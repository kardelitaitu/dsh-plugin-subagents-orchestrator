# Contributing

## Development setup

```bash
pnpm install        # dependencies
pnpm test           # vitest over tests/**/*.test.ts
pnpm typecheck      # tsc --noEmit
pnpm build          # tsup -> lib/
pnpm run verify     # typecheck + tests (what the pre-push hook runs)
pnpm run ci:local   # verify + build + publish preflight, offline
pnpm run release:check   # the full publish gate (see Releasing)
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

## Releasing

Publishing is one tag push; everything before it is local and checkable.

```sh
pnpm run hooks:install     # once per clone (no auto-install; see .githooks/README.md)
pnpm run release:check     # publish preflight
```

1. **Land the work on `main`.** The pre-push hook runs typecheck + the suite so a
   red tree cannot leave the machine; CI is still the source of truth.
2. **Cut the version** in one commit: `version` in `package.json` plus a matching
   `## [X.Y.Z]` section in `CHANGELOG.md` (`release:check` refuses a version the
   changelog does not describe), and the `lib/` rebuild. `lib/` is committed on
   purpose - a git-hosted install (`dsh plugin add github:owner/repo`) ships it as-is -
   so both CI and the release workflow fail when it no longer matches `src/`.
   Semantic versioning is a promise to consumers: new config keys and
   subpaths are a minor bump, anything that changes routing defaults is major.
3. **Preflight** with `pnpm run release:check`. Stages: manifest metadata -> docs ->
   real `npm pack` -> install the tarball into a throwaway consumer project and
   import every published subpath (plus a license audit of the resolved
   runtime closure) -> `repository.url`-vs-origin cross-check -> registry
   duplicate-version probe. Add `--build-parity` to prove the committed `lib/` matches
   a fresh build, or `--skip-install` / `--offline` when there is no network.
4. **Tag and push**: `git tag -a vX.Y.Z -m "release X.Y.Z" && git push origin vX.Y.Z`.
   `.github/workflows/release.yml` re-runs the whole gate, packs the artifact and
   publishes it with npm OIDC provenance, so no long-lived token has to sit in
   repository secrets. One-time setup either way: npm must know this repo is
   allowed to publish the name - configure a trusted publisher (a *pending*
   publisher, since the package does not exist yet) in the npm web UI, or add
   an `NPM_TOKEN` repository secret and the workflow uses that instead. Rehearse
   first via *Actions -> Release -> Run workflow* with `dry_run` on: it runs every
   step including the pack and the artifact upload and stops before publish.
5. **Verify from the registry**: `npm view dsh-plugin-subagents-orchestrator version`,
   then install it into a profile with
   `dsh plugin --profile desktop add dsh-plugin-subagents-orchestrator`.

Rules that keep a release honest:

- Never publish from a working tree - the workflow publishes what it packs from
  the tag, so uncommitted work is simply not in the release. If you must publish
  by hand (the tag workflow is unavailable), run `pnpm run release:check --
  --require-clean` first: it fails when any path in the `files` allowlist
  differs from HEAD, which in a shared checkout means someone else’s work.
- A tag is immutable. If a published tag's workflow run failed, fix forward with
  the next patch version; do not move or re-point the tag.
- `npm deprecate` is the only rollback: a published version cannot be deleted
  inside the 72-hour window, so `npm unpublish` is not part of this process.

### When a GitHub Actions bump lands

Dependabot opens these as ordinary pull requests, and CI on them proves only
that `verify` still passes - `.github/workflows/release.yml` never runs on a
pull request. Merge them one at a time and watch the two artifact jobs
(`pack-release-artifact` -> `unpack-release-artifact`), which exist to cover
the upload/download pair the publish job depends on. Facts from upstream, as
of the pending bumps:

- `actions/download-artifact` v8 makes digest mismatches an error instead of a
  warning and no longer assumes every artifact is zipped. Together with
  `actions/upload-artifact` v7 (direct, unzipped single-file uploads), a
  silent behaviour change here would surface as a corrupt or missing tarball
  in the publish job - the exact failure these two jobs are for.
- `actions/upload-artifact` v5+ and `download-artifact` v6+ run on Node 24 and
  need an Actions runner >= 2.327.1. GitHub-hosted runners are fine; a
  self-hosted runner would fail the workflow before any of our steps.
- `actions/setup-node` v5 auto-enables dependency caching when
  `packageManager` is present, v6 narrowed that to npm only, and v7 removed
  the dummy `NODE_AUTH_TOKEN` export. That export is the reason the publish
  job runs without `registry-url`: an earlier major writes an `_authToken`
  placeholder into the npmrc whenever `registry-url` is set, and an explicit
  token entry outranks the OIDC identity npm provenance needs. The gate job still
  passes `registry-url` (it publishes nothing, and the preflight registry probe
  wants the canonical host); when you bump setup-node, re-justify that difference
  instead of copying it forward.
- `pnpm/action-setup` v6 ships pnpm 11 and its README now points at the
  successor `pnpm/setup` action. The `version: 10` pin in both workflows is
  what keeps CI matching the pnpm 10 store layout the preflight smoke-tests.

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
