#!/usr/bin/env node
/**
 * scan_undefined_calls.js — the durable guard for the 2026-10-06
 * pay-dialog outage class.
 *
 * The outage: the Cash / Card / House payment handlers called
 * splitTenderFields() and readSplitTender(), which were defined in
 * NO commit and NO shipped file. Every click threw a silent
 * ReferenceError. node --check cannot catch this (the file parses —
 * the callee simply does not exist), and the API suites could not
 * catch it (they never click). This scan can: it collects every
 * function definition across ALL shipped client JS (public/*.js +
 * public/views/*.js — one shared definition pool, because the
 * pages load these files together) and flags every bare function
 * call whose callee is defined in none of them and is not a known
 * global.
 *
 * Conservative by design (few false positives over cleverness):
 *   - strings, template literals and comments are blanked before
 *     scanning, so call-shaped text inside them never flags;
 *   - method calls (obj.name(), a?.b()) are never flagged — only
 *     bare NAME(...) calls;
 *   - declarations (function NAME(...)) are not calls;
 *   - JS keywords and the explicit GLOBALS allowlist below (each
 *     entry a browser/DOM API or JS builtin, justified inline) are
 *     never flagged;
 *   - definitions are pooled across files and order-free, and any
 *     const/let/var assignment counts as a definition, so a callee
 *     that exists anywhere in the bundle counts as defined.
 * Known limitation (accepted): a name defined only as a LOCAL
 * inside one function still counts as defined bundle-wide, so the
 * scan can theoretically miss a cross-file shadow bug. It cannot
 * miss the outage class it exists for — a callee defined NOWHERE.
 *
 * Exit 0 = clean. Exit 1 = at least one called-but-undefined name
 * (printed with up to 5 call sites each). Exit 2 = scan error.
 *
 * Usage: node scan_undefined_calls.js [publicDir]
 * Wired into qa/test47_pay_dialogs.py; run it before shipping any
 * batch that touches public/ (see ~/AGENTS.md, 2026-10-06 rule).
 */
const fs = require('fs');
const path = require('path');

const PUB = process.argv[2] || path.join(__dirname, '..', 'public');

const KEYWORDS = new Set([
  'if', 'for', 'while', 'do', 'switch', 'catch', 'return', 'typeof',
  'instanceof', 'new', 'delete', 'void', 'in', 'of', 'await', 'yield',
  'else', 'case', 'throw', 'function', 'class', 'extends', 'super',
  'this', 'var', 'let', 'const',
  // 'async' is a call-shaped token only as the head of an async
  // arrow (async (x) => ...) — a bare call to a function literally
  // named async cannot be distinguished from that and does not
  // occur in this bundle, so the token is never flagged.
  'async',
]);

/* Known globals: JS builtins and browser/DOM APIs a bare call can
   legitimately resolve to without any shipped file defining it.
   Keep this list honest — an entry here silences the scan for that
   name bundle-wide, so every entry must be a real platform global. */
const GLOBALS = new Set([
  // JS builtins / global functions
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'Number', 'String',
  'Boolean', 'Array', 'Object', 'Symbol', 'BigInt', 'Promise', 'Proxy',
  'Reflect', 'Error', 'TypeError', 'RangeError', 'SyntaxError',
  'EvalError', 'AggregateError', 'RegExp', 'Date', 'Map', 'Set',
  'WeakMap', 'WeakSet', 'ArrayBuffer', 'DataView', 'URL', 'URLSearchParams',
  'TextEncoder', 'TextDecoder', 'encodeURIComponent', 'decodeURIComponent',
  'encodeURI', 'decodeURI', 'escape', 'unescape', 'structuredClone',
  'queueMicrotask', 'btoa', 'atob', 'Intl', 'JSON', 'Math',
  // timers / scheduling (window globals)
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
  'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback',
  // browser UI / window functions also callable bare
  'alert', 'confirm', 'prompt', 'fetch', 'open', 'close', 'print',
  'focus', 'blur', 'scrollTo', 'scrollBy', 'postMessage', 'getComputedStyle',
  'getSelection', 'matchMedia', 'addEventListener', 'removeEventListener',
  'dispatchEvent', 'stop', 'find',
  // DOM / platform constructors callable with or without new
  'Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'PointerEvent',
  'TouchEvent', 'InputEvent', 'FormData', 'Blob', 'File', 'FileReader',
  'Image', 'Audio', 'WebSocket', 'EventSource', 'Worker', 'DOMParser',
  'XMLSerializer', 'AbortController', 'AbortSignal', 'MutationObserver',
  'IntersectionObserver', 'ResizeObserver', 'Headers', 'Request',
  'Response', 'IDBKeyRange', 'Notification', 'SpeechSynthesisUtterance',
  'BroadcastChannel', 'MessageChannel', 'OffscreenCanvas', 'Path2D',
  // typed arrays and other platform constructors
  'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array',
  'Uint16Array', 'Int32Array', 'Uint32Array', 'Float32Array',
  'Float64Array', 'BigInt64Array', 'BigUint64Array', 'SharedArrayBuffer',
  'WeakRef', 'FinalizationRegistry',
]);

/* Words after which a / starts a regex rather than division. */
const REGEX_OK_WORDS = new Set([
  'return', 'typeof', 'case', 'delete', 'void', 'in', 'of', 'new',
  'instanceof', 'await', 'yield', 'throw', 'do', 'else',
]);

/* Blank strings, template literals, regex literals and comments in
   place (same length, newlines preserved) so only real code is
   scanned. Regex awareness matters: this codebase has literals
   like /"/g and /'/g whose quote characters would otherwise open
   a phantom string and blank whole regions. A / is treated as a
   regex start unless the previous significant token is an operand
   (identifier value, ), ], }, or a string/template end). */
function stripCode(src) {
  const out = src.split('');
  const n = src.length;
  let i = 0, mode = 'code', braceDepth = 0;
  let prevSig = '', wordBuf = '', inClass = false;
  const tplStack = [];
  const blank = (j) => { if (out[j] !== '\n') out[j] = ' '; };
  const regexAllowed = () => {
    if (!prevSig) return true;
    if (/[\w$]/.test(prevSig)) return REGEX_OK_WORDS.has(wordBuf);
    if (prevSig === ')' || prevSig === ']' || prevSig === '}' ||
        prevSig === '"' || prevSig === "'" || prevSig === '`' || prevSig === '/') return false;
    return true;
  };
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (mode === 'code') {
      if (c === '/' && d === '/') { blank(i); blank(i + 1); i += 2; mode = 'line'; continue; }
      if (c === '/' && d === '*') { blank(i); blank(i + 1); i += 2; mode = 'block'; continue; }
      if (c === '/' && regexAllowed()) { blank(i); i++; mode = 'rx'; inClass = false; continue; }
      if (c === "'") { blank(i); i++; mode = 'sq'; prevSig = "'"; wordBuf = ''; continue; }
      if (c === '"') { blank(i); i++; mode = 'dq'; prevSig = '"'; wordBuf = ''; continue; }
      if (c === '`') { blank(i); i++; mode = 'tpl'; prevSig = '`'; wordBuf = ''; continue; }
      if (c === '{') braceDepth++;
      else if (c === '}') {
        braceDepth--;
        if (tplStack.length && braceDepth === tplStack[tplStack.length - 1]) {
          tplStack.pop(); blank(i); i++; mode = 'tpl'; prevSig = '`'; wordBuf = ''; continue;
        }
      }
      if (/[\w$]/.test(c)) { wordBuf += c; prevSig = c; }
      else if (!/\s/.test(c)) { prevSig = c; wordBuf = ''; }
      i++; continue;
    }
    if (mode === 'rx') {
      if (c === '\\') { blank(i); if (i + 1 < n) blank(i + 1); i += 2; continue; }
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) {
        blank(i); i++;
        while (i < n && /[a-z]/i.test(src[i])) { blank(i); i++; }
        mode = 'code'; prevSig = '/'; wordBuf = ''; continue;
      } else if (c === '\n') { mode = 'code'; continue; }
      blank(i); i++; continue;
    }
    if (mode === 'line') { if (c === '\n') mode = 'code'; else blank(i); i++; continue; }
    if (mode === 'block') {
      if (c === '*' && d === '/') { blank(i); blank(i + 1); i += 2; mode = 'code'; continue; }
      blank(i); i++; continue;
    }
    if (mode === 'sq' || mode === 'dq') {
      const q = mode === 'sq' ? "'" : '"';
      if (c === '\\') { blank(i); if (i + 1 < n) blank(i + 1); i += 2; continue; }
      if (c === q) { blank(i); i++; mode = 'code'; continue; }
      blank(i); i++; continue;
    }
    // tpl
    if (c === '\\') { blank(i); if (i + 1 < n) blank(i + 1); i += 2; continue; }
    if (c === '`') { blank(i); i++; mode = 'code'; continue; }
    if (c === '$' && d === '{') {
      blank(i); blank(i + 1); i += 2;
      tplStack.push(braceDepth); braceDepth++; mode = 'code';
      prevSig = '{'; wordBuf = ''; continue;
    }
    blank(i); i++; continue;
  }
  return out.join('');
}

function collectFiles(dir) {
  const files = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isFile() && e.name.endsWith('.js')) files.push(p);
  }
  const views = path.join(dir, 'views');
  if (fs.existsSync(views)) {
    for (const e of fs.readdirSync(views, { withFileTypes: true })) {
      const p = path.join(views, e.name);
      if (e.isFile() && e.name.endsWith('.js')) files.push(p);
    }
  }
  return files.sort();
}

/* Paren groups that open a body — `(...) {` (function declarations,
   method shorthand in object literals and classes, constructors)
   and `(...) =>` (arrows) — yield two more kinds of definitions:
   the name right before the group, and every parameter name inside
   it. Both are pooled bundle-wide. Pooling parameters is
   deliberately conservative: callback-heavy client code calls its
   parameters bare (Promise executors resolve/reject, confirmDialog
   onOk, picker onPick, wireTipout reload), and without this the
   scan drowns in false positives. The accepted cost: a callee that
   exists ONLY as some unrelated parameter name would be missed.
   Control-flow groups (if/for/while/catch ...) are excluded —
   their keyword sits right before the group. */
function collectParenGroups(code, defined) {
  for (let i = 0; i < code.length; i++) {
    if (code[i] !== '(') continue;
    let depth = 0, j = i;
    for (; j < code.length; j++) {
      if (code[j] === '(') depth++;
      else if (code[j] === ')') { depth--; if (depth === 0) break; }
    }
    if (j >= code.length) break;
    let k = j + 1;
    while (k < code.length && /\s/.test(code[k])) k++;
    const isArrow = code[k] === '=' && code[k + 1] === '>';
    const opensBrace = code[k] === '{';
    if (!isArrow && !opensBrace) continue;
    let e = i - 1;
    while (e >= 0 && /\s/.test(code[e])) e--;
    let s = e;
    while (s >= 0 && /[\w$]/.test(code[s])) s--;
    const name = code.slice(s + 1, e + 1);
    const fnContext = isArrow || name === 'function' || (name && !KEYWORDS.has(name));
    if (!fnContext) continue;
    if (name && name !== 'function' && !KEYWORDS.has(name)) defined.add(name);
    const inner = code.slice(i + 1, j);
    let d2 = 0, seg = '';
    const segs = [];
    for (const ch of inner) {
      if (ch === '(' || ch === '[' || ch === '{') d2++;
      else if (ch === ')' || ch === ']' || ch === '}') d2--;
      if (ch === ',' && d2 === 0) { segs.push(seg); seg = ''; } else seg += ch;
    }
    if (seg.trim()) segs.push(seg);
    for (const part of segs) {
      const lead = part.match(/^\s*(?:\.\.\.)?\s*([A-Za-z_$][\w$]*)/);
      if (lead && !KEYWORDS.has(lead[1])) defined.add(lead[1]);
      if (/^\s*[{\[]/.test(part)) {
        const ids = part.match(/[A-Za-z_$][\w$]*/g) || [];
        for (const id of ids) if (!KEYWORDS.has(id)) defined.add(id);
      }
    }
  }
}

function main() {
  const files = collectFiles(PUB);
  if (!files.length) { console.error('SCAN ERROR: no client JS under ' + PUB); process.exit(2); }
  const stripped = new Map();
  const defined = new Set();
  const defPatterns = [
    /\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)/g,
    /\bclass\s+([A-Za-z_$][\w$]*)/g,
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g,
    /\b([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function\b|\()/g,
    /\b(?:window|globalThis|self)\.([A-Za-z_$][\w$]*)\s*=/g,
  ];
  for (const f of files) {
    const code = stripCode(fs.readFileSync(f, 'utf8'));
    stripped.set(f, code);
    for (const re of defPatterns) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(code))) defined.add(m[1]);
    }
    collectParenGroups(code, defined);
    const singleParam = /([A-Za-z_$][\w$]*)\s*=>/g;
    let sp;
    while ((sp = singleParam.exec(code))) {
      if (!KEYWORDS.has(sp[1])) defined.add(sp[1]);
    }
  }

  const flags = new Map(); // name -> [{file, line}]
  const callRe = /([A-Za-z_$][\w$]*)\s*\(/g;
  for (const f of files) {
    const code = stripped.get(f);
    const rel = path.relative(path.join(PUB, '..'), f);
    callRe.lastIndex = 0;
    let m;
    while ((m = callRe.exec(code))) {
      const name = m[1];
      if (KEYWORDS.has(name) || GLOBALS.has(name) || defined.has(name)) continue;
      // previous non-space char: '.' means method call — never flag
      let j = m.index - 1;
      while (j >= 0 && /\s/.test(code[j])) j--;
      if (j >= 0 && code[j] === '.') continue;
      // function declarations are definitions, not calls
      const before = code.slice(Math.max(0, m.index - 24), m.index);
      if (/(?:^|[^\w$])function\s*\*?\s*$/.test(before)) continue;
      if (/(?:^|[^\w$])class\s*$/.test(before)) continue;
      const line = code.slice(0, m.index).split('\n').length;
      if (!flags.has(name)) flags.set(name, []);
      const sites = flags.get(name);
      if (sites.length < 5) sites.push(rel + ':' + line);
    }
  }

  console.log('scan: ' + files.length + ' shipped client JS files, ' +
    defined.size + ' defined names pooled');
  if (!flags.size) {
    console.log('scan: CLEAN — every bare call resolves to a definition or a known global');
    return 0;
  }
  console.log('scan: ' + flags.size + ' called-but-undefined name(s):');
  for (const [name, sites] of [...flags.entries()].sort()) {
    console.log('  UNDEFINED ' + name + ' — called at ' + sites.join(', '));
  }
  return 1;
}

process.exit(main());
