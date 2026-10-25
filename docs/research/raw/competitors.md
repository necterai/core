# Competitive landscape: AI-agent and bot detection, as of 2026-10-24

Research report for the `necter` implementation team. Scope: what every relevant vendor, protocol and open-source project publicly claims to detect and how, how each treats AI agents, deployment and pricing, known weaknesses and bypass evidence, review/replay capability, and the legal and ethical constraints on interventions. Ends with a frank gap analysis.

## 0. Method, confidence legend and caveats

- Research window: 2026-10-24. Roughly 130 primary-source fetches (vendor docs, IETF drafts, GitHub source, arXiv HTML, court/regulator pages) plus ~40 web searches. The session's shared web-search budget ran out part-way through; after that point I continued with direct fetches of known URLs only. Items I could not fetch are marked.
- Confidence tags used throughout:
  - **[confirmed]** read in a primary source during this session (vendor doc, spec, paper, official blog). Exact strings are quoted.
  - **[secondary]** only seen in a third-party article or search snippet; treat numbers and dates as provisional.
  - **[knowledge]** from training knowledge (cutoff mid-2026), not re-verified in this session. Verify before relying on it in product copy or legal positioning.
  - **[uncertain]** conflicting or thin evidence.
- Several vendor sites return HTTP 403 to automated fetchers (DataDome marketing pages, HUMAN blog, Fingerprint press releases on BusinessWire, OpenAI help center, Cloudflare Radar). That is itself a data point: these vendors fingerprint and block non-browser clients on their own properties. Where this happened I used the vendor's developer docs (which were open) or a mirror.
- Never treat a user-agent string, IP range URL, header name or field name in this document as authoritative unless tagged [confirmed]; I did not fabricate any, and where I could not confirm one I say so.

## 1. Executive summary

1. **The market renamed itself around agents in 2026.** Forrester's Q2 2026 Wave is titled "Bot and Agent Trust Management"; 8 vendors evaluated; Leaders: DataDome, HUMAN, Kasada; Strong Performers: Arkose Labs, CHEQ, Netacea; Contenders: hCaptcha, Google (reCAPTCHA Enterprise / Cloud Fraud Defense) [secondary, consistent across 5 sources]. Forrester's headline: "The rise of AI agents moves the market from security first to trust first", and "Detection explainability is a buying criterion" [secondary, Prosopo write-up]. Gartner's 2026 Application Security Hype Cycle reportedly added an "AI Agent Bot Management" entry [secondary, DataDome claim].
2. **Everyone converged on the same identity rail: Web Bot Auth (RFC 9421 HTTP Message Signatures, Ed25519, `Signature-Agent` + `/.well-known/http-message-signatures-directory`).** Cloudflare, Vercel, AWS WAF, Akamai, DataDome, HUMAN, F5, Kasada, Fingerprint, Castle, Stytch and Arcjet all verify it [confirmed for Cloudflare, Vercel, AWS, DataDome, Castle, Stytch, Arcjet, Fingerprint; secondary for Akamai/HUMAN/F5/Kasada]. Signers today: ChatGPT agent (`https://chatgpt.com`), Google (`https://agent.bot.goog`, "experimenting"), Browserbase (beta), Anchor Browser, Block's Goose, Manus, Amazon Bedrock AgentCore (preview, off by default), Cloudflare Browser Rendering. Adoption is thin: an August 2026 probe reportedly found keys only on chatgpt.com and browserbase.com [secondary].
3. **Cloudflare replaced its bot taxonomy on 2026-07-01**: a behaviour taxonomy (Search, Agent, Training, Transact, Data Collection, Security Testing, SEO, Ads Verification, Social / Link Preview, Feed Fetching, Monitoring & Operations) plus a **Direct vs Intermediary** operator field; "signed agents" were folded into verified bots as "Intermediary" [confirmed]. Since **2026-09-15** new zones default to blocking Training and Agent bots on pages with ads [confirmed in docs]. WAF now exposes `cf.bot_management.signed_agent` [confirmed].
4. **Nobody is good at the hard class: agents that drive a real, logged-in, residential browser** (Claude for Chrome, Comet, Browser Use/OpenClaw on a laptop, Playwright MCP). Independent 2026 research: Cloudflare's free tier with "Block AI Bots" detected 1 of 7 agents (only Manus, because it self-identifies) while a behavioural classifier detected all 7 [confirmed, FP-Agent]; OpenClaw and Claude for Chrome "successfully bypass all tested defenses" including Turnstile, Anubis and Bot Fight Mode [confirmed, arXiv 2606.30119]; Akamai found more than 98% of agentic requests carry little or no mouse telemetry so classic mouse models evaluate <1% of them [confirmed].
5. **Behaviour beats fingerprints for agent attribution.** FP-Agent: browser fingerprints alone F1 0.80 (agents share fingerprints), behavioural features F1 0.9993, combined 1.000 on seven agents; the top feature was "Presence of paste event", then mouse curvature range, hold/inter-key latency medians [confirmed]. Akamai's tiny (44k-parameter) masked-autoencoder transformer on mouse sequences reached ROC-AUC 0.981 [confirmed].
6. **Stealth backfires.** "stealth and anti-detection mechanisms often increase detectability rather than decrease it" (Crawl4AI/Browser Use stealth modes create inconsistent fingerprints and switch to blacklisted datacentre IPs) [confirmed]. Automation-protocol fingerprinting (CDP `Runtime.enable` side effects, error-object shapes under `connectOverCDP`) is now "competitive with fingerprint patching" [confirmed, Kernel; corroborated by the 651-verdict anti-detect benchmark where only nodriver, a raw-CDP driver, passed a Turnstile-protected target].
7. **Spoofing of AI identities is the main operational problem vendors cite.** DataDome: spoofing of tracked agent identities rose 45% Feb–Jul 2026; 79.7% of 698,214 sites did not block a spoofed ChatGPT UA; only 2.4% of 21,491 high-traffic domains blocked all 10 test bots [secondary, from DataDome's report via ppc.land]. Arkose: "97.7%" of legitimate AI-agent sessions had "no verified disclosure" [confirmed on arkoselabs.com]. TollBit: 1.9B+ scrapes "bypassed or ignored robots.txt" in H1 2026 [confirmed on tollbit.com].
8. **Deployment models:** CDN/edge (Cloudflare, Akamai, Vercel, AWS WAF, Fastly), reverse proxy/edge module + JS tag (DataDome, HUMAN, Kasada, Imperva, F5, Netacea, Arkose), app-SDK (Arcjet in-process WASM; Castle server API; Fingerprint JS + server API; Stytch IsAgent client hint; cside script-only). **No vendor offers a self-hostable, open, explainable client-side SDK with provider attribution.**
9. **Review/replay/forensics is weak everywhere.** The best is per-request detection evidence (DataDome "Last 1,000 requests" per agent; Cloudflare `detection_ids`; AWS labels; HUMAN "attack profiles"; Arkose "telltales"). Nobody offers session replay with the agent's actions reconstructed, nor a per-decision evidence bundle a site owner can audit. Prosopo's (self-interested) critique still rings true: "Every Leader still keeps its drill-down inside a fully managed model the customer can't self-tune."
10. **Interventions beyond block are now mainstream and legally safer than they look, with limits.** Cloudflare AI Labyrinth (hidden `nofollow` decoy links to pre-generated Workers AI pages), Akamai tarpits and "serve alternate content", Nepenthes/Iocaine poisoning, Anubis/go-away proof-of-work, Pay-Per-Crawl/x402 402 responses, DataDome "Monetize"/"Time-Box". Constraints: WCAG 2.2 SC 3.3.8 and the W3C CAPTCHA note (do not put cognitive tests or JS-only gates in front of assistive tech), ePrivacy 5(3) on JS fingerprinting in the EU, FTC §5 / DSA dark-pattern rules if decoy content reaches humans, and Nepenthes' own warning that poisoning "WILL LIKELY DISAPPEAR FROM ALL SEARCH RESULTS".
11. **Legal tailwind for defenders:** anti-bot measures are "technological measures"; Reddit's DMCA §1201 and conspiracy claims against Perplexity/SerpApi survived motions to dismiss in July 2026 [confirmed via Wikipedia summary]; Cloudflare's Content Signals policy frames `ai-train=no` as an "EXPRESS RESERVATION OF RIGHTS" under Article 4 of Directive (EU) 2019/790 [confirmed]. Circumventing a site's visible gates also weakens an agent operator's "public data" CFAA defence (hiQ / Van Buren line) [knowledge].
12. **Gap to exploit (section 10):** an agent-class taxonomy with provider attribution and confidence; LLM-specific behavioural features (paste-based typing, zero idle mouse, action-burst timing, DOM-marker side-effects, prompt-injection canaries); extension-agent detection; explainable evidence; first-class parsing of every identity rail (Web Bot Auth, Visa TAP, Skyfire KYA `Skyfire-Pay-Id`, Mastercard tokens, Cloudflare `Forwarded` experiments, UCP OAuth, x402 payment proofs); self-hostable SDK; and replayable sessions.

## 2. Analyst framing and market structure

| Item | What it says | Confidence / source |
|---|---|---|
| Forrester Wave "Bot and Agent Trust Management Software, Q2 2026" | 8 vendors; category formally renamed from "Bot Management". Leaders: DataDome, HUMAN, Kasada. Strong Performers: Arkose Labs, CHEQ, Netacea. Contenders: hCaptcha, Google. Inclusion threshold reportedly $10M standalone product revenue. Criteria named by vendors: "AI Agent Trust Management", "Bot & Agent Detection Explainability", "Intent Visibility", "Attack & User Analytics", "Customizable Reports & Dashboards", "Threat Research", "Partner Ecosystem". Google marked down because its intent analytics "break out only the top four AI agents" and it is "missing an agent library". | [secondary] Prosopo, HUMAN, Kasada, DataDome press pages |
| Gartner Hype Cycle for Application Security 2026 | New "AI Agent Bot Management" category; DataDome a Sample Vendor. | [secondary] DataDome page (403 to fetch) |
| Vendor-reported traffic scale | HUMAN: "20 trillion digital interactions each week" (2025 PR) and "over a quadrillion digital interactions each year" (2026); AI agent + agentic browser traffic up "7,851% year over year" (2026 report, PDF unreadable in-session). DataDome: 52.7B AI agent/LLM crawler requests in 12 months to June 2026. Cloudflare: AI crawlers >50B requests/day (~1% of all requests) at Labyrinth launch. | [confirmed PR text / secondary report numbers] |
| Independent efficacy studies | FP-Agent (UC Davis authors Wang, Shafiq, Vekaria; arXiv 2605.01247); "On the Internet, Nobody Knows You're an LLM Bot" (Fayolle, Bouhenniche, Pélissier, Laperdrix, Maurice, Rudametkin; arXiv 2606.30119); Akamai telemetry blog; ianlpaterson anti-detect benchmark (May–Aug 2026); Kernel's Kasada reverse-engineering. | [confirmed] |

Take-away for positioning: the analysts now score (a) an out-of-the-box agent library with per-agent permissions, (b) intent visibility, (c) explainability, (d) partner/identity ecosystem. Our differentiation must be measurable on exactly those axes plus the ones they do not yet score (replay, self-hosting, provider attribution of *undeclared* agents).

## 3. The shared identity layer: Web Bot Auth and its relatives

### 3.1 Web Bot Auth wire format (Cloudflare's implementation doc) [confirmed]

Source: developers.cloudflare.com/bots/concepts/bot/verified-bots/web-bot-auth/

- Headers on a signed request: `Signature-Input`, `Signature`, `Signature-Agent`.
- `Signature-Agent` "Must be a structured string in double quotes", must use `https://`, e.g. `"https://signature-agent.test"`, and "Must appear in the `Signature-Input` component list". The dictionary form (`sig2="https://..."`) is rejected.
- Covered components: at minimum `@authority` plus `"signature-agent"`; example `("@authority" "signature-agent")`. Do not sign `@query-params`, `@status`; do not use `sf`, `bs`, `key`, `req`, `name` parameters. Sign `Content-Digest` only if the body cannot be altered in transit.
- Tags: request signatures `tag="web-bot-auth"`; key-directory signatures `tag="http-message-signatures-directory"`.
- Key directory: `/.well-known/http-message-signatures-directory` over HTTPS, a JWKS; `Content-Type: application/http-message-signatures-directory+json`; "Each key you want used needs a matching signature in the response"; only `kty`, `crv`, `x` are read; "Never include `d`".
- Algorithm: Ed25519 only (`alg="ed25519"`); `keyid` is the base64url JWK thumbprint (RFC 8037 A.3).
- `created`/`expires` are Unix timestamps; "A minute is often sufficient"; `nonce` recommended but "Cloudflare doesn't validate it or check it against a replay database".
- After verification Cloudflare populates `cf.bot_management.verified_bot`; test endpoint `https://crawltest.com/cdn-cgi/web-bot-auth` (200 verified / 401 unknown key or failed / 400 malformed).
- Registration: Dashboard > Manage Account > Configurations > Bot Submission Form, Verification Method = Request Signature; status in "BotBase > Submission history".

### 3.2 IETF status [confirmed]

- WG `webbotauth` charter: standardize "cryptographically authenticating automated clients" and conveying operator information; **out of scope**: "Authenticating the end user of a participating client or agent", HTTP APIs/agent-to-agent, "Defining a vocabulary for bot intents", "Tracking or assigning reputation to particular bots", "Distinguishing non-participating bots from non-bot clients". Milestones: 2026-04-30 (auth spec and bot-info spec to IESG), 2026-08-31 (BCP). Still Internet-Drafts as of this report; WorkOS reports the current draft revised 2026-09-01, expiring 2027-03-05, with a recommended max signature lifetime of 24 hours and "defines no revocation" [secondary].
- Companion draft `draft-meunier-webbotauth-registry-01` defines a JSON "Signature Agent Card" with optional fields `client_name`, `client_uri`, `logo_uri`, `contacts`, `expected-user-agent` (with `*` wildcards), `rfc9309-product-token`, `rfc9309-compliance`, `trigger` (`fetcher` or `crawler`), `purpose` (controlled vocabulary from AIPREF, examples `search`, `tdm`), `targeted-content`, `rate-control`, `rate-expectation` (both TODO), `known-urls`, `keys` (JWKS); example path `/.well-known/signature-agent-card`.
- WG `aipref` (chairs Mark Nottingham, Suresh Krishnan): vocabulary `draft-ietf-aipref-vocab` and attachment `draft-ietf-aipref-attach` (well-known URI, robots.txt, HTTP header), milestones 2026-08-31; enforcement, crawler authentication and auditing are out of scope.

### 3.3 Who signs, who verifies (October 2026)

| Party | Role | Evidence |
|---|---|---|
| OpenAI ChatGPT agent | Signs; `Signature-Agent: https://chatgpt.com` with keys at chatgpt.com's well-known directory; the arXiv honeysite study saw `signature` and `signature-agent` headers from ChatGPT Agent | [secondary WorkOS; confirmed arXiv 2606.30119] |
| Google | "experimenting with the Web Bot Auth protocol" using identity `https://agent.bot.goog` for Google-Agent | [confirmed, developers.google.com] |
| Browserbase | "Browserbase Identity" / Web Bot Auth in beta; "A valid signature doesn't grant access or sign your agent into a user account" | [confirmed docs] |
| Anchor Browser, Block's Goose | Cloudflare launch cohort Aug 28 2025 | [confirmed Cloudflare blog] |
| Manus | Fingerprint directory lists "Manus Agent" as "Signed" | [confirmed] |
| Amazon Bedrock AgentCore Browser | signing "in preview, off by default"; AWS WAF emits `bot:account:{hash}` for AgentCore agents | [secondary WorkOS; confirmed AWS docs] |
| Cloudflare Browser Rendering | appears in the signed-agent category | [confirmed] |
| Verifiers | Cloudflare (`cf.bot_management.signed_agent`), Vercel (since 2025-08-12; WAF match on `Signature-Agent`), AWS WAF (`web_bot_auth:verified|invalid|expired|unknown_bot`), DataDome (Protection API ingests `SignatureAgent`, `Signature`, `SignatureInput`), Castle (`identified_by: web_bot_auth`), Stytch (IsAgent + DFP, since 2025-09-23), Fingerprint (`identity: signed`), Arcjet (`web-bot-auth` npm sample), Akamai/HUMAN/F5/Kasada (named by AWS/WorkOS and Kasada's own launch post) | [confirmed/secondary as noted] |

Limits every verifier admits: a valid signature "says nothing about who operates the Agent, whether the Agent is benign, or whether the request is authorized" (WorkOS summary of the draft); no end-user identity; no revocation; voluntary. Cloudflare is experimenting with RFC 7239 `Forwarded` to carry end-user info for Intermediary agents ("transitive trust") [confirmed].

### 3.4 Adjacent identity/payment rails a detector must parse

- **Visa Trusted Agent Protocol (TAP)**: RFC 9421 signatures; sample CDN proxy verifies `Signature-Input` and `Signature` with covered components `@authority` and `@path` plus `created`, `keyId`, `alg`; "Ed25519 and RSA-PSS-SHA256"; keys fetched from an "Agent Registry" by `keyId`; signature "bound to your domain and the specific operation being performed" (browsing or payment); consumer identifiers (PAR, loyalty, email, phone) may be passed as query parameters with consent [confirmed, GitHub]. Live date Oct 14 2025 [secondary]. Integrated by Akamai and ingested by DataDome as a "third-party trust authority" (DataDome's doc mis-expands TAP as "Token Agent Protocol") [confirmed].
- **Skyfire KYA / KYAPay**: token types `kya`, `pay`, `kya-pay`; identity claims `hid` (human: `email`, `birthdate`, `given_name`, ..., `verifier`, `verified`, `verification_id`), `apd` (agent platform), `aid` (agent: `name`, `creation_ip`, `source_ips`), `scope`; presented in the `Skyfire-Pay-Id` request header (DataDome Protection API field `SkyfirePayId`) [confirmed]. Live implementations listed: Dappier.com, BuildShip.tools, Apify.com [confirmed docs index]. DataDome labels traffic "Skyfire KYA Verified Agent" / "Skyfire KYA Unverified Agent" and exposes `trustauthority`, `trustauthorityagentid`, `trustauthorityagentName`, `trustauthorityverificationstatus` [confirmed].
- **Mastercard Agent Pay**: Sept 30 2026 "trust and intelligence services" incl. an "AI probability score" for whether an agent initiated a transaction (US testing), KYA with Skyfire, "privacy-preserving environments" with Cloudflare [secondary].
- **Google AP2** (announced 2025-09-16): Checkout Mandate (open/closed) and Payment Mandate (open/closed) as "tamper-evident, cryptographically signed digital objects" (VDCs); merchant verification not described on the overview page [confirmed ap2-protocol.org].
- **Stripe**: Agentic Commerce Protocol with Shared Payment Tokens; also a member of the **UCP** Tech Council. UCP ("co-developed" by Google, Shopify, Etsy, Wayfair, Target, Walmart, Amazon, Microsoft, Meta, Salesforce, Stripe, plus lodging and food groups) uses OAuth 2.0 identity linking (scope `dev.ucp.shopping.checkout`) and AP2 mandates; it does not define request-level agent authentication [confirmed].
- **Cloudflare Monetization Gateway** (2026-07-01, waitlist): HTTP 402 + x402, stablecoins "Open USD and USDC", "Buyers need no account, API key, or prior relationship"; sellers "can optionally require agents to authenticate with Web Bot Auth"; "verified agent identity" is a future capability [confirmed]. "NET Dollar" stablecoin: announced 2025, no 2026 launch found [secondary]. Wallets/x402 handles Aug 2026 [secondary].
- **IAB Tech Lab CoMP** (v1 final 2026-04-28; formerly "LLM Content Ingest API"): licensed access via an access token after an access request with stated reason; "not a blocking system"; "strongly recommends that content owners run their own blocking strategy"; a "Bot and Crawler Management Guidance" doc was in public comment until 2026-06-25 [confirmed]. ppc.land reports CPCr (cost per crawl) pricing and a logging API for accountability [secondary].

Implication: identity is becoming a *multi-protocol* input. A detector that normalizes all of these into one "declared identity + verification strength + principal" object has no equivalent today (DataDome is closest with its "trust authority" fields).

## 4. Vendor deep dives

### 4.1 Cloudflare

**Bot Management core [confirmed]**
- Bot score 1–99: "a score of 1 means Cloudflare is quite certain the request was automated", 99 "quite certain the request came from a human". Groupings: Not computed 0; Automated 1; Likely automated 2–29; Likely human 30–99; Verified bot. Granular score is Enterprise-only.
- Engines: Heuristics ("gives automated requests a score of 1 for high-confidence, deterministic detections"; empty/missing `User-Agent` → score 1), Machine learning ("Adaptive Intelligence ... accounts for the majority of all bot detections"), Anomaly Detection (deprecated), JavaScript Detections ("either blocks, challenges, or passes requests to other engines"), Cloudflare Service. `__cf_bm` cookie smooths scores across a session.
- Ruleset fields: `cf.bot_management.score`, `cf.bot_management.verified_bot`, `cf.bot_management.static_resource`, `cf.bot_management.ja3_hash`, `cf.bot_management.ja4`, `cf.bot_management.detection_ids`, `cf.bot_management.tags`, `cf.bot_management.signed_agent` ("Whether a known agent self-identifies with Web Bot Auth"), `cf.verified_bot_category`, `cf.bot_management.corporate_proxy` (Enterprise). Workers: `request.cf.botManagement.{score,verifiedBot,staticResource,ja3Hash,ja4,jsDetection.passed,detectionIds,signedAgent}`, `request.cf.verifiedBotCategory`. Log fields `BotDetectionIDs`, `BotScore`, `BotScoreSrc`, `BotTags`.
- JA4 Signals (Enterprise Bot Management only): ratios `h2h3_ratio_1h`, `heuristic_ratio_1h`, `browser_ratio_1h`, `cache_ratio_1h`; ranks `uas_rank_1h`, `paths_rank_1h`, `reqs_rank_1h`, `ips_rank_1h`; quantiles `reqs_quantile_1h`, `ips_quantile_1h` (grouped under `ja4Signals` / `jaSignalsParsed`). JA4 "sorts ClientHello extensions", reducing fingerprint churn versus JA3. Also usable to identify mobile-app traffic.
- Turnstile Ephemeral IDs: `metadata.ephemeral_id` in Siteverify; requires Enterprise Bot Management + Turnstile Enterprise add-on.

**Verified bots: the 2026-07-01 taxonomy [confirmed]**
- Behaviours (a bot can have several): **Search** ("build search indexes or RAG databases"), **Agent** ("User-directed agents visiting a page on behalf of a human"), **Training**, **Transact** (checkout for users), **Data Collection**, **Security Testing**, **SEO**, **Ads Verification**, **Social / Link Preview**, **Feed Fetching**, **Monitoring & Operations**. "AI Search" and traditional search both map to Search.
- Operator access: **Direct** ("Operated by a single, narrow operator — usually on the operator's own infrastructure") vs **Intermediary** ("An agentic service that a wide range of end users can operate"; "each action is initiated by a different end user"). "Signed agents are now Verified" and the distinction "is expressed by a new metadata field" in BotBase.
- Validation: must self-identify deterministically by "a cryptographic Web Bot Auth signature, a published IP list with a stable user-agent, or reverse DNS"; must obey robots.txt and crawl-delay, keep "reasonable request rates", not evade owner preferences. Breaches (shared IP ranges, undisclosed IP blocks, ignoring `crawl-delay`) remove a bot from the global allowlist. Rejection reasons are not shown in the dashboard.
- Legacy categories remain usable as strings in WAF rules: `Academic Research`, `Accessibility`, `Advertising & Marketing`, `Aggregator`, `AI Assistant` ("Automated AI bot driven by user action."), `AI Crawler` ("Crawls websites for content that is used for training AI models."), `AI Search`, `Archiver`, `Feed Fetcher`, `Monitoring & Analytics`, `Page Preview`, `Search Engine Crawler`, `Search Engine Optimization`, `Security`, `Social Media Marketing`, `Webhooks`, `Other`. The new behaviours "are not individual fields in WAF custom rules".
- Signed-agent launch (2025-08-28): three traits (user-directed; infrastructure or remote browsing platform signs via Web Bot Auth; complies with policy); launch partners ChatGPT agent, Goose, Browserbase, Anchor Browser; dashboard path `/:account/configurations/bot-submission-form`; directory `https://radar.cloudflare.com/bots/directory` (403 to my fetcher).

**AI bot policies and the 2026-09-15 defaults [confirmed]**
- Security Settings > "Configure AI bot policies": presets **Search**, **Agent** ("real-time automated activity on a person's behalf, such as chat fetch bots and browser-use agents"), **Training**; mitigations "Block (on all pages)", "Block on pages with ads" (Cloudflare automated ad detection), "Allow (do not block)". Each preset covers "Verified bots classified with that behavior, plus additional unverified bots that fall under these classifications."
- From 2026-09-15 new domains: Training and Agent blocked on pages with ads; Search allowed. Legacy "Block AI bots" option "Deprecating on September 15, 2026". Mixed Search+Training crawlers are blocked by any training-blocking configuration. "All Cloudflare customers can choose to block AI bots and agents based on their behavior."

**AI Crawl Control [confirmed]**: dashboard of AI service access, per-crawler allow/block, robots.txt health and "which crawlers violate your directives" with enforcement rules, Pay Per Crawl (private/closed beta), "Available on all plans". Markdown for Agents lives here too.

**AI Labyrinth [confirmed]**: opt-in including Free; injects "invisible links on your webpage with specific `Nofollow` tags" that are "only seen by bots"; decoy pages pre-generated with Workers AI on "diverse topics", "real and related to scientific facts", XSS-sanitized, stored in R2, with meta directives preventing indexing; "No real human would go four links deep into a maze of AI-generated nonsense"; crawl hits are "fed to our machine learning models". Analytics actions: "AI Labyrinth Served" and "AI Labyrinth Crawls"; "AI Labyrinth actions are not mitigations". Links remain valid briefly after disabling.

**Content Signals (CC0) [confirmed]**: managed robots.txt for "over 3.8 million domains" gets `Content-Signal: search=yes, ai-train=no` plus a comment preamble that opens "As a condition of accessing this website, you agree to abide by the following content signals:" and states "ANY RESTRICTIONS EXPRESSED VIA CONTENT SIGNALS ARE EXPRESS RESERVATIONS OF RIGHTS" with a reference to Article 4 of EU Directive 2019/790. Definitions: `search` (index + links/short excerpts, excludes "AI-generated search summaries"), `ai-input` (RAG, grounding, real-time retrieval), `ai-train`. Omitted signal = no preference; Cloudflare will not emit `ai-input` for managed customers. InfoQ (2026-03-05) says signals are "merely preferences, not enforceable rules".

**Markdown for Agents [confirmed]**: request with `Accept: text/markdown`; response `Content-Type: text/markdown; charset=utf-8`, `Vary: Accept`, default `Content-Signal: ai-train=yes, search=yes, ai-input=yes` if origin sets none (note the permissive default), `Content-Length`/`ETag`/`Last-Modified` removed, JSON-LD kept, 6 MiB HTML limit, Pro/Business/Enterprise at no cost; InfoQ reports an `x-markdown-tokens` header [secondary]. Detection hook: a client sending `Accept: text/markdown` is almost certainly an agent or agent-aware fetcher.

**Pay Per Crawl [confirmed, launch post 2025-07-01]**: reactive flow `402 Payment Required` with `crawler-price: USD XX.XX`, retry with `crawler-exact-price`; proactive `crawler-max-price` → `200 OK` with `crawler-charged`; only one of exact/max per request; crawlers must publish an Ed25519 JWK directory, register the directory URL and UA, and sign with `Signature-Agent`, `Signature-Input`, `Signature`; publisher states Allow / Charge / Block; flat per-request site price; Cloudflare is Merchant of Record; closed beta. 2026-07-01 pivot: a "pay per answer/use" research program with Ceramic.ai (pay-per-query, with reporting of query, page, snippet, rank) and You.com (on-demand premium content) [secondary ppc.land]. Open Markets estimates Cloudflare's cut at ~30% [secondary].

**Enforcement track record [confirmed]**: Aug 2025 Perplexity investigation: declared `Perplexity-User/1.0` (~20–25M req/day) vs undeclared crawler with UA `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36` (~3–6M req/day) rotating IPs/ASNs outside published ranges; honeypot domains with robots.txt disallow still summarized; Perplexity de-listed from verified bots; signatures added to the managed AI-crawling block rule for all plans including Free.

**Weaknesses / bypass evidence**
- FP-Agent (2026): free tier + AI Crawl Control + Block AI Bots blocked only Manus ("Manus Bot" rule; it self-identifies); Atlas Agent, ChatGPT Agent, Claude for Chrome, Comet, Browser Use, Skyvern completed tasks [confirmed].
- arXiv 2606.30119: OpenClaw (Claude sonnet-4.5/opus-4.5) and Claude for Chrome passed robots.txt, UA filtering, reCAPTCHA v3, Prosopo, Anubis, Turnstile and "Cloudflare BFM plus Block AI Bots"; ChatGPT Agent was blocked by Turnstile "likely due to HTTP header characteristics"; Cloudflare BFM "did not block" plain HTTP scrapers [confirmed].
- Anti-detect benchmark (651 verdicts, May–Aug 2026): on a Turnstile site nodriver passed every sweep while Patchright, Camoufox, CloakBrowser, curl_cffi, vanilla and rebrowser Playwright were hard-blocked; a Cloudflare interstitial site gated Patchright/Camoufox/CloakBrowser/curl_cffi and hard-blocked vanilla/rebrowser; "Turnstile results are site-state-dependent" [confirmed].
- Managed Unblocker vendors advertise "98% success rate against Cloudflare Bot Management" (Scrapfly, self-reported) [confirmed on page, vendor claim].
- ChatGPT agent clicking the Cloudflare "Verify you are human" checkbox and narrating that the step was needed to prove it was not a bot (July 2025, widely reported) [knowledge; Ars Technica blocked my fetcher]. A terminal-browser issue suggests Turnstile checks "trusted user activation and pointer event fidelity inside its iframe" [secondary].
- Structural: in-page behavioural signals exist only via JS Detections/Turnstile; granular score, JA4 signals and detection IDs are Enterprise-only; "Agent" preset mixes verified and heuristic unverified; no replay; `Forwarded` end-user attribution is experimental.

### 4.2 Akamai

**Products [confirmed on akamai.com]**
- Bot Manager: "Advanced bot detection using AI models for user behavior analysis, browser fingerprinting, and more"; "Behavior anomaly detection is configured automatically by injecting a simple script into each monitored page"; bot score "from 0 (human) to 100 (bot)"; actions include slowing bots, serving cached content "to bots instead of live site content", challenges, "Stealthy defenses that go beyond block-and-allow actions"; "library of known bots" with customer-defined categories; CTA "Verify Your Bot or AI Agent with Akamai".
- Content Protector (scraper-focused): four layers — "Protocol fingerprinting evaluates how the client establishes the connection", application-level ("can run some business logic written in JavaScript"), user interaction ("touch screen, keyboard, and mouse"), user behavior ("user journey"); "Custom JavaScript detects indicators left by headless browsers, even in stealth mode"; low/medium/high risk; actions monitor-and-deny, "tarpits to slow connections", challenges.
- Agentic Security Framework (2026-06-15) for "Bot & Agent Control": six pillars — "verified identity and human attribution", "user-centric authentication", "adaptive trust analysis", "edge-based enforcement", "content monetisation and value exchange", "operational visibility and traffic analysis"; Visa TAP integration; KYA framework with Skyfire and Experian; Auth0 and Ping Identity integrations (apply MFA/behavioural controls to customers' agents); TollBit and Skyfire pay-per-request; TrafficPeak analytics [confirmed via cyberriskleaders; GlobeNewswire 403].

**Research (blog, 2026) [confirmed]**: tested Perplexity Comet, OpenAI Atlas and the Claude Chrome Extension in automation mode against Bot Manager Premier sites with prompts like "Find the login page." Findings: 63.2% of agentic requests had 0 mouse events, 35.8% below the minimum event threshold, only 1.0% evaluable; existing mouse models flagged <1%. Behaviours: no idle cursor movement or hover before click, no exploratory scrolling, precise clicks, "long, irregular pauses, sometimes several seconds between clicks". Model: Masked Autoencoder Transformer, 3.5M unlabeled sequences, 35% masking, 44,000 parameters, 3 layers, 4 heads, 64-d embedding, sinusoidal time encoding; shallow MLP (64→32) on 2,190 labeled agentic sequences; class imbalance ~85:1; ROC-AUC 0.981, PR-AUC 0.661 (vs one-class SVM 0.797/0.044, Isolation Forest 0.833/0.038, VAE 0.882/0.410). Proof of concept; session metrics "reserved for part two". Notes OpenAI discontinued Atlas after the research (Wikipedia: shut down 2026-08-09).

**Treatment of agents**: identity via TAP/KYA/registration; "adaptive trust analysis" rather than binary; monetization via TollBit/Skyfire. No public agent taxonomy or per-agent library page found.

**Weaknesses**: third-party reviewers (cside, Cequence, wal.sh — all with commercial stakes) rate Akamai's native agent detection as less mature than its classic bot detection [secondary]; the behavioural agent model is a PoC; CDN-edge model; no replay. Strength: the only vendor publishing a quantified behavioural agent model.

### 4.3 DataDome

**Agent Trust (docs) [confirmed]**
- Agent categories: **AI Crawler**, **AI Assistant**, **Autonomous Agent**, **Agentic Browser**.
- Identification strength: High = "Web Bot Authentication, cryptographic token verification, trusted IP source lists, and reverse-DNS (rDNS)"; Medium = "Network attribution (isolated AS or IP ranges) and client-side fingerprinting"; Low = "Server-side fingerprinting".
- Two mechanisms: DataDome Agent Catalog (research-built models; simulation mode → two-week customer review with description, Trust Score and recommended policy → activation) and "Third-party trust authorities" (Visa "TAP", Skyfire "KYA"), delivered automatically.
- Agent Trust Score: "a dynamic, continuously updated value between 0 and 100", per customer, from Identification Strength, Behavioral Intent ("balance of legitimate and fraudulent activity ... on your platform and across the DataDome network") and Reputation. No published bands.
- Intent-based Protection: threat categories Vulnerability Scanning, Credential Stuffing, Fake Account Creation, Payment Fraud, Spamming, Scalping, Scraping; three layers (synchronous per-request, asynchronous cross-session, ML loop); applies "regardless of the agent's identity or Trust Score".
- Access Control policies: **Intent-Based** (default for trusted agents), **Allow**, **Block**, **Rate Limit**, **Time-Box** (weekly schedule), **Monetize** (via partner); levels: Default (agent), Endpoint-Level ("different rules per action type"), Custom Rules ("more than 60 characteristics" incl. HTTP headers, Geo, GraphQL operations). "Agent Detailed View" shows "Last 1,000 requests" with metadata and detection output. No challenge policy for agents.
- Protection API (server-side): decision header `X-DataDomeResponse` (200 allow, else challenge, missing = fail-open); origin enrichment via `X-DataDome-request-headers` e.g. `X-DataDome-isbot: 1`, `X-DataDome-botname` (example "Crawler fake Google"), `X-DataDome-botfamily` (example `bad_bot`); client cookie `datadome` / `X-DataDome-ClientID`; request schema includes `SignatureAgent`, `Signature`, `SignatureInput`, `SkyfirePayId` ("for AI bot monetization") and MCP fields `McpMethod`, `McpSessionId`, `McpProtocolVersion`, `McpParamsToolName` — i.e., DataDome protects MCP servers too ("Error: Agent Blocked" page for MCP endpoints).
- Partners: TollBit monetization, Skyfire KYAPay (labels above).

**Marketing claims [secondary, 403 pages]**: "100-point trust score", verifies ChatGPT and Amazon Bedrock AgentCore via Web Bot Auth, "under 2ms", "0.01% false positive rate", Priority Protect virtual waiting room for agentic commerce (2026-05-20), Forrester Leader with "highest score in the Current Offering category", Gartner Sample Vendor.

**2026 State of Bot & Agent Security Report [secondary via ppc.land, published 2026-09-22]**: 52.7B AI agent/LLM crawler requests (Jul 2025–Jun 2026); login-page AI requests 11.9M (Jan 2026) → 99.7M (Jun 2026); spoofing +45% Feb–Jul 2026, by DataDome category: "User-prompted agents" (Perplexity-User, ChatGPT-User) 1.4–5.6%, "Search and answer bots" (OAI-SearchBot, Meta-ExternalAgent) 1.9–4.7%, "Crawlers and indexers" (ClaudeBot, GPTBot) 3.2–5.7%; share of identified AI traffic H1 2026: Meta 46.3% (Meta-ExternalAgent 8.54B, Meta-WebIndexer 5.30B), OpenAI 34.6%, PetalBot 5.3%, Amazon 5.3%, Anthropic 3.5%, Perplexity 2.8%, ByteSpider 1.4%, Google Gemini/Vertex 0.4%; only 2.4% of 21,491 domains blocked all 10 test bots (65.3% unprotected); March 2026 study: 79.7% of 698,214 sites did not block a spoofed ChatGPT UA.

**Weaknesses**: edge/proxy + JS tag only; agent catalogue is curated by DataDome (two-week lag by design); no replay; Camoufox and SeleniumBase UC "clear many ... DataDome targets today" [secondary scraper vendors]; Kernel says DataDome detects "agent-framework DOM markers ... from Browser Use and Stagehand" — a technique we should adopt and generalize [secondary]. Strength: the most complete published agent governance model (trust score + intent + endpoint policies + monetization + MCP).

### 4.4 HUMAN Security

- Sightline Cyberfraud Defense + **AgenticTrust** (launched 2025-07-30; governance controls Sept 2025): "multi-model signal analysis", trust from "behavior and context, not identity alone", "actor-level visibility" across humans, bots, agents; detects impersonation and "excessive or unintended agent behavior"; verification via "HTTP Message Signatures and public-key cryptography"; open-source "HUMAN Verified AI Agent" with a public verifier and demo key registry; actions "block, allow, rate-limit, redirect, or monetize"; "Integrates into WAF, CDN, CIAM and fraud infrastructure" [confirmed PR].
- Forrester 2026: top score in nine criteria incl. "AI Agent Trust Management" and "Intent Visibility"; Forrester praised "a thorough list of AI agents available out of the box with detailed explanations and granular permissions that users can assign to each agent" and "attack profiles, which offer rich attack analytics context and detail"; mitigations integrate with WAF, CDN, IAM and Adobe Experience Platform [confirmed Yahoo mirror].
- 2026 report claims (PDF unreadable; secondary): >1 quadrillion interactions analysed; agent/agentic-browser traffic +7,851% YoY.
- Treatment of agents: allow verified, per-agent permissions, monetize. Deployment: enterprise sensor + edge integrations. Review: attack profiles / Sightline dashboards; no replay. Weaknesses: opaque signals, enterprise-only, blog 403s to researchers; no public taxonomy beyond marketing.

### 4.5 Kasada

- **AI Agent Trust** (2026-01-21): "directory of verified bots and agents, enriched with vendor identity and category data, with support for emerging standards such as Web Bot Auth"; "Trust decisions are enforced upstream"; portal + Custom Reporting show "verification results, request patterns, and endpoint interactions"; "Controls are secure by default" [confirmed]. Third-party listing says agents are "classified by verification strength, from cryptographic Web Bot Auth signatures to weaker signals such as user agents and IP ranges" [secondary]. Forrester Leader; top scores incl. "Bot & Agent Detection Explainability" [confirmed SB]. $20M raise Feb 2026 for "agentic defense" [secondary].
- Also powers **Vercel BotID Deep Analysis** (see 4.6).
- Reverse-engineering writeup (Kernel) [confirmed]: `ips.js` 449 KB custom bytecode VM, 437 KB encoded string table, time seeds, integrity checksums, per-site variants; probes include `navigator.webdriver`, `screen.width`, `RTCPeerConnection`, `getBattery`, canvas primitives, named rules `bot606`, `bot1375_mfsk`, competitor-CAPTCHA detection, cross-frame consistency, UA validation, webdriver getter integrity, window property leaks; "crash-and-capture" probes compare error message text and stack shapes; iframe `matchMedia` binary search of screen dims, color-gamut, dynamic-range, forced-colors; telemetry POST to `https://reporting.cdndex.io/error` XOR-obfuscated with key `omgtopkek`. Key finding: raw CDP passed, Playwright `connectOverCDP` failed because "initialization commands ... modify V8 inspector state" changing JS error shapes; software-rendered canvas/GPU hashes also leak. Conclusion: obfuscation's value "already trending toward zero"; the author advocates verified identity.
- Weakness: client-side obfuscation arms race; vendor positions "trust-based access policies" but publishes no taxonomy; no replay. Strength: deep client sensor, randomized per load.

### 4.6 Vercel

**Firewall bot management [confirmed]**
- Bot Protection managed ruleset (all plans; off by default): JS challenge for "clients that violate browser-like behavior"; blocks "a `curl` request identifying as Chrome"; auto-excludes verified bots; log or challenge mode; "doesn't work when a reverse proxy (e.g. Cloudflare...) is placed in front".
- AI Bots managed ruleset (all plans; "Allow" by default): "AI bots that crawl your site for training data, search purposes, or user-generated fetches"; log or deny; list auto-maintained.
- Verified bots directory (bots.fyi): verified by IP, reverse DNS, or Web Bot Auth (since 2025-08-12; ChatGPT operator was the named signer). Categories observed: `advertising`, `webhook`, `search_engine_optimization`, `search_engine_crawler`, `ai_assistant`, `ai_crawler`, `feed_fetcher`, `monitor`, `preview`, `ecommerce`, `verification`, `analytics`, `accessibility`, `social_media`, `user_initiated`, `agent`. Notable entries: `chatgpt-operator` (ai_assistant), `chatgpt-user`, `gpt-actions`, `oai-searchbot`, `claude-user`, `claude-searchbot`, `claudebot`, `gemini-deep-research`, `google-agent` (category `agent`: "navigates the web and performs actions upon user request, used by agents hosted on Google infrastructure such as Project Mariner"), `google-cloudvertexbot`, `browserbase` (ai_crawler), `kernel`, `cursor-server` (MCP client), `momenticbot`, `qatech`, `stably`, `ryebot` (ecommerce checkout), `channel3bot`, `meta-externalfetcher` (user_initiated, "may bypass robots.txt"), `mistralai-user`, `mistralai-index`, `duckassistbot`, `applebot` (ai_crawler — a GitHub user flags this as a false-positive risk since Applebot powers Siri/Spotlight). Block verified bots via WAF rules on "User Agent" or "Signature-Agent header".
- **BotID**: "invisible CAPTCHA"; Basic (free, all plans) validates challenge integrity; **Deep Analysis "powered by Kasada"** ($1 per 1,000 `checkBotId()` calls on Pro; custom on Enterprise) analyses "thousands of client side signals", "Changing detection methods on every page load to prevent reverse engineering"; fields `isBot`, `isVerifiedBot`, `verifiedBotName` (e.g. `"chatgpt-operator"`), `verifiedBotCategory`; bypass via WAF rule; observability in Firewall tab / Observability Plus; Aug 2025 model update for "bespoke headless browsers and simulated device hardware".
- Weaknesses: no public bypass writeups found (vendor-side obscurity); agent handling is allowlist-by-directory; no behavioural scoring for unknown local agents; no replay; only works when Vercel is the edge.

### 4.7 Fingerprint (FingerprintJS)

- **Bot Detection Smart Signal** [confirmed docs]: results "Good bot" (authorized AI agents, AI assistants, verified crawlers, marketing/monitoring/SEO tools), "Bad bot" ("automation Fingerprint hasn't recognized or verified. This includes Selenium, Puppeteer, and Playwright", and tools impersonating verified ones; "does not, by itself, establish malicious intent"), "Bot not detected". `bot_info` (v4 events) = `category` (examples `ai_assistant`, `ai_agent`, "etc"), `identity` ∈ {`signed`, `verified`, `unknown`, `spoofed`}, `provider`, `name`. Smart Signals reference: `bot` ∈ {`not_detected`, `bad`, `good`}, `bot_type` example `"selenium"`; `developer_tools` (covers "a Chrome instance controlled through an active Chrome DevTools Protocol session"; collected at agent load, so late DevTools missed); `tampering`, `tampering_confidence`, `tampering_ml_score` (>0.8 actionable), `tampering_details.anti_detect_browser`; `virtual_machine` (+ ML score >0.6); plus VPN, Proxy, Tor (`tor_node`), Incognito, Privacy-Focused Settings, Velocity, Suspect Score, MitM, High-Activity Device, mobile integrity signals.
- **Authorized AI Agent Detection** (2026-02-03 with Browserbase) and **AI Assistant Detection** (2026-06-01, preview, free for Smart Signal bot-detection customers): "operates at the HTTP level rather than relying on browser signals"; verification "uses IP-range matching for ChatGPT and Claude, and DNS-based verification for Gemini"; built on the **Automation Intelligence API** ("platform-agnostic", no JS, edge/middleware/backend; a Cloudflare "Flow worker" beta). Roadmap Copilot, Grok, OpenClaw [secondary].
- **Bot Directory** (2026-09-18) [confirmed]: ~128 entries; categories Advertising, Browser automation, AI agent, SEO, AI crawler, eCommerce, Search crawler, AI assistant, AI browser, Scraping, Other, Monitoring, Aggregator, Security, AI search; statuses "Verified", "Signed", "Unknown". Examples: ChatGPT Agent (Signed, AI agent; docs link to OpenAI's "chatgpt-agent-allowlisting" help article, which 403'd), "ChatGPT Agent Dots", Manus Agent (Signed), Browserbase Agent (Signed), Anchor Browser ("supports Web Bot Auth"), Claude Code (CLI) / (Desktop) / (Agent SDK) (Unknown, AI agent), Claude-User (Verified, AI assistant), ClaudeBot (Verified, AI crawler), Claude-SearchBot (Verified, AI search), Gemini Deep Research (Verified). Operator, Comet, OpenClaw not listed.
- BotD open-source library (`@fingerprintjs/botd`): JS-only automation-tool detection (headless, webdriver, CDP-ish artefacts) [knowledge].
- Weaknesses: identity-centric; "bad" conflates all unrecognized automation; agent coverage depends on signatures/IP/DNS; the JS agent is proprietary; no replay (visit history only). Strength: best public enum design (`category` + `identity` + `provider` + `name`) — adopt and extend it.

### 4.8 Arcjet

- SDK runs in app code (Node/Next/Remix/Go...), detection inside a WebAssembly module; "more than 600 different bots ... 25 categories"; categories `ACADEMIC`, `ADVERTISING`, `AI` ("scrape data for AI and LLM purposes"), `AMAZON`, `APPLE`, `ARCHIVE`, `BOTNET`, `FEEDFETCHER`, `GOOGLE`, `META`, `MICROSOFT`, `MONITOR`, `OPTIMIZER`, `PREVIEW`, `PROGRAMMATIC`, `SEARCH_ENGINE`, `SLACK`, `SOCIAL`, `TOOL`, `UNKNOWN`, `VERCEL`, `WEBHOOK`, `YAHOO`; identifiers like `GOOGLE_CRAWLER`, `CURL`, `OPENAI_CRAWLER_SEARCH`; `UNKNOWN_BOT` via request patterns/IP; "bot verification using IP analysis"; results `isSpoofedBot`, `isVerifiedBot`, `isMissingUserAgent`; example denies `CATEGORY:AI` except `PERPLEXITY_CRAWLER`; list source `protocol/src/well-known-bots.ts` [confirmed].
- Guidance: "User-Agent strings are a claim only"; RFC 9421 verification via `web-bot-auth` npm with `Signature-Agent`; cache keys, enforce expiry, "fail closed"; in Go a transport failure fails open [confirmed].
- Weaknesses: UA/IP list based; no behavioural or browser-side signals; no agent-class attribution for undeclared agents; no replay. Strength: developer ergonomics and open bot list.

### 4.9 Castle

- "AI agent detection": "Identify AI agents and browser automation tools that are interacting with your application." API `agent` object: `name`, `operator` (e.g. `openai`), `category` ∈ {`ai_agent`, `browser_automation`, `ai_browser`}, `identified_by` ∈ {`web_bot_auth`, `fingerprint`, `user_agent`}; precedence signature > fingerprint > UA; identification "doesn't change bot or abuse scores"; absent `agent` "does not establish that the request came from a human"; integrations must forward `Signature-Input`, `Signature`, `Signature-Agent`, `Host` [confirmed].
- Signals: "99.5% accurate fingerprinting", labels "Bot behavior", "Headless browser", "HTTP client library", "Emulated device", "Spoofed device", "Missing headers", "Web crawler", IP labels; scores Abuse/ATO/Bot; rules engine with backtesting; session monitoring "down to page views and custom actions", 18 months history; server API `/v1/risk` [confirmed]. Castle's 2025 taxonomy: LLM scrapers (GPTBot `GPTBot/1.1; +https://openai.com/gptbot`, ClaudeBot, PerplexityBot), RAG/search bots (ChatGPT-User, Claude-User), AI agents (cloud: Operator, Skyvern; local: Comet, Stagehand) — local agents "inherit the same fingerprint and session as human traffic", detectable "through side effects like DOM mutations or injected scripts" [confirmed].
- Weaknesses: only ChatGPT agent named in docs; no behavioural agent classifier published; no replay. Strength: clean API design and honest limitations.

### 4.10 Imperva (Thales) Advanced Bot Protection

- "ML-based behavioral analysis + AI tool fingerprinting"; classifies "by tool type, category, and identity"; categories "AI crawlers, AI agents, and AI fetch bots"; "AI Tools dashboard"; "Allow, block, rate-limit, or challenge per AI tool and per endpoint"; 30-day trial; no Web Bot Auth mention (blog 2026-04-06) [confirmed]. cside: shares "the same fundamental limitation as other network-layer solutions regarding in-page behavioural signals" [secondary, competitor].

### 4.11 F5 Distributed Cloud Bot Defense

- "real-time behavioral analysis, client-side intelligence, and platform-wide telemetry"; distinguishes humans, "trusted AI agents" and harmful automation; "allow, block, rate-limit, or step-up"; deploy via Distributed Cloud WAAP, BIG-IP module/iApp, on-prem/hybrid [confirmed]. AWS names F5 among WBA-partner bot vendors [secondary]. No public agent taxonomy found.

### 4.12 Radware

- "Agentic AI Protection Solution" (2026-02-03) protects *enterprise* agents (Copilot Studio, Bedrock) with "external, algorithmic behavioral analysis"; not a website-facing agent detector. Radware Bot Manager's agent features: not found in this session [uncertain]. A later review says agent-trust features "remain on the roadmap" [secondary].

### 4.13 Netacea

- Trust Layer (2026-03-25): "server-side layer" classifying AI agents, crawlers, scrapers, partner automation and malicious bots into useful / ambiguous / harmful; "billions of behavioural signals in real time"; BLADE framework (donated to OWASP); intent analytics [confirmed]. Forrester Strong Performer; pricing "among the most intricate in the market" [secondary].

### 4.14 Arkose Labs

- Platform "Arkose Titan" with "Agent Trust Manager" ("See, classify, and control AI agents"), Device ID, Command Center; sorts each agent "into three populations" (a June 2026 release reportedly names them customer / authorized agent / adversary [secondary]); policy "allow, monitor, or block" per population and journey step; signals cited: build/network changes, "shift to residential and mobile egress", requests that "stopped being signed", changed signatures, scheduled "Agent canary runs"; stats: "97.7%" of legitimate AI agent sessions had no verified disclosure; "35x growth in Meta's Muse sessions in four weeks"; 70.5% of registration sessions fake-account attempts (Jul–Sep 2026) [confirmed on arkoselabs.com]. Forrester Strong Performer; credited for "telltales" explainability [secondary]. Legacy: FunCaptcha/MatchKey interactive challenges [knowledge]. The ICML 2026 "ReCAP" paper shows trained GUI agents reach "non-trivial success rates" on difficult Arkose challenges [secondary snippet; abstract confirmed].

### 4.15 hCaptcha

- "enterprise platform for real-time bot detection, AI agent verification, and fraud prevention"; "Agent Controls" ("Detect and manage agents"); "99.9% passive modes", "Challenge less than 0.1% of legitimate users"; "passive Universal Accessibility system"; blog "hCaptcha CAPTCHAs: Highly Effective Against Bots and Agents in 2026" [confirmed homepage]. Forrester Contender; UI "clunky and engineering-focused" [secondary]. Agents: arXiv honeysite study found Claude for Chrome *refused* a Prosopo CAPTCHA "citing safety guidelines" while ChatGPT Agent *passed* it [confirmed].

### 4.16 Google reCAPTCHA Enterprise / Cloud Fraud Defense

- Forrester Contender; intent analytics "break out only the top four AI agents"; "missing an agent library" [secondary]. reCAPTCHA v3/Enterprise weights IP reputation and cross-site device history; a solver extension dropped pass rate to 0% (one vendor-adjacent test) [secondary]. Google is simultaneously an *agent operator* (Google-Agent) experimenting with Web Bot Auth.

### 4.17 Stytch

- **IsAgent** (`@stytch/is-agent`; `const { is_agent_client_hint, identity } = await isAgent(stytch_public_token)`; identity example "ChatGPT Agent"): signals "User Agent, TLS fingerprint" and "other network characteristics"; "best-effort heuristics"; "will not detect many locally-hosted browser agents"; "client hint", for analytics/agent experience, not blocking; free up to 10,000 calls/month [confirmed]. Web Bot Auth supported in IsAgent and Device Fingerprinting since 2025-09-23 via `Signature-Agent` ("decentralized discoverability") [confirmed]. Device Fingerprinting = the recommended blocking product (passive, ML) [confirmed].

### 4.18 cside

- Client-side script, "No traffic is routed through cside infrastructure, there is no reverse proxy"; checks "atypical device fingerprints", "scripted typing cadence with zero variance", "absence of natural mouse movement"; 100% of sessions, alerts to Slack/Teams/webhook; pricing Free (1,000 calls/mo), Business $99/mo incl. AI agent detection, Enterprise custom [confirmed]. Claim "traditional bot detection tools missed AI agents 81 out of 100 times" has no published methodology [confirmed absence].

### 4.19 AWS WAF Bot Control (not in brief, but the most detailed public label schema) [confirmed]

- Levels: Common (static signatures) and Targeted (`TGT_` browser interrogation, fingerprinting, behaviour heuristics; `TGT_ML_` coordinated-activity ML).
- Labels: `awswaf:managed:aws:bot-control:bot:name:{name}` (incl. "RFC product token from the WBA signature"), `bot:category:{category}` (e.g. `search_engine`, `content_fetcher`, `http_library`, `scraping_framework`, `ai`), `bot:organization:{org}`, `bot:verified`, `bot:unverified`, `bot:user_triggered:verified` ("treated ... like an unverified bot"), `bot:developer_platform:verified`, `bot:vendor:{vendor}` (AgentCore only), `bot:account:{hash}` (Bedrock AgentCore account hash), `bot:web_bot_auth:verified|invalid|expired|unknown_bot`; signals `signal:automated_browser`, `targeted:signal:browser_automation_extension` (Selenium IDE etc.), `targeted:signal:browser_inconsistency`, `signal:cloud_service_provider:{aws|gcp|azure|oracle}`, `token_provenance:ip_category_mismatch:{high|medium|low}` (token acquired on datacentre IP, presented from residential), token reuse across IPs/countries/ASNs, token fingerprint label `awswaf:managed:token:fingerprint:{id}`.
- Rule `CategoryAI`: "applies the action to all matches, regardless of whether the bots are verified or unverified" → Block by default. When `web_bot_auth:verified` is present, category rules and `TGT_TokenAbsent` do not match.
- Deployment: AWS WAF/CloudFront only. Review: CloudWatch label metrics, logs; no replay.

### 4.20 Smaller and adjacent players

- **Prosopo** (CAPTCHA; used in the arXiv honeysite study; self-published Forrester critique). **WebDecoy** (Anubis deep-dive blog). **Kernel** (agent-browser infrastructure vendor; publishes the clearest "what trips detection" guidance). **Browserbase** "Verified" browsers ("Real browser fingerprints - not randomly generated configurations", Windows OS default on Verified, Linux otherwise; CAPTCHA solving; residential proxies; AgentKit "Prove that your agent is human-backed in x402 sessions") [confirmed] — note this is a *detection target* that also cooperates with identity rails.

## 5. Content licensing / monetization intermediaries

| Player | Model | Detection/gating | Numbers | Confidence |
|---|---|---|---|---|
| TollBit | "Bot & agent paywall", TollBit Analytics, "Licensed RAG access", Content controls, Agent Site, MCP, "Scraper audit"; publishers keep 100%, AI companies pay a transaction fee | authentication + licences + pricing enforcement at the edge (mechanics not published on homepage); integrated by Akamai and DataDome | H1 2026: 987B+ visits analysed, 22B+ AI bot scrapes, 1.9B+ "bypassed or ignored robots.txt", 2.6B+ directed to the Bot Paywall; TIME deals with OpenAI and Perplexity | [confirmed homepage; fee model secondary] |
| ScalePost | licensing marketplace, ~15% cut; also citation analytics | — | — | [secondary] |
| ProRata.ai | answer engine on licensed content; 50/50 revenue share by attribution; 500+ publishers | — | — | [secondary] |
| Dappier | priced content APIs / ads in AI answers; listed as a live Skyfire KYA implementation | Skyfire tokens | thin 2026 evidence | [secondary/uncertain] |
| Microsoft Publisher Content Marketplace | pay-per-use, announced Feb 2026; cut unclear | — | — | [secondary] |
| Cloudflare Pay Per Crawl / Monetization Gateway | 402 + Web Bot Auth; x402 stablecoins; est. ~30% cut | signed crawlers only; anonymous x402 planned | — | [confirmed mechanics; cut secondary] |
| IAB Tech Lab CoMP | access-token licensing flow, CPCr, ingest API, logging | "not a blocking system" | v1 final 2026-04-28 | [confirmed] |

Open Markets Institute report "Same Gatekeepers, New Tollbooths" (Radsch & Montoya, May 2026) warns intermediaries' "take rates, and governance norms" are hardening [secondary]. Stack Overflow moved from blocklists ("whack-a-mole") to Cloudflare pay-per-crawl; "bots must be registered to be identified and charged"; "some bots that had received a 403 stopped sending traffic after receiving a 402" [confirmed].

## 6. Open-source and community defences

### 6.1 Anubis (Techaro) [confirmed]
- MIT, Go+JS; proof-of-work (SHA-256 leading zeros; "five leading zeros (the default) in seconds, while one with six can take several minutes"); EdDSA-signed JWT cookie `techaro.lol-anubis-auth`; v1.20.0 added weighted thresholds and a no-JS meta-refresh challenge; latest 1.28.2 (2026-10-23).
- Default policy (`botPolicies.yaml`): imports `bots/_deny-pathological.yaml`, `bots/aggressive-brazilian-scrapers.yaml`, `common/domain-fronting.yaml`, `meta/ai-block-aggressive.yaml`, `crawlers/_allow-good.yaml` (Google, Apple, Bing, DuckDuckGo, Qwant, Internet Archive, Kagi, Marginalia, Mojeek, Arquivo.pt), `clients/x-firefox-ai.yaml`, `crawlers/xai.yaml`, `common/keep-internet-working.yaml`; WEIGH rules: GeoIP `BR`, `CN` +10; ASNs 13335 (Cloudflare), 136907 (Huawei Cloud), 45102 (Alibaba Cloud) +10; `user_agent_regex: Mozilla|Opera` +10; thresholds: ≤0 ALLOW; 0<w<10 CHALLENGE metarefresh difficulty 1; 10–19 fast difficulty 2; 20–29 fast 4; ≥30 fast 6; honeypot `naive`; status codes 200 for CHALLENGE and DENY (to look like success).
- `ai-catchall.yaml` DENY regex (one alternation): `AI2Bot|Ai2Bot-Dolma|aiHitBot|Amazonbot|anthropic-ai|Brightbot 1.0|Bytespider|Claude-Web|cohere-ai|cohere-training-data-crawler|Cotoyogi|Crawlspace|Diffbot|DuckAssistBot|FacebookBot|Factset_spyderbot|FirecrawlAgent|FriendlyCrawler|Google-CloudVertexBot|GoogleOther|GoogleOther-Image|GoogleOther-Video|iaskspider/2.0|ICC-Crawler|ImagesiftBot|img2dataset|imgproxy|ISSCyberRiskCrawler|Kangaroo Bot|meta-externalagent|Meta-ExternalAgent|meta-externalfetcher|Meta-ExternalFetcher|NovaAct|omgili|omgilibot|Operator|PanguBot|Perplexity-User|PerplexityBot|PetalBot|QualifiedBot|Scrapy|SemrushBot-OCOB|SemrushBot-SWA|Sidetrade indexer bot|TikTokSpider|Timpibot|VelenPublicWebCrawler|Webzio-Extended|wpbot|YouBot` (note `NovaAct` and `Operator` as UA tokens — unverified that those products actually send them).
- Adoption: GNOME GitLab, kernel.org LKML archive, sourceware, FFmpeg, Wine, Wikimedia Foundation, UNESCO, FreeCAD, ScummVM, Duke, OpenWRT, etc. Duke pilot: >4M unwanted requests/day blocked; 12 user complaints in one week (cookies).
- Weaknesses: Codeberg (Aug 2025): scrapers "learned how to solve the Anubis challenges"; Tavis Ormandy: compute cost negligible ("I don't think we reach a single cent per month in compute costs until several million sites have deployed Anubis") and native solvers beat browser JS; blocks no-JS users; battery/old-device cost; the challenge page itself denied my fetcher ("Access Denied: error code ..."). Paid "Thoth" reputation service.

### 6.2 go-away [knowledge, could not fetch]
- Go reverse-proxy challenge framework (git.gammaspectra.live/git/go-away) with a richer policy language than Anubis: conditions on headers, UA, ASN/IP lists, TLS fingerprints; challenge types incl. non-JS (meta refresh/cookie), JS proof-of-work, header checks, DNSBL; actions pass/challenge/deny/poison. Verify before citing.

### 6.3 Nepenthes [confirmed]
- "a tarpit intended to catch web crawlers"; endless deterministic pages with dozens of self-links; drip-fed responses (`proxy_buffering` off); Markov text from a per-silo `corpus`; config `min_wait`/`max_wait`/`zero_delay`/`header_wait_*`, `redirect_rate` (v2.5+), `wordlist`, `templates`; routing via `X-Silo`; stats at `/stats`, `/stats/agents`, `/stats/addresses`, `/stats/buffer`; warnings: "DELIBERATELY MALICIOUS", "SIGNIFICANT CONTINUOUS CPU LOAD", "ANY SITE THIS SOFTWARE IS APPLIED TO WILL LIKELY DISAPPEAR FROM ALL SEARCH RESULTS".

### 6.4 Iocaine [confirmed]
- Rust, hidden-Markov nonsense generator; Lua/Fennel/Roto scripting; default heuristics flag known-bad UAs, hits on generated URLs, traffic that "claims to be a mainstream browser but that doesn't set a Sec-Fetch-Site header", and datacentre ASNs; non-matching traffic gets `421 Misdirected Request` so the proxy falls through to the real site; ~55 MB resident; no measured traffic reduction; commenters object that datacentre blocking hits legitimate proxy users.

### 6.5 Quixotic [knowledge, site returned 522]
- marcusb.org Markov-chain content poisoner that generates a static maze of pages (or proxies) seeded from a corpus; intended for bots ignoring robots.txt. Verify.

### 6.6 Cloudflare AI Labyrinth — see 4.1 (the only hosted decoy with ML feedback).

### 6.7 Platforms
- **Wikimedia** [confirmed]: bots ≈35% of pageviews but "at least 65% of the resource-intensive traffic"; multimedia bandwidth +50% since Jan 2024 from scrapers; May 2025 surge of "apparently human traffic, mostly originating from Brazil" was "bots that were built to evade detection"; bot-detection logic updated, Mar–Aug 2025 reclassified, human pageviews down "roughly 8%" YoY; FY2025–26 initiative "WE5: Responsible Use of Infrastructure" ("Our content is free, our infrastructure is not"). Wikimedia also runs Anubis on some properties.
- **Reddit** [confirmed/secondary]: API paywall 2023; Google ($60M/yr) and OpenAI licences (~10% of revenue, expiring 2027); lawsuits v. Anthropic (June 2025) and v. SerpApi/Oxylabs/AWMProxy/Perplexity (Oct 2025) — in July 2026 a federal judge "largely denied motions to dismiss, letting DMCA and civil conspiracy claims against Perplexity proceed"; blocked Wayback Machine crawling in 2025 [knowledge].
- **Stack Overflow** [confirmed]: pay-per-crawl with Cloudflare (402); "whack-a-mole" blocklists abandoned; registered bots only.

## 7. What the agent operators themselves declare (the "easy" surface)

| Operator / product | Token / UA (exact where confirmed) | robots.txt | Verification | Signs (WBA) | Source |
|---|---|---|---|---|---|
| OpenAI GPTBot | `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.4; +https://openai.com/gptbot` | yes | `https://openai.com/gptbot.json` | no | [confirmed] |
| OpenAI ChatGPT-User | `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot` | "may not apply" | `https://openai.com/chatgpt-user.json` | no | [confirmed] |
| OpenAI OAI-SearchBot | `...compatible; OAI-SearchBot/1.4; +https://openai.com/searchbot` | yes | `https://openai.com/searchbot.json` | no | [confirmed] |
| OpenAI OAI-AdsBot | `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-AdsBot/1.0; +https://openai.com/adsbot` | n/s | `https://openai.com/adsbot.json` | no | [confirmed] |
| OpenAI ChatGPT agent (cloud browser; "Operator" name retired) | Chromium 141 class UA; fixed 1280×960 screen; reports 13 CPU cores; font list "only Calibri"; unique JA4 | n/a | signed | `Signature-Agent: https://chatgpt.com` | [confirmed arXiv/FP-Agent; WorkOS secondary] |
| OpenAI Atlas | local macOS browser; shut down 2026-08-09 | n/a | none | no | [confirmed Wikipedia] |
| Anthropic ClaudeBot / Claude-User / Claude-SearchBot | tokens only; `Crawl-delay` honoured for ClaudeBot | "honoring industry standard directives" | `https://claude.com/crawling/bots.json` | no | [confirmed] |
| Anthropic Claude for Chrome | user's own Chrome + session; no self-identification documented; blocked categories (financial, adult, pirated); asks before purchases; refused a CAPTCHA in testing | n/a | none | no | [confirmed] |
| Anthropic Claude Code (CLI/Desktop/SDK) | Fingerprint lists as "Unknown" identity AI agent | n/a | none | no | [confirmed listing; mechanism unknown] |
| Perplexity PerplexityBot | `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)` | yes | `https://www.perplexity.com/perplexitybot.json` | no | [confirmed] |
| Perplexity Perplexity-User | `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Perplexity-User/1.0; +https://perplexity.ai/perplexity-user)` | "generally ignores robots.txt rules" | `https://www.perplexity.com/perplexity-user.json` | no | [confirmed] |
| Perplexity Comet | local agentic browser; not documented by Perplexity | n/a | none | no | [confirmed absence] |
| Google-Agent | desktop UA contains `(KHTML, like Gecko; compatible; Google-Agent; +https://developers.google.com/crawling/docs/crawlers-fetchers/google-agent)` + `Chrome/W.X.Y.Z Safari/537.36` | user-triggered fetchers "generally ignore robots.txt rules" | `https://developers.google.com/static/crawling/ipranges/user-triggered-agents.json`; rDNS `***.gae.googleusercontent.com` / `google-proxy-***.google.com` | experimenting, `https://agent.bot.goog` | [confirmed] |
| Google others | Google-Extended (training opt-out token), Google-CloudVertexBot, Gemini Deep Research, Google-GeminiNotebook (ex Google-NotebookLM until Aug 2026), Google-Read-Aloud | varies | `user-triggered-fetchers.json`, `user-triggered-fetchers-google.json` | no | [confirmed] |
| Meta-ExternalAgent / Meta-ExternalFetcher / Meta-WebIndexer | listed in Vercel directory; Fetcher "may bypass robots.txt" | varies | IP | no | [confirmed directory] |
| Amazonbot, Amzn-SearchBot, Amazon Nova Act | Amazonbot verified in directories; `NovaAct` appears only in Anubis' deny regex | — | IP | AgentCore preview | [confirmed/uncertain] |
| Bytespider / TikTokSpider | in Anubis deny list; 1.4% of AI traffic (DataDome) | often ignores | none | no | [secondary] |
| Manus | "Manus Agent" Signed (Fingerprint); Cloudflare has a "Manus Bot" rule; agent reports Meta as provider in FP-Agent table | — | WBA | yes | [confirmed] |
| Browserbase / Kernel / Anchor | directory entries (`browserbase`, `kernel`, `kernel-searchbot`); Browserbase Identity beta | — | WBA (beta) | partial | [confirmed] |
| Browser Use (cloud) | advertises cookie blocking, CAPTCHA solving, country proxies; stealth mode used low-reputation datacentre IPs; custom CDP interface; inter-key ~5.31 ms | ignores | none | no | [confirmed arXiv] |
| Skyvern (cloud/local) | Playwright, Edge 143/144, reports 32 CPU cores, overrides timezone/screen; residential proxies | ignores | none | no | [confirmed arXiv] |
| Crawl4AI | Playwright; `robots.txt checking is disabled by default`; stealth spoofs UA (detectable via `userAgentData` mismatch) and injects synthetic referers | ignores by default | none | no | [confirmed arXiv] |
| OpenClaw | local Chrome + Playwright; source mentions "reducing the browser automation footprint to improve stealth"; passed every tested defence | ignores | none | no | [confirmed arXiv] |
| Cursor (MCP client) `cursor-server` | Vercel directory | — | — | — | [confirmed] |
| Extension/agentic browsers: Gemini in Chrome, Edge Copilot mode, Dia | no documentation of self-identification found | n/a | none | no | [uncertain / gap] |

## 8. Efficacy and bypass evidence (consolidated)

| Study / event | Setup | Result | Implication |
|---|---|---|---|
| arXiv 2606.30119 (Jun 2026) | 6 agents (OpenClaw, Claude for Chrome, Crawl4AI, BrowserUse local+cloud, ChatGPT Agent, Skyvern) vs robots.txt, UA filter, reCAPTCHA v3, Prosopo, Anubis, Turnstile, Cloudflare BFM + Block AI Bots; honeysites with IP/TLS/HTTP/browser fingerprinting | OpenClaw and Claude for Chrome bypassed everything; Random Forest on all layers accuracy 0.993 (browser FP alone 0.931, IP 0.596, TLS 0.454); 21 unique JA4s, ChatGPT Agent's JA4 unique; "stealth ... often increase detectability"; Claude Chrome refused CAPTCHA 20×; ChatGPT Agent tried to read its own UA via external site/terminal and hopped to alternate honeysites | Cross-layer consistency checks and behaviour beat any single layer; CAPTCHAs are policy, not technical, barriers for frontier agents |
| FP-Agent, arXiv 2605.01247 (May 2026) | 7 agents (Atlas, ChatGPT Agent, Claude for Chrome, Comet, Manus, Browser Use v0.9.2, Skyvern v0.2.23) vs humans on flight booking, shopping, forum tasks; 418 browser + 50 behavioural features; XGBoost | behavioural F1 0.9993, combined 1.000; Atlas/Browser Use/Claude share a macOS fingerprint; top features: paste event presence, mouse curvature range, hold/inter-key medians, scroll distance SD; agents "produce mouse events only at click time and jump directly to targets"; inter-key latencies Browser Use 5.31 ms, Skyvern 9.52, Manus 1.39, Claude <1 ms, Comet paste hold 2.97 ms, ChatGPT Agent Ctrl+V hold 66.58 ms; behavioural F1 plateaus ~3 min, combined ~1 min; unseen-task drop up to 0.369 (behavioural only) vs ≤0.0684 (combined); Cloudflare free tier caught only Manus | Build the classifier on input-event micro-timing + fingerprint consistency; expect task drift, so ensemble |
| Akamai telemetry (2026) | Comet, Atlas, Claude extension on production sites | >98% of agentic requests have little/no mouse data; MAE transformer ROC-AUC 0.981 | Sparse-telemetry models are mandatory; absence of telemetry is itself a feature |
| ianlpaterson benchmark (May–Aug 2026) | 7 tools × 31 targets × 3 runs from one residential Mac | nodriver 28 OK/0 hard blocks; CloakBrowser 26/2; curl_cffi 26/2; Patchright 25/3; Camoufox 25/3; vanilla Playwright 24/5; rebrowser 24/5; only nodriver passed the Turnstile site; Camoufox's Firefox TLS flagged on dev.to | Protocol-layer (CDP) fingerprinting is the current frontier; TLS still matters for Firefox-based stealth |
| Kernel on Kasada | raw CDP vs Playwright `connectOverCDP` | identical observable browser props, different JS error shapes → Playwright failed | Error-object/inspector-state probes are a robust automation tell |
| Kernel 2026 guide | vendor practitioner notes | CDP `Runtime.enable`, `Runtime.addBinding`, `Console.enable`, `Page.addScriptToEvaluateOnNewDocument` visible; "Automation-protocol fingerprinting is now competitive with fingerprint patching"; synthetic `page.mouse.move` detectable; "near-zero variance" timing flagged; DataDome detects Browser Use/Stagehand DOM markers; Web Bot Auth signing used "only on destinations confirmed to verify signatures" | Agents will sign only where it helps them; detectors must not reward signing with blanket trust |
| Cloudflare v. Perplexity (Aug 2025) | honeypot domains | undeclared Chrome/124 macOS UA from rotating ASNs; de-listed | Operators do run stealth crawlers; declared identity is not the whole operator |
| Codeberg / Anubis (Aug 2025) | production | scrapers solved PoW at scale | PoW is a cost lever, not a gate |
| ChatGPT agent + Cloudflare checkbox (Jul 2025) | consumer screenshot | agent clicked "Verify you are human" | Checkbox-style challenges are solved by real-browser agents [knowledge] |
| ReCAP (ICML 2026) | trained GUI agent on 7 CAPTCHA types | "substantially improves" solving; non-trivial on hard Arkose types | Interactive CAPTCHAs are decaying |
| DataDome benchmark (Jun 2026) | 21,491 domains × 10 bots | 2.4% fully protected | The market's floor is very low; most sites run nothing |
| Arkose (Jul–Sep 2026) | production | 97.7% of legitimate agent sessions undisclosed | Declared identity covers a tiny minority of agent sessions |

## 9. Review / replay / forensics: who has what

| Vendor | Evidence per decision | Session-level view | Replay | Export |
|---|---|---|---|---|
| Cloudflare | `detection_ids`, `BotTags`, JA4 signals (Enterprise); Labyrinth Served/Crawls events | Security Analytics, Bot Analytics | no | Logpush |
| Akamai | bot score, risk tiers; TrafficPeak analytics | web security analytics | no | SIEM |
| DataDome | botname/botfamily headers; "Agent Detailed View: Last 1,000 requests" with detection output; Explore grouping by agent/intent/trust authority | yes (agent-centric) | no | logs integration |
| HUMAN | "attack profiles" (Forrester-praised) | Sightline dashboards | no | integrations |
| Kasada | verification results, request patterns, endpoint interactions; Custom Reporting | portal | no | reports |
| Vercel | Firewall tab filter by BotID; Observability Plus | per project | no | drains |
| Fingerprint | per-event Smart Signals, visitor history | visitor timeline | no | webhooks |
| Castle | labels, scores, rule backtesting, 18-month history | "Full user and company history, down to page views and custom actions" | no | API |
| Arkose | "telltales", Command Center, scheduled canary runs | population views | no | — |
| AWS WAF | labels in logs/CloudWatch | — | no | logs |
| cside | per-session flags and alerts | 100% of sessions | no | webhooks |
| Anubis / Nepenthes / Iocaine | logs, `/stats` | no | no | — |

No vendor provides (a) a per-request *evidence bundle* (which signals fired, their weights, the raw values, a confidence interval) that the site owner can inspect and contest, nor (b) DOM/input replay of an agent session. That is the single clearest product gap.

## 10. Gap analysis: what nobody does well yet

1. **Agent-class taxonomy with provider attribution and confidence.** Public taxonomies stop at 3–4 buckets (Cloudflare Search/Agent/Training/Transact; DataDome AI Crawler/AI Assistant/Autonomous Agent/Agentic Browser; Castle ai_agent/browser_automation/ai_browser; Fingerprint 15 directory categories). None attribute *undeclared* agents to a provider or framework. FP-Agent shows it is feasible for a closed world of 7; the arXiv honeysite paper attributes by JA4 + browser fingerprint. **Hook:** ship a closed-world classifier (Browser Use, Stagehand/Playwright MCP, Skyvern, Crawl4AI, OpenClaw, ChatGPT agent, Claude for Chrome, Comet, Gemini/Google-Agent, Manus, Nova Act) with an "unknown automated" class, and expose `{class, framework, provider, confidence, evidence[]}`.
2. **LLM-specific behavioural features.** Vendors still run mouse-trajectory models designed for scripted bots. Evidence-backed features: paste-vs-keystroke input, sub-millisecond inter-key latency with near-zero variance, mouse events only at click time, teleporting cursor, step scrolling vs. bursts, multi-second irregular pauses between actions (model thinking), absence of hover/idle motion, fixed viewport (1280×960), odd `hardwareConcurrency` (13, 32), `userAgentData` vs UA mismatch, non-standard permission states. **Hook:** per-session feature vector + lightweight sparse-telemetry model (Akamai-style) that produces a verdict within ~60 s.
3. **Extension-agent detection (Claude for Chrome, Gemini in Chrome, Comet, Edge Copilot mode).** These inherit the human's fingerprint, cookies and IP; nobody claims reliable detection and the two 2026 papers show vendors miss them. Signals that still exist: input-event provenance (`isTrusted`, pointer event fidelity, missing `pointermove` streams), extension-injected DOM/CSS artefacts, accessibility-tree enumeration patterns, screenshot-cadence `requestAnimationFrame` anomalies, action bursts after long idle, reading-pattern vs. click-pattern mismatch. **Hook:** instrument the SDK to score *provenance of interaction* rather than device identity.
4. **Semantic / prompt-injection canaries, done ethically.** The only precedent is an SSH honeypot (LLM Agent Honeypot: 8.1M attempts, 8 potential AI agents). On the web nobody ships canaries. **Hook:** invisible-to-humans instructions that cause an LLM-driven agent to emit a harmless, detectable side-effect (e.g., request a unique beacon URL, include a token in a form field that humans never see) — never instructions that change the user's task, leak data or make purchases. Pair with Labyrinth-style hidden links.
5. **Cross-layer consistency as a first-class score.** Kasada's lesson: "whether the javascript engine, the dom, and the protocol layer all tell the same story". Only Kasada/HUMAN/Akamai do this deeply and all are opaque. **Hook:** TLS/JA4 ↔ UA ↔ Client Hints ↔ JS engine quirks ↔ GPU/canvas ↔ CDP artefacts ↔ IP class, each mismatch an explainable evidence item.
6. **Automation-protocol fingerprinting in the SDK.** CDP side-effects (inspector state, error shapes, `Runtime.enable` artefacts, `navigator.webdriver` getter integrity) are what currently separates nodriver from Playwright. **Hook:** implement crash-and-capture and inspector-state probes; rotate them.
7. **Explainable evidence and contestability.** Forrester now scores explainability; Prosopo's critique of managed black boxes stands. **Hook:** every verdict ships with the evidence list, weights and raw values; site owners can mark false positives and the model learns per-site.
8. **First-class identity-rail parsing.** Only DataDome ingests Web Bot Auth + Skyfire + Visa TAP + MCP headers today. **Hook:** parse `Signature-Agent`/`Signature-Input`/`Signature`, `Skyfire-Pay-Id`, TAP registry signatures, `Forwarded` (Cloudflare experiment), x402 payment proofs, UCP OAuth tokens; verify keys; surface `declared_identity`, `verification_strength`, `principal` separately from behaviour.
9. **Self-hostable, open client-side SDK + optional edge companion.** Every strong detector is edge/proxy and proprietary (Fingerprint's BotD is open but shallow; Arcjet is app-side but list-based; cside is script-only but closed). **Hook:** open SDK, documented signals, pluggable server verifier, no mandatory data egress.
10. **Replay and review.** Nobody reconstructs an agent session. **Hook:** rrweb-style capture gated by verdict (only for suspected agents, with PII masking), aligned with the evidence timeline.
11. **Spoof-resistant allowlisting.** 79.7% of sites do not challenge a spoofed ChatGPT UA; verifiers still trust IP lists that rotate. **Hook:** declared identity is never sufficient; require signature or IP+rDNS+behaviour agreement; treat `user_triggered` fetchers (ChatGPT-User, Perplexity-User, Google-Agent) as a distinct class that legitimately ignores robots.txt.
12. **Graduated, reversible interventions with telemetry.** Vendors offer block/challenge/rate-limit/monetize; few offer degrade (serve cached/markdown), decoy (Labyrinth), tarpit (Akamai, Nepenthes) and *redirect to an agent gateway* (MCP/UCP endpoint) as a single policy surface with measurable effect. **Hook:** policy engine keyed on `{class, provider, verification_strength, intent, page sensitivity}`.

## 11. Legal and ethical constraints on interventions

### 11.1 Computer Fraud and Abuse Act (US) and trespass
- *Van Buren v. United States* (2021-06-03) narrowed "exceeds authorized access" to information in "areas of the computer" that are "off-limits"; the Court's footnote left open whether purely contractual limits count [confirmed holding; footnote wording knowledge]. *hiQ v. LinkedIn*: Ninth Circuit (2019, reaffirmed April 2022 after remand) held scraping public data likely does not violate the CFAA; the district court (Nov 2022) found hiQ breached the User Agreement; settlement followed [confirmed]. *Craigslist v. 3Taps*: cease-and-desist plus IP blocking was sufficient for a CFAA claim [confirmed Wikipedia]. *Meta v. Bright Data* (Jan 2024) and *X Corp v. Bright Data* (May 2024) rejected ToS/copyright claims over scraping public data [confirmed]. *Ryanair v. Booking.com* (D. Del. 2024): jury found CFAA violation for circumventing Ryanair's anti-bot measures with nominal damages [knowledge]. *eBay v. Bidder's Edge* (trespass to chattels, injunction) [confirmed].
- Implication: visible technical barriers (login walls, blocks, challenges, 402s) are what convert "public data" into "gates down"; our interventions strengthen the site owner's legal position. Decoys and tarpits are permissible self-help on one's own server; they must not damage the visitor's system (no zip bombs that crash browsers, no malware), or they invite counterclaims and reputational harm.

### 11.2 DMCA §1201 (anti-circumvention)
- *Ticketmaster v. RMG Technologies* (C.D. Cal. 2007): circumventing CAPTCHA/anti-bot controls supported DMCA §1201 and infringement claims [knowledge]. *Reddit v. SerpApi, Oxylabs, AWMProxy, Perplexity* (S.D.N.Y., filed Oct 2025): DMCA claims about circumventing anti-bot protections "largely" survived motions to dismiss in July 2026 [confirmed via Wikipedia summary; verify docket]. Also the EU GPAI Code of Practice commits signatories not to circumvent technological protection measures such as paywalls [knowledge].
- Implication: document our controls as "technological measures that effectively control access" (challenge tokens, signed cookies, 402 gates). Keep logs of circumvention attempts; they are evidence.

### 11.3 EU copyright: DSM Directive Art. 4 TDM opt-out, AI Act, robots.txt weight
- Art. 4(3): the commercial TDM exception does not apply where rightholders have reserved rights "in an appropriate manner, such as machine-readable means in the case of content made publicly available online"; Recital 18 cites "metadata and terms and conditions of a website or a service" [knowledge; EUR-Lex returned empty]. Cloudflare's Content Signals explicitly invoke this ("EXPRESS RESERVATIONS OF RIGHTS") [confirmed]. Case law: *Kneschke v. LAION* (LG Hamburg Sept 2024; appeal decided 2025) applied the research exception and discussed natural-language reservations as potentially machine-readable in the AI era; *GEMA v. OpenAI* (LG München I, 2025-11-11) found memorized lyrics in model weights infringing and outside TDM; *Like Company v. Google* (C-250/25) pending at the CJEU [knowledge; all three unverified in session]. AI Act Art. 53(1)(c) requires GPAI providers to have a copyright policy that identifies and complies with Art. 4(3) reservations "including through state-of-the-art technologies"; the GPAI Code of Practice (July 2025) names robots.txt and other machine-readable protocols [knowledge]. IETF AIPREF vocabulary/attachment drafts target Aug 2026 [confirmed]. Wikipedia's article on the directive calls the AI Act's reference to Art. 4 "a clear indication of the EU legislator's intention that the exception covers AI data collection" [confirmed].
- robots.txt (RFC 9309) is voluntary: Perplexity-User "generally ignores robots.txt rules", Google user-triggered fetchers "generally ignore robots.txt rules", ChatGPT-User says rules "may not apply", Meta-ExternalFetcher "may bypass robots.txt" [confirmed]. Legally it is evidence of a reservation and of lack of authorization, not an access control.
- Implication: emit Content-Signal/AIPREF reservations, log who violates them, and present violations in the review UI as evidence; do not claim robots.txt alone "blocks" anything.

### 11.4 Accessibility: do not block assistive technology
- WCAG 2.2 SC 3.3.8 Accessible Authentication (Minimum, AA): "A cognitive function test (such as remembering a password or solving a puzzle) is not required for any step" unless an alternative, a mechanism to assist, object recognition, or personal content applies; an audio CAPTCHA requiring transcription does not satisfy the alternative [confirmed].
- W3C "Inaccessibility of CAPTCHA" (Group Draft Note, 2021-12-16): "we prefer non-interactive approaches because these pose no accessibility challenges"; honeypots "should be considered"; heuristics acceptable only if accurate; proof-of-work "poses no direct accessibility problems, though it may slow performance for users of older hardware" and "requires client-side JavaScript"; where interactive, "a variety of alternative challenges must be made available"; test with assistive technologies [confirmed].
- ADA Title II web rule: WCAG 2.1 AA; compliance dates were extended by an April 20 2026 Interim Final Rule to **2027-04-26** (≥50,000 population) and **2028-04-26** (smaller entities) [confirmed ada.gov]. European Accessibility Act applies to services placed on the market from **2025-06-28**, covering e-commerce and banking; EN 301 549; micro-enterprise service exemption; national fines (e.g., Austria up to €80,000) [confirmed].
- Implication: assistive technologies (screen readers, switch access, voice control, Google-Read-Aloud, accessibility bots in Cloudflare's `Accessibility` category) produce "non-human" input patterns. The SDK must (a) never apply an interactive cognitive challenge as the only path, (b) default to passive scoring and non-blocking actions for low-confidence verdicts, (c) treat AT-consistent signals (AT APIs, `prefers-reduced-motion`, keyboard-only navigation, focus-ring usage) as *human-leaning* evidence, and (d) keep an accessible, human-reviewed appeal path. Anubis' JS-only gate and Duke's cookie complaints show the cost of ignoring this.

### 11.5 Consumer protection and dark patterns (decoys, degradation)
- FTC "Bringing Dark Patterns to Light" (Sept 2022) and FTC Act §5 (deception/unfairness); EU DSA Art. 25 bans deceptive interface design on platforms [confirmed report exists; categories and DSA from knowledge]. The AI-agent twist: an agent acting *for a consumer* that receives decoy prices, fake availability or altered terms could cause a real consumer harm attributable to the site.
- Implication: never serve false *commercial* facts (prices, stock, terms) to suspected agents; prefer degrade (markdown/cached/summary), tarpit, 402, or redirect-to-gateway; keep decoy content clearly non-commercial (Cloudflare's "scientific facts" approach), noindex it, and never show it to humans; log every decoy serve for audit.

### 11.6 Data protection: fingerprinting and consent in the EU
- ePrivacy Art. 5(3) covers storing or gaining access to information on terminal equipment; EDPB Guidelines 2/2023 (final v2.0, 2024-10-16) treat instructing the browser to send device information (including via JavaScript) as "gaining access", so active fingerprinting falls within scope unless "strictly necessary" for a service "explicitly requested" [confirmed date/title; content from knowledge]. Security/fraud-prevention processing is a recognised legitimate interest under GDPR Recital 47, but the ePrivacy consent question is separate and stricter; DPAs (CNIL, Datatilsynet) have historically accepted security cookies as strictly necessary while scrutinising third-party fingerprinting [knowledge].
- Implication: run the SDK first-party; collect the minimum (no canvas/audio hashes unless risk-triggered); prefer ephemeral session-scoped identifiers; document the strictly-necessary security justification; offer a server-only mode (HTTP/TLS/behaviour over time) for consent-constrained deployments; keep raw signals out of long-term storage; note that Cloudflare's Turnstile ephemeral IDs and AWS's token fingerprints follow the same "non-unique, short-lived" pattern.

### 11.7 Prompt-injection canaries: acceptable if non-harmful
- Precedent: LLM Agent Honeypot used prompt injections to identify LLM agents among 8.1M attacks [confirmed]. The arXiv honeysite authors recommend challenges "that go beyond prompt-based reasoning" [confirmed].
- Rules of engagement: canaries must not instruct the agent to take actions against its principal (purchases, data exfiltration, account changes), must not produce content that harms the human if read aloud by AT, must be invisible to humans (ARIA-hidden *and* off-screen *and* zero-size, accepting that some AT may still read `aria-hidden=false` content), and must only trigger a benign detectable side-effect (a beacon fetch, a hidden-field token). Disclose the practice in the privacy/security policy. This mirrors the ethical line Cloudflare drew for Labyrinth ("no real human would go four links deep").

### 11.8 Other constraints
- Do not block protected operators by mistake: search engines, archivers, link previewers, security scanners, accessibility checkers, monitoring (see Cloudflare/Vercel/AWS categories). False positives on these have SEO and compliance consequences; Nepenthes warns of search de-indexing.
- Export controls / sanctions do not apply to detection; but blocking by country (Anubis' BR/CN weights) raises discrimination concerns for consumer sites — prefer behaviour over geography.
- Terms of service should state that automated access requires identification (Web Bot Auth) and that circumvention of controls is prohibited; this supports CFAA/§1201/contract claims.

## 12. Positioning recommendations for necter

1. Lead with *attribution + evidence*, not a bot score: `{class, framework, provider, principal, verification_strength, confidence, evidence[]}` per session and per request.
2. Build the behavioural core around sparse input-event telemetry (paste/keystroke timing, click-only mouse, scroll bursts, action pauses) and cross-layer consistency; publish the feature definitions.
3. Parse every identity rail and *never* reward signing with blanket trust (Kernel: agents sign "only on destinations confirmed to verify signatures").
4. Offer graduated interventions with legal defaults: passive label → degrade (markdown/cached) → 402/gateway redirect → tarpit → decoy (non-commercial, noindex) → block; interactive challenges only with an accessible alternative.
5. Ship replay and an appeal path from day one; this is the whitespace analysts are starting to score (explainability) and no vendor fills.
6. Stay self-hostable and first-party to clear ePrivacy/GDPR review in the EU, where the enterprise vendors require data egress.

## 13. Unknowns and items to verify

- Exact `Signature-Agent` domains for Browserbase, Anchor, Goose, Manus; whether Google-Agent currently signs in production.
- OpenAI's ChatGPT agent allowlisting article (help.openai.com/en/articles/11845367) contents: UA string, IP JSON, key directory (403 in session).
- DataDome's trust-score bands, numeric FP claims ("0.01%"), and the full Agent Catalog list (marketing pages 403; docs partial).
- HUMAN's 2026 report numbers (PDF unreadable) and AgenticTrust signal details.
- Kasada's agent directory contents and whether Vercel BotID surfaces Kasada's agent verdicts.
- Forrester's actual criteria list and scores (only vendor summaries available).
- Gartner Hype Cycle 2026 "AI Agent Bot Management" definition (vendor claim only).
- go-away and Quixotic current feature sets (sites unreachable).
- Legal: current status of *Reddit v. SerpApi* (docket), *Kneschke v. LAION* appeal, *GEMA v. OpenAI* appeal, *Like Company v. Google*, *Ryanair v. Booking.com* post-trial; the EDPB 2/2023 text on JS-based fingerprinting; FTC dark-pattern categories; DSA Art. 25 scope for non-platform sites.
- Whether `NovaAct`/`Operator` UA tokens (in Anubis' deny regex) are real product tokens.
- How Fingerprint detects "Claude Code (CLI/Desktop/Agent SDK)" (likely UA tokens; unverified).
- Edge Copilot mode, Gemini in Chrome and Dia: any self-identification or detectable artefacts (no public sources found).
- Whether the July 2025 "ChatGPT agent clicks Cloudflare checkbox" incident reflects current Turnstile behaviour (Ars Technica blocked; arXiv shows ChatGPT Agent later blocked by Turnstile on header grounds).

## 14. Sources

Primary (fetched):
1. https://blog.cloudflare.com/signed-agents/
2. https://developers.cloudflare.com/bots/concepts/bot/verified-bots/categories/
3. https://developers.cloudflare.com/bots/concepts/bot/verified-bots/
4. https://developers.cloudflare.com/bots/concepts/bot/signed-agents/
5. https://developers.cloudflare.com/bots/concepts/bot/signed-agents/policy/
6. https://developers.cloudflare.com/bots/concepts/bot-score/
7. https://developers.cloudflare.com/bots/reference/bot-management-variables/
8. https://developers.cloudflare.com/bots/additional-configurations/block-ai-bots/
9. https://developers.cloudflare.com/bots/additional-configurations/ja3-ja4-fingerprint/
10. https://developers.cloudflare.com/bots/concepts/bot/verified-bots/web-bot-auth/
11. https://developers.cloudflare.com/bots/additional-configurations/ai-labyrinth/
12. https://blog.cloudflare.com/ai-labyrinth/
13. https://developers.cloudflare.com/ai-crawl-control/
14. https://developers.cloudflare.com/ai-crawl-control/features/pay-per-crawl/what-is-pay-per-crawl/
15. https://blog.cloudflare.com/introducing-pay-per-crawl/
16. https://blog.cloudflare.com/content-signals-policy/
17. https://developers.cloudflare.com/fundamentals/reference/markdown-for-agents/
18. https://blog.cloudflare.com/monetization-gateway
19. https://blog.cloudflare.com/perplexity-is-using-stealth-undeclared-crawlers-to-evade-website-no-crawl-directives/
20. https://www.ietf.org/archive/id/draft-meunier-webbotauth-registry-01.html
21. https://datatracker.ietf.org/wg/webbotauth/about/
22. https://datatracker.ietf.org/wg/aipref/about/
23. https://www.akamai.com/blog/security-research/identifying-agentic-automation-behavioral-telemetry
24. https://www.akamai.com/products/content-protector
25. https://www.akamai.com/products/bot-manager
26. https://cyberriskleaders.com/akamai-launches-agentic-security-framework-for-bot-agent-control/
27. https://docs.datadome.co/docs/agentic-trust/llms.txt
28. https://docs.datadome.co/docs/ai-agent-identification.md
29. https://docs.datadome.co/docs/agent-trust-score.md
30. https://docs.datadome.co/docs/intent-based-protection.md
31. https://docs.datadome.co/docs/agentic-trust-dashboard-access-control.md
32. https://docs.datadome.co/docs/skyfire-kyapay.md
33. https://docs.datadome.co/reference/validate-request.md
34. https://finance.yahoo.com/news/human-introduces-first-adaptive-trust-130000294.html
35. https://finance.yahoo.com/sectors/technology/articles/human-recognized-leader-top-research-165900277.html
36. https://www.kasada.io/blog/kasada-launches-ai-agent-trust-to-secure-agentic-commerce
37. https://securityboulevard.com/2026/06/kasada-named-a-leader-in-the-forrester-wave-bot-and-agent-trust-management-q2-2026/
38. https://www.kernel.sh/blog/detection
39. https://www.kernel.sh/ai-library/bypass-bot-detection-ai-agents-2026
40. https://vercel.com/docs/bot-management
41. https://vercel.com/docs/botid
42. https://vercel.com/docs/botid/verified-bots
43. https://vercel.com/changelog/vercels-bot-verification-now-supports-web-bot-auth
44. https://vercel.com/changelog/botid-deep-analysis-model-improved-for-fake-hardware-detection
45. https://docs.fingerprint.com/docs/bot-detection/overview
46. https://docs.fingerprint.com/docs/smart-signals-overview
47. https://docs.fingerprint.com/docs/smart-signals-reference
48. https://fingerprint.com/bot-directory/
49. https://fingerprint.com/bot-directory/chatgpt-agent/
50. https://siliconangle.com/2026/06/01/fingerprint-launches-ai-assistant-detection-spot-traffic-chatgpt-gemini-claude/
51. https://www.browserbase.com/blog/fingerprint-authorized-agent-detection
52. https://www.browserbase.com/identity
53. https://docs.browserbase.com/features/stealth-mode
54. https://arcjet.com/learn/identify-ai-agents-and-bots
55. https://docs.arcjet.com/bot-protection/identifying-bots/
56. https://castle.io/
57. https://docs.castle.io/docs/ai-agent-identification
58. https://blog.castle.io/from-llm-scrapers-to-ai-agents-mapping-the-ai-bot-landscape-for-detection-teams/
59. https://www.imperva.com/blog/why-ai-bot-protection-and-control-are-essential-for-application-security/
60. https://www.f5.com/products/distributed-cloud-services/bot-defense
61. https://telecomreseller.com/2026/02/03/radware-unveils-agentic-ai-protection-solution-to-shield-enterprises-from-new-agentic-threats/
62. https://securitybrief.co.uk/story/netacea-launches-trust-layer-for-ai-agent-web-traffic
63. https://www.arkoselabs.com/
64. https://www.hcaptcha.com/
65. https://prosopo.io/blog/forrester-wave-bot-management-2026/
66. https://stytch.com/blog/introducing-is-agent/
67. https://www.isagent.dev/faq
68. https://stytch.com/blog/stytch-supports-web-bot-auth/
69. https://cside.com/blog/best-tools-for-ai-agent-detection-to-prevent-website-fraud
70. https://cside.com/
71. https://docs.aws.amazon.com/waf/latest/developerguide/aws-managed-rule-groups-bot.html
72. https://workos.com/blog/web-bot-auth-identify-ai-agents
73. https://tollbit.com/
74. https://mediacopilot.ai/ai-content-licensing-market-publishers-double-bind/
75. https://iabtechlab.com/standards/comp-content-monetization-protocols-initiative/
76. https://skyfire.xyz/industry-articles/how-ai-agents-prove-identity-kya-authentication-authorization-payments/
77. https://docs.skyfire.xyz/
78. https://docs.skyfire.xyz/docs/kya-token
79. https://developer.visa.com/capabilities/trusted-agent-protocol
80. https://raw.githubusercontent.com/visa/trusted-agent-protocol/main/README.md
81. https://raw.githubusercontent.com/visa/trusted-agent-protocol/main/cdn-proxy/README.md
82. https://fintechspecs.com/blog/mastercard-agent-pay-trust-intelligence-skyfire-kya-2026/
83. https://ap2-protocol.org/
84. https://docs.stripe.com/agentic-commerce
85. https://docs.stripe.com/agentic-commerce/protocols/ucp
86. https://ucp.dev/
87. https://lwn.net/Articles/1028558/
88. https://en.wikipedia.org/wiki/Anubis_(software)
89. https://raw.githubusercontent.com/TecharoHQ/anubis/main/data/botPolicies.yaml
90. https://raw.githubusercontent.com/TecharoHQ/anubis/main/data/bots/ai-catchall.yaml
91. https://raw.githubusercontent.com/TecharoHQ/anubis/main/README.md
92. https://lwn.net/Articles/1056953/
93. https://zadzmo.org/code/nepenthes/
94. https://diff.wikimedia.org/2025/04/01/how-crawlers-impact-the-operations-of-the-wikimedia-projects/
95. https://diff.wikimedia.org/2025/10/17/new-user-trends-on-wikipedia/
96. https://stackoverflow.blog/2026/02/26/how-pay-per-crawl-is-reshaping-data-monetization/
97. https://en.wikipedia.org/wiki/Perplexity_AI
98. https://en.wikipedia.org/wiki/Reddit
99. https://developers.openai.com/api/docs/bots
100. https://support.claude.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web-and-how-can-site-owners-block-the-crawler
101. https://docs.perplexity.ai/guides/bots
102. https://developers.google.com/crawling/docs/crawlers-fetchers/user-triggered-fetchers
103. https://developers.google.com/crawling/docs/crawlers-fetchers/google-agent
104. https://claude.com/blog/claude-for-chrome
105. https://en.wikipedia.org/wiki/ChatGPT_Atlas
106. https://arxiv.org/abs/2606.30119 and https://arxiv.org/html/2606.30119
107. https://arxiv.org/abs/2605.01247 and https://arxiv.org/html/2605.01247
108. https://ianlpaterson.com/blog/anti-detect-browser-benchmark-patchright-nodriver-curl-cffi/
109. https://scrapfly.io/blog/posts/best-stealth-browsers
110. https://arxiv.org/abs/2410.13919
111. https://arxiv.org/abs/2603.23559
112. https://www.w3.org/WAI/WCAG22/Understanding/accessible-authentication-minimum.html
113. https://www.w3.org/TR/turingtest/
114. https://www.ada.gov/resources/2024-03-08-web-rule/
115. https://en.wikipedia.org/wiki/European_Accessibility_Act
116. https://www.edpb.europa.eu/our-work-tools/our-documents/guidelines/guidelines-22023-technical-scope-art-53-eprivacy-directive_en
117. https://en.wikipedia.org/wiki/HiQ_Labs_v._LinkedIn
118. https://en.wikipedia.org/wiki/Van_Buren_v._United_States
119. https://en.wikipedia.org/wiki/Bright_Data
120. https://en.wikipedia.org/wiki/Web_scraping
121. https://en.wikipedia.org/wiki/Directive_on_Copyright_in_the_Digital_Single_Market
122. https://www.ftc.gov/reports/bringing-dark-patterns-light
123. https://www.infoq.com/news/2026/03/cloudflare-crawler/
124. https://ppc.land/cloudflare-stops-charging-ai-per-crawl-and-starts-paying-per-answer/
125. https://ppc.land/full-bot-protection-drops-to-2-4-of-popular-websites-datadome-finds/

Secondary (search snippets or third-party; not opened or only partially):
126. https://zian.ai/web-bot-auth-signed-ai-agents/
127. https://andrew.ooo/answers/what-is-cloudflare-web-bot-auth-signed-agents-2026/
128. https://agent-ready.dev/what-is-web-bot-auth
129. https://stellagent.ai/insights/cloudflare-web-bot-auth-agent-verification
130. https://datadome.co/agent-trust-management/datadome-recognized-in-gartner-hype-cycle-for-application-security-2026/
131. https://datadome.co/changelog/datadome-product-roundup-q2-2026/
132. https://www.businesswire.com/news/home/20260520465052/en/DataDome-Announces-Priority-Protect-the-First-Virtual-Waiting-Room-Built-for-Agentic-Commerce
133. https://www.businesswire.com/news/home/20260615464158/en/DataDome-Named-a-Leader-in-Top-Analyst-Report-for-Bot-and-Agent-Trust-Management-a-New-Category-Defined-by-the-Rise-of-AI-Agents
134. https://www.humansecurity.com/newsroom/forrester-wave-bot-agent-trust-management-software-q2-2026/
135. https://www.humansecurity.com/learn/blog/ai-traffic-growth-2025-key-findings/
136. https://www.humansecurity.com/learn/blog/agentictrust-govern-ai-agents/
137. https://www.globenewswire.com/news-release/2026/06/15/3311619/0/en/akamai-unveils-agentic-security-framework-to-power-trusted-ai-driven-interactions-and-commerce.html
138. https://www.businesswire.com/news/home/20260601158287/en/Fingerprint-Launches-Automation-Intelligence-API-and-AI-Assistant-Detection-Delivering-the-Industrys-Most-Complete-View-of-AI-Traffic
139. https://www.morningstar.com/news/business-wire/20260918175871/fingerprint-launches-bot-directory-built-for-the-ai-era
140. https://securitystack.app/products/kasada-bot-defense
141. https://cbinsights.com/company/kasada
142. https://www.kasada.io/blog/the-ai-browser-revolution-rethinking-web-architecture (content credited to monogram.io)
143. https://github.com/Cleveland-Coder/tej-splsh/issues/55
144. https://github.com/zenbu-labs/terminal-browser/issues/129
145. https://dev.to/ianlpaterson/anti-detect-browser-benchmark-2026-7-stealth-tools-31-cloudflare-targets-651-verdicts-4361
146. https://humanbrowser.cloud/blog/playwright-stealth-not-working-2026
147. https://www.niemanlab.org/2026/05/the-emerging-ai-content-licensing-market-puts-news-publishers-in-a-double-bind-a-new-report-warns/
148. https://digitalcontentnext.org/blog/2026/06/09/mapping-publisher-value-in-the-ai-marketplace/
149. https://presenc.ai/research/tollbit-publisher-licensing-2026
150. https://ppc.land/iab-tech-labs-comp-spec-forces-llms-to-pay-before-they-crawl/
151. https://www.ledgerinsights.com/cloudflare-to-launch-net-stablecoin-for-ai-agentic-payments/
152. https://www.infoq.com/news/2026/07/cloudflare-aws-x402-micropayment/
153. https://wavect.io/blog/cloudflare-wallets-ai-agents/
154. https://eco.com/support/en/articles/14846277-know-your-agent-kya-identity-for-agent-payments
155. https://www.cequence.ai/learn/bot-management/choosing-bot-management-vendors-top-8-compared/
156. https://wal.sh/research/bot-agent-trust-management-2026/
157. https://roundproxies.com/blog/castle-bypass/
158. https://shattered.io/cloudflare-ai-crawler-default-20-bots-2026/
159. https://aicrawlercheck.com/blog/ai-crawler-robots-txt-study-2026
160. https://www.arkoselabs.com/videos/why-captchas-are-broken-kevin-gosschalk-rsac-2026
161. https://webdecoy.com/blog/anubis-ai-scraper-firewall-technical-deep-dive/
162. https://primores.org/blog/ai-crawler-tarpits/
163. https://www.rachelkaufman.com/things-i-learned/2026/06/23/iocaine-is-good-actually.html
