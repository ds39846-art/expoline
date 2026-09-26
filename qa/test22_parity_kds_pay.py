#!/usr/bin/env python3
"""test22_parity_kds_pay.py — QA for Phase 3B (competitor parity: KDS + payments).

Boots its OWN scratch server (port 4326 ONLY, fresh DB) from this repo copy.
Covers all six MISSING parity-matrix categories:

  C. KDS ticket timers & aging alerts (alerts fire BEFORE breach)
  C. Course-status headers on KDS tickets
  D. Tip-outs / tip pooling (rules as data, auto-computed at shift review)
  D. QR guest self order & pay (local server, cash + demo tender, reader-ready)
  D. Guest self-split (staff keep override)
  E. Delivery-order aggregation (same single KDS queue)

Money: every *_cents asserted to be a whole integer; hand-computed totals.
"""
import json, os, signal, subprocess, sys, time, urllib.request, urllib.error

PORT = "4326"
BASE = "http://localhost:" + PORT
HERE = os.path.dirname(os.path.abspath(__file__))
SRV_DIR = os.path.dirname(HERE)          # this repo copy (/tmp/expoline-parity-kds)
DB = os.path.join(SRV_DIR, "db", "test22.db")

passed, failed = [], []

def check(name, cond, detail=""):
    (passed if cond else failed).append(name)
    print(("PASS " if cond else "FAIL ") + name + (f" [{detail}]" if detail and not cond else ""))

def call(method, path, token=None, body=None):
    req = urllib.request.Request(BASE + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json", **({"Authorization": "Bearer " + token} if token else {})})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:600]

def login(pin):
    s, b = call("POST", "/api/auth/login", body={"pin": pin})
    assert s == 200, (s, b)
    return b["token"]

def wait_up(timeout=30):
    for _ in range(int(timeout * 2)):
        try:
            s, _ = call("GET", "/api/health")
            if s == 200:
                return True
        except Exception:
            pass
        time.sleep(0.5)
    return False

def restart_server(fresh_db=False):
    """Restart ONLY the 4326 scratch server (never 4317/4320). DB survives unless fresh_db."""
    subprocess.run(f"lsof -ti:{PORT} | xargs kill -9 2>/dev/null", shell=True)
    time.sleep(1.5)
    if fresh_db and os.path.exists(DB):
        os.remove(DB)
    env = dict(os.environ, EXPOLINE_PORT=PORT, EXPOLINE_DB=DB,
               NODE_PATH="/home/hatch/workspace/goals/expo-line-pos-beat-toast-spoton-pilot-at-bali-hai/build/expoline/node_modules")
    subprocess.Popen(["node", "server.js"], cwd=SRV_DIR, env=env,
                     stdout=open("/tmp/test22_boot.log", "a"), stderr=subprocess.STDOUT,
                     start_new_session=True)
    assert wait_up(), "4326 scratch server did not come up"

def cents_ints(obj, where):
    """Every *_cents value in a JSON payload must be a whole integer."""
    bad = []
    def walk(o):
        if isinstance(o, dict):
            for k, v in o.items():
                if k.endswith("_cents") or k.endswith("cents"):
                    if v is None:
                        continue  # nullable cents fields (e.g. tendered_cents on card) are fine
                    if not isinstance(v, int) or isinstance(v, bool):
                        bad.append(f"{k}={v!r}")
                walk(v)
        elif isinstance(o, list):
            for x in o:
                walk(x)
    walk(obj)
    check(f"integer-cents money ({where})", not bad, "; ".join(bad[:5]))

AUTH = {}
def relogin():
    AUTH["st"] = login("1111")   # server
    AUTH["kt"] = login("2222")   # kitchen
    AUTH["mt"] = login("2580")   # manager

def jround(x):  # JS Math.round semantics for positive values
    import math
    return int(math.floor(x + 0.5))

def mk_check(token, table_id=1, guests=4, name="T22"):
    s, b = call("POST", "/api/checks", token, {"table_id": table_id, "guest_count": guests, "tab_name": name})
    assert s == 201, (s, b)
    return b["id"]

def add_item(token, check_id, menu_item_id, seat=1, qty=1):
    s, b = call("POST", f"/api/checks/{check_id}/items", token,
                {"menu_item_id": menu_item_id, "seat": seat, "qty": qty})
    assert s == 201, (s, b)
    return b

def table_qr(token, table_id=1):
    s, b = call("GET", f"/api/tables/{table_id}/qr", token)
    assert s == 200, (s, b)
    return b["token"]

# ================================================================ boot
print("--- boot: fresh DB on 4326 ---")
restart_server(fresh_db=True)
relogin()
check("server booted with migrations", True)

# ================================================================ A: KDS aging & alerts
print("--- A: KDS ticket timers & aging alerts ---")
s, b = call("GET", "/api/kds/settings", AUTH["kt"])
check("A1 settings defaults", s == 200 and b["thresholds"] == {"warn_secs": 600, "late_secs": 1200, "alert_lead_secs": 240}, str(b)[:120])

s, b = call("GET", "/api/kds/settings", AUTH["st"])
check("A2 settings kitchen-readable, server-forbidden", s == 403, f"got {s}")
s, b = call("POST", "/api/kds/settings", AUTH["st"], {"warn_secs": 60})
check("A3 settings server cannot write", s == 403, f"got {s}")

cid = mk_check(AUTH["st"], name="T22 aging")
add_item(AUTH["st"], cid, 2)   # Tuna Poke (appetizer)
s, b = call("POST", f"/api/checks/{cid}/send", AUTH["st"])
check("A4 send created tickets", s == 200 and len(b["tickets"]) >= 1, str(b)[:120])
ticket_id = b["tickets"][0]["id"]

s, b = call("GET", "/api/kds/alerts", AUTH["kt"])
check("A5 fresh ticket raises no alert", s == 200 and b["alerts"] == [], str(b)[:200])

# Tighten thresholds so the alert window is observable: warn in 6s, lead 3s.
s, b = call("POST", "/api/kds/settings", AUTH["mt"], {"warn_secs": 6, "late_secs": 120, "alert_lead_secs": 3})
check("A6 manager sets thresholds", s == 200 and b["thresholds"]["warn_secs"] == 6, str(b)[:120])
time.sleep(3.5)
s, b = call("GET", "/api/kds/alerts", AUTH["kt"])
hits = [a for a in b["alerts"] if a["ticket_id"] == ticket_id]
check("A7 alert fires BEFORE breach (aging_soon, warn_in_s>0)",
      len(hits) == 1 and hits[0]["band"] == "aging_soon" and hits[0]["warn_in_s"] > 0,
      str(hits)[:200])
time.sleep(3.0)
s, b = call("GET", "/api/kds/alerts", AUTH["kt"])
hits = [a for a in b["alerts"] if a["ticket_id"] == ticket_id]
check("A8 band escalates to aging after warn", len(hits) == 1 and hits[0]["band"] == "aging", str(hits)[:200])

s, b = call("POST", "/api/kds/settings", AUTH["mt"], {"warn_secs": 100, "late_secs": 50})
check("A9 ordering lead<warn<late enforced", s == 400, f"got {s} {b}"[:120])
s, b = call("POST", "/api/kds/settings", AUTH["mt"], {"warn_secs": 0})
check("A10 non-positive threshold rejected", s == 400, f"got {s}")
s, b = call("POST", "/api/kds/settings", AUTH["mt"], {"warn_secs": 600, "late_secs": 1200, "alert_lead_secs": 240})
check("A11 thresholds restored", s == 200 and b["thresholds"]["warn_secs"] == 600, str(b)[:120])

# ================================================================ B: course-status headers
print("--- B: course-status headers on KDS tickets ---")
cid = mk_check(AUTH["st"], table_id=2, name="T22 courses")
add_item(AUTH["st"], cid, 69, seat=1)  # BH Mai Tai (drink -> bar)
add_item(AUTH["st"], cid, 2, seat=1)   # Tuna Poke (appetizer)
add_item(AUTH["st"], cid, 14, seat=2)  # Cheese Burger (entree)
s, b = call("POST", f"/api/checks/{cid}/send", AUTH["st"])
check("B1 multi-course send", s == 200 and len(b["tickets"]) >= 2, str(b)[:150])
s, b = call("GET", "/api/kds/tickets?status=open", AUTH["kt"])
check("B2 tickets listed", s == 200 and len(b) >= 2, f"got {len(b) if isinstance(b, list) else b}")
mine = [t for t in b if t["check_id"] == cid]
check("B3 every ticket carries course_status", all(isinstance(t.get("course_status"), list) and t["course_status"] for t in mine),
      str([t.get("course_status") for t in mine])[:300])
food_t = next(t for t in mine if "appetizer" in t["ticket_courses"])
cs = {c["course"]: c for c in food_t["course_status"]}
check("B4 fired counts per course",
      cs.get("appetizer", {}).get("fired") == 1 and cs.get("entree", {}).get("fired") == 1 and cs.get("drink", {}).get("fired") == 1,
      str(food_t["course_status"])[:200])
check("B5 ticket items carry course", all("course" in i for t in mine for i in t["items"]), "")
check("B6 ticket channel defaults dine_in", all(t["channel"] == "dine_in" for t in mine), str([t["channel"] for t in mine]))
cents_ints(mine, "B tickets")

s, b = call("POST", f"/api/kds/tickets/{food_t['id']}/bump", AUTH["kt"], {"status": "fulfilled"})
check("B7 kitchen bumps ticket", s == 200 and b["status"] == "fulfilled", f"got {s}")
s, b = call("GET", "/api/kds/tickets?status=all", AUTH["kt"])
mine = [t for t in b if t["check_id"] == cid]
cs = {c["course"]: c for c in mine[0]["course_status"]}
check("B8 bumped course reflected on sibling ticket",
      cs.get("appetizer", {}).get("bumped") == 1 and cs.get("entree", {}).get("bumped") == 1,
      str(mine[0]["course_status"])[:200])

# ================================================================ C: tip pooling
print("--- C: tip-outs / tip pooling ---")
s, b = call("POST", "/api/tipout/rules", AUTH["st"], {"name": "x", "role": "y", "basis": "food_sales", "pct_bps": 100})
check("C1 server cannot create rule", s == 403, f"got {s}")
s, b = call("POST", "/api/tipout/rules", AUTH["mt"], {"name": "Busser tip-out", "role": "busser", "basis": "food_sales", "pct_bps": 500})
check("C2 rule created (5% of food sales)", s == 201 and b["rule"]["pct"] == 5.0 and b["rule"]["basis"] == "food_sales", str(b)[:150])
s, b = call("POST", "/api/tipout/rules", AUTH["mt"], {"name": "Bar tip-out", "role": "bartender", "basis": "tips", "pct_bps": 1000})
check("C3 second rule created (10% of tips)", s == 201, str(b)[:120])
s, b = call("POST", "/api/tipout/rules", AUTH["mt"], {"name": "Bad", "role": "z", "basis": "revenue", "pct_bps": 100})
check("C4 bad basis rejected", s == 400, f"got {s}")
s, b = call("POST", "/api/tipout/rules", AUTH["mt"], {"name": "Bad", "role": "z", "basis": "tips", "pct_bps": 0})
check("C5 zero pct rejected", s == 400, f"got {s}")
s, b = call("GET", "/api/tipout/rules", AUTH["mt"])
check("C6 rules listed", s == 200 and len(b["rules"]) == 2, str(b)[:150])

# Server's day: $18 food + $14.50 drink; hand-computed totals.
cid = mk_check(AUTH["st"], table_id=3, name="T22 tipout")
add_item(AUTH["st"], cid, 14, seat=1)  # Cheese Burger 1800 (entree=food)
add_item(AUTH["st"], cid, 69, seat=1)  # BH Mai Tai 1450 (drink)
s, b = call("POST", f"/api/checks/{cid}/send", AUTH["st"])
sub, sur, tax = 3250, jround(3250 * 0.05), jround((3250 + jround(3250 * 0.05)) * 0.0775)
total = sub + sur + tax
s, b = call("POST", f"/api/checks/{cid}/payments", AUTH["st"],
            {"method": "card_demo", "amount_cents": total, "tip_cents": 600})
check("C7 paid with $6 tip", s == 201 and b["check"]["total_cents"] == total, f"got {s} total={total}")
# Server's own date (site timezone) straight from the DB — no guessing.
import sqlite3 as _sq
_con = _sq.connect(DB)
date = _con.execute("SELECT substr(opened_at,1,10) FROM checks WHERE id = ?", (cid,)).fetchone()[0]
_con.close()
s, b = call("GET", f"/api/tipout/report?date={date}", AUTH["mt"])
check("C8 report 200", s == 200, f"got {s} {str(b)[:150]}")
srv = next((x for x in b["servers"] if x["server_name"] == "Daniel S"), None)
# Independent cross-check straight from the DB: sum every billable line on
# Daniel's PAID/CLOSED checks opened today (open checks must not inflate the
# base); drinks excluded from food_sales by definition.
_con = _sq.connect(DB)
exp_food = _con.execute(
    """SELECT COALESCE(SUM(ci.qty * (ci.unit_price_cents +
        COALESCE((SELECT SUM(CAST(json_extract(m.value,'$.price_delta_cents') AS INTEGER))
                 FROM json_each(ci.modifiers_json) m), 0))), 0)
       FROM check_items ci JOIN checks c ON c.id = ci.check_id
       WHERE c.server_id = 1 AND substr(c.opened_at,1,10) = ?
         AND c.status IN ('paid','closed')
         AND ci.state IN ('held','sent','fulfilled') AND ci.course != 'drink'""", (date,)).fetchone()[0]
exp_gross = _con.execute(
    """SELECT COALESCE(SUM(ci.qty * (ci.unit_price_cents +
        COALESCE((SELECT SUM(CAST(json_extract(m.value,'$.price_delta_cents') AS INTEGER))
                 FROM json_each(ci.modifiers_json) m), 0))), 0)
       FROM check_items ci JOIN checks c ON c.id = ci.check_id
       WHERE c.server_id = 1 AND substr(c.opened_at,1,10) = ?
         AND c.status IN ('paid','closed')
         AND ci.state IN ('held','sent','fulfilled')""", (date,)).fetchone()[0]
exp_tips = _con.execute(
    """SELECT COALESCE(SUM(p.tip_cents),0) FROM payments p JOIN checks c ON c.id = p.check_id
       WHERE p.site_id = 'bali-hai' AND c.server_id = 1 AND substr(p.created_at,1,10) = ?
         AND p.status = 'completed'""", (date,)).fetchone()[0]
_con.close()
check("C9 food_sales basis excludes drinks (DB cross-check)",
      srv and srv["food_sales_cents"] == exp_food and srv["gross_sales_cents"] == exp_gross and srv["tips_cents"] == exp_tips,
      f"report={str(srv)[:200]} db=({exp_food},{exp_gross},{exp_tips})")
# Hand-computed on THIS phase's check: food=1800, tips=600.
check("C9b this phase's check contributes food=1800 tips=600", exp_food >= 1800 and exp_tips >= 600, "")
exp_busser, exp_bar = jround(exp_food * 0.05), jround(exp_tips * 0.10)
by_name = {t["name"]: t for t in srv["tipouts"]} if srv else {}
check("C10 tip-outs hand-computed",
      by_name.get("Busser tip-out", {}).get("owed_cents") == exp_busser and by_name.get("Bar tip-out", {}).get("owed_cents") == exp_bar,
      f"want busser={exp_busser} bar={exp_bar} got {str(by_name)[:200]}")
check("C11 net tips = tips - tipouts",
      srv and srv["total_tipout_cents"] == exp_busser + exp_bar and srv["net_tips_cents"] == 600 - exp_busser - exp_bar,
      str(srv)[:200])
by_role = {x["role"]: x["total_owed_cents"] for x in b["by_role"]}
check("C12 by_role totals", by_role.get("busser") == exp_busser and by_role.get("bartender") == exp_bar, str(by_role))
cents_ints(b, "C tipout report")
s, b = call("GET", f"/api/tipout/report?date={date}", AUTH["st"])
check("C13 report manager-only", s == 403, f"got {s}")
s, b = call("GET", "/api/tipout/report?date=not-a-date", AUTH["mt"])
check("C14 bad date rejected", s == 400, f"got {s}")
rid = call("GET", "/api/tipout/rules", AUTH["mt"])[1]["rules"][0]["id"]
s, b = call("DELETE", f"/api/tipout/rules/{rid}", AUTH["mt"])
check("C15 rule deactivated", s == 200, f"got {s} {b}")
s, b = call("GET", "/api/tipout/rules", AUTH["mt"])
check("C16 deleted rule hidden", s == 200 and len(b["rules"]) == 1, str(b)[:120])

# ================================================================ D: QR guest order & pay
print("--- D: QR guest self order & pay ---")
qr = table_qr(AUTH["st"], 1)
s, b = call("GET", "/api/guest/menu?token=bad-token")
check("D1 bad token 404", s == 404, f"got {s}")
s, b = call("GET", f"/api/guest/menu?token={qr}")
check("D2 guest menu public, no auth", s == 200 and len(b["categories"]) > 0 and b["table"]["label"] == "50", f"got {s}")
flat = [i for c in b["categories"] for i in c["items"]]
check("D3 menu items priced in integer cents", all(isinstance(i["price_cents"], int) for i in flat), "")
cents_ints(b, "D guest menu")

s, b = call("POST", "/api/guest/orders", body={"token": qr, "guest_name": "QA Guest",
    "items": [{"menu_item_id": 2, "qty": 2, "seat": 1}, {"menu_item_id": 1, "qty": 1, "seat": 2}]})
check("D4 guest order 201", s == 201 and b.get("guest_token"), f"got {s} {str(b)[:150]}")
gt = b["guest_token"]
gcheck_id = b["check_id"]
esub, esur = 7200, jround(7200 * 0.05)
etax = jround((esub + esur) * 0.0775)
check("D5 server-side totals hand-computed (client prices ignored)",
      b["totals"]["subtotal"] == esub and b["totals"]["surcharge"] == esur and
      b["totals"]["tax"] == etax and b["totals"]["total"] == esub + esur + etax and b["totals"]["balance"] == esub + esur + etax,
      str(b["totals"]))
cents_ints(b, "D guest order")
s, b = call("GET", "/api/kds/tickets?status=open", AUTH["kt"])
qrt = [t for t in b if t.get("channel") == "qr_guest"]
check("D6 guest order fired to the SAME KDS queue",
      any(t["check_id"] == gcheck_id for t in qrt),
      f"qr_guest tickets: {len(qrt)}")
s, b = call("GET", f"/api/guest/check?guest_token={gt}")
check("D7 guest check view", s == 200 and b["status"] == "open" and len(b["items"]) == 2, f"got {s} {str(b)[:150]}")
check("D8 items split by seat", {i["seat"] for i in b["items"]} == {1, 2}, str([(i["seat"], i["name"]) for i in b["items"]]))
bal = b["totals"]["balance"]

s, b = call("POST", "/api/guest/pay", body={"guest_token": gt, "method": "card_demo", "amount_cents": bal + 1, "tip_cents": 0})
check("D9 over-balance payment rejected", s == 400, f"got {s}")
s, b = call("POST", "/api/guest/pay", body={"guest_token": gt, "method": "card_demo", "amount_cents": bal - 100, "tip_cents": 50})
check("D10 tip on partial payment rejected", s == 400, f"got {s}")
s, b = call("POST", "/api/guest/pay", body={"guest_token": gt, "method": "card_demo", "amount_cents": bal, "tip_cents": 300})
check("D11 demo-card settles + tip", s == 201 and b["payment"]["tip_cents"] == 300 and b["totals"]["balance"] == 0, f"got {s} {str(b)[:150]}")
check("D12 demo disclosure present (no real charge)", "demo" in b and "card_demo" in b["payment"]["method"], str(b)[:120])
s, b = call("GET", f"/api/guest/check?guest_token={gt}")
check("D13 check paid after guest pay", s == 200 and b["status"] == "paid", f"got {s} {b['status']}")
s, b = call("POST", "/api/guest/feedback", body={"guest_token": gt, "rating": 5, "note": "Great poke!"})
check("D14 post-payment review nudge (optional)", s == 201 and "thanks" in b, f"got {s} {b}")
s, b = call("POST", "/api/guest/feedback", body={"guest_token": gt, "rating": 9})
check("D15 bad rating rejected", s == 400, f"got {s}")

# Cash flow: guest requests cash, staff collects.
s, b = call("POST", "/api/guest/orders", body={"token": qr, "items": [{"menu_item_id": 3, "qty": 1, "seat": 1}]})
gt2 = b["guest_token"]
s, chk = call("GET", f"/api/guest/check?guest_token={gt2}")
bal2 = chk["totals"]["balance"]
s, b = call("POST", "/api/guest/pay", body={"guest_token": gt2, "method": "cash", "amount_cents": bal2, "tip_cents": 0, "tendered_cents": bal2 + 500})
check("D16 cash creates collect request (no payment yet)", s == 201 and b["cash_request"]["status"] == "requested", f"got {s} {str(b)[:150]}")
s, b = call("GET", "/api/cash-requests", AUTH["st"])
found = [r for r in b["requests"] if r["amount_cents"] == bal2]
check("D17 staff see cash-collect queue", s == 200 and len(found) == 1, f"got {s} n={len(found)}")
s, b = call("POST", f"/api/cash-requests/{found[0]['id']}/collect", AUTH["st"])
check("D18 staff collect records cash payment", s == 200 and b["totals"]["balance"] == 0, f"got {s} {str(b)[:150]}")
cents_ints(b, "D cash collect")
s, b = call("GET", "/api/cash-requests", AUTH["st"])
check("D19 collected request leaves queue", s == 200 and not any(r["id"] == found[0]["id"] for r in b["requests"]), "")

# QR rotate invalidates the old token (fresh token per print).
qr2 = table_qr(AUTH["st"], 2)
s, b = call("POST", "/api/tables/2/qr/rotate", AUTH["st"])
check("D20 QR rotate is manager-only", s == 403, f"got {s}")
s, b = call("POST", "/api/tables/2/qr/rotate", AUTH["mt"])
check("D20b manager rotates QR", s == 200 and b["token"] != qr2, f"got {s}")
new_qr = b["token"]
s, b = call("GET", f"/api/guest/menu?token={qr2}")
check("D21 old token dead after rotate", s == 404, f"got {s}")
s, b = call("GET", f"/api/guest/menu?token={new_qr}")
check("D22 new token works", s == 200, f"got {s}")
def raw_get(path):
    """Non-JSON fetch (HTML pages)."""
    req = urllib.request.Request(BASE + path)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()

s, body = raw_get("/g/" + qr)
check("D23 /g/:token serves guest page", s == 200 and b"/views/guest.js" in body, f"got {s}")

# ================================================================ E: guest self-split
print("--- E: guest self-split (restart for rate-limit bucket) ---")
restart_server()
relogin()
qr = table_qr(AUTH["st"], 1)
s, b = call("POST", "/api/guest/orders", body={"token": qr, "items": [
    {"menu_item_id": 2, "qty": 1, "seat": 1},
    {"menu_item_id": 14, "qty": 1, "seat": 2},
    {"menu_item_id": 69, "qty": 1, "seat": 3}]})
gt = b["guest_token"]
s, b = call("POST", "/api/guest/split", body={"guest_token": gt, "mode": "by_seat", "seat_groups": [[1], [2, 3]]})
check("E1 self-split by seat", s == 201 and len(b["checks"]) == 2, f"got {s} {str(b)[:200]}")
group = b["split_group"]
kids = b["checks"]
check("E2 children carry seat sets", {tuple(c["seats"]) for c in kids} == {(1,), (2, 3)}, str(kids))
s, b = call("GET", f"/api/guest/check?guest_token={kids[0]['guest_token']}")
check("E3 child check deep-link works", s == 200 and len(b["items"]) == 1 and b["items"][0]["seat"] == 1, f"got {s}")
bal_k1 = b["totals"]["balance"]
s, b = call("POST", "/api/guest/pay", body={"guest_token": kids[0]["guest_token"], "method": "card_demo", "amount_cents": bal_k1, "tip_cents": 100})
check("E4 seat 1 pays own check", s == 201 and b["totals"]["balance"] == 0, f"got {s}")
s, b = call("POST", "/api/guest/split/reverse", AUTH["mt"], {"split_group": group})
check("E5 reverse blocked once money moved (staff override is safe)", s == 400, f"got {s} {str(b)[:120]}")
s, b = call("POST", "/api/guest/split/reverse", AUTH["st"], {"split_group": group})
check("E6 reverse is manager-only", s == 403, f"got {s}")

# Clean split -> manager reverses.
s, b = call("POST", "/api/guest/orders", body={"token": qr, "items": [
    {"menu_item_id": 2, "qty": 1, "seat": 1}, {"menu_item_id": 14, "qty": 1, "seat": 2}]})
gt3 = b["guest_token"]
s, b = call("POST", "/api/guest/split", body={"guest_token": gt3, "mode": "even"})
check("E7 even self-split", s == 201 and len(b["checks"]) == 2, f"got {s}")
s, b = call("POST", "/api/guest/split/reverse", AUTH["mt"], {"split_group": b["split_group"]})
check("E8 manager reverses clean split", s == 200 and b.get("parent_check"), f"got {s} {str(b)[:120]}")
s, b = call("GET", f"/api/guest/check?guest_token={gt3}")
check("E9 parent reopened with all items", s == 200 and b["status"] == "open" and len(b["items"]) == 2, f"got {s} {b['status']}")
s, b = call("POST", "/api/guest/split", body={"guest_token": kids[0]["guest_token"], "mode": "even"})
check("E10 split on paid child check blocked", s == 400, f"got {s} {str(b)[:120]}")

# ================================================================ F: delivery aggregation
print("--- F: delivery-order aggregation ---")
s, b = call("POST", "/api/delivery/orders", AUTH["st"], body={"source": "DoorDash", "customer_name": "QA Dash",
    "items": [{"menu_item_id": 14, "qty": 1}, {"menu_item_id": 69, "qty": 2}]})
check("F1 delivery order accepted", s == 201 and b["channel"] == "delivery" and b["source"] == "DoorDash", f"got {s} {str(b)[:150]}")
check("F2 delivery KDS tickets created", len(b["tickets"]) >= 1, str(b.get("tickets")))
s, b = call("GET", "/api/kds/tickets?status=open", AUTH["kt"])
dlv = [t for t in b if t["channel"] == "delivery"]
check("F3 delivery lands in the SAME single queue", len(dlv) >= 1 and all(t.get("source") == "DoorDash" for t in dlv),
      f"delivery tickets in queue: {len(dlv)}")
check("F4 delivery ticket shows course rollup", all(t.get("course_status") for t in dlv), "")
s, b = call("POST", "/api/delivery/orders", AUTH["st"], body={"items": [{"menu_item_id": 14, "qty": 1}]})
check("F5 source required", s == 400, f"got {s}")
s, b = call("POST", "/api/delivery/orders", AUTH["st"], {"source": "Uber Eats", "items": [{"menu_item_id": 99999, "qty": 1}]})
check("F6 unknown item rejected, server reprices", s == 400, f"got {s}")
s, b = call("POST", "/api/delivery/orders", body={"source": "X", "items": [{"menu_item_id": 14, "qty": 1}]})
check("F7 delivery requires staff auth", s == 401, f"got {s}")
s, b = call("GET", "/api/delivery/orders", AUTH["st"])
check("F8 delivery orders listed", s == 200 and any(o["source"] == "DoorDash" for o in b["orders"]), f"got {s}")
cents_ints(b, "F delivery")

# ================================================================ G: allergy + special requests on KDS
# Fresh DB for deterministic assertions below.
print("--- G: allergy flags + per-line special requests on KDS ---")
restart_server(fresh_db=True)
relogin()
qr = table_qr(AUTH["st"], 1)
s, b = call("POST", "/api/guest/orders", body={"token": qr, "guest_name": "QA Allergy",
    "items": [{"menu_item_id": 14, "qty": 1, "seat": 1, "note": "No onions, extra pickles",
               "allergy": True, "allergy_detail": "peanut"},
              {"menu_item_id": 90, "qty": 1, "seat": 1}]})
check("G1 guest order with note+allergy accepted", s == 201, f"got {s} {str(b)[:200]}")
gtok = b["guest_token"]
s, b = call("GET", "/api/kds/tickets?status=open", AUTH["kt"])
gal = [t for t in b if t.get("channel") == "qr_guest" and t.get("has_allergy")]
check("G2 KDS ticket flagged has_allergy", len(gal) >= 1, f"qr allergy tickets: {len(gal)}")
t0 = gal[0]
alines = [i for i in t0["items"] if i.get("allergy")]
check("G3 ticket line carries note + allergy_detail",
      len(alines) == 1 and alines[0].get("note") == "No onions, extra pickles"
      and alines[0].get("allergy_detail") == "peanut", str(alines)[:220])
# The soda went to the bar as its own ticket — it must carry no allergy flag.
sib = [t for t in b if t.get("channel") == "qr_guest" and not t.get("has_allergy")]
check("G4 non-allergy ticket/line has no flag",
      len(sib) == 1 and all(not i.get("allergy") for i in sib[0]["items"]),
      f"sibling tickets: {len(sib)}")
s, b = call("GET", "/api/guest/check?guest_token=" + gtok)
check("G5 guest check view shows note/allergy",
      s == 200 and any(i.get("allergy") and i.get("note") == "No onions, extra pickles" for i in b["items"]),
      f"got {s}")
s, b = call("POST", "/api/guest/orders", body={"token": qr,
    "items": [{"menu_item_id": 14, "qty": 1, "note": "x" * 141}]})
check("G6 note >140 chars rejected", s == 400, f"got {s}")
s, b = call("POST", "/api/guest/orders", body={"token": qr,
    "items": [{"menu_item_id": 14, "qty": 1, "allergy": "yes"}]})
check("G7 non-boolean allergy rejected", s == 400, f"got {s}")
# POS path: order-entry owns the note/allergy capture API (parity-orders);
# simulate its capture with SQL, then KDS must render what the schema carries.
cid = mk_check(AUTH["st"], table_id=3)
itm = add_item(AUTH["st"], cid, 14)
subprocess.run(["sqlite3", DB,
                f"UPDATE check_items SET note='Dressing on side', allergy=1, allergy_detail='shellfish' WHERE id={itm['id']}"],
               check=True)
s, b = call("POST", f"/api/checks/{cid}/send", AUTH["st"])
check("G8 POS send fires", s == 200 and b["sent"] == 1, f"got {s} {str(b)[:120]}")
s, b = call("GET", "/api/kds/tickets?status=open", AUTH["kt"])
mine = [t for t in b if t.get("check_id") == cid]
check("G9 POS ticket has_allergy banner flag",
      len(mine) == 1 and mine[0].get("has_allergy") is True, str(mine)[:150])
li = mine[0]["items"][0]
check("G10 POS ticket line carries note/allergy",
      li.get("note") == "Dressing on side" and li.get("allergy") == 1 and li.get("allergy_detail") == "shellfish",
      str(li)[:220])
cents_ints(b, "G allergy")

# ================================================================ H: item re-fire / reprint
print("--- H: item re-fire / reprint kitchen tickets ---")
cid = mk_check(AUTH["st"], table_id=4)
itm = add_item(AUTH["st"], cid, 14)
s, b = call("POST", f"/api/checks/{cid}/send", AUTH["st"])
check("H1 send fires", s == 200 and b["sent"] == 1, f"got {s}")
s, b = call("GET", "/api/kds/tickets?status=open", AUTH["kt"])
orig = [t for t in b if t.get("check_id") == cid][0]
orig_json = json.dumps(orig["items"], sort_keys=True)
check("H1b original ticket not a refire", orig.get("refire") is False, "")
# give the fired line a note/allergy; refire must carry them through
subprocess.run(["sqlite3", DB,
                f"UPDATE check_items SET note='Burnt, remake please', allergy=1 WHERE id={itm['id']}"],
               check=True)
s, b = call("POST", f"/api/checks/{cid}/items/{itm['id']}/refire", AUTH["st"])
check("H2 refire accepted", s == 201 and b["ticket"].get("refire") is True, f"got {s} {str(b)[:200]}")
t2 = b["ticket"]
check("H3 refire ticket carries the same single item",
      len(t2["items"]) == 1 and t2["items"][0].get("item_id") == itm["id"], str(t2["items"])[:160])
check("H4 refire snapshot keeps note/allergy",
      t2["items"][0].get("note") == "Burnt, remake please" and t2["items"][0].get("allergy") == 1,
      str(t2["items"][0])[:200])
s, b = call("GET", "/api/kds/tickets?status=open", AUTH["kt"])
again = [t for t in b if t["id"] == orig["id"]][0]
check("H5 original ticket untouched",
      again["status"] == "new" and json.dumps(again["items"], sort_keys=True) == orig_json, "")
check("H6 refire is its own open ticket", any(t["id"] == t2["id"] and t.get("refire") for t in b), "")
s, b = call("POST", f"/api/checks/{cid}/items/{itm['id']}/refire", AUTH["kt"])
check("H7 kitchen cannot refire (server+ only)", s == 403, f"got {s}")
cid2 = mk_check(AUTH["st"], table_id=5)
itm2 = add_item(AUTH["st"], cid2, 14)
s, b = call("POST", f"/api/checks/{cid2}/items/{itm2['id']}/refire", AUTH["st"])
check("H8 held (unfired) item cannot be refired", s == 400, f"got {s}")
s, b = call("POST", f"/api/checks/{cid}/items/999999/refire", AUTH["st"])
check("H9 unknown item 404", s == 404, f"got {s}")
s, b = call("GET", "/api/admin/approvals/audit?limit=50", AUTH["mt"])
check("H10 refire audit-logged",
      s == 200 and any(a["action"] == "refire" and a["item_id"] == itm["id"] for a in b), f"got {s}")
cents_ints(b, "H refire")

# ================================================================ I: refund UI API + audit fixes
# Restart (keep DB) for a fresh guest rate-limit bucket.
print("--- I: refund UI API surface + audit fixes ---")
restart_server()
relogin()
qr = table_qr(AUTH["st"], 1)
today = time.strftime("%Y-%m-%d", time.gmtime())
cid = mk_check(AUTH["st"], table_id=6)
add_item(AUTH["st"], cid, 90)  # Soda 400
s, b = call("GET", f"/api/checks/{cid}", AUTH["mt"])
tot = b["totals"]["total"]
s, b = call("POST", f"/api/checks/{cid}/payments", AUTH["mt"],
            {"method": "card_demo", "amount_cents": tot, "brand": "Visa", "last4": "4242"})
check("I1 payment recorded", s == 201 and b["payment"]["id"], f"got {s}")
pid = b["payment"]["id"]
s, b = call("POST", f"/api/payments/{pid}/refund", AUTH["mt"], {"amount_cents": 200})
check("I2 partial refund",
      s == 200 and b["payment"]["status"] == "partial_refund" and b["payment"]["refunded_cents"] == 200,
      f"got {s} {str(b)[:160]}")
s, b = call("GET", f"/api/checks/{cid}", AUTH["mt"])
check("I3 balance reflects partial refund", b["totals"]["balance"] == 200, f"balance={b['totals']['balance']}")
s, b = call("POST", f"/api/payments/{pid}/refund", AUTH["mt"], {"amount_cents": tot - 200})
check("I4 full refund marks refunded",
      s == 200 and b["payment"]["status"] == "refunded" and b["payment"]["refunded_cents"] == tot,
      f"got {s}")
s, b = call("GET", f"/api/checks/{cid}", AUTH["mt"])
check("I5 refunded paid check reopens with balance due",
      b["status"] == "open" and b["totals"]["balance"] == tot,
      f"status={b['status']} bal={b['totals']['balance']}")
s, b = call("POST", f"/api/payments/{pid}/refund", AUTH["mt"], {"amount_cents": 1})
check("I6 double refund blocked", s == 400, f"got {s}")
s, b = call("POST", f"/api/payments/{pid}/refund", AUTH["st"], {"amount_cents": 1})
check("I7 refund stays manager-only", s == 403, f"got {s}")
# closed-check refund: recorded, check stays closed
cid2 = mk_check(AUTH["st"], table_id=7)
add_item(AUTH["st"], cid2, 90)
s, b = call("GET", f"/api/checks/{cid2}", AUTH["mt"])
tot2 = b["totals"]["total"]
s, b = call("POST", f"/api/checks/{cid2}/payments", AUTH["mt"],
            {"method": "cash", "amount_cents": tot2, "tendered_cents": tot2})
pid2 = b["payment"]["id"]
s, b = call("POST", f"/api/checks/{cid2}/close", AUTH["mt"])
check("I8 check closed", s == 200, f"got {s}")
s, b = call("POST", f"/api/payments/{pid2}/refund", AUTH["mt"], {"amount_cents": tot2})
check("I8b closed-check refund accepted", s == 200 and b["payment"]["status"] == "refunded", f"got {s}")
s, b = call("GET", f"/api/checks/{cid2}", AUTH["mt"])
check("I9 closed check stays closed after refund", b["status"] == "closed", f"status={b['status']}")
# tip-out report: OPEN checks must not inflate the base
s, b = call("POST", "/api/tipout/rules", AUTH["mt"],
            {"name": "QA busser", "role": "busser", "basis": "food_sales", "pct_bps": 1000})
check("I10 tipout rule created", s == 201, f"got {s}")
cid3 = mk_check(AUTH["st"], table_id=8)
add_item(AUTH["st"], cid3, 14)  # Cheese Burger 1800, entree = food
s, b = call("GET", f"/api/checks/{cid3}", AUTH["mt"])
tot3 = b["totals"]["total"]
srv_name = b["server_name"]
s, b = call("POST", f"/api/checks/{cid3}/payments", AUTH["mt"], {"method": "cash", "amount_cents": tot3, "tendered_cents": tot3})
s, b = call("POST", f"/api/checks/{cid3}/close", AUTH["mt"])
s, b = call("GET", f"/api/tipout/report?date={today}", AUTH["mt"])
row = [r for r in b["servers"] if r["server_name"] == srv_name][0]
base_food = row["food_sales_cents"]
check("I11 paid check feeds tipout base", base_food == 1800, f"food_sales={base_food}")
cid4 = mk_check(AUTH["st"], table_id=9)
add_item(AUTH["st"], cid4, 14)  # stays OPEN (unpaid)
s, b = call("GET", f"/api/tipout/report?date={today}", AUTH["mt"])
row2 = [r for r in b["servers"] if r["server_name"] == srv_name][0]
check("I12 open check does NOT inflate tipout base",
      row2["food_sales_cents"] == base_food, f"before={base_food} after={row2['food_sales_cents']}")
# guest cash tendered floor
s, b = call("POST", "/api/guest/orders", body={"token": qr, "items": [{"menu_item_id": 90, "qty": 1}]})
gt2 = b["guest_token"]
s, b = call("GET", "/api/guest/check?guest_token=" + gt2)
bal2 = b["totals"]["balance"]
s, b = call("POST", "/api/guest/pay", body={"guest_token": gt2, "method": "cash",
    "amount_cents": bal2, "tendered_cents": bal2 - 1})
check("I13 under-tendered cash rejected", s == 400, f"got {s} {str(b)[:120]}")
s, b = call("POST", "/api/guest/pay", body={"guest_token": gt2, "method": "cash",
    "amount_cents": bal2, "tendered_cents": bal2})
check("I14 exact tender accepted (collect request)", s == 201 and b["cash_request"]["status"] == "requested",
      f"got {s} {str(b)[:120]}")
# feedback: post-payment only
s, b = call("POST", "/api/guest/feedback", body={"guest_token": gt2, "rating": 5})
check("I15 feedback on open check blocked", s == 400, f"got {s} {str(b)[:120]}")
s, b = call("POST", "/api/guest/orders", body={"token": qr, "items": [{"menu_item_id": 90, "qty": 1}]})
gt3 = b["guest_token"]
s, b = call("GET", "/api/guest/check?guest_token=" + gt3)
bal3 = b["totals"]["balance"]
s, b = call("POST", "/api/guest/pay", body={"guest_token": gt3, "method": "card_demo", "amount_cents": bal3})
s, b = call("POST", "/api/guest/feedback", body={"guest_token": gt3, "rating": 5, "note": "Great!"})
check("I16 feedback after payment accepted", s == 201 and b.get("feedback_id"), f"got {s} {str(b)[:120]}")
cents_ints(b, "I refunds")

# ================================================================ J: split tender + tender catalog (NG-A / NG-F)
print("--- J: split tender / partial payments + tender catalog ---")
jc = mk_check(AUTH["st"], table_id=20, name="T22 split")
add_item(AUTH["st"], jc, 14)  # Cheese Burger 1800
s, b = call("GET", f"/api/checks/{jc}", AUTH["mt"])
jbal = b["totals"]["balance"]
jtot = b["totals"]["total"]
check("J0 baseline balance", s == 200 and jbal == jtot and jbal > 0, str(b["totals"])[:120])

# J1: partial cash (Toast $20-card-rest-cash shape, reversed): cash 1000 first
s, b = call("POST", f"/api/checks/{jc}/payments", AUTH["st"],
            {"method": "cash", "amount_cents": 1000, "tip_cents": 200, "tendered_cents": 1200})
check("J1 partial cash accepted", s == 201 and b["payment"]["amount_cents"] == 1000, f"got {s} {str(b)[:120]}")
check("J2 cash change nets tip (tendered-amount-tip)",
      b.get("change_cents") == 0, f"change_cents={b.get('change_cents')}")
s, b = call("GET", f"/api/checks/{jc}", AUTH["mt"])
check("J3 balance reduced, check still open",
      b["totals"]["balance"] == jbal - 1000 and b["status"] == "open",
      str(b["totals"])[:120])

# J4: partial card closes the rest (incl. the 200 tip in the balance math)
s, b = call("GET", f"/api/checks/{jc}", AUTH["mt"])
rest = b["totals"]["balance"]
s, b = call("POST", f"/api/checks/{jc}/payments", AUTH["st"],
            {"method": "card_demo", "amount_cents": rest, "tip_cents": 0, "brand": "Visa", "last4": "4242"})
check("J4 partial card closes remainder", s == 201 and b["check"]["status"] == "paid", f"got {s} {str(b)[:120]}")
check("J5 card auth code is demo-shaped",
      bool(b["payment"].get("auth_code", "").startswith("DEMO")), str(b["payment"].get("auth_code")))
cents_ints(b, "J split tender")

# J6: house account needs a memo
hc = mk_check(AUTH["st"], table_id=21, name="T22 house")
add_item(AUTH["st"], hc, 14)
s, b = call("GET", f"/api/checks/{hc}", AUTH["mt"])
hbal = b["totals"]["balance"]
s, b = call("POST", f"/api/checks/{hc}/payments", AUTH["st"],
            {"method": "house_account", "amount_cents": hbal})
check("J6 house account without memo rejected", s == 400, f"got {s} {str(b)[:120]}")
s, b = call("POST", f"/api/checks/{hc}/payments", AUTH["st"],
            {"method": "house_account", "amount_cents": hbal - 500, "tip_cents": 0, "memo": "Bali Hai — Daniel Silva"})
check("J7 partial house charge recorded with memo",
      s == 201 and b["payment"]["memo"] == "Bali Hai — Daniel Silva", f"got {s} {str(b)[:120]}")
s, b = call("POST", f"/api/checks/{hc}/payments", AUTH["st"],
            {"method": "house_account", "amount_cents": 500, "memo": "Bali Hai — Daniel Silva"})
check("J8 second house tender closes check", s == 201 and b["check"]["status"] == "paid", f"got {s} {str(b)[:120]}")
s, b = call("POST", f"/api/checks/{hc}/payments", AUTH["st"],
            {"method": "bitcoin", "amount_cents": 100})
check("J9 unknown tender method rejected", s == 400, f"got {s} {str(b)[:120]}")

# J10: gift card issue + partial redeem (would 500 on old CHECK constraint)
s, b = call("POST", "/api/gift-cards/issue", AUTH["mt"], {"initial_cents": 3000})
gcode = b["card"]["code"] if s == 201 else None
check("J10 gift card issued", s == 201 and bool(gcode), f"got {s} {str(b)[:120]}")
gc = mk_check(AUTH["st"], table_id=22, name="T22 gift")
add_item(AUTH["st"], gc, 14)
s, b = call("GET", f"/api/checks/{gc}", AUTH["mt"])
gbal = b["totals"]["balance"]
s, b = call("POST", "/api/gift-cards/redeem", AUTH["st"],
            {"check_id": gc, "gift_card_code": gcode, "amount_cents": 1000})
check("J11 gift card partial redeem", s == 201 and b["payment"]["method"] == "gift_card", f"got {s} {str(b)[:120]}")
check("J12 gift card balance deducted", s == 201 and b["card"]["balance_cents"] == 2000, str(b.get("card"))[:120])
s, b = call("GET", f"/api/checks/{gc}", AUTH["mt"])
check("J13 gift partial leaves balance open",
      b["totals"]["balance"] == gbal - 1000 and b["status"] == "open", str(b["totals"])[:120])
s, b = call("POST", "/api/gift-cards/redeem", AUTH["st"],
            {"check_id": gc, "gift_card_code": gcode, "amount_cents": 5000})
check("J14 over-balance redeem rejected", s == 400, f"got {s} {str(b)[:120]}")
cents_ints(b, "J gift card")

# J15: comp card = manager-gated comp via tender button (partial)
cc = mk_check(AUTH["st"], table_id=23, name="T22 compcard")
add_item(AUTH["st"], cc, 14)
s, b = call("GET", f"/api/checks/{cc}", AUTH["mt"])
cbal = b["totals"]["balance"]
s, b = call("POST", f"/api/checks/{cc}/comp", AUTH["st"],
            {"manager_pin": "2580", "reason": "Comp card: birthday", "amount_cents": 500})
check("J15 comp-card partial comp (manager PIN)", s == 200 and b["comp_cents"] == 500, f"got {s} {str(b)[:120]}")
s, b = call("GET", f"/api/checks/{cc}", AUTH["mt"])
check("J16 comp reduces balance", b["totals"]["balance"] == cbal - 500, str(b["totals"])[:120])

# J17: payouts report carries the house-account bucket
s, b = call("GET", f"/api/finance/payouts?date={today}", AUTH["mt"])
check("J17 house_account_sales_cents in payouts",
      s == 200 and isinstance(b.get("house_account_sales_cents"), int) and b["house_account_sales_cents"] == hbal,
      f"got {s} {str(b)[:160]}")
cents_ints(b, "J payouts")

# J18: static UI surface — new tender + receipt + refund-picker hooks exist, print CSS present
import re
app_js = open(os.path.join(SRV_DIR, "public", "app.js")).read()
css = open(os.path.join(SRV_DIR, "public", "styles.css")).read()
needles = ["id=\"pay-gift\"", "id=\"pay-house\"", "id=\"pay-compcard\"", "st-amount", "st-tip",
           "splitTenderFields", "id=\"print-receipt\"", "rf-items",
           "api/gift-cards/redeem", "house_account", "kds.gen"]
# Receipt may use the in-place print-area approach ("printing-receipt") or the
# popup-window approach ("window.print" via printReceipt) — either is real.
receipt_ok = "printing-receipt" in app_js or ("printReceipt" in app_js and "window.print" in app_js)
missing = [n for n in needles if n not in app_js]
if not receipt_ok:
    missing.append("receipt-print-hook")
check("J18 tender/receipt/refund-picker UI hooks in app.js", not missing, "missing: " + ",".join(missing))
check("J19 print CSS present", "@media print" in css and "#print-area" in css, "no print rules")
fake_receipt_ui = [n for n in ["Text receipt</button", "Email receipt</button", "SMS receipt</button",
    "send-receipt-text", "send-receipt-email", "receipt-text", "receipt-email"] if n.lower() in app_js.lower()]
check("J20 no fake text/email receipt buttons", not fake_receipt_ui, "found: " + ",".join(fake_receipt_ui))

# ================================================================ summary
print()
print(f"PASSED {len(passed)}  FAILED {len(failed)}")
subprocess.run(f"lsof -ti:{PORT} | xargs kill -9 2>/dev/null", shell=True)
sys.exit(1 if failed else 0)
