#!/usr/bin/env node
/**
 * Extracted-REAL-function harness for test45 (bar tabs).
 *
 * Runs the REAL functions — brace-matched verbatim out of the shipped
 * public/app.js, the harness35/40/43 pattern — so a wiring regression
 * fails here, not in production:
 *   J  locLabel: a bar tab reads "TAB · <name>" (the same prefixed
 *      form the server stamps on KDS tickets); a table check reads its
 *      table label even when it also carries a tab_name label; a
 *      check with neither reads null.
 *   K  lanEnvelope (open_check): a queued tab open (table_id null)
 *      rides the wire as table_id null + tab_name + guest_count, with
 *      the temp id as check_uuid; a queued table open is unchanged.
 *   L  flushOutboxLegacy (open_check): the legacy flush posts the tab
 *      form {table_id: null, guest_count, tab_name} to POST /api/checks
 *      and records the returned real id in the id map; a table open
 *      posts its historic shape.
 *
 * Usage: node harness45_client.js [appJsPath]
 */
const fs = require('fs');
const vm = require('vm');
const nodeCrypto = require('crypto');

const APP_JS = process.argv[2] || __dirname + '/../public/app.js';
const appSrc = fs.readFileSync(APP_JS, 'utf8');

let failures = 0;
function ok(name, cond, extra) {
  if (cond) console.log('  ok  ' + name);
  else { failures++; console.log('  FAIL ' + name + (extra !== undefined ? ' — ' + extra : '')); }
}
function section(s) { console.log('\n' + s); }

/* ---------- extraction (balanced-brace, harness35/40/43 machinery) ---------- */
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
function extractConstFn(src, name) {
  const marker = 'const ' + name + ' =';
  const mstart = src.indexOf(marker);
  if (mstart < 0) throw new Error('const fn not found: ' + name);
  let i = src.indexOf('=>', mstart);
  i = src.indexOf('{', i);
  let depth = 0, str = null, esc = false, tpl = 0;
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
    else if (c === '}') { depth--; if (depth === 0) return src.slice(mstart, i + 2); }
  }
  throw new Error('unterminated const fn: ' + name);
}

const apiErrorLine = appSrc.split('\n').find((l) => l.startsWith('class ApiError'));
if (!apiErrorLine) { console.log('ApiError class line not found'); process.exit(2); }

(async function main() {

/* =============== J: locLabel =============== */
section('J. locLabel — tab identity in check headers');
{
  const ctx = { console };
  vm.createContext(ctx);
  vm.runInContext(extractConstFn(appSrc, 'locLabel'), ctx);
  /* const declarations live in the context lexical scope, not on the
     context object — call through runInContext with the argument
     smuggled in as a data property. */
  const L = (o) => { ctx.__arg = o; return vm.runInContext('locLabel(__arg)', ctx); };
  ok('J1 a bar tab reads TAB · <name>', L({ channel: 'bar_tab', tab_name: 'Silva', table_label: null }) === 'TAB · Silva',
    L({ channel: 'bar_tab', tab_name: 'Silva', table_label: null }));
  ok('J2 a table check reads its table label even with a tab_name label',
    L({ channel: 'dine_in', tab_name: 'Party', table_label: '50' }) === '50',
    L({ channel: 'dine_in', tab_name: 'Party', table_label: '50' }));
  ok('J3 a table-less non-tab check falls back to its tab_name (delivery shape)',
    L({ channel: 'delivery', tab_name: 'Delivery · DoorDash', table_label: null }) === 'Delivery · DoorDash');
  ok('J4 a check with neither reads null', L({ channel: 'dine_in', tab_name: null, table_label: null }) === null);
  ok('J5 a draft tab (no channel yet) still reads its table label path safely',
    L({ tab_name: null, table_label: '51' }) === '51');
}

/* =============== K: lanEnvelope open_check =============== */
section('K. lanEnvelope — the queued tab open rides the wire');
{
  const ctx = { console, crypto: nodeCrypto };
  vm.createContext(ctx);
  vm.runInContext(extractFn(appSrc, 'lanEnvelope'), ctx);
  const tabEnv = ctx.lanEnvelope(
    { op: 'open_check', payload: { check_id: 'tmp-t1', temp_id: 'tmp-t1', table_id: null, guest_count: 1, tab_name: 'Silva' } },
    'bali-hai');
  ok('K1 the tab envelope keeps table_id null', tabEnv.payload.table_id === null,
    JSON.stringify(tabEnv.payload));
  ok('K2 the tab envelope carries the name and guest count',
    tabEnv.payload.tab_name === 'Silva' && tabEnv.payload.guest_count === 1,
    JSON.stringify(tabEnv.payload));
  ok('K3 the temp id becomes the check_uuid', tabEnv.payload.check_uuid === 'tmp-t1',
    tabEnv.payload.check_uuid);
  const tblEnv = ctx.lanEnvelope(
    { op: 'open_check', payload: { check_id: 'tmp-t2', temp_id: 'tmp-t2', table_id: 7, guest_count: 2, tab_name: null } },
    'bali-hai');
  ok('K4 a table open envelope is unchanged',
    tblEnv.payload.table_id === 7 && tblEnv.payload.guest_count === 2 && tblEnv.payload.check_uuid === 'tmp-t2',
    JSON.stringify(tblEnv.payload));
}

/* =============== L: flushOutboxLegacy open_check =============== */
section('L. flushOutboxLegacy — the offline tab open posts the tab form');
{
  const world = { calls: [], removed: [] };
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
    toast: () => {},
    handleApiError: (e) => { throw e; },
    showSyncedBanner: () => {},
    updateOfflineBanner: () => {},
    renderRoute: () => {},
    Outbox: { remove: async (key) => { world.removed.push(key); } },
    rawApi: async (path, method, body) => {
      world.calls.push({ path, method, body });
      if (path !== '/api/checks') throw new Error('unexpected path ' + path);
      return { id: 4321 };
    },
  };
  vm.createContext(ctx);
  vm.runInContext(apiErrorLine, ctx);
  vm.runInContext(extractFn(appSrc, 'loadIdMap'), ctx);
  vm.runInContext(extractFn(appSrc, 'saveIdMap'), ctx);
  vm.runInContext(extractFn(appSrc, 'flushOutboxLegacy'), ctx);

  const tabOp = { key: 'op-tab', op: 'open_check', ts: 1,
    payload: { check_id: 'tmp-t1', temp_id: 'tmp-t1', table_id: null, guest_count: 1, tab_name: 'Silva' } };
  const done = await ctx.flushOutboxLegacy([tabOp]);
  const body = world.calls.length ? world.calls[0].body : {};
  ok('L1 the tab open posts exactly the tab form',
    world.calls.length === 1 && body.table_id === null && body.guest_count === 1 && body.tab_name === 'Silva',
    JSON.stringify(body));
  ok('L2 the returned real id lands in the id map', ctx.loadIdMap()['tmp-t1'] === 4321,
    JSON.stringify(ctx.loadIdMap()));
  ok('L3 the op is consumed', done === 1 && world.removed.includes('op-tab'),
    'done=' + done + ' removed=' + world.removed.join(','));

  world.calls.length = 0;
  const tblOp = { key: 'op-tbl', op: 'open_check', ts: 2,
    payload: { check_id: 'tmp-t2', temp_id: 'tmp-t2', table_id: 7, guest_count: 2, tab_name: null } };
  await ctx.flushOutboxLegacy([tblOp]);
  const tbody = world.calls.length ? world.calls[0].body : {};
  ok('L4 a table open posts its historic shape',
    world.calls.length === 1 && tbody.table_id === 7 && tbody.guest_count === 2 && tbody.tab_name === null,
    JSON.stringify(tbody));
}

console.log('\n' + (failures ? failures + ' FAILURES' : 'ALL HARNESS CHECKS PASS'));
process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
