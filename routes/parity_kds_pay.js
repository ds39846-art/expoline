/* ============================================================================
 * Expoline — Phase 3B: Competitor parity (KDS + payments)
 * ----------------------------------------------------------------------------
 * Six MISSING parity-matrix categories, one module:
 *
 *   C. KDS ticket timers & aging alerts — thresholds as site_config DATA
 *      (kds_warn_secs / kds_late_secs / kds_alert_lead_secs); the ticket
 *      HEADER owns the aging color; /api/kds/alerts fires BEFORE the breach
 *      (aging_soon tickets with warn_in_s > 0), not after. Managers can
 *      also set the pair in minutes (kds_age_warn_minutes /
 *      kds_age_critical_minutes) via PUT /api/admin/settings, which
 *      writes through to the seconds keys — last writer owns the pair.
 *   C. Course-status headers — courseStatusFor() rides on EVERY ticket view
 *      (server.js ticketView): per-course held/fired/bumped so the line
 *      never has to ask. Course order: drink < appetizer < entree < dessert.
 *   D. Tip-outs / tip pooling — pooling rules are DATA (tipout_rules:
 *      name, role, basis food_sales|gross_sales|tips, pct in basis points),
 *      auto-computed at shift review. Integer cents throughout.
 *   D. QR guest self order & pay — /g/:token served by THIS server (LAN-
 *      ready, works when the internet is down); cash via staff-collect
 *      requests, card_demo settles instantly. NO real card processing —
 *      reader-ready (method column reserved for future 'card').
 *   D. Guest self-split — by_seat / even splits on the guest's phone,
 *      staff keep override (manager can reverse a guest split).
 *   E. Delivery-order aggregation — delivery checks land in the SAME single
 *      KDS queue (channel='delivery', source label), no tablet farm.
 *
 * INTEGRATION (integrator adds these lines to server.js):
 *   1. after the other migrate() calls:
 *        require('./routes/parity_kds_pay').migrate(db);
 *   2. after the kiosk register() (BEFORE the auth wall — public routes):
 *        require('./routes/parity_kds_pay').registerPublic(app, {
 *          db, SITE_ID, nowIso, crypto, persistTotals, checkResponse,
 *          broadcastTicket, ticketView, broadcastCheckUpdated,
 *        });
 *   3. after the online register() (after the auth wall — staff routes):
 *        require('./routes/parity_kds_pay').registerStaff(app, {
 *          db, SITE_ID, managerOnly, serverPlus, kitchenPlus, nowIso, crypto,
 *          persistTotals, checkResponse, broadcastCheckUpdated, ticketView,
 *        });
 *   4. server.js /send: add `course: it.course` to ticket item entries.
 *   5. server.js ticketView: add channel/source/course_status (see note in
 *      ticketView below for the exact lines).
 * ========================================================================== */

'use strict';

const isInt = (v) => Number.isInteger(v);
const parseJson = (s, fb) => { try { return JSON.parse(s ?? ''); } catch { return fb; } };
const cleanLabel = (v) => (typeof v === 'string' ? v.trim() : '');
const cleanOpt = (v) => { const s = cleanLabel(v); return s ? s : null; };

const COURSE_ORDER = ['drink', 'appetizer', 'entree', 'dessert'];
const CHANNELS = ['dine_in', 'takeout', 'online', 'delivery', 'qr_guest', 'kiosk'];
const TIPOUT_BASES = ['food_sales', 'gross_sales', 'tips'];

/* Rate limiting for public guest/delivery endpoints (per IP, rolling). */
const RATE_LIMIT_MAX = 12;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const rateBuckets = new Map();
function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || 'unknown';
}
function rateLimited(ip) {
  const now = Date.now();
  let b = rateBuckets.get(ip);
  if (!b) { b = []; rateBuckets.set(ip, b); }
  while (b.length && b[0] <= now - RATE_LIMIT_WINDOW_MS) b.shift();
  if (b.length >= RATE_LIMIT_MAX) return true;
  b.push(now);
  return false;
}

/* --------------------------------- migrate -------------------------------- */
function migrate(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS tipout_rules (
    id INTEGER PRIMARY KEY,
    site_id TEXT,
    name TEXT,
    role TEXT,
    basis TEXT CHECK(basis IN ('food_sales','gross_sales','tips')),
    pct_bps INTEGER,
    active INTEGER DEFAULT 1,
    created_at TEXT
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS cash_collect_requests (
    id INTEGER PRIMARY KEY,
    site_id TEXT,
    check_id INTEGER,
    amount_cents INTEGER,
    tip_cents INTEGER DEFAULT 0,
    tendered_cents INTEGER,
    status TEXT DEFAULT 'requested' CHECK(status IN ('requested','collected','cancelled')),
    created_at TEXT,
    collected_at TEXT,
    collected_by TEXT
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS guest_feedback (
    id INTEGER PRIMARY KEY,
    site_id TEXT,
    check_id INTEGER,
    rating INTEGER CHECK(rating BETWEEN 1 AND 5),
    note TEXT,
    created_at TEXT
  )`);

  const cols = (t) => new Set(db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name));
  const tcols = cols('tables');
  if (!tcols.has('qr_token')) db.exec('ALTER TABLE tables ADD COLUMN qr_token TEXT');
  const ccols = cols('checks');
  if (!ccols.has('channel')) db.exec("ALTER TABLE checks ADD COLUMN channel TEXT DEFAULT 'dine_in'");
  if (!ccols.has('source')) db.exec('ALTER TABLE checks ADD COLUMN source TEXT');
  if (!ccols.has('split_group')) db.exec('ALTER TABLE checks ADD COLUMN split_group TEXT');

  /* Item schema contract (shared with order-entry — see research P0-2):
   * check_items.note TEXT (free text, ≤140 chars, server-validated),
   * check_items.allergy INTEGER 0/1 (high-visibility allergy flag),
   * check_items.allergy_detail TEXT (optional detail, ≤140 chars).
   * KDS renders these from the ticket snapshot; it never edits them. */
  const icols = cols('check_items');
  if (!icols.has('note')) db.exec('ALTER TABLE check_items ADD COLUMN note TEXT');
  if (!icols.has('allergy')) db.exec('ALTER TABLE check_items ADD COLUMN allergy INTEGER DEFAULT 0');
  if (!icols.has('allergy_detail')) db.exec('ALTER TABLE check_items ADD COLUMN allergy_detail TEXT');

  /* Tender catalog expansion (split-tender / gift card / house account):
   * older DBs carry payments.method CHECK(method IN ('cash','card_demo')),
   * which hard-blocks gift_card rows the redeem endpoint already writes.
   * SQLite cannot ALTER a CHECK, so rebuild the table once (idempotent:
   * skipped when the constraint already allows the new methods). */
  const payCols = cols('payments');
  if (payCols.size && !payCols.has('memo')) {
    const row = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'payments'"
    ).get();
    const createSql = (row && row.sql) || '';
    if (createSql.includes("('cash','card_demo')")) {
      db.exec(`CREATE TABLE payments_new (
        id INTEGER PRIMARY KEY,
        uuid TEXT,
        check_id INTEGER,
        site_id TEXT,
        method TEXT CHECK(method IN ('cash','card_demo','gift_card','house_account')),
        amount_cents INTEGER,
        tip_cents INTEGER DEFAULT 0,
        tendered_cents INTEGER,
        brand TEXT,
        last4 TEXT,
        auth_code TEXT,
        memo TEXT,
        status TEXT DEFAULT 'completed' CHECK(status IN ('completed','refunded','partial_refund')),
        refunded_cents INTEGER DEFAULT 0,
        created_at TEXT
      )`);
      db.exec(`INSERT INTO payments_new
        (id, uuid, check_id, site_id, method, amount_cents, tip_cents, tendered_cents,
         brand, last4, auth_code, status, refunded_cents, created_at)
        SELECT id, uuid, check_id, site_id, method, amount_cents, tip_cents, tendered_cents,
         brand, last4, auth_code, status, refunded_cents, created_at FROM payments`);
      db.exec('DROP TABLE payments');
      db.exec('ALTER TABLE payments_new RENAME TO payments');
    } else {
      db.exec('ALTER TABLE payments ADD COLUMN memo TEXT');
    }
  }

  // Every table gets a stable QR token (idempotent).
  const crypto = require('crypto');
  for (const t of db.prepare("SELECT id, qr_token FROM tables WHERE qr_token IS NULL OR qr_token = ''").all()) {
    db.prepare('UPDATE tables SET qr_token = ? WHERE id = ?').run(crypto.randomUUID(), t.id);
  }
}

/* ------------------------------ aging helpers ----------------------------- */
const KDS_DEFAULTS = { warn_secs: 600, late_secs: 1200, alert_lead_secs: 240 };

function kdsThresholds(db, siteId) {
  const rows = db.prepare(
    "SELECT key, value FROM site_config WHERE site_id = ? AND key IN ('kds_warn_secs','kds_late_secs','kds_alert_lead_secs')"
  ).all(siteId);
  const th = { ...KDS_DEFAULTS };
  for (const r of rows) {
    const v = parseInt(r.value, 10);
    if (Number.isFinite(v) && v > 0) th[r.key.replace('kds_', '')] = v;
  }
  // Defensive ordering: lead < warn < late.
  if (!(th.alert_lead_secs < th.warn_secs)) th.alert_lead_secs = Math.max(30, Math.floor(th.warn_secs / 3));
  if (!(th.warn_secs < th.late_secs)) th.late_secs = th.warn_secs + 600;
  return { warn_secs: th.warn_secs, late_secs: th.late_secs, alert_lead_secs: th.alert_lead_secs };
}

/** Aging band for a ticket created at `createdAt` (ISO). Bands:
 *  fresh → aging_soon (within lead window BEFORE warn) → aging → overdue.
 *  Alerts fire on aging_soon — BEFORE the breach, not after. */
function agingFor(createdAt, th) {
  const elapsed = Math.max(0, Math.floor((Date.now() - new Date(createdAt).getTime()) / 1000));
  let band = 'fresh';
  if (elapsed >= th.late_secs) band = 'overdue';
  else if (elapsed >= th.warn_secs) band = 'aging';
  else if (elapsed >= th.warn_secs - th.alert_lead_secs) band = 'aging_soon';
  return { elapsed_s: elapsed, band, warn_in_s: Math.max(0, th.warn_secs - elapsed), late_in_s: Math.max(0, th.late_secs - elapsed) };
}

/* ----------------------------- course helpers ----------------------------- */
/** Per-course rollup for a check: held (not yet fired), fired (on a KDS
 *  ticket), bumped (on a bumped/fulfilled ticket). Rides on every ticket so
 *  the line never has to ask about previous courses. */
function courseStatusFor(db, checkId) {
  const out = COURSE_ORDER.map((c) => ({ course: c, held: 0, fired: 0, bumped: 0, total: 0 }));
  const by = Object.fromEntries(out.map((o) => [o.course, o]));
  const held = db.prepare(
    "SELECT course, COUNT(*) AS n FROM check_items WHERE check_id = ? AND state = 'held' GROUP BY course"
  ).all(checkId);
  for (const r of held) {
    if (!COURSE_ORDER.includes(r.course)) continue;
    by[r.course].held += r.n;
  }
  const tickets = db.prepare('SELECT status, items_json FROM kds_tickets WHERE check_id = ?').all(checkId);
  for (const t of tickets) {
    const done = t.status === 'fulfilled';
    for (const it of parseJson(t.items_json, [])) {
      const c = it.course;
      if (!COURSE_ORDER.includes(c)) continue;
      const q = isInt(it.qty) && it.qty > 0 ? it.qty : 1;
      by[c].fired += q;
      if (done) by[c].bumped += q;
    }
  }
  for (const o of out) o.total = o.held + o.fired;
  return out.filter((o) => o.total > 0);
}

function ticketCourses(itemsJson) {
  const seen = [];
  for (const it of parseJson(itemsJson, [])) {
    if (COURSE_ORDER.includes(it.course) && !seen.includes(it.course)) seen.push(it.course);
  }
  return seen.sort((a, b) => COURSE_ORDER.indexOf(a) - COURSE_ORDER.indexOf(b));
}

/* ------------------------------ money helpers ----------------------------- */
function lineCents(it) {
  const mods = parseJson(it.modifiers_json, []);
  const modSum = mods.reduce((a, m) => a + (isInt(m.price_delta_cents) ? m.price_delta_cents : 0), 0);
  return it.qty * (it.unit_price_cents + modSum);
}
function moneyInt(v) { return isInt(v) && v >= 0; }

/* ============================ PUBLIC: guest QR ============================ */
function registerPublic(app, ctx) {
  const { db, SITE_ID, nowIso, crypto, persistTotals, broadcastTicket, ticketView, broadcastCheckUpdated, effectivePriceCents, dayClosedToday } = ctx;
  // Happy-hour resolver injected by the host; without it lines price at
  // the regular menu price, exactly as before.
  const effPrice = typeof effectivePriceCents === 'function' ? effectivePriceCents : null;
  // EOD freeze (audit gap #5): the host owns the close-out lock; a
  // payment created here would be dated today, so a closed-out today
  // refuses it. Absent the helper (older hosts), behavior is unchanged.
  const todayClosed = typeof dayClosedToday === 'function' ? dayClosedToday : () => false;

  const tableByToken = (token) =>
    db.prepare('SELECT * FROM tables WHERE qr_token = ? AND site_id = ?').get(String(token || ''), SITE_ID);
  const checkByGuestToken = (token) =>
    db.prepare('SELECT * FROM checks WHERE uuid = ? AND site_id = ?').get(String(token || ''), SITE_ID);

  function priceLines(items) {
    const itemStmt = db.prepare('SELECT * FROM menu_items WHERE id = ? AND site_id = ? AND active = 1');
    const modStmt = db.prepare('SELECT price_delta_cents FROM menu_modifiers WHERE item_id = ? AND name = ?');
    const lines = [];
    for (const [idx, it] of items.entries()) {
      if (!it || !isInt(it.menu_item_id)) return { error: `items[${idx}].menu_item_id must be an integer` };
      const mi = itemStmt.get(it.menu_item_id, SITE_ID);
      if (!mi) return { error: `items[${idx}]: unknown or unavailable menu item` };
      if (!(mi.price_cents > 0)) return { error: `items[${idx}]: "${mi.name}" requires staff pricing` };
      const qty = it.qty === undefined ? 1 : it.qty;
      if (!isInt(qty) || qty < 1 || qty > 12) return { error: `items[${idx}].qty must be 1–12` };
      const seat = it.seat === undefined ? 1 : it.seat;
      if (!isInt(seat) || seat < 1 || seat > 40) return { error: `items[${idx}].seat must be 1–40` };
      const mods = it.modifiers === undefined ? [] : it.modifiers;
      if (!Array.isArray(mods) || mods.length > 8) return { error: `items[${idx}].modifiers must be an array (max 8)` };
      const priced = [];
      for (const m of mods) {
        if (!m || typeof m.name !== 'string' || !m.name.trim()) return { error: `items[${idx}]: each modifier needs a name` };
        const row = modStmt.get(mi.id, m.name.trim());
        if (!row) return { error: `items[${idx}]: unknown modifier "${m.name}" for "${mi.name}"` };
        priced.push({ name: m.name.trim(), price_delta_cents: row.price_delta_cents });
      }
      /* Special request + allergy flag ride the shared item schema
       * (check_items.note / .allergy / .allergy_detail) through to KDS. */
      let note = null;
      if (it.note !== undefined && it.note !== null) {
        if (typeof it.note !== 'string' || !it.note.trim()) return { error: `items[${idx}].note must be a non-empty string` };
        if (it.note.trim().length > 140) return { error: `items[${idx}].note is limited to 140 characters` };
        note = it.note.trim();
      }
      let allergy = 0;
      if (it.allergy !== undefined && it.allergy !== null) {
        if (it.allergy !== true && it.allergy !== false) return { error: `items[${idx}].allergy must be true or false` };
        allergy = it.allergy ? 1 : 0;
      }
      let allergyDetail = null;
      if (it.allergy_detail !== undefined && it.allergy_detail !== null) {
        if (typeof it.allergy_detail !== 'string' || !it.allergy_detail.trim()) return { error: `items[${idx}].allergy_detail must be a non-empty string` };
        if (it.allergy_detail.trim().length > 140) return { error: `items[${idx}].allergy_detail is limited to 140 characters` };
        allergyDetail = it.allergy_detail.trim();
      }
      lines.push({ mi, qty, seat, modifiers: priced, note, allergy, allergy_detail: allergyDetail, unit_price_cents: effPrice ? effPrice(mi) : mi.price_cents });
    }
    return { lines };
  }

  /* Serve the guest page. Registered before express.static; the client JS
     validates the token against /api/guest/menu and shows a friendly error
     for bad/rotated tokens. */
  app.get('/g/:token', (req, res) => {
    res.sendFile(require('path').join(__dirname, '..', 'public', 'guest.html'));
  });
  app.get('/g/check/:guest_token', (req, res) => {
    res.sendFile(require('path').join(__dirname, '..', 'public', 'guest.html'));
  });

  /* Guest menu for a table token. Public (customer's phone). */
  app.get('/api/guest/menu', (req, res) => {
    const table = tableByToken(req.query.token);
    if (!table) return res.status(404).json({ error: 'This QR code is not linked to a table — ask your server' });
    const cats = db.prepare(
      'SELECT id, name FROM menu_categories WHERE site_id = ? ORDER BY id'
    ).all(SITE_ID);
    const itemStmt = db.prepare(
      'SELECT id, name, description, price_cents, hh_price_cents, item_type, course FROM menu_items WHERE category_id = ? AND site_id = ? AND active = 1 ORDER BY id'
    );
    const modStmt = db.prepare('SELECT name, price_delta_cents FROM menu_modifiers WHERE item_id = ? ORDER BY id');
    res.json({
      table: { id: table.id, label: table.label, seats: table.seats },
      categories: cats.map((c) => ({
        id: c.id, name: c.name,
        items: itemStmt.all(c.id, SITE_ID).map((i) => ({
          id: i.id, name: i.name, description: i.description, price_cents: i.price_cents,
          hh_price_cents: i.hh_price_cents != null ? i.hh_price_cents : null,
          effective_price_cents: effPrice ? effPrice(i) : i.price_cents,
          hh_active: effPrice ? effPrice(i) !== i.price_cents : false,
          item_type: i.item_type, course: i.course,
          modifiers: modStmt.all(i.id),
        })),
      })),
    });
  });

  /* Guest self-order: creates a check on the token's table and fires items
     straight to the KDS (guest orders are fire-immediately, like kiosk). */
  app.post('/api/guest/orders', (req, res) => {
    if (rateLimited(clientIp(req))) return res.status(429).json({ error: 'Too many requests — wait a moment and try again' });
    const table = tableByToken((req.body || {}).token);
    if (!table) return res.status(404).json({ error: 'This QR code is not linked to a table — ask your server' });
    const b = req.body || {};
    const items = b.items;
    if (!Array.isArray(items) || !items.length || items.length > 24) {
      return res.status(400).json({ error: 'items must be a non-empty array (max 24)' });
    }
    const priced = priceLines(items);
    if (priced.error) return res.status(400).json({ error: priced.error });
    const guestName = cleanOpt(b.guest_name);

    const at = nowIso();
    const checkId = db.prepare(
      "INSERT INTO checks (uuid, site_id, table_id, server_id, tab_name, guest_count, channel, status, opened_at) VALUES (?, ?, ?, NULL, ?, 1, 'qr_guest', 'open', ?)"
    ).run(crypto.randomUUID(), SITE_ID, table.id,
      `QR · ${table.label}${guestName ? ' · ' + guestName : ''}`, at).lastInsertRowid;

    const insItem = db.prepare(
      "INSERT INTO check_items (uuid, check_id, menu_item_id, seat, qty, unit_price_cents, modifiers_json, course, state, note, allergy, allergy_detail, added_at, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'sent', ?, ?, ?, ?, ?)"
    );
    const byStation = new Map();
    for (const ln of priced.lines) {
      const r = insItem.run(crypto.randomUUID(), checkId, ln.mi.id, ln.seat, ln.qty,
        ln.unit_price_cents, JSON.stringify(ln.modifiers), ln.mi.course,
        ln.note, ln.allergy, ln.allergy_detail, at, at);
      const st = ln.mi.station || 'expediter';
      if (!byStation.has(st)) byStation.set(st, []);
      byStation.get(st).push({
        item_id: Number(r.lastInsertRowid), name: ln.mi.name, seat: ln.seat,
        qty: ln.qty, modifiers: ln.modifiers, course: ln.mi.course,
        note: ln.note, allergy: ln.allergy, allergy_detail: ln.allergy_detail,
      });
    }

    const tickets = [];
    const insTicket = db.prepare(
      "INSERT INTO kds_tickets (uuid, check_id, site_id, station, table_label, server_name, items_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'new', ?)"
    );
    for (const [station, tItems] of byStation) {
      const r = insTicket.run(crypto.randomUUID(), checkId, SITE_ID, station, table.label, 'QR guest', JSON.stringify(tItems), at);
      const tv = ticketView(db.prepare('SELECT * FROM kds_tickets WHERE id = ?').get(r.lastInsertRowid));
      tickets.push(tv);
      broadcastTicket(tv);
    }
    const totals = persistTotals(checkId);
    broadcastCheckUpdated(checkId);
    const check = db.prepare('SELECT uuid FROM checks WHERE id = ?').get(checkId);
    res.status(201).json({ check_id: checkId, guest_token: check.uuid, totals, tickets: tickets.map((t) => t.id) });
  });

  /* Guest check view: items by seat, totals, balance. */
  app.get('/api/guest/check', (req, res) => {
    const check = checkByGuestToken(req.query.guest_token);
    if (!check) return res.status(404).json({ error: 'Check not found' });
    const totals = persistTotals(check.id);
    const items = db.prepare(
      `SELECT ci.id, ci.seat, ci.qty, ci.unit_price_cents, ci.modifiers_json, ci.course, ci.state, ci.note, ci.allergy, ci.allergy_detail, mi.name
       FROM check_items ci JOIN menu_items mi ON mi.id = ci.menu_item_id
       WHERE ci.check_id = ? AND ci.state IN ('held','sent','fulfilled') ORDER BY ci.seat, ci.id`
    ).all(check.id);
    res.json({
      guest_token: check.uuid, status: check.status, channel: check.channel || 'dine_in',
      table_label: check.table_id ? (db.prepare('SELECT label FROM tables WHERE id = ?').get(check.table_id) || {}).label : null,
      items: items.map((i) => ({ seat: i.seat, name: i.name, qty: i.qty, course: i.course, state: i.state,
        unit_price_cents: i.unit_price_cents, modifiers: parseJson(i.modifiers_json, []), line_cents: lineCents(i),
        note: i.note || null, allergy: !!i.allergy, allergy_detail: i.allergy_detail || null })),
      totals,
    });
  });

  /* Guest pay. card_demo settles immediately (demo tender); cash creates a
     staff-collect request (no payment row until staff collects). All totals
     recomputed server-side — client amounts are validated, never trusted.
     Reader-ready: method 'card' + terminal fields slot in here later. */
  app.post('/api/guest/pay', (req, res) => {
    if (rateLimited(clientIp(req))) return res.status(429).json({ error: 'Too many requests — wait a moment and try again' });
    const b = req.body || {};
    const check = checkByGuestToken(b.guest_token);
    if (!check) return res.status(404).json({ error: 'Check not found' });
    if (check.status !== 'open') return res.status(400).json({ error: `This check is ${check.status} — ask your server` });
    const method = b.method;
    if (!['card_demo', 'cash'].includes(method)) {
      return res.status(400).json({ error: "method must be 'card_demo' or 'cash'" });
    }
    const totals = persistTotals(check.id);
    const amount = b.amount_cents;
    if (!moneyInt(amount) || amount <= 0 || amount > totals.balance) {
      return res.status(400).json({ error: `amount_cents must be 1–${totals.balance} (the remaining balance)` });
    }
    const tip = b.tip_cents === undefined ? 0 : b.tip_cents;
    if (!moneyInt(tip) || (amount < totals.balance && tip > 0)) {
      // Tips only ride on full-balance payments; partial pays are tender-only.
      if (!moneyInt(tip)) return res.status(400).json({ error: 'tip_cents must be a whole number of cents' });
      return res.status(400).json({ error: 'Tip is only accepted when paying the full balance' });
    }
    if (tip > 0 && amount !== totals.balance) {
      return res.status(400).json({ error: 'Tip is only accepted when paying the full balance' });
    }

    if (method === 'cash') {
      const tendered = b.tendered_cents;
      if (tendered !== undefined && tendered !== null) {
        if (!moneyInt(tendered) || tendered < amount + tip) {
          return res.status(400).json({ error: `tendered_cents must cover amount + tip (${amount + tip}¢) when supplied` });
        }
      }
      const r = db.prepare(
        "INSERT INTO cash_collect_requests (site_id, check_id, amount_cents, tip_cents, tendered_cents, status, created_at) VALUES (?, ?, ?, ?, ?, 'requested', ?)"
      ).run(SITE_ID, check.id, amount, tip, moneyInt(tendered) ? tendered : null, nowIso());
      broadcastCheckUpdated(check.id);
      return res.status(201).json({
        cash_request: { id: Number(r.lastInsertRowid), status: 'requested' },
        message: 'Your server has been notified — they will collect your cash payment.',
        totals,
      });
    }

    // EOD freeze: this payment would be dated today — a closed-out day
    // takes no new money. (The cash path above creates no payment row;
    // the staff collect step enforces the same lock when money moves.)
    if (todayClosed()) {
      return res.status(409).json({ error: 'This business day has been closed out — please see a staff member to finish paying', day_closed: true });
    }

    // card_demo: settle now (demo tender — no real charge).
    const at = nowIso();
    const pr = db.prepare(
      "INSERT INTO payments (uuid, check_id, site_id, method, amount_cents, tip_cents, brand, auth_code, status, created_at) VALUES (?, ?, ?, 'card_demo', ?, ?, 'DEMO', 'DEMO', 'completed', ?)"
    ).run(crypto.randomUUID(), check.id, SITE_ID, amount, tip, at);
    const after = persistTotals(check.id);
    if (after.balance <= 0) db.prepare("UPDATE checks SET status = 'paid' WHERE id = ?").run(check.id);
    broadcastCheckUpdated(check.id);
    res.status(201).json({
      payment: { id: Number(pr.lastInsertRowid), method: 'card_demo', amount_cents: amount, tip_cents: tip },
      demo: 'DEMO tender — no real charge. Real card processing lands with Daniel\'s Stripe Terminal keys.',
      totals: after,
    });
  });

  /* Guest self-split: by_seat (seat_groups: [[1],[2,3]]) or even (across
     distinct seats). Staff keep override — see registerStaff reverse. */
  app.post('/api/guest/split', (req, res) => {
    if (rateLimited(clientIp(req))) return res.status(429).json({ error: 'Too many requests — wait a moment and try again' });
    const b = req.body || {};
    const check = checkByGuestToken(b.guest_token);
    if (!check) return res.status(404).json({ error: 'Check not found' });
    if (check.status !== 'open') return res.status(400).json({ error: `Cannot split a ${check.status} check` });
    if (check.split_group) return res.status(400).json({ error: 'This check is already part of a split — ask your server' });
    const totals = persistTotals(check.id);
    if (totals.service_charge > 0) {
      return res.status(400).json({ error: 'Large-party checks stay on one check — ask your server to split' });
    }
    const payCount = db.prepare('SELECT COUNT(*) AS n FROM payments WHERE check_id = ?').get(check.id).n;
    if (payCount > 0) return res.status(400).json({ error: 'This check already has payments — ask your server' });

    const items = db.prepare(
      `SELECT ci.*, mi.name FROM check_items ci JOIN menu_items mi ON mi.id = ci.menu_item_id
       WHERE ci.check_id = ? AND ci.state IN ('held','sent','fulfilled') ORDER BY ci.seat, ci.id`
    ).all(check.id);
    if (!items.length) return res.status(400).json({ error: 'Nothing to split' });

    const mode = b.mode;
    let groups;
    if (mode === 'by_seat') {
      const sgs = b.seat_groups;
      if (!Array.isArray(sgs) || !sgs.length) return res.status(400).json({ error: "mode 'by_seat' requires seat_groups: [[1],[2]]" });
      groups = sgs.map((sg) => {
        if (!Array.isArray(sg) || !sg.every((s) => isInt(s))) return null;
        const set = new Set(sg);
        return items.filter((it) => set.has(it.seat));
      });
      if (groups.some((g) => !g || !g.length)) return res.status(400).json({ error: 'Each seat group must match at least one seat with items' });
      const covered = new Set(groups.flat().map((it) => it.id));
      if (covered.size !== items.length) return res.status(400).json({ error: 'Seat groups must cover every seat exactly once' });
    } else if (mode === 'even') {
      const seats = [...new Set(items.map((it) => it.seat))].sort((a, c) => a - c);
      if (seats.length < 2) return res.status(400).json({ error: 'Even split needs at least 2 seats' });
      groups = seats.map((s) => items.filter((it) => it.seat === s));
    } else {
      return res.status(400).json({ error: "mode must be 'by_seat' or 'even'" });
    }

    const group = crypto.randomUUID();
    const at = nowIso();
    const created = [];
    db.prepare('BEGIN').run();
    try {
      db.prepare('UPDATE checks SET split_group = ? WHERE id = ?').run(group, check.id);
      const insCheck = db.prepare(
        "INSERT INTO checks (uuid, site_id, table_id, server_id, tab_name, guest_count, channel, split_group, status, opened_at) VALUES (?, ?, ?, ?, ?, ?, 'qr_guest', ?, 'open', ?)"
      );
      const moveStmt = db.prepare('UPDATE check_items SET check_id = ? WHERE id = ?');
      groups.forEach((g, i) => {
        const seats = [...new Set(g.map((it) => it.seat))];
        const r = insCheck.run(crypto.randomUUID(), SITE_ID, check.table_id, check.server_id,
          `Split ${i + 1} · seats ${seats.join(', ')}`, seats.length, group, at);
        for (const it of g) moveStmt.run(r.lastInsertRowid, it.id);
        persistTotals(r.lastInsertRowid);
        broadcastCheckUpdated(r.lastInsertRowid);
        const uuid = db.prepare('SELECT uuid FROM checks WHERE id = ?').get(r.lastInsertRowid).uuid;
        created.push({ check_id: Number(r.lastInsertRowid), guest_token: uuid, seats });
      });
      const remaining = db.prepare(
        "SELECT COUNT(*) AS n FROM check_items WHERE check_id = ? AND state IN ('held','sent','fulfilled')"
      ).get(check.id).n;
      if (remaining === 0) db.prepare("UPDATE checks SET status = 'closed', closed_at = ? WHERE id = ?").run(at, check.id);
      persistTotals(check.id);
      broadcastCheckUpdated(check.id);
      db.prepare('COMMIT').run();
    } catch (e) {
      try { db.prepare('ROLLBACK').run(); } catch { /* already rolled back */ }
      return res.status(500).json({ error: 'Split failed: ' + e.message });
    }
    res.status(201).json({ split_group: group, checks: created });
  });

  /* Post-payment review nudge — guest-optional, one tap, never a nag. */
  app.post('/api/guest/feedback', (req, res) => {
    const b = req.body || {};
    const check = checkByGuestToken(b.guest_token);
    if (!check) return res.status(404).json({ error: 'Check not found' });
    /* Post-payment feedback: the review prompt follows the paid check
     * (SpotOn Mobile Pay & Review parity) — not mid-meal. */
    if (!['paid', 'closed'].includes(check.status)) {
      return res.status(400).json({ error: 'Feedback opens after your check is paid — thanks for dining with us!' });
    }
    const rating = b.rating;
    if (!isInt(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'rating must be 1–5' });
    }
    const note = cleanOpt(b.note);
    if (note && note.length > 280) return res.status(400).json({ error: 'note is limited to 280 characters' });
    const r = db.prepare(
      'INSERT INTO guest_feedback (site_id, check_id, rating, note, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(SITE_ID, check.id, rating, note, nowIso());
    res.status(201).json({ feedback_id: Number(r.lastInsertRowid), thanks: 'Thanks for the feedback!' });
  });
}

/* ============================ STAFF (behind auth wall) ============================ */
function registerStaff(app, ctx) {
  const { db, SITE_ID, managerOnly, serverPlus, kitchenPlus, nowIso, crypto,
    persistTotals, broadcastCheckUpdated, broadcastTicket, ticketView, tzDate, effectivePriceCents, dayClosedToday, isDayClosed } = ctx;
  // EOD freeze helpers injected by the host (audit gap #5); absent them,
  // behavior is exactly as before.
  const todayClosed = typeof dayClosedToday === 'function' ? dayClosedToday : () => false;
  const dayIsClosed = typeof isDayClosed === 'function' ? isDayClosed : () => false;
  const effPrice = typeof effectivePriceCents === 'function' ? effectivePriceCents : null;
  /* Business-date bucketing matches Finance payouts: the SITE-LOCAL date of
   * a timestamp (server.js tzDate), never the raw UTC date inside the stored
   * string — California evening service is already the next UTC day, and the
   * two reports must agree on which day a sale belongs to. */
  const siteDateOf = typeof tzDate === 'function' ? tzDate : (iso) => (iso ? String(iso).slice(0, 10) : null);

  /* ---- KDS aging thresholds (data, not code) ---- */
  app.get('/api/kds/settings', kitchenPlus(), (req, res) => {
    res.json({ thresholds: kdsThresholds(db, SITE_ID) });
  });

  app.post('/api/kds/settings', managerOnly(), (req, res) => {
    const b = req.body || {};
    const set = {};
    for (const k of ['warn_secs', 'late_secs', 'alert_lead_secs']) {
      if (b[k] === undefined) continue;
      const v = b[k];
      if (!isInt(v) || v <= 0 || v > 7200) {
        return res.status(400).json({ error: `${k} must be an integer 1–7200 (seconds)` });
      }
      set['kds_' + k] = String(v);
    }
    if (!Object.keys(set).length) return res.status(400).json({ error: 'Nothing to update' });
    const cur = kdsThresholds(db, SITE_ID);
    const next = { ...cur };
    for (const [k, v] of Object.entries(set)) next[k.replace('kds_', '')] = parseInt(v, 10);
    if (!(next.alert_lead_secs < next.warn_secs && next.warn_secs < next.late_secs)) {
      return res.status(400).json({ error: 'Required ordering: alert_lead_secs < warn_secs < late_secs' });
    }
    const up = db.prepare(
      'INSERT INTO site_config (site_id, key, value) VALUES (?, ?, ?) ON CONFLICT(site_id, key) DO UPDATE SET value = excluded.value'
    );
    for (const [k, v] of Object.entries(set)) up.run(SITE_ID, k, v);
    // Ownership: a warn/late write here (the seconds surface) supersedes
    // the manager minute settings — PUT /api/admin/settings writes
    // kds_age_*_minutes through to these same seconds keys, so drop the
    // minute keys and stored settings never claim values the board is
    // not running. Whichever surface wrote last owns the pair.
    if (set.kds_warn_secs !== undefined || set.kds_late_secs !== undefined) {
      db.prepare("DELETE FROM site_config WHERE site_id = ? AND key IN ('kds_age_warn_minutes','kds_age_critical_minutes')")
        .run(SITE_ID);
    }
    res.json({ thresholds: kdsThresholds(db, SITE_ID) });
  });

  /* ---- KDS aging alerts — fires BEFORE the breach, not after. ---- */
  app.get('/api/kds/alerts', kitchenPlus(), (req, res) => {
    const th = kdsThresholds(db, SITE_ID);
    const station = req.query.station;
    let sql = `SELECT t.*, c.channel, c.source FROM kds_tickets t
               LEFT JOIN checks c ON c.id = t.check_id
               WHERE t.site_id = ? AND t.status IN ('new','in_progress')`;
    const params = [SITE_ID];
    if (station) { sql += ' AND t.station = ?'; params.push(String(station)); }
    sql += ' ORDER BY t.created_at, t.id';
    const alerts = [];
    for (const t of db.prepare(sql).all(...params)) {
      const ag = agingFor(t.created_at, th);
      if (ag.band === 'fresh') continue; // alerts only: aging_soon and worse
      alerts.push({
        ticket_id: t.id, check_id: t.check_id, station: t.station,
        table_label: t.table_label, server_name: t.server_name,
        channel: t.channel || 'dine_in', source: t.source || null,
        elapsed_s: ag.elapsed_s, band: ag.band,
        warn_in_s: ag.warn_in_s, late_in_s: ag.late_in_s,
      });
    }
    res.json({ thresholds: th, alerts });
  });

  /* ---- Tip-out rules (pooling rules as data) ---- */
  const ruleView = (r) => ({
    id: r.id, name: r.name, role: r.role, basis: r.basis,
    pct_bps: r.pct_bps, pct: r.pct_bps / 100, active: !!r.active, created_at: r.created_at,
  });

  app.get('/api/tipout/rules', managerOnly(), (req, res) => {
    const rows = db.prepare(
      'SELECT * FROM tipout_rules WHERE site_id = ? AND active = 1 ORDER BY id'
    ).all(SITE_ID);
    res.json({ rules: rows.map(ruleView) });
  });

  app.post('/api/tipout/rules', managerOnly(), (req, res) => {
    const b = req.body || {};
    const name = cleanLabel(b.name);
    const role = cleanLabel(b.role);
    if (!name) return res.status(400).json({ error: 'name is required (e.g. "Busser tip-out")' });
    if (!role) return res.status(400).json({ error: 'role is required (e.g. "busser")' });
    if (!TIPOUT_BASES.includes(b.basis)) {
      return res.status(400).json({ error: `basis must be one of: ${TIPOUT_BASES.join(', ')}` });
    }
    if (!isInt(b.pct_bps) || b.pct_bps <= 0 || b.pct_bps > 10000) {
      return res.status(400).json({ error: 'pct_bps must be an integer 1–10000 (basis points; 500 = 5%)' });
    }
    const r = db.prepare(
      'INSERT INTO tipout_rules (site_id, name, role, basis, pct_bps, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(SITE_ID, name, role, b.basis, b.pct_bps, nowIso());
    res.status(201).json({ rule: ruleView(db.prepare('SELECT * FROM tipout_rules WHERE id = ?').get(r.lastInsertRowid)) });
  });

  app.put('/api/tipout/rules/:id', managerOnly(), (req, res) => {
    const rule = db.prepare('SELECT * FROM tipout_rules WHERE id = ? AND site_id = ? AND active = 1').get(req.params.id, SITE_ID);
    if (!rule) return res.status(404).json({ error: 'Tip-out rule not found' });
    const b = req.body || {};
    const name = b.name === undefined ? rule.name : cleanLabel(b.name);
    const role = b.role === undefined ? rule.role : cleanLabel(b.role);
    const basis = b.basis === undefined ? rule.basis : b.basis;
    const pct = b.pct_bps === undefined ? rule.pct_bps : b.pct_bps;
    if (!name) return res.status(400).json({ error: 'name is required' });
    if (!role) return res.status(400).json({ error: 'role is required' });
    if (!TIPOUT_BASES.includes(basis)) return res.status(400).json({ error: `basis must be one of: ${TIPOUT_BASES.join(', ')}` });
    if (!isInt(pct) || pct <= 0 || pct > 10000) return res.status(400).json({ error: 'pct_bps must be an integer 1–10000' });
    db.prepare('UPDATE tipout_rules SET name = ?, role = ?, basis = ?, pct_bps = ? WHERE id = ?')
      .run(name, role, basis, pct, rule.id);
    res.json({ rule: ruleView(db.prepare('SELECT * FROM tipout_rules WHERE id = ?').get(rule.id)) });
  });

  app.delete('/api/tipout/rules/:id', managerOnly(), (req, res) => {
    const rule = db.prepare('SELECT * FROM tipout_rules WHERE id = ? AND site_id = ? AND active = 1').get(req.params.id, SITE_ID);
    if (!rule) return res.status(404).json({ error: 'Tip-out rule not found' });
    db.prepare('UPDATE tipout_rules SET active = 0 WHERE id = ?').run(rule.id);
    res.json({ deleted: rule.id });
  });

  /* ---- Tip-out report: auto-computed at shift review, no spreadsheet. ----
     Per server per date: tips earned + food/gross sales, rules applied in
     integer cents (basis × pct_bps / 10000, rounded). */
  app.get('/api/tipout/report', managerOnly(), (req, res) => {
    const date = req.query.date;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    }
    const rules = db.prepare(
      'SELECT * FROM tipout_rules WHERE site_id = ? AND active = 1 ORDER BY id'
    ).all(SITE_ID);

    const servers = [];
    {
      const seen = new Set();
      const rows = db.prepare(
        `SELECT c.server_id AS id, u.name, c.opened_at FROM checks c
         JOIN users u ON u.id = c.server_id
         WHERE c.site_id = ? AND c.status IN ('paid','closed')`
      ).all(SITE_ID);
      for (const r of rows) {
        if (siteDateOf(r.opened_at) !== date || seen.has(r.id)) continue;
        seen.add(r.id);
        servers.push({ id: r.id, name: r.name });
      }
    }

    const itemStmt = db.prepare(
      `SELECT ci.qty, ci.unit_price_cents, ci.modifiers_json, ci.course
       FROM check_items ci WHERE ci.check_id = ? AND ci.state IN ('held','sent','fulfilled')`
    );
    const tipStmt = db.prepare(
      `SELECT p.tip_cents AS tip, p.created_at FROM payments p
       JOIN checks c ON c.id = p.check_id
       WHERE p.site_id = ? AND c.server_id = ? AND p.status = 'completed'`
    );

    const serverRows = [];
    const byRole = {};
    let grandTipout = 0;
    for (const s of servers) {
      /* Sales bases come from PAID/CLOSED checks only — open (unpaid) checks
       * must not inflate tip-outs. */
      const checks = db.prepare(
        "SELECT id, opened_at FROM checks WHERE site_id = ? AND server_id = ? AND status IN ('paid','closed')"
      ).all(SITE_ID, s.id).filter((c) => siteDateOf(c.opened_at) === date);
      let foodSales = 0, grossSales = 0;
      for (const c of checks) {
        for (const it of itemStmt.all(c.id)) {
          const line = lineCents(it);
          grossSales += line;
          if (it.course !== 'drink') foodSales += line;
        }
      }
      const tips = tipStmt.all(SITE_ID, s.id)
        .filter((p) => siteDateOf(p.created_at) === date)
        .reduce((a, p) => a + (p.tip || 0), 0);
      const basisOf = { food_sales: foodSales, gross_sales: grossSales, tips };
      const tipouts = rules.map((r) => {
        const owed = Math.round(basisOf[r.basis] * r.pct_bps / 10000);
        byRole[r.role] = (byRole[r.role] || 0) + owed;
        grandTipout += owed;
        return { rule_id: r.id, name: r.name, role: r.role, basis: r.basis, pct_bps: r.pct_bps, basis_cents: basisOf[r.basis], owed_cents: owed };
      });
      const totalTipout = tipouts.reduce((a, t) => a + t.owed_cents, 0);
      serverRows.push({
        server_id: s.id, server_name: s.name,
        tips_cents: tips, food_sales_cents: foodSales, gross_sales_cents: grossSales,
        tipouts, total_tipout_cents: totalTipout, net_tips_cents: tips - totalTipout,
      });
    }
    res.json({
      date,
      rules: rules.map(ruleView),
      servers: serverRows,
      by_role: Object.entries(byRole).map(([role, total_owed_cents]) => ({ role, total_owed_cents })),
      total_tipout_cents: grandTipout,
    });
  });

  /* ---- Delivery-order aggregation: SAME single KDS queue, no tablet farm ---- */
  app.post('/api/delivery/orders', serverPlus(), (req, res) => {
    if (rateLimited(clientIp(req))) return res.status(429).json({ error: 'Too many requests — wait a moment and try again' });
    const b = req.body || {};
    const source = cleanLabel(b.source);
    if (!source) return res.status(400).json({ error: 'source is required (e.g. "DoorDash")' });
    if (source.length > 40) return res.status(400).json({ error: 'source is limited to 40 characters' });
    const customer = cleanOpt(b.customer_name);
    const notes = cleanOpt(b.notes);
    const items = b.items;
    if (!Array.isArray(items) || !items.length || items.length > 24) {
      return res.status(400).json({ error: 'items must be a non-empty array (max 24)' });
    }
    // Reuse the guest pricer — server-side validation + re-pricing.
    const priced = priceGuestLines(db, SITE_ID, items, effPrice);
    if (priced.error) return res.status(400).json({ error: priced.error });

    const at = nowIso();
    const checkId = db.prepare(
      "INSERT INTO checks (uuid, site_id, table_id, server_id, tab_name, guest_count, channel, source, status, opened_at) VALUES (?, ?, NULL, ?, ?, 1, 'delivery', ?, 'open', ?)"
    ).run(crypto.randomUUID(), SITE_ID, req.user.id,
      `Delivery · ${source}${customer ? ' · ' + customer : ''}`, source, at).lastInsertRowid;

    const insItem = db.prepare(
      "INSERT INTO check_items (uuid, check_id, menu_item_id, seat, qty, unit_price_cents, modifiers_json, course, state, added_at, sent_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, 'sent', ?, ?)"
    );
    const byStation = new Map();
    for (const ln of priced.lines) {
      const r = insItem.run(crypto.randomUUID(), checkId, ln.mi.id, ln.qty,
        ln.unit_price_cents, JSON.stringify(ln.modifiers), ln.mi.course, at, at);
      const st = ln.mi.station || 'expediter';
      if (!byStation.has(st)) byStation.set(st, []);
      byStation.get(st).push({
        item_id: Number(r.lastInsertRowid), name: ln.mi.name, seat: 1,
        qty: ln.qty, modifiers: ln.modifiers, course: ln.mi.course,
        ...(notes ? { notes } : {}),
      });
    }
    const tickets = [];
    const insTicket = db.prepare(
      "INSERT INTO kds_tickets (uuid, check_id, site_id, station, table_label, server_name, items_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'new', ?)"
    );
    for (const [station, tItems] of byStation) {
      const r = insTicket.run(crypto.randomUUID(), checkId, SITE_ID, station,
        `DLV · ${source}`, req.user.name, JSON.stringify(tItems), at);
      const tv = ticketView(db.prepare('SELECT * FROM kds_tickets WHERE id = ?').get(r.lastInsertRowid));
      tickets.push(tv);
      broadcastTicket(tv);
    }
    const totals = persistTotals(checkId);
    broadcastCheckUpdated(checkId);
    res.status(201).json({ check_id: checkId, channel: 'delivery', source, totals, tickets: tickets.map((t) => t.id) });
  });

  app.get('/api/delivery/orders', serverPlus(), (req, res) => {
    const date = req.query.date;
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    const rows = db.prepare(
      `SELECT id, uuid, tab_name, source, status, opened_at, closed_at FROM checks
       WHERE site_id = ? AND channel = 'delivery' ${date ? "AND substr(opened_at,1,10) = ?" : ''} ORDER BY opened_at DESC LIMIT 100`
    ).all(...(date ? [SITE_ID, date] : [SITE_ID]));
    res.json({ orders: rows });
  });

  /* ---- Cash-collect requests (guest chose cash at the QR page) ---- */
  app.get('/api/cash-requests', serverPlus(), (req, res) => {
    const rows = db.prepare(
      `SELECT r.*, c.tab_name, t.label AS table_label FROM cash_collect_requests r
       JOIN checks c ON c.id = r.check_id LEFT JOIN tables t ON t.id = c.table_id
       WHERE r.site_id = ? AND r.status = 'requested' ORDER BY r.created_at`
    ).all(SITE_ID);
    res.json({ requests: rows });
  });

  app.post('/api/cash-requests/:id/collect', serverPlus(), (req, res) => {
    const r = db.prepare('SELECT * FROM cash_collect_requests WHERE id = ? AND site_id = ?').get(req.params.id, SITE_ID);
    if (!r) return res.status(404).json({ error: 'Cash request not found' });
    if (r.status !== 'requested') return res.status(400).json({ error: `Request is ${r.status}` });
    const check = db.prepare('SELECT * FROM checks WHERE id = ?').get(r.check_id);
    if (!check || check.status !== 'open') return res.status(400).json({ error: 'Check is no longer open' });
    // EOD freeze: collecting creates a payment dated today — a
    // closed-out day takes no new money (reopen it from Finance).
    if (todayClosed()) {
      return res.status(409).json({ error: 'Business day is closed out — reopen it (Finance → Close day) before collecting new payments', day_closed: true });
    }
    const totals = persistTotals(check.id);
    if (r.amount_cents > totals.balance) {
      return res.status(400).json({ error: `Request of ${r.amount_cents}¢ exceeds the ${totals.balance}¢ balance` });
    }
    const at = nowIso();
    const pr = db.prepare(
      "INSERT INTO payments (uuid, check_id, site_id, method, amount_cents, tip_cents, tendered_cents, status, created_at) VALUES (?, ?, ?, 'cash', ?, ?, ?, 'completed', ?)"
    ).run(crypto.randomUUID(), check.id, SITE_ID, r.amount_cents, r.tip_cents || 0, r.tendered_cents, at);
    db.prepare("UPDATE cash_collect_requests SET status = 'collected', collected_at = ?, collected_by = ? WHERE id = ?")
      .run(at, req.user.name, r.id);
    const after = persistTotals(check.id);
    if (after.balance <= 0) db.prepare("UPDATE checks SET status = 'paid' WHERE id = ?").run(check.id);
    broadcastCheckUpdated(check.id);
    res.json({ payment_id: Number(pr.lastInsertRowid), collected_by: req.user.name, totals: after });
  });

  app.post('/api/cash-requests/:id/cancel', serverPlus(), (req, res) => {
    const r = db.prepare('SELECT * FROM cash_collect_requests WHERE id = ? AND site_id = ?').get(req.params.id, SITE_ID);
    if (!r) return res.status(404).json({ error: 'Cash request not found' });
    if (r.status !== 'requested') return res.status(400).json({ error: `Request is ${r.status}` });
    db.prepare("UPDATE cash_collect_requests SET status = 'cancelled' WHERE id = ?").run(r.id);
    res.json({ cancelled: r.id });
  });

  /* ---- Guest split reverse — staff keep override (manager) ---- */
  app.post('/api/guest/split/reverse', managerOnly(), (req, res) => {
    const group = cleanLabel((req.body || {}).split_group);
    if (!group) return res.status(400).json({ error: 'split_group is required' });
    const members = db.prepare('SELECT * FROM checks WHERE site_id = ? AND split_group = ?').all(SITE_ID, group);
    if (!members.length) return res.status(404).json({ error: 'Split group not found' });
    // Staff override is safe: refuse if ANY member of the group has payments,
    // not just the still-open children (a paid child is status 'paid', not 'open').
    for (const c of members) {
      const n = db.prepare('SELECT COUNT(*) AS n FROM payments WHERE check_id = ?').get(c.id).n;
      if (n > 0) return res.status(400).json({ error: `Split check ${c.id} already has payments — cannot reverse` });
    }
    const parent = members.find((c) => c.status === 'closed') || members[0];
    // EOD freeze: reversing moves lines back into the parent check —
    // if the parent already belongs to a closed-out business day, that
    // day money is settled history until the day is reopened.
    if (parent && parent.closed_at && dayIsClosed(siteDateOf(parent.closed_at))) {
      return res.status(409).json({ error: 'That split belongs to a closed-out business day — reopen it (Finance → Close day) before reversing', day_closed: true, business_date: siteDateOf(parent.closed_at) });
    }
    const children = members.filter((c) => c.id !== parent.id && c.status === 'open');
    const at = nowIso();
    const moveStmt = db.prepare('UPDATE check_items SET check_id = ? WHERE check_id = ?');
    db.prepare('BEGIN').run();
    try {
      for (const c of children) {
        moveStmt.run(parent.id, c.id);
        db.prepare("UPDATE checks SET status = 'closed', closed_at = ?, split_group = NULL WHERE id = ?").run(at, c.id);
        broadcastCheckUpdated(c.id);
      }
      db.prepare("UPDATE checks SET status = 'open', closed_at = NULL, split_group = NULL WHERE id = ?").run(parent.id);
      persistTotals(parent.id);
      broadcastCheckUpdated(parent.id);
      db.prepare('COMMIT').run();
    } catch (e) {
      try { db.prepare('ROLLBACK').run(); } catch { /* already rolled back */ }
      return res.status(500).json({ error: 'Reverse failed: ' + e.message });
    }
    res.json({ reversed: group, parent_check: parent.id });
  });

  /* ---- Table QR tokens (staff print the QR that guests scan) ---- */
  app.get('/api/tables/:id/qr', serverPlus(), (req, res) => {
    const t = db.prepare('SELECT id, label, qr_token FROM tables WHERE id = ? AND site_id = ?').get(req.params.id, SITE_ID);
    if (!t) return res.status(404).json({ error: 'Table not found' });
    const origin = `${req.protocol}://${req.get('host')}`;
    res.json({ table_id: t.id, label: t.label, token: t.qr_token, url: `${origin}/g/${t.qr_token}` });
  });

  app.post('/api/tables/:id/qr/rotate', managerOnly(), (req, res) => {
    const t = db.prepare('SELECT id, label FROM tables WHERE id = ? AND site_id = ?').get(req.params.id, SITE_ID);
    if (!t) return res.status(404).json({ error: 'Table not found' });
    const token = crypto.randomUUID();
    db.prepare('UPDATE tables SET qr_token = ? WHERE id = ?').run(token, t.id);
    const origin = `${req.protocol}://${req.get('host')}`;
    res.json({ table_id: t.id, label: t.label, token, url: `${origin}/g/${token}` });
  });

  /* ---- Guest feedback inbox (manager) ---- */
  app.get('/api/guest/feedback', managerOnly(), (req, res) => {
    const rows = db.prepare(
      `SELECT f.*, c.tab_name FROM guest_feedback f JOIN checks c ON c.id = f.check_id
       WHERE f.site_id = ? ORDER BY f.created_at DESC LIMIT 100`
    ).all(SITE_ID);
    res.json({ feedback: rows });
  });
}

/* Shared guest/delivery line pricer (server-side validation + re-pricing).
 * effPrice, when the host injects it, is the happy-hour resolver: a line
 * is priced at what the resolver returns for its menu item right now. */
function priceGuestLines(db, siteId, items, effPrice) {
  const itemStmt = db.prepare('SELECT * FROM menu_items WHERE id = ? AND site_id = ? AND active = 1');
  const modStmt = db.prepare('SELECT price_delta_cents FROM menu_modifiers WHERE item_id = ? AND name = ?');
  const lines = [];
  for (const [idx, it] of items.entries()) {
    if (!it || !isInt(it.menu_item_id)) return { error: `items[${idx}].menu_item_id must be an integer` };
    const mi = itemStmt.get(it.menu_item_id, siteId);
    if (!mi) return { error: `items[${idx}]: unknown or unavailable menu item` };
    if (!(mi.price_cents > 0)) return { error: `items[${idx}]: "${mi.name}" requires staff pricing` };
    const qty = it.qty === undefined ? 1 : it.qty;
    if (!isInt(qty) || qty < 1 || qty > 12) return { error: `items[${idx}].qty must be 1–12` };
    const mods = it.modifiers === undefined ? [] : it.modifiers;
    if (!Array.isArray(mods) || mods.length > 8) return { error: `items[${idx}].modifiers must be an array (max 8)` };
    const priced = [];
    for (const m of mods) {
      if (!m || typeof m.name !== 'string' || !m.name.trim()) return { error: `items[${idx}]: each modifier needs a name` };
      const row = modStmt.get(mi.id, m.name.trim());
      if (!row) return { error: `items[${idx}]: unknown modifier "${m.name}" for "${mi.name}"` };
      priced.push({ name: m.name.trim(), price_delta_cents: row.price_delta_cents });
    }
    lines.push({ mi, qty, modifiers: priced, unit_price_cents: effPrice ? effPrice(mi) : mi.price_cents });
  }
  return { lines };
}

module.exports = { migrate, registerPublic, registerStaff };
