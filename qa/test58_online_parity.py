#!/usr/bin/env python3
"""Expoline online-ordering parity — qa/test58_online_parity.py.

WHY: batches 1 (happy-hour pricing) and 9 (floor 86) were scoped to the
staff/guest check flows and explicitly left the WEB ONLINE ORDERING
subsystem (routes/online.js) out, with the gap disclosed each time: a
guest could order an 86'd item online at full price and the kitchen's
countdown was never consumed. This suite pins the parity:

  A  menu payload: the online (guest) menu mirrors the staff /api/menu
     HH fields (hh_price_cents / effective_price_cents / hh_active);
     window OFF -> effective == regular, hh_active false everywhere.
  B  HH pricing: window ON -> an online order charges hh_price_cents
     to the cent (hand-computed), the charged price snapshots onto the
     order line (turning the window OFF afterwards does not move the
     placed order), an item with no HH price charges regular inside
     the window, and an MP item (price 0) with an HH value set is
     NEVER HH-priced (charges 0, the floor's inert rule).
  C  floor 86: an item 86'd from the floor disappears from the online
     menu (guest exclusion, not flagged-visible) and a stale cart
     submitting it is refused BY NAME; restore makes it orderable.
     The legacy structural 86 (active=0) refusal is unchanged.
  D  countdown: remaining=3 -> order 2 leaves 1 -> order 2 refused,
     still 1 -> order 1 burns the last: remaining 0, is_86 flips,
     exactly one item.86_auto audit row with actor 'system' ->
     further orders refused and the item is gone from the menu.
  E  cart aggregation: ONE order whose two lines total 2+2 against
     remaining=3 refuses WHOLE — nothing consumed, no order row.
  F  race: two simultaneous orders for the last unit -> exactly one
     201, exactly one order row, remaining 0.
  G  floor interplay: ONE countdown shared by both worlds — online
     order 1 of remaining 2, floor ring 1 -> remaining 0 + auto-86,
     and the online menu/order path then refuse it.
  H  client wiring: public/views/online.js renders the effective
     price (struck regular + HH tag while hh_active), the honest
     "Only N left", and runs cart math on effective_price_cents.
  Z  equivalence + discriminating control at 66bc07a (pristine
     worktree, second server): a representative cart (no HH prices,
     nothing 86'd) produces byte-identical money (subtotal/tax/total
     + per-line name/qty/unit_price) at 66bc07a and at HEAD; and at
     66bc07a the gaps are LIVE: an HH price is ignored online (full
     price inside the window), a floor-86'd item orders fine, and an
     online order leaves the countdown untouched.

Boot discipline mirrors test14: this suite owns ports 4341 (HEAD) and
4342 (control) and its own scratch DBs; the in-memory rate limit
(10 orders/min/IP) is reset by restarting the HEAD server between
sections. The HH window is forced via PUT /api/admin/dayparts (an
all-day pricing HAPPY HOUR, or an all-day non-pricing LUNCH), so the
suite is wall-clock independent.
"""
import json, os, signal, sqlite3, subprocess, sys, threading, time
import urllib.request, urllib.error
from pathlib import Path

ROOT = Path("/home/hatch/workspace/goals/expo-line-pos-beat-toast-spoton-pilot-at-bali-hai/build/expoline")
PORT, CPORT = 4341, 4342
BASE = f"http://127.0.0.1:{PORT}"
CBASE = f"http://127.0.0.1:{CPORT}"
DB = "/tmp/test58_online.db"
CDB = "/tmp/test58_online_ctrl.db"
WT = "/tmp/wt58_66bc07a"
BASE_COMMIT = "66bc07a"

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
                         stdout=open(f"/tmp/test58_boot_{port}.log", "a"),
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

def q(db, sql, args=()):
    con = sqlite3.connect(db)
    row = con.execute(sql, args).fetchone()
    con.close()
    return row

def place(items, phone, base=BASE, name="QA58"):
    return req("POST", "/api/online/orders",
               {"customer_name": name, "phone": phone, "items": items}, base=base)

def online_items(base=BASE):
    s, menu = req("GET", "/api/online/menu", base=base)
    assert s == 200, (s, menu)
    return {it["id"]: it for c in menu for it in (c.get("items") or [])}

def set_window(mtok, pricing, base=BASE):
    win = ({"name": "HAPPY HOUR", "start": "00:00", "end": "00:00",
            "also": ["BAR"], "pricing": True} if pricing else
           {"name": "LUNCH", "start": "00:00", "end": "00:00",
            "also": ["BAR", "KEIKI", "DESSERTS"]})
    s, r = req("PUT", "/api/admin/dayparts", {"schedule": [win]}, token=mtok, base=base)
    assert s == 200, (s, r)

def mk_item(mtok, cat_id, name, price, hh=None, base=BASE):
    body = {"name": name, "price_cents": price, "category_id": cat_id,
            "station": "expediter", "course": "entree"}
    if hh is not None:
        body["hh_price_cents"] = hh
    s, r = req("POST", "/api/admin/menu/items", body, token=mtok, base=base)
    assert s == 201, (s, r)
    return r["id"]

def floor86(stok, item_id, body, base=BASE):
    return req("POST", f"/api/menu/items/{item_id}/86", body, token=stok, base=base)

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
        mtok, stok, ktok = login("2580"), login("1111"), login("2222")
        s, adm = req("GET", "/api/admin/menu", token=mtok)
        cats = adm if isinstance(adm, list) else adm.get("categories", [])
        cat_id = [it for c in cats for it in c.get("items", [])][0]["category_id"]

        hh_id = mk_item(mtok, cat_id, "QA58 HH Item", 2000, hh=1500)
        plain_id = mk_item(mtok, cat_id, "QA58 Plain", 1000)
        mp_id = mk_item(mtok, cat_id, "QA58 MP", 0, hh=500)

        print("--- A: menu payload + window OFF ---")
        set_window(mtok, pricing=False)
        items = online_items()
        ok("A1 online menu carries hh_price_cents", items[hh_id].get("hh_price_cents") == 1500,
           items[hh_id])
        ok("A2 window off: effective == regular", items[hh_id].get("effective_price_cents") == 2000,
           items[hh_id])
        ok("A3 window off: hh_active false", items[hh_id].get("hh_active") is False, items[hh_id])
        ok("A4 no-HH item: hh_price_cents null, effective regular",
           items[plain_id].get("hh_price_cents") is None
           and items[plain_id].get("effective_price_cents") == 1000, items[plain_id])
        ok("A5 remaining null when no countdown", items[hh_id].get("remaining") is None,
           items[hh_id])
        s, o = place([{"menu_item_id": hh_id, "qty": 1}], "5555801001")
        ok("A6 window off: order charges regular price",
           s == 201 and o.get("subtotal_cents") == 2000 and o.get("total_cents") == 2000 + 155,
           (s, o))

        print("--- B: happy-hour pricing ---")
        set_window(mtok, pricing=True)
        items = online_items()
        ok("B1 window on: effective is the HH price",
           items[hh_id].get("effective_price_cents") == 1500, items[hh_id])
        ok("B2 window on: hh_active true for the HH item",
           items[hh_id].get("hh_active") is True, items[hh_id])
        ok("B3 window on: no-HH item unaffected",
           items[plain_id].get("effective_price_cents") == 1000
           and items[plain_id].get("hh_active") is False, items[plain_id])
        ok("B4 MP item: effective stays 0, hh_active false (inert)",
           items[mp_id].get("effective_price_cents") == 0
           and items[mp_id].get("hh_active") is False, items[mp_id])
        s, o = place([{"menu_item_id": hh_id, "qty": 2},
                      {"menu_item_id": plain_id, "qty": 1},
                      {"menu_item_id": mp_id, "qty": 1}], "5555801002")
        # hand-computed: 2*1500 + 1000 + 0 = 4000; tax round(4000*0.0775)=310
        ok("B5 HH order totals to the cent",
           s == 201 and o.get("subtotal_cents") == 4000 and o.get("tax_cents") == 310
           and o.get("total_cents") == 4310, (s, o))
        units = {i["name"]: i["unit_price_cents"] for i in o.get("items", [])}
        ok("B6 charged unit prices snapshot per line (HH/regular/MP)",
           units.get("QA58 HH Item") == 1500 and units.get("QA58 Plain") == 1000
           and units.get("QA58 MP") == 0, units)
        set_window(mtok, pricing=False)
        s, last = req("GET", "/api/online/last?phone=5555801002")
        ok("B7 snapshot: window off afterwards, placed order unmoved",
           s == 200 and last.get("subtotal_cents") == 4000 and last.get("total_cents") == 4310,
           (s, last))

        print("--- C: floor 86 vs online ---")
        s, r = floor86(stok, plain_id, {"action": "out"})
        ok("C1 floor-86 set", s == 200 and r.get("is_86") is True, (s, r))
        items = online_items()
        ok("C2 86'd item excluded from the online menu", plain_id not in items)
        s, e = place([{"menu_item_id": plain_id, "qty": 1}], "5555801003")
        ok("C3 stale cart refused, naming the item",
           s == 400 and "QA58 Plain" in json.dumps(e) and "sold out" in json.dumps(e), (s, e))
        s, r = floor86(stok, plain_id, {"action": "restore"})
        ok("C4 restore ok", s == 200 and r.get("is_86") is False, (s, r))
        s, o = place([{"menu_item_id": plain_id, "qty": 1}], "5555801004")
        ok("C5 restored item orderable again", s == 201, (s, o))
        s, r86 = req("POST", f"/api/admin/menu/86/{plain_id}", token=mtok)
        assert s == 200 and r86.get("eightysixed") is True, (s, r86)
        s, e = place([{"menu_item_id": plain_id, "qty": 1}], "5555801005")
        ok("C6 legacy structural 86 refusal unchanged",
           s == 400 and "86" in json.dumps(e), (s, e))
        s, menu = req("GET", "/api/online/menu")
        ok("C7 structurally-off item also excluded",
           plain_id not in {it["id"] for c in menu for it in (c.get("items") or [])})
        s, r86 = req("POST", f"/api/admin/menu/86/{plain_id}", token=mtok)
        assert s == 200 and r86.get("eightysixed") is False, (s, r86)

        # ---- restart: fresh rate-limit bucket for D+E ----
        stop(srv); srv = boot(PORT, DB)
        mtok, stok, ktok = login("2580"), login("1111"), login("2222")
        cd_id = mk_item(mtok, cat_id, "QA58 Countdown", 800)

        print("--- D: countdown lifecycle ---")
        s, r = floor86(stok, cd_id, {"action": "out", "remaining": 3})
        ok("D1 countdown set at 3", s == 200 and r.get("remaining") == 3, (s, r))
        items = online_items()
        ok("D2 countdown item visible with remaining shown",
           items.get(cd_id, {}).get("remaining") == 3, items.get(cd_id))
        s, o = place([{"menu_item_id": cd_id, "qty": 2}], "5555802001")
        row = q(DB, "SELECT remaining, is_86 FROM menu_items WHERE id = ?", (cd_id,))
        ok("D3 order 2 consumes: remaining 1, not out",
           s == 201 and row == (1, 0), (s, row))
        s, e = place([{"menu_item_id": cd_id, "qty": 2}], "5555802002")
        row = q(DB, "SELECT remaining, is_86 FROM menu_items WHERE id = ?", (cd_id,))
        ok("D4 oversell refused, nothing consumed",
           s == 400 and "only 1 left" in json.dumps(e) and row == (1, 0), (s, e, row))
        s, o = place([{"menu_item_id": cd_id, "qty": 1}], "5555802003")
        row = q(DB, "SELECT remaining, is_86 FROM menu_items WHERE id = ?", (cd_id,))
        aud = q(DB, "SELECT COUNT(*) FROM menu_audit WHERE item_id = ? AND action = 'item.86_auto' AND actor = 'system'", (cd_id,))[0]
        ok("D5 last unit: remaining 0 + auto-86 + one system audit row",
           s == 201 and row == (0, 1) and aud == 1, (s, row, aud))
        s, e = place([{"menu_item_id": cd_id, "qty": 1}], "5555802004")
        ok("D6 auto-86'd item refused online", s == 400 and "sold out" in json.dumps(e), (s, e))
        ok("D7 auto-86'd item excluded from the online menu", cd_id not in online_items())

        print("--- E: cart aggregation ---")
        agg_id = mk_item(mtok, cat_id, "QA58 Aggregated", 800)
        s, r = floor86(stok, agg_id, {"action": "out", "remaining": 3})
        assert s == 200, (s, r)
        before = q(DB, "SELECT COUNT(*) FROM online_orders WHERE phone = '5555802005'")[0]
        s, e = place([{"menu_item_id": agg_id, "qty": 2},
                      {"menu_item_id": agg_id, "qty": 2}], "5555802005")
        row = q(DB, "SELECT remaining, is_86 FROM menu_items WHERE id = ?", (agg_id,))
        after = q(DB, "SELECT COUNT(*) FROM online_orders WHERE phone = '5555802005'")[0]
        ok("E1 two lines 2+2 vs 3 left refuses whole",
           s == 400 and "only 3 left" in json.dumps(e), (s, e))
        ok("E2 refusal consumed nothing and placed no order",
           row == (3, 0) and after == before, (row, before, after))

        # ---- restart: fresh bucket for F+G ----
        stop(srv); srv = boot(PORT, DB)
        mtok, stok, ktok = login("2580"), login("1111"), login("2222")

        print("--- F: race for the last unit ---")
        race_id = mk_item(mtok, cat_id, "QA58 Race", 800)
        s, r = floor86(stok, race_id, {"action": "out", "remaining": 1})
        assert s == 200, (s, r)
        results = []
        barrier = threading.Barrier(2)
        def racer(phone):
            barrier.wait()
            results.append(place([{"menu_item_id": race_id, "qty": 1}], phone)[0])
        t1 = threading.Thread(target=racer, args=("5555803001",))
        t2 = threading.Thread(target=racer, args=("5555803002",))
        t1.start(); t2.start(); t1.join(); t2.join()
        row = q(DB, "SELECT remaining, is_86 FROM menu_items WHERE id = ?", (race_id,))
        n_orders = q(DB, "SELECT COUNT(*) FROM online_orders WHERE phone IN ('5555803001','5555803002')")[0]
        ok("F1 exactly one of two racers succeeds", sorted(results) == [201, 400], results)
        ok("F2 exactly one order row, countdown at 0 + auto-86",
           n_orders == 1 and row == (0, 1), (n_orders, row))

        print("--- G: floor interplay — one shared countdown ---")
        both_id = mk_item(mtok, cat_id, "QA58 Both Worlds", 800)
        s, r = floor86(stok, both_id, {"action": "out", "remaining": 2})
        assert s == 200, (s, r)
        s, o = place([{"menu_item_id": both_id, "qty": 1}], "5555803003")
        row = q(DB, "SELECT remaining, is_86 FROM menu_items WHERE id = ?", (both_id,))
        ok("G1 online order draws the shared countdown to 1",
           s == 201 and row == (1, 0), (s, row))
        s, zones = req("GET", "/api/zones", token=stok)
        zlist = zones if isinstance(zones, list) else zones.get("zones", [])
        table = next(t for z in zlist for t in z.get("tables", []) if not t.get("open_check_id"))
        s, chk = req("POST", "/api/checks", {"table_id": table["id"], "guest_count": 2}, token=stok)
        assert s in (200, 201), (s, chk)
        s, line = req("POST", f"/api/checks/{chk['id']}/items",
                      {"menu_item_id": both_id, "seat": 1, "qty": 1}, token=stok)
        row = q(DB, "SELECT remaining, is_86 FROM menu_items WHERE id = ?", (both_id,))
        ok("G2 floor ring burns the last: remaining 0 + auto-86",
           s == 201 and row == (0, 1), (s, row))
        ok("G3 online menu then excludes it", both_id not in online_items())
        s, e = place([{"menu_item_id": both_id, "qty": 1}], "5555803004")
        ok("G4 online order then refused", s == 400 and "sold out" in json.dumps(e), (s, e))

        print("--- H: client wiring ---")
        src = (ROOT / "public" / "views" / "online.js").read_text()
        ok("H1 page prices via effective_price_cents with regular fallback",
           "it.effective_price_cents != null ? it.effective_price_cents : it.price_cents" in src)
        ok("H2 HH render: struck regular + Happy hour tag",
           "<s>${oloFmt(it.price_cents)}</s>" in src and "olo-hh" in src and "Happy hour" in src)
        ok("H3 countdown render: honest Only-N-left from payload remaining",
           "Only ${it.remaining} left" in src and "it.remaining != null" in src)
        ok("H4 cart + checkout math uses the effective price",
           "s += q * oloPrice(it)" in src and "oloFmt(q * oloPrice(it))" in src)

        print("--- Z: equivalence + control at 66bc07a ---")
        cmtok, cstok = login("2580", base=CBASE), login("1111", base=CBASE)
        s, cadm = req("GET", "/api/admin/menu", token=cmtok, base=CBASE)
        ccats = cadm if isinstance(cadm, list) else cadm.get("categories", [])
        ccat_id = [it for c in ccats for it in c.get("items", [])][0]["category_id"]
        set_window(cmtok, pricing=False, base=CBASE)
        set_window(mtok, pricing=False)
        eq_h = mk_item(mtok, cat_id, "QA58 EQ One", 1234)
        eq_c = mk_item(cmtok, ccat_id, "QA58 EQ One", 1234, base=CBASE)
        eq2_h = mk_item(mtok, cat_id, "QA58 EQ Two", 777)
        eq2_c = mk_item(cmtok, ccat_id, "QA58 EQ Two", 777, base=CBASE)
        cart = [{"menu_item_id": eq_h, "qty": 2}, {"menu_item_id": eq2_h, "qty": 3}]
        s_h, o_h = place(cart, "5555804001")
        cart_c = [{"menu_item_id": eq_c, "qty": 2}, {"menu_item_id": eq2_c, "qty": 3}]
        s_c, o_c = place(cart_c, "5555804001", base=CBASE)
        money = lambda o: (o.get("subtotal_cents"), o.get("tax_cents"), o.get("total_cents"),
                           sorted((i["name"], i["qty"], i["unit_price_cents"]) for i in o.get("items", [])))
        # hand-computed: 2*1234 + 3*777 = 4799; tax round(4799*0.0775)=372
        ok("Z1 equivalence: HEAD money == hand-computed",
           s_h == 201 and money(o_h)[:3] == (4799, 372, 5171), (s_h, money(o_h)))
        ok("Z2 equivalence: 66bc07a money byte-identical to HEAD",
           s_c == 201 and money(o_c) == money(o_h), (s_c, money(o_c), money(o_h)))
        chh_c = mk_item(cmtok, ccat_id, "QA58 CTRL HH", 2000, hh=1500, base=CBASE)
        set_window(cmtok, pricing=True, base=CBASE)
        s, o = place([{"menu_item_id": chh_c, "qty": 1}], "5555804002", base=CBASE)
        ok("Z3 CONTROL: at 66bc07a the HH price is ignored online (full price)",
           s == 201 and o.get("subtotal_cents") == 2000, (s, o))
        c86 = mk_item(cmtok, ccat_id, "QA58 CTRL 86", 800, base=CBASE)
        s, r = floor86(cstok, c86, {"action": "out"}, base=CBASE)
        ok("Z4 CONTROL setup: floor-86 endpoint exists at 66bc07a",
           s == 200 and r.get("is_86") is True, (s, r))
        s, o = place([{"menu_item_id": c86, "qty": 1}], "5555804003", base=CBASE)
        ok("Z5 CONTROL: at 66bc07a a floor-86'd item orders fine online",
           s == 201, (s, o))
        ccd = mk_item(cmtok, ccat_id, "QA58 CTRL CD", 800, base=CBASE)
        s, r = floor86(cstok, ccd, {"action": "out", "remaining": 3}, base=CBASE)
        assert s == 200, (s, r)
        s, o = place([{"menu_item_id": ccd, "qty": 2}], "5555804004", base=CBASE)
        row = q(CDB, "SELECT remaining FROM menu_items WHERE id = ?", (ccd,))
        ok("Z6 CONTROL: at 66bc07a an online order leaves the countdown untouched",
           s == 201 and row == (3,), (s, row))
    finally:
        stop(srv)
        stop(ctrl)
        subprocess.run(["git", "worktree", "remove", "--force", WT], cwd=ROOT,
                       capture_output=True)

    print(f"\n==== test58_online_parity: {passed} passed, {failed} failed ====")
    if failures:
        print("FAILURES:", failures)
    return 1 if failed else 0

if __name__ == "__main__":
    sys.exit(main())
