/**
 * @necterai/signatures: knowledge base of AI agents, crawlers, automation stacks and their
 * observable artifacts. All data is bundled JSON (see data/ and README.md).
 */
export const SIGNATURES_VERSION = '0.1.0';
/** Date the research snapshot (and bundled IP seeds) were captured. */
export const SNAPSHOT_DATE = '2026-10-24';

export * from './types.js';
export { agents, matchUserAgent, createUaMatcher, compileUaRules, getAgent, KIND_RANK, type UaMatcher } from './agents.js';
export { ipRanges, findIpRanges, createIpRangeIndex, type IpRangeIndex } from './ip-ranges.js';
export { createCidrMatcher, parseIp, parseCidr, isValidCidr, canonicalPrefix, type CidrMatcher, type CidrRange, type ParsedIp } from './cidr.js';
export { parseIpFeed, toIpRangeSet, dedupePrefixes, type ParsedFeed } from './ip-parse.js';
export {
  httpLibraryProfiles,
  browserHeaderProfiles,
  webBotAuthDirectories,
  webBotAuthAbsent,
  hostingAsns,
  sharedEgress,
  hostedAgentProfiles,
  automationGlobals,
  agentDomArtifacts,
  agentExtensions,
  agentHostShapes,
  automationDefaults,
  ipSources,
} from './data.js';
