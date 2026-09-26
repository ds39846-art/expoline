/* ============================================================================
 * Expoline waitlist view — quotes computed from REAL turn-time data
 * (GET /api/waitlist/quote), plus pre-ordering attached at seat time.
 * Never a fixed guess: the quote response carries its basis (bucket median,
 * sample count, fallback flag), and the UI shows it.
 * Usage: renderWaitlist(container, api). Exposed via window (IIFE, no
 * top-level collisions — see test16_frontend_globals.py).
 * ========================================================================== */
(function () {
'use strict';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function money(cents) { return '$' + ((Number(cents) || 0) / 100).toFixed(2); }
function fmtTime(iso) {
  try { return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
  catch (e) { return ''; }
}

async function renderWaitlist(container, api) {
  container.innerHTML =
    '<div class="view-head"><h1>Waitlist</h1><span class="spacer"></span>' +
    '<span class="muted small">Quotes from real turn-time data</span></div>' +
    '<div class="grid2">' +
    '<div class="card"><h3>Add to waitlist</h3>' +
    '<div class="row"><input id="wl-name" class="input" placeholder="Guest name" style="flex:2;min-width:0">' +
    '<input id="wl-phone" class="input" placeholder="Phone (optional)" inputmode="tel" style="flex:1;min-width:0"></div>' +
    '<div class="row mt"><label class="muted small" style="align-self:center">Party</label>' +
    '<input id="wl-party" class="input" type="number" min="1" max="24" value="2" style="width:5rem">' +
    '<button id="wl-quote" class="btn">Get quote</button></div>' +
    '<div id="wl-quote-out" class="mt"></div>' +
    '<h4 class="mt">Pre-order (optional — fires nothing until seated)</h4>' +
    '<div class="row"><select id="wl-menu" class="input" style="flex:1;min-width:0"><option value="">Pick a menu item…</option></select>' +
    '<input id="wl-qty" class="input" type="number" min="1" max="20" value="1" style="width:4.5rem">' +
    '<button id="wl-addpre" class="btn">+ Add</button></div>' +
    '<div id="wl-prelist" class="mt small"></div>' +
    '<div class="mt"><button id="wl-save" class="btn btn-primary btn-block">Add to waitlist</button></div>' +
    '<p class="muted small mt">No quote typed in? The server computes one from this site\u2019s turn-time history.</p></div>' +
    '<div class="card"><h3>Waiting now</h3><div id="wl-list"><p class="muted">Loading…</p></div></div>' +
    '</div>';

  const $ = (id) => container.querySelector('#' + id);
  let menu = [];
  let preorder = [];

  const drawQuote = (q) => {
    if (!q || q.quoted_wait_min == null) {
      $('wl-quote-out').innerHTML = '<p class="muted small">' + esc(q && q.reason ? q.reason : 'No quote available.') + '</p>';
      return;
    }
    const b = q.basis || {};
    $('wl-quote-out').innerHTML =
      '<div class="stat"><div class="k">Quoted wait</div><div class="v">' + q.quoted_wait_min + ' min</div></div>' +
      '<p class="muted small">Basis: party ' + esc(b.party_bucket || '?') + ' median turn ' +
      esc(b.median_turn_min) + ' min (' + esc(b.samples) + ' recent parties' +
      (b.fallback ? ', site default — thin data' : '') + '), ' + esc(b.free_now) + ' of ' +
      esc(b.suitable_tables) + ' suitable tables free, ' + esc(b.waiting_ahead) + ' ahead.</p>';
  };

  const drawPre = () => {
    $('wl-prelist').innerHTML = preorder.length
      ? '<ul class="clean">' + preorder.map((p, i) =>
          '<li>' + p.qty + '× ' + esc(p.name) + (p.unit_price_cents != null ? ' (' + money(p.unit_price_cents) + ')' : '') +
          ' <button class="btn btn-ghost btn-sm" data-pre="' + i + '">✕</button></li>').join('') + '</ul>'
      : '<p class="muted small">No pre-order items.</p>';
    $('wl-prelist').querySelectorAll('[data-pre]').forEach((btn) => {
      btn.onclick = () => { preorder.splice(Number(btn.dataset.pre), 1); drawPre(); };
    });
  };

  $('wl-quote').onclick = async () => {
    const party = Math.max(1, Math.min(24, Number($('wl-party').value) || 2));
    try { drawQuote(await api('/api/waitlist/quote?party_size=' + party)); }
    catch (e) { $('wl-quote-out').innerHTML = '<p class="muted small">Quote failed.</p>'; }
  };
  $('wl-addpre').onclick = () => {
    const id = Number($('wl-menu').value);
    const item = menu.find((m) => m.id === id);
    if (!item) return;
    const qty = Math.max(1, Math.min(20, Number($('wl-qty').value) || 1));
    preorder.push({ menu_item_id: item.id, name: item.name, qty: qty, seat: 1 });
    drawPre();
  };

  $('wl-save').onclick = async () => {
    const name = $('wl-name').value.trim();
    const party = Math.max(1, Math.min(24, Number($('wl-party').value) || 2));
    if (!name) { toast('Guest name is required', 'err'); return; }
    try {
      const w = await api('/api/waitlist', 'POST', {
        customer_name: name, phone: $('wl-phone').value.trim(), party_size: party,
        preorder_items: preorder.map((p) => ({ menu_item_id: p.menu_item_id, qty: p.qty, seat: 1 })),
      });
      toast(w.quoted_wait_min != null ? 'Added — quoted ' + w.quoted_wait_min + ' min' : 'Added to waitlist', 'ok');
      $('wl-name').value = ''; $('wl-phone').value = ''; preorder = []; drawPre(); $('wl-quote-out').innerHTML = '';
      load();
    } catch (e) { handleApiError(e); }
  };

  async function load() {
    let rows = [];
    try { rows = await api('/api/waitlist'); } catch (e) { handleApiError(e); return; }
    const byId = {};
    rows.forEach((w) => { byId[w.id] = w; });
    $('wl-list').innerHTML = rows.length ? '' : '<p class="muted">Nobody waiting.</p>';
    rows.forEach((w) => {
      const pre = (w.preorder_items || []).map((p) => p.qty + '× ' + p.name).join(', ');
      const div = document.createElement('div');
      div.className = 'wl-row';
      div.innerHTML =
        '<div><b>' + esc(w.customer_name) + '</b> · party of ' + w.party_size +
        (w.quoted_wait_min != null ? ' · quoted ' + w.quoted_wait_min + ' min' : '') +
        '<div class="muted small">waiting since ' + fmtTime(w.created_at) + (w.status === 'notified' ? ' · notified' : '') +
        (pre ? '<br>Pre-order: ' + esc(pre) : '') + '</div></div>' +
        '<div class="row">' +
        (w.status === 'waiting' ? '<button class="btn btn-sm" data-n="' + w.id + '">Notify</button>' : '') +
        '<button class="btn btn-sm btn-primary" data-s="' + w.id + '">Seat…</button>' +
        '<button class="btn btn-sm btn-ghost" data-l="' + w.id + '">Left</button></div>';
      $('wl-list').appendChild(div);
    });
    $('wl-list').querySelectorAll('[data-n]').forEach((b) => { b.onclick = async () => { try { await api('/api/waitlist/' + b.dataset.n + '/notify', 'POST'); load(); } catch (e) { handleApiError(e); } }; });
    $('wl-list').querySelectorAll('[data-l]').forEach((b) => { b.onclick = async () => { try { await api('/api/waitlist/' + b.dataset.l, 'PATCH', { status: 'left' }); load(); } catch (e) { handleApiError(e); } }; });
    $('wl-list').querySelectorAll('[data-s]').forEach((b) => { b.onclick = () => seatFlow(byId[Number(b.dataset.s)]); });
  }

  async function seatFlow(w) {
    if (!w) return;
    let avail = null;
    try { avail = await api('/api/floor/availability?party_size=' + w.party_size); } catch (e) { handleApiError(e); return; }
    const free = (avail.tables || []).filter((t) => t.status === 'free');
    if (!free.length) { toast('No free tables right now', 'err'); return; }
    confirmDialog('Seat party', 'Choose a table:<br><select id="wl-table" class="input" style="width:100%;margin-top:.5rem">' +
      free.map((t) => '<option value="' + t.id + '">' + esc(t.label) + ' (' + t.seats + ' seats' + (t.zone ? ', ' + esc(t.zone) : '') + ')</option>').join('') + '</select>',
      'Seat party', async () => {
        const tableId = Number(document.querySelector('#wl-table').value);
        try {
          const out = await api('/api/waitlist/' + w.id + '/seat', 'POST', { table_id: tableId });
          toast('Seated — check #' + out.check_id + (out.preorder_attached ? ' (' + out.preorder_attached + ' pre-order items held)' : ''), 'ok');
          load();
        } catch (e) { handleApiError(e); }
      });
  }

  try {
    const m = await api('/api/menu');
    menu = [];
    (m.categories || []).forEach((c) => (c.items || []).forEach((i) => { if (i.active !== 0) menu.push(i); }));
    $('wl-menu').innerHTML = '<option value="">Pick a menu item…</option>' +
      menu.map((i) => '<option value="' + i.id + '">' + esc(i.name) + ' — ' + money(i.price_cents) + '</option>').join('');
  } catch (e) { /* menu optional for the view */ }
  drawPre();
  load();
}

if (typeof module !== 'undefined' && module.exports) module.exports = { renderWaitlist };
else if (typeof window !== 'undefined') window.renderWaitlist = renderWaitlist;
})();
