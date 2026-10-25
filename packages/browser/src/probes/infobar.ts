/**
 * Debugger-infobar detector (docs/research/raw/extension-agents.md section 3.2).
 *
 * When an extension attaches `chrome.debugger`, Chrome shows the global
 * '"<name>" started debugging this browser' infobar. Measured on Chrome 155 / macOS:
 * resize events at +0, 8, 16, 25, 33, 41, 45, 53, 61, 70, 78, 86, 94 ms with
 * innerHeight 919 -> 908 -> 904 -> ... -> 863 (one initial -11 step, then -2..-5 steps),
 * innerWidth and outerHeight unchanged, net -56 px. The mirror (+) sequence appears
 * when the bar closes (5 s after the last client detaches).
 *
 * Not distinguishable: the "controlled by automated test software" bar
 * (`--enable-automation`) and the bad-flags bar (`--disable-blink-features=...`)
 * also remove 56 px, but they are present *before* our script runs, so there is
 * no transition to observe; only `outerHeight - innerHeight` is unusually large,
 * which the environment module scores as geometry.
 */

export interface ResizeSample {
  t: number;
  innerHeight: number;
  innerWidth: number;
  outerHeight: number;
}

export interface BurstDetection {
  kind: 'appeared' | 'closed';
  steps: number;
  deltaTotal: number;
  durationMs: number;
  innerWidth: number;
  outerHeight: number;
  fromHeight: number;
  toHeight: number;
}

export interface BurstOptions {
  windowMs?: number; // 200
  minSteps?: number; // 8
  minStep?: number; // 2
  maxStep?: number; // 5
  minTotal?: number; // 40
  maxTotal?: number; // 60
  /** Steps outside [minStep, maxStep] tolerated (the measured first step is -11). */
  maxOutliers?: number; // 2
  maxOutlierStep?: number; // 16
}

export class ResizeBurstDetector {
  private samples: ResizeSample[] = [];
  private anchor: ResizeSample | undefined;
  private readonly o: Required<BurstOptions>;

  constructor(opts: BurstOptions = {}) {
    this.o = {
      windowMs: opts.windowMs ?? 200,
      minSteps: opts.minSteps ?? 8,
      minStep: opts.minStep ?? 2,
      maxStep: opts.maxStep ?? 5,
      minTotal: opts.minTotal ?? 40,
      maxTotal: opts.maxTotal ?? 60,
      maxOutliers: opts.maxOutliers ?? 2,
      maxOutlierStep: opts.maxOutlierStep ?? 16,
    };
  }

  /** Record the geometry before any resize so the first step has a reference. */
  prime(sample: ResizeSample): void {
    this.anchor = sample;
  }

  /** Record one resize sample (call from the `resize` listener; cheap, never evaluates). */
  push(sample: ResizeSample): void {
    this.samples.push(sample);
    const cutoff = sample.t - this.o.windowMs;
    while (this.samples.length && this.samples[0]!.t < cutoff) this.anchor = this.samples.shift();
  }

  /**
   * Evaluate once the burst has settled (the host calls this ~100 ms after the
   * last resize event), so the whole animation is judged rather than its first
   * eight steps. A detected burst is consumed.
   */
  settle(): BurstDetection | undefined {
    const result = this.evaluate();
    const last = this.samples[this.samples.length - 1];
    if (result && last) {
      this.anchor = last;
      this.samples = [];
    }
    return result;
  }

  /** push + settle in one call (tests and synchronous hosts). */
  pushAndSettle(sample: ResizeSample): BurstDetection | undefined {
    this.push(sample);
    return this.settle();
  }

  private evaluate(): BurstDetection | undefined {
    const seq = this.anchor ? [this.anchor, ...this.samples] : [...this.samples];
    if (seq.length < this.o.minSteps + 1) return undefined;
    const first = seq[0]!;
    const last = seq[seq.length - 1]!;
    for (const s of seq) if (s.innerWidth !== first.innerWidth || s.outerHeight !== first.outerHeight) return undefined;
    const total = last.innerHeight - first.innerHeight;
    const sign = total < 0 ? -1 : 1;
    if (Math.abs(total) < this.o.minTotal || Math.abs(total) > this.o.maxTotal) return undefined;
    let inRange = 0;
    let outliers = 0;
    for (let i = 1; i < seq.length; i++) {
      const d = (seq[i]!.innerHeight - seq[i - 1]!.innerHeight) * sign;
      if (d === 0) continue; // duplicate event at the same height
      if (d < 0) return undefined; // must be monotonic
      if (d >= this.o.minStep && d <= this.o.maxStep) inRange++;
      else if (d <= this.o.maxOutlierStep) outliers++;
      else return undefined;
    }
    if (inRange < this.o.minSteps || outliers > this.o.maxOutliers) return undefined;
    return {
      kind: sign < 0 ? 'appeared' : 'closed',
      steps: seq.length - 1,
      deltaTotal: total,
      durationMs: last.t - this.samples[0]!.t,
      innerWidth: first.innerWidth,
      outerHeight: first.outerHeight,
      fromHeight: first.innerHeight,
      toHeight: last.innerHeight,
    };
  }
}
