/* ============================================================================
 * Expoline — Phase 3A competitor parity: order & check flow UI.
 *
 * Companion to routes/parity_orders.js. IIFE-wrapped (see views/loyalty.js):
 * no top-level identifiers leak into the shared classic-script scope, so
 * qa/test16_frontend_globals.py stays green. Exposes window.ParityOrders.
 *
 * App.js calls into it from the floor, order, pay, KDS, and menu views.
 * All money stays server-side; this file only renders and calls the API.
 * ========================================================================== */

(function () {
'use strict';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function fmt(cents) { return '$' + ((Number(cents) || 0) / 100).toFixed(2); }
function $(sel, root) { return (root || document).querySelector(sel); }
function $all(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }

/* ------------------------- 1. daypart filtering -------------------------- */
/** Mirror of the server visibility rule: all-day items (blank daypart) and
 *  BAR / ALL DAY items are always orderable; the rest follow the window. */
function itemVisible(daypart, win) {
  const dp = String(daypart || '').trim().toUpperCase();
  if (!dp || dp === 'BAR' || dp === 'ALL DAY') return true;
  if (!win) return true; // outside every window: the whole menu shows
  if (dp === String(win.name || '').toUpperCase()) return true;
  return (win.also || []).some((a) => String(a).toUpperCase() === dp);
}

function filterMenuByDaypart(menu, win) {
  return (menu || []).map((c) => ({
    id: c.id, name: c.name,
    items: (c.items || []).filter((i) => itemVisible(i.daypart, win)),
  })).filter((c) => c.items.length > 0);
}

function windowForName(schedule, name) {
  return (schedule || []).find((w) => w.name === name) || null;
}

function openDaypartPicker(dp, override, onPick) {
  const wins = dp && dp.schedule ? dp.schedule : [];
  const cur = override && override !== 'auto' && override !== 'all'
    ? windowForName(wins, override) : (override === 'all' ? null : (dp && dp.window));
  const label = (w) => esc(w.name) + ' <span class="muted small">' + esc(w.start) + '–' + esc(w.end) + '</span>';
  const bd = window.openModal(
    '<h2>Menu daypart</h2><p class="muted small">The menu switches itself by the clock — this is only an override.</p>' +
    '<div class="checkbox-list">' +
    '<label><input type="radio" name="dpk" value="auto"' + (override !== 'all' && (!override || override === 'auto') ? ' checked' : '') + '><span style="flex:1"><b>Auto</b> <span class="muted small">by clock' + (dp && dp.current ? ' · now ' + esc(dp.current) : ' · now all-day') + '</span></span></label>' +
    wins.map((w) => '<label><input type="radio" name="dpk" value="' + esc(w.name) + '"' + (override === w.name ? ' checked' : '') + '><span style="flex:1">' + label(w) + '</span></label>').join('') +
    '<label><input type="radio" name="dpk" value="all"' + (override === 'all' ? ' checked' : '') + '><span style="flex:1"><b>Show everything</b> <span class="muted small">all dayparts</span></span></label>' +
    '</div><div class="modal-actions"><button class="btn btn-ghost" data-x="c">Cancel</button>' +
    '<button class="btn btn-primary" data-x="go">Apply</button></div>');
  $('[data-x="c"]', bd).onclick = window.closeModal;
  $('[data-x="go"]', bd).onclick = () => {
    const sel = $('input[name="dpk"]:checked', bd);
    window.closeModal();
    onPick(sel ? sel.value : 'auto');
  };
  return cur;
}

/* --------------------- 2. table timers / turn time ------------------------ */
function fmtElapsed(min) {
  min = Math.max(0, Math.round(min || 0));
  if (min < 60) return min + 'm';
  return Math.floor(min / 60) + 'h ' + (min % 60) + 'm';
}

function timerChip(row) {
  if (!row) return '';
  const cls = row.turn_status === 'over' ? 'over' : row.turn_status === 'watch' ? 'watch' : '';
  const icon = row.turn_status === 'over' ? '🔴' : row.turn_status === 'watch' ? '⚠️' : '⏱';
  return '<span class="timer-chip ' + cls + '" title="Seated ' + esc(row.opened_at || '') + (row.server_name ? ' · ' + esc(row.server_name) : '') + '">' +
    icon + ' ' + esc(fmtElapsed(row.elapsed_min)) + '</span>';
}

/* ------------------------- 3. guest renaming ------------------------------ */
function openRenameSeatModal(checkId, seat, currentName) {
  return new Promise((resolve) => {
    const bd = window.openModal(
      '<h2>Rename guest · Seat ' + seat + '</h2>' +
      '<p class="muted small">The name attaches to the seat once and follows the guest across splits, merges, and table moves.</p>' +
      '<div class="field"><label for="rn-name">Guest name</label>' +
      '<input type="text" id="rn-name" maxlength="40" autocomplete="off" placeholder="e.g. Maria" value="' + esc(currentName || '') + '"></div>' +
      '<div class="modal-actions"><button class="btn btn-ghost" data-x="c">Cancel</button>' +
      (currentName ? '<button class="btn btn-ghost" data-x="clear">Clear</button>' : '') +
      '<button class="btn btn-primary" data-x="go">Save</button></div>');
    const input = $('#rn-name', bd);
    input.focus(); input.select();
    const done = (v) => { window.closeModal(); resolve(v); };
    $('[data-x="c"]', bd).onclick = () => done(null);
    const clr = $('[data-x="clear"]', bd);
    if (clr) clr.onclick = () => done('');
    $('[data-x="go"]', bd).onclick = async () => {
      const name = input.value.trim();
      if (name.length > 40) { window.toast('Name must be 40 characters or fewer', 'err'); return; }
      try {
        await window.api('/api/checks/' + encodeURIComponent(checkId) + '/seats/' + seat + '/name', 'PUT', { name });
        done(name);
      } catch (e) { window.handleApiError(e); }
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('[data-x="go"]', bd).click(); });
  });
}

/* ------------------------- 4. edit fired orders --------------------------- */
function describeDelta(d) {
  if (!d) return '';
  if (d.type === 'void') {
    return 'voided' + (d.qty ? ' ' + d.qty + '×' : '') + (d.reason ? ' — ' + d.reason : '');
  }
  const before = d.before || {}, after = d.after || {};
  const bits = [];
  if (before.qty !== after.qty) bits.push(before.qty + '× → ' + after.qty + '×');
  if (before.seat !== after.seat) bits.push('Seat ' + before.seat + ' → Seat ' + after.seat);
  const bm = (before.modifiers || []).map((m) => m.name).join(', ');
  const am = (after.modifiers || []).map((m) => m.name).join(', ');
  if (bm !== am) bits.push('mods: ' + (bm || '—') + ' → ' + (am || '—'));
  return bits.join(' · ') || 'edited';
}

/** Highlighted delta row for KDS tickets — the kitchen sees the change, not a reprint. */
function deltaHtml(d) {
  const when = d.edited_at ? new Date(d.edited_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
  return '<div class="t-delta"><div class="row1"><span class="qty">✎</span>' +
    '<span class="inm">' + (d.type === 'void' ? 'VOIDED · ' : 'EDITED · ') + esc(d.name || 'Item') + '</span>' +
    (d.seat ? '<span class="seat">SEAT ' + d.seat + '</span>' : '') + '</div>' +
    '<div class="tmods">' + esc(describeDelta(d)) + '</div>' +
    '<div class="tmods muted">by ' + esc(d.actor || '?') + (d.manager ? ' · mgr ' + esc(d.manager) : '') + (when ? ' · ' + esc(when) : '') + '</div></div>';
}

async function openEditItemModal(check, item) {
  const fired = item.state === 'sent' || item.state === 'fulfilled';
  const guests = check.guest_count || 2;
  let qty = item.qty || 1, seat = item.seat || 1;
  let course = item.course || null;
  let note = item.note || '', allergy = !!item.allergy, allergyDetail = item.allergy_detail || '';
  let curMods = (item.modifiers || []).map((m) => ({ name: m.name, price_delta_cents: m.price_delta_cents || 0,
    option_id: m.option_id, note: m.note || null }));
  // Full modifier data comes from the menu so the server can validate groups.
  let groups = null, flatOptions = [];
  try {
    const menu = await window.api('/api/menu');
    outer: for (const c of menu) {
      for (const mi of (c.items || [])) {
        if (String(mi.id) === String(item.menu_item_id)) {
          groups = (mi.modifier_groups && mi.modifier_groups.length) ? mi.modifier_groups : null;
          flatOptions = mi.modifiers || [];
          break outer;
        }
      }
    }
  } catch (e) { /* fall back to current modifiers */ }
  if (!groups && !flatOptions.length) flatOptions = curMods.map((m) => ({ name: m.name, price_delta_cents: m.price_delta_cents }));

  const COURSES = ['drink', 'appetizer', 'entree', 'dessert'];
  return new Promise((resolve) => {
    const statePill = fired ? '<span class="pill sent">fired — manager approval needed</span>' : '<span class="pill held">held</span>';
    const modRow = (o, gi, oi) => {
      const on = curMods.some((c) => (o.id != null && c.option_id === o.id) || c.name === o.name);
      const cur = curMods.find((c) => (o.id != null && c.option_id === o.id) || c.name === o.name);
      return '<label class="mod-row' + (o.active === false ? ' mod-86' : '') + '">' +
        '<input type="checkbox" data-eg="' + gi + '" data-eo="' + oi + '"' + (on ? ' checked' : '') +
        (o.active === false ? ' disabled' : '') + '>' +
        '<span class="mn">' + esc(o.name) + (o.active === false ? ' <span class="pill held">86</span>' : '') + '</span>' +
        '<span class="mp">' + (o.price_delta_cents ? '+' + fmt(o.price_delta_cents) : 'incl.') + '</span></label>' +
        '<input class="mod-note-in" data-emn="' + gi + ':' + oi + '" maxlength="60" placeholder="Note for ' + esc(o.name) + ' (optional)"' +
        ' value="' + esc((cur && cur.note) || '') + '"' + (on ? '' : ' style="display:none"') + '>';
    };
    const modsHtml = groups
      ? groups.map((g, gi) => '<div class="mod-group" data-egroup="' + gi + '">' +
          '<h4>' + esc(g.name) + (g.required ? ' <span class="muted small">· required</span>' : '') + '</h4>' +
          g.options.map((o, oi) => modRow(o, gi, oi)).join('') + '</div>').join('')
      : (flatOptions.length ? '<h3>Modifiers</h3><div id="ei-mods">' +
          flatOptions.map((m, i) => {
            const on = curMods.some((c) => c.name === m.name);
            const cur = curMods.find((c) => c.name === m.name);
            return '<label class="mod-row"><input type="checkbox" data-emi="' + i + '"' + (on ? ' checked' : '') + '>' +
              '<span class="mn">' + esc(m.name) + '</span><span class="mp">+' + fmt(m.price_delta_cents) + '</span></label>' +
              '<input class="mod-note-in" data-efmn="' + i + '" maxlength="60" placeholder="Note for ' + esc(m.name) + ' (optional)"' +
              ' value="' + esc((cur && cur.note) || '') + '"' + (on ? '' : ' style="display:none"') + '>';
          }).join('') + '</div>'
        : '<p class="muted small">No modifiers for this item.</p>');
    const bd = window.openModal(
      '<h2>Edit item</h2><p><b>' + esc(item.name) + '</b> ' + statePill + '</p>' +
      '<div class="field"><label>Quantity</label><div class="stepper">' +
      '<button data-q="dec">−</button><span class="val" id="ei-qty">' + qty + '</span><button data-q="inc">+</button></div></div>' +
      '<div class="field"><label>Seat</label><div class="stepper">' +
      '<button data-s="dec">−</button><span class="val" id="ei-seat">' + seat + '</span><button data-s="inc">+</button></div></div>' +
      '<div class="field"><label for="ei-course">Course</label><select id="ei-course">' +
      '<option value="">—</option>' + COURSES.map((c) => '<option value="' + c + '"' + (course === c ? ' selected' : '') + '>' + c + '</option>').join('') +
      '</select></div>' +
      modsHtml +
      '<div class="field"><label for="ei-note">Special request</label>' +
      '<input type="text" id="ei-note" maxlength="140" value="' + esc(note) + '" placeholder="e.g. no onions" autocomplete="off"></div>' +
      '<div class="field"><label class="check-line"><input type="checkbox" id="ei-allergy"' + (allergy ? ' checked' : '') + '> ⚠️ Allergy alert</label>' +
      '<input type="text" id="ei-allergy-detail" maxlength="140" value="' + esc(allergyDetail) + '" placeholder="Allergy detail (optional)" autocomplete="off"' +
      (allergy ? '' : ' style="display:none;margin-top:6px"') + '></div>' +
      '<div class="field ei-disc"><label>Item discount / comp <span class="muted small">(manager approval for fired lines)</span></label>' +
      '<div class="row"><div class="tip-row" id="ei-dmode">' +
      '<button class="tip-chip active" data-dm="amount">$</button><button class="tip-chip" data-dm="percent">%</button></div>' +
      '<input type="number" id="ei-dval" min="0" step="0.01" placeholder="0.00" style="max-width:110px">' +
      '<input type="text" id="ei-dreason" maxlength="120" placeholder="Reason (required)" style="flex:1"></div></div>' +
      (fired ? '<div class="field"><label for="ei-pin">Manager PIN <span class="muted small">(fired items)</span></label>' +
        '<input type="password" id="ei-pin" inputmode="numeric" maxlength="4" placeholder="••••" style="max-width:140px" autocomplete="off"></div>' : '') +
      '<div class="modal-actions"><button class="btn btn-ghost" data-x="c">Cancel</button>' +
      '<button class="btn" id="ei-repeat" title="Add the same line again">Repeat 🔁</button>' +
      '<button class="btn btn-primary" data-x="go">Save changes</button></div>');

    $('[data-q="dec"]', bd).onclick = () => { qty = Math.max(1, qty - 1); $('#ei-qty', bd).textContent = qty; };
    $('[data-q="inc"]', bd).onclick = () => { qty = Math.min(24, qty + 1); $('#ei-qty', bd).textContent = qty; };
    $('[data-s="dec"]', bd).onclick = () => { seat = Math.max(1, seat - 1); $('#ei-seat', bd).textContent = seat; };
    $('[data-s="inc"]', bd).onclick = () => { seat = Math.min(guests, seat + 1); $('#ei-seat', bd).textContent = seat; };
    $('#ei-allergy', bd).onchange = (e) => { $('#ei-allergy-detail', bd).style.display = e.target.checked ? 'block' : 'none'; };
    let dMode = 'amount';
    $$('#ei-dmode .tip-chip', bd).forEach((b) => b.onclick = () => {
      $$('#ei-dmode .tip-chip', bd).forEach((x) => x.classList.remove('active'));
      b.classList.add('active'); dMode = b.dataset.dm;
    });
    // Per-modifier note inputs follow their checkbox.
    bd.addEventListener('change', (e) => {
      const t = e.target;
      if (t.matches('input[data-eg]')) {
        const inp = $('.mod-note-in[data-emn="' + t.dataset.eg + ':' + t.dataset.eo + '"]', bd);
        if (inp) { inp.style.display = t.checked ? 'block' : 'none'; if (!t.checked) inp.value = ''; }
      } else if (t.matches('input[data-emi]')) {
        const inp = $('.mod-note-in[data-efmn="' + t.dataset.emi + '"]', bd);
        if (inp) { inp.style.display = t.checked ? 'block' : 'none'; if (!t.checked) inp.value = ''; }
      }
    });
    const readMods = () => {
      if (groups) {
        return $$('.mod-group input[data-eg]:checked', bd).map((c) => {
          const o = groups[Number(c.dataset.eg)].options[Number(c.dataset.eo)];
          const m = { name: o.name, price_delta_cents: o.price_delta_cents, option_id: o.id };
          const inp = $('.mod-note-in[data-emn="' + c.dataset.eg + ':' + c.dataset.eo + '"]', bd);
          const nt = inp && inp.value.trim();
          if (nt) m.note = nt.slice(0, 60);
          return m;
        });
      }
      return $$('#ei-mods input[data-emi]:checked', bd).map((c) => {
        const m0 = flatOptions[Number(c.dataset.emi)];
        const m = { name: m0.name, price_delta_cents: m0.price_delta_cents };
        const inp = $('.mod-note-in[data-efmn="' + c.dataset.emi + '"]', bd);
        const nt = inp && inp.value.trim();
        if (nt) m.note = nt.slice(0, 60);
        return m;
      });
    };
    const needPin = () => {
      if (!fired) return null;
      const pin = $('#ei-pin', bd).value.trim();
      if (!/^\d{4}$/.test(pin)) { window.toast("Enter the manager's 4-digit PIN", 'err'); return undefined; }
      return pin;
    };
    $('[data-x="c"]', bd).onclick = () => { window.closeModal(); resolve(false); };
    // Repeat (P1-2): same line again — qty, seat, modifiers, course, notes
    // ride along; discounts never copy.
    $('#ei-repeat', bd).onclick = async () => {
      try {
        await window.api('/api/checks/' + encodeURIComponent(check.id) + '/items/' + encodeURIComponent(item.id) + '/duplicate', 'POST', {});
        window.closeModal();
        window.toast('Repeated — same line added again', 'ok');
        resolve(true);
      } catch (e) { window.handleApiError(e); }
    };
    $('[data-x="go"]', bd).onclick = async () => {
      const picked = readMods();
      const b2 = { qty, seat, modifiers: picked };
      const cv = $('#ei-course', bd).value;
      b2.course = cv || null;
      b2.note = $('#ei-note', bd).value.trim().slice(0, 140) || null;
      b2.allergy = $('#ei-allergy', bd).checked;
      b2.allergy_detail = b2.allergy ? ($('#ei-allergy-detail', bd).value.trim().slice(0, 140) || null) : null;
      // Optional item discount in the same save (manager PIN covers both).
      const dVal = parseFloat($('#ei-dval', bd).value || '0');
      const dReason = $('#ei-dreason', bd).value.trim();
      let applyDiscount = null;
      if (dVal > 0) {
        if (!dReason) { window.toast('A reason is required for the discount', 'err'); return; }
        applyDiscount = { reason: dReason };
        if (dMode === 'amount') applyDiscount.amount_cents = Math.round(dVal * 100);
        else {
          if (dVal <= 0 || dVal > 100) { window.toast('Percent must be between 0 and 100', 'err'); return; }
          applyDiscount.percent = dVal;
        }
      }
      const pin = needPin();
      if (pin === undefined) return;
      if (pin) { b2.manager_pin = pin; if (applyDiscount) applyDiscount.manager_pin = pin; }
      try {
        const r = await window.api('/api/checks/' + encodeURIComponent(check.id) + '/items/' + encodeURIComponent(item.id), 'PATCH', b2);
        if (applyDiscount) {
          const itemId = (r.item && r.item.id) || item.id;
          await window.api('/api/checks/' + encodeURIComponent(check.id) + '/items/' + encodeURIComponent(itemId) + '/discount', 'POST', applyDiscount);
        }
        window.closeModal();
        window.toast('Item updated' + (r.kds_deltas ? ' — kitchen notified' : ''), 'ok');
        resolve(true);
      } catch (e) {
        if (e && e.status === 400 && /No changes/.test(e.message || e.error || '')) { window.toast('No changes to save', 'err'); }
        else window.handleApiError(e);
      }
    };
  });
}

/* ------------------- 5. tap-and-drop visual splitting --------------------- */
/** Drag items between checks. Touch fallback: tap a card to select it, then
 *  tap a destination column. The 3-tap even split stays the default — this
 *  is for the complex cases Toast makes painful. */
async function openVisualSplit(checkId) {
  let check, openChecks;
  try {
    const [c, oc] = await Promise.all([
      window.api('/api/checks/' + encodeURIComponent(checkId)),
      window.api('/api/checks/open'),
    ]);
    check = c.check || c; openChecks = oc.checks || oc;
  } catch (e) { window.handleApiError(e); return false; }

  const billable = (c) => (c.items || []).filter((i) => ['held', 'sent', 'fulfilled'].includes(i.state));
  const cols = []; // {key, label, checkId|null(new), items}
  cols.push({ key: 'cur', label: (check.table_label || 'Check') + ' · current', checkId: check.id, items: billable(check) });
  const others = openChecks.filter((o) => String(o.id) !== String(check.id));
  let newColAdded = false;

  const bd = window.openModal(
    '<h2>Visual split</h2><p class="muted small">Drag an item onto another check — or tap the item, then tap the destination. Totals update live.</p>' +
    '<div class="field"><label>Add a check column</label><div class="row" id="vs-add" style="flex-wrap:wrap;gap:6px"></div></div>' +
    '<div class="vs-cols" id="vs-cols"></div>' +
    '<div class="modal-actions"><button class="btn btn-primary" data-x="done">Done</button></div>');

  const colsEl = $('#vs-cols', bd), addEl = $('#vs-add', bd);
  let selected = null; // {itemId, fromKey}

  async function refreshCols() {
    for (const col of cols) {
      if (col.checkId == null) continue;
      try {
        const r = await window.api('/api/checks/' + encodeURIComponent(col.checkId));
        const c = r.check || r;
        col.items = billable(c); col.label = (c.table_label || c.tab_name || 'Check') + (String(c.id) === String(check.id) ? ' · current' : '');
        col.total = c.totals ? c.totals.total : c.total_cents;
      } catch (e) { /* keep stale */ }
    }
    drawCols();
  }

  function drawCols() {
    colsEl.innerHTML = cols.map((col) =>
      '<div class="vs-col" data-col="' + esc(col.key) + '" tabindex="0" aria-label="Drop onto ' + esc(col.label) + '">' +
      '<div class="vs-col-head"><b>' + esc(col.label) + '</b><span class="muted small">' + (col.total != null ? fmt(col.total) : '') + '</span></div>' +
      (col.items.length ? col.items.map((i) =>
        '<div class="vs-card' + (selected && selected.itemId === String(i.id) ? ' sel' : '') + '" draggable="true" data-item="' + esc(String(i.id)) + '" data-from="' + esc(col.key) + '">' +
        '<span class="nm">' + (i.qty > 1 ? i.qty + '× ' : '') + esc(i.name) + '</span>' +
        '<span class="muted small">Seat ' + (i.seat || '—') + '</span>' +
        '<span class="pr">' + fmt(i.line_total_cents) + '</span></div>').join('')
        : '<div class="muted small" style="padding:8px">Drop items here</div>') +
      '</div>').join('');

    $all('.vs-card', colsEl).forEach((card) => {
      card.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', JSON.stringify({ itemId: card.dataset.item, fromKey: card.dataset.from }));
        e.dataTransfer.effectAllowed = 'move';
      });
      card.onclick = () => {
        const id = card.dataset.item, from = card.dataset.from;
        selected = (selected && selected.itemId === id) ? null : { itemId: id, fromKey: from };
        drawCols();
      };
    });
    $all('.vs-col', colsEl).forEach((colEl) => {
      colEl.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; colEl.classList.add('drop-hi'); });
      colEl.addEventListener('dragleave', () => colEl.classList.remove('drop-hi'));
      colEl.addEventListener('drop', (e) => {
        e.preventDefault(); colEl.classList.remove('drop-hi');
        try { const d = JSON.parse(e.dataTransfer.getData('text/plain')); dropOnto(colEl.dataset.col, d.itemId, d.fromKey); }
        catch (err) { /* ignore */ }
      });
      colEl.onclick = (e) => {
        if (e.target.closest('.vs-card') || !selected) return;
        dropOnto(colEl.dataset.col, selected.itemId, selected.fromKey);
      };
    });
  }

  async function dropOnto(toKey, itemId, fromKey) {
    if (toKey === fromKey) { selected = null; drawCols(); return; }
    const fromCol = cols.find((c) => c.key === fromKey);
    const toCol = cols.find((c) => c.key === toKey);
    if (!fromCol || !toCol || fromCol.checkId == null) return;
    const target = toCol.checkId == null ? 'new' : toCol.checkId;
    try {
      const r = await window.api('/api/checks/' + encodeURIComponent(fromCol.checkId) + '/split', 'POST',
        { mode: 'move', item_ids: [Number(itemId)], target });
      if (target === 'new' && r.checks && r.checks[0]) {
        toCol.checkId = r.checks[0]; // the "new check" column becomes real
      }
      selected = null;
      window.toast('Item moved', 'ok');
      await refreshCols();
    } catch (e) { window.handleApiError(e); }
  }

  function drawAdd() {
    const avail = others.filter((o) => !cols.some((c) => String(c.checkId) === String(o.id)));
    addEl.innerHTML =
      avail.map((o) => '<button class="btn btn-sm" data-add="' + esc(String(o.id)) + '">' +
        esc(o.table_label || o.tab_name || ('Check ' + o.id)) + '</button>').join('') +
      (!newColAdded ? '<button class="btn btn-sm btn-ghost" data-addnew="1">+ New check</button>' : '');
    $all('[data-add]', addEl).forEach((b) => b.onclick = async () => {
      const o = others.find((x) => String(x.id) === b.dataset.add);
      try {
        const r = await window.api('/api/checks/' + encodeURIComponent(o.id));
        const c = r.check || r;
        cols.push({ key: 'c' + o.id, label: c.table_label || c.tab_name || 'Check', checkId: o.id, items: billable(c), total: (c.totals || {}).total });
      } catch (e) { window.handleApiError(e); return; }
      drawAdd(); drawCols();
    });
    const an = $('[data-addnew]', addEl);
    if (an) an.onclick = () => {
      newColAdded = true;
      cols.push({ key: 'new', label: '+ New check', checkId: null, items: [], total: null });
      drawAdd(); drawCols();
    };
  }

  drawAdd(); drawCols();
  await refreshCols();
  return new Promise((resolve) => {
    $('[data-x="done"]', bd).onclick = () => { window.closeModal(); resolve(true); };
  });
}

/* ------------------------- 6/7. merge + move ------------------------------ */
/** One-tap merge picker: choose which open check(s) to fold into this one. */
async function openMergePicker(checkId) {
  let openChecks;
  try { openChecks = await window.api('/api/checks/open'); }
  catch (e) { window.handleApiError(e); return false; }
  const others = (openChecks.checks || openChecks).filter((o) => String(o.id) !== String(checkId));
  if (!others.length) { window.toast('No other open checks to merge', 'err'); return false; }
  return new Promise((resolve) => {
    const bd = window.openModal(
      '<h2>Merge into this check</h2><p class="muted small">Seat maps are preserved and renumbered — no re-keying. Checks with payments or a large-party service charge can’t be merged.</p>' +
      '<div class="checkbox-list">' + others.map((o) =>
        '<label><input type="checkbox" data-mg="' + esc(String(o.id)) + '"><span style="flex:1"><b>' +
        esc(o.table_label || o.tab_name || ('Check ' + o.id)) + '</b> <span class="muted small">' +
        (o.guest_count || 0) + ' guests · ' + fmt(o.total_cents) + '</span></span></label>').join('') +
      '</div><div class="modal-actions"><button class="btn btn-ghost" data-x="c">Cancel</button>' +
      '<button class="btn btn-primary" data-x="go">Merge</button></div>');
    $('[data-x="c"]', bd).onclick = () => { window.closeModal(); resolve(false); };
    $('[data-x="go"]', bd).onclick = async () => {
      const ids = $all('[data-mg]:checked', bd).map((c) => Number(c.dataset.mg));
      if (!ids.length) { window.toast('Pick at least one check', 'err'); return; }
      try {
        const r = await window.api('/api/checks/' + encodeURIComponent(checkId) + '/merge', 'POST', { source_check_ids: ids });
        window.closeModal();
        window.toast('Merged — ' + (r.closed || []).length + ' check(s) folded in', 'ok');
        resolve(true);
      } catch (e) { window.handleApiError(e); }
    };
  });
}

window.ParityOrders = {
  itemVisible, filterMenuByDaypart, windowForName, openDaypartPicker,
  fmtElapsed, timerChip,
  openRenameSeatModal,
  openEditItemModal, describeDelta, deltaHtml,
  openVisualSplit, openMergePicker,
};
if (typeof module !== 'undefined' && module.exports) module.exports = window.ParityOrders;
})();
