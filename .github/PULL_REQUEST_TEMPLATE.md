## What changes

-

## Checklist

- [ ] `pnpm run verify` passes (strict typecheck + vitest)
- [ ] Config-facing change: the README options table and `src/types.ts` agree
- [ ] Behaviour change: a probe test pins the new contract; the existing suite still passes
- [ ] Host-plane invariants hold: no start is rejected, queued or stalled, and a
      telemetry/persistence failure never throws into the host plane
- [ ] User-visible change: `CHANGELOG.md` entry added (the publish gate requires a
      section for the version being cut)
- [ ] `src/` changed: `pnpm build` output committed (`lib/` ships in git-hosted installs)
- [ ] Packaging/metadata change: `pnpm run release:check` passes (it installs the real
      tarball and imports every published subpath)
