import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    clean: true,
    target: 'es2020',
    platform: 'browser',
    treeshake: true,
  },
  {
    // Drop-in <script> build: window.Necter
    entry: { necter: 'src/index.ts' },
    format: ['iife'],
    globalName: 'Necter',
    outExtension: () => ({ js: '.iife.js' }),
    sourcemap: true,
    minify: true,
    target: 'es2020',
    platform: 'browser',
    noExternal: ['@necterai/core', '@necterai/signatures'],
  },
]);
