#!/usr/bin/env python3
"""
test44 — KDS ticket + pending-preview field fidelity (the two places
batch f055563 did NOT reach, confirmed by independent QA):

  GAP 1 (safety-relevant): lan/store.js `send` composed ticket items
  as {item_id, item_uuid, name, seat, qty, modifiers} only. The
  mainline fire (server.js fireHeldItemsToKdsCore) composes
  {item_id, name, seat, qty, course, modifiers, note, allergy,
  allergy_detail} — and ticketView derives the ticket-level
  has_allergy banner from items_json, while the KDS renders the
  per-line allergy flag/detail and note from those same fields. A
  line fired through the LAN brain therefore reached the kitchen
  display with NO allergy flag, NO note, and no course, even though
  the check row (post-f055563) stores all of it.

  GAP 2 (display-only): applyOps (public/app.js) overlaid queued
  offline lines onto the check view without note / allergy /
  allergy_detail / course, so the originating device previewed its
  own pending line without the allergy flag until sync. Covered by
  harness44 against the REAL extracted applyOps.

Sections:
  M  (plain server, HTTP) — the mainline reference: POST /items with
     the four fields, POST /send, read the ticket back through
     GET /api/kds/tickets (the ticketView the KDS consumes): the
     Edamame item carries course/note/allergy/allergy_detail, the
     ticket has_allergy is true, ticket_courses sees the course; a
     no-allergy control check fires a ticket with has_allergy false.
  T  (LAN node, HTTP) — the same lines arrive via /api/sync/batch
     add_items and are fired by the batch `send` op: the ticket read
     back (API view AND sqlite items_json) carries the four fields
     with the same values as the mainline ticket, has_allergy is
     true, and the item key set matches the mainline item key set
     plus the LAN-only item_uuid (the documented KDS dedupe key).
     A no-allergy LAN control fires has_allergy false.
  harness44 (node) — the REAL extracted applyOps: a queued full-field
     line previews with note/allergy/allergy_detail/course under the
     itemView key names and normalization; a pre-field line previews
     the neutral values; queued-send overlay behavior is preserved.

Discriminating control: run this suite from a 7339873 worktree —
section T finds the LAN ticket items WITHOUT the four fields and
has_allergy false despite the allergy on the check row, the key-set
parity check fails, and harness S2–S7 fail (overlay lines lack the
keys). Section M passes at both commits (the mainline composition
was always correct — it is the reference being mirrored).
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
PORT = 4355
LAN_PORT = 4356
DB = "/tmp/expoline-test44.db"
LAN_DB = "/tmp/expoline-test44-lan.db"
BASE = f"http://127.0.0.1:{PORT}"
LAN_BASE = f"http://127.0.0.1:{LAN_PORT}"
SERVER_PIN = "1111"
KITCHEN_PIN = "2222"
MANAGER_PIN = "2580"
FIDELITY = {"course", "note", "allergy", "allergy_detail"}

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


def login(pin, base=BASE):
    s, r = req("POST", "/api/auth/login", {"pin": pin}, base=base)
    return r.get("token")


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


def salt_mod(item):
    flav = [g for g in item["modifier_groups"] if g["name"] == "Flavor"][0]
    sea = [o for o in flav["options"] if o["name"] == "Sea Salt"][0]
    return [{"name": "Sea Salt", "option_id": sea["id"], "price_delta_cents": 0}]


def tickets_for(ktok, cid, base=BASE):
    s, tickets = req("GET", "/api/kds/tickets?status=all", token=ktok, base=base)
    if not isinstance(tickets, list):
        return []
    return [t for t in tickets if t.get("check_id") == cid]


def find_item(tickets, name):
    for t in tickets:
        for it in t.get("items", []):
            if it.get("name") == name:
                return t, it
    return None, None


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
    mainline_item = None
    try:
        # ================= M: mainline fire — the reference =================
        print("== M: mainline /send ticket composition (the reference) ==")
        srv = boot(PORT, DB, {"NODE_ENV": "test"})
        tok = login(SERVER_PIN)
        ktok = login(KITCHEN_PIN)
        mtok = login(MANAGER_PIN)
        ok("logins (server + kitchen + manager)", bool(tok) and bool(ktok) and bool(mtok))

        by_name = menu_items(mtok)
        eda, fries = by_name.get("Edamame"), by_name.get("Bali Fries")
        ok("fixture menu: Edamame (Flavor group) + Bali Fries",
           bool(eda and fries and eda.get("modifier_groups")), f"eda={bool(eda)} fries={bool(fries)}")
        smod = salt_mod(eda)

        table = free_table(tok)
        s, opened = req("POST", "/api/checks", {"table_id": table["id"], "guest_count": 4}, token=tok)
        cid = (opened.get("check") or opened or {}).get("id")
        s, r = req("POST", f"/api/checks/{cid}/items",
                   {"menu_item_id": eda["id"], "seat": 1, "qty": 1, "modifiers": smod,
                    "note": "no sauce", "allergy": True, "allergy_detail": "soy",
                    "course": "dessert"}, token=tok)
        ok("mainline: full-field Edamame held", s == 201, f"s={s} {r}")
        s, r = req("POST", f"/api/checks/{cid}/items",
                   {"menu_item_id": fries["id"], "seat": 1, "qty": 1, "modifiers": []}, token=tok)
        ok("mainline: bare Bali Fries held", s == 201, f"s={s} {r}")
        s, sent = req("POST", f"/api/checks/{cid}/send", {}, token=tok)
        ok("mainline: /send fired", s == 200 and sent.get("sent") == 2, f"s={s} {sent}")

        mtix = tickets_for(ktok, cid)
        mt, mitem = find_item(mtix, "Edamame")
        ok("mainline: a ticket for the check carries the Edamame", mitem is not None,
           f"tickets={len(mtix)}")
        if mitem is not None:
            mainline_item = mitem
            ok("mainline: ticket item carries course / note / allergy / detail",
               mitem.get("course") == "dessert" and mitem.get("note") == "no sauce"
               and bool(mitem.get("allergy")) and mitem.get("allergy_detail") == "soy",
               f"item={mitem}")
            ok("mainline: ticket has_allergy is true (the KDS banner input)",
               mt.get("has_allergy") is True, f"has_allergy={mt.get('has_allergy')}")
            ok("mainline: ticket_courses sees the picked course",
               "dessert" in (mt.get("ticket_courses") or []),
               f"courses={mt.get('ticket_courses')}")

        table2 = free_table(tok)
        s, opened2 = req("POST", "/api/checks", {"table_id": table2["id"], "guest_count": 2}, token=tok)
        cid2 = (opened2.get("check") or opened2 or {}).get("id")
        req("POST", f"/api/checks/{cid2}/items",
            {"menu_item_id": fries["id"], "seat": 1, "qty": 1, "modifiers": []}, token=tok)
        req("POST", f"/api/checks/{cid2}/send", {}, token=tok)
        ct, citem = find_item(tickets_for(ktok, cid2), "Bali Fries")
        ok("mainline control: a no-allergy ticket fires has_allergy false",
           ct is not None and ct.get("has_allergy") is False and not citem.get("allergy"),
           f"ticket={ct and ct.get('has_allergy')} item={citem}")

        # ================= T: LAN batch send =================
        print("\n== T: LAN-fired ticket carries the same fields ==")
        seed_env = dict(os.environ, EXPOLINE_DB=LAN_DB)
        seed = subprocess.run(["node", str(ROOT / "db" / "seed.js")], env=seed_env,
                              cwd=str(ROOT), capture_output=True, text=True, timeout=120)
        ok("LAN db seeded", seed.returncode == 0, seed.stderr[-300:] if seed.returncode else "")
        lan = boot(LAN_PORT, LAN_DB, {
            "EXPOLINE_LAN": "1", "EXPOLINE_BRAIN_PRIORITY": "0",
            "EXPOLINE_DEVICE_ID": "qa44-brain", "EXPOLINE_LAN_PEERS": "127.0.0.1:9",
            "EXPOLINE_LAN_GOSSIP_PIN": SERVER_PIN,
        })
        brain = None
        for _ in range(60):
            s, st = req("GET", "/api/brain/status", base=LAN_BASE)
            if s == 200 and st.get("is_brain") and st.get("brain_device_id") == "qa44-brain":
                brain = st
                break
            time.sleep(0.5)
        ok("sole LAN node elected itself brain", brain is not None)
        ltok = login(SERVER_PIN, base=LAN_BASE)
        lktok = login(KITCHEN_PIN, base=LAN_BASE)
        lmtok = login(MANAGER_PIN, base=LAN_BASE)
        lmenu = menu_items(lmtok, base=LAN_BASE)
        leda, lfries = lmenu.get("Edamame"), lmenu.get("Bali Fries")
        lsmod = salt_mod(leda)
        s, zones = req("GET", "/api/zones", token=ltok, base=LAN_BASE)
        if isinstance(zones, list):
            zones = {"zones": zones}
        free_tables = [t for z in zones.get("zones", []) for t in z.get("tables", [])
                       if not t.get("open_check_id")]
        ltable = free_tables[0] if free_tables else None
        ltable2 = free_tables[1] if len(free_tables) > 1 else None

        lam = [0]

        def env_op(op_id, op, payload):
            lam[0] += 1
            return {"op_id": op_id, "site_slug": "bali-hai", "device_id": "qa44",
                    "seq": lam[0], "lamport": lam[0], "op": op, "payload": payload,
                    "created_at": "2026-10-06T07:30:00.000Z"}

        def batch(ops):
            s, b = req("POST", "/api/sync/batch", {"ops": ops}, token=ltok, base=LAN_BASE)
            return s, {r.get("op_id"): r for r in (b.get("results") or [])}

        s, res = batch([
            env_op("t44-open", "open_check",
                   {"check_uuid": "tmp-t44-c1", "table_id": ltable["id"], "guest_count": 4}),
            env_op("t44-add", "add_items",
                   {"check_uuid": "tmp-t44-c1", "items": [
                       {"item_uuid": "tmp-t44-i1", "menu_item_id": leda["id"], "seat": 1, "qty": 1,
                        "modifiers": lsmod, "note": "no sauce", "allergy": True,
                        "allergy_detail": "soy", "course": "dessert"},
                       {"item_uuid": "tmp-t44-i2", "menu_item_id": lfries["id"], "seat": 1,
                        "qty": 1, "modifiers": []},
                   ]}),
        ])
        ok("LAN batch accepted; open + add ok",
           s == 200 and res.get("t44-open", {}).get("ok") is True
           and res.get("t44-add", {}).get("ok") is True, f"s={s} {res}")
        lcid = res.get("t44-open", {}).get("check_id")

        s, res = batch([env_op("t44-send", "send", {"check_uuid": "tmp-t44-c1"})])
        sres = res.get("t44-send", {})
        ok("LAN send op fired both held lines",
           s == 200 and sres.get("ok") is True and sres.get("sent") == 2, f"s={s} {sres}")

        ltix = tickets_for(lktok, lcid, base=LAN_BASE)
        lt, litem = find_item(ltix, "Edamame")
        ok("LAN: a ticket for the check carries the Edamame", litem is not None,
           f"tickets={len(ltix)}")
        if litem is not None:
            ok("LAN: ticket item carries note / allergy / detail / picked course",
               litem.get("note") == "no sauce" and bool(litem.get("allergy"))
               and litem.get("allergy_detail") == "soy" and litem.get("course") == "dessert",
               f"item={litem}")
            ok("LAN: ticket has_allergy is true (the KDS banner input)",
               lt.get("has_allergy") is True, f"has_allergy={lt.get('has_allergy')}")
            ok("LAN: ticket_courses sees the picked course",
               "dessert" in (lt.get("ticket_courses") or []),
               f"courses={lt.get('ticket_courses')}")
            raw = q(LAN_DB, "SELECT items_json FROM kds_tickets WHERE check_id = ?", (lcid,))
            raw_items = [it for (ij,) in raw for it in json.loads(ij)]
            raw_eda = [it for it in raw_items if it.get("name") == "Edamame"]
            ok("LAN: sqlite items_json itself carries the four fields (not a view patch)",
               len(raw_eda) == 1 and raw_eda[0].get("note") == "no sauce"
               and bool(raw_eda[0].get("allergy")) and raw_eda[0].get("allergy_detail") == "soy"
               and raw_eda[0].get("course") == "dessert",
               f"raw={raw_eda}")
            if mainline_item is not None:
                ok("parity: the fidelity fields ride BOTH ticket shapes",
                   FIDELITY <= set(mainline_item) and FIDELITY <= set(litem),
                   f"main={sorted(mainline_item)} lan={sorted(litem)}")
                ok("parity: LAN item key set == mainline key set + item_uuid (the KDS dedupe key)",
                   set(litem) - {"item_uuid"} == set(mainline_item),
                   f"main={sorted(mainline_item)} lan={sorted(litem)}")
                ok("parity: allergy value representation matches the mainline fire",
                   litem.get("allergy") == mainline_item.get("allergy"),
                   f"main={mainline_item.get('allergy')} lan={litem.get('allergy')}")

        s, res = batch([
            env_op("t44-open2", "open_check",
                   {"check_uuid": "tmp-t44-c2", "table_id": ltable2["id"], "guest_count": 2}),
            env_op("t44-add2", "add_items",
                   {"check_uuid": "tmp-t44-c2", "items": [
                       {"item_uuid": "tmp-t44-i3", "menu_item_id": lfries["id"], "seat": 1,
                        "qty": 1, "modifiers": []}]}),
            env_op("t44-send2", "send", {"check_uuid": "tmp-t44-c2"}),
        ])
        lcid2 = res.get("t44-open2", {}).get("check_id")
        ct2, citem2 = find_item(tickets_for(lktok, lcid2, base=LAN_BASE), "Bali Fries")
        ok("LAN control: a no-allergy ticket fires has_allergy false",
           ct2 is not None and ct2.get("has_allergy") is False and not citem2.get("allergy"),
           f"ticket={ct2 and ct2.get('has_allergy')} item={citem2}")

        # ================= client harness =================
        print("\n== client harness (REAL extracted applyOps) ==")
        r = subprocess.run(["node", str(HERE / "harness44_client.js"), app_js],
                           capture_output=True, text=True, timeout=120)
        print(r.stdout.rstrip())
        if r.stderr.strip():
            print(r.stderr.rstrip()[:1500])
        harness_fail = r.stdout.count("  FAIL ")
        harness_pass = r.stdout.count("  ok  ")
        ok("harness44 fully green", r.returncode == 0 and harness_fail == 0,
           f"rc={r.returncode} fails={harness_fail}")
        globals()["passed"] = passed + harness_pass - 1
        print(f"  (harness assertions passed: {harness_pass})")
    finally:
        stop(srv)
        stop(lan)

    print(f"\n==== test44: {passed} passed, {failed} failed ====")
    if failures:
        print("failures:", "; ".join(failures))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
