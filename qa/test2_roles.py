#!/usr/bin/env python3
"""Expoline QA Test 2: role enforcement. Expect exact 401/403/404/200s."""
import json, sys, urllib.request, urllib.error
BASE = "http://localhost:4317"
def api(method, path, token=None, body=None):
    req = urllib.request.Request(BASE + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type":"application/json"})
    if token: req.add_header("Authorization", "Bearer "+token)
    try:
        with urllib.request.urlopen(req) as r: return (r.status, json.loads(r.read().decode() or "{}"))
    except urllib.error.HTTPError as e:
        return (e.code, json.loads(e.read().decode() or "{}"))
def tok(pin): return api("POST","/api/auth/login",None,{"pin":pin})[1]["token"]
ST, KT, MT = tok("1111"), tok("2222"), tok("2580")
checks, fails = 0, []
def want(got, want_code, name):
    global checks
    checks += 1
    if got[0] != want_code:
        fails.append(f"FAIL {name}: want {want_code} got {got[0]} {got[1]}")
        print(f"  ✗ {name}: want {want_code}, got {got[0]}")
    else: print(f"  ✓ {name} -> {got[0]}")

# need a ticket id for bump tests
kids = api("GET","/api/kds/tickets",KT)[1]
tid = kids[0]["id"] if kids else 999999
# need a payment id for refund tests: get from payouts
pays = api("GET","/api/finance/payouts?date=2026-09-25",MT)[1]
pid = pays["card_payments"][0]["id"] if pays["card_payments"] else 999999

print("-- no token --")
want(api("GET","/api/menu"), 401, "no token GET /api/menu")
want(api("GET","/api/config"), 401, "no token GET /api/config")
want(api("GET","/api/health"), 200, "no token GET /api/health (public)")
want(api("POST","/api/auth/login",None,{"pin":"0000"}), 401, "bad PIN login")
want(api("POST","/api/auth/login",None,{"pin":""}), 401, "empty PIN login")
want(api("GET","/api/menu","bogus-token"), 401, "garbage token GET /api/menu")

print("-- server --")
want(api("GET","/api/kds/tickets",ST), 403, "server GET /api/kds/tickets")
want(api("GET","/api/kds/recall",ST), 403, "server GET /api/kds/recall")
want(api("POST",f"/api/kds/tickets/{tid}/bump",ST,{"status":"in_progress"}), 403, "server POST kds bump")
want(api("GET","/api/finance/payouts",ST), 403, "server GET /api/finance/payouts")
want(api("GET","/api/finance/shift",ST), 403, "server GET /api/finance/shift")
want(api("GET","/api/manager/overview",ST), 403, "server GET /api/manager/overview")
want(api("POST",f"/api/payments/{pid}/refund",ST,{}), 403, "server POST payment refund")
want(api("GET","/api/checks/open",ST), 200, "server GET /api/checks/open")
want(api("GET","/api/menu",ST), 200, "server GET /api/menu")

print("-- kitchen --")
want(api("GET","/api/finance/payouts",KT), 403, "kitchen GET /api/finance/payouts")
want(api("GET","/api/finance/shift",KT), 403, "kitchen GET /api/finance/shift")
want(api("GET","/api/manager/overview",KT), 403, "kitchen GET /api/manager/overview")
want(api("POST",f"/api/payments/{pid}/refund",KT,{}), 403, "kitchen POST payment refund")
want(api("POST","/api/checks",KT,{"table_id":5,"guest_count":2}), 403, "kitchen POST /api/checks")
want(api("GET","/api/checks/open",KT), 403, "kitchen GET /api/checks/open")
want(api("GET","/api/kds/tickets",KT), 200, "kitchen GET /api/kds/tickets")
want(api("POST",f"/api/kds/tickets/{tid}/bump",KT,{"status":"fulfilled"}), 200, "kitchen bump 200")

print("-- manager --")
want(api("GET","/api/kds/tickets",MT), 200, "manager GET /api/kds/tickets")
want(api("GET","/api/kds/recall",MT), 200, "manager GET /api/kds/recall")
want(api("GET","/api/finance/payouts",MT), 200, "manager GET /api/finance/payouts")
want(api("GET","/api/finance/shift",MT), 200, "manager GET /api/finance/shift")
want(api("GET","/api/manager/overview",MT), 200, "manager GET /api/manager/overview")
want(api("GET","/api/checks/open",MT), 200, "manager GET /api/checks/open")
want(api("POST","/api/checks",MT,{"table_id":5,"guest_count":2}), 201, "manager POST /api/checks (will cleanup)")
# manager refund works and updates finance: create a fresh paid check on table 5, then refund
c5 = api("GET","/api/checks/open",MT)[1]
chk = [c for c in c5 if c["table_id"]==5][0]
it = api("POST",f"/api/checks/{chk['id']}/items",MT,{"menu_item_id":90,"seat":1,"qty":1,"modifiers":[]})[1]  # Soda 400
pay = api("POST",f"/api/checks/{chk['id']}/payments",MT,{"method":"card_demo","amount_cents":453,"brand":"Visa","last4":"4242"})[1]
before = api("GET","/api/finance/payouts?date=2026-09-25",MT)[1]
rf = api("POST",f"/api/payments/{pay['payment']['id']}/refund",MT,{"amount_cents":453})
want(rf, 200, "manager refund 200")
ok = rf[1]["payment"]["status"]=="refunded" and rf[1]["payment"]["refunded_cents"]==453
checks += 1
print(f"  {'✓' if ok else '✗'} refund status/refunded_cents"); 
if not ok: fails.append("FAIL manager refund fields")
after = api("GET","/api/finance/payouts?date=2026-09-25",MT)[1]
delta_ref = after["refunds_cents"]-before["refunds_cents"]
delta_exp = after["expected_payout_cents"]-before["expected_payout_cents"]
fee = round(0*0.026)+15  # net 0 after full refund -> fee 0; fee before = round(453*0.026)+15=27
checks += 1
exp_delta = -(453 - (round(453*0.026)+15 - 0))  # refund +453, fee drops 27 -> expected changes -(453-27) = -480... wait recompute
# before: vol includes 453, fees include 27 (round(453*0.026)=round(11.778)=12+15=27)
# after: vol includes 453, refunds +453, fees 0 for this payment
# expected = vol - refunds - fees: delta = -(453) + 27 = -426
exp_delta = -(453 - 27)
if delta_ref==453 and delta_exp==exp_delta:
    print(f"  ✓ refund updated finance: refunds +453, expected_payout {delta_exp} (want {exp_delta})")
else:
    fails.append(f"FAIL refund finance math: delta_ref={delta_ref} delta_exp={delta_exp} want 453/{exp_delta}")
    print(f"  ✗ refund finance math: delta_ref={delta_ref} delta_exp={delta_exp} want 453/{exp_delta}")
# cleanup: close the refunded check? It has balance 453 now (reopened). Pay cash + close.
p2 = api("POST",f"/api/checks/{chk['id']}/payments",MT,{"method":"cash","amount_cents":453,"tendered_cents":500})[1]
api("POST",f"/api/checks/{chk['id']}/close",MT)

print("-- route guessing --")
want(api("GET","/api/menu/admin",MT), 404, "GET /api/menu/admin -> 404 (not 403 leak)")
want(api("GET","/api/menu/admin",None), 401, "GET /api/menu/admin no token -> 401")
want(api("GET","/api/admin",MT), 404, "GET /api/admin -> 404")
want(api("GET","/api/checks/999999",MT), 404, "unknown check -> 404")

print(f"\nTest 2: {checks} assertions, {len(fails)} failures")
for f in fails: print(f)
sys.exit(1 if fails else 0)
