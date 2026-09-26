/* ============================================================================
 * Expoline product-mix view — best/worst sellers from the honest sales data.
 * No separate analytics SKU: same check_items the money reports use.
 * Usage: renderProductMix(container, api). Exposed via window (IIFE).
 * ========================================================================== */
(function () {
'use strict';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function money(cents) { return '$' + ((Number(cents) || 0) / 100).toFixed(2); }
function todayLocal() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function daysAgo(n) {
  const d = new Date(); d.setDate(d.getDate() - n);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

async function renderProductMix(container, api) {
  container.innerHTML =
    '<div class="view-head"><h1>Product mix</h1><span class="spacer"></span>' +
    '<input id="pm-from" type="date" class="input" value="' + daysAgo(6) + '">' +
    '<input id="pm-to" type="date" class="input" value="' + todayLocal() + '">' +
    '<button id="pm-go" class="btn btn-primary">Run</button></div>' +
    ((typeof mgrNav === 'function') ? mgrNav('analytics') : '') +
    '<div id="pm-body"><p class="muted">Loading…</p></div>';

  const body = container.querySelector('#pm-body');
  container.querySelector('#pm-go').onclick = load;

  async function load() {
    const from = container.querySelector('#pm-from').value;
    const to = container.querySelector('#pm-to').value;
    let r = null;
    try { r = await api('/api/finance/product-mix?from=' + encodeURIComponent(from) + '&to=' + encodeURIComponent(to)); }
    catch (e) { handleApiError(e); return; }
    const t = r.totals;
    body.innerHTML =
      '<div class="stat-grid">' +
      '<div class="stat"><div class="k">Items sold</div><div class="v">' + r.items.length + '</div></div>' +
      '<div class="stat"><div class="k">Units</div><div class="v">' + t.qty_sold + '</div></div>' +
      '<div class="stat"><div class="k">Gross</div><div class="v">' + money(t.gross_cents) + '</div></div>' +
      '<div class="stat"><div class="k">Voided units</div><div class="v ' + (t.voided_qty ? 'amber' : '') + '">' + t.voided_qty + '</div></div>' +
      '</div>' +
      '<div class="grid2 mt">' +
      '<div class="card"><h3>Best sellers (gross)</h3>' + rankTable(r.best_by_gross) + '</div>' +
      '<div class="card"><h3>Worst sellers (gross)</h3>' + rankTable(r.worst_by_gross) + '</div>' +
      '</div>' +
      '<div class="card mt"><h3>All items</h3><div class="t-scroll"><table class="t-table"><thead><tr>' +
      '<th>Item</th><th>Category</th><th>Units</th><th>Gross</th><th>Share</th><th>Voided</th><th>Void %</th></tr></thead><tbody>' +
      (r.items.map((i) => '<tr><td>' + esc(i.name) + '</td><td class="muted">' + esc(i.category || '—') + '</td><td>' +
        i.qty_sold + '</td><td>' + money(i.gross_cents) + '</td><td>' + i.gross_share_pct + '%</td><td>' +
        i.voided_qty + '</td><td class="' + (i.void_rate_pct >= 10 ? 'amber' : '') + '">' + i.void_rate_pct + '%</td></tr>').join('') ||
       '<tr><td colspan="7" class="muted">No sales in range.</td></tr>') +
      '</tbody></table></div>' +
      '<p class="muted small mt">Voided items are excluded from units/gross and shown separately — a popular-but-voided item can\u2019t hide.</p></div>';
  }

  function rankTable(rows) {
    if (!rows || !rows.length) return '<p class="muted">—</p>';
    return '<table class="t-table"><tbody>' + rows.map((i) =>
      '<tr><td>' + esc(i.name) + '</td><td>' + i.qty_sold + '×</td><td>' + money(i.gross_cents) + '</td></tr>').join('') + '</tbody></table>';
  }

  load();
}

if (typeof module !== 'undefined' && module.exports) module.exports = { renderProductMix };
else if (typeof window !== 'undefined') window.renderProductMix = renderProductMix;
})();
