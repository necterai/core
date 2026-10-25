import type { AgentKind, AgentRecord, CompiledUaRule, UaMatch } from './types.js';
import tier1 from '../data/agents/tier1.json';
import tier2 from '../data/agents/tier2.json';
import tools from '../data/agents/tools.json';
import utility from '../data/agents/utility.json';
import libraries from '../data/agents/libraries.json';

/** Every declared-identity record (operators, tools, utility bots, HTTP libraries, headless markers). */
export const agents: AgentRecord[] = [
  ...(tier1 as unknown as AgentRecord[]),
  ...(tier2 as unknown as AgentRecord[]),
  ...(tools as unknown as AgentRecord[]),
  ...(utility as unknown as AgentRecord[]),
  ...(libraries as unknown as AgentRecord[]),
];

/** Tie-break rank when two records match equally long substrings (mirrors the server analyzer). */
export const KIND_RANK: Record<AgentKind, number> = { agent: 5, crawler: 5, utility: 4, headless: 3, 'http-library': 2, unverifiable: 1 };

export function compileUaRules(records: readonly AgentRecord[]): CompiledUaRule[] {
  const rules: CompiledUaRule[] = [];
  for (const record of records) {
    for (const pattern of record.uaPatterns) {
      rules.push({ re: new RegExp(pattern, 'i'), pattern, record });
    }
  }
  return rules;
}

export type UaMatcher = (ua: string) => UaMatch[];

/**
 * Build a matcher over `records`. Each record contributes at most one match (its longest
 * matching pattern). Results are ordered by specificity: longest matched substring first,
 * then record kind (agent/crawler > utility > headless > http-library > unverifiable),
 * then uaMatchConfidence, then data order.
 */
export function createUaMatcher(records: readonly AgentRecord[]): UaMatcher {
  const rules = compileUaRules(records);
  const order = new Map(records.map((r, i) => [r, i] as const));
  return (ua: string): UaMatch[] => {
    if (typeof ua !== 'string' || !ua) return [];
    const best = new Map<AgentRecord, UaMatch>();
    for (const rule of rules) {
      const m = rule.re.exec(ua);
      if (!m) continue;
      const prev = best.get(rule.record);
      if (prev && prev.matched.length >= m[0].length) continue;
      best.set(rule.record, { record: rule.record, matched: m[0], index: m.index, pattern: rule.pattern, confidence: rule.record.uaMatchConfidence ?? 1 });
    }
    return [...best.values()].sort(
      (a, b) =>
        b.matched.length - a.matched.length ||
        KIND_RANK[b.record.kind] - KIND_RANK[a.record.kind] ||
        b.confidence - a.confidence ||
        order.get(a.record)! - order.get(b.record)!,
    );
  };
}

const defaultMatcher = createUaMatcher(agents);

/** Match a User-Agent against every bundled record, most specific first. */
export function matchUserAgent(ua: string): UaMatch[] {
  return defaultMatcher(ua);
}

const byId = new Map(agents.map((a) => [a.id, a] as const));

export function getAgent(id: string): AgentRecord | undefined {
  return byId.get(id);
}
