import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  outDir: 'lib',
  clean: true,
  dts: true,
  sourcemap: true,
  target: 'node20',
  splitting: false,
  bundle: true,
  external: ['node:fs', 'node:path', 'node:os', 'js-yaml']
});
