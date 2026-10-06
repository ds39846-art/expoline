#!/usr/bin/env python3
"""test49_discount_library.py — discount library (audit gap #4).

What is pinned here:

  H  The client half: qa/harness49_client.js extracts the REAL
     discountValueLabel / discountSavingsCents / discountsForScope
     from public/app.js — the label reads like staff say it, the
     savings preview mirrors the server rounding (Math.round on the
     base) and clamps at the base, and the scope filter keeps
     inactive definitions out of the picker. Static asserts pin the
     picker / strip / settings / pay wiring.
  A  Definition CRUD under the manager gate: create percent + fixed,
     the full validation matrix (name, kind, percent, fixed cents,
     scope, boolean flags), non-managers refused, the floor list
     serving active definitions to server+ only.
  B  PUT merge semantics (absent keeps, kind switch revalidates),
     deactivation hiding a definition from the floor list, DELETE of
     a never-applied definition.
  C  Check-scope percent math: applied = Math.round(subtotal * pct)
     on the net subtotal (the comp base), the amount lands on the
     comp accumulator, the total drops by exactly the amount, and
     tax does NOT move — comps reduce the total after tax, the
     inherited treatment, not a new rule.
  D  Stacking: a second check-scope library discount is a 400 naming
     the incumbent; ad-hoc comps still stack on top (existing
     behavior); the cumulative subtotal guard refuses a fixed
     discount larger than the subtotal and accepts one equal to it.
  E  The approval gate: an approval-flagged definition refuses
     without a PIN and with a wrong PIN (403 + need_manager_pin,
     failed attempts audit-logged), a manager SESSION without a PIN
     is also refused (the comp idiom: the PIN is always fresh), and
     a good PIN applies with a discount_apply audit row whose actor
     is the server and approver is the manager.
  F  Item scope: percent on a held line writes discount_cents +
     the name as discount_reason (the existing slot), totals move
     through item_discount_cents, the line slot conflicts both ways
     (library over ad-hoc, ad-hoc over library, library over
     library), an oversized fixed discount is refused, and the
     scope-mismatch matrix (check def with an item, item def
     without one, item from another check, unknown discount).
  G  A fired line needs the PIN even for an unflagged definition —
     the ad-hoc item-discount rule for sent lines, mirrored.
  R  Removal restores the pre-discount totals BYTE-EQUAL against an
     identical never-discounted control check (check scope and item
     scope), an approval application needs the PIN to come off, a
     second removal is refused, and discount_remove is audited.
  S  Snapshots: renaming + repricing + deactivating a definition
     after application leaves the live check untouched (name,
     amount, totals), the deactivated definition cannot be newly
     applied, and a definition with history cannot be deleted.
  P  The paid-check rule, inherited from comps: no applying to a
     closed check, no removing on a closed check.
  K  Rounding: a true half-cent case (gross * 15% lands on .5)
     rounds UP, the house Math.round idiom.
  L  Splits refuse while a library item discount is live (its
     removal reverses an exact amount; ad-hoc proration would
     orphan the snapshot), and succeed once it is removed.
  M  A 100% check discount leaves exactly surcharge + service
     charge + tax owing (the comp shape), never a negative total;
     a definition that computes to zero on a small check is a 400,
     never a silent zero application.

Discriminating control at 8034993: GET /api/admin/discounts and
POST /api/checks/:id/discounts are 404s, GET /api/checks/:id has no
library_discounts key, and harness49 cannot extract any helper —
sections H, A–M fail there while nothing pre-existing is touched.

Boot pattern mirrors test48 (plain node on :4377).
"""
import json
import math
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
PORT = 4377
DB = "/tmp/expoline-test49.db"
BASE = f"http://127.0.0.1:{PORT}"
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


def jsround(x):
    """JS Math.round for non-negative values (round half up)."""
    return math.floor(x + 0.5)


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


def build_check(tok, lines, send=False):
    """lines: [(menu_item_id, qty), ...] at seat 1. Returns check id."""
    t = free_table(tok)
    s, c = req("POST", "/api/checks", {"table_id": t["id"], "guest_count": 2}, token=tok)
    assert s == 201, (s, c)
    cid = c["id"]
    for item_id, qty in lines:
        s, r = req("POST", f"/api/checks/{cid}/items",
                   {"menu_item_id": item_id, "seat": 1, "qty": qty, "modifiers": []}, token=tok)
        assert s == 201, (s, r)
    if send:
        s, r = req("POST", f"/api/checks/{cid}/send", {}, token=tok)
        assert s in (200, 201), (s, r)
    return cid


def get_check(tok, cid):
    s, c = req("GET", f"/api/checks/{cid}", token=tok)
    assert s == 200, (s, c)
    return c


TOT_KEYS = ("subtotal", "surcharge", "service_charge", "tax", "comp", "total", "paid", "balance")


def totals_of(chk):
    return {k: chk["totals"][k] for k in TOT_KEYS}


def audit_rows(mtok, limit=200):
    s, rows = req("GET", f"/api/admin/approvals/audit?limit={limit}", token=mtok)
    assert s == 200, (s, rows)
    return rows if isinstance(rows, list) else rows.get("rows", [])


def details_of(row):
    d = row.get("details")
    if isinstance(d, str):
        try:
            return json.loads(d)
        except Exception:
            return {}
    return d or {}


def mkdef(mtok, body):
    s, r = req("POST", "/api/admin/discounts", body, token=mtok)
    assert s == 201, (s, r)
    return r


def apply_disc(tok, cid, body):
    return req("POST", f"/api/checks/{cid}/discounts", body, token=tok)


def remove_disc(tok, cid, app_id, body=None):
    return req("POST", f"/api/checks/{cid}/discounts/{app_id}/remove", body or {}, token=tok)


def main():
    print("== H: harness49 — the real client helpers ==")
    r = subprocess.run(["node", str(HERE / "harness49_client.js")],
                       capture_output=True, text=True, timeout=120)
    print("  " + "\n  ".join((r.stdout or "").strip().split("\n")))
    oks = (r.stdout or "").count("  ok  ")
    ok("H1 harness exits clean", r.returncode == 0, f"exit={r.returncode} {(r.stderr or '')[:200]}")
    ok(f"H2 harness sub-checks all pass ({oks} ok lines)", r.returncode == 0 and oks >= 35, f"oks={oks}")

    if os.path.exists(DB):
        os.remove(DB)
    srv = boot(PORT, DB)
    try:
        stok, suser = login(SERVER_PIN)
        mtok, muser = login(MANAGER_PIN)
        ktok, _ = login(KITCHEN_PIN)
        sname, mname = suser.get("name"), muser.get("name")
        items = menu_items(stok)
        plain = [it for it in items.values()
                 if it.get("price_cents", 0) > 0 and not it.get("modifier_groups")]
        plain.sort(key=lambda it: it["price_cents"])
        cheap = plain[0]
        fat = next(it for it in plain if it["price_cents"] >= 2000)

        print("== A: definition CRUD + validation ==")
        s, d_pct = req("POST", "/api/admin/discounts",
                       {"name": "Military", "kind": "percent", "percent": 10, "scope": "check"}, token=mtok)
        ok("A1 manager creates a percent check definition",
           s == 201 and d_pct.get("percent") == 10 and d_pct.get("amount_cents") is None
           and d_pct.get("scope") == "check" and d_pct.get("active") is True
           and d_pct.get("requires_approval") is False, f"{s} {str(d_pct)[:160]}")
        s, d_fix = req("POST", "/api/admin/discounts",
                       {"name": "Appy five", "kind": "fixed", "amount_cents": 500, "scope": "item"}, token=mtok)
        ok("A2 manager creates a fixed item definition",
           s == 201 and d_fix.get("amount_cents") == 500 and d_fix.get("percent") is None
           and d_fix.get("scope") == "item", f"{s} {str(d_fix)[:160]}")
        s, r = req("POST", "/api/admin/discounts",
                   {"name": "Nope", "kind": "percent", "percent": 5, "scope": "check"}, token=stok)
        ok("A3 a server cannot create definitions (403)", s == 403, f"{s}")
        s, r = req("GET", "/api/admin/discounts", token=ktok)
        ok("A4 kitchen cannot read the admin list (403)", s == 403, f"{s}")
        s, r = req("GET", "/api/discounts", token=ktok)
        ok("A5 kitchen cannot read the floor list either (403)", s == 403, f"{s}")
        bad_cases = [
            ("A6 a missing name is a 400", {"kind": "percent", "percent": 5, "scope": "check"}),
            ("A7 a 41-char name is a 400", {"name": "x" * 41, "kind": "percent", "percent": 5, "scope": "check"}),
            ("A8 a bogus kind is a 400", {"name": "B", "kind": "bogus", "percent": 5, "scope": "check"}),
            ("A9 percent 0 is a 400", {"name": "B", "kind": "percent", "percent": 0, "scope": "check"}),
            ("A10 percent 101 is a 400", {"name": "B", "kind": "percent", "percent": 101, "scope": "check"}),
            ("A11 a string percent is a 400", {"name": "B", "kind": "percent", "percent": "10", "scope": "check"}),
            ("A12 fixed 0 cents is a 400", {"name": "B", "kind": "fixed", "amount_cents": 0, "scope": "check"}),
            ("A13 fixed fractional cents is a 400", {"name": "B", "kind": "fixed", "amount_cents": 1050.5, "scope": "check"}),
            ("A14 a bogus scope is a 400", {"name": "B", "kind": "percent", "percent": 5, "scope": "both"}),
            ("A15 a string requires_approval is a 400", {"name": "B", "kind": "percent", "percent": 5, "scope": "check", "requires_approval": "yes"}),
        ]
        for name, body in bad_cases:
            s, r = req("POST", "/api/admin/discounts", body, token=mtok)
            ok(name, s == 400, f"{s} {str(r)[:100]}")
        s, d_both = req("POST", "/api/admin/discounts",
                        {"name": "Both fields", "kind": "percent", "percent": 12, "amount_cents": 500, "scope": "check"}, token=mtok)
        ok("A16 kind wins: a percent definition stores no fixed amount",
           s == 201 and d_both.get("amount_cents") is None and d_both.get("percent") == 12, f"{s} {str(d_both)[:140]}")
        s, floor = req("GET", "/api/discounts", token=stok)
        ok("A17 the floor list serves the active definitions to a server",
           s == 200 and {d["id"] for d in floor} >= {d_pct["id"], d_fix["id"]}, f"{s} {str(floor)[:120]}")

        print("== B: PUT merge + deactivate + DELETE ==")
        s, r = req("PUT", f"/api/admin/discounts/{d_both['id']}", {"name": "Renamed", "percent": 15}, token=mtok)
        ok("B1 PUT renames and reprices, keeping the rest",
           s == 200 and r.get("name") == "Renamed" and r.get("percent") == 15
           and r.get("scope") == "check" and r.get("kind") == "percent", f"{s} {str(r)[:140]}")
        s, r = req("PUT", "/api/admin/discounts/999999", {"name": "Ghost"}, token=mtok)
        ok("B2 PUT on an unknown id is a 404", s == 404, f"{s}")
        s, r = req("PUT", f"/api/admin/discounts/{d_both['id']}", {"percent": 200}, token=mtok)
        ok("B3 PUT revalidates the merged row (percent 200 is a 400)", s == 400, f"{s}")
        s, r = req("PUT", f"/api/admin/discounts/{d_both['id']}", {"kind": "fixed", "amount_cents": 700}, token=mtok)
        ok("B4 a kind switch revalidates and clears the old value",
           s == 200 and r.get("kind") == "fixed" and r.get("amount_cents") == 700 and r.get("percent") is None,
           f"{s} {str(r)[:140]}")
        s, r = req("PUT", f"/api/admin/discounts/{d_both['id']}", {"active": False}, token=mtok)
        s2, floor = req("GET", "/api/discounts", token=stok)
        s3, admin = req("GET", "/api/admin/discounts", token=mtok)
        ok("B5 deactivation hides the definition from the floor but not the admin list",
           s == 200 and all(d["id"] != d_both["id"] for d in floor)
           and any(d["id"] == d_both["id"] and d["active"] is False for d in admin), f"{s} {s2} {s3}")
        s, r = req("DELETE", f"/api/admin/discounts/{d_both['id']}", token=mtok)
        s2, admin = req("GET", "/api/admin/discounts", token=mtok)
        ok("B6 a never-applied definition deletes cleanly",
           s == 200 and r.get("deleted") == d_both["id"]
           and all(d["id"] != d_both["id"] for d in admin), f"{s} {str(r)[:100]}")
        s, r = req("DELETE", "/api/admin/discounts/999999", token=mtok)
        ok("B7 DELETE on an unknown id is a 404", s == 404, f"{s}")

        print("== C: check-scope percent math + inherited tax treatment ==")
        cid = build_check(stok, [(fat["id"], 2)])
        chk0 = get_check(stok, cid)
        t0 = totals_of(chk0)
        want = jsround(t0["subtotal"] * 10 / 100)
        s, r = apply_disc(stok, cid, {"discount_id": d_pct["id"]})
        app = r.get("application") or {}
        ok("C1 a percent check discount applies at Math.round(subtotal * pct)",
           s == 201 and app.get("applied_cents") == want and app.get("name") == "Military"
           and app.get("scope") == "check" and app.get("item_id") is None, f"{s} {str(r)[:180]}")
        chk1 = get_check(stok, cid)
        t1 = totals_of(chk1)
        ok("C2 the amount lands on the comp accumulator and the total drops by exactly it",
           t1["comp"] == want and t1["total"] == t0["total"] - want and t1["balance"] == t0["balance"] - want,
           f"{t0} -> {t1}")
        ok("C3 tax does not move (comps reduce the total after tax — the inherited rule)",
           t1["tax"] == t0["tax"] and t1["subtotal"] == t0["subtotal"], f"{t0} -> {t1}")
        apps = chk1.get("library_discounts")
        ok("C4 the check payload carries the live application with its snapshot",
           isinstance(apps, list) and len(apps) == 1 and apps[0]["id"] == app["id"]
           and apps[0]["name"] == "Military" and apps[0]["applied_cents"] == want, str(apps))

        print("== D: stacking, the cumulative guard, fixed check discounts ==")
        d_fix_check = mkdef(mtok, {"name": "Ten bucks", "kind": "fixed", "amount_cents": 1000, "scope": "check"})
        s, r = apply_disc(stok, cid, {"discount_id": d_fix_check["id"]})
        ok("D1 a second check-scope library discount is a 400 naming the incumbent",
           s == 400 and "Military" in (r.get("error") or ""), f"{s} {str(r)[:140]}")
        s, r = req("POST", f"/api/checks/{cid}/comp",
                   {"percent": 5, "manager_pin": MANAGER_PIN, "reason": "still stacks"}, token=stok)
        chk2 = get_check(stok, cid)
        ok("D2 ad-hoc comps still stack on the same accumulator (existing behavior)",
           s == 200 and chk2["totals"]["comp"] == want + jsround(t0["subtotal"] * 5 / 100),
           f"{s} comp={chk2['totals']['comp']}")
        cid_big = build_check(stok, [(cheap["id"], 1)])
        sub_big = get_check(stok, cid_big)["totals"]["subtotal"]
        d_huge = mkdef(mtok, {"name": "Huge", "kind": "fixed", "amount_cents": sub_big + 1, "scope": "check"})
        s, r = apply_disc(stok, cid_big, {"discount_id": d_huge["id"]})
        ok("D3 a fixed discount larger than the subtotal is refused (cumulative guard)",
           s == 400 and "exceeds" in (r.get("error") or ""), f"{s} {str(r)[:140]}")
        d_exact = mkdef(mtok, {"name": "Exact", "kind": "fixed", "amount_cents": sub_big, "scope": "check"})
        s, r = apply_disc(stok, cid_big, {"discount_id": d_exact["id"]})
        t_ex = totals_of(get_check(stok, cid_big))
        ok("D4 a fixed discount equal to the subtotal applies; surcharge + tax remain owing",
           s == 201 and t_ex["comp"] == sub_big
           and t_ex["total"] == t_ex["surcharge"] + t_ex["service_charge"] + t_ex["tax"] and t_ex["total"] >= 0,
           f"{s} {t_ex}")

        print("== E: the approval gate ==")
        d_appr = mkdef(mtok, {"name": "Big comp", "kind": "percent", "percent": 50,
                              "scope": "check", "requires_approval": True})
        cid_e = build_check(stok, [(fat["id"], 1)])
        fails0 = sum(1 for a in audit_rows(mtok) if a["action"] == "auth_manager_pin_failed")
        s, r = apply_disc(stok, cid_e, {"discount_id": d_appr["id"]})
        ok("E1 an approval definition without a PIN is a 403 with need_manager_pin",
           s == 403 and r.get("need_manager_pin") is True, f"{s} {str(r)[:120]}")
        s, r = apply_disc(stok, cid_e, {"discount_id": d_appr["id"], "manager_pin": "9999"})
        ok("E2 a wrong PIN is a 403 with need_manager_pin",
           s == 403 and r.get("need_manager_pin") is True, f"{s} {str(r)[:120]}")
        s, r = apply_disc(mtok, cid_e, {"discount_id": d_appr["id"]})
        ok("E3 even a manager session needs the fresh PIN (the comp idiom)",
           s == 403 and r.get("need_manager_pin") is True, f"{s} {str(r)[:120]}")
        fails1 = sum(1 for a in audit_rows(mtok) if a["action"] == "auth_manager_pin_failed")
        ok("E4 failed PIN attempts are audit-logged (audit-only, no lockout)",
           fails1 >= fails0 + 3, f"{fails0} -> {fails1}")
        s, r = apply_disc(stok, cid_e, {"discount_id": d_appr["id"], "manager_pin": MANAGER_PIN})
        app_e = r.get("application") or {}
        ok("E5 a good PIN applies the approval discount",
           s == 201 and app_e.get("applied_cents") == jsround(get_check(stok, cid_e)["totals"]["subtotal"] * 50 / 100),
           f"{s} {str(r)[:160]}")
        rows = [a for a in audit_rows(mtok) if a["action"] == "discount_apply"
                and details_of(a).get("discount_id") == d_appr["id"]]
        det = details_of(rows[0]) if rows else {}
        ok("E6 the discount_apply audit row separates actor (server) from approver (manager)",
           bool(rows) and rows[0].get("actor") == sname and rows[0].get("approver") == mname
           and det.get("applied_cents") == app_e.get("applied_cents")
           and (det.get("before") or {}).get("comp_cents") == 0
           and (det.get("after") or {}).get("comp_cents") == app_e.get("applied_cents"),
           f"{str(rows[:1])[:220]}")

        print("== F: item scope — the existing line slot, both-way conflicts ==")
        d_item_pct = mkdef(mtok, {"name": "Line 20", "kind": "percent", "percent": 20, "scope": "item"})
        cid_f = build_check(stok, [(fat["id"], 2)])
        chk_f0 = get_check(stok, cid_f)
        line = chk_f0["items"][0]
        gross = fat["price_cents"] * 2
        want_i = jsround(gross * 20 / 100)
        s, r = apply_disc(stok, cid_f, {"discount_id": d_item_pct["id"], "item_id": line["id"]})
        ok("F1 a percent item discount applies at Math.round(line gross * pct)",
           s == 201 and (r.get("application") or {}).get("applied_cents") == want_i, f"{s} {str(r)[:160]}")
        chk_f1 = get_check(stok, cid_f)
        line1 = next(i for i in chk_f1["items"] if i["id"] == line["id"])
        ok("F2 the line slot carries the amount and the name snapshot as its reason",
           line1.get("discount_cents") == want_i and line1.get("discount_reason") == "Line 20", str(line1)[:160])
        ok("F3 totals flow through item_discount_cents and the subtotal drops",
           chk_f1.get("item_discount_cents") == want_i
           and chk_f1["totals"]["subtotal"] == chk_f0["totals"]["subtotal"] - want_i
           and chk_f1["totals"]["tax"] < chk_f0["totals"]["tax"], f"{chk_f0['totals']} -> {chk_f1['totals']}")
        s, r = apply_disc(stok, cid_f, {"discount_id": d_fix["id"], "item_id": line["id"]})
        ok("F4 a second library discount on the same line is a 400 naming the incumbent",
           s == 400 and "Line 20" in (r.get("error") or ""), f"{s} {str(r)[:140]}")
        s, r = req("POST", f"/api/checks/{cid_f}/items/{line['id']}/discount",
                   {"amount_cents": 100, "reason": "ad-hoc"}, token=stok)
        ok("F5 an ad-hoc discount over a library discount is a 400 naming it",
           s == 400 and "Line 20" in (r.get("error") or ""), f"{s} {str(r)[:140]}")
        cid_f2 = build_check(stok, [(fat["id"], 1)])
        line2 = get_check(stok, cid_f2)["items"][0]
        s, r = req("POST", f"/api/checks/{cid_f2}/items/{line2['id']}/discount",
                   {"amount_cents": 100, "reason": "ad-hoc first"}, token=stok)
        assert s == 200, (s, r)
        s, r = apply_disc(stok, cid_f2, {"discount_id": d_item_pct["id"], "item_id": line2["id"]})
        ok("F6 a library discount over an ad-hoc discount is a 400 (the slot is taken)",
           s == 400 and "already has a discount" in (r.get("error") or ""), f"{s} {str(r)[:140]}")
        d_over = mkdef(mtok, {"name": "Over", "kind": "fixed", "amount_cents": fat["price_cents"] + 1, "scope": "item"})
        cid_f3 = build_check(stok, [(fat["id"], 1)])
        line3 = get_check(stok, cid_f3)["items"][0]
        s, r = apply_disc(stok, cid_f3, {"discount_id": d_over["id"], "item_id": line3["id"]})
        ok("F7 a fixed item discount larger than the (clean) line value is a 400 naming the excess",
           s == 400 and "exceeds the line value" in (r.get("error") or ""), f"{s} {str(r)[:140]}")
        s, r = apply_disc(stok, cid_f2, {"discount_id": d_pct["id"], "item_id": line2["id"]})
        ok("F8 a check-scope definition sent an item_id is a 400",
           s == 400 and "check-level" in (r.get("error") or ""), f"{s} {str(r)[:140]}")
        s, r = apply_disc(stok, cid_f2, {"discount_id": d_item_pct["id"]})
        ok("F9 an item-scope definition without an item_id is a 400",
           s == 400 and "item_id is required" in (r.get("error") or ""), f"{s} {str(r)[:140]}")
        s, r = apply_disc(stok, cid_f2, {"discount_id": d_item_pct["id"], "item_id": line["id"]})
        ok("F10 an item from another check is a 404", s == 404, f"{s} {str(r)[:120]}")
        s, r = apply_disc(stok, cid_f2, {"discount_id": 999999})
        ok("F11 an unknown discount_id is a 404", s == 404, f"{s} {str(r)[:120]}")

        print("== G: fired lines need the PIN (the ad-hoc rule, mirrored) ==")
        cid_g = build_check(stok, [(fat["id"], 1)], send=True)
        line_g = get_check(stok, cid_g)["items"][0]
        ok("G0 the line really fired", line_g.get("state") in ("sent", "fulfilled"), str(line_g.get("state")))
        s, r = apply_disc(stok, cid_g, {"discount_id": d_item_pct["id"], "item_id": line_g["id"]})
        ok("G1 an unflagged definition on a fired line still needs a PIN",
           s == 403 and r.get("need_manager_pin") is True, f"{s} {str(r)[:120]}")
        s, r = apply_disc(stok, cid_g, {"discount_id": d_item_pct["id"], "item_id": line_g["id"],
                                        "manager_pin": MANAGER_PIN})
        ok("G2 with the PIN the fired-line discount applies",
           s == 201 and (r.get("application") or {}).get("applied_cents") == jsround(fat["price_cents"] * 20 / 100),
           f"{s} {str(r)[:140]}")

        print("== R: removal restores byte-equal totals ==")
        lines_r = [(fat["id"], 1), (cheap["id"], 2)]
        cid_ctrl = build_check(stok, lines_r)
        cid_r = build_check(stok, lines_r)
        ctrl_totals = totals_of(get_check(stok, cid_ctrl))
        s, r = apply_disc(stok, cid_r, {"discount_id": d_pct["id"]})
        app_r = r["application"]
        mid_totals = totals_of(get_check(stok, cid_r))
        ok("R1 the discounted check really differs from control before removal",
           mid_totals != ctrl_totals and mid_totals["comp"] == app_r["applied_cents"], f"{mid_totals} vs {ctrl_totals}")
        s, r = remove_disc(stok, cid_r, app_r["id"])
        after_totals = totals_of(get_check(stok, cid_r))
        ok("R2 removing a check discount restores byte-equal totals vs the control check",
           s == 200 and after_totals == ctrl_totals, f"{s} {after_totals} vs {ctrl_totals}")
        ok("R3 the removed application leaves the live list",
           get_check(stok, cid_r).get("library_discounts") == [], "")
        s, r = remove_disc(stok, cid_r, app_r["id"])
        ok("R4 removing an already-removed application is a 400", s == 400, f"{s} {str(r)[:100]}")
        line_r = next(i for i in get_check(stok, cid_r)["items"] if i["menu_item_id"] == fat["id"])
        s, r = apply_disc(stok, cid_r, {"discount_id": d_item_pct["id"], "item_id": line_r["id"]})
        app_ri = r["application"]
        s, r = remove_disc(stok, cid_r, app_ri["id"])
        chk_r = get_check(stok, cid_r)
        line_r2 = next(i for i in chk_r["items"] if i["id"] == line_r["id"])
        ok("R5 removing an item discount zeroes the line slot and restores byte-equal totals",
           s == 200 and line_r2.get("discount_cents") == 0 and not line_r2.get("discount_reason")
           and totals_of(chk_r) == ctrl_totals, f"{s} {str(line_r2)[:120]} {totals_of(chk_r)} vs {ctrl_totals}")
        s, r = remove_disc(stok, cid_e, app_e["id"])
        ok("R6 removing an approval application without its PIN is a 403",
           s == 403 and r.get("need_manager_pin") is True, f"{s} {str(r)[:120]}")
        s, r = remove_disc(stok, cid_e, app_e["id"], {"manager_pin": MANAGER_PIN})
        rows = [a for a in audit_rows(mtok) if a["action"] == "discount_remove"
                and details_of(a).get("application_id") == app_e["id"]]
        ok("R7 with the PIN it removes, and discount_remove is audit-logged with the approver",
           s == 200 and bool(rows) and rows[0].get("approver") == mname, f"{s} rows={len(rows)}")

        print("== S: snapshots survive definition edits ==")
        cid_s = build_check(stok, [(fat["id"], 1)])
        s, r = apply_disc(stok, cid_s, {"discount_id": d_pct["id"]})
        app_s = r["application"]
        tot_s = totals_of(get_check(stok, cid_s))
        s, r = req("PUT", f"/api/admin/discounts/{d_pct['id']}",
                   {"name": "Military (renamed)", "percent": 25, "active": False}, token=mtok)
        assert s == 200, (s, r)
        chk_s = get_check(stok, cid_s)
        live = (chk_s.get("library_discounts") or [{}])[0]
        ok("S1 the live application keeps its original name and amount after rename/reprice/deactivate",
           live.get("name") == "Military" and live.get("applied_cents") == app_s["applied_cents"]
           and totals_of(chk_s) == tot_s, f"{str(live)[:140]}")
        cid_s2 = build_check(stok, [(fat["id"], 1)])
        s, r = apply_disc(stok, cid_s2, {"discount_id": d_pct["id"]})
        ok("S2 the deactivated definition cannot be newly applied",
           s == 400 and "not active" in (r.get("error") or ""), f"{s} {str(r)[:120]}")
        s, r = req("DELETE", f"/api/admin/discounts/{d_pct['id']}", token=mtok)
        ok("S3 a definition with application history cannot be deleted (deactivate instead)",
           s == 400 and "deactivate" in (r.get("error") or ""), f"{s} {str(r)[:140]}")
        s, r = req("PUT", f"/api/admin/discounts/{d_pct['id']}", {"active": True, "name": "Military", "percent": 10}, token=mtok)
        ok("S4 the definition restores for later sections", s == 200, f"{s}")

        print("== P: the paid-check rule (inherited from comps) ==")
        cid_p = build_check(stok, [(fat["id"], 1)])
        bal = get_check(stok, cid_p)["totals"]["balance"]
        s, r = req("POST", f"/api/checks/{cid_p}/payments",
                   {"method": "cash", "amount_cents": bal, "tendered_cents": bal}, token=stok)
        assert s == 201, (s, r)
        s, r = req("POST", f"/api/checks/{cid_p}/close", {}, token=stok)
        assert s == 200 and get_check(stok, cid_p)["status"] == "closed", (s, r)
        s, r = apply_disc(stok, cid_p, {"discount_id": d_pct["id"]})
        ok("P1 applying to a closed check is a 400", s == 400 and "closed" in (r.get("error") or ""),
           f"{s} {str(r)[:120]}")
        cid_p2 = build_check(stok, [(fat["id"], 1)])
        s, r = apply_disc(stok, cid_p2, {"discount_id": d_pct["id"]})
        app_p2 = r["application"]
        bal = get_check(stok, cid_p2)["totals"]["balance"]
        s, r = req("POST", f"/api/checks/{cid_p2}/payments",
                   {"method": "cash", "amount_cents": bal, "tendered_cents": bal}, token=stok)
        assert s == 201, (s, r)
        s, r = req("POST", f"/api/checks/{cid_p2}/close", {}, token=stok)
        assert s == 200, (s, r)
        s, r = remove_disc(stok, cid_p2, app_p2["id"])
        ok("P2 removing on a closed check is a 400", s == 400 and "closed" in (r.get("error") or ""),
           f"{s} {str(r)[:120]}")

        print("== K: rounding — the true half-cent case rounds up ==")
        combo = None
        for it in plain:
            for q in (1, 2, 3, 4):
                if (it["price_cents"] * q * 15) % 100 == 50:
                    combo = (it, q)
                    break
            if combo:
                break
        ok("K0 a half-cent fixture exists on the seeded menu", combo is not None, "")
        if combo:
            it_k, q_k = combo
            gross_k = it_k["price_cents"] * q_k
            d_15 = mkdef(mtok, {"name": "Fifteen", "kind": "percent", "percent": 15, "scope": "item"})
            cid_k = build_check(stok, [(it_k["id"], q_k)])
            line_k = get_check(stok, cid_k)["items"][0]
            s, r = apply_disc(stok, cid_k, {"discount_id": d_15["id"], "item_id": line_k["id"]})
            ok("K1 gross * 15% landing on .5 rounds UP (Math.round, the house idiom)",
               s == 201 and (r.get("application") or {}).get("applied_cents") == jsround(gross_k * 15 / 100)
               and (gross_k * 15) % 100 == 50, f"{s} {str(r)[:140]} gross={gross_k}")

        print("== L: split guard ==")
        cid_l = build_check(stok, [(fat["id"], 1), (cheap["id"], 1)])
        lines_l = get_check(stok, cid_l)["items"]
        line_l1 = next(i for i in lines_l if i["menu_item_id"] == fat["id"])
        line_l2 = next(i for i in lines_l if i["menu_item_id"] == cheap["id"])
        s, r = apply_disc(stok, cid_l, {"discount_id": d_item_pct["id"], "item_id": line_l1["id"]})
        app_l = r["application"]
        s, r = req("POST", f"/api/checks/{cid_l}/split",
                   {"mode": "move", "item_ids": [line_l2["id"]], "target": "new"}, token=stok)
        ok("L1 splitting with a live library item discount is a 400 naming it",
           s == 400 and "Line 20" in (r.get("error") or ""), f"{s} {str(r)[:140]}")
        s, r = remove_disc(stok, cid_l, app_l["id"])
        assert s == 200, (s, r)
        s, r = req("POST", f"/api/checks/{cid_l}/split",
                   {"mode": "move", "item_ids": [line_l2["id"]], "target": "new"}, token=stok)
        ok("L2 once removed, the same split succeeds", s in (200, 201), f"{s} {str(r)[:120]}")

        print("== M: 100% shape + zero-compute refusal ==")
        d_100 = mkdef(mtok, {"name": "Full ride", "kind": "percent", "percent": 100, "scope": "check"})
        cid_m = build_check(stok, [(fat["id"], 1)])
        sub_m = get_check(stok, cid_m)["totals"]["subtotal"]
        s, r = apply_disc(stok, cid_m, {"discount_id": d_100["id"]})
        t_m = totals_of(get_check(stok, cid_m))
        ok("M1 a 100% check discount takes the whole subtotal and nothing more",
           s == 201 and (r.get("application") or {}).get("applied_cents") == sub_m
           and t_m["total"] == t_m["surcharge"] + t_m["service_charge"] + t_m["tax"] and t_m["total"] >= 0,
           f"{s} {t_m}")
        ok("M2 the balance still equals the (non-negative) total — never negative",
           t_m["balance"] == t_m["total"], str(t_m))
        small = next((it for it in plain if it["price_cents"] < 1000), None)
        ok("M0 a sub-$10 fixture exists for the zero-compute case", small is not None, "")
        if small:
            d_tiny = mkdef(mtok, {"name": "Tiny", "kind": "percent", "percent": 0.05, "scope": "item"})
            cid_m2 = build_check(stok, [(small["id"], 1)])
            line_m2 = get_check(stok, cid_m2)["items"][0]
            s, r = apply_disc(stok, cid_m2, {"discount_id": d_tiny["id"], "item_id": line_m2["id"]})
            ok("M3 a definition computing to zero on the line is a 400, not a silent zero",
               s == 400 and "zero" in (r.get("error") or ""), f"{s} {str(r)[:120]}")

    finally:
        stop(srv)

    print(f"\n{'ALL PASS' if failed == 0 else 'FAILURES'}: {passed} passed, {failed} failed")
    if failures:
        print("failed checks:", failures)
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
