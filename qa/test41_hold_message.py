#!/usr/bin/env python3
"""
test41 — HOLD failure messaging (Daniel's live-acceptance defect,
2026-10-05 night): a rejected line must be NAMED, not miscounted.

Incident: 5 staged lines, one an Edamame with no Flavor pick; HOLD
answered "5 need attention: Flavor: please choose at least one" —
no line named, and every still-staged line counted as bad.

API half (own scratch server on :4347, the test35 boot pattern):
  - POST /send-now is a batch: only the server knows which line
    failed, so a per-line validation failure now carries line_index
    + item_name next to the (unchanged) error string. Cases: bad
    line in the middle (index 1), bad line first (index 0), a bad
    course on line 2, and an all-valid control that still fires.
  - POST /items keeps its bare per-line error contract — the HOLD
    client posts line by line and names the line itself.

Client half (qa/harness41_client.js — REAL extracted functions):
  the #btn-hold handler names the rejected line ("Edamame (Seat 1)
  needs attention: <reason> · N more lines still staged"), keeps the
  confirm-per-item contract (stop at the rejection; failed +
  unattempted lines stay staged); the add modal's confirm button
  reads "Save" in Modify mode and "Add to order" on a fresh add;
  drawCart separates the note and allergy segments with a real space.

Discriminating control: run this suite from a cc30c0e worktree —
the send-now cases fail (no line_index/item_name in the body) and
harness sections J/K/L fail on the old strings (evidence in the
build report).
"""
import json
import os
import signal
import subprocess
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HERE = Path(__file__).resolve().parent
PORT = 4347
DB = "/tmp/expoline-test41.db"
BASE = f"http://127.0.0.1:{PORT}"
PAYLOAD = "/tmp/expoline-t41-menu.json"
SERVER_PIN = "1111"
MANAGER_PIN = "2580"

passed = failed = 0
failures = []


def ok(name, cond, extra=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"  ok  {name}")
    else:
        failed += 1
        failures.append(name)
        print(f"  FAIL {name} {extra}")


def req(method, path, body=None, token=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(BASE + path, data=data, method=method)
    r.add_header("Content-Type", "application/json")
    if token:
        r.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(r, timeout=15) as resp:
            return resp.status, json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode() or "{}")
        except Exception:
            return e.code, {}
    except Exception as e:
        return 0, {"error": str(e)}


def boot():
    env = dict(os.environ, EXPOLINE_PORT=str(PORT), EXPOLINE_DB=DB, NODE_ENV="test")
    p = subprocess.Popen(["node", str(ROOT / "server.js")], env=env,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(80):
        try:
            s, _ = req("GET", "/api/health")
            if s == 200:
                return p
        except Exception:
            pass
        time.sleep(0.4)
    p.kill()
    raise RuntimeError("server did not come up")


def main():
    app_js = str(ROOT / "public" / "app.js")
    for a in sys.argv[1:]:
        if a.startswith("--app-js="):
            app_js = a.split("=", 1)[1]

    for suf in ("", "-wal", "-shm"):
        try:
            os.remove(DB + suf)
        except FileNotFoundError:
            pass
    srv = boot()
    try:
        s, login = req("POST", "/api/auth/login", {"pin": SERVER_PIN})
        tok = login.get("token")
        s, mlogin = req("POST", "/api/auth/login", {"pin": MANAGER_PIN})
        mtok = mlogin.get("token")
        ok("logins (server + manager)", bool(tok) and bool(mtok))

        s, menu = req("GET", "/api/menu?all=1", token=mtok)
        if isinstance(menu, list):
            menu = {"categories": menu}
        items = [it for c in menu.get("categories", []) for it in c.get("items", [])]
        by_name = {it["name"]: it for it in items}
        eda = by_name.get("Edamame")
        fries = by_name.get("Bali Fries")
        ok("fixture menu: Edamame (Flavor group) + Bali Fries",
           bool(eda and fries and eda.get("modifier_groups")), f"eda={bool(eda)} fries={bool(fries)}")
        flav = [g for g in eda["modifier_groups"] if g["name"] == "Flavor"][0]
        sea_salt = [o for o in flav["options"] if o["name"] == "Sea Salt"][0]
        Path(PAYLOAD).write_text(json.dumps(menu))

        s, zones = req("GET", "/api/zones", token=tok)
        if isinstance(zones, list):
            zones = {"zones": zones}
        table = None
        for z in zones.get("zones", []):
            for t in z.get("tables", []):
                if not t.get("open_check_id"):
                    table = t
                    break
            if table:
                break
        ok("a free table exists", table is not None)
        s, opened = req("POST", "/api/checks", {"table_id": table["id"], "guest_count": 4}, token=tok)
        check = opened.get("check") or opened or {}
        cid = check.get("id")
        ok("check opened (4 guests)", s == 201 and bool(cid), f"s={s} {opened}")

        eda_ok = {"menu_item_id": eda["id"], "seat": 1, "qty": 1,
                  "modifiers": [{"name": "Sea Salt", "option_id": sea_salt["id"], "price_delta_cents": 0}]}
        eda_bad = {"menu_item_id": eda["id"], "seat": 1, "qty": 1, "modifiers": []}
        fries_ok = {"menu_item_id": fries["id"], "seat": 2, "qty": 1, "modifiers": []}

        print("\n== POST /send-now — per-line failures carry their line ==")
        s, r = req("POST", f"/api/checks/{cid}/send-now",
                   {"items": [eda_ok, eda_bad, fries_ok]}, token=tok)
        ok("bad middle line 400s with the bare reason intact",
           s == 400 and "Flavor: please choose at least one" in (r.get("error") or ""), f"s={s} {r}")
        ok("…and names the line: line_index 1, item_name Edamame",
           r.get("line_index") == 1 and r.get("item_name") == "Edamame", f"{r}")

        s, r = req("POST", f"/api/checks/{cid}/send-now", {"items": [eda_bad]}, token=tok)
        ok("bad first line tags line_index 0",
           s == 400 and r.get("line_index") == 0 and r.get("item_name") == "Edamame", f"s={s} {r}")

        bad_course = dict(eda_ok)
        bad_course["course"] = "brunch"
        s, r = req("POST", f"/api/checks/{cid}/send-now",
                   {"items": [fries_ok, bad_course]}, token=tok)
        ok("bad course on line 2 tags line_index 1 too",
           s == 400 and r.get("line_index") == 1 and "course must be one of" in (r.get("error") or ""),
           f"s={s} {r}")

        s, r = req("POST", f"/api/checks/{cid}/send-now",
                   {"items": [eda_ok, fries_ok]}, token=tok)
        ok("all-valid send-now still fires both lines (control)",
           s in (200, 201) and r.get("sent") == 2, f"s={s} {r}")

        print("\n== POST /items — bare per-line contract unchanged ==")
        s, r = req("POST", f"/api/checks/{cid}/items",
                   {"menu_item_id": eda["id"], "seat": 1, "qty": 1, "modifiers": []}, token=tok)
        ok("missing Flavor still 400s with the bare group error (client names the line)",
           s == 400 and r.get("error") == "Flavor: please choose at least one" and "line_index" not in r,
           f"s={s} {r}")

        print("\n== client harness (REAL extracted functions) ==")
        r = subprocess.run(["node", str(HERE / "harness41_client.js"), PAYLOAD, app_js],
                           capture_output=True, text=True, timeout=120)
        print(r.stdout.rstrip())
        if r.stderr.strip():
            print(r.stderr.rstrip()[:1500])
        harness_fail = r.stdout.count("  FAIL ")
        harness_pass = r.stdout.count("  ok  ")
        ok("harness41 fully green", r.returncode == 0 and harness_fail == 0,
           f"rc={r.returncode} fails={harness_fail}")
        globals()["passed"] = passed + harness_pass - 1
        print(f"  (harness assertions passed: {harness_pass})")
    finally:
        if srv and srv.poll() is None:
            srv.send_signal(signal.SIGTERM)
            srv.wait(timeout=10)

    print(f"\n==== test41: {passed} passed, {failed} failed ====")
    if failures:
        print("failures:", "; ".join(failures))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
