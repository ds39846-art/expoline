#!/usr/bin/env python3
"""test35_client_regressions.py — permanent regression tests for the three
client bugs found and fixed on 2026-10-03:

  A. getMenu() stripped `modifier_groups` and `popular` from menu items
     (fixed b7ed54a / 40f544c) — the order screen never saw the groups,
     so required pickers (Temperature, Flavor) never rendered.
  B. Pick-1 modifier groups (max_select=1) behaved as checkboxes — the
     pre-checked default stayed ticked next to the new pick (fixed
     f27aaef, radio semantics in addItemFlow).
  C. HOLD cleared the staged list BEFORE server confirmation — one
     rejected POST wiped the whole half-built order, localStorage
     included (fixed 7a8ac0f).

Method: qa/harness35_client.js extracts the REAL getMenu / addItemFlow /
#btn-hold handler from public/app.js by brace matching and runs them in
vm contexts — getMenu against a genuine /api/menu payload captured from
a scratch server booted by this test (with one item SQL-flagged
popular), addItemFlow against a minimal DOM shim, HOLD against a
stubbed api whose second POST rejects.

Standalone: python3 qa/test35_client_regressions.py [--app-js PATH]
--app-js points the harness at another checkout's app.js; the suite is
expected to FAIL against d48c287 (the commit before all three fixes).
Own server on :4344 with a scratch DB. Never touches 4317/4320.
"""
import argparse, json, os, signal, sqlite3, subprocess, sys, time
import urllib.request, urllib.error
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PORT = 4344
DB = "/tmp/expoline-test35.db"
BASE = f"http://localhost:{PORT}"
PAYLOAD = "/tmp/expoline-test35-menu.json"

checks, fails = 0, []
def ok(cond, name, detail=""):
    global checks
    checks += 1
    if not cond:
        fails.append(f"FAIL: {name} {detail}")
        print(f"  x {name} {detail}")
    else:
        print(f"  + {name}")

def api(method, path, token=None, body=None):
    req = urllib.request.Request(BASE + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json"})
    if token: req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return resp.status, json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        return e.code, {}

def boot():
    env = dict(os.environ, EXPOLINE_PORT=str(PORT), EXPOLINE_DB=DB, NODE_ENV="test")
    p = subprocess.Popen(["node", str(ROOT / "server.js")], env=env,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(60):
        try:
            with urllib.request.urlopen(BASE + "/api/health", timeout=2) as r:
                if r.status == 200: return p
        except Exception: time.sleep(0.5)
    p.kill(); raise RuntimeError("server did not come up")

def stop(p):
    if p and p.poll() is None:
        p.send_signal(signal.SIGTERM); p.wait(timeout=10)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--app-js", default=str(ROOT / "public" / "app.js"))
    args = ap.parse_args()

    # --- capture a genuine /api/menu payload from a scratch server ---
    for suf in ("", "-wal", "-shm"):
        try: os.remove(DB + suf)
        except FileNotFoundError: pass
    srv = boot()
    try:
        con = sqlite3.connect(DB)
        con.execute("UPDATE menu_items SET popular = 1 WHERE name = 'Bali Fries' AND site_id = 'bali-hai'")
        con.commit(); con.close()
        st, r = api("POST", "/api/auth/login", None, {"pin": "1111"})
        assert st == 200, f"login failed: {r}"
        st, menu = api("GET", "/api/menu", r["token"])
        assert st == 200, f"menu fetch failed: {st}"
    finally:
        stop(srv)
    Path(PAYLOAD).write_text(json.dumps(menu))

    # fixture sanity: the payload itself must carry the fields under test,
    # so a harness failure can only mean the CLIENT dropped them.
    cats = menu if isinstance(menu, list) else (menu.get("categories") or menu.get("menu") or [])
    items = {i["name"]: i for c in cats for i in c.get("items", [])}
    rib = items.get("14oz Ribeye", {})
    ok(bool((rib.get("modifier_groups") or [])), "fixture: API payload has Ribeye modifier_groups")
    ok(items.get("Bali Fries", {}).get("popular") is True, "fixture: API payload flags Bali Fries popular")

    # --- run the extracted-real-function harness ---
    r = subprocess.run(["node", str(ROOT / "qa" / "harness35_client.js"), args.app_js, PAYLOAD],
                       capture_output=True, text=True, timeout=120)
    try:
        result = json.loads(r.stdout.strip().splitlines()[-1])
    except Exception:
        print("node stdout:\n", r.stdout, "\nnode stderr:\n", r.stderr)
        sys.exit("FAIL: harness produced no result")
    if result.get("harnessError"):
        print("HARNESS ERROR:", result["harnessError"])
    for a in result.get("assertions", []):
        ok(a["pass"], f'{a["id"]} {a["name"]}', a.get("detail", ""))
    ok(not result.get("harnessError"), "harness completed without internal error")

    print(f"\n{'ALL GREEN' if not fails else 'FAILURES'}: {checks - len(fails)}/{checks} checks passed"
          f" (app.js under test: {args.app_js})")
    sys.exit(1 if fails else 0)

if __name__ == "__main__":
    main()
