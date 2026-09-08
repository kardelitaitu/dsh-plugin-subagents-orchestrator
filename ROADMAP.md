# Development Roadmap (dsh-plugin-subagents-orchestrator)

This document outlines the planned evolutionary stages and milestones for `dsh-plugin-subagents-orchestrator`.

---

## 🎯 Phase 1: Core Host Routing & Reliability (Completed ✅)

- [x] Create clean host-plane Cordis plugin structure without client bundle baggage.
- [x] Intercept `ctx.subagents.start` and `ctx.subagents.startContinuable`.
- [x] Support multiple endpoints with `round-robin` and `random` routing algorithms.
- [x] Implement subagent-only error failover for connection errors (`RATE_LIMIT`, `QUOTA`, `TIMEOUT`, `SERVER`, `TRANSPORT`, `EMPTY_RESPONSE`).
- [x] Support automatic failover retries to alternative pool endpoints.
- [x] Integrate settings directly from `~/.dsh/settings.yaml` (zero-disk-I/O in-memory cache with debounced `fs.watch` hot reload).

---

## 🚀 Phase 2: Dynamic Health Tracking & Circuit Breaker (Completed ✅)

- [x] **Dynamic Endpoint Health Tracking**:
  - Automatically mark endpoints unhealthy on consecutive failures.
  - Apply temporary backoff cooldowns (e.g., 60s) before returning them to rotation.
- [x] **Adaptive Load Weighting**:
  - Support priority weights (`weight: 1..10`) per endpoint for tiered provider setups.
- [x] **Rate Limit Header Parsing**:
  - Parse provider rate limit responses (e.g., `Retry-After`, `x-ratelimit-reset`) to set exact cooldown windows.
- [x] **Per-Endpoint Toggles & Debug Flag**:
  - `enabled: false` parks an endpoint (kept in config, excluded from routing and failover).
  - `debug: true` emits structured telemetry lines (also available via `DSH_ORCHESTRATOR_DEBUG=1`).
- [x] **Failover Retry Pacing**:
  - Randomized `intervalMinMs`-`intervalMaxMs` wait before a retried subagent request, cancellable via agent abort or plugin dispose (abort-safe: no phantom failovers).
  - Provider cooldown hints (`Retry-After` / `x-ratelimit-reset`, host-parsed when available) take priority over the consecutive-failure threshold.

---

## 📊 Phase 3: Telemetry, Observability & User Notices

- [x] **Failover Notifications**:
  - Opt-in (`ui.toasts: true`) collapsed plugin-notice row delivered into the
    failed subagent's transcript via `agent.inject` (non-waking; the retried
    step sees the endpoint switch). Message construction uses
    `createUserMessage` from `@deepseek-ai/dsh-llm`, resolved lazily — hosts
    without a resolvable module degrade to no notice, never to a broken
    failover.
  - Live push to the web client remains **blocked upstream**: a
    `SessionEventMap` extension point or an `API_REMOTE_FORWARDED_EVENTS`
    entry (both closed to third-party plugins in DSH 0.1.1/0.1.2-rc.1) is
    still required for true client-plane toasts. Re-evaluate on DSH upgrades.
- [x] **Per-Endpoint Latency & Token Metrics**:
  - [x] Failure-latency metrics per endpoint (request-to-failure span: count/total/max/last, plus `latencyMs` on failure events) — distinguishes instant refusals from long hangs.
  - [x] Success-side response latency and token throughput (boundary-paired): the host still exposes no request-completion event, but the agent loop re-dispatches `agent/request` per step and closes every turn at `agent/turn-stopping` — so a span opened at `agent/request` closes at the next same-agent boundary (step advance or turn stop). Spans whose own (turn, step) failed are poisoned via `agent/request-error` / `agent/error` and dropped. Token deltas read the optional `ctx.tokenMeter.measure(session).totalTokens` cumulative (provider-reported usage replayed from the durable log), attributed per closed span with a carried mark so mid-turn endpoint switches never double-count. Surfaced in the diagnostics snapshot, the panel card and `pnpm report` (`ok-latency` / `tokens`).
- [x] **Log Integration**:
  - Structured debug logging (one JSON line per routing event via `console.debug`), enabled by the config `debug` flag or `DSH_ORCHESTRATOR_DEBUG=1` — reachable through `dsh` CLI diagnostics.
  - Offline diagnostics chain: live snapshot via the `./diagnostics` subpath, opt-in durable persistence (`persistTelemetry`) and the `scripts/telemetry-report.mjs` reader (see `ARCHITECTURE.md` §5; runs `pnpm report`).

---

## 🎨 Phase 4: GUI Settings Panel

- [x] **Opt-in settings panel arm** (`ui.panel: true`): the plugin registers the
  `subagents-orchestrator` namespace with DSH's settings service (schemastery
  schema), so the Desktop settings UI can render and edit the scalar fields
  through the standard describe/update protocol. Panel writes persist to the
  same `settings.yaml` the plugin's debounced watcher hot-reloads — no client
  code needed.
- [x] **Tier C list editing**: the panel schema models `endpoints`/`fallback`
  entries (`{ provider, model, weight?, enabled? }`, identity required);
  YAML-only keys survive validation untouched. Malformed stored entries
  degrade the panel to the plain YAML path instead of breaking routing.
- [x] **Optional UI Card Component**:
  - Add optional settings panel in DSH Desktop settings to add, test, and toggle subagent endpoints interactively.
  - [x] **"Test Connection" button with live ping and token check** — unblocked
    on DSH 0.1.2-rc.1: the Typert Gateway serves any endpoint claimed by an
    active host service (SRC fallback, no allowlist on the unary RPC path),
    and `dsh-api-remotes` mounts the first-party `remote.llm`/
    `remote.settings` namespaces client-side for every plugin panel. The
    probe (`src/client/testConnection.ts`) sends a draft
    `remote.llm.discoverModels('llm-pi-ai', { provider, baseURL })` — a live
    `GET {baseURL}/models` that resolves the stored profile credential
    host-side, so no secret enters the panel unless the user types one —
    then reports reachability + latency, the advertised model list, and
    whether the configured model is served (with its disclosed context
    window). Strictly read-only toward routing state (see
    `ARCHITECTURE.md` §6).
- [ ] **Failover toasts (blocked upstream)**: live push to the web client
  requires either a `SessionEventMap` extension point or a new entry in
  `dsh-api-remotes`' compiled `API_REMOTE_FORWARDED_EVENTS` allowlist — both
  are closed to third-party plugins in DSH 0.1.1-rc.2. Re-evaluate on DSH
  upgrades; until then the diagnostics snapshot + settings panel carry the
  observability load.

---

## 📦 Phase 5: Distribution & Packaging

- [x] Add unit and integration tests simulating subagent session execution.
- [x] CI gate: strict typecheck + vitest + tsup build on Node 20/22, `npm pack --dry-run`
      for the manifest, a "committed `lib/` matches `src/`" check (git-hosted installs
      ship `lib/` verbatim, so a stale build must never reach a tag), the publish
      preflight, and pack -> store -> read-back jobs so the artifact handoff the
      publish job relies on is covered by every push rather than by a release.
- [x] Pre-push hook mirroring the blocking CI steps locally.
- [x] Publish preflight (`scripts/release-check.mjs`, `pnpm run release:check`): twelve checks
      over what a publish would ship - manifest metadata and lifecycle-script rules,
      packaged docs, the Cordis bundle patch registering the published name, a real
      `npm pack`, then installing that tarball twice (npm, and pnpm in its isolated
      store - the layout a DSH profile uses and the strict one that catches an
      undeclared dependency) and driving the artifact the way the host would:
      `apply()` must inject and wrap `subagents`, register its `agent/*` handlers,
      pass an unconfigured `start()` through and restore it on dispose. Plus the
      license audit of the resolved closure, `repository.url` against the origin
      remote, and a registry duplicate-version probe. `--require-clean` guards a
      hand-run publish against a dirty tree; `--expect-tag` is the release guard.
- [x] v1.2.0 cut: version bump + changelog for everything merged after the
      `v1.1.0` tag (nothing had reached npm before this cycle).
- [x] Tag-triggered publish workflow with npm OIDC provenance
      (`.github/workflows/release.yml`), plus a dry-run mode to rehearse a release
      (run twice against `main`; the gate is green end to end and stops before
      `npm publish`).
- [x] Open-source release surface: `SECURITY.md` with the plugin trust surface,
      issue/PR templates, `.github/dependabot.yml` for npm and Actions, a
      `docs-config-parity` test pinning the README options table and defaults to
      `parseConfigDocument` and the exported constants, and `CONTRIBUTING` release
      guidance for action bumps and host-level artifact verification.
- [ ] First publish: the `v1.2.0` tag exists on the remote and the release
      workflow ran against it. The gate passed on the tag (typecheck, suite, build
      parity, the full publish preflight, artifact upload); the publish step then
      stopped at `ENEEDAUTH` - npm has no publisher configured for this repo
      and there is no `NPM_TOKEN` secret, so nothing reached the registry (still
      404) and no GitHub Release was created. Configure either one and re-run that
      workflow run; no new tag push is needed.

## 🧭 Candidate: Pool / Fallback endpoint modes (v2)

- [x] Review `DESIGN-pool-fallback.md` - owner approved all four proposals
  (cap accounting, flapping-guard defaults, fallback tier under pool mode,
  failback probe traffic).
- [x] Phase A — config schema + mode/strategy split + ordered fallback chain.
- [x] Phase B — breaker-based auto-failback (healthy-first tier walk) + flapping guard.
- [x] Phase C — `totalSubagents` pass-through concurrency cap.