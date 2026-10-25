# Contributing to Necter

Thanks for helping. Bug reports, missed agents, new signatures and code are all welcome.

## Set up

```bash
git clone https://github.com/necterai/core.git && cd core
corepack enable
pnpm install
pnpm build
pnpm test
```

Node 20 or later. `pnpm zoo` runs real browser-automation agents against the demo shop and needs Playwright's browsers (`pnpm --filter @necterai/zoo exec playwright install chromium`).

## Layout

| Path | |
| --- | --- |
| `packages/core` | Taxonomy, signal catalog, scoring, policy, events |
| `packages/browser` | Browser SDK |
| `packages/server` | Server and edge SDK, framework adapters |
| `packages/signatures` | Agent knowledge base (`pnpm sync:signatures` refreshes published IP ranges) |
| `apps/collector` | Self-hosted script host and dashboard |
| `apps/demo` | Demo shop used by the zoo |
| `apps/zoo` | Agent simulators and the detection matrix |
| `docs/design` | Architecture and the signal-by-signal spec |

## Rules for detection changes

- Every new signal needs a unit test, and a check that it doesn't fire for ordinary humans: no extensions, password managers, screen readers and other accessibility tools, mobile browsers.
- Explain the evidence in plain words (`summary`): the console shows it to site owners.
- Prefer signals that are hard to fake over ones that are easy to remove.
- Don't publish step-by-step bypasses in issues or pull requests; see [SECURITY.md](./SECURITY.md).

## Releasing (maintainers)

```bash
pnpm version:set 0.2.0
git commit -am "v0.2.0"
git tag v0.2.0
git push --follow-tags     # the Release workflow tests and publishes to npm
```

By contributing you agree that your contributions are licensed under the [MIT License](./LICENSE).
