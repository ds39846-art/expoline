#!/usr/bin/env python3
"""test48_tip_adjust.py — tip adjustment (audit gap #3).

What is pinned here:

  H  The client half: qa/harness48_client.js extracts the REAL
     tipAdjustable / parseTipInput from public/app.js — the button
     renders exactly for settled card charges with no refund activity,
     and the typed-dollars parser yields integer cents or an honest
     error, never NaN.
  A  The surface the feature lives on: GET /api/checks/:id now carries
     the check payments (paymentView rows). Before this batch NO staff
     endpoint returned a check payments list, so the pay screen
     Payments list and the manager Refunds card only ever showed
     payments queued on the same device this session.
  B  Happy path on an OPEN check: a manager adjusts a card tip up and
     down; the payment row, the server-fed payments list, and the
     check balance all agree — and the balance does not move, because
     tips never enter totals (paid = amount - refunds).
  C  The manager gate, both established forms: a manager-role session
     (the refund form), or a server session carrying a fresh manager
     PIN (the void / comp form). No gate -> 403 with need_manager_pin;
     a wrong PIN -> 403; kitchen -> 403; no token -> 401.
  D  Validation: negative / fractional / string / missing / null
     tip_cents are all 400 and the stored tip never moves.
  E  Unknown payment id -> 404.
  F  Tender scope: card_demo only. Cash and house-account tips are
     money the house does not batch — adjusting one is a clean,
     documented 400 (correct by refund and re-ring). Gift cards never
     carry a tip at all (rejected at payment time, pinned by test47).
  G  The refund freeze: once ANY refund is taken against a payment
     (partial or full), its tip is final — adjust is a 400.
  I  A CLOSED check: the tip still adjusts (no batch/EOD marker exists
     yet to gate on), the check stays closed with a zero balance, and
     the money reports move by exactly the delta — the tip-out report
     per-server tips_cents and finance payouts tips_cents, both of
     which read the payments rows live.
  J  Principal immutability: a PATCH body smuggling amount_cents /
     status / refunded_cents changes only the tip.
  K  The audit row: every real adjustment writes an approval_audit
     'adjust_tip' row with actor, approver, check id, payment id, and
     the before/after tips (PIN form: actor is the server, approver
     is the manager whose PIN authorized it).
  L  Replay: an absolute-value PATCH is naturally idempotent — the
     identical repeat is a 200 no-op (unchanged:true) and writes NO
     second audit row.
  M  No tip cap, mirroring POST /payments: a tip larger than the
     payment principal is accepted.

Discriminating control at fb14b9a: PATCH /api/payments/:id/tip is a
404, GET /api/checks/:id has no payments key, and harness48 cannot
extract either helper — sections H, A, B, C, I, J, K, L, M fail
there while the pre-existing-behavior guards (D is unreachable
behind the 404, F/G set up through the payment API) still run.

Boot pattern mirrors test47 (plain node on :4376).
"""
import json
import os
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
HERE = Path(__file__).resolve().parent
PORT = 4376
DB = "/tmp/expoline-test48.db"
BASE = f"http://127.0.0.1:{PORT}"
SERVER_PIN = "1111"
KITCHEN_PIN = "2222"
MANAGER_PIN = "2580"
TODAY = time.strftime("%Y-%m-%d", time.gmtime())  # replaced below with site-local
TODAY = __import__("datetime").datetime.now(ZoneInfo("America/Los_Angeles")).strftime("%Y-%m-%d")

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
    return r.get("token"), (r.get("user") or {})


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


def rung_check(tok, item_id):
    t = free_table(tok)
    s, c = req("POST", "/api/checks", {"table_id": t["id"], "guest_count": 2}, token=tok)
    assert s == 201, (s, c)
    cid = c["id"]
    s, r = req("POST", f"/api/checks/{cid}/items",
               {"menu_item_id": item_id, "seat": 1, "qty": 1, "modifiers": []}, token=tok)
    assert s == 201, (s, r)
    s, r = req("POST", f"/api/checks/{cid}/send", {}, token=tok)
    assert s in (200, 201), (s, r)
    return cid


def get_check(tok, cid):
    s, c = req("GET", f"/api/checks/{cid}", token=tok)
    assert s == 200, (s, c)
    return c


def pay(tok, cid, body):
    s, r = req("POST", f"/api/checks/{cid}/payments", body, token=tok)
    assert s == 201, (s, r)
    return r["payment"]


def main():
    print("== H: harness48 — the real client helpers ==")
    r = subprocess.run(["node", str(HERE / "harness48_client.js")],
                       capture_output=True, text=True, timeout=120)
    print("  " + "\n  ".join((r.stdout or "").strip().split("\n")))
    oks = (r.stdout or "").count("  ok  ")
    ok("H1 harness exits clean", r.returncode == 0, f"exit={r.returncode} {(r.stderr or '')[:200]}")
    ok(f"H2 harness sub-checks all pass ({oks} ok lines)", r.returncode == 0 and oks >= 31, f"oks={oks}")

    if os.path.exists(DB):
        os.remove(DB)
    srv = boot(PORT, DB)
    try:
        stok, suser = login(SERVER_PIN)
        mtok, muser = login(MANAGER_PIN)
        ktok, _ = login(KITCHEN_PIN)
        items = menu_items(stok)
        plain = next(it for it in items.values()
                     if it.get("price_cents", 0) > 0 and not it.get("modifier_groups"))

        print("== A: GET /api/checks/:id carries the check payments ==")
        cid = rung_check(stok, plain["id"])
        bal = get_check(stok, cid)["totals"]["balance"]
        p1 = pay(stok, cid, {"method": "card_demo", "amount_cents": 1000, "tip_cents": 500})
        chk = get_check(stok, cid)
        rows = chk.get("payments")
        ok("A1 the payments key exists on the staff check payload", isinstance(rows, list),
           f"keys={sorted(chk.keys())}")
        row = next((x for x in (rows or []) if x.get("id") == p1["id"]), None)
        ok("A2 the payment row is the paymentView shape (id/method/tip/status/refunded)",
           bool(row) and row.get("method") == "card_demo" and row.get("tip_cents") == 500
           and row.get("status") == "completed" and row.get("refunded_cents") == 0, str(row))
        ok("A3 a partial card payment leaves the rest of the balance due",
           chk["totals"]["balance"] == bal - 1000 and chk["status"] == "open", str(chk["totals"]))

        print("== B: happy path on an open check — adjust up, adjust down ==")
        bal_before = get_check(stok, cid)["totals"]["balance"]
        s, r = req("PATCH", f"/api/payments/{p1['id']}/tip", {"tip_cents": 800}, token=mtok)
        ok("B1 manager adjusts the tip up (500 -> 800)",
           s == 200 and (r.get("payment") or {}).get("tip_cents") == 800
           and r.get("previous_tip_cents") == 500, f"{s} {str(r)[:160]}")
        s, r = req("PATCH", f"/api/payments/{p1['id']}/tip", {"tip_cents": 150}, token=mtok)
        ok("B2 manager adjusts the tip down (800 -> 150)",
           s == 200 and (r.get("payment") or {}).get("tip_cents") == 150
           and r.get("previous_tip_cents") == 800, f"{s} {str(r)[:160]}")
        chk = get_check(stok, cid)
        row = next(x for x in chk["payments"] if x["id"] == p1["id"])
        ok("B3 the server-fed payments list reflects the adjusted tip", row["tip_cents"] == 150, str(row))
        ok("B4 the principal never moved", row["amount_cents"] == 1000, str(row))
        ok("B5 the balance does not move when a tip moves (tips never enter totals)",
           chk["totals"]["balance"] == bal_before, str(chk["totals"]))

        print("== C: the manager gate, both forms ==")
        s, r = req("PATCH", f"/api/payments/{p1['id']}/tip", {"tip_cents": 900}, token=stok)
        ok("C1 a server with no manager PIN is refused 403 with need_manager_pin",
           s == 403 and r.get("need_manager_pin") is True, f"{s} {str(r)[:120]}")
        s, r = req("PATCH", f"/api/payments/{p1['id']}/tip",
                   {"tip_cents": 900, "manager_pin": "9999"}, token=stok)
        ok("C2 a server with a wrong manager PIN is refused 403",
           s == 403 and r.get("need_manager_pin") is True, f"{s} {str(r)[:120]}")
        s, r = req("PATCH", f"/api/payments/{p1['id']}/tip",
                   {"tip_cents": 900, "manager_pin": MANAGER_PIN}, token=stok)
        ok("C3 a server carrying a fresh manager PIN adjusts (void/comp form)",
           s == 200 and (r.get("payment") or {}).get("tip_cents") == 900, f"{s} {str(r)[:120]}")
        s, r = req("PATCH", f"/api/payments/{p1['id']}/tip", {"tip_cents": 100}, token=ktok)
        ok("C4 a kitchen session is refused before the handler (role wall)", s == 403, f"{s}")
        s, r = req("PATCH", f"/api/payments/{p1['id']}/tip", {"tip_cents": 100})
        ok("C5 no token at all is a 401", s == 401, f"{s}")
        row = next(x for x in get_check(stok, cid)["payments"] if x["id"] == p1["id"])
        ok("C6 the refused attempts never moved the tip", row["tip_cents"] == 900, str(row))

        print("== D: validation — bad tips are 400 and nothing moves ==")
        for label, body in [("negative", {"tip_cents": -1}),
                            ("fractional cents", {"tip_cents": 12.5}),
                            ("string", {"tip_cents": "800"}),
                            ("missing", {}),
                            ("null", {"tip_cents": None})]:
            s, r = req("PATCH", f"/api/payments/{p1['id']}/tip", body, token=mtok)
            ok(f"D-{label}: 400", s == 400, f"{s} {str(r)[:100]}")
        row = next(x for x in get_check(stok, cid)["payments"] if x["id"] == p1["id"])
        ok("D-final the stored tip survived every invalid body", row["tip_cents"] == 900, str(row))

        print("== E: unknown payment ==")
        s, r = req("PATCH", "/api/payments/999999/tip", {"tip_cents": 100}, token=mtok)
        ok("E1 an unknown payment id is a 404", s == 404, f"{s} {str(r)[:100]}")

        print("== F: tender scope — card only, the rest are clean documented 400s ==")
        cid2 = rung_check(stok, plain["id"])
        bal2 = get_check(stok, cid2)["totals"]["balance"]
        pcash = pay(stok, cid2, {"method": "cash", "amount_cents": bal2, "tip_cents": 200,
                                 "tendered_cents": bal2 + 200})
        s, r = req("PATCH", f"/api/payments/{pcash['id']}/tip", {"tip_cents": 300}, token=mtok)
        ok("F1 a cash tip cannot be adjusted — 400 naming the card-only rule",
           s == 400 and "card" in (r.get("error") or "").lower(), f"{s} {str(r)[:160]}")
        s, r = req("POST", "/api/admin/house-accounts", {"name": "Test House 48"}, token=mtok)
        ok("F2 a manager creates the house account for the house-payment probe",
           s in (200, 201), f"{s} {str(r)[:100]}")
        cid3 = rung_check(stok, plain["id"])
        bal3 = get_check(stok, cid3)["totals"]["balance"]
        phouse = pay(stok, cid3, {"method": "house_account", "amount_cents": bal3,
                                  "tip_cents": 150, "memo": "Test House 48"})
        s, r = req("PATCH", f"/api/payments/{phouse['id']}/tip", {"tip_cents": 300}, token=mtok)
        ok("F3 a house-account tip cannot be adjusted — same clean 400",
           s == 400 and "card" in (r.get("error") or "").lower(), f"{s} {str(r)[:160]}")

        print("== G: the refund freeze ==")
        cid4 = rung_check(stok, plain["id"])
        bal4 = get_check(stok, cid4)["totals"]["balance"]
        p4 = pay(stok, cid4, {"method": "card_demo", "amount_cents": bal4, "tip_cents": 400})
        s, r = req("POST", f"/api/payments/{p4['id']}/refund", {"amount_cents": 100}, token=mtok)
        assert s == 200, (s, r)
        s, r = req("PATCH", f"/api/payments/{p4['id']}/tip", {"tip_cents": 450}, token=mtok)
        ok("G1 a partially refunded payment has a frozen tip (400)",
           s == 400 and "refund" in (r.get("error") or "").lower(), f"{s} {str(r)[:160]}")
        cid5 = rung_check(stok, plain["id"])
        bal5 = get_check(stok, cid5)["totals"]["balance"]
        p5 = pay(stok, cid5, {"method": "card_demo", "amount_cents": bal5, "tip_cents": 400})
        s, r = req("POST", f"/api/payments/{p5['id']}/refund", {}, token=mtok)
        assert s == 200, (s, r)
        s, r = req("PATCH", f"/api/payments/{p5['id']}/tip", {"tip_cents": 450}, token=mtok)
        ok("G2 a fully refunded payment has a frozen tip (400)",
           s == 400 and "refunded" in (r.get("error") or "").lower(), f"{s} {str(r)[:160]}")

        print("== I: closed check — the tip still adjusts and the reports move by the delta ==")
        cid6 = rung_check(stok, plain["id"])
        bal6 = get_check(stok, cid6)["totals"]["balance"]
        p6 = pay(stok, cid6, {"method": "card_demo", "amount_cents": bal6, "tip_cents": 400})
        s, r = req("POST", f"/api/checks/{cid6}/close", {}, token=stok)
        ok("I0 the fully paid check closes", s == 200, f"{s} {str(r)[:120]}")

        def tipout_tips():
            s, rep = req("GET", f"/api/tipout/report?date={TODAY}", token=mtok)
            row = next((x for x in rep.get("servers", []) if x["server_id"] == suser["id"]), None)
            return (row or {}).get("tips_cents")

        def payout_tips():
            s, rep = req("GET", f"/api/finance/payouts?date={TODAY}", token=mtok)
            return rep.get("tips_cents")

        t_before, po_before = tipout_tips(), payout_tips()
        s, r = req("PATCH", f"/api/payments/{p6['id']}/tip", {"tip_cents": 650}, token=mtok)
        ok("I1 a tip on a closed check adjusts (no batch/EOD marker gates it yet)",
           s == 200 and (r.get("payment") or {}).get("tip_cents") == 650, f"{s} {str(r)[:120]}")
        chk6 = get_check(stok, cid6)
        ok("I2 the check stays closed with a zero balance after the adjustment",
           chk6["status"] == "closed" and chk6["totals"]["balance"] == 0, str(chk6["totals"]))
        t_after, po_after = tipout_tips(), payout_tips()
        ok("I3 the tip-out report moves by exactly the +250 delta",
           t_before is not None and t_after == t_before + 250, f"{t_before} -> {t_after}")
        ok("I4 finance payouts tips move by exactly the +250 delta",
           po_before is not None and po_after == po_before + 250, f"{po_before} -> {po_after}")

        print("== J: principal immutability under a smuggling body ==")
        s, r = req("PATCH", f"/api/payments/{p1['id']}/tip",
                   {"tip_cents": 700, "amount_cents": 1, "tendered_cents": 0,
                    "status": "refunded", "refunded_cents": 999, "method": "cash"}, token=mtok)
        ok("J1 the smuggling PATCH itself succeeds on the tip alone", s == 200, f"{s} {str(r)[:120]}")
        row = next(x for x in get_check(stok, cid)["payments"] if x["id"] == p1["id"])
        ok("J2 only the tip changed — amount, status, refunded, method untouched",
           row["tip_cents"] == 700 and row["amount_cents"] == 1000
           and row["status"] == "completed" and row["refunded_cents"] == 0
           and row["method"] == "card_demo", str(row))

        print("== K: the audit rows ==")
        s, audit = req("GET", "/api/admin/approvals/audit?limit=200", token=mtok)
        rows = [x for x in audit if x.get("action") == "adjust_tip"
                and (json.loads(x.get("details") or "{}").get("payment_id") == p1["id"])]
        ok("K1 every real change on the happy-path payment wrote an adjust_tip row",
           len(rows) == 4, f"rows={len(rows)}")  # 500->800, 800->150, 150->900 (PIN), 900->700 (smuggle)
        pin_row = next((x for x in rows
                        if json.loads(x.get("before_json") or "{}").get("tip_cents") == 150
                        and json.loads(x.get("after_json") or "{}").get("tip_cents") == 900), None)
        ok("K2 the PIN-form row carries before/after tips in the audit idiom",
           bool(pin_row), str(rows)[:200])
        ok("K3 the PIN-form row names actor=server, approver=manager, check id set",
           bool(pin_row) and pin_row.get("actor") == suser.get("name")
           and pin_row.get("approver") == muser.get("name")
           and pin_row.get("check_id") == cid, str(pin_row)[:200])
        role_row = next((x for x in rows
                         if json.loads(x.get("before_json") or "{}").get("tip_cents") == 500), None)
        ok("K4 the role-form row names the manager as actor and approver",
           bool(role_row) and role_row.get("actor") == muser.get("name")
           and role_row.get("approver") == muser.get("name"), str(role_row)[:200])

        print("== L: replay is a safe no-op ==")
        s, audit = req("GET", "/api/admin/approvals/audit?limit=200", token=mtok)
        n_before = len([x for x in audit if x.get("action") == "adjust_tip"
                        and (json.loads(x.get("details") or "{}").get("payment_id") == p1["id"])])
        s, r = req("PATCH", f"/api/payments/{p1['id']}/tip", {"tip_cents": 700}, token=mtok)
        ok("L1 the identical repeat PATCH is a 200 no-op (unchanged:true)",
           s == 200 and r.get("unchanged") is True
           and (r.get("payment") or {}).get("tip_cents") == 700, f"{s} {str(r)[:140]}")
        s, audit = req("GET", "/api/admin/approvals/audit?limit=200", token=mtok)
        n_after = len([x for x in audit if x.get("action") == "adjust_tip"
                       and (json.loads(x.get("details") or "{}").get("payment_id") == p1["id"])])
        ok("L2 the no-op wrote no second audit row", n_after == n_before, f"{n_before} -> {n_after}")

        print("== M: no tip cap (mirrors POST /payments) ==")
        s, r = req("PATCH", f"/api/payments/{p1['id']}/tip", {"tip_cents": 5000}, token=mtok)
        ok("M1 a tip larger than the principal is accepted, exactly as at payment time",
           s == 200 and (r.get("payment") or {}).get("tip_cents") == 5000, f"{s} {str(r)[:120]}")
    finally:
        stop(srv)

    print(f"\n{passed} passed, {failed} failed")
    if failures:
        print("FAILURES:", "; ".join(failures))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
