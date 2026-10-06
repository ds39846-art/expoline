#!/usr/bin/env node
/**
 * Extracted-REAL-function harness for test41 (HOLD failure messaging —
 * the 2026-10-05 live-acceptance defect).
 *
 * Incident shape: 5 staged lines, ONE of them an Edamame with no Flavor
 * pick (a required pick-1 group). HOLD answered "5 need attention:
 * Flavor: please choose at least one" — it named no line, and it
 * counted every still-staged line as bad when only the rejected one
 * was. This harness runs the REAL shipped functions (brace-matched
 * verbatim out of public/app.js, the harness35/40 pattern):
 *   - the #btn-hold handler (online path)
 *   - addItemFlow (the add modal that doubles as the staged-line
 *     Modify editor)
 *   - drawCart (the cart line render)
 *
 * Cases:
 *   J  HOLD failure: the error toast NAMES the rejected line (item +
 *      seat) with the server reason; the needs-attention count is the
 *      ONE rejected line, never the still-staged remainder (which the
 *      toast reports as still staged); the confirm-per-item contract
 *      pinned by harness35 D holds (stop at the rejection, failed +
 *      unattempted lines stay staged).
 *   K  addItemFlow confirm button: "Add to order" on a fresh add,
 *      "Save" when editing an existing line (preset / Modify), with
 *      the data-x="add" hook stable in both modes.
 *   L  drawCart line summary: note and allergy segments are separated
 *      by a real space in the rendered line (they rendered fused:
 *      note text straight into the allergy flag).
 *
 * Usage: node harness41_client.js <menu-payload.json> [appJsPath] [parityOrdersPath]
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
function extractBlock(src, marker) {
  const start = src.indexOf(marker);
  if (start < 0) throw new Error('marker not found: ' + marker);
  return scanBlock(src, start);
}
function extractLine(src, re, what) {
  const m = src.match(re);
  if (!m) throw new Error('line not found: ' + what);
  return m[0];
}

/* ---------- modal DOM shim (same flat model as harness40) ---------- */
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

/* ---------- fixtures ---------- */
const categories = payload.categories || [];
const allItems = categories.flatMap((c) => (c.items || []).map((it) => ({ ...it, _cat: c.name })));
const byName = (n) => allItems.find((i) => i.name === n);
const edamameRaw = byName('Edamame');
if (!edamameRaw) { console.log('fixture menu missing Edamame'); process.exit(2); }

/* The real ApiError class ships as one line in app.js. */
const apiErrorLine = appSrc.split('\n').find((l) => l.startsWith('class ApiError'));
if (!apiErrorLine) { console.log('ApiError class line not found'); process.exit(2); }

const PO_REAL = {};
function loadPO() {
  const ctx = { console, window: {}, document: { querySelector: () => null, querySelectorAll: () => [], createElement: () => ({}) } };
  ctx.window.document = ctx.document;
  vm.createContext(ctx);
  vm.runInContext(extractFn(poSrc, 'tappableValue'), ctx);
  PO_REAL.ctx = ctx;
}

(async function main() {
loadPO();

/* =============== J: HOLD failure names the rejected line =============== */
section('J. HOLD handler — a rejected line is named, not miscounted');
{
  const line = (temp_id, menu_item_id, name, seat) => ({
    temp_id, menu_item_id, name, price_cents: 900, seat, qty: 1,
    modifiers: [], note: null, allergy: false, allergy_detail: null, course: null,
  });
  function holdCtx(stagedFixture, badId) {
    const rec = { calls: [], toasts: [], saves: [], apiErrors: [] };
    const ctx = {
      console,
      document: { querySelectorAll: () => [] },
      toast: (m, k) => rec.toasts.push({ msg: m, kind: k }),
      isOffline: () => false, realId: (id) => id,
      saveStaged: (cid, arr) => rec.saves.push(arr.map((s) => s.temp_id)),
      renderRoute: () => {},
      handleApiError: (e) => rec.apiErrors.push(String((e && e.message) || e)),
    };
    vm.createContext(ctx);
    vm.runInContext(apiErrorLine, ctx);
    /* A class declaration binds lexically inside the context, not as a
       sandbox property — pull the constructor out through the context
       so the api stub can throw genuine ApiError instances (the
       handler's instanceof checks depend on it). */
    const ApiErrorCls = vm.runInContext('ApiError', ctx);
    ctx.api = async (path, method, body) => {
      rec.calls.push(body);
      if (body && body.menu_item_id === badId) {
        throw new ApiErrorCls(400, 'Flavor: please choose at least one');
      }
      return {};
    };
    let holdFn = null;
    ctx.$ = () => ({ set onclick(fn) { holdFn = fn; } });
    vm.runInContext('var staged = ' + JSON.stringify(stagedFixture) + '; var checkId = 99;', ctx);
    vm.runInContext(extractBlock(appSrc, "$('#btn-hold').onclick = async () =>"), ctx);
    return { ctx, rec, run: () => holdFn(), stagedNow: () => vm.runInContext('staged.map((s) => s.temp_id)', ctx) };
  }
  const errToast = (rec) => rec.toasts.find((t) => t.kind === 'err');

  /* J-A: the incident shape — the FIRST line is the invalid one. */
  {
    const bad = line('t-bad', 9001, 'Edamame', 1);
    const h = holdCtx([bad, line('t-ok1', 9002, 'Bali Fries', 1), line('t-ok2', 9003, '14oz Ribeye', 2)], 9001);
    await h.run();
    const t = errToast(h.rec);
    ok('J1 an error toast fires', !!t, JSON.stringify(h.rec.toasts));
    ok('J2 the toast names the rejected line (item + seat)',
      !!t && t.msg.includes('Edamame (Seat 1)'), t && t.msg);
    ok('J3 the toast carries the server reason', !!t && t.msg.includes('Flavor: please choose at least one'), t && t.msg);
    ok('J4 the line is the ONE counted as needing attention',
      !!t && /Edamame \(Seat 1\) needs attention/.test(t.msg) && !/\b[2-9]\d* needs? attention/.test(t.msg), t && t.msg);
    ok('J5 the unattempted remainder is reported as still staged, not bad',
      !!t && t.msg.includes('2 more lines still staged'), t && t.msg);
    ok('J6 loop still stops at the rejection (1 POST attempted)', h.rec.calls.length === 1, 'calls=' + h.rec.calls.length);
    ok('J7 failed + unattempted lines all stay staged',
      JSON.stringify(h.stagedNow()) === JSON.stringify(['t-bad', 't-ok1', 't-ok2']), h.stagedNow().join(','));
  }

  /* J-B: failure mid-list — earlier lines hold, the count stays honest. */
  {
    const bad = line('t-bad', 9001, 'Edamame', 2);
    const h = holdCtx([line('t-ok1', 9002, 'Bali Fries', 1), bad, line('t-ok2', 9003, '14oz Ribeye', 2)], 9001);
    await h.run();
    const t = errToast(h.rec);
    ok('J8 held lines still hold before the failure (1 held, named line, 1 still staged)',
      !!t && t.msg.startsWith('1 held · ') && t.msg.includes('Edamame (Seat 2) needs attention')
        && t.msg.includes('1 more line still staged'), t && t.msg);
    ok('J9 loop stops at the rejection (2 POSTs attempted)', h.rec.calls.length === 2, 'calls=' + h.rec.calls.length);
    ok('J10 failed + unattempted lines stay staged, held line is gone',
      JSON.stringify(h.stagedNow()) === JSON.stringify(['t-bad', 't-ok2']), h.stagedNow().join(','));
  }

  /* J-C: control — everything confirms, success shape unchanged. */
  {
    const h = holdCtx([line('t-a', 9002, 'Bali Fries', 1), line('t-b', 9003, '14oz Ribeye', 2)], -1);
    await h.run();
    ok('J11 all-valid HOLD keeps the success toast and empties staged',
      h.rec.toasts.some((t) => t.kind === 'ok' && t.msg === '2 items held') && h.stagedNow().length === 0,
      JSON.stringify(h.rec.toasts));
  }
}

/* =============== K: add modal confirm label follows the mode =============== */
section('K. addItemFlow — "Add to order" on add, "Save" on Modify');
{
  const ctx = {
    console, menu: [], activeCat: null,
    esc: (s) => String(s == null ? '' : s),
    fmt: (c) => '$' + ((Number(c) || 0) / 100).toFixed(2),
    $: (sel, root) => (root || ctx.__bd).querySelector(sel),
    $$: (sel, root) => (root || ctx.__bd).querySelectorAll(sel),
    toast: () => {},
    uid: (() => { let n = 0; return () => 'tmp-k' + (++n); })(),
    isDrink: () => false,
    itemModifiers: () => [],
    openModal: (html) => { ctx.__bd = buildBd(html); return ctx.__bd; },
    closeModal: () => {},
    saveStaged: () => {}, drawCart: () => {}, paintGuests: () => {},
    isOffline: () => false, realId: (id) => id,
    api: async () => ({}), getCheckView: async () => null,
    handleApiError: (e) => { throw e; },
    PO: { tappableValue: PO_REAL.ctx.tappableValue },
  };
  vm.createContext(ctx);
  vm.runInContext('var seat = 1; var guests = 4; var staged = []; var checkId = 4242;' +
    'function setSeat(s){ seat = s; }', ctx);
  vm.runInContext(extractLine(appSrc, /const ME_COURSES = \[[^\]]*\];/, 'ME_COURSES'), ctx);
  vm.runInContext(extractFn(appSrc, 'stageItem'), ctx);
  vm.runInContext(extractFn(appSrc, 'addItemFlow'), ctx);
  const getMenuCtx = { api: async () => payload, console };
  vm.createContext(getMenuCtx);
  vm.runInContext(extractFn(appSrc, 'getMenu'), getMenuCtx);
  const mapped = await vm.runInContext('getMenu()', getMenuCtx);
  const mEdamame = mapped.flatMap((c) => c.items).find((i) => i.name === 'Edamame');
  const addBtn = () => ctx.__bd.querySelector('[data-x="add"]');

  ctx.addItemFlow(mEdamame, 'Pupus', undefined);
  ok('K1 fresh add keeps the data-x="add" hook', !!addBtn());
  ok('K2 fresh add confirm reads "Add to order"', !!addBtn() && addBtn().textContent === 'Add to order',
    addBtn() && addBtn().textContent);

  ctx.addItemFlow(mEdamame, 'Pupus', {
    qty: 1, seat: 1, course: 'appetizer', modifiers: [], note: '', allergy: false, allergy_detail: '',
  });
  ok('K3 Modify (preset) keeps the data-x="add" hook', !!addBtn());
  ok('K4 Modify confirm reads "Save"', !!addBtn() && addBtn().textContent === 'Save',
    addBtn() && addBtn().textContent);
}

/* =============== L: drawCart summary segments are separated =============== */
section('L. drawCart — note and allergy do not render fused');
{
  const cartBody = { innerHTML: '' };
  const ctx = {
    console,
    __cb: cartBody,
    esc: (s) => String(s == null ? '' : s),
    fmt: (c) => '$' + ((Number(c) || 0) / 100).toFixed(2),
    /* The sel-bar buttons are part of the HTML drawCart itself renders,
       so the real code wires their handlers unguarded — the shim hands
       back a benign stub element instead of null. */
    $: () => ({ style: {}, onclick: null, textContent: '' }),
    $$: () => [],
    drawSeats: () => {},
    PO: { quickBarHtml: () => '' },
  };
  vm.createContext(ctx);
  vm.runInContext('var cartBody = __cb; var quickKey = null; var selectMode = false;' +
    'var guests = 4; var check = { items: [], seat_names: {} };' +
    'var staged = [{ temp_id: "t1", menu_item_id: 32, name: "Edamame", price_cents: 900, seat: 1, qty: 1,' +
    ' modifiers: [{ name: "Garlic", price_delta_cents: 0 }], note: "no sauce", allergy: true,' +
    ' allergy_detail: "soy", course: "appetizer" }];', ctx);
  vm.runInContext(extractFn(appSrc, 'drawCart'), ctx);
  vm.runInContext('drawCart()', ctx);
  const html = cartBody.innerHTML;
  ok('L1 the line renders at all (name + note + allergy present)',
    html.includes('Edamame') && html.includes('no sauce') && html.includes('allergy'), html.slice(0, 200));
  ok('L2 a real space separates the note segment from the allergy segment',
    /no sauce<\/span> <span class="pill allergy">/.test(html),
    (html.match(/no sauce.{0,40}/) || [''])[0]);
}

console.log('\n' + (failures ? failures + ' FAILURES' : 'ALL HARNESS CHECKS PASS'));
process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
