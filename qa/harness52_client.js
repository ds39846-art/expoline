#!/usr/bin/env node
/**
 * Extracted-REAL-function harness for test52 (shift review + cash-tip
 * declaration — audit gap #6).
 *
 * The Clock view shift-review section carries three small shipped
 * helpers:
 *   - parseDeclaredCash(str): the typed-dollars parser for the
 *     declaration field — {cents} or {error}, never NaN downstream.
 *   - tipsOfRecord(card, recordedCash, declared): THE composition —
 *     once a declaration exists it is the cash figure of record and the
 *     recorded cash tips are only the pre-declaration fallback; the
 *     two are never summed (the double-count trap this batch exists
 *     to avoid).
 *   - declaredTipsPreview(card, recordedCash, str): the declare form
 *     live preview — parse + composition in one.
 * This harness extracts all three REAL functions out of public/app.js
 * (brace-matched verbatim, the harness35/40/47/48/51 pattern), drives
 * the full matrix, and statically pins the wireShiftReview wiring:
 * the section mounts on the Clock view, reads the shift-review
 * endpoint, and posts declarations (with a manager PIN when a manager
 * declares for another server).
 *
 * Control: at cf3d0b6 none of the functions and none of the wiring
 * exists — extraction fails and every wiring assert fails.
 *
 * Usage: node harness52_client.js [appJsPath]
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
section('== extraction: the real parseDeclaredCash / tipsOfRecord / declaredTipsPreview from public/app.js ==');
let fns = null;
try {
  const src = extractFn(appSrc, 'parseDeclaredCash') + '\n' + extractFn(appSrc, 'tipsOfRecord') + '\n' + extractFn(appSrc, 'declaredTipsPreview');
  const ctx = vm.createContext({});
  vm.runInContext(src + '\nthis.__x = { parseDeclaredCash, tipsOfRecord, declaredTipsPreview };', ctx);
  fns = ctx.__x;
  ok('E1 all three helpers extract and load',
    typeof fns.parseDeclaredCash === 'function' && typeof fns.tipsOfRecord === 'function' && typeof fns.declaredTipsPreview === 'function');
} catch (e) {
  ok('E1 all three helpers extract and load', false, e.message);
}

if (fns) {
  const { parseDeclaredCash, tipsOfRecord, declaredTipsPreview } = fns;
  const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));

  section('== A: parseDeclaredCash — typed dollars in, integer cents or an honest error out ==');
  eq('A1 whole dollars', parseDeclaredCash('42'), { cents: 4200 });
  eq('A2 dollars and cents', parseDeclaredCash('42.50'), { cents: 4250 });
  eq('A3 declaring zero is a valid attestation, not an error', parseDeclaredCash('0'), { cents: 0 });
  eq('A4 zero written out', parseDeclaredCash('0.00'), { cents: 0 });
  eq('A5 surrounding whitespace is trimmed', parseDeclaredCash('  12.34  '), { cents: 1234 });
  eq('A6 one decimal place pads correctly', parseDeclaredCash('7.5'), { cents: 750 });
  ok('A7 empty input is an error, not a silent zero', typeof parseDeclaredCash('').error === 'string');
  ok('A8 whitespace-only input is an error', typeof parseDeclaredCash('   ').error === 'string');
  ok('A9 non-numeric input is an error', typeof parseDeclaredCash('abc').error === 'string');
  ok('A10 a negative declaration is an error', typeof parseDeclaredCash('-5').error === 'string');
  ok('A11 null input is an error', typeof parseDeclaredCash(null).error === 'string');
  ok('A12 no error shape ever carries NaN cents',
    ['', 'abc', '-1', 'NaN', 'Infinity', '$42'].every((s) => { const r = parseDeclaredCash(s); return r.error !== undefined || Number.isInteger(r.cents); }));

  section('== B: tipsOfRecord — the composition: declared replaces recorded, never adds ==');
  eq('B1 with a declaration, the declared figure is the cash of record',
    tipsOfRecord(1000, 300, 500), { declared: true, cash_of_record_cents: 500, total_tips_cents: 1500 });
  eq('B2 the recorded cash tips are NOT added on top of the declaration (1000+500, never 1000+300+500)',
    tipsOfRecord(1000, 300, 500).total_tips_cents, 1500);
  eq('B3 a declaration of zero is a real attestation: cash of record is zero, not the recorded fallback',
    tipsOfRecord(1000, 300, 0), { declared: true, cash_of_record_cents: 0, total_tips_cents: 1000 });
  eq('B4 with no declaration, recorded cash tips are the fallback figure of record',
    tipsOfRecord(1000, 300, null), { declared: false, cash_of_record_cents: 300, total_tips_cents: 1300 });
  eq('B5 no declaration and no recorded cash tips totals to the card tips alone',
    tipsOfRecord(1000, 0, null), { declared: false, cash_of_record_cents: 0, total_tips_cents: 1000 });
  eq('B6 undefined declared behaves as not declared',
    tipsOfRecord(0, 250, undefined), { declared: false, cash_of_record_cents: 250, total_tips_cents: 250 });

  section('== C: declaredTipsPreview — parse + composition for the live form preview ==');
  eq('C1 a typed declaration previews the of-record total',
    declaredTipsPreview(1000, 300, '5.00'), { declared_cents: 500, cash_of_record_cents: 500, total_tips_cents: 1500 });
  eq('C2 typing zero previews a zero cash figure of record, not the recorded 300',
    declaredTipsPreview(1000, 300, '0'), { declared_cents: 0, cash_of_record_cents: 0, total_tips_cents: 1000 });
  ok('C3 an invalid amount previews as an error', typeof declaredTipsPreview(1000, 300, 'abc').error === 'string');
  ok('C4 an empty amount previews as an error', typeof declaredTipsPreview(1000, 300, '').error === 'string');
  ok('C5 a negative amount previews as an error', typeof declaredTipsPreview(1000, 300, '-2').error === 'string');
}

section('== D: wireShiftReview wiring — the Clock section talks to the review + declaration endpoints honestly ==');
ok('D1 renderClock mounts the shift-review section and wires it',
  appSrc.includes('<div id="sr-section"></div>') && appSrc.includes('wireShiftReview();'));
ok('D2 the section reads the shift-review endpoint for the picked date and server',
  appSrc.includes("await api('/api/finance/shift-review?date=' + encodeURIComponent(sr.date)"));
ok('D3 the declaration posts the parsed cents and the picked date',
  appSrc.includes("const body = { declared_cash_tips_cents: p.declared_cents, date: sr.date };") &&
  appSrc.includes("await api('/api/finance/tip-declarations', 'POST', body)"));
ok('D4 a cross-server declaration carries server_id and the manager PIN from the approval modal',
  appSrc.includes('body.server_id = sr.serverId; body.manager_pin = pin;') && appSrc.includes('id="sr-pin"'));
ok('D5 the declare button runs the real preview first and refuses on a parse error',
  appSrc.includes('const p = declaredTipsPreview(r.tips.card_tips_cents, r.tips.recorded_cash_tips_cents, amt.value);') &&
  appSrc.includes("if (p.error) { toast(p.error, 'err'); return; }"));
ok('D6 the live preview repaints on every keystroke through the real helper',
  appSrc.includes("amt.addEventListener('input', paintPrev);"));
ok('D7 the review shows the not-declared state distinctly from a declared zero',
  appSrc.includes('Not declared') && appSrc.includes('Cash tips declared'));
ok('D8 the review discloses that recorded cash tips are a memo, never added to the declaration',
  appSrc.includes('the two are never added together'));
ok('D9 the closed-day state is disclosed on the review',
  appSrc.includes('This date is closed out (Z). Declarations are still accepted'));

console.log('\n' + (failures ? failures + ' FAILURES' : 'ALL HARNESS CHECKS PASS'));
process.exit(failures ? 1 : 0);
