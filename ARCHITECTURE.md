# Architecture & Host Contract Notes

Verified contracts between this plugin and the DeepSeek Harness host. Every claim
below was read out of the installed host packages (paths are relative to
`node_modules/@deepseek-ai/` in the DSH checkout), not assumed from the mocks.

---

## 1. The event surface visible to a host-plane plugin

The agent loop (`dsh-agent-loop/lib/index.js`) dispatches exactly **three**
context events a plugin can listen to:

| Event | Kind | Payload (verified from typert signatures) |
| :--- | :--- | :--- |
| `agent/request` | waterfall | `{ agent, turn, step, [request]` — produces the provider seed (`provider`, `model`, `reasoningEffort`) the host will use |
| `agent/request-error` | waterfall | `{ agent, turn, step, provider, failure: LlmFailure, retryPolicy, signal }` |
| `agent/pre-step` | hook | pre-step notification |
| `agent/turn-stopping` | hook | `{ agent, turn, signal }` — the turn is about to close: the model owes no response, no tool is live |
| `agent/error` | emit | `{ agent, turn, step, error }` — a step or turn errored |

**There is no request-completion / success event.** Raw per-request success
latency is therefore not observable from plugin hooks. What 0.1.2 *does*
guarantee are two same-agent boundaries the loop always reaches: it
re-dispatches `agent/request` for every later step, and it closes every turn
at `agent/turn-stopping` (data decides the close; a listener cannot force
another step from there without steering). Telemetry exploits exactly that
pairing (see §5): a span opened at `agent/request` closes at the NEXT
same-agent boundary, giving a whole-step success span — an upper bound on
raw provider latency that includes our own retry pacing. Spans whose own
(turn, step) failed are poisoned at `agent/request-error` / `agent/error`
and dropped, so a turn that stopped on an error can never be sampled as a
success. Token throughput reads the optional `ctx.tokenMeter` composition
(`measure(session).totalTokens` — provider-reported usage replayed from the
durable log), attributed per closed span with a cumulative mark carried
across mid-turn endpoint switches so retries never double-count.

### Failover decision contract

```
RequestErrorAction = { kind: 'retry' } | undefined
```

(`dsh-tool-cordis` typert declaration.) The loop does:

```js
const action = await dispatch.waterfall('agent/request-error', payload, () => undefined);
signal.throwIfAborted();
if (action?.kind !== 'retry') throw new LlmError(...);  // else: continue the turn
```

The loop applies **no delay** — whoever returns the decision owns the wait.
`dsh-llm-retry` models the same thing: it runs its own `cancellableDelay`
*inside* its handler before returning `{ kind: 'retry' }`, and its `always`
mode forwards a downstream decision **verbatim, without adding delay**.

### Cordis waterfall semantics

Listeners compose outermost-first around `next()`; **a listener that never calls
`next()` vetoes the rest of the chain** — including the built-in behavior and
other recovery plugins. Consequences encoded in this plugin:

- Every non-decision path must end in `return next()` (delegation).
- Our handler body is wrapped in try/catch so an internal bug can never turn
  into an accidental veto that silently kills `dsh-llm-retry` / compaction
  recovery for the whole host.
- `next()` is called exactly once per event.

### Layering with `dsh-llm-retry`

When a provider has a `retryPolicy` (`normal` mode), llm-retry retries the
**same provider** without calling `next()` until its budget is spent or the
code is not in `retryableCodes` — only then does the chain reach this plugin.
Two fall-through cases that land here:

1. `providerRetryAfterMs > policy.maxDelayMs` — huge Retry-After windows are
   exactly the failures this plugin should trip on immediately.
2. Budget exhausted for the (turn, step, provider, policyKey).

In `always` mode llm-retry asks downstream first and forwards our decision.

---

## 2. Failure taxonomy (verified sources)

`LlmFailure` = `{ message, code, status?, providerRetryAfterMs?, requestId? }`
(`dsh-llm/lib/types/adapter-failure.js` + `dsh-llm-deepseek` adapter). **No raw
headers** — the host parses `retry-after` into `failure.providerRetryAfterMs`
(ms) itself; header sniffing in `ratelimit.ts` is only a fallback for
non-host-shaped failures.

| Code | Origin | Host same-provider retryable? | Ours |
| :--- | :--- | :--- | :--- |
| `RATE_LIMIT` | status 429 | ✅ default | ✅ failover trigger |
| `SERVER` | status ≥ 500 | ✅ default | ✅ |
| `TIMEOUT` | per-read idle watchdog | ✅ default | ✅ |
| `TRANSPORT` | network/stream failures | ✅ default | ✅ |
| `EMPTY_RESPONSE` | zero-block completion | ✅ default | ✅ |
| `QUOTA` | exhausted balance/credits | ❌ deliberate (terminal) | ✅ trigger, **budget bypass** |
| `INVALID_CREDENTIAL` | malformed API key | ❌ deliberate | ✅ trigger, **budget bypass** |
| `MISSING_CREDENTIAL` | no key for provider route | ❌ | ✅ trigger, **budget bypass** |
| `AUTH` | 401/403 | ❌ | ❌ shared-infrastructure, not endpoint-specific |
| `CONTEXT_WINDOW_EXCEEDED` | 400 + wording classifier | ❌ | ❌ endpoint-independent |
| `INVALID_REQUEST` | 400 | ❌ | ❌ |
| `HTTP_<status>` | other statuses | ❌ | ❌ |

Rationale for the budget bypass on `QUOTA` / credential codes: they are
**account-terminal** — the same key fails identically on every attempt, while
the other pool entries are different accounts. Same-provider retries (what
llm-retry does) cannot help; switching accounts is the remedy. `AUTH` stays
excluded because it is treated as shared infrastructure.

Host defaults: `DEFAULT_RETRYABLE_CODES = [EMPTY_RESPONSE, RATE_LIMIT, SERVER,
TIMEOUT, TRANSPORT]` (`dsh-llm/lib/index.js`).

---

## 3. Decisions encoded in this plugin

1. **Pacing lives in the decider.** `intervalMinMs`/`intervalMaxMs` (default
   3000–5000) are sampled and awaited *inside our handler* before returning the
   retry decision, with abort-awareness on `payload.signal`.
2. **Terminal-failure bypass.** `QUOTA` / `INVALID_CREDENTIAL` /
   `MISSING_CREDENTIAL` skip the same-endpoint retry budget (as do
   provider-hinted cooldowns) — pacing against a dead key or an exhausted
   balance is pure waste.
3. **Throw-proof handler.** Internal errors are logged and delegated, never
   allowed to veto the chain.
4. **Attribution.** Failures are attributed via the endpoint recorded at
   `agent/request` time (the host dispatches it before any request can fail).
   Unattributed errors defer to the host.
5. **Rate-limit cooldowns** prefer the host-parsed `providerRetryAfterMs`
   (capped at 15 min) over header sniffing.

---

## 4. Config hot-reload & snapshot retention

`src/config.ts` keeps a zero-disk-I/O in-memory snapshot refreshed by a
debounced `fs.watch` on the settings file (`WATCH_DEBOUNCE_MS = 100`).

- Missing/unreadable file **in a living directory** → cache degrades to `null`
  (fail-open; the orchestrator switches off) and the watcher keeps working.
- Deleted **directory** → the watch handle is dead and can never re-arm;
  `reloadConfig()` keeps serving the last known good snapshot instead of
  wiping into a state nothing can recover from (retention beats a permanent
  silent shutdown). Re-arming requires a plugin re-init (host restart).

---

## 5. The diagnostics toolchain

Observability is a three-stage pipeline; each stage is independently
operable and strictly read-only toward the plugin runtime.

### Stage 1 — capture (in-process)

`src/telemetry.ts` attributes every routed event to its endpoint (the
identity recorded at `agent/request` time) and maintains per-endpoint
counters plus failure-latency samples (request→failure span) and success
side step spans with token deltas (boundary-paired — see §1). A bounded
ring buffer keeps recent events for debug output. Two independent read
paths exist:

- `./diagnostics` subpath — `getDiagnosticsSnapshot()` renders the live
  state (config, breaker health derived **without** the probation state
  write, counters) as fresh plain data. Safe before `apply()`, after
  dispose, and with a broken settings file.
- debug event stream — `config.debug` / `DSH_ORCHESTRATOR_DEBUG=1` emits
  one JSON line per routing event via `console.debug`.

### Stage 2 — persistence (opt-in, dispose-time)

With `persistTelemetry: true` (`src/config.ts` schema-gated), the
dispose effect calls `flushTelemetryToDisk()` (`src/persist.ts`) once:
append the buffered events into `events-YYYY-MM-DD.jsonl` (append-only,
day-bucketed, 7-day retention), atomically replace `endpoints.json`
(tmp+rename), prune old buckets. Ordering matters twice: the flush runs
**before** `resetTelemetry()` in the dispose effect, or the data would be
gone; and inside the flush the buffer is consumed only **after** the
append fully succeeded (peek → append → consume), so a failed write
leaves the events buffered for the next flush. Failure semantics:
nothing throws — unwritable roots yield zeroed counters and an intact
buffer; an empty buffer writes nothing, not even the storage root.

### Stage 3 — consumption (out of process)

`scripts/telemetry-report.mjs` reads the persisted artifacts with plain
`node:fs` — human summary, `--json`, `--events N` newest-first across
day buckets, corrupt-line tolerance, graceful degradation on missing
stores. Runs while DSH is live (atomic file snapshots) or post-crash,
which is its main support scenario: the last flushed state is exactly
what the plugin held when it was disposed.

### Design rule

Every stage fails soft and never mutates routing state. Diagnostics are
consumers of the runtime, never participants: no probe path may trip a
breaker, transition probation, or stall a subagent start.

---

## 6. The client→host RPC channel (Test Connection)

The Phase 4 "Test Connection" button was long marked *blocked on a
client→host RPC channel for third-party remotes*. Re-reading the installed
host packages (DSH 0.1.2-rc.1) showed the blocker is gone: the Typert
Gateway serves **any** endpoint claimed by an active host service, not just
codegen-registered ones.

### The verified wire path

- **Host side (discovery):** the `dsh-api-gateway` controller accepts an
  endpoint when `ctx.typert.local` registers it (compiler path) *or* when
  its SRC fallback (`collectSrcClaims`) finds a registered service carrying
  a `typertRemote` binding (`{ service, serviceKey, namespace }`) plus
  prototype method markers
  (`@deepseek-ai/dsh-typert-protocol/remote-methods`, `{ version: 1,
  methods: [...] }`). Cordis `reflect` is prototypally inherited across
  contexts (`Context.extend` = `Object.create(parent)`), so a service
  provided by any plugin is discoverable from the gateway context. SRC
  descriptors derive parameters from the method's identifier parameter
  names (parsed via `Function.prototype.toString`) and validate results as
  JSON-safe only — no typert codegen required.
- **Client side (mount):** `dsh-api-remotes`' client half mounts the
  first-party remote namespaces (`remote.llm`, `remote.settings`,
  `remote.credentials`, …) through `ctx.remote.$mount(contribution)` with
  generated strict-codec descriptors. Any client plugin — including this
  panel — resolves `ctx.remote.llm` and calls its methods; the calls POST
  to `/api/<namespace>/<method>` behind the browser-auth fence, with no
  per-endpoint allowlist on the unary RPC path (unlike the *forwarded
  events* allowlist, which stays closed).

### How the probe uses it

`src/client/testConnection.ts` implements the whole flow client-side; the
host plane is untouched (the probe can never trip a breaker or transition
probation — the §5 design rule holds):

1. `remote.llm.discoverModels('llm-pi-ai', request)` routes a **draft**
   request to the pi-ai discovery implementation, which performs a live
   `GET {baseURL}/models` (protocol `openai-completions` or
   `openai-responses`). The draft reads and writes nothing: no settings,
   no credentials are consumed or mutated on the controller path — the
   caller owns the draft. A draft naming a provider without a shipped
   catalog resolves that stored profile's credential **host-side**, so the
   panel never needs the secret.
2. `remote.settings.describe()` (secret-redacted) prefills the draft
   `baseURL` from the provider's stored `llm-pi-ai` profile record
   (`providers[id].baseURL`) so a configured endpoint probes in one click.
3. The result maps to the panel: reachability + latency, the advertised
   model list, and whether the configured model is served — with its
   disclosed `contextWindow` when the endpoint advertises one (the
   "token check"). HTTP 401/403 surface as explicit "check the API key"
   failures.

### Robustness rules

- Faces resolve **lazily at call time**; `ctx.remote` property access on a
  host without the service throws (cordis refuses unprovided service
  reads), which degrades to an explicit `unavailable` outcome — the panel
  still renders and saves on older hosts.
- The probe composes the caller signal with a 15 s client-side timeout via
  `setTimeout` (no `AbortSignal.any`/`timeout`, newer than the bundle's
  chrome100 target) and always disposes the listener.
- `runEndpointTest` never throws; every failure mode resolves to a
  structured `{ status: 'fail' | 'unavailable', message }` outcome.
- The one-shot draft API key typed into the panel is passed per-request
  and never persisted by the plugin (the draft is not saved anywhere).
