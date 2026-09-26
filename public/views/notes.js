/* ============================================================================
 * Expoline staff notes view (manager) — notes pushed to POS login.
 * 86s, specials, and reservations surface automatically via
 * GET /api/login-summary; this view authors the notes themselves.
 * Usage: renderStaffNotes(container, api). Exposed via window (IIFE).
 * ========================================================================== */
(function () {
'use strict';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function fmtDT(iso) {
  try { return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }
  catch (e) { return ''; }
}

async function renderStaffNotes(container, api) {
  container.innerHTML =
    '<div class="view-head"><h1>Staff notes</h1><span class="spacer"></span>' +
    '<button id="sn-add" class="btn btn-primary">+ Note</button></div>' +
    ((typeof mgrNav === 'function') ? mgrNav('notes') : '') +
    '<p class="muted small">Active notes appear on every staff login — no pre-shift meeting required.</p>' +
    '<div id="sn-body"><p class="muted">Loading…</p></div>';

  const body = container.querySelector('#sn-body');
  container.querySelector('#sn-add').onclick = () => noteDialog(null);

  async function load() {
    let rows = [];
    try { rows = await api('/api/admin/notes'); } catch (e) { handleApiError(e); return; }
    const now = Date.now();
    body.innerHTML = rows.length
      ? '<div class="t-scroll"><table class="t-table"><thead><tr><th>Priority</th><th>Title</th><th>Active window</th><th>By</th><th></th></tr></thead><tbody>' +
        rows.map((n) => {
          const active = (!n.active_from || Date.parse(n.active_from) <= now) && (!n.active_to || Date.parse(n.active_to) >= now);
          return '<tr><td><span class="pill ' + n.priority + '">' + n.priority + '</span></td>' +
            '<td><b>' + esc(n.title) + '</b><div class="muted small">' + esc((n.body || '').slice(0, 120)) + '</div></td>' +
            '<td class="small">' + (n.active_from ? fmtDT(n.active_from) : 'now') + ' → ' + (n.active_to ? fmtDT(n.active_to) : 'until deleted') +
            (active ? '' : ' <span class="muted">(inactive)</span>') + '</td>' +
            '<td class="muted small">' + esc(n.created_by || '') + '</td>' +
            '<td><button class="btn btn-sm" data-e="' + n.id + '">Edit</button> ' +
            '<button class="btn btn-sm btn-ghost" data-d="' + n.id + '">✕</button></td></tr>';
        }).join('') + '</tbody></table></div>'
      : '<div class="card"><p class="muted">No notes yet. Add one — e.g. tonight\u2019s special or a reservation heads-up.</p></div>';
    body.querySelectorAll('[data-e]').forEach((b) => { b.onclick = () => noteDialog(rows.find((n) => n.id === Number(b.dataset.e))); });
    body.querySelectorAll('[data-d]').forEach((b) => {
      b.onclick = () => confirmDialog('Delete note?', 'Staff will stop seeing it at login.', 'Delete', async () => {
        try { await api('/api/admin/notes/' + b.dataset.d, 'DELETE'); load(); } catch (e) { handleApiError(e); }
      });
    });
  }

  function noteDialog(n) {
    const toLocal = (iso) => {
      if (!iso) return '';
      const d = new Date(iso);
      const p = (x) => String(x).padStart(2, '0');
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
    };
    const dlg =
      '<label class="muted small">Title</label><input id="nt-title" class="input" style="width:100%" value="' + esc(n ? n.title : '') + '" placeholder="e.g. Tonight: ahi special $28">' +
      '<label class="muted small">Body</label><textarea id="nt-body" class="input" style="width:100%;min-height:4rem">' + esc(n ? (n.body || '') : '') + '</textarea>' +
      '<div class="row"><div style="flex:1"><label class="muted small">Priority</label><select id="nt-prio" class="input" style="width:100%">' +
      ['high', 'normal', 'low'].map((p) => '<option' + (n && n.priority === p ? ' selected' : (!n && p === 'normal' ? ' selected' : '')) + '>' + p + '</option>').join('') + '</select></div>' +
      '<div style="flex:1"><label class="muted small">Show from</label><input id="nt-from" type="datetime-local" class="input" style="width:100%" value="' + toLocal(n && n.active_from) + '"></div>' +
      '<div style="flex:1"><label class="muted small">Until</label><input id="nt-to" type="datetime-local" class="input" style="width:100%" value="' + toLocal(n && n.active_to) + '"></div></div>';
    confirmDialog(n ? 'Edit note' : 'New note', dlg, n ? 'Save' : 'Add note', async () => {
      const q = (id) => document.querySelector('#' + id).value;
      const toIso = (v) => v ? new Date(v).toISOString() : null;
      const payload = {
        title: q('nt-title').trim(), body: q('nt-body').trim(), priority: q('nt-prio'),
        active_from: toIso(q('nt-from')), active_to: toIso(q('nt-to')),
      };
      if (!payload.title) { toast('Title is required', 'err'); return; }
      try {
        if (n) await api('/api/admin/notes/' + n.id, 'PUT', payload);
        else await api('/api/admin/notes', 'POST', payload);
        toast('Saved', 'ok'); load();
      } catch (e) { handleApiError(e); }
    });
  }

  load();
}

if (typeof module !== 'undefined' && module.exports) module.exports = { renderStaffNotes };
else if (typeof window !== 'undefined') window.renderStaffNotes = renderStaffNotes;
})();
