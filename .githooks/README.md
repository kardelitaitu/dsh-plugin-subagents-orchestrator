# Git hooks

`pre-push` mirrors the CI gate locally: it runs **`pnpm run verify`**
(`tsc --noEmit` + `vitest run`) before anything leaves the machine, so a
commit that would turn the CI badge red cannot be pushed by accident.

## Install (once per clone)

```sh
pnpm run hooks:install     # sets core.hooksPath to .githooks (once per clone)
```

Installation is explicit on purpose: a `prepare` script would run for every
consumer that installs this repo from git (`dsh plugin add github:...`) and
break those installs, which is why it was removed in `64c00b0`. The hook is
purely local convenience - CI stays the source of truth.

## What it catches

Both ways this repo has actually broken CI:

| Push | Failure | Caught by |
| --- | --- | --- |
| `eaa7545` | probe tests committed before the config API they import (`getCachedMode is not a function`) | `vitest run` - `tsconfig.json` excludes `tests/`, so typecheck alone misses it |
| `69cc5ed` | feature commit with two `TS18046` errors in `src/settings.ts` | `tsc --noEmit` |

## Bypass

```sh
git push --no-verify                 # standard git escape hatch
DSH_SKIP_PUSH_VERIFY=1 git push      # same, per invocation
```

## Full local CI run

```sh
pnpm run ci:local          # verify + tsup build + publish preflight (offline registry)
pnpm run release:check     # the same preflight, including the npm registry probe
```

`release:check` is what a release is gated on: it packs a real tarball, installs
it into a throwaway consumer project and imports every published subpath before
npm ever sees it. See [CONTRIBUTING.md](../CONTRIBUTING.md#releasing).
