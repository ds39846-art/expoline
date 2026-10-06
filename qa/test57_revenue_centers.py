#!/usr/bin/env python3
"""
test57 — revenue-center reporting (the last unbuilt item from the
2026-10-05 Toast/SpotOn audit).

The finance reports broke a day down by payment method, product mix,
tax rate and server — but not by WHERE the revenue happened. This
batch adds a "Revenue centers" breakdown to the sales report (the
tax-by-rate extraTable precedent): one row per center for the day,
cross-footing EXACTLY to the sales day row on every shared field.

Centers: a table check belongs to its table's zone ("Dining Room",
"Patio", "Bar", "Holiday SoPac" in the seed); a bar tab is its OWN
center ("Bar Tabs") — never folded into the Bar zone, because a zone
is a physical area and a tab is a service channel; table-less checks
report under their channel (Kiosk — whose checks sit on the virtual
KIOSK table with channel 'dine_in' —, Delivery, Guest). Web online
orders live in their own online_orders store, never enter `checks`,
and are therefore NOT in this report at all (the sales population
excludes them too — nothing to cross-foot against).

SNAPSHOT DISCIPLINE (the tax-batch precedent): zones can be renamed,
tables re-zoned or deleted, and a check can move tables while open —
so the center label is SNAPSHOT onto the check (checks.center_label)
at close, by every path that stamps closed_at: staff close, staff
split / split-item-cost / merge source-empty closes, guest split and
split-reverse closes, LAN brain close. Checks closed before this
batch (NULL label — incl. every seeded check) derive at report time
from the table's CURRENT zone; that fallback is documented in the
sales report notes and pinned in section D.

Bucketing is the sales report's own (status paid/closed, closed_at
set, tzDate(closed_at)) and the center rows accumulate in the SAME
pass with the SAME persistTotals values, so the cross-foot is exact
by construction. The Z close-out snapshot stores the day's center
rows verbatim from that same build.

Sections:
  A  seeded day (yesterday, site tz): day-row pin + exactly one
     center row (Dining Room, all three seeded checks) equal to the
     day row on every shared field; CSV carries the table
  B  mixed fixture (today): >=3 zones + bar tab + kiosk + delivery +
     guest-QR + move + split family + merge + split-item-cost +
     comp + line discount + partial refund + a tax-inclusive line;
     per-center rows equal the summed per-check captures field-by-field
  C  the cross-foot, stated plainly: sum of center rows == day row
     on every shared field; sum of item discounts == Z-source figure;
     sum of tax_included == tax report day row
  D  invariance: stamped rows survive zone rename / table re-zone /
     table deletion; the legacy (NULL-label) fallback follows the
     CURRENT zone, documented; close-path stamp census via SQL
  E  voided checks are excluded exactly as the day row excludes them
  F  Z interplay: snapshot.revenue_centers deep-equals the live
     report rows; a later zone rename leaves the stored JSON untouched
  G  gate: the reports surface is the finance_reports capability —
     server/kitchen 403, anon 401; a matrix grant flips kitchen to
     200, reset restores the 403 (test56 idiom)
  H  client wiring pins (app.js: rc section + renderer + Z panel)

CONTROL (TEST57_CONTROL=1, run inside a pristine d4ffa7f worktree):
the seed-day DAY ROW is byte-identical, the Revenue centers table is
ABSENT, and a close-out snapshot carries no revenue_centers key.

Server: fresh subprocess on :4413 (scratch DB; demo PINs server 1111 /
kitchen 2222 / manager 2580).
"""
import json, os, sqlite3, subprocess, sys, time, urllib.request, urllib.error
from datetime import datetime, timedelta, time as dtime
from zoneinfo import ZoneInfo

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PORT = 4413
BASE = f"http://127.0.0.1:{PORT}"
DB = "/tmp/test57_revenue_centers.db"
CONTROL = os.environ.get("TEST57_CONTROL") == "1"
LA = ZoneInfo("America/Los_Angeles")
TODAY = datetime.now(LA).date().isoformat()
YDAY = (datetime.now(LA).date() - timedelta(days=1)).isoformat()
SERVER_PIN, KITCHEN_PIN, MANAGER_PIN = "1111", "2222", "2580"

passed = failed = 0
def ok(name, cond, extra=""):
    global passed, failed
    if cond: passed += 1; print(f"  ok  {name}")
    else: failed += 1; print(f"  FAIL {name} {extra}")

def req(method, path, body=None, tok=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(BASE + path, data=data, method=method)
    r.add_header("Content-Type", "application/json")
    if tok: r.add_header("Authorization", "Bearer " + tok)
    try:
        with urllib.request.urlopen(r, timeout=15) as x:
            raw = x.read().decode("utf-8", "replace")
            try: return x.status, (json.loads(raw) if raw else {})
            except Exception: return x.status, {"raw": raw[:200]}
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try: return e.code, json.loads(raw)
        except Exception: return e.code, {"raw": raw[:200]}
    except Exception as e:
        return 0, {"error": str(e)}

def req_text(method, path, tok=None):
    r = urllib.request.Request(BASE + path, method=method)
    if tok: r.add_header("Authorization", "Bearer " + tok)
    try:
        with urllib.request.urlopen(r, timeout=15) as x:
            return x.status, x.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")

def wait_health(proc, timeout=30):
    t0 = time.time()
    while time.time() - t0 < timeout:
        if proc.poll() is not None: raise RuntimeError(f"server exited {proc.returncode}")
        try:
            with urllib.request.urlopen(BASE + "/health", timeout=2) as x:
                if x.status == 200: return
        except Exception: pass
        time.sleep(0.25)
    raise RuntimeError("server did not come up")

def login(pin):
    s, r = req("POST", "/api/auth/login", {"pin": pin})
    assert s == 200, (s, r)
    return r["token"]

def sql(*stmts):
    con = sqlite3.connect(DB, timeout=30)
    try:
        for st in stmts:
            if isinstance(st, tuple): con.execute(st[0], st[1])
            else: con.execute(st)
        con.commit()
    finally:
        con.close()

def sql_one(q, args=()):
    con = sqlite3.connect(DB, timeout=30)
    try: return con.execute(q, args).fetchone()
    finally: con.close()

SHARED = ["checks", "covers", "gross_cents", "surcharge_cents", "service_cents",
          "comp_cents", "net_cents", "tax_cents", "tips_cents", "cash_cents", "card_cents"]
CENTER_FIELDS = SHARED + ["item_discounts_cents", "tax_included_cents"]

def center_rows(rep, date):
    for t in (rep.get("extraTables") or []):
        if t.get("title") == "Revenue centers":
            return [r for r in t["rows"] if r["date"] == date]
    return None

def main():
    for suffix in ("", "-wal", "-shm"):
        try: os.unlink(DB + suffix)
        except FileNotFoundError: pass
    env = dict(os.environ, EXPOLINE_DB=DB, EXPOLINE_PORT=str(PORT))
    proc = subprocess.Popen(["node", "server.js"], cwd=ROOT, env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        wait_health(proc)
        S = login(SERVER_PIN); K = login(KITCHEN_PIN); M = login(MANAGER_PIN)

        def report(kind, day, tok=None, fmt="json"):
            s, r = req("GET", f"/api/finance/reports/{kind}?format={fmt}&from={day}&to={day}", tok=tok or M)
            assert s == 200, (kind, s, r)
            return r

        # ---------- A. seeded day ----------
        print("== A. seeded day: one center, exact cross-foot ==")
        seed_day = report("sales", YDAY)["rows"][0]
        PIN = {"checks": 3, "covers": 8, "gross_cents": 33200, "surcharge_cents": 1660,
               "service_cents": 0, "comp_cents": 0, "net_cents": 34860, "tax_cents": 2702,
               "tips_cents": 7000, "cash_cents": 0, "card_cents": 37562}
        ok("A1 seed-day day row is the pinned seed figure (identical at both commits)",
           all(seed_day[k] == v for k, v in PIN.items()), str(seed_day))
        rows = center_rows(report("sales", YDAY), YDAY)
        if CONTROL:
            ok("A2 CONTROL: no Revenue centers table at d4ffa7f", rows is None)
            s, co = req("POST", "/api/finance/close-day",
                        {"date": TODAY, "counted_cash_cents": 0, "manager_pin": MANAGER_PIN}, tok=M)
            ok("A3 CONTROL: close-out snapshot has no revenue_centers key",
               s == 201 and "revenue_centers" not in (co.get("snapshot") or {}), f"{s}")
            print(f"\n{passed} passed, {failed} failed (control)")
            return
        ok("A2 Revenue centers table present for the seeded day", rows is not None)
        ok("A3 exactly one center row (all 3 seeded checks are Dining Room)",
           rows is not None and len(rows) == 1 and rows[0]["center"] == "Dining Room", str(rows))
        if rows:
            ok("A4 the Dining Room row equals the day row on every shared field",
               all(rows[0][k] == seed_day[k] for k in SHARED), str(rows[0]))
            ok("A5 seeded row carries the extra center fields (item discounts / included tax = 0)",
               rows[0]["item_discounts_cents"] == 0 and rows[0]["tax_included_cents"] == 0)
        s, csv = req_text("GET", f"/api/finance/reports/sales?format=csv&from={YDAY}&to={YDAY}", tok=M)
        ok("A6 CSV export carries the Revenue centers table", s == 200 and "Revenue centers" in csv and "Dining Room" in csv)

        # ---------- discovery ----------
        s, zones = req("GET", "/api/zones", tok=M)
        if isinstance(zones, dict): zones = zones.get("zones", [])
        zone_tables = {}
        for z in zones:
            zone_tables[z["name"]] = [t for t in z.get("tables", [])]
        used = set()
        def pick(zone, nth=0):
            cands = [t for t in zone_tables[zone] if t["id"] not in used and not t.get("open_check_id")]
            t = cands[nth]
            used.add(t["id"])
            return t
        s, menu = req("GET", "/api/menu?all=1", tok=M)
        cats = menu["categories"] if isinstance(menu, dict) else menu
        items = {it["name"]: it for c in cats for it in c.get("items", [])}
        MAITAI = items["BH Mai Tai"]["id"]; CALA = items["Crispy Calamari"]["id"]
        SALMON = items["Seared Salmon"]["id"]; EDAM = items["Edamame"]["id"]
        NOOD = items["Chinese Garlic Noodles"]["id"]
        # Edamame carries a required Flavor pick-1 group (Sea Salt is the
        # seeded default) — ring it the way the floor does.
        _flav = [g for g in items["Edamame"].get("modifier_groups") or [] if g["name"] == "Flavor"][0]
        _salt = [o for o in _flav["options"] if o["name"] == "Sea Salt"][0]
        EDAM_MODS = [{"name": "Sea Salt", "option_id": _salt["id"], "price_delta_cents": 0}]

        def get_check(cid, tok=None):
            s, c = req("GET", f"/api/checks/{cid}", tok=tok or S)
            assert s == 200, (s, c)
            return c

        def add(cid, item_id, qty=1, seat=1, mods=None):
            s, r = req("POST", f"/api/checks/{cid}/items",
                       {"menu_item_id": item_id, "seat": seat, "qty": qty, "modifiers": mods or []}, tok=S)
            assert s == 201, (s, r)
            return r

        def pay_full(cid, method, tip=0, tok=None):
            bal = get_check(cid)["totals"]["balance"]
            assert bal > 0, f"check {cid} has no balance to pay"
            body = {"method": method, "amount_cents": bal, "tip_cents": tip}
            if method == "card_demo": body.update({"brand": "Visa", "last4": "4242"})
            if method == "cash": body["tendered_cents"] = bal + tip + 1000
            s, r = req("POST", f"/api/checks/{cid}/payments", body, tok=tok or S)
            assert s == 201, (s, r)
            return r["payment"]["id"]

        def close(cid):
            s, r = req("POST", f"/api/checks/{cid}/close", {}, tok=S)
            assert s == 200, (s, r)

        def capture(cid):
            c = get_check(cid)
            tips = cash = card = 0
            for p in (c.get("payments") or []):
                tips += p.get("tip_cents") or 0
                net = (p.get("amount_cents") or 0) - (p.get("refunded_cents") or 0)
                if p.get("method") in ("cash", "gift_card"): cash += net
                elif p.get("method") == "card_demo": card += net
            return {"checks": 1, "covers": c.get("guest_count") or 0,
                    "gross_cents": c["subtotal_cents"], "item_discounts_cents": c["item_discount_cents"],
                    "surcharge_cents": c["surcharge_cents"], "service_cents": c["service_charge_cents"],
                    "comp_cents": c["comp_cents"],
                    "net_cents": c["subtotal_cents"] + c["surcharge_cents"] + c["service_charge_cents"] - c["comp_cents"],
                    "tax_cents": c["tax_cents"], "tax_included_cents": c["tax_included_cents"],
                    "tips_cents": tips, "cash_cents": cash, "card_cents": card}

        def blank():
            return {k: 0 for k in CENTER_FIELDS}

        expected = {}   # center -> summed capture
        members = {}    # center -> [check ids]
        def record(center, cid):
            cap = capture(cid)
            e = expected.setdefault(center, blank())
            for k in CENTER_FIELDS: e[k] += cap[k]
            members.setdefault(center, []).append(cid)
            return cap

        print("== B. mixed fixture ==")
        # B1 Dining Room table check: line discount (held line, no PIN),
        #    card + tip, staff close.
        t = pick("Dining Room")
        s, c = req("POST", "/api/checks", {"table_id": t["id"], "guest_count": 2}, tok=S)
        dr1 = (c.get("check") or c)["id"]
        add(dr1, MAITAI); add(dr1, CALA)
        line_id = get_check(dr1)["items"][1]["id"]
        s, r = req("POST", f"/api/checks/{dr1}/items/{line_id}/discount",
                   {"amount_cents": 200, "reason": "QA line discount"}, tok=S)
        ok("B1a ad-hoc line discount applies on the held line", s == 200, f"{s} {r}")
        pay_full(dr1, "card_demo", tip=300); close(dr1)
        record("Dining Room", dr1)

        # B2 Patio: comp, card pay, partial refund (check reopens),
        #    remainder in cash, close.
        t = pick("Patio")
        s, c = req("POST", "/api/checks", {"table_id": t["id"], "guest_count": 2}, tok=S)
        patio1 = (c.get("check") or c)["id"]
        add(patio1, SALMON)
        s, r = req("POST", f"/api/checks/{patio1}/comp",
                   {"amount_cents": 500, "manager_pin": MANAGER_PIN, "reason": "QA comp"}, tok=S)
        ok("B2a comp applies with a fresh manager PIN", s == 200, f"{s} {r}")
        pid = pay_full(patio1, "card_demo", tip=200)
        s, r = req("POST", f"/api/payments/{pid}/refund", {"amount_cents": 300}, tok=M)
        ok("B2b partial refund succeeds", s == 200, f"{s} {r}")
        pay_full(patio1, "cash", tip=0); close(patio1)
        record("Patio", patio1)

        # B3 Bar-zone table check — the zone named Bar, NOT Bar Tabs.
        t = pick("Bar")
        s, c = req("POST", "/api/checks", {"table_id": t["id"], "guest_count": 1}, tok=S)
        bar1 = (c.get("check") or c)["id"]
        add(bar1, MAITAI, qty=2)
        pay_full(bar1, "cash", tip=150); close(bar1)
        record("Bar", bar1)

        # B4 bar tab with a tax-inclusive line (Edamame set inclusive at
        #    the site-default rate first; restored afterwards — the ring
        #    snapshot is what the report reads).
        s, r = req("PUT", f"/api/admin/menu/items/{EDAM}", {"tax_inclusive": True, "tax_rate_bps": 775}, tok=M)
        ok("B4a Edamame set tax-inclusive for the tab fixture", s == 200, f"{s} {r}")
        s, tab = req("POST", "/api/checks", {"tab_name": "QA Tab"}, tok=S)
        tab1 = (tab.get("check") or tab)["id"]
        ok("B4b tab created table-less with channel bar_tab",
           tab.get("channel") == "bar_tab" or get_check(tab1).get("channel") == "bar_tab")
        add(tab1, EDAM, mods=EDAM_MODS)
        pay_full(tab1, "card_demo", tip=100); close(tab1)
        cap_tab = record("Bar Tabs", tab1)
        ok("B4c the inclusive line's backed-out tax is captured (tax_included > 0)",
           cap_tab["tax_included_cents"] > 0, str(cap_tab))
        s, r = req("PUT", f"/api/admin/menu/items/{EDAM}", {"tax_inclusive": False, "tax_rate_bps": None}, tok=M)
        ok("B4d Edamame restored after the fixture", s == 200, f"{s} {r}")

        # B5 kiosk order (virtual KIOSK table) — staff pay + close.
        s, order = req("POST", "/api/kiosk/order", {"customer_name": "QA", "items": [{"menu_item_id": SALMON, "qty": 1}]})
        kiosk1 = order["check"]["id"]
        ok("B5a kiosk order creates a check on the KIOSK table", s == 201, f"{s}")
        pay_full(kiosk1, "card_demo"); close(kiosk1)
        record("Kiosk", kiosk1)

        # B6 delivery order (no table, channel delivery) — staff pay + close.
        s, dord = req("POST", "/api/delivery/orders",
                      {"source": "DoorDash", "customer_name": "QA", "items": [{"menu_item_id": CALA, "qty": 1}]}, tok=S)
        deliv1 = dord["check_id"]
        ok("B6a delivery order creates a table-less check", s == 201, f"{s} {dord}")
        pay_full(deliv1, "card_demo"); close(deliv1)
        record("Delivery", deliv1)

        # B7 move while open: Patio table -> Dining Room table; center =
        #    the zone at CLOSE time (the destination).
        tp = pick("Patio"); td = pick("Dining Room")
        s, c = req("POST", "/api/checks", {"table_id": tp["id"], "guest_count": 2}, tok=S)
        move1 = (c.get("check") or c)["id"]
        add(move1, CALA)
        s, r = req("POST", f"/api/checks/{move1}/move", {"table_id": td["id"]}, tok=S)
        ok("B7a move to the Dining Room table succeeds", s == 200, f"{s} {r}")
        pay_full(move1, "card_demo", tip=100); close(move1)
        record("Dining Room", move1)

        # B8 staff split by seat (source empties -> auto-close, stamped):
        #    both children + the zero-money source land in Dining Room.
        t = pick("Dining Room")
        s, c = req("POST", "/api/checks", {"table_id": t["id"], "guest_count": 2}, tok=S)
        split_src = (c.get("check") or c)["id"]
        add(split_src, MAITAI, seat=1); add(split_src, NOOD, seat=2)
        s, sp = req("POST", f"/api/checks/{split_src}/split", {"mode": "by_seat", "groups": [[1], [2]]}, tok=S)
        kids = sp["checks"]
        ok("B8a by-seat split produced 2 children and auto-closed the source",
           s == 200 and len(kids) == 2 and get_check(split_src)["status"] == "closed", f"{s}")
        pay_full(kids[0], "cash", tip=100); close(kids[0])
        pay_full(kids[1], "card_demo", tip=100); close(kids[1])
        record("Dining Room", kids[0]); record("Dining Room", kids[1]); record("Dining Room", split_src)

        # B9 merge: source absorbed (closed + stamped), target survives.
        t1 = pick("Dining Room"); t2 = pick("Dining Room")
        s, c = req("POST", "/api/checks", {"table_id": t1["id"], "guest_count": 2}, tok=S)
        mtarget = (c.get("check") or c)["id"]
        add(mtarget, CALA)
        s, c = req("POST", "/api/checks", {"table_id": t2["id"], "guest_count": 3}, tok=S)
        msource = (c.get("check") or c)["id"]
        add(msource, MAITAI)
        s, r = req("POST", f"/api/checks/{mtarget}/merge", {"source_check_ids": [msource]}, tok=S)
        ok("B9a merge absorbs the source", s == 200 and get_check(msource)["status"] == "closed", f"{s} {r}")
        pay_full(mtarget, "card_demo", tip=200); close(mtarget)
        record("Dining Room", mtarget); record("Dining Room", msource)

        # B10 split-item-cost: source holds ONLY the shared line and is
        #     not a target -> empties -> closes (stamped). Targets carry
        #     the shares (plus their own lines) in Dining Room.
        tt1 = pick("Dining Room"); tt2 = pick("Dining Room"); ts = pick("Dining Room")
        s, c = req("POST", "/api/checks", {"table_id": tt1["id"], "guest_count": 2}, tok=S)
        tgt1 = (c.get("check") or c)["id"]
        add(tgt1, CALA)
        s, c = req("POST", "/api/checks", {"table_id": tt2["id"], "guest_count": 2}, tok=S)
        tgt2 = (c.get("check") or c)["id"]
        add(tgt2, CALA)
        s, c = req("POST", "/api/checks", {"table_id": ts["id"], "guest_count": 2}, tok=S)
        sic_src = (c.get("check") or c)["id"]
        add(sic_src, SALMON)
        src_line = get_check(sic_src)["items"][0]["id"]
        s, r = req("POST", f"/api/checks/{sic_src}/split-item-cost",
                   {"item_id": src_line, "targets": [tgt1, tgt2]}, tok=S)
        ok("B10a split-item-cost empties and closes the source",
           s in (200, 201) and get_check(sic_src)["status"] == "closed", f"{s} {r}")
        pay_full(tgt1, "card_demo", tip=50); close(tgt1)
        pay_full(tgt2, "cash", tip=50); close(tgt2)
        record("Dining Room", tgt1); record("Dining Room", tgt2); record("Dining Room", sic_src)

        # B11 guest QR check on a Patio table (qr_guest WITH a table ->
        #     the table's zone), staff-paid + staff-closed.
        t = pick("Patio")
        s, qr = req("GET", f"/api/tables/{t['id']}/qr", tok=S)
        s, go = req("POST", "/api/guest/orders",
                    {"token": qr["token"], "guest_name": "QA Guest",
                     "items": [{"menu_item_id": MAITAI, "qty": 1, "seat": 1}]})
        guest1 = go["check_id"]
        ok("B11a guest order lands on the Patio table", s == 201, f"{s}")
        pay_full(guest1, "card_demo", tip=50); close(guest1)
        record("Patio", guest1)

        # B12 guest split + reverse: parent empties at split (closed,
        #     stamped); reverse closes the children (stamped) and
        #     reopens the parent, which is then paid + staff-closed.
        t = pick("Patio")
        s, qr = req("GET", f"/api/tables/{t['id']}/qr", tok=S)
        s, go = req("POST", "/api/guest/orders",
                    {"token": qr["token"], "guest_name": "QA Split",
                     "items": [{"menu_item_id": MAITAI, "qty": 1, "seat": 1},
                               {"menu_item_id": CALA, "qty": 1, "seat": 2}]})
        gpar = go["check_id"]; gtok = go["guest_token"]
        s, gs = req("POST", "/api/guest/split", {"guest_token": gtok, "mode": "even"})
        gkids = [k2["check_id"] for k2 in gs["checks"]]
        ok("B12a guest split empties + closes the parent",
           s == 201 and get_check(gpar)["status"] == "closed", f"{s}")
        s, r = req("POST", "/api/guest/split/reverse", {"split_group": gs["split_group"]}, tok=M)
        ok("B12b split reverse closes the children and reopens the parent",
           s == 200 and get_check(gpar)["status"] == "open"
           and all(get_check(k2)["status"] == "closed" for k2 in gkids), f"{s} {r}")
        pay_full(gpar, "card_demo", tip=75); close(gpar)
        record("Patio", gpar)
        for k2 in gkids: record("Patio", k2)

        # ---------- B/C. per-center equality + cross-foot ----------
        print("== B/C. per-center rows equal the captures; cross-foot ==")
        rep = report("sales", TODAY)
        day = rep["rows"][0]
        rows = center_rows(rep, TODAY)
        ok("B13 Revenue centers present for the fixture day", rows is not None)
        by_center = {r["center"]: r for r in (rows or [])}
        ok("B14 exactly the expected centers appear (3 zones + Bar Tabs + Kiosk + Delivery)",
           set(by_center) == set(expected), f"{sorted(by_center)} vs {sorted(expected)}")
        for center, exp in sorted(expected.items()):
            row = by_center.get(center) or {}
            ok(f"B15 center row == summed captures [{center}]",
               all(row.get(k) == exp[k] for k in CENTER_FIELDS),
               f"row={ {k: row.get(k) for k in CENTER_FIELDS} } exp={exp}")
        ok("C1 cross-foot: sum of centers == day row on every shared field",
           rows is not None and all(sum(r[k] for r in rows) == day[k] for k in SHARED),
           f"day={ {k: day[k] for k in SHARED} }")
        ok("C2 cross-foot: sum of center checks == day checks",
           rows is not None and sum(r["checks"] for r in rows) == day["checks"])
        tax_day = report("tax", TODAY)["rows"][0]
        ok("C3 sum of center tax_included == tax report day row tax_included",
           rows is not None and sum(r["tax_included_cents"] for r in rows) == tax_day["tax_included_cents"],
           f'{sum(r["tax_included_cents"] for r in rows or [])} vs {tax_day["tax_included_cents"]}')
        ok("C4 the fixture day really has included tax in play (tab line)",
           tax_day["tax_included_cents"] > 0, str(tax_day["tax_included_cents"]))
        item_disc_sum = sum(r["item_discounts_cents"] for r in (rows or []))
        ok("C5 sum of center item discounts == summed captures (200 line discount)",
           item_disc_sum == sum(e["item_discounts_cents"] for e in expected.values()) == 200,
           str(item_disc_sum))

        # ---------- D. stamp census + invariance ----------
        print("== D. stamp census + invariance ==")
        want_label = {}
        for center, ids in members.items():
            for cid in ids: want_label[cid] = center
        bad = []
        for cid, want in want_label.items():
            got = sql_one("SELECT center_label FROM checks WHERE id = ?", (cid,))[0]
            if got != want: bad.append((cid, want, got))
        ok("D1 every API-closed fixture check carries its center stamp (all close paths)",
           not bad, str(bad))
        ok("D2 the split sources / merged source / split-cost source are stamped, not NULL",
           all(sql_one("SELECT center_label FROM checks WHERE id = ?", (cid,))[0] == "Dining Room"
               for cid in (split_src, msource, sic_src)))

        # Legacy fallback: a closed check with NULL label, backdated to
        # the seeded day, on a Patio table -> derives the CURRENT zone.
        t = pick("Patio")
        s, c = req("POST", "/api/checks", {"table_id": t["id"], "guest_count": 2}, tok=S)
        legacy = (c.get("check") or c)["id"]
        add(legacy, CALA)
        pay_full(legacy, "card_demo", tip=25); close(legacy)
        legacy_cap = capture(legacy)
        yday_iso = datetime.combine(datetime.now(LA).date() - timedelta(days=1),
                                     dtime(20, 0), tzinfo=LA).isoformat()
        sql(("UPDATE checks SET center_label = NULL, closed_at = ? WHERE id = ?", (yday_iso, legacy)))
        rep_y = report("sales", YDAY)
        rows_y = {r["center"]: r for r in (center_rows(rep_y, YDAY) or [])}
        ok("D3 legacy (NULL-label) check derives its table's current zone on the seeded day",
           "Patio" in rows_y and rows_y["Patio"]["checks"] == 1
           and rows_y["Patio"]["gross_cents"] == legacy_cap["gross_cents"], str(rows_y))
        ok("D4 seeded day still cross-foots with the legacy check included",
           all(sum(r[k] for r in rows_y.values()) == rep_y["rows"][0][k] for k in SHARED))

        s, az = req("GET", "/api/admin/zones", tok=M)
        patio_zone = [z for z in az if z["name"] == "Patio"][0]
        s, r = req("PUT", f"/api/admin/zones/{patio_zone['id']}", {"name": "Patio QA Renamed"}, tok=M)
        ok("D5 zone rename succeeds", s == 200, f"{s} {r}")
        rows_t = {r["center"]: r for r in (center_rows(report("sales", TODAY), TODAY) or [])}
        ok("D6 STAMPED rows ignore the rename (today's Patio row is intact)",
           rows_t.get("Patio", {}).get("checks") == expected["Patio"]["checks"]
           and rows_t.get("Patio", {}).get("net_cents") == expected["Patio"]["net_cents"]
           and "Patio QA Renamed" not in rows_t, str(sorted(rows_t)))
        rows_y2 = {r["center"]: r for r in (center_rows(report("sales", YDAY), YDAY) or [])}
        ok("D7 the LEGACY row follows the rename (documented derivation fallback)",
           "Patio QA Renamed" in rows_y2 and "Patio" not in rows_y2, str(sorted(rows_y2)))
        s, r = req("PUT", f"/api/admin/zones/{patio_zone['id']}", {"name": "Patio"}, tok=M)
        ok("D8 zone renamed back", s == 200, f"{s} {r}")

        # Re-zone + delete: a check closed in a fresh zone keeps that
        # label after its table is re-zoned away and then deleted.
        s, azz = req("POST", "/api/admin/zones", {"name": "QA Annex"}, tok=M)
        annex_id = azz["id"]
        s, at = req("POST", "/api/admin/tables",
                    {"zone_id": annex_id, "label": "QA-T1", "seats": 2, "x": 5, "y": 5}, tok=M)
        at_id = at["id"]
        s, c = req("POST", "/api/checks", {"table_id": at_id, "guest_count": 2}, tok=S)
        annex_check = (c.get("check") or c)["id"]
        add(annex_check, CALA)
        pay_full(annex_check, "cash", tip=25); close(annex_check)
        annex_cap = capture(annex_check)
        dr_zone = [z for z in az if z["name"] == "Dining Room"][0]
        s, r = req("PUT", f"/api/admin/tables/{at_id}", {"zone_id": dr_zone["id"]}, tok=M)
        ok("D9 table re-zoned into Dining Room", s == 200, f"{s} {r}")
        rows_t = {r["center"]: r for r in (center_rows(report("sales", TODAY), TODAY) or [])}
        ok("D10 the Annex check keeps its close-time label after the re-zone",
           rows_t.get("QA Annex", {}).get("gross_cents") == annex_cap["gross_cents"]
           and rows_t.get("QA Annex", {}).get("checks") == 1, str(rows_t.get("QA Annex")))
        expected["QA Annex"] = annex_cap  # keep C-style sums honest for F
        s, r = req("DELETE", f"/api/admin/tables/{at_id}", tok=M)
        ok("D11 table deleted once its check is closed", s == 200, f"{s} {r}")
        rows_t = {r["center"]: r for r in (center_rows(report("sales", TODAY), TODAY) or [])}
        ok("D12 the Annex row survives the table deletion (snapshot, not a join)",
           rows_t.get("QA Annex", {}).get("checks") == 1, str(rows_t.get("QA Annex")))

        # ---------- E. void exclusion ----------
        print("== E. void exclusion ==")
        before = report("sales", TODAY)
        t = pick("Dining Room")
        s, c = req("POST", "/api/checks", {"table_id": t["id"], "guest_count": 2}, tok=S)
        vcheck = (c.get("check") or c)["id"]
        add(vcheck, MAITAI)
        s, r = req("POST", f"/api/checks/{vcheck}/void",
                   {"manager_pin": MANAGER_PIN, "reason": "QA void"}, tok=S)
        ok("E1 void succeeds", s == 200, f"{s} {r}")
        after = report("sales", TODAY)
        ok("E2 day row + centers are byte-identical with the void excluded",
           after["rows"] == before["rows"] and center_rows(after, TODAY) == center_rows(before, TODAY))

        # ---------- F. Z interplay ----------
        print("== F. Z close-out snapshot ==")
        live_rows = center_rows(report("sales", TODAY), TODAY)
        s, st = req("GET", f"/api/finance/close-day?date={TODAY}", tok=M)
        expected_cash = st["expected_cash_cents"]
        s, co = req("POST", "/api/finance/close-day",
                    {"date": TODAY, "counted_cash_cents": expected_cash, "manager_pin": MANAGER_PIN}, tok=M)
        ok("F1 close-day succeeds for the fixture day", s == 201, f"{s} {co}")
        snap = co.get("snapshot") or {}
        ok("F2 snapshot.revenue_centers deep-equals the live report rows",
           snap.get("revenue_centers") == live_rows,
           f'{snap.get("revenue_centers")} vs {live_rows}')
        ok("F3 snapshot item discounts == sum of center item discounts",
           snap.get("item_discounts_cents") == sum(r["item_discounts_cents"] for r in (live_rows or [])),
           str(snap.get("item_discounts_cents")))
        s, r = req("PUT", f"/api/admin/zones/{patio_zone['id']}", {"name": "Patio After Z"}, tok=M)
        s, co2 = req("GET", f"/api/finance/closeouts/{co['id']}", tok=M)
        ok("F4 stored snapshot is byte-identical after a later zone rename",
           (co2.get("snapshot") or {}).get("revenue_centers") == live_rows
           and (co2.get("snapshot") or {}).get("sales") == snap.get("sales"))
        s, r = req("PUT", f"/api/admin/zones/{patio_zone['id']}", {"name": "Patio"}, tok=M)

        # ---------- G. capability gate ----------
        print("== G. finance_reports capability gate ==")
        s, r = req("GET", f"/api/finance/reports/sales?format=json&from={TODAY}&to={TODAY}", tok=S)
        ok("G1 server is refused the reports surface (403)", s == 403, f"{s}")
        s, r = req("GET", f"/api/finance/reports/sales?format=json&from={TODAY}&to={TODAY}", tok=K)
        ok("G2 kitchen is refused by default (403)", s == 403, f"{s}")
        s, r = req("GET", f"/api/finance/reports/sales?format=json&from={TODAY}&to={TODAY}")
        ok("G3 anonymous is refused (401)", s == 401, f"{s}")
        s, p = req("GET", "/api/admin/permissions", tok=M)
        kitchen_caps = list(((p.get("matrix") or {}).get("kitchen")) or [])
        s, r = req("PUT", "/api/admin/permissions",
                   {"matrix": {"kitchen": kitchen_caps + ["finance_reports"]}}, tok=M)
        ok("G4 grant kitchen finance_reports", s == 200, f"{s} {r}")
        s, r = req("GET", f"/api/finance/reports/sales?format=json&from={TODAY}&to={TODAY}", tok=K)
        ok("G5 the grant flips kitchen to 200 and the centers are visible",
           s == 200 and center_rows(r, TODAY) is not None, f"{s}")
        s, r = req("PUT", "/api/admin/permissions", {"reset": True}, tok=M)
        s, r = req("GET", f"/api/finance/reports/sales?format=json&from={TODAY}&to={TODAY}", tok=K)
        ok("G6 reset restores the kitchen 403", s == 403, f"{s}")

        # ---------- H. client wiring ----------
        print("== H. client wiring ==")
        app_js = open(os.path.join(ROOT, "public", "app.js"), encoding="utf-8").read()
        ok("H1 Finance renders a revenue-centers section (rc-section + wireRevenueCenters)",
           'id="rc-section"' in app_js and "wireRevenueCenters" in app_js)
        ok("H2 the Z panel renders stored revenue_centers when present",
           "revenue_centers" in app_js and "Revenue centers" in app_js)

        print(f"\n{passed} passed, {failed} failed")
        if failed: sys.exit(1)
    finally:
        proc.send_signal(2)
        try: proc.wait(timeout=10)
        except Exception: proc.kill()

if __name__ == "__main__":
    main()
