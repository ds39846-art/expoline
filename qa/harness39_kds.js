/* harness39_kds.js — extract the REAL kdsBand() decision function from
 * public/app.js (brace-matched, fails loudly if the anchor moves) and run
 * it in a vm with a stubbed `state.kds.thresholds`, so test39 exercises
 * the exact code the KDS board uses to pick a ticket's aging band.
 *
 * Usage: node harness39_kds.js <app.js path> <thresholds JSON> <elapsed JSON array>
 * Prints: JSON array of band strings, one per elapsed value. */
'use strict';
const fs = require('node:fs');
const vm = require('node:vm');

const [, , appPath, thJson, elapsedJson] = process.argv;
const src = fs.readFileSync(appPath, 'utf8');

function extract(anchor) {
  const at = src.indexOf(anchor);
  if (at < 0) throw new Error('anchor not found: ' + anchor);
  const open = src.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(at, i + 1); }
  }
  throw new Error('unbalanced braces after: ' + anchor);
}

const bandSrc = extract('function kdsBand(elapsedS)');
const thresholds = JSON.parse(thJson);
const elapsedList = JSON.parse(elapsedJson);

const ctx = { state: { kds: { thresholds } } };
vm.createContext(ctx);
vm.runInContext(bandSrc, ctx);
if (typeof ctx.kdsBand !== 'function') throw new Error('kdsBand did not evaluate to a function');

process.stdout.write(JSON.stringify(elapsedList.map((s) => ctx.kdsBand(s))));
