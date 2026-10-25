// Set one version across every published package and the VERSION constants in their source.
//   node scripts/set-version.mjs 0.2.0
import { readFileSync, writeFileSync } from 'node:fs';

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version ?? '')) {
  console.error('usage: node scripts/set-version.mjs <semver>');
  process.exit(1);
}
const edit = (file, fn) => writeFileSync(file, fn(readFileSync(file, 'utf8')));
for (const pkg of ['core', 'signatures', 'browser', 'server']) {
  edit(`packages/${pkg}/package.json`, (s) => s.replace(/"version": "[^"]+"/, `"version": "${version}"`));
}
const constants = {
  'packages/core/src/index.ts': 'CORE_VERSION',
  'packages/signatures/src/index.ts': 'SIGNATURES_VERSION',
  'packages/browser/src/version.ts': 'BROWSER_SDK_VERSION',
  'packages/server/src/index.ts': 'SERVER_SDK_VERSION',
};
for (const [file, name] of Object.entries(constants)) {
  edit(file, (s) => s.replace(new RegExp(`(export const ${name} = ')[^']+(')`), `$1${version}$2`));
}
console.log(`set version ${version}; now commit, then: git tag v${version} && git push --tags`);
