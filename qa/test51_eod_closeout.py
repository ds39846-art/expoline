#!/usr/bin/env python3
"""test51_eod_closeout.py — end-of-day close-out (Z), audit gap #5.

Toast/SpotOn end the day with a Z ritual: review the day figures,
count the cash drawer against what the system expects, record
over/short, and LOCK the day — yesterday money can no longer be
edited. Expoline had rich per-day finance reports but no close-out:
no snapshot, no drawer count, no lock. This batch adds it:

  - POST /api/finance/close-day (manager + FRESH manager PIN always,
    counted_cash_cents REQUIRED) snapshots the day by calling the very
    report builders Finance shows — REPORT_DEFS sales/tax/tips rows
    and payoutDay() verbatim — plus named-source extras (payments by
    method, refunds, voids, item discounts) and stores ONE closeouts
    row. The snapshot is immutable: it is never recomputed.
  - The business date then LOCKS through one freeze primitive
    (assertDayOpen): refunds and tip adjustments on payments of that
    date (payment created date OR parent check closed date — the two
    bucketings the reports use), check-reopen resurrecting that date
    money, and any NEW payment dated into a closed today (staff
    payments here; guest card pay / cash-collect / gift-card redeem /
    LAN ops carry the same injected guard) are refused 409 day_closed.
  - POST /api/finance/close-day/reopen (PIN + reason) voids the row
    (kept forever) and unfreezes the day; a re-close writes a NEW row
    with a fresh snapshot.

Business-date definition (ONE, matching the snapshotted reports): a
check belongs to tzDate(closed_at) once closed — the sales/tax
bucketing; a payment also carries tzDate(created_at) — the payouts /
tips bucketing. An open check has no business date: it is CARRIED
(listed in the close-out) and lands on the date it eventually closes.

Expected cash is payments-derived ONLY: cash payments taken on the
date, net of cash refunds (drawerExpected per-payment rule). It
excludes the drawer opening float and paid-ins/paid-outs (the
per-session drawer ritual owns those) and cash tips (kept by the
server). The client copy says exactly this.

FIXTURES (built via the API on the wall-clock day, then moved to
fixture dates by direct SQL on the test DB — dates are controlled by
the DATA, never the wall clock). D1 = 2026-09-14, D2 = 2026-09-15,
D0 = 2026-09-10 (zero activity). Site tz America/Los_Angeles (PDT,
UTC-7): the boundary pair is a check closed 2026-09-15T06:59Z
(23:59 PDT on D1) vs 2026-09-15T07:01Z (00:01 PDT on D2).

Site config (seeded): tax 7.75%, surcharge 5%, service charge 18% at
8+ guests (all fixtures are 2 guests, so service charge is 0).

  A cash — Broccoli 1000 x2: subtotal 2000, surcharge 100,
      tax round(2100*.0775)=163, total 2263. Cash 2263, tip 300,
      tendered 2563. Expected cash += 2263.
  B card + line discount — Tuna Poke 2100, ad-hoc line discount 500:
      subtotal 1600, surcharge 80, tax 130, total 1810. Card, tip 200.
  C cash + comp + refund — Spicy Yakisoba 3200, comp 1000:
      subtotal 3200, surcharge 160, tax 260, total 2620. Cash 2620,
      then a 620 cash refund (before the move) → partial_refund.
      Expected cash += 2620-620 = 2000.
  V void — Broccoli 1000 x1, whole-check void (PIN + reason).
      Voids figure: count 1, amount 1000 (gross of cancelled lines).
  X boundary — Broccoli 1000 x1: tax round(1050*.0775)=81, total 1131.
      Card, tip 100. closed_at moved to 2026-09-15T06:59Z → D1.
  Y boundary — same build, closed_at moved to 2026-09-15T07:01Z → D2.
  P reopen-freeze fixture — Broccoli x1 paid in full by card (1131),
      left status paid; SQL then sets refunded_cents 300 /
      partial_refund (the exact state a refund-with-reseat leaves:
      paid with a positive balance) and moves the payment to D1.
  P2 — the same construction, payment moved to D2 (open-day control).
  O carried — Broccoli x1, left OPEN across the D1 close.

  D1 rollup (payments A,B,C,X,P created on D1; checks A,B,C,X closed
  on D1; V voided on D1):
      sales row (checks A,B,C,X): checks 4, gross 7800, surcharge 390,
        comp 1000, tax 634, tips 600, cash (net) 4263, card (net) 2941,
        net = 7800+390-1000 = 7190
      tax row: checks 4, taxable 8190, tax 634, comp 1000, tips 600
      payouts row: card_volume 4072 (B1810+X1131+P1131), refunds 300
        (card only, the builder rule), cash_sales 4883 (gross amounts),
        tips 600
      payments_by_method: cash {2, 4883, refunded 620, net 4263, tips 300}
                          card {3, 4072, refunded 300, net 3772, tips 300}
      Z refunds {count 2, amount 920}; voids {1, 1000};
      item_discounts 500; true gross 8300
      EXPECTED CASH 4263 → counted 4313 → over/short +50.

Discriminating control at 44d7680 (verified): every close-day
endpoint 404s, the harness cannot extract either helper, and the
suite fails from section A on. The money endpoints behave exactly as
before there (no freeze exists to refuse anything).

Boot pattern mirrors test49/test50 (plain node, own port + DB file).
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
PORT = 4386
DB = "/tmp/expoline-test51.db"
BASE = f"http://127.0.0.1:{PORT}"
SERVER_PIN = "1111"
MANAGER_PIN = "2580"
KITCHEN_PIN = "2222"

D0 = "2026-09-10"
D1 = "2026-09-14"
D2 = "2026-09-15"
D1_INSTANT = "2026-09-14T19:00:00.000Z"     # 12:00 PDT on D1
D2_INSTANT = "2026-09-15T19:00:00.000Z"     # 12:00 PDT on D2
X_INSTANT = "2026-09-15T06:59:00.000Z"      # 23:59 PDT on D1
Y_INSTANT = "2026-09-15T07:01:00.000Z"      # 00:01 PDT on D2

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


def pay(tok, cid, method, amount, tip=0, tendered=None):
    body = {"method": method, "amount_cents": amount, "tip_cents": tip}
    if method == "card_demo":
        body.update({"brand": "Visa", "last4": "4242"})
    if tendered is not None:
        body["tendered_cents"] = tendered
    s, r = req("POST", f"/api/checks/{cid}/payments", body, token=tok)
    assert s == 201, (s, r)
    return r["payment"]["id"]


def close_check(tok, cid):
    s, r = req("POST", f"/api/checks/{cid}/close", {}, token=tok)
    assert s == 200, (s, r)


def report(tok, kind, day):
    s, r = req("GET", f"/api/finance/reports/{kind}?format=json&from={day}&to={day}", token=tok)
    assert s == 200, (kind, s, r)
    return r


def sql(*stmts):
    con = sqlite3.connect(DB, timeout=30)
    try:
        for q, args in stmts:
            con.execute(q, args)
        con.commit()
    finally:
        con.close()


def move(check_id, payment_ids, instant, opened=None):
    stmts = [("UPDATE checks SET closed_at = ? WHERE id = ?", (instant, check_id))]
    if opened:
        stmts.append(("UPDATE checks SET opened_at = ? WHERE id = ?", (opened, check_id)))
    for pid in payment_ids:
        stmts.append(("UPDATE payments SET created_at = ? WHERE id = ?", (instant, pid)))
    sql(*stmts)


def audit_actions(mtok):
    s, r = req("GET", "/api/admin/approvals/audit?limit=300", token=mtok)
    assert s == 200, (s, r)
    rows = r if isinstance(r, list) else r.get("audit", r.get("rows", []))
    return rows


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
        TUNA = menu["Tuna Poke"]["id"]
        YAKI = menu["Spicy Yakisoba Short Rib"]["id"]

        print("== fixtures: build on the wall-clock day ==")
        # A — cash, tip 300
        a = build_check(stok, [(BRO, 2)])
        a_pay = pay(stok, a, "cash", 2263, tip=300, tendered=2563)
        close_check(stok, a)
        # B — card, line discount 500, tip 200
        b = build_check(stok, [(TUNA, 1)])
        b_item = get_check(stok, b)["items"][0]["id"]
        s, r = req("POST", f"/api/checks/{b}/items/{b_item}/discount",
                   {"amount_cents": 500, "reason": "fixture"}, token=stok)
        assert s == 200, (s, r)
        b_pay = pay(stok, b, "card_demo", 1810, tip=200)
        close_check(stok, b)
        # C — cash, comp 1000, refund 620
        c = build_check(stok, [(YAKI, 1)])
        s, r = req("POST", f"/api/checks/{c}/comp",
                   {"amount_cents": 1000, "manager_pin": MANAGER_PIN, "reason": "fixture"}, token=stok)
        assert s == 200, (s, r)
        c_pay = pay(stok, c, "cash", 2620, tip=0, tendered=2620)
        close_check(stok, c)
        s, r = req("POST", f"/api/payments/{c_pay}/refund", {"amount_cents": 620}, token=mtok)
        assert s == 200, (s, r)
        # V — voided check
        v = build_check(stok, [(BRO, 1)])
        s, r = req("POST", f"/api/checks/{v}/void",
                   {"manager_pin": MANAGER_PIN, "reason": "fixture void"}, token=stok)
        assert s == 200, (s, r)
        # X / Y — boundary pair
        x = build_check(stok, [(BRO, 1)])
        x_pay = pay(stok, x, "card_demo", 1131, tip=100)
        close_check(stok, x)
        y = build_check(stok, [(BRO, 1)])
        y_pay = pay(stok, y, "card_demo", 1131, tip=100)
        close_check(stok, y)
        # O / O2 — open checks, built BEFORE P/P2 so they hold their own
        # tables: the reopen occupant guard must see P/P2 tables empty
        # (a later fixture re-seating P2 table would 409 the control).
        o = build_check(stok, [(BRO, 1)])
        o2 = build_check(stok, [(BRO, 1)])  # used by the today-close guard section
        # P / P2 — paid with a balance (refund-with-reseat state), via SQL
        p = build_check(stok, [(BRO, 1)])
        p_pay = pay(stok, p, "card_demo", 1131, tip=0)
        p2 = build_check(stok, [(BRO, 1)])
        p2_pay = pay(stok, p2, "card_demo", 1131, tip=0)

        print("== fixtures: move to fixture dates by SQL (data-controlled) ==")
        move(a, [a_pay], D1_INSTANT, "2026-09-14T18:00:00.000Z")
        move(b, [b_pay], D1_INSTANT, "2026-09-14T18:05:00.000Z")
        move(c, [c_pay], D1_INSTANT, "2026-09-14T18:10:00.000Z")
        sql(("UPDATE checks SET closed_at = ? WHERE id = ?", (D1_INSTANT, v)),
            ("UPDATE checks SET opened_at = ? WHERE id = ?", ("2026-09-14T18:15:00.000Z", v)))
        move(x, [x_pay], X_INSTANT, "2026-09-14T23:30:00.000Z")
        move(y, [y_pay], Y_INSTANT, "2026-09-15T00:00:30.000Z")
        sql(("UPDATE payments SET created_at = ?, refunded_cents = 300, status = 'partial_refund' WHERE id = ?",
             (D1_INSTANT, p_pay)),
            ("UPDATE payments SET created_at = ?, refunded_cents = 300, status = 'partial_refund' WHERE id = ?",
             (D2_INSTANT, p2_pay)))
        ok("F1 fixtures moved (boundary pair straddles the site-local midnight)",
           get_check(stok, x)["status"] == "closed" and get_check(stok, y)["status"] == "closed")

        print("== A: close D1 — snapshot equals the live report builders to the cent ==")
        sales_pre = report(mtok, "sales", D1)
        tax_pre = report(mtok, "tax", D1)
        payouts_pre = report(mtok, "payouts", D1)
        tips_pre = report(mtok, "tips", D1)
        s, co = req("POST", "/api/finance/close-day",
                    {"date": D1, "counted_cash_cents": 4313, "manager_pin": MANAGER_PIN}, token=mtok)
        ok("A1 close-day returns 201", s == 201, f"{s} {co}")
        snap = co.get("snapshot") or {}
        ok("A2 expected cash is the payments-derived figure (2263 + 2620-620)",
           co.get("expected_cash_cents") == 4263, str(co.get("expected_cash_cents")))
        ok("A3 over/short = counted - expected (+50)", co.get("over_short_cents") == 50)
        ok("A4 snapshot.sales IS the sales report row", snap.get("sales") == sales_pre["rows"][0],
           f'{snap.get("sales")} vs {sales_pre["rows"][0]}')
        ok("A5 snapshot.tax IS the tax report row", snap.get("tax") == tax_pre["rows"][0])
        ok("A6 snapshot.payouts IS the payouts report row", snap.get("payouts") == payouts_pre["rows"][0],
           f'{snap.get("payouts")} vs {payouts_pre["rows"][0]}')
        ok("A7 snapshot.tips rows ARE the tips report rows", (snap.get("tips") or {}).get("rows") == tips_pre["rows"])
        tt = {k: v for k, v in (tips_pre.get("totals") or {}).items() if k != "label"}
        ok("A8 snapshot.tips totals equal the tips report totals", (snap.get("tips") or {}).get("totals") == tt,
           f'{(snap.get("tips") or {}).get("totals")} vs {tt}')
        sr = snap.get("sales") or {}
        ok("A9 sales hand-figures (checks incl. boundary X, excl. Y and the void)",
           sr.get("checks") == 4 and sr.get("gross_cents") == 7800 and sr.get("comp_cents") == 1000
           and sr.get("tax_cents") == 634 and sr.get("net_cents") == 7190, str(sr))
        ok("A10 payments by method (cash net of the refund; card incl. fixture P)",
           snap.get("payments_by_method") == [
               {"method": "card_demo", "count": 3, "amount_cents": 4072, "refunded_cents": 300,
                "net_cents": 3772, "tips_cents": 300},
               {"method": "cash", "count": 2, "amount_cents": 4883, "refunded_cents": 620,
                "net_cents": 4263, "tips_cents": 300}], str(snap.get("payments_by_method")))
        ok("A11 refunds roll-up counts both refunded payments (all methods)",
           snap.get("refunds") == {"count": 2, "amount_cents": 920}, str(snap.get("refunds")))
        ok("A12 voids figure from the named source (the voided check, gross of cancelled lines)",
           snap.get("voids") == {"count": 1, "amount_cents": 1000}, str(snap.get("voids")))
        ok("A13 item discounts + true gross ride the snapshot",
           snap.get("item_discounts_cents") == 500 and snap.get("gross_sales_cents") == 8300,
           f'{snap.get("item_discounts_cents")} {snap.get("gross_sales_cents")}')
        carried = (snap.get("open_checks_carried") or {})
        ok("A14 the still-open check is listed as carried over, not force-closed",
           o in (carried.get("check_ids") or []) and carried.get("count") == len(carried.get("check_ids") or [])
           and get_check(stok, o)["status"] == "open", str(carried))
        co_id = co.get("id")

        print("== B: the lock — closed-day money refuses, open-day controls succeed ==")
        s, r = req("PATCH", f"/api/payments/{b_pay}/tip", {"tip_cents": 250, "manager_pin": MANAGER_PIN}, token=stok)
        ok("B1 tip adjust on a D1 payment is refused 409 day_closed",
           s == 409 and r.get("day_closed") is True and r.get("business_date") == D1, f"{s} {r}")
        s, r = req("POST", f"/api/payments/{c_pay}/refund", {"amount_cents": 100}, token=mtok)
        ok("B2 refund on a D1 payment is refused 409 day_closed", s == 409 and r.get("day_closed") is True, f"{s} {r}")
        s, r = req("POST", f"/api/payments/{a_pay}/refund", {"amount_cents": 100}, token=mtok)
        ok("B3 refund on the other D1 payment is refused too", s == 409 and r.get("day_closed") is True, f"{s} {r}")
        s, r = req("POST", f"/api/checks/{p}/reopen", {"manager_pin": MANAGER_PIN}, token=mtok)
        ok("B4 reopening a paid check whose money sits on D1 is refused 409",
           s == 409 and r.get("day_closed") is True, f"{s} {r}")
        s, r = req("POST", f"/api/checks/{a}/comp",
                   {"amount_cents": 100, "manager_pin": MANAGER_PIN, "reason": "late comp"}, token=stok)
        ok("B5 comp on the closed D1 check stays refused (status guard)", s == 400, f"{s} {r}")
        s, r = req("POST", f"/api/checks/{a}/void",
                   {"manager_pin": MANAGER_PIN, "reason": "late void"}, token=stok)
        ok("B6 void on the closed D1 check stays refused (status guard)", s == 400, f"{s} {r}")
        s, r = req("POST", f"/api/checks/{a}/payments", {"method": "cash", "amount_cents": 100}, token=stok)
        ok("B7 a new payment on the closed D1 check stays refused (status guard)", s == 400, f"{s} {r}")
        # open-day controls (D2 is not closed yet)
        s, r = req("PATCH", f"/api/payments/{y_pay}/tip", {"tip_cents": 150, "manager_pin": MANAGER_PIN}, token=stok)
        ok("B8 CONTROL: tip adjust on a D2 payment succeeds", s == 200 and r.get("payment", {}).get("tip_cents") == 150, f"{s} {r}")
        s, r = req("POST", f"/api/checks/{p2}/reopen", {"manager_pin": MANAGER_PIN}, token=mtok)
        ok("B9 CONTROL: reopening a paid check whose money sits on open D2 succeeds",
           s == 200 and r.get("status") == "open", f"{s} {r}")
        s, r = req("POST", f"/api/payments/{y_pay}/refund", {"amount_cents": 100}, token=mtok)
        ok("B10 CONTROL: refund on a D2 payment succeeds", s == 200, f"{s} {r}")

        print("== C: close-out validation and gates ==")
        s, r = req("POST", "/api/finance/close-day",
                   {"date": D1, "counted_cash_cents": 0, "manager_pin": MANAGER_PIN}, token=mtok)
        ok("C1 double-close is a 409", s == 409 and r.get("day_closed") is True, f"{s} {r}")
        s, r = req("POST", "/api/finance/close-day",
                   {"date": D2, "counted_cash_cents": 0, "manager_pin": MANAGER_PIN}, token=stok)
        ok("C2 a server (non-manager) cannot close a day", s == 403, f"{s} {r}")
        s, r = req("POST", "/api/finance/close-day",
                   {"date": D2, "counted_cash_cents": 0}, token=mtok)
        ok("C3 a manager session without a fresh PIN is refused 403 need_manager_pin",
           s == 403 and r.get("need_manager_pin") is True, f"{s} {r}")
        before_fails = sum(1 for row in audit_actions(mtok) if row.get("action") == "auth_manager_pin_failed")
        s, r = req("POST", "/api/finance/close-day",
                   {"date": D2, "counted_cash_cents": 0, "manager_pin": "9999"}, token=mtok)
        after_fails = sum(1 for row in audit_actions(mtok) if row.get("action") == "auth_manager_pin_failed")
        ok("C4 a wrong PIN is refused and the failed attempt is audit-logged",
           s == 403 and after_fails == before_fails + 1, f"{s} fails {before_fails}->{after_fails}")
        s, r = req("POST", "/api/finance/close-day",
                   {"date": D2, "manager_pin": MANAGER_PIN}, token=mtok)
        ok("C5 counted_cash_cents is required", s == 400, f"{s} {r}")
        s, r = req("POST", "/api/finance/close-day",
                   {"date": D2, "counted_cash_cents": -5, "manager_pin": MANAGER_PIN}, token=mtok)
        ok("C6 a negative count is a 400", s == 400, f"{s} {r}")
        s, r = req("POST", "/api/finance/close-day",
                   {"date": D2, "counted_cash_cents": 10.5, "manager_pin": MANAGER_PIN}, token=mtok)
        ok("C7 a fractional count is a 400", s == 400, f"{s} {r}")
        s, r = req("POST", "/api/finance/close-day",
                   {"date": "09/14/2026", "counted_cash_cents": 0, "manager_pin": MANAGER_PIN}, token=mtok)
        ok("C8 a malformed date is a 400", s == 400, f"{s} {r}")
        s, payouts_today = req("GET", "/api/finance/payouts", token=mtok)
        today = payouts_today["sales_date"]
        future = (date_cls.fromisoformat(today) + timedelta(days=1)).isoformat()
        s, r = req("POST", "/api/finance/close-day",
                   {"date": future, "counted_cash_cents": 0, "manager_pin": MANAGER_PIN}, token=mtok)
        ok("C9 closing a future date is a 400", s == 400, f"{s} {r}")
        s, r = req("GET", "/api/finance/closeouts/999999", token=mtok)
        ok("C10 an unknown close-out id is a 404", s == 404, f"{s} {r}")
        s, r = req("GET", "/api/finance/closeouts", token=stok)
        ok("C11 the close-out list is manager-gated", s == 403, f"{s} {r}")

        print("== D: reopen → mutate → reclose; the voided snapshot never changes ==")
        s, r = req("POST", "/api/finance/close-day/reopen",
                   {"date": D1, "manager_pin": MANAGER_PIN}, token=mtok)
        ok("D1 reopen without a reason is a 400", s == 400, f"{s} {r}")
        s, r = req("POST", "/api/finance/close-day/reopen",
                   {"date": D1, "manager_pin": MANAGER_PIN, "reason": "tip was mis-keyed"}, token=mtok)
        ok("D2 reopen with PIN + reason succeeds and voids the row",
           s == 200 and r.get("status") == "voided" and r.get("reopen_reason") == "tip was mis-keyed", f"{s} {r}")
        s, st1 = req("GET", f"/api/finance/close-day?date={D1}", token=mtok)
        ok("D3 day status reads open again after the reopen", st1.get("closed") is False, str(st1))
        s, r = req("PATCH", f"/api/payments/{b_pay}/tip", {"tip_cents": 250, "manager_pin": MANAGER_PIN}, token=stok)
        ok("D4 the frozen tip adjusts again once the day is reopened",
           s == 200 and r.get("payment", {}).get("tip_cents") == 250, f"{s} {r}")
        s, co2 = req("POST", "/api/finance/close-day",
                     {"date": D1, "counted_cash_cents": 4263, "manager_pin": MANAGER_PIN}, token=mtok)
        ok("D5 re-close writes a NEW close-out row", s == 201 and co2.get("id") != co_id, f"{s} {co2.get('id')} vs {co_id}")
        ok("D6 the new snapshot reflects the mutation (tips 600 -> 650)",
           (co2.get("snapshot") or {}).get("payouts", {}).get("tips_cents") == 650,
           str((co2.get("snapshot") or {}).get("payouts")))
        ok("D7 the re-close over/short is exact at an exact count", co2.get("over_short_cents") == 0)
        s, old = req("GET", f"/api/finance/closeouts/{co_id}", token=mtok)
        ok("D8 the voided close-out keeps its ORIGINAL snapshot (immutable history)",
           s == 200 and old.get("status") == "voided"
           and (old.get("snapshot") or {}).get("payouts", {}).get("tips_cents") == 600
           and old.get("counted_cash_cents") == 4313, f"{s} {old.get('status')}")
        s, lst = req("GET", "/api/finance/closeouts", token=mtok)
        d1_rows = [row for row in lst.get("closeouts", []) if row.get("business_date") == D1]
        ok("D9 history lists both D1 close-outs (one closed, one voided)",
           len(d1_rows) == 2 and {row.get("status") for row in d1_rows} == {"closed", "voided"}, str(d1_rows))
        close_rows = [row for row in audit_actions(mtok) if row.get("action") == "close_day"]
        reopen_rows = [row for row in audit_actions(mtok) if row.get("action") == "reopen_day"]
        ok("D10 close and reopen are both approval-audited",
           len(close_rows) >= 2 and len(reopen_rows) >= 1, f"close={len(close_rows)} reopen={len(reopen_rows)}")
        s, r = req("PATCH", f"/api/payments/{b_pay}/tip", {"tip_cents": 275, "manager_pin": MANAGER_PIN}, token=stok)
        ok("D11 the re-close re-locks the day", s == 409 and r.get("day_closed") is True, f"{s} {r}")

        print("== E: boundary + D2 + zero-activity day ==")
        s, st2 = req("GET", f"/api/finance/close-day?date={D2}", token=mtok)
        ok("E1 D2 reads open with zero expected cash (card-only day)",
           st2.get("closed") is False and st2.get("expected_cash_cents") == 0, str(st2))
        s, co3 = req("POST", "/api/finance/close-day",
                     {"date": D2, "counted_cash_cents": 0, "manager_pin": MANAGER_PIN}, token=mtok)
        snap3 = co3.get("snapshot") or {}
        ok("E2 D2 closes with exactly the boundary check Y in sales (checks 1)",
           s == 201 and (snap3.get("sales") or {}).get("checks") == 1, f"{s} {snap3.get('sales')}")
        ok("E3 D2 payouts carry both D2 payments (Y adjusted+refunded, P2)",
           (snap3.get("payouts") or {}).get("card_volume_cents") == 2262
           and (snap3.get("payouts") or {}).get("refunds_cents") == 400, str(snap3.get("payouts")))
        s, co0 = req("POST", "/api/finance/close-day",
                     {"date": D0, "counted_cash_cents": 0, "manager_pin": MANAGER_PIN}, token=mtok)
        snap0 = co0.get("snapshot") or {}
        ok("E4 a zero-activity day closes with a zero snapshot",
           s == 201 and (snap0.get("sales") or {}).get("checks") == 0
           and co0.get("expected_cash_cents") == 0 and co0.get("over_short_cents") == 0, f"{s} {co0}")

        print("== F: carried check lands on its close date; today-close guards new money ==")
        s, before = req("GET", f"/api/finance/reports/sales?format=json&from={today}&to={today}", token=mtok)
        pay(stok, o, "cash", 1131, tip=0, tendered=1131)
        close_check(stok, o)
        s, after = req("GET", f"/api/finance/reports/sales?format=json&from={today}&to={today}", token=mtok)
        ok("F1 the carried check closed today counts today, not in the frozen D1 snapshot",
           after["rows"][0]["checks"] == before["rows"][0]["checks"] + 1
           and (snap.get("sales") or {}).get("checks") == 4,
           f'{before["rows"][0]["checks"]} -> {after["rows"][0]["checks"]}')
        s, coT = req("POST", "/api/finance/close-day",
                     {"counted_cash_cents": 0, "manager_pin": MANAGER_PIN}, token=mtok)
        ok("F2 closing today (default date) succeeds", s == 201 and coT.get("business_date") == today, f"{s} {coT}")
        bal = get_check(stok, o2)["totals"]["balance"]
        s, r = req("POST", f"/api/checks/{o2}/payments",
                   {"method": "cash", "amount_cents": bal, "tip_cents": 0, "tendered_cents": bal}, token=stok)
        ok("F3 a NEW payment dated into closed today is refused 409 day_closed",
           s == 409 and r.get("day_closed") is True and r.get("business_date") == today, f"{s} {r}")
        s, r = req("POST", "/api/finance/close-day/reopen",
                   {"date": today, "manager_pin": MANAGER_PIN, "reason": "late table still trading"}, token=mtok)
        ok("F4 reopening today succeeds", s == 200, f"{s} {r}")
        s, r = req("POST", f"/api/checks/{o2}/payments",
                   {"method": "cash", "amount_cents": bal, "tip_cents": 0, "tendered_cents": bal}, token=stok)
        ok("F5 the same payment succeeds once today is reopened", s == 201, f"{s} {r}")

        print("== H: harness51 — the real client helpers ==")
        r = subprocess.run(["node", str(HERE / "harness51_client.js")],
                           capture_output=True, text=True)
        sys.stdout.write(r.stdout)
        oks = r.stdout.count("  ok  ")
        ok("H1 harness exits clean", r.returncode == 0, f"exit={r.returncode} {(r.stderr or '')[:200]}")
        ok(f"H2 harness sub-checks all pass ({oks} ok lines)", r.returncode == 0 and oks >= 30, f"oks={oks}")

    finally:
        stop(srv)
    print(f"\n{passed} passed, {failed} failed")
    if failures:
        print("FAILURES:", failures)
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
