# Tier-1 provider wire identity: OpenAI, Anthropic, Google (as of 2026-10-24)

Research report for necter (identification layer). Scope: how first-party agents, fetchers and crawlers from OpenAI, Anthropic and Google identify themselves on the wire (User-Agent, IP feeds, reverse DNS, robots.txt tokens, Web Bot Auth signatures), whether they execute JavaScript, whether they honor robots.txt, and whether the product runs in a hosted cloud browser or in the user's local browser.

Method: every claim below was checked against a live source on 2026-10-24. "Fetched" means the primary page or JSON was read. "Probed" means I ran `curl`, `dig -x`, `whois` or unpacked a public Chrome extension package locally. "Third-party" means a vendor/blog observation that I could not confirm against a first-party source. Confidence tags: **[confirmed]** first-party doc or direct probe; **[likely]** consistent secondary sources or strong inference; **[uncertain]** single third-party source or unverifiable.

Raw snapshots of every IP feed and both signature key directories (taken 2026-10-24T22:41Z, SHA-256 in `SHA256SUMS.txt`) are in `docs/research/raw/providers-tier1-feeds/`.

Note on research limits: the shared WebSearch budget for this session ran out midway; after that point I continued with direct fetches and local probes only. Three OpenAI help-center pages returned HTTP 403 to the fetch tool (`help.openai.com/en/articles/11845367`, `/20001371`, `/20001530`) and so did `openai.com/index/introducing-dots/`; where I cite them it is via search-result excerpts or secondary coverage, and I say so.

---

## 0. One-page summary table

| Product / agent | Wire token or identity | IP feed | rDNS | robots.txt | JS exec | Web Bot Auth | Runs where |
|---|---|---|---|---|---|---|---|
| OpenAI GPTBot | `GPTBot/1.4` | `openai.com/gptbot.json` (18) | none published | honors | no (measured 2024) | no | OpenAI/Azure |
| OpenAI ChatGPT-User | `ChatGPT-User/1.0` | `openai.com/chatgpt-user.json` (234) | none | "may not apply" | no | no | OpenAI/Azure |
| OpenAI OAI-SearchBot | `OAI-SearchBot/1.4` | `openai.com/searchbot.json` (39) | none | honors | no | no | OpenAI/Azure |
| OpenAI OAI-AdsBot | `OAI-AdsBot/1.0` | `openai.com/adsbot.json` (2) | none | not stated | unknown | no | OpenAI/Azure |
| OpenAI ChatGPT agent = Cloud browser (ChatGPT Work) | plain Chrome UA + `Signature-Agent: "https://chatgpt.com"` | none specific (see `chatgpt-agents.json` caveat) | none | no statement | yes (real Chromium) | **yes**, Ed25519, keys at `chatgpt.com/.well-known/http-message-signatures-directory` | OpenAI cloud |
| OpenAI dots (Sept 2026) | not documented; each dot has its own cloud computer+browser | undocumented | none | undocumented | yes | undocumented (likely same chatgpt.com signer) | OpenAI cloud |
| OpenAI Codex cloud | no UA documented; proxy egress | `openai.com/chatgpt-agents.json` (1758) | none | n/a | no browser in cloud env | no | OpenAI/Azure |
| OpenAI ChatGPT Atlas | retired 2026-08-09; was plain Chrome UA, no signing | n/a | n/a | n/a | yes | no | was local macOS |
| OpenAI ChatGPT Chrome extension (Atlas successor) | user's Chrome UA; optional `x-browser-agent: ChatGPT/<sessionId>` request header; DOM `codex-agent-overlay-root` | user's IP | user's | n/a | yes | no | user's local Chrome |
| OpenAI Agents API hosted `computer_use` | undocumented | undocumented | none | undocumented | yes | undocumented | OpenAI-hosted env |
| Anthropic ClaudeBot | `ClaudeBot` | `claude.com/crawling/bots.json` (14) | none (AWS/GCP ranges) | honors, Crawl-delay | no (measured 2024) | no | AWS + GCP |
| Anthropic Claude-User | `Claude-User/1.0` | same + `160.79.104.0/21` | none | honors | no | no | Anthropic |
| Anthropic Claude-SearchBot | `Claude-SearchBot` | same | none | honors | no | no | Anthropic |
| Claude API web_fetch / web_search | `Claude-User/1.0` observed | `160.79.104.0/21` documented outbound | none | enforced (`url_not_allowed`) | no (documented) | no | Anthropic |
| Claude Code WebFetch (local) | `axios/1.8.4` observed (third-party) | user's IP | user's | n/a | no | no | user's machine |
| Claude in Chrome extension | user's Chrome UA; DOM `claude-agent-*` markers; WS `bridge.claudeusercontent.com` | user's IP | user's | n/a | yes | no | user's local Chrome |
| Claude computer use / browser use tools | executor's identity (client toolsets) | customer's | customer's | n/a | yes | no | customer env |
| Googlebot / GoogleOther / CloudVertexBot | `Googlebot/2.1`, `GoogleOther`, `Google-CloudVertexBot` | `common-crawlers.json` (170 v4 / 147 v6) | `crawl-*.googlebot.com`, `geo-crawl-*.geo.googlebot.com` | honors | yes (Googlebot WRS) | no | Google |
| Google-Extended | control token only, no UA | n/a | n/a | token | n/a | n/a | n/a |
| Google special-case (AdsBot, Mediapartners, APIs-Google, Google-Safety) | own tokens | `special-crawlers.json` (136/136) | `rate-limited-proxy-*.google.com` | partial / ignores `*` | varies | no | Google |
| Google user-triggered fetchers (FeedFetcher, GoogleProducer, Site-Verification, Read-Aloud, GeminiNotebook...) | own tokens | `user-triggered-fetchers.json` (534/534), `user-triggered-fetchers-google.json` (252/252) | `*.gae.googleusercontent.com`, `google-proxy-*.google.com` | "generally ignore" | varies | no | Google |
| **Google-Agent** (Mariner / hosted agents) | `compatible; Google-Agent;` + Chrome UA | `user-triggered-agents.json` (12 v4 / 8 v6) | `google-proxy-*.google.com` (probed) | ignores | yes | **experimental**, `Signature-Agent: g="https://agent.bot.goog"` | Google cloud |
| Gemini in Chrome / auto browse | user's Chrome UA | user's IP | user's | n/a | yes | no | user's local Chrome |
| Gemini-Deep-Research | third-party only; not in Google docs | none | none | unknown | unknown | no | Google (unverified) |
| AP2 (agent payments) | no HTTP-level identity; SD-JWT mandates at protocol layer | n/a | n/a | n/a | n/a | not referenced | n/a |

---

## 1. Cross-cutting: Web Bot Auth state of play (October 2026)

### 1.1 The standard
- IETF working group document: **draft-ietf-webbotauth-httpsig-protocol-00**, "HTTP Message Signatures for automated traffic" (Meunier, Major), dated 2026-09-01, expires 2027-03-05, Standards Track, WG = webbotauth. **[confirmed]** (datatracker fetched)
- Headers: `Signature-Agent`, `Signature-Input`, `Signature` (RFC 9421). The directory is served at `/.well-known/http-message-signatures-directory` with content type `application/http-message-signatures-directory+json` (a JWKS). Required signature parameters: `created`, `expires`, `keyid`, `tag="web-bot-auth"`; required components: `@authority` (or `@target-uri`) plus `"signature-agent";key="<label>"`. `nonce` is **not** required ("This document defines no additional nonce requirements"). Expiry RECOMMENDED <= 24 h. `keyid` MUST be the base64url JWK SHA-256 thumbprint (RFC 7638 / RFC 8037 for Ed25519); `kid` MAY be present and, if present at the well-known URI, MUST equal the thumbprint. **[confirmed]**
- Changelog items relevant to parsers: renamed from `draft-meunier-web-bot-auth-architecture`; `draft-meunier-webbotauth-httpsig-directory` was folded into the protocol draft; "Require Signature-Agent on every signed request"; **Signature-Agent is now a Dictionary Structured Field** (members are https URI strings, with an optional type parameter). **[confirmed]**

### 1.2 Two incompatible header syntaxes are live
- OpenAI sends the older structured **string** form: `Signature-Agent: "https://chatgpt.com"` with label `sig1`. **[confirmed]** (Simon Willison's capture, OpenAI help article via excerpts, and OpenAI's directory JSON which carries `"signature_agent":"https://chatgpt.com"`)
- Google sends the new **Dictionary** form: `Signature-Agent: g="https://agent.bot.goog"` with the `g` label also used on `Signature-Input` and `Signature`. **[confirmed]** (Google doc "Authenticating requests with Web Bot Auth (Experimental)", last updated 2026-10-13: "Participating requests sent to your server will have the Signature-Agent HTTP request header set to g="https://agent.bot.goog" (take note of the g= label)")
- Cloudflare's verifier documentation (fetched) states the value "must be a double-quoted HTTPS URL in structured-field form, not a dictionary" and lists "dictionary-form headers" among failure conditions; it also supports Ed25519 only and currently performs no nonce validation. Implication for our detector: **parse both forms** (RFC 8941 Item string and Dictionary) and never reject a signature just because a label other than `sig1` is used. **[confirmed]**

### 1.3 Live key directories (probed 2026-10-24 22:31 UTC)

OpenAI, `https://chatgpt.com/.well-known/http-message-signatures-directory` (HTTP/2 200, `server: cloudflare`):

```
content-type: application/http-message-signatures-directory+json
cache-control: no-store, no-transform
content-digest: sha-256=:8fvpaNJgIAT3QHQMWx9oxcsHAu0WykAHWTrT4F766R0=:
signature-input: sig1=("@authority";req "content-digest");created=1792881118;expires=1792967518;keyid="ArwjqcCqtA5oxEWkzXGC-To_0A9whHmajCHtfe8I9aY";tag="http-message-signatures-directory";alg="ed25519"
signature: sig1=:m4w6lb8iHLVV9fgEhyLTJObInC7+z+S4e8Y+LVwUC/VybJVFcPi91JHOIQlApFC7qWKswPUGDYLBcbKKQCGMBw==:

{"keys":[{"crv":"Ed25519","kty":"OKP","x":"P_1c4SX6fCavDcq6FRegWcVvaOKsp_aXHPEN1FcKDIA","kid":"ArwjqcCqtA5oxEWkzXGC-To_0A9whHmajCHtfe8I9aY","use":"sig","nbf":1735689600,"exp":1793485918}],"signature_agent":"https://chatgpt.com","purpose":"ai"}
```
Observations: exactly **one** Ed25519 key; `kid` is a 43-char thumbprint as the draft requires; `nbf` = 2025-01-01T00:00:00Z; the `exp` field is **generated dynamically as now + 604800 s** (three reads minutes apart returned 1793485614, 1793485918, 1793486068; delta to now was 7.000 days each time). Do not treat `exp` as a rotation date; cache the key by `kid` and re-fetch on unknown `kid`. The directory response itself is signed (`tag="http-message-signatures-directory"`, 24 h validity). **[confirmed]**

Google, `https://agent.bot.goog/.well-known/http-message-signatures-directory` (HTTP/2 200, `server: ESF`):

```
signature-input: g=("@authority";req);created=1792881118;expires=1792881418;keyid="DYiMjA";alg="ed25519";tag="http-message-signatures-directory"
signature: g=:ILjPDZMX7C/6HD4gOR4tiOWfrSIXZoRqpIrAmaMNu7mi4BAFsd1OhWhVIDKxxrwtTxchcMtlzDHPaKFmB5bqBA==:
cache-control: public, max-age=3600
content-type: application/http-message-signatures-directory+json

{"keys":[{"alg":"EdDSA", "crv":"Ed25519", "key_ops":["verify"], "kid":"mhxuPw", "kty":"OKP", "use":"sig", "x":"X53rIypL6muU_xeVU6Vm0uoGQcKKxm5FCRIFZHR0CZA"}, {"alg":"EdDSA", "crv":"Ed25519", "key_ops":["verify"], "kid":"cYSMkA", "kty":"OKP", "use":"sig", "x":"BCEFRL2wi2rfWoqfuneHGVmh_axPFaXrXNQrfxUpZqM"}, {"alg":"EdDSA", "crv":"Ed25519", "key_ops":["verify"], "kid":"bUCe2A", "kty":"OKP", "use":"sig", "x":"W1nRrCPqci1T40ppv1ULK6q67a14hjLScZ955FPxQQM"}, {"alg":"EdDSA", "crv":"Ed25519", "key_ops":["verify"], "kid":"DYiMjA", "kty":"OKP", "use":"sig", "x":"0cFRtAeGOa46EsjXFVKw1o_pMPFBGq4ReeznYs_RBrs"}, {"alg":"EdDSA", "crv":"Ed25519", "key_ops":["verify"], "kid":"Ggh50g", "kty":"OKP", "use":"sig", "x":"7ZziBznI1XsHehATtJjS5XD6QrS_LJlLD8jHml5RJVI"}]}
```
Observations: **five** keys; `kid` values are 6-character labels (`mhxuPw`, `cYSMkA`, `bUCe2A`, `DYiMjA`, `Ggh50g`), **not** JWK thumbprints, so a verifier that insists on `keyid == thumbprint` (as the draft text says) will reject Google; match `keyid` to `kid` first and fall back to thumbprint. Directory signature validity is 300 s; `cache-control: max-age=3600`, which Google's doc says to honor ("cache it per the Cache-Control header. Delete cached keys that are no longer in the directory"). No `signature_agent`/`purpose` fields. **[confirmed]**

Other probed locations, all absent: `operator.openai.com` (NXDOMAIN now), `openai.com` (404), `claude.com`, `claude.ai`, `api.anthropic.com` (404), `anthropic.com` (301 to site), `www.google.com`, `gemini.google.com` (404), `bot.goog` (400). **Anthropic publishes no Web Bot Auth directory anywhere I could find.** **[confirmed for the probed hosts]**

### 1.4 Who signs today (first-party)
- OpenAI: Operator since at least May 2025 ("OpenAI signs all Operator requests so site owners can verify they genuinely originate from Operator", Cloudflare blog 2025-05-15, which also listed `operator.openai.com` as an example Signature-Agent); ChatGPT agent since July 2025 (observed Aug 2025); now branded "ChatGPT Work's Cloud browser" (OpenAI help article 11845367). Signer identity today is `https://chatgpt.com`. **[confirmed]**
- Google: Google-Agent only, "a subset of requests", experimental, identity `https://agent.bot.goog`; "Not all Google user agents are using Web Bot Auth"; "Google is not yet signing every request of agents using the protocol"; Google recommends continuing to rely on IP, rDNS and UA. **[confirmed]**
- Anthropic: none found. **[confirmed by probe; absence of evidence]**
- Cloudflare context: "signed agents" program (blog 2025-08-28) listed ChatGPT agent (OpenAI), Goose (Block), Browserbase, Anchor Browser, Cloudflare Browser Rendering; verified-bot behaviour taxonomy now includes `Agent` ("User-directed agents visiting a page on behalf of a human") and `Transact`; since 2026-07-01 a BotBase metadata field distinguishes "Direct versus Intermediary access". **[confirmed]**

---

## 2. OpenAI

Primary page: https://developers.openai.com/api/docs/bots ("Overview of OpenAI Crawlers"; `platform.openai.com/docs/bots` 301s there). It documents exactly four tokens and says nothing about ChatGPT agent, Cloud browser, Atlas, Codex, dots, Web Bot Auth, or JavaScript rendering. **[confirmed]**

### 2.1 GPTBot (training crawler)
- UA (example; "version may change"): `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.4; +https://openai.com/gptbot`
- robots.txt fetches may carry an extra `robots.txt` marker in the UA (OpenAI says it "may add a robots.txt marker").
- robots.txt token: `GPTBot`. Disallowing "signals that content should not be used" for training foundation models. If both GPTBot and OAI-SearchBot are allowed, "OpenAI may use one crawl's results for both purposes".
- IP feed: `https://openai.com/gptbot.json`: `creationTime` `2026-09-22T02:00:07.000000`, 18 IPv4 prefixes, `Last-Modified: Tue, 22 Sep 2026 17:16:01 GMT`, served `application/json`. Full list: 132.196.86.0/24, 172.182.202.0/25, 172.182.207.0/25, 20.125.66.80/28, 20.171.206.0/24, 20.171.207.0/24, 4.227.36.0/25, 52.230.152.0/24, 74.7.175.128/25, 74.7.227.0/25, 74.7.227.128/25, 74.7.228.0/25, 74.7.230.0/25, 74.7.241.0/25, 74.7.241.128/25, 74.7.242.0/25, 74.7.243.128/25, 74.7.244.0/25.
- Hosting: 20.x = Microsoft (ARIN `MSFT`); 74.7.x and 9.x are RIPE-registered blocks (`netname: cloud`), consistent with Azure but not labelled Microsoft in whois **[likely]**. No reverse DNS exists for sampled addresses (`dig -x` empty for 74.7.227.5, 20.171.206.5, 52.230.152.5). **[confirmed by probe]**
- JavaScript: not rendered (Vercel/MERJ measurement, Dec 2024: "none of the major AI crawlers currently render JavaScript", explicitly including GPTBot, ChatGPT-User, OAI-SearchBot, ClaudeBot; ChatGPT fetched JS files 11.5% of the time "without executing them"). **[confirmed measurement, 2024-era]**

### 2.2 ChatGPT-User (user-triggered fetcher for ChatGPT and Custom GPTs)
- UA: `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot`
- Purpose per OpenAI: "user-initiated actions in ChatGPT and Custom GPTs, including page visits and GPT Actions. It is not used for automatic crawling and does not determine Search eligibility." robots: "Because ChatGPT-User actions are user-initiated, robots.txt rules may not apply to them."
- IP feed: `https://openai.com/chatgpt-user.json`: `creationTime` `2026-10-20T17:07:39.673498`, **234** prefixes (233 x /28 plus one `/16`: `9.129.0.0/16`), served from Azure blob storage (`content-type: application/octet-stream`, ETag `0x8DF2ECCA5DEBDA6`, `Last-Modified: Tue, 20 Oct 2026 17:07:40 GMT`). Snapshot in feeds folder.
- Overlap: 141 of the 283 prefixes in `chatgpt-connectors.json` (see 2.6) also appear in `chatgpt-user.json`; only 1 overlaps with `chatgpt-agents.json`. **[confirmed by local diff]**
- The Vercel 2024 study groups ChatGPT-User with the non-JS fetchers. Treat as text fetcher. Third-party sources (DataDome, 2026) agree. **[likely]**

### 2.3 OAI-SearchBot (search index)
- UA: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36; compatible; OAI-SearchBot/1.4; +https://openai.com/searchbot`
- robots.txt fetch variant: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36; compatible; OAI-SearchBot/1.4; robots.txt; +https://openai.com/searchbot`
- Note the non-standard structure: browser UA, then `; compatible; OAI-SearchBot/1.4; +url` **outside** parentheses. Parsers that only look inside `(...)` miss it.
- robots token `OAI-SearchBot`; changes take ~24 h; opted-out sites "won't appear in ChatGPT search answers, but can still appear as navigational links".
- IP feed: `https://openai.com/searchbot.json`: `creationTime` `2026-01-02T11:00:00.000000`, 39 IPv4 prefixes, `Last-Modified: Thu, 10 Sep 2026 19:47:04 GMT`. Full list in snapshot (mix of /24, /25, /28 in 104.210, 13.66, 135.234, 172.182, 172.203, 20.x, 23.102, 4.227, 40.67, 40.90, 51.8, 74.7).

### 2.4 OAI-AdsBot (new, 2026)
- UA: `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-AdsBot/1.0; +https://openai.com/adsbot`
- Purpose: "Checks landing pages submitted as ads on ChatGPT. It only visits submitted ad pages", data not used to train.
- IP feed: `https://openai.com/adsbot.json`: `creationTime` `2026-05-12T03:00:00.000000`, 2 prefixes: `130.131.229.128/25`, `20.168.90.128/25` (`Last-Modified: Sat, 24 Oct 2026 15:01:11 GMT`).

### 2.5 ChatGPT agent -> "Cloud browser" of ChatGPT Work (formerly Operator)
Naming lineage: Operator (Jan 2025, `operator.openai.com`) -> ChatGPT agent (Jul 2025) -> OpenAI help article "ChatGPT Work's Cloud browser allowlisting" (article 11845367; ChatGPT Work launched 2026-07-09 per ppc.land/TechCrunch coverage). Botcrawl's directory lists aliases "ChatGPT Agent; chatgpt-agent; ChatGPT Operator; chatgpt-operator". **[confirmed lineage; help article text only via excerpts]**

Observed wire identity (Simon Willison, 2025-08-04, Cloudflare-fronted site):
```
User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36
Sec-Ch-Ua: "Not)A;Brand";v="8", "Chromium";v="138"
Sec-Ch-Ua-Platform: "Linux"
Sec-Ch-Ua-Mobile: ?0
Signature-Agent: "https://chatgpt.com"
Signature-Input: sig1=("@authority" "@method" "@path" "signature-agent");...   (tag="web-bot-auth", alg ed25519)
Signature: sig1=:1AxfqHocTf693inKKMQ7...:
Cf-Connecting-Ip: 2a09:bac5:665f:1541::21e:154   (Cf-Ipcountry: US)
```
Detector-relevant inconsistencies: a **macOS** User-Agent with a **Linux** `Sec-CH-UA-Platform` client hint, and a `Chromium`-only brand list (no "Google Chrome" brand). **[confirmed observation, Aug 2025; current Chrome major will have moved]**

- OpenAI's help article (per search excerpts and Botcrawl/Nostra/WorkOS summaries): requests are signed with RFC 9421 / Web Bot Auth, `Signature-Agent` is exactly `"https://chatgpt.com"`, keys at `https://chatgpt.com/.well-known/http-message-signatures-directory`; **no fixed User-Agent and no robots.txt token are published**; vendor allowlisting: Cloudflare bot tag + detection ID `129220581`, HUMAN entry "ChatGPT Agent", Vercel recognises it automatically; Akamai/Cloudflare/Vercel verify signatures themselves. **[likely; help page itself returned 403]**
- IP ranges: none published specifically for the cloud browser. The Codex docs call `openai.com/chatgpt-agents.json` "the agent egress IP feed" and the OpenAI IP guide maps it to "Codex cloud: connections to services such as GitHub"; whether ChatGPT Work's cloud browser egresses from the same 1,758 prefixes is **not stated** **[uncertain]**. The Aug 2025 observation was an IPv6 source (`2a09:bac5::/32` space), while every OpenAI feed is IPv4-only; so at least in 2025 the agent used addresses outside all published feeds.
- Hosted in OpenAI's cloud (Azure-class infrastructure per the observation). Executes JavaScript (real Chromium). **[confirmed]**
- robots.txt: no statement from OpenAI; Botcrawl records "No stable robots.txt token". Expect it to ignore robots.txt like other user-directed agents. **[likely]**

### 2.6 OpenAI egress IP feeds beyond the crawler feeds
From https://developers.openai.com/api/docs/guides/ip-addresses ("IP egress ranges"; fetched): "Each JSON file includes a `creationTime` and a `prefixes` array"; "The ranges can change as OpenAI infrastructure changes. Fetch the relevant file regularly"; "An IP allowlist identifies traffic from an OpenAI-operated network, not a specific user or workspace."

| Feed | Covers (OpenAI's words) | Snapshot 2026-10-24 |
|---|---|---|
| `https://openai.com/chatgpt-connectors.json` | "ChatGPT integrations: plugins, connectors, GPT Actions, and agentic commerce" | 283 IPv4 prefixes (/32 to /27), `creationTime` `2026-10-20T17:21:11.118481` |
| `https://openai.com/chatgpt-agents.json` | "Codex cloud: connections to services such as GitHub"; Codex docs: "agent egress IP feed" | **1,758** IPv4 `/28` prefixes, `creationTime` `2026-10-20T17:27:35.755117`; all sampled blocks are ARIN `MSFT`; no rDNS |

Probed and absent (404): `chatgpt-agent.json`, `agents.json`, `operator.json`, `agent.json`, `codex.json`, `dots.json`, `chatgpt-work.json`, `cloud-browser.json`. **[confirmed]**

Implementation note: the "agentic commerce" traffic (ChatGPT Instant Checkout / Agentic Commerce Protocol calls to merchants) is explicitly covered by `chatgpt-connectors.json`, which overlaps 141 prefixes with `chatgpt-user.json`. For attribution, intersect: an IP in both feeds is "ChatGPT product backend"; in `chatgpt-agents.json` only is "Codex cloud sandbox (or other cloud agent env)".

### 2.7 ChatGPT Atlas (retired) and its successors
- Atlas: Chromium browser for macOS, launched 2025-10-21. Normal and agent mode both presented a stock Chrome UA with no Atlas token: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36` (chrisrcook.com, 2025-10-22) and later Chrome/142 (HUMAN). A separate native fetcher for favicons/logos identified as `ChatGPT%20Atlas/<build> CFNetwork/<ver> Darwin/<ver>` (third-party server logs, Nov 2025; the author's version numbers were placeholders, so the exact build format is **[uncertain]**). No Web Bot Auth signing; no robots token. **[confirmed for UA; third-party for favicon UA]**
- Retirement: announced 2026-07-09 together with ChatGPT Work; service ended **2026-08-09**. Successors per OpenAI help article 20001371 ("Evolving Atlas into ChatGPT for browser-based agentic work", cited by Tobira/the-decoder/ppc.land; the page itself 403'd): (1) browser mode in the unified ChatGPT desktop app (Chat / Work / Codex modes, Mac + Windows), (2) the ChatGPT extension for Google Chrome, (3) ChatGPT Work for long multi-step cloud tasks. **[likely; multiple consistent secondary sources]**
- Wikipedia (fetched) confirms the 2026-08-09 shutdown and the March 2026 "desktop super app" plan.

### 2.8 ChatGPT Chrome extension (ID `hehggadaopoacecdllhhajmbjkdcmajg`) - manifest-level facts
Source: Chrome Web Store listing (fetched) and the public CRX package downloaded from Google's update service and unpacked locally (no code executed). **[confirmed]**
- Listing: name "ChatGPT", developer OpenAI, version `1.26.1020.11845`, updated 2026-10-22, "7,000,000 users", rating 2.1. Tagline "Control your browser with ChatGPT"; "enables ChatGPT desktop and web to use your browser to complete tasks"; can work "in the background, without ever taking over your active browsing session".
- `manifest_version: 3`; `permissions`: `alarms, bookmarks, debugger, declarativeNetRequestWithHostAccess, downloads, favicon, history, nativeMessaging, notifications, offscreen, scripting, sessions, storage, tabGroups, tabs, topSites, webNavigation, contextMenus, sidePanel`; `optional_permissions: ["downloads.open"]`; `host_permissions: ["<all_urls>"]`; `minimum_chrome_version: "116"`.
- Static `content_scripts` match **only** `https://chatgpt.com/*` (`chatgpt-website.js`, `codex-work-preload.js` in MAIN world, `side-chat-tab-mentions.js` for `*surface=browser_side_chat*`). Third-party pages are driven via `chrome.debugger` (CDP 1.3) and `chrome.scripting.executeScript`.
- `web_accessible_resources`: `images/cursor-chat.png` for `<all_urls>` -> a page can probe `chrome-extension://hehggadaopoacecdllhhajmbjkdcmajg/images/cursor-chat.png` to detect installation (same technique CHEQ documented for Claude).
- **Request header injection**: `background.js` builds `declarativeNetRequest` session rules (`updateSessionRules`, `MODIFY_HEADERS` / `SET`) scoped to the controlled tab IDs, covering `MAIN_FRAME, SUB_FRAME, OBJECT` and, in a second rule, all other resource types except requests initiated by the extension itself. Default header when enabled: `x-browser-agent: ChatGPT/${sessionId}`. The server-side turn payload can also supply a custom `request_headers` policy (names validated as RFC token, lowercase, <=256 chars, no `sec-`/`proxy-` prefixes, values ASCII <=8192 chars, total <=32 KiB, with session-id templating). The header is only applied when the turn carries `agent_request_header_enabled: true` (or custom headers); the decision is sticky (`chrome.storage.local["AGENT_REQUEST_HEADER_ENABLED"]`). **Whether OpenAI currently turns this on in production is not observable from the package** **[uncertain]**; if it is on, `x-browser-agent` is the single strongest signal for ChatGPT-driven local-browser sessions.
- **DOM markers injected into controlled tabs** (`content-scripts/codex.js`, injected on demand): root element id `codex-agent-overlay-root`; a favicon badge implemented as `<link rel="icon" data-codex-favicon-badge="true">` whose SVG data-URL contains `data-codex-favicon-badge="codex-favicon-badge"` (badge states `active` / `deliverable` / `handoff`; colours `#22c55e`, `#facc15`, black); dataset keys `codexFaviconBadgeCreated`, `codexOriginalFaviconHref`; a phantom cursor using `images/cursor-chat.png`. Legacy class name `AtlasCommandError` remains in the bundle.
- **CDP behaviour**: `chrome.debugger.attach({tabId}, "1.3")` per controlled tab; `Emulation.setDeviceMetricsOverride({..., deviceScaleFactor: 1, mobile: false})` (fixed viewport leases); `Fetch.enable` with URL patterns (request interception); input via `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent`; an internal deny-list forbids its own kernel from calling `Network.setExtraHTTPHeaders`, `Network.setUserAgentOverride` (not present at all), `Page.addScriptToEvaluateOnNewDocument`, `Page.setBypassCSP`, etc. So the **browser UA is not spoofed**; the page runs in the user's real Chrome with the user's cookies and IP, and Chrome shows the "is being debugged" infobar.
- Related: native messaging hosts `com.openai.codexextension` (`.dev`, `.internal`) and a separate "Codex" extension ID `lfkehkpjohcoelkpembgemeipeppanef` referenced in the bundle; its Web Store listing did not render and its CRX download returned HTTP 401 (unlisted/restricted) **[uncertain availability]**.

### 2.9 Codex (cloud sandboxes)
- Current docs live at `learn.chatgpt.com/docs/...` (developers.openai.com/codex/* 308-redirects there). Cloud environments: internet access off by default; when on, outbound HTTP/HTTPS goes through a proxy with a domain policy ("Package managers", "Custom domains only", "All (unrestricted)"); "For services reached over the public internet that filter connections by source IP, use the agent egress IP feed" -> `https://openai.com/chatgpt-agents.json`; capabilities not supported in cloud environments include **"Computer and browser use"** (so no headless browser from Codex cloud today). No User-Agent is documented for sandbox HTTP clients (expect whatever the tool uses: `curl`, `python-requests`, `node`/undici). **[confirmed]**
- Legacy page (Codex Cloud (Legacy): internet access) lists the "Common dependencies" allowlist (alpinelinux.org ... yarnpkg.com, 70+ domains) and the recommended method restriction to `GET`, `HEAD`, `OPTIONS`. **[confirmed]**
- GitHub access goes through a server-side proxy that attaches credentials; the same pattern as Anthropic's cloud sessions.

### 2.10 Agents SDK / Responses API hosted tools
- `web_search` (recommended) and legacy `web_search_preview`: `external_web_access` toggles live fetch vs cache-only (default live); actions reported as `search`, `open_page`, `find_in_page`; `filters.allowed_domains`/`blocked_domains` (up to 100 each); `sources` lists URLs consulted. **The docs say nothing about which identity fetches pages** (OAI-SearchBot index vs ChatGPT-User-style live fetch) **[uncertain]**; given OpenAI's own definitions, live `open_page` fetches most plausibly arrive as `ChatGPT-User/1.0` from `chatgpt-user.json` ranges, and index-backed results come from OAI-SearchBot crawls. Chat Completions equivalents: `gpt-5-search-api` (the `gpt-4o-search-preview` models were shut down 2026-07-23).
- `computer` tool (GA; `computer_use_preview` is the legacy name; migration table: model `computer-use-preview` -> `gpt-6.1-sol`, tool `computer_use_preview` -> `computer`, batched `actions[]`, no `truncation:"auto"`): "Your environment must execute the requested actions and capture screenshots" with Playwright/Selenium; partner-hosted options Browserbase, Browser Use, Daytona, E2B; "The SDK sends returned page text or screenshots to OpenAI". The browser identity is therefore **the developer's or partner's**, not OpenAI's. **[confirmed]**
- Agents API hosted browser: tool `{ "type": "computer_use" }` with `environment.type = "openai_hosted"`, `environment.desktop.enabled = true`, `environment.network.access = "enabled"`; "The Agents API runs the browser in an OpenAI-hosted environment"; every new origin needs a `browser_origin_access` approval; sign-in via `browser_authentication` (no passkeys/QR). **No UA, IP feed, robots or signing statement anywhere on the page** **[confirmed absence]**. Expect the same stack as the ChatGPT cloud browser (Chrome UA, possibly chatgpt.com-signed) **[uncertain]**.

### 2.11 dots (announced 2026-09-29, DevDay 2026)
- OpenAI: "dots, remarkably capable, always-on agents built to handle everything", "powered by GPT-6 Astra" (openai.com/index/introducing-dots, help article 20001530 "Getting started with your dot", ChatGPT release notes; the announcement page 403'd to the fetch tool, text via search excerpts and TNW/VentureBeat/MarkTechPost). Each dot "has its own cloud computer and browser"; connects to 4,000+ apps through plugins; between conversations it works in a read-only proactive mode ("can only use connected apps in read-only mode"; cannot control a browser or computer in that mode); can sign in to supported sites with saved passwords without the model seeing them; optional connection to the user's own laptop via the desktop app; a monitoring system can pause/stop a dot; available on Pro (not EEA/CH/UK) and Business Premium, Enterprise beta. **[likely; consistent secondary + OpenAI release notes excerpt]**
- Wire identity: **undocumented**. Because the dot's browser is an OpenAI cloud browser, the reasonable expectation is the same `Signature-Agent: "https://chatgpt.com"` signing as ChatGPT Work's cloud browser, but I found no statement or capture confirming it. Tasks a dot starts "in Codex or ChatGPT Work count toward usage limits", suggesting dots dispatch into those same environments (hence `chatgpt-agents.json` for Codex-side egress). **[uncertain]**

### 2.12 Operator (historical)
- Cloudflare's 2025-05-15 blog quoted OpenAI: "OpenAI signs all Operator requests so site owners can verify they genuinely originate from Operator" and used `operator.openai.com` as an example Signature-Agent. Today `operator.openai.com` does not resolve. Any detector rule keyed on `operator.openai.com` is dead. **[confirmed]**

---

## 3. Anthropic

Primary page: https://support.claude.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web-and-how-can-site-owners-block-the-crawler (fetched). It documents three tokens, the IP list URL, robots behaviour and crawling principles; it does **not** publish full UA strings, rDNS, JS behaviour or any signing. **[confirmed]**

### 3.1 ClaudeBot, Claude-User, Claude-SearchBot
| Token | Anthropic's description | Effect of blocking |
|---|---|---|
| `ClaudeBot` | collects web content "that could contribute to model training" | future material excluded from training datasets |
| `Claude-User` | fetches when "a Claude user asks a question that needs" the site | no retrieval for user queries; may reduce visibility in user-directed search |
| `Claude-SearchBot` | indexes to improve search result quality | no indexing for search |

- robots.txt: "Anthropic's Bots respect 'do not crawl' signals by honoring industry standard directives in robots.txt"; supports the non-standard `Crawl-delay` (example `Crawl-delay: 1`); block with `Disallow: /` per token, per subdomain. Anti-circumvention principle: "will not bypass CAPTCHAs for the sites we crawl". IP blocking is discouraged because it stops the bots reading robots.txt. Deprecated/undocumented tokens still seen in third-party lists: `Claude-Web`, `anthropic-ai` (knownagents marks `anthropic-ai` "unconfirmed" and `Claude-Web` "undocumented"). **[confirmed]**
- **Published IP list**: `https://claude.com/crawling/bots.json` ("If a crawler's source IP is on that list, the request comes from Anthropic"). Snapshot: `creationTime` `2026-10-20T00:00:00Z`, 14 IPv4 prefixes, `cache-control: public, max-age=3600`:
  `216.73.216.0/22, 34.162.230.222/32, 34.162.244.71/32, 34.162.191.81/32, 34.162.86.102/32, 136.79.143.251/32, 136.83.20.215/32, 34.162.111.78/32, 34.162.90.102/32, 34.162.27.34/32, 34.152.124.140/32, 34.153.21.190/32, 34.186.252.4/32, 34.162.153.71/32`.
  The file does not say which prefix belongs to which bot. **[confirmed]**
- Attribution by whois/rDNS (probed): `216.73.216.0/22` is ARIN `AMAZO-4` (Amazon, i.e. AWS), no rDNS; the `34.162.x`, `136.79.x`, `136.83.x` /32s reverse to `*.bc.googleusercontent.com` (Google Cloud NAT egress). So ClaudeBot traffic will look like generic AWS/GCP to IP-reputation systems; **there is no Anthropic-branded rDNS**. **[confirmed]**
- A second Anthropic range matters for user-directed fetches: the platform docs page "IP addresses" (fetched) lists **outbound** `160.79.104.0/21` ("stable IP addresses that Anthropic uses for outbound requests (for example, when making MCP tool calls to external servers)") and notes that for the AWS-hosted platform "Outbound tool calls (MCP connector, web search, and web fetch) originate from the Anthropic ranges listed on this page". whois: `AP-2440 Anthropic, PBC`. Inbound: `160.79.104.0/23`, `2607:6bc0::/48`. Phased out: `34.162.46.92/32, 34.162.102.82/32, 34.162.136.91/32, 34.162.142.92/32, 34.162.183.95/32`. A Claude Code user reported that allowlisting `160.79.104.0/21` fixed Claude Code CLI WebFetch 403s (GitHub issue 22846, Feb 2026). **[confirmed doc; third-party for the CLI anecdote]**
- Full UA strings (Anthropic publishes only the tokens; a 2026-10 crawler list notes "Not published (the user agent contains ClaudeBot)"):
  - Claude-User, observed by Simon Willison (2025-09-10, consumer app `web_fetch`) and by a GitHub reporter (2026-02-04): `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-User/1.0; +Claude-User@anthropic.com)` **[confirmed observation]**
  - Claude-SearchBot, third-party directory (knownagents.com, updated 2026-10-23): `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-SearchBot/1.0; +searchbot@anthropic.com)`; other directories print `+Claude-SearchBot@anthropic.com` or `+claudebot@anthropic.com`. The contact suffix is **[uncertain]**; match on the token `Claude-SearchBot/`.
  - ClaudeBot: widely reported as `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)`; one directory (llmpulse) shows an older bare form `ClaudeBot (https://www.anthropic.com)`. **[uncertain exact string; token confirmed]**
  - Note the shape difference from OpenAI: Anthropic puts `compatible; <Token>/1.0; +contact` **inside** the `(KHTML, like Gecko; ...)` parentheses.
- JavaScript: not rendered (Vercel/MERJ 2024 measurement for ClaudeBot; Anthropic's own web_fetch doc states the tool "does not support websites dynamically rendered with JavaScript"). Claude fetched JS files 23.84% of the time without executing them and had a 34% 404 rate on nextjs.org (2024). **[confirmed]**

### 3.2 Claude API server tools: web_fetch and web_search (what powers Claude-User traffic)
- `web_fetch` versions: `web_fetch_20250910` (basic), `web_fetch_20260209` (dynamic filtering), `web_fetch_20260309` (+`use_cache`), `web_fetch_20260318` (+`response_inclusion`). "Web fetch is a server tool: the API fetches the content during the request". "The web fetch tool currently does not support websites dynamically rendered with JavaScript." Error code `url_not_allowed` covers "Anthropic-side restrictions, such as private addresses, `robots.txt`, and URLs that appear to contain a credential" -> **robots.txt is enforced server-side for web_fetch**. Only text/HTML/PDF; URL max 250 chars; results are cached ("content returned might not always reflect the latest version"; `use_cache:false` bypasses) -> a site may see fewer hits than requests. Org admins can disable or domain-restrict it. **[confirmed]**
- `web_search` versions: `web_search_20250305`, `web_search_20260209`, `web_search_20260318`; $10 per 1,000 searches; results carry `page_age` and `encrypted_content`. The doc does not name the fetching identity; Managed Agents docs mention validation against "a domain in `allowed_domains` that Anthropic's crawler is not allowed to access" (i.e., robots-aware). **[confirmed]**
- Claude Managed Agents (beta `managed-agents-2026-04-01`): "`web_search` and `web_fetch` run on Anthropic's servers, not in the sandbox"; per-tool `allowed_domains`/`blocked_domains` (<=64), `max_content_tokens`, `user_location`. Sandbox code's own HTTP calls go out through the environment's `limited`/`unrestricted` networking (egress identity not documented). **[confirmed]**
- Where the traffic comes from: documented outbound range `160.79.104.0/21`; the consumer app's web_fetch presents `Claude-User/1.0`. Expect API web_fetch to look identical **[likely]**.

### 3.3 Claude Code: WebFetch / WebSearch, local and cloud
- Local CLI: `WebFetch` runs **on the user's machine** (user's IP) after a preflight call to `https://claude.ai/api/web/domain_info?domain=<host>`; users reported the HTTP client UA as `axios/1.8.4` (Feb 2026) and one reported an empty UA; `WebSearch` runs "at the model's provider" (Anthropic-side), not from the host. No Anthropic documentation of these headers exists; treat as **[uncertain, third-party]**. Detector note: an `axios/<ver>` UA hitting a page right after a `claude.ai` referrer-less preflight pattern is weak evidence; the robust signal is behavioural.
- Cloud sessions (claude.ai/code, `claude --cloud`, Desktop "Cloud", mobile, scheduled tasks, Claude Tag): run in "an isolated, Anthropic-managed VM"; network access levels (Trusted / Limited / None) with a default allowed-domain list and an egress proxy; "GitHub operations from the VM go through the GitHub proxy, which attaches the credential on the server side"; network secrets are attached after requests leave the session. **No published egress IP range or User-Agent for cloud-session HTTP traffic** **[confirmed absence]**. One Cowork user saw `EGRESS_BLOCKED from Anthropic's proxy` for a blocked destination, confirming a proxy sits in the path. Zero-data-retention/HIPAA/CMEK orgs cannot use cloud sessions.

### 3.4 Claude in Chrome (extension ID `fcoeoabgfenejglbffodgkkbkcdhcgfn`), Cowork browsers
Sources: support article 12012173 (fetched), Chrome Web Store listing (fetched), CRX unpacked locally, CHEQ reverse-engineering post (2026-02-18). **[confirmed unless marked]**
- Listing: "Claude", developer Anthropic (`chrome-developer@anthropic.com`), version `1.0.102`, updated 2026-10-21, "20,000,000 users". "Claude reads the page, clicks, types, navigates, and fills forms, while you watch"; "Claude can ask before it acts, one site at a time"; optional mode where "a separate safety check reviews each consequential action first". Not supported on other Chromium browsers or mobile.
- Manifest: `permissions`: `sidePanel, storage, activeTab, scripting, debugger, tabGroups, tabs, alarms, notifications, webNavigation, declarativeNetRequestWithHostAccess, offscreen, nativeMessaging, unlimitedStorage, downloads, identity`; `host_permissions: ["<all_urls>"]`; `externally_connectable` = claude.ai; CSP `connect-src` includes `https://api.anthropic.com wss://api.anthropic.com https://claude.ai https://platform.claude.com ... wss://bridge.claudeusercontent.com wss://bridge-staging.claudeusercontent.com` (Sentry + Datadog telemetry). Anthropic's permissions guide says `declarativeNetRequestWithHostAccess` "lets the extension identify itself to Anthropic's servers" (not to third-party sites; I found no `modifyHeaders` rule or custom header in the bundle).
- Content scripts on **every** page: `assets/accessibility-tree.js-B-oUarrX.js` (`<all_urls>`, `document_start`, all frames) and `assets/agent-visual-indicator.js-uaVFxZ2f.js` (`document_idle`), both also listed as `web_accessible_resources` for `<all_urls>` -> installation probe: `fetch('chrome-extension://fcoeoabgfenejglbffodgkkbkcdhcgfn/assets/accessibility-tree.js-B-oUarrX.js')` resolves when installed. The hash suffix changes per release (CHEQ saw `D39zjmMD` in Feb 2026; today `B-oUarrX`), so probe code must be version-aware or enumerate recent hashes.
- DOM markers while an agent session is active (ids created by the bundle): `claude-agent-stop-container`, `claude-agent-stop-button`, `claude-agent-glow-border`, `claude-agent-glow-border-inner`, `claude-phantom-cursor` (aria-hidden), plus side-panel overlays `claude-screenshot-overlay`, `claude-prompt-overlay`, `claude-prompt-container`, `claude-element-overlay`, `claude-element-highlight`, `claude-element-prompt-container`; CSS keyframes `claude-pulse`. CHEQ also reported a persisting `<style id="claude-agent-animation-styles">` and recommended the selector `[id^="claude-agent-"]` with a `MutationObserver` on `document.body` **[third-party; consistent with bundle]**. A `window.__claudeElementMap` object is used for element references, but it is created from `chrome.scripting.executeScript` (isolated world by default) so page JS probably cannot see it **[uncertain]**.
- CDP behaviour: `chrome.debugger.attach({tabId}, "1.3")`; `Emulation.setFocusEmulationEnabled` (keeps background tabs "focused"); input via `Input.dispatchMouseEvent`, `Input.dispatchKeyEvent`, `Input.insertText`; `Runtime.evaluate` for JS tools. No `Network.setUserAgentOverride` / `setExtraHTTPHeaders` found -> UA, cookies, IP are the **user's**. Chrome shows the debugger infobar.
- Architecture (support article): the side panel "runs as a Claude Cowork session" ("runs in the cloud"), but browser actions execute in the user's local Chrome through the extension; tasks needing local files still need Claude Desktop open. Enterprise requires "Cowork in the cloud" to be enabled. Admin allow/block lists govern navigation; the same list governs the Cowork built-in browser. Network endpoints admins must allow: `claude.ai`, `api.anthropic.com`, `platform.claude.com`, `wss://bridge.claudeusercontent.com`.
- Cowork built-in browser (support article 16607400): "The built-in browser lives in the desktop app" (user's machine), separate profile ("doesn't touch your tabs or logins"), optional per-site login import from Chrome/Edge/Firefox; no UA/engine statement. So a Cowork session controlled from the cloud still produces traffic from the **user's IP**, through either their Chrome or the desktop app's embedded browser. **[confirmed]**

### 3.5 Computer use and browser use (Claude API)
- `computer_toolset_20260801` (current; earlier `computer_20251124`, `computer_20250124`): "your application runs every call in an environment you control"; reference implementation is a Docker container with Xvfb. Not available in Managed Agents. **[confirmed]**
- `browser_toolset_20260801` (client toolset, 27 member tools + optional `javascript_exec`, `file_upload`, `read_console`, `read_network`): "Your application runs every call against its own browser automation; nothing runs on Anthropic's side"; "the sites Claude visits see your executor's network identity". **[confirmed]**
- Consequence: Anthropic-model-driven computer/browser agents built on these tools are indistinguishable from any other Playwright/CDP automation at the network layer; attribution must come from the automation stack (Browser Use, Stagehand, etc.), not from Anthropic identity.

### 3.6 Claude Agent SDK
The Agent SDK wraps Claude Code's tools, so `WebFetch` executes wherever the SDK process runs (developer infrastructure) and `WebSearch` is Anthropic-side; identity follows 3.3. **[likely; follows from the Claude Code docs]**

---

## 4. Google

Primary pages (all fetched 2026-10-24): crawler overview; `google-common-crawlers` (updated 2026-10-15); `google-special-case-crawlers`; `google-user-triggered-fetchers` (updated 2026-08-19); `verify-google-requests`; `web-bot-auth` (updated 2026-10-13); AI features page (updated 2025-12-10). **[confirmed]**

### 4.1 Verification model, rDNS masks and IP feeds
| Category | rDNS mask | IP feed (prefix `https://developers.google.com/static/crawling/ipranges/`) | Snapshot 2026-10-24 (creationTime 2026-10-23T14:45-46Z) |
|---|---|---|---|
| Common crawlers | `crawl-***-***-***-***.googlebot.com`, `geo-crawl-***-***-***-***.geo.googlebot.com` | `common-crawlers.json` | 170 IPv4 + 147 IPv6 |
| Special-case crawlers | `rate-limited-proxy-***-***-***-***.google.com` | `special-crawlers.json` | 136 + 136 |
| User-triggered fetchers (Google-controlled) | `google-proxy-***-***-***-***.google.com` (and "resolve to a google.com hostname") | `user-triggered-fetchers-google.json` | 252 + 252 |
| User-triggered fetchers (user-owned / GAE) | `***-***-***-***.gae.googleusercontent.com` | `user-triggered-fetchers.json` | 534 + 534 |
| User-triggered **agents** | (documented under the fetcher masks; probed = `google-proxy-*.google.com`) | `user-triggered-agents.json` | **12 IPv4 + 8 IPv6** |
- Legacy paths: `/static/search/apis/ipranges/googlebot.json` now returns 301 (to common-crawlers); the `/static/search/apis/ipranges/*.json` aliases still serve 200 for the newer files. Other Google IPs: `https://www.gstatic.com/ipranges/goog.json`. Manual verification: rDNS domain must be `googlebot.com`, `google.com` or `googleusercontent.com`, then forward-confirm. **[confirmed]**
- `user-triggered-agents.json` full contents: IPv6 `2001:4860:c::/124, ::10/124, ::20/124, ::30/124, ::40/124, ::50/124, ::60/124, ::70/124`; IPv4 `136.121.16.0/24, 136.121.24.0/21, 136.121.40.0/21, 136.122.0.0/16, 74.125.232.0/28, .16/28, .32/28, .48/28, .64/28, .80/28, .96/28, .112/28`. These prefixes appear in **no other** Google file (checked). Probed rDNS: `136.122.0.5 -> google-proxy-136-122-0-5.google.com`, `136.121.16.5 -> google-proxy-136-121-16-5.google.com`, `136.121.24.5`, `136.121.40.5` likewise, `74.125.232.5 -> google-proxy-74-125-232-5.google.com`, `2001:4860:c::5 -> google-proxy-2001-4860-000c-0000-0000-0000-0000-0005.google.com`; whois `136.112.0.0/12` = Google LLC (`GOOGL-46`). **[confirmed]**
- Control-plane sanity checks: `66.249.66.1 -> crawl-66-249-66-1.googlebot.com`; `74.125.151.5 -> rate-limited-proxy-74-125-151-5.google.com`. **[confirmed]**

### 4.2 Common crawlers (honor robots.txt; render JS via Googlebot's WRS)
Full strings (`Chrome/W.X.Y.Z` is Google's placeholder for the evergreen Chrome version):
- Googlebot Smartphone: `Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/W.X.Y.Z Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)`
- Googlebot Desktop: `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Googlebot/2.1; +http://www.google.com/bot.html) Chrome/W.X.Y.Z Safari/537.36`; rare: `Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)` and `Googlebot/2.1 (+http://www.google.com/bot.html)`
- `Googlebot-Image/1.0`, `Googlebot-Video/1.0`; Googlebot-News uses the Googlebot strings.
- Storebot desktop: `Mozilla/5.0 (X11; Linux x86_64; Storebot-Google/1.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/W.X.Y.Z Safari/537.36`; mobile: `Mozilla/5.0 (Linux; Android 8.0; Pixel 2 Build/OPD3.170816.012; Storebot-Google/1.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/W.X.Y.Z Mobile Safari/537.36`
- Google-InspectionTool: `Mozilla/5.0 (compatible; Google-InspectionTool/1.0)` and the Nexus 5X mobile wrapper ending `(compatible; Google-InspectionTool/1.0)`
- GoogleOther mobile: `Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/W.X.Y.Z Mobile Safari/537.36 (compatible; GoogleOther)`; desktop: `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GoogleOther) Chrome/W.X.Y.Z Safari/537.36`; `GoogleOther-Image/1.0`; `GoogleOther-Video/1.0`. GoogleOther is the "generic crawler ... used by various product teams for fetching publicly accessible content"; it does not affect a specific product.
- Google-CloudVertexBot: Google documents only the substring `Google-CloudVertexBot`; it crawls "requested by the site owners" to build Vertex AI Agents; "no effect on Google Search".
- **Google-Extended**: "a standalone product token ... to manage whether content Google crawls from their sites may be used for training future generations of Gemini models" and for grounding in Gemini Apps and Grounding with Google Search on Vertex AI; it has **no user-agent string of its own** (requests arrive as Googlebot/GoogleOther) and "does not impact a site's inclusion in Google Search". Detector consequence: Google-Extended cannot be detected on the wire; it is a robots.txt policy knob only. **[confirmed]**

### 4.3 Special-case crawlers (`special-crawlers.json`, `rate-limited-proxy-*.google.com`)
- `APIs-Google (+https://developers.google.com/webmasters/APIs-Google.html)` (ignores `*`)
- `AdsBot-Google (+http://www.google.com/adsbot.html)`; AdsBot Mobile Web: `Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/W.X.Y.Z Mobile Safari/537.36 (compatible; AdsBot-Google-Mobile; +http://www.google.com/mobile/adsbot.html)` (ignore `*`)
- `Mediapartners-Google` (desktop) / `(Various mobile device types) (compatible; Mediapartners-Google/2.1; +http://www.google.com/bot.html)` (ignores `*`)
- `Google-Safety`: "ignores robots.txt rules" (abuse/malware checks).
- Retired tokens worth keeping in a legacy table: `DuplexWeb-Google`, `googleweblight`, `AdsBot-Google-Mobile-Apps`, "Google Favicon" (`Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/49.0.2623.75 Safari/537.36 Google Favicon`). **[confirmed]**

### 4.4 User-triggered fetchers ("generally ignore robots.txt rules")
| Token | UA string (verbatim) | Notes |
|---|---|---|
| `FeedFetcher-Google` | `FeedFetcher-Google; (+http://www.google.com/feedfetcher.html)` | RSS/Atom for Google News & WebSub |
| `GoogleProducer` | `GoogleProducer; (+https://developers.google.com/search/docs/crawling-indexing/google-producer)` | Publisher Center feeds |
| `Google-Site-Verification` | `Mozilla/5.0 (compatible; Google-Site-Verification/1.0)` | Search Console tokens |
| `Google-Read-Aloud` | mobile `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36 (compatible; Google-Read-Aloud; +https://support.google.com/webmasters/answer/1061943)`; desktop `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36 (compatible; Google-Read-Aloud; +https://support.google.com/webmasters/answer/1061943)` | former `google-speakr` deprecated |
| `Google-GeminiNotebook` | same two wrappers with `(compatible; Google-GeminiNotebook; +https://developers.google.com/crawling/docs/crawlers-fetchers/google-gemininotebook)` | "formerly `Google-NotebookLM`", old token supported until August 2026 |
| `Google-CWS` | `Mozilla/5.0 (compatible; Google-CWS)` | Chrome Web Store metadata URLs |
| `GoogleMessages` | `GoogleMessages` | link previews |
| `Google-Pinpoint` | `Google-Pinpoint` | Pinpoint document collections |
| **`Google-Agent`** | mobile `Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/W.X.Y.Z Mobile Safari/537.36 (compatible; Google-Agent; +https://developers.google.com/crawling/docs/crawlers-fetchers/google-agent)`; desktop `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko; compatible; Google-Agent; +https://developers.google.com/crawling/docs/crawlers-fetchers/google-agent) Chrome/W.X.Y.Z Safari/537.36` | see 4.5 |
Note the fixed Chrome 137/138 versions in the Read-Aloud and GeminiNotebook strings (not evergreen placeholders) as documented in August 2026. **[confirmed]**

### 4.5 Google-Agent (hosted agents: Project Mariner, Gemini agent mode and friends)
- Google's definition: "Google-Agent is used by agents hosted on Google infrastructure to navigate the web and perform actions upon user request. It uses IP ranges from user-triggered-agents.json." Added to the docs on **2026-03-20** (nohacks.co; Google's page shows only "last updated 2026-08-19"). Google is "experimenting with the Web Bot Auth protocol, using the `https://agent.bot.goog` identity". robots.txt: inherits "generally ignore robots.txt rules". **[confirmed]**
- Product mapping: Google's docs do not name products. Third-party reporting says "Project Mariner, Google's experimental AI browsing tool, is the first product using it" (nohacks.co) **[likely]**. Google's own Gemini 2.5 Computer Use post (2025-10-07) says "Versions of this model have also been powering Project Mariner, the Firebase Testing Agent, and some agentic capabilities in AI Mode in Search", and the I/O 2025 keynote introduced "Agent Mode in the Gemini app" built on Mariner. Given that Mariner moved to Google-hosted VMs in 2025 (I/O 2025 messaging; not restated on the pages I could fetch) and that Google-Agent is defined as the hosted-agent identity, treat Gemini-app Agent Mode and the hosted parts of AI Mode agentic features as **[likely]** Google-Agent emitters; this is inference, not a Google statement.
- Web Bot Auth specifics (Google doc): "A subset of requests made by the Google-Agent are signed with Web Bot Auth; in these cases, they are authenticated as https://agent.bot.goog"; verification keys at `https://agent.bot.goog/.well-known/http-message-signatures-directory`; "Participating requests sent to your server will have the Signature-Agent HTTP request header set to g="https://agent.bot.goog""; verify per RFC 9421 against the `Signature-Input`; fall back to IP verification; latency-sensitive sites may respond first and verify within the signature's expiry; Google calls the implementation "currently experimental" because the IETF draft may change and IP/UA remain the de facto standard. **[confirmed]**
- Executes JavaScript (Chromium-based agent). Egress is Google infrastructure, not the user's IP. **[confirmed by UA/IP docs]**

### 4.6 Gemini in Chrome, auto browse, Project Mariner, Gemini Computer Use API
- Gemini in Chrome (US, Sept 2025) gained "auto browse" on 2026-01-28 for AI Pro/Ultra subscribers in the US (Android support later): the agent "traversing websites on your behalf", using Chrome's password manager / saved cards without exposing them to the model, and pausing for login and final purchase. This runs **in the user's own Chrome** (it is a Chrome feature, not a fetcher), so the site sees the user's UA, cookies and IP; there is no Google token and no signing. **[likely; TechCrunch + Google messaging; Google does not publish a wire spec]**
- Project Mariner (DeepMind research prototype, Dec 2024; multitasking + "teach and repeat" at I/O 2025; developer access "via the Gemini API") -> today the `Google-Agent` identity (see 4.5). The DeepMind models page no longer lists Mariner as a product. **[confirmed page state; mapping likely]**
- Gemini 2.5 Computer Use model (public preview 2025-10-07 via Gemini API in AI Studio and Vertex AI, demo on Browserbase): developers "build your own agent loop locally with Playwright or in a cloud VM with Browserbase" -> traffic carries the **developer's/partner's** identity, not Google's. **[confirmed]**

### 4.7 AI Overviews, AI Mode and Google-Extended
- Google's "AI features and your website" (updated 2025-12-10): AI Overviews and AI Mode are governed by the same controls as Search; "robots.txt directives for Googlebot is the control"; use `nosnippet`, `data-nosnippet`, `max-snippet`, `noindex` to limit; AI-feature traffic is reported in Search Console under the "Web" search type. **There is no separate AI Overviews/AI Mode fetcher**; grounding/training use for Gemini is governed by the `Google-Extended` token. **[confirmed]**
- A third-party claim that a Search Console setting to opt out of AI Overviews/AI Mode launched on 2026-08-31 could not be verified against Google's page (which predates it). **[uncertain]**
- Agentic checkout / UCP (Universal Commerce Protocol): AP2 says it is "designed explicitly to be compatible with the Universal Commerce Protocol (UCP)"; I found no Google doc describing a distinct fetcher identity for agentic checkout; hosted actions would fall under Google-Agent. **[uncertain]**

### 4.8 Tokens seen only in third-party lists (treat as unverified)
- `Gemini-Deep-Research`: knownagents/darkvisitors list `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Gemini-Deep-Research; +https://gemini.google/overview/deep-research/) Chrome/135.0.0.0 Safari/537.36`, "Operated by Google", US origin; the directory itself says "Because Gemini-Deep-Research does not publish a verification method, any client can claim its identity". **Not present in Google's user-triggered fetcher list as of 2026-08-19.** Treat UA matches as low-confidence Google attribution; verify by IP against the Google feeds. **[uncertain]**
- `GoogleAgent-Mariner`, `GoogleAgent-URLContext`, `Google-Gemini-CLI`: appear in one aggregator table; a 2026-10 crawler list states "GoogleAgent-Mariner is not in Google's crawler list". Not in any Google page I fetched. **[uncertain]**

### 4.9 AP2 (Agent Payments Protocol) and agent identity
- Spec "Agentic Payment Protocol (v0.2)" (GitHub `google-agentic-commerce/AP2`, `docs/ap2/specification.md`, fetched): roles Shopping Agent, Credential Provider, Merchant, Merchant Payment Processor, Trusted Surface; mandates are SD-JWT verifiable digital credentials: Checkout Mandate (`mandate.checkout.open.1`, user-signed via Trusted Surface or signed by a trust list of Agent Providers; merchant signs the Checkout JWT) and Payment Mandate (`mandate.payment.1`); agent key carried as a `cnf` claim; Agent Authorization Framework uses OpenID4VP (`dc+sd-jwt`), Key Binding JWTs, example `vct` `com.emvco.dpc`. Transport is "outside the scope of AP2"; compatible with UCP; A2A/MCP/x402 appear only in sample paths. **No HTTP header, HTTP Message Signature, Web Bot Auth, Visa Trusted Agent Protocol or Mastercard Agent Pay reference anywhere in the spec or authorization doc.** **[confirmed]**
- Consequence: AP2 gives a merchant a cryptographic proof at the **checkout/payment layer** (who authorised the purchase), not an identity for the agent's ordinary page requests. A firewall cannot use AP2 to recognise a shopping agent browsing a catalogue; at most it can expect AP2 mandates on the merchant's checkout API.

---

## 5. Detector implementation notes (what to build from this)

1. **UA token table** (exact, case-sensitive substrings): `GPTBot/`, `ChatGPT-User/`, `OAI-SearchBot/`, `OAI-AdsBot/`, `ClaudeBot`, `Claude-User/`, `Claude-SearchBot/`, `Googlebot/`, `Googlebot-Image/`, `Googlebot-Video/`, `Storebot-Google/`, `Google-InspectionTool/`, `GoogleOther`, `GoogleOther-Image/`, `GoogleOther-Video/`, `Google-CloudVertexBot`, `APIs-Google`, `AdsBot-Google`, `AdsBot-Google-Mobile`, `Mediapartners-Google`, `Google-Safety`, `FeedFetcher-Google`, `GoogleProducer`, `Google-Site-Verification/`, `Google-Read-Aloud`, `Google-GeminiNotebook`, `Google-NotebookLM`, `Google-CWS`, `GoogleMessages`, `Google-Pinpoint`, `Google-Agent`. Parse OpenAI's out-of-parentheses `; compatible; X/1.4; +url` shape and the `; robots.txt;` marker. Flag `Gemini-Deep-Research`, `Claude-Web`, `anthropic-ai`, `GoogleAgent-*` as "claimed, unverifiable".
2. **IP verification** (claimed UA must match feed, else "spoofed"): OpenAI `gptbot.json` / `chatgpt-user.json` / `searchbot.json` / `adsbot.json` (+ `chatgpt-connectors.json`, `chatgpt-agents.json` for backend/agent egress); Anthropic `claude.com/crawling/bots.json` plus `160.79.104.0/21`; Google five files. Refresh at least daily (Google regenerates nightly; OpenAI's `creationTime` moved 2026-10-20; Anthropic `max-age=3600`). Note OpenAI feeds are IPv4-only while the signed agent was seen on IPv6.
3. **rDNS**: only Google has it (`googlebot.com`, `google.com`, `googleusercontent.com`; `google-proxy-*` = user-triggered incl. Google-Agent). OpenAI and Anthropic ranges have no PTR or generic cloud PTRs (`bc.googleusercontent.com`, AWS), so rDNS is useless for them; use feeds.
4. **Web Bot Auth verifier** must: accept `Signature-Agent` as RFC 8941 String **or** Dictionary; accept arbitrary labels (`sig1`, `g`); fetch `/.well-known/http-message-signatures-directory` from the agent origin, require Ed25519 OKP keys, match `keyid` to `kid` or to the computed thumbprint; verify `tag="web-bot-auth"`, `created`/`expires`; verify the directory's own signature (`tag="http-message-signatures-directory"`); cache by `Cache-Control` (Google 3600 s; OpenAI `no-store` but single stable `kid`); treat OpenAI's rolling `exp` as non-informative. Attribute `https://chatgpt.com` -> OpenAI cloud browser family (ChatGPT Work / agent, probably dots and Agents-API hosted browser) and `https://agent.bot.goog` -> Google-Agent. Unsigned requests from these products are still possible (Google explicitly; OpenAI for favicon/subresource fetchers).
5. **Client-hint inconsistency** as a hosted-browser signal: UA says macOS, `Sec-CH-UA-Platform` says `"Linux"`, brand list is `Chromium` only (ChatGPT agent, Aug 2025). Collect `Sec-CH-UA*` server-side and `navigator.userAgentData` client-side and compare.
6. **Local-browser extension agents** (traffic is indistinguishable at L3/L4; detect in-page):
   - Claude in Chrome: probe `chrome-extension://fcoeoabgfenejglbffodgkkbkcdhcgfn/assets/accessibility-tree.js-<hash>.js` (hash per version), watch for `[id^="claude-agent-"]`, `#claude-phantom-cursor`, `#claude-agent-glow-border`, `<style id="claude-agent-animation-styles">`; CDP-driven input (trusted events, no `navigator.webdriver`); `Emulation.setFocusEmulationEnabled` means `document.hasFocus()` is true in background tabs.
   - ChatGPT extension: optional request header `x-browser-agent: ChatGPT/<sessionId>` (server-policy gated); probe `chrome-extension://hehggadaopoacecdllhhajmbjkdcmajg/images/cursor-chat.png`; DOM `#codex-agent-overlay-root`, `link[data-codex-favicon-badge="true"]`; `Emulation.setDeviceMetricsOverride` with `deviceScaleFactor: 1` (a Retina Mac reporting `devicePixelRatio === 1` plus a fixed lease viewport is a tell).
   - Gemini in Chrome auto browse: no public markers found; rely on behavioural signals.
7. **JS-execution split**: GPTBot / ChatGPT-User / OAI-SearchBot / Claude* / Anthropic web_fetch do **not** run JS -> a JS-only beacon that never fires for a UA-identified session is consistent, and a *firing* beacon from an IP in those feeds would itself be anomalous; Googlebot, Google-Agent and all cloud browsers do run JS.
8. **robots.txt semantics**: honoured by GPTBot, OAI-SearchBot, ClaudeBot, Claude-User, Claude-SearchBot (and Anthropic's API web_fetch enforces it server-side); "may not apply" for ChatGPT-User; "generally ignore" for all Google user-triggered fetchers and Google-Agent; no statement for OpenAI's cloud browser. A robots `Disallow` therefore cannot be relied on to stop agents; the firewall must enforce at the edge.
9. **Hosted vs local**: hosted = GPTBot, ChatGPT-User, OAI-SearchBot, OAI-AdsBot, ChatGPT Work cloud browser, dots, Codex cloud, Agents-API `openai_hosted` browser, Claude* fetchers, Anthropic server tools, Claude Code cloud sessions, Googlebot family, Google user-triggered fetchers, Google-Agent. Local = ChatGPT Chrome extension, ChatGPT desktop browser mode, Claude in Chrome, Cowork built-in browser, Claude Code local WebFetch, Gemini in Chrome auto browse, plus every developer-run computer-use / browser-use / Gemini Computer Use integration (identity = developer or partner such as Browserbase).

---

## 6. Unknowns and gaps

- Whether ChatGPT Work's cloud browser, dots and the Agents-API hosted browser egress from `chatgpt-agents.json` (OpenAI maps that feed only to Codex cloud) and whether all three sign with `https://chatgpt.com`.
- Whether OpenAI currently enables the `agent_request_header_enabled` policy (the `x-browser-agent` header) for the ChatGPT Chrome extension in production, and what the ChatGPT desktop app's built-in browser mode sends.
- Exact current UA strings for ClaudeBot and Claude-SearchBot (contact-address suffix varies across third-party captures); whether `bots.json` prefixes are per-bot.
- The identity used by OpenAI's hosted `web_search` `open_page` fetches (ChatGPT-User vs OAI-SearchBot vs something else).
- Which Google products emit `Google-Agent` beyond Project Mariner (Gemini app Agent Mode, AI Mode agentic actions, agentic checkout) and whether Gemini in Chrome auto browse ever proxies through Google infrastructure.
- Whether Google will publish `Gemini-Deep-Research` officially; whether the Search Console AI-features opt-out (claimed 2026-08-31) exists.
- Claude Code cloud sessions / Managed Agents sandbox egress IP ranges and User-Agent; Cowork cloud browser (if one exists apart from the desktop built-in browser).
- The OpenAI "Codex" Chrome extension (`lfkehkpjohcoelkpembgemeipeppanef`): listing/CRX not retrievable, so its wire behaviour is unknown.
- Pages that returned 403 and should be re-read from a browser: OpenAI help 11845367, 20001371, 20001530; `openai.com/index/introducing-dots/`; HUMAN's Atlas analyses; DataDome's Claude-User page.

---

## 7. Sources

OpenAI
- https://developers.openai.com/api/docs/bots (redirect target of https://platform.openai.com/docs/bots)
- https://openai.com/gptbot.json , https://openai.com/chatgpt-user.json , https://openai.com/searchbot.json , https://openai.com/adsbot.json
- https://openai.com/chatgpt-agents.json , https://openai.com/chatgpt-connectors.json
- https://developers.openai.com/api/docs/guides/ip-addresses , https://developers.openai.com/api/docs/guides/ip-allowlist
- https://chatgpt.com/.well-known/http-message-signatures-directory
- https://help.openai.com/en/articles/11845367-chatgpt-works-cloud-browser-allowlisting (403 to fetch tool; content via search excerpts)
- https://help.openai.com/en/articles/20001371-evolving-atlas-into-chatgpt-for-browser-based-agentic-work (403; cited by secondary sources)
- https://help.openai.com/en/articles/20001530-getting-started-with-your-dot (403)
- https://openai.com/index/introducing-dots/ (403) ; https://openai.com/index/devday-2026-recap/ (403)
- https://deploymentsafety.openai.com/gpt-6-astra/evaluations-with-challenging-prompts (dots appendix headings only)
- https://learn.chatgpt.com/docs/environments/cloud-environments , https://learn.chatgpt.com/docs/cloud/internet-access
- https://developers.openai.com/api/docs/guides/tools-web-search
- https://developers.openai.com/api/docs/guides/tools-computer-use , https://developers.openai.com/api/docs/guides/tools-computer-use-integration
- https://developers.openai.com/api/docs/guides/agents-api/tools/computer-use
- https://chromewebstore.google.com/detail/chatgpt/hehggadaopoacecdllhhajmbjkdcmajg (and the CRX package via clients2.google.com/service/update2/crx)
- https://simonwillison.net/2025/Aug/4/chatgpt-agents-user-agent/
- https://www.chrisrcook.com/2025/10/22/chatgpt-atlas-user-agent/
- https://www.aisearchoptimization.in/blog/chatgpt-atlas-user-agent-why-youre-suddenly-seeing-it-in-your-server-logs/
- https://en.wikipedia.org/wiki/ChatGPT_Atlas
- https://blog.tobira.ai/agentic-browser-consolidation-atlas-chatgpt/
- https://the-decoder.com/openai-kills-its-atlas-browser-after-just-eight-months-and-folds-everything-into-chatgpt/
- https://ppc.land/openai-kills-atlas-browser-folds-it-into-new-chatgpt-work-agent/
- https://thenextweb.com/news/openai-dots-always-on-ai-agents-cloud-computers-devday
- https://botcrawl.com/bots/chatgpt-work-cloud-browser/
- https://momenticmarketing.com/blog/ai-search-crawlers-bots (crawler list, checked 2026-10-19)

Anthropic
- https://support.claude.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web-and-how-can-site-owners-block-the-crawler
- https://claude.com/crawling/bots.json
- https://platform.claude.com/docs/en/api/ip-addresses
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-fetch-tool
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/browser-use-tool
- https://platform.claude.com/docs/en/managed-agents/tools-web-restrictions
- https://code.claude.com/docs/en/claude-code-on-the-web , https://code.claude.com/docs/en/cloud-environments
- https://support.claude.com/en/articles/12012173-get-started-with-claude-in-chrome
- https://support.claude.com/en/articles/16607400-use-the-built-in-browser-in-claude-cowork
- https://support.claude.com/en/articles/13065128-claude-in-chrome-admin-controls
- https://chromewebstore.google.com/detail/claude/fcoeoabgfenejglbffodgkkbkcdhcgfn (and the CRX package)
- https://cheq.ai/blog/the-cyborg-session-reversing-detecting-claude-ai-agent-chrome-extension/
- https://simonwillison.net/2025/Sep/10/claude-web-fetch-tool/
- https://github.com/anthropics/claude-code/issues/22846
- https://knownagents.com/agents/claude-searchbot , https://llmpulse.ai/ai-crawler-index/claudebot

Google
- https://developers.google.com/search/docs/crawling-indexing/overview-google-crawlers
- https://developers.google.com/crawling/docs/crawlers-fetchers/google-common-crawlers
- https://developers.google.com/crawling/docs/crawlers-fetchers/google-special-case-crawlers
- https://developers.google.com/crawling/docs/crawlers-fetchers/google-user-triggered-fetchers
- https://developers.google.com/crawling/docs/crawlers-fetchers/verify-google-requests
- https://developers.google.com/crawling/docs/crawlers-fetchers/web-bot-auth
- https://developers.google.com/static/crawling/ipranges/common-crawlers.json , .../special-crawlers.json , .../user-triggered-fetchers.json , .../user-triggered-fetchers-google.json , .../user-triggered-agents.json
- https://agent.bot.goog/.well-known/http-message-signatures-directory
- https://developers.google.com/search/docs/appearance/ai-features
- https://blog.google/technology/ai/io-2025-keynote/
- https://blog.google/technology/google-deepmind/gemini-computer-use-model/
- https://techcrunch.com/2026/01/28/chrome-takes-on-ai-browsers-with-tighter-gemini-integration-agentic-features-for-autonomous-tasks/
- https://www.searchenginejournal.com/google-testing-web-bot-auth-to-verify-ai-agent-requests/573949/
- https://nohacks.co/blog/google-agent-user-agent
- https://knownagents.com/agents/gemini-deep-research (redirect target of darkvisitors.com/agents/gemini-deep-research)
- https://depra.ai/ai-crawlers
- https://ap2-protocol.org/ , https://raw.githubusercontent.com/google-agentic-commerce/AP2/main/docs/ap2/specification.md , https://raw.githubusercontent.com/google-agentic-commerce/AP2/main/docs/ap2/agent_authorization.md

Cross-cutting
- https://datatracker.ietf.org/doc/draft-ietf-webbotauth-httpsig-protocol/
- https://developers.cloudflare.com/bots/reference/bot-verification/web-bot-auth/
- https://developers.cloudflare.com/bots/concepts/bot/verified-bots/categories/
- https://blog.cloudflare.com/web-bot-auth/ (2025-05-15) , https://blog.cloudflare.com/signed-agents/ (2025-08-28)
- https://vercel.com/blog/the-rise-of-the-ai-crawler (2024-12-17)
- Local probes on 2026-10-24: `curl -D -` on both key directories and all feeds; `dig -x` and `whois` on sample addresses from every feed; CRX manifests and bundle greps for both Chrome extensions.
