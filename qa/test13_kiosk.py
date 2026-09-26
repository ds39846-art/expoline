#!/usr/bin/env python3
"""Expoline QA Test 13: kiosk mode + digital menu boards."""
import json, sys, urllib.request, urllib.error
import os

BASE = os.environ.get("EXPOLINE_BASE", os.environ.get("EXPLOINE_BASE", "http://localhost:4333"))
M = "2580"  # manager PIN

checks = 0
fails = []

def ok(cond, name, detail=""):
    global checks
    checks += 1
    if not cond:
        fails.append(f"FAIL: {name} {detail}")
        print(f"  ✗ {name} {detail}")
    # else: print(f"  ✓ {name}")

def api(method, path, token=None, body=None):
    req = urllib.request.Request(BASE + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json"})
    if token:
        req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req) as resp:
            return resp.status, json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode() or "{}")
        except Exception:
            return e.code, {}

def login(pin):
    s, b = api("POST", "/api/auth/login", None, {"pin": pin})
    assert s == 200, (s, b)
    return b["token"]

MT = login(M)

print("-- kiosk menu --")
s, menu = api("GET", "/api/kiosk/menu")
ok(s == 200, "kiosk menu 200", str(s))
cats = menu.get("categories", [])
ok(len(cats) > 0, "menu has categories", str(len(cats)))
all_items = [it for c in cats for it in c["items"]]
ok(all(all_items), "menu has items", str(len(all_items)))
# 86'd items must be EXCLUDED, not flagged — no 'active' field at all
ok(all("active" not in it for it in all_items), "no active flag leaked (excluded, not flagged)")

# find the Cheese Burger (has modifiers in seed)
burger = next((it for it in all_items if it["name"] == "The Cheese Burger"), None)
ok(burger is not None, "found The Cheese Burger in kiosk menu")
if burger:
    ok(burger["price_cents"] > 0, "burger has fixed price")
    mods = {m["name"]: m["price_delta_cents"] for m in burger.get("modifiers", [])}
    ok(mods.get("Add bacon") == 300, "server modifier price 300", str(mods))

print("-- 86 exclusion --")
victim = all_items[0]
s, r = api("POST", f"/api/admin/menu/86/{victim['id']}", MT)
ok(s == 200 and r.get("eightysixed") is True, "86 toggle ok", str((s, r)))
s, menu2 = api("GET", "/api/kiosk/menu")
ids2 = {it["id"] for c in menu2["categories"] for it in c["items"]}
ok(victim["id"] not in ids2, "86'd item excluded from kiosk menu")
s, menu3 = api("GET", "/api/menuboards")
ids3 = {it["id"] for c in menu3["categories"] for it in c["items"]}
ok(victim["id"] not in ids3, "86'd item excluded from menuboards")
s, r = api("POST", f"/api/admin/menu/86/{victim['id']}", MT)  # un-86
ok(s == 200 and r.get("active") == 1, "un-86 restores", str((s, r)))

print("-- kiosk order (server-side pricing) --")
if burger:
    # Lie about the modifier price: server must use the DB price (300), not 99999.
    s, order = api("POST", "/api/kiosk/order", None, {
        "customer_name": "Kiosk QA",
        "items": [
            {"menu_item_id": burger["id"], "qty": 2,
             "modifiers": [{"name": "Add bacon", "price_delta_cents": 99999}]},
        ],
    })
    ok(s == 201, "kiosk order 201 (no auth)", str(s))
    check = order.get("check", {})
    ok(check.get("id") is not None, "order created a check")
    ok(check.get("table_id") is not None, "check on a table")
    # fetch check detail to inspect stored modifier pricing
    s2, det = api("GET", f"/api/checks/{check['id']}", MT)
    if s2 == 200:
        ln = (det.get("items") or [{}])[0]
        stored_mods = ln.get("modifiers") or []
        ok(stored_mods and stored_mods[0].get("price_delta_cents") == 300,
           "server re-priced lying modifier to 300", str(stored_mods))
        ok(ln.get("state") == "sent", "kiosk items fire as sent (not held)", str(ln.get("state")))
        # money: 2 x (burger + 300)
        exp_sub = 2 * (burger["price_cents"] + 300)
        ok(det.get("subtotal_cents") == exp_sub, "subtotal uses server prices",
           f"{det.get('subtotal_cents')} vs {exp_sub}")
    tickets = order.get("tickets", [])
    ok(len(tickets) >= 1, "KDS tickets created", str(len(tickets)))
    ok(all(t.get("table_label") == "KIOSK" for t in tickets), "tickets labeled KIOSK")

print("-- invalid item --")
s, r = api("POST", "/api/kiosk/order", None, {"items": [{"menu_item_id": 999999, "qty": 1}]})
ok(s == 400, "invalid item id -> 400", str(s))
s, r = api("POST", "/api/kiosk/order", None, {"items": []})
ok(s == 400, "empty items -> 400", str(s))
s, r = api("POST", "/api/kiosk/order", None,
           {"items": [{"menu_item_id": burger["id"] if burger else 1, "qty": 1,
                       "modifiers": [{"name": "No such mod"}]}]})
ok(s == 400, "unknown modifier -> 400", str(s))

print("-- call staff --")
s, r = api("POST", "/api/kiosk/call-staff")
ok(s in (200, 201), "call staff ok", str(s))
call_id = r.get("id")
s, calls = api("GET", "/api/kiosk/calls")
ok(s == 200 and any(c["id"] == call_id for c in calls), "flag visible to floor", str(calls))
if call_id:
    s, r = api("POST", f"/api/kiosk/calls/{call_id}/clear")
    ok(s == 200, "clear flag", str(s))
    s, calls = api("GET", "/api/kiosk/calls")
    ok(all(c["id"] != call_id for c in calls), "flag cleared")

print("-- menuboards split --")
s, b1 = api("GET", "/api/menuboards?board=1&boards=2")
s, b2 = api("GET", "/api/menuboards?board=2&boards=2")
s, ball = api("GET", "/api/menuboards")
n1 = {c["name"] for c in b1["categories"]}
n2 = {c["name"] for c in b2["categories"]}
nall = {c["name"] for c in ball["categories"]}
ok(n1.isdisjoint(n2), "board split disjoint", f"{n1} vs {n2}")
ok(n1 | n2 == nall, "board split covers all", f"{n1|n2} vs {nall}")
ok(b1["board"] == 1 and b1["boards"] == 2, "board params echoed")

print("-- rate limit --")
# 30 orders/min/IP allowed; fire 32 and expect 429s.
codes = []
for i in range(32):
    s, _ = api("POST", "/api/kiosk/order", None,
               {"items": [{"menu_item_id": burger["id"] if burger else 1, "qty": 1}]})
    codes.append(s)
n429 = sum(1 for c in codes if c == 429)
ok(n429 >= 1, "rate limit triggers 429", f"{n429}/32 got 429")
ok(sum(1 for c in codes if c == 201) >= 25, "orders before limit succeed",
   f"{sum(1 for c in codes if c == 201)}/32 got 201")

print(f"\nTest 13: {checks} assertions, {len(fails)} failures")
for f in fails:
    print(f)
sys.exit(1 if fails else 0)
