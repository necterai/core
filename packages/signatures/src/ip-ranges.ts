import { createCidrMatcher, type CidrMatcher } from './cidr.js';
import { bundledIpRanges } from './generated/ip-ranges.js';
import type { IpRangeSet } from './types.js';

/** Bundled, normalised range sets (agent feeds and small hosting/CDN lists). AWS/Azure/OCI/iCloud are sync-time only. */
export const ipRanges: IpRangeSet[] = bundledIpRanges;

export interface IpRangeIndex {
  /** Range sets containing `ip`, in ipRanges order. */
  lookup(ip: string): IpRangeSet[];
}

/** Build one matcher per range set (lazily usable for many lookups). */
export function createIpRangeIndex(sets: readonly IpRangeSet[] = ipRanges): IpRangeIndex {
  const entries: [IpRangeSet, CidrMatcher][] = sets.map((s) => [s, createCidrMatcher(s.prefixes)]);
  return { lookup: (ip) => entries.filter(([, m]) => m(ip)).map(([s]) => s) };
}

let defaultIndex: IpRangeIndex | undefined;

/** Range sets (bundled) that contain `ip`. */
export function findIpRanges(ip: string): IpRangeSet[] {
  defaultIndex ??= createIpRangeIndex();
  return defaultIndex.lookup(ip);
}
