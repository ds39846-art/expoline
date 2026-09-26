#!/usr/bin/env python3
"""Expoline — QA Test 26: OpenTable integration (phase 6), sandbox mode.

End-to-end against the local sandbox stub (OPENTABLE_MODE=sandbox, the default):
lock -> make -> update -> cancel partner callbacks, idempotent retries,
conflict prevention vs native bookings, one-tap seating of OT parties from the
floor plan, outbound capture, reconciliation, availability publishing, FRN
recovery, and production-mode fail-closed behavior (no credentials).

The test starts its own servers (sandbox on 4330, production-mode on 4331)
with fresh DBs and shuts them down afterwards.
"""
import json, os, shutil, signal, subprocess, sys, time, urllib.request, urllib.error, urllib.parse
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
BASE = "http://localhost:4330"
BASE_PROD = "http://localhost:4331"
S, M = "1111", "2580"
OT_KEY = "sandbox-partner-key"
RID = "OT-QA-123"

def api(base, method, path, token=None, body=None, headers=None, raw=False):
    req = urllib.request.Request(base + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json"})
    if token: req.add_header("Authorization", "Bearer " + token)
    for k, v in (headers or {}).items(): req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return (resp.status, resp.read().decode()) if raw else json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        return (e.code, e.read().decode()) if raw else json.loads(e.read().decode() or "{}")

checks, fails = 0, []
def ok(cond, name, detail=""):
    global checks
    checks += 1
    if not cond:
        fails.append(f"FAIL: {name} {detail}")
        print(f"  X {name} {detail}")
    else:
        print(f"  + {name}")

def expect_status(base, method, path, token, body, want, name, headers=None):
    st, txt = api(base, method, path, token, body, headers=headers, raw=True)
    ok(st == want, name, f"(got {st} {txt[:160]})")
    return st, txt

def spawn(port, db, extra_env):
    for f in (db, db + "-wal", db + "-shm"):
        try: os.unlink(f)
        except FileNotFoundError: pass
    env = dict(os.environ, EXPOLINE_PORT=str(port), EXPOLINE_DB=db, **extra_env)
    p = subprocess.Popen(["node", "server.js"],
                         cwd=REPO, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return p

def wait_up(base, secs=60):
    t0 = time.time()
    while time.time() - t0 < secs:
        try:
            st, _ = api(base, "GET", "/api/health", raw=True)
            if st == 200: return True
        except Exception: pass
        time.sleep(0.5)
    return False

procs = []
try:
    print("== boot sandbox (4330) + production-mode (4331) servers ==")
    procs.append(spawn(4330, "/tmp/ot-qa-4330.db", {}))
    procs.append(spawn(4331, "/tmp/ot-qa-4331.db", {"OPENTABLE_MODE": "production"}))
    ok(wait_up(BASE), "sandbox server up on 4330")
    ok(wait_up(BASE_PROD), "production-mode server up on 4331")

    ST = api(BASE, "POST", "/api/auth/login", None, {"pin": S})["token"]
    MT = api(BASE, "POST", "/api/auth/login", None, {"pin": M})["token"]
    ok(bool(ST) and bool(MT), "staff + manager login")
    OTH = {"X-Partner-Key": OT_KEY}
    now = datetime.now(timezone.utc)
    def iso(dt): return dt.isoformat()
    def day(): return now.strftime("%Y-%m-%d")

    print("== 26a: link restaurant + status ==")
    link = api(BASE, "POST", "/api/admin/opentable/link", MT, {"opentable_rid": RID, "environment": "sandbox"})
    ok(link.get("linked") and link.get("opentable_rid") == RID, "restaurant linked to OT RID", RID)
    ok(link.get("mode") == "sandbox", "mode defaults to sandbox")
    status = api(BASE, "GET", "/api/admin/opentable/status", ST)
    ok(status.get("linked") and status.get("mode") == "sandbox", "status shows linked + sandbox")
    ok(status.get("credentials_present") is False, "no production credentials present (honest)")
    expect_status(BASE, "POST", "/api/admin/opentable/link", ST, {"opentable_rid": "x"}, 403, "server cannot link (manager-only)")

    print("== 26b: callback auth ==")
    t0 = iso(now + timedelta(hours=3))
    expect_status(BASE, "POST", "/api/opentable/lock", None, {"party_size": 2, "reserved_at": t0}, 401, "lock without partner key rejected (401)")

    print("== 26c: lock (best-efforts hold) ==")
    lock = api(BASE, "POST", "/api/opentable/lock", None, {"party_size": 2, "reserved_at": t0}, headers={**OTH, "X-Request-Id": "req-lock-1"})
    ok(bool(lock.get("lock_id")) and lock.get("table_id"), "lock granted on a table", str(lock.get("table_label")))
    LOCK_ID, LOCK_TABLE = lock["lock_id"], lock["table_id"]
    lock2 = api(BASE, "POST", "/api/opentable/lock", None, {"party_size": 2, "reserved_at": t0}, headers={**OTH, "X-Request-Id": "req-lock-1"})
    ok(lock2.get("replayed") and lock2.get("lock_id") == LOCK_ID, "same X-Request-Id replays the lock, no duplicate")
    expect_status(BASE, "POST", "/api/opentable/lock", None, {"party_size": 0, "reserved_at": t0}, 400, "lock rejects bad party_size (400)", headers=OTH)
    expect_status(BASE, "POST", "/api/opentable/lock", None, {"party_size": 2, "reserved_at": "nope"}, 400, "lock rejects bad datetime (400)", headers=OTH)

    print("== 26d: lock blocks native booking on the same slot ==")
    expect_status(BASE, "POST", "/api/reservations", ST,
        {"customer_name": "Native Clash", "party_size": 2, "reserved_at": t0, "table_id": LOCK_TABLE},
        409, "native booking on OT-locked table rejected (409)")

    print("== 26e: make (OT party -> native reservation) ==")
    make = api(BASE, "POST", "/api/opentable/reservations", None,
        {"opentable_rid": RID, "confirmation_number": "OT-QA-1", "lock_id": LOCK_ID,
         "name": "OpenTable Diner", "phone": "(619) 555-0142", "party_size": 2,
         "reserved_at": t0, "notes": "birthday", "seating_preferences": "window, high chair",
         "email": "diner@example.com"},
        headers={**OTH, "X-Request-Id": "req-make-1"})
    ok(make.get("source") == "opentable", "reservation tagged source=opentable")
    ok(make.get("confirmation_number") == "OT-QA-1", "confirmation number carried through")
    ok("[OpenTable #OT-QA-1]" in (make.get("notes") or ""), "OT confirmation stamped in notes")
    ok("Seating: window, high chair" in (make.get("notes") or ""), "seating preferences mapped to notes")
    ok("birthday" in (make.get("notes") or ""), "diner notes mapped")
    ok(make.get("phone") == "6195550142", "phone normalized to digits")
    ok(make.get("table_id") == LOCK_TABLE, "lock's table consumed by make")
    ok(make.get("ot_confirmation_number") == "OT-QA-1", "resvView exposes ot_confirmation_number")
    OTID = make["id"]

    print("== 26f: idempotent retries (OT retries 3x on failure) ==")
    day_before = [r for r in api(BASE, "GET", f"/api/reservations?date={day()}", ST)
                  if r.get("ot_confirmation_number") == "OT-QA-1"]
    for i in (2, 3):
        r = api(BASE, "POST", "/api/opentable/reservations", None,
            {"opentable_rid": RID, "confirmation_number": "OT-QA-1", "name": "OpenTable Diner",
             "party_size": 2, "reserved_at": t0}, headers={**OTH, "X-Request-Id": "req-make-1"})
        ok(r.get("replayed") and r.get("id") == OTID, f"retry {i} returns original row, no duplicate")
    day_after = [r for r in api(BASE, "GET", f"/api/reservations?date={day()}", ST)
                 if r.get("ot_confirmation_number") == "OT-QA-1"]
    ok(len(day_before) == 1 and len(day_after) == 1, "exactly one OT row for the confirmation", f"{len(day_after)}")

    print("== 26g: OT party on the floor plan ==")
    av = api(BASE, "GET", "/api/floor/availability?datetime=" + urllib.parse.quote(t0) + "&party_size=2", ST)
    trow = next((t for t in av["tables"] if t["id"] == LOCK_TABLE), None)
    ok(trow is not None and trow["status"] == "booked", "locked table shows booked on floor plan")
    ok(trow and trow["reservation"] and trow["reservation"]["customer_name"] == "OpenTable Diner", "floor plan carries OT party name")

    print("== 26h: conflicts — OT vs native both directions ==")
    t2 = iso(now + timedelta(hours=5))
    nat = api(BASE, "POST", "/api/reservations", ST,
        {"customer_name": "Native Regular", "party_size": 2, "reserved_at": t2, "table_id": 3})
    ok(nat.get("status") == "booked" and nat.get("source") == "native", "native booking created (source=native)")
    expect_status(BASE, "POST", "/api/opentable/reservations", None,
        {"opentable_rid": RID, "confirmation_number": "OT-QA-2", "name": "OT Late",
         "party_size": 2, "reserved_at": iso(now + timedelta(hours=5, minutes=15)),
         "preferred_table_id": 3}, 409, "OT make on natively-booked table rejected (409)", headers=OTH)
    expect_status(BASE, "POST", "/api/opentable/lock", None,
        {"party_size": 2, "reserved_at": iso(now + timedelta(hours=5, minutes=15)), "preferred_table_id": 3},
        409, "OT lock on natively-booked table rejected (409)", headers=OTH)
    expect_status(BASE, "POST", "/api/reservations", ST,
        {"customer_name": "Native Late", "party_size": 2,
         "reserved_at": iso(now + timedelta(hours=3, minutes=15)), "table_id": LOCK_TABLE},
        409, "native booking overlapping OT reservation rejected (409)")
    expect_status(BASE, "POST", "/api/opentable/reservations", None,
        {"name": "No Conf", "party_size": 2, "reserved_at": t0}, 400, "make without confirmation rejected (400)", headers=OTH)
    expect_status(BASE, "PATCH", "/api/opentable/reservations/OT-NOPE", None, {"party_size": 3}, 404, "update of unknown confirmation (404)", headers=OTH)

    print("== 26i: update with sequence LWW ==")
    upd = api(BASE, "PATCH", "/api/opentable/reservations/OT-QA-1", None,
        {"party_size": 3, "sequence": 2}, headers={**OTH, "X-Request-Id": "req-upd-1"})
    ok(upd.get("party_size") == 3 and upd.get("sync_sequence") == 2, "party_size updated, sequence=2")
    stale = api(BASE, "PATCH", "/api/opentable/reservations/OT-QA-1", None,
        {"party_size": 9, "sequence": 1}, headers=OTH)
    ok(stale.get("ignored_stale") and stale.get("party_size") == 3, "stale sequence ignored (LWW)")
    bump = api(BASE, "PATCH", "/api/opentable/reservations/OT-QA-1", None,
        {"notes": "n/a", "sequence": 5}, headers=OTH)
    ok(bump.get("sync_sequence") == 5, "higher sequence applied")

    print("== 26j: one-tap seating of the OT party ==")
    seat = api(BASE, "PATCH", f"/api/reservations/{OTID}", ST, {"status": "seated"})
    ok(seat.get("status") == "seated" and seat.get("check_id"), "one-tap seat opens a check", str(seat.get("check_id")))
    ck = api(BASE, "GET", f"/api/checks/{seat['check_id']}", ST)
    ok(ck.get("status") == "open" and ck.get("guest_count") == 3, "check opened for OT party of 3")
    out = api(BASE, "GET", "/api/admin/opentable/outbound", MT)
    seated_msgs = [m for m in out if m["confirmation_number"] == "OT-QA-1" and "SEATED" in m["payload_json"]]
    ok(len(seated_msgs) >= 1 and all(m["delivered"] == "sandbox" for m in seated_msgs),
       "native seat posted outbound SEATED update (sandbox-captured)")
    echo = [m for m in out if m["confirmation_number"] == "OT-QA-1" and m["action"] == "reservation_update" and "BOOKED" in m["payload_json"]]
    ok(len(echo) >= 1, "echo-back reservation_update captured after make")

    print("== 26k: OT-initiated cancel ==")
    t3 = iso(now + timedelta(hours=7))
    make3 = api(BASE, "POST", "/api/opentable/reservations", None,
        {"opentable_rid": RID, "confirmation_number": "OT-QA-3", "name": "OT Cancel Me",
         "party_size": 2, "reserved_at": t3}, headers=OTH)
    ok(make3.get("status") == "booked", "second OT booking created")
    cxl = api(BASE, "DELETE", "/api/opentable/reservations/OT-QA-3", None, {"opentable_rid": RID}, headers=OTH)
    ok(cxl.get("status") == "cancelled", "OT cancel processed")
    row = next((r for r in api(BASE, "GET", f"/api/reservations?date={day()}", ST) if r.get("ot_confirmation_number") == "OT-QA-3"), None)
    ok(row and row["status"] == "cancelled", "cancel persisted on native row")
    expect_status(BASE, "DELETE", "/api/opentable/reservations/OT-QA-3", None, {"opentable_rid": RID}, 400, "double-cancel rejected (400)", headers=OTH)

    print("== 26l: native manager cancel posts outbound CANCELED ==")
    t4 = iso(now + timedelta(hours=8))
    make4 = api(BASE, "POST", "/api/opentable/reservations", None,
        {"opentable_rid": RID, "confirmation_number": "OT-QA-4", "name": "OT Mgr Cancel",
         "party_size": 2, "reserved_at": t4}, headers=OTH)
    dl = api(BASE, "DELETE", f"/api/reservations/{make4['id']}", MT)
    ok(dl.get("status") == "cancelled", "manager cancels OT booking natively")
    out2 = api(BASE, "GET", "/api/admin/opentable/outbound", MT)
    ok(any(m["confirmation_number"] == "OT-QA-4" and "CANCELED" in m["payload_json"] and m["delivered"] == "sandbox" for m in out2),
       "native cancel posted outbound CANCELED update")

    print("== 26m: reconcile safety net ==")
    rec = api(BASE, "POST", "/api/admin/opentable/reconcile", MT,
        {"ot_bookings": [{"confirmation_number": "OT-QA-1", "ot_state": "SEATED"},
                         {"confirmation_number": "OT-GHOST-9", "ot_state": "BOOKED"},
                         {"confirmation_number": "OT-QA-3", "ot_state": "BOOKED"}]})
    ok("OT-GHOST-9" in rec.get("missing_local", []), "OT booking with no local row flagged (no auto-create)")
    ok("OT-QA-4" in rec.get("missing_ot", []), "local booking missing on OT side flagged")
    ok(any(s["confirmation_number"] == "OT-QA-3" for s in rec.get("state_mismatches", [])), "state mismatch flagged")
    ok(rec.get("checked") == 3, "reconcile checked 3 OT bookings")

    print("== 26n: availability publish (sandbox-captured) ==")
    pub = api(BASE, "POST", "/api/admin/opentable/publish-availability", MT, {"date": day()})
    ok(pub.get("slots_published", 0) > 0, "slot grid published", str(pub.get("slots_published")))
    ok(pub.get("delivered") == "sandbox", "publish captured to sandbox outbox")
    out3 = api(BASE, "GET", "/api/admin/opentable/outbound", MT)
    ok(any(m["action"] == "availability_publish" for m in out3), "availability_publish in outbound log")

    print("== 26o: FRN recovery ==")
    frn = api(BASE, "GET", "/api/opentable/recovery", None, headers=OTH)
    ok(frn.get("online") is True, "recovery reports online:true")

    print("== 26p: production mode fails closed without credentials ==")
    pstatus = api(BASE_PROD, "GET", "/api/admin/opentable/status",
                  api(BASE_PROD, "POST", "/api/auth/login", None, {"pin": M})["token"])
    ok(pstatus.get("mode") == "production", "production mode active on 4331")
    ok(pstatus.get("credentials_present") is False, "credentials honestly reported absent")
    st, txt = api(BASE_PROD, "POST", "/api/opentable/lock", None,
                  {"party_size": 2, "reserved_at": iso(now + timedelta(hours=3))}, headers=OTH, raw=True)
    ok(st == 503 and "OPENTABLE_CLIENT_ID" in txt, "production lock fails closed 503 without credentials")
    st2, txt2 = api(BASE_PROD, "POST", "/api/opentable/reservations", None,
                    {"confirmation_number": "X", "name": "X", "party_size": 2,
                     "reserved_at": iso(now + timedelta(hours=3))}, headers=OTH, raw=True)
    ok(st2 == 503, "production make fails closed 503 without credentials")
    plink = api(BASE_PROD, "POST", "/api/admin/opentable/link",
                api(BASE_PROD, "POST", "/api/auth/login", None, {"pin": M})["token"],
                {"opentable_rid": "RID-PROD", "environment": "production"})
    ok(plink.get("linked") and "credentials" in (plink.get("note") or "").lower(), "production link warns about missing credentials")

finally:
    print("== shutdown ==")
    for p in procs:
        try:
            p.terminate()
            p.wait(timeout=10)
        except Exception:
            try: p.kill()
            except Exception: pass
    # belt-and-suspenders: exact ports only, never pkill
    os.system("lsof -ti:4330 | xargs kill -9 2>/dev/null; lsof -ti:4331 | xargs kill -9 2>/dev/null")

print()
print(f"checks: {checks}, failures: {len(fails)}")
if fails:
    print("\n".join(fails)); sys.exit(1)
print("ALL GREEN")
