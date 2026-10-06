'use strict';
/* LAN site brain — sync store: schema, op envelope engine, Lamport clock.
 *
 * The op log is the database (DESIGN.md §6): every applied op envelope is
 * appended to lan_op_log; domain tables (checks, check_items, payments,
 * kds_tickets) are a materialized view of that log. processed_ops is the
 * idempotency index: a duplicate op_id returns the cached result without
 * re-applying — this is what makes kill-mid-flush safe.
 *
 * Op envelope (matches DESIGN.md §2; site_slug is the string site key):
 *   { op_id, site_slug, device_id, actor_id, seq, lamport, op, payload, created_at }
 *
 * Conflict policy (DESIGN.md §5):
 *  - open_check / add_items / send / payment / close: additive; replays
 *    absorbed by idempotency. Temp ids sent by the client BECOME the
 *    permanent uuid (cross-engine sync identity — DESIGN.md §7).
 *  - void_item: first-writer-wins; second void → {ok, already:true}.
 *    Requires manager approval (live PIN or offline PIN-hash + one-time
 *    nonce — never the raw PIN; the nonce wiring is in server.js).
 *  - table_state: last-writer-wins by (lamport, device_id); the loser is
 *    told {applied:false, conflict:true} so the UI can refresh.
 *  - menu_update: version-guarded; stale versions rejected with
 *    current_version so the editor rebases.
 */

const crypto = require('node:crypto');

const SUPPORTED_OPS = new Set([
  'open_check', 'add_items', 'void_item', 'send',
  'payment', 'close', 'table_state', 'menu_update',
]);

/* The course vocabulary, matching the mainline API (server.js COURSES
 * and the client COURSE_LIST): a synced line may carry any of these,
 * null for no course, or nothing for the menu default. */
const COURSES = new Set(['drink', 'appetizer', 'entree', 'dessert']);

/* Additive, guarded migrations. IF NOT EXISTS everywhere; PRAGMA checks
 * before ALTER. Safe to run on every boot next to the existing migrations. */
function migrate(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS lan_kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS lan_processed_ops (
    op_id TEXT PRIMARY KEY,
    site_slug TEXT NOT NULL,
    op TEXT NOT NULL,
    result_json TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS lan_op_log (
    op_id TEXT PRIMARY KEY,
    lamport INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    device_id TEXT NOT NULL,
    envelope_json TEXT NOT NULL
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_lan_op_log_order ON lan_op_log(lamport, seq)`);
  // Floor register for table_state ops (LWW register; the loser is told).
  db.exec(`CREATE TABLE IF NOT EXISTS lan_table_state (
    table_id INTEGER PRIMARY KEY,
    site_slug TEXT NOT NULL,
    state TEXT NOT NULL,
    lamport INTEGER NOT NULL,
    device_id TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  // WAN upload queue: ops the brain still owes Expoline cloud. Drained when
  // EXPOLINE_CLOUD_URL is set; otherwise it just accumulates (durable).
  db.exec(`CREATE TABLE IF NOT EXISTS lan_wan_queue (
    op_id TEXT PRIMARY KEY,
    envelope_json TEXT NOT NULL,
    queued_at TEXT NOT NULL
  )`);
  // menu_items.version for the menu_update version guard (DESIGN.md §5).
  const cols = new Set(db.prepare('PRAGMA table_info(menu_items)').all().map((c) => c.name));
  if (!cols.has('version')) db.exec('ALTER TABLE menu_items ADD COLUMN version INTEGER DEFAULT 1');
  db.prepare('UPDATE menu_items SET version = 1 WHERE version IS NULL').run();
}

function getKv(db, key, dflt) {
  const r = db.prepare('SELECT value FROM lan_kv WHERE key = ?').get(key);
  return r ? r.value : dflt;
}
function setKv(db, key, value) {
  db.prepare(`INSERT INTO lan_kv(key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, String(value));
}

/* Lamport clock, persisted in lan_kv so a restart doesn't rewind it
 * (RISKS.md #9: a wiped device rejoining with clock 0 could lose a
 * table_state LWW race — persistence + the rejoin handshake mitigate it). */
function lamport(db) {
  return parseInt(getKv(db, 'lamport', '0'), 10) || 0;
}
function tick(db, remote = 0) {
  const next = Math.max(lamport(db), remote | 0) + 1;
  setKv(db, 'lamport', String(next));
  return next;
}

const nowIso = () => new Date().toISOString();

/* Resolve a check reference: uuid (client temp id became the uuid) → int id,
 * else a plain integer id. Mirrors the prototype's _resolveCheck. */
function resolveCheck(db, siteSlug, ref) {
  const s = String(ref);
  const byUuid = db.prepare('SELECT id FROM checks WHERE uuid = ? AND site_id = ?').get(s, siteSlug);
  if (byUuid) return Number(byUuid.id);
  const n = Number(s);
  return Number.isInteger(n) ? n : null;
}
function resolveItem(db, siteSlug, ref) {
  const s = String(ref);
  const byUuid = db.prepare('SELECT id FROM check_items WHERE uuid = ?').get(s);
  if (byUuid) return Number(byUuid.id);
  const n = Number(s);
  return Number.isInteger(n) ? n : null;
}

/* Apply one op against the real production schema. `h` is the helper
 * bundle passed from server.js (persistTotals, checkResponse, itemView,
 * paymentView, broadcast*, auditApproval, verifyManagerPin,
 * verifyOfflineApproval, consumeOfflineApproval, crypto).
 * opts.viaGossip: the op was already authorized by the brain that applied
 * it — skip per-op role/manager gates on re-application (the gates ran at
 * the brain; re-running them here would fail on redacted payloads).
 * Returns a JSON-serializable result; throws on unexpected failures
 * (receiveBatch converts to {ok:false, error}). */
function applyOp(db, h, siteSlug, actor, op, opts) {
  const viaGossip = !!(opts && opts.viaGossip);
  const p = typeof op.payload === 'string' ? JSON.parse(op.payload) : (op.payload || {});
  switch (op.op) {
    case 'open_check': {
      const checkUuid = String(p.check_uuid || p.temp_id || crypto.randomUUID());
      // Idempotent: the client temp id became the uuid; a replayed
      // open_check finds the existing row.
      const existing = db.prepare('SELECT id, uuid FROM checks WHERE uuid = ? AND site_id = ?').get(checkUuid, siteSlug);
      if (existing) {
        return { ok: true, check_id: existing.id, check_uuid: existing.uuid, temp_id: checkUuid, replayed_row: true };
      }
      const table = p.table_id != null
        ? db.prepare('SELECT id FROM tables WHERE id = ? AND site_id = ?').get(p.table_id, siteSlug)
        : null;
      if (!table) return { ok: false, error: 'invalid_table', table_id: p.table_id };
      if (!Number.isInteger(p.guest_count) || p.guest_count < 1) {
        return { ok: false, error: 'invalid_guest_count' };
      }
      const taken = db.prepare("SELECT id FROM checks WHERE table_id = ? AND status = 'open' LIMIT 1").get(p.table_id);
      if (taken) return { ok: false, error: 'table_has_open_check', check_id: taken.id };
      const r = db.prepare(
        "INSERT INTO checks (uuid, site_id, table_id, server_id, tab_name, guest_count, status, opened_at) VALUES (?, ?, ?, ?, ?, ?, 'open', ?)"
      ).run(checkUuid, siteSlug, p.table_id, actor ? actor.id : null,
        (typeof p.tab_name === 'string' && p.tab_name.trim()) || null, p.guest_count, nowIso());
      const check = h.checkResponse(r.lastInsertRowid);
      h.broadcastCheckUpdated(check.id);
      return { ok: true, check_id: check.id, check_uuid: checkUuid, temp_id: checkUuid };
    }

    case 'add_items': {
      const checkId = resolveCheck(db, siteSlug, p.check_uuid);
      const chk = checkId === null ? null
        : db.prepare('SELECT * FROM checks WHERE id = ? AND site_id = ?').get(checkId, siteSlug);
      if (!chk) return { ok: false, error: 'check_not_found', check_ref: p.check_uuid };
      if (chk.status !== 'open') return { ok: false, error: 'check_not_open', check_id: checkId };
      const itemIds = [];
      const itemUuids = [];
      const insItem = db.prepare(
        "INSERT INTO check_items (uuid, check_id, menu_item_id, seat, qty, unit_price_cents, modifiers_json, course, state, added_at, note, allergy, allergy_detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'held', ?, ?, ?, ?)"
      );
      for (const it of p.items || []) {
        const itemUuid = String(it.item_uuid || it.temp_id || crypto.randomUUID());
        const dup = db.prepare('SELECT id FROM check_items WHERE uuid = ?').get(itemUuid);
        if (dup) { // item-level idempotency inside a replayed batch
          itemIds.push(dup.id); itemUuids.push(itemUuid);
          continue;
        }
        const menuItem = it.menu_item_id != null
          ? db.prepare('SELECT * FROM menu_items WHERE id = ? AND site_id = ? AND active = 1').get(it.menu_item_id, siteSlug)
          : null;
        if (!menuItem) return { ok: false, error: 'invalid_menu_item', menu_item_id: it.menu_item_id };
        if (!Number.isInteger(it.seat) || it.seat < 1 || it.seat > chk.guest_count) {
          return { ok: false, error: 'invalid_seat', seat: it.seat };
        }
        if (!Number.isInteger(it.qty) || it.qty < 1) return { ok: false, error: 'invalid_qty' };
        /* Per-line special request, allergy flag, and ring-time
           course — mainline POST /items parity. The old insert never
           wrote these columns and forced the menu course, so a line
           synced through the brain lost its note, its allergy
           warning, and its picked course. Absent course keeps the
           menu default; null means no course; a note or detail must
           be a string of at most 140 chars. */
        let note = null;
        if (it.note !== undefined && it.note !== null) {
          if (typeof it.note !== 'string' || it.note.length > 140) {
            return { ok: false, error: 'invalid_note' };
          }
          note = it.note.trim() || null;
        }
        const allergy = it.allergy ? 1 : 0;
        let allergyDetail = null;
        if (it.allergy_detail !== undefined && it.allergy_detail !== null) {
          if (typeof it.allergy_detail !== 'string' || it.allergy_detail.length > 140) {
            return { ok: false, error: 'invalid_allergy_detail' };
          }
          allergyDetail = it.allergy_detail.trim() || null;
        }
        let lineCourse = menuItem.course;
        if (it.course !== undefined) {
          if (it.course !== null && !COURSES.has(it.course)) {
            return { ok: false, error: 'invalid_course' };
          }
          lineCourse = it.course;
        }
        // Same pricing rule as POST /api/checks/:id/items: fixed-price items
        // ALWAYS use the menu price; MP (price 0) items need a manager price.
        let unitPrice = menuItem.price_cents;
        if (menuItem.price_cents === 0) {
          if (!actor || actor.role !== 'manager') return { ok: false, error: 'mp_requires_manager' };
          if (!Number.isInteger(it.unit_price_cents) || it.unit_price_cents < 0) {
            return { ok: false, error: 'mp_requires_price' };
          }
          unitPrice = it.unit_price_cents;
        }
        const mods = Array.isArray(it.modifiers) ? it.modifiers : [];
        const r = insItem.run(itemUuid, checkId, menuItem.id, it.seat, it.qty, unitPrice,
          JSON.stringify(mods), lineCourse, nowIso(), note, allergy, allergyDetail);
        itemIds.push(Number(r.lastInsertRowid));
        itemUuids.push(itemUuid);
      }
      h.persistTotals(checkId);
      h.broadcastCheckUpdated(checkId);
      return { ok: true, check_id: checkId, item_ids: itemIds, item_uuids: itemUuids };
    }

    case 'void_item': {
      // Manager gate. Online path: live manager PIN in the payload.
      // Offline path: PIN hash + one-time nonce (never the raw PIN) —
      // verified and consumed exactly like the legacy void endpoints.
      const itemId = resolveItem(db, siteSlug, p.item_uuid);
      if (itemId === null) return { ok: false, error: 'item_not_found', item_ref: p.item_uuid };
      const checkId = resolveCheck(db, siteSlug, p.check_uuid);
      const check = checkId === null ? null
        : db.prepare('SELECT * FROM checks WHERE id = ? AND site_id = ?').get(checkId, siteSlug);
      if (!check) return { ok: false, error: 'check_not_found', check_ref: p.check_uuid };
      if (check.status !== 'open') return { ok: false, error: 'check_not_open', check_id: checkId };
      const item = db.prepare('SELECT ci.*, mi.name FROM check_items ci LEFT JOIN menu_items mi ON mi.id = ci.menu_item_id WHERE ci.id = ? AND ci.check_id = ?').get(itemId, checkId);
      if (!item) return { ok: false, error: 'item_not_on_check' };
      let mgr = null;
      let approvalMeta = {};
      if (viaGossip) {
        // Already manager-approved at the brain; the stored envelope is
        // redacted (no PIN / nonce), so there is nothing left to verify.
        mgr = { id: op.actor_id ?? null, name: 'gossip' };
      } else if (p.approval_nonce !== undefined || p.manager_pin_hash !== undefined) {
        const v = h.verifyOfflineApproval(p.approval_nonce, p.manager_pin_hash, checkId, itemId);
        if (!v) return { ok: false, error: 'invalid_offline_approval' };
        mgr = v.mgr;
        approvalMeta = { offline: true, approval_nonce: v.nonce, replay: v.replay };
        if (item.state === 'cancelled' && v.replay) {
          return { ok: true, already: true, item_id: itemId, approved_by: mgr.name };
        }
      } else {
        mgr = h.verifyManagerPin(p.manager_pin);
        if (!mgr) return { ok: false, error: 'manager_pin_required' };
      }
      if (item.state === 'cancelled') return { ok: true, already: true, item_id: itemId }; // first-writer-wins
      if (!['held', 'sent', 'fulfilled'].includes(item.state)) {
        return { ok: false, error: 'item_not_voidable', state: item.state };
      }
      const before = { state: item.state, name: item.name, unit_price_cents: item.unit_price_cents };
      db.prepare("UPDATE check_items SET state = 'cancelled' WHERE id = ?").run(itemId);
      if (approvalMeta.offline && !approvalMeta.replay) {
        h.consumeOfflineApproval(approvalMeta.approval_nonce, checkId, itemId, mgr);
      }
      h.persistTotals(checkId);
      h.broadcastCheckUpdated(checkId);
      h.auditApproval({ user: actor }, 'void_item', { check_id: checkId, item_id: itemId },
        { approver: mgr.name, approver_id: mgr.id, before, after: { state: 'cancelled' },
          reason: (typeof p.reason === 'string' && p.reason.trim()) || null,
          via: 'sync_batch', offline: approvalMeta.offline || undefined });
      return { ok: true, item_id: itemId, approved_by: mgr.name };
    }

    case 'send': {
      // Fire held items to the kitchen (at-least-once to KDS; the KDS
      // display dedupes by ticket/item uuid — RISKS.md #11 notes the full
      // KDS failover plan is separate work).
      const checkId = resolveCheck(db, siteSlug, p.check_uuid);
      const check = checkId === null ? null
        : db.prepare('SELECT * FROM checks WHERE id = ? AND site_id = ?').get(checkId, siteSlug);
      if (!check) return { ok: false, error: 'check_not_found', check_ref: p.check_uuid };
      if (check.status !== 'open') return { ok: false, error: 'check_not_open', check_id: checkId };
      const held = db.prepare(
        "SELECT ci.*, mi.name, mi.station FROM check_items ci JOIN menu_items mi ON mi.id = ci.menu_item_id WHERE ci.check_id = ? AND ci.state = 'held' ORDER BY ci.added_at, ci.id"
      ).all(checkId);
      if (held.length === 0) return { ok: true, sent: 0, tickets: [] };
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
          item_id: it.id, item_uuid: it.uuid, name: it.name, seat: it.seat, qty: it.qty,
          modifiers: h.parseJson(it.modifiers_json, []),
        });
      }
      const tickets = [];
      const insTicket = db.prepare(
        "INSERT INTO kds_tickets (uuid, check_id, site_id, station, table_label, server_name, items_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'new', ?)"
      );
      for (const [station, items] of byStation) {
        const r = insTicket.run(crypto.randomUUID(), checkId, siteSlug, station,
          table ? table.label : null, serverUser ? serverUser.name : null,
          JSON.stringify(items), sentAt);
        const ticket = h.ticketView(db.prepare('SELECT * FROM kds_tickets WHERE id = ?').get(r.lastInsertRowid));
        tickets.push(ticket);
        h.broadcastTicket(ticket);
      }
      h.persistTotals(checkId);
      h.broadcastCheckUpdated(checkId);
      return { ok: true, sent: held.length, tickets: tickets.map((t) => t.id) };
    }

    case 'payment': {
      // Cash works offline: by the time the brain sees this op it is a
      // plain ledger entry, settled exactly once via the payment uuid.
      const checkId = resolveCheck(db, siteSlug, p.check_uuid);
      const check = checkId === null ? null
        : db.prepare('SELECT * FROM checks WHERE id = ? AND site_id = ?').get(checkId, siteSlug);
      if (!check) return { ok: false, error: 'check_not_found', check_ref: p.check_uuid };
      if (check.status !== 'open') return { ok: false, error: 'check_not_open', check_id: checkId };
      const payUuid = String(p.payment_uuid || crypto.randomUUID());
      const dup = db.prepare('SELECT id FROM payments WHERE uuid = ?').get(payUuid);
      if (dup) {
        return { ok: true, payment_id: dup.id, payment_uuid: payUuid, already: true };
      }
      if (!['cash', 'card_demo'].includes(p.method)) return { ok: false, error: 'invalid_method' };
      if (!Number.isInteger(p.amount_cents) || p.amount_cents <= 0) return { ok: false, error: 'invalid_amount' };
      if (!Number.isInteger(p.tip_cents || 0) || (p.tip_cents || 0) < 0) return { ok: false, error: 'invalid_tip' };
      const totals = h.persistTotals(checkId);
      if (totals.balance <= 0) return { ok: false, error: 'check_paid_in_full' };
      let authCode = null;
      if (p.method === 'card_demo') authCode = 'DEMO' + crypto.randomBytes(3).toString('hex').toUpperCase();
      const r = db.prepare(
        "INSERT INTO payments (uuid, check_id, site_id, method, amount_cents, tip_cents, tendered_cents, brand, last4, auth_code, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?)"
      ).run(payUuid, checkId, siteSlug, p.method, p.amount_cents, p.tip_cents || 0,
        p.tendered_cents ?? null, p.brand || (p.method === 'card_demo' ? 'DEMO' : null),
        p.last4 || null, authCode, nowIso());
      const after = h.persistTotals(checkId);
      if (after.balance <= 0) db.prepare("UPDATE checks SET status = 'paid' WHERE id = ?").run(checkId);
      h.broadcastCheckUpdated(checkId);
      return { ok: true, payment_id: Number(r.lastInsertRowid), payment_uuid: payUuid };
    }

    case 'close': {
      const checkId = resolveCheck(db, siteSlug, p.check_uuid);
      const check = checkId === null ? null
        : db.prepare('SELECT * FROM checks WHERE id = ? AND site_id = ?').get(checkId, siteSlug);
      if (!check) return { ok: false, error: 'check_not_found', check_ref: p.check_uuid };
      if (check.status === 'closed') return { ok: true, check_id: checkId, already: true };
      const totals = h.persistTotals(checkId);
      if (totals.balance > 0) return { ok: false, error: 'outstanding_balance', balance_cents: totals.balance };
      db.prepare("UPDATE checks SET status = 'closed', closed_at = ? WHERE id = ?").run(nowIso(), checkId);
      h.broadcastCheckUpdated(checkId);
      return { ok: true, check_id: checkId };
    }

    case 'table_state': {
      // Floor register: last-writer-wins by (lamport, device_id).
      if (!Number.isInteger(p.table_id)) return { ok: false, error: 'invalid_table_id' };
      const cur = db.prepare('SELECT lamport, device_id FROM lan_table_state WHERE table_id = ?').get(p.table_id);
      const wins = !cur || op.lamport > cur.lamport ||
        (op.lamport === cur.lamport && String(op.device_id) > String(cur.device_id));
      if (!wins) {
        return { ok: true, applied: false, conflict: true, current_lamport: cur.lamport };
      }
      db.prepare(`INSERT INTO lan_table_state(table_id, site_slug, state, lamport, device_id, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(table_id) DO UPDATE SET state = excluded.state, lamport = excluded.lamport,
          device_id = excluded.device_id, updated_at = excluded.updated_at`)
        .run(p.table_id, siteSlug, String(p.state || 'unknown'), op.lamport, String(op.device_id), nowIso());
      return { ok: true, applied: true, table_id: p.table_id, state: String(p.state || 'unknown') };
    }

    case 'menu_update': {
      // DESIGN.md §11: role gating at the brain; gossip replay is trusted
      // (the brain already enforced the manager gate; the stored envelope
      // is redacted so there is nothing left to re-verify).
      if (!viaGossip && (!actor || actor.role !== 'manager')) {
        return { ok: false, error: 'manager_role_required' };
      }
      const cur = db.prepare('SELECT id, name, price_cents, version FROM menu_items WHERE id = ? AND site_id = ?').get(p.item_id, siteSlug);
      if (!cur) return { ok: false, error: 'menu_item_not_found', item_id: p.item_id };
      const curVer = cur.version || 1;
      if (p.version !== curVer + 1) {
        return { ok: false, conflict: true, error: 'stale_version', current_version: curVer };
      }
      const name = typeof p.name === 'string' && p.name.trim() ? p.name.trim() : cur.name;
      const price = Number.isInteger(p.price_cents) && p.price_cents >= 0 ? p.price_cents : cur.price_cents;
      db.prepare('UPDATE menu_items SET name = ?, price_cents = ?, version = ? WHERE id = ?')
        .run(name, price, p.version, cur.id);
      h.auditMenu({ user: actor }, 'item.update', { item_id: cur.id }, { name, price_cents: price, via: 'sync_batch', version: p.version });
      h.broadcastMenuUpdated();
      return { ok: true, item_id: cur.id, version: p.version };
    }

    default:
      return { ok: false, error: 'unknown_op', op: op.op };
  }
}

/* Apply an inbound batch. Sorts by (lamport, seq, device_id) for causal
 * order, merges remote clocks, enforces site isolation (hard reject on ANY
 * foreign site_slug — treated as a config bug, never retried elsewhere),
 * and records every op in lan_processed_ops + lan_op_log. */
/* Apply an inbound batch. Sorts by (lamport, seq, device_id) for causal
 * order, merges remote clocks, enforces site isolation (hard reject on ANY
 * foreign site_slug — treated as a config bug, never retried elsewhere),
 * and records every op in lan_processed_ops + lan_op_log.
 *
 * opts.viaGossip: the ops were already authorized by the brain that
 * applied them — per-op manager/role gates are skipped on re-application.
 *
 * Exactly-once: applyOp runs inside a transaction; if it throws OR returns
 * {ok:false} the transaction is ROLLED BACK. Only successfully applied ops
 * are appended to lan_op_log / lan_wan_queue. Every op (success or not)
 * is recorded in lan_processed_ops so replays return the cached result.
 *
 * DESIGN.md §11: no raw PINs or credential material in the log — the
 * stored envelope redacts manager_pin before persistence. */
function receiveBatch(db, h, siteSlug, actor, ops, opts) {
  if (!Array.isArray(ops)) return { ok: false, error: 'batch_must_be_array' };
  for (const o of ops) {
    if (!o || typeof o !== 'object') return { ok: false, error: 'bad_envelope' };
    if (!o.op_id || !SUPPORTED_OPS.has(o.op)) {
      // Unknown ops fail individually (forward-compat), but a batch with
      // no valid identity at all is rejected outright.
      if (!o.op_id) return { ok: false, error: 'op_id_required' };
    }
    if (o.site_slug !== siteSlug) {
      return { ok: false, error: 'site_mismatch', expected_site: siteSlug, got_site: o.site_slug };
    }
  }
  const ordered = [...ops].sort((a, b) =>
    ((a.lamport | 0) - (b.lamport | 0)) || ((a.seq | 0) - (b.seq | 0)) ||
    String(a.device_id).localeCompare(String(b.device_id)));
  const results = [];
  const getCached = db.prepare('SELECT result_json FROM lan_processed_ops WHERE op_id = ?');
  const putCached = db.prepare(
    'INSERT OR IGNORE INTO lan_processed_ops(op_id, site_slug, op, result_json, applied_at) VALUES (?, ?, ?, ?, ?)');
  const putLog = db.prepare(
    'INSERT OR IGNORE INTO lan_op_log(op_id, lamport, seq, device_id, envelope_json) VALUES (?, ?, ?, ?, ?)');
  const putWan = db.prepare(
    'INSERT OR IGNORE INTO lan_wan_queue(op_id, envelope_json, queued_at) VALUES (?, ?, ?)');
  for (const op of ordered) {
    tick(db, op.lamport | 0); // merge remote clock
    const cached = getCached.get(op.op_id);
    if (cached) {
      results.push(Object.assign({ op_id: op.op_id, replayed: true }, JSON.parse(cached.result_json)));
      continue;
    }
    let result;
    let failed = false;
    try {
      // One transaction per op: apply + idempotency record + log append
      // commit ATOMICALLY. The COMMIT is the single durability point, so a
      // crash can never leave an op applied-but-unrecorded (which would
      // double-apply on retry) or recorded-but-unapplied. Declined ops
      // (ok:false) roll back any partial writes; their declines are NOT
      // cached, so a retry re-executes cleanly (all decline paths are
      // write-free by construction, so re-execution is deterministic).
      db.exec('BEGIN');
      result = applyOp(db, h, siteSlug, actor, op, opts);
      if (result && result.ok === false) failed = true;
      result = Object.assign({ op_id: op.op_id }, result);
      if (!failed) {
        putCached.run(op.op_id, siteSlug, op.op, JSON.stringify(result), nowIso());
        const payload = typeof op.payload === 'string' ? JSON.parse(op.payload) : op.payload;
        // Never persist credential material: strip the raw manager PIN.
        const storedPayload = (payload && typeof payload === 'object' && !Array.isArray(payload))
          ? Object.assign({}, payload) : payload;
        if (storedPayload && storedPayload.manager_pin !== undefined) delete storedPayload.manager_pin;
        const envelope = {
          op_id: op.op_id, site_slug: op.site_slug, device_id: op.device_id,
          actor_id: op.actor_id ?? null, seq: op.seq | 0, lamport: op.lamport | 0,
          op: op.op, payload: storedPayload,
          created_at: op.created_at,
        };
        putLog.run(op.op_id, op.lamport | 0, op.seq | 0, String(op.device_id), JSON.stringify(envelope));
        putWan.run(op.op_id, JSON.stringify(envelope), nowIso());
      }
      db.exec(failed ? 'ROLLBACK' : 'COMMIT');
    } catch (e) {
      failed = true;
      try { db.exec('ROLLBACK'); } catch (_) { /* already rolled back */ }
      result = { op_id: op.op_id, ok: false, error: 'apply_failed', detail: String((e && e.message) || e) };
    }
    results.push(result);
  }
  return { ok: true, results };
}

/* Log replication (gossip): export slices of the op log; import is just
 * receiveBatch, so re-gossiping is idempotent by construction. */
function exportLog(db, sinceLamport = 0, limit = 5000) {
  return db.prepare('SELECT envelope_json FROM lan_op_log WHERE lamport > ? ORDER BY lamport, seq LIMIT ?')
    .all(sinceLamport | 0, limit | 0).map((r) => JSON.parse(r.envelope_json));
}
function maxLamport(db) {
  const r = db.prepare('SELECT MAX(lamport) AS m FROM lan_op_log').get();
  return r && r.m ? r.m : 0;
}
function logLength(db) {
  return db.prepare('SELECT COUNT(*) AS n FROM lan_op_log').get().n;
}
/* All op_ids in the local log — used by the anti-entropy reconcile loop. */
function opIds(db) {
  return db.prepare('SELECT op_id FROM lan_op_log').all().map((r) => r.op_id);
}
/* Envelopes for an explicit set of op_ids (anti-entropy push/pull). */
function envelopesFor(db, ids) {
  if (!ids || !ids.length) return [];
  const rows = db.prepare(`SELECT envelope_json FROM lan_op_log WHERE op_id IN (${ids.map(() => '?').join(',')})`)
    .all(...ids);
  return rows.map((r) => JSON.parse(r.envelope_json));
}

module.exports = {
  SUPPORTED_OPS, migrate, lamport, tick, getKv, setKv,
  receiveBatch, exportLog, maxLamport, logLength, opIds, envelopesFor,
  resolveCheck, resolveItem,
};
