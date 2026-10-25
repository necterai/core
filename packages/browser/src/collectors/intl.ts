/**
 * Timezone tell (spec §1). Containers inherit TZ=UTC; Firefox RFP spoofs UTC /
 * Atlantic/Reykjavik on purpose (privacy-gated); people in UTC-offset countries
 * running English locales (en-GB, en-IE, ...) are excluded by the locale guard.
 */
import type { Finding } from './finding.js';
import { SPOOFED_TIMEZONES } from './privacy.js';

/** English locales whose region sits on UTC for at least part of the year. */
const ENGLISH_UTC_REGIONS: ReadonlySet<string> = new Set(['GB', 'IE', 'IS', 'GH', 'GM', 'SL', 'LR', 'PT', 'FO', 'SH', 'ML', 'SN', 'BF', 'CI', 'GN', 'GW', 'MR', 'TG']);

export function localeRegion(tag: string | undefined): string | undefined {
  if (!tag) return undefined;
  const m = /^[A-Za-z]{2,3}(?:-[A-Za-z]{4})?-([A-Za-z]{2}|\d{3})(?:-|$)/.exec(tag);
  return m?.[1] ? m[1].toUpperCase() : undefined;
}

export function analyzeTimezone(timezone: string | undefined, language: string | undefined): Finding[] {
  if (!timezone || !SPOOFED_TIMEZONES.has(timezone)) return [];
  const lang = language || '';
  const region = localeRegion(lang);
  const english = /^en\b/i.test(lang);
  if (english && region && ENGLISH_UTC_REGIONS.has(region)) return [];
  const f: Finding = {
    id: 'env.utc-timezone',
    summary: `timezone ${timezone} while navigator.language is ${lang || 'empty'}`,
    value: { timezone, language: lang },
    privacyGated: true,
  };
  // A bare language tag ("en") carries no region: weaker contradiction than "en-US" or "de-DE".
  if (!region) f.reliability = 0.6;
  return [f];
}
