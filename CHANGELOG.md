# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project adheres to [Semantic Versioning](https://semver.org/).

## [1.1.0] - 2026-09-08

### Added

- Same-endpoint retry budget (`maxRetries`, default 20): an eligible failure is
  first retried on the CURRENT endpoint with a randomized 3-5s pause
  (`intervalMinMs`/`intervalMaxMs`), and only then fails over to the next pool
  entry — each fallback endpoint gets a fresh budget. The budget is scoped to
  the failed (turn, step), a provider `Retry-After` hint fails over
  immediately instead of burning retries, and failover targets skip tripped
  endpoints as before.
- `weighted` routing strategy with per-endpoint `weight`.
- Per-endpoint circuit breaker (`health.ts`): consecutive-failure tripping,
  cooldown windows, probationary recovery, graceful degradation when every
  endpoint is down.
- Rate-limit-aware cooldowns: `Retry-After` / `x-ratelimit-reset` headers trip
  an endpoint immediately for the exact window the provider requests
  (`ratelimit.ts`, capped at 15 minutes).
- Per-endpoint telemetry (`telemetry.ts`): requests, failures, failovers and
  cooldown hints per endpoint, plus a recent-event ring buffer and opt-in
  structured debug output (`config.debug` or `DSH_ORCHESTRATOR_DEBUG=1`).
- Config schema validation: unknown or wrongly-typed fields are dropped,
  never coerced (`parseConfigDocument`).
- Per-endpoint `enabled` toggle: parked endpoints stay in config but are
  excluded from routing and failover.
- `cooldownMs` / `maxFailures` config options.
- Failure-latency metrics per endpoint: the request-to-failure span is
  sampled into `latencySamples`/`latencyTotalMs`/`latencyMaxMs`/
  `lastLatencyMs` and exposed as `latencyMs` on failure events.
- Read-only diagnostics snapshot (`./diagnostics` subpath):
  `getDiagnosticsSnapshot()` aggregates config presence, effective
  switches, the endpoint list with parked marking, breaker health and
  telemetry counters; `formatDiagnostics()` renders a compact report.
  Strictly non-mutating — breaker health is derived without tripping the
  probation transition, and probing never touches the disk.
- Durable telemetry persistence (`persist.ts`, opt-in via
  `persistTelemetry`): on plugin dispose the event ring is drained into
  day-bucketed JSONL (7-day retention) and an endpoint-stats snapshot is
  written atomically under `~/.dsh/telemetry/subagents-orchestrator`;
  every failure path is best-effort so diagnostics can never take the
  host plane down, and the default stays off (no disk side effects).
- Offline report script (`scripts/telemetry-report.mjs`): dependency-free,
  read-only reader for the persisted diagnostics — human-readable or
  `--json`, `--events N` tail, works while DSH runs or after a crash;
  missing or corrupt stores degrade to a location report.

### Changed

- Failover now defaults to on: only an explicit `failover: false`
  disables it.
- Terminal failures (`QUOTA`, `INVALID_CREDENTIAL`,
  `MISSING_CREDENTIAL`) skip the same-endpoint retry budget and switch
  accounts on the first failure, the same way provider cooldown hints do.

### Fixed

- Bare `subagents.start(name)` and spec-less `subagents.startContinuable()`
  calls are now routed instead of silently bypassing orchestration.
- Failover no longer targets tripped endpoints while a healthy alternative
  exists.

## [1.0.0] - 2026-09-08

### Added

- Initial host-plane Cordis plugin: round-robin/random multi-endpoint
  distribution for DSH subagents with subagent-only error failover
  (`RATE_LIMIT`, `QUOTA`, `SERVER`, `TIMEOUT`, `TRANSPORT`, `EMPTY_RESPONSE`).
- Hot-reloadable configuration from `~/.dsh/settings.yaml`.
