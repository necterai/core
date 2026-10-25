import { SIGNAL_CATALOG_LITE, type SignalDefinition } from '@necterai/core';

/**
 * Module signal ids. The canonical definitions (weights, classes, false-positive
 * notes) live in packages/core/src/catalog.ts; this re-export keeps the module's
 * registerAll() call working with older core builds that predate the merge.
 */
const IDS = new Set(['env.permissions-query-failing', 'env.chromium-build', 'env.no-google-voices']);
export const definitions: SignalDefinition[] = SIGNAL_CATALOG_LITE.filter((d) => IDS.has(d.id));
