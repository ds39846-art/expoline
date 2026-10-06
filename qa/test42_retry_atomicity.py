#!/usr/bin/env python3
"""
test42 — duplicate-on-retry hazards (confirmed by independent QA at
cc30c0e, live probe + code reading; unchanged at 9b4b8d1):

HAZARD 1 (server, SEND NOW): the send-now loop validated and INSERTED
line by line with no wrapping transaction, so a rejection on line N
left lines 1..N-1 on the check as orphan 'held' rows the client never
saw. Fixing the bad line and re-sending duplicated them (double-fire /
double-charge). The fix validates EVERY line first (all rules are
pure), then inserts + fires in ONE transaction.
  Cases: [fries s1, fries s2, flavorless edamame] -> 400 with the
  tagged body (line_index 2, item_name Edamame, bare reason intact)
  AND the check afterwards provably untouched (sqlite: zero items,
  zero KDS tickets, zero new depletion rows, on_hand unchanged); the
  corrected batch then lands each line exactly once with depletion
  recorded exactly once (recipe-computed deltas).

HAZARD 2 (client, legacy offline outbox): flushOutboxLegacy re-posted
an add_items op's already-landed lines on retry (its id map was only
saved after the whole op). The fix sends a per-line idempotency_key
derived from the line temp_id (persisted inside the queue entry) and
POST /items honors the key with the Phase 1B machinery (replay the
stored response; reserve only after validation, so a 400 never burns
the key). API cases here prove the real server side of the contract;
qa/harness42_client.js proves the client side (stable keys, no
re-insert across a lost-response retry).
  Cases: same key twice -> one item, same response id; a second key
  -> a second item; no key twice -> two items (backward compat); a
  validation 400 under a key does NOT burn it (the corrected line
  lands under the same key, then replays); the Idempotency-Key header
  form works too.

RIDER (harness section N): error toasts are length-scaled with a 6s
floor instead of the flat 3400ms that cut off the long HOLD message.

Discriminating control: run this suite from a 9b4b8d1 worktree — the
send-now section finds the 2 orphan fries rows after the failed batch
(and 5 rows after the retry), the idempotency section gets a fresh
insert (new id) for the repeated key, and harness M5/M6/M7 + N2/N3
fail. Evidence in the build report.
"""
import json
import os
import signal
import sqlite3
import subprocess
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HERE = Path(__file__).resolve().parent
PORT = 4352
DB = "/tmp/expoline-test42.db"
BASE = f"http://127.0.0.1:{PORT}"
SERVER_PIN = "1111"
MANAGER_PIN = "2580"

passed = failed = 0
failures = []


def ok(name, cond, extra=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"  ok  {name}")
    else:
        failed += 1
        failures.append(name)
        print(f"  FAIL {name} {extra}")


def req(method, path, body=None, token=None, headers=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(BASE + path, data=data, method=method)
    r.add_header("Content-Type", "application/json")
    if token:
        r.add_header("Authorization", "Bearer " + token)
    for k, v in (headers or {}).items():
        r.add_header(k, v)
    try:
        with urllib.request.urlopen(r, timeout=15) as resp:
            return resp.status, json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode() or "{}")
        except Exception:
            return e.code, {}
    except Exception as e:
        return 0, {"error": str(e)}


def q(sql, params=()):
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    try:
        return con.execute(sql, params).fetchall()
    finally:
        con.close()


def boot():
    env = dict(os.environ, EXPOLINE_PORT=str(PORT), EXPOLINE_DB=DB, NODE_ENV="test")
    p = subprocess.Popen(["node", str(ROOT / "server.js")], env=env,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(80):
        try:
            s, _ = req("GET", "/api/health")
            if s == 200:
                return p
        except Exception:
            pass
        time.sleep(0.4)
    p.kill()
    raise RuntimeError("server did not come up")


def free_table(tok, used):
    s, zones = req("GET", "/api/zones", token=tok)
    if isinstance(zones, list):
        zones = {"zones": zones}
    for z in zones.get("zones", []):
        for t in z.get("tables", []):
            if not t.get("open_check_id") and t["id"] not in used:
                used.add(t["id"])
                return t
    return None


def main():
    app_js = str(ROOT / "public" / "app.js")
    for a in sys.argv[1:]:
        if a.startswith("--app-js="):
            app_js = a.split("=", 1)[1]

    for suf in ("", "-wal", "-shm"):
        try:
            os.remove(DB + suf)
        except FileNotFoundError:
            pass
    srv = boot()
    try:
        s, login = req("POST", "/api/auth/login", {"pin": SERVER_PIN})
        tok = login.get("token")
        s, mlogin = req("POST", "/api/auth/login", {"pin": MANAGER_PIN})
        mtok = mlogin.get("token")
        ok("logins (server + manager)", bool(tok) and bool(mtok))

        s, menu = req("GET", "/api/menu?all=1", token=mtok)
        if isinstance(menu, list):
            menu = {"categories": menu}
        items = [it for c in menu.get("categories", []) for it in c.get("items", [])]
        by_name = {it["name"]: it for it in items}
        eda = by_name.get("Edamame")
        fries = by_name.get("Bali Fries")
        ok("fixture menu: Edamame (Flavor group) + Bali Fries",
           bool(eda and fries and eda.get("modifier_groups")), f"eda={bool(eda)} fries={bool(fries)}")
        flav = [g for g in eda["modifier_groups"] if g["name"] == "Flavor"][0]
        sea_salt = [o for o in flav["options"] if o["name"] == "Sea Salt"][0]

        used_tables = set()
        table = free_table(tok, used_tables)
        ok("a free table exists", table is not None)
        s, opened = req("POST", "/api/checks", {"table_id": table["id"], "guest_count": 4}, token=tok)
        check = opened.get("check") or opened or {}
        cid = check.get("id")
        ok("check opened (4 guests)", s == 201 and bool(cid), f"s={s} {opened}")

        fries1 = {"menu_item_id": fries["id"], "seat": 1, "qty": 1, "modifiers": []}
        fries2 = {"menu_item_id": fries["id"], "seat": 2, "qty": 1, "modifiers": []}
        eda_bad = {"menu_item_id": eda["id"], "seat": 1, "qty": 1, "modifiers": []}
        eda_ok = {"menu_item_id": eda["id"], "seat": 1, "qty": 1,
                  "modifiers": [{"name": "Sea Salt", "option_id": sea_salt["id"], "price_delta_cents": 0}]}

        print("\n== HAZARD 1: send-now is atomic — a failed batch leaves NOTHING ==")
        # Recipe-derived expectations, read from the seeded DB itself.
        recipe = {}
        for mid, iid, qty in q("SELECT menu_item_id, ingredient_id, qty FROM recipes WHERE menu_item_id IN (?, ?)",
                               (fries["id"], eda["id"])):
            recipe.setdefault(mid, {})[iid] = qty
        ing_ids = sorted({iid for m in recipe.values() for iid in m})
        ok("seeded recipes exist for both items", len(recipe) == 2 and len(ing_ids) >= 2,
           f"recipe={recipe}")
        hand0 = {iid: q("SELECT on_hand FROM ingredients WHERE id = ?", (iid,))[0][0] for iid in ing_ids}
        dep0 = q("SELECT COUNT(*) FROM inventory_adjustments WHERE kind = 'depletion'")[0][0]

        s, r = req("POST", f"/api/checks/{cid}/send-now",
                   {"items": [fries1, fries2, eda_bad]}, token=tok)
        ok("failed batch still 400s with the tagged, unchanged error body",
           s == 400 and "Flavor: please choose at least one" in (r.get("error") or "")
           and r.get("line_index") == 2 and r.get("item_name") == "Edamame", f"s={s} {r}")
        n_items = q("SELECT COUNT(*) FROM check_items WHERE check_id = ?", (cid,))[0][0]
        ok("failed batch left ZERO items on the check (no orphan held rows)",
           n_items == 0, f"items={n_items}")
        n_tix = q("SELECT COUNT(*) FROM kds_tickets WHERE check_id = ?", (cid,))[0][0]
        ok("failed batch created ZERO KDS tickets", n_tix == 0, f"tickets={n_tix}")
        dep1 = q("SELECT COUNT(*) FROM inventory_adjustments WHERE kind = 'depletion'")[0][0]
        ok("failed batch wrote ZERO depletion rows", dep1 == dep0, f"dep {dep0} -> {dep1}")
        hand1 = {iid: q("SELECT on_hand FROM ingredients WHERE id = ?", (iid,))[0][0] for iid in ing_ids}
        ok("failed batch left on_hand untouched", hand1 == hand0, f"{hand0} -> {hand1}")
        s, view = req("GET", f"/api/checks/{cid}", token=tok)
        ok("GET check agrees: no items after the failed batch",
           not view.get("items"), f"items={view.get('items')}")

        s, r = req("POST", f"/api/checks/{cid}/send-now",
                   {"items": [fries1, fries2, eda_ok]}, token=tok)
        ok("corrected batch fires (201, sent=3)",
           s == 201 and r.get("sent") == 3, f"s={s} {r}")
        rows = q("SELECT menu_item_id, seat, state FROM check_items WHERE check_id = ? ORDER BY id", (cid,))
        ok("each corrected line is on the check EXACTLY once, all sent",
           sorted((m, seat) for m, seat, _ in rows) ==
           sorted([(fries["id"], 1), (fries["id"], 2), (eda["id"], 1)])
           and len(rows) == 3 and all(st == "sent" for _, _, st in rows),
           f"rows={rows}")
        tix_items = sum(len(json.loads(t[0])) for t in
                        q("SELECT items_json FROM kds_tickets WHERE check_id = ?", (cid,)))
        ok("KDS tickets carry the 3 lines exactly once", tix_items == 3, f"ticket lines={tix_items}")
        expected = {}
        for line in (fries1, fries2, eda_ok):
            for iid, per in recipe.get(line["menu_item_id"], {}).items():
                expected[iid] = expected.get(iid, 0.0) + per * line["qty"]
        hand2 = {iid: q("SELECT on_hand FROM ingredients WHERE id = ?", (iid,))[0][0] for iid in ing_ids}
        ok("depletion landed exactly once (recipe-computed on_hand deltas)",
           all(abs((hand0[iid] - hand2[iid]) - expected.get(iid, 0.0)) < 1e-9 for iid in ing_ids),
           f"expected={expected} hand {hand0} -> {hand2}")
        dep2 = q("SELECT COUNT(*) FROM inventory_adjustments WHERE kind = 'depletion'")[0][0]
        ok("exactly one aggregated depletion row per ingredient for the fire",
           dep2 - dep0 == len(expected), f"dep {dep0} -> {dep2}, ingredients={len(expected)}")

        print("\n== HAZARD 2: POST /items honors per-line idempotency keys ==")
        table2 = free_table(tok, used_tables)
        s, opened2 = req("POST", "/api/checks", {"table_id": table2["id"], "guest_count": 4}, token=tok)
        check2 = opened2.get("check") or opened2 or {}
        cid2 = check2.get("id")
        ok("second check opened", s == 201 and bool(cid2), f"s={s} {opened2}")

        def count_items(mid=None):
            if mid is None:
                return q("SELECT COUNT(*) FROM check_items WHERE check_id = ?", (cid2,))[0][0]
            return q("SELECT COUNT(*) FROM check_items WHERE check_id = ? AND menu_item_id = ?",
                     (cid2, mid))[0][0]

        k1 = {"idempotency_key": "test42-key-alpha"}
        s, r1 = req("POST", f"/api/checks/{cid2}/items", dict(fries1, **k1), token=tok)
        ok("first keyed POST lands (201)", s == 201 and bool(r1.get("id")), f"s={s} {r1}")
        s, r2 = req("POST", f"/api/checks/{cid2}/items", dict(fries1, **k1), token=tok)
        ok("same key replays: 201 with the SAME item id, no second insert",
           s == 201 and r2.get("id") == r1.get("id") and count_items(fries["id"]) == 1,
           f"s={s} r2={r2} count={count_items(fries['id'])}")
        s, r3 = req("POST", f"/api/checks/{cid2}/items",
                    dict(fries1, idempotency_key="test42-key-beta"), token=tok)
        ok("a different key is a different line (201, new id)",
           s == 201 and r3.get("id") != r1.get("id") and count_items(fries["id"]) == 2,
           f"s={s} r3={r3}")
        s, _ = req("POST", f"/api/checks/{cid2}/items", fries1, token=tok)
        s2, _ = req("POST", f"/api/checks/{cid2}/items", fries1, token=tok)
        ok("keyless POSTs keep the old always-insert behavior (backward compat)",
           s == 201 and s2 == 201 and count_items(fries["id"]) == 4,
           f"count={count_items(fries['id'])}")

        k3 = {"idempotency_key": "test42-key-gamma"}
        s, rbad = req("POST", f"/api/checks/{cid2}/items", dict(eda_bad, **k3), token=tok)
        ok("a validation failure under a key stays the bare 400 (no tag, no burn)",
           s == 400 and rbad.get("error") == "Flavor: please choose at least one"
           and "line_index" not in rbad, f"s={s} {rbad}")
        s, r4 = req("POST", f"/api/checks/{cid2}/items", dict(eda_ok, **k3), token=tok)
        ok("the corrected line lands under the SAME key (key survived the 400)",
           s == 201 and bool(r4.get("id")) and count_items(eda["id"]) == 1,
           f"s={s} r4={r4} count={count_items(eda['id'])}")
        s, r5 = req("POST", f"/api/checks/{cid2}/items", dict(eda_ok, **k3), token=tok)
        ok("…and a further retry replays it instead of duplicating",
           s == 201 and r5.get("id") == r4.get("id") and count_items(eda["id"]) == 1,
           f"s={s} r5={r5} count={count_items(eda['id'])}")

        hdr = {"Idempotency-Key": "test42-hdr-1"}
        s, h1 = req("POST", f"/api/checks/{cid2}/items", fries2, token=tok, headers=hdr)
        s2, h2 = req("POST", f"/api/checks/{cid2}/items", fries2, token=tok, headers=hdr)
        ok("the Idempotency-Key header form replays too",
           s == 201 and s2 == 201 and h1.get("id") == h2.get("id")
           and count_items(fries["id"]) == 5,
           f"h1={h1.get('id')} h2={h2.get('id')} count={count_items(fries['id'])}")

        print("\n== client harness (REAL extracted functions) ==")
        r = subprocess.run(["node", str(HERE / "harness42_client.js"), app_js],
                           capture_output=True, text=True, timeout=120)
        print(r.stdout.rstrip())
        if r.stderr.strip():
            print(r.stderr.rstrip()[:1500])
        harness_fail = r.stdout.count("  FAIL ")
        harness_pass = r.stdout.count("  ok  ")
        ok("harness42 fully green", r.returncode == 0 and harness_fail == 0,
           f"rc={r.returncode} fails={harness_fail}")
        globals()["passed"] = passed + harness_pass - 1
        print(f"  (harness assertions passed: {harness_pass})")
    finally:
        if srv and srv.poll() is None:
            srv.send_signal(signal.SIGTERM)
            srv.wait(timeout=10)

    print(f"\n==== test42: {passed} passed, {failed} failed ====")
    if failures:
        print("failures:", "; ".join(failures))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
