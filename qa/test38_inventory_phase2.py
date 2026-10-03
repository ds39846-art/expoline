#!/usr/bin/env python3
"""test38_inventory_phase2.py — QA for Inventory Phase 2.

End-to-end on a scratch server/DB (port 4348 only, fresh DB):
  fixture via APIs (ingredient + recipe on Bali Fries)
  → sell/send → depletion is ledgered (one aggregated 'sale depletion' row,
    actor = sending user) and on_hand math is unchanged from phase 1
  → waste (valid + rejection cases + cost math at stored unit cost)
  → receive (stock up, latest-cost replacement, ledger row)
  → counts (correction down, no-op match, correction up)
  → variance report equals hand-computed numbers
  → manager-only guards (server token 403s everywhere)

Hand-computed ledger for ingredient A (QA38 Beef, recipe 2 per Bali Fries):
  start on_hand 100, cost 200c
  send 2+1 fries  -> depletion -6   on_hand 94
  waste 4 spoilage -> -4, cost at the time 4*200 = 800c   on_hand 90
  receive 10 @250c -> +10, stored cost becomes 250       on_hand 100
  count 97         -> correction -3                      on_hand 97
  count 97         -> variance 0, NO new correction row
  count 99         -> correction +2                      on_hand 99
  variance row: usage 6, waste 4, waste cost 4*250 = 1000c (CURRENT cost),
  received 10, count corrections -1, net -1  (100 + (-1) = 99 ✓)

Send-now regression guard (appended AFTER the variance snapshot, so the
ledger above is undisturbed): send-now must deplete + ledger exactly like
/send — stage 3 fries in one send-now call -> on_hand 99 - 2x3 = 93,
exactly ONE new aggregated 'sale depletion' row (delta -6, actor = the
send-now user). Send-now previously fired through its own inline path and
never touched inventory at all.
"""
import json, os, signal, subprocess, sys, time
import urllib.request, urllib.error
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PORT = 4348
DB = "/tmp/expoline-test38.db"
BASE = f"http://localhost:{PORT}"

checks, fails = 0, []
def ok(cond, name, detail=""):
    global checks
    checks += 1
    if not cond:
        fails.append(name)
        print(f"  x {name} {detail}")
    else:
        print(f"  + {name}")

def api(method, path, token=None, body=None):
    req = urllib.request.Request(BASE + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json"})
    if token: req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return resp.status, json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        try: return e.code, json.loads(e.read().decode() or "{}")
        except Exception: return e.code, {}

def boot():
    env = dict(os.environ, EXPOLINE_PORT=str(PORT), EXPOLINE_DB=DB, NODE_ENV="test")
    p = subprocess.Popen(["node", str(ROOT / "server.js")], env=env,
                         stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
    for _ in range(60):
        try:
            with urllib.request.urlopen(BASE + "/api/health", timeout=2) as r:
                if r.status == 200: return p
        except Exception: time.sleep(0.5)
    p.kill(); raise RuntimeError("server did not come up")

def stop(p):
    if p and p.poll() is None:
        p.send_signal(signal.SIGTERM); p.wait(timeout=10)

def login(pin):
    s, b = api("POST", "/api/auth/login", None, {"pin": pin})
    assert s == 200, (s, b)
    return b["token"]

def on_hand(mt, iid):
    s, lst = api("GET", "/api/admin/inventory/ingredients", mt)
    assert s == 200
    return [i for i in lst if i["id"] == iid][0]

def main():
    for suf in ("", "-wal", "-shm"):
        try: os.remove(DB + suf)
        except FileNotFoundError: pass

    srv = boot()
    try:
        MT, ST = login("2580"), login("1111")

        # ---- fixture via APIs ----
        s, menu = api("GET", "/api/menu", ST)
        cats = menu if isinstance(menu, list) else menu.get("categories", [])
        fries = None
        for c in cats:
            for i in c.get("items", []):
                if i["name"] == "Bali Fries": fries = i
        assert fries, "Bali Fries not on the menu"
        s, zones = api("GET", "/api/zones", ST)
        zlist = zones if isinstance(zones, list) else zones.get("zones", [])
        table_id = zlist[0]["tables"][0]["id"]

        s, a = api("POST", "/api/admin/inventory/ingredients", MT,
                   {"name": "QA38 Beef", "unit": "lb", "on_hand": 100, "par": 10,
                    "cost_per_unit_cents": 200})
        ok(s == 201, "fixture: ingredient A created", f"s={s} {a}")
        A = a["id"]
        s, b = api("POST", "/api/admin/inventory/ingredients", MT,
                   {"name": "QA38 Idle", "unit": "ea", "on_hand": 5, "par": 1,
                    "cost_per_unit_cents": 100})
        B = b["id"]
        s, rec = api("POST", "/api/admin/inventory/recipes", MT,
                     {"menu_item_id": fries["id"], "lines": [{"ingredient_id": A, "qty": 2}]})
        ok(s == 200 and rec.get("lines") == 1, "fixture: recipe set (2 per fries)", f"s={s} {rec}")

        # ---- sell + send: depletion ledgered, aggregated, actor = sender ----
        s, chk = api("POST", "/api/checks", ST, {"table_id": table_id, "guest_count": 2, "tab_name": "T38"})
        assert s == 201, (s, chk)
        cid = chk["id"]
        for q in (2, 1):
            s, it = api("POST", f"/api/checks/{cid}/items", ST,
                        {"menu_item_id": fries["id"], "seat": 1, "qty": q})
            assert s == 201, (s, it)
        s, sent = api("POST", f"/api/checks/{cid}/send", ST, {})
        ok(s == 200 and sent.get("sent") == 2, "send fires both lines", f"s={s} {sent}")
        ok(on_hand(MT, A)["on_hand"] == 94, "on_hand after send = 100 - (2+1)x2 = 94",
           f"got {on_hand(MT, A)['on_hand']}")
        s, st = api("GET", "/api/inventory/status", MT)
        dep = [x for x in st["recent_adjustments"]
               if x["ingredient_name"] == "QA38 Beef" and x["reason"] == "sale depletion"]
        ok(len(dep) == 1, "exactly ONE aggregated depletion ledger row for the send",
           f"rows={dep}")
        ok(dep and dep[0]["delta"] == -6, "depletion delta = -6", f"{dep}")
        ok(dep and dep[0]["actor"] == "Daniel S", "depletion actor = sending user",
           f"{dep[0]['actor'] if dep else None}")

        # ---- waste ----
        s, w = api("POST", "/api/admin/inventory/waste", MT,
                   {"ingredient_id": A, "qty": 4, "reason_code": "spoilage", "note": "fridge failure"})
        ok(s == 200 and w["waste_cost_cents"] == 800, "waste: cost = 4 x 200c = 800c", f"s={s} {w}")
        ok(w["ingredient"]["on_hand"] == 90, "waste: on_hand 94 - 4 = 90", f"{w}")
        for name, body in [
            ("qty 0", {"ingredient_id": A, "qty": 0, "reason_code": "spoilage"}),
            ("qty negative", {"ingredient_id": A, "qty": -2, "reason_code": "spoilage"}),
            ("bad reason_code", {"ingredient_id": A, "qty": 1, "reason_code": "oops"}),
            ("unknown ingredient", {"ingredient_id": 999999, "qty": 1, "reason_code": "spoilage"}),
        ]:
            s, r = api("POST", "/api/admin/inventory/waste", MT, body)
            ok(s == 400, f"waste rejected: {name}", f"s={s} {r}")
        ok(on_hand(MT, A)["on_hand"] == 90, "rejected waste moved nothing",
           f"got {on_hand(MT, A)['on_hand']}")

        # ---- receiving ----
        s, r = api("POST", "/api/admin/inventory/receive", MT,
                   {"ingredient_id": A, "qty": 10, "unit_cost_cents": 250,
                    "supplier": "Sysco", "invoice_ref": "INV-1042"})
        ok(s == 200 and r["ingredient"]["on_hand"] == 100, "receive: on_hand 90 + 10 = 100", f"s={s} {r}")
        ok(r["ingredient"]["cost_per_unit_cents"] == 250, "receive: stored cost replaced (latest-cost)",
           f"{r['ingredient']}")
        s, r2 = api("POST", "/api/admin/inventory/receive", MT, {"ingredient_id": A, "qty": 0})
        ok(s == 400, "receive rejected: qty 0", f"s={s}")
        s, r2 = api("POST", "/api/admin/inventory/receive", MT,
                    {"ingredient_id": A, "qty": 1, "unit_cost_cents": -5})
        ok(s == 400, "receive rejected: negative cost", f"s={s}")

        # ---- counts ----
        s, c = api("POST", "/api/admin/inventory/count", MT, {"ingredient_id": A, "counted_qty": 97})
        ok(s == 200 and c["expected"] == 100 and c["variance"] == -3 and c["ingredient"]["on_hand"] == 97,
           "count down: expected 100, variance -3, on_hand set to 97", f"s={s} {c}")
        s, c = api("POST", "/api/admin/inventory/count", MT, {"ingredient_id": A, "counted_qty": 97})
        ok(s == 200 and c["variance"] == 0, "count match: variance 0", f"s={s} {c}")
        s, st = api("GET", "/api/inventory/status", MT)
        corr = [x for x in st["recent_adjustments"]
                if x["ingredient_name"] == "QA38 Beef" and x["reason"] == "count correction"]
        ok(len(corr) == 1 and corr[0]["delta"] == -3,
           "matching count wrote NO second correction row", f"rows={corr}")
        s, c = api("POST", "/api/admin/inventory/count", MT, {"ingredient_id": A, "counted_qty": 99})
        ok(s == 200 and c["variance"] == 2 and c["ingredient"]["on_hand"] == 99,
           "count up: variance +2, on_hand 99", f"s={s} {c}")
        s, c = api("POST", "/api/admin/inventory/count", MT, {"ingredient_id": A, "counted_qty": -1})
        ok(s == 400, "count rejected: negative counted_qty", f"s={s}")

        # ---- variance report (hand-computed) ----
        frm = (datetime.now(timezone.utc) - timedelta(days=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
        to = (datetime.now(timezone.utc) + timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
        s, v = api("GET", f"/api/admin/inventory/variance?from={frm}&to={to}", MT)
        ok(s == 200, "variance responds", f"s={s}")
        rows = {r["ingredient_id"]: r for r in v.get("ingredients", [])}
        ok(A in rows, "variance includes the active ingredient", f"keys={list(rows)}")
        ok(B not in rows, "variance excludes the idle ingredient (no activity)", f"keys={list(rows)}")
        ra = rows.get(A, {})
        ok(ra.get("theoretical_usage") == 6, "variance: theoretical usage 6", f"{ra}")
        ok(ra.get("waste_qty") == 4, "variance: waste qty 4", f"{ra}")
        ok(ra.get("waste_cost_cents") == 1000, "variance: waste cost 4 x current 250c = 1000c", f"{ra}")
        ok(ra.get("received_qty") == 10, "variance: received 10", f"{ra}")
        ok(ra.get("count_correction_qty") == -1, "variance: count corrections -3 + 2 = -1", f"{ra}")
        ok(ra.get("net_change") == -1, "variance: net change -6 -4 +10 -1 = -1", f"{ra}")
        t = v.get("totals", {})
        ok(t.get("theoretical_usage") == 6 and t.get("waste_cost_cents") == 1000
           and t.get("net_change") == -1, "variance totals match (only A moved)", f"{t}")
        s, v2 = api("GET", "/api/admin/inventory/variance", MT)
        ok(s == 200 and any(r["ingredient_id"] == A for r in v2.get("ingredients", [])),
           "variance default window (7d) includes today's activity", f"s={s}")

        # ---- send-now: depletes + ledgers identically to /send ----
        s, st = api("GET", "/api/inventory/status", MT)
        dep_before = [x for x in st["recent_adjustments"]
                      if x["ingredient_name"] == "QA38 Beef" and x["reason"] == "sale depletion"]
        table2_id = zlist[0]["tables"][1]["id"]
        s, chk2 = api("POST", "/api/checks", ST, {"table_id": table2_id, "guest_count": 2, "tab_name": "T38-SN"})
        assert s == 201, (s, chk2)
        cid2 = chk2["id"]
        s, sn = api("POST", f"/api/checks/{cid2}/send-now", ST,
                    {"items": [{"menu_item_id": fries["id"], "seat": 1, "qty": 3}]})
        ok(s == 201 and sn.get("sent") == 1 and len(sn.get("tickets", [])) == 1,
           "send-now fires the staged line (201, sent=1, 1 ticket)", f"s={s} {sn}")
        ok(on_hand(MT, A)["on_hand"] == 93,
           "send-now depletes on_hand: 99 - recipe 2 x qty 3 = 93",
           f"got {on_hand(MT, A)['on_hand']}")
        s, st = api("GET", "/api/inventory/status", MT)
        dep_after = [x for x in st["recent_adjustments"]
                     if x["ingredient_name"] == "QA38 Beef" and x["reason"] == "sale depletion"]
        new_rows = [x for x in dep_after if x["id"] not in {y["id"] for y in dep_before}]
        ok(len(dep_after) == len(dep_before) + 1 and len(new_rows) == 1,
           "send-now wrote exactly ONE new aggregated 'sale depletion' row",
           f"before={len(dep_before)} after={len(dep_after)} new={new_rows}")
        ok(bool(new_rows) and new_rows[0]["delta"] == -6,
           "send-now depletion delta = -(2 x 3) = -6", f"{new_rows}")
        ok(bool(new_rows) and new_rows[0]["actor"] == "Daniel S",
           "send-now depletion actor = sending user",
           f"{new_rows[0]['actor'] if new_rows else None}")

        # ---- manager-only guards ----
        for name, method, path, body in [
            ("waste", "POST", "/api/admin/inventory/waste", {"ingredient_id": A, "qty": 1, "reason_code": "other"}),
            ("receive", "POST", "/api/admin/inventory/receive", {"ingredient_id": A, "qty": 1}),
            ("count", "POST", "/api/admin/inventory/count", {"ingredient_id": A, "counted_qty": 1}),
            ("variance", "GET", "/api/admin/inventory/variance", None),
        ]:
            s, r = api(method, path, ST, body)
            ok(s == 403, f"guard: server token 403 on {name}", f"s={s}")
    finally:
        stop(srv)

    print(f"\ntest38: {checks - len(fails)}/{checks} passed" + (f" — FAILURES: {fails}" if fails else ""))
    return 1 if fails else 0

if __name__ == "__main__":
    sys.exit(main())
