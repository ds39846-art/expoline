// Expoline MVP v0.1 — Bali Hai seed script
// Standalone + idempotent: deletes the db files first, then rebuilds from schema.sql.
// Uses node:sqlite (built into Node 22+). No npm dependencies.
// Usage: node db/seed.js   (run from the build/expoline directory)

'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const DIR = __dirname;
const SITES_DIR = path.join(DIR, 'sites');
const SITE_SLUG = process.env.EXPOLINE_SITE || 'bali-hai';
const DB_PATH = process.env.EXPOLINE_DB || path.join(SITES_DIR, `${SITE_SLUG}.db`);
const SCHEMA_PATH = path.join(DIR, 'schema.sql');

fs.mkdirSync(SITES_DIR, { recursive: true });

// ---- idempotent: wipe any existing database (incl. WAL sidecars) ----
for (const f of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm']) {
  try { fs.unlinkSync(f); } catch { /* ignore */ }
}

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode=WAL;');
db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));

const SITE = SITE_SLUG; // site_id for every seeded row — matches the DB file's slug
const SITE_NAME = SITE_SLUG === 'bali-hai'
  ? 'Bali Hai Restaurant'
  : SITE_SLUG.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

// ---------------- helpers ----------------
const q = {
  user: db.prepare("INSERT INTO users (site_id, name, role, pin) VALUES (?, ?, ?, ?)"),
  zone: db.prepare("INSERT INTO zones (site_id, name, sort) VALUES (?, ?, ?)"),
  table: db.prepare("INSERT INTO tables (site_id, zone_id, label, seats) VALUES (?, ?, ?, ?)"),
  cat: db.prepare("INSERT INTO menu_categories (site_id, name, parent, sort) VALUES (?, ?, ?, ?)"),
  item: db.prepare(
    "INSERT INTO menu_items (site_id, category_id, name, description, price_cents, item_type, station, course, active, price_note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)"
  ),
  mod: db.prepare("INSERT INTO menu_modifiers (item_id, name, price_delta_cents) VALUES (?, ?, ?)"),
  config: db.prepare("INSERT INTO site_config (site_id, key, value) VALUES (?, ?, ?)"),
  check: db.prepare(
    "INSERT INTO checks (site_id, table_id, server_id, tab_name, guest_count, status, service_charge_cents, surcharge_cents, tax_cents, subtotal_cents, total_cents, opened_at, closed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ),
  checkItem: db.prepare(
    "INSERT INTO check_items (check_id, menu_item_id, seat, qty, unit_price_cents, modifiers_json, course, state, sent_at, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ),
  payment: db.prepare(
    "INSERT INTO payments (check_id, site_id, method, amount_cents, tip_cents, tendered_cents, brand, last4, auth_code, status, refunded_cents, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ),
  kds: db.prepare(
    "INSERT INTO kds_tickets (check_id, site_id, station, table_label, server_name, items_json, status, created_at, bumped_at, bumped_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ),
};

// ---------------- site ----------------
db.prepare("INSERT INTO sites (id, name, slug) VALUES (?, ?, ?)")
  .run(SITE, SITE_NAME, SITE_SLUG);

// ---------------- config ----------------
const CONFIG = {
  tax_rate: '0.0775',
  surcharge_pct: '0.05',
  service_charge_pct: '0.18',
  service_charge_min_guests: '8',
  stripe_demo_rate: '0.026',
  stripe_demo_fixed_cents: '15',
  payout_lag_days: '2',
  currency: 'USD',
};
for (const [k, v] of Object.entries(CONFIG)) q.config.run(SITE, k, v);

// ---------------- users ----------------
const uid = {};
uid.server = q.user.run(SITE, 'Daniel S', 'server', '1111').lastInsertRowid;
uid.kitchen = q.user.run(SITE, 'Expo Kitchen', 'kitchen', '2222').lastInsertRowid;
uid.manager = q.user.run(SITE, 'Manager', 'manager', '2580').lastInsertRowid;

// ---------------- zones + tables ----------------
const ZONES = ['Dining Room', 'Patio', 'Bar', 'Holiday SoPac'];
const zid = {};
ZONES.forEach((name, i) => { zid[name] = q.zone.run(SITE, name, i + 1).lastInsertRowid; });

const range = (a, b) => { const out = []; for (let i = a; i <= b; i++) out.push(i); return out; };

const TABLES = {
  'Dining Room': ['50','51','515','53','52','525','54','60','61','615','63','62','625','64','66',
    '42','41','40','32','31','425','415','325','315','44','43','34','33','36','46','26','30',
    '24','225','22','23','215','21','20','56','104','105','106','16','103','102','101','15',
    '14','125','12','13','115','11'],
  'Patio': range(1, 9).map(String),
  'Bar': [
    ...range(1, 10).map(n => 'B' + n),
    ...range(90, 97).map(String),
    '81', '82',
    ...range(76, 80).map(String),
    ...range(71, 75).map(String),
    'Desk',
  ],
  'Holiday SoPac': [
    ...range(130, 140).map(String),
    ...range(150, 155).map(String),
    ...range(119, 128).map(String).filter(n => n !== '125'),
    '125SP',
    'HV', 'Satellite', 'FIRE',
    ...range(69, 74).map(n => n + 'sp'),
    ...range(81, 84).map(n => n + 'sp'),
    ...range(91, 94).map(n => n + 'sp'),
    ...range(101, 104).map(n => n + 'sp'),
    ...range(111, 114).map(n => n + 'sp'),
    'Bar',
  ],
};

const tid = {}; // "Zone|label" -> id
for (const [zone, labels] of Object.entries(TABLES)) {
  for (const label of labels) {
    const seats = /^B\d+$/.test(label) ? 1 : 4;
    const id = q.table.run(SITE, zid[zone], label, seats).lastInsertRowid;
    tid[zone + '|' + label] = id;
  }
}

// ---------------- menu ----------------
// item: [name, price_cents, price_note?]
// type/station/course default per category block below.
const MENU = [
  { parent: 'LUNCH', name: 'Pupus', course: 'appetizer', station: 'expediter', type: 'food', items: [
    ["Ali'i Tasting", 3000], ['Tuna Poke', 2100], ['Coconut Shrimp', 1700],
    ['Spinach Lumpia', 1400], ['Island Beef Skewers', 1500], ['Bali Fries', 900],
  ]},
  { parent: 'LUNCH', name: 'Signature Salads', course: 'entree', station: 'garde_manger', type: 'food', items: [
    ['Local Greens', 1300], ['Thai Caesar', 1500], ['Char Sui Cobb', 2400],
    ['Cashew Chicken', 1900], ['Poke Salad', 2300],
  ]},
  { parent: 'LUNCH', name: 'Sandwiches', course: 'entree', station: 'expediter', type: 'food', items: [
    ['Smoked Albacore Tuna Melt', 1900], ['Chicken Banh Mi', 1800],
    ['The Cheese Burger', 1800], ['Teriyaki Smash Burger', 1900],
    ['Korean Fried Chicken Sandwich', 1900],
  ]},
  { parent: 'LUNCH', name: 'House Specials', course: 'entree', station: 'expediter', type: 'food', items: [
    ['Kalua Pork or Poke Island Bowl', 2300], ['Grilled Salmon', 2500],
    ['Fish and Chips', 1900], ['Huli Huli Garlic Shrimp Tacos', 2200],
    ['Grilled Market Fish', 0, 'MP - manager enters price'],
  ]},
  { parent: 'DINNER', name: 'Salads', course: 'appetizer', station: 'garde_manger', type: 'food', items: [
    ['Local Greens', 1300], ['House Caesar', 1500], ['Asian Chop', 1300],
  ]},
  { parent: 'DINNER', name: 'Pupus', course: 'appetizer', station: 'expediter', type: 'food', items: [
    ['Shishito Peppers', 1500], ["Ali'i Tasting", 3000], ['Firecracker Pork Ribs', 1700],
    ['Coconut Shrimp', 1700], ['Spinach Cream Cheese Lumpia', 1400],
    ['Crispy Calamari', 1600], ['Beef Skewers', 1500], ['Edamame', 900],
  ]},
  { parent: 'DINNER', name: 'Aina', course: 'entree', station: 'expediter', type: 'food', items: [
    ['Spicy Yakisoba Short Rib', 3200], ['14oz Ribeye', 5500], ['Lemongrass Chicken', 2700],
    ['Coconut Braised Pork Short Rib', 3000], ['Korean Fried Chicken', 2400],
    ['Hoisin Beef', 2700], ['Sweet and Sour Pork', 2700],
  ]},
  { parent: 'DINNER', name: 'Kai', course: 'entree', station: 'expediter', type: 'food', items: [
    ['Roasted Whole Fish', 0, 'MP - manager enters price'], ['Crispy Ahi Tuna', 3200],
    ['Seared Salmon', 3200], ['Huli Huli Garlic Shrimp', 3400],
    ['Pan Seared Market Fish', 0, 'MP - manager enters price'], ['14oz Wok Fried Bass', 5000],
  ]},
  { parent: 'DINNER', name: 'Sides', course: 'entree', station: 'expediter', type: 'food', items: [
    ['Garlic Mashed Potatoes', 500], ['Steamed White Rice', 400], ['Black Bean Tofu', 800],
    ['Black Bean Chinese Broccoli', 1000], ['Island Macaroni Salad', 800],
    ['Chinese Garlic Noodles', 800], ["Wok'ed/Steamed Vegetables", 800],
    ['Thai Brussel Sprouts', 1000], ['Vegetable Fried Rice or Chow Mein', 900],
  ]},
  { parent: 'DESSERTS', name: 'Desserts', course: 'dessert', station: 'dessert', type: 'dessert', items: [
    ['Chocolate Creme Brulee', 1300], ['Lemon Mousse Cake', 1200],
    ['White Chocolate Cheesecake', 1200], ['House Made Malasadas', 1300],
    ['Seasonal Sorbet', 800], ['Black Sesame Mochi', 900, 'estimated'],
    ['Coconut Custard', 900, 'estimated'], ['Birthday/Anniversary Cake', 0],
  ]},
  { parent: 'KEIKI', name: 'Keiki', course: 'entree', station: 'expediter', type: 'food', items: [
    ['Burger Sliders', 900, 'placeholder - no site price'],
    ['Teriyaki Beef Bowl', 900, 'placeholder - no site price'],
    ['Mac N Cheese', 900, 'placeholder - no site price'],
    ['Chicken Tenders', 900, 'placeholder - no site price'],
    ['Grilled Cheese', 900, 'placeholder - no site price'],
    ['Buttered Noodles', 900, 'placeholder - no site price'],
  ]},
  { parent: 'BAR', name: 'Specialty Cocktails', course: 'drink', station: 'bar', type: 'drink', items: [
    ['BH Mai Tai', 1450], ['Harpoon', 1300], ['Lava Slide', 1400],
    ['Aloha Kiss', 1400, 'estimated'], ['Navy Grog', 1400, 'estimated'],
    ['Zombie', 1500, 'estimated'], ['Scorpion Bowl', 1600, 'estimated'],
    ['Pina Colada', 1300, 'estimated'], ["Planter's Punch", 1300, 'estimated'],
    ['San Diego Sling', 1400, 'estimated'],
  ]},
  { parent: 'BAR', name: 'Liquor', course: 'drink', station: 'bar', type: 'drink', items: [
    ['Woodford Reserve', 1100], ['Well Vodka', 900, 'estimated'],
    ["Tito's", 1100, 'estimated'], ['Casamigos Blanco', 1300, 'estimated'],
    ['Jameson', 1000, 'estimated'],
  ]},
  { parent: 'BAR', name: 'Wine by Glass', course: 'drink', station: 'bar', type: 'drink', items: [
    ['House Red', 1200, 'estimated'], ['House White', 1200, 'estimated'],
  ]},
  { parent: 'BAR', name: 'Beer', course: 'drink', station: 'bar', type: 'drink', items: [
    ['Draft Lager', 700, 'estimated'], ['IPA', 800, 'estimated'],
  ]},
  { parent: 'BAR', name: 'Coffee Drinks', course: 'drink', station: 'bar', type: 'drink', items: [
    ['Bali Hai Coffee', 900, 'estimated'], ['Irish Coffee', 1100, 'estimated'],
  ]},
  { parent: 'BAR', name: 'NA Beverages', course: 'drink', station: 'bar', type: 'drink', items: [
    ['Soda', 400], ['Iced Tea', 400],
  ]},
  { parent: 'HAPPY HOUR', name: 'HH Apps', course: 'appetizer', station: 'expediter', type: 'food', items: [
    ['Tuna Poke HH', 1200, 'placeholder - no site price'],
    ['Coconut Shrimp HH', 1000, 'placeholder - no site price'],
    ['Crispy Calamari HH', 900, 'placeholder - no site price'],
    ['Spinach Lumpia HH', 800, 'placeholder - no site price'],
    ['Beef Skewers HH', 900, 'placeholder - no site price'],
    ['Bali Fries HH', 600, 'placeholder - no site price'],
  ]},
  { parent: 'HAPPY HOUR', name: 'HH Drinks', course: 'drink', station: 'bar', type: 'drink', items: [
    ['Mai Tai HH', 900, 'placeholder - no site price'],
    ['Well Drink HH', 700, 'placeholder - no site price'],
    ['Draft Beer HH', 500, 'placeholder - no site price'],
  ]},
  { parent: 'BRUNCH', name: 'Sunday Brunch', course: 'entree', station: 'expediter', type: 'food', items: [
    ['Brunch Adult', 6800], ['Brunch Child 6-12', 2500], ['Brunch Under 5', 0],
  ]},
];

const itemId = {}; // name -> id (first match)
let catSort = 0;
for (const c of MENU) {
  catSort++;
  const cid = q.cat.run(SITE, c.name, c.parent, catSort).lastInsertRowid;
  for (const [name, price, note] of c.items) {
    const id = q.item.run(SITE, cid, name, null, price, c.type, c.station, c.course, note || null).lastInsertRowid;
    if (!(name in itemId)) itemId[name] = id;
  }
}

// ---------------- modifiers ----------------
const addMods = (itemName, mods) => {
  const id = itemId[itemName];
  if (!id) { console.warn('WARNING: item not found for modifiers:', itemName); return; }
  for (const [name, delta] of mods) q.mod.run(id, name, delta);
};

addMods('The Cheese Burger', [['Add fried egg', 200], ['Add bacon', 300]]);

// Salad add-ons on every salad item (Lunch Signature Salads + Dinner Salads)
const saladMods = [['Add chicken', 900], ['Add salmon', 1300], ['Add shrimp', 1300], ['Add steak', 1300]];
for (const name of ['Local Greens', 'Thai Caesar', 'Char Sui Cobb', 'Cashew Chicken', 'Poke Salad', 'House Caesar', 'Asian Chop']) {
  addMods(name, saladMods);
}

addMods('Vegetable Fried Rice or Chow Mein', [['Add shrimp', 500], ['Add chicken', 300]]);

// ---------------- demo closed checks (yesterday) ----------------
const money = (subtotal, guests) => {
  const sc = guests >= 8 ? Math.round(subtotal * 0.18) : 0;
  const sur = Math.round(subtotal * 0.05);
  const tax = Math.round((subtotal + sur + sc) * 0.0775);
  return { sc, sur, tax, total: subtotal + sur + sc + tax };
};
// Money formula mirrors server calcTotals: tax on (subtotal + surcharge +
// mandatory service charge), because CA includes mandatory service charges
// in taxable gross receipts (CDTFA Pub 22, Jan 2025; Annotation 550.0740).

const Y = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' })
  .format(new Date(Date.now() - 864e5)); // demo "yesterday", site-local — recomputed at seed time so fixtures never rot
const LA_OFF = (() => { // site UTC offset on Y (PDT -07:00 / PST -08:00), so seeded timestamps bucket on Y
  const tzName = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', timeZoneName: 'shortOffset' })
    .formatToParts(new Date(Y + 'T12:00:00Z')).find((p) => p.type === 'timeZoneName').value;
  const m = /GMT([+-])(\d+)/.exec(tzName) || [];
  return (m[1] === '-' ? '-' : '+') + String(m[2] || '7').padStart(2, '0') + ':00';
})();
let authSeq = 483920;
const auth = () => String(authSeq++);

function seedClosedCheck({ tableZone, tableLabel, guests, opened, closed, lines, pay }) {
  const { sc, sur, tax, total } = money(lines.reduce((s, l) => s + l.qty * itemPrice(l.name), 0), guests);
  const checkId = q.check.run(
    SITE, tid[tableZone + '|' + tableLabel], uid.server, null, guests, 'closed',
    sc, sur, tax, lines.reduce((s, l) => s + l.qty * itemPrice(l.name), 0), total,
    Y + 'T' + opened + LA_OFF, Y + 'T' + closed + LA_OFF
  ).lastInsertRowid;

  const tickets = {}; // station -> items[]
  lines.forEach((l, i) => {
    const mi = db.prepare('SELECT id, course, station FROM menu_items WHERE id = ?').get(itemId[l.name]);
    const sentAt = Y + 'T' + opened + LA_OFF;
    q.checkItem.run(checkId, mi.id, l.seat, l.qty, itemPrice(l.name),
      JSON.stringify(l.mods || []), mi.course, 'fulfilled', sentAt, sentAt);
    (tickets[mi.station] = tickets[mi.station] || []).push({
      name: l.name, qty: l.qty, seat: l.seat, mods: l.mods || [],
    });
  });

  const created = Y + 'T' + closed + LA_OFF;
  if (pay.refunded) {
    // double-charge corrected: first payment fully refunded, second completes the check
    q.payment.run(checkId, SITE, 'card_demo', total, 0, total, pay.refunded.brand, pay.refunded.last4, auth(), 'refunded', total, created);
    q.payment.run(checkId, SITE, 'card_demo', total, pay.tip, total + pay.tip, pay.brand, pay.last4, auth(), 'completed', 0, created);
  } else {
    q.payment.run(checkId, SITE, 'card_demo', total, pay.tip, total + pay.tip, pay.brand, pay.last4, auth(), 'completed', 0, created);
  }

  const bumpedBy = 'Expo Kitchen';
  for (const [station, items] of Object.entries(tickets)) {
    q.kds.run(checkId, SITE, station, tableLabel, 'Daniel S', JSON.stringify(items), 'fulfilled',
      Y + 'T' + opened + LA_OFF, Y + 'T' + closed + LA_OFF, bumpedBy);
  }
  return { checkId, total, tax, sur, sc };
}

const itemPrice = (name) => db.prepare('SELECT price_cents FROM menu_items WHERE id = ?').get(itemId[name]).price_cents;

// Check A — table 50, 2 guests: cocktails + calamari + 2 salmon + garlic noodles
seedClosedCheck({
  tableZone: 'Dining Room', tableLabel: '50', guests: 2,
  opened: '19:05:00', closed: '21:12:00',
  lines: [
    { name: 'BH Mai Tai', seat: 1, qty: 2 },
    { name: 'Crispy Calamari', seat: 1, qty: 1 },
    { name: 'Seared Salmon', seat: 1, qty: 1 },
    { name: 'Seared Salmon', seat: 2, qty: 1 },
    { name: 'Chinese Garlic Noodles', seat: 2, qty: 1 },
  ],
  pay: { brand: 'Visa', last4: '4242', tip: 2500 },
});

// Check B — table 63, 4 guests: lava slides, coconut shrimp, ribeye, hoisin beef, rice x2
seedClosedCheck({
  tableZone: 'Dining Room', tableLabel: '63', guests: 4,
  opened: '19:40:00', closed: '21:35:00',
  lines: [
    { name: 'Lava Slide', seat: 1, qty: 1 },
    { name: 'Lava Slide', seat: 3, qty: 1 },
    { name: 'Coconut Shrimp', seat: 2, qty: 1 },
    { name: '14oz Ribeye', seat: 1, qty: 1 },
    { name: 'Hoisin Beef', seat: 4, qty: 1 },
    { name: 'Steamed White Rice', seat: 1, qty: 1 },
    { name: 'Steamed White Rice', seat: 4, qty: 1 },
  ],
  pay: { brand: 'Mastercard', last4: '5555', tip: 3000 },
});

// Check C — table 12, 2 guests: harpoon, ali'i tasting, lemongrass chicken, brussel sprouts;
// first card payment was double-charged and fully refunded.
seedClosedCheck({
  tableZone: 'Dining Room', tableLabel: '12', guests: 2,
  opened: '20:10:00', closed: '21:50:00',
  lines: [
    { name: 'Harpoon', seat: 1, qty: 1 },
    { name: "Ali'i Tasting", seat: 2, qty: 1 },
    { name: 'Lemongrass Chicken', seat: 1, qty: 1 },
    { name: 'Thai Brussel Sprouts', seat: 2, qty: 1 },
  ],
  pay: { brand: 'Amex', last4: '1005', tip: 1500, refunded: { brand: 'Amex', last4: '1005' } },
});

// ---------------- summary ----------------
const counts = {};
for (const t of ['sites','users','zones','tables','menu_categories','menu_items','menu_modifiers','checks','check_items','payments','kds_tickets','site_config']) {
  counts[t] = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
}

console.log('Expoline seed complete: ' + DB_PATH);
for (const [t, n] of Object.entries(counts)) console.log('  ' + t.padEnd(18) + n);

const finance = db.prepare(`
  SELECT COUNT(*) AS payments, SUM(amount_cents) AS gross, SUM(tip_cents) AS tips,
         SUM(CASE WHEN status = 'refunded' THEN refunded_cents ELSE 0 END) AS refunded
  FROM payments`).get();
console.log('  finance: gross=$' + (finance.gross / 100).toFixed(2) +
  ' tips=$' + (finance.tips / 100).toFixed(2) +
  ' refunded=$' + (finance.refunded / 100).toFixed(2) +
  ' across ' + finance.payments + ' payments');

db.close();
