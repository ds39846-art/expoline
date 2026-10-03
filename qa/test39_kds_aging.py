#!/usr/bin/env python3
"""test39_kds_aging.py — KDS aging thresholds as manager minute settings.

Covers the batch-4 WS2 surface:
  - PUT /api/admin/settings accepts kds_age_warn_minutes /
    kds_age_critical_minutes (defaults 8 / 15), validates integers
    1..240 and warn < critical (against the stored counterpart, or the
    defaults when the pair was never saved), rejects as server (403);
  - saving either key materializes BOTH minute keys and their derived
    seconds keys, so GET /api/kds/settings (the channel the KDS board
    already reads) reports warn_secs / late_secs in minutes x 60;
  - an untouched site keeps the long-standing 600 / 1200 / 240 board
    thresholds (the keys are not boot-seeded);
  - POST /api/kds/settings (seconds surface) takes ownership back:
    the minute keys are dropped and a later minute save re-pairs
    against the defaults;
  - the treatment decision itself: the REAL client kdsBand() from
    public/app.js (qa/harness39_kds.js) at the live server thresholds,
    plus the server-side agingFor() on a real fired ticket backdated
    in the scratch DB (overdue / aging / aging_soon / fresh-absent via
    GET /api/kds/alerts).
Own server on :4349, fresh /tmp DB. Never touches 4317/4320.
Pre-fix control: at bccaf0a the minute keys are not whitelisted, so
every PUT below returns 400 and this suite fails there.
"""
import json, os, signal, sqlite3, subprocess, sys, time
import urllib.request, urllib.error
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PORT = 4349
DB = "/tmp/expoline-test39.db"
BASE = f"http://localhost:{PORT}"
LOG = "/tmp/expoline-test39-boot.log"

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
    out = open(LOG, "w")
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
    try:
        rows = con.execute(q, args).fetchall(); con.commit(); return rows
    finally: con.close()

def login(pin):
    s, b = api("POST", "/api/auth/login", None, {"pin": pin})
    assert s == 200, (s, b)
    return b["token"]

def put_setting(tok, key, value):
    return api("PUT", "/api/admin/settings", tok, {"key": key, "value": value})

def thresholds(tok):
    s, b = api("GET", "/api/kds/settings", tok)
    assert s == 200, (s, b)
    return b["thresholds"]

def main():
    for suf in ("", "-wal", "-shm"):
        try: os.remove(DB + suf)
        except FileNotFoundError: pass

    srv = boot()
    try:
        MT, ST, KT = login("2580"), login("1111"), login("2222")

        print("== 1. settings round-trip (minute pair via PUT /api/admin/settings) ==")
        th = thresholds(KT)
        ok(th == {"warn_secs": 600, "late_secs": 1200, "alert_lead_secs": 240},
           "untouched site keeps 600/1200/240 board thresholds", f"{th}")
        s, _ = put_setting(ST, "kds_age_warn_minutes", 10)
        ok(s == 403, "minute setting as server role -> 403", f"s={s}")
        s, _ = put_setting(MT, "not_a_setting", 5)
        ok(s == 400, "non-whitelisted key -> 400", f"s={s}")
        # Pair defaults proven black-box: with nothing ever saved, warn may
        # not reach the default critical (15) and critical may not drop to
        # the default warn (8).
        s, _ = put_setting(MT, "kds_age_warn_minutes", 15)
        ok(s == 400, "warn=15 rejected against default critical 15", f"s={s}")
        s, _ = put_setting(MT, "kds_age_critical_minutes", 8)
        ok(s == 400, "critical=8 rejected against default warn 8", f"s={s}")
        for bad in (0, 241, 8.5, "abc"):
            s, _ = put_setting(MT, "kds_age_warn_minutes", bad)
            ok(s == 400, f"warn={bad!r} -> 400 (integer 1..240)", f"s={s}")
        s, b = put_setting(MT, "kds_age_warn_minutes", 10)
        ok(s == 200 and b.get("key") == "kds_age_warn_minutes" and b.get("value") == "10",
           "warn=10 saves (200, {key, value})", f"s={s} {b}")
        th = thresholds(KT)
        ok(th["warn_secs"] == 600 and th["late_secs"] == 900,
           "board follows: warn 10m -> 600s, critical materialized at default 15m -> 900s", f"{th}")
        rows = dict(sql("SELECT key, value FROM site_config WHERE key LIKE 'kds_age%'"))
        ok(rows == {"kds_age_warn_minutes": "10", "kds_age_critical_minutes": "15"},
           "both minute keys materialized in site_config", f"{rows}")
        s, _ = put_setting(MT, "kds_age_critical_minutes", 12)
        ok(s == 200, "critical=12 saves against stored warn 10", f"s={s}")
        th = thresholds(KT)
        ok(th["warn_secs"] == 600 and th["late_secs"] == 720,
           "board follows: critical 12m -> 720s", f"{th}")
        s, _ = put_setting(MT, "kds_age_critical_minutes", 10)
        ok(s == 400, "critical=10 rejected (must exceed stored warn 10)", f"s={s}")
        s, _ = put_setting(MT, "kds_age_warn_minutes", 12)
        ok(s == 400, "warn=12 rejected (must stay under stored critical 12)", f"s={s}")

        print("== 2. ownership: seconds surface (POST /api/kds/settings) takes the pair back ==")
        s, b = api("POST", "/api/kds/settings", MT, {"warn_secs": 6, "late_secs": 120, "alert_lead_secs": 3})
        ok(s == 200 and b["thresholds"] == {"warn_secs": 6, "late_secs": 120, "alert_lead_secs": 3},
           "POST seconds thresholds still work", f"s={s} {b}")
        rows = sql("SELECT key FROM site_config WHERE key LIKE 'kds_age%'")
        ok(rows == [], "minute keys dropped after seconds write (one owner at a time)", f"{rows}")
        s, _ = put_setting(MT, "kds_age_warn_minutes", 14)
        ok(s == 200, "warn=14 saves again, re-paired against default critical 15", f"s={s}")
        th = thresholds(KT)
        ok(th["warn_secs"] == 840 and th["late_secs"] == 900 and th["alert_lead_secs"] == 3,
           "board follows re-saved minutes; alert_lead (not part of the pair) untouched", f"{th}")
        # Canonical end state for the decision sections: 8m / 15m / 240s lead.
        s, b = api("POST", "/api/kds/settings", MT, {"warn_secs": 480, "late_secs": 900, "alert_lead_secs": 240})
        ok(s == 200, "restore thresholds to 480/900/240 for decision checks", f"s={s}")
        th = thresholds(KT)
        ok(th == {"warn_secs": 480, "late_secs": 900, "alert_lead_secs": 240},
           "live thresholds are 480/900/240", f"{th}")

        print("== 3. treatment decision — real client kdsBand() at live thresholds ==")
        probes = [0, 239, 240, 479, 480, 899, 900, 3600]
        want = ["fresh", "fresh", "aging_soon", "aging_soon", "aging", "aging", "overdue", "overdue"]
        r = subprocess.run(["node", str(ROOT / "qa" / "harness39_kds.js"),
                            str(ROOT / "public" / "app.js"), json.dumps(th), json.dumps(probes)],
                           capture_output=True, text=True, timeout=30)
        got = json.loads(r.stdout) if r.returncode == 0 else []
        ok(r.returncode == 0 and got == want,
           "kdsBand boundaries: <240 fresh, 240-479 aging_soon, 480-899 aging, >=900 overdue",
           f"rc={r.returncode} got={got} err={r.stderr[:200]}")

        print("== 4. server decision on a real ticket (agingFor via /api/kds/alerts) ==")
        s, zones = api("GET", "/api/zones", ST)
        zlist = zones if isinstance(zones, list) else zones.get("zones", [])
        table_id = next(t["id"] for z in zlist for t in z["tables"] if not t.get("open_check_id"))
        s, menu = api("GET", "/api/menu", ST)
        cats = menu if isinstance(menu, list) else menu.get("categories", menu.get("menu", []))
        fries = next(i for c in cats for i in c.get("items", []) if i["name"] == "Bali Fries")
        s, chk = api("POST", "/api/checks", ST, {"table_id": table_id, "guest_count": 2})
        assert s == 201, (s, chk)
        s, sn = api("POST", f"/api/checks/{chk['id']}/send-now", ST,
                    {"items": [{"menu_item_id": fries["id"], "seat": 1, "qty": 1}]})
        ok(s == 201 and sn.get("sent") == 1 and len(sn.get("tickets", [])) == 1,
           "send-now fires one ticket", f"s={s} {sn}")
        tid = sn["tickets"][0]["id"]

        def alert_band(minutes_old):
            ts = (datetime.now(timezone.utc) - timedelta(minutes=minutes_old)).strftime("%Y-%m-%dT%H:%M:%SZ")
            sql("UPDATE kds_tickets SET created_at = ? WHERE id = ?", (ts, tid))
            s, b = api("GET", "/api/kds/alerts?station=expediter", KT)
            assert s == 200, (s, b)
            hit = [a for a in b.get("alerts", []) if a["ticket_id"] == tid]
            return hit[0]["band"] if hit else None

        ok(alert_band(16) == "overdue", "16m-old ticket -> overdue alert", "")
        ok(alert_band(10) == "aging", "10m-old ticket -> aging alert", "")
        ok(alert_band(5) == "aging_soon", "5m-old ticket -> aging_soon alert (lead window)", "")
        ok(alert_band(1) is None, "1m-old ticket -> fresh, absent from alerts", "")
    finally:
        stop(srv)

    print(f"\n{'ALL GREEN' if not fails else 'FAILURES'}: {checks - len(fails)}/{checks} checks passed")
    sys.exit(1 if fails else 0)

if __name__ == "__main__":
    main()
