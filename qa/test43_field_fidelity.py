#!/usr/bin/env python3
"""
test43 — offline field fidelity (confirmed by independent QA with a
live probe of the REAL extracted flushOutboxLegacy at ffd6ccd):

A line held while OFFLINE is enqueued by the HOLD handler WITH its
note, allergy flag/detail, and ring-time course, and POST /items
accepts and stores all four — but both sync paths dropped them:
  * legacy: flushOutboxLegacy built the POST body from only
    {menu_item_id, seat, qty, modifiers} (+ idempotency_key);
  * LAN: lanEnvelope mapped each queued line to only {item_uuid,
    menu_item_id, seat, qty, modifiers}, AND lan/store.js add_items
    never wrote the note/allergy columns at all and forced the menu
    course into the INSERT.
An offline-held Edamame (note "no sauce", allergy "soy", course
picked at ring time) reached the kitchen with none of it. The allergy
loss is the safety-relevant part.

Sections:
  R  (plain server, HTTP) — the API half of the legacy fix: a
     flush-style POST /items body carrying the four fields stores
     them (201 body, GET view, and sqlite all agree); explicit null
     course stores NULL (no course), an absent course keeps the menu
     default, a bare body keeps note NULL / allergy 0; the keyed
     replay contract from test42 still holds with fields attached.
  S  (LAN node, HTTP) — POST /api/sync/batch with an envelope whose
     item carries the four fields: the stored row (sqlite) and the
     GET view carry them; a bare envelope item keeps the defaults;
     an out-of-vocabulary course is rejected as invalid_course and
     inserts nothing.
  harness43 (node) — the REAL extracted flushOutboxLegacy and
     lanEnvelope: the four fields ride when the queued line carries
     them (nulls included — null course must not collapse into the
     menu default) and stay absent when it does not.

Discriminating control: run this suite from an ffd6ccd worktree —
harness P1–P5/P7–P11 and Q2/Q3/Q5 fail on the dropped fields, and
section S finds note NULL / course forced to the menu default /
the invalid-course op accepted. Section R passes at both commits
(the server always stored what it was sent; it was never sent).
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
PORT = 4353
LAN_PORT = 4354
DB = "/tmp/expoline-test43.db"
LAN_DB = "/tmp/expoline-test43-lan.db"
BASE = f"http://127.0.0.1:{PORT}"
LAN_BASE = f"http://127.0.0.1:{LAN_PORT}"
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


def req(method, path, body=None, token=None, base=BASE):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(base + path, data=data, method=method)
    r.add_header("Content-Type", "application/json")
    if token:
        r.add_header("Authorization", "Bearer " + token)
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


def q(db, sql, params=()):
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    try:
        return con.execute(sql, params).fetchall()
    finally:
        con.close()


def boot(port, db, extra_env=None):
    env = dict(os.environ, EXPOLINE_PORT=str(port), EXPOLINE_DB=db)
    if extra_env:
        env.update(extra_env)
    p = subprocess.Popen(["node", str(ROOT / "server.js")], env=env,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(80):
        try:
            s, _ = req("GET", "/api/health", base=f"http://127.0.0.1:{port}")
            if s == 200:
                return p
        except Exception:
            pass
        time.sleep(0.4)
    p.kill()
    raise RuntimeError(f"server on {port} did not come up")


def stop(p):
    if p and p.poll() is None:
        p.send_signal(signal.SIGTERM)
        try:
            p.wait(timeout=10)
        except Exception:
            p.kill()


def menu_items(tok, base=BASE):
    s, menu = req("GET", "/api/menu?all=1", token=tok, base=base)
    if isinstance(menu, list):
        menu = {"categories": menu}
    return {it["name"]: it for c in menu.get("categories", []) for it in c.get("items", [])}


def free_table(tok, base=BASE):
    s, zones = req("GET", "/api/zones", token=tok, base=base)
    if isinstance(zones, list):
        zones = {"zones": zones}
    for z in zones.get("zones", []):
        for t in z.get("tables", []):
            if not t.get("open_check_id"):
                return t
    return None


def main():
    app_js = str(ROOT / "public" / "app.js")
    for a in sys.argv[1:]:
        if a.startswith("--app-js="):
            app_js = a.split("=", 1)[1]

    for path in (DB, LAN_DB):
        for suf in ("", "-wal", "-shm"):
            try:
                os.remove(path + suf)
            except FileNotFoundError:
                pass

    srv = lan = None
    try:
        # ================= R: plain server, flush-style POST =================
        print("== R: POST /items stores the fields a flush sends ==")
        srv = boot(PORT, DB, {"NODE_ENV": "test"})
        s, login = req("POST", "/api/auth/login", {"pin": SERVER_PIN})
        tok = login.get("token")
        s, mlogin = req("POST", "/api/auth/login", {"pin": MANAGER_PIN})
        mtok = mlogin.get("token")
        ok("logins (server + manager)", bool(tok) and bool(mtok))

        by_name = menu_items(mtok)
        eda, fries = by_name.get("Edamame"), by_name.get("Bali Fries")
        ok("fixture menu: Edamame (Flavor group) + Bali Fries with menu courses",
           bool(eda and fries and eda.get("modifier_groups") and eda.get("course") and fries.get("course")),
           f"eda={bool(eda)} fries={bool(fries)}")
        flav = [g for g in eda["modifier_groups"] if g["name"] == "Flavor"][0]
        sea_salt = [o for o in flav["options"] if o["name"] == "Sea Salt"][0]
        salt_mod = [{"name": "Sea Salt", "option_id": sea_salt["id"], "price_delta_cents": 0}]

        table = free_table(tok)
        s, opened = req("POST", "/api/checks", {"table_id": table["id"], "guest_count": 4}, token=tok)
        cid = (opened.get("check") or opened or {}).get("id")
        ok("check opened (4 guests)", s == 201 and bool(cid), f"s={s} {opened}")

        flush_body = {"menu_item_id": eda["id"], "seat": 1, "qty": 1, "modifiers": salt_mod,
                      "note": "no sauce", "allergy": True, "allergy_detail": "soy",
                      "course": "dessert", "idempotency_key": "test43-flush-1"}
        s, r = req("POST", f"/api/checks/{cid}/items", flush_body, token=tok)
        ok("flush-style POST lands (201) with the fields in the response body",
           s == 201 and r.get("note") == "no sauce" and r.get("allergy") is True
           and r.get("allergy_detail") == "soy" and r.get("course") == "dessert",
           f"s={s} {r}")
        row = q(DB, "SELECT note, allergy, allergy_detail, course FROM check_items WHERE id = ?",
                (r.get("id"),))
        ok("sqlite: the stored line carries note / allergy / detail / picked course",
           row == [("no sauce", 1, "soy", "dessert")], f"row={row}")
        s, view = req("GET", f"/api/checks/{cid}", token=tok)
        vline = [i for i in view.get("items", []) if i.get("id") == r.get("id")]
        ok("GET check view shows the same note / allergy / course",
           len(vline) == 1 and vline[0].get("note") == "no sauce"
           and vline[0].get("allergy") is True and vline[0].get("course") == "dessert",
           f"view={vline}")
        s, r2 = req("POST", f"/api/checks/{cid}/items", flush_body, token=tok)
        n_eda = q(DB, "SELECT COUNT(*) FROM check_items WHERE check_id = ? AND menu_item_id = ?",
                  (cid, eda["id"]))[0][0]
        ok("the same keyed flush POST replays — no duplicate line, fields intact",
           s == 201 and r2.get("id") == r.get("id") and n_eda == 1, f"s={s} n={n_eda}")

        s, rn = req("POST", f"/api/checks/{cid}/items",
                    {"menu_item_id": fries["id"], "seat": 2, "qty": 1, "modifiers": [], "course": None},
                    token=tok)
        rown = q(DB, "SELECT course FROM check_items WHERE id = ?", (rn.get("id"),))
        ok("explicit null course stores NULL (no course), not the menu default",
           s == 201 and rown == [(None,)], f"s={s} row={rown}")
        s, rd = req("POST", f"/api/checks/{cid}/items",
                    {"menu_item_id": fries["id"], "seat": 1, "qty": 1, "modifiers": []}, token=tok)
        rowd = q(DB, "SELECT course FROM check_items WHERE id = ?", (rd.get("id"),))
        ok("absent course keeps the menu default",
           s == 201 and rowd == [(fries.get("course"),)], f"s={s} row={rowd} default={fries.get('course')}")
        s, rb = req("POST", f"/api/checks/{cid}/items",
                    {"menu_item_id": eda["id"], "seat": 2, "qty": 1, "modifiers": salt_mod}, token=tok)
        rowb = q(DB, "SELECT note, allergy, allergy_detail FROM check_items WHERE id = ?",
                 (rb.get("id"),))
        ok("a bare body keeps note NULL / allergy 0 / detail NULL",
           s == 201 and rowb == [(None, 0, None)], f"s={s} row={rowb}")

        # ================= S: LAN node, sync batch =================
        print("\n== S: LAN sync stores the fields the envelope carries ==")
        seed_env = dict(os.environ, EXPOLINE_DB=LAN_DB)
        seed = subprocess.run(["node", str(ROOT / "db" / "seed.js")], env=seed_env,
                              cwd=str(ROOT), capture_output=True, text=True, timeout=120)
        ok("LAN db seeded", seed.returncode == 0, seed.stderr[-300:] if seed.returncode else "")
        lan = boot(LAN_PORT, LAN_DB, {
            "EXPOLINE_LAN": "1", "EXPOLINE_BRAIN_PRIORITY": "0",
            "EXPOLINE_DEVICE_ID": "qa43-brain", "EXPOLINE_LAN_PEERS": "127.0.0.1:9",
            "EXPOLINE_LAN_GOSSIP_PIN": SERVER_PIN,
        })
        brain = None
        for _ in range(60):
            s, st = req("GET", "/api/brain/status", base=LAN_BASE)
            if s == 200 and st.get("is_brain") and st.get("brain_device_id") == "qa43-brain":
                brain = st
                break
            time.sleep(0.5)
        ok("sole LAN node elected itself brain", brain is not None, f"{st if 'st' in dir() else ''}")
        s, llogin = req("POST", "/api/auth/login", {"pin": SERVER_PIN}, base=LAN_BASE)
        ltok = llogin.get("token")
        s, lmlogin = req("POST", "/api/auth/login", {"pin": MANAGER_PIN}, base=LAN_BASE)
        lmtok = lmlogin.get("token")
        lmenu = menu_items(lmtok, base=LAN_BASE)
        leda, lfries = lmenu.get("Edamame"), lmenu.get("Bali Fries")
        lflav = [g for g in leda["modifier_groups"] if g["name"] == "Flavor"][0]
        lsalt = [o for o in lflav["options"] if o["name"] == "Sea Salt"][0]
        ltable = free_table(ltok, base=LAN_BASE)

        lam = [0]

        def env_op(op_id, op, payload):
            lam[0] += 1
            return {"op_id": op_id, "site_slug": "bali-hai", "device_id": "qa43",
                    "seq": lam[0], "lamport": lam[0], "op": op, "payload": payload,
                    "created_at": "2026-10-06T07:00:00.000Z"}

        ops = [
            env_op("t43-open", "open_check",
                   {"check_uuid": "tmp-t43-c1", "table_id": ltable["id"], "guest_count": 4}),
            env_op("t43-add", "add_items",
                   {"check_uuid": "tmp-t43-c1", "items": [
                       {"item_uuid": "tmp-t43-i1", "menu_item_id": leda["id"], "seat": 1, "qty": 1,
                        "modifiers": [{"name": "Sea Salt", "option_id": lsalt["id"],
                                       "price_delta_cents": 0}],
                        "note": "no sauce", "allergy": True, "allergy_detail": "soy",
                        "course": "dessert"},
                       {"item_uuid": "tmp-t43-i2", "menu_item_id": lfries["id"], "seat": 1,
                        "qty": 1, "modifiers": []},
                   ]}),
        ]
        s, batch = req("POST", "/api/sync/batch", {"ops": ops}, token=ltok, base=LAN_BASE)
        res = {r.get("op_id"): r for r in (batch.get("results") or [])}
        ok("LAN batch accepted; open + add ok",
           s == 200 and res.get("t43-open", {}).get("ok") is True
           and res.get("t43-add", {}).get("ok") is True, f"s={s} {batch}")
        lcid = res.get("t43-open", {}).get("check_id")
        lrow = q(LAN_DB, "SELECT note, allergy, allergy_detail, course FROM check_items "
                         "WHERE uuid = 'tmp-t43-i1'")
        ok("sqlite (LAN): the synced line carries note / allergy / detail / picked course",
           lrow == [("no sauce", 1, "soy", "dessert")], f"row={lrow}")
        lrow2 = q(LAN_DB, "SELECT note, allergy, course FROM check_items WHERE uuid = 'tmp-t43-i2'")
        ok("sqlite (LAN): the bare envelope line keeps note NULL / allergy 0 / menu course",
           lrow2 == [(None, 0, lfries.get("course"))], f"row={lrow2}")
        s, lview = req("GET", f"/api/checks/{lcid}", token=ltok, base=LAN_BASE)
        lvline = [i for i in lview.get("items", []) if i.get("uuid") == "tmp-t43-i1"]
        ok("GET check view (LAN) shows the note / allergy / course",
           len(lvline) == 1 and lvline[0].get("note") == "no sauce"
           and lvline[0].get("allergy") is True and lvline[0].get("course") == "dessert",
           f"view={lvline}")

        bad = [env_op("t43-bad", "add_items",
                      {"check_uuid": "tmp-t43-c1", "items": [
                          {"item_uuid": "tmp-t43-i3", "menu_item_id": lfries["id"], "seat": 1,
                           "qty": 1, "modifiers": [], "course": "brunch"}]})]
        s, bbatch = req("POST", "/api/sync/batch", {"ops": bad}, token=ltok, base=LAN_BASE)
        bres = {r.get("op_id"): r for r in (bbatch.get("results") or [])}
        nbad = q(LAN_DB, "SELECT COUNT(*) FROM check_items WHERE uuid = 'tmp-t43-i3'")[0][0]
        ok("an out-of-vocabulary course is rejected (invalid_course) and inserts nothing",
           bres.get("t43-bad", {}).get("ok") is False
           and bres.get("t43-bad", {}).get("error") == "invalid_course" and nbad == 0,
           f"res={bres.get('t43-bad')} n={nbad}")

        # ================= client harness =================
        print("\n== client harness (REAL extracted functions) ==")
        r = subprocess.run(["node", str(HERE / "harness43_client.js"), app_js],
                           capture_output=True, text=True, timeout=120)
        print(r.stdout.rstrip())
        if r.stderr.strip():
            print(r.stderr.rstrip()[:1500])
        harness_fail = r.stdout.count("  FAIL ")
        harness_pass = r.stdout.count("  ok  ")
        ok("harness43 fully green", r.returncode == 0 and harness_fail == 0,
           f"rc={r.returncode} fails={harness_fail}")
        globals()["passed"] = passed + harness_pass - 1
        print(f"  (harness assertions passed: {harness_pass})")
    finally:
        stop(srv)
        stop(lan)

    print(f"\n==== test43: {passed} passed, {failed} failed ====")
    if failures:
        print("failures:", "; ".join(failures))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
