#!/usr/bin/env node
/**
 * Extracted-REAL-function harness for test56 (capability matrix —
 * audit gap #10).
 *
 * The client half of the batch lives or dies on three facts:
 *   1. The show/hide helpers (userCaps / roleHasCap / hasAnyCap) must
 *      reproduce the pre-matrix role rendering EXACTLY when a session
 *      carries no capabilities array (old saved sessions), and must
 *      honor a server-supplied capabilities array when one exists.
 *   2. buildPermissionsPayload (editor grid -> PUT body) must emit
 *      only the roles present in the grid, with capabilities in the
 *      canonical order the server sent — the server leaves unlisted
 *      roles untouched, so a stray role key would be a real change.
 *   3. The wiring exists: nav reads capabilities, the manager-area
 *      guard consults them, login persists them, the Permissions
 *      editor route + grid + PUT are present.
 *
 * Control: at 83b91bb none of the helpers or wiring exists —
 * extraction fails and every wiring assert fails.
 *
 * Usage: node harness56_client.js [appJsPath]
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

function extractBlock(src) {
  const a = src.indexOf('const CLIENT_CAP_DEFAULTS');
  const b = src.indexOf('/* ---------------- header / nav ---------------- */');
  if (a < 0 || b < 0 || b <= a) throw new Error('capability helper block not found');
  return src.slice(a, b);
}

(async () => {
  section('== extraction: the real capability helpers from public/app.js ==');
  let H = null;
  try {
    const ctx = vm.createContext({});
    vm.runInContext(extractBlock(appSrc) +
      '\nthis.H = { CLIENT_CAP_DEFAULTS, MANAGER_AREA_CAPS, userCaps, roleHasCap, hasAnyCap, buildPermissionsPayload };', ctx);
    H = ctx.H;
    ok('helpers extracted (CLIENT_CAP_DEFAULTS, userCaps, roleHasCap, hasAnyCap, buildPermissionsPayload)',
      !!H && typeof H.roleHasCap === 'function' && typeof H.buildPermissionsPayload === 'function');
  } catch (e) {
    ok('helpers extracted', false, e.message);
  }

  if (H) {
    section('== legacy sessions (no capabilities array) render exactly as pre-matrix ==');
    const srv = { role: 'server' }, kit = { role: 'kitchen' }, mgr = { role: 'manager' };
    ok('server defaults = floor_ops + menu_86',
      JSON.stringify(H.userCaps(srv)) === JSON.stringify(['floor_ops', 'menu_86']), JSON.stringify(H.userCaps(srv)));
    ok('kitchen defaults = kitchen_ops + menu_86',
      JSON.stringify(H.userCaps(kit)) === JSON.stringify(['kitchen_ops', 'menu_86']));
    ok('manager defaults = all 12 capabilities', H.userCaps(mgr).length === 12 && H.roleHasCap(mgr, 'permissions_admin'));
    ok('pre-matrix nav semantics: server sees floor, not KDS',
      H.roleHasCap(srv, 'floor_ops') && !H.roleHasCap(srv, 'kitchen_ops'));
    ok('pre-matrix nav semantics: kitchen sees KDS, not floor',
      H.roleHasCap(kit, 'kitchen_ops') && !H.roleHasCap(kit, 'floor_ops'));
    ok('manager area: plain server/kitchen have no manager-area cap',
      !H.hasAnyCap(srv, H.MANAGER_AREA_CAPS) && !H.hasAnyCap(kit, H.MANAGER_AREA_CAPS));
    ok('manager area: manager has manager-area caps', H.hasAnyCap(mgr, H.MANAGER_AREA_CAPS));
    ok('null user has no capabilities', H.userCaps(null).length === 0 && !H.roleHasCap(null, 'floor_ops'));

    section('== server-supplied capabilities array wins over role defaults ==');
    const lead = { role: 'kitchen', capabilities: ['kitchen_ops', 'menu_86', 'finance_reports'] };
    ok('granted kitchen reads finance_reports', H.roleHasCap(lead, 'finance_reports'));
    ok('granted kitchen still lacks floor_ops', !H.roleHasCap(lead, 'floor_ops'));
    const demoted = { role: 'manager', capabilities: ['floor_ops'] };
    ok('an explicit array replaces defaults wholesale (manager with only floor_ops)',
      H.userCaps(demoted).length === 1 && !H.roleHasCap(demoted, 'site_admin'));
    ok('an empty explicit array means no capabilities', H.userCaps({ role: 'server', capabilities: [] }).length === 0);

    section('== buildPermissionsPayload: grid -> PUT body ==');
    const capKeys = ['floor_ops', 'kitchen_ops', 'menu_86', 'finance_reports', 'permissions_admin'];
    const grid = {
      server: { floor_ops: true, menu_86: true, finance_reports: false },
      kitchen: { finance_reports: true, kitchen_ops: true, menu_86: false },
    };
    const payload = H.buildPermissionsPayload(grid, capKeys);
    ok('payload carries only the grid roles', JSON.stringify(Object.keys(payload.matrix).sort()) === JSON.stringify(['kitchen', 'server']),
      JSON.stringify(payload));
    ok('server row = checked caps in canonical order',
      JSON.stringify(payload.matrix.server) === JSON.stringify(['floor_ops', 'menu_86']), JSON.stringify(payload.matrix.server));
    ok('kitchen row = checked caps in canonical order (not click order)',
      JSON.stringify(payload.matrix.kitchen) === JSON.stringify(['kitchen_ops', 'finance_reports']), JSON.stringify(payload.matrix.kitchen));
    ok('an all-unchecked role emits an empty set (a real revoke-all)',
      JSON.stringify(H.buildPermissionsPayload({ server: { floor_ops: false } }, capKeys).matrix.server) === '[]');
    ok('empty grid emits an empty matrix', JSON.stringify(H.buildPermissionsPayload({}, capKeys)) === '{"matrix":{}}');
  }

  section('== wiring pins (source) ==');
  ok('nav floor link is capability-driven', appSrc.includes("roleHasCap(state.user, 'floor_ops')"));
  ok('nav KDS link is capability-driven', appSrc.includes("roleHasCap(state.user, 'kitchen_ops')"));
  ok('manager-area guard consults capabilities', appSrc.includes('hasAnyCap(state.user, MANAGER_AREA_CAPS)'));
  ok('login persists the server capabilities', appSrc.includes('capabilities: Array.isArray(user.capabilities)'));
  ok('permissions editor exists and is route-dispatched',
    appSrc.includes('async function renderPermissions(app)') && appSrc.includes("if (sub === 'permissions') return renderPermissions(app);"));
  ok('editor renders the checkbox grid', appSrc.includes('data-perm-role') && appSrc.includes('data-perm-cap'));
  ok('editor saves through the matrix PUT', appSrc.includes("api('/api/admin/permissions', 'PUT', payload)"));
  ok('editor offers reset-to-defaults', appSrc.includes("api('/api/admin/permissions', 'PUT', { reset: true })"));
  ok('manager/permissions_admin cell is locked in the editor', appSrc.includes("c.key === 'permissions_admin'"));
  ok('mgrNav carries the Permissions tab', appSrc.includes("['#/manager/permissions', 'Permissions', active === 'permissions']"));

  console.log('\nharness56: ' + (failures === 0 ? 'ALL PASS' : failures + ' FAILURES'));
  process.exit(failures === 0 ? 0 : 1);
})();
