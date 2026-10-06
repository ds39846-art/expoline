#!/usr/bin/env node
/**
 * Click-path harness for test60 (online ordering view) — drives the REAL
 * public/views/online.js end-to-end in node behind a minimal DOM stub.
 *
 * WHY: on 2026-10-06 the live browser pass found that clicking Checkout
 * on order.html did nothing. Root cause: viewCheckout() assigned
 * `h._slots = slots;` where h is a primitive string in a 'use strict'
 * file — a TypeError thrown inside paint() BEFORE innerHTML was
 * assigned, freezing the menu on screen. The line had been live since
 * 154b396 (2026-09-25). Every API suite passed because online ordering
 * works via the API, and test60's section F node-ran only the extracted
 * oloTaxCalc — nothing ever CALLED paint() on the checkout step. This
 * harness is the permanent pin for that click path: render -> add ->
 * Checkout -> slot click (the viewCheckout._slots read path) -> Back.
 *
 * DISCRIMINATION: restore the stray line in a copy of the view and run
 * `node harness60_client.js <copy>` — the checkout click throws, paint
 * never replaces the menu, and checkout_replaces_menu + the figure
 * assertions FAIL with the TypeError surfaced in `errors`.
 *
 * No jsdom in this repo (checked node_modules) — the stub below is the
 * smallest DOM the view actually touches: createElement, appendChild,
 * setAttribute, className, textContent, value, addEventListener, and
 * querySelector(All) over freshly parsed innerHTML supporting the
 * selector shapes the view uses (#id, .class, [attr], tag[attr="v"]).
 *
 * Fixture cart (hand-computed, mirrors test60 C5): 1x $20.00 inclusive
 * @7.75% (net round(2000/1.0775)=1856, included 144) + 1x $12.34 plain
 * @7.75% (round(1234*.0775)=96) -> subtotal 3234, tax 240 (144 incl),
 * Due at pickup 3234 + 240 - 144 = 3330.
 *
 * Usage: node harness60_client.js [onlineJsPath]
 */
const fs = require('fs');
const path = require('path');

const VIEW = process.argv[2] || path.join(__dirname, '..', 'public', 'views', 'online.js');

/* ---------------- minimal DOM stub ---------------- */
const VOID = new Set(['input', 'br', 'img', 'hr', 'meta', 'link']);

function parseAttrs(s) {
  const attrs = {};
  const re = /([\w-]+)(?:\s*=\s*"([^"]*)")?/g;
  let m; while ((m = re.exec(s))) attrs[m[1]] = m[2] === undefined ? '' : m[2];
  return attrs;
}
function datasetOf(attrs) {
  const d = {};
  for (const k of Object.keys(attrs)) {
    if (k.startsWith('data-')) {
      const key = k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      d[key] = attrs[k];
    }
  }
  return d;
}

class El {
  constructor(tag) {
    this.tagName = String(tag).toLowerCase();
    this.attributes = {};
    this.children = [];
    this.parent = null;
    this._listeners = {};
    this._rawHTML = null;
    this.value = '';
    this.dataset = {};
    this._text = '';
  }
  get className() { return this.attributes.class || ''; }
  set className(v) { this.attributes.class = String(v); }
  setAttribute(k, v) { this.attributes[k] = String(v); this.dataset = datasetOf(this.attributes); }
  getAttribute(k) { return k in this.attributes ? this.attributes[k] : null; }
  appendChild(c) { c.parent = this; this.children.push(c); return c; }
  addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() {
    if (this.children.length) return this.children.map((c) => c.textContent).join('');
    return this._text;
  }
  set innerHTML(html) {
    this._rawHTML = String(html);
    this.children = parseHTML(this._rawHTML);
    this.children.forEach((c) => { c.parent = this; });
  }
  get innerHTML() {
    if (this._rawHTML != null) return this._rawHTML;
    return this.children.map(serialize).join('');
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) {
    const out = [];
    const match = compileSelector(sel);
    (function walk(el) {
      for (const c of el.children) {
        if (c instanceof El) { if (match(c)) out.push(c); walk(c); }
      }
    })(this);
    return out;
  }
}
class Text {
  constructor(t) { this._text = t; this.parent = null; }
  get textContent() { return this._text; }
}
function serialize(node) {
  if (node instanceof Text) return node._text;
  const attrs = Object.entries(node.attributes).map(([k, v]) => ` ${k}="${v}"`).join('');
  if (VOID.has(node.tagName)) return `<${node.tagName}${attrs}>`;
  return `<${node.tagName}${attrs}>${node.children.map(serialize).join('')}</${node.tagName}>`;
}
function compileSelector(sel) {
  let tag = null, id = null, cls = null, attr = null, attrVal = null;
  const m = sel.match(/^([a-zA-Z][\w-]*)?(?:#([\w-]+))?(?:\.([\w-]+))?(?:\[([\w-]+)(?:="([^"]*)")?\])?$/);
  if (!m) throw new Error('unsupported selector: ' + sel);
  [, tag, id, cls, attr, attrVal] = m;
  return (el) => {
    if (tag && el.tagName !== tag.toLowerCase()) return false;
    if (id && el.attributes.id !== id) return false;
    if (cls && !(el.attributes.class || '').split(/\s+/).includes(cls)) return false;
    if (attr && !(attr in el.attributes)) return false;
    if (attr && attrVal != null && el.attributes[attr] !== attrVal) return false;
    return true;
  };
}
function parseHTML(html) {
  const roots = [];
  const stack = [];
  const re = /<(\/?)([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>|([^<]+)/g;
  let m;
  const attach = (node) => {
    const parent = stack[stack.length - 1];
    if (parent) { node.parent = parent; parent.children.push(node); }
    else roots.push(node);
  };
  while ((m = re.exec(html))) {
    if (m[5] !== undefined) { if (m[5]) attach(new Text(m[5])); continue; }
    const [, closing, tagRaw, attrStr, selfClose] = m;
    const tag = tagRaw.toLowerCase();
    if (closing) {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].tagName === tag) { stack.length = i; break; }
      }
      continue;
    }
    const el = new El(tag);
    el.attributes = parseAttrs(attrStr || '');
    el.dataset = datasetOf(el.attributes);
    if ('value' in el.attributes) el.value = el.attributes.value;
    attach(el);
    if (!selfClose && !VOID.has(tag)) stack.push(el);
  }
  return roots;
}

/* ---------------- fake api + fixture ---------------- */
const MENU = [{
  id: 1, name: 'Mains',
  items: [
    { id: 101, name: 'Incl Burger', description: 'tax already in the price',
      price_cents: 2000, effective_price_cents: 2000, hh_active: false,
      tax_inclusive: true, tax_rate_bps: null, effective_tax_rate_bps: 775, remaining: null },
    { id: 102, name: 'Plain Fries', description: '',
      price_cents: 1234, effective_price_cents: 1234, hh_active: false,
      tax_inclusive: false, tax_rate_bps: null, effective_tax_rate_bps: 775, remaining: null },
  ],
}];
const apiCalls = [];
const api = async (p, method, body) => {
  apiCalls.push(p);
  if (p === '/api/online/menu') return JSON.parse(JSON.stringify(MENU));
  throw new Error('unexpected api call in harness: ' + p);
};

/* ---------------- drive ---------------- */
const R = {};   // named assertion results for the python suite
const errors = [];
let failures = 0;
function ok(name, cond, extra) {
  R[name] = !!cond;
  if (cond) console.log('  ok  ' + name);
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')); }
}
async function click(el, label) {
  if (!el) throw new Error('click target missing: ' + label);
  const fns = el._listeners.click || [];
  if (!fns.length) throw new Error('no click listener on: ' + label);
  for (const fn of fns) await fn({ preventDefault() {}, target: el });
}

(async () => {
  global.document = { createElement: (t) => new El(t) };
  const { renderOnlineOrder } = require(path.resolve(VIEW));
  const container = new El('div');
  const wrap = () => container.querySelector('.olo-wrap');
  const html = () => (wrap() ? wrap().innerHTML : '');

  try {
    await renderOnlineOrder(container, api);
    ok('menu_renders_both_items',
      html().includes('Incl Burger') && html().includes('Plain Fries'));

    // add one of each via the REAL stepper wiring
    await click(wrap().querySelector('[data-inc="101"]'), 'inc 101');
    await click(wrap().querySelector('[data-inc="102"]'), 'inc 102');
    const coBtn = wrap().querySelector('#olo-checkout-btn');
    ok('checkout_button_appears_after_adds',
      !!coBtn && html().includes('$32.34'));

    // THE click that froze for 11 days: menu -> checkout
    await click(coBtn, 'checkout');
    ok('checkout_replaces_menu',
      !!wrap().querySelector('#olo-place-btn')
        && wrap().querySelectorAll('[data-inc]').length === 0);
    ok('subtotal_figure_3234', html().includes('Subtotal') && html().includes('$32.34'));
    ok('tax_figure_240', html().includes('Tax') && html().includes('$2.40'));
    ok('includes_row_144', html().includes('includes $1.44 tax in prices'));
    ok('due_figure_3330', html().includes('Due at pickup') && html().includes('$33.30'));

    // slot click exercises the viewCheckout._slots read path
    const slotBtns = wrap().querySelectorAll('[data-slot]');
    await click(slotBtns[1], 'slot 1');
    const slotBtns2 = wrap().querySelectorAll('[data-slot]');
    ok('slot_click_uses_stash',
      !!wrap().querySelector('#olo-place-btn')
        && (slotBtns2[1].attributes.class || '').split(/\s+/).includes('sel')
        && html().includes('$33.30'));

    // back to menu, cart preserved
    await click(wrap().querySelector('#olo-back-btn'), 'back');
    ok('back_returns_to_menu_cart_kept',
      wrap().querySelectorAll('[data-inc]').length === 2
        && html().includes('Incl Burger') && html().includes('Plain Fries')
        && !!wrap().querySelector('#olo-checkout-btn') && html().includes('$32.34'));

    ok('no_unexpected_api_calls', apiCalls.length === 1 && apiCalls[0] === '/api/online/menu',
      apiCalls.join(','));
    ok('drive_completed_without_throw', errors.length === 0, errors.join(' | '));
  } catch (e) {
    errors.push(String((e && e.stack) || e));
    for (const k of ['menu_renders_both_items', 'checkout_button_appears_after_adds',
      'checkout_replaces_menu', 'subtotal_figure_3234', 'tax_figure_240',
      'includes_row_144', 'due_figure_3330', 'slot_click_uses_stash',
      'back_returns_to_menu_cart_kept', 'no_unexpected_api_calls',
      'drive_completed_without_throw']) {
      if (!(k in R)) ok(k, false, 'drive aborted: ' + errors[0].split('\n')[0]);
    }
  }

  const passed = Object.values(R).filter(Boolean).length;
  console.log(`\nharness60_client: ${passed} passed, ${failures} failed`);
  if (errors.length) console.log('ERRORS: ' + errors.join('\n---\n'));
  console.log('@@RESULT@@' + JSON.stringify(R));
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.log('harness60_client: crashed — ' + ((e && e.stack) || e));
  console.log('@@RESULT@@{}');
  process.exit(1);
});
