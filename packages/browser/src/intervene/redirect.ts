import type { InterventionHandler } from '../types.js';

export const redirectHandler: InterventionHandler = (action, ctx) => {
  if (typeof location === 'undefined') return false;
  const to = String(action.params?.['to'] ?? ctx.config.text.gatewayUrl);
  if (location.pathname === to) return true;
  location.assign(to);
  return true;
};
