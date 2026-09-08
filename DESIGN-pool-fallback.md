# Design Proposal: Pool / Fallback endpoint modes (v2)

**Status:** ACCEPTED (owner: implement with your proposals) and implemented.
Phase A (config + mode/strategy split + tiered chain), Phase B (flapping guard
via breaker trip history) and Phase C (totalSubagents pass-through cap) are
landed; the four open questions below were resolved with the owner-approved
proposals marked inline.

---

## 1. Problem

Today every configured endpoint lives in one flat pool, and one routing
strategy governs all of it. Three needs don't fit:

1. **Ordered rescue chains**: a premium provider first, cheap providers only
   as explicit rescue targets — with the premium one *resuming* traffic after
   recovery (today, a failed endpoint re-enters rotation anonymously).
2. **Concurrency governance**: a bound on how many subagents the orchestrator
   fans out to, without ever stalling a start (host-plane invariant).
3. **Mode clarity**: "distribute across everything" and "stick to a primary,
   fall back on trouble" are different intents; expressing both through one
   strategy knob overloads it.

## 2. Goals / Non-goals

**Goals**: explicit `pool` vs `fallback` mode; orthogonal routing strategy
inside pool mode; ordered `fallback:` rescue list; automatic failback to a
recovered primary with anti-flapping hysteresis; `totalSubagents`
concurrency cap with guaranteed pass-through overflow.

**Non-goals**: per-endpoint rate budgets (breaker cooldowns already cover
window semantics); changing the failover trigger taxonomy or retry budget
(the machinery in the runtime is reused unchanged); UI work.

## 3. Config schema (proposed)

```yaml
subagents-orchestrator:
  mode: pool            # pool (default) | fallback
  strategy: round-robin # round-robin | random | weighted (pool mode only)
  totalSubagents: 6     # concurrency cap (optional; absent = unbounded)

  endpoints:            # primary set (meaning depends on mode)
    - { provider: deepseek, model: deepseek-chat }
    - { provider: openai, model: gpt-4o, weight: 2 }

  fallback:             # fallback mode only: ordered rescue chain
    - { provider: siliconflow, model: deepseek-v3 }
    - { provider: anthropic, model: claude-sonnet-4 }
```

Schema rules follow the existing `parseConfigDocument` contract: wrong types
are dropped, never coerced; `mode: fallback` with an empty `fallback:`
list degrades to `pool` (logged once), because a rescue chain with no
rescuers must not become a single point of failure.

## 4. Mode semantics

### pool (default)

Exactly today's behavior, generalized: `strategy` picks among
breaker-healthy endpoints from `endpoints:`; failover walks the pool.
`fallback:`, if present, is appended as a **lower tier** — used only when
every primary endpoint is tripped (degradation today already behaves this
way via `filterHealthy`; the spec makes it explicit and configurable).

### fallback

- `endpoints:` is the **primary set**; with one entry it is sticky (the
  strategy knob is irrelevant), with several it rotates among primaries.
- Failure → existing failover machinery (retry budget, hints, breaker) runs
  first, exactly as today. Only when the current endpoint is actually
  abandoned does the request descend the `fallback:` chain in order.
- **Auto-failback**: after a primary's breaker cooldown expires, it is
  re-probed via the breaker's existing half-open probation. Hysteresis rule:
  a primary resumes traffic only after one clean probationary success; a
  failure during probation re-trips it for a fresh cooldown. This reuses the
  shipped breaker states — no new state machine.
- Flapping guard: an endpoint that trips N times (default 3) within one
  window is demoted to the fallback tier for a longer penalty window
  (configurable, default 3× cooldown) before re-entering primary rotation.

## 5. `totalSubagents` — concurrency cap

- Counted as **live subagent entries** observed at `agent/request` (start)
  minus `agent/disposed` (end) — the same lifecycle signal pair the plugin
  already tracks; no host changes required.
- **Pass-through overflow is intentional and non-negotiable** (host-plane
  safety): a start over the cap is never rejected, blocked, or queued — it
  proceeds unrouted on the caller's provider choice and is logged via the
  debug stream. The cap shapes routing preference, never availability.
- The cap does not interact with failover: an in-flight request may still
  fail over to any healthy endpoint; only new starts are counted.

## 6. Interaction with existing machinery (unchanged)

Breaker (trip/cooldown/probation), provider cooldown hints, the
`maxRetries` budget, terminal-failure bypass, telemetry attribution
(`provider::model` keys are mode-independent), the diagnostics snapshot
and the persistence chain all operate below the mode layer and need no
changes. The mode only decides **which ordered candidate list** feeds
`pickNextEndpoint`.

## 7. Migration & back-compat

- `mode` absent → `pool` (identical to current behavior; golden configs
  keep working bit-for-bit).
- `strategy` stays valid in both modes (pool: full rotation; fallback:
  primary-set rotation).
- Telemetry gains `mode` on events (additive; report script renders it
  when present).

## 8. Open questions for the owner

1. **Cap accounting**: global subagent count, or per provider tier?
   (Proposal: global; per-tier adds semantics without a clear user need.)
2. **Flapping guard defaults**: 3 trips / 3× cooldown — reasonable?
3. **Fallback tier in pool mode**: append `fallback:` as a degradation
   tier, or forbid the combination? (Proposal: append.)
4. **Auto-failback probe traffic**: breaker probation already sends one real
   request — acceptable, or should failback be manual-only in v2?

## 9. Implementation sketch (when approved)

- Phase A: config schema + mode/strategy split + fallback chain ordering
  (`src/config.ts`, `src/balancer.ts`, `src/types.ts`).
- Phase B: auto-failback + flapping guard (`src/health.ts` hysteresis hook).
- Phase C: `totalSubagents` counting (`src/index.ts` lifecycle listeners,
  pass-through overflow).
- Each phase lands behind its own TDD round with boundary probes, per
  CONTRIBUTING.md conventions.
