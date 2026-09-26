'use strict';
/* Expoline — Gift Cards view (Harbor Luxe).
 * Exported as renderGiftCards(container, api). NOT wired into nav here;
 * the integrator mounts it. Depends on the app.js globals: esc, fmt, toast.
 * api(path, method, body) matches the app.js api() signature.
 */

function renderGiftCards(container, api) {
  const root = container;
  root.innerHTML =
    '<div class="view-head"><h2 style="font-family:var(--serif);color:var(--brass-hi);margin:0">Gift Cards</h2>' +
    '<div class="spacer"></div>' +
    '<span style="color:var(--text-dim);font-size:.9rem">Stored value · no manager needed to redeem</span></div>' +

    '<div class="card"><h3 style="font-family:var(--serif);color:var(--text);margin:0 0 8px">Balance lookup</h3>' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
    '<input id="gc-lookup-code" class="mono" placeholder="XXXX-XXXX-XXXX" ' +
    ' style="flex:1;min-width:200px;background:var(--ink-2);border:1px solid var(--line);color:var(--text);' +
    ' border-radius:var(--radius-sm);padding:12px;font-size:1.05rem;letter-spacing:.08em;text-transform:uppercase" />' +
    '<button class="btn btn-primary" id="gc-lookup-btn">Check balance</button></div>' +
    '<div id="gc-lookup-result" style="margin-top:10px"></div></div>' +

    '<div class="card"><h3 style="font-family:var(--serif);color:var(--text);margin:0 0 8px">Issue new card</h3>' +
    '<div class="field"><label>Initial value</label>' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
    [2500, 5000, 10000, 25000].map((c) =>
      '<button class="btn btn-ghost gc-amt" data-amt="' + c + '">' + '$' + (c / 100) + '</button>').join('') +
    '</div></div>' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
    '<input id="gc-issue-amt" inputmode="numeric" placeholder="Custom amount in cents" ' +
    ' style="flex:1;min-width:160px;background:var(--ink-2);border:1px solid var(--line);color:var(--text);' +
    ' border-radius:var(--radius-sm);padding:12px;font-size:1rem" />' +
    '<button class="btn btn-primary" id="gc-issue-btn">Issue card</button></div>' +
    '<div id="gc-issue-result" style="margin-top:10px"></div></div>' +

    '<div class="card"><h3 style="font-family:var(--serif);color:var(--text);margin:0 0 8px">Reload</h3>' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
    '<input id="gc-reload-code" placeholder="Card code" ' +
    ' style="flex:1;min-width:160px;background:var(--ink-2);border:1px solid var(--line);color:var(--text);' +
    ' border-radius:var(--radius-sm);padding:12px;text-transform:uppercase" />' +
    '<input id="gc-reload-amt" inputmode="numeric" placeholder="Cents" ' +
    ' style="width:120px;background:var(--ink-2);border:1px solid var(--line);color:var(--text);' +
    ' border-radius:var(--radius-sm);padding:12px" />' +
    '<button class="btn btn-green" id="gc-reload-btn">Reload</button></div>' +
    '<div id="gc-reload-result" style="margin-top:10px"></div></div>' +

    '<div class="card"><h3 style="font-family:var(--serif);color:var(--text);margin:0 0 8px">Recent cards</h3>' +
    '<div id="gc-list"><p style="color:var(--text-dim)">Loading…</p></div></div>';

  const $id = (id) => root.querySelector('#' + id);
  const money = (c) => '$' + ((Number(c) || 0) / 100).toFixed(2);
  const statusChip = (s) => {
    const color = s === 'active' ? 'var(--green)' : s === 'depleted' ? 'var(--amber)' : 'var(--red)';
    return '<span style="color:' + color + ';font-weight:600">' + esc(s) + '</span>';
  };
  const cardHtml = (c) =>
    '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;' +
    'padding:10px 0;border-bottom:1px solid var(--line-soft)">' +
    '<div><div class="mono" style="letter-spacing:.06em">' + esc(c.code) + '</div>' +
    '<div style="color:var(--text-dim);font-size:.85rem">' + statusChip(c.status) + '</div></div>' +
    '<div style="text-align:right"><div style="font-size:1.15rem;color:var(--brass-hi)">' + money(c.balance_cents) + '</div>' +
    '<div style="color:var(--text-faint);font-size:.8rem">of ' + money(c.initial_cents) + '</div></div></div>';

  async function refreshList() {
    try {
      const d = await api('/api/gift-cards', 'GET');
      $id('gc-list').innerHTML = d.cards.length
        ? d.cards.map(cardHtml).join('')
        : '<p style="color:var(--text-dim)">No cards issued yet.</p>';
    } catch (e) {
      $id('gc-list').innerHTML = '<p style="color:var(--red)">Could not load cards.</p>';
    }
  }

  $id('gc-lookup-btn').addEventListener('click', async () => {
    const code = $id('gc-lookup-code').value.trim();
    if (!code) return;
    try {
      const d = await api('/api/gift-cards/balance/' + encodeURIComponent(code), 'GET');
      $id('gc-lookup-result').innerHTML = cardHtml(d.card);
    } catch (e) {
      $id('gc-lookup-result').innerHTML = '<p style="color:var(--red)">' + esc(e.message || 'Not found') + '</p>';
    }
  });

  root.querySelectorAll('.gc-amt').forEach((b) =>
    b.addEventListener('click', () => { $id('gc-issue-amt').value = b.dataset.amt; }));

  $id('gc-issue-btn').addEventListener('click', async () => {
    const v = parseInt($id('gc-issue-amt').value, 10);
    if (!v || v <= 0) { toast('Enter an amount in cents', 'err'); return; }
    try {
      const d = await api('/api/gift-cards/issue', 'POST', { initial_cents: v });
      $id('gc-issue-result').innerHTML =
        '<p style="color:var(--green)">Issued ' + money(d.card.initial_cents) + ' — code: ' +
        '<span class="mono" style="font-size:1.2rem;letter-spacing:.08em;color:var(--brass-hi)">' +
        esc(d.card.code) + '</span></p>';
      $id('gc-issue-amt').value = '';
      refreshList();
      toast('Gift card issued', 'ok');
    } catch (e) { toast(e.message || 'Issue failed', 'err'); }
  });

  $id('gc-reload-btn').addEventListener('click', async () => {
    const code = $id('gc-reload-code').value.trim();
    const v = parseInt($id('gc-reload-amt').value, 10);
    if (!code || !v || v <= 0) { toast('Enter a code and amount', 'err'); return; }
    try {
      const d = await api('/api/gift-cards/reload', 'POST', { code, amount_cents: v });
      $id('gc-reload-result').innerHTML = '<p style="color:var(--green)">Reloaded — new balance ' +
        money(d.card.balance_cents) + '</p>';
      refreshList();
      toast('Card reloaded', 'ok');
    } catch (e) { toast(e.message || 'Reload failed', 'err'); }
  });

  refreshList();
}

if (typeof module !== 'undefined' && module.exports) module.exports = { renderGiftCards };
