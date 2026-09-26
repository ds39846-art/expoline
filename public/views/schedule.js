/* ============================================================================
 * Expoline scheduling view — weekly schedule with projected labor cost next
 * to sales projections, one glance per day.
 * Usage: renderSchedule(container, api). Exposed via window (IIFE).
 * ========================================================================== */
(function () {
'use strict';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function money(cents) { return '$' + ((Number(cents) || 0) / 100).toFixed(2); }
function hhmm(min) {
  const h = Math.floor(min / 60), m = min % 60;
  const ap = h >= 12 ? 'p' : 'a';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return h12 + ':' + String(m).padStart(2, '0') + ap;
}
function todayLocal() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function mondayOf(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  const dow = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - dow);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function addDaysStr(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() + n);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

async function renderSchedule(container, api) {
  container.innerHTML =
    '<div class="view-head"><h1>Schedule</h1><span class="spacer"></span>' +
    '<input id="sc-week" type="date" class="input" value="' + mondayOf(todayLocal()) + '">' +
    '<button id="sc-add" class="btn btn-primary">+ Shift</button></div>' +
    ((typeof mgrNav === 'function') ? mgrNav('schedule') : '') +
    '<div id="sc-body"><p class="muted">Loading…</p></div>';

  const body = container.querySelector('#sc-body');
  let employees = [];
  try { employees = await api('/api/admin/employees'); } catch (e) { /* optional */ }

  const weekVal = () => container.querySelector('#sc-week').value || mondayOf(todayLocal());

  container.querySelector('#sc-week').onchange = load;
  container.querySelector('#sc-add').onclick = () => shiftDialog(null);

  async function load() {
    const week = weekVal();
    let sched = null, proj = null;
    try {
      [sched, proj] = await Promise.all([
        api('/api/admin/schedule?week=' + week),
        api('/api/admin/schedule/projection?week=' + week),
      ]);
    } catch (e) { handleApiError(e); return; }
    const pDays = {};
    (proj.days || []).forEach((d) => { pDays[d.date] = d; });
    let html = '';
    for (let i = 0; i < 7; i++) {
      const date = addDaysStr(week, i);
      const p = pDays[date] || {};
      const dayShifts = (sched.shifts || []).filter((s) => s.work_date === date);
      const dLabel = new Date(date + 'T12:00:00').toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
      html += '<div class="card mt"><div class="row"><h3 style="margin:0">' + dLabel + '</h3><span class="spacer"></span>' +
        '<span class="muted small">Proj. sales ' + (p.projected_sales_cents != null ? '<b>' + money(p.projected_sales_cents) + '</b> (' + p.projected_sales_samples + ' wks)' : 'no history') + '</span>' +
        '<span class="muted small"> · Labor <b>' + money(p.scheduled_labor_cents || 0) + '</b>' +
        (p.projected_labor_pct != null ? ' · <b>' + p.projected_labor_pct + '%</b>' : '') + '</span></div>';
      html += dayShifts.length
        ? '<div class="t-scroll"><table class="t-table"><thead><tr><th>Who</th><th>Role</th><th>Time</th><th>Hours</th><th>Rate</th><th>Cost</th><th></th></tr></thead><tbody>' +
          dayShifts.map((s) => {
            const hrs = (s.end_min - s.start_min) / 60;
            return '<tr><td>' + esc(s.employee_name) + '</td><td>' + esc(s.role) + '</td><td>' +
              hhmm(s.start_min) + '–' + hhmm(s.end_min) + '</td><td>' + hrs.toFixed(1) + '</td><td>' +
              money(s.rate_cents) + '/hr</td><td>' + money(Math.round(hrs * s.rate_cents)) + '</td>' +
              '<td><button class="btn btn-sm" data-e="' + s.id + '">Edit</button> ' +
              '<button class="btn btn-sm btn-ghost" data-d="' + s.id + '">✕</button></td></tr>';
          }).join('') + '</tbody></table></div>'
        : '<p class="muted small">No shifts scheduled.</p>';
      html += '</div>';
    }
    body.innerHTML = html;
    body.querySelectorAll('[data-e]').forEach((b) => { b.onclick = () => shiftDialog((sched.shifts || []).find((s) => s.id === Number(b.dataset.e))); });
    body.querySelectorAll('[data-d]').forEach((b) => {
      b.onclick = () => confirmDialog('Delete shift?', 'This removes the scheduled shift.', 'Delete', async () => {
        try { await api('/api/admin/schedule/' + b.dataset.d, 'DELETE'); load(); } catch (e) { handleApiError(e); }
      });
    });
  }

  function shiftDialog(s) {
    const empOpts = (employees || []).filter((e) => e.active !== 0 || e.status !== 'inactive')
      .map((e) => '<option value="' + e.id + '"' + (s && s.user_id === e.id ? ' selected' : '') + '>' + esc(e.name) + ' (' + esc(e.role) + ')</option>').join('');
    const dlg =
      '<label class="muted small">Employee</label><select id="sh-user" class="input" style="width:100%">' + empOpts + '</select>' +
      '<label class="muted small">Or name</label><input id="sh-name" class="input" style="width:100%" value="' + esc(s ? s.employee_name : '') + '" placeholder="Name if not in list">' +
      '<div class="row"><div style="flex:1"><label class="muted small">Date</label><input id="sh-date" type="date" class="input" style="width:100%" value="' + esc(s ? s.work_date : weekVal()) + '"></div>' +
      '<div><label class="muted small">Role</label><select id="sh-role" class="input">' +
      ['server', 'kitchen', 'manager'].map((r) => '<option' + (s && s.role === r ? ' selected' : '') + '>' + r + '</option>').join('') + '</select></div></div>' +
      '<div class="row"><div style="flex:1"><label class="muted small">Start</label><input id="sh-start" type="time" class="input" style="width:100%" value="' + (s ? toTime(s.start_min) : '10:00') + '"></div>' +
      '<div style="flex:1"><label class="muted small">End</label><input id="sh-end" type="time" class="input" style="width:100%" value="' + (s ? toTime(s.end_min) : '18:00') + '"></div></div>' +
      '<label class="muted small">Rate $/hr (blank = employee wage)</label><input id="sh-rate" class="input" inputmode="decimal" style="width:100%" value="' + (s ? (s.rate_cents / 100).toFixed(2) : '') + '" placeholder="e.g. 22.50">';
    confirmDialog(s ? 'Edit shift' : 'Add shift', dlg, s ? 'Save' : 'Add shift', async () => {
      const q = (id) => document.querySelector('#' + id).value;
      const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
      const rateStr = q('sh-rate').trim();
      const payload = {
        work_date: q('sh-date'), role: q('sh-role'),
        start_min: toMin(q('sh-start')), end_min: toMin(q('sh-end')),
      };
      const uid = Number(q('sh-user'));
      if (uid) payload.user_id = uid;
      const nm = q('sh-name').trim();
      if (nm) payload.employee_name = nm;
      if (rateStr) payload.rate_cents = Math.round(Number(rateStr) * 100);
      try {
        if (s) await api('/api/admin/schedule/' + s.id, 'PUT', payload);
        else await api('/api/admin/schedule', 'POST', payload);
        toast('Saved', 'ok'); load();
      } catch (e) { handleApiError(e); }
    });
  }
  function toTime(min) {
    return String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0');
  }

  load();
}

if (typeof module !== 'undefined' && module.exports) module.exports = { renderSchedule };
else if (typeof window !== 'undefined') window.renderSchedule = renderSchedule;
})();
