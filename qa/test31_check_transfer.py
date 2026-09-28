#!/usr/bin/env python3
"""
Expoline — check transfer / server re-claim QA (test31, claim/overlap §3.6).

POST /api/checks/:id/transfer {to_server_id, from_server_id, manager_pin?, reason?}
  - holder hands off their own check (no PIN)
  - anyone claims an unassigned (kiosk/QR) check (from_server_id null, no PIN)
  - taking someone else's check needs a FRESH manager PIN (audited override)
  - optimistic concurrency on the current holder: exactly one contender wins
    a race; losers get 409 naming the current holder (§3.4 contract)
  - Idempotency-Key replays the stored outcome instead of 409ing a retry

Manages its own server on port 4336 with a fresh DB. Never touches 4317/4320.
Usage: python3 qa/test31_check_transfer.py
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
PORT = int(os.environ.get("EXPOLINE_TEST_PORT", "4336"))
DB = os.environ.get("EXPOLINE_TEST_DB", "/tmp/expoline-transfer-test31.db")
BASE = f"http://localhost:{PORT}"

if PORT in (4317, 4320):
    sys.exit("FATAL: test 31 refuses ports 4317/4320 (demo/soak ports)")

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


def api(method, path, token=None, body=None, headers=None):
    req = urllib.request.Request(BASE + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json"})
    if token:
        req.add_header("Authorization", "Bearer " + token)
    for k, v in (headers or {}).items():
        req.add_header(k, v)
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


def open_check(tok, table_id, server_id=None):
    """Open a check via API (held by the caller) or raw SQL (unassigned)."""
    if server_id == "caller":
        s, r = api("POST", "/api/checks", token=tok,
                   body={"table_id": table_id, "guest_count": 2})
        assert s == 201, r
        return r["id"]
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


def main():
    print("== test31: check transfer / re-claim ==")
    p = spawn()
    try:
        MT, manager_id = login("2580")
        S1T, S1 = login("1111")
        # second server via manager-created employee (locked policy: manager-created only)
        s, emp = api("POST", "/api/admin/employees", token=MT,
                     body={"name": "QA Server Two", "role": "server", "pin": "4242",
                           "employee_number": 142, "wage_rate_cents": 1800})
        assert s == 201, emp
        S2T, S2 = login("4242")
        check("second server created + login", S2 and S2 != S1, str(emp.get("id")))

        # --- T1: holder hands off their own check, no PIN ---
        t1 = free_table(S1T)
        c1 = open_check(S1T, t1, server_id="caller")
        s, r = api("POST", f"/api/checks/{c1}/transfer", token=S1T,
                   body={"to_server_id": S2, "from_server_id": S1, "reason": "shift change"})
        check("holder handoff 200", s == 200 and r.get("server_id") == S2, f"{s} {r}")
        check("handoff not an override", r.get("override") is False, str(r))
        s, c = api("GET", f"/api/checks/{c1}", token=S1T)
        check("check now held by S2", c.get("server_id") == S2, str(c.get("server_id")))

        # --- T2: stale from_server_id -> 409 naming the holder (§3.4) ---
        s, r = api("POST", f"/api/checks/{c1}/transfer", token=S1T,
                   body={"to_server_id": S1, "from_server_id": S1})
        check("stale from_server_id -> 409", s == 409, f"{s} {r}")
        check("409 names current holder", r.get("held_by_id") == S2 and r.get("check_id") == c1, str(r))

        # --- T3: transfer race — the conditional UPDATE arbitrates; exactly one
        #  real winner. Same-target losers converge via noop; other-target
        #  losers get 409 naming the winner. ---
        t3 = free_table(S1T)
        c3 = open_check(S1T, t3, server_id="caller")  # held by S1
        # S2 takes it first so the race is over a check S1 no longer holds
        s, _ = api("POST", f"/api/checks/{c3}/transfer", token=S1T,
                   body={"to_server_id": S2, "from_server_id": S1})
        assert s == 200
        results = []
        def racer(target):
            st, body = api("POST", f"/api/checks/{c3}/transfer", token=S2T,
                           body={"to_server_id": target, "from_server_id": S2})
            results.append((st, body))
        threads = ([threading.Thread(target=racer, args=(S1,)) for _ in range(4)] +
                   [threading.Thread(target=racer, args=(manager_id,)) for _ in range(4)])
        for th in threads: th.start()
        for th in threads: th.join()
        real_wins = [b for st, b in results if st == 200 and not b.get("noop")]
        noops = [b for st, b in results if st == 200 and b.get("noop")]
        losses = [b for st, b in results if st == 409]
        check("race: exactly one real winner", len(real_wins) == 1,
              f"real_wins={len(real_wins)}")
        winner = real_wins[0]["server_id"] if real_wins else None
        check("race: same-target losers converge via noop",
              all(b.get("server_id") == winner for b in noops), f"noops={len(noops)}")
        check("race: other-target losers get 409 naming the winner",
              len(losses) > 0 and all(b.get("held_by_id") == winner and b.get("check_id") == c3
                                      for b in losses),
              str(losses[:1]))
        check("race: 8 outcomes, no errors",
              len(real_wins) + len(noops) + len(losses) == 8,
              str([(st, b.get("error")) for st, b in results]))
        s, c = api("GET", f"/api/checks/{c3}", token=S1T)
        check("race: final holder is the winner", c.get("server_id") == winner,
              str(c.get("server_id")))

        # --- T4: claim an unassigned (kiosk/QR) check; race the claim ---
        t4 = free_table(S1T)
        c4 = open_check(S1T, t4, server_id=None)
        s, r = api("POST", f"/api/checks/{c4}/transfer", token=S1T,
                   body={"to_server_id": S1, "from_server_id": None})
        check("claim unassigned 200, no PIN", s == 200 and r.get("server_id") == S1, f"{s} {r}")
        t4b = free_table(S1T)
        c4b = open_check(S1T, t4b, server_id=None)
        results = []
        def claimer(tok, who):
            st, body = api("POST", f"/api/checks/{c4b}/transfer", token=tok,
                           body={"to_server_id": who, "from_server_id": None})
            results.append((st, body))
        threads = ([threading.Thread(target=claimer, args=(S1T, S1)) for _ in range(3)] +
                   [threading.Thread(target=claimer, args=(S2T, S2)) for _ in range(3)])
        for th in threads: th.start()
        for th in threads: th.join()
        real_wins = [b for st, b in results if st == 200 and not b.get("noop")]
        noops = [b for st, b in results if st == 200 and b.get("noop")]
        losses = [b for st, b in results if st == 409]
        check("claim race: exactly one real winner", len(real_wins) == 1,
              f"real_wins={len(real_wins)}")
        check("claim race: same-target threads converge via noop",
              len(noops) == 2 and all(b.get("server_id") == S1 for b in noops),
              f"noops={len(noops)}")
        check("claim race: other-target losers get 409 naming holder",
              len(losses) == 3 and all(b.get("held_by_id") == S1 for b in losses),
              str(losses[:1]))

        # --- T5: taking someone else's check — 403 without PIN, 200 with fresh manager PIN ---
        t5 = free_table(S1T)
        c5 = open_check(S1T, t5, server_id="caller")  # held by S1
        s, r = api("POST", f"/api/checks/{c5}/transfer", token=S2T,
                   body={"to_server_id": S2, "from_server_id": S1})
        check("non-holder without PIN -> 403", s == 403 and r.get("need_manager_pin") is True, f"{s} {r}")
        s, r = api("POST", f"/api/checks/{c5}/transfer", token=S2T,
                   body={"to_server_id": S2, "from_server_id": S1,
                         "manager_pin": "2580", "reason": "section rebalance"})
        check("manager PIN override 200", s == 200 and r.get("override") is True, f"{s} {r}")
        check("override names approver", r.get("approved_by") is not None, str(r))
        rows = dbsql("SELECT action, details FROM approval_audit WHERE action='check_transfer' AND check_id=?",
                     (c5,))
        check("override audit-logged with before/after",
              len(rows) == 1 and "section rebalance" in (rows[0][1] or ""), str(rows))

        # --- T6: validation ---
        t6 = free_table(S1T)
        c6 = open_check(S1T, t6, server_id="caller")
        s, r = api("POST", f"/api/checks/{c6}/transfer", token=S1T,
                   body={"to_server_id": 999999, "from_server_id": S1})
        check("unknown to_server_id -> 400", s == 400, f"{s} {r}")
        s, r = api("POST", f"/api/checks/{c6}/transfer", token=S1T,
                   body={"to_server_id": S2})
        check("missing from_server_id -> 400", s == 400, f"{s} {r}")
        s, r = api("POST", f"/api/checks/{c6}/transfer", token=S1T,
                   body={"to_server_id": S1, "from_server_id": S1})
        check("noop transfer -> 200 noop:true", s == 200 and r.get("noop") is True, f"{s} {r}")
        s, r = api("POST", "/api/checks/999999/transfer", token=S1T,
                   body={"to_server_id": S2, "from_server_id": S1})
        check("unknown check -> 404", s == 404, f"{s} {r}")
        con = sqlite3.connect(DB)
        con.execute("UPDATE checks SET status='paid' WHERE id=?", (c6,))
        con.commit(); con.close()
        s, r = api("POST", f"/api/checks/{c6}/transfer", token=S1T,
                   body={"to_server_id": S2, "from_server_id": S1})
        check("paid check -> 400", s == 400, f"{s} {r}")

        # --- T7: idempotency — retry with stale from_server_id replays 200 ---
        t7 = free_table(S1T)
        c7 = open_check(S1T, t7, server_id="caller")
        hdrs = {"Idempotency-Key": "t31-retry-1"}
        s1, r1 = api("POST", f"/api/checks/{c7}/transfer", token=S1T,
                     body={"to_server_id": S2, "from_server_id": S1}, headers=hdrs)
        s2, r2 = api("POST", f"/api/checks/{c7}/transfer", token=S1T,
                     body={"to_server_id": S2, "from_server_id": S1}, headers=hdrs)
        check("idempotent retry replays 200 (not 409)",
              s1 == 200 and s2 == 200 and r2.get("server_id") == S2, f"{s1}/{s2} {r2}")

        # --- T8: audit trail completeness ---
        n = dbsql("SELECT COUNT(*) FROM approval_audit WHERE action='check_transfer'")[0][0]
        check("transfers audited", n >= 5, f"n={n}")
    finally:
        stop(p)

    print(f"\n== test31: {PASSES} passed, {len(FAILS)} failed ==" + ("  " + str(FAILS) if FAILS else ""))
    sys.exit(1 if FAILS else 0)


if __name__ == "__main__":
    main()
