#!/usr/bin/env node
/**
 * Extracted-REAL-function harness for test40 (server-flow frictions).
 *
 * Runs the REAL functions — brace-matched verbatim out of the shipped
 * files, the harness35 pattern — so a wiring regression fails here, not
 * in production:
 *   - getMenu / addItemFlow / stageItem / #btn-hold handler (app.js)
 *   - quickBarHtml / tappableValue + COURSE_LIST (views/parity_orders.js)
 *
 * Cases:
 *   E  getMenu passes item.course through (the 2026-10-03 strip class).
 *   F  addItemFlow: course picker present, defaults to the item's menu
 *      course, chosen course lands on the staged line; seat stepper
 *      moves the staged line's seat; Modify preset pre-loads an existing
 *      group selection; a staged line with NO group selection can gain
 *      one in the editor (the WS-C case).
 *   G  HOLD posts course per line (explicit null rides; a legacy staged
 *      line without the key omits it, keeping the server menu default).
 *   H  quickBarHtml: course pills for staged/held, active pill marked,
 *      no pills when canCourse is false; the editor entry says Modify.
 *   I  tappableValue guest typing: valid apply, invalid entries bounce
 *      with the exact 1..24 toast and never apply.
 *
 * Usage: node harness40_client.js <menu-payload.json> [appJsPath] [parityOrdersPath]
 */
const fs = require('fs');
const vm = require('vm');

const payload = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const APP_JS = process.argv[3] || __dirname + '/../public/app.js';
const PO_JS = process.argv[4] || __dirname + '/../public/views/parity_orders.js';
const appSrc = fs.readFileSync(APP_JS, 'utf8');
const poSrc = fs.readFileSync(PO_JS, 'utf8');

let failures = 0;
function ok(name, cond, extra) {
  if (cond) console.log('  ok  ' + name);
  else { failures++; console.log('  FAIL ' + name + (extra !== undefined ? ' — ' + extra : '')); }
}
function section(s) { console.log('\n' + s); }

/* ---------- extraction (balanced-brace, harness35 machinery) ---------- */
function extractFn(src, name) {
  let start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('function not found: ' + name);
  if (src.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;
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
  throw new Error('unterminated: ' + name);
}
function extractConstFn(src, name) {
  const marker = 'const ' + name + ' =';
  const mstart = src.indexOf(marker);
  if (mstart < 0) throw new Error('const fn not found: ' + name);
  let i = src.indexOf('=>', mstart);
  i = src.indexOf('{', i);
  let depth = 0, str = null, esc = false, tpl = 0;
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
    else if (c === '}') { depth--; if (depth === 0) return src.slice(mstart, i + 2); }
  }
  throw new Error('unterminated const fn: ' + name);
}
function extractBlock(src, marker) {
  const start = src.indexOf(marker);
  if (start < 0) throw new Error('marker not found: ' + marker);
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
  throw new Error('unterminated block: ' + marker);
}
function extractLine(src, re, what) {
  const m = src.match(re);
  if (!m) throw new Error('line not found: ' + what);
  return m[0];
}

/* ---------- modal DOM shim (same flat model as harness35) ---------- */
function parseAttrs(tagInner) {
  const attrs = {};
  const re = /([a-zA-Z_-][\w-]*)(\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g;
  let m;
  while ((m = re.exec(tagInner))) attrs[m[1]] = m[3] === undefined ? true : m[3].replace(/^['"]|['"]$/g, '');
  return attrs;
}
function makeEl(tag, attrs, text) {
  const el = {
    tagName: tag.toUpperCase(), attrs, dataset: {}, children: [],
    _text: text || '', value: attrs.value !== undefined ? attrs.value : '',
    checked: 'checked' in attrs, disabled: 'disabled' in attrs, style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    className: attrs.class || '',
    setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    addEventListener() {}, focus() {}, click() { if (this.onclick) this.onclick(); },
  };
  /* dataset mirrors data-* attributes, camelCased like the real DOM. */
  for (const k of Object.keys(attrs)) {
    if (k.startsWith('data-')) {
      el.dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = attrs[k];
    }
  }
  Object.defineProperty(el, 'textContent', {
    get() { return this._text; },
    set(v) { this._text = String(v); this.children = []; },
  });
  Object.defineProperty(el, 'innerHTML', { get() { return ''; }, set() {} });
  return el;
}
function buildBd(html) {
  const els = [];
  const tagRe = /<(input|button|select|option|span|div|textarea|label|h2|p)\b([^>]*)>([^<]*)/g;
  let m;
  while ((m = tagRe.exec(html))) els.push(makeEl(m[1], parseAttrs(m[2]), m[3]));
  /* Generalized matcher: flat model, so a descendant selector matches on
     its LAST compound (tag / #id / .class / [attr] / [attr="v"], optional
     :checked suffix) — every element the real flows query this way is
     identifiable by that compound alone. */
  const matches = (el, sel) => {
    let s = sel.trim();
    let needChecked = false;
    if (s.endsWith(':checked')) { needChecked = true; s = s.slice(0, -':checked'.length); }
    const parts = s.split(/\s+/);
    s = parts[parts.length - 1];
    if (needChecked && !el.checked) return false;
    if (!s) return true;
    const idM = s.match(/#([\w-]+)/);
    if (idM) return el.attrs.id === idM[1];
    const attrM = s.match(/\[([\w-]+)(?:="([^"]*)")?\]/);
    const clsM = s.match(/\.([\w-]+)/);
    const tagM = s.match(/^[a-zA-Z][\w-]*/);
    if (tagM && el.tagName !== tagM[0].toUpperCase()) return false;
    if (clsM && !(el.attrs.class || '').split(/\s+/).includes(clsM[1])) return false;
    if (attrM) {
      const v = el.attrs[attrM[1]];
      if (v === undefined) return false;
      if (attrM[2] !== undefined && String(v) !== attrM[2]) return false;
    }
    return !!(tagM || clsM || attrM);
  };
  const bd = {
    _els: els,
    _listeners: {},
    addEventListener(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); },
    querySelector(sel) { return sel.split(',').flatMap((p) => els.filter((e) => matches(e, p)))[0] || null; },
    querySelectorAll(sel) { return sel.split(',').flatMap((p) => els.filter((e) => matches(e, p))); },
  };
  /* A real <select> reports the selected option's value (else the
     first option's). Mirror that from the flat element stream: options
     following a select belong to it until the next select. */
  els.forEach((e, i) => {
    if (e.tagName !== 'SELECT') return;
    const opts = [];
    for (let j = i + 1; j < els.length && els[j].tagName !== 'SELECT'; j++) {
      if (els[j].tagName === 'OPTION') opts.push(els[j]);
    }
    const sel = opts.find((o) => o.attrs.selected !== undefined) || opts[0];
    if (sel) e.value = sel.attrs.value !== undefined ? sel.attrs.value : '';
  });
  els.forEach((e) => { e._bd = bd; });
  return bd;
}

/* ---------- shared fixture helpers ---------- */
const categories = payload.categories || [];
const allItems = categories.flatMap((c) => (c.items || []).map((it) => ({ ...it, _cat: c.name })));
const byName = (n) => allItems.find((i) => i.name === n);
const ribeye = byName('14oz Ribeye');
const edamame = byName('Edamame');
if (!ribeye || !edamame) { console.log('fixture menu missing Ribeye/Edamame'); process.exit(2); }
const flavorGroup = (edamame.modifier_groups || []).find((g) => g.name === 'Flavor');
const tempGroup = (ribeye.modifier_groups || []).find((g) => g.name === 'Temperature');
if (!flavorGroup || !tempGroup) { console.log('fixture menu missing modifier groups'); process.exit(2); }
const opt = (g, n) => g.options.find((o) => o.name === n);

const PO_REAL = {};
function loadPO() {
  const ctx = { console, window: {}, document: { querySelector: () => null, querySelectorAll: () => [], createElement: () => ({}) } };
  ctx.window.document = ctx.document;
  vm.createContext(ctx);
  try {
    vm.runInContext(extractLine(poSrc, /const COURSE_LIST = \[[^\]]*\];/, 'COURSE_LIST'), ctx);
  } catch (e) {
    /* Control runs against f841f4b: the shared list is part of this
       change, so it is absent there. The fallback lets the run proceed
       so E/F/G/H fail on their own merits instead of at load time. */
    vm.runInContext("const COURSE_LIST = ['drink', 'appetizer', 'entree', 'dessert'];", ctx);
  }
  vm.runInContext(extractFn(poSrc, 'quickBarHtml'), ctx);
  vm.runInContext(extractFn(poSrc, 'tappableValue'), ctx);
  PO_REAL.ctx = ctx;
}

(async function main() {
loadPO();
/* =============== E: getMenu course pass-through =============== */
section('E. getMenu() passes item.course through');
{
  const ctx = {
    api: async () => payload, console,
  };
  vm.createContext(ctx);
  vm.runInContext(extractFn(appSrc, 'getMenu'), ctx);
  const menu = await vm.runInContext('getMenu()', ctx);
  const flat = menu.flatMap((c) => c.items);
  const mism = flat.filter((mi) => {
    const raw = allItems.find((i) => i.id === mi.id);
    return mi.course !== (raw.course || null);
  });
  ok('E1 every mapped item carries its payload course (or null)', mism.length === 0,
    mism.slice(0, 3).map((m) => m.name + '=' + m.course).join(','));
  const r = flat.find((i) => i.name === '14oz Ribeye');
  ok('E2 Ribeye mapped course is a real course value', typeof r.course === 'string' && r.course.length > 0, String(r.course));
}

/* =============== F: addItemFlow course/seat + Modify presets =============== */
section('F. addItemFlow — course picker, seat stepper, Modify preset plumbing');
{
  const toasts = [];
  const seatCalls = [];
  const ctx = {
    console, menu: [], activeCat: null,
    esc: (s) => String(s == null ? '' : s),
    fmt: (c) => '$' + ((Number(c) || 0) / 100).toFixed(2),
    dispPrice: (item) => (item && item.effective_price_cents != null ? item.effective_price_cents : (item ? item.price_cents : 0)), /* mirror of the real helper — harness46 pins the real one */
    $: (sel, root) => (root || ctx.__bd).querySelector(sel),
    $$: (sel, root) => (root || ctx.__bd).querySelectorAll(sel),
    toast: (m) => toasts.push(m),
    uid: (() => { let n = 0; return () => 'tmp-h' + (++n); })(),
    isDrink: () => false,
    itemModifiers: () => [],
    openModal: (html) => { ctx.__bd = buildBd(html); return ctx.__bd; },
    closeModal: () => {},
    saveStaged: () => {}, drawCart: () => {}, paintGuests: () => {},
    isOffline: () => false, realId: (id) => id,
    api: async () => ({}), getCheckView: async () => null,
    handleApiError: (e) => { throw e; },
    PO: { tappableValue: PO_REAL.ctx.tappableValue },
    __seatCalls: seatCalls,
  };
  vm.createContext(ctx);
  vm.runInContext('var seat = 1; var guests = 4; var staged = []; var checkId = 4242;' +
    'function setSeat(s){ seat = s; __seatCalls.push(s); }', ctx);
  vm.runInContext(extractLine(appSrc, /const ME_COURSES = \[[^\]]*\];/, 'ME_COURSES'), ctx);
  /* test54 (86 from the floor): addItemFlow consults the real itemIs86
     tile helper at its head — extract the REAL line too. */
  vm.runInContext(extractLine(appSrc, /const itemIs86 = \(item\) => [^;]+;/, 'itemIs86'), ctx);
  vm.runInContext(extractFn(appSrc, 'stageItem'), ctx);
  vm.runInContext(extractFn(appSrc, 'addItemFlow'), ctx);
  const getMenuCtx = { api: async () => payload, console };
  vm.createContext(getMenuCtx);
  vm.runInContext(extractFn(appSrc, 'getMenu'), getMenuCtx);
  const mapped = await vm.runInContext('getMenu()', getMenuCtx);
  const mRibeye = mapped.flatMap((c) => c.items).find((i) => i.name === '14oz Ribeye');
  const mEdamame = mapped.flatMap((c) => c.items).find((i) => i.name === 'Edamame');

  const courseSel = () => ctx.__bd.querySelector('#m-course');
  const selectedCourse = () => {
    const opts = ctx.__bd._els.filter((e) => e.tagName === 'OPTION');
    const sel = opts.find((o) => o.attrs.selected !== undefined);
    return sel ? sel.attrs.value : undefined;
  };
  const addBtn = () => ctx.__bd.querySelector('[data-x="add"]');
  /* A group option's checkbox is the input right before its .mn name
     span in modRow's markup. Checking one fires the modal's real
     'change' listeners (single-pick enforcement, note-field reveal). */
  const groupBox = (name) => {
    const els = ctx.__bd._els;
    const idx = els.findIndex((e) => e.tagName === 'SPAN' &&
      (e.attrs.class || '').split(/\s+/).includes('mn') && e.textContent === name);
    if (idx < 0) return null;
    for (let i = idx - 1; i >= 0; i--) if (els[i].tagName === 'INPUT') return els[i];
    return null;
  };
  const userCheck = (name) => {
    const b = groupBox(name); b.checked = true;
    (ctx.__bd._listeners.change || []).forEach((fn) => fn({ target: b }));
  };

  /* F1/F2: fresh add — picker defaults to the item's menu course; a
     different pick lands on the staged line. */
  vm.runInContext('staged = []', ctx);
  ctx.addItemFlow(mRibeye, 'Mains', undefined);
  ok('F1a course select exists in the add modal', !!courseSel());
  ok('F1b it defaults to the item menu course', selectedCourse() === (mRibeye.course || ''),
    'selected=' + selectedCourse() + ' menu=' + mRibeye.course);
  userCheck('Medium');
  if (courseSel()) courseSel().value = 'dessert';
  await addBtn().onclick();
  let st = vm.runInContext('staged', ctx);
  ok('F2a the line staged', st.length === 1, 'n=' + st.length);
  ok('F2b chosen course on the staged line', st[0] && st[0].course === 'dessert', st[0] && st[0].course);
  ok('F2c staged seat is the working seat', st[0] && st[0].seat === 1, st[0] && st[0].seat);

  /* F3: seat stepper inside the modal moves the line's seat. */
  vm.runInContext('staged = []; seat = 1', ctx);
  ctx.addItemFlow(mRibeye, 'Mains', undefined);
  userCheck('Medium');
  const sbInc = ctx.__bd.querySelector('[data-sb="inc"]');
  if (sbInc) sbInc.onclick();
  const mSeatEl = ctx.__bd.querySelector('#m-seat');
  ok('F3a seat stepper exists and the display follows it', !!mSeatEl && mSeatEl.textContent === '2',
    mSeatEl && mSeatEl.textContent);
  await addBtn().onclick();
  st = vm.runInContext('staged', ctx);
  ok('F3b staged line carries seat 2', st[0] && st[0].seat === 2, st[0] && st[0].seat);
  ok('F3c working seat followed (setSeat)', seatCalls.includes(2), seatCalls.join(','));

  /* F4: Modify preset — an existing group selection is pre-loaded. */
  vm.runInContext('staged = []; seat = 1', ctx);
  const spicy = opt(flavorGroup, 'Spicy Chili Garlic');
  ctx.addItemFlow(mEdamame, 'Appetizers', {
    qty: 1, seat: 1, course: 'appetizer',
    modifiers: [{ name: spicy.name, price_delta_cents: spicy.price_delta_cents || 0, option_id: spicy.id, group_name: 'Flavor' }],
    note: '', allergy: false, allergy_detail: '',
  });
  ok('F4a existing pick is pre-checked', groupBox('Spicy Chili Garlic').checked === true);
  ok('F4b the group default is NOT force-checked over it', groupBox('Sea Salt').checked === false);
  ok('F4c the line course is pre-selected', selectedCourse() === 'appetizer', selectedCourse());
  await addBtn().onclick();
  st = vm.runInContext('staged', ctx);
  ok('F4d selection survives the round-trip', st[0] && st[0].modifiers.length === 1 && st[0].modifiers[0].name === 'Spicy Chili Garlic',
    JSON.stringify(st[0] && st[0].modifiers));
  ok('F4e course survives the round-trip', st[0] && st[0].course === 'appetizer', st[0] && st[0].course);

  /* F5: WS-C — a staged line with NO group selection gains one in the
     editor, and the change is on the re-staged line. */
  vm.runInContext('staged = []; seat = 1', ctx);
  ctx.addItemFlow(mEdamame, 'Appetizers', {
    qty: 1, seat: 1, course: null, modifiers: [], note: '', allergy: false, allergy_detail: '',
  });
  ok('F5a nothing pre-checked for a bare line', ctx.__bd._els.filter((e) => e.tagName === 'INPUT' && e.dataset.g !== undefined && e.checked).length === 0);
  userCheck('Garlic');
  if (courseSel()) courseSel().value = 'drink';
  await addBtn().onclick();
  st = vm.runInContext('staged', ctx);
  ok('F5b gained group modifier is on the line', st[0] && st[0].modifiers.length === 1 && st[0].modifiers[0].name === 'Garlic',
    JSON.stringify(st[0] && st[0].modifiers));
  ok('F5c group option id rides along (server stores the pick)', st[0] && st[0].modifiers[0].option_id === opt(flavorGroup, 'Garlic').id,
    st[0] && st[0].modifiers[0] && st[0].modifiers[0].option_id);
  ok('F5d course picked in the editor is on the line', st[0] && st[0].course === 'drink', st[0] && st[0].course);
}

/* =============== G: HOLD posts course per line =============== */
section('G. HOLD handler posts the per-line course');
{
  const calls = [];
  const toasts = [];
  const ctx = {
    console,
    $: () => ({ onclick: null }),
    document: { querySelectorAll: () => [] },
    toast: (m) => toasts.push(m),
    isOffline: () => false, isAuthed: () => true, realId: (id) => id,
    api: async (path, method, body) => { calls.push({ path, method, body }); return {}; },
    getCheckView: async () => null,
    check: { id: 99 }, guests: 4,
    saveStaged: () => {}, drawCart: () => {}, drawSeats: () => {}, setSeat: () => {},
    renderRoute: () => {},
    handleApiError: (e) => { throw e; },
  };
  vm.createContext(ctx);
  vm.runInContext("var staged = [" +
    "{ temp_id:'t1', menu_item_id: 10, name:'A', price_cents: 100, seat: 1, qty: 1, modifiers: [], note: null, allergy: false, allergy_detail: null, course: 'dessert' }," +
    "{ temp_id:'t2', menu_item_id: 11, name:'B', price_cents: 200, seat: 1, qty: 1, modifiers: [], note: null, allergy: false, allergy_detail: null, course: null }," +
    "{ temp_id:'t3', menu_item_id: 12, name:'C', price_cents: 300, seat: 2, qty: 1, modifiers: [], note: null, allergy: false, allergy_detail: null }" +
    "]; var checkId = 99;", ctx);
  const holdDef = extractBlock(appSrc, "$('#btn-hold').onclick = async () =>");
  let holdFn = null;
  ctx.$ = () => ({ set onclick(fn) { holdFn = fn; } });
  vm.runInContext(holdDef, ctx);
  await holdFn();
  const bodies = calls.filter((c) => c.method === 'POST').map((c) => c.body);
  ok('G1 one POST per staged line', bodies.length === 3, 'n=' + bodies.length);
  ok('G2 chosen course posted', bodies[0] && bodies[0].course === 'dessert', bodies[0] && bodies[0].course);
  ok('G3 explicit null course posted (clears to no-course)', bodies[1] && 'course' in bodies[1] && bodies[1].course === null,
    bodies[1] && JSON.stringify(bodies[1].course));
  ok('G4 legacy line without the key omits course (server default preserved)', bodies[2] && !('course' in bodies[2]));
}

/* =============== H: quick bar pills + Modify label =============== */
section('H. quickBarHtml — course pills + Modify entry');
{
  const qb = (o) => PO_REAL.ctx.quickBarHtml(o);
  const staged = qb({ qty: 1, seat: 1, guestCount: 4, staged: true, course: 'entree', canCourse: true });
  ok('H1 staged bar renders 4 course pills', (staged.match(/data-qc="/g) || []).length === 4,
    (staged.match(/data-qc=/g) || []).length + ' pills');
  ok('H2 the current course pill is the active one',
    staged.includes('btn-primary" data-qc="entree"') && staged.includes('btn-ghost" data-qc="drink"'));
  const fired = qb({ qty: 1, seat: 1, guestCount: 4, staged: false, course: 'entree', canCourse: false });
  ok('H3 no pills when canCourse is false (fired lines)', !fired.includes('data-qc='));
  const noCourse = qb({ qty: 1, seat: 1, guestCount: 4, staged: true, course: null, canCourse: true });
  ok('H4 no pill active when the line has no course', !noCourse.includes('btn-primary" data-qc='));
  ok('H5 the full-editor entry is labeled Modify', staged.includes('>Modify</button>'));
  ok('H6 the old More… label is gone', !staged.includes('More…'));
}

/* =============== I: tappableValue guest typing =============== */
section('I. tappableValue — type-the-number guests (real function, mini DOM)');
{
  const ctx = PO_REAL.ctx;
  const toasts = [];
  ctx.window.toast = (m) => toasts.push(m);
  function fakeEl(tag) {
    const el = {
      tagName: tag.toUpperCase(), dataset: {}, children: [], _text: '',
      classList: { add() {} }, style: {},
      setAttribute() {}, focus() {}, select() {},
      querySelector() { return null; }, querySelectorAll() { return []; },
      addEventListener(ev, fn) { (this._l = this._l || {})[ev] = fn; },
      appendChild(c) { this.children.push(c); },
      onclick: null,
    };
    Object.defineProperty(el, 'textContent', {
      get() { return this._text; }, set(v) { this._text = String(v); this.children = []; },
    });
    Object.defineProperty(el, 'isConnected', { get: () => true });
    return el;
  }
  ctx.document = { createElement: (t) => fakeEl(t) };
  let val = 2; const applied = [];
  const span = fakeEl('span'); span.textContent = '2';
  ctx.tappableValue(span, { get: () => val, min: 1, max: 24, label: 'Guests',
    /* Mirrors every production call site: onApply updates the value AND
       repaints the span (finish() restores from get() before onApply). */
    onApply: (n) => { applied.push(n); val = n; span.textContent = String(n); } });
  const input = () => span.children.find((c) => c.tagName === 'INPUT');
  const okBtn = () => span.children.find((c) => c.tagName === 'BUTTON');
  span.onclick();
  ok('I1 tapping the number opens the inline editor', !!input() && input().value === '2', input() && input().value);
  input().value = 'abc';
  okBtn().onclick({ stopPropagation() {} });
  ok('I2 non-numeric bounces with the exact toast', toasts[toasts.length - 1] === 'Enter a whole number between 1 and 24',
    toasts[toasts.length - 1]);
  ok('I3 invalid entry never applies', applied.length === 0 && span.textContent === '2',
    'applied=' + applied.length + ' text=' + span.textContent);
  span.onclick();
  input().value = '25';
  okBtn().onclick({ stopPropagation() {} });
  ok('I4 out-of-range bounces too', applied.length === 0 && toasts[toasts.length - 1] === 'Enter a whole number between 1 and 24');
  span.onclick();
  input().value = '7';
  input()._l.keydown({ key: 'Enter', preventDefault() {}, stopPropagation() {} });
  ok('I5 a typed 7 applies (Enter path)', applied.length === 1 && applied[0] === 7, applied.join(','));
  ok('I6 span shows the applied value', span.textContent === '7', span.textContent);
}

console.log('\n' + (failures ? failures + ' FAILURES' : 'ALL HARNESS CHECKS PASS'));
process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
