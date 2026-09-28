#!/usr/bin/env python3
"""Independent adversarial probe of POST /api/checks/:id/transfer.
Covers gaps in test31: strict int validation, role gating of the target,
inactive users, noop auth order, idempotency-key scoping, override races.
Own server on :4339 with fresh DB. Never touches 4317/4320."""
import json, os, sqlite3, subprocess, signal, sys, threading, time, urllib.request, urllib.error

PORT = 4339
DB = "/tmp/expoline-test33-audit.db"
BASE = f"http://localhost:{PORT}"
PASSES = 0
FAILS = []

def check(name, cond, extra=""):
    global PASSES
    if cond: PASSES += 1; print(f"  PASS {name}")
    else: FAILS.append(name); print(f"  FAIL {name} {extra}")

def spawn():
    if os.path.exists(DB): os.remove(DB)
    env = dict(os.environ, EXPOLINE_PORT=str(PORT), EXPOLINE_DB=DB, NODE_ENV="test")
    p = subprocess.Popen(["node", os.path.expanduser("~/workspace/goals/expo-line-pos-beat-toast-spoton-pilot-at-bali-hai/build/expoline/server.js")],
                         env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(60):
        try:
            with urllib.request.urlopen(BASE + "/api/health", timeout=2) as r:
                if r.status == 200: return p
        except Exception: time.sleep(0.5)
    sys.exit("FATAL: no server")

def stop(p):
    if p and p.poll() is None:
        p.send_signal(signal.SIGTERM); p.wait(timeout=10)

def api(method, path, token=None, body=None, headers=None):
    h = {"Content-Type": "application/json"}
    if token: h["Authorization"] = "Bearer " + token
    if headers: h.update(headers)
    req = urllib.request.Request(BASE + path, method=method,
        data=json.dumps(body).encode() if body is not None else None, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        try: return e.code, json.loads(e.read().decode())
        except Exception: return e.code, {}

def dbsql(q, args=()):
    con = sqlite3.connect(DB)
    try:
        rows = con.execute(q, args).fetchall()
        con.commit()
        return rows
    finally:
        con.close()

def login(pin):
    s, r = api("POST", "/api/auth/login", body={"pin": pin})
    assert s == 200, r
    return r["token"], r["user"]["id"]

def free_table(tok):
    s, zones = api("GET", "/api/zones", token=tok)
    for z in zones:
        for t in z.get("tables", []):
            if not t.get("open_check_id"): return t["id"]
    raise AssertionError("no free table")

def new_check(tok, table_id):
    s, r = api("POST", "/api/checks", token=tok, body={"table_id": table_id, "guest_count": 2})
    assert s == 201, r
    return r["id"]

def main():
    p = spawn()
    try:
        MT, MID = login("2580")
        ST, S1 = login("1111")
        # second server + inactive user (seed already has kitchen pin 2222)
        s, r = api("POST", "/api/admin/employees", token=MT, body={"name": "Srv2", "role": "server", "pin": "5555"})
        assert s in (200, 201), r
        T2, S2 = login("5555")
        KID = dbsql("SELECT id FROM users WHERE pin = '2222'")[0][0]
        s, r = api("POST", "/api/admin/employees", token=MT, body={"name": "Gone", "role": "server", "pin": "6666"})
        GONE = r["id"]
        dbsql("UPDATE users SET active = 0 WHERE id = ?", (GONE,))

        t = free_table(ST)
        c = new_check(ST, t)

        # A1: strict int validation — string ids rejected
        s, r = api("POST", f"/api/checks/{c}/transfer", token=ST,
                   body={"to_server_id": str(S2), "from_server_id": S1})
        check("string to_server_id -> 400", s == 400, f"{s} {r}")
        s, r = api("POST", f"/api/checks/{c}/transfer", token=ST,
                   body={"to_server_id": S2, "from_server_id": str(S1)})
        check("string from_server_id -> 400", s == 400, f"{s} {r}")
        s, r = api("POST", f"/api/checks/{c}/transfer", token=ST,
                   body={"to_server_id": 0, "from_server_id": S1})
        check("to_server_id 0 -> 400", s == 400, f"{s} {r}")
        s, r = api("POST", f"/api/checks/{c}/transfer", token=ST,
                   body={"to_server_id": -3, "from_server_id": S1})
        check("negative to_server_id -> 400", s == 400, f"{s} {r}")

        # A2: role gating of the target
        s, r = api("POST", f"/api/checks/{c}/transfer", token=ST,
                   body={"to_server_id": KID, "from_server_id": S1})
        check("transfer to kitchen role -> 400", s == 400, f"{s} {r}")
        s, r = api("POST", f"/api/checks/{c}/transfer", token=ST,
                   body={"to_server_id": GONE, "from_server_id": S1})
        check("transfer to inactive user -> 400", s == 400, f"{s} {r}")

        # A3: noop on someone else's check without PIN — 200, nothing changes (acceptable)
        s, r = api("POST", f"/api/checks/{c}/transfer", token=T2,
                   body={"to_server_id": S1, "from_server_id": S1})
        check("noop by non-holder without PIN -> 200 noop", s == 200 and r.get("noop") is True, f"{s} {r}")
        s, cc = api("GET", f"/api/checks/{c}", token=ST)
        check("noop changed nothing", cc["server_id"] == S1, str(cc.get("server_id")))

        # A4: idempotency key reuse across DIFFERENT checks replays first outcome (site-scoped keys)
        c2 = new_check(T2, free_table(ST))
        s, r = api("POST", f"/api/checks/{c}/transfer", token=ST,
                   body={"to_server_id": S2, "from_server_id": S1}, headers={"Idempotency-Key": "audit-key-1"})
        assert s == 200, (s, r)
        s, r = api("POST", f"/api/checks/{c2}/transfer", token=T2,
                   body={"to_server_id": S1, "from_server_id": S2}, headers={"Idempotency-Key": "audit-key-1"})
        check("key reuse replays first outcome (no crash)", s == 200 and r.get("transferred") == c, f"{s} {r}")
        s, cc2 = api("GET", f"/api/checks/{c2}", token=T2)
        check("second check untouched by replay", cc2["server_id"] == S2, str(cc2.get("server_id")))

        # A5: override-mode race — check held by S2; one thread targets S2 (noop),
        # one targets S1 (real override). Both 200, exactly one audit row.
        c3 = new_check(T2, free_table(ST))
        s, cc = api("GET", f"/api/checks/{c3}", token=ST)
        assert cc["server_id"] == S2, cc
        res = []
        def ovr(to):
            s, r = api("POST", f"/api/checks/{c3}/transfer", token=ST,
                       body={"to_server_id": to, "from_server_id": 999999, "manager_pin": "2580"})
            res.append((s, r.get("server_id"), r.get("noop")))
        ths = [threading.Thread(target=ovr, args=(S2,)), threading.Thread(target=ovr, args=(S1,))]
        [th.start() for th in ths]; [th.join() for th in ths]
        check("override race: both 200, no 500", all(x[0] == 200 for x in res), str(res))
        check("override race: one noop, one real", sorted(x[2] or False for x in res) == [False, True], str(res))
        n = dbsql("SELECT COUNT(*) FROM approval_audit WHERE check_id = ? AND action = 'check_transfer'", (c3,))[0][0]
        check("override race: exactly one audit row (noop not audited)", n == 1, str(n))
        s, cc3 = api("GET", f"/api/checks/{c3}", token=ST)
        check("override race: final holder is S1", cc3["server_id"] == S1, str(cc3.get("server_id")))

        # A6: stale holder view -> 409 naming the actual holder.
        # T2 (S2) still believes it holds c3; S1 actually does.
        s, r = api("POST", f"/api/checks/{c3}/transfer", token=T2,
                   body={"to_server_id": S2, "from_server_id": S2})
        check("stale holder view -> 409", s == 409, f"{s} {r}")
        check("409 names actual holder S1", r.get("held_by_id") == S1, str(r))

        # A7: transfer endpoint requires auth
        s, r = api("POST", f"/api/checks/{c}/transfer", body={"to_server_id": S2, "from_server_id": S2})
        check("no token -> 401/403", s in (401, 403), f"{s} {r}")
    finally:
        stop(p)
    print(f"\naudit probe: {PASSES} passed, {len(FAILS)} failed")
    sys.exit(1 if FAILS else 0)

if __name__ == "__main__":
    main()
