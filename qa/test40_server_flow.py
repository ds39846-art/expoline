#!/usr/bin/env python3
"""
test40 — server-flow frictions (Daniel's live-demo report, 2026-10-05):
course at ring time, type-the-number guest counts, Modify-before-send.

API half (against a freshly seeded scratch server on :4346):
  - POST /items honors a per-line course: chosen course lands on the
    held line (read back via GET check), absent course keeps the menu
    default, explicit null clears it, an unknown course 400s.
  - POST /send-now honors course the same way (and 400s on a bad one).
  - PATCH guest_count (the call WS-B's typed header uses): 1..24 apply
    and read back; 0 / 25 bounce 400; shrinking below an occupied seat
    bounces with the honest re-seat message.

Client half (qa/harness40_client.js — REAL extracted functions):
  getMenu course pass-through; add-modal course picker default + pick;
  modal seat stepper; Modify preset pre-load; staged line gains a group
  modifier in the editor; HOLD posts course per line (null rides, legacy
  omission preserved); quick-bar course pills + Modify label; the real
  tappableValue guest typing (valid apply / invalid bounce + toast).

Source wiring (the parts a harness can't click): the three guest
steppers are wired to tappableValue in the shipped source.

Discriminating controls (run manually, evidence in the build report):
this suite at f841f4b fails the course API cases (course ignored ->
menu default read back; invalid course -> 201), and the harness at
f841f4b fails E/F/G/H (no course in getMenu, no #m-course, HOLD posts
no course, no pills, label still "More…").
"""
import json
import os
import subprocess
import sys
import time
import urllib.request
import urllib.error

BASE = "http://127.0.0.1:4346"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HERE = os.path.dirname(os.path.abspath(__file__))
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


def wait_up(deadline=40):
    t0 = time.time()
    while time.time() - t0 < deadline:
        try:
            s, _ = req("GET", "/api/health")
            if s == 200:
                return True
        except Exception:
            pass
        time.sleep(0.4)
    return False


def main():
    app_js = os.path.join(ROOT, "public", "app.js")
    po_js = os.path.join(ROOT, "public", "views", "parity_orders.js")
    for a in sys.argv[1:]:
        if a.startswith("--app-js="):
            app_js = a.split("=", 1)[1]
        if a.startswith("--po-js="):
            po_js = a.split("=", 1)[1]

    if not wait_up():
        print("server on :4346 not reachable — start the scratch server first")
        return 1

    s, login = req("POST", "/api/auth/login", {"pin": SERVER_PIN})
    tok = login.get("token")
    s, mtok_body = req("POST", "/api/auth/login", {"pin": MANAGER_PIN})
    mtok = mtok_body.get("token")
    ok("logins (server + manager)", bool(tok) and bool(mtok))

    s, menu = req("GET", "/api/menu?all=1", token=mtok)
    if isinstance(menu, list):  # ?all=1 returns the bare categories array
        menu = {"categories": menu}
    items = [it for c in menu.get("categories", []) for it in c.get("items", [])]
    by_name = {it["name"]: it for it in items}
    rib = by_name.get("14oz Ribeye")
    eda = by_name.get("Edamame")
    ok("fixture menu: Ribeye + Edamame with groups and courses",
       bool(rib and eda and rib.get("course") and eda.get("course")
           and rib.get("modifier_groups") and eda.get("modifier_groups")),
       f"rib={rib and rib.get('course')} eda={eda and eda.get('course')}")
    temp = [g for g in rib["modifier_groups"] if g["name"] == "Temperature"][0]
    medium = [o for o in temp["options"] if o["name"] == "Medium"][0]
    flav = [g for g in eda["modifier_groups"] if g["name"] == "Flavor"][0]
    spicy = [o for o in flav["options"] if o["name"] == "Spicy Chili Garlic"][0]

    payload_path = "/tmp/expoline-t40-menu.json"
    with open(payload_path, "w") as f:
        json.dump(menu, f)

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
    ok("check opened (4 guests)", s == 201 and check.get("guest_count") == 4, f"s={s} {opened}")

    def line(item_id):
        s2, view = req("GET", f"/api/checks/{cid}", token=tok)
        for it in view.get("items", []):
            if it["id"] == item_id:
                return it
        return None

    print("\n== POST /items — per-line course ==")
    s, it1 = req("POST", f"/api/checks/{cid}/items",
                 {"menu_item_id": rib["id"], "seat": 1, "qty": 1,
                  "modifiers": [{"name": "Medium", "option_id": medium["id"], "price_delta_cents": 0}],
                  "course": "dessert"}, token=tok)
    ok("chosen course accepted (201)", s == 201, f"s={s} {it1}")
    back1 = line(it1.get("id")) if it1.get("id") else None
    ok("chosen course on the held line (GET read-back)", back1 and back1.get("course") == "dessert",
       f"course={back1 and back1.get('course')}")

    s, it2 = req("POST", f"/api/checks/{cid}/items",
                 {"menu_item_id": rib["id"], "seat": 1, "qty": 1,
                  "modifiers": [{"name": "Medium", "option_id": medium["id"], "price_delta_cents": 0}]},
                 token=tok)
    back2 = line(it2.get("id")) if it2.get("id") else None
    ok("absent course keeps the menu default", s == 201 and back2 and back2.get("course") == rib["course"],
       f"s={s} course={back2 and back2.get('course')} want={rib['course']}")

    s, it3 = req("POST", f"/api/checks/{cid}/items",
                 {"menu_item_id": rib["id"], "seat": 2, "qty": 1,
                  "modifiers": [{"name": "Medium", "option_id": medium["id"], "price_delta_cents": 0}],
                  "course": None}, token=tok)
    back3 = line(it3.get("id")) if it3.get("id") else None
    ok("explicit null course clears to no-course", s == 201 and back3 is not None and back3.get("course") is None,
       f"s={s} course={back3 and back3.get('course')}")

    s, bad = req("POST", f"/api/checks/{cid}/items",
                 {"menu_item_id": rib["id"], "seat": 1, "qty": 1,
                  "modifiers": [{"name": "Medium", "option_id": medium["id"], "price_delta_cents": 0}],
                  "course": "brunch"}, token=tok)
    ok("unknown course 400s with the taxonomy message",
       s == 400 and "course must be one of" in (bad.get("error") or ""), f"s={s} {bad}")

    print("\n== POST /send-now — per-line course ==")
    s, sn = req("POST", f"/api/checks/{cid}/send-now",
                {"items": [{"menu_item_id": eda["id"], "seat": 1, "qty": 1,
                            "modifiers": [{"name": "Spicy Chili Garlic", "option_id": spicy["id"], "price_delta_cents": 0}],
                            "course": "dessert"}]}, token=tok)
    sn_items = sn.get("items") or []
    ok("send-now chosen course lands on the fired line",
       s in (200, 201) and sn_items and sn_items[0].get("course") == "dessert",
       f"s={s} {sn}")
    s, snbad = req("POST", f"/api/checks/{cid}/send-now",
                   {"items": [{"menu_item_id": eda["id"], "seat": 1, "qty": 1,
                               "modifiers": [{"name": "Spicy Chili Garlic", "option_id": spicy["id"], "price_delta_cents": 0}],
                               "course": "brunch"}]}, token=tok)
    ok("send-now unknown course 400s", s == 400, f"s={s} {snbad}")

    print("\n== PATCH guest_count — the typed-header call ==")
    s, p = req("PATCH", f"/api/checks/{cid}", {"guest_count": 7}, token=tok)
    s, view = req("GET", f"/api/checks/{cid}", token=tok)
    ok("typed 7 applies and reads back", s == 200 and (view.get("check") or view).get("guest_count") == 7,
       f"guests={(view.get('check') or {}).get('guest_count')}")
    s, p25 = req("PATCH", f"/api/checks/{cid}", {"guest_count": 25}, token=tok)
    ok("25 bounces (1..24)", s == 400, f"s={s}")
    s, p0 = req("PATCH", f"/api/checks/{cid}", {"guest_count": 0}, token=tok)
    ok("0 bounces (1..24)", s == 400, f"s={s}")
    # a line sits on seat 2 (it3) — shrinking to 1 must refuse honestly
    s, pshrink = req("PATCH", f"/api/checks/{cid}", {"guest_count": 1}, token=tok)
    ok("shrink below an occupied seat refuses with the re-seat message",
       s == 400 and "seat" in (pshrink.get("error") or ""), f"s={s} {pshrink}")
    s, view = req("GET", f"/api/checks/{cid}", token=tok)
    ok("refused shrink changed nothing", (view.get("check") or view).get("guest_count") == 7)

    print("\n== client harness (REAL extracted functions) ==")
    r = subprocess.run(["node", os.path.join(HERE, "harness40_client.js"),
                        payload_path, app_js, po_js],
                       capture_output=True, text=True, timeout=120)
    print(r.stdout.rstrip())
    if r.stderr.strip():
        print(r.stderr.rstrip()[:1500])
    harness_fail = r.stdout.count("  FAIL ")
    ok("harness40 fully green", r.returncode == 0 and harness_fail == 0,
       f"rc={r.returncode} fails={harness_fail}")
    # count harness oks into the totals
    harness_pass = r.stdout.count("  ok  ")
    globals()["passed"] = passed + harness_pass - 1  # the ok() above already counted 1
    print(f"  (harness assertions passed: {harness_pass})")

    print("\n== source wiring — tappable guest numbers ==")
    src = open(app_js).read()
    ok("#g-val (table-open) wired to tappableValue", "tappableValue($('#g-val'" in src)
    ok("#cs-gc (check settings) wired to tappableValue", "tappableValue($('#cs-gc'" in src)
    ok("header count has its own tappable number span", 'id="hdr-guests-n"' in src
       and "tappableValue(hdrGuestsEl" in src)
    ok("add-modal course select present in source", 'id="m-course"' in src)

    print(f"\n==== test40: {passed} passed, {failed} failed ====")
    if failures:
        print("failures:", "; ".join(failures))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
