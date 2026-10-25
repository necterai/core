// Download the human behaviour datasets the browser tests replay (not redistributed in this repo:
// they belong to their authors). Tests that need them are skipped when they are missing.
//   pnpm datasets
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const BALABIT = 'https://raw.githubusercontent.com/balabit/Mouse-Dynamics-Challenge/master/training_files';
const files = {
  'cmu/DSL-StrongPasswordData.csv': 'https://www.cs.cmu.edu/~keystroke/DSL-StrongPasswordData.csv',
  'balabit/user12_session_2144641057.csv': `${BALABIT}/user12/session_2144641057`,
  'balabit/user15_session_0205904470.csv': `${BALABIT}/user15/session_0205904470`,
  'balabit/user16_session_0735651357.csv': `${BALABIT}/user16/session_0735651357`,
};
const root = new URL('../docs/research/datasets/', import.meta.url);
for (const [rel, url] of Object.entries(files)) {
  const out = new URL(rel, root);
  if (existsSync(out)) continue;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  mkdirSync(dirname(out.pathname), { recursive: true });
  writeFileSync(out, Buffer.from(await res.arrayBuffer()));
  console.log('fetched', rel);
}
