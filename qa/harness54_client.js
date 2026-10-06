#!/usr/bin/env node
/**
 * Extracted-REAL-function harness for test54 (86 from the floor —
 * audit gap #8).
 *
 * The batch lives or dies on two client facts:
 *   1. getMenu() in public/app.js maps server items to a FIXED field
 *      list — the trap that silently dropped modifier_groups, popular,
 *      course and hh fields in earlier batches. The floor-86 fields
 *      (is_86 / remaining) MUST survive that mapping or every tile
 *      renders available forever. This harness runs the REAL getMenu
 *      against a stubbed api() and pins the pass-through.
 *   2. The tile-state helpers (itemIs86 / itemRemaining /
 *      eightySixBadge) decide what the floor sees: out -> an 86 tag,
 *      counting -> an N-left tag, available -> nothing. Extracted
 *      verbatim and driven over the full matrix.
 * Plus static wiring pins: the 86 chip on item tiles, the sheet
 * function posting to the floor endpoint, the addItemFlow guard, the
 * quick-pick routing, and the CSS state classes.
 *
 * Control: at 071341f none of the fields, helpers, or wiring exists —
 * extraction fails and every assert fails.
 *
 * Usage: node harness54_client.js [appJsPath] [stylesCssPath]
 */
const fs = require('fs');
const vm = require('vm');

const APP_JS = process.argv[2] || __dirname + '/../public/app.js';
const CSS = process.argv[3] || __dirname + '/../public/styles.css';
const appSrc = fs.readFileSync(APP_JS, 'utf8');
const cssSrc = fs.readFileSync(CSS, 'utf8');

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
/* The three tile helpers are contiguous top-level consts; slice them
 * out as one block (they reference only each other). */
function extractHelpers(src) {
  const a = src.indexOf('const itemIs86');
  const b = src.indexOf('/* Location label for a check');
  if (a < 0 || b < 0 || b <= a) throw new Error('helper block not found');
  return src.slice(a, b);
}

(async () => {
  section('== extraction: the real getMenu + tile helpers from public/app.js ==');
  let api;
  try {
    const canned = {
      categories: [{
        id: 1, name: 'Mains',
        items: [
          { id: 34, name: '14oz Ribeye', price_cents: 5500, is_86: true, remaining: null },
          { id: 32, name: 'Edamame', price_cents: 900, is_86: false, remaining: 3 },
          { id: 99, name: 'Plain Item', price_cents: 100 },
        ],
      }],
    };
    const ctx = vm.createContext({ api: async () => canned, console });
    vm.runInContext(extractFn(appSrc, 'getMenu'), ctx);
    const menu = await vm.runInContext('getMenu()', ctx);
    const items = menu[0].items;
    ok('getMenu maps the category through', menu.length === 1 && items.length === 3);
    ok('is_86:true survives the mapping (the fixed-field trap)', items[0].is_86 === true, JSON.stringify(items[0]));
    ok('remaining:null survives as null', items[0].remaining === null);
    ok('a countdown item keeps is_86:false + remaining:3', items[1].is_86 === false && items[1].remaining === 3,
      JSON.stringify(items[1]));
    ok('an item with no 86 fields maps to is_86:false / remaining:null',
      items[2].is_86 === false && items[2].remaining === null, JSON.stringify(items[2]));
    api = items;
  } catch (e) {
    ok('getMenu extraction + run', false, e.message);
  }

  let H = null;
  try {
    const ctx = vm.createContext({});
    vm.runInContext(extractHelpers(appSrc) + '\nthis.H = { itemIs86, itemRemaining, eightySixBadge };', ctx);
    H = ctx.H;
    ok('tile helpers extracted (itemIs86 / itemRemaining / eightySixBadge)', !!H);
  } catch (e) {
    ok('tile helpers extracted', false, e.message);
  }

  if (H) {
    section('== tile-state matrix ==');
    ok('itemIs86 true when flagged', H.itemIs86({ is_86: true }) === true);
    ok('itemIs86 false when unflagged', H.itemIs86({ is_86: false }) === false);
    ok('itemIs86 false for a bare item', H.itemIs86({}) === false);
    ok('itemIs86 false for null', H.itemIs86(null) === false);
    ok('itemRemaining reads the count', H.itemRemaining({ remaining: 3 }) === 3);
    ok('itemRemaining reads zero as zero (not null)', H.itemRemaining({ remaining: 0 }) === 0);
    ok('itemRemaining null when unset', H.itemRemaining({ remaining: null }) === null);
    ok('itemRemaining null when absent', H.itemRemaining({}) === null);
    const out = H.eightySixBadge({ is_86: true, remaining: null });
    ok('badge for an out item is the 86 tag', out.includes('e86-tag') && out.includes('>86<'), out);
    const lim = H.eightySixBadge({ is_86: false, remaining: 3 });
    ok('badge for a countdown item reads "3 left"', lim.includes('e86-left') && lim.includes('3 left'), lim);
    ok('badge for an available item is empty', H.eightySixBadge({ is_86: false, remaining: null }) === '');
    ok('out wins over a stale count', H.eightySixBadge({ is_86: true, remaining: 5 }).includes('e86-tag'));
    if (api) {
      ok('helpers agree with the mapped getMenu items',
        H.itemIs86(api[0]) === true && H.itemRemaining(api[1]) === 3 && H.eightySixBadge(api[2]) === '');
    }
  }

  section('== static wiring pins ==');
  ok('getMenu mapping passes is_86 through', appSrc.includes('is_86: !!i.is_86'));
  ok('getMenu mapping passes remaining through', appSrc.includes('remaining: i.remaining != null ? i.remaining : null'));
  ok('the 86 sheet exists', appSrc.includes('function openEightySixSheet(item)'));
  ok('the sheet posts to the floor endpoint', appSrc.includes("'/api/menu/items/' + item.id + '/86'"));
  ok('tiles carry the 86 chip control', appSrc.includes('e86-chip') && appSrc.includes('data-e86'));
  ok('out tiles route to the sheet in drawItems', appSrc.includes('if (itemIs86(item)) openEightySixSheet(item); else addItemFlow(item, cat.name);'));
  ok('quick-pick routes out items to the sheet', appSrc.includes('if (itemIs86(p.item)) openEightySixSheet(p.item); else addItemFlow(p.item, p.cat);'));
  ok('addItemFlow refuses to stage an out item', appSrc.includes('if (!preset && itemIs86(item))'));
  ok('the sheet offers out / set-count / restore actions',
    appSrc.includes('id="e86-out"') && appSrc.includes('id="e86-limit"') && appSrc.includes('id="e86-restore"'));
  ok('CSS dims out tiles and styles the tags', cssSrc.includes('.item-card.is-86') && cssSrc.includes('.e86-tag') && cssSrc.includes('.e86-left') && cssSrc.includes('.e86-chip'));

  console.log('\n' + (failures === 0 ? 'HARNESS54 PASS' : 'HARNESS54 FAIL (' + failures + ')'));
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('HARNESS54 ERROR', e); process.exit(1); });
