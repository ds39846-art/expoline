"""Phase 5 — CA labor/break-rules validation suite (port 4329).

Validates the time-clock rules engine against CURRENT (2026) California
DIR/DLSE guidance. Rule-by-rule citations live in qa/RULES.md.

Boot (fresh scratch DB, never the live tree):
    EXPOLINE_DB=~/workspace/scratch-calabor/run/ca_test.db EXPOLINE_PORT=4329 node server.js
Run:
    CA_TEST_DB=~/workspace/scratch-calabor/run/ca_test.db CA_TEST_BASE=http://localhost:4329 \\
        python3 qa/test25_ca_breaks.py

The suite wipes clock_shifts/clock_breaks/clock_audit at start, so it needs
its own scratch DB.
"""
import json, os, urllib.request, urllib.error, datetime, sqlite3, sys

BASE = os.environ.get('CA_TEST_BASE', 'http://localhost:4329')
DB_PATH = os.environ.get('CA_TEST_DB', os.path.expanduser('~/workspace/scratch-calabor/run/ca_test.db'))
RATE = 1800  # cents/hr set on the server seed user below
passed, failed = [], []

def check(name, cond, detail=''):
    (passed if cond else failed).append(name)
    print(('PASS ' if cond else 'FAIL ') + name + (f' [{detail}]' if detail and not cond else ''))

def call(method, path, token=None, body=None):
    req = urllib.request.Request(BASE + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={'Content-Type': 'application/json', **({'Authorization': 'Bearer ' + token} if token else {})})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, json.loads(r.read() or b'null')
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:500]

def login(pin):
    s, b = call('POST', '/api/auth/login', body={'pin': pin, 'site': 'bali-hai'})
    assert s == 200, (s, b)
    return b['token'], b['user']

PT = datetime.timezone(datetime.timedelta(hours=-7))  # PDT (September)
def pt_iso(y, m, d, hh, mm=0):
    return datetime.datetime(y, m, d, hh, mm, tzinfo=PT).isoformat()
def pt_date(y, m, d):
    return f'{y:04d}-{m:02d}-{d:02d}'

db = sqlite3.connect(DB_PATH)
db.execute('DELETE FROM clock_breaks'); db.execute('DELETE FROM clock_shifts'); db.execute('DELETE FROM clock_audit'); db.commit()

mt, mu = login('2580'); st, su = login('1111')
s, users = call('GET', '/api/admin/clock/users', mt)
srv = [u for u in users if u['role'] == 'server'][0]
call('PUT', f"/api/admin/clock/users/{srv['id']}/rate", mt, {'hourly_rate_cents': RATE})

def mkshift(cin_iso, dur_h, rate=RATE):
    cin = datetime.datetime.fromisoformat(cin_iso)
    cout = cin + datetime.timedelta(hours=dur_h)
    cur = db.execute(
        "INSERT INTO clock_shifts (site_id, user_id, employee_name, role, regular_rate_cents, clock_in, clock_out, created_at)"
        " VALUES (?,?,?,?,?,?,?,?)",
        ('bali-hai', srv['id'], srv['name'], 'server', rate, cin.isoformat(), cout.isoformat(), cin.isoformat()))
    db.commit()
    return cur.lastrowid, cin, cout

def add_break(sid, typ, seq, start, end, waived=0, duty_free=0):
    db.execute("INSERT INTO clock_breaks (shift_id, type, meal_seq, start_at, end_at, waived, duty_free, created_at)"
               " VALUES (?,?,?,?,?,?,?,?)",
               (sid, typ, seq, start.isoformat() if start else None, end.isoformat() if end else None,
                waived, duty_free, (start or datetime.datetime.now(datetime.timezone.utc)).isoformat()))
    db.commit()

def meal(sid, cin, start_h, dur_min=30, duty_free=1, seq=1):
    s = cin + datetime.timedelta(hours=start_h)
    add_break(sid, 'meal', seq, s, s + datetime.timedelta(minutes=dur_min), duty_free=duty_free)

def rest(sid, cin, start_h, dur_min=10):
    s = cin + datetime.timedelta(hours=start_h)
    add_break(sid, 'rest', None, s, s + datetime.timedelta(minutes=dur_min), duty_free=1)

def waiver(sid, seq):
    add_break(sid, 'meal', seq, None, None, waived=1)

def getview(sid):
    s, b = call('GET', '/api/admin/clock/shifts?date=1999-01-01', mt)  # warm
    for dayoff in range(0, 30):
        d = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=dayoff)).date().isoformat()
        s, b = call('GET', f'/api/admin/clock/shifts?date={d}', mt)
        for v in b['shifts']:
            if v['id'] == sid:
                return v
    return None

def getday(date):
    s, b = call('GET', f'/api/admin/clock/shifts?date={date}', mt)
    assert s == 200, (s, b)
    return b

now = datetime.datetime.now(datetime.timezone.utc)
def rel_iso(hours_ago):
    return (now - datetime.timedelta(hours=hours_ago)).isoformat()

print('== 1. rest-break count table (Brinker: major fraction = MORE than 2h) ==')
for dur, expect in [(3.0, 0), (3.5, 1), (6.0, 1), (6.5, 2), (10.0, 2), (10.5, 3), (14.0, 3), (14.5, 4)]:
    sid, cin, cout = mkshift(rel_iso(dur + 1), dur)
    v = getview(sid)
    check(f'{dur}h shift requires {expect} rest(s)',
          v and v['compliance']['rests_required'] == expect,
          v['compliance'] if v else 'no view')

print('== 2. meal timing: must START before end of 5th hour ==')
sid, cin, cout = mkshift(rel_iso(7), 6.0)
meal(sid, cin, 4.9); rest(sid, cin, 2)          # on-time meal
v = getview(sid)
check('meal started at 4.9h: no violation', v and v['compliance']['violations'] == [], v['compliance'] if v else None)

sid, cin, cout = mkshift(rel_iso(7), 6.0)
meal(sid, cin, 5.05); rest(sid, cin, 2)         # late meal
v = getview(sid)
check('meal started at 5.05h: meal violation', v and v['compliance']['violations'] == ['meal'], v['compliance'] if v else None)
check('late meal: 1h premium at regular rate', v and v['pay']['premium_cents'] == RATE, v['pay'] if v else None)

sid, cin, cout = mkshift(rel_iso(7), 6.0)
s2 = cin + datetime.timedelta(hours=4)
add_break(sid, 'meal', 1, s2, s2 + datetime.timedelta(minutes=20), duty_free=1)  # short meal
rest(sid, cin, 2)
v = getview(sid)
check('20-min meal: violation (30-min minimum)', v and v['compliance']['violations'] == ['meal'], v['compliance'] if v else None)

sid, cin, cout = mkshift(rel_iso(12), 11.0)
meal(sid, cin, 4); meal(sid, cin, 9, seq=2)
for h in (2, 6, 10): rest(sid, cin, h)
v = getview(sid)
check('11h shift, both meals on time: no violation', v and v['compliance']['violations'] == [], v['compliance'] if v else None)

sid, cin, cout = mkshift(rel_iso(12), 11.0)
meal(sid, cin, 4)
for h in (2, 6, 10): rest(sid, cin, h)
v = getview(sid)
check('11h shift, second meal missing: meal violation', v and v['compliance']['violations'] == ['meal'], v['compliance'] if v else None)

print('== 3. waivers: eligibility + audit logging ==')
sid, cin, cout = mkshift(rel_iso(6.5), 5.5)
waiver(sid, 1); rest(sid, cin, 2)
v = getview(sid)
check('5.5h shift, meal 1 waived: no violation', v and v['compliance']['violations'] == [], v['compliance'] if v else None)

sid, cin, cout = mkshift(rel_iso(8), 7.0)
waiver(sid, 1); rest(sid, cin, 2); rest(sid, cin, 5)
v = getview(sid)
check('7h shift, meal 1 "waived": ineligible, violation stands', v and v['compliance']['violations'] == ['meal'], v['compliance'] if v else None)

sid, cin, cout = mkshift(rel_iso(12), 11.0)
meal(sid, cin, 4); waiver(sid, 2)
for h in (2, 6, 10): rest(sid, cin, h)
v = getview(sid)
check('11h shift, meal1 taken + meal2 waived: no violation', v and v['compliance']['violations'] == [], v['compliance'] if v else None)

sid, cin, cout = mkshift(rel_iso(12), 11.0)
waiver(sid, 1); waiver(sid, 2)
for h in (2, 6, 10): rest(sid, cin, h)
v = getview(sid)
check('11h shift, both waived: second waiver invalid (first was waived)', v and v['compliance']['violations'] == ['meal'], v['compliance'] if v else None)

# live waiver via API must land in the audit log
s, b = call('POST', '/api/clock/in', st); live_sid = b['id']
s, b = call('POST', '/api/clock/break/waive', st, {'type': 'meal', 'meal_seq': 1})
check('live waiver 201', s == 201, (s, b))
s, b = call('POST', '/api/clock/out', st)
s, audit = call('GET', '/api/admin/clock/audit?limit=50', mt)
acts = [(a['action'], a['shift_id']) for a in audit]
check('waiver audit-logged', ('meal_waived', live_sid) in acts, acts[:8])

print('== 4. premium math: 1h per violation TYPE per day, stacks meal+rest ==')
sid, cin, cout = mkshift(rel_iso(10), 9.0)   # no breaks at all
v = getview(sid)
check('9h no breaks: meal+rest violations', v and sorted(v['compliance']['violations']) == ['meal', 'rest'], v['compliance'] if v else None)
check('9h no breaks: 2h premium', v and v['pay']['premium_cents'] == 2 * RATE, v['pay'] if v else None)
check('premium is not hours worked (OT buckets unchanged)',
      v and v['pay']['ot15_hours'] == 1 and v['pay']['ot2_hours'] == 0, v['pay'] if v else None)

sid, cin, cout = mkshift(rel_iso(10), 9.0)
meal(sid, cin, 4)   # meal ok, rests missed -> single rest premium
v = getview(sid)
check('9h meal ok, rests missed: rest-only violation', v and v['compliance']['violations'] == ['rest'], v['compliance'] if v else None)
check('rest-only: 1h premium', v and v['pay']['premium_cents'] == RATE, v['pay'] if v else None)

print('== 5. daily OT buckets: 1.5x after 8h, 2x after 12h ==')
sid, cin, cout = mkshift(rel_iso(14), 13.0)
meal(sid, cin, 4); meal(sid, cin, 9, seq=2)
for h in (2, 6, 10): rest(sid, cin, h)
v = getview(sid); p = v['pay'] if v else {}
check('13h: 8 reg / 4 OT15 / 1 OT2 hours', p.get('reg_hours') == 8 and p.get('ot15_hours') == 4 and p.get('ot2_hours') == 1, p)
check('13h: reg $144', p.get('reg_cents') == 8 * RATE, p)
check('13h: OT15 = 4 x 1.5 x rate', p.get('ot15_cents') == 4 * RATE * 1.5, p)
check('13h: OT2 = 1 x 2 x rate', p.get('ot2_cents') == 1 * RATE * 2, p)
check('13h: no premium', p.get('premium_cents') == 0, p)

print('== 6. multi-shift workday: OT rebucketed per workday, premium capped per type ==')
D = pt_date(2026, 9, 18)   # fixed past Friday — isolated from other sections
sid1, c1, _ = mkshift(pt_iso(2026, 9, 18, 8), 5.0)
rest(sid1, c1, 2)
sid2, c2, _ = mkshift(pt_iso(2026, 9, 18, 14), 5.0)
rest(sid2, c2, 2)
day = getday(D)
L = day['labor']
check('split 5h+5h: day OT15 = 2h in summary', L['ot_cents'] == 2 * round(RATE * 1.5), L)
check('split 5h+5h: day reg = 8h in summary', L['reg_cents'] == 8 * RATE, L)
check('split 5h+5h: workday_aggregation adjustment recorded',
      any(a['kind'] == 'workday_aggregation' for a in day.get('adjustments', [])), day.get('adjustments'))
v1 = [v for v in day['shifts'] if v['id'] == sid1][0]
check('per-shift line items keep shift truth (0 OT on 5h shift)', v1['pay']['ot15_hours'] == 0, v1['pay'])

sid3, c3, _ = mkshift(pt_iso(2026, 9, 18, 8), 6.0)   # both miss meal+rest on same workday
sid4, c4, _ = mkshift(pt_iso(2026, 9, 18, 15), 6.0)
day = getday(D)
L = day['labor']
v3 = [v for v in day['shifts'] if v['id'] == sid3][0]
v4 = [v for v in day['shifts'] if v['id'] == sid4][0]
check('two shifts, same violations: shift premiums stack on line items',
      v3['pay']['premium_cents'] == 2 * RATE and v4['pay']['premium_cents'] == 2 * RATE,
      (v3['pay']['premium_cents'], v4['pay']['premium_cents']))
check('day summary caps premium at one per violation type per workday',
      L['premium_cents'] == 2 * RATE, L)
adj = [a for a in day.get('adjustments', []) if a['kind'] == 'workday_aggregation']
check('premium cap delta is transparent', any(a['premium_cents_delta'] < 0 for a in adj), adj)

print('== 7. seventh consecutive day: first 8h at 1.5x, beyond 8h at 2x ==')
# Sun 2026-09-06 .. Sat 2026-09-12, 8h/day, fully break-compliant
for i in range(7):
    d = 6 + i
    sid, cin, cout = mkshift(pt_iso(2026, 9, d, 9), 8.0)
    meal(sid, cin, 3.5); rest(sid, cin, 1.5); rest(sid, cin, 6)
sat = getday(pt_date(2026, 9, 12))
L = sat['labor']
check('7th day uplift = 8h x 0.5 x rate', L['seventh_day_cents'] == round(8 * RATE * 0.5), L)
check('seventh_day detail lists the Saturday', len(sat.get('seventh_day', [])) == 1 and sat['seventh_day'][0]['date'] == pt_date(2026, 9, 12), sat.get('seventh_day'))
check('no weekly OT double-count on 7th-day hours (56h wk: extra = 56-40-8)',
      L['weekly_ot_cents'] == round(8 * RATE * 0.5), L)
fri = getday(pt_date(2026, 9, 11))
check('6th consecutive day: no seventh-day premium', fri['labor']['seventh_day_cents'] == 0, fri['labor'])

# finance labor report carries the seventh-day table
s, rep = call('GET', '/api/finance/reports/labor?format=json&from=2026-09-06&to=2026-09-12', mt)
tables = [t['title'] for t in rep.get('extraTables', [])]
check('finance report has seventh-day premium table', 'Seventh consecutive day premiums (CA)' in tables, tables)
sd = [t for t in rep.get('extraTables', []) if t['title'] == 'Seventh consecutive day premiums (CA)'][0]
check('report seventh-day premium = 8h x 0.5 x rate', sd['totals']['premium_cents'] == round(8 * RATE * 0.5), sd['totals'])

print('== 8. break-due prompts fire at the right times ==')
s, b = call('POST', '/api/clock/in', st); pid = b['id']
ago = (now - datetime.timedelta(hours=4.6)).isoformat()
s, b = call('POST', '/api/admin/clock/adjust', mt, {'shift_id': pid, 'clock_in': ago, 'manager_pin': '2580'})
assert s == 200, (s, b)
s, b = call('GET', '/api/clock/status', st)
m1 = [x for x in b['due'] if x['kind'] == 'meal' and x['seq'] == 1][0]
r1 = [x for x in b['due'] if x['kind'] == 'rest'][0]
check('4.6h elapsed: meal seq1 state=due', m1['state'] == 'due', m1)
check('4.6h elapsed: rest state=due with due_at', r1['state'] == 'due' and r1['due_at'], r1)
ago = (now - datetime.timedelta(hours=5.2)).isoformat()
s, b = call('POST', '/api/admin/clock/adjust', mt, {'shift_id': pid, 'clock_in': ago, 'manager_pin': '2580'})
s, b = call('GET', '/api/clock/status', st)
m1 = [x for x in b['due'] if x['kind'] == 'meal' and x['seq'] == 1][0]
check('5.2h elapsed, no meal: meal seq1 state=overdue', m1['state'] == 'overdue', m1)
s, b = call('POST', '/api/clock/break/start', st, {'type': 'meal'})
s, b = call('POST', '/api/clock/break/end', st, {'type': 'meal', 'duty_free': True})
s, b = call('GET', '/api/clock/status', st)
m1 = [x for x in b['due'] if x['kind'] == 'meal' and x['seq'] == 1][0]
check('short (<30min) meal does not satisfy the prompt', m1['state'] != 'taken', m1)
s, b = call('POST', '/api/clock/out', st)

print('== 9. config + responses carry the consult-counsel notice ==')
s, cfg = call('GET', '/api/admin/clock/config', mt)
check('config carries consult-counsel notice', s == 200 and 'consult employment counsel' in cfg.get('notice', '').lower(), cfg.get('notice'))
day = getday(pt_date(2026, 9, 12))
check('shifts endpoint carries legal_notice', 'consult employment counsel' in day.get('legal_notice', '').lower(), day.get('legal_notice'))

print(f'\n{len(passed)} passed, {len(failed)} failed')
if failed:
    print('FAILED:', failed); sys.exit(1)
