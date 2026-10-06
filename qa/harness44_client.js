#!/usr/bin/env node
/**
 * Extracted-REAL-function harness for test44 (ticket/preview fidelity).
 *
 * GAP 2 of the batch: getCheckView overlays still-queued offline lines
 * onto the server check view via applyOps, but the overlay line was
 * built as {id, menu_item_id, name, price_cents, seat, qty, modifiers,
 * state, pending} — the ring-time note, allergy flag/detail, and
 * course the queued payload carries (and both flush paths now send,
 * test43) never reached the preview, so the server did not see the
 * allergy flag on their own pending check until sync landed.
 *
 * The overlay must mirror the server check view (itemView) key names
 * and normalization:
 *   note           -> string|null   (payload note || null)
 *   allergy        -> boolean       (!!payload allergy)
 *   allergy_detail -> string|null   (payload allergy_detail || null)
 *   course         -> payload course, or null when the key is absent
 * A pre-field queue line (none of the keys) therefore previews with
 * the same neutral values a bare stored line shows in itemView.
 *
 * Usage: node harness44_client.js [appJsPath]
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

/* ---------- extraction (balanced-brace, harness35/40/41/42/43 machinery) ---------- */
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

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function applyOpsCtx() {
  const ctx = {
    console,
    /* applyOps calls the real estimateTotals only to refresh the
       totals of a check with pending ops; the totals themselves are
       not under test here, so the stub just marks the refresh. */
    estimateTotals: (check) => { check.totals = { estimated: true }; return check.totals; },
  };
  vm.createContext(ctx);
  vm.runInContext(extractFn(appSrc, 'applyOps'), ctx);
  return ctx;
}

/* =============== S: applyOps preview carries the four fields =============== */
section('S. applyOps — pending preview lines carry note / allergy / course');
{
  const ctx = applyOpsCtx();
  const check = { id: 555, items: [], payments: [] };
  const ops = [{ op: 'add_items', payload: { check_id: 555, items: [
    /* The full-field queued line, exactly as the HOLD enqueue writes
       it (note/allergy/allergy_detail always present, course when
       the staged line carried one). */
    { temp_id: 'tmp-p1', menu_item_id: 32, name: 'Edamame', price_cents: 900,
      seat: 1, qty: 1, modifiers: [{ name: 'Sea Salt' }],
      note: 'no sauce', allergy: true, allergy_detail: 'soy', course: 'dessert' },
    /* A pre-field queue entry: none of the four keys exist. */
    { temp_id: 'tmp-p2', menu_item_id: 6, name: 'Bali Fries', price_cents: 900,
      seat: 1, qty: 1, modifiers: [] },
    /* Explicit null course (server cleared the course at ring time):
       null is a real value and must preview as null. */
    { temp_id: 'tmp-p3', menu_item_id: 6, name: 'Bali Fries', price_cents: 900,
      seat: 2, qty: 1, modifiers: [],
      note: null, allergy: false, allergy_detail: null, course: null },
  ] } }];
  ctx.applyOps(check, ops, {});
  const [eda, bare, nulls] = check.items;

  ok('S1 overlay behavior preserved (3 pending held lines, temp ids)',
    check.items.length === 3 && check.items.every((i) => i.state === 'held' && i.pending === true)
      && eda.id === 'tmp-p1' && bare.id === 'tmp-p2',
    JSON.stringify(check.items.map((i) => [i.id, i.state, i.pending])));
  ok('S2 the full-field line previews its note', eda.note === 'no sauce', JSON.stringify(eda));
  ok('S3 the full-field line previews allergy=true (boolean, itemView shape)',
    eda.allergy === true, JSON.stringify(eda));
  ok('S4 the full-field line previews its allergy detail', eda.allergy_detail === 'soy',
    JSON.stringify(eda));
  ok('S5 the full-field line previews its ring-time course', eda.course === 'dessert',
    JSON.stringify(eda));
  ok('S6 a pre-field line previews the neutral itemView values (keys present, null/false)',
    has(bare, 'note') && bare.note === null && has(bare, 'allergy') && bare.allergy === false
      && has(bare, 'allergy_detail') && bare.allergy_detail === null
      && has(bare, 'course') && bare.course === null,
    JSON.stringify(bare));
  ok('S7 carried nulls preview as nulls and explicit null course stays null',
    nulls.note === null && nulls.allergy === false && nulls.allergy_detail === null
      && nulls.course === null,
    JSON.stringify(nulls));

  /* Preserved overlay behavior: a queued send flips held lines —
     including the pending ones — to sent in the preview. */
  ctx.applyOps(check, [{ op: 'send', payload: { check_id: 555 } }], {});
  ok('S8 a queued send op still flips the preview lines to sent',
    check.items.every((i) => i.state === 'sent'),
    JSON.stringify(check.items.map((i) => i.state)));
}

console.log('\n' + (failures ? failures + ' FAILURES' : 'ALL HARNESS CHECKS PASS'));
process.exit(failures ? 1 : 0);
