#!/usr/bin/env python3
"""test50_tax_report.py — the sales-tax report reconciles with calcTotals.

THE DEFECT (pre-existing, found by the discount-library batch): the tax
report computed taxable sales as

    subtotal + surcharge + service_charge - comp

but calcTotals — the money path guests actually pay — taxes

    taxable = subtotal + surcharge + service_charge
    tax     = round(taxable * tax_rate)
    total   = max(0, subtotal + surcharge + service_charge + tax - comp)

i.e. comps reduce the amount owed AFTER tax; they never enter the
taxable base. Whenever a comp existed, the report's taxable figure was
understated by exactly the comp amount and did not reconcile with the
tax actually collected. The fix aligns the REPORT to the MONEY (never
the reverse — whether comps SHOULD reduce taxable is the accountant's
policy call): taxable_cents now sums the base calcTotals taxed, and
comps are summed into their own comp_cents column/total instead.

Site config on a fresh boot (seeded): tax_rate 7.75%, surcharge 5%,
service charge 18% at 8+ guests. All fixtures below are hand-computed
with JS Math.round (round half up) and asserted TWICE: once against
the check's own totals (the money actually charged — unchanged by
this batch) and once against the report row.

  A plain — Black Bean Chinese Broccoli 1000 x2, 2 guests
      subtotal 2000, surcharge round(2000*.05)=100, service 0
      taxable 2100, tax round(2100*.0775)=round(162.75)=163
      comp 0, total 2263. Paid by card with a 200 tip.
  B item-discounted — Tuna Poke 2100 x1, ad-hoc line discount 500
      gross 2100, subtotal 1600, surcharge 80, service 0
      taxable 1680, tax round(1680*.0775)=round(130.20)=130
      comp 0, total 1810. (Item discounts DO reduce the base, via
      the subtotal — that is the existing money behavior.)
  C ad-hoc comp — Spicy Yakisoba Short Rib 3200 x1, comp 1000
      subtotal 3200, surcharge 160, service 0
      taxable 3360, tax round(3360*.0775)=round(260.40)=260
      comp 1000, total 3360+260-1000=2620.
      OLD report taxable for this check: 3360-1000=2360 (short by 1000).
  D library comp — Firecracker Pork Ribs 1700 x2, library 10% check def
      subtotal 3400, surcharge 170, service 0
      taxable 3570, tax round(3570*.0775)=round(276.675)=277
      comp round(3400*.10)=340, total 3570+277-340=3507.
      OLD report taxable: 3570-340=3230 (short by exactly 340).
  E service charge — Char Sui Cobb 2400 x1, 8 guests
      subtotal 2400, surcharge 120, service round(2400*.18)=432
      taxable 2952, tax round(2952*.0775)=round(228.78)=229
      comp 0, total 3181.
  F mixed — Huli Huli Garlic Shrimp 3400 x1 + Black Bean Chinese
      Broccoli 1000 x1, line discount 300 on the broccoli, comp 500
      gross 4400, subtotal 4100, surcharge 205, service 0
      taxable 4305, tax round(4305*.0775)=round(333.6375)=334
      comp 500, total 4305+334-500=4139.
      OLD report taxable: 4305-500=3805 (short by exactly 500).

  DAY ROLLUP (the six checks above, all closed on the site date):
      checks 6
      taxable 2100+1680+3360+3570+2952+4305 = 17967
      tax     163+130+260+277+229+334       = 1393
      comps   0+0+1000+340+0+500            = 1840
      tips    200 (fixture A only)
      OLD day taxable would be 17967-1840 = 16127.

Discriminating control at c376296 (verified): every report-row
assert fails — the comp_cents key is absent from rows/totals/CSV at
the old commit, and from section C onward taxable is ADDITIONALLY
understated by exactly the cumulative comp (after C: 6140 vs 7140,
short 1000; after D: 9370 vs 10710, short 1340; day: 16127 vs
17967, short 1840). tax_cents is identical at both commits (1393
for the day) — only the taxable presentation was wrong. The
check-total asserts pass at BOTH commits: the money never moved,
only the report did.

Boot pattern mirrors test49 (plain node on :4381, own DB file).
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
PORT = 4381
DB = "/tmp/expoline-test50.db"
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


def jsround(x):
    """JS Math.round for non-negative values (round half up)."""
    return math.floor(x + 0.5)


def req(method, path, body=None, token=None, base=BASE, raw=False):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(base + path, data=data, method=method)
    r.add_header("Content-Type", "application/json")
    if token:
        r.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(r, timeout=15) as resp:
            b = resp.read()
            return (resp.status, b.decode()) if raw else (resp.status, json.loads(b.decode() or "{}"))
    except urllib.error.HTTPError as e:
        b = e.read()
        if raw:
            return e.code, b.decode(errors="replace")
        try:
            return e.code, json.loads(b.decode() or "{}")
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
    """lines: [(menu_item_id, qty), ...] at seat 1. Returns check id."""
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


def pay_and_close(tok, cid, tip=0):
    bal = get_check(tok, cid)["totals"]["balance"]
    body = {"method": "card_demo", "amount_cents": bal, "tip_cents": tip,
            "brand": "Visa", "last4": "4242"}
    s, r = req("POST", f"/api/checks/{cid}/payments", body, token=tok)
    assert s == 201, (s, r)
    s, r = req("POST", f"/api/checks/{cid}/close", {}, token=tok)
    assert s == 200 and get_check(tok, cid)["status"] == "closed", (s, r)


# Hand-computed expectations: (subtotal, surcharge, service, tax, comp, total)
EXP = {
    "A": (2000, 100, 0, 163, 0, 2263),
    "B": (1600, 80, 0, 130, 0, 1810),
    "C": (3200, 160, 0, 260, 1000, 2620),
    "D": (3400, 170, 0, 277, 340, 3507),
    "E": (2400, 120, 432, 229, 0, 3181),
    "F": (4100, 205, 0, 334, 500, 4139),
}
# Cumulative day rollup after each fixture closes:
# (taxable, tax, comp, checks, tips)
CUM = {
    "A": (2100, 163, 0, 1, 200),
    "B": (3780, 293, 0, 2, 200),
    "C": (7140, 553, 1000, 3, 200),
    "D": (10710, 830, 1340, 4, 200),
    "E": (13662, 1059, 1340, 5, 200),
    "F": (17967, 1393, 1840, 6, 200),
}


def main():
    if os.path.exists(DB):
        os.remove(DB)
    srv = boot(PORT, DB)
    try:
        stok = login(SERVER_PIN)
        mtok = login(MANAGER_PIN)
        s, cfg = req("GET", "/api/config", token=mtok)
        site_date = cfg["site_date"]
        items = menu_items(stok)

        def pick(name, price):
            it = items.get(name)
            # Optional modifier groups (min_select 0, not required) are fine —
            # the fixture posts no modifiers. A required group would force a
            # pick and change the line math, so reject only those.
            forced = [g for g in (it or {}).get("modifier_groups") or []
                      if g.get("required") or (g.get("min_select") or 0) > 0]
            assert it and it["price_cents"] == price and not forced, (name, it)
            return it

        broccoli = pick("Black Bean Chinese Broccoli", 1000)
        poke = pick("Tuna Poke", 2100)
        short_rib = pick("Spicy Yakisoba Short Rib", 3200)
        ribs = pick("Firecracker Pork Ribs", 1700)
        cobb = pick("Char Sui Cobb", 2400)
        shrimp = pick("Huli Huli Garlic Shrimp", 3400)

        def tax_report():
            s, r = req("GET", f"/api/finance/reports/tax?format=json&period=day&date={site_date}",
                       token=mtok)
            assert s == 200, (s, r)
            return r

        def expect_money(tag, cid):
            """The charged totals equal the hand numbers (money untouched)."""
            t = get_check(stok, cid)["totals"]
            sub, sur, svc, tax, comp, total = EXP[tag]
            ok(f"{tag}0 charged totals match the hand computation",
               (t["subtotal"], t["surcharge"], t["service_charge"], t["tax"], t["comp"], t["total"])
               == (sub, sur, svc, tax, comp, total), str(t))
            return t

        def expect_report(tag):
            """The day row + totals equal the cumulative hand rollup."""
            r = tax_report()
            taxable, tax, comp, checks, tips = CUM[tag]
            row = r["rows"][0] if r.get("rows") else {}
            tot = r.get("totals") or {}
            ok(f"{tag}8 report row: taxable excludes comps, tax = charged tax, comps in own column",
               row.get("taxable_cents") == taxable and row.get("tax_cents") == tax
               and row.get("comp_cents") == comp and row.get("checks") == checks
               and row.get("tips_cents") == tips,
               f"row={row} want taxable={taxable} tax={tax} comp={comp} checks={checks} tips={tips}")
            ok(f"{tag}9 report totals equal the day row (single-day range)",
               tot.get("taxable_cents") == taxable and tot.get("tax_cents") == tax
               and tot.get("comp_cents") == comp and tot.get("checks") == checks,
               f"totals={tot}")

        print("== A: plain check ==")
        cid = build_check(stok, [(broccoli["id"], 2)])
        expect_money("A", cid)
        pay_and_close(stok, cid, tip=200)
        expect_report("A")

        print("== B: item-discounted check (discount reduces the base via subtotal) ==")
        cid = build_check(stok, [(poke["id"], 1)])
        line = get_check(stok, cid)["items"][0]
        s, r = req("POST", f"/api/checks/{cid}/items/{line['id']}/discount",
                   {"amount_cents": 500, "reason": "test50"}, token=stok)
        assert s == 200, (s, r)
        expect_money("B", cid)
        pay_and_close(stok, cid)
        expect_report("B")

        print("== C: ad-hoc comp — taxable must NOT drop by the comp ==")
        cid = build_check(stok, [(short_rib["id"], 1)])
        s, r = req("POST", f"/api/checks/{cid}/comp",
                   {"amount_cents": 1000, "manager_pin": MANAGER_PIN, "reason": "test50"}, token=stok)
        assert s == 200, (s, r)
        t = expect_money("C", cid)
        ok("C1 the charged tax is computed on the un-comped base",
           t["tax"] == jsround((3200 + 160) * 0.0775) == 260, str(t))
        pay_and_close(stok, cid)
        expect_report("C")

        print("== D: library check-scope comp — same treatment through comp_cents ==")
        s, d = req("POST", "/api/admin/discounts",
                   {"name": "TaxRpt Ten", "kind": "percent", "percent": 10, "scope": "check"},
                   token=mtok)
        assert s == 201, (s, d)
        cid = build_check(stok, [(ribs["id"], 2)])
        s, r = req("POST", f"/api/checks/{cid}/discounts", {"discount_id": d["id"]}, token=stok)
        assert s == 201 and (r.get("application") or {}).get("applied_cents") == 340, (s, r)
        expect_money("D", cid)
        pay_and_close(stok, cid)
        expect_report("D")

        print("== E: service-charged 8-top — service charge stays in the base ==")
        cid = build_check(stok, [(cobb["id"], 1)], guests=8)
        expect_money("E", cid)
        pay_and_close(stok, cid)
        expect_report("E")

        print("== F: mixed — line discount + ad-hoc comp on one check ==")
        cid = build_check(stok, [(shrimp["id"], 1), (broccoli["id"], 1)])
        chk = get_check(stok, cid)
        line = next(i for i in chk["items"] if i["menu_item_id"] == broccoli["id"])
        s, r = req("POST", f"/api/checks/{cid}/items/{line['id']}/discount",
                   {"amount_cents": 300, "reason": "test50"}, token=stok)
        assert s == 200, (s, r)
        s, r = req("POST", f"/api/checks/{cid}/comp",
                   {"amount_cents": 500, "manager_pin": MANAGER_PIN, "reason": "test50"}, token=stok)
        assert s == 200, (s, r)
        expect_money("F", cid)
        pay_and_close(stok, cid)
        expect_report("F")

        print("== G: the whole day reconciles, exports carry the comp column ==")
        r = tax_report()
        tot = r["totals"]
        ok("G1 day totals equal the hand rollup (taxable 17967 / tax 1393 / comps 1840)",
           tot.get("taxable_cents") == 17967 and tot.get("tax_cents") == 1393
           and tot.get("comp_cents") == 1840 and tot.get("checks") == 6
           and tot.get("tips_cents") == 200, f"totals={tot}")
        # Cross-check from first principles: the report must equal the sums
        # over the six checks' own persisted totals (what was charged).
        ok("G2 taxable == sum of per-check (subtotal + surcharge + service charge)",
           tot["taxable_cents"] == sum(e[0] + e[1] + e[2] for e in EXP.values()),
           str(tot["taxable_cents"]))
        ok("G3 tax collected == sum of per-check charged tax_cents",
           tot["tax_cents"] == sum(e[3] for e in EXP.values()), str(tot["tax_cents"]))
        s, csv = req("GET", f"/api/finance/reports/tax?format=csv&period=day&date={site_date}",
                     token=mtok, raw=True)
        head = csv.splitlines()[0] if csv else ""
        ok("G4 the CSV export carries Taxable sales and Comps columns",
           s == 200 and "Taxable sales" in head and "Comps" in head, f"{s} {head}")
        ok("G5 the CSV body carries the dollar day figures (179.67 taxable, 18.40 comps)",
           "179.67" in csv and "18.40" in csv, csv[:300])

    finally:
        stop(srv)

    print(f"\n{'ALL PASS' if failed == 0 else 'FAILURES'}: {passed} passed, {failed} failed")
    if failures:
        print("failed checks:", failures)
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
