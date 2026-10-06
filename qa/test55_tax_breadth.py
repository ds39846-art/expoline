"""test55_tax_breadth.py — per-item tax rates, tax-exempt sales,
tax-inclusive pricing (audit gap #9).

THE HARD ANCHOR: with no per-item override, no exempt check and nothing
tax-inclusive, every total must be BYTE-IDENTICAL to the pre-batch
engine at a5fd7c6:

    surcharge = round(subtotal * .05)
    service   = guests >= 8 ? round(subtotal * .18) : 0
    tax       = round((subtotal + surcharge + service) * .0775)
    total     = max(0, subtotal + surcharge + service + tax - comp)

Section 1 is the proof: 220 deterministic-seeded random carts (items,
quantities, line discounts, comps, party sizes straddling the
service-charge threshold) whose totals are compared field-by-field
against a faithful Python re-implementation of the OLD formula driven
by the server's own line totals.

Design pinned by this suite:
  - Rates SNAPSHOT onto the line at ring time (the unit_price_cents
    precedent): editing an item's rate never reprices lines already
    rung — reports re-run persistTotals on closed checks, so a live
    read would rewrite history.
  - Surcharge/service allocate across rate groups by group base share;
    the largest-base group (ties -> higher rate) absorbs the rounding
    residue, so group bases always sum to the taxed base exactly.
  - Inclusive back-out is per line: net = round(lt / (1 + rate)),
    included = lt - net, so net + included == the charged price.
    Surcharge/service bases use the net-of-tax amount (the existing
    bases with the net substitution); the fee share's tax is ADDED tax.
  - tax_cents stays THE tax figure: added tax + included tax. The
    payload carries totals.tax_included and totals.tax_detail.
  - Check exempt is the comp idiom: fresh manager PIN always (a server
    role alone is refused), reason required both ways, audit-logged,
    open checks only, reversible while open.

Sections:
  1  EQUIVALENCE — 220 seeded carts vs the OLD formula, byte-identical
  2  Validation + admin editor round-trip for the two new fields
  3  Per-item rates — hand-computed groups, allocation + residue,
     rate-0 item, service-charge party, snapshot pinning
  4  Tax-inclusive — single, mixed, own rate, HH interplay, discount
  5  Check exempt — PIN gates, audit, restore, partially paid
  6  Insert-path snapshots — kiosk + delivery orders
  7  Tax report + Z snapshot reconciliation (by-rate extraTable)
  8  LAN menu_update carry (guarded assignment) + add_items snapshot

Discriminating control at a5fd7c6 (verified separately against a
pristine worktree of that commit): the tax fields are dropped on
create (201 but tax_rate_bps / tax_inclusive absent from the stored
item), a two-rate fixture taxes everything at the site rate (tax 244 /
total 3394 where this suite expects 291 / 3441 — a 47c delta), an
"inclusive" item is taxed ON TOP of the sticker (tax 88, total 1220
where this suite expects 82 / 1132), and
POST /checks/:id/tax-exempt is 404.

Run: python3 qa/test55_tax_breadth.py
"""
import json
import math
import os
import random
import signal
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PORT = 4395
LAN_PORT = 4396
DB = "/tmp/expoline-test55.db"
DB2 = "/tmp/expoline-test55b.db"
LAN_DB = "/tmp/expoline-test55-lan.db"
BASE = f"http://127.0.0.1:{PORT}"
LAN_BASE = f"http://127.0.0.1:{LAN_PORT}"
SERVER_PIN = "1111"
MANAGER_PIN = "2580"
TAX = 0.0775
SUR = 0.05
SVC = 0.18
SVC_MIN = 8

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
    s, cats = req("GET", "/api/admin/menu", token=tok, base=base)
    return {it["name"]: it for c in cats for it in c.get("items", [])}


def free_table(tok, base=BASE):
    s, zones = req("GET", "/api/zones", token=tok, base=base)
    if isinstance(zones, dict):
        zones = zones.get("zones", [])
    for z in zones:
        for t in z.get("tables", []):
            if not t.get("open_check_id"):
                return t
    return None


def open_check(tok, guests=2, base=BASE):
    t = free_table(tok, base=base)
    s, c = req("POST", "/api/checks", {"table_id": t["id"], "guest_count": guests},
               token=tok, base=base)
    assert s == 201, (s, c)
    return c["id"]


def add(tok, cid, item_id, qty=1, base=BASE):
    s, r = req("POST", f"/api/checks/{cid}/items",
               {"menu_item_id": item_id, "seat": 1, "qty": qty, "modifiers": []},
               token=tok, base=base)
    assert s == 201, (s, r)
    return r


def get_check(tok, cid, base=BASE):
    s, c = req("GET", f"/api/checks/{cid}", token=tok, base=base)
    assert s == 200, (s, c)
    return c


def mkitem(mtok, cat_id, name, price, base=BASE, **kw):
    body = {"name": name, "price_cents": price, "category_id": cat_id,
            "station": "expediter", "course": "entree", "item_type": "food"}
    body.update(kw)
    s, r = req("POST", "/api/admin/menu/items", body, token=mtok, base=base)
    assert s == 201, (s, r)
    return r


def pay_close(tok, cid, tip=0, base=BASE):
    bal = get_check(tok, cid, base=base)["totals"]["balance"]
    s, r = req("POST", f"/api/checks/{cid}/payments",
               {"method": "card_demo", "amount_cents": bal, "tip_cents": tip,
                "brand": "Visa", "last4": "4242"}, token=tok, base=base)
    assert s == 201, (s, r)
    s, r = req("POST", f"/api/checks/{cid}/close", {}, token=tok, base=base)
    assert s == 200, (s, r)


def expect_totals(name, check, subtotal, surcharge, service, tax, total,
                  included=None, detail=None):
    t = check["totals"]
    want = {"subtotal": subtotal, "surcharge": surcharge,
            "service_charge": service, "tax": tax, "total": total}
    got = {k: t[k] for k in want}
    ok(f"{name} totals", got == want, f"got {got} want {want}")
    if included is not None:
        ok(f"{name} tax_included", t.get("tax_included") == included,
           f"got {t.get('tax_included')} want {included}")
        ok(f"{name} tax_included_cents field", check.get("tax_included_cents") == included,
           f"got {check.get('tax_included_cents')}")
    if detail is not None:
        ok(f"{name} tax_detail", t.get("tax_detail") == detail,
           f"got {t.get('tax_detail')} want {detail}")


def old_formula(check):
    """The pre-batch engine at a5fd7c6, re-implemented faithfully and
    driven by the server's own per-line totals."""
    items = [i for i in check["items"]
             if i["state"] in ("held", "sent", "fulfilled")]
    subtotal = sum(i["line_total_cents"] for i in items)
    surcharge = jsround(subtotal * SUR)
    guests = check.get("guest_count") or 0
    service = jsround(subtotal * SVC) if guests >= SVC_MIN else 0
    tax = jsround((subtotal + surcharge + service) * TAX)
    total = max(0, subtotal + surcharge + service + tax - (check["totals"]["comp"] or 0))
    return {"subtotal": subtotal, "surcharge": surcharge,
            "service_charge": service, "tax": tax, "total": total,
            "paid": 0, "balance": total}


# =====================================================================
def phase1_equivalence():
    print("\n== 1 EQUIVALENCE: 220 seeded carts vs the a5fd7c6 formula ==")
    if os.path.exists(DB):
        os.remove(DB)
    srv = boot(PORT, DB)
    try:
        tok = login(SERVER_PIN)
        mtok = login(MANAGER_PIN)
        menu = menu_items(tok)
        pool = [it for it in menu.values()
                if it["price_cents"] > 0 and not it.get("is_86")
                and not any(g.get("required")
                            for g in it.get("modifier_groups") or [])]
        ok("equivalence pool has >= 12 priced items", len(pool) >= 12,
           f"pool={len(pool)}")
        rng = random.Random(20261006)
        mismatches = 0
        for n in range(220):
            guests = rng.choice([1, 2, 2, 3, 4, 5, 6, 7, 8, 8, 9, 10, 12])
            cid = open_check(tok, guests=guests)
            lines = rng.sample(pool, rng.randint(1, 5))
            added = []
            for it in lines:
                r = add(tok, cid, it["id"], qty=rng.randint(1, 4))
                added.append(r)
            # ~40% of carts get a line discount on one line
            if rng.random() < 0.4:
                ln = rng.choice(added)
                gross = ln["qty"] * ln["unit_price_cents"]
                amt = rng.randint(1, max(1, gross // 2))
                s, r = req("POST", f"/api/checks/{cid}/items/{ln['id']}/discount",
                           {"amount_cents": amt, "reason": "qa55"}, token=tok)
                assert s == 200, (s, r)
            check = get_check(tok, cid)
            # ~25% of carts get a comp (after we know the subtotal)
            if rng.random() < 0.25 and check["totals"]["subtotal"] > 100:
                amt = rng.randint(1, check["totals"]["subtotal"] // 2)
                s, r = req("POST", f"/api/checks/{cid}/comp",
                           {"amount_cents": amt, "manager_pin": MANAGER_PIN,
                            "reason": "qa55"}, token=tok)
                assert s == 200, (s, r)
                check = get_check(tok, cid)
            want = old_formula(check)
            t = check["totals"]
            got = {k: t[k] for k in want}
            if got != want or t.get("tax_included") != 0 or check.get("tax_exempt"):
                mismatches += 1
                if mismatches <= 3:
                    print(f"    cart {n}: got {got} want {want}")
            s, r = req("POST", f"/api/checks/{cid}/void",
                       {"manager_pin": MANAGER_PIN, "reason": "qa55 cleanup"},
                       token=tok)
            assert s == 200, (s, r)
        ok("220/220 seeded carts byte-identical to the OLD formula",
           mismatches == 0, f"mismatches={mismatches}")
    finally:
        stop(srv)


# =====================================================================
def phase2_fixtures():
    print("\n== 2-7 fixtures on a fresh DB ==")
    if os.path.exists(DB2):
        os.remove(DB2)
    srv = boot(PORT, DB2)
    try:
        tok = login(SERVER_PIN)
        mtok = login(MANAGER_PIN)
        s, cfg = req("GET", "/api/config", token=tok)
        site_date = cfg.get("site_date") or (cfg.get("config") or {}).get("site_date")
        adm = admin_items(mtok)
        cat_id = next(iter(adm.values()))["category_id"]

        # ---------- 2 validation + editor round-trip ----------
        print("\n== 2 validation + editor round-trip ==")
        bad = [
            ("rate 10001", {"tax_rate_bps": 10001}),
            ("rate -1", {"tax_rate_bps": -1}),
            ("rate fractional 77.5", {"tax_rate_bps": 77.5}),
            ("rate string", {"tax_rate_bps": "775"}),
            ("inclusive string", {"tax_inclusive": "yes"}),
            ("inclusive number 2", {"tax_inclusive": 2}),
        ]
        for label, kw in bad:
            body = {"name": f"QA55 bad {label}", "price_cents": 100,
                    "category_id": cat_id, "station": "expediter",
                    "course": "entree"}
            body.update(kw)
            s, r = req("POST", "/api/admin/menu/items", body, token=mtok)
            ok(f"create with {label} -> 400", s == 400, f"{s} {r}")
        it = mkitem(mtok, cat_id, "QA55 Valid", 1000, tax_rate_bps=825,
                    tax_inclusive=True)
        ok("create stores tax fields", it.get("tax_rate_bps") == 825
           and it.get("tax_inclusive") is True, f"{it}")
        ok("staff /api/menu carries tax fields",
           menu_items(tok)["QA55 Valid"].get("tax_rate_bps") == 825
           and menu_items(tok)["QA55 Valid"].get("tax_inclusive") is True)
        s, r = req("PUT", f"/api/admin/menu/items/{it['id']}",
                   {"price_cents": 1100}, token=mtok)
        ok("PUT without tax fields preserves them",
           s == 200 and r.get("tax_rate_bps") == 825
           and r.get("tax_inclusive") is True, f"{s} {r}")
        s, r = req("PUT", f"/api/admin/menu/items/{it['id']}",
                   {"tax_rate_bps": 10001}, token=mtok)
        ok("PUT rate out of range -> 400", s == 400, f"{s}")
        s, r = req("PUT", f"/api/admin/menu/items/{it['id']}",
                   {"tax_rate_bps": None, "tax_inclusive": False}, token=mtok)
        ok("PUT explicit null clears rate, false clears inclusive",
           s == 200 and r.get("tax_rate_bps") is None
           and r.get("tax_inclusive") is False, f"{s} {r}")
        s, r = req("PUT", f"/api/admin/menu/items/{it['id']}",
                   {"tax_rate_bps": 0}, token=mtok)
        ok("rate 0 (exempt item) is a valid stored value",
           s == 200 and r.get("tax_rate_bps") == 0, f"{s} {r}")
        s, r = req("PUT", f"/api/admin/menu/items/{it['id']}",
                   {"tax_rate_bps": 825}, token=tok)
        ok("server role cannot edit menu tax fields (403)", s == 403, f"{s}")

        # ---------- 3 per-item rates ----------
        print("\n== 3 per-item rates (hand-computed) ==")
        X = mkitem(mtok, cat_id, "QA55 X 10pct", 2000, tax_rate_bps=1000)
        Y = mkitem(mtok, cat_id, "QA55 Y default", 1000)
        A5 = mkitem(mtok, cat_id, "QA55 A 5pct", 333, tax_rate_bps=500)
        B10 = mkitem(mtok, cat_id, "QA55 B 10pct", 333, tax_rate_bps=1000)
        C775 = mkitem(mtok, cat_id, "QA55 C default", 334)
        Z0 = mkitem(mtok, cat_id, "QA55 Z exempt item", 500, tax_rate_bps=0)

        # F1: two rates + surcharge allocation.
        # bases 2000@10% / 1000@7.75%; fees 150 -> anchor(10%) 100, other 50.
        # tax = round(2100*.10) + round(1050*.0775) = 210 + 81 = 291.
        cid = open_check(tok)
        add(tok, cid, X["id"]); add(tok, cid, Y["id"])
        f1 = cid
        expect_totals("F1 two-rate", get_check(tok, cid), 3000, 150, 0, 291, 3441,
                      included=0,
                      detail=[{"rate_bps": 775, "base_cents": 1050, "tax_cents": 81, "included_cents": 0},
                              {"rate_bps": 1000, "base_cents": 2100, "tax_cents": 210, "included_cents": 0}])

        # F2: three groups, residue absorbed by the largest-base group.
        # subtotal 1000, fees 50: allocs 17 (5%), 17 (10%), anchor 16 (7.75%).
        # tax = round(350*.05)=18 + round(350*.10)=35 + round(350*.0775)=27 = 80.
        cid = open_check(tok)
        add(tok, cid, A5["id"]); add(tok, cid, B10["id"]); add(tok, cid, C775["id"])
        expect_totals("F2 residue", get_check(tok, cid), 1000, 50, 0, 80, 1130,
                      detail=[{"rate_bps": 500, "base_cents": 350, "tax_cents": 18, "included_cents": 0},
                              {"rate_bps": 775, "base_cents": 350, "tax_cents": 27, "included_cents": 0},
                              {"rate_bps": 1000, "base_cents": 350, "tax_cents": 35, "included_cents": 0}])

        # F3: rate-0 item exempt inside a taxed check.
        # fees 75: 0-group alloc round(75*500/1500)=25, anchor 50.
        # tax = round(1050*.0775) = 81.
        cid = open_check(tok)
        add(tok, cid, Z0["id"]); add(tok, cid, Y["id"])
        expect_totals("F3 rate-0 item", get_check(tok, cid), 1500, 75, 0, 81, 1656,
                      detail=[{"rate_bps": 0, "base_cents": 525, "tax_cents": 0, "included_cents": 0},
                              {"rate_bps": 775, "base_cents": 1050, "tax_cents": 81, "included_cents": 0}])

        # F4: two rates + 18% service charge at 8 guests.
        # fees 690: Y alloc round(690*1000/3000)=230, anchor X 460.
        # tax = round(2460*.10)=246 + round(1230*.0775)=95 -> 341.
        cid = open_check(tok, guests=8)
        add(tok, cid, X["id"]); add(tok, cid, Y["id"])
        expect_totals("F4 service charge", get_check(tok, cid),
                      3000, 150, 540, 341, 4031)

        # Snapshot pinning: ring at 12%, edit the rate, totals must NOT move.
        S = mkitem(mtok, cat_id, "QA55 S snap", 1000, tax_rate_bps=1200)
        cid = open_check(tok)
        ln = add(tok, cid, S["id"])
        before = get_check(tok, cid)
        expect_totals("S1 at 12%", before, 1000, 50, 0, 126, 1176)
        ok("S1 line carries the ring-time snapshot",
           ln.get("tax_rate_bps") == 1200, f"{ln.get('tax_rate_bps')}")
        s, r = req("PUT", f"/api/admin/menu/items/{S['id']}",
                   {"tax_rate_bps": 300}, token=mtok)
        assert s == 200, (s, r)
        after = get_check(tok, cid)
        ok("S2 rate edit after ring does NOT reprice the open check",
           after["totals"] == before["totals"],
           f"before {before['totals']} after {after['totals']}")
        cid = open_check(tok)
        ln = add(tok, cid, S["id"])
        expect_totals("S3 new ring uses the new rate", get_check(tok, cid),
                      1000, 50, 0, 32, 1082)
        ok("S3 line snapshot is the new rate", ln.get("tax_rate_bps") == 300)

        # ---------- 4 tax-inclusive ----------
        print("\n== 4 tax-inclusive pricing ==")
        Z = mkitem(mtok, cat_id, "QA55 Z incl", 1078, tax_inclusive=True)
        # I1: sticker 1078 -> net round(1078/1.0775)=1000, included 78.
        # surcharge on NET = 50; its tax round(50*.0775)=4 is added.
        # tax 82, guest total = sticker + fees + added tax = 1132.
        cid = open_check(tok)
        add(tok, cid, Z["id"])
        i1 = get_check(tok, cid)
        expect_totals("I1 single inclusive", i1, 1078, 50, 0, 82, 1132,
                      included=78,
                      detail=[{"rate_bps": 775, "base_cents": 1050, "tax_cents": 82, "included_cents": 78}])
        ok("I1 line flags inclusive", i1["items"][0].get("tax_inclusive") is True)

        # I2: mixed inclusive + exclusive at the same rate.
        # lineBase 2000, fees 100 all to the one group;
        # added = round((1000+100)*.0775) = 85; tax = 85 + 78 = 163.
        cid = open_check(tok)
        add(tok, cid, Z["id"]); add(tok, cid, Y["id"])
        i2 = cid
        expect_totals("I2 mixed", get_check(tok, cid), 2078, 100, 0, 163, 2263,
                      included=78,
                      detail=[{"rate_bps": 775, "base_cents": 2100, "tax_cents": 163, "included_cents": 78}])

        # I3: inclusive at its own 10% rate.
        # net round(2160/1.1)=1964, included 196; surcharge round(1964*.05)=98;
        # added round(98*.10)=10; tax 206; total 2160+98+10.
        W = mkitem(mtok, cat_id, "QA55 W incl 10pct", 2160,
                   tax_rate_bps=1000, tax_inclusive=True)
        cid = open_check(tok)
        add(tok, cid, W["id"])
        expect_totals("I3 inclusive own rate", get_check(tok, cid),
                      2160, 98, 0, 206, 2268, included=196)

        # I4: inclusive + HH — the back-out applies to the CHARGED (HH)
        # price: 1500 -> net round(1500/1.0775)=1392, included 108;
        # surcharge round(1392*.05)=70; added round(70*.0775)=5; tax 113.
        bar_cat = adm["BH Mai Tai"]["category_id"]
        H = mkitem(mtok, bar_cat, "QA55 H incl HH", 2000, hh_price_cents=1500,
                   tax_inclusive=True, station="bar", course="drink",
                   item_type="drink")
        win = {"name": "HAPPY HOUR", "start": "00:00", "end": "00:00",
               "also": ["BAR", "KEIKI", "DESSERTS"], "pricing": True}
        s, r = req("PUT", "/api/admin/dayparts", {"schedule": [win]}, token=mtok)
        assert s == 200, (s, r)
        cid = open_check(tok)
        ln = add(tok, cid, H["id"])
        ok("I4 line charged the HH price", ln.get("unit_price_cents") == 1500,
           f"{ln.get('unit_price_cents')}")
        expect_totals("I4 inclusive HH", get_check(tok, cid),
                      1500, 70, 0, 113, 1575, included=108)
        s, r = req("PUT", "/api/admin/dayparts",
                   {"schedule": [{"name": "ALL DAY", "start": "00:00",
                                  "end": "00:00", "also": ["BAR", "KEIKI", "DESSERTS"]}]},
                   token=mtok)
        assert s == 200, (s, r)

        # I5: inclusive + line discount — back-out on the discounted price.
        # lt 900 -> net round(900/1.0775)=835, included 65;
        # surcharge round(835*.05)=42; added round(42*.0775)=3; tax 68.
        cid = open_check(tok)
        ln = add(tok, cid, Z["id"])
        s, r = req("POST", f"/api/checks/{cid}/items/{ln['id']}/discount",
                   {"amount_cents": 178, "reason": "qa55"}, token=tok)
        assert s == 200, (s, r)
        expect_totals("I5 inclusive discount", get_check(tok, cid),
                      900, 42, 0, 68, 945, included=65)

        # ---------- 5 check-level exempt ----------
        print("\n== 5 check-level tax exemption ==")
        cid = open_check(tok)
        add(tok, cid, X["id"]); add(tok, cid, Y["id"])
        prior = get_check(tok, cid)["totals"]
        assert (prior["tax"], prior["total"]) == (291, 3441), prior

        s, r = req("POST", f"/api/checks/{cid}/tax-exempt",
                   {"exempt": True, "reason": "nonprofit"}, token=tok)
        ok("exempt without PIN -> 403", s == 403, f"{s} {r}")
        s, r = req("POST", f"/api/checks/{cid}/tax-exempt",
                   {"exempt": True, "manager_pin": "9999", "reason": "x"},
                   token=tok)
        ok("exempt with wrong PIN -> 403", s == 403, f"{s}")
        s, r = req("POST", f"/api/checks/{cid}/tax-exempt",
                   {"exempt": True, "manager_pin": MANAGER_PIN}, token=tok)
        ok("exempt without reason -> 400", s == 400, f"{s}")
        s, r = req("POST", f"/api/checks/{cid}/tax-exempt",
                   {"exempt": "yes", "manager_pin": MANAGER_PIN, "reason": "x"},
                   token=tok)
        ok("exempt non-boolean -> 400", s == 400, f"{s}")
        s, r = req("POST", f"/api/checks/999999/tax-exempt",
                   {"exempt": True, "manager_pin": MANAGER_PIN, "reason": "x"},
                   token=tok)
        ok("exempt on missing check -> 404", s == 404, f"{s}")

        s, r = req("POST", f"/api/checks/{cid}/tax-exempt",
                   {"exempt": True, "manager_pin": MANAGER_PIN,
                    "reason": "nonprofit cert on file"}, token=tok)
        ok("server + manager PIN sets exemption (comp idiom)",
           s == 200 and r.get("tax_exempt") is True, f"{s} {r}")
        chk = get_check(tok, cid)
        ok("exempt check: tax 0, total drops by exactly the tax",
           chk["totals"]["tax"] == 0 and chk["totals"]["total"] == 3150,
           f"{chk['totals']}")
        ok("exempt flag on the check payload", chk.get("tax_exempt") is True
           and chk["totals"].get("tax_exempt") is True)
        s, r = req("POST", f"/api/checks/{cid}/tax-exempt",
                   {"exempt": True, "manager_pin": MANAGER_PIN, "reason": "again"},
                   token=tok)
        ok("double-set -> 400", s == 400, f"{s}")

        # Partially paid, then exempted: payments stay, balance follows.
        s, r = req("POST", f"/api/checks/{cid}/payments",
                   {"method": "card_demo", "amount_cents": 1000, "tip_cents": 0,
                    "brand": "Visa", "last4": "4242"}, token=tok)
        ok("partial payment lands while exempt", s == 201, f"{s} {r}")
        chk = get_check(tok, cid)
        ok("partially-paid exempt check: balance = total - paid",
           chk["totals"]["paid"] == 1000 and chk["totals"]["balance"] == 2150,
           f"{chk['totals']}")

        s, r = req("POST", f"/api/checks/{cid}/tax-exempt",
                   {"exempt": False, "manager_pin": MANAGER_PIN,
                    "reason": "certificate revoked"}, token=mtok)
        ok("manager can reverse the exemption", s == 200
           and r.get("tax_exempt") is False, f"{s} {r}")
        chk = get_check(tok, cid)
        ok("toggle off restores the EXACT prior totals",
           chk["totals"]["tax"] == prior["tax"]
           and chk["totals"]["total"] == prior["total"]
           and chk["totals"]["balance"] == prior["total"] - 1000,
           f"{chk['totals']} vs prior {prior}")

        # Audit: both toggles logged; the failed PIN attempts logged too
        # (PIN failures carry no check_id — they are auth events).
        con = sqlite3.connect(DB2)
        rows = con.execute(
            "SELECT action FROM approval_audit WHERE check_id = ? ORDER BY id",
            (cid,)).fetchall()
        fails = con.execute(
            "SELECT COUNT(*) FROM approval_audit "
            "WHERE action = 'auth_manager_pin_failed'").fetchone()[0]
        con.close()
        actions = [a for (a,) in rows]
        ok("exempt on/off both audit-logged",
           actions.count("tax_exempt") == 2, f"{actions}")
        ok("failed PIN attempts audit-logged", fails >= 2, f"fails={fails}")

        # Closed checks refuse the toggle.
        cid2 = open_check(tok)
        add(tok, cid2, Y["id"])
        pay_close(tok, cid2)
        s, r = req("POST", f"/api/checks/{cid2}/tax-exempt",
                   {"exempt": True, "manager_pin": MANAGER_PIN, "reason": "late"},
                   token=tok)
        ok("exempt toggle on a closed check -> 400", s == 400, f"{s} {r}")

        # The designated report exempt check: Y x2, exempted, paid, closed.
        e1 = open_check(tok)
        add(tok, e1, Y["id"], qty=2)
        s, r = req("POST", f"/api/checks/{e1}/tax-exempt",
                   {"exempt": True, "manager_pin": MANAGER_PIN,
                    "reason": "school fundraiser"}, token=tok)
        assert s == 200, (s, r)
        chk = get_check(tok, e1)
        ok("report exempt check totals", chk["totals"]["tax"] == 0
           and chk["totals"]["total"] == 2100, f"{chk['totals']}")
        pay_close(tok, e1)

        # ---------- 6 insert-path snapshots: kiosk + delivery ----------
        print("\n== 6 kiosk + delivery lines snapshot the rate ==")
        s, r = req("POST", "/api/kiosk/order",
                   {"items": [{"menu_item_id": X["id"], "qty": 1}],
                    "customer_name": "QA55"})
        ok("kiosk order created", s == 201, f"{s} {str(r)[:160]}")
        kchk = (r or {}).get("check") or {}
        kline = (kchk.get("items") or [{}])[0]
        ok("kiosk line snapshot is the item rate",
           kline.get("tax_rate_bps") == 1000, f"{kline}")
        # X alone via kiosk (1 guest): subtotal 2000, surcharge 100,
        # tax round(2100*.10) = 210, total 2310.
        ok("kiosk check taxed at the item rate",
           kchk.get("totals", {}).get("tax") == 210
           and kchk.get("totals", {}).get("total") == 2310,
           f"{kchk.get('totals')}")

        s, r = req("POST", "/api/delivery/orders",
                   {"source": "QA55", "customer_name": "Dee",
                    "items": [{"menu_item_id": Z["id"], "qty": 1}]}, token=tok)
        ok("delivery order created", s in (200, 201), f"{s} {str(r)[:160]}")
        dchk = get_check(tok, r["check_id"]) if r.get("check_id") else None
        if dchk is None:
            s2, zones = req("GET", "/api/zones", token=tok)
            ok("delivery check retrievable", False, f"{str(r)[:200]}")
        else:
            dline = (dchk.get("items") or [{}])[0]
            ok("delivery line snapshot is inclusive",
               dline.get("tax_inclusive") is True, f"{dline}")
            ok("delivery inclusive totals match I1",
               dchk["totals"]["tax"] == 82
               and dchk["totals"]["total"] == 1132, f"{dchk['totals']}")

        # ---------- 7 tax report + Z ----------
        # Closed by now: cid2 (the closed-toggle refusal fixture: Y alone,
        # taxable 1050, tax 81), e1 (exempt), plus F1 and I2 closed here.
        print("\n== 7 tax report + Z reconciliation ==")
        pay_close(tok, f1, tip=100)
        pay_close(tok, i2)
        s, r = req("GET",
                   f"/api/finance/reports/tax?format=json&period=day&date={site_date}",
                   token=mtok)
        ok("tax report returns", s == 200, f"{s}")
        rep = r if isinstance(r, dict) else {}
        rows = rep.get("rows") or []
        row = rows[0] if rows else {}
        ok("report day row: checks", row.get("checks") == 4, f"{row}")
        ok("report day row: taxable = 1050 + F1 3150 + I2 2100",
           row.get("taxable_cents") == 6300, f"{row}")
        ok("report day row: tax = 81 + 291 + 163",
           row.get("tax_cents") == 535, f"{row}")
        ok("report day row: included tax", row.get("tax_included_cents") == 78,
           f"{row}")
        ok("report day row: exempt identifiable",
           row.get("exempt_checks") == 1
           and row.get("exempt_sales_cents") == 2100, f"{row}")
        ok("report day row: tips", row.get("tips_cents") == 100, f"{row}")
        extras = rep.get("extraTables") or []
        byrate = next((t for t in extras if t.get("title") == "Tax by rate"), None)
        ok("by-rate extraTable present", byrate is not None, f"{extras}")
        if byrate:
            brows = {b["rate_bps"]: b for b in byrate["rows"]}
            ok("by-rate 7.75% row", brows.get(775, {}).get("base_cents") == 4200
               and brows.get(775, {}).get("tax_cents") == 325
               and brows.get(775, {}).get("included_cents") == 78, f"{brows}")
            ok("by-rate 10% row", brows.get(1000, {}).get("base_cents") == 2100
               and brows.get(1000, {}).get("tax_cents") == 210, f"{brows}")
            tot = byrate.get("totals") or {}
            ok("by-rate sums exactly to the day row",
               tot.get("base_cents") == row.get("taxable_cents")
               and tot.get("tax_cents") == row.get("tax_cents"), f"{tot}")
        s, csv = req("GET",
                     f"/api/finance/reports/tax?format=csv&period=day&date={site_date}",
                     token=mtok, raw=True)
        ok("CSV carries the by-rate table + exempt columns",
           s == 200 and "Tax by rate" in csv and "Exempt checks" in csv,
           f"{s}")

        s, pre = req("GET", f"/api/finance/close-day?date={site_date}", token=mtok)
        expected = pre.get("expected_cash_cents")
        s, co = req("POST", "/api/finance/close-day",
                    {"manager_pin": MANAGER_PIN,
                     "counted_cash_cents": expected, "date": site_date},
                    token=mtok)
        ok("close-day succeeds", s == 201, f"{s} {str(co)[:160]}")
        snap = (co or {}).get("snapshot") or {}
        ok("Z snapshot tax row IS the report row (verbatim builder)",
           snap.get("tax") == row, f"{snap.get('tax')} vs {row}")
    finally:
        stop(srv)


# =====================================================================
_lamport = [0]


def env_op(op_id, op, payload):
    _lamport[0] += 1
    return {"op_id": op_id, "site_slug": "bali-hai", "device_id": "qa55",
            "seq": _lamport[0], "lamport": _lamport[0], "op": op,
            "payload": payload, "created_at": "2026-10-06T15:00:00.000Z"}


def phase3_lan():
    print("\n== 8 LAN menu_update carry + add_items snapshot ==")
    if os.path.exists(LAN_DB):
        os.remove(LAN_DB)
    env = {"EXPOLINE_LAN": "1", "EXPOLINE_LAN_GOSSIP_PIN": "qa55-gossip",
           "EXPOLINE_BRAIN_PRIORITY": "0", "EXPOLINE_DEVICE_ID": "qa55-a",
           "EXPOLINE_LAN_PEERS": f"127.0.0.1:{LAN_PORT}"}
    srv = boot(LAN_PORT, LAN_DB, env)
    try:
        mtok = login(MANAGER_PIN, base=LAN_BASE)
        tok = login(SERVER_PIN, base=LAN_BASE)
        adm = admin_items(mtok, base=LAN_BASE)
        cat_id = next(iter(adm.values()))["category_id"]
        it = mkitem(mtok, cat_id, "QA55 LAN item", 1000, base=LAN_BASE)
        iid = it["id"]

        def menu_update(op_id, payload):
            s, r = req("POST", "/api/sync/batch",
                       {"ops": [env_op(op_id, "menu_update", payload)]},
                       token=mtok, base=LAN_BASE)
            assert s == 200, (s, r)
            return (r.get("results") or [{}])[0]

        r1 = menu_update("qa55-lan-1", {"item_id": iid, "version": 2,
                                        "tax_rate_bps": 925,
                                        "tax_inclusive": True})
        ok("menu_update applies the tax fields",
           r1.get("ok") is True and r1.get("tax_rate_bps") == 925
           and r1.get("tax_inclusive") is True, f"{r1}")
        got = admin_items(mtok, base=LAN_BASE)["QA55 LAN item"]
        ok("brain menu shows the carried tax fields",
           got.get("tax_rate_bps") == 925 and got.get("tax_inclusive") is True,
           f"{got}")

        r2 = menu_update("qa55-lan-2", {"item_id": iid, "version": 3,
                                        "price_cents": 1200})
        got = admin_items(mtok, base=LAN_BASE)["QA55 LAN item"]
        ok("pre-field payload leaves tax fields untouched (guarded)",
           r2.get("ok") is True and got.get("tax_rate_bps") == 925
           and got.get("tax_inclusive") is True
           and got.get("price_cents") == 1200, f"{r2} {got}")

        r3 = menu_update("qa55-lan-3", {"item_id": iid, "version": 4,
                                        "tax_rate_bps": None,
                                        "tax_inclusive": False})
        got = admin_items(mtok, base=LAN_BASE)["QA55 LAN item"]
        ok("explicit null/false clears via the op",
           r3.get("ok") is True and got.get("tax_rate_bps") is None
           and got.get("tax_inclusive") is False, f"{r3} {got}")

        # add_items on the brain snapshots the item's CURRENT tax setting.
        menu_update("qa55-lan-4", {"item_id": iid, "version": 5,
                                   "tax_rate_bps": 925})
        t = free_table(tok, base=LAN_BASE)
        ops = [
            env_op("qa55-lan-c1", "open_check",
                   {"check_uuid": "qa55-lan-check", "table_id": t["id"],
                    "guest_count": 2}),
            env_op("qa55-lan-c2", "add_items",
                   {"check_uuid": "qa55-lan-check",
                    "items": [{"item_uuid": "qa55-lan-line",
                               "menu_item_id": iid, "seat": 1, "qty": 1}]}),
        ]
        s, r = req("POST", "/api/sync/batch", {"ops": ops},
                   token=tok, base=LAN_BASE)
        results = r.get("results") or []
        ok("brain open_check + add_items ok",
           s == 200 and all(x.get("ok") for x in results), f"{s} {results}")
        cid = results[0].get("check_id") if results else None
        chk = get_check(tok, cid, base=LAN_BASE)
        line = (chk.get("items") or [{}])[0]
        ok("brain line snapshot is 925 bps", line.get("tax_rate_bps") == 925,
           f"{line}")
        # 1200c at 9.25%: surcharge round(1200*.05)=60;
        # tax round(1260*.0925)=117; total 1200+60+117.
        ok("brain totals use the snapshotted rate (host calcTotals)",
           chk["totals"]["tax"] == 117 and chk["totals"]["total"] == 1377,
           f"{chk['totals']}")
    finally:
        stop(srv)


def main():
    phase1_equivalence()
    phase2_fixtures()
    phase3_lan()
    print(f"\n{'=' * 60}")
    print(f"test55 tax breadth: {passed} passed, {failed} failed")
    if failures:
        print("FAILURES:")
        for f in failures:
            print(f"  - {f}")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
