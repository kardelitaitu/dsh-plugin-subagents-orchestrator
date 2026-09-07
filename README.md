# DSH Subagents Orchestrator (`dsh-plugin-subagents-orchestrator`)

> Intelligent multi-endpoint load distributor and automated error-failover plugin for **DeepSeek Harness (DSH)** subagents.

---

## Overview

When building complex projects with DeepSeek Harness, tasks are often delegated to multiple concurrent subagents (e.g. `subagent`, `subagent_fork`). Without orchestration, all subagents default to the parent session model endpoint, which rapidly exhausts rate limits, triggers concurrency throttles, or causes overall session failure when a provider experiences transient errors.

`dsh-plugin-subagents-orchestrator` is a lightweight, host-plane Cordis plugin that intercepts all subagent creations and:
1. **Distributes subagent workloads** across multiple LLM provider accounts/endpoints using **round-robin** or **random** strategies.
2. **Provides automated, resilient failover**: If a subagent encounters a rate limit (`RATE_LIMIT`), quota exhaustion (`QUOTA`), server error (`SERVER`), timeout (`TIMEOUT`), or transport issue (`TRANSPORT`), the plugin dynamically retries that subagent on the next configured endpoint in your pool without failing the main conversation.
3. **Zero UI interference**: Runs entirely on the host plane, meaning zero risk of client module crashes, web boot stalls, or frontend incompatibilities.

---

## Key Features

- **Multi-Endpoint Load Balancing**: Evenly spreads subagent calls across different provider keys and endpoints (e.g. `b-ai-1`, `b-ai-2`, `b-ai-3`, `b-ai-4`, `b-ai-5`).
- **Subagent-Only Error Failover**: Intercepts `agent/request-error` specifically for sessions where `origin === "subagent"`, preserving the main agent session integrity.
- **Hot-Reloadable Configuration**: Reads settings directly from `~/.dsh/settings.yaml` on the fly - changes take effect on the very next subagent call without restarting DSH.
- **Respects Explicit Overrides**: If a specific subagent call explicitly requests a model/provider, the orchestrator respects the caller intent and skips routing.
- **Native Cordis Integration**: Built on Cordis lifecycle hooks and wraps `ctx.subagents.start()` and `ctx.subagents.startContinuable()`.

---

## Configuration

Add the `subagents-orchestrator` section to your `~/.dsh/settings.yaml`:

```yaml
subagents-orchestrator:
  enabled: true
  strategy: round-robin   # "round-robin" or "random"
  failover: true          # Automatically switch endpoint on failure
  endpoints:
    - provider: b-ai-1-adikaradwiatmaja
      model: glm-5.3-flash
    - provider: b-ai-2-atmajacreative
      model: glm-5.3-flash
    - provider: b-ai-3-gimoruru
      model: glm-5.3-flash
    - provider: b-ai-4-fannyxborg6
      model: glm-5.3-flash
    - provider: b-ai-5-kardelitaitu2
      model: glm-5.3-flash
```

### Options

| Field | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `enabled` | `boolean` | `true` | Enable or disable subagent orchestration |
| `strategy` | `string` | `"round-robin"` | Distribution algorithm: `"round-robin"` or `"random"` |
| `failover` | `boolean` | `true` | Automatically failover to next endpoint on rate limits/errors |
| `endpoints` | `array` | `[]` | List of `{ provider, model, reasoningEffort? }` endpoints |

---

## Project Structure

```
C:/dev/dsh-plugin-subagents-orchestrator/
├── lib/
│   └── index.js            # Core host-plane plugin & Cordis hooks
├── cordis.patch.yml        # DSH Cordis profile patch definition
├── package.json            # NPM package manifest
├── README.md               # Project documentation
└── ROADMAP.md              # Future development roadmap
```

---

## Installation into DSH

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

---

## License

MIT (c) Adikara