import type { InteractionSummary } from '@necterai/core';
import { clickWindows, cv, inIntervals, mean, median, quantile, roundTo, typingGroups, type Features } from './features.js';
import type { Snapshot } from './records.js';

/** Raw samples attached only when `options.rawSamples` is true (coordinates are personal data). */
export interface RawSamples {
  /** [t, x, y] of pointermoves (capped). */
  moves: [number, number, number][];
  /** [t, x, y, downUpMs] of clicks. */
  clicks: [number, number, number, number | null][];
  /** [t, keyClass] of keydowns: classes only, never key identities. */
  keys: [number, string][];
}

export type InteractionSummaryWithRaw = InteractionSummary & { raw?: RawSamples };

export interface SummaryOptions {
  /** Window start (exclusive). */
  from: number;
  firstInteraction: number | null;
  hasFocus: boolean;
  visible: boolean;
  rawSamples: boolean;
}

const RAW_CAP = 500;
const num = (v: number, digits = 3): number => (Number.isFinite(v) ? roundTo(v, digits) : 0);

/**
 * Aggregate, coordinate-free summary of the window (from, now]. Session-level
 * estimates (lattice spacing) come from the full feature set.
 */
export function buildSummary(snap: Snapshot, f: Features, o: SummaryOptions): InteractionSummaryWithRaw {
  const inWin = (t: number): boolean => t > o.from && t <= snap.now;
  const moves = snap.moves.filter((m) => inWin(m.t));
  const clicks = f.clicks.filter((c) => inWin(c.rec.t));
  const pointer = clicks.filter((c) => c.pointer);
  const eligible = pointer.filter((c) => c.centreEligible);
  const lin = pointer.map((c) => c.path.linearity).filter((v): v is number => v !== null);
  const hovers = pointer.map((c) => c.hoverMs).filter((v): v is number => v !== null);
  const coords = [...moves.map((m) => [m.x, m.y] as const), ...pointer.map((c) => [c.rec.x, c.rec.y] as const)];
  const keys = snap.keys.filter((k) => inWin(k.t));
  const wheels = snap.wheels.filter((w) => inWin(w.t));
  const freq = new Map<number, number>();
  for (const w of wheels) if (w.dy !== 0) freq.set(Math.abs(w.dy), (freq.get(Math.abs(w.dy)) ?? 0) + 1);
  let modal = 0;
  let modalN = 0;
  for (const [v, n] of freq) if (n > modalN) [modal, modalN] = [v, n];
  const turns = f.think.turns.filter((t) => inWin(t.start));
  const gaps: number[] = [];
  for (let i = 1; i < turns.length; i++) gaps.push(turns[i]!.start - turns[i - 1]!.end);
  const windows = clickWindows(f.pointerClicks);
  const idleMoves = moves.filter((m) => !inIntervals(windows, m.t)).length;
  const ikis = typingGroups(keys).flatMap((g) => g.ikis);
  const lattice = f.lattice ? f.lattice.stride : f.integerAtDpr && f.integerAtDpr.n >= 12 && f.integerAtDpr.integers === f.integerAtDpr.n ? 1 : 0;

  const summary: InteractionSummaryWithRaw = {
    windowMs: num(snap.now - o.from, 0),
    pointer: {
      moves: moves.length,
      clicks: clicks.length,
      centerClickRatio: eligible.length ? num(eligible.filter((c) => c.centreHit).length / eligible.length) : 0,
      meanPathLinearity: lin.length ? num(mean(lin)) : 0,
      meanMovesBeforeClick: pointer.length ? num(mean(pointer.map((c) => c.moves500)), 2) : 0,
      medianHoverMs: hovers.length ? num(median(hovers), 1) : 0,
      integerCoordRatio: coords.length ? num(coords.filter(([x, y]) => Number.isInteger(x) && Number.isInteger(y)).length / coords.length) : 0,
      latticeSpacing: num(lattice, 4),
      trustedRatio: clicks.length ? num(clicks.filter((c) => c.rec.trusted).length / clicks.length) : 1,
    },
    keyboard: {
      keydowns: keys.length,
      inputsWithoutKeys: f.fills.filter((e) => inWin(e.t) && e.cls !== 'typed').length,
      interKeyCv: num(cv(ikis)),
      pastes: snap.pastes.filter(inWin).length,
    },
    scroll: {
      wheelEvents: wheels.length,
      scrollEvents: snap.scrolls.filter((s) => inWin(s.t)).length,
      programmaticScrolls: f.scroll.bursts.filter((b) => b.programmatic && inWin(b.start)).length,
      modalDelta: num(modal, 2),
    },
    timing: {
      firstInteractionMs: o.firstInteraction !== null ? num(o.firstInteraction, 0) : -1,
      gapP50: gaps.length ? num(quantile(gaps, 0.5), 0) : 0,
      gapP90: gaps.length ? num(quantile(gaps, 0.9), 0) : 0,
      idleMoves,
    },
    focus: { hasFocus: o.hasFocus, visible: o.visible },
  };
  if (o.rawSamples) {
    summary.raw = {
      moves: moves.slice(-RAW_CAP).map((m) => [num(m.t, 1), m.x, m.y]),
      clicks: clicks.slice(-RAW_CAP).map((c) => [num(c.rec.t, 1), c.rec.x, c.rec.y, c.downUpMs === null ? null : num(c.downUpMs, 1)]),
      keys: keys.slice(-RAW_CAP).map((k) => [num(k.t, 1), k.cls]),
    };
  }
  return summary;
}
