'use strict';
/* ============================================================================
 * Expoline — Online ordering (order-ahead) customer page, v1
 * Mobile-first, Harbor Luxe. Standalone: NOT wired into staff nav.
 * Usage (integrator): renderOnlineOrder(document.getElementById('app'), api)
 *   api = async (path, method, body) => parsed JSON; throws Error on !ok.
 * ========================================================================== */

const oloEsc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const oloFmt = (cents) => '$' + ((Number(cents) || 0) / 100).toFixed(2);
const oloPad = (n) => String(n).padStart(2, '0');

const OLO_CSS = `
.olo-wrap{max-width:560px;margin:0 auto;padding:0 16px 120px;font-family:var(--sans);color:var(--text)}
.olo-hero{text-align:center;padding:28px 0 12px}
.olo-hero h1{font-family:var(--serif);font-size:30px;margin:0;color:var(--text)}
.olo-hero h1 span{color:var(--brass)}
.olo-hero p{color:var(--text-dim);margin:6px 0 0;font-size:14px}
.olo-badge{display:inline-block;margin-top:10px;padding:6px 14px;border:1px solid var(--brass-dim);
  border-radius:999px;color:var(--brass-hi);font-size:12px;letter-spacing:.08em;text-transform:uppercase}
.olo-reorder{margin:14px 0;padding:14px;background:var(--ink-2);border:1px solid var(--line);
  border-radius:var(--radius)}
.olo-reorder h3{margin:0 0 8px;font-size:14px;color:var(--text-dim);font-weight:600}
.olo-row{display:flex;gap:8px}
.olo-input{flex:1;min-height:var(--tap);padding:0 14px;border-radius:var(--radius-sm);
  border:1px solid var(--line);background:var(--ink-3);color:var(--text);font-size:16px}
.olo-btn{min-height:var(--tap);padding:0 20px;border:none;border-radius:var(--radius-sm);
  background:var(--brass);color:#1a1408;font-weight:700;font-size:15px;cursor:pointer}
.olo-btn:active{transform:scale(.98)}
.olo-btn.ghost{background:transparent;border:1px solid var(--line);color:var(--text)}
.olo-btn.big{width:100%;font-size:17px;min-height:56px}
.olo-btn:disabled{opacity:.45;cursor:default}
.olo-cat{margin:22px 0 8px;font-family:var(--serif);font-size:21px;color:var(--brass-hi)}
.olo-item{display:flex;align-items:center;gap:12px;padding:12px;background:var(--ink-2);
  border:1px solid var(--line-soft);border-radius:var(--radius);margin-bottom:8px}
.olo-item .inf{flex:1;min-width:0}
.olo-item .nm{font-weight:600;font-size:15px}
.olo-item .ds{color:var(--text-dim);font-size:13px;margin-top:2px}
.olo-item .pr{color:var(--brass-hi);font-weight:700;margin-top:4px;font-size:15px}
.olo-item .pr s{color:var(--text-dim);font-weight:400;margin-right:6px}
.olo-hh{display:inline-block;margin-left:8px;padding:1px 8px;border:1px solid var(--brass-dim);
  border-radius:999px;color:var(--brass-hi);font-size:11px;letter-spacing:.06em;text-transform:uppercase;vertical-align:1px}
.olo-left{color:var(--brass-hi);font-size:12px;margin-top:3px;font-weight:600}
.olo-step{display:flex;align-items:center;gap:8px}
.olo-step button{width:40px;height:40px;border-radius:50%;border:1px solid var(--brass-dim);
  background:transparent;color:var(--brass-hi);font-size:20px;cursor:pointer}
.olo-step .q{min-width:28px;text-align:center;font-weight:700;font-size:17px}
.olo-cartbar{position:fixed;left:0;right:0;bottom:0;padding:12px 16px calc(12px + env(safe-area-inset-bottom));
  background:rgba(14,20,32,.97);border-top:1px solid var(--line);backdrop-filter:blur(8px)}
.olo-cartbar .in{max-width:560px;margin:0 auto;display:flex;align-items:center;gap:12px}
.olo-cartbar .tot{flex:1}
.olo-cartbar .tot b{font-size:19px}
.olo-cartbar .tot small{display:block;color:var(--text-dim)}
.olo-field{margin-bottom:14px}
.olo-field label{display:block;font-size:13px;color:var(--text-dim);margin-bottom:6px;font-weight:600}
.olo-field .olo-input{width:100%}
.olo-slots{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.olo-slot{padding:12px 4px;border:1px solid var(--line);border-radius:var(--radius-sm);
  background:var(--ink-2);color:var(--text);font-size:14px;cursor:pointer;text-align:center}
.olo-slot.sel{border-color:var(--brass);background:var(--ink-3);color:var(--brass-hi);font-weight:700}
.olo-sum{background:var(--ink-2);border:1px solid var(--line);border-radius:var(--radius);
  padding:14px;margin:16px 0}
.olo-sum .r{display:flex;justify-content:space-between;padding:3px 0;color:var(--text-dim);font-size:14px}
.olo-sum .r.tt{color:var(--text);font-weight:700;font-size:17px;border-top:1px solid var(--line);
  margin-top:8px;padding-top:10px}
.olo-done{text-align:center;padding:40px 0}
.olo-done .ck{font-size:54px;color:var(--green)}
.olo-done h2{font-family:var(--serif);font-size:26px;margin:12px 0 6px}
.olo-done p{color:var(--text-dim)}
.olo-err{background:var(--red-dim);border:1px solid var(--red);color:#ffd9d9;
  padding:12px 14px;border-radius:var(--radius-sm);margin:12px 0;font-size:14px}
.olo-note{font-size:13px;color:var(--text-dim);text-align:center;margin-top:12px}
`;

function oloSlots() {
  const slots = [{ label: 'ASAP', value: null }];
  const d = new Date();
  d.setMinutes(Math.ceil(d.getMinutes() / 15) * 15, 0, 0);
  for (let i = 0; i < 12; i++) {
    const t = new Date(d.getTime() + i * 15 * 60000);
    slots.push({
      label: t.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
      value: t.toISOString(),
    });
  }
  return slots;
}

async function renderOnlineOrder(container, api) {
  const st = {
    step: 'menu', menu: [], cart: new Map(), name: '', phone: '',
    slot: null, // null = ASAP
    placing: false, order: null, err: '',
  };

  try {
    st.menu = await api('/api/online/menu');
  } catch (e) {
    container.innerHTML = `<div class="olo-wrap"><div class="olo-hero"><h1>Bali Hai <span>Restaurant</span></h1></div><div class="olo-err">${oloEsc(e.message || 'Could not load the menu')}</div></div>`;
    return;
  }

  const byId = new Map();
  st.menu.forEach((c) => (c.items || []).forEach((it) => byId.set(it.id, it)));

  // The price an order placed right now would be charged: the server's
  // effective price (happy-hour price while a pricing window is live),
  // falling back to the regular price on payloads that predate it. The
  // server re-prices every order anyway — this only keeps the guest's
  // running total honest.
  const oloPrice = (it) => (it.effective_price_cents != null ? it.effective_price_cents : it.price_cents);
  const priceHtml = (it) => it.hh_active
    ? `<s>${oloFmt(it.price_cents)}</s>${oloFmt(it.effective_price_cents)}<span class="olo-hh">Happy hour</span>`
    : oloFmt(oloPrice(it));

  const cartCount = () => { let n = 0; st.cart.forEach((q) => (n += q)); return n; };
  const cartSubtotal = () => {
    let s = 0;
    st.cart.forEach((q, id) => { const it = byId.get(id); if (it) s += q * oloPrice(it); });
    return s;
  };

  function paint() {
    let style = container.querySelector('style[data-olo]');
    if (!style) {
      style = document.createElement('style');
      style.setAttribute('data-olo', '1');
      style.textContent = OLO_CSS;
      container.appendChild(style);
    }
    const root = container.querySelector('.olo-wrap') || (() => {
      const d = document.createElement('div');
      d.className = 'olo-wrap';
      container.appendChild(d);
      return d;
    })();
    root.innerHTML =
      `<div class="olo-hero"><h1>Bali Hai <span>Restaurant</span></h1>` +
      `<p>Order ahead — skip the line</p>` +
      `<span class="olo-badge">Pay at pickup · No fees</span></div>` +
      (st.err ? `<div class="olo-err">${oloEsc(st.err)}</div>` : '') +
      (st.step === 'menu' ? viewMenu() : st.step === 'checkout' ? viewCheckout() : viewDone());
    wire(root);
  }

  function viewMenu() {
    let h = `<div class="olo-reorder"><h3>Ordered before? One-tap reorder</h3>
      <div class="olo-row"><input class="olo-input" id="olo-phone-lookup" inputmode="tel" placeholder="Phone number">
      <button class="olo-btn ghost" id="olo-reorder-btn">Find</button></div></div>`;
    for (const c of st.menu) {
      if (!c.items || !c.items.length) continue;
      h += `<div class="olo-cat">${oloEsc(c.name)}</div>`;
      for (const it of c.items) {
        const q = st.cart.get(it.id) || 0;
        h += `<div class="olo-item"><div class="inf"><div class="nm">${oloEsc(it.name)}</div>` +
          (it.description ? `<div class="ds">${oloEsc(it.description)}</div>` : '') +
          `<div class="pr">${priceHtml(it)}</div>` +
          (it.remaining != null ? `<div class="olo-left">Only ${it.remaining} left</div>` : '') +
          `</div>
          <div class="olo-step">
            <button data-dec="${it.id}" aria-label="remove">−</button>
            <span class="q">${q}</span>
            <button data-inc="${it.id}" aria-label="add">+</button>
          </div></div>`;
      }
    }
    const n = cartCount();
    if (n > 0) {
      h += `<div class="olo-cartbar"><div class="in"><div class="tot"><small>${n} item${n === 1 ? '' : 's'}</small><b>${oloFmt(cartSubtotal())}</b></div>
        <button class="olo-btn" id="olo-checkout-btn">Checkout →</button></div></div>`;
    }
    return h;
  }

  function viewCheckout() {
    const sub = cartSubtotal();
    const slots = oloSlots();
    let h = `<div class="olo-field"><label>Your name</label>
      <input class="olo-input" id="olo-name" placeholder="Jane Doe" value="${oloEsc(st.name)}"></div>
      <div class="olo-field"><label>Phone (for pickup updates)</label>
      <input class="olo-input" id="olo-phone" inputmode="tel" placeholder="(555) 123-4567" value="${oloEsc(st.phone)}"></div>
      <div class="olo-field"><label>Pickup time</label><div class="olo-slots">`;
    slots.forEach((s, i) => {
      h += `<button class="olo-slot${(st.slot === s.value || (st.slot === null && s.value === null && i === 0)) ? ' sel' : ''}" data-slot="${i}">${oloEsc(s.label)}</button>`;
    });
    h += `</div></div><div class="olo-sum">`;
    st.cart.forEach((q, id) => {
      const it = byId.get(id);
      if (it) h += `<div class="r"><span>${q}× ${oloEsc(it.name)}</span><span>${oloFmt(q * oloPrice(it))}</span></div>`;
    });
    h += `<div class="r"><span>Subtotal</span><span>${oloFmt(sub)}</span></div>
      <div class="r"><span>Tax (7.75%)</span><span>calc. at confirmation</span></div>
      <div class="r tt"><span>Due at pickup</span><span>${oloFmt(sub)}</span></div></div>
      <button class="olo-btn big" id="olo-place-btn" ${st.placing ? 'disabled' : ''}>${st.placing ? 'Placing…' : 'Place order'}</button>
      <div class="olo-row" style="margin-top:8px"><button class="olo-btn ghost big" id="olo-back-btn">← Back to menu</button></div>
      <p class="olo-note">No payment now — pay at pickup. No fees, ever.</p>`;
    h._slots = slots;
    viewCheckout._slots = slots;
    return h;
  }

  function viewDone() {
    const o = st.order;
    const when = o.pickup_at
      ? new Date(o.pickup_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      : 'ASAP';
    return `<div class="olo-done"><div class="ck">✓</div><h2>Order #${o.id} placed</h2>
      <p>${oloEsc(o.customer_name)} · Pickup <b style="color:var(--text)">${oloEsc(when)}</b></p>
      <div class="olo-sum" style="text-align:left">` +
      o.items.map((it) => `<div class="r"><span>${it.qty}× ${oloEsc(it.name)}</span><span>${oloFmt(it.qty * it.unit_price_cents)}</span></div>`).join('') +
      `<div class="r"><span>Subtotal</span><span>${oloFmt(o.subtotal_cents)}</span></div>
       <div class="r"><span>Tax</span><span>${oloFmt(o.tax_cents)}</span></div>
       <div class="r tt"><span>Due at pickup</span><span>${oloFmt(o.total_cents)}</span></div></div>
      <p class="olo-note">Show this screen or give your name at the counter.<br>Pay at pickup — no fees.</p>
      <button class="olo-btn ghost big" id="olo-new-btn">Start a new order</button></div>`;
  }

  function wire(root) {
    root.querySelectorAll('[data-inc]').forEach((b) => b.addEventListener('click', () => {
      const id = Number(b.dataset.inc);
      st.cart.set(id, (st.cart.get(id) || 0) + 1);
      st.err = ''; paint();
    }));
    root.querySelectorAll('[data-dec]').forEach((b) => b.addEventListener('click', () => {
      const id = Number(b.dataset.dec);
      const q = (st.cart.get(id) || 0) - 1;
      if (q <= 0) st.cart.delete(id); else st.cart.set(id, q);
      st.err = ''; paint();
    }));
    const co = root.querySelector('#olo-checkout-btn');
    if (co) co.addEventListener('click', () => { st.step = 'checkout'; st.err = ''; paint(); });
    const back = root.querySelector('#olo-back-btn');
    if (back) back.addEventListener('click', () => { st.step = 'menu'; st.err = ''; paint(); });
    const nb = root.querySelector('#olo-new-btn');
    if (nb) nb.addEventListener('click', () => {
      st.cart.clear(); st.step = 'menu'; st.order = null; st.err = ''; paint();
    });
    root.querySelectorAll('[data-slot]').forEach((b) => b.addEventListener('click', () => {
      st.slot = viewCheckout._slots[Number(b.dataset.slot)].value;
      paint();
    }));
    const rb = root.querySelector('#olo-reorder-btn');
    if (rb) rb.addEventListener('click', async () => {
      const ph = (root.querySelector('#olo-phone-lookup').value || '').trim();
      if (!ph) { st.err = 'Enter your phone number to find your last order.'; paint(); return; }
      try {
        const last = await api('/api/online/last?phone=' + encodeURIComponent(ph));
        st.cart.clear();
        (last.items || []).forEach((it) => {
          if (byId.get(it.menu_item_id)) st.cart.set(it.menu_item_id, Math.min(20, it.qty || 1));
        });
        if (!st.cart.size) { st.err = 'Your last order is no longer on the menu.'; }
        else { st.phone = ph; st.step = 'checkout'; }
        paint();
      } catch (e) {
        st.err = e.message || 'No previous order found for that number.';
        paint();
      }
    });
    const pb = root.querySelector('#olo-place-btn');
    if (pb) pb.addEventListener('click', async () => {
      st.name = (root.querySelector('#olo-name').value || '').trim();
      st.phone = (root.querySelector('#olo-phone').value || '').trim();
      if (!st.name || !st.phone) { st.err = 'Please enter your name and phone number.'; paint(); return; }
      const items = [];
      st.cart.forEach((q, id) => items.push({ menu_item_id: id, qty: q }));
      if (!items.length) { st.err = 'Your cart is empty.'; paint(); return; }
      st.placing = true; st.err = ''; paint();
      try {
        const order = await api('/api/online/orders', 'POST', {
          customer_name: st.name,
          phone: st.phone,
          items,
          pickup_at: st.slot,
        });
        st.order = order; st.step = 'done'; st.placing = false;
        st.cart.clear();
        paint();
      } catch (e) {
        st.placing = false;
        st.err = e.message || 'Could not place the order — please try again.';
        paint();
      }
    });
  }

  paint();
}

if (typeof module !== 'undefined' && module.exports) module.exports = { renderOnlineOrder };
