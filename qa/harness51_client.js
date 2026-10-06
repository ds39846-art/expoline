#!/usr/bin/env node
/**
 * Extracted-REAL-function harness for test51 (EOD close-out — audit
 * gap #5).
 *
 * The Z panel on the manager Finance view carries two small shipped
 * helpers:
 *   - parseCountedCash(str): the typed-dollars parser for the counted
 *     cash field — {cents} or {error}, never NaN cents downstream (the
 *     parseTipInput idiom from the tip-adjust batch).
 *   - overShortPreview(countedStr, expectedCents): the live over/short
 *     preview — counted minus expected, in cents, the exact figure the
 *     server stores at close time.
 * This harness extracts both REAL functions out of public/app.js
 * (brace-matched verbatim, the harness35/40/47/48 pattern) and drives
 * the full matrix, then statically pins the wireCloseout wiring: the
 * panel reads the day-status endpoint, posts the close with the parsed
 * counted cents and a fresh PIN, and posts reopen with PIN + reason.
 *
 * Control: at 44d7680 neither function exists and no close-day wiring
 * is present — extraction fails and every wiring assert fails.
 *
 * Usage: node harness51_client.js [appJsPath]
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
section('== extraction: the real parseCountedCash / overShortPreview from public/app.js ==');
let fns = null;
try {
  const src = extractFn(appSrc, 'parseCountedCash') + '\n' + extractFn(appSrc, 'overShortPreview');
  const ctx = vm.createContext({});
  vm.runInContext(src + '\nthis.__x = { parseCountedCash, overShortPreview };', ctx);
  fns = ctx.__x;
  ok('E1 both helpers extract and load', typeof fns.parseCountedCash === 'function' && typeof fns.overShortPreview === 'function');
} catch (e) {
  ok('E1 both helpers extract and load', false, e.message);
}

if (fns) {
  const { parseCountedCash, overShortPreview } = fns;
  const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));

  section('== A: parseCountedCash — typed dollars in, integer cents or an honest error out ==');
  eq('A1 whole dollars', parseCountedCash('412'), { cents: 41200 });
  eq('A2 dollars and cents', parseCountedCash('412.50'), { cents: 41250 });
  eq('A3 a zero count is valid (an empty drawer is a real count)', parseCountedCash('0'), { cents: 0 });
  eq('A4 zero written out', parseCountedCash('0.00'), { cents: 0 });
  eq('A5 surrounding whitespace is trimmed', parseCountedCash('  42.63  '), { cents: 4263 });
  eq('A6 one decimal place pads correctly', parseCountedCash('30.5'), { cents: 3050 });
  eq('A7 the fixture count from test51', parseCountedCash('43.13'), { cents: 4313 });
  ok('A8 empty input is an error, not zero', typeof parseCountedCash('').error === 'string');
  ok('A9 whitespace-only input is an error', typeof parseCountedCash('   ').error === 'string');
  ok('A10 non-numeric input is an error', typeof parseCountedCash('abc').error === 'string');
  ok('A11 a negative count is an error', typeof parseCountedCash('-5').error === 'string');
  ok('A12 null input is an error', typeof parseCountedCash(null).error === 'string');
  ok('A13 no error shape ever carries NaN cents',
    ['', 'abc', '-1', 'NaN', 'Infinity', '$42'].every((s) => { const r = parseCountedCash(s); return r.error !== undefined || Number.isInteger(r.cents); }));

  section('== B: overShortPreview — counted minus expected, exactly what the server stores ==');
  eq('B1 exact count previews zero', overShortPreview('42.63', 4263), { counted_cents: 4263, over_short_cents: 0 });
  eq('B2 an over count previews positive', overShortPreview('43.13', 4263), { counted_cents: 4313, over_short_cents: 50 });
  eq('B3 a short count previews negative', overShortPreview('40.00', 4263), { counted_cents: 4000, over_short_cents: -263 });
  eq('B4 a zero expected day previews the whole count as over', overShortPreview('10.00', 0), { counted_cents: 1000, over_short_cents: 1000 });
  eq('B5 a missing expected reads as zero', overShortPreview('10.00', undefined), { counted_cents: 1000, over_short_cents: 1000 });
  ok('B6 a parse error passes through as an error', typeof overShortPreview('', 4263).error === 'string');
  ok('B7 a negative count passes through as an error', typeof overShortPreview('-1', 4263).error === 'string');
}

section('== C: wireCloseout wiring — the panel talks to the close-day endpoints honestly ==');
ok('C1 renderFinance mounts the Z panel section', appSrc.includes('\'<div id="z-section"></div>\'') && appSrc.includes('wireCloseout(d);'));
ok('C2 the panel reads the day-status endpoint for the selected date',
  appSrc.includes("await api('/api/finance/close-day?date=' + encodeURIComponent(date))"));
ok('C3 the panel lists previous close-outs', appSrc.includes("await api('/api/finance/closeouts')"));
ok('C4 the close posts parsed counted cents plus a fresh manager PIN',
  appSrc.includes("await api('/api/finance/close-day', 'POST', { date, counted_cash_cents: p.counted_cents, manager_pin: pin, note: note || undefined })"));
ok('C5 the close confirm runs the preview first and refuses on a parse error',
  appSrc.includes('const p = overShortPreview(countedEl.value, expected);') && appSrc.includes("if (p.error) { toast(p.error, 'err'); return; }"));
ok('C6 the live preview repaints on every keystroke through the real helper',
  appSrc.includes("countedEl.addEventListener('input', paintPrev);") && appSrc.includes('const p = overShortPreview(countedEl.value, expected);'));
ok('C7 the reopen posts PIN plus a required reason',
  appSrc.includes("await api('/api/finance/close-day/reopen', 'POST', { date, manager_pin: pin, reason })") && appSrc.includes("if (!reason) { toast('A reason is required', 'err'); return; }"));
ok('C8 the closed panel states the lock plainly',
  appSrc.includes('This day is locked — refunds, tip changes and new payments dated to it are refused until it is reopened.'));
ok('C9 the open panel discloses what expected cash excludes',
  appSrc.includes('It does not include the drawer opening float or paid-ins / paid-outs'));

console.log('\n' + (failures ? failures + ' FAILURES' : 'ALL HARNESS CHECKS PASS'));
process.exit(failures ? 1 : 0);
