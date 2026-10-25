import type { Scheduler } from './types.js';

type IdleWindow = Window & {
  requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
  cancelIdleCallback?: (id: number) => void;
};

export function createScheduler(): Scheduler {
  const cancels = new Set<() => void>();
  const track = (cancel: () => void): (() => void) => {
    cancels.add(cancel);
    return () => {
      cancels.delete(cancel);
      cancel();
    };
  };
  const w = typeof window !== 'undefined' ? (window as IdleWindow) : undefined;
  return {
    idle(fn, timeoutMs = 2000) {
      if (w?.requestIdleCallback) {
        const id = w.requestIdleCallback(() => {
          cancels.delete(cancel);
          fn();
        }, { timeout: timeoutMs });
        const cancel = () => w.cancelIdleCallback?.(id);
        return track(cancel);
      }
      const id = setTimeout(() => {
        cancels.delete(cancel);
        fn();
      }, Math.min(timeoutMs, 50));
      const cancel = () => clearTimeout(id);
      return track(cancel);
    },
    timeout(fn, ms) {
      const id = setTimeout(() => {
        cancels.delete(cancel);
        fn();
      }, ms);
      const cancel = () => clearTimeout(id);
      return track(cancel);
    },
    every(fn, ms) {
      const id = setInterval(fn, ms);
      return track(() => clearInterval(id));
    },
    raf(fn) {
      if (typeof requestAnimationFrame !== 'function') return this.timeout(() => fn(performance.now()), 16);
      const id = requestAnimationFrame((t) => {
        cancels.delete(cancel);
        fn(t);
      });
      const cancel = () => cancelAnimationFrame(id);
      return track(cancel);
    },
    dispose() {
      for (const c of cancels) c();
      cancels.clear();
    },
  };
}
