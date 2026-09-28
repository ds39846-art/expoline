#!/usr/bin/env python3
"""
Expoline — paid-with-balance check reopen QA (test32).

POST /api/checks/:id/reopen {manager_pin}
  - A 'paid' check that still carries a positive balance (e.g. a refund that
    could not auto-reopen because the table was re-seated, and the re-seating
    check has since been voided) is otherwise stuck: payments are refused
    ('Cannot take payment on a paid check') and close is refused
    ('outstanding balance remains'). The reopen endpoint gives it an exit.
  - Requires a FRESH manager PIN every time (like whole-check void).
  - Refused (409) when the table has since been re-seated again, to protect
    the one-open-staff-claim-per-table index (claim/overlap P0).
  - Only 'paid' checks with balance > 0 may reopen (400 otherwise).
  - Audit-logged as 'reopen_check'.

Manages its own server on port 4337 with a fresh DB. Never touches 4317/4320.
Usage: python3 qa/test32_check_reopen.py
"""
import json
import os
import signal
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.request
import urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.join(HERE, "..", "server.js")
PORT = int(os.environ.get("EXPOLINE_TEST_PORT", "4337"))
DB = os.environ.get("EXPOLINE_TEST_DB", "/tmp/expoline-reopen-test32.db")
BASE = f"http://localhost:{PORT}"

if PORT in (4317, 4320):
    sys.exit("FATAL: test 32 refuses ports 4317/4320 (demo/soak ports)")

PASSES = 0
FAILS = []


def check(name, cond, extra=""):
    global PASSES
    if cond:
        PASSES += 1
        print(f"  PASS {name}")
    else:
        FAILS.append(name)
        print(f"  FAIL {name} {extra}")


def spawn():
    if os.path.exists(DB):
        os.remove(DB)
    env = dict(os.environ, EXPOLINE_PORT=str(PORT), EXPOLINE_DB=DB, NODE_ENV="test")
    p = subprocess.Popen(["node", SERVER], env=env,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(60):
        try:
            with urllib.request.urlopen(BASE + "/api/health", timeout=2) as r:
                if r.status == 200:
                    return p
        except Exception:
            time.sleep(0.5)
    stop(p)
    sys.exit("FATAL: test server did not come up")


def stop(p):
    if p and p.poll() is None:
        p.send_signal(signal.SIGTERM)
        try:
            p.wait(timeout=10)
        except subprocess.TimeoutExpired:
            p.kill()


def api(method, path, token=None, body=None):
    req = urllib.request.Request(BASE + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json"})
    if token:
        req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode())
        except Exception:
            return e.code, {}


def dbsql(q, args=()):
    con = sqlite3.connect(DB)
    try:
        return con.execute(q, args).fetchall()
    finally:
        con.close()


def login(pin):
    s, r = api("POST", "/api/auth/login", body={"pin": pin})
    assert s == 200 and r.get("token"), r
    return r["token"], r.get("user", {}).get("id")


def free_table(tok):
    s, zones = api("GET", "/api/zones", token=tok)
    assert s == 200, zones
    for z in zones:
        for t in z.get("tables", []):
            if not t.get("open_check_id"):
                return t["id"]
    raise AssertionError("no free table")


def menu_item():
    rows = dbsql("SELECT id FROM menu_items WHERE active = 1 LIMIT 1")
    assert rows, "no active menu item"
    return rows[0][0]


def make_paid_check(st, mt, table_id):
    """Open a check, add one item, pay it in full -> status 'paid', balance 0."""
    s, r = api("POST", "/api/checks", token=st, body={"table_id": table_id, "guest_count": 2})
    assert s == 201, r
    cid = r["id"]
    s, _ = api("POST", f"/api/checks/{cid}/items", token=st,
               body={"menu_item_id": menu_item(), "seat": 1, "qty": 1})
    assert s in (200, 201), s
    s, c = api("GET", f"/api/checks/{cid}", token=st)
    bal = c["totals"]["balance"]
    s, _ = api("POST", f"/api/checks/{cid}/payments", token=st,
               body={"method": "cash", "amount_cents": bal})
    assert s in (200, 201), s
    s, c = api("GET", f"/api/checks/{cid}", token=st)
    assert c["status"] == "paid", c["status"]
    return cid, c["totals"]["total"]


def refund_all(mt, cid):
    rows = dbsql("SELECT id FROM payments WHERE check_id = ? AND refunded_cents < amount_cents", (cid,))
    for (pid,) in rows:
        s, r = api("POST", f"/api/payments/{pid}/refund", token=mt, body={})
        assert s == 200, (s, r)
    return rows


def raw_open_check(table_id, server_id):
    con = sqlite3.connect(DB)
    try:
        site = con.execute("SELECT site_id FROM tables LIMIT 1").fetchone()[0]
        cur = con.execute(
            "INSERT INTO checks (uuid, site_id, table_id, server_id, guest_count, status, opened_at)"
            " VALUES (hex(randomblob(16)), ?, ?, ?, 2, 'open', datetime('now'))",
            (site, table_id, server_id))
        con.commit()
        return cur.lastrowid
    finally:
        con.close()


def status_of(tok, cid):
    s, c = api("GET", f"/api/checks/{cid}", token=tok)
    assert s == 200, (s, c)
    return c["status"], c["totals"]["balance"]


def main():
    print("== test32: paid-with-balance check reopen ==")
    p = spawn()
    try:
        MT, _ = login("2580")
        ST, S1 = login("1111")

        # --- T1: refund auto-reopen still works when the table is NOT re-seated ---
        t1 = free_table(ST)
        c1, total1 = make_paid_check(ST, MT, t1)
        s, r = refund_all(MT, c1), None
        st, bal = status_of(ST, c1)
        check("auto-reopen fires when table not re-seated", st == "open" and bal == total1,
              f"status={st} bal={bal} total={total1}")
        # and the reopened check can then be closed normally (no need for /reopen)
        s, _ = api("POST", f"/api/checks/{c1}/payments", token=ST,
                   body={"method": "cash", "amount_cents": bal})
        check("reopened check payable", s in (200, 201), str(s))
        s, _ = api("POST", f"/api/checks/{c1}/close", token=ST, body={})
        check("reopened check closable", s == 200, str(s))

        # --- T2: the zombie path — re-seat blocks auto-reopen, /reopen unblocks ---
        t2 = free_table(ST)
        c2, total2 = make_paid_check(ST, MT, t2)
        reseat = raw_open_check(t2, S1)  # table re-seated while c2 was being refunded
        refund_all(MT, c2)
        st, bal = status_of(ST, c2)
        check("re-seat blocks auto-reopen (stays paid)", st == "paid" and bal == total2,
              f"status={st} bal={bal}")
        # the zombie is truly stuck: no payment, no close
        s, r = api("POST", f"/api/checks/{c2}/payments", token=ST,
                   body={"method": "cash", "amount_cents": bal})
        check("zombie refuses payment", s == 400, f"{s} {r}")
        s, r = api("POST", f"/api/checks/{c2}/close", token=ST, body={})
        check("zombie refuses close", s == 400, f"{s} {r}")

        # unblock: void the re-seating check, then reopen needs a fresh PIN
        s, r = api("POST", f"/api/checks/{reseat}/void", token=MT,
                   body={"reason": "qa cleanup", "manager_pin": "2580"})
        assert s == 200, (s, r)
        s, r = api("POST", f"/api/checks/{c2}/reopen", token=ST, body={"manager_pin": "2580"})
        check("server token cannot use reopen (managerOnly)", s == 403, f"{s} {r}")
        s, r = api("POST", f"/api/checks/{c2}/reopen", token=MT, body={})
        check("reopen without fresh PIN -> 403", s == 403 and r.get("need_manager_pin") is True,
              f"{s} {r}")
        s, r = api("POST", f"/api/checks/{c2}/reopen", token=MT, body={"manager_pin": "0000"})
        check("reopen with wrong PIN -> 403", s == 403, f"{s} {r}")
        s, r = api("POST", f"/api/checks/{c2}/reopen", token=MT, body={"manager_pin": "2580"})
        check("reopen with fresh PIN -> 200", s == 200 and r.get("status") == "open",
              f"{s} {r}")
        st, bal = status_of(ST, c2)
        check("check is open with balance after reopen", st == "open" and bal == total2,
              f"status={st} bal={bal}")
        # audit trail
        rows = dbsql("SELECT action FROM approval_audit WHERE check_id = ? ORDER BY id DESC LIMIT 1", (c2,))
        check("reopen audit-logged", rows and rows[0][0] == "reopen_check", str(rows))
        # zombie exit now works: pay + close
        s, _ = api("POST", f"/api/checks/{c2}/payments", token=ST,
                   body={"method": "cash", "amount_cents": bal})
        check("reopened zombie payable", s in (200, 201), str(s))
        s, _ = api("POST", f"/api/checks/{c2}/close", token=ST, body={})
        check("reopened zombie closable", s == 200, str(s))
        s, r = api("POST", f"/api/checks/{c2}/reopen", token=MT, body={"manager_pin": "2580"})
        check("reopen a closed check -> 400", s == 400, f"{s} {r}")

        # --- T3: reopen refuses checks with no outstanding balance ---
        t3 = free_table(ST)
        c3, _ = make_paid_check(ST, MT, t3)  # paid, balance 0
        s, r = api("POST", f"/api/checks/{c3}/reopen", token=MT, body={"manager_pin": "2580"})
        check("reopen paid check with zero balance -> 400", s == 400, f"{s} {r}")
        s, r = api("POST", "/api/checks/999999/reopen", token=MT, body={"manager_pin": "2580"})
        check("reopen unknown check -> 404", s == 404, f"{s} {r}")

        # --- T4: re-seat guard — reopen 409 while another open check holds the table ---
        t4 = free_table(ST)
        c4, total4 = make_paid_check(ST, MT, t4)
        reseat2 = raw_open_check(t4, S1)
        refund_all(MT, c4)
        st, _ = status_of(ST, c4)
        assert st == "paid", st
        s, r = api("POST", f"/api/checks/{c4}/reopen", token=MT, body={"manager_pin": "2580"})
        check("reopen blocked by live re-seat -> 409",
              s == 409 and r.get("open_check_id") == reseat2, f"{s} {r}")
        st, _ = status_of(ST, c4)
        check("blocked check stays paid", st == "paid", st)
        # cleanup: void the re-seat, reopen, pay, close
        s, r = api("POST", f"/api/checks/{reseat2}/void", token=MT,
                   body={"reason": "qa cleanup", "manager_pin": "2580"})
        assert s == 200, (s, r)
        s, r = api("POST", f"/api/checks/{c4}/reopen", token=MT, body={"manager_pin": "2580"})
        check("reopen succeeds once re-seat cleared", s == 200, f"{s} {r}")
        st, bal = status_of(ST, c4)
        s, _ = api("POST", f"/api/checks/{c4}/payments", token=ST,
                   body={"method": "cash", "amount_cents": bal})
        s, _ = api("POST", f"/api/checks/{c4}/close", token=ST, body={})
        check("T4 check fully settled", s == 200, str(s))

        # --- T5: concurrent reopens — exactly one wins, the other gets 4xx (no crash) ---
        t5 = free_table(ST)
        c5, total5 = make_paid_check(ST, MT, t5)
        reseat3 = raw_open_check(t5, S1)
        refund_all(MT, c5)
        s, r = api("POST", f"/api/checks/{reseat3}/void", token=MT,
                   body={"reason": "qa cleanup", "manager_pin": "2580"})
        assert s == 200, (s, r)
        results = []

        def race():
            s, r = api("POST", f"/api/checks/{c5}/reopen", token=MT,
                       body={"manager_pin": "2580"})
            results.append((s, r.get("status")))

        ths = [threading.Thread(target=race) for _ in range(4)]
        for th in ths:
            th.start()
        for th in ths:
            th.join()
        wins = [x for x in results if x[0] == 200]
        check("exactly one concurrent reopen wins", len(wins) == 1, str(results))
        check("losers get 4xx not 500", all(x[0] in (400, 409) for x in results if x[0] != 200),
              str(results))
        st, bal = status_of(ST, c5)
        s, _ = api("POST", f"/api/checks/{c5}/payments", token=ST,
                   body={"method": "cash", "amount_cents": bal})
        s, _ = api("POST", f"/api/checks/{c5}/close", token=ST, body={})
        check("T5 check fully settled", s == 200, str(s))

        # --- T6: no open checks left behind on any test table ---
        n = dbsql("SELECT COUNT(*) FROM checks WHERE status = 'open'")[0][0]
        check("no open checks leak", n == 0, str(n))
    finally:
        stop(p)

    print(f"\ntest32: {PASSES} passed, {len(FAILS)} failed")
    if FAILS:
        print("FAILURES:", FAILS)
        sys.exit(1)


if __name__ == "__main__":
    main()
