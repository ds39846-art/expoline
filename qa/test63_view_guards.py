#!/usr/bin/env python3
"""Expoline view guards — qa/test63_view_guards.py.

WHY: test56 made the capability matrix govern the API and the nav,
and the test62 rider converted the KDS view's entry guard. Five
view-entry guards in public/app.js still read the raw role, so the
view layer disagreed with the API in both directions:

  - renderFloor / renderReservations / renderOrder / renderPay
    hard-blocked `role !== 'server' && role !== 'manager'`: a
    kitchen user granted floor_ops passed every floor API
    (serverPlus = requireCap('floor_ops')) yet the views bounced
    them; a server stripped of floor_ops kept the views while the
    APIs 403'd.
  - mgrGuard (`!state.user || role !== 'manager'`) walled all 8
    manager subviews: the router guard was already hybrid
    (role OR any MANAGER_AREA_CAP), so a non-manager granted e.g.
    admin_discounts entered #/manager, hit Not authorized on every
    subview, while GET /api/admin/discounts answered 200.
  - the router's #/manager guard OR'd the manager role in beside
    hasAnyCap(MANAGER_AREA_CAPS): a manager stripped of every
    manager-area capability kept the area while all its APIs 403'd.

This batch converts the three, per-domain, under the hard rule that
the DEFAULT matrix yields byte-identical outcomes everywhere:

  - floor family  -> !roleHasCap(user, 'floor_ops')
  - router        -> !hasAnyCap(user, MANAGER_AREA_CAPS)   (pure)
  - mgrGuard(app, cap) per subview, cap = the capability whose
    requireCap factory gates that subview's APIs server-side:
      Overview (renderManager)      finance_reports  (its data API,
                                        GET /api/manager/overview,
                                        is gateFinanceReports)
      Settings (renderSvcCharge..)  [site_admin, admin_discounts]
                                        (service-charge + drawer
                                        config are gateSiteAdmin; the
                                        Discount library section is
                                        gateAdminDiscounts — the one
                                        two-domain view, ANY-of)
      Employees                     clock_admin  (gateClockAdmin)
      Floor plan                    site_admin   (zones/tables)
      Finance                       finance_reports
      Shift                         finance_reports  (/api/finance/
                                        shift + tipout report; the
                                        tipout RULES editor inside is
                                        gateSiteAdmin + tolerant)
      Menu                          admin_menu
      Time clock                    clock_admin
    renderPermissions was already capability-based — untouched.
    MANAGER_AREA_CAPS ∩ kitchen defaults = ∅ and ∩ server defaults
    = ∅ (neither kitchen_ops/menu_86 nor floor_ops is in the list),
    so the pure router guard provably preserves defaults.

Sections:
  A  client pins at HEAD: harness63 extracts the REAL guard
     predicates + the REAL mgrGuard from public/app.js and runs
     the fixture truth table (defaults for all 3 roles, explicit-cap
     variants, and every flip); source pins: old guard lines gone,
     exactly 4 floor_ops guards, per-subview call args, messages
     byte-identical, KDS + Permissions guards untouched, server
     factories gate the same capabilities; census: every remaining
     role comparison in app.js is on the documented non-guard list
     (landing redirects, nav hybrid, in-flow checks, data fields).
  B  live at HEAD: login payloads carry the default capabilities;
     the APIs agree with the view guards for every role; the
     extracted predicates evaluated against the LIVE payloads equal
     the fixture verdicts; matrix flips (kitchen +floor_ops,
     server −floor_ops, server +admin_discounts, manager
     −finance_reports) move the same token's API access AND a fresh
     login payload's view verdicts together; reset restores.
  Z  control at d37fa82: old guards present, capability pins fail,
     default fixtures + LIVE default verdicts identical to HEAD
     (the equivalence), the API grant flip already works, yet the
     control view predicates still block the granted payload —
     the view was the only surface out of step.

Ports 4433 (HEAD) / 4434 (control worktree), scratch DBs in /tmp.
"""
import json, os, re, signal, subprocess, sys, time, urllib.request, urllib.error
from pathlib import Path
from zoneinfo import ZoneInfo
from datetime import datetime

ROOT = Path(__file__).resolve().parent.parent
PORT, CPORT = 4433, 4434
BASE = f"http://127.0.0.1:{PORT}"
CBASE = f"http://127.0.0.1:{CPORT}"
DB = "/tmp/test63_view_guards.db"
CDB = "/tmp/test63_view_guards_ctrl.db"
WT = "/tmp/wt63_d37fa82"
BASE_COMMIT = "d37fa82"
CASES = "/tmp/test63_live_cases.json"
CCASES = "/tmp/test63_live_cases_ctrl.json"
TODAY = datetime.now(ZoneInfo("America/Los_Angeles")).strftime("%Y-%m-%d")

OLD_FLOOR_LOCAL = "if (role !== 'server' && role !== 'manager') { app.innerHTML = notAuthorized(); return; }"
OLD_FLOOR_STATE = "if (state.user.role !== 'server' && state.user.role !== 'manager') { app.innerHTML = notAuthorized(); return; }"
OLD_MGRGUARD = "if (!state.user || state.user.role !== 'manager') { app.innerHTML = notAuthorized('Manager area — please log in as a manager.'); return false; }"
OLD_ROUTER = "if (state.user.role !== 'manager' && !hasAnyCap(state.user, MANAGER_AREA_CAPS)) { app.innerHTML = notAuthorized('Manager area — please log in as a manager.'); return; }"
NEW_FLOOR = "if (!roleHasCap(state.user, 'floor_ops')) { app.innerHTML = notAuthorized(); return; }"
NEW_ROUTER = "if (!hasAnyCap(state.user, MANAGER_AREA_CAPS)) { app.innerHTML = notAuthorized('Manager area — please log in as a manager.'); return; }"
KDS_GUARD = "if (!roleHasCap(state.user, 'kitchen_ops')) { app.innerHTML = notAuthorized('The kitchen display is for kitchen and manager roles.'); return; }"
PERM_GUARD = "if (!roleHasCap(state.user, 'permissions_admin')) { app.innerHTML = notAuthorized('Permissions are edited by a manager (Permissions capability required).'); return; }"

ALL_VIEWS = ['floor', 'reservations', 'order', 'pay', 'kds', 'router',
             'mgr_overview', 'mgr_settings', 'mgr_employees', 'mgr_floorplan',
             'mgr_finance', 'mgr_shift', 'mgr_menu', 'mgr_timeclock']
FLOOR4 = ['floor', 'reservations', 'order', 'pay']
# Every remaining role comparison in app.js must be one of these
# documented NON-guard lines (landing redirects, the nav hybrid,
# in-flow checks, data/display) — a new role-guarded view fails here.
ROLE_LINE_ALLOWLIST = [
    "role === 'manager' || hasAnyCap(state.user, MANAGER_AREA_CAPS)",    # nav Manager link (hybrid, presentation)
    "user.role === 'kitchen' ? '#/kds'",                                  # post-login + boot landing redirects
    "const isMgr = role === 'manager'",                                   # reservations in-flow flag
    "const needPin = state.user.role !== 'manager'",                      # PIN axis (in-flow)
    "state.user.role === 'manager' && (check.payments || []).length",     # pay reopen affordance (in-flow)
    "const locked = role === 'manager' && c.key === 'permissions_admin'", # permissions editor lock cell
    "cfg.drawer_close_role === 'server'",                                 # drawer config value (data)
    "emp && emp.role === r",                                              # employee form option (data)
    "isManager: me.role === 'manager'",                                   # shift view in-flow data flag
]
ALL12 = ['floor_ops', 'kitchen_ops', 'menu_86', 'admin_menu', 'admin_discounts',
         'admin_inventory', 'finance_reports', 'finance_closeout', 'refunds',
         'clock_admin', 'site_admin', 'permissions_admin']

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
                         stdout=open(f"/tmp/test63_boot_{port}.log", "a"),
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
    cmd = ["node", str(ROOT / "qa" / "harness63_client.js"), str(app_js)]
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

def verdicts_equal(res, prefix_a, prefix_b, views=ALL_VIEWS):
    return all(res.get(f"{prefix_a}{v}") == res.get(f"{prefix_b}{v}") for v in views)

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
        ok("A harness63 exit 0", rc == 0, f"rc={rc}")
        fix_keys = [k for k in res if k.startswith("fix_")]
        ok("A harness63 all 13 fixtures as expected",
           len(fix_keys) == 13 and all(res[k] for k in fix_keys),
           str([k for k in fix_keys if not res[k]]))
        pin_keys = [k for k in res if k.startswith("pin_")]
        ok("A harness63 all capability pins true",
           len(pin_keys) >= 15 and all(res[k] for k in pin_keys),
           str([k for k in pin_keys if not res[k]]))
        appjs = src_of("public/app.js")
        ok("A old floor guard (local role) absent", OLD_FLOOR_LOCAL not in appjs)
        ok("A old floor guard (state role) absent", OLD_FLOOR_STATE not in appjs)
        ok("A old mgrGuard role line absent", OLD_MGRGUARD not in appjs)
        ok("A old hybrid router guard absent", OLD_ROUTER not in appjs)
        ok("A exactly 4 floor_ops view guards", appjs.count(NEW_FLOOR) == 4,
           str(appjs.count(NEW_FLOOR)))
        ok("A pure-capability router guard present", NEW_ROUTER in appjs)
        ok("A mgrGuard takes a capability argument",
           "function mgrGuard(app, cap) {" in appjs)
        ok("A KDS capability guard untouched (test62)", KDS_GUARD in appjs)
        ok("A Permissions capability guard untouched", PERM_GUARD in appjs)
        srvjs = src_of("server.js")
        ok("A server floor gate is floor_ops",
           "const serverPlus = () => requireCap('floor_ops')" in srvjs)
        ok("A server overview/finance gate is finance_reports",
           "const gateFinanceReports = () => requireCap('finance_reports')" in srvjs
           and "app.get('/api/manager/overview', gateFinanceReports()" in srvjs)
        ok("A server discounts gate is admin_discounts",
           "const gateAdminDiscounts = () => requireCap('admin_discounts')" in srvjs)
        role_lines = [ln.strip() for ln in appjs.splitlines()
                      if re.search(r"role\s*!==|role\s*===|\.role\s*!==|\.role\s*===", ln)]
        ok("A census: exactly the 10 documented non-guard role lines remain",
           len(role_lines) == 10
           and all(any(m in ln for m in ROLE_LINE_ALLOWLIST) for ln in role_lines),
           str(role_lines))

        print("== B. live at HEAD: payloads, API agreement, flips ==")
        stok, suser = login_full("1111")
        ktok, kuser = login_full("2222")
        mtok, muser = login_full("2580")
        ok("B server login caps are the defaults",
           set(suser.get("capabilities") or []) == {"floor_ops", "menu_86"},
           str(suser.get("capabilities")))
        ok("B kitchen login caps are the defaults",
           set(kuser.get("capabilities") or []) == {"kitchen_ops", "menu_86"},
           str(kuser.get("capabilities")))
        ok("B manager login caps are all 12",
           set(muser.get("capabilities") or []) == set(ALL12),
           str(muser.get("capabilities")))
        s, _ = req("GET", "/api/checks/open")
        ok("B anon GET /api/checks/open 401", s == 401, str(s))
        for name, tok, path, want in [
            ("server checks/open 200", stok, "/api/checks/open", 200),
            ("server reservations 200", stok, "/api/reservations", 200),
            ("server discounts API 403", stok, "/api/admin/discounts", 403),
            ("server overview API 403", stok, "/api/manager/overview", 403),
            ("server employees API 403", stok, "/api/admin/employees", 403),
            ("kitchen checks/open 403", ktok, "/api/checks/open", 403),
            ("kitchen reservations 403", ktok, "/api/reservations", 403),
            ("kitchen kds tickets 200", ktok, "/api/kds/tickets", 200),
            ("kitchen discounts API 403", ktok, "/api/admin/discounts", 403),
            ("kitchen overview API 403", ktok, "/api/manager/overview", 403),
            ("manager checks/open 200", mtok, "/api/checks/open", 200),
            ("manager discounts API 200", mtok, "/api/admin/discounts", 200),
            ("manager overview API 200", mtok, "/api/manager/overview", 200),
            ("manager employees API 200", mtok, "/api/admin/employees", 200),
            ("manager menu API 200", mtok, "/api/admin/menu", 200),
            ("manager zones API 200", mtok, "/api/admin/zones", 200),
            ("manager payouts API 200", mtok, f"/api/finance/payouts?date={TODAY}", 200),
        ]:
            s, _ = req("GET", path, token=tok)
            ok(f"B {name}", s == want, str(s))
        write_cases(CASES, [("server_default", suser),
                            ("kitchen_default", kuser),
                            ("manager_default", muser)])
        _, lres = harness(ROOT / "public" / "app.js", CASES)
        ok("B live server payload verdicts == fixture defaults",
           verdicts_equal(lres, "case_live_server_default_", "case_server_caps_"))
        ok("B live kitchen payload verdicts == fixture defaults",
           verdicts_equal(lres, "case_live_kitchen_default_", "case_kitchen_caps_"))
        ok("B live manager payload verdicts == fixture defaults",
           verdicts_equal(lres, "case_live_manager_default_", "case_mgr_caps_"))

        # Flip 1: kitchen + floor_ops — API and view open together.
        s, r = req("PUT", "/api/admin/permissions",
                   {"matrix": {"kitchen": ["kitchen_ops", "menu_86", "floor_ops"]}}, token=mtok)
        ok("B grant floor_ops to kitchen 200", s == 200, f"{s} {str(r)[:80]}")
        s, _ = req("GET", "/api/checks/open", token=ktok)
        ok("B same kitchen token flips to 200 on floor API", s == 200, str(s))
        _, kguser = login_full("2222")
        write_cases(CASES, [("kitchen_floor", kguser)])
        _, kres = harness(ROOT / "public" / "app.js", CASES)
        ok("B granted-kitchen payload: floor family opens",
           all(kres.get(f"case_live_kitchen_floor_{v}") is False for v in FLOOR4), str(kres.get("case_live_kitchen_floor_floor")))
        ok("B granted-kitchen payload: manager area still closed",
           kres.get("case_live_kitchen_floor_router") is True
           and kres.get("case_live_kitchen_floor_mgr_finance") is True)
        ok("B granted-kitchen payload: KDS still open",
           kres.get("case_live_kitchen_floor_kds") is False)

        # Flip 2: server − floor_ops — API and view close together.
        s, r = req("PUT", "/api/admin/permissions",
                   {"matrix": {"server": ["menu_86"]}}, token=mtok)
        ok("B strip floor_ops from server 200", s == 200, f"{s}")
        s, _ = req("GET", "/api/checks/open", token=stok)
        ok("B same server token flips to 403 on floor API", s == 403, str(s))
        _, ssuser = login_full("1111")
        write_cases(CASES, [("server_stripped", ssuser)])
        _, sres = harness(ROOT / "public" / "app.js", CASES)
        ok("B stripped-server payload: floor family closes",
           all(sres.get(f"case_live_server_stripped_{v}") is True for v in FLOOR4))

        # Flip 3: server + admin_discounts — Settings opens, Finance stays shut.
        s, r = req("PUT", "/api/admin/permissions",
                   {"matrix": {"server": ["floor_ops", "menu_86", "admin_discounts"]}}, token=mtok)
        ok("B grant admin_discounts to server 200", s == 200, f"{s}")
        s, _ = req("GET", "/api/admin/discounts", token=stok)
        ok("B same server token flips to 200 on discounts API", s == 200, str(s))
        s, _ = req("GET", "/api/manager/overview", token=stok)
        ok("B server overview API still 403 (no finance_reports)", s == 403, str(s))
        _, sduser = login_full("1111")
        write_cases(CASES, [("server_discounts", sduser)])
        _, dres = harness(ROOT / "public" / "app.js", CASES)
        ok("B discounted-server payload: router + Settings open",
           dres.get("case_live_server_discounts_router") is False
           and dres.get("case_live_server_discounts_mgr_settings") is False)
        ok("B discounted-server payload: Finance + Overview stay shut",
           dres.get("case_live_server_discounts_mgr_finance") is True
           and dres.get("case_live_server_discounts_mgr_overview") is True)

        # Flip 4: manager − finance_reports — Finance/Overview/Shift close, rest stays.
        s, r = req("PUT", "/api/admin/permissions",
                   {"matrix": {"manager": [c for c in ALL12 if c != "finance_reports"]}}, token=mtok)
        ok("B strip finance_reports from manager 200", s == 200, f"{s}")
        s, _ = req("GET", "/api/manager/overview", token=mtok)
        ok("B same manager token flips to 403 on overview API", s == 403, str(s))
        s, _ = req("GET", "/api/admin/discounts", token=mtok)
        ok("B manager discounts API still 200", s == 200, str(s))
        _, mfuser = login_full("2580")
        write_cases(CASES, [("manager_nofin", mfuser)])
        _, fres = harness(ROOT / "public" / "app.js", CASES)
        ok("B no-finance manager payload: Finance/Overview/Shift close",
           all(fres.get(f"case_live_manager_nofin_{v}") is True
               for v in ("mgr_finance", "mgr_overview", "mgr_shift")))
        ok("B no-finance manager payload: Settings/Menu/Employees stay open",
           all(fres.get(f"case_live_manager_nofin_{v}") is False
               for v in ("mgr_settings", "mgr_menu", "mgr_employees")))

        s, r = req("PUT", "/api/admin/permissions", {"reset": True}, token=mtok)
        ok("B matrix reset 200", s == 200, f"{s}")
        s, _ = req("GET", "/api/checks/open", token=stok)
        ok("B reset restores server floor API 200", s == 200, str(s))
        s, _ = req("GET", "/api/checks/open", token=ktok)
        ok("B reset restores kitchen floor API 403", s == 403, str(s))
        s, _ = req("GET", "/api/manager/overview", token=mtok)
        ok("B reset restores manager overview API 200", s == 200, str(s))

        print("== Z. control at d37fa82: role guards, API fine, views block ==")
        ctrl = boot(CPORT, CDB, cwd=WT)
        capp = src_of("public/app.js", root=WT)
        ok("Z control HAS the old floor guards",
           OLD_FLOOR_LOCAL in capp and OLD_FLOOR_STATE in capp)
        ok("Z control HAS the old mgrGuard + hybrid router",
           OLD_MGRGUARD in capp and OLD_ROUTER in capp)
        ok("Z control lacks the capability view guards", NEW_FLOOR not in capp)
        _, zres = harness(Path(WT) / "public" / "app.js")
        ok("Z control capability pins fail",
           zres.get("pin_floor_guard_uses_floor_ops") is False
           and zres.get("pin_router_guard_is_pure_capability") is False
           and zres.get("pin_mgrguard_source_role_free") is False)
        ok("Z control DEFAULT fixtures hold (equivalence at control)",
           all(zres.get(f"fix_{n}_as_expected") is True for n in
               ("mgr_default", "kitchen_default", "server_default",
                "mgr_caps", "kitchen_caps", "server_caps")),
           str([k for k, v in zres.items() if k.startswith("fix_") and not v]))
        ok("Z control flip fixtures fail (grants/strips do not move views)",
           zres.get("case_kitchen_floor_grant_floor") is True
           and zres.get("case_server_discounts_grant_mgr_settings") is True
           and zres.get("case_mgr_no_finance_mgr_finance") is False)
        cstok, csuser = login_full("1111", base=CBASE)
        cktok, ckuser = login_full("2222", base=CBASE)
        cmtok, cmuser = login_full("2580", base=CBASE)
        write_cases(CCASES, [("server_default", csuser),
                             ("kitchen_default", ckuser),
                             ("manager_default", cmuser)])
        _, czres = harness(Path(WT) / "public" / "app.js", CCASES)
        ok("Z control LIVE default verdicts == HEAD live default verdicts",
           all(czres.get(f"case_live_{n}_{v}") == lres.get(f"case_live_{n}_{v}")
               for n in ("server_default", "kitchen_default", "manager_default")
               for v in ALL_VIEWS),
           str({(n, v): (czres.get(f"case_live_{n}_{v}"), lres.get(f"case_live_{n}_{v}"))
                for n in ("server_default", "kitchen_default", "manager_default")
                for v in ALL_VIEWS
                if czres.get(f"case_live_{n}_{v}") != lres.get(f"case_live_{n}_{v}")}))
        s, _ = req("GET", "/api/checks/open", token=cktok, base=CBASE)
        ok("Z control kitchen floor API 403 pre-grant", s == 403, str(s))
        s, r = req("PUT", "/api/admin/permissions",
                   {"matrix": {"kitchen": ["kitchen_ops", "menu_86", "floor_ops"]}},
                   token=cmtok, base=CBASE)
        ok("Z control grant floor_ops to kitchen 200", s == 200, f"{s}")
        s, _ = req("GET", "/api/checks/open", token=cktok, base=CBASE)
        ok("Z control API flips to 200 on grant (API was never the laggard)", s == 200, str(s))
        _, ckguser = login_full("2222", base=CBASE)
        write_cases(CCASES, [("kitchen_floor", ckguser)])
        _, czgres = harness(Path(WT) / "public" / "app.js", CCASES)
        ok("Z control view guards STILL block the granted-kitchen payload",
           all(czgres.get(f"case_live_kitchen_floor_{v}") is True for v in FLOOR4),
           str(czgres.get("case_live_kitchen_floor_floor")))

    finally:
        stop(srv)
        stop(ctrl)
        subprocess.run(["git", "worktree", "remove", "--force", WT], cwd=ROOT,
                       capture_output=True)
        try:
            os.unlink(Path(WT) / "node_modules")
        except Exception:
            pass

    print(f"\ntest63_view_guards: {passed} passed, {failed} failed")
    if failures:
        print("FAILED:", failures)
    sys.exit(1 if failed else 0)

if __name__ == "__main__":
    main()
