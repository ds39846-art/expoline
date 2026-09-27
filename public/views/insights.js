/* ============================================================================
 * Expoline Insights view — proactive P&L digest + "Ask the restaurant anything".
 * Manager-only. Every number is cited from the same honest sales data as
 * finance: no vibes, no invented figures.
 * Usage: renderInsights(container, api). Exposed via window (IIFE).
 * ========================================================================== */
(function () {
'use strict';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function money(cents) { return '$' + ((Number(cents) || 0) / 100).toFixed(2); }

const SUGGESTED = [
  'What were sales today?',
  'Sales this week vs last week?',
  'Who is our best seller?',
  'What are our slowest sellers?',
  'Who is our top server?',
  'What did labor cost today?',
  'How much did we take in tips?',
  'Busiest hour today?',
  'What is 86\u2019d right now?',
];

function stat(k, v, cls) {
  return '<div class="stat"><div class="k">' + esc(k) + '</div><div class="v' + (cls ? ' ' + cls : '') + '">' + v + '</div></div>';
}

function deltaHtml(dp, base, samples) {
  if (dp == null || base == null) return '<span class="muted">no baseline yet</span>';
  const cls = dp >= 0 ? 'good' : 'bad';
  const sign = dp >= 0 ? '+' : '';
  return '<span class="' + cls + '">' + sign + dp + '%</span>' +
    '<div class="muted small">vs typical ' + esc(weekdayName()) + ' (' + money(base) + ', ' + samples + ' wk' + (samples === 1 ? '' : 's') + ')</div>';
}
function weekdayName() {
  return ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][new Date().getDay()];
}

function moversTable(rows, kind) {
  if (!rows || !rows.length) return '<p class="muted">No significant movers this week.</p>';
  return '<table class="t-table"><tbody>' + rows.map((m) =>
    '<tr><td>' + esc(m.name) + '</td><td>' + m.qty_prev + ' &rarr; ' + m.qty_now + '</td>' +
    '<td class="' + (kind === 'up' ? 'good' : 'bad') + '">' + (m.delta_pct >= 0 ? '+' : '') + m.delta_pct + '%</td></tr>'
  ).join('') + '</tbody></table>';
}

function serversTable(servers) {
  if (!servers || !servers.length) return '<p class="muted">No server sales today yet.</p>';
  return '<table class="t-table"><thead><tr><th>Server</th><th>Sales</th><th>Checks</th><th>Avg ticket</th><th>Tips</th><th>Tip %</th></tr></thead><tbody>' +
    servers.map((s, i) =>
      '<tr><td>' + (i === 0 ? '&#9733; ' : '') + esc(s.name) + '</td><td><b>' + money(s.sales_cents) + '</b></td>' +
      '<td>' + s.checks + '</td><td>' + money(s.avg_ticket_cents) + '</td>' +
      '<td>' + money(s.tips_cents) + '</td><td>' + s.tip_pct + '%</td></tr>'
    ).join('') + '</tbody></table>';
}

function alertsHtml(alerts) {
  if (!alerts || !alerts.length) return '<p class="muted">All quiet — no anomalies detected.</p>';
  const pill = { high: 'pill bad', warn: 'pill held', info: 'pill sent' };
  return alerts.map((a) =>
    '<div class="card mt"><span class="' + (pill[a.severity] || 'pill') + '">' + esc(a.severity) + '</span> ' +
    '<b>' + esc(a.title) + '</b><p class="muted small">' + esc(a.detail) + '</p></div>'
  ).join('');
}

async function renderInsights(container, api) {
  container.innerHTML =
    '<div class="view-head"><h1>Insights</h1><span class="spacer"></span><span class="muted small">The POS tells you what\u2019s changing — cited, not vibes</span></div>' +
    ((typeof mgrNav === 'function') ? mgrNav('insights') : '') +
    '<div class="card"><h3>Ask the restaurant anything</h3>' +
    '<div style="display:flex;gap:8px"><input id="ins-q" class="input" style="flex:1" maxlength="300" placeholder="e.g. Who is our top server?  What were sales yesterday?">' +
    '<button id="ins-ask" class="btn btn-primary">Ask</button></div>' +
    '<div class="mt" id="ins-chips">' + SUGGESTED.map((s) => '<button class="btn btn-sm btn-ghost ins-chip">' + esc(s) + '</button>').join(' ') + '</div>' +
    '<div id="ins-answer" class="mt"></div></div>' +
    '<div id="ins-digest"><p class="muted">Loading today\u2019s digest\u2026</p></div>';

  const answerBox = container.querySelector('#ins-answer');
  const qInput = container.querySelector('#ins-q');

  async function ask(q) {
    answerBox.innerHTML = '<p class="muted">Thinking\u2026</p>';
    let r;
    try { r = await api('/api/insights/ask', 'POST', { question: q }); }
    catch (e) { if (typeof handleApiError === 'function') handleApiError(e); return; }
    let html = '<div class="card"><p><b>A:</b> ' + esc(r.answer) + '</p>';
    if (r.figures && r.figures.length) {
      html += '<table class="t-table"><tbody>' + r.figures.map((f) =>
        '<tr><td class="muted">' + esc(f.label) + '</td><td><b>' + esc(f.value) + '</b></td></tr>').join('') + '</tbody></table>';
    }
    if (r.suggestions && r.suggestions.length) {
      html += '<div class="mt">' + r.suggestions.map((s) => '<button class="btn btn-sm btn-ghost ins-chip">' + esc(s) + '</button>').join(' ') + '</div>';
    }
    html += '<p class="muted small mt">Cited from live sales, labor, and menu data — never invented.</p></div>';
    answerBox.innerHTML = html;
    bindChips(answerBox);
  }
  function bindChips(root) {
    root.querySelectorAll('.ins-chip').forEach((b) => { b.onclick = () => { qInput.value = b.textContent; ask(b.textContent); }; });
  }
  bindChips(container);
  container.querySelector('#ins-ask').onclick = () => { if (qInput.value.trim()) ask(qInput.value.trim()); };
  qInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && qInput.value.trim()) ask(qInput.value.trim()); });

  let d;
  try { d = await api('/api/insights/digest'); }
  catch (e) { if (typeof handleApiError === 'function') handleApiError(e); return; }
  const t = d.today || {};
  const L = d.labor || {};

  const silent = (d.slow_sellers && d.slow_sellers.silent) || [];
  const dead = (d.slow_sellers && d.slow_sellers.dead_weight) || [];
  const slowHtml = (!silent.length && !dead.length)
    ? '<p class="muted">Everything active sold this week.</p>'
    : (silent.length ? '<h4>Was selling, now silent (7d)</h4><table class="t-table"><tbody>' +
        silent.slice(0, 8).map((s) => '<tr><td>' + esc(s.name) + '</td><td class="muted">' + s.qty_prior_21d + ' sold in prior 21d</td></tr>').join('') + '</tbody></table>' : '') +
      (dead.length ? '<h4 class="mt">Menu dead weight (no sales in 28d)</h4><p class="muted small">' +
        dead.slice(0, 8).map((s) => esc(s.name)).join(', ') + (dead.length > 8 ? ' <span class="muted">+' + (dead.length - 8) + ' more</span>' : '') + '</p>' : '');

  container.querySelector('#ins-digest').innerHTML =
    '<div class="stat-grid mt">' +
    stat('Sales today (gross)', money(t.sales_gross_cents)) +
    stat('Net sales', money(t.sales_net_cents)) +
    stat('Checks / covers', (t.check_count || 0) + ' / ' + (t.covers || 0)) +
    stat('Avg ticket', money(t.avg_ticket_cents)) +
    stat('Tips', money(t.tips_cents)) +
    stat('Labor cost', money(L.total_cents) + (L.pct_of_sales != null ? ' · ' + L.pct_of_sales + '% of net' : '')) +
    '</div>' +
    '<div class="card mt"><h3>Today vs a typical ' + esc(weekdayName()) + '</h3>' + deltaHtml(t.delta_pct, t.baseline_gross_cents, t.baseline_samples) + '</div>' +
    '<div class="card mt"><h3>&#9888; Alerts</h3>' + alertsHtml(d.alerts) + '</div>' +
    '<div class="grid2 mt">' +
    '<div class="card"><h3>&#8599; Movers up (7d vs prior 7d)</h3>' + moversTable(d.movers && d.movers.up, 'up') + '</div>' +
    '<div class="card"><h3>&#8600; Movers down (7d vs prior 7d)</h3>' + moversTable(d.movers && d.movers.down, 'down') + '</div>' +
    '</div>' +
    '<div class="card mt"><h3>&#9733; Server performance today</h3>' + serversTable(d.servers) +
    '<p class="muted small">Sales, checks, and tips per server — the leaderboard Upserve demos, from our own verified data.</p></div>' +
    '<div class="card mt"><h3>Slow sellers</h3>' + slowHtml + '</div>';
}

if (typeof module !== 'undefined' && module.exports) module.exports = { renderInsights };
else if (typeof window !== 'undefined') window.renderInsights = renderInsights;
})();
