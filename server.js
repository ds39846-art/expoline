'use strict';
/* ============================================================================
 * Expoline MVP v0.1 — backend
 * Node.js 24 + Express + node:sqlite (built into Node, no native npm deps) + ws
 * Port 4317. `npm install && npm start` runs everything.
 *
 * MONEY MATH (server-side single source of truth, ALL integer cents,
 * recomputed + persisted on every mutation via persistTotals()):
 *   billable items : state IN ('held','sent')          (cancelled excluded)
 *   line total     : qty * unit_price_cents + qty * Σ modifier price_delta_cents
 *   subtotal       : Σ lines
 *   surcharge      : round(subtotal * surcharge_pct)    (5% on every check)
 *   service charge : guest_count >= 8 ? round(subtotal * 18%) : 0
 *   taxable        : subtotal + surcharge
 *     - tips are NEVER taxed
 *     - the 18% service charge is NOT taxed in this demo (documented; some
 *       jurisdictions tax it — revisit before real pilot billing)
 *   tax            : round(taxable * tax_rate)          (7.75% from site_config)
 *   total          : subtotal + surcharge + service_charge + tax
 *   balance        : total - Σ(amount_cents - refunded_cents) over all payments
 *     (NOTE: the spec's literal formula `total - Σ(completed amount) +
 *      Σ(refunded)` double-counts refunds for refunded/partial_refund rows, so
 *      the net-paid form above is used; it is identical when there are no
 *      refunds, and it keeps the seeded double-charge correction at 0.)
 *   Stripe DEMO fee per card payment: round(net_amount_cents * 0.026) + 15¢,
 *     computed on the NET amount (amount - refunded); fully-refunded payments
 *     incur no fee. Always labeled "DEMO" — no real charges, ever.
 * ========================================================================== */

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const express = require('express');
const { WebSocketServer } = require('ws');

/* ------------------------------ boot: seed -------------------------------- */
const ROOT = __dirname;
const DB_DIR = path.join(ROOT, 'db');
const DB_PATH = path.join(DB_DIR, 'expoline.db');
const PUBLIC_DIR = path.join(ROOT, 'public');

fs.mkdirSync(DB_DIR, { recursive: true });
fs.mkdirSync(PUBLIC_DIR, { recursive: true });

if (!fs.existsSync(DB_PATH)) {
  const seedJs = path.join(DB_DIR, 'seed.js');
  if (!fs.existsSync(seedJs)) {
    console.error('FATAL: db/expoline.db is missing and db/seed.js was not found. Cannot boot.');
    process.exit(1);
  }
  console.log('[expoline] db/expoline.db not found — running db/seed.js …');
  execFileSync(process.execPath, [seedJs], { stdio: 'inherit', cwd: ROOT });
  if (!fs.existsSync(DB_PATH)) {
    console.error('FATAL: db/seed.js ran but db/expoline.db still missing. Cannot boot.');
    process.exit(1);
  }
}

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode=WAL;');
db.exec('PRAGMA foreign_keys=ON;');

/* --------------------------------- config --------------------------------- */
const PORT = 4317;
const SITE_TZ = 'America/Los_Angeles'; // Bali Hai pilot site timezone for date bucketing
const SITE_ID = (() => {
  const r = db.prepare("SELECT id FROM sites WHERE slug = 'bali-hai'").get()
    || db.prepare('SELECT id FROM sites LIMIT 1').get();
  if (!r) { console.error('FATAL: no site row in database.'); process.exit(1); }
  return r.id;
})();

function getConfig() {
  const rows = db.prepare('SELECT key, value FROM site_config WHERE site_id = ?').all(SITE_ID);
  const m = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    tax_rate: parseFloat(m.tax_rate ?? '0.0775'),
    surcharge_pct: parseFloat(m.surcharge_pct ?? '0.05'),
    service_charge_pct: parseFloat(m.service_charge_pct ?? '0.18'),
    service_charge_min_guests: parseInt(m.service_charge_min_guests ?? '8', 10),
    stripe_demo_rate: parseFloat(m.stripe_demo_rate ?? '0.026'),
    stripe_demo_fixed_cents: parseInt(m.stripe_demo_fixed_cents ?? '15', 10),
    payout_lag_days: parseInt(m.payout_lag_days ?? '2', 10),
  };
}

/* --------------------------------- helpers -------------------------------- */
const nowIso = () => new Date().toISOString();
const parseJson = (s, fb) => { try { return JSON.parse(s ?? ''); } catch { return fb; } };
const isInt = (v) => Number.isInteger(v);

/**
 * node:sqlite has no db.transaction() helper (unlike better-sqlite3), so we
 * wrap synchronous work in raw BEGIN/COMMIT/ROLLBACK. Safe here because every
 * DB call in this server is synchronous.
 */
function withTransaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  }
}

/** YYYY-MM-DD of an ISO timestamp in the site timezone. */
function tzDate(iso, tz = SITE_TZ) {
  if (!iso) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(iso));
}
const todaySite = () => tzDate(nowIso());

function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function lineTotal(it) {
  const mods = parseJson(it.modifiers_json, []);
  const qty = it.qty || 0;
  let t = qty * (it.unit_price_cents || 0);
  for (const mod of mods) t += qty * (mod.price_delta_cents || 0);
  return t;
}

/** Recompute every money field for a check; returns totals {subtotal, surcharge, service_charge, tax, total, paid, balance}. */
function calcTotals(checkId) {
  const cfg = getConfig();
  const items = db.prepare(
    "SELECT * FROM check_items WHERE check_id = ? AND state IN ('held','sent')"
  ).all(checkId);
  const subtotal = items.reduce((s, it) => s + lineTotal(it), 0);
  const surcharge = Math.round(subtotal * cfg.surcharge_pct);
  const check = db.prepare('SELECT guest_count FROM checks WHERE id = ?').get(checkId);
  const guests = check ? (check.guest_count || 0) : 0;
  const serviceCharge = guests >= cfg.service_charge_min_guests
    ? Math.round(subtotal * cfg.service_charge_pct) : 0;
  // Taxable base: subtotal + surcharge. Tips NEVER taxed; service charge not taxed (demo).
  const taxable = subtotal + surcharge;
  const tax = Math.round(taxable * cfg.tax_rate);
  const total = subtotal + surcharge + serviceCharge + tax;
  const pay = db.prepare(
    'SELECT COALESCE(SUM(amount_cents),0) AS amt, COALESCE(SUM(refunded_cents),0) AS ref FROM payments WHERE check_id = ?'
  ).get(checkId);
  const paid = (pay.amt || 0) - (pay.ref || 0);
  const balance = total - paid;
  return { subtotal, surcharge, service_charge: serviceCharge, tax, total, paid, balance };
}

/** Recompute + persist the money columns on the checks row. Call on every mutation. */
function persistTotals(checkId) {
  const t = calcTotals(checkId);
  db.prepare(
    'UPDATE checks SET subtotal_cents = ?, surcharge_cents = ?, service_charge_cents = ?, tax_cents = ?, total_cents = ? WHERE id = ?'
  ).run(t.subtotal, t.surcharge, t.service_charge, t.tax, t.total, checkId);
  return t;
}

function billableItems(checkId) {
  return db.prepare(
    "SELECT ci.*, mi.name, mi.station AS menu_station FROM check_items ci LEFT JOIN menu_items mi ON mi.id = ci.menu_item_id WHERE ci.check_id = ? AND ci.state IN ('held','sent') ORDER BY ci.added_at, ci.id"
  ).all(checkId);
}

function itemView(it) {
  return {
    id: it.id,
    menu_item_id: it.menu_item_id,
    name: it.name,
    seat: it.seat,
    qty: it.qty,
    unit_price_cents: it.unit_price_cents,
    modifiers: parseJson(it.modifiers_json, []),
    course: it.course,
    state: it.state,
    sent_at: it.sent_at,
    added_at: it.added_at,
    line_total_cents: lineTotal(it),
  };
}

/** Full check payload: check + items[] + totals. */
function checkResponse(checkId) {
  const c = db.prepare('SELECT * FROM checks WHERE id = ?').get(checkId);
  if (!c) return null;
  const t = persistTotals(checkId);
  const table = c.table_id ? db.prepare('SELECT label FROM tables WHERE id = ?').get(c.table_id) : null;
  const server = c.server_id ? db.prepare('SELECT name FROM users WHERE id = ?').get(c.server_id) : null;
  const items = db.prepare(
    'SELECT ci.*, mi.name FROM check_items ci LEFT JOIN menu_items mi ON mi.id = ci.menu_item_id WHERE ci.check_id = ? ORDER BY ci.added_at, ci.id'
  ).all(checkId);
  return {
    id: c.id,
    site_id: c.site_id,
    table_id: c.table_id,
    table_label: table ? table.label : null,
    server_id: c.server_id,
    server_name: server ? server.name : null,
    tab_name: c.tab_name,
    guest_count: c.guest_count,
    status: c.status,
    subtotal_cents: t.subtotal,
    surcharge_cents: t.surcharge,
    service_charge_cents: t.service_charge,
    tax_cents: t.tax,
    total_cents: t.total,
    opened_at: c.opened_at,
    closed_at: c.closed_at,
    items: items.map(itemView),
    totals: {
      subtotal: t.subtotal,
      surcharge: t.surcharge,
      service_charge: t.service_charge,
      tax: t.tax,
      total: t.total,
      paid: t.paid,
      balance: t.balance,
    },
  };
}

function ticketView(row) {
  return {
    id: row.id,
    check_id: row.check_id,
    station: row.station,
    table_label: row.table_label,
    server_name: row.server_name,
    items: parseJson(row.items_json, []),
    status: row.status,
    created_at: row.created_at,
    bumped_at: row.bumped_at,
    bumped_by: row.bumped_by,
  };
}

function paymentView(p) {
  return {
    id: p.id,
    check_id: p.check_id,
    method: p.method,
    amount_cents: p.amount_cents,
    tip_cents: p.tip_cents,
    tendered_cents: p.tendered_cents,
    brand: p.brand,
    last4: p.last4,
    auth_code: p.auth_code,
    status: p.status,
    refunded_cents: p.refunded_cents,
    created_at: p.created_at,
  };
}

/* ------------------------------- auth / roles ------------------------------ */
/** In-memory token map: token (32 hex chars) -> {id, name, role}. */
const tokens = new Map();

function issueToken(user) {
  const token = crypto.randomBytes(16).toString('hex');
  tokens.set(token, { id: user.id, name: user.name, role: user.role });
  return token;
}

/** 401 unless a valid Bearer token is present. Mounted on /api with two public paths. */
function authMiddleware(req, res, next) {
  if (req.path === '/health' || req.path === '/auth/login') return next();
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  const user = m ? tokens.get(m[1]) : null;
  if (!user) return res.status(401).json({ error: 'Unauthorized: valid Bearer token required' });
  req.user = user;
  next();
}

/**
 * Role enforcement (server-side). Usage: app.get('/x', requireRole('manager'), handler).
 * - kitchen: blocked from /api/finance/* and /api/menu/admin* (no menu-admin
 *   routes exist in MVP v0.1, so the restriction is vacuous but documented);
 *   CAN bump KDS.
 * - server: blocked from KDS bump; CAN do checks/items/send/split/pay.
 * - manager: everything, including refunds.
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: `Forbidden: requires role ${roles.join(' or ')}` });
    }
    next();
  };
}

const serverPlus = () => requireRole('server', 'manager');   // checks / items / send / split / pay / close
const kitchenPlus = () => requireRole('kitchen', 'manager'); // KDS read + bump
const managerOnly = () => requireRole('manager');            // finance / refunds / overview

/* ---------------------------------- app ----------------------------------- */
const app = express();
app.disable('x-powered-by');
app.use(express.json());

// Request logging (method/url/status/duration only — never tokens or bodies).
app.use((req, res, next) => {
  const t0 = Date.now();
  res.on('finish', () => {
    console.log(`${new Date().toISOString()} ${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - t0}ms`);
  });
  next();
});

app.use('/api', authMiddleware);

/* ------------------------------- public routes ----------------------------- */
app.get('/api/health', (req, res) => {
  res.json({ ok: true, mode: 'demo', site: 'bali-hai' });
});

app.post('/api/auth/login', (req, res) => {
  const pin = req.body && req.body.pin != null ? String(req.body.pin) : '';
  if (!pin) return res.status(401).json({ error: 'PIN required' });
  // PINs compared as strings.
  const user = db.prepare('SELECT id, name, role FROM users WHERE pin = ? AND site_id = ?').get(pin, SITE_ID);
  if (!user) return res.status(401).json({ error: 'Invalid PIN' });
  const token = issueToken(user);
  res.json({ token, user: { id: user.id, name: user.name, role: user.role } });
});

/* --------------------------------- config ---------------------------------- */
app.get('/api/config', (req, res) => {
  res.json(getConfig());
});

/* ---------------------------------- menu ----------------------------------- */
app.get('/api/menu', (req, res) => {
  const cats = db.prepare(
    'SELECT id, name, parent, sort FROM menu_categories WHERE site_id = ? ORDER BY sort, id'
  ).all(SITE_ID);
  const itemStmt = db.prepare(
    'SELECT id, name, description, price_cents, item_type, station, course, price_note FROM menu_items WHERE category_id = ? AND active = 1 ORDER BY id'
  );
  const modStmt = db.prepare(
    'SELECT id, name, price_delta_cents FROM menu_modifiers WHERE item_id = ? ORDER BY id'
  );
  res.json(cats.map((c) => ({
    id: c.id,
    name: c.name,
    parent: c.parent,
    sort: c.sort,
    items: itemStmt.all(c.id).map((it) => ({
      id: it.id,
      name: it.name,
      description: it.description,
      price_cents: it.price_cents,
      item_type: it.item_type,
      station: it.station,
      course: it.course,
      price_note: it.price_note,
      modifiers: modStmt.all(it.id),
    })),
  })));
});
// NOTE: /api/menu/admin* does not exist in MVP v0.1 (no menu editing); kitchen
// restriction on it is therefore vacuous.

/* ---------------------------------- zones ---------------------------------- */
app.get('/api/zones', (req, res) => {
  const zones = db.prepare('SELECT id, name FROM zones WHERE site_id = ? ORDER BY sort, id').all(SITE_ID);
  const tblStmt = db.prepare('SELECT id, label, seats FROM tables WHERE zone_id = ? ORDER BY id');
  const openStmt = db.prepare("SELECT id FROM checks WHERE table_id = ? AND status = 'open' LIMIT 1");
  res.json(zones.map((z) => ({
    id: z.id,
    name: z.name,
    tables: tblStmt.all(z.id).map((t) => {
      const open = openStmt.get(t.id);
      return { id: t.id, label: t.label, seats: t.seats, open_check_id: open ? open.id : null };
    }),
  })));
});

/* --------------------------------- checks ---------------------------------- */
app.post('/api/checks', serverPlus(), (req, res) => {
  const { table_id, guest_count, tab_name } = req.body || {};
  const table = table_id != null
    ? db.prepare('SELECT id FROM tables WHERE id = ? AND site_id = ?').get(table_id, SITE_ID)
    : null;
  if (!table) return res.status(400).json({ error: 'Valid table_id is required' });
  if (!isInt(guest_count) || guest_count < 1) {
    return res.status(400).json({ error: 'guest_count must be a positive integer' });
  }
  const existing = db.prepare("SELECT id FROM checks WHERE table_id = ? AND status = 'open' LIMIT 1").get(table_id);
  if (existing) return res.status(400).json({ error: 'Table already has an open check', check_id: existing.id });
  const r = db.prepare(
    "INSERT INTO checks (site_id, table_id, server_id, tab_name, guest_count, status, opened_at) VALUES (?, ?, ?, ?, ?, 'open', ?)"
  ).run(SITE_ID, table_id, req.user.id, tab_name || null, guest_count, nowIso());
  const check = checkResponse(r.lastInsertRowid);
  broadcastCheckUpdated(check.id);
  res.status(201).json(check);
});

app.get('/api/checks/open', serverPlus(), (req, res) => {
  const rows = db.prepare(
    `SELECT c.id, c.table_id, c.server_id, c.tab_name, c.guest_count, c.status, c.opened_at,
            t.label AS table_label, u.name AS server_name,
            (SELECT COUNT(*) FROM check_items ci WHERE ci.check_id = c.id AND ci.state IN ('held','sent')) AS item_count
     FROM checks c
     LEFT JOIN tables t ON t.id = c.table_id
     LEFT JOIN users u ON u.id = c.server_id
     WHERE c.site_id = ? AND c.status = 'open'
     ORDER BY c.opened_at`
  ).all(SITE_ID);
  res.json(rows.map((c) => {
    const t = persistTotals(c.id);
    return {
      id: c.id, table_id: c.table_id, table_label: c.table_label,
      server_id: c.server_id, server_name: c.server_name,
      tab_name: c.tab_name, guest_count: c.guest_count, status: c.status,
      item_count: c.item_count, total_cents: t.total, opened_at: c.opened_at,
    };
  }));
});

app.get('/api/checks/:id', serverPlus(), (req, res) => {
  const check = checkResponse(req.params.id);
  if (!check) return res.status(404).json({ error: 'Check not found' });
  res.json(check);
});

app.post('/api/checks/:id/items', serverPlus(), (req, res) => {
  const check = db.prepare('SELECT * FROM checks WHERE id = ? AND site_id = ?').get(req.params.id, SITE_ID);
  if (!check) return res.status(404).json({ error: 'Check not found' });
  if (check.status !== 'open') return res.status(400).json({ error: `Cannot add items to a ${check.status} check` });

  const { menu_item_id, seat, qty = 1, modifiers = [], unit_price_cents } = req.body || {};
  const menuItem = menu_item_id != null
    ? db.prepare('SELECT * FROM menu_items WHERE id = ? AND site_id = ? AND active = 1').get(menu_item_id, SITE_ID)
    : null;
  if (!menuItem) return res.status(400).json({ error: 'Valid active menu_item_id is required' });
  if (!isInt(seat) || seat < 1 || seat > check.guest_count) {
    return res.status(400).json({ error: `seat must be an integer between 1 and ${check.guest_count}` });
  }
  if (!isInt(qty) || qty < 1) return res.status(400).json({ error: 'qty must be a positive integer' });
  if (!Array.isArray(modifiers)) return res.status(400).json({ error: 'modifiers must be an array' });
  for (const m of modifiers) {
    if (!m || typeof m.name !== 'string' || !isInt(m.price_delta_cents)) {
      return res.status(400).json({ error: 'Each modifier needs {name, price_delta_cents}' });
    }
  }
  // MP (market price) items: price_cents = 0 requires a manager-entered price.
  let unitPrice = menuItem.price_cents;
  if (menuItem.price_cents === 0) {
    if (unit_price_cents == null) {
      return res.status(400).json({ error: 'Market-price item requires unit_price_cents (manager-entered price)' });
    }
    unitPrice = unit_price_cents;
  } else if (unit_price_cents != null) {
    unitPrice = unit_price_cents;
  }
  if (!isInt(unitPrice) || unitPrice < 0) {
    return res.status(400).json({ error: 'unit_price_cents must be a non-negative integer' });
  }

  const r = db.prepare(
    "INSERT INTO check_items (check_id, menu_item_id, seat, qty, unit_price_cents, modifiers_json, course, state, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'held', ?)"
  ).run(check.id, menuItem.id, seat, qty, unitPrice, JSON.stringify(modifiers), menuItem.course, nowIso());
  const item = db.prepare('SELECT ci.*, mi.name FROM check_items ci LEFT JOIN menu_items mi ON mi.id = ci.menu_item_id WHERE ci.id = ?').get(r.lastInsertRowid);
  persistTotals(check.id);
  broadcastCheckUpdated(check.id);
  res.status(201).json(itemView(item));
});

app.delete('/api/checks/:id/items/:item_id', serverPlus(), (req, res) => {
  const check = db.prepare('SELECT * FROM checks WHERE id = ? AND site_id = ?').get(req.params.id, SITE_ID);
  if (!check) return res.status(404).json({ error: 'Check not found' });
  if (check.status !== 'open') return res.status(400).json({ error: `Cannot void items on a ${check.status} check` });
  const item = db.prepare('SELECT * FROM check_items WHERE id = ? AND check_id = ?').get(req.params.item_id, check.id);
  if (!item) return res.status(404).json({ error: 'Item not found on this check' });
  if (item.state !== 'held') {
    return res.status(400).json({ error: `Only held items can be voided (item is ${item.state})` });
  }
  db.prepare("UPDATE check_items SET state = 'cancelled' WHERE id = ?").run(item.id);
  persistTotals(check.id);
  broadcastCheckUpdated(check.id);
  res.json({ voided: item.id, state: 'cancelled' });
});

/* ------------------------------ send + KDS --------------------------------- */
app.post('/api/checks/:id/send', serverPlus(), (req, res) => {
  const check = db.prepare('SELECT * FROM checks WHERE id = ? AND site_id = ?').get(req.params.id, SITE_ID);
  if (!check) return res.status(404).json({ error: 'Check not found' });
  if (check.status !== 'open') return res.status(400).json({ error: `Cannot send items on a ${check.status} check` });

  const held = db.prepare(
    "SELECT ci.*, mi.name, mi.station FROM check_items ci JOIN menu_items mi ON mi.id = ci.menu_item_id WHERE ci.check_id = ? AND ci.state = 'held' ORDER BY ci.added_at, ci.id"
  ).all(check.id);
  if (held.length === 0) return res.json({ sent: 0, tickets: [] });

  const sentAt = nowIso();
  const table = check.table_id ? db.prepare('SELECT label FROM tables WHERE id = ?').get(check.table_id) : null;
  const serverUser = check.server_id ? db.prepare('SELECT name FROM users WHERE id = ?').get(check.server_id) : null;

  const byStation = new Map();
  const markSent = db.prepare("UPDATE check_items SET state = 'sent', sent_at = ? WHERE id = ?");
  withTransaction(() => {
    for (const it of held) {
      markSent.run(sentAt, it.id);
      const station = it.station || 'expediter';
      if (!byStation.has(station)) byStation.set(station, []);
      byStation.get(station).push({
        item_id: it.id,
        name: it.name,
        seat: it.seat,
        qty: it.qty,
        modifiers: parseJson(it.modifiers_json, []),
      });
    }
  });

  const tickets = [];
  const insTicket = db.prepare(
    "INSERT INTO kds_tickets (check_id, site_id, station, table_label, server_name, items_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'new', ?)"
  );
  for (const [station, items] of byStation) {
    const r = insTicket.run(
      check.id, SITE_ID, station,
      table ? table.label : null,
      serverUser ? serverUser.name : null,
      JSON.stringify(items), sentAt
    );
    const ticket = ticketView(db.prepare('SELECT * FROM kds_tickets WHERE id = ?').get(r.lastInsertRowid));
    tickets.push(ticket);
    broadcastTicket(ticket); // push {type:'ticket'} to that station's subscribers
  }
  persistTotals(check.id);
  broadcastCheckUpdated(check.id);
  res.json({ sent: held.length, tickets });
});

/* --------------------------------- split ----------------------------------- */
app.post('/api/checks/:id/split', serverPlus(), (req, res) => {
  const check = db.prepare('SELECT * FROM checks WHERE id = ? AND site_id = ?').get(req.params.id, SITE_ID);
  if (!check) return res.status(404).json({ error: 'Check not found' });
  if (check.status !== 'open') return res.status(400).json({ error: `Cannot split a ${check.status} check` });

  // 8+ parties carry a service charge and must stay on ONE check.
  const totals = persistTotals(check.id);
  if (totals.service_charge > 0) {
    return res.status(400).json({ error: 'Cannot split: this check has an 18% large-party service charge and must stay on a single check' });
  }
  const payCount = db.prepare('SELECT COUNT(*) AS n FROM payments WHERE check_id = ?').get(check.id).n;
  if (payCount > 0) {
    return res.status(400).json({ error: 'Cannot split a check that already has payments' });
  }

  const items = billableItems(check.id);
  if (items.length === 0) return res.status(400).json({ error: 'Nothing to split: no billable items' });
  const withTotals = items.map((it) => ({ it, line: lineTotal(it) }));

  const { mode } = req.body || {};
  let groups = []; // array of arrays of check_items rows

  if (mode === 'even') {
    const parts = req.body.parts;
    if (!isInt(parts) || parts < 2) return res.status(400).json({ error: "mode 'even' requires integer parts >= 2" });
    // Fairness: sort lines by total desc, then round-robin.
    const sorted = [...withTotals].sort((a, b) => b.line - a.line);
    groups = Array.from({ length: parts }, () => []);
    sorted.forEach((w, i) => groups[i % parts].push(w.it));
    groups = groups.filter((g) => g.length > 0);
  } else if (mode === 'by_seat') {
    const seatGroups = req.body.groups;
    if (!Array.isArray(seatGroups) || seatGroups.length === 0 || !seatGroups.every((g) => Array.isArray(g) && g.length > 0 && g.every((s) => isInt(s) && s >= 1))) {
      return res.status(400).json({ error: "mode 'by_seat' requires groups: [[seat,...],...]" });
    }
    groups = seatGroups.map((seats) => withTotals.filter((w) => seats.includes(w.it.seat)).map((w) => w.it))
      .filter((g) => g.length > 0);
    if (groups.length === 0) return res.status(400).json({ error: 'No items match the requested seat groups' });
  } else if (mode === 'move') {
    const { item_ids, target } = req.body;
    if (!Array.isArray(item_ids) || item_ids.length === 0) {
      return res.status(400).json({ error: "mode 'move' requires item_ids: [...]" });
    }
    const ids = new Set(item_ids);
    const picked = withTotals.filter((w) => ids.has(w.it.id)).map((w) => w.it);
    if (picked.length !== ids.size) {
      return res.status(400).json({ error: 'One or more item_ids not found as billable items on this check' });
    }
    groups = [picked];
    req._moveTarget = target;
  } else {
    return res.status(400).json({ error: "mode must be 'even', 'by_seat', or 'move'" });
  }

  const now = nowIso();
  const createdIds = [];
  const doSplit = () => {
    if (mode === 'move' && req._moveTarget !== 'new' && req._moveTarget != null) {
      const targetCheck = db.prepare('SELECT * FROM checks WHERE id = ? AND site_id = ?').get(req._moveTarget, SITE_ID);
      if (!targetCheck) throw Object.assign(new Error('Target check not found'), { status: 404 });
      if (targetCheck.status !== 'open') throw Object.assign(new Error('Target check is not open'), { status: 400 });
      if (targetCheck.id === check.id) throw Object.assign(new Error('Target check must differ from source'), { status: 400 });
      const moveStmt = db.prepare('UPDATE check_items SET check_id = ? WHERE id = ?');
      for (const it of groups[0]) moveStmt.run(targetCheck.id, it.id);
      createdIds.push(targetCheck.id);
      persistTotals(targetCheck.id);
      broadcastCheckUpdated(targetCheck.id);
    } else {
      const insCheck = db.prepare(
        "INSERT INTO checks (site_id, table_id, server_id, tab_name, guest_count, status, opened_at) VALUES (?, ?, ?, ?, ?, 'open', ?)"
      );
      const moveStmt = db.prepare('UPDATE check_items SET check_id = ? WHERE id = ?');
      groups.forEach((g, i) => {
        const seats = [...new Set(g.map((it) => it.seat))];
        const label = check.tab_name ? `${check.tab_name} · split ${i + 1}` : `Split ${i + 1}`;
        const r = insCheck.run(SITE_ID, check.table_id, check.server_id, label, Math.max(1, seats.length), now);
        for (const it of g) moveStmt.run(r.lastInsertRowid, it.id);
        persistTotals(r.lastInsertRowid);
        broadcastCheckUpdated(r.lastInsertRowid);
        createdIds.push(Number(r.lastInsertRowid));
      });
    }
    // If the source check is now empty (no billable items, no payments), close it.
    const remaining = db.prepare(
      "SELECT COUNT(*) AS n FROM check_items WHERE check_id = ? AND state IN ('held','sent')"
    ).get(check.id).n;
    if (remaining === 0) {
      db.prepare("UPDATE checks SET status = 'closed', closed_at = ? WHERE id = ?").run(now, check.id);
    }
    persistTotals(check.id);
    broadcastCheckUpdated(check.id);
  };

  try {
    withTransaction(doSplit);
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message || 'Split failed' });
  }
  res.json({ split_from: check.id, checks: createdIds });
});

/* -------------------------------- payments --------------------------------- */
app.post('/api/checks/:id/payments', serverPlus(), (req, res) => {
  const check = db.prepare('SELECT * FROM checks WHERE id = ? AND site_id = ?').get(req.params.id, SITE_ID);
  if (!check) return res.status(404).json({ error: 'Check not found' });
  if (check.status !== 'open') return res.status(400).json({ error: `Cannot take payment on a ${check.status} check` });

  const { method, amount_cents, tip_cents = 0, tendered_cents, brand, last4 } = req.body || {};
  if (!['cash', 'card_demo'].includes(method)) {
    return res.status(400).json({ error: "method must be 'cash' or 'card_demo'" });
  }
  if (!isInt(amount_cents) || amount_cents <= 0) {
    return res.status(400).json({ error: 'amount_cents must be a positive integer' });
  }
  if (!isInt(tip_cents) || tip_cents < 0) {
    return res.status(400).json({ error: 'tip_cents must be a non-negative integer' });
  }
  if (tendered_cents != null && !isInt(tendered_cents)) {
    return res.status(400).json({ error: 'tendered_cents must be an integer' });
  }

  const totals = persistTotals(check.id);
  if (totals.balance <= 0) return res.status(400).json({ error: 'Check is already paid in full' });

  let authCode = null;
  let demo = null;
  if (method === 'card_demo') {
    // Simulated terminal: DEMO ONLY — no real charge is ever made.
    authCode = 'DEMO' + crypto.randomBytes(3).toString('hex').toUpperCase();
    demo = { approved: true, auth_code: authCode, message: 'DEMO terminal - no real charge' };
  }

  const r = db.prepare(
    "INSERT INTO payments (check_id, site_id, method, amount_cents, tip_cents, tendered_cents, brand, last4, auth_code, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?)"
  ).run(check.id, SITE_ID, method, amount_cents, tip_cents, tendered_cents ?? null,
    brand || (method === 'card_demo' ? 'DEMO' : null), last4 || null, authCode, nowIso());
  const payment = paymentView(db.prepare('SELECT * FROM payments WHERE id = ?').get(r.lastInsertRowid));

  const after = persistTotals(check.id);
  if (after.balance <= 0) {
    db.prepare("UPDATE checks SET status = 'paid' WHERE id = ?").run(check.id);
  }

  broadcastCheckUpdated(check.id);
  const out = { payment, check: checkResponse(check.id) };
  if (method === 'cash' && tendered_cents != null) out.change_cents = tendered_cents - amount_cents;
  if (demo) out.demo = demo;
  res.status(201).json(out);
});

app.post('/api/payments/:id/refund', managerOnly(), (req, res) => {
  const payment = db.prepare('SELECT * FROM payments WHERE id = ? AND site_id = ?').get(req.params.id, SITE_ID);
  if (!payment) return res.status(404).json({ error: 'Payment not found' });
  if (payment.status === 'refunded') return res.status(400).json({ error: 'Payment already fully refunded' });

  const remaining = payment.amount_cents - (payment.refunded_cents || 0);
  const { amount_cents } = req.body || {};
  const refundAmt = amount_cents == null ? remaining : amount_cents;
  if (!isInt(refundAmt) || refundAmt <= 0 || refundAmt > remaining) {
    return res.status(400).json({ error: `amount_cents must be a positive integer <= ${remaining} (remaining refundable)` });
  }

  const newRefunded = (payment.refunded_cents || 0) + refundAmt;
  const newStatus = newRefunded >= payment.amount_cents ? 'refunded' : 'partial_refund';
  db.prepare('UPDATE payments SET refunded_cents = ?, status = ? WHERE id = ?')
    .run(newRefunded, newStatus, payment.id);

  const totals = persistTotals(payment.check_id);
  const check = db.prepare('SELECT status FROM checks WHERE id = ?').get(payment.check_id);
  if (check && check.status === 'paid' && totals.balance > 0) {
    // Refund pushed the check back to a positive balance — reopen it.
    db.prepare("UPDATE checks SET status = 'open' WHERE id = ?").run(payment.check_id);
  }
  broadcastCheckUpdated(payment.check_id);
  res.json({ payment: paymentView(db.prepare('SELECT * FROM payments WHERE id = ?').get(payment.id)) });
});

app.post('/api/checks/:id/close', serverPlus(), (req, res) => {
  const check = db.prepare('SELECT * FROM checks WHERE id = ? AND site_id = ?').get(req.params.id, SITE_ID);
  if (!check) return res.status(404).json({ error: 'Check not found' });
  if (check.status === 'closed') return res.status(400).json({ error: 'Check already closed' });
  const totals = persistTotals(check.id);
  if (totals.balance > 0) {
    return res.status(400).json({ error: `Cannot close: outstanding balance of ${totals.balance}¢ remains` });
  }
  db.prepare("UPDATE checks SET status = 'closed', closed_at = ? WHERE id = ?").run(nowIso(), check.id);
  broadcastCheckUpdated(check.id);
  res.json(checkResponse(check.id));
});

/* ----------------------------------- KDS ----------------------------------- */
app.get('/api/kds/tickets', kitchenPlus(), (req, res) => {
  const { station, status = 'open' } = req.query;
  let statusClause = "t.status IN ('new','in_progress')";
  if (status === 'new' || status === 'in_progress' || status === 'fulfilled') {
    statusClause = 't.status = ?';
  } else if (status === 'all') {
    statusClause = '1 = 1';
  } else if (status !== 'open') {
    return res.status(400).json({ error: "status must be 'open', 'new', 'in_progress', 'fulfilled', or 'all'" });
  }
  let sql = `SELECT t.* FROM kds_tickets t WHERE t.site_id = ? AND ${statusClause}`;
  const params = [SITE_ID];
  if (statusClause === 't.status = ?') params.push(status);
  if (station) {
    if (!['bar', 'expediter', 'garde_manger', 'dessert'].includes(station)) {
      return res.status(400).json({ error: 'Unknown station' });
    }
    sql += ' AND t.station = ?';
    params.push(station);
  }
  sql += ' ORDER BY t.created_at, t.id';
  res.json(db.prepare(sql).all(...params).map(ticketView));
});

app.post('/api/kds/tickets/:id/bump', kitchenPlus(), (req, res) => {
  const ticket = db.prepare('SELECT * FROM kds_tickets WHERE id = ? AND site_id = ?').get(req.params.id, SITE_ID);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  const { status } = req.body || {};
  if (!['in_progress', 'fulfilled'].includes(status)) {
    return res.status(400).json({ error: "status must be 'in_progress' or 'fulfilled'" });
  }
  const now = nowIso();
  db.prepare('UPDATE kds_tickets SET status = ?, bumped_at = ?, bumped_by = ? WHERE id = ?')
    .run(status, now, req.user.name, ticket.id);
  const updated = ticketView(db.prepare('SELECT * FROM kds_tickets WHERE id = ?').get(ticket.id));
  broadcastTicketUpdated(updated);
  res.json(updated);
});

app.get('/api/kds/recall', kitchenPlus(), (req, res) => {
  const cutoff = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const rows = db.prepare(
    "SELECT * FROM kds_tickets WHERE site_id = ? AND status = 'fulfilled' AND bumped_at >= ? ORDER BY bumped_at DESC"
  ).all(SITE_ID, cutoff);
  res.json(rows.map(ticketView));
});

/* --------------------------------- finance --------------------------------- */
const DEMO_FINANCE_NOTE = 'DEMO — all card processing is simulated. No real charges, no real payouts.';

function demoFeeCents(netAmountCents) {
  const cfg = getConfig();
  if (netAmountCents <= 0) return 0;
  return Math.round(netAmountCents * cfg.stripe_demo_rate) + cfg.stripe_demo_fixed_cents;
}

app.get('/api/finance/payouts', managerOnly(), (req, res) => {
  const date = req.query.date || todaySite();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  const cfg = getConfig();

  const payments = db.prepare('SELECT * FROM payments WHERE site_id = ? ORDER BY created_at, id').all(SITE_ID)
    .filter((p) => tzDate(p.created_at) === date);

  let cardVolume = 0, refunds = 0, fees = 0, cashSales = 0, tips = 0;
  const cardPayments = [];
  for (const p of payments) {
    tips += p.tip_cents || 0;
    const refunded = p.refunded_cents || 0;
    if (p.method === 'card_demo') {
      const net = p.amount_cents - refunded;
      if (p.status === 'completed' || p.status === 'partial_refund') cardVolume += p.amount_cents;
      else if (p.status === 'refunded') { cardVolume += p.amount_cents; }
      refunds += refunded;
      const fee = demoFeeCents(net);
      fees += fee;
      cardPayments.push({
        id: p.id, check_id: p.check_id, brand: p.brand, last4: p.last4,
        amount_cents: p.amount_cents, tip_cents: p.tip_cents, fee_cents: fee,
        fee_label: 'DEMO', refunded_cents: refunded, status: p.status,
      });
    } else if (p.method === 'cash') {
      cashSales += p.amount_cents;
    }
  }
  const expectedPayout = cardVolume - refunds - fees;
  res.json({
    demo: true,
    note: DEMO_FINANCE_NOTE,
    sales_date: date,
    payout_date: addDays(date, cfg.payout_lag_days),
    payout_lag_days: cfg.payout_lag_days,
    card_volume_cents: cardVolume,
    refunds_cents: refunds,
    stripe_fees_cents: fees,
    stripe_fee_label: 'DEMO (simulated)',
    expected_payout_cents: expectedPayout,
    cash_sales_cents: cashSales,
    tips_cents: tips,
    card_payments: cardPayments,
  });
});

app.get('/api/finance/shift', managerOnly(), (req, res) => {
  const date = req.query.date || todaySite();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  const serverId = req.query.server_id != null ? Number(req.query.server_id) : null;
  if (req.query.server_id != null && !isInt(serverId)) {
    return res.status(400).json({ error: 'server_id must be an integer' });
  }

  let sql = "SELECT * FROM checks WHERE site_id = ? AND status IN ('paid','closed') AND closed_at IS NOT NULL";
  const params = [SITE_ID];
  if (serverId != null) { sql += ' AND server_id = ?'; params.push(serverId); }
  const checks = db.prepare(sql).all(...params).filter((c) => tzDate(c.closed_at) === date);

  let subtotal = 0, tips = 0, cashSales = 0, cardTips = 0;
  const brandBreakdown = {};
  const payStmt = db.prepare('SELECT * FROM payments WHERE check_id = ?');
  for (const c of checks) {
    const t = persistTotals(c.id);
    subtotal += t.subtotal;
    for (const p of payStmt.all(c.id)) {
      tips += p.tip_cents || 0;
      if (p.method === 'card_demo' && (p.status === 'completed' || p.status === 'partial_refund')) {
        const b = p.brand || 'Unknown';
        brandBreakdown[b] = (brandBreakdown[b] || 0) + p.amount_cents;
        cardTips += p.tip_cents || 0;
      } else if (p.method === 'cash') {
        cashSales += p.amount_cents;
      }
    }
  }
  // cash_owed_to_server: card tips the house must pay out to the server at
  // checkout (servers keep their cash tips directly).
  res.json({
    demo: true,
    note: DEMO_FINANCE_NOTE,
    date,
    server_id: serverId,
    checks_closed: checks.length,
    subtotal_cents: subtotal,
    tips_cents: tips,
    card_brand_breakdown: brandBreakdown,
    cash_sales_cents: cashSales,
    cash_owed_to_server_cents: cardTips,
    cash_owed_to_server_note: 'Card tips the house owes the server at checkout (cash tips are kept directly)',
  });
});

/* --------------------------------- manager --------------------------------- */
app.get('/api/manager/overview', managerOnly(), (req, res) => {
  const today = todaySite();
  const openChecks = db.prepare("SELECT COUNT(*) AS n FROM checks WHERE site_id = ? AND status = 'open'").get(SITE_ID).n;
  const closedToday = db.prepare(
    "SELECT id, guest_count, closed_at FROM checks WHERE site_id = ? AND status IN ('paid','closed') AND closed_at IS NOT NULL"
  ).all(SITE_ID).filter((c) => tzDate(c.closed_at) === today);
  let sales = 0, covers = 0;
  for (const c of closedToday) {
    sales += persistTotals(c.id).total;
    covers += c.guest_count || 0;
  }

  const alerts = [];
  const staleOpen = db.prepare(
    "SELECT id, table_id, opened_at FROM checks WHERE site_id = ? AND status = 'open' AND opened_at < ?"
  ).all(SITE_ID, new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString());
  for (const c of staleOpen) {
    const table = c.table_id ? db.prepare('SELECT label FROM tables WHERE id = ?').get(c.table_id) : null;
    alerts.push({ type: 'check_open_too_long', check_id: c.id, table_label: table ? table.label : null, opened_at: c.opened_at });
  }
  const staleTickets = db.prepare(
    "SELECT id, station, table_label, created_at FROM kds_tickets WHERE site_id = ? AND status = 'new' AND created_at < ?"
  ).all(SITE_ID, new Date(Date.now() - 30 * 60 * 1000).toISOString());
  for (const t of staleTickets) {
    alerts.push({ type: 'kds_ticket_stale', ticket_id: t.id, station: t.station, table_label: t.table_label, created_at: t.created_at });
  }

  res.json({
    today: { date: today, open_checks: openChecks, sales_cents: sales, covers },
    alerts,
  });
});

/* --------------------------- 404 for unknown /api --------------------------- */
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

/* ------------------------- static frontend + SPA fallback ------------------- */
// The frontend is built by a sibling agent into public/. Serve it; if it is
// not there yet, GET / shows a small status page instead of a 404.
app.use(express.static(PUBLIC_DIR));
app.use((req, res, next) => {
  if (req.method !== 'GET') return next();
  const idx = path.join(PUBLIC_DIR, 'index.html');
  if (fs.existsSync(idx)) return res.sendFile(idx);
  res.status(200).type('html').send(
    '<!doctype html><html><head><title>Expoline</title></head><body style="font-family:sans-serif;padding:2rem">' +
    '<h1>Expoline backend</h1><p>API is running. The frontend bundle is not in <code>public/</code> yet.</p>' +
    '<p><a href="/api/health">GET /api/health</a></p></body></html>'
  );
});

/* -------------------------------- WebSocket --------------------------------- */
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  let pathname = '';
  let token = null;
  try {
    const u = new URL(req.url, 'http://localhost');
    pathname = u.pathname;
    token = u.searchParams.get('token');
  } catch { /* fall through to destroy */ }
  if (pathname !== '/ws') { socket.destroy(); return; }
  const user = token ? tokens.get(token) : null;
  if (!user) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.user = user;
    ws.subs = []; // [{channel:'kds', station}, {channel:'checks'}]
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'connected', user: { name: ws.user.name, role: ws.user.role } }));
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg && msg.action === 'subscribe' && typeof msg.channel === 'string') {
      if (msg.channel === 'kds') {
        if (!['bar', 'expediter', 'garde_manger', 'dessert'].includes(msg.station)) {
          ws.send(JSON.stringify({ type: 'error', error: 'Unknown KDS station' }));
          return;
        }
        ws.subs.push({ channel: 'kds', station: msg.station });
        ws.send(JSON.stringify({ type: 'subscribed', channel: 'kds', station: msg.station }));
      } else if (msg.channel === 'checks') {
        ws.subs.push({ channel: 'checks' });
        ws.send(JSON.stringify({ type: 'subscribed', channel: 'checks' }));
      } else {
        ws.send(JSON.stringify({ type: 'error', error: 'Unknown channel' }));
      }
    } else if (msg && msg.action === 'unsubscribe') {
      ws.subs = (ws.subs || []).filter((s) =>
        !(s.channel === msg.channel && (msg.channel !== 'kds' || s.station === msg.station)));
      ws.send(JSON.stringify({ type: 'unsubscribed', channel: msg.channel }));
    }
  });
});

// Keep-alive: drop dead sockets.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);
heartbeat.unref();

function wsSend(ws, obj) {
  if (ws.readyState === 1) {
    try { ws.send(JSON.stringify(obj)); } catch { /* ignore */ }
  }
}

/** Push {type:'ticket', ticket} to subscribers of that KDS station. */
function broadcastTicket(ticket) {
  for (const ws of wss.clients) {
    if ((ws.subs || []).some((s) => s.channel === 'kds' && s.station === ticket.station)) {
      wsSend(ws, { type: 'ticket', ticket });
    }
  }
}

/** Push {type:'ticket_updated', ticket} to subscribers of that KDS station. */
function broadcastTicketUpdated(ticket) {
  for (const ws of wss.clients) {
    if ((ws.subs || []).some((s) => s.channel === 'kds' && s.station === ticket.station)) {
      wsSend(ws, { type: 'ticket_updated', ticket });
    }
  }
}

/** Push {type:'check_updated', check_id} to 'checks' channel subscribers. */
function broadcastCheckUpdated(checkId) {
  for (const ws of wss.clients) {
    if ((ws.subs || []).some((s) => s.channel === 'checks')) {
      wsSend(ws, { type: 'check_updated', check_id: checkId });
    }
  }
}

/* ------------------------------- graceful stop ------------------------------ */
function shutdown(signal) {
  console.log(`[expoline] received ${signal} — shutting down…`);
  clearInterval(heartbeat);
  server.close(() => {
    wss.close(() => {
      try { db.close(); } catch { /* ignore */ }
      console.log('[expoline] stopped.');
      process.exit(0);
    });
  });
  setTimeout(() => { console.error('[expoline] forced exit'); process.exit(1); }, 8000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

/* ---------------------------------- listen ---------------------------------- */
server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`[expoline] FATAL: port ${PORT} is already in use. Is another copy running?`);
  } else {
    console.error('[expoline] server error:', err);
  }
  process.exit(1);
});
server.listen(PORT, () => {
  console.log(`[expoline] listening on http://localhost:${PORT} (site: bali-hai, mode: demo)`);
});
