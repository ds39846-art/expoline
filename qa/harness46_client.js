#!/usr/bin/env node
/**
 * Extracted-REAL-function harness for test46 (happy-hour pricing).
 *
 * Runs the REAL client price helpers — extracted verbatim out of the
 * shipped public/app.js — so a display-wiring regression fails here:
 *   A  dispPrice: during HH an item with an HH price displays its
 *      effective (HH) price; an item without one displays the regular
 *      price; outside HH everything displays the regular price.
 *   B  priceHtml: during HH the card cell leads with the HH price,
 *      strikes the regular price, and carries the HH badge; outside HH
 *      it is the plain price cell, byte-identical in shape to before.
 *
 * Usage: node harness46_client.js [appJsPath]
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

/* Extract an expression-bodied arrow const: scan from "const NAME =" to
   the semicolon at paren depth 0, respecting strings and templates. */
function extractConstExpr(src, name) {
  const marker = 'const ' + name + ' =';
  const mstart = src.indexOf(marker);
  if (mstart < 0) throw new Error('const not found: ' + name);
  let i = src.indexOf('=>', mstart) + 2;
  let depth = 0, str = null, esc = false;
  for (; i < src.length; i++) {
    const c = src[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (str) { if (c === str) str = null; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 1; continue; }
    if (c === '/' && src[i + 1] === '/') { const e = src.indexOf('\n', i + 2); i = e < 0 ? src.length : e; continue; }
    if (c === "'" || c === '"' || c === '`') { str = c; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ';' && depth === 0) return src.slice(mstart, i + 1);
  }
  throw new Error('unterminated const: ' + name);
}

const ctx = { console };
vm.createContext(ctx);
for (const n of ['fmt', 'dispPrice', 'priceHtml']) {
  vm.runInContext(extractConstExpr(appSrc, n), ctx);
}
const call = (expr) => vm.runInContext(expr, ctx);

const HH_ITEM = { price_cents: 1450, hh_price_cents: 900, effective_price_cents: 900, hh_active: true };
const PLAIN_IN_HH = { price_cents: 600, hh_price_cents: null, effective_price_cents: 600, hh_active: false };
const OFF_ITEM = { price_cents: 1450, hh_price_cents: 900, effective_price_cents: 1450, hh_active: false };

section('A. dispPrice — the price the screen shows is the price the server charges');
ctx.__a = HH_ITEM; ctx.__b = PLAIN_IN_HH; ctx.__c = OFF_ITEM;
ok('A1 during HH an HH item displays 900', call('dispPrice(__a)') === 900, call('dispPrice(__a)'));
ok('A2 during HH a no-HH item displays its regular 600', call('dispPrice(__b)') === 600, call('dispPrice(__b)'));
ok('A3 outside HH the same HH item displays 1450', call('dispPrice(__c)') === 1450, call('dispPrice(__c)'));

section('B. priceHtml — HH badge + struck regular price during the window only');
const hhHtml = call('priceHtml(__a)');
ok('B1 the HH cell shows the HH price', hhHtml.includes('$9.00'), hhHtml);
ok('B2 the HH cell strikes the regular price', hhHtml.includes('<s class="pr-was">$14.50</s>'), hhHtml);
ok('B3 the HH cell carries the HH badge', hhHtml.includes('<span class="hh-tag">HH</span>'), hhHtml);
const offHtml = call('priceHtml(__c)');
ok('B4 outside HH the cell is the plain price, no badge', offHtml === '<span class="pr">$14.50</span>', offHtml);
const plainHtml = call('priceHtml(__b)');
ok('B5 a no-HH item during HH renders the plain price cell', plainHtml === '<span class="pr">$6.00</span>', plainHtml);

console.log(failures ? '\n' + failures + ' FAILURES' : '\nALL PASS');
process.exit(failures ? 1 : 0);
