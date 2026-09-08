# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- "Test Connection" probe in the settings panel (Phase 4, unblocked on DSH
  0.1.2-rc.1): every endpoint row gains a Test action that sends a draft
  `remote.llm.discoverModels('llm-pi-ai', { provider, baseURL })` through
  the client→host Typert Remote channel — a live `GET {baseURL}/models`
  whose stored profile credential resolves host-side (a one-shot key can be
  typed instead; the draft is never saved). The result reports reachability
  and latency, the advertised model list, and whether the configured model
  is served, with its disclosed context window when present. The draft
  `baseURL` prefills from the provider's stored `llm-pi-ai` profile via the
  secret-redacted `remote.settings.describe()` view. The flow is
  client-half-only and strictly read-only toward routing state; hosts
  without the remote namespaces degrade the button to an explicit
  unavailable notice. Documented in `ARCHITECTURE.md` §6.

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
- Success-side step spans and token throughput per endpoint (Phase 3): the
  host exposes no request-completion event, so a span opened at
  `agent/request` closes at the next same-agent boundary (a later step's
  request, or `agent/turn-stopping` at the clean turn close). Spans whose
  own (turn, step) failed are poisoned via `agent/request-error` /
  `agent/error` and dropped, so errored turns never inflate successes.
  Token deltas read the optional `ctx.tokenMeter.measure(session).
  totalTokens` cumulative with a mark carried across mid-turn endpoint
  switches (no double count); without the meter, spans record latency only.
  Surfaced as `successes`/`successLatency*`/`tokensTotal` in endpoint stats,
  the diagnostics snapshot, the panel card and `pnpm report` (`ok-latency`,
  `tokens`).
- Opt-in failover notices (`ui.toasts: true`): a committed failover injects a
  collapsed plugin-notice row (`createUserMessage` with
  `source.form: 'notice'`) into the failed subagent's transcript via
  `agent.inject` — model-facing, non-waking, consumed by the retried step.
  `@deepseek-ai/dsh-llm` is resolved lazily and optionally: hosts without a
  resolvable module degrade to a debug line, never to a broken failover.
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
- CI and the release gate compare the committed `lib/` payload against a fresh
  build. `*.map` files are excluded from that comparison: a sourcemap embeds
  `sourcesContent` verbatim, so one stray carriage return from an editor made
  the byte-compare platform-dependent (a Linux runner rebuilds the client map
  differently). What must match is what a consumer loads - `lib/*.js` and
  `lib/*.d.ts`.
- Release preflight (`scripts/release-check.mjs`, `pnpm run release:check`):
  twelve checks over what a publish would actually ship. The manifest first
  (publish metadata, the git-hostile lifecycle scripts, the `files`
  allowlist rules, `publishConfig`), then the documents that must be inside
  the tarball, then the Cordis bundle patch - a patch whose `id` is not the
  published name installs cleanly and loads nothing, so nothing in the
  artifact would ever look wrong.
- The artifact is installed rather than inspected: a real `npm pack`; the
  installed client bundle keeping its `settings.section` and `settingsScope`
  wiring (the GUI half cannot be imported in Node, so structure is all that
  can be asserted); `./package.json`; every Node-resolvable subpath; and the
  plugin's host contract - `apply()` must inject and wrap the host
  `subagents` service, register its `agent/*` listeners, pass an
  unconfigured `start()` through untouched, and hand the original service
  back on dispose. That install runs twice: npm, and pnpm with its isolated
  store - the layout a DSH profile really uses, and the strict one that
  exposes a dependency `package.json` forgot to declare, which npm hoisting
  hides. The resolved runtime closure is license-audited (one copyleft
  transitive dep would
  change the terms of an MIT release), the offline report script runs from
  its installed location, `repository.url` is compared with the origin
  remote (a different repo name blocks, a different owner only warns, so a
  fork's CI stays green), and the registry is probed for a duplicate version.
- Preflight modes: `--build-parity` rebuilds and fails on a stale committed
  `lib/`; `--require-clean` turns "a packaged path differs from HEAD" from
  a warning into a failure - the flag to reach for before publishing by hand
  in a shared checkout; `--expect-tag <ref>` is the release tag guard;
  `--print-changelog` supplies the GitHub Release body from the changelog.
- Tag-triggered publish workflow (`.github/workflows/release.yml`): pushing a
  `vX.Y.Z` tag re-runs the full gate and publishes to npm with OIDC registry
  provenance, so no access token is stored in repository secrets.
- Pre-push hook (`.githooks/pre-push`) mirroring the blocking CI steps
  (typecheck + suite) so a red push cannot leave the machine.
- CI covers the artifact handoff the publish job depends on
  (`pack-release-artifact` -> `unpack-release-artifact`): pack, checksum, ship
  it through the Actions store, read it back in a *different* job, and verify
  the bytes survived, that it is still a readable npm tarball, and that `lib/`
  and `cordis.patch.yml` came out of it while `src/` and `tests/` did not. The
  download half of `release.yml` had never executed before this existed, and
  it is the half an actions major bump can change underneath us.
- Open-source health files: `SECURITY.md` (supported versions, what the plugin
  does and does not touch, private-advisory reporting), issue and
  pull-request templates, and `.github/dependabot.yml` for npm and Actions.
- `tests/docs-config-parity.test.ts` cross-checks the README against the
  implementation: the options table against the keys `parseConfigDocument`
  actually reads (both directions, so an undocumented key fails and so does a
  documented one that is never read), the documented defaults against the
  exported constants, and the example YAML through the real parser so nothing
  in the block people copy-paste can be silently dropped.

### Changed

- Failover now defaults to on: only an explicit `failover: false`
  disables it.
- Terminal failures (`QUOTA`, `INVALID_CREDENTIAL`,
  `MISSING_CREDENTIAL`) skip the same-endpoint retry budget and switch
  accounts on the first failure, the same way provider cooldown hints do.

### Fixed

- The publish job no longer runs `actions/setup-node` with `registry-url`: with no
  token configured that writes an `_authToken` placeholder into the runner npmrc,
  and an explicit token entry outranks the OIDC identity npm provenance needs -
  the first publish would have 401ed over a credential nobody had misconfigured.
- The release tag guard is preflight code with tests rather than inline shell in
  `release.yml`, and it runs on every gate event so a rehearsal exercises the
  command line a release uses.
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
