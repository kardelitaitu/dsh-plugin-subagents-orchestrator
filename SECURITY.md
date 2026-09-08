# Security Policy

## Supported versions

| Version | Supported |
| :--- | :--- |
| 1.2.x | :white_check_mark: |
| 1.1.x | :white_check_mark: |
| < 1.1 | :heavy_multiplication_x: (no release reached npm before 1.2.0) |

Fixes land on `main` first and are cut as a patch release; the changelog names
the version that carries each fix.

## What this plugin does, in trust terms

It is a **host-plane** Cordis plugin: it runs inside your DSH process, with your
process's file permissions. Concretely:

- It **reads** `~/.dsh/settings.yaml` (and re-reads it on change) to resolve the
  `subagents-orchestrator` section. Anything that can write that file can point
  subagent traffic at provider/model pairs it chooses, so treat the profile
  directory like the credential store it sits next to.
- It **changes the provider/model of subagent starts only**. Parent sessions,
  explicit per-call overrides and parked endpoints are never touched, and a
  start is never rejected, queued or stalled by this plugin - the orchestrator
  degrades to unrouted instead.
- It **does not handle API keys**. Endpoints are `provider` + `model` names resolved
  against the credentials your DSH profile already holds; the plugin never
  reads, logs or persists a credential or a request body.
- Telemetry (`debug`, `persistTelemetry`) records timestamps, agent ids,
  provider/model names, failure codes and latency - nothing else.
  `persistTelemetry` is off by default; when enabled it writes day-bucketed JSONL
  (7-day retention) under `~/.dsh/telemetry/subagents-orchestrator`, and the offline
  reader (`pnpm report`) is read-only.
- The published package is plain JavaScript built by `tsup` from `src/`. It has no
  install-time scripts - deliberately: a `prepare` script would run for every
  consumer that installs this repo from git - and `pnpm run release:check` fails a
  release that adds one back.

## Reporting a vulnerability

Open a **private security advisory** on
[the repository](https://github.com/kardelitaitu/dsh-plugin-subagents-orchestrator/security/advisories/new)
instead of a public issue. Please include:

- the plugin version (`npm ls dsh-plugin-subagents-orchestrator`),
- the DSH version and profile you run it in,
- your `subagents-orchestrator` config, with any model names you consider private
  removed,
- the diagnostics snapshot (`pnpm report --json` with `persistTelemetry` on, or
  `getDiagnosticsSnapshot()` from the `./diagnostics` subpath; neither contains
  credentials).

Expect an acknowledgement within a week. Releases are published with npm
provenance attestation, so a published tarball can be traced to the exact commit
and CI run that produced it.
