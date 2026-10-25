/**
 * RFC 8941 Structured Field Values: the subset RFC 9421 needs (Dictionary,
 * List, Inner List, Item, Parameters, all bare item types) with the canonical
 * serialisation used when rebuilding `@signature-params`.
 */

export type BareItem =
  | { type: 'integer'; value: number }
  | { type: 'decimal'; value: number }
  | { type: 'string'; value: string }
  | { type: 'token'; value: string }
  | { type: 'bytes'; value: Uint8Array }
  | { type: 'boolean'; value: boolean };

export type Params = Array<[string, BareItem]>;
export interface Item {
  item: BareItem;
  params: Params;
}
export interface InnerList {
  items: Item[];
  params: Params;
}
export type Member = Item | InnerList;
export type Dictionary = Map<string, Member>;

export function isInnerList(m: Member): m is InnerList {
  return 'items' in m;
}

export class SfParseError extends Error {
  constructor(message: string, public readonly position: number) {
    super(message);
    this.name = 'SfParseError';
  }
}

class Scanner {
  i = 0;
  constructor(public readonly s: string) {}
  peek(): string {
    return this.s[this.i] ?? '';
  }
  eof(): boolean {
    return this.i >= this.s.length;
  }
  skipSP(): void {
    while (this.s[this.i] === ' ') this.i++;
  }
  skipOWS(): void {
    while (this.s[this.i] === ' ' || this.s[this.i] === '\t') this.i++;
  }
  fail(msg: string): never {
    throw new SfParseError(`${msg} at ${this.i}`, this.i);
  }
}

const KEY_START = /[a-z*]/;
const KEY_CHAR = /[a-z0-9_\-.*]/;
const TOKEN_START = /[A-Za-z*]/;
const TOKEN_CHAR = /[A-Za-z0-9!#$%&'*+\-.^_`|~:/]/;

export function parseDictionary(input: string): Dictionary {
  const sc = new Scanner(input.trim());
  const dict: Dictionary = new Map();
  while (!sc.eof()) {
    const key = parseKey(sc);
    let member: Member;
    if (sc.peek() === '=') {
      sc.i++;
      member = parseItemOrInnerList(sc);
    } else {
      member = { item: { type: 'boolean', value: true }, params: parseParameters(sc) };
    }
    dict.set(key, member);
    sc.skipOWS();
    if (sc.eof()) break;
    if (sc.peek() !== ',') sc.fail('expected ","');
    sc.i++;
    sc.skipOWS();
    if (sc.eof()) sc.fail('trailing comma');
  }
  return dict;
}

export function parseList(input: string): Member[] {
  const sc = new Scanner(input.trim());
  const out: Member[] = [];
  while (!sc.eof()) {
    out.push(parseItemOrInnerList(sc));
    sc.skipOWS();
    if (sc.eof()) break;
    if (sc.peek() !== ',') sc.fail('expected ","');
    sc.i++;
    sc.skipOWS();
    if (sc.eof()) sc.fail('trailing comma');
  }
  return out;
}

export function parseItem(input: string): Item {
  const sc = new Scanner(input.trim());
  const item = parseItemAt(sc);
  sc.skipOWS();
  if (!sc.eof()) sc.fail('unexpected trailing characters');
  return item;
}

function parseItemOrInnerList(sc: Scanner): Member {
  return sc.peek() === '(' ? parseInnerList(sc) : parseItemAt(sc);
}

function parseInnerList(sc: Scanner): InnerList {
  if (sc.peek() !== '(') sc.fail('expected "("');
  sc.i++;
  const items: Item[] = [];
  for (;;) {
    sc.skipSP();
    if (sc.peek() === ')') {
      sc.i++;
      return { items, params: parseParameters(sc) };
    }
    items.push(parseItemAt(sc));
    const c = sc.peek();
    if (c !== ' ' && c !== ')') sc.fail('expected SP or ")" in inner list');
    if (sc.eof()) sc.fail('unterminated inner list');
  }
}

function parseItemAt(sc: Scanner): Item {
  const item = parseBareItem(sc);
  return { item, params: parseParameters(sc) };
}

function parseParameters(sc: Scanner): Params {
  const params: Params = [];
  while (sc.peek() === ';') {
    sc.i++;
    sc.skipSP();
    const key = parseKey(sc);
    let value: BareItem = { type: 'boolean', value: true };
    if (sc.peek() === '=') {
      sc.i++;
      value = parseBareItem(sc);
    }
    const existing = params.findIndex(([k]) => k === key);
    if (existing !== -1) params.splice(existing, 1);
    params.push([key, value]);
  }
  return params;
}

function parseKey(sc: Scanner): string {
  if (!KEY_START.test(sc.peek())) sc.fail('invalid key start');
  let out = '';
  while (!sc.eof() && KEY_CHAR.test(sc.peek())) out += sc.s[sc.i++];
  return out;
}

function parseBareItem(sc: Scanner): BareItem {
  const c = sc.peek();
  if (c === '-' || /[0-9]/.test(c)) return parseNumber(sc);
  if (c === '"') return { type: 'string', value: parseString(sc) };
  if (c === ':') return { type: 'bytes', value: parseByteSequence(sc) };
  if (c === '?') return parseBoolean(sc);
  if (TOKEN_START.test(c)) return { type: 'token', value: parseToken(sc) };
  return sc.fail('invalid bare item');
}

function parseNumber(sc: Scanner): BareItem {
  let sign = 1;
  if (sc.peek() === '-') {
    sign = -1;
    sc.i++;
  }
  if (!/[0-9]/.test(sc.peek())) sc.fail('expected digit');
  let digits = '';
  let decimal = false;
  while (!sc.eof()) {
    const c = sc.peek();
    if (/[0-9]/.test(c)) {
      digits += c;
      sc.i++;
      if (!decimal && digits.length > 15) sc.fail('integer too long');
      if (decimal && digits.length > 16) sc.fail('decimal too long');
    } else if (c === '.' && !decimal) {
      if (digits.length > 12) sc.fail('decimal integer part too long');
      decimal = true;
      digits += c;
      sc.i++;
    } else break;
  }
  if (decimal) {
    if (digits.endsWith('.')) sc.fail('decimal ends with "."');
    const frac = digits.split('.')[1]!;
    if (frac.length > 3) sc.fail('too many decimal places');
    return { type: 'decimal', value: sign * Number(digits) };
  }
  return { type: 'integer', value: sign * Number(digits) };
}

function parseString(sc: Scanner): string {
  if (sc.peek() !== '"') sc.fail('expected "');
  sc.i++;
  let out = '';
  while (!sc.eof()) {
    const c = sc.s[sc.i++]!;
    if (c === '\\') {
      const n = sc.s[sc.i++];
      if (n !== '"' && n !== '\\') sc.fail('invalid escape');
      out += n;
    } else if (c === '"') {
      return out;
    } else {
      const code = c.charCodeAt(0);
      if (code < 0x20 || code > 0x7e) sc.fail('invalid string character');
      out += c;
    }
  }
  return sc.fail('unterminated string');
}

function parseToken(sc: Scanner): string {
  let out = '';
  while (!sc.eof() && TOKEN_CHAR.test(sc.peek())) out += sc.s[sc.i++];
  return out;
}

function parseByteSequence(sc: Scanner): Uint8Array {
  if (sc.peek() !== ':') sc.fail('expected ":"');
  sc.i++;
  const end = sc.s.indexOf(':', sc.i);
  if (end === -1) sc.fail('unterminated byte sequence');
  const b64 = sc.s.slice(sc.i, end);
  if (!/^[A-Za-z0-9+/=]*$/.test(b64)) sc.fail('invalid base64');
  sc.i = end + 1;
  return base64Decode(b64);
}

function parseBoolean(sc: Scanner): BareItem {
  sc.i++;
  const c = sc.s[sc.i++];
  if (c === '1') return { type: 'boolean', value: true };
  if (c === '0') return { type: 'boolean', value: false };
  return sc.fail('invalid boolean');
}

// ───────────────────────── serialisation (RFC 8941 §4.1) ─────────────────────────

export function serializeBareItem(b: BareItem): string {
  switch (b.type) {
    case 'integer':
      return String(Math.trunc(b.value));
    case 'decimal':
      return serializeDecimal(b.value);
    case 'string':
      return `"${b.value.replace(/(["\\])/g, '\\$1')}"`;
    case 'token':
      return b.value;
    case 'bytes':
      return `:${base64Encode(b.value)}:`;
    case 'boolean':
      return b.value ? '?1' : '?0';
  }
}

function serializeDecimal(v: number): string {
  const rounded = Math.round(v * 1000) / 1000;
  let s = rounded.toFixed(3).replace(/0+$/, '');
  if (s.endsWith('.')) s += '0';
  return s;
}

export function serializeParams(params: Params): string {
  let out = '';
  for (const [k, v] of params) {
    out += `;${k}`;
    if (!(v.type === 'boolean' && v.value === true)) out += `=${serializeBareItem(v)}`;
  }
  return out;
}

export function serializeItem(item: Item): string {
  return serializeBareItem(item.item) + serializeParams(item.params);
}

export function serializeInnerList(list: InnerList): string {
  return `(${list.items.map(serializeItem).join(' ')})${serializeParams(list.params)}`;
}

export function serializeMember(m: Member): string {
  return isInnerList(m) ? serializeInnerList(m) : serializeItem(m);
}

export function serializeDictionary(d: Dictionary): string {
  const parts: string[] = [];
  for (const [k, m] of d) {
    if (!isInnerList(m) && m.item.type === 'boolean' && m.item.value === true) parts.push(k + serializeParams(m.params));
    else parts.push(`${k}=${serializeMember(m)}`);
  }
  return parts.join(', ');
}

export function serializeList(l: Member[]): string {
  return l.map(serializeMember).join(', ');
}

/**
 * Raw text of one dictionary member value exactly as it appears on the wire
 * (after `key=` up to the next top-level comma). Used as a fallback when a
 * signer did not use canonical serialisation for `@signature-params`.
 */
export function rawDictionaryMember(input: string, key: string): string | undefined {
  const s = input;
  let i = 0;
  let depth = 0;
  let inString = false;
  let memberStart = 0;
  const members: string[] = [];
  for (; i < s.length; i++) {
    const c = s[i]!;
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) {
      members.push(s.slice(memberStart, i));
      memberStart = i + 1;
    }
  }
  members.push(s.slice(memberStart));
  for (const m of members) {
    const t = m.trim();
    const eq = t.indexOf('=');
    const k = (eq === -1 ? t : t.slice(0, eq)).trim();
    if (k === key) return eq === -1 ? undefined : t.slice(eq + 1).trim();
  }
  return undefined;
}

// ───────────────────────── base64 helpers (standard alphabet) ─────────────────────────

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_LOOKUP = new Map<string, number>([...B64].map((c, i) => [c, i] as [string, number]));
B64_LOOKUP.set('-', 62);
B64_LOOKUP.set('_', 63);

export function base64Decode(input: string): Uint8Array {
  const clean = input.replace(/=+$/, '').replace(/\s+/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 6) / 8));
  let buffer = 0;
  let bits = 0;
  let o = 0;
  for (const ch of clean) {
    const v = B64_LOOKUP.get(ch);
    if (v === undefined) throw new SfParseError('invalid base64 character', 0);
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (buffer >> bits) & 0xff;
    }
  }
  return out.subarray(0, o);
}

export function base64Encode(bytes: Uint8Array, url = false): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + B64[n & 63]!;
  }
  if (i < bytes.length) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8);
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!;
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63]! : '=';
    out += '=';
  }
  if (url) return out.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return out;
}
