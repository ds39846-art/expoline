#!/usr/bin/env node
/* harness35_client.js — headless driver for qa/test35_client_regressions.py.
 *
 * Extracts the REAL functions from public/app.js (getMenu, addItemFlow,
 * the #btn-hold handler) by brace matching and executes them in vm
 * contexts against a stub api / minimal DOM shim. Nothing here is a copy
 * of the logic under test — if app.js changes shape, extraction fails
 * loudly instead of silently testing a reimplementation.
 *
 * Usage: node harness35_client.js <app.js path> <menu payload json path>
 * Prints one JSON line: { assertions: [{id, name, pass, detail}], ... }
 */
'use strict';
const fs = require('fs');
const vm = require('vm');

const appJsPath = process.argv[2];
const payloadPath = process.argv[3];
const src = fs.readFileSync(appJsPath, 'utf8');
const payload = JSON.parse(fs.readFileSync(payloadPath, 'utf8'));

const assertions = [];
function ok(id, name, cond, detail) {
  assertions.push({ id, name, pass: !!cond, detail: detail || '' });
}

/* ------------------------- source extraction ------------------------- */
/* Brace matcher that understands strings, template literals (with ${}
 * nesting) and comments. The extracted regions contain no regex
 * literals, which is the one construct this scanner does not track. */
function extractFrom(srcText, anchor) {
  const i = srcText.indexOf(anchor);
  if (i < 0) throw new Error('anchor not found: ' + anchor);
  const open = srcText.indexOf('{', i);
  if (open < 0) throw new Error('no opening brace after anchor: ' + anchor);
  const frames = [{ kind: 'code', braces: 1 }];
  let j = open + 1;
  while (j < srcText.length) {
    const c = srcText[j];
    const top = frames[frames.length - 1];
    if (top.kind === 'code') {
      if (c === '/' && srcText[j + 1] === '/') { const nl = srcText.indexOf('\n', j); j = nl < 0 ? srcText.length : nl; continue; }
      if (c === '/' && srcText[j + 1] === '*') { const e = srcText.indexOf('*/', j + 2); j = e < 0 ? srcText.length : e + 2; continue; }
      if (c === "'") frames.push({ kind: 'str', q: "'" });
      else if (c === '"') frames.push({ kind: 'str', q: '"' });
      else if (c === '`') frames.push({ kind: 'tpl' });
      else if (c === '{') top.braces++;
      else if (c === '}') {
        top.braces--;
        if (top.braces === 0) {
          frames.pop();
          if (!frames.length) return srcText.slice(i, j + 1);
        }
      }
    } else if (top.kind === 'str') {
      if (c === '\\') j++;
      else if (c === top.q) frames.pop();
    } else if (top.kind === 'tpl') {
      if (c === '\\') j++;
      else if (c === '`') frames.pop();
      else if (c === '$' && srcText[j + 1] === '{') { frames.push({ kind: 'code', braces: 1 }); j++; }
    }
    j++;
  }
  throw new Error('unbalanced extraction for anchor: ' + anchor);
}

const getMenuSrc = extractFrom(src, 'async function getMenu(');
const addItemFlowSrc = extractFrom(src, 'function addItemFlow(');
/* addItemFlow renders its course picker from the module-level ME_COURSES
 * const (test40, WS-A) — extracted flows need it in scope, exactly like
 * the real module provides. */
const meCoursesSrc = (src.match(/const ME_COURSES = \[[^\]]*\];/) || [''])[0];
let holdSrc = extractFrom(src, "$('#btn-hold').onclick");
const apiErrorSrc = (src.match(/^class ApiError .*$/m) || [])[0];
if (!apiErrorSrc) throw new Error('ApiError class line not found');

/* --------------------------- minimal DOM ----------------------------- */
/* Just enough of the DOM for addItemFlow's modal: a flat element list
 * built by tokenizing the generated HTML, div ancestry for descendant
 * selectors, dataset/checked/value/style, and change listeners on the
 * backdrop. Selectors supported: tag, #id, .class, [attr], [attr="v"],
 * :checked, one descendant combinator, comma lists. */
function parseAttrs(attrText) {
  const attrs = {};
  const re = /([a-zA-Z][\w-]*)(?:\s*=\s*"([^"]*)")?/g;
  let m;
  while ((m = re.exec(attrText))) attrs[m[1]] = m[2] !== undefined ? m[2] : '';
  return attrs;
}
function toDataset(attrs) {
  const ds = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('data-')) ds[k.slice(5).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase())] = v;
  }
  return ds;
}
function buildBd(html) {
  const bd = { _els: [], _listeners: {}, addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); } };
  const tagRe = /<(\/?)([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  const divStack = [];
  let m;
  while ((m = tagRe.exec(html))) {
    const [, closing, tag, attrText] = m;
    if (closing) {
      if (tag === 'div') divStack.pop();
      continue;
    }
    const attrs = parseAttrs(attrText || '');
    const el = {
      tag, attrs, id: attrs.id || null,
      classes: new Set((attrs.class || '').split(/\s+/).filter(Boolean)),
      dataset: toDataset(attrs),
      checked: 'checked' in attrs,
      disabled: 'disabled' in attrs,
      value: attrs.value !== undefined ? attrs.value : '',
      style: { display: /display\s*:\s*none/.test(attrs.style || '') ? 'none' : '' },
      textContent: '', onclick: null, onchange: null,
      ancestors: divStack.slice(),
    };
    bd._els.push(el);
    if (tag === 'div') divStack.push(el);
  }
  return bd;
}
function parseCompound(s) {
  const comp = { tag: null, id: null, classes: [], attrs: [], checked: false };
  const re = /(^[a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]|(:checked)/g;
  let m;
  while ((m = re.exec(s))) {
    if (m[1]) comp.tag = m[1];
    else if (m[2]) comp.id = m[2];
    else if (m[3]) comp.classes.push(m[3]);
    else if (m[4]) comp.attrs.push([m[4], m[5]]);
    else if (m[6]) comp.checked = true;
  }
  return comp;
}
function matchCompound(el, comp) {
  if (comp.tag && el.tag !== comp.tag) return false;
  if (comp.id && el.id !== comp.id) return false;
  for (const cl of comp.classes) if (!el.classes.has(cl)) return false;
  for (const [k, v] of comp.attrs) {
    if (!(k in el.attrs)) return false;
    if (v !== undefined && el.attrs[k] !== v) return false;
  }
  if (comp.checked && !el.checked) return false;
  return true;
}
function queryAll(bd, sel) {
  const out = [];
  for (const part of sel.split(',')) {
    const comps = part.trim().split(/\s+/).map(parseCompound);
    for (const el of bd._els) {
      if (!matchCompound(el, comps[comps.length - 1])) continue;
      if (comps.length === 2 && !el.ancestors.some((a) => matchCompound(a, comps[0]))) continue;
      if (!out.includes(el)) out.push(el);
    }
  }
  return out;
}
const q1 = (sel, root) => queryAll(root, sel)[0] || null;
function userCheck(bd, el) {
  el.checked = true;
  for (const fn of bd._listeners.change || []) fn({ target: el });
}

/* ------------------------------ contexts ------------------------------ */
function baseCtx() {
  const ctx = {
    console,
    esc: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
    fmt: (cents) => '$' + ((Number(cents) || 0) / 100).toFixed(2),
  };
  vm.createContext(ctx);
  return ctx;
}

async function main() {
  /* ---------- A. getMenu pass-through (modifier_groups + popular) ---------- */
  const menuCtx = baseCtx();
  menuCtx.api = async () => JSON.parse(JSON.stringify(payload));
  vm.runInContext(getMenuSrc + '\nglobalThis.__getMenu = getMenu;', menuCtx);
  const menu = await menuCtx.__getMenu();
  const flat = [];
  for (const c of menu) for (const i of c.items || []) flat.push(i);
  const byName = (n) => flat.find((i) => i.name === n);
  const ribeye = byName('14oz Ribeye');
  const edamame = byName('Edamame');
  const fries = byName('Bali Fries');
  ok('A1', 'getMenu: Ribeye item present', !!ribeye);
  const rGroups = (ribeye && ribeye.modifier_groups) || [];
  ok('A2', 'getMenu: Ribeye carries modifier_groups', Array.isArray(ribeye && ribeye.modifier_groups) && rGroups.length === 1,
    'got ' + JSON.stringify(ribeye && ribeye.modifier_groups));
  const temp = rGroups[0] || {};
  ok('A3', 'getMenu: Temperature group shape (name/required/5 options)',
    temp.name === 'Temperature' && !!temp.required && (temp.options || []).length === 5,
    'got name=' + temp.name + ' required=' + temp.required + ' options=' + ((temp.options || []).length));
  const med = (temp.options || []).find((o) => o.name === 'Medium');
  ok('A4', 'getMenu: Medium option keeps is_default', !!med && !!med.is_default);
  const eGroups = (edamame && edamame.modifier_groups) || [];
  ok('A5', 'getMenu: Edamame Flavor group (4 options)',
    eGroups.length === 1 && eGroups[0].name === 'Flavor' && (eGroups[0].options || []).length === 4,
    'got ' + JSON.stringify(eGroups.map((g) => g.name)));
  ok('A6', 'getMenu: popular flag passes through (Bali Fries flagged in fixture)',
    !!fries && fries.popular === true, 'got ' + (fries && fries.popular));
  /* Probe item must stay unflagged in the seed: batch 4 flags Bali Fries,
   * Edamame, the Ribeye, and BH Mai Tai as quick-pick favorites, so the
   * Ribeye can no longer serve as the unflagged control here. */
  const unflagged = byName('Coconut Shrimp');
  ok('A7', 'getMenu: unflagged items stay popular=false', !!unflagged && unflagged.popular === false,
    'got ' + (unflagged && unflagged.popular));

  /* ---------- B. addItemFlow pick-1 radio semantics ---------- */
  function flowCase(item, catName, prefix, groupIdx, defaultName, pickName) {
    const ctx = baseCtx();
    const toasts = [];
    const stagedCalls = [];
    let bd = null;
    ctx.$ = q1;
    ctx.$$ = (sel, root) => queryAll(root, sel);
    ctx.openModal = (html) => { bd = buildBd(html); return bd; };
    ctx.closeModal = () => {};
    ctx.toast = (msg, kind) => toasts.push({ msg, kind });
    ctx.stageItem = (it, modifiers, qty, extra) => stagedCalls.push({ name: it.name, modifiers, qty, extra });
    ctx.itemModifiers = (it) => it.modifiers || [];
    ctx.isDrink = () => false;
    ctx.PO = { tappableValue: () => {} };
    /* Scope the modal-seat logic (test40 WS-A) touches: the guest count
       the seat stepper clamps to and the grow-path helpers. With the
       working seat inside the count, Add never reaches the PATCH path. */
    ctx.setSeat = () => {};
    ctx.isOffline = () => false;
    ctx.realId = (id) => id;
    ctx.api = async () => ({});
    ctx.getCheckView = async () => null;
    ctx.handleApiError = (e) => { throw e; };
    ctx.paintGuests = () => {};
    vm.runInContext('var seat = 1; var guests = 4;', ctx);
    if (meCoursesSrc) vm.runInContext(meCoursesSrc, ctx);
    vm.runInContext(addItemFlowSrc + '\nglobalThis.__addItemFlow = addItemFlow;', ctx);
    ctx.__addItemFlow(item, catName);
    ok(prefix + '1', `addItemFlow(${item.name}): modifier modal opens (no instant stage)`,
      !!bd && stagedCalls.length === 0, 'stagedCalls=' + stagedCalls.length + ' bd=' + !!bd);
    if (!bd) return;
    const boxes = queryAll(bd, '.mod-group input[data-g="' + groupIdx + '"]');
    const group = item.modifier_groups[groupIdx];
    const optIdx = (name) => group.options.findIndex((o) => o.name === name);
    const checkedIdx = () => boxes.filter((b) => b.checked).map((b) => Number(b.dataset.o));
    const before = checkedIdx();
    ok(prefix + '2', `addItemFlow(${item.name}): default "${defaultName}" is the only pre-check`,
      before.length === 1 && before[0] === optIdx(defaultName), 'checked=' + JSON.stringify(before));
    const pickBox = boxes.find((b) => Number(b.dataset.o) === optIdx(pickName));
    userCheck(bd, pickBox);
    const after = checkedIdx();
    ok(prefix + '3', `addItemFlow(${item.name}): selecting "${pickName}" unchecks "${defaultName}" (exactly one checked)`,
      after.length === 1 && after[0] === optIdx(pickName), 'checked=' + JSON.stringify(after));
    const addBtn = queryAll(bd, '[data-x="add"]')[0];
    if (addBtn && addBtn.onclick) addBtn.onclick();
    const mods = stagedCalls.length ? (stagedCalls[0].modifiers || []).map((x) => x.name) : [];
    ok(prefix + '4', `addItemFlow(${item.name}): Add stages exactly ["${pickName}"]`,
      stagedCalls.length === 1 && mods.length === 1 && mods[0] === pickName,
      'staged=' + JSON.stringify(stagedCalls.map((s) => (s.modifiers || []).map((x) => x.name))) +
      ' toasts=' + JSON.stringify(toasts.map((t) => t.msg)));
  }
  if (ribeye && rGroups.length) flowCase(ribeye, 'Aina', 'B', 0, 'Medium', 'Medium Rare');
  else { ok('B0', 'addItemFlow(Ribeye): skipped — no groups on mapped item', false, 'modifier_groups missing (see A2)'); }
  if (edamame && eGroups.length) flowCase(edamame, 'Pupus', 'C', 0, 'Sea Salt', 'Spicy Chili Garlic');
  else { ok('C0', 'addItemFlow(Edamame): skipped — no groups on mapped item', false, 'modifier_groups missing (see A5)'); }

  /* ---------- D. HOLD failure preservation ---------- */
  function holdCtx() {
    const ctx = baseCtx();
    const rec = { toasts: [], saves: [], apiCalls: [], apiErrors: [] };
    const holdBtn = {};
    ctx.__rec = rec;
    ctx.__holdBtn = holdBtn;
    ctx.$ = (sel) => (sel === '#btn-hold' ? holdBtn : null);
    ctx.localStorage = { _m: {}, getItem(k) { return k in this._m ? this._m[k] : null; }, setItem(k, v) { this._m[k] = String(v); }, removeItem(k) { delete this._m[k]; } };
    ctx.Outbox = { enqueue: async () => {} };
    ctx.isOffline = () => false;
    ctx.realId = (x) => x;
    ctx.renderRoute = () => {};
    ctx.toast = (msg, kind) => rec.toasts.push({ msg, kind });
    ctx.handleApiError = (e) => rec.apiErrors.push(String((e && e.message) || e));
    ctx.saveStaged = (cid, arr) => rec.saves.push(JSON.parse(JSON.stringify(arr)));
    vm.runInContext(apiErrorSrc, ctx);
    vm.runInContext('globalThis.__mkErr = (s, m) => new ApiError(s, m);', ctx);
    vm.runInContext('let staged = []; let checkId = 7;', ctx);
    vm.runInContext(holdSrc, ctx);
    return { ctx, rec, holdBtn };
  }
  const stagedFixture = () => ([
    { temp_id: 'st-1', menu_item_id: 101, name: 'One', price_cents: 100, seat: 1, qty: 1, modifiers: [], note: null, allergy: false, allergy_detail: null },
    { temp_id: 'st-2', menu_item_id: 102, name: 'Two', price_cents: 200, seat: 1, qty: 1, modifiers: [], note: null, allergy: false, allergy_detail: null },
    { temp_id: 'st-3', menu_item_id: 103, name: 'Three', price_cents: 300, seat: 2, qty: 2, modifiers: [], note: null, allergy: false, allergy_detail: null },
  ]);
  { // Case A: the SECOND item's POST is rejected (e.g. missing required group)
    const { ctx, rec, holdBtn } = holdCtx();
    ctx.api = async (path, method, body) => {
      rec.apiCalls.push(body);
      if (rec.apiCalls.length === 2) throw ctx.__mkErr(400, 'Temperature: please choose at least one');
      return {};
    };
    vm.runInContext('staged = ' + JSON.stringify(stagedFixture()) + ';', ctx);
    await holdBtn.onclick();
    const remaining = vm.runInContext('staged.map((s) => s.temp_id)', ctx);
    ok('D1', 'HOLD failure: failed + unattempted lines stay staged',
      JSON.stringify(remaining) === JSON.stringify(['st-2', 'st-3']), 'remaining=' + JSON.stringify(remaining));
    const lastSave = rec.saves.length ? rec.saves[rec.saves.length - 1].map((s) => s.temp_id) : null;
    ok('D2', 'HOLD failure: persisted staged state matches (not wiped)',
      JSON.stringify(lastSave) === JSON.stringify(['st-2', 'st-3']), 'lastSave=' + JSON.stringify(lastSave) + ' saves=' + rec.saves.length);
    ok('D3', 'HOLD failure: honest toast (1 held · attention + server message)',
      rec.toasts.some((t) => t.kind === 'err' && /1 held/.test(t.msg) && /attention/.test(t.msg) && /Temperature/.test(t.msg)),
      'toasts=' + JSON.stringify(rec.toasts));
    ok('D4', 'HOLD failure: loop stops at the rejection (2 POSTs attempted)',
      rec.apiCalls.length === 2, 'calls=' + rec.apiCalls.length);
  }
  { // Case B: everything confirms — staged empties, success toast unchanged
    const { ctx, rec, holdBtn } = holdCtx();
    ctx.api = async (path, method, body) => { rec.apiCalls.push(body); return {}; };
    vm.runInContext('staged = ' + JSON.stringify(stagedFixture()) + ';', ctx);
    await holdBtn.onclick();
    const remaining = vm.runInContext('staged.length', ctx);
    const lastSave = rec.saves.length ? rec.saves[rec.saves.length - 1] : null;
    ok('D5', 'HOLD success: staged empties and persists empty',
      remaining === 0 && Array.isArray(lastSave) && lastSave.length === 0,
      'remaining=' + remaining + ' lastSave=' + JSON.stringify(lastSave));
    ok('D6', 'HOLD success: success toast preserved',
      rec.toasts.some((t) => t.kind === 'ok' && t.msg === '3 items held'), 'toasts=' + JSON.stringify(rec.toasts));
  }

  const failed = assertions.filter((a) => !a.pass);
  console.log(JSON.stringify({ assertions, total: assertions.length, passed: assertions.length - failed.length, failed: failed.length }));
}

main().catch((e) => {
  console.log(JSON.stringify({ assertions, total: assertions.length, passed: assertions.filter((a) => a.pass).length, failed: assertions.filter((a) => !a.pass).length, harnessError: String(e && e.stack || e) }));
  process.exit(2);
});
