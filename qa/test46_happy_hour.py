#!/usr/bin/env python3
"""test46_happy_hour.py — time-based (happy-hour) pricing, audit gap #2.

What is pinned here:

  A  Manager-set HH price: PUT/POST on the admin menu API stores
     hh_price_cents next to price_cents; negative, fractional and
     string values 400; null clears; absent leaves the stored value;
     the admin read model returns it.
  B  Window binding: HH pricing is live exactly while the site's
     current daypart window is a pricing window. Three bindings are
     exercised — a window flagged pricing:true, an unflagged window
     named HAPPY HOUR (schedules saved before the flag existed), and a
     flagged window with any other name — plus a plain all-day window
     where pricing is OFF. Windows are forced with start=end=00:00,
     which the daypart clock treats as all-day: no wall-clock games.
  C  Charge paths (HH on): POST /items, send-now, and the LAN store
     add_items all charge the HH price (BH Mai Tai 1450 -> 900); an
     item with no HH price charges regular; the menu payload exposes
     price_cents / hh_price_cents / effective_price_cents / hh_active
     and the effective price equals what gets charged.
  D  HH off: the same item charges 1450 on POST /items and the payload
     effective price is 1450 with hh_active false.
  E  Snapshot semantics: a line rung (held) during HH keeps 900 in
     totals and in the card_demo payment after the window flips off;
     a line rung after the flip on a fresh check charges 1450.
  F  Market price: an MP item (price_cents 0) carrying an hh price is
     never HH-priced — servers still 403, a manager price still wins.
  G  Rider (from bar-tab QA): PATCH cannot blank a bar tab's name
     (null / empty / whitespace -> 400), renaming works, the ≤40 rule
     holds, and a table check's optional label still clears to null.
  H  Client wiring: harness46 drives the real dispPrice / priceHtml
     out of public/app.js; static asserts pin the getMenu pass-through,
     the menu-editor HH field, and the daypart pricing checkbox.

Discriminating control: at 6fc816a there is no hh_price_cents anywhere —
the admin PUT drops the unknown field (read model has no such key),
every charge is the regular price, the payload has no effective
fields, harness46 cannot extract priceHtml, and the rider PATCH nulls
the tab name (200).

Boot pattern mirrors test45 (plain node on :4371, LAN brain on :4372).
"""
import json
import os
import signal
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HERE = Path(__file__).resolve().parent
PORT = 4371
LAN_PORT = 4372
DB = "/tmp/expoline-test46.db"
LAN_DB = "/tmp/expoline-test46-lan.db"
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


def admin_items(tok, base=BASE):
    s, adm = req("GET", "/api/admin/menu", token=tok, base=base)
    if isinstance(adm, list):
        adm = {"categories": adm}
    return {it["name"]: it for c in adm.get("categories", [])
            for it in c.get("items", [])}


def free_table(tok, base=BASE):
    s, zones = req("GET", "/api/zones", token=tok, base=base)
    if isinstance(zones, list):
        zones = {"zones": zones}
    for z in zones.get("zones", []):
        for t in z.get("tables", []):
            if not t.get("open_check_id"):
                return t
    return None


def set_schedule(mtok, windows, base=BASE):
    return req("PUT", "/api/admin/dayparts", {"schedule": windows}, token=mtok, base=base)


def win(name, pricing=None):
    w = {"name": name, "start": "00:00", "end": "00:00",
         "also": ["BAR", "KEIKI", "DESSERTS"]}
    if pricing is not None:
        w["pricing"] = pricing
    return w


def open_table_check(tok, base=BASE):
    t = free_table(tok, base=base)
    s, c = req("POST", "/api/checks", {"table_id": t["id"], "guest_count": 2},
               token=tok, base=base)
    assert s == 201, (s, c)
    return c["id"]


def line_prices(check_body):
    return {it["menu_item_id"]: it["unit_price_cents"]
            for it in check_body.get("items", [])}


def get_check(tok, cid, base=BASE):
    s, c = req("GET", f"/api/checks/{cid}", token=tok, base=base)
    return c


def main():
    for f in (DB, LAN_DB):
        for suffix in ("", "-wal", "-shm"):
            try:
                os.unlink(f + suffix)
            except OSError:
                pass
    seed = subprocess.run(["node", str(ROOT / "db" / "seed.js")],
                          env=dict(os.environ, EXPOLINE_DB=DB),
                          cwd=str(ROOT), capture_output=True, text=True, timeout=120)
    assert seed.returncode == 0, seed.stderr[-400:]
    srv = boot(PORT, DB)
    lan = None
    try:
        tok = login(SERVER_PIN)
        mtok = login(MANAGER_PIN)
        menu = menu_items(tok)
        mai_tai = menu["BH Mai Tai"]
        fries = menu["Bali Fries"]
        assert mai_tai["price_cents"] == 1450, mai_tai
        fries_price = fries["price_cents"]

        print("\n== A: manager sets the HH price; validation ==")
        adm_items = admin_items(mtok)
        mt_admin = adm_items["BH Mai Tai"]
        ok("A1 the admin read model carries hh_price_cents (null before any set)",
           "hh_price_cents" in mt_admin and mt_admin["hh_price_cents"] is None,
           f"{mt_admin.get('hh_price_cents', '<missing>')}")
        s, r = req("PUT", f"/api/admin/menu/items/{mai_tai['id']}",
                   {"hh_price_cents": -1}, token=mtok)
        ok("A2 a negative HH price 400s", s == 400, f"{s} {r}")
        s, r = req("PUT", f"/api/admin/menu/items/{mai_tai['id']}",
                   {"hh_price_cents": 12.5}, token=mtok)
        ok("A3 a fractional HH price 400s", s == 400, f"{s} {r}")
        s, r = req("PUT", f"/api/admin/menu/items/{mai_tai['id']}",
                   {"hh_price_cents": "900"}, token=mtok)
        ok("A4 a string HH price 400s", s == 400, f"{s} {r}")
        s, r = req("PUT", f"/api/admin/menu/items/{mai_tai['id']}",
                   {"hh_price_cents": 900}, token=tok)
        ok("A5 a non-manager cannot set an HH price (403)", s == 403, f"{s}")
        s, r = req("PUT", f"/api/admin/menu/items/{mai_tai['id']}",
                   {"hh_price_cents": 900}, token=mtok)
        ok("A6 the manager sets BH Mai Tai HH 900",
           s == 200 and r.get("hh_price_cents") == 900 and r.get("price_cents") == 1450,
           f"{s} {str(r)[:160]}")
        s, r = req("PUT", f"/api/admin/menu/items/{mai_tai['id']}",
                   {"price_cents": 1450}, token=mtok)
        ok("A7 an unrelated PUT leaves the HH price in place",
           s == 200 and r.get("hh_price_cents") == 900, f"{s} {str(r)[:120]}")
        adm_items = admin_items(mtok)
        ok("A8 the stored HH price reads back in the admin menu",
           adm_items["BH Mai Tai"].get("hh_price_cents") == 900)
        # create path: with HH, without HH, invalid HH
        cat_id = adm_items["BH Mai Tai"]["category_id"]
        s, r = req("POST", "/api/admin/menu/items",
                   {"name": "QA46 HH Special", "price_cents": 1000, "hh_price_cents": 700,
                    "category_id": cat_id, "station": "bar", "course": "drink"},
                   token=mtok)
        ok("A9 create with an HH price stores it",
           s == 201 and r.get("hh_price_cents") == 700, f"{s} {str(r)[:140]}")
        hh_special_id = r.get("id")
        s, r = req("POST", "/api/admin/menu/items",
                   {"name": "QA46 No HH", "price_cents": 1000,
                    "category_id": cat_id, "station": "bar", "course": "drink"},
                   token=mtok)
        ok("A10 create without an HH price leaves it null",
           s == 201 and r.get("hh_price_cents") is None, f"{s} {str(r)[:140]}")
        s, r = req("POST", "/api/admin/menu/items",
                   {"name": "QA46 Bad HH", "price_cents": 1000, "hh_price_cents": -5,
                    "category_id": cat_id, "station": "bar", "course": "drink"},
                   token=mtok)
        ok("A11 create with a negative HH price 400s", s == 400, f"{s} {r}")

        print("\n== B/C: HH window ON (flagged) — payload + every charge path ==")
        s, r = set_schedule(mtok, [win("HAPPY HOUR", pricing=True)])
        ok("B1 the flagged all-day HAPPY HOUR window saves", s == 200, f"{s} {r}")
        s, dp = req("GET", "/api/dayparts", token=tok)
        ok("B2 the current window is the pricing HAPPY HOUR",
           dp.get("current") == "HAPPY HOUR"
           and any(w.get("name") == "HAPPY HOUR" and w.get("pricing") is True
                   for w in dp.get("schedule", [])), f"{str(dp)[:200]}")
        menu = menu_items(tok)
        mt = menu["BH Mai Tai"]
        ok("C1 payload: regular + HH + effective + hh_active during HH",
           mt.get("price_cents") == 1450 and mt.get("hh_price_cents") == 900
           and mt.get("effective_price_cents") == 900 and mt.get("hh_active") is True,
           f"{ {k: mt.get(k) for k in ('price_cents', 'hh_price_cents', 'effective_price_cents', 'hh_active')} }")
        ok("C2 payload: an item with no HH price shows effective = regular, hh_active false",
           menu["Bali Fries"].get("effective_price_cents") == fries_price
           and menu["Bali Fries"].get("hh_active") is False
           and menu["Bali Fries"].get("hh_price_cents") is None,
           f"{menu['Bali Fries']}")

        cid = open_table_check(tok)
        s, c = req("POST", f"/api/checks/{cid}/items",
                   {"menu_item_id": mai_tai["id"], "seat": 1, "qty": 1, "modifiers": []},
                   token=tok)
        got = line_prices(get_check(tok, cid))
        ok("C3 POST /items charges the HH price 900 during HH",
           s == 201 and got.get(mai_tai["id"]) == 900,
           f"{s} {got}")
        s, c = req("POST", f"/api/checks/{cid}/items",
                   {"menu_item_id": fries["id"], "seat": 1, "qty": 1, "modifiers": []},
                   token=tok)
        got = line_prices(get_check(tok, cid))
        ok("C4 an item with no HH price charges regular during HH",
           s == 201 and got.get(fries["id"]) == fries_price,
           f"{s} {got}")

        cid2 = open_table_check(tok)
        s, c = req("POST", f"/api/checks/{cid2}/send-now",
                   {"items": [{"menu_item_id": mai_tai["id"], "seat": 1, "qty": 1,
                               "modifiers": []}]}, token=tok)
        ok("C5 send-now charges the HH price 900 during HH",
           s == 201 and line_prices(c).get(mai_tai["id"]) == 900,
           f"{s} {str(c)[:200]}")

        print("\n== E: snapshot — rung during HH, window flips off, price holds ==")
        cid3 = open_table_check(tok)
        s, c = req("POST", f"/api/checks/{cid3}/items",
                   {"menu_item_id": mai_tai["id"], "seat": 1, "qty": 1, "modifiers": []},
                   token=tok)
        ok("E1 the held line is rung at 900 during HH",
           s == 201 and line_prices(get_check(tok, cid3)).get(mai_tai["id"]) == 900, f"{s}")
        s, r = set_schedule(mtok, [win("ALL DAY")])
        ok("E2 the window flips off (plain all-day window saves)", s == 200, f"{s}")
        s, c = req("POST", f"/api/checks/{cid3}/send", {}, token=tok)
        got = line_prices(get_check(tok, cid3))
        ok("E3 after the flip the fired line still carries 900",
           s in (200, 201) and got.get(mai_tai["id"]) == 900,
           f"{s} {got}")
        s, c = req("GET", f"/api/checks/{cid3}", token=tok)
        total = c.get("total_cents")
        ok("E4 the check subtotal is the HH 900, not 1450",
           c.get("subtotal_cents") == 900, f"{c.get('subtotal_cents')} total={total}")
        s, pay = req("POST", f"/api/checks/{cid3}/payments",
                     {"method": "card_demo", "amount_cents": total, "tip_cents": 0},
                     token=tok)
        ok("E5 card_demo pays the HH-priced total exactly",
           s == 201 and (pay.get("payment") or {}).get("amount_cents") == total,
           f"{s} {str(pay)[:140]}")

        print("\n== D: HH off — regular price everywhere ==")
        menu = menu_items(tok)
        mt = menu["BH Mai Tai"]
        ok("D1 payload off-HH: effective = 1450, hh_active false, HH price still advertised",
           mt.get("effective_price_cents") == 1450 and mt.get("hh_active") is False
           and mt.get("hh_price_cents") == 900, f"{mt}")
        cid4 = open_table_check(tok)
        s, c = req("POST", f"/api/checks/{cid4}/items",
                   {"menu_item_id": mai_tai["id"], "seat": 1, "qty": 1, "modifiers": []},
                   token=tok)
        got = line_prices(get_check(tok, cid4))
        ok("D2 POST /items charges 1450 with HH off",
           s == 201 and got.get(mai_tai["id"]) == 1450,
           f"{s} {got}")

        print("\n== B (cont): the other two bindings ==")
        s, r = set_schedule(mtok, [win("HAPPY HOUR")])  # no pricing key at all
        menu = menu_items(tok)
        ok("B3 an unflagged window NAMED HAPPY HOUR still prices (legacy schedules)",
           s == 200 and menu["BH Mai Tai"].get("effective_price_cents") == 900,
           f"{s} {menu['BH Mai Tai'].get('effective_price_cents')}")
        s, r = set_schedule(mtok, [win("BRUNCH", pricing=True)])
        menu = menu_items(tok)
        ok("B4 a flagged window under any name prices (the flag, not the name)",
           s == 200 and menu["BH Mai Tai"].get("effective_price_cents") == 900,
           f"{s} {menu['BH Mai Tai'].get('effective_price_cents')}")
        s, r = set_schedule(mtok, [win("ALL DAY")])

        print("\n== F: market-price items never take an HH price ==")
        s, r = req("POST", "/api/admin/menu/items",
                   {"name": "QA46 Market Catch", "price_cents": 0, "hh_price_cents": 500,
                    "category_id": cat_id, "station": "expediter", "course": "entree"},
                   token=mtok)
        ok("F1 an MP item can carry an HH price value (stored, inert)",
           s == 201 and r.get("hh_price_cents") == 500, f"{s} {str(r)[:140]}")
        mp_id = r.get("id")
        s, r = set_schedule(mtok, [win("HAPPY HOUR", pricing=True)])
        cid5 = open_table_check(tok)
        s, c = req("POST", f"/api/checks/{cid5}/items",
                   {"menu_item_id": mp_id, "seat": 1, "qty": 1, "modifiers": []},
                   token=tok)
        ok("F2 a server still cannot ring the MP item during HH (403)",
           s == 403, f"{s} {str(c)[:120]}")
        s, c = req("POST", f"/api/checks/{cid5}/items",
                   {"menu_item_id": mp_id, "seat": 1, "qty": 1, "modifiers": [],
                    "unit_price_cents": 2600}, token=mtok)
        got = line_prices(get_check(mtok, cid5))
        ok("F3 the manager-entered price wins during HH (2600, not the HH 500)",
           s == 201 and got.get(mp_id) == 2600,
           f"{s} {got}")
        s, r = set_schedule(mtok, [win("ALL DAY")])

        print("\n== G: rider — a bar tab name cannot be blanked ==")
        s, tab = req("POST", "/api/checks", {"tab_name": "Rider Tab"}, token=tok)
        tab_id = tab["id"]
        ok("G0 the tab opens", s == 201 and tab.get("channel") == "bar_tab", f"{s}")
        for label, val in (("null", None), ("empty string", ""), ("whitespace", "   ")):
            s, r = req("PATCH", f"/api/checks/{tab_id}", {"tab_name": val}, token=tok)
            ok(f"G1 PATCH blanking a tab name ({label}) 400s", s == 400, f"{s} {r}")
        s, chk = req("GET", f"/api/checks/{tab_id}", token=tok)
        ok("G2 the tab kept its name through the blanking attempts",
           chk.get("tab_name") == "Rider Tab", f"{chk.get('tab_name')}")
        s, r = req("PATCH", f"/api/checks/{tab_id}", {"tab_name": "Renamed Tab"}, token=tok)
        ok("G3 renaming a tab to another valid name works",
           s == 200 and r.get("tab_name") == "Renamed Tab", f"{s} {str(r)[:120]}")
        s, r = req("PATCH", f"/api/checks/{tab_id}", {"tab_name": "X" * 41}, token=tok)
        ok("G4 an over-long rename 400s", s == 400, f"{s}")
        t = free_table(tok)
        s, tc = req("POST", "/api/checks",
                    {"table_id": t["id"], "guest_count": 2, "tab_name": "Party Label"},
                    token=tok)
        tc_id = tc["id"]
        s, r = req("PATCH", f"/api/checks/{tc_id}", {"tab_name": None}, token=tok)
        ok("G5 a table check label still clears to null (historic behavior)",
           s == 200 and r.get("tab_name") is None, f"{s} {str(r)[:120]}")
        s, r = req("PATCH", f"/api/checks/{tc_id}", {"tab_name": "Back Again"}, token=tok)
        ok("G6 a table check label still sets", s == 200 and r.get("tab_name") == "Back Again",
           f"{s}")

        print("\n== C (cont): the LAN store charges the HH price ==")
        seed2 = subprocess.run(["node", str(ROOT / "db" / "seed.js")],
                               env=dict(os.environ, EXPOLINE_DB=LAN_DB),
                               cwd=str(ROOT), capture_output=True, text=True, timeout=120)
        ok("L0 LAN db seeded", seed2.returncode == 0, seed2.stderr[-300:] if seed2.returncode else "")
        lan = boot(LAN_PORT, LAN_DB, {
            "EXPOLINE_LAN": "1", "EXPOLINE_BRAIN_PRIORITY": "0",
            "EXPOLINE_DEVICE_ID": "qa46-brain", "EXPOLINE_LAN_PEERS": "127.0.0.1:9",
            "EXPOLINE_LAN_GOSSIP_PIN": SERVER_PIN,
        })
        brain = None
        for _ in range(60):
            s, st = req("GET", "/api/brain/status", base=LAN_BASE)
            if s == 200 and st.get("is_brain") and st.get("brain_device_id") == "qa46-brain":
                brain = st
                break
            time.sleep(0.5)
        ok("L1 sole LAN node elected itself brain", brain is not None)
        ltok = login(SERVER_PIN, base=LAN_BASE)
        lmtok = login(MANAGER_PIN, base=LAN_BASE)
        lmenu = menu_items(ltok, base=LAN_BASE)
        lmt = lmenu["BH Mai Tai"]
        s, r = req("PUT", f"/api/admin/menu/items/{lmt['id']}",
                   {"hh_price_cents": 900}, token=lmtok, base=LAN_BASE)
        ok("L2 the brain admin API sets the HH price", s == 200 and r.get("hh_price_cents") == 900,
           f"{s}")
        s, r = set_schedule(lmtok, [win("HAPPY HOUR", pricing=True)], base=LAN_BASE)
        ok("L3 the brain schedule flips to the pricing window", s == 200, f"{s}")

        lam = [0]

        def env_op(op_id, op, payload):
            lam[0] += 1
            return {"op_id": op_id, "site_slug": "bali-hai", "device_id": "qa46",
                    "seq": lam[0], "lamport": lam[0], "op": op, "payload": payload,
                    "created_at": "2026-10-06T08:20:00.000Z"}

        def batch(ops):
            s, b = req("POST", "/api/sync/batch", {"ops": ops}, token=ltok, base=LAN_BASE)
            return s, {r.get("op_id"): r for r in (b.get("results") or [])}

        s, res = batch([
            env_op("qa46-open", "open_check",
                   {"check_uuid": "tmp-qa46-tab", "table_id": None,
                    "guest_count": 1, "tab_name": "HH Lan Tab"}),
            env_op("qa46-add", "add_items",
                   {"check_uuid": "tmp-qa46-tab", "items": [
                       {"item_uuid": "tmp-qa46-i1", "menu_item_id": lmt["id"],
                        "seat": 1, "qty": 1, "modifiers": []}]}),
        ])
        ok("L4 LAN open + add_items succeed during HH",
           res.get("qa46-open", {}).get("ok") is True
           and res.get("qa46-add", {}).get("ok") is True, f"{str(res)[:200]}")
        rows = q(LAN_DB, "SELECT ci.unit_price_cents FROM check_items ci "
                         "JOIN checks c ON c.id = ci.check_id "
                         "WHERE c.uuid = 'tmp-qa46-tab' AND ci.menu_item_id = ?",
                 (lmt["id"],))
        ok("L5 the LAN line charged the HH price 900",
           rows == [(900,)], f"{rows}")
        s, r = set_schedule(lmtok, [win("ALL DAY")], base=LAN_BASE)
        s, res = batch([
            env_op("qa46-add2", "add_items",
                   {"check_uuid": "tmp-qa46-tab", "items": [
                       {"item_uuid": "tmp-qa46-i2", "menu_item_id": lmt["id"],
                        "seat": 1, "qty": 1, "modifiers": []}]}),
        ])
        rows = q(LAN_DB, "SELECT ci.unit_price_cents FROM check_items ci "
                         "JOIN checks c ON c.id = ci.check_id "
                         "WHERE c.uuid = 'tmp-qa46-tab' AND ci.menu_item_id = ? ORDER BY ci.id",
                 (lmt["id"],))
        ok("L6 after the flip the LAN line charges 1450; the first line still holds 900",
           rows == [(900,), (1450,)], f"{rows}")

        print("\n== H: client wiring (harness46 + static pins) ==")
        h = subprocess.run(["node", str(HERE / "harness46_client.js")],
                           capture_output=True, text=True, timeout=60)
        print(h.stdout)
        if h.stderr:
            print(h.stderr[-500:])
        ok("H1 harness46 (real dispPrice / priceHtml) passes", h.returncode == 0,
           f"rc={h.returncode}")
        app_src = (ROOT / "public" / "app.js").read_text()
        ok("H2 getMenu passes the HH fields through",
           "effective_price_cents: i.effective_price_cents" in app_src
           and "hh_price_cents: i.hh_price_cents" in app_src)
        ok("H3 the menu editor carries an HH price field end to end",
           'id="mi-hhprice"' in app_src and "hh_price_cents: hhRaw === '' ? null" in app_src)
        ok("H4 the daypart editor round-trips the pricing flag",
           'data-dpf="pricing"' in app_src and "pricing: !!w.pricing" in app_src)
        ok("H5 the order grid renders through priceHtml",
           "priceHtml(i)" in app_src and "priceHtml(p.item)" in app_src)

        # cleanup: restore HH price state + default schedule
        req("PUT", f"/api/admin/menu/items/{mai_tai['id']}",
            {"hh_price_cents": None}, token=mtok)
        set_schedule(mtok, [
            {"name": "LUNCH", "start": "11:00", "end": "16:00", "also": ["BAR", "KEIKI", "DESSERTS"]},
            {"name": "HAPPY HOUR", "start": "16:00", "end": "18:00", "also": ["BAR"], "pricing": True},
            {"name": "DINNER", "start": "18:00", "end": "22:00", "also": ["BAR", "DESSERTS"]},
        ])
    finally:
        stop(lan)
        stop(srv)

    print(f"\n==== test46_happy_hour: {passed} passed, {failed} failed ====")
    if failures:
        print("FAILURES:", failures)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
