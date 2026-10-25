/**
 * First-visit amnesia (spec §1, informational): a brand-new profile with no prior
 * storage, a one-entry history and no referrer. Every genuine first visit looks
 * like this, so the weight is informational; it only matters in aggregate.
 */
import type { Finding } from './finding.js';

export function analyzeStorage(firstVisit: boolean, historyLength: number | undefined, referrer: string): Finding[] {
  if (!firstVisit) return [];
  if (typeof historyLength === 'number' && historyLength > 1) return [];
  if (referrer) return [];
  return [
    {
      id: 'env.first-visit-amnesia',
      summary: `first visit, history.length ${historyLength ?? 'n/a'}, no referrer`,
      value: { historyLength: historyLength ?? null, referrer: false },
    },
  ];
}
