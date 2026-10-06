#!/usr/bin/env node
/**
 * Extracted-REAL-function harness for test43 (offline field fidelity).
 *
 * The defect: a line held while OFFLINE is enqueued by the HOLD handler
 * WITH its note, allergy flag/detail, and ring-time course — but both
 * sync paths dropped all four before the kitchen ever saw them:
 *   P  flushOutboxLegacy built the POST /items body from only
 *      {menu_item_id, seat, qty, modifiers} (+ the idempotency key).
 *   Q  lanEnvelope mapped each queued line to only {item_uuid,
 *      menu_item_id, seat, qty, modifiers} for the sync batch.
 * (The third locus — lan/store.js never writing the columns — is
 * server-side and covered by test43's LAN API section over HTTP.)
 *
 * Conventions under test, mirrored from the online HOLD body:
 *   - a field the queued line CARRIES rides along, normalized the
 *     same way (note -> string|null, allergy -> boolean,
 *     allergy_detail -> string|null, course -> as-is);
 *   - a field the queued line does NOT carry stays ABSENT from the
 *     body/envelope, so pre-field queue entries post byte-identically
 *     to before — for course this is load-bearing: absent means the
 *     server applies the menu default, while an explicit null means
 *     no course at all, and the null must ride.
 *
 * Usage: node harness43_client.js [appJsPath]
 */
const fs = require('fs');
const vm = require('vm');

const APP_JS = process.argv[2] || __dirname + '/../public/app.js';
const appSrc = fs.readFileSync(APP_JS, 'utf8');

let failures = 0;
function ok(name, cond, extra) {
  if (cond) console.log('  ok  ' + name);
  else { failures++; console.log('  FAIL ' + name + (extra !== undefined ? ' — ' + extra : '')); }
}
function section(s) { console.log('\n' + s); }

/* ---------- extraction (balanced-brace, harness35/40/41/42 machinery) ---------- */
function scanBlock(src, start) {
  let i = src.indexOf('{', start), depth = 0, str = null, esc = false, tpl = 0;
  for (; i < src.length; i++) {
    const c = src[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (str) {
      if (str === '`' && c === '$' && src[i + 1] === '{') { tpl++; i++; continue; }
      if (str === '`' && c === '}' && tpl > 0) { tpl--; continue; }
      if (c === str && tpl === 0) str = null;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 1; continue; }
    if (c === '/' && src[i + 1] === '/') { const e = src.indexOf('\n', i + 2); i = e < 0 ? src.length : e; continue; }
    if (c === "'" || c === '"' || c === '`') { str = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error('unterminated block');
}
function extractFn(src, name) {
  let start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('function not found: ' + name);
  if (src.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;
  return scanBlock(src, start);
}

const apiErrorLine = appSrc.split('\n').find((l) => l.startsWith('class ApiError'));
if (!apiErrorLine) { console.log('ApiError class line not found'); process.exit(2); }

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/* ---------- fake world for the legacy flush ---------- */
function flushCtx(world) {
  const store = new Map();
  const ctx = {
    console,
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    location: { hash: '' },
    state: { route: null },
    toast: (m, k) => world.toasts.push({ msg: m, kind: k }),
    handleApiError: (e) => { throw e; },
    showSyncedBanner: () => {},
    updateOfflineBanner: () => {},
    renderRoute: () => {},
    Outbox: { remove: async (key) => { world.removed.push(key); } },
    rawApi: async (path, method, body) => {
      world.calls.push({ path, method, body });
      if (!/\/items$/.test(path)) throw new Error('unexpected path ' + path);
      const item = { id: world.nextId++, menu_item_id: body.menu_item_id };
      world.created.push(item);
      return { id: item.id };
    },
  };
  vm.createContext(ctx);
  vm.runInContext(apiErrorLine, ctx);
  vm.runInContext(extractFn(appSrc, 'loadIdMap'), ctx);
  vm.runInContext(extractFn(appSrc, 'saveIdMap'), ctx);
  vm.runInContext(extractFn(appSrc, 'flushOutboxLegacy'), ctx);
  return ctx;
}

function makeWorld() {
  return { created: [], calls: [], toasts: [], removed: [], nextId: 2000 };
}

const bodiesFor = (world, mid) =>
  world.calls.filter((c) => c.body && c.body.menu_item_id === mid).map((c) => c.body);

(async function main() {

/* =============== P: flushOutboxLegacy carries the four fields =============== */
section('P. flushOutboxLegacy — note / allergy / course ride the POST body');
{
  const world = makeWorld();
  const ctx = flushCtx(world);
  const op = { key: 'op-p', op: 'add_items', ts: 1, payload: { check_id: 555, items: [
    /* The QA-probe line: an Edamame carrying all four fields. */
    { temp_id: 'tmp-f1', menu_item_id: 32, name: 'Edamame', seat: 1, qty: 1,
      modifiers: [{ name: 'Sea Salt' }],
      note: 'no sauce', allergy: true, allergy_detail: 'soy', course: 'appetizer' },
    /* A pre-field queue entry: none of the four keys exist. */
    { temp_id: 'tmp-f2', menu_item_id: 6, name: 'Bali Fries', seat: 1, qty: 1, modifiers: [] },
    /* The plain-line shape the current HOLD enqueue writes when the
       server cleared the course: nulls and false are REAL values. */
    { temp_id: 'tmp-f3', menu_item_id: 6, name: 'Bali Fries', seat: 2, qty: 1, modifiers: [],
      note: null, allergy: false, allergy_detail: null, course: null },
    /* Mixed: a note but no course key at all. */
    { temp_id: 'tmp-f4', menu_item_id: 6, name: 'Bali Fries', seat: 2, qty: 2, modifiers: [],
      note: 'extra crispy' },
  ] } };
  const done = await ctx.flushOutboxLegacy([op]);
  ok('P0 the op completes', done === 1 && world.created.length === 4,
    'done=' + done + ' created=' + world.created.length);

  const eda = bodiesFor(world, 32)[0] || {};
  ok('P1 the full-field line posts note verbatim', eda.note === 'no sauce', JSON.stringify(eda));
  ok('P2 the full-field line posts allergy=true', eda.allergy === true, JSON.stringify(eda));
  ok('P3 the full-field line posts allergy_detail verbatim', eda.allergy_detail === 'soy',
    JSON.stringify(eda));
  ok('P4 the full-field line posts its ring-time course', eda.course === 'appetizer',
    JSON.stringify(eda));
  ok('P5 the idempotency key still rides (246efc0 preserved)',
    eda.idempotency_key === 'outbox-item-tmp-f1', JSON.stringify(eda));

  const bare = bodiesFor(world, 6).find((b) => b.seat === 1) || {};
  ok('P6 a pre-field line posts NO note/allergy/allergy_detail/course keys (byte-shape of today)',
    !has(bare, 'note') && !has(bare, 'allergy') && !has(bare, 'allergy_detail') && !has(bare, 'course'),
    JSON.stringify(bare));

  const nulls = bodiesFor(world, 6).find((b) => b.seat === 2 && b.qty === 1) || {};
  ok('P7 carried nulls ride as nulls (note, allergy_detail)',
    has(nulls, 'note') && nulls.note === null && has(nulls, 'allergy_detail') && nulls.allergy_detail === null,
    JSON.stringify(nulls));
  ok('P8 carried allergy=false rides as false', has(nulls, 'allergy') && nulls.allergy === false,
    JSON.stringify(nulls));
  ok('P9 explicit null course RIDES (null means no course — it must not be dropped into the menu default)',
    has(nulls, 'course') && nulls.course === null, JSON.stringify(nulls));

  const mixed = bodiesFor(world, 6).find((b) => b.qty === 2) || {};
  ok('P10 a carried note rides even when course is absent', mixed.note === 'extra crispy',
    JSON.stringify(mixed));
  ok('P11 …and the absent course stays absent on that same line', !has(mixed, 'course'),
    JSON.stringify(mixed));
}

/* =============== Q: lanEnvelope carries the four fields =============== */
section('Q. lanEnvelope — note / allergy / course ride the sync envelope');
{
  const ctx = { console };
  vm.createContext(ctx);
  vm.runInContext(extractFn(appSrc, 'lanEnvelope'), ctx);
  const mk = (items) => ({ op_id: 'q-op', device_id: 'h43', seq: 1, lamport: 1, ts: 1,
    op: 'add_items', payload: { check_id: 555, items } });
  const line = (env) => env.payload.items[0];

  const full = line(ctx.lanEnvelope(mk([
    { temp_id: 'tmp-g1', menu_item_id: 32, seat: 1, qty: 1, modifiers: [],
      note: 'no sauce', allergy: true, allergy_detail: 'soy', course: 'appetizer' },
  ]), 'bali-hai'));
  ok('Q1 envelope line keeps its item_uuid from temp_id', full.item_uuid === 'tmp-g1',
    JSON.stringify(full));
  ok('Q2 envelope carries note / allergy / allergy_detail',
    full.note === 'no sauce' && full.allergy === true && full.allergy_detail === 'soy',
    JSON.stringify(full));
  ok('Q3 envelope carries the ring-time course', full.course === 'appetizer', JSON.stringify(full));

  const bare = line(ctx.lanEnvelope(mk([
    { temp_id: 'tmp-g2', menu_item_id: 6, seat: 1, qty: 1, modifiers: [] },
  ]), 'bali-hai'));
  ok('Q4 a pre-field line gains NO new keys in the envelope',
    !has(bare, 'note') && !has(bare, 'allergy') && !has(bare, 'allergy_detail') && !has(bare, 'course'),
    JSON.stringify(bare));

  const nul = line(ctx.lanEnvelope(mk([
    { temp_id: 'tmp-g3', menu_item_id: 6, seat: 2, qty: 1, modifiers: [],
      note: null, allergy: false, allergy_detail: null, course: null },
  ]), 'bali-hai'));
  ok('Q5 explicit null course rides the envelope as null',
    has(nul, 'course') && nul.course === null && has(nul, 'note') && nul.note === null
      && nul.allergy === false, JSON.stringify(nul));
}

console.log('\n' + (failures ? failures + ' FAILURES' : 'ALL HARNESS CHECKS PASS'));
process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
