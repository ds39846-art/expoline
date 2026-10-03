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

Kind-column hardening (2026-10-03): variance buckets on the structured
inventory_adjustments.kind, never on reason text. After the baseline:
  → four /adjust calls whose free-text reasons ape the structured formats
    ('waste: spoilage', 'Receiving — QA Farms', 'count correction',
    'sale depletion'; deltas net to zero) — the variance report must be
    byte-identical, the rows ledgered as kind 'manual', on_hand unmoved
  → every structured row carries its kind (depletion/waste/receiving/
    count_correction), checked via /api/inventory/status
  → qty sanity cap: waste/receive/adjust/count at 1e9 → 400, no movement
  → variance with from > to → 400 (was an empty 200)
  → legacy phase (port 4350, separate DB): drop the kind column, plant
    pre-migration rows with legacy reason strings, reboot — the boot
    migration backfills depletion/waste/receiving/count_correction and
    files everything else ('waste:expired', free text) under 'manual',
    and the variance report buckets the backfilled rows correctly
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

def legacy_phase():
    """Kind backfill on a pre-migration DB.

    First boot builds a fully-formed DB with the current code; then the
    kind column is DROPPED (restoring the old schema) and legacy rows are
    inserted carrying only the historical reason strings. The next boot's
    migration must re-add kind and backfill it from the exact legacy
    patterns — including the traps: 'receiving — <supplier>' still counts
    as receiving, while 'waste:expired' (no space after the colon — never
    a structured format) and arbitrary free text fall to 'manual'.
    """
    import sqlite3
    LPORT, LDB = 4350, "/tmp/expoline-test38-legacy.db"
    LBASE = f"http://localhost:{LPORT}"

    def lapi(method, path, token=None, body=None):
        req = urllib.request.Request(LBASE + path, method=method,
            data=json.dumps(body).encode() if body is not None else None,
            headers={"Content-Type": "application/json"})
        if token: req.add_header("Authorization", "Bearer " + token)
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                return resp.status, json.loads(resp.read().decode() or "{}")
        except urllib.error.HTTPError as e:
            try: return e.code, json.loads(e.read().decode() or "{}")
            except Exception: return e.code, {}

    def lboot():
        env = dict(os.environ, EXPOLINE_PORT=str(LPORT), EXPOLINE_DB=LDB, NODE_ENV="test")
        p = subprocess.Popen(["node", str(ROOT / "server.js")], env=env,
                             stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
        for _ in range(60):
            try:
                with urllib.request.urlopen(LBASE + "/api/health", timeout=2) as r:
                    if r.status == 200: return p
            except Exception: time.sleep(0.5)
        p.kill(); raise RuntimeError("legacy server did not come up")

    for suf in ("", "-wal", "-shm"):
        try: os.remove(LDB + suf)
        except FileNotFoundError: pass
    srv = lboot()
    stop(srv)  # fully-formed DB; server fully down before surgery

    planted = [
        ("sale depletion", -11), ("waste: spoilage", -12),
        ("receiving — QA Farms", 13), ("count correction", 14),
        ("waste:expired", -16), ("cycle count note", 15),
    ]
    con = sqlite3.connect(LDB)
    site = con.execute("SELECT id FROM sites LIMIT 1").fetchone()[0]
    ing = con.execute("SELECT id FROM ingredients WHERE name = 'Ribeye beef'").fetchone()[0]
    con.execute("ALTER TABLE inventory_adjustments DROP COLUMN kind")
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    for reason, delta in planted:
        con.execute(
            "INSERT INTO inventory_adjustments (site_id, ingredient_id, delta, reason, actor, created_at)"
            " VALUES (?, ?, ?, ?, 'legacy probe', ?)", (site, ing, delta, reason, ts))
    con.commit()
    con.close()

    srv = lboot()
    try:
        s, b = lapi("POST", "/api/auth/login", None, {"pin": "2580"})
        assert s == 200, (s, b)
        mt = b["token"]
        s, st = lapi("GET", "/api/inventory/status", mt)
        got = {x["reason"]: x.get("kind") for x in st["recent_adjustments"]
               if x["ingredient_name"] == "Ribeye beef"}
        expect = {"sale depletion": "depletion", "waste: spoilage": "waste",
                  "receiving — QA Farms": "receiving",
                  "count correction": "count_correction",
                  "waste:expired": "manual", "cycle count note": "manual"}
        ok(got == expect, "backfill: kinds derived from legacy reason patterns",
           f"got={got}")
        s, v = lapi("GET", "/api/admin/inventory/variance", mt)
        row = [r for r in v.get("ingredients", []) if r["name"] == "Ribeye beef"]
        ok(bool(row) and row[0]["theoretical_usage"] == 11 and row[0]["waste_qty"] == 12
           and row[0]["received_qty"] == 13 and row[0]["count_correction_qty"] == 14
           and row[0]["net_change"] == 3,
           "backfill: variance buckets the backfilled rows correctly", f"{row}")
    finally:
        stop(srv)


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

        # ---- variance pollution: crafted manual reasons must not bucket ----
        # A is at 93 after send-now. The four crafted /adjust deltas net to
        # zero (-5 +8 -2 -1), so if kind bucketing works the report must be
        # BYTE-identical afterwards even though every reason string apes a
        # structured movement ('waste: ...', 'Receiving ...', ...). The rows
        # themselves must still land — as kind 'manual'.
        s, v_before = api("GET", f"/api/admin/inventory/variance?from={frm}&to={to}", MT)
        ok(s == 200, "pollution: baseline variance snapshot", f"s={s}")
        before_blob = json.dumps(v_before, sort_keys=True)
        crafted = [
            (-5, "waste: spoilage", 88),
            (8, "Receiving — QA Farms", 96),
            (-2, "count correction", 94),
            (-1, "sale depletion", 93),
        ]
        for delta, reason, expect_hand in crafted:
            s, r = api("POST", "/api/admin/inventory/adjust", MT,
                       {"ingredient_id": A, "delta": delta, "reason": reason})
            ok(s == 200 and r.get("on_hand") == expect_hand,
               f"pollution: adjust {reason!r} lands, on_hand -> {expect_hand}",
               f"s={s} {r}")
        s, v_after = api("GET", f"/api/admin/inventory/variance?from={frm}&to={to}", MT)
        ok(s == 200 and json.dumps(v_after, sort_keys=True) == before_blob,
           "pollution: variance report byte-identical after crafted manual reasons",
           "reports differ")
        s, st = api("GET", "/api/inventory/status", MT)
        # Match on (reason, delta) pairs: the structured rows share two of
        # the reason strings ('sale depletion', 'count correction') but with
        # different deltas, so reason alone would over-match.
        crafted_pairs = {(r, d) for d, r, _ in crafted}
        manual = [x for x in st["recent_adjustments"]
                  if x["ingredient_name"] == "QA38 Beef"
                  and (x["reason"], x["delta"]) in crafted_pairs]
        ok(len(manual) == 4 and all(x.get("kind") == "manual" for x in manual),
           "pollution: crafted rows ledgered with kind 'manual'", f"rows={manual}")
        # Structured rows written earlier must carry their own kinds.
        adj = [x for x in st["recent_adjustments"] if x["ingredient_name"] == "QA38 Beef"]
        depk = [x for x in adj if x["reason"] == "sale depletion" and x["delta"] == -6]
        ok(len(depk) == 2 and all(x.get("kind") == "depletion" for x in depk),
           "kinds: depletion rows carry kind 'depletion'", f"{depk}")
        wstk = [x for x in adj if x["reason"] == "waste: spoilage — fridge failure"]
        ok(len(wstk) == 1 and wstk[0].get("kind") == "waste",
           "kinds: waste rows carry kind 'waste'", f"{wstk}")
        rctk = [x for x in adj if x["reason"].startswith("receiving")]
        ok(len(rctk) == 1 and rctk[0].get("kind") == "receiving",
           "kinds: receiving rows carry kind 'receiving'", f"{rctk}")
        cork = [x for x in adj if x["reason"] == "count correction" and x["delta"] in (-3, 2)]
        ok(len(cork) == 2 and all(x.get("kind") == "count_correction" for x in cork),
           "kinds: count rows carry kind 'count_correction'", f"{cork}")
        ok(on_hand(MT, A)["on_hand"] == 93, "pollution: net-zero adjusts return on_hand to 93",
           f"got {on_hand(MT, A)['on_hand']}")

        # ---- quantity sanity cap (1,000,000): all four writers ----
        for name, path, body in [
            ("waste", "/api/admin/inventory/waste",
             {"ingredient_id": A, "qty": 10**9, "reason_code": "spoilage"}),
            ("receive", "/api/admin/inventory/receive",
             {"ingredient_id": A, "qty": 10**9}),
            ("adjust +", "/api/admin/inventory/adjust",
             {"ingredient_id": A, "delta": 10**9, "reason": "cap probe"}),
            ("adjust -", "/api/admin/inventory/adjust",
             {"ingredient_id": A, "delta": -(10**9), "reason": "cap probe"}),
            ("count", "/api/admin/inventory/count",
             {"ingredient_id": A, "counted_qty": 10**9}),
        ]:
            s, r = api("POST", path, MT, body)
            ok(s == 400, f"cap: {name} at 1e9 rejected 400", f"s={s} {r}")
        ok(on_hand(MT, A)["on_hand"] == 93, "cap: rejected movements changed no stock",
           f"got {on_hand(MT, A)['on_hand']}")

        # ---- variance window sanity ----
        f2 = (datetime.now(timezone.utc) + timedelta(days=2)).strftime("%Y-%m-%dT%H:%M:%SZ")
        t2 = (datetime.now(timezone.utc) + timedelta(days=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
        s, r = api("GET", f"/api/admin/inventory/variance?from={f2}&to={t2}", MT)
        ok(s == 400, "variance: from after to is a 400, not an empty 200", f"s={s} {r}")

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

    # ---- kind backfill on a pre-migration DB ----
    legacy_phase()

    print(f"\ntest38: {checks - len(fails)}/{checks} passed" + (f" — FAILURES: {fails}" if fails else ""))
    return 1 if fails else 0

if __name__ == "__main__":
    sys.exit(main())
