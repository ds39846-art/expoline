#!/usr/bin/env python3
"""Expoline KDS view guard — qa/test62_kds_guard.py.

WHY: renderKds opened with a pre-matrix hard block —
`if (state.user.role === 'server')` (commit 6b5cf7d9, 2026-09-26) —
refusing the whole kitchen display to every server regardless of the
permissions matrix. Since test56, KDS access is governed by the
kitchen_ops capability everywhere else: the nav renders the KDS link
on it, the online board (test61) gates on it, and the API enforces
it (kitchenPlus = requireCap('kitchen_ops'); test61 §C proved a
matrix grant flips a server's API access with the same token). The
view was the one surface still reading the raw role, so a manager
could grant kitchen_ops to a server — API opens, nav shows the KDS
link — and the view still bounced them. This rider swaps the role
test for the capability test the codebase already uses; nothing else
in the view changes, and the notAuthorized message is byte-identical.

Sections:
  A  client pins at HEAD: harness62 extracts the REAL entry-guard
     predicate + the REAL roleHasCap helpers from public/app.js and
     evaluates the truth table (server default blocks, granted
     server passes, kitchen/manager pass, stripped kitchen blocks,
     null blocks); source pins: old guard line gone, new guard is
     renderKds's first statement, nav + board + server gate all
     consult the same kitchen_ops capability.
  B  live at HEAD: login payloads carry the expected capabilities;
     GET /api/kds/tickets (kitchenPlus) agrees with the guard for
     every role; the extracted predicate is evaluated against the
     LIVE login payloads (server blocks pre-grant); a matrix grant
     flips the same server token's API access AND a fresh server
     login payload passes the guard — while the legacy role
     predicate evaluated on that same payload still blocks it;
     reset restores 403 and kitchen access is undisturbed.
  Z  control at 5f101fa: the old role guard is present and the
     capability guard absent; harness62 against the control client
     fails exactly the capability pins while the default-matrix
     equivalence fixtures hold; on the control SERVER the API grant
     flip already works (the API was never the laggard) yet the
     extracted control guard still blocks the live granted-server
     payload — the view was the only surface out of step.

Ports 4431 (HEAD) / 4432 (control worktree), scratch DBs in /tmp.
"""
import json, os, signal, subprocess, sys, time, urllib.request, urllib.error
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PORT, CPORT = 4431, 4432
BASE = f"http://127.0.0.1:{PORT}"
CBASE = f"http://127.0.0.1:{CPORT}"
DB = "/tmp/test62_kds_guard.db"
CDB = "/tmp/test62_kds_guard_ctrl.db"
WT = "/tmp/wt62_5f101fa"
BASE_COMMIT = "5f101fa"
CASES = "/tmp/test62_live_cases.json"
CCASES = "/tmp/test62_live_cases_ctrl.json"

OLD_GUARD = "if (state.user.role === 'server') { app.innerHTML = notAuthorized('The kitchen display is for kitchen and manager roles.'); return; }"
NEW_GUARD = "if (!roleHasCap(state.user, 'kitchen_ops')) { app.innerHTML = notAuthorized('The kitchen display is for kitchen and manager roles.'); return; }"

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
                         stdout=open(f"/tmp/test62_boot_{port}.log", "a"),
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

def login_full(pin, base=BASE):
    s, r = req("POST", "/api/auth/login", {"pin": pin}, base=base)
    assert s == 200, (s, r)
    return r["token"], r["user"]

def src_of(relpath, root=ROOT):
    return (Path(root) / relpath).read_text()

def harness(app_js, cases=None):
    cmd = ["node", str(ROOT / "qa" / "harness62_client.js"), str(app_js)]
    if cases:
        cmd.append(str(cases))
    h = subprocess.run(cmd, capture_output=True, text=True, cwd=ROOT)
    res = {}
    for line in h.stdout.splitlines():
        if line.startswith("@@RESULT@@"):
            res = json.loads(line[len("@@RESULT@@"):])
    return h.returncode, res

def write_cases(path, named_users):
    Path(path).write_text(json.dumps(
        [{"name": n, "user": u} for n, u in named_users]))

def main():
    for f in (DB, CDB):
        for suffix in ("", "-wal", "-shm"):
            try:
                os.unlink(f + suffix)
            except FileNotFoundError:
                pass
    subprocess.run(["git", "worktree", "remove", "--force", WT], cwd=ROOT,
                   capture_output=True)
    subprocess.run(["git", "worktree", "add", WT, BASE_COMMIT], cwd=ROOT,
                   check=True, capture_output=True)
    os.symlink(ROOT / "node_modules", Path(WT) / "node_modules")

    srv = boot(PORT, DB)
    ctrl = None
    try:
        print("== A. client pins at HEAD ==")
        rc, res = harness(ROOT / "public" / "app.js")
        ok("A harness62 exit 0", rc == 0, f"rc={rc}")
        fixture_keys = [k for k in res if not k.startswith("live_")]
        ok("A harness62 all fixture assertions true",
           len(fixture_keys) >= 11 and all(res[k] for k in fixture_keys),
           str({k: v for k, v in res.items() if not v}))
        appjs = src_of("public/app.js")
        ok("A old role guard line absent", OLD_GUARD not in appjs)
        ok("A new capability guard line present", NEW_GUARD in appjs)
        sig_at = appjs.index("async function renderKds(app) {")
        ok("A guard is renderKds's first statement",
           0 < appjs.index(NEW_GUARD) - sig_at < 100,
           str(appjs.index(NEW_GUARD) - sig_at))
        ok("A nav KDS link gated on the same capability",
           "if (roleHasCap(state.user, 'kitchen_ops')) links.push(['#/kds', 'KDS']);" in appjs)
        ok("A online board gated on the same capability",
           "const canOnline = roleHasCap(state.user, 'kitchen_ops');" in appjs)
        ok("A server gate is the same capability",
           "const kitchenPlus = () => requireCap('kitchen_ops')" in src_of("server.js"))

        print("== B. live at HEAD: payloads, API agreement, grant flip ==")
        stok, suser = login_full("1111")
        ktok, kuser = login_full("2222")
        mtok, muser = login_full("2580")
        ok("B server login caps are floor_ops + menu_86 (no kitchen_ops)",
           set(suser.get("capabilities") or []) == {"floor_ops", "menu_86"},
           str(suser.get("capabilities")))
        ok("B kitchen login caps include kitchen_ops",
           "kitchen_ops" in (kuser.get("capabilities") or []))
        ok("B manager login caps include kitchen_ops",
           "kitchen_ops" in (muser.get("capabilities") or []))
        s, _ = req("GET", "/api/kds/tickets")
        ok("B anon GET /api/kds/tickets 401", s == 401, str(s))
        s, _ = req("GET", "/api/kds/tickets", token=stok)
        ok("B server GET /api/kds/tickets 403 (API agrees with guard)", s == 403, str(s))
        s, _ = req("GET", "/api/kds/tickets", token=ktok)
        ok("B kitchen GET /api/kds/tickets 200", s == 200, str(s))
        s, _ = req("GET", "/api/kds/tickets", token=mtok)
        ok("B manager GET /api/kds/tickets 200", s == 200, str(s))
        write_cases(CASES, [("server_default", suser),
                            ("kitchen_default", kuser),
                            ("manager_default", muser)])
        _, lres = harness(ROOT / "public" / "app.js", CASES)
        ok("B live server payload: guard blocks",
           lres.get("live_server_default_guard_blocks") is True, str(lres))
        ok("B live kitchen payload: guard passes",
           lres.get("live_kitchen_default_guard_blocks") is False)
        ok("B live manager payload: guard passes",
           lres.get("live_manager_default_guard_blocks") is False)
        ok("B live server payload: legacy predicate also blocks (pre-grant agreement)",
           lres.get("live_server_default_legacy_blocks") is True)
        s, r = req("PUT", "/api/admin/permissions",
                   {"matrix": {"server": ["floor_ops", "menu_86", "kitchen_ops"]}}, token=mtok)
        ok("B grant kitchen_ops to server 200", s == 200, f"{s} {str(r)[:100]}")
        s, _ = req("GET", "/api/kds/tickets", token=stok)
        ok("B same server token flips to 200 on the KDS API", s == 200, str(s))
        _, guser = login_full("1111")
        ok("B fresh server login payload now carries kitchen_ops",
           "kitchen_ops" in (guser.get("capabilities") or []), str(guser.get("capabilities")))
        write_cases(CASES, [("server_granted", guser)])
        _, gres = harness(ROOT / "public" / "app.js", CASES)
        ok("B live granted-server payload: guard PASSES (the flip)",
           gres.get("live_server_granted_guard_blocks") is False, str(gres))
        ok("B live granted-server payload: legacy predicate still blocks it",
           gres.get("live_server_granted_legacy_blocks") is True)
        s, r = req("PUT", "/api/admin/permissions", {"reset": True}, token=mtok)
        ok("B matrix reset 200", s == 200, f"{s}")
        s, _ = req("GET", "/api/kds/tickets", token=stok)
        ok("B reset restores server 403", s == 403, str(s))
        s, _ = req("GET", "/api/kds/tickets", token=ktok)
        ok("B kitchen access undisturbed by grant/reset cycle", s == 200, str(s))

        print("== Z. control at 5f101fa: role guard, API fine, view blocks ==")
        ctrl = boot(CPORT, CDB, cwd=WT)
        capp = src_of("public/app.js", root=WT)
        ok("Z control app.js HAS the old role guard", OLD_GUARD in capp)
        ok("Z control app.js lacks the capability guard", NEW_GUARD not in capp)
        _, zres = harness(Path(WT) / "public" / "app.js")
        ok("Z control guard does not consult kitchen_ops",
           zres.get("guard_uses_kitchen_ops_capability") is False, str(zres))
        ok("Z control granted-server fixture still blocked",
           zres.get("server_granted_kitchen_ops_passes") is False)
        ok("Z control equivalence fixtures hold (server blocks, kitchen/manager pass)",
           zres.get("server_default_blocks") is True
           and zres.get("server_explicit_default_caps_blocks") is True
           and zres.get("kitchen_default_passes") is True
           and zres.get("manager_default_passes") is True)
        cstok, _ = login_full("1111", base=CBASE)
        cmtok, _ = login_full("2580", base=CBASE)
        s, _ = req("GET", "/api/kds/tickets", token=cstok, base=CBASE)
        ok("Z control server tickets 403 pre-grant", s == 403, str(s))
        s, r = req("PUT", "/api/admin/permissions",
                   {"matrix": {"server": ["floor_ops", "menu_86", "kitchen_ops"]}},
                   token=cmtok, base=CBASE)
        ok("Z control grant 200 (API already capability-based)", s == 200, f"{s}")
        s, _ = req("GET", "/api/kds/tickets", token=cstok, base=CBASE)
        ok("Z control API flips to 200 on grant", s == 200, str(s))
        _, cguser = login_full("1111", base=CBASE)
        write_cases(CCASES, [("server_granted", cguser)])
        _, czres = harness(Path(WT) / "public" / "app.js", CCASES)
        ok("Z control guard STILL blocks the live granted-server payload",
           czres.get("live_server_granted_guard_blocks") is True, str(czres))

    finally:
        stop(srv)
        stop(ctrl)
        subprocess.run(["git", "worktree", "remove", "--force", WT], cwd=ROOT,
                       capture_output=True)
        try:
            os.unlink(Path(WT) / "node_modules")
        except Exception:
            pass

    print(f"\ntest62_kds_guard: {passed} passed, {failed} failed")
    if failures:
        print("FAILED:", failures)
    sys.exit(1 if failed else 0)

if __name__ == "__main__":
    main()
