#!/usr/bin/env node
/**
 * Extracted-REAL-function harness for test47 (pay-dialog outage —
 * the 2026-10-06 diagnosis).
 *
 * Incident shape: the Cash, Card and House-account dialogs on the
 * staff Pay screen were dead from 2026-09-26 to 2026-10-06. All
 * three onclick handlers call splitTenderFields(due, tipCents) and
 * readSplitTender(bd, balance), and those two functions were
 * defined in NO commit — the click threw a silent ReferenceError
 * before openModal ran. The suites never caught it because they
 * pay via the API; browser passes voided test checks instead of
 * paying them.
 *
 * This harness runs the REAL shipped code (brace-matched verbatim
 * out of public/app.js, the harness35/40/41 pattern):
 *   - splitTenderFields / readSplitTender (the restored helpers)
 *   - recordPayment (the real poster extracted from renderPay)
 *   - the #pay-cash / #pay-card / #pay-house onclick handlers
 * against the same flat modal DOM shim as harness41, and proves:
 *   A  splitTenderFields prefills principal/tip from (due, tipCents)
 *   B  readSplitTender: full, partial, tip-only-adjusted and every
 *      documented invalid shape, mirroring the server rules pinned
 *      by test47 section S (principal > 0, principal <= balance,
 *      tip >= 0 uncapped, bad input is an error — never NaN cents)
 *   C  each handler opens its dialog without throwing, the modal
 *      HTML carries the dialog markers, and driving the dialog
 *      posts the exact {method, amount_cents, tip_cents, ...} the
 *      server must receive — cash incl. tendered + change math and
 *      the partial label, card through the demo terminal screens,
 *      house with the account name as memo.
 *
 * Control: at b517273 the helpers do not exist — extraction fails,
 * sections A/B report the miss, and every handler in section C
 * throws "ReferenceError: splitTenderFields is not defined".
 *
 * Usage: node harness47_client.js [appJsPath]
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
function extractBlock(src, marker) {
  const start = src.indexOf(marker);
  if (start < 0) throw new Error('marker not found: ' + marker);
  return scanBlock(src, start);
}
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

/* ---------- modal DOM shim (harness41 flat model + listeners) ---------- */
function parseAttrs(tagInner) {
  const attrs = {};
  const re = /([a-zA-Z_-][\w-]*)(\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g;
  let m;
  while ((m = re.exec(tagInner))) attrs[m[1]] = m[3] === undefined ? true : m[3].replace(/^['"]|['"]$/g, '');
  return attrs;
}
function makeEl(tag, attrs, text) {
  const classes = new Set(String(attrs.class || '').split(/\s+/).filter(Boolean));
  const el = {
    tagName: tag.toUpperCase(), attrs, dataset: {}, children: [],
    _text: text || '', value: attrs.value !== undefined ? attrs.value : '',
    checked: 'checked' in attrs, disabled: 'disabled' in attrs, style: {},
    _listeners: {},
    classList: {
      add: (c) => classes.add(c), remove: (c) => classes.delete(c),
      toggle: (c) => (classes.has(c) ? classes.delete(c) : classes.add(c)),
      contains: (c) => classes.has(c),
    },
    setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    addEventListener(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); },
    focus() {}, click() { if (this.onclick) return this.onclick(); },
    fire(ev) { (this._listeners[ev] || []).forEach((fn) => fn({ target: this })); },
  };
  Object.defineProperty(el, 'className', {
    get() { return [...classes].join(' '); },
    set(v) { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); },
  });
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
  const tagRe = /<(input|button|select|option|span|div|textarea|label|h2|p|b)\b([^>]*)>([^<]*)/g;
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
  els.forEach((e) => { e._bd = bd; });
  return bd;
}

/* ---------- extraction of the real code under test ---------- */
const missing = [];
function tryExtract(label, fn) {
  try { return fn(); } catch (e) { missing.push(label + ': ' + e.message); return null; }
}
const fmtSrc = tryExtract('fmt', () => extractConstExpr(appSrc, 'fmt'));
const fieldsSrc = tryExtract('splitTenderFields', () => extractFn(appSrc, 'splitTenderFields'));
const readSrc = tryExtract('readSplitTender', () => extractFn(appSrc, 'readSplitTender'));
const recordSrc = tryExtract('recordPayment', () => extractBlock(appSrc, 'const recordPayment = async (payload) =>'));
const cashSrc = tryExtract('pay-cash handler', () => extractBlock(appSrc, "$('#pay-cash').onclick = () => {"));
const cardSrc = tryExtract('pay-card handler', () => extractBlock(appSrc, "$('#pay-card').onclick = () => {"));
const houseSrc = tryExtract('pay-house handler', () => extractBlock(appSrc, "$('#pay-house').onclick = () => {"));

/* ---------- pay-view context factory ----------
   balance 1018, tip picked on the pay screen 200 -> due 1218. */
const BALANCE = 1018, TIP = 200, DUE = BALANCE + TIP;
function payCtx(apiResp) {
  const rec = { handlers: {}, modals: [], toasts: [], apiCalls: [], apiErrors: [], closed: 0, renders: 0 };
  const ctx = {
    console,
    toast: (m, k) => rec.toasts.push({ msg: m, kind: k }),
    isOffline: () => false,
    realId: (id) => id,
    renderRoute: () => { rec.renders++; },
    handleApiError: (e) => rec.apiErrors.push(String((e && e.message) || e)),
    localStorage: { getItem: () => null, setItem: () => {} },
    Outbox: { enqueue: async () => {} },
    api: async (path, method, body) => { rec.apiCalls.push({ path, method, body }); return apiResp; },
    openModal: (html) => { rec.modals.push(html); const bd = buildBd(html); rec.lastBd = bd; return bd; },
    closeModal: () => { rec.closed++; },
  };
  ctx.$ = (sel, root) => {
    if (root) return root.querySelector(sel);
    if (!rec.handlers[sel]) {
      const reg = {};
      Object.defineProperty(reg, 'onclick', { set(fn) { rec.handlers[sel] = fn; }, get() { return rec.handlers[sel]; } });
      rec.handlers[sel] = reg;
      return reg;
    }
    return rec.handlers[sel];
  };
  ctx.$$ = (sel, root) => (root ? root.querySelectorAll(sel) : []);
  vm.createContext(ctx);
  if (fmtSrc) vm.runInContext(fmtSrc, ctx);
  if (fieldsSrc) vm.runInContext(fieldsSrc, ctx);
  if (readSrc) vm.runInContext(readSrc, ctx);
  vm.runInContext('var t = { balance: ' + BALANCE + ', total: ' + BALANCE + ' };' +
    'var tipCents = ' + TIP + '; var checkId = 99;', ctx);
  if (recordSrc) vm.runInContext(recordSrc, ctx);
  return { ctx, rec };
}
const call = (ctx, expr) => vm.runInContext(expr, ctx);
function setVal(bd, sel, v) { const el = bd.querySelector(sel); el.value = v; el.fire('input'); return el; }

(async function main() {

if (missing.length) {
  section('X. extraction misses (the outage shape at the control commit)');
  missing.forEach((m) => console.log('  MISSING ' + m));
}

/* =============== A: splitTenderFields prefills =============== */
section('A. splitTenderFields — prefills from (due, tipCents)');
{
  const { ctx } = payCtx({});
  if (!fieldsSrc) {
    ok('A0 splitTenderFields is defined in the shipped app.js', false, 'extraction failed');
  } else {
    const html = call(ctx, 'splitTenderFields(' + DUE + ', ' + TIP + ')');
    const bd = buildBd(html);
    ok('A1 fragment carries #st-amount and #st-tip',
      !!bd.querySelector('#st-amount') && !!bd.querySelector('#st-tip'), html);
    ok('A2 amount prefills to the principal (due - tip = 1018 -> 10.18)',
      bd.querySelector('#st-amount').value === '10.18', bd.querySelector('#st-amount').value);
    ok('A3 tip prefills to the pay-screen tip (200 -> 2.00)',
      bd.querySelector('#st-tip').value === '2.00', bd.querySelector('#st-tip').value);
    const bd0 = buildBd(call(ctx, 'splitTenderFields(1018, 0)'));
    ok('A4 zero tip prefills amount = full due, tip 0.00',
      bd0.querySelector('#st-amount').value === '10.18' && bd0.querySelector('#st-tip').value === '0.00',
      bd0.querySelector('#st-amount').value + '/' + bd0.querySelector('#st-tip').value);
    const bdC = buildBd(call(ctx, 'splitTenderFields(500, 700)'));
    ok('A5 a tip larger than due clamps the principal prefill at 0.00, never negative',
      bdC.querySelector('#st-amount').value === '0.00' && bdC.querySelector('#st-tip').value === '7.00',
      bdC.querySelector('#st-amount').value + '/' + bdC.querySelector('#st-tip').value);
  }
}

/* =============== B: readSplitTender matrix =============== */
section('B. readSplitTender — the server-mirroring validation matrix');
{
  const { ctx } = payCtx({});
  if (!readSrc || !fieldsSrc) {
    ok('B0 readSplitTender is defined in the shipped app.js', false, 'extraction failed');
  } else {
    const read = (amt, tip, balance) => {
      ctx.__bd = buildBd(call(ctx, 'splitTenderFields(' + DUE + ', ' + TIP + ')'));
      ctx.__bd.querySelector('#st-amount').value = amt;
      ctx.__bd.querySelector('#st-tip').value = tip;
      ctx.__bal = balance === undefined ? BALANCE : balance;
      return call(ctx, 'readSplitTender(__bd, __bal)');
    };
    const shape = (r) => r && Number.isInteger(r.principal) && Number.isInteger(r.tip)
      && Number.isInteger(r.payTotal) && (r.error === null || typeof r.error === 'string');
    let r = read('10.18', '2.00');
    ok('B1 full payment: principal 1018, tip 200, payTotal 1218, no error',
      shape(r) && r.principal === 1018 && r.tip === 200 && r.payTotal === 1218 && r.error === null, JSON.stringify(r));
    r = read('5.00', '1.00');
    ok('B2 partial payment: principal 500, tip 100, payTotal 600 (< due), no error',
      shape(r) && r.principal === 500 && r.tip === 100 && r.payTotal === 600 && r.error === null, JSON.stringify(r));
    r = read('10.18', '3.50');
    ok('B3 tip-only adjustment: principal stays 1018, tip 350, payTotal 1368, no error',
      shape(r) && r.principal === 1018 && r.tip === 350 && r.payTotal === 1368 && r.error === null, JSON.stringify(r));
    r = read('10.18', '0');
    ok('B4 zero tip is valid (the server floor is tip >= 0)',
      shape(r) && r.tip === 0 && r.payTotal === 1018 && r.error === null, JSON.stringify(r));
    r = read('10.18', '25.00');
    ok('B5 a tip larger than the bill is valid (the server sets no tip cap)',
      shape(r) && r.tip === 2500 && r.payTotal === 3518 && r.error === null, JSON.stringify(r));
    r = read('3.333', '0.00');
    ok('B6 fractional cents round to integer cents (3.333 -> 333), never float cents',
      shape(r) && r.principal === 333 && r.error === null, JSON.stringify(r));
    const invalid = [
      ['B7 amount above the balance', '10.19', '0.00', /exceeds the balance due/],
      ['B8 zero amount', '0.00', '0.00', /more than \$0\.00/],
      ['B9 negative amount', '-5.00', '0.00', /more than \$0\.00/],
      ['B10 negative tip', '5.00', '-1.00', /Tip cannot be negative/],
      ['B11 non-numeric amount', 'abc', '0.00', /Enter a payment amount/],
      ['B12 empty amount', '', '0.00', /Enter a payment amount/],
      ['B13 non-numeric tip', '5.00', 'xyz', /Enter a tip amount/],
      ['B14 empty tip', '5.00', '', /Enter a tip amount/],
    ];
    for (const [name, a, tp, re] of invalid) {
      r = read(a, tp);
      ok(name + ' -> error, zeroed money fields, integer shape (no NaN)',
        shape(r) && typeof r.error === 'string' && re.test(r.error)
          && r.principal === 0 && r.tip === 0 && r.payTotal === 0, JSON.stringify(r));
    }
    r = read('10.18', '2.00', 500);
    ok('B15 the balance argument is honored (full bill amount vs a 500 balance errors)',
      typeof r.error === 'string' && /exceeds the balance due \(\$5\.00\)/.test(r.error), JSON.stringify(r));
  }
}

/* =============== C: the three handlers, clicked for real =============== */
section('C. handlers — open without throwing, markers present, payment posts exactly');
const HANDLERS = [
  ['cash', '#pay-cash', cashSrc, ['id="st-amount"', 'id="st-tip"', 'id="cash-tendered"', 'id="cash-change"', 'Cash payment']],
  ['card', '#pay-card', cardSrc, ['id="st-amount"', 'id="st-tip"', 'data-tm="insert"', 'data-tm="tap"', 'data-tm="swipe"', 'term-screen']],
  ['house', '#pay-house', houseSrc, ['id="st-amount"', 'id="st-tip"', 'id="ha-name"', 'House account']],
];
for (const [name, sel, src, markers] of HANDLERS) {
  const { ctx, rec } = payCtx({ payment: { id: 1 }, demo: { auth_code: 'DEMO-TEST' } });
  if (!src) { ok('C-' + name + ' handler extractable', false, 'extraction failed'); continue; }
  vm.runInContext(src, ctx);
  let threw = null;
  try { rec.handlers[sel](); } catch (e) { threw = e; }
  ok('C-' + name + '1 clicking ' + name + ' does not throw', !threw, threw && (threw.name + ': ' + threw.message));
  if (threw) continue;
  ok('C-' + name + '2 the dialog opens exactly once', rec.modals.length === 1, 'modals=' + rec.modals.length);
  const html = rec.modals[0] || '';
  ok('C-' + name + '3 dialog markers present (' + markers.join(', ') + ')',
    markers.every((m) => html.includes(m)),
    markers.filter((m) => !html.includes(m)).join(','));
  ok('C-' + name + '4 no API error was swallowed on open', rec.apiErrors.length === 0, rec.apiErrors.join(';'));
}

/* C-cash drive: full payment with over-tender -> exact POST + change */
try {
  const { ctx, rec } = payCtx({ payment: { id: 1 } });
  vm.runInContext(cashSrc, ctx);
  rec.handlers['#pay-cash']();
  const bd = rec.lastBd;
  const go = bd.querySelector('[data-x="go"]');
  setVal(bd, '#cash-tendered', '20.00');
  ok('C-cash5 change math runs off payTotal (2000 tendered - 1218 = $7.82 change)',
    bd.querySelector('#cash-change').textContent === 'Change due: $7.82',
    bd.querySelector('#cash-change').textContent);
  ok('C-cash6 full payment leaves the confirm enabled with the plain label',
    go.disabled === false && go.textContent === 'Record cash payment', go.textContent);
  await go.onclick();
  const c = rec.apiCalls[0] || {};
  ok('C-cash7 the POST hits the payments endpoint for the open check',
    rec.apiCalls.length === 1 && c.path === '/api/checks/99/payments' && c.method === 'POST',
    JSON.stringify(rec.apiCalls.map((x) => x.path)));
  ok('C-cash8 the POST body is principal/tip/tendered exactly (1018/200/2000)',
    !!c.body && c.body.method === 'cash' && c.body.amount_cents === 1018
      && c.body.tip_cents === 200 && c.body.tendered_cents === 2000, JSON.stringify(c.body));
} catch (e) { ok('C-cash drive runs end to end', false, e.name + ': ' + e.message); }
/* C-cash partial: reduced amount -> partial label + partial POST + toast */
try {
  const { ctx, rec } = payCtx({ payment: { id: 2 } });
  vm.runInContext(cashSrc, ctx);
  rec.handlers['#pay-cash']();
  const bd = rec.lastBd;
  const go = bd.querySelector('[data-x="go"]');
  setVal(bd, '#st-amount', '5.00');
  setVal(bd, '#st-tip', '0.00');
  ok('C-cash9 a partial amount relabels the confirm with the remainder left',
    go.disabled === false && go.textContent === 'Record partial — $7.18 left', go.textContent);
  await go.onclick();
  const c = rec.apiCalls[0] || {};
  ok('C-cash10 the partial POSTs principal 500, tip 0, tendered = due 1218',
    !!c.body && c.body.amount_cents === 500 && c.body.tip_cents === 0 && c.body.tendered_cents === 1218,
    JSON.stringify(c.body));
  ok('C-cash11 the partial toast names the remaining balance',
    rec.toasts.some((t) => t.msg === 'Partial payment — $7.18 remaining'),
    JSON.stringify(rec.toasts.map((t) => t.msg)));
} catch (e) { ok('C-cash partial drive runs end to end', false, e.name + ': ' + e.message); }
/* C-cash invalid: amount over balance disables confirm and blocks the POST */
try {
  const { ctx, rec } = payCtx({ payment: { id: 3 } });
  vm.runInContext(cashSrc, ctx);
  rec.handlers['#pay-cash']();
  const bd = rec.lastBd;
  const go = bd.querySelector('[data-x="go"]');
  setVal(bd, '#st-amount', '99.99');
  ok('C-cash12 an over-balance amount disables the confirm button', go.disabled === true);
  await go.onclick();
  ok('C-cash13 the blocked confirm toasts the error and posts nothing',
    rec.apiCalls.length === 0 && rec.toasts.some((t) => t.kind === 'err' && /exceeds the balance/.test(t.msg)),
    JSON.stringify(rec.toasts.map((t) => t.msg)));
} catch (e) { ok('C-cash invalid drive runs end to end', false, e.name + ': ' + e.message); }
/* C-card drive: insert -> processing -> approved screen with auth code */
try {
  const { ctx, rec } = payCtx({ payment: { id: 4 }, demo: { auth_code: 'DEMO-TEST' } });
  vm.runInContext(cardSrc, ctx);
  rec.handlers['#pay-card']();
  const bd = rec.lastBd;
  const insert = bd.querySelectorAll('[data-tm]').find((b) => b.dataset.tm === 'insert');
  await insert.onclick();
  const c = rec.apiCalls[0] || {};
  ok('C-card5 insert posts card_demo principal/tip exactly (1018/200, Visa 4242)',
    !!c.body && c.body.method === 'card_demo' && c.body.amount_cents === 1018
      && c.body.tip_cents === 200 && c.body.brand === 'Visa' && c.body.last4 === '4242',
    JSON.stringify(c.body));
  ok('C-card6 the approved screen shows the returned auth code',
    bd.querySelector('#term-auth').textContent === 'DEMO-TEST',
    bd.querySelector('#term-auth').textContent);
  ok('C-card7 the processing screen was shown and then hidden',
    bd.querySelector('#term-2').classList.contains('hidden')
      && !bd.querySelector('#term-3').classList.contains('hidden'));
} catch (e) { ok('C-card drive runs end to end', false, e.name + ': ' + e.message); }
/* C-card invalid: zero amount blocks at the terminal button, nothing posts */
try {
  const { ctx, rec } = payCtx({ payment: { id: 5 }, demo: { auth_code: 'DEMO-TEST' } });
  vm.runInContext(cardSrc, ctx);
  rec.handlers['#pay-card']();
  const bd = rec.lastBd;
  bd.querySelector('#st-amount').value = '0.00';
  const tap = bd.querySelectorAll('[data-tm]').find((b) => b.dataset.tm === 'tap');
  await tap.onclick();
  ok('C-card8 a zero amount toasts the validation error and posts nothing',
    rec.apiCalls.length === 0 && rec.toasts.some((t) => t.kind === 'err' && /more than \$0\.00/.test(t.msg)),
    JSON.stringify(rec.toasts.map((t) => t.msg)));
  ok('C-card9 the terminal never leaves the amount screen on a blocked tap',
    !bd.querySelector('#term-1').classList.contains('hidden'));
} catch (e) { ok('C-card invalid drive runs end to end', false, e.name + ': ' + e.message); }
/* C-house drive: named account -> charge posts with the name as memo */
try {
  const { ctx, rec } = payCtx({ payment: { id: 6 } });
  vm.runInContext(houseSrc, ctx);
  rec.handlers['#pay-house']();
  const bd = rec.lastBd;
  bd.querySelector('#ha-name').value = 'Test House Account';
  await bd.querySelector('[data-x="go"]').onclick();
  const c = rec.apiCalls[0] || {};
  ok('C-house5 the charge posts house_account principal/tip with the account name as memo',
    !!c.body && c.body.method === 'house_account' && c.body.amount_cents === 1018
      && c.body.tip_cents === 200 && c.body.memo === 'Test House Account', JSON.stringify(c.body));
} catch (e) { ok('C-house drive runs end to end', false, e.name + ': ' + e.message); }
/* C-house guard: no account name -> toast, nothing posts */
try {
  const { ctx, rec } = payCtx({ payment: { id: 7 } });
  vm.runInContext(houseSrc, ctx);
  rec.handlers['#pay-house']();
  const bd = rec.lastBd;
  await bd.querySelector('[data-x="go"]').onclick();
  ok('C-house6 an unnamed account toasts and posts nothing',
    rec.apiCalls.length === 0 && rec.toasts.some((t) => t.kind === 'err' && /account name/.test(t.msg)),
    JSON.stringify(rec.toasts.map((t) => t.msg)));
} catch (e) { ok('C-house guard drive runs end to end', false, e.name + ': ' + e.message); }
console.log('\n' + (failures ? failures + ' FAILURES' : 'ALL HARNESS CHECKS PASS'));
process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
