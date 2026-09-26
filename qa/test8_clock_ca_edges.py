"""CA edge cases: waivers, 13h day, on-time meal, premium stacking (port 4321)."""
import json, urllib.request, urllib.error, datetime, sqlite3, sys
import os

BASE = os.environ.get("EXPLOINE_BASE", os.environ.get("EXPLOINE_BASE", "http://localhost:4321"))
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

mt, mu = login('2580'); st, su = login('1111')
s, users = call('GET', '/api/admin/clock/users', mt)
srv = [u for u in users if u['role'] == 'server'][0]
call('PUT', f"/api/admin/clock/users/{srv['id']}/rate", mt, {'hourly_rate_cents': 1800})
db = sqlite3.connect('/tmp/clock_test.db')
db.execute('DELETE FROM clock_breaks'); db.execute('DELETE FROM clock_shifts'); db.execute('DELETE FROM clock_audit'); db.commit()

now = datetime.datetime.now(datetime.timezone.utc)
def iso(dt): return dt.isoformat()
def mkshift(hours_ago_start, dur_h, rate=1800):
    cin = now - datetime.timedelta(hours=hours_ago_start)
    cout = cin + datetime.timedelta(hours=dur_h)
    cur = db.execute(
        "INSERT INTO clock_shifts (site_id, user_id, employee_name, role, regular_rate_cents, clock_in, clock_out, created_at) VALUES (?,?,?,?,?,?,?,?)",
        ('bali-hai', srv['id'], srv['name'], 'server', rate, iso(cin), iso(cout), iso(cin)))
    db.commit()
    return cur.lastrowid, cin, cout
def add_break(sid, typ, seq, start, end, waived=0, duty_free=0):
    db.execute("INSERT INTO clock_breaks (shift_id, type, meal_seq, start_at, end_at, waived, duty_free, created_at) VALUES (?,?,?,?,?,?,?,?)",
               (sid, typ, seq, iso(start), iso(end) if end else None, waived, duty_free, iso(start)))
    db.commit()
def getview(sid):
    s, b = call('GET', f"/api/admin/clock/shifts?date={(now - datetime.timedelta(hours=20)).date().isoformat()}", mt)
    # search across today + yesterday (shifts may span)
    for dayoff in (0, 1):
        d = (now - datetime.timedelta(days=dayoff)).date().isoformat()
        s, b = call('GET', f'/api/admin/clock/shifts?date={d}', mt)
        for v in b['shifts']:
            if v['id'] == sid: return v
    return None

# 1. 5.5h shift, meal 1 waived -> no meal violation, no premium
sid, cin, cout = mkshift(6, 5.5)
add_break(sid, 'meal', 1, cin + datetime.timedelta(hours=1), None, waived=1)
add_break(sid, 'rest', None, cin + datetime.timedelta(hours=3), cin + datetime.timedelta(hours=3, minutes=10))
v = getview(sid)
check('5.5h waived meal: no violation', v and v['compliance']['violations'] == [], v['compliance'] if v else None)
check('5.5h waived meal: no premium', v and v['pay']['premium_cents'] == 0, v['pay'] if v else None)

# 2. 7h shift, meal 1 "waived" -> ineligible, violation stands + premium
sid, cin, cout = mkshift(8, 7)
add_break(sid, 'meal', 1, cin + datetime.timedelta(hours=1), None, waived=1)
add_break(sid, 'rest', None, cin + datetime.timedelta(hours=2), cin + datetime.timedelta(hours=2, minutes=10))
add_break(sid, 'rest', None, cin + datetime.timedelta(hours=5), cin + datetime.timedelta(hours=5, minutes=10))
v = getview(sid)
check('7h ineligible waiver: violation stands', v and any('meal' in x for x in v['compliance']['violations']), v['compliance'] if v else None)
check('7h ineligible waiver: premium owed', v and v['pay']['premium_cents'] == 1800, v['pay'] if v else None)

# 3. 13h shift, all breaks taken -> 8 reg + 4 OT15 + 1 OT2, no premium
sid, cin, cout = mkshift(14, 13)
add_break(sid, 'meal', 1, cin + datetime.timedelta(hours=4), cin + datetime.timedelta(hours=4.5), duty_free=1)
add_break(sid, 'meal', 2, cin + datetime.timedelta(hours=9), cin + datetime.timedelta(hours=9.5), duty_free=1)
for h in (2, 6, 10):
    add_break(sid, 'rest', None, cin + datetime.timedelta(hours=h), cin + datetime.timedelta(hours=h, minutes=10))
v = getview(sid)
p = v['pay'] if v else {}
check('13h: 8 reg hours', p.get('reg_hours') == 8, p)
check('13h: 4 OT15 hours', p.get('ot15_hours') == 4, p)
check('13h: 1 OT2 hour', p.get('ot2_hours') == 1, p)
check('13h: reg $144', p.get('reg_cents') == 8*1800, p)
check('13h: OT15 $108', p.get('ot15_cents') == 4*2700, p)
check('13h: OT2 $36', p.get('ot2_cents') == 1*3600, p)
check('13h: no premium', p.get('premium_cents') == 0, p)

# 4. 9h shift, on-time meal + 2 rests -> no violations
sid, cin, cout = mkshift(10, 9)
add_break(sid, 'meal', 1, cin + datetime.timedelta(hours=4), cin + datetime.timedelta(hours=4.5), duty_free=1)
add_break(sid, 'rest', None, cin + datetime.timedelta(hours=2), cin + datetime.timedelta(hours=2, minutes=10))
add_break(sid, 'rest', None, cin + datetime.timedelta(hours=7), cin + datetime.timedelta(hours=7, minutes=10))
v = getview(sid)
check('9h compliant: no violations', v and v['compliance']['violations'] == [], v['compliance'] if v else None)
check('9h compliant: 1h OT', v and v['pay']['ot15_hours'] == 1 and v['pay']['ot15_cents'] == 2700, v['pay'] if v else None)

# 5. 9h shift, NO breaks -> missed meal + missed rest stack (2 premiums)
sid, cin, cout = mkshift(10, 9)
v = getview(sid)
check('9h no breaks: 2 violations', v and len(v['compliance']['violations']) == 2, v['compliance'] if v else None)
check('9h no breaks: $36 premium', v and v['pay']['premium_cents'] == 3600, v['pay'] if v else None)

# 6. meal taken but NOT duty-free -> violation (not a real break)
sid, cin, cout = mkshift(10, 9)
add_break(sid, 'meal', 1, cin + datetime.timedelta(hours=4), cin + datetime.timedelta(hours=4.5), duty_free=0)
v = getview(sid)
check('non-duty-free meal: violation', v and any('meal' in x for x in v['compliance']['violations']), v['compliance'] if v else None)

# 7. live waiver via API: clock in, waive meal 1 (shift < 6h so eligible), clock out
s, b = call('POST', '/api/clock/in', st); live_sid = b['id']
s, b = call('POST', '/api/clock/break/waive', st, {'type': 'meal', 'meal_seq': 1})
check('live waiver 201', s == 201, (s, b))
s, b = call('POST', '/api/clock/break/waive', st, {'type': 'meal', 'meal_seq': 2})
check('waive meal 2 recorded 201 (validity at clock-out)', s == 201, (s, b))
s, b = call('POST', '/api/clock/out', st)
check('live clock out', s == 200, (s, b))

print(f'\n{len(passed)} passed, {len(failed)} failed')
if failed: print('FAILED:', failed); sys.exit(1)
