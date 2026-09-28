#!/usr/bin/env python3
"""Expoline QA Test 17: auth audit — server-side role enforcement + session handling.

Self-contained: boots a FRESH scratch server on port 4321 (never 4317/4320)
with a fresh DB at start, runs all phases, then reboots once more at the end
so the in-memory rate-limit buckets are cleared for whatever runs next.

Phases:
  1. login basics (per-role tokens, bad PIN rejected)
  2. unauthenticated callers get 401 on every protected route
  3. wrong-role callers get 403 on every protected route
  4. kiosk staff-call endpoints are server-side gated; customer flows public
  5. session/token handling: logout revokes, deactivation kills the token,
     garbage auth headers rejected
  6. manager-PIN point-of-action checks (void/comp/adjust require the PIN)
  7. auth audit-only (LOCKED POLICY): bad logins/PINs are audit-logged,
     never locked out — no 429s, service always available
"""
import json, os, subprocess, sys, time, urllib.request, urllib.error

SRV_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = "http://localhost:4321"
DB = "/tmp/auth_audit_test.db"

passed, failed = [], []

def check(name, cond, detail=""):
    (passed if cond else failed).append(name)
    print(("PASS " if cond else "FAIL ") + name + (f" [{detail}]" if detail and not cond else ""))

def call(method, path, token=None, body=None):
    req = urllib.request.Request(BASE + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json",
                 **({"Authorization": "Bearer " + token} if token else {})})
    try:
        with urllib.request.urlopen(req) as r:
            raw = r.read()
            try:
                return r.status, json.loads(raw.decode() or "null")
            except Exception:
                return r.status, {"_binary": len(raw)}
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode() or "{}")
        except Exception:
            return e.code, {}

def login(pin):
    s, b = call("POST", "/api/auth/login", body={"pin": pin})
    assert s == 200, (s, b)
    return b["token"]

def wait_up(timeout=30):
    for _ in range(int(timeout * 2)):
        try:
            if call("GET", "/api/health")[0] == 200:
                return True
        except Exception:
            pass
        time.sleep(0.5)
    return False

def boot(fresh_db):
    subprocess.run("lsof -ti:4321 | xargs kill -9 2>/dev/null", shell=True)
    time.sleep(1.5)
    if fresh_db:
        for suf in ("", "-wal", "-shm", "-journal"):
            try:
                os.remove(DB + suf)
            except FileNotFoundError:
                pass
    env = dict(os.environ, EXPOLINE_PORT="4321", EXPOLINE_DB=DB)
    subprocess.Popen(["node", "server.js"], cwd=SRV_DIR, env=env,
                     stdout=open("/tmp/auth_audit_boot.log", "a"),
                     stderr=subprocess.STDOUT, start_new_session=True)
    assert wait_up(), "scratch server did not come up on 4321"

# ------------------------------------------------------------------ phase 0
print("--- phase 0: fresh boot on 4321 ---")
boot(fresh_db=True)
check("server up", True)

# ------------------------------------------------------------------ phase 1
print("--- phase 1: login basics ---")
s, b = call("POST", "/api/auth/login", body={"pin": "1111"})
check("server login 200 + token", s == 200 and b.get("token") and b["user"]["role"] == "server", (s, b))
s, b = call("POST", "/api/auth/login", body={"pin": "2222"})
check("kitchen login 200", s == 200 and b["user"]["role"] == "kitchen", (s, b))
s, b = call("POST", "/api/auth/login", body={"pin": "2580"})
check("manager login 200", s == 200 and b["user"]["role"] == "manager", (s, b))
check("bad PIN 401", call("POST", "/api/auth/login", body={"pin": "0000"})[0] == 401)
check("empty PIN 401", call("POST", "/api/auth/login", body={"pin": ""})[0] == 401)
check("missing body PIN 401", call("POST", "/api/auth/login", body={})[0] == 401)

ST, KT, MT = login("1111"), login("2222"), login("2580")

# ------------------------------------------------------------------ phase 2
print("--- phase 2: unauthenticated -> 401 on protected routes ---")
PROTECTED_GETS = [
    "/api/menu", "/api/config", "/api/zones", "/api/checks/open", "/api/checks/1",
    "/api/kds/tickets", "/api/kds/recall",
    "/api/admin/menu", "/api/admin/menu/audit", "/api/admin/zones",
    "/api/admin/employees", "/api/admin/employees/next-number", "/api/admin/approvals/audit",
    "/api/finance/payouts", "/api/finance/shift", "/api/finance/reports/sales",
    "/api/manager/overview",
    "/api/gift-cards", "/api/gift-cards/AAAA-BBBB-CCCC/txns", "/api/gift-cards/balance/AAAA-BBBB-CCCC",
    "/api/admin/clock/shifts", "/api/admin/clock/config", "/api/admin/clock/users", "/api/admin/clock/audit",
    "/api/online/orders", "/api/loyalty/lookup?phone=6195550100",
    "/api/reservations", "/api/waitlist", "/api/floor/availability", "/api/clock/status",
    "/api/kiosk/calls",
]
for p in PROTECTED_GETS:
    check(f"no-token GET {p} -> 401", call("GET", p)[0] == 401)

PROTECTED_POSTS = [
    ("POST", "/api/admin/menu/categories", {"name": "X"}),
    ("POST", "/api/admin/menu/items", {"name": "X", "category_id": 1, "price_cents": 100}),
    ("POST", "/api/admin/menu/86/1", {}),
    ("PUT", "/api/admin/menu/items/1", {"name": "X"}),
    ("DELETE", "/api/admin/menu/items/999999", None),
    ("POST", "/api/checks", {"table_id": 1, "guest_count": 2}),
    ("POST", "/api/checks/1/items", {"menu_item_id": 1, "seat": 1, "qty": 1}),
    ("DELETE", "/api/checks/1/items/1", {"manager_pin": "2580"}),
    ("POST", "/api/checks/1/void-item", {"item_id": 1, "manager_pin": "2580"}),
    ("POST", "/api/checks/1/comp", {"amount_cents": 100, "manager_pin": "2580", "reason": "x"}),
    ("POST", "/api/checks/1/send", {}),
    ("POST", "/api/checks/1/split", {"mode": "even", "parts": 2}),
    ("POST", "/api/checks/1/payments", {"method": "cash", "amount_cents": 100}),
    ("POST", "/api/payments/1/refund", {}),
    ("POST", "/api/kds/tickets/1/bump", {"status": "in_progress"}),
    ("POST", "/api/gift-cards/issue", {"initial_cents": 1000}),
    ("POST", "/api/gift-cards/reload", {"code": "X", "amount_cents": 100}),
    ("POST", "/api/gift-cards/void", {"code": "X"}),
    ("POST", "/api/gift-cards/redeem", {"check_id": 1, "gift_card_code": "X"}),
    ("POST", "/api/loyalty/earn", {"check_id": 1, "phone": "6195550100"}),
    ("POST", "/api/loyalty/redeem", {"check_id": 1, "phone": "6195550100", "points": 100}),
    ("POST", "/api/reservations", {"customer_name": "T", "party_size": 2, "reserved_at": "2030-01-01T12:00:00Z"}),
    ("PATCH", "/api/reservations/1", {"status": "seated"}),
    ("DELETE", "/api/reservations/1", None),
    ("POST", "/api/waitlist", {"customer_name": "T", "party_size": 2}),
    ("POST", "/api/waitlist/1/notify", {}),
    ("DELETE", "/api/waitlist/1", None),
    ("POST", "/api/clock/in", {}),
    ("POST", "/api/admin/clock/adjust", {"shift_id": 1, "manager_pin": "2580"}),
    ("POST", "/api/admin/employees", {"name": "N", "role": "server", "pin": "9998"}),
    ("POST", "/api/kiosk/calls/1/clear", {}),
    ("POST", "/api/admin/zones", {"name": "Z"}),
    ("POST", "/api/admin/tables", {"zone_id": 1, "label": "ZZ"}),
    ("PATCH", "/api/online/orders/1", {"status": "cancelled"}),
]
for m, p, b in PROTECTED_POSTS:
    check(f"no-token {m} {p} -> 401", call(m, p, None, b)[0] == 401)
check("bogus token -> 401", call("GET", "/api/menu", "deadbeef" * 8)[0] == 401)

print("--- public endpoints stay public ---")
for p, want in [("/api/health", 200), ("/api/brain/status", 200), ("/api/online/menu", 200),
                ("/api/menuboards", 200), ("/api/kiosk/menu", 200)]:
    check(f"public GET {p} -> {want}", call("GET", p)[0] == want)
check("public POST /api/kiosk/call-staff", call("POST", "/api/kiosk/call-staff", None, {})[0] in (200, 201))
s, _ = call("POST", "/api/online/orders", None,
            {"customer_name": "Pub", "phone": "6195550199",
             "items": [{"menu_item_id": 1, "qty": 1}]})
check("public POST /api/online/orders", s == 201, s)

# ------------------------------------------------------------------ phase 3
print("--- phase 3: wrong-role -> 403 ---")
# server must not touch manager-only or kitchen-only
for m, p, b in [("GET", "/api/admin/menu", None), ("GET", "/api/finance/payouts", None),
                ("GET", "/api/finance/shift", None), ("GET", "/api/finance/reports/sales", None),
                ("GET", "/api/manager/overview", None), ("GET", "/api/admin/employees", None),
                ("POST", "/api/admin/employees", {"name": "N", "role": "server", "pin": "9997"}),
                ("POST", "/api/payments/1/refund", {}), ("POST", "/api/gift-cards/issue", {"initial_cents": 500}),
                ("GET", "/api/admin/clock/shifts", None), ("POST", "/api/admin/clock/adjust", {"shift_id": 1}),
                ("GET", "/api/kds/tickets", None), ("POST", "/api/kds/tickets/1/bump", {"status": "in_progress"}),
                ("GET", "/api/kds/recall", None), ("GET", "/api/online/orders", None)]:
    check(f"server {m} {p} -> 403", call(m, p, ST, b)[0] == 403)
# kitchen must not touch server or manager routes
for m, p, b in [("GET", "/api/finance/payouts", None), ("GET", "/api/manager/overview", None),
                ("POST", "/api/payments/1/refund", {}), ("POST", "/api/checks", {"table_id": 1, "guest_count": 2}),
                ("GET", "/api/checks/open", None), ("POST", "/api/admin/menu/categories", {"name": "X"}),
                ("GET", "/api/admin/employees", None), ("POST", "/api/gift-cards/issue", {"initial_cents": 500}),
                ("GET", "/api/reservations", None), ("POST", "/api/loyalty/earn", {"check_id": 1, "phone": "1"}),
                ("GET", "/api/kiosk/calls", None)]:
    check(f"kitchen {m} {p} -> 403", call(m, p, KT, b)[0] == 403)
# kitchen CAN do kitchen things
check("kitchen GET /api/kds/tickets 200", call("GET", "/api/kds/tickets", KT)[0] == 200)
check("kitchen GET /api/online/orders 200", call("GET", "/api/online/orders", KT)[0] == 200)
# manager can do everything role-gated
for m, p in [("GET", "/api/admin/menu"), ("GET", "/api/finance/payouts"), ("GET", "/api/manager/overview"),
              ("GET", "/api/kds/tickets"), ("GET", "/api/checks/open"), ("GET", "/api/admin/clock/shifts"),
              ("GET", "/api/kiosk/calls")]:
    check(f"manager {m} {p} -> 200", call(m, p, MT)[0] == 200)

# ------------------------------------------------------------------ phase 4
print("--- phase 4: kiosk staff-call endpoints gated ---")
check("no-token GET /api/kiosk/calls -> 401", call("GET", "/api/kiosk/calls")[0] == 401)
check("kitchen GET /api/kiosk/calls -> 403", call("GET", "/api/kiosk/calls", KT)[0] == 403)
check("server GET /api/kiosk/calls -> 200", call("GET", "/api/kiosk/calls", ST)[0] == 200)
check("no-token POST /api/kiosk/calls/1/clear -> 401", call("POST", "/api/kiosk/calls/1/clear")[0] == 401)
check("manager POST /api/kiosk/calls/999999/clear -> 404", call("POST", "/api/kiosk/calls/999999/clear", MT)[0] == 404)

# ------------------------------------------------------------------ phase 5
print("--- phase 5: session/token handling ---")
t = login("1111")
check("token works before logout", call("GET", "/api/menu", t)[0] == 200)
check("logout 200", call("POST", "/api/auth/logout", t)[0] == 200)
check("token dead after logout -> 401", call("GET", "/api/menu", t)[0] == 401)
check("logout without token still 200", call("POST", "/api/auth/logout")[0] == 200)
# deactivation kills the live session
s, b = call("POST", "/api/admin/employees", MT, {"name": "Audit Temp", "role": "server", "pin": "4477"})
check("temp employee created", s == 201, (s, b))
et = login("4477")
check("temp token works while active", call("GET", "/api/checks/open", et)[0] == 200)
s, _ = call("DELETE", f"/api/admin/employees/{b['id']}", MT)
check("temp employee deactivated", s == 200, s)
check("deactivated token -> 401", call("GET", "/api/checks/open", et)[0] == 401)
check("deactivated PIN cannot log in", call("POST", "/api/auth/login", body={"pin": "4477"})[0] == 401)
# role change applies to the live session: demote path — promote temp then check.
# (uses a fresh temp employee to avoid touching the seeded manager)
s, b = call("POST", "/api/admin/employees", MT, {"name": "Audit Temp2", "role": "server", "pin": "4488"})
et2 = login("4488")
check("temp2 cannot hit manager route", call("GET", "/api/admin/menu", et2)[0] == 403)
s, _ = call("PUT", f"/api/admin/employees/{b['id']}", MT, {"role": "manager"})
check("temp2 promoted", s == 200, s)
check("promoted session gains manager access", call("GET", "/api/admin/menu", et2)[0] == 200)
s, _ = call("PUT", f"/api/admin/employees/{b['id']}", MT, {"role": "server"})
check("temp2 demoted", s == 200, s)
check("demoted session loses manager access", call("GET", "/api/admin/menu", et2)[0] == 403)
call("DELETE", f"/api/admin/employees/{b['id']}", MT)
# garbage Authorization variants
for hv in ["Bearer", "Bearer ", "Token abc", "Bearer x y"]:
    req = urllib.request.Request(BASE + "/api/menu", method="GET",
                                 headers={"Content-Type": "application/json", "Authorization": hv})
    try:
        with urllib.request.urlopen(req) as r:
            code = r.status
    except urllib.error.HTTPError as e:
        code = e.code
    check(f"garbage auth {hv!r} -> 401", code == 401)

# ------------------------------------------------------------------ phase 6
print("--- phase 6: manager-PIN point-of-action ---")
s, zones = call("GET", "/api/zones", MT)
s, opens = call("GET", "/api/checks/open", MT)
busy = {c["table_id"] for c in opens}
free_table = None
for z in zones:
    for t in z.get("tables", []):
        if t["id"] not in busy:
            free_table = t["id"]
            break
    if free_table:
        break
assert free_table, "no free table in seed"
s, b = call("POST", "/api/checks", ST, {"table_id": free_table, "guest_count": 2})
check("check created for PIN tests", s == 201, (s, b))
chk = b["id"]
# put a real item on the check so comp/void have something to act on
s, mi = call("GET", "/api/menu", ST)
item_id = mi[0]["items"][0]["id"]
s, ib = call("POST", f"/api/checks/{chk}/items", ST, {"menu_item_id": item_id, "seat": 1, "qty": 1})
check("item added for PIN tests", s == 201, (s, ib))
line_id = ib["id"]
s, ib2 = call("POST", f"/api/checks/{chk}/items", ST, {"menu_item_id": item_id, "seat": 1, "qty": 1})
check("second item added (comp needs a nonzero subtotal after the void)", s == 201)
check("void-item without manager_pin -> 403",
      call("POST", f"/api/checks/{chk}/void-item", ST, {"item_id": line_id})[0] == 403)
check("void-item with wrong manager_pin -> 403",
      call("POST", f"/api/checks/{chk}/void-item", ST, {"item_id": line_id, "manager_pin": "0000"})[0] == 403)
check("void-item with correct manager_pin works",
      call("POST", f"/api/checks/{chk}/void-item", ST, {"item_id": line_id, "manager_pin": "2580", "reason": "audit"})[0] == 200)
check("comp without manager_pin -> 403",
      call("POST", f"/api/checks/{chk}/comp", ST, {"amount_cents": 100, "reason": "x"})[0] == 403)
check("comp with wrong manager_pin -> 403",
      call("POST", f"/api/checks/{chk}/comp", ST, {"amount_cents": 100, "manager_pin": "0000", "reason": "x"})[0] == 403)
check("comp with correct manager_pin works",
      call("POST", f"/api/checks/{chk}/comp", ST, {"amount_cents": 100, "manager_pin": "2580", "reason": "audit"})[0] == 200)
s, b = call("POST", "/api/clock/in", ST)
sid = b["id"]
check("clock adjust without manager_pin -> 403",
      call("POST", "/api/admin/clock/adjust", MT, {"shift_id": sid, "clock_in": "2026-09-26T09:00:00Z"})[0] == 403)
s, _ = call("POST", "/api/admin/clock/adjust", MT, {"shift_id": sid, "manager_pin": "2580", "clock_in": "2026-09-26T09:00:00Z"})
check("clock adjust with manager_pin works", s == 200, s)
call("POST", "/api/clock/out", ST)
call("POST", f"/api/checks/{chk}/close", ST)

# ------------------------------------------------------------------ phase 7
print("--- phase 7: auth audit-only (LOCKED POLICY: no lockout) ---")
# Policy B (2026-09-27): failed logins / manager-PIN attempts are AUDIT-LOGGED,
# never locked out. Hammering with bad credentials must never yield 429, and
# the failures must appear in the approval audit log.
boot(fresh_db=False)
MT = login("2580")
codes = [call("POST", "/api/auth/login", body={"pin": "0101"})[0] for _ in range(15)]
check("login: 15 bad PINs all 401, never 429 (no lockout)", all(c == 401 for c in codes), codes)
check("login: good PIN still works immediately after bad attempts",
      call("POST", "/api/auth/login", body={"pin": "1111"})[0] == 200)
codes = [call("POST", "/api/admin/clock/adjust", MT, {"shift_id": 1, "manager_pin": "0202"})[0] for _ in range(12)]
check("manager PIN: 12 bad attempts all 403, never 429 (no lockout)", all(c == 403 for c in codes), codes)
check("manager PIN: good PIN still works immediately after bad attempts",
      call("POST", "/api/admin/clock/adjust", MT, {"shift_id": 1, "manager_pin": "2580", "clock_in": "2026-09-26T09:00:00Z"})[0] == 200)
s, audit = call("GET", "/api/admin/approvals/audit?limit=500", MT)
actions = [r["action"] for r in (audit if isinstance(audit, list) else [])]
check("audit log records failed logins",
      s == 200 and "auth_login_failed" in actions, actions[-5:] if isinstance(audit, list) else s)
check("audit log records failed manager-PIN attempts",
      s == 200 and "auth_manager_pin_failed" in actions, actions[-5:] if isinstance(audit, list) else s)

# ------------------------------------------------------------------ cleanup
print("--- cleanup: reboot to clear rate-limit buckets ---")
boot(fresh_db=False)
check("server healthy after reboot", call("GET", "/api/health")[0] == 200)
check("login works after reboot", call("POST", "/api/auth/login", body={"pin": "1111"})[0] == 200)

print(f"\n{len(passed)} passed, {len(failed)} failed")
if failed:
    print("FAILURES:")
    for f in failed:
        print("  -", f)
    sys.exit(1)
print("ALL GREEN")
