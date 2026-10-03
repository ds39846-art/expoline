#!/usr/bin/env python3
"""test37_stale_checks.py — boot-time stale open-check report (report-only).

Plants open checks via SQL against a scratch DB, reboots, and verifies:
  - a check opened 3 days ago with its last item 3 days ago IS stale;
  - a fresh open check is NOT;
  - a check opened 3 days ago but with an item 30 minutes ago is NOT
    (last activity, not opened_at, decides — the discriminating case);
  - a check opened 3 days ago with a payment 2 hours ago is NOT;
  - a paid check from 3 days ago is NOT (not open);
  - the stale check appears in the boot log line AND in
    GET /api/manager/overview stale_open_checks with id/table/age/
    items/total, the endpoint stays manager-only, and the stale check
    is still OPEN afterwards (nothing auto-closed).
Own server on :4347. Never touches 4317/4320.
"""
import json, os, signal, sqlite3, subprocess, sys, time
import urllib.request, urllib.error
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PORT = 4347
DB = "/tmp/expoline-test37.db"
BASE = f"http://localhost:{PORT}"
LOG = "/tmp/expoline-test37-boot.log"

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
        return e.code, {}

def boot(logpath=None):
    env = dict(os.environ, EXPOLINE_PORT=str(PORT), EXPOLINE_DB=DB, NODE_ENV="test")
    out = open(logpath, "w") if logpath else subprocess.DEVNULL
    p = subprocess.Popen(["node", str(ROOT / "server.js")], env=env, stdout=out, stderr=subprocess.STDOUT)
    for _ in range(60):
        try:
            with urllib.request.urlopen(BASE + "/api/health", timeout=2) as r:
                if r.status == 200: return p
        except Exception: time.sleep(0.5)
    p.kill(); raise RuntimeError("server did not come up")

def stop(p):
    if p and p.poll() is None:
        p.send_signal(signal.SIGTERM); p.wait(timeout=10)

def sql(q, args=()):
    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    try:
        rows = con.execute(q, args).fetchall(); con.commit(); return rows
    finally: con.close()

def iso(**kw):
    return (datetime.now(timezone.utc) - timedelta(**kw)).strftime("%Y-%m-%dT%H:%M:%SZ")

def main():
    for suf in ("", "-wal", "-shm"):
        try: os.remove(DB + suf)
        except FileNotFoundError: pass

    srv = boot(); stop(srv)  # schema + seed

    tables = sql("SELECT id, label FROM tables ORDER BY id LIMIT 5")
    server_id = sql("SELECT id FROM users WHERE site_id='bali-hai' AND role='server' LIMIT 1")[0]["id"]
    menu_item = sql("SELECT id FROM menu_items WHERE site_id='bali-hai' LIMIT 1")[0]["id"]
    old, recent_item, recent_pay = iso(days=3), iso(minutes=30), iso(hours=2)

    def plant_check(tidx, status, opened_at, total=0):
        con = sqlite3.connect(DB)
        try:
            cur = con.execute(
                "INSERT INTO checks (uuid, site_id, table_id, server_id, guest_count, status,"
                " total_cents, opened_at) VALUES (?,?,?,?,?,?,?,?)",
                (f"test37-{tidx}", "bali-hai", tables[tidx]["id"], server_id, 2, status, total, opened_at))
            con.commit(); return cur.lastrowid
        finally: con.close()

    C1 = plant_check(0, "open", old, total=4200)   # stale: opened + last item 3d ago
    C2 = plant_check(1, "open", iso(minutes=5))    # fresh -> not stale
    C3 = plant_check(2, "open", old)               # old open, RECENT item -> not stale
    C4 = plant_check(3, "open", old)               # old open, RECENT payment -> not stale
    C5 = plant_check(4, "paid", old)               # not open -> excluded
    sql("INSERT INTO check_items (check_id, menu_item_id, seat, qty, unit_price_cents, state, added_at)"
        " VALUES (?, ?, 1, 1, 4200, 'held', ?)", (C1, menu_item, old))
    sql("INSERT INTO check_items (check_id, menu_item_id, seat, qty, unit_price_cents, state, added_at)"
        " VALUES (?, ?, 1, 1, 900, 'held', ?)", (C3, menu_item, recent_item))
    sql("INSERT INTO payments (check_id, site_id, method, amount_cents, tip_cents, status, created_at)"
        " VALUES (?, 'bali-hai', 'cash', 1000, 0, 'completed', ?)", (C4, recent_pay))

    srv = boot(LOG)
    try:
        log = Path(LOG).read_text()
        line = next((l for l in log.splitlines() if "stale open checks" in l), "")
        ok(f"): 1 — #{C1}" in line, "boot log: exactly one stale check, id listed", f"line={line!r}")

        st, r = api("POST", "/api/auth/login", None, {"pin": "2580"})
        assert st == 200, f"manager login failed: {r}"
        mtok = r["token"]
        st, ov = api("GET", "/api/manager/overview", mtok)
        ok(st == 200, "overview responds for manager", f"st={st}")
        soc = ov.get("stale_open_checks") or {}
        ok(soc.get("threshold_hours") == 24, "overview: threshold_hours = 24 (default)",
           f"got {soc.get('threshold_hours')}")
        rows = soc.get("checks") or []
        ids = [r["check_id"] for r in rows]
        ok(ids == [C1], "overview: stale list is exactly the backdated check",
           f"ids={ids} want=[{C1}] (C2 fresh, C3 recent item, C4 recent payment, C5 paid)")
        if rows:
            row = rows[0]
            ok(row.get("table_label") == tables[0]["label"], "overview: table label present",
               f"got {row.get('table_label')} want {tables[0]['label']}")
            ok(row.get("item_count") == 1, "overview: item_count = 1", f"got {row.get('item_count')}")
            ok(row.get("total_cents") == 4200, "overview: total_cents = 4200", f"got {row.get('total_cents')}")
            ok(71 <= (row.get("age_hours") or 0) <= 73.5, "overview: age_hours ≈ 72",
               f"got {row.get('age_hours')}")
            ok(row.get("last_activity_at") == old, "overview: last_activity_at = last item time",
               f"got {row.get('last_activity_at')} want {old}")
        st, r = api("POST", "/api/auth/login", None, {"pin": "1111"})
        stok = r["token"]
        st, _ = api("GET", "/api/manager/overview", stok)
        ok(st == 403, "overview stays manager-only (server role 403)", f"st={st}")
    finally:
        stop(srv)

    status = sql("SELECT status FROM checks WHERE id = ?", (C1,))[0]["status"]
    ok(status == "open", "stale check still OPEN after boot (report-only, nothing auto-closed)",
       f"status={status}")

    print(f"\n{'ALL GREEN' if not fails else 'FAILURES'}: {checks - len(fails)}/{checks} checks passed")
    sys.exit(1 if fails else 0)

if __name__ == "__main__":
    main()
