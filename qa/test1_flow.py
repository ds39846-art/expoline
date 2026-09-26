#!/usr/bin/env python3
"""Expoline MVP v0.1 — QA Test 1: full user flow with hand-computed money assertions."""
import json, sys, urllib.request, urllib.error
import os

BASE = os.environ.get("EXPOLINE_BASE", os.environ.get("EXPLOINE_BASE", "http://localhost:4317"))
S = "1111"; K = "2222"; M = "2580"

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
        print(f"  ✗ {name} {detail}")
    else:
        print(f"  ✓ {name}")

def expect_status(method, path, token, body, want, name):
    st, txt = api(method, path, token, body, raw=True)
    ok(st == want, name, f"(got {st} {txt[:120]})")
    return st, txt

# Money math helpers (mirror of the documented business rules — hand computed).
# CA: the mandatory service charge IS part of the taxable sale (CDTFA Pub 22,
# Jan 2025; Annotation 550.0740), so tax = round((sub + sur + svc) * 0.0775).
def line(qty, unit, mods=()): return qty*unit + qty*sum(mods)
def totals(sub, guests):
    sur = round(sub*0.05)
    svc = round(sub*0.18) if guests >= 8 else 0
    tax = round((sub+sur+svc)*0.0775)
    return {"subtotal":sub,"surcharge":sur,"service_charge":svc,"tax":tax,"total":sub+sur+svc+tax}
def assert_totals(check, exp, name, guests=0):
    ok(check["subtotal_cents"]==exp["subtotal"], name+" subtotal", f"got {check['subtotal_cents']} want {exp['subtotal']}")
    ok(check["surcharge_cents"]==exp["surcharge"], name+" surcharge", f"got {check['surcharge_cents']} want {exp['surcharge']}")
    ok(check["service_charge_cents"]==exp["service_charge"], name+" service_charge", f"got {check['service_charge_cents']} want {exp['service_charge']}")
    ok(check["tax_cents"]==exp["tax"], name+" tax", f"got {check['tax_cents']} want {exp['tax']}")
    ok(check["total_cents"]==exp["total"], name+" total", f"got {check['total_cents']} want {exp['total']}")

print("== Test 1a: seat party, order w/ modifiers, HELD state, SEND, KDS ==")
c1 = api("POST","/api/checks",ST,{"table_id":1,"guest_count":4,"tab_name":"QA flow A"})
ok(c1["status"]=="open", "check A opened", str(c1["id"]))
items = [
    ("BH Mai Tai", 69, 1, 2, []),
    ("Cheese Burger", 14, 1, 1, [{"name":"Add bacon","price_delta_cents":300}]),
    ("Local Greens", 7, 2, 1, [{"name":"Add chicken","price_delta_cents":900}]),
    ("Creme Brulee", 55, 3, 1, []),
    ("Tuna Poke", 2, 4, 1, []),
]
exp_lines = {"BH Mai Tai":2900,"Cheese Burger":2100,"Local Greens":2200,"Creme Brulee":1300,"Tuna Poke":2100}
added = {}
for label, mid, seat, qty, mods in items:
    it = api("POST", f"/api/checks/{c1['id']}/items", ST,
             {"menu_item_id":mid,"seat":seat,"qty":qty,"modifiers":mods})
    added[label] = it["id"]
    ok(it["state"]=="held", f"{label} held state", str(it["state"]))
    ok(it["line_total_cents"]==exp_lines[label], f"{label} line total", f"got {it['line_total_cents']} want {exp_lines[label]}")
c1g = api("GET", f"/api/checks/{c1['id']}", ST)
ok(all(i["state"]=="held" for i in c1g["items"]), "all items HELD before send")
expA = totals(10600, 4)  # sub 10600 sur 530 svc 0 tax 863 total 11993
print("  hand-computed A:", expA)
assert_totals(c1g, expA, "check A pre-send")

sent = api("POST", f"/api/checks/{c1['id']}/send", ST)
ok(sent["sent"]==5, "send count 5", str(sent["sent"]))
by_st = {t["station"]: t for t in sent["tickets"]}
ok(set(by_st)== {"bar","expediter","garde_manger","dessert"}, "one ticket per station", str(set(by_st)))
ok(any(i["name"]=="BH Mai Tai" for i in by_st["bar"]["items"]), "bar ticket has BH Mai Tai")
ok(len(by_st["bar"]["items"])==1, "bar ticket ONLY drinks (no food leakage)")
ok(set(i["name"] for i in by_st["expediter"]["items"])=={"The Cheese Burger","Tuna Poke"}, "expediter items")
ok(by_st["garde_manger"]["items"][0]["name"]=="Local Greens", "garde_manger salad")
ok(by_st["dessert"]["items"][0]["name"]=="Chocolate Creme Brulee", "dessert item")
ok(all(t["status"]=="new" for t in sent["tickets"]), "tickets start status new")
c1g2 = api("GET", f"/api/checks/{c1['id']}", ST)
ok(all(i["state"]=="sent" for i in c1g2["items"]), "items sent after send")

# kitchen bump lifecycle with kitchen token
kids = api("GET","/api/kds/tickets",KT)
mine = [t for t in kids if t["check_id"]==c1["id"]]
ok(len(mine)==4, "kitchen sees 4 open tickets for check A")
for t in mine:
    b = api("POST", f"/api/kds/tickets/{t['id']}/bump", KT, {"status":"in_progress"})
    ok(b["status"]=="in_progress", f"ticket {t['id']} in_progress")
    b = api("POST", f"/api/kds/tickets/{t['id']}/bump", KT, {"status":"fulfilled"})
    ok(b["status"]=="fulfilled", f"ticket {t['id']} fulfilled")
    ok(b["bumped_by"] is not None, f"ticket {t['id']} bumped_by set")
rec = api("GET","/api/kds/recall",KT)
ok(len([t for t in rec if t["check_id"]==c1["id"]])==4, "recall shows 4 fulfilled tickets")
assert_totals(api("GET", f"/api/checks/{c1['id']}", ST), expA, "check A totals unchanged post-send")

print("== Test 1b: even split — totals must sum to original ==")
sp = api("POST", f"/api/checks/{c1['id']}/split", ST, {"mode":"even","parts":2})
ok(len(sp["checks"])==2, "even split produced 2 checks")
# sorted lines desc: 2900,2200,2100,2100,1300 -> g0=[2900,2100,1300]=6300 g1=[2200,2100]=4300
expG0 = totals(6300, 3)  # 6300+315+513 = 7128
expG1 = totals(4300, 2)  # 4300+215+350 = 4865
print("  hand-computed g0:", expG0, " g1:", expG1)
g0 = api("GET", f"/api/checks/{sp['checks'][0]}", ST)
g1 = api("GET", f"/api/checks/{sp['checks'][1]}", ST)
assert_totals(g0, expG0, "even-split g0")
assert_totals(g1, expG1, "even-split g1")
ok(expG0["total"]+expG1["total"]==expA["total"], "even-split totals sum to original",
   f"{expG0['total']}+{expG1['total']}={expG0['total']+expG1['total']} vs {expA['total']}")
src = api("GET", f"/api/checks/{c1['id']}", ST)
ok(src["status"]=="closed", "emptied source check auto-closed", str(src["status"]))

print("== Test 1c: split-by-seat ==")
c2 = api("POST","/api/checks",ST,{"table_id":2,"guest_count":3,"tab_name":"QA flow B"})
api("POST", f"/api/checks/{c2['id']}/items", ST, {"menu_item_id":72,"seat":1,"qty":1,"modifiers":[]})   # Aloha Kiss 1400 bar
api("POST", f"/api/checks/{c2['id']}/items", ST, {"menu_item_id":10,"seat":1,"qty":1,"modifiers":[{"name":"Add salmon","price_delta_cents":1300}]})  # Cashew 3200 gm
api("POST", f"/api/checks/{c2['id']}/items", ST, {"menu_item_id":37,"seat":2,"qty":1,"modifiers":[]})  # KFC 2400 exp
api("POST", f"/api/checks/{c2['id']}/items", ST, {"menu_item_id":79,"seat":3,"qty":1,"modifiers":[]})  # Woodford 1100 bar
expB = totals(8100, 3)  # 8100+405+659 = 9164
assert_totals(api("GET", f"/api/checks/{c2['id']}", ST), expB, "check B pre-send")
s2 = api("POST", f"/api/checks/{c2['id']}/send", ST)
ok(len(s2["tickets"])==3, "check B: 3 stations (bar,garde_manger,expediter)")
ok(any(i["name"]=="Woodford Reserve" for t in s2["tickets"] if t["station"]=="bar" for i in t["items"]), "bar ticket carries Woodford alongside food sent at once")
sp2 = api("POST", f"/api/checks/{c2['id']}/split", ST, {"mode":"by_seat","groups":[[1],[2,3]]})
expS0 = totals(4600, 1)  # 4600+230+374 = 5204
expS1 = totals(3500, 2)  # 3500+175+285 = 3960
s0 = api("GET", f"/api/checks/{sp2['checks'][0]}", ST)
s1 = api("GET", f"/api/checks/{sp2['checks'][1]}", ST)
assert_totals(s0, expS0, "by-seat g0 (seat 1)")
assert_totals(s1, expS1, "by-seat g1 (seats 2+3)")
ok(expS0["total"]+expS1["total"]==expB["total"], "by-seat totals sum to original")

print("== Test 1d: move-items-to-new-check ==")
c3 = api("POST","/api/checks",ST,{"table_id":3,"guest_count":2,"tab_name":"QA flow C"})
salmon = api("POST", f"/api/checks/{c3['id']}/items", ST, {"menu_item_id":18,"seat":1,"qty":1,"modifiers":[]})
harpoon = api("POST", f"/api/checks/{c3['id']}/items", ST, {"menu_item_id":70,"seat":2,"qty":1,"modifiers":[]})
expC = totals(3800, 2)  # 3800+190+309 = 4299
assert_totals(api("GET", f"/api/checks/{c3['id']}", ST), expC, "check C pre-move")
api("POST", f"/api/checks/{c3['id']}/send", ST)
mv = api("POST", f"/api/checks/{c3['id']}/split", ST, {"mode":"move","item_ids":[harpoon["id"]],"target":"new"})
ncid = mv["checks"][0]
expMT = totals(1300, 1)  # 1300+65+106 = 1471
expMS = totals(2500, 1)  # 2500+125+203 = 2828
assert_totals(api("GET", f"/api/checks/{ncid}", ST), expMT, "move-target (Harpoon)")
assert_totals(api("GET", f"/api/checks/{c3['id']}", ST), expMS, "move-source (Salmon)")
ok(expMT["total"]+expMS["total"]==expC["total"], "move totals sum to original")

print("== Test 1e: 8-top — service charge appears; split rejected ==")
c8 = api("POST","/api/checks",ST,{"table_id":4,"guest_count":8,"tab_name":"QA 8-top"})
api("POST", f"/api/checks/{c8['id']}/items", ST, {"menu_item_id":71,"seat":1,"qty":2,"modifiers":[]})  # Lava Slide 2x1400
exp8 = totals(2800, 8)  # 2800+140+504+267 = 3711 (tax on sub+sur+svc per CDTFA)
c8g = api("GET", f"/api/checks/{c8['id']}", ST)
assert_totals(c8g, exp8, "8-top check")
ok(c8g["service_charge_cents"]==504, "18% service charge present on 8-top")
expect_status("POST", f"/api/checks/{c8['id']}/split", ST, {"mode":"even","parts":2}, 400, "8-top even split rejected 400")
expect_status("POST", f"/api/checks/{c8['id']}/split", ST, {"mode":"by_seat","groups":[[1],[2]]}, 400, "8-top by_seat split rejected 400")
api("POST", f"/api/checks/{c8['id']}/send", ST)

print("== Test 1f: payments — CASH change, card_demo approval, close ==")
# cash on even-split g0: total 7128, tip 1000, tendered 9000 -> change 872
# (change nets the tip: 9000-7128-1000. The old 1872 expectation returned the
# tip as change, contradicting the cash modal's own "tendered - due" display.)
p = api("POST", f"/api/checks/{g0['id']}/payments", ST,
        {"method":"cash","amount_cents":7128,"tip_cents":1000,"tendered_cents":9000})
ok(p["change_cents"]==872, "cash change = tendered-amount-tip", f"got {p['change_cents']} want 872")
ok(p["check"]["totals"]["balance"]==0, "balance 0 after cash pay")
cl = api("POST", f"/api/checks/{g0['id']}/close", ST)
ok(cl["status"]=="closed" and cl["totals"]["balance"]==0, "cash check closed, balance 0")
# card on even-split g1: total 4865, tip 800 -> demo approval + auth_code
p = api("POST", f"/api/checks/{g1['id']}/payments", ST,
        {"method":"card_demo","amount_cents":4865,"tip_cents":800,"brand":"Visa","last4":"4242"})
ok(p["demo"]["approved"] is True, "card_demo approved true")
ok(str(p["demo"]["auth_code"]).startswith("DEMO"), "card_demo auth_code DEMO*", str(p["demo"]["auth_code"]))
ok(p["check"]["status"]=="paid" and p["check"]["totals"]["balance"]==0, "paid, balance 0")
cl = api("POST", f"/api/checks/{g1['id']}/close", ST)
ok(cl["status"]=="closed", "card check closed")
# by-seat g0 cash: 5204, tip 500, tendered 6000 -> change 296 (6000-5204-500)
p = api("POST", f"/api/checks/{s0['id']}/payments", ST,
        {"method":"cash","amount_cents":5204,"tip_cents":500,"tendered_cents":6000})
ok(p["change_cents"]==296, "by-seat cash change 296")
api("POST", f"/api/checks/{s0['id']}/close", ST)
# by-seat g1 card: 3960, tip 700
p = api("POST", f"/api/checks/{s1['id']}/payments", ST,
        {"method":"card_demo","amount_cents":3960,"tip_cents":700,"brand":"Visa","last4":"4242"})
ok(p["demo"]["approved"] is True, "by-seat card approved")
api("POST", f"/api/checks/{s1['id']}/close", ST)
# move-source salmon cash: 2828, tendered 3000 -> change 172
p = api("POST", f"/api/checks/{c3['id']}/payments", ST,
        {"method":"cash","amount_cents":2828,"tendered_cents":3000})
ok(p["change_cents"]==172, "move-source cash change 172")
api("POST", f"/api/checks/{c3['id']}/close", ST)
# move-target harpoon card: 1471, tip 300 (kept open for refund test later)
p = api("POST", f"/api/checks/{ncid}/payments", ST,
        {"method":"card_demo","amount_cents":1471,"tip_cents":300,"brand":"Visa","last4":"4242"})
ok(p["demo"]["approved"] is True, "move-target card approved")
ok(p["payment"]["auth_code"].startswith("DEMO"), "payment row auth_code")
move_target_pay_id = p["payment"]["id"]
api("POST", f"/api/checks/{ncid}/close", ST)
# 8-top card: 3711, tip 0
p = api("POST", f"/api/checks/{c8['id']}/payments", ST,
        {"method":"card_demo","amount_cents":3711,"brand":"Visa","last4":"4242"})
api("POST", f"/api/checks/{c8['id']}/close", ST)
print("MOVE_TARGET_CHECK=", ncid, " MOVE_TARGET_PAY=", move_target_pay_id)

print(f"\nTest 1: {checks} assertions, {len(fails)} failures")
for f in fails: print(f)
sys.exit(1 if fails else 0)
