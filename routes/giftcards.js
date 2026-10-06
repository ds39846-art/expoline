'use strict';
/* ============================================================================
 * Expoline — Gift Cards (stored value)
 * Integration contract: { migrate(db), register(app, ctx) }.
 * The integrator requires this file, calls migrate(db) at boot (alongside the
 * other boot migrations), and calls register(app, ctx) after the core routes.
 * server.js and public/app.js are NEVER edited by this module.
 *
 * MONEY SAFETY:
 *  - balance_cents has a CHECK(balance_cents >= 0) constraint (DDL backstop).
 *  - Every redemption runs inside BEGIN IMMEDIATE with a conditional UPDATE
 *    (… WHERE balance_cents >= ?) — the check-and-deduct is atomic, so two
 *    concurrent redeems cannot double-spend. Loser gets changes=0 → 400.
 *  - Every mutation writes a gift_card_txns row (issue/redeem/reload/void).
 *  - Redemptions insert a real payments row with method='gift_card', so the
 *    check totals, KDS-agnostic finance math, and shift reports see them.
 *    NOTE FOR INTEGRATOR: finance categorization in server.js currently
 *    branches on 'card_demo' / 'cash' only. Add an
 *    `else if (p.method === 'gift_card')` branch wherever those appear
 *    (payouts ~L1492, shift ~L1552, sales ~L1626, export ~L1720, tips ~L1855)
 *    and treat gift-card volume like cash (no processing fee).
 * ========================================================================== */

/* Unambiguous alphabet: no 0/O, 1/I/L. */
const CODE_ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_GROUPS = [4, 4, 4];
const MAX_ISSUE_CENTS = 100000; // $1,000 sanity cap per card action

function normalizeCode(raw) {
  return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function genCode(crypto) {
  const bytes = crypto.randomBytes(CODE_GROUPS.reduce((a, b) => a + b, 0));
  let i = 0;
  return CODE_GROUPS
    .map((n) => Array.from({ length: n }, () => CODE_ALPHA[bytes[i++] % CODE_ALPHA.length]).join(''))
    .join('-');
}

function isInt(n) {
  return typeof n === 'number' && Number.isInteger(n);
}

function migrate(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS gift_cards (
    id INTEGER PRIMARY KEY,
    uuid TEXT UNIQUE,
    site_id TEXT,
    code TEXT UNIQUE,
    initial_cents INTEGER NOT NULL CHECK(initial_cents > 0),
    balance_cents INTEGER NOT NULL CHECK(balance_cents >= 0),
    status TEXT DEFAULT 'active' CHECK(status IN ('active','depleted','voided')),
    issued_at TEXT,
    last_used_at TEXT
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS gift_card_txns (
    id INTEGER PRIMARY KEY,
    card_id INTEGER NOT NULL,
    check_id INTEGER,
    amount_cents INTEGER NOT NULL,
    type TEXT CHECK(type IN ('issue','redeem','reload','void')),
    created_at TEXT,
    actor TEXT
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_gift_cards_code ON gift_cards(code)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_gift_card_txns_card ON gift_card_txns(card_id)`);

  /* The core payments table ships with CHECK(method IN ('cash','card_demo')).
     Gift-card redemptions are real payment rows (method='gift_card'), so widen
     the constraint with a table rebuild (SQLite cannot ALTER a CHECK).
     Nothing references payments via FK, and the single index is recreated. */
  const paySql = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'payments'").get();
  if (paySql && paySql.sql && !paySql.sql.includes('gift_card')) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(`ALTER TABLE payments RENAME TO payments_legacy_gc`);
      db.exec(`CREATE TABLE payments (
        id INTEGER PRIMARY KEY,
        uuid TEXT,
        check_id INTEGER,
        site_id TEXT,
        method TEXT CHECK(method IN ('cash','card_demo','gift_card')),
        amount_cents INTEGER,
        tip_cents INTEGER DEFAULT 0,
        tendered_cents INTEGER,
        brand TEXT,
        last4 TEXT,
        auth_code TEXT,
        status TEXT DEFAULT 'completed' CHECK(status IN ('completed','refunded','partial_refund')),
        refunded_cents INTEGER DEFAULT 0,
        created_at TEXT
      )`);
      db.exec(`INSERT INTO payments (id, uuid, check_id, site_id, method, amount_cents,
          tip_cents, tendered_cents, brand, last4, auth_code, status, refunded_cents, created_at)
        SELECT id, uuid, check_id, site_id, method, amount_cents,
          tip_cents, tendered_cents, brand, last4, auth_code, status, refunded_cents, created_at
        FROM payments_legacy_gc`);
      db.exec(`DROP TABLE payments_legacy_gc`);
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_uuid ON payments(uuid)`);
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw e;
    }
  }
}

function cardView(c) {
  return {
    id: c.id,
    uuid: c.uuid,
    code: c.code,
    initial_cents: c.initial_cents,
    balance_cents: c.balance_cents,
    status: c.status,
    issued_at: c.issued_at,
    last_used_at: c.last_used_at,
  };
}

function register(app, ctx) {
  const { db, SITE_ID, gateSiteAdmin, serverPlus, nowIso, crypto,
          persistTotals, checkResponse, paymentView, broadcastCheckUpdated,
          auditApproval, idemKeyFrom, idemReplay, idemReserve, idemStore, idemClear,
          dayClosedToday } = ctx;
  // EOD freeze (audit gap #5): a redemption writes a payment dated
  // today; the host owns the close-out lock. Absent the helper (older
  // hosts), behavior is unchanged.
  const todayClosed = typeof dayClosedToday === 'function' ? dayClosedToday : () => false;

  const findCard = (rawCode) => {
    const norm = normalizeCode(rawCode);
    if (!norm) return null;
    return db.prepare(
      "SELECT * FROM gift_cards WHERE REPLACE(code, '-', '') = ? AND site_id = ?"
    ).get(norm, SITE_ID);
  };

  const txn = (fn) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      db.exec('COMMIT');
      return r;
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw e;
    }
  };

  const issueCode = () => {
    for (let attempt = 0; attempt < 12; attempt++) {
      const code = genCode(crypto);
      const clash = db.prepare('SELECT id FROM gift_cards WHERE code = ?').get(code);
      if (!clash) return code;
    }
    const err = new Error('Could not generate a unique gift card code');
    err.status = 500;
    throw err;
  };

  /* ---------------- issue ---------------- */
  app.post('/api/gift-cards/issue', gateSiteAdmin(), (req, res) => {
    const { initial_cents } = req.body || {};
    // Phase 1B: idempotency replay FIRST — a retried issue returns the
    // already-issued card even though validation below would re-run.
    const ikey0 = idemKeyFrom(req);
    if (ikey0) {
      const rp0 = idemReplay('gift_card_issue', ikey0);
      if (rp0) return res.status(rp0.status).json(rp0.body);
    }
    if (!isInt(initial_cents) || initial_cents <= 0) {
      return res.status(400).json({ error: 'initial_cents must be a positive integer' });
    }
    if (initial_cents > MAX_ISSUE_CENTS) {
      return res.status(400).json({ error: `initial_cents cannot exceed ${MAX_ISSUE_CENTS} ($${MAX_ISSUE_CENTS / 100})` });
    }
    // Phase 1B: reserve the idempotency key AFTER validation, BEFORE minting.
    const ikey = ikey0;
    let idem = null;
    if (ikey) {
      const rsv = idemReserve('gift_card_issue', ikey);
      if (rsv.state === 'replay') return res.status(rsv.status).json(rsv.body);
      if (rsv.state === 'processing') return res.status(409).json({ error: 'Duplicate issue already in progress — retry shortly' });
      idem = ikey;
    }
    try {
      const card = txn(() => {
        const code = issueCode();
        const r = db.prepare(
          `INSERT INTO gift_cards (uuid, site_id, code, initial_cents, balance_cents, status, issued_at)
           VALUES (?, ?, ?, ?, ?, 'active', ?)`
        ).run(crypto.randomUUID(), SITE_ID, code, initial_cents, initial_cents, nowIso());
        const c = db.prepare('SELECT * FROM gift_cards WHERE id = ?').get(r.lastInsertRowid);
        db.prepare(
          `INSERT INTO gift_card_txns (card_id, check_id, amount_cents, type, created_at, actor)
           VALUES (?, NULL, ?, 'issue', ?, ?)`
        ).run(c.id, initial_cents, nowIso(), req.user ? req.user.name : '?');
        return c;
      });
      auditApproval(req, 'gift_card_issue', {}, {
        approver: req.user ? req.user.name : '?',
        before: null,
        after: { code: card.code, initial_cents: card.initial_cents },
      });
      const out = { card: cardView(card) };
      if (idem) idemStore('gift_card_issue', idem, 201, out);
      res.status(201).json(out);
    } catch (e) {
      if (idem) idemClear('gift_card_issue', idem);
      res.status(e.status || 500).json({ error: e.message || 'Issue failed' });
    }
  });

  /* ---------------- reload ---------------- */
  app.post('/api/gift-cards/reload', gateSiteAdmin(), (req, res) => {
    const { code, amount_cents } = req.body || {};
    // Phase 1B: idempotency replay FIRST.
    const ikey0 = idemKeyFrom(req);
    if (ikey0) {
      const rp0 = idemReplay('gift_card_reload', ikey0);
      if (rp0) return res.status(rp0.status).json(rp0.body);
    }
    const card = findCard(code);
    if (!card) return res.status(404).json({ error: 'Gift card not found' });
    if (card.status === 'voided') return res.status(400).json({ error: 'Card is voided and cannot be reloaded' });
    if (!isInt(amount_cents) || amount_cents <= 0) {
      return res.status(400).json({ error: 'amount_cents must be a positive integer' });
    }
    if (amount_cents > MAX_ISSUE_CENTS) {
      return res.status(400).json({ error: `amount_cents cannot exceed ${MAX_ISSUE_CENTS}` });
    }
    // Phase 1B: reserve the idempotency key AFTER validation, BEFORE the reload.
    const ikey = ikey0;
    let idem = null;
    if (ikey) {
      const rsv = idemReserve('gift_card_reload', ikey);
      if (rsv.state === 'replay') return res.status(rsv.status).json(rsv.body);
      if (rsv.state === 'processing') return res.status(409).json({ error: 'Duplicate reload already in progress — retry shortly' });
      idem = ikey;
    }
    try {
      const updated = txn(() => {
        const newStatus = card.status === 'depleted' ? 'active' : card.status;
        db.prepare(
          `UPDATE gift_cards SET balance_cents = balance_cents + ?, status = ?, last_used_at = ?
           WHERE id = ? AND site_id = ?`
        ).run(amount_cents, newStatus, nowIso(), card.id, SITE_ID);
        db.prepare(
          `INSERT INTO gift_card_txns (card_id, check_id, amount_cents, type, created_at, actor)
           VALUES (?, NULL, ?, 'reload', ?, ?)`
        ).run(card.id, amount_cents, nowIso(), req.user ? req.user.name : '?');
        return db.prepare('SELECT * FROM gift_cards WHERE id = ?').get(card.id);
      });
      const out = { card: cardView(updated) };
      if (idem) idemStore('gift_card_reload', idem, 200, out);
      res.json(out);
    } catch (e) {
      if (idem) idemClear('gift_card_reload', idem);
      res.status(500).json({ error: 'Reload failed' });
    }
  });

  /* ---------------- void (only if never used) ---------------- */
  app.post('/api/gift-cards/void', gateSiteAdmin(), (req, res) => {
    const { code } = req.body || {};
    const card = findCard(code);
    if (!card) return res.status(404).json({ error: 'Gift card not found' });
    if (card.status === 'voided') return res.status(400).json({ error: 'Card is already voided' });
    if (card.status === 'depleted' || card.balance_cents !== card.initial_cents) {
      return res.status(400).json({ error: 'Only a never-used card can be voided' });
    }
    try {
      const updated = txn(() => {
        db.prepare(`UPDATE gift_cards SET status = 'voided' WHERE id = ? AND site_id = ?`)
          .run(card.id, SITE_ID);
        db.prepare(
          `INSERT INTO gift_card_txns (card_id, check_id, amount_cents, type, created_at, actor)
           VALUES (?, NULL, ?, 'void', ?, ?)`
        ).run(card.id, card.balance_cents, nowIso(), req.user ? req.user.name : '?');
        return db.prepare('SELECT * FROM gift_cards WHERE id = ?').get(card.id);
      });
      auditApproval(req, 'gift_card_void', {}, {
        approver: req.user ? req.user.name : '?',
        before: { code: card.code, balance_cents: card.balance_cents },
        after: { code: card.code, status: 'voided' },
      });
      res.json({ card: cardView(updated) });
    } catch (e) {
      res.status(500).json({ error: 'Void failed' });
    }
  });

  /* ---------------- balance lookup (single tap at payment) ---------------- */
  app.get('/api/gift-cards/balance/:code', serverPlus(), (req, res) => {
    const card = findCard(req.params.code);
    if (!card) return res.status(404).json({ error: 'Gift card not found' });
    res.json({ card: cardView(card) });
  });

  /* ---------------- list (manager view) ---------------- */
  app.get('/api/gift-cards', gateSiteAdmin(), (req, res) => {
    const rows = db.prepare(
      'SELECT * FROM gift_cards WHERE site_id = ? ORDER BY id DESC LIMIT 200'
    ).all(SITE_ID);
    res.json({ cards: rows.map(cardView) });
  });

  /* ---------------- redeem → real payment row ---------------- */
  app.post('/api/gift-cards/redeem', serverPlus(), (req, res) => {
    const { check_id, gift_card_code, amount_cents, tip_cents = 0 } = req.body || {};
    // Phase 1B: idempotency replay FIRST — a retried redeem replays the
    // stored payment even though the card balance / check balance changed.
    const ikey0 = idemKeyFrom(req);
    if (ikey0) {
      const rp0 = idemReplay('gift_card_redeem', ikey0);
      if (rp0) return res.status(rp0.status).json(rp0.body);
    }
    const check = db.prepare('SELECT * FROM checks WHERE id = ? AND site_id = ?').get(check_id, SITE_ID);
    if (!check) return res.status(404).json({ error: 'Check not found' });
    if (check.status !== 'open') {
      return res.status(400).json({ error: `Cannot take payment on a ${check.status} check` });
    }
    // EOD freeze: the redemption payment would be dated today — a
    // closed-out day takes no new money (reopen it from Finance).
    if (todayClosed()) {
      return res.status(409).json({ error: 'Business day is closed out — reopen it (Finance → Close day) before taking new payments', day_closed: true });
    }
    const card = findCard(gift_card_code);
    if (!card) return res.status(404).json({ error: 'Gift card not found' });
    if (card.status === 'voided') return res.status(400).json({ error: 'Gift card is voided' });
    if (card.status === 'depleted' || card.balance_cents <= 0) {
      return res.status(400).json({ error: 'Gift card is depleted' });
    }
    if (isInt(tip_cents) && tip_cents > 0) {
      return res.status(400).json({ error: 'Tips cannot be charged to a gift card — take the tip on another tender' });
    }
    if (tip_cents !== 0 && !(isInt(tip_cents) && tip_cents === 0)) {
      return res.status(400).json({ error: 'tip_cents must be 0 for gift card payments' });
    }

    const totals = persistTotals(check.id);
    if (totals.balance <= 0) return res.status(400).json({ error: 'Check is already paid in full' });

    const amount = amount_cents == null
      ? Math.min(card.balance_cents, totals.balance)
      : amount_cents;
    if (!isInt(amount) || amount <= 0) {
      return res.status(400).json({ error: 'amount_cents must be a positive integer' });
    }
    if (amount > card.balance_cents) {
      return res.status(400).json({
        error: `Insufficient gift card balance (${card.balance_cents}¢ available)`,
      });
    }
    // Phase 1B money audit: a redemption may never exceed the remaining
    // check balance (no negative balances via over-application).
    if (amount > totals.balance) {
      return res.status(400).json({
        error: `amount_cents (${amount}¢) exceeds the remaining check balance (${totals.balance}¢)`,
      });
    }

    // Phase 1B: reserve the idempotency key AFTER validation, BEFORE the spend.
    const ikey = ikey0;
    let idem = null;
    if (ikey) {
      const rsv = idemReserve('gift_card_redeem', ikey);
      if (rsv.state === 'replay') return res.status(rsv.status).json(rsv.body);
      if (rsv.state === 'processing') return res.status(409).json({ error: 'Duplicate redeem already in progress — retry shortly' });
      idem = ikey;
    }

    try {
      const out = txn(() => {
        // Atomic deduct: the balance guard inside UPDATE is what defeats the
        // double-spend race. changes===0 means someone else spent it first.
        const upd = db.prepare(
          `UPDATE gift_cards SET balance_cents = balance_cents - ?, last_used_at = ?
           WHERE id = ? AND site_id = ? AND balance_cents >= ?`
        ).run(amount, nowIso(), card.id, SITE_ID, amount);
        if (upd.changes !== 1) {
          const err = new Error('Gift card balance changed — please re-check the balance and retry');
          err.status = 409;
          throw err;
        }
        let fresh = db.prepare('SELECT * FROM gift_cards WHERE id = ?').get(card.id);
        if (fresh.balance_cents === 0 && fresh.status === 'active') {
          db.prepare(`UPDATE gift_cards SET status = 'depleted' WHERE id = ?`).run(card.id);
          fresh = db.prepare('SELECT * FROM gift_cards WHERE id = ?').get(card.id);
        }
        db.prepare(
          `INSERT INTO gift_card_txns (card_id, check_id, amount_cents, type, created_at, actor)
           VALUES (?, ?, ?, 'redeem', ?, ?)`
        ).run(card.id, check.id, amount, nowIso(), req.user ? req.user.name : '?');

        const norm = normalizeCode(card.code);
        const pr = db.prepare(
          `INSERT INTO payments (uuid, check_id, site_id, method, amount_cents, tip_cents,
             tendered_cents, brand, last4, auth_code, status, created_at)
           VALUES (?, ?, ?, 'gift_card', ?, 0, NULL, 'GIFT', ?, ?, 'completed', ?)`
        ).run(crypto.randomUUID(), check.id, SITE_ID, amount,
          norm.slice(-4) || null, norm, nowIso());
        const payment = paymentView(db.prepare('SELECT * FROM payments WHERE id = ?').get(pr.lastInsertRowid));

        const after = persistTotals(check.id);
        if (after.balance <= 0) {
          db.prepare(`UPDATE checks SET status = 'paid' WHERE id = ?`).run(check.id);
        }
        return { payment, card: fresh, checkId: check.id };
      });
      broadcastCheckUpdated(out.checkId);
      const resp = {
        payment: out.payment,
        card: cardView(out.card),
        check: checkResponse(out.checkId),
      };
      if (idem) idemStore('gift_card_redeem', idem, 201, resp);
      res.status(201).json(resp);
    } catch (e) {
      if (idem) idemClear('gift_card_redeem', idem);
      res.status(e.status || 500).json({ error: e.message || 'Redeem failed' });
    }
  });

  /* ---------------- transaction history for a card ---------------- */
  app.get('/api/gift-cards/:code/txns', gateSiteAdmin(), (req, res) => {
    const card = findCard(req.params.code);
    if (!card) return res.status(404).json({ error: 'Gift card not found' });
    const rows = db.prepare(
      'SELECT id, check_id, amount_cents, type, created_at, actor FROM gift_card_txns WHERE card_id = ? ORDER BY id'
    ).all(card.id);
    res.json({ card: cardView(card), txns: rows });
  });
}

module.exports = { migrate, register };
