/* ============================================================================
 * Expoline inventory view (manager) — phase 1: ingredient records,
 * per-item recipes, manual adjustments, low-stock alerts. Depletion happens
 * automatically when items fire (/send).
 * Usage: renderInventory(container, api). Exposed via window (IIFE).
 * ========================================================================== */
(function () {
'use strict';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function money(cents) { return '$' + ((Number(cents) || 0) / 100).toFixed(2); }
function fmtDT(iso) {
  try { return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }
  catch (e) { return ''; }
}
function num(n) { return (Math.round((Number(n) || 0) * 100) / 100).toString(); }

async function renderInventory(container, api) {
  container.innerHTML =
    '<div class="view-head"><h1>Inventory</h1><span class="spacer"></span>' +
    '<button id="iv-add" class="btn btn-primary">+ Ingredient</button></div>' +
    ((typeof mgrNav === 'function') ? mgrNav('inventory') : '') +
    '<p class="muted small">Phase 1: ingredients deplete automatically when items fire. Receiving, POs, and waste tracking are not in this phase.</p>' +
    '<div id="iv-low"></div>' +
    '<div class="card mt"><h3>Ingredients</h3><div class="t-scroll"><table class="t-table"><thead><tr>' +
    '<th>Name</th><th>On hand</th><th>Par</th><th>Unit cost</th><th>Stock value</th><th></th></tr></thead>' +
    '<tbody id="iv-body"><tr><td colspan="6" class="muted">Loading…</td></tr></tbody></table></div></div>' +
    '<div class="grid2 mt"><div class="card"><h3>Recipe for a menu item</h3>' +
    '<div class="row"><select id="iv-item" class="input" style="flex:1;min-width:0"><option value="">Pick item…</option></select></div>' +
    '<div id="iv-recipe" class="mt"><p class="muted small">Pick a menu item to see or edit its ingredient lines.</p></div></div>' +
    '<div class="card"><h3>Recent adjustments</h3><div id="iv-adj"><p class="muted small">Loading…</p></div></div></div>';

  const $ = (id) => container.querySelector('#' + id);
  let ingredients = [];
  let menuItems = [];
  $('iv-add').onclick = () => ingDialog(null);

  async function load() {
    try {
      [ingredients] = [await api('/api/admin/inventory/ingredients')];
    } catch (e) { handleApiError(e); return; }
    $('iv-body').innerHTML = ingredients.length ? ingredients.map((g) => {
      const low = g.on_hand <= g.par;
      return '<tr><td><b>' + esc(g.name) + '</b><div class="muted small">' + esc(g.unit) + (low ? ' · <span class="amber">LOW</span>' : '') + '</div></td>' +
        '<td>' + num(g.on_hand) + '</td><td class="muted">' + num(g.par) + '</td><td>' + money(g.cost_per_unit_cents) + '</td>' +
        '<td>' + money(Math.round(g.on_hand * g.cost_per_unit_cents)) + '</td>' +
        '<td><button class="btn btn-sm" data-e="' + g.id + '">Edit</button> ' +
        '<button class="btn btn-sm" data-a="' + g.id + '">Adjust</button> ' +
        '<button class="btn btn-sm btn-ghost" data-d="' + g.id + '">✕</button></td></tr>';
    }).join('') : '<tr><td colspan="6" class="muted">No ingredients yet.</td></tr>';
    $('iv-body').querySelectorAll('[data-e]').forEach((b) => { b.onclick = () => ingDialog(ingredients.find((g) => g.id === Number(b.dataset.e))); });
    $('iv-body').querySelectorAll('[data-a]').forEach((b) => { b.onclick = () => adjustDialog(ingredients.find((g) => g.id === Number(b.dataset.a))); });
    $('iv-body').querySelectorAll('[data-d]').forEach((b) => {
      b.onclick = () => confirmDialog('Deactivate ingredient?', 'History is kept; it just won\u2019t appear in recipes.', 'Deactivate', async () => {
        try { await api('/api/admin/inventory/ingredients/' + b.dataset.d, 'DELETE'); load(); } catch (e) { handleApiError(e); }
      });
    });
    loadStatus();
  }

  async function loadStatus() {
    let st = null;
    try { st = await api('/api/inventory/status'); } catch (e) { return; }
    $('iv-low').innerHTML = st.low_stock.length
      ? '<div class="card warn"><h3>⚠ Low stock (' + st.low_stock.length + ')</h3><p>' +
        st.low_stock.map((g) => '<span class="pill low">' + esc(g.name) + ' ' + num(g.on_hand) + ' ' + esc(g.unit) + '</span>').join(' ') + '</p></div>'
      : '';
    $('iv-adj').innerHTML = st.recent_adjustments.length
      ? '<table class="t-table"><tbody>' + st.recent_adjustments.slice(0, 10).map((a) =>
          '<tr><td>' + esc(a.ingredient_name) + '</td><td class="' + (a.delta < 0 ? 'amber' : '') + '">' +
          (a.delta > 0 ? '+' : '') + num(a.delta) + '</td><td class="muted small">' + esc(a.reason || '') + ' · ' + esc(a.actor || '') + '</td>' +
          '<td class="muted small">' + fmtDT(a.created_at) + '</td></tr>').join('') + '</tbody></table>'
      : '<p class="muted small">No adjustments yet.</p>';
  }

  function ingDialog(g) {
    const dlg =
      '<label class="muted small">Name</label><input id="ig-name" class="input" style="width:100%" value="' + esc(g ? g.name : '') + '">' +
      '<div class="row"><div style="flex:1"><label class="muted small">Unit</label><input id="ig-unit" class="input" style="width:100%" value="' + esc(g ? g.unit : 'ea') + '"></div>' +
      '<div style="flex:1"><label class="muted small">On hand</label><input id="ig-oh" class="input" inputmode="decimal" style="width:100%" value="' + (g ? num(g.on_hand) : '0') + '"></div>' +
      '<div style="flex:1"><label class="muted small">Par</label><input id="ig-par" class="input" inputmode="decimal" style="width:100%" value="' + (g ? num(g.par) : '0') + '"></div></div>' +
      '<label class="muted small">Unit cost $</label><input id="ig-cost" class="input" inputmode="decimal" style="width:100%" value="' + (g ? (g.cost_per_unit_cents / 100).toFixed(2) : '0') + '">';
    confirmDialog(g ? 'Edit ingredient' : 'New ingredient', dlg, g ? 'Save' : 'Add', async () => {
      const q = (id) => document.querySelector('#' + id).value;
      const payload = {
        name: q('ig-name').trim(), unit: q('ig-unit').trim() || 'ea',
        on_hand: Number(q('ig-oh')) || 0, par: Number(q('ig-par')) || 0,
        cost_per_unit_cents: Math.round((Number(q('ig-cost')) || 0) * 100),
      };
      try {
        if (g) await api('/api/admin/inventory/ingredients/' + g.id, 'PUT', payload);
        else await api('/api/admin/inventory/ingredients', 'POST', payload);
        toast('Saved', 'ok'); load();
      } catch (e) { handleApiError(e); }
    });
  }

  function adjustDialog(g) {
    if (!g) return;
    confirmDialog('Adjust ' + esc(g.name),
      '<p class="muted small">Current on hand: ' + num(g.on_hand) + ' ' + esc(g.unit) + '</p>' +
      '<label class="muted small">Delta (use − for usage/spoilage)</label><input id="ia-delta" class="input" inputmode="decimal" style="width:100%" placeholder="-2">' +
      '<label class="muted small">Reason</label><input id="ia-reason" class="input" style="width:100%" placeholder="e.g. spoilage, receiving">',
      'Apply', async () => {
        const q = (id) => document.querySelector('#' + id).value;
        const delta = Number(q('ia-delta'));
        if (!isFinite(delta) || delta === 0) { toast('Enter a non-zero delta', 'err'); return; }
        try {
          await api('/api/admin/inventory/adjust', 'POST', { ingredient_id: g.id, delta: delta, reason: q('ia-reason').trim() });
          toast('Adjusted', 'ok'); load();
        } catch (e) { handleApiError(e); }
      });
  }

  // ---- recipe editor ----
  async function loadMenu() {
    try {
      const m = await api('/api/menu');
      menuItems = [];
      (m.categories || []).forEach((c) => (c.items || []).forEach((i) => { if (i.active !== 0) menuItems.push(i); }));
      $('iv-item').innerHTML = '<option value="">Pick item…</option>' +
        menuItems.map((i) => '<option value="' + i.id + '">' + esc(i.name) + '</option>').join('');
    } catch (e) { /* optional */ }
  }
  $('iv-item').onchange = async () => {
    const id = Number($('iv-item').value);
    if (!id) { $('iv-recipe').innerHTML = '<p class="muted small">Pick a menu item to see or edit its ingredient lines.</p>'; return; }
    let lines = [];
    try { lines = await api('/api/admin/inventory/recipes?menu_item_id=' + id); } catch (e) { handleApiError(e); return; }
    drawRecipe(id, lines);
  };
  function drawRecipe(itemId, lines) {
    $('iv-recipe').innerHTML =
      (lines.length ? '<ul class="clean">' + lines.map((l) =>
        '<li>' + esc(l.ingredient_name) + ' — ' + num(l.qty) + ' ' + esc(l.unit) + '</li>').join('') + '</ul>'
        : '<p class="muted small">No recipe lines yet.</p>') +
      '<div class="row mt"><select id="iv-ing" class="input" style="flex:1;min-width:0">' +
      ingredients.map((g) => '<option value="' + g.id + '">' + esc(g.name) + ' (' + esc(g.unit) + ')</option>').join('') + '</select>' +
      '<input id="iv-qty" class="input" inputmode="decimal" placeholder="Qty" style="width:5rem">' +
      '<button id="iv-addline" class="btn">+ Line</button></div>' +
      '<div class="mt"><button id="iv-saverecipe" class="btn btn-primary">Save recipe</button></div>';
    let working = lines.map((l) => ({ ingredient_id: l.ingredient_id, ingredient_name: l.ingredient_name, unit: l.unit, qty: l.qty }));
    const redraw = () => {
      const ul = $('iv-recipe').querySelector('ul');
      if (ul) ul.innerHTML = working.map((l, i) =>
        '<li>' + esc(l.ingredient_name) + ' — ' + num(l.qty) + ' ' + esc(l.unit) +
        ' <button class="btn btn-ghost btn-sm" data-rl="' + i + '">✕</button></li>').join('');
      $('iv-recipe').querySelectorAll('[data-rl]').forEach((b) => {
        b.onclick = () => { working.splice(Number(b.dataset.rl), 1); drawRecipe(itemId, workingAsLines(working)); };
      });
    };
    const workingAsLines = (w) => w.map((l) => ({ ingredient_id: l.ingredient_id, ingredient_name: l.ingredient_name, unit: l.unit, qty: l.qty }));
    $('iv-addline').onclick = () => {
      const gid = Number($('iv-ing').value);
      const g = ingredients.find((x) => x.id === gid);
      const qty = Number($('iv-qty').value);
      if (!g || !isFinite(qty) || qty <= 0) { toast('Pick an ingredient and a positive qty', 'err'); return; }
      if (working.some((l) => l.ingredient_id === gid)) { toast('Already in the recipe', 'err'); return; }
      working.push({ ingredient_id: gid, ingredient_name: g.name, unit: g.unit, qty: qty });
      drawRecipe(itemId, workingAsLines(working));
    };
    redraw();
    $('iv-saverecipe').onclick = async () => {
      try {
        await api('/api/admin/inventory/recipes', 'POST', {
          menu_item_id: itemId,
          lines: working.map((l) => ({ ingredient_id: l.ingredient_id, qty: l.qty })),
        });
        toast('Recipe saved — future fires deplete stock', 'ok');
      } catch (e) { handleApiError(e); }
    };
  }

  await loadMenu();
  load();
}

if (typeof module !== 'undefined' && module.exports) module.exports = { renderInventory };
else if (typeof window !== 'undefined') window.renderInventory = renderInventory;
})();
