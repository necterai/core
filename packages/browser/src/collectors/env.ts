/**
 * The `Env` adapter is the only way collectors touch the browser. Every read is
 * wrapped so a missing or hostile API yields `undefined` instead of throwing into
 * the host page, and tests stub the pieces jsdom lacks (WebGL, mediaDevices,
 * speechSynthesis, permissions, Workers).
 */

export interface UABrand {
  brand: string;
  version: string;
}

export interface EnvUserAgentData {
  brands: UABrand[];
  mobile: boolean;
  platform: string;
  /** Resolves the requested high-entropy hints; undefined when the API is missing. */
  getHighEntropyValues?(hints: string[]): Promise<Record<string, unknown>>;
}

export interface EnvScreen {
  width: number;
  height: number;
  availWidth: number;
  availHeight: number;
  availTop: number | undefined;
  availLeft: number | undefined;
  colorDepth: number;
  pixelDepth: number;
}

export interface EnvWindow {
  innerWidth: number;
  innerHeight: number;
  outerWidth: number;
  outerHeight: number;
  screenX: number;
  screenY: number;
  devicePixelRatio: number;
}

export interface EnvWebGL {
  vendor: string;
  renderer: string;
  /** True when WEBGL_debug_renderer_info was available (unmasked strings). */
  unmasked: boolean;
}

export interface EnvVoice {
  name: string;
  lang: string;
  localService: boolean;
}

export interface EnvSpeech {
  getVoices(): EnvVoice[];
  /** Subscribe to voiceschanged; returns an unsubscribe. */
  onVoicesChanged(fn: () => void): () => void;
}

export interface EnvMediaDevice {
  kind: string;
  deviceId: string;
  label: string;
}

/** How navigator.webdriver is defined on this realm. */
export type WebdriverDescriptorState =
  | 'native' // accessor on Navigator.prototype with a native getter
  | 'missing' // no descriptor anywhere (deleted by a stealth script)
  | 'own' // redefined as an own property on the navigator instance
  | 'tampered' // accessor present but the getter is not native code
  | 'unknown';

export interface WorkerSnapshot {
  platform: string;
  userAgent: string;
  hardwareConcurrency: number | undefined;
  languages: string[];
  uaDataPlatform: string | undefined;
  brands: string[] | undefined;
}

export interface Env {
  readonly userAgent: string;
  readonly platform: string;
  readonly language: string;
  readonly languages: readonly string[];
  readonly hardwareConcurrency: number | undefined;
  readonly deviceMemory: number | undefined;
  readonly maxTouchPoints: number;
  readonly webdriver: boolean | undefined;
  readonly userAgentData: EnvUserAgentData | undefined;
  /** `navigator.brave` object present (Brave exposes it on every page). */
  readonly braveObject: boolean;
  readonly screen: EnvScreen;
  readonly window: EnvWindow;
  /** window.chrome shape: undefined when the object is missing entirely. */
  readonly chromeObject: { keys: string[]; runtime: boolean; app: boolean } | undefined;
  readonly secureContext: boolean;

  webdriverDescriptor(): WebdriverDescriptorState;
  isBrave(): Promise<boolean> | undefined;
  fullscreen(): boolean;
  hasFocus(): boolean;
  visibilityState(): 'visible' | 'hidden' | 'prerender' | 'unknown';
  activeElementIsFrame(): boolean;
  timezone(): string | undefined;
  intlLocale(): string | undefined;
  historyLength(): number | undefined;
  referrer(): string;
  notificationPermission(): string | undefined;
  /** undefined when the Permissions API is missing; otherwise the promise (may reject). */
  permissionsQuery(name: string): Promise<string> | undefined;
  /** null = WebGL unavailable (no context); undefined = cannot test (no canvas). */
  getWebGL(): EnvWebGL | null | undefined;
  /**
   * Measures each font against generic fallbacks. Returns undefined when canvas text
   * metrics are unavailable or broken (every probe identical).
   */
  measureFonts(fonts: readonly string[]): Map<string, boolean> | undefined;
  enumerateDevices(): Promise<EnvMediaDevice[]> | undefined;
  speech(): EnvSpeech | undefined;
  /** A small canvas rendering hashed to a string; undefined when canvas is unavailable. */
  canvasHash(): string | undefined;
  /**
   * Spawns a Blob worker running `code` and resolves with its first message.
   * Resolves undefined when workers/blobs are blocked (CSP worker-src, no Blob).
   */
  runWorker(code: string, timeoutMs: number): Promise<WorkerSnapshot | undefined>;
  /** Passive capture-phase listener on window; returns an unsubscribe. */
  on(type: string, fn: (e: Event) => void): () => void;
  now(): number;
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

const FONT_SAMPLE = 'mmmmmmmmmmlli1Il|WwQq@#';

/** Builds the real adapter over the page's globals. Never throws. */
export function createRealEnv(): Env {
  const nav = typeof navigator !== 'undefined' ? navigator : undefined;
  const win = typeof window !== 'undefined' ? window : undefined;
  const doc = typeof document !== 'undefined' ? document : undefined;
  const scr = typeof screen !== 'undefined' ? screen : undefined;
  const n = nav as (Navigator & { deviceMemory?: number; userAgentData?: EnvUserAgentData; brave?: { isBrave?: () => Promise<boolean> } }) | undefined;

  const uad = safe(() => {
    const d = n?.userAgentData;
    if (!d) return undefined;
    const out: EnvUserAgentData = {
      brands: Array.isArray(d.brands) ? d.brands.map((b) => ({ brand: String(b.brand), version: String(b.version) })) : [],
      mobile: !!d.mobile,
      platform: typeof d.platform === 'string' ? d.platform : '',
    };
    if (typeof (d as { getHighEntropyValues?: unknown }).getHighEntropyValues === 'function') {
      out.getHighEntropyValues = (hints) => (d as { getHighEntropyValues: (h: string[]) => Promise<Record<string, unknown>> }).getHighEntropyValues(hints);
    }
    return out;
  }, undefined);

  const chromeObject = safe(() => {
    const c = (win as (Window & { chrome?: Record<string, unknown> }) | undefined)?.chrome;
    if (!c || typeof c !== 'object') return undefined;
    return { keys: Object.keys(c), runtime: c.runtime !== undefined, app: c.app !== undefined };
  }, undefined);

  return {
    userAgent: safe(() => n?.userAgent ?? '', ''),
    platform: safe(() => n?.platform ?? '', ''),
    language: safe(() => n?.language ?? '', ''),
    languages: safe(() => [...(n?.languages ?? [])], []),
    hardwareConcurrency: safe(() => (typeof n?.hardwareConcurrency === 'number' ? n.hardwareConcurrency : undefined), undefined),
    deviceMemory: safe(() => (typeof n?.deviceMemory === 'number' ? n.deviceMemory : undefined), undefined),
    maxTouchPoints: safe(() => (typeof n?.maxTouchPoints === 'number' ? n.maxTouchPoints : 0), 0),
    webdriver: safe(() => (n ? (n.webdriver as boolean | undefined) : undefined), undefined),
    userAgentData: uad,
    braveObject: safe(() => !!n?.brave, false),
    screen: {
      width: safe(() => scr?.width ?? 0, 0),
      height: safe(() => scr?.height ?? 0, 0),
      availWidth: safe(() => scr?.availWidth ?? 0, 0),
      availHeight: safe(() => scr?.availHeight ?? 0, 0),
      availTop: safe(() => (scr as (Screen & { availTop?: number }) | undefined)?.availTop, undefined),
      availLeft: safe(() => (scr as (Screen & { availLeft?: number }) | undefined)?.availLeft, undefined),
      colorDepth: safe(() => scr?.colorDepth ?? 24, 24),
      pixelDepth: safe(() => scr?.pixelDepth ?? 24, 24),
    },
    window: {
      innerWidth: safe(() => win?.innerWidth ?? 0, 0),
      innerHeight: safe(() => win?.innerHeight ?? 0, 0),
      outerWidth: safe(() => win?.outerWidth ?? 0, 0),
      outerHeight: safe(() => win?.outerHeight ?? 0, 0),
      screenX: safe(() => win?.screenX ?? 0, 0),
      screenY: safe(() => win?.screenY ?? 0, 0),
      devicePixelRatio: safe(() => win?.devicePixelRatio ?? 1, 1),
    },
    chromeObject,
    secureContext: safe(() => !!win?.isSecureContext, false),

    webdriverDescriptor() {
      return safe<WebdriverDescriptorState>(() => {
        if (!n || typeof Navigator === 'undefined') return 'unknown';
        const own = Object.getOwnPropertyDescriptor(n, 'webdriver');
        if (own) return 'own';
        const proto = Object.getOwnPropertyDescriptor(Navigator.prototype, 'webdriver');
        if (!proto) return 'missing';
        if (typeof proto.get !== 'function') return 'tampered';
        const src = Function.prototype.toString.call(proto.get);
        return /\{\s*\[native code\]\s*\}/.test(src) ? 'native' : 'tampered';
      }, 'unknown');
    },
    isBrave() {
      return safe(() => {
        const fn = n?.brave?.isBrave;
        return typeof fn === 'function' ? fn.call(n?.brave) : undefined;
      }, undefined);
    },
    fullscreen() {
      return safe(() => {
        if (doc?.fullscreenElement) return true;
        if (win?.matchMedia && win.matchMedia('(display-mode: fullscreen)').matches) return true;
        return false;
      }, false);
    },
    hasFocus() {
      return safe(() => (doc ? doc.hasFocus() : true), true);
    },
    visibilityState() {
      return safe(() => {
        const d = doc as (Document & { prerendering?: boolean }) | undefined;
        if (d?.prerendering) return 'prerender';
        const v = d?.visibilityState;
        return v === 'visible' || v === 'hidden' ? v : 'unknown';
      }, 'unknown');
    },
    activeElementIsFrame() {
      return safe(() => {
        const el = doc?.activeElement;
        return !!el && (el.tagName === 'IFRAME' || el.tagName === 'FRAME');
      }, false);
    },
    timezone() {
      return safe(() => (typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : undefined), undefined);
    },
    intlLocale() {
      return safe(() => (typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().locale : undefined), undefined);
    },
    historyLength() {
      return safe(() => (win?.history ? win.history.length : undefined), undefined);
    },
    referrer() {
      return safe(() => doc?.referrer ?? '', '');
    },
    notificationPermission() {
      return safe(() => (typeof Notification !== 'undefined' ? Notification.permission : undefined), undefined);
    },
    permissionsQuery(name) {
      return safe(() => {
        const p = n?.permissions;
        if (!p || typeof p.query !== 'function') return undefined;
        return p.query({ name: name as PermissionName }).then((s) => s.state as string);
      }, undefined);
    },
    getWebGL() {
      return safe<EnvWebGL | null | undefined>(() => {
        if (!doc) return undefined;
        const canvas = doc.createElement('canvas');
        if (typeof canvas.getContext !== 'function') return undefined;
        const gl = (canvas.getContext('webgl') || canvas.getContext('experimental-webgl')) as WebGLRenderingContext | null;
        if (!gl) return null;
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        if (ext) {
          return {
            vendor: String(gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) ?? ''),
            renderer: String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) ?? ''),
            unmasked: true,
          };
        }
        return { vendor: String(gl.getParameter(gl.VENDOR) ?? ''), renderer: String(gl.getParameter(gl.RENDERER) ?? ''), unmasked: false };
      }, undefined);
    },
    measureFonts(fonts) {
      return safe<Map<string, boolean> | undefined>(() => {
        if (!doc) return undefined;
        const canvas = doc.createElement('canvas');
        const ctx = canvas.getContext && (canvas.getContext('2d') as CanvasRenderingContext2D | null);
        if (!ctx || typeof ctx.measureText !== 'function') return undefined;
        const width = (font: string): number => {
          ctx.font = font;
          return ctx.measureText(FONT_SAMPLE).width;
        };
        const mono = width('72px monospace');
        const sans = width('72px sans-serif');
        const serif = width('72px serif');
        if (!(mono > 0) || !(sans > 0) || (mono === sans && sans === serif)) return undefined;
        const out = new Map<string, boolean>();
        for (const f of fonts) {
          const quoted = `"${f.replace(/"/g, '')}"`;
          const wMono = width(`72px ${quoted}, monospace`);
          const wSans = width(`72px ${quoted}, sans-serif`);
          out.set(f, wMono !== mono && wSans !== sans);
        }
        return out;
      }, undefined);
    },
    enumerateDevices() {
      return safe(() => {
        const md = n?.mediaDevices;
        if (!md || typeof md.enumerateDevices !== 'function') return undefined;
        return md.enumerateDevices().then((list) => list.map((d) => ({ kind: String(d.kind), deviceId: String(d.deviceId ?? ''), label: String(d.label ?? '') })));
      }, undefined);
    },
    speech() {
      return safe<EnvSpeech | undefined>(() => {
        const ss = (win as (Window & { speechSynthesis?: SpeechSynthesis }) | undefined)?.speechSynthesis;
        if (!ss || typeof ss.getVoices !== 'function') return undefined;
        return {
          getVoices: () => safe(() => ss.getVoices().map((v) => ({ name: String(v.name), lang: String(v.lang), localService: !!v.localService })), []),
          onVoicesChanged(fn) {
            try {
              ss.addEventListener('voiceschanged', fn);
              return () => safe(() => ss.removeEventListener('voiceschanged', fn), undefined);
            } catch {
              return () => undefined;
            }
          },
        };
      }, undefined);
    },
    canvasHash() {
      return safe<string | undefined>(() => {
        if (!doc) return undefined;
        const canvas = doc.createElement('canvas');
        canvas.width = 120;
        canvas.height = 40;
        const ctx = canvas.getContext && (canvas.getContext('2d') as CanvasRenderingContext2D | null);
        if (!ctx || typeof canvas.toDataURL !== 'function') return undefined;
        ctx.textBaseline = 'alphabetic';
        ctx.fillStyle = '#f60';
        ctx.fillRect(10, 5, 60, 20);
        ctx.fillStyle = '#069';
        ctx.font = '14px Arial';
        ctx.fillText('necter 🙂', 2, 30);
        ctx.strokeStyle = 'rgba(102, 204, 0, 0.7)';
        ctx.beginPath();
        ctx.arc(90, 20, 15, 0, Math.PI * 1.5);
        ctx.stroke();
        return canvas.toDataURL();
      }, undefined);
    },
    runWorker(code, timeoutMs) {
      return new Promise<WorkerSnapshot | undefined>((resolve) => {
        let done = false;
        let worker: Worker | undefined;
        let url: string | undefined;
        const finish = (v: WorkerSnapshot | undefined) => {
          if (done) return;
          done = true;
          safe(() => worker?.terminate(), undefined);
          if (url) safe(() => URL.revokeObjectURL(url!), undefined);
          resolve(v);
        };
        try {
          if (typeof Worker === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
            finish(undefined);
            return;
          }
          url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
          worker = new Worker(url);
          worker.onmessage = (e) => finish(e.data as WorkerSnapshot);
          worker.onerror = () => finish(undefined);
          setTimeout(() => finish(undefined), timeoutMs);
        } catch {
          finish(undefined);
        }
      });
    },
    on(type, fn) {
      try {
        if (!win) return () => undefined;
        const opts = { capture: true, passive: true } as AddEventListenerOptions;
        win.addEventListener(type, fn, opts);
        return () => safe(() => win.removeEventListener(type, fn, opts), undefined);
      } catch {
        return () => undefined;
      }
    },
    now() {
      return safe(() => (typeof performance !== 'undefined' ? performance.now() : Date.now()), Date.now());
    },
  };
}
