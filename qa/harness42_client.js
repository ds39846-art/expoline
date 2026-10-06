#!/usr/bin/env node
/**
 * Extracted-REAL-function harness for test42 (duplicate-on-retry hazards).
 *
 *   M  flushOutboxLegacy (legacy offline outbox flush): an add_items
 *      op whose second line lands on the server but whose RESPONSE is
 *      lost (the classic mid-flush connection drop). The op stays
 *      queued whole; on the retry pass the already-landed lines must
 *      NOT be inserted again. The mechanism under test: the client
 *      sends a per-line idempotency_key derived from the line temp_id
 *      (persisted inside the queue entry), and the server replays the
 *      stored response for a seen key. The fake rawApi below models
 *      that server contract faithfully (key seen -> replay, no insert;
 *      no key -> always insert); qa/test42 proves the REAL server
 *      honors the same contract over HTTP. At the pre-fix commit the
 *      client sends no key, the fake inserts again, and M3/M4 fail on
 *      the duplicated lines.
 *   M7 the a2ee194 preservation pin at flush level: a genuine 400 on a
 *      queued line still fires the named-line toast and keeps the op
 *      queued (stop-on-failure ordering unchanged).
 *   N  toast durations: error toasts stay up long enough to read
 *      (length-scaled, floored at 6s); ok/info keep the 3400ms beat.
 *
 * Usage: node harness42_client.js [appJsPath]
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

/* ---------- extraction (balanced-brace, harness35/40/41 machinery) ---------- */
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

/* The real ApiError class ships as one line in app.js. */
const apiErrorLine = appSrc.split('\n').find((l) => l.startsWith('class ApiError'));
if (!apiErrorLine) { console.log('ApiError class line not found'); process.exit(2); }

/* ---------- fake world: an in-memory model of the server contract ---------- */
function makeWorld() {
  return {
    created: [],              // items the fake server actually inserted
    byKey: new Map(),         // idempotency_key -> stored response (replay source)
    calls: [],                // every rawApi call {path, method, body}
    toasts: [],
    removed: [],              // Outbox.remove keys, in order
    nextId: 1000,
    dropResponseOnce: new Set(), // menu_item_ids: insert, then lose the response
    reject400: new Map(),        // menu_item_id -> validation error (inserts nothing)
  };
}

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
  };
  vm.createContext(ctx);
  vm.runInContext(apiErrorLine, ctx);
  /* The fake server must throw THIS context's ApiError class — the
     extracted flush instanceof-checks against its own binding, and a
     class from another vm context would never match. */
  const ApiErrorCls = vm.runInContext('ApiError', ctx);
  ctx.rawApi = async (path, method, body) => {
    world.calls.push({ path, method, body });
    if (!/\/items$/.test(path)) throw new Error('unexpected path ' + path);
    const key = body && body.idempotency_key;
    if (key && world.byKey.has(key)) return world.byKey.get(key); // replay: NO insert
    if (world.reject400.has(body.menu_item_id)) {
      throw new ApiErrorCls(400, world.reject400.get(body.menu_item_id));
    }
    const item = { id: world.nextId++, menu_item_id: body.menu_item_id, seat: body.seat, qty: body.qty };
    world.created.push(item);
    const resp = { id: item.id, menu_item_id: item.menu_item_id, seat: item.seat, qty: item.qty };
    if (key) world.byKey.set(key, resp);
    if (world.dropResponseOnce.has(body.menu_item_id)) {
      world.dropResponseOnce.delete(body.menu_item_id);
      throw new Error('network error: response lost');
    }
    return resp;
  };
  vm.runInContext(extractFn(appSrc, 'loadIdMap'), ctx);
  vm.runInContext(extractFn(appSrc, 'saveIdMap'), ctx);
  vm.runInContext(extractFn(appSrc, 'flushOutboxLegacy'), ctx);
  ctx.__loadIdMap = () => vm.runInContext('loadIdMap()', ctx);
  return ctx;
}

(async function main() {

/* =============== M: a retried flush never re-posts a landed line =============== */
section('M. flushOutboxLegacy — mid-op response loss, then retry');
{
  const world = makeWorld();
  const ctx = flushCtx(world);
  const op = { key: 'op-m', op: 'add_items', ts: 1, payload: { check_id: 555, items: [
    { temp_id: 'st-t1', menu_item_id: 101, name: 'Bali Fries', seat: 1, qty: 1, modifiers: [] },
    { temp_id: 'st-t2', menu_item_id: 102, name: 'Edamame', seat: 1, qty: 1, modifiers: [] },
    { temp_id: 'st-t3', menu_item_id: 103, name: 'Bali Fries', seat: 2, qty: 1, modifiers: [] },
  ] } };
  world.dropResponseOnce.add(102); // line 2 lands, its response is lost

  const done1 = await ctx.flushOutboxLegacy([op]);
  ok('M1 pass 1 stops inside the op (0 ops completed)', done1 === 0, 'done=' + done1);
  ok('M2 pass 1 landed lines 1-2 and never attempted line 3',
    world.created.map((c) => c.menu_item_id).join(',') === '101,102'
      && !world.calls.some((c) => c.body && c.body.menu_item_id === 103),
    'created=' + world.created.map((c) => c.menu_item_id).join(','));
  ok('M3 pass 1 keeps the op queued (no Outbox.remove)', world.removed.length === 0,
    world.removed.join(','));

  const done2 = await ctx.flushOutboxLegacy([op]);
  const perItem = {};
  for (const c of world.created) perItem[c.menu_item_id] = (perItem[c.menu_item_id] || 0) + 1;
  ok('M4 retry completes the op (1 done, removed once)',
    done2 === 1 && world.removed.join(',') === 'op-m', 'done=' + done2 + ' removed=' + world.removed.join(','));
  ok('M5 NO line was inserted twice across the retry (3 inserts total)',
    world.created.length === 3 && perItem[101] === 1 && perItem[102] === 1 && perItem[103] === 1,
    'created=' + JSON.stringify(world.created.map((c) => c.menu_item_id)));
  const keyOf = (mid, pass) => {
    const hits = world.calls.filter((c) => c.body && c.body.menu_item_id === mid);
    return hits[pass] && hits[pass].body.idempotency_key;
  };
  ok('M6 line 1 carries the SAME non-empty idempotency key on both passes',
    !!keyOf(101, 0) && keyOf(101, 0) === keyOf(101, 1), keyOf(101, 0) + ' vs ' + keyOf(101, 1));
  ok('M7 line 2 (the lost-response line) also retries under its original key',
    !!keyOf(102, 0) && keyOf(102, 0) === keyOf(102, 1), keyOf(102, 0) + ' vs ' + keyOf(102, 1));
  const idmap = ctx.__loadIdMap();
  const idFor = (mid) => (world.created.find((c) => c.menu_item_id === mid) || {}).id;
  ok('M8 id map points every temp line at its ORIGINAL server id',
    idmap['st-t1'] === idFor(101) && idmap['st-t2'] === idFor(102) && idmap['st-t3'] === idFor(103),
    JSON.stringify(idmap));
}

/* =============== M7: a genuine 400 still names the line and stops =============== */
section('M7. flushOutboxLegacy — a genuine 400 keeps the a2ee194 behavior');
{
  const world = makeWorld();
  world.reject400.set(202, 'Flavor: please choose at least one');
  const ctx = flushCtx(world);
  const op = { key: 'op-q', op: 'add_items', ts: 1, payload: { check_id: 777, items: [
    { temp_id: 'st-u1', menu_item_id: 201, name: 'Bali Fries', seat: 1, qty: 1, modifiers: [] },
    { temp_id: 'st-u2', menu_item_id: 202, name: 'Edamame', seat: 1, qty: 1, modifiers: [] },
  ] } };
  const done = await ctx.flushOutboxLegacy([op]);
  const t = world.toasts.find((x) => x.kind === 'err');
  ok('Q1 the named-line toast still fires on a 400',
    !!t && t.msg.includes('Edamame (Seat 1) needs attention: Flavor: please choose at least one'),
    JSON.stringify(world.toasts));
  ok('Q2 the op stays queued and only the valid line landed',
    done === 0 && world.removed.length === 0 && world.created.length === 1,
    'done=' + done + ' created=' + world.created.length);
}

/* =============== N: toast durations =============== */
section('N. toast — errors stay readable, ok/info keep the standard beat');
{
  const delays = [];
  const ctx = {
    console,
    $: () => ({ appendChild() {} }),
    document: { createElement: () => ({ className: '', textContent: '', style: {}, remove() {} }) },
    setTimeout: (fn, ms) => { delays.push(ms); return 1; },
  };
  vm.createContext(ctx);
  vm.runInContext(extractFn(appSrc, 'toast'), ctx);
  ctx.toast('2 items held', 'ok');
  ctx.toast('1 held · Edamame (Seat 1) needs attention: Flavor: please choose at least one · 2 more lines still staged', 'err');
  ctx.toast('Nope', 'err');
  ctx.toast('Saved');
  ok('N1 ok toast keeps 3400ms', delays[0] === 3400, 'got ' + delays[0]);
  ok('N2 the long HOLD error toast stays up >= 6s', delays[1] >= 6000 && delays[1] > delays[0], 'got ' + delays[1]);
  ok('N3 even a short error toast gets the 6s floor', delays[2] >= 6000, 'got ' + delays[2]);
  ok('N4 kindless toast keeps 3400ms', delays[3] === 3400, 'got ' + delays[3]);
}

console.log('\n' + (failures ? failures + ' FAILURES' : 'ALL HARNESS CHECKS PASS'));
process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
