// Wraps the minified <script> build as a JS module so server code can serve it without touching the
// filesystem (works on Node, Bun, Deno, Cloudflare Workers and Vercel Edge):
//   import source from '@necterai/browser/script-source'
import { readFileSync, writeFileSync } from 'node:fs';

const iife = readFileSync(new URL('../dist/necter.iife.js', import.meta.url), 'utf8').replace(/\n\/\/# sourceMappingURL=.*\s*$/, '\n');
const literal = JSON.stringify(iife);
const out = (name, body) => writeFileSync(new URL(`../dist/${name}`, import.meta.url), body);
out('script-source.js', `const source = ${literal};\nexport default source;\n`);
out('script-source.cjs', `"use strict";\nconst source = ${literal};\nmodule.exports = source;\nmodule.exports.default = source;\n`);
const dts = '/** The minified browser SDK (the same file as dist/necter.iife.js), ready to serve as /__necter/script.js. */\ndeclare const source: string;\nexport default source;\n';
out('script-source.d.ts', dts);
out('script-source.d.cts', dts);
