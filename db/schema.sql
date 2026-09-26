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
  pin TEXT
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
  seats INTEGER DEFAULT 4
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
  item_type TEXT CHECK(item_type IN ('drink','food','dessert')),
  station TEXT CHECK(station IN ('bar','expediter','garde_manger','dessert')),
  course TEXT CHECK(course IN ('drink','appetizer','entree','dessert')),
  active INTEGER DEFAULT 1,
  price_note TEXT
);

CREATE TABLE menu_modifiers (
  id INTEGER PRIMARY KEY,
  item_id INTEGER,
  name TEXT,
  price_delta_cents INTEGER
);

CREATE TABLE checks (
  id INTEGER PRIMARY KEY,
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
  closed_at TEXT
);

CREATE TABLE check_items (
  id INTEGER PRIMARY KEY,
  check_id INTEGER,
  menu_item_id INTEGER,
  seat INTEGER,
  qty INTEGER DEFAULT 1,
  unit_price_cents INTEGER,
  modifiers_json TEXT DEFAULT '[]',
  course TEXT,
  state TEXT DEFAULT 'held' CHECK(state IN ('held','sent','fulfilled','cancelled')),
  sent_at TEXT,
  added_at TEXT
);

CREATE TABLE payments (
  id INTEGER PRIMARY KEY,
  check_id INTEGER,
  site_id TEXT,
  method TEXT CHECK(method IN ('cash','card_demo')),
  amount_cents INTEGER,
  tip_cents INTEGER DEFAULT 0,
  tendered_cents INTEGER,
  brand TEXT,
  last4 TEXT,
  auth_code TEXT,
  status TEXT DEFAULT 'completed' CHECK(status IN ('completed','refunded','partial_refund')),
  refunded_cents INTEGER DEFAULT 0,
  created_at TEXT
);

CREATE TABLE kds_tickets (
  id INTEGER PRIMARY KEY,
  check_id INTEGER,
  site_id TEXT,
  station TEXT,
  table_label TEXT,
  server_name TEXT,
  items_json TEXT,
  status TEXT DEFAULT 'new' CHECK(status IN ('new','in_progress','fulfilled')),
  created_at TEXT,
  bumped_at TEXT,
  bumped_by TEXT
);

CREATE TABLE site_config (
  site_id TEXT,
  key TEXT,
  value TEXT,
  PRIMARY KEY (site_id, key)
);
