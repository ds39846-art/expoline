#!/usr/bin/env python3
"""
test19_frontend_syntax.py — Frontend JavaScript syntax audit.

Daniel caught a blank menu on the public demo (2026-09-26) that API-only QA
never caught. Root cause: public/views/parity_orders.js had an unclosed IIFE
(missing })();), so the entire script failed to parse, window.ParityOrders was
undefined, and the order-screen menu render crashed silently.

This test validates syntax of every frontend JS file using node --check.
Must be run as part of the QA suite before any "done" claim.
"""
import subprocess
import sys
from pathlib import Path

BUILD = Path.home() / "workspace/goals/expo-line-pos-beat-toast-spoton-pilot-at-bali-hai/build/expoline"
JS_FILES = sorted((BUILD / "public").rglob("*.js"))

def negative_control():
    """Prove the checker actually catches the bug class that broke the demo.

    Writes a temp file with the exact defect from the 2026-09-26 incident
    (unclosed IIFE) and asserts node --check rejects it. If this control
    ever passes, the audit is vacuous and must not be trusted.
    """
    import tempfile, os
    broken = "(function(){\n  window.BrokenFixture = { ok: true };\n  // missing })(); — unclosed IIFE, the demo-killing defect\n"
    with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False,
                                     dir=str(BUILD / "public")) as f:
        f.write(broken)
        tmp = f.name
    try:
        r = subprocess.run(["node", "--check", tmp],
                           capture_output=True, text=True, timeout=30)
        if r.returncode == 0:
            print("NEGATIVE CONTROL FAILED: broken fixture parsed clean — audit is vacuous!")
            return False
        print(f"ok:   negative control (broken fixture correctly rejected)")
        return True
    finally:
        os.unlink(tmp)

def main():
    failures = []
    checked = 0
    if not negative_control():
        return 1
    for f in JS_FILES:
        # Skip node_modules if any
        if "node_modules" in str(f):
            continue
        checked += 1
        rel = f.relative_to(BUILD)
        r = subprocess.run(["node", "--check", str(f)],
                           capture_output=True, text=True, timeout=30)
        if r.returncode != 0:
            err = (r.stderr or r.stdout).strip().split("\n")[0]
            failures.append((str(rel), err))
            print(f"FAIL: {rel}\n      {err}")
        else:
            print(f"ok:   {rel}")
    print(f"\n{checked - len(failures)}/{checked} JS files parse cleanly.")
    if failures:
        print(f"\n{len(failures)} SYNTAX FAILURES — frontend is broken, do not ship.")
        return 1
    print("All frontend JS parses. UI can load.")
    return 0

if __name__ == "__main__":
    sys.exit(main())
