#!/usr/bin/env python3
"""Expoline — QA Test 17: edit items on an open check (PATCH /api/checks/:id/items/:item_id).
Covers: held-item qty/modifier edit, validation (qty bounds, modifier shape,
empty patch), 404s, voided-item rejection, closed-check rejection,
sent-item manager-PIN gate (403 without/wrong PIN, 200 + audit with PIN),
totals recompute, kitchen role blocked."""
import json, sys, urllib.request, urllib.error

BASE = "http://localhost:4331"
S = "1111"; K = "2222"; M = "2580"

def login(pin):
    r = api("POST", "/api/auth/login", None, {"pin": pin})
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
        print(f"  ok {name}")

def expect_status(method, path, token, body, want, name):
    st, txt = api(method, path, token, body, raw=True)
    ok(st == want, name, f"(got {st} {txt[:160]})")
    return st, txt

def open_check(table_id, guests=2):
    return api("POST", "/api/checks", ST, {"table_id": table_id, "guest_count": guests})["id"]

menu = api("GET", "/api/menu", ST)
items = [i for cat in menu for i in cat.get("items", []) if i["price_cents"] > 0]
ok(len(items) > 0, "menu has priced items")
ITEM = items[0]
MODS = [{"name": "Rare", "price_delta_cents": 0}, {"name": "Extra sauce", "price_delta_cents": 150}]

print("== held item: qty edit ==")
cid = open_check(21)
it = api("POST", f"/api/checks/{cid}/items", ST, {"menu_item_id": ITEM["id"], "qty": 1, "seat": 1})
iid = it["id"]
tot0 = api("GET", f"/api/checks/{cid}", ST)["total_cents"]
r = api("PATCH", f"/api/checks/{cid}/items/{iid}", ST, {"qty": 3})
ok(r.get("qty") == 3, "qty updated to 3", str(r.get("qty")))
ok(r.get("line_total_cents") == ITEM["price_cents"] * 3, "line total = 3x unit price", str(r.get("line_total_cents")))
tot1 = api("GET", f"/api/checks/{cid}", ST)["total_cents"]
ok(tot1 > tot0, "check totals recomputed after edit", f"{tot0} -> {tot1}")

print("== held item: modifier edit ==")
r = api("PATCH", f"/api/checks/{cid}/items/{iid}", ST, {"modifiers": MODS})
ok([m["name"] for m in r.get("modifiers", [])] == ["Rare", "Extra sauce"], "modifiers stored")
ok(r.get("line_total_cents") == ITEM["price_cents"] * 3 + 150 * 3, "line total includes modifier deltas x qty")

print("== validation ==")
expect_status("PATCH", f"/api/checks/{cid}/items/{iid}", ST, {"qty": 0}, 400, "qty 0 rejected")
expect_status("PATCH", f"/api/checks/{cid}/items/{iid}", ST, {"qty": 99}, 400, "qty 99 rejected")
expect_status("PATCH", f"/api/checks/{cid}/items/{iid}", ST, {"qty": "3"}, 400, "string qty rejected")
expect_status("PATCH", f"/api/checks/{cid}/items/{iid}", ST, {"modifiers": "x"}, 400, "non-array modifiers rejected")
expect_status("PATCH", f"/api/checks/{cid}/items/{iid}", ST, {"modifiers": [{"name": "x"}]}, 400, "modifier missing price_delta rejected")
expect_status("PATCH", f"/api/checks/{cid}/items/{iid}", ST, {}, 400, "empty patch rejected")
expect_status("PATCH", f"/api/checks/{cid}/items/999999", ST, {"qty": 2}, 404, "unknown item 404")
expect_status("PATCH", "/api/checks/999999/items/1", ST, {"qty": 2}, 404, "unknown check 404")
expect_status("PATCH", f"/api/checks/{cid}/items/abc", ST, {"qty": 2}, 400, "non-numeric item id 400")

print("== roles ==")
expect_status("PATCH", f"/api/checks/{cid}/items/{iid}", KT, {"qty": 2}, 403, "kitchen blocked from editing")
expect_status("PATCH", f"/api/checks/{cid}/items/{iid}", None, {"qty": 2}, 401, "unauthenticated blocked")
r = api("PATCH", f"/api/checks/{cid}/items/{iid}", MT, {"qty": 2})
ok(r.get("qty") == 2, "manager can edit held item")

print("== sent item: manager PIN gate ==")
cid2 = open_check(22)
it2 = api("POST", f"/api/checks/{cid2}/items", ST, {"menu_item_id": ITEM["id"], "qty": 1, "seat": 1})
iid2 = it2["id"]
api("POST", f"/api/checks/{cid2}/send", ST)
expect_status("PATCH", f"/api/checks/{cid2}/items/{iid2}", ST, {"qty": 2}, 403, "sent item edit without PIN rejected (403)")
expect_status("PATCH", f"/api/checks/{cid2}/items/{iid2}", ST, {"qty": 2, "manager_pin": "0000"}, 403, "sent item edit with wrong PIN rejected")
r = api("PATCH", f"/api/checks/{cid2}/items/{iid2}", ST, {"qty": 2, "manager_pin": M})
ok(r.get("qty") == 2 and r.get("approved_by"), "sent item edit with manager PIN succeeds + audit", str(r.get("approved_by")))
aud = api("GET", "/api/admin/approvals/audit?limit=5", MT)
ok(any(a.get("action") == "edit_item" and a.get("item_id") == iid2 for a in (aud if isinstance(aud, list) else aud.get("audit", []))),
   "edit_item approval audit-logged with before/after")

print("== voided + closed checks ==")
api("POST", f"/api/checks/{cid}/void-item", ST, {"item_id": iid, "manager_pin": M, "reason": "qa"})
expect_status("PATCH", f"/api/checks/{cid}/items/{iid}", ST, {"qty": 1}, 400, "voided item edit rejected")
cid3 = open_check(23)
it3 = api("POST", f"/api/checks/{cid3}/items", ST, {"menu_item_id": ITEM["id"], "qty": 1, "seat": 1})
api("POST", f"/api/checks/{cid3}/send", ST)
api("POST", f"/api/checks/{cid3}/payments", ST, {"method": "cash", "amount_cents": 100000})
api("POST", f"/api/checks/{cid3}/close", ST)
expect_status("PATCH", f"/api/checks/{cid3}/items/{it3['id']}", ST, {"qty": 2}, 400, "edit on closed check rejected")

print(f"\n{checks - len(fails)}/{checks} assertions passed")
if fails:
    print("\n".join(fails)); sys.exit(1)
print("PASS: item editing (held/sent/roles/validation/audit)")
