import { describe, expect, it } from 'vitest';
import { SIGNAL_CATALOG, SIGNAL_CATALOG_LITE, SIGNAL_LAYERS, STRENGTH_LOG_ODDS, ACTOR_CLASSES } from '../src/index.js';

describe('signal catalog', () => {
  it('has unique ids prefixed by a layer-ish namespace', () => {
    const ids = SIGNAL_CATALOG.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z]+\.[a-z0-9-]+$/);
  });
  it('uses valid layers, classes and sensible weights', () => {
    for (const d of SIGNAL_CATALOG) {
      expect(SIGNAL_LAYERS).toContain(d.layer);
      const bound = Math.max(STRENGTH_LOG_ODDS[d.strength] * 1.25, 1);
      if (d.strength === 'deterministic') expect(Math.abs(d.automation)).toBeGreaterThanOrEqual(6);
      else if (d.strength === 'informational') expect(Math.abs(d.automation)).toBeLessThanOrEqual(0.5);
      else expect(Math.abs(d.automation)).toBeLessThanOrEqual(Math.max(bound, 4.5));
      for (const cls of Object.keys(d.classes ?? {})) expect(ACTOR_CLASSES).toContain(cls);
      expect(d.description.length).toBeGreaterThan(10);
    }
  });
  it('documents false positives for every non-deterministic client signal with positive weight above 1', () => {
    const missing = SIGNAL_CATALOG.filter((d) => d.source !== 'server' && d.strength !== 'deterministic' && d.automation > 1 && !d.falsePositives && !d.family);
    // Signals without a family or FP note must be rare; list them so additions are deliberate.
    expect(missing.map((d) => d.id)).toEqual([]);
  });

  it('lite catalog matches the full catalog (run pnpm gen:lite after editing catalog.ts)', () => {
    const strip = (d: (typeof SIGNAL_CATALOG)[number]) => ({ id: d.id, layer: d.layer, strength: d.strength, automation: d.automation, source: d.source, classes: d.classes, family: d.family });
    expect(SIGNAL_CATALOG_LITE.map(strip)).toEqual(SIGNAL_CATALOG.map(strip));
  });
});
