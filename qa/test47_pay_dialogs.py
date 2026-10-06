#!/usr/bin/env python3
"""test47_pay_dialogs.py — the staff Pay-screen dialog outage
(2026-10-06 diagnosis) and the split-tender helpers that fix it.

What is pinned here:

  G  The durable class guard: qa/scan_undefined_calls.js over ALL
     shipped client JS (public/*.js + public/views/*.js) reports
     zero called-but-undefined names. At b517273 it flags exactly
     splitTenderFields and readSplitTender at their 6 call sites —
     the scan's discriminating control, run by hand against a
     scratch worktree when this suite was written (see the fix
     report); this section is the at-HEAD gate that keeps the
     class from ever shipping again.
  H  The click path itself: qa/harness47_client.js extracts the
     REAL splitTenderFields / readSplitTender / recordPayment and
     the REAL #pay-cash / #pay-card / #pay-house handlers out of
     public/app.js and drives them against the modal DOM shim —
     dialogs open without throwing, prefills and the validation
     matrix hold, and cash/card/house drives post exactly the
     {method, amount_cents, tip_cents, ...} the server must see.
     At b517273 every handler fails there with
     "ReferenceError: splitTenderFields is not defined".
  S  Client/server agreement: readSplitTender mirrors
     POST /api/checks/:id/payments (server.js) — this section pins
     the server side of that contract so a future server change
     breaks THIS suite instead of silently desyncing the dialog:
     amount must be a positive integer, tip a non-negative integer
     with no cap, card/house amounts may not exceed the balance,
     partial payments reduce the balance by the principal only
     (tips ride on top), cash change = tendered - amount - tip,
     and the one server exception the client deliberately does NOT
     use: cash amount > balance WITH an explicit tendered is
     clamped to the balance server-side (the dialog caps the
     principal at the balance and expresses over-tender through
     the Tendered field instead, so its change math stays exact).

Boot pattern mirrors test46 (plain node on :4373).
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

ROOT = Path(__file__).resolve().parent.parent
HERE = Path(__file__).resolve().parent
PORT = 4373
DB = "/tmp/expoline-test47.db"
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


def open_table_check(tok):
    t = free_table(tok)
    s, c = req("POST", "/api/checks", {"table_id": t["id"], "guest_count": 2},
               token=tok)
    assert s == 201, (s, c)
    return c["id"]


def balance_of(tok, cid):
    s, c = req("GET", f"/api/checks/{cid}", token=tok)
    tot = c.get("totals") or {}
    if tot.get("balance") is not None:
        return tot["balance"]
    return c.get("balance_cents")


def rung_check(tok, item_id):
    cid = open_table_check(tok)
    s, c = req("POST", f"/api/checks/{cid}/items",
               {"menu_item_id": item_id, "seat": 1, "qty": 1, "modifiers": []},
               token=tok)
    assert s == 201, (s, c)
    s, c = req("POST", f"/api/checks/{cid}/send", {}, token=tok)
    assert s in (200, 201), (s, c)
    return cid


def main():
    print("== G: the called-but-undefined guard over all shipped client JS ==")
    r = subprocess.run(["node", str(HERE / "scan_undefined_calls.js")],
                       capture_output=True, text=True, timeout=120)
    print("  " + "\n  ".join((r.stdout or "").strip().split("\n")))
    ok("G1 scan exits clean at HEAD", r.returncode == 0,
       f"exit={r.returncode} {(r.stderr or '')[:200]}")
    ok("G2 scan covers the whole bundle (19 files) and names no undefined callee",
       "19 shipped client JS files" in r.stdout and "CLEAN" in r.stdout,
       (r.stdout or "")[:200])

    print("\n== H: harness47 — the real handlers, clicked ==")
    r = subprocess.run(["node", str(HERE / "harness47_client.js")],
                       capture_output=True, text=True, timeout=120)
    tail = "\n".join((r.stdout or "").strip().split("\n")[-6:])
    print("  " + tail.replace("\n", "\n  "))
    ok("H1 harness exits clean", r.returncode == 0,
       f"exit={r.returncode} {(r.stderr or '')[:200]}")
    oks = (r.stdout or "").count("  ok  ")
    ok(f"H2 harness sub-checks all pass ({oks} ok lines, incl. the three handler drives)",
       "ALL HARNESS CHECKS PASS" in r.stdout and oks >= 45, f"oks={oks}")

    print("\n== S: server payment rules — the contract readSplitTender mirrors ==")
    for suffix in ("", "-journal", "-wal", "-shm"):
        try:
            os.unlink(DB + suffix)
        except FileNotFoundError:
            pass
    srv = boot(PORT, DB)
    try:
        tok = login(SERVER_PIN)
        mtok = login(MANAGER_PIN)
        mai_tai = menu_items(tok)["BH Mai Tai"]

        cid = rung_check(tok, mai_tai["id"])
        bal = balance_of(tok, cid)
        ok("S0 the rung check carries a payable balance", isinstance(bal, int) and bal > 500,
           f"balance={bal}")

        s, r = req("POST", f"/api/checks/{cid}/payments",
                   {"method": "card_demo", "amount_cents": 0, "tip_cents": 0}, token=tok)
        ok("S1 amount_cents 0 is a 400 (client: principal must be > 0)",
           s == 400 and "positive integer" in (r.get("error") or ""), f"{s} {r.get('error')}")
        s, r = req("POST", f"/api/checks/{cid}/payments",
                   {"method": "card_demo", "amount_cents": 10.5, "tip_cents": 0}, token=tok)
        ok("S2 a fractional amount_cents is a 400 (client: integer cents only)",
           s == 400, f"{s} {r.get('error')}")
        s, r = req("POST", f"/api/checks/{cid}/payments",
                   {"method": "card_demo", "amount_cents": 100, "tip_cents": -1}, token=tok)
        ok("S3 a negative tip_cents is a 400 (client: tip must be >= 0)",
           s == 400 and "non-negative integer" in (r.get("error") or ""), f"{s} {r.get('error')}")
        s, r = req("POST", f"/api/checks/{cid}/payments",
                   {"method": "card_demo", "amount_cents": bal + 1, "tip_cents": 0}, token=tok)
        ok("S4 a card amount above the balance is a 400 (client caps principal at balance)",
           s == 400 and "exceeds the remaining balance" in (r.get("error") or ""),
           f"{s} {r.get('error')}")
        s, r = req("POST", f"/api/checks/{cid}/payments",
                   {"method": "card", "amount_cents": 100, "tip_cents": 0}, token=tok)
        ok("S5 an unknown method is a 400 (the dialogs only send cash/card_demo/house_account)",
           s == 400, f"{s} {r.get('error')}")

        s, r = req("POST", f"/api/checks/{cid}/payments",
                   {"method": "card_demo", "amount_cents": 500, "tip_cents": 200}, token=tok)
        pay = r.get("payment") or {}
        ok("S6 a partial card payment lands with principal/tip stored verbatim",
           s == 201 and pay.get("amount_cents") == 500 and pay.get("tip_cents") == 200,
           f"{s} {str(r)[:160]}")
        ok("S7 the balance falls by the principal only — the tip rides on top",
           balance_of(tok, cid) == bal - 500, f"balance={balance_of(tok, cid)} want={bal - 500}")

        rem = bal - 500
        s, r = req("POST", f"/api/checks/{cid}/payments",
                   {"method": "cash", "amount_cents": rem, "tip_cents": 100,
                    "tendered_cents": rem + 100 + 500}, token=tok)
        ok("S8 cash full payment: change = tendered - principal - tip (500 back)",
           s == 201 and r.get("change_cents") == 500, f"{s} {str(r)[:160]}")
        ok("S9 the check is paid off (balance 0)", balance_of(tok, cid) == 0,
           f"balance={balance_of(tok, cid)}")
        s, r = req("POST", f"/api/checks/{cid}/payments",
                   {"method": "cash", "amount_cents": 100, "tip_cents": 0,
                    "tendered_cents": 100}, token=tok)
        ok("S10 paying a paid check is a 400 (status guard fires first; the dialogs "
           "never see balance 0)",
           s == 400 and "Cannot take payment on a paid check" in (r.get("error") or ""),
           f"{s} {r.get('error')}")

        cid2 = rung_check(tok, mai_tai["id"])
        bal2 = balance_of(tok, cid2)
        s, r = req("POST", f"/api/checks/{cid2}/payments",
                   {"method": "cash", "amount_cents": bal2 + 5000, "tip_cents": 0,
                    "tendered_cents": bal2 + 5000}, token=tok)
        pay = r.get("payment") or {}
        ok("S11 server exception, documented: cash over-amount WITH tendered clamps to the "
           "balance (the dialog avoids this path by capping principal at the balance)",
           s == 201 and pay.get("amount_cents") == bal2,
           f"{s} applied={pay.get('amount_cents')} balance={bal2}")
        ok("S12 the clamped cash payment still reports exact change (5000)",
           r.get("change_cents") == 5000, f"change={r.get('change_cents')}")

        s, r = req("POST", "/api/admin/house-accounts", {"name": "Test House 47"},
                   token=mtok)
        ok("S13 a manager can create the house account the dialog will charge",
           s in (200, 201), f"{s} {str(r)[:120]}")
        cid3 = rung_check(tok, mai_tai["id"])
        bal3 = balance_of(tok, cid3)
        s, r = req("POST", f"/api/checks/{cid3}/payments",
                   {"method": "house_account", "amount_cents": 100, "tip_cents": 0},
                   token=tok)
        ok("S14 house_account without a memo (account name) is a 400 — the dialog requires the name",
           s == 400 and "memo" in (r.get("error") or ""), f"{s} {r.get('error')}")
        s, r = req("POST", f"/api/checks/{cid3}/payments",
                   {"method": "house_account", "amount_cents": 100, "tip_cents": 0,
                    "memo": "No Such Account 47"}, token=tok)
        ok("S15 house_account naming an unknown account is a 400 (manager-created only)",
           s == 400 and "Unknown or inactive" in (r.get("error") or ""), f"{s} {r.get('error')}")
        s, r = req("POST", f"/api/checks/{cid3}/payments",
                   {"method": "house_account", "amount_cents": bal3, "tip_cents": 150,
                    "memo": "Test House 47"}, token=tok)
        pay = r.get("payment") or {}
        ok("S16 the named-account charge lands in full with the memo as the ledger name",
           s == 201 and pay.get("amount_cents") == bal3 and pay.get("tip_cents") == 150
           and pay.get("memo") == "Test House 47", f"{s} {str(r)[:160]}")
    finally:
        stop(srv)

    print(f"\n{passed} passed, {failed} failed")
    if failures:
        print("FAILURES:", "; ".join(failures))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
