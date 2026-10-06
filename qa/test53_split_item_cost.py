#!/usr/bin/env python3
"""test53_split_item_cost.py — split one shared item's cost across checks
(audit gap #7).

Toast/SpotOn let a server divide ONE indivisible line — the shared
$30 bottle — across several checks. Expoline's split family moved
whole lines or whole quantities only. This batch adds
POST /api/checks/:id/split-item-cost {item_id, targets, shares?,
manager_pin?}:

  - WHAT IS SPLIT: the line's NET total (lineGross − line discount).
    The ad-hoc line discount follows proportionally — the treatment
    the qty-division split gives it (Math.round proration), the last
    target taking the residue — so each share line carries gross_i /
    discount_i with gross_i − discount_i = net_i, Σ gross_i =
    lineGross and Σ discount_i = the line discount, to the cent. A
    live LIBRARY item discount on the line refuses (its snapshot is
    never prorated), mirroring the split family.
  - SHARE LINES are ordinary check_items rows (qty 1) whose unit
    price is the share gross with the source line's modifier deltas
    folded in (modifiers ride for display at 0 delta, per-modifier
    notes and the allergy flag verbatim) — lineGross(share) = gross_i
    and lineTotal(share) = net_i by construction, so calcTotals is
    untouched and every target check taxes its own share.
  - THE SOURCE LINE is consumed the way voids consume a line (state
    'cancelled', provenance appended to its note); each share line's
    note names its fraction and the source check. State rides along:
    held shares stay held; a fired line's shares stay 'sent' with the
    original sent_at — the split creates NO KDS tickets and nothing
    can re-fire (the kitchen made the item once).
  - EVEN SPLIT: floor shares, the first (amount mod n) targets in
    REQUEST ORDER absorb +1¢ (1000 over 3 → 334/333/333). Explicit
    shares must be positive integers summing EXACTLY to the net.
  - GATES mirror POST /split, same order: source open → no
    large-party service charge → no payments on the source → the
    split permission (manager role / split_allowed / manager PIN).
    Targets must exist and be open (a partially-paid target simply
    owes more — the family's move-target rule).
  - TAX DISCLOSURE, pinned in section M: subtotal is conserved to
    the cent, but surcharge/tax are computed per check, so combined
    tax can differ by a rounding cent from the unsplit check. That
    is how every POS (and this codebase's own whole-line splits)
    behaves — the test pins the exact cent rather than hiding it.

Fixtures are all API-built on one scratch server (boot pattern
mirrors test52). Menu anchors: Black Bean Chinese Broccoli 1000¢;
The Cheese Burger 1800¢ with flat modifier Add bacon +300¢.
Site money: surcharge 5%, tax 7.75%, service charge 18% at 8+.

Discriminating control at 7757fde (verified separately): the
endpoint 404s, the quick bar has no Split cost action, and
harness53 cannot extract its helpers.
"""
import json
import math
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
PORT = 4389
DB = "/tmp/expoline-test53.db"
BASE = f"http://127.0.0.1:{PORT}"
SERVER_PIN = "1111"
MANAGER_PIN = "2580"
KITCHEN_PIN = "2222"
NED_PIN = "4444"  # inserted by SQL with split_allowed = 0

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


def rhu(x):
    """JS Math.round for non-negative doubles (identical IEEE ops)."""
    return math.floor(x + 0.5)


def expected_totals(subtotal, guests=2, comp=0):
    surcharge = rhu(subtotal * 0.05)
    service = rhu(subtotal * 0.18) if guests >= 8 else 0
    tax = rhu((subtotal + surcharge + service) * 0.0775)
    total = max(0, subtotal + surcharge + service + tax - comp)
    return {"subtotal": subtotal, "surcharge": surcharge, "service_charge": service,
            "tax": tax, "comp": comp, "total": total}


def totals_match(check, guests=2):
    t = check["totals"]
    e = expected_totals(t["subtotal"], guests=guests, comp=t["comp"])
    return all(t[k] == e[k] for k in ("subtotal", "surcharge", "service_charge", "tax", "total"))


def main():
    print("== H: harness53 — the real client helpers == ")
    r = subprocess.run(["node", str(HERE / "harness53_client.js")],
                       capture_output=True, text=True, timeout=120)
    print("  " + "\n  ".join((r.stdout or "").strip().split("\n")))
    ok("H0 harness53 passes (extraction + matrices + wiring)", r.returncode == 0,
       (r.stdout or "")[-300:] + (r.stderr or "")[-300:])

    if os.path.exists(DB):
        os.remove(DB)
    proc = boot(PORT, DB)
    try:
        tok = login(SERVER_PIN)
        mtok = login(MANAGER_PIN)
        ktok = login(KITCHEN_PIN)

        s, menu = req("GET", "/api/menu?all=1", token=tok)
        if isinstance(menu, list):
            menu = {"categories": menu}
        items = {it["name"]: it for c in menu.get("categories", []) for it in c.get("items", [])}
        broc = items["Black Bean Chinese Broccoli"]
        burger = items["The Cheese Burger"]
        assert broc["price_cents"] == 1000 and burger["price_cents"] == 1800

        table_pool = []

        def free_table():
            if not table_pool:
                s, z = req("GET", "/api/zones", token=tok)
                if isinstance(z, list):
                    z = {"zones": z}
                for zz in z.get("zones", []):
                    for t in zz.get("tables", []):
                        if not t.get("open_check_id"):
                            table_pool.append(t["id"])
            assert table_pool, "ran out of free tables"
            return table_pool.pop(0)

        def mkcheck(guests=2, token=None):
            s, c = req("POST", "/api/checks", {"table_id": free_table(), "guest_count": guests},
                       token=token or tok)
            assert s == 201, (s, c)
            return c["id"]

        def add(cid, mi, qty=1, mods=None, seat=1, token=None):
            s, r = req("POST", f"/api/checks/{cid}/items",
                       {"menu_item_id": mi["id"], "seat": seat, "qty": qty, "modifiers": mods or []},
                       token=token or tok)
            assert s == 201, (s, r)
            return r

        def get(cid, token=None):
            s, c = req("GET", f"/api/checks/{cid}", token=token or tok)
            assert s == 200, (s, c)
            return c

        def billable(check, name=None):
            return [i for i in check["items"]
                    if i["state"] in ("held", "sent", "fulfilled")
                    and (name is None or i["name"] == name)]

        def split_cost(cid, body, token=None):
            return req("POST", f"/api/checks/{cid}/split-item-cost", body, token=token or tok)

        def tickets_for(cid):
            s, t = req("GET", "/api/kds/tickets?status=all", token=ktok)
            assert s == 200, (s, t)
            rows = t if isinstance(t, list) else t.get("tickets", [])
            return [x for x in rows if x.get("check_id") == cid]

        print("== A: even split, source is a target, an untouched line rides along ==")
        S = mkcheck(); T1 = mkcheck(); T2 = mkcheck()
        line = add(S, broc)
        add(S, broc, seat=2)
        before = {c: get(c)["totals"] for c in (S, T1, T2)}
        ok("A1 fixture: source subtotal 2000, targets empty",
           before[S]["subtotal"] == 2000 and before[T1]["subtotal"] == 0 and before[T2]["subtotal"] == 0,
           str(before))
        s, r = split_cost(S, {"item_id": line["id"], "targets": [S, T1, T2]})
        ok("A2 even split succeeds", s == 200, f"{s} {str(r)[:160]}")
        ok("A3 response: amount is the line net, shares align with the request order",
           r.get("amount_cents") == 1000 and r.get("checks") == [S, T1, T2]
           and [sh["share_cents"] for sh in r.get("shares", [])] == [334, 333, 333]
           and [sh["check_id"] for sh in r.get("shares", [])] == [S, T1, T2], str(r)[:240])
        after = {c: get(c) for c in (S, T1, T2)}
        ok("A4 subtotal is conserved to the cent across all three checks",
           sum(after[c]["totals"]["subtotal"] for c in (S, T1, T2)) == 2000,
           str({c: after[c]["totals"]["subtotal"] for c in (S, T1, T2)}))
        ok("A5 every check's totals are its own calcTotals on its own subtotal",
           all(totals_match(after[c]) for c in (S, T1, T2)),
           str({c: after[c]["totals"] for c in (S, T1, T2)}))
        src_line = next(i for i in after[S]["items"] if i["id"] == line["id"])
        ok("A6 the source line is consumed (cancelled) with provenance in its note",
           src_line["state"] == "cancelled"
           and f"Split across checks #{S}, #{T1}, #{T2}" in (src_line.get("note") or ""),
           str(src_line)[:220])
        shares_on = {c: [i for i in billable(after[c]) if "Split share" in (i.get("note") or "")]
                     for c in (S, T1, T2)}
        ok("A7 each target holds exactly one share line, qty 1, priced at its share",
           all(len(shares_on[c]) == 1 and shares_on[c][0]["qty"] == 1 for c in (S, T1, T2))
           and shares_on[S][0]["line_total_cents"] == 334
           and shares_on[T1][0]["line_total_cents"] == 333
           and shares_on[T2][0]["line_total_cents"] == 333
           and shares_on[S][0]["unit_price_cents"] == 334, str(shares_on)[:300])
        ok("A8 share notes name the fraction and the source check",
           f"Split share 1 of 3" in shares_on[S][0]["note"] and f"from check #{S}" in shares_on[S][0]["note"]
           and f"Split share 2 of 3" in shares_on[T1][0]["note"]
           and f"Split share 3 of 3" in shares_on[T2][0]["note"],
           str([shares_on[c][0]["note"] for c in (S, T1, T2)]))
        ok("A9 the untouched second line is still billable on the source at full price",
           len([i for i in billable(after[S], broc["name"]) if i["id"] != shares_on[S][0]["id"]]) == 1
           and after[S]["totals"]["subtotal"] == 1334, str(after[S]["totals"]))

        print("== B: the remainder follows REQUEST order, not check-id order ==")
        S2 = mkcheck(); U1 = mkcheck(); U2 = mkcheck()
        line2 = add(S2, broc)
        s, r = split_cost(S2, {"item_id": line2["id"], "targets": [U2, S2, U1]})
        got = {sh["check_id"]: sh["share_cents"] for sh in r.get("shares", [])}
        ok("B1 targets listed [U2, S2, U1] → U2 absorbs the remainder cent",
           s == 200 and got == {U2: 334, S2: 333, U1: 333}, f"{s} {got}")

        print("== C: explicit shares — happy path + the validation matrix ==")
        S3 = mkcheck(); V1 = mkcheck()
        line3 = add(S3, broc)
        s, r = split_cost(S3, {"item_id": line3["id"], "targets": [S3, V1], "shares": [400, 600]})
        ok("C1 explicit shares [400, 600] apply exactly",
           s == 200 and [sh["share_cents"] for sh in r["shares"]] == [400, 600], f"{s} {str(r)[:160]}")
        for label, body, want in [
            ("C2 sum off by one cent (999) → 400 naming the expected 1000 and the got 999",
             {"targets": ["S", "V"], "shares": [400, 599]}, ("shares must add up", "1000", "999")),
            ("C3 a zero share → 400", {"targets": ["S", "V"], "shares": [0, 1000]}, ("positive integer",)),
            ("C4 a negative share → 400", {"targets": ["S", "V"], "shares": [-5, 1005]}, ("positive integer",)),
            ("C5 a fractional share → 400", {"targets": ["S", "V"], "shares": [333.5, 666.5]}, ("positive integer",)),
            ("C6 shares/targets length mismatch → 400", {"targets": ["S", "V"], "shares": [1000]}, ("one amount per target",)),
        ]:
            Sx = mkcheck(); Vx = mkcheck()
            lx = add(Sx, broc)
            body = {"item_id": lx["id"],
                    "targets": [Sx if t == "S" else Vx for t in body["targets"]],
                    "shares": body["shares"]}
            s, r = split_cost(Sx, body)
            ok(label, s == 400 and all(w in (r.get("error") or "") for w in want),
               f"{s} {str(r)[:160]}")
            ok(label.split(" → ")[0] + " left no share lines behind",
               len(billable(get(Sx))) == 1 and len(billable(get(Vx))) == 0)

        print("== D: source not a target — emptied source closes, otherwise stays open ==")
        S4 = mkcheck(); W1 = mkcheck(); W2 = mkcheck()
        line4 = add(S4, broc)
        s, r = split_cost(S4, {"item_id": line4["id"], "targets": [W1, W2]})
        st4 = get(S4)
        ok("D1 a source left with nothing billable closes (split-family behavior)",
           s == 200 and st4["status"] == "closed" and st4["totals"]["subtotal"] == 0, f"{s} {st4['status']}")
        ok("D2 both targets hold 500 shares",
           get(W1)["totals"]["subtotal"] == 500 and get(W2)["totals"]["subtotal"] == 500)
        S5 = mkcheck(); W3 = mkcheck()
        line5 = add(S5, broc); add(S5, broc, seat=2)
        s, r = split_cost(S5, {"item_id": line5["id"], "targets": [S5, W3], "shares": [250, 750]})
        ok("D3 a source that keeps a share (and other lines) stays open",
           s == 200 and get(S5)["status"] == "open" and get(S5)["totals"]["subtotal"] == 1250,
           str(get(S5)["totals"]))

        print("== E: modifiers fold into the share price and ride for display ==")
        S6 = mkcheck(); X1 = mkcheck()
        bl = add(S6, burger, qty=2, mods=[{"name": "Add bacon"}])
        ok("E1 fixture: burger x2 + bacon grosses 4200", bl["line_total_cents"] == 4200, str(bl)[:160])
        s, r = split_cost(S6, {"item_id": bl["id"], "targets": [S6, X1]})
        shs = {}
        for c in (S6, X1):
            shs[c] = [i for i in billable(get(c)) if "Split share" in (i.get("note") or "")][0]
        ok("E2 each share line is qty 1 at half the gross, modifiers at 0 delta with names intact",
           s == 200 and all(shs[c]["qty"] == 1 and shs[c]["unit_price_cents"] == 2100
                             and shs[c]["line_total_cents"] == 2100 for c in (S6, X1))
           and all([ (m["name"], m["price_delta_cents"]) for m in shs[c]["modifiers"]] == [("Add bacon", 0)]
                   for c in (S6, X1)), str(shs)[:300])
        ok("E3 a qty-2 line splits its whole gross — subtotal conserved",
           get(S6)["totals"]["subtotal"] + get(X1)["totals"]["subtotal"] == 4200)

        print("== F: the ad-hoc line discount prorates (the qty-division precedent) ==")
        S7 = mkcheck(); Y1 = mkcheck()
        dl = add(S7, broc)
        s, r = req("POST", f"/api/checks/{S7}/items/{dl['id']}/discount",
                   {"amount_cents": 100, "reason": "test53"}, token=tok)
        assert s == 200, (s, r)
        s, r = split_cost(S7, {"item_id": dl["id"], "targets": [S7, Y1]})
        fsh = {}
        for c in (S7, Y1):
            fsh[c] = [i for i in billable(get(c)) if "Split share" in (i.get("note") or "")][0]
        ok("F1 net 900 splits 450/450; discount prorates 50/50; gross shares 500/500",
           s == 200 and fsh[S7]["line_total_cents"] == 450 and fsh[Y1]["line_total_cents"] == 450
           and fsh[S7]["discount_cents"] == 50 and fsh[Y1]["discount_cents"] == 50
           and fsh[S7]["unit_price_cents"] == 500 and fsh[Y1]["unit_price_cents"] == 500
           and fsh[S7]["discount_reason"] == "test53", str(fsh)[:300])
        ok("F2 gross is conserved across the checks (Σ share unit prices = the line gross)",
           get(S7)["gross_subtotal_cents"] + get(Y1)["gross_subtotal_cents"] == 1000,
           f"{get(S7)['gross_subtotal_cents']} + {get(Y1)['gross_subtotal_cents']}")
        S8 = mkcheck(); Y2 = mkcheck(); Y3 = mkcheck()
        dl2 = add(S8, broc)
        s, r = req("POST", f"/api/checks/{S8}/items/{dl2['id']}/discount",
                   {"amount_cents": 100, "reason": "test53"}, token=tok)
        assert s == 200, (s, r)
        s, r = split_cost(S8, {"item_id": dl2["id"], "targets": [S8, Y2, Y3], "shares": [450, 270, 180]})
        got = {sh["check_id"]: (sh["gross_cents"], sh["discount_cents"]) for sh in r.get("shares", [])}
        ok("F3 uneven explicit shares: discount prorates 50/30 with the residue 20 on the LAST target",
           s == 200 and got == {S8: (500, 50), Y2: (300, 30), Y3: (200, 20)}, f"{s} {got}")
        ok("F4 Σ gross shares = line gross, Σ discount shares = the line discount",
           sum(g for g, _ in got.values()) == 1000 and sum(d for _, d in got.values()) == 100)

        print("== G: a live library item discount refuses; the guard is line-scoped ==")
        s, dfix = req("POST", "/api/admin/discounts",
                      {"name": "Splitguard ten", "kind": "percent", "percent": 10, "scope": "item"}, token=mtok)
        assert s == 201, (s, dfix)
        S9 = mkcheck(); Z1 = mkcheck()
        gl = add(S9, broc); other = add(S9, broc, seat=2)
        s, r = req("POST", f"/api/checks/{S9}/discounts", {"discount_id": dfix["id"], "item_id": gl["id"]}, token=tok)
        assert s in (200, 201), (s, r)
        app_id = r["application"]["id"]
        s, r = split_cost(S9, {"item_id": gl["id"], "targets": [S9, Z1]})
        ok("G1 splitting the library-discounted line → 400 naming the discount",
           s == 400 and "Splitguard ten" in (r.get("error") or ""), f"{s} {str(r)[:160]}")
        s, r = split_cost(S9, {"item_id": other["id"], "targets": [S9, Z1]})
        ok("G2 the OTHER line on the same check splits fine (the guard is line-scoped, not check-wide)",
           s == 200, f"{s} {str(r)[:160]}")
        s, r = req("POST", f"/api/checks/{S9}/discounts/{app_id}/remove", {}, token=tok)
        assert s == 200, (s, r)
        s, r = split_cost(S9, {"item_id": gl["id"], "targets": [S9, Z1]})
        ok("G3 once the library discount is removed, the line splits", s == 200, f"{s} {str(r)[:160]}")

        print("== I/J: kitchen — fired lines never re-fire; held shares fire as themselves ==")
        S10 = mkcheck(); K1 = mkcheck()
        fl = add(S10, broc)
        s, r = req("POST", f"/api/checks/{S10}/send", {}, token=tok)
        assert s == 200, (s, r)
        src_before = next(i for i in get(S10)["items"] if i["id"] == fl["id"])
        tix_before = tickets_for(S10)
        tix_snap_before = [json.dumps(t["items"], sort_keys=True) for t in tix_before]
        ok("I1 fixture: one ticket on the source after send", len(tix_before) == 1, str(tix_before)[:160])
        s, r = split_cost(S10, {"item_id": fl["id"], "targets": [S10, K1]})
        tix_after = tickets_for(S10)
        ok("I2 splitting a FIRED line creates no new tickets and changes none",
           s == 200 and len(tix_after) == 1
           and [json.dumps(t["items"], sort_keys=True) for t in tix_after] == tix_snap_before, f"{s}")
        fsh10 = {}
        for c in (S10, K1):
            fsh10[c] = [i for i in billable(get(c)) if "Split share" in (i.get("note") or "")][0]
        ok("I3 fired shares stay 'sent' with the original sent_at (nothing can re-fire)",
           all(fsh10[c]["state"] == "sent" and fsh10[c]["sent_at"] == src_before["sent_at"] for c in (S10, K1)),
           str(fsh10)[:260])
        s, r = req("POST", f"/api/checks/{K1}/send", {}, token=tok)
        ok("I4 sending a target holding only a fired share fires nothing new",
           len(tickets_for(K1)) == 0 and len(tickets_for(S10)) == 1, f"{s} {str(r)[:120]}")
        S11 = mkcheck(); K2 = mkcheck()
        hl = add(S11, broc)
        s, r = split_cost(S11, {"item_id": hl["id"], "targets": [S11, K2]})
        hsh = {}
        for c in (S11, K2):
            hsh[c] = [i for i in billable(get(c)) if "Split share" in (i.get("note") or "")][0]
        ok("J1 a HELD line's shares stay held on their target checks",
           s == 200 and all(hsh[c]["state"] == "held" for c in (S11, K2)))
        s, r = req("POST", f"/api/checks/{K2}/send", {}, token=tok)
        tix_k2 = tickets_for(K2)
        k2_items = tix_k2[0]["items"] if tix_k2 else []
        ok("J2 sending the target fires ITS share as its own line (provenance rides the ticket)",
           s == 200 and len(tix_k2) == 1 and len(k2_items) == 1
           and k2_items[0].get("name") == broc["name"]
           and "Split share 2 of 2" in (k2_items[0].get("note") or ""), str(tix_k2)[:240])
        s, r = req("POST", f"/api/checks/{S11}/send", {}, token=tok)
        tix_s11 = tickets_for(S11)
        s11_items = tix_s11[0]["items"] if tix_s11 else []
        s11_after = get(S11)
        share_state = next(i["state"] for i in s11_after["items"] if i["id"] == hsh[S11]["id"])
        orig_state = next(i["state"] for i in s11_after["items"] if i["id"] == hl["id"])
        ok("J3 the source check fires its own share — the consumed line itself never fires",
           len(tix_s11) == 1 and len(s11_items) == 1
           and "Split share 1 of 2" in (s11_items[0].get("note") or "")
           and "Split across" not in (s11_items[0].get("note") or "")
           and share_state == "sent" and orig_state == "cancelled", str(tix_s11)[:240])

        print("== K: guards — payments, statuses, targets, roles ==")
        S12 = mkcheck(); P1 = mkcheck()
        pl = add(S12, broc); add(S12, broc, seat=2)
        s, r = req("POST", f"/api/checks/{S12}/payments",
                   {"method": "cash", "amount_cents": 500, "tip_cents": 0, "tendered_cents": 500}, token=tok)
        assert s == 201, (s, r)
        s, r = split_cost(S12, {"item_id": pl["id"], "targets": [S12, P1]})
        ok("K1 a source with payments → 400 (the split-family rule)",
           s == 400 and "already has payments" in (r.get("error") or ""), f"{s} {str(r)[:140]}")
        S13 = mkcheck()
        closed_t = mkcheck()
        cl = add(closed_t, broc)
        tot = get(closed_t)["totals"]["total"]
        s, r = req("POST", f"/api/checks/{closed_t}/payments",
                   {"method": "cash", "amount_cents": tot, "tip_cents": 0, "tendered_cents": tot}, token=tok)
        assert s == 201, (s, r)
        s, r = req("POST", f"/api/checks/{closed_t}/close", {}, token=tok)
        assert s == 200, (s, r)
        l13 = add(S13, broc)
        s, r = split_cost(S13, {"item_id": l13["id"], "targets": [S13, closed_t]})
        ok("K2 a closed target → 400 not open", s == 400 and "not open" in (r.get("error") or ""), f"{s} {str(r)[:140]}")
        void_t = mkcheck(); add(void_t, broc)
        s, r = req("POST", f"/api/checks/{void_t}/void", {"manager_pin": MANAGER_PIN, "reason": "test53"}, token=tok)
        assert s == 200, (s, r)
        s, r = split_cost(S13, {"item_id": l13["id"], "targets": [S13, void_t]})
        ok("K3 a void target → 400 not open", s == 400 and "not open" in (r.get("error") or ""), f"{s} {str(r)[:140]}")
        s, r = split_cost(S13, {"item_id": l13["id"], "targets": [S13, 999999]})
        ok("K4 an unknown target → 404", s == 404, f"{s} {str(r)[:120]}")
        s, r = split_cost(S13, {"item_id": l13["id"], "targets": [S13]})
        ok("K5 fewer than 2 targets → 400", s == 400, f"{s}")
        s, r = split_cost(S13, {"item_id": l13["id"], "targets": [S13, S13]})
        ok("K6 duplicate targets → 400", s == 400 and "distinct" in (r.get("error") or ""), f"{s} {str(r)[:120]}")
        foreign = add(P1, broc)
        s, r = split_cost(S13, {"item_id": foreign["id"], "targets": [S13, P1]})
        ok("K7 an item from another check → 404", s == 404, f"{s}")
        s, r = split_cost(S13, {"targets": [S13, P1]})
        ok("K8 a missing item_id → 400", s == 400, f"{s}")
        dead = add(S13, broc, seat=2)
        s, r = req("POST", f"/api/checks/{S13}/void-item",
                   {"item_id": dead["id"], "manager_pin": MANAGER_PIN, "reason": "test53"}, token=tok)
        assert s == 200, (s, r)
        s, r = split_cost(S13, {"item_id": dead["id"], "targets": [S13, P1]})
        ok("K9 a voided line → 400 already voided", s == 400 and "already voided" in (r.get("error") or ""), f"{s} {str(r)[:120]}")
        s, r = split_cost(S13, {"item_id": l13["id"], "targets": [S13, P1]}, token=ktok)
        ok("K10 the kitchen role is refused (serverPlus)", s == 403, f"{s}")
        s, r = split_cost(S4, {"item_id": line4["id"], "targets": [W1, W2]})
        ok("K11 splitting on a closed source check → 400", s == 400 and "closed" in (r.get("error") or ""), f"{s} {str(r)[:120]}")

        print("== L: large-party service charge + zero-net line ==")
        S14 = mkcheck(guests=8)
        sl = add(S14, broc)
        ok("L1 fixture: the 8-top carries a service charge", get(S14)["totals"]["service_charge"] > 0,
           str(get(S14)["totals"]))
        s, r = split_cost(S14, {"item_id": sl["id"], "targets": [S14, P1]})
        ok("L2 a service-charged source → 400 naming the service charge (split-family rule)",
           s == 400 and "service charge" in (r.get("error") or ""), f"{s} {str(r)[:140]}")
        S15 = mkcheck()
        zl = add(S15, broc)
        s, r = req("POST", f"/api/checks/{S15}/items/{zl['id']}/discount",
                   {"amount_cents": 1000, "reason": "test53"}, token=tok)
        assert s == 200, (s, r)
        s, r = split_cost(S15, {"item_id": zl["id"], "targets": [S15, P1]})
        ok("L3 a fully discounted (zero-net) line → 400, nothing to divide",
           s == 400 and "no cost left" in (r.get("error") or ""), f"{s} {str(r)[:140]}")

        print("== M: tax disclosure — subtotal exact, combined tax pinned to the cent ==")
        # Control: one 1000 line alone. surcharge round(1000*.05)=50,
        # taxable 1050, tax round(1050*.0775)=round(81.375)=81, total 1131.
        C0 = mkcheck(); add(C0, broc)
        ctl = get(C0)["totals"]
        ok("M1 control check: tax 81, total 1131",
           ctl["subtotal"] == 1000 and ctl["tax"] == 81 and ctl["total"] == 1131, str(ctl))
        # Split [7, 993]: the 7-cent check rounds its tax UP
        # (7*.0775=0.5425 → 1) while the 993 check matches the control's
        # rounding — combined tax 82, exactly +1 over the unsplit check.
        # Subtotal is still conserved to the cent: per-check rounding
        # is the disclosed behavior, not a leak.
        S16 = mkcheck(); M1t = mkcheck()
        ml = add(S16, broc)
        s, r = split_cost(S16, {"item_id": ml["id"], "targets": [S16, M1t], "shares": [7, 993]})
        a16, b16 = get(S16)["totals"], get(M1t)["totals"]
        ok("M2 subtotal conserved exactly (7 + 993 = 1000)",
           s == 200 and a16["subtotal"] + b16["subtotal"] == 1000, f"{s} {a16} {b16}")
        ok("M3 per-check figures are each check's own calcTotals (7→tax 1; 993→surcharge 50, tax 81)",
           a16["subtotal"] == 7 and a16["surcharge"] == 0 and a16["tax"] == 1 and a16["total"] == 8
           and b16["surcharge"] == 50 and b16["tax"] == 81 and b16["total"] == 1124,
           f"{a16} {b16}")
        ok("M4 combined tax is exactly +1¢ over the unsplit control (per-check rounding, pinned)",
           a16["tax"] + b16["tax"] == ctl["tax"] + 1 == 82, f"{a16['tax']}+{b16['tax']} vs {ctl['tax']}")

        print("== N: targets with their own lives — partial payment and a bar tab ==")
        T17 = mkcheck()
        add(T17, broc)
        s, r = req("POST", f"/api/checks/{T17}/payments",
                   {"method": "cash", "amount_cents": 500, "tip_cents": 0, "tendered_cents": 500}, token=tok)
        assert s == 201, (s, r)
        S17 = mkcheck()
        nl = add(S17, broc)
        s, r = split_cost(S17, {"item_id": nl["id"], "targets": [S17, T17]})
        t17 = get(T17)["totals"]
        ok("N1 a partially-paid open target accepts a share and simply owes more",
           s == 200 and t17["subtotal"] == 1500 and t17["paid"] == 500
           and t17["balance"] == t17["total"] - 500 and totals_match(get(T17)),
           f"{s} {t17}")
        s, tab = req("POST", "/api/checks", {"tab_name": "Split Tab 53", "guest_count": 1}, token=tok)
        assert s == 201, (s, tab)
        tab_id = tab["id"]
        S18 = mkcheck()
        tl = add(S18, broc)
        s, r = split_cost(S18, {"item_id": tl["id"], "targets": [S18, tab_id], "shares": [600, 400]})
        tabc = get(tab_id)
        ok("N2 a bar tab is a valid target; the share lands with tab totals updated",
           s == 200 and tabc["channel"] == "bar_tab" and tabc["totals"]["subtotal"] == 400
           and totals_match(tabc), f"{s} {tabc['totals']}")

        print("== O: the split permission — split_allowed gate + manager PIN fallback ==")
        con = sqlite3.connect(DB)
        con.execute("INSERT INTO users (site_id, name, role, pin, split_allowed) "
                    "VALUES ('bali-hai', 'NoSplit Ned', 'server', ?, 0)", (NED_PIN,))
        con.commit(); con.close()
        ntok = login(NED_PIN)
        NS = mkcheck(token=ntok); NT = mkcheck(token=ntok)
        nline = add(NS, broc, token=ntok)
        s, r = split_cost(NS, {"item_id": nline["id"], "targets": [NS, NT]}, token=ntok)
        ok("O1 staff without split_allowed → 403 need_manager_pin",
           s == 403 and r.get("need_manager_pin") is True, f"{s} {str(r)[:140]}")
        s, r = split_cost(NS, {"item_id": nline["id"], "targets": [NS, NT], "manager_pin": "9999"}, token=ntok)
        ok("O2 a wrong manager PIN → 403", s == 403, f"{s}")
        s, r = split_cost(NS, {"item_id": nline["id"], "targets": [NS, NT], "manager_pin": MANAGER_PIN}, token=ntok)
        ok("O3 the manager PIN fallback approves the split", s == 200, f"{s} {str(r)[:140]}")

        print("== P: audit — split_item_cost rows carry the full division ==")
        s, audit = req("GET", "/api/admin/approvals/audit?limit=400", token=mtok)
        assert s == 200, (s, audit)
        rows = [x for x in audit if x.get("action") == "split_item_cost"]
        ok("P1 audit rows exist for the splits performed", len(rows) >= 10, f"rows={len(rows)}")
        broc_row = next((x for x in rows
                         if json.loads(x.get("details") or "{}").get("item_name") == broc["name"]), None)
        det = json.loads(broc_row.get("details") or "{}") if broc_row else {}
        ok("P2 a row names the item, the net, and per-target shares summing to the net",
           bool(broc_row) and det.get("net_cents") == 1000
           and det.get("net_cents") == sum(t["share_cents"] for t in det.get("targets", []))
           and all(t.get("gross_cents") - t.get("discount_cents") == t.get("share_cents")
                   for t in det.get("targets", [])), str(det)[:240])
        pin_rows = [x for x in rows if json.loads(x.get("details") or "{}").get("approved_by") == "Manager"]
        ok("P3 the PIN-approved split records approved_by = the manager",
           len(pin_rows) >= 1, f"pin_rows={len(pin_rows)}")

    finally:
        stop(proc)

    print(f"\n{'ALL PASS' if not failures else 'FAILURES: ' + ', '.join(failures)} — {passed} passed, {failed} failed")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
