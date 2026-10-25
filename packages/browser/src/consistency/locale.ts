/**
 * Locale vs timezone (spec §7, weak and privacy-gated). A small tz -> country
 * table covers the zones that carry most traffic; unknown zones never fire.
 * Travellers, VPN and relay users legitimately mismatch (false-positive-traps.md
 * §8), hence the weak weight and the English discount.
 */
import type { Finding } from '../collectors/finding.js';
import { localeRegion } from '../collectors/intl.js';
import { SPOOFED_TIMEZONES } from '../collectors/privacy.js';

export const TZ_COUNTRY: Readonly<Record<string, string>> = {
  'America/New_York': 'US', 'America/Chicago': 'US', 'America/Denver': 'US', 'America/Los_Angeles': 'US', 'America/Phoenix': 'US',
  'America/Anchorage': 'US', 'Pacific/Honolulu': 'US', 'America/Detroit': 'US', 'America/Indiana/Indianapolis': 'US',
  'America/Toronto': 'CA', 'America/Vancouver': 'CA', 'America/Edmonton': 'CA', 'America/Winnipeg': 'CA', 'America/Halifax': 'CA',
  'America/Mexico_City': 'MX', 'America/Sao_Paulo': 'BR', 'America/Argentina/Buenos_Aires': 'AR', 'America/Bogota': 'CO', 'America/Lima': 'PE', 'America/Santiago': 'CL',
  'Europe/London': 'GB', 'Europe/Dublin': 'IE', 'Europe/Paris': 'FR', 'Europe/Berlin': 'DE', 'Europe/Madrid': 'ES', 'Europe/Rome': 'IT',
  'Europe/Amsterdam': 'NL', 'Europe/Brussels': 'BE', 'Europe/Zurich': 'CH', 'Europe/Vienna': 'AT', 'Europe/Stockholm': 'SE', 'Europe/Oslo': 'NO',
  'Europe/Copenhagen': 'DK', 'Europe/Helsinki': 'FI', 'Europe/Warsaw': 'PL', 'Europe/Prague': 'CZ', 'Europe/Budapest': 'HU', 'Europe/Lisbon': 'PT',
  'Europe/Athens': 'GR', 'Europe/Istanbul': 'TR', 'Europe/Moscow': 'RU', 'Europe/Kiev': 'UA', 'Europe/Kyiv': 'UA', 'Europe/Bucharest': 'RO',
  'Asia/Tokyo': 'JP', 'Asia/Seoul': 'KR', 'Asia/Shanghai': 'CN', 'Asia/Hong_Kong': 'HK', 'Asia/Taipei': 'TW', 'Asia/Singapore': 'SG',
  'Asia/Kolkata': 'IN', 'Asia/Calcutta': 'IN', 'Asia/Dubai': 'AE', 'Asia/Jakarta': 'ID', 'Asia/Bangkok': 'TH', 'Asia/Manila': 'PH',
  'Asia/Ho_Chi_Minh': 'VN', 'Asia/Karachi': 'PK', 'Asia/Dhaka': 'BD', 'Asia/Tehran': 'IR', 'Asia/Jerusalem': 'IL', 'Asia/Riyadh': 'SA',
  'Australia/Sydney': 'AU', 'Australia/Melbourne': 'AU', 'Australia/Brisbane': 'AU', 'Australia/Perth': 'AU', 'Pacific/Auckland': 'NZ',
  'Africa/Johannesburg': 'ZA', 'Africa/Lagos': 'NG', 'Africa/Cairo': 'EG', 'Africa/Nairobi': 'KE', 'Africa/Casablanca': 'MA',
};

export interface LocaleFacts {
  languages: readonly string[];
  intlLocale: string | undefined;
  timezone: string | undefined;
}

export function analyzeLocale(f: LocaleFacts): Finding[] {
  const primary = f.languages[0];
  const langRegion = localeRegion(primary);
  const intlRegion = localeRegion(f.intlLocale);
  const tzCountry = f.timezone && !SPOOFED_TIMEZONES.has(f.timezone) ? TZ_COUNTRY[f.timezone] : undefined;

  if (langRegion && tzCountry && langRegion !== tzCountry) {
    // Any accepted language from the timezone's country explains the primary tag (bilingual users).
    const explained = f.languages.some((l) => localeRegion(l) === tzCountry);
    if (!explained) {
      const english = /^en\b/i.test(primary ?? '');
      return [
        {
          id: 'consistency.locale-mismatch',
          summary: `navigator.languages[0] "${primary}" (${langRegion}) vs timezone ${f.timezone} (${tzCountry})`,
          value: [['navigator.languages[0]', primary ?? ''], ['timezone', f.timezone ?? '']],
          details: { languages: [...f.languages], intlLocale: f.intlLocale ?? null },
          reliability: english ? 0.4 : 0.6,
          privacyGated: true,
        },
      ];
    }
  }

  if (langRegion && intlRegion && langRegion !== intlRegion) {
    return [
      {
        id: 'consistency.locale-mismatch',
        summary: `navigator.languages[0] "${primary}" vs Intl default locale "${f.intlLocale}"`,
        value: [['navigator.languages[0]', primary ?? ''], ['Intl.locale', f.intlLocale ?? '']],
        reliability: 0.5,
        privacyGated: true,
      },
    ];
  }
  return [];
}
