import type { ActorClass, ProviderId } from '@necterai/core';

/**
 * Record types for @necterai/signatures.
 *
 * Contract note: the server consumes these through packages/server/src/knowledge.ts.
 * Where that adapter and the original research schema disagreed, the knowledge.ts
 * shape wins (field names and value domains) and the richer research detail is kept
 * in additional, optional fields. Each such place is marked "contract:" below.
 */

/** Catalog ids a declared-identity match may emit (see packages/core/src/catalog.ts). */
export type DeclaredSignalId =
  | 'declared.ai-agent-ua'
  | 'declared.ai-crawler-ua'
  | 'declared.search-crawler-ua'
  | 'declared.utility-bot-ua'
  | 'declared.http-library-ua'
  | 'declared.headless-ua';

export type VerificationMethod = 'ip-range' | 'rdns' | 'web-bot-auth' | 'none';
export type RobotsRespect = 'yes' | 'no' | 'partial' | 'unknown';
export type EvidenceConfidence = 'confirmed' | 'observed' | 'reported' | 'uncertain';

/**
 * What kind of record this is; drives the declared.* signal id and tie-breaking in the
 * server's user-agent analyzer (knowledge.ts `kind`).
 * - agent: fetchers and browser / computer-use / extension agents
 * - crawler: AI and search crawlers
 * - utility: wanted utility bots (unfurlers, monitors, previews)
 * - http-library: a stock HTTP client's default UA
 * - headless: headless-browser markers in the UA
 * - unverifiable: tokens that appear only in third-party lists (no operator documentation)
 */
export type AgentKind = 'agent' | 'crawler' | 'http-library' | 'headless' | 'utility' | 'unverifiable';

export interface AgentWebBotAuth {
  /**
   * contract: boolean (knowledge.ts). True when the product is known to sign at least
   * some of its requests with RFC 9421 / Web Bot Auth as of the snapshot date.
   */
  signs: boolean;
  /** Research detail behind `signs`: every request, a subset, opt-in (off by default), or not known. */
  coverage?: 'all' | 'partial' | 'optional' | 'none' | 'unknown';
  /** Origin that hosts /.well-known/http-message-signatures-directory, when known. */
  directoryUrl?: string;
  /** Exact Signature-Agent value seen on the wire. */
  signatureAgent?: string;
}

export interface AgentRecord {
  /** Stable slug used in verdicts, policies and tests. */
  id: string;
  provider: ProviderId;
  product: string;
  class: ActorClass;
  /** See AgentKind. */
  kind: AgentKind;
  /** Class-profile override for the emitted signal (knowledge.ts `classes`). */
  classes?: Partial<Record<ActorClass, number>>;
  /** Case-insensitive regex sources matched against the User-Agent. Empty when the agent has no stable token. */
  uaPatterns: string[];
  /** Real UA strings from the research (placeholders such as Chrome/W.X.Y.Z kept verbatim). */
  uaExamples: string[];
  /** URLs of provider-published IP range feeds (see data/ip-ranges/sources.json). */
  ipRangeUrls: string[];
  /** Forward-confirmed reverse-DNS suffixes published by the operator. */
  rdnsSuffixes: string[];
  /** robots.txt product tokens. */
  robotsTokens: string[];
  webBotAuth: AgentWebBotAuth;
  /** contract: boolean (knowledge.ts); omitted when unknown. Does the product execute JavaScript? */
  executesJs?: boolean;
  /** contract: boolean (knowledge.ts). Does the product identify itself on the wire (UA token or signature)? */
  selfIdentifies: boolean;
  verification: VerificationMethod[];
  respectsRobots: RobotsRespect;
  /** Catalog signal to emit when the UA matches. */
  signal: DeclaredSignalId;
  /**
   * How much a UA match alone says about the product (0..1). Defaults to 1 for
   * unique tokens; lower for strings that ordinary browsers can also send.
   */
  uaMatchConfidence?: number;
  /** Research confidence of the record as a whole. */
  evidence: EvidenceConfidence;
  /** Where the product runs. */
  runsWhere?: 'operator-cloud' | 'user-device' | 'customer-env' | 'unknown';
  notes: string;
  sources: string[];
}

export interface UaMatch {
  record: AgentRecord;
  /** The substring of the UA that matched. */
  matched: string;
  /** Index of the match inside the UA. */
  index: number;
  /** The regex source that matched. */
  pattern: string;
  /** record.uaMatchConfidence ?? 1 */
  confidence: number;
}

export interface CompiledUaRule {
  re: RegExp;
  pattern: string;
  record: AgentRecord;
}

// ───────────────────────── IP ranges ─────────────────────────

export type IpSourceFormat =
  | 'prefixes-json'
  | 'aws-json'
  | 'azure-json'
  | 'oci-json'
  | 'fastly-json'
  | 'ipverse-json'
  | 'csv-geofeed'
  | 'txt-lines'
  | 'html-embedded-json'
  | 'html-ip-scan'
  | 'cidr-scan';

/** contract: knowledge.ts uses 'agent' | 'hosting' | 'cdn' | 'shared-egress' (types.ts had 'relay'). */
export type IpRangeKind = 'agent' | 'hosting' | 'cdn' | 'shared-egress';

export interface IpSource {
  /** Output file name under data/ip-ranges/<id>.json */
  id: string;
  provider: ProviderId;
  product: string;
  /** Canonical feed URL. */
  url: string;
  /** Additional URLs merged into the same set (e.g. Cloudflare v4 + v6). */
  urls?: string[];
  format: IpSourceFormat;
  kind: IpRangeKind;
  /** Whether the normalised file ships in the npm bundle (false = sync-time download only). */
  bundled: boolean;
  /** false = never fetched by the sync script (hand-maintained, e.g. ranges quoted on an HTML docs page). */
  sync?: boolean;
  /** Seed file under data/ip-ranges/raw used to normalise offline. */
  seedFile?: string;
  /** Format of the seed when it differs from the live feed (e.g. an HTML page captured instead of the JSON). */
  seedFormat?: IpSourceFormat;
  /** Prefixes transcribed verbatim from the research (merged with the seed, if any). */
  inlinePrefixes?: string[];
  transcribedFrom?: string;
  /** The bundled data is a known subset of the published list. */
  partial?: boolean;
  /** Optional filter for multi-service feeds (aws: {service}, azure: {name}). */
  filter?: Record<string, string>;
  /** Agent record ids whose claims this source verifies. */
  agentIds?: string[];
  notes?: string;
}

/** A normalised range set (data/ip-ranges/<id>.json). Shape required by knowledge.ts `IpRangeSet`. */
export interface IpRangeSet {
  id: string;
  provider: ProviderId;
  product?: string;
  kind: IpRangeKind;
  /** Feed URL the prefixes came from. */
  source: string;
  /** ISO date/timestamp of the fetch. */
  fetchedAt: string;
  /** creationTime / syncToken date as published by the feed, if any. */
  creationTime?: string;
  /** Only a sample of the published list is bundled. */
  partial?: boolean;
  /** Set when (some) prefixes were transcribed from the research rather than parsed from a feed. */
  transcribedFrom?: string;
  agentIds?: string[];
  prefixes: string[];
}

/** contract: knowledge.ts shape {asn, name, kind, provider?}; `role`/prefixListUrl are extras. */
export interface HostingAsn {
  asn: number;
  name: string;
  kind: 'cloud' | 'hosting' | 'cdn' | 'shared-egress';
  provider?: ProviderId;
  /** ipverse aggregated prefix list, syncable. */
  prefixListUrl?: string;
  notes?: string;
  sources?: string[];
}

/** contract: knowledge.ts `SharedEgressList` {id, name, kind, prefixes, asns?, partial?}. */
export interface SharedEgressList {
  id: string;
  name: string;
  kind: 'relay' | 'vpn' | 'enterprise-proxy' | 'cgnat' | 'cdn-proxy';
  provider?: ProviderId;
  /** Egress prefixes known from the research (bundled sample). Full list via `listUrl`. */
  prefixes: string[];
  asns?: number[];
  partial?: boolean;
  /** How a detector should treat traffic from it. */
  treatment?: 'suppress-datacenter' | 'tag-only';
  listUrl?: string;
  format?: IpSourceFormat;
  /** Documented ingress ranges (where clients connect TO; never seen as a client IP at an origin). */
  ingressPrefixes?: string[];
  dnsNames?: string[];
  notes?: string;
  sources?: string[];
}

/** @deprecated alias kept for the original schema name. */
export type SharedEgressDescriptor = SharedEgressList;

// ───────────────────────── HTTP / TLS fingerprints ─────────────────────────

/**
 * contract: knowledge.ts `HttpLibraryProfile`. Header names in `headerOrder` are lower-cased;
 * the exact wire casing is in `h1HeaderOrderRaw`.
 */
export interface HttpLibraryProfile {
  id: string;
  name: string;
  language?: string;
  version?: string;
  /** Regex source matched against the UA; omitted when the library sends no User-Agent. */
  uaPattern?: string;
  uaExample?: string | null;
  /** Exact HTTP/1.1 header-name order on the wire, lower-cased. */
  headerOrder?: string[];
  /** Exact HTTP/1.1 header names as captured (case preserved). */
  h1HeaderOrderRaw?: string[];
  /** The library emits lower-case header names on HTTP/1.1. */
  lowercaseH1?: boolean;
  accept?: string;
  /** Accept-Encoding literals seen (varies with optional brotli/zstd modules). */
  acceptEncoding?: string[];
  acceptLanguage?: string;
  connection?: string;
  /** Full JA4 values measured (fresh and resumed variants). */
  ja4?: string[];
  ja3?: string[];
  /** JA4 `b` (cipher-hash) sections that identify the TLS library. */
  ja4Cipher?: string[];
  /** The cipher hash is shared with a real browser family (do not use `b` alone). */
  cipherSharedWithBrowser?: 'firefox' | 'chromium' | 'safari';
  grease?: boolean;
  /** Akamai HTTP/2 fingerprints. */
  akamai?: string[];
  /** HTTP/2 pseudo-header order (m,a,s,p...). */
  pseudoOrder?: string;
  /** First ALPN value offered: h1 = http/1.1 first, h2, none = no ALPN. */
  alpnFirst?: 'h1' | 'h2' | 'none';
  /** ALPN list offered, in order (null = no ALPN extension). */
  alpn?: string[] | null;
  /** Base64 HTTP2-Settings payload sent with Upgrade: h2c on plaintext. */
  http2Settings?: string[];
  httpVersionDefault?: 'h1' | 'h2';
  notes?: string;
  sources?: string[];
}

/** contract: knowledge.ts `BrowserHeaderProfile`; extras: id, version, h1HeaderOrderRaw, notes, sources. */
export interface BrowserHeaderProfile {
  id: string;
  family: 'chromium' | 'firefox' | 'safari';
  version?: string;
  accept: string;
  acceptEncoding: string;
  /** HTTP/1.1 navigation header order (lower-cased names). */
  navigationOrder: string[];
  h1HeaderOrderRaw?: string[];
  pseudoOrder: string;
  akamai: string[];
  ja4Cipher: string[];
  ja4?: string[];
  http2Settings?: string;
  titleCaseH1: boolean;
  grease?: boolean;
  clientHints?: boolean;
  priorityHeader?: boolean;
  notes?: string;
  sources?: string[];
}

// ───────────────────────── Web Bot Auth ─────────────────────────

/** contract: knowledge.ts `WebBotAuthDirectory` {origin, provider, product?, purpose?, status, classes?}. */
export interface WebBotAuthDirectory {
  /** Origin (https://host) or a glob with `*` labels for per-tenant hosts. */
  origin: string;
  provider: ProviderId;
  product?: string;
  purpose?: string;
  /** live = valid directory fetched; broken = served but unusable; survey = valid per the 2026-10-19 survey, not re-fetched. */
  status: 'live' | 'broken' | 'survey';
  classes?: Partial<Record<ActorClass, number>>;
  keys?: number;
  kids?: string[];
  kidStyle?: 'thumbprint' | 'short' | 'none' | 'mixed';
  signatureAgent?: string;
  labelsSeen?: string[];
  cacheControl?: string;
  quirks?: string[];
  asOf?: string;
  sources?: string[];
}

/** Hosts probed for a directory that had none (useful to avoid refetching and for attribution tables). */
export interface WebBotAuthAbsence {
  origin: string;
  provider: ProviderId;
  result: string;
  asOf: string;
}

// ───────────────────────── in-page artifacts ─────────────────────────

export interface AutomationGlobalRule {
  /** Regex source tested against own property names of window/globalThis (or document when scope says so). */
  pattern: string;
  scope: 'window' | 'document' | 'function-source' | 'prototype';
  stack: string;
  provider?: ProviderId;
  signal: string;
  /** main = visible to page JS; isolated = only in the extension/utility world (documented, not probeable). */
  visibility: 'main' | 'isolated' | 'conditional';
  confidence: EvidenceConfidence;
  notes?: string;
}

export interface AgentDomArtifact {
  selector: string;
  stack: string;
  provider?: ProviderId;
  signal: string;
  /** Where the element lives: light DOM, inside a closed shadow root (not queryable), or attribute on page elements. */
  where: 'light-dom' | 'closed-shadow' | 'attribute';
  status: 'current' | 'legacy' | 'uncertain';
  notes?: string;
}

export interface HostShape {
  id: string;
  stack: string;
  provider: ProviderId;
  signal: string;
  tag: string;
  attributes: number;
  childNodes: number;
  openShadowRoot: boolean;
  computedDisplay: string;
  parent: 'body' | 'html';
  position?: 'last-child' | 'any';
  timingMs?: number;
  notes: string;
}

export interface AgentExtension {
  id: string | null;
  name: string;
  provider: ProviderId;
  store: 'chrome' | 'edge' | 'builtin' | 'unpacked' | 'unlisted' | 'component';
  version?: string;
  updated?: string;
  users?: string;
  usesDebugger: boolean | 'partial' | 'unknown';
  inputPath: 'cdp' | 'content-script' | 'runtime-evaluate' | 'mixed' | 'unknown';
  permissions?: string[];
  /** Probeable web_accessible_resources per version. */
  webAccessibleResources: { version: string; matches: string; paths: string[]; seen: string }[];
  domMarkers: string[];
  mainWorldGlobals: string[];
  requestHeaders?: { name: string; valuePattern: string; condition: string }[];
  schemes?: string[];
  relatedIds?: { id: string; store: string; note: string }[];
  notes: string;
  sources: string[];
}

/** Hosted agent environment features (screen, UA, GPU, network...). Keys present only when the research supports them. */
export type HostedAgentFeatures = {
  screen?: { width: number; height: number } | null;
  viewport?: { width: number; height: number } | null;
  devicePixelRatio?: number;
  hardwareConcurrency?: number | null;
  deviceMemory?: number | null;
  uaPattern?: string | null;
  uaExample?: string | null;
  platformHint?: string | null;
  uaPlatformMismatch?: boolean;
  brandsChromiumOnly?: boolean;
  webglRenderer?: string | null;
  timezone?: string | null;
  locale?: string | null;
  fonts?: string;
  cookies?: 'reused' | 'rotating' | 'fresh' | 'user' | 'unknown';
  network?: string;
  webBotAuth?: string;
  permissions?: string;
  tls?: string;
  input?: string;
  coordinateGrid?: string;
  timing?: string;
  other?: string[];
  [key: string]: unknown;
};

/** contract: knowledge.ts `HostedAgentProfile` {id, provider, product, features}. */
export interface HostedAgentProfile {
  id: string;
  provider: ProviderId;
  product: string;
  class: ActorClass;
  features: HostedAgentFeatures;
  signal: string;
  confidence: EvidenceConfidence;
  notes: string;
  sources: string[];
}

export interface AutomationDefault {
  stack: string;
  provider?: ProviderId;
  class: ActorClass;
  viewport?: { width: number; height: number } | null;
  viewportNotes?: string;
  userAgent: string;
  navigatorWebdriver: 'true' | 'false' | 'undefined' | 'depends';
  headlessDefault: boolean | 'depends';
  runtimeEnable: boolean | 'conditional';
  flags: string[];
  inputSignature: string;
  mainWorldArtifacts: string[];
  catalogSignals: string[];
  notes?: string;
  sources: string[];
}
