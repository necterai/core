/** Small DOM helpers that work under strict CSP (no inline style attributes/elements). */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, styles: Partial<CSSStyleDeclaration> = {}, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node.style, styles);
  if (text !== undefined) node.textContent = text;
  return node;
}

export function overlayRoot(id: string): HTMLDivElement {
  const existing = document.getElementById(id) as HTMLDivElement | null;
  if (existing) return existing;
  const root = el('div', {
    position: 'fixed',
    inset: '0',
    zIndex: '2147483647',
    background: 'rgba(17, 24, 39, 0.96)',
    color: '#f9fafb',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
    textAlign: 'center',
    padding: '24px',
  });
  root.id = id;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  (document.body ?? document.documentElement).appendChild(root);
  return root;
}
