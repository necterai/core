import { median, roundTo as r, type ClickFeature, type Features } from './features.js';

/**
 * Map features to catalog signals (packages/core/src/catalog.ts, `beh.*` and
 * `extension.hidden-tab-input`). Pure: the module applies the decisions with
 * ctx.emit / ctx.retract.
 *
 * Thresholds are the spec §3 values except where the research gives a better
 * number (each deviation is commented with its source).
 */

export interface Decision {
  id: string;
  active: boolean;
  /**
   * Dispatch-level evidence that stays once observed (it does not stop being
   * true when the sample window slides). Non-latched decisions are hypotheses
   * over recent behaviour and are retracted when they no longer hold.
   */
  latch?: boolean;
  summary: string;
  value?: unknown;
  reliability?: number;
  details?: Record<string, unknown>;
}

/** Signals suppressed (and retracted) while the session looks AT-possible (spec §0, research §12.2). */
export const AT_SUPPRESSED: readonly string[] = [
  'beh.no-pointer-path',
  'beh.center-clicks',
  'beh.robotic-input-timing',
  'beh.coordinate-lattice',
  // Additionally (research §12.2: screen readers scroll without input events and users read with no pointer):
  'beh.llm-think-time',
  'beh.no-idle-motion',
  'beh.programmatic-scroll',
];

/** Ids this module never retracts (other modules emit them too, or they are session classes). */
export const NEVER_RETRACT: ReadonlySet<string> = new Set(['beh.human-input-evidence', 'extension.hidden-tab-input', 'beh.at-possible']);

const step = (n: number, table: readonly [number, number][]): number => {
  let v = 0;
  for (const [min, rel] of table) if (n >= min) v = rel;
  return v;
};

function list(values: readonly (number | null)[], digits = 1): string {
  return values.map((v) => (v === null || !Number.isFinite(v) ? '-' : String(r(v, digits)))).join('/');
}

function profileForIki(ms: number): string {
  if (ms < 5) return 'cdp-back-to-back';
  if (ms >= 9 && ms <= 15) return 'xdotool-type-delay-12';
  if (ms >= 40 && ms <= 60) return 'playwright-delay-50';
  if (ms < 9) return 'fixed-short-delay';
  return 'fixed-delay';
}

export function decide(f: Features): Decision[] {
  const at = f.at.possible;
  const out: Decision[] = [];

  // ── session classes ──
  out.push({
    id: 'beh.at-possible',
    active: at,
    latch: true,
    summary: `Assistive-technology-possible session (${f.at.reasons.join(', ')}); pointer-kinematics signals suppressed.`,
    value: f.at.reasons,
  });
  out.push({
    id: 'beh.keyboard-only',
    active: f.at.reasons.includes('keyboard-only'),
    summary: `${f.keyboard.tabFocus} Tab focus moves and ${f.keyboard.activations} Enter/Space activations with no pointer samples.`,
    value: f.keyboard.tabFocus,
  });

  // ── pointer path ──
  const recentMoves = f.recent.map((c) => c.movesBefore);
  out.push({
    id: 'beh.no-pointer-path',
    // Spec: movesBefore <= 1 on >= 3 of the last 5 pointer clicks. The 600 ms window is anchored at the
    // pointer's arrival within 24 px of the press point, and teleports must land in >= 3 distinct places:
    // on the Balabit sessions a press-anchored window fired on 3-33 % of 5-click windows (people dwell
    // and re-click without moving); the arrival-anchored one with 3 distinct positions fires on none of the
    // 5,414 click windows (the residue was a remote-desktop gap: one sample, then three clicks in place).
    active: !at && f.teleport.recent >= 3 && f.teleport.distinct >= 3,
    summary: `${f.teleport.recent} of the last ${f.teleport.considered} clicks had at most one pointermove before the press (moves ${recentMoves.join('/')}).`,
    value: f.teleport.recent,
    reliability: step(f.teleport.recent, [
      [3, 0.6],
      [4, 0.8],
      [5, 1],
    ]),
    details: { movesBefore: recentMoves },
  });
  const linear = f.pointerClicks.slice(-10).filter((c) => c.linear);
  out.push({
    id: 'beh.linear-pointer-path',
    active: f.linearCount >= 2,
    summary: `${f.linearCount} clicks approached on straight, evenly spaced paths (linearity ${list(linear.map((c) => c.approach.linearity), 4)}, step CV ${list(linear.map((c) => c.approach.stepCv), 3)}).`,
    value: f.linearCount,
    reliability: f.linearCount >= 3 ? 1 : 0.7,
  });
  const nat = f.pointerClicks.slice(-10).filter((c) => c.natural);
  out.push({
    id: 'beh.natural-pointer',
    active: f.natural.count >= 3 && f.natural.ratio >= 0.3,
    summary: `${f.natural.count} of the last ${f.natural.considered} clicks had human approach paths (median ${median(nat.map((c) => c.moves2s))} moves, linearity ${r(median(nat.map((c) => c.path.linearity ?? NaN)), 2)}, hover ${r(median(nat.map((c) => c.hoverMs ?? NaN)), 0)} ms).`,
    value: f.natural.count,
    reliability: step(f.natural.count, [
      [3, 0.6],
      [4, 0.8],
      [5, 1],
    ]),
  });

  // ── click geometry ──
  const centred = f.recent.filter((c) => c.centreHit && c.movesBefore <= 2);
  out.push({
    id: 'beh.center-clicks',
    active: !at && f.centre.recentHits >= 3,
    summary: `${f.centre.recentHits} of the last ${f.recent.length} clicks landed within 1 px of the target centre with no approach path (offsets ${centred.map((c) => `${r(c.rec.geometry!.dx, 1)},${r(c.rec.geometry!.dy, 1)}`).join(' ')}).`,
    value: f.centre.recentHits,
    reliability: step(f.centre.recentHits, [
      [3, 0.6],
      [4, 0.8],
      [5, 1],
    ]),
  });
  const lat = f.lattice;
  const intDpr = f.integerAtDpr;
  const intLattice = !!intDpr && intDpr.n >= 12 && intDpr.integers === intDpr.n;
  out.push({
    id: 'beh.coordinate-lattice',
    active: !at && (!!lat || intLattice),
    summary: lat
      ? `${lat.hits} of ${lat.n} pointer positions fall on a ${lat.mapping}(k×${r(lat.stride, 4)}) lattice in ${lat.frame} coordinates (chance p=${lat.p.toExponential(1)}).`
      : `All ${intDpr?.n ?? 0} pointer coordinates are integers at devicePixelRatio ${f.env.dpr}.`,
    value: lat ? r(lat.stride, 4) : 1,
    // 0.7 at the LATTICE_MAX_P bound (1e-5), 1.0 at p <= 1e-8.
    reliability: lat ? r(0.7 + 0.3 * Math.min(1, Math.max(0, (-5 - Math.log10(Math.max(lat.p, 1e-300))) / 3)), 2) : 0.7,
    details: lat ? { frame: lat.frame, mapping: lat.mapping, n: lat.n, p: lat.p } : { route: 'integer-at-fractional-dpr', n: intDpr?.n },
  });

  // ── dispatch micro-timing ──
  const t = f.timing;
  const criteria: string[] = [];
  if (t.fastDownUp >= 2) criteria.push(`down→up <15 ms on ${t.fastDownUp} clicks`);
  if (t.fastOverDown >= 2) criteria.push(`over→down <15 ms without approach on ${t.fastOverDown} clicks`);
  if (t.keyIkiN >= 6 && t.keyIkiMedian < 10) criteria.push(`median inter-key ${r(t.keyIkiMedian, 1)} ms over ${t.keyIkiN} keys`);
  if (t.fineClock && t.identicalPairs >= 1) criteria.push(`${t.identicalPairs} distinct-key pairs sharing a timeStamp`);
  if (t.pressureHalfMovementZero) criteria.push('pressure 0.5 on every press with movementX/Y always 0');
  // Research §4.3 / arXiv 2607.26935: click_dur_std < 5 ms over >= 5 clicks (Browser Use's fixed 80 ms press).
  if (t.fineClock && t.downUpN >= 5 && t.downUpStd < 5) criteria.push(`press duration ${r(t.downUpMedian, 1)}±${r(t.downUpStd, 1)} ms over ${t.downUpN} clicks`);
  const durs = f.pointerClicks.slice(-5).map((c: ClickFeature) => c.downUpMs);
  out.push({
    id: 'beh.robotic-input-timing',
    active: !at && criteria.length >= 2,
    latch: true,
    summary: `Driver input timing: ${criteria.join('; ')}.`,
    value: criteria.length,
    reliability: criteria.length >= 3 ? 1 : 0.8,
    details: {
      criteria,
      downUpMs: durs,
      ...(Number.isFinite(t.keyIkiMedian) ? { keyProfile: profileForIki(t.keyIkiMedian) } : {}),
    },
  });

  const p = f.props;
  const synth: string[] = [];
  const atShape = f.at.reasons.includes('source-capabilities-null') || f.at.reasons.includes('mousedown-detail-0');
  if (!at && !atShape && p.downs >= 2 && p.pressureZeroDowns === p.downs) synth.push(`pressure 0 on ${p.downs} mouse presses`);
  if (p.moves >= 20 && p.movementZero === p.moves) synth.push(`movementX/Y 0 on all ${p.moves} moves`);
  if (f.env.chromium && p.coalescedKnown >= 20 && p.coalescedEmpty === p.coalescedKnown) synth.push(`getCoalescedEvents() empty on all ${p.coalescedKnown} moves`);
  if (f.env.windowed && p.screenSamples >= 3 && p.screenEqClient === p.screenSamples) synth.push(`screenX/Y equal clientX/Y on ${p.screenSamples} events in a windowed browser`);
  out.push({
    id: 'beh.synthetic-event-properties',
    active: synth.length > 0,
    latch: true,
    summary: `Synthetic pointer properties: ${synth.join('; ')}.`,
    value: synth.length,
    reliability: synth.length === 1 && synth[0]!.startsWith('pressure') && p.downs < 4 ? 0.7 : 1,
  });

  // ── trust ──
  out.push({
    id: 'beh.untrusted-input',
    active: f.untrusted.total >= 1,
    latch: true,
    summary: `${f.untrusted.clicks} clicks and ${f.untrusted.keys} keydowns arrived with isTrusted=false from non-site code.`,
    value: f.untrusted.total,
    reliability: step(f.untrusted.total, [
      [1, 0.6],
      [2, 0.8],
      [3, 1],
    ]),
    details: { origins: f.untrusted.origins },
  });

  // ── form fills ──
  const agentFills = f.fills.filter((e) => e.cls === 'agent-fill');
  const humanFills = f.fills.filter((e) => e.cls === 'autofill' || e.cls === 'password-manager');
  const untrustedFills = f.fills.filter((e) => e.cls === 'untrusted-form-fill');
  const selectBoost = agentFills.some((e) => e.selectBefore) ? 0.25 : 0;
  out.push({
    id: 'beh.instant-fill',
    active: agentFills.length >= 1,
    latch: true,
    summary: `${agentFills.length} fields received whole values (${agentFills.map((e) => e.delta).join('/')} chars) in one trusted input with no keydown (inputType ${[...new Set(agentFills.map((e) => e.inputType || '""'))].join('/')}).`,
    value: agentFills.length,
    reliability: Math.min(1, 0.5 + 0.25 * (agentFills.length - 1) + selectBoost),
  });
  out.push({
    id: 'beh.human-input-evidence',
    active: humanFills.length >= 1,
    latch: true,
    summary: `${humanFills.length} fields were filled by browser autofill or a password manager (${[...new Set(humanFills.map((e) => e.cls))].join(', ')}).`,
    value: humanFills.length,
    details: { kinds: humanFills.map((e) => e.cls) },
  });
  out.push({
    id: 'beh.untrusted-form-fill',
    active: untrustedFills.length >= 1,
    latch: true,
    summary: `${untrustedFills.length} fields were set by untrusted plain input/change events right after a trusted focus, with no keys.`,
    value: untrustedFills.length,
    reliability: Math.min(1, 0.6 + 0.2 * (untrustedFills.length - 1)),
  });

  // ── typing ──
  const met = f.typing.metronomic;
  out.push({
    id: 'beh.metronomic-typing',
    active: !!met,
    latch: true,
    summary: met ? `${met.keydowns} keys typed at a constant ${r(met.ikiMedian, 1)} ms interval (CV ${r(met.ikiCv, 3)}).` : '',
    value: met ? r(met.ikiMedian, 1) : undefined,
    details: met ? { profile: profileForIki(met.ikiMedian), cv: r(met.ikiCv, 3), dwellMedian: r(met.dwellMedian, 1) } : undefined,
  });
  const pooled = f.typing.pooled;
  const digraphOk = !pooled || !Number.isFinite(pooled.boundaryMedian) || !Number.isFinite(pooled.charMedian) || pooled.boundaryMedian >= 0.9 * pooled.charMedian;
  const keyRobotic = t.keyIkiN >= 6 && t.keyIkiMedian < 10;
  const naturalTyping =
    !!pooled &&
    !met &&
    !keyRobotic &&
    pooled.keydowns >= 8 &&
    pooled.ikis.length >= 7 &&
    pooled.ikiCv > 0.3 &&
    pooled.dwells.length >= 5 &&
    pooled.dwellMedian >= 40 &&
    pooled.dwellMedian <= 200 &&
    digraphOk;
  out.push({
    id: 'beh.natural-typing',
    active: naturalTyping,
    summary: pooled
      ? `${pooled.keydowns} keys with human timing (inter-key median ${r(pooled.ikiMedian, 0)} ms, CV ${r(pooled.ikiCv, 2)}, hold ${r(pooled.dwellMedian, 0)} ms, rollover ${r(pooled.rollover * 100, 0)} %).`
      : '',
    value: pooled ? r(pooled.ikiCv, 2) : undefined,
  });

  // ── scroll ──
  const sc = f.scroll;
  const settled = sc.bursts.length;
  const frac = settled ? sc.programmatic / settled : 0;
  out.push({
    id: 'beh.programmatic-scroll',
    active: !at && sc.programmatic >= 1 && f.keyboard.pointerSamples > 0,
    latch: true,
    summary: `${sc.programmatic} of ${settled} scroll bursts had no wheel/touch/key/pointer/focus/navigation cause within 150 ms.`,
    value: sc.programmatic,
    reliability: r(Math.min(1, 0.5 * sc.programmatic) * (frac >= 0.5 ? 1 : 0.6), 2),
  });
  const w = f.wheel;
  // Spec rule: >= 5 wheels with one |deltaY| >= 100. Windows notched wheels produce a constant 100 px at
  // wheelDeltaY 120 (ratio 1.2) and X11 120/120, so a constant delta only counts when the wheelDelta ratio
  // is not a hardware ratio, the cadence is timer-regular (xdotool click --repeat: 100 ms), or the ratio is
  // unknown (reliability 0.5). Research §7.1-7.2.
  let wheelRel = 0;
  let wheelWhy = '';
  if (w.sameDelta) {
    if (w.hardwareRatio === false) [wheelRel, wheelWhy] = [1, 'non-hardware wheelDelta ratio'];
    else if (Number.isFinite(w.intervalCv) && w.intervalCv < 0.1) [wheelRel, wheelWhy] = [0.8, `timer cadence (interval CV ${r(w.intervalCv, 3)})`];
    else if (w.hardwareRatio === null) [wheelRel, wheelWhy] = [0.5, 'wheelDelta unavailable'];
  }
  if (w.cdpMismatch >= 2 && w.otherTicks === 0) {
    const rel = w.cdpMismatch >= 3 ? 1 : 0.7;
    if (rel > wheelRel) [wheelRel, wheelWhy] = [rel, `${w.cdpMismatch} wheels with wheelDeltaY ±120 for a round deltaY (CDP mouseWheel)`];
  }
  out.push({
    id: 'beh.quantised-wheel',
    active: wheelRel > 0,
    latch: true,
    summary: `${w.n} wheel events, modal |deltaY| ${w.modalDelta} px: ${wheelWhy}.`,
    value: w.modalDelta,
    reliability: wheelRel,
  });

  // ── session timing ──
  const th = f.think;
  out.push({
    id: 'beh.llm-think-time',
    active: !at && th.thinkGaps >= 3 && th.totalGaps > 0 && th.thinkGaps / th.totalGaps >= 0.6,
    latch: true,
    summary: `${th.thinkGaps} of ${th.totalGaps} inter-action gaps were 2.5-60 s with no pointer movement before a click (median gap ${r(median(th.gaps) / 1000, 1)} s).`,
    value: th.thinkGaps,
    reliability: step(th.thinkGaps, [
      [3, 0.6],
      [4, 0.8],
      [5, 1],
    ]),
  });
  const idle = f.idle;
  out.push({
    id: 'beh.no-idle-motion',
    active: !at && f.env.finePointer && idle.visibleMs >= 20_000 && idle.turns >= 2 && idle.pointerClicks >= 1 && idle.idleMoves < 3,
    summary: `${idle.idleMoves} pointermoves outside click windows in ${r(idle.visibleMs / 1000, 0)} s visible with ${idle.turns} actions.`,
    value: idle.idleMoves,
  });

  // ── hidden tab ──
  out.push({
    id: 'extension.hidden-tab-input',
    active: f.hiddenInputs >= 2,
    latch: true,
    summary: `${f.hiddenInputs} trusted pointer/keyboard events arrived while the document was hidden.`,
    value: f.hiddenInputs,
  });

  // AT gating: suppressed ids are forced inactive (the module retracts them).
  if (at) for (const d of out) if (AT_SUPPRESSED.includes(d.id)) d.active = false;
  return out;
}
