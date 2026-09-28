#!/usr/bin/env python3
"""Expoline QA Test 30: claim/overlap concurrency.

Covers the P0 overlapping-claim hazard (design:
hidden_files/claim-overlap-20260927/DESIGN.md):

  T1  Table-claim race (app level): N threads race POST /api/checks on one
      table. Exactly one 201; losers get a conflict (400 today, 409 per the
      design contract) naming the winning check_id; the DB holds exactly one
      open check for the table.
  T2  Schema guard: a second open check INSERT for the same table must be
      rejected by the DB. EXPECTED TO FAIL until the partial unique index
      from DESIGN.md section 3.1 lands -- the red test proving the P0.
  T3  Course-fire double-fire race: N threads race fire-course on held items.
      Exactly one fire wins; every item is ticketed exactly once
      (no duplicate item_id across kds_tickets, exactly one course_fires row).
  T4  Claim-token expiry/steal: SKIPPED -- designed-not-built (no claim-token
      endpoint exists yet; see DESIGN.md section 3.2/3.6).

Soak-safe: owns its server on port 4335 (never 4317/4320) with a fresh temp
DB, following qa/test28_course_fire_rollback.py's pattern. Additive only --
this file never touches existing code.
"""
import json, os, signal, sqlite3, subprocess, sys, time
import threading
import urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.join(HERE, "..", "server.js")
PORT = int(os.environ.get("EXPOLINE_TEST_PORT", "4335"))
DB = os.environ.get("EXPOLINE_TEST_DB", "/tmp/expoline-claim-test30.db")
BASE = f"http://localhost:{PORT}"
S, M = "1111", "2580"

if PORT in (4317, 4320):
    sys.exit("FATAL: test 30 refuses ports 4317/4320 (demo/soak ports)")


def spawn(extra_env=None, fresh=True, port=None):
    if fresh and os.path.exists(DB):
        os.remove(DB)
    use_port = port or PORT
    env = dict(os.environ, EXPOLINE_PORT=str(use_port), EXPOLINE_DB=DB,
               NODE_ENV="test", **(extra_env or {}))
    p = subprocess.Popen(["node", SERVER], env=env,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    base = f"http://localhost:{use_port}"
    for _ in range(60):
        try:
            with urllib.request.urlopen(base + "/api/health", timeout=2) as r:
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
    """Returns (status, parsed_body); never raises on HTTP error."""
    req = urllib.request.Request(BASE + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json"})
    if token:
        req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            raw = resp.read().decode() or "{}"
            return resp.status, json.loads(raw)
    except urllib.error.HTTPError as e:
        raw = e.read().decode() or "{}"
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {"raw": raw}


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


def race(n_threads, fn):
    """Run fn() on n_threads threads released simultaneously; return results."""
    barrier = threading.Barrier(n_threads)
    def wrapped():
        barrier.wait(timeout=30)
        return fn()
    with ThreadPoolExecutor(max_workers=n_threads) as ex:
        return list(ex.map(lambda _: wrapped(), range(n_threads)))


srv = None
try:
    print("== Test 30 setup: server on port %d ==" % PORT)
    srv = spawn()
    st = api("POST", "/api/auth/login", None, {"pin": S})[1]["token"]
    mt = api("POST", "/api/auth/login", None, {"pin": M})[1]["token"]
    ok(bool(st) and bool(mt), "server + manager PINs log in")

    zones = api("GET", "/api/zones", st)[1]
    tables = [t for z in zones for t in z["tables"]]
    ok(len(tables) >= 2, "seeded tables available", f"({len(tables)})")
    t1, t2 = tables[0]["id"], tables[1]["id"]

    # ---------------- T1: table-claim race ----------------
    print("== T1: N threads race to claim one table ==")
    N = 16
    results = race(N, lambda: api("POST", "/api/checks", st,
                                 {"table_id": t1, "guest_count": 2}))
    winners = [r for r in results if r[0] == 201]
    losers = [r for r in results if r[0] != 201]
    ok(len(winners) == 1, "exactly one claim winner", f"(201s={len(winners)})")
    win_id = winners[0][1].get("id") if winners else None
    bad_loser = [r for r in losers if r[0] not in (400, 409)]
    ok(not bad_loser, "losers get conflict status (400 today, 409 per design)",
       f"(statuses={sorted(set(r[0] for r in losers))})")
    named = [r for r in losers
             if r[1].get("check_id") == win_id]
    ok(len(named) == len(losers) and win_id is not None,
       "every loser names the winning check_id",
       f"({len(named)}/{len(losers)} named check {win_id})")
    open_n = dbq("SELECT COUNT(*) FROM checks WHERE table_id = ? AND status = 'open'",
                 (t1,))[0][0]
    ok(open_n == 1, "DB holds exactly one open check for the table",
       f"(found {open_n})")

    # ---------------- T2: schema guard ----------------
    print("== T2: DB must reject a second open check on the same table ==")
    # NOTE: expected to FAIL until DESIGN.md 3.1 (partial unique index) lands.
    # A passing second INSERT here is the P0 proved, not a test bug.
    con = sqlite3.connect(DB)
    try:
        con.execute(
            "INSERT INTO checks (uuid, site_id, table_id, server_id, guest_count,"
            " status, opened_at) VALUES (?, 'test', ?, 1, 2, 'open', 't')",
            ("t2-guard", t1))
        con.commit()
        ok(False, "DB rejects second open check on same table",
           "(second INSERT succeeded -- P0 CONFIRMED, no guard)")
        con.execute("DELETE FROM checks WHERE uuid = 't2-guard'")
        con.commit()
    except sqlite3.IntegrityError:
        ok(True, "DB rejects second open check on same table")
    finally:
        con.close()

    # ---------------- T3: course-fire double-fire race ----------------
    print("== T3: N threads race to fire the same held course ==")
    items = dbq("SELECT id FROM menu_items WHERE course = 'appetizer'"
                " AND active = 1 LIMIT 2")
    ok(len(items) == 2, "two seeded appetizer items found")
    chk = api("POST", "/api/checks", st, {"table_id": t2, "guest_count": 2})[1]
    for (mid,) in items:
        st_add, _ = api("POST", f"/api/checks/{chk['id']}/items", st,
                        {"menu_item_id": mid, "seat": 1, "qty": 1})
        ok(st_add in (200, 201), "held item added", f"(menu_item {mid})")
    held_ids = sorted(r[0] for r in dbq(
        "SELECT id FROM check_items WHERE check_id = ? AND state = 'held'",
        (chk["id"],)))
    ok(len(held_ids) == 2, "two items held before the race")

    fires = race(8, lambda: api("POST",
                                f"/api/checks/{chk['id']}/fire-course",
                                st, {"course": "appetizer"}))
    ok_fires = [r for r in fires if r[0] == 200 and r[1].get("ok")]
    ok(len(ok_fires) == 1, "exactly one fire wins",
       f"(ok={len(ok_fires)})")
    ok(all(r[0] == 409 for r in fires if r not in ok_fires),
       "losing fires get 409",
       f"(statuses={sorted(set(r[0] for r in fires))})")
    if ok_fires:
        ok(ok_fires[0][1].get("sent") == 2, "winner fired both items",
           f"(sent={ok_fires[0][1].get('sent')})")
    nfires = dbq("SELECT COUNT(*) FROM course_fires WHERE course = 'appetizer' "
                 "AND check_id = ?", (float(chk["id"]),))[0][0]
    # NOTE: node:sqlite binds every JS number as REAL, so the server stores
    # check_id as TEXT '5.0'; an INTEGER bind would silently miss the row
    # (SQLite INTEGER-vs-TEXT comparison quirk). Bind float to match server.
    ok(nfires == 1, "exactly one course_fires row", f"(found {nfires})")
    states = dbq("SELECT DISTINCT state FROM check_items WHERE check_id = ?",
                 (chk["id"],))
    ok(states == [("sent",)], "all items SENT exactly once",
       f"(states={states})")
    seen, dup = [], False
    for (js,) in dbq("SELECT items_json FROM kds_tickets WHERE check_id = ?",
                     (chk["id"],)):
        try:
            ids = [it.get("item_id") for it in json.loads(js or "[]")]
        except Exception:
            ids = []
        for i in ids:
            if i in seen:
                dup = True
            seen.append(i)
    ok(not dup and sorted(seen) == held_ids,
       "no item ticketed twice across KDS tickets",
       f"(ticketed={sorted(seen)}, held={held_ids})")

    # ---------------- T4: claim-token expiry (designed-not-built) ----------------
    print("== T4: claim-token expiry/steal -- SKIPPED (designed-not-built) ==")
    print("  - no claim-token endpoint exists yet; contract specified in"
          " DESIGN.md sections 3.2 and 3.6")

    # ---------------- T5: cross-process claim race (LAN failover) ----------------
    # Two server processes sharing ONE sqlite file = the LAN site-brain
    # failover scenario from DESIGN.md 3.4. The partial unique index (not the
    # app) must be the arbiter: exactly one winner; losers get 400 (friendly
    # fast path) or 409 (lost-race contract); the DB holds exactly one open
    # staff check on the table.
    print("== T5: cross-process claim race (two servers, one DB) ==")
    PORT2 = PORT + 1
    assert PORT2 not in (4317, 4320), "T5 refuses demo/soak ports"
    srv2 = None
    try:
        srv2 = spawn(port=PORT2, fresh=False)
        BASE2 = f"http://localhost:{PORT2}"

        def api2(method, path, token=None, body=None):
            req = urllib.request.Request(
                BASE2 + path, method=method,
                data=json.dumps(body).encode() if body is not None else None,
                headers={"Content-Type": "application/json"})
            if token:
                req.add_header("Authorization", "Bearer " + token)
            try:
                with urllib.request.urlopen(req, timeout=15) as resp:
                    raw = resp.read().decode() or "{}"
                    return resp.status, json.loads(raw)
            except urllib.error.HTTPError as e:
                raw = e.read().decode() or "{}"
                try:
                    return e.code, json.loads(raw)
                except Exception:
                    return e.code, {"raw": raw}

        st2 = api2("POST", "/api/auth/login", None, {"pin": S})[1]["token"]
        ok(bool(st2), "second server logs in on the shared DB")
        t3 = tables[2]["id"]

        n5 = 12
        bar5 = threading.Barrier(n5)

        def claim5(i):
            bar5.wait(timeout=30)
            if i % 2 == 0:
                return api("POST", "/api/checks", st,
                           {"table_id": t3, "guest_count": 2})
            return api2("POST", "/api/checks", st2,
                        {"table_id": t3, "guest_count": 2})

        with ThreadPoolExecutor(max_workers=n5) as ex:
            r5 = list(ex.map(claim5, range(n5)))
        wins5 = [r for r in r5 if r[0] == 201]
        lose5 = [r for r in r5 if r[0] != 201]
        ok(len(wins5) == 1, "exactly one claim wins across two processes",
           f"(winners={len(wins5)})")
        ok(all(s in (400, 409) for s, _ in lose5), "losers get 400 or 409",
           f"(statuses={sorted(set(s for s, _ in lose5))})")
        open5 = dbq("SELECT COUNT(*) FROM checks WHERE table_id = ? "
                    "AND status = 'open'", (t3,))[0][0]
        ok(open5 == 1, "exactly one open check in the shared DB",
           f"(found {open5})")
        if wins5:
            wid = wins5[0][1].get("id")
            bad409 = [b for s, b in lose5
                      if s == 409 and b.get("check_id") != wid]
            ok(not bad409, "every 409 names the winning check",
               f"(mismatched={len(bad409)})")
    finally:
        stop(srv2)

finally:
    stop(srv)

print(f"\nTest 30: {checks - len(fails)}/{checks} passed")
if fails:
    print("\n".join(fails))
    # T2 is the known-red P0 proof; exit non-zero only if anything ELSE failed.
    others = [f for f in fails if "DB rejects second open check" not in f]
    sys.exit(1 if others else 2)
