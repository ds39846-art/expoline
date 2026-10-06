/* ============================================================
   Expoline MVP v0.1 — Harbor Luxe POS (vanilla JS, no build)
   Views: login, floor, order, kds, pay, manager (+finance/shift/menu)
   Offline: IndexedDB outbox queue (see "OFFLINE OUTBOX" section)
   ============================================================ */
'use strict';

/* ---------------- utils ---------------- */
const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const fmt = (cents) => '$' + ((Number(cents) || 0) / 100).toFixed(2);
const pad2 = (n) => String(n).padStart(2, '0');
const fmtClock = (ts) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const fmtDate = (ts) => new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
const fmtDateTime = (ts) => new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const todayISO = () => { const d = new Date(); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); };
// Site-timezone business date (America/Los_Angeles for the Bali Hai pilot),
// so date pickers default to the restaurant's sales date, not the device date.
async function siteDate() {
  try {
    const c = await getConfig();
    const d = c.site_date;
    if (/^\d{4}-\d{2}-\d{2}$/.test(d || '')) return d;
  } catch (e) {}
  return todayISO();
}
const uid = (p) => (p || 'id') + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

/* ---------------- app state ---------------- */
const state = {
  user: null,          // {id,name,role}
  route: null,
  kds: { station: 'expediter', tickets: [], ws: null, wsUp: false, recall: false, retryMs: 1000 },
  timers: { kds: null },
  reviewNudged: {},    // checkId -> true (post-payment nudge shown once per check)
  reviewPrompt: true,   // from /api/login-summary (manager can disable site-wide)
};

/** Phase 3C — staff notes pushed at POS login: 86s, specials (notes), and
 *  today's reservations surface in one dismissible modal. Silent when empty. */
async function showLoginSummary() {
  let s = null;
  try { s = await api('/api/login-summary'); } catch (e) { return; }
  state.reviewPrompt = !!s.review_prompt;
  const hasNotes = (s.notes || []).length > 0;
  const has86 = (s.eighty_six || []).length > 0;
  const hasResv = (s.reservations_today || {}).count > 0;
  const hasWl = (s.waitlist_waiting || 0) > 0;
  if (!hasNotes && !has86 && !hasResv && !hasWl) return;
  const bd = openModal('<h2>Shift notes</h2>' +
    (hasNotes ? '<h3>Notes</h3>' + s.notes.map((n) =>
      '<div class="note-row"><span class="pill ' + esc(n.priority) + '">' + esc(n.priority) + '</span> <b>' + esc(n.title) + '</b>' +
      (n.body ? '<div class="muted small">' + esc(n.body) + '</div>' : '') + '</div>').join('') : '') +
    (has86 ? '<h3>86\u2019d right now</h3><p>' + s.eighty_six.map((x) => '<span class="pill low">' + esc(x) + '</span>').join(' ') + '</p>' : '') +
    (hasResv ? '<h3>Reservations today (' + s.reservations_today.count + ')</h3>' +
      (s.reservations_today.upcoming || []).map((r) =>
        '<div class="small">' + esc(r.customer_name) + ' · party of ' + r.party_size + ' · ' +
        new Date(r.reserved_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) + '</div>').join('') : '') +
    (hasWl ? '<h3>Waitlist</h3><p class="small">' + s.waitlist_waiting + ' parties waiting</p>' : '') +
    '<div class="modal-actions"><button class="btn btn-primary" data-x="go">Got it</button></div>');
  bd.querySelector('[data-x="go"]').onclick = closeModal;
}

const API = location.origin; // same origin, port 4317

/* ---------------- auth ---------------- */
function saveSession(token, user) {
  sessionStorage.setItem('expoline.token', token);
  sessionStorage.setItem('expoline.user', JSON.stringify(user));
  state.user = user;
}
function loadSession() {
  try {
    const u = sessionStorage.getItem('expoline.user');
    if (u && sessionStorage.getItem('expoline.token')) state.user = JSON.parse(u);
  } catch (e) { /* ignore */ }
}
function clearSession() {
  sessionStorage.removeItem('expoline.token');
  sessionStorage.removeItem('expoline.user');
  state.user = null;
}
function logout() {
  clearSession();
  closeKdsSocket();
  location.hash = '#/login';
}

/* ---------------- api client ---------------- */
class OfflineError extends Error { constructor(m) { super(m || 'offline'); this.offline = true; } }
class ApiError extends Error { constructor(status, msg, body) { super(msg || ('HTTP ' + status)); this.status = status; if (body !== undefined) this.body = body; } }

const isOffline = () => localStorage.getItem('expoline.forceOffline') === '1' || !navigator.onLine;

async function rawApi(path, method, body) {
  const headers = { 'Content-Type': 'application/json' };
  const tok = sessionStorage.getItem('expoline.token');
  if (tok) headers['Authorization'] = 'Bearer ' + tok;
  let res;
  try {
    res = await fetch(API + path, { method: method || 'GET', headers, body: body ? JSON.stringify(body) : undefined });
  } catch (e) {
    throw new OfflineError('network unreachable');
  }
  if (!res.ok) {
    let msg = 'Request failed (' + res.status + ')', body;
    try { body = await res.json(); msg = body.error || body.message || msg; } catch (e) { /* ignore */ }
    throw new ApiError(res.status, msg, body);
  }
  if (res.status === 204) return null;
  const ct = res.headers.get('content-type') || '';
  return ct.includes('json') ? res.json() : res.text();
}

/* api(): same as rawApi, but when offline serves GETs from localStorage cache
   and refuses mutations with OfflineError (callers queue them via Outbox). */
async function api(path, method, body) {
  method = method || 'GET';
  if (isOffline()) {
    if (method === 'GET') {
      const c = localStorage.getItem('expoline.cache:' + path);
      if (c) return JSON.parse(c);
      throw new OfflineError('offline with no cached copy of ' + path);
    }
    throw new OfflineError('offline — mutation must be queued');
  }
  const data = await rawApi(path, method, body);
  if (method === 'GET' && data !== undefined) {
    try { localStorage.setItem('expoline.cache:' + path, JSON.stringify(data)); } catch (e) { /* quota */ }
  }
  return data;
}

/* Global API error policy: 401/403 -> bounce to login (locked rule). */
function handleApiError(e, opts) {
  opts = opts || {};
  if (e instanceof OfflineError) { toast('You are offline — reconnect to continue', 'err'); return 'offline'; }
  if (e instanceof ApiError && (e.status === 401 || e.status === 403) && !opts.keep) {
    toast('Session ended — please log in', 'err');
    logout();
    return 'bounced';
  }
  toast(e.message || 'Something went wrong', 'err');
  return 'error';
}

/* ============================================================
   OFFLINE OUTBOX (IndexedDB)
   Mutations made while offline are stored here in order and
   flushed oldest-first on reconnect (see flushOutbox below).
   Ops: open_check, add_items, void_item, send, payment, close.
   Temp ids ("tmp-…") are remapped to real server ids during
   flush via the expoline.idmap table (see loadIdMap/saveIdMap).
   ============================================================ */
const Outbox = {
  db: null,
  mem: [], // fallback if IndexedDB is unavailable
  useMem: false,

  open() {
    return new Promise((resolve) => {
      if (!('indexedDB' in window)) { Outbox.useMem = true; resolve(); return; }
      let req;
      try { req = indexedDB.open('expoline', 1); }
      catch (e) { Outbox.useMem = true; resolve(); return; }
      req.onupgradeneeded = () => { req.result.createObjectStore('outbox', { keyPath: 'key', autoIncrement: true }); };
      req.onsuccess = () => { Outbox.db = req.result; resolve(); };
      req.onerror = () => { Outbox.useMem = true; resolve(); };
    });
  },

  enqueue(op, payload) {
    /* LAN SYNC (phase 2): op envelope identity (DESIGN.md §2). The brain
       uses op_id for idempotency and (lamport, seq) for causal order across
       devices. Harmless extra fields on the legacy flush path. */
    const entry = { ts: Date.now(), op, payload,
      op_id: (crypto.randomUUID ? crypto.randomUUID() : 'op-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10)),
      device_id: lanDeviceId(), seq: lanNextSeq(), lamport: lanNextLamport() };
    const done = () => { updateOfflineBanner(); return entry; };
    if (Outbox.useMem) { entry.key = 'm' + Outbox.mem.length + '-' + Date.now(); Outbox.mem.push(entry); return Promise.resolve(done()); }
    return new Promise((resolve, reject) => {
      const tx = Outbox.db.transaction('outbox', 'readwrite');
      const r = tx.objectStore('outbox').add(entry);
      r.onsuccess = () => { entry.key = r.result; resolve(done()); };
      r.onerror = () => reject(r.error);
    });
  },

  all() {
    if (Outbox.useMem) return Promise.resolve(Outbox.mem.slice().sort((a, b) => a.ts - b.ts));
    return new Promise((resolve, reject) => {
      const r = Outbox.db.transaction('outbox', 'readonly').objectStore('outbox').getAll();
      r.onsuccess = () => resolve((r.result || []).sort((a, b) => a.ts - b.ts));
      r.onerror = () => reject(r.error);
    });
  },

  forCheck(checkId) {
    return Outbox.all().then((ops) => ops.filter((o) => {
      const p = o.payload || {};
      return String(p.check_id) === String(checkId) || String(p.temp_id) === String(checkId);
    }));
  },

  remove(key) {
    if (Outbox.useMem) { Outbox.mem = Outbox.mem.filter((e) => e.key !== key); updateOfflineBanner(); return Promise.resolve(); }
    return new Promise((resolve, reject) => {
      const tx = Outbox.db.transaction('outbox', 'readwrite');
      const r = tx.objectStore('outbox').delete(key);
      r.onsuccess = () => { updateOfflineBanner(); resolve(); };
      r.onerror = () => reject(r.error);
    });
  },

  /* rewrite an existing entry (used to absorb a void into a pending add_items op) */
  update(entry) {
    if (Outbox.useMem) {
      const i = Outbox.mem.findIndex((e) => e.key === entry.key);
      if (i >= 0) Outbox.mem[i] = entry;
      updateOfflineBanner();
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const tx = Outbox.db.transaction('outbox', 'readwrite');
      const r = tx.objectStore('outbox').put(entry);
      r.onsuccess = () => { updateOfflineBanner(); resolve(); };
      r.onerror = () => reject(r.error);
    });
  },

  count() { return Outbox.all().then((ops) => ops.length); },
};

/* ============================================================
   LAN SYNC (phase 2) — device identity + logical clock for op envelopes.
   device_id is stable per browser profile (localStorage); seq is a
   per-device monotonic counter; lamport is a Lamport clock ticked on every
   local mutation. The brain merges remote clocks on receipt, so ops sort
   causally across devices with no wall-clock dependence (DESIGN.md §4).
   ============================================================ */
function lanDeviceId() {
  try {
    let id = localStorage.getItem('expoline.device_id');
    if (!id) {
      id = 'web-' + (crypto.randomUUID ? crypto.randomUUID().slice(0, 8) : Date.now().toString(36));
      localStorage.setItem('expoline.device_id', id);
    }
    return id;
  } catch (e) { return 'web-unknown'; }
}
function lanNextSeq() {
  try {
    const n = (parseInt(localStorage.getItem('expoline.sync.seq') || '0', 10) || 0) + 1;
    localStorage.setItem('expoline.sync.seq', String(n));
    return n;
  } catch (e) { return Date.now(); }
}
function lanNextLamport() {
  try {
    const n = (parseInt(localStorage.getItem('expoline.sync.lamport') || '0', 10) || 0) + 1;
    localStorage.setItem('expoline.sync.lamport', String(n));
    return n;
  } catch (e) { return Date.now(); }
}
/* Merge a remote clock reading (e.g. from a sync-batch response). */
function lanMergeClock(remote) {
  try {
    const cur = parseInt(localStorage.getItem('expoline.sync.lamport') || '0', 10) || 0;
    if ((remote | 0) > cur) localStorage.setItem('expoline.sync.lamport', String(remote | 0));
  } catch (e) { /* ignore */ }
}

/* Build the wire envelope for one queued op (DESIGN.md §2). Temp ids are
   sent as-is: the client's temp id BECOMES the permanent uuid on the brain
   (DESIGN.md §7), so the op is referenceable before it ever reaches a server. */
function lanEnvelope(o, siteSlug) {
  const p = Object.assign({}, o.payload);
  const checkUuid = String(p.check_id != null ? p.check_id : (p.temp_id != null ? p.temp_id : ''));
  const payload = {};
  switch (o.op) {
    case 'open_check':
      payload.check_uuid = String(p.temp_id || p.check_id || '');
      payload.table_id = p.table_id; payload.guest_count = p.guest_count; payload.tab_name = p.tab_name;
      break;
    case 'add_items':
      payload.check_uuid = checkUuid;
      payload.items = (p.items || []).map((it) => {
        const item = { item_uuid: String(it.temp_id || ''), menu_item_id: it.menu_item_id,
          seat: it.seat, qty: it.qty, modifiers: it.modifiers || [] };
        /* Same field fidelity as the legacy flush: the ring-time
           note, allergy flag and detail, and course ride the envelope
           when the queued line carries them. Absent stays absent —
           the store then applies the menu default course, while an
           explicit null course still means no course. */
        if (it.note !== undefined) item.note = it.note || null;
        if (it.allergy !== undefined) item.allergy = !!it.allergy;
        if (it.allergy_detail !== undefined) item.allergy_detail = it.allergy_detail || null;
        if (it.course !== undefined) item.course = it.course;
        return item;
      });
      break;
    case 'void_item':
      payload.check_uuid = checkUuid;
      payload.item_uuid = String(p.item_id);
      payload.reason = p.reason;
      if (p.approval_nonce) { payload.approval_nonce = p.approval_nonce; payload.manager_pin_hash = p.manager_pin_hash; }
      else payload.manager_pin = p.manager_pin;
      break;
    case 'send':
      payload.check_uuid = checkUuid;
      break;
    case 'payment':
      payload.check_uuid = checkUuid;
      payload.payment_uuid = p.payment_uuid || ('pay-' + (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36)));
      payload.method = p.method; payload.amount_cents = p.amount_cents;
      payload.tip_cents = p.tip_cents || 0; payload.tendered_cents = p.tendered_cents;
      payload.brand = p.brand; payload.last4 = p.last4;
      break;
    case 'close':
      payload.check_uuid = checkUuid;
      break;
    default:
      Object.assign(payload, p);
  }
  return {
    op_id: o.op_id, site_slug: siteSlug, device_id: o.device_id,
    actor_id: (typeof state !== 'undefined' && state.user) ? state.user.id : null,
    seq: o.seq, lamport: o.lamport, op: o.op, payload,
    created_at: new Date(o.ts || Date.now()).toISOString(),
  };
}

/* Apply one sync-batch result: temp-id → real-id remaps and draft cleanup.
   Mirrors what the legacy flush does per endpoint. */
async function lanApplyResult(r, entry, idmap) {
  const p = entry.payload || {};
  if (r.op === 'open_check' || (entry.op === 'open_check')) {
    const tempId = r.temp_id || p.temp_id || p.check_id;
    if (tempId && r.check_id) idmap[tempId] = r.check_id;
    localStorage.removeItem('expoline.draft:' + tempId);
    localStorage.removeItem('expoline.staged:' + tempId);
  } else if (entry.op === 'add_items') {
    const uuids = r.item_uuids || [];
    const ids = r.item_ids || [];
    for (let i = 0; i < uuids.length; i++) if (uuids[i] && ids[i]) idmap[uuids[i]] = ids[i];
  }
  saveIdMap(idmap);
}

/* Flush the outbox through POST /api/sync/batch (idempotent, causal order).
   Chunked (200 ops) to stay under server batch limits. Stops at the first
   failed op so order is preserved; the rest retry on the next reconnect. */
async function flushOutboxBatch(ops) {
  const cfg = await getConfig().catch(() => ({}));
  const siteSlug = cfg.site_slug || 'bali-hai';
  const idmap = loadIdMap();
  let done = 0, failed = false;
  const CHUNK = 200;
  for (let i = 0; i < ops.length && !failed; i += CHUNK) {
    const chunk = ops.slice(i, i + CHUNK);
    let res;
    try {
      res = await rawApi('/api/sync/batch', 'POST', { ops: chunk.map((o) => lanEnvelope(o, siteSlug)) });
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) handleApiError(e);
      failed = true; // transport/auth failure: keep everything queued
      break;
    }
    if (!res || res.ok === false) { failed = true; break; } // e.g. site_mismatch: keep queued, surface loudly
    if (res.lamport) lanMergeClock(res.lamport);
    for (const r of (res.results || [])) {
      const entry = chunk.find((o) => o.op_id === r.op_id);
      if (!entry) continue;
      if (r.ok) {
        await lanApplyResult(r, entry, idmap);
        await Outbox.remove(entry.key);
        done++;
      } else {
        failed = true; // stop at first failure to preserve causal order
        if (r.error && r.error !== 'check_not_open') toast('Sync: ' + r.error, 'err');
        break;
      }
    }
  }
  saveIdMap(idmap);
  if (done > 0 && !failed) {
    showSyncedBanner(done);
    const m = location.hash.match(/^#\/order\/(tmp-[^/]+)/);
    if (m && idmap[m[1]]) location.hash = '#/order/' + idmap[m[1]];
    else if (state.route && state.route.view === 'order') renderRoute(true);
    else if (state.route && state.route.view === 'floor') renderRoute(true);
  } else if (done > 0) {
    toast('Synced ' + done + ' — ' + (ops.length - done) + ' still queued', 'ok');
  }
  updateOfflineBanner();
  return done;
}

/* temp-id -> real-id map, persisted so a flush can resume across reloads */
function loadIdMap() { try { return JSON.parse(localStorage.getItem('expoline.idmap') || '{}'); } catch (e) { return {}; } }
function saveIdMap(m) { try { localStorage.setItem('expoline.idmap', JSON.stringify(m)); } catch (e) { /* ignore */ } }
function realId(id) { const m = loadIdMap(); return m[id] || id; }

/* sha256 hex via WebCrypto (available on localhost + https). Used for
   offline manager approvals: the queued void stores sha256(PIN) + a random
   one-time nonce — never the raw PIN — so a stolen queue can't be replayed
   or forged. The server binds the nonce to (check, item) on first use. */
async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(s)));
  return Array.from(new Uint8Array(buf)).map((x) => x.toString(16).padStart(2, '0')).join('');
}
function randomNonce() {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return Array.from(a).map((x) => x.toString(16).padStart(2, '0')).join('');
}

/* Flush the outbox oldest-first. Stops at the first failure so order is
   preserved; remaining ops retry on the next reconnect.
   LAN SYNC (phase 2): when the server advertises lan_sync in /api/config,
   the outbox flushes as op envelopes through POST /api/sync/batch
   (idempotent, causal order, temp-ids become uuids). Otherwise the legacy
   per-endpoint flush runs untouched. */
let flushing = false;
async function flushOutbox() {
  if (flushing || isOffline()) return 0;
  const ops = await Outbox.all();
  if (!ops.length) return 0;
  flushing = true;
  try {
    const cfg = await getConfig().catch(() => ({}));
    if (cfg.lan_sync) return await flushOutboxBatch(ops);
    return await flushOutboxLegacy(ops);
  } finally { flushing = false; }
}

async function flushOutboxLegacy(ops) {
  const idmap = loadIdMap();
  let done = 0, failed = false;
  {
    for (const o of ops) {
      const p = Object.assign({}, o.payload);
      try {
        if (o.op === 'open_check') {
          const r = await rawApi('/api/checks', 'POST', { table_id: p.table_id, guest_count: p.guest_count, tab_name: p.tab_name });
          const rid = (r && (r.id || (r.check && r.check.id))) || null;
          if (!rid) throw new Error('open_check returned no id');
          idmap[p.temp_id] = rid; saveIdMap(idmap);
          localStorage.removeItem('expoline.draft:' + p.temp_id);
          localStorage.removeItem('expoline.staged:' + p.temp_id);
        } else {
          const cid = idmap[p.check_id] || p.check_id;
          if (o.op === 'add_items') {
            for (const it of (p.items || [])) {
              const postBody = { menu_item_id: it.menu_item_id, seat: it.seat, qty: it.qty, modifiers: it.modifiers || [] };
              /* Field fidelity: the queued line also carries the
                 ring-time note, allergy flag and detail, and course
                 (the HOLD handler enqueues all four and POST /items
                 stores all four). The old body dropped them, so an
                 offline-held line reached the kitchen with no special
                 request, no allergy warning, and the menu default
                 course instead of the picked one. Values are
                 normalized exactly like the online HOLD body; a field
                 the queued line does not carry stays absent, so
                 pre-field queue entries post byte-identically to
                 before — most importantly course, where absent means
                 menu default and null means no course at all. */
              if (it.note !== undefined) postBody.note = it.note || null;
              if (it.allergy !== undefined) postBody.allergy = !!it.allergy;
              if (it.allergy_detail !== undefined) postBody.allergy_detail = it.allergy_detail || null;
              if (it.course !== undefined) postBody.course = it.course;
              /* Per-line idempotency: the key derives from the line
                 temp_id, which is persisted inside the queue entry
                 itself, so the key is identical on every retry and
                 across app restarts. The server stores the first
                 response under the key and replays it on a retry
                 instead of inserting the line a second time — the old
                 shape re-posted the whole op after a mid-op failure
                 (its id mappings were only saved at the end), which
                 duplicated every line that had already landed. Lines
                 queued before keys existed carry no temp_id and post
                 exactly as before. */
              if (it.temp_id) postBody.idempotency_key = 'outbox-item-' + it.temp_id;
              let r;
              try {
                r = await rawApi('/api/checks/' + cid + '/items', 'POST', postBody);
              } catch (ie) {
                /* Name the queued line the server rejected before the
                   flush stops on it — the old shape stopped silently, so
                   the failure surfaced nowhere and the server never
                   learned which line never reached the check. */
                if (ie instanceof ApiError && ie.status === 400) {
                  toast((it.name || 'A queued item') + (it.seat ? ' (Seat ' + it.seat + ')' : '') + ' needs attention: ' + (ie.message || 'sync failed'), 'err');
                }
                throw ie;
              }
              const iid = r && (r.id || (r.item && r.item.id));
              if (it.temp_id && iid) { idmap[it.temp_id] = iid; }
            }
            saveIdMap(idmap);
          } else if (o.op === 'void_item') {
            const iid = idmap[p.item_id] || p.item_id;
            // Offline approvals travel as PIN hash + one-time nonce (never the
            // raw PIN); ops queued before this change still carry manager_pin.
            const vbody = { item_id: Number(iid) || iid, reason: p.reason };
            if (p.approval_nonce) { vbody.manager_pin_hash = p.manager_pin_hash; vbody.approval_nonce = p.approval_nonce; }
            else vbody.manager_pin = p.manager_pin;
            try {
              await rawApi('/api/checks/' + cid + '/void-item', 'POST', vbody);
            } catch (ve) {
              // Approval failure (bad/expired PIN) is not a session problem —
              // keep the op queued and tell the user instead of bouncing to login.
              if (ve instanceof ApiError && ve.status === 403) {
                toast('A queued void needs a valid manager PIN — re-void it from the check', 'err');
                failed = true; break;
              }
              throw ve;
            }
          } else if (o.op === 'send') {
            await rawApi('/api/checks/' + cid + '/send', 'POST');
          } else if (o.op === 'payment') {
            await rawApi('/api/checks/' + cid + '/payments', 'POST',
              { method: p.method, amount_cents: p.amount_cents, tip_cents: p.tip_cents || 0, tendered_cents: p.tendered_cents, brand: p.brand, last4: p.last4 });
          } else if (o.op === 'close') {
            await rawApi('/api/checks/' + cid + '/close', 'POST');
          }
        }
        await Outbox.remove(o.key);
        done++;
      } catch (e) {
        if (e instanceof ApiError && (e.status === 401 || e.status === 403)) { handleApiError(e); failed = true; break; }
        failed = true; // keep order: stop, retry later
        break;
      }
    }
  }

  if (done > 0 && !failed) {
    showSyncedBanner(done);
    // if we were viewing a temp check that now has a real id, jump to it
    const m = location.hash.match(/^#\/order\/(tmp-[^/]+)/);
    if (m && idmap[m[1]]) location.hash = '#/order/' + idmap[m[1]];
    else if (state.route && state.route.view === 'order') renderRoute(true);
    else if (state.route && state.route.view === 'floor') renderRoute(true);
  } else if (done > 0) {
    toast('Synced ' + done + ' — ' + (ops.length - done) + ' still queued', 'ok');
  }
  updateOfflineBanner();
  return done;
}

/* ---------------- toast / modal / banner ---------------- */
function toast(msg, kind) {
  const root = $('#toast-root');
  const el = document.createElement('div');
  el.className = 'toast' + (kind ? ' ' + kind : '');
  el.textContent = msg;
  root.appendChild(el);
  /* Errors carry the one fact the server must act on (which line, what
     is wrong), so they stay up long enough to actually read: scaled by
     message length, floored at 6s and capped at 12s. Success and info
     toasts keep the standard beat. */
  const holdMs = kind === 'err'
    ? Math.max(6000, Math.min(12000, 3400 + String(msg).length * 45))
    : 3400;
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .4s'; setTimeout(() => el.remove(), 450); }, holdMs);
}

function openModal(html) {
  closeModal();
  const bd = document.createElement('div');
  bd.className = 'modal-backdrop';
  bd.innerHTML = '<div class="modal" role="dialog" aria-modal="true">' + html + '</div>';
  bd.addEventListener('click', (e) => { if (e.target === bd) closeModal(); });
  $('#modal-root').appendChild(bd);
  const first = bd.querySelector('input, select, button');
  if (first) setTimeout(() => { try { first.focus({ preventScroll: true }); } catch (e) {} }, 60);
  return bd;
}
function closeModal() { $('#modal-root').innerHTML = ''; }
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

function confirmDialog(title, body, okLabel, onOk) {
  const bd = openModal(
    '<h2>' + esc(title) + '</h2><p class="muted">' + esc(body) + '</p>' +
    '<div class="modal-actions"><button class="btn btn-ghost" data-x="cancel">Cancel</button>' +
    '<button class="btn btn-danger" data-x="ok">' + esc(okLabel || 'Confirm') + '</button></div>');
  $('[data-x="cancel"]', bd).onclick = closeModal;
  $('[data-x="ok"]', bd).onclick = async () => { closeModal(); await onOk(); };
}

async function updateOfflineBanner() {
  const b = $('#offline-banner');
  if (!isOffline()) { b.classList.add('hidden'); return; }
  const n = await Outbox.count().catch(() => 0);
  b.classList.remove('hidden', 'synced');
  b.textContent = 'OFFLINE — ' + n + (n === 1 ? ' order' : ' orders') + ' queued';
}
function showSyncedBanner(n) {
  const b = $('#offline-banner');
  b.classList.remove('hidden');
  b.classList.add('synced');
  b.textContent = 'Synced ' + n + (n === 1 ? ' order' : ' orders') + ' ✓';
  setTimeout(() => { if (!isOffline()) b.classList.add('hidden'); }, 4000);
  updateOfflineBannerSoon();
}
const updateOfflineBannerSoon = debounce(updateOfflineBanner, 300);

/* ---------------- header / nav ---------------- */
function renderHeader() {
  const h = $('#app-header');
  if (!state.user) { h.classList.add('hidden'); return; }
  h.classList.remove('hidden');
  const role = state.user.role;
  const links = [];
  if (role === 'server' || role === 'manager') links.push(['#/floor', 'Floor']);
  if (role === 'server' || role === 'manager') links.push(['#/reservations', 'Reservations']);
  if (role === 'server' || role === 'manager') links.push(['#/waitlist', 'Waitlist']);
  if (role === 'server' || role === 'manager') links.push(['#/giftcards', 'Gift Cards']);
  if (role === 'server' || role === 'manager') links.push(['#/loyalty', 'Loyalty']);
  if (role === 'kitchen' || role === 'manager') links.push(['#/kds', 'KDS']);
  if (role === 'manager') links.push(['#/manager', 'Manager']);
  links.push(['#/clock', 'Clock']);
  const cur = location.hash.split('?')[0];
  $('#main-nav').innerHTML = links.map(([href, label]) =>
    '<a href="' + href + '" class="' + (cur === href || (href !== '#/floor' && cur.startsWith(href + '/')) ? 'active' : '') + '">' + esc(label) + '</a>').join('');
  $('#user-chip').innerHTML = '<b>' + esc(state.user.name) + '</b> · ' + esc(role);
  const t = $('#force-offline');
  t.checked = localStorage.getItem('expoline.forceOffline') === '1';
  t.onchange = async () => {
    localStorage.setItem('expoline.forceOffline', t.checked ? '1' : '0');
    await updateOfflineBanner();
    if (!t.checked && !isOffline()) { const n = await flushOutbox(); if (n === 0) toast('Back online', 'ok'); }
    else if (t.checked) toast('Offline demo mode ON — actions will queue', 'err');
  };
  $('#logout-btn').onclick = logout;
}

/* ============================================================
   DATA HELPERS — menu / zones / config caching, check view-model
   ============================================================ */
async function getMenu() {
  const raw = await api('/api/menu');
  const cats = raw.categories || raw.menu || (Array.isArray(raw) ? raw : []);
  return cats.map((c) => ({
    id: c.id || c.name, name: c.name || 'Menu',
    items: (c.items || []).map((i) => ({
      id: i.id, name: i.name || 'Item',
      price_cents: i.price_cents != null ? i.price_cents : Math.round((Number(i.price) || 0) * 100),
      is_drink: i.is_drink, tags: i.tags || [],
      modifiers: i.modifiers || i.modifier_options || [],
      /* Modifier GROUPS (Temperature, Flavor, …) must ride through: the
         server sends them on every item, and addItemFlow reads
         item.modifier_groups to render required pickers. This mapping
         used to drop the field, so grouped items staged instantly with
         no picker and the server then rejected the line at HOLD for a
         missing required selection the server could never make. */
      modifier_groups: i.modifier_groups || [],
      /* Same pass-through rule for the manager-set popular flag: the
         quick-pick row reads i.popular from these mapped items. */
      popular: !!i.popular,
      /* And for the item default course: the addItemFlow course picker
         and stageItem read item.course. This mapping used to drop it,
         so a line course could never be picked at ring time — the
         server silently substituted the menu default at HOLD. */
      course: i.course || null,
      station: i.station || i.kds_station || null,
      daypart: i.daypart || null,
    })),
  }));
}
async function getZones() {
  const raw = await api('/api/zones');
  const zones = raw.zones || (Array.isArray(raw) ? raw : []);
  return zones.map((z) => ({
    id: z.id || z.name, name: z.name || 'Zone',
    tables: (z.tables || []).map((t) => ({
      id: t.id, label: t.label || t.name || t.number || String(t.id),
      open_check_id: t.open_check_id || t.check_id || null,
      seats: t.seats || t.capacity || null,
    })),
  }));
}
async function getConfig() {
  try {
    const raw = await api('/api/config');
    return raw.config || raw || {};
  } catch (e) { return {}; }
}

/* Drinks are visually tagged. Detection: explicit item flag first,
   then tags, then category-name heuristic (contract has no drink flag). */
function isDrink(item, catName) {
  if (item.is_drink === true) return true;
  if (item.is_drink === false) return false;
  const tags = (item.tags || []).join(' ').toLowerCase();
  if (/drink|cocktail|beverage|alcohol|liquor|wine|beer/.test(tags)) return true;
  return /bar|cocktail|drink|wine|beer|liquor|spirits|coffee|beverage|tiki|happy hour/i.test(catName || '');
}
function itemModifiers(item) {
  return (item.modifiers || []).map((m) => ({
    name: m.name || m.label || 'Modifier',
    price_delta_cents: m.price_delta_cents != null ? m.price_delta_cents : Math.round((Number(m.price_delta) || Number(m.price) || 0) * 100),
  }));
}

/* Build the check view-model: server check + pending offline ops overlaid.
   Temp checks (opened offline) live in localStorage drafts. */
async function getCheckView(id) {
  if (String(id).startsWith('tmp-')) {
    const d = localStorage.getItem('expoline.draft:' + id);
    if (!d) throw new Error('Offline draft not found');
    const check = JSON.parse(d);
    check.totals = estimateTotals(check);
    return { check, temp: true };
  }
  const rid = realId(id);
  let base;
  try {
    const raw = await api('/api/checks/' + rid);
    base = raw.check || raw;
    try { localStorage.setItem('expoline.checkcache:' + rid, JSON.stringify(base)); } catch (e) { /* ignore */ }
  } catch (e) {
    if (e instanceof OfflineError) {
      const c = localStorage.getItem('expoline.checkcache:' + rid);
      if (!c) throw e;
      base = JSON.parse(c);
    } else throw e;
  }
  const check = JSON.parse(JSON.stringify(base));
  check.items = check.items || [];
  check.payments = check.payments || [];
  const idmap = loadIdMap();
  const ops = await Outbox.forCheck(rid);
  if (ops.length) applyOps(check, ops, idmap);
  return { check, temp: false };
}

function applyOps(check, ops, idmap) {
  let estimated = false;
  for (const o of ops) {
    const p = o.payload || {};
    if (o.op === 'add_items') {
      for (const it of (p.items || [])) {
        check.items.push({
          id: it.temp_id, menu_item_id: it.menu_item_id, name: it.name,
          price_cents: it.price_cents, seat: it.seat, qty: it.qty,
          modifiers: it.modifiers || [], state: 'held', pending: true,
        });
      }
      estimated = true;
    } else if (o.op === 'void_item') {
      const iid = String((idmap && (idmap[p.item_id] || p.item_id)) || p.item_id);
      check.items = check.items.filter((i) => String(i.id) !== iid);
      estimated = true;
    } else if (o.op === 'send') {
      check.items.forEach((i) => { if (i.state === 'held') i.state = 'sent'; });
    } else if (o.op === 'payment') {
      check.payments.push({ method: p.method, amount_cents: p.amount_cents, tip_cents: p.tip_cents || 0, tendered_cents: p.tendered_cents, pending: true, brand: p.brand, last4: p.last4 });
      estimated = true;
    } else if (o.op === 'close') {
      check.status = 'closed';
    }
  }
  if (estimated) check.totals = estimateTotals(check);
  return check;
}

/* Site money config — the SERVER is the single source of truth (calcTotals);
   the client only reads it here for display labels and offline estimates. */
async function siteConfig() {
  const fallback = { tax_rate: 0.0775, surcharge_pct: 0.05, service_charge_pct: 0.18, service_charge_min_guests: 8 };
  try {
    const c = await api('/api/config');
    const cfg = (c && c.config) || c || {};
    const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
    return {
      tax_rate: num(cfg.tax_rate, fallback.tax_rate),
      surcharge_pct: num(cfg.surcharge_pct, fallback.surcharge_pct),
      service_charge_pct: num(cfg.service_charge_pct, fallback.service_charge_pct),
      service_charge_min_guests: num(cfg.service_charge_min_guests, fallback.service_charge_min_guests),
    };
  } catch (e) { return fallback; }
}
const pctLabel = (p) => (Math.round(p * 1000) / 10).toString().replace(/\.0$/, '') + '%';

/* Client-side totals used ONLY while offline (labeled "estimated").
   Rules mirror the server contract; percentages/threshold come from the
   cached /api/config (defaults 5% surcharge, 18% service charge on 8+). */
function estimateTotals(check) {
  const items = (check.items || []).filter((i) => i.state !== 'void');
  let sub = 0;
  for (const i of items) {
    const q = i.qty || 1;
    sub += (i.price_cents || 0) * q;
    for (const m of (i.modifiers || [])) sub += (m.price_delta_cents || 0) * q;
  }
  const guests = check.guest_count || check.guests || 0;
  let surPct = 0.05, scPct = 0.18, scMin = 8;
  try {
    const c = JSON.parse(localStorage.getItem('expoline.cache:/api/config') || 'null');
    const cfg = (c && c.config) || c || {};
    if (typeof cfg.surcharge_pct === 'number' && isFinite(cfg.surcharge_pct)) surPct = cfg.surcharge_pct;
    if (typeof cfg.service_charge_pct === 'number' && isFinite(cfg.service_charge_pct)) scPct = cfg.service_charge_pct;
    if (typeof cfg.service_charge_min_guests === 'number' && isFinite(cfg.service_charge_min_guests)) scMin = cfg.service_charge_min_guests;
  } catch (e) { /* offline fallbacks above */ }
  const surcharge = Math.round(sub * surPct);
  const service_charge = scMin > 0 && guests >= scMin ? Math.round(sub * scPct) : 0;
  let rate = null;
  const t = check.totals || {};
  if (t.subtotal > 0) {
    const taxableBase = t.subtotal + (t.surcharge || 0) + (t.service_charge || 0);
    if (taxableBase > 0) rate = (t.tax || 0) / taxableBase;
  }
  if (rate == null) {
    try {
      const c = JSON.parse(localStorage.getItem('expoline.cache:/api/config') || 'null');
      const cfg = (c && c.config) || c || {};
      rate = typeof cfg.tax_rate === 'number' ? cfg.tax_rate : 0;
    } catch (e) { rate = 0; }
  }
  const tax = Math.round((sub + surcharge + service_charge) * rate);
  const total = sub + surcharge + service_charge + tax;
  const paid = (check.payments || []).reduce((a, p) => a + (p.amount_cents || 0), 0);
  return { subtotal: sub, surcharge, service_charge, tax, total, paid, balance: total - paid, estimated: true };
}

/* ============================================================
   ROUTER (hash)
   ============================================================ */
function parseRoute() {
  const h = location.hash || '#/login';
  const m = h.match(/^#\/([a-z]+)(?:\/([^?]+))?/);
  if (!m) return { view: 'login' };
  return { view: m[1], param: m[2] ? decodeURIComponent(m[2]) : null };
}
const notAuthorized = (what) =>
  '<div class="card"><h2>Not authorized</h2><p class="muted">' + esc(what || 'Your role cannot access this area.') + '</p>' +
  '<p><a class="btn btn-ghost" href="#/floor">Back</a></p></div>';

async function renderRoute(soft) {
  const r = parseRoute();
  state.route = r;
  renderHeader();
  const app = $('#app');
  window.scrollTo(0, 0);
  try {
    if (r.view === 'login') { renderLogin(app); return; }
    if (!state.user) { location.hash = '#/login'; return; }
    if (r.view === 'floor') return renderFloor(app);
    if (r.view === 'reservations') return renderReservations(app);
    if (r.view === 'waitlist') return renderWaitlist(app, api);
    if (r.view === 'giftcards') return renderGiftCards(app, api);
    if (r.view === 'loyalty') return renderLoyalty(app, api);
    if (r.view === 'order') return renderOrder(app, r.param);
    if (r.view === 'kds') return renderKds(app);
    if (r.view === 'clock') return renderClock(app);
    if (r.view === 'pay') return renderPay(app, r.param);
    if (r.view === 'manager') {
      if (state.user.role !== 'manager') { app.innerHTML = notAuthorized('Manager area — please log in as a manager.'); return; }
      const sub = (location.hash.match(/^#\/manager\/([a-z]+)/) || [])[1];
      if (sub === 'finance') return renderFinance(app);
      if (sub === 'shift') return renderShift(app);
      if (sub === 'menu') return renderMenuViewer(app);
      if (sub === 'floorplan') return renderFloorPlan(app);
      if (sub === 'timeclock') return renderTimeClock(app);
      if (sub === 'employees') return renderEmployees(app);
      if (sub === 'settings') return renderSvcChargeSettings(app);
      if (sub === 'cash') return renderCashDrawer(app, api);
      if (sub === 'schedule') return renderSchedule(app, api);
      if (sub === 'analytics') return renderProductMix(app, api);
      if (sub === 'insights') return renderInsights(app, api);
      if (sub === 'notes') return renderStaffNotes(app, api);
      if (sub === 'reviews') return renderReviews(app, api);
      if (sub === 'multisite') return renderMultisite(app, api);
      if (sub === 'inventory') return renderInventory(app, api);
      if (sub === 'apidocs') return renderApiDocs(app, api);
      return renderManager(app);
    }
    app.innerHTML = '<div class="empty">Unknown view.</div>';
  } catch (e) {
    if (e instanceof ApiError && (e.status === 401 || e.status === 403)) { handleApiError(e); return; }
    if (e instanceof OfflineError) { app.innerHTML = '<div class="card"><h2>Offline</h2><p class="muted">No cached copy available. Reconnect to continue.</p></div>'; return; }
    app.innerHTML = '<div class="card"><h2>Something went wrong</h2><p class="muted">' + esc(e.message || e) + '</p></div>';
  }
  if (!soft) updateOfflineBanner();
}

/* ============================================================
   VIEW: LOGIN
   ============================================================ */
function renderLogin(app) {
  $('#app-header').classList.add('hidden');
  closeKdsSocket();
  let pin = '';
  let role = 'server';
  app.innerHTML =
    '<div class="login-wrap"><div class="card login-card">' +
    '<div class="brand" style="justify-content:center"><span class="brand-mark">◈</span><span class="brand-name">Expoline</span></div>' +
    '<p class="login-sub">Harbor Luxe POS · Bali Hai</p>' +
    '<div class="role-row" role="radiogroup" aria-label="Role">' +
    ['server|Server', 'kitchen|Kitchen', 'manager|Manager'].map((s) => {
      const [v, l] = s.split('|');
      return '<button class="btn tab role-chip' + (v === role ? ' active' : '') + '" data-role="' + v + '">' + l + '</button>';
    }).join('') + '</div>' +
    '<div class="pin-dots" id="pin-dots" aria-hidden="true"></div>' +
    '<div class="pin-pad" id="pin-pad">' +
    [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => '<button class="pin-key" data-k="' + n + '">' + n + '</button>').join('') +
    '<button class="pin-key fn" data-k="clear">⌫</button>' +
    '<button class="pin-key" data-k="0">0</button>' +
    '<button class="pin-key fn" data-k="back">←</button>' +
    '</div>' +
    '<div class="login-error" id="login-error"></div>' +
    '<button class="btn btn-primary btn-block" id="login-go" style="min-height:60px;font-size:1.15rem">Log in</button>' +
    '<p class="demo-hint">Demo PINs — server 1111 · kitchen 2222 · manager 2580</p>' +
    '</div></div>';

  const dots = $('#pin-dots');
  const draw = () => { dots.innerHTML = [0, 1, 2, 3].map((i) => '<span class="dot' + (pin.length > i ? ' on' : '') + '"></span>').join(''); };
  draw();
  $$('#pin-pad .pin-key').forEach((b) => b.onclick = () => {
    const k = b.dataset.k;
    if (k === 'clear') pin = '';
    else if (k === 'back') pin = pin.slice(0, -1);
    else if (pin.length < 8) pin += k;
    draw();
  });
  $$('.role-chip').forEach((b) => b.onclick = () => {
    role = b.dataset.role;
    $$('.role-chip').forEach((x) => x.classList.toggle('active', x === b));
  });
  const err = (m) => { $('#login-error').textContent = m; };
  $('#login-go').onclick = async () => {
    if (!pin) { err('Enter your PIN'); return; }
    err('');
    try {
      const r = await rawApi('/api/auth/login', 'POST', { pin });
      const user = r.user || r;
      if (!user || !user.role) throw new Error('Login returned no user');
      saveSession(r.token, { id: user.id, name: user.name || role, role: user.role });
      const dest = user.role === 'kitchen' ? '#/kds' : user.role === 'manager' ? '#/manager' : '#/floor';
      location.hash = dest;
      // flush anything queued while we were logged out
      setTimeout(() => flushOutbox(), 800);
      // phase 3C: staff notes pushed at login (86s, specials, reservations)
      setTimeout(() => showLoginSummary(), 600);
    } catch (e) {
      if (e instanceof OfflineError) err('Offline — cannot log in without a connection');
      else err(e.message || 'Login failed');
    }
  };
}

/* ============================================================
   VIEW: FLOOR (server + manager)
   ============================================================ */
async function renderFloor(app) {
  const role = state.user.role;
  if (role !== 'server' && role !== 'manager') { app.innerHTML = notAuthorized(); return; }
  app.innerHTML = '<div class="view-head"><h1>Floor</h1><span class="spacer"></span>' +
    '<button class="btn btn-ghost btn-sm" id="floor-merge" title="One-tap merge: fold one party into another">Merge</button> ' +
    '<button class="btn btn-ghost btn-sm" id="floor-move" title="Move a check to a different table">Move</button> ' +
    '<span class="muted small" id="floor-clock"></span></div>' +
    '<div id="floor-banner-slot"></div>' +
    '<div class="tabs" id="zone-tabs"></div><div class="zone-grid" id="zone-grid"></div>';
  const tick = () => { const c = $('#floor-clock'); if (c) c.textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); };
  tick(); const iv = setInterval(tick, 20000);
  const cleanup = () => { clearInterval(iv); if (tmIv) clearInterval(tmIv); };
  app._cleanup = cleanup;

  let zones;
  try { zones = await getZones(); }
  catch (e) { if (handleApiError(e) === 'bounced') return; app.innerHTML = '<div class="empty">Could not load floor.</div>'; return; }
  if (!zones.length) { $('#zone-grid').innerHTML = '<div class="empty">No zones configured.</div>'; return; }

  let active = zones[0].id;
  const tabs = $('#zone-tabs'), grid = $('#zone-grid'), bannerSlot = $('#floor-banner-slot');
  const PO2 = window.ParityOrders;
  let timers = {}, floorMode = null, floorSel = null, tmIv = null;

  /* Phase 3A: actionable turn-time badges on every open table. */
  const loadTimers = async () => {
    try { const rows = await api('/api/floor/timers'); timers = {}; (rows.timers || rows).forEach((r) => { timers[String(r.table_id)] = r; }); }
    catch (e) { /* keep last-known */ }
    drawGrid();
  };
  const drawGrid = () => {
    const z = zones.find((x) => String(x.id) === String(active));
    grid.innerHTML = z.tables.map((t) => {
      const tm = timers[String(t.id)];
      return '<button class="table-tile' + (t.open_check_id ? ' open' : '') + (tm && tm.turn_status === 'over' ? ' over' : '') +
        (floorSel && String(floorSel) === String(t.id) ? ' pick-src' : '') + '" data-t="' + esc(String(t.id)) + '"' +
        (floorMode === 'move' && t.open_check_id ? ' draggable="true"' : '') +
        ' aria-label="Table ' + esc(t.label) + (t.open_check_id ? ', open' : ', available') + '">' +
        '<span>' + esc(t.label) + '</span>' +
        '<span class="sub">' + (t.open_check_id ? 'OPEN' : (t.seats ? t.seats + ' seats' : 'Available')) + '</span>' +
        (tm ? PO2.timerChip(tm) : '') + '</button>';
    }).join('');
    $$('.table-tile', grid).forEach((b) => {
      const t = z.tables.find((x) => String(x.id) === b.dataset.t);
      if (floorMode === 'move' && t.open_check_id) {
        b.ondragstart = (e) => { e.dataTransfer.setData('text/plain', JSON.stringify({ checkId: t.open_check_id, label: t.label })); e.dataTransfer.effectAllowed = 'move'; };
      }
      if (floorMode === 'move' && !t.open_check_id) {
        b.ondragover = (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; };
        b.ondrop = (e) => { e.preventDefault(); try { const d = JSON.parse(e.dataTransfer.getData('text/plain')); doMove(d.checkId, d.label, t); } catch (err) {} };
      }
      b.onclick = () => {
        if (floorMode) { handleModeTap(t); return; }
        if (t.open_check_id) location.hash = '#/order/' + t.open_check_id;
        else openCheckSheet(t);
      };
    });
  };

  const drawTabs = () => {
    tabs.innerHTML = zones.map((z) => {
      const open = z.tables.filter((t) => t.open_check_id).length;
      return '<button class="tab' + (z.id === active ? ' active' : '') + '" data-z="' + esc(String(z.id)) + '">' + esc(z.name) + '<span class="count">' + open + '/' + z.tables.length + '</span></button>';
    }).join('');
    $$('.tab', tabs).forEach((b) => b.onclick = () => { active = b.dataset.z; drawTabs(); drawGrid(); });
  };

  const drawBanner = () => {
    if (!floorMode) { bannerSlot.innerHTML = ''; return; }
    const hint = floorMode === 'merge'
      ? (floorSel ? 'Tap the check to merge IN — seats remap automatically.' : 'Merge mode: tap the table to KEEP.')
      : (floorSel ? 'Tap the free destination table.' : 'Move mode: tap the check’s table, or drag its tile.');
    bannerSlot.innerHTML = '<div class="floor-banner"><span>' + (floorMode === 'merge' ? '🔀 Merge mode — ' : '📍 Move mode — ') + esc(hint) + '</span>' +
      '<span class="spacer"></span><button class="btn btn-ghost btn-sm" id="floor-exit-mode">Exit</button></div>';
    $('#floor-exit-mode').onclick = exitMode;
  };
  const exitMode = () => { floorMode = null; floorSel = null; $('#floor-merge').classList.remove('btn-primary'); $('#floor-move').classList.remove('btn-primary'); drawBanner(); drawGrid(); };

  async function handleModeTap(t) {
    const other = zones.flatMap((z) => z.tables).find((x) => String(x.id) === String(floorSel));
    if (floorMode === 'merge') {
      if (!t.open_check_id) { toast('Merge needs an occupied table', 'err'); return; }
      if (!floorSel) { floorSel = t.id; drawBanner(); drawGrid(); return; }
      if (String(floorSel) === String(t.id)) { floorSel = null; drawBanner(); drawGrid(); return; }
      // one-action party merge: keep floorSel, fold t into it
      const keep = other, absorb = t;
      confirmDialog('Merge parties', 'Fold <b>Table ' + esc(absorb.label) + '</b> into <b>Table ' + esc(keep.label) + '</b>? Seats remap automatically and guest names survive.', 'Merge', async () => {
        try {
          const r = await api('/api/checks/' + encodeURIComponent(keep.open_check_id) + '/merge', 'POST', { source_check_ids: [absorb.open_check_id] });
          toast('Merged — party of ' + (r.guest_count || '?') + ' on Table ' + keep.label, 'ok');
          exitMode(); zones = await getZones(); drawTabs(); drawGrid(); loadTimers();
        } catch (e) { handleApiError(e); }
      });
    } else { // move
      if (!floorSel) {
        if (!t.open_check_id) { toast('Move: tap the check’s current table first', 'err'); return; }
        floorSel = t.id; drawBanner(); drawGrid(); return;
      }
      if (String(floorSel) === String(t.id)) { floorSel = null; drawBanner(); drawGrid(); return; }
      if (t.open_check_id) { toast('That table is occupied — pick a free one', 'err'); return; }
      doMove(other.open_check_id, other.label, t);
    }
  }
  async function doMove(checkId, fromLabel, destTable) {
    confirmDialog('Move check', 'Move the check from <b>Table ' + esc(fromLabel) + '</b> to <b>Table ' + esc(destTable.label) + '</b>? The KDS header updates itself.', 'Move', async () => {
      try {
        await api('/api/checks/' + encodeURIComponent(checkId) + '/move', 'POST', { table_id: destTable.id });
        toast('Check moved to Table ' + destTable.label, 'ok');
        exitMode(); zones = await getZones(); drawTabs(); drawGrid(); loadTimers();
      } catch (e) { handleApiError(e); }
    });
  }

  $('#floor-merge').onclick = () => {
    if (floorMode === 'merge') return exitMode();
    floorMode = 'merge'; floorSel = null;
    $('#floor-merge').classList.add('btn-primary'); $('#floor-move').classList.remove('btn-primary');
    drawBanner(); drawGrid();
  };
  $('#floor-move').onclick = () => {
    if (floorMode === 'move') return exitMode();
    floorMode = 'move'; floorSel = null;
    $('#floor-move').classList.add('btn-primary'); $('#floor-merge').classList.remove('btn-primary');
    drawBanner(); drawGrid();
  };
  drawTabs(); drawGrid();
  loadTimers(); tmIv = setInterval(loadTimers, 30000);

  function openCheckSheet(t) {
    let guests = 2, tabName = '';
    const bd = openModal(
      '<h2>New check · Table ' + esc(t.label) + '</h2>' +
      '<div class="field"><label>Guests</label><div class="stepper">' +
      '<button data-s="dec" aria-label="Fewer guests">−</button><span class="val" id="g-val">2</span><button data-s="inc" aria-label="More guests">+</button></div></div>' +
      '<div class="field"><label for="tab-name">Tab name (optional)</label><input type="text" id="tab-name" placeholder="e.g. Birthday table" maxlength="40"></div>' +
      '<div class="modal-actions"><button class="btn btn-ghost" data-x="cancel">Cancel</button>' +
      '<button class="btn btn-primary" data-x="go">Open check</button></div>');
    $('[data-s="dec"]', bd).onclick = () => { guests = Math.max(1, guests - 1); $('#g-val', bd).textContent = guests; };
    $('[data-s="inc"]', bd).onclick = () => { guests = Math.min(24, guests + 1); $('#g-val', bd).textContent = guests; };
    /* Tap the number to type the party size (WS-B) — same local guests
       value the steppers drive, same 1..24 bounds and bounce toast. */
    window.ParityOrders.tappableValue($('#g-val', bd), { get: () => guests, min: 1, max: 24, label: 'Guests',
      onApply: (n) => { guests = n; $('#g-val', bd).textContent = n; } });
    $('[data-x="cancel"]', bd).onclick = closeModal;
    $('[data-x="go"]', bd).onclick = async () => {
      tabName = $('#tab-name', bd).value.trim();
      closeModal();
      /* LAN SYNC (phase 2): the temp id is a uuid — it BECOMES the permanent
         cross-engine check uuid on the brain (DESIGN.md §7). The tmp- prefix
         is kept so routing/draft code keeps working. */
      const tempId = 'tmp-' + (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
      try {
        if (isOffline()) {
          const draft = { id: tempId, table_id: t.id, table_label: t.label, guest_count: guests, tab_name: tabName, items: [], payments: [], status: 'open', totals: { subtotal: 0, surcharge: 0, service_charge: 0, tax: 0, total: 0, paid: 0, balance: 0 } };
          localStorage.setItem('expoline.draft:' + tempId, JSON.stringify(draft));
          await Outbox.enqueue('open_check', { check_id: tempId, temp_id: tempId, table_id: t.id, guest_count: guests, tab_name: tabName });
          toast('Check opened offline — will sync', 'ok');
          location.hash = '#/order/' + tempId;
        } else {
          const r = await api('/api/checks', 'POST', { table_id: t.id, guest_count: guests, tab_name: tabName });
          const id = r.id || (r.check && r.check.id);
          if (!id) throw new Error('Server did not return a check id');
          location.hash = '#/order/' + id;
        }
      } catch (e) { handleApiError(e); }
    };
  }
}

/* ============================================================
   VIEW: RESERVATIONS + WAITLIST — floor-plan-integrated booking.
   Fewer taps than Toast: seat from the list in one tap (check opens
   automatically), smart table suggestions come from the server in one
   query, no-show history rides along on every phone number.
   ============================================================ */
const siteTodayLocal = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const STATUS_CHIP = { booked: '', seated: 'active', cancelled: 'bad', no_show: 'bad', completed: '', waiting: 'warn', notified: 'active', left: '', };

async function renderReservations(app) {
  const role = state.user.role;
  if (role !== 'server' && role !== 'manager') { app.innerHTML = notAuthorized(); return; }
  const isMgr = role === 'manager';
  let date = siteTodayLocal();

  app.innerHTML =
    '<div class="view-head"><h1>Reservations</h1><span class="spacer"></span>' +
    '<input type="date" id="resv-date" value="' + esc(date) + '" aria-label="Booking date" style="min-height:44px;background:var(--ink);border:1px solid var(--line);border-radius:8px;padding:8px 12px;color:var(--text)">' +
    '<button class="btn btn-primary" id="resv-new">＋ New</button></div>' +
    '<div class="resv-cols">' +
    '<div class="card"><h2>Bookings <span class="count" id="resv-count"></span></h2><div id="resv-list"><div class="empty">Loading…</div></div></div>' +
    '<div class="card"><div class="view-head" style="margin:0 0 8px"><h2>Waitlist <span class="count" id="wl-count"></span></h2><span class="spacer"></span><button class="btn btn-sm" id="wl-add">＋ Add</button></div><div id="wl-list"><div class="empty">Loading…</div></div></div>' +
    '</div>';

  $('#resv-date').onchange = (e) => { date = e.target.value || siteTodayLocal(); load(); };
  $('#resv-new').onclick = openResvModal;
  $('#wl-add').onclick = openWaitlistModal;

  async function load() {
    let resvs = [], wl = [];
    try {
      [resvs, wl] = await Promise.all([api('/api/reservations?date=' + encodeURIComponent(date)), api('/api/waitlist')]);
    } catch (e) { if (handleApiError(e) === 'bounced') return; }
    drawResvs(resvs); drawWaitlist(wl);
  }

  function drawResvs(rows) {
    $('#resv-count').textContent = rows.filter((r) => r.status === 'booked').length + ' booked';
    if (!rows.length) { $('#resv-list').innerHTML = '<div class="empty">No bookings for this date.</div>'; return; }
    $('#resv-list').innerHTML = rows.map((r) => {
      const warn = r.no_show_count ? ' <span class="chip bad" title="Prior no-shows">⚠ ' + r.no_show_count + ' no-show' + (r.no_show_count > 1 ? 's' : '') + '</span>' : '';
      const acts = [];
      if (r.status === 'booked') acts.push('<button class="btn btn-sm btn-primary" data-a="seat">Seat</button>');
      if (isMgr && r.status === 'booked') acts.push('<button class="btn btn-sm btn-ghost" data-a="noshow">No-show</button>');
      if (isMgr && !['cancelled', 'no_show', 'completed'].includes(r.status)) acts.push('<button class="btn btn-sm btn-danger" data-a="cancel">Cancel</button>');
      return '<div class="resv-row" data-id="' + r.id + '"><div class="grow">' +
        '<b>' + fmtClock(r.reserved_at) + '</b> · ' + esc(r.customer_name) +
        ' <span class="muted small">(' + r.party_size + ' guests' + (r.table_label ? ' · Tbl ' + esc(r.table_label) : ' · no table') + ')</span>' +
        ' <span class="chip ' + (STATUS_CHIP[r.status] || '') + '">' + esc(r.status.replace('_', ' ')) + '</span>' + warn +
        (r.notes ? '<div class="muted small">' + esc(r.notes) + '</div>' : '') +
        '</div><div class="resv-actions">' + acts.join('') + '</div></div>';
    }).join('');
    $$('#resv-list .resv-row').forEach((row) => {
      const id = row.dataset.id;
      const q = (a) => $('[data-a="' + a + '"]', row);
      if (q('seat')) q('seat').onclick = () => seatReservation(id);
      if (q('noshow')) q('noshow').onclick = () =>
        confirmDialog('Mark no-show?', 'This is recorded in the audit log and counts against the phone number.', 'Mark no-show', async () => {
          try { const r = await api('/api/reservations/' + id, 'PATCH', { status: 'no_show' }); toast('Marked no-show', 'ok'); load(); }
          catch (e) { handleApiError(e); }
        });
      if (q('cancel')) q('cancel').onclick = () =>
        confirmDialog('Cancel booking?', 'The table is released for this time slot.', 'Cancel booking', async () => {
          try { await api('/api/reservations/' + id, 'DELETE'); toast('Booking cancelled', 'ok'); load(); }
          catch (e) { handleApiError(e); }
        });
    });
  }

  function drawWaitlist(rows) {
    $('#wl-count').textContent = rows.length + ' waiting';
    if (!rows.length) { $('#wl-list').innerHTML = '<div class="empty">Waitlist is clear.</div>'; return; }
    $('#wl-list').innerHTML = rows.map((w) => {
      const wait = w.quoted_wait_min != null ? w.quoted_wait_min + ' min quoted' : 'no quote';
      const warn = w.no_show_count ? ' <span class="chip bad">⚠ ' + w.no_show_count + '</span>' : '';
      return '<div class="resv-row" data-id="' + w.id + '"><div class="grow">' +
        '<b>' + esc(w.customer_name) + '</b> <span class="muted small">(' + w.party_size + ' · ' + esc(wait) + ')</span>' +
        ' <span class="chip ' + (STATUS_CHIP[w.status] || '') + '">' + esc(w.status) + '</span>' + warn +
        '</div><div class="resv-actions">' +
        (w.status === 'waiting' ? '<button class="btn btn-sm" data-a="notify">Notify</button>' : '') +
        '<button class="btn btn-sm btn-primary" data-a="seat">Seat</button>' +
        (isMgr ? '<button class="btn btn-sm btn-danger" data-a="rm">✕</button>'
               : '<button class="btn btn-sm btn-ghost" data-a="left">Left</button>') +
        '</div></div>';
    }).join('');
    $$('#wl-list .resv-row').forEach((row) => {
      const id = row.dataset.id;
      const q = (a) => $('[data-a="' + a + '"]', row);
      if (q('notify')) q('notify').onclick = async () => {
        try { await api('/api/waitlist/' + id + '/notify', 'POST'); toast('Marked notified', 'ok'); load(); }
        catch (e) { handleApiError(e); }
      };
      if (q('seat')) q('seat').onclick = () => seatWaitlist(id);
      if (q('rm')) q('rm').onclick = () =>
        confirmDialog('Remove from waitlist?', 'This entry is deleted.', 'Remove', async () => {
          try { await api('/api/waitlist/' + id, 'DELETE'); load(); } catch (e) { handleApiError(e); }
        });
      if (q('left')) q('left').onclick = async () => {
        try { await api('/api/waitlist/' + id, 'PATCH', { status: 'left' }); load(); }
        catch (e) { handleApiError(e); }
      };
    });
  }

  /* Table picker: free + suggested tables for (datetime, party). One tap seats. */
  async function pickTable(party, whenIso, onPick) {
    let avail;
    try {
      avail = await api('/api/floor/availability?datetime=' + encodeURIComponent(whenIso) + '&party_size=' + party);
    } catch (e) { handleApiError(e); return; }
    const free = avail.tables.filter((t) => t.status === 'free');
    if (!free.length) { toast('No free tables for that time', 'err'); return; }
    free.sort((a, b) => (b.suggested - a.suggested) || (a.seats - b.seats));
    const bd = openModal('<h2>Pick a table · ' + party + ' guests</h2><p class="muted">★ = best fit for this party</p>' +
      '<div class="tbl-pick">' + free.map((t) =>
        '<button class="table-tile' + (t.suggested ? ' suggested' : '') + '" data-t="' + t.id + '">' +
        '<span>' + (t.suggested ? '★ ' : '') + esc(t.label) + '</span><span class="sub">' + t.seats + ' seats · ' + esc(t.zone || '') + '</span></button>').join('') +
      '</div><div class="modal-actions"><button class="btn btn-ghost" data-x="cancel">Cancel</button></div>');
    $('[data-x="cancel"]', bd).onclick = closeModal;
    $$('.table-tile', bd).forEach((b) => b.onclick = async () => { closeModal(); await onPick(Number(b.dataset.t)); });
  }

  async function seatReservation(id) {
    let r;
    try { r = (await api('/api/reservations?date=' + encodeURIComponent(date))).find((x) => String(x.id) === String(id)); }
    catch (e) { handleApiError(e); return; }
    if (!r) return;
    const go = async (tableId) => {
      try {
        const out = await api('/api/reservations/' + id, 'PATCH', { status: 'seated', table_id: tableId });
        toast('Seated — check opened', 'ok');
        if (out.check_id) location.hash = '#/order/' + out.check_id; else load();
      } catch (e) { handleApiError(e); }
    };
    if (r.table_id) go(r.table_id);
    else pickTable(r.party_size, r.reserved_at, go);
  }

  async function seatWaitlist(id) {
    let w;
    try { w = (await api('/api/waitlist')).find((x) => String(x.id) === String(id)); }
    catch (e) { handleApiError(e); return; }
    if (!w) return;
    pickTable(w.party_size, new Date().toISOString(), async (tableId) => {
      try {
        const out = await api('/api/waitlist/' + id + '/seat', 'POST', { table_id: tableId });
        toast('Seated — check opened', 'ok');
        location.hash = '#/order/' + out.check_id;
      } catch (e) { handleApiError(e); }
    });
  }

  function openResvModal() {
    let party = 2, tableId = null;
    const dflt = new Date(Date.now() + 2 * 3600e3);
    const hh = String(dflt.getHours()).padStart(2, '0'), mm = dflt.getMinutes() < 30 ? '00' : '30';
    const bd = openModal(
      '<h2>New reservation</h2>' +
      '<div class="field"><label for="nr-name">Name</label><input type="text" id="nr-name" maxlength="60" placeholder="Guest name"></div>' +
      '<div class="field"><label for="nr-phone">Phone (optional)</label><input type="tel" id="nr-phone" maxlength="20" placeholder="(619) 555-0123"></div>' +
      '<div class="field"><label>Party size</label><div class="stepper">' +
      '<button data-s="dec">−</button><span class="val" id="nr-pval">2</span><button data-s="inc">+</button></div></div>' +
      '<div class="field"><label for="nr-date">Date</label><input type="date" id="nr-date" value="' + esc(date) + '"></div>' +
      '<div class="field"><label for="nr-time">Time</label><input type="time" id="nr-time" value="' + hh + ':' + mm + '"></div>' +
      '<div class="field"><label for="nr-dur">Duration</label><select id="nr-dur"><option value="60">1 hr</option><option value="90" selected>1.5 hr</option><option value="120">2 hr</option><option value="180">3 hr</option></select></div>' +
      '<div class="field"><label for="nr-table">Table (★ suggested)</label><select id="nr-table"><option value="">— pick after time —</option></select></div>' +
      '<div class="field"><label for="nr-notes">Notes (optional)</label><input type="text" id="nr-notes" maxlength="200" placeholder="Allergies, occasion…"></div>' +
      '<div class="modal-actions"><button class="btn btn-ghost" data-x="cancel">Cancel</button>' +
      '<button class="btn btn-primary" data-x="go">Book</button></div>');

    const setParty = (p) => { party = Math.min(24, Math.max(1, p)); $('#nr-pval', bd).textContent = party; refreshTables(); };
    $('[data-s="dec"]', bd).onclick = () => setParty(party - 1);
    $('[data-s="inc"]', bd).onclick = () => setParty(party + 1);
    $('[data-x="cancel"]', bd).onclick = closeModal;

    let lastKey = '';
    async function refreshTables() {
      const d = $('#nr-date', bd).value, t = $('#nr-time', bd).value;
      if (!d || !t) return;
      const key = d + '|' + t + '|' + party;
      if (key === lastKey) return;
      lastKey = key;
      const sel = $('#nr-table', bd);
      sel.innerHTML = '<option value="">Checking…</option>';
      try {
        const av = await api('/api/floor/availability?datetime=' + encodeURIComponent(d + 'T' + t + ':00') + '&party_size=' + party);
        const free = av.tables.filter((x) => x.status === 'free')
          .sort((a, b) => (b.suggested - a.suggested) || (a.seats - b.seats));
        sel.innerHTML = '<option value="">No table (unassigned)</option>' + free.map((x) =>
          '<option value="' + x.id + '"' + (x.suggested ? ' data-s="1"' : '') + '>' +
          (x.suggested ? '★ ' : '') + esc(x.label) + ' · ' + x.seats + ' seats · ' + esc(x.zone || '') + '</option>').join('');
        const sug = free.find((x) => x.suggested);
        if (sug) { sel.value = String(sug.id); tableId = sug.id; }
      } catch (e) { sel.innerHTML = '<option value="">Unavailable</option>'; }
    }
    $('#nr-date', bd).onchange = () => { lastKey = ''; refreshTables(); };
    $('#nr-time', bd).onchange = () => { lastKey = ''; refreshTables(); };
    $('#nr-table', bd).onchange = (e) => { tableId = e.target.value ? Number(e.target.value) : null; };
    refreshTables();

    $('[data-x="go"]', bd).onclick = async () => {
      const name = $('#nr-name', bd).value.trim();
      if (!name) { toast('Name is required', 'err'); return; }
      const body = {
        customer_name: name, phone: $('#nr-phone', bd).value.trim(), party_size: party,
        reserved_at: $('#nr-date', bd).value + 'T' + $('#nr-time', bd).value + ':00',
        duration_min: Number($('#nr-dur', bd).value), notes: $('#nr-notes', bd).value.trim(),
      };
      if (tableId) body.table_id = tableId;
      try {
        const r = await api('/api/reservations', 'POST', body);
        closeModal();
        if (r.no_show_count) toast('⚠ ' + r.no_show_count + ' prior no-show' + (r.no_show_count > 1 ? 's' : '') + ' on this number', 'err');
        else toast('Booked', 'ok');
        if ($('#nr-date', bd)) date = $('#nr-date', bd).value;
        $('#resv-date').value = date;
        load();
      } catch (e) { handleApiError(e); }
    };
  }

  function openWaitlistModal() {
    let party = 2, quoted = 20;
    const bd = openModal(
      '<h2>Add to waitlist</h2>' +
      '<div class="field"><label for="wl-name">Name</label><input type="text" id="wl-name" maxlength="60" placeholder="Guest name"></div>' +
      '<div class="field"><label for="wl-phone">Phone (optional)</label><input type="tel" id="wl-phone" maxlength="20"></div>' +
      '<div class="field"><label>Party size</label><div class="stepper">' +
      '<button data-s="dec">−</button><span class="val" id="wl-pval">2</span><button data-s="inc">+</button></div></div>' +
      '<div class="field"><label>Quoted wait</label><div class="stepper">' +
      '<button data-q="dec">−</button><span class="val" id="wl-qval">20 min</span><button data-q="inc">+</button></div></div>' +
      '<div class="modal-actions"><button class="btn btn-ghost" data-x="cancel">Cancel</button>' +
      '<button class="btn btn-primary" data-x="go">Add</button></div>');
    $('[data-s="dec"]', bd).onclick = () => { party = Math.max(1, party - 1); $('#wl-pval', bd).textContent = party; };
    $('[data-s="inc"]', bd).onclick = () => { party = Math.min(24, party + 1); $('#wl-pval', bd).textContent = party; };
    $('[data-q="dec"]', bd).onclick = () => { quoted = Math.max(0, quoted - 5); $('#wl-qval', bd).textContent = quoted + ' min'; };
    $('[data-q="inc"]', bd).onclick = () => { quoted = Math.min(180, quoted + 5); $('#wl-qval', bd).textContent = quoted + ' min'; };
    $('[data-x="cancel"]', bd).onclick = closeModal;
    $('[data-x="go"]', bd).onclick = async () => {
      const name = $('#wl-name', bd).value.trim();
      if (!name) { toast('Name is required', 'err'); return; }
      try {
        const w = await api('/api/waitlist', 'POST', { customer_name: name, phone: $('#wl-phone', bd).value.trim(), party_size: party, quoted_wait_min: quoted });
        closeModal();
        if (w.no_show_count) toast('⚠ ' + w.no_show_count + ' prior no-show' + (w.no_show_count > 1 ? 's' : '') + ' on this number', 'err');
        else toast('Added to waitlist', 'ok');
        load();
      } catch (e) { handleApiError(e); }
    };
  }

  load();
}

/* ============================================================
   VIEW: ORDER (server) — seat-first ordering, HOLD + SEND only.
   Locked rule: NO Stay / Release / Quick Send anywhere.
   ============================================================ */
function loadStaged(checkId) {
  try { return JSON.parse(localStorage.getItem('expoline.staged:' + checkId) || '[]'); } catch (e) { return []; }
}
function saveStaged(checkId, staged) {
  try { localStorage.setItem('expoline.staged:' + checkId, JSON.stringify(staged)); } catch (e) { /* ignore */ }
}

async function renderOrder(app, checkId) {
  if (state.user.role !== 'server' && state.user.role !== 'manager') { app.innerHTML = notAuthorized(); return; }
  if (!checkId) { location.hash = '#/floor'; return; }

  let view;
  try { view = await getCheckView(checkId); }
  catch (e) { if (handleApiError(e) === 'bounced') return; app.innerHTML = '<div class="card"><h2>Check not found</h2><p><a class="btn btn-ghost" href="#/floor">Back to floor</a></p></div>'; return; }
  let check = view.check;
  let guests = check.guest_count || check.guests || 2;
  /* The seat the server is ringing for survives re-renders (HOLD, quick
     actions, websocket redraws) — losing it mid-rush sends the next tap to
     Seat 1. Persisted per check, clamped to the live guest count. */
  let seat = 1;
  try { seat = Number(sessionStorage.getItem('expoline.seat:' + checkId)) || 1; } catch (e) { /* ignore */ }
  if (!(seat >= 1)) seat = 1;
  if (seat > guests) seat = guests;
  const setSeat = (s) => {
    seat = Math.max(1, Math.min(Math.max(1, guests), s));
    try { sessionStorage.setItem('expoline.seat:' + checkId, String(seat)); } catch (e) { /* ignore */ }
  };
  let staged = loadStaged(checkId);
  /* Rush controls: quickKey = the tapped cart line ('staged:<temp_id>' or
     'held:<item_id>') whose quick-action bar is open; selectMode shows the
     multi-select checkboxes for bulk seat moves. */
  let quickKey = null;
  let selectMode = false;
  try { selectMode = sessionStorage.getItem('expoline.selectMode:' + checkId) === '1'; } catch (e) { /* ignore */ }
  const setSelectMode = (on) => {
    selectMode = !!on;
    try { sessionStorage.setItem('expoline.selectMode:' + checkId, on ? '1' : '0'); } catch (e) { /* ignore */ }
  };
  let menu = [], activeCat = null;

  try { menu = await getMenu(); } catch (e) { handleApiError(e); }

  /* Phase 3A: daypart auto-switch. The menu follows the site clock with zero
     taps; the pill is only a manual override. */
  let dpInfo = null, dpOverride = null;
  try { dpOverride = sessionStorage.getItem('expoline.daypartOverride') || 'auto'; } catch (e) { dpOverride = 'auto'; }
  try { dpInfo = await api('/api/dayparts'); } catch (e) { /* offline: show everything */ }
  const PO = window.ParityOrders;
  const dpWindow = () => {
    if (!dpInfo) return null;
    if (dpOverride === 'all') return null;
    if (dpOverride && dpOverride !== 'auto') return PO.windowForName(dpInfo.schedule, dpOverride) || dpInfo.window;
    return dpInfo.window;
  };
  const visibleMenu = () => PO.filterMenuByDaypart(menu, dpWindow());
  const dpLabel = () => {
    const w = dpWindow();
    if (dpOverride === 'all') return '🍽 All day';
    if (w) return '🍽 ' + w.name + (dpOverride === 'auto' || !dpOverride ? ' · auto' : '');
    return '🍽 All day' + (dpInfo && dpInfo.current ? '' : ' · auto');
  };

  const totals = check.totals || {};
  app.innerHTML =
    '<div class="order-top">' +
    '<a class="btn btn-ghost" href="#/floor" aria-label="Back to floor">‹</a>' +
    '<span class="table-label">' + esc(check.table_label || check.table || ('Check ' + String(checkId).slice(-4))) + '</span>' +
    (check.tab_name ? '<span class="muted">· ' + esc(check.tab_name) + '</span>' : '') +
    '<span class="muted small" id="hdr-guests"><span id="hdr-guests-n">' + guests + '</span> guests</span>' +
    '<button class="icon-btn" id="check-settings" title="Check settings — guests, tab name, coursing, order note, void check" aria-label="Check settings">⚙</button>' +
    '<span class="spacer"></span>' +
    '<button class="pill dp-pill" id="dp-pill" title="Menu daypart — auto by clock, tap to override">' + esc(dpLabel()) + '</button>' +
    '<a class="btn btn-primary" href="#/pay/' + encodeURIComponent(checkId) + '">Pay · ' + fmt(totals.total) + '</a>' +
    '</div>' +
    (totals.estimated ? '<p class="small muted">Totals estimated while offline — final math comes from the server on sync.</p>' : '') +
    '<h3 style="margin-bottom:4px">Seat <span class="muted small">— pick a seat first</span> ' +
    '<button class="icon-btn" id="seat-rename" title="Rename guest at this seat" aria-label="Rename guest">✎</button></h3>' +
    '<div class="seat-row" id="seat-row" role="radiogroup" aria-label="Seat"></div>' +
    '<div class="tabs" id="cat-tabs"></div>' +
    /* Phase 3A (NG-D): quick-pick row — one-tap popular items (SpotOn V3 1:05
       "quick buttons for popular items"). Manager flags items as popular in
       the menu editor; 86'd items never appear here. */
    '<div class="quick-pick" id="quick-pick" style="display:none"></div>' +
    /* Menu search — instant filter across all categories. Faster than scrolling
       19 categories when you know the item name. */
    '<div class="menu-search-row"><input type="search" id="menu-search" placeholder="🔍 Search menu…" autocomplete="off" aria-label="Search menu items">' +
    '<button class="btn btn-ghost btn-sm" id="menu-search-clear" style="display:none" aria-label="Clear search">✕</button></div>' +
    '<div class="order-layout"><div><div class="item-grid" id="item-grid"></div>' +
    '<div class="drinks-note">🍸 <b>Drinks</b> are tagged <span class="drink-tag">BAR</span> — they fire to the <b>bar</b> immediately on send, never holding up food.</div></div>' +
    '<div class="cart-panel"><div class="card"><h3>Order</h3><div id="cart-body"></div>' +
    /* Handheld bottom bar shows the running total next to the actions
       (mirrors the header Pay total — same value, same paint points);
       the span is display:none except at the handheld breakpoint. */
    '<div class="order-actions"><span class="order-total" id="order-total">' + fmt(totals.total) + '</span><button class="btn btn-amber btn-big" id="btn-hold">HOLD</button>' +
    '<button class="btn btn-green btn-big" id="btn-send">SEND</button>' +
    /* Phase 3A (P0-4): one-tap send-now — staged items go straight to the
       KDS, skipping the HOLD step (Toast "Send" parity). */
    '<button class="btn btn-blue btn-big" id="btn-sendnow" title="Add staged items and fire them immediately">SEND NOW</button></div>' +
    '</div></div></div>' +
    /* Synchronized course-fire timing: shows optimal fire times for remaining
       courses, computed from eat/prep estimates. Fire at the right moment so
       courses land in sequence — no gap, no rush. */
    '<div class="card" id="course-fire-card" style="margin-top:12px;display:none"><h3>🔥 Course timing</h3><div id="course-fire-body"><p class="muted small">Loading…</p></div></div>';

  const seatRow = $('#seat-row'), catTabs = $('#cat-tabs'), itemGrid = $('#item-grid'), cartBody = $('#cart-body');

  /* Header guests label: the header is only rebuilt on full renders, so
     guest_count changes (seat add, typed-seat growth) repaint it in place
     from the light-refresh paths — otherwise it reads stale until HOLD. */
  const paintGuests = () => {
    /* The count lives in its own span (#hdr-guests-n) so tap-to-type can
       own the number without eating the " guests" suffix on restore. */
    const n = $('#hdr-guests-n');
    if (n) { n.textContent = guests; return; }
    const el = $('#hdr-guests');
    if (el) el.textContent = guests + ' guests';
  };

  /* The header count itself is tap-to-type (WS-B): type the party size
     and the check PATCHes to match — the same endpoint "+ Seat" and
     Check settings use, no stepper-tapping and no modal round-trip.
     A shrink the server refuses (seats beyond the new count still hold
     lines or names) surfaces the server's message and the label keeps
     the real count. */
  const applyGuestCount = async (n) => {
    if (n === guests) return;
    if (String(checkId).startsWith('tmp-')) {
      try {
        const d = JSON.parse(localStorage.getItem('expoline.draft:' + checkId));
        if (d) { d.guest_count = n; localStorage.setItem('expoline.draft:' + checkId, JSON.stringify(d)); }
      } catch (e) { /* best effort — the draft re-syncs on next render */ }
      check.guest_count = n; guests = n;
      paintGuests(); drawSeats(); drawCart();
      return;
    }
    if (isOffline()) { toast('Changing the guest count needs a connection — reconnect first', 'err'); paintGuests(); return; }
    try {
      await api('/api/checks/' + realId(checkId), 'PATCH', { guest_count: n });
      const v = await getCheckView(checkId).catch(() => null);
      if (v) { check = v.check; guests = check.guest_count || n; }
      else guests = n;
    } catch (e) { handleApiError(e); }
    paintGuests(); drawSeats(); drawCart();
  };
  const hdrGuestsEl = $('#hdr-guests-n');
  if (hdrGuestsEl) PO.tappableValue(hdrGuestsEl, { get: () => guests, min: 1, max: 24, label: 'Guests',
    onApply: (n) => { applyGuestCount(n); } });

  /* Seat strip: chips carry per-seat line counts; "+ Seat" grows the check
     (PATCH guest_count — server-level, no manager PIN) and selects the new
     seat so the next taps land on it; the active chip's ✎ renames that
     guest via the existing modal. */
  async function renameSeat(s) {
    const names = check.seat_names || {};
    const r = await PO.openRenameSeatModal(check.id, s, names[s] || '');
    if (r === null) return; // cancelled
    try {
      const v = await getCheckView(checkId);
      check = v.check; guests = check.guest_count || guests; drawSeats(); drawCart();
    } catch (e) { handleApiError(e); }
  }
  async function addSeat() {
    if (guests >= 24) { toast('24 guests is the max for one check', 'err'); return; }
    if (isOffline()) { toast('Adding a seat needs a connection — reconnect first', 'err'); return; }
    try {
      await api('/api/checks/' + realId(checkId), 'PATCH', { guest_count: guests + 1 });
    } catch (e) { handleApiError(e); return; }
    try {
      const v = await getCheckView(checkId);
      check = v.check; guests = check.guest_count || guests + 1;
    } catch (e) { guests = guests + 1; }
    setSeat(guests);
    paintGuests();
    drawSeats(); drawCart();
    toast('Seat ' + guests + ' added — tap items to ring for this guest', 'ok');
  }
  const drawSeats = () => {
    const counts = PO.countLinesBySeat(
      staged.concat((check.items || []).filter((i) => ['held', 'sent', 'fulfilled'].includes(i.state))));
    seatRow.innerHTML = PO.seatStripHtml({ guestCount: guests, seatNames: check.seat_names || {}, counts, selectedSeat: seat });
    $$('.seat-chip[data-s]', seatRow).forEach((b) => b.onclick = (e) => {
      if (e.target.closest('[data-rename-seat]')) return; // rename has its own handler
      setSeat(Number(b.dataset.s)); drawSeats(); drawCart();
    });
    $$('[data-rename-seat]', seatRow).forEach((b) => b.onclick = (e) => {
      e.stopPropagation();
      setSeat(Number(b.dataset.renameSeat));
      drawSeats(); drawCart();
      renameSeat(seat);
    });
    const add = $('[data-add-seat]', seatRow);
    if (add) add.onclick = addSeat;
  };
  const drawCats = () => {
    const vm = visibleMenu();
    if (!vm.some((c) => String(c.id) === String(activeCat))) activeCat = vm.length ? vm[0].id : null;
    catTabs.innerHTML = vm.map((c) =>
      '<button class="tab' + (c.id === activeCat ? ' active' : '') + '" data-c="' + esc(String(c.id)) + '">' + esc(c.name) + '</button>').join('');
    $$('.tab', catTabs).forEach((b) => b.onclick = () => { activeCat = b.dataset.c; drawCats(); drawItems(); });
  };
  const drawItems = () => {
    const q = (searchInput && searchInput.value || '').trim().toLowerCase();
    /* Search mode: flat results across all categories. */
    if (q) {
      const hits = [];
      visibleMenu().forEach((c) => (c.items || []).forEach((i) => {
        if ((i.name || '').toLowerCase().includes(q)) hits.push({ item: i, catName: c.name });
      }));
      if (!hits.length) { itemGrid.innerHTML = '<div class="empty">No items match “' + esc(searchInput.value.trim()) + '”.</div>'; return; }
      itemGrid.innerHTML = hits.map(({ item: i, catName }) => {
        const drink = isDrink(i, catName);
        return '<button class="item-card" data-i="' + esc(String(i.id)) + '" data-cat="' + esc(catName) + '">' +
          (drink ? '<span class="drink-tag">BAR</span>' : '') +
          '<span class="nm">' + esc(i.name) + '</span><span class="pr">' + fmt(i.price_cents) + '</span>' +
          '<span class="cat-lbl">' + esc(catName) + '</span></button>';
      }).join('');
      $$('.item-card', itemGrid).forEach((b) => b.onclick = () => {
        const item = hits.find(({ item: x }) => String(x.id) === b.dataset.i).item;
        addItemFlow(item, b.dataset.cat);
      });
      return;
    }
    const cat = visibleMenu().find((c) => String(c.id) === String(activeCat));
    if (!cat) { itemGrid.innerHTML = '<div class="empty">No menu loaded.</div>'; return; }
    itemGrid.innerHTML = cat.items.map((i) => {
      const drink = isDrink(i, cat.name);
      return '<button class="item-card" data-i="' + esc(String(i.id)) + '">' +
        (drink ? '<span class="drink-tag">BAR</span>' : '') +
        '<span class="nm">' + esc(i.name) + '</span><span class="pr">' + fmt(i.price_cents) + '</span></button>';
    }).join('');
    $$('.item-card', itemGrid).forEach((b) => b.onclick = () => {
      const item = cat.items.find((x) => String(x.id) === b.dataset.i);
      addItemFlow(item, cat.name);
    });
  };

  /* Menu search wiring. */
  const searchInput = $('#menu-search'), searchClear = $('#menu-search-clear');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      searchClear.style.display = searchInput.value ? '' : 'none';
      drawItems();
    });
    searchClear.onclick = () => { searchInput.value = ''; searchClear.style.display = 'none'; drawItems(); searchInput.focus(); };
  }

  /* Phase 3A (P0-6/NG-E/P0-2): guided modifier flow — modifier GROUPS with
     required/min/max, defaults pre-checked, 86'd options disabled, nested
     groups revealed by their parent option; per-modifier notes ("light on
     the cheese"); per-line special request + allergy flag. */
  /* preset (staged-line "Modify" restage): prefill qty / seat / course /
     modifiers / note / allergy from the staged entry being edited, so the
     flow reopens the way the line already is instead of making the server
     rebuild it. The editor this opens is the full one — everything on the
     line is changeable before the line ever reaches the kitchen. */
  function addItemFlow(item, catName, preset) {
    const groups = Array.isArray(item.modifier_groups) && item.modifier_groups.length
      ? item.modifier_groups : null;
    const flatMods = groups ? [] : itemModifiers(item);
    let qty = (preset && preset.qty) || 1;
    /* Seat + course are pickable HERE, while the line is being rung —
       not only later on the held line. Seat starts from the preset
       (staged-line Modify) or the working seat; course from the preset,
       else the item's menu default. */
    let mSeat = (preset && preset.seat != null) ? preset.seat : seat;
    const startCourse = preset && preset.course !== undefined ? preset.course : (item.course || null);
    /* Fast path for FRESH adds only: nothing to configure, so stage in
       one tap. In edit mode (preset from a staged line's "Modify") the
       modal must ALWAYS open — even when the item has no modifiers —
       so qty, the special-request note and the allergy flag stay
       editable; the shortcut would otherwise re-stage instantly and
       silently drop the preset's note/allergy. */
    if (!preset && !groups && !flatMods.length) { stageItem(item, [], qty, {}); return; }
    const groupHint = (g) => {
      const bits = [];
      if (g.required) bits.push('required');
      if (g.min_select > 1) bits.push('pick ≥ ' + g.min_select);
      if (g.max_select > 0) bits.push('up to ' + g.max_select);
      return bits.length ? ' <span class="muted small">· ' + bits.join(', ') + '</span>' : '';
    };
    const presetMod = (key) => !preset ? null
      : (preset.modifiers || []).find((m) => m.name === key) || null;
    const modRow = (o, gi, oi) => {
      const pm = preset
        ? (preset.modifiers || []).find((m) => (o.id != null && m.option_id === o.id) || m.name === o.name) || null
        : null;
      const on = preset ? !!pm : (o.is_default && o.active !== false);
      return '<label class="mod-row' + (o.active === false ? ' mod-86' : '') + '">' +
      '<input type="checkbox" data-g="' + gi + '" data-o="' + oi + '"' +
      (on && o.active !== false ? ' checked' : '') +
      (o.active === false ? ' disabled' : '') + '>' +
      '<span class="mn">' + esc(o.name) + (o.active === false ? ' <span class="pill held">86</span>' : '') + '</span>' +
      '<span class="mp">' + (o.price_delta_cents ? '+' + fmt(o.price_delta_cents) : 'incl.') + '</span></label>' +
      '<input class="mod-note-in" data-mn="' + gi + ':' + oi + '" maxlength="60" placeholder="Note for ' + esc(o.name) + ' (optional)"' +
      ' value="' + esc((pm && pm.note) || '') + '"' + (on ? '' : ' style="display:none"') + '>';
    };
    const groupsHtml = groups ? groups.map((g, gi) =>
      '<div class="mod-group" data-group="' + gi + '" data-parent-opt="' + (g.parent_option_id || '') + '">' +
      '<h4>' + esc(g.name) + groupHint(g) + '</h4>' +
      g.options.map((o, oi) => modRow(o, gi, oi)).join('') + '</div>').join('')
      : (flatMods.length ? '<h3>Modifiers</h3><div id="mod-list">' +
        flatMods.map((m, i) => {
          const pm = presetMod(m.name);
          const on = !!pm;
          return '<label class="mod-row"><input type="checkbox" data-mi="' + i + '"' + (on ? ' checked' : '') + '><span class="mn">' + esc(m.name) + '</span><span class="mp">+' + fmt(m.price_delta_cents) + '</span></label>' +
          '<input class="mod-note-in" data-fmn="' + i + '" maxlength="60" placeholder="Note for ' + esc(m.name) + ' (optional)" value="' + esc((pm && pm.note) || '') + '"' + (on ? '' : ' style="display:none"') + '>';
        }).join('') + '</div>' : '');
    const bd = openModal(
      '<h2>' + esc(item.name) + ' <span class="muted">· ' + fmt(item.price_cents) + '</span></h2>' +
      '<p class="muted small">Seat <span id="m-seat-note">' + mSeat + '</span>' + (isDrink(item, catName) ? ' · <span class="drink-tag">BAR</span> fires to bar on send' : '') + '</p>' +
      '<div class="field"><label>Quantity</label><div class="stepper"><button data-q="dec">−</button><span class="val" id="m-qty">' + qty + '</span><button data-q="inc">+</button></div></div>' +
      '<div class="field"><label>Seat</label><div class="stepper"><button data-sb="dec">−</button><span class="val" id="m-seat">' + mSeat + '</span><button data-sb="inc">+</button></div></div>' +
      '<div class="field"><label for="m-course">Course</label><select id="m-course">' +
      '<option value=""' + (startCourse ? '' : ' selected') + '>—</option>' +
      ME_COURSES.map((c) => '<option value="' + c + '"' + (startCourse === c ? ' selected' : '') + '>' + c + '</option>').join('') +
      '</select></div>' +
      groupsHtml +
      '<div class="field"><label for="m-note">Special request <span class="muted small">(optional, prints on the KDS ticket)</span></label>' +
      '<input type="text" id="m-note" maxlength="140" value="' + esc((preset && preset.note) || '') + '" placeholder="e.g. no onions, dressing on side" autocomplete="off"></div>' +
      '<div class="field"><label class="check-line"><input type="checkbox" id="m-allergy"' + (preset && preset.allergy ? ' checked' : '') + '> ⚠️ Allergy alert for this item</label>' +
      '<input type="text" id="m-allergy-detail" maxlength="140" value="' + esc((preset && preset.allergy_detail) || '') + '" placeholder="Allergy detail (optional)" autocomplete="off" style="' + (preset && preset.allergy ? '' : 'display:none;') + 'margin-top:6px"></div>' +
      '<div class="modal-actions"><button class="btn btn-ghost" data-x="cancel">Cancel</button>' +
      '<button class="btn btn-primary" data-x="add">' + (preset ? 'Save' : 'Add to order') + '</button></div>');
    $('[data-q="dec"]', bd).onclick = () => { qty = Math.max(1, qty - 1); delete $('#m-qty', bd).dataset.editing; $('#m-qty', bd).textContent = qty; };
    $('[data-q="inc"]', bd).onclick = () => { qty = Math.min(24, qty + 1); delete $('#m-qty', bd).dataset.editing; $('#m-qty', bd).textContent = qty; };
    /* Tap-to-type on the quantity — same local qty the steppers drive. */
    PO.tappableValue($('#m-qty', bd), { get: () => qty, min: 1, max: 24, label: 'Quantity',
      onApply: (n) => { qty = n; $('#m-qty', bd).textContent = n; } });
    /* Seat stepper + tap-to-type, driving the same local mSeat. The
       stepper clamps to the current guest count (a seat can't exist
       past it); a typed seat beyond it grows the check at Add time —
       the same grow-first rule the quick-bar typed seat uses. */
    const paintMSeat = () => {
      const el = $('#m-seat', bd); if (el) { delete el.dataset.editing; el.textContent = mSeat; }
      const sn = $('#m-seat-note', bd); if (sn) sn.textContent = mSeat;
    };
    $('[data-sb="dec"]', bd).onclick = () => { mSeat = Math.max(1, mSeat - 1); paintMSeat(); };
    $('[data-sb="inc"]', bd).onclick = () => { mSeat = Math.min(guests, mSeat + 1); paintMSeat(); };
    PO.tappableValue($('#m-seat', bd), { get: () => mSeat, min: 1, max: 24, label: 'Seat',
      onApply: (n) => { mSeat = n; paintMSeat(); } });
    $('#m-allergy', bd).onchange = (e) => { $('#m-allergy-detail', bd).style.display = e.target.checked ? 'block' : 'none'; };
    $('[data-x="cancel"]', bd).onclick = closeModal;
    // Show the per-modifier note field only while its modifier is checked;
    // nested groups appear only when their parent option is picked.
    const refreshModUI = () => {
      const checkedOpts = new Set($$('#mod-list input:checked, .mod-group input:checked', bd).map((c) =>
        c.dataset.g !== undefined ? 'g' + c.dataset.g + ':o' + c.dataset.o : 'f' + c.dataset.mi));
      $$('.mod-note-in', bd).forEach((inp) => {
        const key = inp.dataset.mn !== undefined ? 'g' + inp.dataset.mn.replace(':', ':o') : 'f' + inp.dataset.fmn;
        inp.style.display = checkedOpts.has(key) ? 'block' : 'none';
        if (inp.style.display === 'none') inp.value = '';
      });
      if (groups) {
        const pickedOptIds = new Set($$('.mod-group input:checked', bd).map((c) => {
          const g = groups[Number(c.dataset.g)];
          return g && g.options[Number(c.dataset.o)] ? g.options[Number(c.dataset.o)].id : null;
        }).filter(Boolean));
        $$('.mod-group[data-parent-opt]', bd).forEach((el) => {
          const pid = Number(el.dataset.parentOpt);
          el.style.display = (!pid || pickedOptIds.has(pid)) ? 'block' : 'none';
        });
      }
    };
    /* Single-pick groups (max_select === 1 — Temperature, Flavor, …)
       behave like radios: checking an option unchecks its siblings in
       the same group. Without this the pre-checked default stayed
       ticked next to the new pick and the pair tripped the group's
       own at-most-1 validation (or reached the server) until the user
       unticked the first by hand. Registered before refreshModUI so
       note fields and nested groups settle on the final state. */
    const enforceSinglePick = (e) => {
      const t = e.target;
      if (!groups || !t || !t.checked || !t.dataset || t.dataset.g === undefined) return;
      const g = groups[Number(t.dataset.g)];
      if (!g || Number(g.max_select) !== 1) return;
      $$('.mod-group input[data-g="' + t.dataset.g + '"]', bd).forEach((c) => {
        if (c !== t) c.checked = false;
      });
    };
    bd.addEventListener('change', enforceSinglePick);
    bd.addEventListener('change', refreshModUI);
    refreshModUI();
    $('[data-x="add"]', bd).onclick = async () => {
      let picked = [];
      if (groups) {
        // Validate required/min/max against VISIBLE (applicable) groups only.
        const pickedByGroup = groups.map(() => []);
        $$('.mod-group input:checked', bd).forEach((c) => {
          const gi = Number(c.dataset.g), oi = Number(c.dataset.o);
          const g = groups[gi], o = g.options[oi];
          if ($('.mod-group[data-group="' + gi + '"]', bd).style.display === 'none') return;
          const noteInp = $('.mod-note-in[data-mn="' + gi + ':' + oi + '"]', bd);
          const m = { name: o.name, price_delta_cents: o.price_delta_cents, option_id: o.id };
          const nt = noteInp && noteInp.value.trim();
          if (nt) m.note = nt.slice(0, 60);
          pickedByGroup[gi].push(m);
        });
        for (let gi = 0; gi < groups.length; gi++) {
          const g = groups[gi];
          if ($('.mod-group[data-group="' + gi + '"]', bd).style.display === 'none') continue;
          const n = pickedByGroup[gi].length;
          if (g.required && n === 0) { toast(g.name + ': please choose at least one', 'err'); return; }
          if (g.min_select > 0 && n < g.min_select) { toast(g.name + ': pick at least ' + g.min_select, 'err'); return; }
          if (g.max_select > 0 && n > g.max_select) { toast(g.name + ': at most ' + g.max_select, 'err'); return; }
        }
        picked = pickedByGroup.flat();
      } else {
        picked = $$('#mod-list input:checked', bd).map((c) => {
          const m = flatMods[Number(c.dataset.mi)];
          const o = { name: m.name, price_delta_cents: m.price_delta_cents };
          const noteInp = $('.mod-note-in[data-fmn="' + c.dataset.mi + '"]', bd);
          const nt = noteInp && noteInp.value.trim();
          if (nt) o.note = nt.slice(0, 60);
          return o;
        });
      }
      const note = $('#m-note', bd).value.trim().slice(0, 140) || null;
      const allergy = $('#m-allergy', bd).checked;
      const allergyDetail = allergy ? ($('#m-allergy-detail', bd).value.trim().slice(0, 140) || null) : null;
      const courseSel = $('#m-course', bd).value;
      const course = courseSel ? courseSel : null;
      /* A typed seat past the guest count grows the check first (the
         HOLD POST would 400 on seat > guest_count) — same rule as the
         quick-bar typed seat and the edit-modal save. If the grow
         fails, the modal stays open and nothing is staged. */
      if (mSeat > guests) {
        if (isOffline()) { toast('Adding a seat needs a connection — reconnect first', 'err'); return; }
        try {
          await api('/api/checks/' + realId(checkId), 'PATCH', { guest_count: mSeat });
          const v = await getCheckView(checkId).catch(() => null);
          if (v) { check = v.check; guests = check.guest_count || mSeat; }
          else guests = mSeat;
          paintGuests();
        } catch (e) { handleApiError(e); return; }
      }
      if (mSeat !== seat) setSeat(mSeat);
      closeModal();
      stageItem(item, picked, qty, { note, allergy, allergy_detail: allergyDetail, course });
    };
  }

  function stageItem(item, modifiers, qty, extra) {
    extra = extra || {};
    staged.push({
      temp_id: uid('st'), menu_item_id: item.id, name: item.name, price_cents: item.price_cents,
      seat, qty, modifiers,
      note: extra.note || null,
      allergy: !!extra.allergy,
      allergy_detail: extra.allergy_detail || null,
      /* Ring-time course: the add-modal pick when given, else the menu
         item default. Rides the staged line so HOLD/SEND NOW can post
         it — before this, a line course was whatever the menu default
         was until someone edited the held line. */
      course: extra.course !== undefined ? extra.course : (item.course || null),
      drink: isDrink(item, (menu.find((c) => String(c.id) === String(activeCat)) || {}).name),
    });
    saveStaged(checkId, staged);
    drawCart();
    toast(item.name + ' → Seat ' + seat);
  }

  function drawCart() {
    /* The seat strip's per-seat counts derive from the same staged + held
       lines the cart renders — repaint it on EVERY cart mutation (stage,
       quick-bar change, void, …), not just full renders, or the chips
       read stale until the next HOLD. */
    drawSeats();
    const bySeat = {};
    const seatNames = check.seat_names || {};
    staged.forEach((s) => { (bySeat[s.seat] = bySeat[s.seat] || []).push({ kind: 'staged', ref: s }); });
    (check.items || []).forEach((i) => { (bySeat[i.seat || 0] = bySeat[i.seat || 0] || []).push({ kind: 'held', ref: i }); });
    const seats = Object.keys(bySeat).map(Number).sort((a, b) => a - b);
    if (!seats.length) { cartBody.innerHTML = '<p class="muted small">Nothing ordered yet — pick a seat, then tap items.</p>'; return; }
    const toolsHtml = '<div class="cart-tools">' +
      '<button class="btn btn-sm' + (selectMode ? ' btn-primary' : ' btn-ghost') + '" id="sel-toggle" aria-pressed="' + selectMode + '">' +
      (selectMode ? '✓ Selecting' : '☰ Select') + '</button>' +
      '<span class="muted small">' + (selectMode ? 'Tick lines, then Move to seat…' : 'Tap a line for quick actions') + '</span></div>';
    cartBody.innerHTML = toolsHtml + seats.map((s) =>
      '<div class="seat-group"><div class="seat-name">' + (s ? 'Seat ' + s + (seatNames[s] ? ' · ' + esc(seatNames[s]) : '') : 'Unseated') + '</div>' +
      bySeat[s].map(({ kind, ref }) => {
        const pill = kind === 'staged' ? '<span class="pill staged">staged</span>'
          : ref.state === 'held' ? '<span class="pill held">held</span>' : '<span class="pill sent">sent</span>';
        const mods = (ref.modifiers || []).map((m) => esc(m.name) + (m.price_delta_cents ? ' (+' + fmt(m.price_delta_cents) + ')' : '') +
          (m.note ? ' <span class="mod-note">“' + esc(m.note) + '”</span>' : '')).join(', ');
        const unitCents = (ref.unit_price_cents != null ? ref.unit_price_cents : ref.price_cents) || 0;
        const lineTotal = unitCents * (ref.qty || 1) + (ref.modifiers || []).reduce((a, m) => a + (m.price_delta_cents || 0) * (ref.qty || 1), 0);
        /* Phase 3A (P0-2/NG-E): special request + allergy ride the cart line. */
        const noteHtml = ref.note ? '<span class="line-note">📝 ' + esc(ref.note) + '</span>' : '';
        /* The line's course rides the cart line too — it's picked at ring
           time now, so the server can see it without opening the editor. */
        const courseHtml = ref.course ? '<span class="mods course-tag">' + esc(ref.course) + '</span>' : '';
        const allergyHtml = ref.allergy ? '<span class="pill allergy">⚠️ allergy' + (ref.allergy_detail ? ' · ' + esc(ref.allergy_detail) : '') + '</span>' : '';
        /* Multi-select (Select toggle on): staged + held lines can be
           ticked for selective send / bulk seat moves. */
        const selKey = kind + ':' + (ref.temp_id || ref.id);
        const selBox = (selectMode && (kind === 'staged' || ref.state === 'held'))
          ? '<input type="checkbox" class="line-sel" data-sel="' + esc(selKey) + '" aria-label="Select line">'
          : '';
        const voidBtn = (kind === 'staged' || ref.state === 'held')
          ? '<button class="icon-btn" data-void="' + esc(String(ref.temp_id || ref.id)) + '" data-kind="' + kind + '" data-nm="' + esc(ref.name) + '" aria-label="Void item" title="Void">✕</button>'
          : (ref.state === 'sent'
            ? '<button class="icon-btn mgr-void" data-voidmgr="' + esc(String(ref.id)) + '" data-nm="' + esc(ref.name) + '" aria-label="Void sent item — manager approval required" title="Void (manager approval)">✕</button>'
            : '');
        /* Re-fire: one tap re-sends an already-fired line as a ↻ RE-FIRE
         * ticket (no more void + re-add dance). */
        const refireBtn = (kind === 'held' && (ref.state === 'sent' || ref.state === 'fulfilled'))
          ? '<button class="icon-btn" data-refire="' + esc(String(ref.id)) + '" data-nm="' + esc(ref.name) + '" aria-label="Re-fire item to kitchen" title="Re-fire to kitchen">↻</button>'
          : '';
        /* Phase 3A: edit held/fired items (fired need manager PIN) — the edit
           is audit-logged and highlighted on KDS. */
        const editBtn = (kind !== 'staged' && (ref.state === 'held' || ref.state === 'sent'))
          ? '<button class="icon-btn" data-edit="' + esc(String(ref.id)) + '" aria-label="Edit item" title="Edit item (fired items need manager PIN)">✎</button>'
          : '';
        /* Line summary segments join with a real space: the note and
           allergy spans are inline, so bare concatenation rendered them
           run together as one blob (note text fused to the allergy
           flag). Block segments (mods, course) ignore the extra space. */
        const nmSegs = [esc(ref.name) + (ref.qty > 1 ? ' <span class="qty">×' + ref.qty + '</span>' : '')];
        if (mods) nmSegs.push('<span class="mods">' + mods + '</span>');
        if (courseHtml) nmSegs.push(courseHtml);
        if (noteHtml) nmSegs.push(noteHtml);
        if (allergyHtml) nmSegs.push(allergyHtml);
        const lineHtml = '<div class="cart-line' + (quickKey === selKey ? ' qsel' : '') + '" data-line="' + esc(selKey) + '">' + selBox + '<div class="nm">' + nmSegs.join(' ') + '</div>' + pill +
          '<span class="pr">' + fmt(lineTotal) + '</span>' + editBtn + refireBtn + voidBtn + '</div>';
        /* Quick-action bar: tapping the line opens qty/seat steppers plus
           Repeat / Void / Modify directly under it — qty and seat apply in
           one tap via PATCH, no modal round-trip. */
        const quickHtml = quickKey === selKey
          ? PO.quickBarHtml({ qty: ref.qty || 1, seat: ref.seat || s, guestCount: guests, staged: kind === 'staged',
              course: ref.course != null ? ref.course : null,
              canCourse: kind === 'staged' || ref.state === 'held' })
          : '';
        return lineHtml + quickHtml;
      }).join('') + '</div>').join('') +
      /* Selection action bar — send selected lines, or move them all to
         one seat (chips, incl. "+ New seat") in a single action. */
      '<div class="sel-bar" id="sel-bar" style="display:none">' +
      '<span class="muted small" id="sel-count"></span>' +
      '<button class="btn btn-sm" id="sel-send">Send selected</button>' +
      '<button class="btn btn-sm" id="sel-move">Move to seat…</button>' +
      '<button class="btn btn-sm btn-ghost" id="sel-clear">Clear</button></div>';
    $$('[data-void]', cartBody).forEach((b) => b.onclick = () => {
      const id = b.dataset.void, kind = b.dataset.kind;
      if (kind === 'staged') {
        confirmDialog('Void item', 'Remove this item from the order? It was never sent anywhere.', 'Void item', async () => {
          staged = staged.filter((s) => s.temp_id !== id);
          saveStaged(checkId, staged);
          drawCart();
        });
      } else {
        openVoidApproval(id, b.dataset.nm);
      }
    });
    /* Sent items: same manager-approval modal. */
    $$('[data-voidmgr]', cartBody).forEach((b) => b.onclick = () => openVoidApproval(b.dataset.voidmgr, b.dataset.nm));
    /* Phase 3A: edit held/fired items — audit trail + highlighted KDS delta. */
    $$('[data-edit]', cartBody).forEach((b) => b.onclick = async () => {
      const it = (check.items || []).find((x) => String(x.id) === String(b.dataset.edit));
      if (it && await PO.openEditItemModal(check, it)) renderRoute(true);
    });
    /* Select toggle: the multi-select checkboxes render only in select
       mode, so the default cart stays clean for line tapping. */
    const selToggle = $('#sel-toggle', cartBody);
    if (selToggle) selToggle.onclick = () => {
      setSelectMode(!selectMode);
      if (selectMode) quickKey = null; // one interaction mode at a time
      drawCart();
    };
    /* Tap a line → its quick-action bar opens under it. Taps landing on the
       line's own buttons/checkboxes keep their existing behavior. */
    $$('.cart-line[data-line]', cartBody).forEach((el) => el.onclick = (e) => {
      if (e.target.closest('button, input, select, a')) return;
      quickKey = quickKey === el.dataset.line ? null : el.dataset.line;
      drawCart();
    });
    const findLine = (key) => {
      if (!key) return null;
      const ix = key.indexOf(':');
      const kind = key.slice(0, ix), id = key.slice(ix + 1);
      if (kind === 'staged') {
        const ref = staged.find((x) => String(x.temp_id) === id);
        return ref ? { kind, ref } : null;
      }
      const ref = (check.items || []).find((x) => String(x.id) === id);
      return ref ? { kind, ref } : null;
    };
    /* Staged "Modify": a staged line has no server row for the edit modal,
       so More reopens the guided add-item modifier flow on the same menu
       item — prefilled with the line's seat, qty, modifiers, note and
       allergy — and the staged entry is swapped for the flow's result.
       The modal can close via Cancel, backdrop tap, or Esc; whichever
       way it closes without staging a replacement, the original entry
       is restored untouched, so backing out never loses the line. */
    const restageStagedLine = (sref) => {
      let foundItem = null, foundCat = '';
      for (const c of menu) {
        const mi = (c.items || []).find((x) => String(x.id) === String(sref.menu_item_id));
        if (mi) { foundItem = mi; foundCat = c.name; break; }
      }
      if (!foundItem) { toast('That item is no longer on the menu — void it and re-ring it', 'err'); return; }
      const backup = sref;
      staged = staged.filter((s) => s.temp_id !== sref.temp_id);
      saveStaged(checkId, staged);
      quickKey = null;
      setSeat(sref.seat || seat);
      drawCart();
      const countAfterRemoval = staged.length;
      addItemFlow(foundItem, foundCat, {
        qty: sref.qty || 1,
        seat: sref.seat || seat,
        course: sref.course,
        modifiers: sref.modifiers || [],
        note: sref.note || '',
        allergy: !!sref.allergy,
        allergy_detail: sref.allergy_detail || '',
      });
      const root = $('#modal-root');
      const bdNode = root && root.firstChild;
      if (bdNode) {
        const obs = new MutationObserver(() => {
          if (bdNode.isConnected) return;
          obs.disconnect();
          if (staged.length === countAfterRemoval && !staged.some((s) => s.temp_id === backup.temp_id)) {
            staged.push(backup);
            saveStaged(checkId, staged);
            drawCart();
          }
        });
        obs.observe(root, { childList: true });
      }
    };
    /* Light refresh after a quick action: refetch the check, redraw seats +
       cart, repaint the header Pay total from the mutation response. No
       full route re-render — the tapped line and the selected seat stay
       exactly where the server left them. */
    const refreshAfterQuick = async (totals) => {
      try {
        const v = await getCheckView(checkId);
        check = v.check; guests = check.guest_count || guests;
      } catch (e) { /* keep the on-screen check; the next render resyncs */ }
      paintGuests();
      if (totals && totals.total != null) {
        const pl = $('.order-top a.btn-primary');
        if (pl) pl.textContent = 'Pay · ' + fmt(totals.total);
        const ot = $('#order-total');
        if (ot) ot.textContent = fmt(totals.total);
      }
      drawSeats(); drawCart();
    };
    const qb = $('[data-quickbar]', cartBody);
    if (qb) {
      const found = findLine(quickKey);
      if (!found) quickKey = null;
      else {
        const { kind, ref } = found;
        const fired = kind !== 'staged' && ref.state !== 'held';
        let busy = false;
        /* Fired lines: the API requires a manager PIN for edits, so qty /
           seat changes hand off to the full edit modal (the PIN lives
           there) instead of firing a request that would 403. Steppers,
           typed values, and the value spans all route through here. */
        const routeFired = async () => {
          toast('Fired item — manager approval needed', 'err');
          const it = (check.items || []).find((x) => String(x.id) === String(ref.id));
          if (it && await PO.openEditItemModal(check, it)) renderRoute(true);
        };
        const patchItem = async (patch) => {
          if (fired) { await routeFired(); return; }
          const r = await api('/api/checks/' + realId(checkId) + '/items/' + ref.id, 'PATCH', patch);
          await refreshAfterQuick(r && r.totals);
        };
        /* The apply paths shared by the steppers AND tap-to-type, so a
           typed value lands exactly like a tapped one. */
        const applyQtyVal = async (nq) => {
          if (nq === (ref.qty || 1)) return;
          if (kind === 'staged') { ref.qty = nq; saveStaged(checkId, staged); drawCart(); }
          else await patchItem({ qty: nq });
        };
        const applySeatVal = async (ns) => {
          if (ns === (ref.seat || 1)) return;
          if (ns > guests) {
            /* Typed seat past the current guest_count: grow the check
               first (the same PATCH the "+ Seat" chip uses), then move
               the line — refreshAfterQuick / drawSeats repaint guests. */
            if (isOffline()) { toast('Adding a seat needs a connection — reconnect first', 'err'); return; }
            await api('/api/checks/' + realId(checkId), 'PATCH', { guest_count: ns });
            if (kind === 'staged') {
              ref.seat = ns; saveStaged(checkId, staged);
              await refreshAfterQuick();
              return;
            }
          }
          if (kind === 'staged') { ref.seat = ns; saveStaged(checkId, staged); drawCart(); }
          else await patchItem({ seat: ns });
        };
        $$('[data-qa]', qb).forEach((b) => b.onclick = async () => {
          if (busy) return;
          busy = true;
          $$('button', qb).forEach((x) => { x.disabled = true; });
          try {
            const a = b.dataset.qa;
            if (a === 'qty-inc' || a === 'qty-dec') {
              const nq = Math.max(1, Math.min(24, (ref.qty || 1) + (a === 'qty-inc' ? 1 : -1)));
              await applyQtyVal(nq);
            } else if (a === 'seat-inc' || a === 'seat-dec') {
              const ns = Math.max(1, Math.min(guests, (ref.seat || 1) + (a === 'seat-inc' ? 1 : -1)));
              await applySeatVal(ns);
            } else if (a === 'repeat') {
              if (kind === 'staged') {
                staged.push(Object.assign({}, ref, { temp_id: uid('st'),
                  modifiers: (ref.modifiers || []).map((m) => Object.assign({}, m)) }));
                saveStaged(checkId, staged); drawCart();
                toast('Repeated — same line added again', 'ok');
              } else {
                const r = await api('/api/checks/' + realId(checkId) + '/items/' + ref.id + '/duplicate', 'POST', {});
                toast('Repeated — same line added again', 'ok');
                await refreshAfterQuick(r && r.totals);
              }
            } else if (a === 'void') {
              if (kind === 'staged') {
                confirmDialog('Void item', 'Remove this item from the order? It was never sent anywhere.', 'Void item', async () => {
                  staged = staged.filter((s) => s.temp_id !== ref.temp_id);
                  saveStaged(checkId, staged);
                  quickKey = null;
                  drawCart();
                });
              } else {
                openVoidApproval(ref.id, ref.name);
              }
            } else if (a === 'more') {
              if (kind === 'staged') {
                restageStagedLine(ref);
              } else {
                const it = (check.items || []).find((x) => String(x.id) === String(ref.id));
                if (it && await PO.openEditItemModal(check, it)) renderRoute(true);
              }
            }
          } catch (e) { handleApiError(e); }
          finally {
            busy = false;
            // If a redraw replaced the bar this closure is dead anyway;
            // otherwise (a modal was cancelled) restore the buttons. The
            // handlers clamp to the API bounds, so re-enabling is safe.
            if (qb.isConnected) $$('button', qb).forEach((x) => { x.disabled = false; });
          }
        });
        /* Tap-to-type on the bar's numbers: typing the exact qty / seat
           beats tapping + twelve times in a rush. Typed values run the
           same busy guard + apply paths as the steppers; on fired lines
           the numbers route to the PIN-carrying edit modal instead,
           exactly like the stepper taps do. */
        const typedRun = async (fn) => {
          if (busy) return;
          busy = true;
          $$('button', qb).forEach((x) => { x.disabled = true; });
          try { await fn(); } catch (e) { handleApiError(e); }
          finally {
            busy = false;
            if (qb.isConnected) $$('button', qb).forEach((x) => { x.disabled = false; });
          }
        };
        const qtyValEl = $('[data-qbval="qty"]', qb), seatValEl = $('[data-qbval="seat"]', qb);
        if (fired) {
          [qtyValEl, seatValEl].forEach((el) => {
            if (!el) return;
            el.classList.add('tappable');
            el.title = 'Tap to edit — manager approval needed';
            el.onclick = () => typedRun(routeFired);
          });
        } else {
          if (qtyValEl) PO.tappableValue(qtyValEl, { get: () => ref.qty || 1, min: 1, max: 24, label: 'Quantity',
            onApply: (n) => typedRun(() => applyQtyVal(n)) });
          if (seatValEl) PO.tappableValue(seatValEl, { get: () => ref.seat || 1, min: 1, max: 24, label: 'Seat',
            onApply: (n) => typedRun(() => applySeatVal(n)) });
        }
        /* Course pills: one tap re-courses the line. Staged lines update
           in place (local state + persisted staged storage — no server
           round-trip until HOLD posts the course); held lines go through
           the same PATCH the edit modal uses. Fired lines render no
           pills — their edits stay behind the manager PIN in the modal. */
        $$('[data-qc]', qb).forEach((b) => b.onclick = () => {
          const c = b.dataset.qc || null;
          if (!c || (ref.course || null) === c) return;
          if (kind === 'staged') { ref.course = c; saveStaged(checkId, staged); drawCart(); }
          else typedRun(() => patchItem({ course: c }));
        });
      }
    }
    /* Phase 3A (P0-3/NG-C): line selection — selective send + item-first
       seat assignment ("start with the items and choose who it's for"). */
    const selBar = $('#sel-bar', cartBody), selCount = $('#sel-count', cartBody);
    const selectedKeys = () => $$('.line-sel:checked', cartBody).map((c) => c.dataset.sel);
    const refreshSel = () => {
      const n = selectedKeys().length;
      selBar.style.display = n ? 'flex' : 'none';
      selCount.textContent = n + ' selected';
    };
    $$('.line-sel', cartBody).forEach((c) => c.onchange = refreshSel);
    $('#sel-clear', cartBody).onclick = () => { $$('.line-sel:checked', cartBody).forEach((c) => { c.checked = false; }); refreshSel(); };
    $('#sel-send', cartBody).onclick = async () => {
      const heldIds = selectedKeys().filter((k) => k.startsWith('held:')).map((k) => Number(k.slice(5)));
      if (!heldIds.length) { toast('Select held lines to send (staged lines need HOLD first)', 'err'); return; }
      try {
        if (isOffline()) { toast('Selective send needs a connection — reconnect first', 'err'); return; }
        const r = await api('/api/checks/' + realId(checkId) + '/send', 'POST', { item_ids: heldIds });
        toast('Sent ' + (r.sent || 0) + ' line' + ((r.sent || 0) === 1 ? '' : 's'), 'ok');
      } catch (e) { handleApiError(e); }
      renderRoute(true);
    };
    /* Bulk move: seat chips (incl. "+ New seat") replace the old stepper
       modal. Moves run line-by-line over the same PATCH endpoint as the
       quick bar; every failure is counted and reported, never swallowed. */
    $('#sel-move', cartBody).onclick = async () => {
      const keys = selectedKeys();
      if (!keys.length) return;
      const counts = PO.countLinesBySeat(
        staged.concat((check.items || []).filter((i) => ['held', 'sent', 'fulfilled'].includes(i.state))));
      const target = await PO.openMoveToSeatPicker({ guestCount: guests, seatNames: check.seat_names || {}, counts, count: keys.length });
      if (target === null) return;
      let toSeat = target;
      if (target === 'new') {
        if (isOffline()) { toast('Adding a seat needs a connection — reconnect first', 'err'); return; }
        try {
          await api('/api/checks/' + realId(checkId), 'PATCH', { guest_count: guests + 1 });
          const v = await getCheckView(checkId);
          check = v.check; guests = check.guest_count || guests + 1;
          toSeat = guests;
        } catch (e) { handleApiError(e); return; }
      }
      let moved = 0, already = 0; const failures = [];
      for (const k of keys) {
        const ix = k.indexOf(':');
        const kind = k.slice(0, ix), id = k.slice(ix + 1);
        if (kind === 'staged') {
          const s = staged.find((x) => String(x.temp_id) === id);
          if (s) {
            /* Already on the target seat: not a move, not a failure. */
            if ((s.seat || 1) === toSeat) already++;
            else { s.seat = toSeat; moved++; }
          }
        } else {
          const cur = (check.items || []).find((x) => String(x.id) === id);
          if (cur && (cur.seat || 1) === toSeat) { already++; continue; }
          try {
            await api('/api/checks/' + realId(checkId) + '/items/' + id, 'PATCH', { seat: toSeat });
            moved++;
          } catch (e) { failures.push(e); }
        }
      }
      saveStaged(checkId, staged);
      if (failures.length) {
        const why = (failures[0] && (failures[0].message || failures[0].error)) || 'error';
        toast('Moved ' + moved + ' of ' + (moved + failures.length) + ' lines → Seat ' + toSeat + ' — ' + failures.length + ' failed (' + why + ')' +
          (already ? ' · ' + already + ' already on Seat ' + toSeat : ''), 'err');
      } else {
        const parts = [];
        if (moved) parts.push('Moved ' + moved + ' line' + (moved === 1 ? '' : 's') + ' → Seat ' + toSeat);
        if (already) parts.push(already + ' already on Seat ' + toSeat);
        toast(parts.join(' · ') || 'Nothing to move', 'ok');
      }
      renderRoute(true);
    };
    /* Re-fire: confirm, then POST — the kitchen gets a flagged RE-FIRE ticket. */
    $$('[data-refire]', cartBody).forEach((b) => b.onclick = () => {
      confirmDialog('Re-fire item',
        'Send <b>' + esc(b.dataset.nm || 'item') + '</b> to the kitchen again? It arrives as a <b>↻ RE-FIRE</b> ticket — flagged as a reprint, not a new make.',
        'Re-fire', async () => {
          try {
            if (isOffline()) { toast('Re-fire needs a connection — reconnect first', 'err'); return; }
            const r = await api('/api/checks/' + realId(checkId) + '/items/' + b.dataset.refire + '/refire', 'POST');
            toast('Re-fired ↻ ' + esc((r.ticket && r.ticket.station) || 'kitchen'), 'ok');
          } catch (e) { handleApiError(e); }
        });
    });
  }

  /* Manager-approved void (held or sent): the manager enters their PIN at
     the device; the approval is audit-logged server-side. Offline, the PIN
     is NOT stored — the queued op carries sha256(PIN) + a one-time nonce,
     which the server binds to (check, item) on first use (no replay/forge). */
  function openVoidApproval(itemId, itemName) {
    const bd = openModal('<h2>Void item</h2>' +
      '<p class="muted">Void <b>' + esc(itemName || 'item') + '</b>? A manager\'s approval is required — the void is audit-logged.</p>' +
      '<label class="fld">Reason <input id="vm-reason" maxlength="120" placeholder="e.g. wrong seat"></label>' +
      '<label class="fld">Manager PIN <input id="vm-pin" inputmode="numeric" maxlength="4" placeholder="••••" style="max-width:140px"></label>' +
      '<div class="modal-actions"><button class="btn btn-ghost" data-x="c">Cancel</button>' +
      '<button class="btn btn-danger" data-x="go">Void item</button></div>');
    $('[data-x="c"]', bd).onclick = closeModal;
    $('[data-x="go"]', bd).onclick = async () => {
      const pin = $('#vm-pin', bd).value.trim();
      if (!/^\d{4}$/.test(pin)) { toast('Enter the manager\'s 4-digit PIN', 'err'); return; }
      const reason = $('#vm-reason', bd).value.trim() || undefined;
      closeModal();
      await voidApprovedItem(checkId, itemId, pin, reason);
      renderRoute(true);
    };
  }

  async function voidApprovedItem(cid, itemId, managerPin, reason) {
    try {
      if (isOffline()) {
        // if the item is itself a pending offline add, absorb the void into that op
        const ops = await Outbox.forCheck(realId(cid));
        let absorbed = false;
        for (const o of ops) {
          if (o.op === 'add_items') {
            const items = (o.payload.items || []).filter((it) => String(it.temp_id) !== String(itemId));
            if (items.length !== (o.payload.items || []).length) {
              absorbed = true;
              if (!items.length) await Outbox.remove(o.key);
              else { o.payload.items = items; await Outbox.update(o); }
              break;
            }
          }
        }
        if (!absorbed) {
          if (!window.crypto || !crypto.subtle || !crypto.getRandomValues) {
            toast('Offline void needs a secure context — reconnect to void', 'err');
            return;
          }
          // Store approval as sha256(PIN) + one-time nonce — never the raw PIN.
          const payload = { check_id: realId(cid), item_id: itemId, reason,
            manager_pin_hash: await sha256Hex(managerPin), approval_nonce: randomNonce() };
          await Outbox.enqueue('void_item', payload);
        }
        toast('Void queued — manager approval syncs on reconnect', 'ok');
      } else {
        await api('/api/checks/' + realId(cid) + '/void-item', 'POST', { item_id: Number(itemId), manager_pin: managerPin, reason });
        toast('Item voided — manager approved', 'ok');
      }
    } catch (e) { handleApiError(e); }
  }

  $('#btn-hold').onclick = async () => {
    if (!staged.length) { toast('Nothing staged — tap menu items first'); return; }
    const items = staged.map((s) => {
      const it = { temp_id: s.temp_id, menu_item_id: s.menu_item_id, name: s.name, price_cents: s.price_cents, seat: s.seat, qty: s.qty, modifiers: s.modifiers,
        note: s.note || null, allergy: !!s.allergy, allergy_detail: s.allergy_detail || null };
      /* The ring-time course rides along when the staged line carries
         one (post-change lines always do). Legacy staged lines without
         the key omit it, so the server keeps applying the menu default
         for them exactly as before. */
      if (s.course !== undefined) it.course = s.course;
      return it;
    });
    /* Staged lines are removed ONLY as they are confirmed. The old shape
       cleared the list up front, so one rejected POST (e.g. a required
       modifier group the client menu never showed) destroyed the whole
       half-built order — data loss on a validation error. */
    try {
      if (isOffline()) {
        if (String(checkId).startsWith('tmp-')) {
          const d = JSON.parse(localStorage.getItem('expoline.draft:' + checkId));
          items.forEach((it) => {
            const dItem = { id: it.temp_id, menu_item_id: it.menu_item_id, name: it.name, price_cents: it.price_cents, seat: it.seat, qty: it.qty, modifiers: it.modifiers,
              note: it.note || null, allergy: !!it.allergy, allergy_detail: it.allergy_detail || null, state: 'held' };
            if (it.course !== undefined) dItem.course = it.course;
            d.items.push(dItem);
          });
          localStorage.setItem('expoline.draft:' + checkId, JSON.stringify(d));
        }
        try {
          await Outbox.enqueue('add_items', { check_id: realId(checkId), items });
        } catch (e) {
          /* Queue write failed after the draft absorbed the lines: back
             them out of the draft so a retry cannot double them, and keep
             the staged list untouched. */
          if (String(checkId).startsWith('tmp-')) {
            try {
              const d2 = JSON.parse(localStorage.getItem('expoline.draft:' + checkId));
              d2.items = d2.items.filter((x) => !items.some((it) => it.temp_id === x.id));
              localStorage.setItem('expoline.draft:' + checkId, JSON.stringify(d2));
            } catch (e2) { /* best effort */ }
          }
          throw e;
        }
        staged = []; saveStaged(checkId, staged);
        toast('Held offline — will sync', 'ok');
      } else {
        const rid = realId(checkId);
        const heldIds = new Set();
        let failure = null;
        let failLine = null;
        for (const it of items) {
          try {
            const body = { menu_item_id: it.menu_item_id, seat: it.seat, qty: it.qty, modifiers: it.modifiers,
              note: it.note || null, allergy: !!it.allergy, allergy_detail: it.allergy_detail || null };
            if (it.course !== undefined) body.course = it.course;
            await api('/api/checks/' + rid + '/items', 'POST', body);
            heldIds.add(it.temp_id);
          } catch (e) { failure = e; failLine = it; break; }
        }
        staged = staged.filter((s) => !heldIds.has(s.temp_id));
        saveStaged(checkId, staged);
        if (!failure) {
          toast(items.length + (items.length === 1 ? ' item' : ' items') + ' held', 'ok');
        } else if (failure instanceof ApiError && (failure.status === 401 || failure.status === 403)) {
          handleApiError(failure);
        } else {
          /* Name the ONE line the server actually rejected. Lines after
             it were never attempted — they are still staged, not in need
             of attention. (The old toast counted every remaining staged
             line as bad and named none: one flavorless Edamame in a
             five-line order read as "5 need attention".) */
          const nm = failLine ? (failLine.name + (failLine.seat ? ' (Seat ' + failLine.seat + ')' : '')) : 'One line';
          const rest = staged.length - (failLine ? 1 : 0);
          toast((heldIds.size ? heldIds.size + ' held · ' : '') + nm + ' needs attention: ' + (failure.message || 'request failed') +
            (rest > 0 ? ' · ' + rest + ' more line' + (rest === 1 ? '' : 's') + ' still staged' : ''), 'err');
        }
      }
    } catch (e) { handleApiError(e); }
    renderRoute(true);
  };

  $('#btn-send').onclick = async () => {
    if (staged.length) { toast('Tap HOLD first to add staged items', 'err'); return; }
    const heldCount = (check.items || []).filter((i) => i.state === 'held').length;
    if (!heldCount) { toast('Nothing held to send'); return; }
    const doSend = async (extra) => {
      try {
        if (isOffline()) {
          if (String(checkId).startsWith('tmp-')) {
            const d = JSON.parse(localStorage.getItem('expoline.draft:' + checkId));
            d.items.forEach((i) => { if (i.state === 'held') i.state = 'sent'; });
            localStorage.setItem('expoline.draft:' + checkId, JSON.stringify(d));
          }
          await Outbox.enqueue('send', { check_id: realId(checkId) });
          toast('Send queued — fires on reconnect', 'ok');
        } else {
          await api('/api/checks/' + realId(checkId) + '/send', 'POST', extra || undefined);
          toast('Sent to kitchen & bar', 'ok');
        }
      } catch (e) {
        /* Phase 3A (P0-7): coursing prompt — the check fires by course, so
           ask which course(s) to fire (or all, when optional). */
        if (e instanceof ApiError && e.status === 409 && e.body && e.body.need_course_selection) {
          const courses = e.body.courses || [];
          const bd = openModal('<h2>Fire by course</h2><p class="muted">This check fires one course at a time. Choose what to send now.</p>' +
            '<div class="checkbox-list">' + courses.map((c) =>
              '<label><input type="checkbox" data-sc="' + esc(c) + '" checked><span style="flex:1;text-transform:capitalize">' + esc(c) + '</span></label>').join('') + '</div>' +
            '<div class="modal-actions"><button class="btn btn-ghost" data-x="c">Cancel</button>' +
            (e.body.optional ? '<button class="btn" data-x="all">Send all</button>' : '') +
            '<button class="btn btn-primary" data-x="go">Fire selected</button></div>');
          $('[data-x="c"]', bd).onclick = closeModal;
          const go = (list) => { closeModal(); doSend({ courses: list }); };
          if (e.body.optional) $('[data-x="all"]', bd).onclick = () => go(['all']);
          $('[data-x="go"]', bd).onclick = () => {
            const sel = $$('[data-sc]:checked', bd).map((c) => c.dataset.sc);
            if (!sel.length) { toast('Pick at least one course', 'err'); return; }
            go(sel);
          };
          return;
        }
        handleApiError(e); return;
      }
      renderRoute(true);
    };
    await doSend();
  };

  /* Phase 3A (P0-4): SEND NOW — one-tap add+fire. Staged lines go on the
     check and straight to the KDS in a single atomic call. */
  $('#btn-sendnow').onclick = async () => {
    if (!staged.length) { toast('Nothing staged — tap menu items first'); return; }
    /* Staged lines clear ONLY after the server confirms the send-now call.
       The old shape cleared the list before even the offline check, so an
       offline SEND NOW (or one rejected POST) silently discarded the whole
       order behind a toast. */
    if (isOffline()) { toast('Send-now needs a connection — reconnect first', 'err'); return; }
    const items = staged.map((s) => {
      const it = { menu_item_id: s.menu_item_id, seat: s.seat, qty: s.qty, modifiers: s.modifiers,
        note: s.note || null, allergy: !!s.allergy, allergy_detail: s.allergy_detail || null };
      if (s.course !== undefined) it.course = s.course;
      return it;
    });
    try {
      const r = await api('/api/checks/' + realId(checkId) + '/send-now', 'POST', { items });
      staged = []; saveStaged(checkId, staged);
      toast('Sent now — ' + (r.sent || 0) + ' line' + ((r.sent || 0) === 1 ? '' : 's') + ' fired', 'ok');
    } catch (e) {
      /* A rejected line is named, not just described: the server tags a
         per-line validation failure with its line index, so the toast
         can point at the exact staged line the kitchen never got. */
      const li = (e instanceof ApiError && e.body && Number.isInteger(e.body.line_index)) ? e.body.line_index : -1;
      const bad = li >= 0 ? staged[li] : null;
      if (bad && e.status === 400) {
        toast(bad.name + (bad.seat ? ' (Seat ' + bad.seat + ')' : '') + ' needs attention: ' + (e.message || 'request failed'), 'err');
      } else handleApiError(e);
    }
    renderRoute(true);
  };

  /* Live menu: when a manager edits the menu or 86s an item, every open
     order screen refetches and redraws — no manual refresh, no stale items. */
  let menuWs = null;
  function menuWatch() {
    if (isOffline()) return;
    const tok = sessionStorage.getItem('expoline.token');
    if (!tok) return;
    try { menuWs = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws?token=' + encodeURIComponent(tok)); }
    catch (e) { return; }
    menuWs.onopen = () => { try { menuWs.send(JSON.stringify({ action: 'subscribe', channel: 'menu' })); } catch (e) {} };
    menuWs.onmessage = async (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (!msg || msg.type !== 'menu_updated') return;
      try {
        menu = await getMenu();
        if (!visibleMenu().some((c) => String(c.id) === String(activeCat))) {
          const vmw = visibleMenu();
          activeCat = vmw.length ? vmw[0].id : null;
        }
        drawCats(); drawItems();
        toast('Menu updated', 'ok');
      } catch (e) { /* keep the old menu on screen */ }
    };
    menuWs.onclose = () => { menuWs = null; };
    menuWs.onerror = () => { try { menuWs.close(); } catch (e) {} };
  }
  menuWatch();
  app._cleanup = () => { if (menuWs) { try { menuWs.close(); } catch (e) {} menuWs = null; } };

  /* Menu must ALWAYS render — even if the API failed, show the empty state
     with a retry button instead of a blank screen (2026-09-26: Daniel caught
     a blank menu on the public demo that API-only QA never caught). */
  const vm0 = visibleMenu();
  activeCat = vm0.length ? vm0[0].id : null;
  drawCats(); drawItems();
  /* Synchronized course-fire timing: load schedule, render fire buttons. */
  const loadFireSchedule = async () => {
    const card = $('#course-fire-card'), body = $('#course-fire-body');
    if (!card || !body) return;
    try {
      const s = await api('/api/checks/' + encodeURIComponent(checkId) + '/fire-schedule');
      if (!s.schedule.length && !s.fired.length) { card.style.display = 'none'; return; }
      card.style.display = '';
      const fmtTime = (iso) => { const d = new Date(iso); return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); };
      const now = Date.now();
      let html = '';
      if (s.fired.length) html += '<p class="small muted">Fired: ' + s.fired.map((f) => esc(f.course) + ' ' + fmtTime(f.fired_at)).join(', ') + '</p>';
      if (s.schedule.length) {
        /* Course order is enforced server-side: only the first scheduled
           course can fire — later ones wait until earlier held courses fire.
           Show them disabled with the reason instead of letting the tap 409. */
        html += '<div class="fire-schedule">' + s.schedule.map((it, i) => {
          const fireMs = new Date(it.fire_at).getTime();
          const mins = Math.max(0, Math.round((fireMs - now) / 60000));
          const due = fireMs <= now + 60000;
          const blockedBy = i > 0 ? s.schedule[0].course : null;
          const btn = blockedBy
            ? '<button class="btn btn-sm btn-ghost" disabled title="Fire ' + esc(blockedBy) + ' first">waiting on ' + esc(blockedBy) + '</button>'
            : '<button class="btn btn-sm ' + (due ? 'btn-amber' : 'btn-ghost') + '" data-fire-course="' + esc(it.course) + '">' + (due ? '🔥 FIRE NOW' : 'Fire') + '</button>';
          return '<div class="fire-row' + (due && !blockedBy ? ' fire-due' : '') + '"><span><b>' + esc(it.course) + '</b> <span class="muted small">~' + fmtTime(it.fire_at) + (mins > 0 ? ' (' + mins + 'm)' : ' (now)') + '</span></span>' + btn + '</div>';
        }).join('') + '</div>';
      } else {
        html += '<p class="small muted">All courses fired.</p>';
      }
      body.innerHTML = html;
      body.querySelectorAll('[data-fire-course]').forEach((b) => b.onclick = async () => {
        b.disabled = true;
        try { await api('/api/checks/' + encodeURIComponent(checkId) + '/fire-course', 'POST', { course: b.dataset.fireCourse }); }
        catch (e) { handleApiError(e); b.disabled = false; return; }
        toast('Fired ' + b.dataset.fireCourse + ' to KDS', 'ok');
        /* Re-render the whole order view so item badges flip HELD -> SENT
           and the fire schedule recomputes (same as HOLD does). */
        renderRoute(true);
      });
    } catch (e) { /* offline: hide card */ card.style.display = 'none'; }
  };
  loadFireSchedule();
  if (!menu.length) {
    itemGrid.innerHTML = '<div class="empty"><p>No menu loaded.</p>' +
      '<button class="btn btn-primary" id="menu-retry">Retry loading menu</button></div>';
    $('#menu-retry').onclick = async () => {
      try { menu = await getMenu(); } catch (e) { handleApiError(e); return; }
      const vm = visibleMenu();
      activeCat = vm.length ? vm[0].id : null;
      drawCats(); drawItems();
    };
  }
  drawSeats(); drawCart();
  $('#dp-pill').onclick = () => PO.openDaypartPicker(dpInfo, dpOverride, (v) => {
    dpOverride = v;
    try { sessionStorage.setItem('expoline.daypartOverride', v); } catch (e) {}
    renderRoute(true);
  });
  $('#seat-rename').onclick = () => renameSeat(seat);
  /* Phase 3A (NG-D): quick-pick row — one-tap popular items across all
     visible categories. Hidden when nothing is flagged popular. */
  const drawQuickPick = () => {
    const qp = $('#quick-pick');
    const picks = [];
    visibleMenu().forEach((c) => (c.items || []).forEach((i) => { if (i.popular) picks.push({ item: i, cat: c.name }); }));
    if (!picks.length) { qp.style.display = 'none'; qp.innerHTML = ''; return; }
    qp.style.display = 'flex';
    qp.innerHTML = '<span class="qp-label">★ Quick pick</span>' + picks.map((p) =>
      '<button class="item-card qp-card" data-qp="' + esc(String(p.item.id)) + '">' +
      '<span class="nm">' + esc(p.item.name) + '</span><span class="pr">' + fmt(p.item.price_cents) + '</span></button>').join('');
    $$('.qp-card', qp).forEach((b) => b.onclick = () => {
      const p = picks.find((x) => String(x.item.id) === b.dataset.qp);
      if (p) addItemFlow(p.item, p.cat);
    });
  };
  drawQuickPick();
  /* Phase 3A (P1-3/NG-E/NG-B): check settings — guest count, tab name,
     coursing mode, order-level note, and manager-gated full-check void. */
  $('#check-settings').onclick = () => {
    let gc = check.guest_count || 2, coursing = check.coursing || 'off';
    const bd = openModal('<h2>Check settings</h2>' +
      '<div class="field"><label>Guests</label><div class="stepper"><button data-gc="dec">−</button><span class="val" id="cs-gc">' + gc + '</span><button data-gc="inc">+</button></div></div>' +
      '<div class="field"><label for="cs-tab">Tab name <span class="muted small">(optional)</span></label>' +
      '<input type="text" id="cs-tab" maxlength="40" value="' + esc(check.tab_name || '') + '" placeholder="e.g. Daniel" autocomplete="off"></div>' +
      '<div class="field"><label for="cs-coursing">Firing</label><select id="cs-coursing">' +
      ['off', 'optional', 'required'].map((c) => '<option value="' + c + '"' + (coursing === c ? ' selected' : '') + '>' +
        (c === 'off' ? 'Off — send fires everything' : c === 'optional' ? 'By course — prompt, can send all' : 'By course — must pick a course') + '</option>').join('') +
      '</select></div>' +
      '<div class="field"><label for="cs-note">Order note <span class="muted small">(whole check — prints on every KDS ticket)</span></label>' +
      '<input type="text" id="cs-note" maxlength="500" value="' + esc(check.order_note || '') + '" placeholder="e.g. allergy table — confirm with server" autocomplete="off"></div>' +
      '<div class="modal-actions"><button class="btn btn-ghost" data-x="c">Cancel</button>' +
      '<button class="btn btn-danger" id="cs-void" title="Void the entire check — manager approval required">Void check…</button>' +
      '<button class="btn btn-primary" data-x="go">Save</button></div>');
    $('[data-gc="dec"]', bd).onclick = () => { gc = Math.max(1, gc - 1); $('#cs-gc', bd).textContent = gc; };
    $('[data-gc="inc"]', bd).onclick = () => { gc = Math.min(24, gc + 1); $('#cs-gc', bd).textContent = gc; };
    /* Tap the number to type the guest count (WS-B) — same local gc the
       steppers drive; Save PATCHes it exactly as before. */
    PO.tappableValue($('#cs-gc', bd), { get: () => gc, min: 1, max: 24, label: 'Guests',
      onApply: (n) => { gc = n; $('#cs-gc', bd).textContent = n; } });
    $('[data-x="c"]', bd).onclick = closeModal;
    $('[data-x="go"]', bd).onclick = async () => {
      const body = { guest_count: gc, tab_name: $('#cs-tab', bd).value.trim() || null,
        coursing: $('#cs-coursing', bd).value, order_note: $('#cs-note', bd).value.trim() || null };
      try {
        await api('/api/checks/' + realId(checkId), 'PATCH', body);
        closeModal(); toast('Check updated', 'ok');
      } catch (e) { handleApiError(e); return; }
      renderRoute(true);
    };
    /* NG-B: full-check void — manager role direct, servers enter a PIN. */
    $('#cs-void', bd).onclick = () => {
      const needPin = state.user.role !== 'manager';
      const b2 = openModal('<h2>Void entire check</h2>' +
        '<p class="muted">Void <b>every line</b> on this check? Fired lines send cancellation notices to the KDS. This is audit-logged and cannot be undone.</p>' +
        '<div class="field"><label for="vc-reason">Reason (required)</label>' +
        '<input type="text" id="vc-reason" maxlength="120" placeholder="e.g. walked out" autocomplete="off"></div>' +
        (needPin ? '<div class="field"><label for="vc-pin">Manager PIN</label>' +
          '<input type="password" id="vc-pin" inputmode="numeric" maxlength="4" placeholder="••••" style="max-width:140px" autocomplete="off"></div>' : '') +
        '<div class="modal-actions"><button class="btn btn-ghost" data-x="c">Cancel</button>' +
        '<button class="btn btn-danger" data-x="go">Void check</button></div>');
      $('[data-x="c"]', b2).onclick = () => { closeModal(); };
      $('[data-x="go"]', b2).onclick = async () => {
        const reason = $('#vc-reason', b2).value.trim();
        if (!reason) { toast('A reason is required to void a check', 'err'); return; }
        const body = { reason };
        if (needPin) {
          const pin = $('#vc-pin', b2).value.trim();
          if (!/^\d{4}$/.test(pin)) { toast("Enter the manager's 4-digit PIN", 'err'); return; }
          body.manager_pin = pin;
        }
        try {
          if (isOffline()) { toast('Voiding a check needs a connection — reconnect first', 'err'); return; }
          const r = await api('/api/checks/' + realId(checkId) + '/void', 'POST', body);
          closeModal(); closeModal();
          toast('Check voided — ' + r.voided_items + ' line(s) voided', 'ok');
          location.hash = '#/floor';
        } catch (e) { handleApiError(e); }
      };
    };
  };
  if (!document.getElementById('order-layout-css')) {
    const layout = document.createElement('style');
    layout.id = 'order-layout-css';
    layout.textContent = '@media(min-width:1000px){.order-layout{display:grid;grid-template-columns:1fr 380px;gap:20px;align-items:start}.order-layout .cart-panel{margin-top:0;position:sticky;top:70px}}';
    document.head.appendChild(layout);
  }
}

/* ============================================================
   VIEW: KDS (kitchen + manager). Servers see "not authorized".
   Live tickets via WS /ws?token=, subscribe {action:'subscribe',
   channel:'kds', station}. Timers tick every second.
   ============================================================ */
const KDS_STATIONS = [
  { label: 'Expediter', slug: 'expediter' },
  { label: 'Garde Manger', slug: 'garde_manger' },
  { label: 'Dessert', slug: 'dessert' },
  { label: 'Bar', slug: 'bar' },
];
function kdsLabel(slug) {
  const s = KDS_STATIONS.find((x) => x.slug === slug);
  return s ? s.label : slug;
}

/* Socket-only close: used when (re)subscribing so the 1s timer and 20s
 * alert intervals survive. Full cleanup (socket + timers) stays in
 * closeKdsSocket() for route exit / logout.
 * Reconnect audit: closing an old socket fires its onclose asynchronously,
 * and that stale handler used to schedule ANOTHER kdsSubscribe() after the
 * new socket was already live (duplicate subscribe churn). closeKdsWs now
 * detaches the old socket's handlers BEFORE closing and bumps a generation
 * counter; the down() retry only resubscribes when its generation is still
 * current. */
function closeKdsWs() {
  state.kds.gen = (state.kds.gen || 0) + 1;
  if (state.kds.ws) {
    try {
      state.kds.ws.onopen = state.kds.ws.onmessage = state.kds.ws.onerror = state.kds.ws.onclose = null;
      state.kds.ws.close();
    } catch (e) {}
    state.kds.ws = null;
  }
  state.kds.wsUp = false;
}
function closeKdsSocket() {
  closeKdsWs();
  if (state.timers.kds) { clearInterval(state.timers.kds); state.timers.kds = null; }
  if (state.timers.kdsAlerts) { clearInterval(state.timers.kdsAlerts); state.timers.kdsAlerts = null; }
}

function kdsElapsed(ts) {
  const s = Math.max(0, Math.floor((Date.now() - new Date(ts).getTime()) / 1000));
  return { s, mmss: pad2(Math.floor(s / 60)) + ':' + pad2(s % 60) };
}

/* Aging band for a ticket: thresholds come from /api/kds/settings (manager-
 * configurable, site_config data). 'aging_soon' is the BEFORE-breach alert
 * window — the line sees the warning while there's still time to act. */
function kdsBand(elapsedS) {
  const th = state.kds.thresholds || { warn_secs: 600, late_secs: 1200, alert_lead_secs: 240 };
  if (elapsedS >= th.late_secs) return 'overdue';
  if (elapsedS >= th.warn_secs) return 'aging';
  if (elapsedS >= th.warn_secs - th.alert_lead_secs) return 'aging_soon';
  return 'fresh';
}
function kdsWarnIn(elapsedS) {
  const th = state.kds.thresholds || { warn_secs: 600, late_secs: 1200, alert_lead_secs: 240 };
  return Math.max(0, th.warn_secs - elapsedS);
}

async function renderKds(app) {
  if (state.user.role === 'server') { app.innerHTML = notAuthorized('The kitchen display is for kitchen and manager roles.'); return; }
  closeKdsSocket();
  state.kds.recall = false;
  state.kds.tickets = [];
  state.kds.thresholds = null;
  try {
    const s = await api('/api/kds/settings');
    state.kds.thresholds = (s && s.thresholds) || null;
  } catch (e) { /* defaults */ }

  app.innerHTML =
    '<div class="kds-root" id="kds-root">' +
    '<div class="view-head"><h1>Kitchen Display</h1><span class="spacer"></span>' +
    '<span class="kds-ws" id="kds-ws"><span class="dot-dead"></span>connecting…</span> ' +
    '<button class="btn btn-ghost" id="kds-recall-btn">Recall</button>' +
    '<button class="btn btn-ghost" id="kds-tv-btn" aria-pressed="false">🖥 TV</button></div>' +
    '<div id="kds-alerts"></div>' +
    '<div class="tabs" id="kds-tabs">' +
    KDS_STATIONS.map((s) => '<button class="tab' + (s.slug === state.kds.station ? ' active' : '') + '" data-st="' + esc(s.slug) + '">' + esc(s.label) + '</button>').join('') +
    '</div><div class="kds-grid" id="kds-grid"></div></div>';

  const grid = $('#kds-grid'), wsBadge = $('#kds-ws'), recallBtn = $('#kds-recall-btn');
  const alertsEl = $('#kds-alerts');

  /* TV mode (presentation only): toggles the .kds-tv scale on the
     board root for a wall-mounted kitchen display. Persisted per
     device in localStorage; the same scale auto-applies via CSS
     on very wide/tall viewports. No ticket behavior changes. */
  const kdsRoot = $('#kds-root'), tvBtn = $('#kds-tv-btn');
  const applyKdsTv = (on) => {
    kdsRoot.classList.toggle('kds-tv', on);
    tvBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    tvBtn.textContent = on ? '🖥 TV: On' : '🖥 TV';
  };
  let kdsTv = false;
  try { kdsTv = localStorage.getItem('expoline.kdsTv') === '1'; } catch (e) { /* storage unavailable */ }
  applyKdsTv(kdsTv);
  tvBtn.onclick = () => {
    kdsTv = !kdsTv;
    try { localStorage.setItem('expoline.kdsTv', kdsTv ? '1' : '0'); } catch (e) { /* ignore */ }
    applyKdsTv(kdsTv);
  };

  $$('#kds-tabs .tab').forEach((b) => b.onclick = () => {
    state.kds.station = b.dataset.st;
    state.kds.recall = false; recallBtn.textContent = 'Recall';
    $$('#kds-tabs .tab').forEach((x) => x.classList.toggle('active', x === b));
    loadTickets(); kdsSubscribe(); loadAlerts();
  });
  recallBtn.onclick = async () => {
    state.kds.recall = !state.kds.recall;
    recallBtn.textContent = state.kds.recall ? 'Live' : 'Recall';
    if (state.kds.recall) {
      try {
        const r = await api('/api/kds/recall');
        state.kds.tickets = r.tickets || r || [];
      } catch (e) { handleApiError(e); return; }
    } else loadTickets();
    drawTickets();
  };

  function chanBadge(t) {
    const ch = t.channel || 'dine_in';
    if (ch === 'dine_in') return '';
    const label = ch === 'delivery' ? 'DLV' + (t.source ? ' · ' + t.source : '')
      : ch === 'qr_guest' ? 'QR GUEST'
      : ch === 'takeout' ? 'TAKEOUT'
      : ch === 'online' ? 'ONLINE'
      : ch === 'kiosk' ? 'KIOSK' : ch.toUpperCase();
    return '<span class="t-chan ch-' + esc(ch) + '">' + esc(label) + '</span>';
  }

  function courseLine(t) {
    const cs = t.course_status || [];
    if (!cs.length) return '';
    const bits = cs.map((c) => {
      const name = String(c.course || '').toUpperCase();
      if (c.total > 0 && c.bumped >= c.total) return name + ' ✓';
      let s = name + ' ' + c.bumped + '/' + c.total + ' bumped';
      if (c.held > 0) s += ' · ' + c.held + ' held';
      return s;
    });
    return '<div class="t-courses" title="Course status — the line never has to ask">🍽 ' + esc(bits.join(' · ')) + '</div>';
  }

  function ticketCard(t) {
    const ts = t.fired_at || t.created_at || t.updated_at || Date.now();
    const el = kdsElapsed(ts);
    const band = kdsBand(el.s);
    const timerCls = band === 'overdue' ? 'late' : (band === 'aging' || band === 'aging_soon') ? 'warn' : '';
    const items = (t.items || []).map((i) => {
      const mods = (i.modifiers || []).map((m) => '<div class="tmods">+ ' + esc(m.name || m) + '</div>').join('');
      /* Allergy renders as a high-visibility badge — never a low-priority note. */
      const allergy = i.allergy
        ? '<div class="t-allergy">⚠ ALLERGY' + (i.allergy_detail ? ' — ' + esc(i.allergy_detail) : '') + '</div>'
        : '';
      const note = (i.note || i.notes)
        ? '<div class="t-note">✎ ' + esc(i.note || i.notes) + '</div>'
        : '';
      const seatLbl = i.seat ? 'SEAT ' + i.seat + (i.guest_name ? ' · ' + String(i.guest_name).toUpperCase() : '') : '';
      return '<div class="t-item"><div class="row1"><span class="qty">' + (i.qty || 1) + '×</span>' +
        '<span class="inm">' + esc(i.name || 'Item') + '</span>' +
        (seatLbl ? '<span class="seat">' + esc(seatLbl) + '</span>' : '') + '</div>' + mods + allergy + note + '</div>';
    }).join('');
    /* Phase 3A: highlighted edits — the kitchen sees the delta, not a reprint. */
    const deltas = (t.deltas || []).map((d) => window.ParityOrders.deltaHtml(d)).join('');
    const status = (t.status || 'new').toLowerCase().replace(/ /g, '_');
    const next = status === 'new' ? 'in_progress' : status === 'in_progress' ? 'fulfilled' : null;
    const bumpLabel = status === 'new' ? 'Start' : status === 'in_progress' ? 'Bump ✓' : null;
    /* Ticket-level banners: allergy alert (verify before firing) and
     * re-fire (reprint — not a new make, don't double-fire). */
    const banners =
      (t.has_allergy ? '<div class="t-banner t-banner-allergy">⚠ ALLERGY ALERT — check flagged items before firing</div>' : '') +
      (t.refire ? '<div class="t-banner t-banner-refire">↻ RE-FIRE — reprint, already fired once</div>' : '');
    return '<div class="ticket band-' + band + '" data-tid="' + esc(String(t.id)) + '">' +
      '<div class="t-head band-' + band + '"><span class="t-table">' + esc(t.table_label || t.table || '—') + '</span>' +
      chanBadge(t) +
      '<span class="t-server">' + esc(t.server_name || t.server || '') + '</span>' +
      '<span class="t-status ' + esc(status) + '">' + esc(status.replace('_', ' ')) + '</span>' +
      '<span class="t-timer ' + timerCls + '" data-ts="' + esc(String(ts)) + '">' + el.mmss + '</span></div>' +
      banners +
      courseLine(t) +
      items + deltas +
      (bumpLabel && !state.kds.recall
        ? '<div class="bump-row"><button class="btn ' + (status === 'new' ? 'btn-amber' : 'btn-green') + '" data-bump="' + esc(String(t.id)) + '" data-next="' + next + '">' + bumpLabel + '</button></div>'
        : '<div class="small muted" style="margin-top:8px">' + esc(fmtDateTime(ts)) + '</div>') +
      '</div>';
  }

  function drawTickets() {
    const list = state.kds.tickets;
    if (!list.length) {
      grid.innerHTML = '<div class="kds-empty">' + (state.kds.recall ? 'No recently fulfilled tickets.' : 'All clear — no open tickets for ' + esc(kdsLabel(state.kds.station)) + '.') + '</div>';
      return;
    }
    grid.innerHTML = list.map(ticketCard).join('');
    $$('[data-bump]', grid).forEach((b) => b.onclick = async () => {
      b.disabled = true;
      try {
        await api('/api/kds/tickets/' + b.dataset.bump + '/bump', 'POST', { status: b.dataset.next });
        state.kds.tickets = state.kds.tickets.filter((t) => String(t.id) !== b.dataset.bump);
        drawTickets();
      } catch (e) { handleApiError(e); b.disabled = false; }
    });
  }

  async function loadTickets() {
    try {
      const r = await api('/api/kds/tickets?station=' + encodeURIComponent(state.kds.station) + '&status=open');
      state.kds.tickets = r.tickets || (Array.isArray(r) ? r : []);
      drawTickets();
      loadAlerts();
    } catch (e) { handleApiError(e); }
  }

  function kdsSubscribe() {
    closeKdsWs();
    if (isOffline()) { wsBadge.innerHTML = '<span class="dot-dead"></span>offline'; return; }
    const tok = sessionStorage.getItem('expoline.token');
    if (!tok) return;
    const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    let ws;
    try { ws = new WebSocket(proto + location.host + '/ws?token=' + encodeURIComponent(tok)); }
    catch (e) { wsBadge.innerHTML = '<span class="dot-dead"></span>unavailable'; return; }
    state.kds.ws = ws;
    const gen = state.kds.gen || 0;
    ws.onopen = () => {
      state.kds.wsUp = true; state.kds.retryMs = 1000;
      wsBadge.innerHTML = '<span class="dot-live"></span>live';
      try { ws.send(JSON.stringify({ action: 'subscribe', channel: 'kds', station: state.kds.station })); } catch (e) {}
    };
    ws.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if ((msg.type === 'ticket' || msg.type === 'ticket_updated') && msg.ticket) {
        const t = msg.ticket;
        const tStation = t.station || t.kds_station;
        if (tStation && tStation !== state.kds.station) return; // other station's ticket
        const i = state.kds.tickets.findIndex((x) => String(x.id) === String(t.id));
        const closed = ['fulfilled', 'done', 'closed'].includes(String(t.status || '').toLowerCase());
        if (closed) { if (i >= 0) { state.kds.tickets.splice(i, 1); drawTickets(); } }
        else if (i >= 0) state.kds.tickets[i] = t;
        else state.kds.tickets.unshift(t);
        if (!state.kds.recall) drawTickets();
      }
    };
    const down = () => {
      state.kds.wsUp = false;
      wsBadge.innerHTML = '<span class="dot-dead"></span>reconnecting…';
      const ms = state.kds.retryMs;
      state.kds.retryMs = Math.min(30000, ms * 2);
      // Only resubscribe if no newer generation superseded this socket
      // (prevents the closed-old-socket retry from churning a live one).
      setTimeout(() => {
        if ((state.kds.gen || 0) === gen && state.route && state.route.view === 'kds') kdsSubscribe();
      }, ms);
    };
    ws.onclose = down; ws.onerror = down;
  }

  // Aging alerts strip — fires BEFORE the breach (aging_soon tickets show
  // their warn-in countdown). Refreshed on load, on station switch, on WS
  // ticket events, and every 20s.
  function fmtDur(s) { s = Math.max(0, Math.floor(s)); return Math.floor(s / 60) + ':' + pad2(s % 60); }
  async function loadAlerts() {
    if (state.kds.recall || !alertsEl) return;
    let r;
    try { r = await api('/api/kds/alerts?station=' + encodeURIComponent(state.kds.station)); }
    catch (e) { return; }
    const list = (r && r.alerts) || [];
    if (!list.length) { alertsEl.innerHTML = ''; return; }
    const order = { overdue: 0, aging: 1, aging_soon: 2 };
    list.sort((a, b) => (order[a.band] ?? 3) - (order[b.band] ?? 3));
    alertsEl.innerHTML = '<div class="kds-alerts">' + list.map((a) => {
      const cls = a.band === 'overdue' ? 'al-over' : a.band === 'aging' ? 'al-age' : 'al-soon';
      const msg = a.band === 'aging_soon' ? 'warn in ' + fmtDur(a.warn_in_s)
        : a.band === 'aging' ? 'aging ' + fmtDur(a.elapsed_s)
        : 'OVERDUE ' + fmtDur(a.elapsed_s);
      return '<span class="kds-alert ' + cls + '">' + (a.band === 'aging_soon' ? '⚠ ' : '⏱ ') +
        esc(a.table_label || '—') + ' · ' + esc(kdsLabel(a.station)) + ' — ' + esc(msg) + '</span>';
    }).join('') + '</div>';
  }

  // 1-second timer updates (mm:ss; band colors from /api/kds/settings thresholds)
  state.timers.kds = setInterval(() => {
    $$('#kds-grid .t-timer').forEach((el) => {
      const ts = el.dataset.ts;
      const e = kdsElapsed(ts);
      const band = kdsBand(e.s);
      el.textContent = e.mmss;
      el.classList.toggle('warn', band === 'aging' || band === 'aging_soon');
      el.classList.toggle('late', band === 'overdue');
      const card = el.closest('.ticket');
      if (card) card.className = 'ticket band-' + band;
      const head = card ? card.querySelector('.t-head') : null;
      if (head) head.className = 't-head band-' + band;
    });
  }, 1000);
  state.timers.kdsAlerts = setInterval(loadAlerts, 20000);

  app._cleanup = () => { closeKdsSocket(); };
  await loadTickets();
  kdsSubscribe();
  loadAlerts();
}

/* ============================================================
   VIEW: PAY (server) — line-by-line math, splits, payments, close.
   ============================================================ */
async function renderPay(app, checkId) {
  if (state.user.role !== 'server' && state.user.role !== 'manager') { app.innerHTML = notAuthorized(); return; }
  if (!checkId) { location.hash = '#/floor'; return; }

  let view;
  try { view = await getCheckView(checkId); }
  catch (e) { if (handleApiError(e) === 'bounced') return; app.innerHTML = '<div class="card"><h2>Check not found</h2></div>'; return; }
  const check = view.check;
  const t = Object.assign({ subtotal: 0, surcharge: 0, service_charge: 0, tax: 0, total: 0, paid: 0, balance: 0 }, check.totals || {});
  const guests = check.guest_count || check.guests || 0;
  let tipCents = 0, tipPct = 0;

  const sc = await siteConfig();

  const moneyRows = [
    ['Subtotal', fmt(t.subtotal)],
    [pctLabel(sc.surcharge_pct) + ' surcharge', fmt(t.surcharge)],
    t.service_charge ? [pctLabel(sc.service_charge_pct) + ' service charge <span class="lbl-note">' + sc.service_charge_min_guests + '+ guests · mandatory — not a tip</span>', fmt(t.service_charge)] : null,
    ['Tax', fmt(t.tax)],
    t.comp ? ['Comp <span class="lbl-note">manager approved</span>', '−' + fmt(t.comp)] : null,
  ].filter(Boolean);

  app.innerHTML =
    '<div class="order-top"><a class="btn btn-ghost" href="#/order/' + encodeURIComponent(checkId) + '">‹ Order</a>' +
    '<span class="table-label">' + esc(check.table_label || 'Check') + '</span>' +
    (check.tab_name ? '<span class="muted">· ' + esc(check.tab_name) + '</span>' : '') +
    '<span class="spacer"></span><span class="muted small">' + guests + ' guests</span></div>' +
    (t.estimated ? '<p class="small muted">Totals estimated while offline.</p>' : '') +
    '<div class="card"><h2>Check summary</h2><table class="money-table">' +
    moneyRows.map(([l, v]) => '<tr><td>' + l + '</td><td>' + v + '</td></tr>').join('') +
    '<tr class="total"><td>Total</td><td>' + fmt(t.total) + '</td></tr>' +
    ((check.payments || []).length ? '<tr><td colspan="2" style="border:none;padding-top:10px"><b>Payments</b></td></tr>' +
      (check.payments || []).map((p) => '<tr><td>' + esc(paymentLabel(p)) + (p.pending ? ' <span class="pill held">queued</span>' : '') + '</td><td>' + fmt(p.amount_cents) + (p.tip_cents ? ' <span class="muted small">+ ' + fmt(p.tip_cents) + ' tip</span>' : '') + '</td></tr>').join('') : '') +
    '<tr><td>Paid</td><td>' + fmt(t.paid) + '</td></tr>' +
    '<tr class="balance' + (t.balance <= 0 ? ' zero' : '') + '"><td>Balance due</td><td>' + fmt(Math.max(0, t.balance)) + '</td></tr>' +
    '</table>' +
    (t.service_charge ? '<p class="muted small">The service charge is mandatory restaurant revenue, not a tip — it is never auto-distributed as tips, and it is taxed as part of the sale in CA. Confirm tax treatment with your accountant.</p>' : '') +
    '<div style="margin-top:10px"><button class="btn" id="print-receipt">🖨 Print receipt</button></div>' +
    '</div>' +

    '<div class="card"><h2>Comp</h2>' +
    '<p class="muted small">Manager approval required — amount or %, a reason, and the manager\'s PIN. The comp is audit-logged.</p>' +
    '<div class="tip-row" id="comp-mode">' +
    '<button class="tip-chip active" data-cm="amount">$ amount</button><button class="tip-chip" data-cm="percent">% percent</button></div>' +
    '<div class="field"><label for="comp-val" id="comp-val-label">Comp amount ($)</label><input type="number" id="comp-val" min="0" step="0.01" inputmode="decimal" placeholder="0.00"></div>' +
    '<div class="field"><label for="comp-reason">Reason (required)</label><input type="text" id="comp-reason" maxlength="120" placeholder="e.g. birthday dessert"></div>' +
    '<div class="field"><label for="comp-pin">Manager PIN</label><input type="password" id="comp-pin" inputmode="numeric" maxlength="4" placeholder="••••" style="max-width:140px"></div>' +
    '<button class="btn btn-block" id="comp-apply">Apply comp</button></div>' +

    (state.user.role === 'manager' && (check.payments || []).length
      ? '<div class="card"><h2>Refunds</h2>' +
        '<p class="muted small">Manager only — partial or full refunds, no hoops. A refund that returns a balance to a paid check reopens it.</p>' +
        '<table class="money-table">' +
        (check.payments || []).map((p) => {
          const refunded = p.refunded_cents || 0;
          const remaining = (p.amount_cents || 0) - refunded;
          const st = p.status || 'completed';
          const pill = st === 'refunded' ? ' <span class="pill sent">refunded</span>'
            : st === 'partial_refund' ? ' <span class="pill held">partial refund</span>' : '';
          return '<tr><td>' + paymentLabel(p) + pill +
            (refunded ? '<div class="small muted">refunded ' + fmt(refunded) + '</div>' : '') + '</td>' +
            '<td>' + fmt(p.amount_cents) + '</td>' +
            '<td style="text-align:right;white-space:nowrap">' +
            (remaining > 0 ? '<button class="btn btn-sm" data-refund="' + p.id + '">Refund</button>' : '<span class="muted small">—</span>') +
            '</td></tr>';
        }).join('') + '</table></div>'
      : '') +

    '<div class="card"><h2>Split check</h2>' +
    (t.service_charge ? '<p class="small" style="color:var(--red)">Splitting is unavailable — a ' + pctLabel(sc.service_charge_pct) + ' service charge is applied to this check.</p>'
      : '<div class="split-row"><button class="btn" id="split-even">Split evenly</button>' +
        '<button class="btn" id="split-seat">Split by seat</button>' +
        '<button class="btn" id="split-move">Move items</button>' +
        '<button class="btn" id="split-visual">Visual split</button></div>') +
    '</div>' +
    '<div class="card"><h2>Merge</h2>' +
    '<button class="btn" id="merge-into">Merge into another check…</button></div>' +

    '<div class="card"><h2>Payment</h2>' +
    '<div class="field"><label>Tip</label><div class="tip-row" id="tip-row">' +
    [15, 18, 20, 25].map((p) => '<button class="tip-chip" data-tip="' + p + '">' + p + '%</button>').join('') +
    '<button class="tip-chip" data-tip="custom">Custom</button></div>' +
    '<div class="field" id="tip-custom-wrap" style="display:none"><label for="tip-custom">Custom tip ($)</label><input type="number" id="tip-custom" min="0" step="0.01" inputmode="decimal" placeholder="0.00"></div>' +
    '<p class="small muted" id="tip-line">Tip: $0.00</p></div>' +
    '<div class="pay-methods"><button class="btn btn-big" id="pay-cash">Cash</button>' +
    '<button class="btn btn-big btn-primary" id="pay-card">Card</button></div>' +
    '<div class="pay-methods" style="margin-top:8px"><button class="btn" id="pay-gift">Gift card</button>' +
    '<button class="btn" id="pay-house">House account</button>' +
    '<button class="btn" id="pay-compcard">Comp card</button></div></div>' +

    '<div class="card"><button class="btn btn-green btn-big btn-block" id="close-check"' + (t.balance > 0 ? ' disabled' : '') + '>' +
    (t.balance > 0 ? 'Balance remaining — cannot close' : 'Close check ✓') + '</button>' +
    (t.balance > 0 ? '' : '<p class="small muted" style="text-align:center;margin-top:8px">Balance is $0.00 — ready to close.</p>') + '</div>' +
    '<div id="review-nudge-slot"></div>' +
    /* Handheld only (CSS-gated): the running total stays pinned in a
       bottom bar while the server scrolls the payment card. Same `t`
       the summary card above renders — display only. */
    '<div class="pay-total-bar" id="pay-total-bar"><span>Total · ' + fmt(t.total) + '</span>' +
    (Math.max(0, t.balance) !== t.total ? '<span class="due">Due ' + fmt(Math.max(0, t.balance)) + '</span>' : '') + '</div>';

  function paymentLabel(p) {
    if (p.method === 'cash') return 'Cash' + (p.tendered_cents ? ' (tendered ' + fmt(p.tendered_cents) + ')' : '');
    if (p.method === 'card_demo' || p.method === 'card') return 'Card' + (p.brand ? ' · ' + esc(p.brand) : '') + (p.last4 ? ' •••• ' + esc(p.last4) : '') + ' <span class="pill staged">DEMO</span>';
    if (p.method === 'gift_card') return 'Gift card' + (p.last4 ? ' •••• ' + esc(p.last4) : '');
    if (p.method === 'house_account') return 'House account' + (p.memo ? ' — ' + esc(p.memo) : '');
    return esc(p.method || 'Payment');
  }

  /* ---- tip ---- */
  const tipLine = $('#tip-line');
  const prBtn = $('#print-receipt');
  if (prBtn) prBtn.onclick = () => printReceipt(check, t, view.items || [], sc);
  const drawTip = () => { tipLine.textContent = 'Tip: ' + fmt(tipCents) + (tipPct ? ' (' + tipPct + '%)' : ''); };
  $$('#tip-row .tip-chip').forEach((b) => b.onclick = () => {
    $$('#tip-row .tip-chip').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    const v = b.dataset.tip;
    if (v === 'custom') { $('#tip-custom-wrap').style.display = 'block'; $('#tip-custom').focus(); return; }
    $('#tip-custom-wrap').style.display = 'none';
    tipPct = Number(v);
    tipCents = Math.round((t.balance || 0) * tipPct / 100);
    drawTip();
  });
  $('#tip-custom').addEventListener('input', (e) => {
    tipPct = 0;
    tipCents = Math.round((parseFloat(e.target.value) || 0) * 100);
    drawTip();
  });

  /* ---- splits ---- */
  const doSplit = async (body) => {
    try {
      if (isOffline()) { toast('Splits need a connection — reconnect to split', 'err'); return; }
      const r = await api('/api/checks/' + realId(checkId) + '/split', 'POST', body);
      toast('Check split', 'ok');
      const checks = r.checks || r.splits || [];
      if (checks.length && checks[0].id) { location.hash = '#/pay/' + checks[0].id; return; }
      renderRoute(true);
    } catch (e) {
      /* Phase 3A (P1-3): manager-PIN fallback — staff without the split
         permission get a 403 need_manager_pin, enter the PIN, and retry. */
      if (e instanceof ApiError && e.status === 403 && e.body && e.body.need_manager_pin) {
        const bd = openModal('<h2>Manager approval</h2>' +
          '<p class="muted">Splitting checks needs the split permission. A manager can approve with their PIN.</p>' +
          '<div class="field"><label for="sp-pin">Manager PIN</label>' +
          '<input type="password" id="sp-pin" inputmode="numeric" maxlength="4" placeholder="••••" style="max-width:140px" autocomplete="off"></div>' +
          '<div class="modal-actions"><button class="btn btn-ghost" data-x="c">Cancel</button>' +
          '<button class="btn btn-primary" data-x="go">Approve split</button></div>');
        $('[data-x="c"]', bd).onclick = closeModal;
        $('[data-x="go"]', bd).onclick = async () => {
          const pin = $('#sp-pin', bd).value.trim();
          if (!/^\d{4}$/.test(pin)) { toast("Enter the manager's 4-digit PIN", 'err'); return; }
          closeModal();
          await doSplit(Object.assign({}, body, { manager_pin: pin }));
        };
        return;
      }
      if (e instanceof ApiError) toast(e.message, 'err'); else handleApiError(e);
    }
  };

  const splitVisualBtn = $('#split-visual');
  if (splitVisualBtn) splitVisualBtn.onclick = async () => {
    if (await window.ParityOrders.openVisualSplit(realId(checkId))) renderRoute(true);
  };
  const mergeIntoBtn = $('#merge-into');
  if (mergeIntoBtn) mergeIntoBtn.onclick = async () => {
    if (await window.ParityOrders.openMergePicker(realId(checkId))) renderRoute(true);
  };

  const splitEvenBtn = $('#split-even');
  if (splitEvenBtn) splitEvenBtn.onclick = () => {
    // tap 1: open stepper · tap 2: confirm  (≤3 taps total)
    let parts = 2;
    const bd = openModal('<h2>Split evenly</h2><p class="muted">Divide the total into equal parts.</p>' +
      '<div class="stepper" style="margin:12px 0"><button data-s="dec">−</button><span class="val" id="sp-val">2</span><button data-s="inc">+</button></div>' +
      '<p class="small muted">Each pays <b id="sp-each">' + fmt(Math.ceil((t.total || 0) / 2)) + '</b> (rounded up)</p>' +
      '<div class="modal-actions"><button class="btn btn-ghost" data-x="c">Cancel</button><button class="btn btn-primary" data-x="go">Split into 2</button></div>');
    const upd = () => { $('#sp-val', bd).textContent = parts; $('#sp-each', bd).textContent = fmt(Math.ceil((t.total || 0) / parts)); $('[data-x="go"]', bd).textContent = 'Split into ' + parts; };
    $('[data-s="dec"]', bd).onclick = () => { parts = Math.max(2, parts - 1); upd(); };
    $('[data-s="inc"]', bd).onclick = () => { parts = Math.min(12, parts + 1); upd(); };
    $('[data-x="c"]', bd).onclick = closeModal;
    $('[data-x="go"]', bd).onclick = async () => { closeModal(); await doSplit({ mode: 'even', parts }); };
  };

  const splitSeatBtn = $('#split-seat');
  if (splitSeatBtn) splitSeatBtn.onclick = () => {
    let nGroups = 2;
    const assign = {}; // seat -> group
    for (let s = 1; s <= guests; s++) assign[s] = 1;
    const bd = openModal('<h2>Split by seat</h2><p class="muted">Assign each seat to a group.</p>' +
      '<div class="field"><label>Groups</label><div class="stepper"><button data-g="dec">−</button><span class="val" id="sg-val">2</span><button data-g="inc">+</button></div></div>' +
      '<div class="checkbox-list" id="sg-list"></div>' +
      '<div class="modal-actions"><button class="btn btn-ghost" data-x="c">Cancel</button><button class="btn btn-primary" data-x="go">Confirm split</button></div>');
    const draw = () => {
      $('#sg-val', bd).textContent = nGroups;
      const seatNames = check.seat_names || {};
      $('#sg-list', bd).innerHTML = Array.from({ length: guests }, (_, i) => i + 1).map((s) =>
        '<label><span style="min-width:70px;font-weight:700">Seat ' + s + (seatNames[s] ? '<br><span class="muted small">' + esc(seatNames[s]) + '</span>' : '') + '</span><div class="stepper"><button data-as="-1" data-s="' + s + '">−</button><span class="val" data-gv="' + s + '">' + assign[s] + '</span><button data-as="1" data-s="' + s + '">+</button></div></label>').join('');
      $$('[data-as]', bd).forEach((b) => b.onclick = (e) => {
        e.preventDefault();
        const s = b.dataset.s;
        assign[s] = Math.min(nGroups, Math.max(1, assign[s] + Number(b.dataset.as)));
        $('[data-gv="' + s + '"]', bd).textContent = assign[s];
      });
    };
    $('[data-g="dec"]', bd).onclick = () => { nGroups = Math.max(2, nGroups - 1); for (const s in assign) assign[s] = Math.min(assign[s], nGroups); draw(); };
    $('[data-g="inc"]', bd).onclick = () => { nGroups = Math.min(guests, nGroups + 1); draw(); };
    $('[data-x="c"]', bd).onclick = closeModal;
    $('[data-x="go"]', bd).onclick = async () => {
      const groups = [];
      for (let g = 1; g <= nGroups; g++) {
        const seats = Object.keys(assign).filter((s) => assign[s] === g).map(Number);
        if (seats.length) groups.push(seats);
      }
      if (groups.length < 2) { toast('Assign seats to at least 2 groups', 'err'); return; }
      closeModal();
      await doSplit({ mode: 'by_seat', groups });
    };
    draw();
  };

  const splitMoveBtn = $('#split-move');
  if (splitMoveBtn) splitMoveBtn.onclick = () => {
    const items = (check.items || []).filter((i) => i.state !== 'void');
    if (!items.length) { toast('No items to move'); return; }
    const bd = openModal('<h2>Move items</h2><p class="muted">Select items to move onto a brand-new check.</p>' +
      '<div class="checkbox-list">' + items.map((i) =>
        '<label><input type="checkbox" data-mv="' + esc(String(i.id)) + '" data-mvqty="' + (i.qty || 1) + '"><span style="flex:1">' + (i.qty > 1 ? i.qty + '× ' : '') + esc(i.name) + ' <span class="muted small">Seat ' + (i.seat || '—') + '</span></span><span>' + fmt(((i.unit_price_cents != null ? i.unit_price_cents : i.price_cents) || 0) * (i.qty || 1)) + '</span></label>').join('') +
      '</div><div class="field" id="mv-qty-wrap" style="display:none"><label>How many to move? <span class="muted small">(split the line)</span></label>' +
      '<div class="stepper"><button data-mq="dec">−</button><span class="val" id="mv-qty">1</span><button data-mq="inc">+</button></div></div>' +
      '<div class="modal-actions"><button class="btn btn-ghost" data-x="c">Cancel</button><button class="btn btn-primary" data-x="go">Move to new check</button></div>');
    let moveQty = 1, moveMax = 1;
    const refreshQty = () => {
      const checked = $$('[data-mv]:checked', bd);
      if (checked.length === 1) {
        moveMax = Number(checked[0].dataset.mvqty) || 1;
        if (moveMax > 1) {
          $('#mv-qty-wrap', bd).style.display = 'block';
          moveQty = Math.min(moveQty, moveMax);
          $('#mv-qty', bd).textContent = moveQty;
          return;
        }
      }
      $('#mv-qty-wrap', bd).style.display = 'none'; moveQty = 1;
    };
    $$('[data-mv]', bd).forEach((c) => c.onchange = refreshQty);
    $('[data-mq="dec"]', bd).onclick = () => { moveQty = Math.max(1, moveQty - 1); $('#mv-qty', bd).textContent = moveQty; };
    $('[data-mq="inc"]', bd).onclick = () => { moveQty = Math.min(moveMax, moveQty + 1); $('#mv-qty', bd).textContent = moveQty; };
    $('[data-x="c"]', bd).onclick = closeModal;
    $('[data-x="go"]', bd).onclick = async () => {
      const ids = $$('[data-mv]:checked', bd).map((c) => c.dataset.mv);
      if (!ids.length) { toast('Select at least one item', 'err'); return; }
      closeModal();
      const body = { mode: 'move', item_ids: ids, target: 'new' };
      if (ids.length === 1 && moveMax > 1 && moveQty < moveMax) body.qty = moveQty;
      await doSplit(body);
    };
  };

  /* ---- comp (manager approval at point of action) ---- */
  let compMode = 'amount';
  $$('#comp-mode .tip-chip').forEach((b) => b.onclick = () => {
    $$('#comp-mode .tip-chip').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    compMode = b.dataset.cm;
    $('#comp-val-label').textContent = compMode === 'amount' ? 'Comp amount ($)' : 'Comp percent (%)';
  });
  $('#comp-apply').onclick = async () => {
    if (isOffline()) { toast('Comps need a connection — reconnect first', 'err'); return; }
    const pin = $('#comp-pin').value.trim();
    if (!/^\d{4}$/.test(pin)) { toast('Enter the manager\'s 4-digit PIN', 'err'); return; }
    const reason = $('#comp-reason').value.trim();
    if (!reason) { toast('A reason is required for comps', 'err'); return; }
    const v = parseFloat($('#comp-val').value || '0');
    const body = { manager_pin: pin, reason };
    if (compMode === 'amount') {
      if (!(v > 0)) { toast('Enter a comp amount', 'err'); return; }
      body.amount_cents = Math.round(v * 100);
    } else {
      if (!(v > 0) || v > 100) { toast('Enter a percent between 0 and 100', 'err'); return; }
      body.percent = v;
    }
    try {
      const r = await api('/api/checks/' + realId(checkId) + '/comp', 'POST', body);
      toast('Comp applied — ' + fmt(r.comp_cents) + ' (approved by ' + (r.approved_by || 'manager') + ')', 'ok');
      renderRoute(true);
    } catch (e) { handleApiError(e); }
  };

  /* ---- refunds (manager only; API is managerOnly) ---- */
  $$('[data-refund]', app).forEach((b) => b.onclick = () => {
    const p = (check.payments || []).find((x) => String(x.id) === b.dataset.refund);
    if (!p) return;
    const remaining = (p.amount_cents || 0) - (p.refunded_cents || 0);
    if (remaining <= 0) { toast('Nothing left to refund on this payment', 'err'); return; }
    const plainLabel = paymentLabel(p).replace(/<[^>]+>/g, '');
    const billable = (check.items || []).filter((i) => i.state !== 'void');
    const lineTotal = (i) => ((i.unit_price_cents != null ? i.unit_price_cents : i.price_cents) || 0) * (i.qty || 1);
    const bd = openModal('<h2>Refund payment</h2>' +
      '<p class="muted">' + esc(plainLabel) + ' — paid ' + fmt(p.amount_cents) + ', refundable <b>' + fmt(remaining) + '</b></p>' +
      (billable.length ? '<p class="muted small">Tap items to refund them specifically — the amount fills in automatically.</p>' +
      '<div class="checkbox-list" id="rf-items">' + billable.map((i) =>
        '<label><input type="checkbox" data-rf-item="' + esc(String(i.id)) + '" data-rf-total="' + lineTotal(i) + '">' +
        '<span style="flex:1">' + (i.qty > 1 ? i.qty + '× ' : '') + esc(i.name) + '</span><span>' + fmt(lineTotal(i)) + '</span></label>').join('') + '</div>' : '') +
      '<div class="field"><label for="rf-amt">Refund amount ($)</label>' +
      '<input type="number" id="rf-amt" min="0.01" step="0.01" inputmode="decimal" value="' + (remaining / 100).toFixed(2) + '"></div>' +
      '<div class="modal-actions"><button class="btn btn-ghost" data-x="c">Cancel</button>' +
      '<button class="btn btn-danger" data-x="go">Refund ' + fmt(remaining) + '</button></div>');
    const rfUpd = () => {
      const picked = $$('#rf-items [data-rf-item]:checked', bd).reduce((s, c) => s + Number(c.dataset.rfTotal || 0), 0);
      if (picked > 0) $('#rf-amt', bd).value = (Math.min(picked, remaining) / 100).toFixed(2);
      const cents = Math.round((parseFloat($('#rf-amt', bd).value) || 0) * 100);
      $('[data-x="go"]', bd).textContent = 'Refund ' + fmt(Math.min(cents, remaining));
    };
    $$('#rf-items [data-rf-item]', bd).forEach((c) => c.addEventListener('change', rfUpd));
    $('#rf-amt', bd).addEventListener('input', rfUpd);
    $('[data-x="c"]', bd).onclick = closeModal;
    $('[data-x="go"]', bd).onclick = async () => {
      const cents = Math.round((parseFloat($('#rf-amt', bd).value) || 0) * 100);
      if (!(cents > 0) || cents > remaining) { toast('Enter $0.01 – ' + fmt(remaining), 'err'); return; }
      closeModal();
      try {
        if (isOffline()) { toast('Refunds need a connection — reconnect first', 'err'); return; }
        const r = await api('/api/payments/' + p.id + '/refund', 'POST', { amount_cents: cents });
        const rp = (r && r.payment) || {};
        toast(rp.status === 'refunded' ? 'Payment fully refunded' : 'Partial refund — ' + fmt(rp.refunded_cents || cents) + ' refunded', 'ok');
        renderRoute(true);
      } catch (e) { handleApiError(e); }
    };
  });

  /* ---- payments ---- */
  const recordPayment = async (payload) => {
    let resp = null;
    try {
      if (isOffline()) {
        if (String(checkId).startsWith('tmp-')) {
          const d = JSON.parse(localStorage.getItem('expoline.draft:' + checkId));
          d.payments.push({ method: payload.method, amount_cents: payload.amount_cents, tip_cents: payload.tip_cents || 0, tendered_cents: payload.tendered_cents, brand: payload.brand, last4: payload.last4, memo: payload.memo });
          localStorage.setItem('expoline.draft:' + checkId, JSON.stringify(d));
        }
        await Outbox.enqueue('payment', Object.assign({ check_id: realId(checkId) }, payload));
        toast('Payment queued — syncs on reconnect', 'ok');
        resp = { queued: true };
      } else {
        resp = await api('/api/checks/' + realId(checkId) + '/payments', 'POST', payload);
        toast('Payment recorded', 'ok');
      }
    } catch (e) { handleApiError(e); return null; }
    renderRoute(true);
    return resp;
  };

  $('#pay-cash').onclick = () => {
    const balance = Math.max(0, t.balance || 0);
    const due = balance + tipCents;
    let tendered = due;
    const bd = openModal('<h2>Cash payment</h2><p class="muted">Due: <b style="color:var(--brass-hi)">' + fmt(due) + '</b>' + (tipCents ? ' (incl. ' + fmt(tipCents) + ' tip)' : '') + '</p>' +
      splitTenderFields(due, tipCents) +
      '<div class="tip-row" id="cash-presets">' +
      '<button class="tip-chip" data-t="exact">Exact</button><button class="tip-chip" data-t="2000">$20</button><button class="tip-chip" data-t="5000">$50</button><button class="tip-chip" data-t="10000">$100</button></div>' +
      '<div class="field"><label for="cash-tendered">Tendered ($)</label><input type="number" id="cash-tendered" min="0" step="0.01" inputmode="decimal" value="' + (due / 100).toFixed(2) + '"></div>' +
      '<div class="change-due" id="cash-change">Change due: $0.00</div>' +
      '<div class="modal-actions"><button class="btn btn-ghost" data-x="c">Cancel</button><button class="btn btn-primary" data-x="go" id="cash-go">Record cash payment</button></div>');
    const cur = () => readSplitTender(bd, balance);
    const upd = () => {
      const r = cur();
      const go = $('[data-x="go"]', bd);
      if (r.error) { go.disabled = true; go.textContent = 'Record cash payment'; return; }
      const ch = tendered - r.payTotal;
      $('#cash-change', bd).textContent = 'Change due: ' + fmt(Math.max(0, ch));
      go.disabled = tendered < r.payTotal;
      go.textContent = r.payTotal >= due ? 'Record cash payment'
        : 'Record partial — ' + fmt(due - r.payTotal) + ' left';
    };
    $$('#cash-presets .tip-chip', bd).forEach((b) => b.onclick = () => {
      tendered = b.dataset.t === 'exact'
        ? Math.round((parseFloat($('#st-amount', bd).value) || 0) * 100)
        : Number(b.dataset.t);
      $('#cash-tendered', bd).value = (tendered / 100).toFixed(2);
      upd();
    });
    $('#cash-tendered', bd).addEventListener('input', (e) => { tendered = Math.round((parseFloat(e.target.value) || 0) * 100); upd(); });
    $('#st-amount', bd).addEventListener('input', upd);
    $('#st-tip', bd).addEventListener('input', upd);
    $('[data-x="c"]', bd).onclick = closeModal;
    $('[data-x="go"]', bd).onclick = async () => {
      const r = cur();
      if (r.error) { toast(r.error, 'err'); return; }
      if (tendered < r.payTotal) { toast('Tendered is less than the payment amount', 'err'); return; }
      const partial = r.payTotal < due;
      closeModal();
      const resp = await recordPayment({ method: 'cash', amount_cents: r.principal, tip_cents: r.tip, tendered_cents: tendered });
      if (resp && partial) toast('Partial payment — ' + fmt(due - r.payTotal) + ' remaining', 'ok');
    };
    upd();
  };

  $('#pay-card').onclick = () => {
    const balance = Math.max(0, t.balance || 0);
    const due = balance + tipCents;
    const bd = openModal('<div class="demo-banner">DEMO TERMINAL — no real charge will be made</div>' +
      '<div class="term-screen" id="term-1"><h2>Card payment</h2><div class="term-amount">' + fmt(due) + '</div>' +
      splitTenderFields(due, tipCents) +
      '<div class="term-btns"><button class="btn btn-big" data-tm="insert">Insert</button><button class="btn btn-big" data-tm="tap">Tap</button></div>' +
      '<div class="term-btns" style="margin-top:12px"><button class="btn btn-big" data-tm="swipe">Swipe</button><button class="btn btn-ghost" data-x="c">Cancel</button></div></div>' +
      '<div class="term-screen hidden" id="term-2"><h2>Processing…</h2><p class="muted">Contacting demo processor</p><p style="font-size:2rem">◌</p></div>' +
      '<div class="term-screen hidden" id="term-3"><div class="term-ok">✓</div><h2>Approved</h2>' +
      '<p class="muted">Auth code</p><p class="auth-code" id="term-auth"></p>' +
      '<div class="demo-banner" style="margin-top:12px">DEMO — simulated approval, nothing charged</div>' +
      '<button class="btn btn-primary btn-block" data-x="done">Done</button></div>');
    $('[data-x="c"]', bd).onclick = closeModal;
    $$('[data-tm]', bd).forEach((b) => b.onclick = async () => {
      const r = readSplitTender(bd, balance);
      if (r.error) { toast(r.error, 'err'); return; }
      const partial = r.payTotal < due;
      $('#term-1', bd).classList.add('hidden');
      $('#term-2', bd).classList.remove('hidden');
      const resp = await recordPayment({ method: 'card_demo', amount_cents: r.principal, tip_cents: r.tip, brand: 'Visa', last4: '4242' });
      $('#term-2', bd).classList.add('hidden');
      if (resp && resp.demo && resp.demo.auth_code) {
        $('#term-3', bd).classList.remove('hidden');
        $('#term-auth', bd).textContent = resp.demo.auth_code;
        if (partial) toast('Partial card payment — ' + fmt(due - r.payTotal) + ' remaining', 'ok');
      } else if (resp && resp.queued) {
        $('#term-3', bd).classList.remove('hidden');
        $('#term-3 h2', bd).textContent = 'Queued offline';
        $('#term-auth', bd).textContent = 'will sync on reconnect';
      } else {
        closeModal();
      }
    });
    $('[data-x="done"]', bd).onclick = () => { closeModal(); };
  };

  /* ---- gift card tender (real redeem endpoint; tips can't go on a gift card) ---- */
  $('#pay-gift').onclick = () => {
    if (isOffline()) { toast('Gift cards need a connection — reconnect first', 'err'); return; }
    const balance = Math.max(0, t.balance || 0);
    let cardBal = null;
    const bd = openModal('<h2>Gift card</h2><p class="muted">Balance due: <b style="color:var(--brass-hi)">' + fmt(balance) + '</b></p>' +
      '<div class="field"><label for="gc-code">Card code</label><input type="text" id="gc-code" inputmode="text" placeholder="e.g. GC-XXXX" style="text-transform:uppercase"></div>' +
      '<button class="btn" id="gc-lookup" style="margin-bottom:12px">Look up balance</button>' +
      '<p class="small" id="gc-bal"></p><div id="gc-pay" style="display:none">' +
      '<div class="field"><label for="gc-amount">Redeem amount ($) <span class="muted small">partial OK</span></label>' +
      '<input type="number" id="gc-amount" min="0" step="0.01" inputmode="decimal"></div>' +
      '<p class="small muted">Tips can\'t go on a gift card — take the tip on another tender.</p></div>' +
      '<div class="modal-actions"><button class="btn btn-ghost" data-x="c">Cancel</button><button class="btn btn-primary" data-x="go" id="gc-go" disabled>Redeem</button></div>');
    $('[data-x="c"]', bd).onclick = closeModal;
    $('#gc-lookup', bd).onclick = async () => {
      const code = $('#gc-code', bd).value.trim();
      if (!code) { toast('Enter the card code', 'err'); return; }
      try {
        const r = await api('/api/gift-cards/balance/' + encodeURIComponent(code));
        cardBal = (r.card && r.card.balance_cents) || 0;
        $('#gc-bal', bd).textContent = 'Available: ' + fmt(cardBal);
        $('#gc-amount', bd).value = (Math.min(cardBal, balance) / 100).toFixed(2);
        $('#gc-pay', bd).style.display = 'block';
        $('#gc-go', bd).disabled = false;
      } catch (e) { handleApiError(e); }
    };
    $('[data-x="go"]', bd).onclick = async () => {
      const code = $('#gc-code', bd).value.trim();
      const amt = Math.round((parseFloat($('#gc-amount', bd).value) || 0) * 100);
      if (!(amt > 0)) { toast('Enter an amount above $0.00', 'err'); return; }
      if (amt > balance) { toast('Amount exceeds the balance due', 'err'); return; }
      if (cardBal != null && amt > cardBal) { toast('Amount exceeds the card balance', 'err'); return; }
      closeModal();
      try {
        await api('/api/gift-cards/redeem', 'POST', { check_id: realId(checkId), gift_card_code: code, amount_cents: amt });
        toast(amt >= balance ? 'Gift card payment recorded' : 'Partial gift card payment — ' + fmt(balance - amt) + ' remaining', 'ok');
        renderRoute(true);
      } catch (e) { handleApiError(e); }
    };
  };

  /* ---- house account tender (charge to a named account; the payment row is the ledger) ---- */
  $('#pay-house').onclick = () => {
    const balance = Math.max(0, t.balance || 0);
    const due = balance + tipCents;
    const bd = openModal('<h2>House account</h2><p class="muted">Charge <b style="color:var(--brass-hi)">' + fmt(due) + '</b> due to a house account.</p>' +
      '<div class="field"><label for="ha-name">Account name (required)</label><input type="text" id="ha-name" maxlength="80" placeholder="e.g. Bali Hai — Daniel Silva"></div>' +
      splitTenderFields(due, tipCents) +
      '<div class="modal-actions"><button class="btn btn-ghost" data-x="c">Cancel</button><button class="btn btn-primary" data-x="go">Charge account</button></div>');
    $('[data-x="c"]', bd).onclick = closeModal;
    $('[data-x="go"]', bd).onclick = async () => {
      const name = $('#ha-name', bd).value.trim();
      if (!name) { toast('Enter the account name', 'err'); return; }
      const r = readSplitTender(bd, balance);
      if (r.error) { toast(r.error, 'err'); return; }
      const partial = r.payTotal < due;
      closeModal();
      const resp = await recordPayment({ method: 'house_account', amount_cents: r.principal, tip_cents: r.tip, memo: name });
      if (resp && partial) toast('Partial house charge — ' + fmt(due - r.payTotal) + ' remaining', 'ok');
    };
  };

  /* ---- comp card tender: same manager-gated, audit-logged comp flow, tender-button entry ---- */
  $('#pay-compcard').onclick = () => {
    if (isOffline()) { toast('Comps need a connection — reconnect first', 'err'); return; }
    const balance = Math.max(0, t.balance || 0);
    const bd = openModal('<h2>Comp card</h2><p class="muted">Manager approval required — applies a comp for the card amount. Audit-logged.</p>' +
      '<div class="field"><label for="cc-amount">Comp amount ($)</label><input type="number" id="cc-amount" min="0" step="0.01" inputmode="decimal" value="' + (balance / 100).toFixed(2) + '"></div>' +
      '<div class="field"><label for="cc-reason">Reason (required)</label><input type="text" id="cc-reason" maxlength="120" placeholder="e.g. comp card — birthday"></div>' +
      '<div class="field"><label for="cc-pin">Manager PIN</label><input type="password" id="cc-pin" inputmode="numeric" maxlength="4" placeholder="••••" style="max-width:140px"></div>' +
      '<div class="modal-actions"><button class="btn btn-ghost" data-x="c">Cancel</button><button class="btn btn-primary" data-x="go">Apply comp card</button></div>');
    $('[data-x="c"]', bd).onclick = closeModal;
    $('[data-x="go"]', bd).onclick = async () => {
      const pin = $('#cc-pin', bd).value.trim();
      if (!/^\d{4}$/.test(pin)) { toast('Enter the manager\'s 4-digit PIN', 'err'); return; }
      const reason = $('#cc-reason', bd).value.trim();
      if (!reason) { toast('A reason is required', 'err'); return; }
      const amt = Math.round((parseFloat($('#cc-amount', bd).value) || 0) * 100);
      if (!(amt > 0) || amt > balance) { toast('Enter an amount between $0.01 and ' + fmt(balance), 'err'); return; }
      closeModal();
      try {
        const r = await api('/api/checks/' + realId(checkId) + '/comp', 'POST', { manager_pin: pin, reason: 'Comp card: ' + reason, amount_cents: amt });
        toast('Comp card applied — ' + fmt(r.comp_cents) + ' (approved by ' + (r.approved_by || 'manager') + ')', 'ok');
        renderRoute(true);
      } catch (e) { handleApiError(e); }
    };
  };

  const closeBtn = $('#close-check');
  if (closeBtn && !closeBtn.disabled) closeBtn.onclick = () => {    confirmDialog('Close check', 'Close this check? The table will become available.', 'Close check', async () => {
      try {
        if (isOffline()) {
          if (String(checkId).startsWith('tmp-')) {
            const d = JSON.parse(localStorage.getItem('expoline.draft:' + checkId));
            d.status = 'closed';
            localStorage.setItem('expoline.draft:' + checkId, JSON.stringify(d));
          }
          await Outbox.enqueue('close', { check_id: realId(checkId) });
          toast('Close queued', 'ok');
        } else {
          await api('/api/checks/' + realId(checkId) + '/close', 'POST');
          toast('Check closed ✓', 'ok');
        }
      } catch (e) { handleApiError(e); return; }
      location.hash = '#/floor';
    });
  };

  /* Phase 3C — post-payment review nudge: guest-optional, once per check,
     dismissible, never blocks payment. */
  if (t.balance <= 0 && state.reviewPrompt && !state.reviewNudged[checkId] && typeof reviewNudge === 'function') {
    state.reviewNudged[checkId] = true;
    try { reviewNudge($('#review-nudge-slot'), api, realId(checkId)); } catch (e) { /* non-fatal */ }
  }
}

/* ============================================================
   Printable guest receipt. The pay/check summary is the live receipt
   surface; this renders a clean print-only copy with the same numbers:
   every line item, subtotal, surcharge, the mandatory service charge
   (labeled as NOT a tip), tax, total, payments/tips, and the
   accountant disclaimer. Never invents values — all from server totals.
   ============================================================ */
function printReceipt(check, t, items, sc) {
  const rows = (items || []).map((i) => {
    const q = i.qty || 1, p = i.price_cents || 0;
    return '<tr><td>' + esc(i.name || 'Item') + (q > 1 ? ' × ' + q : '') + '</td><td class="r">' + fmt(p * q) + '</td></tr>';
  }).join('');
  const payRows = (check.payments || []).map((p) => '<tr><td>' + esc(p.method === 'card_demo' ? 'Card' : (p.method || 'Payment')) +
    (p.brand ? ' · ' + esc(p.brand) : '') + (p.last4 ? ' ••••' + esc(p.last4) : '') +
    (p.tip_cents ? ' <span class="dim">+ ' + fmt(p.tip_cents) + ' tip</span>' : '') +
    '</td><td class="r">' + fmt(p.amount_cents || 0) + '</td></tr>').join('');
  const when = new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' });
  const html = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Receipt — Bali Hai</title>' +
    '<style>body{font-family:Georgia,serif;max-width:340px;margin:0 auto;padding:16px;color:#111}' +
    'h1{font-size:20px;text-align:center;margin:4px 0}h2{font-size:14px;text-align:center;font-weight:normal;margin:0 0 12px}' +
    'table{width:100%;border-collapse:collapse;font-size:13px}td{padding:3px 0;vertical-align:top}' +
    '.r{text-align:right;white-space:nowrap}.tot td{border-top:1px solid #111;font-weight:bold;font-size:15px}' +
    '.note{font-size:11px;color:#444;margin:8px 0}.ctr{text-align:center}.dim{color:#555}' +
    '@media print{body{padding:0}.noprint{display:none}}</style></head><body>' +
    '<h1>Bali Hai Restaurant</h1><h2>Guest receipt</h2>' +
    '<p class="ctr dim" style="font-size:12px">' + esc(check.table_label || 'Check') +
    ' · ' + (check.guest_count || check.guests || 0) + ' guests · ' + esc(when) + '</p>' +
    '<table>' + rows +
    '<tr><td>Subtotal</td><td class="r">' + fmt(t.subtotal) + '</td></tr>' +
    (t.surcharge ? '<tr><td>' + pctLabel(sc.surcharge_pct) + ' surcharge</td><td class="r">' + fmt(t.surcharge) + '</td></tr>' : '') +
    (t.service_charge ? '<tr><td>' + pctLabel(sc.service_charge_pct) + ' service charge<br><span class="dim">' + sc.service_charge_min_guests + '+ guests · mandatory — NOT a tip</span></td><td class="r">' + fmt(t.service_charge) + '</td></tr>' : '') +
    '<tr><td>Tax</td><td class="r">' + fmt(t.tax) + '</td></tr>' +
    (t.comp ? '<tr><td>Comp (manager approved)</td><td class="r">−' + fmt(t.comp) + '</td></tr>' : '') +
    '<tr class="tot"><td>Total</td><td class="r">' + fmt(t.total) + '</td></tr></table>' +
    (payRows ? '<table style="margin-top:8px">' + payRows +
      '<tr><td>Paid</td><td class="r">' + fmt(t.paid) + '</td></tr>' +
      '<tr><td>Balance due</td><td class="r">' + fmt(Math.max(0, t.balance)) + '</td></tr></table>' : '') +
    (t.service_charge ? '<p class="note">The service charge is mandatory restaurant revenue, not a tip — it is never auto-distributed as tips, and it is taxed as part of the sale in CA.</p>' : '') +
    '<p class="note">Tax treatment follows CA CDTFA guidance for mandatory service charges. This receipt is not tax or legal advice — confirm with your accountant.</p>' +
    '<p class="ctr dim" style="font-size:12px">Thank you — please come again</p>' +
    '<p class="ctr noprint"><button onclick="window.print()" style="font-size:16px;padding:10px 24px">Print</button></p>' +
    '<script>window.onload=function(){window.print()}<\/script></body></html>';
  const w = window.open('', '_blank', 'width=400,height=700');
  if (!w) { toast('Popup blocked — allow popups to print the receipt', 'err'); return; }
  w.document.write(html);
  w.document.close();
}

/* ============================================================
   VIEW: MANAGER (manager only)
   ============================================================ */
function mgrGuard(app) {
  if (!state.user || state.user.role !== 'manager') { app.innerHTML = notAuthorized('Manager area — please log in as a manager.'); return false; }
  return true;
}
function mgrNav(active) {
  return '<div class="tabs">' +
    [['#/manager', 'Overview', active === 'overview'], ['#/manager/finance', 'Finance & Payouts', active === 'finance'],
     ['#/manager/shift', 'Shift report', active === 'shift'], ['#/manager/menu', 'Menu', active === 'menu'],
     ['#/manager/floorplan', 'Floor plan', active === 'floorplan'], ['#/manager/timeclock', 'Time clock', active === 'timeclock'],
     ['#/manager/employees', 'Employees', active === 'employees'],
     ['#/manager/cash', 'Cash drawer', active === 'cash'], ['#/manager/schedule', 'Schedule', active === 'schedule'],
     ['#/manager/analytics', 'Product mix', active === 'analytics'], ['#/manager/insights', 'Insights', active === 'insights'], ['#/manager/notes', 'Staff notes', active === 'notes'],
     ['#/manager/reviews', 'Reviews', active === 'reviews'], ['#/manager/inventory', 'Inventory', active === 'inventory'],
     ['#/manager/multisite', 'Locations', active === 'multisite'], ['#/manager/apidocs', 'API docs', active === 'apidocs'],
     ['#/manager/settings', 'Settings', active === 'settings']]
      .map(([h, l, a]) => '<a class="tab' + (a ? ' active' : '') + '" href="' + h + '">' + l + '</a>').join('') + '</div>';
}

async function renderManager(app) {
  if (!mgrGuard(app)) return;
  let o = {};
  try { o = await api('/api/manager/overview'); } catch (e) { if (handleApiError(e) === 'bounced') return; }
  const t = o.today || {};
  const sales = t.sales_cents ?? o.today_sales_cents ?? o.sales_cents ?? o.net_sales_cents ?? 0;
  const open = t.open_checks ?? o.open_checks ?? o.open_check_count ?? 0;
  const covers = t.covers ?? o.covers ?? o.today_covers ?? 0;
  app.innerHTML = '<div class="view-head"><h1>Manager</h1></div>' + mgrNav('overview') +
    '<div class="stat-grid">' +
    '<div class="stat"><div class="k">Today sales</div><div class="v">' + fmt(sales) + '</div></div>' +
    '<div class="stat"><div class="k">Open checks</div><div class="v amber">' + open + '</div></div>' +
    '<div class="stat"><div class="k">Covers</div><div class="v">' + covers + '</div></div>' +
    '</div><p class="muted small mt">Detailed reconciliation lives under Finance &amp; Payouts — every fee named, no “Other” bucket.</p>' +
    '<div class="card mt"><h3>Service</h3><p class="muted small">Turn-time target drives the floor timer badges — <span class="pill">ok</span> under 75%, <span class="pill held">watch</span> 75–100%, <span class="pill sent">over</span> past target.</p>' +
    '<div class="field"><label for="turn-target">Turn-time target (minutes)</label><input type="number" id="turn-target" min="15" max="240" style="max-width:140px"></div>' +
    '<button class="btn btn-primary btn-sm" id="turn-save">Save</button></div>';

  try {
    const tt = await api('/api/admin/floor/config');
    $('#turn-target').value = tt.turn_time_target_min != null ? tt.turn_time_target_min : 90;
  } catch (e) { /* leave blank */ }
  $('#turn-save').onclick = async () => {
    const v = Number($('#turn-target').value);
    if (!Number.isInteger(v) || v < 15 || v > 240) { toast('Enter 15–240 minutes', 'err'); return; }
    try { await api('/api/admin/floor/config', 'PUT', { turn_time_target_min: v }); toast('Turn target saved', 'ok'); }
    catch (e) { handleApiError(e); }
  };
}

/* ============================================================
   VIEW: SETTINGS — service charge (manager)
   A mandatory service charge is restaurant revenue, NOT a tip: it is never
   auto-distributed to staff and never appears in tip lines or the Tips
   report. In California it is part of the taxable sale (CDTFA Publication 22,
   Jan 2025; Annotation 550.0740). Changes require a live manager PIN and are
   audit-logged with before/after values. This screen is not tax or legal
   advice — confirm with your accountant.
   ============================================================ */
async function renderSvcChargeSettings(app) {
  if (!mgrGuard(app)) return;
  app.innerHTML = '<div class="view-head"><h1>Settings</h1></div>' + mgrNav('settings') +
    '<div class="card"><h2>Large-party service charge</h2>' +
    '<p class="muted small">A mandatory service charge is <b>restaurant revenue, not a tip</b> — it is never auto-distributed as tips and never appears in tip lines or the Tips report. In California it is part of the taxable sale (CDTFA Publication 22, Jan 2025; Annotation 550.0740). This screen is not tax or legal advice — <b>confirm with your accountant</b>.</p>' +
    '<div class="form-grid">' +
    '<label>Charge %<input type="number" id="sc-pct" min="0" max="50" step="0.1" inputmode="decimal" placeholder="18"></label>' +
    '<label>Min guests (threshold)<input type="number" id="sc-min" min="0" max="99" step="1" inputmode="numeric" placeholder="8"></label>' +
    '<label>Manager PIN<input type="password" id="sc-pin" inputmode="numeric" maxlength="8" placeholder="••••" style="max-width:140px"></label>' +
    '</div>' +
    '<p class="muted small">The percentage applies to the check subtotal for parties at or above the threshold. Set the threshold to <b>0</b> to disable the charge entirely. Sales tax is computed on subtotal + surcharge + service charge − comps.</p>' +
    '<button class="btn btn-primary" id="sc-save">Save changes</button></div>' +
    '<div class="card mt"><h2>Cash drawer closeout</h2>' +
    '<p class="muted small">Who may perform the blind drawer close. <b>Manager-only</b> is the safe default: only a manager enters the counted cash while the server computes expected vs. counted. Relaxing to <b>Servers too</b> lets servers close the drawer themselves (the count stays blind — they never see expected).</p>' +
    '<div class="form-grid">' +
    '<label>Who may close the drawer<select id="dr-role"><option value="manager">Manager-only</option><option value="server">Servers too</option></select></label>' +
    '<label>Manager PIN<input type="password" id="dr-pin" inputmode="numeric" maxlength="8" placeholder="••••" style="max-width:140px"></label>' +
    '</div>' +
    '<button class="btn btn-primary" id="dr-save">Save drawer policy</button></div>' +
    '<div class="card mt"><h3>Change history</h3><p class="muted small">Every change is audit-logged with before/after values.</p>' +
    '<div class="t-scroll"><table class="t-table" id="sc-audit">' +
    '<thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Detail</th></tr></thead>' +
    '<tbody><tr><td colspan="4" class="muted">Loading…</td></tr></tbody></table></div></div>';

  const summarize = (r) => {
    try {
      const b = JSON.parse(r.before_json || '{}'), a = JSON.parse(r.after_json || '{}');
      const bits = [];
      if (a.service_charge_pct !== undefined && a.service_charge_pct !== b.service_charge_pct)
        bits.push('charge ' + pctLabel(b.service_charge_pct || 0) + ' → ' + pctLabel(a.service_charge_pct));
      if (a.service_charge_min_guests !== undefined && a.service_charge_min_guests !== b.service_charge_min_guests)
        bits.push('threshold ' + (b.service_charge_min_guests ?? '?') + ' → ' + (a.service_charge_min_guests ?? '?'));
      return (bits.length ? bits.join('; ') : 'no value change') +
        (a.approver && a.approver !== r.actor ? ' (PIN by ' + a.approver + ')' : '');
    } catch (e) { return ''; }
  };

  const load = async () => {
    try {
      const cfg = await api('/api/admin/service-charge/config');
      $('#sc-pct').value = (cfg.current.service_charge_pct * 100).toString();
      $('#sc-min').value = String(cfg.current.service_charge_min_guests);
    } catch (e) { if (handleApiError(e) === 'bounced') return; }
    let rows = [];
    try { rows = await api('/api/admin/service-charge/audit?limit=60'); } catch (e) { rows = []; }
    $('#sc-audit tbody', app).innerHTML = rows.length ? rows.map((r) =>
      '<tr><td class="small">' + esc(fmtDateTime(r.created_at)) + '</td>' +
      '<td>' + esc(r.actor || '—') + '</td>' +
      '<td><span class="pill staged">' + esc(r.action) + '</span></td>' +
      '<td class="small">' + esc(summarize(r)) + '</td></tr>'
    ).join('') : '<tr><td colspan="4" class="muted">No changes yet.</td></tr>';
  };

  $('#sc-save').onclick = async () => {
    const pct = parseFloat($('#sc-pct').value);
    const min = parseInt($('#sc-min').value, 10);
    const pin = $('#sc-pin').value;
    if (!pin) { toast('Enter your manager PIN to save', 'err'); return; }
    const saves = [];
    if (isFinite(pct)) saves.push(['service_charge_pct', pct / 100]);
    if (Number.isInteger(min)) saves.push(['service_charge_min_guests', min]);
    if (!saves.length) { toast('Enter a charge % and/or a threshold', 'err'); return; }
    try {
      for (const [key, value] of saves)
        await api('/api/admin/service-charge/config', 'PUT', { key, value, manager_pin: pin });
      $('#sc-pin').value = '';
      toast('Service charge updated', 'ok');
      await load();
    } catch (e) { handleApiError(e); }
  };

  $('#dr-save').onclick = async () => {
    const value = $('#dr-role').value;
    const pin = $('#dr-pin').value;
    if (!pin) { toast('Enter your manager PIN to save', 'err'); return; }
    try {
      await api('/api/admin/drawer/config', 'PUT', { value, manager_pin: pin });
      $('#dr-pin').value = '';
      toast('Drawer close policy updated', 'ok');
      await load();
    } catch (e) { handleApiError(e); }
  };

  const loadDrawer = async () => {
    try {
      const cfg = await api('/api/admin/drawer/config');
      $('#dr-role').value = cfg.drawer_close_role === 'server' ? 'server' : 'manager';
    } catch (e) { /* leave default */ }
  };
  await load();
  await loadDrawer();
}

/* ============================================================
   VIEW: EMPLOYEES (manager)
   Employee records: list, add, edit, deactivate. PINs are never
   displayed or returned by the API. Deactivation blocks login and
   clock-in. Every change lands in the approval audit below.
   ============================================================ */
async function renderEmployees(app) {
  if (!mgrGuard(app)) return;
  app.innerHTML = '<div class="view-head"><h1>Employees</h1><span class="spacer"></span>' +
    '<button class="btn btn-primary" id="emp-add">+ Add employee</button></div>' + mgrNav('employees') +
    '<div class="card"><div class="t-scroll"><table class="t-table" id="emp-table">' +
    '<thead><tr><th>#</th><th>Name</th><th>Role</th><th>Wage</th><th>Status</th><th></th></tr></thead>' +
    '<tbody><tr><td colspan="6" class="muted">Loading…</td></tr></tbody></table></div>' +
    '<p class="muted small mt">Employee # and PIN must be unique. Deactivating keeps payroll history but blocks login and clock-in.</p></div>' +
    '<div class="card mt"><h3>Manager approvals</h3><p class="muted small">Voids, comps, time adjustments, employee changes — who approved what, and when.</p>' +
    '<div class="t-scroll"><table class="t-table" id="audit-table">' +
    '<thead><tr><th>When</th><th>Action</th><th>Actor</th><th>Approver</th><th>Detail</th></tr></thead>' +
    '<tbody><tr><td colspan="5" class="muted">Loading…</td></tr></tbody></table></div></div>';

  const roleName = (r) => ({ server: 'Server', kitchen: 'Kitchen', manager: 'Manager' }[r] || r);

  const summarize = (r) => {
    try {
      const d = JSON.parse(r.details || '{}');
      if (r.action === 'void_item') return 'Item ' + (r.item_id || d.item_id || '?') + ' on check ' + (r.check_id || d.check_id || '?') + (d.reason ? ' — “' + d.reason + '”' : '');
      if (r.action === 'comp') return fmt(d.added_cents || 0) + ' on check ' + (r.check_id || '?') + (d.reason ? ' — “' + d.reason + '”' : '');
      if (r.action === 'adjust') {
        const bits = [];
        if (d.before && d.after) {
          if (d.after.clock_in) bits.push('in ' + d.before.clock_in + ' → ' + d.after.clock_in);
          if (d.after.clock_out !== undefined) bits.push('out → ' + (d.after.clock_out || 'reopened'));
        }
        if (d.break) bits.push('break #' + d.break.id);
        return 'Shift ' + (r.shift_id || d.shift_id || '?') + (bits.length ? ': ' + bits.join('; ') : '');
      }
      if (r.action === 'employee.create') return 'Created ' + ((d.after && d.after.name) || '') + ' (#' + ((d.after && d.after.employee_number) || '?') + ')';
      if (r.action === 'employee.update') return 'Updated ' + (((d.after && d.after.name) || (d.before && d.before.name)) || ('#' + d.employee_id));
      if (r.action === 'employee.deactivate') return 'Deactivated ' + ((d.before && d.before.name) || ('#' + d.employee_id));
      return '';
    } catch (e) { return ''; }
  };

  const load = async () => {
    let emps = [];
    try { emps = await api('/api/admin/employees'); }
    catch (e) { if (handleApiError(e) === 'bounced') return; emps = []; }
    $('#emp-table tbody', app).innerHTML = emps.length ? emps.map((e) =>
      '<tr><td><b>' + e.employee_number + '</b></td>' +
      '<td>' + esc(e.name) + '</td><td>' + esc(roleName(e.role)) + '</td>' +
      '<td>' + fmt(e.wage_rate_cents) + '/hr</td>' +
      '<td>' + (e.active ? '<span class="pill sent">active</span>' : '<span class="pill held">inactive</span>') + '</td>' +
      '<td style="white-space:nowrap"><button class="btn btn-ghost btn-sm" data-edit="' + e.id + '">Edit</button> ' +
      (e.active ? '<button class="btn btn-ghost btn-sm" data-deact="' + e.id + '" data-nm="' + esc(e.name) + '">Deactivate</button>' : '') + '</td></tr>'
    ).join('') : '<tr><td colspan="6" class="muted">No employees yet.</td></tr>';

    let rows = [];
    try { rows = await api('/api/admin/approvals/audit?limit=60'); } catch (e) { rows = []; }
    $('#audit-table tbody', app).innerHTML = rows.length ? rows.map((r) =>
      '<tr><td class="small">' + esc(fmtDateTime(r.created_at)) + '</td>' +
      '<td><span class="pill staged">' + esc(r.action) + '</span></td>' +
      '<td>' + esc(r.actor || '—') + '</td><td>' + esc(r.approver || '—') + '</td>' +
      '<td class="small">' + esc(summarize(r)) + '</td></tr>'
    ).join('') : '<tr><td colspan="5" class="muted">No approvals yet.</td></tr>';

    $$('[data-edit]', app).forEach((b) => b.onclick = () => openEmpForm(emps.find((e) => String(e.id) === b.dataset.edit)));
    $$('[data-deact]', app).forEach((b) => b.onclick = () => {
      confirmDialog('Deactivate employee', 'Deactivate ' + b.dataset.nm + '? They will no longer be able to log in or clock in. History is kept.', 'Deactivate', async () => {
        try { await api('/api/admin/employees/' + b.dataset.deact, 'DELETE'); toast('Employee deactivated', 'ok'); load(); }
        catch (e) { handleApiError(e); }
      });
    });
  };

  const openEmpForm = async (emp) => {
    let nextNum = '';
    try { const n = await api('/api/admin/employees/next-number'); nextNum = n.employee_number; } catch (e) { /* ignore */ }
    const bd = openModal('<h2>' + (emp ? 'Edit employee' : 'Add employee') + '</h2>' +
      '<label class="fld">Name <input id="ef-name" maxlength="60" value="' + esc(emp ? emp.name : '') + '"></label>' +
      '<label class="fld">Role <select id="ef-role">' +
      ['server', 'kitchen', 'manager'].map((r) => '<option value="' + r + '"' + (emp && emp.role === r ? ' selected' : '') + '>' + roleName(r) + '</option>').join('') +
      '</select></label>' +
      '<label class="fld">Employee # <input id="ef-num" inputmode="numeric" value="' + (emp ? emp.employee_number : nextNum) + '"></label>' +
      '<label class="fld">PIN (4 digits)' + (emp ? ' <span class="muted small">— blank keeps current</span>' : '') + ' <input id="ef-pin" inputmode="numeric" maxlength="4" placeholder="' + (emp ? '••••' : 'e.g. 1234') + '"></label>' +
      '<label class="fld">Wage ($/hr) <input id="ef-wage" type="number" min="0" step="0.01" inputmode="decimal" value="' + ((emp ? emp.wage_rate_cents : 0) / 100).toFixed(2) + '"></label>' +
      (emp ? '<label class="fld"><input type="checkbox" id="ef-active" style="width:auto;display:inline-block;margin-right:8px"' + (emp.active ? ' checked' : '') + '> Active (login + clock-in allowed)</label>' : '') +
      '<div class="modal-actions"><button class="btn btn-ghost" data-x="c">Cancel</button>' +
      '<button class="btn btn-primary" data-x="go">' + (emp ? 'Save' : 'Add employee') + '</button></div>');
    $('[data-x="c"]', bd).onclick = closeModal;
    $('[data-x="go"]', bd).onclick = async () => {
      const body = {
        name: $('#ef-name', bd).value.trim(),
        role: $('#ef-role', bd).value,
        employee_number: Number($('#ef-num', bd).value),
        wage_rate_cents: Math.round(parseFloat($('#ef-wage', bd).value || '0') * 100),
      };
      const pin = $('#ef-pin', bd).value.trim();
      if (pin) body.pin = pin; else if (!emp) { toast('PIN is required', 'err'); return; }
      if (emp) body.active = $('#ef-active', bd).checked;
      try {
        await api('/api/admin/employees' + (emp ? '/' + emp.id : ''), emp ? 'PUT' : 'POST', body);
        closeModal(); toast(emp ? 'Employee saved' : 'Employee added', 'ok'); load();
      } catch (e) { handleApiError(e); }
    };
  };

  $('#emp-add', app).onclick = () => openEmpForm(null);
  await load();
}

/* ============================================================
   VIEW: FLOOR PLAN EDITOR (manager)
   Drag-and-drop floor layout. Mouse + touch (pointer events),
   20px snap-to-grid, 56px+ touch targets, undo, explicit save.
   Zone tints are quiet neutrals — never a status hue (DESIGN.md).
   ============================================================ */
const FP_SNAP = 20;
const FP_TINTS = ['fpz0', 'fpz1', 'fpz2', 'fpz3', 'fpz4', 'fpz5'];

async function renderFloorPlan(app) {
  if (!mgrGuard(app)) return;
  const fp = { zones: [], activeZone: null, sel: null, undo: [], saved: '', nextNeg: -1 };

  app.innerHTML =
    '<div class="view-head"><h1>Floor plan</h1><span class="spacer"></span>' +
    '<button class="btn btn-ghost" id="fp-undo" disabled>↩ Undo</button> ' +
    '<button class="btn btn-primary" id="fp-save" disabled>Save<span class="fp-dot hidden" id="fp-dot"></span></button></div>' +
    mgrNav('floorplan') +
    '<div class="fp-toolbar">' +
    '<span class="muted small">Template:</span> ' +
    '<button class="btn btn-ghost btn-sm" data-tpl="current">Current layout</button>' +
    '<button class="btn btn-ghost btn-sm" data-tpl="empty">Empty</button>' +
    '<button class="btn btn-ghost btn-sm" data-tpl="cafe">Small café</button>' +
    '<span class="spacer"></span>' +
    '<button class="btn btn-ghost btn-sm" id="fp-add-zone">+ Zone</button> ' +
    '<button class="btn btn-primary btn-sm" id="fp-add-table">+ Table</button></div>' +
    '<div id="fp-warn"></div>' +
    '<div class="tabs" id="fp-tabs"></div>' +
    '<div class="fp-body"><div class="fp-canvas-wrap"><div class="fp-canvas" id="fp-canvas"></div></div>' +
    '<div class="fp-inspector" id="fp-inspector"></div></div>' +
    '<div class="card fp-zones"><h3>Zones</h3><div id="fp-zone-list"></div></div>' +
    '<p class="muted small">Drag tables to arrange them — they snap to the grid. Changes stay on this screen until you press <b>Save</b>.</p>';

  const canvas = $('#fp-canvas'), inspector = $('#fp-inspector');
  const snap = (v) => Math.round(v / FP_SNAP) * FP_SNAP;
  const tblSize = (seats) => Math.max(56, Math.min(112, 64 + (seats || 4) * 4));
  const findTable = (id) => { for (const z of fp.zones) { const t = z.tables.find((t) => String(t.id) === String(id)); if (t) return { t, z }; } return null; };
  const snapState = () => JSON.stringify(fp.zones.map((z) => ({ id: z.id, name: z.name, tables: z.tables.map((t) => ({ id: t.id, label: t.label, seats: t.seats, x: t.x, y: t.y, shape: t.shape })) })));
  const isDirty = () => snapState() !== fp.saved;
  const tintOf = (zoneId) => FP_TINTS[fp.zones.findIndex((z) => String(z.id) === String(zoneId)) % FP_TINTS.length] || 'fpz0';

  function refreshChrome() {
    const dirty = isDirty();
    window.__fpDirty = dirty;
    $('#fp-save').disabled = !dirty;
    $('#fp-dot').classList.toggle('hidden', !dirty);
    $('#fp-undo').disabled = !fp.undo.length;
  }
  function pushUndo() { fp.undo.push(snapState()); if (fp.undo.length > 50) fp.undo.shift(); }
  function mutate(fn) { pushUndo(); fn(); fp.sel = null; draw(); refreshChrome(); }
  function doUndo() {
    if (!fp.undo.length) return;
    fp.zones = JSON.parse(fp.undo.pop());
    if (fp.sel && !findTable(fp.sel)) fp.sel = null;
    if (!fp.zones.some((z) => String(z.id) === String(fp.activeZone))) fp.activeZone = fp.zones.length ? fp.zones[0].id : null;
    draw(); refreshChrome(); toast('Undone', 'ok');
  }

  /* ---- load + auto-layout (client-side grid for tables without x/y) ---- */
  async function load() {
    let zones;
    try { zones = await api('/api/admin/zones'); }
    catch (e) { if (handleApiError(e) === 'bounced') return false; app.innerHTML = '<div class="empty">Could not load floor plan.</div>'; return false; }
    fp.zones = zones.map((z) => ({ id: z.id, name: z.name, tables: z.tables.map((t) => ({ ...t })) }));
    let laidOut = 0;
    for (const z of fp.zones) {
      let i = 0;
      for (const t of z.tables) {
        if (t.x == null || t.y == null) { t.x = 40 + (i % 4) * 180; t.y = 40 + Math.floor(i / 4) * 150; laidOut++; }
        i++;
      }
    }
    fp.activeZone = fp.zones.length ? fp.zones[0].id : null;
    fp.undo = []; fp.sel = null;
    fp.saved = snapState();
    // First save persists the auto-layout so the grid isn't lost.
    if (laidOut) { fp.saved = JSON.stringify([]); }
    window.__fpGuard = { hash: location.hash };
    refreshChrome();
    return true;
  }

  /* ---- drawing ---- */
  function draw() { drawWarn(); drawTabs(); drawCanvas(); drawInspector(); drawZoneList(); }
  function drawWarn() {
    const seen = new Map(), dupes = new Set();
    for (const z of fp.zones) for (const t of z.tables) {
      const k = t.label.toLowerCase();
      if (seen.has(k)) dupes.add(t.label);
      seen.set(k, (seen.get(k) || 0) + 1);
    }
    $('#fp-warn').innerHTML = dupes.size
      ? '<div class="fp-warn">⚠ Duplicate table label' + (dupes.size > 1 ? 's' : '') + ': ' +
        [...dupes].map((d) => '<b>' + esc(d) + '</b>').join(', ') +
        ' — rename one of each so every table saves cleanly.</div>'
      : '';
  }
  function drawTabs() {
    const tabs = $('#fp-tabs');
    tabs.innerHTML = fp.zones.map((z) =>
      '<button class="tab' + (String(z.id) === String(fp.activeZone) ? ' active' : '') + '" data-z="' + esc(String(z.id)) + '">' +
      esc(z.name) + '<span class="count">' + z.tables.length + '</span></button>').join('') ||
      '<span class="muted small">No zones yet — add one to get started.</span>';
    $$('.tab', tabs).forEach((b) => { b.onclick = () => { fp.activeZone = fp.zones.find((z) => String(z.id) === b.dataset.z).id; fp.sel = null; draw(); }; });
  }
  function drawCanvas() {
    const z = fp.zones.find((x) => String(x.id) === String(fp.activeZone));
    canvas.innerHTML = '';
    if (!z) { canvas.innerHTML = '<div class="fp-hint muted">Select a zone, then add tables.</div>'; return; }
    let maxX = 0, maxY = 0;
    for (const t of z.tables) { maxX = Math.max(maxX, t.x + tblSize(t.seats)); maxY = Math.max(maxY, t.y + tblSize(t.seats)); }
    canvas.style.width = Math.max(1100, maxX + 160) + 'px';
    canvas.style.height = Math.max(600, maxY + 160) + 'px';
    for (const t of z.tables) {
      const s = tblSize(t.seats);
      const d = document.createElement('div');
      d.className = 'fp-table ' + tintOf(z.id) + (t.shape === 'round' ? ' round' : '') + (String(t.id) === String(fp.sel) ? ' sel' : '');
      d.style.left = t.x + 'px'; d.style.top = t.y + 'px';
      d.style.width = s + 'px'; d.style.height = s + 'px';
      d.dataset.tid = t.id;
      d.setAttribute('role', 'button');
      d.setAttribute('aria-label', 'Table ' + t.label + ', ' + t.seats + ' seats. Drag to move, tap to edit.');
      d.innerHTML = '<span class="fp-label">' + esc(t.label) + '</span><span class="fp-sub">' + t.seats + ' seats</span>';
      canvas.appendChild(d);
      bindDrag(d, t);
    }
  }
  function bindDrag(el, t) {
    let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false, down = false;
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try { el.setPointerCapture(e.pointerId); } catch (err) { /* synthetic events or no active pointer */ }
      const r = canvas.getBoundingClientRect();
      sx = e.clientX - r.left; sy = e.clientY - r.top; ox = t.x; oy = t.y;
      dragging = false; down = true;
    });
    el.addEventListener('pointermove', (e) => {
      if (!down) return;
      const r = canvas.getBoundingClientRect();
      const cx = e.clientX - r.left, cy = e.clientY - r.top;
      if (!dragging && Math.hypot(cx - sx, cy - sy) < 6) return;
      if (!dragging) { dragging = true; pushUndo(); el.classList.add('dragging'); }
      const s = tblSize(t.seats);
      t.x = Math.max(0, snap(ox + (cx - sx) - s / 2));
      t.y = Math.max(0, snap(oy + (cy - sy) - s / 2));
      el.style.left = t.x + 'px'; el.style.top = t.y + 'px';
    });
    const end = () => {
      if (!down) return;
      down = false;
      if (dragging) { el.classList.remove('dragging'); fp.sel = t.id; draw(); refreshChrome(); }
      else { fp.sel = t.id; draw(); }
      dragging = false;
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  /* ---- inspector ---- */
  function drawInspector() {
    const found = fp.sel ? findTable(fp.sel) : null;
    if (!found) {
      const z = fp.zones.find((x) => String(x.id) === String(fp.activeZone));
      inspector.innerHTML = '<h3>Nothing selected</h3><p class="muted small">' +
        (z ? 'Tap a table to edit it, or drag it to move it.' : 'Add a zone first, then add tables.') + '</p>';
      return;
    }
    const { t } = found;
    inspector.innerHTML = '<h3>Table ' + esc(t.label) + '</h3>' +
      '<div class="field"><label for="fp-label">Label</label><input id="fp-label" type="text" value="' + esc(t.label) + '" maxlength="12"></div>' +
      '<div class="field"><label>Seats</label><div class="stepper">' +
      '<button data-s="dec" aria-label="Fewer seats">−</button><span class="val" id="fp-seats">' + t.seats + '</span><button data-s="inc" aria-label="More seats">+</button></div></div>' +
      '<div class="field"><label>Shape</label><div class="fp-shape-row">' +
      '<button class="btn btn-ghost btn-sm' + (t.shape === 'square' ? ' active-shape' : '') + '" data-shape="square">▢ Square</button>' +
      '<button class="btn btn-ghost btn-sm' + (t.shape === 'round' ? ' active-shape' : '') + '" data-shape="round">◯ Round</button></div></div>' +
      '<div class="field"><label for="fp-zone">Zone</label><select id="fp-zone">' +
      fp.zones.map((z) => '<option value="' + esc(String(z.id)) + '"' + (String(z.id) === String(t.zone_id) ? ' selected' : '') + '>' + esc(z.name) + '</option>').join('') +
      '</select></div>' +
      '<button class="btn btn-danger btn-block" id="fp-del">Delete table</button>';
    $('#fp-label').addEventListener('change', (e) => {
      const v = e.target.value.trim();
      if (!v) { e.target.value = t.label; toast('Label cannot be empty', 'err'); return; }
      const clash = fp.zones.some((z) => z.tables.some((o) => o !== t && o.label.toLowerCase() === v.toLowerCase()));
      if (clash) { e.target.value = t.label; toast('A table with that label already exists', 'err'); return; }
      pushUndo(); t.label = v; draw(); refreshChrome();
    });
    $('[data-s="dec"]', inspector).onclick = () => { if (t.seats > 1) { pushUndo(); t.seats--; draw(); refreshChrome(); } };
    $('[data-s="inc"]', inspector).onclick = () => { if (t.seats < 20) { pushUndo(); t.seats++; draw(); refreshChrome(); } };
    $$('[data-shape]', inspector).forEach((b) => { b.onclick = () => { pushUndo(); t.shape = b.dataset.shape; draw(); refreshChrome(); }; });
    $('#fp-zone').addEventListener('change', (e) => {
      const nz = fp.zones.find((z) => String(z.id) === e.target.value);
      if (!nz) return;
      pushUndo();
      const old = fp.zones.find((z) => String(z.id) === String(t.zone_id));
      if (old) old.tables = old.tables.filter((o) => o !== t);
      t.zone_id = nz.id; nz.tables.push(t);
      fp.activeZone = nz.id; draw(); refreshChrome();
    });
    $('#fp-del').onclick = () => confirmDialog('Delete table ' + t.label + '?', 'This cannot be undone after saving.', 'Delete', () => {
      pushUndo();
      const zz = fp.zones.find((z) => String(z.id) === String(t.zone_id));
      if (zz) zz.tables = zz.tables.filter((o) => o !== t);
      fp.sel = null; draw(); refreshChrome();
    });
  }

  /* ---- zone management ---- */
  function drawZoneList() {
    const list = $('#fp-zone-list');
    list.innerHTML = fp.zones.map((z) =>
      '<div class="fp-zone-row"><span class="fp-zone-dot ' + tintOf(z.id) + '"></span>' +
      '<input type="text" value="' + esc(z.name) + '" data-zid="' + esc(String(z.id)) + '" maxlength="30" aria-label="Zone name">' +
      '<span class="muted small">' + z.tables.length + ' tables</span>' +
      '<button class="btn btn-ghost btn-sm" data-zdel="' + esc(String(z.id)) + '"' + (z.tables.length ? ' disabled title="Move or delete its tables first"' : '') + '>Delete</button></div>').join('') ||
      '<p class="muted small">No zones yet.</p>';
    $$('input[data-zid]', list).forEach((inp) => {
      inp.addEventListener('change', () => {
        const z = fp.zones.find((x) => String(x.id) === inp.dataset.zid);
        const v = inp.value.trim();
        if (!v) { inp.value = z.name; toast('Zone name cannot be empty', 'err'); return; }
        if (fp.zones.some((o) => o !== z && o.name.toLowerCase() === v.toLowerCase())) { inp.value = z.name; toast('A zone with that name already exists', 'err'); return; }
        pushUndo(); z.name = v; draw(); refreshChrome();
      });
    });
    $$('[data-zdel]', list).forEach((b) => {
      b.onclick = () => confirmDialog('Delete zone?', 'The zone will be removed. Tables must be moved or deleted first.', 'Delete', () => {
        pushUndo();
        fp.zones = fp.zones.filter((z) => String(z.id) !== b.dataset.zdel);
        if (String(fp.activeZone) === b.dataset.zdel) fp.activeZone = fp.zones.length ? fp.zones[0].id : null;
        draw(); refreshChrome();
      });
    });
  }

  /* ---- add table / add zone ---- */
  function suggestLabel() {
    const used = new Set();
    for (const z of fp.zones) for (const t of z.tables) used.add(t.label);
    let n = 1;
    while (used.has(String(n))) n++;
    return String(n);
  }
  $('#fp-add-table').onclick = () => {
    if (!fp.zones.length) { toast('Add a zone first', 'err'); return; }
    let shape = 'square', seats = 4;
    const bd = openModal(
      '<h2>Add table</h2>' +
      '<div class="field"><label for="nt-label">Label</label><input id="nt-label" type="text" value="' + esc(suggestLabel()) + '" maxlength="12"></div>' +
      '<div class="field"><label>Seats</label><div class="stepper"><button data-s="dec">−</button><span class="val" id="nt-seats">4</span><button data-s="inc">+</button></div></div>' +
      '<div class="field"><label>Shape</label><div class="fp-shape-row">' +
      '<button class="btn btn-ghost btn-sm active-shape" data-shape="square">▢ Square</button>' +
      '<button class="btn btn-ghost btn-sm" data-shape="round">◯ Round</button></div></div>' +
      '<div class="modal-actions"><button class="btn btn-ghost" data-x="cancel">Cancel</button>' +
      '<button class="btn btn-primary" data-x="go">Add table</button></div>');
    $$('[data-shape]', bd).forEach((b) => { b.onclick = () => { shape = b.dataset.shape; $$('[data-shape]', bd).forEach((x) => x.classList.toggle('active-shape', x === b)); }; });
    $('[data-s="dec"]', bd).onclick = () => { seats = Math.max(1, seats - 1); $('#nt-seats', bd).textContent = seats; };
    $('[data-s="inc"]', bd).onclick = () => { seats = Math.min(20, seats + 1); $('#nt-seats', bd).textContent = seats; };
    $('[data-x="cancel"]', bd).onclick = closeModal;
    $('[data-x="go"]', bd).onclick = () => {
      const label = $('#nt-label', bd).value.trim();
      if (!label) { toast('Label is required', 'err'); return; }
      if (fp.zones.some((z) => z.tables.some((t) => t.label.toLowerCase() === label.toLowerCase()))) { toast('A table with that label already exists', 'err'); return; }
      closeModal();
      const z = fp.zones.find((x) => String(x.id) === String(fp.activeZone)) || fp.zones[0];
      const id = 'n' + (fp.nextNeg--);
      const n = z.tables.length;
      pushUndo();
      z.tables.push({ id, zone_id: z.id, label, seats, shape, x: 40 + (n % 4) * 180, y: 40 + Math.floor(n / 4) * 150 });
      fp.sel = id; draw(); refreshChrome();
    };
  };
  $('#fp-add-zone').onclick = () => {
    const bd = openModal('<h2>Add zone</h2><div class="field"><label for="nz-name">Zone name</label>' +
      '<input id="nz-name" type="text" placeholder="e.g. Rooftop" maxlength="30"></div>' +
      '<div class="modal-actions"><button class="btn btn-ghost" data-x="cancel">Cancel</button>' +
      '<button class="btn btn-primary" data-x="go">Add zone</button></div>');
    $('[data-x="cancel"]', bd).onclick = closeModal;
    $('[data-x="go"]', bd).onclick = () => {
      const name = $('#nz-name', bd).value.trim();
      if (!name) { toast('Zone name is required', 'err'); return; }
      if (fp.zones.some((z) => z.name.toLowerCase() === name.toLowerCase())) { toast('A zone with that name already exists', 'err'); return; }
      closeModal();
      pushUndo();
      const z = { id: 'zn' + (fp.nextNeg--), name, tables: [] };
      fp.zones.push(z); fp.activeZone = z.id; draw(); refreshChrome();
    };
  };

  /* ---- templates ---- */
  $$('[data-tpl]').forEach((b) => {
    b.onclick = () => {
      const tpl = b.dataset.tpl;
      const apply = () => {
        pushUndo();
        if (tpl === 'current') { load().then((ok) => { if (ok) { draw(); refreshChrome(); } }); return; }
        if (tpl === 'empty') { for (const z of fp.zones) z.tables = []; }
        if (tpl === 'cafe') {
          fp.zones = [{ id: 'zn' + (fp.nextNeg--), name: 'Main', tables: [] }];
          const z = fp.zones[0];
          const defs = [['1', 2, 'round'], ['2', 2, 'round'], ['3', 2, 'round'], ['4', 2, 'round'], ['5', 4, 'square'], ['6', 4, 'square'], ['7', 6, 'square'], ['8', 4, 'round']];
          defs.forEach(([label, seats, shape], i) => {
            z.tables.push({ id: 'n' + (fp.nextNeg--), zone_id: z.id, label, seats, shape, x: 40 + (i % 4) * 180, y: 40 + Math.floor(i / 4) * 150 });
          });
          fp.activeZone = z.id;
        }
        fp.sel = null; draw(); refreshChrome();
      };
      if (tpl === 'empty' || tpl === 'cafe') confirmDialog('Replace layout?', 'This replaces the current tables on screen. Save to keep it, or leave without saving to discard.', 'Replace', apply);
      else apply();
    };
  });

  /* ---- undo / save ---- */
  $('#fp-undo').onclick = doUndo;
  document.addEventListener('keydown', keyHandler);
  function keyHandler(e) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      e.preventDefault(); doUndo();
    }
  }
  window.addEventListener('beforeunload', beforeUnload);
  function beforeUnload(e) { if (window.__fpDirty) { e.preventDefault(); e.returnValue = ''; } }

  $('#fp-save').onclick = async () => {
    const btn = $('#fp-save');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      await saveAll();
      const ok = await load();
      if (ok) { draw(); refreshChrome(); toast('Floor plan saved', 'ok'); }
    } catch (e) {
      toast('Save failed: ' + (e.message || e), 'err');
      refreshChrome();
    }
    btn.innerHTML = 'Save<span class="fp-dot hidden" id="fp-dot"></span>';
    refreshChrome();
  };

  async function saveAll() {
    const saved = JSON.parse(fp.saved || '[]');
    const savedZones = new Map(saved.map((z) => [String(z.id), z]));
    const savedTables = new Map();
    for (const z of saved) for (const t of z.tables) savedTables.set(String(t.id), { ...t, _zone: String(z.id) });
    const failures = [];
    const attempt = async (what, fn) => {
      try { await fn(); } catch (e) { failures.push(what + ': ' + (e.message || e)); }
    };

    // 1. create new zones first (tables need real zone ids)
    for (const z of fp.zones) {
      if (String(z.id).startsWith('zn')) {
        await attempt('Add zone "' + z.name + '"', async () => {
          const r = await api('/api/admin/zones', 'POST', { name: z.name });
          z.id = r.id;
          for (const t of z.tables) t.zone_id = r.id;
        });
      } else if (savedZones.has(String(z.id)) && savedZones.get(String(z.id)).name !== z.name) {
        await attempt('Rename zone "' + z.name + '"', () => api('/api/admin/zones/' + z.id, 'PUT', { name: z.name }));
      }
    }
    // 2. delete removed tables, then create/update the rest
    const curTables = new Map();
    for (const z of fp.zones) for (const t of z.tables) curTables.set(String(t.id), t);
    for (const [id, st] of savedTables) {
      if (!curTables.has(id) && !String(id).startsWith('n')) {
        await attempt('Delete table "' + (st.label || id) + '"', () => api('/api/admin/tables/' + id, 'DELETE'));
      }
    }
    for (const z of fp.zones) {
      for (const t of z.tables) {
        const body = { zone_id: z.id, label: t.label, seats: t.seats, x: Math.round(t.x), y: Math.round(t.y), shape: t.shape };
        if (String(t.id).startsWith('n')) {
          await attempt('Add table "' + t.label + '"', async () => {
            const r = await api('/api/admin/tables', 'POST', body);
            t.id = r.id;
          });
        } else {
          const st = savedTables.get(String(t.id));
          if (!st || st.label !== t.label || st.seats !== t.seats || st.x !== Math.round(t.x) || st.y !== Math.round(t.y) || st.shape !== t.shape || st._zone !== String(z.id)) {
            await attempt('Save table "' + t.label + '"', () => api('/api/admin/tables/' + t.id, 'PUT', body));
          }
        }
      }
    }
    // 3. delete removed zones (now empty)
    for (const [id] of savedZones) {
      if (!fp.zones.some((z) => String(z.id) === String(id)) && !String(id).startsWith('zn')) {
        const sz = savedZones.get(String(id));
        await attempt('Delete zone "' + (sz.name || id) + '"', () => api('/api/admin/zones/' + id, 'DELETE'));
      }
    }
    if (failures.length) throw new Error(failures.length + ' change(s) could not be saved — ' + failures.slice(0, 3).join('; ') + (failures.length > 3 ? '…' : ''));
  }

  /* ---- lifecycle ---- */
  app._cleanup = () => {
    document.removeEventListener('keydown', keyHandler);
    window.removeEventListener('beforeunload', beforeUnload);
    window.__fpGuard = null; window.__fpDirty = false;
  };
  if (await load()) { draw(); refreshChrome(); }
}

/* Honest reconciliation: card volume − refunds − each named Stripe fee
   = expected payout. Tips shown separately ("tips are not taxed").
   Sales date and payout date are distinct columns. */
async function renderFinance(app) {
  if (!mgrGuard(app)) return;
  const date = await siteDate();
  app.innerHTML = '<div class="view-head"><h1>Finance &amp; Payouts</h1><span class="spacer"></span>' +
    '<input type="date" id="fin-date" value="' + date + '" aria-label="Sales date" style="min-height:44px;background:var(--ink);border:1px solid var(--line);border-radius:8px;padding:8px 12px;color:var(--text)"></div>' +
    mgrNav('finance') + '<div id="fin-body"></div>';
  const body = $('#fin-body');
  const load = async () => {
    const d = $('#fin-date').value || date;
    body.innerHTML = '<p class="muted">Loading reconciliation…</p>';
    try {
      const r = await api('/api/finance/payouts?date=' + encodeURIComponent(d));
      body.innerHTML = financeHtml(r, d) + '<div id="pm-section"></div>';
      wireReportExports(d);
      wireProductMix(d);
    } catch (e) { if (handleApiError(e) !== 'bounced') body.innerHTML = '<div class="empty">Could not load payouts.</div>'; }
  };
  $('#fin-date').addEventListener('change', load);
  await load();
}

function financeHtml(r, date) {
  const p = r.payout || r;
  const cardVol = p.card_volume_cents ?? p.cardVolume ?? 0;
  const refunds = p.refunds_cents ?? p.refund_cents ?? 0;
  const tips = p.tips_cents ?? 0;
  const cards = p.card_payments || [];
  // Backend contract: stripe_fees_cents (total) + per-payment fee_cents in card_payments[].
  const feeTotal = p.stripe_fees_cents ?? p.stripe_fee_cents ??
    cards.reduce((a, c) => a + (c.fee_cents || 0), 0);
  const expected = p.expected_payout_cents ?? (cardVol - refunds - feeTotal);
  const salesDate = p.sales_date || p.date || date;
  const payoutDate = p.payout_date || p.estimated_payout_date || '—';
  const feeRows = cards.length
    ? cards.map((c) => '<tr><td>− Stripe fee <span class="lbl-note">DEMO ' + esc(String(c.brand || 'Card')) +
        (c.last4 ? ' ••••' + esc(String(c.last4)) : '') + ' · ' + fmt(c.amount_cents || 0) +
        (c.status && c.status !== 'completed' ? ' · ' + esc(String(c.status)) : '') + '</span></td>' +
        '<td class="num neg">−' + fmt(c.fee_cents || 0) + '</td></tr>').join('')
    : '<tr><td>− Stripe fees' + (feeTotal > 0 ? ' <span class="lbl-note">aggregate only — no per-payment detail</span>' : ' <span class="lbl-note">none</span>') +
      '</td><td class="num neg">−' + fmt(feeTotal) + '</td></tr>';
  const laborCents = p.labor_cents ?? 0;
  const laborDetail = p.labor ? ' <span class="lbl-note">reg ' + fmt(p.labor.reg_cents || 0) +
    (p.labor.ot_cents ? ' · OT ' + fmt(p.labor.ot_cents) : '') +
    (p.labor.premium_cents ? ' · break premiums ' + fmt(p.labor.premium_cents) : '') +
    (p.labor.weekly_ot_cents ? ' · weekly OT ' + fmt(p.labor.weekly_ot_cents) : '') + '</span>' : '';
  return '<div class="date-cols"><div class="date-col"><div class="k">Sales date</div><div class="v">' + esc(String(salesDate)) + '</div></div>' +
    '<div class="date-col"><div class="k">Payout date</div><div class="v">' + esc(String(payoutDate)) + '</div></div></div>' +
    '<div class="card"><h2>Reconciliation</h2><table class="fin-table">' +
    '<tr><td>Card volume</td><td class="num pos">' + fmt(cardVol) + '</td></tr>' +
    '<tr><td>− Refunds</td><td class="num neg">−' + fmt(refunds) + '</td></tr>' +
    feeRows +
    '<tr class="result"><td>= Expected payout</td><td class="num">' + fmt(expected) + '</td></tr>' +
    '</table>' +
    '<table class="fin-table" style="margin-top:14px"><tr><td>Tips (collected separately)</td><td class="num pos">' + fmt(tips) + '</td></tr>' +
    '<tr><td>Service charge <span class="lbl-note">informational — inside card volume, not a tip</span></td><td class="num">' + fmt(p.service_charge_cents ?? 0) + '</td></tr>' +
    '<tr><td>Labor cost (time clock)' + laborDetail + '</td><td class="num">' + fmt(laborCents) + '</td></tr></table>' +
    '<p class="tips-note">Tips are paid out to staff and are not taxed — they never reduce the payout above.</p>' +
    (p.service_charge_cents ? '<p class="muted small">The mandatory service charge is restaurant revenue, already included in card volume — it is never paid out as a tip or wage. Confirm tax treatment with your accountant.</p>' : '') + '</div>' +
    '<p class="muted small">Every fee is itemized by name. There is no “Other” bucket — if a fee exists, it is listed.</p>' +
    reportsExportHtml();
}

const REP_KINDS = [['sales', 'Sales summary'], ['payouts', 'Payout reconciliation'], ['tax', 'Sales tax'], ['labor', 'Labor'], ['tips', 'Tips']];
const REP_FMTS = [['xlsx', 'Excel (.xlsx)'], ['csv', 'CSV'], ['pdf', 'PDF'], ['docx', 'Word (.docx)']];

function reportsExportHtml() {
  return '<div class="card" id="rep-exports"><h2>Accounting exports</h2>' +
    '<p class="muted small">Genuine .xlsx, .csv, .pdf, and .docx files — every report honors the selected range.</p>' +
    '<div class="form-grid">' +
    '<label>Report<select id="rep-kind">' + REP_KINDS.map((k) => '<option value="' + k[0] + '">' + k[1] + '</option>').join('') + '</select></label>' +
    '<label>Range<select id="rep-period"><option value="day">Day</option><option value="week">Week</option>' +
    '<option value="month" selected>Month</option><option value="year">Year</option><option value="custom">Custom…</option></select></label>' +
    '<label id="rep-anchor-wrap">Date<input type="date" id="rep-date"></label>' +
    '<label id="rep-from-wrap" hidden>From<input type="date" id="rep-from"></label>' +
    '<label id="rep-to-wrap" hidden>To<input type="date" id="rep-to"></label>' +
    '</div>' +
    '<div class="btn-row" style="display:flex;gap:10px;flex-wrap:wrap;margin:12px 0">' +
    REP_FMTS.map((f) => '<button class="btn" data-rep-fmt="' + f[0] + '">⤓ ' + f[1] + '</button>').join('') +
    '</div>' +
    '<div class="form-grid"><label>Accountant email<input type="email" id="rep-email" inputmode="email" placeholder="accountant@example.com" autocomplete="email"></label></div>' +
    '<div style="margin:12px 0"><button class="btn btn-primary" id="rep-share">✉ Email report</button></div>' +
    '<p class="muted small">Email sharing downloads the report file and opens a prefilled compose in your mail app — attach the downloaded file before sending. Automated server-side email sending is not set up yet (it needs the restaurant’s email-provider credentials).</p>' +
    '<p class="muted small" id="rep-status" role="status"></p></div>';
}

function repStatus(msg, bad) {
  const el = $('#rep-status');
  if (el) { el.textContent = msg || ''; el.style.color = bad ? 'var(--red)' : ''; }
}

function repQuery() {
  const kind = $('#rep-kind').value;
  const period = $('#rep-period').value;
  let q = 'period=' + encodeURIComponent(period);
  if (period === 'custom') {
    const f = $('#rep-from').value, t = $('#rep-to').value;
    if (!f || !t) { repStatus('Pick a From and To date for a custom range.', true); return null; }
    q += '&from=' + encodeURIComponent(f) + '&to=' + encodeURIComponent(t);
  } else {
    const d = $('#rep-date').value;
    if (d) q += '&date=' + encodeURIComponent(d);
  }
  return { kind, q, period };
}

/* ============================================================
   PRODUCT MIX ANALYTICS — best/worst sellers from honest sales data.
   API: GET /api/finance/product-mix?from=YYYY-MM-DD&to=YYYY-MM-DD
   (manager only). No separate analytics SKU — same data as finance.
   ============================================================ */
function wireProductMix(anchorDate) {
  const sec = document.getElementById('pm-section');
  if (!sec) return;
  // Default: last 7 days ending on the finance date.
  const to = anchorDate;
  const from = (() => { const d = new Date(to + 'T12:00:00'); d.setDate(d.getDate() - 6); return d.toISOString().slice(0, 10); })();
  sec.innerHTML =
    '<div class="card" style="margin-top:18px"><h2>Product mix <span class="muted small">best &amp; worst sellers</span></h2>' +
    '<div class="row" style="gap:8px;align-items:center;margin-bottom:12px">' +
    '<label class="muted small">From <input type="date" id="pm-from" value="' + esc(from) + '" style="min-height:40px"></label>' +
    '<label class="muted small">To <input type="date" id="pm-to" value="' + esc(to) + '" style="min-height:40px"></label>' +
    '<button class="btn btn-primary btn-sm" id="pm-go">Load</button></div>' +
    '<div id="pm-body"><p class="muted">Loading…</p></div></div>';
  const load = async () => {
    const f = document.getElementById('pm-from').value, t = document.getElementById('pm-to').value;
    const body = document.getElementById('pm-body');
    body.innerHTML = '<p class="muted">Loading…</p>';
    try {
      const r = await api('/api/finance/product-mix?from=' + encodeURIComponent(f) + '&to=' + encodeURIComponent(t));
      body.innerHTML = productMixHtml(r);
    } catch (e) { if (handleApiError(e) !== 'bounced') body.innerHTML = '<div class="empty">Could not load product mix.</div>'; }
  };
  document.getElementById('pm-go').onclick = load;
  load();
}

function pmTable(title, rows, key) {
  if (!rows || !rows.length) return '<h3>' + esc(title) + '</h3><p class="muted small">No data in range.</p>';
  const body = rows.map((r, i) =>
    '<tr><td>' + (i + 1) + '</td><td>' + esc(r.name || 'Item') +
    (r.category ? ' <span class="lbl-note">' + esc(r.category) + '</span>' : '') + '</td>' +
    '<td class="num">' + (r.qty_sold || 0) + '</td>' +
    '<td class="num">' + fmt(r.gross_cents || 0) + '</td>' +
    '<td class="num">' + (r.gross_share_pct != null ? r.gross_share_pct + '%' : '—') + '</td>' +
    '<td class="num' + ((r.void_rate_pct || 0) > 5 ? ' neg' : '') + '">' + (r.void_rate_pct != null ? r.void_rate_pct + '%' : '—') + '</td></tr>'
  ).join('');
  return '<h3>' + esc(title) + '</h3><table class="fin-table"><thead><tr>' +
    '<th>#</th><th>Item</th><th class="num">Qty</th><th class="num">Gross</th>' +
    '<th class="num">Share</th><th class="num">Void %</th></tr></thead><tbody>' + body + '</tbody></table>';
}

function productMixHtml(r) {
  const t = r.totals || {};
  const head = '<div class="date-cols">' +
    '<div class="date-col"><div class="k">Items sold</div><div class="v">' + (t.items || 0) + '</div></div>' +
    '<div class="date-col"><div class="k">Quantity</div><div class="v">' + (t.qty_sold || 0) + '</div></div>' +
    '<div class="date-col"><div class="k">Gross</div><div class="v">' + fmt(t.gross_cents || 0) + '</div></div>' +
    '<div class="date-col"><div class="k">Voided qty</div><div class="v">' + (t.voided_qty || 0) + '</div></div></div>' +
    '<p class="muted small">Range: ' + esc(r.from || '') + ' → ' + esc(r.to || '') +
    '. Attribution: items on checks closed in range. Voids counted separately — a popular-but-voided item can’t hide.</p>';
  return head +
    '<div class="pm-grid">' +
    '<div>' + pmTable('Top 10 by quantity', r.best_by_qty) + '</div>' +
    '<div>' + pmTable('Top 10 by revenue', r.best_by_gross) + '</div>' +
    '<div>' + pmTable('Bottom 10 by quantity', r.worst_by_qty) + '</div>' +
    '<div>' + pmTable('Bottom 10 by revenue', r.worst_by_gross) + '</div>' +
    '</div>';
}


async function downloadReportBlob(fmt) {
  const rq = repQuery();
  if (!rq) return null;
  repStatus('Preparing ' + fmt.toUpperCase() + '…');
  const path = '/api/finance/reports/' + rq.kind + '?format=' + fmt + '&' + rq.q;
  const tok = sessionStorage.getItem('expoline.token');
  let res;
  try {
    res = await fetch(API + path, { headers: tok ? { Authorization: 'Bearer ' + tok } : {} });
  } catch (e) { repStatus('Export failed: network unreachable.', true); return null; }
  if (!res.ok) {
    let msg = 'Export failed (' + res.status + ')';
    try { const j = await res.json(); msg = j.error || msg; } catch (e) { /* ignore */ }
    repStatus(msg, true);
    return null;
  }
  const blob = await res.blob();
  const m = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '');
  const name = m ? m[1] : 'expoline-' + rq.kind + '.' + fmt;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 8000);
  repStatus('Downloaded ' + name);
  return { name, kind: rq.kind, period: rq.period, fmt };
}

function wireReportExports(anchorDate) {
  const per = $('#rep-period');
  if (!per) return;
  $('#rep-date').value = anchorDate || '';
  const sync = () => {
    const custom = per.value === 'custom';
    $('#rep-from-wrap').hidden = !custom;
    $('#rep-to-wrap').hidden = !custom;
    $('#rep-anchor-wrap').hidden = custom;
  };
  per.addEventListener('change', sync); sync();
  document.querySelectorAll('[data-rep-fmt]').forEach((b) => {
    b.addEventListener('click', () => { downloadReportBlob(b.getAttribute('data-rep-fmt')); });
  });
  $('#rep-share').addEventListener('click', async () => {
    const dl = await downloadReportBlob('xlsx');
    if (!dl) return;
    const kindName = (REP_KINDS.find((k) => k[0] === dl.kind) || [null, dl.kind])[1];
    const range = dl.period === 'custom' ? 'the selected custom range' : 'the selected ' + dl.period;
    const email = ($('#rep-email').value || '').trim();
    const subject = encodeURIComponent('Expoline ' + kindName + ' — ' + range);
    const bodyText = encodeURIComponent('Hi,\n\nAttached is the Expoline ' + kindName + ' for ' + range + '.\n\n' +
      'Note: the file "' + dl.name + '" just downloaded to this device — please attach it to this email before sending.\n\n— sent from Expoline');
    window.location.href = 'mailto:' + encodeURIComponent(email) + '?subject=' + subject + '&body=' + bodyText;
    repStatus('Downloaded ' + dl.name + ' — opening your mail app. Attach the file before sending.');
  });
}

async function renderShift(app) {
  if (!mgrGuard(app)) return;
  const date = await siteDate();
  app.innerHTML = '<div class="view-head"><h1>Shift report</h1><span class="spacer"></span>' +
    '<input type="date" id="sh-date" value="' + date + '" aria-label="Shift date" style="min-height:44px;background:var(--ink);border:1px solid var(--line);border-radius:8px;padding:8px 12px;color:var(--text)"></div>' +
    mgrNav('shift') + '<div id="sh-body"></div>';
  const body = $('#sh-body');
  const load = async () => {
    const d = $('#sh-date').value || date;
    body.innerHTML = '<p class="muted">Loading shift report…</p>';
    try {
      const r = await api('/api/finance/shift?date=' + encodeURIComponent(d));
      let tp = null;
      try { tp = await api('/api/tipout/report?date=' + encodeURIComponent(d)); } catch (e2) { /* tip-outs optional */ }
      body.innerHTML = shiftHtml(r, d, tp);
      wireTipout(body, d, load);
    } catch (e) { if (handleApiError(e) !== 'bounced') body.innerHTML = '<div class="empty">Could not load shift report.</div>'; }
  };
  $('#sh-date').addEventListener('change', load);
  await load();
}

function shiftHtml(r, date, tp) {
  const s = r.shift || r;
  const closed = s.checks_closed ?? s.closed_checks ?? 0;
  const sub = s.subtotal_cents ?? 0;
  const tips = s.tips_cents ?? 0;
  // Backend contract: card_brand_breakdown is {Brand: cents}, cash_sales_cents is a number.
  const bb = s.card_brand_breakdown || s.card_brands || {};
  const brandNames = Array.isArray(bb) ? [] : Object.keys(bb);
  const brandRows = brandNames.length
    ? brandNames.map((b) => '<tr><td>' + esc(b) + '</td><td class="num">' + fmt(bb[b] || 0) + '</td></tr>').join('')
    : (Array.isArray(bb) && bb.length ? bb.map((b) =>
      '<tr><td>' + esc(b.brand || b.name || 'Card') + ' <span class="muted small">×' + (b.count ?? b.transactions ?? '') + '</span></td><td class="num">' + fmt(b.cents ?? b.amount_cents ?? 0) + '</td></tr>').join('') : '');
  const cashSales = s.cash_sales_cents ?? s.cash?.expected_cents ?? 0;
  const cardTipsOwed = s.cash_owed_to_server_cents ?? 0;
  return '<p class="muted small">Shift date: <b>' + esc(String(s.date || date)) + '</b>' + (s.server_name ? ' · Server: <b>' + esc(s.server_name) + '</b>' : '') + '</p>' +
    '<div class="report-grid">' +
    '<div class="card"><h2>Totals</h2><table class="fin-table">' +
    '<tr><td>Checks closed</td><td class="num">' + closed + '</td></tr>' +
    '<tr><td>Subtotal</td><td class="num">' + fmt(sub) + '</td></tr>' +
    '<tr><td>Tips</td><td class="num">' + fmt(tips) + '</td></tr></table></div>' +
    '<div class="card"><h2>Card brand breakdown</h2>' +
    (brandRows ? '<table class="fin-table">' + brandRows + '</table>'
      : '<p class="muted">No card breakdown returned.</p>') + '</div>' +
    '<div class="card"><h2>Cash reconciliation</h2><table class="fin-table">' +
    '<tr><td>Cash sales</td><td class="num">' + fmt(cashSales) + '</td></tr>' +
    '<tr><td>Card tips owed to server <span class="lbl-note">paid out at checkout</span></td><td class="num">' + fmt(cardTipsOwed) + '</td></tr>' +
    '</table></div></div>' + tipoutHtml(tp);
}

/* ============================================================
   TIP-OUTS / TIP POOLING — pooling rules as data, auto-computed
   at shift review. No spreadsheet.
   ============================================================ */
function tipoutHtml(tp) {
  if (!tp) return '';
  const basisLabel = (b) => ({ food_sales: 'food sales', gross_sales: 'gross sales', tips: 'tips' }[b] || b);
  const rulesRows = (tp.rules || []).map((r) =>
    '<tr><td>' + esc(r.name) + '<div class="muted small">' + esc(r.role) + ' · ' + r.pct + '% of ' + esc(basisLabel(r.basis)) + '</div></td>' +
    '<td class="num"><button class="btn btn-ghost btn-sm" data-tipout-del="' + r.id + '">Remove</button></td></tr>'
  ).join('');
  const serverRows = (tp.servers || []).map((s) => {
    const detail = (s.tipouts || []).map((t) =>
      '<div class="muted small">' + esc(t.name) + ': ' + fmt(t.owed_cents) + ' <span class="lbl-note">(' + t.pct_bps / 100 + '% of ' + fmt(t.basis_cents) + ' ' + esc(basisLabel(t.basis)) + ')</span></div>'
    ).join('');
    return '<tr><td><b>' + esc(s.server_name) + '</b><div class="muted small">tips ' + fmt(s.tips_cents) + ' · food ' + fmt(s.food_sales_cents) + '</div>' + detail + '</td>' +
      '<td class="num">' + fmt(s.total_tipout_cents) + '<div class="muted small">net ' + fmt(s.net_tips_cents) + '</div></td></tr>';
  }).join('');
  const roleRows = (tp.by_role || []).map((x) =>
    '<tr><td>' + esc(x.role) + '</td><td class="num">' + fmt(x.total_owed_cents) + '</td></tr>'
  ).join('');
  return '<div class="card" style="margin-top:12px"><h2>Tip-outs &amp; pooling</h2>' +
    '<p class="muted small">Pooling rules are data — computed from today\'s sales at shift review. ' +
    'Food sales exclude bar drinks; all math in whole cents.</p>' +
    '<div class="report-grid">' +
    '<div><h3>Per server</h3>' + (serverRows ? '<table class="fin-table">' + serverRows + '</table>' : '<p class="muted">No server sales for this date.</p>') + '</div>' +
    '<div><h3>Owed by role</h3>' + (roleRows ? '<table class="fin-table">' + roleRows + '</table>' : '<p class="muted">No rules active.</p>') +
    '<h3 style="margin-top:12px">Rules</h3>' +
    (rulesRows ? '<table class="fin-table">' + rulesRows + '</table>' : '<p class="muted">No pooling rules yet — add one below.</p>') +
    '<div class="row" style="gap:8px;flex-wrap:wrap;margin-top:10px">' +
    '<input id="tp-name" class="input" placeholder="Rule name (e.g. Busser tip-out)" style="flex:2;min-width:160px">' +
    '<input id="tp-role" class="input" placeholder="Role (e.g. busser)" style="flex:1;min-width:100px">' +
    '<select id="tp-basis" class="input" style="flex:1;min-width:110px"><option value="food_sales">% of food sales</option><option value="gross_sales">% of gross sales</option><option value="tips">% of tips</option></select>' +
    '<input id="tp-pct" class="input" inputmode="decimal" placeholder="%" style="width:80px">' +
    '<button class="btn btn-primary btn-sm" id="tp-add">Add rule</button></div>' +
    '<p class="muted small" id="tp-msg" style="margin-top:6px"></p></div></div></div>';
}

function wireTipout(body, date, reload) {
  const add = body.querySelector('#tp-add');
  if (!add) return;
  const msg = body.querySelector('#tp-msg');
  add.onclick = async () => {
    const pct = parseFloat((body.querySelector('#tp-pct').value || '').trim());
    try {
      await api('/api/tipout/rules', 'POST', {
        name: body.querySelector('#tp-name').value,
        role: body.querySelector('#tp-role').value,
        basis: body.querySelector('#tp-basis').value,
        pct_bps: Math.round(pct * 100),
      });
      reload();
    } catch (e) { msg.textContent = (e && e.message) || 'Could not add rule'; }
  };
  body.querySelectorAll('[data-tipout-del]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('Remove this tip-out rule?')) return;
      try { await api('/api/tipout/rules/' + b.dataset.tipoutDel, 'DELETE'); reload(); }
      catch (e) { msg.textContent = (e && e.message) || 'Could not remove rule'; }
    };
  });
}

/* ============================================================
   VIEW: MENU EDITOR (manager only) — phase 2.
   Categories + items CRUD, one-tap 86 toggle, audit log.
   Every mutation broadcasts menu_updated so all devices refresh instantly.
   ============================================================ */
const ME_COURSES = ['drink', 'appetizer', 'entree', 'dessert'];
const ME_TYPES = ['food', 'drink', 'dessert'];
const ME_DAYPARTS = ['LUNCH', 'DINNER', 'DESSERTS', 'KEIKI', 'BAR', 'HAPPY HOUR', 'BRUNCH', 'ALL DAY'];

function meActionLabel(a) {
  return { 'item.86': '86’d', 'item.un86': 'Restored', 'item.create': 'Added item', 'item.update': 'Edited item', 'item.delete': 'Deleted item', 'category.create': 'Added category', 'category.update': 'Edited category', 'category.delete': 'Deleted category' }[a] || a;
}

async function renderMenuViewer(app) {
  if (!mgrGuard(app)) return;
  const me = { cats: [], activeCat: null, showAudit: false };

  app.innerHTML =
    '<div class="view-head"><h1>Menu</h1><span class="spacer"></span>' +
    '<button class="btn btn-ghost btn-sm" id="me-audit-toggle">Recent changes</button> ' +
    '<button class="btn btn-primary btn-sm" id="me-add-cat">+ Category</button></div>' +
    mgrNav('menu') +
    '<div class="tabs" id="me-tabs"></div>' +
    '<div class="me-toolbar"><span class="spacer"></span><button class="btn btn-primary" id="me-add-item">+ Item</button></div>' +
    '<div class="card" id="dp-card"><div class="row" style="align-items:center"><h3 style="margin:0">Daypart schedule</h3><span class="spacer"></span>' +
    '<button class="btn btn-ghost btn-sm" id="dp-toggle">Show</button></div>' +
    '<div id="dp-body" class="hidden">' +
    '<p class="muted small">Windows switch the order menu by the site clock. Times are in America/Los_Angeles. “Also includes” lists extra daypart tags shown during this window (comma-separated).</p>' +
    '<div id="dp-rows"></div>' +
    '<div class="row" style="gap:8px;margin-top:8px"><button class="btn btn-ghost btn-sm" id="dp-add">+ Window</button>' +
    '<button class="btn btn-primary btn-sm" id="dp-save">Save dayparts</button></div></div></div>' +
    '<div id="me-list"><p class="muted">Loading…</p></div>' +
    '<div class="card hidden" id="me-audit-card"><h3>Recent changes</h3><div id="me-audit-list"><p class="muted">Loading…</p></div></div>';

  const cat = () => me.cats.find((c) => String(c.id) === String(me.activeCat));
  async function refresh() { if (await load()) { drawTabs(); drawList(); } }
  async function load() {
    try { me.cats = await api('/api/admin/menu'); }
    catch (e) { if (handleApiError(e) === 'bounced') return false; $('#me-list').innerHTML = '<div class="empty">Could not load menu.</div>'; return false; }
    if (!me.cats.some((c) => String(c.id) === String(me.activeCat))) me.activeCat = me.cats.length ? String(me.cats[0].id) : null;
    return true;
  }

  function drawTabs() {
    $('#me-tabs').innerHTML = me.cats.map((c) => {
      const n86 = c.items.filter((i) => !i.active).length;
      return '<button class="tab' + (String(c.id) === String(me.activeCat) ? ' active' : '') + '" data-c="' + esc(String(c.id)) + '">' +
        esc(c.name) + ' <span class="muted small">' + c.items.length + '</span>' +
        (n86 ? ' <span class="me-n86">' + n86 + ' 86’d</span>' : '') + '</button>';
    }).join('') + (me.cats.length ? '<button class="tab me-manage" id="me-cat-manage" title="Rename or delete this category" aria-label="Manage category">⋯</button>' : '');
    $$('#me-tabs .tab[data-c]').forEach((b) => b.onclick = () => { me.activeCat = b.dataset.c; drawTabs(); drawList(); });
    const mg = $('#me-cat-manage');
    if (mg) mg.onclick = catManage;
  }

  function drawList() {
    const c = cat();
    if (!c) { $('#me-list').innerHTML = '<div class="empty">No categories yet — add one to start building the menu.</div>'; return; }
    $('#me-list').innerHTML = c.items.map((i) => {
      const dead = !i.active;
      const bits = [fmt(i.price_cents), i.course, kdsLabel(i.station)];
      if (i.daypart) bits.push(i.daypart);
      if ((i.modifiers || []).length) bits.push(i.modifiers.length + ' mods');
      if (i.price_note) bits.push(i.price_note);
      return '<div class="me-row' + (dead ? ' is-86' : '') + '">' +
        '<button class="me-86btn' + (dead ? ' restore' : '') + '" data-86="' + i.id + '" aria-pressed="' + dead + '" aria-label="' + (dead ? 'Put back on menu: ' : '86 (sold out): ') + esc(i.name) + '">' +
        (dead ? '↩<span>UN-86</span>' : '86') + '</button>' +
        '<button class="me-main" data-edit="' + i.id + '" aria-label="Edit ' + esc(i.name) + '">' +
        '<span class="me-name">' + esc(i.name) +
        (i.item_type === 'drink' ? ' <span class="drink-tag">BAR</span>' : '') +
        (dead ? ' <span class="me-86badge">86’D</span>' : '') + '</span>' +
        '<span class="me-meta">' + esc(bits.join(' · ')) + '</span>' +
        (i.image_url ? '<span class="me-imgtag">🖼 image set</span>' : '') +
        '</button></div>';
    }).join('') || '<div class="empty">No items in this category yet — tap + Item.</div>';
    $$('#me-list [data-86]').forEach((b) => b.onclick = async () => {
      const id = b.getAttribute('data-86');
      b.disabled = true;
      try {
        const r = await api('/api/admin/menu/86/' + encodeURIComponent(id), 'POST');
        toast(r.eightysixed ? '86’d: ' + r.name : 'Back on menu: ' + r.name, r.eightysixed ? 'err' : 'ok');
        await refresh();
      } catch (e) { handleApiError(e); b.disabled = false; }
    });
    $$('#me-list [data-edit]').forEach((b) => b.onclick = () => openItemModal(b.getAttribute('data-edit')));
  }

  function saveErr(e) {
    if (e instanceof ApiError && (e.status === 401 || e.status === 403)) handleApiError(e);
    else toast(e.message || 'Could not save', 'err');
  }

  /* ---- category modals ---- */
  function openCatModal(id) {
    const c = id ? me.cats.find((x) => String(x.id) === String(id)) : null;
    const bd = openModal('<h2>' + (c ? 'Rename category' : 'New category') + '</h2>' +
      '<div class="field"><label>Name</label><input id="mc-name" value="' + esc(c ? c.name : '') + '" maxlength="60"></div>' +
      '<div class="field"><label>Daypart</label><input id="mc-parent" list="me-dayparts" value="' + esc(c ? (c.parent || '') : '') + '" placeholder="e.g. LUNCH, DINNER, HAPPY HOUR"></div>' +
      '<div class="field"><label>Sort order <span class="muted small">(blank = at the end)</span></label><input id="mc-sort" type="number" inputmode="numeric" value="' + (c ? c.sort : '') + '"></div>' +
      '<datalist id="me-dayparts">' + ME_DAYPARTS.map((d) => '<option value="' + d + '">').join('') + '</datalist>' +
      '<div class="modal-actions"><button class="btn btn-ghost" data-x="cancel">Cancel</button><button class="btn btn-primary" data-x="save">' + (c ? 'Save' : 'Add category') + '</button></div>');
    $('[data-x="cancel"]', bd).onclick = closeModal;
    $('[data-x="save"]', bd).onclick = async () => {
      const body = { name: $('#mc-name', bd).value };
      if ($('#mc-parent', bd).value.trim()) body.parent = $('#mc-parent', bd).value;
      if ($('#mc-sort', bd).value !== '') body.sort = Number($('#mc-sort', bd).value);
      try {
        if (c) await api('/api/admin/menu/categories/' + c.id, 'PUT', body);
        else { const r = await api('/api/admin/menu/categories', 'POST', body); me.activeCat = String(r.id); }
        closeModal(); toast(c ? 'Category saved' : 'Category added', 'ok'); await refresh();
      } catch (e) { saveErr(e); }
    };
  }

  function catManage() {
    const c = cat(); if (!c) return;
    const bd = openModal('<h2>' + esc(c.name) + '</h2>' +
      '<p class="muted small">' + c.items.length + ' item' + (c.items.length === 1 ? '' : 's') + ' · daypart ' + esc(c.parent || '—') + '</p>' +
      '<div class="modal-actions"><button class="btn btn-ghost" data-x="cancel">Close</button>' +
      '<button class="btn btn-ghost" data-x="rename">Rename</button>' +
      '<button class="btn btn-danger" data-x="del">Delete</button></div>');
    $('[data-x="cancel"]', bd).onclick = closeModal;
    $('[data-x="rename"]', bd).onclick = () => { closeModal(); openCatModal(c.id); };
    $('[data-x="del"]', bd).onclick = () => {
      closeModal();
      confirmDialog('Delete category', 'Delete “' + c.name + '”? A category with items cannot be deleted — move or delete its items first.', 'Delete', async () => {
        try { await api('/api/admin/menu/categories/' + c.id, 'DELETE'); toast('Category deleted', 'ok'); me.activeCat = null; await refresh(); }
        catch (e) { handleApiError(e); }
      });
    };
  }

  /* ---- item modal ---- */
  function openItemModal(id) {
    const c = cat(); if (!c) return;
    const it = id ? c.items.find((x) => String(x.id) === String(id)) : null;
    const mods = (it && it.modifiers ? it.modifiers : []).map((m) => ({ name: m.name, price_delta_cents: m.price_delta_cents }));
    const bd = openModal('<h2>' + (it ? 'Edit item' : 'New item') + '</h2>' +
      '<div class="field"><label>Name</label><input id="mi-name" value="' + esc(it ? it.name : '') + '" maxlength="80"></div>' +
      '<div class="frow"><div class="field"><label>Price ($)</label><input id="mi-price" type="number" min="0" step="0.01" inputmode="decimal" value="' + (it ? (it.price_cents / 100).toFixed(2) : '') + '"></div>' +
      '<div class="field"><label>Category</label><select id="mi-cat">' + me.cats.map((x) => '<option value="' + x.id + '"' + (String(x.id) === String(it ? it.category_id : me.activeCat) ? ' selected' : '') + '>' + esc(x.name) + '</option>').join('') + '</select></div></div>' +
      '<div class="frow"><div class="field"><label>Station</label><select id="mi-station">' + KDS_STATIONS.map((s) => '<option value="' + s.slug + '"' + (it && it.station === s.slug ? ' selected' : '') + '>' + esc(s.label) + '</option>').join('') + '</select></div>' +
      '<div class="field"><label>Course</label><select id="mi-course">' + ME_COURSES.map((x) => '<option' + (it && it.course === x ? ' selected' : '') + '>' + x + '</option>').join('') + '</select></div>' +
      '<div class="field"><label>Type</label><select id="mi-type">' + ME_TYPES.map((x) => '<option' + (it && it.item_type === x ? ' selected' : '') + '>' + x + '</option>').join('') + '</select></div></div>' +
      '<div class="field"><label>Daypart <span class="muted small">(blank = follows category)</span></label><input id="mi-daypart" list="me-dayparts" value="' + esc(it && it.daypart ? it.daypart : '') + '" placeholder="e.g. HAPPY HOUR"></div>' +
      '<div class="field"><label>Description</label><input id="mi-desc" value="' + esc(it && it.description ? it.description : '') + '" maxlength="200"></div>' +
      '<div class="frow"><div class="field"><label>Price note</label><input id="mi-note" value="' + esc(it && it.price_note ? it.price_note : '') + '" placeholder="e.g. market price" maxlength="40"></div>' +
      '<div class="field"><label>Image URL</label><input id="mi-img" value="' + esc(it && it.image_url ? it.image_url : '') + '" placeholder="https://…" inputmode="url"></div></div>' +
      '<h3>Modifiers</h3><div id="mi-mods"></div>' +
      '<button class="btn btn-ghost btn-sm" id="mi-addmod" type="button">+ Modifier</button>' +
      '<div class="frow" style="margin-top:10px"><div class="field"><label class="check-line"><input type="checkbox" id="mi-popular"' + (it && it.popular ? ' checked' : '') + '> ★ Popular — show in the order-screen quick-pick row</label></div></div>' +
      (it ? '<h3>Modifier groups <span class="muted small">(rules: required, min/max, 86, nested)</span></h3>' +
        '<div id="mi-groups"><p class="muted small">Loading groups…</p></div>' +
        '<button class="btn btn-ghost btn-sm" id="mi-addgroup" type="button">+ Modifier group</button>' : '') +
      '<div class="modal-actions"><button class="btn btn-ghost" data-x="cancel">Cancel</button>' +
      (it ? '<button class="btn btn-danger" data-x="del">Delete</button>' : '') +
      '<button class="btn btn-primary" data-x="save">' + (it ? 'Save' : 'Add item') + '</button></div>');
    const modsBox = $('#mi-mods', bd);
    function drawMods() {
      modsBox.innerHTML = mods.map((m, i) =>
        '<div class="me-modrow"><input data-mn="' + i + '" value="' + esc(m.name) + '" placeholder="Modifier name" maxlength="60">' +
        '<input data-mp="' + i + '" type="number" min="0" step="0.01" inputmode="decimal" value="' + (m.price_delta_cents / 100).toFixed(2) + '" aria-label="Modifier price">' +
        '<button class="btn btn-ghost btn-sm" data-mx="' + i + '" aria-label="Remove modifier">✕</button></div>').join('') ||
        '<p class="muted small">No modifiers.</p>';
      $$('#mi-mods [data-mx]', bd).forEach((b) => b.onclick = () => { syncMods(); mods.splice(Number(b.getAttribute('data-mx')), 1); drawMods(); });
    }
    function syncMods() {
      mods.forEach((m, i) => {
        const n = modsBox.querySelector('[data-mn="' + i + '"]'), p = modsBox.querySelector('[data-mp="' + i + '"]');
        if (n) m.name = n.value;
        if (p) m.price_delta_cents = Math.round((parseFloat(p.value) || 0) * 100);
      });
    }
    $('#mi-addmod', bd).onclick = () => { syncMods(); mods.push({ name: '', price_delta_cents: 0 }); drawMods(); };
    drawMods();
    /* Phase 3A (P0-6): modifier-group manager UI — groups with required/
       min/max rules, 86 toggles, defaults, nested groups. */
    if (it) {
      const gBox = $('#mi-groups', bd);
      const drawGroups = async () => {
        let groups = [];
        try { const r = await api('/api/admin/menu/items/' + it.id + '/modifier-groups'); groups = r.groups || []; }
        catch (e) { gBox.innerHTML = '<p class="muted small">Could not load groups.</p>'; return; }
        const allOpts = [];
        groups.forEach((g) => (g.options || []).forEach((o) => allOpts.push({ id: o.id, name: g.name + ' › ' + o.name })));
        gBox.innerHTML = groups.map((g) =>
          '<div class="me-group" data-g="' + g.id + '">' +
          '<div class="me-grow"><b>' + esc(g.name) + '</b> ' +
          '<span class="muted small">' + (g.required ? 'required' : 'optional') +
          (g.max_select ? ' · ' + (g.min_select || 0) + '–' + g.max_select : (g.min_select ? ' · min ' + g.min_select : '')) +
          (g.parent_option_id ? ' · nested' : '') + '</span></div>' +
          '<div class="me-gopts">' + (g.options || []).map((o) =>
            '<div class="me-modrow' + (o.active ? '' : ' mod-86') + '">' +
            '<span class="mn">' + esc(o.name) + (o.is_default ? ' <span class="muted small">· default</span>' : '') + (o.active ? '' : ' <span class="pill held">86</span>') + '</span>' +
            '<span class="mp">' + (o.price_delta_cents ? '+' + fmt(o.price_delta_cents) : 'incl.') + '</span>' +
            '<button class="btn btn-ghost btn-sm" data-go86="' + o.id + '" title="' + (o.active ? '86 this modifier' : 'Bring back') + '">' + (o.active ? '86' : '↩') + '</button>' +
            '<button class="btn btn-ghost btn-sm" data-godel="' + o.id + '" aria-label="Delete option">✕</button></div>').join('') +
          '</div>' +
          '<div class="me-gopt-add"><input data-goname="' + g.id + '" placeholder="New option name" maxlength="80">' +
          '<input data-goprice="' + g.id + '" type="number" min="0" step="0.01" placeholder="$" style="max-width:80px" aria-label="Option price">' +
          '<label class="muted small"><input type="checkbox" data-godef="' + g.id + '"> default</label>' +
          '<button class="btn btn-ghost btn-sm" data-goadd="' + g.id + '">+ Option</button>' +
          '<button class="btn btn-ghost btn-sm" data-gdel="' + g.id + '" title="Delete group">Delete group</button></div>' +
          '</div>').join('') || '<p class="muted small">No groups yet.</p>';
        $$('[data-go86]', gBox).forEach((b) => b.onclick = async () => {
          const o = groups.flatMap((g) => g.options).find((x) => String(x.id) === b.dataset.go86);
          try { await api('/api/admin/menu/modifier-options/' + b.dataset.go86, 'PUT', { active: !(o && o.active) }); await drawGroups(); }
          catch (e) { handleApiError(e); }
        });
        $$('[data-godel]', gBox).forEach((b) => b.onclick = async () => {
          try { await api('/api/admin/menu/modifier-options/' + b.dataset.godel, 'DELETE'); await drawGroups(); }
          catch (e) { handleApiError(e); }
        });
        $$('[data-goadd]', gBox).forEach((b) => b.onclick = async () => {
          const gid = b.dataset.goadd;
          const name = $('[data-goname="' + gid + '"]', gBox).value.trim();
          if (!name) { toast('Option name is required', 'err'); return; }
          const price = Math.round((parseFloat($('[data-goprice="' + gid + '"]', gBox).value) || 0) * 100);
          const isDef = $('[data-godef="' + gid + '"]', gBox).checked;
          try { await api('/api/admin/menu/modifier-groups/' + gid + '/options', 'POST', { name, price_delta_cents: price, is_default: isDef }); await drawGroups(); }
          catch (e) { handleApiError(e); }
        });
        $$('[data-gdel]', gBox).forEach((b) => b.onclick = async () => {
          try { await api('/api/admin/menu/modifier-groups/' + b.dataset.gdel, 'DELETE'); await drawGroups(); }
          catch (e) { handleApiError(e); }
        });
      };
      drawGroups();
      $('#mi-addgroup', bd).onclick = async () => {
        const name = prompt('Group name (e.g. Cheese, Protein, Toppings):');
        if (!name || !name.trim()) return;
        const req = confirm('Required group? (OK = required, Cancel = optional)');
        const maxS = prompt('Max selections (0 = unlimited):', '0');
        try {
          await api('/api/admin/menu/items/' + it.id + '/modifier-groups', 'POST',
            { name: name.trim(), required: req, min_select: req ? 1 : 0, max_select: Math.max(0, parseInt(maxS || '0', 10) || 0) });
          await drawGroups();
        } catch (e) { handleApiError(e); }
      };
    }
    $('[data-x="cancel"]', bd).onclick = closeModal;
    $('[data-x="save"]', bd).onclick = async () => {
      syncMods();
      const body = {
        name: $('#mi-name', bd).value,
        price_cents: Math.round((parseFloat($('#mi-price', bd).value) || 0) * 100),
        category_id: Number($('#mi-cat', bd).value),
        station: $('#mi-station', bd).value,
        course: $('#mi-course', bd).value,
        item_type: $('#mi-type', bd).value,
        daypart: $('#mi-daypart', bd).value,
        description: $('#mi-desc', bd).value,
        price_note: $('#mi-note', bd).value,
        image_url: $('#mi-img', bd).value,
        modifiers: mods.filter((m) => m.name.trim() !== ''),
      };
      try {
        let savedId = it ? it.id : null;
        if (it) await api('/api/admin/menu/items/' + it.id, 'PUT', body);
        else { const r = await api('/api/admin/menu/items', 'POST', body); savedId = r && r.id; }
        /* Phase 3A (NG-D): popular flag rides the dedicated endpoint so the
           quick-pick row updates without touching the rest of the item. */
        const popBox = $('#mi-popular', bd);
        if (popBox && savedId && popBox.checked !== !!(it && it.popular)) {
          await api('/api/admin/menu/items/' + savedId + '/popular', 'PUT', { popular: popBox.checked });
        }
        closeModal(); toast(it ? 'Item saved' : 'Item added', 'ok');
        me.activeCat = String(body.category_id);
        await refresh();
      } catch (e) { saveErr(e); }
    };
    if (it) $('[data-x="del"]', bd).onclick = () => {
      closeModal();
      confirmDialog('Delete item', 'Delete “' + it.name + '”? Items with order history cannot be deleted — 86 them instead.', 'Delete', async () => {
        try { await api('/api/admin/menu/items/' + it.id, 'DELETE'); toast('Item deleted', 'ok'); await refresh(); }
        catch (e) { handleApiError(e); }
      });
    };
  }

  /* ---- audit log ---- */
  async function toggleAudit() {
    me.showAudit = !me.showAudit;
    $('#me-audit-card').classList.toggle('hidden', !me.showAudit);
    if (!me.showAudit) return;
    try {
      const rows = await api('/api/admin/menu/audit?limit=30');
      $('#me-audit-list').innerHTML = rows.length ? rows.map((r) =>
        '<div class="me-audit-row"><span class="me-audit-act">' + esc(meActionLabel(r.action)) + '</span> ' +
        '<span>' + esc((r.details && r.details.name) || ('#' + (r.item_id || r.category_id || ''))) + '</span> ' +
        '<span class="muted small">· ' + esc(r.actor || '?') + ' · ' + esc(String(r.created_at || '').slice(0, 16).replace('T', ' ')) + '</span></div>'
      ).join('') : '<p class="muted">No changes logged yet.</p>';
    } catch (e) { handleApiError(e); }
  }

  $('#me-add-cat').onclick = () => openCatModal(null);
  $('#me-add-item').onclick = () => { if (!me.cats.length) { toast('Add a category first', 'err'); return; } openItemModal(null); };
  $('#me-audit-toggle').onclick = toggleAudit;

  /* Phase 3A: clock-driven daypart schedule (manager-only). */
  let dpSchedule = [];
  const dpRows = () => $('#dp-rows');
  function drawDpRows() {
    dpRows().innerHTML = dpSchedule.map((w, i) =>
      '<div class="row" data-dpr="' + i + '" style="gap:8px;margin-bottom:8px;align-items:end">' +
      '<div class="field" style="flex:2"><label>Name</label><input data-dpf="name" value="' + esc(w.name) + '" maxlength="40"></div>' +
      '<div class="field" style="flex:1"><label>Start</label><input data-dpf="start" type="time" value="' + esc(w.start) + '"></div>' +
      '<div class="field" style="flex:1"><label>End</label><input data-dpf="end" type="time" value="' + esc(w.end) + '"></div>' +
      '<div class="field" style="flex:2"><label>Also includes</label><input data-dpf="also" value="' + esc((w.also || []).join(', ')) + '" placeholder="HH, BRUNCH"></div>' +
      '<button class="icon-btn" data-dpdel="' + i + '" title="Remove window" aria-label="Remove window">✕</button></div>').join('') ||
      '<p class="muted small">No windows — the whole menu shows all day.</p>';
    $$('[data-dpdel]', dpRows()).forEach((b) => b.onclick = () => { dpSchedule.splice(Number(b.dataset.dpdel), 1); drawDpRows(); });
  }
  async function loadDp() {
    try { const r = await api('/api/admin/dayparts'); dpSchedule = (r.schedule || []).map((w) => ({ name: w.name, start: w.start, end: w.end, also: w.also || [] })); }
    catch (e) { handleApiError(e); return; }
    drawDpRows();
  }
  $('#dp-toggle').onclick = () => { const b = $('#dp-body'); b.classList.toggle('hidden'); $('#dp-toggle').textContent = b.classList.contains('hidden') ? 'Show' : 'Hide'; };
  $('#dp-add').onclick = () => { dpSchedule.push({ name: 'NEW', start: '08:00', end: '22:00', also: [] }); drawDpRows(); };
  $('#dp-save').onclick = async () => {
    const rows = $$('[data-dpr]', dpRows());
    const schedule = rows.map((r) => {
      const v = (f) => $('[data-dpf="' + f + '"]', r).value.trim();
      return { name: v('name').toUpperCase(), start: v('start'), end: v('end'), also: v('also').split(',').map((x) => x.trim().toUpperCase()).filter(Boolean) };
    });
    try {
      await api('/api/admin/dayparts', 'PUT', { schedule });
      toast('Daypart schedule saved', 'ok');
      await loadDp();
    } catch (e) { handleApiError(e); }
  };
  loadDp();
  await refresh();
}

/* ============================================================
   INIT
   ============================================================ */
function bindGlobal() {
  window.addEventListener('hashchange', () => {
    // Floor-plan editor: guard against losing unsaved layout changes.
    if (window.__fpGuard && !window.__fpBypass && location.hash !== window.__fpGuard.hash) {
      const dest = location.hash;
      window.__fpBypass = true;
      location.hash = window.__fpGuard.hash; // snap back; the re-fire bypasses the guard
      confirmDialog('Unsaved floor-plan changes', 'Leave without saving? Your layout changes will be lost.', 'Discard', () => {
        window.__fpGuard = null; window.__fpDirty = false;
        location.hash = dest;
      });
      return;
    }
    window.__fpBypass = false;
    if (state.route && state.route.view === 'kds' && parseRoute().view !== 'kds') closeKdsSocket();
    if (typeof $('#app')._cleanup === 'function') { try { $('#app')._cleanup(); } catch (e) {} $('#app')._cleanup = null; }
    renderRoute().finally(() => { try { maybeClockBanner(); } catch (e) {} });
  });
  window.addEventListener('online', async () => {
    updateOfflineBanner();
    if (!isOffline()) { const n = await flushOutbox(); if (n === 0) toast('Back online', 'ok'); }
  });
  window.addEventListener('offline', () => updateOfflineBanner());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) updateOfflineBanner(); });
}

async function init() {
  loadSession();
  bindGlobal();
  await Outbox.open();
  await updateOfflineBanner();
  if (!location.hash) location.hash = state.user ? (state.user.role === 'kitchen' ? '#/kds' : state.user.role === 'manager' ? '#/manager' : '#/floor') : '#/login';
  else renderRoute().finally(() => { try { maybeClockBanner(); } catch (e) {} });
  // flush anything queued from a previous session
  if (state.user && !isOffline()) setTimeout(() => flushOutbox(), 1500);
}

/* ============================================================
   GLOBAL BREAK NUDGE
   On every view except #/clock itself, an employee with an open shift sees
   a slim nonblocking banner when a meal/rest break is due or overdue, with
   one-tap Start. Never blocks navigation; all failures are silent.
   ============================================================ */
async function maybeClockBanner() {
  try {
    if (!state.user) return;
    if (parseRoute().view === 'clock') return; // clock view has its own banners
    const app = $('#app');
    if (!app || app.querySelector('.clock-global-banner')) return;
    let s;
    try { s = await api('/api/clock/status'); }
    catch (e) { return; } // offline / unauthorized: stay silent
    if (!s || !s.open) return;
    const need = [];
    for (const d of (s.due || [])) {
      if ((d.state === 'due' || d.state === 'overdue') && !need.some((n) => n.kind === d.kind)) {
        need.push({ kind: d.kind, overdue: d.state === 'overdue' });
      }
    }
    if (!need.length) return;
    const anyOverdue = need.some((n) => n.overdue);
    const b = document.createElement('div');
    b.className = 'clock-global-banner' + (anyOverdue ? ' overdue' : '');
    b.setAttribute('role', 'status');
    b.innerHTML = '<span>' + (anyOverdue ? '⚠ <b>Break overdue</b>' : '⏳ <b>Break due</b>') + ' — ' +
      need.map((n) => n.kind).join(' + ') + '</span> ' +
      need.map((n) => '<button class="btn btn-sm ' + (n.overdue ? 'btn-primary' : 'btn-ghost') + '" data-gb="' + n.kind + '">Start ' + n.kind + '</button>').join(' ');
    b.querySelectorAll('[data-gb]').forEach((btn) => {
      btn.onclick = async () => {
        btn.disabled = true;
        try { await api('/api/clock/break/start', 'POST', { type: btn.dataset.gb }); toast('Break started — enjoy', 'ok'); }
        catch (e) { handleApiError(e); }
        b.remove();
      };
    });
    app.prepend(b);
  } catch (e) { /* never break navigation */ }
}

/* ============================================================
   VIEW: TIME CLOCK (all roles)
   Clock in/out + break prompts. Polls /api/clock/status every 60s so
   due/overdue break banners appear without a page refresh.
   ============================================================ */
const CLOCK_POLL_MS = 60000;
const ckElapsedFmt = (h) => {
  h = Math.max(0, Number(h) || 0);
  const m = Math.round(h * 60);
  return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
};

async function renderClock(app) {
  app.innerHTML = '<div class="view-head"><h1>Time clock</h1><span class="spacer"></span><span class="muted small" id="clock-now"></span></div>' +
    '<div id="clock-body"><p class="muted">Loading…</p></div>';
  const body = $('#clock-body');
  const tickNow = () => { const c = $('#clock-now'); if (c) c.textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); };
  tickNow();

  const load = async () => {
    let s;
    try { s = await api('/api/clock/status'); }
    catch (e) { if (handleApiError(e) === 'bounced') return; body.innerHTML = '<div class="empty">Could not load time clock.</div>'; return; }
    draw(s);
  };

  const draw = (s) => {
    if (!s.open) {
      body.innerHTML = '<div class="card"><h2>Not clocked in</h2>' +
        '<p class="muted">Tap below to start your shift. Your breaks and overtime are tracked automatically.</p>' +
        '<button class="btn btn-primary btn-big btn-block" id="ck-in">Clock In</button></div>';
      $('#ck-in').onclick = async () => {
        try { await api('/api/clock/in', 'POST', {}); toast('Clocked in — have a great shift', 'ok'); load(); }
        catch (e) { handleApiError(e); }
      };
      return;
    }
    let banners = '';
    for (const d of (s.due || [])) {
      if (d.kind === 'meal' && d.state === 'overdue') {
        banners += '<div class="clock-banner overdue" role="alert"><span>⚠ <b>Meal break OVERDUE</b> — start it now to avoid a premium.</span>' +
          '<button class="btn btn-primary btn-sm" data-start="meal">Start meal break</button></div>';
      } else if (d.kind === 'meal' && d.state === 'due') {
        banners += '<div class="clock-banner due"><span>⏳ <b>Meal break due</b> by ' + esc(fmtClock(d.due_at)) + '.</span>' +
          '<button class="btn btn-ghost btn-sm" data-start="meal">Start meal break</button></div>';
      } else if (d.kind === 'rest' && d.state === 'due') {
        banners += '<div class="clock-banner due"><span>⏳ <b>Rest break due</b> — take 10 minutes.</span>' +
          '<button class="btn btn-ghost btn-sm" data-start="rest">Start rest break</button></div>';
      }
    }
    const mealIp = (s.breaks || []).some((b) => b.type === 'meal' && !b.end_at && !b.waived);
    const restIp = (s.breaks || []).some((b) => b.type === 'rest' && !b.end_at);
    const chips = (s.breaks || []).map((b) => {
      if (b.waived) return '<span class="chip">Meal ' + (b.meal_seq || 1) + ' waived</span>';
      const lbl = b.type === 'meal' ? 'Meal' : 'Rest';
      const tm = fmtClock(b.start_at) + (b.end_at ? '–' + fmtClock(b.end_at) + ' (' + b.minutes + 'm)' : ' — in progress');
      return '<span class="chip' + (!b.end_at ? ' active' : '') + '">' + lbl + ' ' + tm + '</span>';
    }).join(' ');
    body.innerHTML = banners +
      '<div class="card"><h2>' + esc(s.employee_name) + ' <span class="muted small">· ' + esc(s.role) + '</span></h2>' +
      '<div class="stat-grid">' +
      '<div class="stat"><div class="k">Clocked in</div><div class="v">' + esc(fmtClock(s.clock_in)) + '</div></div>' +
      '<div class="stat"><div class="k">Elapsed</div><div class="v">' + esc(ckElapsedFmt(s.elapsed_h)) + '</div></div>' +
      '<div class="stat"><div class="k">Rate</div><div class="v">' + fmt(s.regular_rate_cents) + '/hr</div></div>' +
      '</div>' +
      (chips ? '<p class="mt">' + chips + '</p>' : '<p class="muted small mt">No breaks yet this shift.</p>') +
      '<div class="clock-actions">' +
      (mealIp ? '<button class="btn btn-big btn-amber" id="ck-end-meal">End meal break</button>'
        : '<button class="btn btn-big btn-ghost" id="ck-start-meal">Start meal break</button>') +
      (restIp ? '<button class="btn btn-big btn-amber" id="ck-end-rest">End rest break</button>'
        : '<button class="btn btn-big btn-ghost" id="ck-start-rest">Start rest break</button>') +
      '</div>' +
      '<div id="ck-attest" class="card mt hidden"><h3>End meal break</h3>' +
      '<label class="check"><input type="checkbox" id="ck-dutyfree"> <span>I was <b>fully relieved of duty</b> for this entire meal break.</span></label>' +
      '<p class="muted small">California requires an uninterrupted, duty-free 30-minute meal period.</p>' +
      '<div class="modal-actions"><button class="btn btn-ghost" id="ck-attest-cancel">Cancel</button>' +
      '<button class="btn btn-primary" id="ck-attest-ok">End break</button></div></div>' +
      '<button class="btn btn-block mt" id="ck-out" style="min-height:56px">Clock Out</button></div>';

    const start = async (t) => { try { await api('/api/clock/break/start', 'POST', { type: t }); load(); } catch (e) { handleApiError(e); } };
    body.querySelectorAll('[data-start]').forEach((b) => { b.onclick = () => start(b.dataset.start); });
    const sm = $('#ck-start-meal'); if (sm) sm.onclick = () => start('meal');
    const sr = $('#ck-start-rest'); if (sr) sr.onclick = () => start('rest');
    const er = $('#ck-end-rest'); if (er) er.onclick = async () => { try { await api('/api/clock/break/end', 'POST', { type: 'rest' }); load(); } catch (e) { handleApiError(e); } };
    const em = $('#ck-end-meal');
    if (em) em.onclick = () => $('#ck-attest').classList.remove('hidden');
    const ac = $('#ck-attest-cancel'); if (ac) ac.onclick = () => $('#ck-attest').classList.add('hidden');
    const ao = $('#ck-attest-ok');
    if (ao) ao.onclick = async () => {
      if (!$('#ck-dutyfree').checked) { toast('Please confirm you were fully relieved of duty', 'err'); return; }
      try { await api('/api/clock/break/end', 'POST', { type: 'meal', duty_free: true }); toast('Meal break ended', 'ok'); load(); }
      catch (e) { handleApiError(e); }
    };
    $('#ck-out').onclick = async () => {
      try {
        const v = await api('/api/clock/out', 'POST', {});
        const viol = (v.compliance.violations || []).join(' + ');
        toast(viol ? 'Clocked out — ⚠ break premium owed (' + viol + ')' : 'Clocked out — shift total ' + fmt(v.pay.total_cents), viol ? 'err' : 'ok');
        load();
      } catch (e) { handleApiError(e); }
    };
  };

  await load();
  const iv1 = setInterval(load, CLOCK_POLL_MS);
  const iv2 = setInterval(tickNow, 20000);
  app._cleanup = () => { clearInterval(iv1); clearInterval(iv2); };
}

/* ============================================================
   VIEW: MANAGER TIME CLOCK (#/manager/timeclock)
   Who's in now, shifts + breaks + compliance, premiums, overtime,
   day labor rollup, team rates, and shift adjustments.
   ============================================================ */
function ckMealChip(v, seq, okFlag) {
  const b = (v.breaks || []).find((x) => x.type === 'meal' && (x.meal_seq || 1) === seq);
  const tag = 'M' + seq;
  if (b && b.waived) return '<span class="chip">' + tag + ' waived</span>';
  if (b && b.end_at) return '<span class="chip">' + tag + ' ✓ ' + fmtClock(b.start_at) + '–' + fmtClock(b.end_at) + '</span>';
  if (b && !b.end_at) return '<span class="chip active">' + tag + ' …in progress</span>';
  if (!okFlag && v.compliance.finalized) return '<span class="chip bad">⚠ ' + tag + ' missed</span>';
  if (!okFlag) return '<span class="chip warn">' + tag + ' pending</span>';
  return '<span class="chip">—</span>';
}

async function renderTimeClock(app) {
  if (!mgrGuard(app)) return;
  const defDate = await siteDate();
  app.innerHTML = '<div class="view-head"><h1>Time clock</h1><span class="spacer"></span>' +
    '<label class="muted small">Date <input type="date" id="tc-date" class="date-in" value="' + esc(defDate) + '"></label></div>' +
    mgrNav('timeclock') + '<div id="tc-body"><p class="muted">Loading…</p></div>';
  const body = $('#tc-body');

  const load = async () => {
    const d = ($('#tc-date') && $('#tc-date').value) || defDate;
    let data, users;
    try {
      data = await api('/api/admin/clock/shifts?date=' + encodeURIComponent(d));
      users = await api('/api/admin/clock/users');
    } catch (e) { if (handleApiError(e) === 'bounced') return; body.innerHTML = '<div class="empty">Could not load time clock.</div>'; return; }
    draw(data, users, d);
  };

  const violTxt = (v) => (v.compliance.violations || []).map((x) => x === 'meal' ? 'meal' : x).join(' + ');

  const draw = (data, users, d) => {
    const L = data.labor || {};
    const onShift = (data.on_shift || []).map((s) =>
      '<span class="chip active">' + esc(s.employee_name) + ' <span class="muted">· in ' + esc(fmtClock(s.clock_in)) + '</span></span>').join(' ') || '<span class="muted">Nobody clocked in.</span>';
    const rows = (data.shifts || []).map((v) => {
      const comp = v.compliance;
      const meals = comp.meals_required === 0 ? '<span class="muted">—</span>'
        : ckMealChip(v, 1, comp.meal1_ok) + (comp.meals_required > 1 ? ' ' + ckMealChip(v, 2, comp.meal2_ok) : '');
      const rest = comp.rests_required === 0 ? '<span class="muted">—</span>'
        : (comp.rests_ok
          ? '<span class="chip">R ✓ ' + comp.rests_taken + '/' + comp.rests_required + '</span>'
          : '<span class="chip ' + (comp.finalized ? 'bad' : 'warn') + '">⚠ R ' + comp.rests_taken + '/' + comp.rests_required + '</span>');
      const otH = (v.pay.ot15_hours || 0) + (v.pay.ot2_hours || 0);
      return '<tr>' +
        '<td><b>' + esc(v.employee_name) + '</b><br><span class="muted small">' + esc(v.role) + '</span></td>' +
        '<td class="small">' + esc(fmtClock(v.clock_in)) + '<br><span class="muted">' + (v.clock_out ? esc(fmtClock(v.clock_out)) : 'open') + '</span></td>' +
        '<td>' + v.hours.toFixed(2) + 'h</td>' +
        '<td>' + meals + ' ' + rest + '</td>' +
        '<td>' + (otH > 0 ? otH.toFixed(2) + 'h<br><span class="muted small">' + fmt(v.pay.ot15_cents + v.pay.ot2_cents) + '</span>' : '<span class="muted">—</span>') + '</td>' +
        '<td>' + (v.pay.premium_cents > 0 ? '<span class="red"><b>⚠ ' + fmt(v.pay.premium_cents) + '</b><br><span class="small">' + esc(violTxt(v)) + '</span></span>' : '<span class="muted">—</span>') + '</td>' +
        '<td><b>' + fmt(v.pay.total_cents) + '</b></td>' +
        '<td><button class="btn btn-ghost btn-sm" data-adj="' + v.id + '">Adjust</button></td></tr>';
    }).join('');
    const violRows = (data.violations || []).map((x) =>
      '<div class="clock-banner overdue slim"><span>⚠ <b>' + esc(x.employee_name) + '</b> — missed ' + esc(violTxt({ compliance: { violations: x.violations } })) + ' break: <b>' + fmt(x.premium_cents) + '</b> premium owed.</span></div>').join('');
    const rates = (users || []).map((u) =>
      '<div class="rate-row"><span><b>' + esc(u.name) + '</b> <span class="muted small">· ' + esc(u.role) + '</span></span>' +
      '<span>$<input type="number" class="rate-in" data-u="' + u.id + '" min="0" step="0.01" value="' + ((u.hourly_rate_cents || 0) / 100).toFixed(2) + '">/hr ' +
      '<button class="btn btn-ghost btn-sm" data-rate="' + u.id + '">Save</button></span></div>').join('');

    body.innerHTML =
      '<div class="card"><h3>On shift now</h3><p>' + onShift + '</p></div>' +
      '<div class="stat-grid">' +
      '<div class="stat"><div class="k">Labor cost · ' + esc(d) + '</div><div class="v">' + fmt(L.total_cents) + '</div></div>' +
      '<div class="stat"><div class="k">Break premiums owed</div><div class="v ' + (L.premium_cents > 0 ? 'red' : '') + '">' + fmt(L.premium_cents) + '</div></div>' +
      '<div class="stat"><div class="k">Overtime pay</div><div class="v ' + ((L.ot_cents + L.weekly_ot_cents) > 0 ? 'amber' : '') + '">' + fmt((L.ot_cents || 0) + (L.weekly_ot_cents || 0)) + '</div></div>' +
      '<div class="stat"><div class="k">Regular pay</div><div class="v">' + fmt(L.reg_cents) + '</div></div>' +
      '</div>' +
      (violRows || '') +
      '<div class="card mt"><h3>Shifts</h3><div class="t-scroll"><table class="t-table">' +
      '<thead><tr><th>Employee</th><th>In / Out</th><th>Hours</th><th>Breaks</th><th>OT</th><th>Premium</th><th>Labor</th><th></th></tr></thead>' +
      '<tbody>' + (rows || '<tr><td colspan="8" class="muted">No shifts this date.</td></tr>') + '</tbody></table></div></div>' +
      '<div class="card"><h3>Team hourly rates</h3>' + rates +
      '<p class="muted small mt">Rates are captured on each shift at clock-in, so past shifts keep their historical rate. Changes apply to future shifts.</p></div>' +
      '<p class="muted small">Break rules use California defaults validated against DIR/DLSE guidance 2026-09-26 (30-min duty-free meal before the 5th hour, 10-min paid rest per 4h or major fraction &gt;2h, 1h premium per violation type per day, OT after 8/12h daily incl. 7th-day rules, 40h weekly). Thresholds are config data — not legal advice. Consult employment counsel before relying on them for payroll.</p>';

    body.querySelectorAll('[data-rate]').forEach((b) => {
      b.onclick = async () => {
        const inp = body.querySelector('.rate-in[data-u="' + b.dataset.rate + '"]');
        const cents = Math.round(parseFloat(inp.value || '0') * 100);
        if (!Number.isFinite(cents) || cents < 0) { toast('Enter a valid rate', 'err'); return; }
        try { await api('/api/admin/clock/users/' + b.dataset.rate + '/rate', 'PUT', { hourly_rate_cents: cents }); toast('Rate saved', 'ok'); }
        catch (e) { handleApiError(e); }
      };
    });
    body.querySelectorAll('[data-adj]').forEach((b) => {
      b.onclick = () => {
        const sh = (data.shifts || []).find((s) => String(s.id) === b.dataset.adj);
        if (sh) openAdjust(sh, d, load);
      };
    });
  };

  const openAdjust = (shift, d, reload) => {
    const shiftId = shift.id;
    const toLocal = (iso) => {
      if (!iso) return '';
      const t = new Date(iso), p = (n) => String(n).padStart(2, '0');
      return t.getFullYear() + '-' + p(t.getMonth() + 1) + '-' + p(t.getDate()) + 'T' + p(t.getHours()) + ':' + p(t.getMinutes());
    };
    const breakRows = (shift.breaks || []).map((b) =>
      '<div class="card slim" style="margin:8px 0;padding:10px"><b class="small">' + esc(b.type === 'meal' ? 'Meal break' : 'Rest break') + '</b>' +
      '<label class="fld">Start <input type="datetime-local" data-brk="' + b.id + '" data-f="start_at" value="' + toLocal(b.start_at) + '"></label>' +
      '<label class="fld">End <input type="datetime-local" data-brk="' + b.id + '" data-f="end_at" value="' + toLocal(b.end_at) + '"></label></div>'
    ).join('');
    const bd = openModal('<h2>Adjust shift</h2>' +
      '<p class="muted small">Manager correction — the original values stay in the audit log with the approver\'s name. Times are local (site timezone).</p>' +
      '<label class="fld">Clock in <input type="datetime-local" id="adj-in" value="' + toLocal(shift.clock_in) + '"></label>' +
      '<label class="fld">Clock out <input type="datetime-local" id="adj-out" value="' + toLocal(shift.clock_out) + '"></label>' +
      '<p class="muted small">Leave clock-out empty to reopen a closed shift.</p>' +
      (breakRows ? '<h3 class="mt">Breaks</h3>' + breakRows : '') +
      '<label class="fld">Manager PIN <span class="muted small">— approves this correction</span> <input id="adj-pin" inputmode="numeric" maxlength="4" placeholder="••••" style="max-width:140px"></label>' +
      '<div class="modal-actions"><button class="btn btn-ghost" data-x="cancel">Cancel</button>' +
      '<button class="btn btn-primary" data-x="save">Save adjustment</button></div>');
    $('[data-x="cancel"]', bd).onclick = closeModal;
    $('[data-x="save"]', bd).onclick = async () => {
      const toIso = (s) => s ? new Date(s).toISOString() : null;
      const pin = $('#adj-pin', bd).value.trim();
      if (!/^\d{4}$/.test(pin)) { toast('Enter your 4-digit manager PIN to approve', 'err'); return; }
      const ci = $('#adj-in', bd).value, co = $('#adj-out', bd).value;
      const patch = { shift_id: Number(shiftId), manager_pin: pin };
      if (ci) patch.clock_in = toIso(ci);
      if (co) patch.clock_out = toIso(co); else patch.clock_out = null;
      try {
        await api('/api/admin/clock/adjust', 'POST', patch);
        // Break corrections, one call per changed break.
        for (const b of (shift.breaks || [])) {
          const sIn = $('[data-brk="' + b.id + '"][data-f="start_at"]', bd);
          const eIn = $('[data-brk="' + b.id + '"][data-f="end_at"]', bd);
          const ns = toIso(sIn.value), ne = eIn.value ? toIso(eIn.value) : null;
          const os = b.start_at ? new Date(b.start_at).toISOString() : null;
          const oe = b.end_at ? new Date(b.end_at).toISOString() : null;
          if (ns !== os || ne !== oe) {
            await api('/api/admin/clock/adjust', 'POST', { shift_id: Number(shiftId), manager_pin: pin, break_id: b.id, start_at: ns, end_at: ne });
          }
        }
        closeModal(); toast('Shift adjusted — pay recomputed', 'ok'); reload();
      } catch (e) { handleApiError(e); }
    };
  };

  $('#tc-date').onchange = load;
  await load();
}

/* Phase 3A: visual split — drag items into new checks (simplified: checkbox picker). */
function openVisualSplit(checkId, check) {
  const items = (check.items || []).filter((i) => i.state !== 'void');
  if (!items.length) { toast('No items to split'); return; }
  const bd = openModal('<h2>Visual split</h2><p class="muted">Pick items for the new check — the rest stay here.</p>' +
    '<div class="checkbox-list">' + items.map((i) =>
      '<label><input type="checkbox" data-vs="' + esc(String(i.id)) + '"><span style="flex:1">' + (i.qty > 1 ? i.qty + '× ' : '') + esc(i.name) + '</span></label>').join('') +
    '</div><div class="modal-actions"><button class="btn btn-ghost" data-x="c">Cancel</button><button class="btn btn-primary" data-x="go">Split selected</button></div>');
  $('[data-x="c"]', bd).onclick = closeModal;
  $('[data-x="go"]', bd).onclick = async () => {
    const ids = $$('[data-vs]:checked', bd).map((c) => Number(c.dataset.vs));
    closeModal();
    if (!ids.length) { toast('Select at least one item'); return; }
    try {
      const r = await api('/api/checks/' + realId(checkId) + '/split', 'POST', { mode: 'move', item_ids: ids });
      toast('Check split', 'ok');
      renderRoute(true);
    } catch (e) { handleApiError(e); }
  };
}

/* Phase 3A: merge picker — merge this check into another open check. */
function openMergePicker(checkId) {
  const bd = openModal('<h2>Merge check</h2><p class="muted">Merge this check into another open check.</p>' +
    '<div class="field"><label>Target check ID</label><input id="merge-target" type="number" min="1" placeholder="Check #"></div>' +
    '<div class="modal-actions"><button class="btn btn-ghost" data-x="c">Cancel</button><button class="btn btn-primary" data-x="go">Merge</button></div>');
  $('[data-x="c"]', bd).onclick = closeModal;
  $('[data-x="go"]', bd).onclick = async () => {
    const target = Number($('#merge-target', bd).value);
    closeModal();
    if (!target) { toast('Enter a target check ID'); return; }
    try {
      await api('/api/checks/' + realId(checkId) + '/merge', 'POST', { target_check_id: target });
      toast('Checks merged', 'ok');
      renderRoute(true);
    } catch (e) { handleApiError(e); }
  };
}

document.addEventListener('DOMContentLoaded', init);
