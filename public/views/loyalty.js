/* ============================================================================
 * Expoline loyalty view — Harbor Luxe styling.
 * Phone-number lookup (no app, no card), one-tap earn at close, one-tap
 * redeem at payment. Staff see visit counts + a "regular" flag.
 *
 * Not wired into nav yet — the integrator adds the route + nav entry.
 * Usage: renderLoyalty(container, api) where api(path, method, body) is the
 * app's api helper.
 * ========================================================================== */

(function () {
'use strict';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function money(cents) {
  return '$' + (cents / 100).toFixed(2);
}

async function renderLoyalty(container, api) {
  container.innerHTML =
    '<div class="view-head"><h1>Loyalty</h1><span class="spacer"></span>' +
    '<span class="muted small">Phone lookup — no app, no card</span></div>' +
    '<div class="card"><div class="row">' +
    '<input id="loy-phone" class="input" inputmode="tel" placeholder="Phone number" autocomplete="off" style="flex:1;min-width:0">' +
    '<button id="loy-lookup" class="btn primary">Look up</button>' +
    '</div><div id="loy-result" class="muted small" style="margin-top:8px">Enter a phone number to find the customer.</div></div>' +
    '<div id="loy-customer"></div>';

  const phoneEl = container.querySelector('#loy-phone');
  const resultEl = container.querySelector('#loy-result');
  const custEl = container.querySelector('#loy-customer');
  let customer = null;

  function drawCustomer() {
    if (!customer) { custEl.innerHTML = ''; return; }
    const c = customer;
    custEl.innerHTML =
      '<div class="card" style="margin-top:12px">' +
      '<div class="row"><div style="flex:1;min-width:0">' +
      '<div class="big">' + esc(c.name) + '</div>' +
      '<div class="muted small">' + esc(c.phone) + '</div>' +
      '</div>' +
      (c.is_regular ? '<span class="pill gold">★ Regular</span>' : '<span class="pill">New</span>') +
      '</div>' +
      '<div class="stat-row">' +
      '<div class="stat"><span class="stat-num">' + c.visit_count + '</span><span class="stat-label">visits</span></div>' +
      '<div class="stat"><span class="stat-num">' + c.points + '</span><span class="stat-label">points</span></div>' +
      '<div class="stat"><span class="stat-num">' + money(c.total_spent_cents) + '</span><span class="stat-label">lifetime</span></div>' +
      '</div>' +
      '<div class="row" style="margin-top:12px">' +
      '<input id="loy-check" class="input" inputmode="numeric" placeholder="Check #" style="flex:1;min-width:0">' +
      '<button id="loy-earn" class="btn">Earn on close</button>' +
      '</div>' +
      '<div class="row" style="margin-top:8px">' +
      '<input id="loy-points" class="input" inputmode="numeric" placeholder="Points (×100)" style="flex:1;min-width:0">' +
      '<button id="loy-redeem" class="btn primary">Redeem $5 / 100 pts</button>' +
      '</div>' +
      '<div id="loy-msg" class="muted small" style="margin-top:8px"></div>' +
      '</div>';

    const msg = (t, ok) => {
      const m = custEl.querySelector('#loy-msg');
      m.textContent = t; m.className = 'small ' + (ok ? 'ok-text' : 'muted');
    };
    const checkId = () => {
      const v = parseInt(custEl.querySelector('#loy-check').value, 10);
      return Number.isFinite(v) && v > 0 ? v : null;
    };

    custEl.querySelector('#loy-earn').onclick = async () => {
      const cid = checkId();
      if (!cid) { msg('Enter a check number first.'); return; }
      try {
        const r = await api('/api/loyalty/earn', 'POST', { check_id: cid, phone: c.phone, name: c.name });
        customer = r.customer;
        msg(r.already_earned ? 'Already earned for this check.' : ('+' + r.earned + ' points earned.'), true);
        drawCustomer();
      } catch (e) { msg(e.message || 'Earn failed.'); }
    };
    custEl.querySelector('#loy-redeem').onclick = async () => {
      const cid = checkId();
      const pts = parseInt(custEl.querySelector('#loy-points').value, 10);
      if (!cid) { msg('Enter a check number first.'); return; }
      if (!Number.isFinite(pts) || pts <= 0) { msg('Enter points in multiples of 100.'); return; }
      try {
        const r = await api('/api/loyalty/redeem', 'POST', { check_id: cid, phone: c.phone, points: pts });
        customer = r.customer;
        msg(money(r.discount_cents) + ' discount applied to check ' + cid + '.', true);
        drawCustomer();
      } catch (e) { msg(e.message || 'Redeem failed.'); }
    };
  }

  async function lookup() {
    const phone = phoneEl.value.trim();
    if (!phone) { resultEl.textContent = 'Enter a phone number.'; return; }
    resultEl.textContent = 'Looking up…';
    try {
      const r = await api('/api/loyalty/lookup?phone=' + encodeURIComponent(phone), 'GET');
      customer = r.customer;
      if (!customer) {
        resultEl.textContent = 'No customer found — they\u2019ll be added automatically on first earn.';
        custEl.innerHTML = '';
      } else {
        resultEl.textContent = '';
        drawCustomer();
      }
    } catch (e) {
      resultEl.textContent = e.message || 'Lookup failed.';
    }
  }

  container.querySelector('#loy-lookup').onclick = lookup;
  phoneEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') lookup(); });
}

if (typeof module !== 'undefined' && module.exports) module.exports = { renderLoyalty };
else if (typeof window !== 'undefined') window.renderLoyalty = renderLoyalty;
})();
