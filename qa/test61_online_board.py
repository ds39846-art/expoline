#!/usr/bin/env python3
"""Expoline online-orders staff board — qa/test61_online_board.py.

WHY: the 2026-10-06 live browser pass proved web online ordering
works end-to-end for the GUEST (order.html: cart -> checkout -> place
-> confirmation), but no staff surface consumed the kitchen API:
GET /api/online/orders listed active orders and PATCH walked them
through placed -> confirmed (fires station KDS tickets) -> ready ->
picked_up / cancelled, yet nothing in public/ called those endpoints
except the guest page itself. A placed order was invisible to every
staff screen, could never be confirmed from the UI, and its tickets
never fired. This batch adds the board as a section of the KDS view
(#/kds-online inside renderKds): capability-gated (kitchen_ops —
the endpoints are kitchenPlus), polling on the KDS alerts cadence
(20s — placement broadcasts nothing), with Confirm / Mark ready /
Picked up / Cancel wired through oloBoardPatch.

Sections:
  A  API end-to-end (pre-existing API, driven the way the board
     drives it): place a two-station order -> kitchen list shows it
     placed with the orderView fields -> invalid transition refused
     -> confirm fires one ticket per station with online_order_id
     set (DB-verified) and the ONLINE #<id> label on the KDS feed
     -> ready -> picked_up -> terminal orders leave the list.
  B  cancel paths: placed -> cancelled (no tickets ever fired);
     confirmed -> cancelled (order terminal, leaves the list).
  C  gate: server (no kitchen_ops by default) 403 on list + PATCH,
     anon 401; a roles-matrix grant of kitchen_ops to server flips
     the SAME server token to 200; reset restores 403.
  H  client: harness61_client.js drives the real extracted board
     builders (buttons per status, badge math, empty state,
     includes-tax row, escaping, the exact PATCH call) + source
     pins for the renderKds wiring, the capability gate, the 20s
     poll, and the board CSS.
  Z  discriminating control at 1c25431: the API flow works there
     identically (pre-existing), but the client has NO board —
     app.js lacks the builders, the #kds-online container and the
     list fetch, and harness61 fails extraction against it. The
     board's presence/wiring at HEAD is the discriminating fact.

Ports 4421 (HEAD) / 4422 (control worktree), scratch DBs in /tmp.
Placements are kept under the public rate limit (10/min/IP/process):
3 on HEAD, 1 on the control.
"""
import json, os, signal, sqlite3, subprocess, sys, time, urllib.request, urllib.error
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PORT, CPORT = 4421, 4422
BASE = f"http://127.0.0.1:{PORT}"
CBASE = f"http://127.0.0.1:{CPORT}"
DB = "/tmp/test61_online_board.db"
CDB = "/tmp/test61_online_board_ctrl.db"
WT = "/tmp/wt61_1c25431"
BASE_COMMIT = "1c25431"

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
                         stdout=open(f"/tmp/test61_boot_{port}.log", "a"),
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

def login(pin, base=BASE):
    s, r = req("POST", "/api/auth/login", {"pin": pin}, base=base)
    assert s == 200, (s, r)
    return r["token"]

def src_of(relpath, root=ROOT):
    return (Path(root) / relpath).read_text()

def first_cat(mtok, base=BASE):
    s, adm = req("GET", "/api/admin/menu", token=mtok, base=base)
    assert s == 200, (s, adm)
    cats = adm if isinstance(adm, list) else adm.get("categories", [])
    return [it for c in cats for it in c.get("items", [])][0]["category_id"]

def mk_item(mtok, cat_id, name, price, station, incl=None, base=BASE):
    body = {"name": name, "price_cents": price, "category_id": cat_id,
            "station": station, "course": "entree"}
    if incl is not None:
        body["tax_inclusive"] = incl
    s, r = req("POST", "/api/admin/menu/items", body, token=mtok, base=base)
    assert s == 201, (s, r)
    return r["id"]

def place(items, name, phone, base=BASE):
    return req("POST", "/api/online/orders",
               {"customer_name": name, "phone": phone, "items": items}, base=base)

def db_rows(sql, args=()):
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    try:
        return con.execute(sql, args).fetchall()
    finally:
        con.close()

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
    ctrl = boot(CPORT, CDB, cwd=WT)
    try:
        mtok = login("2580")
        ktok = login("2222")
        stok = login("1111")
        cat = first_cat(mtok)
        it_exp = mk_item(mtok, cat, "QA61 Expediter Plate", 1500, "expediter")
        it_bar = mk_item(mtok, cat, "QA61 Bar Pour", 1200, "bar")
        it_incl = mk_item(mtok, cat, "QA61 Incl Cake", 2000, "expediter", incl=True)

        print("== A. API end-to-end, driven the way the board drives it ==")
        s, o = place([{"menu_item_id": it_exp, "qty": 2},
                      {"menu_item_id": it_bar, "qty": 1},
                      {"menu_item_id": it_incl, "qty": 1}],
                     "Board Flow", "5550161001")
        ok("A place 201 placed", s == 201 and o.get("status") == "placed", f"{s} {str(o)[:120]}")
        oid = o["id"]
        ok("A totals snapshot on the order",
           o.get("subtotal_cents") == 2 * 1500 + 1200 + 2000 and
           o.get("total_cents") == o.get("subtotal_cents") + (o.get("tax_cents", 0) - o.get("tax_included_cents", 0)),
           str({k: o.get(k) for k in ("subtotal_cents", "tax_cents", "tax_included_cents", "total_cents")}))
        ok("A tax_included_cents carried (inclusive line backed out)",
           (o.get("tax_included_cents") or 0) > 0, str(o.get("tax_included_cents")))
        s, lst = req("GET", "/api/online/orders", token=ktok)
        mine = [x for x in lst if x.get("id") == oid] if s == 200 else []
        ok("A kitchen list shows the order placed", s == 200 and len(mine) == 1 and mine[0]["status"] == "placed",
           f"{s} {len(mine)}")
        ok("A list row carries the board fields",
           bool(mine) and mine[0].get("customer_name") == "Board Flow" and
           mine[0].get("phone") == "5550161001" and len(mine[0].get("items", [])) == 3 and
           "pickup_at" in mine[0] and "created_at" in mine[0] and "tax_included_cents" in mine[0])
        s, e = req("PATCH", f"/api/online/orders/{oid}", {"status": "picked_up"}, token=ktok)
        ok("A invalid transition placed->picked_up 400",
           s == 400 and "Cannot move order from placed to picked_up" in str(e.get("error", "")), f"{s} {e}")
        s, r = req("PATCH", f"/api/online/orders/{oid}", {"status": "confirmed"}, token=ktok)
        tickets = r.get("kds_tickets") or []
        ok("A confirm 200 + one ticket per station", s == 200 and len(tickets) == 2, f"{s} {tickets}")
        tids = [t["id"] for t in tickets]
        rows = db_rows(f"SELECT online_order_id, station FROM kds_tickets WHERE id IN ({','.join('?' * len(tids))})", tids) if tids else []
        ok("A tickets carry online_order_id in the DB",
           len(rows) == 2 and all(row[0] == oid for row in rows), str(rows))
        ok("A tickets station-routed", sorted(row[1] for row in rows) == ["bar", "expediter"], str(rows))
        s, feed = req("GET", "/api/kds/tickets?status=all", token=ktok)
        online_feed = [t for t in feed if str(t.get("table_label") or "").startswith(f"ONLINE #{oid}")] if s == 200 else []
        ok("A fired tickets visible on the KDS feed", s == 200 and len(online_feed) == 2, f"{s} {len(online_feed)}")
        s, r = req("PATCH", f"/api/online/orders/{oid}", {"status": "ready"}, token=ktok)
        ok("A confirmed->ready 200", s == 200 and r["order"]["status"] == "ready", f"{s}")
        s, r = req("PATCH", f"/api/online/orders/{oid}", {"status": "picked_up"}, token=ktok)
        ok("A ready->picked_up 200", s == 200 and r["order"]["status"] == "picked_up", f"{s}")
        s, lst = req("GET", "/api/online/orders", token=ktok)
        ok("A picked_up order leaves the active list",
           s == 200 and all(x.get("id") != oid for x in lst), f"{s}")

        print("== B. cancel paths ==")
        s, oc = place([{"menu_item_id": it_exp, "qty": 1}], "Cancel Placed", "5550161002")
        ocid = oc["id"]
        s, r = req("PATCH", f"/api/online/orders/{ocid}", {"status": "cancelled"}, token=ktok)
        ok("B placed->cancelled 200", s == 200 and r["order"]["status"] == "cancelled", f"{s}")
        rows = db_rows("SELECT COUNT(*) FROM kds_tickets WHERE online_order_id = ?", (ocid,))
        ok("B cancelled-from-placed fired no tickets", rows and rows[0][0] == 0, str(rows))
        s, lst = req("GET", "/api/online/orders", token=ktok)
        ok("B cancelled order leaves the active list", s == 200 and all(x.get("id") != ocid for x in lst))
        s, oc2 = place([{"menu_item_id": it_exp, "qty": 1}], "Cancel Confirmed", "5550161003")
        oc2id = oc2["id"]
        s, r = req("PATCH", f"/api/online/orders/{oc2id}", {"status": "confirmed"}, token=ktok)
        ok("B second order confirms", s == 200, f"{s}")
        s, r = req("PATCH", f"/api/online/orders/{oc2id}", {"status": "cancelled"}, token=ktok)
        ok("B confirmed->cancelled 200", s == 200 and r["order"]["status"] == "cancelled", f"{s}")
        s, one = req("GET", f"/api/online/orders/{oc2id}", token=ktok)
        ok("B cancelled order reads back terminal", s == 200 and one.get("status") == "cancelled", f"{s}")
        s, lst = req("GET", "/api/online/orders", token=ktok)
        ok("B confirmed-cancel leaves the active list", s == 200 and all(x.get("id") != oc2id for x in lst))

        print("== C. capability gate + matrix grant flip ==")
        s, _ = req("GET", "/api/online/orders", token=stok)
        ok("C server list 403 (no kitchen_ops by default)", s == 403, str(s))
        s, _ = req("PATCH", f"/api/online/orders/{oid}", {"status": "confirmed"}, token=stok)
        ok("C server PATCH 403", s == 403, str(s))
        s, _ = req("GET", "/api/online/orders")
        ok("C anon list 401", s == 401, str(s))
        s, r = req("PUT", "/api/admin/permissions",
                   {"matrix": {"server": ["floor_ops", "menu_86", "kitchen_ops"]}}, token=mtok)
        ok("C grant kitchen_ops to server 200", s == 200, f"{s} {str(r)[:100]}")
        s, _ = req("GET", "/api/online/orders", token=stok)
        ok("C granted server list flips to 200 (same token)", s == 200, str(s))
        s, r = req("PUT", "/api/admin/permissions", {"reset": True}, token=mtok)
        ok("C matrix reset 200", s == 200, f"{s}")
        s, _ = req("GET", "/api/online/orders", token=stok)
        ok("C reset restores server 403", s == 403, str(s))

        print("== H. client board: harness + wiring pins ==")
        h = subprocess.run(["node", str(ROOT / "qa" / "harness61_client.js")],
                           capture_output=True, text=True, cwd=ROOT)
        res = {}
        for line in h.stdout.splitlines():
            if line.startswith("@@RESULT@@"):
                res = json.loads(line[len("@@RESULT@@"):])
        ok("H harness61 exit 0", h.returncode == 0, (h.stdout + h.stderr)[-400:])
        ok("H harness61 all assertions true",
           len(res) >= 20 and all(res.values()), str({k: v for k, v in res.items() if not v}))
        appjs = src_of("public/app.js")
        ok("H board container lives in the KDS view", 'id="kds-online"' in appjs)
        ok("H board gated on kitchen_ops", "const canOnline = roleHasCap(state.user, 'kitchen_ops')" in appjs)
        ok("H board polls on the alerts cadence", "setInterval(loadOnlineOrders, 20000)" in appjs)
        ok("H board fetches the kitchen list", "api('/api/online/orders')" in appjs)
        ok("H board timers cleaned up with the KDS",
           "clearInterval(state.timers.online)" in appjs and "clearInterval(state.timers.onlineAge)" in appjs)
        css = src_of("public/styles.css")
        ok("H board styles present", ".olo-card" in css and ".olo-newpill" in css and ".olo-empty" in css)

        print("== Z. control at 1c25431: API pre-existing, board absent ==")
        cktok = login("2222", base=CBASE)
        cmtok = login("2580", base=CBASE)
        ccat = first_cat(cmtok, base=CBASE)
        cit = mk_item(cmtok, ccat, "QA61 Ctrl Plate", 1500, "expediter", base=CBASE)
        s, co = place([{"menu_item_id": cit, "qty": 1}], "Ctrl Flow", "5550161009", base=CBASE)
        ok("Z control place 201", s == 201, f"{s}")
        s, r = req("PATCH", f"/api/online/orders/{co['id']}", {"status": "confirmed"}, token=cktok, base=CBASE)
        ok("Z control confirm works (API pre-existing)",
           s == 200 and len(r.get("kds_tickets") or []) == 1, f"{s} {str(r)[:120]}")
        capp = src_of("public/app.js", root=WT)
        ok("Z control app.js has NO board builders", "oloBoardHtml" not in capp and "oloBoardPatch" not in capp)
        ok("Z control app.js has NO board container or fetch",
           'id="kds-online"' not in capp and "api('/api/online/orders')" not in capp)
        h2 = subprocess.run(["node", str(ROOT / "qa" / "harness61_client.js"), str(Path(WT) / "public" / "app.js")],
                            capture_output=True, text=True, cwd=ROOT)
        ok("Z harness61 fails against the control client", h2.returncode != 0, f"rc={h2.returncode}")

    finally:
        stop(srv)
        stop(ctrl)
        subprocess.run(["git", "worktree", "remove", "--force", WT], cwd=ROOT,
                       capture_output=True)
        try:
            os.unlink(Path(WT) / "node_modules")
        except Exception:
            pass

    print(f"\ntest61_online_board: {passed} passed, {failed} failed")
    if failures:
        print("FAILED:", failures)
    sys.exit(1 if failed else 0)

if __name__ == "__main__":
    main()
