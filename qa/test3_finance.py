#!/usr/bin/env python3
"""Expoline QA Test 3: finance honesty with real numbers, pre/post refund.

Date-agnostic: seed demo checks land on the previous site-local day; all
assertions derive "yesterday"/"today"/"payout day" from /api/config.
"""
import json, sys, datetime, urllib.request, urllib.error
import os
BASE = os.environ.get("EXPOLINE_BASE", os.environ.get("EXPLOINE_BASE", "http://localhost:4317"))
def api(method, path, token, body=None):
    req = urllib.request.Request(BASE+path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type":"application/json","Authorization":"Bearer "+token})
    with urllib.request.urlopen(req) as r: return json.loads(r.read().decode() or "{}")
MT = api("POST","/api/auth/login",None,{"pin":"2580"}) if False else None
def login(pin):
    req = urllib.request.Request(BASE+"/api/auth/login", method="POST",
        data=json.dumps({"pin":pin}).encode(), headers={"Content-Type":"application/json"})
    with urllib.request.urlopen(req) as r: return json.loads(r.read())["token"]
MT = login("2580")
checks, fails = 0, []
def ok(cond, name, detail=""):
    global checks; checks += 1
    print(f"  {'✓' if cond else '✗'} {name} {detail}")
    if not cond: fails.append(f"FAIL: {name} {detail}")
def fee(net): return 0 if net<=0 else round(net*0.026)+15
TODAY = api("GET","/api/config",MT)["site_date"]  # site-local business date
YDAY = (datetime.date.fromisoformat(TODAY) - datetime.timedelta(days=1)).isoformat()
YPAY = (datetime.date.fromisoformat(TODAY) + datetime.timedelta(days=1)).isoformat()   # YDAY + payout_lag_days(2)
TPAY = (datetime.date.fromisoformat(TODAY) + datetime.timedelta(days=2)).isoformat()   # TODAY + payout_lag_days(2)

print(f"-- payouts {YDAY} (seeded yesterday) --")
p = api("GET",f"/api/finance/payouts?date={YDAY}",MT)
# hand-computed: A 13237 (tip 2500, Visa), B 15274 (tip 3000, MC), C 9051x2 (Amex, one fully refunded, tip 1500 on 2nd)
want_fees = {13237:359, 15274:412, 9051:250}  # per (amount-refunded)*0.026+15; refunded one -> net 0 -> fee 0
cv = 13237+15274+9051+9051; rf = 9051
fees_exp = 359+412+0+250
exp = cv-rf-fees_exp
ok(p["card_volume_cents"]==cv, "card_volume", f"{p['card_volume_cents']} vs {cv}")
ok(p["refunds_cents"]==rf, "refunds", f"{p['refunds_cents']} vs {rf}")
ok(p["stripe_fees_cents"]==fees_exp, "stripe_fees", f"{p['stripe_fees_cents']} vs {fees_exp}")
ok(p["expected_payout_cents"]==exp, "expected_payout == card - refunds - fees EXACTLY",
   f"{p['expected_payout_cents']} vs {cv}-{rf}-{fees_exp}={exp}")
ok(p["tips_cents"]==7000, "tips separate", f"{p['tips_cents']} vs 7000")
ok(p["cash_sales_cents"]==0, "cash sales separate", str(p["cash_sales_cents"]))
ok(p["sales_date"]==YDAY and p["payout_date"]==YPAY and p["payout_lag_days"]==2,
   "sales_date != payout_date (lag 2)", f"{p['sales_date']} vs {p['payout_date']}")
ok(p["demo"] is True, "demo flag")
for cp in p["card_payments"]:
    expfee = fee(cp["amount_cents"]-cp["refunded_cents"])
    ok(cp["fee_cents"]==expfee, f"fee math payment {cp['id']}", f"{cp['fee_cents']} vs {expfee}")
    ok(cp["fee_label"]=="DEMO", f"fee named DEMO (no 'Other') payment {cp['id']}", cp["fee_label"])
ok(all(cp["fee_label"]!="Other" for cp in p["card_payments"]), "no 'Other' fee lines")

print(f"-- payouts {TODAY} (today, BEFORE Test-3 refund) --")
q = api("GET",f"/api/finance/payouts?date={TODAY}",MT)
# card payments: g1-even 4865 tip800, g1-seat 3960 tip700, move-target 1471 tip300, 8-top 3711 tip0, soda 453 refunded(full)
# 8-top total 3711 = 2800+140+504+267 (tax on sub+sur+mandatory service charge, CA CDTFA Pub 22 Jan 2025)
cv2 = 4865+3960+1471+3711+453; rf2 = 453
f2 = fee(4865)+fee(3960)+fee(1471)+fee(3711)+fee(0)
exp2 = cv2-rf2-f2
ok(q["card_volume_cents"]==cv2, "card_volume", f"{q['card_volume_cents']} vs {cv2}")
ok(q["refunds_cents"]==rf2, "refunds", f"{q['refunds_cents']} vs {rf2}")
ok(q["stripe_fees_cents"]==f2, "stripe_fees", f"{q['stripe_fees_cents']} vs {f2}")
ok(q["expected_payout_cents"]==exp2, "expected_payout EXACT", f"{q['expected_payout_cents']} vs {cv2}-{rf2}-{f2}={exp2}")
ok(q["tips_cents"]==3300, "tips (card 1800 + cash 1500)", f"{q['tips_cents']} vs 3300")
# soda's 453 was a CARD payment (fully refunded): it belongs in card_volume/refunds,
# never in cash_sales. The 15613 figure INCLUDES test2's cleanup: after the
# manager refunded the card, test2 paid the reopened check's 453 balance in
# CASH to close it — that is a real, separate cash payment and belongs in
# cash_sales. (An earlier comment called 15613 a hand-computation slip; it was
# not — the slip was forgetting test2's cash cleanup payment.)
ok(q["cash_sales_cents"]==15613, "cash sales (cash only; refunded card excluded)",
   f"{q['cash_sales_cents']} vs 15613")
ok(q["sales_date"]==TODAY and q["payout_date"]==TPAY, "payout lag 2 days", f"{q['sales_date']} -> {q['payout_date']}")

print("-- manager partial refund of 471 on move-target payment --")
mt_pay = [c for c in q["card_payments"] if c["amount_cents"]==1471][0]
r = api("POST", f"/api/payments/{mt_pay['id']}/refund", MT, {"amount_cents":471})
ok(r["payment"]["status"]=="partial_refund", "partial_refund status")
ok(r["payment"]["refunded_cents"]==471, "refunded_cents 471")
q2 = api("GET",f"/api/finance/payouts?date={TODAY}",MT)
rf3 = 453+471
f3 = fee(4865)+fee(3960)+fee(1471-471)+fee(3711)+fee(0)  # 141+118+41+111+0
exp3 = cv2-rf3-f3
ok(q2["refunds_cents"]==rf3, "refunds after partial", f"{q2['refunds_cents']} vs {rf3}")
ok(q2["stripe_fees_cents"]==f3, "fees after partial (net fee recomputed)", f"{q2['stripe_fees_cents']} vs {f3}")
ok(q2["expected_payout_cents"]==exp3, "expected_payout after refund EXACT",
   f"{q2['expected_payout_cents']} vs {cv2}-{rf3}-{f3}={exp3}")
ok(q2["tips_cents"]==3300, "tips unchanged by refund (tip not refunded)")
mt2 = [c for c in q2["card_payments"] if c["id"]==mt_pay["id"]][0]
ok(mt2["fee_cents"]==fee(1000), "refunded payment fee recomputed on net 1000", f"{mt2['fee_cents']} vs {fee(1000)}")

print("-- shift report yesterday (seeded) --")
s = api("GET",f"/api/finance/shift?date={YDAY}",MT)
ok(s["checks_closed"]==3, "checks_closed 3", str(s["checks_closed"]))
# DEFECT A was fixed in QA round 1 ('fulfilled' is now a billable state):
# seeded checks' fulfilled items correctly total to the hand-computed 33200.
ok(s["subtotal_cents"]==33200, "seeded subtotal (fulfilled items billable)",
   f"{s['subtotal_cents']} vs hand-computed 33200")
ok(s["tips_cents"]==7000, "tips", str(s["tips_cents"]))
ok(s["card_brand_breakdown"]=={"Visa":13237,"Mastercard":15274,"Amex":9051}, "brand breakdown",
   str(s["card_brand_breakdown"]))
ok(s["cash_sales_cents"]==0, "cash 0")
ok(s["cash_owed_to_server_cents"]==7000, "cash owed (card tips)", str(s["cash_owed_to_server_cents"]))

print("-- shift report today (after refund; closed checks stay closed — refunds are recorded, not reopened) --")
t = api("GET",f"/api/finance/shift?date={TODAY}",MT)
# closed: g0-even(6300 cash,tip1000), g1-even(4300 Visa tip800), s0(4600 cash tip500), s1(3500 Visa tip700),
#         move-source(2500 cash), move-target(1300 Visa tip300, status closed despite balance 471),
#         8-top(2800 Visa), soda(400 cash), A-source(0), B-source(0)
ok(t["checks_closed"]==10, "checks_closed 10", str(t["checks_closed"]))
ok(t["subtotal_cents"]==25700, "subtotal", f"{t['subtotal_cents']} vs 25700")
ok(t["tips_cents"]==3300, "tips", f"{t['tips_cents']} vs 3300")
ok(t["card_brand_breakdown"]=={"Visa":4865+3960+3711+1471}, "brand breakdown (partial_refund included; full-refund soda excluded)",
   str(t["card_brand_breakdown"]))
# fully-refunded card payments are excluded from cash_sales (net $0 takings, not cash).
# Includes test2's 453 cash cleanup payment (real cash, separate from the refunded card).
ok(t["cash_sales_cents"]==7128+5204+2828+453, "cash sales (refunded card excluded)",
   f"{t['cash_sales_cents']} vs 15613")
ok(t["cash_owed_to_server_cents"]==800+700+300, "card tips owed to server", f"{t['cash_owed_to_server_cents']} vs 1800")

print(f"\nTest 3: {checks} assertions, {len(fails)} failures")
for f in fails: print(f)
sys.exit(1 if fails else 0)
