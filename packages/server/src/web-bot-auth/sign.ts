/**
 * Signing helpers: produce valid Web Bot Auth / RFC 9421 signatures for tests,
 * the zoo and site-owner tooling. Mirrors the verifier's signature-base code so
 * vectors round-trip.
 */
import { parseDictionary, serializeInnerList, type InnerList, type Item, type Params } from './sf.js';
import { base64url, jwkThumbprint, type JsonWebKey } from './jwk.js';
import { buildSignatureBase } from './verify.js';

export interface Ed25519KeyPair {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  /** Public JWK (kty OKP, crv Ed25519, x). */
  jwk: JsonWebKey & { kty: 'OKP'; crv: 'Ed25519'; x: string };
  /** RFC 7638 thumbprint, the draft's required keyid. */
  thumbprint: string;
}

export async function generateEd25519KeyPair(subtle: SubtleCrypto = crypto.subtle): Promise<Ed25519KeyPair> {
  const pair = (await subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const exported = (await subtle.exportKey('jwk', pair.publicKey)) as { x: string };
  const jwk = { kty: 'OKP' as const, crv: 'Ed25519' as const, x: exported.x };
  const thumbprint = (await jwkThumbprint(jwk, subtle))!;
  return { privateKey: pair.privateKey, publicKey: pair.publicKey, jwk, thumbprint };
}

/** Import the RFC 9421 test key (or any Ed25519 JWK with `d`) for signing. */
export async function importEd25519PrivateJwk(jwk: { x: string; d: string }, subtle: SubtleCrypto = crypto.subtle): Promise<CryptoKey> {
  return subtle.importKey('jwk', { kty: 'OKP', crv: 'Ed25519', x: jwk.x, d: jwk.d }, { name: 'Ed25519' }, false, ['sign']);
}

export interface SignRequestOptions {
  privateKey: CryptoKey;
  /** keyid parameter (the JWK thumbprint per the draft; Google uses short kids). */
  keyid: string;
  /** Signature-Agent identity URL (https://chatgpt.com). Omit for a signature without Signature-Agent. */
  agent?: string;
  /** `string` = Cloudflare/OpenAI bare quoted string; `dictionary` = draft form `label="https://..."`. */
  agentForm?: 'string' | 'dictionary';
  /** Optional `type` parameter on the dictionary form (jwks_uri, cimd). */
  agentType?: string;
  label?: string;
  /** Covered components, e.g. ['@authority', '@method', '@path', 'signature-agent']. */
  components?: string[];
  created?: number;
  expires?: number;
  nonce?: string;
  tag?: string;
  alg?: string;
  now?: () => number;
  subtle?: SubtleCrypto;
}

export interface SignedHeaders {
  'signature-input': string;
  signature: string;
  'signature-agent'?: string;
  signatureBase: string;
}

function strItem(value: string, params: Params = []): Item {
  return { item: { type: 'string', value }, params };
}

export async function signRequest(req: { method: string; url: string; headers?: HeadersInit }, opts: SignRequestOptions): Promise<SignedHeaders> {
  const subtle = opts.subtle ?? crypto.subtle;
  const now = Math.floor((opts.now ?? Date.now)() / 1000);
  const label = opts.label ?? 'sig1';
  const created = opts.created ?? now;
  const expires = opts.expires ?? created + 300;
  const agentForm = opts.agentForm ?? 'string';
  const headers = new Headers(req.headers ?? {});
  if (opts.agent) {
    headers.set('signature-agent', agentForm === 'string' ? `"${opts.agent}"` : `${label}="${opts.agent}"${opts.agentType ? `;type=${opts.agentType}` : ''}`);
  }
  const names = opts.components ?? (opts.agent ? ['@authority', '@method', '@path', 'signature-agent'] : ['@authority', '@method', '@path']);
  const components: Item[] = names.map((n) => {
    if (n === 'signature-agent' && agentForm === 'dictionary') return strItem(n, [['key', { type: 'string', value: label }]]);
    return strItem(n);
  });
  const params: Params = [
    ['created', { type: 'integer', value: created }],
    ['expires', { type: 'integer', value: expires }],
    ['keyid', { type: 'string', value: opts.keyid }],
    ['alg', { type: 'string', value: opts.alg ?? 'ed25519' }],
  ];
  if (opts.nonce) params.push(['nonce', { type: 'string', value: opts.nonce }]);
  params.push(['tag', { type: 'string', value: opts.tag ?? 'web-bot-auth' }]);
  const inner: InnerList = { items: components, params };
  const serialisedParams = serializeInnerList(inner);
  const base = buildSignatureBase({ method: req.method, url: req.url, headers }, components, serialisedParams);
  const sig = new Uint8Array(await subtle.sign({ name: 'Ed25519' }, opts.privateKey, new TextEncoder().encode(base)));
  const out: SignedHeaders = {
    'signature-input': `${label}=${serialisedParams}`,
    signature: `${label}=:${toStdBase64(sig)}:`,
    signatureBase: base,
  };
  const agentHeader = headers.get('signature-agent');
  if (agentHeader) out['signature-agent'] = agentHeader;
  // Sanity: the Signature-Input we emit must parse back.
  parseDictionary(out['signature-input']);
  return out;
}

function toStdBase64(bytes: Uint8Array): string {
  return base64url(bytes).replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (Math.ceil((bytes.length * 4) / 3) % 4)) % 4);
}

/** Build a minimal signed key directory body (JWKS) for a stubbed fetch. */
export function directoryBody(keys: JsonWebKey[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ keys, ...extra });
}
