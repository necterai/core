/**
 * JA4 / Akamai HTTP/2 fingerprint parsing (formats per server-fingerprints.md §2).
 */

export interface Ja4Parts {
  /** t (TCP), q (QUIC), d (DTLS). */
  protocol: string;
  /** '13', '12', ... '00'. */
  tlsVersion: string;
  sni: boolean;
  cipherCount: number;
  extensionCount: number;
  /** First+last char of the first ALPN value: 'h2', 'h1', '00' (none) or other. */
  alpn: string;
  /** JA4 `b`: truncated SHA-256 of the sorted cipher list. */
  cipherHash: string;
  /** JA4 `c`: truncated SHA-256 of sorted extensions + signature algorithms. */
  extensionHash: string;
  a: string;
}

export function parseJa4(ja4: string | undefined): Ja4Parts | undefined {
  if (!ja4) return undefined;
  const m = /^([tqd])(\d{2})([di])(\d{2})(\d{2})([a-z0-9]{2})_([a-f0-9]{12}|0{12})_([a-f0-9]{12}|0{12})$/i.exec(ja4.trim());
  if (!m) return undefined;
  return {
    protocol: m[1]!.toLowerCase(),
    tlsVersion: m[2]!,
    sni: m[3]!.toLowerCase() === 'd',
    cipherCount: Number(m[4]),
    extensionCount: Number(m[5]),
    alpn: m[6]!.toLowerCase(),
    cipherHash: m[7]!.toLowerCase(),
    extensionHash: m[8]!.toLowerCase(),
    a: m[1]! + m[2]! + m[3]! + m[4]! + m[5]! + m[6]!,
  };
}

/** GREASE values (RFC 8701): 0x0a0a, 0x1a1a, ... 0xfafa. */
export function isGreaseCode(hex: string): boolean {
  return /^([0-9a-f])a\1a$/i.test(hex.trim());
}

/**
 * Inspect a JA4_r (raw) string for GREASE cipher/extension codes. Returns
 * undefined when the input is not a JA4_r. Note: some tooling strips GREASE
 * before emitting the raw form; prefer an explicit `grease` flag from the edge.
 */
export function ja4RawHasGrease(ja4r: string | undefined): boolean | undefined {
  if (!ja4r) return undefined;
  const parts = ja4r.trim().split('_');
  if (parts.length < 3) return undefined;
  const codes = parts.slice(1).flatMap((p) => p.split(',')).map((c) => c.trim()).filter(Boolean);
  if (!codes.length || !codes.every((c) => /^[0-9a-f]{4}$/i.test(c))) return undefined;
  return codes.some(isGreaseCode);
}

export interface AkamaiParts {
  settings: string;
  settingsMap: Record<string, number>;
  windowUpdate: string;
  priority: string;
  pseudoOrder: string;
  raw: string;
}

export function parseAkamai(fp: string | undefined): AkamaiParts | undefined {
  if (!fp) return undefined;
  const parts = fp.trim().split('|');
  if (parts.length < 4) return undefined;
  const settingsMap: Record<string, number> = {};
  for (const kv of parts[0]!.split(';')) {
    const [k, v] = kv.split(':');
    if (k && v !== undefined) settingsMap[k] = Number(v);
  }
  return { settings: parts[0]!, settingsMap, windowUpdate: parts[1]!, priority: parts[2]!, pseudoOrder: parts[3]!, raw: fp.trim() };
}

/** Expected HTTP/2 pseudo-header order per browser family. */
export const BROWSER_PSEUDO_ORDER: Record<'chromium' | 'firefox' | 'safari', string> = {
  chromium: 'm,a,s,p',
  firefox: 'm,p,a,s',
  safari: 'm,s,a,p',
};
