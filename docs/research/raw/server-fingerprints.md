# Server/edge-side fingerprinting of fetch-library agents, AI crawlers, hosted browsers, and the Web Bot Auth ecosystem (as of 2026-10-24)

Research area: server/edge-side identification signals for the necter edge companion.
Author: research agent (automated), 2026-10-24. Everything below was either (a) fetched from a primary source on 2026-10-24 (URL given) or (b) **measured by us** on 2026-10-24 by running the actual client against a local raw-header capture server and against the public fingerprint oracle `https://tls.peet.ws/api/all` (JA3/JA4/Akamai-h2 computed by that service). Measured items are tagged **[measured]**. Items we could not confirm from a primary source are tagged **[uncertain]** and say what we saw.

Confidence legend: **confirmed** = primary source or direct measurement; **likely** = consistent secondary evidence; **uncertain** = not verified this session.

---

## 0. Executive summary (what matters for implementation)

1. **Web Bot Auth is now an IETF working-group item** (`draft-ietf-webbotauth-httpsig-protocol-00`, 2026-09-01, WG "Web Bot Auth"; the older `draft-meunier-web-bot-auth-architecture-05` and `draft-meunier-http-message-signatures-directory-05` are *replaced*). Wire format: RFC 9421 `Signature-Input` / `Signature` plus `Signature-Agent` (Structured-Field Dictionary of HTTPS URLs, optional `type=directory|jwks_uri|cimd`), `tag="web-bot-auth"`, mandatory `created`+`expires`, `keyid` = base64url JWK SHA-256 thumbprint, Ed25519 keys in a JWKS served at `/.well-known/http-message-signatures-directory` with media type `application/http-message-signatures-directory+json`, the directory itself signed with `tag="http-message-signatures-directory"`. Verification is "the URL you fetched is the identity"; an unresolved `Signature-Agent` is only a claim. (Section 7.)
2. **Who signs today (measured 2026-10-24):** OpenAI `chatgpt.com` (1 Ed25519 key, `"signature_agent":"https://chatgpt.com","purpose":"ai"`), Google `agent.bot.goog` (5 keys, *short non-thumbprint kids*), Meta `www.meta.com` (5 keys, *no kid field*), DuckDuckGo `assistbot.duckduckgo.com`, Browserbase `www.browserbase.com` (2 keys, `"purpose":"rag"`), Hyperbrowser, Kernel, Anchor, Manus, Apify, Exa, You.com, xAI (served from `cursorusercontent.com`), Amazon AgentCore Browser (9 regional `*.keydirectory.signer.<region>.on.aws` hosts), Cloudflare (`search.ai.cloudflare.com`, per-tenant `*.wba-bots.ai-audit.cfdata.org`), PayPal, Shopify, Klaviyo, Spotify, Wappalyzer and ~40 smaller operators — 54–55 of 150 operators in an independent 2026-10-19 survey. **Not signing:** Anthropic (ClaudeBot/Claude-User), Perplexity, Apple, Common Crawl, Mistral, Bing, GPTBot/OAI-SearchBot (only the ChatGPT *agent* signs). Browserless serves a broken directory (wrong media type, zero keys). (Section 7.4.)
3. **Stock fetch libraries are trivially fingerprintable at three layers at once** and the layers disagree with any spoofed browser UA: TLS (OpenSSL vs rustls vs Go vs Java vs GnuTLS vs BoringSSL cipher/extension sets), HTTP/2 (SETTINGS/WINDOW_UPDATE/pseudo-header order — Go has shipped `2:0;4:4194304;…|1073741824|0|a,m,p,s` unchanged since Akamai's 2017 paper; OkHttp still `4:16777216|16711681|0|m,p,a,s`), and HTTP/1.1 header *order* (e.g. `python-requests` always `Host, User-Agent, Accept-Encoding, Accept, Connection`; Node `fetch` always lowercase `host, connection, accept, accept-language: *, sec-fetch-mode: cors, user-agent: node, accept-encoding`). Full measured tables in Section 3.
4. **Several "accidental" tells beat hash matching:** `httpx[http2]` and `undici allowH2` advertise ALPN `http/1.1` *before* `h2` (JA4 ends in `h1` while the connection is h2); Java `HttpClient` and curl-impersonate/`curl_cffi` emit `Upgrade: h2c` + `HTTP2-Settings` on plaintext HTTP (real browsers never do); `curl_cffi` with no impersonation sends Chrome's exact HTTP/2 SETTINGS but **no User-Agent at all**; Node's bundled OpenSSL offers **52 cipher suites**; Scrapy/Twisted and GNU wget send **no ALPN**; Java sends `status_request_v2`; Bun's BoringSSL hello shares Firefox's cipher list hash (`5b57614c22b0`) but is HTTP/1.1-only. JA4 for Node differs between first and resumed TLS connections (`pre_shared_key` adds an extension), so a detector must store both variants.
5. **IP intelligence feeds that exist and were fetched successfully today** (with sizes): AWS (10,684 v4 + 7,005 v6 prefixes), GCP `cloud.json` (1,135), Google crawler/fetcher/agent JSONs (317/272/1,068/504/20 prefixes), Azure Service Tags weekly JSON (4.87 MB, dated 2026-10-19), Oracle (56 regions), DigitalOcean/Linode/Vultr RFC 8805 geofeeds, Cloudflare/Fastly proxy ranges, iCloud Private Relay egress CSV (285,106 rows), OpenAI (gptbot 18 / searchbot 39 / chatgpt-user 234 / adsbot 2 prefixes), Anthropic `claude.com/crawling/bots.json` (14), Perplexity (8 + 4), Bing (28), Applebot (24), CCBot (`index.commoncrawl.org/ccbot.json`), Amazonbot (1,292 v4 prefixes embedded in its HTML page). Hetzner/OVH/Alibaba/Tencent publish no first-party list; use ASN prefix sets (ipverse per-ASN files verified). **JA4DB is no longer a free download** (ja4db.com → ja4db.foxio.io, `/api/read/` returns 404, signup required), so we must build our own fingerprint DB — Section 3 is the seed. (Sections 5–6.)
6. **Policy/licensing signals an agent firewall must parse and can use as behavioural probes:** Cloudflare Pay-Per-Crawl 402 flow (`crawler-price`, `crawler-exact-price`, `crawler-max-price`, `crawler-charged`, `crawler-error`; payment headers must be covered by `Signature-Input`), RSL 1.0 (`License:` robots directive, `Link: <…>; rel="license"; type="application/rsl+xml"`), IETF aipref (`Content-Usage: train-ai=n` header and robots rule; vocab tokens `train-ai`, `ai-use`, `search`), Cloudflare Content Signals (`Content-Signal: search=yes, ai-train=no`), W3C TDMRep (`tdm-reservation: 1`, `/.well-known/tdmrep.json`), DeviantArt `noai`/`noimageai`, `llms.txt`. (Section 8.)
7. **Payments identity layers** that will show up in requests: Visa Trusted Agent Protocol (RFC 9421 signatures with tags `agent-browser-auth` and `agent-payer-auth`, components `@authority` `@path`, sample uses `keyId` spelling and `rsa-pss-sha256`), OpenAI/Stripe Agentic Commerce Protocol (headers `Authorization`, `Accept-Language`, `User-Agent: ChatGPT/2.0 (…)`, `Idempotency-Key`, `Request-Id`, `Signature`, `Timestamp`, `API-Version: 2025-09-12`), Google AP2 (signed Intent/Checkout/Payment mandates over A2A/MCP/UCP, no HTTP header spec). Mastercard Agent Pay docs were not reachable (403/404) → uncertain. (Section 9.)
8. **Request-pattern facts with numbers:** none of the major AI crawlers execute JavaScript (Vercel, 2024-12); ChatGPT fetches are 57.70% HTML / 11.50% JS, Claude 35.17% images / 23.84% JS; 404 rates 34.82% (ChatGPT) and 34.16% (Claude) vs 8.22% Googlebot; Cloudflare documented Perplexity's undeclared crawler using UA `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36` across rotating ASNs at 3–6 M requests/day. (Section 10.)

---

## 1. Methodology for the measured values

- Date: 2026-10-24. Oracle: `https://tls.peet.ws/api/all` (returns `tls.ja3_hash`, `tls.ja4`, `tls.ja4_r`, cipher/extension lists, `http2.akamai_fingerprint`, sent HTTP/2 frames, HTTP/1.1 header list in wire order). Raw HTTP/1.1 header order was captured independently with a 20-line asyncio TCP server that logs request bytes verbatim (so ordering/casing below is exactly what was on the wire, not what a parser normalised).
- Clients run on macOS 15 arm64 (Homebrew Python 3.13.16 + OpenSSL 3.5.9; Node 22.23.3 (OpenSSL 3.5.8, undici 6.28.1) and 24.16.0 (OpenSSL 3.5.6, undici 7.25.0); Go 1.26.5; Rust 1.96 + reqwest 0.12.28/rustls 0.23.46/hyper 1.12.0/h2 0.4.20; Deno 2.9.8; Bun 1.4.4; Apple curl 8.7.1 (SecureTransport)) and in Docker Linux containers (python:3.12-slim → Python 3.12.13 + OpenSSL 3.5.6; debian:bookworm-slim → curl 7.88.1/OpenSSL 3.0.22, GNU Wget 1.21.3/GnuTLS; eclipse-temurin:21 → OpenJDK 21.0.12.1, OkHttp 4.12.0).
- Library versions: requests 2.34.2, urllib3 2.8.0, httpx 0.28.1 (+h2), aiohttp 3.14.5, Scrapy 2.19.0, curl_cffi 0.16.3, node-fetch 3.3.2, axios 1.20.0, got 14.6.6, undici (npm) 7.30.1.
- Caveats: (1) Python/curl TLS fingerprints depend on the OpenSSL build (we give both macOS-Homebrew and Debian values; Debian stable ships OpenSSL 3.0 which lacks `X25519MLKEM768` and `compress_certificate`, so cipher hash `ab0a1bf427ad` is stable across builds but the extension hash varies). (2) Go, Node, rustls (reqwest/Deno), Bun (BoringSSL) and Java bundle their own TLS stack, so their values are platform-independent for a given runtime version. (3) JA4 extension hashes change when a client resumes a session (`pre_shared_key` 0x0029 is added) — we observed this for Node and Java; keep both. (4) The oracle labels extension 65281 as "boringssl renegotiation_info"; it is just `renegotiation_info`.

---

## 2. Fingerprint formats (reference)

### 2.1 JA3 (legacy)
MD5 of `TLSVersion,Ciphers,Extensions,EllipticCurves,EllipticCurvePointFormats` in ClientHello order (GREASE removed). Order-sensitive, so Chrome's extension-order randomisation (since Chrome 110) splits Chrome into many JA3s. Still widely logged (Cloudflare `cf.bot_management.ja3_hash`). Source: FoxIO JA4 docs below contrast it; Cloudflare field reference §4.

### 2.2 JA4 (FoxIO) — primary TLS fingerprint
Spec: https://raw.githubusercontent.com/FoxIO-LLC/ja4/main/technical_details/JA4.md (fetched). Format `a_b_c`, example `t13d1516h2_8daaf6152771_e5627efa2ab1`:
- `a` (10 chars): protocol `t` (TCP) / `q` (QUIC) / `d` (DTLS); TLS version from `supported_versions` highest non-GREASE (`13`, `12`, …, `00` unknown); `d` if SNI present, `i` if not; 2-digit non-GREASE cipher count (capped 99); 2-digit non-GREASE extension count (SNI and ALPN *are* counted); first+last char of the **first** ALPN value (`h2`, `h1` for `http/1.1`, `00` when no ALPN; hex if non-alphanumeric).
- `b` (12 chars): truncated SHA-256 of the **sorted** 4-hex cipher codes joined by `,`; `000000000000` if none.
- `c` (12 chars): truncated SHA-256 of the sorted extension codes **excluding** SNI (`0000`) and ALPN (`0010`), then `_` and the signature-algorithm codes **in original order**.
- `JA4_r` = raw unhashed lists; `JA4_o` keeps original order (includes 0000/0010). Because extensions are sorted, JA4 is stable under Chrome's randomisation.

### 2.3 JA4H (HTTP client fingerprint)
Source file https://github.com/FoxIO-LLC/ja4/blob/main/technical_details/JA4H.md is mostly an image; the only text we could extract is the header-count rule: "2 digit number of headers, not counting Cookie and Referer. For 3 headers the value is "03". If there are more than 99, the output is 99." **[uncertain beyond that]**: our recollection of the format is `[method 2][version 2][cookie c/n][referer r/n][header count 2][accept-language first 4]_[sha256-12 of header names in order excl. Cookie/Referer]_[sha256-12 of sorted cookie names]_[sha256-12 of sorted cookie name=value]` (e.g. `ge11cr20enus_…`). Verify against the image before implementing; our own header-order fingerprint (Section 3.4) does not depend on JA4H.

### 2.4 Akamai HTTP/2 fingerprint
Primary source: Akamai white paper "Passive Fingerprinting of HTTP/2 Clients" (Segal, Fridman, Shuster, 06/2017), PDF read directly: https://www.blackhat.com/docs/eu-17/materials/eu-17-Shuster-Passive-Fingerprinting-Of-HTTP2-Clients-wp.pdf
- Format `S[;]|WU|P[,]#|PS[,]` → in practice written `SETTINGS|WINDOW_UPDATE|PRIORITY|PSEUDO_ORDER`:
  - `S`: `key:value` pairs from the client's first SETTINGS frame, **in the order sent**, joined by `;` (keys: 1 HEADER_TABLE_SIZE, 2 ENABLE_PUSH, 3 MAX_CONCURRENT_STREAMS, 4 INITIAL_WINDOW_SIZE, 5 MAX_FRAME_SIZE, 6 MAX_HEADER_LIST_SIZE; also 8 ENABLE_CONNECT_PROTOCOL, 9 NO_RFC7540_PRIORITIES seen today).
  - `WU`: increment of the connection-level WINDOW_UPDATE sent after SETTINGS; `00`/`0` if absent.
  - `P`: PRIORITY frames as `StreamID:Exclusive:DependentStreamID:Weight` joined by `,`; `0` if none.
  - `PS`: pseudo-header order letters `m` (:method) `a` (:authority) `s` (:scheme) `p` (:path).
- Paper's reference values (2017): Chrome 58 `1:65536;3:1000;4:6291456|15663105|0`; Edge 14 `3:1024;4:10485760|10420225|0`; OkHttp 3.6.0 `4:16777216|16711681|0`; Firefox 53 `1:65536;4:131072;5:16384|12517377|3:0:0:201,5:0:0:101,7:0:0:1,9:0:7:1,11:0:3:1|m,p,a,s`; Go-http-client/2.0 `2:0;4:4194304;6:10485760|1073741824|0`; curl 7.54 `3:100;4:1073741824;2:0|1073676289|0`; nghttp2 1.22 `3:100;4:65535|00|3:0:0:201,…`. Pseudo-header orders: Chrome `m,a,s,p`; Firefox `m,p,a,s`; Safari 10 `m,s,p,a`; curl 7.54 `m,p,s,a`; Go `a,m,p,s`; Jetty `s,m,a,p`.

### 2.5 HTTP/1.1 header-order fingerprint
Not standardised; we use the ordered list of header names (case preserved) plus the exact `Accept-Encoding`, `Accept`, `Connection` values (Section 3.4). Vercel's "bot protection" ruleset explicitly "prevents requests that falsely claim to be from a browser such as a `curl` request identifying as Chrome" (https://vercel.com/docs/bot-management), i.e. the same class of check.

### 2.6 Cloudflare's exposed fields (what the market baseline looks like)
From https://developers.cloudflare.com/ruleset-engine/rules-language/fields/dynamic-fields/ : `cf.bot_management.score` (1–99), `cf.bot_management.verified_bot`, `cf.verified_bot_category`, `cf.bot_management.ja3_hash`, `cf.bot_management.ja4`, `cf.bot_management.js_detection.passed`, `cf.bot_management.detection_ids`, `cf.bot_management.static_resource`, `cf.bot_management.corporate_proxy`, `cf.client.bot`, `cf.waf.score`. JA4 "Signals" (https://developers.cloudflare.com/bots/additional-configurations/ja3-ja4-fingerprint/signals-intelligence/) are per-JA4, 1-hour aggregates: `h2h3_ratio_1h`, `heuristic_ratio_1h`, `reqs_quantile_1h`, `uas_rank_1h`, `browser_ratio_1h`, `paths_rank_1h`, `reqs_rank_1h`, `cache_ratio_1h`, `ips_rank_1h`, `ips_quantile_1h` (not usable in WAF rules; exposed to Workers). **Implementation hook:** replicate these per-fingerprint aggregates (and add per-ASN and per-`Signature-Agent` versions) — a JA4 that is seen with many distinct UAs or an absurd paths/IP spread is automation regardless of hash.

---

## 3. Measured fingerprint tables per client library

All rows **[measured 2026-10-24]** unless marked. "h2?" = did the client negotiate HTTP/2 by default against an h2-capable origin.

### 3.1 TLS fingerprints (JA3 hash, JA4, distinguishing ClientHello features)

| Client (version, TLS stack, platform) | h2? | JA3 hash | JA4 | Cipher/ext counts, ALPN, notable tells |
|---|---|---|---|---|
| python-requests 2.34.2 / urllib3 2.8.0 — CPython 3.12 + OpenSSL 3.5.6, **Debian Linux** | no (HTTP/1.1 only) | `86dab2109182b6bbaa644647d7db2997` | `t13d1713h1_ab0a1bf427ad_8537cf56674e` | 17 ciphers, 13 ext, ALPN `http/1.1`. Ext set: renegotiation_info, SNI, ec_point_formats, supported_groups, ALPN, encrypt_then_mac(22), extended_master_secret, **post_handshake_auth(49)**, sigalgs, supported_versions, psk_kex_modes, key_share, compress_certificate(27). **No session_ticket** (urllib3 disables tickets) — this is how requests/urllib3 differ from httpx/aiohttp. Groups start `X25519MLKEM768, X25519, P-256, X448, P-384, P-521, ffdhe2048, ffdhe3072`. |
| python-requests 2.34.2 — CPython 3.13 + OpenSSL 3.5.9, **macOS Homebrew** | no | `7291ea5e449f2c7b17582541703e549d` | `t13d1712h1_ab0a1bf427ad_882d495ac381` | Same as above minus compress_certificate (12 ext). Identical values for direct `urllib3.PoolManager`. |
| httpx 0.28.1 (HTTP/1.1 default) — CPython 3.13/OpenSSL 3.5.9 | no by default | `37f7d09ced1a845dc48872abc1a29d7b` | `t13d1712h1_ab0a1bf427ad_8e6e362c5eac` | 17 ciphers, 12 ext; has **session_ticket(35)**, **no post_handshake_auth** (ssl.create_default_context defaults). |
| httpx 0.28.1 with `http2=True` (h2 lib) | **yes** | same `37f7d09c…` | `t13d1712h1_ab0a1bf427ad_8e6e362c5eac` | ALPN list is **`['http/1.1', 'h2']`** — http/1.1 first, so JA4 ends `h1` even though h2 is negotiated. Strong tell: "JA4 says h1, connection is h2". |
| aiohttp 3.14.5 | no | `37f7d09ced1a845dc48872abc1a29d7b` | `t13d1712h1_ab0a1bf427ad_8e6e362c5eac` | **Identical TLS fingerprint to httpx** (both use `ssl.create_default_context()`); disambiguate by headers (3.4). |
| urllib (stdlib) — CPython 3.13 macOS / 3.12 Linux | no | `a1ebe7f90a577e9399eaa60be3c67721` / `ebed420a5a445535c05da9e8349f4e4a` | `t13d1713h1_ab0a1bf427ad_89ab6efea773` / `t13d1714h1_ab0a1bf427ad_5ae85263eb3b` | Has **both** session_ticket and post_handshake_auth (13/14 ext). |
| Scrapy 2.19.0 (Twisted + pyOpenSSL, OpenSSL 3.5.9) | no (HTTP/1.1 handler default; `HTTPX_HTTP2_ENABLED = False`) | `33ae362844509ccb28660da3cbfca03d` | `t13d3010_1d37bd780c83_3550537cd59b` | **30 ciphers, no ALPN (`00`)**, only 10 ext, **SNI sent last** in the extension list, supported_groups includes `SM2 (41)` and ML-KEM hybrids 4587/4590 (raw OpenSSL defaults, not Python's). |
| Node 22.23.3 / 24.16.0 built-in `fetch` (undici, bundled OpenSSL 3.5.x) | no (undici default HTTP/1.1) | `d67b094811e5145139d7cea5f014309f` | `t13d5212h1_b262b3658495_8e6e362c5eac` | **52 cipher suites** (Node's default OpenSSL list incl. DHE/CBC suites) → cipher hash `b262b3658495` is a "Node.js TLS" marker. 12 ext incl. session_ticket, encrypt_then_mac; no post_handshake_auth. Identical on Node 22 and 24. |
| Node `https.get` (no ALPN) | no | `944d1e1858cd278718f8a46b65d3212f` | `t13d5211_b262b3658495_8e6e362c5eac` | No ALPN extension at all → `t13d5211` (11 ext). |
| node-fetch 3.3.2 / axios 1.20.0 / got 14.6.6 (all via node `https` Agent, **resumed session**) | no | `3071e91916919685206127280b6af9bf` | `t13d5212_b262b3658495_66863fb0a24c` | Same stack as above but the second connection carried `pre_shared_key(41)` → extension count 12 and different `c` hash. Keep both the fresh and resumed variants in the DB. |
| undici 7.30.1 (npm) on Node 22 | no | `30490d79325943f1ebf6750aae4e304c` | `t13d5213h1_b262b3658495_66863fb0a24c` | ALPN + PSK (13 ext). On Node 24: `t13d5212h1_b262b3658495_8e6e362c5eac`. |
| undici `new Agent({allowH2:true})` | **yes** | `d67b094811e5145139d7cea5f014309f` | `t13d5212h1_b262b3658495_8e6e362c5eac` | ALPN **`['http/1.1','h2']`** (http/1.1 first) → same "h1 JA4 on an h2 connection" tell as httpx. |
| got 14 with `http2: true` (node:http2) | yes | `d67b094811e5145139d7cea5f014309f` | `t13d5212h2_b262b3658495_8e6e362c5eac` | ALPN `h2` first (node core http2). |
| Go 1.26.5 `net/http` (crypto/tls) | **yes** | `03117a8ed39ef02427ebbc39f121275c` | `t13d1312h2_f57a46bbacb6_ab7e3b40a677` | 13 ciphers (incl. 3 CBC-SHA suites, no DHE), 12 ext: SNI, ec_point_formats, renegotiation_info, extended_master_secret, **SCT(18)**, status_request, supported_groups, sigalgs, **signature_algorithms_cert(50)**, ALPN, supported_versions, key_share. **No session_ticket, no psk_kex_modes.** Groups: `X25519MLKEM768, 4587, 4589, X25519, P-256, P-384, P-521` (4587/4589 = SecP256r1MLKEM768 / SecP384r1MLKEM1024 — new in Go 1.26 **[likely]**). |
| Go with `GODEBUG=http2client=0` | no | `9b7dcdf3f997f1fb7b4409c94cb7ef36` | `t13d1311_f57a46bbacb6_ab7e3b40a677` | **No ALPN at all** when h2 is disabled (UA becomes `Go-http-client/1.1`). |
| Rust reqwest 0.12.28 + rustls 0.23.46 (hyper 1.12, h2 0.4.20) | **yes** | `bedb4cc6143de62715afa3acf4fef9a8` | `t13d1011h2_61a7ad8aa9b6_3fcd1a44f3e3` | **10 ciphers**, 11 ext (SNI, ec_point_formats, sigalgs, session_ticket, supported_versions, ALPN, supported_groups, psk_kex_modes, status_request, extended_master_secret, key_share). Cipher hash `61a7ad8aa9b6` = rustls default list (shared with Deno). |
| Deno 2.9.8 `fetch` (rustls) | **yes** | `23c757883fb1ec2a2dc3b41d29c9959c` | `t13d1011h2_61a7ad8aa9b6_f9531d972513` | Same ciphers as reqwest; `c` differs (sigalg list differs). |
| Bun 1.4.4 `fetch` (BoringSSL) | **no** (HTTP/1.1 only; `http_version` returned `HTTP/1.1`) | `1523504b38f0fae0d881d4b6554aac1b` | `t13d1713h1_5b57614c22b0_7f527383e249` | 17 ciphers; cipher hash `5b57614c22b0` is the same as Firefox's (curl_cffi `firefox` profile) — do not use the `b` section alone. 13 ext incl. status_request, SCT, psk_kex_modes; **no GREASE** (real Chrome/Safari always GREASE). |
| curl 7.88.1 — OpenSSL 3.0.22, **Debian bookworm** | **yes** | `0149f47eabf9a20d0893e2a44e5a6323` | `t13d3112h2_e8f1e7e78f70_b26ce05bbdd6` (`--http1.1`: `t13d3112h1_…`) | 31 ciphers, 12 ext incl. **padding(21)**, post_handshake_auth, encrypt_then_mac; `supported_versions` advertises TLS 1.3/1.2/**1.1/1.0**; ffdhe2048…8192. The `c` hash `b26ce05bbdd6` also appears in third-party listings for Python-on-OpenSSL-3.0, i.e. it identifies the OpenSSL 3.0 build more than the app. |
| curl 8.7.1 — Apple SecureTransport/LibreSSL 3.3.6, macOS | **yes** | `375c6162a492dfbf2795909110ce8424` | `t13d497h2_0d8feac7bc37_7395dae3b2f3` (`--http1.1`: `t13d497h1_…`) | 49 ciphers, only 7 ext (no session_ticket/psk/ems). macOS-specific; Linux curl differs (row above). |
| GNU Wget 1.21.3 — GnuTLS, Debian | no (HTTP/1.1 only) | `bb4f9fef542ff6b4b29aa653bf0c1d31` | `t13d2913_723694b0fccc_899037bd0b8c` | **No ALPN**, 29 ciphers incl. `TLS_AES_128_CCM_SHA256 (1304)` and `*_CCM` suites (GnuTLS tell), groups ordered `P-256, P-384, P-521, X25519, X448, ffdhe…`, ext incl. record_size_limit(28), padding. |
| Java 21.0.12.1 `java.net.http.HttpClient` (JSSE) | **yes** (HTTP_2 default) | `bddb16608b241c89053080cf80771423` | `t13d3113h2_1d947a95fc68_7e1102d2036b` | 31 ciphers; ext incl. **status_request_v2(17)** (JSSE-only), signature_algorithms_cert, session_ticket; no renegotiation_info. Forced HTTP/1.1 (resumed): `57128db24fb3c2fc035d6a39ccb08cac` / `t13d3113_1d947a95fc68_d6a918353cf0` (no ALPN, PSK present). |
| Java 21 `HttpURLConnection` | no | `57128db24fb3c2fc035d6a39ccb08cac` | `t13d3113_1d947a95fc68_d6a918353cf0` | Same JSSE hello (no ALPN). |
| OkHttp 4.12.0 on JDK 21 | **yes** | `2ca8118b4937369765242b3fbbc2afcf` | `t13d1114h2_5e2a75874763_89e9e4bb3419` | OkHttp's restricted **11-cipher** list (3 TLS1.3 + 8 ECDHE GCM/CHACHA), 14 ext incl. status_request_v2 + renegotiation_info. |
| curl_cffi 0.16.3, **no `impersonate`** (bundled curl-impersonate libcurl/BoringSSL) | **yes** | `35c61a611436bd206b042c36810d36ad` | `t13d2712h2_b4f9224df7c1_cbb9361b6bf9` | 27 ciphers, 12 ext incl. padding(21), no GREASE, groups only `X25519, P-256, P-384`. Sends **Chrome's HTTP/2 SETTINGS** but **no User-Agent header** (see 3.2/3.4) — a unique combination. |
| curl_cffi `impersonate="chrome"` (→ Chrome 150 profile) | yes | `843ef3f09ec995bdba386dccc6041b99` | `t13d1516h2_8daaf6152771_806a8c22fdea` | GREASE, ECH(65037), ALPS(17613), compress_certificate, `X25519MLKEM768` — looks like Chrome at TLS+h2 layers; see 3.5 for the remaining tells. |
| curl_cffi `impersonate="safari"` (Safari 26.0.1 profile) | yes | `ecdf4f49dd59effc439639da29186671` | `t13d2013h2_a09f3c656075_7f0f34a4126d` | GREASE, 21 ciphers incl. 3DES/CBC legacy suites, no session_ticket. |
| curl_cffi `impersonate="firefox"` (Firefox 147 profile) | yes | `6f7889b9fb1a62a9577e685c1fcfa919` | `t13d1717h2_5b57614c22b0_3cbfd9057e0d` | delegated_credentials(34), record_size_limit(28), ECH; no GREASE (Firefox doesn't GREASE); `priority` frames absent (see 3.2). |

**Cross-row observations.**
- Cipher-hash `b` sections identify the TLS *library*: `ab0a1bf427ad` = CPython `ssl` module on OpenSSL 3.x (all of requests/urllib3/httpx/aiohttp/urllib on both macOS and Debian); `b262b3658495` = Node.js bundled OpenSSL; `f57a46bbacb6` = Go crypto/tls (1.26); `61a7ad8aa9b6` = rustls 0.23 (reqwest, Deno); `1d947a95fc68` = JSSE (Java 21) ; `5e2a75874763` = OkHttp 4 restricted list; `723694b0fccc` = GnuTLS (wget); `e8f1e7e78f70` = Debian curl/OpenSSL 3.0 default; `0d8feac7bc37` = Apple SecureTransport curl.
- Extension hash `c` sections separate *apps* on the same library (requests vs httpx vs urllib) through session_ticket / post_handshake_auth / compress_certificate toggles — but they also move with the OpenSSL version and with session resumption, so store multiple `c` values per app and treat `a`+`b` as the stable core.
- None of the libraries sends GREASE values; every real Chrome/Edge/Safari/Opera ClientHello does (Firefox does not). A UA claiming Chrome/Safari with a GREASE-free hello is spoofed.

### 3.2 HTTP/2 Akamai fingerprints and pseudo-header order

| Client | Akamai fingerprint (SETTINGS\|WINDOW_UPDATE\|PRIORITY\|pseudo-order) | Notes |
|---|---|---|
| httpx 0.28.1 (python `h2` library) | `1:4096;2:0;4:65535;5:16384;3:100;6:65536\|16777216\|0\|m,a,s,p` | SETTINGS keys sent out of numeric order (…5,3,6) — h2-lib tell. Pseudo-order matches Chrome, SETTINGS do not. |
| Go 1.26.5 net/http | `2:0;4:4194304;5:16384;6:10485760\|1073741824\|0\|a,m,p,s` | Akamai 2017 listed Go as `2:0;4:4194304;6:10485760\|1073741824\|0` — only `5:16384` was added in 9 years. `:authority` first is unique to Go and Java (and undici). Request headers on h2: `accept-encoding: gzip`, `user-agent: Go-http-client/2.0`. |
| Rust reqwest/hyper/h2 0.4 | `2:0;4:2097152;5:16384;6:16384\|5177345\|0\|m,s,a,p` | Headers: `accept: */*`, `accept-encoding: zstd,gzip,deflate,br` (no spaces), **no user-agent**. |
| Deno 2.9.8 (hyper/h2) | `2:0;4:2097152;5:16384;6:262144\|5177345\|0\|m,s,a,p` | Same WINDOW_UPDATE as reqwest; MAX_HEADER_LIST_SIZE 262144 distinguishes Deno. Headers: `accept: */*`, `accept-language: *`, `user-agent: Deno/2.9.8`, `accept-encoding: gzip,br`. |
| Node `got` http2 (node:http2 core) | `2:0;4:33554432\|4128769\|0\|m,p,a,s` | Also sends an empty SETTINGS (ack) frame immediately. |
| Node undici `allowH2` | `2:0;4:262144\|458753\|0\|a,m,p,s` | Headers: `accept: */*`, `accept-language: *`, `sec-fetch-mode: cors`, `user-agent: undici`, `accept-encoding: br, gzip, deflate`. |
| Java 21 HttpClient | `1:16384;2:0;3:0;4:16777216;5:16384;6:393216\|33488897\|0\|a,m,p,s` | **`MAX_CONCURRENT_STREAMS = 0`** — unique. Only header sent on h2: `user-agent: Java-http-client/21.0.12.1` (no accept, no accept-encoding). |
| OkHttp 4.12.0 | `4:16777216\|16711681\|0\|m,p,a,s` | Byte-identical to Akamai's 2017 OkHttp 3.6.0 value. Headers: `accept-encoding: gzip`, `user-agent: okhttp/4.12.0`. |
| curl 7.88.1 (Debian, nghttp2 1.52) | `3:100;4:33554432;2:0\|33488897\|0\|m,p,s,a` | Header order `user-agent`, `accept`. |
| curl 8.7.1 (macOS, nghttp2 1.68) | `3:100;4:10485760;2:0\|1048510465\|0\|m,s,a,p` | Pseudo-order changed from `m,p,s,a` (≤7.88) to `m,s,a,p` (8.x) **[measured; curl source not re-verified]**. |
| curl_cffi default (no impersonation) | `1:65536;2:0;4:6291456;6:262144\|15663105\|0\|m,a,s,p` + a second SETTINGS frame `4:1048576` | Chrome's SETTINGS/WINDOW_UPDATE with no browser headers and no UA. |
| curl_cffi chrome (150) | `1:65536;2:0;4:6291456;6:262144\|15663105\|0\|m,a,s,p` | HEADERS frame priority `weight 256, depends_on 0, exclusive 1`; header set includes `sec-ch-ua`, `priority: u=0, i`. |
| curl_cffi safari (26.0.1) | `2:0;3:100;4:2097152;9:1\|10420225\|0\|m,s,a,p` | `9:1` = `SETTINGS_NO_RFC7540_PRIORITIES` (Safari/WebKit tell). |
| curl_cffi firefox (147) | `1:65536;2:0;4:131072;5:16384\|12517377\|0\|m,p,a,s` | Real Firefox historically sends 5 PRIORITY frames (`3:0:0:201,5:0:0:101,7:0:0:1,9:0:7:1,11:0:3:1`); this profile sends none (`0`). Whether Firefox 147 still sends them is **[uncertain]** — measure real Firefox before using as a tell. |
| Chrome (reference, Akamai 2017 + curl_cffi profile) | `1:65536;2:0;4:6291456;6:262144\|15663105\|0\|m,a,s,p` | Chrome dropped `3:1000` and added `6:262144` since 2017. |

Pseudo-header order quick map: `m,a,s,p` Chrome/Chromium, httpx, curl_cffi-chrome · `m,p,a,s` Firefox, OkHttp, node:http2 · `m,s,a,p` Safari/WebKit, curl ≥ 8, hyper (reqwest, Deno) · `m,p,s,a` curl ≤ 7.88 · `a,m,p,s` Go, Java HttpClient, undici · `s,m,a,p` Jetty (2017).

### 3.3 HTTP version usage per library (default behaviour)

| Library | Default | How to get h2/h3 |
|---|---|---|
| python-requests / urllib3 | HTTP/1.1 only | not supported |
| httpx | HTTP/1.1 | `httpx.Client(http2=True)` (needs `h2` extra) — then ALPN `http/1.1,h2` |
| aiohttp | HTTP/1.1 only | not supported |
| urllib / http.client | HTTP/1.1 | no |
| Scrapy | HTTP/1.1 (`HTTP11DownloadHandler`) | experimental H2 handler; `HTTPX_HTTP2_ENABLED = False` by default |
| Node fetch/undici | HTTP/1.1 | `new Agent({allowH2: true})` |
| node-fetch, axios | HTTP/1.1 | axios 1.x has an `httpVersion: 2` option (`http2Transport`), default 1, and rejects h2 with a proxy |
| got | HTTP/1.1 | `http2: true` (ALPN choice via node:http2) |
| Bun fetch | HTTP/1.1 (measured) | docs mention `:authority` over HTTP/2 and a `protocol: "http3"` option; negotiation not documented **[uncertain]** |
| Deno fetch | **h2 via ALPN** (measured) | — |
| Go net/http | **h2 via ALPN** for https (measured); `Go-http-client/2.0` UA | `GODEBUG=http2client=0` disables |
| Rust reqwest | **h2 via ALPN** (default feature) | `http2_prior_knowledge()`, http3 feature |
| Java HttpClient | **HTTP/2 preferred**, falls back; on plaintext sends `Upgrade: h2c` | `.version(HTTP_1_1)` |
| HttpURLConnection | HTTP/1.1 | — |
| OkHttp | **h2 via ALPN** | — |
| curl | **h2 via ALPN** when built with nghttp2 (both tested builds) | `--http1.1`, `--http3` |
| wget 1.x | HTTP/1.1 | wget2 supports h2 (not tested) |
| curl_cffi / curl-impersonate | h2 (profiles), h3 optional (`--http3`) | — |
| tls-client (bogdanfinn) | h2 (utls + custom h2 settings) | — |

### 3.4 HTTP/1.1 default header sets and exact wire order (captured raw)

Format: `request-line || header1 | header2 | …` exactly as received over plaintext HTTP/1.1 (TLS requests showed identical ordering in the oracle's `http1.headers`).

```
python-requests 2.34.2   GET / HTTP/1.1 || Host: … | User-Agent: python-requests/2.34.2 | Accept-Encoding: gzip, deflate[, br][, zstd] | Accept: */* | Connection: keep-alive
httpx 0.28.1             GET / HTTP/1.1 || Host: … | Accept: */* | Accept-Encoding: gzip, deflate[, br][, zstd] | Connection: keep-alive | User-Agent: python-httpx/0.28.1
aiohttp 3.14.5           GET / HTTP/1.1 || Host: … | Accept: */* | Accept-Encoding: gzip, deflate[, br][, zstd] | User-Agent: Python/3.13 aiohttp/3.14.5
urllib (3.9/3.12/3.13)   GET / HTTP/1.1 || Accept-Encoding: identity | Host: … | User-Agent: Python-urllib/3.13 | Connection: close
urllib3 2.8.0 (direct)   GET / HTTP/1.1 || Host: … | Accept-Encoding: identity | User-Agent: python-urllib3/2.8.0
Scrapy 2.19.0            GET / HTTP/1.1 || Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8 | Accept-Language: en | User-Agent: Scrapy/2.19.0 (+https://scrapy.org) | Accept-Encoding: gzip, deflate, br, zstd | Host: …
Node 22/24 fetch (http)  GET / HTTP/1.1 || host: … | connection: keep-alive | accept: */* | accept-language: * | sec-fetch-mode: cors | user-agent: node | accept-encoding: gzip, deflate
Node fetch (https)       …same but accept-encoding: br, gzip, deflate, zstd (undici appends zstd only on https; Node 22/24 bundled undici produced "br, gzip, deflate")
undici 7.30.1 (npm)      GET / HTTP/1.1 || host: … | connection: keep-alive | accept: */* | accept-language: * | sec-fetch-mode: cors | user-agent: undici | accept-encoding: gzip, deflate
node:http(s).get         GET / HTTP/1.1 || Host: … | Connection: keep-alive            (no UA, no Accept)
node-fetch 3.3.2         GET / HTTP/1.1 || accept: */* | accept-encoding: gzip, deflate, br | user-agent: node-fetch | Host: … | Connection: keep-alive
axios 1.20.0             GET / HTTP/1.1 || Accept: application/json, text/plain, */* | User-Agent: axios/1.20.0 | Accept-Encoding: gzip, compress, deflate, br | Host: … | Connection: keep-alive
got 14.6.6               GET / HTTP/1.1 || user-agent: got (https://github.com/sindresorhus/got) | accept-encoding: gzip, deflate, br, zstd | Host: … | Connection: keep-alive      (.json() adds accept: application/json)
Bun 1.4.4 fetch          GET / HTTP/1.1 || Connection: keep-alive | User-Agent: Bun/1.4.4 | Accept: */* | Host: … | Accept-Encoding: gzip, deflate, br, zstd
Deno 2.9.8 fetch         GET / HTTP/1.1 || accept: */* | accept-language: * | user-agent: Deno/2.9.8 | accept-encoding: gzip,br | host: …
Go 1.26 net/http         GET / HTTP/1.1 || Host: … | User-Agent: Go-http-client/1.1 | Accept-Encoding: gzip
Rust reqwest 0.12        GET / HTTP/1.1 || accept: */* | accept-encoding: zstd,gzip,deflate,br | host: …          (no User-Agent)
curl 7.88 / 8.7          GET / HTTP/1.1 || Host: … | User-Agent: curl/7.88.1 | Accept: */*        (--compressed adds Accept-Encoding: deflate, gzip, br, zstd)
GNU Wget 1.21.3          GET / HTTP/1.1 || Host: … | User-Agent: Wget/1.21.3 | Accept: */* | Accept-Encoding: identity | Connection: Keep-Alive
Java 21 HttpClient(http) GET / HTTP/1.1 || Connection: Upgrade, HTTP2-Settings | Host: … | HTTP2-Settings: AAEAAEAAAAIAAAAAAAMAAAAAAAQBAAAAAAUAAEAAAAYABgAA | Upgrade: h2c | User-Agent: Java-http-client/21.0.12.1
Java 21 HttpClient(https, h1.1) || Host: … | User-Agent: Java-http-client/21.0.12.1          (no Accept at all)
Java 21 HttpURLConnection GET / HTTP/1.1 || User-Agent: Java/21.0.12.1 | Host: … | Accept: */* | Connection: keep-alive   (UA before Host)
OkHttp 4.12.0            GET / HTTP/1.1 || Host: … | Connection: Keep-Alive | Accept-Encoding: gzip | User-Agent: okhttp/4.12.0
curl_cffi 0.16.3 default GET / HTTP/1.1 || Host: … | Accept-Encoding: gzip, deflate, br          (no UA, no Accept)
curl_cffi chrome (http)  GET / HTTP/1.1 || Host: … | Upgrade: h2c | HTTP2-Settings: AAEAAQAAAAIAAAAAAAQAYAAAAAYABAAA | sec-ch-ua: "Not;A=Brand";v="8", "Chromium";v="150", "Google Chrome";v="150" | sec-ch-ua-mobile: ?0 | sec-ch-ua-platform: "macOS" | Upgrade-Insecure-Requests: 1 | User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36 | Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7 | Sec-Fetch-Site: none | Sec-Fetch-Mode: navigate | Sec-Fetch-User: ?1 | Sec-Fetch-Dest: document | Accept-Encoding: gzip, deflate, br, zstd | Accept-Language: en-US,en;q=0.9 | Connection: Upgrade, HTTP2-Settings
curl_cffi safari (http)  GET / HTTP/1.1 || Host: … | Upgrade: h2c | HTTP2-Settings: AAIAAAAAAAMAAABkAAQAIAAAAAkAAAAB | sec-fetch-dest: document | user-agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0.1 Safari/605.1.15 | accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8 | sec-fetch-site: none | sec-fetch-mode: navigate | accept-language: en-US,en;q=0.9 | accept-encoding: gzip, deflate, br | Connection: Upgrade, HTTP2-Settings
curl_cffi firefox (http) GET / HTTP/1.1 || Host: … | Upgrade: h2c | HTTP2-Settings: AAEAAQAAAAIAAAAAAAQAAgAAAAUAAEAA | User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:147.0) Gecko/20100101 Firefox/147.0 | Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8 | Accept-Language: en-US,en;q=0.9 | Accept-Encoding: gzip, deflate, br, zstd | Upgrade-Insecure-Requests: 1 | Sec-Fetch-Dest: document | Sec-Fetch-Mode: navigate | Sec-Fetch-Site: none | Sec-Fetch-User: ?1 | Priority: u=0, i | Te: trailers | Connection: Upgrade, HTTP2-Settings
```

Source-confirmed defaults behind these rows:
- requests `default_headers()` order `User-Agent, Accept-Encoding, Accept, Connection`; UA `python-requests/<version>`; `Accept-Encoding` from urllib3 `make_headers(accept_encoding=True)` (https://raw.githubusercontent.com/psf/requests/main/src/requests/utils.py). Measured: `gzip, deflate` on a bare install; `br` added when `brotli`/`brotlicffi` present, `zstd` when `zstandard` present.
- aiohttp: `DEFAULT_HEADERS = {Accept: */*, Accept-Encoding: _gen_default_accept_encoding()}` (gzip, deflate + `br` if Brotli + `zstd` if Zstandard); UA = `SERVER_SOFTWARE` (measured `Python/3.13 aiohttp/3.14.5`); Host first, then caller headers, then defaults (https://raw.githubusercontent.com/aio-libs/aiohttp/master/aiohttp/client_reqrep.py).
- Scrapy: `USER_AGENT = f"Scrapy/{version} (+https://scrapy.org)"`, `DEFAULT_REQUEST_HEADERS = {"Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", "Accept-Language": "en"}`, `COMPRESSION_ENABLED = True` (https://raw.githubusercontent.com/scrapy/scrapy/master/scrapy/settings/default_settings.py).
- undici fetch: appends `accept: */*`, `accept-language: *` in `fetching()`, then fetch metadata, `user-agent` = `'node'` when `__UNDICI_IS_NODE__`/`esbuildDetection` is defined else `'undici'`, then `accept-encoding: br, gzip, deflate, zstd` for https / `gzip, deflate` otherwise (https://raw.githubusercontent.com/nodejs/undici/main/lib/web/fetch/index.js). (Node 22/24's bundled undici produced `br, gzip, deflate` over https — older undici without zstd.)
- node-fetch 3: `Accept: */*`, `User-Agent: node-fetch`, `Accept-Encoding: gzip, deflate, br` when `compress` (https://raw.githubusercontent.com/node-fetch/node-fetch/main/src/request.js).
- axios 1.x: `User-Agent: axios/<VERSION>`; `ACCEPT_ENCODING = 'gzip, compress, deflate' + (isBrotliSupported ? ', br' : '')`, `zstd` only with `transitional.advertiseZstdAcceptEncoding === true`; `Accept: application/json, text/plain, */*` from defaults (https://raw.githubusercontent.com/axios/axios/v1.x/lib/adapters/http.js, …/lib/defaults/index.js).
- got: `'user-agent': 'got (https://github.com/sindresorhus/got)'`, `decompress: true` sets `accept-encoding`, `http2: false` default (https://raw.githubusercontent.com/sindresorhus/got/main/source/core/options.ts).
- Go: `const defaultUserAgent = "Go-http-client/1.1"` (net/http/request.go:545) and `http2defaultUserAgent = "Go-http-client/2.0"` (h2_bundle.go) — read from the local GOROOT of Go 1.26.5.
- Java: `"Java-http-client/" + System.getProperty("java.version")` (HttpRequestImpl.java); HttpURLConnection `"Java/"+version` with optional `http.agent` prefix, `acceptString = "*/*"`, `Connection: keep-alive` (OpenJDK sources, raw.githubusercontent.com/openjdk/jdk/master/…).
- OkHttp: `const val userAgent = "okhttp/${OkHttp.VERSION}"`; BridgeInterceptor adds `Host`, `Connection: Keep-Alive`, `Accept-Encoding: gzip` (transparent gzip unless Accept-Encoding/Range set), `Cookie`, `User-Agent` in that order.
- wget: `User-Agent: Wget/<version>`, `Accept: */*`, `Accept-Encoding: identity` (or `gzip` when built with zlib and compression enabled), `Connection: Keep-Alive`; order Host, Referer, …, User-Agent, Accept, Accept-Encoding, Authorization, Connection (src/http.c mirror).
- Deno: `concat!("Deno/", env!("DENO_VERSION"))` (+`+<git hash>` on canary) (https://raw.githubusercontent.com/denoland/deno/main/cli/lib/version.rs).
- Bun docs show `User-Agent: Bun/1.3.3`, `Accept: */*`, `Accept-Encoding: gzip, deflate, br, zstd`, `Connection: keep-alive` (https://bun.com/docs/api/fetch) — matches our 1.4.4 capture.
- curl: `Accept: */*` only when no custom Accept; UA only when non-empty (lib/http.c).

### 3.5 Impersonation stacks (what they fake and what they still leak)

- **curl-impersonate (lexiforest fork)** targets: Chrome 99,100,101,104,107,110,116,119,120,123,124,131,133a,136,142,145,146,150,151,152 (+`chrome151_macos`, `chrome152_macos`, `chrome99_android`, `chrome131_android`), Edge 99/101, Safari 15.3, 15.5, 17.0, 17.2(iOS), 18.0, 18.0(iOS), 18.4, 18.4(iOS), 26.0, 26.0(iOS), 26.0.1, 27.0, 27.0(iOS), Firefox 133,135,144,147,153,154,155, Tor 14.5. Wrappers `curl_chrome152` etc.; modifies BoringSSL ClientHello (extension order, GREASE, ECH, ALPS, ZSTD, X25519Kyber768/MLKEM), HTTP/2 SETTINGS, default headers, HTTP/3/QUIC (https://raw.githubusercontent.com/lexiforest/curl-impersonate/main/README.md).
- **curl_cffi** (Python binding, 47 presets, `curl-cffi list`, `curl-cffi update` pulls new fingerprints from impersonate.pro; unversioned aliases `chrome`, `safari`, `safari_ios` track latest; custom `ja3`/`akamai`/`extra_fp` params) (https://raw.githubusercontent.com/lexiforest/curl_cffi/main/README.md).
- **tls-client (bogdanfinn, Go + Python/Node/C# bindings)** profiles (`profiles/profiles.go`): default `chrome_150`; `chrome_103…chrome_152` incl. `_PSK`/`_PQ` variants, `brave_146`, `safari_15_6_1`, `safari_16_0`, `safari_ipad_15_6`, `safari_ios_15_5…26_0`, `firefox_102…firefox_148`, `opera_89/90/91`, `zalando_*`, `nike_*`, `cloudscraper`, `mms_ios*`, `mesh_ios*`/`mesh_android*`, `confirmed_ios/android`, `okhttp4_android_7…13`.
- **Leaks we measured** (curl_cffi 0.16.3): (1) over plaintext `http://` every profile sends `Upgrade: h2c`, `HTTP2-Settings: …`, `Connection: Upgrade, HTTP2-Settings` — no browser does; (2) the Firefox profile sends no PRIORITY frames; (3) default (non-impersonated) mode = Chrome h2 SETTINGS + no UA; (4) profiles carry fixed `Accept-Language: en-US,en;q=0.9` and a fixed macOS UA regardless of the real host; (5) TLS session resumption, ECH outer SNI, HTTP/3 usage and TCP/IP stack (JA4T/TTL/window) are not faked by curl_cffi (TCP stack is the host's — Linux servers behind a "macOS Chrome" UA). (6) No JavaScript execution → never fetches the firewall's client SDK, never produces a client-side token.

### 3.6 Fetch/tool-call agents and their defaults (source-confirmed)

| Tool | User-Agent / headers | Library | robots.txt |
|---|---|---|---|
| MCP reference `fetch` server (`mcp-server-fetch`) | `ModelContextProtocol/1.0 (Autonomous; +https://github.com/modelcontextprotocol/servers)` for tool calls; `ModelContextProtocol/1.0 (User-Specified; +https://github.com/modelcontextprotocol/servers)` for the prompt; only header it sets is User-Agent, so the rest is httpx's set (`Accept: */*`, `Accept-Encoding: gzip, deflate[, br, zstd]`, `Connection: keep-alive`) in httpx order (UA last) | httpx.AsyncClient, follow_redirects, 30 s timeout | Fetches `/robots.txt` with the Autonomous UA; 401/403 → refuse; Protego parser; skipped with `ignore_robots_txt` |
| Crawl4AI `BrowserConfig` | default `user_agent = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/116.0.0.0 Safari/537.36"` (note: **no `(KHTML, like Gecko)`** token — a textual tell), `browser_type="chromium"`, `headless=True`, adds a generated `sec-ch-ua` header; `user_agent_mode="random"` optional (https://raw.githubusercontent.com/unclecode/crawl4ai/main/crawl4ai/async_configs.py) | Playwright Chromium | n/a |
| Scrapy | `Scrapy/2.19.0 (+https://scrapy.org)` | Twisted | obeys with `ROBOTSTXT_OBEY` (default False) |
| LangChain `WebBaseLoader` | **[uncertain]** source fetch returned 404 (file moved); historically a `default_header_template` with a desktop Chrome UA and `Accept-Language: en-US,en;q=0.5` on top of `requests` — verify before use | requests/aiohttp | no |
| Firecrawl, Jina Reader | **[uncertain]** not verified this session (ai.robots.txt lists a `FirecrawlAgent` token) | — | — |
| Cursor | Vercel directory lists `cursor-server` ("connects to MCP servers on behalf of a Cursor user"); xAI/Cursor key directory at `cursorusercontent.com` (Section 7.4) | — | — |

---

## 4. Consistency checks between layers (server-side, no JS needed)

Specs confirmed this session:
- UA Client Hints (https://wicg.github.io/ua-client-hints/): `Sec-CH-UA`, `Sec-CH-UA-Mobile`, `Sec-CH-UA-Platform` "will be sent by default, whether or not the server opted-into receiving the header"; high-entropy hints (`Sec-CH-UA-Arch`, `-Bitness`, `-Full-Version-List`, `-Model`, `-Platform-Version`, `-WoW64`, `-Form-Factors`) need `Accept-CH`; `Sec-CH-UA-Full-Version` deprecated; brands "MUST include more than a single value in brands, where one of these values is an arbitrary value" (GREASE brand); JS API `navigator.userAgentData.{brands,mobile,platform,getHighEntropyValues()}`.
- Fetch Metadata (https://w3c.github.io/webappsec-fetch-metadata/): `Sec-Fetch-Dest`, `Sec-Fetch-Mode` (`cors|navigate|no-cors|same-origin|websocket`), `Sec-Fetch-Site` (`cross-site|same-origin|same-site|none`) sent on every request to a potentially-trustworthy (HTTPS) URL; `Sec-Fetch-User: ?1` only on user-activated navigations. Top-level navigation = `document` / `navigate` / (`none` for address-bar) / `?1`.

Checks (each is cheap and deterministic; combine as a weighted vector, never as a single kill switch):

| # | Check | Pass looks like | Spoof/automation looks like |
|---|---|---|---|
| C1 | UA family ↔ TLS library class | Chrome/Edge UA ↔ BoringSSL hello with GREASE, ECH(65037), ALPS(17613), `X25519MLKEM768`; Safari ↔ GREASE + legacy CBC suites + `9:1` h2; Firefox ↔ NSS set (delegated_credentials 34, record_size_limit 28, no GREASE) | Chrome UA with cipher hash `ab0a1bf427ad` (Python), `b262b3658495` (Node), `f57a46bbacb6` (Go), `61a7ad8aa9b6` (rustls), `1d947a95fc68` (Java) → certain spoof |
| C2 | UA family ↔ h2 pseudo-header order & SETTINGS | Chrome `m,a,s,p` + `1:65536;2:0;4:6291456;6:262144|15663105`; Firefox `m,p,a,s` + `1:65536;2:0;4:131072;5:16384|12517377` (+PRIORITY frames); Safari `m,s,a,p` + `9:1` | Chrome UA with `a,m,p,s` (Go/Java/undici) or `m,s,a,p` (hyper/curl) |
| C3 | ALPN order vs negotiated protocol | browsers offer `h2, http/1.1` | `http/1.1, h2` (httpx, undici allowH2); no ALPN but UA claims modern browser (Scrapy, wget, Go-h1, Java-h1) |
| C4 | GREASE presence | Chromium/WebKit always GREASE ciphers, extensions, groups, versions | no GREASE + Chrome/Safari UA |
| C5 | Client hints presence | Chromium ≥ 89 UA ⇒ `sec-ch-ua`, `sec-ch-ua-mobile`, `sec-ch-ua-platform` present and brand list contains a GREASE brand and the same major version as the UA; platform matches UA OS token | Chrome UA without `sec-ch-ua` (python/Go/… spoofers, old curl-impersonate), or brand version ≠ UA version |
| C6 | Fetch metadata on HTTPS | top-level HTML navigation carries `Sec-Fetch-Dest: document`, `Sec-Fetch-Mode: navigate`, `Sec-Fetch-Site`, (often) `Sec-Fetch-User: ?1`; subresources carry `image|script|style…` with `no-cors`/`cors` | browser UA with no `Sec-Fetch-*`; or `sec-fetch-mode: cors` with **no** `sec-fetch-site/dest` (undici signature) |
| C7 | Accept / Accept-Language / Accept-Encoding sets | Chrome nav `Accept: text/html,…,application/signed-exchange;v=b3;q=0.7`, `Accept-Encoding: gzip, deflate, br, zstd`, `Accept-Language` with q-values; Safari `gzip, deflate, br` (no zstd); Firefox `gzip, deflate, br, zstd` | `Accept: */*` on a document navigation; missing `Accept-Language`; `accept-language: *` (undici/Deno); `gzip, compress, deflate, br` (axios); `zstd,gzip,deflate,br` (reqwest); `identity` (urllib/wget/urllib3) |
| C8 | h2c upgrade on plaintext | browsers never send `Upgrade: h2c` | `Upgrade: h2c` + `HTTP2-Settings` ⇒ Java HttpClient or curl-impersonate/curl_cffi |
| C9 | `Priority` header / h2 PRIORITY | Chrome & Firefox send `priority: u=0, i` on navigations (RFC 9218); Firefox sends PRIORITY frames | absent with a 2025+ browser UA |
| C10 | Header casing | h1 browsers send Title-Case; undici/Deno/reqwest/got/node-fetch emit lowercase on h1 | lowercase h1 headers + browser UA |
| C11 | Client-side cross-check (needs the JS SDK) | `navigator.userAgentData.brands` == `sec-ch-ua`; `navigator.languages[0]` ≈ first `Accept-Language` token; `navigator.platform` ≈ `sec-ch-ua-platform` | mismatch ⇒ header-level spoof (curl_cffi/tls-client) or a proxy rewriting headers |
| C12 | Session resumption behaviour | browsers reuse tickets within a site and send `pre_shared_key` on 2nd+ connections | automation often opens a fresh hello every connection; or vice-versa (PSK on first-ever visit = shared ticket cache across "users") |

Market note: Cloudflare already exposes JA3/JA4 and verified-bot fields; Vercel's managed bot ruleset does the UA-vs-stack check and "automatically excludes verified bots"; Vercel WAF rules can match the `Signature-Agent` header. Nobody on the list exposes the *reasons* (which layer disagreed); surfacing the C1–C12 vector per request is a differentiator for the review/replay product.

---

## 5. IP intelligence sources (all URLs fetched 2026-10-24 unless noted)

### 5.1 Cloud / hosting ranges

| Provider | URL | Format / size seen | Notes |
|---|---|---|---|
| AWS | `https://ip-ranges.amazonaws.com/ip-ranges.json` | JSON 2.7 MB; `syncToken 1792870625`, `createDate 2026-10-24-19-37-05`; 10,684 `prefixes` + 7,005 `ipv6_prefixes` with `ip_prefix`, `region`, `service` (`AMAZON`, `EC2`, `CLOUDFRONT`, `S3`, `GLOBALACCELERATOR`, …), `network_border_group` | Filter `service == "EC2"` for compute; `CLOUDFRONT` ≠ bots. Updated continuously. |
| Google Cloud | `https://www.gstatic.com/ipranges/cloud.json` | 1,135 prefixes (`ipv4Prefix`/`ipv6Prefix`, `service: "Google Cloud"`, `scope: <region>`), `creationTime 2026-10-24T13:10:14` | Customer VMs (where hosted browsers and Anthropic's `34.162.x.x/32` Claude-User IPs live). |
| Google (all Google-owned) | `https://www.gstatic.com/ipranges/goog.json` | 148 prefixes | Superset incl. non-cloud; "general Google IP list" per Google's verify page. |
| Azure | `https://download.microsoft.com/download/7/1/D/71D86715-5596-4529-9B13-DA13A5DE5B63/ServiceTags_Public_YYYYMMDD.json` | `ServiceTags_Public_20261019.json` → 200, 4,870,615 bytes, Last-Modified 2026-10-20; `20261012` also 200; non-Monday dates 404 | Weekly file named by the Monday date; discover via https://www.microsoft.com/en-us/download/details.aspx?id=56519. Service tags (`AzureCloud.<region>`, …) with `properties.addressPrefixes`. Note OpenAI's own crawler prefixes (`13.66.x`, `20.x`, `172.182.x`, `104.210.x`…) sit inside Azure. |
| Oracle OCI | `https://docs.oracle.com/en-us/iaas/tools/public_ip_ranges.json` | 56 regions, `cidrs[].cidr` + `tags` (`OCI`, `OSN`, …), `last_updated_timestamp 2026-08-25` | — |
| DigitalOcean | `https://digitalocean.com/geo/google.csv` | 1,235 rows `prefix,country,region,city,postal` | AS14061 |
| Linode/Akamai cloud | `https://geoip.linode.com/` | RFC 8805 geofeed, 5,505 rows, "Last modified: 2026-10-24" | AS63949 |
| Vultr | `https://geofeed.constant.com/` | geofeed, 494 rows | AS20473 |
| Cloudflare (proxy, not customers) | `https://www.cloudflare.com/ips-v4`, `/ips-v6` | 15 v4 ranges (`173.245.48.0/20`, `103.21.244.0/22`, …, `131.0.72.0/22`) | Traffic *from* these = Cloudflare Workers/Browser Rendering/WARP-less proxying. |
| Fastly | `https://api.fastly.com/public-ip-list` | 21 v4 + 3 v6 | — |
| Hetzner | **no first-party list** (`api.hetzner.com/ips` → 404) | use ASN **AS24940** (+ AS213230 Hetzner Online cloud) prefix sets | ipverse `as/24940/aggregated.json` fetched OK (1.8 KB) |
| OVH | **no first-party list** (`geofeed.ovh.net` unreachable) | ASN **AS16276** | ipverse `as/16276/aggregated.json` OK (12 KB) |
| Alibaba Cloud | no first-party list found | AS45102 (Alibaba US), AS37963 (Hangzhou) | ipverse OK |
| Tencent Cloud | no first-party list found | AS132203 | ipverse OK |
| Apple (incl. Applebot, Private Relay) | AS714 / AS6185; Applebot list in 5.2; Private Relay in 5.4 | — | — |

### 5.2 Published AI-operator / crawler ranges (JSON schema `{"creationTime": "...", "prefixes": [{"ipv4Prefix": "..."}|{"ipv6Prefix": "..."}]}` unless noted)

| Operator / bot | URL | Seen 2026-10-24 |
|---|---|---|
| OpenAI GPTBot | `https://openai.com/gptbot.json` | 18 prefixes, creationTime 2026-09-22 (e.g. `132.196.86.0/24`, `172.182.202.0/25`) |
| OpenAI OAI-SearchBot | `https://openai.com/searchbot.json` | 39 prefixes, 2026-01-02 (e.g. `104.210.140.128/28`, `13.66.216.176/28`, `135.234.64.0/24`) |
| OpenAI ChatGPT-User (also covers ChatGPT agent fetches **[likely]**) | `https://openai.com/chatgpt-user.json` | 234 prefixes, 2026-10-20 (served as `application/octet-stream`) |
| OpenAI OAI-AdsBot | `https://openai.com/adsbot.json` | 2 prefixes (`130.131.229.128/25`, `20.168.90.128/25`) |
| Anthropic (ClaudeBot, Claude-User, Claude-SearchBot — one shared list) | `https://claude.com/crawling/bots.json` | 14 prefixes, creationTime `2026-10-20T00:00:00Z` (e.g. `216.73.216.0/22`, `34.162.230.222/32`, `34.162.244.71/32`) |
| Google common crawlers (Googlebot…) | `https://developers.google.com/static/crawling/ipranges/common-crawlers.json` (legacy `/static/search/apis/ipranges/googlebot.json` still 200 and identical) | 317 prefixes, 2026-10-23 |
| Google special-case crawlers (AdsBot, Mediapartners, Google-Safety) | `…/ipranges/special-crawlers.json` | 272 |
| Google user-triggered fetchers (user-owned, `gae.googleusercontent.com`) | `…/ipranges/user-triggered-fetchers.json` | 1,068 |
| Google user-triggered fetchers (Google-owned, `google.com`) | `…/ipranges/user-triggered-fetchers-google.json` | 504 |
| **Google-Agent (Mariner etc.)** | `…/ipranges/user-triggered-agents.json` | **20** prefixes (e.g. `2001:4860:c::/124`) |
| Perplexity PerplexityBot | `https://www.perplexity.com/perplexitybot.json` | 8 single-IP `/32` prefixes (`107.20.236.150/32`, `3.224.62.45/32`, `18.210.92.235/32`, …), 2025-02-07 — AWS us-east-1 addresses |
| Perplexity-User | `https://www.perplexity.com/perplexity-user.json` | 4 prefixes (`44.208.221.197/32`, `34.193.163.52/32`, `18.97.21.0/30`, …), 2025-10-17 |
| Microsoft Bingbot | `https://www.bing.com/toolbox/bingbot.json` | 28 prefixes (`157.55.39.0/24`, `207.46.13.0/24`, `40.77.167.0/24`, …), creationTime 2024-01-03 |
| Apple Applebot | `https://search.developer.apple.com/applebot.json` | 24 prefixes (`17.241.208.160/27`, …), 2026-09-15 |
| Amazonbot / Amzn-SearchBot / Amzn-User | `https://developer.amazon.com/amazonbot/ip-addresses/`, `…/searchbot-ip-addresses/`, `…/live-ip-addresses/` | HTML page with the JSON **embedded** (1,292 `ipv4Prefix` entries, creationTime `2026-09-08T05:24:10`); no bare JSON endpoint found |
| Common Crawl CCBot | `https://index.commoncrawl.org/ccbot.json` | `synctoken 20260811134000`; notes: "For verification of IPv4 addresses, FCrDNS is also recommended."; e.g. `2600:1f28:365:8000::/56`, `3.41.188.32/29`, `18.97.9.168/29` |
| DuckDuckGo DuckDuckBot | help page lists IPs (346 unique v4 extracted); JSON URL truncated in page (`https://duckdu…`) **[uncertain]** | — |
| Meta crawlers | no list URL on the crawler docs; Meta says to allow-list "the IP addresses (more secure)" but gives none; practice is `whois -h whois.radb.net -- '-i origin AS32934'` **[uncertain]** | — |
| ByteDance Bytespider | none published ("does not publish a verification method") | — |
| Mistral, xAI, DeepSeek, Moonshot, etc. | none found this session | — |

### 5.3 ASN datasets
- **iptoasn.com** (`https://iptoasn.com/`): `data/ip2asn-v4.tsv.gz`, `ip2asn-v4-u32.tsv.gz`, `ip2asn-v6.tsv.gz`, `ip2asn-combined.tsv.gz` (HEAD → 200, `application/binary`); columns `range_start range_end AS_number country_code AS_description`; "Updated hourly"; PDDL public domain; no hosted API since 2020-12-31.
- **ipverse/asn-ip** (GitHub): `as/<ASN>/aggregated.json`, `ipv4-aggregated.txt`, `ipv6-aggregated.txt`; "updated daily"; CC0 1.0; raw URL `https://raw.githubusercontent.com/ipverse/asn-ip/master/as/<ASN>/aggregated.json` (fetched for AS24940, 213230, 16276, 45102, 37963, 132203, 14061, 63949, 20473, 14618, 16509, 15169, 396982, 8075, 31898 — all 200). Sibling: `ipverse/as-metadata`.
- **IPinfo Lite** (`https://ipinfo.io/lite`): free, CC BY-SA 4.0, daily, CSV/MMDB/JSON/Parquet; fields `asn`, `as_name`, `as_domain`, `country_code`, `country`, `continent_code`, `continent`; **no privacy/hosting flags** (those are paid: `is_anonymous`, `is_hosting`, `anonymous.is_vpn/is_proxy/is_tor/is_relay/is_res_proxy/name`).
- **MaxMind GeoLite2** (Country/City/ASN): free but requires account + license key, geoipupdate or CSV download, 30 downloads/day cap, must refresh within 30 days of a release, attribution required; "not recommended for commercial use cases" (City).
- **Spur Context API** (paid, `https://docs.spur.us/context-api`): `infrastructure` (`DATACENTER`, …), `client.types`, `client.proxies` (`NETNUT_PROXY`, `ABCPROXY_PROXY`, … `OXYLABS_PROXY`), `client.behaviors`, `tunnels[].type/operator/anonymous`, `risks` (`CALLBACK_PROXY`, `TUNNEL`, `GEO_MISMATCH`) — the canonical residential-proxy-network labelling source.

### 5.4 Relay / VPN egress
- **iCloud Private Relay**: `https://mask-api.icloud.com/egress-ip-ranges.csv` — 12 MB, **285,106 rows** `CIDR,country,region,city,postal` (e.g. `172.224.226.0/27,GB,GB-EN,London,`). Apple: two hops run by different entities; identify via this list or provider annotations (`is_relay`, `is_hosting`, `privacy_service`, `privacy_proxy`); DNS names `mask.icloud.com`, `mask-h2.icloud.com`; recommends Private Access Tokens instead of blocking. Treat as carrier-grade NAT, not datacenter.
- **Cloudflare WARP**: only *ingress* ranges are documented (`162.159.193.0/24` WireGuard, `162.159.197.0/24` MASQUE, `162.159.239.0/24` FedRAMP, `162.159.192.0/24` consumer 1.1.1.1+WARP; v6 `2606:4700:100::/48`, `…:102::/48`, `…:105::/48`). **No public WARP egress list** found (https://developers.cloudflare.com/cloudflare-one/connections/connect-devices/warp/deployment/firewall/) **[uncertain]** — WARP egress appears as Cloudflare ASN 13335 with `is_relay`-style annotations in commercial feeds.

### 5.5 Reverse-DNS (FCrDNS) procedures that operators actually publish

| Operator | Reverse-DNS suffix(es) | Forward-confirm | Source |
|---|---|---|---|
| Google (all crawlers/fetchers) | `crawl-***-***-***-***.googlebot.com`, `geo-crawl-***.geo.googlebot.com` (common); `rate-limited-proxy-***.google.com` (special-case); `***.gae.googleusercontent.com` (user-owned fetchers), `google-proxy-***.google.com` (Google-owned fetchers); accepted domains `googlebot.com`, `google.com`, `googleusercontent.com` | `host <ip>` then `host <name>` must return the same IP; examples `host 66.249.66.1`, `host 35.247.243.240`, `host 66.249.90.77` | https://developers.google.com/crawling/docs/crawlers-fetchers/verify-google-requests |
| Apple Applebot | `*.applebot.apple.com` | `host` both ways | https://support.apple.com/en-us/119829 |
| Common Crawl CCBot | `*.crawl.commoncrawl.org` (e.g. `18-97-14-84.crawl.commoncrawl.org`), IPv4 only | `dig -x` then `dig A` | https://commoncrawl.org/ccbot |
| Microsoft Bingbot | `search.msn.com` **[uncertain — Bing help pages are JS-rendered and could not be fetched; the IP JSON is confirmed]** | — | https://www.bing.com/webmasters/help/how-to-verify-bingbot-3905dc26 |
| Amazonbot | `crawl.amazonbot.amazon` **[uncertain — not on the fetched page]** | — | https://developer.amazon.com/amazonbot |
| OpenAI, Anthropic, Perplexity, DuckDuckGo | **IP list only**, no rDNS published | — | docs above |
| Cloudflare verified-bots policy | bot owners may submit "domain suffixes" for rDNS validation; "IP addresses should have PTR records set correctly"; generic UA patterns (`Dart`, `Go-http-client`, `python-requests`, `node-fetch`) are rejected | — | https://developers.cloudflare.com/bots/reference/bot-verification/ip-validation/ |

FCrDNS algorithm (what to implement): (1) PTR lookup on the client IP; (2) the PTR name must end with an allow-listed suffix for the claimed UA token; (3) A/AAAA lookup of that name must contain the client IP; (4) cache positive results per IP for 24 h, negative for 1 h; (5) never trust a PTR alone (anyone controls their own reverse zone).

---

## 6. Declared bot / agent catalogue (exact strings)

| Bot (operator) | Exact UA / token | robots.txt behaviour | Verification | Source |
|---|---|---|---|---|
| GPTBot (OpenAI) | `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.4; +https://openai.com/gptbot` | obeys; token `GPTBot` | IP list | https://developers.openai.com/api/docs/bots |
| OAI-SearchBot | `…; compatible; OAI-SearchBot/1.4; +https://openai.com/searchbot` (robots.txt fetch variant inserts `; robots.txt;`) | obeys; 24 h propagation | IP list | same |
| ChatGPT-User | `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot` | "may not apply" (user-triggered; GPT Actions) | IP list; ChatGPT **agent** additionally signs with `Signature-Agent: "https://chatgpt.com"` | same; Cloudflare blog |
| OAI-AdsBot | `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-AdsBot/1.0; +https://openai.com/adsbot` | — | IP list | same |
| ClaudeBot / Claude-User / Claude-SearchBot (Anthropic) | tokens only on the support page; full UA strings not published there **[uncertain]** (ai.robots.txt also lists `Claude-Web`, `Claude-Code`, `anthropic-ai`) | honour robots.txt incl. `Crawl-delay`; "don't bypass CAPTCHAs" | IP list `claude.com/crawling/bots.json`; **no Web Bot Auth** | https://support.claude.com/en/articles/8896518-… |
| Googlebot | contains `Googlebot/2.1 (+http://www.google.com/bot.html)` (desktop/smartphone variants with `Chrome/W.X.Y.Z`) | obeys | rDNS + `common-crawlers.json` | https://developers.google.com/search/docs/crawling-indexing/google-common-crawlers |
| Google-Extended | **no UA** — robots token only (controls Gemini training/grounding) | — | — | same |
| Google-CloudVertexBot, GoogleOther(-Image/-Video), Google-InspectionTool, Storebot-Google | substrings as named | obeys | same | same |
| **Google-Agent** (Mariner & Google-hosted agents) | mobile: `Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/W.X.Y.Z Mobile Safari/537.36 (compatible; Google-Agent; +https://developers.google.com/crawling/docs/crawlers-fetchers/google-agent)`; desktop: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko; compatible; Google-Agent; +https://developers.google.com/crawling/docs/crawlers-fetchers/google-agent) Chrome/W.X.Y.Z Safari/537.36` | "generally ignore robots.txt" (user-triggered) | `user-triggered-agents.json`; rDNS `gae.googleusercontent.com` / `google-proxy-*.google.com`; **Web Bot Auth experimental, identity `https://agent.bot.goog`** ("We don't sign every request") | https://developers.google.com/crawling/docs/crawlers-fetchers/google-agent |
| Google-GeminiNotebook (ex Google-NotebookLM, until Aug 2026), Google-Read-Aloud, FeedFetcher-Google, GoogleProducer, Google-Site-Verification/1.0, Google-CWS, GoogleMessages, Google-Pinpoint | as named | ignore robots.txt (user-triggered) | user-triggered-fetchers*.json | https://developers.google.com/search/docs/crawling-indexing/google-user-triggered-fetchers |
| APIs-Google, AdsBot-Google(-Mobile), Mediapartners-Google, Google-Safety | as named | ignore `*` group / ignore robots | `special-crawlers.json`, rDNS `rate-limited-proxy-*.google.com` | …/google-special-case-crawlers |
| PerplexityBot | `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)` | obeys | IP list | https://docs.perplexity.ai/guides/bots |
| Perplexity-User | `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Perplexity-User/1.0; +https://perplexity.ai/perplexity-user)` | "generally ignores robots.txt" | IP list; **undeclared fallback crawler observed** using `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36` from rotating ASNs | Perplexity docs; https://blog.cloudflare.com/perplexity-is-using-stealth-undeclared-crawlers-to-evade-website-no-crawl-directives/ |
| Amazonbot | `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Amazonbot/0.1) Chrome/W.X.Y.Z Safari/537.36` | RFC 9309; 30-day cache; no crawl-delay; honours `noarchive` (no training) | IP list page | https://developer.amazon.com/amazonbot |
| Amzn-SearchBot / Amzn-User | same template with `Amzn-SearchBot/0.1` / `Amzn-User/0.1` | SearchBot follows other search-bot rules if unnamed; Amzn-User may not follow (user-initiated) | separate IP pages | same |
| Amazon Nova Act / AgentCore Browser | token `NovaAct` (ai.robots.txt) **[uncertain UA]**; AgentCore Browser signs via `*.keydirectory.signer.<region>.on.aws` | — | Web Bot Auth | survey (Section 7.4) |
| Applebot | `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15 (Applebot/0.1; +http://www.apple.com/go/applebot)` (+ iPhone variant) | obeys; falls back to Googlebot rules | rDNS `*.applebot.apple.com` + `applebot.json` | https://support.apple.com/en-us/119829 |
| Applebot-Extended | robots token only ("does not crawl webpages") | controls foundation-model training | — | same |
| meta-externalagent / meta-externalfetcher / facebookexternalhit / meta-webindexer / meta-externalads | `meta-externalagent/1.1 (+/documentation/sharing/webmasters/web-crawlers)` and bare `meta-externalagent/1.1` (same pattern for the others; `facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)`) | externalfetcher & externalhit may bypass robots (user-initiated / integrity checks); 24 h cache | IP allow-listing recommended, no URL; Web Bot Auth keys at `www.meta.com` (survey: for `Meta-ExternalTest`) | https://developers.facebook.com/docs/sharing/webmasters/web-crawlers |
| Bytespider (ByteDance) | `Mozilla/5.0 (Linux; Android 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36 (compatible; Bytespider; spider-feedback@bytedance.com)` | expected to follow | **none published** | https://knownagents.com/agents/bytespider |
| CCBot (Common Crawl) | `CCBot/2.0 (https://commoncrawl.org/faq/)` | obeys; aware of impostors | rDNS + `ccbot.json` | https://commoncrawl.org/ccbot |
| DuckDuckBot / DuckAssistBot | `DuckDuckBot/1.1; (+http://duckduckgo.com/duckduckbot.html)`; DuckAssistBot UA **[uncertain]** | obeys | IP list; DuckAssistBot **signs** (`assistbot.duckduckgo.com`) | https://duckduckgo.com/duckduckgo-help-pages/results/duckduckbot/ |
| Bingbot | UA not fetched (JS page) **[uncertain]** | — | `bingbot.json` | https://www.bing.com/toolbox/bingbot.json |
| Microsoft Copilot | "lacks a unique user agent" (Vercel) | — | — | https://vercel.com/blog/the-rise-of-the-ai-crawler |
| 200 tokens / 110 operators | `ai.robots.txt` `robots.json` (fetched, 88 KB): includes `ChatGPT Agent`, `Operator`, `Claude-Code`, `Codex`, `Cursor`, `Devin`, `Crawl4AI`, `FirecrawlAgent`, `GoogleAgent-Mariner`, `Gemini-Deep-Research`, `Kimi-Agent`, `Manus-User`, `MistralAI-User`, `NovaAct`, `Lightpanda`, `Mozilla-Tabstack`, `TavilyBot`, `LinkupBot`, `ExaUser`, `Shap-User`, `Diffbot-User`, `AmazonBuyForMe`, `CartAI Agentic Commerce` … | — | — | https://raw.githubusercontent.com/ai-robots-txt/ai.robots.txt/main/robots.json |
| Vercel/bots.fyi directory (216 entries) | slugs incl. `chatgpt-operator`, `chatgpt-user`, `gpt-actions`, `gptbot`, `oai-searchbot`, `oai-adsbot`, `claude-user`, `claude-searchbot`, `claudebot`, `perplexity-user`, `perplexitybot`, `google-agent` (category `agent`), `gemini-deep-research`, `google-cloudvertexbot`, `duckassistbot`, `mistralai-user`, `mistralai-index`, `browserbase`, `kernel`, `kernel-searchbot`, `cursor-server`, `ryebot`, `channel3bot`, `shapbot`, `v0bot`, `rovo`, `microsoftpreview`, `meta-webindexer`, `amazon-q`, `amazon-kendra` with categories `ai_crawler`, `ai_assistant`, `agent`, `user_initiated`, `search_engine_crawler`, `ecommerce`, `preview`, `webhook`, `monitor` | — | IP / rDNS / Web Bot Auth ("ChatGPT operator signs its requests … is now allowed", 2025-08-12) | https://vercel.com/docs/bot-management, https://bots.fyi |

---

## 7. Web Bot Auth — protocol as of October 2026

### 7.1 Document status (IETF datatracker, fetched)
- **WG document:** `draft-ietf-webbotauth-httpsig-protocol-00`, "HTTP Message Signatures for automated traffic", Web Bot Auth WG, published 2026-09-01, expires 2027-03-05, Standards Track, authors Thibault Meunier (Cloudflare), Sandor Major (Google). Replaces `draft-meunier-webbotauth-httpsig-protocol` (-00…-02), which replaced `draft-meunier-web-bot-auth-architecture-05` (2026-03-02). The protocol-01 changelog says it "folds in the directory draft" — i.e. the separate directory document (`draft-meunier-http-message-signatures-directory-05`, "Replaced by draft-meunier-webbotauth-httpsig-directory") is now merged; `draft-ietf-webbotauth-httpsig-directory` **does not exist** (404).
- Related WG-adjacent drafts: `draft-meunier-webbotauth-registry-03` (Registry and Signature Agent Card), `draft-singh-webbotauth-hosted-directories-00`, `draft-rescorla-anonymous-webbotauth-01` (anonymous auth / rate limiting), `draft-illyes-webbotauth-jafar-01` (**JSON format for publishing IP ranges of automated clients**, 2026-10-22), `draft-kelley-webbotauth-sail-00` (Source Address Identity List, 2026-10-22), `draft-illyes-webbotauth-cbcp-01` (crawler best practices), `draft-farzdusa-webbot-datacollection-01`, `draft-popov-webbotauth-semantic-anchor-00`.

### 7.2 Wire format (protocol-00 + Cloudflare implementation notes)
Headers (all RFC 9421 Structured Fields):
```
Signature-Agent: sig1="https://signature-agent.test"                       ; Dictionary; member value = String item containing an https URI
Signature-Agent: sig1="https://signature-agent.test/jwks.json";type=jwks_uri
Signature-Agent: sig1="https://signature-agent.test/card";type=cimd        ; type ∈ directory (default) | jwks_uri | cimd
Signature-Input: sig1=("@authority" "signature-agent";key="sig1");created=1700000000;expires=1700011111;keyid="ba3e64==";alg="ed25519";nonce="…";tag="web-bot-auth"
Signature: sig1=:base64(64-byte Ed25519 R||S):
```
Rules:
- Covered components: MUST include `@authority` or `@target-uri`; SHOULD cover `@method`, `@path`, `@target-uri`, `@query-param`; when `Signature-Agent` is sent, `"signature-agent";key="<label>"` MUST be covered (the member keyed to the signature's own label). Bodies: send and cover `Content-Digest`. Cloudflare additionally: components must be ASCII; `sf`, `bs`, `key`, `req` (on headers), `name` parameters and `@query-params`/`@status` are unsupported; the `Signature-Agent` value must be an `https://` URI in double quotes, not dictionary form `sig2="…"` **(Cloudflare doc; contradicts the draft's Dictionary form — accept both)**.
- Parameters: `created` and `expires` MUST be present (expiry RECOMMENDED ≤ 24 h; Cloudflare recommends about a minute); `keyid` MUST be the base64url JWK SHA-256 thumbprint (RFC 7638 for RSA/EC, RFC 8037 App. A.3 for Ed25519); `tag` MUST be `web-bot-auth`; `alg` from the IANA HTTP Signature Algorithms registry (`ed25519`, `rsa-pss-sha512`, …); `nonce` optional (Cloudflare: "recommended but not validated").
- Identity model: "The identifier is the URL the verifier fetched"; "an unresolved `Signature-Agent` is a claim rather than an identity"; a valid signature proves key possession only; key lookup is keyed on the `(URL, keyid)` pair; fallback identity without a URL is the `keyid` thumbprint ("This mode has no rotation").
- Discovery: `directory` → `GET https://<origin>/.well-known/http-message-signatures-directory` with `Accept: application/http-message-signatures-directory+json`; only `200 (OK)` is accepted — "A verifier MUST treat all other HTTP status codes as discovery failures and MUST NOT automatically follow HTTP redirects". Directory = RFC 7517 JWKS (`{"keys":[{"kty":"OKP","crv":"Ed25519","x":"…","kid":"<thumbprint>","use":"sig","nbf":…,"exp":…}]}`), served over HTTPS with `Content-Type: application/http-message-signatures-directory+json`, and **signed**: response `Signature-Input`/`Signature` with one signature per key, covering `("@authority";req)`, `tag="http-message-signatures-directory"`, `keyid` = thumbprint, `created`/`expires`; clients SHOULD ignore keys without a valid signature (directory-05 §5.2; protocol-02 made this optional for directly resolved keys). Cloudflare's `http-signature-directory` CLI validates a directory; test endpoint `https://crawltest.com/cdn-cgi/web-bot-auth` returns 401 unknown key / 200 verified / 400 malformed.
- Challenge/response: origin MAY answer unsigned requests with **403 and `Accept-Signature`** (RFC 9421 §5: a Dictionary whose member value lists the desired covered components and parameters such as `created`, `expires`, `nonce`, `tag`, `alg`, `keyid`); 429 when a signature/nonce is replayed beyond policy; 400 on parse failure.
- Transitive trust (Cloudflare experiment): `Forwarded: for="openai"` / `Forwarded: for="openai";use="reference"` — "may change".
- RFC 9421 verification (§3.2, fetched): parse `Signature`/`Signature-Input` by label; parse the Inner List; examine parameters; resolve key material (fail if unknown/untrusted); resolve algorithm (config → key → `alg`, must agree); rebuild the signature base; run HTTP_VERIFY; any failure ⇒ invalid. Ed25519 = RFC 8032 pure mode, "no prehash", 64-octet `R||S`. Signature base line format `"<component-identifier>": <value>` ending with `"@signature-params": <inner list>`; `@authority` lower-cased without default port; `@path` without query; `@query` includes leading `?`.

### 7.3 Verification algorithm to implement (edge companion)
```
verifyWebBotAuth(req):
  1. if no Signature-Input: return UNSIGNED  (optionally emit 403 + Accept-Signature for routes that require signing)
  2. parse Signature-Input (SF Dictionary → label → Inner List + params); parse Signature (label → Byte Sequence); parse Signature-Agent (SF Dictionary; also accept bare sf-string per Cloudflare); 400 on any parse error
  3. for each label L present in both fields (stop at first that verifies, ≤ 3 labels):
       p = params[L]; require p.tag == "web-bot-auth"; require p.created and p.expires integers;
       require created-skew ≤ now ≤ expires and expires-created ≤ 24h (policy: ≤ 5 min for strict mode)
       require p.alg in {ed25519, rsa-pss-sha512, ecdsa-p256-sha256} (policy) ; require p.keyid
       components = inner list; require "@authority" or "@target-uri" ∈ components
       if Signature-Agent present: require ("signature-agent";key=L) ∈ components (also accept plain "signature-agent")
       identity = Signature-Agent[L] (or Signature-Agent string) ; must be https URI; type := param type or "directory"
       keys = resolveKeys(identity, type)      # cached by (URL, keyid); SSRF-safe fetch: DNS→public IP only, 200 only, no redirects, ≤ 64 KiB, timeout 2 s, Accept: application/http-message-signatures-directory+json, verify directory self-signature if present (tag http-message-signatures-directory), check nbf/exp
       key = keys[p.keyid]  (match on kid; ALSO compute RFC 7638 thumbprint of each JWK and match on it — Google publishes short kids, Meta none)
       if !key: optionally refetch once (rotation), else UNKNOWN_KEY → treat as unsigned + record claim
       base = buildSignatureBase(req, components, p)  # RFC 9421 §2.5 incl. "@signature-params" line, exactly as serialized in Signature-Input
       ok = Ed25519.verify(key.x, base, sig)
       if ok: nonce replay check (LRU keyed by (identity, keyid, nonce) for expires window) → VERIFIED(identity, keyid, purpose fields from directory)
  4. VERIFIED → attribution = resolved URL origin (e.g. https://chatgpt.com); map to operator/category via local registry; log Signature-Agent even when verification fails (it is a *claim* worth counting)
```
Reference code: Cloudflare `web-bot-auth` npm package — `sign(request, {signer: await signerFromJWK(jwk), created, expires, nonce: generateNonce()})` and `verify(signedRequest, {resolver: (candidate) => …return verifier for candidate.keyid…, validate: ({nonce}) => …replay cache…})` with `signerFromJWK`/`verifierFromJWK` from `web-bot-auth/crypto` (https://raw.githubusercontent.com/cloudflare/web-bot-auth/main/packages/web-bot-auth/README.md); repo also has `http-message-sig`, `jsonwebkey-thumbprint`, Rust crate `web-bot-auth`, `http-signature-directory` CLI, Caddy plugin, Workers verifier, browser-extension signer; test key `examples/rfc9421-keys/ed25519.pem` (RFC 9421 test key `test-key-ed25519`: `x = JrQLj5P_89iXES9-vFgrIy29clF9CC_oPPsw3c5D0bs`, `d = n4Ni-HpISpVObnQMW0wOhCKROaIKqKtW_2ZYb2p9KcU` — **flag any request signed with this key as a test/abuse signal**, its thumbprint appears as `kid` `NFcWBst6DXG-N35nHdzMrioWntdzNZghQSkjHNMMSjw` / `poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U` in the drafts). Other listed implementations: Stytch Puppeteer example (`stytchauth/web-bot-auth-example`), Guzzle middleware (PHP), `cyberstormdotmu/bot-authentication` (Python; scrapy/crawl4ai), HUMAN `human-verified-ai-agent` (Python; components `@authority`+`signature-agent`, optional `@method`,`@path`; verification via HUMAN's `/verify` service; "No agent registry or certificate authority currently exists in production"), Linzer (Ruby), `garyillyes/web-bot-auth-apache` (C).

### 7.4 Adopters: key directories observed live on 2026-10-24 (GET `/.well-known/http-message-signatures-directory`)

| Identity / host | Status, media type | Keys | Directory signature details & quirks |
|---|---|---|---|
| `https://chatgpt.com` (OpenAI ChatGPT agent/Operator/Atlas **[likely scope]**) | 200 `application/http-message-signatures-directory+json`, `cache-control: no-store, no-transform`, server cloudflare | 1 × Ed25519, `kid ArwjqcCqtA5oxEWkzXGC-To_0A9whHmajCHtfe8I9aY`, `nbf 1735689600` (2025-01-01), `exp 1793485794` | `Signature-Input: sig1=("@authority";req "content-digest");created=…;expires=+24h;keyid=…;tag="http-message-signatures-directory";alg="ed25519"`; extra top-level fields `"signature_agent": "https://chatgpt.com"`, `"purpose": "ai"`. `www.chatgpt.com` also serves it; `operator.openai.com` does not resolve; `openai.com` 404. |
| `https://agent.bot.goog` (Google-Agent) | 200, `cache-control: public, max-age=3600`, server ESF | 5 × Ed25519 with `alg: EdDSA`, `key_ops: ["verify"]`, **short kids** `mhxuPw`, `cYSMkA`, `bUCe2A`, `DYiMjA`, `Ggh50g` (not thumbprints) | `g=("@authority";req);created;expires=+300s;keyid="DYiMjA";alg="ed25519";tag="http-message-signatures-directory"` — only one of five keys signs the directory. |
| `https://www.meta.com` (Meta; survey says `Meta-ExternalTest`) | 200, `cache-control: must-revalidate, max-age=3600` | 5 × Ed25519 **without `kid`/`use`** | 5 signatures `sig1…sig5` each `("@authority";req);alg="ed25519";keyid=<thumbprint>;nonce=…;tag=…;created;expires=+65min`. `meta.com` → 301 to www. |
| `https://assistbot.duckduckgo.com` (DuckAssistBot) | 200, `cache-control: max-age=86340`, nginx | 1 × Ed25519 `kid Ov3HDsa8JQ39dPEYFvFFN-cUpnz9yNI8LDvr-5LeiBM` | signed with nonce; `duckduckgo.com` 404. |
| `https://www.browserbase.com` (Browserbase hosted browsers) | 200, `cache-control: public, max-age=3600`, server Vercel, `age` header (CDN-cached, ETag) | 2 × Ed25519 (`NVhTndQWodGQ47Kmhm1bhTdt0swWS7EHmUEMo-opsXU`, `DJuTDnlBxNZzalQhhvktwvkF3lWss-T56g7s4xubuhU`) + `"purpose": "rag"` | labels `binding0`/`binding1`, components `("@authority")` **without `;req`**; `browserbase.com` → 301. |
| `https://cursorusercontent.com` (listed by Cloudflare Radar as xAI "Grok Bot" **[uncertain attribution]**) | 200 (`…+json; charset=utf-8`), `max-age=86400` | 1 × Ed25519, `nbf 1786403101`, `exp 1817939101` | `sig1=("@authority";req);…;alg="ed25519"`. `x.ai`, `grok.com` 404. |
| `https://www.hyperbrowser.ai` | 200, `max-age=86400` | 1 × Ed25519 | `binding=("@authority";req "content-digest")` with **no `alg`**; apex `hyperbrowser.ai` → 307. |
| `https://www.kernel.sh` (+ `search.bot.kernel.sh`) | 200, `max-age=3600` | 1 × Ed25519 with `nbf`/`exp` = 1 h window (short-lived key!) | `onkernel.com` → 301 to www.kernel.sh. |
| `https://www.browserless.io` | 200 but **`Content-Type: application/http-message-signatures-directory; charset=utf-8` (missing `+json`) and `"keys": []`** | 0 | Non-conformant; treat as "claims to sign, cannot verify". |
| Amazon AgentCore Browser | 9 hosts `https://<id>.keydirectory.signer.{us-east-1,us-east-2,us-west-2,eu-west-1,eu-central-1,ap-south-1,ap-southeast-1,ap-southeast-2,ap-northeast-1}.on.aws` (e.g. `xhah6q48pbxb4.keydirectory.signer.us-east-1.on.aws`) | 1 × Ed25519 each | Not Amazonbot. `amazon.com`/`developer.amazon.com` 404. |
| Cloudflare | `search.ai.cloudflare.com` (+`/external/`), `web-bot-auth{,-crawl}.cloudflare-browser-rendering-085.workers.dev` (3 keys), `bot-auth-worker[-staging].product-sre.workers.dev`, per-tenant `<uuid>.wba-bots.ai-audit.cfdata.org` (1–4 keys, `EdDSA`) | — | The `wba-bots.ai-audit.cfdata.org` pattern = Cloudflare-issued identities for customers' crawlers/agents **[likely]**. |
| Others with valid directories (survey 2026-10-19, `verdict=directory`): Anchor `api.anchorbrowser.io`; Apify `api.apify.com`; Manus `api.manus.im`; Exa `crawler.exa.ai` (2 keys); You.com `you.com`; Klaviyo `www.klaviyo.com`; Shopify `cloudsurf.shopify.io`; PayPal `agentic-crawler-directory.guidedcrawler.workers.dev`; Spotify `creators.spotify.com`; Wappalyzer `api.wappalyzer.com`; ADP `payroll-bot.adp.com`; Payhawk `external-bot.payhawk.com`; Channel3 `bot.trychannel3.com`; Rye `rye.xyz`; Strivve `signatures.cardsavr.io`; Firmly `api.firmly.online`; QA.tech `app.bugduck.tech`; Webmesh (`agent|dnsdoc|seo.webmesh.ai`, **EC P-256 + Ed25519**); Bixel, Lyrenth, Hark, Henry Labs, Hikari, InspiMark, InstaClaw, Lane, Milten, MrScraper, Nava Labs, Scovant, Vardia, Visually.io, Willow, Zipchat, Gemmetric, Cerebro, Atticus Health, A1 (`api-staging.aone.dev`), Caiged, codire, nippan.org, OBSIDIAAN, Pulso360, Riggle, AGI Inc `api.agi.tech`. | | | Survey file: https://modpagespeed.com/data/web-bot-auth-2026-10-19/results.tsv (396 URLs; 82 `directory` + 15 `directory only after redirect` + 299 none; 54 operators by our parse, 55 claimed). |
| **Not found (404/none):** Anthropic (`anthropic.com`, `www.anthropic.com`, `claude.ai`, `claude.com`), Perplexity (`perplexity.ai`, `www.perplexity.ai`), Apple, Common Crawl, Mistral, Bing/Microsoft, Vercel (`vercel.com`), Stytch, Steel, Anchor apex (`anchorbrowser.io`; API host has one). | | | |

Platform support: **Cloudflare** (Verified Bots "Request Signature" method via the BotBase submission form; Radar bots directory https://radar.cloudflare.com/verified-bots; AI Crawl Control policies by behaviour Search / Agent / Training with "Block on pages with ads"; legacy "Block AI bots" deprecating 2026-09-15), **Vercel** (bot verification supports Web Bot Auth since 2025-08-12; WAF rules can match the `Signature-Agent` header; BotID `checkBotId()` returns `isVerifiedBot`, `verifiedBotName` (e.g. `"chatgpt-operator"`), `verifiedBotCategory`), **HUMAN** (verifier service + email registration), **Akamai** (TechDocs page `bot-manager/docs/web-bot-auth` exists but is login-gated — support **[likely]**, details unverified), **Stytch** (example signer only).

### 7.5 Detection/attribution hooks from Web Bot Auth
- A verified signature gives a *strong positive identity* for the subset of agents that sign (OpenAI agent, Google-Agent sometimes, DuckAssist, hosted-browser vendors). Use it to label, not to allow by default: Browserbase/Kernel/Hyperbrowser signatures mean "someone's automation on a hosted browser" (purpose `rag`), which for most sites is still a bot.
- `Signature-Agent` present but unverifiable (unknown host, bad signature, expired, test key) = suspicious claim; count per host.
- Directory fetches must be SSRF-safe and rate-limited (an attacker can point `Signature-Agent` at arbitrary URLs); never follow redirects; cache negative lookups (per draft: discovery failures ≠ invalid, but policy may treat as unsigned).
- Keys with `nbf`/`exp` windows (Kernel: 1 h) imply frequent directory refetches; honour `Cache-Control` but cap at 24 h and refetch on unknown `keyid`.

---

## 8. Crawler economics & preference-signalling protocols (exact syntax)

| Mechanism | Exact syntax | Source |
|---|---|---|
| **Cloudflare Pay Per Crawl** (private beta) | Unpaid request → `HTTP/2 402` with `crawler-price: USD 0.01`. Crawler retries with `crawler-exact-price: USD 0.01` (must equal) or `crawler-max-price: USD 0.05` (ceiling; 402 if page price higher). Success `200` + `crawler-charged: USD 0.01`. Failure `402` + `crawler-error: InvalidCrawlerExactPrice`. Crawler must be Web-Bot-Auth verified and the payment header must be listed in the `signature-input` covered components. | https://developers.cloudflare.com/ai-crawl-control/features/pay-per-crawl/use-pay-per-crawl-as-ai-owner/crawl-pages/ |
| **RSL 1.0** (Really Simple Licensing, Recommendation 2025-12-10) | robots.txt `License: https://example.com/license.xml` (global or per `User-agent` group); HTTP `Link: <https://example.com/license.xml>; rel="license"; type="application/rsl+xml"`; HTML `<link rel="license" type="application/rsl+xml" href="…">` or inline `<script type="application/rsl+xml">`; XML `<rsl xmlns="https://rslstandard.org/rsl"><content url="/" server="…"><license><permits type="usage">ai-train</permits>…`; usage tokens `ai-train`, `ai-input`, `ai-index`, `ai-all`, `search`, `all`; `<payment type="purchase|subscription|training|crawl|use|contribution|attribution|free">`; License Server = OAuth AS implementing Open License Protocol with `/token`, `/introspect`, `/key`. | https://rslstandard.org/rsl |
| **IETF aipref** (`draft-ietf-aipref-attach-05`, 2026-08-19; `draft-ietf-aipref-vocab-08`, 2026-09-14, "does not reflect consensus") | Header `Content-Usage: train-ai=n` (SF Dictionary, representation metadata, no cache effect). robots.txt rule inside a group: `Content-Usage: train-ai=n` or path-scoped `Content-Usage: /ai-ok/ train-ai=y` (longest-prefix wins; only for crawlable paths). Vocabulary: `train-ai`, `ai-use`, `search` with values `y`/`n` (anything else = unknown); combination rule: any `n` ⇒ disallowed, else any `y` ⇒ allowed, else unknown; `search` overrides other categories. | https://datatracker.ietf.org/doc/html/draft-ietf-aipref-attach, …/draft-ietf-aipref-vocab |
| **Content Signals** (Cloudflare, 2025-09-24) | robots.txt line `Content-Signal: search=yes, ai-train=no` (keys `search`, `ai-input`, `ai-train`; values `yes`/`no`; omitted = no preference) preceded by a commented policy text asserting EU DSM Art. 4 reservation; auto-added for managed-robots.txt zones (without `ai-input`). | https://blog.cloudflare.com/content-signals-policy/ |
| **TDMRep** (W3C CG final 2024-02-02) | Response headers `tdm-reservation: 1` (or `0`), `tdm-policy: <url>`; `/.well-known/tdmrep.json` = array of `{"location": "/images/*.jpg", "tdm-reservation": 1, "tdm-policy": "…"}` (first match wins, `*` and `$` wildcards); `<meta name="tdm-reservation" content="1">`, `<meta name="tdm-policy" content="…">`; precedence well-known < header < meta < EPUB. | https://www.w3.org/community/reports/tdmrep/CG-FINAL-tdmrep-20240202/ |
| **noai / noimageai** (DeviantArt, 2022-11-11) | `<meta name="robots" content="noai">`, `<meta name="robots" content="noimageai">`; `X-Robots-Tag: noai` / `X-Robots-Tag: noimageai`. | https://www.deviantart.com/team/journal/UPDATE-All-Deviations-Are-Opted-Out-of-AI-Datasets-934500371 |
| **llms.txt** (Jeremy Howard, 2024-09-03; page modified 2026-08-10) | `/llms.txt` at root or any sub-path; H1 required, blockquote summary, H2 link-list sections (`- [name](url): notes`), "Optional" section; markdown twins `page.html.md` / `page.md`, `index.html.md`; discovery `rel="alternate" type="text/markdown"` and `rel="describedby"` (link element or `Link:` header). `/llms-full.txt` is **not** in the spec (convention only). | https://llmstxt.org/ |
| **Google tokens** | `Google-Extended` (training/grounding), `Applebot-Extended` (Apple training) — robots-only tokens with no UA. | Google/Apple docs above |

Detection use: requests for `/robots.txt`, `/llms.txt`, `/llms-full.txt`, `/.well-known/tdmrep.json`, `/.well-known/http-message-signatures-directory`, `/ai.txt`, `/sitemap.xml` *before* any HTML, and `Accept: text/markdown` or `.md` twins, are agent-only access patterns; respecting vs ignoring `Content-Usage`/`Content-Signal`/`tdm-reservation` can be measured per operator by serving honeypot paths disallowed only by these signals.

---

## 9. Payment / agentic-commerce identity layers

| Protocol | What appears on the wire | Status / source |
|---|---|---|
| **Visa Trusted Agent Protocol (TAP)** | RFC 9421 signatures on agent requests. Sample implementation (`visa/trusted-agent-protocol`): `Signature-Input: sig2=("@authority" "@path"); created=…; expires=<created+480>; keyId="primary-ed25519"; alg="ed25519"; nonce="<uuid4>"; tag="agent-browser-auth"` (product browsing) or `tag="agent-payer-auth"` (checkout); RSA variant `keyId="primary"; alg="rsa-pss-sha256"`; `Signature: sig2=:<b64>:`; headers injected into **every** Playwright request via `extra_http_headers`; `@path` includes the query string; **no `Signature-Agent`**; verifier (CDN proxy) fetches the public key from an "Agent Registry" by `keyId` (`AGENT_REGISTRY_URL`, local in the sample; no production JWKS path published). Note the non-RFC spelling `keyId` and the non-registry algorithm name `rsa-pss-sha256`. Visa's overview: "verifiable, cryptographic standard" built on RFC 9421; merchant "reconstruct[s] the signature_base string … then use[s] the agent's public key"; also "signatures to enable consumer recognition and payment" (details on a merchant-spec page we could not retrieve). | https://developer.visa.com/capabilities/trusted-agent-protocol/overview ; https://raw.githubusercontent.com/visa/trusted-agent-protocol/main/tap-agent/agent_app.py ; …/cdn-proxy/README.md |
| **OpenAI × Stripe Agentic Commerce Protocol (ACP)** | ChatGPT → merchant checkout API headers: `Authorization: Bearer <api_key>`, `Accept-Language: en-US`, `User-Agent: ChatGPT/2.0 (Mac OS X 15.0.1; arm64; build 0)` (example), `Idempotency-Key`, `Request-Id`, `Signature` ("Base64 encoded signature of the request body"; algorithm/key not specified in the spec), `Timestamp` (RFC 3339), `API-Version: 2025-09-12`, `Content-Type: application/json`; merchants echo `Idempotency-Key`/`Request-Id`; merchant webhooks signed with HMAC in `Merchant_Name-Signature`. | https://developers.openai.com/commerce/specs/checkout |
| **Google AP2 (Agent Payments Protocol)** | Roles: Shopping Agent, Credential Provider, Merchant, Merchant Payment Processor, Trusted Surface, Network/Issuer. Signed **Checkout Mandate** (cart + user confirmation; "Open"/"Closed" for human-not-present), **Payment Mandate** (to CP/merchant/network/issuer), merchant-signed cart; "an extension for … A2A, MCP, and Universal Commerce Protocol (UCP)". **No HTTP header names defined.** | https://raw.githubusercontent.com/google-agentic-commerce/AP2/main/docs/overview.md |
| **Mastercard Agent Pay / Agentic Tokens** | **[uncertain]** — press release returned 403, developer pages 404; no wire-format details verified. | — |
| **Vercel/bots.fyi `ryebot`** | "Powers automated checkout on behalf of shoppers with explicit consent" (category `ecommerce`); Rye also publishes a Web Bot Auth directory (`rye.xyz`). | https://vercel.com/docs/bot-management |

Implementation hook: treat any request carrying `Signature-Input` with `tag` ∈ {`agent-browser-auth`, `agent-payer-auth`} or ACP headers (`API-Version` + `Idempotency-Key` + `Request-Id` + `Signature` + `Timestamp`) as a declared commerce agent; verify when keys are obtainable, otherwise label "claimed".

---

## 10. Request-pattern signals (measured by others, with numbers)

- **No JavaScript execution**: "None of the major AI crawlers render JavaScript" — OpenAI (OAI-SearchBot, ChatGPT-User, GPTBot), Anthropic (ClaudeBot), Meta, ByteDance (Bytespider), Perplexity; they *fetch* JS files (ChatGPT 11.50 %, Claude 23.84 % of requests) but do not execute them; AppleBot and Gemini (Googlebot infra) do render. (Vercel, Dec 2024: https://vercel.com/blog/the-rise-of-the-ai-crawler)
- **Content-type mix**: ChatGPT 57.70 % HTML; Claude 35.17 % images; Googlebot 31.00 % HTML / 29.34 % JSON / 20.77 % text / 15.25 % JS.
- **Error behaviour**: 404 rates ChatGPT 34.82 %, Claude 34.16 % vs Googlebot 8.22 %; ChatGPT follows redirects 14.36 %; crawlers "often request outdated assets in the `/static/` folder" (stale URL memory).
- **Volumes (Vercel network, one month)**: Googlebot 4.5 B, GPTBot 569 M, Claude 370 M, AppleBot 314 M, PerplexityBot 24.4 M.
- **Geography**: ChatGPT from Des Moines/Phoenix (Azure), Claude from Columbus OH (GCP); "all measured AI crawlers operate from U.S. data centers".
- **Stealth crawling (Cloudflare, 2025-08)**: Perplexity's declared crawler 20–25 M req/day; undeclared crawler 3–6 M req/day with generic Chrome/124 macOS UA, IPs outside the published list, rotated when blocked, across multiple ASNs; fetched content from fresh unindexed domains whose robots.txt disallowed everything — "not checking for the presence of a robots.txt file". OpenAI's ChatGPT-User by contrast stopped at robots.txt / block pages with no follow-up from other UAs.
- **robots.txt mechanics useful as probes**: Amazon caches robots.txt ≤ 30 days and treats fetch failure as "nonexistent"; Meta caches 24 h; OpenAI/Google user-triggered fetchers ignore robots; MCP fetch refuses on 401/403 of robots.txt; OpenAI's robots fetch uses a distinct UA variant (`…; robots.txt; …`).
- **Pattern features to compute per client/session** (edge): (1) first request path (`/robots.txt`, `/llms.txt`, `/sitemap.xml`, `/.well-known/*` vs `/`); (2) HTML:asset ratio and absence of CSS/image/font requests after an HTML 200 (browser-UA + zero subresources = fetch library or headless with resource blocking); (3) cookie persistence (Set-Cookie never echoed); (4) `Referer` absence on deep pages; (5) breadth-first link coverage and inter-request timing regularity; (6) HEAD-before-GET, `Range` use, `If-Modified-Since` with stale dates; (7) `Accept-Language` absence; (8) TLS session reuse across "unrelated" IPs (shared ticket cache = fleet); (9) JA4/ASN/UA cardinality stats as in Cloudflare's JA4 Signals; (10) reaction to 402/403/429 and to `Accept-Signature` (a cooperative agent retries signed; a scraper rotates UA/IP).

---

## 11. End-to-end identification pipeline (recommended)

1. **Transport capture** (edge): ClientHello → JA3, JA4, JA4_r, JA4_o, GREASE flag, ALPN list order, session-resumption flag; TCP → JA4T (TTL/window/options) when available; HTTP/2 → Akamai fingerprint + HEADERS priority fields + header list order; HTTP/1.1 → ordered header-name list + casing + exact `Accept*`/`Connection` values; HTTP/3 → QUIC transport params (future).
2. **Library attribution**: match (`b` cipher hash, `c` ext hash variants, Akamai fp, header-order signature, UA) against the table in Section 3 → library/runtime with confidence; unknown JA4s go to an "observed" store with the aggregates from Section 2.6.
3. **Declared identity**: parse UA tokens against the catalogue (Section 6) and `Signature-Agent` / `Signature-Input` (Section 7). Declared ⇒ verify: IP-list membership (feeds in Section 5.2, refreshed ≤ 24 h, keyed by token), FCrDNS where published (5.5), Web Bot Auth (7.3). Outcomes: `verified`, `claimed-unverified`, `impersonated` (UA token with IP outside list and no signature → e.g. fake Googlebot/GPTBot).
4. **Browser claim consistency**: C1–C12 (Section 4). Any hard contradiction (C1, C2, C4, C8) ⇒ "spoofed browser UA", attribute to the real stack from step 2.
5. **Network context**: ASN class (cloud/hosting/residential/mobile/relay) from Section 5 feeds; Private Relay list; residential-proxy flags (Spur/IPinfo) when licensed; per-ASN request aggregates.
6. **Behaviour**: Section 10 features over the session; JS-SDK token presence (client-side half of the product) — absence after an HTML 200 from a browser-UA is itself a strong signal.
7. **Decision**: label ∈ {verified-search-crawler, verified-ai-crawler(training), verified-ai-assistant(user-triggered), verified-agent(signed), hosted-browser-automation, fetch-library (named), spoofed-browser, residential-proxy-browser, human}, with the contributing evidence list for review/replay. Actions (block/challenge/degrade/decoy/tarpit/redirect-to-gateway/label/log) key off the label plus site policy (RSL/aipref/Content-Signal/Pay-Per-Crawl state).

---

## 12. Unknowns / things we could not verify this session

1. Real-browser reference JA4/Akamai values for current Chrome 150+/Firefox 147/Safari 26 were **not** measured (only curl_cffi's imitations); the detector needs a live baseline table (JA4 `c` sections differ from FoxIO's 2023 example `e5627efa2ab1`).
2. Whether current Firefox still sends the five PRIORITY frames (curl_cffi's Firefox profile does not).
3. Bingbot UA strings and `search.msn.com` rDNS (Bing help pages are JS-rendered); Amazonbot rDNS `crawl.amazonbot.amazon`; Meta IP retrieval via `AS32934` whois.
4. Full ClaudeBot/Claude-User UA strings (support page gives tokens only); Claude for Chrome / computer-use fetchers have no published server-side identifier; Anthropic has no Web Bot Auth directory.
5. Perplexity Comet, OpenAI Atlas, Gemini-in-Chrome, Edge Copilot: no server-side identifiers published; they present as the host browser (client-side detection area).
6. Whether `chatgpt.com`'s key covers Operator/Atlas as well as "ChatGPT agent" (OpenAI publishes no doc; Cloudflare says "ChatGPT Agent signs").
7. Attribution of `cursorusercontent.com` directory to xAI vs Cursor (Radar lists it under xAI/Grok Bot; the host belongs to Cursor).
8. Akamai Bot Manager's Web Bot Auth behaviour (TechDocs login-gated); Mastercard Agent Pay wire format; Visa TAP merchant spec page (404); Google's "authenticate with Web Bot Auth" guide URL (404 at guessed path).
9. JA4DB access: the FoxIO database moved to `ja4db.foxio.io` with auth endpoints (`/api/auth/token/`, `/api/signup/requests/`); the old public dump is gone — licensing/API terms unknown.
10. LangChain WebBaseLoader, Firecrawl, Jina Reader default headers (sources moved/404).
11. Cloudflare WARP egress ranges (only ingress documented) and `cf.verified_bot_category` enumerated values (field page lists none).
12. HTTP/3 fingerprints for any library (not measured; tls.peet.ws oracle used over TCP only).

---

## 13. Sources (all accessed 2026-10-24)

IETF / standards
- https://datatracker.ietf.org/doc/html/draft-ietf-webbotauth-httpsig-protocol (protocol-00, 2026-09-01)
- https://datatracker.ietf.org/wg/webbotauth/documents/
- https://datatracker.ietf.org/doc/html/draft-meunier-web-bot-auth-architecture (-05, replaced)
- https://datatracker.ietf.org/doc/html/draft-meunier-http-message-signatures-directory (-05, replaced)
- https://www.rfc-editor.org/rfc/rfc9421.html
- https://datatracker.ietf.org/doc/html/draft-ietf-aipref-attach (-05) ; https://datatracker.ietf.org/doc/html/draft-ietf-aipref-vocab (-08)
- https://www.w3.org/community/reports/tdmrep/CG-FINAL-tdmrep-20240202/
- https://wicg.github.io/ua-client-hints/ ; https://w3c.github.io/webappsec-fetch-metadata/
- https://rslstandard.org/rsl ; https://llmstxt.org/ ; https://blog.cloudflare.com/content-signals-policy/
- https://www.deviantart.com/team/journal/UPDATE-All-Deviations-Are-Opted-Out-of-AI-Datasets-934500371

Fingerprint formats / tooling
- https://raw.githubusercontent.com/FoxIO-LLC/ja4/main/technical_details/JA4.md ; https://github.com/FoxIO-LLC/ja4/blob/main/technical_details/JA4H.md
- https://www.blackhat.com/docs/eu-17/materials/eu-17-Shuster-Passive-Fingerprinting-Of-HTTP2-Clients-wp.pdf
- https://tls.peet.ws/api/all (measurement oracle) ; https://ja4db.foxio.io/ (formerly ja4db.com/api/read/, now 404)
- https://raw.githubusercontent.com/lexiforest/curl-impersonate/main/README.md ; https://raw.githubusercontent.com/lexiforest/curl_cffi/main/README.md ; https://raw.githubusercontent.com/bogdanfinn/tls-client/master/profiles/profiles.go
- https://developers.cloudflare.com/ruleset-engine/rules-language/fields/dynamic-fields/ ; https://developers.cloudflare.com/bots/additional-configurations/ja3-ja4-fingerprint/ ; …/signals-intelligence/ ; https://developers.cloudflare.com/bots/llms.txt

Library sources (default headers)
- https://raw.githubusercontent.com/psf/requests/main/src/requests/utils.py ; https://raw.githubusercontent.com/aio-libs/aiohttp/master/aiohttp/client_reqrep.py ; https://raw.githubusercontent.com/scrapy/scrapy/master/scrapy/settings/default_settings.py
- https://raw.githubusercontent.com/nodejs/undici/main/lib/web/fetch/index.js ; https://raw.githubusercontent.com/node-fetch/node-fetch/main/src/request.js ; https://raw.githubusercontent.com/axios/axios/v1.x/lib/adapters/http.js ; https://raw.githubusercontent.com/axios/axios/v1.x/lib/defaults/index.js ; https://raw.githubusercontent.com/sindresorhus/got/main/source/core/options.ts
- Go 1.26.5 GOROOT `src/net/http/request.go`, `h2_bundle.go` (local)
- https://raw.githubusercontent.com/openjdk/jdk/master/src/java.net.http/share/classes/jdk/internal/net/http/HttpRequestImpl.java ; https://raw.githubusercontent.com/openjdk/jdk/master/src/java.base/share/classes/sun/net/www/protocol/http/HttpURLConnection.java
- https://raw.githubusercontent.com/square/okhttp/parent-4.12.0/okhttp/src/main/kotlin/okhttp3/internal/Util.kt ; https://raw.githubusercontent.com/square/okhttp/master/okhttp/src/commonJvmAndroid/kotlin/okhttp3/internal/http/BridgeInterceptor.kt
- https://raw.githubusercontent.com/mirror/wget/master/src/http.c ; https://raw.githubusercontent.com/curl/curl/master/lib/http.c
- https://raw.githubusercontent.com/denoland/deno/main/cli/lib/version.rs ; https://bun.com/docs/api/fetch
- https://raw.githubusercontent.com/modelcontextprotocol/servers/main/src/fetch/src/mcp_server_fetch/server.py ; https://raw.githubusercontent.com/unclecode/crawl4ai/main/crawl4ai/async_configs.py

Bot operator documentation
- https://developers.openai.com/api/docs/bots ; https://openai.com/gptbot.json ; https://openai.com/searchbot.json ; https://openai.com/chatgpt-user.json ; https://openai.com/adsbot.json ; https://chatgpt.com/.well-known/http-message-signatures-directory
- https://support.claude.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web-and-how-can-site-owners-block-the-crawler ; https://claude.com/crawling/bots.json
- https://developers.google.com/search/docs/crawling-indexing/google-common-crawlers ; …/google-special-case-crawlers ; …/google-user-triggered-fetchers ; https://developers.google.com/crawling/docs/crawlers-fetchers/google-agent ; https://developers.google.com/crawling/docs/crawlers-fetchers/verify-google-requests ; https://developers.google.com/static/crawling/ipranges/{common-crawlers,special-crawlers,user-triggered-fetchers,user-triggered-fetchers-google,user-triggered-agents}.json ; https://agent.bot.goog/.well-known/http-message-signatures-directory
- https://docs.perplexity.ai/guides/bots ; https://www.perplexity.com/perplexitybot.json ; https://www.perplexity.com/perplexity-user.json ; https://blog.cloudflare.com/perplexity-is-using-stealth-undeclared-crawlers-to-evade-website-no-crawl-directives/
- https://developer.amazon.com/amazonbot ; https://developer.amazon.com/amazonbot/ip-addresses/
- https://support.apple.com/en-us/119829 ; https://search.developer.apple.com/applebot.json ; https://developer.apple.com/support/prepare-your-network-for-icloud-private-relay/ ; https://mask-api.icloud.com/egress-ip-ranges.csv
- https://developers.facebook.com/docs/sharing/webmasters/web-crawlers ; https://developers.facebook.com/docs/sharing/webmasters/crawler/ ; https://www.meta.com/.well-known/http-message-signatures-directory
- https://knownagents.com/agents/bytespider ; https://commoncrawl.org/ccbot ; https://index.commoncrawl.org/ccbot.json ; https://duckduckgo.com/duckduckgo-help-pages/results/duckduckbot/ ; https://assistbot.duckduckgo.com/.well-known/http-message-signatures-directory ; https://www.bing.com/toolbox/bingbot.json
- https://raw.githubusercontent.com/ai-robots-txt/ai.robots.txt/main/robots.json ; https://modpagespeed.com/blog/which-ai-crawlers-sign-their-requests/ ; https://modpagespeed.com/data/web-bot-auth-2026-10-19/results.tsv
- https://www.browserbase.com/.well-known/http-message-signatures-directory ; https://www.hyperbrowser.ai/… ; https://www.kernel.sh/… ; https://www.browserless.io/… ; https://cursorusercontent.com/…

Platforms / vendors
- https://developers.cloudflare.com/bots/concepts/bot/verified-bots/web-bot-auth/ ; https://developers.cloudflare.com/bots/concepts/bot/verified-bots/ ; https://developers.cloudflare.com/bots/reference/bot-verification/ip-validation/ ; https://developers.cloudflare.com/bots/additional-configurations/block-ai-bots/ ; https://developers.cloudflare.com/ai-crawl-control/ ; https://developers.cloudflare.com/ai-crawl-control/features/pay-per-crawl/use-pay-per-crawl-as-ai-owner/crawl-pages/ ; https://developers.cloudflare.com/cloudflare-one/connections/connect-devices/warp/deployment/firewall/
- https://raw.githubusercontent.com/cloudflare/web-bot-auth/main/README.md ; https://raw.githubusercontent.com/cloudflare/web-bot-auth/main/packages/web-bot-auth/README.md ; https://raw.githubusercontent.com/HumanSecurity/human-verified-ai-agent/main/README.md
- https://vercel.com/docs/bot-management ; https://vercel.com/docs/botid ; https://vercel.com/docs/botid/verified-bots ; https://vercel.com/changelog/vercels-bot-verification-now-supports-web-bot-auth ; https://bots.fyi ; https://vercel.com/blog/the-rise-of-the-ai-crawler
- https://developer.visa.com/capabilities/trusted-agent-protocol/overview ; https://raw.githubusercontent.com/visa/trusted-agent-protocol/main/tap-agent/agent_app.py ; https://raw.githubusercontent.com/visa/trusted-agent-protocol/main/cdn-proxy/README.md ; https://developers.openai.com/commerce/specs/checkout ; https://raw.githubusercontent.com/google-agentic-commerce/AP2/main/docs/overview.md

IP / ASN data
- https://ip-ranges.amazonaws.com/ip-ranges.json ; https://www.gstatic.com/ipranges/cloud.json ; https://www.gstatic.com/ipranges/goog.json ; https://download.microsoft.com/download/7/1/D/71D86715-5596-4529-9B13-DA13A5DE5B63/ServiceTags_Public_20261019.json ; https://docs.oracle.com/en-us/iaas/tools/public_ip_ranges.json ; https://digitalocean.com/geo/google.csv ; https://geoip.linode.com/ ; https://geofeed.constant.com/ ; https://www.cloudflare.com/ips-v4 ; https://api.fastly.com/public-ip-list
- https://iptoasn.com/ ; https://github.com/ipverse/asn-ip ; https://ipinfo.io/lite ; https://ipinfo.io/products/proxy-vpn-detection-api ; https://dev.maxmind.com/geoip/geolite2-free-geolocation-data/ ; https://docs.spur.us/context-api

Raw measurement artefacts (scratchpad, session-local): `/private/tmp/claude-501/-Users-dev-Projects-necter/3044e935-0f92-4a55-99e9-6a0b4223c15f/scratchpad/out/peet_*.json`, `…/out/captured.jsonl`, `…/docker/out/peet_*.json`, `…/wba/*.hdr|*.body`, `…/ipranges/*`, `…/downloads/wba_results.tsv`.
