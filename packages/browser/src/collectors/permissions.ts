/**
 * Permissions API consistency (spec §1, cdp-leak-techniques.md §8).
 * chrome-headless-shell answers Notification.permission === "denied" while
 * permissions.query({name:'notifications'}) resolves "prompt": an impossible pair
 * in a headed browser (BotD detectNotificationPermissions). New headless is
 * consistent ("default" / "prompt"), so this only identifies the shell that
 * Playwright still uses for headless Chromium by default.
 *
 * The hosted ChatGPT agent fails most permissions.query calls (arXiv 2606.30119
 * Table 11: NS for 12 of 13 permissions); counted only for names Chromium's
 * PermissionName enum always accepts so Firefox TypeErrors never count.
 */
import type { Finding } from './finding.js';
import type { ParsedUA } from './ua.js';

/** Names Chromium supports; Firefox rejects several of these with TypeError, so the rate is Blink-only. */
export const PERMISSION_NAMES: readonly string[] = [
  'notifications',
  'geolocation',
  'camera',
  'microphone',
  'midi',
  'persistent-storage',
  'clipboard-read',
  'clipboard-write',
  'accelerometer',
  'gyroscope',
  'magnetometer',
  'background-sync',
  'payment-handler',
];

export type PermissionOutcome = 'granted' | 'denied' | 'prompt' | 'rejected';

export interface PermissionsInput {
  ua: ParsedUA;
  notificationPermission: string | undefined;
  /** name -> outcome for every probed permission. */
  outcomes: Map<string, PermissionOutcome>;
}

export interface PermissionsResult {
  findings: Finding[];
  failRate: number;
  deniedRate: number;
}

export function analyzePermissions(i: PermissionsInput): PermissionsResult {
  const findings: Finding[] = [];
  const total = i.outcomes.size;
  let rejected = 0;
  let denied = 0;
  for (const o of i.outcomes.values()) {
    if (o === 'rejected') rejected++;
    else if (o === 'denied') denied++;
  }
  const failRate = total ? rejected / total : 0;
  const deniedRate = total ? denied / total : 0;

  const notif = i.outcomes.get('notifications');
  if (i.ua.engine === 'blink' && i.notificationPermission === 'denied' && notif === 'prompt') {
    findings.push({
      id: 'env.permissions-inconsistent',
      summary: 'Notification.permission is "denied" while permissions.query({name:"notifications"}) resolves "prompt"',
      value: { notificationPermission: 'denied', query: 'prompt' },
    });
  }

  if (i.ua.engine === 'blink' && total >= 5 && failRate >= 0.5) {
    findings.push({
      id: 'env.permissions-query-failing',
      summary: `${rejected} of ${total} permissions.query calls rejected on a Chromium UA`,
      value: { rejected, total },
      details: { failRate: Math.round(failRate * 100) / 100 },
      reliability: Math.min(1, failRate),
    });
  }
  return { findings, failRate, deniedRate };
}
