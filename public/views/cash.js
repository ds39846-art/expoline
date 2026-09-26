/* ============================================================================
 * Expoline cash drawer view — blind-count closeout, cash log,
 * expected-vs-counted with variance audit.
 * Blind by role: the server never shows expected_cents to non-managers;
 * the count screen hides it for everyone until the count is submitted.
 * Usage: renderCashDrawer(container, api). Exposed via window (IIFE).
 * ========================================================================== */
(function () {
'use strict';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function money(cents) {
  const v = (Number(cents) || 0) / 100;
  return (v < 0 ? '-$' : '$') + Math.abs(v).toFixed(2);
}
function fmtDT(iso) {
  try { return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }
  catch (e) { return ''; }
}
function dollarsToCents(str) {
  const n = Number(String(str).replace(/[$,\s]/g, ''));
  return isFinite(n) ? Math.round(n * 100) : null;
}

async function renderCashDrawer(container, api) {
  container.innerHTML =
    '<div class="view-head"><h1>Cash drawer</h1></div>' + mgrNavSafe('cash') +
    '<div id="cd-body"><p class="muted">Loading…</p></div>';

  const body = container.querySelector('#cd-body');

  async function load() {
    let data = null;
    try { data = await api('/api/cash/drawer'); } catch (e) { handleApiError(e); return; }
    draw(data);
  }

  function draw(data) {
    const d = data.drawer;
    if (!d) {
      body.innerHTML =
        '<div class="card"><h3>No drawer open</h3><p class="muted small">Open a drawer with the starting float to begin the cash log.</p>' +
        '<div class="row"><input id="cd-float" class="input" inputmode="decimal" placeholder="Opening float, e.g. 200.00" style="max-width:14rem">' +
        '<button id="cd-open" class="btn btn-primary">Open drawer</button></div></div>' +
        '<div class="card mt"><h3>Recent closeouts</h3><div id="cd-log"><p class="muted">Loading…</p></div></div>';
      body.querySelector('#cd-open').onclick = async () => {
        const cents = dollarsToCents(body.querySelector('#cd-float').value);
        if (cents == null || cents < 0) { toast('Enter a valid float amount', 'err'); return; }
        try { await api('/api/cash/drawer/open', 'POST', { opening_float_cents: cents }); toast('Drawer opened', 'ok'); load(); }
        catch (e) { handleApiError(e); }
      };
      loadHistory();
      return;
    }
    const isMgr = d.expected_cents != null;
    let html =
      '<div class="stat-grid">' +
      '<div class="stat"><div class="k">Status</div><div class="v ' + (d.status === 'open' ? 'amber' : '') + '">' + esc(d.status) + '</div></div>' +
      '<div class="stat"><div class="k">Opening float</div><div class="v">' + money(d.opening_float_cents) + '</div></div>' +
      (isMgr && d.status === 'open'
        ? '<div class="stat"><div class="k">Expected in drawer</div><div class="v">' + money(d.expected_cents) + '</div></div>'
        : '') +
      (d.status === 'closed'
        ? '<div class="stat"><div class="k">Counted</div><div class="v">' + money(d.counted_cents) + '</div></div>' +
          '<div class="stat"><div class="k">Variance</div><div class="v ' + (d.variance_cents === 0 ? '' : 'amber') + '">' + money(d.variance_cents) + '</div></div>'
        : '') +
      '</div>' +
      '<p class="muted small">Opened ' + fmtDT(d.opened_at) + ' by ' + esc(d.opened_by || '?') +
      (isMgr ? '' : ' · <b>blind count: the expected figure is hidden from you</b>') + '</p>';
    if (d.status === 'open') {
      html +=
        '<div class="card mt"><h3>Log cash movement</h3><div class="row">' +
        '<select id="cd-kind" class="input"><option value="paid_in">Paid in</option><option value="paid_out">Paid out</option>' +
        '<option value="no_sale">No-sale open</option><option value="note">Note</option></select>' +
        '<input id="cd-amt" class="input" inputmode="decimal" placeholder="Amount" style="max-width:10rem">' +
        '<input id="cd-note" class="input" placeholder="Note (e.g. bar change)" style="flex:1;min-width:0">' +
        '<button id="cd-log" class="btn btn-primary">Log</button></div></div>' +
        '<div class="card mt"><h3>Blind-count closeout</h3>' +
        '<p class="muted small">Count the cash in the drawer and enter the total below. ' +
        (isMgr ? 'As the manager you can see the expected figure above — the count entry is still recorded blind.' : 'You cannot see the expected figure — that is the point of a blind count.') + '</p>' +
        '<div class="row"><input id="cd-counted" class="input" inputmode="decimal" placeholder="Counted cash, e.g. 486.50" style="max-width:14rem">' +
        '<button id="cd-close" class="btn btn-primary">Close drawer</button></div></div>';
    }
    html += '<div class="card mt"><h3>Cash log</h3><div class="t-scroll"><table class="t-table"><thead><tr><th>When</th><th>Event</th><th>Amount</th><th>By</th><th>Note</th></tr></thead><tbody>' +
      ((data.events || []).map((ev) =>
        '<tr><td>' + fmtDT(ev.created_at) + '</td><td>' + esc(ev.kind.replace('_', ' ')) + '</td><td>' +
        (ev.kind === 'paid_in' || ev.kind === 'paid_out' || ev.kind === 'open' || ev.kind === 'close' ? money(ev.amount_cents) : '—') +
        '</td><td>' + esc(ev.actor || '') + '</td><td class="muted">' + esc(ev.note || '') + '</td></tr>').join('') ||
       '<tr><td colspan="5" class="muted">No events yet.</td></tr>') +
      '</tbody></table></div></div>';
    body.innerHTML = html;

    const logBtn = body.querySelector('#cd-log');
    if (logBtn) logBtn.onclick = async () => {
      const kind = body.querySelector('#cd-kind').value;
      const amtStr = body.querySelector('#cd-amt').value.trim();
      const needs = kind === 'paid_in' || kind === 'paid_out';
      const cents = amtStr ? dollarsToCents(amtStr) : 0;
      if (needs && (cents == null || cents <= 0)) { toast('Enter a positive amount', 'err'); return; }
      try {
        await api('/api/cash/drawer/event', 'POST', { kind: kind, amount_cents: cents || 0, note: body.querySelector('#cd-note').value.trim() });
        toast('Logged', 'ok'); load();
      } catch (e) { handleApiError(e); }
    };
    const closeBtn = body.querySelector('#cd-close');
    if (closeBtn) closeBtn.onclick = () => {
      const cents = dollarsToCents(body.querySelector('#cd-counted').value);
      if (cents == null || cents < 0) { toast('Enter a valid counted total', 'err'); return; }
      confirmDialog('Close drawer?', 'Counted <b>' + money(cents) + '</b>. The variance is computed server-side and cannot be edited after.', 'Close drawer', async () => {
        try {
          const out = await api('/api/cash/drawer/close', 'POST', { counted_cents: cents });
          const v = out.drawer.variance_cents;
          toast(v === 0 ? 'Closed — drawer balances exactly' : 'Closed — variance ' + money(v), v === 0 ? 'ok' : 'err');
          load();
        } catch (e) { handleApiError(e); }
      });
    };
  }

  async function loadHistory() {
    let rows = [];
    try { rows = await api('/api/cash/log'); } catch (e) { return; }
    const el = body.querySelector('#cd-log');
    if (!el) return;
    el.innerHTML = rows.length
      ? '<div class="t-scroll"><table class="t-table"><thead><tr><th>Opened</th><th>Float</th><th>Expected</th><th>Counted</th><th>Variance</th><th>By</th></tr></thead><tbody>' +
        rows.map((d) => '<tr><td>' + fmtDT(d.opened_at) + '</td><td>' + money(d.opening_float_cents) + '</td><td>' +
          (d.expected_cents != null ? money(d.expected_cents) : '—') + '</td><td>' +
          (d.counted_cents != null ? money(d.counted_cents) : '—') + '</td><td class="' + (d.variance_cents ? 'amber' : '') + '">' +
          (d.variance_cents != null ? money(d.variance_cents) : '—') + '</td><td>' + esc(d.counted_by || '') + '</td></tr>').join('') +
        '</tbody></table></div>'
      : '<p class="muted">No closeouts yet.</p>';
  }

  load();
}

function mgrNavSafe(active) {
  return (typeof mgrNav === 'function') ? mgrNav(active) : '';
}

if (typeof module !== 'undefined' && module.exports) module.exports = { renderCashDrawer };
else if (typeof window !== 'undefined') window.renderCashDrawer = renderCashDrawer;
})();
