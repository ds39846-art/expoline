"""Expoline time-clock full verification suite (scratch DB, port 4321)."""
import json, urllib.request, urllib.error, datetime, sqlite3, sys
import os

BASE = os.environ.get("EXPOLINE_BASE", os.environ.get("EXPLOINE_BASE", "http://localhost:4321"))
passed, failed = [], []
def check(name, cond, detail=''):
    (passed if cond else failed).append(name)
    print(('PASS ' if cond else 'FAIL ') + name + (f' [{detail}]' if detail and not cond else ''))

def call(method, path, token=None, body=None):
    req = urllib.request.Request(BASE + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={'Content-Type': 'application/json', **({'Authorization': 'Bearer ' + token} if token else {})})
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read() or b'null')
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:400]

def login(pin):
    s, b = call('POST', '/api/auth/login', body={'pin': pin, 'site': 'bali-hai'})
    assert s == 200, (s, b)
    return b['token'], b['user']

st, su = login('1111'); kt, ku = login('2222'); mt, mu = login('2580')
check('login server/kitchen/manager', su['role'] == 'server' and ku['role'] == 'kitchen' and mu['role'] == 'manager')

# --- lifecycle ---
s, b = call('POST', '/api/clock/in', st)
check('clock in 201', s == 201, (s, b))
s, b = call('POST', '/api/clock/in', st)
check('duplicate clock-in 400', s == 400, (s, b))
s, b = call('GET', '/api/clock/status', st)
check('status open', s == 200 and b.get('open') is True, (s, b))
s, b = call('POST', '/api/clock/break/end', st, {'type': 'meal', 'duty_free': True})
check('end meal not started 400', s == 400, (s, b))
s, b = call('POST', '/api/clock/break/start', st, {'type': 'meal'})
check('meal start 201', s == 201, (s, b))
s, b = call('POST', '/api/clock/break/end', st, {'type': 'meal'})
check('meal end w/o attestation 400', s == 400, (s, b))
s, b = call('POST', '/api/clock/break/end', st, {'type': 'meal', 'duty_free': True})
check('meal end w/ attestation 200', s == 200, (s, b))
s, b = call('POST', '/api/clock/break/start', st, {'type': 'rest'})
check('rest start 201', s == 201, (s, b))
s, b = call('POST', '/api/clock/break/end', st, {'type': 'rest'})
check('rest end 200', s == 200, (s, b))
s, b = call('POST', '/api/clock/out', st)
check('clock out 200', s == 200, (s, b))
s, b = call('GET', '/api/clock/status', st)
check('status closed', s == 200 and b.get('clocked_in') is False, (s, b))

# --- manager adjust (needs an existing shift: clock in again, then adjust) ---
s, b = call('POST', '/api/clock/in', st)
sid = b['id']
s, b = call('POST', '/api/admin/clock/adjust', mt, {'shift_id': sid, 'manager_pin': '2580'})
check('adjust empty patch 400', s == 400, (s, b))
s, b = call('POST', '/api/clock/out', st)
check('clock out 2', s == 200, (s, b))
s, b = call('POST', '/api/admin/clock/adjust', mt, {'shift_id': 999999, 'clock_in': '2026-01-01T09:00:00', 'manager_pin': '2580'})
check('adjust unknown shift 400', s == 400, (s, b))

# --- role enforcement ---
s, b = call('GET', '/api/admin/clock/shifts', kt)
check('kitchen denied admin shifts 403', s == 403, (s, b))
s, b = call('POST', '/api/admin/clock/adjust', st, {'shift_id': sid})
check('server denied adjust 403', s == 403, (s, b))
s, b = call('GET', '/api/clock/status')
check('no token 401', s == 401, (s, b))
s, b = call('POST', '/api/clock/in', st, {'user_id': ku['id']})
check('non-manager clock-in other 403', s == 403, (s, b))
s, b = call('POST', '/api/clock/in', mt, {'user_id': ku['id']})
check('manager clock-in other 201', s == 201, (s, b))
ksid = b['id']
s, b = call('POST', '/api/clock/out', mt, {'user_id': ku['id']})
check('manager clock-out other 200', s == 200 and b.get('open') is False, (s, b))
s, b = call('GET', '/api/admin/clock/audit', mt)
acts = [a['action'] for a in (b if isinstance(b, list) else [])]
check('manager clock-out audited', 'manager_clock_out' in acts, acts[:6])

# --- config ---
s, b = call('GET', '/api/admin/clock/config', mt)
check('config read', s == 200 and b['effective']['meal_break_min'] == 30, (s, b))
s, b = call('PUT', '/api/admin/clock/config', mt, {'key': 'meal_break_min', 'value': 30})
check('config write', s == 200, (s, b))
s, b = call('PUT', '/api/admin/clock/config', mt, {'key': 'nope', 'value': 1})
check('config unknown key 400', s == 400, (s, b))
s, b = call('PUT', '/api/admin/clock/config', mt, {'key': 'meal_break_min', 'value': -5})
check('config negative 400', s == 400, (s, b))
s, b = call('GET', '/api/admin/clock/config', st)
check('server denied config 403', s == 403, (s, b))

# --- rates ---
s, users = call('GET', '/api/admin/clock/users', mt)
srv = [u for u in users if u['role'] == 'server'][0]
s, b = call('PUT', f"/api/admin/clock/users/{srv['id']}/rate", mt, {'hourly_rate_cents': 1800})
check('rate update 200', s == 200, (s, b))
s, b = call('PUT', f"/api/admin/clock/users/{srv['id']}/rate", mt, {'hourly_rate_cents': -100})
check('negative rate 400', s == 400, (s, b))

# --- admin labor rollup ---
today = datetime.date.today().isoformat()
s, b = call('GET', f'/api/admin/clock/shifts?date={today}', mt)
check('admin shifts 200', s == 200 and 'labor' in b and 'shifts' in b, (s, str(b)[:100]))

# --- regression: floor admin, menu admin, finance, overview ---
s, b = call('GET', '/api/admin/zones', mt)
check('floor admin regression', s == 200 and isinstance(b, list), (s, b))
s, b = call('GET', '/api/admin/menu', mt)
check('menu admin regression', s == 200, (s, str(b)[:100]))
s, b = call('GET', f'/api/finance/payouts?date={today}', mt)
check('finance regression + labor_cents', s == 200 and 'labor_cents' in b, (s, str(b)[:120]))
s, b = call('GET', '/api/manager/overview', mt)
check('overview labor field', s == 200 and 'labor' in b and 'total_cents' in b['labor'], (s, str(b)[:120]))

# --- order -> send -> cash -> close regression ---
s, menu = call('GET', '/api/menu', st)
cats = menu.get('categories', []) if isinstance(menu, dict) else menu
item = None
for c in cats:
    for it in c.get('items', []):
        if it.get('available') is not False:
            item = it; break
    if item: break
check('menu has item', item is not None)
s, zones = call('GET', '/api/zones', st)
t = None
for z in zones:
    if z.get('tables'):
        t = z['tables'][0]; break
check('floor has table', t is not None)
s, chk = call('POST', '/api/checks', st, {'table_id': t['id'], 'guest_count': 2})
check('check open', s in (200, 201), (s, chk))
cid = chk['id'] if isinstance(chk, dict) else chk
s, b = call('POST', f'/api/checks/{cid}/items', st, {'menu_item_id': item['id'], 'qty': 1, 'seat': 1})
check('add item', s in (200, 201), (s, b))
s, b = call('POST', f'/api/checks/{cid}/send', st, {})
check('send to kitchen', s in (200, 201), (s, b))
s, b = call('POST', f'/api/checks/{cid}/payments', st, {'method': 'cash', 'amount_cents': 100000, 'tendered_cents': 100000})
check('cash pay', s in (200, 201), (s, b))
check('cash over-tender gives change', isinstance(b, dict) and b.get('change_cents', 0) > 0, (s, b))
s, b = call('POST', f'/api/checks/{cid}/close', st, {})
check('close check', s in (200, 201), (s, b))

print(f'\n{len(passed)} passed, {len(failed)} failed')
if failed:
    print('FAILED:', failed); sys.exit(1)
