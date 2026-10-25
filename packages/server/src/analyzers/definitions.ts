import { SIGNAL_CATALOG, type SignalDefinition } from '@necterai/core';

/**
 * Module signal ids. The canonical definitions (weights, classes, false-positive
 * notes) live in packages/core/src/catalog.ts; this re-export keeps the module's
 * registerAll() call working with older core builds that predate the merge.
 */
const IDS = new Set(['declared.agent-header', 'request.h2c-upgrade']);
export const serverSignalDefinitions: SignalDefinition[] = SIGNAL_CATALOG.filter((d) => IDS.has(d.id));
