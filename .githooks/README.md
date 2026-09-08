# Git hooks

`pre-push` mirrors the CI gate locally: it runs **`pnpm run verify`**
(`tsc --noEmit` + `vitest run`) before anything leaves the machine, so a
commit that would turn the CI badge red cannot be pushed by accident.

## Install (once per clone)

```sh
npm run hooks:install      # sets core.hooksPath to .githooks
```

Any `pnpm install` / `npm install` in this repo runs the same command through
the `prepare` script, so a fresh clone is wired automatically. The hook is
purely local convenience - CI stays the source of truth, and `prepare` never
fails a non-git install.

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
pnpm run ci:local    # verify + tsup build + npm pack --dry-run
```
