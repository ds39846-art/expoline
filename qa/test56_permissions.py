#!/usr/bin/env python3
"""
test56 — capability matrix over the role gates (audit gap #10).

Expoline had exactly three hardcoded roles baked into gate helpers
(serverPlus / kitchenPlus / managerOnly). This batch introduces a
per-role CAPABILITY MATRIX (site_config permissions_json) that the
gate helpers consult on every request, tunable by a manager in the
new Settings -> Permissions editor.

THE HARD ANCHOR — section A is an explicit role x endpoint equivalence
table (44 probes x server/kitchen/manager + an unauthenticated
column). With the default (absent) matrix, every cell must equal the
pre-batch behavior at 83b91bb. Gate classes: ALLOW = the request got
past the role/capability gate (any non-403 status, OR a 403 that is
the separate manager-PIN axis refusing — PIN refusals prove the role
gate PASSED); DENY = a gate 403 ("Forbidden: requires ..."). The
control run executes section A alone against a pristine 83b91bb tree
(TEST56_EQUIV_ONLY=1): the identical table must pass there, while
sections B+ fail there (matrix endpoints 404 at the base commit).

Sections:
  A  equivalence table (the anchor; runs at BOTH commits)
  F  client payload: login capabilities + GET /api/admin/permissions
  B  matrix effects: grant flips one surface only; revoke; reset
  C  lockout invariant, validation, audit row, partial PUT semantics
  D  PIN axis untouched: capabilities never substitute for a fresh
     manager PIN (close-day with a granted capability; comp PIN-always
     even for the manager role itself)
  E  split_allowed coexistence: the per-user flag + PIN path behave
     exactly as pre-matrix under the default matrix
  G  session freshness: same token, grant/revoke apply next request
  H  harness56_client.js — the extracted client helpers + wiring

Server: fresh subprocess on :4398 (scratch DB; seeds demo users
server 1111 / kitchen 2222 / manager 2580).
"""
import json, os, sqlite3, subprocess, sys, time, urllib.request, urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PORT = 4398
BASE = f"http://127.0.0.1:{PORT}"
DB = "/tmp/test56_permissions.db"
EQUIV_ONLY = os.environ.get("TEST56_EQUIV_ONLY") == "1"

passed = failed = 0
def ok(name, cond, extra=""):
    global passed, failed
    if cond: passed += 1; print(f"  ok  {name}")
    else: failed += 1; print(f"  FAIL {name} {extra}")

def req(method, path, body=None, tok=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(BASE + path, data=data, method=method)
    r.add_header("Content-Type", "application/json")
    if tok: r.add_header("Authorization", "Bearer " + tok)
    try:
        with urllib.request.urlopen(r, timeout=15) as x:
            raw = x.read().decode("utf-8", "replace")
            try: return x.status, (json.loads(raw) if raw else {})
            except Exception: return x.status, {"raw": raw[:80]}
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try: return e.code, json.loads(raw)
        except Exception: return e.code, {"raw": raw}
    except Exception as e:
        return 0, {"error": str(e)}

def login(pin):
    s, r = req("POST", "/api/auth/login", {"pin": pin})
    assert s == 200, (s, r)
    return r["token"], r["user"]

def gate_class(status, body):
    """ALLOW / DENY / UNAUTH for one probe response (see header)."""
    if status == 401: return "UNAUTH"
    if status == 403:
        text = json.dumps(body).lower()
        if "manager_pin" in text or "manager pin" in text: return "ALLOW"  # PIN axis, gate passed
        return "DENY"
    return "ALLOW"

def wait_health(proc, timeout=30):
    t0 = time.time()
    while time.time() - t0 < timeout:
        if proc.poll() is not None: raise RuntimeError(f"server exited {proc.returncode}")
        try:
            with urllib.request.urlopen(BASE + "/health", timeout=2) as x:
                if x.status == 200: return
        except Exception: pass
        time.sleep(0.25)
    raise RuntimeError("server did not come up")

ALL_CAPS = ["floor_ops", "kitchen_ops", "menu_86", "admin_menu", "admin_discounts",
            "admin_inventory", "finance_reports", "finance_closeout", "refunds",
            "clock_admin", "site_admin", "permissions_admin"]
DEFAULTS = {"server": ["floor_ops", "menu_86"], "kitchen": ["kitchen_ops", "menu_86"],
            "manager": ALL_CAPS}

def main():
    for suffix in ("", "-wal", "-shm"):
        try: os.unlink(DB + suffix)
        except FileNotFoundError: pass
    env = dict(os.environ, EXPOLINE_DB=DB, EXPOLINE_PORT=str(PORT))
    proc = subprocess.Popen(["node", "server.js"], cwd=ROOT, env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        wait_health(proc)
        S, s_user = login("1111")
        K, k_user = login("2222")
        M, m_user = login("2580")
        A, D_, U = "ALLOW", "DENY", "UNAUTH"

        # ---- discovery: tables, a menu item, one check per floor role ----
        s, zones = req("GET", "/api/zones", tok=M)
        tables = [t["id"] for z in zones for t in z.get("tables", [])]
        s, menu = req("GET", "/api/menu", tok=M)
        cats = menu["categories"] if isinstance(menu, dict) else menu
        item_id = cats[0]["items"][0]["id"]
        s, chk = req("POST", "/api/checks", {"table_id": tables[5], "guest_count": 2}, tok=S)
        cid = (chk.get("check") or chk)["id"]
        s, chk2 = req("POST", "/api/checks", {"table_id": tables[6], "guest_count": 2}, tok=M)
        cid_m = (chk2.get("check") or chk2)["id"]

        print("== A. EQUIVALENCE TABLE — default matrix == HEAD == 83b91bb behavior ==")
        # (label, method, path, body, server, kitchen, manager, anon?)
        probes = [
            ("GET /api/zones (ungated beyond auth)", "GET", "/api/zones", None, A, A, A, True),
            ("GET /api/checks/open", "GET", "/api/checks/open", None, A, D_, A, True),
            ("POST /api/checks", "POST", "/api/checks", {"table_id": tables[7], "guest_count": 2}, A, D_, A, False),
            ("GET /api/discounts (floor feed)", "GET", "/api/discounts", None, A, D_, A, False),
            ("GET /api/admin/house-accounts", "GET", "/api/admin/house-accounts", None, A, D_, A, False),
            ("GET /api/reservations", "GET", "/api/reservations", None, A, D_, A, False),
            ("GET /api/waitlist", "GET", "/api/waitlist", None, A, D_, A, False),
            ("GET /api/dayparts", "GET", "/api/dayparts", None, A, D_, A, False),
            ("GET /api/admin/dayparts", "GET", "/api/admin/dayparts", None, D_, D_, A, False),
            ("GET /api/kiosk/calls", "GET", "/api/kiosk/calls", None, A, D_, A, False),
            ("GET /api/loyalty/lookup", "GET", "/api/loyalty/lookup?phone=5550100", None, A, D_, A, False),
            ("POST /api/gift-cards/redeem (bad code)", "POST", "/api/gift-cards/redeem",
             {"check_id": cid, "gift_card_code": "NOPE", "amount_cents": 100}, A, D_, A, False),
            ("PATCH /api/payments/999999/tip", "PATCH", "/api/payments/999999/tip", {"tip_cents": 100}, A, D_, A, False),
            ("GET /api/kds/tickets", "GET", "/api/kds/tickets", None, D_, A, A, True),
            ("GET /api/kds/settings", "GET", "/api/kds/settings", None, D_, A, A, False),
            ("GET /api/online/orders", "GET", "/api/online/orders", None, D_, A, A, False),
            ("POST /api/menu/items/:id/86 restore (noop)", "POST", f"/api/menu/items/{item_id}/86",
             {"action": "restore"}, A, A, A, False),
            ("GET /api/admin/menu", "GET", "/api/admin/menu", None, D_, D_, A, True),
            ("GET /api/admin/menu/items/:id/modifier-groups", "GET", f"/api/admin/menu/items/{item_id}/modifier-groups", None, D_, D_, A, False),
            ("GET /api/admin/discounts", "GET", "/api/admin/discounts", None, D_, D_, A, False),
            ("GET /api/admin/inventory/ingredients", "GET", "/api/admin/inventory/ingredients", None, D_, D_, A, False),
            ("GET /api/inventory/status", "GET", "/api/inventory/status", None, D_, D_, A, False),
            ("GET /api/finance/payouts", "GET", "/api/finance/payouts", None, D_, D_, A, True),
            ("GET /api/finance/reports/tax", "GET", "/api/finance/reports/tax?from=2026-10-01&to=2026-10-06&format=json", None, D_, D_, A, False),
            ("GET /api/tipout/report", "GET", "/api/tipout/report?date=2026-10-06", None, D_, D_, A, False),
            ("GET /api/insights/digest", "GET", "/api/insights/digest", None, D_, D_, A, False),
            ("GET /api/manager/overview", "GET", "/api/manager/overview", None, D_, D_, A, False),
            ("GET /api/cash/log", "GET", "/api/cash/log", None, D_, D_, A, False),
            ("GET /api/finance/closeouts", "GET", "/api/finance/closeouts", None, D_, D_, A, True),
            ("GET /api/finance/close-day", "GET", "/api/finance/close-day?date=2026-10-06", None, D_, D_, A, False),
            ("GET /api/admin/clock/shifts", "GET", "/api/admin/clock/shifts", None, D_, D_, A, True),
            ("GET /api/admin/employees", "GET", "/api/admin/employees", None, D_, D_, A, False),
            ("GET /api/admin/zones", "GET", "/api/admin/zones", None, D_, D_, A, True),
            ("GET /api/admin/approvals/audit", "GET", "/api/admin/approvals/audit", None, D_, D_, A, False),
            ("GET /api/openapi.json", "GET", "/api/openapi.json", None, D_, D_, A, False),
            ("GET /api/gift-cards (admin list)", "GET", "/api/gift-cards", None, D_, D_, A, False),
            ("POST /api/payments/999999/refund", "POST", "/api/payments/999999/refund", {}, D_, D_, A, False),
            ("POST /api/checks/999999/reopen", "POST", "/api/checks/999999/reopen", {}, D_, D_, A, False),
            ("DELETE /api/reservations/999999", "DELETE", "/api/reservations/999999", None, D_, D_, A, False),
            ("GET /api/guest/feedback", "GET", "/api/guest/feedback", None, D_, D_, A, False),
            ("POST /api/kds/settings", "POST", "/api/kds/settings",
             {"kds_age_warn_minutes": 9, "kds_age_critical_minutes": 19}, D_, D_, A, False),
            ("PUT /api/admin/settings (bogus key)", "PUT", "/api/admin/settings", {"key": "__bogus__", "value": "x"}, D_, D_, A, False),
            ("POST /api/cash/drawer/close (un-migrated role policy gate)", "POST", "/api/cash/drawer/close", {}, D_, D_, A, False),
            ("POST /api/checks/:id/tax-exempt (PIN axis proves gate)", "POST", f"/api/checks/{cid}/tax-exempt", {}, A, D_, A, False),
        ]
        toks = {"server": S, "kitchen": K, "manager": M}
        for label, method, path, body, e_s, e_k, e_m, anon in probes:
            for role, exp in (("server", e_s), ("kitchen", e_k), ("manager", e_m)):
                st, r = req(method, path, body, tok=toks[role])
                got = gate_class(st, r)
                ok(f"A {label} — {role}", got == exp, f"want {exp} got {got} ({st} {str(r)[:90]})")
            if anon:
                st, r = req(method, path, body)
                ok(f"A {label} — anon 401", gate_class(st, r) == U, f"got {st}")
        ok("A table size >= 25 probes", len(probes) >= 25, str(len(probes)))

        if EQUIV_ONLY:
            print(f"\ntest56 (equivalence only): {passed} passed, {failed} failed")
            return 1 if failed else 0

        print("== F. client payload — login capabilities + GET matrix (fresh state) ==")
        ok("F login: server capabilities = defaults", s_user.get("capabilities") == DEFAULTS["server"], str(s_user.get("capabilities")))
        ok("F login: kitchen capabilities = defaults", k_user.get("capabilities") == DEFAULTS["kitchen"])
        ok("F login: manager capabilities = all 12", sorted(m_user.get("capabilities", [])) == sorted(ALL_CAPS))
        s, p = req("GET", "/api/admin/permissions", tok=K)
        ok("F GET matrix readable by kitchen (any staff)", s == 200, str(s))
        ok("F payload: 12 capability defs with labels",
           len(p.get("capabilities", [])) == 12 and all("label" in c and "desc" in c for c in p["capabilities"]))
        ok("F payload: roles are the three existing roles", p.get("roles") == ["server", "kitchen", "manager"])
        ok("F payload: effective matrix = defaults on a fresh site", p.get("matrix") == DEFAULTS, str(p.get("matrix"))[:120])
        ok("F payload: stored flag false before any save", p.get("stored") is False)
        ok("F payload: yours = caller capabilities", p.get("yours") == DEFAULTS["kitchen"])
        s, p = req("GET", "/api/admin/permissions")
        ok("F GET matrix anon -> 401", s == 401, str(s))

        print("== B. matrix effects — grant / revoke / reset ==")
        s, r = req("PUT", "/api/admin/permissions",
                   {"matrix": {"kitchen": ["kitchen_ops", "menu_86", "finance_reports"]}}, tok=M)
        ok("B grant kitchen finance_reports -> 200", s == 200, str(r)[:120])
        s, r = req("GET", "/api/finance/payouts", tok=K)
        ok("B kitchen payouts flips to allow", s == 200, str(s))
        s, r = req("GET", "/api/finance/reports/tax?from=2026-10-01&to=2026-10-06&format=json", tok=K)
        ok("B kitchen tax report flips too (same capability)", s == 200, str(s))
        s, r = req("GET", "/api/checks/open", tok=K)
        ok("B kitchen floor still denied (other caps unchanged)", gate_class(s, r) == D_)
        s, r = req("GET", "/api/finance/payouts", tok=S)
        ok("B server finance still denied", gate_class(s, r) == D_)
        s, r = req("PUT", "/api/admin/permissions", {"matrix": {"server": ["menu_86"]}}, tok=M)
        ok("B revoke server floor_ops -> 200", s == 200, str(r)[:120])
        s, r = req("GET", "/api/checks/open", tok=S)
        ok("B server checks/open now denied", gate_class(s, r) == D_)
        s, r = req("POST", "/api/checks", {"table_id": tables[8], "guest_count": 2}, tok=S)
        ok("B server create check now denied", gate_class(s, r) == D_)
        s, r = req("POST", f"/api/menu/items/{item_id}/86", {"action": "restore"}, tok=S)
        ok("B server kept menu_86 (restore noop still 200)", s == 200 and r.get("noop") is True, f"{s} {str(r)[:80]}")
        s, r = req("GET", "/api/checks/open", tok=M)
        ok("B manager floor unaffected by server revoke", s == 200, str(s))
        s, r = req("PUT", "/api/admin/permissions", {"matrix": {"server": ["floor_ops", "menu_86", "site_admin"]}}, tok=M)
        s, r = req("GET", "/api/admin/zones", tok=S)
        ok("B grant server site_admin -> zones allow", s == 200, str(s))
        s, r = req("GET", "/api/finance/payouts", tok=S)
        ok("B server finance still denied (site_admin is not finance)", gate_class(s, r) == D_)
        s, r = req("PUT", "/api/admin/permissions", {"reset": True}, tok=M)
        ok("B reset -> 200", s == 200, str(r)[:100])
        s, r = req("GET", "/api/finance/payouts", tok=K)
        ok("B reset: kitchen finance denied again", gate_class(s, r) == D_)
        s, r = req("GET", "/api/checks/open", tok=S)
        ok("B reset: server floor restored", s == 200, str(s))
        s, p = req("GET", "/api/admin/permissions", tok=M)
        ok("B reset: stored flag false + matrix = defaults", p.get("stored") is False and p.get("matrix") == DEFAULTS)

        print("== C. lockout invariant + validation + audit + partial PUT ==")
        s, r = req("PUT", "/api/admin/permissions", {"matrix": {"manager": ["floor_ops", "site_admin"]}}, tok=M)
        ok("C PUT stripping manager permissions_admin -> 400", s == 400 and "lock" in json.dumps(r).lower(), f"{s} {str(r)[:120]}")
        s, r = req("PUT", "/api/admin/permissions", {"matrix": {"manager": []}}, tok=M)
        ok("C PUT emptying the manager set -> 400 (lockout)", s == 400, str(s))
        s, r = req("PUT", "/api/admin/permissions", {"matrix": {"owner": ["floor_ops"]}}, tok=M)
        ok("C unknown role -> 400", s == 400, str(s))
        s, r = req("PUT", "/api/admin/permissions", {"matrix": {"server": ["fly_to_the_moon"]}}, tok=M)
        ok("C unknown capability -> 400", s == 400, str(s))
        s, r = req("PUT", "/api/admin/permissions", {"matrix": {"server": "floor_ops"}}, tok=M)
        ok("C non-array capability set -> 400", s == 400, str(s))
        s, r = req("PUT", "/api/admin/permissions", {"nope": {}}, tok=M)
        ok("C missing matrix -> 400", s == 400, str(s))
        s, r = req("PUT", "/api/admin/permissions", {"matrix": {"kitchen": ["kitchen_ops"]}}, tok=S)
        ok("C PUT by server -> 403", gate_class(s, r) == D_, str(s))
        s, r = req("PUT", "/api/admin/permissions", {"matrix": {"kitchen": ["kitchen_ops"]}}, tok=K)
        ok("C PUT by kitchen -> 403", gate_class(s, r) == D_, str(s))
        s, r = req("PUT", "/api/admin/permissions", {"matrix": {"kitchen": ["kitchen_ops"]}})
        ok("C PUT anon -> 401", s == 401, str(s))
        s, p = req("GET", "/api/admin/permissions", tok=M)
        ok("C refused PUTs changed nothing (defaults still effective)",
           p.get("matrix") == DEFAULTS and p.get("stored") is False, str(p.get("matrix"))[:100])
        # partial PUT: unlisted roles keep their stored set
        req("PUT", "/api/admin/permissions", {"matrix": {"server": ["floor_ops", "menu_86", "refunds"]}}, tok=M)
        req("PUT", "/api/admin/permissions", {"matrix": {"kitchen": ["kitchen_ops", "menu_86", "clock_admin"]}}, tok=M)
        s, p = req("GET", "/api/admin/permissions", tok=M)
        ok("C partial PUT: server set persists across a kitchen-only PUT",
           p["matrix"]["server"] == ["floor_ops", "menu_86", "refunds"], str(p["matrix"].get("server")))
        ok("C partial PUT: kitchen set replaced", p["matrix"]["kitchen"] == ["kitchen_ops", "menu_86", "clock_admin"])
        ok("C partial PUT: manager untouched (defaults)", p["matrix"]["manager"] == ALL_CAPS)
        s, rows = req("GET", "/api/admin/approvals/audit?limit=100", tok=M)
        perm_rows = [x for x in rows if x.get("action") == "permissions_update"]
        ok("C matrix changes audit-logged (permissions_update rows)", len(perm_rows) >= 3, str(len(perm_rows)))
        if perm_rows:
            latest = perm_rows[0]
            before = json.loads(latest["before_json"]); after = json.loads(latest["after_json"])
            ok("C audit row carries before/after matrices",
               before.get("kitchen") == DEFAULTS["kitchen"] and after.get("kitchen") == ["kitchen_ops", "menu_86", "clock_admin"],
               str(latest)[:160])
        req("PUT", "/api/admin/permissions", {"reset": True}, tok=M)

        print("== D. PIN axis untouched — capabilities never replace a fresh manager PIN ==")
        req("PUT", "/api/admin/permissions",
            {"matrix": {"server": ["floor_ops", "menu_86", "finance_closeout"]}}, tok=M)
        s, r = req("POST", "/api/finance/close-day",
                   {"date": "2026-09-15", "counted_cash_cents": 0}, tok=S)
        ok("D granted server close-day WITHOUT pin -> 403 need_manager_pin",
           s == 403 and "manager_pin" in json.dumps(r), f"{s} {str(r)[:110]}")
        s, r = req("POST", "/api/finance/close-day",
                   {"date": "2026-09-15", "counted_cash_cents": 0, "manager_pin": "0000"}, tok=S)
        ok("D granted server close-day with WRONG pin -> 403", s == 403, str(s))
        s, r = req("POST", "/api/finance/close-day",
                   {"date": "2026-09-15", "counted_cash_cents": 0, "manager_pin": "2580"}, tok=S)
        ok("D granted server close-day WITH the fresh manager PIN -> 201 (both axes satisfied)",
           s == 201, f"{s} {str(r)[:110]}")
        # comp: PIN-always — even the manager role (all capabilities) comping
        req("POST", f"/api/checks/{cid_m}/items", {"menu_item_id": item_id, "qty": 1, "seat": 1}, tok=M)
        s, r = req("POST", f"/api/checks/{cid_m}/comp", {"amount_cents": 100, "reason": "test56"}, tok=M)
        ok("D manager comp WITHOUT pin -> 403 (PIN-always, capabilities irrelevant)",
           s == 403 and "manager pin" in json.dumps(r).lower(), f"{s} {str(r)[:110]}")
        s, r = req("POST", f"/api/checks/{cid_m}/comp",
                   {"amount_cents": 100, "reason": "test56", "manager_pin": "2580"}, tok=M)
        ok("D manager comp WITH pin -> 200", s == 200, f"{s} {str(r)[:110]}")
        s, r = req("POST", f"/api/checks/{cid}/comp", {"amount_cents": 100, "reason": "test56"}, tok=S)
        ok("D server comp WITHOUT pin -> 403", s == 403, str(s))
        req("PUT", "/api/admin/permissions", {"reset": True}, tok=M)

        print("== E. split_allowed coexistence — per-user flag + PIN path unchanged ==")
        conn = sqlite3.connect(DB)
        def set_split_allowed(v):
            conn.execute("UPDATE users SET split_allowed = ? WHERE role = 'server'", (v,))
            conn.commit()
        def mkpair(tag, t0):
            ids = []
            for t in (t0, t0 + 1, t0 + 2):
                s, a = req("POST", "/api/checks", {"table_id": tables[t], "guest_count": 2}, tok=S)
                assert (a.get("check") or a).get("id"), (tag, s, a)
                ids.append((a.get("check") or a)["id"])
            s, r = req("POST", f"/api/checks/{ids[0]}/items", {"menu_item_id": item_id, "qty": 2, "seat": 1}, tok=S)
            assert s in (200, 201), (tag, s, r)
            s, full = req("GET", f"/api/checks/{ids[0]}", tok=S)
            line = [i for i in full["items"] if i["state"] != "cancelled"][0]
            return ids[0], [ids[1], ids[2]], line["id"]
        set_split_allowed(0)
        ca, targets, line_id = mkpair("E1", 9)
        s, r = req("POST", f"/api/checks/{ca}/split-item-cost",
                   {"item_id": line_id, "targets": targets}, tok=S)
        ok("E split by split_allowed=0 server -> 403 need_manager_pin",
           s == 403 and r.get("need_manager_pin") is True, f"{s} {str(r)[:130]}")
        s, r = req("POST", f"/api/checks/{ca}/split-item-cost",
                   {"item_id": line_id, "targets": targets, "manager_pin": "2580"}, tok=S)
        ok("E same split WITH manager PIN -> 200 (the pre-matrix PIN path)",
           s == 200, f"{s} {str(r)[:110]}")
        set_split_allowed(1)
        ca2, targets2, line2 = mkpair("E2", 12)
        s, r = req("POST", f"/api/checks/{ca2}/split-item-cost",
                   {"item_id": line2, "targets": targets2}, tok=S)
        ok("E split_allowed=1 server splits with no PIN -> 200 (default behavior)",
           s == 200, f"{s} {str(r)[:110]}")
        conn.close()

        print("== G. session freshness — grant/revoke apply to the SAME token, next request ==")
        s, r = req("GET", "/api/finance/payouts", tok=K)
        ok("G kitchen token starts denied", gate_class(s, r) == D_)
        req("PUT", "/api/admin/permissions",
            {"matrix": {"kitchen": ["kitchen_ops", "menu_86", "finance_reports"]}}, tok=M)
        s, r = req("GET", "/api/finance/payouts", tok=K)
        ok("G SAME kitchen token allowed after grant (no re-login)", s == 200, str(s))
        req("PUT", "/api/admin/permissions", {"reset": True}, tok=M)
        s, r = req("GET", "/api/finance/payouts", tok=K)
        ok("G SAME kitchen token denied again after reset", gate_class(s, r) == D_)

        print("== H. harness56 — extracted client helpers + wiring ==")
        h = subprocess.run(["node", os.path.join(HERE, "harness56_client.js")],
                           capture_output=True, text=True, timeout=60)
        hok = h.stdout.count("  ok  ")
        ok("H harness56 all pass", h.returncode == 0 and "ALL PASS" in h.stdout,
           (h.stdout + h.stderr)[-400:])
        ok("H harness56 check count >= 25", hok >= 25, str(hok))

        print(f"\ntest56: {passed} passed, {failed} failed")
        return 1 if failed else 0
    finally:
        proc.terminate()
        try: proc.wait(timeout=5)
        except Exception: proc.kill()

if __name__ == "__main__":
    sys.exit(main())
