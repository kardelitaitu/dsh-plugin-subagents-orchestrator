# DSH Subagents Orchestrator (`dsh-plugin-subagents-orchestrator`)

> Intelligent multi-endpoint load distributor and automated error-failover plugin for **DeepSeek Harness (DSH)** subagents.
> Coded by glm-5.3-flash

---

## Overview

When building complex projects with DeepSeek Harness, tasks are often delegated to multiple concurrent subagents (e.g. `subagent`, `subagent_fork`). Without orchestration, all subagents default to the parent session model endpoint, which rapidly exhausts rate limits, triggers concurrency throttles, or causes overall session failure when a provider experiences transient errors.

`dsh-plugin-subagents-orchestrator` is a lightweight, host-plane Cordis plugin that intercepts all subagent creations and:
1. **Distributes subagent workloads** across multiple LLM provider accounts/endpoints using **round-robin**, **random**, or **weighted** strategies.
2. **Provides automated, resilient failover**: If a subagent encounters a rate limit (`RATE_LIMIT`), quota exhaustion (`QUOTA`), server error (`SERVER`), timeout (`TIMEOUT`), or transport issue (`TRANSPORT`), the plugin first retries the failing endpoint up to `maxRetries` times (default 20) with a 3-5 second randomized pause, then fails over to the next endpoint in your pool — giving each fallback endpoint its own fresh retry budget — without failing the main conversation.
3. **Zero UI interference**: Runs entirely on the host plane, meaning zero risk of client module crashes, web boot stalls, or frontend incompatibilities.

---

## Key Features

- **Multi-Endpoint Load Balancing**: Evenly spreads subagent calls across different provider keys and endpoints (e.g. `b-ai-1`, `b-ai-2`, `b-ai-3`, `b-ai-4`, `b-ai-5`).
- **Subagent-Only Error Failover**: Intercepts `agent/request-error` specifically for sessions where `origin === "subagent"`, preserving the main agent session integrity.
- **Circuit-Breaker Health Tracking**: Endpoints that fail repeatedly are pulled from rotation for a cooldown window, then recover on probation — with graceful degradation to the full pool if every endpoint is down.
- **Rate-Limit-Aware Cooldowns**: When a provider answers with `Retry-After` / `x-ratelimit-reset` headers, the endpoint trips immediately for exactly that window (capped at 15 minutes).
- **Endpoint Toggles**: Set `enabled: false` on an endpoint to park it (kept in config, excluded from routing, failover and telemetry) without deleting it.
- **Structured Telemetry**: Optional per-endpoint routing/failure/failover event stream with recent-event and per-endpoint-stat snapshots; enable via the config `debug` flag or `DSH_ORCHESTRATOR_DEBUG=1`.
- **Zero-Disk-I/O Config Cache**: Settings are parsed once into memory and served from there; a debounced `fs.watch` on `~/.dsh/settings.yaml` hot-reloads the cache, so reads are allocation-cheap and never hit the disk.
- **Hot-Reloadable Configuration**: Reads settings directly from `~/.dsh/settings.yaml` on the fly - changes take effect on the very next subagent call without restarting DSH.
- **Respects Explicit Overrides**: If a specific subagent call explicitly requests a model/provider, the orchestrator respects the caller intent and skips routing.
- **Native Cordis Integration**: Built on Cordis lifecycle hooks and wraps `ctx.subagents.start()` and `ctx.subagents.startContinuable()`.

---

## Configuration

Add the `subagents-orchestrator` section to your `~/.dsh/settings.yaml`:

```yaml
subagents-orchestrator:
  enabled: true
  strategy: round-robin    # "round-robin" | "random" | "weighted"
  failover: true           # Automatically switch endpoint on failure
  maxRetries: 20           # Same-endpoint retries (3-5s apart) before switching endpoint
  intervalMinMs: 3000      # Subagent retry pause lower bound (ms)
  intervalMaxMs: 5000      # Subagent retry pause upper bound (ms)
  cooldownMs: 120000       # Cooldown once an endpoint trips (provider hints override)
  maxFailures: 20          # Consecutive failures before an endpoint trips
  debug: false             # Emit structured telemetry lines for every routing event

  # endpoints and models should be already on the DSH profile
  endpoints:
    - provider: provider-5
      model: glm-5.3-flash
      weight: 3           # only used by the "weighted" strategy
      enabled: true       # set to false to park an endpoint without deleting it
    - provider: provider-4
      model: glm-5.3-flash
      weight: 1           # only used by the "weighted" strategy
    - provider: provider-3
      model: glm-5.3-flash
    - provider: provider-2
      model: glm-5.3-flash
    - provider: provider-1
      model: glm-5.3-flash
```

### Options

| Field | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `enabled` | `boolean` | `true` | Enable or disable subagent orchestration |
| `strategy` | `string` | `"round-robin"` | Distribution algorithm: `"round-robin"`, `"random"`, or `"weighted"` |
| `failover` | `boolean` | `true` | Automatically failover to next endpoint on rate limits/errors |
| `cooldownMs` | `number` | `60000` | Circuit-breaker cooldown once an endpoint trips (a provider `Retry-After` / `x-ratelimit-reset` hint overrides both window and threshold) |
| `maxFailures` | `number` | `3` | Consecutive failures before an endpoint trips |
| `maxRetries` | `number` | `20` | Same-endpoint retry budget: an eligible failure is retried on the CURRENT endpoint this many times (each pause 3-5s via `intervalMinMs`/`intervalMaxMs`) before failing over to the next endpoint — every failover target starts with a fresh budget, and a provider `Retry-After` hint trips the endpoint instead of burning retries |
| `intervalMinMs` | `number` | `3000` | Lower bound of the randomized wait before a retried subagent request (failover pacing; `0` disables the wait) |
| `intervalMaxMs` | `number` | `5000` | Upper bound of the randomized wait before a retried subagent request (failover pacing) |
| `debug` | `boolean` | `DSH_ORCHESTRATOR_DEBUG` | Emit structured telemetry debug lines for every routing event (an explicit value overrides the `DSH_ORCHESTRATOR_DEBUG=1` environment variable) |
| `endpoints` | `array` | `[]` | List of `{ provider, model, reasoningEffort?, weight?, enabled? }` endpoints (`weight` feeds the `"weighted"` strategy; `enabled: false` parks an endpoint — it stays in the config but is excluded from routing, failover targets and telemetry) |

---

## Project Structure

```
/
├── src/
│   ├── index.ts            # Plugin entry: Cordis hooks, request wrap & failover wiring
│   ├── config.ts           # ~/.dsh/settings.yaml zero-I/O cache, schema validation + debounced watcher
│   ├── balancer.ts         # round-robin / random / weighted endpoint picking
│   ├── health.ts           # per-endpoint circuit breaker (closed/open/half-open)
│   ├── ratelimit.ts        # Retry-After / x-ratelimit-reset cooldown parsing
│   ├── telemetry.ts        # per-endpoint routing/failure/failover stats + debug event stream
│   └── types.ts            # Shared TypeScript contracts
├── tests/                  # Vitest suite (unit + plugin behavior, mock Cordis context)
├── lib/                    # Build output (tsup: index.js + index.d.ts + sourcemap)
├── cordis.patch.yml        # DSH Cordis profile patch definition
├── package.json            # NPM package manifest
├── CHANGELOG.md            # Release notes (Keep a Changelog)
├── README.md               # Project documentation
└── ROADMAP.md              # Future development roadmap
```

---

## Install

Install from the npm registry:

```bash
npm install dsh-plugin-subagents-orchestrator
```

Or via the DSH plugin command (equivalent; it goes through npm internally):

```bash
dsh plugin --profile desktop add dsh-plugin-subagents-orchestrator
```

`dsh plugin add` is the preferred route: besides installing the dependency into the profile, it automatically registers the plugin in the profile bundle stack (`dsh.profile.bundles`) - the package declares `dsh.bundle`, so no manual manifest editing is needed. A bare `npm install` (run inside your profile directory) only installs the dependency; you must add the package to `dsh.profile.bundles` yourself, as shown below.

You can also install straight from a GitHub repository:

```bash
dsh plugin --profile web add github:username/repository-name
```

Replace `username/repository-name` with this plugin's GitHub owner/repo, and `--profile` with the profile you boot. If pnpm asks to allow build scripts during a git-hosted install, add the exact key it prints under `allowBuilds` in the profile's `pnpm-workspace.yaml` and re-run the command.

### Install from source (local development)

Add as a local dependency in your profile (`~/.dsh/profiles/desktop/package.json`):

```json
{
  "dependencies": {
    "dsh-plugin-subagents-orchestrator": "link:C:/dev/dsh-plugin-subagents-orchestrator"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "...",
        "dsh-plugin-subagents-orchestrator"
      ]
    }
  }
}
```

Run `pnpm install` in your profile directory:
```bash
cd ~/.dsh/profiles/desktop
pnpm install
```

This manual route is the only one that needs the hand-edited `dsh.profile.bundles` registration - the `dsh plugin add` commands above keep the bundle stack in sync automatically.

---

## License

MIT (c) kardelitaitu