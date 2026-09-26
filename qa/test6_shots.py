#!/usr/bin/env python3
"""Expoline QA Test 6: screenshots via headless playwright chromium."""
import json, sys, urllib.request, urllib.error
import os
from playwright.sync_api import sync_playwright

BASE = os.environ.get("EXPOLINE_BASE", os.environ.get("EXPLOINE_BASE", "http://localhost:4317"))
OUT = "qa/screenshots"

def api(method, path, token=None, body=None):
    req = urllib.request.Request(BASE+path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type":"application/json"})
    if token: req.add_header("Authorization", "Bearer "+token)
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read().decode() or "{}")

def login(pin):
    return api("POST","/api/auth/login",None,{"pin":pin})

ST = login("1111"); KT = login("2222"); MT = login("2580")

# --- stage live demo data: open check with items across stations, sent to KDS ---
zones = api("GET","/api/zones",ST["token"])
tbl = next(t for z in zones for t in z["tables"] if not t["open_check_id"])["id"]
chk = api("POST","/api/checks",ST["token"],{"table_id":tbl,"guest_count":4,"tab_name":"QA visuals"})
cid = chk["id"]
api("POST",f"/api/checks/{cid}/items",ST["token"],{"menu_item_id":69,"seat":1,"qty":2,"modifiers":[]})          # BH Mai Tai bar
api("POST",f"/api/checks/{cid}/items",ST["token"],{"menu_item_id":14,"seat":1,"qty":1,"modifiers":[{"name":"Add bacon","price_delta_cents":300}]})
api("POST",f"/api/checks/{cid}/items",ST["token"],{"menu_item_id":7,"seat":2,"qty":1,"modifiers":[{"name":"Add chicken","price_delta_cents":900}]})
api("POST",f"/api/checks/{cid}/items",ST["token"],{"menu_item_id":55,"seat":3,"qty":1,"modifiers":[]})          # dessert
api("POST",f"/api/checks/{cid}/send",ST["token"])
print("staged check", cid, "on table", tbl)

def goto(page, h):
    """Hash navigation inside the SPA (same-document): set hash, wait for render.
    h like '/#/order/19' -> location.hash becomes '#/order/19'."""
    frag = h[h.index("#"):] if "#" in h else h
    page.evaluate("f=>{location.hash=f}", frag)
    page.wait_for_timeout(1400)

def session_inject(page, sess):
    page.goto(BASE + "/#/login", wait_until="networkidle")
    page.evaluate("s=>{sessionStorage.setItem('expoline.token',s.token);sessionStorage.setItem('expoline.user',JSON.stringify(s.user))}", sess)
    page.reload(wait_until="networkidle")  # re-run init() with the session present
    page.wait_for_timeout(800)

shots = []
def snap(page, name, url=None):
    if url: goto(page, url)
    else: page.wait_for_timeout(1200)
    p = f"{OUT}/{name}"
    page.screenshot(path=p, full_page=False)
    shots.append(p); print("saved", p, page.url)

with sync_playwright() as pw:
    b = pw.chromium.launch(executable_path="/home/hatch/.cache/ms-playwright/chromium-1243/chrome-linux/chrome",
                           args=["--no-sandbox"])
    pg = b.new_page(viewport={"width":1366,"height":800})
    pg.goto(BASE + "/#/login", wait_until="networkidle")  # real document load first
    pg.wait_for_selector(".role-chip", timeout=15000)

    # 1. login screen, unauthenticated
    snap(pg, "01-login.png", "/#/login")

    # 2. drive the PIN pad for real (server 1111): click role chip, digits, log in
    pg.click('.role-chip[data-role="server"]')
    for d in "1111": pg.click(f'.pin-key[data-k="{d}"]')
    pg.click("#login-go")
    pg.wait_for_timeout(1500)
    ok_login = "#/floor" in pg.url
    print("PIN-pad login ->", pg.url, "OK" if ok_login else "FAILED")
    snap(pg, "02-floor-server.png")

    # zone tabs on floor (click a second zone tab if present)
    tabs = pg.query_selector_all(".zone-tab, .tab[data-zone]")
    print("zone tab candidates:", len(tabs))
    if tabs and len(tabs) > 1:
        tabs[1].click(); pg.wait_for_timeout(800)
        snap(pg, "02b-floor-zone2.png")

    # 3. order view with items
    snap(pg, "03-order.png", f"/#/order/{cid}")
    # 4. pay view
    snap(pg, "04-pay.png", f"/#/pay/{cid}")

    # 5. KDS per station as kitchen user (click in-app station tabs)
    ctx = b.new_context(viewport={"width":1366,"height":800})
    kp = ctx.new_page()
    session_inject(kp, KT)
    goto(kp, "#/kds")
    kp.wait_for_selector("#kds-tabs .tab")
    for st in ["Bar","Expediter","Garde Manger","Dessert"]:
        kp.click(f'#kds-tabs .tab[data-st="{st}"]')
        kp.wait_for_timeout(1200)
        p = f"{OUT}/05-kds-{st.lower().replace(' ','_')}.png"
        kp.screenshot(path=p, full_page=False)
        shots.append(p); print("saved", p)
    kp.close()

    # 6. manager views
    ctx2 = b.new_context(viewport={"width":1366,"height":800})
    mp = ctx2.new_page()
    session_inject(mp, MT)
    snap(mp, "06-floor-manager.png", "/#/floor")
    snap(mp, "07-manager-overview.png", "/#/manager")
    snap(mp, "08-finance-payouts.png", "/#/manager/finance")
    snap(mp, "09-shift-report.png", "/#/manager/shift")
    mp.close(); ctx.close(); ctx2.close(); b.close()

print(f"\n{len(shots)} screenshots, PIN-pad login {'OK' if ok_login else 'FAILED'}")
sys.exit(0 if ok_login else 1)
