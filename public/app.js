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
};

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
class ApiError extends Error { constructor(status, msg) { super(msg || ('HTTP ' + status)); this.status = status; } }

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
  if (res.status === 401) throw new ApiError(401, 'Unauthorized');
  if (res.status === 403) throw new ApiError(403, 'Forbidden');
  if (!res.ok) {
    let msg = 'Request failed (' + res.status + ')';
    try { const j = await res.json(); msg = j.error || j.message || msg; } catch (e) { /* ignore */ }
    throw new ApiError(res.status, msg);
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
    const entry = { ts: Date.now(), op, payload };
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

/* temp-id -> real-id map, persisted so a flush can resume across reloads */
function loadIdMap() { try { return JSON.parse(localStorage.getItem('expoline.idmap') || '{}'); } catch (e) { return {}; } }
function saveIdMap(m) { try { localStorage.setItem('expoline.idmap', JSON.stringify(m)); } catch (e) { /* ignore */ } }
function realId(id) { const m = loadIdMap(); return m[id] || id; }

/* Flush the outbox oldest-first. Stops at the first failure so order is
   preserved; remaining ops retry on the next reconnect. */
let flushing = false;
async function flushOutbox() {
  if (flushing || isOffline()) return 0;
  const ops = await Outbox.all();
  if (!ops.length) return 0;
  flushing = true;
  const idmap = loadIdMap();
  let done = 0, failed = false;
  try {
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
              const r = await rawApi('/api/checks/' + cid + '/items', 'POST',
                { menu_item_id: it.menu_item_id, seat: it.seat, qty: it.qty, modifiers: it.modifiers || [] });
              const iid = r && (r.id || (r.item && r.item.id));
              if (it.temp_id && iid) { idmap[it.temp_id] = iid; }
            }
            saveIdMap(idmap);
          } else if (o.op === 'void_item') {
            const iid = idmap[p.item_id] || p.item_id;
            await rawApi('/api/checks/' + cid + '/items/' + iid, 'DELETE');
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
  } finally { flushing = false; }

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
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .4s'; setTimeout(() => el.remove(), 450); }, 3400);
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
  if (role === 'kitchen' || role === 'manager') links.push(['#/kds', 'KDS']);
  if (role === 'manager') links.push(['#/manager', 'Manager']);
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
      station: i.station || i.kds_station || null,
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

/* Client-side totals used ONLY while offline (labeled "estimated").
   Rules mirror the contract: 5% surcharge, 18% service charge on 8+ guests. */
function estimateTotals(check) {
  const items = (check.items || []).filter((i) => i.state !== 'void');
  let sub = 0;
  for (const i of items) {
    const q = i.qty || 1;
    sub += (i.price_cents || 0) * q;
    for (const m of (i.modifiers || [])) sub += (m.price_delta_cents || 0) * q;
  }
  const guests = check.guest_count || check.guests || 0;
  const surcharge = Math.round(sub * 0.05);
  const service_charge = guests >= 8 ? Math.round(sub * 0.18) : 0;
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
    if (r.view === 'order') return renderOrder(app, r.param);
    if (r.view === 'kds') return renderKds(app);
    if (r.view === 'pay') return renderPay(app, r.param);
    if (r.view === 'manager') {
      if (state.user.role !== 'manager') { app.innerHTML = notAuthorized('Manager area — please log in as a manager.'); return; }
      const sub = (location.hash.match(/^#\/manager\/([a-z]+)/) || [])[1];
      if (sub === 'finance') return renderFinance(app);
      if (sub === 'shift') return renderShift(app);
      if (sub === 'menu') return renderMenuViewer(app);
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
  app.innerHTML = '<div class="view-head"><h1>Floor</h1><span class="spacer"></span><span class="muted small" id="floor-clock"></span></div>' +
    '<div class="tabs" id="zone-tabs"></div><div class="zone-grid" id="zone-grid"></div>';
  const tick = () => { const c = $('#floor-clock'); if (c) c.textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); };
  tick(); const iv = setInterval(tick, 20000);
  const cleanup = () => clearInterval(iv);
  app._cleanup = cleanup;

  let zones;
  try { zones = await getZones(); }
  catch (e) { if (handleApiError(e) === 'bounced') return; app.innerHTML = '<div class="empty">Could not load floor.</div>'; return; }
  if (!zones.length) { $('#zone-grid').innerHTML = '<div class="empty">No zones configured.</div>'; return; }

  let active = zones[0].id;
  const tabs = $('#zone-tabs'), grid = $('#zone-grid');
  const drawTabs = () => {
    tabs.innerHTML = zones.map((z) => {
      const open = z.tables.filter((t) => t.open_check_id).length;
      return '<button class="tab' + (z.id === active ? ' active' : '') + '" data-z="' + esc(String(z.id)) + '">' + esc(z.name) + '<span class="count">' + open + '/' + z.tables.length + '</span></button>';
    }).join('');
    $$('.tab', tabs).forEach((b) => b.onclick = () => { active = b.dataset.z; drawTabs(); drawGrid(); });
  };
  const drawGrid = () => {
    const z = zones.find((x) => String(x.id) === String(active));
    grid.innerHTML = z.tables.map((t) =>
      '<button class="table-tile' + (t.open_check_id ? ' open' : '') + '" data-t="' + esc(String(t.id)) + '" aria-label="Table ' + esc(t.label) + (t.open_check_id ? ', open' : ', available') + '">' +
      '<span>' + esc(t.label) + '</span>' +
      '<span class="sub">' + (t.open_check_id ? 'OPEN' : (t.seats ? t.seats + ' seats' : 'Available')) + '</span></button>').join('');
    $$('.table-tile', grid).forEach((b) => b.onclick = () => {
      const t = z.tables.find((x) => String(x.id) === b.dataset.t);
      if (t.open_check_id) location.hash = '#/order/' + t.open_check_id;
      else openCheckSheet(t);
    });
  };
  drawTabs(); drawGrid();

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
    $('[data-x="cancel"]', bd).onclick = closeModal;
    $('[data-x="go"]', bd).onclick = async () => {
      tabName = $('#tab-name', bd).value.trim();
      closeModal();
      const tempId = 'tmp-' + Date.now().toString(36);
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
  const check = view.check;
  const guests = check.guest_count || check.guests || 2;
  let seat = 1;
  let staged = loadStaged(checkId);
  let menu = [], activeCat = null;

  try { menu = await getMenu(); } catch (e) { handleApiError(e); }

  const totals = check.totals || {};
  app.innerHTML =
    '<div class="order-top">' +
    '<a class="btn btn-ghost" href="#/floor" aria-label="Back to floor">‹</a>' +
    '<span class="table-label">' + esc(check.table_label || check.table || ('Check ' + String(checkId).slice(-4))) + '</span>' +
    (check.tab_name ? '<span class="muted">· ' + esc(check.tab_name) + '</span>' : '') +
    '<span class="muted small">' + guests + ' guests</span><span class="spacer"></span>' +
    '<a class="btn btn-primary" href="#/pay/' + encodeURIComponent(checkId) + '">Pay · ' + fmt(totals.total) + '</a>' +
    '</div>' +
    (totals.estimated ? '<p class="small muted">Totals estimated while offline — final math comes from the server on sync.</p>' : '') +
    '<h3 style="margin-bottom:4px">Seat <span class="muted small">— pick a seat first</span></h3>' +
    '<div class="seat-row" id="seat-row" role="radiogroup" aria-label="Seat"></div>' +
    '<div class="tabs" id="cat-tabs"></div>' +
    '<div class="order-layout"><div><div class="item-grid" id="item-grid"></div>' +
    '<div class="drinks-note">🍸 <b>Drinks</b> are tagged <span class="drink-tag">BAR</span> — they fire to the <b>bar</b> immediately on send, never holding up food.</div></div>' +
    '<div class="cart-panel"><div class="card"><h3>Order</h3><div id="cart-body"></div>' +
    '<div class="order-actions"><button class="btn btn-amber btn-big" id="btn-hold">HOLD</button>' +
    '<button class="btn btn-green btn-big" id="btn-send">SEND</button></div>' +
    '</div></div></div>';

  const seatRow = $('#seat-row'), catTabs = $('#cat-tabs'), itemGrid = $('#item-grid'), cartBody = $('#cart-body');

  const drawSeats = () => {
    seatRow.innerHTML = Array.from({ length: guests }, (_, i) => i + 1).map((s) =>
      '<button class="seat-chip' + (s === seat ? ' active' : '') + '" data-s="' + s + '" role="radio" aria-checked="' + (s === seat) + '">Seat ' + s + '</button>').join('');
    $$('.seat-chip', seatRow).forEach((b) => b.onclick = () => { seat = Number(b.dataset.s); drawSeats(); drawCart(); });
  };
  const drawCats = () => {
    catTabs.innerHTML = menu.map((c) =>
      '<button class="tab' + (c.id === activeCat ? ' active' : '') + '" data-c="' + esc(String(c.id)) + '">' + esc(c.name) + '</button>').join('');
    $$('.tab', catTabs).forEach((b) => b.onclick = () => { activeCat = b.dataset.c; drawCats(); drawItems(); });
  };
  const drawItems = () => {
    const cat = menu.find((c) => String(c.id) === String(activeCat));
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

  function addItemFlow(item, catName) {
    const mods = itemModifiers(item);
    if (!mods.length) { stageItem(item, [], 1); return; }
    // modifier picker modal: checkboxes with +$ amounts
    let qty = 1;
    const bd = openModal(
      '<h2>' + esc(item.name) + ' <span class="muted">· ' + fmt(item.price_cents) + '</span></h2>' +
      '<p class="muted small">Seat ' + seat + (isDrink(item, catName) ? ' · <span class="drink-tag">BAR</span> fires to bar on send' : '') + '</p>' +
      '<div class="field"><label>Quantity</label><div class="stepper"><button data-q="dec">−</button><span class="val" id="m-qty">1</span><button data-q="inc">+</button></div></div>' +
      '<h3>Modifiers</h3><div id="mod-list">' +
      mods.map((m, i) => '<label class="mod-row"><input type="checkbox" data-mi="' + i + '"><span class="mn">' + esc(m.name) + '</span><span class="mp">+' + fmt(m.price_delta_cents) + '</span></label>').join('') +
      '</div><div class="modal-actions"><button class="btn btn-ghost" data-x="cancel">Cancel</button>' +
      '<button class="btn btn-primary" data-x="add">Add to order</button></div>');
    $('[data-q="dec"]', bd).onclick = () => { qty = Math.max(1, qty - 1); $('#m-qty', bd).textContent = qty; };
    $('[data-q="inc"]', bd).onclick = () => { qty = Math.min(24, qty + 1); $('#m-qty', bd).textContent = qty; };
    $('[data-x="cancel"]', bd).onclick = closeModal;
    $('[data-x="add"]', bd).onclick = () => {
      const picked = $$('#mod-list input:checked', bd).map((c) => mods[Number(c.dataset.mi)]).map((m) => ({ name: m.name, price_delta_cents: m.price_delta_cents }));
      closeModal();
      stageItem(item, picked, qty);
    };
  }

  function stageItem(item, modifiers, qty) {
    staged.push({
      temp_id: uid('st'), menu_item_id: item.id, name: item.name, price_cents: item.price_cents,
      seat, qty, modifiers, drink: isDrink(item, (menu.find((c) => String(c.id) === String(activeCat)) || {}).name),
    });
    saveStaged(checkId, staged);
    drawCart();
    toast(item.name + ' → Seat ' + seat);
  }

  function drawCart() {
    const bySeat = {};
    staged.forEach((s) => { (bySeat[s.seat] = bySeat[s.seat] || []).push({ kind: 'staged', ref: s }); });
    (check.items || []).forEach((i) => { (bySeat[i.seat || 0] = bySeat[i.seat || 0] || []).push({ kind: 'held', ref: i }); });
    const seats = Object.keys(bySeat).map(Number).sort((a, b) => a - b);
    if (!seats.length) { cartBody.innerHTML = '<p class="muted small">Nothing ordered yet — pick a seat, then tap items.</p>'; return; }
    cartBody.innerHTML = seats.map((s) =>
      '<div class="seat-group"><div class="seat-name">' + (s ? 'Seat ' + s : 'Unseated') + '</div>' +
      bySeat[s].map(({ kind, ref }) => {
        const pill = kind === 'staged' ? '<span class="pill staged">staged</span>'
          : ref.state === 'held' ? '<span class="pill held">held</span>' : '<span class="pill sent">sent</span>';
        const mods = (ref.modifiers || []).map((m) => esc(m.name) + (m.price_delta_cents ? ' (+' + fmt(m.price_delta_cents) + ')' : '')).join(', ');
        const unitCents = (ref.unit_price_cents != null ? ref.unit_price_cents : ref.price_cents) || 0;
        const lineTotal = unitCents * (ref.qty || 1) + (ref.modifiers || []).reduce((a, m) => a + (m.price_delta_cents || 0) * (ref.qty || 1), 0);
        const voidBtn = (kind === 'staged' || ref.state === 'held')
          ? '<button class="icon-btn" data-void="' + esc(String(ref.temp_id || ref.id)) + '" data-kind="' + kind + '" aria-label="Void item" title="Void">✕</button>' : '';
        return '<div class="cart-line"><div class="nm">' + esc(ref.name) + (ref.qty > 1 ? ' <span class="qty">×' + ref.qty + '</span>' : '') +
          (mods ? '<span class="mods">' + mods + '</span>' : '') + '</div>' + pill +
          '<span class="pr">' + fmt(lineTotal) + '</span>' + voidBtn + '</div>';
      }).join('') + '</div>').join('');
    $$('[data-void]', cartBody).forEach((b) => b.onclick = () => {
      const id = b.dataset.void, kind = b.dataset.kind;
      confirmDialog('Void item', 'Remove this item from the order? (Held items only — sent items go through the kitchen.)', 'Void item', async () => {
        if (kind === 'staged') {
          staged = staged.filter((s) => s.temp_id !== id);
          saveStaged(checkId, staged);
          drawCart();
        } else {
          await voidHeldItem(checkId, id);
          renderRoute(true);
        }
      });
    });
  }

  async function voidHeldItem(cid, itemId) {
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
        if (!absorbed) await Outbox.enqueue('void_item', { check_id: realId(cid), item_id: itemId });
        toast('Void queued', 'ok');
      } else {
        await api('/api/checks/' + realId(cid) + '/items/' + itemId, 'DELETE');
        toast('Item voided', 'ok');
      }
    } catch (e) { handleApiError(e); }
  }

  $('#btn-hold').onclick = async () => {
    if (!staged.length) { toast('Nothing staged — tap menu items first'); return; }
    const items = staged.map((s) => ({ temp_id: s.temp_id, menu_item_id: s.menu_item_id, name: s.name, price_cents: s.price_cents, seat: s.seat, qty: s.qty, modifiers: s.modifiers }));
    staged = []; saveStaged(checkId, staged);
    try {
      if (isOffline()) {
        if (String(checkId).startsWith('tmp-')) {
          const d = JSON.parse(localStorage.getItem('expoline.draft:' + checkId));
          items.forEach((it) => d.items.push({ id: it.temp_id, menu_item_id: it.menu_item_id, name: it.name, price_cents: it.price_cents, seat: it.seat, qty: it.qty, modifiers: it.modifiers, state: 'held' }));
          localStorage.setItem('expoline.draft:' + checkId, JSON.stringify(d));
        }
        await Outbox.enqueue('add_items', { check_id: realId(checkId), items });
        toast('Held offline — will sync', 'ok');
      } else {
        const rid = realId(checkId);
        for (const it of items) {
          await api('/api/checks/' + rid + '/items', 'POST', { menu_item_id: it.menu_item_id, seat: it.seat, qty: it.qty, modifiers: it.modifiers });
        }
        toast(items.length + (items.length === 1 ? ' item' : ' items') + ' held', 'ok');
      }
    } catch (e) { handleApiError(e); }
    renderRoute(true);
  };

  $('#btn-send').onclick = async () => {
    if (staged.length) { toast('Tap HOLD first to add staged items', 'err'); return; }
    const heldCount = (check.items || []).filter((i) => i.state === 'held').length;
    if (!heldCount) { toast('Nothing held to send'); return; }
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
        await api('/api/checks/' + realId(checkId) + '/send', 'POST');
        toast('Sent to kitchen & bar', 'ok');
      }
    } catch (e) { handleApiError(e); return; }
    renderRoute(true);
  };

  if (menu.length) { activeCat = menu[0].id; drawCats(); drawItems(); }
  drawSeats(); drawCart();
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

function closeKdsSocket() {
  if (state.kds.ws) { try { state.kds.ws.close(); } catch (e) {} state.kds.ws = null; }
  state.kds.wsUp = false;
  if (state.timers.kds) { clearInterval(state.timers.kds); state.timers.kds = null; }
}

function kdsElapsed(ts) {
  const s = Math.max(0, Math.floor((Date.now() - new Date(ts).getTime()) / 1000));
  return { s, mmss: pad2(Math.floor(s / 60)) + ':' + pad2(s % 60) };
}

async function renderKds(app) {
  if (state.user.role === 'server') { app.innerHTML = notAuthorized('The kitchen display is for kitchen and manager roles.'); return; }
  closeKdsSocket();
  state.kds.recall = false;
  state.kds.tickets = [];

  app.innerHTML =
    '<div class="view-head"><h1>Kitchen Display</h1><span class="spacer"></span>' +
    '<span class="kds-ws" id="kds-ws"><span class="dot-dead"></span>connecting…</span> ' +
    '<button class="btn btn-ghost" id="kds-recall-btn">Recall</button></div>' +
    '<div class="tabs" id="kds-tabs">' +
    KDS_STATIONS.map((s) => '<button class="tab' + (s.slug === state.kds.station ? ' active' : '') + '" data-st="' + esc(s.slug) + '">' + esc(s.label) + '</button>').join('') +
    '</div><div class="kds-grid" id="kds-grid"></div>';

  const grid = $('#kds-grid'), wsBadge = $('#kds-ws'), recallBtn = $('#kds-recall-btn');

  $$('#kds-tabs .tab').forEach((b) => b.onclick = () => {
    state.kds.station = b.dataset.st;
    state.kds.recall = false; recallBtn.textContent = 'Recall';
    $$('#kds-tabs .tab').forEach((x) => x.classList.toggle('active', x === b));
    loadTickets(); kdsSubscribe();
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

  function ticketCard(t) {
    const ts = t.fired_at || t.created_at || t.updated_at || Date.now();
    const el = kdsElapsed(ts);
    const timerCls = el.s > 20 * 60 ? 'late' : el.s > 10 * 60 ? 'warn' : '';
    const items = (t.items || []).map((i) => {
      const mods = (i.modifiers || []).map((m) => '<div class="tmods">+ ' + esc(m.name || m) + '</div>').join('');
      return '<div class="t-item"><div class="row1"><span class="qty">' + (i.qty || 1) + '×</span>' +
        '<span class="inm">' + esc(i.name || 'Item') + '</span>' +
        (i.seat ? '<span class="seat">SEAT ' + i.seat + '</span>' : '') + '</div>' + mods +
        (i.notes ? '<div class="tmods">✎ ' + esc(i.notes) + '</div>' : '') + '</div>';
    }).join('');
    const status = (t.status || 'new').toLowerCase().replace(/ /g, '_');
    const next = status === 'new' ? 'in_progress' : status === 'in_progress' ? 'fulfilled' : null;
    const bumpLabel = status === 'new' ? 'Start' : status === 'in_progress' ? 'Bump ✓' : null;
    return '<div class="ticket' + (el.s > 20 * 60 ? ' overdue' : el.s > 10 * 60 ? ' aging' : '') + '" data-tid="' + esc(String(t.id)) + '">' +
      '<div class="t-head"><span class="t-table">' + esc(t.table_label || t.table || '—') + '</span>' +
      '<span class="t-server">' + esc(t.server_name || t.server || '') + '</span>' +
      '<span class="t-status ' + esc(status) + '">' + esc(status.replace('_', ' ')) + '</span>' +
      '<span class="t-timer ' + timerCls + '" data-ts="' + esc(String(ts)) + '">' + el.mmss + '</span></div>' +
      items +
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
    } catch (e) { handleApiError(e); }
  }

  function kdsSubscribe() {
    closeKdsSocket();
    if (isOffline()) { wsBadge.innerHTML = '<span class="dot-dead"></span>offline'; return; }
    const tok = sessionStorage.getItem('expoline.token');
    if (!tok) return;
    const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    let ws;
    try { ws = new WebSocket(proto + location.host + '/ws?token=' + encodeURIComponent(tok)); }
    catch (e) { wsBadge.innerHTML = '<span class="dot-dead"></span>unavailable'; return; }
    state.kds.ws = ws;
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
      setTimeout(() => { if (state.route && state.route.view === 'kds') kdsSubscribe(); }, ms);
    };
    ws.onclose = down; ws.onerror = down;
  }

  // 1-second timer updates (mm:ss, amber >10min, red >20min)
  state.timers.kds = setInterval(() => {
    $$('#kds-grid .t-timer').forEach((el) => {
      const ts = el.dataset.ts;
      const e = kdsElapsed(ts);
      el.textContent = e.mmss;
      el.classList.toggle('warn', e.s > 10 * 60 && e.s <= 20 * 60);
      el.classList.toggle('late', e.s > 20 * 60);
      const card = el.closest('.ticket');
      if (card) {
        card.classList.toggle('aging', e.s > 10 * 60 && e.s <= 20 * 60);
        card.classList.toggle('overdue', e.s > 20 * 60);
      }
    });
  }, 1000);

  app._cleanup = () => { closeKdsSocket(); };
  await loadTickets();
  kdsSubscribe();
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

  const moneyRows = [
    ['Subtotal', fmt(t.subtotal)],
    ['5% surcharge', fmt(t.surcharge)],
    t.service_charge ? ['18% service charge <span class="lbl-note">8+ guests</span>', fmt(t.service_charge)] : null,
    ['Tax', fmt(t.tax)],
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
    '</table></div>' +

    '<div class="card"><h2>Split check</h2>' +
    (t.service_charge ? '<p class="small" style="color:var(--red)">Splitting is unavailable — an 18% service charge is applied to this check.</p>'
      : '<div class="split-row"><button class="btn" id="split-even">Split evenly</button>' +
        '<button class="btn" id="split-seat">Split by seat</button>' +
        '<button class="btn" id="split-move">Move items</button></div>') +
    '</div>' +

    '<div class="card"><h2>Payment</h2>' +
    '<div class="field"><label>Tip</label><div class="tip-row" id="tip-row">' +
    [15, 18, 20, 25].map((p) => '<button class="tip-chip" data-tip="' + p + '">' + p + '%</button>').join('') +
    '<button class="tip-chip" data-tip="custom">Custom</button></div>' +
    '<div class="field" id="tip-custom-wrap" style="display:none"><label for="tip-custom">Custom tip ($)</label><input type="number" id="tip-custom" min="0" step="0.01" inputmode="decimal" placeholder="0.00"></div>' +
    '<p class="small muted" id="tip-line">Tip: $0.00</p></div>' +
    '<div class="pay-methods"><button class="btn btn-big" id="pay-cash">Cash</button>' +
    '<button class="btn btn-big btn-primary" id="pay-card">Card</button></div></div>' +

    '<div class="card"><button class="btn btn-green btn-big btn-block" id="close-check"' + (t.balance > 0 ? ' disabled' : '') + '>' +
    (t.balance > 0 ? 'Balance remaining — cannot close' : 'Close check ✓') + '</button>' +
    (t.balance > 0 ? '' : '<p class="small muted" style="text-align:center;margin-top:8px">Balance is $0.00 — ready to close.</p>') + '</div>';

  function paymentLabel(p) {
    if (p.method === 'cash') return 'Cash' + (p.tendered_cents ? ' (tendered ' + fmt(p.tendered_cents) + ')' : '');
    if (p.method === 'card_demo' || p.method === 'card') return 'Card' + (p.brand ? ' · ' + esc(p.brand) : '') + (p.last4 ? ' •••• ' + esc(p.last4) : '') + ' <span class="pill staged">DEMO</span>';
    return esc(p.method || 'Payment');
  }

  /* ---- tip ---- */
  const tipLine = $('#tip-line');
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
      if (e instanceof ApiError) toast(e.message, 'err'); else handleApiError(e);
    }
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
      $('#sg-list', bd).innerHTML = Array.from({ length: guests }, (_, i) => i + 1).map((s) =>
        '<label><span style="min-width:70px;font-weight:700">Seat ' + s + '</span><div class="stepper"><button data-as="-1" data-s="' + s + '">−</button><span class="val" data-gv="' + s + '">' + assign[s] + '</span><button data-as="1" data-s="' + s + '">+</button></div></label>').join('');
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
        '<label><input type="checkbox" data-mv="' + esc(String(i.id)) + '"><span style="flex:1">' + (i.qty > 1 ? i.qty + '× ' : '') + esc(i.name) + ' <span class="muted small">Seat ' + (i.seat || '—') + '</span></span><span>' + fmt(((i.unit_price_cents != null ? i.unit_price_cents : i.price_cents) || 0) * (i.qty || 1)) + '</span></label>').join('') +
      '</div><div class="modal-actions"><button class="btn btn-ghost" data-x="c">Cancel</button><button class="btn btn-primary" data-x="go">Move to new check</button></div>');
    $('[data-x="c"]', bd).onclick = closeModal;
    $('[data-x="go"]', bd).onclick = async () => {
      const ids = $$('[data-mv]:checked', bd).map((c) => c.dataset.mv);
      if (!ids.length) { toast('Select at least one item', 'err'); return; }
      closeModal();
      await doSplit({ mode: 'move', item_ids: ids, target: 'new' });
    };
  };

  /* ---- payments ---- */
  const recordPayment = async (payload) => {
    let resp = null;
    try {
      if (isOffline()) {
        if (String(checkId).startsWith('tmp-')) {
          const d = JSON.parse(localStorage.getItem('expoline.draft:' + checkId));
          d.payments.push({ method: payload.method, amount_cents: payload.amount_cents, tip_cents: payload.tip_cents || 0, tendered_cents: payload.tendered_cents, brand: payload.brand, last4: payload.last4 });
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
    const due = Math.max(0, (t.balance || 0) + tipCents);
    let tendered = due;
    const bd = openModal('<h2>Cash payment</h2><p class="muted">Due: <b style="color:var(--brass-hi)">' + fmt(due) + '</b>' + (tipCents ? ' (incl. ' + fmt(tipCents) + ' tip)' : '') + '</p>' +
      '<div class="tip-row" id="cash-presets">' +
      '<button class="tip-chip" data-t="exact">Exact</button><button class="tip-chip" data-t="2000">$20</button><button class="tip-chip" data-t="5000">$50</button><button class="tip-chip" data-t="10000">$100</button></div>' +
      '<div class="field"><label for="cash-tendered">Tendered ($)</label><input type="number" id="cash-tendered" min="0" step="0.01" inputmode="decimal" value="' + (due / 100).toFixed(2) + '"></div>' +
      '<div class="change-due" id="cash-change">Change due: $0.00</div>' +
      '<div class="modal-actions"><button class="btn btn-ghost" data-x="c">Cancel</button><button class="btn btn-primary" data-x="go">Record cash payment</button></div>');
    const upd = () => {
      const ch = tendered - due;
      $('#cash-change', bd).textContent = 'Change due: ' + fmt(Math.max(0, ch));
      $('[data-x="go"]', bd).disabled = tendered < due;
    };
    $$('#cash-presets .tip-chip', bd).forEach((b) => b.onclick = () => {
      tendered = b.dataset.t === 'exact' ? due : Number(b.dataset.t);
      $('#cash-tendered', bd).value = (tendered / 100).toFixed(2);
      upd();
    });
    $('#cash-tendered', bd).addEventListener('input', (e) => { tendered = Math.round((parseFloat(e.target.value) || 0) * 100); upd(); });
    $('[data-x="c"]', bd).onclick = closeModal;
    $('[data-x="go"]', bd).onclick = async () => {
      closeModal();
      await recordPayment({ method: 'cash', amount_cents: t.balance, tip_cents: tipCents, tendered_cents: tendered });
    };
    upd();
  };

  $('#pay-card').onclick = () => {
    const due = Math.max(0, (t.balance || 0) + tipCents);
    const bd = openModal('<div class="demo-banner">DEMO TERMINAL — no real charge will be made</div>' +
      '<div class="term-screen" id="term-1"><h2>Card payment</h2><div class="term-amount">' + fmt(due) + '</div>' +
      (tipCents ? '<p class="muted small">includes ' + fmt(tipCents) + ' tip</p>' : '') +
      '<div class="term-btns"><button class="btn btn-big" data-tm="insert">Insert</button><button class="btn btn-big" data-tm="tap">Tap</button></div>' +
      '<div class="term-btns" style="margin-top:12px"><button class="btn btn-big" data-tm="swipe">Swipe</button><button class="btn btn-ghost" data-x="c">Cancel</button></div></div>' +
      '<div class="term-screen hidden" id="term-2"><h2>Processing…</h2><p class="muted">Contacting demo processor</p><p style="font-size:2rem">◌</p></div>' +
      '<div class="term-screen hidden" id="term-3"><div class="term-ok">✓</div><h2>Approved</h2>' +
      '<p class="muted">Auth code</p><p class="auth-code" id="term-auth"></p>' +
      '<div class="demo-banner" style="margin-top:12px">DEMO — simulated approval, nothing charged</div>' +
      '<button class="btn btn-primary btn-block" data-x="done">Done</button></div>');
    $('[data-x="c"]', bd).onclick = closeModal;
    let method = 'tap';
    $$('[data-tm]', bd).forEach((b) => b.onclick = async () => {
      method = b.dataset.tm;
      $('#term-1', bd).classList.add('hidden');
      $('#term-2', bd).classList.remove('hidden');
      const resp = await recordPayment({ method: 'card_demo', amount_cents: t.balance, tip_cents: tipCents, brand: 'Visa', last4: '4242' });
      $('#term-2', bd).classList.add('hidden');
      if (resp && resp.demo && resp.demo.auth_code) {
        $('#term-3', bd).classList.remove('hidden');
        $('#term-auth', bd).textContent = resp.demo.auth_code;
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

  const closeBtn = $('#close-check');
  if (closeBtn && !closeBtn.disabled) closeBtn.onclick = () => {
    confirmDialog('Close check', 'Close this check? The table will become available.', 'Close check', async () => {
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
     ['#/manager/shift', 'Shift report', active === 'shift'], ['#/manager/menu', 'Menu', active === 'menu']]
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
    '</div><p class="muted small mt">Detailed reconciliation lives under Finance &amp; Payouts — every fee named, no “Other” bucket.</p>';
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
      body.innerHTML = financeHtml(r, d);
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
    : '<tr><td>− Stripe fees <span class="lbl-note">no fee breakdown returned by API</span></td><td class="num neg">−' + fmt(feeTotal) + '</td></tr>';
  return '<div class="date-cols"><div class="date-col"><div class="k">Sales date</div><div class="v">' + esc(String(salesDate)) + '</div></div>' +
    '<div class="date-col"><div class="k">Payout date</div><div class="v">' + esc(String(payoutDate)) + '</div></div></div>' +
    '<div class="card"><h2>Reconciliation</h2><table class="fin-table">' +
    '<tr><td>Card volume</td><td class="num pos">' + fmt(cardVol) + '</td></tr>' +
    '<tr><td>− Refunds</td><td class="num neg">−' + fmt(refunds) + '</td></tr>' +
    feeRows +
    '<tr class="result"><td>= Expected payout</td><td class="num">' + fmt(expected) + '</td></tr>' +
    '</table>' +
    '<table class="fin-table" style="margin-top:14px"><tr><td>Tips (collected separately)</td><td class="num pos">' + fmt(tips) + '</td></tr></table>' +
    '<p class="tips-note">Tips are paid out to staff and are not taxed — they never reduce the payout above.</p></div>' +
    '<p class="muted small">Every fee is itemized by name. There is no “Other” bucket — if a fee exists, it is listed.</p>';
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
      body.innerHTML = shiftHtml(r, d);
    } catch (e) { if (handleApiError(e) !== 'bounced') body.innerHTML = '<div class="empty">Could not load shift report.</div>'; }
  };
  $('#sh-date').addEventListener('change', load);
  await load();
}

function shiftHtml(r, date) {
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
    '</table></div></div>';
}

async function renderMenuViewer(app) {
  if (!mgrGuard(app)) return;
  app.innerHTML = '<div class="view-head"><h1>Menu</h1><span class="muted small">read-only</span></div>' + mgrNav('menu') + '<div id="menu-body"><p class="muted">Loading…</p></div>';
  try {
    const menu = await getMenu();
    $('#menu-body').innerHTML = menu.map((c) =>
      '<div class="card menu-cat"><h2>' + esc(c.name) + '</h2>' +
      c.items.map((i) => '<div class="menu-item-row"><span>' + esc(i.name) +
        (isDrink(i, c.name) ? ' <span class="drink-tag">BAR</span>' : '') +
        ((i.modifiers || []).length ? ' <span class="muted small">· ' + i.modifiers.length + ' mods</span>' : '') +
        '</span><span class="pr">' + fmt(i.price_cents) + '</span></div>').join('') + '</div>').join('');
  } catch (e) { if (handleApiError(e) !== 'bounced') $('#menu-body').innerHTML = '<div class="empty">Could not load menu.</div>'; }
}

/* ============================================================
   INIT
   ============================================================ */
function bindGlobal() {
  window.addEventListener('hashchange', () => {
    if (state.route && state.route.view === 'kds' && parseRoute().view !== 'kds') closeKdsSocket();
    if (typeof $('#app')._cleanup === 'function') { try { $('#app')._cleanup(); } catch (e) {} $('#app')._cleanup = null; }
    renderRoute();
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
  else renderRoute();
  // flush anything queued from a previous session
  if (state.user && !isOffline()) setTimeout(() => flushOutbox(), 1500);
}

document.addEventListener('DOMContentLoaded', init);
