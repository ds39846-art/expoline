'use strict';
/* ============================================================================
 * Expoline — Phase 3A competitor-parity: order & check flow.
 *
 * Beats Toast / SpotOn / Square / Clover in the 7 missing categories from
 * parity-matrix sections A/B, with fewer taps and server-side role
 * enforcement everywhere. Money stays integer cents; every mutation goes
 * through persistTotals() and broadcasts so KDS/floor stay live.
 *
 *   1. Daypart menu switching — auto-switch by site clock, no manual tap.
 *   2. Table timers / turn-time tracking — actionable floor timers.
 *   3. Guest renaming on checks — seat-level names follow splits/merges.
 *   4. Edit fired orders — post-fire changes, manager-approved, KDS deltas.
 *   5. Tap-and-drop visual splitting — drag items between checks (uses the
 *      existing split 'move' mode; the UI is the new part).
 *   6. Merge parties — one tap, combined seat map preserved, no re-keying.
 *   7. Move checks between tables — KDS ticket headers update themselves.
 *
 * migrate(db): boot-time schema additions (guarded, idempotent).
 * register(app, ctx): mounts the endpoints. ctx carries the server.js
 *   helpers (db, SITE_ID, role guards, persistTotals, checkResponse, …).
 * copySeatNames(db, siteId, fromCheckId, pairs): seat-name carry for splits.
 * ========================================================================== */

const DEFAULT_DAYPARTS = [
  { name: 'LUNCH', start: '11:00', end: '16:00', also: ['BAR', 'KEIKI', 'DESSERTS'] },
  { name: 'HAPPY HOUR', start: '16:00', end: '18:00', also: ['BAR'], pricing: true },
  { name: 'DINNER', start: '18:00', end: '22:00', also: ['BAR', 'DESSERTS'] },
];
const ALWAYS_VISIBLE_DAYPARTS = new Set(['BAR', 'ALL DAY']);

function migrate(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS check_seats (
    id INTEGER PRIMARY KEY,
    site_id TEXT,
    check_id INTEGER,
    seat INTEGER,
    guest_name TEXT,
    created_at TEXT,
    UNIQUE(site_id, check_id, seat)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS item_edits (
    id INTEGER PRIMARY KEY,
    site_id TEXT,
    check_id INTEGER,
    item_id INTEGER,
    actor TEXT,
    action TEXT,
    before_json TEXT,
    after_json TEXT,
    manager_id INTEGER,
    manager_name TEXT,
    created_at TEXT
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_check_seats_check ON check_seats(site_id, check_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_item_edits_item ON item_edits(site_id, item_id)`);
  const kcols = new Set(db.prepare('PRAGMA table_info(kds_tickets)').all().map((c) => c.name));
  if (!kcols.has('deltas_json')) db.exec("ALTER TABLE kds_tickets ADD COLUMN deltas_json TEXT DEFAULT '[]'");
  const ccols = new Set(db.prepare('PRAGMA table_info(checks)').all().map((c) => c.name));
  if (!ccols.has('merged_from_json')) db.exec('ALTER TABLE checks ADD COLUMN merged_from_json TEXT');
  /* --- Toast/SpotOn flow parity (P0): per-line notes/allergy, item discounts --- */
  const icols = new Set(db.prepare('PRAGMA table_info(check_items)').all().map((c) => c.name));
  for (const [col, ddl] of [
    ['note', 'TEXT'],
    ['allergy', 'INTEGER DEFAULT 0'],
    ['allergy_detail', 'TEXT'],
    ['discount_cents', 'INTEGER DEFAULT 0'],
    ['discount_reason', 'TEXT'],
  ]) if (!icols.has(col)) db.exec(`ALTER TABLE check_items ADD COLUMN ${col} ${ddl}`);
  /* --- P0-6: modifier groups (required/min/max/nested/defaults) --- */
  db.exec(`CREATE TABLE IF NOT EXISTS menu_modifier_groups (
    id INTEGER PRIMARY KEY, site_id TEXT, menu_item_id INTEGER, name TEXT,
    min_select INTEGER DEFAULT 0, max_select INTEGER DEFAULT 0,
    required INTEGER DEFAULT 0, parent_group_id INTEGER, parent_option_id INTEGER,
    sort_order INTEGER DEFAULT 0)`);
  db.exec(`CREATE TABLE IF NOT EXISTS menu_modifier_options (
    id INTEGER PRIMARY KEY, group_id INTEGER, name TEXT,
    price_delta_cents INTEGER DEFAULT 0, is_default INTEGER DEFAULT 0,
    active INTEGER DEFAULT 1, sort_order INTEGER DEFAULT 0)`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_mod_groups_item ON menu_modifier_groups(site_id, menu_item_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_mod_opts_group ON menu_modifier_options(group_id)');
  // Migrate legacy flat menu_modifiers into one default group per item (idempotent).
  try {
    const grouped = new Set(db.prepare('SELECT menu_item_id FROM menu_modifier_groups').all().map((r) => r.menu_item_id));
    const legacy = db.prepare(`SELECT mm.item_id, mm.name, mm.price_delta_cents, mi.site_id
      FROM menu_modifiers mm JOIN menu_items mi ON mi.id = mm.item_id`).all();
    const byItem = new Map();
    for (const m of legacy) {
      if (grouped.has(m.item_id)) continue;
      if (!byItem.has(m.item_id)) byItem.set(m.item_id, { site_id: m.site_id, opts: [] });
      byItem.get(m.item_id).opts.push(m);
    }
    for (const [itemId, g] of byItem) {
      const r = db.prepare('INSERT INTO menu_modifier_groups (site_id, menu_item_id, name, sort_order) VALUES (?, ?, ?, 0)')
        .run(g.site_id, itemId, 'Options');
      const ins = db.prepare('INSERT INTO menu_modifier_options (group_id, name, price_delta_cents, sort_order) VALUES (?, ?, ?, ?)');
      g.opts.forEach((o, i) => ins.run(r.lastInsertRowid, o.name, o.price_delta_cents || 0, i));
    }
  } catch { /* menu tables may not exist on exotic DBs */ }
  /* --- P0-7: per-check coursing mode (off|optional|required) --- */
  const chcols = new Set(db.prepare('PRAGMA table_info(checks)').all().map((c) => c.name));
  if (!chcols.has('coursing')) db.exec("ALTER TABLE checks ADD COLUMN coursing TEXT DEFAULT 'off'");
  /* --- P1-3: split permission (Toast 1.20 model; manager PIN fallback) --- */
  const ucols = new Set(db.prepare('PRAGMA table_info(users)').all().map((c) => c.name));
  if (!ucols.has('split_allowed')) db.exec('ALTER TABLE users ADD COLUMN split_allowed INTEGER DEFAULT 1');
  /* --- NG-E: order-level notes (SpotOn V3 1:55 — "add notes to the entire order") --- */
  const chcols2 = new Set(db.prepare('PRAGMA table_info(checks)').all().map((c) => c.name));
  if (!chcols2.has('order_note')) db.exec('ALTER TABLE checks ADD COLUMN order_note TEXT');
  /* --- NG-D: quick-pick / popular-item flag (SpotOn V3 1:05 quick buttons) --- */
  try {
    const micols = new Set(db.prepare('PRAGMA table_info(menu_items)').all().map((c) => c.name));
    if (!micols.has('popular')) db.exec('ALTER TABLE menu_items ADD COLUMN popular INTEGER DEFAULT 0');
  } catch { /* menu tables may not exist on exotic DBs */ }
  /* --- NG-B: full-check void needs 'void' in the checks.status CHECK --- */
  widenChecksStatusVoid(db);
}

/* Rebuild the checks table once so status accepts 'void' (SQLite cannot ALTER
 * a CHECK constraint). Copies every existing column generically, so later
 * ADD COLUMN migrations stay intact. Idempotent: no-op once 'void' is present. */
function widenChecksStatusVoid(db) {
  let sql = null;
  try { sql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'checks'").get().sql; } catch { return; }
  if (!sql || sql.includes("'void'")) return;
  const cols = db.prepare('PRAGMA table_info(checks)').all();
  if (!cols.length) return;
  const defs = cols.map((c) => {
    if (c.name === 'status') return '"status" TEXT DEFAULT \'open\' CHECK(status IN (\'open\',\'paid\',\'closed\',\'void\'))';
    let d = `"${c.name}" ${c.type}`;
    if (c.pk) d += ' PRIMARY KEY';
    if (c.notnull) d += ' NOT NULL';
    if (c.dflt_value !== null && c.dflt_value !== undefined) d += ' DEFAULT ' + c.dflt_value;
    return d;
  });
  const idx = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'checks' AND sql IS NOT NULL").all().map((r) => r.sql);
  const names = cols.map((c) => `"${c.name}"`).join(', ');
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN');
    db.exec(`CREATE TABLE checks_new (${defs.join(', ')})`);
    db.exec(`INSERT INTO checks_new (${names}) SELECT ${names} FROM checks`);
    db.exec('DROP TABLE checks');
    db.exec('ALTER TABLE checks_new RENAME TO checks');
    for (const s of idx) db.exec(s);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  }
  db.exec('PRAGMA foreign_keys = ON');
}

/** Seat names carried when items move between checks (splits/merges).
 *  moves: [{ check_id, from_seat, to_seat }] — copies the guest name from
 *  from_seat on fromCheckId onto to_seat of the target check. Splits keep
 *  seat numbers (from == to); merges remap them by the guest-count offset. */
function copySeatNames(db, siteId, fromCheckId, moves, createdAt) {
  const get = db.prepare('SELECT seat, guest_name FROM check_seats WHERE site_id = ? AND check_id = ? AND seat = ?');
  const put = db.prepare(`INSERT INTO check_seats (site_id, check_id, seat, guest_name, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(site_id, check_id, seat) DO UPDATE SET guest_name = excluded.guest_name`);
  for (const m of moves || []) {
    const row = get.get(siteId, fromCheckId, m.from_seat);
    if (row && row.guest_name) put.run(siteId, m.check_id, m.to_seat, row.guest_name, createdAt);
  }
}

function getSeatNames(db, siteId, checkId) {
  const rows = db.prepare('SELECT seat, guest_name FROM check_seats WHERE site_id = ? AND check_id = ?').all(siteId, checkId);
  const m = {};
  for (const r of rows) m[r.seat] = r.guest_name;
  return m;
}

/* ------------------------------- dayparts -------------------------------- */

function validHHMM(v) {
  return typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
}

function getDayparts(db, siteId) {
  const row = db.prepare("SELECT value FROM site_config WHERE site_id = ? AND key = 'dayparts_json'").get(siteId);
  if (!row) {
    db.prepare("INSERT OR IGNORE INTO site_config (site_id, key, value) VALUES (?, 'dayparts_json', ?)")
      .run(siteId, JSON.stringify(DEFAULT_DAYPARTS));
    return DEFAULT_DAYPARTS.map((d) => ({ ...d }));
  }
  try {
    const arr = JSON.parse(row.value);
    if (Array.isArray(arr) && arr.length) return arr;
  } catch { /* fall through to default */ }
  return DEFAULT_DAYPARTS.map((d) => ({ ...d }));
}

function hhmmInWindow(hhmm, w) {
  // Overnight windows (end <= start) wrap past midnight.
  if (w.end > w.start) return hhmm >= w.start && hhmm < w.end;
  return hhmm >= w.start || hhmm < w.end;
}

/** Current daypart window for a timestamp (ms), in the site timezone. */
function currentDaypart(schedule, nowMs, tz) {
  const hhmm = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(nowMs));
  for (const w of schedule) {
    if (validHHMM(w.start) && validHHMM(w.end) && hhmmInWindow(hhmm, w)) return w;
  }
  return null;
}

/** Item visibility rule: all-day items (blank daypart) and BAR / ALL DAY
 *  items are always visible; otherwise the item shows when its daypart — or
 *  one of the window's `also` categories — matches the current window name. */
function itemVisibleInWindow(itemDaypart, windowName, also) {
  const dp = (itemDaypart || '').trim().toUpperCase();
  if (!dp || ALWAYS_VISIBLE_DAYPARTS.has(dp)) return true;
  if (!windowName) return true;
  const w = String(windowName).toUpperCase();
  if (dp === w) return true;
  return (also || []).some((a) => String(a).toUpperCase() === w);
}

function register(app, ctx) {
  const { db, SITE_ID, SITE_TZ, gateAdminMenu, gateSiteAdmin, serverPlus, nowIso, crypto,
    persistTotals, checkResponse, itemView, ticketView, broadcastCheckUpdated,
    broadcastTicketUpdated, auditApproval, getConfig, parseJson, isInt,
    withTransaction, verifyManagerPin, cleanLabel, validateModifiers,
    actorName } = ctx;

  /* ------------------------- 1. daypart switching ------------------------- */
  app.get('/api/dayparts', serverPlus(), (req, res) => {
    const schedule = getDayparts(db, SITE_ID);
    const nowMs = Date.now();
    const cur = currentDaypart(schedule, nowMs, SITE_TZ);
    res.json({ tz: SITE_TZ, schedule, now: new Date(nowMs).toISOString(), current: cur ? cur.name : null });
  });
  app.get('/api/admin/dayparts', gateSiteAdmin(), (req, res) => {
    res.json({ tz: SITE_TZ, schedule: getDayparts(db, SITE_ID) });
  });
  app.put('/api/admin/dayparts', gateSiteAdmin(), (req, res) => {
    const schedule = (req.body || {}).schedule;
    if (!Array.isArray(schedule) || !schedule.length) {
      return res.status(400).json({ error: 'schedule must be a non-empty array of windows' });
    }
    for (const w of schedule) {
      if (!w || typeof w.name !== 'string' || !w.name.trim()) {
        return res.status(400).json({ error: 'Each window needs a name' });
      }
      if (!validHHMM(w.start) || !validHHMM(w.end)) {
        return res.status(400).json({ error: `Window "${w.name}": start/end must be HH:MM (24h)` });
      }
    }
    const clean = schedule.map((w) => ({
      name: w.name.trim().slice(0, 40), start: w.start, end: w.end,
      also: Array.isArray(w.also) ? w.also.map((a) => String(a).slice(0, 40)).slice(0, 12) : [],
      // pricing:true marks a happy-hour pricing window (items with an
      // hh_price_cents charge it while the window is current). Preserved
      // only when literally true so stored schedules stay clean.
      ...(w.pricing === true ? { pricing: true } : {}),
    }));
    db.prepare("INSERT INTO site_config (site_id, key, value) VALUES (?, 'dayparts_json', ?) ON CONFLICT(site_id, key) DO UPDATE SET value = excluded.value")
      .run(SITE_ID, JSON.stringify(clean));
    res.json({ tz: SITE_TZ, schedule: clean });
  });

  /* --------------------- 2. floor timers / turn times --------------------- */
  function getFloorConfig() {
    const row = db.prepare("SELECT value FROM site_config WHERE site_id = ? AND key = 'floor_config_json'").get(SITE_ID);
    try {
      const v = row ? JSON.parse(row.value) : null;
      if (v && isInt(v.turn_time_target_min)) return { turn_time_target_min: v.turn_time_target_min };
    } catch { /* fall through to default */ }
    return { turn_time_target_min: 90 };
  }
  function turnStatus(elapsedMin, targetMin) {
    if (elapsedMin >= targetMin) return 'over';
    if (elapsedMin >= targetMin - 30) return 'watch';
    return 'ok';
  }
  function parseOpenedAt(v) {
    const s = String(v || '');
    if (!s) return NaN;
    return Date.parse(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
  }
  app.get('/api/floor/timers', serverPlus(), (req, res) => {
    const cfg = getFloorConfig();
    const nowMs = Date.now();
    const rows = db.prepare(
      `SELECT c.id AS check_id, c.table_id, c.guest_count, c.opened_at, c.tab_name, t.label AS table_label
       FROM checks c LEFT JOIN tables t ON t.id = c.table_id
       WHERE c.site_id = ? AND c.status = 'open' ORDER BY c.opened_at`
    ).all(SITE_ID);
    res.json({
      turn_time_target_min: cfg.turn_time_target_min,
      tables: rows.map((r) => {
        const openedMs = parseOpenedAt(r.opened_at);
        const elapsedMin = Math.max(0, Math.floor((nowMs - (Number.isFinite(openedMs) ? openedMs : nowMs)) / 60000));
        return {
          check_id: r.check_id, table_id: r.table_id, table_label: r.table_label,
          tab_name: r.tab_name, guest_count: r.guest_count,
          elapsed_min: elapsedMin, turn_status: turnStatus(elapsedMin, cfg.turn_time_target_min),
        };
      }),
    });
  });
  app.get('/api/admin/floor/config', gateSiteAdmin(), (req, res) => {
    res.json(getFloorConfig());
  });
  app.put('/api/admin/floor/config', gateSiteAdmin(), (req, res) => {
    const target = (req.body || {}).turn_time_target_min;
    if (!isInt(target) || target < 15 || target > 480) {
      return res.status(400).json({ error: 'turn_time_target_min must be an integer between 15 and 480' });
    }
    db.prepare("INSERT INTO site_config (site_id, key, value) VALUES (?, 'floor_config_json', ?) ON CONFLICT(site_id, key) DO UPDATE SET value = excluded.value")
      .run(SITE_ID, JSON.stringify({ turn_time_target_min: target }));
    res.json({ turn_time_target_min: target });
  });

  /* -------------------------- 3. guest seat names ------------------------- */
  app.put('/api/checks/:id/seats/:seat/name', serverPlus(), (req, res) => {
    const check = db.prepare('SELECT * FROM checks WHERE id = ? AND site_id = ?').get(req.params.id, SITE_ID);
    if (!check) return res.status(404).json({ error: 'Check not found' });
    if (check.status !== 'open') return res.status(400).json({ error: `Cannot rename seats on a ${check.status} check` });
    const seat = Number(req.params.seat);
    if (!isInt(seat) || seat < 1 || seat > check.guest_count) {
      return res.status(400).json({ error: `seat must be an integer between 1 and ${check.guest_count}` });
    }
    const raw = (req.body || {}).name;
    const name = typeof raw === 'string' ? raw.trim() : '';
    if (name.length > 40) return res.status(400).json({ error: 'Guest name must be 40 characters or fewer' });
    if (!name) {
      db.prepare('DELETE FROM check_seats WHERE site_id = ? AND check_id = ? AND seat = ?').run(SITE_ID, check.id, seat);
    } else {
      db.prepare(`INSERT INTO check_seats (site_id, check_id, seat, guest_name, created_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(site_id, check_id, seat) DO UPDATE SET guest_name = excluded.guest_name`)
        .run(SITE_ID, check.id, seat, name, nowIso());
    }
    broadcastCheckUpdated(check.id);
    res.json({ check_id: check.id, seat, seat_names: getSeatNames(db, SITE_ID, check.id) });
  });

  /* NOTE: PATCH /api/checks/:id/items/:item_id lives in server.js (Daniel's
     hotfix, extended in Phase 3A with seat/course/note/allergy + KDS deltas).
     It was removed from this module to avoid a duplicate route. */

  /* NOTE: POST /api/checks/:id/split lives in server.js (the original endpoint,
     registered first). It was extended in Phase 3A with max-seat guest_count,
     the split permission + manager-PIN fallback, and qty division. The duplicate
     route that was here has been removed to avoid shadowing confusion. */



  /* ------------- P0-6: modifier group admin (manager only) -------------- */
  function getMenuItem(id) {
    return db.prepare('SELECT * FROM menu_items WHERE id = ? AND site_id = ?').get(id, SITE_ID);
  }
  function groupJson(g) {
    const opts = db.prepare('SELECT * FROM menu_modifier_options WHERE group_id = ? ORDER BY sort_order, id').all(g.id);
    return {
      id: g.id, menu_item_id: g.menu_item_id, name: g.name,
      min_select: g.min_select, max_select: g.max_select, required: !!g.required,
      parent_group_id: g.parent_group_id, parent_option_id: g.parent_option_id,
      sort_order: g.sort_order,
      options: opts.map((o) => ({ id: o.id, name: o.name, price_delta_cents: o.price_delta_cents,
        is_default: !!o.is_default, active: !!o.active, sort_order: o.sort_order })),
    };
  }
  app.get('/api/admin/menu/items/:id/modifier-groups', gateAdminMenu(), (req, res) => {
    const item = getMenuItem(req.params.id);
    if (!item) return res.status(404).json({ error: 'Menu item not found' });
    const groups = db.prepare('SELECT * FROM menu_modifier_groups WHERE site_id = ? AND menu_item_id = ? ORDER BY sort_order, id')
      .all(SITE_ID, item.id);
    res.json({ item_id: item.id, groups: groups.map(groupJson) });
  });
  app.post('/api/admin/menu/items/:id/modifier-groups', gateAdminMenu(), (req, res) => {
    const item = getMenuItem(req.params.id);
    if (!item) return res.status(404).json({ error: 'Menu item not found' });
    const b = req.body || {};
    const name = typeof b.name === 'string' ? b.name.trim().slice(0, 60) : '';
    if (!name) return res.status(400).json({ error: 'name is required' });
    for (const k of ['min_select', 'max_select']) {
      if (b[k] !== undefined && (!isInt(b[k]) || b[k] < 0)) {
        return res.status(400).json({ error: `${k} must be a non-negative integer` });
      }
    }
    const minS = b.min_select || 0, maxS = b.max_select || 0;
    if (maxS > 0 && maxS < minS) return res.status(400).json({ error: 'max_select cannot be less than min_select' });
    let parentGroupId = null, parentOptionId = null;
    if (b.parent_option_id != null) {
      const po = db.prepare(`SELECT o.id, o.group_id FROM menu_modifier_options o
        JOIN menu_modifier_groups g ON g.id = o.group_id
        WHERE o.id = ? AND g.site_id = ? AND g.menu_item_id = ?`).get(b.parent_option_id, SITE_ID, item.id);
      if (!po) return res.status(400).json({ error: 'parent_option_id must be an option of this item' });
      parentGroupId = po.group_id; parentOptionId = po.id;
    }
    const r = db.prepare(`INSERT INTO menu_modifier_groups
      (site_id, menu_item_id, name, min_select, max_select, required, parent_group_id, parent_option_id, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(SITE_ID, item.id, name, minS, maxS, b.required ? 1 : 0, parentGroupId, parentOptionId, b.sort_order || 0);
    const g = db.prepare('SELECT * FROM menu_modifier_groups WHERE id = ?').get(r.lastInsertRowid);
    res.status(201).json(groupJson(g));
  });
  app.put('/api/admin/menu/modifier-groups/:groupId', gateAdminMenu(), (req, res) => {
    const g = db.prepare('SELECT * FROM menu_modifier_groups WHERE id = ? AND site_id = ?').get(req.params.groupId, SITE_ID);
    if (!g) return res.status(404).json({ error: 'Modifier group not found' });
    const b = req.body || {};
    const patch = {};
    if (b.name !== undefined) {
      const n = typeof b.name === 'string' ? b.name.trim().slice(0, 60) : '';
      if (!n) return res.status(400).json({ error: 'name cannot be empty' });
      patch.name = n;
    }
    for (const k of ['min_select', 'max_select']) {
      if (b[k] !== undefined) {
        if (!isInt(b[k]) || b[k] < 0) return res.status(400).json({ error: `${k} must be a non-negative integer` });
        patch[k] = b[k];
      }
    }
    const minS = patch.min_select !== undefined ? patch.min_select : g.min_select;
    const maxS = patch.max_select !== undefined ? patch.max_select : g.max_select;
    if (maxS > 0 && maxS < minS) return res.status(400).json({ error: 'max_select cannot be less than min_select' });
    if (b.required !== undefined) patch.required = b.required ? 1 : 0;
    if (b.sort_order !== undefined) patch.sort_order = b.sort_order || 0;
    if (b.parent_option_id !== undefined) {
      if (b.parent_option_id === null) { patch.parent_group_id = null; patch.parent_option_id = null; }
      else {
        const po = db.prepare(`SELECT o.id, o.group_id FROM menu_modifier_options o
          JOIN menu_modifier_groups g ON g.id = o.group_id
          WHERE o.id = ? AND g.site_id = ? AND g.menu_item_id = ? AND g.id != ?`)
          .get(b.parent_option_id, SITE_ID, g.menu_item_id, g.id);
        if (!po) return res.status(400).json({ error: 'parent_option_id must be an option of this item (and not in this group)' });
        patch.parent_group_id = po.group_id; patch.parent_option_id = po.id;
      }
    }
    if (Object.keys(patch).length) {
      db.prepare(`UPDATE menu_modifier_groups SET ${Object.keys(patch).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
        .run(...Object.values(patch), g.id);
    }
    res.json(groupJson(db.prepare('SELECT * FROM menu_modifier_groups WHERE id = ?').get(g.id)));
  });
  app.delete('/api/admin/menu/modifier-groups/:groupId', gateAdminMenu(), (req, res) => {
    const g = db.prepare('SELECT * FROM menu_modifier_groups WHERE id = ? AND site_id = ?').get(req.params.groupId, SITE_ID);
    if (!g) return res.status(404).json({ error: 'Modifier group not found' });
    withTransaction(() => {
      // Nested groups anchored to this group's options become top-level.
      db.prepare('UPDATE menu_modifier_groups SET parent_group_id = NULL, parent_option_id = NULL WHERE parent_group_id = ?').run(g.id);
      db.prepare('DELETE FROM menu_modifier_options WHERE group_id = ?').run(g.id);
      db.prepare('DELETE FROM menu_modifier_groups WHERE id = ?').run(g.id);
    });
    res.json({ deleted: g.id });
  });
  app.post('/api/admin/menu/modifier-groups/:groupId/options', gateAdminMenu(), (req, res) => {
    const g = db.prepare('SELECT * FROM menu_modifier_groups WHERE id = ? AND site_id = ?').get(req.params.groupId, SITE_ID);
    if (!g) return res.status(404).json({ error: 'Modifier group not found' });
    const b = req.body || {};
    const name = typeof b.name === 'string' ? b.name.trim().slice(0, 80) : '';
    if (!name) return res.status(400).json({ error: 'name is required' });
    if (b.price_delta_cents !== undefined && !isInt(b.price_delta_cents)) {
      return res.status(400).json({ error: 'price_delta_cents must be an integer' });
    }
    const r = db.prepare(`INSERT INTO menu_modifier_options
      (group_id, name, price_delta_cents, is_default, active, sort_order) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(g.id, name, b.price_delta_cents || 0, b.is_default ? 1 : 0, b.active === false ? 0 : 1, b.sort_order || 0);
    const o = db.prepare('SELECT * FROM menu_modifier_options WHERE id = ?').get(r.lastInsertRowid);
    res.status(201).json({ id: o.id, name: o.name, price_delta_cents: o.price_delta_cents,
      is_default: !!o.is_default, active: !!o.active, sort_order: o.sort_order });
  });
  app.put('/api/admin/menu/modifier-options/:optionId', gateAdminMenu(), (req, res) => {
    const o = db.prepare(`SELECT o.* FROM menu_modifier_options o
      JOIN menu_modifier_groups g ON g.id = o.group_id WHERE o.id = ? AND g.site_id = ?`).get(req.params.optionId, SITE_ID);
    if (!o) return res.status(404).json({ error: 'Modifier option not found' });
    const b = req.body || {};
    const patch = {};
    if (b.name !== undefined) {
      const n = typeof b.name === 'string' ? b.name.trim().slice(0, 80) : '';
      if (!n) return res.status(400).json({ error: 'name cannot be empty' });
      patch.name = n;
    }
    if (b.price_delta_cents !== undefined) {
      if (!isInt(b.price_delta_cents)) return res.status(400).json({ error: 'price_delta_cents must be an integer' });
      patch.price_delta_cents = b.price_delta_cents;
    }
    if (b.is_default !== undefined) patch.is_default = b.is_default ? 1 : 0;
    // 86 a modifier: active=false blocks it at order time (server-enforced).
    if (b.active !== undefined) patch.active = b.active ? 1 : 0;
    if (b.sort_order !== undefined) patch.sort_order = b.sort_order || 0;
    if (Object.keys(patch).length) {
      db.prepare(`UPDATE menu_modifier_options SET ${Object.keys(patch).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
        .run(...Object.values(patch), o.id);
    }
    const u = db.prepare('SELECT * FROM menu_modifier_options WHERE id = ?').get(o.id);
    res.json({ id: u.id, name: u.name, price_delta_cents: u.price_delta_cents,
      is_default: !!u.is_default, active: !!u.active, sort_order: u.sort_order });
  });
  app.delete('/api/admin/menu/modifier-options/:optionId', gateAdminMenu(), (req, res) => {
    const o = db.prepare(`SELECT o.* FROM menu_modifier_options o
      JOIN menu_modifier_groups g ON g.id = o.group_id WHERE o.id = ? AND g.site_id = ?`).get(req.params.optionId, SITE_ID);
    if (!o) return res.status(404).json({ error: 'Modifier option not found' });
    withTransaction(() => {
      db.prepare('UPDATE menu_modifier_groups SET parent_group_id = NULL, parent_option_id = NULL WHERE parent_option_id = ?').run(o.id);
      db.prepare('DELETE FROM menu_modifier_options WHERE id = ?').run(o.id);
    });
    res.json({ deleted: o.id });
  });

  /* ---------------------------- 6. merge parties -------------------------- */
  app.post('/api/checks/:id/merge', serverPlus(), (req, res) => {
    const b = req.body || {};
    const target = db.prepare('SELECT * FROM checks WHERE id = ? AND site_id = ?').get(req.params.id, SITE_ID);
    if (!target) return res.status(404).json({ error: 'Check not found' });
    if (target.status !== 'open') return res.status(400).json({ error: `Cannot merge into a ${target.status} check` });
    const sourceIds = b.source_check_ids;
    if (!Array.isArray(sourceIds) || sourceIds.length === 0 || !sourceIds.every((v) => isInt(v))) {
      return res.status(400).json({ error: 'source_check_ids must be a non-empty array of check ids' });
    }
    if (new Set(sourceIds).size !== sourceIds.length) {
      return res.status(400).json({ error: 'Duplicate source check ids' });
    }
    if (sourceIds.includes(target.id)) {
      return res.status(400).json({ error: 'A check cannot be merged into itself' });
    }
    const sources = [];
    for (const sid of sourceIds) {
      const s = db.prepare('SELECT * FROM checks WHERE id = ? AND site_id = ?').get(sid, SITE_ID);
      if (!s) return res.status(404).json({ error: `Source check ${sid} not found` });
      if (s.status !== 'open') return res.status(400).json({ error: `Source check ${sid} is ${s.status}, not open` });
      sources.push(s);
    }
    const all = [target, ...sources];
    const payCount = db.prepare(`SELECT COUNT(*) AS n FROM payments WHERE check_id IN (${all.map(() => '?').join(',')})`).get(...all.map((c) => c.id)).n;
    if (payCount > 0) return res.status(400).json({ error: 'Cannot merge checks that already have payments' });
    for (const c of all) {
      if ((c.service_charge_cents || 0) > 0) {
        return res.status(400).json({ error: `Check ${c.id} carries an 18% large-party service charge and cannot be merged` });
      }
    }
    const totalGuests = all.reduce((s, c) => s + (c.guest_count || 0), 0);
    if (totalGuests > 24) return res.status(400).json({ error: `Merged party of ${totalGuests} exceeds the 24-guest limit` });

    const now = nowIso();
    const before = all.map((c) => ({ id: c.id, table_id: c.table_id, guest_count: c.guest_count, tab_name: c.tab_name }));
    ctx.withTransaction(() => {
      let guestCount = target.guest_count;
      let tabName = target.tab_name;
      const moveItem = db.prepare('UPDATE check_items SET seat = ? WHERE id = ?');
      const itemStmt = db.prepare("SELECT id, seat FROM check_items WHERE check_id = ? AND state != 'cancelled'");
      for (const s of sources) {
        const offset = guestCount;
        for (const it of itemStmt.all(s.id)) {
          moveItem.run(it.seat + offset, it.id);
        }
        db.prepare('UPDATE check_items SET check_id = ? WHERE check_id = ?').run(target.id, s.id);
        // FIX: every named source seat moves — including guests with no items
        // yet — remapped by the guest-count offset.
        const namedSeats = db.prepare('SELECT seat FROM check_seats WHERE site_id = ? AND check_id = ?').all(SITE_ID, s.id);
        copySeatNames(db, SITE_ID, s.id,
          namedSeats.map((r) => ({ check_id: target.id, from_seat: r.seat, to_seat: r.seat + offset })), now);
        db.prepare('DELETE FROM check_seats WHERE site_id = ? AND check_id = ?').run(SITE_ID, s.id);
        guestCount += s.guest_count;
        if (!tabName && s.tab_name) tabName = s.tab_name;
        db.prepare("UPDATE checks SET status = 'closed', closed_at = ? WHERE id = ?").run(now, s.id);
        // Open KDS tickets from the absorbed checks re-point at the surviving table.
        const openTickets = db.prepare(
          "SELECT id FROM kds_tickets WHERE check_id = ? AND site_id = ? AND status IN ('new','in_progress')"
        ).all(s.id, SITE_ID);
        const targetLabel = db.prepare('SELECT label FROM tables WHERE id = ?').get(target.table_id);
        for (const t of openTickets) {
          db.prepare('UPDATE kds_tickets SET table_label = ? WHERE id = ?').run(targetLabel ? targetLabel.label : null, t.id);
          ctx.broadcastTicketUpdated(ctx.ticketView(db.prepare('SELECT * FROM kds_tickets WHERE id = ?').get(t.id)));
        }
      }
      const mergedFrom = parseJson(target.merged_from_json, []).concat(sources.map((s) => s.id));
      db.prepare('UPDATE checks SET guest_count = ?, tab_name = ?, merged_from_json = ? WHERE id = ?')
        .run(guestCount, tabName, JSON.stringify(mergedFrom), target.id);
      ctx.persistTotals(target.id);
    });
    ctx.persistTotals(target.id);
    ctx.broadcastCheckUpdated(target.id);
    for (const s of sources) ctx.broadcastCheckUpdated(s.id);
    ctx.auditApproval(req, 'merge_checks', { check_id: target.id },
      { before: { checks: before }, after: { merged_into: target.id, closed: sources.map((s) => s.id), guest_count: totalGuests } });
    res.json({ merged_into: target.id, closed: sources.map((s) => s.id), check: ctx.checkResponse(target.id) });
  });

  /* ------------------------ 7. move check to table ------------------------ */
  app.post('/api/checks/:id/move', serverPlus(), (req, res) => {
    const b = req.body || {};
    const check = db.prepare('SELECT * FROM checks WHERE id = ? AND site_id = ?').get(req.params.id, SITE_ID);
    if (!check) return res.status(404).json({ error: 'Check not found' });
    if (check.status !== 'open') return res.status(400).json({ error: `Cannot move a ${check.status} check` });
    /* A bar tab has no table to move FROM and must not silently become a
     * table check (its channel is its identity) — close the tab and open
     * a table check instead. */
    if (check.channel === 'bar_tab') return res.status(400).json({ error: 'A bar tab cannot be moved to a table — close the tab and open a table check' });
    const tableId = b.table_id;
    if (!isInt(tableId)) return res.status(400).json({ error: 'table_id is required' });
    const dest = db.prepare('SELECT id, label FROM tables WHERE id = ? AND site_id = ?').get(tableId, SITE_ID);
    if (!dest) return res.status(404).json({ error: 'Destination table not found' });
    if (dest.id === check.table_id) return res.status(400).json({ error: 'Check is already on that table' });
    const occupant = db.prepare("SELECT id FROM checks WHERE table_id = ? AND status = 'open' LIMIT 1").get(dest.id);
    if (occupant) return res.status(400).json({ error: `Table ${dest.label} already has an open check`, check_id: occupant.id });
    const payCount = db.prepare('SELECT COUNT(*) AS n FROM payments WHERE check_id = ?').get(check.id).n;
    if (payCount > 0) return res.status(400).json({ error: 'Cannot move a check that already has payments' });

    const fromLabel = db.prepare('SELECT label FROM tables WHERE id = ?').get(check.table_id);
    ctx.withTransaction(() => {
      db.prepare('UPDATE checks SET table_id = ? WHERE id = ?').run(dest.id, check.id);
      // KDS ticket headers update themselves — the line never has to ask.
      const tickets = db.prepare(
        "SELECT id FROM kds_tickets WHERE check_id = ? AND site_id = ? AND status IN ('new','in_progress')"
      ).all(check.id, SITE_ID);
      for (const t of tickets) {
        db.prepare('UPDATE kds_tickets SET table_label = ? WHERE id = ?').run(dest.label, t.id);
        ctx.broadcastTicketUpdated(ctx.ticketView(db.prepare('SELECT * FROM kds_tickets WHERE id = ?').get(t.id)));
      }
    });
    ctx.persistTotals(check.id);
    ctx.broadcastCheckUpdated(check.id);
    ctx.auditApproval(req, 'move_check', { check_id: check.id },
      { before: { table_id: check.table_id, table_label: fromLabel ? fromLabel.label : null },
        after: { table_id: dest.id, table_label: dest.label } });
    res.json({ check: ctx.checkResponse(check.id) });
  });
}

module.exports = { migrate, register, copySeatNames, getSeatNames, getDayparts, currentDaypart, itemVisibleInWindow, DEFAULT_DAYPARTS };
