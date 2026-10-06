#!/usr/bin/env node
/**
 * Extracted-REAL-code harness for test62 (KDS view guard — capability
 * rider on the online-board batch).
 *
 * The renderKds entry guard used to hard-block role === 'server'
 * (commit 6b5cf7d9, 2026-09-26 — pre-matrix). Since test56, access to
 * the KDS surface is supposed to follow the kitchen_ops capability:
 * the nav link renders on it, the online board gates on it, and the
 * API enforces it (kitchenPlus = requireCap('kitchen_ops'); test61 §C
 * proved a matrix grant flips a server's API access live). The view
 * itself was the one surface still reading the raw role.
 *
 * This harness extracts, from the REAL public/app.js:
 *   1. the capability helper block (CLIENT_CAP_DEFAULTS .. userCaps /
 *      roleHasCap / hasAnyCap) — the same block harness56 extracts;
 *   2. the FIRST if-condition inside renderKds — the entry guard's
 *      actual predicate text, paren-matched out of the shipped file.
 * It then evaluates that exact predicate, with the real helpers in
 * scope, against fixture users and (optionally) live login payloads
 * the python suite fetched from a running server.
 *
 * Control: at 5f101fa the extracted predicate is the role test — the
 * capability pin fails and a kitchen_ops-granted server fixture is
 * still blocked, while default server/kitchen/manager outcomes match
 * HEAD exactly (the equivalence the rider must preserve).
 *
 * Usage: node harness62_client.js [appJsPath] [liveCasesJsonPath]
 *   liveCasesJsonPath: [{"name": "...", "user": {...}|null}, ...]
 *   For each case two extra results are emitted:
 *     live_<name>_guard_blocks  — the extracted predicate's verdict
 *     live_<name>_legacy_blocks — the pre-rider predicate
 *                                 (user.role === 'server') on the same
 *                                 payload, for the flip comparison.
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

/* The entry guard = the first `if (...)` after the renderKds
 * signature. Paren-match the condition so nested calls survive. */
function extractGuard(src) {
  const sig = src.indexOf('async function renderKds(app) {');
  if (sig < 0) throw new Error('renderKds not found');
  const head = src.slice(sig, sig + 600);
  const ifAt = head.indexOf('if (');
  if (ifAt < 0) throw new Error('no entry if in renderKds head');
  let depth = 0, end = -1;
  for (let i = ifAt + 3; i < head.length; i++) {
    if (head[i] === '(') depth++;
    else if (head[i] === ')') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end < 0) throw new Error('guard condition parens unbalanced');
  return { cond: head.slice(ifAt + 4, end), after: head.slice(end + 1, end + 220) };
}

(async () => {
  section('== extraction: real capability helpers + the real renderKds entry guard ==');
  let ctx = null, guard = null;
  try {
    ctx = vm.createContext({ state: { user: null }, console });
    vm.runInContext(extractHelpers(appSrc) +
      '\nthis.__rhc = roleHasCap;', ctx);
    ok('helpers extracted (userCaps / roleHasCap)', typeof ctx.__rhc === 'function');
  } catch (e) {
    ok('helpers extracted (userCaps / roleHasCap)', false, e.message);
  }
  try {
    guard = extractGuard(appSrc);
    ok('renderKds entry guard extracted', !!guard.cond, JSON.stringify(guard));
  } catch (e) {
    ok('renderKds entry guard extracted', false, e.message);
  }

  if (ctx && guard) {
    const blocks = (user) => {
      ctx.state.user = user;
      return !!vm.runInContext('(' + guard.cond + ')', ctx);
    };
    const tryBlocks = (user) => {
      try { return blocks(user); } catch (e) { return 'eval-error'; }
    };

    section('== the guard predicate itself ==');
    ok('guard_uses_kitchen_ops_capability',
      /roleHasCap/.test(guard.cond) && guard.cond.includes("'kitchen_ops'") && !/\.role\s*===/.test(guard.cond),
      guard.cond);
    ok('guard_message_unchanged',
      guard.after.includes("notAuthorized('The kitchen display is for kitchen and manager roles.')"),
      guard.after.slice(0, 120));

    section('== fixture verdicts (default matrix + the grant flip) ==');
    ok('server_default_blocks', tryBlocks({ role: 'server' }) === true);
    ok('server_explicit_default_caps_blocks',
      tryBlocks({ role: 'server', capabilities: ['floor_ops', 'menu_86'] }) === true);
    ok('server_granted_kitchen_ops_passes',
      tryBlocks({ role: 'server', capabilities: ['floor_ops', 'menu_86', 'kitchen_ops'] }) === false);
    ok('kitchen_default_passes', tryBlocks({ role: 'kitchen' }) === false);
    ok('manager_default_passes', tryBlocks({ role: 'manager' }) === false);
    ok('kitchen_stripped_of_kitchen_ops_blocks',
      tryBlocks({ role: 'kitchen', capabilities: ['menu_86'] }) === true);
    ok('null_user_blocks', tryBlocks(null) === true);

    if (CASES_JS) {
      section('== live login payloads (fetched by test62 from a running server) ==');
      const cases = JSON.parse(fs.readFileSync(CASES_JS, 'utf8'));
      for (const c of cases) {
        const verdict = tryBlocks(c.user);
        R['live_' + c.name + '_guard_blocks'] = verdict;
        console.log('  live ' + c.name + ': guard_blocks=' + JSON.stringify(verdict));
        const legacy = !!(c.user && c.user.role === 'server');
        R['live_' + c.name + '_legacy_blocks'] = legacy;
        console.log('  live ' + c.name + ': legacy_blocks=' + JSON.stringify(legacy));
      }
    }
  }

  const passed = Object.values(R).filter(Boolean).length;
  console.log(`\nharness62_client: ${passed} passed, ${failures} failed`);
  console.log('@@RESULT@@' + JSON.stringify(R));
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.log('harness62_client: crashed — ' + ((e && e.stack) || e));
  console.log('@@RESULT@@' + JSON.stringify(R));
  process.exit(1);
});
