import type { RequestAnalyzer } from '../types.js';
import { userAgentAnalyzer } from './user-agent.js';
import { headerShapeAnalyzer } from './header-shape.js';
import { webBotAuthAnalyzer } from './web-bot-auth.js';
import { clientPatternAnalyzer } from './client-pattern.js';
import { networkAnalyzer } from './network.js';

/**
 * Default request analyzers, in order. Each is independent; the engine fuses
 * their signals. Replace or extend through ServerOptions.analyzers /
 * extraAnalyzers. The tie analyzer (C11, JS hints vs request headers) is not a
 * request analyzer: it runs in `ingest()` when the SDK's `session` event
 * carries `data.hints` (see analyzers/tie.ts).
 */
export function defaultAnalyzers(): RequestAnalyzer[] {
  return [userAgentAnalyzer(), headerShapeAnalyzer(), webBotAuthAnalyzer(), networkAnalyzer(), clientPatternAnalyzer()];
}

export { userAgentAnalyzer, headerShapeAnalyzer, webBotAuthAnalyzer, clientPatternAnalyzer, networkAnalyzer };
export { resolveDeclaredAgent, frozenUaTell, CRAWL4AI_DEFAULT_UA, LIGHTHOUSE_UAS, type DeclaredIdentity, type DeclaredSignalId, type UaRule, type UserAgentAnalyzerOptions } from './user-agent.js';
export { analyzeHeaderShape, isSecureContextRequest, uaFamily, parseSecChUa, isGreaseBrand, decodeHttp2Settings, normaliseOrder, LIBRARY_ACCEPT_ENCODING, type BrowserFamily, type UaFamily, type HeaderShapeInput, type HeaderShapeAnalyzerOptions, type SecChUaBrand } from './header-shape.js';
export { analyzeTls, candidateRangeSets, type NetworkAnalyzerOptions } from './network.js';
export { type WebBotAuthAnalyzerOptions, type LegacyWebBotAuthVerify } from './web-bot-auth.js';
export { compareHints, tieSignals, captureTieHeaders, TIE_HEADER_NAMES, type TiePair } from './tie.js';
export { serverSignalDefinitions } from './definitions.js';
