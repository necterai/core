import { base64Decode, base64Encode } from './sf.js';

export interface JsonWebKey {
  kty: string;
  crv?: string;
  x?: string;
  y?: string;
  n?: string;
  e?: string;
  kid?: string;
  alg?: string;
  use?: string;
  key_ops?: string[];
  nbf?: number;
  exp?: number;
  [k: string]: unknown;
}

/**
 * RFC 9421 §B.1.4 / RFC 8032 test key `test-key-ed25519`. Any request signed
 * with it is a test or abuse signal and is never treated as verified.
 */
export const RFC9421_TEST_ED25519_X = 'JrQLj5P_89iXES9-vFgrIy29clF9CC_oPPsw3c5D0bs';
export const RFC9421_TEST_KEY_THUMBPRINTS: ReadonlySet<string> = new Set([
  'NFcWBst6DXG-N35nHdzMrioWntdzNZghQSkjHNMMSjw',
  'poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U',
]);

export function base64url(bytes: Uint8Array): string {
  return base64Encode(bytes, true);
}

export function fromBase64url(s: string): Uint8Array {
  return base64Decode(s);
}

export function utf8(s: string): Uint8Array<ArrayBuffer> {
  return copyBytes(new TextEncoder().encode(s));
}

/** Copy into a fresh ArrayBuffer-backed view (WebCrypto's BufferSource rejects SharedArrayBuffer-typed views). */
export function copyBytes(src: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(src.byteLength);
  out.set(src);
  return out;
}

/** Canonical JWK members for the RFC 7638 thumbprint (lexicographic order, no whitespace). */
export function thumbprintInput(jwk: JsonWebKey): string | undefined {
  switch (jwk.kty) {
    case 'OKP':
      if (!jwk.crv || !jwk.x) return undefined;
      return JSON.stringify({ crv: jwk.crv, kty: 'OKP', x: jwk.x });
    case 'EC':
      if (!jwk.crv || !jwk.x || !jwk.y) return undefined;
      return JSON.stringify({ crv: jwk.crv, kty: 'EC', x: jwk.x, y: jwk.y });
    case 'RSA':
      if (!jwk.e || !jwk.n) return undefined;
      return JSON.stringify({ e: jwk.e, kty: 'RSA', n: jwk.n });
    default:
      return undefined;
  }
}

/** RFC 7638 (and RFC 8037 App. A.3 for OKP) base64url SHA-256 thumbprint. */
export async function jwkThumbprint(jwk: JsonWebKey, subtle: SubtleCrypto = crypto.subtle): Promise<string | undefined> {
  const input = thumbprintInput(jwk);
  if (!input) return undefined;
  const digest = await subtle.digest('SHA-256', utf8(input));
  return base64url(new Uint8Array(digest));
}

export function isTestKey(jwk: JsonWebKey, thumbprint?: string): boolean {
  if (jwk.kty === 'OKP' && jwk.x === RFC9421_TEST_ED25519_X) return true;
  if (thumbprint && RFC9421_TEST_KEY_THUMBPRINTS.has(thumbprint)) return true;
  if (jwk.kid && RFC9421_TEST_KEY_THUMBPRINTS.has(jwk.kid)) return true;
  return false;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
