import type { AnalyzerApi, RequestAnalyzer, RequestContext } from '../types.js';
import { getKnowledge, type Knowledge } from '../knowledge.js';
import { createWebBotAuthVerifier, parseWebBotAuthHeaders, type VerifyOptions, type WebBotAuthResult, type WebBotAuthStatus, type WebBotAuthVerifier } from '../web-bot-auth/verify.js';
import { attributeDirectory, providerFromDirectory as providerFromDirectoryImpl } from '../web-bot-auth/providers.js';
import { createNodeResolveHost } from '../net/rdns.js';

/**
 * Web Bot Auth (draft-ietf-webbotauth-httpsig-protocol): agents sign requests
 * with RFC 9421 HTTP Message Signatures (`tag="web-bot-auth"`) and point at a
 * key directory through Signature-Agent. The header alone is a *claim*
 * (`declared.signature-agent`); `web-bot-auth/verify.ts` resolves the directory
 * (SSRF-guarded, cached, nonce-replay checked) and verifies the Ed25519
 * signature, producing `network.web-bot-auth-verified` (identity = the
 * directory origin we fetched) or `network.web-bot-auth-invalid`.
 * Verification is gated by `options.verifyWebBotAuth` (default true).
 */

/** Legacy hook kept for compatibility: a custom verification function. */
export type LegacyWebBotAuthVerify = (ctx: RequestContext, api: AnalyzerApi) => Promise<{ ok: boolean; agent?: string; reason?: string }>;

export interface WebBotAuthAnalyzerOptions {
  /** Prebuilt verifier (shared cache across servers, tests). Default: one per analyzer instance, built on first use. */
  verifier?: WebBotAuthVerifier;
  /** Overrides for the default verifier (merged over the server's `webBotAuth` options). */
  verifyOptions?: VerifyOptions;
  knowledge?: Knowledge;
  /** Legacy custom verification function; bypasses verify.ts when given. */
  verify?: LegacyWebBotAuthVerify;
}

/** How much a non-verified outcome says: a bad signature is proof of tampering, a discovery failure may be ours. */
const FAILURE_RELIABILITY: Record<Exclude<WebBotAuthStatus, 'verified' | 'unsigned'>, number> = {
  invalid: 1,
  'unknown-key': 0.7,
  'directory-unavailable': 0.4,
};

export function webBotAuthAnalyzer(opts: WebBotAuthAnalyzerOptions | LegacyWebBotAuthVerify = {}): RequestAnalyzer {
  const o: WebBotAuthAnalyzerOptions = typeof opts === 'function' ? { verify: opts } : opts;
  let verifier: WebBotAuthVerifier | undefined = o.verifier;
  let currentNow = Date.now();

  function getVerifier(api: AnalyzerApi): WebBotAuthVerifier {
    if (verifier) return verifier;
    const so = api.options.webBotAuth ?? {};
    const resolveHost = so.resolveHost === false ? undefined : (so.resolveHost ?? createNodeResolveHost());
    const vo: VerifyOptions = {
      fetch: api.fetch,
      now: () => currentNow,
      log: (...args: unknown[]) => api.log('[web-bot-auth]', ...args),
      ...(resolveHost ? { resolveHost } : {}),
      ...(so.maxLifetimeSec !== undefined ? { maxLifetimeSec: so.maxLifetimeSec } : {}),
      ...(so.skewSec !== undefined ? { skewSec: so.skewSec } : {}),
      ...(so.allowRsa !== undefined ? { allowRsa: so.allowRsa } : {}),
      ...(so.directoryTimeoutMs !== undefined ? { directoryTimeoutMs: so.directoryTimeoutMs } : {}),
      ...(so.cacheTtlMs !== undefined ? { cacheTtlMs: so.cacheTtlMs } : {}),
      ...(so.maxDirectoryFetchesPerMinute !== undefined ? { maxFetchesPerMinute: so.maxDirectoryFetchesPerMinute } : {}),
      ...(o.verifyOptions ?? {}),
    };
    verifier = createWebBotAuthVerifier(vo);
    return verifier;
  }

  return {
    name: 'web-bot-auth',
    async analyze(ctx, api) {
      const agentHeader = ctx.headers.get('signature-agent');
      const input = ctx.headers.get('signature-input');
      const sig = ctx.headers.get('signature');
      if (!agentHeader && !input && !sig) return;
      const kb = o.knowledge ?? getKnowledge();

      // ── The claim ──
      const parsed = parseWebBotAuthHeaders(ctx.headers);
      const identity = parsed.agents[0]?.url ?? (agentHeader ? agentHeader.trim().replace(/^"|"$/g, '') : undefined);
      const attribution = identity ? attributeDirectory(identity, kb) : undefined;
      const tags = [...new Set([...parsed.inputs.values()].map((i) => i.tag).filter((t): t is string => Boolean(t)))];
      api.emit({
        id: 'declared.signature-agent',
        summary: `Signature-Agent ${identity ?? '(missing)'}${input ? ` with Signature-Input${tags.length ? ` tag=${tags.join(',')}` : ''}` : ''}`,
        value: { agent: identity, input: input?.slice(0, 200) },
        details: {
          verification: 'unverified',
          ...(tags.length ? { tags } : {}),
          ...(parsed.otherTags.length ? { otherTags: parsed.otherTags } : {}),
          ...(parsed.agents.length ? { agentForm: parsed.agents[0]!.label === '*' ? 'string' : 'dictionary' } : {}),
          ...(parsed.parseErrors.length ? { parseErrors: parsed.parseErrors.slice(0, 3) } : {}),
        },
        ...(attribution ? { provider: { id: attribution.provider, confidence: 0.5, product: attribution.product ?? identity! } } : {}),
      });
      if (!api.options.verifyWebBotAuth) return;

      // ── Legacy custom verifier ──
      if (o.verify) {
        if (!identity || !input || !sig) return;
        try {
          const result = await o.verify(ctx, api);
          if (result.ok) {
            api.emit({
              id: 'network.web-bot-auth-verified',
              summary: `Web Bot Auth signature verified for ${identity}`,
              details: { verification: 'passed', method: 'web-bot-auth', identity },
              provider: { id: providerFromDirectoryImpl(identity, kb), confidence: 0.99, product: attribution?.product ?? identity },
            });
          } else {
            api.emit({ id: 'network.web-bot-auth-invalid', summary: `Web Bot Auth signature invalid: ${result.reason ?? 'unknown'}`, details: { verification: 'failed', method: 'web-bot-auth', identity, reason: result.reason ?? 'unknown' } });
          }
        } catch (err) {
          api.log('web-bot-auth verify error', err);
        }
        return;
      }

      // ── verify.ts ──
      if (!input && !sig) return; // Signature-Agent alone: a claim with nothing to verify.
      let result: WebBotAuthResult;
      try {
        currentNow = ctx.now;
        result = await getVerifier(api).verify({ method: ctx.method, url: ctx.url.href, headers: ctx.headers });
      } catch (err) {
        api.log('web-bot-auth verify error', err);
        return;
      }
      if (result.status === 'unsigned') return;
      const who = result.identity ?? identity;
      const attr = who ? attributeDirectory(who, kb) : undefined;
      if (result.status === 'verified') {
        const host = safeHost(who);
        api.emit({
          id: 'network.web-bot-auth-verified',
          summary: `Web Bot Auth signature verified: ${who} (keyid ${result.keyid ?? '?'}${result.directory?.purpose ? `, purpose ${result.directory.purpose}` : ''})`,
          value: { identity: who, keyid: result.keyid },
          details: {
            verification: 'passed',
            method: 'web-bot-auth',
            identity: who,
            ...(result.directoryUrl ? { directory: result.directoryUrl } : {}),
            ...(result.keyid ? { keyid: result.keyid } : {}),
            ...(result.thumbprint ? { thumbprint: result.thumbprint } : {}),
            ...(result.label ? { label: result.label } : {}),
            ...(result.components ? { components: result.components } : {}),
            ...(result.created !== undefined ? { created: result.created } : {}),
            ...(result.expires !== undefined ? { expires: result.expires } : {}),
            ...(result.directory?.purpose ? { purpose: result.directory.purpose } : {}),
            ...(attr ? { knownOperator: attr.known } : {}),
          },
          provider: { id: attr?.provider ?? host ?? 'unknown', confidence: 0.99, product: attr?.product ?? host ?? who ?? 'web-bot-auth' },
          ...(attr?.classes ? { classes: attr.classes } : {}),
        });
        return;
      }
      const reliability = result.testKey ? 1 : FAILURE_RELIABILITY[result.status];
      api.emit({
        id: 'network.web-bot-auth-invalid',
        summary: result.testKey
          ? `Web Bot Auth signature uses the public RFC 9421 test key (never trusted)${who ? ` for ${who}` : ''}`
          : `Web Bot Auth ${result.status}: ${result.reason ?? 'unknown'}${who ? ` (${who})` : ''}`,
        value: { identity: who, keyid: result.keyid, reason: result.reason },
        details: {
          verification: 'failed',
          method: 'web-bot-auth',
          status: result.status,
          reason: result.reason ?? 'unknown',
          ...(who ? { identity: who } : {}),
          ...(result.keyid ? { keyid: result.keyid } : {}),
          ...(result.testKey ? { testKey: true } : {}),
        },
        reliability,
      });
    },
  };
}

function safeHost(u: string | undefined): string | undefined {
  if (!u) return undefined;
  try {
    return new URL(u).hostname;
  } catch {
    return undefined;
  }
}

/** Provider id for a directory URL/host (kept for backwards compatibility; see web-bot-auth/providers.ts). */
export function providerFromDirectory(directory: string): string {
  return providerFromDirectoryImpl(directory);
}
