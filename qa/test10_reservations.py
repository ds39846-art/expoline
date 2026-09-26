#!/usr/bin/env python3
"""Expoline — QA Test 10: native reservations + waitlist (floor-plan integrated)."""
import json, sys, urllib.request, urllib.error, urllib.parse
from datetime import datetime, timedelta, timezone

BASE = "http://localhost:4322"
S = "1111"; M = "2580"

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

ST = login(S); MT = login(M)
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
    ok(st == want, name, f"(got {st} {txt[:160]})")
    return st, txt

now = datetime.now(timezone.utc)
def iso(dt): return dt.isoformat()
def day(): return now.strftime("%Y-%m-%d")

print("== Test 10a: create reservation ==")
t1 = iso(now + timedelta(hours=2))
r1 = api("POST", "/api/reservations", ST, {"customer_name": "QA Guest", "phone": "(619) 555-0100",
        "party_size": 4, "reserved_at": t1, "table_id": 1, "notes": "anniversary"})
ok(r1.get("status") == "booked", "reservation booked", str(r1.get("id")))
ok(bool(r1.get("uuid")), "reservation has uuid")
ok(r1.get("table_label"), "table label joined", str(r1.get("table_label")))
ok(r1.get("no_show_count") == 0, "no-show count 0 for new phone")
R1 = r1["id"]

print("== Test 10b: overlap prevention ==")
t_overlap = iso(now + timedelta(hours=2, minutes=30))
expect_status("POST", "/api/reservations", ST,
    {"customer_name": "Clash", "party_size": 2, "reserved_at": t_overlap, "table_id": 1}, 409, "overlapping booking rejected (409)")
r2 = api("POST", "/api/reservations", ST, {"customer_name": "Later", "party_size": 2,
        "reserved_at": iso(now + timedelta(hours=4)), "table_id": 1})
ok(r2.get("status") == "booked", "non-overlapping booking on same table OK")
R2 = r2["id"]
r3 = api("POST", "/api/reservations", ST, {"customer_name": "Other table", "party_size": 2,
        "reserved_at": t_overlap, "table_id": 2})
ok(r3.get("status") == "booked", "same time on different table OK")
R3 = r3["id"]

print("== Test 10c: validation ==")
expect_status("POST", "/api/reservations", ST, {"party_size": 2, "reserved_at": t1}, 400, "name required (400)")
expect_status("POST", "/api/reservations", ST, {"customer_name": "X", "party_size": 0, "reserved_at": t1}, 400, "party_size 0 rejected")
expect_status("POST", "/api/reservations", ST, {"customer_name": "X", "party_size": 2, "reserved_at": "not-a-date"}, 400, "bad datetime rejected")
expect_status("POST", "/api/reservations", ST, {"customer_name": "X", "party_size": 2, "reserved_at": iso(now - timedelta(hours=5))}, 400, "far-past datetime rejected")
st, _ = api("GET", "/api/reservations?date=bogus", ST, raw=True)
ok(st == 400, "bad date param rejected (400)")

print("== Test 10d: day listing ==")
lst = api("GET", f"/api/reservations?date={day()}", ST)
ok(isinstance(lst, list) and len(lst) >= 3, "day list returns bookings", str(len(lst)))
ok(all(lst[i]["reserved_at"] <= lst[i+1]["reserved_at"] for i in range(len(lst)-1)), "bookings ordered by time")

print("== Test 10e: floor availability ==")
av = api("GET", "/api/floor/availability?datetime=" + urllib.parse.quote(t1) + "&party_size=4", ST)
ok("tables" in av and len(av["tables"]) > 10, "availability returns tables", str(len(av.get("tables", []))))
t1row = next((t for t in av["tables"] if t["id"] == 1), None)
ok(t1row is not None and t1row["status"] == "booked", "table 1 shows booked for the slot", str(t1row and t1row["status"]))
ok(t1row and t1row["reservation"] and t1row["reservation"]["customer_name"] == "QA Guest", "booked table carries reservation detail")
ok(t1row and "x" in t1row and "shape" in t1row and "zone" in t1row, "table carries x/y/shape/zone")
sug = [t for t in av["tables"] if t.get("suggested")]
ok(1 <= len(sug) <= 3, "1–3 suggested tables", str(len(sug)))
ok(all(t["status"] == "free" for t in sug), "suggestions are free tables")
ok(all(t["seats"] >= 4 for t in sug), "suggestions fit party of 4")

print("== Test 10f: waitlist add → notify → seat (one-tap check) ==")
w = api("POST", "/api/waitlist", ST, {"customer_name": "Walk-in QA", "phone": "6195550199", "party_size": 3, "quoted_wait_min": 15})
ok(w.get("status") == "waiting", "waitlist entry waiting", str(w.get("id")))
ok(bool(w.get("uuid")), "waitlist entry has uuid")
WID = w["id"]
wl = api("GET", "/api/waitlist", ST)
ok(any(x["id"] == WID for x in wl), "entry appears in waitlist")
n = api("POST", f"/api/waitlist/{WID}/notify", ST)
ok(n.get("status") == "notified" and n.get("notified_at"), "entry notified with timestamp")
seat = api("POST", f"/api/waitlist/{WID}/seat", ST, {"table_id": 5})
ok("check_id" in seat and seat["check_id"], "seat returns check_id", str(seat.get("check_id")))
ok(seat["entry"]["status"] == "seated", "entry marked seated")
ck = api("GET", f"/api/checks/{seat['check_id']}", ST)
ok(ck.get("status") == "open" and ck.get("table_id") == 5 and ck.get("guest_count") == 3, "open check auto-created on table 5 for 3 guests")
expect_status("POST", f"/api/waitlist/{WID}/seat", ST, {"table_id": 6}, 400, "re-seat of seated entry rejected (400)")

print("== Test 10g: reservation → seated opens check ==")
seated = api("PATCH", f"/api/reservations/{R1}", ST, {"status": "seated"})
ok(seated.get("status") == "seated", "reservation seated")
ok(seated.get("check_id"), "seated response carries check_id", str(seated.get("check_id")))
ck2 = api("GET", f"/api/checks/{seated['check_id']}", ST)
ok(ck2.get("status") == "open" and ck2.get("table_id") == 1 and ck2.get("guest_count") == 4, "check opened on reserved table for party of 4")

print("== Test 10h: roles — no-show + delete are manager-only ==")
expect_status("PATCH", f"/api/reservations/{R3}", ST, {"status": "no_show"}, 403, "server cannot mark no-show (403)")
expect_status("PATCH", f"/api/reservations/{R3}", ST, {"status": "cancelled"}, 403, "server cannot cancel (403)")
expect_status("DELETE", f"/api/reservations/{R3}", ST, None, 403, "server cannot DELETE (403)")
ns = api("PATCH", f"/api/reservations/{R3}", MT, {"status": "no_show"})
ok(ns.get("status") == "no_show", "manager marks no-show")
lst2 = api("GET", f"/api/reservations?date={day()}", ST)
r3row = next((x for x in lst2 if x["id"] == R3), None)
ok(r3row and r3row["status"] == "no_show", "no-show persisted on row")
# no-show history surfaces on repeat booking with same phone
r4 = api("POST", "/api/reservations", ST, {"customer_name": "Repeat", "phone": "619-555-0100",
        "party_size": 2, "reserved_at": iso(now + timedelta(hours=6)), "table_id": 3})
ok(r4.get("no_show_count") == 0, "QA Guest phone has 0 no-shows (R1 was seated, not no-show)")
# mark a phone-number no-show then rebook
r5 = api("POST", "/api/reservations", ST, {"customer_name": "Flaky", "phone": "6195550200",
        "party_size": 2, "reserved_at": iso(now + timedelta(hours=7)), "table_id": 4})
api("PATCH", f"/api/reservations/{r5['id']}", MT, {"status": "no_show"})
r6 = api("POST", "/api/reservations", ST, {"customer_name": "Flaky Again", "phone": "(619) 555-0200",
        "party_size": 2, "reserved_at": iso(now + timedelta(hours=8)), "table_id": 4})
ok(r6.get("no_show_count") == 1, "no-show count 1 surfaced on repeat booking", str(r6.get("no_show_count")))
dl = api("DELETE", f"/api/reservations/{R2}", MT)
ok(dl.get("status") == "cancelled", "manager DELETE cancels")
expect_status("DELETE", f"/api/reservations/{R2}", MT, None, 400, "double-cancel rejected (400)")

print("== Test 10i: PATCH table reassignment overlap-checked ==")
# r7 overlaps R1's window on table 1 (+2h → +3.5h); moving there must fail
r7 = api("POST", "/api/reservations", ST, {"customer_name": "Mover", "party_size": 2,
        "reserved_at": iso(now + timedelta(hours=2, minutes=45)), "table_id": 6})
expect_status("PATCH", f"/api/reservations/{r7['id']}", ST, {"table_id": 1}, 409,
    "reassign into booked slot rejected (409)")
mv = api("PATCH", f"/api/reservations/{r7['id']}", ST, {"table_id": 7})
ok(mv.get("table_id") == 7, "reassign to free table OK")

print("== Test 10j: waitlist roles ==")
w2 = api("POST", "/api/waitlist", ST, {"customer_name": "Temp", "party_size": 2})
expect_status("DELETE", f"/api/waitlist/{w2['id']}", ST, None, 403, "server cannot DELETE waitlist (403)")
lf = api("PATCH", f"/api/waitlist/{w2['id']}", ST, {"status": "left"})
ok(lf.get("status") == "left", "server can mark left")
w3 = api("POST", "/api/waitlist", ST, {"customer_name": "Temp2", "party_size": 2})
rm = api("DELETE", f"/api/waitlist/{w3['id']}", MT)
ok(rm.get("deleted") == w3["id"], "manager can remove waitlist entry")

print(f"\n{checks - len(fails)}/{checks} passed")
if fails:
    print("\n".join(fails)); sys.exit(1)
print("ALL GREEN")
