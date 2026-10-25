/**
 * Minimal User-Agent classification shared by the environment and consistency
 * modules. It only extracts what the guards need (OS family, engine, browser
 * product, mobile / WebView / headless flags); it is not a general UA parser.
 *
 * Caveats baked in from docs/research/raw/false-positive-traps.md §7.5 and §9:
 *  - Chrome >= 110 freezes the OS token ("Windows NT 10.0; Win64; x64",
 *    "Macintosh; Intel Mac OS X 10_15_7", "X11; Linux x86_64", "Linux; Android 10; K"),
 *    so the UA only tells us the OS *family*, never the version or CPU.
 *  - iPadOS Safari in desktop mode reports a Macintosh UA with navigator.platform
 *    "MacIntel" and maxTouchPoints > 1; treat it as macOS-compatible.
 *  - WebViews (`wv`, iOS without `Safari/`, in-app tokens) are degraded environments
 *    and must never be scored on window-chrome / storage tells.
 */

export type UAOs = 'windows' | 'macos' | 'linux' | 'chromeos' | 'android' | 'ios' | 'unknown';
export type UAEngine = 'blink' | 'gecko' | 'webkit' | 'unknown';
export type UABrowser = 'chrome' | 'edge' | 'opera' | 'samsung' | 'firefox' | 'safari' | 'other';

export interface ParsedUA {
  raw: string;
  os: UAOs;
  engine: UAEngine;
  browser: UABrowser;
  /** Chromium major version when the UA carries one. */
  chromiumMajor: number | undefined;
  /** Firefox major version when the UA carries one. */
  firefoxMajor: number | undefined;
  headless: boolean;
  mobile: boolean;
  webview: boolean;
  /** Desktop-class UA: windows/macos/linux/chromeos, not mobile, not a WebView. */
  desktop: boolean;
}

const IN_APP = /\bFB[\w_]+\/|\bInstagram|\bLine\/|\bMicroMessenger\/|\bPuffin|\bMiuiBrowser\/|\bTwitter/;

export function parseUA(raw: string | undefined | null): ParsedUA {
  const ua = typeof raw === 'string' ? raw : '';
  let os: UAOs = 'unknown';
  if (/Windows NT|Win64|Win32/.test(ua)) os = 'windows';
  else if (/iPhone|iPad|iPod/.test(ua)) os = 'ios';
  else if (/Android/.test(ua)) os = 'android';
  else if (/CrOS/.test(ua)) os = 'chromeos';
  else if (/Macintosh|Mac OS X/.test(ua)) os = 'macos';
  else if (/X11|Linux|Ubuntu|Fedora/.test(ua)) os = 'linux';

  let engine: UAEngine = 'unknown';
  if (/Gecko\/\d|Firefox\/|FxiOS\//.test(ua)) engine = 'gecko';
  if (/Chrome\/|Chromium\/|CriOS\/|HeadlessChrome\//.test(ua)) engine = 'blink';
  else if (/AppleWebKit\//.test(ua) && engine === 'unknown') engine = 'webkit';
  // Every browser on iOS is WebKit regardless of the product token.
  if (os === 'ios') engine = 'webkit';

  let browser: UABrowser = 'other';
  if (/Edg(e|A|iOS)?\//.test(ua)) browser = 'edge';
  else if (/OPR\/|Opera/.test(ua)) browser = 'opera';
  else if (/SamsungBrowser\//.test(ua)) browser = 'samsung';
  else if (/Firefox\/|FxiOS\//.test(ua)) browser = 'firefox';
  else if (/Chrome\/|Chromium\/|CriOS\/|HeadlessChrome\//.test(ua)) browser = 'chrome';
  else if (/Safari\//.test(ua) && /Version\//.test(ua)) browser = 'safari';
  else if (os === 'ios' && engine === 'webkit') browser = 'safari';

  const chromium = /(?:HeadlessChrome|Chrome|Chromium|CriOS)\/(\d+)/.exec(ua);
  const firefox = /(?:Firefox|FxiOS)\/(\d+)/.exec(ua);
  const headless = /HeadlessChrome\//.test(ua) || /\bHeadless\b/i.test(ua);
  // Tablets count as mobile-class here: the desktop-only tells (window chrome, fonts) do not apply to them.
  const mobile = /\bMobile\b|Android|iPhone|iPod|iPad|\bwv\b/.test(ua);
  const webview =
    /\bwv\b/.test(ua) ||
    (/(iPhone|iPod|iPad)/.test(ua) && !/Safari\//.test(ua)) ||
    IN_APP.test(ua);
  const desktop = (os === 'windows' || os === 'macos' || os === 'linux' || os === 'chromeos') && !mobile && !webview;

  return {
    raw: ua,
    os,
    engine,
    browser,
    chromiumMajor: chromium?.[1] ? Number(chromium[1]) : undefined,
    firefoxMajor: firefox?.[1] ? Number(firefox[1]) : undefined,
    headless,
    mobile,
    webview,
    desktop,
  };
}

/** navigator.platform values that are consistent with each UA OS family. */
export function platformMatchesOs(platform: string, os: UAOs): boolean | undefined {
  const p = platform || '';
  switch (os) {
    case 'windows':
      return /^Win/.test(p);
    case 'macos':
      // iPadOS desktop-mode Safari also says Macintosh + MacIntel; Apple Silicon reports MacIntel.
      return /^Mac/.test(p);
    case 'ios':
      // iPad desktop mode reports MacIntel (handled by the caller through maxTouchPoints).
      return /^(iPhone|iPad|iPod)/.test(p) || /^Mac/.test(p);
    case 'android':
      return /^(Linux|Android)/.test(p) || p === '';
    case 'linux':
    case 'chromeos':
      return /^Linux|^X11|^FreeBSD|^OpenBSD|^NetBSD|^SunOS/.test(p) || p === '';
    default:
      return undefined;
  }
}

/** navigator.userAgentData.platform values that are consistent with each UA OS family. */
export function uaDataPlatformMatchesOs(uaDataPlatform: string, os: UAOs): boolean | undefined {
  const p = uaDataPlatform || '';
  switch (os) {
    case 'windows':
      return p === 'Windows';
    case 'macos':
      return p === 'macOS';
    case 'linux':
      return p === 'Linux' || p === 'Unknown';
    case 'chromeos':
      return p === 'Chrome OS' || p === 'Chromium OS' || p === 'Linux';
    case 'android':
      return p === 'Android';
    case 'ios':
      return p === 'iOS' || p === '';
    default:
      return undefined;
  }
}

export function humanOs(os: UAOs): string {
  return os === 'macos' ? 'macOS' : os === 'ios' ? 'iOS' : os === 'chromeos' ? 'ChromeOS' : os.charAt(0).toUpperCase() + os.slice(1);
}
