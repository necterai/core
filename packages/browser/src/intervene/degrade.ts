import type { InterventionHandler } from '../types.js';

/**
 * Degrade: keep the page usable for a person but reduce its value to a scraper.
 * Level 'light' hides elements matching `sensitiveSelectors`; 'scramble' replaces
 * their text content with a visually identical rendering whose DOM text is
 * shuffled (implemented by the module phase via a glyph-remapped font).
 */
export const degradeHandler: InterventionHandler = (action, ctx) => {
  if (typeof document === 'undefined') return false;
  const level = (action.params?.['level'] as string | undefined) ?? 'light';
  let touched = 0;
  for (const selector of ctx.config.sensitiveSelectors) {
    let nodes: NodeListOf<Element>;
    try {
      nodes = document.querySelectorAll(selector);
    } catch {
      continue;
    }
    nodes.forEach((node) => {
      const eln = node as HTMLElement;
      if (eln.dataset['necterDegraded']) return;
      eln.dataset['necterDegraded'] = level;
      if (level === 'hide') {
        eln.style.visibility = 'hidden';
      } else {
        eln.setAttribute('aria-hidden', 'false');
        eln.style.userSelect = 'none';
      }
      touched++;
    });
  }
  ctx.log('degrade', level, touched);
  return touched > 0;
};
