import { SIGNAL_CATALOG } from './src/catalog.ts';
const ids = process.argv.slice(2);
for (const d of SIGNAL_CATALOG) if (ids.length === 0 ? d.classes && ('computer-use-agent' in d.classes || 'extension-agent' in d.classes) : ids.includes(d.id)) console.log(d.id.padEnd(42), d.weight, JSON.stringify(d.classes));
