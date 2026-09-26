"""Independent menu-editor QA: CRUD, 86 hide/show, roles, audit (port 4321)."""
import json, urllib.request, urllib.error, sys
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
        return e.code, e.read().decode()[:300]

def login(pin):
    s, b = call('POST', '/api/auth/login', body={'pin': pin, 'site': 'bali-hai'})
    assert s == 200, (s, b)
    return b['token'], b['user']

st, su = login('1111'); kt, ku = login('2222'); mt, mu = login('2580')

# --- category CRUD ---
import time as _t; _q='QA'+str(int(_t.time()))
s, b = call('POST', '/api/admin/menu/categories', mt, {'name': _q})
check('create category', s in (200, 201) and b.get('id'), (s, b))
cat = b['id'] if isinstance(b, dict) else None
s, b = call('POST', '/api/admin/menu/categories', kt, {'name': 'Nope'})
check('kitchen denied category create 403', s == 403, (s, b))
s, b = call('POST', '/api/admin/menu/categories', st, {'name': 'Nope'})
check('server denied category create 403', s == 403, (s, b))
s, b = call('PUT', f'/api/admin/menu/categories/{cat}', mt, {'name': _q+'R'})
check('rename category', s == 200, (s, b))

# --- item CRUD ---
s, b = call('POST', '/api/admin/menu/items', mt, {'category_id': cat, 'name': 'QA Burger', 'price_cents': 1599, 'station': 'expediter', 'course': 'entree'})
check('create item', s in (200, 201) and (b.get('id') if isinstance(b, dict) else False), (s, b))
item = b['id']
s, b = call('PUT', f'/api/admin/menu/items/{item}', mt, {'price_cents': 1699})
check('update item price', s == 200, (s, b))
s, b = call('PUT', f'/api/admin/menu/items/{item}', mt, {'price_cents': -5})
check('negative price 400', s == 400, (s, b))

# --- 86: hides from order menu, instant ---
s, menu = call('GET', '/api/menu', st)
def find_item(m, iid):
    cats = m.get('categories', []) if isinstance(m, dict) else m
    for c in cats:
        for it in c.get('items', []):
            if it.get('id') == iid: return it
    return None
check('item visible pre-86', find_item(menu, item) is not None)
s, b = call('POST', f'/api/admin/menu/86/{item}', mt, {'eightysix': True})
check('86 item', s == 200, (s, b))
s, menu = call('GET', '/api/menu', st)
got = find_item(menu, item)
check('86d item hidden from order menu', got is None or got.get('available') is False, got)
s, b = call('POST', f'/api/admin/menu/86/{item}', kt, {'eightysix': True})
check('kitchen denied 86 403', s == 403, (s, b))
s, b = call('POST', f'/api/admin/menu/86/{item}', mt, {'eightysix': False})
check('un-86 item', s == 200, (s, b))
s, menu = call('GET', '/api/menu', st)
got = find_item(menu, item)
check('un-86d item visible again', got is not None and got.get('available') is not False, got)

# --- audit ---
s, b = call('GET', '/api/admin/menu/audit', mt)
check('audit log lists changes', s == 200 and isinstance(b, list) and len(b) >= 4, (s, len(b) if isinstance(b, list) else b))
s, b = call('GET', '/api/admin/menu/audit', st)
check('server denied audit 403', s == 403, (s, b))

# --- delete item + category ---
s, b = call('DELETE', f'/api/admin/menu/items/{item}', mt)
check('delete item', s == 200, (s, b))
s, menu = call('GET', '/api/menu', st)
check('deleted item gone', find_item(menu, item) is None)
s, b = call('DELETE', f'/api/admin/menu/categories/{cat}', mt)
check('delete category', s == 200, (s, b))

# --- regression: order flow still works after menu edits ---
s, menu = call('GET', '/api/menu', st)
cats = menu.get('categories', []) if isinstance(menu, dict) else menu
it2 = None
for c in cats:
    for it in c.get('items', []):
        if it.get('available') is not False: it2 = it; break
    if it2: break
s, zones = call('GET', '/api/zones', st)
t = next(z for z in zones if z.get('tables'))['tables'][0]
s, chk = call('POST', '/api/checks', st, {'table_id': t['id'], 'guest_count': 1})
cid = chk['id']
s, b = call('POST', f'/api/checks/{cid}/items', st, {'menu_item_id': it2['id'], 'qty': 1, 'seat': 1})
check('order item post-menu-edits', s in (200, 201), (s, b))
s, b = call('POST', f'/api/checks/{cid}/send', st, {})
check('send post-menu-edits', s in (200, 201), (s, b))

print(f'\n{len(passed)} passed, {len(failed)} failed')
if failed: print('FAILED:', failed); sys.exit(1)
