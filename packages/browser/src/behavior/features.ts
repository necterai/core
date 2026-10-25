import { BUFFER_SIZE, type ClickRecord, type InputRecord, type KeyRecord, type MoveSample, type Snapshot } from './records.js';

/**
 * Pure feature extraction over a capture snapshot. No DOM access: everything
 * here can be unit-tested with hand-built or dataset-replayed snapshots.
 *
 * Calibration notes (numbers from docs/research/raw/behavior-biometrics.md):
 * - Human click duration: Balabit median 94-109 ms, p5 62-78 ms (§4.2).
 * - Human hold time: CMU mean 90 ms, p1 38 ms; IKI mean 239 ms, lower bound ~60 ms (§4.2).
 * - CDP input: pointerover→pointerdown ≈ 2-9 ms, down→up 1.2-4.8 ms, keys ≈ 0.1-3 ms (§2.12, extension-agents §3.4).
 * - Remote-desktop human motion arrives at ~110 ms per sample (Balabit Move→Move p50 110-124 ms), so path
 *   statistics use a 2 s window and an arrival-anchored teleport test (see `clickFeatures`).
 */

// ───────────── small statistics ─────────────

export function mean(a: readonly number[]): number {
  if (a.length === 0) return NaN;
  let s = 0;
  for (const v of a) s += v;
  return s / a.length;
}

export function std(a: readonly number[]): number {
  if (a.length < 2) return NaN;
  const m = mean(a);
  let s = 0;
  for (const v of a) s += (v - m) * (v - m);
  return Math.sqrt(s / a.length);
}

/** Coefficient of variation (std / mean); NaN when undefined. */
export function cv(a: readonly number[]): number {
  const m = mean(a);
  if (!(m > 0)) return NaN;
  return std(a) / m;
}

export function quantile(a: readonly number[], q: number): number {
  if (a.length === 0) return NaN;
  const s = [...a].sort((x, y) => x - y);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}

export function median(a: readonly number[]): number {
  return quantile(a, 0.5);
}

function round(v: number, digits = 2): number {
  if (!Number.isFinite(v)) return v;
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

/** Index of the last element with t <= time (binary search on a time-sorted array), -1 if none. */
export function lastIndexAtOrBefore<T extends { t: number }>(arr: readonly T[], time: number): number {
  let lo = 0;
  let hi = arr.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid]!.t <= time) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

function countInRange<T extends { t: number }>(arr: readonly T[], from: number, to: number): number {
  // (from, to]
  return lastIndexAtOrBefore(arr, to) - lastIndexAtOrBefore(arr, from);
}

function sliceRange<T extends { t: number }>(arr: readonly T[], from: number, to: number): T[] {
  return arr.slice(lastIndexAtOrBefore(arr, from) + 1, lastIndexAtOrBefore(arr, to) + 1);
}

/** Visible milliseconds in [a, b): hidden/prerender spans are subtracted (clocks pause while hidden). */
export function visibleDuration(a: number, b: number, spans: readonly [number, number][], hiddenSince: number | null): number {
  if (b <= a) return 0;
  let hidden = 0;
  const all: [number, number][] = hiddenSince !== null ? [...spans, [hiddenSince, Infinity]] : [...spans];
  for (const [s, e] of all) {
    const lo = Math.max(a, s);
    const hi = Math.min(b, e);
    if (hi > lo) hidden += hi - lo;
  }
  return Math.max(0, b - a - hidden);
}

/** Merge [start, end] intervals (sorted by start) for fast membership tests. */
export function mergeIntervals(intervals: readonly (readonly [number, number])[]): [number, number][] {
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

export function inIntervals(merged: readonly [number, number][], t: number): boolean {
  let lo = 0;
  let hi = merged.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [a, b] = merged[mid]!;
    if (t < a) hi = mid - 1;
    else if (t > b) lo = mid + 1;
    else return true;
  }
  return false;
}

/** Click windows (approach window through 50 ms after release): moves inside are not "idle". */
export function clickWindows(clicks: readonly ClickFeature[]): [number, number][] {
  return mergeIntervals(clicks.map((c) => [Math.min(c.rec.downT ?? c.rec.t, c.arrivalT) - TELEPORT_WINDOW_MS, (c.rec.upT ?? c.rec.t) + 50] as const));
}

const byTime = <T extends { t: number }>(a: readonly T[]): T[] => {
  for (let i = 1; i < a.length; i++) if (a[i]!.t < a[i - 1]!.t) return [...a].sort((x, y) => x.t - y.t);
  return a as T[];
};

/** Event timestamps can arrive slightly out of order (a wheel is dispatched after the scroll it caused). */
export function sortSnapshot(snap: Snapshot): Snapshot {
  return {
    ...snap,
    moves: byTime(snap.moves),
    clicks: byTime(snap.clicks),
    keys: byTime(snap.keys),
    inputs: byTime(snap.inputs),
    wheels: byTime(snap.wheels),
    scrolls: byTime(snap.scrolls),
    causes: byTime(snap.causes),
    focuses: byTime(snap.focuses),
    selects: byTime(snap.selects),
    pastes: [...snap.pastes].sort((a, b) => a - b),
    compositions: [...snap.compositions].sort((a, b) => a - b),
  };
}

// ───────────── paths ─────────────

export interface PathStats {
  n: number;
  /** chord / path length (1 = straight); null for < 3 samples or zero length. */
  linearity: number | null;
  /** CV of step lengths (0 = evenly spaced, interpolated). */
  stepCv: number | null;
  /** CV of sample intervals. */
  intervalCv: number | null;
  /** Position of the speed peak as a fraction of path length (bell-shaped: 0.2-0.7). */
  peakPos: number | null;
  length: number;
}

export function pathStats(samples: readonly { t: number; x: number; y: number }[]): PathStats {
  const n = samples.length;
  if (n < 3) return { n, linearity: null, stepCv: null, intervalCv: null, peakPos: null, length: 0 };
  const steps: number[] = [];
  const dts: number[] = [];
  const speeds: number[] = [];
  const cum: number[] = [];
  let L = 0;
  for (let i = 1; i < n; i++) {
    const a = samples[i - 1]!;
    const b = samples[i]!;
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    const dt = b.t - a.t;
    steps.push(d);
    dts.push(dt);
    // Δt floor: remote-desktop data batches several samples on one timestamp (§12.6).
    speeds.push(d / Math.max(4, dt));
    cum.push(L + d / 2);
    L += d;
  }
  const first = samples[0]!;
  const last = samples[n - 1]!;
  const D = Math.hypot(last.x - first.x, last.y - first.y);
  let peak = 0;
  for (let i = 1; i < speeds.length; i++) if (speeds[i]! > speeds[peak]!) peak = i;
  const sc = cv(steps);
  const ic = cv(dts);
  return {
    n,
    linearity: L > 0 ? D / L : null,
    stepCv: Number.isFinite(sc) ? sc : L > 0 ? 0 : null,
    intervalCv: Number.isFinite(ic) ? ic : null,
    peakPos: L > 0 ? cum[peak]! / L : null,
    length: L,
  };
}

// ───────────── clicks ─────────────

/** Radius (CSS px) within which the pointer counts as "arrived" at the press point (= minimum target size). */
export const ARRIVAL_RADIUS = 24;
/** Teleport window (spec §3): pointermoves in the 600 ms before arrival. */
export const TELEPORT_WINDOW_MS = 600;
/** Path window for natural-pointer statistics (research §4.3 `moves_before_click`: 2 s). */
export const PATH_WINDOW_MS = 2000;
/** A pause longer than this splits a path into segments (RDP sampling is ~110 ms). */
export const SEGMENT_PAUSE_MS = 400;

export interface ClickFeature {
  rec: ClickRecord;
  /** Trusted mouse press+release+click (kinematic signals apply; touch/pen never). */
  pointer: boolean;
  /** pointermoves in the 600 ms window ending at arrival (or the press when there is no approach). */
  movesBefore: number;
  moves2s: number;
  /** pointermoves in the 500 ms before the press (InteractionSummary definition). */
  moves500: number;
  arrivalT: number;
  /** Final segment of the 2 s approach path. */
  path: PathStats;
  /** Arrival-anchored teleport window path (for interpolated-path detection). */
  approach: PathStats;
  /** Sample-interval CV over the raw 2 s window. */
  intervalCv2s: number | null;
  hoverMs: number | null;
  downUpMs: number | null;
  overDownMs: number | null;
  centreEligible: boolean;
  centreHit: boolean;
  teleport: boolean;
  natural: boolean;
  linear: boolean;
  /** A pointermove jumped away within 30 ms of release and nothing followed (NVDA jump-back). */
  returnJump: boolean;
  /** The jump went back to the exact pre-teleport position. */
  returnToPrev: boolean;
}

function mouseMoves(moves: readonly MoveSample[]): MoveSample[] {
  return moves.filter((m) => (m.pointerType === 'mouse' || m.pointerType === 'unknown') && !m.hidden);
}

/** Click features are computed for the most recent clicks only (bounded main-thread cost). */
export const MAX_CLICK_FEATURES = 60;

export function clickFeatures(snap: Snapshot): ClickFeature[] {
  const moves = mouseMoves(snap.moves);
  const out: ClickFeature[] = [];
  const clicks = snap.clicks;
  for (let ci = Math.max(0, clicks.length - MAX_CLICK_FEATURES); ci < clicks.length; ci++) {
    const rec = clicks[ci]!;
    const pointer = rec.kind === 'pointer' && rec.trusted && !rec.hidden && (rec.pointerType === 'mouse' || rec.pointerType === 'unknown');
    const tDown = rec.downT ?? rec.t;
    const idx = lastIndexAtOrBefore(moves, tDown);
    let a = idx;
    let arrivalT = tDown;
    while (a >= 0 && Math.hypot(moves[a]!.x - rec.x, moves[a]!.y - rec.y) <= ARRIVAL_RADIUS) {
      arrivalT = moves[a]!.t;
      a--;
    }
    const prev = a >= 0 ? moves[a]! : null;
    const winStart = Math.min(tDown, arrivalT) - TELEPORT_WINDOW_MS;
    const movesBefore = countInRange(moves, winStart, tDown);
    const raw2s = sliceRange(moves, tDown - PATH_WINDOW_MS, tDown);
    let segStart = 0;
    for (let i = 1; i < raw2s.length; i++) if (raw2s[i]!.t - raw2s[i - 1]!.t > SEGMENT_PAUSE_MS) segStart = i;
    const path = pathStats(raw2s.slice(segStart));
    const approach = pathStats(sliceRange(moves, winStart, tDown));
    const dts: number[] = [];
    for (let i = 1; i < raw2s.length; i++) dts.push(raw2s[i]!.t - raw2s[i - 1]!.t);
    const icv = cv(dts);
    const intervalCv2s = Number.isFinite(icv) ? icv : null;
    // Hover dwell: since the pointer entered the arrival radius or the latest pointerover, whichever is later.
    const hoverStart = Math.max(arrivalT, rec.overT ?? -Infinity);
    const hoverMs = rec.downT !== null ? Math.max(0, tDown - hoverStart) : null;
    const downUpMs = rec.downT !== null && rec.upT !== null && rec.upT >= rec.downT ? rec.upT - rec.downT : null;
    const overDownMs = rec.downT !== null && rec.overT !== null && rec.overT <= rec.downT && rec.downT - rec.overT < 10_000 ? rec.downT - rec.overT : null;
    const g = rec.geometry;
    const centreEligible = pointer && !!g && g.w >= 24 && g.h >= 24;
    const centreHit = centreEligible && Math.abs(g!.dx) <= 1 && Math.abs(g!.dy) <= 1;
    const teleport = pointer && movesBefore <= 1;
    // Natural: >= 8 moves in 2 s and at least 3 of the 4 kinematic criteria (spec §3 thresholds; the
    // linearity floor is 0.3 instead of 0.6 because Balabit final segments have median 0.68-0.82, p10 0.2-0.35).
    let crit = 0;
    if (path.linearity !== null && path.linearity >= 0.3 && path.linearity <= 0.98) crit++;
    if (path.peakPos !== null && path.peakPos >= 0.2 && path.peakPos <= 0.7) crit++;
    if (intervalCv2s !== null && intervalCv2s > 0.15) crit++;
    if (hoverMs !== null && hoverMs >= 60 && hoverMs <= 1500) crit++;
    const natural = pointer && raw2s.length >= 8 && crit >= 3;
    // Interpolated path: evenly spaced samples on a straight line. Spatial evenness is the discriminator
    // because rAF-aligned pointermoves give humans near-constant intervals too (research §4.1).
    const linear =
      pointer &&
      movesBefore >= 5 &&
      approach.linearity !== null &&
      approach.linearity > 0.995 &&
      approach.stepCv !== null &&
      (approach.stepCv < 0.05 || (approach.intervalCv !== null && approach.intervalCv < 0.05 && approach.stepCv < 0.15));
    // NVDA: pointer jumps to the centre ~1 ms before pointerdown and back ~5 ms after pointerup.
    let returnJump = false;
    let returnToPrev = false;
    if (pointer && rec.upT !== null) {
      const j = lastIndexAtOrBefore(moves, rec.upT) + 1;
      const m = moves[j];
      if (m && m.t - rec.upT <= 30 && Math.hypot(m.x - rec.x, m.y - rec.y) >= ARRIVAL_RADIUS) {
        const next = clicks[ci + 1];
        const nextDown = next ? next.downT ?? next.t : Infinity;
        if (nextDown - m.t > 300) {
          returnJump = true;
          returnToPrev = !!prev && Math.hypot(m.x - prev.x, m.y - prev.y) <= 3;
        }
      }
    }
    out.push({
      rec,
      pointer,
      movesBefore,
      moves2s: raw2s.length,
      moves500: countInRange(moves, tDown - 500, tDown),
      arrivalT,
      path,
      approach,
      intervalCv2s,
      hoverMs,
      downUpMs,
      overDownMs,
      centreEligible,
      centreHit,
      teleport,
      natural,
      linear,
      returnJump,
      returnToPrev,
    });
  }
  return out;
}

// ───────────── coordinate lattice ─────────────

/** Scale factors seen in computer-use harnesses (research §5.6, computer-use-agents §11.3). */
export const LATTICE_STRIDES = [8 / 7, 1.25, 4 / 3, 1.35, 1.4056, 1.44, 1.5, 1.6, 1.875, 1.92, 2, 2.25, 2.5];

export interface LatticeResult {
  stride: number;
  frame: 'client' | 'screen' | 'device';
  /** round = half-up (JS), round-even = half-to-even (Python round()), floor = int() truncation. */
  mapping: 'round' | 'round-even' | 'floor';
  n: number;
  hits: number;
  /** Bonferroni-corrected chance probability. */
  p: number;
}

/** Corrected chance probability a lattice hypothesis must beat (strict: evaluated repeatedly per session). */
export const LATTICE_MAX_P = 1e-5;

function isInt(X: number): boolean {
  return Math.abs(X - Math.round(X)) <= 1e-6;
}

function roundHalfEven(v: number): number {
  const f = Math.floor(v);
  const d = v - f;
  if (Math.abs(d - 0.5) < 1e-9) return f % 2 === 0 ? f : f + 1;
  return Math.round(v);
}

const MAPPINGS: Record<LatticeResult['mapping'], (X: number, s: number) => boolean> = {
  round: (X, s) => {
    const k = Math.round(X / s);
    for (let d = -1; d <= 1; d++) if (Math.round((k + d) * s + 1e-9) === X) return true;
    return false;
  },
  'round-even': (X, s) => {
    const k = Math.round(X / s);
    for (let d = -1; d <= 1; d++) if (roundHalfEven((k + d) * s) === X) return true;
    return false;
  },
  floor: (X, s) => {
    const k = Math.ceil(X / s - 1e-9);
    for (let d = -1; d <= 1; d++) if (Math.floor((k + d) * s + 1e-9) === X) return true;
    return false;
  },
};

/** Binomial upper tail P[X >= k] for X ~ Bin(n, p). */
export function binomTail(n: number, k: number, p: number): number {
  if (k <= 0) return 1;
  if (k > n) return 0;
  let logC = 0; // log C(n, k)
  for (let j = 1; j <= k; j++) logC += Math.log((n - k + j) / j);
  let total = 0;
  for (let i = k; i <= n; i++) {
    total += Math.exp(logC + i * Math.log(p) + (n - i) * Math.log(1 - p));
    if (i < n) logC += Math.log((n - i) / (i + 1)); // C(n, i+1) = C(n, i)·(n-i)/(i+1)
  }
  return Math.min(1, total);
}

/**
 * Lattice test: do (x, y) press/move points sit on `round(k·s)` (Anthropic scale_coordinates uses Python
 * round, Claude in Chrome 8/7) or `floor(k·s)` (Gemini 0-999 grid) for one candidate stride? A random
 * integer is reachable with probability 1/s per axis, so both axes together give 1/s² chance; the best
 * hypothesis must reach a 95 % hit rate and survive a Bonferroni correction over all strides × frames ×
 * mappings at LATTICE_MAX_P. (Spec: 85 % at >= 8 samples; on the Balabit human session that fired at
 * stride 8/7 — 57/60 hits where 46 are expected by chance — so the bound is statistical instead.)
 */
export function latticeTest(points: readonly { x: number; y: number; sx: number; sy: number }[], dpr: number, minN = 8): LatticeResult | null {
  if (points.length < minN) return null;
  const frames: { frame: LatticeResult['frame']; get: (p: { x: number; y: number; sx: number; sy: number }) => [number, number] }[] = [
    { frame: 'client', get: (p) => [p.x, p.y] },
    { frame: 'screen', get: (p) => [p.sx, p.sy] },
  ];
  if (Math.abs(dpr - 1) > 1e-3) frames.push({ frame: 'device', get: (p) => [p.x * dpr, p.y * dpr] });
  const mappings = Object.keys(MAPPINGS) as LatticeResult['mapping'][];
  const hypotheses = frames.length * mappings.length * LATTICE_STRIDES.length;
  let best: LatticeResult | null = null;
  for (const f of frames) {
    // Distinct positions only: a frame where many samples share one position (e.g. screenX/Y stuck at 0)
    // must not count as many lattice hits.
    const seen = new Set<string>();
    const coords: [number, number][] = [];
    for (const p of points) {
      const c = f.get(p);
      const k = `${c[0]},${c[1]}`;
      if (!seen.has(k)) {
        seen.add(k);
        coords.push(c);
      }
    }
    const n = coords.length;
    if (n < minN) continue;
    if (coords.filter(([X, Y]) => isInt(X) && isInt(Y)).length / n < 0.95) continue;
    for (const mapping of mappings) {
      const reach = MAPPINGS[mapping];
      for (const s of LATTICE_STRIDES) {
        let hits = 0;
        for (const [X, Y] of coords) if (isInt(X) && isInt(Y) && reach(Math.round(X), s) && reach(Math.round(Y), s)) hits++;
        if (hits / n < 0.95) continue;
        const p = Math.min(1, binomTail(n, hits, 1 / (s * s)) * hypotheses);
        if (!best || p < best.p) best = { stride: s, frame: f.frame, mapping, n, hits, p };
      }
    }
  }
  return best && best.p < LATTICE_MAX_P ? best : null;
}

// ───────────── typing ─────────────

export interface TypingGroup {
  field: number;
  keydowns: number;
  ikis: number[];
  ikiMedian: number;
  ikiCv: number;
  dwells: number[];
  dwellMedian: number;
  dwellCv: number;
  /** Share of keys released after the next key went down. */
  rollover: number;
  /** Median IKI ending at space/punctuation vs letters (digraph structure). */
  boundaryMedian: number;
  charMedian: number;
}

function typingKeys(keys: readonly KeyRecord[]): KeyRecord[] {
  return keys.filter((k) => k.trusted && !k.repeat && k.cls !== 'generic' && k.cls !== 'modifier' && !k.hidden);
}

export function typingGroups(keys: readonly KeyRecord[], burstGapMs = 2000): TypingGroup[] {
  const byField = new Map<number, KeyRecord[]>();
  for (const k of typingKeys(keys)) {
    const list = byField.get(k.field) ?? [];
    list.push(k);
    byField.set(k.field, list);
  }
  const out: TypingGroup[] = [];
  for (const [field, list] of byField) {
    list.sort((a, b) => a.t - b.t);
    const ikis: number[] = [];
    const boundary: number[] = [];
    const chars: number[] = [];
    let roll = 0;
    let rollN = 0;
    for (let i = 1; i < list.length; i++) {
      const d = list[i]!.t - list[i - 1]!.t;
      if (d < burstGapMs) {
        ikis.push(d);
        const cls = list[i]!.cls;
        if (cls === 'space' || cls === 'punct') boundary.push(d);
        else if (cls === 'char') chars.push(d);
      }
      const up = list[i - 1]!.up;
      if (up !== null) {
        rollN++;
        if (list[i]!.t < up) roll++;
      }
    }
    const dwells = list.filter((k) => k.up !== null).map((k) => k.up! - k.t);
    out.push({
      field,
      keydowns: list.length,
      ikis,
      ikiMedian: median(ikis),
      ikiCv: cv(ikis),
      dwells,
      dwellMedian: median(dwells),
      dwellCv: cv(dwells),
      rollover: rollN ? roll / rollN : NaN,
      boundaryMedian: median(boundary),
      charMedian: median(chars),
    });
  }
  return out;
}

/** Pairs of consecutive trusted keydowns on distinct keys sharing one timeStamp (CDP batches). */
export function identicalKeyPairs(keys: readonly KeyRecord[]): number {
  const list = typingKeys(keys).sort((a, b) => a.t - b.t);
  let n = 0;
  for (let i = 1; i < list.length; i++) if (Math.abs(list[i]!.t - list[i - 1]!.t) < 0.05 && list[i]!.code !== list[i - 1]!.code) n++;
  return n;
}

/** Timestamps carry sub-millisecond information (Chrome 0.1 ms) rather than 1 ms / 16.7 ms rounding. */
export function fineClock(times: readonly number[]): boolean {
  const ts = times.filter((t) => Number.isFinite(t) && t > 0);
  if (ts.length < 10) return false;
  let frac = 0;
  for (const t of ts) {
    const f = t - Math.floor(t);
    if (f > 0.05 && f < 0.95) frac++;
  }
  return frac / ts.length >= 0.2;
}

// ───────────── form fills ─────────────

export type FillClass =
  | 'typed'
  | 'agent-fill'
  | 'autofill'
  | 'password-manager'
  | 'untrusted-form-fill'
  | 'credential-untrusted'
  | 'untrusted-other'
  | 'paste'
  | 'ime'
  | 'possible-autofill'
  | 'other';

export interface FillEpisode {
  field: number;
  t: number;
  delta: number;
  cls: FillClass;
  inputType: string;
  /** A trusted `select` event on the field just before (Playwright fill: select() + insertText). */
  selectBefore: boolean;
  fieldType: string;
}

const AUTOFILL_TOKENS =
  /\b(username|current-password|new-password|one-time-code|email|tel|name|given-name|family-name|additional-name|honorific-\w+|nickname|organization|street-address|address-line\d|address-level\d|postal-code|country|country-name|cc-\w+|bday\S*|webauthn)\b/;

export function isCredentialOrAutofillField(fieldType: string, autocomplete: string): boolean {
  return fieldType === 'password' || fieldType === 'email' || fieldType === 'tel' || AUTOFILL_TOKENS.test(autocomplete);
}

function isCredentialField(fieldType: string, autocomplete: string): boolean {
  return fieldType === 'password' || /\b(current-password|new-password|one-time-code|cc-\w+)\b/.test(autocomplete);
}

export function fillEpisodes(snap: Snapshot): FillEpisode[] {
  const byField = new Map<number, InputRecord[][]>();
  for (const r of snap.inputs) {
    if (r.field === 0) continue;
    const eps = byField.get(r.field) ?? [];
    const cur = eps[eps.length - 1];
    if (cur && r.t - cur[cur.length - 1]!.t <= 150) cur.push(r);
    else eps.push([r]);
    byField.set(r.field, eps);
  }
  const keys = snap.keys;
  const out: FillEpisode[] = [];
  for (const [field, eps] of byField) {
    for (const ep of eps) {
      const changes = ep.filter((r) => r.kind !== 'beforeinput');
      if (changes.length === 0) continue;
      const delta = Math.max(...changes.map((r) => r.delta));
      if (delta < 4) continue;
      const t = ep[0]!.t;
      const end = ep[ep.length - 1]!.t;
      const first = changes[0]!;
      const trustedChange = changes.find((r) => r.trusted);
      const untrusted = changes.some((r) => !r.trusted);
      const inputType = ep.find((r) => r.trusted && r.inputType)?.inputType ?? '';
      const fieldType = first.fieldType;
      const autocomplete = first.autocomplete;
      const autofill = ep.some((r) => r.autofill);
      const pmMarker = ep.some((r) => r.pmMarker);
      const keysNear = sliceRange(keys, t - 300 - 1e-9, end);
      const typedKeys = keysNear.some((k) => k.trusted && k.field === field && (k.cls === 'char' || k.cls === 'space' || k.cls === 'punct' || k.cls === 'backspace'));
      const anyKey = keysNear.some((k) => k.t <= t);
      const trustedGeneric = keysNear.some((k) => k.trusted && k.cls === 'generic');
      const untrustedGenericOnField = sliceRange(keys, t - 500 - 1e-9, end + 50).some((k) => !k.trusted && k.field === field);
      const focusBefore = snap.focuses.some((f) => f.trusted && f.field === field && f.t <= t && t - f.t <= 5000);
      const paste = snap.pastes.some((p) => p >= t - 300 && p <= end + 10) || inputType === 'insertFromPaste';
      const ime = snap.compositions.some((c) => c >= t - 1000 && c <= end) || inputType === 'insertCompositionText';
      const selectBefore = snap.selects.some((s) => s.field === field && s.t <= t && t - s.t <= 50);
      let cls: FillClass;
      if (typedKeys) cls = 'typed';
      else if (untrusted && !trustedChange) {
        if (untrustedGenericOnField || pmMarker || autofill) cls = 'password-manager';
        else if (isCredentialField(fieldType, autocomplete)) cls = 'credential-untrusted';
        else if (!first.isInputEvent && focusBefore) cls = snap.pmMarkersPresent ? 'password-manager' : 'untrusted-form-fill';
        else cls = 'untrusted-other';
      } else if (untrustedGenericOnField || pmMarker) cls = 'password-manager';
      else if (trustedGeneric || autofill || inputType === 'insertReplacementText') cls = 'autofill';
      else if (paste) cls = 'paste';
      else if (ime) cls = 'ime';
      else if (!anyKey && inputType === 'insertText') cls = 'agent-fill';
      else if (!anyKey && inputType === '') cls = isCredentialOrAutofillField(fieldType, autocomplete) ? 'possible-autofill' : 'agent-fill';
      else cls = 'other';
      out.push({ field, t, delta, cls, inputType, selectBefore, fieldType });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

// ───────────── scroll & wheel ─────────────

export const SCROLL_CAUSE_WINDOW_MS = 150;
export const SCROLL_BURST_GAP_MS = 120;

export interface ScrollBurst {
  start: number;
  end: number;
  events: number;
  cause: string;
  programmatic: boolean;
}

/**
 * Group scroll events into bursts and decide provenance per burst: a burst is programmatic when no
 * wheel/touch/key/pointer/focus/navigation/resize input happened in the 150 ms before it starts and the
 * page has been loaded for more than 1 s. Decided lazily (bursts younger than 200 ms are skipped) because
 * Chrome can dispatch the causing wheel event after the first scroll (research Appendix A rows 51-53).
 */
export function scrollBursts(snap: Snapshot): ScrollBurst[] {
  const out: ScrollBurst[] = [];
  let cur: ScrollBurst | null = null;
  for (const s of snap.scrolls) {
    if (cur && s.t - cur.end <= SCROLL_BURST_GAP_MS) {
      cur.end = s.t;
      cur.events++;
    } else {
      cur = { start: s.t, end: s.t, events: 1, cause: '', programmatic: false };
      out.push(cur);
    }
  }
  // Only judge bursts inside the cause buffer's horizon: once the cause ring has evicted older entries,
  // an old burst's cause may simply be gone.
  const horizon = snap.causes.length >= BUFFER_SIZE ? snap.causes[0]!.t + SCROLL_CAUSE_WINDOW_MS : -Infinity;
  const settled = out.filter((b) => snap.now - b.start >= 200 && b.start >= horizon);
  for (const b of settled) {
    const ci = lastIndexAtOrBefore(snap.causes, b.start + 20);
    const c = ci >= 0 && snap.causes[ci]!.t >= b.start - SCROLL_CAUSE_WINDOW_MS ? snap.causes[ci]! : undefined;
    if (c) b.cause = c.kind;
    else if (b.start - snap.loadT < 1000) b.cause = 'load';
    else if (visibleDuration(b.start - 1, b.start, snap.hiddenSpans, snap.hiddenSince) === 0) b.cause = 'hidden';
    else {
      b.cause = 'none';
      b.programmatic = true;
    }
  }
  return settled;
}

const PLATFORM_WHEEL_RATIOS = [1.2, 1, 3];

export interface WheelFeatures {
  n: number;
  modalDelta: number;
  /** All >= 5 events share one |deltaY| >= 100 in pixel mode. */
  sameDelta: boolean;
  intervalCv: number;
  /** Every event has wheelDeltaY/deltaY at a hardware ratio (Windows 1.2, X11 1, macOS precise 3). */
  hardwareRatio: boolean | null;
  /** Events with |wheelDeltaY| === 120 but a round, large deltaY at a non-platform ratio (CDP mouseWheel). */
  cdpMismatch: number;
  /** Events whose |wheelDeltaY| is neither 0 nor 120 (trackpads / multi-notch). */
  otherTicks: number;
}

export function wheelFeatures(snap: Snapshot): WheelFeatures {
  const ws = snap.wheels.filter((w) => w.trusted && w.t >= snap.segmentStart);
  const abs = ws.filter((w) => w.mode === 0 && w.dy !== 0).map((w) => Math.round(Math.abs(w.dy) * 100) / 100);
  const freq = new Map<number, number>();
  for (const v of abs) freq.set(v, (freq.get(v) ?? 0) + 1);
  let modalDelta = 0;
  let modalCount = 0;
  for (const [v, c] of freq) if (c > modalCount) [modalDelta, modalCount] = [v, c];
  const recent = ws.slice(-20);
  const dts: number[] = [];
  for (let i = 1; i < recent.length; i++) dts.push(recent[i]!.t - recent[i - 1]!.t);
  const sameDelta = ws.length >= 5 && ws.every((w) => w.mode === 0) && freq.size === 1 && modalDelta >= 100;
  let hardwareRatio: boolean | null = null;
  let cdpMismatch = 0;
  let otherTicks = 0;
  for (const w of ws) {
    if (w.wdy === null || w.dy === 0) continue;
    const ratio = Math.abs(w.wdy / w.dy);
    const hw = PLATFORM_WHEEL_RATIOS.some((r) => Math.abs(ratio - r) / r <= 0.02);
    hardwareRatio = (hardwareRatio ?? true) && hw;
    const ady = Math.abs(w.dy);
    if (Math.abs(w.wdy) === 120 && !hw && ady >= 200 && Math.abs(ady / 50 - Math.round(ady / 50)) < 1e-6) cdpMismatch++;
    if (Math.abs(w.wdy) !== 120 && w.wdy !== 0) otherTicks++;
  }
  return { n: ws.length, modalDelta, sameDelta, intervalCv: cv(dts), hardwareRatio, cdpMismatch, otherTicks };
}

// ───────────── session timing ─────────────

export interface Turn {
  start: number;
  end: number;
  /** First action of the turn is a trusted pointer click. */
  startsWithClick: boolean;
}

export interface ThinkFeatures {
  gaps: number[];
  thinkGaps: number;
  totalGaps: number;
  turns: Turn[];
}

export function turns(snap: Snapshot, clicks: readonly ClickFeature[], bursts: readonly ScrollBurst[]): Turn[] {
  const actions: { start: number; end: number; click: boolean }[] = [];
  for (const c of clicks) {
    if (!c.rec.trusted || c.rec.kind === 'derived') continue;
    const s = c.rec.downT ?? c.rec.t;
    if (s >= snap.segmentStart) actions.push({ start: s, end: c.rec.t, click: c.pointer });
  }
  let kb: { start: number; end: number; click: boolean } | null = null;
  for (const k of snap.keys) {
    if (!k.trusted || k.t < snap.segmentStart) continue;
    if (kb && k.t - kb.end < 1000) kb.end = k.t;
    else {
      kb = { start: k.t, end: k.t, click: false };
      actions.push(kb);
    }
  }
  for (const b of bursts) if (b.start >= snap.segmentStart) actions.push({ start: b.start, end: b.end, click: false });
  actions.sort((a, b) => a.start - b.start);
  const out: Turn[] = [];
  for (const a of actions) {
    const cur = out[out.length - 1];
    if (cur && a.start - cur.end <= 1000) cur.end = Math.max(cur.end, a.end);
    else out.push({ start: a.start, end: a.end, startsWithClick: a.click });
  }
  return out;
}

export function thinkFeatures(snap: Snapshot, ts: readonly Turn[]): ThinkFeatures {
  const moves = mouseMoves(snap.moves);
  const gaps: number[] = [];
  let thinkGaps = 0;
  for (let i = 1; i < ts.length; i++) {
    const a = ts[i - 1]!;
    const b = ts[i]!;
    const wall = b.start - a.end;
    const gap = visibleDuration(a.end, b.start, snap.hiddenSpans, snap.hiddenSince);
    if (gap < wall - 1) continue; // the clock was paused (hidden tab): not a think gap either way
    gaps.push(gap);
    // Exclude the 150 ms before the click: CDP/xdotool stacks move once just before pressing.
    if (gap >= 2500 && gap <= 60_000 && b.startsWithClick && countInRange(moves, a.end, b.start - 150) === 0) thinkGaps++;
  }
  return { gaps, thinkGaps, totalGaps: gaps.length, turns: [...ts] };
}

// ───────────── everything ─────────────

export interface Features {
  now: number;
  clicks: ClickFeature[];
  pointerClicks: ClickFeature[];
  recent: ClickFeature[];
  teleport: { recent: number; distinct: number; considered: number };
  linearCount: number;
  natural: { count: number; considered: number; ratio: number };
  centre: { recentHits: number; recentEligible: number; hits: number; eligible: number };
  lattice: LatticeResult | null;
  integerAtDpr: { n: number; integers: number } | null;
  timing: {
    fastDownUp: number;
    fastOverDown: number;
    downUpMedian: number;
    downUpStd: number;
    downUpN: number;
    keyIkiMedian: number;
    keyIkiN: number;
    identicalPairs: number;
    pressureHalfMovementZero: boolean;
    fineClock: boolean;
  };
  props: {
    downs: number;
    pressureZeroDowns: number;
    moves: number;
    movementZero: number;
    coalescedEmpty: number;
    coalescedKnown: number;
    screenSamples: number;
    screenEqClient: number;
  };
  typing: { groups: TypingGroup[]; metronomic: TypingGroup | null; pooled: TypingGroup | null };
  fills: FillEpisode[];
  untrusted: { clicks: number; keys: number; total: number; origins: Record<string, number> };
  scroll: { bursts: ScrollBurst[]; programmatic: number; events: number };
  wheel: WheelFeatures;
  think: ThinkFeatures;
  idle: { visibleMs: number; turns: number; idleMoves: number; pointerClicks: number };
  keyboard: { tabFocus: number; activations: number; pointerSamples: number };
  at: { possible: boolean; reasons: string[] };
  hiddenInputs: number;
  env: Snapshot['env'];
}

function pooledTyping(groups: readonly TypingGroup[]): TypingGroup | null {
  const ikis = groups.flatMap((g) => g.ikis);
  if (ikis.length === 0) return null;
  const dwells = groups.flatMap((g) => g.dwells);
  const roll = groups.filter((g) => Number.isFinite(g.rollover));
  return {
    field: -1,
    keydowns: groups.reduce((s, g) => s + g.keydowns, 0),
    ikis,
    ikiMedian: median(ikis),
    ikiCv: cv(ikis),
    dwells,
    dwellMedian: median(dwells),
    dwellCv: cv(dwells),
    rollover: roll.length ? mean(roll.map((g) => g.rollover)) : NaN,
    boundaryMedian: median(groups.map((g) => g.boundaryMedian).filter(Number.isFinite)),
    charMedian: median(groups.map((g) => g.charMedian).filter(Number.isFinite)),
  };
}

export function computeFeatures(input: Snapshot): Features {
  const snap = sortSnapshot(input);
  const clicks = clickFeatures(snap);
  const pointerClicks = clicks.filter((c) => c.pointer);
  const recent = pointerClicks.slice(-5);
  const teleports = recent.filter((c) => c.teleport);
  const distinct: { x: number; y: number }[] = [];
  for (const c of teleports) if (!distinct.some((d) => Math.hypot(d.x - c.rec.x, d.y - c.rec.y) <= ARRIVAL_RADIUS)) distinct.push({ x: c.rec.x, y: c.rec.y });
  const last10 = pointerClicks.slice(-10);
  const naturalCount = last10.filter((c) => c.natural).length;

  // Lattice samples: distinct press points and mouse move destinations (most recent 60).
  const mm = mouseMoves(snap.moves).filter((m) => m.trusted);
  const pts: { t: number; x: number; y: number; sx: number; sy: number }[] = [
    ...mm.map((m) => ({ t: m.t, x: m.x, y: m.y, sx: m.sx, sy: m.sy })),
    ...pointerClicks.map((c) => ({ t: c.rec.downT ?? c.rec.t, x: c.rec.x, y: c.rec.y, sx: c.rec.sx, sy: c.rec.sy })),
  ].sort((a, b) => a.t - b.t);
  const dedup: typeof pts = [];
  for (const p of pts) {
    const prev = dedup[dedup.length - 1];
    if (!prev || prev.x !== p.x || prev.y !== p.y) dedup.push(p);
  }
  const latticePts = dedup.slice(-100);
  const lattice = latticeTest(latticePts, snap.env.dpr);
  let integerAtDpr: Features['integerAtDpr'] = null;
  if (snap.env.chromium && Math.abs(snap.env.dpr - Math.round(snap.env.dpr)) > 1e-3) {
    const sample = latticePts.slice(-40);
    integerAtDpr = { n: sample.length, integers: sample.filter((p) => Number.isInteger(p.x) && Number.isInteger(p.y)).length };
  }

  const durations = pointerClicks.map((c) => c.downUpMs).filter((v): v is number => v !== null);
  const recentDur = durations.slice(-10);
  const groups = typingGroups(snap.keys);
  const keyGroups = groups.filter((g) => g.keydowns >= 6);
  const fastKeys = keyGroups.reduce<TypingGroup | null>((best, g) => (!best || g.ikiMedian < best.ikiMedian ? g : best), null);
  const allTimes = [...mm.map((m) => m.t), ...snap.keys.map((k) => k.t), ...pointerClicks.map((c) => c.rec.downT ?? c.rec.t)];
  const fine = fineClock(allTimes);
  const downs = pointerClicks.filter((c) => c.rec.pressure !== null);
  const trustedMoves = mm;
  const pressureHalfMovementZero =
    downs.length >= 2 && downs.every((c) => c.rec.pressure === 0.5) && trustedMoves.length >= 3 && trustedMoves.every((m) => m.mx === 0 && m.my === 0);

  const metronomic = groups.find((g) => g.keydowns >= 8 && g.ikis.length >= 7 && g.ikiCv < 0.08 && g.ikiMedian >= 5 && g.ikiMedian <= 120) ?? null;
  const fills = fillEpisodes(snap);

  // Untrusted clicks/keys: exclude site-originated dispatches, reactions to trusted input within 50 ms
  // (frameworks forwarding a user's click), password-manager trains and credential fields.
  const trustedInputs: { t: number }[] = [];
  for (const c of snap.clicks) {
    if (!c.trusted) continue;
    trustedInputs.push({ t: c.t });
    if (c.downT !== null) trustedInputs.push({ t: c.downT });
    if (c.upT !== null) trustedInputs.push({ t: c.upT });
  }
  for (const k of snap.keys) if (k.trusted) trustedInputs.push({ t: k.t });
  trustedInputs.sort((a, b) => a.t - b.t);
  const reaction = (t: number): boolean => {
    const i = lastIndexAtOrBefore(trustedInputs, t);
    return i >= 0 && t - trustedInputs[i]!.t <= 50;
  };
  const pmFills = fills.filter((f) => f.cls === 'password-manager' || f.cls === 'credential-untrusted');
  const nearPm = (t: number, field: number): boolean => pmFills.some((f) => (field === 0 || f.field === field) && Math.abs(f.t - t) <= 1500);
  const origins: Record<string, number> = {};
  let uClicks = 0;
  let uKeys = 0;
  for (const c of snap.clicks) {
    if (c.trusted || c.origin === 'site' || reaction(c.t)) continue;
    if (c.onField && (snap.pmMarkersPresent || nearPm(c.t, 0))) continue;
    uClicks++;
    origins[c.origin ?? 'unknown'] = (origins[c.origin ?? 'unknown'] ?? 0) + 1;
  }
  for (const k of snap.keys) {
    if (k.trusted || k.origin === 'site' || reaction(k.t)) continue;
    if (k.field !== 0 && (snap.pmMarkersPresent || nearPm(k.t, k.field))) continue;
    uKeys++;
    origins[k.origin ?? 'unknown'] = (origins[k.origin ?? 'unknown'] ?? 0) + 1;
  }

  const bursts = scrollBursts(snap);
  const ts = turns(snap, clicks, bursts);
  const think = thinkFeatures(snap, ts);

  // Idle motion: mouse moves outside click windows (approach window through 50 ms after release).
  const windows = clickWindows(pointerClicks);
  const segMoves = mouseMoves(snap.moves).filter((m) => m.t >= snap.segmentStart);
  const idleMoves = segMoves.filter((m) => !inIntervals(windows, m.t)).length;
  const visibleMs = visibleDuration(snap.segmentStart, snap.now, snap.hiddenSpans, snap.hiddenSince);

  // Keyboard-only navigation.
  const tabFocus = snap.focuses.filter((f) => f.viaTab && f.t >= snap.segmentStart).length;
  const activations =
    snap.keys.filter((k) => k.trusted && (k.cls === 'enter' || k.cls === 'space') && k.t >= snap.segmentStart).length +
    snap.clicks.filter((c) => c.kind === 'keyboard').length;
  const pointerSamples = segMoves.length + pointerClicks.length;

  // AT-possible (spec §0, research §12, false-positive-traps §3.1).
  const reasons: string[] = [];
  if (tabFocus >= 5 && activations >= 1 && pointerSamples === 0) reasons.push('keyboard-only');
  if (pointerClicks.some((c) => c.rec.sourceCaps === 'null')) reasons.push('source-capabilities-null');
  if (pointerClicks.some((c) => c.rec.mdDetail === 0)) reasons.push('mousedown-detail-0');
  if (pointerClicks.some((c) => c.rec.focusBeforeDown && c.teleport)) reasons.push('focus-before-pointerdown');
  if (snap.clicks.some((c) => c.kind === 'sr')) reasons.push('click-without-press-or-key');
  if (clicks.some((c) => c.returnJump && (c.returnToPrev || tabFocus >= 1))) reasons.push('pointer-jump-back');

  return {
    now: snap.now,
    clicks,
    pointerClicks,
    recent,
    teleport: { recent: teleports.length, distinct: distinct.length, considered: recent.length },
    linearCount: pointerClicks.slice(-10).filter((c) => c.linear).length,
    natural: { count: naturalCount, considered: last10.length, ratio: last10.length ? naturalCount / last10.length : 0 },
    centre: {
      recentHits: recent.filter((c) => c.centreHit && c.movesBefore <= 2).length,
      recentEligible: recent.filter((c) => c.centreEligible).length,
      hits: pointerClicks.filter((c) => c.centreHit).length,
      eligible: pointerClicks.filter((c) => c.centreEligible).length,
    },
    lattice,
    integerAtDpr,
    timing: {
      fastDownUp: pointerClicks.filter((c) => c.downUpMs !== null && c.downUpMs < 15).length,
      fastOverDown: pointerClicks.filter((c) => c.overDownMs !== null && c.overDownMs < 15 && c.movesBefore <= 1).length,
      downUpMedian: median(recentDur),
      downUpStd: std(recentDur),
      downUpN: recentDur.length,
      keyIkiMedian: fastKeys ? fastKeys.ikiMedian : NaN,
      keyIkiN: fastKeys ? fastKeys.keydowns : 0,
      identicalPairs: identicalKeyPairs(snap.keys),
      pressureHalfMovementZero,
      fineClock: fine,
    },
    props: {
      downs: downs.length,
      pressureZeroDowns: downs.filter((c) => c.rec.pressure === 0 && (c.rec.buttons ?? 1) === 1).length,
      moves: trustedMoves.length,
      movementZero: trustedMoves.filter((m) => m.mx === 0 && m.my === 0).length,
      coalescedEmpty: trustedMoves.filter((m) => m.coalesced === 0).length,
      coalescedKnown: trustedMoves.filter((m) => m.coalesced >= 0).length,
      screenSamples: trustedMoves.length + pointerClicks.length,
      screenEqClient:
        trustedMoves.filter((m) => m.sx === m.x && m.sy === m.y).length + pointerClicks.filter((c) => c.rec.sx === c.rec.x && c.rec.sy === c.rec.y).length,
    },
    typing: { groups, metronomic, pooled: pooledTyping(groups) },
    fills,
    untrusted: { clicks: uClicks, keys: uKeys, total: uClicks + uKeys, origins },
    scroll: { bursts, programmatic: bursts.filter((b) => b.programmatic).length, events: snap.scrolls.length },
    wheel: wheelFeatures(snap),
    think,
    idle: { visibleMs, turns: ts.length, idleMoves, pointerClicks: pointerClicks.length },
    keyboard: { tabFocus, activations, pointerSamples },
    at: { possible: reasons.length > 0, reasons },
    hiddenInputs: snap.hiddenTrustedInputs,
    env: snap.env,
  };
}

export { round as roundTo };
