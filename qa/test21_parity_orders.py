#!/usr/bin/env python3
"""test21_parity_orders.py — Phase 3A competitor parity: order & check flow.

Covers the 7 MISSING categories from parity-matrix sections A/B:
  1. Daypart menu switching (auto by clock)
  2. Table timers / turn-time tracking
  3. Guest renaming on checks (seat-level, follows splits/merges)
  4. Edit fired orders (manager-approved, KDS deltas, audit trail)
  5. Tap-and-drop visual splitting (split 'move' between checks; 3-tap even split)
  6. Merge parties (one tap, seat map preserved)
  7. Move checks between tables (KDS headers update)

Money is hand-computed in integer cents (mirrors the documented rules).
Role enforcement is asserted on every new endpoint.
"""
import json, os, sys, urllib.request, urllib.error
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

BASE = os.environ.get("EXPOLINE_TEST_BASE", "http://localhost:4325")
DB_PATH = os.environ.get("EXPOLINE_TEST_DB", "/tmp/parity-orders-qa.db")
S, K, M = "1111", "2222", "2580"

def api(method, path, token=None, body=None):
    req = urllib.request.Request(BASE + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json"})
    if token: req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req) as resp:
            return resp.status, json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:300]

def login(pin):
    st, r = api("POST", "/api/auth/login", None, {"pin": pin})
    assert st == 200, f"login {pin} failed: {r}"
    return r["token"]

ST, KT, MT = login(S), login(K), login(M)
# Test fixture: "Extra lime" 100¢ modifier for BH Mai Tai (money audit requires real menu modifiers)
import sqlite3 as _sq
_con = _sq.connect(DB_PATH)
_mai_id = _con.execute("SELECT id FROM menu_items WHERE name='BH Mai Tai' AND site_id='bali-hai'").fetchone()
if _mai_id:
    _con.execute("INSERT OR IGNORE INTO menu_modifiers (item_id, name, price_delta_cents) VALUES (?, 'Extra lime', 100)", (_mai_id[0],))
    _con.commit()
_con.close()
checks, fails = 0, []
def ok(cond, name, detail=""):
    global checks
    checks += 1
    if not cond:
        fails.append(f"FAIL: {name} {detail}")
        print(f"  x {name} {detail}")
    else:
        print(f"  + {name}")

# ---- money helpers (hand-computed, mirror of documented rules) ----
# NOTE: the server uses JS Math.round (round-half-up); Python's round() is
# banker's rounding, so we implement half-up explicitly for .5 cases.
import math as _math
def _rhu(x): return _math.floor(x + 0.5)
def line(qty, unit, mods=()): return qty * unit + qty * sum(mods)
def totals(sub, guests):
    sur = _rhu(sub * 0.05)
    svc = _rhu(sub * 0.18) if guests >= 8 else 0
    tax = _rhu((sub + sur) * 0.0775)
    return {"subtotal": sub, "surcharge": sur, "service_charge": svc, "tax": tax, "total": sub + sur + svc + tax}
def assert_totals(c, exp, name):
    for k in ("subtotal", "surcharge", "service_charge", "tax", "total"):
        ok(c[f"{k}_cents"] == exp[k], f"{name} {k}", f"got {c[f'{k}_cents']} want {exp[k]}")

def free_tables(n):
    st, zones = api("GET", "/api/zones", ST)
    assert st == 200
    free = [t for z in zones for t in z["tables"] if not t["open_check_id"]]
    assert len(free) >= n, f"need {n} free tables, have {len(free)}"
    return free[:n]

def menu_by_name():
    st, cats = api("GET", "/api/menu", ST)
    assert st == 200
    m = {}
    for c in cats:
        for i in c["items"]:
            m[i["name"]] = i
    return m

def open_check(table_id, guests, tab=None):
    st, c = api("POST", "/api/checks", ST, {"table_id": table_id, "guest_count": guests, "tab_name": tab})
    assert st == 201, f"open check failed: {c}"
    return c

def add_item(cid, menu_id, seat, qty=1, mods=()):
    st, it = api("POST", f"/api/checks/{cid}/items", ST,
                 {"menu_item_id": menu_id, "seat": seat, "qty": qty, "modifiers": list(mods)})
    assert st == 201, f"add item failed: {it}"
    return it

def get_check(cid):
    st, c = api("GET", f"/api/checks/{cid}", ST)
    assert st == 200, f"get check failed: {c}"
    return c

def pay_full(cid, token):
    c = get_check(cid)
    bal = c["totals"]["balance"]
    if bal > 0:
        st, r = api("POST", f"/api/checks/{cid}/payments", token, {"method": "cash", "amount_cents": bal})
        assert st == 201, f"pay failed: {r}"
    st, r = api("POST", f"/api/checks/{cid}/close", token)
    assert st == 200, f"close failed: {r}"

# =====================================================================
print("== 1. Daypart menu switching ==")
st, dp = api("GET", "/api/dayparts", ST)
ok(st == 200, "GET /api/dayparts 200")
ok(dp["tz"] == "America/Los_Angeles", "site tz", dp.get("tz"))
ok(isinstance(dp["schedule"], list) and len(dp["schedule"]) == 3, "default 3-window schedule")
# Expected current window computed from the server's own timestamp (deterministic).
srv_now = datetime.fromisoformat(dp["now"].replace("Z", "+00:00"))
la_hm = srv_now.astimezone(ZoneInfo("America/Los_Angeles")).strftime("%H:%M")
exp_cur = None
for w in dp["schedule"]:
    s, e = w["start"], w["end"]
    inside = (s <= la_hm < e) if e > s else (la_hm >= s or la_hm < e)
    if inside:
        exp_cur = w["name"]; break
ok(dp["current"] == exp_cur, "current window matches clock", f"server={dp['current']} expected={exp_cur} la={la_hm}")
st, menu = api("GET", "/api/menu", ST)
ok(st == 200, "menu 200")
ok(all("daypart" in i for c in menu for i in c["items"]), "every menu item carries daypart")
ok(any((i.get("daypart") or "") != "" for c in menu for i in c["items"]), "some items have a daypart")
st, _ = api("PUT", "/api/admin/dayparts", ST, {"schedule": []})
ok(st == 403, "daypart config is manager-only (server 403)")
st, _ = api("PUT", "/api/admin/dayparts", MT, {"schedule": [{"name": "X", "start": "nope", "end": "25:00"}]})
ok(st == 400, "bad HH:MM rejected")
custom = [{"name": "BRUNCH", "start": "09:00", "end": "14:00", "also": ["BAR"]}]
st, r = api("PUT", "/api/admin/dayparts", MT, {"schedule": custom})
ok(st == 200 and r["schedule"][0]["name"] == "BRUNCH", "manager can set schedule")
st, dp2 = api("GET", "/api/dayparts", ST)
ok(dp2["schedule"][0]["name"] == "BRUNCH", "schedule persists")
# restore defaults
st, r = api("PUT", "/api/admin/dayparts", MT, {"schedule": [
    {"name": "LUNCH", "start": "11:00", "end": "16:00", "also": ["BAR", "KEIKI", "DESSERTS"]},
    {"name": "HAPPY HOUR", "start": "16:00", "end": "18:00", "also": ["BAR"]},
    {"name": "DINNER", "start": "18:00", "end": "22:00", "also": ["BAR", "DESSERTS"]}]})
ok(st == 200, "defaults restored")

# =====================================================================
print("== 2. Table timers / turn-time tracking ==")
st, t0 = api("GET", "/api/floor/timers", ST)
ok(st == 200 and t0["turn_time_target_min"] == 90, "timers endpoint, default 90min target")
t = free_tables(1)[0]
c = open_check(t["id"], 2, "QA timers")
st, t1 = api("GET", "/api/floor/timers", ST)
row = next((r for r in t1["tables"] if r["check_id"] == c["id"]), None)
ok(row is not None, "new check appears in timers")
ok(row["elapsed_min"] >= 0 and row["turn_status"] == "ok", "fresh table status ok", str(row))
ok(row["table_label"] == t["label"] and row["guest_count"] == 2, "timer row carries table/guests")
# age the check 130 min via DB to exercise watch/over thresholds
import sqlite3
con = sqlite3.connect(DB_PATH); con.execute("UPDATE checks SET opened_at = datetime('now','-130 minutes') WHERE id = ?", (c["id"],)); con.commit(); con.close()
st, t2 = api("GET", "/api/floor/timers", ST)
row2 = next((r for r in t2["tables"] if r["check_id"] == c["id"]), None)
ok(row2["elapsed_min"] >= 125 and row2["turn_status"] == "over", "130min-old table is over target", str({k: row2[k] for k in ("elapsed_min","turn_status")}))
st, _ = api("PUT", "/api/admin/floor/config", ST, {"turn_time_target_min": 60})
ok(st == 403, "floor config is manager-only")
st, _ = api("PUT", "/api/admin/floor/config", MT, {"turn_time_target_min": 10})
ok(st == 400, "target below 15min rejected")
st, r = api("PUT", "/api/admin/floor/config", MT, {"turn_time_target_min": 160})
ok(st == 200 and r["turn_time_target_min"] == 160, "manager sets target 160")
st, t3 = api("GET", "/api/floor/timers", ST)
ok(t3["turn_time_target_min"] == 160, "target persists")
row3 = next((r for r in t3["tables"] if r["check_id"] == c["id"]), None)
ok(row3["turn_status"] == "watch", "130min vs 160min target = watch", row3["turn_status"])
st, _ = api("PUT", "/api/admin/floor/config", MT, {"turn_time_target_min": 90})
ok(st == 200, "target restored to 90")
pay_full(c["id"], ST)

# =====================================================================
print("== 3. Guest renaming on checks ==")
t = free_tables(1)[0]
c = open_check(t["id"], 3, "QA names")
cid = c["id"]
st, r = api("PUT", f"/api/checks/{cid}/seats/1/name", ST, {"name": "Maria"})
ok(st == 200 and r["seat_names"].get("1") == "Maria", "rename seat 1")
st, r = api("PUT", f"/api/checks/{cid}/seats/2/name", ST, {"name": "  Theo  "})
ok(r["seat_names"].get("2") == "Theo", "name is trimmed")
st, _ = api("PUT", f"/api/checks/{cid}/seats/9/name", ST, {"name": "X"})
ok(st == 400, "seat beyond guest_count rejected")
st, _ = api("PUT", f"/api/checks/{cid}/seats/1/name", ST, {"name": "N" * 41})
ok(st == 400, "41-char name rejected")
st, _ = api("PUT", f"/api/checks/{cid}/seats/1/name", KT, {"name": "Nope"})
ok(st == 403, "kitchen cannot rename guests")
st, r = api("PUT", f"/api/checks/{cid}/seats/2/name", ST, {"name": ""})
ok(st == 200 and "2" not in r["seat_names"], "empty name clears the seat name")
g = get_check(cid)
ok(g["seat_names"].get("1") == "Maria", "seat_names ride on check GET")
# names follow a by_seat split
MITEMS = menu_by_name()
mai = MITEMS["BH Mai Tai"]["id"]; burger = MITEMS["The Cheese Burger"]["id"]
add_item(cid, mai, 1); add_item(cid, burger, 2)
st, r = api("POST", f"/api/checks/{cid}/split", ST, {"mode": "by_seat", "groups": [[1], [2]]})
ok(st == 200 and len(r["checks"]) == 2, "by_seat split 200")
g1, g2 = get_check(r["checks"][0]), get_check(r["checks"][1])
names = {}
for g in (g1, g2):
    names.update(g["seat_names"])
ok(names.get("1") == "Maria", "Maria's name followed her seat through the split", str(names))
for g in (g1, g2):
    pay_full(g["id"], ST)

# =====================================================================
print("== 4. Edit fired orders ==")
t = free_tables(1)[0]
c = open_check(t["id"], 2, "QA edit")
cid = c["id"]
mai_price = MITEMS["BH Mai Tai"]["price_cents"]
it = add_item(cid, mai, 1, qty=1)
# held item: server may edit without manager PIN
st, r = api("PATCH", f"/api/checks/{cid}/items/{it['id']}", ST, {"qty": 2})
ok(st == 200 and r["item"]["qty"] == 2 and not r["fired"], "held qty edit by server, no PIN")
assert_totals(get_check(cid), totals(line(2, mai_price), 2), "held edit totals")
st, _ = api("PATCH", f"/api/checks/{cid}/items/{it['id']}", ST, {"qty": 2})
ok(st == 400, "no-change edit rejected")
st, _ = api("PATCH", f"/api/checks/{cid}/items/999999", ST, {"qty": 2})
ok(st == 404, "unknown item 404")
# fire it
st, sent = api("POST", f"/api/checks/{cid}/send", ST)
ok(st == 200 and sent["sent"] == 1, "sent 1 item")
bar_station = MITEMS["BH Mai Tai"]["station"]
# fired item without PIN -> 403
st, _ = api("PATCH", f"/api/checks/{cid}/items/{it['id']}", ST, {"qty": 3})
ok(st == 403, "fired edit without manager PIN -> 403")
st, _ = api("PATCH", f"/api/checks/{cid}/items/{it['id']}", KT, {"qty": 3, "manager_pin": M})
ok(st == 403, "kitchen role blocked even with PIN")
# fired item with manager PIN -> 200, totals move by exact cents
st, r = api("PATCH", f"/api/checks/{cid}/items/{it['id']}", ST, {"qty": 3, "manager_pin": M})
ok(st == 200 and r["item"]["qty"] == 3 and r["fired"] and r["kds_deltas"] >= 1, "fired qty edit w/ PIN, KDS delta queued")
assert_totals(get_check(cid), totals(line(3, mai_price), 2), "fired edit totals hand-computed")
# audit trail: approval_audit row with before/after
st, audit = api("GET", "/api/admin/approvals/audit?limit=3", MT)
row = next((a for a in audit if a["action"] == "edit_item" and a["item_id"] == it["id"]), None)
ok(row is not None, "edit_item in approval audit")
before, after = json.loads(row["before_json"]), json.loads(row["after_json"])
ok(before["qty"] == 2 and after["qty"] == 3, "audit before/after qty", f"{before}->{after}")
ok(row["approver"] is not None, "manager approver recorded")
# KDS ticket carries the highlighted delta
st, tk = api("GET", f"/api/kds/tickets?station={bar_station}&status=open", KT)
ok(st == 200, "kds tickets 200")
tickets = tk if isinstance(tk, list) else tk.get("tickets", [])
tick = next((x for x in tickets if x["check_id"] == cid), None)
ok(tick is not None and any(d.get("type") == "edit" and d.get("item_id") == it["id"] and d["before"]["qty"] == 2 and d["after"]["qty"] == 3 for d in tick.get("deltas", [])), "KDS delta highlights the qty change", str(tick.get("deltas"))[:160] if tick else "no ticket")
# modifier edit on fired item
st, r = api("PATCH", f"/api/checks/{cid}/items/{it['id']}", ST,
            {"modifiers": [{"name": "Extra lime", "price_delta_cents": 100}], "manager_pin": M})
ok(st == 200, "fired modifier edit w/ PIN")
assert_totals(get_check(cid), totals(line(3, mai_price, (100,)), 2), "modifier edit totals")
# seat edit on fired item
st, r = api("PATCH", f"/api/checks/{cid}/items/{it['id']}", ST, {"seat": 2, "manager_pin": M})
ok(st == 200 and r["item"]["seat"] == 2, "fired seat edit w/ PIN")
st, _ = api("PATCH", f"/api/checks/{cid}/items/{it['id']}", ST, {"qty": 0, "manager_pin": M})
ok(st == 400, "qty 0 rejected")
pay_full(cid, ST)

# =====================================================================
print("== 5. Tap-and-drop visual splitting (move between checks) ==")
ta, tb = free_tables(2)
ca, cb = open_check(ta["id"], 2, "QA split A"), open_check(tb["id"], 2, "QA split B")
# names attach once at seat level
api("PUT", f"/api/checks/{ca['id']}/seats/2/name", ST, {"name": "Priya"})
ia1 = add_item(ca["id"], mai, 1)
ia2 = add_item(ca["id"], burger, 2)
ib1 = add_item(cb["id"], mai, 1)
sub_a = line(1, mai_price) + line(1, MITEMS["The Cheese Burger"]["price_cents"])
sub_b = line(1, mai_price)
# drag ia2 from A onto B: one POST, both totals move by exact cents
st, r = api("POST", f"/api/checks/{ca['id']}/split", ST, {"mode": "move", "item_ids": [ia2["id"]], "target": cb["id"]})
ok(st == 200 and r["checks"] == [cb["id"]], "move item A->B 200")
assert_totals(get_check(ca["id"]), totals(line(1, mai_price), 2), "A totals after drag-off")
assert_totals(get_check(cb["id"]), totals(sub_b + line(1, MITEMS["The Cheese Burger"]["price_cents"]), 2), "B totals after drag-on")
gb = get_check(cb["id"])
ok(gb["seat_names"].get("2") == "Priya", "guest name followed the dragged item")
ok(any(i["id"] == ia2["id"] and i["seat"] == 2 for i in gb["items"]), "dragged item kept its seat")
# move to a brand-new check still works
st, r = api("POST", f"/api/checks/{ca['id']}/split", ST, {"mode": "move", "item_ids": [ia1["id"]], "target": "new"})
ok(st == 200 and len(r["checks"]) == 1, "move to new check")
# 3-tap even split: totals must partition exactly
tc = open_check(free_tables(1)[0]["id"], 4, "QA even")
add_item(tc["id"], mai, 1); add_item(tc["id"], mai, 2); add_item(tc["id"], burger, 3); add_item(tc["id"], burger, 4)
whole = totals(2 * line(1, mai_price) + 2 * line(1, MITEMS["The Cheese Burger"]["price_cents"]), 4)
st, r = api("POST", f"/api/checks/{tc['id']}/split", ST, {"mode": "even", "parts": 2})
ok(st == 200 and len(r["checks"]) == 2, "even split 2 ways")
parts = [get_check(x) for x in r["checks"]]
ok(sum(p["subtotal_cents"] for p in parts) == whole["subtotal"], "even split partitions the subtotal exactly")
for p in parts:
    assert_totals(p, totals(p["subtotal_cents"], p["guest_count"]), "even split part")
# split blocked once payments exist
pay_c = open_check(free_tables(1)[0]["id"], 2, "QA splitpay")
add_item(pay_c["id"], mai, 1)
c0 = get_check(pay_c["id"])
api("POST", f"/api/checks/{pay_c['id']}/payments", ST, {"method": "cash", "amount_cents": 100})
st, _ = api("POST", f"/api/checks/{pay_c['id']}/split", ST, {"mode": "even", "parts": 2})
ok(st == 400, "split blocked after payments")
for x in (ca["id"], cb["id"], r["checks"][0], r["checks"][1], *[p["id"] for p in parts], pay_c["id"]):
    try: pay_full(x, ST)
    except Exception: pass

# =====================================================================
print("== 6. Merge parties ==")
ta, tb = free_tables(2)
ca, cb = open_check(ta["id"], 2, "QA merge keep"), open_check(tb["id"], 3, "QA merge absorb")
api("PUT", f"/api/checks/{ca['id']}/seats/1/name", ST, {"name": "Ana"})
api("PUT", f"/api/checks/{cb['id']}/seats/2/name", ST, {"name": "Zed"})
add_item(ca["id"], mai, 1)
add_item(cb["id"], burger, 2)
add_item(cb["id"], mai, 3)
# fire on the absorbed check so we can verify KDS headers re-point
api("POST", f"/api/checks/{cb['id']}/send", ST)
sub = line(1, mai_price) + line(1, MITEMS["The Cheese Burger"]["price_cents"]) + line(1, mai_price)
st, r = api("POST", f"/api/checks/{ca['id']}/merge", ST, {"source_check_ids": [cb["id"]]})
ok(st == 200 and r["merged_into"] == ca["id"] and r["closed"] == [cb["id"]], "merge 200")
m = r["check"]
ok(m["guest_count"] == 5, "guest counts summed", str(m["guest_count"]))
ok(len([i for i in m["items"] if i["state"] != "cancelled"]) == 3, "all 3 items on merged check")
seats = sorted(i["seat"] for i in m["items"] if i["state"] != "cancelled")
ok(seats == [1, 4, 5], "absorbed seats remapped by offset", str(seats))
ok(m["seat_names"].get("1") == "Ana" and m["seat_names"].get("4") == "Zed", "guest names remapped with seats", str(m["seat_names"]))
assert_totals(m, totals(sub, 5), "merged totals hand-computed")
ok(cb["id"] in m["merged_from"], "merge provenance recorded")
g_closed = get_check(cb["id"])
ok(g_closed["status"] == "closed", "absorbed check closed")
# KDS open tickets from the absorbed check re-point at the surviving table
st, tk = api("GET", f"/api/kds/tickets?station={MITEMS['The Cheese Burger']['station']}&status=open", KT)
tickets = tk if isinstance(tk, list) else tk.get("tickets", [])
tick = next((x for x in tickets if x["check_id"] == cb["id"]), None)
ok(tick is not None and tick["table_label"] == ta["label"], "absorbed KDS ticket header re-pointed", str(tick["table_label"]) if tick else "no ticket")
# error paths
st, _ = api("POST", f"/api/checks/{ca['id']}/merge", ST, {"source_check_ids": [cb["id"]]})
ok(st == 400, "cannot merge an already-closed source")
st, _ = api("POST", f"/api/checks/{ca['id']}/merge", ST, {"source_check_ids": [ca["id"]]})
ok(st == 400, "self-merge rejected")
st, _ = api("POST", f"/api/checks/{ca['id']}/merge", KT, {"source_check_ids": []})
ok(st == 403, "merge is server/manager only")
big1 = open_check(free_tables(1)[0]["id"], 20, "QA big1")
big2 = open_check(free_tables(1)[0]["id"], 5, "QA big2")
st, _ = api("POST", f"/api/checks/{big1['id']}/merge", ST, {"source_check_ids": [big2["id"]]})
ok(st == 400, "25-guest merge rejected")
for x in (big1["id"], big2["id"]):
    st, _ = api("POST", f"/api/checks/{x}/close", ST); ok(st == 200, "empty big check closed")
pay_full(ca["id"], ST)

# =====================================================================
print("== 7. Move checks between tables ==")
ta, tb = free_tables(2)
c = open_check(ta["id"], 2, "QA move")
add_item(c["id"], mai, 1)
api("POST", f"/api/checks/{c['id']}/send", ST)
st, r = api("POST", f"/api/checks/{c['id']}/move", ST, {"table_id": tb["id"]})
ok(st == 200 and r["check"]["table_id"] == tb["id"], "move 200, table_id updated")
ok(r["check"]["table_label"] == tb["label"], "table_label updated")
st, tk = api("GET", f"/api/kds/tickets?station={bar_station}&status=open", KT)
tickets = tk if isinstance(tk, list) else tk.get("tickets", [])
tick = next((x for x in tickets if x["check_id"] == c["id"]), None)
ok(tick is not None and tick["table_label"] == tb["label"], "KDS ticket header updated itself", str(tick["table_label"]) if tick else "no ticket")
st, zones = api("GET", "/api/zones", ST)
t_a = next(t for z in zones for t in z["tables"] if t["id"] == ta["id"])
t_b = next(t for z in zones for t in z["tables"] if t["id"] == tb["id"])
ok(t_a["open_check_id"] is None and t_b["open_check_id"] == c["id"], "old table freed, new table occupied")
st, _ = api("POST", f"/api/checks/{c['id']}/move", ST, {"table_id": tb["id"]})
ok(st == 400, "move to same table rejected")
tc = open_check(ta["id"], 2, "QA move blocker")
st, _ = api("POST", f"/api/checks/{c['id']}/move", ST, {"table_id": ta["id"]})
ok(st == 400, "move onto occupied table rejected")
st, _ = api("POST", f"/api/checks/{c['id']}/move", ST, {"table_id": 999999})
ok(st == 404, "move to unknown table 404")
st, _ = api("POST", f"/api/checks/{c['id']}/move", KT, {"table_id": ta["id"]})
ok(st == 403, "move is server/manager only")
pay_full(tc["id"], ST)
pay_full(c["id"], ST)

# ======================================================================
# 8. Frontend wiring (static assertions — every UI capability present)
# ======================================================================
print("\n== 8. Frontend UI wiring ==")
PUB = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "public")
def read(p):
    with open(os.path.join(PUB, p), encoding="utf-8") as f: return f.read()
po = read("views/parity_orders.js")
app = read("app.js")
idx = read("index.html")
css = read("styles.css")

ok("window.ParityOrders" in po, "parity_orders.js exposes window.ParityOrders")
ok("(function () {" in po, "parity_orders.js is IIFE-wrapped")
for fn in ["openDaypartPicker", "filterMenuByDaypart", "timerChip", "openRenameSeatModal",
           "openEditItemModal", "deltaHtml", "openVisualSplit", "openMergePicker"]:
    ok(fn in po, "ParityOrders exports " + fn)
ok("views/parity_orders.js" in idx, "index.html loads parity_orders.js")
ok(idx.index("views/parity_orders.js") < idx.index("app.js"), "script load order correct")
ok("dp-pill" in app, "daypart auto pill on order view")
ok("openDaypartPicker" in app, "daypart override picker wired")
ok("floor/timers" in app and "timerChip" in app, "floor timer badges wired")
ok('id="floor-merge"' in app and 'id="floor-move"' in app, "floor merge/move mode buttons")
ok("openRenameSeatModal" in app and 'id="seat-rename"' in app, "seat rename affordance")
ok("data-edit=" in app and "openEditItemModal" in app, "fired-item edit buttons")
ok('id="split-visual"' in app and "openVisualSplit" in app, "visual split button")
ok('id="merge-into"' in app and "openMergePicker" in app, "merge picker button")
ok("deltaHtml" in app, "KDS highlighted deltas rendered")
ok('id="dp-save"' in app, "daypart schedule config in menu editor")
ok('id="turn-target"' in app and "admin/floor/config" in app, "turn-target config in manager view")
for sel in [".timer-chip", ".t-delta", ".vs-col", ".floor-banner", ".seat-chip .guest-nm"]:
    ok(sel in css, "styles.css has " + sel)

# =====================================================================
print("\n== 9. NG-B: full-check void (manager-PIN-gated, audited) ==")
t9 = free_tables(3)
vc = open_check(t9[0]["id"], 2)
menu = menu_by_name()
vnames = list(menu.keys())
vh1 = add_item(vc["id"], menu[vnames[0]]["id"], 1, 1)
st, _ = api("POST", f"/api/checks/{vc['id']}/send", ST, {})
assert st == 200, f"send for void test failed: {_}"
vh2 = add_item(vc["id"], menu[vnames[1]]["id"], 2, 1)  # stays held
# missing reason -> 400
st, r = api("POST", f"/api/checks/{vc['id']}/void", MT, {})
ok(st == 400, "void without reason 400")
# server without PIN -> 403 need_manager_pin
st, r = api("POST", f"/api/checks/{vc['id']}/void", ST, {"reason": "walked out"})
ok(st == 403, "void as server without PIN 403")
# server with wrong PIN -> 403
st, r = api("POST", f"/api/checks/{vc['id']}/void", ST, {"reason": "walked out", "manager_pin": "0000"})
ok(st == 403, "void as server with wrong PIN 403")
# kitchen cannot void -> 403 (role)
st, r = api("POST", f"/api/checks/{vc['id']}/void", KT, {"reason": "x", "manager_pin": M})
ok(st == 403, "void as kitchen 403")
# server with valid manager PIN -> 200
st, r = api("POST", f"/api/checks/{vc['id']}/void", ST, {"reason": "walked out", "manager_pin": M})
ok(st == 200, "void as server with manager PIN 200", str(r)[:120])
ok(r.get("status") == "void", "void response status void")
ok(r.get("voided_items") == 2, "voided 2 lines", str(r.get("voided_items")))
ok(r.get("kds_deltas") == 1, "KDS delta for the 1 fired line", str(r.get("kds_deltas")))
ok(r.get("approved_by") == "Manager", "void approved_by manager", str(r.get("approved_by")))
vc2 = get_check(vc["id"])
ok(vc2["status"] == "void", "check status void after void")
ok(all(i["state"] == "cancelled" for i in vc2["items"]), "all lines cancelled")
# repeat void -> 400
st, r = api("POST", f"/api/checks/{vc['id']}/void", MT, {"reason": "again"})
ok(st == 400, "double void 400")
# void with payments -> 400 route_to_refund (partial payment keeps check open)
pc = open_check(t9[1]["id"], 2)
add_item(pc["id"], menu[vnames[0]]["id"], 1, 1)
st, _ = api("POST", f"/api/checks/{pc['id']}/send", ST, {})
assert st == 200
c0 = get_check(pc["id"])
st, _ = api("POST", f"/api/checks/{pc['id']}/payments", ST, {"method": "cash", "amount_cents": 100})
assert st == 201, f"partial pay failed: {_}"
st, r = api("POST", f"/api/checks/{pc['id']}/void", MT, {"reason": "oops"})
ok(st == 400, "void with payments 400")
try:
    rj = json.loads(r) if isinstance(r, str) else r
    ok(rj.get("route_to_refund") is True, "void with payments routes to refund")
except Exception:
    ok(False, "void with payments routes to refund", str(r)[:100])
# audit log records the void
st, al = api("GET", "/api/admin/approvals/audit?limit=50", MT)
ok(st == 200, "audit log readable")
rows = al if isinstance(al, list) else []
ok(any("void" in json.dumps(a).lower() for a in rows), "void appears in audit log")

# =====================================================================
print("\n== 10. NG-E: order-level + modifier-level notes -> KDS ==")
t10 = free_tables(2)
nc = open_check(t10[0]["id"], 2)
# order_note via PATCH
st, r = api("PATCH", f"/api/checks/{nc['id']}", ST, {"order_note": "Allergy table — confirm with server"})
ok(st == 200, "PATCH order_note 200")
ok(r.get("order_note") == "Allergy table — confirm with server", "order_note round-trips")
# 500-char limit
st, r = api("PATCH", f"/api/checks/{nc['id']}", ST, {"order_note": "x" * 501})
ok(st == 400, "order_note >500 chars 400")
# clear order_note
st, r = api("PATCH", f"/api/checks/{nc['id']}", ST, {"order_note": None})
ok(st == 200 and r.get("order_note") is None, "order_note clears to null")
st, r = api("PATCH", f"/api/checks/{nc['id']}", ST, {"order_note": "Allergy table — confirm with server"})
assert st == 200
# item with modifier note + line note + allergy (use The Cheese Burger which has the "Add bacon" modifier)
mi = menu["The Cheese Burger"]
st, it = api("POST", f"/api/checks/{nc['id']}/items", ST, {
    "menu_item_id": mi["id"], "seat": 1, "qty": 1,
    "modifiers": [{"name": "Add bacon", "price_delta_cents": 100, "note": "light on the cheese"}],
    "note": "no onions", "allergy": True, "allergy_detail": "peanut"})
ok(st == 201, "add item with modifier note 201", str(it)[:150])
ok(it["modifiers"][0].get("note") == "light on the cheese", "modifier note preserved")
ok(it.get("note") == "no onions" and it.get("allergy") is True, "line note + allergy preserved")
# modifier note 60-char limit
st, r = api("POST", f"/api/checks/{nc['id']}/items", ST, {
    "menu_item_id": mi["id"], "seat": 1, "qty": 1,
    "modifiers": [{"name": "Add bacon", "price_delta_cents": 100, "note": "y" * 61}]})
ok(st == 400, "modifier note >60 chars 400")
st, _ = api("POST", f"/api/checks/{nc['id']}/send", ST, {})
assert st == 200
st, tickets = api("GET", "/api/kds/tickets", KT)
ok(st == 200, "KDS tickets readable")
mine = [t for t in tickets if t.get("check_id") == nc["id"]]
ok(len(mine) >= 1, "KDS ticket exists for the check")
tk = mine[0]
ok(tk.get("order_note") == "Allergy table — confirm with server", "order_note on KDS ticket")
titems = tk.get("items", [])
ok(any((m.get("note") == "light on the cheese") for li in titems for m in (li.get("modifiers") or [])), "modifier note on KDS ticket")
ok(any(li.get("note") == "no onions" for li in titems), "line note on KDS ticket")
ok(any(li.get("allergy") for li in titems), "allergy flag on KDS ticket")

# =====================================================================
print("\n== 11. NG-D: popular / quick-pick flag ==")
pop_item = menu[vnames[0]]
st, r = api("PUT", f"/api/admin/menu/items/{pop_item['id']}/popular", ST, {"popular": True})
ok(st == 403, "popular flag as server 403")
st, r = api("PUT", f"/api/admin/menu/items/{pop_item['id']}/popular", MT, {"popular": True})
ok(st == 200, "popular flag as manager 200")
st, cats = api("GET", "/api/menu", ST)
found = [i for c in cats for i in c["items"] if i["id"] == pop_item["id"]]
ok(found and found[0].get("popular") is True, "/api/menu exposes popular=true")
st, r = api("PUT", f"/api/admin/menu/items/{pop_item['id']}/popular", MT, {"popular": False})
ok(st == 200, "popular flag clears 200")
st, cats = api("GET", "/api/menu", ST)
found = [i for c in cats for i in c["items"] if i["id"] == pop_item["id"]]
ok(found and found[0].get("popular") is False, "popular=false round-trips")

# =====================================================================
print("\n== 12. send-now atomicity (correct contract) ==")
t12 = free_tables(1)
sc = open_check(t12[0]["id"], 2)
st, r = api("POST", f"/api/checks/{sc['id']}/send-now", ST, {"items": [
    {"menu_item_id": menu[vnames[0]]["id"], "seat": 1, "qty": 2},
    {"menu_item_id": menu[vnames[1]]["id"], "seat": 2, "qty": 1, "note": "extra napkins"}]})
ok(st == 201, "send-now {items:[...]} 201", str(r)[:150])
ok(isinstance(r.get("items"), list) and len(r["items"]) == 2, "send-now returns items array")
sc2 = get_check(sc["id"])
ok(all(i["state"] == "sent" for i in sc2["items"]), "send-now lines arrive fired")
ok(any(i.get("note") == "extra napkins" for i in sc2["items"]), "send-now preserves line note")
# wrong (legacy bare-object) contract -> 400
st, r = api("POST", f"/api/checks/{sc['id']}/send-now", ST, {"menu_item_id": menu[vnames[0]]["id"]})
ok(st == 400, "send-now bare object 400")

# =====================================================================
print("\n== 13. item PATCH: course / note / allergy / seat (NG-C item-first) ==")
t13 = free_tables(1)
ec = open_check(t13[0]["id"], 3)
ei = add_item(ec["id"], menu[vnames[0]]["id"], 1, 2)
# item-first seat assignment: move a held line to another guest
st, r = api("PATCH", f"/api/checks/{ec['id']}/items/{ei['id']}", ST, {"seat": 3})
ok(st == 200, "PATCH item seat 200")
ok(r["item"]["seat"] == 3, "item-first seat assignment sticks")
# course + note + allergy on held line (no PIN needed)
st, r = api("PATCH", f"/api/checks/{ec['id']}/items/{ei['id']}", ST,
            {"course": "entree", "note": "well done", "allergy": True, "allergy_detail": "shellfish"})
ok(st == 200, "PATCH course/note/allergy 200")
ok(r["item"]["course"] == "entree" and r["item"]["note"] == "well done", "course + note saved")
ok(r["item"]["allergy"] is True and r["item"]["allergy_detail"] == "shellfish", "allergy saved")
# invalid course -> 400
st, r = api("PATCH", f"/api/checks/{ec['id']}/items/{ei['id']}", ST, {"course": "brunch"})
ok(st == 400, "PATCH invalid course 400")
# fired line edit needs manager PIN
st, _ = api("POST", f"/api/checks/{ec['id']}/send", ST, {})
assert st == 200
st, r = api("PATCH", f"/api/checks/{ec['id']}/items/{ei['id']}", ST, {"qty": 1})
ok(st == 403, "fired edit without PIN 403")
st, r = api("PATCH", f"/api/checks/{ec['id']}/items/{ei['id']}", ST, {"qty": 1, "manager_pin": M})
ok(st == 200, "fired edit with manager PIN 200")
ok(r["item"]["qty"] == 1, "fired qty edit applied")
ok("kds_deltas" in r, "fired edit returns kds_deltas")

# =====================================================================
print("\n== 14. item discount + repeat ==")
t14 = free_tables(1)
dc = open_check(t14[0]["id"], 2)
di = add_item(dc["id"], menu[vnames[0]]["id"], 1, 2)
unit = menu[vnames[0]]["price_cents"]
# held-line discount by a server (audited, no PIN)
st, r = api("POST", f"/api/checks/{dc['id']}/items/{di['id']}/discount", ST,
            {"amount_cents": 200, "reason": "happy hour"})
ok(st == 200, "held discount amount 200")
ok(r["discount_cents"] == 200, "discount_cents recorded")
# percent discount on a fresh line
di2 = add_item(dc["id"], menu[vnames[1]]["id"], 1, 1)
unit2 = menu[vnames[1]]["price_cents"]
st, r = api("POST", f"/api/checks/{dc['id']}/items/{di2['id']}/discount", ST,
            {"percent": 50, "reason": "comp dessert"})
ok(st == 200, "percent discount 200")
import math as _m2
ok(r["discount_cents"] == _m2.floor(unit2 * 0.5 + 0.5), "percent discount math (half-up)")
# discount without reason -> 400
st, r = api("POST", f"/api/checks/{dc['id']}/items/{di2['id']}/discount", ST, {"amount_cents": 100})
ok(st == 400, "discount without reason 400")
# amount AND percent -> 400
st, r = api("POST", f"/api/checks/{dc['id']}/items/{di2['id']}/discount", ST,
            {"amount_cents": 100, "percent": 10, "reason": "x"})
ok(st == 400, "discount amount+percent 400")
# fired-line discount needs manager PIN
st, _ = api("POST", f"/api/checks/{dc['id']}/send", ST, {})
assert st == 200
st, r = api("POST", f"/api/checks/{dc['id']}/items/{di['id']}/discount", ST,
            {"amount_cents": 100, "reason": "mgr comp"})
ok(st == 403, "fired discount without PIN 403")
st, r = api("POST", f"/api/checks/{dc['id']}/items/{di['id']}/discount", ST,
            {"amount_cents": 100, "reason": "mgr comp", "manager_pin": M})
ok(st == 200, "fired discount with PIN 200")
# repeat / duplicate
st, r = api("POST", f"/api/checks/{dc['id']}/items/{di['id']}/duplicate", ST, {})
ok(st == 201, "duplicate 201")
ok(r.get("menu_item_id") == di["menu_item_id"] and r.get("qty") == di["qty"], "duplicate copies line")
ok(r.get("state") == "held", "duplicate starts held")
ok(not r.get("discount_cents"), "duplicate drops discount")

# =====================================================================
print("\n== 15. split: qty division + manager-PIN fallback ==")
import sqlite3 as _sq
t15 = free_tables(2)
qc = open_check(t15[0]["id"], 2)
qi = add_item(qc["id"], menu[vnames[0]]["id"], 1, 4)
# qty division: move 1 of 4 onto a new check
st, r = api("POST", f"/api/checks/{qc['id']}/split", ST, {"mode": "move", "item_ids": [qi["id"]], "target": "new", "qty": 1})
ok(st == 200, "move with qty division 200", str(r)[:150])
src = get_check(qc["id"])
moved = [i for i in src["items"] if i["id"] == qi["id"]]
ok(moved and moved[0]["qty"] == 3, "source line keeps 3")
news = r.get("checks") or r.get("splits") or []
ok(len(news) == 1, "one new check created")
new_id = news[0]["id"] if isinstance(news[0], dict) else news[0]
dst = get_check(new_id)
ok(sum(i["qty"] for i in dst["items"] if i["menu_item_id"] == qi["menu_item_id"]) == 1, "new check gets 1")
# manager-PIN fallback: staffer without split_allowed
st, emp = api("POST", "/api/admin/employees", MT, {"name": "NoSplit", "role": "server", "pin": "9999"})
assert st in (200, 201), f"create employee failed: {emp}"
_con = _sq.connect(DB_PATH); _con.execute("UPDATE users SET split_allowed = 0 WHERE pin = '9999'"); _con.commit(); _con.close()
NT = login("9999")
fc = open_check(t15[1]["id"], 2)
add_item(fc["id"], menu[vnames[0]]["id"], 1, 1)
st, r = api("POST", f"/api/checks/{fc['id']}/split", NT, {"mode": "even", "parts": 2})
ok(st == 403, "split without permission 403")
try:
    rj = json.loads(r) if isinstance(r, str) else r
    ok(rj.get("need_manager_pin") is True, "split 403 carries need_manager_pin")
except Exception:
    ok(False, "split 403 carries need_manager_pin", str(r)[:100])
st, r = api("POST", f"/api/checks/{fc['id']}/split", NT, {"mode": "even", "parts": 2, "manager_pin": M})
ok(st == 200, "split with manager PIN fallback 200")

# =====================================================================
print("\n== 16. coursing prompt (409) on send ==")
t16 = free_tables(1)
cc = open_check(t16[0]["id"], 2)
st, r = api("PATCH", f"/api/checks/{cc['id']}", ST, {"coursing": "required"})
ok(st == 200, "PATCH coursing=required 200")
add_item(cc["id"], menu[vnames[0]]["id"], 1, 1)
ci2 = add_item(cc["id"], menu[vnames[1]]["id"], 1, 1)
st, _ = api("PATCH", f"/api/checks/{cc['id']}/items/{ci2['id']}", ST, {"course": "dessert"})
assert st == 200
st, r = api("POST", f"/api/checks/{cc['id']}/send", ST, {})
ok(st == 409, "send spanning courses 409")
try:
    rj = json.loads(r) if isinstance(r, str) else r
    ok(rj.get("need_course_selection") is True, "409 carries need_course_selection")
except Exception:
    ok(False, "409 carries need_course_selection", str(r)[:100])
st, r = api("POST", f"/api/checks/{cc['id']}/send", ST, {"courses": ["dessert"]})
ok(st == 200 and r.get("sent") == 1, "send with courses fires one course")
st, r = api("POST", f"/api/checks/{cc['id']}/send", ST, {"courses": ["all"]})
ok(st == 200, "send with courses=['all'] 200")

# =====================================================================
print("\n== 17. check metadata PATCH ==")
t17 = free_tables(1)
mc = open_check(t17[0]["id"], 2)
st, r = api("PATCH", f"/api/checks/{mc['id']}", ST,
            {"guest_count": 5, "tab_name": "Daniel", "coursing": "optional"})
ok(st == 200, "PATCH metadata 200")
ok(r.get("guest_count") == 5 and r.get("tab_name") == "Daniel" and r.get("coursing") == "optional", "metadata round-trips")
st, r = api("PATCH", f"/api/checks/{mc['id']}", ST, {"guest_count": 0})
ok(st == 400, "guest_count 0 rejected 400")
st, r = api("PATCH", f"/api/checks/{mc['id']}", KT, {"tab_name": "x"})
ok(st == 403, "metadata PATCH as kitchen 403")

# =====================================================================
print("\n== 18. frontend UI wiring (new Phase 3A surfaces) ==")
for marker, label in [
    ("id=\"sel-bar\"", "cart selection action bar"),
    ("id=\"btn-sendnow\"", "SEND NOW button"),
    ("id=\"quick-pick\"", "quick-pick row"),
    ("id=\"check-settings\"", "check settings button"),
    ("Void check", "void-check UI"),
    ("id=\"cs-note\"", "order note field"),
    ("need_course_selection", "course prompt handling"),
    ("need_manager_pin", "split PIN fallback handling"),
    ("data-mq=\"dec\"", "move qty stepper"),
    ("id=\"mi-groups\"", "modifier-group manager UI"),
    ("id=\"mi-popular\"", "popular flag checkbox"),
    ("id=\"ei-course\"", "edit-modal course field"),
    ("id=\"ei-note\"", "edit-modal note field"),
    ("id=\"ei-allergy\"", "edit-modal allergy field"),
    ("id=\"ei-dval\"", "edit-modal discount field"),
    ("id=\"ei-repeat\"", "edit-modal repeat button"),
    ("data-emn=", "per-modifier note inputs"),
]:
    ok(marker in app or marker in po, label)
ok("openEditItemModal" in po, "edit modal lives in parity_orders.js")
# frontend globals guard still passes (IIFE / window exposure)
ok("(function () {" in po, "parity_orders.js still IIFE-wrapped")

print("\n{0}/{1} assertions passed".format(checks - len(fails), checks))
if fails:
    for f in fails: print(f)
    sys.exit(1)
print("ALL GREEN")
