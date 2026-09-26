'use strict';
/* ============================================================================
 * Expoline loyalty — light visits/rewards.
 *
 * Phone-number identification: no app download, no card. Toast/SpotOn push
 * their apps; we don't. Earn is one tap at close, redeem is one tap at
 * payment. Staff see visit counts + a "regular" flag so regulars get
 * recognized.
 *
 * Rules (configurable via site_config):
 *   loyalty_points_per_dollar      default 1   — points earned per $1 spent
 *   loyalty_reward_cents_per_100pts default 500 — $5 reward per 100 points
 * All math in integer cents/points. Points can never go negative.
 * ========================================================================== */

const REGULAR_VISITS = 5;

function normPhone(p) {
  return String(p || '').replace(/\D/g, '');
}

function cleanName(n) {
  const s = String(n || '').trim().replace(/\s+/g, ' ');
  return s ? s.slice(0, 80) : '';
}

function loyaltyConfig(db, siteId) {
  const rows = db.prepare('SELECT key, value FROM site_config WHERE site_id = ? AND key LIKE ?')
    .all(siteId, 'loyalty_%');
  const m = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const ppd = parseInt(m.loyalty_points_per_dollar ?? '1', 10);
  const rcp = parseInt(m.loyalty_reward_cents_per_100pts ?? '500', 10);
  return {
    pointsPerDollar: Number.isFinite(ppd) && ppd > 0 ? ppd : 1,
    rewardCentsPer100Pts: Number.isFinite(rcp) && rcp > 0 ? rcp : 500,
  };
}

function customerView(c) {
  if (!c) return null;
  return {
    id: c.id,
    uuid: c.uuid,
    name: c.name,
    phone: c.phone,
    visit_count: c.visit_count || 0,
    points: c.points || 0,
    total_spent_cents: c.total_spent_cents || 0,
    is_regular: (c.visit_count || 0) >= REGULAR_VISITS,
    created_at: c.created_at,
  };
}

function migrate(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY,
    uuid TEXT UNIQUE,
    site_id TEXT,
    name TEXT,
    phone TEXT,
    visit_count INTEGER DEFAULT 0,
    points INTEGER DEFAULT 0,
    total_spent_cents INTEGER DEFAULT 0,
    created_at TEXT,
    UNIQUE(site_id, phone)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS loyalty_txns (
    id INTEGER PRIMARY KEY,
    uuid TEXT UNIQUE,
    site_id TEXT,
    customer_id INTEGER,
    check_id INTEGER,
    points_delta INTEGER,
    type TEXT CHECK(type IN ('earn','redeem')),
    created_at TEXT
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_loyalty_txns_check ON loyalty_txns(check_id, type)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_loyalty_txns_customer ON loyalty_txns(customer_id)`);
}

function register(app, ctx) {
  const { db, SITE_ID, serverPlus, nowIso, crypto, persistTotals,
    broadcastCheckUpdated, auditApproval } = ctx;

  /* GET /api/loyalty/lookup?phone= — find a customer by phone (digits only).
     Returns { customer } or { customer: null }. */
  app.get('/api/loyalty/lookup', serverPlus(), (req, res) => {
    const phone = normPhone(req.query.phone);
    if (!phone) return res.status(400).json({ error: 'phone is required' });
    const c = db.prepare('SELECT * FROM customers WHERE site_id = ? AND phone = ?')
      .get(SITE_ID, phone);
    res.json({ customer: customerView(c) });
  });

  /* GET /api/loyalty/customer/:id — customer detail + recent transactions. */
  app.get('/api/loyalty/customer/:id', serverPlus(), (req, res) => {
    const c = db.prepare('SELECT * FROM customers WHERE id = ? AND site_id = ?')
      .get(req.params.id, SITE_ID);
    if (!c) return res.status(404).json({ error: 'Customer not found' });
    const txns = db.prepare(
      'SELECT id, uuid, check_id, points_delta, type, created_at FROM loyalty_txns WHERE customer_id = ? ORDER BY id DESC LIMIT 20'
    ).all(c.id);
    res.json({ customer: customerView(c), recent_txns: txns });
  });

  /* POST /api/loyalty/earn {check_id, phone, name?} — award points for a
     paid/closed check. Idempotent per check: a second call is a no-op.
     Auto-creates the customer on first earn. */
  app.post('/api/loyalty/earn', serverPlus(), (req, res) => {
    const b = req.body || {};
    const phone = normPhone(b.phone);
    if (!phone) return res.status(400).json({ error: 'phone is required' });
    const check = db.prepare('SELECT * FROM checks WHERE id = ? AND site_id = ?')
      .get(b.check_id, SITE_ID);
    if (!check) return res.status(404).json({ error: 'Check not found' });
    if (check.status !== 'paid' && check.status !== 'closed') {
      return res.status(400).json({ error: 'Points are earned when the check is paid or closed' });
    }

    const now = nowIso();
    let result;
    db.exec('BEGIN IMMEDIATE');
    try {
      // Idempotency lives INSIDE the transaction so concurrent earns can't double-award.
      const dup = db.prepare("SELECT id FROM loyalty_txns WHERE check_id = ? AND type = 'earn' LIMIT 1")
        .get(check.id);
      if (dup) {
        db.exec('ROLLBACK');
        const c = db.prepare('SELECT * FROM customers WHERE site_id = ? AND phone = ?')
          .get(SITE_ID, phone);
        return res.json({ earned: 0, already_earned: true, customer: customerView(c) });
      }
      const t = persistTotals(check.id);
      const cfg = loyaltyConfig(db, SITE_ID);
      const points = Math.floor(t.total / 100) * cfg.pointsPerDollar;
      let c = db.prepare('SELECT * FROM customers WHERE site_id = ? AND phone = ?')
        .get(SITE_ID, phone);
      if (!c) {
        const r = db.prepare(
          `INSERT INTO customers (uuid, site_id, name, phone, visit_count, points, total_spent_cents, created_at)
           VALUES (?, ?, ?, ?, 0, 0, 0, ?)`
        ).run(crypto.randomUUID(), SITE_ID, cleanName(b.name) || phone, phone, now);
        c = db.prepare('SELECT * FROM customers WHERE id = ?').get(r.lastInsertRowid);
      }
      db.prepare(
        `INSERT INTO loyalty_txns (uuid, site_id, customer_id, check_id, points_delta, type, created_at)
         VALUES (?, ?, ?, ?, ?, 'earn', ?)`
      ).run(crypto.randomUUID(), SITE_ID, c.id, check.id, points, now);
      db.prepare(
        'UPDATE customers SET visit_count = visit_count + 1, points = points + ?, total_spent_cents = total_spent_cents + ? WHERE id = ?'
      ).run(points, t.total, c.id);
      db.exec('COMMIT');
      result = { points, total_cents: t.total, customerId: c.id };
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw e;
    }
    const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(result.customerId);
    auditApproval(req, 'loyalty_earn', { check_id: check.id },
      { customer_id: c.id, phone, points: result.points, check_total_cents: result.total_cents });
    res.status(201).json({ earned: result.points, customer: customerView(c) });
  });

  /* POST /api/loyalty/redeem {check_id, phone, points} — redeem points for a
     discount, applied through the existing comp_cents mechanism (reduces the
     check total, never below zero). One tap at payment. Points are deducted
     atomically and can never go negative. */
  app.post('/api/loyalty/redeem', serverPlus(), (req, res) => {
    const b = req.body || {};
    const phone = normPhone(b.phone);
    const points = b.points;
    if (!phone) return res.status(400).json({ error: 'phone is required' });
    if (!Number.isInteger(points) || points <= 0 || points % 100 !== 0) {
      return res.status(400).json({ error: 'points must be a positive multiple of 100' });
    }
    const c = db.prepare('SELECT * FROM customers WHERE site_id = ? AND phone = ?')
      .get(SITE_ID, phone);
    if (!c) return res.status(404).json({ error: 'Customer not found — no points to redeem' });
    if ((c.points || 0) < points) {
      return res.status(400).json({ error: `Insufficient points (has ${c.points || 0}, needs ${points})` });
    }
    const check = db.prepare('SELECT * FROM checks WHERE id = ? AND site_id = ?')
      .get(b.check_id, SITE_ID);
    if (!check) return res.status(404).json({ error: 'Check not found' });
    if (check.status !== 'open') {
      return res.status(400).json({ error: `Cannot redeem on a ${check.status} check` });
    }
    const cfg = loyaltyConfig(db, SITE_ID);
    const discount = Math.floor(points / 100) * cfg.rewardCentsPer100Pts;
    const t0 = persistTotals(check.id);
    if (t0.total <= 0) return res.status(400).json({ error: 'Check total is zero — nothing to discount' });
    if (discount > t0.total) {
      return res.status(400).json({
        error: `Reward $${(discount / 100).toFixed(2)} exceeds check total $${(t0.total / 100).toFixed(2)} — redeem fewer points`,
      });
    }

    const now = nowIso();
    const beforeComp = check.comp_cents || 0;
    let applied = false;
    db.exec('BEGIN IMMEDIATE');
    try {
      // Re-read the balance inside the transaction: two devices redeeming at
      // once can't both spend the same points.
      const fresh = db.prepare('SELECT points FROM customers WHERE id = ?').get(c.id);
      if ((fresh.points || 0) >= points) {
        db.prepare('UPDATE customers SET points = points - ? WHERE id = ?').run(points, c.id);
        db.prepare(
          `INSERT INTO loyalty_txns (uuid, site_id, customer_id, check_id, points_delta, type, created_at)
           VALUES (?, ?, ?, ?, ?, 'redeem', ?)`
        ).run(crypto.randomUUID(), SITE_ID, c.id, check.id, -points, now);
        db.prepare('UPDATE checks SET comp_cents = ? WHERE id = ?').run(beforeComp + discount, check.id);
        db.exec('COMMIT');
        applied = true;
      } else {
        db.exec('ROLLBACK');
      }
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw e;
    }
    if (!applied) return res.status(400).json({ error: 'Insufficient points' });

    const t = persistTotals(check.id);
    broadcastCheckUpdated(check.id);
    auditApproval(req, 'loyalty_redeem', { check_id: check.id },
      { customer_id: c.id, phone, points_redeemed: points, discount_cents: discount,
        before_comp_cents: beforeComp, after_comp_cents: beforeComp + discount });
    const updated = db.prepare('SELECT * FROM customers WHERE id = ?').get(c.id);
    res.json({ discount_cents: discount, customer: customerView(updated), totals: t });
  });
}

module.exports = { migrate, register };
