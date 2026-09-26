'use strict';
/* ============================================================================
 * Expoline MVP v0.1 — backend
 * Node.js 24 + Express + node:sqlite (built into Node, no native npm deps) + ws
 * Port 4317. `npm install && npm start` runs everything.
 *
 * MONEY MATH (server-side single source of truth, ALL integer cents,
 * recomputed + persisted on every mutation via persistTotals()):
 *   billable items : state IN ('held','sent','fulfilled')  (void/cancelled excluded)
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
 *   Idempotency (Phase 1B): payment / refund / gift-card issue+reload+redeem /
 *     loyalty-redeem mutations accept an Idempotency-Key (request header or
 *     `idempotency_key` body field) — a retried double-tap/double-POST with
 *     the same key replays the stored response instead of double-applying.
 *   Discounts (manager comp + loyalty redeem) can never exceed the check
 *     subtotal; totals can never go negative. Payments can never exceed the
 *     remaining balance. Modifiers must exist on the menu item and are
 *     always re-priced server-side from menu_modifiers (client prices ignored).
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
const SITES_DIR = path.join(DB_DIR, 'sites');
// Multi-site isolation: each restaurant gets its own DB file so one site's
// corruption/config/network failure cannot affect another.
// EXPOLINE_SITE selects the site slug (default 'bali-hai').
// EXPOLINE_DB overrides the path entirely (used by QA).
const SITE_SLUG = process.env.EXPOLINE_SITE || 'bali-hai';
const DB_PATH = process.env.EXPOLINE_DB
  || path.join(SITES_DIR, `${SITE_SLUG}.db`);
const PUBLIC_DIR = path.join(ROOT, 'public');

fs.mkdirSync(DB_DIR, { recursive: true });
fs.mkdirSync(SITES_DIR, { recursive: true });
fs.mkdirSync(PUBLIC_DIR, { recursive: true });

if (!fs.existsSync(DB_PATH)) {
  const seedJs = path.join(DB_DIR, 'seed.js');
  if (!fs.existsSync(seedJs)) {
    console.error(`FATAL: ${DB_PATH} is missing and db/seed.js was not found. Cannot boot.`);
    process.exit(1);
  }
  console.log(`[expoline] ${DB_PATH} not found — running db/seed.js …`);
  execFileSync(process.execPath, [seedJs], { stdio: 'inherit', cwd: ROOT });
  if (!fs.existsSync(DB_PATH)) {
    console.error(`FATAL: db/seed.js ran but ${DB_PATH} still missing. Cannot boot.`);
    process.exit(1);
  }
}

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode=WAL;');
db.exec('PRAGMA foreign_keys=ON;');
// Phase 1B money audit: wait (rather than fail fast with SQLITE_BUSY) when a
// second process holds the write lock — concurrent POS terminals / kiosk /
// online ordering must serialize instead of erroring on money writes.
db.exec('PRAGMA busy_timeout=5000;');

/* Floor-plan editor migration (phase 2): position + shape columns on tables.
   Runs on every boot; ALTER TABLE is a no-op-safe guard via PRAGMA table_info. */
(() => {
  const cols = new Set(db.prepare('PRAGMA table_info(tables)').all().map((c) => c.name));
  if (!cols.has('x')) db.exec('ALTER TABLE tables ADD COLUMN x REAL');
  if (!cols.has('y')) db.exec('ALTER TABLE tables ADD COLUMN y REAL');
  if (!cols.has('shape')) db.exec("ALTER TABLE tables ADD COLUMN shape TEXT DEFAULT 'square'");
  db.exec("UPDATE tables SET shape = 'square' WHERE shape IS NULL OR shape NOT IN ('square','round')");
})();

/* Menu editor migration (phase 2): image + daypart columns on menu_items,
   plus the menu_audit log table. Runs on every boot; guards via PRAGMA. */
(() => {
  const cols = new Set(db.prepare('PRAGMA table_info(menu_items)').all().map((c) => c.name));
  if (!cols.has('image_url')) db.exec('ALTER TABLE menu_items ADD COLUMN image_url TEXT');
  if (!cols.has('daypart')) db.exec('ALTER TABLE menu_items ADD COLUMN daypart TEXT');
  db.exec(`CREATE TABLE IF NOT EXISTS menu_audit (
    id INTEGER PRIMARY KEY,
    site_id TEXT,
    actor TEXT,
    action TEXT,
    item_id INTEGER,
    category_id INTEGER,
    details TEXT,
    created_at TEXT
  )`);
})();

/* Time clock + CA break-compliance migration (phase 2). Runs on every boot;
   guards via PRAGMA / CREATE TABLE IF NOT EXISTS. Demo wage defaults are
   applied once (only where no rate is set); the manager sets real rates in
   the Time clock view. */
(() => {
  const ucols = new Set(db.prepare('PRAGMA table_info(users)').all().map((c) => c.name));
  if (!ucols.has('hourly_rate_cents')) db.exec('ALTER TABLE users ADD COLUMN hourly_rate_cents INTEGER DEFAULT 0');
  db.exec(`CREATE TABLE IF NOT EXISTS clock_shifts (
    id INTEGER PRIMARY KEY,
    site_id TEXT,
    user_id INTEGER,
    employee_name TEXT,
    role TEXT,
    regular_rate_cents INTEGER DEFAULT 0,
    clock_in TEXT,
    clock_out TEXT,
    created_at TEXT
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS clock_breaks (
    id INTEGER PRIMARY KEY,
    shift_id INTEGER,
    type TEXT CHECK(type IN ('meal','rest')),
    meal_seq INTEGER,
    start_at TEXT,
    end_at TEXT,
    waived INTEGER DEFAULT 0,
    duty_free INTEGER DEFAULT 0,
    created_at TEXT
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS clock_audit (
    id INTEGER PRIMARY KEY,
    site_id TEXT,
    actor TEXT,
    action TEXT,
    shift_id INTEGER,
    details TEXT,
    created_at TEXT
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_clock_shifts_user ON clock_shifts(site_id, user_id, clock_out)`);
})();

/* Employee records + manager approvals (phase 2). Runs on every boot.
   employees is the canonical staff record; a users row is kept in sync so
   PIN login keeps working. Demo PINs 1111/2222/2580 are seeded as
   employees 101/102/100 on first boot. */
(() => {
  db.exec(`CREATE TABLE IF NOT EXISTS employees (
    id INTEGER PRIMARY KEY,
    site_id TEXT,
    employee_number INTEGER UNIQUE,
    user_id INTEGER UNIQUE,
    name TEXT,
    role TEXT CHECK(role IN ('server','kitchen','manager')),
    pin TEXT UNIQUE,
    wage_rate_cents INTEGER DEFAULT 0,
    active INTEGER DEFAULT 1,
    created_at TEXT
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS approval_audit (
    id INTEGER PRIMARY KEY,
    site_id TEXT,
    actor TEXT,
    approver TEXT,
    action TEXT,
    check_id INTEGER,
    item_id INTEGER,
    shift_id INTEGER,
    before_json TEXT,
    after_json TEXT,
    details TEXT,
    created_at TEXT
  )`);
  /* One-time offline manager approvals. When a void is queued offline, the
     client stores sha256(manager PIN) + a random nonce — NEVER the raw PIN.
     The nonce is bound to (check, item) on first use; replays and retargets
     are rejected. */
  db.exec(`CREATE TABLE IF NOT EXISTS offline_approvals (
    id INTEGER PRIMARY KEY,
    site_id TEXT,
    nonce TEXT,
    check_id INTEGER,
    item_id INTEGER,
    manager_id INTEGER,
    manager_name TEXT,
    used INTEGER DEFAULT 0,
    created_at TEXT,
    UNIQUE(site_id, nonce)
  )`);
  const ccols = new Set(db.prepare('PRAGMA table_info(checks)').all().map((c) => c.name));
  if (!ccols.has('comp_cents')) db.exec('ALTER TABLE checks ADD COLUMN comp_cents INTEGER DEFAULT 0');
  const scols = new Set(db.prepare('PRAGMA table_info(clock_shifts)').all().map((c) => c.name));
  if (!scols.has('employee_id')) db.exec('ALTER TABLE clock_shifts ADD COLUMN employee_id INTEGER');
  const ucols = new Set(db.prepare('PRAGMA table_info(users)').all().map((c) => c.name));
  if (!ucols.has('active')) db.exec('ALTER TABLE users ADD COLUMN active INTEGER DEFAULT 1');
})();

/* Sync-identity migration (offline ladder). The offline-ladder prototype proved
   integer PKs break the moment a second engine (LAN brain, cloud mirror,
   Bluetooth proxy) applies ops — autoincrement ids diverge across engines.
   uuid is the cross-engine sync identity; integer PKs stay for local speed.
   Ops reference uuids; each engine resolves uuid → local id at apply time.
   Runs on every boot; guarded via PRAGMA + IF NOT EXISTS. */
(() => {
  const SYNC_TABLES = ['checks', 'check_items', 'payments', 'kds_tickets', 'clock_shifts', 'clock_breaks'];
  for (const t of SYNC_TABLES) {
    const cols = new Set(db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name));
    if (!cols.has('uuid')) db.exec(`ALTER TABLE ${t} ADD COLUMN uuid TEXT`);
    const missing = db.prepare(`SELECT id FROM ${t} WHERE uuid IS NULL`).all();
    if (missing.length) {
      const upd = db.prepare(`UPDATE ${t} SET uuid = ? WHERE id = ?`);
      for (const r of missing) upd.run(crypto.randomUUID(), r.id);
    }
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_${t}_uuid ON ${t}(uuid)`);
  }
})();

/* Feature modules (gift cards, loyalty, kiosk, online ordering). Each module
   owns its tables via migrate(db); guarded and idempotent on every boot. */
require('./routes/giftcards').migrate(db);
require('./routes/loyalty').migrate(db);
require('./routes/kiosk').migrate(db);
require('./routes/online').migrate(db);

/* Seed employees from existing users once SITE_ID is known (see below,
   after the config section — migrations above run before SITE_ID exists). */

/* Reservations + waitlist (phase 2). Runs on every boot; guarded via
   CREATE TABLE IF NOT EXISTS + IF NOT EXISTS indexes. uuid columns follow
   the sync-identity pattern (crypto.randomUUID() at insert) so a future
   LAN site brain can reference these rows across engines. */
(() => {
  db.exec(`CREATE TABLE IF NOT EXISTS reservations (
    id INTEGER PRIMARY KEY,
    uuid TEXT UNIQUE,
    site_id TEXT,
    customer_name TEXT,
    phone TEXT,
    party_size INTEGER,
    reserved_at TEXT,
    duration_min INTEGER DEFAULT 90,
    table_id INTEGER,
    status TEXT CHECK(status IN ('booked','seated','cancelled','no_show','completed')),
    notes TEXT,
    created_by TEXT,
    created_at TEXT
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS waitlist (
    id INTEGER PRIMARY KEY,
    uuid TEXT UNIQUE,
    site_id TEXT,
    customer_name TEXT,
    phone TEXT,
    party_size INTEGER,
    quoted_wait_min INTEGER,
    status TEXT CHECK(status IN ('waiting','notified','seated','left','cancelled')),
    notified_at TEXT,
    created_at TEXT
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_reservations_site_time ON reservations(site_id, reserved_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_reservations_table_time ON reservations(site_id, table_id, reserved_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_reservations_phone ON reservations(site_id, phone)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_waitlist_site_status ON waitlist(site_id, status, created_at)`);
})();

/* Idempotency keys (Phase 1B money audit). Guards payment / refund /
   gift-card / loyalty-redeem endpoints against double-tap and double-POST:
   a retried request carrying the same Idempotency-Key (header or
   `idempotency_key` body field) replays the stored response instead of
   executing the money mutation a second time. */
(() => {
  db.exec(`CREATE TABLE IF NOT EXISTS idempotency_keys (
    site_id TEXT NOT NULL,
    scope TEXT NOT NULL,
    key TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'processing' CHECK(status IN ('processing','completed')),
    response_status INTEGER,
    response_json TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (site_id, scope, key)
  )`);
})();

/* --------------------------------- config --------------------------------- */
const PORT = parseInt(process.env.EXPOLINE_PORT || process.env.PORT || '4317', 10);
const SITE_TZ = 'America/Los_Angeles'; // Bali Hai pilot site timezone for date bucketing
const SITE_ID = (() => {
  const r = db.prepare('SELECT id FROM sites WHERE slug = ?').get(SITE_SLUG)
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
    site_tz: SITE_TZ,
    site_date: todaySite(),
  };
}

/* Demo wage defaults for the time clock (phase 2): applied once, only where
   no rate is set. The manager sets real rates in the Time clock view. */
(() => {
  const rateByRole = { server: 1800, kitchen: 2000, manager: 3000 };
  const upd = db.prepare('UPDATE users SET hourly_rate_cents = ? WHERE site_id = ? AND role = ? AND (hourly_rate_cents IS NULL OR hourly_rate_cents = 0)');
  for (const [role, rate] of Object.entries(rateByRole)) upd.run(rate, SITE_ID, role);
})();

/* Seed employee records from existing users (phase 2). Idempotent: runs only
   when no employees exist yet for this site. Demo PINs 1111/2222/2580 become
   employees 101/102/100. */
(() => {
  const n = db.prepare('SELECT COUNT(*) AS n FROM employees WHERE site_id = ?').get(SITE_ID).n;
  if (n !== 0) return;
  const users = db.prepare('SELECT id, name, role, pin, COALESCE(hourly_rate_cents,0) AS w FROM users WHERE site_id = ?').all(SITE_ID);
  const numFor = { manager: 100, server: 101, kitchen: 102 };
  const ins = db.prepare('INSERT INTO employees (site_id, employee_number, user_id, name, role, pin, wage_rate_cents, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)');
  const now = new Date().toISOString();
  users.forEach((u, i) => {
    try { ins.run(SITE_ID, numFor[u.role] != null ? numFor[u.role] : 200 + i, u.id, u.name, u.role, u.pin, u.w, now); }
    catch (e) { /* duplicate pin/number — leave existing row */ }
  });
  db.exec('UPDATE clock_shifts SET employee_id = (SELECT id FROM employees WHERE employees.user_id = clock_shifts.user_id) WHERE employee_id IS NULL');
})();

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

/* ------------------------- idempotency-key helpers -------------------------
 * Phase 1B money audit. Two-step usage inside a money-mutating handler:
 *   const ikey = idemKeyFrom(req);
 *   // 1) replay FIRST, before any state-dependent validation:
 *   if (ikey) { const rp = idemReplay('payments', ikey);
 *     if (rp) return res.status(rp.status).json(rp.body); }
 *   ... validate ...
 *   // 2) reserve AFTER validation passes, before the mutation:
 *   let idem = null;
 *   if (ikey) {
 *     const rsv = idemReserve('payments', ikey);
 *     if (rsv.state === 'replay') return res.status(rsv.status).json(rsv.body);
 *     if (rsv.state === 'processing') return res.status(409).json({ error: 'Duplicate request in progress — retry shortly' });
 *     idem = ikey;
 *   }
 *   try {
 *     ... mutate ...
 *     const out = { ... }; const status = 201;
 *     if (idem) idemStore('payments', idem, status, out);
 *     return res.status(status).json(out);
 *   } catch (e) { if (idem) idemClear('payments', idem); throw e; }
 * A 'processing' row older than IDEM_STALE_MS is treated as orphaned (the
 * first attempt crashed before storing) and reclaimed, so a retry can
 * proceed instead of 409-ing forever. All DB calls here are synchronous,
 * so reserve/store cannot interleave with another request mid-handler. */
const IDEM_STALE_MS = 120_000;

function idemKeyFrom(req) {
  const h = req.get('Idempotency-Key') || req.get('idempotency-key');
  const b = (req.body || {}).idempotency_key;
  const k = (h != null ? String(h) : b != null ? String(b) : '').trim().slice(0, 128);
  return k || null;
}

/* Completed-key lookup. Call FIRST in the handler (before any
 * state-dependent validation): a retry must replay the stored response even
 * when the world has moved on (e.g. the balance is now lower). */
function idemReplay(scope, key) {
  const row = db.prepare(
    'SELECT status, response_status, response_json FROM idempotency_keys WHERE site_id = ? AND scope = ? AND key = ?'
  ).get(SITE_ID, scope, key);
  if (row && row.status === 'completed') {
    let body = {};
    try { body = JSON.parse(row.response_json || '{}'); } catch { body = {}; }
    return { status: row.response_status || 200, body };
  }
  return null;
}

function idemReserve(scope, key) {
  // returns {state:'new'} | {state:'replay',...} | {state:'processing'}
  // Claim is atomic across processes: exactly one contender wins the
  // INSERT OR IGNORE; losers read the winner's row and replay or back off.
  const rp = idemReplay(scope, key);
  if (rp) return { state: 'replay', status: rp.status, body: rp.body };
  const ins = db.prepare(
    "INSERT OR IGNORE INTO idempotency_keys (site_id, scope, key, status, created_at) VALUES (?, ?, ?, 'processing', ?)"
  ).run(SITE_ID, scope, key, nowIso());
  if (ins.changes === 1) return { state: 'new' };
  const row = db.prepare(
    'SELECT status, response_status, response_json, created_at FROM idempotency_keys WHERE site_id = ? AND scope = ? AND key = ?'
  ).get(SITE_ID, scope, key);
  if (!row) return { state: 'new' }; // lost a race with a delete; next call re-claims
  if (row.status === 'completed') {
    let body = null;
    try { body = JSON.parse(row.response_json); } catch { /* keep null */ }
    return { state: 'replay', status: row.response_status || 200, body };
  }
  const age = Date.now() - new Date(row.created_at).getTime();
  if (Number.isFinite(age) && age >= IDEM_STALE_MS) {
    // Orphaned 'processing' row (first attempt crashed before storing).
    // Reclaim is conditional so only one contender wins it.
    const upd = db.prepare(
      "UPDATE idempotency_keys SET created_at = ? WHERE site_id = ? AND scope = ? AND key = ? AND status = 'processing'"
    ).run(nowIso(), SITE_ID, scope, key);
    if (upd.changes === 1) return { state: 'new' };
  }
  return { state: 'processing' };
}

function idemStore(scope, key, status, body) {
  db.prepare(
    "UPDATE idempotency_keys SET status = 'completed', response_status = ?, response_json = ?, created_at = ? WHERE site_id = ? AND scope = ? AND key = ?"
  ).run(status, JSON.stringify(body), nowIso(), SITE_ID, scope, key);
}

function idemClear(scope, key) {
  db.prepare('DELETE FROM idempotency_keys WHERE site_id = ? AND scope = ? AND key = ?')
    .run(SITE_ID, scope, key);
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
// Billable = every non-void line. Held + sent + fulfilled are all owed;
// only 'void'/'cancelled' are excluded. (KDS send uses state='held' only.)
const BILLABLE_STATES = "('held','sent','fulfilled')";

function calcTotals(checkId) {
  const cfg = getConfig();
  // Billable = every non-void line: held, sent, AND fulfilled (served food is still owed).
  const items = db.prepare(
    `SELECT * FROM check_items WHERE check_id = ? AND state IN ${BILLABLE_STATES}`
  ).all(checkId);
  const subtotal = items.reduce((s, it) => s + lineTotal(it), 0);
  const surcharge = Math.round(subtotal * cfg.surcharge_pct);
  const check = db.prepare('SELECT guest_count, COALESCE(comp_cents, 0) AS comp_cents FROM checks WHERE id = ?').get(checkId);
  const guests = check ? (check.guest_count || 0) : 0;
  const comp = check ? (check.comp_cents || 0) : 0;
  const serviceCharge = guests >= cfg.service_charge_min_guests
    ? Math.round(subtotal * cfg.service_charge_pct) : 0;
  // Taxable base: subtotal + surcharge. Tips NEVER taxed; service charge not taxed (demo).
  // Manager-approved comps reduce the amount owed (never below zero).
  const taxable = subtotal + surcharge;
  const tax = Math.round(taxable * cfg.tax_rate);
  const total = Math.max(0, subtotal + surcharge + serviceCharge + tax - comp);
  const pay = db.prepare(
    'SELECT COALESCE(SUM(amount_cents),0) AS amt, COALESCE(SUM(refunded_cents),0) AS ref FROM payments WHERE check_id = ?'
  ).get(checkId);
  const paid = (pay.amt || 0) - (pay.ref || 0);
  const balance = total - paid;
  return { subtotal, surcharge, service_charge: serviceCharge, tax, total, paid, balance, comp };
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
    "SELECT ci.*, mi.name, mi.station AS menu_station FROM check_items ci LEFT JOIN menu_items mi ON mi.id = ci.menu_item_id WHERE ci.check_id = ? AND ci.state IN " + BILLABLE_STATES + " ORDER BY ci.added_at, ci.id"
  ).all(checkId);
}

function itemView(it) {
  return {
    id: it.id,
    uuid: it.uuid,
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
    uuid: c.uuid,
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
    comp_cents: t.comp,
    total_cents: t.total,
    opened_at: c.opened_at,
    closed_at: c.closed_at,
    items: items.map(itemView),
    totals: {
      subtotal: t.subtotal,
      surcharge: t.surcharge,
      service_charge: t.service_charge,
      tax: t.tax,
      comp: t.comp,
      total: t.total,
      paid: t.paid,
      balance: t.balance,
    },
  };
}

// Canonical KDS station slugs; accepts display names too ("Expediter", "Garde Manger", ...)
const KDS_STATION_SLUGS = ['bar', 'expediter', 'garde_manger', 'dessert'];
function canonStation(s) {
  if (typeof s !== 'string') return null;
  const slug = s.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return KDS_STATION_SLUGS.includes(slug) ? slug : null;
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
    uuid: p.uuid,
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
/**
 * In-memory token map: token (32 hex chars) -> {id, name, role, expires_at}.
 * Sessions expire TOKEN_TTL_MS after issue (a long restaurant shift + margin);
 * there is deliberately no "remember me" — a lost/stolen device stops working
 * on its own. POST /api/auth/logout revokes immediately.
 */
const tokens = new Map();
const TOKEN_TTL_MS = 12 * 3600 * 1000;

function issueToken(user) {
  const token = crypto.randomBytes(16).toString('hex');
  tokens.set(token, { id: user.id, name: user.name, role: user.role, expires_at: Date.now() + TOKEN_TTL_MS });
  return token;
}

// Reap expired sessions so the map cannot grow without bound.
setInterval(() => {
  const now = Date.now();
  for (const [t, s] of tokens) {
    if (s.expires_at && s.expires_at <= now) tokens.delete(t);
  }
}, 5 * 60_000).unref();

/* ---- login brute-force protection (4-digit PINs are guessable) ----
   Per-IP: LOGIN_MAX failed attempts inside LOGIN_WINDOW_MS locks the IP out
   of /api/auth/login for LOGIN_LOCK_MS (429). A success resets the counter. */
const LOGIN_MAX = 10;
const LOGIN_WINDOW_MS = 60_000;
const LOGIN_LOCK_MS = 5 * 60_000;
const loginAttempts = new Map(); // ip -> {count, firstAt, lockedUntil}
function loginThrottled(ip) {
  const now = Date.now();
  const e = loginAttempts.get(ip);
  if (!e) return false;
  if (e.lockedUntil > now) return true;
  if (now - e.firstAt > LOGIN_WINDOW_MS) { loginAttempts.delete(ip); return false; }
  return false;
}
function recordLoginAttempt(ip, ok) {
  const now = Date.now();
  if (ok) { loginAttempts.delete(ip); return; }
  let e = loginAttempts.get(ip);
  if (!e || now - e.firstAt > LOGIN_WINDOW_MS) e = { count: 0, firstAt: now, lockedUntil: 0 };
  e.count += 1;
  if (e.count >= LOGIN_MAX) e.lockedUntil = now + LOGIN_LOCK_MS;
  loginAttempts.set(ip, e);
}
// Prevent unbounded growth of the limiter map.
setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of loginAttempts) {
    if (e.lockedUntil <= now && now - e.firstAt > LOGIN_WINDOW_MS) loginAttempts.delete(ip);
  }
}, 5 * 60_000).unref();

/* ---- manager-PIN brute-force protection ----
   Voids, comps, and time-clock adjustments require the manager's 4-digit PIN
   at the point of action. An authenticated insider (any server token) could
   otherwise guess it at full speed. Per (actor, IP): PIN_MAX failed attempts
   inside PIN_WINDOW_MS locks PIN verification for PIN_LOCK_MS (429). */
const PIN_MAX = 8;
const PIN_WINDOW_MS = 5 * 60_000;
const PIN_LOCK_MS = 5 * 60_000;
const pinAttempts = new Map(); // `${ip}|${actorId}` -> {count, firstAt, lockedUntil}
function pinKey(req) {
  const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
  return `${ip}|${req.user ? req.user.id : '?'}`;
}
function managerPinThrottled(req) {
  const now = Date.now();
  const e = pinAttempts.get(pinKey(req));
  if (!e) return false;
  if (e.lockedUntil > now) return true;
  if (now - e.firstAt > PIN_WINDOW_MS) { pinAttempts.delete(pinKey(req)); return false; }
  return false;
}
function recordManagerPinAttempt(req, ok) {
  const key = pinKey(req);
  const now = Date.now();
  if (ok) { pinAttempts.delete(key); return; }
  let e = pinAttempts.get(key);
  if (!e || now - e.firstAt > PIN_WINDOW_MS) e = { count: 0, firstAt: now, lockedUntil: 0 };
  e.count += 1;
  if (e.count >= PIN_MAX) e.lockedUntil = now + PIN_LOCK_MS;
  pinAttempts.set(key, e);
}
setInterval(() => {
  const now = Date.now();
  for (const [k, e] of pinAttempts) {
    if (e.lockedUntil <= now && now - e.firstAt > PIN_WINDOW_MS) pinAttempts.delete(k);
  }
}, 5 * 60_000).unref();

/** 401 unless a valid Bearer token is present. Mounted on /api with public paths. */
function authMiddleware(req, res, next) {
  if (req.path === '/health' || req.path === '/auth/login' || req.path === '/auth/logout') return next();
  // Public online-ordering endpoints (customer's phone — no staff token).
  if (req.path === '/online/menu'
      || (req.path === '/online/orders' && req.method === 'POST')
      || req.path === '/online/last') return next();
  // Public kiosk (customer device) + TV menu boards — no staff token.
  // (The staff-facing kiosk call-flag endpoints are registered after this
  // wall and gated per-route with requireRole.)
  if (req.path === '/kiosk/menu'
      || (req.path === '/kiosk/order' && req.method === 'POST')
      || (req.path === '/kiosk/call-staff' && req.method === 'POST')
      || req.path === '/menuboards') return next();
  // Public LAN brain discovery (devices find the brain before auth).
  if (req.path === '/brain/status') return next();
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  const sess = m ? tokens.get(m[1]) : null;
  if (!sess) return res.status(401).json({ error: 'Unauthorized: valid Bearer token required' });
  if (sess.expires_at && Date.now() > sess.expires_at) {
    tokens.delete(m[1]);
    return res.status(401).json({ error: 'Unauthorized: session expired — please log in again' });
  }
  // A token must not outlive the account behind it. Re-read the live user row
  // on every request: a deactivated staffer's token stops working immediately,
  // and a role change (promote/demote) applies to the live session at once.
  const live = db.prepare('SELECT id, name, role FROM users WHERE id = ? AND COALESCE(active, 1) = 1').get(sess.id);
  if (!live) {
    tokens.delete(m[1]);
    return res.status(401).json({ error: 'Unauthorized: this account is no longer active' });
  }
  req.user = { id: live.id, name: live.name, role: live.role };
  next();
}

/**
 * Role enforcement (server-side). Usage: app.get('/x', requireRole('manager'), handler).
 * - kitchen: blocked from /api/finance/* and /api/menu/admin* (no menu editing
 *   for kitchen or servers — manager only); CAN bump KDS.
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

/**
 * Manager PIN verification for point-of-action approvals (voids, comps,
 * time-clock adjustments). Returns the manager user row or null. A valid
 * login token alone is NOT enough on the floor — the manager physically
 * enters their PIN at the device.
 */
function verifyManagerPin(pin) {
  const p = pin != null ? String(pin).trim() : '';
  if (!/^\d{4}$/.test(p)) return null;
  return db.prepare("SELECT id, name, role, pin FROM users WHERE pin = ? AND site_id = ? AND role = 'manager' AND COALESCE(active, 1) = 1").get(p, SITE_ID) || null;
}

/* Offline-approval verification for queued voids (fix 5). The client stores
   sha256(manager PIN) + a random nonce — never the raw PIN. The server finds
   the active manager whose PIN hashes to the given value, then binds the
   nonce to (check, item) on first use. Replays (nonce already used) and
   retargets (same nonce, different check/item) are rejected. A retry of the
   exact same action after a dropped response is treated as a replay-success
   so the outbox flush stays idempotent. */
function verifyOfflineApproval(nonce, pinHash, checkId, itemId) {
  const n = nonce != null ? String(nonce).trim() : '';
  const h = pinHash != null ? String(pinHash).trim().toLowerCase() : '';
  if (!/^[0-9a-f]{32,}$/.test(n) || !/^[0-9a-f]{64}$/.test(h)) return null;
  const mgrs = db.prepare("SELECT id, name, pin FROM users WHERE site_id = ? AND role = 'manager' AND COALESCE(active, 1) = 1").all(SITE_ID);
  const mgr = mgrs.find((m) => crypto.createHash('sha256').update(String(m.pin)).digest('hex') === h);
  if (!mgr) return null;
  const row = db.prepare('SELECT * FROM offline_approvals WHERE site_id = ? AND nonce = ?').get(SITE_ID, n);
  if (row && row.used) {
    if (row.check_id === checkId && row.item_id === itemId && row.manager_id === mgr.id) return { mgr, replay: true, nonce: n };
    return null; // replay for a different action or a different manager: forged
  }
  return { mgr, replay: false, nonce: n };
}
function consumeOfflineApproval(nonce, checkId, itemId, mgr) {
  db.prepare(`INSERT INTO offline_approvals (site_id, nonce, check_id, item_id, manager_id, manager_name, used, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?)
    ON CONFLICT(site_id, nonce) DO UPDATE SET used = 1, check_id = excluded.check_id, item_id = excluded.item_id,
      manager_id = excluded.manager_id, manager_name = excluded.manager_name`)
    .run(SITE_ID, nonce, checkId, itemId, mgr.id, mgr.name, new Date().toISOString());
}
/* Resolve a void approval from either the online path (raw manager PIN,
   verified live) or the offline path (PIN hash + one-time nonce). Returns
   { mgr, offline, replay, nonce } or sends 403/429 and returns null. */
function resolveVoidApproval(req, b, checkId, itemId, res) {
  if (managerPinThrottled(req)) {
    res.status(429).json({ error: 'Too many failed manager-PIN attempts — please wait a few minutes' });
    return null;
  }
  if (b.approval_nonce !== undefined || b.manager_pin_hash !== undefined) {
    const v = verifyOfflineApproval(b.approval_nonce, b.manager_pin_hash, checkId, itemId);
    if (!v) {
      recordManagerPinAttempt(req, false);
      res.status(403).json({ error: 'Invalid or already-used offline approval — re-void from the check with a manager PIN' });
      return null;
    }
    recordManagerPinAttempt(req, true);
    return { mgr: v.mgr, offline: true, replay: v.replay, nonce: v.nonce };
  }
  const mgr = verifyManagerPin(b.manager_pin);
  if (!mgr) {
    recordManagerPinAttempt(req, false);
    res.status(403).json({ error: 'Manager PIN required to void an item' });
    return null;
  }
  recordManagerPinAttempt(req, true);
  return { mgr, offline: false, replay: false, nonce: null };
}

/** Audit row for manager approvals: who acted, which manager approved, what changed. */
function auditApproval(req, action, ids, details) {
  const d = details || {};
  db.prepare(`INSERT INTO approval_audit (site_id, actor, approver, action, check_id, item_id, shift_id, before_json, after_json, details, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(SITE_ID, req.user ? req.user.name : '?', d.approver || (req.user ? req.user.name : '?'),
      action, ids.check_id ?? null, ids.item_id ?? null, ids.shift_id ?? null,
      JSON.stringify(d.before !== undefined ? d.before : null),
      JSON.stringify(d.after !== undefined ? d.after : null),
      JSON.stringify(d), new Date().toISOString());
}

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

/* Kiosk: registered AFTER the auth wall. The customer flows
   (/kiosk/menu, POST /kiosk/order, POST /kiosk/call-staff, /menuboards) stay
   token-free via the wall's public-path early return; the staff-facing
   call-flag endpoints are gated by ctx.serverPlus (req.user is populated by
   the wall, so role checks work). */
require('./routes/kiosk').register(app, {
  db, SITE_ID, nowIso, crypto, persistTotals, checkResponse, broadcastCheckUpdated,
  // Staff-facing call-flag endpoints are gated server-side; the customer
  // kiosk flows (menu/order/call-staff) stay public by design.
  serverPlus,
});

/* ------------------------------- public routes ----------------------------- */
app.get('/api/health', (req, res) => {
  res.json({ ok: true, mode: 'demo', site: SITE_SLUG });
});

/* ------------------------- LAN site brain discovery -------------------------
 * The site brain is the authoritative node on the restaurant LAN. Devices
 * discover it via mDNS (_expoline._tcp.local) or via this HTTP endpoint when
 * the IP is known (DHCP reservation recommended for the brain terminal).
 * The brain holds the site DB, serves /api/sync to LAN clients, and owns
 * the WAN upload queue. See offline-ladder/DESIGN.md §4 for the full design.
 */
app.get('/api/brain/status', (req, res) => {
  res.json({
    brain: true,
    site_slug: SITE_SLUG,
    site_id: SITE_ID,
    version: '1.0',
    // Heartbeat for election: priority 0 = preferred brain (wall terminal),
    // higher = fallback (handhelds/tablets). See sync-engine/brain.js.
    priority: parseInt(process.env.EXPOLINE_BRAIN_PRIORITY || '0', 10),
    uptime_s: Math.floor(process.uptime()),
    db_path: DB_PATH,
  });
});

app.post('/api/auth/login', (req, res) => {
  const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
  if (loginThrottled(ip)) {
    return res.status(429).json({ error: 'Too many login attempts — please wait a few minutes and try again' });
  }
  const pin = req.body && req.body.pin != null ? String(req.body.pin) : '';
  if (!pin) { recordLoginAttempt(ip, false); return res.status(401).json({ error: 'PIN required' }); }
  // PINs compared as strings. Deactivated staff cannot log in.
  const user = db.prepare('SELECT id, name, role FROM users WHERE pin = ? AND site_id = ? AND COALESCE(active, 1) = 1').get(pin, SITE_ID);
  if (!user) { recordLoginAttempt(ip, false); return res.status(401).json({ error: 'Invalid PIN' }); }
  recordLoginAttempt(ip, true);
  const token = issueToken(user);
  res.json({ token, user: { id: user.id, name: user.name, role: user.role } });
});

/* POST /api/auth/logout — revoke the presented Bearer token immediately.
   Always 200 (logging out of an already-dead session is a no-op); the token
   is deleted when present so a copied token cannot be reused afterwards. */
app.post('/api/auth/logout', (req, res) => {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  if (m) tokens.delete(m[1]);
  res.json({ ok: true });
});

/* --------------------------------- config ---------------------------------- */
app.get('/api/config', (req, res) => {
  res.json(getConfig());
});

/* Merge same-named categories (e.g. LUNCH "Pupus" + DINNER "Pupus") into one
 * tab with the union of items, deduped by name+price. Servers think in
 * categories, not dayparts; the DB keeps daypart parents for reporting. */
function mergeCats(cats) {
  const byName = new Map();
  const merged = [];
  for (const c of cats) {
    if (byName.has(c.name)) {
      const ex = byName.get(c.name);
      const seen = new Set(ex.items.map((i) => i.name + '|' + i.price_cents));
      for (const it of c.items) {
        if (!seen.has(it.name + '|' + it.price_cents)) { seen.add(it.name + '|' + it.price_cents); ex.items.push(it); }
      }
    } else {
      byName.set(c.name, c);
      merged.push(c);
    }
  }
  return merged;
}

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
  res.json(mergeCats(cats.map((c) => ({
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
  }))));
});
// Menu admin lives under /api/admin/menu/* (manager only) — see below.

/* ---------------------------------- zones ---------------------------------- */
app.get('/api/zones', (req, res) => {
  const zones = db.prepare('SELECT id, name FROM zones WHERE site_id = ? ORDER BY sort, id').all(SITE_ID);
  const tblStmt = db.prepare('SELECT id, label, seats, x, y, shape FROM tables WHERE zone_id = ? ORDER BY id');
  const openStmt = db.prepare("SELECT id FROM checks WHERE table_id = ? AND status = 'open' LIMIT 1");
  res.json(zones.map((z) => ({
    id: z.id,
    name: z.name,
    tables: tblStmt.all(z.id).map((t) => {
      const open = openStmt.get(t.id);
      return { id: t.id, label: t.label, seats: t.seats, x: t.x, y: t.y, shape: t.shape || 'square', open_check_id: open ? open.id : null };
    }),
  })));
});

/* ------------------------- floor-plan admin (manager) -------------------------
   Manager portal floor-plan editor: zones and tables CRUD. Read is manager-only
   (keeps x/y/shape together); writes validate labels, seats, shapes, coords. */
const SHAPES = new Set(['square', 'round']);
function zoneById(id) {
  return db.prepare('SELECT id, name FROM zones WHERE id = ? AND site_id = ?').get(id, SITE_ID);
}
function tableById(id) {
  if (id == null) return undefined; // untrusted callers may omit table_id; never let undefined reach sqlite
  return db.prepare('SELECT id, site_id, zone_id, label, seats, x, y, shape FROM tables WHERE id = ? AND site_id = ?').get(id, SITE_ID);
}
function cleanLabel(v) { return typeof v === 'string' ? v.trim() : ''; }
function labelTaken(label, excludeId) {
  return !!db.prepare('SELECT id FROM tables WHERE site_id = ? AND LOWER(label) = LOWER(?) AND id != ?')
    .get(SITE_ID, label, excludeId == null ? -1 : excludeId);
}
function validSeats(v) { return isInt(v) && v >= 1 && v <= 20; }
function validCoord(v) { return v == null || (typeof v === 'number' && Number.isFinite(v)); }

app.get('/api/admin/zones', managerOnly(), (req, res) => {
  const zones = db.prepare('SELECT id, name FROM zones WHERE site_id = ? ORDER BY sort, id').all(SITE_ID);
  const tblStmt = db.prepare('SELECT id, label, seats, x, y, shape FROM tables WHERE zone_id = ? ORDER BY id');
  res.json(zones.map((z) => ({
    id: z.id, name: z.name,
    tables: tblStmt.all(z.id).map((t) => ({ id: t.id, label: t.label, seats: t.seats, x: t.x, y: t.y, shape: t.shape || 'square' })),
  })));
});

app.post('/api/admin/zones', managerOnly(), (req, res) => {
  const name = cleanLabel(req.body && req.body.name);
  if (!name) return res.status(400).json({ error: 'Zone name is required' });
  if (db.prepare('SELECT id FROM zones WHERE site_id = ? AND LOWER(name) = LOWER(?)').get(SITE_ID, name)) {
    return res.status(400).json({ error: 'A zone with that name already exists' });
  }
  const maxSort = db.prepare('SELECT COALESCE(MAX(sort), -1) AS m FROM zones WHERE site_id = ?').get(SITE_ID).m;
  const r = db.prepare('INSERT INTO zones (site_id, name, sort) VALUES (?, ?, ?)').run(SITE_ID, name, maxSort + 1);
  res.status(201).json({ id: r.lastInsertRowid, name, tables: [] });
});

app.put('/api/admin/zones/:id', managerOnly(), (req, res) => {
  const z = zoneById(req.params.id);
  if (!z) return res.status(404).json({ error: 'Zone not found' });
  const name = cleanLabel(req.body && req.body.name);
  if (!name) return res.status(400).json({ error: 'Zone name is required' });
  if (db.prepare('SELECT id FROM zones WHERE site_id = ? AND LOWER(name) = LOWER(?) AND id != ?').get(SITE_ID, name, z.id)) {
    return res.status(400).json({ error: 'A zone with that name already exists' });
  }
  db.prepare('UPDATE zones SET name = ? WHERE id = ?').run(name, z.id);
  res.json({ id: z.id, name });
});

app.delete('/api/admin/zones/:id', managerOnly(), (req, res) => {
  const z = zoneById(req.params.id);
  if (!z) return res.status(404).json({ error: 'Zone not found' });
  const n = db.prepare('SELECT COUNT(*) AS n FROM tables WHERE zone_id = ?').get(z.id).n;
  if (n > 0) return res.status(400).json({ error: `Zone has ${n} table${n === 1 ? '' : 's'} — move or delete them first` });
  db.prepare('DELETE FROM zones WHERE id = ?').run(z.id);
  res.json({ deleted: z.id });
});

app.post('/api/admin/tables', managerOnly(), (req, res) => {
  const b = req.body || {};
  const z = zoneById(b.zone_id);
  if (!z) return res.status(400).json({ error: 'Valid zone_id is required' });
  const label = cleanLabel(b.label);
  if (!label) return res.status(400).json({ error: 'Table label is required' });
  if (labelTaken(label)) return res.status(400).json({ error: `Table "${label}" already exists` });
  if (!validSeats(b.seats)) return res.status(400).json({ error: 'Seats must be a whole number from 1 to 20' });
  if (!validCoord(b.x) || !validCoord(b.y)) return res.status(400).json({ error: 'x and y must be numbers' });
  if (b.shape != null && !SHAPES.has(b.shape)) return res.status(400).json({ error: 'shape must be "square" or "round"' });
  const r = db.prepare('INSERT INTO tables (site_id, zone_id, label, seats, x, y, shape) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(SITE_ID, z.id, label, b.seats, b.x ?? null, b.y ?? null, b.shape || 'square');
  res.status(201).json({ id: r.lastInsertRowid, zone_id: z.id, label, seats: b.seats, x: b.x ?? null, y: b.y ?? null, shape: b.shape || 'square' });
});

app.put('/api/admin/tables/:id', managerOnly(), (req, res) => {
  const t = tableById(req.params.id);
  if (!t) return res.status(404).json({ error: 'Table not found' });
  const b = req.body || {};
  const label = b.label === undefined ? t.label : cleanLabel(b.label);
  if (!label) return res.status(400).json({ error: 'Table label is required' });
  if (labelTaken(label, t.id)) return res.status(400).json({ error: `Table "${label}" already exists` });
  const seats = b.seats === undefined ? t.seats : b.seats;
  if (!validSeats(seats)) return res.status(400).json({ error: 'Seats must be a whole number from 1 to 20' });
  const zoneId = b.zone_id === undefined ? t.zone_id : b.zone_id;
  if (!zoneById(zoneId)) return res.status(400).json({ error: 'Valid zone_id is required' });
  const x = b.x === undefined ? t.x : b.x;
  const y = b.y === undefined ? t.y : b.y;
  if (!validCoord(x) || !validCoord(y)) return res.status(400).json({ error: 'x and y must be numbers' });
  const shape = b.shape === undefined ? (t.shape || 'square') : b.shape;
  if (!SHAPES.has(shape)) return res.status(400).json({ error: 'shape must be "square" or "round"' });
  db.prepare('UPDATE tables SET label = ?, seats = ?, zone_id = ?, x = ?, y = ?, shape = ? WHERE id = ?')
    .run(label, seats, zoneId, x, y, shape, t.id);
  res.json({ id: t.id, zone_id: zoneId, label, seats, x, y, shape });
});

app.delete('/api/admin/tables/:id', managerOnly(), (req, res) => {
  const t = tableById(req.params.id);
  if (!t) return res.status(404).json({ error: 'Table not found' });
  const open = db.prepare("SELECT id FROM checks WHERE table_id = ? AND status = 'open' LIMIT 1").get(t.id);
  if (open) return res.status(400).json({ error: 'Table has an open check — close it first' });
  db.prepare('DELETE FROM tables WHERE id = ?').run(t.id);
  res.json({ deleted: t.id });
});

/* ------------------------------- menu admin -------------------------------- */
/* Manager-only menu editor (phase 2). Every mutation writes a menu_audit row
   and broadcasts {type:'menu_updated'} so every connected device refreshes
   its menu instantly (including the one-tap 86 toggle). */

const COURSES = new Set(['drink', 'appetizer', 'entree', 'dessert']);
const ITEM_TYPES = new Set(['drink', 'food', 'dessert']);

function menuCategoryById(id) {
  return db.prepare('SELECT id, name, parent, sort FROM menu_categories WHERE id = ? AND site_id = ?').get(id, SITE_ID);
}
function menuItemById(id) {
  return db.prepare('SELECT id, site_id, category_id, name, description, price_cents, item_type, station, course, active, price_note, image_url, daypart FROM menu_items WHERE id = ? AND site_id = ?').get(id, SITE_ID);
}
function auditMenu(req, action, ids, details) {
  db.prepare('INSERT INTO menu_audit (site_id, actor, action, item_id, category_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(SITE_ID, req.user ? req.user.name : '?', action, ids.item_id ?? null, ids.category_id ?? null, JSON.stringify(details || {}), nowIso());
}
function validPriceCents(v) { return isInt(v) && v >= 0; }
function cleanOpt(v) { const s = cleanLabel(v); return s ? s : null; }
function validCourse(v) { return typeof v === 'string' && COURSES.has(v.trim().toLowerCase()); }
function validItemType(v) { return typeof v === 'string' && ITEM_TYPES.has(v.trim().toLowerCase()); }
function validateModifiers(mods) {
  if (mods === undefined) return null;
  if (!Array.isArray(mods)) return 'modifiers must be an array';
  for (const m of mods) {
    if (!m || typeof m !== 'object' || !cleanLabel(m.name)) return 'each modifier needs a name';
    if (!validPriceCents(m.price_delta_cents)) return 'modifier price must be a whole number of cents ≥ 0';
  }
  return null;
}
function saveModifiers(itemId, mods) {
  db.prepare('DELETE FROM menu_modifiers WHERE item_id = ?').run(itemId);
  const ins = db.prepare('INSERT INTO menu_modifiers (item_id, name, price_delta_cents) VALUES (?, ?, ?)');
  for (const m of mods) ins.run(itemId, cleanLabel(m.name), m.price_delta_cents);
}
function itemAdminView(it) {
  const mods = db.prepare('SELECT id, name, price_delta_cents FROM menu_modifiers WHERE item_id = ? ORDER BY id').all(it.id);
  return {
    id: it.id, category_id: it.category_id, name: it.name, description: it.description,
    price_cents: it.price_cents, item_type: it.item_type, station: it.station, course: it.course,
    active: it.active, price_note: it.price_note, image_url: it.image_url, daypart: it.daypart,
    modifiers: mods,
  };
}

/* Full menu for the editor — includes 86'd (inactive) items the public
   /api/menu deliberately hides. */
app.get('/api/admin/menu', managerOnly(), (req, res) => {
  const cats = db.prepare('SELECT id, name, parent, sort FROM menu_categories WHERE site_id = ? ORDER BY sort, id').all(SITE_ID);
  const itemStmt = db.prepare('SELECT id, site_id, category_id, name, description, price_cents, item_type, station, course, active, price_note, image_url, daypart FROM menu_items WHERE category_id = ? ORDER BY id');
  res.json(cats.map((c) => ({
    id: c.id, name: c.name, parent: c.parent, sort: c.sort,
    items: itemStmt.all(c.id).map(itemAdminView),
  })));
});

app.post('/api/admin/menu/categories', managerOnly(), (req, res) => {
  const b = req.body || {};
  const name = cleanLabel(b.name);
  if (!name) return res.status(400).json({ error: 'Category name is required' });
  if (db.prepare('SELECT id FROM menu_categories WHERE site_id = ? AND LOWER(name) = LOWER(?)').get(SITE_ID, name)) {
    return res.status(400).json({ error: 'A category with that name already exists' });
  }
  const parent = cleanOpt(b.parent) || 'ALL DAY';
  const maxSort = db.prepare('SELECT COALESCE(MAX(sort), 0) AS m FROM menu_categories WHERE site_id = ?').get(SITE_ID).m;
  const sort = b.sort === undefined ? maxSort + 10 : b.sort;
  if (!isInt(sort)) return res.status(400).json({ error: 'sort must be a whole number' });
  const r = db.prepare('INSERT INTO menu_categories (site_id, name, parent, sort) VALUES (?, ?, ?, ?)').run(SITE_ID, name, parent, sort);
  auditMenu(req, 'category.create', { category_id: r.lastInsertRowid }, { name, parent, sort });
  broadcastMenuUpdated();
  res.status(201).json({ id: r.lastInsertRowid, name, parent, sort, items: [] });
});

app.put('/api/admin/menu/categories/:id', managerOnly(), (req, res) => {
  const c = menuCategoryById(req.params.id);
  if (!c) return res.status(404).json({ error: 'Category not found' });
  const b = req.body || {};
  const name = b.name === undefined ? c.name : cleanLabel(b.name);
  if (!name) return res.status(400).json({ error: 'Category name is required' });
  if (db.prepare('SELECT id FROM menu_categories WHERE site_id = ? AND LOWER(name) = LOWER(?) AND id != ?').get(SITE_ID, name, c.id)) {
    return res.status(400).json({ error: 'A category with that name already exists' });
  }
  const parent = b.parent === undefined ? c.parent : (cleanOpt(b.parent) || 'ALL DAY');
  const sort = b.sort === undefined ? c.sort : b.sort;
  if (!isInt(sort)) return res.status(400).json({ error: 'sort must be a whole number' });
  db.prepare('UPDATE menu_categories SET name = ?, parent = ?, sort = ? WHERE id = ?').run(name, parent, sort, c.id);
  auditMenu(req, 'category.update', { category_id: c.id }, { name, parent, sort });
  broadcastMenuUpdated();
  res.json({ id: c.id, name, parent, sort });
});

app.delete('/api/admin/menu/categories/:id', managerOnly(), (req, res) => {
  const c = menuCategoryById(req.params.id);
  if (!c) return res.status(404).json({ error: 'Category not found' });
  const n = db.prepare('SELECT COUNT(*) AS n FROM menu_items WHERE category_id = ?').get(c.id).n;
  if (n > 0) return res.status(400).json({ error: `Category has ${n} item${n === 1 ? '' : 's'} — move or delete them first` });
  db.prepare('DELETE FROM menu_categories WHERE id = ?').run(c.id);
  auditMenu(req, 'category.delete', { category_id: c.id }, { name: c.name });
  broadcastMenuUpdated();
  res.json({ deleted: c.id });
});

app.post('/api/admin/menu/items', managerOnly(), (req, res) => {
  const b = req.body || {};
  const cat = menuCategoryById(b.category_id);
  if (!cat) return res.status(400).json({ error: 'Valid category_id is required' });
  const name = cleanLabel(b.name);
  if (!name) return res.status(400).json({ error: 'Item name is required' });
  if (!validPriceCents(b.price_cents)) return res.status(400).json({ error: 'price_cents must be a whole number of cents ≥ 0' });
  const station = canonStation(b.station);
  if (!station) return res.status(400).json({ error: 'station must be one of: bar, expediter, garde_manger, dessert' });
  if (!validCourse(b.course)) return res.status(400).json({ error: 'course must be one of: drink, appetizer, entree, dessert' });
  const course = b.course.trim().toLowerCase();
  const item_type = b.item_type === undefined ? (station === 'bar' ? 'drink' : 'food') : b.item_type.trim().toLowerCase();
  if (!ITEM_TYPES.has(item_type)) return res.status(400).json({ error: 'item_type must be one of: drink, food, dessert' });
  const modErr = validateModifiers(b.modifiers);
  if (modErr) return res.status(400).json({ error: modErr });
  const r = db.prepare(`INSERT INTO menu_items
    (site_id, category_id, name, description, price_cents, item_type, station, course, active, price_note, image_url, daypart)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`)
    .run(SITE_ID, cat.id, name, cleanOpt(b.description), b.price_cents, item_type, station, course,
      cleanOpt(b.price_note), cleanOpt(b.image_url), cleanOpt(b.daypart));
  const id = r.lastInsertRowid;
  if (b.modifiers) saveModifiers(id, b.modifiers);
  auditMenu(req, 'item.create', { item_id: id, category_id: cat.id }, { name, price_cents: b.price_cents, station, course });
  broadcastMenuUpdated();
  res.status(201).json(itemAdminView(menuItemById(id)));
});

app.put('/api/admin/menu/items/:id', managerOnly(), (req, res) => {
  const it = menuItemById(req.params.id);
  if (!it) return res.status(404).json({ error: 'Menu item not found' });
  const b = req.body || {};
  const name = b.name === undefined ? it.name : cleanLabel(b.name);
  if (!name) return res.status(400).json({ error: 'Item name is required' });
  const price_cents = b.price_cents === undefined ? it.price_cents : b.price_cents;
  if (!validPriceCents(price_cents)) return res.status(400).json({ error: 'price_cents must be a whole number of cents ≥ 0' });
  const station = b.station === undefined ? it.station : canonStation(b.station);
  if (!station) return res.status(400).json({ error: 'station must be one of: bar, expediter, garde_manger, dessert' });
  const course = b.course === undefined ? it.course : b.course.trim().toLowerCase();
  if (!COURSES.has(course)) return res.status(400).json({ error: 'course must be one of: drink, appetizer, entree, dessert' });
  const item_type = b.item_type === undefined ? it.item_type : b.item_type.trim().toLowerCase();
  if (!ITEM_TYPES.has(item_type)) return res.status(400).json({ error: 'item_type must be one of: drink, food, dessert' });
  const category_id = b.category_id === undefined ? it.category_id : b.category_id;
  if (!menuCategoryById(category_id)) return res.status(400).json({ error: 'Valid category_id is required' });
  const modErr = validateModifiers(b.modifiers);
  if (modErr) return res.status(400).json({ error: modErr });
  db.prepare(`UPDATE menu_items SET category_id = ?, name = ?, description = ?, price_cents = ?,
    item_type = ?, station = ?, course = ?, price_note = ?, image_url = ?, daypart = ? WHERE id = ?`)
    .run(category_id, name, b.description === undefined ? it.description : cleanOpt(b.description),
      price_cents, item_type, station, course,
      b.price_note === undefined ? it.price_note : cleanOpt(b.price_note),
      b.image_url === undefined ? it.image_url : cleanOpt(b.image_url),
      b.daypart === undefined ? it.daypart : cleanOpt(b.daypart), it.id);
  if (b.modifiers !== undefined) saveModifiers(it.id, b.modifiers);
  auditMenu(req, 'item.update', { item_id: it.id, category_id }, { name, price_cents, station, course });
  broadcastMenuUpdated();
  res.json(itemAdminView(menuItemById(it.id)));
});

app.delete('/api/admin/menu/items/:id', managerOnly(), (req, res) => {
  const it = menuItemById(req.params.id);
  if (!it) return res.status(404).json({ error: 'Menu item not found' });
  const refs = db.prepare('SELECT COUNT(*) AS n FROM check_items WHERE menu_item_id = ?').get(it.id).n;
  if (refs > 0) {
    return res.status(400).json({ error: `“${it.name}” has order history — 86 it to hide it instead of deleting` });
  }
  db.prepare('DELETE FROM menu_modifiers WHERE item_id = ?').run(it.id);
  db.prepare('DELETE FROM menu_items WHERE id = ?').run(it.id);
  auditMenu(req, 'item.delete', { item_id: it.id, category_id: it.category_id }, { name: it.name });
  broadcastMenuUpdated();
  res.json({ deleted: it.id });
});

/* One-tap 86: flips active 1↔0. Kept deliberately tiny — this is the button a
   manager hammers mid-rush, so it does one UPDATE, one audit row, one push. */
app.post('/api/admin/menu/86/:id', managerOnly(), (req, res) => {
  const it = menuItemById(req.params.id);
  if (!it) return res.status(404).json({ error: 'Menu item not found' });
  const active = it.active ? 0 : 1;
  db.prepare('UPDATE menu_items SET active = ? WHERE id = ?').run(active, it.id);
  auditMenu(req, active ? 'item.un86' : 'item.86', { item_id: it.id, category_id: it.category_id }, { name: it.name, active });
  broadcastMenuUpdated();
  res.json({ id: it.id, name: it.name, active, eightysixed: active === 0 });
});

app.get('/api/admin/menu/audit', managerOnly(), (req, res) => {
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || '50', 10) || 50));
  const rows = db.prepare('SELECT id, actor, action, item_id, category_id, details, created_at FROM menu_audit WHERE site_id = ? ORDER BY id DESC LIMIT ?').all(SITE_ID, limit);
  res.json(rows.map((r) => ({ id: r.id, actor: r.actor, action: r.action, item_id: r.item_id, category_id: r.category_id, details: parseJson(r.details, {}), created_at: r.created_at })));
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
    "INSERT INTO checks (uuid, site_id, table_id, server_id, tab_name, guest_count, status, opened_at) VALUES (?, ?, ?, ?, ?, ?, 'open', ?)"
  ).run(crypto.randomUUID(), SITE_ID, table_id, req.user.id, tab_name || null, guest_count, nowIso());
  const check = checkResponse(r.lastInsertRowid);
  broadcastCheckUpdated(check.id);
  res.status(201).json(check);
});

app.get('/api/checks/open', serverPlus(), (req, res) => {
  const rows = db.prepare(
    `SELECT c.id, c.table_id, c.server_id, c.tab_name, c.guest_count, c.status, c.opened_at,
            t.label AS table_label, u.name AS server_name,
            (SELECT COUNT(*) FROM check_items ci WHERE ci.check_id = c.id AND ci.state IN ${BILLABLE_STATES}) AS item_count
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
  if (!isInt(qty) || qty < 1 || qty > 999) return res.status(400).json({ error: 'qty must be a positive integer (max 999)' });
  if (!Array.isArray(modifiers)) return res.status(400).json({ error: 'modifiers must be an array' });
  // Phase 1B money audit: modifiers are NEVER trusted from the client.
  // Each modifier must exist on this menu item (matched by name); the
  // canonical price_delta_cents from menu_modifiers is used and any
  // client-supplied price_delta_cents is ignored. This closes the
  // arbitrary-discount hole (e.g. a client-invented -$50.00 modifier).
  const modStmt = db.prepare('SELECT price_delta_cents FROM menu_modifiers WHERE item_id = ? AND name = ?');
  const pricedMods = [];
  for (const m of modifiers) {
    if (!m || typeof m.name !== 'string' || !m.name.trim()) {
      return res.status(400).json({ error: 'Each modifier needs a name' });
    }
    const row = modStmt.get(menuItem.id, m.name.trim());
    if (!row) {
      return res.status(400).json({ error: `Unknown modifier "${m.name.trim()}" for "${menuItem.name}" — modifiers must come from the menu` });
    }
    pricedMods.push({ name: m.name.trim(), price_delta_cents: row.price_delta_cents });
  }
  // MP (market price) items: price_cents = 0 requires a manager-entered price.
  // Fixed-price items ALWAYS use the menu price — a request-supplied
  // unit_price_cents for them is ignored, never trusted.
  let unitPrice = menuItem.price_cents;
  if (menuItem.price_cents === 0) {
    if (req.user.role !== 'manager') {
      return res.status(403).json({ error: 'Market-price items must be priced by a manager' });
    }
    if (unit_price_cents == null) {
      return res.status(400).json({ error: 'Market-price item requires unit_price_cents (manager-entered price)' });
    }
    unitPrice = unit_price_cents;
  }
  if (!isInt(unitPrice) || unitPrice < 0) {
    return res.status(400).json({ error: 'unit_price_cents must be a non-negative integer' });
  }

  // Phase 1B money audit (concurrency): re-check the 86 flag INSIDE a write
  // transaction. The menu editor can 86 an item between our earlier
  // active=1 read and this INSERT; BEGIN IMMEDIATE serializes us against
  // that toggle so an 86'd item can never slip onto a check.
  let item;
  try {
    db.exec('BEGIN IMMEDIATE');
    const fresh = db.prepare('SELECT active FROM menu_items WHERE id = ? AND site_id = ?')
      .get(menuItem.id, SITE_ID);
    if (!fresh || fresh.active !== 1) {
      db.exec('ROLLBACK');
      return res.status(400).json({ error: 'That item was just 86\'d — please reorder' });
    }
    const r = db.prepare(
      "INSERT INTO check_items (uuid, check_id, menu_item_id, seat, qty, unit_price_cents, modifiers_json, course, state, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'held', ?)"
    ).run(crypto.randomUUID(), check.id, menuItem.id, seat, qty, unitPrice, JSON.stringify(pricedMods), menuItem.course, nowIso());
    item = db.prepare('SELECT ci.*, mi.name FROM check_items ci LEFT JOIN menu_items mi ON mi.id = ci.menu_item_id WHERE ci.id = ?').get(r.lastInsertRowid);
    persistTotals(check.id);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw e;
  }
  broadcastCheckUpdated(check.id);
  res.status(201).json(itemView(item));
});

/** DELETE /api/checks/:id/items/:item_id — legacy held-item void path.
 *  Kept for the offline outbox flush; requires the same manager approval as
 *  the POST /void-item endpoint (live PIN or offline hash+nonce) and is
 *  audit-logged identically. There is no unapproved void path. */
app.delete('/api/checks/:id/items/:item_id', serverPlus(), (req, res) => {
  const b = req.body || {};
  const checkId = Number(req.params.id);
  const itemId = Number(req.params.item_id);
  const approval = resolveVoidApproval(req, b, checkId, itemId, res);
  if (!approval) return;
  const mgr = approval.mgr;
  const check = db.prepare('SELECT * FROM checks WHERE id = ? AND site_id = ?').get(checkId, SITE_ID);
  if (!check) return res.status(404).json({ error: 'Check not found' });
  if (check.status !== 'open') return res.status(400).json({ error: `Cannot void items on a ${check.status} check` });
  const item = db.prepare('SELECT ci.*, mi.name FROM check_items ci LEFT JOIN menu_items mi ON mi.id = ci.menu_item_id WHERE ci.id = ? AND ci.check_id = ?').get(itemId, check.id);
  if (!item) return res.status(404).json({ error: 'Item not found on this check' });
  if (item.state !== 'held') {
    if (approval.offline && approval.replay && item.state === 'cancelled') {
      return res.json({ voided: item.id, state: 'cancelled', already_voided: true, approved_by: mgr.name });
    }
    return res.status(400).json({ error: `Only held items can be voided here (item is ${item.state}) — use POST /void-item` });
  }
  const before = { state: item.state, name: item.name, unit_price_cents: item.unit_price_cents };
  db.prepare("UPDATE check_items SET state = 'cancelled' WHERE id = ?").run(item.id);
  if (approval.offline && !approval.replay) consumeOfflineApproval(approval.nonce, check.id, item.id, mgr);
  persistTotals(check.id);
  broadcastCheckUpdated(check.id);
  auditApproval(req, 'void_item', { check_id: check.id, item_id: item.id },
    { approver: mgr.name, approver_id: mgr.id, before, after: { state: 'cancelled' }, reason: cleanLabel(b.reason) || null,
      offline: approval.offline || undefined, approval_nonce: approval.offline ? approval.nonce : undefined });
  res.json({ voided: item.id, state: 'cancelled', approved_by: mgr.name });
});

/**
 * POST /api/checks/:id/void-item {item_id, manager_pin, reason?}
 * Manager-approved void. Works for held AND sent/fulfilled items (the
 * real fraud vector is post-kitchen voids). The manager physically enters
 * their PIN at the device; the approval is audit-logged with before/after.
 */
app.post('/api/checks/:id/void-item', serverPlus(), (req, res) => {
  const b = req.body || {};
  const checkId = Number(req.params.id);
  const itemId = b.item_id != null ? Number(b.item_id) : NaN;
  if (!Number.isFinite(itemId)) return res.status(400).json({ error: 'item_id is required' });
  const approval = resolveVoidApproval(req, b, checkId, itemId, res);
  if (!approval) return;
  const mgr = approval.mgr;
  const check = db.prepare('SELECT * FROM checks WHERE id = ? AND site_id = ?').get(checkId, SITE_ID);
  if (!check) return res.status(404).json({ error: 'Check not found' });
  if (check.status !== 'open') return res.status(400).json({ error: `Cannot void items on a ${check.status} check` });
  const item = db.prepare('SELECT ci.*, mi.name FROM check_items ci LEFT JOIN menu_items mi ON mi.id = ci.menu_item_id WHERE ci.id = ? AND ci.check_id = ?')
    .get(itemId, check.id);
  if (!item) return res.status(404).json({ error: 'Item not found on this check' });
  if (item.state === 'cancelled') {
    // Idempotent retry of an offline approval after a dropped response.
    if (approval.offline && approval.replay) {
      return res.json({ voided: item.id, state: 'cancelled', already_voided: true, approved_by: mgr.name });
    }
    return res.status(400).json({ error: 'Item is already voided' });
  }
  if (!['held', 'sent', 'fulfilled'].includes(item.state)) {
    return res.status(400).json({ error: `Cannot void an item in state ${item.state}` });
  }
  const reason = cleanLabel(b.reason);
  const before = { state: item.state, name: item.name, unit_price_cents: item.unit_price_cents };
  db.prepare("UPDATE check_items SET state = 'cancelled' WHERE id = ?").run(item.id);
  if (approval.offline && !approval.replay) consumeOfflineApproval(approval.nonce, check.id, item.id, mgr);
  const t = persistTotals(check.id);
  broadcastCheckUpdated(check.id);
  auditApproval(req, 'void_item', { check_id: check.id, item_id: item.id },
    { approver: mgr.name, approver_id: mgr.id, before, after: { state: 'cancelled' }, reason: reason || null,
      offline: approval.offline || undefined, approval_nonce: approval.offline ? approval.nonce : undefined });
  res.json({ voided: item.id, state: 'cancelled', approved_by: mgr.name, totals: t });
});

/**
 * PATCH /api/checks/:id/items/:item_id {qty?, modifiers?, manager_pin?, manager_pin_hash?, approval_nonce?}
 * Edit an item on an open check: change qty and/or modifiers.
 * - held items: the server/kitchen can edit directly (nothing fired yet).
 * - sent/fulfilled items: the kitchen already fired — requires manager
 *   approval (same live-PIN or offline hash+nonce mechanism as void-item),
 *   and the change is audit-logged with before/after.
 * Modifier validation mirrors POST /items. Fixed-price items keep the menu
 * price; market-price items keep their manager-entered price (price itself
 * is never editable here — void and re-add instead).
 */
app.patch('/api/checks/:id/items/:item_id', serverPlus(), (req, res) => {
  const b = req.body || {};
  const checkId = Number(req.params.id);
  const itemId = Number(req.params.item_id);
  if (!Number.isFinite(itemId)) return res.status(400).json({ error: 'item_id is required' });
  const check = db.prepare('SELECT * FROM checks WHERE id = ? AND site_id = ?').get(checkId, SITE_ID);
  if (!check) return res.status(404).json({ error: 'Check not found' });
  if (check.status !== 'open') return res.status(400).json({ error: `Cannot edit items on a ${check.status} check` });
  const item = db.prepare('SELECT ci.*, mi.name FROM check_items ci LEFT JOIN menu_items mi ON mi.id = ci.menu_item_id WHERE ci.id = ? AND ci.check_id = ?')
    .get(itemId, check.id);
  if (!item) return res.status(404).json({ error: 'Item not found on this check' });
  if (item.state === 'cancelled') return res.status(400).json({ error: 'Item is voided — re-add it instead' });
  if (!['held', 'sent', 'fulfilled'].includes(item.state)) {
    return res.status(400).json({ error: `Cannot edit an item in state ${item.state}` });
  }
  const patch = {};
  if (b.qty !== undefined) {
    if (!isInt(b.qty) || b.qty < 1 || b.qty > 24) return res.status(400).json({ error: 'qty must be an integer between 1 and 24' });
    patch.qty = b.qty;
  }
  if (b.modifiers !== undefined) {
    if (!Array.isArray(b.modifiers)) return res.status(400).json({ error: 'modifiers must be an array' });
    for (const m of b.modifiers) {
      if (!m || typeof m.name !== 'string' || !isInt(m.price_delta_cents)) {
        return res.status(400).json({ error: 'Each modifier needs {name, price_delta_cents}' });
      }
    }
    patch.modifiers = b.modifiers.map((m) => ({ name: m.name.trim().slice(0, 80), price_delta_cents: m.price_delta_cents }));
  }
  if (!('qty' in patch) && !('modifiers' in patch)) {
    return res.status(400).json({ error: 'Nothing to update — send qty and/or modifiers' });
  }
  let approval = null;
  if (item.state !== 'held') {
    approval = resolveVoidApproval(req, b, checkId, itemId, res);
    if (!approval) return;
    if (approval.offline && approval.replay) {
      // Idempotent retry after a dropped response — the edit already applied.
      const cur = db.prepare('SELECT ci.*, mi.name FROM check_items ci LEFT JOIN menu_items mi ON mi.id = ci.menu_item_id WHERE ci.id = ?').get(item.id);
      return res.json(Object.assign(itemView(cur), { already_applied: true, approved_by: approval.mgr.name }));
    }
  }
  const before = { qty: item.qty, modifiers: parseJson(item.modifiers_json, []) };
  if (patch.qty !== undefined) db.prepare('UPDATE check_items SET qty = ? WHERE id = ?').run(patch.qty, item.id);
  if (patch.modifiers !== undefined) db.prepare('UPDATE check_items SET modifiers_json = ? WHERE id = ?').run(JSON.stringify(patch.modifiers), item.id);
  if (approval && approval.offline && !approval.replay) consumeOfflineApproval(approval.nonce, check.id, item.id, approval.mgr);
  const t = persistTotals(check.id);
  broadcastCheckUpdated(check.id);
  const updated = db.prepare('SELECT ci.*, mi.name FROM check_items ci LEFT JOIN menu_items mi ON mi.id = ci.menu_item_id WHERE ci.id = ?').get(item.id);
  if (approval) {
    auditApproval(req, 'edit_item', { check_id: check.id, item_id: item.id },
      { approver: approval.mgr.name, approver_id: approval.mgr.id,
        before, after: { qty: updated.qty, modifiers: parseJson(updated.modifiers_json, []) },
        offline: approval.offline || undefined, approval_nonce: approval.offline ? approval.nonce : undefined });
  }
  res.json(Object.assign(itemView(updated), approval ? { approved_by: approval.mgr.name } : {}, { totals: t }));
});

/**
 * POST /api/checks/:id/comp {amount_cents | percent, manager_pin, reason}
 * Manager-approved check-level discount. Accumulates on the check (multiple
 * comps allowed, each audit-logged). Reason is required — comps without a
 * reason are how money walks out the door.
 */
app.post('/api/checks/:id/comp', serverPlus(), (req, res) => {
  const b = req.body || {};
  if (managerPinThrottled(req)) {
    return res.status(429).json({ error: 'Too many failed manager-PIN attempts — please wait a few minutes' });
  }
  const mgr = verifyManagerPin(b.manager_pin);
  if (!mgr) { recordManagerPinAttempt(req, false); return res.status(403).json({ error: 'Manager PIN required to comp a check' }); }
  recordManagerPinAttempt(req, true);
  const check = db.prepare('SELECT * FROM checks WHERE id = ? AND site_id = ?').get(req.params.id, SITE_ID);
  if (!check) return res.status(404).json({ error: 'Check not found' });
  if (check.status !== 'open') return res.status(400).json({ error: `Cannot comp a ${check.status} check` });
  const reason = cleanLabel(b.reason);
  if (!reason) return res.status(400).json({ error: 'A reason is required for comps' });
  const t0 = calcTotals(check.id);
  let comp;
  if (b.amount_cents != null) {
    if (!isInt(b.amount_cents) || b.amount_cents <= 0) return res.status(400).json({ error: 'amount_cents must be a positive whole number of cents' });
    if (t0.subtotal <= 0) return res.status(400).json({ error: 'Check subtotal is zero — nothing to comp' });
    comp = b.amount_cents;
  } else if (b.percent != null) {
    const p = Number(b.percent);
    if (!Number.isFinite(p) || p <= 0 || p > 100) return res.status(400).json({ error: 'percent must be > 0 and ≤ 100' });
    comp = Math.round(t0.subtotal * p / 100);
    if (comp <= 0) return res.status(400).json({ error: 'Check subtotal is zero — nothing to comp' });
  } else {
    return res.status(400).json({ error: 'amount_cents or percent is required' });
  }
  const before = check.comp_cents || 0;
  // Phase 1B money audit: cumulative comps may never exceed the check
  // subtotal — a discount can't exceed what's owed, and the total must never
  // depend on the Math.max(0, …) clamp to stay non-negative.
  if (before + comp > t0.subtotal) {
    return res.status(400).json({ error: `Comp of ${before + comp}¢ exceeds the check subtotal of ${t0.subtotal}¢` });
  }
  // Atomic increment (never read-then-overwrite) so two concurrent comps
  // accumulate instead of the second clobbering the first.
  db.prepare('UPDATE checks SET comp_cents = comp_cents + ? WHERE id = ?').run(comp, check.id);
  const after = before + comp;
  const t = persistTotals(check.id);
  broadcastCheckUpdated(check.id);
  auditApproval(req, 'comp', { check_id: check.id },
    { approver: mgr.name, approver_id: mgr.id, before: { comp_cents: before }, after: { comp_cents: after }, added_cents: comp, percent: b.percent ?? null, reason });
  res.json({ check_id: check.id, comp_cents: after, added_cents: comp, approved_by: mgr.name, totals: t });
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
    "INSERT INTO kds_tickets (uuid, check_id, site_id, station, table_label, server_name, items_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'new', ?)"
  );
  for (const [station, items] of byStation) {
    const r = insTicket.run(
      crypto.randomUUID(), check.id, SITE_ID, station,
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
        "INSERT INTO checks (uuid, site_id, table_id, server_id, tab_name, guest_count, status, opened_at) VALUES (?, ?, ?, ?, ?, ?, 'open', ?)"
      );
      const moveStmt = db.prepare('UPDATE check_items SET check_id = ? WHERE id = ?');
      groups.forEach((g, i) => {
        const seats = [...new Set(g.map((it) => it.seat))];
        const label = check.tab_name ? `${check.tab_name} · split ${i + 1}` : `Split ${i + 1}`;
        const r = insCheck.run(crypto.randomUUID(), SITE_ID, check.table_id, check.server_id, label, Math.max(1, seats.length), now);
        for (const it of g) moveStmt.run(r.lastInsertRowid, it.id);
        persistTotals(r.lastInsertRowid);
        broadcastCheckUpdated(r.lastInsertRowid);
        createdIds.push(Number(r.lastInsertRowid));
      });
    }
    // If the source check is now empty (no billable items, no payments), close it.
    const remaining = db.prepare(
      "SELECT COUNT(*) AS n FROM check_items WHERE check_id = ? AND state IN " + BILLABLE_STATES
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
  if (tendered_cents != null && (!isInt(tendered_cents) || tendered_cents < 0)) {
    return res.status(400).json({ error: 'tendered_cents must be a non-negative integer' });
  }

  // Phase 1B money audit: idempotency replay comes FIRST — a retried
  // double-tap/double-POST with the same key replays the stored payment
  // instead of re-running validation against the now-changed balance.
  const ikey = idemKeyFrom(req);
  if (ikey) {
    const rp = idemReplay('payments', ikey);
    if (rp) return res.status(rp.status).json(rp.body);
  }

  const totals = persistTotals(check.id);
  if (totals.balance <= 0) return res.status(400).json({ error: 'Check is already paid in full' });
  // Phase 1B money audit: a payment may never exceed the remaining balance —
  // over-application used to drive the balance negative and mark the check
  // paid with money the house never collected.
  if (amount_cents > totals.balance) {
    return res.status(400).json({ error: `amount_cents (${amount_cents}¢) exceeds the remaining balance (${totals.balance}¢)` });
  }

  // Reserve AFTER validation, BEFORE the mutation.
  let idem = null;
  if (ikey) {
    const rsv = idemReserve('payments', ikey);
    if (rsv.state === 'replay') return res.status(rsv.status).json(rsv.body);
    if (rsv.state === 'processing') return res.status(409).json({ error: 'Duplicate payment already in progress — retry shortly' });
    idem = ikey;
  }

  try {
    let authCode = null;
    let demo = null;
    if (method === 'card_demo') {
      // Simulated terminal: DEMO ONLY — no real charge is ever made.
      authCode = 'DEMO' + crypto.randomBytes(3).toString('hex').toUpperCase();
      demo = { approved: true, auth_code: authCode, message: 'DEMO terminal - no real charge' };
    }

    const r = db.prepare(
      "INSERT INTO payments (uuid, check_id, site_id, method, amount_cents, tip_cents, tendered_cents, brand, last4, auth_code, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?)"
    ).run(crypto.randomUUID(), check.id, SITE_ID, method, amount_cents, tip_cents, tendered_cents ?? null,
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
    if (idem) idemStore('payments', idem, 201, out);
    return res.status(201).json(out);
  } catch (e) {
    if (idem) idemClear('payments', idem);
    throw e;
  }
});

app.post('/api/payments/:id/refund', managerOnly(), (req, res) => {
  // Phase 1B money audit: idempotency replay FIRST — a retried double-POST
  // replays the stored refund even though the payment now reads 'refunded'.
  const ikey0 = idemKeyFrom(req);
  if (ikey0) {
    const rp0 = idemReplay('refunds', ikey0);
    if (rp0) return res.status(rp0.status).json(rp0.body);
  }
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

  // Phase 1B money audit: reserve the idempotency key AFTER validation,
  // BEFORE the mutation.
  const ikey = ikey0;
  let idem = null;
  if (ikey) {
    const rsv = idemReserve('refunds', ikey);
    if (rsv.state === 'replay') return res.status(rsv.status).json(rsv.body);
    if (rsv.state === 'processing') return res.status(409).json({ error: 'Duplicate refund already in progress — retry shortly' });
    idem = ikey;
  }

  try {
    // Conditional UPDATE on the exact refunded_cents we read: the
    // check-and-set is atomic, so a concurrent refund can't double-apply.
    const upd = db.prepare('UPDATE payments SET refunded_cents = ?, status = ? WHERE id = ? AND refunded_cents = ?')
      .run(newRefunded, newStatus, payment.id, payment.refunded_cents || 0);
    if (upd.changes !== 1) {
      const err = new Error('Payment changed while refunding — please retry');
      err.status = 409;
      throw err;
    }

    const totals = persistTotals(payment.check_id);
  const check = db.prepare('SELECT status FROM checks WHERE id = ?').get(payment.check_id);
  /* A refund on a still-active ('paid') check reopens it so the balance stays
     visible on the floor. A 'closed' check is end-of-lifecycle history: the
     refund is recorded in payouts/refunds, but the check does NOT reopen —
     the customer already left and the balance is not a collectible debt
     (matches Toast/Square behavior; keeps closed checks out of the open list). */
  if (check && check.status === 'paid' && totals.balance > 0) {
    // Refund pushed the check back to a positive balance — reopen it.
    db.prepare("UPDATE checks SET status = 'open', closed_at = NULL WHERE id = ?").run(payment.check_id);
  }
  broadcastCheckUpdated(payment.check_id);
  const out = { payment: paymentView(db.prepare('SELECT * FROM payments WHERE id = ?').get(payment.id)) };
  if (idem) idemStore('refunds', idem, 200, out);
  return res.json(out);
} catch (e) {
  if (idem) idemClear('refunds', idem);
  throw e;
}
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
    const slug = canonStation(station);
    if (!slug) {
      return res.status(400).json({ error: 'Unknown station' });
    }
    sql += ' AND t.station = ?';
    params.push(slug);
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
    } else if (p.method === 'cash' || p.method === 'gift_card') {
      cashSales += p.amount_cents;
    }
  }
  const expectedPayout = cardVolume - refunds - fees;
  // Time-clock labor for the same sales date, so Finance shows the full
  // picture (premiums are wages and belong in labor cost).
  const labor = dayLabor(date).summary;
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
    labor_cents: labor.total_cents,
    labor: { reg_cents: labor.reg_cents, ot_cents: labor.ot_cents, premium_cents: labor.premium_cents, weekly_ot_cents: labor.weekly_ot_cents },
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
      } else if (p.method === 'cash' || p.method === 'gift_card') {
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

/* --------------------------- accounting reports ---------------------------- */
/** Exportable accounting reports: sales | payouts | tax | labor | tips.
 *  Formats: xlsx | csv | pdf | docx (genuine files via exceljs / pdf-lib /
 *  docx) plus json for debugging. Every report honors the requested range:
 *  period = day | week | month | year | custom, or explicit from/to
 *  (YYYY-MM-DD, site timezone). Sales bucket by sales date (closed_at);
 *  payouts/tips by payment date; labor by shift date.
 *
 *  NOTE: automated server-side email sending is NOT implemented — it needs
 *  Daniel's email-provider credentials. The UI downloads the file and opens
 *  a prefilled mailto: compose instead. Nothing here fakes sending. */
function badReq(msg) { const e = new Error(msg); e.statusCode = 400; return e; }

function reportRange(q) {
  const explicit = q.from || q.to;
  const period = String(q.period || (explicit ? 'custom' : 'day')).toLowerCase();
  const anchor = /^\d{4}-\d{2}-\d{2}$/.test(q.date || '') ? q.date : todaySite();
  let from, to, eff = period;
  if (period === 'custom' || explicit) {
    eff = 'custom';
    from = q.from || q.to; to = q.to || q.from;
    if (!from) throw badReq('from and to are required for a custom range (YYYY-MM-DD)');
  } else if (period === 'day') { from = to = anchor; }
  else if (period === 'week') { from = weekStartSite(anchor + 'T12:00:00Z'); to = addDays(from, 6); }
  else if (period === 'month') {
    from = anchor.slice(0, 8) + '01';
    const [y, m] = anchor.split('-').map(Number);
    to = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  }
  else if (period === 'year') { from = anchor.slice(0, 4) + '-01-01'; to = anchor.slice(0, 4) + '-12-31'; }
  else throw badReq('period must be day, week, month, year, or custom');
  for (const d of [from, to]) if (!/^\d{4}-\d{2}-\d{2}$/.test(d || '')) throw badReq('from/to must be YYYY-MM-DD');
  if (from > to) throw badReq('from must not be after to (reversed range)');
  if (Math.round((new Date(to + 'T00:00:00Z') - new Date(from + 'T00:00:00Z')) / 86400000) > 370) {
    throw badReq('range is limited to 370 days');
  }
  return { from, to, period: eff };
}

/** Per-sales-date payout math (same contract as GET /api/finance/payouts). */
function payoutDay(date) {
  const cfg = getConfig();
  const payments = db.prepare('SELECT * FROM payments WHERE site_id = ? ORDER BY created_at, id').all(SITE_ID)
    .filter((p) => tzDate(p.created_at) === date);
  let cardVolume = 0, refunds = 0, fees = 0, cashSales = 0, tips = 0;
  for (const p of payments) {
    tips += p.tip_cents || 0;
    const refunded = p.refunded_cents || 0;
    if (p.method === 'card_demo') {
      cardVolume += p.amount_cents;
      refunds += refunded;
      fees += demoFeeCents(p.amount_cents - refunded);
    } else if (p.method === 'cash' || p.method === 'gift_card') {
      cashSales += p.amount_cents;
    }
  }
  return {
    sales_date: date, payout_date: addDays(date, cfg.payout_lag_days),
    card_volume_cents: cardVolume, refunds_cents: refunds,
    stripe_fees_cents: fees, expected_payout_cents: cardVolume - refunds - fees,
    cash_sales_cents: cashSales, tips_cents: tips,
  };
}

function eachDate(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

function employeeNumberFor(userId) {
  const r = db.prepare('SELECT employee_number FROM employees WHERE user_id = ? AND site_id = ?').get(userId, SITE_ID);
  return r ? r.employee_number : null;
}

/** Weekly-OT premium rows for one Sun–Sat workweek (mirrors dayLabor). */
function weeklyOtRows(weekStart) {
  const cfg = clockConfig();
  const byUser = new Map();
  for (const s of db.prepare('SELECT * FROM clock_shifts WHERE site_id = ?').all(SITE_ID)) {
    if (weekStartSite(s.clock_in) !== weekStart) continue;
    if (!byUser.has(s.user_id)) byUser.set(s.user_id, []);
    byUser.get(s.user_id).push(s);
  }
  const rows = [];
  for (const [uid, wshifts] of byUser) {
    let wh = 0, dot = 0, payAt1x = 0;
    for (const s of wshifts) {
      const v = shiftView(s, breaksFor(s.id), cfg);
      wh += v.hours; dot += v.pay.ot15_hours + v.pay.ot2_hours;
      payAt1x += v.pay.reg_cents + v.pay.ot15_cents / 1.5 + v.pay.ot2_cents / 2;
    }
    const extra = Math.max(0, wh - cfg.ot_weekly_h - dot);
    const avgRate = wh > 0.005 ? payAt1x / wh : 0;
    if (extra > 0.005 && avgRate > 0) {
      rows.push({
        week_start: weekStart, employee_number: employeeNumberFor(uid),
        employee_name: wshifts[0].employee_name, extra_ot_hours: r2(extra),
        premium_cents: Math.round(extra * avgRate * 0.5),
      });
    }
  }
  return rows;
}

const REPORT_DEFS = {
  sales: {
    title: 'Sales summary',
    notes: ['Net sales = gross + surcharge + service charge − comps.', 'Tips are not sales and are not taxed.'],
    columns: [
      { key: 'date', label: 'Date', kind: 'date' },
      { key: 'checks', label: 'Checks', kind: 'int' },
      { key: 'covers', label: 'Covers', kind: 'int' },
      { key: 'gross_cents', label: 'Gross sales', kind: 'money' },
      { key: 'surcharge_cents', label: 'Surcharge', kind: 'money' },
      { key: 'service_cents', label: 'Service charge', kind: 'money' },
      { key: 'comp_cents', label: 'Comps', kind: 'money' },
      { key: 'net_cents', label: 'Net sales', kind: 'money' },
      { key: 'tax_cents', label: 'Tax', kind: 'money' },
      { key: 'tips_cents', label: 'Tips', kind: 'money' },
      { key: 'cash_cents', label: 'Cash sales', kind: 'money' },
      { key: 'card_cents', label: 'Card sales', kind: 'money' },
    ],
    totalKeys: ['checks', 'covers', 'gross_cents', 'surcharge_cents', 'service_cents', 'comp_cents', 'net_cents', 'tax_cents', 'tips_cents', 'cash_cents', 'card_cents'],
    build(from, to) {
      const checks = db.prepare("SELECT * FROM checks WHERE site_id = ? AND status IN ('paid','closed') AND closed_at IS NOT NULL").all(SITE_ID);
      const payByCheck = new Map();
      for (const p of db.prepare('SELECT * FROM payments WHERE site_id = ?').all(SITE_ID)) {
        if (!payByCheck.has(p.check_id)) payByCheck.set(p.check_id, []);
        payByCheck.get(p.check_id).push(p);
      }
      const rows = eachDate(from, to).map((date) => {
        const r = { date, checks: 0, covers: 0, gross_cents: 0, surcharge_cents: 0, service_cents: 0, comp_cents: 0, net_cents: 0, tax_cents: 0, tips_cents: 0, cash_cents: 0, card_cents: 0 };
        for (const c of checks) {
          if (tzDate(c.closed_at) !== date) continue;
          const t = persistTotals(c.id);
          r.checks++; r.covers += c.guest_count || 0;
          r.gross_cents += t.subtotal; r.surcharge_cents += t.surcharge; r.service_cents += t.service_charge;
          r.comp_cents += t.comp; r.tax_cents += t.tax;
          for (const p of (payByCheck.get(c.id) || [])) {
            r.tips_cents += p.tip_cents || 0;
            const net = p.amount_cents - (p.refunded_cents || 0);
            if (p.method === 'cash' || p.method === 'gift_card') r.cash_cents += net;
            else if (p.method === 'card_demo') r.card_cents += net;
          }
        }
        r.net_cents = r.gross_cents + r.surcharge_cents + r.service_cents - r.comp_cents;
        return r;
      });
      return { rows, extraTables: [] };
    },
  },
  payouts: {
    title: 'Payout reconciliation',
    notes: ['Expected payout = card volume − refunds − Stripe fees (DEMO rate: 2.6% + 15¢ per card payment).', 'Sales date and payout date are distinct — payouts land ' + getConfig().payout_lag_days + ' days after the sales date.', 'Tips are collected separately and never reduce the payout.'],
    columns: [
      { key: 'sales_date', label: 'Sales date', kind: 'date' },
      { key: 'payout_date', label: 'Payout date', kind: 'date' },
      { key: 'card_volume_cents', label: 'Card volume', kind: 'money' },
      { key: 'refunds_cents', label: 'Refunds', kind: 'money' },
      { key: 'stripe_fees_cents', label: 'Stripe fees (DEMO)', kind: 'money' },
      { key: 'expected_payout_cents', label: 'Expected payout', kind: 'money' },
    ],
    totalKeys: ['card_volume_cents', 'refunds_cents', 'stripe_fees_cents', 'expected_payout_cents'],
    build(from, to) {
      const rows = eachDate(from, to).map((d) => payoutDay(d));
      return { rows, extraTables: [] };
    },
  },
  tax: {
    title: 'Sales tax',
    notes: ['Taxable sales = gross + surcharge + service charge − comps. Tips are not taxed and are shown only for completeness.'],
    columns: [
      { key: 'date', label: 'Date', kind: 'date' },
      { key: 'checks', label: 'Checks', kind: 'int' },
      { key: 'taxable_cents', label: 'Taxable sales', kind: 'money' },
      { key: 'tax_cents', label: 'Tax collected', kind: 'money' },
      { key: 'tips_cents', label: 'Tips (nontaxable)', kind: 'money' },
    ],
    totalKeys: ['checks', 'taxable_cents', 'tax_cents', 'tips_cents'],
    build(from, to) {
      const checks = db.prepare("SELECT * FROM checks WHERE site_id = ? AND status IN ('paid','closed') AND closed_at IS NOT NULL").all(SITE_ID);
      const tipByCheck = new Map();
      for (const p of db.prepare('SELECT check_id, tip_cents FROM payments WHERE site_id = ?').all(SITE_ID)) {
        tipByCheck.set(p.check_id, (tipByCheck.get(p.check_id) || 0) + (p.tip_cents || 0));
      }
      const rows = eachDate(from, to).map((date) => {
        const r = { date, checks: 0, taxable_cents: 0, tax_cents: 0, tips_cents: 0 };
        for (const c of checks) {
          if (tzDate(c.closed_at) !== date) continue;
          const t = persistTotals(c.id);
          r.checks++;
          r.taxable_cents += t.subtotal + t.surcharge + t.service_charge - t.comp;
          r.tax_cents += t.tax;
          r.tips_cents += tipByCheck.get(c.id) || 0;
        }
        return r;
      });
      return { rows, extraTables: [] };
    },
  },
  labor: {
    title: 'Labor',
    notes: ['Regular, daily overtime (1.5× after 8h, 2× after 12h), and CA break premiums come from the time clock.', 'Weekly overtime (hours beyond 40/week at 1.5×) is listed separately by workweek and included in the combined total.'],
    columns: [
      { key: 'date', label: 'Date', kind: 'date' },
      { key: 'employee_number', label: '#', kind: 'text' },
      { key: 'employee_name', label: 'Employee', kind: 'text' },
      { key: 'role', label: 'Role', kind: 'text' },
      { key: 'reg_hours', label: 'Reg hrs', kind: 'hours' },
      { key: 'reg_cents', label: 'Reg pay', kind: 'money' },
      { key: 'ot15_hours', label: 'OT 1.5 hrs', kind: 'hours' },
      { key: 'ot15_cents', label: 'OT 1.5 pay', kind: 'money' },
      { key: 'ot2_hours', label: 'OT 2× hrs', kind: 'hours' },
      { key: 'ot2_cents', label: 'OT 2× pay', kind: 'money' },
      { key: 'premium_cents', label: 'Break premium', kind: 'money' },
      { key: 'total_cents', label: 'Total pay', kind: 'money' },
    ],
    totalKeys: ['reg_hours', 'reg_cents', 'ot15_hours', 'ot15_cents', 'ot2_hours', 'ot2_cents', 'premium_cents', 'total_cents'],
    build(from, to) {
      const cfg = clockConfig();
      const shifts = db.prepare('SELECT * FROM clock_shifts WHERE site_id = ? ORDER BY clock_in, id').all(SITE_ID)
        .filter((s) => { const d = tzDate(s.clock_in); return d >= from && d <= to; });
      const rows = shifts.map((s) => {
        const v = shiftView(s, breaksFor(s.id), cfg);
        return {
          date: tzDate(s.clock_in), employee_number: employeeNumberFor(s.user_id) || '—',
          employee_name: s.employee_name, role: s.role,
          reg_hours: v.pay.reg_hours, reg_cents: v.pay.reg_cents,
          ot15_hours: v.pay.ot15_hours, ot15_cents: v.pay.ot15_cents,
          ot2_hours: v.pay.ot2_hours, ot2_cents: v.pay.ot2_cents,
          premium_cents: v.pay.premium_cents, total_cents: v.pay.total_cents,
        };
      });
      const weekStarts = [...new Set(shifts.map((s) => weekStartSite(s.clock_in)))].sort();
      const wotRows = weekStarts.flatMap((ws) => weeklyOtRows(ws));
      const wotTotal = wotRows.reduce((a, r) => a + r.premium_cents, 0);
      const extraTables = wotRows.length ? [{
        title: 'Weekly overtime premiums',
        columns: [
          { key: 'week_start', label: 'Week starting', kind: 'date' },
          { key: 'employee_number', label: '#', kind: 'text' },
          { key: 'employee_name', label: 'Employee', kind: 'text' },
          { key: 'extra_ot_hours', label: 'Extra OT hrs', kind: 'hours' },
          { key: 'premium_cents', label: 'Premium pay', kind: 'money' },
        ],
        rows: wotRows,
        totals: { label: 'Total', premium_cents: wotTotal },
      }] : [];
      return { rows, extraTables, combinedNote: wotTotal ? 'Combined labor cost incl. weekly OT premiums: see totals above + ' + '$' + (wotTotal / 100).toFixed(2) : null };
    },
  },
  tips: {
    title: 'Tips',
    notes: ['Tips are not sales and are not taxed. Cash tips are kept by the server directly; card tips are paid out by the house at checkout.'],
    columns: [
      { key: 'date', label: 'Date', kind: 'date' },
      { key: 'server_name', label: 'Server', kind: 'text' },
      { key: 'cash_tips_cents', label: 'Cash tips', kind: 'money' },
      { key: 'card_tips_cents', label: 'Card tips', kind: 'money' },
      { key: 'total_tips_cents', label: 'Total tips', kind: 'money' },
    ],
    totalKeys: ['cash_tips_cents', 'card_tips_cents', 'total_tips_cents'],
    build(from, to) {
      const serverByCheck = new Map();
      for (const c of db.prepare('SELECT id, server_id FROM checks WHERE site_id = ?').all(SITE_ID)) serverByCheck.set(c.id, c.server_id);
      const nameByUser = new Map();
      for (const u of db.prepare('SELECT id, name FROM users WHERE site_id = ?').all(SITE_ID)) nameByUser.set(u.id, u.name);
      const byKey = new Map();
      for (const p of db.prepare('SELECT * FROM payments WHERE site_id = ?').all(SITE_ID)) {
        const d = tzDate(p.created_at);
        if (!d || d < from || d > to) continue;
        if (!(p.tip_cents > 0)) continue;
        const nm = nameByUser.get(serverByCheck.get(p.check_id)) || 'Unknown';
        const k = d + '|' + nm;
        if (!byKey.has(k)) byKey.set(k, { date: d, server_name: nm, cash_tips_cents: 0, card_tips_cents: 0, total_tips_cents: 0 });
        const r = byKey.get(k);
        if (p.method === 'cash' || p.method === 'gift_card') r.cash_tips_cents += p.tip_cents;
        else r.card_tips_cents += p.tip_cents;
        r.total_tips_cents += p.tip_cents;
      }
      const rows = [...byKey.values()].sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : a.server_name.localeCompare(b.server_name));
      return { rows, extraTables: [] };
    },
  },
};

function reportTotals(def, rows) {
  const t = { label: 'Total' };
  for (const k of (def.totalKeys || [])) {
    t[k] = rows.reduce((a, r) => a + (Number(r[k]) || 0), 0);
  }
  // hours need 2dp rounding after summation
  for (const c of def.columns) {
    if (c.kind === 'hours' && typeof t[c.key] === 'number') t[c.key] = r2(t[c.key]);
  }
  return t;
}

function fmtCell(col, v) {
  if (v == null) return '';
  if (col.kind === 'money') return '$' + (Number(v) / 100).toFixed(2);
  if (col.kind === 'hours') return Number(v).toFixed(2);
  return String(v);
}
function csvCell(col, v) {
  let s;
  if (v == null) s = '';
  else if (col.kind === 'money') s = (Number(v) / 100).toFixed(2);
  else if (col.kind === 'hours') s = Number(v).toFixed(2);
  else s = String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function buildCsv(def, data) {
  const lines = [];
  const table = (columns, rows, totals) => {
    lines.push(columns.map((c) => csvCell({ kind: 'text' }, c.label)).join(','));
    for (const r of rows) lines.push(columns.map((c) => csvCell(c, r[c.key])).join(','));
    if (totals) {
      lines.push(columns.map((c, i) => i === 0 ? 'Total' : csvCell(c, totals[c.key])).join(','));
    }
  };
  table(def.columns, data.rows, reportTotals(def, data.rows));
  for (const t of (data.extraTables || [])) {
    lines.push('');
    lines.push(csvCell({ kind: 'text' }, t.title));
    table(t.columns, t.rows, t.totals);
  }
  return lines.join('\r\n') + '\r\n';
}

async function buildXlsx(title, periodLabel, def, data) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Expoline';
  wb.created = new Date();
  const moneyFmt = '"$"#,##0.00';
  const addTable = (ws, columns, rows, totals, startRow) => {
    startRow = startRow || 1;
    const numKind = (k) => k === 'money' || k === 'int' || k === 'hours';
    columns.forEach((c, i) => {
      const col = ws.getColumn(i + 1);
      col.width = Math.max(c.label.length + 4, c.kind === 'money' ? 14 : 12);
      if (c.kind === 'money') col.numFmt = moneyFmt;
      if (c.kind === 'hours') col.numFmt = '0.00';
    });
    const hr = ws.getRow(startRow);
    columns.forEach((c, i) => { hr.getCell(i + 1).value = c.label; });
    hr.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    hr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F2A33' } };
    let r = startRow;
    for (const row of rows) {
      r++;
      const xr = ws.getRow(r);
      columns.forEach((c, i) => { xr.getCell(i + 1).value = numKind(c.kind) ? Number(row[c.key]) || 0 : (row[c.key] ?? ''); });
    }
    if (totals) {
      r++;
      const tr = ws.getRow(r);
      columns.forEach((c, i) => { tr.getCell(i + 1).value = i === 0 ? 'Total' : (Number(totals[c.key]) || 0); });
      tr.font = { bold: true };
      tr.border = { top: { style: 'thin' } };
    }
    return r + 2;
  };
  const ws = wb.addWorksheet('Report');
  ws.getCell('A1').value = title;
  ws.getCell('A1').font = { bold: true, size: 14 };
  ws.getCell('A2').value = periodLabel + ' · generated ' + new Date().toISOString();
  ws.getCell('A2').font = { italic: true, color: { argb: 'FF666666' } };
  addTable(ws, def.columns, data.rows, reportTotals(def, data.rows), 4);
  for (const t of (data.extraTables || [])) {
    const w2 = wb.addWorksheet(t.title.slice(0, 31));
    addTable(w2, t.columns, t.rows, t.totals, 1);
  }
  if (data.combinedNote) {
    const wn = wb.addWorksheet('Notes');
    wn.getCell('A1').value = title; wn.getCell('A1').font = { bold: true, size: 14 };
    (def.notes || []).forEach((n, i) => { wn.getCell('A' + (3 + i)).value = n; });
    if (data.combinedNote) wn.getCell('A' + (3 + (def.notes || []).length)).value = data.combinedNote;
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function buildPdf(title, periodLabel, def, data) {
  const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const PW = 612, PH = 792, M = 44, ROW_H = 17;
  const ink = rgb(0.12, 0.12, 0.12), grey = rgb(0.45, 0.45, 0.45), line = rgb(0.8, 0.8, 0.8);
  // Standard PDF fonts are WinAnsi-only: map common Unicode punctuation to ASCII.
  const pdfSafe = (s) => String(s ?? '').replace(/−/g, '-').replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/…/g, '...');
  let page = doc.addPage([PW, PH]);
  let y = PH - M;
  const text = (t, x, yy, size, f, color, align) => {
    t = pdfSafe(t);
    const w = f.widthOfTextAtSize(t, size);
    page.drawText(t, { x: align === 'right' ? x - w : x, y: yy, size, font: f, color: color || ink });
  };
  const numKind = (k) => k === 'money' || k === 'int' || k === 'hours';
  const drawTable = (columns, rows, totals) => {
    const avail = PW - M * 2;
    // natural widths from header + all cells
    let widths = columns.map((c) => bold.widthOfTextAtSize(pdfSafe(c.label), 9) + 14);
    for (const r of rows.concat(totals ? [totals] : [])) {
      columns.forEach((c, i) => {
        const w = font.widthOfTextAtSize(pdfSafe(fmtCell(c, i === 0 && totals && r === totals ? r.label : r[c.key])), 9) + 14;
        if (w > widths[i]) widths[i] = w;
      });
    }
    const sum = widths.reduce((a, b) => a + b, 0);
    if (sum > avail) widths = widths.map((w) => w * avail / sum);
    const xs = []; let x = M;
    widths.forEach((w) => { xs.push(x); x += w; });
    const need = ROW_H * (rows.length + (totals ? 1 : 0)) + ROW_H + 8;
    const headerRow = () => {
      page.drawRectangle({ x: M, y: y - ROW_H + 4, width: avail, height: ROW_H, color: rgb(0.94, 0.94, 0.94) });
      columns.forEach((c, i) => text(c.label, xs[i] + (numKind(c.kind) ? widths[i] - 7 : 7), y - 12, 9, bold, ink, numKind(c.kind) ? 'right' : undefined));
      y -= ROW_H;
      page.drawLine({ start: { x: M, y: y + 4 }, end: { x: M + avail, y: y + 4 }, thickness: 1, color: line });
    };
    const bodyRow = (r, isTotal) => {
      if (y < M + ROW_H) { page = doc.addPage([PW, PH]); y = PH - M; headerRow(); }
      columns.forEach((c, i) => {
        const v = isTotal && i === 0 ? 'Total' : fmtCell(c, r[c.key]);
        text(v, xs[i] + (numKind(c.kind) ? widths[i] - 7 : 7), y - 12, 9, isTotal ? bold : font, ink, numKind(c.kind) ? 'right' : undefined);
      });
      y -= ROW_H;
    };
    if (y < M + need) { page = doc.addPage([PW, PH]); y = PH - M; }
    headerRow();
    rows.forEach((r) => bodyRow(r, false));
    if (totals) {
      page.drawLine({ start: { x: M, y: y + 4 }, end: { x: M + avail, y: y + 4 }, thickness: 1, color: ink });
      bodyRow(Object.fromEntries(columns.map((c) => [c.key, totals[c.key]])), true);
    }
    y -= 10;
  };
  text(title, M, y, 16, bold); y -= 22;
  text(periodLabel + ' · generated ' + new Date().toISOString().slice(0, 16).replace('T', ' '), M, y, 9, font, grey); y -= 20;
  drawTable(def.columns, data.rows, reportTotals(def, data.rows));
  for (const t of (data.extraTables || [])) {
    if (y < M + 60) { page = doc.addPage([PW, PH]); y = PH - M; }
    text(t.title, M, y, 12, bold); y -= 18;
    drawTable(t.columns, t.rows, t.totals);
  }
  for (const n of (def.notes || [])) {
    if (y < M + 20) { page = doc.addPage([PW, PH]); y = PH - M; }
    text('• ' + n, M, y, 8, font, grey); y -= 13;
  }
  if (data.combinedNote) { text(data.combinedNote, M, y, 9, bold); y -= 14; }
  const bytes = await doc.save();
  return Buffer.from(bytes);
}

async function buildDocx(title, periodLabel, def, data) {
  const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, HeadingLevel, AlignmentType, WidthType } = require('docx');
  const cell = (t, opts) => new TableCell({
    children: [new Paragraph(Object.assign({ children: [new TextRun(t)] }, opts && opts.alignRight ? { alignment: AlignmentType.RIGHT } : {}))],
  });
  const numKind = (k) => k === 'money' || k === 'int' || k === 'hours';
  const mkTable = (columns, rows, totals) => {
    const head = new TableRow({
      children: columns.map((c) => new TableCell({
        children: [new Paragraph({ children: [new TextRun({ text: c.label, bold: true })], alignment: numKind(c.kind) ? AlignmentType.RIGHT : undefined })],
      })),
    });
    const body = rows.map((r) => new TableRow({
      children: columns.map((c) => cell(fmtCell(c, r[c.key]), { alignRight: numKind(c.kind) })),
    }));
    const all = [head, ...body];
    if (totals) {
      all.push(new TableRow({
        children: columns.map((c, i) => new TableCell({
          children: [new Paragraph({
            children: [new TextRun({ text: i === 0 ? 'Total' : fmtCell(c, totals[c.key]), bold: true })],
            alignment: numKind(c.kind) ? AlignmentType.RIGHT : undefined,
          })],
        })),
      }));
    }
    return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: all });
  };
  const children = [
    new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(title)] }),
    new Paragraph({ children: [new TextRun({ text: periodLabel + ' · generated ' + new Date().toISOString(), italics: true, color: '666666' })] }),
    mkTable(def.columns, data.rows, reportTotals(def, data.rows)),
  ];
  for (const t of (data.extraTables || [])) {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun(t.title)] }));
    children.push(mkTable(t.columns, t.rows, t.totals));
  }
  for (const n of (def.notes || [])) children.push(new Paragraph({ children: [new TextRun({ text: '• ' + n, italics: true, color: '666666' })] }));
  if (data.combinedNote) children.push(new Paragraph({ children: [new TextRun({ text: data.combinedNote, bold: true })] }));
  const doc = new Document({ sections: [{ children }] });
  return Buffer.from(await Packer.toBuffer(doc));
}

/** GET /api/finance/reports/:report?format=&period=&date=&from=&to= */
app.get('/api/finance/reports/:report', managerOnly(), async (req, res) => {
  try {
    const def = REPORT_DEFS[req.params.report];
    if (!def) return res.status(400).json({ error: 'Unknown report. Choose: ' + Object.keys(REPORT_DEFS).join(', ') });
    const format = String(req.query.format || 'xlsx').toLowerCase();
    if (!['xlsx', 'csv', 'pdf', 'docx', 'json'].includes(format)) {
      return res.status(400).json({ error: 'format must be xlsx, csv, pdf, or docx' });
    }
    const { from, to, period } = reportRange(req.query);
    const data = def.build(from, to);
    if (format === 'json') return res.json({ report: req.params.report, from, to, period, rows: data.rows, totals: reportTotals(def, data.rows), extraTables: data.extraTables || [] });
    const periodLabel = period === 'custom' ? from + ' to ' + to : period + ' of ' + from + (from === to ? '' : ' to ' + to);
    const fname = 'expoline-' + req.params.report + '-' + from + '_to_' + to + '.' + format;
    let buf, ctype;
    if (format === 'xlsx') { buf = await buildXlsx(def.title, periodLabel, def, data); ctype = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'; }
    else if (format === 'csv') { buf = Buffer.from(buildCsv(def, data), 'utf8'); ctype = 'text/csv; charset=utf-8'; }
    else if (format === 'pdf') { buf = await buildPdf(def.title, periodLabel, def, data); ctype = 'application/pdf'; }
    else { buf = await buildDocx(def.title, periodLabel, def, data); ctype = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'; }
    res.setHeader('Content-Type', ctype);
    res.setHeader('Content-Length', buf.length);
    res.setHeader('Content-Disposition', 'attachment; filename="' + fname + '"');
    res.send(buf);
  } catch (e) {
    if (e && e.statusCode) return res.status(e.statusCode).json({ error: e.message });
    console.error('report export failed:', e);
    res.status(500).json({ error: 'Report generation failed' });
  }
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
    // Time-clock labor cost for today (finalized closed shifts + elapsed-so-far
    // on open shifts, including break premiums and overtime). Feeds Finance.
    labor: dayLabor(today).summary,
  });
});

/* ================= time clock + CA break compliance (phase 2) =================
   Native time clock with a California meal/rest-break rules engine. Premiums
   are wages: they feed labor cost (see GET /api/admin/clock/shifts and the
   labor_today_cents field on /api/manager/overview).

   CA RULES (encoded as CONFIG DATA in CLOCK_CA_DEFAULTS + site_config
   `clock_*` overrides — NOT hardcoded law; verify against current CA DIR
   guidance before the pilot — we are not lawyers):
     - 30-min unpaid meal, must START before end of 5th hour; second before
       end of 10th hour. 1st waivable (mutual) if shift <= 6h; 2nd waivable if
       shift <= 12h and the first was taken.
     - 10-min paid rest per 4h or major fraction (>= 2h); none if shift < 3.5h.
     - Missed break = 1 hour of pay at regular rate, per TYPE per day
       (missed meal + missed rest stack; two missed meals do not).
     - Overtime: 1.5x after 8h/day, 2x after 12h/day, 1.5x after 40h/week
       (weekly extra computed at day level; daily OT is never double-counted).
   Money: integer cents, server-side. Break timestamps are ISO strings.
   ============================================================================ */

const CLOCK_CA_DEFAULTS = {
  meal_break_min: 30,
  meal_due_by_hour: 5,
  second_meal_due_by_hour: 10,
  meal_waivable_max_shift_h: 6,
  second_meal_waivable_max_shift_h: 12,
  rest_break_min: 10,
  rest_per_hours: 4,
  rest_major_fraction_h: 2,
  rest_min_shift_h: 3.5,
  premium_hours: 1,
  ot_daily_h: 8,
  ot_double_h: 12,
  ot_weekly_h: 40,
};

/** Effective clock config: CA defaults overlaid with site_config `clock_*`. */
function clockConfig() {
  const cfg = { ...CLOCK_CA_DEFAULTS };
  for (const r of db.prepare("SELECT key, value FROM site_config WHERE site_id = ? AND key LIKE 'clock_%'").all(SITE_ID)) {
    const k = r.key.slice(6);
    if (k in cfg) {
      const n = parseFloat(r.value);
      if (Number.isFinite(n) && n >= 0) cfg[k] = n;
    }
  }
  return cfg;
}

function auditClock(req, action, shiftId, details) {
  db.prepare('INSERT INTO clock_audit (site_id, actor, action, shift_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(SITE_ID, req.user ? req.user.name : '?', action, shiftId ?? null, JSON.stringify(details || {}), nowIso());
}

const minsBetween = (a, b) => Math.max(0, (new Date(b).getTime() - new Date(a).getTime()) / 60000);
const r2 = (v) => Math.round(v * 100) / 100;

function openShiftFor(userId) {
  return db.prepare("SELECT * FROM clock_shifts WHERE site_id = ? AND user_id = ? AND clock_out IS NULL ORDER BY id DESC LIMIT 1")
    .get(SITE_ID, userId);
}
function shiftById(id) {
  return db.prepare('SELECT * FROM clock_shifts WHERE id = ? AND site_id = ?').get(id, SITE_ID);
}
function breaksFor(shiftId) {
  return db.prepare('SELECT * FROM clock_breaks WHERE shift_id = ? ORDER BY id').all(shiftId);
}

/**
 * Compliance + pay for one shift. `finalized` is true once clocked out —
 * premiums are only assessed on closed shifts (open shifts report due/overdue
 * separately via clockDue()).
 */
function clockCompute(shift, breaks, cfg) {
  const endIso = shift.clock_out || nowIso();
  const h = minsBetween(shift.clock_in, endIso) / 60;
  const rate = shift.regular_rate_cents || 0;
  const finalized = !!shift.clock_out;
  const dueAt = (hours) => new Date(new Date(shift.clock_in).getTime() + hours * 3600 * 1000).toISOString();

  const mealOk = (b) => b.end_at && minsBetween(b.start_at, b.end_at) >= cfg.meal_break_min && b.duty_free === 1;
  const meals = breaks.filter((b) => b.type === 'meal' && !b.waived);
  const waivers = breaks.filter((b) => b.type === 'meal' && b.waived);

  const need1 = h > cfg.meal_due_by_hour;
  const need2 = h > cfg.second_meal_due_by_hour;
  const firstTaken = meals.some((b) => (b.meal_seq || 1) === 1 && mealOk(b) && b.start_at <= dueAt(cfg.meal_due_by_hour));
  const secondTaken = meals.some((b) => b.meal_seq === 2 && mealOk(b) && b.start_at <= dueAt(cfg.second_meal_due_by_hour));
  const waive1 = waivers.some((b) => (b.meal_seq || 1) === 1);
  const waive2 = waivers.some((b) => b.meal_seq === 2);
  const meal1ok = !need1 || firstTaken || (waive1 && h <= cfg.meal_waivable_max_shift_h);
  const meal2ok = !need2 || secondTaken || (waive2 && h <= cfg.second_meal_waivable_max_shift_h && firstTaken);

  const restsRequired = h < cfg.rest_min_shift_h ? 0
    : Math.floor(h / cfg.rest_per_hours) + ((h % cfg.rest_per_hours) >= cfg.rest_major_fraction_h ? 1 : 0);
  const restsTaken = breaks.filter((b) => b.type === 'rest' && b.end_at && minsBetween(b.start_at, b.end_at) >= cfg.rest_break_min).length;
  const restsOk = restsTaken >= restsRequired;

  // One premium per violation TYPE per day (missed meal + missed rest stack).
  const violations = [];
  if (finalized) {
    if ((need1 && !meal1ok) || (need2 && !meal2ok)) violations.push('meal');
    if (!restsOk) violations.push('rest');
  }
  const premiumCents = Math.round(violations.length * cfg.premium_hours * rate);

  const regH = Math.min(h, cfg.ot_daily_h);
  const ot15H = Math.min(Math.max(h - cfg.ot_daily_h, 0), cfg.ot_double_h - cfg.ot_daily_h);
  const ot2H = Math.max(h - cfg.ot_double_h, 0);
  const regCents = Math.round(regH * rate);
  const ot15Cents = Math.round(ot15H * rate * 1.5);
  const ot2Cents = Math.round(ot2H * rate * 2);

  return {
    hours: r2(h), finalized, rate_cents: rate,
    mealsRequired: (need1 ? 1 : 0) + (need2 ? 1 : 0), meal1ok, meal2ok,
    restsRequired, restsTaken, restsOk, violations,
    regH: r2(regH), ot15H: r2(ot15H), ot2H: r2(ot2H),
    regCents, ot15Cents, ot2Cents, premiumCents,
    totalCents: regCents + ot15Cents + ot2Cents + premiumCents,
    meal1DueAt: dueAt(cfg.meal_due_by_hour), meal2DueAt: dueAt(cfg.second_meal_due_by_hour),
  };
}

function breakView(b) {
  return {
    id: b.id, uuid: b.uuid, type: b.type, meal_seq: b.meal_seq, start_at: b.start_at, end_at: b.end_at,
    waived: b.waived === 1, duty_free: b.duty_free === 1,
    minutes: b.end_at ? Math.round(minsBetween(b.start_at, b.end_at)) : null,
  };
}

function shiftView(shift, breaks, cfg) {
  const c = clockCompute(shift, breaks, cfg);
  return {
    id: shift.id, uuid: shift.uuid, user_id: shift.user_id, employee_id: shift.employee_id ?? null, employee_name: shift.employee_name, role: shift.role,
    regular_rate_cents: shift.regular_rate_cents, clock_in: shift.clock_in, clock_out: shift.clock_out,
    open: !shift.clock_out,
    hours: c.hours,
    breaks: breaks.map(breakView),
    compliance: {
      meals_required: c.mealsRequired, meal1_ok: c.meal1ok, meal2_ok: c.meal2ok,
      rests_required: c.restsRequired, rests_taken: c.restsTaken, rests_ok: c.restsOk,
      violations: c.violations, finalized: c.finalized,
    },
    pay: {
      reg_hours: c.regH, ot15_hours: c.ot15H, ot2_hours: c.ot2H,
      reg_cents: c.regCents, ot15_cents: c.ot15Cents, ot2_cents: c.ot2Cents,
      premium_cents: c.premiumCents, total_cents: c.totalCents,
    },
  };
}

/** Sunday (site tz) starting the workweek containing `iso`. */
function weekStartSite(iso) {
  const [y, m, d] = tzDate(iso).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  dt.setUTCDate(dt.getUTCDate() - dt.getUTCDay());
  return dt.toISOString().slice(0, 10);
}

/* ------------------------------ employee clock ----------------------------- */

/** POST /api/clock/in — clock yourself in; managers may pass {user_id}. */
app.post('/api/clock/in', (req, res) => {
  let targetId = req.user.id, managerActing = false;
  if (req.body && req.body.user_id != null) {
    if (req.user.role !== 'manager') return res.status(403).json({ error: 'Forbidden: only managers can clock in other employees' });
    targetId = req.body.user_id; managerActing = true;
  }
  const emp = db.prepare('SELECT id, name, role, hourly_rate_cents, COALESCE(active, 1) AS active FROM users WHERE id = ? AND site_id = ?').get(targetId, SITE_ID);
  if (!emp) return res.status(400).json({ error: 'Unknown employee' });
  if (!emp.active) return res.status(403).json({ error: emp.name + ' is deactivated and cannot clock in' });
  if (openShiftFor(emp.id)) return res.status(400).json({ error: emp.name + ' is already clocked in' });
  const empRec = db.prepare('SELECT id, active FROM employees WHERE user_id = ? AND site_id = ?').get(emp.id, SITE_ID);
  if (empRec && empRec.active !== 1) return res.status(403).json({ error: emp.name + ' is deactivated and cannot clock in' });
  const r = db.prepare('INSERT INTO clock_shifts (uuid, site_id, user_id, employee_id, employee_name, role, regular_rate_cents, clock_in, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(crypto.randomUUID(), SITE_ID, emp.id, empRec ? empRec.id : null, emp.name, emp.role, emp.hourly_rate_cents || 0, nowIso(), nowIso());
  if (managerActing) auditClock(req, 'manager_clock_in', r.lastInsertRowid, { user_id: emp.id, employee_name: emp.name });
  const cfg = clockConfig();
  res.status(201).json(shiftView(shiftById(r.lastInsertRowid), [], cfg));
});

/** POST /api/clock/out — clock yourself out; managers may pass {user_id}. */
app.post('/api/clock/out', (req, res) => {
  let targetId = req.user.id, managerActing = false;
  if (req.body && req.body.user_id != null) {
    if (req.user.role !== 'manager') return res.status(403).json({ error: 'Forbidden: only managers can clock out other employees' });
    targetId = req.body.user_id; managerActing = true;
  }
  const shift = openShiftFor(targetId);
  if (!shift) return res.status(400).json({ error: 'No open shift to clock out of' });
  const outIso = nowIso();
  db.prepare('UPDATE clock_shifts SET clock_out = ? WHERE id = ?').run(outIso, shift.id);
  if (managerActing) auditClock(req, 'manager_clock_out', shift.id, { user_id: targetId, employee_name: shift.employee_name });
  const cfg = clockConfig();
  res.json(shiftView(shiftById(shift.id), breaksFor(shift.id), cfg));
});

/** POST /api/clock/break/start {type: meal|rest} */
app.post('/api/clock/break/start', (req, res) => {
  const type = req.body && req.body.type;
  if (type !== 'meal' && type !== 'rest') return res.status(400).json({ error: 'type must be meal or rest' });
  const shift = openShiftFor(req.user.id);
  if (!shift) return res.status(400).json({ error: 'Clock in before starting a break' });
  const existing = breaksFor(shift.id).filter((b) => !b.waived);
  if (existing.some((b) => b.type === type && !b.end_at)) {
    return res.status(400).json({ error: 'A ' + type + ' break is already in progress' });
  }
  const mealSeq = type === 'meal' ? existing.filter((b) => b.type === 'meal').length + 1 : null;
  const r = db.prepare("INSERT INTO clock_breaks (uuid, shift_id, type, meal_seq, start_at, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(crypto.randomUUID(), shift.id, type, mealSeq, nowIso(), nowIso());
  res.status(201).json(breakView(db.prepare('SELECT * FROM clock_breaks WHERE id = ?').get(r.lastInsertRowid)));
});

/** POST /api/clock/break/end {type: meal|rest, duty_free} — meal end REQUIRES
    the duty-free attestation (employee confirms fully relieved of duty). */
app.post('/api/clock/break/end', (req, res) => {
  const type = req.body && req.body.type;
  if (type !== 'meal' && type !== 'rest') return res.status(400).json({ error: 'type must be meal or rest' });
  const shift = openShiftFor(req.user.id);
  if (!shift) return res.status(400).json({ error: 'No open shift' });
  const b = breaksFor(shift.id).find((x) => x.type === type && !x.end_at && !x.waived);
  if (!b) return res.status(400).json({ error: 'No ' + type + ' break in progress' });
  let dutyFree = 0;
  if (type === 'meal') {
    const att = req.body && req.body.duty_free;
    if (att !== true && att !== 1 && att !== '1') {
      return res.status(400).json({ error: 'Meal break end requires the duty-free attestation (fully relieved of duty)' });
    }
    dutyFree = 1;
  }
  db.prepare('UPDATE clock_breaks SET end_at = ?, duty_free = ? WHERE id = ?').run(nowIso(), dutyFree, b.id);
  res.json(breakView(db.prepare('SELECT * FROM clock_breaks WHERE id = ?').get(b.id)));
});

/** POST /api/clock/break/waive {type: 'meal', meal_seq: 1|2} — statutory meal
    waivers only (first if shift <= 6h, second if <= 12h and first taken).
    Eligibility is re-checked at clock-out; an ineligible waiver is ignored. */
app.post('/api/clock/break/waive', (req, res) => {
  const seq = req.body && req.body.meal_seq;
  if ((req.body && req.body.type) !== 'meal' || (seq !== 1 && seq !== 2)) {
    return res.status(400).json({ error: 'Only meal breaks can be waived; meal_seq must be 1 or 2' });
  }
  const shift = openShiftFor(req.user.id);
  if (!shift) return res.status(400).json({ error: 'No open shift' });
  const existing = breaksFor(shift.id);
  if (existing.some((b) => b.type === 'meal' && b.waived && (b.meal_seq || 1) === seq)) {
    return res.status(400).json({ error: 'That meal break is already waived' });
  }
  if (existing.some((b) => b.type === 'meal' && !b.waived && (b.meal_seq || 1) === seq)) {
    return res.status(400).json({ error: 'That meal break was already taken — it cannot be waived' });
  }
  const r = db.prepare("INSERT INTO clock_breaks (uuid, shift_id, type, meal_seq, waived, created_at) VALUES (?, ?, 'meal', ?, 1, ?)")
    .run(crypto.randomUUID(), shift.id, seq, nowIso());
  res.status(201).json(breakView(db.prepare('SELECT * FROM clock_breaks WHERE id = ?').get(r.lastInsertRowid)));
});

/** GET /api/clock/status — my current shift + which breaks are due/overdue. */
app.get('/api/clock/status', (req, res) => {
  const shift = openShiftFor(req.user.id);
  if (!shift) return res.json({ clocked_in: false });
  const cfg = clockConfig();
  const breaks = breaksFor(shift.id);
  const view = shiftView(shift, breaks, cfg);
  const nowMs = Date.now();
  const inMs = new Date(shift.clock_in).getTime();
  const elapsedH = (nowMs - inMs) / 3600000;
  const taken = (seq) => breaks.some((b) => b.type === 'meal' && !b.waived && (b.meal_seq || 1) === seq && b.end_at && b.duty_free === 1);
  const waived = (seq) => breaks.some((b) => b.type === 'meal' && b.waived && (b.meal_seq || 1) === seq);
  const inProg = (t) => breaks.some((b) => b.type === t && !b.end_at && !b.waived);
  const due = [];
  const mealState = (seq, dueHour) => {
    const dueAt = new Date(inMs + dueHour * 3600 * 1000).toISOString();
    if (taken(seq)) return { kind: 'meal', seq, state: 'taken', due_at: dueAt };
    if (waived(seq)) return { kind: 'meal', seq, state: 'waived', due_at: dueAt };
    if (inProg('meal')) return { kind: 'meal', seq, state: 'in_progress', due_at: dueAt };
    if (nowMs > inMs + dueHour * 3600 * 1000) return { kind: 'meal', seq, state: 'overdue', due_at: dueAt };
    if (nowMs > inMs + (dueHour - 0.5) * 3600 * 1000) return { kind: 'meal', seq, state: 'due', due_at: dueAt };
    return { kind: 'meal', seq, state: 'upcoming', due_at: dueAt };
  };
  due.push(mealState(1, cfg.meal_due_by_hour));
  if (elapsedH > cfg.meal_due_by_hour + 3 || breaks.some((b) => b.type === 'meal' && (b.meal_seq || 1) === 2)) {
    due.push(mealState(2, cfg.second_meal_due_by_hour));
  }
  const restsReq = elapsedH < cfg.rest_min_shift_h ? 0
    : Math.floor(elapsedH / cfg.rest_per_hours) + ((elapsedH % cfg.rest_per_hours) >= cfg.rest_major_fraction_h ? 1 : 0);
  const restsTaken = breaks.filter((b) => b.type === 'rest' && b.end_at && minsBetween(b.start_at, b.end_at) >= cfg.rest_break_min).length;
  due.push({
    kind: 'rest', state: inProg('rest') ? 'in_progress' : (restsTaken >= restsReq ? 'ok' : (restsReq > 0 ? 'due' : 'upcoming')),
    required: restsReq, taken: restsTaken, due_at: null,
  });
  view.due = due;
  view.elapsed_h = r2(elapsedH);
  res.json(view);
});

/* --------------------------- manager time clock ---------------------------- */

/** Day labor rollup (closed shifts finalized; open shifts counted elapsed-so-far). */
function dayLabor(dateStr) {
  const cfg = clockConfig();
  const shifts = db.prepare('SELECT * FROM clock_shifts WHERE site_id = ?').all(SITE_ID)
    .filter((s) => tzDate(s.clock_in) === dateStr);
  let reg = 0, ot = 0, premium = 0, total = 0;
  const views = [];
  for (const s of shifts) {
    const v = shiftView(s, breaksFor(s.id), cfg);
    views.push(v);
    reg += v.pay.reg_cents; ot += v.pay.ot15_cents + v.pay.ot2_cents;
    premium += v.pay.premium_cents; total += v.pay.total_cents;
  }
  // Weekly OT: per user, hours beyond 40h/week (Sun-Sat, site tz) not already
  // counted as daily OT convert to 1.5x.
  const ws = weekStartSite(dateStr + 'T12:00:00Z');
  const weekly = [];
  const byUser = new Map();
  for (const s of db.prepare('SELECT * FROM clock_shifts WHERE site_id = ?').all(SITE_ID)) {
    if (weekStartSite(s.clock_in) !== ws) continue;
    if (!byUser.has(s.user_id)) byUser.set(s.user_id, []);
    byUser.get(s.user_id).push(s);
  }
  let weeklyOtCents = 0;
  for (const [uid, wshifts] of byUser) {
    let wh = 0, dot = 0, payAt1x = 0;
    for (const s of wshifts) {
      const v = shiftView(s, breaksFor(s.id), cfg);
      wh += v.hours; dot += v.pay.ot15_hours + v.pay.ot2_hours;
      // Hours already paid at 1x contribute to a weighted-average rate so the
      // weekly premium lands on the right base when rates vary mid-week.
      payAt1x += v.pay.reg_cents + v.pay.ot15_cents / 1.5 + v.pay.ot2_cents / 2;
    }
    const extra = Math.max(0, wh - cfg.ot_weekly_h - dot);
    const avgRate = wh > 0.005 ? payAt1x / wh : 0;
    if (extra > 0.005 && avgRate > 0) {
      // These hours already earned 1x in the daily rollup; the weekly premium
      // is the additional 0.5x that brings them to 1.5x total (never 2.5x).
      const pay = Math.round(extra * avgRate * 0.5);
      weeklyOtCents += pay;
      const nm = wshifts[0].employee_name;
      weekly.push({ user_id: uid, employee_name: nm, week_hours: r2(wh), extra_ot15_hours: r2(extra), extra_ot15_cents: pay });
    }
  }
  total += weeklyOtCents;
  return { views, summary: { reg_cents: reg, ot_cents: ot, premium_cents: premium, weekly_ot_cents: weeklyOtCents, total_cents: total }, weekly };
}

/** GET /api/admin/clock/shifts?date=YYYY-MM-DD — manager: all shifts, breaks,
    compliance, premiums, OT, and the day labor rollup. */
app.get('/api/admin/clock/shifts', managerOnly(), (req, res) => {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : todaySite();
  const { views, summary, weekly } = dayLabor(date);
  const onShift = db.prepare("SELECT id, employee_name, role, clock_in FROM clock_shifts WHERE site_id = ? AND clock_out IS NULL").all(SITE_ID);
  const violations = views.filter((v) => v.compliance.violations.length)
    .map((v) => ({ shift_id: v.id, employee_name: v.employee_name, violations: v.compliance.violations, premium_cents: v.pay.premium_cents }));
  res.json({ date, on_shift: onShift, shifts: views, labor: summary, weekly_ot: weekly, violations });
});

/** POST /api/admin/clock/adjust — manager correction (audit-logged).
 *  Adjusts clock_in/clock_out/rate AND break start/end times; pay recomputes
 *  from the adjusted times on read. A manager PIN is REQUIRED for every
 *  adjustment — the manager physically enters their PIN at the device and
 *  there is no adjustment path without it. The correction lands in the
 *  approval_audit table (same as voids/comps) with before/after + approver. */
app.post('/api/admin/clock/adjust', managerOnly(), (req, res) => {
  const b = req.body || {};
  // Point-of-action approval FIRST: a valid session alone is NOT enough — the
  // manager must enter their PIN at the device for every adjustment. Checked
  // before anything else so no information leaks without approval either.
  if (managerPinThrottled(req)) {
    return res.status(429).json({ error: 'Too many failed manager-PIN attempts — please wait a few minutes' });
  }
  const mgr = verifyManagerPin(b.manager_pin);
  if (!mgr) { recordManagerPinAttempt(req, false); return res.status(403).json({ error: 'Manager PIN required for time-clock adjustments' }); }
  recordManagerPinAttempt(req, true);
  const shift = b.shift_id != null ? shiftById(b.shift_id) : null;
  if (!shift) return res.status(400).json({ error: 'Unknown shift_id' });
  const approver = mgr.name;
  const patch = {};
  if (b.clock_in !== undefined) {
    if (isNaN(new Date(b.clock_in).getTime())) return res.status(400).json({ error: 'clock_in must be an ISO timestamp' });
    patch.clock_in = new Date(b.clock_in).toISOString();
  }
  if (b.clock_out !== undefined) {
    if (b.clock_out !== null && isNaN(new Date(b.clock_out).getTime())) return res.status(400).json({ error: 'clock_out must be an ISO timestamp or null' });
    patch.clock_out = b.clock_out === null ? null : new Date(b.clock_out).toISOString();
  }
  const ci = patch.clock_in !== undefined ? patch.clock_in : shift.clock_in;
  const co = patch.clock_out !== undefined ? patch.clock_out : shift.clock_out;
  if (ci && co && new Date(co) <= new Date(ci)) return res.status(400).json({ error: 'clock_out must be after clock_in' });
  if (b.regular_rate_cents !== undefined) {
    if (!isInt(b.regular_rate_cents) || b.regular_rate_cents < 0) return res.status(400).json({ error: 'regular_rate_cents must be a whole number of cents ≥ 0' });
    patch.regular_rate_cents = b.regular_rate_cents;
  }
  // Break-time correction: {break_id, start_at?, end_at?} — the break must
  // belong to this shift; times stay inside the shift window.
  let breakPatch = null;
  if (b.break_id !== undefined) {
    const brk = db.prepare('SELECT * FROM clock_breaks WHERE id = ? AND shift_id = ?').get(b.break_id, shift.id);
    if (!brk) return res.status(400).json({ error: 'Unknown break_id for this shift' });
    breakPatch = { id: brk.id, before: { start_at: brk.start_at, end_at: brk.end_at } };
    const bs = {}, bsets = [];
    if (b.start_at !== undefined) {
      if (isNaN(new Date(b.start_at).getTime())) return res.status(400).json({ error: 'start_at must be an ISO timestamp' });
      bs.start_at = new Date(b.start_at).toISOString(); bsets.push('start_at = ?');
    }
    if (b.end_at !== undefined) {
      if (b.end_at !== null && isNaN(new Date(b.end_at).getTime())) return res.status(400).json({ error: 'end_at must be an ISO timestamp or null' });
      bs.end_at = b.end_at === null ? null : new Date(b.end_at).toISOString(); bsets.push('end_at = ?');
    }
    const nbs = bs.start_at !== undefined ? bs.start_at : brk.start_at;
    const nbe = bs.end_at !== undefined ? bs.end_at : brk.end_at;
    if (nbs && nbe && new Date(nbe) <= new Date(nbs)) return res.status(400).json({ error: 'break end_at must be after start_at' });
    if (!bsets.length) return res.status(400).json({ error: 'Nothing to adjust on the break' });
    db.prepare('UPDATE clock_breaks SET ' + bsets.join(', ') + ' WHERE id = ?').run(...Object.values(bs), brk.id);
    breakPatch.after = { start_at: nbs, end_at: nbe };
  }
  if (!Object.keys(patch).length && !breakPatch) return res.status(400).json({ error: 'Nothing to adjust' });
  const before = { clock_in: shift.clock_in, clock_out: shift.clock_out, regular_rate_cents: shift.regular_rate_cents };
  if (Object.keys(patch).length) {
    const sets = Object.keys(patch).map((k) => k + ' = ?').join(', ');
    db.prepare('UPDATE clock_shifts SET ' + sets + ' WHERE id = ?').run(...Object.values(patch), shift.id);
  }
  const approvalDetails = { approver, approver_id: mgr.id, before, after: patch };
  if (breakPatch) approvalDetails.break = breakPatch;
  // Canonical audit: time adjustments live in approval_audit alongside
  // voids/comps (actor, action, before/after, timestamp). The shift-timeline
  // row in clock_audit is kept as well for the clock history view.
  auditApproval(req, 'adjust', { shift_id: shift.id }, approvalDetails);
  auditClock(req, 'adjust', shift.id, approvalDetails);
  const cfg = clockConfig();
  res.json(shiftView(shiftById(shift.id), breaksFor(shift.id), cfg));
});

/** GET /api/admin/clock/config — resolved CA-rule config (defaults + overrides). */
app.get('/api/admin/clock/config', managerOnly(), (req, res) => {
  const overrides = {};
  for (const r of db.prepare("SELECT key, value FROM site_config WHERE site_id = ? AND key LIKE 'clock_%'").all(SITE_ID)) {
    overrides[r.key.slice(6)] = r.value;
  }
  res.json({ defaults: CLOCK_CA_DEFAULTS, overrides, effective: clockConfig() });
});

/** PUT /api/admin/clock/config {key, value} — tune a threshold (audit-logged). */
app.put('/api/admin/clock/config', managerOnly(), (req, res) => {
  const { key, value } = req.body || {};
  if (!(key in CLOCK_CA_DEFAULTS)) return res.status(400).json({ error: 'Unknown clock config key' });
  const n = parseFloat(value);
  if (!Number.isFinite(n) || n < 0) return res.status(400).json({ error: 'value must be a number ≥ 0' });
  db.prepare('INSERT INTO site_config (site_id, key, value) VALUES (?, ?, ?) ON CONFLICT(site_id, key) DO UPDATE SET value = excluded.value')
    .run(SITE_ID, 'clock_' + key, String(n));
  auditClock(req, 'config_change', null, { key, value: n });
  res.json({ key, value: n, effective: clockConfig() });
});

/** GET /api/admin/clock/users — team list with hourly rates (for the manager UI). */
app.get('/api/admin/clock/users', managerOnly(), (req, res) => {
  res.json(db.prepare('SELECT id, name, role, hourly_rate_cents FROM users WHERE site_id = ? ORDER BY role, name').all(SITE_ID));
});

/** PUT /api/admin/clock/users/:id/rate {hourly_rate_cents} — set pay rate (audit-logged). */
app.put('/api/admin/clock/users/:id/rate', managerOnly(), (req, res) => {
  const u = db.prepare('SELECT id, name, role, hourly_rate_cents FROM users WHERE id = ? AND site_id = ?').get(req.params.id, SITE_ID);
  if (!u) return res.status(400).json({ error: 'Unknown user' });
  const v = req.body && req.body.hourly_rate_cents;
  if (!isInt(v) || v < 0) return res.status(400).json({ error: 'hourly_rate_cents must be a whole number of cents ≥ 0' });
  db.prepare('UPDATE users SET hourly_rate_cents = ? WHERE id = ?').run(v, u.id);
  auditClock(req, 'rate_change', null, { user_id: u.id, employee_name: u.name, before: u.hourly_rate_cents, after: v });
  res.json({ id: u.id, name: u.name, role: u.role, hourly_rate_cents: v });
});

/** GET /api/admin/clock/audit?limit= — who changed what, when. */
app.get('/api/admin/clock/audit', managerOnly(), (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit || '100', 10) || 100, 1), 500);
  res.json(db.prepare('SELECT id, actor, action, shift_id, details, created_at FROM clock_audit WHERE site_id = ? ORDER BY id DESC LIMIT ?').all(SITE_ID, limit));
});

/* ------------------------- employee records (phase 2) ------------------------ */
/** Manager-only staff management. employees is the canonical record; the
 *  users row stays in sync so PIN login keeps working. DELETE is a soft
 *  deactivation (payroll history must survive) and can never remove the
 *  last active manager. PINs are never returned by these endpoints. */
function employeeView(e) {
  return {
    id: e.id, employee_number: e.employee_number, name: e.name, role: e.role,
    wage_rate_cents: e.wage_rate_cents, active: e.active === 1, created_at: e.created_at,
  };
}
function nextEmployeeNumber() {
  const r = db.prepare('SELECT MAX(employee_number) AS m FROM employees WHERE site_id = ?').get(SITE_ID);
  return Math.max(101, (r && r.m != null ? r.m : 100) + 1);
}
const EMP_ROLES = new Set(['server', 'kitchen', 'manager']);
function validEmployeePin(p) { return typeof p === 'string' && /^\d{4}$/.test(p); }
function employeeById(id) {
  return db.prepare('SELECT * FROM employees WHERE id = ? AND site_id = ?').get(id, SITE_ID);
}

app.get('/api/admin/employees', managerOnly(), (req, res) => {
  let sql = 'SELECT * FROM employees WHERE site_id = ?';
  const params = [SITE_ID];
  if (req.query.active === '1') { sql += ' AND active = 1'; }
  else if (req.query.active === '0') { sql += ' AND active = 0'; }
  sql += ' ORDER BY employee_number, id';
  res.json(db.prepare(sql).all(...params).map(employeeView));
});

app.get('/api/admin/employees/next-number', managerOnly(), (req, res) => {
  res.json({ employee_number: nextEmployeeNumber() });
});

app.post('/api/admin/employees', managerOnly(), (req, res) => {
  const b = req.body || {};
  const name = cleanLabel(b.name);
  if (!name) return res.status(400).json({ error: 'name is required' });
  const role = typeof b.role === 'string' ? b.role.trim().toLowerCase() : '';
  if (!EMP_ROLES.has(role)) return res.status(400).json({ error: 'role must be server, kitchen, or manager' });
  const pin = b.pin != null ? String(b.pin) : '';
  if (!validEmployeePin(pin)) return res.status(400).json({ error: 'pin must be 4 digits' });
  if (db.prepare('SELECT id FROM users WHERE pin = ? AND site_id = ?').get(pin, SITE_ID)) {
    return res.status(400).json({ error: 'PIN is already in use' });
  }
  let number = b.employee_number;
  if (number === undefined || number === null || number === '') number = nextEmployeeNumber();
  number = Number(number);
  if (!isInt(number) || number <= 0) return res.status(400).json({ error: 'employee_number must be a positive integer' });
  if (db.prepare('SELECT id FROM employees WHERE employee_number = ? AND site_id = ?').get(number, SITE_ID)) {
    return res.status(400).json({ error: 'Employee number is already in use' });
  }
  const wage = b.wage_rate_cents === undefined ? 0 : b.wage_rate_cents;
  if (!isInt(wage) || wage < 0) return res.status(400).json({ error: 'wage_rate_cents must be a whole number of cents ≥ 0' });
  try {
    db.exec('BEGIN');
    const u = db.prepare('INSERT INTO users (site_id, name, role, pin, hourly_rate_cents, active) VALUES (?, ?, ?, ?, ?, 1)')
      .run(SITE_ID, name, role, pin, wage);
    const e = db.prepare('INSERT INTO employees (site_id, employee_number, user_id, name, role, pin, wage_rate_cents, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)')
      .run(SITE_ID, number, u.lastInsertRowid, name, role, pin, wage, new Date().toISOString());
    db.exec('COMMIT');
    auditApproval(req, 'employee.create', {}, { employee_id: e.lastInsertRowid, after: { name, role, employee_number: number, wage_rate_cents: wage } });
    res.status(201).json(employeeView(employeeById(e.lastInsertRowid)));
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    return res.status(400).json({ error: 'Could not create employee: ' + (err.message || 'constraint failed') });
  }
});

app.put('/api/admin/employees/:id', managerOnly(), (req, res) => {
  const emp = employeeById(req.params.id);
  if (!emp) return res.status(404).json({ error: 'Employee not found' });
  const b = req.body || {};
  const patch = {}, userPatch = {};
  if (b.name !== undefined) {
    const name = cleanLabel(b.name);
    if (!name) return res.status(400).json({ error: 'name cannot be blank' });
    patch.name = name; userPatch.name = name;
  }
  if (b.role !== undefined) {
    const role = String(b.role).trim().toLowerCase();
    if (!EMP_ROLES.has(role)) return res.status(400).json({ error: 'role must be server, kitchen, or manager' });
    if (emp.role === 'manager' && role !== 'manager') {
      const others = db.prepare("SELECT COUNT(*) AS n FROM employees WHERE site_id = ? AND role = 'manager' AND active = 1 AND id != ?").get(SITE_ID, emp.id).n;
      if (!others) return res.status(400).json({ error: 'Cannot demote the last active manager' });
    }
    patch.role = role; userPatch.role = role;
  }
  if (b.pin !== undefined) {
    const pin = String(b.pin);
    if (!validEmployeePin(pin)) return res.status(400).json({ error: 'pin must be 4 digits' });
    const clash = db.prepare('SELECT id FROM users WHERE pin = ? AND site_id = ? AND id != ?').get(pin, SITE_ID, emp.user_id);
    if (clash) return res.status(400).json({ error: 'PIN is already in use' });
    patch.pin = pin; userPatch.pin = pin;
  }
  if (b.employee_number !== undefined) {
    const number = Number(b.employee_number);
    if (!isInt(number) || number <= 0) return res.status(400).json({ error: 'employee_number must be a positive integer' });
    const clash = db.prepare('SELECT id FROM employees WHERE employee_number = ? AND site_id = ? AND id != ?').get(number, SITE_ID, emp.id);
    if (clash) return res.status(400).json({ error: 'Employee number is already in use' });
    patch.employee_number = number;
  }
  if (b.wage_rate_cents !== undefined) {
    if (!isInt(b.wage_rate_cents) || b.wage_rate_cents < 0) return res.status(400).json({ error: 'wage_rate_cents must be a whole number of cents ≥ 0' });
    patch.wage_rate_cents = b.wage_rate_cents; userPatch.hourly_rate_cents = b.wage_rate_cents;
  }
  if (b.active !== undefined) {
    const active = b.active ? 1 : 0;
    if (!active && emp.role === 'manager') {
      const others = db.prepare("SELECT COUNT(*) AS n FROM employees WHERE site_id = ? AND role = 'manager' AND active = 1 AND id != ?").get(SITE_ID, emp.id).n;
      if (!others) return res.status(400).json({ error: 'Cannot deactivate the last active manager' });
    }
    patch.active = active; userPatch.active = active;
  }
  if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to update' });
  const before = employeeView(emp);
  try {
    db.exec('BEGIN');
    db.prepare('UPDATE employees SET ' + Object.keys(patch).map((k) => k + ' = ?').join(', ') + ' WHERE id = ?')
      .run(...Object.values(patch), emp.id);
    if (Object.keys(userPatch).length && emp.user_id) {
      db.prepare('UPDATE users SET ' + Object.keys(userPatch).map((k) => k + ' = ?').join(', ') + ' WHERE id = ?')
        .run(...Object.values(userPatch), emp.user_id);
    }
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* noop */ }
    return res.status(400).json({ error: 'Could not update employee: ' + (err.message || 'constraint failed') });
  }
  const after = employeeView(employeeById(emp.id));
  auditApproval(req, 'employee.update', {}, { employee_id: emp.id, before, after });
  res.json(after);
});

/** DELETE deactivates (never hard-deletes — payroll history must survive). */
app.delete('/api/admin/employees/:id', managerOnly(), (req, res) => {
  const emp = employeeById(req.params.id);
  if (!emp) return res.status(404).json({ error: 'Employee not found' });
  if (emp.role === 'manager') {
    const others = db.prepare("SELECT COUNT(*) AS n FROM employees WHERE site_id = ? AND role = 'manager' AND active = 1 AND id != ?").get(SITE_ID, emp.id).n;
    if (!others) return res.status(400).json({ error: 'Cannot deactivate the last active manager' });
  }
  const before = employeeView(emp);
  db.prepare('UPDATE employees SET active = 0 WHERE id = ?').run(emp.id);
  if (emp.user_id) db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(emp.user_id);
  auditApproval(req, 'employee.deactivate', {}, { employee_id: emp.id, before, after: { ...before, active: false } });
  res.json({ id: emp.id, active: false });
});

/** GET /api/admin/approvals/audit?limit= — every manager approval, who/when/what. */
app.get('/api/admin/approvals/audit', managerOnly(), (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit || '100', 10) || 100, 1), 500);
  res.json(db.prepare('SELECT id, actor, approver, action, check_id, item_id, shift_id, before_json, after_json, details, created_at FROM approval_audit WHERE site_id = ? ORDER BY id DESC LIMIT ?').all(SITE_ID, limit));
});

/* --------------------- reservations + waitlist ----------------------
   Native reservations + waitlist, deeply integrated with the floor plan.
   Differentiators vs Toast/TouchBistro:
   - /api/floor/availability returns every table with its live slot status
     (free / occupied / booked) plus x/y/shape/zone — the floor plan IS the
     availability view.
   - Smart best-fit table suggestion in ONE query (no N+1).
   - One-tap seat: waitlist entry or reservation -> open check on the table.
   - Server-side overlap prevention; per-phone no-show history surfaced on
     every booking. */
const RESV_STATUSES = new Set(['booked', 'seated', 'cancelled', 'no_show', 'completed']);
const WL_STATUSES = new Set(['waiting', 'notified', 'seated', 'left', 'cancelled']);

const cleanPhone = (p) => (typeof p === 'string' ? p.replace(/\D/g, '') : '');
const parseSlot = (s) => {
  if (typeof s !== 'string' || !s.trim()) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
};

function resvById(id) {
  return db.prepare('SELECT * FROM reservations WHERE id = ? AND site_id = ?').get(id, SITE_ID);
}
function wlById(id) {
  return db.prepare('SELECT * FROM waitlist WHERE id = ? AND site_id = ?').get(id, SITE_ID);
}
function tableById(id) {
  if (id == null) return undefined; // untrusted callers may omit table_id; never let undefined reach sqlite
  return db.prepare('SELECT id, label, seats, zone_id, x, y, shape FROM tables WHERE id = ? AND site_id = ?').get(id, SITE_ID);
}

/** No-show history for a phone number (digits-normalized). Shown on repeat bookings. */
function noShowCount(phone) {
  const p = cleanPhone(phone);
  if (!p) return 0;
  return db.prepare("SELECT COUNT(*) AS c FROM reservations WHERE site_id = ? AND phone = ? AND status = 'no_show'").get(SITE_ID, p).c;
}

/** Overlap guard: active reservation on table whose [reserved_at, +duration) hits [startMs, endMs).
    Epoch comparison via strftime avoids ISO 'T' vs SQLite ' ' format pitfalls. */
function resvOverlap(tableId, startMs, endMs, excludeId) {
  return db.prepare(
    `SELECT id FROM reservations
     WHERE site_id = ? AND table_id = ? AND status IN ('booked','seated')
       AND id != COALESCE(?, -1)
       AND strftime('%s', reserved_at) < strftime('%s', ?)
       AND strftime('%s', reserved_at, '+' || duration_min || ' minutes') > strftime('%s', ?)
     LIMIT 1`
  ).get(SITE_ID, tableId, excludeId ?? null, new Date(endMs).toISOString(), new Date(startMs).toISOString()) || null;
}

/** Open a check on a table (shared by reservation-arrive + waitlist-seat). */
function openCheckOnTable(tableId, guestCount, tabName, serverId) {
  const table = tableById(tableId);
  if (!table) return { error: 'Valid table_id is required' };
  if (!isInt(guestCount) || guestCount < 1) return { error: 'guest_count must be a positive integer' };
  const existing = db.prepare("SELECT id FROM checks WHERE table_id = ? AND status = 'open' LIMIT 1").get(tableId);
  if (existing) return { error: 'Table already has an open check', check_id: existing.id };
  const r = db.prepare(
    "INSERT INTO checks (uuid, site_id, table_id, server_id, tab_name, guest_count, status, opened_at) VALUES (?, ?, ?, ?, ?, ?, 'open', ?)"
  ).run(crypto.randomUUID(), SITE_ID, tableId, serverId, tabName || null, guestCount, nowIso());
  const check = checkResponse(r.lastInsertRowid);
  broadcastCheckUpdated(check.id);
  return { check };
}

/** Push {type:'resv_updated'} to 'reservations' channel subscribers. */
function broadcastResvUpdated() {
  for (const ws of wss.clients) {
    if ((ws.subs || []).some((s) => s.channel === 'reservations')) {
      wsSend(ws, { type: 'resv_updated' });
    }
  }
}

/* Site-local day helpers (America/Los_Angeles for the Bali Hai pilot). */
function tzOffsetMs(tz, utcMs) {
  const d = new Date(utcMs);
  const tzDate = new Date(d.toLocaleString('en-US', { timeZone: tz }));
  const utcDate = new Date(d.toLocaleString('en-US', { timeZone: 'UTC' }));
  return tzDate.getTime() - utcDate.getTime();
}
function siteTodayStr() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: SITE_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function siteDayBounds(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) return null;
  const naiveUtc = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const off = tzOffsetMs(SITE_TZ, naiveUtc + 12 * 3600e3);
  const startMs = naiveUtc - off;
  return [new Date(startMs).toISOString(), new Date(startMs + 86400000).toISOString()];
}

function resvView(r) {
  const t = r.table_id != null ? tableById(r.table_id) : null;
  return {
    id: r.id, uuid: r.uuid, customer_name: r.customer_name, phone: r.phone,
    party_size: r.party_size, reserved_at: r.reserved_at, duration_min: r.duration_min,
    table_id: r.table_id, table_label: t ? t.label : null, status: r.status,
    notes: r.notes, created_by: r.created_by, created_at: r.created_at,
    no_show_count: noShowCount(r.phone),
  };
}

app.post('/api/reservations', serverPlus(), (req, res) => {
  const b = req.body || {};
  const name = cleanLabel(b.customer_name);
  if (!name) return res.status(400).json({ error: 'customer_name is required' });
  if (!isInt(b.party_size) || b.party_size < 1 || b.party_size > 24)
    return res.status(400).json({ error: 'party_size must be a whole number from 1 to 24' });
  const startMs = parseSlot(b.reserved_at);
  if (startMs == null) return res.status(400).json({ error: 'reserved_at must be a valid ISO datetime' });
  if (startMs < Date.now() - 2 * 3600e3)
    return res.status(400).json({ error: 'reserved_at is too far in the past' });
  const duration = b.duration_min == null ? 90 : b.duration_min;
  if (!isInt(duration) || duration < 15 || duration > 480)
    return res.status(400).json({ error: 'duration_min must be 15–480' });
  let tableId = null;
  if (b.table_id != null) {
    const t = tableById(b.table_id);
    if (!t) return res.status(400).json({ error: 'Valid table_id is required' });
    tableId = t.id;
    const clash = resvOverlap(tableId, startMs, startMs + duration * 60000, null);
    if (clash) return res.status(409).json({ error: 'Table is already booked for that time', conflicting_reservation_id: clash.id });
  }
  const phone = cleanPhone(b.phone);
  const r = db.prepare(
    `INSERT INTO reservations (uuid, site_id, customer_name, phone, party_size, reserved_at, duration_min,
       table_id, status, notes, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'booked', ?, ?, ?)`
  ).run(crypto.randomUUID(), SITE_ID, name, phone || null, b.party_size,
    new Date(startMs).toISOString(), duration, tableId,
    cleanLabel(b.notes) || null, req.user.name, nowIso());
  broadcastResvUpdated();
  res.status(201).json(resvView(resvById(r.lastInsertRowid)));
});

app.get('/api/reservations', serverPlus(), (req, res) => {
  let date = req.query.date;
  if (date == null || date === '') date = siteTodayStr();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  const bounds = siteDayBounds(date);
  if (!bounds) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  const rows = db.prepare(
    `SELECT * FROM reservations WHERE site_id = ? AND reserved_at >= ? AND reserved_at < ?
     ORDER BY reserved_at`
  ).all(SITE_ID, bounds[0], bounds[1]);
  res.json(rows.map(resvView));
});

/** PATCH: change status (booked→seated one-tap opens the check; no_show is
    manager-only and audited) or reassign table (overlap-checked). */
app.patch('/api/reservations/:id', serverPlus(), (req, res) => {
  const r = resvById(req.params.id);
  if (!r) return res.status(404).json({ error: 'Reservation not found' });
  const b = req.body || {};
  const before = { status: r.status, table_id: r.table_id };

  let tableId = r.table_id;
  if (b.table_id !== undefined) {
    if (b.table_id == null) {
      tableId = null;
    } else {
      const t = tableById(b.table_id);
      if (!t) return res.status(400).json({ error: 'Valid table_id is required' });
      tableId = t.id;
    }
  }
  if (b.status !== undefined && !RESV_STATUSES.has(b.status))
    return res.status(400).json({ error: 'Invalid status' });
  const newStatus = b.status !== undefined ? b.status : r.status;

  if (['cancelled', 'no_show', 'completed'].includes(r.status) && newStatus !== r.status)
    return res.status(400).json({ error: `Reservation is already ${r.status}` });
  if (newStatus === 'no_show' && req.user.role !== 'manager')
    return res.status(403).json({ error: 'Only managers can mark a no-show' });
  if (newStatus === 'cancelled' && req.user.role !== 'manager')
    return res.status(403).json({ error: 'Only managers can cancel a reservation' });
  if (newStatus === 'seated' && r.status !== 'booked')
    return res.status(400).json({ error: 'Only booked reservations can be seated' });

  // Overlap check whenever the table or the time window matters.
  if (tableId != null && (tableId !== r.table_id || newStatus === 'seated')) {
    const startMs = Date.parse(r.reserved_at);
    const clash = resvOverlap(tableId, startMs, startMs + r.duration_min * 60000, r.id);
    if (clash) return res.status(409).json({ error: 'Table is already booked for that time', conflicting_reservation_id: clash.id });
  }

  let checkId = null;
  if (newStatus === 'seated') {
    if (tableId == null) return res.status(400).json({ error: 'Assign a table to seat this reservation' });
    const opened = openCheckOnTable(tableId, r.party_size, r.customer_name, req.user.id);
    if (opened.error && !opened.check_id)
      return res.status(400).json({ error: opened.error });
    checkId = opened.check ? opened.check.id : opened.check_id; // reuse open check if one exists
  }

  db.prepare('UPDATE reservations SET status = ?, table_id = ? WHERE id = ?')
    .run(newStatus, tableId, r.id);
  if (newStatus === 'no_show' || newStatus === 'cancelled') {
    auditApproval(req, newStatus === 'no_show' ? 'resv_no_show' : 'resv_cancel',
      {}, { reservation_id: r.id, before, after: { status: newStatus, table_id: tableId } });
  }
  broadcastResvUpdated();
  const out = resvView(resvById(r.id));
  if (checkId) out.check_id = checkId;
  res.json(out);
});

/** DELETE cancels a reservation (manager-only, audited). */
app.delete('/api/reservations/:id', managerOnly(), (req, res) => {
  const r = resvById(req.params.id);
  if (!r) return res.status(404).json({ error: 'Reservation not found' });
  if (['cancelled', 'no_show', 'completed'].includes(r.status))
    return res.status(400).json({ error: `Reservation is already ${r.status}` });
  db.prepare("UPDATE reservations SET status = 'cancelled' WHERE id = ?").run(r.id);
  auditApproval(req, 'resv_cancel', {}, { reservation_id: r.id, before: { status: r.status }, after: { status: 'cancelled' } });
  broadcastResvUpdated();
  res.json({ id: r.id, status: 'cancelled' });
});

/* --------------------------------- waitlist -------------------------------- */
function wlView(w) {
  return {
    id: w.id, uuid: w.uuid, customer_name: w.customer_name, phone: w.phone,
    party_size: w.party_size, quoted_wait_min: w.quoted_wait_min, status: w.status,
    notified_at: w.notified_at, created_at: w.created_at,
    no_show_count: noShowCount(w.phone),
  };
}

app.post('/api/waitlist', serverPlus(), (req, res) => {
  const b = req.body || {};
  const name = cleanLabel(b.customer_name);
  if (!name) return res.status(400).json({ error: 'customer_name is required' });
  if (!isInt(b.party_size) || b.party_size < 1 || b.party_size > 24)
    return res.status(400).json({ error: 'party_size must be a whole number from 1 to 24' });
  const quoted = b.quoted_wait_min == null ? null : b.quoted_wait_min;
  if (quoted != null && (!isInt(quoted) || quoted < 0 || quoted > 480))
    return res.status(400).json({ error: 'quoted_wait_min must be 0–480' });
  const phone = cleanPhone(b.phone);
  const r = db.prepare(
    `INSERT INTO waitlist (uuid, site_id, customer_name, phone, party_size, quoted_wait_min, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'waiting', ?)`
  ).run(crypto.randomUUID(), SITE_ID, name, phone || null, b.party_size, quoted, nowIso());
  broadcastResvUpdated();
  res.status(201).json(wlView(wlById(r.lastInsertRowid)));
});

app.get('/api/waitlist', serverPlus(), (req, res) => {
  const rows = db.prepare(
    `SELECT * FROM waitlist WHERE site_id = ? AND status IN ('waiting','notified') ORDER BY created_at`
  ).all(SITE_ID);
  res.json(rows.map(wlView));
});

app.post('/api/waitlist/:id/notify', serverPlus(), (req, res) => {
  const w = wlById(req.params.id);
  if (!w) return res.status(404).json({ error: 'Waitlist entry not found' });
  if (w.status !== 'waiting') return res.status(400).json({ error: `Entry is ${w.status}` });
  db.prepare("UPDATE waitlist SET status = 'notified', notified_at = ? WHERE id = ?").run(nowIso(), w.id);
  broadcastResvUpdated();
  res.json(wlView(wlById(w.id)));
});

/** One-tap seat: waiting/notified entry -> open check on the chosen table. */
app.post('/api/waitlist/:id/seat', serverPlus(), (req, res) => {
  const w = wlById(req.params.id);
  if (!w) return res.status(404).json({ error: 'Waitlist entry not found' });
  if (!['waiting', 'notified'].includes(w.status))
    return res.status(400).json({ error: `Entry is ${w.status}` });
  const t = tableById((req.body || {}).table_id);
  if (!t) return res.status(400).json({ error: 'Valid table_id is required' });
  const opened = openCheckOnTable(t.id, w.party_size, w.customer_name, req.user.id);
  if (opened.error) return res.status(400).json({ error: opened.error, check_id: opened.check_id || null });
  db.prepare("UPDATE waitlist SET status = 'seated' WHERE id = ?").run(w.id);
  broadcastResvUpdated();
  res.json({ entry: wlView(wlById(w.id)), check_id: opened.check.id });
});

app.patch('/api/waitlist/:id', serverPlus(), (req, res) => {
  const w = wlById(req.params.id);
  if (!w) return res.status(404).json({ error: 'Waitlist entry not found' });
  const st = (req.body || {}).status;
  if (!WL_STATUSES.has(st) || st === 'seated')
    return res.status(400).json({ error: "status must be one of: waiting, notified, left, cancelled (use /seat to seat)" });
  db.prepare('UPDATE waitlist SET status = ? WHERE id = ?').run(st, w.id);
  broadcastResvUpdated();
  res.json(wlView(wlById(w.id)));
});

app.delete('/api/waitlist/:id', managerOnly(), (req, res) => {
  const w = wlById(req.params.id);
  if (!w) return res.status(404).json({ error: 'Waitlist entry not found' });
  db.prepare('DELETE FROM waitlist WHERE id = ?').run(w.id);
  auditApproval(req, 'waitlist_delete', {}, { waitlist_id: w.id, name: w.customer_name });
  broadcastResvUpdated();
  res.json({ deleted: w.id });
});

/* ------------------------- floor availability -------------------------
   The floor plan IS the availability view: every table with its live slot
   status, position, shape, and zone — plus best-fit suggestions computed in
   a SINGLE query (no N+1). */
function suggestTables(partySize, startMs, endMs, limit) {
  return db.prepare(
    `SELECT t.id FROM tables t
     WHERE t.site_id = ? AND t.seats >= ?
       AND NOT EXISTS (
         SELECT 1 FROM reservations r
         WHERE r.site_id = ? AND r.table_id = t.id AND r.status IN ('booked','seated')
           AND strftime('%s', r.reserved_at) < strftime('%s', ?)
           AND strftime('%s', r.reserved_at, '+' || r.duration_min || ' minutes') > strftime('%s', ?)
       )
     ORDER BY (t.seats - ?) ASC, t.id ASC
     LIMIT ?`
  ).all(SITE_ID, partySize, SITE_ID, new Date(endMs).toISOString(), new Date(startMs).toISOString(), partySize, limit)
    .map((r) => r.id);
}

app.get('/api/floor/availability', serverPlus(), (req, res) => {
  const startMs = req.query.datetime ? parseSlot(req.query.datetime) : Date.now();
  if (startMs == null) return res.status(400).json({ error: 'datetime must be a valid ISO datetime' });
  const party = req.query.party_size == null ? 2 : parseInt(req.query.party_size, 10);
  if (!isInt(party) || party < 1 || party > 24)
    return res.status(400).json({ error: 'party_size must be 1–24' });
  const dur = req.query.duration_min == null ? 90 : parseInt(req.query.duration_min, 10);
  if (!isInt(dur) || dur < 15 || dur > 480)
    return res.status(400).json({ error: 'duration_min must be 15–480' });
  const endMs = startMs + dur * 60000;

  const tables = db.prepare(
    `SELECT t.id, t.label, t.seats, t.zone_id, z.name AS zone, t.x, t.y, t.shape,
       (SELECT r.id FROM reservations r
        WHERE r.site_id = ? AND r.table_id = t.id AND r.status IN ('booked','seated')
          AND strftime('%s', r.reserved_at) < strftime('%s', ?)
          AND strftime('%s', r.reserved_at, '+' || r.duration_min || ' minutes') > strftime('%s', ?)
        LIMIT 1) AS resv_id,
       (SELECT c.id FROM checks c WHERE c.table_id = t.id AND c.status = 'open' LIMIT 1) AS open_check_id
     FROM tables t LEFT JOIN zones z ON z.id = t.zone_id
     WHERE t.site_id = ?
     ORDER BY z.sort, t.label`
  ).all(SITE_ID, new Date(endMs).toISOString(), new Date(startMs).toISOString(), SITE_ID);

  const resvIds = [...new Set(tables.map((t) => t.resv_id).filter((v) => v != null))];
  const resvMap = new Map();
  if (resvIds.length) {
    const rows = db.prepare(
      `SELECT id, customer_name, party_size, reserved_at, duration_min FROM reservations WHERE id IN (${resvIds.map(() => '?').join(',')})`
    ).all(...resvIds);
    for (const r of rows) resvMap.set(r.id, r);
  }
  const suggested = new Set(suggestTables(party, startMs, endMs, 3));
  res.json({
    datetime: new Date(startMs).toISOString(),
    duration_min: dur,
    party_size: party,
    tables: tables.map((t) => ({
      id: t.id, label: t.label, seats: t.seats, zone_id: t.zone_id, zone: t.zone,
      x: t.x, y: t.y, shape: t.shape,
      open_check_id: t.open_check_id,
      status: t.open_check_id ? 'occupied' : (t.resv_id ? 'booked' : 'free'),
      reservation: t.resv_id ? resvMap.get(t.resv_id) || null : null,
      suggested: suggested.has(t.id),
    })),
  });
});

/* --------------------------- 404 for unknown /api --------------------------- */
/* Feature modules (authenticated — staff token required). Registered after all
   core routes, before the /api 404 catch-all. */
require('./routes/giftcards').register(app, {
  db, SITE_ID, managerOnly, serverPlus, nowIso, crypto,
  persistTotals, checkResponse, paymentView, broadcastCheckUpdated, auditApproval,
  idemKeyFrom, idemReplay, idemReserve, idemStore, idemClear,
});
require('./routes/loyalty').register(app, {
  db, SITE_ID, serverPlus, nowIso, crypto, persistTotals,
  broadcastCheckUpdated, auditApproval,
  idemKeyFrom, idemReplay, idemReserve, idemStore, idemClear,
});
require('./routes/online').register(app, {
  db, SITE_ID, managerOnly, serverPlus, kitchenPlus, nowIso, crypto,
  persistTotals, checkResponse, broadcastCheckUpdated,
});

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
        const slug = canonStation(msg.station);
        if (!slug) {
          ws.send(JSON.stringify({ type: 'error', error: 'Unknown KDS station' }));
          return;
        }
        ws.subs.push({ channel: 'kds', station: slug });
        ws.send(JSON.stringify({ type: 'subscribed', channel: 'kds', station: slug }));
      } else if (msg.channel === 'checks') {
        ws.subs.push({ channel: 'checks' });
        ws.send(JSON.stringify({ type: 'subscribed', channel: 'checks' }));
      } else if (msg.channel === 'menu') {
        ws.subs.push({ channel: 'menu' });
        ws.send(JSON.stringify({ type: 'subscribed', channel: 'menu' }));
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

/** Push {type:'menu_updated'} to 'menu' channel subscribers — every device
    refetches the menu (used by the menu editor and the one-tap 86 toggle). */
function broadcastMenuUpdated() {
  for (const ws of wss.clients) {
    if ((ws.subs || []).some((s) => s.channel === 'menu')) {
      wsSend(ws, { type: 'menu_updated' });
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
