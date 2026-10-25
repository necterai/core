export const CORE_VERSION = '0.1.0';
/** Default URL prefix for the SDK's own endpoints (beacon, canary, challenge, policy). */
export const DEFAULT_ENDPOINT_PREFIX = '/__necter';
/** Name of the header / cookie carrying the session id between client and server. */
export const SESSION_HEADER = 'x-necter-session';
export const SESSION_COOKIE = '__necter_sid';
/** Headers the server adds when the `label` action fires. */
export const LABEL_HEADERS = {
  score: 'x-necter-score',
  actorClass: 'x-necter-class',
  provider: 'x-necter-provider',
  action: 'x-necter-action',
} as const;

export * from './taxonomy.js';
export * from './signals.js';
export * from './engine.js';
export * from './policy.js';
export * from './events.js';
export * from './util.js';
export * from './catalog.js';
export * from './catalog.lite.js';
