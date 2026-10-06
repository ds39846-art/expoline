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
 *   service charge : guest_count >= min_guests ? round(subtotal * pct) : 0
 *     (defaults 18% on 8+ guests; configurable per site in site_config —
 *      manager-editable via PUT /api/admin/service-charge/config, with live
 *      manager PIN verification + audit log)
 *   A MANDATORY service charge is restaurant revenue, NOT a tip. It is never
 *   auto-distributed to staff and never appears in tip lines or the Tips
 *   report; the house distributes (or keeps) it per its own policy. In
 *   California it is part of the taxable sale (see below). The manager UI
 *   and every report carry a "confirm with your accountant" note — Expoline
 *   is not giving tax or legal advice.
 *   taxable        : subtotal + surcharge + service_charge - comps
 *     - tips are NEVER taxed (only voluntary tips retained by employees are
 *       nontaxable — CA CDTFA Publication 22, Dining and Beverage Industry,
 *       Jan 2025)
 *     - the mandatory service charge IS taxed: mandatory charges are included
 *       in taxable gross receipts (CDTFA Pub 22 §"Tips, gratuities, and
 *       service charges"; Sales and Use Tax Annotation 550.0740)
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
const parityOrders = require('./routes/parity_orders');

/* ------------------------------ boot: seed -------------------------------- */
const ROOT = __dirname;
const DB_DIR = path.join(ROOT, 'db');
const SITES_DIR = path.join(DB_DIR, 'sites');
// Multi-site isolation: each restaurant gets its own DB file so one site's
// corruption/config/network failure cannot affect another.
// EXPOLINE_SITE selects the site slug (default 'bali-hai').
// EXPOLINE_DB overrides the path entirely (used by QA).
const SITE_SLUG = process.env.EXPOLINE_SITE || 'bali-hai';
if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(SITE_SLUG)) {
  console.error(`FATAL: invalid EXPOLINE_SITE "${SITE_SLUG}" (must match ^[a-z0-9][a-z0-9-]{0,63}$).`);
  process.exit(1);
}

/* LAN BRAIN (phase 2) — master switch. Off by default: with EXPOLINE_LAN
 * unset, the lan/ module is never loaded and single-server behavior is
 * byte-for-byte identical. Set EXPOLINE_LAN=1 to enable mDNS discovery,
 * heartbeat election, /api/sync/*, gossip and the WAN queue. */
const LAN_ENABLED = process.env.EXPOLINE_LAN === '1';
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

/* Service charge config audit (phase 4). The 18%-on-8+ default is just
   site_config data; every change is manager-editable (PIN-verified) and
   lands here with before/after values. Runs on every boot. */
(() => {
  db.exec(`CREATE TABLE IF NOT EXISTS service_charge_audit (
    id INTEGER PRIMARY KEY,
    site_id TEXT,
    actor TEXT,
    action TEXT,
    before_json TEXT,
    after_json TEXT,
    details TEXT,
    created_at TEXT
  )`);
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
  /* House accounts (LOCKED POLICY 2026-09-27: manager-created only).
     A house_account tender must name an existing ACTIVE account; servers
     cannot invent accounts at payment time. */
  db.exec(`CREATE TABLE IF NOT EXISTS house_accounts (
    id INTEGER PRIMARY KEY,
    uuid TEXT,
    site_id TEXT,
    name TEXT,
    active INTEGER DEFAULT 1,
    created_by TEXT,
    created_at TEXT,
    UNIQUE(site_id, name)
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
require('./routes/parity_orders').migrate(db);
require('./routes/parity_kds_pay').migrate(db);

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

/* OpenTable integration (phase 6): sync-layer tables + source column.
   Runs on every boot; guarded via CREATE TABLE IF NOT EXISTS / PRAGMA. */
(() => {
  db.exec(`CREATE TABLE IF NOT EXISTS ot_links (
    id INTEGER PRIMARY KEY,
    site_id TEXT,
    opentable_rid TEXT,
    environment TEXT DEFAULT 'sandbox',
    status TEXT DEFAULT 'active',
    frn_online INTEGER DEFAULT 1,
    created_at TEXT,
    updated_at TEXT
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS ot_reservation_map (
    id INTEGER PRIMARY KEY,
    site_id TEXT,
    reservation_uuid TEXT UNIQUE,
    opentable_rid TEXT,
    confirmation_number TEXT,
    source TEXT,
    sync_sequence INTEGER DEFAULT 0,
    ot_state TEXT,
    details_json TEXT,
    last_request_id TEXT,
    idempotency_response TEXT,
    last_sync_at TEXT
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ot_map_conf ON ot_reservation_map(site_id, opentable_rid, confirmation_number)`);
  db.exec(`CREATE TABLE IF NOT EXISTS ot_locks (
    id INTEGER PRIMARY KEY,
    site_id TEXT,
    lock_id TEXT UNIQUE,
    table_id INTEGER,
    party_size INTEGER,
    reserved_at TEXT,
    duration_min INTEGER DEFAULT 90,
    expires_at TEXT,
    status TEXT DEFAULT 'held',
    request_id TEXT,
    created_at TEXT
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ot_locks_table ON ot_locks(site_id, table_id, status)`);
  db.exec(`CREATE TABLE IF NOT EXISTS ot_outbound (
    id INTEGER PRIMARY KEY,
    site_id TEXT,
    opentable_rid TEXT,
    action TEXT,
    confirmation_number TEXT,
    payload_json TEXT,
    request_id TEXT,
    delivered TEXT DEFAULT 'sandbox',
    response_json TEXT,
    created_at TEXT
  )`);
  const rcols = new Set(db.prepare('PRAGMA table_info(reservations)').all().map((c) => c.name));
  if (!rcols.has('source')) db.exec("ALTER TABLE reservations ADD COLUMN source TEXT DEFAULT 'native'");
  db.exec("UPDATE reservations SET source = 'native' WHERE source IS NULL OR source = ''");
})();

/* Phase 3C — competitor parity: back office. Runs on every boot; guarded via
   CREATE TABLE IF NOT EXISTS / PRAGMA column checks. All money stays in
   integer cents; quantities (inventory) are REALs. */
(() => {
  // Waitlist pre-ordering: preorder_json on waitlist (array of
  // {menu_item_id, qty, seat, modifiers}).
  const wcols = new Set(db.prepare('PRAGMA table_info(waitlist)').all().map((c) => c.name));
  if (!wcols.has('preorder_json')) db.exec("ALTER TABLE waitlist ADD COLUMN preorder_json TEXT DEFAULT '[]'");

  db.exec(`CREATE TABLE IF NOT EXISTS cash_drawers (
    id INTEGER PRIMARY KEY,
    uuid TEXT UNIQUE,
    site_id TEXT,
    opened_at TEXT,
    closed_at TEXT,
    opened_by TEXT,
    opening_float_cents INTEGER DEFAULT 0,
    status TEXT CHECK(status IN ('open','closed')) DEFAULT 'open',
    expected_cents INTEGER,
    counted_cents INTEGER,
    variance_cents INTEGER,
    counted_by TEXT,
    notes TEXT
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS cash_drawer_events (
    id INTEGER PRIMARY KEY,
    drawer_id INTEGER,
    site_id TEXT,
    kind TEXT CHECK(kind IN ('open','paid_in','paid_out','no_sale','note','close')),
    amount_cents INTEGER DEFAULT 0,
    note TEXT,
    actor TEXT,
    created_at TEXT
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_drawers_site_status ON cash_drawers(site_id, status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_drawer_events ON cash_drawer_events(drawer_id, created_at)`);

  /* Synchronized course-fire timing: per-course eat/prep estimates drive
     optimal fire-time computation so courses land in sequence with no gap
     and no rush. Configurable per site; fires are tracked per check. */
  db.exec(`CREATE TABLE IF NOT EXISTS course_timing (
    site_id TEXT,
    course TEXT,
    eat_minutes INTEGER DEFAULT 20,
    prep_minutes INTEGER DEFAULT 12,
    updated_at TEXT,
    PRIMARY KEY (site_id, course)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS course_fires (
    id INTEGER PRIMARY KEY,
    uuid TEXT UNIQUE,
    site_id TEXT,
    check_id TEXT,
    course TEXT,
    fired_at TEXT,
    fired_by TEXT
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_course_fires ON course_fires(site_id, check_id, fired_at)`);
  /* One fire per course per check — the 409 "already fired" path is only real
     with this constraint. Dedup first so the index can't fail on boot. */
  db.exec(`DELETE FROM course_fires WHERE id NOT IN (SELECT MIN(id) FROM course_fires GROUP BY site_id, check_id, course)`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_course_fires_unique ON course_fires(site_id, check_id, course)`);

  /* Soak-found perf indexes (2026-09-29): at ~80k+ rows the KDS ticket poll
     degraded to 15.6s and /api/zones to 2.2s, wedging the server (health
     8s+, CPU pinned 92%). Missing indexes:
       - kds_tickets(site_id, status, created_at, id): the KDS open-ticket poll
       - kds_tickets(check_id): courseStatusFor() N+1 per ticket row
       - check_items(check_id, state): courseStatusFor() held-course counts
       - checks(table_id, status): /api/zones per-table open-check lookup
     (the partial idx_checks_one_open_per_table can't serve that query since
     it doesn't constrain split_from/server_id). */
  db.exec(`CREATE INDEX IF NOT EXISTS idx_kds_tickets_site_status ON kds_tickets(site_id, status, created_at, id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_kds_tickets_check_id ON kds_tickets(check_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_check_items_check_id_state ON check_items(check_id, state)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_checks_table_status ON checks(table_id, status)`);

  /* Claim/overlap P0 (DESIGN hidden_files/claim-overlap-20260927, implemented
     2026-09-28): one open STAFF claim per table, enforced by SQLite itself so
     two processes (LAN site-brain failover) can't both win a read-then-write
     race. Scope notes:
       - split_from IS NULL: check splits legitimately keep several open
         checks on one table (staff split flow + soak harness); split children
         carry split_from = source check id.
       - server_id IS NOT NULL: kiosk orders (server_id NULL, one check per
         order on the kiosk pseudo-table) and QR-guest self-orders
         (server_id NULL, channel='qr_guest') legitimately stack checks and
         are out of scope.
     Claim endpoints therefore INSERT first and convert the constraint
     violation into the 409 lost-race contract; the friendly pre-check SELECT
     stays as an advisory fast path. */
  (() => {
    const ccols = new Set(db.prepare('PRAGMA table_info(checks)').all().map((c) => c.name));
    if (!ccols.has('split_from')) db.exec('ALTER TABLE checks ADD COLUMN split_from INTEGER');
    // Grandfather pre-existing split children (tab_name like '%split N'): link
    // them to the earliest other open check on the table so the new index
    // (which excludes split_from rows) doesn't fail on real split data.
    try {
      db.exec(`UPDATE checks SET split_from = (
          SELECT MIN(o.id) FROM checks o
          WHERE o.table_id = checks.table_id AND o.status = 'open' AND o.id <> checks.id
        )
        WHERE status = 'open' AND split_from IS NULL AND tab_name LIKE '%split%'
        AND (SELECT COUNT(*) FROM checks o2
             WHERE o2.table_id = checks.table_id AND o2.status = 'open') > 1`);
    } catch { /* checks table without tab_name on exotic DBs */ }
    // Genuine double-claims from the racy era: keep the earliest-opened,
    // void the rest (audit-logged). The index can't be created on dirty data.
    try {
      const dupes = db.prepare(
        `SELECT table_id FROM checks
         WHERE status = 'open' AND split_from IS NULL AND server_id IS NOT NULL
         GROUP BY table_id HAVING COUNT(*) > 1`
      ).all();
      const voidStmt = db.prepare(`UPDATE checks SET status = 'void', closed_at = ? WHERE id = ?`);
      const auditStmt = db.prepare(
        `INSERT INTO approval_audit (site_id, actor, approver, action, check_id, item_id, shift_id, before_json, after_json, details, created_at)
         VALUES (?, 'system', 'system', 'upgrade.duplicate_open_check_voided', ?, NULL, NULL, ?, ?, ?, ?)`
      );
      for (const d of dupes) {
        const ids = db.prepare(
          `SELECT id, site_id FROM checks
           WHERE status = 'open' AND split_from IS NULL AND server_id IS NOT NULL
             AND table_id = ? ORDER BY id`
        ).all(d.table_id);
        for (const extra of ids.slice(1)) {
          const at = new Date().toISOString();
          voidStmt.run(at, extra.id);
          try {
            auditStmt.run(extra.site_id, extra.id,
              JSON.stringify({ status: 'open' }), JSON.stringify({ status: 'void' }),
              JSON.stringify({ reason: 'upgrade: duplicate open check', table_id: d.table_id, kept_check_id: ids[0].id }), at);
          } catch { /* approval_audit absent on exotic DBs */ }
        }
      }
    } catch { /* checks table absent on exotic DBs */ }
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_checks_one_open_per_table
      ON checks(table_id)
      WHERE status = 'open' AND split_from IS NULL AND server_id IS NOT NULL`);
  })();

  db.exec(`CREATE TABLE IF NOT EXISTS schedule_shifts (
    id INTEGER PRIMARY KEY,
    uuid TEXT UNIQUE,
    site_id TEXT,
    user_id INTEGER,
    employee_name TEXT,
    role TEXT,
    work_date TEXT,
    start_min INTEGER,
    end_min INTEGER,
    rate_cents INTEGER,
    created_by TEXT,
    created_at TEXT
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sched_site_date ON schedule_shifts(site_id, work_date)`);

  db.exec(`CREATE TABLE IF NOT EXISTS ingredients (
    id INTEGER PRIMARY KEY,
    site_id TEXT,
    name TEXT,
    unit TEXT DEFAULT 'ea',
    on_hand REAL DEFAULT 0,
    par REAL DEFAULT 0,
    cost_per_unit_cents INTEGER DEFAULT 0,
    active INTEGER DEFAULT 1,
    created_at TEXT
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS recipes (
    id INTEGER PRIMARY KEY,
    site_id TEXT,
    menu_item_id INTEGER,
    ingredient_id INTEGER,
    qty REAL DEFAULT 0,
    UNIQUE(site_id, menu_item_id, ingredient_id)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS inventory_adjustments (
    id INTEGER PRIMARY KEY,
    site_id TEXT,
    ingredient_id INTEGER,
    delta REAL,
    reason TEXT,
    kind TEXT,
    actor TEXT,
    created_at TEXT
  )`);
  /* Ledger kind migration (2026-10-03): the variance report used to bucket
     rows by pattern-matching the free-text reason, so a manager's manual
     adjustment (POST /adjust stores their text verbatim) could impersonate
     a waste / receiving / count / depletion bucket just by its wording.
     Bucketing is now on this structured `kind`, set explicitly by every
     writer. Existing rows are backfilled ONCE — when the column is first
     added — from the exact reason formats the structured writers used;
     anything unrecognized is a manual adjustment. */
  (() => {
    const acols = new Set(db.prepare('PRAGMA table_info(inventory_adjustments)').all().map((c) => c.name));
    if (!acols.has('kind')) {
      db.exec('ALTER TABLE inventory_adjustments ADD COLUMN kind TEXT');
      db.exec(`UPDATE inventory_adjustments SET kind = CASE
        WHEN reason = 'sale depletion' THEN 'depletion'
        WHEN reason LIKE 'waste: %' THEN 'waste'
        WHEN reason LIKE 'receiving%' THEN 'receiving'
        WHEN reason = 'count correction' THEN 'count_correction'
        ELSE 'manual' END`);
    }
  })();
  db.exec(`CREATE INDEX IF NOT EXISTS idx_recipes_item ON recipes(site_id, menu_item_id)`);

  db.exec(`CREATE TABLE IF NOT EXISTS staff_notes (
    id INTEGER PRIMARY KEY,
    uuid TEXT UNIQUE,
    site_id TEXT,
    title TEXT,
    body TEXT,
    priority TEXT DEFAULT 'normal' CHECK(priority IN ('low','normal','high')),
    active_from TEXT,
    active_to TEXT,
    created_by TEXT,
    created_at TEXT
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_notes_site ON staff_notes(site_id, active_from, active_to)`);

  db.exec(`CREATE TABLE IF NOT EXISTS guest_reviews (
    id INTEGER PRIMARY KEY,
    site_id TEXT,
    check_id INTEGER,
    rating INTEGER CHECK(rating BETWEEN 1 AND 5),
    comment TEXT,
    marketing_opt_in INTEGER DEFAULT 0,
    created_at TEXT,
    UNIQUE(site_id, check_id)
  )`);
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
  const r = db.prepare('SELECT id FROM sites WHERE slug = ?').get(SITE_SLUG);
  if (!r) { console.error(`FATAL: no sites row for slug "${SITE_SLUG}" in database. Refusing to bind to the wrong site.`); process.exit(1); }
  return r.id;
})();

/* Phase 3C defaults: post-payment review nudge is OFF by default (LOCKED
   POLICY 2026-09-27: review nudge B — off). The manager can turn it on via
   PUT /api/admin/settings. Set once per site. */
(() => {
  const cur = db.prepare("SELECT value FROM site_config WHERE site_id = ? AND key = 'review_prompt'").get(SITE_ID);
  if (!cur) db.prepare("INSERT INTO site_config (site_id, key, value) VALUES (?, 'review_prompt', '0')").run(SITE_ID);
})();

/* Synchronized course-fire timing defaults: seed per-course eat/prep
   estimates (tunable by manager via PUT /api/course-timing). */
(() => {
  const ct = db.prepare(`INSERT OR IGNORE INTO course_timing (site_id, course, eat_minutes, prep_minutes, updated_at) VALUES (?, ?, ?, ?, ?)`);
  const now = new Date().toISOString();
  [['drink', 10, 5], ['appetizer', 20, 12], ['entree', 30, 18], ['dessert', 15, 10]].forEach(([c, e, p]) => {
    try { ct.run(SITE_ID, c, e, p, now); } catch (err) { /* seeded */ }
  });
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
    turn_time_target_min: parseInt(m.turn_time_target_min ?? '90', 10),
    drawer_close_role: m.drawer_close_role === 'server' ? 'server' : 'manager',
    site_tz: SITE_TZ,
    site_date: todaySite(),
    site_slug: SITE_SLUG, // LAN BRAIN (phase 2): op envelopes carry this
    /* LAN BRAIN (phase 2): tells the PWA whether to flush its outbox through
       POST /api/sync/batch (envelopes) or the legacy per-endpoint path. */
    lan_sync: LAN_ENABLED,
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
/* SQLite datetime('now') stores UTC as 'YYYY-MM-DD HH:MM:SS' (no zone).
   Date.parse() reads that as LOCAL time, shifting it by the server TZ offset
   (7h in PDT) whenever it is compared against Date.now(). Parse naive DB
   timestamps as UTC; pass real ISO strings (with Z/offset) through. */
const parseDbUtc = (s) => {
  if (typeof s !== 'string' || !s.trim()) return NaN;
  const t = s.trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?(\.\d+)?$/.test(t))
    return Date.parse(t.replace(' ', 'T') + 'Z');
  return Date.parse(t);
};
/* Sentinel for "fail this request with a 409" thrown from inside a
   transaction (the rollback is harmless — nothing was written yet). */
class FireConflict extends Error {}
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
  // P0-1: item-level discounts reduce the line; a 100% discount zeroes it,
  // never drives it negative.
  return Math.max(0, t - (it.discount_cents || 0));
}

/** Pre-discount line value — gross vs net reporting (P0-1). */
function lineGross(it) {
  const mods = parseJson(it.modifiers_json, []);
  const qty = it.qty || 0;
  let t = qty * (it.unit_price_cents || 0);
  for (const mod of mods) t += qty * (mod.price_delta_cents || 0);
  return t;
}

/** Recompute every money field for a check; returns totals {subtotal, gross_subtotal,
 *  item_discount_cents, surcharge, service_charge, tax, total, paid, balance, comp}. */
// Billable = every non-void line. Held + sent + fulfilled are all owed;
// only 'void'/'cancelled' are excluded. (KDS send uses state='held' only.)
const BILLABLE_STATES = "('held','sent','fulfilled')";

function calcTotals(checkId) {
  const cfg = getConfig();
  // Billable = every non-void line: held, sent, AND fulfilled (served food is still owed).
  const items = db.prepare(
    `SELECT * FROM check_items WHERE check_id = ? AND state IN ${BILLABLE_STATES}`
  ).all(checkId);
  const gross = items.reduce((s, it) => s + lineGross(it), 0);
  const subtotal = items.reduce((s, it) => s + lineTotal(it), 0);
  // P0-1: gross − item discounts = net subtotal. Surcharges/tax apply to net.
  const itemDiscounts = gross - subtotal;
  const surcharge = Math.round(subtotal * cfg.surcharge_pct);
  const check = db.prepare('SELECT guest_count, COALESCE(comp_cents, 0) AS comp_cents FROM checks WHERE id = ?').get(checkId);
  const guests = check ? (check.guest_count || 0) : 0;
  const comp = check ? (check.comp_cents || 0) : 0;
  const serviceCharge = (cfg.service_charge_min_guests > 0 && guests >= cfg.service_charge_min_guests)
    ? Math.round(subtotal * cfg.service_charge_pct) : 0;
  // Taxable base (California): subtotal + surcharge + mandatory service charge.
  // Tips are NEVER taxed. Mandatory service charges ARE taxed — they are
  // part of the taxable sale (CDTFA Publication 22, Jan 2025; Annotation
  // 550.0740). Manager-approved comps reduce the amount owed (never below zero).
  const taxable = subtotal + surcharge + serviceCharge;
  const tax = Math.round(taxable * cfg.tax_rate);
  const total = Math.max(0, subtotal + surcharge + serviceCharge + tax - comp);
  const pay = db.prepare(
    'SELECT COALESCE(SUM(amount_cents),0) AS amt, COALESCE(SUM(refunded_cents),0) AS ref FROM payments WHERE check_id = ?'
  ).get(checkId);
  const paid = (pay.amt || 0) - (pay.ref || 0);
  const balance = total - paid;
  return { subtotal, surcharge, service_charge: serviceCharge, tax, total, paid, balance, comp,
    gross_subtotal: gross, item_discount_cents: itemDiscounts };
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
    // P0-1/P0-2: per-line discount + special request / allergy flag.
    note: it.note || null,
    allergy: it.allergy ? true : false,
    allergy_detail: it.allergy_detail || null,
    discount_cents: it.discount_cents || 0,
    discount_reason: it.discount_reason || null,
  };
}

/** Full check payload: check + items[] + totals. */
function checkResponse(checkId) {
  const c = db.prepare('SELECT * FROM checks WHERE id = ? AND site_id = ?').get(checkId, SITE_ID);
  if (!c) return null;
  const t = persistTotals(checkId);
  const table = c.table_id ? db.prepare('SELECT label FROM tables WHERE id = ?').get(c.table_id) : null;
  const server = c.server_id ? db.prepare('SELECT name FROM users WHERE id = ?').get(c.server_id) : null;
  const items = db.prepare(
    'SELECT ci.*, mi.name FROM check_items ci LEFT JOIN menu_items mi ON mi.id = ci.menu_item_id WHERE ci.check_id = ? ORDER BY ci.added_at, ci.id'
  ).all(checkId);
  // Seat-level guest names (phase 3A): attach once, follow the guest across
  // splits and merges.
  const seatNames = {};
  try {
    for (const r of db.prepare('SELECT seat, guest_name FROM check_seats WHERE site_id = ? AND check_id = ?').all(SITE_ID, checkId)) {
      seatNames[r.seat] = r.guest_name;
    }
  } catch { /* table created by parity_orders migrate; absent on ancient DBs */ }
  return {
    id: c.id,
    uuid: c.uuid,
    site_id: c.site_id,
    table_id: c.table_id,
    table_label: table ? table.label : null,
    server_id: c.server_id,
    server_name: server ? server.name : null,
    tab_name: c.tab_name,
    channel: c.channel || 'dine_in',
    guest_count: c.guest_count,
    status: c.status,
    coursing: c.coursing || 'off',
    order_note: c.order_note || null,
    seat_names: seatNames,
    merged_from: parseJson(c.merged_from_json, []),
    subtotal_cents: t.subtotal,
    surcharge_cents: t.surcharge,
    service_charge_cents: t.service_charge,
    tax_cents: t.tax,
    comp_cents: t.comp,
    gross_subtotal_cents: t.gross_subtotal,
    item_discount_cents: t.item_discount_cents,
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

/* Location label for KDS tickets and location-aware surfaces: the table
 * label for a table check; for a table-less check, its tab name — bar
 * tabs get the prefixed form used on the floor and in check headers
 * ("TAB · Silva"; prefixed labels are the house style — delivery tickets
 * read "DLV · <source>") so the kitchen can tell a tab from a table at a
 * glance. tableRow is the already-fetched tables row (or null). */
function checkLocationLabel(tableRow, chk) {
  if (tableRow) return tableRow.label;
  if (!chk) return null;
  if (chk.channel === 'bar_tab') return 'TAB · ' + (chk.tab_name || 'Tab');
  return chk.tab_name || null;
}

// Canonical KDS station slugs; accepts display names too ("Expediter", "Garde Manger", ...)
const KDS_STATION_SLUGS = ['bar', 'expediter', 'garde_manger', 'dessert'];
function canonStation(s) {
  if (typeof s !== 'string') return null;
  const slug = s.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return KDS_STATION_SLUGS.includes(slug) ? slug : null;
}

/* KDS tickets intentionally carry NO financial fields (no subtotal, tax,
 * tip, surcharge, or service charge). The kitchen display is a production
 * view: stations see items to make, never money. A service-charge line here
 * would be the first financial figure on KDS and could be misread as an
 * item or a tip — so it is deliberately absent. Financial breakdowns live
 * on the pay/check summary, the printed receipt, and Finance reports. */
/* kds_tickets.refire — marks re-fired/reprinted tickets (see POST
 * /api/checks/:id/items/:itemId/refire). Guarded: runs on every boot. */
(() => {
  const cols = new Set(db.prepare('PRAGMA table_info(kds_tickets)').all().map((c) => c.name));
  if (!cols.has('refire')) db.exec('ALTER TABLE kds_tickets ADD COLUMN refire INTEGER DEFAULT 0');
})();

const KDS_COURSE_ORDER = ['drink', 'appetizer', 'entree', 'dessert'];
/* Per-course rollup for a check: held (not yet fired), fired (on a KDS
 * ticket), bumped (on a bumped/fulfilled ticket). Rides on EVERY ticket view
 * so the line never has to ask about previous-course state. */
function courseStatusFor(checkId) {
  const out = KDS_COURSE_ORDER.map((c) => ({ course: c, held: 0, fired: 0, bumped: 0, total: 0 }));
  const by = Object.fromEntries(out.map((o) => [o.course, o]));
  for (const r of db.prepare(
    "SELECT course, COUNT(*) AS n FROM check_items WHERE check_id = ? AND state = 'held' GROUP BY course"
  ).all(checkId)) {
    if (by[r.course]) by[r.course].held += r.n;
  }
  for (const t of db.prepare('SELECT status, items_json FROM kds_tickets WHERE check_id = ?').all(checkId)) {
    const done = t.status === 'fulfilled';
    for (const it of parseJson(t.items_json, [])) {
      if (!by[it.course]) continue;
      const q = Number.isInteger(it.qty) && it.qty > 0 ? it.qty : 1;
      by[it.course].fired += q;
      if (done) by[it.course].bumped += q;
    }
  }
  for (const o of out) o.total = o.held + o.fired;
  return out.filter((o) => o.total > 0);
}
function ticketCourses(itemsJson) {
  const seen = [];
  for (const it of parseJson(itemsJson, [])) {
    if (KDS_COURSE_ORDER.includes(it.course) && !seen.includes(it.course)) seen.push(it.course);
  }
  return seen.sort((a, b) => KDS_COURSE_ORDER.indexOf(a) - KDS_COURSE_ORDER.indexOf(b));
}

function ticketView(row) {
  const chk = row.check_id
    ? db.prepare('SELECT channel, source FROM checks WHERE id = ?').get(row.check_id)
    : null;
  // Phase 3A (NG-E): the check-level order note rides every ticket so the
  // kitchen sees whole-order notes ("allergy table — confirm w/ server").
  let orderNote = null;
  try {
    const c = db.prepare('SELECT order_note FROM checks WHERE id = ?').get(row.check_id);
    orderNote = (c && c.order_note) || null;
  } catch { /* checks.order_note owned by parity_orders migrate */ }
  const items = parseJson(row.items_json, []);
  return {
    id: row.id,
    uuid: row.uuid,
    check_id: row.check_id,
    station: row.station,
    table_label: row.table_label,
    server_name: row.server_name,
    order_note: orderNote,
    items,
    // Phase 3A: post-fire edit deltas — the kitchen sees the delta
    // highlighted on the live ticket, not a reprinted ticket.
    deltas: parseJson(row.deltas_json, []),
    status: row.status,
    created_at: row.created_at,
    bumped_at: row.bumped_at,
    bumped_by: row.bumped_by,
    /* refire: this ticket is a re-fire/reprint of an already-fired item —
     * the kitchen sees a ↻ RE-FIRE banner, never a silent duplicate make. */
    refire: !!row.refire,
    /* has_allergy: any line carries an allergy flag — the ticket gets a
     * high-visibility allergy banner on KDS. */
    has_allergy: items.some((i) => !!i.allergy),
    channel: (chk && chk.channel) || 'dine_in',
    source: (chk && chk.source) || null,
    ticket_courses: ticketCourses(row.items_json),
    course_status: courseStatusFor(row.check_id),
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
    memo: p.memo || null,
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
  tokens.set(token, { id: user.id, name: user.name, role: user.role, expires_at: Date.now() + TOKEN_TTL_MS, split_allowed: user.split_allowed == null ? 1 : user.split_allowed });
  return token;
}

// Reap expired sessions so the map cannot grow without bound.
setInterval(() => {
  const now = Date.now();
  for (const [t, s] of tokens) {
    if (s.expires_at && s.expires_at <= now) tokens.delete(t);
  }
}, 5 * 60_000).unref();

/* ---- auth audit (LOCKED POLICY 2026-09-27: audit-only, NO strict lockout) ----
   Failed logins and failed manager-PIN verifications are written to the
   approval audit log. There is deliberately NO lockout: a busy restaurant
   must never be locked out of its own POS during service. Managers review
   repeated failures in the audit log. */
function auditAuthEvent(req, action, details) {
  try {
    db.prepare(`INSERT INTO approval_audit (site_id, actor, approver, action, check_id, item_id, shift_id, before_json, after_json, details, created_at)
      VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?)`)
      .run(SITE_ID, req.user ? req.user.name : '?', req.user ? req.user.name : '?',
        action, JSON.stringify(details || {}), new Date().toISOString());
  } catch (e) { /* audit is best-effort; never break the auth flow */ }
}
function recordLoginAttempt(req, ip, ok) {
  if (!ok) auditAuthEvent(req, 'auth_login_failed', { ip });
}
function recordManagerPinAttempt(req, ok) {
  if (!ok) auditAuthEvent(req, 'auth_manager_pin_failed', { ip: req.ip || (req.socket && req.socket.remoteAddress) || 'unknown' });
}

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
  // OpenTable partner callbacks — authenticated via X-Partner-Key (otCallbackAuth),
  // not staff Bearer tokens. The per-route otCallbackAuth middleware enforces it.
  if (req.path.startsWith('/opentable/')) return next();
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
  const live = db.prepare('SELECT id, name, role, COALESCE(split_allowed, 1) AS split_allowed FROM users WHERE id = ? AND COALESCE(active, 1) = 1').get(sess.id);
  if (!live) {
    tokens.delete(m[1]);
    return res.status(401).json({ error: 'Unauthorized: this account is no longer active' });
  }
  req.user = { id: live.id, name: live.name, role: live.role, split_allowed: live.split_allowed };
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
   { mgr, offline, replay, nonce } or sends 403 and returns null.
   Policy: audit-only — failed PIN attempts are audit-logged, never lock out. */
function resolveVoidApproval(req, b, checkId, itemId, res) {
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

/* Phase 3B public routes: guest QR order/pay/split + /g/:token page.
   Registered before the auth wall like kiosk (customer phones carry no staff
   token); hardened by rate limiting + full server-side validation. */
require('./routes/parity_kds_pay').registerPublic(app, {
  db, SITE_ID, nowIso, crypto, persistTotals, checkResponse,
  broadcastTicket, ticketView, broadcastCheckUpdated,
});

app.use('/api', authMiddleware);

/* ----------------- LAN site brain (phase 2) integration -----------------
 * Modular: all LAN logic lives in ./lan/; this block is the only wiring.
 * With EXPOLINE_LAN unset, init() returns a no-op stub and nothing else
 * here runs (routes, discovery, election, gossip all stay off). */
const lanRuntime = (() => {
  if (!LAN_ENABLED) return { stop() {}, isBrain: () => false, status: () => ({ lan_enabled: false }) };
  const ctx = {
    db,
    siteSlug: SITE_SLUG,
    helpers: {
      persistTotals, checkResponse, ticketView, checkLocationLabel,
      broadcastTicket, broadcastCheckUpdated, broadcastMenuUpdated,
      auditApproval, auditMenu,
      verifyManagerPin, verifyOfflineApproval, consumeOfflineApproval,
      parseJson, crypto,
    },
    // NOTE: cross-node gossip authenticates by logging in to the brain
    // with EXPOLINE_LAN_GOSSIP_PIN (see lan/lan.js) — Bearer <redacted> are
    // node-local and cannot be reused across nodes.
  };
  return require('./lan/lan').init(app, ctx);
})();

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
  /* LAN BRAIN (phase 2): when enabled, report live election state so
     devices and diagnostics can see who the brain is right now. */
  const lan = LAN_ENABLED ? lanRuntime.status() : { lan_enabled: false };
  res.json({
    brain: true,
    site_slug: SITE_SLUG,
    site_id: SITE_ID,
    version: '1.0',
    // Heartbeat for election: priority 0 = preferred brain (wall terminal),
    // higher = fallback (handhelds/tablets). See sync-engine/brain.js.
    priority: parseInt(process.env.EXPOLINE_BRAIN_PRIORITY || '0', 10),
    uptime_s: Math.floor(process.uptime()),
    /* Security: never expose the absolute server path. Basename only. */
    db_file: String(DB_PATH || '').split('/').pop(),
    lan,
    is_brain: lan.lan_enabled ? lan.is_brain : undefined,
    brain_device_id: lan.lan_enabled && lan.brain ? lan.brain.device_id : undefined,
  });
});

app.post('/api/auth/login', (req, res) => {
  const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
  const pin = req.body && req.body.pin != null ? String(req.body.pin) : '';
  if (!pin) { recordLoginAttempt(req, ip, false); return res.status(401).json({ error: 'PIN required' }); }
  // PINs compared as strings. Deactivated staff cannot log in.
  const user = db.prepare('SELECT id, name, role, COALESCE(split_allowed, 1) AS split_allowed FROM users WHERE pin = ? AND site_id = ? AND COALESCE(active, 1) = 1').get(pin, SITE_ID);
  if (!user) { recordLoginAttempt(req, ip, false); return res.status(401).json({ error: 'Invalid PIN' }); }
  recordLoginAttempt(req, ip, true);
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
    'SELECT id, name, description, price_cents, item_type, station, course, price_note, daypart, popular FROM menu_items WHERE category_id = ? AND active = 1 ORDER BY id'
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
      // Effective daypart for clock-based auto-switching: item-level override
      // wins, then the category's daypart parent, else all-day (null).
      daypart: it.daypart || c.parent || null,
      // Phase 3A (NG-D): popular flag — quick-pick row on the order screen
      // (SpotOn V3 1:05 "quick buttons for popular items").
      popular: it.popular ? true : false,
      modifiers: modStmt.all(it.id),
      // Phase 3A (P0-6): modifier groups with required/min/max/nesting.
      modifier_groups: getModifierGroups(it.id),
    })),
  }))));
});
// Menu admin lives under /api/admin/menu/* (manager only) — see below.

/* --------------------- modifier groups (P0-6, Toast parity) ---------------- */
/** Load an item's modifier groups with their options, in display order. */
function getModifierGroups(menuItemId) {
  const groups = db.prepare(
    'SELECT * FROM menu_modifier_groups WHERE menu_item_id = ? ORDER BY sort_order, id'
  ).all(menuItemId);
  const optStmt = db.prepare('SELECT * FROM menu_modifier_options WHERE group_id = ? ORDER BY sort_order, id');
  return groups.map((g) => ({
    id: g.id, name: g.name, min_select: g.min_select, max_select: g.max_select,
    required: g.required ? true : false, parent_group_id: g.parent_group_id,
    parent_option_id: g.parent_option_id, sort_order: g.sort_order,
    options: optStmt.all(g.id).map((o) => ({
      id: o.id, name: o.name, price_delta_cents: o.price_delta_cents,
      is_default: o.is_default ? true : false, active: o.active ? true : false,
      sort_order: o.sort_order,
    })),
  }));
}

/** Validate + normalize client modifiers for a menu item.
 *  Returns { error } or { modifiers: [{name, price_delta_cents, option_id?}] }.
 *  - Items WITH groups: every selection must match an option of an applicable
 *    group (nested groups apply only when their parent option is selected);
 *    required/min/max enforced; prices come from the menu option, never the
 *    client; 86'd (inactive) options rejected.
 *  - Items without groups: legacy shape check (backward compatible). */
function resolveModifiers(menuItemId, modifiers) {
  const sel = Array.isArray(modifiers) ? modifiers : [];
  /* Phase 3A (NG-E): per-modifier notes ("light on the cheese") — a short
     string (≤60) that rides the modifier into KDS. */
  const modNote = (m) => {
    if (m.note === undefined || m.note === null || m.note === '') return undefined;
    if (typeof m.note !== 'string' || m.note.length > 60) return { error: 'modifier note must be a string of at most 60 characters' };
    return m.note.trim() || undefined;
  };
  const groups = getModifierGroups(menuItemId);
  if (!groups.length) {
    /* Phase 1B money audit: modifiers are NEVER trusted from the client.
       Each modifier must exist on this menu item (matched by name); the
       canonical price_delta_cents from menu_modifiers is used. */
    const modStmt = db.prepare('SELECT price_delta_cents FROM menu_modifiers WHERE item_id = ? AND name = ?');
    const priced = [];
    for (const m of sel) {
      if (!m || typeof m.name !== 'string' || !m.name.trim()) {
        return { error: 'Each modifier needs a name' };
      }
      const row = modStmt.get(menuItemId, m.name.trim());
      if (!row) {
        return { error: `Unknown modifier "${m.name.trim()}" — modifiers must come from the menu` };
      }
      const n = modNote(m);
      if (n && n.error) return n;
      const o = { name: m.name.trim().slice(0, 80), price_delta_cents: row.price_delta_cents };
      if (n) o.note = n;
      priced.push(o);
    }
    return { modifiers: priced };
  }
  const optById = new Map();
  const optByName = new Map();
  for (const g of groups) for (const o of g.options) {
    optById.set(o.id, { opt: o, group: g });
    if (!optByName.has(o.name)) optByName.set(o.name, { opt: o, group: g });
  }
  const matched = [];
  for (const m of sel) {
    if (!m || typeof m.name !== 'string') return { error: 'Each modifier needs {name}' };
    let hit = null;
    if (m.option_id != null) hit = optById.get(Number(m.option_id)) || null;
    if (!hit) hit = optByName.get(m.name.trim()) || null;
    if (!hit) return { error: `Modifier "${m.name}" is not offered for this item` };
    if (!hit.opt.active) return { error: `Modifier "${hit.opt.name}" is 86'd` };
    const n = modNote(m);
    if (n && n.error) return n;
    matched.push({ hit, note: n || undefined });
  }
  // Nested groups apply only when their parent option is selected.
  const selectedOptIds = new Set(matched.map((x) => x.hit.opt.id));
  const applicable = groups.filter((g) =>
    !g.parent_group_id || (g.parent_option_id && selectedOptIds.has(g.parent_option_id)));
  for (const g of applicable) {
    const n = matched.filter((x) => x.hit.group.id === g.id).length;
    if (g.required && n === 0) return { error: `${g.name}: please choose at least one` };
    if (g.min_select > 0 && n < g.min_select) return { error: `${g.name}: pick at least ${g.min_select}` };
    if (g.max_select > 0 && n > g.max_select) return { error: `${g.name}: at most ${g.max_select}` };
  }
  return { modifiers: matched.map((x) => {
    const o = { name: x.hit.opt.name, price_delta_cents: x.hit.opt.price_delta_cents, option_id: x.hit.opt.id };
    if (x.note) o.note = x.note;
    return o;
  }) };
}

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
  /* LAN BRAIN (phase 2): version-guard for menu_update ops. Bumped on
     name/price edits so a stale LAN editor's write is rejected with the
     current version instead of silently clobbering. Unread in
     single-server mode. */
  if (LAN_ENABLED && (name !== it.name || price_cents !== it.price_cents)) {
    db.prepare('UPDATE menu_items SET version = COALESCE(version, 1) + 1 WHERE id = ?').run(it.id);
  }
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

/* Phase 3A (NG-D): popular / quick-pick flag — the order screen's quick-pick
 * row (SpotOn V3 1:05 "quick buttons for popular items"). Manager-only;
 * 86'd items never appear in the quick-pick row even when flagged. */
app.put('/api/admin/menu/items/:id/popular', managerOnly(), (req, res) => {
  const it = menuItemById(req.params.id);
  if (!it) return res.status(404).json({ error: 'Menu item not found' });
  const popular = (req.body || {}).popular;
  if (typeof popular !== 'boolean') return res.status(400).json({ error: 'popular must be a boolean' });
  db.prepare('UPDATE menu_items SET popular = ? WHERE id = ?').run(popular ? 1 : 0, it.id);
  auditMenu(req, popular ? 'item.popular_on' : 'item.popular_off', { item_id: it.id, category_id: it.category_id }, { name: it.name, popular });
  broadcastMenuUpdated();
  res.json({ id: it.id, name: it.name, popular });
});

app.get('/api/admin/menu/audit', managerOnly(), (req, res) => {
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || '50', 10) || 50));
  const rows = db.prepare('SELECT id, actor, action, item_id, category_id, details, created_at FROM menu_audit WHERE site_id = ? ORDER BY id DESC LIMIT ?').all(SITE_ID, limit);
  res.json(rows.map((r) => ({ id: r.id, actor: r.actor, action: r.action, item_id: r.item_id, category_id: r.category_id, details: parseJson(r.details, {}), created_at: r.created_at })));
});

/* --------------------------------- checks ---------------------------------- */

/* Claim/overlap P0: the partial unique index idx_checks_one_open_per_table
 * (see boot migration) is the arbiter for staff table claims. node:sqlite
 * reports the violation against the TABLE+COLUMN, not the index name:
 *   "UNIQUE constraint failed: checks.table_id"
 * (verified 2026-09-28 against node:sqlite; the index name never appears).
 * This message is unambiguous here: the partial claim index is the only
 * UNIQUE constraint on checks.table_id (uuid/id violations name their own
 * columns). */
function isClaimConflict(err) {
  return !!err && typeof err.message === 'string' &&
    err.message.includes('UNIQUE constraint failed: checks.table_id');
}

/* Winner identity for the 409 lost-race contract (DESIGN.md 3.4): the winning
 * check's id, the server's display name (never a PIN or id), and when the
 * claim was made. Prefers the primary staff claim; falls back to any open
 * check so the loser always gets something actionable. */
function claimWinnerOnTable(tableId) {
  return db.prepare(
    `SELECT c.id, c.opened_at, u.name AS server_name FROM checks c
     LEFT JOIN users u ON u.id = c.server_id
     WHERE c.table_id = ? AND c.status = 'open'
       AND c.split_from IS NULL AND c.server_id IS NOT NULL
     ORDER BY c.id LIMIT 1`
  ).get(tableId)
    || db.prepare(
      `SELECT c.id, c.opened_at, u.name AS server_name FROM checks c
       LEFT JOIN users u ON u.id = c.server_id
       WHERE c.table_id = ? AND c.status = 'open'
       ORDER BY c.id LIMIT 1`
    ).get(tableId)
    || null;
}

app.post('/api/checks', serverPlus(), (req, res) => {
  const { table_id, guest_count, tab_name } = req.body || {};
  /* Bar tab: a named check with NO table (channel 'bar_tab', the same
   * table-less shape delivery checks already use). The discriminator is
   * the absent table: with no table_id, a non-empty tab_name opens a
   * tab; with no name either, the request is the same malformed one it
   * always was and keeps the historic error. A request WITH a table_id
   * follows the table rules below exactly — tab_name stays an optional
   * label there. No card pre-authorization exists yet (Stripe-gated);
   * a tab is a normal check for money: it is paid at the end like any
   * other check. */
  if (table_id == null) {
    const cleanTab = typeof tab_name === 'string' ? tab_name.trim() : '';
    if (!cleanTab) {
      return res.status(400).json({
        error: tab_name == null ? 'Valid table_id is required' : 'tab_name is required to open a bar tab',
      });
    }
    if (cleanTab.length > 40) {
      return res.status(400).json({ error: 'tab_name must be at most 40 characters' });
    }
    const guests = guest_count == null ? 1 : guest_count;
    if (!isInt(guests) || guests < 1) {
      return res.status(400).json({ error: 'guest_count must be a positive integer' });
    }
    const r = db.prepare(
      "INSERT INTO checks (uuid, site_id, table_id, server_id, tab_name, guest_count, channel, status, opened_at) VALUES (?, ?, NULL, ?, ?, ?, 'bar_tab', 'open', ?)"
    ).run(crypto.randomUUID(), SITE_ID, req.user.id, cleanTab, guests, nowIso());
    const check = checkResponse(r.lastInsertRowid);
    broadcastCheckUpdated(check.id);
    /* Duplicate-name rule: tabs are NEVER merged — a second open tab
     * under the same name is a distinct check (two guests can share a
     * name, and silently folding one tab into another would mix their
     * bills). When THIS server already has an open tab under the same
     * name, the response names those tabs so the client can warn
     * instead of quietly stacking look-alikes. */
    const existing = db.prepare(
      "SELECT id, opened_at FROM checks WHERE site_id = ? AND server_id = ? AND channel = 'bar_tab' AND status = 'open' AND LOWER(tab_name) = LOWER(?) AND id != ? ORDER BY id"
    ).all(SITE_ID, req.user.id, cleanTab, check.id)
      .map((t) => ({ id: t.id, opened_at: t.opened_at, total_cents: persistTotals(t.id).total }));
    return res.status(201).json(existing.length ? { ...check, existing_tabs: existing } : check);
  }
  const table = db.prepare('SELECT id FROM tables WHERE id = ? AND site_id = ?').get(table_id, SITE_ID);
  if (!table) return res.status(400).json({ error: 'Valid table_id is required' });
  if (!isInt(guest_count) || guest_count < 1) {
    return res.status(400).json({ error: 'guest_count must be a positive integer' });
  }
  /* Friendly fast path (advisory only): catches the common single-process
   * double-claim in one query. The INSERT below is the decision point — the
   * unique index arbitrates races across processes. */
  const existing = db.prepare("SELECT id FROM checks WHERE table_id = ? AND status = 'open' LIMIT 1").get(table_id);
  if (existing) return res.status(400).json({ error: 'Table already has an open check', check_id: existing.id });
  try {
    const r = db.prepare(
      "INSERT INTO checks (uuid, site_id, table_id, server_id, tab_name, guest_count, status, opened_at) VALUES (?, ?, ?, ?, ?, ?, 'open', ?)"
    ).run(crypto.randomUUID(), SITE_ID, table_id, req.user.id, tab_name || null, guest_count, nowIso());
    const check = checkResponse(r.lastInsertRowid);
    broadcastCheckUpdated(check.id);
    res.status(201).json(check);
  } catch (e) {
    if (isClaimConflict(e)) {
      const w = claimWinnerOnTable(table_id);
      return res.status(409).json({
        error: 'Table already claimed',
        check_id: w ? w.id : null,
        claimed_by: w ? w.server_name : null,
        claimed_at: w ? w.opened_at : null,
      });
    }
    throw e;
  }
});

app.get('/api/checks/open', serverPlus(), (req, res) => {
  const rows = db.prepare(
    `SELECT c.id, c.uuid, c.table_id, c.server_id, c.tab_name, c.channel, c.guest_count, c.status, c.opened_at,
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
      id: c.id, uuid: c.uuid, table_id: c.table_id, table_label: c.table_label,
      server_id: c.server_id, server_name: c.server_name,
      tab_name: c.tab_name, channel: c.channel || 'dine_in', guest_count: c.guest_count, status: c.status,
      item_count: c.item_count, total_cents: t.total, opened_at: c.opened_at,
    };
  }));
});

app.get('/api/checks/:id', serverPlus(), (req, res) => {
  const check = checkResponse(req.params.id);
  if (!check) return res.status(404).json({ error: 'Check not found' });
  res.json(check);
});

/* Synchronized course-fire timing API.
   GET /api/course-timing — per-course eat/prep minutes for this site.
   PUT /api/course-timing — manager updates estimates.
   GET /api/checks/:id/fire-schedule — optimal fire times for remaining courses,
     computed from last fire + eat duration - next prep time.
   POST /api/checks/:id/fire-course {course} — record a course fire. */
app.get('/api/course-timing', serverPlus(), (req, res) => {
  const rows = db.prepare(`SELECT course, eat_minutes, prep_minutes FROM course_timing WHERE site_id = ?`).all(SITE_ID);
  res.json({ timing: rows });
});
app.put('/api/course-timing', serverPlus(), managerOnly(), (req, res) => {
  const { timing } = req.body || {};
  if (!Array.isArray(timing)) return res.status(400).json({ error: 'timing array required' });
  const up = db.prepare(`INSERT INTO course_timing (site_id, course, eat_minutes, prep_minutes, updated_at)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(site_id, course) DO UPDATE SET eat_minutes=excluded.eat_minutes, prep_minutes=excluded.prep_minutes, updated_at=excluded.updated_at`);
  const now = new Date().toISOString();
  withTransaction(() => {
    for (const t of timing) {
      if (!t.course || typeof t.eat_minutes !== 'number' || typeof t.prep_minutes !== 'number') continue;
      up.run(SITE_ID, String(t.course), Math.max(1, Math.min(180, Math.round(t.eat_minutes))), Math.max(1, Math.min(120, Math.round(t.prep_minutes))), now);
    }
  });
  res.json({ ok: true });
});
app.get('/api/checks/:id/fire-schedule', serverPlus(), (req, res) => {
  const check = db.prepare('SELECT * FROM checks WHERE id = ? AND site_id = ?').get(req.params.id, SITE_ID);
  if (!check) return res.status(404).json({ error: 'Check not found' });
  const checkId = check.id;
  const timing = Object.fromEntries(db.prepare(`SELECT course, eat_minutes, prep_minutes FROM course_timing WHERE site_id = ?`).all(SITE_ID).map((r) => [r.course, r]));
  const fires = db.prepare(`SELECT course, fired_at FROM course_fires WHERE site_id = ? AND check_id = ? ORDER BY fired_at DESC`).all(SITE_ID, checkId);
  const order = ['drink', 'appetizer', 'entree', 'dessert'];
  /* Remaining = courses that actually have held items waiting, in course order.
     This handles re-fires (items added after a course fired) and out-of-order
     flows — the card only offers to fire food that exists. */
  const heldByCourse = new Set(courseStatusFor(checkId).filter((s) => s.held > 0).map((s) => s.course));
  const remaining = order.filter((c) => heldByCourse.has(c));
  const schedule = [];
  let anchor = fires.length ? new Date(fires[0].fired_at).getTime() : Date.now();
  let anchorCourse = fires.length ? fires[0].course : null;
  for (const course of remaining) {
    const t = timing[course] || { eat_minutes: 20, prep_minutes: 12 };
    let fireAt;
    if (!fires.length && schedule.length === 0) {
      fireAt = Date.now();
    } else {
      const anchorTiming = anchorCourse ? (timing[anchorCourse] || { eat_minutes: 20 }) : { eat_minutes: 20 };
      fireAt = anchor + anchorTiming.eat_minutes * 60000 - t.prep_minutes * 60000;
      fireAt = Math.max(fireAt, Date.now());
    }
    schedule.push({ course, fire_at: new Date(fireAt).toISOString(), eat_minutes: t.eat_minutes, prep_minutes: t.prep_minutes });
    anchor = fireAt;
    anchorCourse = course;
  }
  res.json({ check_id: checkId, fired: fires.map((f) => ({ course: f.course, fired_at: f.fired_at })), schedule });
});
app.post('/api/checks/:id/fire-course', serverPlus(), (req, res) => {
  const check = db.prepare('SELECT * FROM checks WHERE id = ? AND site_id = ?').get(req.params.id, SITE_ID);
  if (!check) return res.status(404).json({ error: 'Check not found' });
  if (check.status !== 'open') return res.status(400).json({ error: `Cannot fire course on a ${check.status} check` });
  const { course } = req.body || {};
  const order = ['drink', 'appetizer', 'entree', 'dessert'];
  if (!course || !order.includes(course)) return res.status(400).json({ error: 'valid course required' });

  /* Course order is enforced: a course cannot fire while an earlier course
     still has held items waiting. (A course with nothing held never blocks —
     e.g. firing appetizer when no drinks were ordered is fine.) */
  const earlier = order.slice(0, order.indexOf(course));
  if (earlier.length) {
    const rows = db.prepare(
      `SELECT LOWER(course) AS course, COUNT(*) AS n FROM check_items
       WHERE check_id = ? AND state = 'held' AND LOWER(course) IN (${earlier.map(() => '?').join(',')})
       GROUP BY LOWER(course)`
    ).all(check.id, ...earlier);
    if (rows.length) {
      rows.sort((a, b) => order.indexOf(a.course) - order.indexOf(b.course));
      const blocker = rows[0];
      return res.status(409).json({
        error: `fire ${blocker.course} first — ${blocker.n} item(s) still held`,
        blocked_by: blocker.course, need_course_order: true,
      });
    }
  }

  const firedAt = nowIso();
  const actor = req.user?.name || req.user?.pin || 'staff';
  const heldStmt = db.prepare(
    "SELECT ci.*, mi.name, mi.station FROM check_items ci JOIN menu_items mi ON mi.id = ci.menu_item_id WHERE ci.check_id = ? AND ci.state = 'held' AND LOWER(ci.course) = ? ORDER BY ci.added_at, ci.id"
  );
  let result;
  try {
    /* One transaction, one truth: the fire-record upsert, the item/inventory/
       ticket writes, totals, and the audit entry all commit or roll back
       together. Held items are re-read INSIDE the transaction so two
       concurrent fires can never ticket the same item twice. */
    result = withTransaction(() => {
      const heldNow = heldStmt.all(check.id, course.toLowerCase());
      const existingNow = db.prepare(`SELECT id FROM course_fires WHERE site_id = ? AND check_id = ? AND course = ?`).get(SITE_ID, check.id, course);
      /* Re-fire policy: firing a course that already fired is allowed when new
         held items landed in that course afterwards — only the still-held items
         fire, and the fire record's timestamp refreshes. Re-firing with nothing
         held is a no-op 409. The unique index + upsert is the race guard. */
      if (!heldNow.length && existingNow) throw new FireConflict('course already fired');
      db.prepare(`INSERT INTO course_fires (uuid, site_id, check_id, course, fired_at, fired_by)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(site_id, check_id, course) DO UPDATE SET fired_at = excluded.fired_at, fired_by = excluded.fired_by`)
        .run(crypto.randomUUID(), SITE_ID, check.id, course, firedAt, actor);
      /* The actual fire — held items of this course go to KDS now via the shared
         fire path (same tickets, inventory, totals as /send). When nothing is
         held the fire is still recorded (and audited) for timing. */
      const core = fireHeldItemsToKdsCore(check, heldNow, actor);
      persistTotals(check.id);
      /* Dedicated audit entry so every course fire is traceable. */
      db.prepare(`INSERT INTO approval_audit (site_id, actor, approver, action, check_id, item_id, shift_id, before_json, after_json, details, created_at)
        VALUES (?, ?, ?, 'course_fire', ?, NULL, NULL, NULL, NULL, ?, ?)`)
        .run(SITE_ID, actor, actor, check.id,
          JSON.stringify({ course, fired_at: firedAt, refire: !!existingNow, items_sent: core.sent, item_ids: heldNow.map((i) => i.id), ticket_ids: core.tickets.map((t) => t.id) }),
          firedAt);
      return { ...core, refire: !!existingNow };
    });
  } catch (e) {
    if (e instanceof FireConflict) return res.status(409).json({ error: e.message });
    throw e;
  }
  for (const ticket of result.tickets) broadcastTicket(ticket);
  broadcastCheckUpdated(check.id);
  res.json({ ok: true, course, fired_at: firedAt, refire: result.refire, sent: result.sent, tickets: result.tickets });
});

/* Phase 3A (P1): editable check metadata — guest count, tab name, coursing.
 * Shrinking guest_count is blocked when billable lines or seat names sit
 * beyond the new count (re-seat or split first). */
app.patch('/api/checks/:id', serverPlus(), (req, res) => {
  const b = req.body || {};
  const check = db.prepare('SELECT * FROM checks WHERE id = ? AND site_id = ?').get(req.params.id, SITE_ID);
  if (!check) return res.status(404).json({ error: 'Check not found' });
  if (check.status !== 'open') return res.status(400).json({ error: `Cannot edit a ${check.status} check` });
  const patch = {};
  if (b.tab_name !== undefined) {
    if (b.tab_name !== null && (typeof b.tab_name !== 'string' || b.tab_name.length > 40)) {
      return res.status(400).json({ error: 'tab_name must be a string of at most 40 characters' });
    }
    patch.tab_name = b.tab_name === null ? null : b.tab_name.trim() || null;
  }
  if (b.guest_count !== undefined) {
    if (!isInt(b.guest_count) || b.guest_count < 1 || b.guest_count > 24) {
      return res.status(400).json({ error: 'guest_count must be an integer between 1 and 24' });
    }
    if (b.guest_count < check.guest_count) {
      const beyond = db.prepare(
        `SELECT COUNT(*) AS n FROM check_items WHERE check_id = ? AND state IN ${BILLABLE_STATES} AND seat > ?`
      ).get(check.id, b.guest_count).n;
      let named = 0;
      try {
        named = db.prepare('SELECT COUNT(*) AS n FROM check_seats WHERE site_id = ? AND check_id = ? AND seat > ?')
          .get(SITE_ID, check.id, b.guest_count).n;
      } catch { /* table owned by parity_orders migrate */ }
      if (beyond > 0 || named > 0) {
        return res.status(400).json({ error: `Seat(s) beyond ${b.guest_count} still have items or guest names — re-seat first` });
      }
    }
    patch.guest_count = b.guest_count;
  }
  if (b.coursing !== undefined) {
    if (!['off', 'optional', 'required'].includes(b.coursing)) {
      return res.status(400).json({ error: "coursing must be one of off|optional|required" });
    }
    patch.coursing = b.coursing;
  }
  /* Phase 3A (NG-E): order-level notes (SpotOn V3 1:55 — "add notes to the
     entire order"). ≤500 chars, clearable with null; flows to KDS tickets. */
  if (b.order_note !== undefined) {
    if (b.order_note !== null && (typeof b.order_note !== 'string' || b.order_note.length > 500)) {
      return res.status(400).json({ error: 'order_note must be a string of at most 500 characters' });
    }
    patch.order_note = b.order_note === null ? null : b.order_note.trim() || null;
  }
  if (!Object.keys(patch).length) {
    return res.status(400).json({ error: 'Nothing to update — send guest_count, tab_name, coursing, or order_note' });
  }
  const before = { guest_count: check.guest_count, tab_name: check.tab_name, coursing: check.coursing || 'off', order_note: check.order_note || null };
  const sets = Object.keys(patch).map((k) => `${k} = ?`).join(', ');
  db.prepare(`UPDATE checks SET ${sets} WHERE id = ?`).run(...Object.values(patch), check.id);
  const t = persistTotals(check.id);
  broadcastCheckUpdated(check.id);
  auditApproval(req, 'edit_check', { check_id: check.id }, { before, after: Object.assign({}, before, patch) });
  res.json(Object.assign(checkResponse(check.id), { totals: t }));
});

app.post('/api/checks/:id/items', serverPlus(), (req, res) => {
  /* Phase 1B idempotency (offline outbox): a queued line carries a
     per-line idempotency_key (see flushOutboxLegacy in app.js) so a
     retried flush replays the stored response instead of duplicating
     the line on the check. Replay comes FIRST, before any
     state-dependent validation: the line already landed, and the
     retry only needs its original response back (its item id feeds
     the client id map). Requests without a key — the online HOLD
     path, older queued payloads — are byte-identical to before. */
  const ikey = idemKeyFrom(req);
  if (ikey) {
    const rp = idemReplay('check_items', ikey);
    if (rp) return res.status(rp.status).json(rp.body);
  }
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
  // Phase 3A (P0-6): group-aware modifier validation — required/min/max
  // enforced, 86'd options rejected, prices taken from the menu option.
  // (Phase 1B money audit preserved: client prices are never trusted.)
  const rmod = resolveModifiers(menuItem.id, modifiers);
  if (rmod.error) return res.status(400).json({ error: rmod.error });
  const cleanMods = rmod.modifiers;
  // Phase 3A (P0-2): per-line special request + allergy flag.
  const b = req.body || {};
  let note = null;
  if (b.note !== undefined && b.note !== null) {
    if (typeof b.note !== 'string' || b.note.length > 140) {
      return res.status(400).json({ error: 'note must be a string of at most 140 characters' });
    }
    note = b.note.trim() || null;
  }
  const allergy = b.allergy ? 1 : 0;
  let allergyDetail = null;
  if (b.allergy_detail !== undefined && b.allergy_detail !== null) {
    if (typeof b.allergy_detail !== 'string' || b.allergy_detail.length > 140) {
      return res.status(400).json({ error: 'allergy_detail must be a string of at most 140 characters' });
    }
    allergyDetail = b.allergy_detail.trim() || null;
  }
  /* Ring-time course: a server may pick the line's course while adding
     it (add-item modal / staged quick bar), not only afterwards via the
     item PATCH. Absent → the menu item's default course (the historical
     behavior); null → explicitly no course (mirrors the PATCH contract);
     anything else must be a real course. */
  let lineCourse = menuItem.course;
  if (b.course !== undefined) {
    if (b.course !== null && !COURSES.has(b.course)) {
      return res.status(400).json({ error: 'course must be one of drink|appetizer|entree|dessert' });
    }
    lineCourse = b.course;
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

  /* Reserve the idempotency key only AFTER validation passes: a
     rejected line must not burn its key, or the corrected retry
     could never land. A 'processing' verdict means the first attempt
     is in flight (or died mid-flight inside the stale window) —
     answer 409 like the money endpoints and let the retry replay
     the stored response once it completes. */
  let idem = null;
  if (ikey) {
    const rsv = idemReserve('check_items', ikey);
    if (rsv.state === 'replay') return res.status(rsv.status).json(rsv.body);
    if (rsv.state === 'processing') return res.status(409).json({ error: 'Duplicate request in progress — retry shortly' });
    idem = ikey;
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
      if (idem) idemClear('check_items', idem);
      return res.status(400).json({ error: 'That item was just 86\'d — please reorder' });
    }
    const r = db.prepare(
      `INSERT INTO check_items (uuid, check_id, menu_item_id, seat, qty, unit_price_cents, modifiers_json, course, state, added_at,
         note, allergy, allergy_detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'held', ?, ?, ?, ?)`
    ).run(crypto.randomUUID(), check.id, menuItem.id, seat, qty, unitPrice, JSON.stringify(cleanMods), lineCourse, nowIso(),
      note, allergy, allergyDetail);
    item = db.prepare('SELECT ci.*, mi.name FROM check_items ci LEFT JOIN menu_items mi ON mi.id = ci.menu_item_id WHERE ci.id = ?').get(r.lastInsertRowid);
    persistTotals(check.id);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    if (idem) idemClear('check_items', idem);
    throw e;
  }
  const out = itemView(item);
  if (idem) idemStore('check_items', idem, 201, out);
  broadcastCheckUpdated(check.id);
  res.status(201).json(out);
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
 * POST /api/checks/:id/void {manager_pin?, reason}
 * Phase 3A (NG-B): full-check void — Toast overflow → "Void order" parity.
 * - Manager role approves directly; a server must supply a manager PIN
 *   (verifyManagerPin) — the void is always manager-gated and audit-logged.
 * - reason is required (≤120 chars).
 * - Rejected when the check has any payments (route to refund instead).
 * - Voids every billable line (held/sent/fulfilled → cancelled) in one
 *   transaction, pushes KDS cancellation deltas for fired lines, marks the
 *   check 'void', and broadcasts.
 */
app.post('/api/checks/:id/void', serverPlus(), (req, res) => {
  const b = req.body || {};
  const checkId = Number(req.params.id);
  const check = db.prepare('SELECT * FROM checks WHERE id = ? AND site_id = ?').get(checkId, SITE_ID);
  if (!check) return res.status(404).json({ error: 'Check not found' });
  if (check.status !== 'open') return res.status(400).json({ error: `Cannot void a ${check.status} check` });
  const reason = cleanLabel(b.reason);
  if (!reason) return res.status(400).json({ error: 'A void reason is required' });
  if (reason.length > 120) return res.status(400).json({ error: 'reason must be at most 120 characters' });
  /* Daniel's policy (2026-09-26): whole-check void requires a FRESH manager PIN
     every time, no exceptions — even a logged-in manager must re-enter their PIN. */
  const mgr = verifyManagerPin(b.manager_pin);
  if (!mgr) {
    return res.status(403).json({ error: "Voiding a whole check needs a manager's PIN — enter it fresh every time", need_manager_pin: true });
  }
  const payCount = db.prepare('SELECT COUNT(*) AS n FROM payments WHERE check_id = ?').get(check.id).n;
  if (payCount > 0) {
    return res.status(400).json({ error: 'This check has payments — use refund instead of void', route_to_refund: true });
  }
  const billable = db.prepare(
    `SELECT ci.*, mi.name FROM check_items ci LEFT JOIN menu_items mi ON mi.id = ci.menu_item_id
     WHERE ci.check_id = ? AND ci.state IN ${BILLABLE_STATES} ORDER BY ci.id`
  ).all(check.id);
  const voidedIds = billable.map((i) => i.id);
  const firedIds = new Set(billable.filter((i) => i.state !== 'held').map((i) => i.id));
  let kdsDeltas = 0;
  const at = nowIso();
  withTransaction(() => {
    if (voidedIds.length) {
      db.prepare(`UPDATE check_items SET state = 'cancelled' WHERE id IN (${voidedIds.map(() => '?').join(',')})`)
        .run(...voidedIds);
    }
    // KDS cancellation notices for lines the kitchen already fired.
    const tickets = db.prepare('SELECT * FROM kds_tickets WHERE check_id = ?').all(check.id);
    for (const t of tickets) {
      const lines = parseJson(t.items_json, []);
      const hit = lines.filter((l) => firedIds.has(l.item_id));
      if (!hit.length) continue;
      const deltas = parseJson(t.deltas_json, []);
      for (const l of hit) {
        deltas.push({ type: 'void', item_id: l.item_id, name: l.name, qty: l.qty, seat: l.seat,
          actor: req.user ? req.user.name : '?', manager: mgr.name, reason, voided_at: at });
        kdsDeltas += 1;
      }
      db.prepare('UPDATE kds_tickets SET deltas_json = ? WHERE id = ?').run(JSON.stringify(deltas), t.id);
      broadcastTicketUpdated(ticketView(db.prepare('SELECT * FROM kds_tickets WHERE id = ?').get(t.id)));
    }
    db.prepare("UPDATE checks SET status = 'void', closed_at = ? WHERE id = ?").run(at, check.id);
  });
  const t = persistTotals(check.id);
  broadcastCheckUpdated(check.id);
  auditApproval(req, 'void_check', { check_id: check.id },
    { approver: mgr.name, approver_id: mgr.id,
      before: { status: 'open', billable_items: voidedIds.length },
      after: { status: 'void' }, reason, voided_items: voidedIds.length, kds_deltas: kdsDeltas });
  res.json({ voided: check.id, status: 'void', voided_items: voidedIds.length,
    approved_by: mgr.name, kds_deltas: kdsDeltas, totals: t });
});


/**
 * POST /api/checks/:id/transfer {to_server_id, from_server_id, manager_pin?, reason?, idempotency_key?}
 * Check transfer / server re-claim (claim/overlap design §3.6).
 * - Moves an OPEN check to another server (shift change, section handoff) or
 *   lets a server claim an unassigned (kiosk/QR) check: from_server_id null
 *   means "I expect it to be unassigned".
 * - Optimistic concurrency on the current holder: the conditional UPDATE is
 *   the arbiter — exactly one contender wins a race. A lost race returns 409
 *   with the current holder's identity (§3.4 contract), never a silent 200.
 * - Who may transfer: the check's current holder, anyone claiming an
 *   unassigned check, or — for someone else's check — a FRESH manager PIN
 *   (verifyManagerPin, same bar as whole-check void; always audit-logged).
 * - Accepts Idempotency-Key (header or body) via the idemReserve framework:
 *   a retried transfer replays the stored outcome instead of 409ing.
 */
app.post('/api/checks/:id/transfer', serverPlus(), (req, res) => {
  const b = req.body || {};
  const checkId = Number(req.params.id);
  const ikey = req.get('Idempotency-Key') || b.idempotency_key || null;
  let idem = null;
  if (ikey) {
    const rsv = idemReserve('transfers', ikey);
    if (rsv.state === 'replay') return res.status(rsv.status).json(rsv.body);
    if (rsv.state === 'processing')
      return res.status(409).json({ error: 'Duplicate request in progress' });
    idem = ikey;
  }
  const fail = (status, body) => {
    if (idem) idemClear('transfers', idem);
    return res.status(status).json(body);
  };
  try {
    const check = db.prepare('SELECT * FROM checks WHERE id = ? AND site_id = ?').get(checkId, SITE_ID);
    if (!check) return fail(404, { error: 'Check not found' });
    if (check.status !== 'open')
      return fail(400, { error: `Cannot transfer a ${check.status} check` });

    const toId = b.to_server_id;
    if (!isInt(toId) || toId < 1)
      return fail(400, { error: 'to_server_id must be a user id' });
    const target = db.prepare(
      "SELECT id, name, role FROM users WHERE id = ? AND site_id = ? AND role IN ('server','manager') AND COALESCE(active, 1) = 1"
    ).get(toId, SITE_ID);
    if (!target)
      return fail(400, { error: 'to_server_id must be an active server or manager' });

    // from_server_id is required (null = "I expect it unassigned") so the
    // client states the holder it saw; the UPDATE below enforces it.
    if (!('from_server_id' in b) || (b.from_server_id !== null && (!isInt(b.from_server_id) || b.from_server_id < 1)))
      return fail(400, { error: 'from_server_id is required (null when the check is unassigned)' });
    const fromId = b.from_server_id;

    if (toId === check.server_id)
      return fail(200, { transferred: check.id, server_id: check.server_id, noop: true });

    /* Authorization (claim/overlap design §3.6):
       - from_server_id === caller: acting as the (believed) holder — a handoff.
         The conditional UPDATE below arbitrates; a stale view loses with 409.
       - from_server_id === null: claiming an unassigned check. The UPDATE's
         `server_id IS NULL` arbitrates; losers get 409 naming the holder.
       - from_server_id === someone else: acting on another holder's check —
         needs a FRESH manager PIN (override mode, bypasses the holder check,
         always audit-logged). Without it: 403.
       A valid manager PIN always selects override mode. */
    const callerId = req.user ? req.user.id : null;
    let mgr = null, override = false;
    if (fromId !== null && fromId !== callerId) {
      mgr = verifyManagerPin(b.manager_pin);
      if (!mgr)
        return fail(403, { error: "Transferring another server's check needs a manager's PIN", need_manager_pin: true });
      override = true;
    }

    const holderName = (id) => id == null ? null
      : (db.prepare('SELECT name FROM users WHERE id = ?').get(id) || {}).name || null;
    const lostRace = () => {
      const cur = db.prepare('SELECT server_id, status FROM checks WHERE id = ?').get(checkId);
      if (!cur || cur.status !== 'open')
        return fail(409, { error: 'Check changed during transfer', check_id: checkId, status: cur ? cur.status : 'gone' });
      const hid = cur.server_id;
      return fail(409, {
        error: hid == null ? 'Check is unassigned' : 'Check holder changed',
        check_id: checkId, held_by_id: hid, held_by: holderName(hid),
      });
    };

    let changes;
    if (override) {
      changes = db.prepare(
        "UPDATE checks SET server_id = ? WHERE id = ? AND site_id = ? AND status = 'open'"
      ).run(toId, checkId, SITE_ID).changes;
    } else if (fromId == null) {
      changes = db.prepare(
        "UPDATE checks SET server_id = ? WHERE id = ? AND site_id = ? AND status = 'open' AND server_id IS NULL"
      ).run(toId, checkId, SITE_ID).changes;
    } else {
      changes = db.prepare(
        "UPDATE checks SET server_id = ? WHERE id = ? AND site_id = ? AND status = 'open' AND server_id = ?"
      ).run(toId, checkId, SITE_ID, fromId).changes;
    }
    if (changes !== 1) return lostRace();

    const reason = cleanLabel(b.reason || '');
    broadcastCheckUpdated(checkId);
    auditApproval(req, 'check_transfer', { check_id: checkId },
      { before: { server_id: check.server_id, server_name: holderName(check.server_id) },
        after: { server_id: toId, server_name: target.name },
        override, approver: mgr ? mgr.name : null, reason: reason || undefined });
    const out = { transferred: checkId, server_id: toId, server_name: target.name,
      from_server_id: check.server_id, override, approved_by: mgr ? mgr.name : undefined };
    if (idem) idemStore('transfers', idem, 200, out);
    return res.json(out);
  } catch (e) {
    if (idem) idemClear('transfers', idem);
    throw e;
  }
});


/**
 * PATCH /api/checks/:id/items/:item_id {qty?, modifiers?, seat?, course?, note?, allergy?, allergy_detail?,
 *   manager_pin?, manager_pin_hash?, approval_nonce?}
 * Edit an item on an open check: change qty and/or modifiers.
 * (Daniel's hotfix — kept verbatim; the "Phase 3A ext" blocks below extend it
 * with seat reassignment, course change, and per-line special-request /
 * allergy flags for Toast/SpotOn parity. When merging upstream, keep the
 * hotfix and apply only the marked extension blocks.)
 * - held items: the server/kitchen can edit directly (nothing fired yet).
 * - sent/fulfilled items: the kitchen already fired — requires manager
 *   approval (same live-PIN or offline hash+nonce mechanism as void-item),
 *   and the change is audit-logged with before/after.
 * Modifier validation mirrors POST /items (now group-aware: required/min/max
 * and 86'd options enforced server-side). Fixed-price items keep the menu
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
    /* Phase 3A ext: group-aware validation — required/min/max enforced, 86'd
       options rejected, prices taken from the menu option (never the client). */
    const rmod = resolveModifiers(item.menu_item_id, b.modifiers);
    if (rmod.error) return res.status(400).json({ error: rmod.error });
    patch.modifiers = rmod.modifiers;
  }
  /* Phase 3A ext: seat reassignment (Toast Order-by-Seat parity), course change,
     per-line special request + allergy flag (SpotOn parity). */
  if (b.seat !== undefined) {
    if (!isInt(b.seat) || b.seat < 1 || b.seat > check.guest_count) {
      return res.status(400).json({ error: `seat must be an integer between 1 and ${check.guest_count}` });
    }
    patch.seat = b.seat;
  }
  if (b.course !== undefined) {
    const COURSES = ['drink', 'appetizer', 'entree', 'dessert'];
    if (b.course !== null && !COURSES.includes(b.course)) {
      return res.status(400).json({ error: 'course must be one of drink|appetizer|entree|dessert' });
    }
    patch.course = b.course;
  }
  if (b.note !== undefined) {
    if (b.note !== null && (typeof b.note !== 'string' || b.note.length > 140)) {
      return res.status(400).json({ error: 'note must be a string of at most 140 characters' });
    }
    patch.note = b.note === null ? null : b.note.trim();
  }
  if (b.allergy !== undefined) patch.allergy = b.allergy ? 1 : 0;
  if (b.allergy_detail !== undefined) {
    if (b.allergy_detail !== null && (typeof b.allergy_detail !== 'string' || b.allergy_detail.length > 140)) {
      return res.status(400).json({ error: 'allergy_detail must be a string of at most 140 characters' });
    }
    patch.allergy_detail = b.allergy_detail === null ? null : b.allergy_detail.trim();
  } else if (b.allergy === false) {
    patch.allergy_detail = null; // clearing the flag clears the detail
  }
  if (!Object.keys(patch).length) {
    return res.status(400).json({ error: 'Nothing to update — send qty, modifiers, seat, course, note, or allergy' });
  }
  let approval = null;
  if (item.state !== 'held') {
    approval = resolveVoidApproval(req, b, checkId, itemId, res);
    if (!approval) return;
    if (approval.offline && approval.replay) {
      // Idempotent retry after a dropped response — the edit already applied.
      const cur = db.prepare('SELECT ci.*, mi.name FROM check_items ci LEFT JOIN menu_items mi ON mi.id = ci.menu_item_id WHERE ci.id = ?').get(item.id);
      /* Phase 3A ext: wrap the hotfix's flat itemView in {item, fired} for
         test21/UI compatibility — flat fields kept at top level too. */
      const curFlat = itemView(cur);
      return res.json(Object.assign({}, curFlat, { item: curFlat, fired: item.state !== 'held',
        already_applied: true, approved_by: approval.mgr.name, kds_deltas: 0 }));
    }
  }
  const before = { qty: item.qty, modifiers: parseJson(item.modifiers_json, []),
    seat: item.seat, course: item.course, note: item.note || null,
    allergy: !!item.allergy, allergy_detail: item.allergy_detail || null };
  /* Phase 3A ext: no-change edit is a 400 (matches the hotfix-era contract
     test21 asserts) — compare the would-be after against before, with
     modifiers normalized so key order can't fake a change. */
  const normMods = (arr) => (arr || []).map((m) => [m.name, m.price_delta_cents || 0, m.option_id || null, m.note || null].join('|')).sort();
  const after = Object.assign({}, before);
  if (patch.qty !== undefined) after.qty = patch.qty;
  if (patch.modifiers !== undefined) after.modifiers = patch.modifiers;
  if (patch.seat !== undefined) after.seat = patch.seat;
  if (patch.course !== undefined) after.course = patch.course;
  if (patch.note !== undefined) after.note = patch.note;
  if (patch.allergy !== undefined) after.allergy = !!patch.allergy;
  if (patch.allergy_detail !== undefined) after.allergy_detail = patch.allergy_detail;
  const same = after.qty === before.qty && after.seat === before.seat && after.course === before.course &&
    after.note === before.note && after.allergy === before.allergy && after.allergy_detail === before.allergy_detail &&
    JSON.stringify(normMods(after.modifiers)) === JSON.stringify(normMods(before.modifiers));
  if (same) {
    return res.status(400).json({ error: 'No changes — the item already has these values' });
  }
  if (patch.qty !== undefined) db.prepare('UPDATE check_items SET qty = ? WHERE id = ?').run(patch.qty, item.id);
  if (patch.modifiers !== undefined) db.prepare('UPDATE check_items SET modifiers_json = ? WHERE id = ?').run(JSON.stringify(patch.modifiers), item.id);
  /* Phase 3A ext */
  if (patch.seat !== undefined) db.prepare('UPDATE check_items SET seat = ? WHERE id = ?').run(patch.seat, item.id);
  if (patch.course !== undefined) db.prepare('UPDATE check_items SET course = ? WHERE id = ?').run(patch.course, item.id);
  if (patch.note !== undefined) db.prepare('UPDATE check_items SET note = ? WHERE id = ?').run(patch.note, item.id);
  if (patch.allergy !== undefined) db.prepare('UPDATE check_items SET allergy = ? WHERE id = ?').run(patch.allergy, item.id);
  if (patch.allergy_detail !== undefined) db.prepare('UPDATE check_items SET allergy_detail = ? WHERE id = ?').run(patch.allergy_detail, item.id);
  if (approval && approval.offline && !approval.replay) consumeOfflineApproval(approval.nonce, check.id, item.id, approval.mgr);
  const t = persistTotals(check.id);
  broadcastCheckUpdated(check.id);
  const updated = db.prepare('SELECT ci.*, mi.name FROM check_items ci LEFT JOIN menu_items mi ON mi.id = ci.menu_item_id WHERE ci.id = ?').get(item.id);
  if (approval) {
    auditApproval(req, 'edit_item', { check_id: check.id, item_id: item.id },
      { approver: approval.mgr.name, approver_id: approval.mgr.id,
        before, after: { qty: updated.qty, modifiers: parseJson(updated.modifiers_json, []),
        seat: updated.seat, course: updated.course, note: updated.note || null,
        allergy: !!updated.allergy, allergy_detail: updated.allergy_detail || null },
        offline: approval.offline || undefined, approval_nonce: approval.offline ? approval.nonce : undefined });
  }
  /* Phase 3A ext: post-fire edits land highlighted on the kitchen's open
     tickets (deltas), not as a reprint. Held-item edits never fired. */
  let kdsDeltas = 0;
  if (item.state !== 'held') {
    try {
      const tickets = db.prepare("SELECT * FROM kds_tickets WHERE check_id = ? AND site_id = ? AND status IN ('new','in_progress')").all(check.id, SITE_ID);
      const delta = { type: 'edit', item_id: item.id, name: item.name,
        before, after: { qty: updated.qty, modifiers: parseJson(updated.modifiers_json, []),
          seat: updated.seat, course: updated.course, note: updated.note || null,
          allergy: !!updated.allergy, allergy_detail: updated.allergy_detail || null },
        actor: req.user ? req.user.name : '?', manager: approval ? approval.mgr.name : null,
        edited_at: new Date().toISOString() };
      for (const t of tickets) {
        const lines = parseJson(t.items_json, []);
        if (!lines.some((l) => l.item_id === item.id)) continue;
        const deltas = parseJson(t.deltas_json, []);
        deltas.push(delta);
        db.prepare('UPDATE kds_tickets SET deltas_json = ? WHERE id = ?').run(JSON.stringify(deltas), t.id);
        kdsDeltas += 1;
        broadcastTicketUpdated(ticketView(db.prepare('SELECT * FROM kds_tickets WHERE id = ?').get(t.id)));
      }
    } catch { /* deltas_json owned by parity_orders migrate */ }
  }
  /* Phase 3A ext: wrap the hotfix's flat itemView in {item, fired} for
     test21/UI compatibility — AND keep the flat itemView fields at top level
     for the item-edit hotfix contract (test17) and older clients. */
  const flat = itemView(updated);
  res.json(Object.assign({}, flat,
    { item: flat, fired: item.state !== 'held' },
    approval ? { approved_by: approval.mgr.name } : {}, { totals: t, kds_deltas: kdsDeltas }));
});
/**
 * POST /api/checks/:id/items/:item_id/discount {amount_cents? | percent?, reason, manager_pin?}
 * Item-level discount / comp (Toast/SpotOn parity, P0-1).
 * - amount_cents XOR percent (percent is round-half-up of the pre-discount line).
 * - 0 < discount <= line gross: a 100% discount zeroes the line, never negative.
 * - reason required (audit). Held lines: server+ may discount (audit-logged).
 *   Sent/fulfilled lines: manager PIN required (same mechanism as void-item).
 * - Replaces any existing line discount (single discount per line); the
 *   before/after is audit-logged. Discounts survive splits (prorated).
 */
app.post('/api/checks/:id/items/:item_id/discount', serverPlus(), (req, res) => {
  const b = req.body || {};
  const checkId = Number(req.params.id);
  const itemId = Number(req.params.item_id);
  const check = db.prepare('SELECT * FROM checks WHERE id = ? AND site_id = ?').get(checkId, SITE_ID);
  if (check.status !== 'open') return res.status(400).json({ error: `Cannot discount items on a ${check.status} check` });
  const item = db.prepare('SELECT ci.*, mi.name FROM check_items ci LEFT JOIN menu_items mi ON mi.id = ci.menu_item_id WHERE ci.id = ? AND ci.check_id = ?')
    .get(itemId, check.id);
  if (!item) return res.status(404).json({ error: 'Item not found on this check' });
  if (item.state === 'cancelled') return res.status(400).json({ error: 'Cannot discount a voided item' });
  const gross = lineGross(item);
  if (gross <= 0) return res.status(400).json({ error: 'Cannot discount a zero-value line' });
  let discount;
  if (b.amount_cents !== undefined && b.percent !== undefined) {
    return res.status(400).json({ error: 'Send amount_cents or percent, not both' });
  } else if (b.amount_cents !== undefined) {
    if (!isInt(b.amount_cents) || b.amount_cents <= 0) {
      return res.status(400).json({ error: 'amount_cents must be a positive integer' });
    }
    discount = b.amount_cents;
  } else if (b.percent !== undefined) {
    if (typeof b.percent !== 'number' || !(b.percent > 0) || b.percent > 100) {
      return res.status(400).json({ error: 'percent must be a number between 0 (exclusive) and 100' });
    }
    discount = Math.round(gross * b.percent / 100);
  } else {
    return res.status(400).json({ error: 'amount_cents or percent is required' });
  }
  if (discount <= 0) return res.status(400).json({ error: 'Discount must be greater than zero' });
  if (discount > gross) {
    return res.status(400).json({ error: `Discount ${discount}¢ exceeds the line value of ${gross}¢` });
  }
  const reason = typeof b.reason === 'string' ? b.reason.trim().slice(0, 120) : '';
  if (!reason) return res.status(400).json({ error: 'reason is required' });

  // Sent/fulfilled lines need manager approval (money out the door).
  let approval = null;
  if (item.state !== 'held') {
    approval = resolveVoidApproval(req, b, check.id, item.id, res);
    if (!approval) return;
  }
  const before = { discount_cents: item.discount_cents || 0, discount_reason: item.discount_reason || null };
  db.prepare('UPDATE check_items SET discount_cents = ?, discount_reason = ? WHERE id = ?')
    .run(discount, reason, item.id);
  const t = persistTotals(check.id);
  broadcastCheckUpdated(check.id);
  auditApproval(req, 'item_discount', { check_id: check.id, item_id: item.id },
    Object.assign({
      approver: approval ? approval.mgr.name : (req.user ? req.user.name : '?'),
      approver_id: approval ? approval.mgr.id : (req.user ? req.user.id : null),
      before, after: { discount_cents: discount, discount_reason: reason }, reason,
    }, approval && approval.offline ? { offline: true, approval_nonce: approval.nonce } : {}));
  const updated = db.prepare('SELECT ci.*, mi.name FROM check_items ci LEFT JOIN menu_items mi ON mi.id = ci.menu_item_id WHERE ci.id = ?').get(item.id);
  res.json(Object.assign(itemView(updated), { totals: t },
    approval ? { approved_by: approval.mgr.name } : {}));
});

/**
 * POST /api/checks/:id/items/:item_id/duplicate
 * Duplicate a line (Toast/SpotOn parity) — copies qty, modifiers, seat, course,
 * note, allergy. The duplicate starts as 'held' (not fired).
 */
app.post('/api/checks/:id/items/:item_id/duplicate', serverPlus(), (req, res) => {
  const checkId = Number(req.params.id);
  const itemId = Number(req.params.item_id);
  const check = db.prepare('SELECT * FROM checks WHERE id = ? AND site_id = ?').get(checkId, SITE_ID);
  if (!check) return res.status(404).json({ error: 'Check not found' });
  if (check.status !== 'open') return res.status(400).json({ error: `Cannot duplicate items on a ${check.status} check` });
  const item = db.prepare('SELECT ci.*, mi.name FROM check_items ci LEFT JOIN menu_items mi ON mi.id = ci.menu_item_id WHERE ci.id = ? AND ci.check_id = ?')
    .get(itemId, check.id);
  if (!item) return res.status(404).json({ error: 'Item not found on this check' });
  if (item.state === 'cancelled') return res.status(400).json({ error: 'Cannot duplicate a voided item' });
  const r = db.prepare(
    `INSERT INTO check_items (uuid, check_id, menu_item_id, seat, qty, unit_price_cents, modifiers_json, course, state, added_at,
       note, allergy, allergy_detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'held', ?, ?, ?, ?)`
  ).run(crypto.randomUUID(), check.id, item.menu_item_id, item.seat, item.qty, item.unit_price_cents,
    item.modifiers_json, item.course, nowIso(), item.note, item.allergy, item.allergy_detail);
  const dup = db.prepare('SELECT ci.*, mi.name FROM check_items ci LEFT JOIN menu_items mi ON mi.id = ci.menu_item_id WHERE ci.id = ?').get(r.lastInsertRowid);
  const t = persistTotals(check.id);
  broadcastCheckUpdated(check.id);
  res.status(201).json(Object.assign(itemView(dup), { totals: t }));
});
/**
 * POST /api/checks/:id/items/:item_id/duplicate — repeat-item action (P1).

/**
 * POST /api/checks/:id/comp {amount_cents | percent, manager_pin, reason}
 * Manager-approved check-level discount. Accumulates on the check (multiple
 * comps allowed, each audit-logged). Reason is required — comps without a
 * reason are how money walks out the door.
 */
app.post('/api/checks/:id/comp', serverPlus(), (req, res) => {
  const b = req.body || {};
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
/* Core KDS fire: mark held items sent, create station tickets, deplete
   inventory, broadcast. Shared by /send and /fire-course so a course fire
   actually puts food on the KDS — not just a timestamp. Returns {sent, tickets}. */
/* Core KDS fire: mark held items sent, create station tickets, deplete
   inventory. Shared by /send and /fire-course so a course fire actually puts
   food on the KDS — not just a timestamp.
   DB-ONLY: runs inside the caller's transaction (no broadcasts here) so the
   item/inventory/ticket writes commit or roll back as one unit. Returns
   {sent, tickets} with full ticket views; the caller broadcasts after commit. */
function fireHeldItemsToKdsCore(check, held, actor) {
  const sentAt = nowIso();
  const table = check.table_id ? db.prepare('SELECT label FROM tables WHERE id = ?').get(check.table_id) : null;
  const serverUser = check.server_id ? db.prepare('SELECT name FROM users WHERE id = ?').get(check.server_id) : null;

  const byStation = new Map();
  const markSent = db.prepare("UPDATE check_items SET state = 'sent', sent_at = ? WHERE id = ?");
  for (const it of held) {
    markSent.run(sentAt, it.id);
    const station = it.station || 'expediter';
    if (!byStation.has(station)) byStation.set(station, []);
    byStation.get(station).push({
      item_id: it.id,
      name: it.name,
      seat: it.seat,
      qty: it.qty,
      course: it.course,
      modifiers: parseJson(it.modifiers_json, []),
      /* Allergy + special-request note ride the ticket to KDS (schema:
       * check_items.note / .allergy / .allergy_detail — shared contract
       * with order-entry; KDS only renders, never edits). */
      note: it.note || null,
      allergy: it.allergy ? 1 : 0,
      allergy_detail: it.allergy_detail || null,
    });
  }
  /* Ledger actor: the sending user when the route threaded one through,
     else the check's server, else 'system'. */
  depleteInventoryForItems(held, actor || (serverUser ? serverUser.name : null)); // phase 3C: ingredient-level depletion from real sales

  /* Tickets are created in the SAME transaction as the item/inventory writes:
     a crash mid-fire can never leave items marked sent with no KDS ticket. */
  const tickets = [];
  const insTicket = db.prepare(
    "INSERT INTO kds_tickets (uuid, check_id, site_id, station, table_label, server_name, items_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'new', ?)"
  );
  for (const [station, items] of byStation) {
    const r = insTicket.run(
      crypto.randomUUID(), check.id, SITE_ID, station,
      checkLocationLabel(table, check),
      serverUser ? serverUser.name : null,
      JSON.stringify(items), sentAt
    );
    tickets.push(ticketView(db.prepare('SELECT * FROM kds_tickets WHERE id = ?').get(r.lastInsertRowid)));
    /* QA hook (test-scoped, env-gated): EXPOLINE_TEST_FAIL_KDS=1 forces a
       mid-fire failure AFTER the first ticket insert — so forced-failure
       tests can prove the course-fire transaction rolls back atomically
       (items stay HELD, inventory restored, no fire/audit rows). Inert in
       production unless the env var is explicitly set. */
    if (process.env.EXPOLINE_TEST_FAIL_KDS === '1') {
      throw new Error('EXPOLINE_TEST_FAIL_KDS: forced KDS ticket-insertion failure mid-fire');
    }
  }
  return { sent: held.length, tickets };
}

function fireHeldItemsToKds(check, held, actor) {
  const result = withTransaction(() => fireHeldItemsToKdsCore(check, held, actor));
  for (const ticket of result.tickets) broadcastTicket(ticket); // push {type:'ticket'} to that station's subscribers
  persistTotals(check.id);
  broadcastCheckUpdated(check.id);
  return { sent: result.sent, tickets: result.tickets };
}

app.post('/api/checks/:id/send', serverPlus(), (req, res) => {
  const check = db.prepare('SELECT * FROM checks WHERE id = ? AND site_id = ?').get(req.params.id, SITE_ID);
  if (!check) return res.status(404).json({ error: 'Check not found' });
  if (check.status !== 'open') return res.status(400).json({ error: `Cannot send items on a ${check.status} check` });
  const b = req.body || {};

  let held = db.prepare(
    "SELECT ci.*, mi.name, mi.station FROM check_items ci JOIN menu_items mi ON mi.id = ci.menu_item_id WHERE ci.check_id = ? AND ci.state = 'held' ORDER BY ci.added_at, ci.id"
  ).all(check.id);
  // Phase 3A: selective send — item_ids and/or courses filters
  if (b.item_ids !== undefined) {
    if (!Array.isArray(b.item_ids)) return res.status(400).json({ error: 'item_ids must be an array' });
    const ids = new Set(b.item_ids);
    held = held.filter((it) => ids.has(it.id));
  }
  if (b.courses !== undefined) {
    if (!Array.isArray(b.courses)) return res.status(400).json({ error: 'courses must be an array' });
    if (!b.courses.map((c) => String(c).toLowerCase()).includes('all')) {
      const want = new Set(b.courses.map((c) => String(c).toLowerCase()));
      held = held.filter((it) => want.has(String(it.course || '').toLowerCase()));
    }
  }
  if (held.length === 0) return res.json({ sent: 0, tickets: [] });

  /* Phase 3A (P0-7): coursing. When the check requires coursing and the send
     doesn't name items/courses, held items spanning 2+ courses get a 409
     course-selection prompt instead of firing everything. */
  const coursing = check.coursing || 'off';
  if ((coursing === 'required' || coursing === 'optional') && b.item_ids === undefined && b.courses === undefined) {
    const courses = [...new Set(held.map((it) => it.course || 'other'))];
    if (courses.length > 1) {
      return res.status(409).json({
        error: `This check fires by course — choose which course${coursing === 'optional' ? ' (or send all)' : ''} to fire`,
        need_course_selection: true, optional: coursing === 'optional', courses,
      });
    }
  }

  /* Fire via the shared KDS path so /send and /fire-course behave identically. */
  return res.json(fireHeldItemsToKds(check, held, req.user && req.user.name));
});

/* Phase 3A (P0 send-now): one-tap add+fire — items go on the check and straight to KDS. */
app.post('/api/checks/:id/send-now', serverPlus(), (req, res) => {
  const check = db.prepare('SELECT * FROM checks WHERE id = ? AND site_id = ?').get(req.params.id, SITE_ID);
  if (!check) return res.status(404).json({ error: 'Check not found' });
  if (check.status !== 'open') return res.status(400).json({ error: `Cannot send items on a ${check.status} check` });
  const items = (req.body || {}).items;
  if (!Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: 'items must be a non-empty array of order lines' });
  }
  if (items.length > 50) return res.status(400).json({ error: 'At most 50 lines per send-now' });
  /* Validate EVERY line before inserting anything (same rules as
     POST /items). The old loop validated and inserted line by line, so
     a rejection on line N left lines 1..N-1 on the check as orphan
     'held' rows the client never saw; fixing the bad line and
     re-sending then duplicated them (double-fire / double-charge).
     Every rule below is pure (menu row, seat/qty bounds, modifiers,
     price, course — none depends on an earlier insert), so phase 1
     collects the exact rows phase 2 inserts: the first failure
     returns with the same status and body as before, and the check
     is left exactly as it was. */
  const prepared = [];
  for (let li = 0; li < items.length; li++) {
    const line = items[li];
    const { menu_item_id, seat, qty = 1, modifiers = [], unit_price_cents, note, allergy, allergy_detail } = line || {};
    const menuItem = menu_item_id != null
      ? db.prepare('SELECT * FROM menu_items WHERE id = ? AND site_id = ? AND active = 1').get(menu_item_id, SITE_ID)
      : null;
    /* Per-line failures carry their line index + item name so the client
       can name the exact staged line instead of showing a bare reason
       the server cannot act on ("Flavor: please choose at least one" —
       on WHICH line?). The error string itself is unchanged. */
    const lineErr = (status, error) => res.status(status).json({
      error, line_index: li, item_name: menuItem ? menuItem.name : null,
    });
    if (!menuItem) return lineErr(400, 'Valid active menu_item_id is required');
    if (!isInt(seat) || seat < 1 || seat > check.guest_count) {
      return lineErr(400, `seat must be an integer between 1 and ${check.guest_count}`);
    }
    if (!isInt(qty) || qty < 1) return lineErr(400, 'qty must be a positive integer');
    const rmod = resolveModifiers(menuItem.id, modifiers);
    if (rmod.error) return lineErr(400, rmod.error);
    let unitPrice = menuItem.price_cents;
    if (menuItem.price_cents === 0) {
      if (req.user.role !== 'manager') return lineErr(403, 'Market-price items must be priced by a manager');
      if (unit_price_cents == null) return lineErr(400, 'Market-price item requires unit_price_cents');
      unitPrice = unit_price_cents;
    }
    let ln = null;
    if (note !== undefined && note !== null) {
      if (typeof note !== 'string' || note.length > 140) return lineErr(400, 'note must be ≤140 chars');
      ln = note.trim() || null;
    }
    const alg = allergy ? 1 : 0;
    let algD = null;
    if (allergy_detail !== undefined && allergy_detail !== null) {
      if (typeof allergy_detail !== 'string' || allergy_detail.length > 140) return lineErr(400, 'allergy_detail must be ≤140 chars');
      algD = allergy_detail.trim() || null;
    }
    /* Ring-time course, same contract as POST /items: absent → the menu
       item's default; null → no course; otherwise a valid course. */
    let lineCourse = menuItem.course;
    if (line && line.course !== undefined) {
      if (line.course !== null && !COURSES.has(line.course)) {
        return lineErr(400, 'course must be one of drink|appetizer|entree|dessert');
      }
      lineCourse = line.course;
    }
    prepared.push({
      menuItem, seat, qty, unitPrice,
      modifiersJson: JSON.stringify(rmod.modifiers),
      course: lineCourse, note: ln, allergy: alg, allergyDetail: algD,
    });
  }
  // Insert the validated lines and fire them via the standard send logic
  const sentAt = nowIso();
  const table = check.table_id ? db.prepare('SELECT label FROM tables WHERE id = ?').get(check.table_id) : null;
  const serverUser = check.server_id ? db.prepare('SELECT name FROM users WHERE id = ?').get(check.server_id) : null;
  const markSent = db.prepare("UPDATE check_items SET state = 'sent', sent_at = ? WHERE id = ?");
  let seatNames = {};
  try {
    for (const r of db.prepare('SELECT seat, guest_name FROM check_seats WHERE site_id = ? AND check_id = ?').all(SITE_ID, check.id)) {
      seatNames[r.seat] = r.guest_name;
    }
  } catch { /* parity_orders migrate owns this table */ }
  const insertLine = db.prepare(
    `INSERT INTO check_items (uuid, check_id, menu_item_id, seat, qty, unit_price_cents, modifiers_json, course, state, added_at,
       note, allergy, allergy_detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'held', ?, ?, ?, ?)`
  );
  const newTicket = db.prepare(
    `INSERT INTO kds_tickets (uuid, site_id, check_id, station, table_label, server_name, items_json, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'new', ?)`
  );
  /* Insert + fire in ONE transaction, mirroring /send's
     fireHeldItemsToKds: the new rows, their sent marks, the inventory
     depletion (+ aggregated 'sale depletion' ledger), and the KDS
     tickets commit or roll back as a single unit — a send-now can
     never half-land, so a retry can never duplicate a line. (This
     inline fire path previously never called depleteInventoryForItems
     at all: send-now sales silently left ingredient on_hand untouched.)
     Ticket broadcasts go out after commit, like /send. */
  const fired = withTransaction(() => {
    const insertedIds = [];
    for (const p of prepared) {
      const r = insertLine.run(crypto.randomUUID(), check.id, p.menuItem.id, p.seat, p.qty, p.unitPrice,
        p.modifiersJson, p.course, nowIso(), p.note, p.allergy, p.allergyDetail);
      insertedIds.push(r.lastInsertRowid);
    }
    const held = db.prepare(
      "SELECT ci.*, mi.name, mi.station FROM check_items ci JOIN menu_items mi ON mi.id = ci.menu_item_id WHERE ci.id IN (" + insertedIds.map(() => '?').join(',') + ") ORDER BY ci.id"
    ).all(...insertedIds);
    const byStation = new Map();
    for (const it of held) {
      markSent.run(sentAt, it.id);
      const station = it.station || 'expediter';
      if (!byStation.has(station)) byStation.set(station, []);
      byStation.get(station).push({
        item_id: it.id, name: it.name, seat: it.seat, guest_name: seatNames[it.seat] || null,
        qty: it.qty, modifiers: parseJson(it.modifiers_json, []), course: it.course || null,
        note: it.note || null, allergy: it.allergy ? true : false, allergy_detail: it.allergy_detail || null,
      });
    }
    depleteInventoryForItems(held, (req.user && req.user.name) || (serverUser ? serverUser.name : null));
    const created = [];
    for (const [station, tItems] of byStation) {
      const r = newTicket.run(crypto.randomUUID(), SITE_ID, check.id, station,
        checkLocationLabel(table, check), serverUser ? serverUser.name : null,
        JSON.stringify(tItems), sentAt);
      created.push(ticketView(db.prepare('SELECT * FROM kds_tickets WHERE id = ?').get(r.lastInsertRowid)));
    }
    return { insertedIds, tickets: created, sentCount: held.length };
  });
  for (const ticket of fired.tickets) broadcastTicket(ticket);
  persistTotals(check.id);
  broadcastCheckUpdated(check.id);
  const outItems = fired.insertedIds.map((id) => itemView(db.prepare('SELECT ci.*, mi.name FROM check_items ci LEFT JOIN menu_items mi ON mi.id = ci.menu_item_id WHERE ci.id = ?').get(id)));
  res.status(201).json({ sent: fired.sentCount, tickets: fired.tickets, items: outItems });
});

/* Item re-fire / reprint kitchen ticket (Toast overflow parity:
 * "Reprint kitchen tickets: re-sends items to the kitchen for firing").
 * Today the only path is void + re-add; this fires ONE already-fired item
 * again as a NEW ticket flagged refire:true so the kitchen sees a ↻ RE-FIRE
 * banner instead of a silent duplicate. The original ticket is untouched.
 * Server role (the floor owns re-fires); audit-logged with before/after. */
app.post('/api/checks/:id/items/:itemId/refire', serverPlus(), (req, res) => {
  const check = db.prepare('SELECT * FROM checks WHERE id = ? AND site_id = ?').get(req.params.id, SITE_ID);
  if (!check) return res.status(404).json({ error: 'Check not found' });
  if (check.status !== 'open') return res.status(400).json({ error: `Cannot re-fire on a ${check.status} check` });
  const itemId = Number(req.params.itemId);
  if (!Number.isFinite(itemId)) return res.status(400).json({ error: 'itemId is required' });
  const item = db.prepare(
    `SELECT ci.*, mi.name, mi.station FROM check_items ci
     JOIN menu_items mi ON mi.id = ci.menu_item_id
     WHERE ci.id = ? AND ci.check_id = ?`
  ).get(itemId, check.id);
  if (!item) return res.status(404).json({ error: 'Item not found on this check' });
  if (!['sent', 'fulfilled'].includes(item.state)) {
    return res.status(400).json({ error: `Only fired items can be re-fired (this one is ${item.state}) — send it first` });
  }

  const at = nowIso();
  const table = check.table_id ? db.prepare('SELECT label FROM tables WHERE id = ?').get(check.table_id) : null;
  const serverUser = check.server_id ? db.prepare('SELECT name FROM users WHERE id = ?').get(check.server_id) : null;
  const snap = {
    item_id: item.id,
    name: item.name,
    seat: item.seat,
    qty: item.qty,
    course: item.course,
    modifiers: parseJson(item.modifiers_json, []),
    note: item.note || null,
    allergy: item.allergy ? 1 : 0,
    allergy_detail: item.allergy_detail || null,
  };
  const r = db.prepare(
    `INSERT INTO kds_tickets (uuid, check_id, site_id, station, table_label, server_name, items_json, refire, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'new', ?)`
  ).run(crypto.randomUUID(), check.id, SITE_ID, item.station || 'expediter',
    checkLocationLabel(table, check), serverUser ? serverUser.name : null,
    JSON.stringify([snap]), at);
  const ticket = ticketView(db.prepare('SELECT * FROM kds_tickets WHERE id = ?').get(r.lastInsertRowid));
  auditApproval(req, 'refire', { check_id: check.id, item_id: item.id }, {
    approver: req.user ? req.user.name : '?',
    before: { state: item.state },
    after: { refire_ticket_id: ticket.id, station: ticket.station },
  });
  broadcastTicket(ticket);
  res.status(201).json({ ticket });
});

/* --------------------------------- split ----------------------------------- */
app.post('/api/checks/:id/split', serverPlus(), (req, res) => {
  const check = db.prepare('SELECT * FROM checks WHERE id = ? AND site_id = ?').get(req.params.id, SITE_ID);
  if (!check) return res.status(404).json({ error: 'Check not found' });
  if (check.status !== 'open') return res.status(400).json({ error: `Cannot split a ${check.status} check` });

  // Large parties carry a service charge and must stay on ONE check.
  const totals = persistTotals(check.id);
  if (totals.service_charge > 0) {
    const pctLabel = Math.round(getConfig().service_charge_pct * 1000) / 10;
    return res.status(400).json({ error: `Cannot split: this check has a ${pctLabel}% large-party service charge and must stay on a single check` });
  }
  const payCount = db.prepare('SELECT COUNT(*) AS n FROM payments WHERE check_id = ?').get(check.id).n;
  if (payCount > 0) {
    return res.status(400).json({ error: 'Cannot split a check that already has payments' });
  }
  // Phase 3A (P1 split permission, Toast 1.20 model): managers always; staff
  // with split_allowed; anyone else needs a manager PIN fallback.
  let splitApprovedBy = null;
  if (req.user.role !== 'manager' && !req.user.split_allowed) {
    const mgr = verifyManagerPin((req.body || {}).manager_pin);
    if (!mgr) {
      return res.status(403).json({ error: 'Splitting checks needs the split permission — ask a manager', need_manager_pin: true });
    }
    splitApprovedBy = mgr.name;
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
    const { item_ids, target, qty } = req.body;
    if (!Array.isArray(item_ids) || item_ids.length === 0) {
      return res.status(400).json({ error: "mode 'move' requires item_ids: [...]" });
    }
    const ids = new Set(item_ids);
    const picked = withTotals.filter((w) => ids.has(w.it.id)).map((w) => w.it);
    if (picked.length !== ids.size) {
      return res.status(400).json({ error: 'One or more item_ids not found as billable items on this check' });
    }
    // Phase 3A (P1): quantity division — split one line across the two checks.
    if (qty !== undefined) {
      if (picked.length !== 1) {
        return res.status(400).json({ error: 'qty division applies to a single item — pass exactly one item_id' });
      }
      const it = picked[0];
      if (!isInt(qty) || qty < 1 || qty >= it.qty) {
        return res.status(400).json({ error: `qty must be an integer between 1 and ${it.qty - 1} to divide the line` });
      }
      req._moveQty = qty;
    }
    groups = [picked];
    req._moveTarget = target;
  } else {
    return res.status(400).json({ error: "mode must be 'even', 'by_seat', or 'move'" });
  }

  const now = nowIso();
  const createdIds = [];
  const nameMoves = []; // guest names follow their seats onto the new checks
  /* Move one line onto targetCheckId. Whole-line moves keep the row; a
     qty-divided move splits the line and prorates any item discount exactly. */
  const moveStmt = db.prepare('UPDATE check_items SET check_id = ? WHERE id = ?');
  function transferItem(it, targetCheckId, qtyToMove) {
    const q = qtyToMove == null ? it.qty : qtyToMove;
    if (q >= it.qty) { moveStmt.run(targetCheckId, it.id); return; }
    const movedDisc = Math.round((it.discount_cents || 0) * q / it.qty);
    db.prepare('UPDATE check_items SET qty = qty - ?, discount_cents = discount_cents - ? WHERE id = ?')
      .run(q, movedDisc, it.id);
    db.prepare(`INSERT INTO check_items (uuid, check_id, menu_item_id, seat, qty, unit_price_cents,
        modifiers_json, course, state, sent_at, added_at, note, allergy, allergy_detail,
        discount_cents, discount_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(crypto.randomUUID(), targetCheckId, it.menu_item_id, it.seat, q, it.unit_price_cents,
        it.modifiers_json, it.course, it.state, it.sent_at, nowIso(),
        it.note, it.allergy, it.allergy_detail, movedDisc, it.discount_reason);
  }
  const doSplit = () => {
    if (mode === 'move' && req._moveTarget !== 'new' && req._moveTarget != null) {
      const targetCheck = db.prepare('SELECT * FROM checks WHERE id = ? AND site_id = ?').get(req._moveTarget, SITE_ID);
      if (!targetCheck) throw Object.assign(new Error('Target check not found'), { status: 404 });
      if (targetCheck.status !== 'open') throw Object.assign(new Error('Target check is not open'), { status: 400 });
      if (targetCheck.id === check.id) throw Object.assign(new Error('Target check must differ from source'), { status: 400 });
      for (const it of groups[0]) transferItem(it, targetCheck.id, req._moveQty);
      createdIds.push(targetCheck.id);
      for (const s of new Set(groups[0].map((it) => it.seat))) {
        nameMoves.push({ check_id: targetCheck.id, from_seat: s, to_seat: s });
      }
      persistTotals(targetCheck.id);
      broadcastCheckUpdated(targetCheck.id);
    } else {
      const insCheck = db.prepare(
        "INSERT INTO checks (uuid, site_id, table_id, server_id, tab_name, guest_count, channel, split_from, status, opened_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)"
      );
      groups.forEach((g, i) => {
        const seats = [...new Set(g.map((it) => it.seat))];
        const label = check.tab_name ? `${check.tab_name} · split ${i + 1}` : `Split ${i + 1}`;
        // Phase 3A fix: guest_count is the MAX retained seat number, not the
        // distinct-seat count — a retained seat 2 stays valid when seat 1 moved.
        // Claim/overlap P0: split children carry split_from so the one-open-
        // claim-per-table index doesn't treat a split as a double-claim.
        // Bar tabs: children inherit the parent channel (and its NULL
        // table_id) so a split tab stays a tab.
        const r = insCheck.run(crypto.randomUUID(), SITE_ID, check.table_id, check.server_id, label, Math.max(...seats), check.channel || 'dine_in', check.id, now);
        for (const it of g) {
          transferItem(it, r.lastInsertRowid, mode === 'move' && g.length === 1 ? req._moveQty : null);
        }
        persistTotals(r.lastInsertRowid);
        broadcastCheckUpdated(r.lastInsertRowid);
        createdIds.push(Number(r.lastInsertRowid));
        for (const s of seats) nameMoves.push({ check_id: Number(r.lastInsertRowid), from_seat: s, to_seat: s });
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
  // Guest names follow their seats onto the new / target checks.
  try { parityOrders.copySeatNames(db, SITE_ID, check.id, nameMoves, nowIso()); } catch { /* table owned by parity_orders migrate */ }
  auditApproval(req, 'split_check', { check_id: check.id },
    { mode, checks: createdIds, approved_by: splitApprovedBy });
  res.json({ split_from: check.id, checks: createdIds });
});

/* -------------------------------- payments --------------------------------- */
app.post('/api/checks/:id/payments', serverPlus(), (req, res) => {
  const check = db.prepare('SELECT * FROM checks WHERE id = ? AND site_id = ?').get(req.params.id, SITE_ID);
  if (!check) return res.status(404).json({ error: 'Check not found' });
  if (check.status !== 'open') return res.status(400).json({ error: `Cannot take payment on a ${check.status} check` });

  const { method, amount_cents, tip_cents = 0, tendered_cents, brand, last4, memo } = req.body || {};
  const TENDER_METHODS = ['cash', 'card_demo', 'house_account'];
  if (!TENDER_METHODS.includes(method)) {
    return res.status(400).json({ error: "method must be one of 'cash', 'card_demo', 'house_account'" });
  }
  /* House account is a real charge-to-account tender: the named account owes
   * the house; the payment row (with memo = account name) is the ledger
   * entry and shows up in finance reporting.
   * LOCKED POLICY 2026-09-27 (A — manager-created only): the memo must name
   * an existing ACTIVE house account. Servers cannot invent accounts at
   * payment time; accounts are created by managers via /api/admin/house-accounts. */
  let memoVal = null;
  if (method === 'house_account') {
    memoVal = String(memo || '').trim();
    if (!memoVal) return res.status(400).json({ error: 'memo (account name) is required for house account payments' });
    if (memoVal.length > 80) return res.status(400).json({ error: 'memo must be 80 characters or fewer' });
    const acct = db.prepare("SELECT id FROM house_accounts WHERE site_id = ? AND name = ? AND COALESCE(active, 1) = 1").get(SITE_ID, memoVal);
    if (!acct) return res.status(400).json({ error: 'Unknown or inactive house account — ask a manager to create it first' });
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
  // Phase 1B money audit: a payment may never be APPLIED for more than the
  // remaining balance — over-application used to drive the balance negative
  // and mark the check paid with money the house never collected.
  // Cash is the exception: over-tender is a normal restaurant flow (hand $20
  // for a $13.94 check), but only when the tendered amount is stated
  // explicitly via tendered_cents — an unstated over-tender is ambiguous and
  // is rejected. Cards can never exceed the balance.
  let appliedCents = amount_cents;
  let tenderedCents = tendered_cents ?? null;
  if (amount_cents > totals.balance) {
    if (method === 'cash' && tendered_cents != null) {
      appliedCents = totals.balance;
    } else {
      return res.status(400).json({ error: `amount_cents (${amount_cents}¢) exceeds the remaining balance (${totals.balance}¢)` });
    }
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
      "INSERT INTO payments (uuid, check_id, site_id, method, amount_cents, tip_cents, tendered_cents, brand, last4, auth_code, memo, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?)"
    ).run(crypto.randomUUID(), check.id, SITE_ID, method, appliedCents, tip_cents, tenderedCents,
      brand || (method === 'card_demo' ? 'DEMO' : null), last4 || null, authCode, memoVal, nowIso());
    const payment = paymentView(db.prepare('SELECT * FROM payments WHERE id = ?').get(r.lastInsertRowid));

    const after = persistTotals(check.id);
    if (after.balance <= 0) {
      db.prepare("UPDATE checks SET status = 'paid' WHERE id = ?").run(check.id);
    }

    broadcastCheckUpdated(check.id);
    const out = { payment, check: checkResponse(check.id) };
    if (method === 'cash' && tenderedCents != null) out.change_cents = tenderedCents - appliedCents - (tip_cents || 0);
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
  let reopenSkipped = null; // set when a re-seated table blocks the reopen
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
  const check = db.prepare('SELECT status, table_id FROM checks WHERE id = ?').get(payment.check_id);
  /* A refund on a still-active ('paid') check reopens it so the balance stays
     visible on the floor. A 'closed' check is end-of-lifecycle history: the
     refund is recorded in payouts/refunds, but the check does NOT reopen —
     the customer already left and the balance is not a collectible debt
     (matches Toast/Square behavior; keeps closed checks out of the open list). */
  if (check && check.status === 'paid' && totals.balance > 0) {
    // Refund pushed the check back to a positive balance — reopen it, UNLESS
    // the table has since been re-seated: reopening would violate the
    // one-open-staff-claim-per-table index (claim/overlap P0). In that case
    // the refund still stands; the check keeps its history and the manager
    // settles the residual from the payout records.
    const occupant = db.prepare(
      `SELECT id FROM checks WHERE table_id = ? AND status = 'open'
       AND split_from IS NULL AND server_id IS NOT NULL LIMIT 1`
    ).get(check.table_id);
    if (!occupant) {
      db.prepare("UPDATE checks SET status = 'open', closed_at = NULL WHERE id = ?").run(payment.check_id);
    } else {
      reopenSkipped = { reason: 'table_reseated', open_check_id: occupant.id };
    }
  }
  broadcastCheckUpdated(payment.check_id);
  const out = { payment: paymentView(db.prepare('SELECT * FROM payments WHERE id = ?').get(payment.id)) };
  if (reopenSkipped) out.reopen_skipped = reopenSkipped;
  if (idem) idemStore('refunds', idem, 200, out);
  return res.json(out);
} catch (e) {
  if (idem) idemClear('refunds', idem);
  throw e;
}
});

/* Reopen a 'paid' check that still carries a positive balance (e.g. a refund
   that could not auto-reopen because the table had been re-seated, and the
   re-seating check has since been voided). Manager-only: a paid check with
   balance > 0 is otherwise unpayable ('Cannot take payment on a paid check')
   and unclosable ('outstanding balance remains') — a zombie with no exit.
   The same re-seat guard as the refund auto-reopen applies: if the table now
   has an open staff claim, the reopen is refused (409) to protect the
   one-open-staff-claim-per-table index (claim/overlap P0). */
app.post('/api/checks/:id/reopen', managerOnly(), (req, res) => {
  const check = db.prepare('SELECT * FROM checks WHERE id = ? AND site_id = ?').get(req.params.id, SITE_ID);
  if (!check) return res.status(404).json({ error: 'Check not found' });
  if (check.status !== 'paid') {
    return res.status(400).json({ error: `Only a paid check can be reopened (status: ${check.status})` });
  }
  const totals = persistTotals(check.id);
  if (totals.balance <= 0) {
    return res.status(400).json({ error: 'Check has no outstanding balance — nothing to reopen for' });
  }
  /* Reopening a check requires a FRESH manager PIN every time, like void —
     this is a state-machine override, not routine flow. */
  const b = req.body || {};
  const mgr = verifyManagerPin(b.manager_pin);
  if (!mgr) {
    return res.status(403).json({ error: 'Reopening a paid check needs a manager PIN — enter it fresh every time', need_manager_pin: true });
  }
  const occupant = db.prepare(
    `SELECT id FROM checks WHERE table_id = ? AND status = 'open'
     AND split_from IS NULL AND server_id IS NOT NULL LIMIT 1`
  ).get(check.table_id);
  if (occupant) {
    return res.status(409).json({
      error: 'Table has been re-seated — cannot reopen while another open check holds the table',
      open_check_id: occupant.id,
    });
  }
  const upd = db.prepare("UPDATE checks SET status = 'open', closed_at = NULL WHERE id = ? AND status = 'paid'").run(check.id);
  if (upd.changes !== 1) {
    return res.status(409).json({ error: 'Check changed while reopening — please retry' });
  }
  auditApproval(req, 'reopen_check', { check_id: check.id },
    { approver: mgr.name, approver_id: mgr.id,
      before: { status: 'paid' }, after: { status: 'open' },
      reason: 'manual reopen of paid-with-balance zombie (re-seat block cleared)' });
  broadcastCheckUpdated(check.id);
  return res.json({ id: check.id, status: 'open', balance: totals.balance });
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

  let cardVolume = 0, refunds = 0, fees = 0, cashSales = 0, houseAccountSales = 0, tips = 0;
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
    } else if (p.method === 'house_account') {
      houseAccountSales += p.amount_cents;
    }
  }
  const expectedPayout = cardVolume - refunds - fees;
  // Time-clock labor for the same sales date, so Finance shows the full
  // picture (premiums are wages and belong in labor cost).
  const labor = dayLabor(date).summary;
  // Service charge is informational only: it is restaurant revenue already
  // inside card volume above. Attributed from checks closed on the sales
  // date (same bucketing as the sales report). Never a tip, never wages.
  const serviceCharge = serviceChargeOn(date);
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
    service_charge_cents: serviceCharge,
    service_charge_note: 'Informational only — the mandatory service charge is restaurant revenue already included in card volume above. It is never paid out as a tip or wage. Confirm tax treatment with your accountant.',
    cash_sales_cents: cashSales,
    house_account_sales_cents: houseAccountSales,
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

  let subtotal = 0, tips = 0, cashSales = 0, cardTips = 0, serviceCharge = 0;
  const brandBreakdown = {};
  const payStmt = db.prepare('SELECT * FROM payments WHERE check_id = ?');
  for (const c of checks) {
    const t = persistTotals(c.id);
    subtotal += t.subtotal;
    serviceCharge += t.service_charge;
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
    service_charge_cents: serviceCharge,
    service_charge_note: 'Mandatory service charge is restaurant revenue, not a tip — it stays with the house and is taxed as part of the sale in CA. Confirm with your accountant.',
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
  let cardVolume = 0, refunds = 0, fees = 0, cashSales = 0, houseAccountSales = 0, tips = 0;
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
    // Informational only: restaurant revenue already inside card volume,
    // attributed from checks closed on the sales date. Never a tip/wage.
    service_charge_cents: serviceChargeOn(date),
    cash_sales_cents: cashSales, tips_cents: tips,
  };
}

/** Service charge (cents) on checks closed on a sales date — shared by the
 *  payouts endpoint and the payouts report. Informational only. */
function serviceChargeOn(date) {
  let s = 0;
  for (const c of db.prepare("SELECT id, closed_at FROM checks WHERE site_id = ? AND status IN ('paid','closed') AND closed_at IS NOT NULL").all(SITE_ID)) {
    if (tzDate(c.closed_at) === date) s += persistTotals(c.id).service_charge || 0;
  }
  return s;
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

/** Weekly-OT premium rows for one Sun-Sat workweek (shares weekPayroll with
    dayLabor so the finance report and the time-clock summary always agree). */
function weeklyOtRows(weekStart) {
  const rows = [];
  for (const w of weekPayroll(weekStart)) {
    if (w.extra_ot15_hours > 0.005 && w.extra_ot15_cents > 0) {
      rows.push({
        week_start: weekStart, employee_number: employeeNumberFor(w.user_id),
        employee_name: w.employee_name, extra_ot_hours: r2(w.extra_ot15_hours),
        premium_cents: w.extra_ot15_cents,
      });
    }
  }
  return rows;
}

/** Seventh-consecutive-day premium rows for one Sun-Sat workweek: the uplift
    (extra 0.5x) on hours not already at 2x, per 7th workday. */
function seventhDayRows(weekStart) {
  const rows = [];
  for (const w of weekPayroll(weekStart)) {
    for (const sd of w.seventhDays) {
      rows.push({
        week_start: weekStart, date: sd.date, employee_number: employeeNumberFor(w.user_id),
        employee_name: w.employee_name, day_hours: r2(sd.hours),
        uplifted_hours: r2(sd.regH + sd.ot15H), premium_cents: sd.upliftCents,
      });
    }
  }
  return rows;
}

const REPORT_DEFS = {
  sales: {
    title: 'Sales summary',
    notes: ['Net sales = gross + surcharge + service charge − comps.', 'Tips are not sales and are not taxed.',
      'The mandatory service charge is restaurant revenue (NOT a tip): it is never auto-distributed to staff and never appears in tip lines or the Tips report.',
      'Tax treatment follows CA CDTFA guidance for mandatory service charges (Publication 22, Jan 2025; Annotation 550.0740). Expoline is not giving tax advice — confirm with your accountant.'],
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
    notes: ['Expected payout = card volume − refunds − Stripe fees (DEMO rate: 2.6% + 15¢ per card payment).', 'Sales date and payout date are distinct — payouts land ' + getConfig().payout_lag_days + ' days after the sales date.', 'Tips are collected separately and never reduce the payout.', 'Service charge is restaurant revenue, not a tip: it stays inside card volume and the payout, and is never paid out as a tip or wage. The Service charge column is informational only — it is already inside card volume.'],
    columns: [
      { key: 'sales_date', label: 'Sales date', kind: 'date' },
      { key: 'payout_date', label: 'Payout date', kind: 'date' },
      { key: 'card_volume_cents', label: 'Card volume', kind: 'money' },
      { key: 'refunds_cents', label: 'Refunds', kind: 'money' },
      { key: 'stripe_fees_cents', label: 'Stripe fees (DEMO)', kind: 'money' },
      { key: 'expected_payout_cents', label: 'Expected payout', kind: 'money' },
      { key: 'service_charge_cents', label: 'Service charge (info)', kind: 'money' },
    ],
    totalKeys: ['card_volume_cents', 'refunds_cents', 'stripe_fees_cents', 'expected_payout_cents', 'service_charge_cents'],
    build(from, to) {
      const rows = eachDate(from, to).map((d) => payoutDay(d));
      return { rows, extraTables: [] };
    },
  },
  tax: {
    title: 'Sales tax',
    notes: ['Taxable sales = gross + surcharge + service charge − comps. Tips are not taxed and are shown only for completeness.',
      'Mandatory service charges are included in taxable gross receipts in CA (CDTFA Publication 22, Jan 2025; Annotation 550.0740). Confirm with your accountant.'],
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
    notes: ['Regular, daily overtime (1.5× after 8h, 2× after 12h), and CA break premiums come from the time clock.', 'Weekly overtime (hours beyond 40/week at 1.5×) and seventh-consecutive-day premiums (first 8h at 1.5×, beyond 8h at 2×) are listed separately by workweek and included in the combined total.',
      'Service charges are house revenue, not wages or tips — they never appear in this report unless the house separately distributes them under house policy (distribution is not automatic).'],
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
      const sdRows = weekStarts.flatMap((ws) => seventhDayRows(ws));
      const sdTotal = sdRows.reduce((a, r) => a + r.premium_cents, 0);
      const extraTables = [];
      if (wotRows.length) extraTables.push({
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
      });
      if (sdRows.length) extraTables.push({
        title: 'Seventh consecutive day premiums (CA)',
        columns: [
          { key: 'date', label: 'Date', kind: 'date' },
          { key: 'employee_number', label: '#', kind: 'text' },
          { key: 'employee_name', label: 'Employee', kind: 'text' },
          { key: 'day_hours', label: 'Day hrs', kind: 'hours' },
          { key: 'uplifted_hours', label: 'Uplifted hrs', kind: 'hours' },
          { key: 'premium_cents', label: 'Premium pay', kind: 'money' },
        ],
        rows: sdRows,
        totals: { label: 'Total', premium_cents: sdTotal },
      });
      const premTotal = wotTotal + sdTotal;
      return { rows, extraTables, combinedNote: premTotal ? 'Combined labor cost incl. weekly OT + seventh-day premiums: see totals above + ' + '$' + (premTotal / 100).toFixed(2) : null };
    },
  },
  tips: {
    title: 'Tips',
    notes: ['Tips are not sales and are not taxed. Cash tips are kept by the server directly; card tips are paid out by the house at checkout.',
      'The mandatory service charge is NOT a tip and never appears here — it is restaurant revenue, never auto-distributed as tips; any distribution to staff follows house policy, not this report.'],
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
  if ((def.notes && def.notes.length) || data.combinedNote) {
    lines.push('');
    lines.push(csvCell({ kind: 'text' }, 'Notes'));
    for (const n of (def.notes || [])) lines.push(csvCell({ kind: 'text' }, n));
    if (data.combinedNote) lines.push(csvCell({ kind: 'text' }, data.combinedNote));
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
  if ((def.notes && def.notes.length) || data.combinedNote) {
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
    "SELECT id, table_id, tab_name, channel, opened_at FROM checks WHERE site_id = ? AND status = 'open' AND opened_at < ?"
  ).all(SITE_ID, new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString());
  for (const c of staleOpen) {
    const table = c.table_id ? db.prepare('SELECT label FROM tables WHERE id = ?').get(c.table_id) : null;
    alerts.push({ type: 'check_open_too_long', check_id: c.id, table_label: table ? table.label : null, tab_name: c.tab_name || null, channel: c.channel || 'dine_in', opened_at: c.opened_at });
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
    // Day-scale orphan report: OPEN checks with no activity (no new
    // items, no payments) for site_config stale_check_hours (default
    // 24). Report only — nothing is auto-voided or auto-closed.
    // (The alerts array above carries the separate in-service signal:
    // opened_at older than 4h regardless of activity.)
    stale_open_checks: staleOpenChecks(),
  });
});

/* ================= time clock + CA break compliance (phase 2) =================
   Native time clock with a California meal/rest-break rules engine. Premiums
   are wages: they feed labor cost (see GET /api/admin/clock/shifts and the
   labor_today_cents field on /api/manager/overview).

   CA RULES (validated 2026-09-26 against current DIR/DLSE guidance; encoded
   as CONFIG DATA in CLOCK_CA_DEFAULTS + site_config `clock_*` overrides —
   thresholds are NOT hardcoded law, and this engine is NOT legal advice:
   consult employment counsel before relying on it for payroll. Sources:
     - Meal periods: DIR FAQ_MealPeriods.html (Labor Code 512) —
       https://www.dir.ca.gov/dlse/FAQ_MealPeriods.html
       30-min unpaid duty-free meal before end of 5th hour (must START by the
       5th-hour mark); second 30-min meal before end of 10th hour when the
       shift exceeds 10h. 1st waivable by mutual consent if total shift <= 6h;
       2nd waivable if total shift <= 12h AND the first meal was taken.
     - Rest periods: DIR FAQ_RestPeriods.htm (IWC Wage Orders; Brinker
       Restaurant Corp. v. Superior Court (2012) 53 Cal.4th 1004) —
       http://www.dir.ca.gov/dlse/FAQ_RestPeriods.htm
       10-min paid duty-free rest per 4h or MAJOR FRACTION (>2h, strictly
       more than half); none if total shift < 3.5h. Brinker table:
       3.5-6h -> 1, >6-10h -> 2, >10-14h -> 3, and so on.
     - Premiums: Labor Code 226.7 + IWC Orders — 1 extra hour at the regular
       rate per workday per violation TYPE (missed meal + missed rest stack to
       2h/day; two missed meals in one day do NOT). Not hours worked for OT.
     - Overtime: DIR IWC Article 17 + Labor Code 510 —
       http://www.dir.ca.gov/IWC/IWCArticle17.pdf
       1.5x for hours >8 up to and including 12 in a workday, for hours >40 in
       a workweek, and for the first 8 hours on the 7th consecutive day of
       work in a workweek; 2x for hours >12 in a workday and for hours >8 on
       the 7th consecutive day. Daily OT is workday-based (site-tz date); the
       day summary aggregates multi-shift days so split shifts are not
       underpaid. Weekly OT never double-counts daily OT or 7th-day hours
       (no pyramiding).
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

/** Rest periods required for h hours worked. Brinker/DLSE: 10 minutes net
    per 4 hours or MAJOR FRACTION thereof, where a major fraction is MORE
    than 2 hours (strictly greater — a 6.0h shift owes 1 rest, not 2; a
    10.0h shift owes 2, not 3). None when the shift is under 3.5h. */
function restsRequiredFor(h, cfg) {
  if (h < cfg.rest_min_shift_h) return 0;
  return Math.floor(h / cfg.rest_per_hours) + ((h % cfg.rest_per_hours) > cfg.rest_major_fraction_h ? 1 : 0);
}

/** A meal break counts as taken: at least 30 minutes, duty-free (employee
    fully relieved of duty), and STARTED no later than the due mark
    (Brinker: the meal must be provided before the end of the 5th/10th hour). */
function mealBreakOk(b, cfg, dueAtIso) {
  return !!(b.end_at && b.duty_free === 1 &&
    minsBetween(b.start_at, b.end_at) >= cfg.meal_break_min &&
    b.start_at <= dueAtIso);
}

/** YYYY-MM-DD shifted by n calendar days. */
function shiftDateStr(dateStr, n) {
  const dt = new Date(dateStr + 'T12:00:00Z');
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

/** Displayed everywhere the CA rule thresholds surface: configuration is
    not legal advice. */
const CLOCK_LEGAL_NOTICE = 'Break and overtime rules are configuration data reflecting California DIR/DLSE guidance as validated 2026-09-26 — not legal advice. Consult employment counsel before relying on them for payroll.';

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

  const meals = breaks.filter((b) => b.type === 'meal' && !b.waived);
  const waivers = breaks.filter((b) => b.type === 'meal' && b.waived);

  const need1 = h > cfg.meal_due_by_hour;
  const need2 = h > cfg.second_meal_due_by_hour;
  const firstTaken = meals.some((b) => (b.meal_seq || 1) === 1 && mealBreakOk(b, cfg, dueAt(cfg.meal_due_by_hour)));
  const secondTaken = meals.some((b) => b.meal_seq === 2 && mealBreakOk(b, cfg, dueAt(cfg.second_meal_due_by_hour)));
  const waive1 = waivers.some((b) => (b.meal_seq || 1) === 1);
  const waive2 = waivers.some((b) => b.meal_seq === 2);
  const meal1ok = !need1 || firstTaken || (waive1 && h <= cfg.meal_waivable_max_shift_h);
  const meal2ok = !need2 || secondTaken || (waive2 && h <= cfg.second_meal_waivable_max_shift_h && firstTaken);

  const restsRequired = restsRequiredFor(h, cfg);
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
  // Waivers are compliance-significant: the waiver row lives on the shift's
  // break list AND an audit entry records who waived which meal and when.
  // Statutory eligibility (<=6h / <=12h + first taken) is re-checked at
  // clock-out; an ineligible waiver is ignored by clockCompute.
  auditClock(req, 'meal_waived', shift.id, { meal_seq: seq, employee_name: shift.employee_name });
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
  const dueAtIso = (dueHour) => new Date(inMs + dueHour * 3600 * 1000).toISOString();
  const taken = (seq, dueHour) => breaks.some((b) => b.type === 'meal' && !b.waived && (b.meal_seq || 1) === seq &&
    mealBreakOk(b, cfg, dueAtIso(dueHour)));
  const waived = (seq) => breaks.some((b) => b.type === 'meal' && b.waived && (b.meal_seq || 1) === seq);
  const inProg = (t) => breaks.some((b) => b.type === t && !b.end_at && !b.waived);
  const due = [];
  const mealState = (seq, dueHour) => {
    const dueAt = dueAtIso(dueHour);
    if (taken(seq, dueHour)) return { kind: 'meal', seq, state: 'taken', due_at: dueAt };
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
  const restsReq = restsRequiredFor(elapsedH, cfg);
  const restsTaken = breaks.filter((b) => b.type === 'rest' && b.end_at && minsBetween(b.start_at, b.end_at) >= cfg.rest_break_min).length;
  // Next rest is ideally mid-block ("insofar as practicable in the middle of
  // each work period"): middle of the next 4-hour block.
  const restDueAt = restsTaken >= restsReq ? null
    : new Date(inMs + (restsTaken * cfg.rest_per_hours + cfg.rest_per_hours / 2) * 3600 * 1000).toISOString();
  due.push({
    kind: 'rest', state: inProg('rest') ? 'in_progress' : (restsTaken >= restsReq ? 'ok' : (restsReq > 0 ? 'due' : 'upcoming')),
    required: restsReq, taken: restsTaken, due_at: restDueAt,
  });
  view.due = due;
  view.elapsed_h = r2(elapsedH);
  res.json(view);
});

/* --------------------------- manager time clock ---------------------------- */

/** Per-user week payroll detail for one Sun-Sat workweek (site tz). Day-level
    buckets (not per-shift) drive the weekly math because CA daily OT is
    workday-based. Also detects 7th consecutive workdays: a workday preceded
    by 6 consecutive calendar days with hours worked (the streak may start in
    the prior workweek — consecutive days don't reset on Sunday; the 7th day
    itself is always inside this workweek). On a 7th day the first 8 hours
    earn 1.5x and hours beyond 8 earn 2x (IWC Article 17); the uplift is the
    extra 0.5x on hours not already at 2x, valued at the day's
    hours-weighted average 1x rate. */
function weekPayroll(weekStart) {
  const cfg = clockConfig();
  const byUserDay = new Map();
  for (const s of db.prepare('SELECT * FROM clock_shifts WHERE site_id = ?').all(SITE_ID)) {
    if (weekStartSite(s.clock_in) !== weekStart) continue;
    const d = tzDate(s.clock_in);
    if (!byUserDay.has(s.user_id)) byUserDay.set(s.user_id, new Map());
    const m = byUserDay.get(s.user_id);
    if (!m.has(d)) m.set(d, []);
    m.get(d).push(s);
  }
  const out = [];
  for (const [uid, days] of byUserDay) {
    const dayRows = [];
    for (const [date, ss] of days) {
      const H = ss.reduce((a, s) => a + minsBetween(s.clock_in, s.clock_out || nowIso()) / 60, 0);
      let payAt1x = 0;
      for (const s of ss) {
        const v = shiftView(s, breaksFor(s.id), cfg);
        payAt1x += v.pay.reg_cents + v.pay.ot15_cents / 1.5 + v.pay.ot2_cents / 2;
      }
      const regH = Math.min(H, cfg.ot_daily_h);
      const ot15H = Math.min(Math.max(H - cfg.ot_daily_h, 0), cfg.ot_double_h - cfg.ot_daily_h);
      const ot2H = Math.max(H - cfg.ot_double_h, 0);
      dayRows.push({
        date, hours: H, regH, ot15H, ot2H, payAt1x,
        avgRate: H > 0.005 && payAt1x > 0 ? payAt1x / H : 0,
        employee_name: ss[0].employee_name,
      });
    }
    dayRows.sort((a, b) => (a.date < b.date ? -1 : 1));
    // Dates with any hours worked (whole history — the 6-day lookback may
    // reach into the prior workweek).
    const worked = new Set();
    for (const s of db.prepare('SELECT clock_in, clock_out FROM clock_shifts WHERE site_id = ? AND user_id = ?').all(SITE_ID, uid)) {
      if (minsBetween(s.clock_in, s.clock_out || nowIso()) > 0) worked.add(tzDate(s.clock_in));
    }
    const seventhDays = [];
    for (const dr of dayRows) {
      if (dr.hours <= 0.005) continue;
      let consec = true;
      for (let i = 1; i <= 6; i++) {
        if (!worked.has(shiftDateStr(dr.date, -i))) { consec = false; break; }
      }
      if (!consec) continue;
      // First 8h -> 1.5x (uplift +0.5x on regH); beyond 8h -> 2x (uplift +0.5x
      // on ot15H; ot2H already at 2x). Never pyramided with weekly OT.
      const upliftCents = Math.round((dr.regH + dr.ot15H) * dr.avgRate * 0.5);
      seventhDays.push({ ...dr, upliftCents });
    }
    const wh = dayRows.reduce((a, d) => a + d.hours, 0);
    const dotH = dayRows.reduce((a, d) => a + d.ot15H + d.ot2H, 0);
    const s7h = seventhDays.reduce((a, d) => a + d.hours, 0);
    const payAt1xW = dayRows.reduce((a, d) => a + d.payAt1x, 0);
    const avgW = wh > 0.005 && payAt1xW > 0 ? payAt1xW / wh : 0;
    // Weekly OT: hours beyond 40/week at 1.5x. Hours already premium-paid
    // (daily OT buckets, 7th-day hours) are excluded — no pyramiding.
    const extra = Math.max(0, wh - cfg.ot_weekly_h - dotH - s7h);
    const weeklyOtCents = (extra > 0.005 && avgW > 0) ? Math.round(extra * avgW * 0.5) : 0;
    const seventhDayCents = seventhDays.reduce((a, d) => a + d.upliftCents, 0);
    out.push({
      user_id: uid, employee_name: dayRows.length ? dayRows[0].employee_name : '',
      week_hours: wh, extra_ot15_hours: extra, extra_ot15_cents: weeklyOtCents,
      seventhDays, seventhDayCents,
    });
  }
  return out;
}

/** Day labor rollup (closed shifts finalized; open shifts counted elapsed-so-far).
 *  The per-shift `views` are line items. The SUMMARY is computed per
 *  (employee, workday) because CA daily OT thresholds (8h/12h) and break
 *  premiums (one per violation type per workday, LC 226.7) are workday-based,
 *  not shift-based — a split shift (e.g. 5h + 5h) owes daily OT on the hours
 *  past 8, and two shifts missing the same break type in one workday owe one
 *  premium hour, not two. Single-shift days use the shift's own numbers
 *  exactly; multi-shift days land a transparent entry in `adjustments`. */
function dayLabor(dateStr) {
  const cfg = clockConfig();
  const shifts = db.prepare('SELECT * FROM clock_shifts WHERE site_id = ?').all(SITE_ID)
    .filter((s) => tzDate(s.clock_in) === dateStr);
  const views = [];
  const viewById = new Map();
  for (const s of shifts) {
    const v = shiftView(s, breaksFor(s.id), cfg);
    views.push(v); viewById.set(s.id, v);
  }
  let reg = 0, ot = 0, premium = 0;
  const adjustments = [];
  const byUser = new Map();
  for (const s of shifts) {
    if (!byUser.has(s.user_id)) byUser.set(s.user_id, []);
    byUser.get(s.user_id).push(s);
  }
  for (const [uid, us] of byUser) {
    if (us.length === 1) {
      const v = viewById.get(us[0].id);
      reg += v.pay.reg_cents; ot += v.pay.ot15_cents + v.pay.ot2_cents; premium += v.pay.premium_cents;
      continue;
    }
    const H = us.reduce((a, s) => a + minsBetween(s.clock_in, s.clock_out || nowIso()) / 60, 0);
    let payAt1x = 0, sReg = 0, sOt = 0, sPrem = 0;
    const types = new Set();
    for (const s of us) {
      const v = viewById.get(s.id);
      payAt1x += v.pay.reg_cents + v.pay.ot15_cents / 1.5 + v.pay.ot2_cents / 2;
      sReg += v.pay.reg_cents; sOt += v.pay.ot15_cents + v.pay.ot2_cents; sPrem += v.pay.premium_cents;
      if (v.compliance.finalized) for (const t of v.compliance.violations) types.add(t);
    }
    const avg = H > 0.005 && payAt1x > 0 ? payAt1x / H : 0;
    const regH = Math.min(H, cfg.ot_daily_h);
    const ot15H = Math.min(Math.max(H - cfg.ot_daily_h, 0), cfg.ot_double_h - cfg.ot_daily_h);
    const ot2H = Math.max(H - cfg.ot_double_h, 0);
    const regC = Math.round(regH * avg), ot15C = Math.round(ot15H * avg * 1.5), ot2C = Math.round(ot2H * avg * 2);
    const premC = Math.round(types.size * cfg.premium_hours * avg);
    reg += regC; ot += ot15C + ot2C; premium += premC;
    adjustments.push({
      kind: 'workday_aggregation', user_id: uid, employee_name: us[0].employee_name, date: dateStr,
      detail: us.length + ' shifts aggregated to one workday: daily OT rebucketed per workday (8h/12h), break premiums capped at one per violation type per workday',
      reg_cents_delta: regC - sReg, ot_cents_delta: (ot15C + ot2C) - sOt, premium_cents_delta: premC - sPrem,
    });
  }
  // Weekly OT + 7th-consecutive-day premiums: per user, Sun-Sat workweek.
  const ws = weekStartSite(dateStr + 'T12:00:00Z');
  const weekly = [], seventh = [];
  let weeklyOtCents = 0, seventhDayCents = 0;
  for (const w of weekPayroll(ws)) {
    weeklyOtCents += w.extra_ot15_cents;
    if (w.extra_ot15_hours > 0.005 && w.extra_ot15_cents > 0) {
      weekly.push({ user_id: w.user_id, employee_name: w.employee_name, week_hours: r2(w.week_hours), extra_ot15_hours: r2(w.extra_ot15_hours), extra_ot15_cents: w.extra_ot15_cents });
    }
    for (const sd of w.seventhDays) {
      // The uplift is earned on the 7th day itself: only the queried date's
      // share lands in this day's total (weekly_ot_cents stays week-level,
      // matching the pre-existing weekly-OT semantics).
      if (sd.date === dateStr) seventhDayCents += sd.upliftCents;
      seventh.push({
        user_id: w.user_id, employee_name: w.employee_name, date: sd.date,
        day_hours: r2(sd.hours), uplifted_hours: r2(sd.regH + sd.ot15H), uplift_cents: sd.upliftCents,
      });
    }
  }
  const total = reg + ot + premium + weeklyOtCents + seventhDayCents;
  return {
    views, adjustments,
    summary: {
      reg_cents: reg, ot_cents: ot, premium_cents: premium,
      weekly_ot_cents: weeklyOtCents, seventh_day_cents: seventhDayCents, total_cents: total,
    },
    weekly, seventh_day: seventh,
  };
}

/** GET /api/admin/clock/shifts?date=YYYY-MM-DD — manager: all shifts, breaks,
    compliance, premiums, OT, and the day labor rollup. */
app.get('/api/admin/clock/shifts', managerOnly(), (req, res) => {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : todaySite();
  const { views, adjustments, summary, weekly, seventh_day } = dayLabor(date);
  const onShift = db.prepare("SELECT id, employee_name, role, clock_in FROM clock_shifts WHERE site_id = ? AND clock_out IS NULL").all(SITE_ID);
  const violations = views.filter((v) => v.compliance.violations.length)
    .map((v) => ({ shift_id: v.id, employee_name: v.employee_name, violations: v.compliance.violations, premium_cents: v.pay.premium_cents }));
  res.json({ date, on_shift: onShift, shifts: views, labor: summary, adjustments, weekly_ot: weekly, seventh_day, violations, legal_notice: CLOCK_LEGAL_NOTICE });
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
  res.json({ defaults: CLOCK_CA_DEFAULTS, overrides, effective: clockConfig(), notice: CLOCK_LEGAL_NOTICE });
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

/* ---------------- service charge settings (phase 4) -----------------------
 * The mandatory service charge (default 18% on parties of 8+) is site_config
 * data, editable per site by a manager. Server-side enforcement: every
 * check recomputes via calcTotals() from live config — clients can estimate
 * but never set the charge. A mandatory service charge is restaurant
 * revenue, NOT a tip: never auto-distributed to staff, never in tip lines or
 * the Tips report. In CA it is part of the taxable sale (CDTFA Publication
 * 22, Jan 2025; Annotation 550.0740). UI + report notes carry a "confirm with
 * your accountant" disclaimer — Expoline is not giving tax advice.
 */
const SVC_CHARGE_DEFAULTS = { service_charge_pct: 0.18, service_charge_min_guests: 8 };

function auditSvcCharge(req, action, before, after) {
  db.prepare('INSERT INTO service_charge_audit (site_id, actor, action, before_json, after_json, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(SITE_ID, req.user ? req.user.name : '?', action, JSON.stringify(before ?? null),
      JSON.stringify(after ?? null), JSON.stringify({ approver: (after && after.approver) || (req.user ? req.user.name : '?') }), nowIso());
}

function svcChargeCurrent() {
  const cfg = getConfig();
  return { service_charge_pct: cfg.service_charge_pct, service_charge_min_guests: cfg.service_charge_min_guests };
}

/** GET /api/admin/service-charge/config — current charge config + defaults. */
app.get('/api/admin/service-charge/config', managerOnly(), (req, res) => {
  const current = svcChargeCurrent();
  res.json({
    defaults: SVC_CHARGE_DEFAULTS,
    current,
    disabled: current.service_charge_min_guests === 0,
    note: 'A mandatory service charge is restaurant revenue, not a tip. In CA it is part of the taxable sale (CDTFA Pub 22, Jan 2025). Confirm with your accountant.',
  });
});

/** GET /api/admin/service-charge/audit?limit= — who changed the config, when. */
app.get('/api/admin/service-charge/audit', managerOnly(), (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit || '100', 10) || 100, 1), 500);
  res.json(db.prepare('SELECT id, actor, action, before_json, after_json, details, created_at FROM service_charge_audit WHERE site_id = ? ORDER BY id DESC LIMIT ?').all(SITE_ID, limit));
});

/** PUT /api/admin/service-charge/config {key, value, manager_pin}
 *  Change the charge percentage or guest threshold. Requires a manager
 *  session AND a live manager PIN (point-of-action approval, like comps).
 *  Every change is audit-logged with before/after values. */
app.put('/api/admin/service-charge/config', managerOnly(), (req, res) => {
  const b = req.body || {};
  const { key, value } = b;
  if (!['service_charge_pct', 'service_charge_min_guests'].includes(key)) {
    return res.status(400).json({ error: 'key must be service_charge_pct or service_charge_min_guests' });
  }
  const mgr = verifyManagerPin(b.manager_pin);
  if (!mgr) return res.status(403).json({ error: 'Manager PIN required to change the service charge' });
  const before = { ...svcChargeCurrent(), changed_by: req.user ? req.user.name : '?', approver: mgr.name };
  let next;
  if (key === 'service_charge_pct') {
    const n = parseFloat(value);
    if (!Number.isFinite(n) || n < 0 || n > 0.5) {
      return res.status(400).json({ error: 'service_charge_pct must be between 0 and 0.5 (0–50%)' });
    }
    next = n;
  } else {
    const n = value;
    if (!Number.isInteger(n) || n < 0 || n > 99) {
      return res.status(400).json({ error: 'service_charge_min_guests must be a whole number 0–99 (0 disables the charge)' });
    }
    next = n;
  }
  db.prepare('INSERT INTO site_config (site_id, key, value) VALUES (?, ?, ?) ON CONFLICT(site_id, key) DO UPDATE SET value = excluded.value')
    .run(SITE_ID, key, String(next));
  const after = { ...svcChargeCurrent(), changed_by: req.user ? req.user.name : '?', approver: mgr.name };
  auditSvcCharge(req, 'config_change', before, after);
  res.json({ key, value: next, current: svcChargeCurrent() });
});

/** GET /api/admin/drawer/config — who may perform a blind drawer close.
 *  Manager-only by default (Daniel's policy); a manager can relax it to
 *  'server' (servers and managers) with a live manager PIN. */
app.get('/api/admin/drawer/config', managerOnly(), (req, res) => {
  res.json({ drawer_close_role: getConfig().drawer_close_role });
});

/** PUT /api/admin/drawer/config {value, manager_pin} — value is
 *  'manager' or 'server'. Requires a manager session AND a live manager PIN
 *  (point-of-action approval, like comps). Audit-logged with before/after. */
app.put('/api/admin/drawer/config', managerOnly(), (req, res) => {
  const b = req.body || {};
  if (!['manager', 'server'].includes(b.value)) {
    return res.status(400).json({ error: "value must be 'manager' or 'server'" });
  }
  const mgr = verifyManagerPin(b.manager_pin);
  if (!mgr) return res.status(403).json({ error: 'Manager PIN required to change the drawer close policy' });
  const before = { drawer_close_role: getConfig().drawer_close_role };
  db.prepare('INSERT INTO site_config (site_id, key, value) VALUES (?, ?, ?) ON CONFLICT(site_id, key) DO UPDATE SET value = excluded.value')
    .run(SITE_ID, 'drawer_close_role', b.value);
  const after = { drawer_close_role: getConfig().drawer_close_role };
  auditApproval(req, 'drawer_config_change', {}, { before, after, approver: mgr.name });
  res.json({ drawer_close_role: after.drawer_close_role });
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

/* ------------------------- house accounts -------------------------
   LOCKED POLICY 2026-09-27 (A — manager-created only): house accounts are
   created (and deactivated) by managers only. The house_account payment
   tender requires the memo to name an existing active account. */

/** GET /api/admin/house-accounts — list accounts (managers; servers see active names for the tender picker). */
app.get('/api/admin/house-accounts', serverPlus(), (req, res) => {
  const rows = db.prepare('SELECT id, uuid, name, active, created_by, created_at FROM house_accounts WHERE site_id = ? ORDER BY name').all(SITE_ID);
  res.json(rows);
});

/** POST /api/admin/house-accounts {name} — manager-only creation. */
app.post('/api/admin/house-accounts', managerOnly(), (req, res) => {
  const name = String((req.body && req.body.name) || '').trim();
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (name.length > 80) return res.status(400).json({ error: 'name must be 80 characters or fewer' });
  const dup = db.prepare('SELECT id, active FROM house_accounts WHERE site_id = ? AND name = ?').get(SITE_ID, name);
  if (dup) {
    if (dup.active) return res.status(409).json({ error: 'House account already exists', id: dup.id });
    db.prepare('UPDATE house_accounts SET active = 1 WHERE id = ?').run(dup.id);
    auditApproval(req, 'house_account_reactivate', {}, { house_account_id: dup.id, name });
    return res.json({ id: dup.id, name, active: 1, reactivated: true });
  }
  const r = db.prepare('INSERT INTO house_accounts (uuid, site_id, name, active, created_by, created_at) VALUES (?, ?, ?, 1, ?, ?)')
    .run(crypto.randomUUID(), SITE_ID, name, req.user ? req.user.name : '?', new Date().toISOString());
  auditApproval(req, 'house_account_create', {}, { house_account_id: r.lastInsertRowid, name });
  res.status(201).json({ id: r.lastInsertRowid, name, active: 1 });
});

/** PATCH /api/admin/house-accounts/:id {active} — manager-only deactivate/reactivate. */
app.patch('/api/admin/house-accounts/:id', managerOnly(), (req, res) => {
  const row = db.prepare('SELECT id, name, active FROM house_accounts WHERE id = ? AND site_id = ?').get(req.params.id, SITE_ID);
  if (!row) return res.status(404).json({ error: 'House account not found' });
  const active = req.body && req.body.active !== undefined ? (req.body.active ? 1 : 0) : 1;
  db.prepare('UPDATE house_accounts SET active = ? WHERE id = ?').run(active, row.id);
  auditApproval(req, active ? 'house_account_reactivate' : 'house_account_deactivate', {}, { house_account_id: row.id, name: row.name });
  res.json({ id: row.id, name: row.name, active });
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

/** Open a check on a table (shared by reservation-arrive + waitlist-seat).
 *  Write-first like POST /api/checks: the unique index arbitrates races; the
 *  pre-check SELECT is an advisory fast path. On a lost race the returned
 *  object carries the winner's check_id so callers can reuse it (reservation
 *  seating intentionally reuses an existing open check). */
function openCheckOnTable(tableId, guestCount, tabName, serverId) {
  const table = tableById(tableId);
  if (!table) return { error: 'Valid table_id is required' };
  if (!isInt(guestCount) || guestCount < 1) return { error: 'guest_count must be a positive integer' };
  const existing = db.prepare("SELECT id FROM checks WHERE table_id = ? AND status = 'open' LIMIT 1").get(tableId);
  if (existing) return { error: 'Table already has an open check', check_id: existing.id };
  try {
    const r = db.prepare(
      "INSERT INTO checks (uuid, site_id, table_id, server_id, tab_name, guest_count, status, opened_at) VALUES (?, ?, ?, ?, ?, ?, 'open', ?)"
    ).run(crypto.randomUUID(), SITE_ID, tableId, serverId, tabName || null, guestCount, nowIso());
    const check = checkResponse(r.lastInsertRowid);
    broadcastCheckUpdated(check.id);
    return { check };
  } catch (e) {
    if (isClaimConflict(e)) {
      const w = claimWinnerOnTable(tableId);
      return {
        error: 'Table already claimed',
        status: 409, // lost-race contract: callers must preserve the 409
        check_id: w ? w.id : null,
        claimed_by: w ? w.server_name : null,
        claimed_at: w ? w.opened_at : null,
      };
    }
    throw e;
  }
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
  const om = r ? otMapForReservation(r.id) : null;
  return {
    id: r.id, uuid: r.uuid, customer_name: r.customer_name, phone: r.phone,
    party_size: r.party_size, reserved_at: r.reserved_at, duration_min: r.duration_min,
    table_id: r.table_id, table_label: t ? t.label : null, status: r.status,
    notes: r.notes, source: r.source || 'native', created_by: r.created_by, created_at: r.created_at,
    ot_confirmation_number: om ? om.confirmation_number : null,
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
    // OpenTable integration: an active OT hold blocks native booking on the same slot.
    const otClash = otLockClash(tableId, startMs, startMs + duration * 60000, null);
    if (otClash) return res.status(409).json({ error: 'Table is held by an OpenTable party for that time', ot_lock_id: otClash.lock_id });
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
    if (opened.status === 409)
      // Lost a simultaneous claim race: the reservation stays booked so the
      // host can seat it at another table. (A pre-existing open check found
      // by the fast path is still intentionally reused below.)
      return res.status(409).json({ error: opened.error, check_id: opened.check_id, claimed_by: opened.claimed_by, claimed_at: opened.claimed_at });
    checkId = opened.check ? opened.check.id : opened.check_id; // reuse open check if one exists
  }

  db.prepare('UPDATE reservations SET status = ?, table_id = ? WHERE id = ?')
    .run(newStatus, tableId, r.id);
  if (newStatus === 'no_show' || newStatus === 'cancelled') {
    auditApproval(req, newStatus === 'no_show' ? 'resv_no_show' : 'resv_cancel',
      {}, { reservation_id: r.id, before, after: { status: newStatus, table_id: tableId } });
  }
  // OpenTable integration: native status changes sync back to OpenTable.
  const om2 = otMapForReservation(r.id);
  if (om2 && newStatus !== before.status) otNotifyStatus(resvById(r.id), om2);
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
  const om = otMapForReservation(r.id); // native → OpenTable status update
  if (om) otNotifyStatus(resvById(r.id), om);
  broadcastResvUpdated();
  res.json({ id: r.id, status: 'cancelled' });
});

/* ------------------------ OpenTable integration ------------------------
   Locked rule: integrate OpenTable, don't replace it.
   The production API is partner-gated (see build/opentable-integration-brief.md).
   OPENTABLE_MODE=sandbox (the default) runs the ENTIRE flow against a local
   stub: inbound callbacks work over HTTP exactly like the real lock → make →
   update → cancel partner callbacks, and outbound posts are captured durably in
   ot_outbound with delivered='sandbox'. OPENTABLE_MODE=production is a pure
   config flip: credentials come ONLY from the environment
   (OPENTABLE_CLIENT_ID / OPENTABLE_CLIENT_SECRET / OPENTABLE_PARTNER_KEY),
   never from code. Without credentials, production-mode endpoints fail closed
   (503) — they never pretend to work. */
const OT_MODE = (process.env.OPENTABLE_MODE || 'sandbox').toLowerCase() === 'production' ? 'production' : 'sandbox';
const OT_API_BASE = process.env.OPENTABLE_API_BASE || null; // portal-issued base URL; null until provisioned
const OT_PARTNER_KEY = process.env.OPENTABLE_PARTNER_KEY || 'sandbox-partner-key';
const OT_LOCK_TTL_SEC = Math.max(30, parseInt(process.env.OPENTABLE_LOCK_TTL_SEC || '180', 10) || 180);

const OT_STATE_TO_NATIVE = {
  BOOKED: 'booked', SEATED: 'seated', ASSUMED_SEATED: 'seated',
  CANCELED: 'cancelled', NOSHOW: 'no_show', DONE: 'completed', PENDING: 'booked',
};
const NATIVE_TO_OT_STATE = { booked: 'BOOKED', seated: 'SEATED', cancelled: 'CANCELED', no_show: 'NOSHOW', completed: 'DONE' };

function otLink() {
  return db.prepare('SELECT * FROM ot_links WHERE site_id = ? ORDER BY id DESC LIMIT 1').get(SITE_ID) || null;
}

/** Production guard: fail closed + honestly when credentials are missing. */
function otProdGuard(req, res, next) {
  if (OT_MODE === 'sandbox') return next();
  if (process.env.OPENTABLE_CLIENT_ID && process.env.OPENTABLE_CLIENT_SECRET) return next();
  return res.status(503).json({
    error: 'OPENTABLE_MODE=production requires OPENTABLE_CLIENT_ID and OPENTABLE_CLIENT_SECRET in the environment. Production integration is not functional without partner credentials (see opentable-integration-brief.md).',
  });
}

/** Partner-callback auth: shared partner key header. In production the value
    is the portal-issued key (env); the exact scheme is a config detail. */
function otCallbackAuth(req, res, next) {
  const key = req.get('X-Partner-Key') || req.get('X-OT-Partner-Key');
  if (!key || key !== OT_PARTNER_KEY)
    return res.status(401).json({ error: 'Invalid or missing partner key' });
  next();
}

/** Live OpenTable hold on a table overlapping [startMs, endMs), or null. */
function otLockClash(tableId, startMs, endMs, excludeLockId) {
  return db.prepare(
    `SELECT * FROM ot_locks
     WHERE site_id = ? AND table_id = ? AND status = 'held'
       AND lock_id != COALESCE(?, '')
       AND strftime('%s', reserved_at) < strftime('%s', ?)
       AND strftime('%s', reserved_at, '+' || duration_min || ' minutes') > strftime('%s', ?)
       AND expires_at > ?
     LIMIT 1`
  ).get(SITE_ID, tableId, excludeLockId ?? null, new Date(endMs).toISOString(), new Date(startMs).toISOString(), nowIso()) || null;
}

/** Best-fit free table: smallest seats >= party_size with no native overlap
    and no live OT lock. Returns the table row or null. */
function otBestFitTable(partySize, startMs, endMs) {
  const tables = db.prepare(
    'SELECT id, label, seats, zone_id, x, y, shape FROM tables WHERE site_id = ? AND seats >= ? ORDER BY seats ASC, id ASC'
  ).all(SITE_ID, partySize);
  for (const t of tables) {
    if (resvOverlap(t.id, startMs, endMs, null)) continue;
    if (otLockClash(t.id, startMs, endMs, null)) continue;
    return t;
  }
  return null;
}

/** Map an OpenTable party payload onto the native reservation shape. */
function otMapPayload(b, conf) {
  const name = cleanLabel(b.name || b.party_name || b.customer_name || b.guest_name);
  const phone = cleanPhone(b.phone || b.guest_phone);
  const prefs = cleanLabel(b.seating_preferences || b.preferences);
  const dinerNotes = cleanLabel(b.notes || b.diner_notes || b.special_requests);
  const parts = [`[OpenTable #${conf}]`];
  if (dinerNotes) parts.push(dinerNotes);
  if (prefs) parts.push('Seating: ' + prefs);
  if (b.email) parts.push('email: ' + cleanLabel(b.email));
  return {
    customer_name: name,
    phone,
    party_size: b.party_size,
    reserved_at: b.reserved_at || b.date_time || b.dateTime,
    duration_min: b.duration_min == null ? 90 : b.duration_min,
    notes: parts.join(' · '),
  };
}

/** Outbound reservation update (Expoline → OpenTable). Sandbox: captured
    durably in ot_outbound with delivered='sandbox' — echo-backs and
    status updates are fully testable today. Production: queued durably with
    delivered='production-queued' until the portal-issued endpoint mapping is
    provisioned (no URLs are fabricated here). */
function otOutbound(action, confirmationNumber, payload) {
  const link = otLink();
  const requestId = crypto.randomUUID();
  const row = { request_id: requestId };
  if (OT_MODE === 'sandbox') {
    db.prepare(
      `INSERT INTO ot_outbound (site_id, opentable_rid, action, confirmation_number, payload_json, request_id, delivered, response_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'sandbox', ?, ?)`
    ).run(SITE_ID, link ? link.opentable_rid : null, action, confirmationNumber,
      JSON.stringify(payload), requestId, JSON.stringify({ sandbox: true, delivered: true }), nowIso());
    return { ...row, delivered: 'sandbox' };
  }
  db.prepare(
    `INSERT INTO ot_outbound (site_id, opentable_rid, action, confirmation_number, payload_json, request_id, delivered, response_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'production-queued', ?, ?)`
  ).run(SITE_ID, link ? link.opentable_rid : null, action, confirmationNumber,
    JSON.stringify(payload), requestId,
    JSON.stringify({ queued: true, reason: 'portal endpoint mapping not yet provisioned' }), nowIso());
  return { ...row, delivered: 'production-queued' };
}

/** Post a status update for an OT-linked reservation (native → OT direction). */
function otNotifyStatus(resv, mapRow) {
  const link = otLink();
  if (!link || !mapRow) return null;
  const otState = NATIVE_TO_OT_STATE[resv.status] || resv.status;
  const out = otOutbound('reservation_update', mapRow.confirmation_number, {
    confirmation_number: mapRow.confirmation_number,
    state: otState,
    party_size: resv.party_size,
    reserved_at: resv.reserved_at,
    table_id: resv.table_id,
  });
  db.prepare('UPDATE ot_reservation_map SET ot_state = ?, sync_sequence = sync_sequence + 1, last_sync_at = ? WHERE id = ?')
    .run(otState, nowIso(), mapRow.id);
  return out;
}

function otMapForReservation(resvId) {
  const r = resvById(resvId);
  if (!r) return null;
  return db.prepare('SELECT * FROM ot_reservation_map WHERE reservation_uuid = ? AND site_id = ?').get(r.uuid, SITE_ID) || null;
}

function siteLocalParts(utcMs) {
  const off = tzOffsetMs(SITE_TZ, utcMs);
  const d = new Date(utcMs + off);
  return { h: d.getUTCHours(), m: d.getUTCMinutes() };
}

/* ---- admin: link / status / unlink ---- */

app.post('/api/admin/opentable/link', managerOnly(), (req, res) => {
  const b = req.body || {};
  const rid = cleanLabel(b.opentable_rid || b.rid);
  if (!rid) return res.status(400).json({ error: 'opentable_rid is required' });
  const env = b.environment === 'production' ? 'production' : 'sandbox';
  const existing = otLink();
  if (existing) {
    db.prepare('UPDATE ot_links SET opentable_rid = ?, environment = ?, status = ?, updated_at = ? WHERE id = ?')
      .run(rid, env, 'active', nowIso(), existing.id);
  } else {
    db.prepare(`INSERT INTO ot_links (site_id, opentable_rid, environment, status, frn_online, created_at, updated_at)
                VALUES (?, ?, ?, 'active', 1, ?, ?)`)
      .run(SITE_ID, rid, env, nowIso(), nowIso());
  }
  const link = otLink();
  const creds = !!(process.env.OPENTABLE_CLIENT_ID && process.env.OPENTABLE_CLIENT_SECRET);
  res.json({
    linked: true, opentable_rid: link.opentable_rid, environment: link.environment,
    mode: OT_MODE, credentials_present: creds,
    note: OT_MODE === 'production' && !creds
      ? 'Production credentials are not configured; callbacks fail closed (503) until OPENTABLE_CLIENT_ID/OPENTABLE_CLIENT_SECRET are set.'
      : undefined,
  });
});

app.get('/api/admin/opentable/status', serverPlus(), (req, res) => {
  const link = otLink();
  const out = db.prepare("SELECT COUNT(*) AS c FROM ot_outbound WHERE site_id = ? AND delivered = 'sandbox'").get(SITE_ID).c;
  res.json({
    mode: OT_MODE,
    linked: !!link,
    opentable_rid: link ? link.opentable_rid : null,
    environment: link ? link.environment : null,
    frn_online: link ? !!link.frn_online : null,
    credentials_present: !!(process.env.OPENTABLE_CLIENT_ID && process.env.OPENTABLE_CLIENT_SECRET),
    partner_key_configured: OT_PARTNER_KEY !== 'sandbox-partner-key',
    sandbox_outbound_captured: out,
  });
});

app.delete('/api/admin/opentable/link', managerOnly(), (req, res) => {
  db.prepare('DELETE FROM ot_links WHERE site_id = ?').run(SITE_ID);
  res.json({ linked: false });
});

/** Recent outbound sync messages (durable queue view for ops / QA). */
app.get('/api/admin/opentable/outbound', managerOnly(), (req, res) => {
  const rows = db.prepare(
    `SELECT id, opentable_rid, action, confirmation_number, payload_json, request_id, delivered, response_json, created_at
     FROM ot_outbound WHERE site_id = ? ORDER BY id DESC LIMIT 200`
  ).all(SITE_ID);
  res.json(rows);
});

/* ---- partner-hosted callbacks (OpenTable → Expoline) ---- */

/** LOCK: hold a slot for the make step (best-efforts inventory hold, per OT
    docs). 409 when nothing fits — never silently double-book. */
app.post('/api/opentable/lock', otCallbackAuth, otProdGuard, (req, res) => {
  const b = req.body || {};
  const requestId = req.get('X-Request-Id') || null;
  if (requestId) {
    const prior = db.prepare("SELECT * FROM ot_locks WHERE site_id = ? AND request_id = ? AND status = 'held' AND expires_at > ?")
      .get(SITE_ID, requestId, nowIso());
    if (prior) {
      const t = tableById(prior.table_id);
      return res.status(200).json({
        lock_id: prior.lock_id, table_id: prior.table_id, table_label: t ? t.label : null,
        expires_at: prior.expires_at,
        expires_in_sec: Math.max(0, Math.round((Date.parse(prior.expires_at) - Date.now()) / 1000)),
        replayed: true,
      });
    }
  }
  if (!isInt(b.party_size) || b.party_size < 1 || b.party_size > 24)
    return res.status(400).json({ error: 'party_size must be a whole number from 1 to 24' });
  const startMs = parseSlot(b.reserved_at || b.date_time);
  if (startMs == null) return res.status(400).json({ error: 'reserved_at must be a valid ISO datetime' });
  if (startMs < Date.now() - 2 * 3600e3) return res.status(400).json({ error: 'reserved_at is too far in the past' });
  const duration = b.duration_min == null ? 90 : b.duration_min;
  if (!isInt(duration) || duration < 15 || duration > 480)
    return res.status(400).json({ error: 'duration_min must be 15–480' });
  const endMs = startMs + duration * 60000;

  let table = null;
  if (b.preferred_table_id != null) {
    const t = tableById(b.preferred_table_id);
    if (!t) return res.status(400).json({ error: 'Valid preferred_table_id is required' });
    if (t.seats < b.party_size) return res.status(400).json({ error: 'Preferred table is too small for the party' });
    if (resvOverlap(t.id, startMs, endMs, null))
      return res.status(409).json({ error: 'Requested table is already booked for that time' });
    const lclash = otLockClash(t.id, startMs, endMs, null);
    if (lclash) return res.status(409).json({ error: 'Requested table is already held for that time', lock_id: lclash.lock_id });
    table = t;
  }
  if (!table) table = otBestFitTable(b.party_size, startMs, endMs);
  if (!table) return res.status(409).json({ error: 'No table available for that party size and time' });

  const lockId = 'otlk_' + crypto.randomUUID().slice(0, 12);
  const expiresAt = new Date(Date.now() + OT_LOCK_TTL_SEC * 1000).toISOString();
  db.prepare(
    `INSERT INTO ot_locks (site_id, lock_id, table_id, party_size, reserved_at, duration_min, expires_at, status, request_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'held', ?, ?)`
  ).run(SITE_ID, lockId, table.id, b.party_size, new Date(startMs).toISOString(), duration, expiresAt, requestId, nowIso());
  res.status(201).json({ lock_id: lockId, table_id: table.id, table_label: table.label, expires_at: expiresAt, expires_in_sec: OT_LOCK_TTL_SEC });
});

/** MAKE: create the reservation. Idempotent on (opentable_rid,
    confirmation_number) — a retried make returns the original row, never a
    duplicate. */
app.post('/api/opentable/reservations', otCallbackAuth, otProdGuard, (req, res) => {
  const b = req.body || {};
  const requestId = req.get('X-Request-Id') || null;
  const link = otLink();
  const rid = cleanLabel(b.opentable_rid) || (link ? link.opentable_rid : null);
  const conf = cleanLabel(b.confirmation_number || b.confirmation);
  if (!rid) return res.status(400).json({ error: 'opentable_rid is required (or link the restaurant first)' });
  if (!conf) return res.status(400).json({ error: 'confirmation_number is required' });

  const dup = db.prepare('SELECT * FROM ot_reservation_map WHERE site_id = ? AND opentable_rid = ? AND confirmation_number = ?')
    .get(SITE_ID, rid, conf);
  if (dup) {
    if (requestId && dup.last_request_id !== requestId)
      db.prepare('UPDATE ot_reservation_map SET last_request_id = ?, last_sync_at = ? WHERE id = ?').run(requestId, nowIso(), dup.id);
    const r = db.prepare('SELECT * FROM reservations WHERE uuid = ?').get(dup.reservation_uuid);
    if (r) return res.status(200).json({ ...resvView(r), confirmation_number: conf, replayed: true });
    // Map row exists but the reservation row vanished — rebuild instead of duplicating.
    db.prepare('DELETE FROM ot_reservation_map WHERE id = ?').run(dup.id);
  }

  const m = otMapPayload(b, conf);
  if (!m.customer_name) return res.status(400).json({ error: 'guest name is required' });
  if (!isInt(m.party_size) || m.party_size < 1 || m.party_size > 24)
    return res.status(400).json({ error: 'party_size must be a whole number from 1 to 24' });
  const startMs = parseSlot(m.reserved_at);
  if (startMs == null) return res.status(400).json({ error: 'reserved_at must be a valid ISO datetime' });
  if (startMs < Date.now() - 2 * 3600e3) return res.status(400).json({ error: 'reserved_at is too far in the past' });
  const endMs = startMs + m.duration_min * 60000;

  // Resolve table: consume the lock if supplied, else best-fit with conflict checks.
  let table = null;
  if (b.lock_id) {
    const lock = db.prepare("SELECT * FROM ot_locks WHERE site_id = ? AND lock_id = ? AND status = 'held' AND expires_at > ?")
      .get(SITE_ID, cleanLabel(b.lock_id), nowIso());
    if (lock) {
      table = tableById(lock.table_id);
      if (!table || resvOverlap(table.id, startMs, endMs, null))
        return res.status(409).json({ error: 'Locked table is no longer available', lock_id: lock.lock_id });
      db.prepare("UPDATE ot_locks SET status = 'consumed' WHERE id = ?").run(lock.id);
    }
  }
  if (!table && b.preferred_table_id != null) {
    const t = tableById(b.preferred_table_id);
    if (!t) return res.status(400).json({ error: 'Valid preferred_table_id is required' });
    if (t.seats < m.party_size) return res.status(400).json({ error: 'Preferred table is too small for the party' });
    if (resvOverlap(t.id, startMs, endMs, null))
      return res.status(409).json({ error: 'Requested table is already booked for that time' });
    const lclash = otLockClash(t.id, startMs, endMs, null);
    if (lclash) return res.status(409).json({ error: 'Requested table is held by an OpenTable lock for that time', lock_id: lclash.lock_id });
    table = t;
  }
  if (!table) table = otBestFitTable(m.party_size, startMs, endMs);
  if (!table) return res.status(409).json({ error: 'No table available for that party size and time' });

  const r = db.prepare(
    `INSERT INTO reservations (uuid, site_id, customer_name, phone, party_size, reserved_at, duration_min,
       table_id, status, notes, source, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'booked', ?, 'opentable', ?, ?)`
  ).run(crypto.randomUUID(), SITE_ID, m.customer_name, m.phone || null, m.party_size,
    new Date(startMs).toISOString(), m.duration_min, table.id, m.notes,
    'opentable-sync', nowIso());
  const row = resvById(r.lastInsertRowid);
  db.prepare(
    `INSERT INTO ot_reservation_map (site_id, reservation_uuid, opentable_rid, confirmation_number, source,
       sync_sequence, ot_state, details_json, last_request_id, idempotency_response, last_sync_at)
     VALUES (?, ?, ?, ?, 'opentable', 1, 'BOOKED', ?, ?, ?, ?)`
  ).run(SITE_ID, row.uuid, rid, conf, JSON.stringify({ raw: b }), requestId, null, nowIso());
  const view = { ...resvView(row), confirmation_number: conf };
  db.prepare('UPDATE ot_reservation_map SET idempotency_response = ? WHERE site_id = ? AND opentable_rid = ? AND confirmation_number = ?')
    .run(JSON.stringify(view), SITE_ID, rid, conf);

  // Echo-back (anti-ghost-booking): tell OT the booking exists in our system.
  otOutbound('reservation_update', conf, {
    confirmation_number: conf, state: 'BOOKED', party_size: m.party_size,
    reserved_at: row.reserved_at, table_id: table.id,
  });

  broadcastResvUpdated();
  res.status(201).json(view);
});

/** UPDATE: party size / time / state changes. Sequence-based last-writer-wins
    (mirrors OT's own sequence_id semantics): stale sequences are ignored. */
app.patch('/api/opentable/reservations/:confirmation', otCallbackAuth, otProdGuard, (req, res) => {
  const conf = cleanLabel(req.params.confirmation);
  const b = req.body || {};
  const link = otLink();
  const rid = cleanLabel(b.opentable_rid) || (link ? link.opentable_rid : null);
  const map = db.prepare('SELECT * FROM ot_reservation_map WHERE site_id = ? AND opentable_rid = ? AND confirmation_number = ?')
    .get(SITE_ID, rid, conf);
  if (!map) return res.status(404).json({ error: 'Unknown OpenTable confirmation number' });
  const r = db.prepare('SELECT * FROM reservations WHERE uuid = ?').get(map.reservation_uuid);
  if (!r) return res.status(404).json({ error: 'Linked reservation not found' });

  const seq = b.sequence == null ? null : parseInt(b.sequence, 10);
  if (seq != null && (!Number.isInteger(seq) || seq < 0))
    return res.status(400).json({ error: 'sequence must be a non-negative integer' });
  if (seq != null && seq <= map.sync_sequence)
    return res.status(200).json({ ...resvView(r), confirmation_number: conf, ignored_stale: true, sync_sequence: map.sync_sequence });

  let tableId = r.table_id, partySize = r.party_size;
  let startMs = Date.parse(r.reserved_at), duration = r.duration_min, newState = r.status;
  if (b.party_size !== undefined) {
    if (!isInt(b.party_size) || b.party_size < 1 || b.party_size > 24)
      return res.status(400).json({ error: 'party_size must be a whole number from 1 to 24' });
    partySize = b.party_size;
  }
  if (b.reserved_at !== undefined) {
    const t = parseSlot(b.reserved_at);
    if (t == null) return res.status(400).json({ error: 'reserved_at must be a valid ISO datetime' });
    startMs = t;
  }
  if (b.duration_min !== undefined) {
    if (!isInt(b.duration_min) || b.duration_min < 15 || b.duration_min > 480)
      return res.status(400).json({ error: 'duration_min must be 15–480' });
    duration = b.duration_min;
  }
  if (b.ot_state !== undefined || b.status !== undefined) {
    const otState = cleanLabel(b.ot_state || b.status).toUpperCase();
    if (!OT_STATE_TO_NATIVE[otState]) return res.status(400).json({ error: 'Unknown OT state' });
    newState = OT_STATE_TO_NATIVE[otState];
  }
  if (b.table_id !== undefined) {
    if (b.table_id == null) return res.status(400).json({ error: 'OpenTable bookings require a table' });
    const t = tableById(b.table_id);
    if (!t) return res.status(400).json({ error: 'Valid table_id is required' });
    tableId = t.id;
  }
  const tbl = tableById(tableId);
  if (tbl && partySize > tbl.seats) return res.status(400).json({ error: 'party_size exceeds table seats' });
  if (tableId != null) {
    const clash = resvOverlap(tableId, startMs, startMs + duration * 60000, r.id);
    if (clash) return res.status(409).json({ error: 'Table is already booked for that time', conflicting_reservation_id: clash.id });
    const lclash = otLockClash(tableId, startMs, startMs + duration * 60000, null);
    if (lclash) return res.status(409).json({ error: 'Table is held by an OpenTable lock for that time', lock_id: lclash.lock_id });
  }
  if (['cancelled', 'no_show', 'completed'].includes(r.status) && newState !== r.status)
    return res.status(400).json({ error: `Reservation is already ${r.status}` });

  const newSeq = seq != null ? seq : map.sync_sequence + 1;
  const newOtState = (b.ot_state !== undefined || b.status !== undefined)
    ? cleanLabel(b.ot_state || b.status).toUpperCase() : map.ot_state;
  db.prepare('UPDATE reservations SET party_size = ?, reserved_at = ?, duration_min = ?, table_id = ?, status = ? WHERE id = ?')
    .run(partySize, new Date(startMs).toISOString(), duration, tableId, newState, r.id);
  db.prepare('UPDATE ot_reservation_map SET sync_sequence = ?, ot_state = ?, last_sync_at = ?, last_request_id = ? WHERE id = ?')
    .run(newSeq, newOtState, nowIso(), req.get('X-Request-Id') || null, map.id);
  broadcastResvUpdated();
  res.json({ ...resvView(resvById(r.id)), confirmation_number: conf, sync_sequence: newSeq });
});

/** CANCEL: OpenTable-initiated cancellation. */
app.delete('/api/opentable/reservations/:confirmation', otCallbackAuth, otProdGuard, (req, res) => {
  const conf = cleanLabel(req.params.confirmation);
  const link = otLink();
  const rid = cleanLabel((req.body || {}).opentable_rid) || (link ? link.opentable_rid : null);
  const map = db.prepare('SELECT * FROM ot_reservation_map WHERE site_id = ? AND opentable_rid = ? AND confirmation_number = ?')
    .get(SITE_ID, rid, conf);
  if (!map) return res.status(404).json({ error: 'Unknown OpenTable confirmation number' });
  const r = db.prepare('SELECT * FROM reservations WHERE uuid = ?').get(map.reservation_uuid);
  if (!r) return res.status(404).json({ error: 'Linked reservation not found' });
  if (['cancelled', 'no_show', 'completed'].includes(r.status))
    return res.status(400).json({ error: `Reservation is already ${r.status}` });
  db.prepare("UPDATE reservations SET status = 'cancelled' WHERE id = ?").run(r.id);
  db.prepare("UPDATE ot_reservation_map SET ot_state = 'CANCELED', sync_sequence = sync_sequence + 1, last_sync_at = ? WHERE id = ?")
    .run(nowIso(), map.id);
  otOutbound('reservation_update', conf, { confirmation_number: conf, state: 'CANCELED' });
  auditApproval({ user: { name: 'opentable-sync' } }, 'resv_cancel', {},
    { reservation_id: r.id, before: { status: r.status }, after: { status: 'cancelled' }, via: 'opentable' });
  broadcastResvUpdated();
  res.json({ confirmation_number: conf, status: 'cancelled' });
});

/** FRN recovery: OpenTable polls this after our endpoints fail. Reports online
    so the restaurant becomes bookable again on OpenTable. */
app.get('/api/opentable/recovery', otCallbackAuth, (req, res) => {
  db.prepare('UPDATE ot_links SET frn_online = 1, updated_at = ? WHERE site_id = ?').run(nowIso(), SITE_ID);
  res.json({ online: true, mode: OT_MODE, ts: nowIso() });
});

/* ---- admin: reconcile + availability publish ---- */

/** RECONCILE: safety-net compare. The caller (QA harness / ops; production
    pulls by modified_at once the partner pull endpoint is provisioned) supplies
    the OT-side booking list. Never auto-creates — mismatches are reported for
    a manager to resolve. */
app.post('/api/admin/opentable/reconcile', managerOnly(), (req, res) => {
  const b = req.body || {};
  const otBookings = Array.isArray(b.ot_bookings) ? b.ot_bookings : [];
  const link = otLink();
  const maps = db.prepare('SELECT confirmation_number, ot_state FROM ot_reservation_map WHERE site_id = ?').all(SITE_ID);
  const byConf = new Map(maps.map((m) => [m.confirmation_number, m]));
  const seen = new Set();
  const missing_local = [], state_mismatches = [];
  for (const ob of otBookings) {
    const conf = cleanLabel(ob.confirmation_number);
    seen.add(conf);
    const m = byConf.get(conf);
    if (!m) { missing_local.push(conf); continue; }
    const want = cleanLabel(ob.ot_state || ob.state || '').toUpperCase();
    if (want && m.ot_state && want !== m.ot_state)
      state_mismatches.push({ confirmation_number: conf, ot: want, local: m.ot_state });
  }
  const missing_ot = maps.filter((m) => !seen.has(m.confirmation_number)).map((m) => m.confirmation_number);
  res.json({
    opentable_rid: link ? link.opentable_rid : null, mode: OT_MODE,
    missing_local, missing_ot, state_mismatches, checked: otBookings.length,
  });
});

/** AVAILABILITY PUBLISH: derive OT 15-min slot buckets from live floor-plan
    availability (the floor plan is the single arbiter) and publish. Sandbox:
    captured to ot_outbound. */
app.post('/api/admin/opentable/publish-availability', managerOnly(), (req, res) => {
  const date = cleanLabel((req.body || {}).date) || siteTodayStr();
  const bounds = siteDayBounds(date);
  if (!bounds) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  const PARTY_SIZES = [1, 2, 3, 4, 5, 6, 7, 8];
  const tables = db.prepare('SELECT id, seats FROM tables WHERE site_id = ?').all(SITE_ID);
  const slots = [];
  const t0 = Date.parse(bounds[0]);
  for (let ms = t0; ms < t0 + 86400000; ms += 900000) {
    const { h } = siteLocalParts(ms);
    if (h < 17 || h >= 22) continue; // dinner service window, site-local
    for (const ps of PARTY_SIZES) {
      const free = tables.some((t) => t.seats >= ps
        && !resvOverlap(t.id, ms, ms + 90 * 60000, null)
        && !otLockClash(t.id, ms, ms + 90 * 60000, null));
      if (free) slots.push({ time: new Date(ms).toISOString(), party_size: ps });
    }
  }
  const out = otOutbound('availability_publish', null, { date, slot_count: slots.length, slots });
  res.json({
    date, slots_published: slots.length, delivered: out.delivered, request_id: out.request_id,
    note: 'Last-writer-wins by sequence_id per OT docs; omit-a-time means not bookable.',
  });
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

/* ----------------- waitlist quotes from REAL turn-time data -----------------
   Quotes are computed from this site's own check history (opened_at ->
   closed_at), bucketed by party size. Buckets with fewer than 5 samples in
   the last 28 days fall back to a labeled 75-minute default — the response
   always says which basis was used. Never a fixed blind guess. */
const PARTY_BUCKETS = ['1-2', '3-4', '5-6', '7+'];
function partyBucket(n) {
  const p = Math.max(1, n | 0);
  return p <= 2 ? '1-2' : p <= 4 ? '3-4' : p <= 6 ? '5-6' : '7+';
}
function turnTimeStats() {
  const cutoff = new Date(Date.now() - 28 * 86400000).toISOString();
  const rows = db.prepare(
    `SELECT guest_count, opened_at, closed_at FROM checks
     WHERE site_id = ? AND status IN ('paid','closed')
       AND closed_at IS NOT NULL AND closed_at >= ? AND opened_at IS NOT NULL`
  ).all(SITE_ID, cutoff);
  const per = {};
  for (const r of rows) {
    const mins = (parseDbUtc(r.closed_at) - parseDbUtc(r.opened_at)) / 60000;
    if (!isFinite(mins) || mins <= 0 || mins > 720) continue;
    const b = partyBucket(r.guest_count || 2);
    (per[b] = per[b] || []).push(mins);
  }
  const out = {};
  for (const b of PARTY_BUCKETS) {
    const a = (per[b] || []).sort((x, y) => x - y);
    out[b] = a.length >= 5
      ? { median_min: Math.round(a[Math.floor(a.length / 2)]), samples: a.length, fallback: false }
      : { median_min: 75, samples: a.length, fallback: true };
  }
  return out;
}
function quoteWaitlist(party) {
  const stats = turnTimeStats();
  const myBucket = partyBucket(party);
  const my = stats[myBucket];
  const suitable = db.prepare('SELECT id FROM tables WHERE site_id = ? AND seats >= ? ORDER BY seats ASC').all(SITE_ID, party);
  if (!suitable.length) {
    return { quoted_wait_min: null, reason: 'no table seats a party of ' + party, basis: { party_bucket: myBucket, median_turn_min: my.median_min, samples: my.samples, fallback: my.fallback } };
  }
  const waitingAhead = db.prepare(
    `SELECT COUNT(*) AS c FROM waitlist WHERE site_id = ? AND status IN ('waiting','notified') AND party_size >= ?`
  ).get(SITE_ID, Math.max(1, party - 2)).c;
  const openStmt = db.prepare('SELECT opened_at, guest_count FROM checks WHERE table_id = ? AND status = ? ORDER BY opened_at LIMIT 1');
  const nowMs = Date.now();
  let freeNow = 0;
  let soonestFreeMin = Infinity;
  for (const t of suitable) {
    const oc = openStmt.get(t.id, 'open');
    if (!oc || !oc.opened_at) { freeNow++; continue; }
    const st = stats[partyBucket(oc.guest_count || 2)];
    const elapsed = (nowMs - parseDbUtc(oc.opened_at)) / 60000;
    const remain = Math.max(0, st.median_min - (isFinite(elapsed) ? elapsed : 0));
    soonestFreeMin = Math.min(soonestFreeMin, remain);
  }
  if (!isFinite(soonestFreeMin)) soonestFreeMin = 0;
  // Model: tables that are free now (or imminently) absorb the queue ahead;
  // the rest of the wait is amortized across suitable tables by median turn.
  let quote;
  if (freeNow > waitingAhead) quote = 0;
  else quote = Math.max(5, Math.round(soonestFreeMin + ((waitingAhead - freeNow) * my.median_min) / suitable.length));
  return {
    quoted_wait_min: quote,
    basis: {
      party_bucket: myBucket, median_turn_min: my.median_min, samples: my.samples, fallback: my.fallback,
      suitable_tables: suitable.length, free_now: freeNow, waiting_ahead: waitingAhead,
    },
  };
}

/** Validate waitlist pre-order lines. Returns {items:[{menuItem, qty, seat, modifiers}]} or {error}. */
function validatePreorder(lines, partySize, actorRole) {
  if (lines == null) return { items: [] };
  if (!Array.isArray(lines)) return { error: 'preorder_items must be an array' };
  if (lines.length > 40) return { error: 'preorder_items is limited to 40 lines' };
  const items = [];
  for (const [i, ln] of lines.entries()) {
    const menuItem = ln && ln.menu_item_id != null
      ? db.prepare('SELECT * FROM menu_items WHERE id = ? AND site_id = ? AND active = 1').get(ln.menu_item_id, SITE_ID)
      : null;
    if (!menuItem) return { error: `preorder_items[${i}]: valid active menu_item_id is required` };
    const qty = ln.qty == null ? 1 : ln.qty;
    if (!isInt(qty) || qty < 1 || qty > 20) return { error: `preorder_items[${i}]: qty must be 1–20` };
    const seat = ln.seat == null ? 1 : ln.seat;
    if (!isInt(seat) || seat < 1 || seat > partySize) return { error: `preorder_items[${i}]: seat must be 1–${partySize}` };
    const mods = ln.modifiers == null ? [] : ln.modifiers;
    if (!Array.isArray(mods)) return { error: `preorder_items[${i}]: modifiers must be an array` };
    for (const m of mods) {
      if (!m || typeof m.name !== 'string' || !isInt(m.price_delta_cents)) {
        return { error: `preorder_items[${i}]: each modifier needs {name, price_delta_cents}` };
      }
    }
    let unitPrice = menuItem.price_cents;
    if (menuItem.price_cents === 0) {
      // Market-price items: a manager must set the price when the pre-order is taken.
      if (actorRole !== 'manager') {
        return { error: `preorder_items[${i}]: market-price item "${menuItem.name}" must be pre-ordered by a manager` };
      }
      if (!isInt(ln.unit_price_cents) || ln.unit_price_cents < 0) {
        return { error: `preorder_items[${i}]: market-price item needs unit_price_cents (manager-entered price)` };
      }
      unitPrice = ln.unit_price_cents;
    }
    items.push({ menuItem, qty, seat, modifiers: mods, unitPrice });
  }
  return { items };
}

function wlPreorderView(w) {
  return { ...wlView(w), preorder_items: parseJson(w.preorder_json, []) };
}

app.post('/api/waitlist', serverPlus(), (req, res) => {
  const b = req.body || {};
  const name = cleanLabel(b.customer_name);
  if (!name) return res.status(400).json({ error: 'customer_name is required' });
  if (!isInt(b.party_size) || b.party_size < 1 || b.party_size > 24)
    return res.status(400).json({ error: 'party_size must be a whole number from 1 to 24' });
  const pre = validatePreorder(b.preorder_items, b.party_size, req.user.role);
  if (pre.error) return res.status(400).json({ error: pre.error });
  let quoted = b.quoted_wait_min == null ? null : b.quoted_wait_min;
  let quoteBasis = null;
  if (quoted != null && (!isInt(quoted) || quoted < 0 || quoted > 480))
    return res.status(400).json({ error: 'quoted_wait_min must be 0–480' });
  if (quoted == null) {
    // Data-driven default: quote from real turn-time history, never a guess.
    const q = quoteWaitlist(b.party_size);
    quoted = q.quoted_wait_min == null ? 0 : q.quoted_wait_min;
    quoteBasis = q.basis || null;
  }
  const phone = cleanPhone(b.phone);
  const r = db.prepare(
    `INSERT INTO waitlist (uuid, site_id, customer_name, phone, party_size, quoted_wait_min, preorder_json, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'waiting', ?)`
  ).run(crypto.randomUUID(), SITE_ID, name, phone || null, b.party_size, quoted, JSON.stringify(pre.items.map((p) => ({
    menu_item_id: p.menuItem.id, name: p.menuItem.name, qty: p.qty, seat: p.seat,
    modifiers: p.modifiers, unit_price_cents: p.unitPrice,
  }))), nowIso());
  broadcastResvUpdated();
  const out = wlPreorderView(wlById(r.lastInsertRowid));
  if (quoteBasis) out.quote_basis = quoteBasis;
  res.status(201).json(out);
});

/** GET /api/waitlist/quote?party_size=N — data-driven quote without adding
 *  anyone to the list. */
app.get('/api/waitlist/quote', serverPlus(), (req, res) => {
  const party = req.query.party_size == null ? 2 : parseInt(req.query.party_size, 10);
  if (!isInt(party) || party < 1 || party > 24)
    return res.status(400).json({ error: 'party_size must be 1–24' });
  res.json(quoteWaitlist(party));
});

app.get('/api/waitlist', serverPlus(), (req, res) => {
  const rows = db.prepare(
    `SELECT * FROM waitlist WHERE site_id = ? AND status IN ('waiting','notified') ORDER BY created_at`
  ).all(SITE_ID);
  res.json(rows.map(wlPreorderView));
});

app.post('/api/waitlist/:id/notify', serverPlus(), (req, res) => {
  const w = wlById(req.params.id);
  if (!w) return res.status(404).json({ error: 'Waitlist entry not found' });
  if (w.status !== 'waiting') return res.status(400).json({ error: `Entry is ${w.status}` });
  db.prepare("UPDATE waitlist SET status = 'notified', notified_at = ? WHERE id = ?").run(nowIso(), w.id);
  broadcastResvUpdated();
  res.json(wlPreorderView(wlById(w.id)));
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
  if (opened.error) {
    // Lost-race (409) preserves the contract so the host sees who claimed the
    // table; other errors stay 400 and the entry remains waiting/notified.
    const out = { error: opened.error, check_id: opened.check_id || null };
    if (opened.status === 409) {
      out.claimed_by = opened.claimed_by;
      out.claimed_at = opened.claimed_at;
      return res.status(409).json(out);
    }
    return res.status(400).json(out);
  }
  // Attach the pre-order as HELD items — the kitchen fires nothing until /send.
  const preorder = parseJson(w.preorder_json, []);
  const insPre = db.prepare(
    "INSERT INTO check_items (uuid, check_id, menu_item_id, seat, qty, unit_price_cents, modifiers_json, course, state, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'held', ?)"
  );
  const skipped = [];
  withTransaction(() => {
    for (const ln of preorder) {
      const mi = db.prepare('SELECT * FROM menu_items WHERE id = ? AND site_id = ? AND active = 1').get(ln.menu_item_id, SITE_ID);
      if (!mi) { skipped.push(ln.name || ('item ' + ln.menu_item_id)); continue; } // 86'd while they waited
      const seat = Math.min(Math.max(1, ln.seat | 0), w.party_size);
      const qty = Math.min(Math.max(1, ln.qty | 0), 20);
      const unit = ln.unit_price_cents != null ? ln.unit_price_cents : mi.price_cents;
      insPre.run(crypto.randomUUID(), opened.check.id, mi.id, seat, qty, unit,
        JSON.stringify(Array.isArray(ln.modifiers) ? ln.modifiers : []), mi.course, nowIso());
    }
  });
  if (preorder.length) persistTotals(opened.check.id);
  db.prepare("UPDATE waitlist SET status = 'seated' WHERE id = ?").run(w.id);
  auditApproval(req, 'waitlist_seat', { check_id: opened.check.id }, { waitlist_id: w.id, preorder_attached: preorder.length - skipped.length, preorder_skipped: skipped });
  broadcastResvUpdated();
  res.json({ entry: wlPreorderView(wlById(w.id)), check_id: opened.check.id, preorder_attached: preorder.length - skipped.length, preorder_skipped: skipped });
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

/* ================= Phase 3C — competitor parity: back office =================
   Cash drawer (blind-count closeout), scheduling with labor-vs-sales
   projections, product-mix analytics, staff notes at login, review prompts,
   multi-location dashboard, open API docs, inventory phase 1. */

/* ------------------------------- cash drawer -------------------------------
   One open drawer at a time per site. Expected cash is server-computed:
   opening float + cash payments (net of cash refunds) + paid-ins − paid-outs.
   Cash tips are kept by the server directly (see /api/finance/shift), so only
   the house's amount_cents moves the drawer. Closeout is blind: non-managers
   never see expected_cents; the manager enters the count and the server
   computes the variance. */
function currentDrawer() {
  return db.prepare("SELECT * FROM cash_drawers WHERE site_id = ? AND status = 'open' ORDER BY opened_at DESC LIMIT 1").get(SITE_ID);
}
function drawerExpected(d) {
  const close = d.closed_at || nowIso();
  const pays = db.prepare(
    `SELECT method, amount_cents, refunded_cents, status FROM payments
     WHERE site_id = ? AND created_at >= ? AND created_at < ?`
  ).all(SITE_ID, d.opened_at, close);
  let cashNet = 0;
  for (const p of pays) {
    if (p.method !== 'cash') continue;
    if (p.status === 'completed' || p.status === 'partial_refund') cashNet += p.amount_cents - (p.refunded_cents || 0);
  }
  const evts = db.prepare('SELECT kind, amount_cents FROM cash_drawer_events WHERE drawer_id = ?').all(d.id);
  let paidIn = 0, paidOut = 0;
  for (const e of evts) {
    if (e.kind === 'paid_in') paidIn += e.amount_cents || 0;
    else if (e.kind === 'paid_out') paidOut += e.amount_cents || 0;
  }
  return d.opening_float_cents + cashNet + paidIn - paidOut;
}
function drawerView(d, includeExpected) {
  const v = {
    id: d.id, uuid: d.uuid, status: d.status, opened_at: d.opened_at, closed_at: d.closed_at,
    opened_by: d.opened_by, opening_float_cents: d.opening_float_cents,
    counted_cents: d.counted_cents, variance_cents: d.variance_cents, counted_by: d.counted_by, notes: d.notes,
  };
  if (includeExpected) v.expected_cents = d.status === 'open' ? drawerExpected(d) : d.expected_cents;
  return v;
}
function logDrawerEvent(drawerId, kind, amountCents, note, actor) {
  db.prepare(
    `INSERT INTO cash_drawer_events (drawer_id, site_id, kind, amount_cents, note, actor, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(drawerId, SITE_ID, kind, amountCents || 0, note || null, actor || null, nowIso());
}

app.post('/api/cash/drawer/open', managerOnly(), (req, res) => {
  if (currentDrawer()) return res.status(409).json({ error: 'A drawer is already open' });
  const b = req.body || {};
  if (!isInt(b.opening_float_cents) || b.opening_float_cents < 0)
    return res.status(400).json({ error: 'opening_float_cents must be a non-negative integer' });
  const r = db.prepare(
    `INSERT INTO cash_drawers (uuid, site_id, opened_at, opened_by, opening_float_cents, status)
     VALUES (?, ?, ?, ?, ?, 'open')`
  ).run(crypto.randomUUID(), SITE_ID, nowIso(), req.user.name, b.opening_float_cents);
  logDrawerEvent(r.lastInsertRowid, 'open', b.opening_float_cents, 'Opening float', req.user.name);
  auditApproval(req, 'drawer_open', {}, { drawer_id: r.lastInsertRowid, opening_float_cents: b.opening_float_cents });
  res.status(201).json(drawerView(db.prepare('SELECT * FROM cash_drawers WHERE id = ?').get(r.lastInsertRowid), true));
});

/** Blind by role: managers see the live expected figure; servers/kitchen see
 *  the drawer state and event log without it (blind count). */
app.get('/api/cash/drawer', serverPlus(), (req, res) => {
  const d = currentDrawer();
  if (!d) return res.json({ drawer: null });
  const events = db.prepare('SELECT id, kind, amount_cents, note, actor, created_at FROM cash_drawer_events WHERE drawer_id = ? ORDER BY created_at').all(d.id);
  res.json({ drawer: drawerView(d, req.user.role === 'manager'), events });
});

app.post('/api/cash/drawer/event', serverPlus(), (req, res) => {
  const d = currentDrawer();
  if (!d) return res.status(409).json({ error: 'No drawer is open' });
  const b = req.body || {};
  const kinds = new Set(['paid_in', 'paid_out', 'no_sale', 'note']);
  if (!kinds.has(b.kind)) return res.status(400).json({ error: 'kind must be paid_in, paid_out, no_sale, or note' });
  const needsAmt = b.kind === 'paid_in' || b.kind === 'paid_out';
  const amt = b.amount_cents == null ? 0 : b.amount_cents;
  if (needsAmt && (!isInt(amt) || amt <= 0))
    return res.status(400).json({ error: 'amount_cents must be a positive integer for paid_in/paid_out' });
  if (!needsAmt && b.amount_cents != null && !isInt(b.amount_cents))
    return res.status(400).json({ error: 'amount_cents must be an integer' });
  const note = cleanLabel(b.note);
  logDrawerEvent(d.id, b.kind, amt, note || null, req.user.name);
  auditApproval(req, 'drawer_event', {}, { drawer_id: d.id, kind: b.kind, amount_cents: amt, note: note || null });
  res.status(201).json({ ok: true, drawer: drawerView(db.prepare('SELECT * FROM cash_drawers WHERE id = ?').get(d.id), req.user.role === 'manager') });
});

/** Blind-count closeout: the manager enters the counted cash; the server —
 *  not the counter — computes expected and the variance. */
const drawerCloseGate = () => (req, res, next) =>
  (getConfig().drawer_close_role === 'server' ? serverPlus() : managerOnly())(req, res, next);
app.post('/api/cash/drawer/close', drawerCloseGate(), (req, res) => {
  const d = currentDrawer();
  if (!d) return res.status(409).json({ error: 'No drawer is open' });
  const b = req.body || {};
  if (!isInt(b.counted_cents) || b.counted_cents < 0)
    return res.status(400).json({ error: 'counted_cents must be a non-negative integer' });
  const expected = drawerExpected(d);
  const variance = b.counted_cents - expected;
  const closedAt = nowIso();
  db.prepare(
    `UPDATE cash_drawers SET status = 'closed', closed_at = ?, expected_cents = ?, counted_cents = ?, variance_cents = ?, counted_by = ?, notes = ? WHERE id = ?`
  ).run(closedAt, expected, b.counted_cents, variance, req.user.name, cleanLabel(b.notes) || null, d.id);
  logDrawerEvent(d.id, 'close', b.counted_cents, `Counted ${b.counted_cents}, expected ${expected}, variance ${variance}`, req.user.name);
  auditApproval(req, 'drawer_close', {}, { drawer_id: d.id, expected_cents: expected, counted_cents: b.counted_cents, variance_cents: variance });
  res.json({ drawer: drawerView(db.prepare('SELECT * FROM cash_drawers WHERE id = ?').get(d.id), true) });
});

app.get('/api/cash/log', managerOnly(), (req, res) => {
  const drawers = db.prepare('SELECT * FROM cash_drawers WHERE site_id = ? ORDER BY opened_at DESC LIMIT 30').all(SITE_ID);
  res.json(drawers.map((d) => drawerView(d, true)));
});

/* ------------------------------ scheduling --------------------------------
   Weekly schedule with projected labor cost next to sales projections.
   Sales projections come from the site's own closed-check history (same
   weekday, trailing 8 weeks) — no invented numbers. */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function validMinutes(v) { return isInt(v) && v >= 0 && v <= 1440; }

app.get('/api/admin/schedule', managerOnly(), (req, res) => {
  const week = req.query.week;
  if (week != null && !DATE_RE.test(week)) return res.status(400).json({ error: 'week must be YYYY-MM-DD' });
  const start = week || weekStartSite(todaySite() + 'T12:00:00Z');
  const end = addDays(start, 6);
  const rows = db.prepare(
    'SELECT * FROM schedule_shifts WHERE site_id = ? AND work_date >= ? AND work_date <= ? ORDER BY work_date, start_min'
  ).all(SITE_ID, start, end);
  res.json({ week_start: start, week_end: end, shifts: rows });
});

app.post('/api/admin/schedule', managerOnly(), (req, res) => {
  const b = req.body || {};
  if (!DATE_RE.test(b.work_date || '')) return res.status(400).json({ error: 'work_date must be YYYY-MM-DD' });
  if (!validMinutes(b.start_min) || !validMinutes(b.end_min) || b.end_min <= b.start_min)
    return res.status(400).json({ error: 'start_min/end_min must be 0–1440 with end after start' });
  const user = b.user_id != null ? db.prepare('SELECT * FROM users WHERE id = ?').get(b.user_id) : null;
  const name = cleanLabel(b.employee_name) || (user ? user.name : '');
  if (!name) return res.status(400).json({ error: 'employee_name or a valid user_id is required' });
  const role = ['server', 'kitchen', 'manager'].includes(b.role) ? b.role : (user ? user.role : 'server');
  const rate = b.rate_cents != null ? b.rate_cents : (user ? (user.hourly_rate_cents || 0) : 0);
  if (!isInt(rate) || rate < 0) return res.status(400).json({ error: 'rate_cents must be a non-negative integer' });
  const r = db.prepare(
    `INSERT INTO schedule_shifts (uuid, site_id, user_id, employee_name, role, work_date, start_min, end_min, rate_cents, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(crypto.randomUUID(), SITE_ID, user ? user.id : null, name, role, b.work_date, b.start_min, b.end_min, rate, req.user.name, nowIso());
  auditApproval(req, 'schedule_create', {}, { shift_id: r.lastInsertRowid, employee_name: name, work_date: b.work_date });
  res.status(201).json(db.prepare('SELECT * FROM schedule_shifts WHERE id = ?').get(r.lastInsertRowid));
});

app.put('/api/admin/schedule/:id', managerOnly(), (req, res) => {
  const s = db.prepare('SELECT * FROM schedule_shifts WHERE id = ? AND site_id = ?').get(req.params.id, SITE_ID);
  if (!s) return res.status(404).json({ error: 'Scheduled shift not found' });
  const b = req.body || {};
  const upd = {
    employee_name: b.employee_name != null ? cleanLabel(b.employee_name) : s.employee_name,
    role: ['server', 'kitchen', 'manager'].includes(b.role) ? b.role : s.role,
    work_date: b.work_date != null ? b.work_date : s.work_date,
    start_min: b.start_min != null ? b.start_min : s.start_min,
    end_min: b.end_min != null ? b.end_min : s.end_min,
    rate_cents: b.rate_cents != null ? b.rate_cents : s.rate_cents,
  };
  if (!upd.employee_name) return res.status(400).json({ error: 'employee_name is required' });
  if (!DATE_RE.test(upd.work_date)) return res.status(400).json({ error: 'work_date must be YYYY-MM-DD' });
  if (!validMinutes(upd.start_min) || !validMinutes(upd.end_min) || upd.end_min <= upd.start_min)
    return res.status(400).json({ error: 'start_min/end_min must be 0–1440 with end after start' });
  if (!isInt(upd.rate_cents) || upd.rate_cents < 0) return res.status(400).json({ error: 'rate_cents must be a non-negative integer' });
  db.prepare('UPDATE schedule_shifts SET employee_name = ?, role = ?, work_date = ?, start_min = ?, end_min = ?, rate_cents = ? WHERE id = ?')
    .run(upd.employee_name, upd.role, upd.work_date, upd.start_min, upd.end_min, upd.rate_cents, s.id);
  auditApproval(req, 'schedule_update', {}, { shift_id: s.id, before: { work_date: s.work_date, start_min: s.start_min, end_min: s.end_min }, after: upd });
  res.json(db.prepare('SELECT * FROM schedule_shifts WHERE id = ?').get(s.id));
});

app.delete('/api/admin/schedule/:id', managerOnly(), (req, res) => {
  const s = db.prepare('SELECT * FROM schedule_shifts WHERE id = ? AND site_id = ?').get(req.params.id, SITE_ID);
  if (!s) return res.status(404).json({ error: 'Scheduled shift not found' });
  db.prepare('DELETE FROM schedule_shifts WHERE id = ?').run(s.id);
  auditApproval(req, 'schedule_delete', {}, { shift_id: s.id, employee_name: s.employee_name, work_date: s.work_date });
  res.json({ deleted: s.id });
});

/** Projected labor cost next to sales projections, per day of the week.
 *  Projected sales = mean of that weekday's closed-check net sales over the
 *  trailing 8 weeks. Labor = Σ scheduled hours × rate. */
app.get('/api/admin/schedule/projection', managerOnly(), (req, res) => {
  const week = req.query.week;
  if (week != null && !DATE_RE.test(week)) return res.status(400).json({ error: 'week must be YYYY-MM-DD' });
  const start = week || weekStartSite(todaySite() + 'T12:00:00Z');
  // Trailing 8 weeks of closed-check daily sales, bucketed by site weekday.
  const salesByDay = db.prepare(
    `SELECT closed_at, total_cents FROM checks
     WHERE site_id = ? AND status IN ('paid','closed') AND closed_at IS NOT NULL
       AND closed_at >= ?`
  ).all(SITE_ID, new Date(Date.now() - 56 * 86400000).toISOString());
  const byDow = {}; // 0=Sun..6=Sat -> [daily totals]
  const dayTotals = {};
  for (const c of salesByDay) {
    const d = tzDate(c.closed_at);
    if (!DATE_RE.test(d)) continue;
    dayTotals[d] = (dayTotals[d] || 0) + (c.total_cents || 0);
  }
  for (const [d, t] of Object.entries(dayTotals)) {
    const dow = new Date(d + 'T12:00:00Z').getUTCDay();
    (byDow[dow] = byDow[dow] || []).push(t);
  }
  const shifts = db.prepare(
    'SELECT * FROM schedule_shifts WHERE site_id = ? AND work_date >= ? AND work_date <= ?'
  ).all(SITE_ID, start, addDays(start, 6));
  const days = [];
  for (let i = 0; i < 7; i++) {
    const date = addDays(start, i);
    const dow = new Date(date + 'T12:00:00Z').getUTCDay();
    const samples = byDow[dow] || [];
    const projected = samples.length ? Math.round(samples.reduce((a, b) => a + b, 0) / samples.length) : null;
    const dayShifts = shifts.filter((s) => s.work_date === date);
    const labor = dayShifts.reduce((a, s) => a + ((s.end_min - s.start_min) / 60) * (s.rate_cents || 0), 0);
    days.push({
      date, dow,
      projected_sales_cents: projected,
      projected_sales_samples: samples.length,
      scheduled_labor_cents: Math.round(labor),
      scheduled_shifts: dayShifts.length,
      projected_labor_pct: projected ? +(100 * labor / projected).toFixed(1) : null,
    });
  }
  res.json({ week_start: start, week_end: addDays(start, 6), days });
});

/* ------------------------- product-mix analytics --------------------------
   Best/worst sellers from the same honest sales data — no separate analytics
   SKU. Attribution: items on checks closed in the range (billable states).
   Voids are counted separately so a popular-but-voided item can't hide. */
app.get('/api/finance/product-mix', managerOnly(), (req, res) => {
  let from = req.query.from, to = req.query.to;
  const today = todaySite();
  if (!from && !to) { to = today; from = addDays(today, -6); }
  else { from = from || to; to = to || from; }
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) return res.status(400).json({ error: 'from/to must be YYYY-MM-DD' });
  if (from > to) return res.status(400).json({ error: 'from must not be after to' });
  if (Math.round((new Date(to + 'T00:00:00Z') - new Date(from + 'T00:00:00Z')) / 86400000) > 370)
    return res.status(400).json({ error: 'range is limited to 370 days' });
  // Filter in JS on site-timezone close date (tzDate is JS-side).
  const byItem = new Map();
  let grossTotal = 0, qtyTotal = 0, voidTotal = 0;
  const closedRows = db.prepare(
    `SELECT ci.menu_item_id, ci.qty, ci.unit_price_cents, ci.modifiers_json, ci.state,
            mi.name, mi.course, mi.station, mc.name AS category, c.closed_at
     FROM check_items ci
     JOIN checks c ON c.id = ci.check_id
     LEFT JOIN menu_items mi ON mi.id = ci.menu_item_id
     LEFT JOIN menu_categories mc ON mc.id = mi.category_id
     WHERE c.site_id = ? AND c.status IN ('paid','closed') AND c.closed_at IS NOT NULL`
  ).all(SITE_ID);
  for (const r of closedRows) {
    const d = tzDate(r.closed_at);
    if (d < from || d > to) continue;
    const mods = parseJson(r.modifiers_json, []);
    const line = r.qty * r.unit_price_cents + r.qty * mods.reduce((a, m) => a + (m.price_delta_cents || 0), 0);
    let e = byItem.get(r.menu_item_id);
    if (!e) {
      e = { menu_item_id: r.menu_item_id, name: r.name || ('Item ' + r.menu_item_id), category: r.category || null, course: r.course || null, station: r.station || null, qty_sold: 0, gross_cents: 0, voided_qty: 0 };
      byItem.set(r.menu_item_id, e);
    }
    if (r.state === 'cancelled') { e.voided_qty += r.qty; voidTotal += r.qty; }
    else { e.qty_sold += r.qty; e.gross_cents += line; qtyTotal += r.qty; grossTotal += line; }
  }
  const list = [...byItem.values()].map((e) => ({
    ...e,
    gross_share_pct: grossTotal ? +(100 * e.gross_cents / grossTotal).toFixed(2) : 0,
    void_rate_pct: (e.qty_sold + e.voided_qty) ? +(100 * e.voided_qty / (e.qty_sold + e.voided_qty)).toFixed(1) : 0,
  }));
  const byQty = [...list].sort((a, b) => b.qty_sold - a.qty_sold);
  const byGross = [...list].sort((a, b) => b.gross_cents - a.gross_cents);
  res.json({
    from, to,
    totals: { items: list.length, qty_sold: qtyTotal, gross_cents: grossTotal, voided_qty: voidTotal },
    best_by_qty: byQty.slice(0, 10), worst_by_qty: byQty.slice(-10).reverse(),
    best_by_gross: byGross.slice(0, 10), worst_by_gross: byGross.slice(-10).reverse(),
    items: list.sort((a, b) => b.gross_cents - a.gross_cents),
  });
});

/* ------------------- staff notes pushed at POS login -----------------------
   86s, specials (notes), and today's reservations surface at login — no
   pre-shift meeting required. Notes are manager-authored with an active
   window; the login summary merges them with live operational state. */
app.post('/api/admin/notes', managerOnly(), (req, res) => {
  const b = req.body || {};
  const title = cleanLabel(b.title);
  if (!title) return res.status(400).json({ error: 'title is required' });
  const body = typeof b.body === 'string' ? b.body.slice(0, 2000) : '';
  const priority = ['low', 'normal', 'high'].includes(b.priority) ? b.priority : 'normal';
  for (const k of ['active_from', 'active_to']) {
    if (b[k] != null && isNaN(Date.parse(b[k]))) return res.status(400).json({ error: k + ' must be a valid datetime' });
  }
  if (b.active_from && b.active_to && Date.parse(b.active_from) > Date.parse(b.active_to))
    return res.status(400).json({ error: 'active_from must not be after active_to' });
  const r = db.prepare(
    `INSERT INTO staff_notes (uuid, site_id, title, body, priority, active_from, active_to, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(crypto.randomUUID(), SITE_ID, title, body, priority, b.active_from || null, b.active_to || null, req.user.name, nowIso());
  auditApproval(req, 'note_create', {}, { note_id: r.lastInsertRowid, title });
  res.status(201).json(db.prepare('SELECT * FROM staff_notes WHERE id = ?').get(r.lastInsertRowid));
});

app.get('/api/admin/notes', managerOnly(), (req, res) => {
  res.json(db.prepare('SELECT * FROM staff_notes WHERE site_id = ? ORDER BY created_at DESC LIMIT 100').all(SITE_ID));
});

app.put('/api/admin/notes/:id', managerOnly(), (req, res) => {
  const n = db.prepare('SELECT * FROM staff_notes WHERE id = ? AND site_id = ?').get(req.params.id, SITE_ID);
  if (!n) return res.status(404).json({ error: 'Note not found' });
  const b = req.body || {};
  const title = b.title != null ? cleanLabel(b.title) : n.title;
  if (!title) return res.status(400).json({ error: 'title is required' });
  const body = b.body != null ? String(b.body).slice(0, 2000) : n.body;
  const priority = b.priority != null ? b.priority : n.priority;
  if (!['low', 'normal', 'high'].includes(priority)) return res.status(400).json({ error: 'priority must be low, normal, or high' });
  const af = b.active_from !== undefined ? b.active_from : n.active_from;
  const at = b.active_to !== undefined ? b.active_to : n.active_to;
  for (const [k, v] of [['active_from', af], ['active_to', at]]) {
    if (v != null && isNaN(Date.parse(v))) return res.status(400).json({ error: k + ' must be a valid datetime' });
  }
  if (af && at && Date.parse(af) > Date.parse(at)) return res.status(400).json({ error: 'active_from must not be after active_to' });
  db.prepare('UPDATE staff_notes SET title = ?, body = ?, priority = ?, active_from = ?, active_to = ? WHERE id = ?')
    .run(title, body, priority, af, at, n.id);
  res.json(db.prepare('SELECT * FROM staff_notes WHERE id = ?').get(n.id));
});

app.delete('/api/admin/notes/:id', managerOnly(), (req, res) => {
  const n = db.prepare('SELECT * FROM staff_notes WHERE id = ? AND site_id = ?').get(req.params.id, SITE_ID);
  if (!n) return res.status(404).json({ error: 'Note not found' });
  db.prepare('DELETE FROM staff_notes WHERE id = ?').run(n.id);
  auditApproval(req, 'note_delete', {}, { note_id: n.id, title: n.title });
  res.json({ deleted: n.id });
});

/** Everything a staff member needs to see at login: manager notes in their
 *  active window, current 86s, today's reservations, waitlist depth. */
app.get('/api/login-summary', (req, res) => {
  const now = nowIso();
  const prio = { high: 0, normal: 1, low: 2 };
  const notes = db.prepare(
    `SELECT id, title, body, priority, created_by, created_at FROM staff_notes
     WHERE site_id = ? AND (active_from IS NULL OR active_from <= ?) AND (active_to IS NULL OR active_to >= ?)`
  ).all(SITE_ID, now, now).sort((a, b) => (prio[a.priority] - prio[b.priority]) || (a.created_at < b.created_at ? 1 : -1));
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
  // Currently 86'd = inactive menu items (the 86 toggle flips active; un-86 restores it).
  const eightysix = db.prepare(
    `SELECT name FROM menu_items WHERE site_id = ? AND active = 0 ORDER BY name LIMIT 20`
  ).all(SITE_ID).map((r) => r.name);
  const today = todaySite();
  const resv = db.prepare(
    `SELECT id, customer_name, party_size, reserved_at, table_id, notes FROM reservations
     WHERE site_id = ? AND status = 'booked' ORDER BY reserved_at LIMIT 50`
  ).all(SITE_ID).filter((r) => tzDate(r.reserved_at) === today);
  const upcoming = resv.filter((r) => r.reserved_at >= now).slice(0, 3);
  const wlWaiting = db.prepare(
    `SELECT COUNT(*) AS c FROM waitlist WHERE site_id = ? AND status IN ('waiting','notified')`
  ).get(SITE_ID).c;
  const reviewPrompt = db.prepare("SELECT value FROM site_config WHERE site_id = ? AND key = 'review_prompt'").get(SITE_ID);
  res.json({
    notes, eighty_six: eightysix,
    reservations_today: { count: resv.length, upcoming },
    waitlist_waiting: wlWaiting,
    review_prompt: (reviewPrompt ? reviewPrompt.value : '0') === '1',
  });
});

/* --------------------- review prompts / guest marketing --------------------
   Post-payment nudge: after a check is paid, the payment device MAY offer a
   1–5 star rating. Guest-optional, shown once per check, never blocks
   payment, and the manager can disable it site-wide. No nagging. */
app.post('/api/reviews', serverPlus(), (req, res) => {
  const rp = db.prepare("SELECT value FROM site_config WHERE site_id = ? AND key = 'review_prompt'").get(SITE_ID);
  if ((rp ? rp.value : '0') !== '1') return res.status(409).json({ error: 'Review prompts are disabled for this site' });
  const b = req.body || {};
  const check = db.prepare('SELECT * FROM checks WHERE id = ? AND site_id = ?').get(b.check_id, SITE_ID);
  if (!check) return res.status(404).json({ error: 'Check not found' });
  if (!['paid', 'closed'].includes(check.status)) return res.status(400).json({ error: 'Reviews are only taken after payment' });
  if (!isInt(b.rating) || b.rating < 1 || b.rating > 5) return res.status(400).json({ error: 'rating must be 1–5' });
  const comment = typeof b.comment === 'string' ? b.comment.slice(0, 500) : null;
  try {
    const r = db.prepare(
      `INSERT INTO guest_reviews (site_id, check_id, rating, comment, marketing_opt_in, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(SITE_ID, check.id, b.rating, comment, b.marketing_opt_in ? 1 : 0, nowIso());
    res.status(201).json(db.prepare('SELECT * FROM guest_reviews WHERE id = ?').get(r.lastInsertRowid));
  } catch (e) {
    if (String(e.message || '').includes('UNIQUE')) return res.status(409).json({ error: 'This check already has a review' });
    throw e;
  }
});

app.get('/api/reviews', managerOnly(), (req, res) => {
  const rows = db.prepare('SELECT * FROM guest_reviews WHERE site_id = ? ORDER BY created_at DESC LIMIT 200').all(SITE_ID);
  const dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let sum = 0;
  for (const r of rows) { dist[r.rating] = (dist[r.rating] || 0) + 1; sum += r.rating; }
  res.json({
    count: rows.length,
    average: rows.length ? +(sum / rows.length).toFixed(2) : null,
    distribution: dist,
    marketing_opt_ins: rows.filter((r) => r.marketing_opt_in).length,
    reviews: rows,
  });
});

/** Manager settings (whitelisted keys only). */
const ADMIN_SETTINGS = new Set(['review_prompt', 'kds_archive_retention_days', 'stale_check_hours',
  'kds_age_warn_minutes', 'kds_age_critical_minutes']);
/* KDS aging pair (minutes). Defaults 8 / 15 apply when the pair is first
 * saved: saving either key materializes BOTH minute keys and their
 * derived seconds keys (kds_warn_secs / kds_late_secs — what
 * kdsThresholds() reads), so the stored pair is always complete and the
 * board always runs what the settings say. The keys are deliberately
 * NOT boot-seeded: an untouched site keeps the long-standing board
 * thresholds (600s / 1200s) the seconds surface has always driven.
 * POST /api/kds/settings (seconds) deletes the minute keys when it
 * writes warn/late — whichever surface wrote last owns the pair. */
const KDS_AGE_DEFAULTS = { kds_age_warn_minutes: 8, kds_age_critical_minutes: 15 };
function kdsAgeMinutes(key) {
  const row = db.prepare('SELECT value FROM site_config WHERE site_id = ? AND key = ?').get(SITE_ID, key);
  const n = row ? parseInt(row.value, 10) : NaN;
  return Number.isFinite(n) && n >= 1 && n <= 240 ? n : KDS_AGE_DEFAULTS[key];
}
app.put('/api/admin/settings', managerOnly(), (req, res) => {
  const b = req.body || {};
  if (!ADMIN_SETTINGS.has(b.key)) return res.status(400).json({ error: 'key must be one of: ' + [...ADMIN_SETTINGS].join(', ') });
  // review_prompt is boolean-ish: accept true/false, 1/0, and the strings
  // "true"/"false"/"1"/"0"/"on"/"off"/"yes"/"no" — a bare "false" string disables.
  let value;
  if (b.key === 'review_prompt') {
    const v = b.value;
    const off = v === false || v === 0 ||
      (typeof v === 'string' && ['0', 'false', 'off', 'no', ''].includes(v.trim().toLowerCase()));
    value = off ? '0' : '1';
  } else if (b.key === 'kds_archive_retention_days') {
    const n = parseInt(b.value, 10);
    if (!Number.isFinite(n) || n < 1 || n > 3650) return res.status(400).json({ error: 'kds_archive_retention_days must be an integer 1..3650' });
    value = String(n);
  } else if (b.key === 'stale_check_hours') {
    const n = parseInt(b.value, 10);
    if (!Number.isFinite(n) || n < 1 || n > 8760) return res.status(400).json({ error: 'stale_check_hours must be an integer 1..8760' });
    value = String(n);
  } else if (b.key === 'kds_age_warn_minutes' || b.key === 'kds_age_critical_minutes') {
    const n = Number(b.value);
    if (!Number.isInteger(n) || n < 1 || n > 240) {
      return res.status(400).json({ error: b.key + ' must be an integer 1..240 (minutes)' });
    }
    const otherKey = b.key === 'kds_age_warn_minutes' ? 'kds_age_critical_minutes' : 'kds_age_warn_minutes';
    const pair = { [b.key]: n, [otherKey]: kdsAgeMinutes(otherKey) };
    if (!(pair.kds_age_warn_minutes < pair.kds_age_critical_minutes)) {
      return res.status(400).json({
        error: 'kds_age_warn_minutes (' + pair.kds_age_warn_minutes +
          ') must be less than kds_age_critical_minutes (' + pair.kds_age_critical_minutes + ')',
      });
    }
    // Materialize the full pair + the derived seconds keys atomically,
    // so kdsThresholds() (seconds) always runs what these settings say.
    const up = db.prepare('INSERT INTO site_config (site_id, key, value) VALUES (?, ?, ?) ON CONFLICT(site_id, key) DO UPDATE SET value = excluded.value');
    withTransaction(() => {
      up.run(SITE_ID, 'kds_age_warn_minutes', String(pair.kds_age_warn_minutes));
      up.run(SITE_ID, 'kds_age_critical_minutes', String(pair.kds_age_critical_minutes));
      up.run(SITE_ID, 'kds_warn_secs', String(pair.kds_age_warn_minutes * 60));
      up.run(SITE_ID, 'kds_late_secs', String(pair.kds_age_critical_minutes * 60));
    });
    value = String(n);
  } else {
    value = String(b.value ?? '');
  }
  db.prepare('INSERT INTO site_config (site_id, key, value) VALUES (?, ?, ?) ON CONFLICT(site_id, key) DO UPDATE SET value = excluded.value')
    .run(SITE_ID, b.key, value);
  auditApproval(req, 'setting_change', {}, { key: b.key, value });
  res.json({ key: b.key, value });
});

/* ------------------------- multi-location dashboard -----------------------
   Cross-site overview on top of per-site DB isolation. Each site DB is
   opened READ-ONLY and wrapped in its own try/catch: one site's corrupt or
   locked file degrades to an error card and never touches the others. */
function multisiteFiles() {
  try {
    return fs.readdirSync(SITES_DIR)
      .filter((f) => f.endsWith('.db') && !f.endsWith('-wal') && !f.endsWith('-shm') && !f.endsWith('-journal'))
      .map((f) => path.join(SITES_DIR, f));
  } catch { return []; }
}
function multisiteSiteSummary(file) {
  const slug = path.basename(file, '.db');
  const rdb = new DatabaseSync(file, { readOnly: true });
  try {
    const has = (t) => rdb.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
    let name = slug;
    try { const s = rdb.prepare('SELECT name FROM sites LIMIT 1').get(); if (s && s.name) name = s.name; } catch { /* older db */ }
    const today = todaySite();
    const closed = has('checks')
      ? rdb.prepare("SELECT closed_at, total_cents FROM checks WHERE status IN ('paid','closed') AND closed_at IS NOT NULL").all()
      : [];
    let salesToday = 0, coversToday = 0;
    for (const c of closed) {
      if (tzDate(c.closed_at) === today) { salesToday += c.total_cents || 0; coversToday++; }
    }
    const openChecks = has('checks') ? rdb.prepare("SELECT COUNT(*) AS c FROM checks WHERE status = 'open'").get().c : 0;
    let drawer = 'none';
    if (has('cash_drawers')) {
      const d = rdb.prepare("SELECT status FROM cash_drawers WHERE status = 'open' LIMIT 1").get();
      drawer = d ? 'open' : 'closed';
    }
    let staffOn = 0;
    if (has('clock_shifts')) {
      try { staffOn = rdb.prepare('SELECT COUNT(*) AS c FROM clock_shifts WHERE clock_out IS NULL').get().c; } catch { staffOn = 0; }
    }
    return { slug, name, ok: true, sales_today_cents: salesToday, covers_today: coversToday, open_checks: openChecks, drawer, staff_clocked_in: staffOn };
  } finally {
    try { rdb.close(); } catch { /* ignore */ }
  }
}
app.get('/api/admin/multisite/overview', managerOnly(), (req, res) => {
  const sites = [];
  for (const f of multisiteFiles()) {
    try {
      sites.push(multisiteSiteSummary(f));
    } catch (e) {
      // One site's failure (corrupt/locked/unreadable) never touches another.
      sites.push({ slug: path.basename(f, '.db'), name: path.basename(f, '.db'), ok: false, error: 'unreadable: ' + String((e && e.message) || e).slice(0, 120) });
    }
  }
  res.json({ sites });
});

/* ------------------------------ inventory (1) -----------------------------
   Phase 1: ingredient records, per-menu-item recipes, depletion on fire
   (/send), manual adjustments with audit, low-stock status.
   Phase 2 (below, after /adjust): depletion is ledgered ('sale depletion'),
   waste logging, PO-less receiving, physical counts with correction rows,
   and a theoretical-vs-actual variance report. Purchase orders as documents
   are deliberately still out of scope. */
function ingredientById(id) {
  return db.prepare('SELECT * FROM ingredients WHERE id = ? AND site_id = ?').get(id, SITE_ID);
}
app.get('/api/admin/inventory/ingredients', managerOnly(), (req, res) => {
  const rows = db.prepare('SELECT * FROM ingredients WHERE site_id = ? AND active = 1 ORDER BY name').all(SITE_ID);
  res.json(rows.map((r) => ({ ...r, low: r.on_hand <= r.par })));
});
app.post('/api/admin/inventory/ingredients', managerOnly(), (req, res) => {
  const b = req.body || {};
  const name = cleanLabel(b.name);
  if (!name) return res.status(400).json({ error: 'name is required' });
  const unit = cleanLabel(b.unit) || 'ea';
  for (const [k, v] of [['on_hand', b.on_hand], ['par', b.par]]) {
    if (v != null && (typeof v !== 'number' || !isFinite(v) || v < 0))
      return res.status(400).json({ error: k + ' must be a non-negative number' });
  }
  if (b.cost_per_unit_cents != null && (!isInt(b.cost_per_unit_cents) || b.cost_per_unit_cents < 0))
    return res.status(400).json({ error: 'cost_per_unit_cents must be a non-negative integer' });
  const r = db.prepare(
    `INSERT INTO ingredients (site_id, name, unit, on_hand, par, cost_per_unit_cents, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(SITE_ID, name, unit, b.on_hand || 0, b.par || 0, b.cost_per_unit_cents || 0, nowIso());
  auditApproval(req, 'ingredient_create', {}, { ingredient_id: r.lastInsertRowid, name });
  res.status(201).json(ingredientById(r.lastInsertRowid));
});
app.put('/api/admin/inventory/ingredients/:id', managerOnly(), (req, res) => {
  const ing = ingredientById(req.params.id);
  if (!ing) return res.status(404).json({ error: 'Ingredient not found' });
  const b = req.body || {};
  const name = b.name != null ? cleanLabel(b.name) : ing.name;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const unit = b.unit != null ? (cleanLabel(b.unit) || 'ea') : ing.unit;
  const onHand = b.on_hand != null ? b.on_hand : ing.on_hand;
  const par = b.par != null ? b.par : ing.par;
  for (const [k, v] of [['on_hand', onHand], ['par', par]]) {
    if (typeof v !== 'number' || !isFinite(v) || v < 0) return res.status(400).json({ error: k + ' must be a non-negative number' });
  }
  const cost = b.cost_per_unit_cents != null ? b.cost_per_unit_cents : ing.cost_per_unit_cents;
  if (!isInt(cost) || cost < 0) return res.status(400).json({ error: 'cost_per_unit_cents must be a non-negative integer' });
  db.prepare('UPDATE ingredients SET name = ?, unit = ?, on_hand = ?, par = ?, cost_per_unit_cents = ? WHERE id = ?')
    .run(name, unit, onHand, par, cost, ing.id);
  auditApproval(req, 'ingredient_update', {}, { ingredient_id: ing.id, name });
  res.json(ingredientById(ing.id));
});
app.delete('/api/admin/inventory/ingredients/:id', managerOnly(), (req, res) => {
  const ing = ingredientById(req.params.id);
  if (!ing) return res.status(404).json({ error: 'Ingredient not found' });
  db.prepare('UPDATE ingredients SET active = 0 WHERE id = ?').run(ing.id); // deactivate, keep history
  auditApproval(req, 'ingredient_deactivate', {}, { ingredient_id: ing.id, name: ing.name });
  res.json({ deactivated: ing.id });
});
/** Replace the recipe (ingredient lines) for one menu item. */
app.post('/api/admin/inventory/recipes', managerOnly(), (req, res) => {
  const b = req.body || {};
  const item = b.menu_item_id != null
    ? db.prepare('SELECT id, name FROM menu_items WHERE id = ? AND site_id = ?').get(b.menu_item_id, SITE_ID)
    : null;
  if (!item) return res.status(400).json({ error: 'Valid menu_item_id is required' });
  const lines = b.lines == null ? [] : b.lines;
  if (!Array.isArray(lines)) return res.status(400).json({ error: 'lines must be an array' });
  const seen = new Set();
  for (const [i, ln] of lines.entries()) {
    const ing = ln && ln.ingredient_id != null ? ingredientById(ln.ingredient_id) : null;
    if (!ing || !ing.active) return res.status(400).json({ error: `lines[${i}]: valid active ingredient_id is required` });
    if (typeof ln.qty !== 'number' || !isFinite(ln.qty) || ln.qty <= 0)
      return res.status(400).json({ error: `lines[${i}]: qty must be a positive number` });
    if (seen.has(ing.id)) return res.status(400).json({ error: `lines[${i}]: duplicate ingredient ${ing.name}` });
    seen.add(ing.id);
  }
  withTransaction(() => {
    db.prepare('DELETE FROM recipes WHERE site_id = ? AND menu_item_id = ?').run(SITE_ID, item.id);
    const ins = db.prepare('INSERT INTO recipes (site_id, menu_item_id, ingredient_id, qty) VALUES (?, ?, ?, ?)');
    for (const ln of lines) ins.run(SITE_ID, item.id, ln.ingredient_id, ln.qty);
  });
  auditApproval(req, 'recipe_set', {}, { menu_item_id: item.id, lines: lines.length });
  res.json({ menu_item_id: item.id, lines: lines.length });
});
app.get('/api/admin/inventory/recipes', managerOnly(), (req, res) => {
  const q = req.query.menu_item_id;
  let rows;
  if (q != null) {
    rows = db.prepare(
      `SELECT r.*, i.name AS ingredient_name, i.unit FROM recipes r JOIN ingredients i ON i.id = r.ingredient_id
       WHERE r.site_id = ? AND r.menu_item_id = ?`
    ).all(SITE_ID, q);
  } else {
    rows = db.prepare(
      `SELECT r.*, i.name AS ingredient_name, i.unit, mi.name AS item_name FROM recipes r
       JOIN ingredients i ON i.id = r.ingredient_id JOIN menu_items mi ON mi.id = r.menu_item_id
       WHERE r.site_id = ? ORDER BY mi.name`
    ).all(SITE_ID);
  }
  res.json(rows);
});
app.post('/api/admin/inventory/adjust', managerOnly(), (req, res) => {
  const b = req.body || {};
  const ing = b.ingredient_id != null ? ingredientById(b.ingredient_id) : null;
  if (!ing || !ing.active) return res.status(400).json({ error: 'Valid active ingredient_id is required' });
  if (typeof b.delta !== 'number' || !isFinite(b.delta) || b.delta === 0)
    return res.status(400).json({ error: 'delta must be a non-zero number' });
  if (overQtyCap(b.delta))
    return res.status(400).json({ error: 'delta exceeds the ' + MAX_STOCK_QTY + ' sanity cap' });
  const reason = cleanLabel(b.reason) || 'manual adjustment';
  withTransaction(() => {
    db.prepare('UPDATE ingredients SET on_hand = on_hand + ? WHERE id = ?').run(b.delta, ing.id);
    /* kind is ALWAYS 'manual' here: the reason is the manager's free text
       and must never land this row in a structured variance bucket. */
    db.prepare('INSERT INTO inventory_adjustments (site_id, ingredient_id, delta, reason, kind, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(SITE_ID, ing.id, b.delta, reason, 'manual', req.user.name, nowIso());
  });
  auditApproval(req, 'inventory_adjust', {}, { ingredient_id: ing.id, delta: b.delta, reason });
  res.json(ingredientById(ing.id));
});
/* ------------------------- inventory phase 2 ------------------------------
   Waste, receiving (deliberately PO-less — no purchase-order documents),
   physical counts, and the theoretical-vs-actual variance report. Every
   movement writes an inventory_adjustments row carrying a structured
   `kind` — the variance report buckets on kind ONLY, never on the reason
   text (which for manual adjustments is manager free text). The reason
   strings stay human-readable, in one consistent format:
     kind 'depletion'       reason 'sale depletion'   (depleteInventoryForItems)
     kind 'waste'           reason 'waste: <code>' [+ ' — <note>']
     kind 'receiving'       reason 'receiving' [+ ' — <supplier>' [+ ' · inv <invoice_ref>']]
     kind 'count_correction' reason 'count correction'
     kind 'manual'          reason = manager free text (POST /adjust)
   Waste cost uses the ingredient's stored unit cost (cost_per_unit_cents)
   at the moment of the movement; an unset cost is 0, so waste cost is 0. */
const WASTE_REASON_CODES = ['spoilage', 'expired', 'dropped', 'over_portioned', 'quality', 'other'];
const r4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000; // quantities are REAL; trim float dust
function inventoryTarget(req, res) {
  const b = req.body || {};
  const ing = b.ingredient_id != null ? ingredientById(b.ingredient_id) : null;
  if (!ing || !ing.active) { res.status(400).json({ error: 'Valid active ingredient_id is required' }); return null; }
  return ing;
}
const isPositiveQty = (v) => typeof v === 'number' && isFinite(v) && v > 0;
/* Sanity cap on a single stock movement: quantities are real-world amounts
   (lb / L / ea), so anything past this is a typo or a runaway client and
   must not zero — or explode — the book. Shared by waste / receive /
   count / adjust. */
const MAX_STOCK_QTY = 1000000;
const overQtyCap = (v) => Math.abs(v) > MAX_STOCK_QTY;
function writeAdjustment(ingredientId, delta, reason, kind, actor) {
  db.prepare('INSERT INTO inventory_adjustments (site_id, ingredient_id, delta, reason, kind, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(SITE_ID, ingredientId, delta, reason, kind, actor, nowIso());
}

app.post('/api/admin/inventory/waste', managerOnly(), (req, res) => {
  const ing = inventoryTarget(req, res); if (!ing) return;
  const b = req.body || {};
  if (!isPositiveQty(b.qty)) return res.status(400).json({ error: 'qty must be a positive number' });
  if (overQtyCap(b.qty)) return res.status(400).json({ error: 'qty exceeds the ' + MAX_STOCK_QTY + ' sanity cap' });
  if (!WASTE_REASON_CODES.includes(b.reason_code))
    return res.status(400).json({ error: 'reason_code must be one of: ' + WASTE_REASON_CODES.join(', ') });
  const note = b.note != null ? cleanLabel(b.note) : null;
  const reason = 'waste: ' + b.reason_code + (note ? ' — ' + note : '');
  const wasteCost = Math.round(b.qty * (ing.cost_per_unit_cents || 0));
  withTransaction(() => {
    db.prepare('UPDATE ingredients SET on_hand = on_hand - ? WHERE id = ?').run(b.qty, ing.id);
    writeAdjustment(ing.id, -b.qty, reason, 'waste', req.user.name);
  });
  auditApproval(req, 'inventory_waste', {}, { ingredient_id: ing.id, qty: b.qty, reason_code: b.reason_code, waste_cost_cents: wasteCost });
  res.json({ ingredient: ingredientById(ing.id), wasted_qty: b.qty, waste_cost_cents: wasteCost });
});

app.post('/api/admin/inventory/receive', managerOnly(), (req, res) => {
  const ing = inventoryTarget(req, res); if (!ing) return;
  const b = req.body || {};
  if (!isPositiveQty(b.qty)) return res.status(400).json({ error: 'qty must be a positive number' });
  if (overQtyCap(b.qty)) return res.status(400).json({ error: 'qty exceeds the ' + MAX_STOCK_QTY + ' sanity cap' });
  if (b.unit_cost_cents != null && (!isInt(b.unit_cost_cents) || b.unit_cost_cents < 0))
    return res.status(400).json({ error: 'unit_cost_cents must be a non-negative integer' });
  const supplier = b.supplier != null ? cleanLabel(b.supplier) : null;
  const invoiceRef = b.invoice_ref != null ? cleanLabel(b.invoice_ref) : null;
  const detail = [supplier, invoiceRef ? 'inv ' + invoiceRef : null].filter(Boolean).join(' · ');
  const reason = 'receiving' + (detail ? ' — ' + detail : '');
  withTransaction(() => {
    db.prepare('UPDATE ingredients SET on_hand = on_hand + ? WHERE id = ?').run(b.qty, ing.id);
    /* Latest-cost semantics: a delivery cost stated on receiving replaces
       the stored unit cost, so stock value and waste cost track the newest
       invoice price. Omit unit_cost_cents to keep the stored cost. */
    if (b.unit_cost_cents != null)
      db.prepare('UPDATE ingredients SET cost_per_unit_cents = ? WHERE id = ?').run(b.unit_cost_cents, ing.id);
    writeAdjustment(ing.id, b.qty, reason, 'receiving', req.user.name);
  });
  auditApproval(req, 'inventory_receive', {}, { ingredient_id: ing.id, qty: b.qty, unit_cost_cents: b.unit_cost_cents ?? null, supplier, invoice_ref: invoiceRef });
  res.json({ ingredient: ingredientById(ing.id), received_qty: b.qty });
});

app.post('/api/admin/inventory/count', managerOnly(), (req, res) => {
  const ing = inventoryTarget(req, res); if (!ing) return;
  const b = req.body || {};
  if (typeof b.counted_qty !== 'number' || !isFinite(b.counted_qty) || b.counted_qty < 0)
    return res.status(400).json({ error: 'counted_qty must be a non-negative number' });
  if (overQtyCap(b.counted_qty))
    return res.status(400).json({ error: 'counted_qty exceeds the ' + MAX_STOCK_QTY + ' sanity cap' });
  const expected = ing.on_hand;
  const variance = r4(b.counted_qty - expected);
  /* No separate counts table: when the count disagrees with the book, the
     'count correction' adjustment row IS the record of the count. A count
     that matches writes no row (but is still audit-logged below). */
  if (variance !== 0) {
    withTransaction(() => {
      db.prepare('UPDATE ingredients SET on_hand = ? WHERE id = ?').run(b.counted_qty, ing.id);
      writeAdjustment(ing.id, variance, 'count correction', 'count_correction', req.user.name);
    });
  }
  auditApproval(req, 'inventory_count', {}, { ingredient_id: ing.id, expected, counted: b.counted_qty, variance });
  res.json({ ingredient: ingredientById(ing.id), expected, counted: b.counted_qty, variance });
});

app.get('/api/admin/inventory/variance', managerOnly(), (req, res) => {
  const nowMs = Date.now();
  const parseWin = (v, fallback, endOfDay) => {
    if (v == null || v === '') return fallback;
    let s = String(v);
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s += endOfDay ? 'T23:59:59.999Z' : 'T00:00:00.000Z';
    const t = Date.parse(s);
    return isNaN(t) ? null : new Date(t).toISOString();
  };
  const from = parseWin(req.query.from, new Date(nowMs - 7 * 864e5).toISOString(), false);
  const to = parseWin(req.query.to, new Date(nowMs).toISOString(), true);
  if (!from || !to) return res.status(400).json({ error: 'from/to must be ISO dates' });
  if (from > to) return res.status(400).json({ error: 'from must not be after to' });
  /* Inclusion rule: an ingredient appears iff it has at least one ledger row
     inside the window (any kind). Buckets key on the structured kind ONLY —
     reason text is never consulted, so a manual adjustment whose free-text
     reason happens to read like a structured movement cannot pollute a
     bucket (it still counts toward net_change). Waste cost is valued at
     each ingredient's CURRENT stored unit cost. */
  const rows = db.prepare(`
    SELECT i.id AS ingredient_id, i.name AS name, i.unit AS unit, i.cost_per_unit_cents AS cost_per_unit_cents,
      SUM(CASE WHEN a.kind = 'depletion' THEN -a.delta ELSE 0 END) AS theoretical_usage,
      SUM(CASE WHEN a.kind = 'waste' THEN -a.delta ELSE 0 END) AS waste_qty,
      SUM(CASE WHEN a.kind = 'receiving' THEN a.delta ELSE 0 END) AS received_qty,
      SUM(CASE WHEN a.kind = 'count_correction' THEN a.delta ELSE 0 END) AS count_correction_qty,
      SUM(a.delta) AS net_change
    FROM inventory_adjustments a JOIN ingredients i ON i.id = a.ingredient_id
    WHERE a.site_id = ? AND a.created_at >= ? AND a.created_at <= ?
    GROUP BY a.ingredient_id ORDER BY i.name`).all(SITE_ID, from, to);
  const ingredients = rows.map((r) => ({
    ingredient_id: r.ingredient_id, name: r.name, unit: r.unit,
    theoretical_usage: r4(r.theoretical_usage),
    waste_qty: r4(r.waste_qty),
    waste_cost_cents: Math.round((r.waste_qty || 0) * (r.cost_per_unit_cents || 0)),
    received_qty: r4(r.received_qty),
    count_correction_qty: r4(r.count_correction_qty),
    net_change: r4(r.net_change),
  }));
  const totals = { theoretical_usage: 0, waste_qty: 0, waste_cost_cents: 0, received_qty: 0, count_correction_qty: 0, net_change: 0 };
  for (const r of ingredients) {
    totals.theoretical_usage = r4(totals.theoretical_usage + r.theoretical_usage);
    totals.waste_qty = r4(totals.waste_qty + r.waste_qty);
    totals.waste_cost_cents += r.waste_cost_cents;
    totals.received_qty = r4(totals.received_qty + r.received_qty);
    totals.count_correction_qty = r4(totals.count_correction_qty + r.count_correction_qty);
    totals.net_change = r4(totals.net_change + r.net_change);
  }
  res.json({ from, to, ingredients, totals });
});

app.get('/api/inventory/status', managerOnly(), (req, res) => {
  const ings = db.prepare('SELECT * FROM ingredients WHERE site_id = ? AND active = 1 ORDER BY name').all(SITE_ID);
  const recent = db.prepare(
    `SELECT a.*, i.name AS ingredient_name FROM inventory_adjustments a
     JOIN ingredients i ON i.id = a.ingredient_id
     WHERE a.site_id = ? ORDER BY a.created_at DESC LIMIT 25`
  ).all(SITE_ID);
  res.json({
    low_stock: ings.filter((r) => r.on_hand <= r.par).map((r) => ({ ...r, low: true })),
    ingredient_count: ings.length,
    recent_adjustments: recent,
  });
});
/** Deplete inventory for fired items. Called inside the fire transaction
 * (shared by /send, /fire-course, and /send-now).
 * Phase 2: every depletion is also written to the inventory_adjustments
 * ledger — one row per ingredient per fire, aggregated across all fired
 * lines (reason 'sale depletion', kind 'depletion') — so theoretical usage
 * is auditable against waste/counts. The on_hand math is unchanged from
 * phase 1. */
function depleteInventoryForItems(heldItems, actor) {
  const lineStmt = db.prepare('SELECT ingredient_id, qty FROM recipes WHERE site_id = ? AND menu_item_id = ?');
  const decStmt = db.prepare('UPDATE ingredients SET on_hand = on_hand - ? WHERE id = ? AND site_id = ?');
  const ledStmt = db.prepare('INSERT INTO inventory_adjustments (site_id, ingredient_id, delta, reason, kind, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const used = new Map(); // ingredient_id -> total qty consumed by this fire
  for (const it of heldItems) {
    for (const ln of lineStmt.all(SITE_ID, it.menu_item_id)) {
      const qty = ln.qty * (it.qty || 1);
      decStmt.run(qty, ln.ingredient_id, SITE_ID);
      used.set(ln.ingredient_id, (used.get(ln.ingredient_id) || 0) + qty);
    }
  }
  if (used.size) {
    const ts = nowIso();
    for (const [ingredientId, qty] of used) {
      ledStmt.run(SITE_ID, ingredientId, -qty, 'sale depletion', 'depletion', actor || 'system', ts);
    }
  }
}

/* ------------------------------ open API docs ------------------------------
   Open API before an app store: every endpoint documented from a single
   registry so docs can't drift from the code. Served as JSON for machines
   and rendered HTML for humans. Stability note: this API is internal v0.1 —
   third-party bearer scopes do not exist yet; staff PIN-login tokens only. */
const API_DOCS = [
  { method: 'GET', path: '/api/health', auth: 'none', summary: 'Liveness probe', params: '—' },
  { method: 'POST', path: '/api/auth/login', auth: 'none', summary: 'PIN login → Bearer <redacted>', params: 'pin' },
  { method: 'GET', path: '/api/config', auth: 'any staff', summary: 'Site config (tax, surcharge, service charge)', params: '—' },
  { method: 'GET', path: '/api/menu', auth: 'any staff', summary: 'Full menu with categories, items, modifiers', params: '—' },
  { method: 'GET', path: '/api/zones', auth: 'any staff', summary: 'Floor zones with tables', params: '—' },
  { method: 'POST', path: '/api/checks', auth: 'server+', summary: 'Open a check on a table — or a bar tab (channel bar_tab) when table_id is omitted and tab_name names the guest', params: 'table_id?, guest_count, tab_name?' },
  { method: 'GET', path: '/api/checks/open', auth: 'server+', summary: 'List open checks', params: '—' },
  { method: 'GET', path: '/api/checks/:id', auth: 'server+', summary: 'Check with items, totals, payments', params: '—' },
  { method: 'POST', path: '/api/checks/:id/items', auth: 'server+', summary: 'Add held item (server-side price lock)', params: 'menu_item_id, seat, qty, modifiers' },
  { method: 'POST', path: '/api/checks/:id/send', auth: 'server+', summary: 'Fire held items → KDS, depletes inventory', params: '—' },
  { method: 'POST', path: '/api/checks/:id/void-item', auth: 'server+ (+manager PIN approval)', summary: 'Void an item, audit-logged', params: 'item_id, manager_pin, reason' },
  { method: 'POST', path: '/api/checks/:id/comp', auth: 'server+ (+manager PIN approval)', summary: 'Comp value on a check', params: 'amount_cents, manager_pin, reason' },
  { method: 'POST', path: '/api/checks/:id/transfer', auth: 'server+ (+manager PIN to take another server\'s check)', summary: 'Transfer check to another server / claim unassigned (NEW 3.6)', params: 'to_server_id, from_server_id, manager_pin?, reason?' },
  { method: 'POST', path: '/api/checks/:id/reopen', auth: 'manager (+fresh manager PIN)', summary: 'Reopen a paid check that still has a positive balance (e.g. refund could not auto-reopen because table was re-seated)', params: 'manager_pin' },
  { method: 'POST', path: '/api/checks/:id/split', auth: 'server+', summary: 'Even / by-seat / by-item split', params: 'mode, ...' },
  { method: 'POST', path: '/api/checks/:id/payments', auth: 'server+', summary: 'Take cash, card_demo, or house_account payment (house_account requires a manager-created account)', params: 'method, amount_cents, tip_cents, tendered_cents?, memo?' },
  { method: 'GET', path: '/api/admin/house-accounts', auth: 'server+', summary: 'List house accounts (manager-created only)', params: '—' },
  { method: 'POST', path: '/api/admin/house-accounts', auth: 'manager', summary: 'Create a house account', params: 'name' },
  { method: 'PATCH', path: '/api/admin/house-accounts/:id', auth: 'manager', summary: 'Activate/deactivate a house account', params: 'active' },
  { method: 'POST', path: '/api/payments/:id/refund', auth: 'manager', summary: 'Refund a payment', params: 'amount_cents?' },
  { method: 'POST', path: '/api/checks/:id/close', auth: 'server+', summary: 'Close a fully-paid check', params: '—' },
  { method: 'GET', path: '/api/kds/tickets', auth: 'kitchen+', summary: 'KDS tickets by station', params: 'station?' },
  { method: 'POST', path: '/api/kds/tickets/:id/bump', auth: 'kitchen+', summary: 'Bump a ticket', params: '—' },
  { method: 'GET', path: '/api/kds/recall', auth: 'kitchen+', summary: 'Recall bumped tickets', params: '—' },
  { method: 'GET', path: '/api/finance/payouts', auth: 'manager', summary: 'Honest payout reconciliation', params: 'date?' },
  { method: 'GET', path: '/api/finance/shift', auth: 'manager', summary: 'Shift report: sales, tips, cash owed', params: 'date?, server_id?' },
  { method: 'GET', path: '/api/finance/reports/:report', auth: 'manager', summary: 'sales|payouts|tax|labor|tips export', params: 'period|from&to, format=xlsx|csv|pdf|docx|json' },
  { method: 'GET', path: '/api/finance/product-mix', auth: 'manager', summary: 'Best/worst sellers, void rates (NEW 3C)', params: 'from?, to?' },
  { method: 'GET', path: '/api/manager/overview', auth: 'manager', summary: 'Today sales, open checks, covers', params: '—' },
  { method: 'POST', path: '/api/clock/in', auth: 'any staff', summary: 'Clock in (own PIN)', params: 'pin' },
  { method: 'POST', path: '/api/clock/out', auth: 'any staff', summary: 'Clock out with break attestation', params: '—' },
  { method: 'POST', path: '/api/clock/break/start', auth: 'any staff', summary: 'Start meal/rest break', params: 'type' },
  { method: 'POST', path: '/api/clock/break/end', auth: 'any staff', summary: 'End break', params: '—' },
  { method: 'POST', path: '/api/clock/break/waive', auth: 'any staff', summary: 'Waive a break (CA rules)', params: 'type' },
  { method: 'GET', path: '/api/clock/status', auth: 'any staff', summary: 'Current shift + break state', params: '—' },
  { method: 'GET', path: '/api/admin/clock/shifts', auth: 'manager', summary: 'Shifts with CA premium math', params: 'date?' },
  { method: 'POST', path: '/api/admin/clock/adjust', auth: 'manager', summary: 'Adjust a shift (PIN + audit)', params: 'shift_id, manager_pin, ...' },
  { method: 'GET', path: '/api/admin/employees', auth: 'manager', summary: 'Employee records', params: '—' },
  { method: 'POST', path: '/api/admin/employees', auth: 'manager', summary: 'Create employee (unique # + PIN)', params: 'name, role, pin, ...' },
  { method: 'PUT', path: '/api/admin/employees/:id', auth: 'manager', summary: 'Update employee', params: '—' },
  { method: 'DELETE', path: '/api/admin/employees/:id', auth: 'manager', summary: 'Deactivate employee', params: '—' },
  { method: 'POST', path: '/api/reservations', auth: 'server+', summary: 'Book a reservation', params: 'customer_name, party_size, reserved_at, ...' },
  { method: 'GET', path: '/api/reservations', auth: 'server+', summary: 'List reservations', params: 'date?' },
  { method: 'PATCH', path: '/api/reservations/:id', auth: 'server+', summary: 'Update reservation', params: 'status, ...' },
  { method: 'DELETE', path: '/api/reservations/:id', auth: 'server+', summary: 'Cancel reservation', params: '—' },
  { method: 'POST', path: '/api/waitlist', auth: 'server+', summary: 'Add to waitlist — quote auto-computed from turn-time data; pre-order optional (NEW 3C)', params: 'customer_name, party_size, quoted_wait_min?, preorder_items?' },
  { method: 'GET', path: '/api/waitlist', auth: 'server+', summary: 'Waiting/notified entries with pre-orders', params: '—' },
  { method: 'GET', path: '/api/waitlist/quote', auth: 'server+', summary: 'Data-driven wait quote, no signup needed (NEW 3C)', params: 'party_size' },
  { method: 'POST', path: '/api/waitlist/:id/notify', auth: 'server+', summary: 'Mark entry notified', params: '—' },
  { method: 'POST', path: '/api/waitlist/:id/seat', auth: 'server+', summary: 'Seat entry → opens check, attaches pre-order as held items (NEW 3C)', params: 'table_id' },
  { method: 'GET', path: '/api/floor/availability', auth: 'server+', summary: 'Table availability + suggestions', params: 'datetime?, party_size?, duration_min?' },
  { method: 'POST', path: '/api/cash/drawer/open', auth: 'manager', summary: 'Open cash drawer with float (NEW 3C)', params: 'opening_float_cents' },
  { method: 'GET', path: '/api/cash/drawer', auth: 'server+ (expected hidden from non-managers)', summary: 'Drawer state + events; blind count enforced by role (NEW 3C)', params: '—' },
  { method: 'POST', path: '/api/cash/drawer/event', auth: 'server+', summary: 'Log paid_in / paid_out / no_sale / note (NEW 3C)', params: 'kind, amount_cents?, note?' },
  { method: 'POST', path: '/api/cash/drawer/close', auth: 'manager', summary: 'Blind-count closeout → server-computed variance (NEW 3C)', params: 'counted_cents, notes?' },
  { method: 'GET', path: '/api/cash/log', auth: 'manager', summary: 'Drawer history with expected/counted/variance (NEW 3C)', params: '—' },
  { method: 'GET', path: '/api/admin/schedule', auth: 'manager', summary: 'Week of scheduled shifts (NEW 3C)', params: 'week?' },
  { method: 'POST', path: '/api/admin/schedule', auth: 'manager', summary: 'Schedule a shift (NEW 3C)', params: 'employee_name|user_id, work_date, start_min, end_min, role?, rate_cents?' },
  { method: 'PUT', path: '/api/admin/schedule/:id', auth: 'manager', summary: 'Edit a scheduled shift (NEW 3C)', params: '—' },
  { method: 'DELETE', path: '/api/admin/schedule/:id', auth: 'manager', summary: 'Delete a scheduled shift (NEW 3C)', params: '—' },
  { method: 'GET', path: '/api/admin/schedule/projection', auth: 'manager', summary: 'Projected labor cost vs projected sales per day (NEW 3C)', params: 'week?' },
  { method: 'POST', path: '/api/admin/notes', auth: 'manager', summary: 'Create a staff note (NEW 3C)', params: 'title, body?, priority?, active_from?, active_to?' },
  { method: 'GET', path: '/api/admin/notes', auth: 'manager', summary: 'List staff notes (NEW 3C)', params: '—' },
  { method: 'PUT', path: '/api/admin/notes/:id', auth: 'manager', summary: 'Edit a staff note (NEW 3C)', params: '—' },
  { method: 'DELETE', path: '/api/admin/notes/:id', auth: 'manager', summary: 'Delete a staff note (NEW 3C)', params: '—' },
  { method: 'GET', path: '/api/login-summary', auth: 'any staff', summary: 'Notes + 86s + today reservations + waitlist depth at login (NEW 3C)', params: '—' },
  { method: 'POST', path: '/api/reviews', auth: 'server+', summary: 'Post-payment 1–5★ review, once per check (NEW 3C)', params: 'check_id, rating, comment?, marketing_opt_in?' },
  { method: 'GET', path: '/api/reviews', auth: 'manager', summary: 'Review summary + list (NEW 3C)', params: '—' },
  { method: 'PUT', path: '/api/admin/settings', auth: 'manager', summary: 'Whitelisted site settings (review_prompt, kds_archive_retention_days, stale_check_hours, kds_age_warn_minutes, kds_age_critical_minutes)', params: 'key, value' },
  { method: 'GET', path: '/api/admin/multisite/overview', auth: 'manager', summary: 'Cross-site dashboard; one site failure never touches another (NEW 3C)', params: '—' },
  { method: 'GET', path: '/api/admin/inventory/ingredients', auth: 'manager', summary: 'Ingredient records with low-stock flags (NEW 3C)', params: '—' },
  { method: 'POST', path: '/api/admin/inventory/ingredients', auth: 'manager', summary: 'Create ingredient (NEW 3C)', params: 'name, unit?, on_hand?, par?, cost_per_unit_cents?' },
  { method: 'PUT', path: '/api/admin/inventory/ingredients/:id', auth: 'manager', summary: 'Update ingredient (NEW 3C)', params: '—' },
  { method: 'DELETE', path: '/api/admin/inventory/ingredients/:id', auth: 'manager', summary: 'Deactivate ingredient (NEW 3C)', params: '—' },
  { method: 'GET', path: '/api/admin/inventory/recipes', auth: 'manager', summary: 'Recipe lines (NEW 3C)', params: 'menu_item_id?' },
  { method: 'POST', path: '/api/admin/inventory/recipes', auth: 'manager', summary: 'Replace recipe lines for a menu item (NEW 3C)', params: 'menu_item_id, lines[]' },
  { method: 'POST', path: '/api/admin/inventory/adjust', auth: 'manager', summary: 'Manual stock adjustment, audited (NEW 3C)', params: 'ingredient_id, delta, reason?' },
  { method: 'POST', path: '/api/admin/inventory/waste', auth: 'manager', summary: 'Log waste with a reason code; returns waste cost (Phase 2)', params: 'ingredient_id, qty, reason_code, note?' },
  { method: 'POST', path: '/api/admin/inventory/receive', auth: 'manager', summary: 'Receive a delivery (PO-less); stated cost replaces stored cost (Phase 2)', params: 'ingredient_id, qty, unit_cost_cents?, supplier?, invoice_ref?' },
  { method: 'POST', path: '/api/admin/inventory/count', auth: 'manager', summary: 'Physical stock count; writes a count-correction row on variance (Phase 2)', params: 'ingredient_id, counted_qty' },
  { method: 'GET', path: '/api/admin/inventory/variance', auth: 'manager', summary: 'Theoretical vs actual: usage, waste, receiving, count corrections per ingredient (Phase 2)', params: 'from?, to?' },
  { method: 'GET', path: '/api/inventory/status', auth: 'manager', summary: 'Low-stock list + recent adjustments (NEW 3C)', params: '—' },
  { method: 'GET', path: '/api/openapi.json', auth: 'manager', summary: 'Machine-readable endpoint registry (NEW 3C)', params: '—' },
  { method: 'GET', path: '/api/docs', auth: 'manager', summary: 'Human-readable API documentation (NEW 3C)', params: '—' },
];
app.get('/api/openapi.json', managerOnly(), (req, res) => {
  res.json({
    name: 'expoline', version: '0.1.0', base_url: '/api',
    auth: 'Bearer <token> from POST /api/auth/login (staff PIN). Roles: server, kitchen, manager. server+ = server or manager; kitchen+ = kitchen or manager.',
    stability: 'internal v0.1 — endpoints may change; third-party OAuth scopes do not exist yet (staff tokens only).',
    money: 'All money is integer cents. Dates are ISO-8601 strings; reporting buckets use the America/Los_Angeles site timezone.',
    endpoints: API_DOCS,
  });
});
app.get('/api/docs', managerOnly(), (req, res) => {
  const escH = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const rows = API_DOCS.map((e) =>
    `<tr><td><span class="m">${escH(e.method)}</span></td><td><code>${escH(e.path)}</code></td>` +
    `<td>${escH(e.auth)}</td><td>${escH(e.summary)}</td><td class="mut">${escH(e.params)}</td></tr>`).join('');
  res.type('html').send(
    '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Expoline API docs</title><style>body{font-family:system-ui,sans-serif;max-width:1100px;margin:2rem auto;padding:0 1rem;color:#1a1a1a}' +
    'table{border-collapse:collapse;width:100%;font-size:.85rem}th,td{border:1px solid #ddd;padding:.45rem .6rem;text-align:left;vertical-align:top}' +
    'th{background:#f4f1ea}.m{font-weight:700;font-size:.75rem;background:#0f2a43;color:#fff;border-radius:4px;padding:.1rem .4rem}' +
    'code{background:#f4f1ea;padding:.1rem .3rem;border-radius:3px}.mut{color:#666}.note{background:#fff8e6;border:1px solid #e8d9a0;padding:.8rem 1rem;border-radius:8px}</style></head><body>' +
    '<h1>Expoline API documentation</h1><p class="note"><b>Internal v0.1.</b> Auth is <code>Authorization: Bearer &lt;token&gt;</code> from <code>POST /api/auth/login</code> (staff PIN; roles server/kitchen/manager). ' +
    'All money is integer cents; dates are ISO-8601; reporting buckets use America/Los_Angeles. Third-party OAuth scopes do not exist yet — staff tokens only.</p>' +
    '<p><a href="/api/openapi.json">openapi.json (machine-readable)</a></p>' +
    '<table><thead><tr><th>Method</th><th>Path</th><th>Auth</th><th>What it does</th><th>Params</th></tr></thead><tbody>' + rows + '</tbody></table></body></html>'
  );
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

/* Phase 4: proactive P&L insights + "Ask the restaurant anything" (manager-only).
   Same honest sales data as finance; server performance, movers, labor watch,
   anomaly alerts, and deterministic NL Q&A — no separate analytics SKU. */
require('./routes/insights').register(app, {
  db, SITE_ID, managerOnly, nowIso, tzDate, todaySite, addDays, dayLabor, SITE_TZ,
});

/* Phase 3B staff routes: KDS aging settings/alerts, tip-out rules + report,
   delivery aggregation, cash-collect requests, guest-split reverse, table QR. */
require('./routes/parity_kds_pay').registerStaff(app, {
  db, SITE_ID, managerOnly, serverPlus, kitchenPlus, nowIso, crypto, tzDate,
  persistTotals, checkResponse, broadcastCheckUpdated, broadcastTicket, ticketView,
});
/* Phase 3A competitor parity: order & check flow (dayparts, timers, guest
   names, fired-item edits, merge, move). */
parityOrders.register(app, {
  db, SITE_ID, SITE_TZ, managerOnly, serverPlus, nowIso, crypto,
  persistTotals, checkResponse, itemView, ticketView, broadcastCheckUpdated,
  broadcastTicketUpdated, auditApproval, getConfig, parseJson, isInt,
  withTransaction, verifyManagerPin, cleanLabel, validateModifiers,
  actorName: (req) => (req.user && req.user.name) || '?',
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

/* ------------------------------ maintenance ------------------------------
   Periodic housekeeping. Fulfilled KDS tickets used to accumulate
   forever (504,836 rows in the 7-day soak DB) because nothing ever
   retired them; the pass below archives them on a retention window. */

/** Integer site_config value with a sane fallback (the keys are
    manager-editable via the whitelisted PUT /api/admin/settings). */
function siteConfigInt(key, fallback) {
  const r = db.prepare('SELECT value FROM site_config WHERE site_id = ? AND key = ?').get(SITE_ID, key);
  const n = parseInt(r && r.value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/* Archive table: mirrors kds_tickets column-for-column so rows move
   across intact on ANY database vintage (boot migrations have appended
   columns over time — refire, online_order_id, deltas_json — and a
   static column list would silently drop the newer ones). The mirror
   is reconciled before every pass, following the codebase's
   PRAGMA-guard migration pattern.
   DELIBERATELY NO PRIMARY KEY in the mirror: kds_tickets.id is a plain
   rowid (no AUTOINCREMENT), so once a ticket is archived and deleted,
   SQLite can hand its id to a NEW ticket. If the archive treated id
   as unique, archiving that recycled id later would violate the
   constraint, roll the whole batch back, and wedge every subsequent
   pass on the same first batch forever. Archive rows are cold
   records — the archive's implicit rowid is its own identity, and two
   archive rows may legitimately carry the same original ticket id
   from different eras. Only non-unique indexes (id, created_at) are
   added. */
function ensureKdsArchiveTable() {
  const cols = db.prepare('PRAGMA table_info(kds_tickets)').all();
  if (!cols.length) return [];
  const exists = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'kds_tickets_archive'").get();
  if (!exists) {
    const defs = cols.map((c) => `${c.name} ${c.type || 'TEXT'}`).join(', ');
    db.exec(`CREATE TABLE kds_tickets_archive (${defs})`);
  } else {
    let info = db.prepare('PRAGMA table_info(kds_tickets_archive)').all();
    const idCol = info.find((c) => c.name === 'id');
    if (idCol && idCol.pk) {
      /* Legacy shape (pre-fix builds): id was mirrored as PRIMARY KEY.
         Rebuild the table once without it, preserving every row — it
         carries the same wedging hazard as the fresh-create case. */
      const oldNames = new Set(info.map((c) => c.name));
      const copyCols = cols.map((c) => c.name).filter((n) => oldNames.has(n));
      const defs = cols.map((c) => `${c.name} ${c.type || 'TEXT'}`).join(', ');
      withTransaction(() => {
        db.exec(`CREATE TABLE kds_tickets_archive_rebuilt (${defs})`);
        if (copyCols.length) {
          db.exec(`INSERT INTO kds_tickets_archive_rebuilt (${copyCols.join(', ')}) SELECT ${copyCols.join(', ')} FROM kds_tickets_archive`);
        }
        db.exec('DROP TABLE kds_tickets_archive');
        db.exec('ALTER TABLE kds_tickets_archive_rebuilt RENAME TO kds_tickets_archive');
      });
      console.log('[expoline] kds-archive: rebuilt kds_tickets_archive without PRIMARY KEY on id (source ticket ids recycle after archival)');
      info = db.prepare('PRAGMA table_info(kds_tickets_archive)').all();
    }
    const have = new Set(info.map((c) => c.name));
    for (const c of cols) {
      if (!have.has(c.name)) db.exec(`ALTER TABLE kds_tickets_archive ADD COLUMN ${c.name} ${c.type || 'TEXT'}`);
    }
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_kds_tickets_archive_id ON kds_tickets_archive(id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_kds_tickets_archive_created ON kds_tickets_archive(created_at)');
  return cols.map((c) => c.name);
}

/* Move FULFILLED tickets older than the retention window (site_config
   kds_archive_retention_days, default 30) into kds_tickets_archive, in
   bounded batches of KDS_ARCHIVE_BATCH, ONE TRANSACTION PER BATCH. A
   single pass loops until a batch comes back short (backlog exhausted)
   so a large legacy backlog drains in one pass instead of trickling
   out over weeks — but a hard cap of KDS_ARCHIVE_MAX_BATCHES batches
   per pass (250k rows) means a pathological case can never stall boot
   or the 6h interval indefinitely; if the cap stops the pass with
   qualifying rows still remaining, the caller logs that more remain
   for the next pass. "Older" is judged by the fulfill time
   (bumped_at), falling back to created_at for rows that never got a
   bump stamp. Non-fulfilled tickets are never touched. Timestamps are
   UTC ISO (a few legacy rows are naive SQLite UTC — the separator
   difference is sub-second at this granularity). */
const KDS_ARCHIVE_BATCH = 5000;
const KDS_ARCHIVE_MAX_BATCHES = 50;
function archiveFulfilledKdsTickets() {
  const colNames = ensureKdsArchiveTable();
  if (!colNames.length) return { moved: 0, capped: false };
  const colList = colNames.join(', ');
  const days = siteConfigInt('kds_archive_retention_days', 30);
  const cutoff = new Date(Date.now() - days * 86400_000).toISOString();
  let moved = 0;
  let batches = 0;
  let lastBatchFull = false;
  while (batches < KDS_ARCHIVE_MAX_BATCHES) {
    const rows = db.prepare(
      `SELECT id FROM kds_tickets
       WHERE site_id = ? AND status = 'fulfilled' AND COALESCE(bumped_at, created_at) < ?
       ORDER BY id LIMIT ?`
    ).all(SITE_ID, cutoff, KDS_ARCHIVE_BATCH);
    if (!rows.length) { lastBatchFull = false; break; }
    const ids = rows.map((r) => r.id);
    const ph = ids.map(() => '?').join(',');
    withTransaction(() => {
      db.prepare(`INSERT INTO kds_tickets_archive (${colList}) SELECT ${colList} FROM kds_tickets WHERE id IN (${ph})`).run(...ids);
      db.prepare(`DELETE FROM kds_tickets WHERE id IN (${ph}) AND status = 'fulfilled'`).run(...ids);
    });
    moved += ids.length;
    batches += 1;
    lastBatchFull = ids.length === KDS_ARCHIVE_BATCH;
    if (!lastBatchFull) break; // short batch: backlog exhausted
  }
  /* capped = the pass stopped at the batch cap with a full final batch
     AND qualifying rows still remain (probed cheaply — a full final
     batch that happens to end exactly on the backlog's last row is
     not "capped"). */
  let capped = false;
  if (batches === KDS_ARCHIVE_MAX_BATCHES && lastBatchFull) {
    capped = !!db.prepare(
      `SELECT 1 AS x FROM kds_tickets
       WHERE site_id = ? AND status = 'fulfilled' AND COALESCE(bumped_at, created_at) < ? LIMIT 1`
    ).get(SITE_ID, cutoff);
  }
  return { moved, capped };
}

(() => {
  db.prepare("INSERT OR IGNORE INTO site_config (site_id, key, value) VALUES (?, 'kds_archive_retention_days', '30')").run(SITE_ID);
  try {
    const days = siteConfigInt('kds_archive_retention_days', 30);
    const r = archiveFulfilledKdsTickets();
    console.log(`[expoline] kds-archive: moved ${r.moved} fulfilled ticket(s) past the ${days}d retention window to kds_tickets_archive${r.capped ? ' (batch cap reached — more remain for the next pass)' : ''}`);
  } catch (e) { console.error('[expoline] kds-archive boot pass failed:', e.message); }
})();

/* Interval passes stay quiet unless something actually moved. */
setInterval(() => {
  try {
    const r = archiveFulfilledKdsTickets();
    if (r.moved) console.log(`[expoline] kds-archive: moved ${r.moved} fulfilled ticket(s) past the retention window to kds_tickets_archive${r.capped ? ' (batch cap reached — more remain for the next pass)' : ''}`);
  } catch (e) { console.error('[expoline] kds-archive pass failed:', e.message); }
}, 6 * 3600_000).unref();

/* --------------------- stale open checks (report) ----------------------
   OPEN checks whose last activity is older than site_config
   stale_check_hours (default 24) are REPORTED — one boot log line and
   the stale_open_checks field on GET /api/manager/overview — but never
   auto-voided or auto-closed: a stale check can be a legitimate
   long-running tab, so cleanup stays a human decision. "Last activity"
   is the latest of the check's opened_at, its newest
   check_items.added_at and its newest payments.created_at, compared
   via parseDbUtc so naive SQLite UTC timestamps don't skew the age. */
function staleOpenChecks() {
  const hours = siteConfigInt('stale_check_hours', 24);
  const cutoffMs = Date.now() - hours * 3600_000;
  const opens = db.prepare(
    "SELECT id, table_id, tab_name, channel, opened_at, total_cents FROM checks WHERE site_id = ? AND status = 'open' ORDER BY id"
  ).all(SITE_ID);
  const out = [];
  if (opens.length) {
    const ids = opens.map((c) => c.id);
    const ph = ids.map(() => '?').join(',');
    const itemAgg = new Map(db.prepare(
      `SELECT check_id, COUNT(*) AS n, MAX(added_at) AS last_at FROM check_items WHERE check_id IN (${ph}) GROUP BY check_id`
    ).all(...ids).map((r) => [r.check_id, r]));
    const payAgg = new Map(db.prepare(
      `SELECT check_id, MAX(created_at) AS last_at FROM payments WHERE check_id IN (${ph}) GROUP BY check_id`
    ).all(...ids).map((r) => [r.check_id, r]));
    const labelStmt = db.prepare('SELECT label FROM tables WHERE id = ?');
    for (const c of opens) {
      const ia = itemAgg.get(c.id), pa = payAgg.get(c.id);
      const stamps = [c.opened_at, ia ? ia.last_at : null, pa ? pa.last_at : null];
      let lastMs = NaN, lastRaw = null;
      for (const s of stamps) {
        const ms = parseDbUtc(s);
        if (Number.isFinite(ms) && (!Number.isFinite(lastMs) || ms > lastMs)) { lastMs = ms; lastRaw = s; }
      }
      if (!Number.isFinite(lastMs) || lastMs > cutoffMs) continue;
      const table = c.table_id ? labelStmt.get(c.table_id) : null;
      out.push({
        check_id: c.id,
        table_id: c.table_id,
        table_label: table ? table.label : null,
        tab_name: c.tab_name || null,
        channel: c.channel || 'dine_in',
        opened_at: c.opened_at,
        last_activity_at: lastRaw,
        age_hours: Math.round(((Date.now() - lastMs) / 3600_000) * 10) / 10,
        item_count: ia ? ia.n : 0,
        total_cents: c.total_cents || 0,
      });
    }
  }
  return { threshold_hours: hours, checks: out };
}

(() => {
  db.prepare("INSERT OR IGNORE INTO site_config (site_id, key, value) VALUES (?, 'stale_check_hours', '24')").run(SITE_ID);
  try {
    const stale = staleOpenChecks();
    if (!stale.checks.length) {
      console.log(`[expoline] stale open checks (no activity > ${stale.threshold_hours}h): none`);
    } else {
      const ids = stale.checks.slice(0, 20).map((c) => '#' + c.check_id).join(', ');
      const more = stale.checks.length > 20 ? ` +${stale.checks.length - 20} more` : '';
      console.log(`[expoline] stale open checks (no activity > ${stale.threshold_hours}h): ${stale.checks.length} — ${ids}${more} (report only — nothing auto-closed)`);
    }
  } catch (e) { console.error('[expoline] stale-check boot scan failed:', e.message); }
})();

/* ------------------------------- graceful stop ------------------------------ */
function shutdown(signal) {
  console.log(`[expoline] received ${signal} — shutting down…`);
  clearInterval(heartbeat);
  try { lanRuntime.stop(); } catch { /* ignore */ } // LAN BRAIN (phase 2)
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
  console.log(`[expoline] listening on http://localhost:${PORT} (site: ${SITE_SLUG}, mode: demo)`);
});
