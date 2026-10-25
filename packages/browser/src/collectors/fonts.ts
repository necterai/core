/**
 * Font-set tells (spec §1). Twelve probe fonts measured against generic
 * fallbacks via canvas measureText: a minimal Linux container only matches the
 * DejaVu / Liberation / Noto families, a stock Windows install has Segoe UI,
 * Calibri, Cambria and Consolas, a stock macOS install has Helvetica Neue,
 * Menlo, PingFang SC and Hiragino Sans. Firefox RFP limits fonts to bundled
 * "Base Fonts" (FF80) and normalises system fonts (FF128): privacy-gated.
 */
import type { Finding } from './finding.js';
import type { ParsedUA } from './ua.js';

export const WINDOWS_FONTS: readonly string[] = ['Segoe UI', 'Calibri', 'Cambria', 'Consolas'];
export const MAC_FONTS: readonly string[] = ['Helvetica Neue', 'Menlo', 'PingFang SC', 'Hiragino Sans'];
export const LINUX_FONTS: readonly string[] = ['DejaVu Sans', 'Liberation Sans', 'Noto Sans', 'Ubuntu'];
export const PROBE_FONTS: readonly string[] = [...WINDOWS_FONTS, ...MAC_FONTS, ...LINUX_FONTS];

export interface FontSummary {
  windows: string[];
  mac: string[];
  linux: string[];
  total: number;
}

export function summarizeFonts(present: Map<string, boolean>): FontSummary {
  const pick = (list: readonly string[]) => list.filter((f) => present.get(f) === true);
  const windows = pick(WINDOWS_FONTS);
  const mac = pick(MAC_FONTS);
  const linux = pick(LINUX_FONTS);
  return { windows, mac, linux, total: windows.length + mac.length + linux.length };
}

export function analyzeFonts(present: Map<string, boolean> | undefined, ua: ParsedUA): Finding[] {
  if (!present || !ua.desktop) return [];
  const s = summarizeFonts(present);
  const out: Finding[] = [];

  if (ua.os === 'windows' || ua.os === 'macos') {
    const own = ua.os === 'windows' ? s.windows : s.mac;
    const onlyLinux = s.linux.length > 0 && s.windows.length === 0 && s.mac.length === 0;
    if (onlyLinux) {
      out.push({
        id: 'env.container-fonts',
        summary: `only Linux fonts (${s.linux.join(', ')}) available on a ${ua.os} UA`,
        value: s.linux,
        details: { windows: s.windows, mac: s.mac },
        privacyGated: true,
      });
    } else if (own.length < 3) {
      out.push({
        id: 'env.container-fonts',
        summary: `${own.length} of ${ua.os === 'windows' ? WINDOWS_FONTS.length : MAC_FONTS.length} stock ${ua.os} fonts present (${own.join(', ') || 'none'})`,
        value: own,
        details: { windows: s.windows, mac: s.mac, linux: s.linux },
        // Fewer stock fonts is weaker evidence than a Linux-only set: trimmed enterprise images exist.
        reliability: own.length === 0 ? 0.8 : 0.5,
        privacyGated: true,
      });
    }
  } else if (ua.os === 'linux' && s.total <= 1 && s.linux.length <= 1) {
    // A Linux desktop usually carries DejaVu + Liberation + Noto (+ Ubuntu/Cantarell); a Debian/Ubuntu
    // container has at most fonts-dejavu pulled in by a dependency.
    out.push({
      id: 'env.container-fonts',
      summary: `${s.total} of ${PROBE_FONTS.length} probe fonts present on a Linux UA (${s.linux.join(', ') || 'none'})`,
      value: s.linux,
      reliability: 0.5,
      privacyGated: true,
    });
  }
  return out;
}
