#!/usr/bin/env node
/**
 * Extracted-REAL-function harness for test48 (tip adjustment —
 * audit gap #3).
 *
 * The tip-adjust client surface lives on the staff Pay screen, in the
 * manager payments card next to Refund (server-fed since this batch:
 * GET /api/checks/:id now carries the check payments — before that the
 * card only ever saw payments queued on the same device). Two small
 * shipped helpers carry the client logic:
 *   - tipAdjustable(p): whether the Adjust tip button renders for a
 *     payment row — settled card charge, real id, no refund activity.
 *     Mirrors the server guards on PATCH /api/payments/:id/tip.
 *   - parseTipInput(str): the typed-dollars parser for the dialog —
 *     {cents} or {error}, never NaN cents downstream.
 * This harness extracts both REAL functions out of public/app.js
 * (brace-matched verbatim, the harness35/40/47 pattern) and drives
 * the full matrix, then statically pins the renderPay wiring: the
 * button is rendered only through the predicate, and the confirm
 * handler PATCHes the tip endpoint with the parsed cents.
 *
 * Control: at fb14b9a neither function exists and no adjust wiring
 * is present — extraction fails and every section reports the miss.
 *
 * Usage: node harness48_client.js [appJsPath]
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
section('== extraction: the real tipAdjustable / parseTipInput from public/app.js ==');
let fns = null;
try {
  const src = extractFn(appSrc, 'tipAdjustable') + '\n' + extractFn(appSrc, 'parseTipInput');
  const ctx = vm.createContext({});
  vm.runInContext(src + '\nthis.__x = { tipAdjustable, parseTipInput };', ctx);
  fns = ctx.__x;
  ok('E1 both helpers extract and load', typeof fns.tipAdjustable === 'function' && typeof fns.parseTipInput === 'function');
} catch (e) {
  ok('E1 both helpers extract and load', false, e.message);
}

if (fns) {
  const { tipAdjustable, parseTipInput } = fns;

  section('== A: tipAdjustable — the button renders exactly for adjustable payments ==');
  const card = { id: 5, method: 'card_demo', status: 'completed', refunded_cents: 0, tip_cents: 500, amount_cents: 1000 };
  ok('A1 a settled card payment is adjustable', tipAdjustable(card) === true);
  ok('A2 a card payment with no status field reads as completed', tipAdjustable({ id: 5, method: 'card_demo' }) === true);
  ok('A3 cash is not adjustable', tipAdjustable({ ...card, method: 'cash' }) === false);
  ok('A4 house account is not adjustable', tipAdjustable({ ...card, method: 'house_account' }) === false);
  ok('A5 gift card is not adjustable', tipAdjustable({ ...card, method: 'gift_card' }) === false);
  ok('A6 a fully refunded card payment is not adjustable', tipAdjustable({ ...card, status: 'refunded', refunded_cents: 1000 }) === false);
  ok('A7 a partially refunded card payment is not adjustable', tipAdjustable({ ...card, status: 'partial_refund', refunded_cents: 100 }) === false);
  ok('A8 any refunded cents freeze the tip even if status lags', tipAdjustable({ ...card, refunded_cents: 1 }) === false);
  ok('A9 a queued offline payment (pending, no server id) is not adjustable', tipAdjustable({ method: 'card_demo', pending: true, tip_cents: 500 }) === false);
  ok('A10 a payment with a temp string id is not adjustable', tipAdjustable({ ...card, id: 'tmp-3' }) === false);
  ok('A11 null / missing rows are not adjustable', tipAdjustable(null) === false && tipAdjustable(undefined) === false);

  section('== B: parseTipInput — typed dollars in, integer cents or an honest error out ==');
  const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));
  eq('B1 whole dollars', parseTipInput('8'), { cents: 800 });
  eq('B2 dollars and cents', parseTipInput('4.50'), { cents: 450 });
  eq('B3 zero is a valid tip (clearing a mis-keyed tip)', parseTipInput('0'), { cents: 0 });
  eq('B4 zero dollars written out', parseTipInput('0.00'), { cents: 0 });
  eq('B5 surrounding whitespace is trimmed', parseTipInput('  7.25  '), { cents: 725 });
  eq('B6 cent rounding is exact', parseTipInput('1.01'), { cents: 101 });
  ok('B7 empty input is an error, not zero', typeof parseTipInput('').error === 'string');
  ok('B8 whitespace-only input is an error', typeof parseTipInput('   ').error === 'string');
  ok('B9 non-numeric input is an error', typeof parseTipInput('abc').error === 'string');
  ok('B10 a negative tip is an error', typeof parseTipInput('-5').error === 'string');
  ok('B11 null input is an error', typeof parseTipInput(null).error === 'string');
  ok('B12 no error shape ever carries NaN cents',
    ['', 'abc', '-1', 'NaN', 'Infinity'].every((s) => { const r = parseTipInput(s); return r.error !== undefined || Number.isInteger(r.cents); }));
}

section('== C: renderPay wiring — the predicate gates the button, the dialog PATCHes parsed cents ==');
ok('C1 the Adjust tip button renders through the predicate with the payment id',
  appSrc.includes("(tipAdjustable(p) ? '<button class=\"btn btn-sm\" data-adjust-tip=\"' + p.id + '\">Adjust tip</button> ' : '')"));
ok('C2 the manager card shows the current tip on the row',
  appSrc.includes("'<div class=\"small muted\">tip ' + fmt(p.tip_cents) + '</div>'"));
ok('C3 the click wiring binds every rendered Adjust tip button',
  appSrc.includes("$$('[data-adjust-tip]', app).forEach((b) => b.onclick = () => {"));
ok('C4 the confirm handler PATCHes the tip endpoint with the parsed cents',
  appSrc.includes("await api('/api/payments/' + p.id + '/tip', 'PATCH', { tip_cents: parsed.cents })"));
ok('C5 the dialog parses the typed field through parseTipInput before posting',
  appSrc.includes("const parsed = parseTipInput($('#tip-adj-val', bd).value);"));
ok('C6 a parse error toasts and posts nothing (the handler returns on parsed.error)',
  appSrc.includes("if (parsed.error) { toast(parsed.error, 'err'); return; }"));
ok('C7 success reports the old and new tip and refreshes the screen',
  appSrc.includes("'Tip adjusted — ' + fmt(r.previous_tip_cents || 0) + ' → ' + fmt(np.tip_cents || 0)") && appSrc.includes('renderRoute(true);'));

console.log('\n' + (failures ? failures + ' FAILURES' : 'ALL HARNESS CHECKS PASS'));
process.exit(failures ? 1 : 0);
