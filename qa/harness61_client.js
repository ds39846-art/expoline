#!/usr/bin/env node
/**
 * Extracted-REAL-function harness for test61 (online orders board —
 * a section of the KDS view in public/app.js).
 *
 * WHY: the 2026-10-06 live browser pass proved web online ordering
 * works end-to-end for the guest, but no staff surface consumed
 * GET/PATCH /api/online/orders — a placed order was invisible to the
 * kitchen. This batch adds the board to the KDS view. The board's
 * render/action logic lives in pure top-level builders in app.js
 * (oloBoardActions / oloBoardPlacedCount / oloBoardPickupLabel /
 * oloBoardCardHtml / oloBoardHtml / oloBoardPatch); the renderKds
 * wiring is a thin fetch + click layer over them, so this harness
 * extracts the REAL functions (plus the esc/fmt/pad2/kdsElapsed
 * helpers they use) and drives them in node:
 *   - fabricated orders in every status -> the correct buttons,
 *   - the click path's one call: oloBoardPatch must issue exactly
 *     PATCH /api/online/orders/<id> {status: <next>},
 *   - the header badge math (PLACED count only),
 *   - the honest empty state, the includes-tax row discipline, and
 *     customer-name escaping.
 *
 * Control: at 1c25431 none of the oloBoard* functions exist in
 * app.js — extraction fails and every assertion fails.
 *
 * Usage: node harness61_client.js [appJsPath]
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const APP_JS = process.argv[2] || path.join(__dirname, '..', 'public', 'app.js');
const src = fs.readFileSync(APP_JS, 'utf8');

const R = {};
let failures = 0;
function ok(name, cond, extra) {
  R[name] = !!cond;
  if (cond) console.log('  ok  ' + name);
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')); }
}

/* -------- extraction: consts end at the first ';', functions brace-match -------- */
function extractConst(s, name) {
  const i = s.indexOf('const ' + name + ' =');
  if (i < 0) throw new Error('const not found: ' + name);
  // Terminate at ';' + newline — a bare ';' also occurs inside the
  // HTML entities in esc's replace chain ('&amp;' etc.).
  const j = s.indexOf(';\n', i);
  if (j < 0) throw new Error('const unterminated: ' + name);
  return s.slice(i, j + 1);
}
function extractFn(s, name) {
  const re = new RegExp('(?:async\\s+)?function ' + name + '\\s*\\(');
  const m = re.exec(s);
  if (!m) throw new Error('function not found: ' + name);
  let depth = 0;
  const open = s.indexOf('{', m.index);
  for (let j = open; j < s.length; j++) {
    if (s[j] === '{') depth++;
    else if (s[j] === '}') { depth--; if (depth === 0) return s.slice(m.index, j + 1); }
  }
  throw new Error('function unterminated: ' + name);
}

(async () => {
  let H = null;
  try {
    const names = ['esc', 'fmt', 'pad2'];
    const fns = ['kdsElapsed', 'oloBoardActions', 'oloBoardPlacedCount',
      'oloBoardPickupLabel', 'oloBoardCardHtml', 'oloBoardHtml', 'oloBoardPatch'];
    const code = names.map((n) => extractConst(src, n)).join('\n') + '\n' +
      fns.map((n) => extractFn(src, n)).join('\n') +
      '\nthis.H = { esc, fmt, pad2, kdsElapsed, oloBoardActions, oloBoardPlacedCount,' +
      ' oloBoardPickupLabel, oloBoardCardHtml, oloBoardHtml, oloBoardPatch };';
    const ctx = vm.createContext({});
    vm.runInContext(code, ctx);
    H = ctx.H;
    ok('helpers_extracted', !!H && typeof H.oloBoardCardHtml === 'function' && typeof H.oloBoardPatch === 'function');
  } catch (e) {
    ok('helpers_extracted', false, e.message);
  }

  if (H) {
    const fiveMinAgo = new Date(Date.now() - 5 * 60000).toISOString();
    const pickup = new Date(Date.now() + 30 * 60000).toISOString();
    const base = { customer_name: 'Jane Doe', phone: '5551234567', created_at: fiveMinAgo,
      items: [{ menu_item_id: 1, name: 'Incl Burger', qty: 2, unit_price_cents: 2000, station: 'expediter' },
              { menu_item_id: 2, name: 'Plain Fries', qty: 1, unit_price_cents: 1234, station: 'garde_manger' }],
      subtotal_cents: 5234, tax_cents: 600, tax_included_cents: 288, total_cents: 5546, pickup_at: null };
    const placedIncl = { ...base, id: 7, status: 'placed' };
    const placedPickup = { ...base, id: 8, status: 'placed', pickup_at: pickup, tax_included_cents: 0 };
    const confirmed = { ...base, id: 9, status: 'confirmed' };
    const ready = { ...base, id: 10, status: 'ready' };
    const picked = { ...base, id: 11, status: 'picked_up' };
    const xss = { ...base, id: 12, status: 'placed', customer_name: '<img src=x onerror=alert(1)>' };

    const pairs = (list) => JSON.stringify((list || []).map((a) => [a.act, a.next]));
    ok('actions_placed', pairs(H.oloBoardActions('placed')) === JSON.stringify([['confirm', 'confirmed'], ['cancel', 'cancelled']]),
      pairs(H.oloBoardActions('placed')));
    ok('actions_confirmed', pairs(H.oloBoardActions('confirmed')) === JSON.stringify([['ready', 'ready'], ['cancel', 'cancelled']]),
      pairs(H.oloBoardActions('confirmed')));
    ok('actions_ready', pairs(H.oloBoardActions('ready')) === JSON.stringify([['picked_up', 'picked_up']]),
      pairs(H.oloBoardActions('ready')));
    ok('actions_terminal_empty',
      H.oloBoardActions('picked_up').length === 0 && H.oloBoardActions('cancelled').length === 0);

    ok('placed_count_mixed', H.oloBoardPlacedCount([placedIncl, placedPickup, confirmed, ready, picked]) === 2);
    ok('placed_count_zero', H.oloBoardPlacedCount([confirmed, ready]) === 0);

    const headHtml = H.oloBoardHtml([placedIncl, placedPickup, confirmed]);
    ok('header_pill_shows_count', headHtml.includes('olo-newpill') && headHtml.includes('2 NEW'),
      headHtml.slice(0, 200));
    ok('header_no_pill_when_none_placed', !H.oloBoardHtml([confirmed, ready]).includes('olo-newpill'));
    ok('empty_state_honest', H.oloBoardHtml([]).includes('No online orders waiting'));
    ok('board_html_lists_all_cards',
      headHtml.includes('ONLINE #7') && headHtml.includes('ONLINE #8') && headHtml.includes('ONLINE #9'));

    const card = H.oloBoardCardHtml(placedIncl);
    ok('card_customer_and_phone', card.includes('Jane Doe') && card.includes('5551234567'));
    ok('card_pickup_asap', card.includes('Pickup ASAP'));
    const cardPickup = H.oloBoardCardHtml(placedPickup);
    ok('card_pickup_time', !cardPickup.includes('ASAP') && /Pickup \d{1,2}:\d{2}/.test(cardPickup),
      cardPickup.slice(0, 300));
    ok('card_items_with_qty_and_line_totals',
      card.includes('2× Incl Burger') && card.includes('$40.00') &&
      card.includes('1× Plain Fries') && card.includes('$12.34'));
    ok('card_totals_and_includes_row',
      card.includes('Subtotal') && card.includes('$52.34') &&
      card.includes('Due at pickup') && card.includes('$55.46') &&
      card.includes('includes $2.88 tax in prices'));
    ok('card_no_includes_row_when_zero', !cardPickup.includes('tax in prices'));
    ok('card_buttons_placed',
      card.includes('data-olo-next="confirmed"') && card.includes('data-olo-next="cancelled"') &&
      card.includes('data-oid="7"'));
    const cardReady = H.oloBoardCardHtml(ready);
    ok('card_buttons_ready_only_pickup',
      cardReady.includes('data-olo-next="picked_up"') &&
      !cardReady.includes('data-olo-next="cancelled"') && !cardReady.includes('data-olo-next="confirmed"'));
    ok('card_age_span', card.includes('data-oage="' + fiveMinAgo + '"'));
    const cardXss = H.oloBoardCardHtml(xss);
    ok('card_escapes_customer_name', cardXss.includes('&lt;img') && !cardXss.includes('<img src=x'));

    const calls = [];
    const fakeApi = async (p, method, body) => { calls.push([p, method, body]); return { order: { id: 7, status: 'confirmed' } }; };
    const resp = await H.oloBoardPatch(fakeApi, 7, 'confirmed');
    ok('patch_issues_exact_call',
      JSON.stringify(calls) === JSON.stringify([['/api/online/orders/7', 'PATCH', { status: 'confirmed' }]]) &&
      resp && resp.order && resp.order.status === 'confirmed',
      JSON.stringify(calls));
  }

  const passed = Object.values(R).filter(Boolean).length;
  console.log(`\nharness61_client: ${passed} passed, ${failures} failed`);
  console.log('@@RESULT@@' + JSON.stringify(R));
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.log('harness61_client: crashed — ' + ((e && e.stack) || e));
  console.log('@@RESULT@@' + JSON.stringify(R));
  process.exit(1);
});
