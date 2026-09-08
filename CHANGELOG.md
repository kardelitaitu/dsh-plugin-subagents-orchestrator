# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.2.0] - 2026-09-08

Everything merged after the `v1.1.0` tag. Nothing reached npm before this
cycle, so this is also the first release the packaging gate was built for.

### Added

- Same-endpoint retry budget (`maxRetries`, default 20): an eligible failure is
  first retried on the CURRENT endpoint with a randomized 3-5s pause
  (`intervalMinMs`/`intervalMaxMs`), and only then fails over to the next pool
  entry — each fallback endpoint gets a fresh budget. The budget is scoped to
  the failed (turn, step), a provider `Retry-After` hint fails over
  immediately instead of burning retries, and failover targets skip tripped
  endpoints as before.
- Failure-latency metrics per endpoint: the request-to-failure span is
  sampled into `latencySamples`/`latencyTotalMs`/`latencyMaxMs`/
  `lastLatencyMs` and exposed as `latencyMs` on failure events.
- Read-only diagnostics snapshot (`./diagnostics` subpath):
  `getDiagnosticsSnapshot()` aggregates config presence, effective
  switches, the endpoint list with parked marking, breaker health and
  telemetry counters; `formatDiagnostics()` renders a compact report.
  Strictly non-mutating — breaker health is derived without tripping the
  probation transition, and probing never touches the disk.
- Pool / fallback endpoint modes (v2, `mode` + `fallback` config): ordered
  rescue chain descending after the primaries, healthy-first tier walk with
  automatic failback through breaker probation, and a flapping guard that
  extends the cooldown of rapidly re-tripping endpoints.
- `totalSubagents` soft concurrency cap: starts at or over the cap pass
  through unrouted - never rejected, queued or stalled - and routing resumes
  when a slot is freed.
- Opt-in settings panel arm (`ui.panel: true`): registers the
  `subagents-orchestrator` namespace with DSH's settings service so the
  Desktop settings UI can edit the scalar fields; panel writes persist to
  the watched settings.yaml and hot-reload through the zero-I/O cache.
  Config gates `ui: { toasts, panel }` added (all surfaces off by default).
- Tier C list editing: the panel schema models `endpoints` and `fallback`
  as `{ provider, model, weight?, enabled? }` entries (identity required,
  YAML-only keys like `reasoningEffort` preserved through validation).
- Visual settings card in the DSH GUI (`./client` bundle): a
  `settings.section` panel component with live endpoint rows, per-endpoint
  breaker health and a draft/edit model synced against the same settings
  namespace, gated behind `ui.panel` so the plugin stays invisible by default.
- Durable telemetry persistence (`persist.ts`, opt-in via
  `persistTelemetry`): on plugin dispose the event ring is flushed into
  day-bucketed JSONL (7-day retention) and an endpoint-stats snapshot is
  written atomically under `~/.dsh/telemetry/subagents-orchestrator`;
  the buffer is consumed only after a successful append, so a failed
  write never loses diagnostics, and the default stays off (no disk
  side effects).
- Offline report script (`scripts/telemetry-report.mjs`, `pnpm report`):
  dependency-free, read-only reader for the persisted diagnostics —
  human-readable or `--json`, `--events N` tail, works while DSH runs or
  after a crash; missing or corrupt stores degrade to a location report.
- CI runs `npm pack --dry-run` after build, so packaging regressions
  (files-manifest omissions) fail the build instead of the publish.
- Release preflight (`scripts/release-check.mjs`, `pnpm run release:check`):
  validates the publish metadata, packs a real tarball, installs it into a
  throwaway consumer project and imports every Node-resolvable subpath
  (host entry, diagnostics, report script, Cordis client wrapper), then
  checks the version is still free on the registry. `--build-parity` also
  proves the committed `lib/` matches a fresh build.
- Tag-triggered publish workflow (`.github/workflows/release.yml`): pushing a
  `vX.Y.Z` tag re-runs the full gate and publishes to npm with OIDC registry
  provenance, so no access token is stored in repository secrets.
- Pre-push hook (`.githooks/pre-push`) mirroring the blocking CI steps
  (typecheck + suite) so a red push cannot leave the machine.

### Changed

- Failover now defaults to on: only an explicit `failover: false`
  disables it.
- Terminal failures (`QUOTA`, `INVALID_CREDENTIAL`,
  `MISSING_CREDENTIAL`) skip the same-endpoint retry budget and switch
  accounts on the first failure, the same way provider cooldown hints do.

### Fixed

- `scripts/` ships in the npm `files` manifest, so the `pnpm report`
  alias has its target in the published package.
- The `prepare` lifecycle script is gone: it ran during a git-hosted
  `dsh plugin add github:owner/repo` install and broke it. Hook setup is
  an explicit `pnpm run hooks:install` now.
- The client card reads `props.scope`/`props.useScope` straight off the
  slot props, and the draft sync no longer echoes an edit back as new state.

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
