/**
 * Media devices and speech voices (spec §1). Linux containers enumerate no
 * devices and expose no voices (no speech-dispatcher); real desktops almost
 * always have at least an audio output. WebKit hides devices before permission
 * (reliability 0.6) and Firefox often has no voices (reliability 0.5).
 * Attribution detail: Google Chrome ships "Google ..." network voices while
 * Chromium / Chrome for Testing / Atlas do not (cdp-leak-techniques.md §9.4,
 * computer-use-agents.md §3.6).
 */
import type { EnvMediaDevice, EnvVoice } from './env.js';
import type { Finding } from './finding.js';
import type { ParsedUA } from './ua.js';

export function analyzeMediaDevices(devices: EnvMediaDevice[] | undefined, ua: ParsedUA): Finding[] {
  if (!devices) return [];
  if (devices.length > 0) return [];
  const f: Finding = {
    id: 'env.no-media-devices',
    summary: 'enumerateDevices() returned 0 audio input, audio output or video devices',
    value: 0,
    privacyGated: true,
  };
  if (ua.engine === 'webkit') f.reliability = 0.6;
  return [f];
}

export interface VoicesResult {
  findings: Finding[];
  total: number;
  google: number;
}

export function analyzeVoices(voices: EnvVoice[] | undefined, ua: ParsedUA): VoicesResult {
  if (!voices) return { findings: [], total: 0, google: 0 };
  const total = voices.length;
  const google = voices.filter((v) => /^Google /.test(v.name)).length;
  const findings: Finding[] = [];
  if (total === 0) {
    const f: Finding = {
      id: 'env.no-voices',
      summary: 'speechSynthesis.getVoices() is empty after voiceschanged / 1.5 s',
      value: 0,
      privacyGated: true,
    };
    if (ua.engine === 'gecko') f.reliability = 0.5;
    findings.push(f);
  } else if (ua.browser === 'chrome' && ua.engine === 'blink' && ua.desktop && google === 0) {
    findings.push({
      id: 'env.no-google-voices',
      summary: `${total} local voices but no "Google ..." network voices on a Chrome UA`,
      value: { total, google },
    });
  }
  return { findings, total, google };
}
