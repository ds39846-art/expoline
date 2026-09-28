/* ============================================================================
 * Expoline — R4 role API wall (reference middleware, 2026-09-27)
 * ----------------------------------------------------------------------------
 * Single source of truth for which roles may call which API routes.
 * Roles: 'server', 'kitchen', 'manager' (see db/seed.js; users.role CHECK).
 *
 * Role sets used below:
 *   'public'  — no staff auth required (liveness, login, customer kiosk /
 *               online-ordering / guest-pay surfaces, LAN brain discovery).
 *   'partner' — OpenTable partner callbacks; authenticated via X-Partner-Key
 *               (otCallbackAuth), NOT staff Bearer tokens.
 *   'any'     — any authenticated staff token (server, kitchen, manager).
 *   ['server','manager']  — serverPlus(): floor operations.
 *   ['kitchen','manager'] — kitchenPlus(): KDS + online-order fulfillment.
 *   ['manager']           — managerOnly(): finance, pricing, labor, insights.
 *
 * DEFAULT-DENY: any method+path not listed here is rejected (403 for
 * authenticated callers, 401 when no session exists). New endpoints must be
 * added to ROLE_MAP before they become reachable.
 *
 * Scattered inline checks this map DOCUMENTS but does not replace (they run
 * inside handlers, after the middleware):
 *   - market-price menu items (price_cents = 0): only a manager may supply
 *     unit_price_cents (server.js add-item / pre-order paths).
 *   - void / void-item / comp / split: serverPlus() at the gate, then a
 *     FRESH manager PIN (verifyManagerPin) per action, audit-logged.
 *   - POST /api/cash/drawer/close: live code uses drawerCloseGate() —
 *     managerOnly() by default, serverPlus() when site config
 *     drawer_close_role = 'server' (deliberate, decided 2026-09-26).
 *     This wall defaults to manager-only (the safe default); call
 *     setDrawerCloseRole('server') at integration time ONLY if the site
 *     has explicitly opted into the server-close policy.
 *
 * INTEGRATION (one line, when the merge hold lifts — DO NOT wire yet):
 *   const { roleWall } = require('./middleware/roleWall');
 *   app.use('/api', roleWall);   // AFTER authMiddleware (it needs req.user),
 *                                // BEFORE all route registrations.
 * The wall is additive defense: existing per-route requireRole() guards stay
 * in place. If the wall and a route guard ever disagree, the STRICTER of the
 * two wins (both must call next()).
 * ========================================================================== */

'use strict';

/* method, path (Express :param style), roles */
const ROLE_MAP = [
  // ---- public: no staff auth -------------------------------------------
  ['GET', '/api/health', 'public'],
  ['POST', '/api/auth/login', 'public'],
  ['POST', '/api/auth/logout', 'public'],
  ['GET', '/api/brain/status', 'public'],
  ['GET', '/api/online/menu', 'public'],
  ['POST', '/api/online/orders', 'public'],
  ['GET', '/api/online/last', 'public'],
  ['GET', '/api/kiosk/menu', 'public'],
  ['POST', '/api/kiosk/order', 'public'],
  ['POST', '/api/kiosk/call-staff', 'public'],
  ['GET', '/api/menuboards', 'public'],
  ['GET', '/g/:token', 'public'],
  ['GET', '/g/check/:guest_token', 'public'],
  ['GET', '/api/guest/menu', 'public'],
  ['POST', '/api/guest/orders', 'public'],
  ['GET', '/api/guest/check', 'public'],
  ['POST', '/api/guest/pay', 'public'],
  ['POST', '/api/guest/split', 'public'],
  ['POST', '/api/guest/feedback', 'public'],

  // ---- partner: OpenTable callbacks (X-Partner-Key, not staff tokens) ---
  ['POST', '/api/opentable/lock', 'partner'],
  ['POST', '/api/opentable/reservations', 'partner'],
  ['PATCH', '/api/opentable/reservations/:confirmation', 'partner'],
  ['DELETE', '/api/opentable/reservations/:confirmation', 'partner'],
  ['GET', '/api/opentable/recovery', 'partner'],

  // ---- any authenticated staff ------------------------------------------
  ['GET', '/api/config', 'any'],
  ['GET', '/api/menu', 'any'],
  ['GET', '/api/zones', 'any'],
  ['POST', '/api/clock/in', 'any'],
  ['POST', '/api/clock/out', 'any'],
  ['POST', '/api/clock/break/start', 'any'],
  ['POST', '/api/clock/break/end', 'any'],
  ['POST', '/api/clock/break/waive', 'any'], // own shift only (handler-scoped)
  ['GET', '/api/clock/status', 'any'],
  ['GET', '/api/login-summary', 'any'],

  // ---- server+ : floor operations ---------------------------------------
  ['POST', '/api/checks', ['server', 'manager']],
  ['GET', '/api/checks/open', ['server', 'manager']],
  ['GET', '/api/checks/:id', ['server', 'manager']],
  ['PATCH', '/api/checks/:id', ['server', 'manager']],
  ['POST', '/api/checks/:id/items', ['server', 'manager']],
  ['DELETE', '/api/checks/:id/items/:item_id', ['server', 'manager']],
  ['PATCH', '/api/checks/:id/items/:item_id', ['server', 'manager']],
  ['POST', '/api/checks/:id/items/:item_id/discount', ['server', 'manager']],
  ['POST', '/api/checks/:id/items/:item_id/duplicate', ['server', 'manager']],
  ['POST', '/api/checks/:id/items/:itemId/refire', ['server', 'manager']],
  ['POST', '/api/checks/:id/void-item', ['server', 'manager']], // + fresh mgr PIN
  ['POST', '/api/checks/:id/void', ['server', 'manager']],     // + fresh mgr PIN
  ['POST', '/api/checks/:id/comp', ['server', 'manager']],     // + fresh mgr PIN
  ['POST', '/api/checks/:id/send', ['server', 'manager']],
  ['POST', '/api/checks/:id/send-now', ['server', 'manager']],
  ['POST', '/api/checks/:id/fire-course', ['server', 'manager']],
  ['GET', '/api/checks/:id/fire-schedule', ['server', 'manager']],
  ['POST', '/api/checks/:id/split', ['server', 'manager']],    // + mgr PIN unless split_allowed
  ['POST', '/api/checks/:id/payments', ['server', 'manager']],
  ['POST', '/api/checks/:id/close', ['server', 'manager']],
  ['POST', '/api/checks/:id/merge', ['server', 'manager']],
  ['POST', '/api/checks/:id/move', ['server', 'manager']],
  ['PUT', '/api/checks/:id/seats/:seat/name', ['server', 'manager']],
  ['GET', '/api/course-timing', ['server', 'manager']],
  ['POST', '/api/reservations', ['server', 'manager']],
  ['GET', '/api/reservations', ['server', 'manager']],
  ['PATCH', '/api/reservations/:id', ['server', 'manager']],
  ['POST', '/api/waitlist', ['server', 'manager']],
  ['GET', '/api/waitlist', ['server', 'manager']],
  ['GET', '/api/waitlist/quote', ['server', 'manager']],
  ['POST', '/api/waitlist/:id/notify', ['server', 'manager']],
  ['POST', '/api/waitlist/:id/seat', ['server', 'manager']],
  ['PATCH', '/api/waitlist/:id', ['server', 'manager']],
  ['GET', '/api/floor/availability', ['server', 'manager']],
  ['GET', '/api/floor/timers', ['server', 'manager']],
  ['GET', '/api/dayparts', ['server', 'manager']],
  ['GET', '/api/cash/drawer', ['server', 'manager']], // blind: expected hidden from non-managers
  ['POST', '/api/cash/drawer/event', ['server', 'manager']],
  ['GET', '/api/gift-cards/balance/:code', ['server', 'manager']],
  ['POST', '/api/gift-cards/redeem', ['server', 'manager']],
  ['GET', '/api/loyalty/lookup', ['server', 'manager']],
  ['GET', '/api/loyalty/customer/:id', ['server', 'manager']],
  ['POST', '/api/loyalty/earn', ['server', 'manager']],
  ['POST', '/api/loyalty/redeem', ['server', 'manager']],
  ['GET', '/api/kiosk/calls', ['server', 'manager']],
  ['POST', '/api/kiosk/calls/:id/clear', ['server', 'manager']],
  ['POST', '/api/reviews', ['server', 'manager']],
  ['POST', '/api/delivery/orders', ['server', 'manager']],
  ['GET', '/api/delivery/orders', ['server', 'manager']],
  ['GET', '/api/cash-requests', ['server', 'manager']],
  ['POST', '/api/cash-requests/:id/collect', ['server', 'manager']],
  ['POST', '/api/cash-requests/:id/cancel', ['server', 'manager']],
  ['GET', '/api/tables/:id/qr', ['server', 'manager']],
  ['GET', '/api/admin/opentable/status', ['server', 'manager']], // FINDING F2: only /api/admin/* not manager-only

  // ---- kitchen+ : KDS + online fulfillment -------------------------------
  ['GET', '/api/kds/tickets', ['kitchen', 'manager']],
  ['POST', '/api/kds/tickets/:id/bump', ['kitchen', 'manager']],
  ['GET', '/api/kds/recall', ['kitchen', 'manager']],
  ['GET', '/api/kds/settings', ['kitchen', 'manager']],
  ['GET', '/api/kds/alerts', ['kitchen', 'manager']],
  ['GET', '/api/online/orders', ['kitchen', 'manager']],
  ['GET', '/api/online/orders/:id', ['kitchen', 'manager']],
  ['PATCH', '/api/online/orders/:id', ['kitchen', 'manager']],

  // ---- manager: finance --------------------------------------------------
  ['GET', '/api/finance/payouts', ['manager']],
  ['GET', '/api/finance/shift', ['manager']],
  ['GET', '/api/finance/reports/:report', ['manager']],
  ['GET', '/api/finance/product-mix', ['manager']],
  ['POST', '/api/payments/:id/refund', ['manager']],
  ['GET', '/api/manager/overview', ['manager']],
  ['GET', '/api/cash/log', ['manager']],
  ['POST', '/api/cash/drawer/open', ['manager']],

  // ---- manager: pricing --------------------------------------------------
  ['GET', '/api/admin/menu', ['manager']],
  ['POST', '/api/admin/menu/categories', ['manager']],
  ['PUT', '/api/admin/menu/categories/:id', ['manager']],
  ['DELETE', '/api/admin/menu/categories/:id', ['manager']],
  ['POST', '/api/admin/menu/items', ['manager']],
  ['PUT', '/api/admin/menu/items/:id', ['manager']],
  ['DELETE', '/api/admin/menu/items/:id', ['manager']],
  ['POST', '/api/admin/menu/86/:id', ['manager']],
  ['PUT', '/api/admin/menu/items/:id/popular', ['manager']],
  ['GET', '/api/admin/menu/audit', ['manager']],
  ['GET', '/api/admin/menu/items/:id/modifier-groups', ['manager']],
  ['POST', '/api/admin/menu/items/:id/modifier-groups', ['manager']],
  ['PUT', '/api/admin/menu/modifier-groups/:groupId', ['manager']],
  ['DELETE', '/api/admin/menu/modifier-groups/:groupId', ['manager']],
  ['POST', '/api/admin/menu/modifier-groups/:groupId/options', ['manager']],
  ['PUT', '/api/admin/menu/modifier-options/:optionId', ['manager']],
  ['DELETE', '/api/admin/menu/modifier-options/:optionId', ['manager']],
  ['GET', '/api/admin/dayparts', ['manager']],
  ['PUT', '/api/admin/dayparts', ['manager']],
  ['PUT', '/api/course-timing', ['manager']], // live: stacked serverPlus+managerOnly = effective manager
  ['GET', '/api/admin/service-charge/config', ['manager']],
  ['PUT', '/api/admin/service-charge/config', ['manager']],
  ['GET', '/api/admin/service-charge/audit', ['manager']],
  ['GET', '/api/admin/drawer/config', ['manager']],
  ['PUT', '/api/admin/drawer/config', ['manager']],
  ['POST', '/api/cash/drawer/close', ['manager']], // FINDING F1: live drawerCloseGate() also permits server when drawer_close_role='server'
  ['GET', '/api/tipout/rules', ['manager']],
  ['POST', '/api/tipout/rules', ['manager']],
  ['PUT', '/api/tipout/rules/:id', ['manager']],
  ['DELETE', '/api/tipout/rules/:id', ['manager']],
  ['GET', '/api/tipout/report', ['manager']],

  // ---- manager: labor ----------------------------------------------------
  ['GET', '/api/admin/clock/shifts', ['manager']],
  ['POST', '/api/admin/clock/adjust', ['manager']],
  ['GET', '/api/admin/clock/config', ['manager']],
  ['PUT', '/api/admin/clock/config', ['manager']],
  ['GET', '/api/admin/clock/users', ['manager']],
  ['PUT', '/api/admin/clock/users/:id/rate', ['manager']],
  ['GET', '/api/admin/clock/audit', ['manager']],
  ['GET', '/api/admin/employees', ['manager']],
  ['GET', '/api/admin/employees/next-number', ['manager']],
  ['POST', '/api/admin/employees', ['manager']],
  ['PUT', '/api/admin/employees/:id', ['manager']],
  ['DELETE', '/api/admin/employees/:id', ['manager']],
  ['GET', '/api/admin/schedule', ['manager']],
  ['POST', '/api/admin/schedule', ['manager']],
  ['PUT', '/api/admin/schedule/:id', ['manager']],
  ['DELETE', '/api/admin/schedule/:id', ['manager']],
  ['GET', '/api/admin/schedule/projection', ['manager']],

  // ---- manager: insights / "ask the restaurant" ---------------------------
  ['GET', '/api/insights/digest', ['manager']],
  ['POST', '/api/insights/ask', ['manager']],
  ['GET', '/api/reviews', ['manager']],
  ['GET', '/api/guest/feedback', ['manager']],

  // ---- manager: inventory -------------------------------------------------
  ['GET', '/api/admin/inventory/ingredients', ['manager']],
  ['POST', '/api/admin/inventory/ingredients', ['manager']],
  ['PUT', '/api/admin/inventory/ingredients/:id', ['manager']],
  ['DELETE', '/api/admin/inventory/ingredients/:id', ['manager']],
  ['GET', '/api/admin/inventory/recipes', ['manager']],
  ['POST', '/api/admin/inventory/recipes', ['manager']],
  ['POST', '/api/admin/inventory/adjust', ['manager']],
  ['GET', '/api/inventory/status', ['manager']],

  // ---- manager: platform / admin ------------------------------------------
  ['GET', '/api/admin/zones', ['manager']],
  ['POST', '/api/admin/zones', ['manager']],
  ['PUT', '/api/admin/zones/:id', ['manager']],
  ['DELETE', '/api/admin/zones/:id', ['manager']],
  ['POST', '/api/admin/tables', ['manager']],
  ['PUT', '/api/admin/tables/:id', ['manager']],
  ['DELETE', '/api/admin/tables/:id', ['manager']],
  ['DELETE', '/api/reservations/:id', ['manager']],
  ['DELETE', '/api/waitlist/:id', ['manager']],
  ['POST', '/api/kds/settings', ['manager']],
  ['GET', '/api/admin/approvals/audit', ['manager']],
  ['POST', '/api/admin/opentable/link', ['manager']],
  ['DELETE', '/api/admin/opentable/link', ['manager']],
  ['GET', '/api/admin/opentable/outbound', ['manager']],
  ['POST', '/api/admin/opentable/reconcile', ['manager']],
  ['POST', '/api/admin/opentable/publish-availability', ['manager']],
  ['GET', '/api/admin/floor/config', ['manager']],
  ['PUT', '/api/admin/floor/config', ['manager']],
  ['POST', '/api/admin/notes', ['manager']],
  ['GET', '/api/admin/notes', ['manager']],
  ['PUT', '/api/admin/notes/:id', ['manager']],
  ['DELETE', '/api/admin/notes/:id', ['manager']],
  ['PUT', '/api/admin/settings', ['manager']],
  ['GET', '/api/admin/multisite/overview', ['manager']],
  ['POST', '/api/gift-cards/issue', ['manager']],
  ['POST', '/api/gift-cards/reload', ['manager']],
  ['POST', '/api/gift-cards/void', ['manager']],
  ['GET', '/api/gift-cards', ['manager']],
  ['GET', '/api/gift-cards/:code/txns', ['manager']],
  ['POST', '/api/guest/split/reverse', ['manager']],
  ['POST', '/api/tables/:id/qr/rotate', ['manager']],
  ['GET', '/api/openapi.json', ['manager']],
  ['GET', '/api/docs', ['manager']],
];

/* drawer/close policy override: 'manager' (default, safe) or 'server'.
 * Mirrors live drawerCloseGate(). Only change at integration time with an
 * explicit site decision. */
let drawerCloseRole = 'manager';
function setDrawerCloseRole(r) {
  drawerCloseRole = r === 'server' ? 'server' : 'manager';
}

const _regexCache = new Map();
function _toRegex(path) {
  if (!_regexCache.has(path)) {
    _regexCache.set(path, new RegExp('^' + path.split('/').map((seg) =>
      seg.startsWith(':') ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    ).join('/') + '$'));
  }
  return _regexCache.get(path);
}

/* Returns the ROLE_MAP entry for (method, path), or null. Exported for tests. */
function matchRoute(method, path) {
  const m = String(method || '').toUpperCase();
  for (const [em, epath, roles] of ROLE_MAP) {
    if (em !== m) continue;
    if (_toRegex(epath).test(path)) return { method: em, path: epath, roles };
  }
  return null;
}

function roleWall(req, res, next) {
  const entry = matchRoute(req.method, req.path);
  // DEFAULT-DENY: unlisted route.
  if (!entry) {
    const code = req.user ? 403 : 401;
    return res.status(code).json({ error: `Forbidden: no role-wall entry for ${req.method} ${req.path} (default-deny)` });
  }
  const roles = entry.roles;
  if (roles === 'public' || roles === 'partner') return next(); // partner enforced by otCallbackAuth
  if (!req.user) return res.status(401).json({ error: 'Unauthorized: valid Bearer <redacted> required' });
  if (roles === 'any') return next();
  let allowed = roles;
  if (entry.path === '/api/cash/drawer/close' && drawerCloseRole === 'server') {
    allowed = ['server', 'manager'];
  }
  if (!allowed.includes(req.user.role)) {
    return res.status(403).json({ error: `Forbidden: requires role ${allowed.join(' or ')}` });
  }
  next();
}

module.exports = { roleWall, ROLE_MAP, matchRoute, setDrawerCloseRole };
