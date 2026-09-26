#!/usr/bin/env python3
"""Expoline online ordering (order-ahead) — qa/test14_online.py (scratch DB, port 4334).

Rate limiting is in-memory per process, so this file restarts the scratch
server (port 4334 ONLY) between phases to get a fresh bucket. DB is on disk
and survives restarts.
"""
import json, os, signal, subprocess, sys, time, urllib.request, urllib.error, datetime

BASE = "http://localhost:4335"
SRV_DIR = "/home/hatch/workspace/goals/expo-line-pos-beat-toast-spoton-pilot-at-bali-hai/build/expoline"
passed, failed = [], []

def check(name, cond, detail=""):
    (passed if cond else failed).append(name)
    print(("PASS " if cond else "FAIL ") + name + (f" [{detail}]" if detail and not cond else ""))

def call(method, path, token=None, body=None):
    req = urllib.request.Request(BASE + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json", **({"Authorization": "Bearer " + token} if token else {})})
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:500]

def login(pin):
    s, b = call("POST", "/api/auth/login", body={"pin": pin, "site": "bali-hai"})
    assert s == 200, (s, b)
    return b["token"]

def wait_up(timeout=25):
    for _ in range(int(timeout * 2)):
        try:
            s, _ = call("GET", "/api/health")
            if s == 200:
                return True
        except Exception:
            pass
        time.sleep(0.5)
    return False

def restart_server():
    """Restart ONLY the scratch server on port 4335 (never 4317/4320)."""
    subprocess.run("lsof -ti:4335 | xargs kill -9 2>/dev/null", shell=True)
    time.sleep(2)
    env = dict(os.environ, EXPOLINE_PORT="4335", EXPOLINE_DB="/tmp/online_test.db")
    subprocess.Popen(["node", "server.js"], cwd=SRV_DIR, env=env,
                     stdout=open("/tmp/online_boot.log", "a"),
                     stderr=subprocess.STDOUT, start_new_session=True)
    assert wait_up(), "scratch server did not come back up"

AUTH = {}
def relogin():
    AUTH["kt"] = login("2222")   # kitchen
    AUTH["mt"] = login("2580")   # manager
    AUTH["st"] = login("1111")   # server

def fee_free_totals(lines):
    sub = sum(q * p for q, p in lines)
    tax = round(sub * 0.0775)
    return sub, tax, sub + tax

def place(customer, phone, items, **kw):
    return call("POST", "/api/online/orders",
                body={"customer_name": customer, "phone": phone, "items": items, **kw})

# ---------------------------------------------------------------- phase 0
print("--- phase 0: rate limit (fresh bucket) ---")
relogin()
s, menu0 = call("GET", "/api/online/menu")
assert s == 200, (s, menu0)
item_a = [it for c in menu0 for it in (c.get("items") or [])][0]
got429 = False
for i in range(12):
    s, _ = place(f"RL {i}", f"5550199{i:03d}", [{"menu_item_id": item_a["id"], "qty": 1}])
    if s == 429:
        got429 = True
        break
check("rate limit 429 after 10/min/IP", got429)

# ---------------------------------------------------------------- phase 1
print("--- phase 1: menu + pricing + validation + 86 ---")
restart_server(); relogin()
kt, mt = AUTH["kt"], AUTH["mt"]

s, menu = call("GET", "/api/online/menu")
check("menu 200 public", s == 200, (s, str(menu)[:80]))
check("menu has categories", isinstance(menu, list) and len(menu) > 0)
all_items = [it for c in menu for it in (c.get("items") or [])]
check("menu has items", len(all_items) > 3, len(all_items))
s2, admin = call("GET", "/api/admin/menu/items", mt)
eightysixed = set()
if s2 == 200:
    items = admin if isinstance(admin, list) else admin.get("items", [])
    eightysixed = {it["id"] for it in items if not it.get("active", 1)}
pub_ids = {it["id"] for it in all_items}
check("no 86d items in public menu", not (pub_ids & eightysixed), pub_ids & eightysixed)
check("menu items priced", all("price_cents" in it for it in all_items))

a, b = all_items[0], all_items[1]
PA, PB = a["price_cents"], b["price_cents"]

s, o = place("QA Tester", "(555) 010-2030",
             [{"menu_item_id": a["id"], "qty": 2}, {"menu_item_id": b["id"], "qty": 1}],
             subtotal_cents=1, total_cents=1)  # lies — server must ignore
check("place 201", s == 201, (s, o))
esub, etax, etot = fee_free_totals([(2, PA), (1, PB)])
check("server subtotal", o.get("subtotal_cents") == esub, (o.get("subtotal_cents"), esub))
check("server tax 7.75%", o.get("tax_cents") == etax, (o.get("tax_cents"), etax))
check("server total", o.get("total_cents") == etot, (o.get("total_cents"), etot))
check("status placed", o.get("status") == "placed")
check("uuid present", bool(o.get("uuid")))
check("pay_at_pickup flag", o.get("pay_at_pickup") is True)
oid = o["id"]

s, _ = place("", "5550102030", [{"menu_item_id": a["id"], "qty": 1}])
check("missing name 400", s == 400, s)
s, _ = place("X", "12", [{"menu_item_id": a["id"], "qty": 1}])
check("bad phone 400", s == 400, s)
s, _ = place("X", "5550102030", [])
check("empty items 400", s == 400, s)
s, _ = place("X", "5550102030", [{"menu_item_id": a["id"], "qty": 0}])
check("qty 0 400", s == 400, s)
s, _ = place("X", "5550102030", [{"menu_item_id": 999999, "qty": 1}])
check("unknown item 400", s == 400, s)
past = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=1)).isoformat()
s, _ = place("X", "5550102030", [{"menu_item_id": a["id"], "qty": 1}], pickup_at=past)
check("past pickup 400", s == 400, s)

s, r86 = call("POST", f"/api/admin/menu/86/{b['id']}", mt)
check("86 toggle ok", s == 200 and r86.get("eightysixed") is True, (s, r86))
s, e = place("QA", "5550102030", [{"menu_item_id": b["id"], "qty": 1}])
check("86d item 400", s == 400 and "86" in json.dumps(e), (s, e))
s, m2 = call("GET", "/api/online/menu")
pub_ids2 = {it["id"] for c in (m2 if s == 200 else []) for it in (c.get("items") or [])}
check("86d hidden from menu", b["id"] not in pub_ids2)
s, r86 = call("POST", f"/api/admin/menu/86/{b['id']}", mt)
check("un-86 ok", s == 200 and r86.get("eightysixed") is False, (s, r86))

# ---------------------------------------------------------------- phase 2
print("--- phase 2: status flow + KDS + sorting + reorder + roles ---")
restart_server(); relogin()
kt, mt, st = AUTH["kt"], AUTH["mt"], AUTH["st"]

s, o2 = place("KDS Check", "5550102040", [{"menu_item_id": a["id"], "qty": 1}])
check("flow order placed", s == 201, (s, o2))
fid = o2["id"]
s, e = call("PATCH", f"/api/online/orders/{fid}", kt, {"status": "ready"})
check("placed->ready 400", s == 400, (s, e))
s, r = call("PATCH", f"/api/online/orders/{fid}", kt, {"status": "confirmed"})
check("placed->confirmed 200", s == 200, (s, r))
check("kds tickets fired", isinstance(r.get("kds_tickets"), list) and len(r["kds_tickets"]) > 0, r.get("kds_tickets"))
s, tickets = call("GET", "/api/kds/tickets?status=all", kt)
mine = [t for t in tickets if (t.get("table_label") or "").startswith(f"ONLINE #{fid}")]
check("online ticket on KDS", len(mine) > 0, len(tickets))
check("KDS ticket labeled ONLINE", all("ONLINE" in (t.get("table_label") or "") for t in mine))
s, r = call("PATCH", f"/api/online/orders/{fid}", kt, {"status": "ready"})
check("confirmed->ready 200", s == 200, (s, r))
s, e = call("PATCH", f"/api/online/orders/{fid}", kt, {"status": "cancelled"})
check("ready->cancelled 400", s == 400, (s, e))
s, r = call("PATCH", f"/api/online/orders/{fid}", kt, {"status": "picked_up"})
check("ready->picked_up 200", s == 200 and r["order"]["status"] == "picked_up", (s, r))

s, oc = place("Cancel Me", "5550102050", [{"menu_item_id": a["id"], "qty": 1}])
s, r = call("PATCH", f"/api/online/orders/{oc['id']}", kt, {"status": "cancelled"})
check("placed->cancelled 200", s == 200 and r["order"]["status"] == "cancelled", (s, r))
s, oc2 = place("Cancel Me 2", "5550102051", [{"menu_item_id": a["id"], "qty": 1}])
check("cancel2 order placed", s == 201, (s, oc2))
call("PATCH", f"/api/online/orders/{oc2['id']}", kt, {"status": "confirmed"})
s, r = call("PATCH", f"/api/online/orders/{oc2['id']}", kt, {"status": "cancelled"})
check("confirmed->cancelled 200", s == 200, (s, r))

now = datetime.datetime.now(datetime.timezone.utc)
t30 = (now + datetime.timedelta(minutes=30)).isoformat()
t60 = (now + datetime.timedelta(minutes=60)).isoformat()
place("Sort C", "5550102060", [{"menu_item_id": a["id"], "qty": 1}], pickup_at=t60)
place("Sort A", "5550102061", [{"menu_item_id": a["id"], "qty": 1}])  # ASAP
place("Sort B", "5550102062", [{"menu_item_id": a["id"], "qty": 1}], pickup_at=t30)
s, act = call("GET", "/api/online/orders", kt)
check("kitchen list 200", s == 200, s)
names = [o["customer_name"] for o in act if o["customer_name"] in ("Sort A", "Sort B", "Sort C")]
check("sorted ASAP,t+30,t+60", names == ["Sort A", "Sort B", "Sort C"], names)

s, last = call("GET", "/api/online/last?phone=5550102061")
check("last order 200", s == 200 and last["customer_name"] == "Sort A", (s, last))
check("last order has items", len(last.get("items", [])) > 0)
s, e = call("GET", "/api/online/last?phone=5550000000")
check("unknown phone 404", s == 404, s)

s, _ = call("GET", "/api/online/orders", st)
check("server blocked from kitchen list 403", s == 403, s)
s, _ = call("PATCH", f"/api/online/orders/{oid}", st, {"status": "confirmed"})
check("server blocked from status change 403", s == 403, s)

print(f"\n{len(passed)} passed, {len(failed)} failed")
if failed:
    print("FAILED:", failed)
    sys.exit(1)
