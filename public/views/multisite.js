/* ============================================================================
 * Expoline multi-location dashboard — cross-site overview on top of
 * per-site DB isolation. One site's failure degrades to an error card and
 * never touches another site's numbers.
 * Usage: renderMultisite(container, api). Exposed via window (IIFE).
 * ========================================================================== */
(function () {
'use strict';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function money(cents) { return '$' + ((Number(cents) || 0) / 100).toFixed(2); }

async function renderMultisite(container, api) {
  container.innerHTML =
    '<div class="view-head"><h1>Locations</h1><span class="spacer"></span>' +
    '<button id="ms-refresh" class="btn">Refresh</button></div>' +
    ((typeof mgrNav === 'function') ? mgrNav('multisite') : '') +
    '<p class="muted small">Each site keeps its own database — this dashboard only reads them. A site that can\u2019t be read shows an error card, never breaks the rest.</p>' +
    '<div id="ms-body"><p class="muted">Loading…</p></div>';

  const body = container.querySelector('#ms-body');
  container.querySelector('#ms-refresh').onclick = load;

  async function load() {
    body.innerHTML = '<p class="muted">Loading…</p>';
    let r = null;
    try { r = await api('/api/admin/multisite/overview'); } catch (e) { handleApiError(e); return; }
    const sites = r.sites || [];
    const okSites = sites.filter((s) => s.ok);
    const totalSales = okSites.reduce((a, s) => a + (s.sales_today_cents || 0), 0);
    body.innerHTML =
      '<div class="stat-grid">' +
      '<div class="stat"><div class="k">Locations</div><div class="v">' + sites.length + '</div></div>' +
      '<div class="stat"><div class="k">Today sales (all)</div><div class="v">' + money(totalSales) + '</div></div>' +
      '<div class="stat"><div class="k">Open checks (all)</div><div class="v amber">' + okSites.reduce((a, s) => a + (s.open_checks || 0), 0) + '</div></div>' +
      '<div class="stat"><div class="k">Staff clocked in</div><div class="v">' + okSites.reduce((a, s) => a + (s.staff_clocked_in || 0), 0) + '</div></div>' +
      '</div>' +
      '<div class="grid2 mt">' + sites.map((s) => siteCard(s)).join('') + '</div>';
  }

  function siteCard(s) {
    if (!s.ok) {
      return '<div class="card"><h3>' + esc(s.name) + '</h3>' +
        '<p class="muted">⚠ Could not read this site\u2019s data.</p>' +
        '<p class="muted small">' + esc(s.error || 'unknown error') + '</p>' +
        '<p class="muted small">Other locations are unaffected.</p></div>';
    }
    return '<div class="card"><h3>' + esc(s.name) + '</h3>' +
      '<div class="stat-grid">' +
      '<div class="stat"><div class="k">Today sales</div><div class="v">' + money(s.sales_today_cents) + '</div></div>' +
      '<div class="stat"><div class="k">Covers</div><div class="v">' + s.covers_today + '</div></div>' +
      '<div class="stat"><div class="k">Open checks</div><div class="v amber">' + s.open_checks + '</div></div>' +
      '<div class="stat"><div class="k">Drawer</div><div class="v">' + esc(s.drawer) + '</div></div>' +
      '</div>' +
      '<p class="muted small mt">Staff clocked in: ' + s.staff_clocked_in + ' · <span class="muted">' + esc(s.slug) + '</span></p></div>';
  }

  load();
}

if (typeof module !== 'undefined' && module.exports) module.exports = { renderMultisite };
else if (typeof window !== 'undefined') window.renderMultisite = renderMultisite;
})();
