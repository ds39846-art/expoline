#!/usr/bin/env python3
"""test54 — 86 from the floor (audit gap #8).

WHY: "86" is restaurant language for "we're out of that — stop selling
it NOW." Before this batch, Expoline's only 86 was the MANAGER's
structural menu toggle (menu_items.active via POST
/api/admin/menu/86/:id): a menu-management act in settings, permanent
until a manager reversed it. A server who heard "that was the last
ribeye" had no floor-level way to stop the next three servers from
selling it. This batch adds a RUNTIME availability state separate from
active — menu_items.is_86 + a remaining countdown — flippable by every
staff role (server / kitchen / manager) via POST
/api/menu/items/:id/86, enforced server-side at RING time on every
insert path, with the countdown consumed atomically (conditional
UPDATE) so the last portion can never be sold twice.

Sections:
  Z  harness54 (client getMenu mapping + tile helpers) counted in
  A  endpoint gates + validation (roles, unknown item, bad bodies) +
     audit rows for floor 86 / restore
  B  idempotency: re-86 / re-restore are 200 no-ops with NO new audit
  C  payload propagation: staff /api/menu keeps the item WITH state;
     kiosk + guest menus exclude it (their inactive-item precedent);
     admin menu exposes the fields; login summary names it
  D  POST /items refuses an 86'd item naming it; restore re-enables
  E  send-now refuses the whole batch (line_index + item_name, nothing
     inserted); other items' happy path unaffected
  F  kiosk order refuses; happy path unaffected
  G  guest QR order refuses; happy path unaffected
  H  delivery order refuses
  I  waitlist: preorder validation refuses; seating after an 86 skips
     the line into preorder_skipped (no silent loss, no line rung)
  J  lines ALREADY on open checks are unaffected: a held line fires
     after the 86, a fired line's check pays + closes
  K  countdown lifecycle: set 2 -> ring (1 left, still orderable) ->
     ring (0, auto-86 with a 'system' item.86_auto audit row) -> next
     ring refused; an oversize ring refuses and consumes nothing;
     restore clears the countdown
  L  the remaining=1 RACE: two concurrent rings, exactly one 201
  M  send-now aggregation: two lines of the same item cannot jointly
     overrun the countdown (2+2 vs 3 refuses whole; 2+1 consumes to 0)
  N  LAN: floor 86 on the brain refuses synced add_items (item_86d,
     nothing stored); a menu_update op carries remaining and the brain
     consumes + auto-flips; an op carrying is_86 round-trips into the
     brain's /api/menu
  O  EOD: close-day does NOT clear the 86 state (persist-until-restored
     is the documented behavior)

Discriminating control at 071341f: POST /api/menu/items/:id/86 is 404,
/api/menu carries no is_86/remaining, and an item marked out in SQL
still rings on every path (no runtime availability exists).

Run: python3 qa/test54_eighty_six.py
"""
import json
import os
import signal
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HERE = Path(__file__).resolve().parent
PORT = 4393
LAN_PORT = 4394
DB = "/tmp/expoline-test54.db"
LAN_DB = "/tmp/expoline-test54-lan.db"
BASE = f"http://127.0.0.1:{PORT}"
LAN_BASE = f"http://127.0.0.1:{LAN_PORT}"
SERVER_PIN = "1111"
KITCHEN_PIN = "2222"
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
        with urllib.request.urlopen(r, timeout=20) as resp:
            return resp.status, json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode() or "{}")
        except Exception:
            return e.code, {}
    except Exception as e:
        return 0, {"error": str(e)}


def boot(port, db, extra=None):
    env = dict(os.environ, EXPOLINE_PORT=str(port), EXPOLINE_DB=db)
    if extra:
        env.update(extra)
    p = subprocess.Popen(["node", str(ROOT / "server.js")], env=env, cwd=str(ROOT),
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(80):
        s, _ = req("GET", "/api/health", base=f"http://127.0.0.1:{port}")
        if s == 200:
            return p
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
    assert s == 200, (s, r)
    return r.get("token")


def q(db, sql, args=()):
    con = sqlite3.connect(db)
    try:
        return con.execute(sql, args).fetchall()
    finally:
        con.close()


def cats_of(payload):
    if isinstance(payload, list):
        return payload
    return payload.get("categories", [])


def menu_map(tok, base=BASE):
    s, menu = req("GET", "/api/menu", token=tok, base=base)
    assert s == 200, (s, menu)
    return {it["name"]: it for c in cats_of(menu) for it in c.get("items", [])}


def audit_rows(db, item_id, action=None):
    if action:
        return q(db, "SELECT actor, action FROM menu_audit WHERE item_id = ? AND action = ?",
                 (item_id, action))
    return q(db, "SELECT actor, action FROM menu_audit WHERE item_id = ?", (item_id,))


def main():
    for f in (DB, LAN_DB):
        try:
            os.remove(f)
        except FileNotFoundError:
            pass

    print("== Z: harness54 — client getMenu mapping + tile helpers ==")
    h = subprocess.run(["node", str(HERE / "harness54_client.js")],
                       capture_output=True, text=True, timeout=120)
    ok("Z harness54 passes (real getMenu mapping keeps is_86/remaining; tile helpers)",
       h.returncode == 0 and "HARNESS54 PASS" in h.stdout,
       (h.stdout + h.stderr)[-400:])

    srv = boot(PORT, DB)
    lan = None
    try:
        tok = login(SERVER_PIN)
        ktok = login(KITCHEN_PIN)
        mtok = login(MANAGER_PIN)
        items = menu_map(tok)
        rib = items["14oz Ribeye"]
        eda = items["Edamame"]
        mai = items["BH Mai Tai"]
        ok("seed items resolved by name (Ribeye / Edamame / BH Mai Tai)",
           all(x and x.get("id") for x in (rib, eda, mai)), str((rib, eda, mai))[:200])

        table_pool = []

        def free_table(token=tok, base=BASE):
            if not table_pool:
                s, z = req("GET", "/api/zones", token=token, base=base)
                if isinstance(z, list):
                    z = {"zones": z}
                for zz in z.get("zones", []):
                    for t in zz.get("tables", []):
                        if not t.get("open_check_id"):
                            table_pool.append(t["id"])
            return table_pool.pop(0)

        def mkcheck():
            s, c = req("POST", "/api/checks", {"table_id": free_table(), "guest_count": 2}, token=tok)
            assert s == 201, (s, c)
            return c["id"]

        def floor86(item_id, body, token=tok):
            return req("POST", f"/api/menu/items/{item_id}/86", body, token=token)

        def mods_for(item):
            # Ribeye (Temperature) and Edamame (Flavor) carry REQUIRED
            # modifier groups; a valid ring selects the default option.
            for g in item.get("modifier_groups") or []:
                for o in g.get("options", []):
                    if o.get("is_default"):
                        return [{"name": o["name"], "option_id": o["id"],
                                 "price_delta_cents": o.get("price_delta_cents", 0)}]
            return []

        def ring(cid, item, qty=1, seat=1):
            return req("POST", f"/api/checks/{cid}/items",
                       {"menu_item_id": item["id"], "seat": seat, "qty": qty,
                        "modifiers": mods_for(item)}, token=tok)

        def sendnow(cid, lines):
            return req("POST", f"/api/checks/{cid}/send-now",
                       {"items": [{"menu_item_id": it["id"], "seat": st, "qty": q,
                                   "modifiers": mods_for(it)} for it, q, st in lines]},
                       token=tok)

        def menu_item(item_id, token=tok, base=BASE):
            for it in menu_map(token, base=base).values():
                if it["id"] == item_id:
                    return it
            return None

        # ================= A: gates + validation =================
        print("\n== A: endpoint gates + validation ==")
        s, r = req("POST", f"/api/menu/items/{rib['id']}/86", {"action": "out"})
        ok("A1 no auth -> 401", s == 401, f"{s} {r}")
        s, r = floor86(999999, {"action": "out"})
        ok("A2 unknown item -> 404 naming it", s == 404 and "not found" in (r.get("error") or ""), f"{s} {r}")
        s, r = floor86(rib["id"], {"action": "sideways"})
        ok("A3 bad action -> 400", s == 400, f"{s} {r}")
        s, r = floor86(rib["id"], {"action": "restore", "remaining": 3})
        ok("A4 remaining with restore -> 400", s == 400, f"{s} {r}")
        for bad in (0, -2, 1.5, "3"):
            s, r = floor86(rib["id"], {"action": "out", "remaining": bad})
            ok(f"A5 remaining={bad!r} -> 400", s == 400, f"{s} {r}")
        s, r = floor86(rib["id"], {"action": "out"}, token=ktok)
        ok("A6 kitchen can 86 (the kitchen calls it)", s == 200 and r.get("is_86") is True
           and r.get("remaining") is None, f"{s} {r}")
        rows = audit_rows(DB, rib["id"], "item.floor86")
        ok("A7 the floor 86 is audit-logged with the human actor",
           len(rows) == 1 and rows[0][0] not in ("system", None), f"{rows}")
        s, r = floor86(rib["id"], {"action": "restore"}, token=tok)
        ok("A8 a server can restore", s == 200 and r.get("is_86") is False, f"{s} {r}")
        ok("A9 the restore is audit-logged (item.floor_un86)",
           len(audit_rows(DB, rib["id"], "item.floor_un86")) == 1)
        s, r = floor86(rib["id"], {"action": "out"}, token=mtok)
        ok("A10 manager can 86 too", s == 200 and r.get("is_86") is True, f"{s} {r}")
        floor86(rib["id"], {"action": "restore"}, token=mtok)

        # ================= B: idempotency =================
        print("\n== B: idempotent re-86 / re-restore (no audit spam) ==")
        floor86(eda["id"], {"action": "out"}, token=tok)
        n_before = len(audit_rows(DB, eda["id"]))
        s, r = floor86(eda["id"], {"action": "out"}, token=ktok)
        ok("B1 re-86 of an out item -> 200 noop:true", s == 200 and r.get("noop") is True, f"{s} {r}")
        ok("B2 the no-op wrote NO new audit row", len(audit_rows(DB, eda["id"])) == n_before)
        floor86(eda["id"], {"action": "restore"}, token=tok)
        n_before = len(audit_rows(DB, eda["id"]))
        s, r = floor86(eda["id"], {"action": "restore"}, token=tok)
        ok("B3 re-restore of an available item -> 200 noop:true", s == 200 and r.get("noop") is True, f"{s} {r}")
        ok("B4 the restore no-op wrote NO new audit row", len(audit_rows(DB, eda["id"])) == n_before)
        s, r = floor86(eda["id"], {"action": "out", "remaining": 5}, token=tok)
        ok("B5 setting a countdown answers is_86:false + remaining:5",
           s == 200 and r.get("is_86") is False and r.get("remaining") == 5, f"{s} {r}")
        ok("B6 the countdown set is audit-logged (item.floor86_limit)",
           len(audit_rows(DB, eda["id"], "item.floor86_limit")) == 1)
        s, r = floor86(eda["id"], {"action": "out", "remaining": 5}, token=tok)
        ok("B7 re-setting the same countdown is a no-op", s == 200 and r.get("noop") is True, f"{s} {r}")
        floor86(eda["id"], {"action": "restore"}, token=tok)

        # ================= C: payload propagation =================
        print("\n== C: payload propagation across surfaces ==")
        floor86(rib["id"], {"action": "out"}, token=tok)
        mi = menu_item(rib["id"])
        ok("C1 staff /api/menu KEEPS the 86'd item, flagged (see it, don't wonder)",
           mi is not None and mi.get("is_86") is True and mi.get("remaining") is None, f"{mi}")
        s, km = req("GET", "/api/kiosk/menu")
        kflat = [i for c in cats_of(km) for i in c.get("items", [])]
        ok("C2 kiosk menu excludes the 86'd item (its inactive-item precedent)",
           s == 200 and all(i["id"] != rib["id"] for i in kflat), f"{s}")
        s, qr = req("GET", "/api/tables/1/qr", token=tok)
        qtok = qr.get("token")
        s, gm = req("GET", f"/api/guest/menu?token={qtok}")
        gflat = [i for c in cats_of(gm) for i in c.get("items", [])]
        ok("C3 guest menu excludes the 86'd item (its inactive-item precedent)",
           s == 200 and all(i["id"] != rib["id"] for i in gflat), f"{s}")
        s, am = req("GET", "/api/admin/menu", token=mtok)
        afl = [i for c in cats_of(am) for i in c.get("items", [])]
        arib = [i for i in afl if i["id"] == rib["id"]]
        ok("C4 admin menu payload exposes is_86/remaining for the editor",
           s == 200 and arib and arib[0].get("is_86") is True, f"{s} {str(arib)[:120]}")
        s, ls = req("GET", "/api/login-summary", token=tok)
        ok("C5 login summary's 86 list names the floor-86'd item",
           s == 200 and "14oz Ribeye" in (ls.get("eighty_six") or []), f"{s} {str(ls)[:200]}")

        # ================= D: POST /items enforcement =================
        print("\n== D: POST /items refuses the 86'd item, by name ==")
        cid = mkcheck()
        s, r = ring(cid, rib)
        ok("D1 ringing an 86'd item -> 400 '86: \"14oz Ribeye\" is sold out'",
           s == 400 and (r.get("error") or "") == '86: "14oz Ribeye" is sold out', f"{s} {r}")
        s, r = ring(cid, eda)
        ok("D2 other items still ring (happy path unaffected)", s == 201, f"{s} {r}")
        floor86(rib["id"], {"action": "restore"}, token=tok)
        s, r = ring(cid, rib)
        ok("D3 restore re-enables ringing", s == 201, f"{s} {r}")

        # ================= E: send-now enforcement =================
        print("\n== E: send-now refuses the whole batch, nothing inserted ==")
        floor86(rib["id"], {"action": "out"}, token=tok)
        cid2 = mkcheck()
        s, r = sendnow(cid2, [(eda, 1, 1), (rib, 1, 1)])
        ok("E1 a batch containing an 86'd line -> 400 with line_index + item_name",
           s == 400 and r.get("line_index") == 1 and r.get("item_name") == "14oz Ribeye"
           and "sold out" in (r.get("error") or ""), f"{s} {r}")
        s, chk = req("GET", f"/api/checks/{cid2}", token=tok)
        ok("E2 NOTHING from the refused batch was inserted",
           s == 200 and len(chk.get("items") or []) == 0, f"{str(chk)[:160]}")
        s, r = sendnow(cid2, [(eda, 1, 1)])
        ok("E3 a clean batch still sends (happy path)", s in (200, 201), f"{s} {r}")
        floor86(rib["id"], {"action": "restore"}, token=tok)

        # ================= F: kiosk =================
        print("\n== F: kiosk order enforcement ==")
        floor86(mai["id"], {"action": "out"}, token=ktok)
        s, r = req("POST", "/api/kiosk/order",
                   {"customer_name": "QA54", "items": [{"menu_item_id": mai["id"], "qty": 1}]})
        ok("F1 kiosk order of an 86'd item -> 400 naming it 86'd",
           s == 400 and "BH Mai Tai" in (r.get("error") or "") and "86" in (r.get("error") or ""), f"{s} {r}")
        s, r = req("POST", "/api/kiosk/order",
                   {"customer_name": "QA54", "items": [{"menu_item_id": eda["id"], "qty": 1}]})
        ok("F2 kiosk order of an available item still works", s == 201, f"{s} {r}")
        floor86(mai["id"], {"action": "restore"}, token=tok)

        # ================= G: guest QR =================
        print("\n== G: guest QR order enforcement ==")
        floor86(mai["id"], {"action": "out"}, token=tok)
        s, r = req("POST", "/api/guest/orders",
                   {"token": qtok, "guest_name": "QA54", "items": [{"menu_item_id": mai["id"], "qty": 1, "seat": 1}]})
        ok("G1 guest order of an 86'd item -> 400 naming it 86'd",
           s == 400 and "BH Mai Tai" in (r.get("error") or "") and "86" in (r.get("error") or ""), f"{s} {r}")
        s, r = req("POST", "/api/guest/orders",
                   {"token": qtok, "guest_name": "QA54", "items": [{"menu_item_id": eda["id"], "qty": 1, "seat": 1}]})
        ok("G2 guest order of an available item still works", s == 201, f"{s} {r}")
        floor86(mai["id"], {"action": "restore"}, token=tok)

        # ================= H: delivery =================
        print("\n== H: delivery order enforcement ==")
        floor86(mai["id"], {"action": "out"}, token=tok)
        s, r = req("POST", "/api/delivery/orders",
                   {"source": "DoorDash", "customer_name": "QA54",
                    "items": [{"menu_item_id": mai["id"], "qty": 1}]}, token=tok)
        ok("H1 delivery order of an 86'd item -> 400 naming it 86'd",
           s == 400 and "BH Mai Tai" in (r.get("error") or "") and "86" in (r.get("error") or ""), f"{s} {r}")
        floor86(mai["id"], {"action": "restore"}, token=tok)

        # ================= I: waitlist =================
        print("\n== I: waitlist preorder validation + seating skip ==")
        floor86(rib["id"], {"action": "out"}, token=tok)
        s, r = req("POST", "/api/waitlist",
                   {"customer_name": "QA54 Wait", "party_size": 2,
                    "preorder_items": [{"menu_item_id": rib["id"], "qty": 1, "seat": 1}]}, token=tok)
        ok("I1 a preorder naming an 86'd item -> 400 naming it",
           s == 400 and "14oz Ribeye" in (r.get("error") or ""), f"{s} {r}")
        floor86(rib["id"], {"action": "restore"}, token=tok)
        s, w = req("POST", "/api/waitlist",
                   {"customer_name": "QA54 Wait2", "party_size": 2,
                    "preorder_items": [{"menu_item_id": rib["id"], "qty": 1, "seat": 1}]}, token=tok)
        ok("I2 the same preorder is accepted while available", s == 201, f"{s} {w}")
        floor86(rib["id"], {"action": "out"}, token=tok)
        s, seat = req("POST", f"/api/waitlist/{w['id']}/seat", {"table_id": free_table()}, token=tok)
        ok("I3 seating after the 86 skips the line (preorder_skipped names it)",
           s == 200 and (seat.get("preorder_skipped") or []) == ["14oz Ribeye"]
           and seat.get("preorder_attached") == 0, f"{s} {str(seat)[:220]}")
        s, chk = req("GET", f"/api/checks/{seat.get('check_id')}", token=tok)
        ok("I4 no line for the skipped item landed on the seated check",
           s == 200 and all(i.get("menu_item_id") != rib["id"] for i in chk.get("items") or []),
           f"{str(chk)[:160]}")
        floor86(rib["id"], {"action": "restore"}, token=tok)

        # ================= J: existing lines unaffected =================
        print("\n== J: lines already on open checks are unaffected ==")
        cidJ = mkcheck()
        s, held = ring(cidJ, rib)
        ok("J1 setup: ribeye held on an open check", s == 201, f"{s} {held}")
        cidJ2 = mkcheck()
        s, r = sendnow(cidJ2, [(rib, 1, 1)])
        ok("J2 setup: ribeye fired on a second check", s in (200, 201), f"{s} {r}")
        floor86(rib["id"], {"action": "out"}, token=tok)
        s, r = req("POST", f"/api/checks/{cidJ}/send", {}, token=tok)
        ok("J3 the HELD line still fires after the 86", s == 200, f"{s} {r}")
        for cidX, tag in ((cidJ, "J4"), (cidJ2, "J5")):
            s, chk = req("GET", f"/api/checks/{cidX}", token=tok)
            tot = chk["totals"]["total"]
            s, r = req("POST", f"/api/checks/{cidX}/payments",
                       {"method": "cash", "amount_cents": tot, "tip_cents": 0, "tendered_cents": tot},
                       token=tok)
            s2, r2 = req("POST", f"/api/checks/{cidX}/close", {}, token=tok)
            ok(f"{tag} the check containing the 86'd item pays + closes normally",
               s in (200, 201) and s2 == 200, f"pay={s} {r} close={s2} {r2}")
        floor86(rib["id"], {"action": "restore"}, token=tok)

        # ================= K: countdown lifecycle =================
        print("\n== K: countdown lifecycle (set 2 -> 1 -> auto-86 at 0) ==")
        s, r = floor86(eda["id"], {"action": "out", "remaining": 2}, token=ktok)
        ok("K1 countdown set: remaining 2, not out", s == 200 and r.get("remaining") == 2
           and r.get("is_86") is False, f"{s} {r}")
        mi = menu_item(eda["id"])
        ok("K2 the menu payload shows the count (the floor sees '2 left')",
           mi.get("remaining") == 2 and mi.get("is_86") is False, f"{mi}")
        cidK = mkcheck()
        s, r = ring(cidK, eda)
        ok("K3 first ring succeeds", s == 201, f"{s} {r}")
        mi = menu_item(eda["id"])
        ok("K4 remaining ticks to 1, still orderable",
           mi.get("remaining") == 1 and mi.get("is_86") is False, f"{mi}")
        s, r = ring(cidK, eda)
        ok("K5 second ring succeeds", s == 201, f"{s} {r}")
        mi = menu_item(eda["id"])
        ok("K6 at zero the item auto-86s (is_86 true, remaining 0)",
           mi.get("remaining") == 0 and mi.get("is_86") is True, f"{mi}")
        auto = audit_rows(DB, eda["id"], "item.86_auto")
        ok("K7 the auto-86 is audit-logged with actor 'system' (honest: the count ran out)",
           len(auto) == 1 and auto[0][0] == "system", f"{auto}")
        s, r = ring(cidK, eda)
        ok("K8 the next ring refuses as sold out", s == 400 and "sold out" in (r.get("error") or ""), f"{s} {r}")
        # Oversize ring against a fresh countdown consumes nothing.
        floor86(eda["id"], {"action": "restore"}, token=tok)
        floor86(eda["id"], {"action": "out", "remaining": 2}, token=tok)
        s, r = ring(cidK, eda, qty=3)
        ok("K9 a ring larger than the count refuses ('has only 2 left')",
           s == 400 and "only 2 left" in (r.get("error") or ""), f"{s} {r}")
        mi = menu_item(eda["id"])
        ok("K10 the refused ring consumed nothing", mi.get("remaining") == 2, f"{mi}")
        s, r = floor86(eda["id"], {"action": "restore"}, token=tok)
        mi = menu_item(eda["id"])
        ok("K11 restore clears BOTH the flag and the countdown",
           s == 200 and r.get("remaining") is None and mi.get("is_86") is False
           and mi.get("remaining") is None, f"{s} {r} {mi}")

        # ================= L: the race =================
        print("\n== L: remaining=1 race — two concurrent rings, exactly one wins ==")
        floor86(mai["id"], {"action": "out", "remaining": 1}, token=tok)
        race_checks = [mkcheck(), mkcheck()]
        results = []

        def race_ring(cid):
            results.append(ring(cid, mai))
        threads = [threading.Thread(target=race_ring, args=(c,)) for c in race_checks]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        codes = sorted(s for s, _ in results)
        ok("L1 exactly one 201 and one 400", codes == [201, 400], f"{results}")
        loser = [r for s, r in results if s == 400][0]
        ok("L2 the loser is told the truth (sold out / only N left)",
           "86" in (loser.get("error") or ""), f"{loser}")
        n_lines = sum(len(q(DB, "SELECT id FROM check_items WHERE check_id = ? AND menu_item_id = ?",
                            (c, mai["id"]))) for c in race_checks)
        ok("L3 exactly one line landed across both checks", n_lines == 1, f"lines={n_lines}")
        mi = menu_item(mai["id"])
        ok("L4 the count ended at exactly 0 with the item out (no oversell, no negative)",
           mi.get("remaining") == 0 and mi.get("is_86") is True, f"{mi}")
        floor86(mai["id"], {"action": "restore"}, token=tok)

        # ================= M: send-now aggregation =================
        print("\n== M: send-now cannot split a countdown across two lines ==")
        floor86(eda["id"], {"action": "out", "remaining": 3}, token=tok)
        cidM = mkcheck()
        s, r = sendnow(cidM, [(eda, 2, 1), (eda, 2, 2)])
        ok("M1 lines 2+2 against 3 left -> 400 (aggregated, not per-line)",
           s == 400 and "only 3 left" in (r.get("error") or ""), f"{s} {r}")
        s, chk = req("GET", f"/api/checks/{cidM}", token=tok)
        mi = menu_item(eda["id"])
        ok("M2 nothing inserted and nothing consumed by the refused batch",
           len(chk.get("items") or []) == 0 and mi.get("remaining") == 3, f"{mi}")
        s, r = sendnow(cidM, [(eda, 2, 1), (eda, 1, 2)])
        ok("M3 lines 2+1 against 3 left -> sent", s in (200, 201), f"{s} {r}")
        mi = menu_item(eda["id"])
        ok("M4 the batch consumed the count to 0 and auto-86'd",
           mi.get("remaining") == 0 and mi.get("is_86") is True, f"{mi}")
        floor86(eda["id"], {"action": "restore"}, token=tok)

        # ================= N: LAN =================
        print("\n== N: LAN brain enforces + syncs the 86 state ==")
        seed = subprocess.run(["node", str(ROOT / "db" / "seed.js")],
                              env=dict(os.environ, EXPOLINE_DB=LAN_DB), cwd=str(ROOT),
                              capture_output=True, text=True, timeout=120)
        ok("N0 LAN db seeded", seed.returncode == 0, seed.stderr[-200:] if seed.returncode else "")
        lan = boot(LAN_PORT, LAN_DB, {
            "EXPOLINE_LAN": "1", "EXPOLINE_BRAIN_PRIORITY": "0",
            "EXPOLINE_DEVICE_ID": "qa54-brain", "EXPOLINE_LAN_PEERS": "127.0.0.1:9",
            "EXPOLINE_LAN_GOSSIP_PIN": SERVER_PIN,
        })
        brain = None
        for _ in range(60):
            s, st = req("GET", "/api/brain/status", base=LAN_BASE)
            if s == 200 and st.get("is_brain"):
                brain = st
                break
            time.sleep(0.5)
        ok("N1 sole LAN node elected itself brain", brain is not None)
        ltok = login(SERVER_PIN, base=LAN_BASE)
        lmtok = login(MANAGER_PIN, base=LAN_BASE)
        litems = menu_map(ltok, base=LAN_BASE)
        leda, lrib = litems["Edamame"], litems["14oz Ribeye"]
        # Floor-86 the item on the brain itself (REST), then a synced
        # add_items for it must refuse and store nothing.
        s, r = req("POST", f"/api/menu/items/{leda['id']}/86", {"action": "out"},
                   token=ltok, base=LAN_BASE)
        ok("N2 floor 86 works on the brain", s == 200 and r.get("is_86") is True, f"{s} {r}")
        s, zones = req("GET", "/api/zones", token=ltok, base=LAN_BASE)
        if isinstance(zones, list):
            zones = {"zones": zones}
        ltable = None
        for zz in zones.get("zones", []):
            for t in zz.get("tables", []):
                if not t.get("open_check_id"):
                    ltable = t["id"]
                    break
            if ltable:
                break
        lam = [100]

        def env_op(op_id, op, payload):
            lam[0] += 1
            return {"op_id": op_id, "site_slug": "bali-hai", "device_id": "qa54",
                    "seq": lam[0], "lamport": lam[0], "op": op, "payload": payload,
                    "created_at": "2026-10-06T07:00:00.000Z"}

        ops = [
            env_op("t54-open", "open_check",
                   {"check_uuid": "tmp-t54-c1", "table_id": ltable, "guest_count": 2}),
            env_op("t54-add86", "add_items",
                   {"check_uuid": "tmp-t54-c1", "items": [
                       {"item_uuid": "tmp-t54-i1", "menu_item_id": leda["id"], "seat": 1,
                        "qty": 1, "modifiers": []}]}),
        ]
        s, batch = req("POST", "/api/sync/batch", {"ops": ops}, token=ltok, base=LAN_BASE)
        res = {x.get("op_id"): x for x in (batch.get("results") or [])}
        ok("N3 synced add_items for the 86'd item refuses item_86d naming it",
           res.get("t54-add86", {}).get("ok") is False
           and res.get("t54-add86", {}).get("error") == "item_86d"
           and res.get("t54-add86", {}).get("item_name") == "Edamame", f"{batch}")
        ok("N4 the refused op stored no line",
           q(LAN_DB, "SELECT id FROM check_items WHERE uuid = 'tmp-t54-i1'") == [])
        # A menu_update op carries the countdown; the brain consumes it.
        ver = q(LAN_DB, "SELECT version FROM menu_items WHERE id = ?", (lrib["id"],))[0][0] or 1
        ops = [env_op("t54-mu", "menu_update",
                      {"item_id": lrib["id"], "version": ver + 1, "remaining": 1})]
        s, batch = req("POST", "/api/sync/batch", {"ops": ops}, token=lmtok, base=LAN_BASE)
        res = {x.get("op_id"): x for x in (batch.get("results") or [])}
        ok("N5 menu_update op accepts + reports the countdown",
           res.get("t54-mu", {}).get("ok") is True and res.get("t54-mu", {}).get("remaining") == 1,
           f"{batch}")
        ops = [env_op("t54-add1", "add_items",
                      {"check_uuid": "tmp-t54-c1", "items": [
                          {"item_uuid": "tmp-t54-i2", "menu_item_id": lrib["id"], "seat": 1,
                           "qty": 1, "modifiers": []}]})]
        s, batch = req("POST", "/api/sync/batch", {"ops": ops}, token=ltok, base=LAN_BASE)
        res = {x.get("op_id"): x for x in (batch.get("results") or [])}
        ok("N6 the synced ring consumes the last count", res.get("t54-add1", {}).get("ok") is True,
           f"{batch}")
        row = q(LAN_DB, "SELECT is_86, remaining FROM menu_items WHERE id = ?", (lrib["id"],))
        ok("N7 the brain auto-flipped at zero", row == [(1, 0)], f"{row}")
        mi = menu_item(lrib["id"], token=ltok, base=LAN_BASE)
        ok("N8 the brain's /api/menu shows the item out",
           mi is not None and mi.get("is_86") is True, f"{mi}")
        ops = [env_op("t54-add2", "add_items",
                      {"check_uuid": "tmp-t54-c1", "items": [
                          {"item_uuid": "tmp-t54-i3", "menu_item_id": lrib["id"], "seat": 1,
                           "qty": 1, "modifiers": []}]})]
        s, batch = req("POST", "/api/sync/batch", {"ops": ops}, token=ltok, base=LAN_BASE)
        res = {x.get("op_id"): x for x in (batch.get("results") or [])}
        ok("N9 further synced rings refuse item_86d",
           res.get("t54-add2", {}).get("ok") is False
           and res.get("t54-add2", {}).get("error") == "item_86d", f"{batch}")

        # ================= O: EOD persistence =================
        print("\n== O: close-day does NOT clear the 86 state ==")
        floor86(mai["id"], {"action": "out"}, token=tok)
        today = time.strftime("%Y-%m-%d", time.localtime())
        s, r = req("POST", "/api/finance/close-day",
                   {"date": today, "counted_cash_cents": 0, "manager_pin": MANAGER_PIN}, token=mtok)
        ok("O1 close-day completes", s == 201, f"{s} {str(r)[:160]}")
        mi = menu_item(mai["id"])
        ok("O2 the item is STILL 86'd after close-day (persist until a human restores it)",
           mi is not None and mi.get("is_86") is True, f"{mi}")
        floor86(mai["id"], {"action": "restore"}, token=tok)

    finally:
        stop(lan)
        stop(srv)

    print(f"\n{'=' * 60}")
    print(f"test54: {passed} passed, {failed} failed")
    if failures:
        print("failures:")
        for f in failures:
            print(f"  - {f}")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
