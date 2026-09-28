#!/usr/bin/env python3
"""Copied-DB migration test for the P0 partial unique index
(idx_checks_one_open_per_table, commit 16dee84).

Builds a dirty 'old-schema' DB (index dropped, split_from dropped,
two genuine double-claimed open checks on one table, plus a split
child), then boots the CURRENT server against it and verifies:
  1. server boots clean (no crash on dirty data)
  2. earliest duplicate kept open, extras voided + audit-logged
  3. split children grandfathered via split_from
  4. the partial unique index exists afterwards
  5. a new double-open attempt is rejected at the DB level (P0 holds)
Own server on :4343. Never touches 4317/4320."""
import os, sqlite3, subprocess, signal, sys, time, urllib.request, urllib.error, json

PORT = 4343
DB = "/tmp/expoline-test34-migration.db"
BASE = f"http://localhost:{PORT}"
PASSES = 0
FAILS = []

def check(name, cond, extra=""):
    global PASSES
    if cond: PASSES += 1; print(f"  PASS {name}")
    else: FAILS.append(name); print(f"  FAIL {name} {extra}")

def api(method, path, token=None, body=None):
    h = {"Content-Type": "application/json"}
    if token: h["Authorization"] = "Bearer " + token
    req = urllib.request.Request(BASE + path, method=method,
        data=json.dumps(body).encode() if body is not None else None, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        try: return e.code, json.loads(e.read().decode())
        except Exception: return e.code, {}

SRV = os.path.expanduser("~/workspace/goals/expo-line-pos-beat-toast-spoton-pilot-at-bali-hai/build/expoline/server.js")

def boot(db):
    env = dict(os.environ, EXPOLINE_PORT=str(PORT), EXPOLINE_DB=db, NODE_ENV="test")
    p = subprocess.Popen(["node", SRV], env=env,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(60):
        try:
            with urllib.request.urlopen(BASE + "/api/health", timeout=2) as r:
                if r.status == 200: return p
        except Exception: time.sleep(0.5)
    return None

def stop(p):
    if p and p.poll() is None:
        p.send_signal(signal.SIGTERM); p.wait(timeout=10)

def dbsql(q, args=()):
    con = sqlite3.connect(DB)
    try:
        rows = con.execute(q, args).fetchall(); con.commit(); return rows
    finally: con.close()

def dbinsert(q, args=()):
    con = sqlite3.connect(DB)
    try:
        cur = con.execute(q, args); con.commit(); return cur.lastrowid
    finally: con.close()

# ---- phase 1: create a clean DB with the current server, then dirty it ----
if os.path.exists(DB): os.remove(DB)
p = boot(DB)
if not p: sys.exit("FATAL: server did not boot on clean DB")
stop(p)

# make it "old schema": drop the index and the split_from column
dbsql("DROP INDEX IF EXISTS idx_checks_one_open_per_table")
try:
    dbsql("ALTER TABLE checks DROP COLUMN split_from")
    dropped_col = True
except Exception as e:
    dropped_col = False
    print(f"  (note: DROP COLUMN unsupported: {e})")

# dirty data, inserted directly (bypassing app guards):
# - table 1: TWO genuine open staff-claimed checks (ids will be earliest/latest)
# - table 2: one open check + one open "split 2" child (pre-existing split)
S1 = dbsql("SELECT id FROM users WHERE pin='1111'")[0][0]
EARLY = dbinsert("""INSERT INTO checks (site_id, table_id, server_id, guest_count, status, opened_at)
         VALUES ('bali-hai', 1, ?, 2, 'open', '2026-09-28T10:00:00Z')""", (S1,))
LATE = dbinsert("""INSERT INTO checks (site_id, table_id, server_id, guest_count, status, opened_at)
         VALUES ('bali-hai', 1, ?, 2, 'open', '2026-09-28T10:05:00Z')""", (S1,))
PARENT = dbinsert("""INSERT INTO checks (site_id, table_id, server_id, guest_count, status, opened_at)
         VALUES ('bali-hai', 2, ?, 2, 'open', '2026-09-28T10:00:00Z')""", (S1,))
SPLIT = dbinsert("""INSERT INTO checks (site_id, table_id, server_id, tab_name, guest_count, status, opened_at)
         VALUES ('bali-hai', 2, ?, 'Table 2 split 2', 2, 'open', '2026-09-28T10:06:00Z')""", (S1,))

idx_before = dbsql("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_checks_one_open_per_table'")
print(f"setup: old-schema DB ready (index present before dirtying: {bool(idx_before)}, split_from dropped: {dropped_col})")
print(f"       early={EARLY} late={LATE} parent={PARENT} split={SPLIT}")

# ---- phase 2: boot the CURRENT server against the dirty old DB ----
p = boot(DB)
check("server boots on dirty old-schema DB", p is not None)
try:
    s, r = api("POST", "/api/auth/login", body={"pin": "2580"})
    MT = r["token"] if s == 200 else None
    check("login works after migration", s == 200, f"{s} {r}")

    st = dbsql("SELECT id, status FROM checks WHERE id IN (?,?,?,?) ORDER BY id", (EARLY, LATE, PARENT, SPLIT))
    st = {i: s for i, s in st}
    check("earliest duplicate kept open", st.get(EARLY) == "open", str(st))
    check("later duplicate voided by migration", st.get(LATE) == "void", str(st))
    check("split parent untouched (open)", st.get(PARENT) == "open", str(st))
    check("split child untouched (open, not voided as dupe)", st.get(SPLIT) == "open", str(st))

    cols = [c[1] for c in dbsql("PRAGMA table_info(checks)")]
    check("split_from column exists after migration", "split_from" in cols)
    sf = dbsql("SELECT split_from FROM checks WHERE id = ?", (SPLIT,))[0][0]
    check("split child grandfathered (split_from -> parent)", sf == PARENT, f"split_from={sf} parent={PARENT}")

    idx = dbsql("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_checks_one_open_per_table'")
    check("partial unique index created", len(idx) == 1, str(idx))
    check("index is partial on open non-split staff claims",
          bool(idx) and "WHERE" in idx[0][0] and "status = 'open'" in idx[0][0], str(idx[0][0]) if idx else "")

    audits = dbsql("SELECT COUNT(*) FROM approval_audit WHERE action='upgrade.duplicate_open_check_voided' AND check_id=?", (LATE,))[0][0]
    check("voided duplicate audit-logged", audits == 1, str(audits))

    # P0 still holds: direct double-open at the DB level must fail
    try:
        dbsql("""INSERT INTO checks (site_id, table_id, server_id, guest_count, status, opened_at)
                 VALUES ('bali-hai', 1, ?, 2, 'open', '2026-09-28T11:00:00Z')""", (S1,))
        check("DB rejects second open claim on table 1", False, "insert succeeded!")
    except sqlite3.IntegrityError:
        check("DB rejects second open claim on table 1", True)

    # app-level double-open also rejected
    s, zones = api("GET", "/api/zones", token=MT)
    s, r = api("POST", "/api/checks", token=MT, body={"table_id": 1, "guest_count": 2})
    check("API rejects open on occupied table", s in (400, 409), f"{s} {r}")

    # second boot: migration is idempotent
    stop(p); p = boot(DB)
    check("second boot clean (idempotent migration)", p is not None)
    st2 = {i: s for i, s in dbsql("SELECT id, status FROM checks WHERE id IN (?,?,?,?) ORDER BY id", (EARLY, LATE, PARENT, SPLIT))}
    check("second boot changes nothing", st2 == st, f"{st2} vs {st}")
finally:
    stop(p)

print(f"\nmigration test: {PASSES} passed, {len(FAILS)} failed")
sys.exit(1 if FAILS else 0)
