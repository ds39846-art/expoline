-- Expoline MVP v0.1 — SQLite schema
-- Money is stored in INTEGER CENTS everywhere. Dates are ISO strings.

CREATE TABLE sites (
  id TEXT PRIMARY KEY,
  name TEXT,
  slug TEXT
);

CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  site_id TEXT,
  name TEXT,
  role TEXT CHECK(role IN ('server','kitchen','manager')),
  pin TEXT,
  hourly_rate_cents INTEGER
);

CREATE TABLE zones (
  id INTEGER PRIMARY KEY,
  site_id TEXT,
  name TEXT,
  sort INTEGER
);

CREATE TABLE tables (
  id INTEGER PRIMARY KEY,
  site_id TEXT,
  zone_id INTEGER,
  label TEXT,
  seats INTEGER DEFAULT 4,
  x REAL,
  y REAL,
  shape TEXT DEFAULT 'square'
);

CREATE TABLE menu_categories (
  id INTEGER PRIMARY KEY,
  site_id TEXT,
  name TEXT,
  parent TEXT,
  sort INTEGER
);

CREATE TABLE menu_items (
  id INTEGER PRIMARY KEY,
  site_id TEXT,
  category_id INTEGER,
  name TEXT,
  description TEXT,
  price_cents INTEGER,
  hh_price_cents INTEGER,
  item_type TEXT CHECK(item_type IN ('drink','food','dessert')),
  station TEXT CHECK(station IN ('bar','expediter','garde_manger','dessert')),
  course TEXT CHECK(course IN ('drink','appetizer','entree','dessert')),
  active INTEGER DEFAULT 1,
  price_note TEXT,
  image_url TEXT,
  daypart TEXT
);

CREATE TABLE menu_audit (
  id INTEGER PRIMARY KEY,
  site_id TEXT,
  actor TEXT,
  action TEXT,
  item_id INTEGER,
  category_id INTEGER,
  details TEXT,
  created_at TEXT
);

CREATE TABLE menu_modifiers (
  id INTEGER PRIMARY KEY,
  item_id INTEGER,
  name TEXT,
  price_delta_cents INTEGER
);

CREATE TABLE checks (
  id INTEGER PRIMARY KEY,
  uuid TEXT,
  site_id TEXT,
  table_id INTEGER,
  server_id INTEGER,
  tab_name TEXT,
  guest_count INTEGER,
  status TEXT DEFAULT 'open' CHECK(status IN ('open','paid','closed')),
  service_charge_cents INTEGER DEFAULT 0,
  surcharge_cents INTEGER DEFAULT 0,
  tax_cents INTEGER DEFAULT 0,
  subtotal_cents INTEGER DEFAULT 0,
  total_cents INTEGER DEFAULT 0,
  opened_at TEXT,
  closed_at TEXT,
  split_from INTEGER,
  channel TEXT DEFAULT 'dine_in',
  source TEXT,
  split_group TEXT
);

/* Claim/overlap P0: one open staff claim per table, enforced by the DB.
   Split children (split_from), kiosk orders (server_id NULL) and QR-guest
   self-orders (server_id NULL) legitimately stack checks on a table and are
   out of scope. Boot migration in server.js backfills split_from and dedupes. */
CREATE UNIQUE INDEX IF NOT EXISTS idx_checks_one_open_per_table
  ON checks(table_id)
  WHERE status = 'open' AND split_from IS NULL AND server_id IS NOT NULL;

CREATE TABLE check_items (
  id INTEGER PRIMARY KEY,
  uuid TEXT,
  check_id INTEGER,
  menu_item_id INTEGER,
  seat INTEGER,
  qty INTEGER DEFAULT 1,
  unit_price_cents INTEGER,
  modifiers_json TEXT DEFAULT '[]',
  course TEXT,
  state TEXT DEFAULT 'held' CHECK(state IN ('held','sent','fulfilled','cancelled')),
  sent_at TEXT,
  added_at TEXT,
  note TEXT,
  allergy INTEGER DEFAULT 0,
  allergy_detail TEXT
);

CREATE TABLE payments (
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
);

/* Discount library (audit gap #4): named manager-defined discounts and
   their applications. Applications snapshot the definition (name, kind,
   value) plus the computed amount, so later edits never rewrite history. */
CREATE TABLE discounts (
  id INTEGER PRIMARY KEY,
  site_id TEXT,
  name TEXT,
  kind TEXT CHECK(kind IN ('percent','fixed')),
  percent REAL,
  amount_cents INTEGER,
  scope TEXT CHECK(scope IN ('check','item')),
  requires_approval INTEGER DEFAULT 0,
  active INTEGER DEFAULT 1,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE check_discounts (
  id INTEGER PRIMARY KEY,
  site_id TEXT,
  check_id INTEGER,
  item_id INTEGER,
  discount_id INTEGER,
  name TEXT,
  kind TEXT,
  percent REAL,
  amount_cents INTEGER,
  scope TEXT,
  applied_cents INTEGER,
  requires_approval INTEGER DEFAULT 0,
  status TEXT DEFAULT 'applied' CHECK(status IN ('applied','removed')),
  applied_by_id INTEGER,
  applied_by_name TEXT,
  approver_id INTEGER,
  approver_name TEXT,
  created_at TEXT,
  removed_at TEXT,
  removed_by_id INTEGER,
  removed_by_name TEXT
);

CREATE INDEX idx_check_discounts_check ON check_discounts(check_id, status);

/* EOD close-out (audit gap #5): one row per close-out event for a
   business date. status closed is the live day lock; reopening flips
   the row to voided (kept forever) and a re-close writes a NEW row.
   snapshot_json is the frozen Z record, written once at close time. */
CREATE TABLE closeouts (
  id INTEGER PRIMARY KEY,
  uuid TEXT UNIQUE,
  site_id TEXT,
  business_date TEXT,
  status TEXT CHECK(status IN ('closed','voided')) DEFAULT 'closed',
  snapshot_json TEXT,
  expected_cash_cents INTEGER,
  counted_cash_cents INTEGER,
  over_short_cents INTEGER,
  note TEXT,
  closed_by TEXT,
  closed_by_id INTEGER,
  closed_at TEXT,
  reopened_by TEXT,
  reopened_at TEXT,
  reopen_reason TEXT,
  created_at TEXT
);

CREATE INDEX idx_closeouts_site_date ON closeouts(site_id, business_date, status);

/* Cash-tip declarations (audit gap #6): one row per (server, business
   date); the server attested cash-tip figure of record. Amendments are
   approval-audited with before/after; the first declarant is preserved
   in declared_by/declared_at, the last writer in updated_by/updated_at. */
CREATE TABLE tip_declarations (
  id INTEGER PRIMARY KEY,
  uuid TEXT UNIQUE,
  site_id TEXT,
  user_id INTEGER,
  business_date TEXT,
  declared_cash_tips_cents INTEGER,
  declared_by TEXT,
  declared_by_id INTEGER,
  declared_at TEXT,
  updated_by TEXT,
  updated_by_id INTEGER,
  updated_at TEXT,
  created_at TEXT,
  UNIQUE(site_id, user_id, business_date)
);

CREATE INDEX idx_tip_declarations_site_date ON tip_declarations(site_id, business_date);

/* House accounts (LOCKED POLICY 2026-09-27: manager-created only).
   A house_account tender must name an existing ACTIVE account; servers
   cannot invent accounts at payment time. */
CREATE TABLE house_accounts (
  id INTEGER PRIMARY KEY,
  uuid TEXT,
  site_id TEXT,
  name TEXT,
  active INTEGER DEFAULT 1,
  created_by TEXT,
  created_at TEXT,
  UNIQUE(site_id, name)
);

CREATE TABLE kds_tickets (
  id INTEGER PRIMARY KEY,
  uuid TEXT,
  check_id INTEGER,
  site_id TEXT,
  station TEXT,
  table_label TEXT,
  server_name TEXT,
  items_json TEXT,
  status TEXT DEFAULT 'new' CHECK(status IN ('new','in_progress','fulfilled')),
  created_at TEXT,
  bumped_at TEXT,
  bumped_by TEXT,
  refire INTEGER DEFAULT 0
);

CREATE TABLE site_config (
  site_id TEXT,
  key TEXT,
  value TEXT,
  PRIMARY KEY (site_id, key)
);

-- Time clock (California meal/rest-break compliance)
CREATE TABLE clock_shifts (
  id INTEGER PRIMARY KEY,
  uuid TEXT,
  site_id TEXT,
  user_id INTEGER,
  employee_name TEXT,
  role TEXT,
  regular_rate_cents INTEGER DEFAULT 0,
  clock_in TEXT,
  clock_out TEXT,
  created_at TEXT
);
CREATE TABLE clock_breaks (
  id INTEGER PRIMARY KEY,
  uuid TEXT,
  shift_id INTEGER,
  type TEXT CHECK(type IN ('meal','rest')),
  meal_seq INTEGER,
  start_at TEXT,
  end_at TEXT,
  waived INTEGER DEFAULT 0,
  duty_free INTEGER DEFAULT 0,
  created_at TEXT
);
CREATE TABLE clock_audit (
  id INTEGER PRIMARY KEY,
  site_id TEXT,
  actor TEXT,
  action TEXT,
  shift_id INTEGER,
  details TEXT,
  created_at TEXT
);
CREATE INDEX idx_clock_shifts_user ON clock_shifts(site_id, user_id, clock_out);

CREATE TABLE reservations (
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
);
CREATE INDEX idx_reservations_site_time ON reservations(site_id, reserved_at);
CREATE INDEX idx_reservations_table_time ON reservations(site_id, table_id, reserved_at);
CREATE INDEX idx_reservations_phone ON reservations(site_id, phone);

CREATE TABLE waitlist (
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
);
CREATE INDEX idx_waitlist_site_status ON waitlist(site_id, status, created_at);
