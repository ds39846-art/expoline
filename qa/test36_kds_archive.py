#!/usr/bin/env python3
"""test36_kds_archive.py — KDS fulfilled-ticket archival/retention.

Boots the real server against a scratch DB, plants tickets via SQL,
reboots (the boot pass must archive), and verifies:
  (i)   fulfilled tickets older than the 30-day retention window land
        in kds_tickets_archive with every column intact;
  (ii)  recent fulfilled and old UNfulfilled tickets stay in kds_tickets;
  (iii) a second boot pass moves 0 (idempotent), and the seeded demo
        tickets (fulfilled "yesterday") are never touched;
  (iv)  a 12,000-row backlog of old fulfilled tickets (>1 batch of
        5,000) drains in ONE pass — the multi-batch loop — leaving
        only non-qualifying rows live, with the pass total logged;
  (v)   LEGACY SHAPE: an archive table created by the pre-fix build
        (id as PRIMARY KEY) is rebuilt once by the reconcile, rows
        preserved, and archiving proceeds normally afterwards;
  (vi)  ID RECYCLING: kds_tickets ids are plain rowids, so a new
        ticket can reuse an archived ticket's id; when it ages out
        fulfilled it must archive as a SECOND row carrying that id
        (the archive must not treat id as unique — a PK there wedges
        every pass on the same rolled-back batch);
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

    # --- Backlog case: >1 batch of old fulfilled tickets must drain in
    # ONE pass (regression for the 5,000-per-pass trickle: the soak's
    # 504,836-row backlog would otherwise take ~25 days at 4 passes/day).
    # Explicit ids above BOTH tables' maxima simulate a real legacy
    # backlog, whose ids all predate the archive table entirely.
    BACKLOG_N = 12000
    id_base = max(sql("SELECT COALESCE(MAX(id),0) AS m FROM kds_tickets")[0]["m"],
                  sql("SELECT COALESCE(MAX(id),0) AS m FROM kds_tickets_archive")[0]["m"])
    con = sqlite3.connect(DB)
    try:
        con.executemany(
            "INSERT INTO kds_tickets (id, check_id, site_id, station, table_label, server_name,"
            " items_json, status, created_at, bumped_at, bumped_by) VALUES (?,NULL,'bali-hai',"
            " 'expediter','T36','Test Server','[]','fulfilled',?,?,?)",
            [(id_base + 1 + i, iso(40), iso(39), "Expo Kitchen") for i in range(BACKLOG_N)])
        con.commit()
    finally: con.close()
    bulk_ids = {r["id"] for r in sql("SELECT id FROM kds_tickets WHERE id > ?", (id_base,))}
    ok(len(bulk_ids) == BACKLOG_N, "backlog planted (12,000 old fulfilled)", f"planted={len(bulk_ids)}")
    KEEP_RECENT = plant("fulfilled", iso(3), iso(2))   # recent fulfilled -> stays
    KEEP_OPEN = plant("new", iso(40), None)            # old unfulfilled -> stays

    srv = boot(LOG); stop(srv)  # ONE pass must drain the whole backlog
    log3 = Path(LOG).read_text()
    arch3_ids = {r["id"] for r in sql("SELECT id FROM kds_tickets_archive")}
    live3_ids = {r["id"] for r in sql("SELECT id FROM kds_tickets")}
    ok(len(arch3_ids) == n_arch + BACKLOG_N and bulk_ids <= arch3_ids,
       "backlog: all 12,000 archived in a single pass",
       f"arch {n_arch}->{len(arch3_ids)}")
    ok(not (bulk_ids & live3_ids), "backlog: no planted fulfilled ticket left live")
    ok(len(live3_ids) == n_live + 2 and KEEP_RECENT in live3_ids and KEEP_OPEN in live3_ids,
       "backlog: kds_tickets retains only the non-qualifying rows",
       f"live {n_live}->{len(live3_ids)}")
    ok(f"kds-archive: moved {BACKLOG_N}" in log3, "backlog: boot log reports the pass total",
       "log tail: " + "".join(log3.splitlines(keepends=True)[-4:]))

    # --- Legacy-shape rebuild: reshape the archive into the PRE-FIX
    # schema (id PRIMARY KEY), rows and all, then boot. The reconcile
    # must rebuild it once without the PK — rows preserved — and a
    # planted old fulfilled ticket must archive normally afterwards.
    con = sqlite3.connect(DB)
    try:
        info = con.execute("PRAGMA table_info(kds_tickets_archive)").fetchall()
        defs = ", ".join(f"{r[1]} {r[2] or 'TEXT'}" + (" PRIMARY KEY" if r[1] == "id" else "") for r in info)
        names = ", ".join(r[1] for r in info)
        con.execute(f"CREATE TABLE kds_tickets_archive_oldshape ({defs})")
        con.execute(f"INSERT INTO kds_tickets_archive_oldshape ({names}) SELECT {names} FROM kds_tickets_archive")
        con.execute("DROP TABLE kds_tickets_archive")
        con.execute("ALTER TABLE kds_tickets_archive_oldshape RENAME TO kds_tickets_archive")
        con.commit()
    finally: con.close()
    pk_before = [r["pk"] for r in sql("PRAGMA table_info(kds_tickets_archive)") if r["name"] == "id"]
    ok(pk_before == [1], "legacy setup: archive id reshaped to PRIMARY KEY", f"pk={pk_before}")
    n_arch_before_rebuild = sql("SELECT COUNT(*) AS n FROM kds_tickets_archive")[0]["n"]
    T7 = plant("fulfilled", iso(41), iso(40))       # old fulfilled -> must archive post-rebuild

    srv = boot(LOG); stop(srv)  # reconcile (rebuild) + pass run here
    log6 = Path(LOG).read_text()
    pk_after = [r["pk"] for r in sql("PRAGMA table_info(kds_tickets_archive)") if r["name"] == "id"]
    ok(pk_after == [0], "reconcile rebuilt the archive without PRIMARY KEY on id", f"pk={pk_after}")
    ok("rebuilt kds_tickets_archive without PRIMARY KEY" in log6, "rebuild is logged at boot",
       "log tail: " + "".join(log6.splitlines(keepends=True)[-4:]))
    ok("kds-archive: moved 1" in log6, "post-rebuild pass archives the planted ticket",
       "log tail: " + "".join(log6.splitlines(keepends=True)[-4:]))
    n_arch_after_rebuild = sql("SELECT COUNT(*) AS n FROM kds_tickets_archive")[0]["n"]
    ok(n_arch_after_rebuild == n_arch_before_rebuild + 1,
       "rebuild preserved every archive row (count only grew by the new ticket)",
       f"{n_arch_before_rebuild}->{n_arch_after_rebuild}")
    ok(len(sql("SELECT * FROM kds_tickets_archive WHERE id = ?", (T1,))) == 1,
       "the original id-T1 archive row survived the rebuild")
    ok(sql("SELECT id FROM kds_tickets_archive WHERE id = ?", (T7,)),
       "planted ticket is in the archive after the rebuild pass")
    idx = {r["name"] for r in sql("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='kds_tickets_archive'")}
    ok("idx_kds_tickets_archive_id" in idx and "idx_kds_tickets_archive_created" in idx,
       "non-unique id + created_at indexes exist on the archive", f"idx={sorted(idx)}")

    # --- Recycling case: T1's id was freed when T1 was archived above.
    # Plant a NEW fulfilled ticket reusing id T1 explicitly, aged past
    # retention. The next pass must archive it as a SECOND archive row
    # carrying original id T1. (Pre-fix, the archive's PRIMARY KEY on
    # id made this INSERT fail; the batch rolled back and every later
    # pass wedged on the same first batch.)
    con = sqlite3.connect(DB)
    try:
        con.execute("INSERT INTO kds_tickets (id, check_id, site_id, station, table_label, server_name,"
                    " items_json, status, created_at, bumped_at, bumped_by) VALUES (?,NULL,'bali-hai',"
                    " 'expediter','T36-RECYCLED','Test Server','[]','fulfilled',?,?,?)",
                    (T1, iso(45), iso(44), "Expo Kitchen"))
        con.commit()
    finally: con.close()
    n_t1_before = sql("SELECT COUNT(*) AS n FROM kds_tickets_archive WHERE id = ?", (T1,))[0]["n"]
    ok(n_t1_before == 1, "recycle setup: archive holds original id T1 exactly once so far",
       f"n={n_t1_before}")
    n_arch_before_recycle = sql("SELECT COUNT(*) AS n FROM kds_tickets_archive")[0]["n"]

    srv = boot(LOG); stop(srv)  # pass over the recycled id
    log4 = Path(LOG).read_text()
    rows_t1 = sql("SELECT * FROM kds_tickets_archive WHERE id = ?", (T1,))
    ok(len(rows_t1) == 2, "recycled id archived a second time (two archive rows share the original id)",
       f"rows={len(rows_t1)}")
    ok(any(r["table_label"] == "T36-RECYCLED" for r in rows_t1),
       "the second id-T1 archive row is the recycled ticket")
    ok(not sql("SELECT id FROM kds_tickets WHERE id = ?", (T1,)),
       "recycled ticket removed from kds_tickets")
    ok("kds-archive: moved 1" in log4, "recycle pass logs moved 1",
       "log tail: " + "".join(log4.splitlines(keepends=True)[-4:]))
    ok("kds-archive boot pass failed" not in log4 and "UNIQUE constraint" not in log4,
       "recycle pass logs no archive failure")
    n_arch_after_recycle = sql("SELECT COUNT(*) AS n FROM kds_tickets_archive")[0]["n"]
    ok(n_arch_after_recycle == n_arch_before_recycle + 1, "archive grew by exactly the recycled row",
       f"{n_arch_before_recycle}->{n_arch_after_recycle}")

    srv = boot(LOG); stop(srv)  # third pass: nothing left, nothing wedged
    log5 = Path(LOG).read_text()
    ok("kds-archive: moved 0" in log5, "pass after recycling moves 0 (not wedged)",
       "log tail: " + "".join(log5.splitlines(keepends=True)[-4:]))
    ok(len(sql("SELECT * FROM kds_tickets_archive WHERE id = ?", (T1,))) == 2,
       "archive still holds both id-T1 rows after the quiet pass")

    print(f"\n{'ALL GREEN' if not fails else 'FAILURES'}: {checks - len(fails)}/{checks} checks passed")
    sys.exit(1 if fails else 0)

if __name__ == "__main__":
    main()
