/* ============================================================================
 * Expoline API docs view — renders GET /api/openapi.json (single registry,
 * docs can't drift from code). Machine JSON at /api/openapi.json.
 * Usage: renderApiDocs(container, api). Exposed via window (IIFE).
 * ========================================================================== */
(function () {
'use strict';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

async function renderApiDocs(container, api) {
  container.innerHTML =
    '<div class="view-head"><h1>API docs</h1><span class="spacer"></span>' +
    '<a class="btn" href="/api/openapi.json" target="_blank" rel="noopener">openapi.json</a> ' +
    '<a class="btn" href="/api/docs" target="_blank" rel="noopener">Printable</a></div>' +
    ((typeof mgrNav === 'function') ? mgrNav('apidocs') : '') +
    '<p class="muted small">Open API before an app store: integrations as documented endpoints. Internal v0.1 — staff PIN tokens only, no third-party OAuth scopes yet.</p>' +
    '<div class="card"><div class="row"><input id="ad-q" class="input" placeholder="Filter endpoints…" style="flex:1;min-width:0"></div>' +
    '<div class="t-scroll"><table class="t-table"><thead><tr><th>Method</th><th>Path</th><th>Auth</th><th>What it does</th><th>Params</th></tr></thead>' +
    '<tbody id="ad-body"><tr><td colspan="5" class="muted">Loading…</td></tr></tbody></table></div></div>';

  let eps = [];
  try {
    const r = await api('/api/openapi.json');
    eps = r.endpoints || [];
  } catch (e) { handleApiError(e); return; }

  const draw = (q) => {
    const needle = (q || '').toLowerCase();
    const rows = eps.filter((e) => !needle ||
      (e.path + ' ' + e.summary + ' ' + e.method).toLowerCase().includes(needle));
    container.querySelector('#ad-body').innerHTML = rows.map((e) =>
      '<tr><td><b>' + esc(e.method) + '</b></td><td><code>' + esc(e.path) + '</code></td><td>' + esc(e.auth) + '</td>' +
      '<td>' + esc(e.summary) + '</td><td class="muted small">' + esc(e.params) + '</td></tr>').join('') ||
      '<tr><td colspan="5" class="muted">No matches.</td></tr>';
  };
  container.querySelector('#ad-q').oninput = (ev) => draw(ev.target.value);
  draw('');
}

if (typeof module !== 'undefined' && module.exports) module.exports = { renderApiDocs };
else if (typeof window !== 'undefined') window.renderApiDocs = renderApiDocs;
})();
