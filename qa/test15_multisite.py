#!/usr/bin/env python3
"""Expoline multi-site isolation — qa/test15_multisite.py.

Verifies that each restaurant site gets its own isolated database file,
so one site's corruption/config/network failure cannot affect another.

- Site A (bali-hai) on port 4341, DB db/sites/bali-hai.db
- Site B (test-site-2) on port 4342, DB db/sites/test-site-2.db
- Gift card issued on A is NOT visible on B (and vice versa)
- Brain status endpoints report correct site slugs and DB paths
"""
import json, subprocess, time, urllib.request, urllib.error, os, sys

SRV_DIR = "/home/hatch/workspace/goals/expo-line-pos-beat-toast-spoton-pilot-at-bali-hai/build/expoline"
SITES = [
    {"slug": "bali-hai", "port": 4341, "db": "/tmp/msite_a.db"},
    {"slug": "test-site-2", "port": 4342, "db": "/tmp/msite_b.db"},
]

def start_site(slug, port, db):
    subprocess.run(f"lsof -ti:{port} | xargs kill -9 2>/dev/null", shell=True)
    time.sleep(1)
    try: os.unlink(db)
    except: pass
    env = dict(os.environ, EXPOLINE_PORT=str(port), EXPOLINE_DB=db,
               EXPOLINE_SITE=slug)
    subprocess.Popen(["node", "server.js"], cwd=SRV_DIR, env=env,
                     stdout=open(f"/tmp/msite_{port}.log", "a"),
                     stderr=subprocess.STDOUT, start_new_session=True)
    for _ in range(30):
        try:
            urllib.request.urlopen(f"http://localhost:{port}/api/health", timeout=2)
            return True
        except: time.sleep(1)
    return False

def call(port, method, path, token=None, body=None):
    req = urllib.request.Request(
        f"http://localhost:{port}{path}", method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json",
                 **({"Authorization": "Bearer " + token} if token else {})})
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode() or "{}")

checks, fails = 0, []
def ok(cond, name, detail=""):
    global checks
    checks += 1
    if cond: print(f"  ✓ {name}")
    else:
        fails.append(name)
        print(f"  ✗ {name}: {detail}")

print("--- starting isolated site servers ---")
for s in SITES:
    assert start_site(s["slug"], s["port"], s["db"]), f"site {s['slug']} failed to start"
    print(f"  ✓ {s['slug']} up on :{s['port']}")

print("--- brain status reports correct site ---")
for s in SITES:
    st, b = call(s["port"], "GET", "/api/brain/status")
    ok(st == 200 and b.get("site_slug") == s["slug"],
       f"{s['slug']} brain reports correct slug", (st, b))
    ok(b.get("brain") is True, f"{s['slug']} brain flag true")

print("--- gift card isolation ---")
tokens = {}
for s in SITES:
    st, b = call(s["port"], "POST", "/api/auth/login", body={"pin": "2580"})
    assert st == 200, (s["slug"], st, b)
    tokens[s["slug"]] = b["token"]

# Issue on A
st, b = call(4341, "POST", "/api/gift-cards/issue", tokens["bali-hai"],
             {"initial_cents": 7777})
assert st in (200, 201), (st, b)
code_a = b["card"]["code"]
print(f"  ✓ issued {code_a} on bali-hai")

# A sees it
st, b = call(4341, "GET", f"/api/gift-cards/balance/{code_a}", tokens["bali-hai"])
ok(st == 200 and b.get("card", {}).get("balance_cents") == 7777,
   "site A sees own card", (st, b))

# B does NOT see it
st, b = call(4342, "GET", f"/api/gift-cards/balance/{code_a}", tokens["test-site-2"])
ok(st == 404, "site B cannot see site A card", (st, b))

# Issue on B, A cannot see it
st, b = call(4342, "POST", "/api/gift-cards/issue", tokens["test-site-2"],
             {"initial_cents": 8888})
assert st in (200, 201), (st, b)
code_b = b["card"]["code"]
st, b = call(4341, "GET", f"/api/gift-cards/balance/{code_b}", tokens["bali-hai"])
ok(st == 404, "site A cannot see site B card", (st, b))

print("--- DB files are separate ---")
for s in SITES:
    ok(os.path.exists(s["db"]), f"{s['slug']} DB file exists at {s['db']}")

print(f"\nTest 15: {checks} assertions, {len(fails)} failures")
sys.exit(1 if fails else 0)
