#!/usr/bin/env python3
"""Expoline UUID integrity + per-site isolation regression — qa/test19_uuid_site_audit.py.

Covers PHASE 1C findings:
  - every new check / check_item / payment / KDS ticket / clock shift / break
    gets a proper UUID v4, and every API response that returns one carries it
    (incl. KDS ticketView, kiosk tickets, online confirm tickets, checks/open list)
  - no NULL / duplicate / malformed uuids in the six sync tables
  - FK consistency: payments->checks, check_items->checks, breaks->shifts,
    kds_tickets->checks; ticket items_json item_ids resolve (dine-in/kiosk);
    void/refund flows keep rows linked (soft state, no orphans)
  - per-site isolation: separate DB files per EXPOLINE_SITE; no cross-site
    reads; site slug not spoofable via header/query; sites row slug matches
    the booted slug; seed data does not bleed across sites

Two isolated servers (ports 4351/4352, /tmp DBs) so this suite never touches
the live demo (4317) or the soak test (4320). SRV_DIR is env-overridable.
"""
import json, os, re, sqlite3, subprocess, sys, time, urllib.request, urllib.error

SRV_DIR = os.environ.get("EXPLOINE_SRV_DIR",
    "/home/hatch/workspace/goals/expo-line-pos-beat-toast-spoton-pilot-at-bali-hai/build/expoline")
SITES = [
    {"slug": "bali-hai", "port": 4351, "db": "/tmp/uuid19_a.db"},
    {"slug": "test-site-2", "port": 4352, "db": "/tmp/uuid19_b.db"},
]
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", re.I)
SYNC_TABLES = ["checks", "check_items", "payments", "kds_tickets", "clock_shifts", "clock_breaks"]

checks, fails = 0, []
def ok(cond, name, detail=""):
    global checks
    checks += 1
    if cond: print(f"  PASS {name}")
    else:
        fails.append(name); print(f"  FAIL {name}: {detail}")

def is_uuid(v): return isinstance(v, str) and bool(UUID_RE.match(v))

def start_site(slug, port, db):
    subprocess.run(f"lsof -ti:{port} | xargs kill -9 2>/dev/null", shell=True)
    time.sleep(1)
    for f in (db, db + "-wal", db + "-shm"):
        try: os.unlink(f)
        except OSError: pass
    env = dict(os.environ, EXPOLINE_PORT=str(port), EXPOLINE_DB=db, EXPOLINE_SITE=slug)
    subprocess.Popen(["node", "server.js"], cwd=SRV_DIR, env=env,
                     stdout=open(f"/tmp/uuid19_{port}.log", "a"),
                     stderr=subprocess.STDOUT, start_new_session=True)
    for _ in range(40):
        try:
            urllib.request.urlopen(f"http://localhost:{port}/api/health", timeout=2)
            return True
        except Exception:
            time.sleep(1)
    return False

def call(port, method, path, token=None, body=None, headers=None):
    h = {"Content-Type": "application/json"}
    if token: h["Authorization"] = "Bearer " + token
    if headers: h.update(headers)
    req = urllib.request.Request(f"http://localhost:{port}{path}", method=method,
        data=json.dumps(body).encode() if body is not None else None, headers=h)
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode() or "{}")

def login(port, pin):
    st, b = call(port, "POST", "/api/auth/login", body={"pin": pin})
    assert st == 200, (port, pin, st, b)
    return b["token"]

def free_tables(port, token):
    st, b = call(port, "GET", "/api/floor/availability", token)
    assert st == 200, (st, b)
    rows = b if isinstance(b, list) else b.get("tables", [])
    return [t["id"] for t in rows if t.get("status") == "free"]

print("--- starting isolated site servers ---")
for s in SITES:
    assert start_site(s["slug"], s["port"], s["db"]), f"site {s['slug']} failed to start"
    print(f"  up: {s['slug']} on :{s['port']}")

PA, PB = SITES[0]["port"], SITES[1]["port"]
STA, KTA, MTA = login(PA, "1111"), login(PA, "2222"), login(PA, "2580")
STB, KTB, MTB = login(PB, "1111"), login(PB, "2222"), login(PB, "2580")

print("--- UUID on every created entity (site A) ---")
T1, T2 = free_tables(PA, MTA)[:2]
st, b = call(PA, "POST", "/api/checks", STA, {"table_id": T1, "tab_name": "U19A", "guest_count": 2})
assert st in (200, 201), (st, b)
ok(is_uuid(b.get("uuid")), "check create returns v4 uuid", b.get("uuid"))
CID = b["id"]; CHK_UUID = b["uuid"]
st, b = call(PA, "POST", f"/api/checks/{CID}/items", STA, {"menu_item_id": 1, "seat": 1, "qty": 2})
assert st in (200, 201), (st, b)
ok(is_uuid(b.get("uuid")), "item add returns v4 uuid", b.get("uuid"))
IID = b["id"]
st, b = call(PA, "POST", f"/api/checks/{CID}/send", STA)
assert st == 200 and b.get("tickets"), (st, b)
ok(all(is_uuid(t.get("uuid")) for t in b["tickets"]), "send tickets carry v4 uuids",
   [t.get("uuid") for t in b["tickets"]])
TIX_UUID = b["tickets"][0]["uuid"]
st, b = call(PA, "POST", f"/api/checks/{CID}/payments", STA,
             {"method": "card_demo", "amount_cents": 100, "tip_cents": 5})
assert st in (200, 201), (st, b)
ok(is_uuid(b["payment"].get("uuid")), "payment returns v4 uuid", b["payment"].get("uuid"))
PID = b["payment"]["id"]
st, b = call(PA, "POST", f"/api/payments/{PID}/refund", MTA, {})
assert st == 200, (st, b)
ok(b["payment"]["status"] == "refunded" and is_uuid(b["payment"].get("uuid")),
   "refunded payment keeps uuid", b["payment"])
st, b = call(PA, "POST", f"/api/checks/{CID}/void-item", STA,
             {"item_id": IID, "manager_pin": "2580", "reason": "u19"})
assert st == 200, (st, b)
ok(b.get("state") == "cancelled", "item void ok", b)
st, b = call(PA, "POST", "/api/clock/in", STA)
assert st == 201, (st, b)
ok(is_uuid(b.get("uuid")), "shift returns v4 uuid", b.get("uuid"))
st, b = call(PA, "POST", "/api/clock/break/start", STA, {"type": "meal"})
assert st == 201, (st, b)
ok(is_uuid(b.get("uuid")), "break returns v4 uuid", b.get("uuid"))
st, b = call(PA, "POST", "/api/clock/break/end", STA, {"type": "meal", "duty_free": True})
assert st == 200, (st, b)
st, b = call(PA, "POST", "/api/clock/out", STA)
assert st == 200, (st, b)
ok(is_uuid(b.get("uuid")) and all(is_uuid(x.get("uuid")) for x in b.get("breaks", [])),
   "closed shift + nested breaks carry uuids")

print("--- list/detail endpoints carry uuids ---")
st, b = call(PA, "GET", "/api/kds/tickets?status=all", KTA)
tix = b if isinstance(b, list) else b.get("tickets", [])
ok(len(tix) > 0 and all(is_uuid(t.get("uuid")) for t in tix), "KDS list uuids",
   [t.get("uuid") for t in tix][:2] if isinstance(tix, list) else tix)
st, b = call(PA, "GET", "/api/checks/open", STA)
rows = b if isinstance(b, list) else []
ok(any(r.get("uuid") == CHK_UUID for r in rows) and all(is_uuid(r.get("uuid")) for r in rows),
   "checks/open rows carry uuids")
st, b = call(PA, "GET", f"/api/checks/{CID}", STA)
ok(is_uuid(b.get("uuid")) and all(is_uuid(i.get("uuid")) for i in b.get("items", [])),
   "check detail + items carry uuids")
# kiosk ticket carries uuid
st, b = call(PA, "POST", "/api/kiosk/order",
             body={"customer_name": "U19K", "items": [{"menu_item_id": 1, "qty": 1}]})
assert st in (200, 201), (st, b)
ok(all(is_uuid(t.get("uuid")) for t in b["tickets"]), "kiosk tickets carry uuids",
   [t.get("uuid") for t in b["tickets"]])
# online confirm tickets carry uuids
st, b = call(PA, "POST", "/api/online/orders",
             body={"customer_name": "U19O", "phone": "555-0199",
                   "items": [{"menu_item_id": 2, "qty": 1}]})
assert st in (200, 201), (st, b)
OID = b["id"] if "id" in b else b["order"]["id"]
st, b = call(PA, "PATCH", f"/api/online/orders/{OID}", KTA, {"status": "confirmed"})
assert st == 200, (st, b)
ok(all(is_uuid(t.get("uuid")) for t in b.get("kds_tickets", [])),
   "online confirm tickets carry uuids", b.get("kds_tickets"))

print("--- DB-level uuid integrity (site A) ---")
con = sqlite3.connect(SITES[0]["db"]); con.execute("PRAGMA query_only=ON")
for t in SYNC_TABLES:
    n = con.execute(f"SELECT COUNT(*) FROM {t} WHERE uuid IS NULL OR uuid=''").fetchone()[0]
    ok(n == 0, f"{t}: no NULL/empty uuid", f"{n} bad")
    d = con.execute(f"SELECT COUNT(*) - COUNT(DISTINCT uuid) FROM {t}").fetchone()[0]
    ok(d == 0, f"{t}: uuid unique", f"{d} dupes")
    bad = sum(1 for (u,) in con.execute(f"SELECT uuid FROM {t}") if not is_uuid(u))
    ok(bad == 0, f"{t}: all uuids v4-shaped", f"{bad} malformed")

print("--- FK consistency after void/refund (site A) ---")
ok(con.execute("SELECT COUNT(*) FROM payments p LEFT JOIN checks c ON c.id=p.check_id WHERE c.id IS NULL").fetchone()[0] == 0,
   "payments.check_id -> checks")
ok(con.execute("SELECT COUNT(*) FROM check_items ci LEFT JOIN checks c ON c.id=ci.check_id WHERE c.id IS NULL").fetchone()[0] == 0,
   "check_items.check_id -> checks")
ok(con.execute("SELECT COUNT(*) FROM clock_breaks b LEFT JOIN clock_shifts s ON s.id=b.shift_id WHERE s.id IS NULL").fetchone()[0] == 0,
   "clock_breaks.shift_id -> shifts")
ok(con.execute("SELECT COUNT(*) FROM kds_tickets t LEFT JOIN checks c ON c.id=t.check_id WHERE t.check_id IS NOT NULL AND c.id IS NULL").fetchone()[0] == 0,
   "kds_tickets.check_id -> checks (NULL ok for online)")
orph = 0
for (jid, ck) in con.execute("SELECT items_json, check_id FROM kds_tickets"):
    try: items = json.loads(jid)
    except Exception: items = []
    for it in items:
        iid = it.get("item_id")
        if ck is not None and iid is not None and \
           con.execute("SELECT COUNT(*) FROM check_items WHERE id=?", (iid,)).fetchone()[0] == 0:
            orph += 1
ok(orph == 0, "dine-in/kiosk ticket item_ids -> check_items", f"{orph} orphans")
for (jid,) in con.execute("SELECT items_json FROM kds_tickets WHERE check_id IS NULL"):
    try: items = json.loads(jid)
    except Exception: items = []
    for it in items:
        mid = it.get("menu_item_id")
        ok(mid is not None and con.execute("SELECT COUNT(*) FROM menu_items WHERE id=?", (mid,)).fetchone()[0] == 1,
           "online ticket menu_item_id -> menu_items", it)
ok(con.execute("SELECT COUNT(*) FROM check_items WHERE id=? AND state='cancelled' AND check_id=?",
               (IID, CID)).fetchone()[0] == 1, "voided item retained + linked (no orphan)")
ok(con.execute("SELECT COUNT(*) FROM payments WHERE id=? AND status='refunded'",
               (PID,)).fetchone()[0] == 1, "refunded payment retained + linked")

print("--- per-site isolation ---")
for s in SITES:
    st, b = call(s["port"], "GET", "/api/brain/status")
    ok(st == 200 and b.get("site_slug") == s["slug"], f"{s['slug']} brain slug", b)
    row = sqlite3.connect(s["db"]).execute("SELECT id, slug FROM sites").fetchone()
    ok(row[1] == s["slug"] and row[0] == s["slug"], f"{s['slug']} sites row slug", row)
    ok(os.path.exists(s["db"]), f"{s['slug']} own DB file", s["db"])

# B-side data
TB = free_tables(PB, MTB)[0]
st, b = call(PB, "POST", "/api/checks", STB, {"table_id": TB, "tab_name": "U19B", "guest_count": 2})
assert st in (200, 201), (st, b)
BCHK, BCHK_UUID = b["id"], b["uuid"]
st, b = call(PB, "POST", "/api/gift-cards/issue", MTB, {"initial_cents": 5000})
assert st in (200, 201), (st, b)
BGC = b["card"]["code"]
st, b = call(PA, "POST", "/api/gift-cards/issue", MTA, {"initial_cents": 6000})
assert st in (200, 201), (st, b)
AGC = b["card"]["code"]

print("--- cross-site invisibility ---")
st, b = call(PB, "GET", f"/api/checks/{CID}", STB)
ok(st == 404 or (st == 200 and b.get("uuid") != CHK_UUID),
   "A check not readable as A on B", (st, (b.get("uuid") if isinstance(b, dict) else b)))
st, b = call(PB, "GET", "/api/kds/tickets?status=all", KTB)
tix = b if isinstance(b, list) else b.get("tickets", [])
ok(all(t.get("uuid") != TIX_UUID for t in tix), "A ticket uuid absent on B")
st, b = call(PB, "GET", "/api/checks/open", STB)
rows = b if isinstance(b, list) else []
ok(all(c.get("uuid") != CHK_UUID for c in rows) and any(c.get("uuid") == BCHK_UUID for c in rows),
   "B open list: own check present, A check absent")
st, b = call(PB, "GET", f"/api/gift-cards/balance/{AGC}", MTB)
ok(st == 404, "A gift card not visible on B", (st, b))
st, b = call(PA, "GET", f"/api/gift-cards/balance/{BGC}", MTA)
ok(st == 404, "B gift card not visible on A", (st, b))

print("--- slug spoof attempts ignored ---")
for name, path, kw in [
    ("X-Site-Slug header", "/api/checks/open", {"headers": {"X-Site-Slug": "bali-hai"}}),
    ("X-Site header", "/api/checks/open", {"headers": {"X-Site": "bali-hai"}}),
    ("?site= query", "/api/checks/open?site=bali-hai", {}),
    ("?site_slug= query", "/api/checks/open?site_slug=bali-hai", {}),
]:
    st, b = call(PB, "GET", path, STB, **kw)
    rows = b if isinstance(b, list) else []
    uuids = {c.get("uuid") for c in rows}
    ok(BCHK_UUID in uuids and CHK_UUID not in uuids, f"spoof via {name} has no effect", (st, uuids))

print("--- DB-file level: no bleed ---")
conB = sqlite3.connect(SITES[1]["db"]); conB.execute("PRAGMA query_only=ON")
a_uuids = {t: [r[0] for r in con.execute(f"SELECT uuid FROM {t}")] for t in SYNC_TABLES}
a_uuids["gift_cards"] = [r[0] for r in con.execute("SELECT code FROM gift_cards")]
for t, col in [("checks", "uuid"), ("check_items", "uuid"), ("payments", "uuid"),
               ("kds_tickets", "uuid"), ("clock_shifts", "uuid"), ("clock_breaks", "uuid"),
               ("gift_cards", "code")]:
    vals = a_uuids[t]
    n = conB.execute(f"SELECT COUNT(*) FROM {t} WHERE {col} IN ({','.join('?' * len(vals))})",
                     tuple(vals)).fetchone()[0] if vals else 0
    ok(n == 0, f"B file: no A {t} rows", f"{n} leaked")
for t in ["checks", "payments", "kds_tickets", "clock_shifts"]:
    bad = conB.execute(f"SELECT COUNT(*) FROM {t} WHERE site_id != 'test-site-2'").fetchone()[0]
    ok(bad == 0, f"B {t}: all rows site_id=test-site-2", f"{bad} wrong-site")
ok(conB.execute("SELECT COUNT(*) FROM checks WHERE uuid=?", (BCHK_UUID,)).fetchone()[0] == 1,
   "B file holds B's check")

print(f"\nTest 19: {checks} assertions, {len(fails)} failures")
sys.exit(1 if fails else 0)
