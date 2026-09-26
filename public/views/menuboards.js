/* ============================================================================
 * Expoline — digital menu boards (TV display).
 * Standalone: <script src="/views/menuboards.js"></script> in a bare page.
 * Board selection via query params: ?board=2&boards=3
 *
 * Full-screen dark, min 48px item names (readable from 10 feet),
 * auto-rotates categories every 15s, re-polls the menu every 60s so 86'd
 * items vanish from every TV within a minute.
 * ========================================================================== */
(function () {
  'use strict';

  var ROTATE_MS = 15000;
  var POLL_MS = 60000;

  function qp(name, fb) {
    var m = new RegExp('[?&]' + name + '=([^&]*)').exec(location.search);
    return m ? decodeURIComponent(m[1]) : fb;
  }
  var BOARD = Math.max(1, parseInt(qp('board', '1'), 10) || 1);
  var BOARDS = Math.max(1, parseInt(qp('boards', '1'), 10) || 1);

  var css = [
    '*{box-sizing:border-box}',
    'html,body{margin:0;padding:0;height:100%;background:#06090f}',
    'body{color:#f4efe2;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;overflow:hidden}',
    '#mb{height:100vh;display:flex;flex-direction:column;padding:4vh 4vw}',
    '#mb-head{display:flex;align-items:baseline;justify-content:space-between;flex:none;margin-bottom:3vh}',
    '#mb-title{font-size:64px;font-weight:800;letter-spacing:1px;color:#c9a86a;margin:0}',
    '#mb-clock{font-size:40px;color:#a8a294}',
    '#mb-catname{font-size:88px;font-weight:800;margin:0 0 2vh;line-height:1.05}',
    '#mb-items{flex:1;display:grid;grid-template-columns:1fr 1fr;gap:1.2vh 4vw;align-content:start;overflow:hidden}',
    '.mb-it{border-bottom:2px solid #1f2a42;padding-bottom:1vh}',
    '.mb-it .nm{font-size:52px;font-weight:700;line-height:1.15}',
    '.mb-it .ds{font-size:30px;color:#a8a294;line-height:1.25;margin-top:.4vh}',
    '.mb-it .pr{font-size:52px;color:#c9a86a;font-weight:800;float:right;margin-left:2vw}',
    '#mb-dots{flex:none;display:flex;gap:16px;justify-content:center;padding-top:2.5vh}',
    '.mb-dot{width:22px;height:22px;border-radius:50%;background:#2a3650}',
    '.mb-dot.on{background:#c9a86a}',
    '#mb-empty{font-size:48px;color:#a8a294;text-align:center;margin-top:20vh}'
  ].join('\n');

  var state = { cats: [], idx: 0 };

  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function money(c) { return '$' + (c / 100).toFixed(2); }

  function build() {
    var st = document.createElement('style');
    st.textContent = css;
    document.head.appendChild(st);
    var root = el('div');
    root.id = 'mb';
    root.innerHTML =
      '<div id="mb-head"><h1 id="mb-title">BALI HAI</h1><div id="mb-clock"></div></div>' +
      '<h2 id="mb-catname"></h2><div id="mb-items"></div><div id="mb-dots"></div>';
    document.body.appendChild(root);
    tickClock();
    setInterval(tickClock, 30000);
  }
  function tickClock() {
    var d = new Date();
    var h = d.getHours(), m = ('0' + d.getMinutes()).slice(-2), ap = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    document.getElementById('mb-clock').textContent = h + ':' + m + ' ' + ap;
  }

  function load() {
    fetch('/api/menuboards?board=' + BOARD + '&boards=' + BOARDS)
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var fresh = d.categories || [];
        // Keep rotation position stable across polls when possible.
        var curName = state.cats[state.idx] && state.cats[state.idx].name;
        state.cats = fresh;
        if (!fresh.length) { renderEmpty(); return; }
        var ni = fresh.findIndex(function (c) { return c.name === curName; });
        state.idx = ni >= 0 ? ni : 0;
        render();
      })
      .catch(function () { /* keep last board on poll failure */ });
  }

  function renderEmpty() {
    document.getElementById('mb-catname').textContent = '';
    document.getElementById('mb-items').innerHTML =
      '<div id="mb-empty">Menu updating…</div>';
    document.getElementById('mb-dots').innerHTML = '';
  }

  function render() {
    var cat = state.cats[state.idx];
    if (!cat) { renderEmpty(); return; }
    document.getElementById('mb-catname').textContent = cat.name;
    var box = document.getElementById('mb-items');
    box.innerHTML = '';
    cat.items.forEach(function (it) {
      var price = it.price_cents > 0 ? money(it.price_cents)
        : (it.price_note ? esc(it.price_note) : 'MP');
      box.appendChild(el('div', 'mb-it',
        '<span class="pr">' + price + '</span>' +
        '<div class="nm">' + esc(it.name) + '</div>' +
        (it.description ? '<div class="ds">' + esc(it.description) + '</div>' : '')));
    });
    var dots = document.getElementById('mb-dots');
    dots.innerHTML = '';
    state.cats.forEach(function (c, i) {
      dots.appendChild(el('span', 'mb-dot' + (i === state.idx ? ' on' : '')));
    });
  }

  function rotate() {
    if (state.cats.length < 2) return;
    state.idx = (state.idx + 1) % state.cats.length;
    render();
  }

  build();
  load();
  setInterval(load, POLL_MS);
  setInterval(rotate, ROTATE_MS);
})();
