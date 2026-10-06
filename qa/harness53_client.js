#!/usr/bin/env node
/**
 * Extracted-REAL-function harness for test53 (split item cost — audit
 * gap #7).
 *
 * The order-screen Split cost dialog carries three small shipped
 * helpers in public/app.js:
 *   - splitSharesEven(amountCents, n): the even rule — every share is
 *     the floor and the first (amount mod n) shares absorb one extra
 *     cent, in order. It is the server rule verbatim, so the dialog
 *     preview is the charge.
 *   - parseShareInput(str): the typed-dollars parser for one custom
 *     share — {cents} or {error}, never NaN downstream.
 *   - splitSharesValid(amountCents, shares): explicit shares post
 *     only when every share is a positive whole number of cents and
 *     they add up to the line amount exactly.
 * Plus the quick-bar entry in public/views/parity_orders.js
 * (quickBarHtml): the Split cost button renders for server lines and
 * never for staged lines (a staged line has no server row to divide).
 *
 * This harness extracts all four REAL functions (brace-matched
 * verbatim, the harness35/40/47/48/51/52 pattern), drives the full
 * matrix, and statically pins the dialog wiring in app.js: the
 * quick-bar dispatch, the split-item-cost POST, the open-checks
 * picker feed, and the manager-PIN retry.
 *
 * Control: at 7757fde none of the functions, the button, and none of
 * the wiring exists — extraction fails and every wiring assert fails.
 *
 * Usage: node harness53_client.js [appJsPath] [parityOrdersPath]
 */
const fs = require('fs');
const vm = require('vm');

const APP_JS = process.argv[2] || __dirname + '/../public/app.js';
const PO_JS = process.argv[3] || __dirname + '/../public/views/parity_orders.js';
const appSrc = fs.readFileSync(APP_JS, 'utf8');
const poSrc = fs.readFileSync(PO_JS, 'utf8');

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
section('== extraction: the real splitSharesEven / parseShareInput / splitSharesValid from public/app.js ==');
let fns = null;
try {
  const src = extractFn(appSrc, 'splitSharesEven') + '\n' + extractFn(appSrc, 'parseShareInput') + '\n' + extractFn(appSrc, 'splitSharesValid');
  const ctx = vm.createContext({});
  vm.runInContext(src + '\nthis.__x = { splitSharesEven, parseShareInput, splitSharesValid };', ctx);
  fns = ctx.__x;
  ok('E1 all three helpers extract and load',
    typeof fns.splitSharesEven === 'function' && typeof fns.parseShareInput === 'function' && typeof fns.splitSharesValid === 'function');
} catch (e) {
  ok('E1 all three helpers extract and load', false, e.message);
}

if (fns) {
  section('== A: splitSharesEven — floor shares, first shares absorb the remainder cents, in order ==');
  const ev = fns.splitSharesEven;
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  ok('A1 1000 over 3 → 334/333/333', eq(ev(1000, 3), [334, 333, 333]), JSON.stringify(ev(1000, 3)));
  ok('A2 1000 over 2 → 500/500', eq(ev(1000, 2), [500, 500]));
  ok('A3 1000 over 4 → 250 ×4', eq(ev(1000, 4), [250, 250, 250, 250]));
  ok('A4 999 over 3 → 333 ×3 (no remainder)', eq(ev(999, 3), [333, 333, 333]));
  ok('A5 5 over 3 → 2/2/1', eq(ev(5, 3), [2, 2, 1]), JSON.stringify(ev(5, 3)));
  ok('A6 7 over 2 → 4/3', eq(ev(7, 2), [4, 3]));
  ok('A7 100 over 7 → 15/15/14/14/14/14/14', eq(ev(100, 7), [15, 15, 14, 14, 14, 14, 14]), JSON.stringify(ev(100, 7)));
  ok('A8 any split sums to the amount exactly', [1, 2, 3, 17, 100, 101, 1000, 12345].every((amt) =>
    [2, 3, 4, 5, 9].every((n) => ev(amt, n).reduce((a, s) => a + s, 0) === amt && ev(amt, n).length === n)));
  ok('A9 n of 0 or missing → empty set', eq(ev(1000, 0), []) && eq(ev(1000), []));
  ok('A10 amount of 0 → zero shares, still n long', eq(ev(0, 3), [0, 0, 0]));

  section('== B: parseShareInput — typed dollars to exact cents, errors instead of NaN ==');
  const ps = fns.parseShareInput;
  ok('B1 "3.34" → 334', ps('3.34').cents === 334, JSON.stringify(ps('3.34')));
  ok('B2 "3" → 300', ps('3').cents === 300);
  ok('B3 "0.01" → 1', ps('0.01').cents === 1);
  ok('B4 " 12.50 " trims → 1250', ps(' 12.50 ').cents === 1250);
  ok('B5 empty → error', !!ps('').error && !!ps('   ').error && !!ps(null).error && !!ps(undefined).error);
  ok('B6 non-numeric → error', !!ps('abc').error && !!ps('1.2.3').error);
  ok('B7 zero and negative → error', !!ps('0').error && !!ps('0.00').error && !!ps('-4.50').error);
  ok('B8 a parsed value is always a whole number of cents', ['1.1', '2.22', '0.07', '99.99'].every((s) => Number.isInteger(ps(s).cents)));

  section('== C: splitSharesValid — positive whole cents summing to the amount, nothing else posts ==');
  const sv = fns.splitSharesValid;
  ok('C1 exact even set passes', sv(1000, [334, 333, 333]) === true);
  ok('C2 off by one cent fails', sv(1000, [334, 333, 332]) === false && sv(1000, [334, 333, 334]) === false);
  ok('C3 a zero share fails even when the sum is right', sv(1000, [0, 1000]) === false);
  ok('C4 a negative share fails', sv(1000, [-1, 1001]) === false);
  ok('C5 a fractional share fails', sv(1000, [333.5, 666.5]) === false);
  ok('C6 empty / missing set fails', sv(1000, []) === false && sv(1000, null) === false && sv(1000, undefined) === false);
  ok('C7 a single full share is well-formed (the 2-check rule lives in the dialog/server)', sv(500, [500]) === true);
}

section('== D: quickBarHtml (real, from views/parity_orders.js) — the Split cost entry ==');
try {
  const ctx = vm.createContext({ window: {} });
  ctx.window = ctx;
  vm.runInContext('const COURSE_LIST = ["appetizer","entree","drink","dessert"];\n' +
    extractFn(poSrc, 'quickBarHtml') + '\nthis.__qb = quickBarHtml;', ctx);
  const serverBar = ctx.__qb({ qty: 1, seat: 1, guestCount: 4, staged: false, course: null, canCourse: true });
  ok('D1 a server line bar carries the Split cost action', serverBar.includes('data-qa="splitcost"') && serverBar.includes('>Split cost</button>'));
  const stagedBar = ctx.__qb({ qty: 1, seat: 1, guestCount: 4, staged: true, course: null, canCourse: true });
  ok('D2 a staged line bar has NO Split cost action (no server row yet)', !stagedBar.includes('splitcost'));
  const firedBar = ctx.__qb({ qty: 2, seat: 1, guestCount: 4, staged: false, course: 'entree', canCourse: false });
  ok('D3 a fired line keeps the Split cost action (fired lines split by cost, never re-fired)', firedBar.includes('data-qa="splitcost"'));
} catch (e) {
  ok('D1 quickBarHtml extracts and renders', false, e.message);
  ok('D2 staged exclusion', false, 'extraction failed');
  ok('D3 fired inclusion', false, 'extraction failed');
}

section('== W: wiring asserts on public/app.js (static) ==');
ok('W1 the quick-bar dispatch routes splitcost to the dialog', appSrc.includes("a === 'splitcost'") && appSrc.includes('openSplitItemCost(it)'));
ok('W2 the dialog posts to the split-item-cost endpoint', appSrc.includes("/split-item-cost'") && appSrc.includes("'POST', body"));
ok('W3 the picker feeds on the open-checks list with the source preselected',
  appSrc.includes("api('/api/checks/open')") && appSrc.includes('new Set([Number(check.id)])'));
ok('W4 custom amounts run through the real helpers before posting',
  appSrc.includes('splitSharesValid(amount, sh)') && appSrc.includes('parseShareInput(typed[id])'));
ok('W5 the even preview renders from splitSharesEven', appSrc.includes('splitSharesEven(amount, ids.length)'));
ok('W6 a 403 need_manager_pin detours to the PIN step and retries with the same body',
  appSrc.includes('e.body.need_manager_pin') && appSrc.includes('manager_pin: pin'));
ok('W7 offline is refused up front, the split-family message', appSrc.includes("toast('Splits need a connection — reconnect to split', 'err')"));
ok('W8 the dialog names the line and its amount and explains the consumption',
  appSrc.includes('Split item cost') && appSrc.includes('The line is consumed here'));

console.log('\n' + (failures ? failures + ' FAILURES' : 'ALL PASS'));
process.exit(failures ? 1 : 0);
