#!/usr/bin/env python3
"""Expoline — QA Test 11: gift cards (stored value).
Covers: issue (code format, validation, roles), balance lookup, redeem
(full + partial), reload, void (unused ok / used rejected), over-balance
redeem rejected, double-spend race, gift-card payments in finance."""
import json, re, sys, threading, urllib.request, urllib.error

BASE = "http://localhost:4331"
S = "1111"; K = "2222"; M = "2580"

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

def login(pin):
    return api("POST", "/api/auth/login", None, {"pin": pin})["token"]

ST = login(S); KT = login(K); MT = login(M)
checks, fails = 0, []
def ok(cond, name, detail=""):
    global checks
    checks += 1
    if not cond:
        fails.append(f"FAIL: {name} {detail}")
        print(f"  ✗ {name} {detail}")
    else:
        print(f"  ✓ {name}")

def expect_status(method, path, token, body, want, name):
    st, _ = api(method, path, token, body, raw=True)
    ok(st == want, name, f"got {st}, want {want}")

CODE_RE = re.compile(r'^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$')
AMBIGUOUS = set('01OIL')

print("== issue ==")
r = api("POST", "/api/gift-cards/issue", MT, {"initial_cents": 5000})
c1 = r["card"]
ok(CODE_RE.match(c1["code"]), "code format XXXX-XXXX-XXXX", c1["code"])
ok(not (set(c1["code"].replace("-", "")) & AMBIGUOUS), "no ambiguous chars (0/O/1/I/L)")
ok(c1["balance_cents"] == 5000 and c1["status"] == "active", "issue balance/status")
ok(c1["uuid"], "card has uuid")
# uniqueness: issue several, all codes distinct
codes = {c1["code"]}
for _ in range(5):
    codes.add(api("POST", "/api/gift-cards/issue", MT, {"initial_cents": 1000})["card"]["code"])
ok(len(codes) == 6, "codes unique across issues")

print("== issue validation / roles ==")
expect_status("POST", "/api/gift-cards/issue", MT, {"initial_cents": 0}, 400, "issue 0 rejected")
expect_status("POST", "/api/gift-cards/issue", MT, {"initial_cents": -100}, 400, "issue negative rejected")
expect_status("POST", "/api/gift-cards/issue", MT, {}, 400, "issue missing amount rejected")
expect_status("POST", "/api/gift-cards/issue", ST, {"initial_cents": 1000}, 403, "server cannot issue")
expect_status("POST", "/api/gift-cards/issue", KT, {"initial_cents": 1000}, 403, "kitchen cannot issue")

print("== balance lookup ==")
b = api("GET", f"/api/gift-cards/balance/{c1['code']}", ST)
ok(b["card"]["balance_cents"] == 5000, "balance lookup (server role)")
# lowercase + no dashes still resolves
b2 = api("GET", f"/api/gift-cards/balance/{c1['code'].replace('-', '').lower()}", ST)
ok(b2["card"]["id"] == c1["id"], "code normalization (case/dashes)")
expect_status("GET", "/api/gift-cards/balance/ZZZZ-ZZZZ-ZZZZ", ST, None, 404, "unknown code 404")
expect_status("GET", "/api/gift-cards/balance/ZZZZ-ZZZZ-ZZZZ", KT, None, 403, "kitchen blocked from lookup")

print("== redeem: full amount ==")
# open a check with a known total: use menu item directly via API
menu = api("GET", "/api/menu", ST)
items = [i for cat in menu for i in cat.get("items", []) if i["price_cents"] > 0]
item = items[0]
ok(len(items) > 0, "menu has priced items")
chk = api("POST", "/api/checks", ST, {"table_id": 1, "guest_count": 1})
cid = chk["id"]
api("POST", f"/api/checks/{cid}/items", ST, {"menu_item_id": item["id"], "qty": 1, "seat": 1})
api("POST", f"/api/checks/{cid}/send", ST)
tot = api("GET", f"/api/checks/{cid}", ST)["total_cents"]
ok(tot > 0, "check has total", tot)
# issue a card covering exactly the total
rc = api("POST", "/api/gift-cards/issue", MT, {"initial_cents": tot})["card"]
rd = api("POST", "/api/gift-cards/redeem", ST,
         {"check_id": cid, "gift_card_code": rc["code"]})
ok(rd["payment"]["method"] == "gift_card", "payment method gift_card")
ok(rd["payment"]["amount_cents"] == tot, "redeem defaulted to full balance")
ok(rd["card"]["balance_cents"] == 0 and rd["card"]["status"] == "depleted", "card depleted")
ok(rd["check"]["status"] == "paid", "check paid in full")
ok(rd["payment"]["brand"] == "GIFT", "payment brand GIFT")
# txn history
tx = api("GET", f"/api/gift-cards/{rc['code']}/txns", MT)
ok([t["type"] for t in tx["txns"]] == ["issue", "redeem"], "txn log issue+redeem")

print("== redeem: partial ==")
chk2 = api("POST", "/api/checks", ST, {"table_id": 2, "guest_count": 1})
cid2 = chk2["id"]
api("POST", f"/api/checks/{cid2}/items", ST, {"menu_item_id": item["id"], "qty": 2, "seat": 1})
api("POST", f"/api/checks/{cid2}/send", ST)
tot2 = api("GET", f"/api/checks/{cid2}", ST)["total_cents"]
big = api("POST", "/api/gift-cards/issue", MT, {"initial_cents": tot2 + 5000})["card"]
part = tot2 // 2
rd2 = api("POST", "/api/gift-cards/redeem", ST,
          {"check_id": cid2, "gift_card_code": big["code"], "amount_cents": part})
ok(rd2["card"]["balance_cents"] == (tot2 + 5000) - part, "partial leaves balance")
ok(rd2["card"]["status"] == "active", "card stays active after partial")
ok(rd2["check"]["status"] == "open", "check stays open after partial")
# remainder payable by cash
rem = api("GET", f"/api/checks/{cid2}", ST)["totals"]["balance"]
ok(rem == tot2 - part, "remainder correct", rem)
api("POST", f"/api/checks/{cid2}/payments", ST, {"method": "cash", "amount_cents": rem})
ok(api("GET", f"/api/checks/{cid2}", ST)["status"] == "paid", "remainder paid by cash")

print("== redeem validation ==")
expect_status("POST", "/api/gift-cards/redeem", ST,
              {"check_id": cid2, "gift_card_code": big["code"], "amount_cents": 10},
              400, "redeem on paid check rejected")
chk3 = api("POST", "/api/checks", ST, {"table_id": 3, "guest_count": 1})["id"]
expect_status("POST", "/api/gift-cards/redeem", ST,
              {"check_id": chk3, "gift_card_code": big["code"], "amount_cents": 99999999},
              400, "redeem over balance rejected")
expect_status("POST", "/api/gift-cards/redeem", ST,
              {"check_id": chk3, "gift_card_code": "ZZZZ-ZZZZ-ZZZZ", "amount_cents": 100},
              404, "redeem unknown card 404")
expect_status("POST", "/api/gift-cards/redeem", ST,
              {"check_id": chk3, "gift_card_code": rc["code"], "amount_cents": 100},
              400, "redeem depleted card rejected")
expect_status("POST", "/api/gift-cards/redeem", ST,
              {"check_id": chk3, "gift_card_code": big["code"], "amount_cents": 100, "tip_cents": 500},
              400, "tip on gift card rejected")
expect_status("POST", "/api/gift-cards/redeem", KT,
              {"check_id": chk3, "gift_card_code": big["code"], "amount_cents": 100},
              403, "kitchen cannot redeem")
expect_status("POST", "/api/gift-cards/redeem", ST,
              {"check_id": 999999, "gift_card_code": big["code"], "amount_cents": 100},
              404, "redeem unknown check 404")

print("== reload ==")
rl = api("POST", "/api/gift-cards/reload", MT, {"code": rc["code"], "amount_cents": 2000})
ok(rl["card"]["balance_cents"] == 2000 and rl["card"]["status"] == "active",
   "reload reactivates depleted card")
expect_status("POST", "/api/gift-cards/reload", ST, {"code": rc["code"], "amount_cents": 100},
              403, "server cannot reload")
expect_status("POST", "/api/gift-cards/reload", MT, {"code": rc["code"], "amount_cents": 0},
              400, "reload 0 rejected")

print("== void ==")
vc = api("POST", "/api/gift-cards/issue", MT, {"initial_cents": 3000})["card"]
v = api("POST", "/api/gift-cards/void", MT, {"code": vc["code"]})
ok(v["card"]["status"] == "voided", "unused card voided")
expect_status("POST", "/api/gift-cards/void", MT, {"code": vc["code"]}, 400, "double void rejected")
expect_status("POST", "/api/gift-cards/void", MT, {"code": big["code"]}, 400, "used card cannot be voided")
expect_status("POST", "/api/gift-cards/void", MT, {"code": rc["code"]}, 400, "reloaded (used) card cannot be voided")
expect_status("POST", "/api/gift-cards/void", ST, {"code": vc["code"]}, 403, "server cannot void")
expect_status("POST", "/api/gift-cards/redeem", ST,
              {"check_id": chk3, "gift_card_code": vc["code"], "amount_cents": 100},
              400, "redeem voided card rejected")
expect_status("POST", "/api/gift-cards/reload", MT, {"code": vc["code"], "amount_cents": 100},
              400, "reload voided card rejected")

print("== double-spend race ==")
race_card = api("POST", "/api/gift-cards/issue", MT, {"initial_cents": 4000})["card"]
chk4 = api("POST", "/api/checks", ST, {"table_id": 4, "guest_count": 1})["id"]
api("POST", f"/api/checks/{chk4}/items", ST, {"menu_item_id": item["id"], "qty": 1, "seat": 1})
api("POST", f"/api/checks/{chk4}/send", ST)
results = []
barrier = threading.Barrier(2)
def race_redeem():
    barrier.wait()  # both threads fire at once to maximize overlap
    st, txt = api("POST", "/api/gift-cards/redeem", ST,
                  {"check_id": chk4, "gift_card_code": race_card["code"], "amount_cents": 4000},
                  raw=True)
    results.append(st)
threads = [threading.Thread(target=race_redeem) for _ in range(2)]
[t.start() for t in threads]
[t.join() for t in threads]
ok(results.count(201) == 1 and sorted(results)[1] in (400, 409),
   "double-spend: exactly one wins, loser fails", results)
final = api("GET", f"/api/gift-cards/balance/{race_card['code']}", ST)["card"]
ok(final["balance_cents"] == 0, "no negative balance after race", final["balance_cents"])
# every gift_card_txn for this card sums to the issued amount (no phantom money)
txns = api("GET", f"/api/gift-cards/{race_card['code']}/txns", MT)["txns"]
redeemed = sum(t["amount_cents"] for t in txns if t["type"] == "redeem")
ok(redeemed == 4000, "exactly one redeem txn recorded", redeemed)

print("== finance includes gift card payments ==")
shift = api("GET", "/api/finance/shift", MT)
ok(shift["checks_closed"] >= 0, "shift report ok with gift_card payments")
payout = api("GET", "/api/finance/payouts", MT)
ok("expected_payout_cents" in payout, "payouts report ok with gift_card payments")
# gift-card payment rows are first-class completed payments the finance SQL reads
ok(rd["payment"]["status"] == "completed" and rd["payment"]["method"] == "gift_card",
   "redeem payment is a completed gift_card payment row")
# void was audit-logged (required)
audit = api("GET", "/api/admin/approvals/audit?limit=50", MT)
ok(any(a["action"] == "gift_card_void" and vc["code"] in (a["before_json"] or "")
       for a in audit), "void appears in approval audit log")

print(f"\nTest 11: {checks} assertions, {len(fails)} failures")
for f in fails: print(f)
sys.exit(1 if fails else 0)
