#!/usr/bin/env node
/**
 * Extracted-REAL-function harness for test49 (discount library —
 * audit gap #4).
 *
 * Three shipped helpers in public/app.js carry the client logic:
 *   - discountValueLabel(d): how a definition reads to staff
 *     ("10% off" / "$5.00 off").
 *   - discountSavingsCents(d, baseCents): the picker savings preview.
 *     Must mirror the server math exactly — percent rounds with
 *     Math.round on the base, fixed is the stored cents — and clamp
 *     at the base for display.
 *   - discountsForScope(list, scope): the picker filter — scope match,
 *     active definitions only.
 * This harness extracts all three REAL functions (brace-matched
 * verbatim, the harness35/40/47/48 pattern) and drives the matrix,
 * then statically pins the wiring: the order-screen picker posts to
 * the apply/remove endpoints, the settings editor talks to the admin
 * CRUD, and the pay screen itemizes library rows by name.
 *
 * The helpers call the shipped fmt(). The harness supplies fmt with
 * its exact shipped definition and asserts the shipped line still
 * matches, so the stub can never silently drift.
 *
 * Control: at 8034993 none of the three functions or any of the
 * wiring exists — extraction fails and every section reports it.
 *
 * Usage: node harness49_client.js [appJsPath]
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

/* ---------- extraction (balanced-brace, harness35/40 machinery) ---------- */
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

/* ---------- load the real helpers ---------- */
section('== extraction: the real discount helpers from public/app.js ==');
ok('E0 the shipped fmt matches the harness stub byte-for-byte',
  appSrc.includes("const fmt = (cents) => '$' + ((Number(cents) || 0) / 100).toFixed(2);"));
let fns = null;
try {
  const src = extractFn(appSrc, 'discountValueLabel') + '\n' +
    extractFn(appSrc, 'discountSavingsCents') + '\n' +
    extractFn(appSrc, 'discountsForScope');
  const ctx = vm.createContext({});
  vm.runInContext("const fmt = (cents) => '$' + ((Number(cents) || 0) / 100).toFixed(2);\n" + src +
    '\nthis.__x = { discountValueLabel, discountSavingsCents, discountsForScope };', ctx);
  fns = ctx.__x;
  ok('E1 all three helpers extract and load',
    typeof fns.discountValueLabel === 'function' && typeof fns.discountSavingsCents === 'function' &&
    typeof fns.discountsForScope === 'function');
} catch (e) {
  ok('E1 all three helpers extract and load', false, e.message);
}

if (fns) {
  const { discountValueLabel, discountSavingsCents, discountsForScope } = fns;
  const pct = (percent, extra) => Object.assign({ kind: 'percent', percent, amount_cents: null, scope: 'check', active: true }, extra || {});
  const fix = (amount_cents, extra) => Object.assign({ kind: 'fixed', percent: null, amount_cents, scope: 'item', active: true }, extra || {});

  section('== A: discountValueLabel — definitions read the way staff say them ==');
  ok('A1 whole percent', discountValueLabel(pct(10)) === '10% off', discountValueLabel(pct(10)));
  ok('A2 fractional percent keeps its decimals', discountValueLabel(pct(8.5)) === '8.5% off', discountValueLabel(pct(8.5)));
  ok('A3 long percent trims to cents of a percent', discountValueLabel(pct(33.333)) === '33.33% off', discountValueLabel(pct(33.333)));
  ok('A4 fixed renders dollars', discountValueLabel(fix(500)) === '$5.00 off', discountValueLabel(fix(500)));
  ok('A5 fixed with cents', discountValueLabel(fix(1250)) === '$12.50 off', discountValueLabel(fix(1250)));
  ok('A6 a missing definition labels empty', discountValueLabel(null) === '' && discountValueLabel(undefined) === '');

  section('== B: discountSavingsCents — the preview mirrors the server math ==');
  const eq = (name, got, want) => ok(name, got === want, got + ' !== ' + want);
  eq('B1 percent of the subtotal', discountSavingsCents(pct(10), 6000), 600);
  eq('B2 percent rounds half up like the server (157.5 -> 158)', discountSavingsCents(pct(15), 1050), 158);
  eq('B3 percent rounds half up on the quarter case (262.5 -> 263)', discountSavingsCents(pct(25), 1050), 263);
  eq('B4 a 100% definition saves the whole base', discountSavingsCents(pct(100), 999), 999);
  eq('B5 a zero base saves zero', discountSavingsCents(pct(50), 0), 0);
  eq('B6 fixed under the base', discountSavingsCents(fix(500), 6000), 500);
  eq('B7 fixed clamps at the base for display', discountSavingsCents(fix(500), 300), 300);
  eq('B8 fixed on a zero base saves zero', discountSavingsCents(fix(500), 0), 0);
  eq('B9 a missing definition saves zero', discountSavingsCents(null, 6000), 0);
  eq('B10 a fractional percent computes like the server', discountSavingsCents(pct(8.5), 1000), 85);

  section('== C: discountsForScope — the picker shows active definitions for its context ==');
  const lib = [
    pct(10, { id: 1, name: 'Military' }),
    pct(20, { id: 2, name: 'Employee', active: false }),
    fix(500, { id: 3, name: 'Appy five' }),
    fix(300, { id: 4, name: 'Dessert three', active: 0 }),
    fix(200, { id: 5, name: 'Line two', active: 1 }),
  ];
  const checks = discountsForScope(lib, 'check');
  ok('C1 check scope returns only active check definitions',
    checks.length === 1 && checks[0].id === 1, JSON.stringify(checks.map((d) => d.id)));
  const items = discountsForScope(lib, 'item');
  ok('C2 item scope returns active item definitions (boolean and 1 both count)',
    items.length === 2 && items[0].id === 3 && items[1].id === 5, JSON.stringify(items.map((d) => d.id)));
  ok('C3 a non-array list filters to empty',
    discountsForScope(null, 'check').length === 0 && discountsForScope(undefined, 'item').length === 0);
  ok('C4 an empty library filters to empty', discountsForScope([], 'check').length === 0);
}

section('== D: wiring — picker, strip, settings editor, pay itemization ==');
ok('D1 the picker feeds from the floor list endpoint',
  appSrc.includes("defs = await api('/api/discounts');"));
ok('D2 applying posts to the check discounts endpoint',
  appSrc.includes("await api('/api/checks/' + realId(checkId) + '/discounts', 'POST', body)"));
ok('D3 removal posts to the application remove endpoint',
  appSrc.includes("'/discounts/' + a.id + '/remove', 'POST', body"));
ok('D4 the order screen has the check-scope Discount button',
  appSrc.includes('id="disc-open"'));
ok('D5 every cart line carries the item-scope discount button',
  appSrc.includes('data-disc="') && appSrc.includes("openDiscountPicker({ scope: 'item', item: it })"));
ok('D6 the applied strip renders a remove control per application',
  appSrc.includes('data-libdisc-remove="') && appSrc.includes('removeDiscountFlow(a)'));
ok('D7 a server 403 need_manager_pin lands in the PIN step, not a bounce',
  appSrc.includes("e.body.need_manager_pin) { pinStep(); return; }"));
ok('D8 the settings editor lists from the admin endpoint',
  appSrc.includes("rows = await api('/api/admin/discounts');"));
ok('D9 the settings editor creates through the admin endpoint',
  appSrc.includes("await api('/api/admin/discounts', 'POST', body);"));
ok('D10 the settings editor updates through the admin endpoint',
  appSrc.includes("await api('/api/admin/discounts/' + d.id, 'PUT', body);"));
ok('D11 the pay screen itemizes library discounts by name',
  appSrc.includes("'Discount · ' + esc(a.name) + ' <span class=\"lbl-note\">library</span>'"));
ok('D12 the receipt itemizes library discounts by name too',
  appSrc.includes("'<tr><td>Discount · ' + esc(a.name) + '</td>"));
ok('D13 the editor form carries name, kind, scope, approval and active fields',
  appSrc.includes('id="de-name"') && appSrc.includes('id="de-kind"') && appSrc.includes('id="de-scope"') &&
  appSrc.includes('id="de-appr"') && appSrc.includes('id="de-active"'));

console.log('\n' + (failures ? failures + ' FAILURES' : 'ALL HARNESS CHECKS PASS'));
process.exit(failures ? 1 : 0);
