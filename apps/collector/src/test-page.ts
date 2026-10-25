import { scriptTag } from './proxy.js';

/**
 * A small multi-page site served by the collector itself, so there is always
 * something to point an agent at: a catalogue with prices, an article, and a form.
 */
const PRODUCTS = [
  { id: 1, name: 'Field notebook, A5 dot grid', price: 18, stock: 42, blurb: 'Lay-flat binding, 120 gsm paper, 192 pages.' },
  { id: 2, name: 'Brass mechanical pencil', price: 46, stock: 9, blurb: '0.7 mm lead, knurled grip, refillable eraser.' },
  { id: 3, name: 'Desk tray, walnut', price: 64, stock: 15, blurb: 'Solid walnut, oiled finish, 30 × 20 cm.' },
  { id: 4, name: 'Fountain pen ink, slate', price: 14, stock: 120, blurb: '50 ml bottle, water-based, quick drying.' },
];

function layout(title: string, body: string, opts: { mode: 'monitor' | 'enforce'; debug: boolean }): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
${scriptTag({ src: '/__necter/script.js', site: 'test-page', mode: opts.mode, debug: opts.debug })}
<title>${title} · Paper & Brass (necter test shop)</title>
<style>
:root{--ink:#131416;--muted:#5d5f60;--ground:#fbfaf7;--line:#e7e4dc;--accent:#1b6c80}
*{box-sizing:border-box}body{margin:0;background:var(--ground);color:var(--ink);font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
header,main,footer{max-width:960px;margin:0 auto;padding:0 24px}
header{display:flex;align-items:center;justify-content:space-between;height:64px}
header a{color:inherit;text-decoration:none}header nav{display:flex;gap:20px}header nav a{color:var(--muted)}header nav a:hover{color:var(--ink)}
.brand{font-weight:600}h1{font-size:40px;line-height:1.1;letter-spacing:-.02em;margin:40px 0 12px}
.lead{font-size:18px;color:var(--muted);max-width:60ch;margin:0 0 32px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:16px}
.card{display:block;background:#fff;border:1px solid var(--line);border-radius:10px;padding:18px;color:inherit;text-decoration:none}
.card:hover{border-color:#cfcabe}.price{font-weight:600;font-variant-numeric:tabular-nums}
.btn{display:inline-block;background:var(--ink);color:#fff;border:0;border-radius:8px;padding:10px 16px;font:inherit;cursor:pointer;text-decoration:none}
form{display:grid;gap:14px;max-width:440px}label{display:grid;gap:4px;font-size:14px;color:var(--muted)}
input,textarea{font:inherit;padding:10px;border:1px solid var(--line);border-radius:8px;background:#fff}
article p{max-width:66ch}footer{color:var(--muted);font-size:14px;padding-top:48px;padding-bottom:48px}
table{border-collapse:collapse;width:100%;max-width:520px}td,th{text-align:left;padding:8px 0;border-bottom:1px solid var(--line)}td.num{text-align:right;font-variant-numeric:tabular-nums}
</style></head><body>
<header><a class="brand" href="/test">Paper &amp; Brass</a><nav><a href="/test/products">Shop</a><a href="/test/article">Journal</a><a href="/test/contact">Contact</a></nav></header>
<main>${body}</main>
<footer>A test shop served by the necter collector. Every visit shows up on the <a href="/__necter/ui/">dashboard</a>.</footer>
</body></html>`;
}

export function testPage(opts: { page: string; mode: 'monitor' | 'enforce'; debug: boolean }): string {
  const page = opts.page.replace(/\/$/, '') || '/';
  const product = /^\/products\/(\d+)$/.exec(page);
  if (product) {
    const p = PRODUCTS.find((x) => x.id === Number(product[1]));
    if (p) {
      return layout(p.name, `<h1>${p.name}</h1><p class="lead">${p.blurb}</p>
<table class="price-table" data-sensitive><tr><th>Price</th><td class="num price">$${p.price.toFixed(2)}</td></tr><tr><th>In stock</th><td class="num">${p.stock}</td></tr><tr><th>Ships</th><td class="num">2 working days</td></tr></table>
<p style="margin-top:24px"><button class="btn" type="button" data-add="${p.id}" onclick="this.textContent='Added to bag'">Add to bag</button></p>`, opts);
    }
  }
  if (page === '/products') {
    return layout('Shop', `<h1>Shop</h1><p class="lead">Four things for a good desk. Prices include shipping in the US.</p>
<div class="grid">${PRODUCTS.map((p) => `<a class="card" href="/test/products/${p.id}"><strong>${p.name}</strong><br><span class="price">$${p.price.toFixed(2)}</span><br><small>${p.blurb}</small></a>`).join('')}</div>`, opts);
  }
  if (page === '/article') {
    return layout('Journal', `<article><h1>Why we still sell pencils</h1><p class="lead">A short note from the workshop.</p>
<p>Most of what we sell will outlast the screen you are reading this on. A brass pencil is a small, heavy, quiet object: it does one job and it does it for decades.</p>
<p>We make our trays from offcuts left over from a furniture maker down the road. Each one has a slightly different grain, which is why the photographs never quite match what arrives.</p>
<p>Our notebooks are bound in Porto by a family business that has been stitching paper since 1948. We visit twice a year and we always come back with more than we planned.</p></article>`, opts);
  }
  if (page === '/contact') {
    return layout('Contact', `<h1>Contact</h1><p class="lead">Questions about an order, or wholesale? We answer within a day.</p>
<form method="get" action="/test/thanks"><label>Name<input name="name" autocomplete="name"></label><label>Email<input name="email" type="email" autocomplete="email"></label><label>Message<textarea name="message" rows="4"></textarea></label><button class="btn" type="submit">Send message</button></form>`, opts);
  }
  if (page === '/thanks') return layout('Thanks', `<h1>Thanks</h1><p class="lead">Message received. We will reply soon.</p><p><a href="/test">Back to the shop</a></p>`, opts);
  return layout('Home', `<h1>Good tools for a desk</h1><p class="lead">Notebooks, pencils and trays made to last. Browse the <a href="/test/products">shop</a>, read the <a href="/test/article">journal</a>, or <a href="/test/contact">get in touch</a>.</p>
<div class="grid">${PRODUCTS.slice(0, 3).map((p) => `<a class="card" href="/test/products/${p.id}"><strong>${p.name}</strong><br><span class="price">$${p.price.toFixed(2)}</span></a>`).join('')}</div>`, opts);
}
