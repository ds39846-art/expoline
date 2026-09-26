/* ============================================================================
 * Expoline reviews view (manager) — post-payment review summary.
 * The nudge itself lives in the pay flow (guest-optional, once per check,
 * dismissible, never blocks payment). This is the manager read-out.
 * Usage: renderReviews(container, api). Exposed via window (IIFE).
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
function stars(n) {
  let s = '';
  for (let i = 1; i <= 5; i++) s += i <= n ? '★' : '☆';
  return s;
}

async function renderReviews(container, api) {
  container.innerHTML =
    '<div class="view-head"><h1>Guest reviews</h1></div>' +
    ((typeof mgrNav === 'function') ? mgrNav('reviews') : '') +
    '<div id="rv-body"><p class="muted">Loading…</p></div>';

  const body = container.querySelector('#rv-body');

  async function load() {
    let r = null;
    try { r = await api('/api/reviews'); } catch (e) { handleApiError(e); return; }
    const max = Math.max(1, ...[1, 2, 3, 4, 5].map((k) => r.distribution[k] || 0));
    body.innerHTML =
      '<div class="stat-grid">' +
      '<div class="stat"><div class="k">Average</div><div class="v">' + (r.average != null ? r.average + ' ★' : '—') + '</div></div>' +
      '<div class="stat"><div class="k">Reviews</div><div class="v">' + r.count + '</div></div>' +
      '<div class="stat"><div class="k">Marketing opt-ins</div><div class="v">' + r.marketing_opt_ins + '</div></div>' +
      '</div>' +
      '<div class="card mt"><h3>Distribution</h3>' +
      [5, 4, 3, 2, 1].map((k) => {
        const c = r.distribution[k] || 0;
        const pct = Math.round(100 * c / max);
        return '<div class="row" style="align-items:center"><span style="width:4rem">' + k + ' ★</span>' +
          '<div style="flex:1;background:#eee;border-radius:4px;height:1rem"><div style="width:' + pct + '%;background:#c9a227;height:1rem;border-radius:4px"></div></div>' +
          '<span class="muted" style="width:3rem;text-align:right">' + c + '</span></div>';
      }).join('') + '</div>' +
      '<div class="card mt"><h3>Recent</h3>' +
      (r.reviews.length
        ? r.reviews.slice(0, 30).map((rv) =>
            '<div class="rv-row"><div><b>' + stars(rv.rating) + '</b> <span class="muted small">check #' + rv.check_id + ' · ' + fmtDT(rv.created_at) +
            (rv.marketing_opt_in ? ' · opted in' : '') + '</span>' +
            (rv.comment ? '<div>' + esc(rv.comment) + '</div>' : '') + '</div></div>').join('')
        : '<p class="muted">No reviews yet. They arrive from the post-payment nudge on the payment screen.</p>') + '</div>';
  }

  load();
}

/** Post-payment nudge — called from the pay view after a check is paid.
 *  Guest-optional: one dismissible card, once per check, never blocks. */
async function reviewNudge(mount, api, checkId) {
  let mountEl = typeof mount === 'string' ? document.querySelector(mount) : mount;
  if (!mountEl) return;
  const card = document.createElement('div');
  card.className = 'card mt';
  card.innerHTML =
    '<h3>How was your visit?</h3><p class="muted small">Optional — tap a star or dismiss. We read every one.</p>' +
    '<div class="row" id="rv-stars">' + [1, 2, 3, 4, 5].map((n) =>
      '<button class="btn btn-lg" data-star="' + n + '" style="font-size:1.8rem">☆</button>').join('') + '</div>' +
    '<div id="rv-form" style="display:none"><textarea id="rv-comment" class="input" style="width:100%;min-height:3rem" maxlength="500" placeholder="Anything we should know? (optional)"></textarea>' +
    '<label class="small"><input type="checkbox" id="rv-optin"> Email me about events &amp; specials</label>' +
    '<div class="row mt"><button id="rv-send" class="btn btn-primary">Send</button>' +
    '<button id="rv-no" class="btn btn-ghost">No thanks</button></div></div>' +
    '<div class="mt"><button id="rv-dismiss" class="btn btn-ghost btn-sm">Dismiss</button></div>';
  mountEl.appendChild(card);
  let rating = 0;
  const starBtns = card.querySelectorAll('[data-star]');
  starBtns.forEach((b) => {
    b.onclick = () => {
      rating = Number(b.dataset.star);
      starBtns.forEach((x) => { x.textContent = Number(x.dataset.star) <= rating ? '★' : '☆'; });
      card.querySelector('#rv-form').style.display = '';
      card.querySelector('#rv-dismiss').style.display = 'none';
    };
  });
  card.querySelector('#rv-dismiss').onclick = () => card.remove();
  card.querySelector('#rv-no').onclick = () => card.remove();
  card.querySelector('#rv-send').onclick = async () => {
    try {
      await api('/api/reviews', 'POST', {
        check_id: checkId, rating: rating,
        comment: card.querySelector('#rv-comment').value.trim(),
        marketing_opt_in: card.querySelector('#rv-optin').checked,
      });
      card.innerHTML = '<h3>Thank you! ★</h3><p class="muted small">Your feedback helps the whole team.</p>';
      setTimeout(() => card.remove(), 4000);
    } catch (e) { handleApiError(e); }
  };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { renderReviews, reviewNudge };
else if (typeof window !== 'undefined') { window.renderReviews = renderReviews; window.reviewNudge = reviewNudge; }
})();
