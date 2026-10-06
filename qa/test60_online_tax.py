#!/usr/bin/env python3
"""Expoline online tax parity — qa/test60_online_tax.py.

WHY: the tax-breadth batch (85d42fa/83b91bb) gave floor/guest/kiosk
checks per-item tax semantics — menu_items.tax_rate_bps (null = site
default, 0 = exempt) and tax_inclusive (the sticker already contains
the tax; calcTotals backs it out per line) — but routes/online.js kept
its own flat math: tax = Math.round(subtotal * site rate) on the FULL
sticker subtotal. Proven consequence (test59 E4, pre-parity): a $20.00
inclusive item ordered online totaled $21.55 (tax charged ON TOP)
while the same item on a guest check totaled $20.00 with the tax
backed out. Same item, two tax treatments by channel. This batch gives
online totals the floor's semantics, fee-free (online has NO
surcharge/service charge — none is added):

  tax = Σ over rate groups of Math.round(groupExclusiveBase * rate)
        + Σ per-line included back-outs
      — exactly calcTotals with fees = 0 (alloc = 0): exclusive bases
        group by the effective rate DOUBLE (bps/10000 is the identical
        double to the parsed site rate, so classic carts form ONE
        group and the operation is the identical
        Math.round(subtotal * rate) the old code ran — section A is
        the byte-equivalence anchor);
      — inclusive back-out per line on the CHARGED line total:
        net = Math.round(lt / (1 + rate)), included = lt - net,
        and included counts in tax_cents but NOT in the guest total.

Placement snapshots each line's tax treatment (tax_rate_bps +
tax_inclusive via the host's taxSnapshotOf) into items_json and stores
tax_included_cents on the order row; read-backs serve the stored
values, so a later menu edit cannot move a placed order (section D).
The client (public/views/online.js) computes the same math via the
pure top-level oloTaxCalc (section F drives it in node and compares
against server-placed orders) and the online menu finally renders the
"Tax included" label — true now that the math honors it (section E).

Sections:
  A  equivalence battery: classic carts (all default-rate,
     non-inclusive) byte-identical money at 686bfc4 and HEAD, each
     also hand-anchored.
  B  per-item rates: 0 bps exempt, custom 1200 bps, a mixed cart
     hand-computed to the cent, and grouped (not per-line) rounding.
  C  inclusive: default-rate back-out (incl. the qty-2 line), custom
     rate, the rate-0 inclusive edge (floor's rate>0 rule), a mixed
     inclusive+exclusive cart, and cross-channel equality vs a guest
     check (tax_included_cents and sticker subtotal).
  D  snapshot discipline: place, edit the items' rate/flag, read back
     via /last and the kitchen view — byte-identical.
  E  payload + label: menu fields (raw + effective rate, flag), the
     order payload's tax_included_cents + line snapshots, and the
     view pins (paren-anchored label condition, negation absence,
     checkout wired to the real math, no "calc. at confirmation").
  F  client math: oloTaxCalc extracted and run in node — fixtures
     match hand computation AND a server-placed order's tax figures.
  G  click path: harness60_client.js drives the REAL view in node
     behind a minimal DOM stub (no jsdom in this repo) — render, add,
     Checkout click, slot click, Back. Pins the 2026-10-06 live find:
     viewCheckout() assigned `h._slots = slots` onto a primitive
     string in a 'use strict' file, throwing inside paint() before
     innerHTML was set, so Checkout had been frozen since 154b396
     (2026-09-25) while every API suite stayed green. With the stray
     line restored in a scratch copy the harness fails 9/11 with that
     exact TypeError; at HEAD it passes 11/11.
  Z  discriminating control at 686bfc4: inclusive item taxed ON TOP
     (2155), custom-rate item taxed at the site rate, no
     tax_included_cents key, no line snapshot fields, no label.

Hand anchors (site rate 7.75% = 775 bps):
  A1 2*1234 + 3*777 = 4799; tax round(4799*.0775) = 372; total 5171
  A2 1234; tax round(95.635) = 96; total 1330
  A3 5*777 + 1234 = 5119; tax round(396.7225) = 397; total 5516
  A4 20*777 = 15540; tax round(1204.35) = 1204; total 16744
  B3 groups: 0bps -> 0; 1200bps: round(2500*.12) = 300;
     775: round(1234*.0775) = 96 -> tax 396 on subtotal 4734
  B4 two 1001 lines at default rate: GROUPED round(2002*.0775) = 155
     (per-line rounding would give 78+78 = 156 — calcTotals groups)
  C1 $20.00 inclusive @7.75%: net round(2000/1.0775) = 1856,
     included 144, tax 144, total 2000 (the FLOOR's figure — test59 F5)
  C2 qty 2: lt 4000, net round(4000/1.0775) = 3712, included 288
  C3 $30.00 inclusive @10%: net round(3000/1.1) = 2727, included 273
  C5 mixed: included 144 + round(1234*.0775) = 96 -> tax 240,
     subtotal 3234, total 3330

Boot discipline mirrors test58: ports 4417 (HEAD) / 4418 (control,
pristine 686bfc4 worktree), own scratch DBs, HEAD server restarted
between sections to reset the in-memory order rate limit.
"""
import json, math, os, re, signal, subprocess, sys, time
import urllib.request, urllib.error
from pathlib import Path

ROOT = Path("/home/hatch/workspace/goals/expo-line-pos-beat-toast-spoton-pilot-at-bali-hai/build/expoline")
PORT, CPORT = 4417, 4418
BASE = f"http://127.0.0.1:{PORT}"
CBASE = f"http://127.0.0.1:{CPORT}"
DB = "/tmp/test60_online_tax.db"
CDB = "/tmp/test60_online_tax_ctrl.db"
WT = "/tmp/wt60_686bfc4"
BASE_COMMIT = "686bfc4"

passed, failed = 0, 0
failures = []

def ok(name, cond, extra=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"  PASS {name}")
    else:
        failed += 1
        failures.append(name)
        print(f"  FAIL {name} {extra}")

def mround(x):
    """JS Math.round for positive values."""
    return math.floor(x + 0.5)

def req(method, path, body=None, token=None, base=BASE):
    r = urllib.request.Request(base + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json",
                 **({"Authorization": "Bearer " + token} if token else {})})
    try:
        with urllib.request.urlopen(r) as resp:
            return resp.status, json.loads(resp.read() or b"null")
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw or "{}")
        except Exception:
            return e.code, {"raw": raw}

def wait_up(base, timeout=30):
    for _ in range(int(timeout * 2)):
        try:
            s, _ = req("GET", "/api/health", base=base)
            if s == 200:
                return True
        except Exception:
            pass
        time.sleep(0.5)
    return False

def boot(port, db, cwd=ROOT):
    subprocess.run(f"lsof -ti:{port} | xargs -r kill -9 2>/dev/null", shell=True)
    time.sleep(1)
    env = dict(os.environ, EXPOLINE_PORT=str(port), EXPOLINE_DB=db)
    p = subprocess.Popen(["node", "server.js"], cwd=str(cwd), env=env,
                         stdout=open(f"/tmp/test60_boot_{port}.log", "a"),
                         stderr=subprocess.STDOUT, start_new_session=True)
    assert wait_up(f"http://127.0.0.1:{port}"), f"server on {port} did not come up"
    return p

def stop(p):
    if p and p.poll() is None:
        p.send_signal(signal.SIGTERM)
        try:
            p.wait(timeout=10)
        except Exception:
            p.kill()

def login(pin, base=BASE):
    s, r = req("POST", "/api/auth/login", {"pin": pin}, base=base)
    assert s == 200, (s, r)
    return r["token"]

def src_of(relpath, root=ROOT):
    return (root / relpath).read_text()

def mk_item(mtok, cat_id, name, price, tax_bps="ABSENT", incl="ABSENT", base=BASE):
    body = {"name": name, "price_cents": price, "category_id": cat_id,
            "station": "expediter", "course": "entree"}
    if tax_bps != "ABSENT":
        body["tax_rate_bps"] = tax_bps
    if incl != "ABSENT":
        body["tax_inclusive"] = incl
    s, r = req("POST", "/api/admin/menu/items", body, token=mtok, base=base)
    assert s == 201, (s, r)
    return r["id"]

def first_cat(mtok, base=BASE):
    s, adm = req("GET", "/api/admin/menu", token=mtok, base=base)
    assert s == 200, (s, adm)
    cats = adm if isinstance(adm, list) else adm.get("categories", [])
    return [it for c in cats for it in c.get("items", [])][0]["category_id"]

def fixture(mtok, base=BASE):
    cat = first_cat(mtok, base)
    return {
        "c1": mk_item(mtok, cat, "QA60 Classic One", 1234, base=base),
        "c2": mk_item(mtok, cat, "QA60 Classic Two", 777, base=base),
        "odd": mk_item(mtok, cat, "QA60 Odd", 1001, base=base),
        "exempt": mk_item(mtok, cat, "QA60 Exempt", 1000, tax_bps=0, base=base),
        "custom": mk_item(mtok, cat, "QA60 Custom 12", 2500, tax_bps=1200, base=base),
        "incl": mk_item(mtok, cat, "QA60 Incl", 2000, incl=True, base=base),
        "incl10": mk_item(mtok, cat, "QA60 Incl 10", 3000, tax_bps=1000, incl=True, base=base),
        "incl0": mk_item(mtok, cat, "QA60 Incl Zero", 1500, tax_bps=0, incl=True, base=base),
    }

def place(items, phone, base=BASE, name="QA60"):
    return req("POST", "/api/online/orders",
               {"customer_name": name, "phone": phone, "items": items}, base=base)

def money(o):
    return (o.get("subtotal_cents"), o.get("tax_cents"), o.get("total_cents"))

def linesig(o):
    return sorted((i["name"], i["qty"], i["unit_price_cents"]) for i in o.get("items", []))

def online_items(base=BASE):
    s, menu = req("GET", "/api/online/menu", base=base)
    assert s == 200, (s, menu)
    return {it["id"]: it for c in menu for it in (c.get("items") or [])}

def main():
    for f in (DB, CDB):
        try:
            os.unlink(f)
        except FileNotFoundError:
            pass
    subprocess.run(["git", "worktree", "remove", "--force", WT], cwd=ROOT,
                   capture_output=True)
    subprocess.run(["git", "worktree", "add", WT, BASE_COMMIT], cwd=ROOT,
                   check=True, capture_output=True)
    os.symlink(ROOT / "node_modules", Path(WT) / "node_modules")

    srv = boot(PORT, DB)
    ctrl = boot(CPORT, CDB, cwd=WT)
    try:
        mtok = login("2580")
        ids = fixture(mtok)
        cmtok = login("2580", base=CBASE)
        cids = fixture(cmtok, base=CBASE)

        print("--- A: equivalence battery — classic carts, 686bfc4 vs HEAD ---")
        carts = [
            ("A1", [("c1", 2), ("c2", 3)], (4799, 372, 5171)),
            ("A2", [("c1", 1)], (1234, 96, 1330)),
            ("A3", [("c2", 5), ("c1", 1)], (5119, 397, 5516)),
            ("A4", [("c2", 20)], (15540, 1204, 16744)),
        ]
        for tag, cart, want in carts:
            items = [{"menu_item_id": ids[k], "qty": q} for k, q in cart]
            s_h, o_h = place(items, f"5556001{tag[1]}01")
            citems = [{"menu_item_id": cids[k], "qty": q} for k, q in cart]
            s_c, o_c = place(citems, f"5556001{tag[1]}01", base=CBASE)
            ok(f"{tag} HEAD money == hand anchor and byte-identical to 686bfc4",
               s_h == 201 and s_c == 201 and money(o_h) == want
               and money(o_c) == money(o_h) and linesig(o_c) == linesig(o_h)
               and o_h.get("tax_included_cents") == 0,
               (s_h, money(o_h), s_c, money(o_c)))

        # ---- restart: fresh rate-limit bucket for B+C ----
        stop(srv); srv = boot(PORT, DB)
        mtok, stok = login("2580"), login("1111")
        ids = fixture(mtok)

        print("--- B: per-item rates ---")
        s, o = place([{"menu_item_id": ids["exempt"], "qty": 2}], "5556002001")
        ok("B1 0-bps item contributes no tax",
           s == 201 and money(o) == (2000, 0, 2000) and o.get("tax_included_cents") == 0,
           (s, o))
        s, o = place([{"menu_item_id": ids["custom"], "qty": 1}], "5556002002")
        ok("B2 custom 1200-bps item taxed at 12%",
           s == 201 and money(o) == (2500, 300, 2800), (s, o))
        s, o = place([{"menu_item_id": ids["exempt"], "qty": 1},
                      {"menu_item_id": ids["custom"], "qty": 1},
                      {"menu_item_id": ids["c1"], "qty": 1}], "5556002003")
        # subtotal 1000+2500+1234 = 4734; groups: 0 -> 0, 1200 -> 300, 775 -> 96
        ok("B3 mixed-rate cart hand-computed (tax 396)",
           s == 201 and money(o) == (4734, 396, 5130), (s, o))
        s, o = place([{"menu_item_id": ids["odd"], "qty": 1},
                      {"menu_item_id": ids["odd"], "qty": 1}], "5556002004")
        # GROUPED rounding: round(2002*.0775) = 155 (per-line would be 156)
        ok("B4 rounding is per rate GROUP, not per line (155, not 156)",
           s == 201 and money(o) == (2002, 155, 2157), (s, o))

        print("--- C: tax-inclusive ---")
        s, o_incl1 = place([{"menu_item_id": ids["incl"], "qty": 1}], "5556003001")
        ok("C1 $20 inclusive at default rate: total stays $20.00, tax 144 all included",
           s == 201 and money(o_incl1) == (2000, 144, 2000)
           and o_incl1.get("tax_included_cents") == 144, (s, o_incl1))
        s, o = place([{"menu_item_id": ids["incl"], "qty": 2}], "5556003002")
        ok("C2 qty-2 inclusive line backs out on the line total (288)",
           s == 201 and money(o) == (4000, 288, 4000)
           and o.get("tax_included_cents") == 288, (s, o))
        s, o = place([{"menu_item_id": ids["incl10"], "qty": 1}], "5556003003")
        ok("C3 inclusive at custom 10% rate (included 273)",
           s == 201 and money(o) == (3000, 273, 3000)
           and o.get("tax_included_cents") == 273, (s, o))
        s, o = place([{"menu_item_id": ids["incl0"], "qty": 1}], "5556003004")
        ok("C4 inclusive flag at 0 bps: no back-out, no tax (floor's rate>0 rule)",
           s == 201 and money(o) == (1500, 0, 1500)
           and o.get("tax_included_cents") == 0, (s, o))
        s, o_mix = place([{"menu_item_id": ids["incl"], "qty": 1},
                          {"menu_item_id": ids["c1"], "qty": 1}], "5556003005")
        ok("C5 inclusive + exclusive mixed cart (tax 144 incl + 96 added = 240)",
           s == 201 and money(o_mix) == (3234, 240, 3330)
           and o_mix.get("tax_included_cents") == 144, (s, o_mix))
        # Cross-channel: the same cart on a guest check (calcTotals).
        # The guest check adds a surcharge, so its TOTAL tax differs —
        # the parity claim is the item's included tax + sticker subtotal.
        s, qr_r = req("GET", "/api/tables/1/qr", token=stok)
        assert s == 200, (s, qr_r)
        s, go = req("POST", "/api/guest/orders",
                    {"token": qr_r["token"], "guest_name": "QA60",
                     "items": [{"menu_item_id": ids["incl"], "qty": 1, "seat": 1},
                               {"menu_item_id": ids["c1"], "qty": 1, "seat": 1}]})
        assert s == 201, (s, go)
        gt = go["totals"]
        ok("C6 cross-channel: guest check and online agree on included tax + subtotal",
           gt.get("tax_included_cents") == o_mix.get("tax_included_cents") == 144
           and gt.get("subtotal") == o_mix.get("subtotal_cents") == 3234,
           (gt, o_mix))

        # ---- restart: fresh rate-limit bucket for E+D+F ----
        stop(srv); srv = boot(PORT, DB)
        mtok, stok, ktok = login("2580"), login("1111"), login("2222")
        ids = fixture(mtok)

        print("--- E: payload + label ---")
        oi = online_items()
        ok("E1 menu payload: inclusive item flag true, raw rate null, effective 775",
           oi[ids["incl"]].get("tax_inclusive") is True
           and oi[ids["incl"]].get("tax_rate_bps") is None
           and oi[ids["incl"]].get("effective_tax_rate_bps") == 775, oi[ids["incl"]])
        ok("E2 menu payload: custom-rate item raw + effective 1200, flag false; exempt effective 0",
           oi[ids["custom"]].get("tax_rate_bps") == 1200
           and oi[ids["custom"]].get("effective_tax_rate_bps") == 1200
           and oi[ids["custom"]].get("tax_inclusive") is False
           and oi[ids["exempt"]].get("effective_tax_rate_bps") == 0, oi[ids["custom"]])
        s, o = place([{"menu_item_id": ids["incl"], "qty": 1}], "5556005001")
        line = (o.get("items") or [{}])[0]
        ok("E3 order payload: tax_included_cents + per-line tax snapshot",
           s == 201 and o.get("tax_included_cents") == 144
           and line.get("tax_inclusive") is True and line.get("tax_rate_bps") is None,
           (s, o))
        vsrc = src_of("public/views/online.js")
        ok("E4 label pin: paren-anchored flag-conditioned render + pill CSS",
           "(it.tax_inclusive ? '<span class=\"olo-taxincl\">Tax included</span>'" in vsrc
           and ".olo-taxincl{" in vsrc)
        ok("E5 label polarity: no negated-flag occurrence anywhere in the view",
           not re.search(r"!\s*it\.tax_inclusive", vsrc))
        ok("E6 checkout wired to the real math (no 'calc. at confirmation' left)",
           "const tx = cartTax();" in vsrc
           and "sub + tx.tax_cents - tx.tax_included_cents" in vsrc
           and "calc. at confirmation" not in vsrc)
        rsrc = src_of("routes/online.js")
        ok("E7 route pins: placement snapshots via taxSnapshotOf",
           "taxSnapshotOf" in rsrc and "tax_rate_bps: taxSnap.tax_rate_bps" in rsrc)

        print("--- D: snapshot discipline ---")
        s, placed = place([{"menu_item_id": ids["custom"], "qty": 1},
                           {"menu_item_id": ids["incl"], "qty": 1}], "5556004001")
        # subtotal 4500; tax = round(2500*.12) 300 added + 144 included = 444
        ok("D1 placement money (4500 / 444 / total 4800)",
           s == 201 and money(placed) == (4500, 444, 4800)
           and placed.get("tax_included_cents") == 144, (s, placed))
        s, r = req("PUT", f"/api/admin/menu/items/{ids['custom']}",
                   {"tax_rate_bps": 500}, token=mtok)
        assert s == 200, (s, r)
        s, r = req("PUT", f"/api/admin/menu/items/{ids['incl']}",
                   {"tax_inclusive": False, "tax_rate_bps": 300}, token=mtok)
        assert s == 200, (s, r)
        oi = online_items()
        ok("D2 the menu edits really landed (rate 500; flag off, effective 300)",
           oi[ids["custom"]].get("effective_tax_rate_bps") == 500
           and oi[ids["incl"]].get("tax_inclusive") is False
           and oi[ids["incl"]].get("effective_tax_rate_bps") == 300,
           (oi[ids["custom"]], oi[ids["incl"]]))
        s, last = req("GET", "/api/online/last?phone=5556004001")
        ok("D3 read-back via /last: byte-identical to the placement response",
           s == 200 and json.dumps(last, sort_keys=True) == json.dumps(placed, sort_keys=True),
           (s, last, placed))
        s, one = req("GET", f"/api/online/orders/{placed['id']}", token=ktok)
        ok("D4 read-back via kitchen view: byte-identical too",
           s == 200 and json.dumps(one, sort_keys=True) == json.dumps(placed, sort_keys=True),
           (s, one))

        print("--- F: client math (oloTaxCalc in node) vs server ---")
        m = re.search(r"function oloTaxCalc\(entries\) \{.*?\n\}", vsrc, re.S)
        assert m, "oloTaxCalc not found in views/online.js"
        driver = m.group(0) + """
const cases = [
  [{total_cents: 2000, rate_bps: 775, inclusive: true}],
  [{total_cents: 2000, rate_bps: 775, inclusive: true},
   {total_cents: 1234, rate_bps: 775, inclusive: false},
   {total_cents: 2500, rate_bps: 1200, inclusive: false},
   {total_cents: 1000, rate_bps: 0, inclusive: false}],
  [{total_cents: 1001, rate_bps: 775, inclusive: false},
   {total_cents: 1001, rate_bps: 775, inclusive: false}],
  [{total_cents: 1500, rate_bps: 0, inclusive: true}],
];
console.log(JSON.stringify(cases.map(oloTaxCalc)));
"""
        Path("/tmp/test60_client.js").write_text(driver)
        out = subprocess.run(["node", "/tmp/test60_client.js"],
                             capture_output=True, text=True)
        assert out.returncode == 0, out.stderr
        cres = json.loads(out.stdout.strip())
        ok("F1 client math: inclusive back-out + mixed groups + grouped rounding + rate-0",
           cres == [{"tax_cents": 144, "tax_included_cents": 144},
                    {"tax_cents": 540, "tax_included_cents": 144},
                    {"tax_cents": 155, "tax_included_cents": 0},
                    {"tax_cents": 0, "tax_included_cents": 0}], cres)
        # Server side of client case 2, on FRESH items (section D edited
        # the shared fixtures): incl 2000 + classic 1234 + custom 2500
        # + exempt 1000 -> subtotal 6734, tax 540 (144 included),
        # total 6734 + (540 - 144) = 7130.
        cat = first_cat(mtok)
        f_incl = mk_item(mtok, cat, "QA60 F Incl", 2000, incl=True)
        f_custom = mk_item(mtok, cat, "QA60 F Custom", 2500, tax_bps=1200)
        s, o = place([{"menu_item_id": f_incl, "qty": 1},
                      {"menu_item_id": ids["c1"], "qty": 1},
                      {"menu_item_id": f_custom, "qty": 1},
                      {"menu_item_id": ids["exempt"], "qty": 1}], "5556006001")
        ok("F2 client case 2 == server-placed order, to the cent",
           s == 201 and money(o) == (6734, 540, 7130)
           and o.get("tax_included_cents") == cres[1]["tax_included_cents"] == 144
           and o.get("tax_cents") == cres[1]["tax_cents"], (s, o, cres))

        print("--- G: click path — the real view driven end-to-end ---")
        ok("G1 source pin: no property assignment onto the string accumulator; "
           "the function-object slot stash remains",
           "h._slots" not in vsrc and "viewCheckout._slots = slots;" in vsrc)
        hout = subprocess.run(["node", str(ROOT / "qa" / "harness60_client.js")],
                              capture_output=True, text=True)
        hres = {}
        for line in hout.stdout.splitlines():
            if line.startswith("@@RESULT@@"):
                try:
                    hres = json.loads(line[len("@@RESULT@@"):])
                except Exception:
                    hres = {}
        ok("G2 harness60 process: exit 0 with a RESULT line",
           hout.returncode == 0 and bool(hres),
           (hout.returncode, hout.stdout[-400:], hout.stderr[-400:]))
        for gname in ["menu_renders_both_items", "checkout_button_appears_after_adds",
                      "checkout_replaces_menu", "subtotal_figure_3234",
                      "tax_figure_240", "includes_row_144", "due_figure_3330",
                      "slot_click_uses_stash", "back_returns_to_menu_cart_kept",
                      "no_unexpected_api_calls", "drive_completed_without_throw"]:
            ok(f"G3 click-path: {gname}", hres.get(gname) is True, hres.get(gname))

        print("--- Z: discriminating control at 686bfc4 ---")
        s, o = place([{"menu_item_id": cids["incl"], "qty": 1}], "5556009001", base=CBASE)
        ok("Z1 CONTROL: inclusive item taxed ON TOP (2000/155/2155), no included key",
           s == 201 and money(o) == (2000, 155, 2155)
           and "tax_included_cents" not in o, (s, o))
        s, o = place([{"menu_item_id": cids["custom"], "qty": 1}], "5556009002", base=CBASE)
        ok("Z2 CONTROL: custom-rate item taxed at the SITE rate (194)",
           s == 201 and money(o) == (2500, 194, 2694), (s, o))
        coi = online_items(base=CBASE)
        ok("Z3 CONTROL: base online menu carries no tax fields",
           "tax_inclusive" not in coi[cids["incl"]]
           and "effective_tax_rate_bps" not in coi[cids["incl"]]
           and "tax_rate_bps" not in coi[cids["incl"]], coi[cids["incl"]])
        ok("Z4 CONTROL: base view has no label and no oloTaxCalc",
           "Tax included" not in src_of("public/views/online.js", Path(WT))
           and "oloTaxCalc" not in src_of("public/views/online.js", Path(WT)))
    finally:
        stop(srv)
        stop(ctrl)
        subprocess.run(["git", "worktree", "remove", "--force", WT], cwd=ROOT,
                       capture_output=True)

    print(f"\n==== test60_online_tax: {passed} passed, {failed} failed ====")
    if failures:
        print("FAILURES:", failures)
    return 1 if failed else 0

if __name__ == "__main__":
    sys.exit(main())
