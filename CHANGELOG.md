# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project adheres to [Semantic Versioning](https://semver.org/).

## [1.1.0] - 2026-09-08

### Added

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
