#!/usr/bin/env python3
"""test16_frontend_globals.py — regression test for the 2026-09-26 blank-page bug.

index.html loads giftcards.js, loyalty.js, then app.js as classic scripts in
shared global scope. loyalty.js used to declare a top-level `function esc`
which collided with app.js's top-level `const esc`, throwing
`SyntaxError: Identifier 'esc' has already been declared` at parse time and
killing ALL of app.js (blank page, no login). This test concatenates the
scripts in index.html load order inside a node vm context and asserts they
evaluate without a SyntaxError and expose the expected view functions.
"""
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PUBLIC = ROOT / "public"

SCRIPT_RE = re.compile(r'<script\s+src="\./([^"]+\.js)"')


def main():
    html = (PUBLIC / "index.html").read_text()
    scripts = SCRIPT_RE.findall(html)
    assert scripts, "no classic scripts found in index.html"
    print("load order:", " -> ".join(scripts))
    for s in scripts:
        assert (PUBLIC / s).exists(), f"missing script file: {s}"

    node_program = """
const fs = require('fs');
const vm = require('vm');
const files = %s;
const ctx = { window: {}, console,
  setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  location: { hash: '' }, navigator: {},
  document: { addEventListener: () => {}, querySelector: () => null, getElementById: () => null } };
ctx.window = ctx;
vm.createContext(ctx);
try {
  for (const f of files) vm.runInContext(fs.readFileSync(f, 'utf8'), ctx, { filename: f });
  const out = { ok: true, renderLoyalty: typeof ctx.renderLoyalty, renderGiftCards: typeof ctx.renderGiftCards };
  console.log(JSON.stringify(out));
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: e.constructor.name + ': ' + e.message }));
  process.exit(1);
}
""" % str([str(PUBLIC / s) for s in scripts])

    r = subprocess.run(["node", "-e", node_program], capture_output=True, text=True, timeout=60)
    import json
    try:
        result = json.loads(r.stdout.strip().splitlines()[-1])
    except Exception:
        print("node output:\n", r.stdout, r.stderr)
        sys.exit("FAIL: could not parse node result")
    assert result.get("ok"), f"FAIL: {result.get('error')}"
    assert result.get("renderLoyalty") == "function", "renderLoyalty not exposed"
    assert result.get("renderGiftCards") == "function", "renderGiftCards not exposed"
    print("PASS: all", len(scripts), "scripts evaluate in global scope with no collisions")


if __name__ == "__main__":
    main()
