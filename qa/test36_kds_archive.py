#!/usr/bin/env python3
"""test36_kds_archive.py — KDS fulfilled-ticket archival/retention.

Boots the real server against a scratch DB, plants tickets via SQL,
reboots (the boot pass must archive), and verifies:
  (i)   fulfilled tickets older than the 30-day retention window land
        in kds_tickets_archive with every column intact;
  (ii)  recent fulfilled and old UNfulfilled tickets stay in kds_tickets;
  (iii) a second boot pass moves 0 (idempotent), and the seeded demo
        tickets (fulfilled "yesterday") are never touched.
Own server on :4346. Never touches 4317/4320.
"""
import os, signal, sqlite3, subprocess, sys, time
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PORT = 4346
DB = "/tmp/expoline-test36.db"
BASE = f"http://localhost:{PORT}"
LOG = "/tmp/expoline-test36-boot.log"

checks, fails = 0, []
def ok(cond, name, detail=""):
    global checks
    checks += 1
    if not cond:
        fails.append(name)
        print(f"  x {name} {detail}")
    else:
        print(f"  + {name}")

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

def iso(days_ago, hours=0):
    t = datetime.now(timezone.utc) - timedelta(days=days_ago, hours=hours)
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")

def main():
    for suf in ("", "-wal", "-shm"):
        try: os.remove(DB + suf)
        except FileNotFoundError: pass

    srv = boot(); stop(srv)  # first boot: schema + seed

    # Plant tickets: T1..T6
    def plant(status, created, bumped):
        con = sqlite3.connect(DB)
        try:
            cur = con.execute("INSERT INTO kds_tickets (check_id, site_id, station, table_label, server_name,"
                              " items_json, status, created_at, bumped_at, bumped_by) VALUES (NULL,'bali-hai',"
                              " 'expediter','T36','Test Server','[]',?,?,?,?)",
                              (status, created, bumped, "Expo Kitchen" if bumped else None))
            con.commit(); return cur.lastrowid
        finally: con.close()
    T1 = plant("fulfilled", iso(41), iso(40))       # old fulfilled -> archive
    T2 = plant("fulfilled", iso(3), iso(2))         # recent fulfilled -> stays
    T3 = plant("fulfilled", iso(40), None)          # old, no bump stamp -> archive (created_at fallback)
    T4 = plant("new", iso(40), None)                # old but unfulfilled -> stays
    T5 = plant("in_progress", iso(40), None)        # old but unfulfilled -> stays
    T6 = plant("fulfilled", iso(32), iso(31))       # just past 30d -> archive
    before = {r["id"]: dict(r) for r in sql("SELECT * FROM kds_tickets WHERE id IN (?,?,?,?,?,?)",
                                            (T1, T2, T3, T4, T5, T6))}
    seeded_ids = [r["id"] for r in sql("SELECT id FROM kds_tickets WHERE id NOT IN (?,?,?,?,?,?)",
                                       (T1, T2, T3, T4, T5, T6))]

    srv = boot(LOG); stop(srv)  # boot pass runs here
    log = Path(LOG).read_text()

    arch = {r["id"]: dict(r) for r in sql("SELECT * FROM kds_tickets_archive")}
    live = {r["id"] for r in sql("SELECT id FROM kds_tickets")}

    ok(set(arch) == {T1, T3, T6}, "archive holds exactly the old fulfilled tickets",
       f"arch={sorted(arch)} want={[T1, T3, T6]}")
    for tid in (T1, T3, T6):
        # uuid is excluded from equality: a boot migration legitimately
        # backfills missing uuids before the archive pass moves the row.
        a, b = dict(arch.get(tid) or {}), dict(before[tid])
        a.pop("uuid", None); b.pop("uuid", None)
        ok(a == b and (arch.get(tid) or {}).get("uuid"),
           f"archived row {tid} intact (all columns, uuid backfilled)",
           f"got {arch.get(tid)} want {before[tid]}")
    ok(T2 in live and T4 in live and T5 in live, "recent fulfilled + old unfulfilled stay live",
       f"live={sorted(live)}")
    ok(not ({T1, T3, T6} & live), "archived tickets removed from kds_tickets")
    ok(all(i in live for i in seeded_ids), "seeded demo tickets untouched (fulfilled yesterday < 30d)")
    ok("kds-archive: moved 3" in log, "boot log reports the pass count", 
       "log tail: " + "".join(log.splitlines(keepends=True)[-4:]))

    n_arch, n_live = len(arch), len(live)
    srv = boot(LOG); stop(srv)  # second pass
    log2 = Path(LOG).read_text()
    arch2 = sql("SELECT COUNT(*) AS n FROM kds_tickets_archive")[0]["n"]
    live2 = sql("SELECT COUNT(*) AS n FROM kds_tickets")[0]["n"]
    ok(arch2 == n_arch and live2 == n_live, "second boot pass moves 0 (idempotent)",
       f"arch {n_arch}->{arch2} live {n_live}->{live2}")
    ok("kds-archive: moved 0" in log2, "second boot pass logs moved 0")

    print(f"\n{'ALL GREEN' if not fails else 'FAILURES'}: {checks - len(fails)}/{checks} checks passed")
    sys.exit(1 if fails else 0)

if __name__ == "__main__":
    main()
