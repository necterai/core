import { describe, expect, it, vi } from 'vitest';
import { init, destroy, get } from '../src/index.js';
import type { Module } from '../src/types.js';

describe('browser runtime', () => {
  it('boots, accepts module signals, evaluates and exposes headers', async () => {
    destroy();
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;
    const mod: Module = {
      name: 'probes',
      start(ctx) {
        ctx.emit({ id: 'probe.playwright-artifact', summary: '__pwInitScripts present' });
      },
    };
    const cm = init({ mode: 'monitor', beacon: { intervalMs: 10 } }, [mod]);
    expect(get()).toBe(cm);
    await new Promise((r) => setTimeout(r, 30));
    expect(cm.verdict.actorClass).toBe('browser-agent');
    expect(cm.verdict.deterministic).toBe(true);
    expect(cm.headers()['x-necter-class']).toBe('browser-agent');
    await cm.flush();
    expect(fetchMock).toHaveBeenCalled();
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.sessionId).toBe(cm.sessionId);
    expect(body.events.some((e: { type: string }) => e.type === 'verdict')).toBe(true);
    destroy();
  });

  it('does not finalize on a low-reliability hit of a deterministic signal', async () => {
    destroy();
    (globalThis as unknown as { fetch: unknown }).fetch = vi.fn(async () => new Response('{}'));
    const cm = init({ mode: 'enforce' }, [{ name: 'probes', start: (ctx) => void ctx.emit({ id: 'probe.selenium-artifact', summary: 'weak', reliability: 0.4 }) }]);
    await new Promise((r) => setTimeout(r, 30));
    expect(cm.verdict.deterministic).toBe(false);
    expect(document.getElementById('__necter-block')).toBeNull();
    destroy();
  });

  it('monitor mode does not render the block overlay', async () => {
    destroy();
    (globalThis as unknown as { fetch: unknown }).fetch = vi.fn(async () => new Response('{}'));
    const cm = init({ mode: 'monitor' }, [{ name: 'probes', start: (ctx) => void ctx.emit({ id: 'probe.puppeteer-artifact', summary: 'pptr' }) }]);
    await new Promise((r) => setTimeout(r, 20));
    expect(cm.verdict.score).toBeGreaterThan(95);
    expect(document.getElementById('__necter-block')).toBeNull();
    destroy();
  });

  it('enforce mode blocks on a deterministic proof', async () => {
    destroy();
    (globalThis as unknown as { fetch: unknown }).fetch = vi.fn(async () => new Response('{}'));
    init({ mode: 'enforce' }, [{ name: 'probes', start: (ctx) => void ctx.emit({ id: 'probe.selenium-artifact', summary: '$cdc_' }) }]);
    await new Promise((r) => setTimeout(r, 30));
    expect(document.getElementById('__necter-block')).not.toBeNull();
    destroy();
  });
});
