# @necterai/core

The shared engine behind [Necter](https://github.com/necterai/core): agent taxonomy, signal catalog, capped log-odds scoring with ordered evidence, the policy engine (`defaultPolicy`, `decide`) and the session event schema. Isomorphic, zero dependencies.

You usually don't install this directly; [`@necterai/browser`](https://www.npmjs.com/package/@necterai/browser) and [`@necterai/server`](https://www.npmjs.com/package/@necterai/server) depend on it. Use it to write your own policy, your own signals, or an event sink:

```ts
import { defaultPolicy, createFanoutSink, createConsoleSink } from '@necterai/core';
```

## License

MIT
