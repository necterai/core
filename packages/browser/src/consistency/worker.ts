/**
 * Blob Worker cross-check (spec §7, cdp-leak-techniques.md §10.2 item 4). Stealth
 * scripts and hosted browsers override navigator in the main world only; a fresh
 * Worker realm still reports the host (ChatGPT agent: "Mac" main / "Linux" worker,
 * Browserbase basic tier the same). CSP `worker-src` may block the Blob worker:
 * the adapter resolves undefined and we skip silently.
 */
import type { WorkerSnapshot } from '../collectors/env.js';
import type { Finding } from '../collectors/finding.js';

export const WORKER_CODE = `(function(){try{var n=self.navigator;var d=n.userAgentData;self.postMessage({platform:n.platform,userAgent:n.userAgent,hardwareConcurrency:n.hardwareConcurrency,languages:Array.prototype.slice.call(n.languages||[]),uaDataPlatform:d?d.platform:undefined,brands:d&&d.brands?d.brands.map(function(b){return b.brand}):undefined});}catch(e){self.postMessage({error:String(e)});}})();`;

export interface MainSnapshot {
  platform: string;
  userAgent: string;
  hardwareConcurrency: number | undefined;
  languages: readonly string[];
  uaDataPlatform: string | undefined;
  brands: string[] | undefined;
}

export interface WorkerComparison {
  findings: Finding[];
  platformMismatch: boolean;
}

export function compareWorker(main: MainSnapshot, worker: WorkerSnapshot | undefined): WorkerComparison {
  if (!worker || typeof worker !== 'object' || typeof worker.platform !== 'string') return { findings: [], platformMismatch: false };
  const diffs: Array<{ key: string; main: string; worker: string; reliability: number }> = [];
  if (worker.platform !== main.platform) diffs.push({ key: 'navigator.platform', main: main.platform, worker: worker.platform, reliability: 1 });
  if (worker.userAgent !== main.userAgent) diffs.push({ key: 'navigator.userAgent', main: main.userAgent, worker: worker.userAgent, reliability: 1 });
  if (worker.uaDataPlatform !== undefined && main.uaDataPlatform !== undefined && worker.uaDataPlatform !== main.uaDataPlatform) {
    diffs.push({ key: 'userAgentData.platform', main: main.uaDataPlatform, worker: worker.uaDataPlatform, reliability: 1 });
  }
  if (worker.brands && main.brands && worker.brands.join('|') !== main.brands.join('|')) {
    diffs.push({ key: 'userAgentData.brands', main: main.brands.join(', '), worker: worker.brands.join(', '), reliability: 0.9 });
  }
  if (typeof worker.hardwareConcurrency === 'number' && typeof main.hardwareConcurrency === 'number' && worker.hardwareConcurrency !== main.hardwareConcurrency) {
    diffs.push({ key: 'navigator.hardwareConcurrency', main: String(main.hardwareConcurrency), worker: String(worker.hardwareConcurrency), reliability: 0.5 });
  }
  if (Array.isArray(worker.languages) && worker.languages.join(',') !== [...main.languages].join(',')) {
    diffs.push({ key: 'navigator.languages', main: [...main.languages].join(','), worker: worker.languages.join(','), reliability: 0.5 });
  }
  if (diffs.length === 0) return { findings: [], platformMismatch: false };
  const best = diffs.reduce((a, b) => (b.reliability > a.reliability ? b : a));
  return {
    platformMismatch: diffs.some((d) => d.key === 'navigator.platform' || d.key === 'userAgentData.platform'),
    findings: [
      {
        id: 'consistency.worker-platform-mismatch',
        summary: `${best.key} is "${best.main}" on the main thread but "${best.worker}" in a Worker${diffs.length > 1 ? ` (+${diffs.length - 1} more)` : ''}`,
        value: { key: best.key, main: best.main, worker: best.worker },
        details: { diffs },
        reliability: best.reliability,
        privacyGated: true,
      },
    ],
  };
}
