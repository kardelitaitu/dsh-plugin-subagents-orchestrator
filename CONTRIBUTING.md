# Contributing

## Development setup

```bash
pnpm install        # dependencies
pnpm test           # vitest over tests/**/*.test.ts
pnpm typecheck      # tsc --noEmit
pnpm build          # tsup -> lib/
```

Host-contract facts (event surface, failure taxonomy, retry layering) are
documented in [ARCHITECTURE.md](./ARCHITECTURE.md) — read it before touching
the failover or pacing logic.

## Concurrent agent sessions

This repository is worked by **multiple agent sessions sharing one checkout**,
committing every few minutes. The protocol below is enforced by practice; it
exists so independent work streams never corrupt each other.

### Owning and respecting in-flight files

- A dirty file in `git status` belongs to the session editing it. Never
  commit, revert, format, or "fix" another session's uncommitted work.
- Untracked `tests/tddN.test.ts` files are active TDD probes for the round in
  progress. Read them to learn where the repo is heading — but do not edit.
- A failing test file that belongs to another session (e.g. a transient parse
  error mid-write) is **their bug to fix** and typically self-resolves within
  minutes. Verify ownership before diagnosing; never hot-patch in place.

### Picking a lane

1. `git log --oneline -3` and `git status --porcelain` before acting — HEAD
   moves constantly.
2. Choose work in files **not currently dirty**; if your target is held,
   pick a different deliverable and come back.
3. Stable lane split: one session drives the runtime loop (`src/index.ts`,
   TDD rounds), another owns adjacent modules, docs, and tooling. Probe
   suites that pin **another session's module** are welcome — a healthy
   contract holds without modifying the module under test.

### Editing under concurrency

- The file-edit tool requires a fresh read of the target ("file changed since
  it was read" means someone else touched it). Re-read and retry once.
- If a file is being actively edited by another session, stop using the edit
  tool on it. Use an **atomic scripted rewrite** instead: write a temporary
  patch script (node script with exact anchor checks) and run it once. A
  script that finds its anchor missing reports `ANCHOR-MISSING` rather than
  corrupting the file.
- Shell one-liners with nested quotes are error-prone; prefer the temp-script
  pattern for anything beyond a trivial substitution.

### Committing

- Commit only files you changed: explicit scoped `git add <paths>`, never
  `git add -A`.
- Before landing on a shared file (README, CHANGELOG, package.json),
  re-check `git status`; if it went dirty mid-flight, either commit your
  verified lines only or leave the file for the other session's next docs
  commit.
- A quiescence check (short wait, re-run `git status --porcelain | wc -l`)
  helps confirm no one is mid-write when your change spans shared files.
- `lib/` build output is rebuilt by whoever lands last. Never commit a build
  compiled from another session's uncommitted source.
- Interleaved histories are normal: expect commits from the other session to
  land between yours; rebase-free linear flow is preserved by scoped commits.

## Host-plane safety invariants

Non-negotiable for any change to the plugin runtime:

- **Never reject or stall a subagent start.** The plugin sits on the host
  plane; overflow and pass-through behaviors are intentional.
- **Never veto the Cordis waterfall by accident.** A listener that doesn't
  call `next()` vetoes the whole chain — every internal-error path must
  delegate (see ARCHITECTURE.md §1).
- **Diagnostics must fail soft.** Telemetry, persistence and report paths
  return sentinels on failure; they may never throw into the host plane.
- **No disk I/O on the hot path.** Config is a zero-I/O cached snapshot;
  telemetry persistence is opt-in and dispose-time only.

## Test conventions

- Vitest, `tests/**/*.test.ts`; shared mock Cordis context in
  `tests/mocks/cordis.ts`.
- Config-dependent tests pass explicit values (e.g. `intervalMinMs: 0`) so
  default changes never break unrelated suites.
- Failure-behavior tests set `maxRetries: 0` when they need first-failure
  crossover; the default budget (20) is exercised by dedicated suites.
