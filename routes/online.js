'use strict';
/* ============================================================================
 * Expoline — Online ordering (order-ahead), v1
 * ----------------------------------------------------------------------------
 * The restaurant's OWN order-ahead link: no marketplace, no commission.
 * Customer flow (no staff login required — it's the customer's phone):
 *   menu → cart → checkout (name/phone/pickup slot) → placed
 * Kitchen flow (kitchen+ role):
 *   placed → confirmed (fires KDS tickets, station-routed like dine-in send)
 *        → ready → picked_up. Cancel allowed from placed/confirmed.
 * Money: ALL totals recomputed server-side in integer cents from menu_items.
 * Client-sent totals are ignored. v1 is pay-at-pickup (no card processing).
 * Pricing/availability parity with the floor: the unit price resolves
 * through the host's happy-hour resolver (ctx.effectivePriceCents — HH
 * price during a pricing window, MP items never HH-priced) and snapshots
 * onto the order line exactly like a check line; floor-86 (is_86 +
 * remaining countdown) is enforced with the host's helpers — 86'd items
 * are excluded from this guest menu and refused at placement, and the
 * countdown is consumed inside the placement transaction with the same
 * conditional-UPDATE discipline (aggregated per item across the cart),
 * auto-86ing at zero with the 'system' audit row. The menu below reads
 * menu_items LIVE (there is no snapshot table), so an 86 or an HH price
 * set mid-service takes effect on the next menu read / order — nothing
 * can go stale. All ctx helpers are guarded: a host that does not wire
 * them gets the pre-parity behavior (plain price, active-flag only).
 *
 * INTEGRATION (integrator adds these lines to server.js — see bottom):
 *   1. in authMiddleware's public-path early return, add the online paths
 *   2. after the other boot migrations: require('./routes/online.js').migrate(db)
 *   3. after `app` + role helpers exist: .register(app, ctx)
 * ========================================================================== */

const RATE_LIMIT_MAX = 10;  // max orders per IP...
const RATE_LIMIT_WINDOW_MS = 60 * 1000;  // ...per rolling minute
const MAX_FUTURE_DAYS = 7;               // pickup_at may not exceed this
const MAX_QTY_PER_LINE = 20;
const NAME_MAX = 60;

const rateBuckets = new Map(); // ip -> array of epoch-ms timestamps (in-memory)

function checkRateLimit(ip) {
  const now = Date.now();
  const key = ip || 'unknown';
  let bucket = rateBuckets.get(key);
  if (!bucket) { bucket = []; rateBuckets.set(key, bucket); }
  while (bucket.length && bucket[0] <= now - RATE_LIMIT_WINDOW_MS) bucket.shift();
  if (bucket.length >= RATE_LIMIT_MAX) return false;
  bucket.push(now);
  return true;
}

function normalizePhone(phone) {
  return String(phone == null ? '' : phone).replace(/\D/g, '');
}

/* --------------------------------- migrate -------------------------------- */
function migrate(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS online_orders (
    id INTEGER PRIMARY KEY,
    uuid TEXT UNIQUE,
    site_id TEXT,
    customer_name TEXT,
    phone TEXT,
    items_json TEXT,
    subtotal_cents INTEGER DEFAULT 0,
    tax_cents INTEGER DEFAULT 0,
    total_cents INTEGER DEFAULT 0,
    status TEXT DEFAULT 'placed'
      CHECK(status IN ('placed','confirmed','ready','picked_up','cancelled')),
    pickup_at TEXT,
    created_at TEXT
  )`);
  // Defensive backfill: any row that somehow lacks a uuid gets one.
  const missing = db.prepare('SELECT id FROM online_orders WHERE uuid IS NULL').all();
  if (missing.length) {
    const { randomUUID } = require('node:crypto');
    const upd = db.prepare('UPDATE online_orders SET uuid = ? WHERE id = ?');
    for (const r of missing) upd.run(randomUUID(), r.id);
  }
  // Link KDS tickets back to their online order (additive, guarded).
  const tcols = new Set(db.prepare('PRAGMA table_info(kds_tickets)').all().map((c) => c.name));
  if (!tcols.has('online_order_id')) db.exec('ALTER TABLE kds_tickets ADD COLUMN online_order_id INTEGER');
  db.exec('CREATE INDEX IF NOT EXISTS idx_online_orders_site_status ON online_orders(site_id, status)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_online_orders_phone ON online_orders(site_id, phone)');
}

/* --------------------------------- views ---------------------------------- */
function orderView(row) {
  let items = [];
  try { items = JSON.parse(row.items_json || '[]'); } catch { items = []; }
  return {
    id: row.id,
    uuid: row.uuid,
    customer_name: row.customer_name,
    phone: row.phone,
    items,
    subtotal_cents: row.subtotal_cents,
    tax_cents: row.tax_cents,
    total_cents: row.total_cents,
    status: row.status,
    pickup_at: row.pickup_at,
    created_at: row.created_at,
    pay_at_pickup: true,
  };
}

/* -------------------------------- register -------------------------------- */
function register(app, ctx) {
  const { db, SITE_ID, kitchenPlus, nowIso, crypto } = ctx;

  /* Floor-parity helpers, injected by the host (guarded — see header). */
  const hhPricingActive = typeof ctx.hhPricingActive === 'function'
    ? ctx.hhPricingActive : () => false;
  const effectivePriceCents = typeof ctx.effectivePriceCents === 'function'
    ? ctx.effectivePriceCents : (mi) => (mi ? mi.price_cents : 0);
  const eightySixRefusal = typeof ctx.eightySixRefusal === 'function'
    ? ctx.eightySixRefusal : () => null;
  const consumeEightySixCountdown = typeof ctx.consumeEightySixCountdown === 'function'
    ? ctx.consumeEightySixCountdown : () => ({ consumed: false, flipped: false });
  const pushMenuUpdated = typeof ctx.broadcastMenuUpdated === 'function'
    ? ctx.broadcastMenuUpdated : () => {};

  const taxRate = () => {
    const r = db.prepare("SELECT value FROM site_config WHERE site_id = ? AND key = 'tax_rate'").get(SITE_ID);
    const v = parseFloat(r ? r.value : '0.0775');
    return Number.isFinite(v) && v >= 0 ? v : 0.0775;
  };

  const getOrder = (id) =>
    db.prepare('SELECT * FROM online_orders WHERE id = ? AND site_id = ?').get(id, SITE_ID);

  /* ---- GET /api/online/menu — 86-filtered public menu (no auth) ---- */
  app.get('/api/online/menu', (req, res) => {
    const cats = db.prepare(
      'SELECT id, name, parent, sort FROM menu_categories WHERE site_id = ? ORDER BY sort, id'
    ).all(SITE_ID);
    // Guest surface: structurally-off (active = 0) AND floor-86'd items are
    // both excluded server-side — same rule as the kiosk/guest menus (staff
    // keep flagged-visible; guests never see a sold-out item at all).
    const itemStmt = db.prepare(
      'SELECT id, name, description, price_cents, hh_price_cents, is_86, remaining, item_type, station, course, price_note FROM menu_items WHERE category_id = ? AND active = 1 AND COALESCE(is_86, 0) = 0 ORDER BY id'
    );
    const modStmt = db.prepare(
      'SELECT id, name, price_delta_cents FROM menu_modifiers WHERE item_id = ? ORDER BY id'
    );
    const hhActive = hhPricingActive();
    // Same shape as /api/menu; mergeCats is server-local so we inline a flat list.
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
        // Happy-hour pricing, mirroring the staff /api/menu fields: the
        // manager-set HH price (null = none), the price an order placed
        // right now would actually be charged, and whether the HH price
        // is the one in effect for this item.
        hh_price_cents: it.hh_price_cents != null ? it.hh_price_cents : null,
        effective_price_cents: effectivePriceCents(it, hhActive),
        hh_active: hhActive && it.price_cents > 0 && it.hh_price_cents != null,
        // Portions still orderable under a floor-86 countdown, else null —
        // shown honestly ("Only N left"), never invented.
        remaining: it.remaining != null ? it.remaining : null,
        item_type: it.item_type,
        station: it.station,
        course: it.course,
        price_note: it.price_note,
        modifiers: modStmt.all(it.id),
      })),
    })));
  });

  /* ---- POST /api/online/orders — place an order (PUBLIC, rate-limited) ---- */
  app.post('/api/online/orders', (req, res) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    if (!checkRateLimit(ip)) {
      return res.status(429).json({ error: 'Too many orders — please wait a minute and try again' });
    }
    const b = req.body || {};
    const name = String(b.customer_name == null ? '' : b.customer_name).trim().slice(0, NAME_MAX);
    if (!name) return res.status(400).json({ error: 'customer_name is required' });
    const phone = normalizePhone(b.phone);
    if (phone.length < 7 || phone.length > 15) {
      return res.status(400).json({ error: 'A valid phone number is required (for pickup updates)' });
    }
    if (!Array.isArray(b.items) || b.items.length === 0) {
      return res.status(400).json({ error: 'items must be a non-empty array' });
    }
    if (b.items.length > 50) return res.status(400).json({ error: 'Too many line items (max 50)' });

    // Validate + re-price every line server-side. Client totals are ignored.
    const lineReqs = [];
    for (const ln of b.items) {
      const menuItemId = Number(ln.menu_item_id);
      const qty = Number(ln.qty);
      if (!Number.isInteger(menuItemId) || menuItemId <= 0) {
        return res.status(400).json({ error: 'Each item needs a valid menu_item_id' });
      }
      if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY_PER_LINE) {
        return res.status(400).json({ error: `qty must be 1–${MAX_QTY_PER_LINE}` });
      }
      lineReqs.push({ menuItemId, qty });
    }
    const ids = [...new Set(lineReqs.map((l) => l.menuItemId))];
    const placeholders = ids.map(() => '?').join(',');
    const found = db.prepare(
      `SELECT mi.id, mi.name, mi.price_cents, mi.hh_price_cents, mi.is_86, mi.remaining, mi.station, mi.active, mi.category_id
       FROM menu_items mi WHERE mi.id IN (${placeholders})`
    ).all(...ids);
    // Site-scope check: item must belong to this site via its category.
    const siteIds = new Set(
      db.prepare(`SELECT id FROM menu_categories WHERE site_id = ?`).all(SITE_ID).map((c) => c.id)
    );
    const byId = new Map(found.map((r) => [r.id, r]));
    // Aggregate the cart per item: a guest may submit the same item on
    // several lines, and the floor-86 countdown answers for the TOTAL —
    // 2+2 against 3 left must refuse whole, never slip through per-line.
    const cartQty = new Map();
    for (const l of lineReqs) cartQty.set(l.menuItemId, (cartQty.get(l.menuItemId) || 0) + l.qty);
    const hhActive = hhPricingActive();
    const priced = [];
    for (const l of lineReqs) {
      const mi = byId.get(l.menuItemId);
      if (!mi || !siteIds.has(mi.category_id)) {
        return res.status(400).json({ error: `Unknown menu item ${l.menuItemId}` });
      }
      if (mi.active !== 1) {
        return res.status(400).json({ error: `“${mi.name}” is 86'd right now — please pick something else` });
      }
      priced.push({
        menu_item_id: mi.id,
        name: mi.name,
        qty: l.qty,
        // The charged price resolves through the floor's HH resolver and
        // snapshots onto the line — a line placed at 5:55pm keeps its HH
        // price after 6:00pm, exactly like a rung check line.
        unit_price_cents: effectivePriceCents(mi, hhActive),
        station: mi.station || 'expediter',
      });
    }
    /* Floor 86, up front (read-only — consumes nothing): a sold-out item
       refuses by name even when a stale cart submits it, and a countdown
       item refuses a cart whose AGGREGATED qty exceeds what is left. The
       authoritative consume happens inside the write transaction below
       (this read can race another order by design — the conditional
       UPDATE there is the one that decides). */
    for (const id of ids) {
      const refusal86 = eightySixRefusal(byId.get(id), cartQty.get(id) || 0);
      if (refusal86) return res.status(400).json({ error: refusal86 });
    }

    let pickupAt = null;
    if (b.pickup_at != null && b.pickup_at !== '') {
      const t = new Date(b.pickup_at).getTime();
      if (!Number.isFinite(t)) return res.status(400).json({ error: 'pickup_at must be an ISO timestamp' });
      const now = Date.now();
      if (t <= now) return res.status(400).json({ error: 'pickup_at must be in the future' });
      if (t > now + MAX_FUTURE_DAYS * 86400000) {
        return res.status(400).json({ error: `pickup_at may be at most ${MAX_FUTURE_DAYS} days out` });
      }
      pickupAt = new Date(t).toISOString();
    }

    const subtotal = priced.reduce((s, l) => s + l.qty * l.unit_price_cents, 0);
    const tax = Math.round(subtotal * taxRate());
    const total = subtotal + tax;
    const createdAt = nowIso();
    // Phase 1B money audit (concurrency): re-check 86 flags inside a write
    // transaction — an item 86'd between validation and INSERT must not
    // land on a placed online order. The floor-86 countdown consume runs
    // in the SAME transaction: the conditional UPDATE inside
    // consumeEightySixCountdown is what makes two orders racing the last
    // portion produce exactly one success, and any refusal rolls the
    // whole order (and any partial consume) back.
    let orderId;
    let consumedAny86 = false;
    try {
      db.exec('BEGIN IMMEDIATE');
      const recheck = db.prepare(
        `SELECT id, active, is_86, remaining, name, category_id FROM menu_items WHERE id IN (${placeholders})`
      ).all(...ids);
      const freshMap = new Map(recheck.map((r) => [r.id, r]));
      for (const l of priced) {
        const fresh = freshMap.get(l.menu_item_id);
        if (!fresh || fresh.active !== 1) {
          db.exec('ROLLBACK');
          return res.status(400).json({ error: `“${l.name}” is 86'd right now — please pick something else` });
        }
      }
      for (const id of ids) {
        const fresh = freshMap.get(id);
        if (fresh.is_86) {
          db.exec('ROLLBACK');
          return res.status(400).json({ error: `86: "${fresh.name}" is sold out` });
        }
        const cr = consumeEightySixCountdown(
          { id, name: fresh.name, category_id: fresh.category_id, remaining: fresh.remaining },
          cartQty.get(id) || 0);
        if (cr.error) {
          db.exec('ROLLBACK');
          return res.status(400).json({ error: cr.error });
        }
        if (cr.consumed) consumedAny86 = true;
      }
      const r = db.prepare(
        `INSERT INTO online_orders
          (uuid, site_id, customer_name, phone, items_json, subtotal_cents, tax_cents, total_cents, status, pickup_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'placed', ?, ?)`
      ).run(crypto.randomUUID(), SITE_ID, name, phone, JSON.stringify(priced), subtotal, tax, total, pickupAt, createdAt);
      orderId = r.lastInsertRowid;
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw e;
    }
    // A countdown that ran out flipped an item to 86 — staff surfaces
    // re-read the menu, exactly like a floor ring that burns the last one.
    if (consumedAny86) { try { pushMenuUpdated(); } catch { /* best-effort */ } }
    res.status(201).json(orderView(getOrder(orderId)));
  });

  /* ---- GET /api/online/last?phone= — one-tap reorder (PUBLIC) ---- */
  app.get('/api/online/last', (req, res) => {
    const phone = normalizePhone(req.query.phone);
    if (phone.length < 7) return res.status(400).json({ error: 'phone is required' });
    const row = db.prepare(
      `SELECT * FROM online_orders WHERE site_id = ? AND phone = ? AND status != 'cancelled'
       ORDER BY created_at DESC, id DESC LIMIT 1`
    ).get(SITE_ID, phone);
    if (!row) return res.status(404).json({ error: 'No previous order for this phone' });
    res.json(orderView(row));
  });

  /* ---- GET /api/online/orders — kitchen view (kitchen+) ---- */
  app.get('/api/online/orders', kitchenPlus(), (req, res) => {
    const rows = db.prepare(
      `SELECT * FROM online_orders
       WHERE site_id = ? AND status IN ('placed','confirmed','ready')
       ORDER BY CASE WHEN pickup_at IS NULL THEN 0 ELSE 1 END, pickup_at, created_at, id`
    ).all(SITE_ID);
    res.json(rows.map(orderView));
  });

  /* ---- GET /api/online/orders/:id — single order (kitchen+) ---- */
  app.get('/api/online/orders/:id', kitchenPlus(), (req, res) => {
    const o = getOrder(req.params.id);
    if (!o) return res.status(404).json({ error: 'Order not found' });
    res.json(orderView(o));
  });

  /* ---- PATCH /api/online/orders/:id — status flow (kitchen+) ---- */
  const TRANSITIONS = {
    placed: ['confirmed', 'cancelled'],
    confirmed: ['ready', 'cancelled'],
    ready: ['picked_up'],
    picked_up: [],
    cancelled: [],
  };
  app.patch('/api/online/orders/:id', kitchenPlus(), (req, res) => {
    const o = getOrder(req.params.id);
    if (!o) return res.status(404).json({ error: 'Order not found' });
    const next = req.body && req.body.status;
    if (!TRANSITIONS[o.status].includes(next)) {
      return res.status(400).json({ error: `Cannot move order from ${o.status} to ${next || '(none)'}` });
    }
    db.prepare('UPDATE online_orders SET status = ? WHERE id = ?').run(next, o.id);

    // On confirm: fire KDS tickets, station-routed exactly like dine-in send.
    let tickets = [];
    if (next === 'confirmed') {
      const items = orderView(o).items;
      const byStation = new Map();
      for (const it of items) {
        const st = it.station || 'expediter';
        if (!byStation.has(st)) byStation.set(st, []);
        // NOTE: online tickets have no check/check_items rows — item_id here is a
        // menu_items id (not a check_items id like dine-in/kiosk tickets).
        // menu_item_id is explicit so consumers never mis-join it to check_items.
        byStation.get(st).push({ item_id: it.menu_item_id, menu_item_id: it.menu_item_id, name: it.name, qty: it.qty, modifiers: [] });
      }
      const sentAt = nowIso();
      const label = 'ONLINE #' + o.id + (o.pickup_at
        ? ' · ' + new Date(o.pickup_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
        : ' · ASAP');
      const insTicket = db.prepare(
        "INSERT INTO kds_tickets (uuid, check_id, online_order_id, site_id, station, table_label, server_name, items_json, status, created_at) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 'new', ?)"
      );
      for (const [station, titems] of byStation) {
        const r = insTicket.run(
          crypto.randomUUID(), o.id, SITE_ID, station, label, o.customer_name,
          JSON.stringify(titems), sentAt
        );
        const row = db.prepare('SELECT * FROM kds_tickets WHERE id = ?').get(r.lastInsertRowid);
        tickets.push({ id: row.id, uuid: row.uuid });
        // Broadcast to KDS subscribers when the host wires it (optional ctx).
        if (ctx.broadcastTicket) {
          try {
            ctx.broadcastTicket({
              id: row.id, uuid: row.uuid, check_id: null, online_order_id: o.id, station: row.station,
              table_label: row.table_label, server_name: row.server_name,
              items: titems, status: row.status, created_at: row.created_at,
              bumped_at: null, bumped_by: null,
            });
          } catch { /* broadcast is best-effort */ }
        }
      }
    }
    res.json({ order: orderView(getOrder(o.id)), kds_tickets: tickets });
  });
}

module.exports = { migrate, register };

/* ============================================================================
 * INTEGRATOR LINES — add to server.js (do NOT edit this file instead):
 *
 * 1) Public paths (in authMiddleware, alongside /health and /auth/login):
 *      if (req.path === '/health' || req.path === '/auth/login'
 *        || req.path === '/online/menu'
 *        || (req.path === '/online/orders' && req.method === 'POST')
 *        || req.path === '/online/last') return next();
 *
 * 2) After the boot migration blocks (once `db` exists):
 *      require('./routes/online.js').migrate(db);
 *
 * 3) After `app`, role helpers, and WS broadcasters exist (e.g. right before
 *    the "listen" section):
 *      require('./routes/online.js').register(app, {
 *        db, SITE_ID, managerOnly, serverPlus, kitchenPlus,
 *        nowIso, crypto, persistTotals, checkResponse, broadcastCheckUpdated,
 *        broadcastTicket,   // optional — enables instant KDS push
 *      });
 *
 * 4) Frontend: serve public/views/online.js and add a public route that calls
 *      renderOnlineOrder(document.getElementById('app'), api)
 *    with  api = async (path, method, body) => {
 *      const r = await fetch(path, { method: method || 'GET',
 *        headers: {'Content-Type':'application/json'},
 *        body: body ? JSON.stringify(body) : undefined });
 *      const d = await r.json().catch(() => ({}));
 *      if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
 *      return d;
 *    }
 * ========================================================================== */
