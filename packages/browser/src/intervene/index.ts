import type { Action, ActionKind } from '@necterai/core';
import type { InterventionContext, InterventionHandler, ResolvedConfig } from '../types.js';
import { blockHandler } from './block.js';
import { labelHandler } from './label.js';
import { challengeHandler, runChallenge } from './challenge.js';
import { degradeHandler } from './degrade.js';
import { decoyHandler } from './decoy.js';
import { tarpitHandler } from './tarpit.js';
import { limitHandler } from './limit.js';
import { redirectHandler } from './redirect.js';

export interface InterventionRunner {
  run(action: Action, ctx: InterventionContext): Promise<boolean>;
  challenge(ctx: InterventionContext): Promise<boolean>;
}

const observe: InterventionHandler = () => true;
const notify: InterventionHandler = (action, ctx) => {
  ctx.log('notify', action.params);
  return true;
};

export function createInterventionRunner(config: ResolvedConfig): InterventionRunner {
  const handlers: Record<ActionKind, InterventionHandler> = {
    allow: () => true,
    observe,
    notify,
    label: labelHandler,
    limit: limitHandler,
    tarpit: tarpitHandler,
    degrade: degradeHandler,
    decoy: decoyHandler,
    challenge: challengeHandler,
    redirect: redirectHandler,
    block: blockHandler,
    ...config.interventions,
  };
  return {
    async run(action, ctx) {
      const handler = handlers[action.kind];
      if (!handler) return false;
      // In monitor mode only non-visible actions execute locally.
      if (config.mode === 'monitor' && !['allow', 'observe', 'notify', 'label'].includes(action.kind)) {
        ctx.log('monitor mode: skipping', action.kind);
        return false;
      }
      return handler(action, ctx);
    },
    challenge: (ctx) => runChallenge(ctx),
  };
}
