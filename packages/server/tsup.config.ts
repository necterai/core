import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'adapters/node': 'src/adapters/node.ts',
    'adapters/express': 'src/adapters/express.ts',
    'adapters/hono': 'src/adapters/hono.ts',
    'adapters/next': 'src/adapters/next.ts',
    'adapters/cloudflare': 'src/adapters/cloudflare.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2022',
  platform: 'neutral',
  external: ['node:http', 'node:stream'],
  treeshake: true,
});
