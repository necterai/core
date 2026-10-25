import type { InterventionHandler } from '../types.js';

/** Client-side decoy is a no-op placeholder: decoys are served by the server action. */
export const decoyHandler: InterventionHandler = (_action, ctx) => {
  ctx.log('decoy requested (server-side action)');
  return false;
};
