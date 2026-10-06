/* ============================================================================
 * Expoline — Kiosk mode (customer self-order).
 * Standalone: include via <script src="/views/kiosk.js"></script> in a bare
 * HTML page. Builds its own DOM + styles; not wired into the staff nav.
 *
 * 3-tap order: category → item (no modifiers = instant add) → SEND.
 * Harbor Luxe adapted for touch: min 64px targets, high contrast.
 * ========================================================================== */
(function () {
  'use strict';

  var MENU_URL = '/api/kiosk/menu';
  var ORDER_URL = '/api/kiosk/order';
  var CALL_URL = '/api/kiosk/call-staff';
  var POLL_MS = 60000;

  var css = [
    ':root{--ink:#0e1420;--ink2:#141b2b;--ink3:#1b2438;--brass:#c9a86a;--brass-hi:#e3c78e;',
    '--text:#ece7db;--dim:#a8a294;--green:#3ed598;--red:#ec6f6f;--line:#2a3650}',
    '*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}',
    'html,body{margin:0;padding:0;height:100%}',
    'body{background:var(--ink);color:var(--text);font-family:system-ui,-apple-system,"Segoe UI",sans-serif;',
    'font-size:20px;overflow:hidden;user-select:none}',
    '#kx{height:100vh;display:flex;flex-direction:column}',
    '#kx-head{background:var(--ink2);border-bottom:2px solid var(--line);padding:16px 24px;',
    'display:flex;align-items:center;justify-content:space-between;min-height:88px}',
    '#kx-head h1{margin:0;font-size:32px;letter-spacing:.5px;color:var(--brass)}',
    '#kx-call{background:var(--red);color:#fff;border:none;border-radius:16px;min-height:64px;min-width:200px;',
    'font-size:22px;font-weight:700;cursor:pointer;padding:12px 24px}',
    '#kx-call:active{transform:scale(.97)}',
    '#kx-cats{display:flex;gap:12px;padding:16px 24px;overflow-x:auto;background:var(--ink2);flex:none}',
    '.kx-cat{flex:none;min-height:64px;padding:12px 28px;border-radius:16px;border:2px solid var(--line);',
    'background:var(--ink3);color:var(--text);font-size:22px;font-weight:600;cursor:pointer;white-space:nowrap}',
    '.kx-cat.on{border-color:var(--brass);color:var(--brass-hi);background:#2a2417}',
    '#kx-items{flex:1;overflow-y:auto;padding:20px 24px;display:grid;',
    'grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px;align-content:start}',
    '.kx-item{background:var(--ink3);border:2px solid var(--line);border-radius:20px;padding:20px;cursor:pointer;',
    'min-height:120px;display:flex;flex-direction:column;justify-content:center;gap:8px;text-align:left;color:var(--text)}',
    '.kx-item:active{transform:scale(.98);border-color:var(--brass)}',
    '.kx-item .nm{font-size:26px;font-weight:700;line-height:1.2}',
    '.kx-item .ds{font-size:17px;color:var(--dim);line-height:1.3}',
    '.kx-item .pr{font-size:24px;color:var(--brass);font-weight:700;margin-top:4px}',
    '#kx-bar{flex:none;background:var(--ink2);border-top:2px solid var(--line);padding:16px 24px;',
    'display:flex;gap:16px;align-items:center;min-height:104px}',
    '#kx-cartinfo{flex:1;font-size:22px}',
    '#kx-cartinfo b{color:var(--brass)}',
    '#kx-viewcart,#kx-send{background:var(--ink3);color:var(--text);border:2px solid var(--line);border-radius:16px;',
    'min-height:72px;padding:12px 32px;font-size:24px;font-weight:700;cursor:pointer}',
    '#kx-send{background:var(--green);border-color:var(--green);color:#06281c;min-width:280px;font-size:26px}',
    '#kx-send:disabled{opacity:.4}',
    '#kx-sheet{position:fixed;inset:0;background:rgba(0,0,0,.6);display:none;align-items:flex-end;justify-content:center;z-index:50}',
    '#kx-sheet.open{display:flex}',
    '#kx-panel{background:var(--ink2);border-radius:28px 28px 0 0;width:100%;max-width:900px;max-height:88vh;',
    'overflow-y:auto;padding:28px;border-top:2px solid var(--line)}',
    '#kx-panel h2{margin:0 0 8px;font-size:32px}',
    '#kx-panel .qtyrow{display:flex;align-items:center;gap:24px;margin:20px 0}',
    '.kx-qtybtn{width:88px;height:88px;border-radius:20px;border:2px solid var(--line);background:var(--ink3);',
    'color:var(--text);font-size:44px;cursor:pointer}',
    '#kx-qty{font-size:40px;font-weight:800;min-width:80px;text-align:center}',
    '.kx-mod{display:flex;align-items:center;gap:16px;padding:16px;border:2px solid var(--line);border-radius:16px;',
    'margin-bottom:12px;cursor:pointer;min-height:72px;font-size:22px}',
    '.kx-mod.on{border-color:var(--brass);background:#2a2417}',
    '.kx-mod .ck{width:36px;height:36px;border-radius:10px;border:2px solid var(--dim);flex:none;',
    'display:flex;align-items:center;justify-content:center;font-size:24px}',
    '.kx-mod.on .ck{background:var(--brass);border-color:var(--brass);color:#0e1420}',
    '.kx-mod .mp{margin-left:auto;color:var(--brass);font-weight:700}',
    '#kx-addbtn{width:100%;min-height:80px;border:none;border-radius:18px;background:var(--brass);color:#0e1420;',
    'font-size:28px;font-weight:800;cursor:pointer;margin-top:16px}',
    '.kx-close{float:right;background:none;border:none;color:var(--dim);font-size:32px;cursor:pointer;min-width:64px;min-height:64px}',
    '.kx-cartline{display:flex;align-items:center;gap:16px;padding:16px 0;border-bottom:1px solid var(--line);font-size:22px}',
    '.kx-cartline .qn{color:var(--brass);font-weight:800;min-width:56px}',
    '.kx-cartline .rm{margin-left:auto;background:none;border:2px solid var(--line);color:var(--red);border-radius:12px;',
    'min-width:64px;min-height:64px;font-size:24px;cursor:pointer}',
    '#kx-name{width:100%;min-height:64px;border-radius:14px;border:2px solid var(--line);background:var(--ink);',
    'color:var(--text);font-size:22px;padding:12px 16px;margin:12px 0}',
    '#kx-done{text-align:center;padding:60px 24px}',
    '#kx-done .big{font-size:72px;margin-bottom:16px}',
    '#kx-done h2{font-size:40px;color:var(--green);margin:0 0 12px}',
    '#kx-done p{font-size:24px;color:var(--dim)}',
    '#kx-neworder{min-height:80px;padding:12px 48px;border-radius:18px;border:none;background:var(--brass);',
    'color:#0e1420;font-size:28px;font-weight:800;cursor:pointer;margin-top:24px}'
  ].join('\n');

  var state = { cats: [], catId: null, cart: [], name: '' };

  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
  }
  function money(c) { return '$' + (c / 100).toFixed(2); }
  /* Happy-hour pricing: show (and cart) the effective price the server
     will charge right now, when the payload carries one. */
  function priceOf(it) { return it.effective_price_cents != null ? it.effective_price_cents : it.price_cents; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function build() {
    var st = document.createElement('style');
    st.textContent = css;
    document.head.appendChild(st);
    var root = el('div');
    root.id = 'kx';
    root.innerHTML =
      '<div id="kx-head"><h1>Bali Hai &middot; Order</h1>' +
      '<button id="kx-call">\uD83D\uDECE&nbsp; Call staff</button></div>' +
      '<div id="kx-cats"></div><div id="kx-items"></div>' +
      '<div id="kx-bar"><div id="kx-cartinfo">Tap items to add</div>' +
      '<button id="kx-viewcart">Cart</button>' +
      '<button id="kx-send" disabled>Send order</button></div>' +
      '<div id="kx-sheet"><div id="kx-panel"></div></div>';
    document.body.appendChild(root);
    document.getElementById('kx-call').addEventListener('click', callStaff);
    document.getElementById('kx-viewcart').addEventListener('click', showCart);
    document.getElementById('kx-send').addEventListener('click', sendOrder);
    document.getElementById('kx-sheet').addEventListener('click', function (e) {
      if (e.target.id === 'kx-sheet') closeSheet();
    });
  }

  function loadMenu() {
    fetch(MENU_URL).then(function (r) { return r.json(); }).then(function (d) {
      state.cats = d.categories || [];
      if (!state.cats.length) return;
      if (!state.cats.some(function (c) { return c.id === state.catId; })) {
        state.catId = state.cats[0].id;
      }
      renderCats();
      renderItems();
    }).catch(function () { /* keep last menu on poll failure */ });
  }

  function renderCats() {
    var box = document.getElementById('kx-cats');
    box.innerHTML = '';
    state.cats.forEach(function (c) {
      var b = el('button', 'kx-cat' + (c.id === state.catId ? ' on' : ''), esc(c.name));
      b.addEventListener('click', function () { state.catId = c.id; renderCats(); renderItems(); });
      box.appendChild(b);
    });
  }

  function renderItems() {
    var box = document.getElementById('kx-items');
    box.innerHTML = '';
    var cat = state.cats.filter(function (c) { return c.id === state.catId; })[0];
    if (!cat) return;
    cat.items.forEach(function (it) {
      var b = el('button', 'kx-item',
        '<span class="nm">' + esc(it.name) + '</span>' +
        (it.description ? '<span class="ds">' + esc(it.description) + '</span>' : '') +
        '<span class="pr">' + money(priceOf(it)) + '</span>');
      b.addEventListener('click', function () { tapItem(it); });
      box.appendChild(b);
    });
  }

  /* 3-tap core: no modifiers → instant add (tap 2); modifiers → sheet. */
  function tapItem(it) {
    if (!it.modifiers || !it.modifiers.length) {
      addToCart(it, 1, [], priceOf(it));
      return;
    }
    openSheet(itemSheet(it));
  }

  function itemSheet(it) {
    var p = el('div');
    var qty = 1, picked = {};
    p.innerHTML = '<button class="kx-close" id="kxx">\u2715</button>' +
      '<h2>' + esc(it.name) + '</h2>' +
      '<div style="color:var(--dim);font-size:20px">' + esc(it.description || '') + '</div>' +
      '<div class="qtyrow"><button class="kx-qtybtn" id="kx-minus">\u2212</button>' +
      '<span id="kx-qty">1</span>' +
      '<button class="kx-qtybtn" id="kx-plus">+</button>' +
      '<span style="margin-left:auto;font-size:28px;color:var(--brass);font-weight:800" id="kx-tot">' +
      money(priceOf(it)) + '</span></div>' +
      '<div id="kx-mods"></div>' +
      '<button id="kx-addbtn">Add to order</button>';
    var modsBox = p.querySelector('#kx-mods');
    it.modifiers.forEach(function (m) {
      var row = el('div', 'kx-mod',
        '<span class="ck"></span><span>' + esc(m.name) + '</span>' +
        '<span class="mp">+' + money(m.price_delta_cents) + '</span>');
      row.addEventListener('click', function () {
        if (picked[m.name]) { delete picked[m.name]; row.classList.remove('on'); row.querySelector('.ck').textContent = ''; }
        else { picked[m.name] = m; row.classList.add('on'); row.querySelector('.ck').textContent = '\u2713'; }
        updTot();
      });
      modsBox.appendChild(row);
    });
    function unit() {
      var t = priceOf(it);
      Object.keys(picked).forEach(function (k) { t += picked[k].price_delta_cents; });
      return t;
    }
    function updTot() {
      p.querySelector('#kx-qty').textContent = qty;
      p.querySelector('#kx-tot').textContent = money(unit() * qty);
    }
    p.querySelector('#kx-minus').addEventListener('click', function () { if (qty > 1) { qty--; updTot(); } });
    p.querySelector('#kx-plus').addEventListener('click', function () { if (qty < 20) { qty++; updTot(); } });
    p.querySelector('#kxx').addEventListener('click', closeSheet);
    p.querySelector('#kx-addbtn').addEventListener('click', function () {
      addToCart(it, qty, Object.keys(picked).map(function (k) { return { name: picked[k].name }; }), unit());
      closeSheet();
    });
    return p;
  }

  function cartKey(ln) {
    return ln.id + '|' + ln.mods.map(function (m) { return m.name; }).sort().join(',');
  }
  function addToCart(it, qty, mods, unitPrice) {
    var key = it.id + '|' + mods.map(function (m) { return m.name; }).sort().join(',');
    var found = null;
    state.cart.forEach(function (ln) { if (cartKey(ln) === key) found = ln; });
    if (found) found.qty = Math.min(20, found.qty + qty);
    else state.cart.push({ id: it.id, name: it.name, unit: unitPrice, qty: qty, mods: mods });
    renderBar();
  }
  function cartCount() { return state.cart.reduce(function (n, ln) { return n + ln.qty; }, 0); }
  function cartTotal() {
    return state.cart.reduce(function (t, ln) { return t + ln.qty * ln.unit; }, 0);
  }
  function renderBar() {
    var n = cartCount();
    document.getElementById('kx-cartinfo').innerHTML = n
      ? '<b>' + n + '</b> item' + (n > 1 ? 's' : '') + ' &middot; <b>' + money(cartTotal()) + '</b>'
      : 'Tap items to add';
    document.getElementById('kx-send').disabled = !n;
  }

  function showCart() {
    var p = el('div');
    var h = '<button class="kx-close" id="kxx">\u2715</button><h2>Your order</h2>';
    if (!state.cart.length) h += '<p style="color:var(--dim);font-size:22px">Your cart is empty.</p>';
    state.cart.forEach(function (ln, i) {
      h += '<div class="kx-cartline"><span class="qn">' + ln.qty + '\u00d7</span><span>' + esc(ln.name) +
        (ln.mods.length ? '<br><span style="color:var(--dim);font-size:18px">' +
          esc(ln.mods.map(function (m) { return m.name; }).join(', ')) + '</span>' : '') +
        '</span><span style="color:var(--brass);font-weight:700">' + money(ln.qty * ln.unit) + '</span>' +
        '<button class="rm" data-i="' + i + '">\u2715</button></div>';
    });
    h += '<input id="kx-name" placeholder="Name for the order (optional)" maxlength="40" value="' + esc(state.name) + '">';
    p.innerHTML = h;
    p.querySelector('#kxx').addEventListener('click', closeSheet);
    Array.prototype.forEach.call(p.querySelectorAll('.rm'), function (b) {
      b.addEventListener('click', function () {
        state.cart.splice(parseInt(b.getAttribute('data-i'), 10), 1);
        state.name = p.querySelector('#kx-name').value;
        showCart(); renderBar();
      });
    });
    p.querySelector('#kx-name').addEventListener('input', function (e) { state.name = e.target.value; });
    openSheet(p);
  }

  function openSheet(node) {
    var panel = document.getElementById('kx-panel');
    panel.innerHTML = '';
    panel.appendChild(node);
    document.getElementById('kx-sheet').classList.add('open');
  }
  function closeSheet() { document.getElementById('kx-sheet').classList.remove('open'); }

  function sendOrder() {
    if (!state.cart.length) return;
    var btn = document.getElementById('kx-send');
    btn.disabled = true;
    btn.textContent = 'Sending…';
    fetch(ORDER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customer_name: state.name || undefined,
        items: state.cart.map(function (ln) {
          return { menu_item_id: ln.id, qty: ln.qty, modifiers: ln.mods };
        })
      })
    }).then(function (r) {
      return r.json().then(function (d) { return { ok: r.ok, d: d }; });
    }).then(function (res) {
      if (!res.ok) throw new Error((res.d && res.d.error) || 'Order failed');
      state.cart = [];
      state.name = '';
      renderBar();
      showDone(res.d);
    }).catch(function (e) {
      btn.disabled = false;
      btn.textContent = 'Send order';
      alert('Could not send order: ' + e.message);
    });
  }

  function showDone(d) {
    var n = (d.check && d.check.tab_name) || 'your order';
    var p = el('div');
    p.id = 'kx-done';
    p.innerHTML = '<div class="big">\u2705</div><h2>Order sent!</h2>' +
      '<p>' + esc(n) + ' is on its way to the kitchen.<br>Pay at the counter when ready.</p>' +
      '<button id="kx-neworder">New order</button>';
    p.querySelector('#kx-neworder').addEventListener('click', function () {
      closeSheet(); renderItems();
    });
    openSheet(p);
  }

  function callStaff() {
    var b = document.getElementById('kx-call');
    b.disabled = true;
    fetch(CALL_URL, { method: 'POST' }).then(function (r) { return r.json(); }).then(function () {
      b.textContent = '\u2705 Staff on the way';
      setTimeout(function () { b.innerHTML = '\uD83D\uDECE&nbsp; Call staff'; b.disabled = false; }, 30000);
    }).catch(function () { b.disabled = false; });
  }

  build();
  loadMenu();
  setInterval(loadMenu, POLL_MS);
})();
