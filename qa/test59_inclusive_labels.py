#!/usr/bin/env python3
"""Expoline tax-inclusive guest labels — qa/test59_inclusive_labels.py.

WHY: the tax-breadth batch (gap #9) made menu items optionally
tax-INCLUSIVE (menu_items.tax_inclusive — the sticker price already
contains the tax; calcTotals backs the tax out and reports it as
totals.tax_included). It disclosed one gap: the GUEST menu didn't
LABEL inclusive items — guest totals were right, a guest just
couldn't tell the price already included tax. This rider adds the
"Tax included" label — but ONLY where the label is TRUE:

  IN  guest QR menu (/api/guest/menu -> public/views/guest.js):
      guest order totals run through persistTotals/calcTotals, which
      back inclusive tax OUT of the sticker price. Label is true.
  IN  kiosk menu (/api/kiosk/menu -> public/views/kiosk.js) and the
      TV menu boards (/api/menuboards -> public/views/menuboards.js),
      which share routes/kiosk.js buildMenu: kiosk orders snapshot
      the flag and total through persistTotals/calcTotals too.
  ONLINE ordering (/api/online/menu -> public/views/online.js) was
      OUT of scope for the original rider: routes/online.js priced
      orders with its own flat math — tax = Math.round(subtotal *
      site rate) on the FULL sticker price, no per-item rate, no
      inclusive back-out — so a "Tax included" label there would have
      been a LIE, and section E pinned that exclusion. The online
      tax-parity batch (test60) then gave online orders the floor's
      per-item tax semantics, so the exclusion is LIFTED: section E
      now pins the parity (payload carries the flag, view renders the
      label conditioned on it, route applies the semantics, and a
      placed order's tax is hand-verified to be the BACKED-OUT amount
      — the exact behavior change test60 proves exhaustively).

This batch is presentation + payload passthrough ONLY — no totals
change anywhere. Section F is the equivalence anchor: a guest order
and a kiosk order containing inclusive items produce byte-identical
totals at a368b34 (base) and at HEAD, including through guest pay.

Rendering pins are source-level (the house pattern — cf. test58
section H): guest.js/kiosk.js/menuboards.js are standalone DOM-boot
IIFEs with no node harness in the repo, so the suite pins the exact
flag-conditioned render expressions plus the payload contract that
drives them. The pins are polarity-discriminating: each anchors the
condition's opening paren (so "(!i.tax_inclusive ? ..." does NOT
satisfy them), and each in-scope view file is asserted free of any
negated-flag occurrence anywhere in the file, so an inverted
condition — label on every NON-inclusive item, no inclusive item —
fails the suite.

Boot discipline mirrors test58: this suite owns ports 4345 (HEAD)
and 4346 (control, pristine a368b34 worktree) and its own scratch DBs.
"""
import json, os, re, signal, subprocess, sys, time
import urllib.request, urllib.error
from pathlib import Path

ROOT = Path("/home/hatch/workspace/goals/expo-line-pos-beat-toast-spoton-pilot-at-bali-hai/build/expoline")
PORT, CPORT = 4345, 4346
BASE = f"http://127.0.0.1:{PORT}"
CBASE = f"http://127.0.0.1:{CPORT}"
DB = "/tmp/test59_incl.db"
CDB = "/tmp/test59_incl_ctrl.db"
WT = "/tmp/wt59_a368b34"
BASE_COMMIT = "a368b34"

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
                         stdout=open(f"/tmp/test59_boot_{port}.log", "a"),
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

def mk_item(mtok, cat_id, name, price, tax_inclusive="ABSENT", base=BASE):
    body = {"name": name, "price_cents": price, "category_id": cat_id,
            "station": "expediter", "course": "entree"}
    if tax_inclusive != "ABSENT":
        body["tax_inclusive"] = tax_inclusive
    s, r = req("POST", "/api/admin/menu/items", body, token=mtok, base=base)
    assert s == 201, (s, r)
    return r["id"]

def fixture(mtok, base=BASE):
    """Three probe items in the first seeded category: flag set true,
    flag never sent (create default), flag set false explicitly."""
    s, adm = req("GET", "/api/admin/menu", token=mtok, base=base)
    assert s == 200, (s, adm)
    cats = adm if isinstance(adm, list) else adm.get("categories", [])
    cat_id = [it for c in cats for it in c.get("items", [])][0]["category_id"]
    return {
        "incl": mk_item(mtok, cat_id, "QA59 Incl", 2000, True, base),
        "plain": mk_item(mtok, cat_id, "QA59 Plain", 1000, "ABSENT", base),
        "expl": mk_item(mtok, cat_id, "QA59 Expl", 1550, False, base),
    }

def flat_menu(payload):
    return {it["id"]: it for c in payload.get("categories", [])
            for it in (c.get("items") or [])}

def guest_items(qr, base=BASE):
    s, m = req("GET", f"/api/guest/menu?token={qr}", base=base)
    assert s == 200, (s, m)
    return flat_menu(m)

def kiosk_items(base=BASE):
    s, m = req("GET", "/api/kiosk/menu", base=base)
    assert s == 200, (s, m)
    return flat_menu(m)

def totals_json(t):
    return json.dumps(t, sort_keys=True)

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
        mtok, stok = login("2580"), login("1111")
        ids = fixture(mtok)
        s, qr_r = req("GET", "/api/tables/1/qr", token=stok)
        assert s == 200, (s, qr_r)
        qr = qr_r["token"]

        print("--- A: guest QR menu payload carries the flag ---")
        gi = guest_items(qr)
        ok("A1 inclusive item: tax_inclusive true",
           gi[ids["incl"]].get("tax_inclusive") is True, gi[ids["incl"]])
        ok("A2 flag never set at create: tax_inclusive false",
           gi[ids["plain"]].get("tax_inclusive") is False, gi[ids["plain"]])
        ok("A3 explicit false at create: tax_inclusive false",
           gi[ids["expl"]].get("tax_inclusive") is False, gi[ids["expl"]])
        ok("A4 allowlist discipline: item keys exactly the guest set",
           set(gi[ids["incl"]].keys()) == {
               "id", "name", "description", "price_cents", "hh_price_cents",
               "effective_price_cents", "hh_active", "tax_inclusive",
               "item_type", "course", "modifiers"},
           sorted(gi[ids["incl"]].keys()))

        print("--- B: guest view renders the label (source pins) ---")
        gsrc = src_of("public/views/guest.js")
        ok("B1 label copy + pill class present",
           "Tax included" in gsrc and "gx-taxincl" in gsrc)
        ok("B2 item render is conditioned on the payload flag",
           "(i.tax_inclusive ? '<br><span class=\"gx-taxincl\">Tax included</span>'" in gsrc)
        ok("B3 pill style rule defined", ".gx-taxincl{" in gsrc)
        ok("B4 guest view: no negated-flag render anywhere in the file",
           not re.search(r"!\s*i\.tax_inclusive", gsrc))

        print("--- C: kiosk + menu-board payloads carry the flag ---")
        ki = kiosk_items()
        ok("C1 kiosk menu inclusive item: tax_inclusive true",
           ki[ids["incl"]].get("tax_inclusive") is True, ki[ids["incl"]])
        ok("C2 kiosk menu default item: tax_inclusive false",
           ki[ids["plain"]].get("tax_inclusive") is False, ki[ids["plain"]])
        ok("C3 kiosk menu explicit-false item: tax_inclusive false",
           ki[ids["expl"]].get("tax_inclusive") is False, ki[ids["expl"]])
        s, mb = req("GET", "/api/menuboards")
        ok("C4 menu-board payload (shared builder) carries the flag",
           s == 200 and flat_menu(mb)[ids["incl"]].get("tax_inclusive") is True,
           (s, flat_menu(mb).get(ids["incl"])))

        print("--- D: kiosk + menu-board views render the label (source pins) ---")
        ksrc = src_of("public/views/kiosk.js")
        ok("D1 kiosk grid pill conditioned on the flag",
           "(it.tax_inclusive ? '<span class=\"ti\">Tax included</span>'" in ksrc)
        ok("D2 kiosk item sheet note conditioned on the flag",
           "(it.tax_inclusive ? '<div class=\"kx-taxnote\">Tax included</div>'" in ksrc)
        ok("D4 kiosk view: no negated-flag render anywhere in the file",
           not re.search(r"!\s*it\.tax_inclusive", ksrc))
        msrc = src_of("public/views/menuboards.js")
        ok("D3 menu-board label conditioned on the flag",
           "(it.tax_inclusive ? '<div class=\"ti\">Tax included</div>'" in msrc)
        ok("D5 menu-board view: no negated-flag render anywhere in the file",
           not re.search(r"!\s*it\.tax_inclusive", msrc))

        print("--- E: online ordering — tax parity landed (test60), label TRUE ---")
        s, om = req("GET", "/api/online/menu")
        assert s == 200, (s, om)
        oi = flat_menu({"categories": om})
        ok("E1 online payload carries the flag (true on the inclusive item)",
           oi[ids["incl"]].get("tax_inclusive") is True
           and oi[ids["plain"]].get("tax_inclusive") is False, oi[ids["incl"]])
        osrc = src_of("public/views/online.js")
        ok("E2 online view renders the label, conditioned on the flag (no negation)",
           "(it.tax_inclusive ? '<span class=\"olo-taxincl\">Tax included</span>'" in osrc
           and not re.search(r"!\s*it\.tax_inclusive", osrc))
        ok("E3 online route applies the per-item tax semantics",
           "tax_inclusive" in src_of("routes/online.js")
           and "taxSnapshotOf" in src_of("routes/online.js"))
        # Proven with money: the inclusive item ordered online now backs
        # its tax OUT — net = round(2000/1.0775) = 1856, included = 144 —
        # tax_cents 144 (all of it included), total stays the $20.00
        # sticker. (Pre-parity this was tax 155 ON TOP, total 2155.)
        s, o = req("POST", "/api/online/orders",
                   {"customer_name": "QA59", "phone": "5555901001",
                    "items": [{"menu_item_id": ids["incl"], "qty": 1}]})
        ok("E4 online math backs the inclusive tax OUT (label is true)",
           s == 201 and o.get("subtotal_cents") == 2000
           and o.get("tax_cents") == 144 and o.get("tax_included_cents") == 144
           and o.get("total_cents") == 2000,
           (s, o))

        print("--- F: totals equivalence a368b34 vs HEAD (no money moved) ---")
        cmtok, cstok = login("2580", base=CBASE), login("1111", base=CBASE)
        cids = fixture(cmtok, base=CBASE)
        s, cqr_r = req("GET", "/api/tables/1/qr", token=cstok, base=CBASE)
        assert s == 200, (s, cqr_r)
        cqr = cqr_r["token"]

        cart = [{"menu_item_id": ids["incl"], "qty": 2, "seat": 1},
                {"menu_item_id": ids["plain"], "qty": 1, "seat": 1}]
        s, go = req("POST", "/api/guest/orders",
                    {"token": qr, "guest_name": "QA59", "items": cart})
        assert s == 201, (s, go)
        gt, ht = go["guest_token"], go["totals"]
        ccart = [{"menu_item_id": cids["incl"], "qty": 2, "seat": 1},
                 {"menu_item_id": cids["plain"], "qty": 1, "seat": 1}]
        s, cgo = req("POST", "/api/guest/orders",
                     {"token": cqr, "guest_name": "QA59", "items": ccart},
                     base=CBASE)
        assert s == 201, (s, cgo)
        cgt, ct = cgo["guest_token"], cgo["totals"]
        # Hand anchor: sticker subtotal 2*2000+1000=5000; the inclusive
        # line backs out round-trip tax of 288 (4000 - round(4000/1.0775)).
        ok("F1 HEAD guest totals hand-anchored (tax backed out, not added)",
           ht.get("subtotal") == 5000 and ht.get("tax_included_cents") == 288
           and ht.get("tax_added_cents") == ht.get("tax", 0) - 288
           and ht.get("total") == 5000 + ht.get("surcharge", 0)
           + ht.get("service_charge", 0) + ht.get("tax", 0) - 288,
           ht)
        ok("F2 guest order totals byte-identical at a368b34 and HEAD",
           totals_json(ct) == totals_json(ht), (ct, ht))
        s, hv = req("GET", f"/api/guest/check?guest_token={gt}")
        s2, cv = req("GET", f"/api/guest/check?guest_token={cgt}", base=CBASE)
        ok("F3 guest check-view totals byte-identical",
           s == 200 and s2 == 200
           and totals_json(cv["totals"]) == totals_json(hv["totals"]),
           (s, s2))
        bal = hv["totals"]["balance"]
        s, hp = req("POST", "/api/guest/pay",
                    {"guest_token": gt, "method": "card_demo",
                     "amount_cents": bal, "tip_cents": 0})
        s2, cp = req("POST", "/api/guest/pay",
                     {"guest_token": cgt, "method": "card_demo",
                      "amount_cents": cv["totals"]["balance"], "tip_cents": 0},
                     base=CBASE)
        ok("F4 guest pay settles and totals stay byte-identical",
           s == 201 and s2 == 201
           and totals_json(cp["totals"]) == totals_json(hp["totals"])
           and hp["totals"].get("balance") == 0,
           (s, s2, hp.get("totals"), cp.get("totals")))
        s, ko = req("POST", "/api/kiosk/order",
                    {"customer_name": "QA59",
                     "items": [{"menu_item_id": ids["incl"], "qty": 1}]})
        assert s == 201, (s, ko)
        s2, cko = req("POST", "/api/kiosk/order",
                      {"customer_name": "QA59",
                       "items": [{"menu_item_id": cids["incl"], "qty": 1}]},
                      base=CBASE)
        assert s2 == 201, (s2, cko)
        ok("F5 kiosk order totals byte-identical (inclusive backs out 144)",
           totals_json(cko["check"]["totals"]) == totals_json(ko["check"]["totals"])
           and ko["check"]["totals"].get("tax_included") == 144,
           (ko["check"]["totals"], cko["check"]["totals"]))

        print("--- Z: discriminating control at a368b34 ---")
        cgi = guest_items(cqr, base=CBASE)
        ok("Z1 CONTROL: base guest payload has NO tax_inclusive key",
           "tax_inclusive" not in cgi[cids["incl"]], cgi[cids["incl"]])
        cki = kiosk_items(base=CBASE)
        ok("Z2 CONTROL: base kiosk payload has NO tax_inclusive key",
           "tax_inclusive" not in cki[cids["incl"]], cki[cids["incl"]])
        s, cmb = req("GET", "/api/menuboards", base=CBASE)
        ok("Z3 CONTROL: base menu-board payload has NO tax_inclusive key",
           s == 200 and "tax_inclusive" not in flat_menu(cmb)[cids["incl"]],
           (s,))
        ok("Z4 CONTROL: base guest/kiosk/board views render no label",
           all("Tax included" not in src_of(v, Path(WT))
               for v in ("public/views/guest.js", "public/views/kiosk.js",
                         "public/views/menuboards.js")))
    finally:
        stop(srv)
        stop(ctrl)
        subprocess.run(["git", "worktree", "remove", "--force", WT], cwd=ROOT,
                       capture_output=True)

    print(f"\n==== test59_inclusive_labels: {passed} passed, {failed} failed ====")
    if failures:
        print("FAILURES:", failures)
    return 1 if failed else 0

if __name__ == "__main__":
    sys.exit(main())
