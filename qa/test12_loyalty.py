#!/usr/bin/env python3
"""Expoline — QA Test 12: loyalty (light visits/rewards).
Phone-number identification, earn on close (idempotent), redeem as comp.
"""
import json, sys, urllib.request, urllib.error
import os

BASE = os.environ.get("EXPOLINE_BASE", os.environ.get("EXPLOINE_BASE", "http://localhost:4332"))
S = "1111"; K = "2222"; M = "2580"
PHONE = "5550001111"

def login(pin):
    r = api("POST", "/api/auth/login", {}, {"pin": pin})
    return r["token"]

def api(method, path, token=None, body=None, raw=False):
    req = urllib.request.Request(BASE + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json"})
    if token: req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req) as resp:
            return (resp.status, resp.read().decode()) if raw else json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        return (e.code, e.read().decode()) if raw else (_ for _ in ()).throw(e)

ST = login(S); KT = login(K); MT = login(M)
checks, fails = 0, []
def ok(cond, name, detail=""):
    global checks
    checks += 1
    if not cond:
        fails.append(f"FAIL: {name} {detail}")
        print(f"  x {name} {detail}")
    else:
        print(f"  + {name}")

def expect_status(method, path, token, body, want, name):
    st, txt = api(method, path, token, body, raw=True)
    ok(st == want, name, f"(got {st} {txt[:140]})")
    return st, txt

def check_total(sub):
    sur = round(sub * 0.05)
    tax = round((sub + sur) * 0.0775)
    return sub + sur + tax

def make_paid_check(token, item_id, qty, table_id):
    """Open check, add items, pay in full (cash), close. Returns (check_id, total)."""
    c = api("POST", "/api/checks", token, {"table_id": table_id, "guest_count": 2})
    cid = c["id"]
    api("POST", f"/api/checks/{cid}/items", token,
        {"menu_item_id": item_id, "seat": 1, "qty": qty, "modifiers": []})
    ch = api("GET", f"/api/checks/{cid}", token)
    total = ch["total_cents"]
    api("POST", f"/api/checks/{cid}/payments", token, {"method": "cash", "amount_cents": total})
    api("POST", f"/api/checks/{cid}/close", token)
    return cid, total

def make_open_check(token, item_id, qty, table_id):
    c = api("POST", "/api/checks", token, {"table_id": table_id, "guest_count": 2})
    cid = c["id"]
    api("POST", f"/api/checks/{cid}/items", token,
        {"menu_item_id": item_id, "seat": 1, "qty": qty, "modifiers": []})
    ch = api("GET", f"/api/checks/{cid}", token)
    return cid, ch["total_cents"]

print("== 12a: lookup miss / validation / role lock ==")
r = api("GET", f"/api/loyalty/lookup?phone={PHONE}", ST)
ok(r["customer"] is None, "lookup miss -> null")
expect_status("GET", "/api/loyalty/lookup", ST, None, 400, "lookup without phone -> 400")
expect_status("GET", f"/api/loyalty/lookup?phone={PHONE}", KT, None, 403, "kitchen blocked from lookup -> 403")
expect_status("POST", "/api/loyalty/earn", KT, {"check_id": 1, "phone": PHONE}, 403, "kitchen blocked from earn -> 403")

print("== 12b: earn on close, points math ==")
cid1, total1 = make_paid_check(ST, 1, 1, 20)   # Ali'i Tasting 3000
exp_total1 = check_total(3000)
ok(total1 == exp_total1, "check total hand-computed", f"got {total1} want {exp_total1}")
exp_pts1 = (total1 // 100) * 1
e = api("POST", "/api/loyalty/earn", ST, {"check_id": cid1, "phone": PHONE, "name": "Test Regular"})
ok(e["earned"] == exp_pts1, "earn points = floor(total/100)", f"got {e['earned']} want {exp_pts1}")
cust = e["customer"]
ok(cust["visit_count"] == 1, "visit_count 1")
ok(cust["points"] == exp_pts1, "points balance", str(cust["points"]))
ok(cust["total_spent_cents"] == total1, "lifetime spend", str(cust["total_spent_cents"]))
ok(cust["is_regular"] is False, "not regular yet")
ok(cust["uuid"] is not None, "customer has uuid")
cid_cust = cust["id"]

print("== 12c: earn idempotency ==")
e2 = api("POST", "/api/loyalty/earn", ST, {"check_id": cid1, "phone": PHONE})
ok(e2.get("already_earned") is True and e2["earned"] == 0, "double earn -> no-op")
r = api("GET", f"/api/loyalty/lookup?phone={PHONE}", ST)
ok(r["customer"]["points"] == exp_pts1, "points unchanged after double earn")
ok(r["customer"]["visit_count"] == 1, "visits unchanged after double earn")

print("== 12d: earn requires paid/closed check ==")
cid_open, _ = make_open_check(ST, 1, 1, 21)
expect_status("POST", "/api/loyalty/earn", ST, {"check_id": cid_open, "phone": PHONE}, 400,
              "earn on open check -> 400")
expect_status("POST", "/api/loyalty/earn", ST, {"check_id": 999999, "phone": PHONE}, 404,
              "earn on unknown check -> 404")
expect_status("POST", "/api/loyalty/earn", ST, {"check_id": cid1}, 400,
              "earn without phone -> 400")

print("== 12e: phone uniqueness (formatting-insensitive), visit increments ==")
cid2, total2 = make_paid_check(ST, 1, 4, 22)   # 4x Ali'i = 12000
exp_pts2 = (total2 // 100)
e3 = api("POST", "/api/loyalty/earn", ST, {"check_id": cid2, "phone": "(555) 000-1111"})
ok(e3["customer"]["id"] == cid_cust, "same customer for formatted phone")
ok(e3["customer"]["visit_count"] == 2, "visit_count 2")
ok(e3["customer"]["points"] == exp_pts1 + exp_pts2, "points accumulate",
   f"got {e3['customer']['points']} want {exp_pts1 + exp_pts2}")

print("== 12f: redeem discount as comp ==")
# customer now has exp_pts1 + exp_pts2 points; redeem 100 -> $5 off
have = exp_pts1 + exp_pts2
ok(have >= 100, "enough points banked for redeem test", str(have))
cid3, total3 = make_open_check(ST, 1, 1, 23)
rd = api("POST", "/api/loyalty/redeem", ST, {"check_id": cid3, "phone": PHONE, "points": 100})
ok(rd["discount_cents"] == 500, "100 pts = $5 discount")
ch3 = api("GET", f"/api/checks/{cid3}", ST)
ok(ch3["comp_cents"] == 500, "comp_cents applied on check")
ok(ch3["total_cents"] == total3 - 500, "total reduced by discount",
   f"got {ch3['total_cents']} want {total3 - 500}")
ok(rd["customer"]["points"] == have - 100, "points deducted", str(rd["customer"]["points"]))

print("== 12g: redeem guards ==")
expect_status("POST", "/api/loyalty/redeem", ST, {"check_id": cid3, "phone": PHONE, "points": 100}, 400,
              "redeem more than balance -> 400")
expect_status("POST", "/api/loyalty/redeem", ST, {"check_id": cid3, "phone": PHONE, "points": 50}, 400,
              "redeem non-multiple of 100 -> 400")
expect_status("POST", "/api/loyalty/redeem", ST, {"check_id": cid3, "phone": PHONE, "points": -100}, 400,
              "redeem negative -> 400")
expect_status("POST", "/api/loyalty/redeem", ST, {"check_id": cid1, "phone": PHONE, "points": 100}, 400,
              "redeem on closed check -> 400")
expect_status("POST", "/api/loyalty/redeem", ST, {"check_id": cid3, "phone": "5559998888", "points": 100}, 404,
              "redeem unknown customer -> 404")
expect_status("POST", "/api/loyalty/redeem", KT, {"check_id": cid3, "phone": PHONE, "points": 100}, 403,
              "kitchen blocked from redeem -> 403")

print("== 12h: discount cannot exceed check total ==")
import sqlite3
db = sqlite3.connect("/tmp/loyalty_test.db")
db.execute("INSERT INTO site_config (site_id, key, value) VALUES ('bali-hai', 'loyalty_reward_cents_per_100pts', '50000') "
           "ON CONFLICT(site_id, key) DO UPDATE SET value=excluded.value")
db.commit(); db.close()
cid4, total4 = make_open_check(ST, 6, 1, 24)   # Bali Fries 900 -> total ~1018
# bank points first: earn on a big check so we hold 100+ (already have have-100)
expect_status("POST", "/api/loyalty/redeem", ST, {"check_id": cid4, "phone": PHONE, "points": 100}, 400,
              "discount > total -> 400")
db = sqlite3.connect("/tmp/loyalty_test.db")
db.execute("DELETE FROM site_config WHERE key='loyalty_reward_cents_per_100pts'")
db.commit(); db.close()

print("== 12i: regular flag at 5 visits + customer detail ==")
for t in (25, 26, 27):
    cx, _ = make_paid_check(ST, 6, 1, t)
    api("POST", "/api/loyalty/earn", ST, {"check_id": cx, "phone": PHONE})
r = api("GET", f"/api/loyalty/lookup?phone={PHONE}", ST)
ok(r["customer"]["visit_count"] == 5, "visit_count 5", str(r["customer"]["visit_count"]))
ok(r["customer"]["is_regular"] is True, "regular flag at 5 visits")
d = api("GET", f"/api/loyalty/customer/{cid_cust}", ST)
ok(d["customer"]["id"] == cid_cust, "customer detail")
ok(len(d["recent_txns"]) >= 6, "txn history present", str(len(d["recent_txns"])))
ok(all(t in ("earn", "redeem") for t in [x["type"] for x in d["recent_txns"]]), "txn types valid")
expect_status("GET", "/api/loyalty/customer/999999", ST, None, 404, "unknown customer -> 404")

print(f"\nTest 12: {checks} assertions, {len(fails)} failures")
for f in fails: print(f)
sys.exit(1 if fails else 0)
