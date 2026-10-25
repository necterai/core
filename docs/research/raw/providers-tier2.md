# Tier-2 AI operators: wire-level identity of crawlers, fetchers and agents

**Research date:** 2026-10-24
**Scope:** Meta, Perplexity, Microsoft, Amazon, Apple, xAI, ByteDance, Mistral, DeepSeek, Cohere, DuckDuckGo, You.com, Brave, Diffbot, Common Crawl, Huawei, Alibaba/Qwen, Moonshot/Kimi, Zhipu, Tencent/Baidu/01.ai (brief), plus the agent products the brief asked about (Meta Muse, Perplexity Comet, Microsoft Copilot Actions / Edge Copilot Mode / Magentic-UI, Amazon Nova Act / Rufus / Buy for Me, Apple Intelligence / Safari agent features, xAI Grok Bot, Manus, Genspark, Fellou, Dia/Arc, Opera Neon) and the smaller crawler operators named in the brief (AI2Bot, ImagesiftBot, omgili, Timpibot, Kangaroo Bot, Scrapy, Mozilla-Tabstack).
**Method:** Live web only. Primary vendor documentation was fetched directly wherever it exists; every published IP-list JSON endpoint was fetched to confirm it resolves and to record its format, size and `creationTime`; `/.well-known/http-message-signatures-directory` was probed on the domains most likely to sign agent traffic; two independent 2026 robots.txt/user-agent measurement write-ups were used for observed (as opposed to declared) behaviour. Third-party bot directories (knownagents.com, formerly darkvisitors; tryrankly; ai.robots.txt on GitHub) were used only where no primary doc exists and are labelled as such.
**Budget note:** The session's shared WebSearch budget ran out part-way through; the remainder of the research was done with direct fetches of known URLs. A few official pages are JavaScript-rendered or geo/bot-blocked and could not be read (Bing Webmaster help pages, Huawei's PetalBot page, Cloudflare Radar, GeekWire, DataDome, HUMAN's own blog without a reader). Where that happened the report says so.

**Confidence legend used throughout**
- **CONFIRMED** – read on the operator's own page or endpoint during this research.
- **OBSERVED** – reported from logs/tests by a named third party (measurement write-ups, security vendors), not stated by the operator.
- **REPORTED** – appears only in third-party directories; the operator has not published it. Treat as a hint, never as proof.
- **UNCERTAIN** – conflicting or unverifiable.

---

## 0. Executive summary for the detector team

1. **Declared identities are the easy half and are now machine-readable almost everywhere that matters.** Perplexity, Amazon, Apple, Mistral, Moonshot (Kimi), DuckDuckGo, Common Crawl, Microsoft (bingbot) and You.com all publish `{"creationTime": ..., "prefixes": [{"ipv4Prefix": ...}]}` JSON (the Google-style format). Meta publishes none. Several lists are tiny (Perplexity-User: 4 /32s; Mistral: 2 and 4 /32s; Kimi: the same 4 /32s for all three bots), which makes an IP+UA allow/deny rule cheap and precise.
2. **The user-initiated "fetcher" class ignores robots.txt by design and says so:** Perplexity-User ("generally ignores robots.txt rules"), Meta-ExternalFetcher ("may bypass robots.txt"), Amzn-User ("may not follow all robots.txt directives"), Kimi-User ("robots.txt rules may not directly apply"). Independent tests in June 2026 confirmed MistralAI-User and meta-webindexer fetched disallowed URLs while identifying themselves honestly. Robots compliance and honest identification are independent axes; score them separately.
3. **The Chinese operators and xAI are the stealth problem.** xAI publishes no crawler docs, no UA, no IPs; two independent 2026 tests saw Grok retrieval arrive as plain Mac/Chrome/Safari user agents from 17 and 59 rotating IPs (hosting + residential + commercial proxy) without ever requesting robots.txt. DeepSeek (Firefox-on-Linux UA from Huawei Cloud), Qwen (Chrome UA via country-rotating proxies) and Kimi (fake Windows UAs incl. "Windows NT 11.0" from a 10-IP proxy swarm) behaved the same way in the June 2026 test, even though Kimi publishes a clean crawler policy. ByteDance's Bytespider is the only one of them with a stable token and it is flagged `respect: No` by ai.robots.txt.
4. **Web Bot Auth is real but thin.** Confirmed key directories: OpenAI (`https://chatgpt.com`, `signature_agent` + `purpose: "ai"`), Google (`https://agent.bot.goog`, 5 keys), Meta (`https://www.meta.com`, 5 Ed25519 keys, no `kid`, no card metadata), Shopify (single JWK), You.com (1 key). Amazon ships it in Bedrock AgentCore Browser but **off by default**. Cloudflare says OpenAI, Google and AWS sign agent requests; Cloudflare's first signed-agent cohort (Aug 2025) was ChatGPT agent, Block's Goose, Browserbase and Anchor Browser. **Nobody in this tier besides You.com has documented a Signature-Agent value for a crawler**, and Microsoft, Perplexity, xAI, Mistral, DuckDuckGo, Apple all returned 404 on the well-known path. Meta's directory is the most interesting unknown: it exists, it is unpublicised, and Amazon says Muse "did not identify itself while browsing".
5. **Agentic browsers split into two architectures with different fingerprints.** (a) *Local, user's machine, user's IP, real Chromium*: Perplexity Comet, Opera Neon (Browser Operator), Edge Copilot Mode/Actions, Dia, Fellou (defunct), Manus Browser Operator extension, Claude for Chrome, Apple Safari MCP. These are invisible at UA/IP level and must be caught by in-page artifacts (Comet's hidden extension `npclhjbddhklpbnacpjloidibaggcgon`, overlay IDs `pplx-agent-overlay` / `pplx-agent-overlay-stop-button`; Genspark's `genspark-float-bar`; Manus Helper `mljmkmodkfigdopcpgboaalildgijkoc`) and by CDP-driven input (clicks with no `mousemove`, straight-line pointer paths, 0.25px coordinate steps). (b) *Hosted cloud computer, datacenter egress, real Chromium*: Meta Muse ("Muse Secure VM, a dedicated secure computer with its own browser"), xAI Grok Bot (Firecracker microVM, "shared static egress IP addresses", ranges only "available from your account team", hosted in "Cursor's cloud" per docs.x.ai), Amazon Nova Act on AgentCore Browser, Opera "Neon Make", Manus cloud agent, Genspark, Kimi Agent. These are catchable by ASN/datacenter heuristics plus whatever token they append (`NovaAct`, `Manus-User/1.0`, `Genspark/1.0.200`); Muse and Grok Bot append nothing that anyone has confirmed.
6. **Cloudflare has already shipped the taxonomy the market will converge on** (1 July 2026): behaviours Search / Agent / Training (+ Transact, Data Collection, …), content-use levels `immediate` / `reference` / `full`, and access type **Direct** (one operator, own infra) vs **Intermediary** (a service many end users drive, with experimental `Forwarded: for="openai";use="reference"` for transitive trust). Since 15 Sep 2026 new zones block Training and Agent on ad-bearing pages by default. Applebot, Bingbot and Googlebot got an "Accountable" mixed-use designation; Microsoft committed to a robots.txt no-training token "targeted for early 2027". A detector that labels traffic with the same vocabulary will be easier to sell and to reason about.
7. **What a major target actually blocks today:** Amazon's robots.txt (fetched 2026-10-24) has ~100 `Disallow: /` groups including `meta-externalagent`, `meta-externalfetcher`, `meta-webindexer`, `Perplexity-User`, `PerplexityBot`, `Manus-User`, `GrokBot`, `xAI-Grok`, `Grok-DeepSearch`, `Bytespider`, `MistralAI-User`, `DuckAssistBot`, `YouBot`, `Diffbot`, `PetalBot`, `PanguBot`, `ChatGLM-Spider`, `DeepSeekBot`, `Copilot`, `CopilotNative`, `CopilotSapphire` — but **no** `Muse`, `NovaAct`, `Amzn-User`, `Kimi-*`, `Qwen*`, `Applebot-Extended` or `bingbot`. Amazon blocked Muse with an anti-bot wall, not robots.txt.

---

## 1. Cross-cutting infrastructure

### 1.1 Web Bot Auth (HTTP Message Signatures for bots) – what is on the wire

Source: Cloudflare developer docs (CONFIRMED) – https://developers.cloudflare.com/bots/concepts/bot/verified-bots/web-bot-auth/

- Drafts referenced: `draft-meunier-http-message-signatures-directory-03`, `draft-meunier-web-bot-auth-architecture-02`. (A secondary source says the IETF WG adopted `draft-ietf-webbotauth-httpsig-protocol` in Sept 2026 — UNCERTAIN, not verified here.)
- Request headers: `Signature`, `Signature-Input` (required params `tag="web-bot-auth"`, `keyid` = JWK thumbprint, `created`, `expires`; `nonce` recommended but "currently no `nonce` validation"), `Signature-Agent` ("must be a structured string in double quotes over `https://`", e.g. `"https://signature-agent.test"`, and must be included in the signed component list; the newer dictionary form `sig2="..."` "is not accepted" by Cloudflare's verifier).
- Key directory: `/.well-known/http-message-signatures-directory`, a JWKS over HTTPS, `Content-Type: application/http-message-signatures-directory+json`, itself signed with `tag="http-message-signatures-directory"`; only `kty`, `crv`, `x` are used; Ed25519 only.
- Verification failure cases: `Signature-Agent` unquoted or not https, missing from component list, non-ASCII components, `bs`/`sf` params, `@query-params`, `@status`, `key`, `req`, `name`.
- Test endpoint: `https://crawltest.com/cdn-cgi/web-bot-auth` (401 unknown key, 200 verified, 400 malformed).
- Transitive trust (experimental): `Forwarded: for="openai";use="reference"`.
- Observed on the wire from OpenAI Operator (Security Boulevard, OBSERVED): `Signature-Input: sig1=("@authority" "@method" "@path" "signature-agent")…` and `Signature-Agent: "https://chatgpt.com"`.

Registry / card format (Cloudflare blog "Beyond IP lists", 30 Oct 2025, CONFIRMED – https://blog.cloudflare.com/agent-registry/): a registry is "a list of URLs pointing to Signature Agent keys"; a *Signature Agent Card* extends JWKS with `client_name`, `client_uri`, `logo_uri`, `contacts`, `expected-user-agent`, `rfc9309-product-token`, `rfc9309-compliance`, `trigger`, `purpose`, `targeted-content`, `rate-control`, `rate-expectation`, `known-urls`, `keys[]{kty,crv,kid,x,use,nbf,exp}`. Named implementers: Amazon Bedrock AgentCore Browser, Vercel, Visa, Shopify (`Signature-Agent: "https://shopify.com"`), Cloudflare.

### 1.2 Key-directory probes performed 2026-10-24 (all CONFIRMED by direct fetch)

| Domain probed | Result | Notes |
|---|---|---|
| `https://chatgpt.com/.well-known/http-message-signatures-directory` | **200, JSON** | `"signature_agent": "https://chatgpt.com"`, `"purpose": "ai"`, one key `kty OKP / crv Ed25519 / x P_1c4SX6fCavDcq6FRegWcVvaOKsp_aXHPEN1FcKDIA / kid ArwjqcCqtA5oxEWkzXGC-To_0A9whHmajCHtfe8I9aY / use sig / nbf 1735689600 / exp 1793485614` |
| `https://www.meta.com/.well-known/http-message-signatures-directory` (and `https://meta.com/...`) | **200, JWKS** | 5 keys, all `OKP/Ed25519`, **no `kid`, `use`, `nbf`, `exp`, no card fields**. `x` values: `vMEYr406dhzH8Tf8ClCCvt8D-MBTAkBHsnqz10iM5c0`, `zyr8gublkmFR2NH1NrOb8YxX_37l-j-MpDAnJLvSAJY`, `9SsjIMTl9VZq1ENHSf2O6546RqxEND4aY3qaSrir1aw`, `tKt3iCHBs2ZlHWb2n-MKjXvfPyj7SkHSXM02IBIdNRc`, `vZZN3dwDUvU8CGzrB_GVsstowD79eAYgLNM-Jof2Di0`. Meta documents this nowhere that was found. Which product signs with it (Muse? meta-externalfetcher? meta-webindexer?) is UNCERTAIN. |
| `https://agent.bot.goog/.well-known/http-message-signatures-directory` | **200, JWKS** | 5 Ed25519 keys with `kid` `mhxuPw`, `cYSMkA`, `bUCe2A`, `DYiMjA`, `Ggh50g` (Google-Agent; outside this tier but useful for the verifier). |
| `https://www.shopify.com/.well-known/http-message-signatures-directory` | **200, single JWK (not a JWKS)** | `kty OKP, crv Ed25519, x Mt6otbtH_mqWe1Qsm0cW9GVfknDvrGXXMpyXhiW0Dr4, use sig, alg EdDSA, kid SjjyXvQ2cGhsRXs9DXEaV6ClyCun0Pj5yxjV67dLGOk, nbf 1773401952, exp 1804937952`. |
| `https://you.com/.well-known/http-message-signatures-directory` | **200, JWKS** | `{"keys":[{"kty":"OKP","crv":"Ed25519","x":"0DJXAmXhPs6hq-7SHZFAFJZHW2-8zQNh8wkdD8UKZSM"}]}` (YouBot, documented). |
| `https://www.bing.com/…` | 404 | |
| `https://copilot.microsoft.com/…` | 302 → `https://www.bing.com/` | |
| `https://www.microsoft.com/…` | 404 | |
| `https://www.perplexity.ai/…`, `https://perplexity.ai/…` | 404 | |
| `https://manus.im/…`, `https://www.manus.im/…` | 404 | Cloudflare Radar reportedly lists Manus as a signed Intermediary agent (see §3.21), so the directory must be on another host – UNCERTAIN which. |
| `https://muse.ai/…` | 404 (`muse.ai` itself 307s to `auth.muse.ai`) | |
| `https://www.facebook.com/…`, `https://ai.meta.com/…` | 404 | `https://www.meta.ai/…` returned a Next.js streaming payload, not JSON. |
| `https://www.apple.com/…` | 404 | |
| `https://x.ai/…`, `https://grok.com/…` | 404 | |
| `https://duckduckgo.com/…`, `https://mistral.ai/…`, `https://www.genspark.ai/…`, `https://www.diffbot.com/…` | 404 | |
| `https://www.kimi.com/…` | soft-200 (served the HTML homepage) | |
| `https://www.amazon.com/…` | 503 | `https://nova.amazon.com/…` served a sign-in page; `https://buyforme.amazon/…` 301 → `https://www.amazon.com/b?node=204815148011`. |

### 1.3 Cloudflare's 2026 taxonomy and defaults (the vocabulary to reuse)

Sources (CONFIRMED): policy page https://developers.cloudflare.com/bots/concepts/bot/verified-bots/policy/ ; categories page https://developers.cloudflare.com/bots/concepts/bot/verified-bots/categories/ ; "Your site, your rules" (1 Jul 2026) https://blog.cloudflare.com/content-independence-day-ai-options/ ; "Have it both ways" (15 Sep 2026) https://blog.cloudflare.com/accountable-mixed-use-ai-crawlers/ ; "Continuous accountability for Verified bots" (16 Oct 2026) https://blog.cloudflare.com/verified-bots-accountability/ ; "BotBase for Operators" (28 Aug 2026) https://blog.cloudflare.com/botbase-for-operators/ ; "The age of agents" (28 Aug 2025) https://blog.cloudflare.com/signed-agents/

- Verified-bot bar: "it declares who it is deterministically, through a cryptographic Web Bot Auth signature" or "a published IP list with a stable user-agent, or reverse DNS"; and "it obeys robots.txt and crawl directives, maintains reasonable request rates".
- **Direct** = "Operated by a single, narrow operator — usually on the operator's own infrastructure … Only that operator can send requests that present as this bot." **Intermediary** = "An agentic service that a wide range of end users can operate."
- Behaviours: Search, Agent ("User-directed agents visiting a page on behalf of a human"; "Includes chat fetch bots and browser-use agents"), Training, Transact, Data Collection, Security Testing, SEO, Ads Verification, Social / Link Preview, Feed Fetching, Monitoring & Operations. Legacy labels still visible: *AI Assistant* ("Automated AI bot driven by user action", examples **Perplexity-User, DuckAssistBot**), *AI Crawler*, *AI Search* (example OAI-SearchBot), *Archiver* (examples Internet Archive, **CommonCrawl**).
- Content-use levels: `immediate` (store nothing), `reference` (default: index, excerpt, link back), `full` (summarize and reproduce). Content-Signal example: `Content-Signal: search=yes, ai-train=no, use=reference`.
- 1 Jul 2026: Search/Agent/Training manageable separately on all plans incl. Free; "Verified status no longer means 'default allowed'". 15 Sep 2026 (new domains): Training and Agent blocked by default on pages with ads; multi-purpose crawlers follow the most restrictive rule.
- "Accountable" mixed-use crawlers: **Applebot, Bingbot, Googlebot**. Apple: training opt-out via `Applebot-Extended`, summaries via `nosnippet`, URL-level inspection "next year". Microsoft: training preference today only via `NOARCHIVE` meta tag; robots.txt no-training token "targeted for early 2027"; "Until that support launches, selecting Disallow AI Training will not automatically convey a no-training preference to Bing through robots.txt."
- Accountability: "de-listed Perplexity's bot from our Verified bot list in 2025" after it "accessed resources on sites that had opted out of scraping and tried to get around blocks". Trust band measured on robots.txt adherence over time and reaction to HTTP 429.
- Signed-agent cohort (Aug 2025): ChatGPT agent (OpenAI), Goose (Block), Browserbase, Anchor Browser, plus Cloudflare Browser Rendering. "The Internet has a second audience" (30 Sep 2026, https://blog.cloudflare.com/agentic-web/): "operators, including OpenAI, Google, and AWS, cryptographically sign their agents' requests"; "daily requests from AI agents on our network grew by more than 1,700%"; 52% of crawler requests were for AI training by June 2026 (22% in Spring 2025); "Fewer than 1% of sites on Cloudflare block search crawlers, while 17% block training."
- Precursor (13 Jul 2026, https://blog.cloudflare.com/introducing-precursor/): client-side script captures "pointer movement, keyboard activity, focus changes, and visibility" (keyboard "as timing and rhythm, not as the actual keys pressed"), checks cross-stream consistency ("pointer activity correlates with page visibility duration"; "keyboard events only fire when a text field is focused"), flags "linear interpolations or mathematically ideal Bézier curves"; session-scoped so "a bot cannot reset its behavioral signature by refreshing the page". This is the closest public description of what a client-side SDK competitor does.

### 1.4 Independent robots.txt / identity measurements (OBSERVED)

**A. searchengineworld.com, "Do AI Assistants Actually Respect Your robots.txt? We Put 12 of Them to the Test" (published 20 Jun 2026, updated 2 Jul 2026)** – https://www.searchengineworld.com/do-ai-assistants-actually-respect-your-robots-txt-we-put-12-of-them-to-the-test
Method: two never-linked canary URLs per assistant (one allowed, one disallowed twin, each with a unique reference number), pasted into the assistant by hand; full headers logged; IP checked against published ranges and rDNS.

| Assistant | UA observed | Honoured robots.txt? | Source network |
|---|---|---|---|
| ChatGPT | `ChatGPT-User` | Yes | inside OpenAI published range |
| Claude | `Claude-User` | Yes | rDNS → Google Cloud |
| Perplexity | `Perplexity-User`; `From: crawler-support@perplexity.ai` | Yes (caveat on self-report) | IP-verified |
| Gemini | bare `Google` | No | Google proxy infra |
| **Microsoft Copilot** | plain Linux Chrome, no bot token | No | **Diffbot, AS6939 (Hurricane Electric)** |
| **Meta AI** | `meta-webindexer/1.1` | No | Meta IPs |
| **Mistral** | `MistralAI-User` | No | rDNS `crawlers.mistral.ai` |
| **Grok (xAI)** | faked Mac browser UAs | No | 17 distinct IPs (France, Italy, Mexico, Brazil, Chile, …) |
| **DeepSeek** | faked Firefox-on-Linux UA | No | Huawei Cloud |
| **Qwen (Alibaba)** | faked Chrome UA | No | country proxies (Norway, then Turkey) |
| **ERNIE (Baidu)** | `Baiduspider` on allowed page; forged strings incl. `Go-http-client/1.1` and `pc` on blocked page | No | Baidu IPs + third-party Chinese hosting |
| **Kimi (Moonshot)** | faked browser UAs incl. `Windows NT 11.0` | No | 10-IP worldwide proxy swarm |

**B. southasiadigital.com, "Which AI Crawlers Actually Respect robots.txt in 2026? A Real IP/Proxy Test" (16 Oct 2026)** – https://southasiadigital.com/which-ai-crawlers-respect-robots-txt/
Grok: six test requests → **59 distinct IPs, none reused**, bursts of 9–12 IPs within seconds, "hosting providers and small residential ISPs in multiple countries, and at least one range traced to a commercial proxy provider"; robots.txt never requested; UA "a standard Chrome or Safari browser". Cites a Feb 2026 analysis: "none of xAI's own documented crawler names ever appeared in its logs." Claude fetched robots.txt first and declined the canary; ChatGPT's first request skipped robots.txt, then OAI-SearchBot read it ~76 s later and later requests were refused; Gemini used a "bare 'Google' user agent" from IPs outside Google's published crawler ranges; PerplexityBot read robots.txt.

Implication: UA honesty, robots compliance and IP verifiability are three separate scores. The "fetcher" class (Perplexity-User, MistralAI-User, meta-webindexer, Amzn-User, Kimi-User) is honest but non-compliant by policy; Grok/DeepSeek/Qwen/Kimi-chat are dishonest and non-compliant; ChatGPT-User/Claude-User are honest and compliant.

### 1.5 Community token list (ai.robots.txt) – REPORTED

https://raw.githubusercontent.com/ai-robots-txt/ai.robots.txt/main/robots.json (200 entries on 2026-10-24). Entries relevant to this tier and *not* documented by any operator page found: `Muse` (operator "Meta", function "AI Agents"), `Manus-User`, `NovaAct`, `AmazonBuyForMe`, `amazon-QBusiness`, `bedrockbot`, `Kimi-Agent`, `MoonshotBot`, `QwenBot`, `TongyiBot`, `DoubaoBot`, `TikTokSpider`, `ChatGLM-Spider`, `GrokBot`, `GrokAppAndroid`, `xAI-Grok`, `Grok Bot`, `DeepSeekBot` (`respect: No`), `Bytespider` (`respect: No`), `PanguBot`, `Hunyuan`, `ERNIEBot`, `YiyanBot`, `YiBot`, `cohere-ai`, `cohere-training-data-crawler`, `Diffbot-User`, `Mozilla-Tabstack`, `FacebookBot`, `Webzio-Extended`, `Timpibot`, `Kangaroo Bot`, `AI2Bot-DeepResearchEval`, `Ai2Bot-Dolma`, `ShapBot`/`Shap-User` (Parallel), `ExaUser`/`ExaSearchBot`, `LinkupBot`, `TavilyBot`. Use the list as a *token vocabulary*, not as evidence of what a given operator actually sends.

---

## 2. What a big target blocks: Amazon's robots.txt (fetched 2026-10-24, CONFIRMED)

`https://www.amazon.com/robots.txt` – every group except `*` is `Disallow: /`. Tokens in file order:
EtaoSpider, GPTBot, CCBot, PerplexityBot, Google-Extended, GoogleAgent-Mariner, GoogleAgent-Shopping, ClaudeBot, meta-externalagent, Bytespider, Scrapy, PetalBot, Devin, omgili, AI2Bot, Gemini-Deep-Research, PanguBot, MistralAI-User, Diffbot, Sidetrade indexer bot, Google-NotebookLM, DuckAssistBot, **Copilot**, Ai2Bot-Dolma, Google-CloudVertexBot, meta-externalfetcher, iaskspider, wpbot, aiHitBot, cohere-ai, FriendlyCrawler, img2dataset, VelenPublicWebCrawler, YouBot, Brightbot, Claude-User, ClaudeBot (again), Claude-SearchBot, Perplexity-User, ISSCyberRiskCrawler, **CopilotNative**, **CopilotSapphire**, imgproxy, SemrushBot-SWA, ChatGPT-User, OAI-SearchBot, Timpibot, Thinkbot, AddSearchBot, AI2Bot-DeepResearchEval, Andibot, Anomura, atlassian-bot, BuddyBot, Channel3Bot, ChatGLM-Spider, Claude-Web, Cloudflare-AutoRAG, CloudflareBrowserRenderingCrawler, cohere-training-data-crawler, Cotoyogi, Crawl4AI, Datenbank Crawler, DeepSeekBot, Echobot Bot, EchoboxBot, factset_spyderbot, Google-Firebase, GoogleOther, **Grok-DeepSearch**, **GrokBot**, iAskBot, IbouBot, ICC-Crawler, ImagesiftBot, imageSpider, Kangaroo Bot, KlaviyoAIBot, KunatoCrawler, laion-huggingface-processor, Linguee Bot, LinkupBot, Manus-User, meta-webindexer, netEstate Imprint Crawler, Panscient, panscient.com, PhindBot, Poggio-Citations, QualifiedBot, SBIntuitionsBot, ShapBot, TavilyBot, TerraCotta, TwinAgent, webzio-extended, WRTNBot, **xAI-Grok**, YaK, ZanistaBot.

Absent: `Muse`, `muse-`, `NovaAct`, `Amzn-User`, `Kimi-*`, `Qwen*`, `Comet`, `Google-Agent`, `facebookexternalhit`, `Applebot-Extended`, `bingbot`.
`Copilot`, `CopilotNative`, `CopilotSapphire` and `Grok-DeepSearch` are not documented by Microsoft or xAI anywhere found (knownagents.com has no pages for them either) – UNCERTAIN whether they are real UA tokens or defensive guesses. ("Sapphire" is the long-standing internal name of the Bing/Copilot mobile app, which makes `CopilotSapphire` plausible as an in-app fetch token, but that is inference.)

---

## 3. Per-operator detail

### 3.1 Meta

**Official page (CONFIRMED):** https://developers.facebook.com/docs/sharing/webmasters/web-crawlers (Markdown twin: https://developers.facebook.com/documentation/sharing/webmasters/web-crawlers.md). Five crawlers, each with a long and a short UA form:

| Crawler | UA strings (verbatim) | Purpose (Meta's words) | robots.txt |
|---|---|---|---|
| FacebookExternalHit | `facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)` / `facebookexternalhit/1.1` | link previews for Facebook, Instagram, Messenger | "might bypass robots.txt when performing security or integrity checks" |
| Meta-WebIndexer | `meta-webindexer/1.1 (+/documentation/sharing/webmasters/web-crawlers)` / `meta-webindexer/1.1` | improves Meta AI search result quality / citations | governed by robots.txt (but see test: fetched a disallowed URL) |
| Meta-ExternalAds | `meta-externalads/1.1 (+/documentation/sharing/webmasters/web-crawlers)` / `meta-externalads/1.1` | advertising / business products | governed |
| Meta-ExternalAgent | `meta-externalagent/1.1 (+/documentation/sharing/webmasters/web-crawlers)` / `meta-externalagent/1.1` | "training foundation AI models or improving products by indexing content directly" | governed |
| Meta-ExternalFetcher | `meta-externalfetcher/1.1 (+/documentation/sharing/webmasters/web-crawlers)` / `meta-externalfetcher/1.1` | "Fetches individual links at a user's request" incl. "helping AI navigate sites to complete tasks" | "may bypass robots.txt because it performs fetches that were requested by the user" |

Notes:
- The `+/documentation/...` URL in the UA is a *relative* path – a cheap sanity check (a spoofer who "fixes" it to an absolute URL is wrong). An older absolute form `meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)` is REPORTED by third parties.
- "Please allow up to 24 hours for changes to `robots.txt` to take effect".
- **IP verification: Meta publishes no IP list, no rDNS pattern and no longer prints the old `whois -h whois.radb.net -- '-i origin AS32934'` guidance** – the page only says "Add to your allow list either the user agent strings or the IP addresses (more secure) used by the crawler" and links to an in-page anchor. Practical approach: AS32934 (Facebook) prefix set from RADB/BGP data – UNCERTAIN whether all Meta AI fetchers egress from AS32934.
- **FacebookBot** (speech-recognition training, "Up to 1 page per second" per ai.robots.txt) is no longer on Meta's crawler page; `https://developers.facebook.com/docs/sharing/bot` now serves the web-crawlers page and `llms.txt` lists no FacebookBot doc. Treat as legacy/unknown status.
- Observed: `meta-webindexer/1.1` fetched a robots-disallowed canary from Meta IPs (searchengineworld, June 2026). ai.robots.txt reports its frequency as "More than 1 per second".
- Web Bot Auth: **Meta serves a 5-key Ed25519 JWKS at `https://www.meta.com/.well-known/http-message-signatures-directory`** (see §1.2). Undocumented; product mapping UNCERTAIN.

**Meta Muse (the "Meta Muse" the project owner asked about) – CONFIRMED facts**
- Announced 8 Sep 2026 (Meta Newsroom: https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/). "Personal AI agent" for long-running tasks; "powered by Muse Spark" (Muse Spark introduced Apr 2026; Muse Spark 1.1 on 9 Jul 2026, https://ai.meta.com/blog/introducing-muse-spark-meta-model-api/). US launch on iOS, Android and `muse.ai`; free tier plus $20/$100 plans (Wikipedia).
- **Architecture:** "Muse Secure VM, a dedicated secure computer with its own browser" in Meta's cloud; a "Sentinel" agent on the same machine must approve anything Muse sends to the internet; "Muse can open a browser, fill out forms, and negotiate on their behalf"; checkout via "Link built by Stripe" one-time cards, Shop Pay "coming soon"; credentials in secure storage usable without the model seeing them (Meta's "authd" with surrogate tokens is cited second-hand); 1Password support planned; "Muse Confidential VM" (user-held key) planned. Meta (quoted via nohacks.co) says Muse drives "a real up-to-date Chromium based browser". Each user gets a separate VM (Wikipedia).
- 23 Sep 2026 additions (TechCrunch): control of macOS apps ("Muse will be able to operate any app on a user's desktop"), a dedicated agent email address, glasses wake word, Realtime Avatar, a developer/connector platform (1,500+ applications in a week), commerce partners Shopify (full catalog), Stripe, PayPal, Best Buy, Gap, Sephora, Walmart, Wayfair, Expedia, Instacart; revenue "taking a small fee from transactions". Muse for Small Business 29 Sep 2026.
- **Amazon block (20–21 Sep 2026):** users saw "Continued access by an unauthorized AI agent violates Amazon's Conditions of Use, to which our customers have agreed." Amazon told GeekWire that Meta had not notified it, that the agent "did not identify itself while browsing", and that it appeared to capture and store customer credentials (Meta denies). Amazon: agents "should operate openly and respect service provider decisions about whether or not to participate"; Amazon also said its own Buy for Me agent identifies itself to other retailers and lets them opt out (The Register). The Register's own test: Muse reported "Hit a snag: Amazon is showing an anti-bot wall that blocks automated browsers outright" and "I didn't push past it, since the notice says continuing would violate Amazon's terms." Amazon's robots.txt contains no Muse token; the block was an anti-bot wall. Shopify and (reportedly) Walmart allow Muse.
- **Identity on the wire:** No UA, IP range, header or Signature-Agent has been published by Meta; Meta's crawler page does not list Muse (checked 2026-10-24). REPORTED only: knownagents.com says to grep for `Muse`; aicrawlercheck.com says Cloudflare Radar lists a token `muse-` as an "automated AI agent client associated with Meta's Muse product" (Radar itself returned 403 here). ai.robots.txt has an entry `Muse`. UNCERTAIN until observed in logs. Given the Secure-VM design, expect: datacenter egress (likely Meta AS32934 or a cloud ASN), a current-Chrome UA, real JS execution, cookies and forms, approvals that pause before purchase, and possibly Web Bot Auth signatures against the `www.meta.com` directory.
- Incidents: 404 Media (22 Sep 2026) – some "automated" Muse phone calls were completed by human call-centre workers; Claroc/Ars Technica (18–20 Oct 2026) – shared Muse chats discoverable via passive DNS; sharing suspended.

### 3.2 Perplexity

**Official page (CONFIRMED):** https://docs.perplexity.ai/guides/bots
- `PerplexityBot`: `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)` – "not used to crawl content for AI foundation models"; IP list `https://www.perplexity.com/perplexitybot.json` (302 → `https://www.perplexity.ai/perplexitybot.json`): **8 prefixes**, `creationTime 2025-02-07T16:56:00.000000` – `107.20.236.150/32, 3.224.62.45/32, 18.210.92.235/32, 3.222.232.239/32, 3.211.124.183/32, 3.231.139.107/32, 18.97.1.228/30, 18.97.9.96/29` (AWS).
- `Perplexity-User`: `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Perplexity-User/1.0; +https://perplexity.ai/perplexity-user)` – "Since a user requested the fetch, this fetcher generally ignores robots.txt rules"; IP list `https://www.perplexity.com/perplexity-user.json` (→ `.ai`): **4 prefixes**, `creationTime 2025-10-17T10:17:00.000000` – `44.208.221.197/32, 34.193.163.52/32, 18.97.21.0/30, 18.97.43.80/29`.
- Perplexity recommends pairing UA match with IP-set membership in Cloudflare/AWS WAF; "changes can take up to 24 hours". Observed header: `From: crawler-support@perplexity.ai` (June 2026 test). No rDNS pattern, no Web Bot Auth (well-known path 404).
- **Stealth history:** Cloudflare removed Perplexity from its Verified list in 2025 because its bot "accessed resources on sites that had opted out of scraping and tried to get around blocks" (CONFIRMED in the Oct 2026 Cloudflare post; Cloudflare's original Aug 2025 write-up about generic-Chrome UAs from undeclared ASNs could not be fetched this session – its slug returned 404). Any Perplexity-attributable traffic outside the two JSON lists should be scored as evasive.

**Perplexity Comet (agentic browser) – identity**
- Chromium-based desktop browser launched July 2025 (Max subscribers first). Prosopo: "Comet runs on the user's own machine", traffic comes from residential addresses, "no published IP range covers it"; "autonomous background agents need Pro or Max" (execution location of background agents not stated). MIT AI Agent Index: "Comet primary sources reviewed do not publish or document Comet's default User-Agent string"; Digiday: "requests appear to come from a user's residential IP addres[s]".
- HUMAN Security (OBSERVED, Oct 2025 analysis of Comet vs Atlas): `navigator.userAgent` = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36`; `navigator.userAgentData.brands` = Chromium 142 / Google Chrome 142 / Not_A Brand 99 – identical to Chrome; Google TTS voices preserved in `speechSynthesis`; `comet://extensions/` appears empty but an internal extension is active in agent mode and injects `overlay.js` (element highlighting, overlays, progress indicators, input blocking, screenshot capture). Arkose: Comet "stays closer to stock Chrome but layers its agentic features in through an internal extension."
- Security Boulevard (OBSERVED, Aug 2025, code excerpts): no self-identification in headers or UA; "no obvious global variables like `window.brave`"; content script `comet-agent/content.js`; `chrome://extensions` redirects to `comet://extensions` where the extension is hidden; `const B = "npclhjbddhklpbnacpjloidibaggcgon";` with background at `comet-extension://npclhjbddhklpbnacpjloidibaggcgon/background.js`; DOM ids `const p = "pplx-agent-overlay", O = "pplx-agent-overlay-stop-button";`, button text `"Stop Comet Assistant"`; overlay style `position: "fixed", inset: "-1em", … opacity: "0", cursor: "progress"`; a probe `color === 'rgb(255, 254, 251)'` on the overlay button "works whether the agent is active or not"; behaviour: clicks are dispatched via CDP `Input.dispatchMouseEvent` (`"mousePressed"`) with **no `mousemove` events**. HUMAN also described one Comet session with a carding-like pattern.
- Legal: Amazon v. Perplexity – preliminary injunction 9 Mar 2026, vacated by the Ninth Circuit 4 Aug 2026; agent currently unrestrained (Prosopo).
- Detector hooks: MutationObserver for `#pplx-agent-overlay-stop-button`; resource probe for the extension ID; click-without-mousemove; UA/UA-CH exactly Chrome; residential IP.

### 3.3 Microsoft

**Bing crawlers.** Bing's help page is JS-rendered and could not be read directly; strings below come from Bing's own 2022 UA-change announcement (CONFIRMED – https://blogs.bing.com/webmaster/2022/4/Announcing-user-agent-change-for-Bing-crawler-bingbot/), xseek's transcription of the current help page, udger's UA database and knownagents (REPORTED for MicrosoftPreview's long form).
- bingbot desktop: `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm) Chrome/W.X.Y.Z Safari/537.36` (W.X.Y.Z = current stable Edge version; udger shows `Chrome/116.0.1938.76`, `Chrome/136.0.0.0`, `Chrome/112.0.0.0`, `Chrome/100.0.4896.127` variants, plus a duplicated-token-chain variant).
- bingbot mobile: `Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/W.X.Y.Z Mobile Safari/537.36 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)`.
- legacy (still seen in 2026 per udger): `Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)`.
- adidxbot: `Mozilla/5.0 (compatible; adidxbot/2.0; +http://www.bing.com/bingbot.htm)`.
- BingPreview (legacy screenshot bot): `Mozilla/5.0 (Windows NT 6.1; WOW64) AppleWebKit/534+ (KHTML, like Gecko) BingPreview/1.0b`; the current help page says BingPreview now uses the bingbot/2.0 token.
- MicrosoftPreview: `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; MicrosoftPreview/2.0; +https://aka.ms/MicrosoftPreview) Chrome/W.X.Y.Z Safari/537.36` (robots token `MicrosoftPreview`; renders link previews across Teams/Outlook/SharePoint/Copilot per DataDome; knownagents lists it as *not* expected to follow robots.txt, Bing's page says it does – UNCERTAIN).
- Verification (CONFIRMED): `https://www.bing.com/toolbox/bingbot.json` – **28 prefixes**, `creationTime 2024-01-03T10:00:00.121331`, first entries `157.55.39.0/24, 207.46.13.0/24, 40.77.167.0/24, 13.66.139.0/24, 13.66.144.0/24, 52.167.144.0/24, 13.67.10.16/28, 13.69.66.240/28, 13.71.172.224/28, 139.217.52.0/28`; rDNS suffix `search.msn.com` (udger samples: `msnbot-<ip-with-dashes>.search.msn.com`; some 20.x/40.x bingbot IPs have no rDNS). Bing's "Verify Bingbot" tool.
- AI-use controls (CONFIRMED – Bing blog Sept 2023): `<meta name="robots" content="noarchive">` → "will not be included in Bing Chat answers" nor used for training; `nocache` → URL/title/snippet only; `<meta name="bingbot" content="nocache">` scopes to bingbot. **There is no Copilot crawler token**; "Bingbot powers Copilot answers". Microsoft's robots.txt no-training token is "targeted for early 2027" (Cloudflare, Sep 2026).
- **Observed:** Copilot's live page fetch for a user prompt arrived with a plain Linux Chrome UA and no bot token from Diffbot infrastructure, AS6939 (searchengineworld, June 2026). Nohacks: "Copilot Actions: Uses standard Edge/Chromium user agents with no bot signal."
- Web Bot Auth: `bing.com`, `microsoft.com` 404; `copilot.microsoft.com` redirects to bing.com.

**Copilot Mode / Copilot Actions / Edge for Business agentic browsing**
- Copilot Mode in Edge shipped mid-2025 (secondary sources: July 2025); Actions = multi-step tasks in the user's own browser using the current session; Journeys = browsing grouped into tasks. Microsoft's product page (CONFIRMED – https://explore.microsoft.com/en-us/edge/copilot-mode): "Copilot works in your browser, using your tabs to compare options…"; nothing about identification to websites. One secondary source claims the "Copilot Mode" brand was retired 13 May 2026 – UNCERTAIN.
- Edge for Business agentic browsing (CONFIRMED – Edge blog 20 May 2026): limited preview, "Available worldwide with a Microsoft 365 Copilot license, excluding the European Economic Area"; "scoped to sites you designate"; "clear visual indicators show when Copilot is taking action"; "For sensitive actions such as entering passwords or credit card numbers, Copilot pauses for user input"; Purview DLP enforced. Secondary reports say the agent runs in an isolated tab without personal cookies – UNCERTAIN.
- **WebMCP** (CONFIRMED – Edge blog 21 Sep 2026 + spec README): Edge's WebMCP implementation "is ready for testing" behind `about://flags/#enable-webmcp-testing`; a "WebMCP Explorer" extension exists; the spec API is `document.modelContext.registerTool(tool, options)`, `getTools()`, `executeTool()`, a `toolchange` event, `allow="tools"` Permissions Policy, `exposedTo` / `fromOrigins`; "No flag or event indicates that an agent is present"; a `native-agent` keyword is under consideration. **Hook:** a site that registers a decoy tool and watches for `executeTool` calls gets a positive agent signal with zero false positives from humans.
- Microsoft has published no UA, header or client hint for Copilot Actions; treat as local-browser class (user IP, Edge UA).

**Magentic-UI** (Microsoft Research open-source web agent, CONFIRMED README/config): Playwright-driven WebSurfer; browser sessions "run inside a lightweight VM sandbox" ("quicksand": "Lightweight QEMU VM with browser isolation (recommended)"; `null` = no isolation); recommended browser-use model "Fara"; Docker for code execution. No UA customisation documented → expect Playwright/Chromium defaults (and Playwright artifacts such as `navigator.webdriver` unless patched) from whatever network the operator runs it on.

### 3.4 Amazon

**Official page (CONFIRMED):** https://developer.amazon.com/amazonbot
- `Amazonbot`: `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Amazonbot/0.1) Chrome/W.X.Y.Z Safari/537.36` – "may be used to train Amazon AI models"; RFC 9309, robots cached 30 days, no `crawl-delay`, honours `rel=nofollow`, `noindex`, `none`, and **`noarchive` = do not use for model training**. IP list `https://developer.amazon.com/amazonbot/ip-addresses/` (HTML page with inline JSON): ~1,290 entries, key `ipv4Prefix`, **bare IPs without CIDR suffix**, `creationTime 2026-09-08T05:24:10.610952+00:00` (3.x AWS us-east-1 addresses).
- `Amzn-SearchBot`: `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Amzn-SearchBot/0.1) Chrome/W.X.Y.Z Safari/537.36` – search experiences incl. Alexa, not generative training; IP list `https://developer.amazon.com/amazonbot/searchbot-ip-addresses/`: ~860 entries, **key `ip_prefix`** (note the different key), `/32` CIDRs, `creationTime 2026-09-08T05:24:10.610952+00:00`.
- `Amzn-User`: `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Amzn-User/0.1) Chrome/W.X.Y.Z Safari/537.36` – "fetches live information to answer user requests, such as Alexa queries"; "Because actions taken by Amzn-User can be initiated by a user, it may not follow all robots.txt directives."; IP list `https://developer.amazon.com/amazonbot/live-ip-addresses/` ("Amazonbot Live Crawl IP addresses"): ~1,023 entries, key `ipv4Prefix`, bare IPs, `creationTime 2025-11-04T15:57:38.092840+00:00`.
- No rDNS pattern documented; no Web Bot Auth for these three. An older Amazonbot form `Mozilla/5.0 (compatible; Amazonbot/0.1; +https://developer.amazon.com/support/amazonbot) Chrome/119.0.6045.214 Safari/537.36` is REPORTED.
- Related tokens REPORTED only: `bedrockbot` (Bedrock knowledge-base web crawler), `amazon-kendra`, `amazon-QBusiness`, `AmazonBuyForMe`.

**Nova Act** (CONFIRMED – https://github.com/aws/nova-act README; API reference): "If you are using our browsing environment defaults, look for `NovaAct` in the user agent string to identify our agent. If you operate Nova Act in your own browsing environment or customize the user agent, we recommend that you include that same string." `NovaAct(..., user_agent="MyUserAgent/2.7")` overrides Playwright's UA (`user_agent: str | None`, "Optionally override the user agent used by playwright."); `headless` defaults `False` (`NOVA_ACT_HEADLESS`); `chrome_channel` defaults `"chrome"` (`"chromium"`, `"chrome-beta"`, `"msedge"` allowed); `proxy={server,username,password}`; `cdp_endpoint_url` to attach to any CDP browser (proxy then unsupported); "Nova Act comes with Playwright's Chrome and Chromium browsers"; clean cloned user-data-dir per run; hosted option = Bedrock AgentCore Browser. **Exact default UA string containing `NovaAct` is not printed anywhere found – UNCERTAIN; match `NovaAct` as a substring.** knownagents: "NovaAct does not publish a verification method"; no IP list.
- **Bedrock AgentCore Browser** (CONFIRMED – AWS docs): containerised managed Chromium with CDP automation endpoint, Live View, session recording (DOM changes, actions, console, network) to S3; sessions default 15 min, max 8 h. **Web Bot Auth (Preview)** adds `Signature`, `Signature-Agent`, `Signature-Input`; "Amazon Bedrock AgentCore registers with bot control vendors (Cloudflare, reCAPTCHA, etc.)"; supported verifiers **Cloudflare, HUMAN Security, Akamai Technologies, DataDome, F5**; **"The feature is disabled by default and must be explicitly enabled during browser creation"** (`--browser-signing '{"enabled": true}'`). The Signature-Agent/key-directory URL AWS uses is not printed in the doc – UNCERTAIN. Secondary: AWS and Cloudflare announced a joint key registry in Feb 2026 (UNCERTAIN).

**Buy for Me / Rufus / Alexa+** – Buy for Me (announced 3 Apr 2025) visits an external retailer, selects the product and fills name/address/payment ("uses encryption to 'securely' insert your billing information"); "powered by its Amazon Nova AI models, in addition to Anthropic's Claude" (TechCrunch, CONFIRMED). Amazon told The Register its agent identifies itself to retailers and lets them opt out (CONFIRMED quote, mechanism unspecified). CNBC (Jan 2026, not fetchable) reported merchants receiving orders without opting in. REPORTED token `AmazonBuyForMe` (knownagents: "not expected to follow robots.txt"; official site `https://buyforme.amazon/` 301s to an Amazon category page). Rufus/Alexa+ reportedly merged into "Alexa for Shopping" (May 2026, single secondary source – UNCERTAIN); live fetches for Alexa answers are documented as `Amzn-User`.

### 3.5 Apple

**Official page (CONFIRMED):** https://support.apple.com/en-us/119829
- Desktop: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15 (Applebot/0.1; +http://www.apple.com/go/applebot)`
- Mobile: `Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Mobile/15E148 Safari/604.1 (Applebot/0.1; +http://www.apple.com/go/applebot)` (Apple "occasionally updates the browser version it advertises").
- Separate `User-Agent: iTMS` for Apple Podcasts URLs (ignores robots.txt).
- Verification: rDNS in `applebot.apple.com` (example `17-58-101-179.applebot.apple.com`) with forward confirmation, or `http://search.developer.apple.com/applebot.json` – **24 prefixes**, `creationTime 2026-09-15T10:00:00.000000`, e.g. `17.241.208.160/27, 17.241.193.160/27, 17.241.200.160/27, 17.166.192.48/28, 17.166.240.48/28, 17.166.248.48/28, 17.166.20.0/24 … 17.166.23.0/24` (all 17.0.0.0/8 but the JSON is authoritative).
- Behaviour: follows Applebot rules, else **falls back to Googlebot rules**; ignores `crawl-delay`; "may render pages in a browser"; honours `noindex, nosnippet, nofollow, none, all` and `X-Robots-Tag: applebot: nosnippet`; `isAccessibleForFree` for paywalls.
- `Applebot-Extended`: robots token only – "does not crawl pages"; disallowing stops use for "training its general-purpose foundation models, including those behind Apple Intelligence"; no effect on ranking. Crawled data also "may supply context for AI-generated answers in Siri and Search" – `nosnippet` opts out.
- Cloudflare "Accountable" designation (Sep 2026); URL-level inspection promised "next year". No Web Bot Auth (apple.com 404).

**Apple Intelligence / Safari agent features (CONFIRMED – WebKit blog "WebKit Features for Safari 27.0", 17 Sep 2026; idownloadblog 5 Oct 2026):**
- **Safari MCP**: "makes working with coding agents dramatically easier"; agents can see rendering, verify form/checkout states, accessibility, performance; "runs entirely on your local machine"; "does not have access to your personal information in Safari"; enabled via Safari ▸ Settings ▸ Developer ▸ **"Allow remote automation and external agents"**; e.g. `claude mcp add safari-mcp -- "/usr/bin/safaridriver" --mcp`. Traffic is the user's own Safari on the user's IP → local-browser class; safaridriver-driven sessions are WebDriver sessions (expect `navigator.webdriver === true` as with any WebDriver automation – inference, not stated by Apple).
- **"Notify Me"**: "Safari in OS 27 can do background checks on a website at a set time" and alerts on the described change (Apple Intelligence required) → periodic unattended fetches from residential IPs with a normal Safari UA.
- **Passwords auditing** (future update): Passwords app "use Safari to automatically fix weak and compromised passwords" – agentic navigation of sign-in/change-password flows.
- Siri with web answers, AI tab grouping, "build extension by describing" – not agentic browsing. No Safari "agent mode" that autonomously shops/books was found.

### 3.6 xAI (Grok)

- **No crawler documentation, UA or IP list exists** (multiple 2026 references agree; `x.ai` / `grok.com` key directories 404). REPORTED tokens with no vendor page: `GrokBot` (knownagents prints `Mozilla/5.0 (compatible; GrokBot/1.0; +https://x.ai/)` and admits "xAI has not confirmed any of this"), `xAI-Grok`, `Grok-DeepSearch`, `xAI-Bot`, `xAI-SearchBot`, `GrokAppAndroid`; aicrawlercheck says Cloudflare Radar lists `GrokAgent` (UNCERTAIN). Amazon blocks `GrokBot`, `xAI-Grok`, `Grok-DeepSearch` in robots.txt.
- **OBSERVED retrieval behaviour:** faked Mac browser UAs from 17 IPs in many countries, robots ignored (June 2026); 59 distinct IPs over six requests, bursts of 9–12 IPs, hosting + residential + commercial proxy, robots.txt never requested (Oct 2026); DataDome (early 2026): Chrome-on-macOS and Safari-on-iPhone UAs. Treat Grok's web retrieval as an unidentified residential-proxy scraper; detectable only behaviourally (burst of near-simultaneous single-page fetches from unrelated IPs, no robots.txt, no subresources).
- **Grok Bot (hosted agent, CONFIRMED – docs.x.ai):** "Grok Bot runs only on Cursor-hosted cloud computers"; "The computers Bots work on run in Cursor's cloud"; each Bot has "a persistent cloud computer with a browser, filesystem, and terminal"; "Each user gets a dedicated Firecracker microVM"; hosted "In the United States today"; **"Hosted computers reach the internet through shared static egress IP addresses by default"**, "The ranges are shared across Grok Bot customers, and dedicated per-customer IPs are not available", **"Current ranges are available from your account team"** (not published); "Some services flag datacenter IP addresses"; members can "route traffic through their desktop to use its network and IP address" (on by default for admins to allow); hosted-computer domains match `*.*.cursorvm.com`; browser cookies and signed-in sessions shared across a user's Bots; on CAPTCHAs / "explicitly require a human" the Bot hands off ("pause and notify you rather than attempting to bypass the check"). Access via Cursor paid plans, SuperGrok link or Grok Business seat. **No UA, header or robots statement.** Expect a current Chromium UA from an unpublished shared datacenter range (or, with local routing, the user's IP).

### 3.7 ByteDance

- No official crawler page is reachable (`https://zhanzhang.toutiao.com/` and `https://www.doubao.com/bot` render title-only placeholders).
- `Bytespider` (REPORTED strings): mobile form `Mozilla/5.0 (Linux; Android 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36 (compatible; Bytespider; spider-feedback@bytedance.com)`; desktop form `Mozilla/5.0 (compatible; Bytespider; https://zhanzhang.toutiao.com/) AppleWebKit/537.36`. ai.robots.txt: `respect: No`, function "LLM training". Third parties report crawling of disallowed paths, very large IP pools ("100,000+ IP addresses" claimed, unverified), Singapore origin. No IP list, no rDNS.
- `TikTokSpider` (REPORTED): `Mozilla/5.0 (Linux; Android 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36 (compatible; TikTokSpider; ttspider-feedback@tiktok.com)` – link-preview fetcher per knownagents ("not expected to follow robots.txt"); ai.robots.txt says LLM training. UNCERTAIN purpose.
- `DoubaoBot` / `Doubaobot` (REPORTED): token only, Doubao assistant training/fetching.
- Hook: match the three tokens; score Bytespider as non-compliant; no verification possible, so a spoofed Bytespider is indistinguishable from a real one.

### 3.8 Mistral

**Official page (CONFIRMED):** https://docs.mistral.ai/robots (product named there is "Vibe")
- `MistralAI-User`: `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; MistralAI-User/1.0; +https://docs.mistral.ai/robots)` – user-initiated visits; IP list `https://mistral.ai/mistralai-user-ips.json`: **2 prefixes** `135.225.57.92/32, 20.240.192.194/32`, `creationTime 2026-04-19T12:00:00.000000` (Azure).
- `MistralAI-Index`: `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; MistralAI-Index/1.0; +https://docs.mistral.ai/robots)` – indexing only, "not used for generative AI training"; IP list `https://mistral.ai/mistralai-index-ips.json`: **4 prefixes** `20.240.160.161/32, 20.240.160.1/32, 20.240.194.83/32, 51.12.243.114/32`, `creationTime 2025-02-19T12:00:00.000000`.
- `MistralAI-Training`: `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; MistralAI-Training/1.0; +https://docs.mistral.ai/robots)` – training datasets; **no IP list published**.
- OBSERVED: rDNS `crawlers.mistral.ai`; MistralAI-User fetched a disallowed canary (June 2026). No Web Bot Auth (404).

### 3.9 DeepSeek

- No crawler documentation (`https://deepseek.com/bot` 404; xseek: "DeepSeek does **not** publish a user agent for its crawler"). REPORTED string `Mozilla/5.0 (compatible; DeepSeekBot/1.0; +https://www.deepseek.com/)` (knownagents, "normally originates from the Netherlands"; ai.robots.txt `respect: No`). Also REPORTED `DeepSeek-User`.
- OBSERVED: DeepSeek's live fetch used a faked Firefox-on-Linux UA from Huawei Cloud and ignored robots.txt (June 2026). Hook: Huawei Cloud ASN + Firefox/Linux UA + single-page fetch with no subresources is the best available signature; token match on `DeepSeekBot` catches only cooperative or spoofed traffic.

### 3.10 Cohere

**Official page (CONFIRMED):** https://docs.cohere.com/docs/cohere-web-crawlers – "We do not use Cohere bots or user agents for the purpose of crawling or scraping web content … to train generative AI foundation models at this time"; the active-crawler table contains only `N/A`; "It is Cohere's policy to require that crawlers be designed to respect `robots.txt`"; example token `Coherebot` is hypothetical. Therefore `cohere-ai` and `cohere-training-data-crawler` (in ai.robots.txt and in Amazon's robots.txt) are **unconfirmed by Cohere**; traffic carrying them should be treated as unverified third-party or spoofed.

### 3.11 DuckDuckGo

**Official pages (CONFIRMED):** https://duckduckgo.com/duckduckgo-help-pages/results/duckduckbot/ and https://duckduckgo.com/duckduckgo-help-pages/results/duckassistbot
- `DuckDuckBot/1.1; (+http://duckduckgo.com/duckduckbot.html)` – search crawler; "respects WWW::RobotRules"; IP JSON `https://duckduckgo.com/duckduckbot.json` (~500 `/32`s, `creationTime 2026-09-01T12:44:58.000000`).
- `DuckAssistBot/1.2; (+http://duckduckgo.com/duckassistbot.html)` – "crawls pages in real-time for our AI-assisted answers, which prominently cite their sources"; "This data is not used in any way to train AI models"; robots opt-out "will take effect after 72 hours"; contact `crawling@duckduckgo.com`; IP JSON `https://duckduckgo.com/duckassistbot.json` – **486 `/32` prefixes**, `creationTime 2026-09-01T12:44:58.000000`, e.g. `104.43.54.127/32, 104.43.55.116/32, … 128.203.236.110/32` (Azure). The two JSON files returned the same leading entries and timestamp – they appear to be the same list. Note the unusual UA shape (no `Mozilla/5.0`, semicolon before the URL). No rDNS, no Web Bot Auth.

### 3.12 You.com

**Official page (CONFIRMED):** https://you.com/docs/youbot (301 from docs.you.com/youbot)
- UA: `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; YouBot/1.0; +https://docs.you.com/youbot; env:prod) Chrome/X.X.X.X Safari/537.36` (note the `env:prod` token).
- IP range `68.67.112.0/24`; rDNS `youbot-{octets-with-hyphens}.search.you.com` with forward confirmation; **Web Bot Auth keys at `https://you.com/.well-known/http-message-signatures-directory`** (fetched: one Ed25519 key); honours robots.txt and `crawl-delay`, caches robots 30 min; backs off on 429, pauses on 503; contact `spider@you.com`. Purpose: search index (ai.robots.txt adds "and LLMs"). The only operator in this tier with all three verification methods documented.

### 3.13 Brave

**Official page (CONFIRMED):** https://search.brave.com/help/brave-search-crawler – the crawler "does not advertise a differentiated user agent" because "we must avoid discrimination from websites that allow only Google to crawl them"; "if a domain or page is not crawlable by Googlebot, then Brave Search's bot will not crawl it either"; "robots.txt is not used to prevent a page from being indexed" – use `noindex` and request a re-fetch; partially powered by the opt-in Web Discovery Project (data contributed from users' browsers). **No `Bravebot` token, no IPs, no rDNS are documented.** Third-party claims of a `Bravebot/1.0` UA (e.g. `Mozilla/5.0 (compatible; Bravebot/1.0; +https://brave.com/search/)`) conflict with the official page – UNCERTAIN/likely spurious. Detector: Brave's crawler is indistinguishable from a generic browser by design; there is nothing to match.

### 3.14 Diffbot

**Official page (CONFIRMED):** https://www.diffbot.com/docs/crawl/ – "By default Crawl adheres to a site's robots.txt instructions, including the disallow and crawl-delay directives."; "In specific cases — typically because of a partnership or agreement you have with the site to be crawled — the robots.txt instruction can be ignored/overridden."; whitelist with `User-agent: Diffbot` / `Disallow:`; "Crawl does not adhere to the `Allow` directive." No full UA string, **no IP list**. `Diffbot-User` (user-requested fetches) exists only in community lists (REPORTED). ai.robots.txt: Diffbot respect "At discretion of users". **Diffbot is also the fetch back-end for Microsoft Copilot's live page reads (OBSERVED, AS6939, plain Linux Chrome UA)** – so Copilot answers may appear in logs as Diffbot infrastructure with no token at all.

### 3.15 Common Crawl

**Official page (CONFIRMED):** https://commoncrawl.org/ccbot – UA `CCBot/2.0 (https://commoncrawl.org/faq/)`; "CCBot is now run on dedicated IP address ranges with reverse DNS" – `https://index.commoncrawl.org/ccbot.json`: `synctoken 20260811134000`, `creationTime 2026-08-11T13:40:00Z`, IPv4 `3.41.188.32/29, 18.97.9.168/29, 18.97.14.80/29, 18.97.14.88/30`, IPv6 `2600:1f28:365:8000::/56`; rDNS example `18.97.14.84 → 18-97-14-84.crawl.commoncrawl.org` ("except over IPv6 where reverse DNS is not yet supported"); "we are aware of crawlers falsely identifying themselves as CCBot"; monthly crawl; Opt-Out Registry exists. Cloudflare classes it as Archiver. Hook: any `CCBot` UA outside those 5 prefixes is a spoof – one of the cleanest spoof detectors available.

### 3.16 Huawei (PetalBot, PanguBot)

- Official page `https://webmaster.petalsearch.com/site/petalbot` is JS-only (title "Webmaster certification site"); `aspiegel.com/petalbot` 404. REPORTED strings: PetalBot mobile `Mozilla/5.0 (Linux; Android 7.0;) AppleWebKit/537.36 (HTML, like Gecko) Mobile Safari/537.36 (compatible; PetalBot;+https://webmaster.petalsearch.com/site/petalbot)` (as printed by knownagents, including the odd `(HTML, like Gecko)`); purpose Petal Search + Huawei Assistant/AI recommendations; rDNS suffix variously claimed as `petalsearch.com`, `aspiegel.com` or `huawei.com` – UNCERTAIN. ai.robots.txt: respects robots.
- `PanguBot` REPORTED: `Mozilla/5.0 (compatible;PanguBot;pangubot@huawei.com)` (no spaces after semicolons), PanGu LLM training data; one directory lists Huawei Cloud `114.119.128.0/18` – unverified. Note DeepSeek's observed fetches also came from Huawei Cloud, so Huawei Cloud ASN alone is not attribution.

### 3.17 Alibaba / Qwen / Quark

- No official page reachable (`https://tongyi.aliyun.com/bot` 301s to `http://www.qianwen.com/bot` → 404). REPORTED and mutually inconsistent strings: `Mozilla/5.0 (compatible; Qwenbot/1.0; +https://qwen.alibaba.com/)` (knownagents), `Mozilla/5.0 (compatible; QwenBot/1.0; +https://tongyi.aliyun.com/bot)` (rankly/reignat), `Mozilla/5.0 (compatible; TongyiBot/1.0; +https://tongyi.aliyun.com)` (reignat). Rankly also lists `Qwen-User` (live fetch), `Quark-Agent` (agentic browser), `Quark-Spider` (AI search index), `AliyunSecBot` (security scanner) with no strings. Case varies (`QwenBot` vs `Qwenbot`) – match case-insensitively.
- OBSERVED: Qwen's live fetch used a faked Chrome UA via rotating country proxies (Norway then Turkey) and ignored robots.txt (June 2026). Same detection posture as DeepSeek/Grok.

### 3.18 Moonshot AI (Kimi)

**Official page (CONFIRMED):** https://www.kimi.ai/policies/kimi-crawlers (also kimi.com) – three bots, all with the GPTBot-style punctuation `(KHTML, like Gecko); compatible;`:
- `KimiBot`: `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; KimiBot/1.0; +https://www.kimi.com/policies/kimi-crawlers` – "potentially used to train Kimi's foundation models"; IP JSON `https://www.kimi.com/policies/kimibot.json` (302 → `www.kimi.ai`).
- `Kimi-User`: `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; Kimi-User/1.0; +https://www.kimi.com/policies/kimi-crawlers` – user-initiated; "is not used for automated bulk crawling" and "robots.txt rules may not directly apply"; JSON `/policies/kimi-user.json`.
- `Kimi-SearchBot`: `… compatible; Kimi-SearchBot/1.0; +https://www.kimi.com/policies/kimi-crawlers` – search index; JSON `/policies/kimi-searchbot.json`.
- **All three JSON files contain the identical 4 prefixes** `47.79.253.42/32, 47.79.253.91/32, 47.79.225.241/32, 47.79.230.254/32` with `creationTime 2026-05-18T10:04:07Z` (Alibaba Cloud 47.79.x). Page warns Kimi uses "a dynamic range of IPs" and that IP-blocking may stop it reading robots.txt; robots is per-subdomain; `Crawl-delay` honoured.
- REPORTED: `Kimi-Agent` with UA `Mozilla/5.0 Kimi-Agent/2.5` (knownagents; "official" link `https://kimi.com/agent` is just the product page); legacy `MoonshotBot`/`Kimibot` under kimi.moonshot.cn.
- OBSERVED: despite the clean policy, Kimi's chat fetch of a canary used faked browser UAs (incl. `Windows NT 11.0`) from a 10-IP proxy swarm and ignored robots (June 2026). Hook: `Windows NT 11.0` does not exist in genuine Chrome UA strings (Windows reports `NT 10.0`) – a free high-precision tell.

### 3.19 Zhipu AI (ChatGLM-Spider)

- No official doc. REPORTED strings disagree: `Mozilla/5.0 (compatible; ChatGLM-Spider/1.0; +https://chatglm.cn/)`, `… +https://zhipuai.cn/)`, `… +https://zhipu.ai/spider)`, and a `ChatGLM-Spider/2.0` variant; no IP ranges; robots compliance undocumented. Amazon blocks the token.

### 3.20 Tencent, Baidu, 01.ai (brief)

ai.robots.txt tokens `Hunyuan` (Tencent training), `ERNIEBot` / `YiyanBot` (Baidu), `YiBot` (01.ai) – REPORTED only. OBSERVED (June 2026): ERNIE's assistant sent `Baiduspider` to the allowed page and forged strings (`Go-http-client/1.1`, `pc`) to the blocked page from Baidu IPs plus third-party Chinese hosting. Baidu's `Baiduspider` verification (rDNS `*.baidu.com` / `*.baidu.jp`) is well known but was not re-verified here.

### 3.21 Manus (Butterfly Effect)

- REPORTED UA example: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36; Manus-User/1.0` – token appended after a semicolon to a Linux Chrome UA (knownagents; `manus.im/help/Manus-user` 404 now). Search results indicated Cloudflare Radar lists Manus as a **verified Agent, Operator: Manus, Access: Intermediary** with a signature directory (Radar 403 here; `manus.im` and `www.manus.im` well-known paths 404 – directory host UNCERTAIN).
- Two execution modes: cloud agent (Linux UA above, datacenter IP) and **Manus Browser Operator / Manus Helper Chrome extension** running in the user's own Chrome (user IP/cookies). HUMAN (OBSERVED): extension ID `mljmkmodkfigdopcpgboaalildgijkoc`; a `fetch()` of `chrome-extension://mljmkmodkfigdopcpgboaalildgijkoc/content.ts.js` returns 200 when present; console log `Manus helper started`; Manus-specific `window` properties (unnamed). Arkose: Manus and Claude for Chrome "attach via the Chrome DevTools Protocol … It's real, unmodified Chrome the entire time." ai.robots.txt lists `Manus-User` (operator Butterfly Effect). Amazon blocks `Manus-User`.

### 3.22 Genspark

- OBSERVED (HUMAN "AI Agent Detection: Signals, Tools & Best Practices"): UA token `Genspark/1.0.200` appended to a Chrome-style UA on every request; every page opened gets `<div id="genspark-float-bar">`; actions executed through Playwright (Genspark says so during execution). No official crawler/agent doc; `genspark.ai` key directory 404. ai.robots.txt has no Genspark entry; a widely copied Apache blocklist matches `Genspark`.

### 3.23 Fellou

- Electron-based agentic browser ("Chromium sits underneath it", custom autofill/password vault/address book) launched spring 2025; Arkose Labs disclosed vulnerabilities in the custom layer; "It is no longer available" (Arkose, 2026). No UA token documented. Historical only.

### 3.24 Dia / Arc (The Browser Company, now Atlassian)

- Chromium-based (Chromium 144 as of v1.14.0, Jan 2026), macOS only, built from scratch rather than forked from Arc; Browser Company acquired by Atlassian ($610M). Reviews: Dia "does not click around pages on your behalf the way Comet's agent does" but its assistant "can see everything the user sees in authenticated sessions" (summarisation/chat over open tabs). No distinct UA token found; treat as local-browser class with Chrome UA. Arc has no agent mode of note.

### 3.25 Opera Neon

- Announced 28 May 2025 (press.opera.com): Browser Operator "performs these tasks locally in the browser"; Neon Make agents work "in a virtual machine hosted in the cloud" and "continue working … even when they go offline"; Opera Deep Research Agent (ODRA) added 20 Oct 2025. MIT AI Agent Index: Neon uses "regular browser UA strings that do not make the browser distinguishable"; "Neon Do … runs locally within your browser". Normal Opera UAs carry `OPR/x` – that identifies Opera, not the agent. No agent token, IP range or cloud UA documented. Local Neon Do = user IP; Neon Make = cloud VM with unknown egress.

### 3.26 Smaller crawler operators named in the brief

| Bot | UA (status) | Operator / purpose | robots | Verification |
|---|---|---|---|---|
| AI2Bot | `Mozilla/5.0 (compatible) AI2Bot (+https://www.allenai.org/crawler)` (CONFIRMED, allenai.org/crawler: "always makes requests with" this header) | Ai2, training open language models | respects (ai.robots.txt) | none published. Variants `Ai2Bot-Dolma`, `AI2Bot-DeepResearchEval` REPORTED (both blocked by Amazon). |
| ImagesiftBot | `Mozilla/5.0 (compatible; ImagesiftBot; +imagesift.com)` (CONFIRMED, imagesift.com/about, "Imagesift by Hive") | public images + host URL, page text, alt text for web-intelligence/similar-image search | "Standard directives in robots.txt that target ImagesiftBot are respected"; supports `Crawl-delay`; **falls back to Googlebot rules** | none; `support@imagesift.com` |
| omgili / omgilibot / Webzio / Webzio-Extended | no strings on `webz.io/bot.html` (CONFIRMED page names Omgilibot, Webzio, Webzio-extended); `omgili.com/bot.html` has an expired TLS cert | Webz.io; data sold incl. for LLM training (ai.robots.txt); Webzio-extended tags data "usable or not usable for AI/ML training" | "meticulously adheres to robots.txt" (Webzio) | none |
| Timpibot | `Timpibot/1.0 (+http://timpi.io/crawler)` (REPORTED; `timpi.io/crawler` 404) | Timpi decentralized search index, "can be used to train LLMs" | expected | none |
| Kangaroo Bot | `Mozilla/5.0 (compatible; Kangaroo Bot; +https://www.kangaroo.com)` (REPORTED; official page empty) | Kangaroo LLM (Australia), open-source model training | expected | none |
| Scrapy | default `USER_AGENT = "Scrapy/VERSION (+https://scrapy.org)"` (CONFIRMED docs); `ROBOTSTXT_OBEY` True in `startproject` templates but False in library defaults; default headers `Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8`, `Accept-Language: en` | framework used by anyone | per operator | none – the default UA plus `Accept-Language: en` with no `Accept-Encoding`/`Sec-Fetch-*` is itself a signature |
| Mozilla-Tabstack | `Mozilla-Tabstack/1.0 (+https://tabstack.ai)` (CONFIRMED, docs.tabstack.ai/trust/data-handling: "Direct fetches identify Tabstack with the User-Agent …") | Mozilla's web API for agents (`/research`, `/extract`, `/automate` on public sites, "does not sign in on your behalf"); "runs on Google Cloud Platform"; uses a server-side browser when needed | respects (ai.robots.txt), on-demand | none published (GCP egress) |

---

## 4. Agent-product matrix (how each reaches the web)

| Product | Where it runs | Source IP class | UA / declared token | Verifiable? | Best detection handle |
|---|---|---|---|---|---|
| Meta Muse | Meta cloud "Muse Secure VM" with own Chromium browser; Sentinel gate | datacenter (unpublished) | none published; `Muse` / `muse-` REPORTED | no (Meta key directory exists but unlinked) | datacenter ASN + real-browser behaviour + checkout via Stripe Link one-time cards; watch for signatures against `www.meta.com` keys |
| Meta meta-externalfetcher | Meta infra | Meta (AS32934 presumed) | `meta-externalfetcher/1.1 …` | UA only | token + Meta ASN |
| Perplexity Comet | user's machine | residential | Chrome UA, no token | no | hidden extension `npclhjbddhklpbnacpjloidibaggcgon`, `#pplx-agent-overlay-stop-button`, CDP clicks without mousemove |
| Perplexity-User | Perplexity/AWS | 4 published /32s | `… Perplexity-User/1.0 …` + `From:` header | IP list | UA+IP; ignores robots by design |
| Microsoft Copilot (web/app answers) | Microsoft → **Diffbot** fetch (observed) | AS6939 | plain Linux Chrome, no token | no | Diffbot infra + headless-ish single fetch; `Copilot*` tokens unverified |
| Edge Copilot Mode / Actions / Edge for Business agent | user's Edge | residential/corporate | Edge UA | no | WebMCP decoy tool calls; UI-less automation cadence |
| Magentic-UI | operator's host / QEMU VM | any | Playwright default | no | Playwright/CDP artifacts |
| Amazon Nova Act (local) | developer machine, Playwright Chrome | any | `NovaAct` substring (defaults), overridable | no | token; headed Chrome via CDP |
| Nova Act on AgentCore Browser | AWS managed container | AWS | unknown; Web Bot Auth optional | yes when signing enabled | signature verification; AWS ASN |
| Amazon Buy for Me | Amazon infra (Nova + Claude) | Amazon | `AmazonBuyForMe` REPORTED | no | Amazon ASN + checkout-form autofill pattern |
| Amzn-User (Alexa+) | Amazon | ~1,023 published IPs | `… Amzn-User/0.1 …` | IP list | UA+IP |
| Apple Safari MCP / Notify Me / Passwords | user's Mac/iPhone | residential | Safari UA | no | WebDriver flag (MCP), unattended periodic fetches (Notify Me) |
| xAI Grok Bot | Cursor-hosted Firecracker microVM, US | shared static datacenter ranges (unpublished) or user desktop | unknown | no | datacenter egress + `*.cursorvm.com` only visible to the operator; behavioural |
| xAI Grok web retrieval | unknown | rotating hosting/residential/proxy | spoofed Chrome/Safari | no | burst of 9–12 unrelated IPs/sec, no robots.txt, no subresources |
| Manus (cloud) | Butterfly Effect cloud | datacenter | `…; Manus-User/1.0` | signed (per Radar, unverified here) | token; signature |
| Manus Browser Operator | user's Chrome via extension | residential | Chrome UA | no | extension ID `mljmkmodkfigdopcpgboaalildgijkoc`, `content.ts.js` probe |
| Genspark | Genspark cloud, Playwright | datacenter | `Genspark/1.0.200` suffix | no | token + `#genspark-float-bar` |
| Kimi Agent / OK Computer | Moonshot cloud | Alibaba Cloud (4 IPs for crawlers) | `Mozilla/5.0 Kimi-Agent/2.5` REPORTED | no | token; else proxy-swarm behaviour |
| Opera Neon Do / Browser Operator | user's Opera | residential | Opera UA (`OPR/`) | no | behavioural |
| Opera Neon Make | Opera cloud VM | datacenter (unknown) | unknown | no | behavioural |
| Dia | user's Mac | residential | Chrome UA | no | n/a (no page actions) |
| Mozilla Tabstack | GCP server-side browser | GCP | `Mozilla-Tabstack/1.0 (+https://tabstack.ai)` on direct fetches | UA only | token + GCP ASN |
| Fellou | user's machine (Electron) | residential | Chrome-like | no | defunct |

---

## 5. Implementation hooks (condensed)

1. **Allow/deny by (token, IP-list) pairs** for every operator with a JSON list: Perplexity (×2), Amazon (×3; note `ip_prefix` key and bare-IP entries), Apple, Mistral (×2), Kimi (×3, same 4 IPs), DuckDuckGo (×2), Common Crawl (IPv4+IPv6), Bing (`bingbot.json`), You.com (`68.67.112.0/24`). Refresh on `creationTime` change; several files are months old (Bing 2024-01, Perplexity 2025-02), so also accept rDNS where documented (Bing `search.msn.com`, Apple `applebot.apple.com`, CCBot `crawl.commoncrawl.org`, You.com `search.you.com`, Mistral `crawlers.mistral.ai` observed).
2. **Spoof scoring:** a declared token whose IP is outside the operator's list is a spoof with high confidence for CCBot, Applebot, PerplexityBot/-User, Amazonbot family, MistralAI-*, Kimi*, DuckDuckBot/DuckAssistBot, YouBot, bingbot. For Meta tokens use AS32934 heuristically. For Bytespider, PetalBot, PanguBot, ChatGLM-Spider, DeepSeekBot, QwenBot, GrokBot there is no ground truth – label "unverifiable declared".
3. **Policy-ignores-robots class:** Perplexity-User, meta-externalfetcher, Amzn-User, Kimi-User, MistralAI-User, DuckAssistBot (72 h lag), TikTokSpider (reported) – do not treat robots violations as evasion for these; do treat them as "fetcher" intent (Cloudflare "Agent" behaviour).
4. **Web Bot Auth verifier:** parse `Signature-Agent` (quoted https URL), fetch `/.well-known/http-message-signatures-directory`, accept Ed25519 JWKS; seed trusted directories with `https://chatgpt.com`, `https://agent.bot.goog`, `https://you.com`, `https://shopify.com`, and `https://www.meta.com` (flag Meta as "known directory, unknown product"). Record `purpose` / card metadata when present. Note AWS AgentCore signs only when the customer enabled `browserSigning`.
5. **In-page artifacts (client SDK):** Comet (`#pplx-agent-overlay`, `#pplx-agent-overlay-stop-button`, "Stop Comet Assistant", extension `npclhjbddhklpbnacpjloidibaggcgon`, `comet-extension://` scheme), Manus Helper (`mljmkmodkfigdopcpgboaalildgijkoc`, `content.ts.js`, console "Manus helper started"), Genspark (`#genspark-float-bar`, UA suffix `Genspark/1.0.200`), Playwright/Browserbase (`window.playwright__binding`, `navigator.platform` main-thread vs worker mismatch, UTC timezone), SwiftShader WebGL renderer for Linux containers, `navigator.webdriver` for WebDriver/Safari MCP. Register a decoy **WebMCP** tool via `document.modelContext.registerTool` and treat any `executeTool` invocation as agent-positive.
6. **Input telemetry:** clicks with no preceding `mousemove` (Comet CDP), straight-line pointer paths and 0.25-px coordinate steps (ChatGPT agent, HUMAN), ideal Bézier curves, keyboard events without focused text field (Cloudflare Precursor heuristics).
7. **Stealth-fetch heuristics for Grok/DeepSeek/Qwen/Kimi-chat/Gemini-bare-"Google":** single HTML fetch with no subresources, no robots.txt request, browser UA with missing/odd headers, 9–12 simultaneous IPs from unrelated ASNs, Huawei Cloud or country-rotating proxy ASNs, impossible UA facts (`Windows NT 11.0`), Firefox-on-Linux claiming Chrome-only client hints, etc.
8. **Hosted-agent heuristics (Muse, Grok Bot, Neon Make, Genspark, Manus cloud, AgentCore):** datacenter ASN + full browser behaviour (JS, cookies, fonts, WebGL) + task-shaped navigation (search → product → cart → checkout in one short session) + Stripe Link / agent-wallet one-time cards at checkout (Muse). Amazon's own Muse response was an anti-bot wall triggered this way.
9. **Vocabulary:** emit Cloudflare-compatible labels – behaviour {Search, Agent, Training, Transact, Data Collection, …}, access {Direct, Intermediary}, content-use {immediate, reference, full}, plus honesty {declared-verified, declared-unverifiable, spoofed, undeclared}.

---

## 6. Unknowns / open questions

- Which Meta product signs with the 5 keys at `https://www.meta.com/.well-known/http-message-signatures-directory`, and whether Muse sends `Signature-Agent` at all. No Muse UA/IP/ASN has been published or independently logged in any source found; the `Muse` / `muse-` tokens are directory hearsay.
- Microsoft: whether `Copilot`, `CopilotNative`, `CopilotSapphire` (seen only in Amazon's robots.txt) are real UA tokens; how Copilot Actions / Edge for Business agent sessions identify themselves (nothing published); whether Copilot's Diffbot-backed fetches carry any stable marker.
- xAI: Grok Bot's shared egress ranges (account-team only), Grok Bot UA, and whether Grok retrieval's residential-proxy behaviour is xAI's own infrastructure or a vendor; whether `GrokAgent` (Radar, unverified) exists.
- Amazon: the exact default Nova Act UA string; the Signature-Agent URL / key directory used by AgentCore Browser; how Buy for Me "identifies itself" to retailers; current status/UA of Rufus / "Alexa for Shopping".
- Apple: whether Safari MCP sessions expose `navigator.webdriver` (inference only); Notify Me fetch cadence.
- Perplexity: whether Comet "background assistants" execute in Perplexity's cloud (and from which ranges) rather than on-device; whether Perplexity still runs undeclared crawlers after the 2025 de-listing.
- Manus: location of its Web Bot Auth key directory; whether the cloud agent still sends `Manus-User/1.0`.
- ByteDance, Huawei, Alibaba, Zhipu, DeepSeek: no primary documentation reachable; all strings are REPORTED; IP ranges unknown.
- Brave: whether any Brave-specific crawler signal exists at all (official answer: no).
- Cloudflare's August 2025 Perplexity stealth-crawler post could not be fetched (404 on the expected slug); its figures were not re-verified.
- GeekWire's original Muse reporting, DataDome's agent-spoofing analysis, HUMAN's own blog (direct), Bing Webmaster help pages and Cloudflare Radar were not readable in this session (403/JS); their content is cited via secondary quotations.

---

## 7. Sources

Primary (operator) documentation
- Meta web crawlers: https://developers.facebook.com/docs/sharing/webmasters/web-crawlers ; Markdown twin https://developers.facebook.com/documentation/sharing/webmasters/web-crawlers.md ; llms index https://developers.facebook.com/documentation/sharing/llms.txt
- Meta Muse launch: https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/ ; Muse Spark 1.1: https://ai.meta.com/blog/introducing-muse-spark-meta-model-api/
- Meta key directory: https://www.meta.com/.well-known/http-message-signatures-directory
- Perplexity bots: https://docs.perplexity.ai/guides/bots ; IP lists https://www.perplexity.ai/perplexitybot.json , https://www.perplexity.ai/perplexity-user.json ; Comet launch https://www.perplexity.ai/hub/blog/introducing-comet
- Bing UA change (2022): https://blogs.bing.com/webmaster/2022/4/Announcing-user-agent-change-for-Bing-crawler-bingbot/ ; Bing Chat content controls (2023): https://blogs.bing.com/webmaster/september-2023/Announcing-new-options-for-webmasters-to-control-usage-of-their-content-in-Bing-Chat ; bingbot IP list https://www.bing.com/toolbox/bingbot.json ; Bing crawler overview (JS-only, not readable): https://www.bing.com/webmasters/help/which-crawlers-does-bing-use-8c184ec0
- Microsoft Edge: Copilot Mode page https://explore.microsoft.com/en-us/edge/copilot-mode ; Edge for Business agentic browsing https://blogs.windows.com/msedgedev/2026/05/20/new-in-edge-for-business-ai-for-work-safe-from-day-one/ ; WebMCP in Edge https://blogs.windows.com/msedgedev/2026/09/21/new-in-edge-for-developers-create-better-components-and-make-your-site-agent-ready/ ; WebMCP labs https://github.com/MicrosoftEdge/webmcp-labs ; WebMCP spec https://github.com/webmachinelearning/webmcp ; Magentic-UI https://github.com/microsoft/magentic-ui (README, docs/configuration.md)
- Amazon: https://developer.amazon.com/amazonbot ; IP lists https://developer.amazon.com/amazonbot/ip-addresses/ , https://developer.amazon.com/amazonbot/searchbot-ip-addresses/ , https://developer.amazon.com/amazonbot/live-ip-addresses/ ; Nova Act https://github.com/aws/nova-act (README) and API reference mirror https://mintlify.wiki/aws/nova-act/api/novaact ; AgentCore Browser https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/browser-tool.html , features https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/browser-features.html , Web Bot Auth https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/browser-web-bot-auth.html ; Amazon robots.txt https://www.amazon.com/robots.txt
- Apple: https://support.apple.com/en-us/119829 ; IP list http://search.developer.apple.com/applebot.json ; WebKit Features for Safari 27.0 https://webkit.org/blog/18325/webkit-features-for-safari-27-0/ ; Safari 27.1 https://webkit.org/blog/18486/webkit-features-for-safari-27-1/
- xAI Grok Bot: https://docs.x.ai/grok-bot ; https://docs.x.ai/grok-bot/security ; https://docs.x.ai/grok-bot/security-faq ; https://docs.x.ai/grok-bot/computer-and-apps ; https://docs.x.ai/grok-bot/deployment
- Mistral: https://docs.mistral.ai/robots ; IP lists https://mistral.ai/mistralai-user-ips.json , https://mistral.ai/mistralai-index-ips.json
- Cohere: https://docs.cohere.com/docs/cohere-web-crawlers
- DuckDuckGo: https://duckduckgo.com/duckduckgo-help-pages/results/duckduckbot/ ; https://duckduckgo.com/duckduckgo-help-pages/results/duckassistbot ; IP lists https://duckduckgo.com/duckduckbot.json , https://duckduckgo.com/duckassistbot.json
- You.com: https://you.com/docs/youbot ; key directory https://you.com/.well-known/http-message-signatures-directory
- Brave: https://search.brave.com/help/brave-search-crawler
- Diffbot: https://www.diffbot.com/docs/crawl/
- Common Crawl: https://commoncrawl.org/ccbot ; IP list https://index.commoncrawl.org/ccbot.json
- Moonshot/Kimi: https://www.kimi.ai/policies/kimi-crawlers ; IP lists https://www.kimi.ai/policies/kimibot.json , https://www.kimi.ai/policies/kimi-user.json , https://www.kimi.ai/policies/kimi-searchbot.json
- Ai2: https://allenai.org/crawler ; ImageSift: https://imagesift.com/about ; Webz.io: https://webz.io/bot.html ; Scrapy settings: https://docs.scrapy.org/en/latest/topics/settings.html ; Tabstack: https://tabstack.ai/ , https://docs.tabstack.ai/trust/data-handling
- Opera Neon press release: https://press.opera.com/2025/05/28/opera-neon-the-first-ai-agentic-browser/ ; ODRA: https://press.opera.com/2025/10/20/opera-neon-deep-research-agent-odra/
- OpenAI key directory (for comparison): https://chatgpt.com/.well-known/http-message-signatures-directory ; Google: https://agent.bot.goog/.well-known/http-message-signatures-directory ; Shopify: https://www.shopify.com/.well-known/http-message-signatures-directory

Cloudflare (standards, taxonomy, policy)
- Web Bot Auth docs: https://developers.cloudflare.com/bots/concepts/bot/verified-bots/web-bot-auth/ ; policy https://developers.cloudflare.com/bots/concepts/bot/verified-bots/policy/ ; categories https://developers.cloudflare.com/bots/concepts/bot/verified-bots/categories/ ; reference implementation https://github.com/cloudflare/web-bot-auth
- Blog: signed agents https://blog.cloudflare.com/signed-agents/ ; agent registry https://blog.cloudflare.com/agent-registry/ ; moving past bots vs humans https://blog.cloudflare.com/past-bots-and-humans/ ; your site your rules https://blog.cloudflare.com/content-independence-day-ai-options/ ; one year on https://blog.cloudflare.com/agentic-internet-bot-report/ ; Precursor https://blog.cloudflare.com/introducing-precursor/ ; good and bad agentic behaviors https://blog.cloudflare.com/good-and-bad-agentic-behaviors/ ; BotBase for operators https://blog.cloudflare.com/botbase-for-operators/ ; accountable mixed-use crawlers https://blog.cloudflare.com/accountable-mixed-use-ai-crawlers/ ; second audience https://blog.cloudflare.com/agentic-web/ ; verified bots accountability https://blog.cloudflare.com/verified-bots-accountability/ ; tag indexes https://blog.cloudflare.com/tag/bots/ , https://blog.cloudflare.com/tag/ai-bots/ , https://blog.cloudflare.com/tag/bot-management/

Independent measurements and security analyses (OBSERVED data)
- searchengineworld robots.txt test of 12 assistants (Jun/Jul 2026): https://www.searchengineworld.com/do-ai-assistants-actually-respect-your-robots-txt-we-put-12-of-them-to-the-test
- South Asia Digital IP/proxy test (16 Oct 2026): https://southasiadigital.com/which-ai-crawlers-respect-robots-txt/
- HUMAN Security, Atlas vs Comet: https://www.humansecurity.com/learn/blog/chatgpt-atlas-vs-perplexity-comet-agentic-browsers/ ; HUMAN, AI agent detection signals (Genspark, Manus): https://www.humansecurity.com/learn/blog/ai-agent-signals-traffic-detection/
- Security Boulevard, "From detection to trust" (Comet extension/overlay code, Operator signatures, Browserbase, Skyvern): https://securityboulevard.com/2025/08/from-detection-to-trust-the-evolving-challenge-of-ai-bot-authentication/
- Arkose Labs, standalone agentic browsers (Fellou, Atlas, Comet, Manus): https://www.arkoselabs.com/blog/standalone-agentic-browser-didnt-win
- Prosopo, Comet and Amazon v. Perplexity: https://prosopo.io/blog/perplexity-comet-browser/
- MIT AI Agent Index: Comet https://aiagentindex.mit.edu/2025/comet ; Opera Neon https://aiagentindex.mit.edu/2025/opera-neon
- udger bingbot UA database: https://udger.com/resources/ua-list/bot-detail?bot=bingbot
- xseek Bing AI user agents: https://www.xseek.io/docs/bing-ai-user-agents ; xseek DeepSeek: https://www.xseek.io/docs/deepseek-user-agents

Muse / Amazon reporting
- Wikipedia, Muse (AI agent): https://en.wikipedia.org/wiki/Muse_(AI_agent)
- The Register (21 Sep 2026): https://www.theregister.com/ai-and-ml/2026/09/21/amazon-shows-metas-muse-ai-shopping-agent-the-door/5297777
- TechCrunch (21 Sep 2026): https://techcrunch.com/2026/09/21/metas-ai-agent-has-been-blocked-from-using-amazon-com/ ; (23 Sep 2026): https://techcrunch.com/2026/09/23/everything-new-coming-to-metas-ai-agent-muse/ ; Buy for Me (3 Apr 2025): https://techcrunch.com/2025/04/03/amazons-new-ai-agent-will-shop-third-party-stores-for-you/
- nohacks.co, Amazon blocked Muse / robots.txt analysis: https://nohacks.co/blog/amazon-blocked-muse-robots-txt-had-nothing-to-say ; AI UA landscape 2026: https://nohacks.co/blog/ai-user-agents-landscape-2026
- aicrawlercheck.com Muse guide: https://aicrawlercheck.com/blog/meta-muse-ai-agent-website-guide
- GeekWire (not fetchable, cited via the above): https://www.geekwire.com/2026/amazon-blocks-metas-muse-ai-assistant-in-new-standoff-over-agentic-shopping/
- 404 Media: https://www.404media.co/meta-tests-muse-ai-agent-calls-that-are-actually-made-by-humans-in-a-call-center/ ; Ars Technica: https://arstechnica.com/security/2026/10/meta-muse-exposes-users-personal-and-business-secrets-when-they-share-conversations/

Third-party directories (REPORTED strings)
- ai.robots.txt: https://raw.githubusercontent.com/ai-robots-txt/ai.robots.txt/main/robots.json
- knownagents.com (ex-darkvisitors): /agents/youbot, /agents/bytespider, /agents/tiktokspider, /agents/doubaobot, /agents/petalbot, /agents/pangubot, /agents/amazonbuyforme, /agents/muse, /agents/manus-user, /agents/novaact, /agents/kimi-agent, /agents/grokbot, /agents/qwenbot, /agents/tongyibot, /agents/chatglm-spider, /agents/omgili, /agents/timpibot, /agents/kangaroo-bot, /agents/mozilla-tabstack, /agents/deepseekbot, /agents/microsoftpreview (all under https://knownagents.com)
- tryrankly Alibaba operator page: https://www.tryrankly.com/agent-directory/operator/alibaba
- botcrawl MicrosoftPreview: https://botcrawl.com/bots/microsoft-preview/
- momenticmarketing AI crawler list (Oct 2026): https://momenticmarketing.com/blog/ai-search-crawlers-bots
- tinaponting Chinese AI blocking guide: https://github.com/tinaponting/ai-robots-scrapers/blob/main/Chinese-AI-Blocking-Guide-2026.md
- idownloadblog Safari 27 features: https://www.idownloadblog.com/2026/10/05/new-safari-features-ios-macos-27/
