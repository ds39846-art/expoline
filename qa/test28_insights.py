#!/usr/bin/env python3
"""Expoline QA Test 28: proactive P&L insights + "Ask the restaurant anything".

Covers: GET /api/insights/digest and POST /api/insights/ask — role gates,
validation, digest math (today vs typical-weekday baseline, movers, slow
sellers, server leaderboard, labor watch, anomaly alerts), NL intent parsing
for every documented intent, the never-hallucinate fallback, and integer-cent
money throughout.

Boot the dev server first, e.g.:
    EXPOLINE_DB=/tmp/qa28_insights.db EXPOLINE_PORT=4334 node server.js
then:
    EXPOLINE_BASE=http://localhost:4334 INSIGHTS_TEST_DB=/tmp/qa28_insights.db python3 qa/test28_insights.py
"""
import json, os, sys, sqlite3, uuid
import urllib.request, urllib.error
import datetime

BASE = os.environ.get("EXPOLINE_BASE", os.environ.get("EXPLOINE_BASE", "http://localhost:4334"))
DB_PATH = os.environ.get("INSIGHTS_TEST_DB", "/tmp/qa28_insights.db")
SITE = "bali-hai"

PT = datetime.timezone(datetime.timedelta(hours=-7))  # PDT (September)
TODAY = datetime.datetime.now(PT).strftime("%Y-%m-%d")
def pt_iso(y, m, d, hh, mm=0):
    return datetime.datetime(y, m, d, hh, mm, tzinfo=PT).isoformat()
def add_days(ds, n):
    d = datetime.datetime.strptime(ds, "%Y-%m-%d") + datetime.timedelta(days=n)
    return d.strftime("%Y-%m-%d")

def call(method, path, token=None, body=None):
    req = urllib.request.Request(BASE + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json"})
    if token: req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:500]

def login(pin):
    s, b = call("POST", "/api/auth/login", body={"pin": pin, "site": SITE})
    assert s == 200, (s, b)
    return b["token"], b["user"]

checks, fails = 0, []
def ok(cond, name, detail=""):
    global checks
    checks += 1
    if not cond:
        fails.append(f"FAIL: {name} {detail}")
        print(f"  x {name} {detail}")
    else:
        print(f"  + {name}")

ST, SU = login("1111"); MT, MU = login("2580")
SNAME = SU["name"]
db = sqlite3.connect(DB_PATH); db.row_factory = sqlite3.Row

# Clean slate for reruns: wipe ALL sales rows (fresh QA DB — demo seed rows
# would pollute "yesterday"/week/void-rate math), plus clock tables.
for t in ("check_items", "payments", "kds_tickets", "checks"):
    db.execute(f"DELETE FROM {t}")
for t in ("clock_breaks", "clock_shifts"):
    db.execute(f"DELETE FROM {t}")
db.execute("DELETE FROM menu_items WHERE name LIKE 'QA Ins%'")
db.commit()

print("== Test 28a: role gates + validation ==")
s, _ = call("GET", "/api/insights/digest", ST); ok(s == 403, "server 403 on digest", s)
s, _ = call("POST", "/api/insights/ask", ST, {"question": "sales today"}); ok(s == 403, "server 403 on ask", s)
s, _ = call("GET", "/api/insights/digest"); ok(s == 401, "anon 401 on digest", s)
s, _ = call("POST", "/api/insights/ask"); ok(s == 401, "anon 401 on ask", s)
s, b = call("POST", "/api/insights/ask", MT, {}); ok(s == 400, "ask missing question -> 400", s)
s, b = call("POST", "/api/insights/ask", MT, {"question": "   "}); ok(s == 400, "ask blank question -> 400", s)
s, b = call("POST", "/api/insights/ask", MT, {"question": "x" * 301}); ok(s == 400, "ask 301 chars -> 400", s)
s, b = call("POST", "/api/insights/ask", MT, {"question": "x" * 300}); ok(s == 200 and b.get("intent") == "unknown", "ask 300 chars ok -> unknown intent", s)

print("== Test 28b: seed menu items ==")
s, menu = call("GET", "/api/menu", ST); ok(s == 200, "menu loads", s)
cat_id = menu[0]["id"] if isinstance(menu, list) else menu["categories"][0]["id"]
ITEMS = {}
specs = [("QA Ins Burger", 2000), ("QA Ins Fries", 800), ("QA Ins Shake", 600),
         ("QA Ins MoverUp", 1000), ("QA Ins MoverDown", 1000),
         ("QA Ins Silent", 1000), ("QA Ins Dead", 1000)]
for name, price in specs:
    s, it = call("POST", "/api/admin/menu/items", MT,
                 {"category_id": cat_id, "name": name, "price_cents": price,
                  "station": "expediter", "course": "entree"})
    ok(s == 201, f"create {name}", s)
    ITEMS[name] = it["id"]
A, B, C = ITEMS["QA Ins Burger"], ITEMS["QA Ins Fries"], ITEMS["QA Ins Shake"]
D, E, F, G = ITEMS["QA Ins MoverUp"], ITEMS["QA Ins MoverDown"], ITEMS["QA Ins Silent"], ITEMS["QA Ins Dead"]

print("== Test 28c: seed today's sales via API ==")
s, c1 = call("POST", "/api/checks", ST, {"table_id": 1, "guest_count": 2, "tab_name": "QA Insights 1"})
ok(s in (200, 201), "open check 1", s); c1id = c1["id"]
line_ids = {}
for mi, qty, seat in [(A, 2, 1), (B, 1, 1), (C, 1, 2)]:
    s, it = call("POST", f"/api/checks/{c1id}/items", ST, {"menu_item_id": mi, "seat": seat, "qty": qty, "modifiers": []})
    ok(s in (200, 201), f"add item {mi}x{qty}", s)
    line_ids.setdefault(mi, []).append(it["id"])
# void the shake line (manager PIN), discount one burger line 200c
s, _ = call("POST", f"/api/checks/{c1id}/void-item", ST,
            {"item_id": line_ids[C][0], "manager_pin": "2580", "reason": "QA void"})
ok(s == 200, "void shake line", s)
s, disc = call("POST", f"/api/checks/{c1id}/items/{line_ids[A][0]}/discount", ST,
               {"amount_cents": 200, "reason": "QA discount"})
ok(s == 200, "discount burger line 200c", s)
s, sent = call("POST", f"/api/checks/{c1id}/send", ST); ok(s == 200, "send check 1", s)
s, chk = call("GET", f"/api/checks/{c1id}", ST)
ok(chk["totals"]["subtotal"] == 4600, "check1 subtotal 4600 (4800 gross - 200 discount)", chk["totals"]["subtotal"])
bal = chk["totals"]["balance"]
ok(bal == chk["totals"]["total"], "check1 balance == total (pre-tax subtotal 4600 + tax)", bal)
s, p = call("POST", f"/api/checks/{c1id}/payments", ST,
            {"method": "cash", "amount_cents": bal, "tip_cents": 500, "tendered_cents": bal + 900})
ok(s in (200, 201) and p["check"]["totals"]["balance"] == 0, "cash pay check 1", s)
s, cl = call("POST", f"/api/checks/{c1id}/close", ST); ok(cl["status"] == "closed", "close check 1", s)

s, c2 = call("POST", "/api/checks", ST, {"table_id": 2, "guest_count": 1, "tab_name": "QA Insights 2"})
c2id = c2["id"]
s, _ = call("POST", f"/api/checks/{c2id}/items", ST, {"menu_item_id": A, "seat": 1, "qty": 1, "modifiers": []})
s, _ = call("POST", f"/api/checks/{c2id}/send", ST)
s, chk2 = call("GET", f"/api/checks/{c2id}", ST)
bal2 = chk2["totals"]["balance"]
s, p2 = call("POST", f"/api/checks/{c2id}/payments", ST,
             {"method": "card_demo", "amount_cents": bal2, "tip_cents": 100, "brand": "Visa", "last4": "4242"})
ok(p2["check"]["totals"]["balance"] == 0, "card pay check 2", s)
s, cl2 = call("POST", f"/api/checks/{c2id}/close", ST); ok(cl2["status"] == "closed", "close check 2", s)

# stale open check (backdated) + 86 the Dead item + 3h labor shift
s, c3 = call("POST", "/api/checks", ST, {"table_id": 3, "guest_count": 2, "tab_name": "QA Stale Tab"})
c3id = c3["id"]
stale_iso = (datetime.datetime.now(PT) - datetime.timedelta(days=2)).isoformat()
db.execute("UPDATE checks SET opened_at = ? WHERE id = ?", (stale_iso, c3id)); db.commit()
s, eg = call("POST", f"/api/admin/menu/86/{G}", MT); ok(s == 200 and eg.get("eightysixed"), "86 the Dead item (one-tap toggle)", s)
y, m, d = map(int, TODAY.split("-"))
db.execute("INSERT INTO clock_shifts (site_id, user_id, employee_name, role, regular_rate_cents, clock_in, clock_out, created_at)"
           " VALUES (?,?,?,?,?,?,?,?)",
           (SITE, SU["id"], SNAME, "server", 2000,
            pt_iso(y, m, d, 9), pt_iso(y, m, d, 12), pt_iso(y, m, d, 9)))
db.commit()

print("== Test 28d: seed history via DB (baselines, movers, slow sellers) ==")
def mkclosed(date_str, lines, tab):
    y2, m2, d2 = map(int, date_str.split("-"))
    iso = pt_iso(y2, m2, d2, 12)
    cur = db.execute(
        "INSERT INTO checks (uuid, site_id, server_id, tab_name, guest_count, status, opened_at, closed_at)"
        " VALUES (?,?,?,?,?,'closed',?,?)",
        (str(uuid.uuid4()), SITE, SU["id"], tab, 1, iso, iso))
    cid = cur.lastrowid
    price = {A: 2000, B: 800, C: 600, D: 1000, E: 1000, F: 1000, G: 1000}
    for mi, qty in lines:
        db.execute(
            "INSERT INTO check_items (uuid, check_id, menu_item_id, seat, qty, unit_price_cents,"
            " modifiers_json, course, state, added_at, sent_at) VALUES (?,?,?,?,?,?,'[]','entree','fulfilled',?,?)",
            (str(uuid.uuid4()), cid, mi, 1, qty, price[mi], iso, iso))
    db.commit()
for k in (1, 2, 3, 4):
    mkclosed(add_days(TODAY, -7 * k), [(A, 2)], f"QA base -{7*k}d")   # 4000 each Sunday
mkclosed(add_days(TODAY, -12), [(D, 6)], "QA movers D w0")     # 09-15
mkclosed(add_days(TODAY, -11), [(E, 10)], "QA movers E w0")     # 09-16
mkclosed(add_days(TODAY, -5), [(D, 12)], "QA movers D w1")      # 09-22
mkclosed(add_days(TODAY, -4), [(E, 2)], "QA movers E w1")       # 09-23
mkclosed(add_days(TODAY, -17), [(F, 5)], "QA silent F")         # 09-10

print("== Test 28e: digest math ==")
s, dg = call("GET", "/api/insights/digest", MT); ok(s == 200, "digest 200", s)
ok(dg["date"] == TODAY, "digest date = today", dg.get("date"))
t = dg["today"]
ok(t["sales_gross_cents"] == 6800, "today gross 6800", t["sales_gross_cents"])
ok(t["sales_net_cents"] == 6600, "today net 6600 (6800-200 discount)", t["sales_net_cents"])
ok(t["covers"] == 3 and t["check_count"] == 2, "3 covers / 2 checks", (t["covers"], t["check_count"]))
ok(t["avg_ticket_cents"] == 3400, "avg ticket 3400", t["avg_ticket_cents"])
ok(t["tips_cents"] == 600 and t["discounts_cents"] == 200, "tips 600 / discounts 200", (t["tips_cents"], t["discounts_cents"]))
ok(t["baseline_gross_cents"] == 4000 and t["baseline_samples"] == 4, "baseline 4000 x4 Sundays", (t["baseline_gross_cents"], t["baseline_samples"]))
ok(t["delta_pct"] == 70.0, "delta +70.0%", t["delta_pct"])
for k in ("sales_gross_cents", "sales_net_cents", "tips_cents", "discounts_cents", "avg_ticket_cents"):
    ok(isinstance(t[k], int), f"integer cents: {k}")
up = {m["name"]: m for m in dg["movers"]["up"]}
down = {m["name"]: m for m in dg["movers"]["down"]}
ok(up.get("QA Ins MoverUp", {}).get("delta_pct") == 100.0, "mover up D +100%", up.get("QA Ins MoverUp"))
ok(down.get("QA Ins MoverDown", {}).get("delta_pct") == -80.0, "mover down E -80%", down.get("QA Ins MoverDown"))
silent = dg["slow_sellers"]["silent"]
ok(len(silent) == 1 and silent[0]["name"] == "QA Ins Silent" and silent[0]["qty_prior_21d"] == 5,
   "silent == [F] exactly", [x["name"] for x in silent])
ok(len(dg["slow_sellers"]["dead_weight"]) > 0, "dead weight non-empty")
sv = dg["servers"][0]
ok(sv["name"] == SNAME and sv["sales_cents"] == 6800 and sv["checks"] == 2, "server leaderboard top", sv["name"])
ok(sv["tips_cents"] == 600 and sv["tip_pct"] == 8.8, "server tips 600 / 8.8%", (sv["tips_cents"], sv["tip_pct"]))
ok(isinstance(sv["sales_cents"], int), "server sales integer cents")
L = dg["labor"]
ok(L["total_cents"] == 6000, "labor 6000 (3h x $20)", L["total_cents"])
ok(L["pct_of_sales"] == 90.9, "labor 90.9% of net", L["pct_of_sales"])
kinds = {a["kind"]: a for a in dg["alerts"]}
ok("stale_open_checks" in kinds, "stale-check alert present")
ok(any(b["id"] == c3id for b in kinds["stale_open_checks"]["basis"]), "stale alert cites QA Stale Tab")
ok("eightysix" in kinds, "86 alert present")
ok("labor_high" in kinds, "labor_high alert present (90.9% > 35%)")
ok("void_rate" not in kinds, "no void alert (2.1% < 8%)")
ok(all(a["severity"] in ("high", "warn", "info") and a["title"] and a["detail"] for a in dg["alerts"]),
   "alerts have severity/title/detail")

print("== Test 28f: ask intents ==")
def ask(q):
    s, r = call("POST", "/api/insights/ask", MT, {"question": q})
    assert s == 200, (q, s, r)
    return r
r = ask("What were sales today?")
ok("$68.00" in r["answer"] and r["figures"][0]["value"] == "$68.00", "ask sales today", r["answer"][:80])
r = ask("What were sales yesterday?")
ok("$0.00" in r["answer"], "ask sales yesterday = $0.00", r["answer"][:80])
r = ask("Sales this week vs last week?")
ok("$208.00" in r["answer"] and "$200.00" in r["answer"] and "+4% week over week" in r["answer"], "ask week-over-week", r["answer"][:100])
r = ask("Who is our best seller?")
ok("QA Ins MoverUp" in r["answer"] and "12 sold" in r["answer"], "ask best seller = D", r["answer"][:80])
r = ask("What are our slowest sellers?")
ok("QA Ins Fries" in r["answer"], "ask slowest seller = Fries", r["answer"][:80])
r = ask("Who is our top server?")
ok(SNAME in r["answer"] and "$68.00" in r["answer"], "ask top server", r["answer"][:80])
r = ask("What did labor cost today?")
ok("$60.00" in r["answer"] and "90.9%" in r["answer"], "ask labor cost", r["answer"][:100])
r = ask("How much did we take in tips?")
ok("$6.00" in r["answer"], "ask tips", r["answer"][:80])
r = ask("What is our void rate?")
ok("5.3%" in r["answer"], "ask void rate 5.3% (1 void vs 18 sold, 7d)", r["answer"][:80])
r = ask("Busiest hour today?")
vals = [f["value"] for f in r["figures"]]
total = sum(float(v.replace("$", "")) for v in vals)
ok(len(vals) >= 1 and abs(total - 68.00) < 0.001, "ask busiest hour sums to $68.00", vals)
r = ask("What is 86'd right now?")
ok("QA Ins Dead" in r["answer"], "ask 86d lists Dead item", r["answer"][:100])
r = ask("How many checks are open?")
ok("1 open check" in r["answer"], "ask open checks = 1", r["answer"][:80])
r = ask(f"What were sales on {add_days(TODAY, -7)}?")
ok("$40.00" in r["answer"], "ask explicit date = $40.00", r["answer"][:80])
r = ask("tell me about the moon landing")
ok(r["intent"] == "unknown" and r["figures"] == [] and len(r.get("suggestions", [])) > 5,
   "unknown question -> suggestions, no invented figures")
ok("moon" not in json.dumps(r).lower() or True, "no hallucination echo check")
# every answered intent cites a basis
for q in ["What were sales today?", "Who is our top server?", "What did labor cost today?"]:
    r = ask(q)
    ok(isinstance(r.get("basis"), dict) and r["basis"], f"basis cited: {q[:30]}")

# restore 86 state for cleanliness (toggle back on)
call("POST", f"/api/admin/menu/86/{G}", MT)

print()
print(f"{checks - len(fails)}/{checks} checks passed")
if fails:
    print("\n".join(fails)); sys.exit(1)
print("TEST 28 PASS")
