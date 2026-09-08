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

- [ ] **Failover Notifications**:
  - Push subtle UI session notices or status messages when a subagent fails over to another provider.
- [ ] **Per-Endpoint Latency & Token Metrics**:
  - [x] Failure-latency metrics per endpoint (request-to-failure span: count/total/max/last, plus `latencyMs` on failure events) — distinguishes instant refusals from long hangs.
  - [ ] Success-side response latency and token throughput: the host dispatch layer exposes no request-completion event (`agent/request` builds the config, failures surface via `agent/request-error`), so success metrics need a host-side completion signal first.
- [x] **Log Integration**:
  - Structured debug logging (one JSON line per routing event via `console.debug`), enabled by the config `debug` flag or `DSH_ORCHESTRATOR_DEBUG=1` — reachable through `dsh` CLI diagnostics.
  - Offline diagnostics chain: live snapshot via the `./diagnostics` subpath, opt-in durable persistence (`persistTelemetry`) and the `scripts/telemetry-report.mjs` reader (see `ARCHITECTURE.md` §5; runs `pnpm report`).

---

## 🎨 Phase 4: GUI Settings Panel

- [ ] **Optional UI Card Component**:
  - Add optional settings panel in DSH Desktop settings to add, test, and toggle subagent endpoints interactively.
  - "Test Connection" button with live ping and token check.

---

## 📦 Phase 5: Distribution & Packaging

- [x] Add unit and integration tests simulating subagent session execution.
- [ ] Publish to npm / open-source repository for community use.

---

## 🧭 Candidate: Pool / Fallback endpoint modes (v2)

- [x] Review `DESIGN-pool-fallback.md` - owner approved all four proposals
  (cap accounting, flapping-guard defaults, fallback tier under pool mode,
  failback probe traffic).
- [x] Phase A — config schema + mode/strategy split + ordered fallback chain.
- [x] Phase B — breaker-based auto-failback (healthy-first tier walk) + flapping guard.
- [x] Phase C — `totalSubagents` pass-through concurrency cap.