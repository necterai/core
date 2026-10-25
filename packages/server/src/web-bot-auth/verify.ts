/**
 * Web Bot Auth verification: RFC 9421 HTTP Message Signatures with
 * `tag="web-bot-auth"`, Ed25519 (RSA-PSS-SHA512 optional) keys resolved from
 * the agent's `/.well-known/http-message-signatures-directory`.
 *
 * Spec basis: draft-ietf-webbotauth-httpsig-protocol-00 as summarised in
 * docs/research/raw/server-fingerprints.md §7 (wire format, verification
 * algorithm, live directory quirks: Google's short kids, Meta's missing kids,
 * OpenAI's bare quoted-string Signature-Agent vs the Dictionary form).
 */
import {
  type BareItem,
  type Dictionary,
  type InnerList,
  type Item,
  type Member,
  type Params,
  isInnerList,
  parseDictionary,
  parseItem,
  parseList,
  rawDictionaryMember,
  serializeDictionary,
  serializeInnerList,
  serializeItem,
  serializeList,
  serializeMember,
  base64Encode,
} from './sf.js';
import { type JsonWebKey, copyBytes, fromBase64url, isTestKey, jwkThumbprint, utf8 } from './jwk.js';
import { isIpLiteral, isPrivateOrReservedIp } from '../net/cidr.js';

export type WebBotAuthStatus = 'unsigned' | 'verified' | 'invalid' | 'unknown-key' | 'directory-unavailable';

export interface SignatureAgentRef {
  /** Dictionary label (or '*' for the bare quoted-string form). */
  label: string;
  url: string;
  type: 'directory' | 'jwks_uri' | 'cimd' | string;
}

export interface ParsedSignatureInput {
  label: string;
  components: Item[];
  params: Params;
  /** Canonical serialisation of the inner list with its params. */
  canonical: string;
  /** The member value exactly as on the wire. */
  raw?: string;
  created?: number;
  expires?: number;
  keyid?: string;
  alg?: string;
  nonce?: string;
  tag?: string;
}

export interface ParsedWebBotAuthHeaders {
  inputs: Map<string, ParsedSignatureInput>;
  signatures: Map<string, Uint8Array>;
  agents: SignatureAgentRef[];
  /** Other RFC 9421 tags seen (e.g. Visa TAP agent-browser-auth). */
  otherTags: string[];
  parseErrors: string[];
}

export interface WebBotAuthResult {
  status: WebBotAuthStatus;
  reason?: string;
  label?: string;
  identity?: string;
  directoryUrl?: string;
  keyid?: string;
  thumbprint?: string;
  alg?: string;
  created?: number;
  expires?: number;
  nonce?: string;
  components?: string[];
  testKey?: boolean;
  directory?: DirectoryMeta;
  agents: SignatureAgentRef[];
  otherTags: string[];
}

export interface DirectoryMeta {
  origin: string;
  url: string;
  purpose?: string;
  signatureAgent?: string;
  keyCount: number;
  contentType?: string;
  mediaTypeOk: boolean;
}

export interface ResolvedKey {
  jwk: JsonWebKey;
  thumbprint?: string;
  kid?: string;
  testKey: boolean;
}

interface DirectoryEntry {
  fetchedAt: number;
  expiresAt: number;
  status: 'ok' | 'error';
  reason?: string;
  keys: ResolvedKey[];
  meta?: DirectoryMeta;
}

export interface VerifyOptions {
  fetch?: typeof fetch;
  now?: () => number;
  subtle?: SubtleCrypto;
  /** Max accepted expires-created (default 24 h). */
  maxLifetimeSec?: number;
  /** Clock skew tolerance (default 60 s). */
  skewSec?: number;
  allowRsa?: boolean;
  /** Treat the RFC 9421 test key as valid (tests only; default false). */
  allowTestKeys?: boolean;
  directoryTimeoutMs?: number;
  maxDirectoryBytes?: number;
  cacheTtlMs?: number;
  negativeCacheTtlMs?: number;
  maxNonceEntries?: number;
  /** Upper bound on directory fetches per rolling minute across all hosts (default 60). */
  maxFetchesPerMinute?: number;
  /** Optional DNS-level SSRF check (resolve hostname → reject private addresses). */
  resolveHost?: (host: string) => Promise<string[]>;
  isPrivateIp?: (ip: string) => boolean;
  log?: (...args: unknown[]) => void;
}

export interface WebBotAuthVerifier {
  verify(request: { method: string; url: string; headers: Headers }): Promise<WebBotAuthResult>;
  parse(headers: Headers): ParsedWebBotAuthHeaders;
  /** Directory cache for inspection/tests. */
  readonly cache: Map<string, DirectoryEntry>;
  clearCache(): void;
}

export const DIRECTORY_MEDIA_TYPE = 'application/http-message-signatures-directory+json';
export const WELL_KNOWN_DIRECTORY = '/.well-known/http-message-signatures-directory';
const SUPPORTED_ALGS = new Set(['ed25519', 'rsa-pss-sha512']);

// ───────────────────────── header parsing ─────────────────────────

function paramString(params: Params, key: string): string | undefined {
  const p = params.find(([k]) => k === key)?.[1];
  return p && (p.type === 'string' || p.type === 'token') ? p.value : undefined;
}
function paramInt(params: Params, key: string): number | undefined {
  const p = params.find(([k]) => k === key)?.[1];
  return p && p.type === 'integer' ? p.value : undefined;
}

export function parseWebBotAuthHeaders(headers: Headers): ParsedWebBotAuthHeaders {
  const out: ParsedWebBotAuthHeaders = { inputs: new Map(), signatures: new Map(), agents: [], otherTags: [], parseErrors: [] };
  const inputHeader = headers.get('signature-input');
  const sigHeader = headers.get('signature');
  const agentHeader = headers.get('signature-agent');

  if (inputHeader) {
    try {
      const dict = parseDictionary(inputHeader);
      for (const [label, member] of dict) {
        if (!isInnerList(member)) {
          out.parseErrors.push(`Signature-Input ${label} is not an inner list`);
          continue;
        }
        const tag = paramString(member.params, 'tag');
        const parsed: ParsedSignatureInput = {
          label,
          components: member.items,
          params: member.params,
          canonical: serializeInnerList(member),
        };
        const raw = rawDictionaryMember(inputHeader, label);
        if (raw) parsed.raw = raw;
        const created = paramInt(member.params, 'created');
        const expires = paramInt(member.params, 'expires');
        const keyid = paramString(member.params, 'keyid');
        const alg = paramString(member.params, 'alg');
        const nonce = paramString(member.params, 'nonce');
        if (created !== undefined) parsed.created = created;
        if (expires !== undefined) parsed.expires = expires;
        if (keyid !== undefined) parsed.keyid = keyid;
        if (alg !== undefined) parsed.alg = alg;
        if (nonce !== undefined) parsed.nonce = nonce;
        if (tag !== undefined) parsed.tag = tag;
        if (tag && tag !== 'web-bot-auth' && !out.otherTags.includes(tag)) out.otherTags.push(tag);
        out.inputs.set(label, parsed);
      }
    } catch (err) {
      out.parseErrors.push(`Signature-Input: ${(err as Error).message}`);
    }
  }
  if (sigHeader) {
    try {
      const dict = parseDictionary(sigHeader);
      for (const [label, member] of dict) {
        if (isInnerList(member) || member.item.type !== 'bytes') {
          out.parseErrors.push(`Signature ${label} is not a byte sequence`);
          continue;
        }
        out.signatures.set(label, member.item.value);
      }
    } catch (err) {
      out.parseErrors.push(`Signature: ${(err as Error).message}`);
    }
  }
  if (agentHeader) {
    const trimmed = agentHeader.trim();
    // Cloudflare/OpenAI form: a bare sf-string `"https://chatgpt.com"`.
    if (trimmed.startsWith('"')) {
      try {
        const item = parseItem(trimmed);
        if (item.item.type === 'string') out.agents.push({ label: '*', url: item.item.value, type: paramString(item.params, 'type') ?? 'directory' });
        else out.parseErrors.push('Signature-Agent string form is not a string');
      } catch (err) {
        out.parseErrors.push(`Signature-Agent: ${(err as Error).message}`);
      }
    } else if (/^https:\/\/[^\s",;]+$/i.test(trimmed)) {
      // Lenient: an unquoted bare URL (`Signature-Agent: https://chatgpt.com`, seen in secondary
      // write-ups). Not valid SF, but the identity is unambiguous; it is still resolved and verified.
      out.agents.push({ label: '*', url: trimmed, type: 'directory' });
    } else {
      // Draft form: Dictionary `g="https://agent.bot.goog"`, optional `;type=jwks_uri`.
      try {
        const dict = parseDictionary(trimmed);
        for (const [label, member] of dict) {
          if (isInnerList(member) || member.item.type !== 'string') {
            out.parseErrors.push(`Signature-Agent ${label} is not a string`);
            continue;
          }
          out.agents.push({ label, url: member.item.value, type: paramString(member.params, 'type') ?? 'directory' });
        }
      } catch (err) {
        out.parseErrors.push(`Signature-Agent: ${(err as Error).message}`);
      }
    }
  }
  return out;
}

// ───────────────────────── signature base (RFC 9421 §2) ─────────────────────────

export interface SignatureBaseRequest {
  method: string;
  url: string;
  headers: Headers;
  /** Trailers are unsupported; present for completeness. */
  trailers?: Headers;
}

export class SignatureBaseError extends Error {
  constructor(message: string, public readonly reason: string) {
    super(message);
    this.name = 'SignatureBaseError';
  }
}

function componentName(item: Item): string {
  if (item.item.type !== 'string') throw new SignatureBaseError('component identifier must be a string', 'bad-component');
  return item.item.value;
}

function serializeComponentIdentifier(item: Item): string {
  return serializeItem({ item: { type: 'string', value: componentName(item).toLowerCase() }, params: item.params });
}

function derivedComponentValue(name: string, params: Params, req: SignatureBaseRequest, url: URL): string {
  switch (name) {
    case '@method':
      return req.method.toUpperCase();
    case '@target-uri':
      return url.href;
    case '@authority': {
      // host is already lower-case with default port stripped by the URL parser; normalise anyway.
      let host = url.host.toLowerCase();
      if ((url.protocol === 'https:' && host.endsWith(':443')) || (url.protocol === 'http:' && host.endsWith(':80'))) host = host.slice(0, host.lastIndexOf(':'));
      return host;
    }
    case '@scheme':
      return url.protocol.replace(/:$/, '').toLowerCase();
    case '@request-target':
      return url.pathname + url.search;
    case '@path':
      return url.pathname || '/';
    case '@query':
      return url.search || '?';
    case '@query-param': {
      const pname = paramString(params, 'name');
      if (pname === undefined) throw new SignatureBaseError('@query-param needs name', 'bad-component');
      const values = url.searchParams.getAll(pname);
      if (values.length !== 1) throw new SignatureBaseError('@query-param must occur exactly once', 'bad-component');
      return encodeURIComponent(values[0]!).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
    }
    case '@status':
      throw new SignatureBaseError('@status is not valid on requests', 'bad-component');
    default:
      throw new SignatureBaseError(`unknown derived component ${name}`, 'bad-component');
  }
}

function reserialiseStructured(value: string): string {
  // Try dictionary, then list, then item: RFC 9421 requires the field's actual type, but a request
  // signer rarely uses `sf`; we accept whichever parses.
  try {
    return serializeDictionary(parseDictionary(value));
  } catch {
    /* next */
  }
  try {
    return serializeList(parseList(value));
  } catch {
    /* next */
  }
  return serializeItem(parseItem(value));
}

function headerComponentValue(name: string, params: Params, req: SignatureBaseRequest): string {
  const raw = req.headers.get(name);
  if (raw === null) throw new SignatureBaseError(`covered header ${name} is missing`, 'missing-header');
  // RFC 9421 §2.1: strip leading/trailing whitespace, collapse obs-fold.
  const value = raw.split(/\r?\n[ \t]+/).map((s) => s.trim()).join(' ').trim();
  const hasBs = params.some(([k]) => k === 'bs');
  const hasSf = params.some(([k]) => k === 'sf');
  const key = paramString(params, 'key');
  for (const [k] of params) {
    if (k === 'req' || k === 'tr') throw new SignatureBaseError(`unsupported component parameter ${k} on a request signature`, 'unsupported-param');
    if (k !== 'sf' && k !== 'bs' && k !== 'key') throw new SignatureBaseError(`unknown component parameter ${k}`, 'unsupported-param');
  }
  if (hasBs && (hasSf || key !== undefined)) throw new SignatureBaseError('bs cannot combine with sf/key', 'unsupported-param');
  if (hasBs) return `:${base64Encode(utf8(value))}:`;
  if (key !== undefined) {
    let dict: Dictionary;
    try {
      dict = parseDictionary(value);
    } catch {
      if (name === 'signature-agent') return value; // bare string form: fall back to the whole value
      throw new SignatureBaseError(`${name} is not a dictionary`, 'bad-component');
    }
    const member: Member | undefined = dict.get(key);
    if (!member) throw new SignatureBaseError(`${name} has no member ${key}`, 'missing-header');
    return serializeMember(member);
  }
  if (hasSf) return reserialiseStructured(value);
  return value;
}

/**
 * Build the RFC 9421 signature base for `components`, ending with the
 * `"@signature-params": <inner list>` line supplied by the caller (exactly as
 * serialised in Signature-Input).
 */
export function buildSignatureBase(req: SignatureBaseRequest, components: Item[], signatureParams: string): string {
  const url = new URL(req.url);
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const c of components) {
    const name = componentName(c);
    if (name !== name.toLowerCase()) throw new SignatureBaseError('component identifiers must be lower-case', 'bad-component');
    const id = serializeComponentIdentifier(c);
    if (seen.has(id)) throw new SignatureBaseError(`duplicate component ${id}`, 'bad-component');
    seen.add(id);
    const value = name.startsWith('@') ? derivedComponentValue(name, c.params, req, url) : headerComponentValue(name, c.params, req);
    lines.push(`${id}: ${value}`);
  }
  lines.push(`"@signature-params": ${signatureParams}`);
  return lines.join('\n');
}

// ───────────────────────── directory resolution ─────────────────────────

const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home', '.corp', '.intranet', '.arpa', '.onion', '.test', '.example', '.invalid'];

/** SSRF guard: https only, no credentials, no IP literals, no local/internal names, default port only. */
export function isSafeDirectoryUrl(url: URL): string | undefined {
  if (url.protocol !== 'https:') return 'directory-not-https';
  if (url.username || url.password) return 'directory-has-credentials';
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host || isIpLiteral(host)) return 'directory-host-is-ip';
  if (host === 'localhost' || !host.includes('.')) return 'directory-host-local';
  if (BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) return 'directory-host-local';
  if (url.port && url.port !== '443') return 'directory-nonstandard-port';
  if (!/^[a-z0-9.-]+$/.test(host)) return 'directory-host-invalid';
  return undefined;
}

export function directoryUrlFor(agent: SignatureAgentRef): URL | undefined {
  try {
    const u = new URL(agent.url);
    if (agent.type === 'jwks_uri') return u;
    if (agent.type === 'cimd') return undefined; // Signature Agent Cards are not resolved yet.
    return new URL(WELL_KNOWN_DIRECTORY, u.origin);
  } catch {
    return undefined;
  }
}

async function readBodyCapped(res: Response, max: number): Promise<string> {
  const body = res.body;
  if (!body || typeof body.getReader !== 'function') {
    const text = await res.text();
    if (text.length > max) throw new Error('directory-too-large');
    return text;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > max) {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        throw new Error('directory-too-large');
      }
      chunks.push(value);
    }
  }
  const all = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    all.set(c, o);
    o += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

// ───────────────────────── verifier ─────────────────────────

export function createWebBotAuthVerifier(opts: VerifyOptions = {}): WebBotAuthVerifier {
  const now = opts.now ?? (() => Date.now());
  const subtle = opts.subtle ?? crypto.subtle;
  const fetchImpl: typeof fetch = opts.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const maxLifetime = opts.maxLifetimeSec ?? 24 * 3600;
  const skew = opts.skewSec ?? 60;
  const cacheTtl = opts.cacheTtlMs ?? 15 * 60_000;
  const negativeTtl = opts.negativeCacheTtlMs ?? 5 * 60_000;
  const timeoutMs = opts.directoryTimeoutMs ?? 2000;
  const maxBytes = opts.maxDirectoryBytes ?? 64 * 1024;
  const maxNonces = opts.maxNonceEntries ?? 10_000;
  const maxFetchesPerMinute = opts.maxFetchesPerMinute ?? 60;
  const fetchTimes: number[] = [];
  const log = opts.log ?? (() => undefined);
  const cache = new Map<string, DirectoryEntry>();
  const nonces = new Map<string, number>(); // key → expires (epoch seconds)

  async function fetchDirectory(url: URL): Promise<DirectoryEntry> {
    const t = now();
    const unsafe = isSafeDirectoryUrl(url);
    if (unsafe) return { fetchedAt: t, expiresAt: t + negativeTtl, status: 'error', reason: unsafe, keys: [] };
    // Global fetch budget: Signature-Agent is attacker-controlled, so an attacker rotating hosts must
    // not turn the verifier into a request amplifier. Over budget = transient failure (short cache).
    while (fetchTimes.length && t - fetchTimes[0]! > 60_000) fetchTimes.shift();
    if (fetchTimes.length >= maxFetchesPerMinute) return { fetchedAt: t, expiresAt: t + 10_000, status: 'error', reason: 'directory-rate-limited', keys: [] };
    fetchTimes.push(t);
    if (opts.resolveHost) {
      try {
        let dnsTimer: ReturnType<typeof setTimeout> | undefined;
        const addrs = await Promise.race([
          opts.resolveHost(url.hostname),
          new Promise<string[]>((_, reject) => {
            dnsTimer = setTimeout(() => reject(new Error('dns-timeout')), timeoutMs);
          }),
        ]).finally(() => clearTimeout(dnsTimer));
        const priv = opts.isPrivateIp ?? isPrivateOrReservedIp;
        if (!addrs.length || addrs.some((a) => priv(a))) return { fetchedAt: t, expiresAt: t + negativeTtl, status: 'error', reason: 'directory-host-private', keys: [] };
      } catch {
        return { fetchedAt: t, expiresAt: t + negativeTtl, status: 'error', reason: 'directory-dns-failed', keys: [] };
      }
    }
    const controller = typeof AbortController === 'function' ? new AbortController() : undefined;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
    try {
      const res = await fetchImpl(url.href, {
        method: 'GET',
        headers: { accept: DIRECTORY_MEDIA_TYPE, 'user-agent': 'necter/0.1 (web-bot-auth verifier; +https://github.com/necter)' },
        redirect: 'manual',
        ...(controller ? { signal: controller.signal } : {}),
      });
      if (res.status >= 300 && res.status < 400) return { fetchedAt: t, expiresAt: t + negativeTtl, status: 'error', reason: 'redirect-refused', keys: [] };
      if (res.status !== 200) return { fetchedAt: t, expiresAt: t + negativeTtl, status: 'error', reason: `directory-status-${res.status}`, keys: [] };
      const contentType = res.headers.get('content-type') ?? '';
      const mediaTypeOk = contentType.toLowerCase().split(';')[0]!.trim() === DIRECTORY_MEDIA_TYPE;
      const text = await readBodyCapped(res, maxBytes);
      let json: { keys?: unknown; purpose?: unknown; signature_agent?: unknown };
      try {
        json = JSON.parse(text) as typeof json;
      } catch {
        return { fetchedAt: t, expiresAt: t + negativeTtl, status: 'error', reason: 'directory-not-json', keys: [] };
      }
      const rawKeys = Array.isArray(json.keys) ? (json.keys as JsonWebKey[]) : [];
      const keys: ResolvedKey[] = [];
      for (const jwk of rawKeys) {
        if (!jwk || typeof jwk !== 'object') continue;
        const okp = jwk.kty === 'OKP' && jwk.crv === 'Ed25519' && typeof jwk.x === 'string';
        const rsa = opts.allowRsa === true && jwk.kty === 'RSA' && typeof jwk.n === 'string' && typeof jwk.e === 'string';
        if (!okp && !rsa) continue;
        if ('d' in jwk) continue; // never accept private material
        let thumbprint: string | undefined;
        try {
          thumbprint = await jwkThumbprint(jwk, subtle);
        } catch {
          thumbprint = undefined;
        }
        const entry: ResolvedKey = { jwk, testKey: isTestKey(jwk, thumbprint) };
        if (thumbprint) entry.thumbprint = thumbprint;
        if (typeof jwk.kid === 'string') entry.kid = jwk.kid;
        keys.push(entry);
      }
      const meta: DirectoryMeta = { origin: url.origin, url: url.href, keyCount: keys.length, contentType, mediaTypeOk };
      if (typeof json.purpose === 'string') meta.purpose = json.purpose;
      if (typeof json.signature_agent === 'string') meta.signatureAgent = json.signature_agent;
      // Honour Cache-Control max-age when present (Google 3600, Kernel 1h keys), floor 60 s, cap at our TTL.
      let ttl = cacheTtl;
      const cc = /max-age=(\d+)/i.exec(res.headers.get('cache-control') ?? '');
      if (cc) ttl = Math.min(cacheTtl, Math.max(60_000, Number(cc[1]) * 1000));
      return { fetchedAt: t, expiresAt: t + ttl, status: 'ok', keys, meta };
    } catch (err) {
      const reason = (err as Error)?.name === 'AbortError' ? 'directory-timeout' : (err as Error)?.message === 'directory-too-large' ? 'directory-too-large' : 'directory-fetch-failed';
      log('directory fetch failed', url.href, err);
      return { fetchedAt: t, expiresAt: t + negativeTtl, status: 'error', reason, keys: [] };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function resolveKeys(url: URL, wantKeyid: string): Promise<{ entry: DirectoryEntry; key?: ResolvedKey }> {
    const t = now();
    let entry = cache.get(url.href);
    if (!entry || entry.expiresAt <= t) {
      entry = await fetchDirectory(url);
      cache.set(url.href, entry);
    }
    let key = findKey(entry, wantKeyid);
    // Unknown kid on a cached directory: refetch once (key rotation), but not more than once per 10 s.
    if (!key && entry.status === 'ok' && t - entry.fetchedAt > 10_000) {
      entry = await fetchDirectory(url);
      cache.set(url.href, entry);
      key = findKey(entry, wantKeyid);
    }
    return key ? { entry, key } : { entry };
  }

  function findKey(entry: DirectoryEntry, keyid: string): ResolvedKey | undefined {
    return entry.keys.find((k) => k.kid === keyid) ?? entry.keys.find((k) => k.thumbprint === keyid);
  }

  function nonceReplayed(identity: string, keyid: string, nonce: string, expires: number): boolean {
    const t = Math.floor(now() / 1000);
    // Opportunistic sweep of expired entries.
    if (nonces.size > maxNonces) {
      for (const [k, exp] of nonces) {
        if (exp < t) nonces.delete(k);
        if (nonces.size <= maxNonces * 0.9) break;
      }
      while (nonces.size > maxNonces) nonces.delete(nonces.keys().next().value as string);
    }
    const key = `${identity}|${keyid}|${nonce}`;
    const seen = nonces.get(key);
    if (seen !== undefined && seen >= t) return true;
    nonces.set(key, expires);
    return false;
  }

  async function verifyBytes(key: ResolvedKey, alg: string, base: string, signature: Uint8Array): Promise<boolean> {
    const data = utf8(base);
    if (alg === 'ed25519') {
      if (key.jwk.kty !== 'OKP') return false;
      const x = copyBytes(fromBase64url(key.jwk.x!));
      if (x.length !== 32 || signature.length !== 64) return false;
      const cryptoKey = await subtle.importKey('raw', x, { name: 'Ed25519' }, false, ['verify']);
      return subtle.verify({ name: 'Ed25519' }, cryptoKey, copyBytes(signature), data);
    }
    if (alg === 'rsa-pss-sha512') {
      if (key.jwk.kty !== 'RSA') return false;
      const cryptoKey = await subtle.importKey('jwk', { kty: 'RSA', n: key.jwk.n!, e: key.jwk.e!, ext: true }, { name: 'RSA-PSS', hash: 'SHA-512' }, false, ['verify']);
      return subtle.verify({ name: 'RSA-PSS', saltLength: 64 }, cryptoKey, copyBytes(signature), data);
    }
    return false;
  }

  async function verify(request: { method: string; url: string; headers: Headers }): Promise<WebBotAuthResult> {
    const parsed = parseWebBotAuthHeaders(request.headers);
    const base: WebBotAuthResult = { status: 'unsigned', agents: parsed.agents, otherTags: parsed.otherTags };
    if (!parsed.inputs.size && !parsed.signatures.size) {
      if (parsed.parseErrors.length) return { ...base, status: 'invalid', reason: 'parse-error:' + parsed.parseErrors[0] };
      return base;
    }
    if (parsed.parseErrors.length) return { ...base, status: 'invalid', reason: 'parse-error:' + parsed.parseErrors[0] };

    // Candidate labels: present in both headers, web-bot-auth tagged first, at most 3.
    const labels = [...parsed.inputs.keys()].filter((l) => parsed.signatures.has(l));
    if (!labels.length) return { ...base, status: 'invalid', reason: 'label-mismatch' };
    labels.sort((x, y) => Number(parsed.inputs.get(y)!.tag === 'web-bot-auth') - Number(parsed.inputs.get(x)!.tag === 'web-bot-auth'));
    let lastFailure: WebBotAuthResult | undefined;
    for (const label of labels.slice(0, 3)) {
      const input = parsed.inputs.get(label)!;
      const result = await verifyLabel(request, input, parsed.signatures.get(label)!, parsed);
      if (result.status === 'verified') return result;
      if (!lastFailure || rank(result.status) > rank(lastFailure.status)) lastFailure = result;
    }
    return lastFailure ?? { ...base, status: 'invalid', reason: 'no-web-bot-auth-signature' };
  }

  function rank(s: WebBotAuthStatus): number {
    return s === 'invalid' ? 3 : s === 'unknown-key' ? 2 : s === 'directory-unavailable' ? 1 : 0;
  }

  async function verifyLabel(request: { method: string; url: string; headers: Headers }, input: ParsedSignatureInput, signature: Uint8Array, parsed: ParsedWebBotAuthHeaders): Promise<WebBotAuthResult> {
    const res: WebBotAuthResult = { status: 'invalid', label: input.label, agents: parsed.agents, otherTags: parsed.otherTags };
    const fail = (reason: string, status: WebBotAuthStatus = 'invalid'): WebBotAuthResult => ({ ...res, status, reason });
    if (input.created !== undefined) res.created = input.created;
    if (input.expires !== undefined) res.expires = input.expires;
    if (input.keyid !== undefined) res.keyid = input.keyid;
    if (input.alg !== undefined) res.alg = input.alg;
    if (input.nonce !== undefined) res.nonce = input.nonce;
    try {
      res.components = input.components.map((c) => serializeComponentIdentifier(c));
    } catch {
      return fail('bad-component');
    }

    if (input.tag !== 'web-bot-auth') return fail(input.tag ? `tag-${input.tag}` : 'missing-tag', 'unsigned');
    if (input.created === undefined || input.expires === undefined) return fail('missing-created-or-expires');
    const t = Math.floor(now() / 1000);
    if (input.created > t + skew) return fail('created-in-future');
    if (input.expires < t - skew) return fail('expired');
    if (input.expires - input.created > maxLifetime) return fail('lifetime-too-long');
    if (input.expires <= input.created) return fail('expires-before-created');
    if (!input.keyid) return fail('missing-keyid');
    const alg = input.alg ?? 'ed25519';
    if (!SUPPORTED_ALGS.has(alg) || (alg === 'rsa-pss-sha512' && !opts.allowRsa)) return fail(`unsupported-alg-${alg}`);

    const names = input.components.map((c) => (c.item.type === 'string' ? c.item.value : ''));
    if (!names.includes('@authority') && !names.includes('@target-uri')) return fail('authority-not-covered');

    // Identity: the Signature-Agent member keyed by this label, or the bare string form.
    const agent = parsed.agents.find((a) => a.label === input.label) ?? parsed.agents.find((a) => a.label === '*') ?? (parsed.agents.length === 1 ? parsed.agents[0] : undefined);
    if (parsed.agents.length) {
      if (!agent) return fail('signature-agent-label-mismatch');
      if (!names.includes('signature-agent')) return fail('signature-agent-not-covered');
      res.identity = agent.url;
    }
    if (!agent) {
      // Fallback identity mode (keyid thumbprint only) has no directory to resolve against.
      return fail('no-signature-agent', 'unknown-key');
    }

    let identityUrl: URL;
    try {
      identityUrl = new URL(agent.url);
    } catch {
      return fail('signature-agent-not-a-url');
    }
    const unsafe = isSafeDirectoryUrl(identityUrl);
    if (unsafe) return fail(unsafe);
    const dirUrl = directoryUrlFor(agent);
    if (!dirUrl) return fail(`unsupported-agent-type-${agent.type}`, 'directory-unavailable');
    res.directoryUrl = dirUrl.href;

    if (isTestKeyId(input.keyid)) {
      return { ...fail('test-key'), testKey: true };
    }

    const { entry, key } = await resolveKeys(dirUrl, input.keyid);
    if (entry.meta) res.directory = entry.meta;
    if (entry.status === 'error') return fail(entry.reason ?? 'directory-unavailable', 'directory-unavailable');
    if (!key) return fail('unknown-keyid', 'unknown-key');
    if (key.thumbprint) res.thumbprint = key.thumbprint;
    if (key.testKey) {
      res.testKey = true;
      if (!opts.allowTestKeys) return fail('test-key');
    }
    if (typeof key.jwk.nbf === 'number' && key.jwk.nbf > t + skew) return fail('key-not-yet-valid');
    if (typeof key.jwk.exp === 'number' && key.jwk.exp < t - skew) return fail('key-expired');

    let signatureBase: string;
    try {
      signatureBase = buildSignatureBase(request, input.components, input.canonical);
    } catch (err) {
      return fail(err instanceof SignatureBaseError ? err.reason : 'bad-signature-base');
    }
    let ok = false;
    try {
      ok = await verifyBytes(key, alg, signatureBase, signature);
      if (!ok && input.raw && input.raw !== input.canonical) {
        // Signer used a non-canonical serialisation of @signature-params: try the wire text.
        ok = await verifyBytes(key, alg, buildSignatureBase(request, input.components, input.raw), signature);
      }
    } catch (err) {
      log('verify error', err);
      return fail('crypto-error');
    }
    if (!ok) return fail('signature-mismatch');
    if (input.nonce && nonceReplayed(agent.url, input.keyid, input.nonce, input.expires)) return fail('replayed-nonce');
    return { ...res, status: 'verified' };
  }

  return {
    verify,
    parse: parseWebBotAuthHeaders,
    cache,
    clearCache: () => {
      cache.clear();
      nonces.clear();
    },
  };
}

function isTestKeyId(keyid: string): boolean {
  return isTestKey({ kty: 'OKP' }, keyid);
}

export type { BareItem, InnerList, Item, Member, Params };
