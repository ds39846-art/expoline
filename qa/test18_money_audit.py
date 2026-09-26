#!/usr/bin/env python3
"""Expoline MVP v0.1 — QA Test 18: money-math + pricing-validation + idempotency audit.

Phase 1B regression suite. Covers:
  18a: static float-scan — no parseFloat/toFixed in money computation paths
       (server.js + routes/*.js), outside an explicit allowlist of
       config-parsing / display-only uses.
  18b: server-side repricing — client-submitted modifier prices are ignored;
       unknown modifiers rejected; negative-qty / over-qty rejected; check
       totals always recomputed server-side in integer cents.
  18c: double-POST idempotency — payments, refunds, gift-card issue/redeem
       and loyalty redeem survive a retried request with the same
       Idempotency-Key without double-applying.
  18d: payment/refund/comp validation — no overpayment, no negative balances,
       comps capped at subtotal, no negative totals.
  18e: concurrency — N threads adding items to one check: no lost items,
       totals consistent; 86 guard holds.

Runs against EXPOLINE_BASE (default http://localhost:4322, the audit port).
"""
import json, os, re, sys, threading, urllib.request, urllib.error

BASE = os.environ.get("EXPLOINE_BASE", "http://localhost:4322")
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
S, K, M = "1111", "2222", "2580"

def login(pin):
    st, r = api("POST", "/api/auth/login", None, {"pin": pin})
    assert st == 200, f"login failed: {st} {r}"
    return r["token"]

def api(method, path, token=None, body=None, headers=None, raw=False):
    h = {"Content-Type": "application/json"}
    if token: h["Authorization"] = "Bearer " + token
    if headers: h.update(headers)
    req = urllib.request.Request(BASE + path, method=method,
        data=json.dumps(body).encode() if body is not None else None, headers=h)
    try:
        with urllib.request.urlopen(req) as resp:
            txt = resp.read().decode()
            return (resp.status, txt) if raw else (resp.status, json.loads(txt or "{}"))
    except urllib.error.HTTPError as e:
        txt = e.read().decode()
        return (e.code, txt) if raw else (e.code, json.loads(txt or "{}"))

checks, fails = 0, []
def ok(cond, name, detail=""):
    global checks
    checks += 1
    if not cond:
        fails.append(f"FAIL: {name} {detail}")
        print(f"  \u2717 {name} {detail}")
    else:
        print(f"  \u2713 {name}")

def expect_status(method, path, token, body, want, name, headers=None):
    st, txt = api(method, path, token, body, headers=headers, raw=True)
    ok(st == want, name, f"(got {st} {txt[:140]})")
    return st, txt

_table_seq = [20]
_table_lock = threading.Lock()
def new_check(token, guests=2, tab="T18"):
    with _table_lock:
        _table_seq[0] += 1
        tid = _table_seq[0]
    st, c = api("POST", "/api/checks", token, {"table_id": tid, "guest_count": guests, "tab_name": tab})
    assert st == 201, f"check open failed: {st} {c}"
    return c["id"]

def hand_totals(subtotal, guests, comp=0):
    sur = round(subtotal * 0.05)
    svc = round(subtotal * 0.18) if guests >= 8 else 0
    tax = round((subtotal + sur) * 0.0775)
    total = max(0, subtotal + sur + svc + tax - comp)
    return {"subtotal": subtotal, "surcharge": sur, "service_charge": svc,
            "tax": tax, "total": total}

def int_money_fields(obj, names):
    return all(isinstance(obj.get(n), int) and not isinstance(obj.get(n), bool) for n in names)

ST = login(S); MT = login(M)

# ---------------------------------------------------------------- 18a: float scan
print("== 18a: static float-scan of money paths ==")
# Allowlist: (file, substring-of-line, justification). Everything else with
# parseFloat / toFixed in server code is a finding.
ALLOW = [
    # site-config rate parsing (config multipliers, not money; consumed only
    # via Math.round(int_cents * rate) in calcTotals/demoFeeCents)
    ("server.js", "tax_rate: parseFloat", "config rate"),
    ("server.js", "surcharge_pct: parseFloat", "config rate"),
    ("server.js", "service_charge_pct: parseFloat", "config rate"),
    ("server.js", "stripe_demo_rate: parseFloat", "config rate"),
    ("server.js", "const n = parseFloat(r.value);", "clock config threshold"),
    ("server.js", "const n = parseFloat(value);", "clock config write"),
    ("routes/online.js", "parseFloat(r ? r.value", "tax config rate"),
    # display-only formatting ($ strings, never fed back into math)
    ("server.js", "(wotTotal / 100).toFixed(2)", "display"),
    ("server.js", "(premTotal / 100).toFixed(2)", "display"),
    ("server.js", "(Number(v) / 100).toFixed(2)", "display"),
    ("server.js", "s = (Number(v) / 100).toFixed(2)", "display"),
    ("server.js", "Number(v).toFixed(2)", "display"),
    ("routes/loyalty.js", "(discount / 100).toFixed(2)", "display"),
    ("routes/loyalty.js", "(t0.total / 100).toFixed(2)", "display"),
    # report percentages (labor %, gross share %, void rate %) — display-only,
    # never fed back into money math; underlying values stay integer cents
    ("server.js", "projected_labor_pct:", "report pct display"),
    ("server.js", "gross_share_pct:", "report pct display"),
    ("server.js", "void_rate_pct:", "report pct display"),
    # guest-review star-rating average (1-5 scale, not money) — display-only
    ("server.js", "average: rows.length ? +(sum / rows.length).toFixed(2)", "rating avg display"),
]
violations = []
for fn in ["server.js"] + [f"routes/{r}" for r in ("giftcards.js", "kiosk.js", "loyalty.js", "online.js")]:
    with open(os.path.join(REPO, fn)) as f:
        for i, line in enumerate(f, 1):
            if "parseFloat" in line or "toFixed" in line:
                if not any(a[0] == fn and a[1] in line for a in ALLOW):
                    violations.append(f"{fn}:{i}: {line.strip()[:110]}")
ok(not violations, "no unallowlisted parseFloat/toFixed in server money paths",
   f"({len(violations)}: {violations[:3]})")

# every money field the API returns must be a true int (never a float)
c0 = new_check(ST)
st, it0 = api("POST", f"/api/checks/{c0}/items", ST,
              {"menu_item_id": 7, "seat": 1, "qty": 2,
               "modifiers": [{"name": "Add chicken", "price_delta_cents": 900}]})
st, chk0 = api("GET", f"/api/checks/{c0}", ST)
ok(int_money_fields(chk0, ["subtotal_cents", "surcharge_cents", "service_charge_cents",
                           "tax_cents", "comp_cents", "total_cents"]),
   "check money fields are integer cents")
ok(int_money_fields(it0, ["unit_price_cents", "line_total_cents"]), "line money fields are integer cents")
ok(int_money_fields(chk0["totals"], ["subtotal", "surcharge", "service_charge", "tax", "total", "paid", "balance"]),
   "totals block fields are integer cents")

# ---------------------------------------------------------------- 18b: repricing
print("== 18b: server-side repricing vs tampered client input ==")
cid = new_check(ST, tab="T18-reprice")
# tampered modifier price: client claims 1c, menu says 900c -> server must use 900
st, it = api("POST", f"/api/checks/{cid}/items", ST,
             {"menu_item_id": 7, "seat": 1, "qty": 1,
              "modifiers": [{"name": "Add chicken", "price_delta_cents": 1}]})
ok(st == 201, "tampered-modifier add accepted", f"got {st}")
ok(it["line_total_cents"] == 1300 + 900, "client modifier price ignored, menu price used",
   f"got {it['line_total_cents']} want 2200")
ok(it["modifiers"][0]["price_delta_cents"] == 900, "stored modifier carries canonical menu price")
# invented negative modifier (discount fraud) -> rejected
expect_status("POST", f"/api/checks/{cid}/items", ST,
              {"menu_item_id": 7, "seat": 1, "qty": 1,
               "modifiers": [{"name": "VIP kickback", "price_delta_cents": -5000}]},
              400, "invented negative modifier rejected")
# unknown modifier name with plausible price -> rejected
expect_status("POST", f"/api/checks/{cid}/items", ST,
              {"menu_item_id": 7, "seat": 1, "qty": 1,
               "modifiers": [{"name": "Add chicken", "price_delta_cents": 900},
                             {"name": "Extra truffle", "price_delta_cents": 500}]},
              400, "unknown modifier name rejected")
# qty bounds
expect_status("POST", f"/api/checks/{cid}/items", ST,
              {"menu_item_id": 7, "seat": 1, "qty": 0}, 400, "qty=0 rejected")
expect_status("POST", f"/api/checks/{cid}/items", ST,
              {"menu_item_id": 7, "seat": 1, "qty": 1000}, 400, "qty=1000 rejected (cap)")
# check totals are server-recomputed integer math, never client totals
st, chk = api("GET", f"/api/checks/{cid}", ST)
exp = hand_totals(2200, 2)
ok(chk["subtotal_cents"] == exp["subtotal"] and chk["total_cents"] == exp["total"],
   "check totals hand-computed match", f"got sub={chk['subtotal_cents']} tot={chk['total_cents']}")
# a second line with qty 3 + modifier: qty multiplies the menu modifier price
st, it2 = api("POST", f"/api/checks/{cid}/items", ST,
              {"menu_item_id": 7, "seat": 2, "qty": 3,
               "modifiers": [{"name": "Add salmon", "price_delta_cents": 1300}]})
ok(it2["line_total_cents"] == 3 * (1300 + 1300), "qty multiplies server-side modifier price",
   f"got {it2['line_total_cents']} want 7800")

# ---------------------------------------------------------------- 18c: idempotency
print("== 18c: double-POST idempotency ==")
cid = new_check(ST, tab="T18-idem-pay")
api("POST", f"/api/checks/{cid}/items", ST, {"menu_item_id": 7, "seat": 1, "qty": 1, "modifiers": []})
st, chk = api("GET", f"/api/checks/{cid}", ST)
total = chk["totals"]["total"]
K1 = "t18-pay-key-001"
h = {"Idempotency-Key": K1}
s1, p1 = api("POST", f"/api/checks/{cid}/payments", ST,
            {"method": "cash", "amount_cents": total - 200}, headers=h)
s2, p2 = api("POST", f"/api/checks/{cid}/payments", ST,
            {"method": "cash", "amount_cents": total - 200}, headers=h)
ok(s1 == 201 and s2 == 201, "idempotent payment: both POSTs 201", f"got {s1}/{s2}")
ok(p1["payment"]["id"] == p2["payment"]["id"], "idempotent payment: same payment id replayed")
st, chk = api("GET", f"/api/checks/{cid}", ST)
ok(chk["totals"]["paid"] == total - 200, "double-POST applied payment exactly once",
   f"paid={chk['totals']['paid']} want {total - 200}")
# different key -> genuinely new payment
s3, p3 = api("POST", f"/api/checks/{cid}/payments", ST,
            {"method": "cash", "amount_cents": 200}, headers={"Idempotency-Key": "t18-pay-key-002"})
ok(s3 == 201 and p3["payment"]["id"] != p1["payment"]["id"], "different key creates a new payment")
st, chk = api("GET", f"/api/checks/{cid}", ST)
ok(chk["status"] == "paid" and chk["totals"]["balance"] == 0, "check paid in full after two keyed payments")

# refund idempotency (manager)
pay_id = p1["payment"]["id"]
RK = "t18-refund-key-001"
r1s, r1 = api("POST", f"/api/payments/{pay_id}/refund", MT, {"amount_cents": 100},
             headers={"Idempotency-Key": RK})
r2s, r2 = api("POST", f"/api/payments/{pay_id}/refund", MT, {"amount_cents": 100},
             headers={"Idempotency-Key": RK})
ok(r1s == 200 and r2s == 200, "idempotent refund: both POSTs 200", f"got {r1s}/{r2s}")
ok(r1["payment"]["refunded_cents"] == 100 and r2["payment"]["refunded_cents"] == 100,
   "double-POST refunded exactly once", f"got {r1['payment']['refunded_cents']}/{r2['payment']['refunded_cents']}")
# different key refunds again (remaining  (total-200)-100 )
r3s, r3 = api("POST", f"/api/payments/{pay_id}/refund", MT, {"amount_cents": 50},
             headers={"Idempotency-Key": "t18-refund-key-002"})
ok(r3s == 200 and r3["payment"]["refunded_cents"] == 150, "second key refunds remaining",
   f"got {r3['payment']['refunded_cents'] if r3s==200 else r3s}")

# gift-card issue idempotency (manager)
g1s, g1 = api("POST", "/api/gift-cards/issue", MT, {"initial_cents": 5000},
             headers={"Idempotency-Key": "t18-gc-issue-001"})
g2s, g2 = api("POST", "/api/gift-cards/issue", MT, {"initial_cents": 5000},
             headers={"Idempotency-Key": "t18-gc-issue-001"})
ok(g1s == 201 and g2s == 201, "idempotent gift-card issue: both 201", f"got {g1s}/{g2s}")
ok(g1["card"]["code"] == g2["card"]["code"], "double-POST issue returned the same card")
ok(g1["card"]["balance_cents"] == 5000, "issued card balance intact")

# gift-card redeem idempotency
cid = new_check(ST, tab="T18-idem-gc")
api("POST", f"/api/checks/{cid}/items", ST, {"menu_item_id": 7, "seat": 1, "qty": 1, "modifiers": []})
st, chk = api("GET", f"/api/checks/{cid}", ST)
baltot = chk["totals"]["total"]
d1s, d1 = api("POST", "/api/gift-cards/redeem", ST,
             {"check_id": cid, "gift_card_code": g1["card"]["code"], "amount_cents": 1000},
             headers={"Idempotency-Key": "t18-gc-redeem-001"})
d2s, d2 = api("POST", "/api/gift-cards/redeem", ST,
             {"check_id": cid, "gift_card_code": g1["card"]["code"], "amount_cents": 1000},
             headers={"Idempotency-Key": "t18-gc-redeem-001"})
ok(d1s == 201 and d2s == 201, "idempotent gift-card redeem: both 201", f"got {d1s}/{d2s}")
ok(d1["payment"]["id"] == d2["payment"]["id"], "double-POST redeem replayed same payment")
bs, bal = api("GET", f"/api/gift-cards/balance/{g1['card']['code']}", ST)
ok(bal["card"]["balance_cents"] == 4000, "card charged exactly once", f"got {bal['card']['balance_cents']}")

# loyalty earn + redeem idempotency
cid = new_check(ST, tab="T18-idem-loyal")
api("POST", f"/api/checks/{cid}/items", ST, {"menu_item_id": 7, "seat": 1, "qty": 10, "modifiers": []})
st, chk = api("GET", f"/api/checks/{cid}", ST)
ltot = chk["totals"]["total"]
api("POST", f"/api/checks/{cid}/payments", ST, {"method": "cash", "amount_cents": ltot})
phone = "5550180018"
e1s, e1 = api("POST", "/api/loyalty/earn", ST, {"check_id": cid, "phone": phone, "name": "T18 Regular"})
e2s, e2 = api("POST", "/api/loyalty/earn", ST, {"check_id": cid, "phone": phone, "name": "T18 Regular"})
ok(e1.get("already_earned") or e2.get("already_earned"), "loyalty earn idempotent per check",
   f"got {e1s}/{e2s}")
pts = max(e1.get("customer", {}).get("points", 0), e2.get("customer", {}).get("points", 0))
ok(pts >= 100, f"earned >= 100 points for 100-point redeem test (got {pts})")
cid2 = new_check(ST, tab="T18-idem-loyal2")
api("POST", f"/api/checks/{cid2}/items", ST, {"menu_item_id": 7, "seat": 1, "qty": 2, "modifiers": []})
L1 = "t18-loyal-redeem-001"
x1s, x1 = api("POST", "/api/loyalty/redeem", ST,
             {"check_id": cid2, "phone": phone, "points": 100},
             headers={"Idempotency-Key": L1})
x2s, x2 = api("POST", "/api/loyalty/redeem", ST,
             {"check_id": cid2, "phone": phone, "points": 100},
             headers={"Idempotency-Key": L1})
ok(x1s == 200 and x2s == 200, "idempotent loyalty redeem: both 200", f"got {x1s}/{x2s}")
ok(x1["discount_cents"] == x2["discount_cents"] == 500, "redeem discount replayed identically")
_, cust = api("GET", "/api/loyalty/lookup?phone=" + phone, ST)
ok(cust["customer"]["points"] == pts - 100, "points deducted exactly once",
   f"got {cust['customer']['points']} want {pts - 100}")
st, chk2 = api("GET", f"/api/checks/{cid2}", ST)
ok(chk2["comp_cents"] == 500, "comp applied exactly once", f"got {chk2['comp_cents']}")

# ---------------------------------------------------------------- 18d: validation
print("== 18d: payment / comp validation ==")
cid = new_check(ST, tab="T18-validate")
api("POST", f"/api/checks/{cid}/items", ST, {"menu_item_id": 7, "seat": 1, "qty": 1, "modifiers": []})
st, chk = api("GET", f"/api/checks/{cid}", ST)
sub = chk["subtotal_cents"]; tot = chk["totals"]["total"]
# overpayment rejected
expect_status("POST", f"/api/checks/{cid}/payments", ST,
              {"method": "cash", "amount_cents": tot + 1}, 400, "payment above balance rejected")
# negative tendered rejected
expect_status("POST", f"/api/checks/{cid}/payments", ST,
              {"method": "cash", "amount_cents": tot, "tendered_cents": -5}, 400,
              "negative tendered rejected")
# comp above subtotal rejected (manager)
expect_status("POST", f"/api/checks/{cid}/comp", MT,
              {"amount_cents": sub + 1, "manager_pin": M, "reason": "T18 over-comp"}, 400,
              "comp exceeding subtotal rejected")
# comp exactly subtotal accepted; total never negative
cs, comp = api("POST", f"/api/checks/{cid}/comp", MT,
               {"amount_cents": sub, "manager_pin": M, "reason": "T18 full comp"})
ok(cs == 200, "comp == subtotal accepted", f"got {cs}")
st, chk = api("GET", f"/api/checks/{cid}", ST)
ok(chk["total_cents"] >= 0 and chk["comp_cents"] == sub, "total non-negative after full comp",
   f"total={chk['total_cents']}")
# second comp on top must fail (would exceed subtotal)
expect_status("POST", f"/api/checks/{cid}/comp", MT,
              {"amount_cents": 100, "manager_pin": M, "reason": "T18 extra"}, 400,
              "cumulative comp past subtotal rejected")
# percent comp > 100 rejected; percent of zero-subtotal handled
expect_status("POST", f"/api/checks/{cid}/comp", MT,
              {"percent": 101, "manager_pin": M, "reason": "T18 pct"}, 400,
              "comp percent > 100 rejected")
# gift-card redeem above balance rejected
g3s, g3 = api("POST", "/api/gift-cards/issue", MT, {"initial_cents": 50000})
cid3 = new_check(ST, tab="T18-validate-gc")
api("POST", f"/api/checks/{cid3}/items", ST, {"menu_item_id": 7, "seat": 1, "qty": 1, "modifiers": []})
st, chk3 = api("GET", f"/api/checks/{cid3}", ST)
expect_status("POST", "/api/gift-cards/redeem", ST,
              {"check_id": cid3, "gift_card_code": g3["card"]["code"],
               "amount_cents": chk3["totals"]["balance"] + 500}, 400,
              "gift-card redeem above balance rejected")
# refund more than remaining rejected
p1s, p1 = api("POST", f"/api/checks/{cid3}/payments", ST,
             {"method": "card_demo", "amount_cents": chk3["totals"]["total"]})
expect_status("POST", f"/api/payments/{p1['payment']['id']}/refund", MT,
              {"amount_cents": p1["payment"]["amount_cents"] + 1}, 400,
              "refund above remaining rejected")

# ---------------------------------------------------------------- 18e: concurrency
print("== 18e: concurrent check updates ==")
cid = new_check(ST, guests=4, tab="T18-concurrent")
N_THREADS, PER_THREAD = 8, 3
errors = []
def adder(n):
    try:
        for _ in range(PER_THREAD):
            st, it = api("POST", f"/api/checks/{cid}/items", ST,
                         {"menu_item_id": 7, "seat": 1, "qty": 1, "modifiers": []})
            if st != 201:
                errors.append(f"thread {n}: add failed {st}")
    except Exception as e:  # noqa: BLE001
        errors.append(f"thread {n}: {e}")
threads = [threading.Thread(target=adder, args=(i,)) for i in range(N_THREADS)]
[t.start() for t in threads]
[t.join() for t in threads]
ok(not errors, "concurrent adds: no thread errors", f"({errors[:2]})")
st, chk = api("GET", f"/api/checks/{cid}", ST)
want_n = N_THREADS * PER_THREAD
ok(len(chk["items"]) == want_n, f"concurrent adds: all {want_n} items present",
   f"got {len(chk['items'])}")
exp = hand_totals(want_n * 1300, 4)
ok(chk["subtotal_cents"] == exp["subtotal"] and chk["total_cents"] == exp["total"],
   "concurrent adds: totals consistent", f"got sub={chk['subtotal_cents']} tot={chk['total_cents']}")

# 86 guard: 86 the item, add must fail; un-86, add works
es, e86 = api("POST", "/api/admin/menu/86/7", MT)
ok(es == 200 and e86.get("eightysixed") is True, "86'd item 7")
expect_status("POST", f"/api/checks/{cid}/items", ST,
              {"menu_item_id": 7, "seat": 1, "qty": 1}, 400, "add of 86'd item rejected")
es, e86b = api("POST", "/api/admin/menu/86/7", MT)
ok(es == 200 and e86b.get("eightysixed") is False, "un-86'd item 7")
st, it = api("POST", f"/api/checks/{cid}/items", ST, {"menu_item_id": 7, "seat": 1, "qty": 1})
ok(st == 201, "add works again after un-86", f"got {st}")

print(f"\nTest 18: {checks} assertions, {len(fails)} failures")
for f in fails: print(f)
sys.exit(1 if fails else 0)
