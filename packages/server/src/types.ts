import type {
  Action,
  ClientHints,
  Decision,
  Engine,
  EventSink,
  Policy,
  SessionEvent,
  Signal,
  SignalInput,
  SignalRegistry,
  Verdict,
} from '@necterai/core';

export interface TlsHints {
  ja3?: string;
  ja4?: string;
  /** JA4_r: the raw (unhashed) JA4 with cipher and extension lists, when the edge exposes it. */
  ja4_r?: string;
  /** Whether the ClientHello carried GREASE values (Chromium/WebKit always do; libraries never do). */
  grease?: boolean;
  /** Akamai-style HTTP/2 fingerprint (SETTINGS|WINDOW_UPDATE|PRIORITY|pseudo-header order). */
  h2?: string;
  /** Negotiated protocol if known: 'http/1.1' | 'h2' | 'h3'. */
  alpn?: string;
}

export interface InspectExtras {
  /** Client IP if the adapter knows it; otherwise derived from headers when `trustProxy` is set. */
  ip?: string;
  /** Raw header names in wire order (Node rawHeaders). */
  headerOrder?: string[];
  tls?: TlsHints;
  /** Autonomous system number of the client IP when the edge knows it (Cloudflare `request.cf.asn`). */
  asn?: number;
  /** Extra tags for policy matching (e.g. 'authenticated'). */
  tags?: string[];
}

export interface RequestContext {
  request: Request;
  url: URL;
  method: string;
  headers: Headers;
  headerOrder?: string[];
  ip?: string;
  tls?: TlsHints;
  /** Client ASN when supplied by the adapter (InspectExtras.asn). */
  asn?: number;
  /** Session id from cookie/header, or a fresh one minted for this request. */
  sessionId: string;
  /** True if the session id came from the client (cookie/header) rather than being minted now. */
  sessionFromClient: boolean;
  /** Hash of ip + UA: groups cookie-less clients across requests. */
  clientKey: string;
  /** Navigation / document request (as opposed to API, asset or beacon). */
  isDocument: boolean;
  /** Request targets one of the SDK's own endpoints. */
  isEndpoint: boolean;
  now: number;
  tags: string[];
}

export interface AnalyzerApi {
  emit(input: SignalInput): Signal;
  /** Aggregated view of the cookie-less client (same ip+UA). */
  client: ClientAggregate;
  session: SessionRecord;
  fetch: typeof fetch;
  log(...args: unknown[]): void;
  options: ResolvedServerOptions;
}

export interface RequestAnalyzer {
  name: string;
  /** Return quickly; network work (directory fetches, rDNS) must be cached and time-bounded. */
  analyze(ctx: RequestContext, api: AnalyzerApi): void | Promise<void>;
}

export interface ChallengeState {
  issuedAt: number;
  attempts: number;
  passedAt?: number;
  failedAt?: number;
}

export interface SessionRecord {
  id: string;
  createdAt: number;
  lastSeenAt: number;
  ip?: string;
  ua?: string;
  clientKey: string;
  /** Latest signal per id, both sources merged. */
  signals: Map<string, Signal>;
  verdict?: Verdict;
  /** Last verdict the browser SDK computed locally. */
  clientVerdict?: Verdict;
  requests: number;
  documentsServed: number;
  beacons: number;
  lastDocumentAt?: number;
  lastBeaconAt?: number;
  canaryHits: string[];
  challenge?: ChallengeState;
  tags: Set<string>;
  /**
   * Selected headers (lower-case names) of the last document request this session made:
   * user-agent, sec-ch-ua*, accept-language. The tie analyzer compares them with what the
   * browser SDK reports from JavaScript.
   */
  lastDocumentHeaders?: Record<string, string>;
  /** Last client hints reported by the browser SDK (session event `data.hints`). */
  lastClientHints?: ClientHints;
}

export interface ClientAggregate {
  key: string;
  firstSeenAt: number;
  lastSeenAt: number;
  requests: number;
  documents: number;
  beacons: number;
  /** Requests that carried a session cookie we had set earlier. */
  cookieReturns: number;
  /** Requests that did not carry a cookie although one had been set for this client before. */
  cookieMisses: number;
  /** Distinct paths seen (bounded). */
  paths: string[];
  /** Subresource requests (css/js/img/font) seen. */
  assets: number;
  robotsTxt: number;
  sitemap: number;
  sessions: number;
}

export interface SessionStore {
  get(id: string): Promise<SessionRecord | undefined> | SessionRecord | undefined;
  save(record: SessionRecord): Promise<void> | void;
  client(key: string): Promise<ClientAggregate | undefined> | ClientAggregate | undefined;
  saveClient(agg: ClientAggregate): Promise<void> | void;
  /** Remove records idle for longer than ttlMs; returns the number removed. */
  sweep(ttlMs: number, now: number): Promise<number> | number;
  size(): number;
}

export interface GatewayText {
  title: string;
  body: string;
  /** Contact or licensing URL shown to agents. */
  contact?: string;
}

export interface ServerOptions {
  policy?: Policy;
  mode?: 'monitor' | 'enforce';
  endpoint?: string;
  sink?: EventSink;
  store?: SessionStore;
  analyzers?: RequestAnalyzer[];
  /** Append to the default analyzers instead of replacing them. */
  extraAnalyzers?: RequestAnalyzer[];
  /** Trust X-Forwarded-For / CF-Connecting-IP / X-Real-IP (default false). */
  trustProxy?: boolean;
  /** Fetch implementation used for directory and IP-range retrieval. */
  fetch?: typeof fetch;
  /** Verify Web Bot Auth signatures (default true). */
  verifyWebBotAuth?: boolean;
  /**
   * Forward-confirmed reverse DNS for crawlers that publish rDNS suffixes (Googlebot, Applebot,
   * CCBot, Bingbot, YouBot...). Node only (uses dns/promises); default false. Results are cached
   * 24 h (positive) / 1 h (negative) and every lookup is bounded by `rdnsTimeoutMs` (default 1500).
   */
  rdns?: boolean;
  rdnsTimeoutMs?: number;
  /** Web Bot Auth verifier tuning (see web-bot-auth/verify.ts). */
  webBotAuth?: WebBotAuthServerOptions;
  /** Milliseconds after serving HTML before "no JS execution" is inferred (default 8000). */
  noJsGraceMs?: number;
  /** Session idle TTL (default 30 min). */
  sessionTtlMs?: number;
  registry?: SignalRegistry;
  /**
   * Browser SDK served at `${endpoint}/script.js`. Default: the bundled `@necterai/browser` build, so
   * `<script src="/__necter/script.js" data-necter>` works with no setup. Pass a string to serve your
   * own build, or `false` to turn the route off.
   */
  scriptContent?: string | false;
  /**
   * Answer SDK endpoints cross-origin, for a hosted collector that serves many sites.
   * `true` allows any origin; a list allows only those origins (beacons from others get 403).
   */
  cors?: boolean | string[];
  gateway?: Partial<GatewayText>;
  /** Called for the `notify` action. */
  onNotify?(payload: { verdict: Verdict; decision: Decision; path: string; ip?: string }): void | Promise<void>;
  /** Produce decoy HTML for the `decoy` action. */
  decoy?: (ctx: RequestContext, verdict: Verdict) => string | Promise<string>;
  /** Trusted automation (site-owner CI, monitoring) matched by UA substring or IP; never blocked. */
  allowlist?: { userAgents?: string[]; ips?: string[]; sessionTags?: string[] };
  debug?: boolean;
  now?: () => number;
}

export interface WebBotAuthServerOptions {
  /**
   * DNS-level SSRF guard run before every directory fetch: resolve the directory host and refuse
   * private/reserved addresses. Default: `node:dns` lookup on Node, no DNS check elsewhere (the
   * literal-IP / https-only / local-name guards always apply). `false` disables it.
   */
  resolveHost?: ((host: string) => Promise<string[]>) | false;
  /** Max accepted `expires - created` in seconds (default 86400). */
  maxLifetimeSec?: number;
  /** Clock-skew tolerance in seconds (default 60). */
  skewSec?: number;
  /** Accept rsa-pss-sha512 keys (default false). */
  allowRsa?: boolean;
  /** Directory fetch timeout (default 2000 ms). */
  directoryTimeoutMs?: number;
  /** Directory cache TTL (default 15 min; Cache-Control max-age can shorten it). */
  cacheTtlMs?: number;
  /** Upper bound on directory fetches per minute across all hosts (default 60). */
  maxDirectoryFetchesPerMinute?: number;
}

export interface ResolvedServerOptions extends Required<Pick<ServerOptions, 'mode' | 'endpoint' | 'trustProxy' | 'verifyWebBotAuth' | 'noJsGraceMs' | 'sessionTtlMs' | 'debug'>> {
  rdns: boolean;
  rdnsTimeoutMs: number;
  webBotAuth: WebBotAuthServerOptions;
  policy: Policy;
  gateway: GatewayText;
  allowlist: { userAgents: string[]; ips: string[]; sessionTags: string[] };
  scriptContent?: string | false;
  cors: boolean | string[];
  onNotify?: ServerOptions['onNotify'];
  decoy?: ServerOptions['decoy'];
}

export interface Inspection {
  ctx: RequestContext;
  session: SessionRecord;
  verdict: Verdict;
  decision: Decision;
  /** Signals emitted for this request. */
  signals: Signal[];
  /** Headers to add to whatever response goes out (session cookie, labels). */
  responseHeaders: Record<string, string>;
  /** True when the request was fully handled (endpoint or terminal action). */
  handled: boolean;
  /** Prepared response for terminal actions (block/redirect/challenge/decoy), if any. */
  response?: Response;
}

export interface NecterServer {
  readonly options: ResolvedServerOptions;
  readonly engine: Engine;
  readonly registry: SignalRegistry;
  readonly sink: EventSink;
  readonly store: SessionStore;
  /** Analyse a request, update the session, decide, and prepare a response if the decision is terminal. */
  inspect(request: Request, extras?: InspectExtras): Promise<Inspection>;
  /** Handle the SDK's own endpoints; returns undefined when the request is not one of them. */
  handleEndpoint(request: Request, extras?: InspectExtras): Promise<Response | undefined>;
  /** Run `next()` under the decision: applies tarpit/limit/labels, or returns the prepared response. */
  respond(inspection: Inspection, next: () => Promise<Response>): Promise<Response>;
  /** Convenience: inspect + endpoint handling + respond in one call. */
  handle(request: Request, next: () => Promise<Response>, extras?: InspectExtras): Promise<Response>;
  /** Ingest a beacon payload (already parsed) for a session. */
  ingest(payload: BeaconPayload, meta: { ip?: string; ua?: string }): Promise<{ verdict: Verdict; decision: Decision }>;
  /** Record a canary hit (deterministic proof). */
  canaryHit(sessionId: string, token: string, kind: 'link' | 'field' | 'instruction' | 'endpoint' | 'other', detail?: Record<string, unknown>): Promise<Verdict | undefined>;
  verdictFor(sessionId: string): Promise<Verdict | undefined>;
  applyAction(action: Action, inspection: Inspection): Promise<Response | undefined>;
}

export interface BeaconPayload {
  v: number;
  sessionId: string;
  siteKey?: string;
  sentAt: number;
  events: SessionEvent[];
}
