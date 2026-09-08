import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: ['src/index.ts', 'src/diagnostics.ts'],
    format: ['esm'],
    outDir: 'lib',
    clean: false,
    dts: true,
    sourcemap: true,
    target: 'node20',
    splitting: false,
    bundle: true,
    external: ['node:fs', 'node:path', 'node:os', 'js-yaml']
  },
  {
    entry: { client: 'src/client/index.tsx' },
    format: ['cjs'],
    outDir: 'lib',
    clean: false,
    dts: false,
    sourcemap: true,
    target: 'chrome100',
    splitting: false,
    bundle: true,
    outExtension() {
      return { js: '.js' };
    },
    external: [
      'react',
      'react/jsx-runtime',
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-client-runtime/client',
      '@deepseek-ai/dsh-client-ui-primitives',
      '@deepseek-ai/dsh-client-ui-slots'
    ],
    banner: {
      js: 'window.__ModuleLoader__.load({id: "dsh-plugin-subagents-orchestrator",factory: (require) => {var module = { exports: {} };var exports = module.exports;'
    },
    footer: {
      js: 'return module.exports;} });'
    }
  }
]);
