import { describe, expect, it } from 'vitest';
import {
  binomTail,
  classifyStack,
  computeFeatures,
  decide,
  fineClock,
  latticeTest,
  pathStats,
  typingGroups,
  visibleDuration,
  wheelFeatures,
  type KeyRecord,
  type Snapshot,
} from '../src/behavior/index.js';

function snapshot(over: Partial<Snapshot> = {}): Snapshot {
  return {
    now: 60_000,
    moves: [],
    clicks: [],
    keys: [],
    inputs: [],
    wheels: [],
    scrolls: [],
    causes: [],
    focuses: [],
    pastes: [],
    compositions: [],
    selects: [],
    hiddenSpans: [],
    hiddenSince: null,
    segmentStart: 0,
    loadT: 0,
    hiddenTrustedInputs: 0,
    pmMarkersPresent: false,
    env: { chromium: false, dpr: 1, finePointer: true, sourceCapsSupported: true, windowed: false },
    ...over,
  };
}

let seed = 7;
const rand = (): number => {
  seed = (seed * 1103515245 + 12345) % 2 ** 31;
  return seed / 2 ** 31;
};

describe('pathStats', () => {
  it('scores an interpolated straight path as linear with even steps', () => {
    const pts = Array.from({ length: 10 }, (_, i) => ({ t: i * 2, x: 10 + i * 30, y: 20 + i * 15 }));
    const p = pathStats(pts);
    expect(p.linearity).toBeCloseTo(1, 6);
    expect(p.stepCv).toBeCloseTo(0, 6);
  });

  it('scores a curved, accelerating human-like path as non-linear with a mid-path speed peak', () => {
    const pts = Array.from({ length: 20 }, (_, i) => {
      const u = i / 19;
      const s = (1 - Math.cos(Math.PI * u)) / 2; // bell-shaped speed
      return { t: i * 16 + (i % 3), x: 400 * s, y: 120 * Math.sin(Math.PI * s) };
    });
    const p = pathStats(pts);
    expect(p.linearity!).toBeGreaterThan(0.6);
    expect(p.linearity!).toBeLessThan(0.98);
    expect(p.peakPos!).toBeGreaterThan(0.2);
    expect(p.peakPos!).toBeLessThan(0.7);
    expect(p.stepCv!).toBeGreaterThan(0.2);
  });

  it('returns nulls for fewer than three samples', () => {
    expect(pathStats([{ t: 0, x: 0, y: 0 }]).linearity).toBeNull();
  });
});

describe('latticeTest', () => {
  it('finds nothing in uniformly random human integer coordinates', () => {
    seed = 3;
    for (let run = 0; run < 20; run++) {
      const pts = Array.from({ length: 100 }, () => {
        const x = Math.floor(rand() * 1900);
        const y = Math.floor(rand() * 1000);
        return { x, y, sx: x, sy: y + 85 };
      });
      expect(latticeTest(pts, 1)).toBeNull();
    }
  });

  it('finds a Gemini 0-999 grid (floor(k × 1.92)) in client coordinates', () => {
    seed = 11;
    const pts = Array.from({ length: 30 }, () => {
      const x = Math.floor(Math.floor(rand() * 1000) * 1.92);
      const y = Math.floor(Math.floor(rand() * 560) * 1.92);
      return { x, y, sx: x + 7, sy: y + 85 };
    });
    const r = latticeTest(pts, 1);
    expect(r?.stride).toBe(1.92);
    expect(r?.mapping).toBe('floor');
    expect(r?.frame).toBe('client');
  });

  it('needs enough samples for weak strides', () => {
    const pts = Array.from({ length: 10 }, (_, i) => ({ x: Math.round(i * 37 * 1.5), y: Math.round(i * 11 * 1.5), sx: 0, sy: 0 }));
    expect(latticeTest(pts, 1)).toBeNull(); // 10 points at stride 1.5 cannot beat the corrected bound
  });

  it('binomTail matches closed forms', () => {
    expect(binomTail(10, 10, 0.5)).toBeCloseTo(1 / 1024, 10);
    expect(binomTail(10, 0, 0.3)).toBe(1);
    expect(binomTail(3, 2, 0.5)).toBeCloseTo(0.5, 10);
  });
});

describe('typing statistics', () => {
  const keys = (downs: number[], dwell: number, field = 1): KeyRecord[] =>
    downs.map((t, i) => ({ t, up: t + dwell, code: `Key${String.fromCharCode(65 + (i % 26))}`, cls: 'char', trusted: true, repeat: false, field, hidden: false }));

  it('computes inter-key CV, dwell and rollover per field', () => {
    const g = typingGroups([...keys([0, 100, 250, 330, 520], 90), ...keys([5000, 5012, 5024], 6, 2)]);
    const a = g.find((x) => x.field === 1)!;
    expect(a.ikis).toEqual([100, 150, 80, 190]);
    expect(a.dwellMedian).toBe(90);
    expect(a.rollover).toBeCloseTo(1 / 4, 6); // 250 → 330 overlaps (250 + 90 > 330)
    expect(g.find((x) => x.field === 2)!.ikiCv).toBeCloseTo(0, 6);
  });

  it('metronomic typing fires for 12 ms cadence but not for human variance', () => {
    const robot = computeFeatures(snapshot({ keys: keys(Array.from({ length: 12 }, (_, i) => 1000 + i * 12), 6) }));
    expect(decide(robot).find((d) => d.id === 'beh.metronomic-typing')?.active).toBe(true);
    seed = 5;
    let t = 1000;
    const human = keys(Array.from({ length: 30 }, () => (t += 120 + rand() * 250)), 90);
    const f = computeFeatures(snapshot({ keys: human }));
    const d = decide(f);
    expect(d.find((x) => x.id === 'beh.metronomic-typing')?.active).toBe(false);
    expect(d.find((x) => x.id === 'beh.natural-typing')?.active).toBe(true);
  });

  it('fineClock distinguishes 0.1 ms clocks from millisecond rounding', () => {
    expect(fineClock(Array.from({ length: 20 }, (_, i) => 1000 + i * 12.3))).toBe(true);
    expect(fineClock(Array.from({ length: 20 }, (_, i) => 1000 + i * 12))).toBe(false);
  });
});

describe('wheel features', () => {
  it('flags CDP wheelDelta ±120 for round deltas and accepts hardware ratios', () => {
    const cdp = wheelFeatures(snapshot({ wheels: [1, 2, 3].map((i) => ({ t: i * 700, dx: 0, dy: 300, mode: 0, wdy: -120, trusted: true })) }));
    expect(cdp.cdpMismatch).toBe(3);
    expect(cdp.hardwareRatio).toBe(false);
    const win = wheelFeatures(snapshot({ wheels: [1, 2, 3].map((i) => ({ t: i * 90, dx: 0, dy: 200, mode: 0, wdy: -240, trusted: true })) }));
    expect(win.hardwareRatio).toBe(true);
    expect(win.cdpMismatch).toBe(0);
    const mac = wheelFeatures(snapshot({ wheels: [1, 2, 3].map((i) => ({ t: i * 16, dx: 0, dy: 13.5 * i, mode: 0, wdy: -40.5 * i, trusted: true })) }));
    expect(mac.hardwareRatio).toBe(true);
  });
});

describe('scroll provenance (pure)', () => {
  it('classifies bursts by preceding cause, load grace and settlement', () => {
    const f = computeFeatures(
      snapshot({
        now: 10_000,
        loadT: 1000,
        moves: [{ t: 100, x: 1, y: 1, sx: 1, sy: 86, pointerType: 'mouse', mx: 1, my: 1, coalesced: 1, buttons: 0, trusted: true, hidden: false }],
        scrolls: [
          { t: 1500, pos: 10 }, // within 1 s of load
          { t: 3000, pos: 100 }, // wheel-caused (wheel at 2900)
          { t: 3016, pos: 140 },
          { t: 5000, pos: 400 }, // no cause → programmatic
          { t: 9900, pos: 800 }, // too young to judge
        ],
        causes: [{ t: 2900, kind: 'wheel' }],
      }),
    );
    expect(f.scroll.bursts.map((b) => b.cause)).toEqual(['load', 'wheel', 'none']);
    expect(f.scroll.programmatic).toBe(1);
  });
});

describe('helpers', () => {
  it('visibleDuration subtracts hidden spans and an open hidden period', () => {
    expect(visibleDuration(0, 10_000, [[2000, 5000]], null)).toBe(7000);
    expect(visibleDuration(0, 10_000, [], 8000)).toBe(8000);
  });

  it('classifyStack attributes dispatchers', () => {
    const own = 'https://site.example/sdk.js';
    expect(classifyStack(`Error\n    at h (${own}:1:1)\n    at chrome-extension://abc/cs.js:3:4`, own)).toBe('foreign');
    expect(classifyStack(`Error\n    at h (${own}:1:1)\n    at <anonymous>:1:44`, own)).toBe('foreign');
    expect(classifyStack(`Error\n    at h (${own}:1:1)\n    at go (https://site.example/app.js:9:9)`, own)).toBe('site');
    expect(classifyStack(`Error\n    at h (${own}:1:1)\n    at pptr:evaluate;x:1:1`, own)).toBe('foreign');
    expect(classifyStack(`Error\n    at h (${own}:1:1)`, own)).toBe('unknown');
    expect(classifyStack(undefined, own)).toBe('unknown');
  });

  it('an empty snapshot produces no active decisions', () => {
    expect(decide(computeFeatures(snapshot())).filter((d) => d.active)).toEqual([]);
  });
});
