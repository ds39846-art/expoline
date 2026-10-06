#!/usr/bin/env node
/**
 * Extracted-REAL-code harness for test63 (view guards — capability
 * consistency, completing the test56/test62 permissions model).
 *
 * Until this batch, five view-entry guards in public/app.js still
 * read the raw role while the API, the nav, and (since the test62
 * rider) the KDS view all follow the capability matrix:
 *   - renderFloor / renderReservations / renderOrder / renderPay
 *     hard-blocked `role !== 'server' && role !== 'manager'`, so a
 *     kitchen user granted floor_ops got floor APIs (serverPlus =
 *     requireCap('floor_ops')) but a bounced view, and a server
 *     stripped of floor_ops kept the views while the APIs 403'd.
 *   - mgrGuard hard-blocked `role !== 'manager'` for all 8 manager
 *     subviews, so a non-manager granted e.g. admin_discounts passed
 *     the (already hybrid) router guard into #/manager and then hit
 *     a wall on every subview, while the discounts API answered 200.
 *   - the router's #/manager guard still OR'd the manager role in
 *     beside hasAnyCap(MANAGER_AREA_CAPS), so a manager stripped of
 *     every manager-area capability kept the area while its APIs
 *     all 403'd.
 *
 * This harness extracts, from the REAL public/app.js:
 *   1. the capability helper block (CLIENT_CAP_DEFAULTS ..
 *      roleHasCap / hasAnyCap — the same block harness56/62 extract);
 *   2. the FIRST if-condition inside each guarded render function
 *      (floor family + KDS), paren-matched out of the shipped file;
 *   3. the router's #/manager guard condition;
 *   4. the ENTIRE mgrGuard function (brace-matched) plus the exact
 *      capability argument each manager subview's call site passes —
 *      mgrGuard is then CALLED for real against a stub app object.
 * Every guard verdict below is the shipped code's own verdict:
 * blocked === true means the view refuses the user.
 *
 * Control: at d37fa82 the extracted predicates are the role tests —
 * the capability pins fail, granted/stripped fixtures stay blocked
 * or open exactly as the old role logic dictated, and the DEFAULT
 * fixture verdicts match HEAD exactly (the equivalence this batch
 * must preserve).
 *
 * Usage: node harness63_client.js [appJsPath] [liveCasesJsonPath]
 *   liveCasesJsonPath: [{"name": "...", "user": {...}|null}, ...]
 *   Live verdicts are emitted as case_live_<name>_<view>.
 */
const fs = require('fs');
const vm = require('vm');

const APP_JS = process.argv[2] || __dirname + '/../public/app.js';
const CASES_JS = process.argv[3] || null;
const appSrc = fs.readFileSync(APP_JS, 'utf8');

const R = {};
let failures = 0;
function ok(name, cond, extra) {
  R[name] = !!cond;
  if (cond) console.log('  ok  ' + name);
  else { failures++; console.log('  FAIL ' + name + (extra !== undefined ? ' — ' + extra : '')); }
}
function section(s) { console.log('\n' + s); }

function extractHelpers(src) {
  const a = src.indexOf('const CLIENT_CAP_DEFAULTS');
  const b = src.indexOf('/* ---------------- header / nav ---------------- */');
  if (a < 0 || b < 0 || b <= a) throw new Error('capability helper block not found');
  return src.slice(a, b);
}

/* Paren-match the first `if (...)` at or after index `from`. */
function extractCond(src, from, window) {
  const head = src.slice(from, from + (window || 900));
  const ifAt = head.indexOf('if (');
  if (ifAt < 0) throw new Error('no if found in window');
  let depth = 0, end = -1;
  for (let i = ifAt + 3; i < head.length; i++) {
    if (head[i] === '(') depth++;
    else if (head[i] === ')') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end < 0) throw new Error('guard condition parens unbalanced');
  return head.slice(ifAt + 4, end);
}

function extractFn(src, sigStart) {
  const at = src.indexOf(sigStart);
  if (at < 0) throw new Error('signature not found: ' + sigStart);
  const open = src.indexOf('{', at);
  let depth = 0, end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end < 0) throw new Error('function braces unbalanced: ' + sigStart);
  return { text: src.slice(at, end + 1), at };
}

/* The capability argument a render function passes to mgrGuard:
 * the text between `mgrGuard(app` and the call's closing paren. */
function extractMgrArg(src, sigStart) {
  const at = src.indexOf(sigStart);
  if (at < 0) throw new Error('signature not found: ' + sigStart);
  const head = src.slice(at, at + 300);
  const callAt = head.indexOf('mgrGuard(app');
  if (callAt < 0) throw new Error('no mgrGuard call in ' + sigStart);
  let depth = 0, end = -1;
  const open = callAt + 'mgrGuard'.length;
  for (let i = open; i < head.length; i++) {
    if (head[i] === '(') depth++;
    else if (head[i] === ')') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end < 0) throw new Error('mgrGuard call parens unbalanced');
  const inner = head.slice(open + 1, end).trim(); // "app" or "app, <expr>"
  if (inner === 'app') return null;
  if (!inner.startsWith('app,')) throw new Error('unexpected mgrGuard call shape: ' + inner);
  return inner.slice(4).trim();
}

const COND_VIEWS = [
  ['floor', 'async function renderFloor(app) {'],
  ['reservations', 'async function renderReservations(app) {'],
  ['order', 'async function renderOrder(app, checkId) {'],
  ['pay', 'async function renderPay(app, checkId) {'],
  ['kds', 'async function renderKds(app) {'],
];
const MGR_VIEWS = [
  ['mgr_overview', 'async function renderManager(app) {'],
  ['mgr_settings', 'async function renderSvcChargeSettings(app) {'],
  ['mgr_employees', 'async function renderEmployees(app) {'],
  ['mgr_floorplan', 'async function renderFloorPlan(app) {'],
  ['mgr_finance', 'async function renderFinance(app) {'],
  ['mgr_shift', 'async function renderShift(app) {'],
  ['mgr_menu', 'async function renderMenuViewer(app) {'],
  ['mgr_timeclock', 'async function renderTimeClock(app) {'],
];
const ALL_VIEWS = COND_VIEWS.map((v) => v[0]).concat(['router'], MGR_VIEWS.map((v) => v[0]));
const EXPECTED_MGR_ARGS = {
  mgr_overview: "'finance_reports'",
  mgr_settings: "['site_admin', 'admin_discounts']",
  mgr_employees: "'clock_admin'",
  mgr_floorplan: "'site_admin'",
  mgr_finance: "'finance_reports'",
  mgr_shift: "'finance_reports'",
  mgr_menu: "'admin_menu'",
  mgr_timeclock: "'clock_admin'",
};
const ALL12 = ['floor_ops', 'kitchen_ops', 'menu_86', 'admin_menu', 'admin_discounts', 'admin_inventory', 'finance_reports', 'finance_closeout', 'refunds', 'clock_admin', 'site_admin', 'permissions_admin'];

/* blocked-map builder: keys are views, true = the view refuses. */
function blockedMap(passViews) {
  const m = {};
  for (const v of ALL_VIEWS) m[v] = !passViews.includes(v);
  return m;
}
const FLOOR4 = ['floor', 'reservations', 'order', 'pay'];
const MGR8 = MGR_VIEWS.map((v) => v[0]);
const FIXTURES = [
  ['mgr_default', { role: 'manager' }, blockedMap(ALL_VIEWS)],
  ['kitchen_default', { role: 'kitchen' }, blockedMap(['kds'])],
  ['server_default', { role: 'server' }, blockedMap(FLOOR4)],
  ['mgr_caps', { role: 'manager', capabilities: ALL12.slice() }, blockedMap(ALL_VIEWS)],
  ['kitchen_caps', { role: 'kitchen', capabilities: ['kitchen_ops', 'menu_86'] }, blockedMap(['kds'])],
  ['server_caps', { role: 'server', capabilities: ['floor_ops', 'menu_86'] }, blockedMap(FLOOR4)],
  ['kitchen_floor_grant', { role: 'kitchen', capabilities: ['kitchen_ops', 'menu_86', 'floor_ops'] },
    blockedMap(FLOOR4.concat(['kds']))],
  ['server_floor_stripped', { role: 'server', capabilities: ['menu_86'] }, blockedMap([])],
  ['server_discounts_grant', { role: 'server', capabilities: ['floor_ops', 'menu_86', 'admin_discounts'] },
    blockedMap(FLOOR4.concat(['router', 'mgr_settings']))],
  ['mgr_no_finance', { role: 'manager', capabilities: ALL12.filter((c) => c !== 'finance_reports') },
    blockedMap(ALL_VIEWS.filter((v) => !['mgr_finance', 'mgr_overview', 'mgr_shift'].includes(v)))],
  ['mgr_no_discounts', { role: 'manager', capabilities: ALL12.filter((c) => c !== 'admin_discounts') },
    blockedMap(ALL_VIEWS)],
  ['server_site_grant', { role: 'server', capabilities: ['floor_ops', 'menu_86', 'site_admin'] },
    blockedMap(FLOOR4.concat(['router', 'mgr_settings', 'mgr_floorplan']))],
  ['null_user', null, blockedMap([])],
];

(async () => {
  section('== extraction: real helpers, real guard predicates, real mgrGuard ==');
  let ctx = null;
  const conds = {};
  const mgrArgs = {};
  let mgrGuardFn = null;
  try {
    ctx = vm.createContext({ state: { user: null }, console });
    vm.runInContext(extractHelpers(appSrc) +
      '\nthis.__rhc = roleHasCap; this.__hac = hasAnyCap;', ctx);
    ok('helpers extracted (userCaps / roleHasCap / hasAnyCap)',
      typeof ctx.__rhc === 'function' && typeof ctx.__hac === 'function');
  } catch (e) {
    ok('helpers extracted (userCaps / roleHasCap / hasAnyCap)', false, e.message);
  }
  for (const [view, sig] of COND_VIEWS) {
    try {
      conds[view] = extractCond(appSrc, appSrc.indexOf(sig));
      ok('guard extracted: ' + view, typeof conds[view] === 'string' && conds[view].length > 0);
    } catch (e) { ok('guard extracted: ' + view, false, e.message); }
  }
  try {
    const mgrAt = appSrc.indexOf("if (r.view === 'manager') {");
    if (mgrAt < 0) throw new Error('manager router branch not found');
    conds.router = extractCond(appSrc, appSrc.indexOf('{', mgrAt) + 1, 400);
    ok('guard extracted: router', typeof conds.router === 'string' && conds.router.length > 0);
  } catch (e) { ok('guard extracted: router', false, e.message); }
  try {
    const fn = extractFn(appSrc, 'function mgrGuard(app');
    /* mgrGuard renders through notAuthorized on the block path; give
     * the context the same-shaped stub so the REAL function runs. */
    vm.runInContext('this.notAuthorized = function (w) { return "NA:" + (w || ""); };', ctx);
    vm.runInContext(fn.text + '\nthis.__mgrGuard = mgrGuard;', ctx);
    mgrGuardFn = ctx.__mgrGuard;
    ok('mgrGuard extracted (real function)', typeof mgrGuardFn === 'function');
    R.mgrguard_source = fn.text;
  } catch (e) { ok('mgrGuard extracted (real function)', false, e.message); }
  for (const [view, sig] of MGR_VIEWS) {
    try {
      mgrArgs[view] = extractMgrArg(appSrc, sig);
      ok('mgrGuard call arg extracted: ' + view, true, String(mgrArgs[view]));
    } catch (e) { ok('mgrGuard call arg extracted: ' + view, false, e.message); }
  }

  if (ctx && mgrGuardFn) {
    const verdicts = (user) => {
      const out = {};
      ctx.state.user = user;
      ctx.role = user ? user.role : undefined;
      for (const view of Object.keys(conds)) {
        try { out[view] = !!vm.runInContext('(' + conds[view] + ')', ctx); }
        catch (e) { out[view] = 'eval-error'; }
      }
      for (const [view] of MGR_VIEWS) {
        try {
          const argExpr = mgrArgs[view];
          const argVal = argExpr == null ? undefined : vm.runInContext('(' + argExpr + ')', ctx);
          const fakeApp = { innerHTML: '' };
          out[view] = mgrGuardFn(fakeApp, argVal) === false;
        } catch (e) { out[view] = 'eval-error'; }
      }
      return out;
    };

    section('== the guard predicates themselves ==');
    const roleFree = (s) => typeof s === 'string' && !/\.role\b/.test(s) && !/(^|[^.\w])role\s*(!==|===)/.test(s);
    for (const view of ['floor', 'reservations', 'order', 'pay']) {
      ok('pin_' + view + '_guard_uses_floor_ops',
        typeof conds[view] === 'string' && conds[view].includes("roleHasCap(state.user, 'floor_ops')") && roleFree(conds[view]),
        conds[view]);
    }
    ok('pin_router_guard_is_pure_capability',
      conds.router === '!hasAnyCap(state.user, MANAGER_AREA_CAPS)', conds.router);
    ok('pin_mgrguard_source_role_free',
      typeof R.mgrguard_source === 'string' && roleFree(R.mgrguard_source) && R.mgrguard_source.includes('hasAnyCap'),
      String(R.mgrguard_source).slice(0, 120));
    for (const [view] of MGR_VIEWS) {
      ok('pin_arg_' + view, mgrArgs[view] === EXPECTED_MGR_ARGS[view], String(mgrArgs[view]));
    }
    ok('pin_messages_unchanged',
      typeof conds.router === 'string' &&
      appSrc.includes("notAuthorized('Manager area — please log in as a manager.')") &&
      (R.mgrguard_source || '').includes("notAuthorized('Manager area — please log in as a manager.')"));

    section('== fixture verdicts (defaults equivalence + capability flips) ==');
    for (const [name, user, expected] of FIXTURES) {
      const got = verdicts(user);
      let allOk = true;
      for (const view of ALL_VIEWS) {
        const key = 'case_' + name + '_' + view;
        R[key] = got[view];
        const exp = expected[view];
        // The router is only reached with a session (renderRoute bounces
        // anon first), and order/pay read state.user.role pre-conversion:
        // a null user is 'eval-error' there in the control, true at HEAD.
        const match = got[view] === exp || (got[view] === 'eval-error' && exp === true);
        if (!match) allOk = false;
        console.log('  ' + (match ? 'ok  ' : 'FAIL ') + key + ' = ' + JSON.stringify(got[view]) +
          ' (expected blocked=' + exp + ')');
        if (!match) failures++;
      }
      R['fix_' + name + '_as_expected'] = allOk;
    }

    if (CASES_JS) {
      section('== live login payloads (fetched by test63 from a running server) ==');
      const cases = JSON.parse(fs.readFileSync(CASES_JS, 'utf8'));
      for (const c of cases) {
        const got = verdicts(c.user);
        for (const view of ALL_VIEWS) {
          R['case_live_' + c.name + '_' + view] = got[view];
          console.log('  live ' + c.name + ' ' + view + ': blocked=' + JSON.stringify(got[view]));
        }
      }
    }
  }

  const passed = Object.values(R).filter((v) => v === true).length;
  console.log(`\nharness63_client: ${passed} true assertions, ${failures} failed`);
  console.log('@@RESULT@@' + JSON.stringify(R));
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.log('harness63_client: crashed — ' + ((e && e.stack) || e));
  console.log('@@RESULT@@' + JSON.stringify(R));
  process.exit(1);
});
