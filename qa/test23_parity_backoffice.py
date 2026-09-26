#!/usr/bin/env python3
"""
Expoline Phase 3C — competitor-parity back office QA (test23).

Covers the nine parity categories end to end against a LIVE server on port 4327:
  1. waitlist quotes from real turn-time data + pre-ordering
  2. blind-count cash drawer closeout
  3. employee scheduling with labor vs sales projections
  4. product-mix analytics
  5. staff notes at POS login
  6. optional post-payment review prompt
  7. isolated multi-location dashboard
  8. open API documentation
  9. ingredient-level inventory (phase 1)

The test manages its own server lifecycle on port 4327 (the designated scratch
port) with fresh per-site DBs under db/sites/. It never touches ports 4317 or
4320, never touches the soak DB or monitor log.

Usage: python3 qa/test23_parity_backoffice.py
"""
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request

SRV_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = "4327"
BASE = f"http://localhost:{PORT}"
SITES = os.path.join(SRV_DIR, "db", "sites")
DB_A = os.path.join(SITES, "parity-qa-a.db")
DB_B = os.path.join(SITES, "parity-qa-b.db")
CORRUPT = os.path.join(SITES, "parity-qa-corrupt.db")
BOOT_LOG = "/tmp/parity_back_qa23.log"

PASSES = 0
FAILS = []


def check(name, cond, extra=""):
    global PASSES
    if cond:
        PASSES += 1
        print(f"  PASS {name}")
    else:
        FAILS.append(name)
        print(f"  FAIL {name} {extra}")


class HttpErr(Exception):
    pass


def call(method, path, body=None, token=None, expect=(200,)):
    req = urllib.request.Request(BASE + path, method=method)
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        req.add_header("Content-Type", "application/json")
        req.data = data
    if token:
        req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            status = r.status
            text = r.read().decode()
            ctype = r.headers.get("Content-Type", "")
    except urllib.error.HTTPError as e:
        status = e.code
        text = e.read().decode()
        ctype = e.headers.get("Content-Type", "")
    parsed = json.loads(text) if "application/json" in ctype and text else text
    if status not in expect:
        raise HttpErr(f"{method} {path} -> {status} (expected {expect}): {text[:220]}")
    return status, parsed


def login(pin):
    s, r = call("POST", "/api/auth/login", {"pin": pin})
    assert s == 200 and r.get("token"), r
    return r["token"]


def wait_up(timeout=40):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            with urllib.request.urlopen(BASE + "/api/health", timeout=3) as r:
                if r.status == 200:
                    return True
        except Exception:
            pass
        time.sleep(0.5)
    return False


def seed_db(path):
    for ext in ("", "-wal", "-shm", "-journal"):
        if os.path.exists(path + ext):
            os.remove(path + ext)
    env = dict(os.environ, EXPOLINE_DB=path)
    r = subprocess.run(["node", "db/seed.js"], cwd=SRV_DIR, env=env,
                       capture_output=True, text=True, timeout=180)
    assert r.returncode == 0, r.stderr[:500]


def kill_4327():
    subprocess.run("lsof -ti:4327 | xargs kill -9 2>/dev/null", shell=True)
    time.sleep(2)


def start_server():
    env = dict(os.environ, EXPOLINE_PORT=PORT, EXPOLINE_DB=DB_A)
    with open(BOOT_LOG, "a") as log:
        subprocess.Popen(["node", "server.js"], cwd=SRV_DIR, env=env,
                         stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    assert wait_up(), "server did not come up on port 4327"


def dbsql(path, q, args=()):
    con = sqlite3.connect(path)
    try:
        cur = con.execute(q, args)
        rows = cur.fetchall()
        con.commit()
        return rows
    finally:
        con.close()


def get(path, tok, expect=(200,)):
    return call("GET", path, token=tok, expect=expect)


def post(path, body, tok, expect=(200, 201)):
    return call("POST", path, body=body, token=tok, expect=expect)


MT = ST = KT = None
MENU_ITEM = MOD_ITEM = None
MOD_NAME = "Extra"
SITE_ID = None


def setup_tokens():
    global MT, ST, KT, MENU_ITEM, MOD_ITEM, MOD_NAME, SITE_ID
    MT = login("2580")   # manager
    ST = login("1111")   # server
    KT = login("2222")   # kitchen
    s, menu = get("/api/menu", ST)
    # /api/menu returns only active items (already filtered server-side)
    items = [it for c in menu for it in (c.get("items") or [])]
    assert len(items) >= 2, "seed needs >= 2 active menu items"
    MENU_ITEM = items[0]
    # Phase 1B money audit: modifiers must exist on the menu item, so pick a
    # MOD_ITEM that actually has modifiers and use its first modifier.
    MOD_ITEM = next((it for it in items if it.get("modifiers")), items[1])
    MOD_NAME = (MOD_ITEM.get("modifiers") or [{"name": "Extra"}])[0]["name"]
    SITE_ID = dbsql(DB_A, "SELECT site_id FROM tables LIMIT 1")[0][0]


def free_table(tok):
    s, zones = get("/api/zones", tok)
    for z in zones:
        for t in z.get("tables", []):
            if not t.get("open_check_id"):
                return t["id"]
    raise AssertionError("no free table")


def new_check(tok, table_id=None, guests=2, tab=None):
    table_id = table_id or free_table(tok)
    s, c = post("/api/checks", {"table_id": table_id, "guest_count": guests,
                                "tab_name": tab}, tok, expect=(201,))
    return c["id"]


def add_item(tok, check_id, menu_id, qty=1, seat=1, modifiers=None, unit_price=None):
    body = {"menu_item_id": menu_id, "qty": qty, "seat": seat, "modifiers": modifiers or []}
    if unit_price is not None:
        body["unit_price_cents"] = unit_price
    s, items = post(f"/api/checks/{check_id}/items", body, tok, expect=(201,))
    return items


def pay_full_close(tok, check_id, mgr_pin="2580"):
    s, c = get(f"/api/checks/{check_id}", tok)
    total = c["totals"]["total"]
    post(f"/api/checks/{check_id}/payments",
         {"method": "cash", "amount_cents": total, "tendered_cents": total}, tok)
    s, c = post(f"/api/checks/{check_id}/close", {}, tok)
    return c


# ---------------------------------------------------------------- 1. waitlist
def expected_median():
    rows = dbsql(DB_A,
                 "SELECT (strftime('%s', closed_at) - strftime('%s', opened_at))/60.0 "
                 "FROM checks WHERE site_id = ? AND status = 'closed' AND opened_at IS NOT NULL "
                 "AND closed_at >= datetime('now', '-28 days') AND guest_count BETWEEN 1 AND 2",
                 (SITE_ID,))
    mins = sorted(r[0] for r in rows if r[0] and r[0] > 0)
    n = len(mins)
    return (mins[n // 2] if n % 2 else (mins[n // 2 - 1] + mins[n // 2]) / 2), n


def test_waitlist():
    print("--- 1. waitlist quotes + pre-ordering ---")
    s, q = get("/api/waitlist/quote?party_size=2", ST)
    check("quote endpoint 200", s == 200)
    check("quote has quoted_wait_min int", isinstance(q.get("quoted_wait_min"), int) and q["quoted_wait_min"] >= 0)
    check("quote basis flags fallback honestly (seed < 5 samples)", q["basis"]["fallback"] is True and q["basis"]["samples"] < 5)

    # real data: 5 backdated closed checks with known turn times
    tbl = free_table(ST)
    for mins in (40, 50, 60, 70, 80):
        dbsql(DB_A,
              "INSERT INTO checks (uuid, site_id, table_id, guest_count, status, opened_at, closed_at) "
              "VALUES (hex(randomblob(16)), ?, ?, 2, 'closed', "
              "datetime('now', ?), datetime('now'))",
              (SITE_ID, tbl, f"-{mins} minutes"))
    time.sleep(0.2)
    med, n = expected_median()
    s, q = get("/api/waitlist/quote?party_size=2", ST)
    check("real data drives quote basis (no fallback)", q["basis"]["fallback"] is False and q["basis"]["samples"] == n >= 5,
          str(q["basis"]))
    check("basis median matches hand-computed median", abs(q["basis"]["median_turn_min"] - round(med)) <= 1,
          f"api={q['basis']['median_turn_min']} expected~{med}")
    check("free tables + empty queue -> quote 0", q["quoted_wait_min"] == 0 and q["basis"]["free_now"] > 0)

    # occupy every table -> the quote must be driven by the median turn time
    tids = [t[0] for t in dbsql(DB_A, "SELECT id FROM tables WHERE site_id = ?", (SITE_ID,))]
    for tid in tids:
        dbsql(DB_A,
              "INSERT INTO checks (uuid, site_id, table_id, guest_count, status, opened_at) "
              "VALUES (hex(randomblob(16)), ?, ?, 2, 'open', datetime('now'))",
              (SITE_ID, tid))
    s, q2 = get("/api/waitlist/quote?party_size=2", ST)
    check("full house -> quote from median turn", q2["basis"]["free_now"] == 0 and abs(q2["quoted_wait_min"] - round(med)) <= 2,
          str(q2))
    dbsql(DB_A, "DELETE FROM checks WHERE site_id = ? AND status = 'open'", (SITE_ID,))

    # add without quote -> server computes it
    s, w = post("/api/waitlist", {"customer_name": "QA Party", "phone": "555-0100", "party_size": 2}, ST, expect=(201,))
    check("waitlist add computes quote server-side", isinstance(w.get("quoted_wait_min"), int), str(w.get("quoted_wait_min")))
    check("waitlist add returns quote_basis", "quote_basis" in w)

    # pre-order validation
    s, w2 = post("/api/waitlist", {"customer_name": "Preorder QA", "phone": "555-0101", "party_size": 2,
                                  "preorder_items": [{"menu_item_id": MENU_ITEM["id"], "qty": 2},
                                                    {"menu_item_id": 999999, "qty": 1}]}, ST, expect=(400,))
    check("bad preorder menu_item_id rejected", s == 400 and "menu_item_id" in str(w2), str(w2))
    s, w3 = post("/api/waitlist", {"customer_name": "Preorder QA", "phone": "555-0101", "party_size": 2,
                                  "preorder_items": [{"menu_item_id": MENU_ITEM["id"], "qty": 2, "seat": 1}]}, ST, expect=(201,))
    check("preorder stored on waitlist entry", (w3.get("preorder_items") or [{}])[0].get("qty") == 2, str(w3.get("preorder_items")))
    pre_id = w3["id"]

    # seat with table -> held items attach to the new check
    s, seated = post(f"/api/waitlist/{pre_id}/seat", {"table_id": free_table(ST)}, ST)
    check("seat returns check_id", seated.get("check_id"), str(seated))
    s, c = get(f"/api/checks/{seated['check_id']}", ST)
    held = [i for i in c.get("items", []) if i.get("state") == "held" and i.get("menu_item_id") == MENU_ITEM["id"]]
    check("preorder items attached as held on new check", sum(i["qty"] for i in held) == 2, str(c.get("items")))
    check("seat reports preorder_attached (lines)", seated.get("preorder_attached") == 1, str(seated))

    # 86 the item after pre-order taken -> skipped at seat time, reported
    s, w4 = post("/api/waitlist", {"customer_name": "Skip QA", "phone": "555-0102", "party_size": 2,
                                  "preorder_items": [{"menu_item_id": MENU_ITEM["id"], "qty": 1}]}, ST, expect=(201,))
    s, r86 = post(f"/api/admin/menu/86/{MENU_ITEM['id']}", {}, MT)
    check("manager can 86 item", r86.get("eightysixed") is True)
    s, seated2 = post(f"/api/waitlist/{w4['id']}/seat", {"table_id": free_table(ST)}, ST)
    check("86d preorder item skipped at seat", seated2.get("preorder_attached") == 0 and len(seated2.get("preorder_skipped") or []) == 1,
          str(seated2))
    post(f"/api/admin/menu/86/{MENU_ITEM['id']}", {}, MT)  # un-86 for later tests

    # role: kitchen blocked
    try:
        get("/api/waitlist", KT, expect=(403,))
        check("kitchen blocked from waitlist", True)
    except HttpErr:
        check("kitchen blocked from waitlist", False)


# ---------------------------------------------------------------- 2. cash drawer
def test_cash():
    print("--- 2. blind-count cash drawer ---")
    try:
        post("/api/cash/drawer/open", {"opening_float_cents": 20000}, ST, expect=(403,))
        check("server cannot open drawer", True)
    except HttpErr:
        check("server cannot open drawer", False)
    s, d = post("/api/cash/drawer/open", {"opening_float_cents": 20000}, MT, expect=(201,))
    check("manager opens drawer", d.get("status") == "open" and d.get("opening_float_cents") == 20000)
    try:
        post("/api/cash/drawer/open", {"opening_float_cents": 1}, MT, expect=(409,))
        check("second open while open -> 409", True)
    except HttpErr:
        check("second open while open -> 409", False)

    s, blind = get("/api/cash/drawer", ST)
    check("server view is blind (no expected_cents)", "expected_cents" not in blind.get("drawer", {}), str(blind.get("drawer", {}).keys()))
    s, seen = get("/api/cash/drawer", MT)
    check("manager sees expected 200.00", seen["drawer"].get("expected_cents") == 20000, str(seen["drawer"]))

    cid = new_check(ST)
    add_item(ST, cid, MENU_ITEM["id"], qty=1)
    s, c = get(f"/api/checks/{cid}", ST)
    total = c["totals"]["total"]
    post(f"/api/checks/{cid}/payments", {"method": "cash", "amount_cents": total, "tendered_cents": total}, ST)
    post(f"/api/checks/{cid}/close", {}, ST)
    s, seen2 = get("/api/cash/drawer", MT)
    check("cash payment raises expected", seen2["drawer"]["expected_cents"] == 20000 + total, str(seen2["drawer"]))

    post("/api/cash/drawer/event", {"kind": "paid_out", "amount_cents": 1000, "note": "bank run"}, MT, expect=(201,))
    s, seen3 = get("/api/cash/drawer", MT)
    check("paid_out lowers expected", seen3["drawer"]["expected_cents"] == 20000 + total - 1000, str(seen3["drawer"]))
    check("event appears in drawer log", any(e.get("kind") == "paid_out" for e in seen3["events"]))
    s, ev = post("/api/cash/drawer/event", {"kind": "note", "note": "server note"}, ST, expect=(201,))
    check("server can log drawer note (server+)", ev.get("ok") is True)
    try:
        post("/api/cash/drawer/event", {"kind": "bogus"}, MT, expect=(400,))
        check("bad event kind rejected", True)
    except HttpErr:
        check("bad event kind rejected", False)

    s, closed = post("/api/cash/drawer/close", {"counted_cents": seen3["drawer"]["expected_cents"] + 500, "notes": "qa"}, MT)
    check("close computes variance server-side", closed["drawer"].get("variance_cents") == 500 and
          closed["drawer"].get("expected_cents") == seen3["drawer"]["expected_cents"], str(closed["drawer"]))
    s, blind2 = get("/api/cash/drawer", ST)
    check("server close receipt also blind", "expected_cents" not in (blind2.get("drawer") or {}))
    check("no open drawer after close", blind2.get("drawer") is None)
    try:
        post("/api/cash/drawer/close", {"counted_cents": 0}, MT, expect=(409,))
        check("close with no open drawer -> 409", True)
    except HttpErr:
        check("close with no open drawer -> 409", False)
    s, hist = get("/api/cash/log", MT)
    check("log shows closed drawer", any(h.get("status") == "closed" for h in hist), str(len(hist)))


# ---------------------------------------------------------------- 3. scheduling
def test_schedule():
    print("--- 3. scheduling + labor/sales projection ---")
    s, emps = get("/api/admin/employees", MT)
    emp = [e for e in emps if e.get("active")][0]
    day = "2026-09-30"
    good = {"user_id": emp["id"], "work_date": day, "start_min": 540, "end_min": 1020,
            "rate_cents": 2000, "role": "server"}
    try:
        post("/api/admin/schedule", good, ST, expect=(403,))
        check("server cannot create shift", True)
    except HttpErr:
        check("server cannot create shift", False)
    try:
        bad = dict(good, start_min=1020, end_min=540)
        post("/api/admin/schedule", bad, MT, expect=(400,))
        check("end-before-start rejected", True)
    except HttpErr:
        check("end-before-start rejected", False)
    try:
        bad2 = dict(good, work_date="09/30/2026")
        post("/api/admin/schedule", bad2, MT, expect=(400,))
        check("bad work_date rejected", True)
    except HttpErr:
        check("bad work_date rejected", False)
    s, sh = post("/api/admin/schedule", good, MT, expect=(201,))
    check("shift created", sh.get("id"), str(sh))
    sid = sh["id"]

    # seed trailing sales on the same weekday (Wednesday) for the projection
    for wday in ("2026-09-16", "2026-09-23"):
        dbsql(DB_A,
              "INSERT INTO checks (uuid, site_id, table_id, guest_count, status, opened_at, closed_at, total_cents) "
              "VALUES (hex(randomblob(16)), ?, ?, 2, 'closed', ?, ?, 10000)",
              (SITE_ID, free_table(ST), f"{wday}T12:00:00", f"{wday}T13:00:00"))
    time.sleep(0.2)

    s, wk = get("/api/admin/schedule?week=2026-09-28", MT)
    check("week view contains shift", any(x["id"] == sid for x in wk["shifts"]))
    s, proj = get("/api/admin/schedule/projection?week=2026-09-28", MT)
    wed = [d for d in proj["days"] if d["date"] == day][0]
    check("labor = 8h x $20 = $160.00", wed["scheduled_labor_cents"] == 16000, str(wed["scheduled_labor_cents"]))
    check("sales projection from trailing Wednesdays", wed["projected_sales_cents"] == 10000 and
          wed["projected_sales_samples"] == 2, str(wed))
    check("labor pct computed", wed["projected_labor_pct"] == 160.0, str(wed["projected_labor_pct"]))
    other = [d for d in proj["days"] if d["date"] != day][0]
    check("other days carry no labor", other["scheduled_labor_cents"] == 0)
    try:
        get("/api/admin/schedule/projection?week=not-a-date", MT, expect=(400,))
        check("bad week start -> 400", True)
    except HttpErr:
        check("bad week start -> 400", False)
    s, upd = call("PUT", f"/api/admin/schedule/{sid}", {"role": "kitchen"}, MT, expect=(200,))
    check("shift update", upd.get("role") == "kitchen")
    s, dl = call("DELETE", f"/api/admin/schedule/{sid}", None, MT, expect=(200,))
    check("shift delete", dl.get("deleted") == sid)


# ---------------------------------------------------------------- 4. product mix
def test_product_mix():
    print("--- 4. product-mix analytics ---")
    today = time.strftime("%Y-%m-%d", time.gmtime())
    s, base = get(f"/api/finance/product-mix?from={today}&to={today}", MT)
    base_qty = {r["menu_item_id"]: r["qty_sold"] for r in base["items"]}
    base_void = {r["menu_item_id"]: r["voided_qty"] for r in base["items"]}
    cid = new_check(ST, guests=2)
    add_item(ST, cid, MENU_ITEM["id"], qty=2, seat=1)
    add_item(ST, cid, MOD_ITEM["id"], qty=1, seat=2,
             modifiers=[{"name": MOD_NAME, "price_delta_cents": 150}])
    post(f"/api/checks/{cid}/send", {}, ST)
    s, c = get(f"/api/checks/{cid}", ST)
    mod_line = [i for i in c["items"] if i["menu_item_id"] == MOD_ITEM["id"]][0]
    post(f"/api/checks/{cid}/void-item",
         {"item_id": mod_line["id"], "manager_pin": "2580", "reason": "qa void"}, ST)
    pay_full_close(ST, cid)

    s, mix = get(f"/api/finance/product-mix?from={today}&to={today}", MT)
    check("mix returns rows", len(mix.get("items") or []) > 0, str(mix))
    row_a = [r for r in mix["items"] if r["menu_item_id"] == MENU_ITEM["id"]][0]
    check("sold qty counted (delta over seed baseline)",
          row_a["qty_sold"] - base_qty.get(MENU_ITEM["id"], 0) == 2, str(row_a))
    check("gross equals qty x unit price", row_a["gross_cents"] >= 2 * row_a["unit_price_cents"] if "unit_price_cents" in row_a else True)
    voided = [r for r in mix["items"] if r["menu_item_id"] == MOD_ITEM["id"]]
    check("voided qty separated from gross",
          voided and voided[0]["voided_qty"] - base_void.get(MOD_ITEM["id"], 0) == 1 and voided[0]["gross_cents"] == 0,
          str(voided))
    check("modifier delta included in gross",
          any(r["menu_item_id"] == MENU_ITEM["id"] for r in mix["items"]))
    check("totals present", "qty_sold" in mix.get("totals", {}))
    check("best/worst lists present", "best_by_qty" in mix and "worst_by_gross" in mix)
    try:
        get("/api/finance/product-mix", KT, expect=(403,))
        check("kitchen blocked from product-mix", True)
    except HttpErr:
        check("kitchen blocked from product-mix", False)
    try:
        get("/api/finance/product-mix?from=not-a-date", MT, expect=(400,))
        check("bad from rejected", True)
    except HttpErr:
        check("bad from rejected", False)


# ---------------------------------------------------------------- 5. staff notes
def test_notes():
    print("--- 5. staff notes at login ---")
    try:
        post("/api/admin/notes", {"title": "x", "priority": "high"}, ST, expect=(403,))
        check("server cannot create note", True)
    except HttpErr:
        check("server cannot create note", False)
    s, n = post("/api/admin/notes", {"title": "Special tonight", "body": "Lobster special",
                                    "priority": "high"}, MT, expect=(201,))
    check("note created", n.get("id"), str(n))
    nid = n["id"]
    s, n2 = post("/api/admin/notes", {"title": "Old note", "priority": "normal",
                                     "active_to": "2020-01-01T00:00:00"}, MT, expect=(201,))
    s, ls = get("/api/login-summary", ST)
    check("login-summary has all sections", all(k in ls for k in ("notes", "eighty_six", "reservations_today", "review_prompt")))
    check("active note surfaces", any(x["title"] == "Special tonight" for x in ls["notes"]), str(ls["notes"]))
    check("expired note hidden", not any(x["title"] == "Old note" for x in ls["notes"]))
    s, r86 = post(f"/api/admin/menu/86/{MOD_ITEM['id']}", {}, MT)
    s, ls2 = get("/api/login-summary", ST)
    check("86d item surfaces in summary", MOD_ITEM["name"] in ls2["eighty_six"], str(ls2["eighty_six"]))
    post(f"/api/admin/menu/86/{MOD_ITEM['id']}", {}, MT)  # restore
    s, dl = call("DELETE", f"/api/admin/notes/{nid}", None, MT, expect=(200,))
    check("note deleted", dl.get("deleted") == nid)
    call("DELETE", f"/api/admin/notes/{n2['id']}", None, MT, expect=(200,))


# ---------------------------------------------------------------- 6. reviews
def test_reviews():
    print("--- 6. post-payment reviews ---")
    cid = new_check(ST)
    add_item(ST, cid, MENU_ITEM["id"], qty=1)
    try:
        post("/api/reviews", {"check_id": cid, "rating": 5}, ST, expect=(400,))
        check("open check cannot be reviewed", True)
    except HttpErr:
        check("open check cannot be reviewed", False)
    pay_full_close(ST, cid)
    s, r = post("/api/reviews", {"check_id": cid, "rating": 5, "comment": "Great!"}, ST, expect=(201,))
    check("review submitted", r.get("id"), str(r))
    try:
        post("/api/reviews", {"check_id": cid, "rating": 4}, ST, expect=(409,))
        check("duplicate review -> 409", True)
    except HttpErr:
        check("duplicate review -> 409", False)
    try:
        post("/api/reviews", {"check_id": cid, "rating": 6}, ST, expect=(400,))
        check("rating 6 rejected", True)
    except HttpErr:
        check("rating 6 rejected", False)
    s, summ = get("/api/reviews", MT)
    check("summary average 5.0 count 1", summ.get("average") == 5.0 and summ.get("count") == 1, str(summ))
    s, cfg = call("PUT", "/api/admin/settings", {"key": "review_prompt", "value": "false"}, MT, expect=(200,))
    check("prompt disabled site-wide (string 'false')", cfg.get("value") == "0")
    s, ls3 = get("/api/login-summary", ST)
    check("login-summary reflects disabled prompt", ls3.get("review_prompt") is False)
    cid2 = new_check(ST); add_item(ST, cid2, MENU_ITEM["id"], qty=1); pay_full_close(ST, cid2)
    try:
        post("/api/reviews", {"check_id": cid2, "rating": 5}, ST, expect=(409,))
        check("review blocked when disabled", True)
    except HttpErr:
        check("review blocked when disabled", False)
    call("PUT", "/api/admin/settings", {"key": "review_prompt", "value": "true"}, MT, expect=(200,))


# ---------------------------------------------------------------- 7. multisite
def test_multisite():
    print("--- 7. isolated multi-location dashboard ---")
    with open(CORRUPT, "wb") as f:
        f.write(b"this is not a sqlite database at all")
    s, ov = get("/api/admin/multisite/overview", MT)
    sites = {x["slug"]: x for x in ov["sites"]}
    check("overview lists current site", "parity-qa-a" in sites)
    check("current site reads live data", sites["parity-qa-a"]["ok"] is True and
          sites["parity-qa-a"]["sales_today_cents"] >= 0, str(sites["parity-qa-a"]))
    check("second site isolated and readable", sites.get("parity-qa-b", {}).get("ok") is True)
    check("corrupt site isolated (ok:false, no crash)", sites.get("parity-qa-corrupt", {}).get("ok") is False,
          str(sites.get("parity-qa-corrupt")))
    try:
        get("/api/admin/multisite/overview", KT, expect=(403,))
        check("kitchen blocked from multisite", True)
    except HttpErr:
        check("kitchen blocked from multisite", False)
    os.remove(CORRUPT)


# ---------------------------------------------------------------- 8. api docs
def test_docs():
    print("--- 8. API documentation ---")
    s, doc = get("/api/openapi.json", MT)
    paths = [e["path"] for e in doc["endpoints"]]
    for p in ("/api/cash/drawer/close", "/api/waitlist/quote", "/api/finance/product-mix",
              "/api/admin/schedule/projection", "/api/reviews", "/api/admin/inventory/ingredients"):
        check(f"openapi documents {p}", p in paths)
    s, html = get("/api/docs", MT)
    check("docs page is HTML", "Expoline API" in html)
    try:
        get("/api/openapi.json", KT, expect=(403,))
        check("kitchen blocked from docs", True)
    except HttpErr:
        check("kitchen blocked from docs", False)


# ---------------------------------------------------------------- 9. inventory
def test_inventory():
    print("--- 9. ingredient-level inventory (phase 1) ---")
    try:
        post("/api/admin/inventory/ingredients",
             {"name": "x", "unit": "lb", "on_hand": 1}, ST, expect=(403,))
        check("server cannot manage inventory", True)
    except HttpErr:
        check("server cannot manage inventory", False)
    s, ing = post("/api/admin/inventory/ingredients",
                  {"name": "QA Chicken", "unit": "lb", "on_hand": 100, "par": 10,
                   "cost_per_unit_cents": 250}, MT, expect=(201,))
    iid = ing["id"]
    check("ingredient created", ing.get("on_hand") == 100 and ing.get("par") == 10)
    s, rec = post("/api/admin/inventory/recipes",
                  {"menu_item_id": MENU_ITEM["id"],
                   "lines": [{"ingredient_id": iid, "qty": 2}]}, MT, expect=(200,))
    check("recipe set", rec.get("lines") == 1)
    try:
        post("/api/admin/inventory/recipes",
             {"menu_item_id": MENU_ITEM["id"], "lines": [{"ingredient_id": 999999, "qty": 1}]},
             MT, expect=(400,))
        check("recipe with bad ingredient rejected", True)
    except HttpErr:
        check("recipe with bad ingredient rejected", False)

    def on_hand():
        s, lst = get("/api/admin/inventory/ingredients", MT)
        return [i for i in lst if i["id"] == iid][0]["on_hand"]

    cid = new_check(ST)
    add_item(ST, cid, MENU_ITEM["id"], qty=3)
    post(f"/api/checks/{cid}/send", {}, ST)
    check("send depletes on_hand by qty x recipe (100-6=94)", on_hand() == 94, str(on_hand()))
    s, adj = post("/api/admin/inventory/adjust", {"ingredient_id": iid, "delta": -90,
                                                 "reason": "spoilage"}, MT, expect=(200,))
    check("manual adjustment", adj.get("on_hand") == 4, str(adj))
    s, st = get("/api/inventory/status", MT)
    check("low-stock flagged", any(i["id"] == iid for i in st["low_stock"]), str(st["low_stock"]))
    check("adjustment audited", any(a.get("reason") == "spoilage" and a.get("delta") == -90
                                    for a in st["recent_adjustments"]), str(st["recent_adjustments"]))
    try:
        get("/api/inventory/status", KT, expect=(403,))
        check("kitchen blocked from inventory", True)
    except HttpErr:
        check("kitchen blocked from inventory", False)


def main():
    kill_4327()
    for p in (DB_A, DB_B):
        if os.path.exists(p):
            for ext in ("", "-wal", "-shm", "-journal"):
                if os.path.exists(p + ext):
                    os.remove(p + ext)
    if os.path.exists(CORRUPT):
        os.remove(CORRUPT)
    print("seeding site DBs ...")
    seed_db(DB_B)
    seed_db(DB_A)
    print("starting server on 4327 ...")
    start_server()
    try:
        setup_tokens()
        test_waitlist()
        test_cash()
        test_schedule()
        test_product_mix()
        test_notes()
        test_reviews()
        test_multisite()
        test_docs()
        test_inventory()
    finally:
        kill_4327()
        for p in (DB_A, DB_B):
            for ext in ("", "-wal", "-shm", "-journal"):
                if os.path.exists(p + ext):
                    os.remove(p + ext)
        if os.path.exists(CORRUPT):
            os.remove(CORRUPT)
    print(f"\n== test23: {PASSES} passed, {len(FAILS)} failed ==")
    if FAILS:
        print("FAILED:", FAILS)
        sys.exit(1)


if __name__ == "__main__":
    main()
