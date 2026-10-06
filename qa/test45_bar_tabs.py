#!/usr/bin/env python3
"""test45_bar_tabs.py — bar tabs: named, table-less checks (channel
'bar_tab'), the audit's #1 gap. What is pinned here:

  A  Create rules: no table + no name keeps the historic 400; a blank
     or over-long name 400s; a valid name opens a tab (table_id NULL,
     channel 'bar_tab', guest_count defaults to 1); a name never
     rescues a bogus table_id; table checks keep the old rules
     (tab_name stays an optional label there).
  B  Lifecycle + money parity: identical items on a tab and a table
     check produce identical totals; /send and /send-now fire KDS
     tickets labeled 'TAB · <name>' with channel 'bar_tab'.
  C  Discovery: /api/checks/open lists the tab (channel, owner, item
     count, total); zones never show a tab as a table occupant; the
     manager overview open-check count moves with tabs.
  D  Duplicate names: never merged — a second same-name tab for the
     same server is a distinct check and the 201 names the existing
     one(s) (existing_tabs); another server gets no advisory.
  E  Money bucketing: paying a tab (card_demo + tip) and closing it
     moves the tip-out report by exactly the tab's tip and gross;
     the payment row is a normal row; the tab drops off the open
     list; once all same-name tabs are gone the name is free again.
  F  Split children of a tab stay tabs (channel copied, table NULL);
     a tab cannot be moved to a table (400, clear message).
  I  Stale radar: an aged tab appears in stale_open_checks carrying
     tab_name + channel; a fresh tab does not.
  H  LAN batch: open_check with table_id null + tab_name creates the
     tab on the brain (replay-safe); nameless -> tab_name_required;
     bogus table -> invalid_table; add_items + send fire a ticket
     labeled 'TAB · <name>'; payment + close complete the tab.
  G  Client wiring: harness45 drives the real locLabel / lanEnvelope /
     flushOutboxLegacy (the offline open posts {table_id: null,
     guest_count, tab_name}); static asserts pin the floor New Tab
     button, the open-tabs strip filter, and the header label use.

Discriminating control: at a751285 a tab cannot be created at all
(POST without table_id -> 400 'Valid table_id is required'; the LAN
open_check -> invalid_table), so sections A/B/D/E/F/H fail there and
harness45 cannot extract locLabel.

Boot pattern mirrors test44 (plain node on :4361, LAN brain on :4362).
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
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
HERE = Path(__file__).resolve().parent
PORT = 4361
LAN_PORT = 4362
DB = "/tmp/expoline-test45.db"
LAN_DB = "/tmp/expoline-test45-lan.db"
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


def free_table(tok, base=BASE):
    s, zones = req("GET", "/api/zones", token=tok, base=base)
    if isinstance(zones, list):
        zones = {"zones": zones}
    for z in zones.get("zones", []):
        for t in z.get("tables", []):
            if not t.get("open_check_id"):
                return t
    return None


def salt_mod(eda):
    for g in eda.get("modifier_groups") or []:
        for o in g.get("options", []):
            if o["name"] == "Sea Salt":
                return {"name": o["name"], "option_id": o["id"],
                        "price_delta_cents": o.get("price_delta_cents", 0)}
    return None


def tickets_for(ktok, check_id, base=BASE):
    s, t = req("GET", "/api/kds/tickets", token=ktok, base=base)
    rows = t if isinstance(t, list) else t.get("tickets", [])
    return [x for x in rows if x.get("check_id") == check_id]


def tipout_row(mtok, date):
    s, b = req("GET", f"/api/tipout/report?date={date}", token=mtok)
    for r in b.get("servers", []):
        if r.get("server_name") == "Daniel S":
            return r
    return None


def main():
    for f in (DB, LAN_DB):
        try:
            os.remove(f)
        except OSError:
            pass
    srv = boot(PORT, DB, {"NODE_ENV": "test"})
    lan = None
    try:
        tok = login(SERVER_PIN)
        ktok = login(KITCHEN_PIN)
        mtok = login(MANAGER_PIN)
        menu = menu_items(tok)
        eda, fries = menu["Edamame"], menu["Bali Fries"]
        salt = salt_mod(eda)
        today = datetime.now(ZoneInfo("America/Los_Angeles")).strftime("%Y-%m-%d")

        print("\n== A: create rules ==")
        s, b = req("POST", "/api/checks", {"guest_count": 1}, token=tok)
        ok("A1 no table + no name keeps the historic 400",
           s == 400 and b.get("error") == "Valid table_id is required", f"{s} {b}")
        s, b = req("POST", "/api/checks", {"tab_name": "   "}, token=tok)
        ok("A2 blank tab name 400s", s == 400 and "tab_name" in (b.get("error") or ""), f"{s} {b}")
        s, b = req("POST", "/api/checks", {"tab_name": "X" * 41}, token=tok)
        ok("A3 over-long tab name 400s", s == 400 and "40" in (b.get("error") or ""), f"{s} {b}")
        s, b = req("POST", "/api/checks", {"tab_name": "Silva", "guest_count": 0}, token=tok)
        ok("A4 bad guest_count 400s", s == 400 and "guest_count" in (b.get("error") or ""), f"{s} {b}")
        s, tab = req("POST", "/api/checks", {"tab_name": "Silva"}, token=tok)
        ok("A5 a named request opens a tab",
           s == 201 and tab.get("channel") == "bar_tab" and tab.get("table_id") is None
           and tab.get("tab_name") == "Silva" and tab.get("status") == "open",
           f"{s} {str(tab)[:200]}")
        ok("A5b tab guest_count defaults to 1", tab.get("guest_count") == 1, f"{tab.get('guest_count')}")
        tab_id = tab["id"]
        tbl = free_table(tok)
        s, tcheck = req("POST", "/api/checks",
                        {"table_id": tbl["id"], "guest_count": 2, "tab_name": "Party label"}, token=tok)
        ok("A6 table rules unchanged (label stays a label)",
           s == 201 and (tcheck.get("channel") or "dine_in") == "dine_in"
           and tcheck.get("table_label") == tbl["label"] and tcheck.get("tab_name") == "Party label",
           f"{s} {str(tcheck)[:200]}")
        table_check_id = tcheck["id"]
        s, b = req("POST", "/api/checks", {"table_id": 999999, "tab_name": "Silva"}, token=tok)
        ok("A7 a name never rescues a bogus table_id",
           s == 400 and b.get("error") == "Valid table_id is required", f"{s} {b}")
        s, got = req("GET", f"/api/checks/{tab_id}", token=tok)
        ok("A8 the tab reads back as a tab",
           s == 200 and got.get("channel") == "bar_tab" and got.get("table_label") is None,
           f"{s} {str(got)[:160]}")

        print("\n== B: lifecycle + money parity + ticket labels ==")
        for cid in (tab_id, table_check_id):
            req("POST", f"/api/checks/{cid}/items",
                {"menu_item_id": eda["id"], "seat": 1, "qty": 1, "modifiers": [salt]}, token=tok)
            req("POST", f"/api/checks/{cid}/items",
                {"menu_item_id": fries["id"], "seat": 1, "qty": 2, "modifiers": []}, token=tok)
        s, tv = req("GET", f"/api/checks/{tab_id}", token=tok)
        s, cv = req("GET", f"/api/checks/{table_check_id}", token=tok)
        ok("B1 held items land on the tab",
           len(tv.get("items", [])) == 2 and all(i["state"] == "held" for i in tv["items"]),
           f"{str(tv.get('items'))[:160]}")
        tkeys = ("subtotal_cents", "surcharge_cents", "service_charge_cents", "tax_cents", "total_cents")
        ok("B2 tab totals identical to the table check, field by field",
           all(tv.get(k) == cv.get(k) for k in tkeys),
           f"tab={ {k: tv.get(k) for k in tkeys} } table={ {k: cv.get(k) for k in tkeys} }")
        tab_total = tv["total_cents"]
        tab_gross = tv["gross_subtotal_cents"]
        s, b = req("POST", f"/api/checks/{tab_id}/send", {}, token=tok)
        ok("B3 /send fires the tab", s == 200, f"{s} {str(b)[:120]}")
        tt = tickets_for(ktok, tab_id)
        ok("B4 the KDS ticket is labeled TAB · Silva with channel bar_tab",
           len(tt) >= 1 and all(t.get("table_label") == "TAB · Silva" for t in tt)
           and all(t.get("channel") == "bar_tab" for t in tt),
           f"{[(t.get('table_label'), t.get('channel')) for t in tt]}")
        s, tab2 = req("POST", "/api/checks", {"tab_name": "SendNow Tab"}, token=tok)
        tab2_id = tab2["id"]
        s, sn = req("POST", f"/api/checks/{tab2_id}/send-now",
                    {"items": [{"menu_item_id": fries["id"], "seat": 1, "qty": 1, "modifiers": []}]}, token=tok)
        ok("B5 send-now works on a tab", s in (200, 201), f"{s} {str(sn)[:120]}")
        tt2 = tickets_for(ktok, tab2_id)
        ok("B6 the send-now ticket is labeled TAB · SendNow Tab",
           len(tt2) >= 1 and all(t.get("table_label") == "TAB · SendNow Tab" for t in tt2),
           f"{[(t.get('table_label')) for t in tt2]}")

        print("\n== C: discovery — open list, zones, overview ==")
        s, rows = req("GET", "/api/checks/open", token=tok)
        row = next((c for c in rows if c["id"] == tab_id), None)
        ok("C1 the open list carries the tab with owner, items, total",
           row is not None and row.get("channel") == "bar_tab"
           and row.get("server_name") == "Daniel S" and row.get("item_count") == 2
           and row.get("total_cents") == tab_total,
           f"{str(row)[:200]}")
        s, zones = req("GET", "/api/zones", token=tok)
        if isinstance(zones, list):
            zones = {"zones": zones}
        occupants = [t.get("open_check_id") for z in zones.get("zones", []) for t in z.get("tables", [])]
        ok("C2 no table is occupied by a tab",
           tab_id not in occupants and tab2_id not in occupants, f"{occupants[:8]}")
        ok("C3 the parity table shows its own check",
           table_check_id in occupants, f"{occupants[:8]}")
        s, ov = req("GET", "/api/manager/overview", token=mtok)
        open_n = ov["today"]["open_checks"]
        s, ctab = req("POST", "/api/checks", {"tab_name": "Count Tab"}, token=tok)
        s, ov2 = req("GET", "/api/manager/overview", token=mtok)
        ok("C4 overview open_checks counts a new tab",
           ov2["today"]["open_checks"] == open_n + 1,
           f"{open_n} -> {ov2['today']['open_checks']}")
        s, b = req("POST", f"/api/checks/{ctab['id']}/void",
                   {"manager_pin": MANAGER_PIN, "reason": "qa"}, token=mtok)
        ok("C5a the tab voids with a fresh manager PIN", s == 200, f"{s} {str(b)[:120]}")
        s, ov3 = req("GET", "/api/manager/overview", token=mtok)
        ok("C5 voiding the tab returns the count",
           ov3["today"]["open_checks"] == open_n, f"{ov3['today']['open_checks']}")

        print("\n== D: duplicate names — never merged ==")
        s, ta = req("POST", "/api/checks", {"tab_name": "Marta"}, token=tok)
        ok("D1 the first Marta carries no advisory",
           s == 201 and "existing_tabs" not in ta, f"{s} {str(ta)[:160]}")
        req("POST", f"/api/checks/{ta['id']}/items",
            {"menu_item_id": fries["id"], "seat": 1, "qty": 1, "modifiers": []}, token=tok)
        s, ta_view = req("GET", f"/api/checks/{ta['id']}", token=tok)
        s, tb = req("POST", "/api/checks", {"tab_name": "MARTA"}, token=tok)
        ex = tb.get("existing_tabs") or []
        ok("D2 a second same-name tab is distinct and names the first",
           s == 201 and tb["id"] != ta["id"] and len(ex) == 1 and ex[0]["id"] == ta["id"]
           and ex[0]["total_cents"] == ta_view["total_cents"],
           f"{s} id={tb.get('id')} ex={ex}")
        s, tb_view = req("GET", f"/api/checks/{tb['id']}", token=tok)
        ok("D3 the second tab starts empty (nothing merged)",
           len(tb_view.get("items", [])) == 0, f"{len(tb_view.get('items', []))} items")
        s, tm = req("POST", "/api/checks", {"tab_name": "Marta"}, token=mtok)
        ok("D4 another server gets no advisory (per-server rule)",
           s == 201 and "existing_tabs" not in tm, f"{s} {str(tm)[:160]}")

        print("\n== E: money bucketing — tip-out delta, close, name freed ==")
        before = tipout_row(mtok, today) or {"tips_cents": 0, "gross_sales_cents": 0}
        s, pay = req("POST", f"/api/checks/{tab_id}/payments",
                     {"method": "card_demo", "amount_cents": tab_total, "tip_cents": 500}, token=tok)
        ok("E1 card_demo pays the tab", s == 201, f"{s} {str(pay)[:140]}")
        s, b = req("POST", f"/api/checks/{tab_id}/close", {}, token=tok)
        ok("E2 the tab closes", s == 200, f"{s} {str(b)[:120]}")
        s, closed = req("GET", f"/api/checks/{tab_id}", token=tok)
        ok("E3 the closed tab reads closed", closed.get("status") == "closed", f"{closed.get('status')}")
        after = tipout_row(mtok, today) or {"tips_cents": 0, "gross_sales_cents": 0}
        ok("E4 tip-out moves by exactly the tab tip and gross",
           after["tips_cents"] - before["tips_cents"] == 500
           and after["gross_sales_cents"] - before["gross_sales_cents"] == tab_gross,
           f"tips {before['tips_cents']}->{after['tips_cents']} gross {before['gross_sales_cents']}->{after['gross_sales_cents']} want +500/+{tab_gross}")
        prow = q(DB, "SELECT method, tip_cents FROM payments WHERE check_id = ?", (tab_id,))
        ok("E5 the payment is a normal payment row",
           prow == [("card_demo", 500)], f"{prow}")
        s, rows = req("GET", "/api/checks/open", token=tok)
        ok("E6 the paid tab drops off the open list",
           all(c["id"] != tab_id for c in rows), "")
        void_results = []
        for cid in (ta["id"], tb["id"], tm["id"]):
            vs, vb = req("POST", f"/api/checks/{cid}/void",
                         {"manager_pin": MANAGER_PIN, "reason": "qa"}, token=mtok)
            void_results.append(vs)
        ok("E6b every Marta tab voids", all(v == 200 for v in void_results), f"{void_results}")
        s, tf = req("POST", "/api/checks", {"tab_name": "Marta"}, token=tok)
        ok("E7 once every Marta is gone the name is free (no advisory)",
           s == 201 and "existing_tabs" not in tf, f"{s} {str(tf)[:140]}")
        req("POST", f"/api/checks/{tf['id']}/void",
            {"manager_pin": MANAGER_PIN, "reason": "qa"}, token=mtok)

        print("\n== F: split stays a tab; move is refused ==")
        s, stab = req("POST", "/api/checks", {"tab_name": "Split Tab"}, token=tok)
        sid = stab["id"]
        req("POST", f"/api/checks/{sid}/items",
            {"menu_item_id": fries["id"], "seat": 1, "qty": 1, "modifiers": []}, token=tok)
        req("POST", f"/api/checks/{sid}/items",
            {"menu_item_id": eda["id"], "seat": 1, "qty": 1, "modifiers": [salt]}, token=tok)
        s, sp = req("POST", f"/api/checks/{sid}/split", {"mode": "even", "parts": 2}, token=tok)
        child_ids = sp.get("checks") or []
        ok("F1 the tab splits", s == 200 and len(child_ids) == 2, f"{s} {str(sp)[:160]}")
        child_views = []
        for cid in child_ids:
            s2, v = req("GET", f"/api/checks/{cid}", token=tok)
            child_views.append(v)
        ok("F2 split children stay tabs (channel copied, no table)",
           all(v.get("channel") == "bar_tab" and v.get("table_id") is None for v in child_views),
           f"{[(v.get('channel'), v.get('table_id')) for v in child_views]}")
        dest = free_table(tok)
        s, b = req("POST", f"/api/checks/{tab2_id}/move", {"table_id": dest["id"]}, token=tok)
        ok("F3 a tab cannot be moved to a table",
           s == 400 and "bar tab" in (b.get("error") or ""), f"{s} {b}")

        print("\n== I: stale radar identifies tabs ==")
        s, stale_tab = req("POST", "/api/checks", {"tab_name": "Stale Tab"}, token=tok)
        stale_id = stale_tab["id"]
        req("POST", f"/api/checks/{stale_id}/items",
            {"menu_item_id": fries["id"], "seat": 1, "qty": 1, "modifiers": []}, token=tok)
        s, fresh_tab = req("POST", "/api/checks", {"tab_name": "Fresh Tab"}, token=tok)
        fresh_id = fresh_tab["id"]
        stop(srv)
        srv = None
        old = (datetime.now(timezone.utc) - timedelta(hours=30)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
        con = sqlite3.connect(DB)
        con.execute("UPDATE checks SET opened_at = ? WHERE id = ?", (old, stale_id))
        con.execute("UPDATE check_items SET added_at = ? WHERE check_id = ?", (old, stale_id))
        con.commit()
        con.close()
        srv = boot(PORT, DB, {"NODE_ENV": "test"})
        mtok2 = login(MANAGER_PIN)
        s, ov = req("GET", "/api/manager/overview", token=mtok2)
        stale_rows = (ov.get("stale_open_checks") or {}).get("checks") or []
        srow = next((c for c in stale_rows if c.get("check_id") == stale_id), None)
        ok("I1 the aged tab is reported stale WITH its tab identity",
           srow is not None and srow.get("tab_name") == "Stale Tab"
           and srow.get("channel") == "bar_tab",
           f"{str(srow)[:180]}")
        ok("I2 the fresh tab is not stale",
           all(c.get("check_id") != fresh_id for c in stale_rows), "")

        print("\n== H: LAN batch — tab open, fire, pay, close ==")
        seed_env = dict(os.environ, EXPOLINE_DB=LAN_DB)
        seed = subprocess.run(["node", str(ROOT / "db" / "seed.js")], env=seed_env,
                              cwd=str(ROOT), capture_output=True, text=True, timeout=120)
        ok("H0 LAN db seeded", seed.returncode == 0, seed.stderr[-300:] if seed.returncode else "")
        lan = boot(LAN_PORT, LAN_DB, {
            "EXPOLINE_LAN": "1", "EXPOLINE_BRAIN_PRIORITY": "0",
            "EXPOLINE_DEVICE_ID": "qa45-brain", "EXPOLINE_LAN_PEERS": "127.0.0.1:9",
            "EXPOLINE_LAN_GOSSIP_PIN": SERVER_PIN,
        })
        brain = None
        for _ in range(60):
            s, st = req("GET", "/api/brain/status", base=LAN_BASE)
            if s == 200 and st.get("is_brain") and st.get("brain_device_id") == "qa45-brain":
                brain = st
                break
            time.sleep(0.5)
        ok("H1 sole LAN node elected itself brain", brain is not None)
        ltok = login(SERVER_PIN, base=LAN_BASE)
        lktok = login(KITCHEN_PIN, base=LAN_BASE)
        lmenu = menu_items(ltok, base=LAN_BASE)
        lfries = lmenu["Bali Fries"]

        lam = [0]

        def env_op(op_id, op, payload):
            lam[0] += 1
            return {"op_id": op_id, "site_slug": "bali-hai", "device_id": "qa45",
                    "seq": lam[0], "lamport": lam[0], "op": op, "payload": payload,
                    "created_at": "2026-10-06T07:50:00.000Z"}

        def batch(ops):
            s, b = req("POST", "/api/sync/batch", {"ops": ops}, token=ltok, base=LAN_BASE)
            return s, {r.get("op_id"): r for r in (b.get("results") or [])}

        open_op = env_op("qa45-tab-open", "open_check",
                         {"check_uuid": "tmp-qa45-tab1", "table_id": None,
                          "guest_count": 1, "tab_name": "Lan Tab"})
        s, res = batch([open_op])
        ok("H2 the LAN open_check accepts a table-less tab",
           res.get("qa45-tab-open", {}).get("ok") is True, f"{str(res)[:200]}")
        ltab_id = res.get("qa45-tab-open", {}).get("check_id")
        rows = q(LAN_DB, "SELECT channel, table_id, tab_name FROM checks WHERE uuid = 'tmp-qa45-tab1'")
        ok("H3 the synced row is a tab (channel, NULL table, name)",
           rows == [("bar_tab", None, "Lan Tab")], f"{rows}")
        s, res = batch([open_op])
        n = q(LAN_DB, "SELECT COUNT(*) FROM checks WHERE uuid = 'tmp-qa45-tab1'")[0][0]
        ok("H4 replaying the open op creates no second tab",
           res.get("qa45-tab-open", {}).get("ok") is True and n == 1, f"n={n} {str(res)[:120]}")
        s, res = batch([env_op("qa45-noname", "open_check",
                               {"check_uuid": "tmp-qa45-noname", "table_id": None, "guest_count": 1})])
        ok("H5 a nameless table-less open is refused",
           res.get("qa45-noname", {}).get("ok") is False
           and res.get("qa45-noname", {}).get("error") == "tab_name_required",
           f"{str(res)[:160]}")
        s, res = batch([env_op("qa45-badtable", "open_check",
                               {"check_uuid": "tmp-qa45-bad", "table_id": 999999, "guest_count": 1})])
        ok("H6 a bogus table still returns invalid_table",
           res.get("qa45-badtable", {}).get("ok") is False
           and res.get("qa45-badtable", {}).get("error") == "invalid_table",
           f"{str(res)[:160]}")
        s, res = batch([
            env_op("qa45-add", "add_items",
                   {"check_uuid": "tmp-qa45-tab1", "items": [
                       {"item_uuid": "tmp-qa45-i1", "menu_item_id": lfries["id"],
                        "seat": 1, "qty": 1, "modifiers": []}]}),
            env_op("qa45-send", "send", {"check_uuid": "tmp-qa45-tab1"}),
        ])
        ok("H7 add_items + send succeed on the LAN tab",
           res.get("qa45-add", {}).get("ok") is True and res.get("qa45-send", {}).get("ok") is True,
           f"{str(res)[:200]}")
        lt = tickets_for(lktok, ltab_id, base=LAN_BASE)
        ok("H8 the LAN-fired ticket is labeled TAB · Lan Tab",
           len(lt) >= 1 and all(t.get("table_label") == "TAB · Lan Tab" for t in lt)
           and all(t.get("channel") == "bar_tab" for t in lt),
           f"{[(t.get('table_label'), t.get('channel')) for t in lt]}")
        s, rows = req("GET", "/api/checks/open", token=ltok, base=LAN_BASE)
        lrow = next((c for c in rows if c["id"] == ltab_id), None)
        ok("H9 the LAN open list carries the tab",
           lrow is not None and lrow.get("channel") == "bar_tab", f"{str(lrow)[:140]}")
        s, lview = req("GET", f"/api/checks/{ltab_id}", token=ltok, base=LAN_BASE)
        ltotal = lview["totals"]["total"]
        s, res = batch([
            env_op("qa45-pay", "payment",
                   {"check_uuid": "tmp-qa45-tab1", "payment_uuid": "pay-qa45-1",
                    "method": "card_demo", "amount_cents": ltotal, "tip_cents": 300}),
            env_op("qa45-close", "close", {"check_uuid": "tmp-qa45-tab1"}),
        ])
        ok("H10 payment + close complete the LAN tab",
           res.get("qa45-pay", {}).get("ok") is True and res.get("qa45-close", {}).get("ok") is True,
           f"{str(res)[:200]}")
        st = q(LAN_DB, "SELECT status FROM checks WHERE uuid = 'tmp-qa45-tab1'")
        ok("H11 the LAN tab row is closed", st == [("closed",)], f"{st}")

        print("\n== G: client wiring (harness45 + static) ==")
        h = subprocess.run(["node", str(HERE / "harness45_client.js")],
                           capture_output=True, text=True, timeout=120)
        print(h.stdout[-2500:])
        if h.returncode != 0:
            print(h.stderr[-800:])
        ok("G1 harness45 (locLabel / lanEnvelope / legacy flush open)",
           h.returncode == 0 and "ALL HARNESS CHECKS PASS" in h.stdout,
           f"rc={h.returncode}")
        app_js = (ROOT / "public" / "app.js").read_text()
        css = (ROOT / "public" / "styles.css").read_text()
        ok("G2 the floor carries the New Tab button and the tabs slot",
           'id="floor-newtab"' in app_js and 'id="open-tabs-slot"' in app_js, "")
        ok("G3 the strip filters on the bar_tab channel",
           "c.channel === 'bar_tab'" in app_js, "")
        ok("G4 the tab sheet posts the tab form and queues table_id null",
           "{ tab_name: name, guest_count: 1 }" in app_js
           and "table_id: null, guest_count: 1, tab_name: name" in app_js
           and "channel: 'bar_tab'" in app_js, "")
        ok("G5 headers and receipt use the shared location label",
           app_js.count("locLabel(check)") >= 3, f"n={app_js.count('locLabel(check)')}")
        ok("G6 the tab chip has styles", ".tab-chip" in css and ".open-tabs" in css, "")
    finally:
        stop(srv)
        stop(lan)

    print(f"\n{'ALL GREEN' if failed == 0 else 'FAILURES: ' + ', '.join(failures)} — {passed} passed, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
