/* ============================================================================
 * Expoline — Guest QR self order & pay.
 * Standalone: included via <script src="/views/guest.js"> in guest.html,
 * served by the LOCAL server at /g/:token (works on the LAN when the
 * internet is down). Builds its own DOM + styles; not wired into staff nav.
 *
 * Flow: menu (seat picker) → cart → SEND (fires KDS immediately) →
 * check → self-split (by seat / even) → pay (demo card now, cash via
 * staff-collect request) → optional 1-tap review nudge.
 *
 * Reader-ready: card payments post {method:'card_demo'} today; a real
 * terminal adds method 'card' + terminal fields at /api/guest/pay.
 * ========================================================================== */
(function () {
'use strict';

var TOKEN = (function () {
  var m = location.pathname.match(/^\/g\/([A-Za-z0-9-]+)/);
  if (m) return m[1];
  m = location.search.match(/[?&]t=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : null;
})();
/* Check deep-link mode: /g/check/<guest_token> or ?c=<guest_token> opens one
   check directly (used by self-split share links). */
var CHECK_TOKEN = (function () {
  var m = location.pathname.match(/^\/g\/check\/([A-Za-z0-9-]+)/);
  if (m) return m[1];
  m = location.search.match(/[?&]c=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : null;
})();

var css = [
  ':root{--ink:#0e1420;--ink2:#141b2b;--ink3:#1b2438;--brass:#c9a86a;--brass-hi:#e3c78e;',
  '--text:#ece7db;--dim:#a8a294;--green:#3ed598;--red:#ec6f6f;--blue:#5aa9ff;--line:#2a3650}',
  '*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}',
  'html,body{margin:0;padding:0}',
  'body{background:var(--ink);color:var(--text);font-family:system-ui,-apple-system,"Segoe UI",sans-serif;font-size:18px}',
  '#gx{min-height:100vh;display:flex;flex-direction:column;max-width:720px;margin:0 auto}',
  '#gx-head{background:var(--ink2);border-bottom:2px solid var(--line);padding:14px 18px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:5}',
  '#gx-head h1{margin:0;font-size:22px;color:var(--brass);letter-spacing:.5px}',
  '#gx-head .sub{font-size:13px;color:var(--dim)}',
  '#gx-body{flex:1;padding:16px 16px 120px}',
  '.gx-err{background:#3a1d22;border:1px solid var(--red);border-radius:12px;padding:18px;margin:24px 0}',
  '.gx-cats{display:flex;gap:8px;overflow-x:auto;padding:4px 0 12px;position:sticky;top:73px;background:var(--ink);z-index:4}',
  '.gx-cat{background:var(--ink3);border:1px solid var(--line);color:var(--text);border-radius:999px;padding:10px 18px;font-size:16px;white-space:nowrap;cursor:pointer;min-height:48px}',
  '.gx-cat.on{background:var(--brass);color:#171106;font-weight:700;border-color:var(--brass)}',
  '.gx-item{background:var(--ink2);border:1px solid var(--line);border-radius:14px;padding:14px 16px;margin-bottom:10px;display:flex;align-items:center;gap:12px}',
  '.gx-item .nm{flex:1;min-width:0}.gx-item .nm b{display:block;font-size:17px}.gx-item .nm span{font-size:13px;color:var(--dim)}',
  '.gx-item .pr{font-weight:700;color:var(--brass-hi);white-space:nowrap}',
  '.gx-add{background:var(--brass);color:#171106;border:none;border-radius:12px;min-width:64px;min-height:56px;font-size:20px;font-weight:800;cursor:pointer}',
  '.gx-add:active{transform:scale(.95)}',
  '.gx-seat{display:flex;align-items:center;gap:12px;background:var(--ink2);border:1px solid var(--line);border-radius:12px;padding:10px 14px;margin-bottom:12px}',
  '.gx-seat select{background:var(--ink3);color:var(--text);border:1px solid var(--line);border-radius:10px;font-size:18px;padding:10px 14px;min-height:52px}',
  '#gx-bar{position:fixed;bottom:0;left:0;right:0;background:var(--ink2);border-top:2px solid var(--line);padding:12px 16px;display:flex;gap:10px;align-items:center;max-width:720px;margin:0 auto;z-index:6}',
  '#gx-bar .tot{flex:1;font-size:15px;color:var(--dim)}#gx-bar .tot b{display:block;font-size:20px;color:var(--text)}',
  '.btn{border:none;border-radius:12px;min-height:56px;padding:12px 22px;font-size:18px;font-weight:700;cursor:pointer}',
  '.btn.go{background:var(--green);color:#06281b}.btn.ghost{background:var(--ink3);color:var(--text);border:1px solid var(--line)}',
  '.btn.cash{background:var(--blue);color:#06121f}.btn:active{transform:scale(.97)}',
  '.btn:disabled{opacity:.45}',
  '.card{background:var(--ink2);border:1px solid var(--line);border-radius:14px;padding:16px;margin-bottom:12px}',
  '.row{display:flex;justify-content:space-between;padding:6px 0;font-size:16px}',
  '.row.total{border-top:1px solid var(--line);margin-top:8px;padding-top:10px;font-size:20px;font-weight:800}',
  '.row .num{font-variant-numeric:tabular-nums}',
  '.muted{color:var(--dim)}.small{font-size:14px}',
  '.seat-h{font-size:13px;text-transform:uppercase;letter-spacing:1px;color:var(--brass);margin:14px 0 6px}',
  '.tip-row{display:flex;gap:8px;margin:10px 0}',
  '.tip{flex:1;background:var(--ink3);border:1px solid var(--line);color:var(--text);border-radius:10px;min-height:52px;font-size:16px;font-weight:700;cursor:pointer}',
  '.tip.on{background:var(--brass);color:#171106;border-color:var(--brass)}',
  '.stars{display:flex;gap:10px;justify-content:center;margin:12px 0}',
  '.star{background:none;border:none;font-size:44px;cursor:pointer;color:var(--line);padding:4px}',
  '.star.on{color:var(--brass)}',
  '.split-link{display:block;background:var(--ink3);border:1px dashed var(--brass);border-radius:10px;padding:12px;margin:8px 0;color:var(--brass-hi);text-decoration:none;font-size:15px;word-break:break-all}'
].join('\n');

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function money(c) { return '$' + (c / 100).toFixed(2); }
/* Happy-hour pricing: display (and cart) the effective price the server
   will charge right now, when the payload carries one. */
function priceOf(i) { return i.effective_price_cents != null ? i.effective_price_cents : i.price_cents; }
function el(html) { var d = document.createElement('div'); d.innerHTML = html; return d.firstChild; }

var S = { menu: null, cat: null, cart: [], check: null, guestToken: null, seat: 1, name: '' };

async function j(method, url, body) {
  var r = await fetch(url, {
    method: method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  var d = null;
  try { d = await r.json(); } catch (e) { /* non-JSON */ }
  if (!r.ok) throw new Error((d && d.error) || ('Request failed (' + r.status + ')'));
  return d;
}

function boot() {
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
  document.body.innerHTML = '<div id="gx"><div id="gx-head"><div><h1>Order &amp; Pay</h1>' +
    '<div class="sub" id="gx-sub">Loading…</div></div></div><div id="gx-body"></div><div id="gx-bar" style="display:none"></div></div>';
  if (CHECK_TOKEN) { S.guestToken = CHECK_TOKEN; loadCheck(); return; }
  if (!TOKEN) return fail('No table code found. Please scan the QR code on your table again.');
  loadMenu();
}

function fail(msg) {
  document.getElementById('gx-body').innerHTML = '<div class="gx-err"><b>Can\'t load the menu.</b><br>' + esc(msg) + '</div>';
  document.getElementById('gx-sub').textContent = 'Error';
}

async function loadMenu() {
  try {
    S.menu = await j('GET', '/api/guest/menu?token=' + encodeURIComponent(TOKEN));
  } catch (e) { fail(e.message); return; }
  document.getElementById('gx-sub').textContent = 'Table ' + S.menu.table.label;
  S.cat = S.menu.categories.length ? S.menu.categories[0].id : null;
  drawMenu();
}

function cartQty(id) { return S.cart.reduce(function (a, l) { return a + (l.id === id ? l.qty : 0); }, 0); }
function cartTotal() { return S.cart.reduce(function (a, l) { return a + l.qty * l.price; }, 0); }

function drawMenu() {
  var body = document.getElementById('gx-body');
  var seats = '';
  for (var i = 1; i <= Math.max(1, S.menu.table.seats || 4); i++) {
    seats += '<option value="' + i + '"' + (i === S.seat ? ' selected' : '') + '>Seat ' + i + '</option>';
  }
  var html = '<div class="gx-seat"><span class="muted small">Ordering for</span><select id="gx-seat-sel">' + seats + '</select>' +
    '<input id="gx-name" class="small" placeholder="Your name (optional)" maxlength="30" style="flex:1;min-width:0;background:var(--ink3);border:1px solid var(--line);border-radius:10px;color:var(--text);padding:10px 12px;font-size:16px;min-height:52px"></div>';
  html += '<div class="gx-cats">' + S.menu.categories.map(function (c) {
    return '<button class="gx-cat' + (c.id === S.cat ? ' on' : '') + '" data-cat="' + c.id + '">' + esc(c.name) + '</button>';
  }).join('') + '</div><div id="gx-items"></div>';
  body.innerHTML = html;
  document.getElementById('gx-seat-sel').onchange = function (e) { S.seat = parseInt(e.target.value, 10) || 1; };
  document.getElementById('gx-name').oninput = function (e) { S.name = e.target.value; };
  body.querySelectorAll('[data-cat]').forEach(function (b) {
    b.onclick = function () { S.cat = parseInt(b.dataset.cat, 10); drawMenu(); };
  });
  drawItems();
  drawBar();
}

function drawItems() {
  var cat = S.menu.categories.find(function (c) { return c.id === S.cat; });
  var host = document.getElementById('gx-items');
  if (!cat) { host.innerHTML = '<p class="muted">No items.</p>'; return; }
  host.innerHTML = cat.items.map(function (i) {
    var q = cartQty(i.id);
    return '<div class="gx-item"><div class="nm"><b>' + esc(i.name) + '</b>' +
      (i.description ? '<span>' + esc(i.description) + '</span>' : '') +
      (i.modifiers && i.modifiers.length ? '<span> · ' + i.modifiers.length + ' options</span>' : '') + '</div>' +
      '<div class="pr">' + money(priceOf(i)) + '</div>' +
      '<button class="gx-add" data-add="' + i.id + '">' + (q ? q + ' +' : '+') + '</button></div>';
  }).join('');
  host.querySelectorAll('[data-add]').forEach(function (b) {
    b.onclick = function () { addToCart(parseInt(b.dataset.add, 10)); };
  });
}

function addToCart(id) {
  var item = null;
  S.menu.categories.forEach(function (c) { c.items.forEach(function (i) { if (i.id === id) item = i; }); });
  if (!item) return;
  var mods = item.modifiers || [];
  var chosen = [];
  if (mods.length) {
    var names = prompt('Options for ' + item.name + ' (comma-separated, or leave blank):\n' +
      mods.map(function (m) { return m.name + (m.price_delta_cents ? ' +' + money(m.price_delta_cents) : ''); }).join('\n'));
    if (names === null) return;
    var want = names.split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
    for (var k = 0; k < want.length; k++) {
      var found = mods.find(function (m) { return m.name.toLowerCase() === want[k] || m.name.toLowerCase().indexOf(want[k]) === 0; });
      if (!found) { alert('Unknown option: ' + want[k]); return; }
      chosen.push({ name: found.name });
    }
  }
  var key = id + '|' + S.seat + '|' + chosen.map(function (m) { return m.name; }).join(',');
  var line = S.cart.find(function (l) { return l.key === key; });
  if (line) line.qty++;
  else S.cart.push({ key: key, id: id, name: item.name, price: priceOf(item), qty: 1, seat: S.seat, modifiers: chosen });
  drawItems(); drawBar();
}

function drawBar() {
  var bar = document.getElementById('gx-bar');
  if (!S.cart.length) { bar.style.display = 'none'; return; }
  bar.style.display = 'flex';
  bar.innerHTML = '<div class="tot"><b>' + money(cartTotal()) + '</b>' + S.cart.reduce(function (a, l) { return a + l.qty; }, 0) + ' items</div>' +
    '<button class="btn ghost" id="gx-clear">Clear</button>' +
    '<button class="btn go" id="gx-send">Send order →</button>';
  document.getElementById('gx-clear').onclick = function () { S.cart = []; drawItems(); drawBar(); };
  document.getElementById('gx-send').onclick = sendOrder;
}

async function sendOrder() {
  if (!S.cart.length) return;
  var btn = document.getElementById('gx-send');
  btn.disabled = true; btn.textContent = 'Sending…';
  try {
    var r = await j('POST', '/api/guest/orders', {
      token: TOKEN, guest_name: S.name || undefined,
      items: S.cart.map(function (l) { return { menu_item_id: l.id, qty: l.qty, seat: l.seat, modifiers: l.modifiers }; }),
    });
    S.guestToken = r.guest_token; S.cart = [];
    document.getElementById('gx-bar').style.display = 'none';
    await loadCheck();
  } catch (e) { alert(e.message); btn.disabled = false; btn.textContent = 'Send order →'; }
}

/* ------------------------------ check + pay ------------------------------ */
async function loadCheck() {
  var d;
  try { d = await j('GET', '/api/guest/check?guest_token=' + encodeURIComponent(S.guestToken)); }
  catch (e) { fail(e.message); return; }
  S.check = d;
  var body = document.getElementById('gx-body');
  document.getElementById('gx-sub').textContent = 'Table ' + (d.table_label || '');
  if (d.status !== 'open') return drawPaid(d);

  var bySeat = {};
  d.items.forEach(function (i) { (bySeat[i.seat] = bySeat[i.seat] || []).push(i); });
  var seatsHtml = Object.keys(bySeat).sort(function (a, b) { return a - b; }).map(function (s) {
    return '<div class="seat-h">Seat ' + s + '</div>' + bySeat[s].map(function (i) {
      var mods = (i.modifiers || []).map(function (m) { return esc(m.name); }).join(', ');
      return '<div class="row"><span>' + i.qty + '× ' + esc(i.name) + (mods ? ' <span class="muted small">(' + mods + ')</span>' : '') + '</span>' +
        '<span class="num">' + money(i.line_cents) + '</span></div>';
    }).join('');
  }).join('');

  var t = d.totals;
  var tipPct = 20, tipCents = Math.round(t.total * tipPct / 100);
  body.innerHTML =
    '<div class="card"><div class="row"><span class="muted">Subtotal</span><span class="num">' + money(t.subtotal) + '</span></div>' +
    (t.surcharge ? '<div class="row"><span class="muted">Surcharge</span><span class="num">' + money(t.surcharge) + '</span></div>' : '') +
    (t.service_charge ? '<div class="row"><span class="muted">Service charge</span><span class="num">' + money(t.service_charge) + '</span></div>' : '') +
    '<div class="row"><span class="muted">Tax</span><span class="num">' + money(t.tax) + '</span></div>' +
    (t.paid ? '<div class="row"><span class="muted">Paid</span><span class="num">−' + money(t.paid) + '</span></div>' : '') +
    '<div class="row total"><span>Balance due</span><span class="num" id="gx-bal">' + money(t.balance) + '</span></div></div>' +
    '<div class="card"><h3 style="margin:0 0 8px">Your order</h3>' + seatsHtml + '</div>' +
    '<div class="card"><h3 style="margin:0 0 8px">Split the check</h3>' +
    '<p class="muted small" style="margin:0 0 10px">Split by seat on your own phone — everyone pays their own. Staff can undo a split if needed.</p>' +
    '<div style="display:flex;gap:8px"><button class="btn ghost" id="gx-split-seat" style="flex:1">Split by seat</button>' +
    '<button class="btn ghost" id="gx-split-even" style="flex:1">Even split</button></div>' +
    '<div id="gx-split-out" style="margin-top:8px"></div></div>' +
    '<div class="card"><h3 style="margin:0 0 8px">Tip</h3><div class="tip-row" id="gx-tips">' +
    [15, 18, 20, 25].map(function (p) {
      return '<button class="tip' + (p === tipPct ? ' on' : '') + '" data-tip="' + p + '">' + p + '%<br><span class="small">' + money(Math.round(t.total * p / 100)) + '</span></button>';
    }).join('') + '</div>' +
    '<h3 style="margin:14px 0 8px">Pay</h3>' +
    '<div style="display:flex;gap:8px"><button class="btn go" id="gx-pay-card" style="flex:1">Pay ' + money(t.balance + tipCents) + ' <span class="small">(demo card)</span></button></div>' +
    '<div style="display:flex;gap:8px;margin-top:8px"><button class="btn cash" id="gx-pay-cash" style="flex:1">Pay cash — server collects</button></div>' +
    '<p class="muted small" id="gx-pay-msg" style="margin:10px 0 0"></p></div>';

  body.querySelector('#gx-tips').addEventListener('click', function (e) {
    var b = e.target.closest('[data-tip]'); if (!b) return;
    tipPct = parseInt(b.dataset.tip, 10); tipCents = Math.round(t.total * tipPct / 100);
    body.querySelectorAll('#gx-tips .tip').forEach(function (x) { x.classList.toggle('on', x === b); });
    document.getElementById('gx-pay-card').innerHTML = 'Pay ' + money(t.balance + tipCents) + ' <span class="small">(demo card)</span>';
  });
  document.getElementById('gx-split-seat').onclick = function () { guestSplit('by_seat'); };
  document.getElementById('gx-split-even').onclick = function () { guestSplit('even'); };
  document.getElementById('gx-pay-card').onclick = function () { guestPay('card_demo', tipCents); };
  document.getElementById('gx-pay-cash').onclick = function () { guestPay('cash', 0); };
}

async function guestSplit(mode) {
  var out = document.getElementById('gx-split-out');
  try {
    var seats = [...new Set(S.check.items.map(function (i) { return i.seat; }))].sort(function (a, b) { return a - b; });
    var body = { guest_token: S.guestToken, mode: mode };
    if (mode === 'by_seat') body.seat_groups = seats.map(function (s) { return [s]; });
    var r = await j('POST', '/api/guest/split', body);
    out.innerHTML = '<p class="small" style="color:var(--green)">Split into ' + r.checks.length + ' checks. Share each link so everyone pays their own:</p>' +
      r.checks.map(function (c) {
        return '<a class="split-link" href="' + location.origin + '/g/check/' + encodeURIComponent(c.guest_token) + '">Seats ' + c.seats.join(', ') + ' — open to pay</a>';
      }).join('') +
      '<p class="muted small">Each link opens that seat\'s check on their phone.</p>';
  } catch (e) { out.innerHTML = '<p class="small" style="color:var(--red)">' + esc(e.message) + '</p>'; }
}

async function guestPay(method, tipCents) {
  var msg = document.getElementById('gx-pay-msg');
  var t = S.check.totals;
  try {
    msg.textContent = 'Processing…';
    var payload = { guest_token: S.guestToken, method: method, amount_cents: t.balance, tip_cents: tipCents };
    if (method === 'cash') payload.tip_cents = 0;
    var r = await j('POST', '/api/guest/pay', payload);
    if (r.cash_request) {
      msg.innerHTML = '<span style="color:var(--blue)">✓ ' + esc(r.message) + '</span>';
    } else {
      S.check.totals = r.totals; S.check.status = 'paid';
      drawPaid(S.check);
    }
  } catch (e) { msg.innerHTML = '<span style="color:var(--red)">' + esc(e.message) + '</span>'; }
}

function drawPaid(d) {
  var body = document.getElementById('gx-body');
  document.getElementById('gx-bar').style.display = 'none';
  body.innerHTML = '<div class="card" style="text-align:center;padding:32px 16px">' +
    '<div style="font-size:56px">✓</div><h2>Paid — thank you!</h2>' +
    '<p class="muted">Your check is settled.</p>' +
    '<h3>How was your visit?</h3><div class="stars" id="gx-stars">' +
    [1, 2, 3, 4, 5].map(function (n) { return '<button class="star" data-star="' + n + '">★</button>'; }).join('') +
    '</div><p class="muted small" id="gx-fb-msg">Optional — one tap, no account needed.</p></div>';
  body.querySelector('#gx-stars').addEventListener('click', async function (e) {
    var b = e.target.closest('[data-star]'); if (!b) return;
    var n = parseInt(b.dataset.star, 10);
    body.querySelectorAll('.star').forEach(function (x) { x.classList.toggle('on', parseInt(x.dataset.star, 10) <= n); });
    try {
      await j('POST', '/api/guest/feedback', { guest_token: S.guestToken, rating: n });
      document.getElementById('gx-fb-msg').textContent = 'Thanks for the feedback!';
    } catch (err) { document.getElementById('gx-fb-msg').textContent = 'Could not save — no problem, enjoy your day.'; }
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

})();
