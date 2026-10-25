import type { InterventionContext, InterventionHandler } from '../types.js';
import { el, overlayRoot } from './dom.js';
import { BLOCK_OVERLAY_ID } from './block.js';

export const CHALLENGE_OVERLAY_ID = '__necter-challenge';

/**
 * Built-in kinematic challenge: drag a handle across a track. We do not score
 * the *result* (any agent can drag), we score the *motion*: sampling rate,
 * velocity profile, jitter and path. Keyboard users can complete it with arrow
 * keys and are scored on key cadence instead, so assistive-technology users
 * are never locked out. Module implementers refine the scoring in
 * `scoreDrag`/`scoreKeys`.
 */
export async function runChallenge(ctx: InterventionContext): Promise<boolean> {
  if (typeof document === 'undefined') return false;
  if (ctx.config.challenge.kind === 'custom' && ctx.config.challenge.run) {
    const ok = await ctx.config.challenge.run();
    ctx.event({ type: 'challenge', data: { challengeId: 'custom', kind: 'custom', outcome: ok ? 'passed' : 'failed' } });
    return ok;
  }
  const id = 'c_' + Math.random().toString(36).slice(2, 10);
  ctx.event({ type: 'challenge', data: { challengeId: id, kind: 'kinematic', outcome: 'issued' } });
  const result = await presentSlider(ctx);
  ctx.event({ type: 'challenge', data: { challengeId: id, kind: 'kinematic', outcome: result.passed ? 'passed' : 'failed', detail: result.detail } });
  return result.passed;
}

export const challengeHandler: InterventionHandler = async (_action, ctx) => {
  let attempts = 0;
  while (attempts < ctx.config.challenge.attempts) {
    attempts++;
    const ok = await ctx.challenge();
    if (ok) return true;
  }
  await ctx.apply({ kind: ctx.config.challenge.onFail, params: { reason: 'challenge-failed' } });
  return false;
};

interface Sample { t: number; x: number; y: number; trusted: boolean }

function presentSlider(ctx: InterventionContext): Promise<{ passed: boolean; detail: Record<string, unknown> }> {
  return new Promise((resolve) => {
    const root = overlayRoot(CHALLENGE_OVERLAY_ID);
    root.replaceChildren();
    const box = el('div', { maxWidth: '420px', width: '100%' });
    box.appendChild(el('h2', { fontSize: '20px', margin: '0 0 8px' }, ctx.config.text.challengeTitle));
    box.appendChild(el('p', { fontSize: '14px', margin: '0 0 16px', opacity: '0.9' }, ctx.config.text.challengeBody));
    const track = el('div', { position: 'relative', height: '48px', borderRadius: '24px', background: '#374151', margin: '0 auto', width: '320px' });
    const handle = el('div', { position: 'absolute', top: '4px', left: '4px', width: '40px', height: '40px', borderRadius: '20px', background: '#60a5fa', cursor: 'grab', touchAction: 'none' });
    handle.tabIndex = 0;
    handle.setAttribute('role', 'slider');
    handle.setAttribute('aria-valuemin', '0');
    handle.setAttribute('aria-valuemax', '100');
    handle.setAttribute('aria-valuenow', '0');
    handle.setAttribute('aria-label', ctx.config.text.challengeBody);
    track.appendChild(handle);
    box.appendChild(track);
    root.appendChild(box);
    handle.focus();

    const max = 320 - 48;
    let pos = 0;
    let dragging = false;
    const samples: Sample[] = [];
    const keyTimes: number[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (passed: boolean, detail: Record<string, unknown>) => {
      if (timer) clearTimeout(timer);
      handle.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      handle.removeEventListener('keydown', onKey);
      root.remove();
      if (!passed) document.getElementById(BLOCK_OVERLAY_ID)?.remove();
      resolve({ passed, detail });
    };
    const setPos = (p: number) => {
      pos = Math.max(0, Math.min(max, p));
      handle.style.left = `${4 + pos}px`;
      handle.setAttribute('aria-valuenow', String(Math.round((pos / max) * 100)));
    };
    const onDown = (e: PointerEvent) => {
      dragging = true;
      samples.length = 0;
      samples.push({ t: e.timeStamp, x: e.clientX, y: e.clientY, trusted: e.isTrusted });
      handle.setPointerCapture?.(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (!dragging) return;
      samples.push({ t: e.timeStamp, x: e.clientX, y: e.clientY, trusted: e.isTrusted });
      const start = samples[0]!;
      setPos(e.clientX - start.x);
    };
    const onUp = (e: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      samples.push({ t: e.timeStamp, x: e.clientX, y: e.clientY, trusted: e.isTrusted });
      if (pos >= max - 2) {
        const score = scoreDrag(samples);
        finish(score.passed, { mode: 'drag', ...score });
      } else {
        setPos(0);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
        keyTimes.push(e.timeStamp);
        setPos(pos + 16);
        if (pos >= max - 2) {
          const score = scoreKeys(keyTimes, e.isTrusted);
          finish(score.passed, { mode: 'keys', ...score });
        }
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
        setPos(pos - 16);
      }
    };
    handle.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    handle.addEventListener('keydown', onKey);
    timer = setTimeout(() => finish(false, { mode: 'timeout' }), 60_000);
  });
}

/** Human drags: dozens of samples, irregular spacing, non-constant speed, some vertical wander, all trusted. */
export function scoreDrag(samples: Sample[]): { passed: boolean; samples: number; cv: number; yVar: number; trusted: boolean; durationMs: number } {
  const n = samples.length;
  const trusted = samples.every((s) => s.trusted);
  const durationMs = n > 1 ? samples[n - 1]!.t - samples[0]!.t : 0;
  const speeds: number[] = [];
  let yVar = 0;
  const y0 = samples[0]?.y ?? 0;
  for (let i = 1; i < n; i++) {
    const a = samples[i - 1]!;
    const b = samples[i]!;
    const dt = Math.max(1, b.t - a.t);
    speeds.push(Math.hypot(b.x - a.x, b.y - a.y) / dt);
    yVar += Math.abs(b.y - y0);
  }
  const mean = speeds.reduce((s, v) => s + v, 0) / Math.max(1, speeds.length);
  const sd = Math.sqrt(speeds.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, speeds.length));
  const cv = mean > 0 ? sd / mean : 0;
  yVar /= Math.max(1, n - 1);
  // Two or three samples means a teleport (CDP mouse.move without steps or xdotool); perfectly
  // constant speed means linear interpolation; zero vertical wander is unnatural for a 270px drag.
  const passed = trusted && n >= 12 && durationMs >= 150 && cv > 0.15;
  return { passed, samples: n, cv: round(cv), yVar: round(yVar), trusted, durationMs: Math.round(durationMs) };
}

/** Keyboard path: trusted events with human-like irregular cadence. */
export function scoreKeys(times: number[], trusted: boolean): { passed: boolean; presses: number; cv: number } {
  const gaps: number[] = [];
  for (let i = 1; i < times.length; i++) gaps.push(times[i]! - times[i - 1]!);
  const mean = gaps.reduce((s, v) => s + v, 0) / Math.max(1, gaps.length);
  const sd = Math.sqrt(gaps.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, gaps.length));
  const cv = mean > 0 ? sd / mean : 0;
  // Key repeat (holding the arrow) is metronomic for humans too, so only reject the extreme cases.
  const passed = trusted && times.length >= 10 && (cv > 0.05 || mean > 40);
  return { passed, presses: times.length, cv: round(cv) };
}

function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}
