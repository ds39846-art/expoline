#!/usr/bin/env python3
"""test20_lan_brain.py — LAN site brain: election, sync, failover, convergence.

Spins up two Expoline nodes from THIS repo tree (default ports 4324 + 4337,
override with LAN_QA_PORT_A / LAN_QA_PORT_B):
    A: priority 0, device brain-qa      (expected brain)
    B: priority 10, device tablet-qa   (expected standby)

Covers: election, op sync + gossip convergence, idempotent replay,
menu/check/KDS convergence, LWW table_state, site isolation, manager gates,
brain kill mid-flush (zero lost / zero duplicated orders), re-election,
offline-outbox drain on reconnect, rejoin merge, and the default-OFF guard
(/api/sync/* must not exist without EXPOLINE_LAN=1).

Usage:  python3 qa/test20_lan_brain.py
Exit 0 = all assertions passed.
"""
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time

import requests

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT_A = int(os.environ.get("LAN_QA_PORT_A", "4324"))
PORT_B = int(os.environ.get("LAN_QA_PORT_B", "4337"))
PORT_C = int(os.environ.get("LAN_QA_PORT_C", "4344"))  # default-OFF guard node
SITE = "bali-hai"
PIN_SERVER = "1111"
PIN_MGR = "2580"
GOSSIP_PIN = "1111"

PASS = 0
FAIL = 0
FAILURES = []


def check(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ok   {name}")
    else:
        FAIL += 1
        FAILURES.append(name)
        print(f"  FAIL {name} {detail}")


def wait_until(fn, timeout, interval=0.5, desc=""):
    """Poll fn() until truthy; return last value (or None on timeout)."""
    end = time.time() + timeout
    last = None
    while time.time() < end:
        try:
            last = fn()
        except Exception:
            last = None
        if last:
            return last
        time.sleep(interval)
    return last


# ---------------------------------------------------------------- processes

def seed_db(path):
    env = dict(os.environ, EXPOLINE_DB=path)
    r = subprocess.run(["node", "db/seed.js"], cwd=REPO, env=env,
                       capture_output=True, text=True, timeout=120)
    if r.returncode != 0:
        raise RuntimeError(f"seed failed for {path}: {r.stderr[-2000:]}")


def start_node(port, db_path, priority, device, peer_port, lan=True):
    env = dict(os.environ,
               EXPOLINE_PORT=str(port),
               EXPOLINE_DB=db_path,
               EXPOLINE_BRAIN_PRIORITY=str(priority),
               EXPOLINE_DEVICE_ID=device,
               EXPOLINE_LAN_PEERS=f"127.0.0.1:{peer_port}")
    if lan:
        env["EXPOLINE_LAN"] = "1"
        env["EXPOLINE_LAN_GOSSIP_PIN"] = GOSSIP_PIN
    else:
        env.pop("EXPOLINE_LAN", None)
    logf = open(os.path.join(tempfile.gettempdir(), f"test20-{port}.log"), "ab")
    proc = subprocess.Popen(["node", "server.js"], cwd=REPO, env=env,
                            stdout=logf, stderr=subprocess.STDOUT)
    ok = wait_until(lambda: _health(port), 25, 0.5)
    if not ok:
        stop_node(proc)
        raise RuntimeError(f"node on {port} did not come up")
    return proc


def _health(port):
    try:
        r = requests.get(f"http://localhost:{port}/api/health", timeout=2)
        return r.status_code == 200
    except Exception:
        return False


def stop_node(proc):
    try:
        proc.terminate()
        proc.wait(timeout=8)
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass


def kill9(proc):
    try:
        proc.send_signal(signal.SIGKILL)
        proc.wait(timeout=8)
    except Exception:
        pass


# ------------------------------------------------------------------- client

def login(port, pin):
    r = requests.post(f"http://localhost:{port}/api/auth/login",
                      json={"pin": pin}, timeout=5)
    r.raise_for_status()
    return r.json()["token"]


def api(port, method, path, token=None, body=None, timeout=10):
    headers = {}
    if token:
        headers["Authorization"] = "Bearer " + token
    r = requests.request(method, f"http://localhost:{port}{path}",
                         headers=headers, json=body, timeout=timeout)
    try:
        data = r.json()
    except Exception:
        data = None
    return r.status_code, data


_lamport = [0]


def env_op(op_id, op, payload, device="qa20", seq=None):
    _lamport[0] += 1
    return {
        "op_id": op_id, "site_slug": SITE, "device_id": device,
        "seq": seq if seq is not None else _lamport[0],
        "lamport": _lamport[0], "op": op, "payload": payload,
        "created_at": "2026-09-26T15:00:00.000Z",
    }


def brain_status(port):
    try:
        r = requests.get(f"http://localhost:{port}/api/brain/status", timeout=3)
        return r.json()
    except Exception:
        return None


def wait_brain_on(port, device, timeout=25):
    """Wait until the given (sole surviving) node reports itself brain."""
    def cond():
        s = brain_status(port)
        if s and s.get("is_brain") and s.get("brain_device_id") == device:
            return s
        return None
    return wait_until(cond, timeout, 0.5)


def wait_election(a_is_brain, timeout=25):
    """Wait until exactly one node is brain (and it is the expected one)."""
    def cond():
        sa, sb = brain_status(PORT_A), brain_status(PORT_B)
        if not sa or not sb:
            return None
        ia, ib = sa.get("is_brain"), sb.get("is_brain")
        if ia == a_is_brain and ib == (not a_is_brain) and ia != ib:
            if sa.get("brain_device_id") == sb.get("brain_device_id"):
                return (sa, sb)
        return None
    return wait_until(cond, timeout, 0.5)


def wait_converged(tok_a, tok_b, timeout=30):
    def cond():
        sa = api(PORT_A, "GET", "/api/sync/status", tok_a)[1]
        sb = api(PORT_B, "GET", "/api/sync/status", tok_b)[1]
        if sa and sb and sa.get("op_log_length") == sb.get("op_log_length"):
            return (sa, sb)
        return None
    return wait_until(cond, timeout, 0.5)


def wait_opids_equal(tok_a, tok_b, timeout=30):
    def cond():
        _, da = api(PORT_A, "GET", "/api/sync/opids", tok_a)
        _, db_ = api(PORT_B, "GET", "/api/sync/opids", tok_b)
        if da and db_ and set(da["op_ids"]) == set(db_["op_ids"]) and da["op_ids"]:
            return (da, db_)
        return None
    return wait_until(cond, timeout, 1.0)


def open_checks(port, token):
    _, data = api(port, "GET", "/api/checks/open", token)
    return data if isinstance(data, list) else []


# ===========================================================================
def main():
    global PASS, FAIL
    tmp = tempfile.mkdtemp(prefix="test20-lan-")
    db_a = os.path.join(tmp, "a.db")
    db_b = os.path.join(tmp, "b.db")
    print(f"seeding DBs in {tmp}")
    seed_db(db_a)
    seed_db(db_b)

    procs = []
    try:
        print("starting nodes A (brain-qa, prio 0) and B (tablet-qa, prio 10)")
        pa = start_node(PORT_A, db_a, 0, "brain-qa", PORT_B)
        pb = start_node(PORT_B, db_b, 10, "tablet-qa", PORT_A)
        procs += [pa, pb]
        tok_a = login(PORT_A, PIN_SERVER)
        tok_b = login(PORT_B, PIN_SERVER)
        mgr_a = login(PORT_A, PIN_MGR)

        # ---- T1 election ------------------------------------------------
        print("T1 election")
        st = wait_election(a_is_brain=True, timeout=25)
        check("exactly one brain, and it is brain-qa (prio 0)", st is not None,
              f"got {st}")
        if st:
            check("both nodes agree on brain_device_id",
                  st[0]["brain_device_id"] == "brain-qa" and
                  st[1]["brain_device_id"] == "brain-qa")

        # ---- T2 sync batch on brain: open + items + send ---------------
        print("T2 sync batch on brain")
        ops2 = [
            env_op("qa20-t2-open", "open_check",
                   {"check_uuid": "tmp-qa20-c1", "table_id": 42,
                    "guest_count": 2, "server_id": 1}),
            env_op("qa20-t2-add", "add_items",
                   {"check_uuid": "tmp-qa20-c1",
                    "items": [{"item_uuid": "tmp-qa20-i1", "seat": 1,
                               "menu_item_id": 1, "qty": 2}]}),
            env_op("qa20-t2-send", "send", {"check_uuid": "tmp-qa20-c1"}),
        ]
        sc, batch2 = api(PORT_A, "POST", "/api/sync/batch", tok_a,
                         {"ops": ops2})
        check("batch accepted (HTTP 200)", sc == 200, f"HTTP {sc}")
        res2 = {r["op_id"]: r for r in (batch2.get("results") or [])}
        check("open_check ok", res2.get("qa20-t2-open", {}).get("ok") is True,
              str(res2.get("qa20-t2-open")))
        check("add_items ok", res2.get("qa20-t2-add", {}).get("ok") is True,
              str(res2.get("qa20-t2-add")))
        check("send ok", res2.get("qa20-t2-send", {}).get("ok") is True,
              str(res2.get("qa20-t2-send")))
        check_id = res2["qa20-t2-open"].get("check_id")
        # money math: pick the menu item price from /api/menu
        _, menu = api(PORT_A, "GET", "/api/menu", tok_a)
        mi = None
        for cat in (menu or []):
            for it in cat.get("items", []):
                if it.get("id") == 1:
                    mi = it
        check("menu item 1 found on brain", mi is not None)
        _, cdetail = api(PORT_A, "GET", f"/api/checks/{check_id}", tok_a)
        items = cdetail.get("items", [])
        check("brain check has exactly 1 item row", len(items) == 1,
              str(len(items)))
        check("brain check qty is 2", items and items[0].get("qty") == 2)
        if mi and items:
            check("brain subtotal = 2 x unit price",
                  cdetail.get("subtotal_cents") == 2 * mi["price_cents"],
                  f"subtotal={cdetail.get('subtotal_cents')} price={mi['price_cents']}")
        # KDS ticket created by send
        _, kds = api(PORT_A, "GET", "/api/kds/tickets?status=all", mgr_a)
        tk = [t for t in (kds if isinstance(kds, list) else [])
              if t.get("check_id") == check_id]
        check("KDS ticket exists for the sent check", len(tk) >= 1,
              f"tickets={len(tk) if isinstance(kds, list) else kds}")

        # ---- T3 gossip convergence --------------------------------------
        print("T3 gossip convergence brain -> standby")
        conv = wait_converged(tok_a, tok_b, timeout=30)
        check("standby op_log_length converges to brain's",
              conv is not None and
              conv[1]["op_log_length"] == conv[0]["op_log_length"] == 3,
              str(conv[1]["op_log_length"] if conv else None))
        bchecks = [c for c in open_checks(PORT_B, tok_b)
                   if c.get("table_id") == 42]
        check("standby shows the table-42 check", len(bchecks) == 1,
              f"found {len(bchecks)}")
        if bchecks:
            check("standby check has 1 item row",
                  bchecks[0].get("item_count") == 1,
                  str(bchecks[0].get("item_count")))
            # money math converges: standby total == brain total for the
            # same check (total includes tax/fees — compare node to node)
            achecks42 = [c for c in open_checks(PORT_A, tok_a)
                         if c.get("table_id") == 42]
            check("standby check total matches brain check total",
                  bool(achecks42) and
                  bchecks[0].get("total_cents") == achecks42[0].get("total_cents"),
                  f"standby={bchecks[0].get('total_cents')} brain={achecks42[0].get('total_cents') if achecks42 else None}")

        # ---- T4 idempotent replay ---------------------------------------
        print("T4 idempotent replay")
        sc, batch4 = api(PORT_A, "POST", "/api/sync/batch", tok_a,
                         {"ops": ops2})
        res4 = {r["op_id"]: r for r in (batch4.get("results") or [])}
        check("replayed batch: all results replayed:true",
              all(r.get("replayed") is True and r.get("ok") is True
                  for r in res4.values()) and len(res4) == 3,
              str(res4))
        _, cdetail2 = api(PORT_A, "GET", f"/api/checks/{check_id}", tok_a)
        check("no duplicate items after replay",
              len(cdetail2.get("items", [])) == 1)

        # ---- T5 menu_update converges -----------------------------------
        print("T5 menu_update")
        new_price = (mi["price_cents"] if mi else 100) + 50
        ops5 = [env_op("qa20-t5-menu", "menu_update",
                       {"item_id": 1, "version": 2,
                        "price_cents": new_price})]
        sc, batch5 = api(PORT_A, "POST", "/api/sync/batch", mgr_a,
                         {"ops": ops5})
        r5 = (batch5.get("results") or [{}])[0]
        check("menu_update ok at version 2", r5.get("ok") is True and
              r5.get("version") == 2, str(r5))

        def standby_menu_price():
            _, m = api(PORT_B, "GET", "/api/menu", tok_b)
            for cat in (m or []):
                for it in cat.get("items", []):
                    if it.get("id") == 1:
                        return it.get("price_cents")
            return None
        got = wait_until(lambda: standby_menu_price() == new_price, 30, 1.0)
        check("standby menu converges to new price", bool(got),
              f"standby price={standby_menu_price()} expected={new_price}")
        # stale version rejected
        sc, batch5s = api(PORT_A, "POST", "/api/sync/batch", mgr_a,
                          {"ops": [env_op("qa20-t5-stale", "menu_update",
                                          {"item_id": 1, "version": 2,
                                           "price_cents": new_price + 1})]})
        r5s = (batch5s.get("results") or [{}])[0]
        check("stale menu_update rejected with conflict",
              r5s.get("conflict") is True and
              r5s.get("current_version") == 2, str(r5s))

        # ---- T6 table_state LWW -----------------------------------------
        print("T6 table_state last-writer-wins")
        ops6 = [
            env_op("qa20-t6-lo", "table_state",
                   {"table_id": 46, "state": "dirty"}),
            env_op("qa20-t6-hi", "table_state",
                   {"table_id": 46, "state": "clean"}),
        ]
        # force the LOWER lamport onto the second-listed op: swap lamports
        ops6[0]["lamport"], ops6[1]["lamport"] = 910, 950
        ops6[0]["seq"], ops6[1]["seq"] = 910, 950
        sc, batch6 = api(PORT_A, "POST", "/api/sync/batch", tok_a,
                         {"ops": ops6})
        r6 = {r["op_id"]: r for r in (batch6.get("results") or [])}
        check("higher-lamport table_state applied",
              r6.get("qa20-t6-hi", {}).get("applied") is True,
              str(r6.get("qa20-t6-hi")))
        # a LOWER lamport afterwards loses
        lo2 = env_op("qa20-t6-lo2", "table_state",
                     {"table_id": 46, "state": "dirty"})
        lo2["lamport"] = 920
        sc, batch6b = api(PORT_A, "POST", "/api/sync/batch", tok_a,
                          {"ops": [lo2]})
        r6b = (batch6b.get("results") or [{}])[0]
        check("lower-lamport table_state loses (conflict)",
              r6b.get("applied") is False and r6b.get("conflict") is True,
              str(r6b))
        # final state in the log is the winner
        _, logd = api(PORT_A, "GET", "/api/sync/log?since=0", tok_a)
        states = [e["payload"]["state"] for e in (logd.get("envelopes") or [])
                  if e.get("op") == "table_state"
                  and e.get("payload", {}).get("table_id") == 46]
        check("log shows clean as the final table-46 state",
              states and states[-1] == "clean", str(states))

        # ---- T7 site isolation ------------------------------------------
        print("T7 site isolation")
        _, st0 = api(PORT_A, "GET", "/api/sync/status", tok_a)
        n0 = st0["op_log_length"]
        bad = env_op("qa20-t7-bad", "open_check",
                     {"check_uuid": "tmp-qa20-evil", "table_id": 47,
                      "guest_count": 1})
        bad["site_slug"] = "wrong-site"
        sc, data7 = api(PORT_A, "POST", "/api/sync/batch", tok_a,
                        {"ops": [bad]})
        check("foreign site_slug rejected (HTTP 400)",
              sc == 400 and (data7 or {}).get("error") == "site_mismatch",
              f"HTTP {sc} {data7}")
        _, st1 = api(PORT_A, "GET", "/api/sync/status", tok_a)
        check("rejected op not appended to the log",
              st1["op_log_length"] == n0)

        # ---- T8 void manager gates --------------------------------------
        print("T8 void manager gates")
        vbase = {"check_uuid": "tmp-qa20-c1", "item_uuid": "tmp-qa20-i1",
                 "reason": "qa"}
        sc, bv = api(PORT_A, "POST", "/api/sync/batch", tok_a, {"ops": [
            env_op("qa20-t8-nopin", "void_item", dict(vbase))]})
        rv = (bv.get("results") or [{}])[0]
        check("void without manager approval rejected",
              rv.get("ok") is False and
              rv.get("error") in ("manager_pin_required",
                                  "manager_pin_invalid",
                                  "manager_role_required"),
              str(rv))
        vp = dict(vbase, manager_pin=PIN_MGR)
        sc, bv2 = api(PORT_A, "POST", "/api/sync/batch", tok_a, {"ops": [
            env_op("qa20-t8-pin", "void_item", vp)]})
        rv2 = (bv2.get("results") or [{}])[0]
        check("void with manager PIN ok", rv2.get("ok") is True, str(rv2))
        # the stored envelope must not contain the raw PIN (DESIGN.md §11)
        _, logv = api(PORT_A, "GET", "/api/sync/log?since=0", tok_a)
        venv = [e for e in (logv.get("envelopes") or [])
                if e.get("op_id") == "qa20-t8-pin"]
        check("no raw manager_pin in the stored op log",
              bool(venv) and "manager_pin" not in
              json.dumps(venv[0].get("payload", {})),
              str(venv[0].get("payload") if venv else None))
        sc, bv3 = api(PORT_A, "POST", "/api/sync/batch", tok_a, {"ops": [
            env_op("qa20-t8-pin", "void_item", vp)]})
        rv3 = (bv3.get("results") or [{}])[0]
        check("void replay is idempotent (ok, replayed)",
              rv3.get("ok") is True and rv3.get("replayed") is True,
              str(rv3))

        # ---- T9 kill brain mid-flush: zero lost, zero duplicated ---------
        print("T9 kill brain mid-flush")
        ops9 = [
            env_op("qa20-t9-open", "open_check",
                   {"check_uuid": "tmp-qa20-c9", "table_id": 44,
                    "guest_count": 3, "server_id": 1}),
            env_op("qa20-t9-add", "add_items",
                   {"check_uuid": "tmp-qa20-c9",
                    "items": [{"item_uuid": "tmp-qa20-i9", "seat": 1,
                               "menu_item_id": 1, "qty": 1}]}),
        ]
        flight = {}

        def _post_in_flight():
            try:
                s, d = api(PORT_A, "POST", "/api/sync/batch", tok_a,
                           {"ops": ops9}, timeout=15)
                flight["done"] = (s, d)
            except Exception as e:  # brain died mid-request: expected
                flight["error"] = repr(e)

        th = threading.Thread(target=_post_in_flight, daemon=True)
        th.start()
        time.sleep(0.08)  # let the request get in flight, then kill -9
        kill9(pa)
        th.join(timeout=20)
        procs.remove(pa)
        print(f"  info in-flight result: "
              f"{'HTTP ' + str(flight.get('done', [None])[0]) if 'done' in flight else flight.get('error')}")
        # NOTE: node A is dead, so poll only the survivor (wait_election
        # needs both nodes alive).
        st9 = wait_brain_on(PORT_B, "tablet-qa", timeout=25)
        check("survivor re-elected as the only brain", st9 is not None,
              f"got {st9.get('brain_device_id') if st9 else None}")
        # re-flush the same batch to the new brain (tablet-qa)
        tok_b = login(PORT_B, PIN_SERVER)  # refresh (tokens are node-local)
        sc, batch9 = api(PORT_B, "POST", "/api/sync/batch", tok_b,
                         {"ops": ops9})
        res9 = {r["op_id"]: r for r in (batch9.get("results") or [])}
        check("re-flush after failover: all ops ok (fresh or replayed)",
              all(r.get("ok") is True for r in res9.values())
              and len(res9) == 2, str(res9))
        b9checks = [c for c in open_checks(PORT_B, tok_b)
                    if c.get("table_id") == 44]
        check("mid-flush check survived on the new brain",
              len(b9checks) == 1, f"found {len(b9checks)}")
        if b9checks:
            check("exactly-once: 1 item row on the check (no dupes)",
                  b9checks[0].get("item_count") == 1,
                  str(b9checks[0].get("item_count")))
            # note: menu item 1 was repriced in T5, so use the new price;
            # subtotal_cents is pre-tax — compare against the unit price.
            cid9 = res9.get("qa20-t9-open", {}).get("check_id")
            _, cdet9 = api(PORT_B, "GET", f"/api/checks/{cid9}", tok_b)
            check("exactly-once: subtotal = 1 x current unit price",
                  (cdet9 or {}).get("subtotal_cents") == new_price,
                  f"subtotal={(cdet9 or {}).get('subtotal_cents')} price={new_price}")
        # While A is dead, take a NEW order on the survivor. These ops have
        # never existed on A — they prove the gossip PUSH path on rejoin.
        ops9b = [
            env_op("qa20-t9b-open", "open_check",
                   {"check_uuid": "tmp-qa20-c9b", "table_id": 48,
                    "guest_count": 2, "server_id": 1}),
            env_op("qa20-t9b-add", "add_items",
                   {"check_uuid": "tmp-qa20-c9b",
                    "items": [{"item_uuid": "tmp-qa20-i9b", "seat": 1,
                               "menu_item_id": 1, "qty": 1}]}),
        ]
        sc, batch9b = api(PORT_B, "POST", "/api/sync/batch", tok_b,
                          {"ops": ops9b})
        res9b = {r["op_id"]: r for r in (batch9b.get("results") or [])}
        check("survivor takes new orders while old brain is dead",
              all(r.get("ok") is True for r in res9b.values())
              and len(res9b) == 2, str(res9b))

        # ---- T10 old brain rejoins: bidirectional merge -----------------
        print("T10 rejoin + bidirectional merge")
        pa2 = start_node(PORT_A, db_a, 0, "brain-qa", PORT_B)
        procs.append(pa2)
        tok_a = login(PORT_A, PIN_SERVER)
        st10 = wait_election(a_is_brain=True, timeout=25)
        check("priority-0 node re-elected on rejoin (exactly one brain)",
              st10 is not None, f"got {st10}")
        eq = wait_opids_equal(tok_a, tok_b, timeout=30)
        check("op_id sets converge on both nodes after rejoin",
              eq is not None)
        _, opids_a = api(PORT_A, "GET", "/api/sync/opids", tok_a)
        ids_a = set((opids_a or {}).get("op_ids", []))
        have9 = {"qa20-t9b-open", "qa20-t9b-add"}.issubset(ids_a)
        check("rejoined brain merged the failover-window ops (push path)",
              have9, f"A has {len(ids_a)} ops")
        have_t2 = {"qa20-t2-open", "qa20-t2-add", "qa20-t2-send"}.issubset(ids_a)
        check("rejoined brain kept all pre-failover ops (pull path)",
              have_t2)
        achecks = [c for c in open_checks(PORT_A, tok_a)
                   if c.get("table_id") == 42]
        check("pre-failover check (table 42) still on rejoined brain",
              len(achecks) == 1)

        # ---- T11 offline outbox drains on reconnect ---------------------
        print("T11 offline outbox drain")
        outbox = [
            env_op("qa20-t11-open", "open_check",
                   {"check_uuid": "tmp-qa20-c11", "table_id": 45,
                    "guest_count": 2, "server_id": 1}, device="offline-tab"),
            env_op("qa20-t11-add", "add_items",
                   {"check_uuid": "tmp-qa20-c11",
                    "items": [{"item_uuid": "tmp-qa20-i11", "seat": 1,
                               "menu_item_id": 1, "qty": 1}]},
                   device="offline-tab"),
        ]
        pre = [c for c in open_checks(PORT_A, tok_a)
               if c.get("table_id") == 45]
        check("check not on brain while device offline", len(pre) == 0)
        # reconnect: flush the queued outbox to the current brain
        sc, batch11 = api(PORT_A, "POST", "/api/sync/batch", tok_a,
                          {"ops": outbox})
        res11 = {r["op_id"]: r for r in (batch11.get("results") or [])}
        check("offline outbox flushes cleanly on reconnect",
              all(r.get("ok") is True for r in res11.values())
              and len(res11) == 2, str(res11))
        outbox = [o for o in outbox if not res11.get(o["op_id"], {}).get("ok")]
        check("outbox drains to empty after flush", len(outbox) == 0)
        post = [c for c in open_checks(PORT_A, tok_a)
                if c.get("table_id") == 45]
        check("offline-created check present after drain", len(post) == 1)

        # ---- T12 default-OFF guard --------------------------------------
        print("T12 default-OFF guard (no EXPOLINE_LAN)")
        db_c = os.path.join(tmp, "c.db")
        seed_db(db_c)
        pc = start_node(PORT_C, db_c, 0, "lonely", PORT_A, lan=False)
        procs.append(pc)
        _, cfgc = api(PORT_C, "GET", "/api/config")
        check("/api/config shows lan_sync falsy when flag off",
              not (cfgc or {}).get("lan_sync"), str((cfgc or {}).get("lan_sync")))
        tok_c = login(PORT_C, PIN_SERVER)
        sc, _ = api(PORT_C, "POST", "/api/sync/batch", tok_c, {"ops": []})
        check("/api/sync/batch is 404 when LAN disabled", sc == 404,
              f"HTTP {sc}")
        try:
            bc = requests.get(f"http://localhost:{PORT_C}/api/brain/status",
                              timeout=3).json()
            check("/api/brain/status reports lan disabled",
                  bc.get("lan", {}).get("lan_enabled") is False,
                  str(bc.get("lan")))
        except Exception as e:
            check("/api/brain/status reports lan disabled", False, repr(e))

    finally:
        for p in list(procs):
            stop_node(p)
        shutil.rmtree(tmp, ignore_errors=True)

    print(f"\ntest20: {PASS} passed, {FAIL} failed")
    if FAILURES:
        print("failures:", FAILURES)
    sys.exit(1 if FAIL else 0)


if __name__ == "__main__":
    main()
