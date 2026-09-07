# Development Roadmap (dsh-plugin-subagents-orchestrator)

This document outlines the planned evolutionary stages and milestones for `dsh-plugin-subagents-orchestrator`.

---

## 🎯 Phase 1: Core Host Routing & Reliability (Completed ✅)

- [x] Create clean host-plane Cordis plugin structure without client bundle baggage.
- [x] Intercept `ctx.subagents.start` and `ctx.subagents.startContinuable`.
- [x] Support multiple endpoints with `round-robin` and `random` routing algorithms.
- [x] Implement subagent-only error failover for connection errors (`RATE_LIMIT`, `QUOTA`, `TIMEOUT`, `SERVER`, `TRANSPORT`, `EMPTY_RESPONSE`).
- [x] Support automatic failover retries to alternative pool endpoints.
- [x] Integrate settings directly from `~/.dsh/settings.yaml`.

---

## 🚀 Phase 2: Dynamic Health Tracking & Circuit Breaker

- [ ] **Dynamic Endpoint Health Tracking**:
  - Automatically mark endpoints unhealthy on consecutive failures.
  - Apply temporary backoff cooldowns (e.g., 60s) before returning them to rotation.
- [ ] **Adaptive Load Weighting**:
  - Support priority weights (`weight: 1..10`) per endpoint for tiered provider setups.
- [ ] **Rate Limit Header Parsing**:
  - Parse provider rate limit responses (e.g., `Retry-After`, `x-ratelimit-reset`) to set exact cooldown windows.

---

## 📊 Phase 3: Telemetry, Observability & User Notices

- [ ] **Failover Notifications**:
  - Push subtle UI session notices or status messages when a subagent fails over to another provider.
- [ ] **Per-Endpoint Latency & Token Metrics**:
  - Track response latency and token throughput per subagent endpoint.
- [ ] **Log Integration**:
  - Structured debug logging accessible via `dsh` CLI diagnostics.

---

## 🎨 Phase 4: GUI Settings Panel

- [ ] **Optional UI Card Component**:
  - Add optional settings panel in DSH Desktop settings to add, test, and toggle subagent endpoints interactively.
  - "Test Connection" button with live ping and token check.

---

## 📦 Phase 5: Distribution & Packaging

- [ ] Add unit and integration tests simulating subagent session execution.
- [ ] Publish to npm / open-source repository for community use.