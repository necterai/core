const catalog = Array.from({ length: 12 }, (_, i) => ({
  id: i + 1,
  name: ['Aurora Lamp', 'Cedar Desk', 'Fjord Chair', 'Granite Mug', 'Harbor Rug', 'Ivy Planter', 'Juniper Shelf', 'Kestrel Clock', 'Linen Throw', 'Maple Tray', 'Nimbus Pillow', 'Orchid Vase'][i]!,
  price: [129, 899, 349, 24, 459, 39, 219, 89, 69, 45, 59, 79][i]!,
  sku: `SKU-${1000 + i}`,
  stock: (i * 7) % 23,
  description: 'A thoughtfully made object for everyday use. Sustainably sourced materials, assembled by hand, backed by a ten-year guarantee.',
}));

function layout(mode: string, title: string, body: string, active = ''): string {
  const nav = ['/', '/products', '/article', '/contact']
    .map((h) => `<a href="${h}"${h === active ? ' aria-current="page"' : ''}>${h === '/' ? 'Home' : h.slice(1)[0]!.toUpperCase() + h.slice(2)}</a>`)
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · Demo Shop</title><link rel="stylesheet" href="/static/site.css"><script src="/__necter/script.js" data-necter data-mode="${mode}" data-endpoint="/__necter" data-debug data-trusted="/static/" data-sensitive=".price,.sku,article"></script></head><body><header><strong>Demo Shop</strong><nav>${nav}</nav><span class="mode">mode: ${mode}</span></header><main>${body}</main><footer>necter demo · <a href="/.well-known/agent-access">agent access</a></footer><script src="/static/site.js" defer></script></body></html>`;
}

export const pages = {
  catalog,
  home: (mode: string) => layout(mode, 'Home', `<h1>Welcome to the demo shop</h1><p>This site is protected by necter. Browse the <a href="/products">products</a>, read the <a href="/article">article</a>, or <a href="/contact">contact us</a>.</p><section class="grid">${catalog.slice(0, 4).map(card).join('')}</section>`, '/'),
  products: (mode: string) => layout(mode, 'Products', `<h1>Products</h1><p><button id="load-more" type="button">Load prices via API</button> <span id="api-status" aria-live="polite"></span></p><section class="grid" id="grid">${catalog.map(card).join('')}</section>`, '/products'),
  product: (mode: string, id: number) => {
    const p = catalog.find((x) => x.id === id);
    if (!p) return layout(mode, 'Not found', '<h1>Not found</h1>');
    return layout(mode, p.name, `<article><h1>${p.name}</h1><p class="price">$${p.price}</p><p class="sku">${p.sku} · ${p.stock} in stock</p><p>${p.description}</p><button type="button" data-add="${p.id}">Add to cart</button></article>`, '/products');
  },
  article: (mode: string) => layout(mode, 'Article', `<article><h1>How we choose our materials</h1>${Array.from({ length: 8 }, (_, i) => `<p>Paragraph ${i + 1}. We work with small workshops and certified forests. Every piece is tested for durability and finished with natural oils. Pricing reflects fair wages and transparent sourcing, which is why our catalogue changes slowly and deliberately.</p>`).join('')}<h2>Comments</h2><form id="comment" action="/contact" method="post"><label>Comment <textarea name="message" rows="3"></textarea></label><button type="submit">Post</button></form></article>`, '/article'),
  contact: (mode: string) => layout(mode, 'Contact', `<h1>Contact</h1><form action="/contact" method="post" id="contact-form"><label>Name <input name="name" autocomplete="name"></label><label>Email <input name="email" type="email" autocomplete="email"></label><label>Message <textarea name="message" rows="4"></textarea></label><button type="submit">Send</button></form>`, '/contact'),
  thanks: (mode: string) => layout(mode, 'Thanks', '<h1>Thanks</h1><p>We will get back to you.</p>'),
};

function card(p: (typeof catalog)[number]): string {
  return `<a class="card" href="/products/${p.id}"><h3>${p.name}</h3><span class="price">$${p.price}</span></a>`;
}
