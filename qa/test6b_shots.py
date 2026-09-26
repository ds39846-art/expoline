#!/usr/bin/env python3
"""Expoline QA round-2: KDS tabs (slug data-st), manager views incl. seeded-date variants."""
import json, urllib.request
from playwright.sync_api import sync_playwright

BASE = "http://localhost:4317"
OUT = "qa/screenshots"

def api(method, path, token=None, body=None):
    req = urllib.request.Request(BASE+path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type":"application/json"})
    if token: req.add_header("Authorization", "Bearer "+token)
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read().decode() or "{}")

def login(pin): return api("POST","/api/auth/login",None,{"pin":pin})
KT = login("2222"); MT = login("2580")

def goto(page, frag):
    page.evaluate("f=>{location.hash=f}", frag)
    page.wait_for_timeout(1400)

def session_inject(page, sess):
    page.goto(BASE + "/#/login", wait_until="networkidle")
    page.evaluate("s=>{sessionStorage.setItem('expoline.token',s.token);sessionStorage.setItem('expoline.user',JSON.stringify(s.user))}", sess)
    page.reload(wait_until="networkidle")
    page.wait_for_timeout(800)

def toast_check(page, where):
    t = page.evaluate("()=>{const els=[...document.querySelectorAll('.toast,.toast-error,.alert')];return els.map(e=>e.textContent.trim());}")
    bad = [x for x in t if 'Unknown' in x]
    print(f"  [{where}] toasts={t} {'!! UNKNOWN-STATION TOAST' if bad else 'ok'}")
    return not bad

with sync_playwright() as pw:
    b = pw.chromium.launch(executable_path="/home/hatch/.cache/ms-playwright/chromium-1243/chrome-linux/chrome",
                           args=["--no-sandbox"])
    ok = True

    # --- KDS as kitchen: click each station tab (slugs) ---
    ctx = b.new_context(viewport={"width":1366,"height":800})
    kp = ctx.new_page()
    session_inject(kp, KT)
    goto(kp, "#/kds")
    kp.wait_for_selector("#kds-tabs .tab")
    ws = kp.evaluate("()=>document.querySelector('#kds-ws').textContent.trim()")
    print("kds ws badge:", ws)
    for slug in ["expediter","garde_manger","dessert","bar"]:
        kp.click(f'#kds-tabs .tab[data-st="{slug}"]')
        kp.wait_for_timeout(1200)
        cards = kp.evaluate("()=>document.querySelectorAll('.ticket-card,.kds-card,.ticket').length")
        print(f"tab {slug}: ticket cards in DOM = {cards}")
        ok = toast_check(kp, f"kds/{slug}") and ok
        kp.screenshot(path=f"{OUT}/05-kds-{slug}.png")
        print("saved", f"{OUT}/05-kds-{slug}.png")
    kp.close(); ctx.close()

    # --- manager views ---
    ctx2 = b.new_context(viewport={"width":1366,"height":800})
    mp = ctx2.new_page()
    session_inject(mp, MT)

    goto(mp, "#/floor"); mp.wait_for_timeout(800)
    mp.screenshot(path=f"{OUT}/06-floor-manager.png"); print("saved 06-floor-manager.png")

    goto(mp, "#/manager")
    ov = mp.evaluate("()=>document.body.innerText.slice(0,600)")
    print("overview text sample:", ov.replace("\n"," | ")[:300])
    mp.screenshot(path=f"{OUT}/07-manager-overview.png"); print("saved 07-manager-overview.png")

    # Finance: default site date
    goto(mp, "#/manager/finance")
    findate = mp.evaluate("()=>document.querySelector('#fin-date').value")
    print("fin-date default:", findate, "(expect 2026-09-25)")
    mp.screenshot(path=f"{OUT}/08-finance-payouts.png"); print("saved 08-finance-payouts.png")
    # Finance: seeded date
    mp.evaluate("()=>{const i=document.querySelector('#fin-date');i.value='2026-09-24';i.dispatchEvent(new Event('change',{bubbles:true}));}")
    mp.wait_for_timeout(1200)
    fintext = mp.evaluate("()=>document.querySelector('#fin-body').innerText.replace(/\\n+/g,' | ').slice(0,500)")
    print("fin 2026-09-24 body:", fintext[:400])
    mp.screenshot(path=f"{OUT}/08b-finance-payouts-2026-09-24.png"); print("saved 08b-finance-payouts-2026-09-24.png")

    # Shift: default site date
    goto(mp, "#/manager/shift")
    shdate = mp.evaluate("()=>document.querySelector('#sh-date').value")
    print("sh-date default:", shdate, "(expect 2026-09-25)")
    mp.screenshot(path=f"{OUT}/09-shift-report.png"); print("saved 09-shift-report.png")
    # Shift: seeded date
    mp.evaluate("()=>{const i=document.querySelector('#sh-date');i.value='2026-09-24';i.dispatchEvent(new Event('change',{bubbles:true}));}")
    mp.wait_for_timeout(1200)
    shtext = mp.evaluate("()=>document.querySelector('#sh-body').innerText.replace(/\\n+/g,' | ').slice(0,500)")
    print("shift 2026-09-24 body:", shtext[:400])
    mp.screenshot(path=f"{OUT}/09b-shift-report-2026-09-24.png"); print("saved 09b-shift-report-2026-09-24.png")

    mp.close(); ctx2.close(); b.close()
print("ALL-OK" if ok else "TOAST-ISSUE")
