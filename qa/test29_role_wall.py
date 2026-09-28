#!/usr/bin/env python3
"""Expoline QA Test 29: R4 role API wall (adversarial).

Proves server (PIN 1111) and kitchen (PIN 2222) roles CANNOT reach
finance, pricing, labor, insights/"ask the restaurant", or other
manager-only endpoints: every one must return 403 (guard runs before any
handler logic, so even bogus IDs / minimal bodies get 403, not 404/400).

Also proves:
  - unauthenticated callers get 401 on guarded endpoints,
  - manager (PIN 2580) still gets 200 on a control sample,
  - cross-role denials hold (server blocked from KDS, kitchen blocked
    from floor check endpoints),
  - POST /api/cash/drawer/close is manager-only under the DEFAULT site
    config (see FINDINGS.md F1 for the deliberate drawer_close_role
    override),
  - GET /api/admin/opentable/status is reachable by server (FINDING F2:
    the single /api/admin/* endpoint not manager-only — asserted as
    live behavior, flagged for Daniel's call).

Reference map: middleware/roleWall.js (ROLE_MAP). This test exercises the
LIVE server's current guards; any map/code drift is reported, not hidden.

Owns its server + DB: port 4334 (never 4317/4320) with a fresh temp DB,
following qa/test28_course_fire_rollback.py.
"""
import json, os, signal, subprocess, sys, time
import urllib.request, urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.join(HERE, "..", "server.js")
PORT = int(os.environ.get("EXPOLINE_TEST_PORT", "4334"))
DB = os.environ.get("EXPOLINE_TEST_DB", "/tmp/expoline-rolewall-test29.db")
BASE = f"http://localhost:{PORT}"

if PORT in (4317, 4320):
    sys.exit("FATAL: test 29 refuses ports 4317/4320 (demo + soak ports)")


def spawn():
    if os.path.exists(DB):
        os.remove(DB)
    env = dict(os.environ, EXPOLINE_PORT=str(PORT), EXPOLINE_DB=DB, NODE_ENV="test")
    p = subprocess.Popen(["node", SERVER], env=env,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(60):
        try:
            with urllib.request.urlopen(BASE + "/api/health", timeout=2) as r:
                if r.status == 200:
                    return p
        except Exception:
            time.sleep(0.5)
    stop(p)
    sys.exit("FATAL: test server did not come up")


def stop(p):
    if p and p.poll() is None:
        p.send_signal(signal.SIGTERM)
        try:
            p.wait(timeout=10)
        except subprocess.TimeoutExpired:
            p.kill()


def api(method, path, token=None, body=None):
    req = urllib.request.Request(BASE + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json"})
    if token:
        req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return (r.status, json.loads(r.read().decode() or "{}"))
    except urllib.error.HTTPError as e:
        try:
            return (e.code, json.loads(e.read().decode() or "{}"))
        except Exception:
            return (e.code, {})


checks, fails = 0, []
def want(got, want_code, name):
    global checks
    checks += 1
    if got[0] != want_code:
        fails.append(f"FAIL {name}: want {want_code} got {got[0]} {got[1]}")
        print(f"  x {name}: want {want_code}, got {got[0]}")
    # else: print(f"  ok {name} -> {got[0]}")  # quiet on pass; summary at end


def tok(pin):
    st, b = api("POST", "/api/auth/login", None, {"pin": pin})
    assert st == 200, f"login failed for pin {pin}: {st} {b}"
    return b["token"]


# (method, path, body) — guards run before handler logic, so bogus IDs and
# minimal bodies are fine: a correct wall returns 403, never 404/400.
SENSITIVE = [
    # finance
    ("GET", "/api/finance/payouts", None),
    ("GET", "/api/finance/shift", None),
    ("GET", "/api/finance/reports/sales?format=json", None),
    ("GET", "/api/finance/product-mix", None),
    ("POST", "/api/payments/999999/refund", {}),
    ("GET", "/api/manager/overview", None),
    ("GET", "/api/cash/log", None),
    ("POST", "/api/cash/drawer/open", {"opening_float_cents": 10000}),
    ("GET", "/api/tipout/report", None),
    # pricing
    ("GET", "/api/admin/menu", None),
    ("POST", "/api/admin/menu/items", {"name": "x"}),
    ("PUT", "/api/admin/dayparts", {}),
    ("GET", "/api/admin/service-charge/config", None),
    ("PUT", "/api/course-timing", {}),
    ("POST", "/api/gift-cards/issue", {"initial_cents": 1000}),
    ("POST", "/api/gift-cards/reload", {"code": "x", "amount_cents": 100}),
    ("GET", "/api/gift-cards", None),
    # labor
    ("GET", "/api/admin/clock/shifts", None),
    ("GET", "/api/admin/clock/users", None),
    ("GET", "/api/admin/clock/config", None),
    ("GET", "/api/admin/employees", None),
    ("GET", "/api/admin/schedule", None),
    ("GET", "/api/admin/schedule/projection", None),
    # insights / "ask the restaurant"
    ("GET", "/api/insights/digest", None),
    ("POST", "/api/insights/ask", {"question": "what were sales today?"}),
    # admin misc
    ("GET", "/api/openapi.json", None),
    ("GET", "/api/docs", None),
    ("GET", "/api/inventory/status", None),
    ("GET", "/api/reviews", None),
    ("GET", "/api/guest/feedback", None),
    ("POST", "/api/tables/1/qr/rotate", {}),
    ("POST", "/api/guest/split/reverse", {}),
    ("POST", "/api/kds/settings", {}),
    # drawer close: manager-only under DEFAULT config (FINDING F1)
    ("POST", "/api/cash/drawer/close", {"counted_cents": 100}),
]

p = spawn()
try:
    ST, KT, MT = tok("1111"), tok("2222"), tok("2580")

    print("-- adversarial: server + kitchen must get 403 on manager endpoints --")
    for method, path, body in SENSITIVE:
        want(api(method, path, ST, body), 403, f"server {method} {path}")
        want(api(method, path, KT, body), 403, f"kitchen {method} {path}")

    print("-- unauthenticated -> 401 --")
    want(api("GET", "/api/finance/payouts"), 401, "no-token finance/payouts")
    want(api("GET", "/api/insights/digest"), 401, "no-token insights/digest")
    want(api("POST", "/api/insights/ask", None, {"question": "x"}), 401, "no-token insights/ask")

    print("-- manager control sample -> 200 --")
    want(api("GET", "/api/finance/payouts", MT), 200, "manager finance/payouts")
    want(api("GET", "/api/insights/digest", MT), 200, "manager insights/digest")
    want(api("GET", "/api/admin/employees", MT), 200, "manager admin/employees")
    want(api("GET", "/api/menu", MT), 200, "manager menu")

    print("-- any-staff endpoints still reachable --")
    want(api("GET", "/api/menu", ST), 200, "server menu")
    want(api("GET", "/api/menu", KT), 200, "kitchen menu")
    want(api("GET", "/api/checks/open", ST), 200, "server checks/open")
    want(api("GET", "/api/kds/tickets", KT), 200, "kitchen kds/tickets")

    print("-- cross-role denials --")
    want(api("GET", "/api/kds/tickets", ST), 403, "server kds/tickets")
    want(api("GET", "/api/kds/recall", ST), 403, "server kds/recall")
    want(api("POST", "/api/checks", KT, {"table_id": 1, "guest_count": 2}), 403, "kitchen POST checks")
    want(api("GET", "/api/checks/open", KT), 403, "kitchen checks/open")

    print("-- FINDING F2 documented behavior: server CAN read ot status --")
    want(api("GET", "/api/admin/opentable/status", ST), 200, "server ot/status (F2: live behavior)")
    want(api("GET", "/api/admin/opentable/status", KT), 403, "kitchen ot/status")
    want(api("GET", "/api/admin/opentable/status", MT), 200, "manager ot/status")

    print(f"\n{checks - len(fails)}/{checks} assertions passed")
    if fails:
        print("\nFAILURES:")
        for f in fails:
            print(" ", f)
        sys.exit(1)
    print("ROLE WALL HOLDS")
finally:
    stop(p)
