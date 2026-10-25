# @necterai/signatures

A maintained knowledge base of AI agents, AI crawlers and automation stacks, used by [Necter](https://github.com/necterai/core):

- agent records: user-agent patterns, robots.txt tokens, published IP range sources, rDNS suffixes, Web Bot Auth key directories,
- automation globals and DOM artifacts (Playwright, Puppeteer, Selenium, CDP, agent frameworks),
- agentic extension ids,
- HTTP-library fingerprints (Python `requests`, undici, `curl`, Go…).

```ts
import { agents, matchUserAgent } from '@necterai/signatures';

matchUserAgent('Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)');
// → [{ record: { id: 'gptbot', provider: 'openai', product: 'GPTBot', class: 'ai-crawler', … }, … }]
```

Corrections and new agents are welcome: open a pull request at [necterai/core](https://github.com/necterai/core).

## License

MIT
