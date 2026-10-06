#!/usr/bin/env python3
"""test52_shift_review.py — shift review + cash-tip declaration (audit gap #6).

Toast/SpotOn end a server shift with a review and a DECLARATION of the
cash tips received — the attested figure of record for cash tips, most
of which never pass through a payment record. Expoline had the clock
and per-server reporting but no review surface and no declaration.
This batch adds both, plus a rider from EOD QA.

  - POST /api/finance/tip-declarations: one declaration per (server,
    business date) in tip_declarations. Own declaration is self-service
    (the session is the attestation); amending ANOTHER server's takes a
    manager role + a FRESH manager PIN (403 need_manager_pin without),
    and every write is approval-audited with before/after. Declaring 0
    is a real attestation, distinct from never declaring.
  - GET /api/finance/shift-review?date=&server_id=: one server + one
    business date, composed ENTIRELY from the existing builders — sales
    from the finance/shift aggregation, recorded tips from the tips
    report builder, tip-out from the tipoutReport() computation the
    /api/tipout/report route serves, labor from clockCompute. Scope is
    server+date, NOT a clock window: every per-server money figure in
    the codebase is date-bucketed; a clock-window review would invent
    a bucketing that disagrees with every report a manager reads. Two
    clock shifts in one day review together (and are listed).
  - COMPOSITION (the double-count trap): cash of record = the declared
    figure when a declaration exists, else the recorded cash tips;
    total = card tips + cash of record. Recorded cash tips ride as a
    memo and are NEVER added to a declaration.
  - Tips report gains a declared_cash_tips_cents column (rows + totals)
    sourced from the declarations table; the recorded columns do not
    move. The Z snapshot tips section is the builder output, so a
    declaration filed BEFORE a close is inside the snapshot, and one
    filed AFTER never rewrites it.
  - EOD INTERPLAY — declarations are EXEMPT from the day freeze: they
    write only the declarations table and cannot move any money
    figure; the frozen snapshot is stored JSON, never recomputed.
    Freezing them would strand the common declare-after-Z case behind
    a full day-reopen that unfreezes ALL money.
  - RIDER: in POST /api/checks/:id/payments the EOD freeze now runs
    AFTER the idempotency replay (matching refund + the LAN payment
    op): a retry of an already-applied payment on a closed-out day
    returns the stored replay response; a NEW payment still 409s.

FIXTURES (built via the API on the wall-clock day, then moved to
fixture dates by direct SQL — dates are controlled by the DATA).
D1 = 2026-09-16, D2 = 2026-09-17. Site tz America/Los_Angeles.

  A (server1 Daniel S) — Broccoli x2: subtotal 2000, surcharge 100,
      tax round(2100 x .0775) = 163, total 2263. Cash 1000 (tip 300,
      tendered 1300) + card 1263 (tip 200). Closed; opened/closed/
      payments moved to D1 noon PDT.
      finance/shift D1: checks 1, subtotal 2000, cash sales 1000,
        brands {Visa: 1263}, tips 500, card tips owed 200.
      tips report D1: cash 300, card 200, total 500.
      tip-out (rule: busser 10% of tips): tips 500, owed 50, net 450.
  B (server1) — Broccoli x1, left OPEN (open_checks fixture).
  Clock — server1 clocks in/out on the wall clock, then the shift is
      moved to D1 10:00-18:00 PDT (8.0 h) for the labor figure.
  Server2 (Sam Server, pin 3333) is inserted by SQL — the seed ships a
      single server, and the own-only rule needs a second one.

Hand composition checks: declare 475 -> total = 200 + 475 = 675
(never 200 + 300 + 475 = 975); amend to 500 -> 700; manager amend to
550 -> 750; declare on the CLOSED day 600 -> 800 while the frozen Z
snapshot keeps its pre-declaration 500 declared total.

Discriminating control at cf3d0b6 (verified separately): both new
endpoints 404, the tips report has no declared column, the harness
cannot extract its helpers, and the rider retry on a closed day 409s
instead of replaying.

Boot pattern mirrors test51 (plain node, own port + DB file).
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
from datetime import date as date_cls, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HERE = Path(__file__).resolve().parent
PORT = 4387
DB = "/tmp/expoline-test52.db"
BASE = f"http://127.0.0.1:{PORT}"
SERVER_PIN = "1111"
SERVER2_PIN = "3333"
MANAGER_PIN = "2580"
KITCHEN_PIN = "2222"

D1 = "2026-09-16"
D2 = "2026-09-17"
D1_INSTANT = "2026-09-16T19:00:00.000Z"     # 12:00 PDT on D1

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


def req(method, path, body=None, token=None, base=BASE, headers=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(base + path, data=data, method=method)
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


def boot(port, db):
    env = dict(os.environ, EXPOLINE_PORT=str(port), EXPOLINE_DB=db)
    p = subprocess.Popen(["node", str(ROOT / "server.js")], env=env,
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


def login(pin):
    s, r = req("POST", "/api/auth/login", {"pin": pin})
    assert s == 200, (s, r)
    return r.get("token")


def menu_items(tok):
    s, menu = req("GET", "/api/menu?all=1", token=tok)
    if isinstance(menu, list):
        menu = {"categories": menu}
    return {it["name"]: it for c in menu.get("categories", []) for it in c.get("items", [])}


def free_table(tok):
    s, zones = req("GET", "/api/zones", token=tok)
    if isinstance(zones, list):
        zones = {"zones": zones}
    for z in zones.get("zones", []):
        for t in z.get("tables", []):
            if not t.get("open_check_id"):
                return t
    return None


def build_check(tok, lines, guests=2):
    t = free_table(tok)
    s, c = req("POST", "/api/checks", {"table_id": t["id"], "guest_count": guests}, token=tok)
    assert s == 201, (s, c)
    cid = c["id"]
    for item_id, qty in lines:
        s, r = req("POST", f"/api/checks/{cid}/items",
                   {"menu_item_id": item_id, "seat": 1, "qty": qty, "modifiers": []}, token=tok)
        assert s == 201, (s, r)
    return cid


def get_check(tok, cid):
    s, c = req("GET", f"/api/checks/{cid}", token=tok)
    assert s == 200, (s, c)
    return c


def pay(tok, cid, method, amount, tip=0, tendered=None, headers=None):
    body = {"method": method, "amount_cents": amount, "tip_cents": tip}
    if method == "card_demo":
        body.update({"brand": "Visa", "last4": "4242"})
    if tendered is not None:
        body["tendered_cents"] = tendered
    s, r = req("POST", f"/api/checks/{cid}/payments", body, token=tok, headers=headers)
    assert s == 201, (s, r)
    return r["payment"]["id"]


def close_check(tok, cid):
    s, r = req("POST", f"/api/checks/{cid}/close", {}, token=tok)
    assert s == 200, (s, r)


def report(tok, kind, day):
    s, r = req("GET", f"/api/finance/reports/{kind}?format=json&from={day}&to={day}", token=tok)
    assert s == 200, (kind, s, r)
    return r


def review(tok, day, server_id=None):
    q = f"/api/finance/shift-review?date={day}"
    if server_id is not None:
        q += f"&server_id={server_id}"
    return req("GET", q, token=tok)


def declare(tok, cents, day=None, server_id=None, pin=None):
    body = {"declared_cash_tips_cents": cents}
    if day is not None:
        body["date"] = day
    if server_id is not None:
        body["server_id"] = server_id
    if pin is not None:
        body["manager_pin"] = pin
    return req("POST", "/api/finance/tip-declarations", body, token=tok)


def audit_rows(mtok):
    s, r = req("GET", "/api/admin/approvals/audit?limit=400", token=mtok)
    assert s == 200, (s, r)
    return r if isinstance(r, list) else r.get("audit", r.get("rows", []))


def sql(*stmts):
    con = sqlite3.connect(DB, timeout=30)
    try:
        for q, args in stmts:
            con.execute(q, args)
        con.commit()
    finally:
        con.close()


def main():
    if os.path.exists(DB):
        os.remove(DB)
    srv = boot(PORT, DB)
    try:
        stok = login(SERVER_PIN)
        mtok = login(MANAGER_PIN)
        ktok = login(KITCHEN_PIN)
        menu = menu_items(stok)
        BRO = menu["Black Bean Chinese Broccoli"]["id"]

        # A second server (the seed ships one) for the own-only rule.
        con = sqlite3.connect(DB, timeout=30)
        site_id = con.execute("SELECT site_id FROM users WHERE pin = ?", (SERVER_PIN,)).fetchone()[0]
        con.execute("INSERT INTO users (site_id, name, role, pin) VALUES (?, 'Sam Server', 'server', ?)",
                    (site_id, SERVER2_PIN))
        con.commit()
        con.close()
        stok2 = login(SERVER2_PIN)
        s, users = req("GET", "/api/admin/clock/users", token=mtok)
        uid = {u["name"]: u["id"] for u in users}
        S1, S2 = uid["Daniel S"], uid["Sam Server"]

        print("== fixtures: check A paid + closed, check B open, one clock shift ==")
        a = build_check(stok, [(BRO, 2)])
        a_cash = pay(stok, a, "cash", 1000, tip=300, tendered=1300)
        a_card = pay(stok, a, "card_demo", 1263, tip=200)
        close_check(stok, a)
        b = build_check(stok, [(BRO, 1)])
        s, r = req("POST", "/api/clock/in", {}, token=stok)
        assert s == 201, (s, r)
        shift_id = r["id"]
        s, r = req("POST", "/api/clock/out", {}, token=stok)
        assert s == 200, (s, r)
        sql(
            ("UPDATE checks SET opened_at = ?, closed_at = ? WHERE id = ?", (D1_INSTANT, D1_INSTANT, a)),
            ("UPDATE payments SET created_at = ? WHERE id IN (?, ?)", (D1_INSTANT, a_cash, a_card)),
            ("UPDATE clock_shifts SET clock_in = ?, clock_out = ? WHERE id = ?",
             ("2026-09-16T17:00:00.000Z", "2026-09-17T01:00:00.000Z", shift_id)),
        )
        s, r = req("POST", "/api/tipout/rules",
                   {"name": "Busser", "role": "busser", "basis": "tips", "pct_bps": 1000}, token=mtok)
        assert s == 201, (s, r)
        s, payouts = req("GET", "/api/finance/payouts", token=mtok)
        today = payouts["sales_date"]
        future = (date_cls.fromisoformat(today) + timedelta(days=1)).isoformat()

        print("== A: gates and shape ==")
        s, r = req("GET", f"/api/finance/shift-review?date={D1}", token=ktok)
        ok("A1 kitchen cannot read a shift review", s == 403, f"{s}")
        s, r = declare(ktok, 100, day=D1)
        ok("A2 kitchen cannot declare cash tips", s == 403, f"{s}")
        s, r = req("GET", f"/api/finance/shift-review?date={D1}")
        ok("A3 no token is a 401", s == 401, f"{s}")
        s, r = review(stok, D1, server_id=S2)
        ok("A4 a server cannot read another server review", s == 403, f"{s} {r}")
        s, r = review(mtok, D1, server_id=999999)
        ok("A5 an unknown server_id is a 404 for a manager", s == 404, f"{s}")
        s, r = req("GET", "/api/finance/shift-review?date=16-09-2026", token=stok)
        ok("A6 a malformed review date is a 400", s == 400, f"{s}")
        s, r = declare(stok, 100, day="16/09/2026")
        ok("A7 a malformed declaration date is a 400", s == 400, f"{s}")
        s, r = declare(stok, 100, day=future)
        ok("A8 a declaration for a future date is a 400 (you cannot attest tips not yet received)",
           s == 400, f"{s} {r}")

        print("== B: the review before any declaration — builders verbatim ==")
        s, rev = review(stok, D1)
        ok("B0 the own review loads", s == 200, f"{s} {str(rev)[:200]}")
        ok("B1 scope is server + business date, named honestly",
           rev.get("scope") == "server_business_date" and rev.get("server_id") == S1, str(rev.get("scope")))
        s, fin = req("GET", f"/api/finance/shift?date={D1}&server_id={S1}", token=mtok)
        sv = rev["sales"]
        ok("B2 review sales ARE the finance/shift figures",
           sv["checks_closed"] == fin["checks_closed"] == 1
           and sv["subtotal_cents"] == fin["subtotal_cents"] == 2000
           and sv["service_charge_cents"] == fin["service_charge_cents"] == 0
           and sv["cash_sales_cents"] == fin["cash_sales_cents"] == 1000
           and sv["card_brand_breakdown"] == fin["card_brand_breakdown"] == {"Visa": 1263},
           str(sv))
        trow = next((x for x in report(mtok, "tips", D1)["rows"] if x["server_name"] == "Daniel S"), None)
        tp = rev["tips"]
        ok("B3 recorded tips ARE the tips report row (card 200, cash 300)",
           trow and tp["card_tips_cents"] == trow["card_tips_cents"] == 200
           and tp["recorded_cash_tips_cents"] == trow["cash_tips_cents"] == 300
           and trow["total_tips_cents"] == 500, str(tp))
        ok("B4 before declaring: declared is null (not zero), of-record falls back to recorded cash, total 500",
           tp["declared_cash_tips_cents"] is None and tp["declared"] is False
           and tp["cash_tips_of_record_cents"] == 300 and tp["total_tips_cents"] == 500
           and tp["cash_owed_to_server_cents"] == 200, str(tp))
        s, tpr = req("GET", f"/api/tipout/report?date={D1}", token=mtok)
        trow_out = next((x for x in tpr["servers"] if x["server_id"] == S1), None)
        ok("B5 tip-out IS the tip-out report row (tips 500, owed 50, net 450), untouched by declarations",
           trow_out and rev["tipout"] and rev["tipout"]["tips_cents"] == trow_out["tips_cents"] == 500
           and rev["tipout"]["total_tipout_cents"] == trow_out["total_tipout_cents"] == 50
           and rev["tipout"]["net_tips_cents"] == trow_out["net_tips_cents"] == 450,
           str(rev.get("tipout")))
        ok("B6 the still-open check B is listed as held by the server",
           rev["open_checks"] == {"count": 1, "check_ids": [b]}, str(rev["open_checks"]))
        ok("B7 labor comes from the clock: one D1 shift of 8.0 hours",
           len(rev["labor"]["shifts"]) == 1 and rev["labor"]["hours"] == 8, str(rev["labor"]))
        ok("B8 the day is not closed yet", rev["day_closed"] is False, str(rev["day_closed"]))

        print("== C: declare — the composition never double-counts ==")
        s, r = declare(stok, 475, day=D1)
        ok("C1 a server declares their own cash tips (201)",
           s == 201 and (r.get("declaration") or {}).get("declared_cash_tips_cents") == 475
           and (r.get("declaration") or {}).get("declared_by") == "Daniel S", f"{s} {str(r)[:160]}")
        s, rev = review(stok, D1)
        tp = rev["tips"]
        ok("C2 after declaring 475: of-record is 475 and the total is 200 + 475 = 675 — never 975",
           tp["declared_cash_tips_cents"] == 475 and tp["declared"] is True
           and tp["cash_tips_of_record_cents"] == 475 and tp["total_tips_cents"] == 675
           and tp["recorded_cash_tips_cents"] == 300, str(tp))
        trow = next((x for x in report(mtok, "tips", D1)["rows"] if x["server_name"] == "Daniel S"), None)
        ok("C3 the tips report gains the declared column; the recorded columns do not move",
           trow and trow["declared_cash_tips_cents"] == 475 and trow["cash_tips_cents"] == 300
           and trow["card_tips_cents"] == 200 and trow["total_tips_cents"] == 500, str(trow))
        rows = [x for x in audit_rows(mtok) if x.get("action") == "declare_cash_tips"]
        ok("C4 the declaration is approval-audited with a null before and the declared after",
           len(rows) == 1 and rows[0].get("actor") == "Daniel S"
           and json.loads(rows[0].get("before_json") or "null") is None
           and json.loads(rows[0].get("after_json") or "{}").get("declared_cash_tips_cents") == 475
           and json.loads(rows[0].get("details") or "{}").get("server_id") == S1, str(rows)[:200])
        s, r = declare(stok, 500, day=D1)
        ok("C5 the server amends their own declaration without a PIN (200, amended)",
           s == 200 and r.get("amended") is True
           and (r.get("declaration") or {}).get("declared_cash_tips_cents") == 500, f"{s} {str(r)[:160]}")
        rows = [x for x in audit_rows(mtok) if x.get("action") == "amend_cash_tips"]
        ok("C6 the amendment is audited with before 475 and after 500",
           len(rows) == 1
           and json.loads(rows[0].get("before_json") or "{}").get("declared_cash_tips_cents") == 475
           and json.loads(rows[0].get("after_json") or "{}").get("declared_cash_tips_cents") == 500,
           str(rows)[:200])
        s, rev = review(stok, D1)
        ok("C7 the review total follows the amendment: 200 + 500 = 700",
           rev["tips"]["total_tips_cents"] == 700, str(rev["tips"]))

        print("== D: declared zero is not not-declared; default date is today ==")
        s, r = declare(stok2, 0, day=D1)
        ok("D1 a second server can declare zero (a real attestation)", s == 201, f"{s} {str(r)[:120]}")
        s, rev2 = review(mtok, D1, server_id=S2)
        tp2 = rev2["tips"]
        ok("D2 declared zero reads as declared: of-record 0, never the recorded fallback",
           tp2["declared"] is True and tp2["declared_cash_tips_cents"] == 0
           and tp2["cash_tips_of_record_cents"] == 0 and tp2["total_tips_cents"] == 0
           and rev2["tipout"] is None and rev2["sales"]["checks_closed"] == 0, str(tp2))
        trow2 = next((x for x in report(mtok, "tips", D1)["rows"] if x["server_name"] == "Sam Server"), None)
        ok("D3 a declared-only server still gets a tips report row (zeros + declared)",
           trow2 is not None and trow2["cash_tips_cents"] == 0 and trow2["declared_cash_tips_cents"] == 0,
           str(trow2))
        s, r = declare(stok2, 250)
        ok("D4 omitting the date declares for the site-local today",
           s == 201 and (r.get("declaration") or {}).get("date") == today, f"{s} {str(r)[:140]}")

        print("== E: own-only and the manager amendment gate ==")
        s, r = declare(stok, 999, day=D1, server_id=S2)
        ok("E1 a server cannot declare for another server (403), and the target is unchanged",
           s == 403, f"{s} {r}")
        s, rev2 = review(mtok, D1, server_id=S2)
        ok("E1b server2 declaration is still the zero from D1",
           rev2["tips"]["declared_cash_tips_cents"] == 0, str(rev2["tips"]))
        fails_before = sum(1 for x in audit_rows(mtok) if x.get("action") == "auth_manager_pin_failed")
        s, r = declare(mtok, 550, day=D1, server_id=S1)
        fails_mid = sum(1 for x in audit_rows(mtok) if x.get("action") == "auth_manager_pin_failed")
        ok("E2 a manager amending without a PIN is refused 403 need_manager_pin, and the refusal is audit-logged",
           s == 403 and r.get("need_manager_pin") is True and fails_mid == fails_before + 1,
           f"{s} {r} fails {fails_before} -> {fails_mid}")
        s, r = declare(mtok, 550, day=D1, server_id=S1, pin="0000")
        fails_after = sum(1 for x in audit_rows(mtok) if x.get("action") == "auth_manager_pin_failed")
        ok("E3 a wrong PIN is refused and the failed attempt is audit-logged",
           s == 403 and fails_after == fails_mid + 1, f"{s} fails {fails_mid} -> {fails_after}")
        s, rev = review(stok, D1)
        ok("E4 the refused amendments never moved the declaration (still 500)",
           rev["tips"]["declared_cash_tips_cents"] == 500, str(rev["tips"]))
        s, r = declare(mtok, 550, day=D1, server_id=S1, pin=MANAGER_PIN)
        ok("E5 a manager amends with a fresh PIN (200)",
           s == 200 and (r.get("declaration") or {}).get("declared_cash_tips_cents") == 550, f"{s} {str(r)[:160]}")
        rows = [x for x in audit_rows(mtok) if x.get("action") == "amend_cash_tips"
                and json.loads(x.get("after_json") or "{}").get("declared_cash_tips_cents") == 550]
        ok("E6 the manager amendment is audited: actor Manager, before 500, after 550",
           len(rows) == 1 and rows[0].get("actor") == "Manager"
           and json.loads(rows[0].get("before_json") or "{}").get("declared_cash_tips_cents") == 500,
           str(rows)[:200])
        s, rev = review(stok, D1)
        ok("E7 the first declarant is preserved on the row; the last writer is the manager",
           rev["declaration"]["declared_by"] == "Daniel S" and rev["declaration"]["updated_by"] == "Manager"
           and rev["tips"]["total_tips_cents"] == 750, str(rev.get("declaration")))
        s, r = declare(stok, 500, day=D1)
        ok("E8 the server can still self-amend after a manager amendment (no PIN)",
           s == 200 and (r.get("declaration") or {}).get("declared_cash_tips_cents") == 500, f"{s}")

        print("== F: validation matrix (on D2, away from the D1 fixtures) ==")
        for name, cents in [("negative", -1), ("fractional cents", 1050.5), ("a string", "500"),
                            ("null", None), ("a boolean", True)]:
            body = {"declared_cash_tips_cents": cents, "date": D2}
            s, r = req("POST", "/api/finance/tip-declarations", body, token=stok)
            ok(f"F-validation: {name} is a 400", s == 400, f"{s} {str(r)[:120]}")
        s, r = req("POST", "/api/finance/tip-declarations", {"date": D2}, token=stok)
        ok("F-validation: a missing amount is a 400", s == 400, f"{s}")
        s, r = declare(stok, 999999999, day=D2)
        ok("F-absurd: an absurd attestation is accepted — the system records, it does not judge",
           s == 201, f"{s} {str(r)[:120]}")
        s, r = declare(stok, 100, day=D2, server_id="abc")
        ok("F-validation: a non-integer server_id is a 400", s == 400, f"{s}")

        print("== G: EOD interplay — exempt from the freeze, invisible to the frozen Z ==")
        s, co = req("POST", "/api/finance/close-day",
                    {"date": D1, "counted_cash_cents": 1000, "manager_pin": MANAGER_PIN}, token=mtok)
        ok("G1 D1 closes (counted = the 1000 expected cash)", s == 201, f"{s} {str(co)[:160]}")
        co_id = co.get("id")
        s, detail = req("GET", f"/api/finance/closeouts/{co_id}", token=mtok)
        snap_before = (detail or {}).get("snapshot") or {}
        ok("G2 the frozen Z snapshot carries the declarations filed before the close (declared total 500)",
           (snap_before.get("tips") or {}).get("totals", {}).get("declared_cash_tips_cents") == 500,
           str((snap_before.get("tips") or {}).get("totals")))
        s, r = declare(stok, 600, day=D1)
        ok("G3 a declaration on the CLOSED day is still accepted (exempt: it moves no money)",
           s == 200 and (r.get("declaration") or {}).get("declared_cash_tips_cents") == 600, f"{s} {str(r)[:140]}")
        s, rev = review(stok, D1)
        ok("G4 the review shows the closed day and the new declared figure (total 200 + 600 = 800)",
           rev["day_closed"] is True and rev["tips"]["declared_cash_tips_cents"] == 600
           and rev["tips"]["total_tips_cents"] == 800, str(rev["tips"]))
        s, detail2 = req("GET", f"/api/finance/closeouts/{co_id}", token=mtok)
        ok("G5 the frozen snapshot is byte-identical after the late declaration",
           (detail2 or {}).get("snapshot") == snap_before, "snapshot changed")
        trow = next((x for x in report(mtok, "tips", D1)["rows"] if x["server_name"] == "Daniel S"), None)
        ok("G6 the LIVE tips report does move (declared 600) — live and frozen are different records",
           trow and trow["declared_cash_tips_cents"] == 600, str(trow))
        s, r = req("PATCH", f"/api/payments/{a_card}/tip", {"tip_cents": 999}, token=mtok)
        ok("G7 the day money itself stays frozen: a tip adjustment on D1 still 409s day_closed",
           s == 409 and r.get("day_closed") is True, f"{s} {r}")
        s, r = req("POST", "/api/finance/close-day/reopen",
                   {"date": D1, "manager_pin": MANAGER_PIN, "reason": "late declaration check"}, token=mtok)
        ok("G8 reopening D1 succeeds", s == 200, f"{s} {str(r)[:120]}")
        s_post, co2 = req("POST", "/api/finance/close-day",
                          {"date": D1, "counted_cash_cents": 1000, "manager_pin": MANAGER_PIN}, token=mtok)
        s, detail3 = req("GET", f"/api/finance/closeouts/{co2.get('id')}", token=mtok)
        ok("G9 a re-close snapshots the CURRENT builder output (declared total now 600)",
           s_post == 201 and s == 200 and ((detail3 or {}).get("snapshot") or {}).get("tips", {}).get("totals", {})
           .get("declared_cash_tips_cents") == 600,
           f"post={s_post} get={s} " + str(((detail3 or {}).get("snapshot") or {}).get("tips", {}).get("totals")))

        print("== R: rider — replay before freeze in POST /payments ==")
        rc = build_check(stok, [(BRO, 1)])   # total 1131, stays open
        key = {"Idempotency-Key": "test52-rider-1"}
        pid = pay(stok, rc, "cash", 500, tip=0, tendered=500, headers=key)
        s, coT = req("POST", "/api/finance/close-day",
                     {"counted_cash_cents": 0, "manager_pin": MANAGER_PIN}, token=mtok)
        ok("R1 today closes (default date)", s == 201 and coT.get("business_date") == today, f"{s} {str(coT)[:140]}")
        s, r = req("POST", f"/api/checks/{rc}/payments",
                   {"method": "cash", "amount_cents": 500, "tip_cents": 0, "tendered_cents": 500},
                   token=stok, headers=key)
        ok("R2 retrying the applied payment on the closed day REPLAYS the stored 201, not a 409",
           s == 201 and (r.get("payment") or {}).get("id") == pid, f"{s} {str(r)[:160]}")
        s, r = req("POST", f"/api/checks/{rc}/payments",
                   {"method": "cash", "amount_cents": 100, "tip_cents": 0, "tendered_cents": 100},
                   token=stok, headers={"Idempotency-Key": "test52-rider-2"})
        ok("R3 a NEW payment (new key) on the closed day still 409s day_closed",
           s == 409 and r.get("day_closed") is True, f"{s} {r}")
        s, r = req("POST", f"/api/checks/{rc}/payments",
                   {"method": "cash", "amount_cents": 100, "tip_cents": 0, "tendered_cents": 100},
                   token=stok)
        ok("R4 a NEW payment (no key) on the closed day still 409s day_closed",
           s == 409 and r.get("day_closed") is True, f"{s} {r}")
        bal = get_check(stok, rc)["totals"]["balance"]
        ok("R5 the replays and refusals moved no money (balance still 631)", bal == 631, f"balance={bal}")
        s, r = req("POST", "/api/finance/close-day/reopen",
                   {"date": today, "manager_pin": MANAGER_PIN, "reason": "rider cleanup"}, token=mtok)
        ok("R6 today reopens for a clean end state", s == 200, f"{s}")

        print("== H: harness52 — the real client helpers ==")
        r = subprocess.run(["node", str(HERE / "harness52_client.js")],
                           capture_output=True, text=True)
        sys.stdout.write(r.stdout)
        oks = r.stdout.count("  ok  ")
        ok("H1 harness exits clean", r.returncode == 0, f"exit={r.returncode} {(r.stderr or '')[:200]}")
        ok(f"H2 harness sub-checks all pass ({oks} ok lines)", r.returncode == 0 and oks >= 33, f"oks={oks}")

    finally:
        stop(srv)
    print(f"\n{passed} passed, {failed} failed")
    if failures:
        print("FAILURES:", failures)
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
