#!/usr/bin/env python3
"""Expoline QA Test 28: course-fire forced-failure rollback.

Proves the POST /api/checks/:id/fire-course transaction (commit 498e381) is
truly atomic: a mid-fire KDS ticket-insertion failure — injected AFTER real
writes have happened inside the transaction (course_fires upsert, item state
updates, inventory depletion, one ticket insert) — must roll back EVERYTHING:

  (a) the item stays HELD
  (b) inventory on_hand is unchanged
  (c) no course_fires row exists for the check
  (d) no approval_audit 'course_fire' entry exists for the check
  (+) no KDS ticket exists for the check

A control pass (no injected failure) then asserts the fire succeeds and
writes ALL records: item -> sent, inventory depleted, course_fires row,
approval_audit entry, KDS ticket.

Failure injection: server.js's fireHeldItemsToKdsCore() throws when the
env var EXPOLINE_TEST_FAIL_KDS=1 — a test-scoped hook, inert in production.

This test owns its server instance and DB: it launches server.js on port
4333 (never 4320, the soak-test port) with EXPOLINE_DB pointed at a fresh
temp DB file, runs the failure phase, restarts the server WITHOUT the hook
for the control phase, and shuts it down at the end.
"""
import json, os, signal, sqlite3, subprocess, sys, time
import urllib.request, urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.join(HERE, "..", "server.js")
PORT = int(os.environ.get("EXPOLINE_TEST_PORT", "4333"))
DB = os.environ.get("EXPOLINE_TEST_DB", "/tmp/expoline-rollback-test28.db")
BASE = f"http://localhost:{PORT}"
S, M = "1111", "2580"

if PORT == 4320:
    sys.exit("FATAL: test 28 refuses to use port 4320 (soak test port)")


def spawn(extra_env, fresh=True):
    if fresh and os.path.exists(DB):
        os.remove(DB)
    env = dict(os.environ, EXPOLINE_PORT=str(PORT), EXPOLINE_DB=DB,
               NODE_ENV="test", **extra_env)
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


def api(method, path, token=None, body=None, raw=False):
    req = urllib.request.Request(BASE + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json"})
    if token:
        req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return (resp.status, resp.read().decode()) if raw \
                else json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        if raw:
            return (e.code, e.read().decode())
        raise


def dbq(sql, args=()):
    con = sqlite3.connect(DB)
    try:
        return con.execute(sql, args).fetchall()
    finally:
        con.close()


checks, fails = 0, []


def ok(cond, name, detail=""):
    global checks
    checks += 1
    if not cond:
        fails.append(f"FAIL: {name} {detail}")
        print(f"  X {name} {detail}")
    else:
        print(f"  + {name}")


ST = KT = None
srv = None
try:
    print("== Test 28 setup: failure-injection server on port %d ==" % PORT)
    srv = spawn({"EXPOLINE_TEST_FAIL_KDS": "1"})
    ST = api("POST", "/api/auth/login", None, {"pin": S})["token"]
    MT = api("POST", "/api/auth/login", None, {"pin": M})["token"]

    # Inventory fixture: an ingredient with a recipe on an appetizer item
    ing = api("POST", "/api/admin/inventory/ingredients", MT,
              {"name": "QA28 Flour", "unit": "ea", "on_hand": 100, "par": 10})
    ing_id = ing["id"]
    api("POST", "/api/admin/inventory/recipes", MT,
        {"menu_item_id": 2, "lines": [{"ingredient_id": ing_id, "qty": 2.5}]})
    ok(ing["on_hand"] == 100, "ingredient seeded at 100")

    # Check with held items in the appetizer course (2 x qty => 5.0 depletion)
    c = api("POST", "/api/checks", ST,
            {"table_id": 1, "guest_count": 2, "tab_name": "QA28 rollback"})
    cid = c["id"]
    added = api("POST", f"/api/checks/{cid}/items", ST,
                {"menu_item_id": 2, "seat": 1, "qty": 2})
    item_id = added["id"]
    ok(dbq("SELECT state FROM check_items WHERE id = ?", (item_id,))[0][0]
       == "held", "item starts HELD")

    base_on_hand = dbq("SELECT on_hand FROM ingredients WHERE id = ?",
                       (ing_id,))[0][0]

    print("== Test 28a: forced KDS failure mid-fire ==")
    st, txt = api("POST", f"/api/checks/{cid}/fire-course", ST,
                  {"course": "appetizer"}, raw=True)
    ok(st == 500, "fire with injected KDS failure -> 500", f"got {st}")
    ok("EXPOLINE_TEST_FAIL_KDS" in txt,
       "500 body names the forced-failure hook", txt[:80])

    print("== Test 28b: rollback invariants ==")
    state = dbq("SELECT state FROM check_items WHERE id = ?", (item_id,))[0][0]
    ok(state == "held", "(a) item still HELD after rollback", f"state={state}")
    on_hand = dbq("SELECT on_hand FROM ingredients WHERE id = ?",
                  (ing_id,))[0][0]
    ok(on_hand == base_on_hand, "(b) inventory unchanged",
       f"on_hand={on_hand} expected={base_on_hand}")
    n_fires = dbq("SELECT COUNT(*) FROM course_fires WHERE CAST(check_id AS REAL) = CAST(? AS REAL)",
                  (cid,))[0][0]
    ok(n_fires == 0, "(c) no course_fires row", f"rows={n_fires}")
    n_audit = dbq("SELECT COUNT(*) FROM approval_audit WHERE check_id = ? "
                  "AND action = 'course_fire'", (cid,))[0][0]
    ok(n_audit == 0, "(d) no approval_audit course_fire entry",
       f"rows={n_audit}")
    n_tix = dbq("SELECT COUNT(*) FROM kds_tickets WHERE check_id = ?",
                (cid,))[0][0]
    ok(n_tix == 0, "(+) no KDS ticket leaked for the check", f"rows={n_tix}")
    # totals untouched: no sent_at stamp on the held item
    sent_at = dbq("SELECT sent_at FROM check_items WHERE id = ?",
                  (item_id,))[0][0]
    ok(sent_at is None, "(+) held item has no sent_at timestamp")

    print("== Test 28c: restart server WITHOUT the failure hook ==")
    stop(srv)
    srv = spawn({}, fresh=False)  # keep the same DB: the rolled-back check must survive
    ST = api("POST", "/api/auth/login", None, {"pin": S})["token"]

    print("== Test 28d: control pass — fire succeeds, all records written ==")
    r = api("POST", f"/api/checks/{cid}/fire-course", ST,
            {"course": "appetizer"})
    ok(r.get("ok") and r.get("sent") == 1,
       "control fire returns ok, sent=1", str(r)[:120])
    state2 = dbq("SELECT state FROM check_items WHERE id = ?", (item_id,))[0][0]
    ok(state2 == "sent", "control: item now SENT", f"state={state2}")
    on_hand2 = dbq("SELECT on_hand FROM ingredients WHERE id = ?",
                   (ing_id,))[0][0]
    ok(abs(on_hand2 - (base_on_hand - 2 * 2.5)) < 1e-9,
       "control: inventory depleted 2 x 2.5 = 5.0",
       f"on_hand={on_hand2}")
    n_fires2 = dbq("SELECT COUNT(*) FROM course_fires WHERE CAST(check_id AS REAL) = CAST(? AS REAL)",
                   (cid,))[0][0]
    ok(n_fires2 == 1, "control: course_fires row written", f"rows={n_fires2}")
    n_audit2 = dbq("SELECT COUNT(*) FROM approval_audit WHERE check_id = ? "
                   "AND action = 'course_fire'", (cid,))[0][0]
    ok(n_audit2 == 1, "control: approval_audit course_fire entry written",
       f"rows={n_audit2}")
    n_tix2 = dbq("SELECT COUNT(*) FROM kds_tickets WHERE check_id = ? "
                 "AND status = 'new'", (cid,))[0][0]
    ok(n_tix2 == 1, "control: KDS ticket created", f"rows={n_tix2}")
    # the hook is inert without the env var: the shared /send path fires too
    c2 = api("POST", "/api/checks", ST,
             {"table_id": 2, "guest_count": 2, "tab_name": "QA28 send path"})
    cid2 = c2["id"]
    api("POST", f"/api/checks/{cid2}/items", ST,
        {"menu_item_id": 2, "seat": 1, "qty": 1})
    s2 = api("POST", f"/api/checks/{cid2}/send", ST, {})
    ok(s2.get("sent") == 1 and len(s2.get("tickets", [])) == 1,
       "control: /send works with hook unset", str(s2)[:120])
finally:
    stop(srv)

print(f"\n{checks - len(fails)}/{checks} assertions passed")
if fails:
    print("\n".join(fails))
    sys.exit(1)
print("TEST 28 PASS")
