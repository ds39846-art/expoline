#!/usr/bin/env python3
"""Expoline QA Test 27: synchronized course-fire timing.

Covers: GET/PUT /api/course-timing, GET /api/checks/:id/fire-schedule,
POST /api/checks/:id/fire-course — including the critical property that
FIRE actually puts held items on KDS (not just a timestamp), check
validation, duplicate-fire 409, out-of-order fires, re-fires, and role gates.
"""
import json, sys, urllib.request, urllib.error
import os

BASE = os.environ.get("EXPOLINE_BASE", os.environ.get("EXPLOINE_BASE", "http://localhost:4317"))
S = "1111"; K = "2222"; M = "2580"

def login(pin):
    r = api("POST", "/api/auth/login", {}, {"pin": pin})
    return r["token"]

def api(method, path, token=None, body=None, raw=False):
    req = urllib.request.Request(BASE + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json"})
    if token: req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req) as resp:
            return (resp.status, resp.read().decode()) if raw else json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        if raw: return (e.code, e.read().decode())
        raise

ST = login(S); KT = login(K); MT = login(M)
checks, fails = 0, []
def ok(cond, name, detail=""):
    global checks
    checks += 1
    if not cond:
        fails.append(f"FAIL: {name} {detail}")
        print(f"  ✗ {name} {detail}")
    else:
        print(f"  ✓ {name}")

def expect_status(method, path, token, body, want, name):
    st, txt = api(method, path, token, body, raw=True)
    ok(st == want, name, f"(got {st} {txt[:150]})")
    return st, txt

print("== Test 27a: course-timing config ==")
t = api("GET", "/api/course-timing", ST)
ok("timing" in t and len(t["timing"]) == 4, "seeded 4 courses", str(len(t.get("timing", []))))
by = {r["course"]: r for r in t["timing"]}
ok(by.get("appetizer", {}).get("eat_minutes") == 20, "appetizer default 20m eat")
ok(by.get("entree", {}).get("prep_minutes") == 18, "entree default 18m prep")

# Server cannot update timing (manager-only)
expect_status("PUT", "/api/course-timing", ST, {"timing": []}, 403, "server blocked from PUT timing")
# Bad body
expect_status("PUT", "/api/course-timing", MT, {}, 400, "PUT timing missing array -> 400")
expect_status("PUT", "/api/course-timing", MT, {"timing": "nope"}, 400, "PUT timing non-array -> 400")
# Manager update + clamping
r = api("PUT", "/api/course-timing", MT, {"timing": [
    {"course": "appetizer", "eat_minutes": 25, "prep_minutes": 14},
    {"course": "entree", "eat_minutes": 999, "prep_minutes": -5},  # clamped
    {"course": "", "eat_minutes": 10, "prep_minutes": 10},  # skipped (no course)
    {"course": "dessert", "eat_minutes": "x", "prep_minutes": 10},  # skipped (non-number)
]})
ok(r.get("ok"), "manager PUT timing ok")
t2 = api("GET", "/api/course-timing", ST)
by2 = {r["course"]: r for r in t2["timing"]}
ok(by2["appetizer"]["eat_minutes"] == 25, "appetizer updated to 25m")
ok(by2["entree"]["eat_minutes"] == 180, "entree eat clamped to 180")
ok(by2["entree"]["prep_minutes"] == 1, "entree prep clamped to 1")
# restore defaults for other tests
api("PUT", "/api/course-timing", MT, {"timing": [
    {"course": "drink", "eat_minutes": 10, "prep_minutes": 5},
    {"course": "appetizer", "eat_minutes": 20, "prep_minutes": 12},
    {"course": "entree", "eat_minutes": 30, "prep_minutes": 18},
    {"course": "dessert", "eat_minutes": 15, "prep_minutes": 10},
]})

print("== Test 27b: fire-schedule / fire-course validation ==")
expect_status("GET", "/api/checks/999999/fire-schedule", ST, None, 404, "schedule on missing check -> 404")
expect_status("POST", "/api/checks/999999/fire-course", ST, {"course": "appetizer"}, 404, "fire on missing check -> 404")
expect_status("GET", "/api/checks/abc-not-a-check/fire-schedule", ST, None, 404, "schedule on garbage id -> 404")

# Build a check with items across courses. Find menu items by course first.
menu = api("GET", "/api/menu", ST)
by_course = {}
def walk_menu(node):
    if isinstance(node, dict):
        if node.get("items"):
            for it in node["items"]:
                c = (it.get("course") or "").lower()
                if c in ("drink", "appetizer", "entree", "dessert") and c not in by_course:
                    by_course[c] = it
        for v in node.values():
            walk_menu(v)
    elif isinstance(node, list):
        for v in node: walk_menu(v)
walk_menu(menu)
ok(len(by_course) == 4, "found menu items in all 4 courses", str(sorted(by_course)))

c1 = api("POST", "/api/checks", ST, {"table_id": 1, "guest_count": 2, "tab_name": "QA course timing"})
cid = c1["id"]
ok(c1["status"] == "open", "check opened")

# Invalid course values
expect_status("POST", f"/api/checks/{cid}/fire-course", ST, {"course": "brunch"}, 400, "invalid course -> 400")
expect_status("POST", f"/api/checks/{cid}/fire-course", ST, {}, 400, "missing course -> 400")
# Kitchen cannot fire courses
expect_status("POST", f"/api/checks/{cid}/fire-course", KT, {"course": "appetizer"}, 403, "kitchen blocked from fire-course")

# Schedule with no held items: empty schedule, no fired
s0 = api("GET", f"/api/checks/{cid}/fire-schedule", ST)
ok(s0["schedule"] == [] and s0["fired"] == [], "empty check -> empty schedule")

print("== Test 27c: fire appetizer -> KDS ticket created ==")
for course in ("drink", "appetizer", "entree"):
    mi = by_course[course]
    r = api("POST", f"/api/checks/{cid}/items", ST, {"menu_item_id": mi["id"], "seat": 1, "qty": 1})
    ok(r.get("ok") or r.get("id"), f"added {course} item ({mi['name']})")

s1 = api("GET", f"/api/checks/{cid}/fire-schedule", ST)
sched_courses = [s["course"] for s in s1["schedule"]]
ok(sched_courses == ["drink", "appetizer", "entree"], "schedule lists held courses in order", str(sched_courses))
ok(all("fire_at" in s and "eat_minutes" in s for s in s1["schedule"]), "schedule entries have fire_at + estimates")

# FIRE the appetizer course
f1 = api("POST", f"/api/checks/{cid}/fire-course", ST, {"course": "appetizer"})
ok(f1.get("ok") and f1.get("sent") == 1, "fire appetizer -> sent 1 item", str(f1.get("sent")))
ok(len(f1.get("tickets", [])) == 1, "fire appetizer -> 1 KDS ticket")

# Verify the ticket actually has the appetizer item
tix = f1["tickets"][0]
items_json = tix.get("items_json") or tix.get("items") or []
if isinstance(items_json, str): items_json = json.loads(items_json)
ok(any((it.get("course") or "").lower() == "appetizer" for it in items_json), "KDS ticket holds appetizer item")

# Verify item state flipped to sent
check_items = api("GET", f"/api/checks/{cid}", ST).get("items", [])
app_items = [i for i in check_items if (i.get("course") or "").lower() == "appetizer"]
ok(all(i.get("state") == "sent" for i in app_items), "appetizer items marked sent")
drink_items = [i for i in check_items if (i.get("course") or "").lower() == "drink"]
ok(all(i.get("state") == "held" for i in drink_items), "drink items still held")

# Schedule now excludes appetizer, shows fired
s2 = api("GET", f"/api/checks/{cid}/fire-schedule", ST)
ok([s["course"] for s in s2["schedule"]] == ["drink", "entree"], "appetizer dropped from schedule", str([s["course"] for s in s2["schedule"]]))
ok(any(f["course"] == "appetizer" for f in s2["fired"]), "appetizer in fired list")

print("== Test 27d: duplicate fire -> 409, out-of-order, re-fire ==")
expect_status("POST", f"/api/checks/{cid}/fire-course", ST, {"course": "appetizer"}, 409, "duplicate appetizer fire -> 409")

# Out-of-order: fire entree before drink — allowed, schedule recomputes
f2 = api("POST", f"/api/checks/{cid}/fire-course", ST, {"course": "entree"})
ok(f2.get("ok") and f2.get("sent") == 1, "out-of-order entree fire works")
s3 = api("GET", f"/api/checks/{cid}/fire-schedule", ST)
ok([s["course"] for s in s3["schedule"]] == ["drink"], "only drink remains", str([s["course"] for s in s3["schedule"]]))

# Re-fire: add another drink after drink was never fired — then fire drink twice via new items
f3 = api("POST", f"/api/checks/{cid}/fire-course", ST, {"course": "drink"})
ok(f3.get("ok") and f3.get("sent") == 1, "fire drink -> sent 1")
# Add another drink item post-fire; schedule should offer drink again
mi_drink = by_course["drink"]
api("POST", f"/api/checks/{cid}/items", ST, {"menu_item_id": mi_drink["id"], "seat": 2, "qty": 1})
s4 = api("GET", f"/api/checks/{cid}/fire-schedule", ST)
ok("drink" in [s["course"] for s in s4["schedule"]], "new drink item reappears in schedule")
# But duplicate fire record is still blocked
expect_status("POST", f"/api/checks/{cid}/fire-course", ST, {"course": "drink"}, 409, "drink re-fire blocked (already recorded)")

print("== Test 27e: closed check ==")
# Pay & close the check, then fire -> 400
api("POST", f"/api/checks/{cid}/send", ST, {})  # send any remaining held
c_tot = api("GET", f"/api/checks/{cid}", ST)
api("POST", f"/api/checks/{cid}/payments", ST, {"method": "cash", "amount_cents": c_tot["total_cents"]})
# close if needed
c_now = api("GET", f"/api/checks/{cid}", ST)
if c_now.get("status") == "open":
    api("POST", f"/api/checks/{cid}/close", MT, {})
expect_status("POST", f"/api/checks/{cid}/fire-course", ST, {"course": "dessert"}, 400, "fire on closed check -> 400")

print(f"\n{checks - len(fails)}/{checks} assertions passed")
if fails:
    print("\n".join(fails))
    sys.exit(1)
print("TEST 27 PASS")
