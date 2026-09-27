/* ============================================================================
 * Expoline — Phase 4: Proactive P&L insights + "Ask the restaurant anything"
 * ----------------------------------------------------------------------------
 * The 2026 AI bar (all documented in hidden_files/competitor-intel.md):
 *   - Toast IQ      — AI agent that combs data and tells the owner what to do
 *   - SpotOn Profit AI — proactive P&L recommendations (beta 2026)
 *   - Upserve       — menu intelligence + server performance as the DEFAULT
 *                     dashboard ("which servers upsell best")
 *   - Square        — natural-language reporting ("ask the restaurant anything")
 *
 * The documented complaint underneath: dashboards nobody opens. Owners get
 * 90+ reports (SpotOn) or per-module analytics SKUs (Toast) but no answers.
 * Expoline answers instead: a daily digest computed from the SAME honest
 * sales data the finance screens use, plus a rule-based NL Q&A over verified
 * figures. Every number is cited; nothing is vibes. No separate analytics
 * SKU, no per-seat fee — it's the POS telling the owner what's changing,
 * why, and what to do.
 *
 * Endpoints (all manager-only — these are the owner's numbers):
 *   GET  /api/insights/digest  — today vs typical weekday, movers, slow
 *                                 sellers, server leaderboard, labor watch,
 *                                 anomaly alerts (all with cited basis)
 *   POST /api/insights/ask      — {question} -> {answer, figures, basis};
 *                                 deterministic intent parsing, never
 *                                 hallucinates: unknown questions get the
 *                                 menu of answerable topics, not invented data
 *
 * Money: integer cents everywhere server-side; formatted only in answers.
 * INTEGRATION (server.js): require('./routes/insights').register(app, {...})
 * ========================================================================== */

'use strict';

const isInt = (v) => Number.isInteger(v);
const parseJson = (s, fb) => { try { return JSON.parse(s ?? ''); } catch { return fb; } };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/* Pre-discount line value (same definition as server.js lineGross). */
function lineGrossOf(r) {
  const mods = parseJson(r.modifiers_json, []);
  const qty = r.qty || 0;
  let t = qty * (r.unit_price_cents || 0);
  for (const m of mods) t += qty * (m.price_delta_cents || 0);
  return t;
}

function money(c) { return '$' + ((Number(c) || 0) / 100).toFixed(2); }
function pct1(x) { return (Math.round(x * 10) / 10).toFixed(1) + '%'; }

/* ---------------------------------------------------------------------------
 * Data layer — one pass over closed checks, bucketed by site-timezone date.
 * ------------------------------------------------------------------------- */
function closedLines(db, SITE_ID) {
  return db.prepare(
    `SELECT ci.menu_item_id, ci.qty, ci.unit_price_cents, ci.modifiers_json,
            ci.state, ci.discount_cents, ci.seat, mi.name AS item_name,
            c.id AS check_id, c.server_id, c.guest_count, c.closed_at, c.opened_at
     FROM check_items ci
     JOIN checks c ON c.id = ci.check_id
     LEFT JOIN menu_items mi ON mi.id = ci.menu_item_id
     WHERE c.site_id = ? AND c.status IN ('paid','closed') AND c.closed_at IS NOT NULL`
  ).all(SITE_ID);
}

function paymentsFor(db, SITE_ID) {
  return db.prepare(
    `SELECT p.tip_cents, p.amount_cents, p.status, p.check_id, c.closed_at
     FROM payments p JOIN checks c ON c.id = p.check_id
     WHERE p.site_id = ? AND c.site_id = ? AND c.status IN ('paid','closed')
       AND c.closed_at IS NOT NULL`
  ).all(SITE_ID, SITE_ID);
}

/* Per-date rollup: { gross, net, covers, checks, tips, discounts, void_qty,
   item_qty: Map<menu_item_id,{name,qty}>, by_hour: Map<hour,count sales> } */
function dailyStats(db, SITE_ID, tzDate, siteTz, from, to) {
  const days = new Map();
  const get = (d) => {
    if (!days.has(d)) days.set(d, {
      gross: 0, net: 0, covers: 0, checks: 0, tips: 0, discounts: 0,
      void_qty: 0, item_qty: new Map(), by_hour: new Map(), servers: new Map(),
    });
    return days.get(d);
  };
  const checkSeen = new Map(); // check_id -> date (count covers/checks once)
  const checkServer = new Map(); // check_id -> server_id (for date-scoped tip attribution)
  const tipByServer = new Map(); // date -> Map<server_id, tips> — tips credited on the day's digest
  for (const r of closedLines(db, SITE_ID)) {
    const d = tzDate(r.closed_at);
    if (!d || d < from || d > to) continue;
    checkServer.set(r.check_id, r.server_id);
    const s = get(d);
    if (!checkSeen.has(r.check_id)) { checkSeen.set(r.check_id, d); s.checks += 1; s.covers += (r.guest_count || 0); }
    if (r.state === 'cancelled') { s.void_qty += r.qty || 0; continue; }
    const g = lineGrossOf(r);
    s.gross += g;
    s.net += Math.max(0, g - (r.discount_cents || 0));
    s.discounts += (r.discount_cents || 0);
    const e = s.item_qty.get(r.menu_item_id) || { name: r.item_name || ('Item ' + r.menu_item_id), qty: 0 };
    e.qty += r.qty || 0; s.item_qty.set(r.menu_item_id, e);
    const hh = new Date(r.closed_at).toLocaleString('en-US', { timeZone: siteTz, hour: 'numeric', hour12: false });
    s.by_hour.set(hh, (s.by_hour.get(hh) || 0) + g);
    const sv = s.servers.get(r.server_id) || { sales: 0, checks: new Set() };
    sv.sales += g; sv.checks.add(r.check_id); s.servers.set(r.server_id, sv);
  }
  for (const p of paymentsFor(db, SITE_ID)) {
    const d = tzDate(p.closed_at);
    if (!d || d < from || d > to) continue;
    if (p.status === 'refunded') continue; // honest: refunded payments don't count as tips
    get(d).tips += (p.tip_cents || 0);
    const sid = checkServer.get(p.check_id);
    if (sid) {
      if (!tipByServer.has(d)) tipByServer.set(d, new Map());
      const m = tipByServer.get(d);
      m.set(sid, (m.get(sid) || 0) + (p.tip_cents || 0));
    }
  }
  return { days, tipByServer };
}

function sumItemQty(days, from, to) {
  const out = new Map();
  for (const [d, s] of days) {
    if (d < from || d > to) continue;
    for (const [id, e] of s.item_qty) {
      const o = out.get(id) || { name: e.name, qty: 0 };
      o.qty += e.qty; out.set(id, o);
    }
  }
  return out;
}

/* ---------------------------------------------------------------------------
 * Digest builder
 * ------------------------------------------------------------------------- */
function buildDigest(ctx) {
  const { db, SITE_ID, tzDate, todaySite, addDays, dayLabor, nowIso, SITE_TZ } = ctx;
  const today = todaySite();
  const { days, tipByServer } = dailyStats(db, SITE_ID, tzDate, SITE_TZ, addDays(today, -60), today);
  const t = days.get(today) || { gross: 0, net: 0, covers: 0, checks: 0, tips: 0, discounts: 0, void_qty: 0, item_qty: new Map(), by_hour: new Map(), servers: new Map() };

  // Baseline: same weekday over the prior 4 weeks, only days with sales.
  const baseSamples = [];
  for (let k = 1; k <= 4; k++) {
    const d = addDays(today, -7 * k);
    const s = days.get(d);
    if (s && s.checks > 0) baseSamples.push(s.gross);
  }
  const baseline = baseSamples.length ? Math.round(baseSamples.reduce((a, b) => a + b, 0) / baseSamples.length) : null;
  const deltaPct = baseline ? +(((t.gross - baseline) / baseline) * 100).toFixed(1) : null;

  // Movers: this 7d vs prior 7d, significant only (prior qty >= 5).
  const w1 = sumItemQty(days, addDays(today, -6), today);
  const w0 = sumItemQty(days, addDays(today, -13), addDays(today, -7));
  const movers = [];
  for (const [id, e1] of w1) {
    const q0 = (w0.get(id) || { qty: 0 }).qty;
    if (q0 >= 5) movers.push({ menu_item_id: id, name: e1.name, qty_now: e1.qty, qty_prev: q0, delta_pct: +(((e1.qty - q0) / q0) * 100).toFixed(1) });
  }
  const up = movers.filter((m) => m.delta_pct > 0).sort((a, b) => b.delta_pct - a.delta_pct).slice(0, 3);
  const down = movers.filter((m) => m.delta_pct < 0).sort((a, b) => a.delta_pct - b.delta_pct).slice(0, 3);

  // Slow sellers: active menu items silent this week that were selling before.
  const activeItems = db.prepare('SELECT id, name FROM menu_items WHERE site_id = ? AND active = 1').all(SITE_ID);
  const w21 = sumItemQty(days, addDays(today, -27), addDays(today, -7));
  const d28 = sumItemQty(days, addDays(today, -27), today);
  const silent = [], dead = [];
  for (const mi of activeItems) {
    const q1 = (w1.get(mi.id) || { qty: 0 }).qty;
    if (q1 > 0) continue;
    const q21 = (w21.get(mi.id) || { qty: 0 }).qty;
    if (q21 >= 3) silent.push({ menu_item_id: mi.id, name: mi.name, qty_prior_21d: q21 });
    else if (((d28.get(mi.id) || { qty: 0 }).qty) === 0) dead.push({ menu_item_id: mi.id, name: mi.name });
  }

  // Server leaderboard (Upserve's best demo): sales, checks, avg ticket, tips.
  const users = new Map(db.prepare('SELECT id, name, role FROM users').all().map((u) => [u.id, u]));
  const servers = [];
  for (const [sid, sv] of t.servers) {
    const u = users.get(sid) || { name: 'Unknown', role: 'server' };
    // Tips are credited on the check's close date (site tz), from the same
    // date-bucketed pass as the rest of the digest — never all-time totals.
    const tips = (tipByServer.get(today) || new Map()).get(sid) || 0;
    servers.push({
      user_id: sid, name: u.name, role: u.role,
      sales_cents: sv.sales, checks: sv.checks.size,
      avg_ticket_cents: sv.checks.size ? Math.round(sv.sales / sv.checks.size) : 0,
      tips_cents: tips, tip_pct: sv.sales ? +((tips / sv.sales) * 100).toFixed(1) : 0,
    });
  }
  servers.sort((a, b) => b.sales_cents - a.sales_cents);

  // Labor watch: today's CA-compliant labor cost vs net sales.
  let labor = null;
  try {
    const s = dayLabor(today).summary || {};
    labor = {
      reg_cents: s.reg_cents || 0, ot_cents: s.ot_cents || 0, premium_cents: s.premium_cents || 0,
      total_cents: s.total_cents || 0,
      pct_of_sales: t.net > 0 ? +(((s.total_cents || 0) / t.net) * 100).toFixed(1) : null,
    };
  } catch { labor = { reg_cents: 0, ot_cents: 0, premium_cents: 0, total_cents: 0, pct_of_sales: null }; }

  // Alerts — anomalies with cited basis, never vibes.
  const alerts = [];
  const staleCut = new Date(new Date(nowIso()).getTime() - 24 * 3600 * 1000).toISOString();
  const stale = db.prepare(
    `SELECT c.id, c.tab_name, c.opened_at, t.label AS table_label
     FROM checks c LEFT JOIN tables t ON t.id = c.table_id
     WHERE c.site_id = ? AND c.status = 'open' AND c.opened_at < ? ORDER BY c.opened_at`
  ).all(SITE_ID, staleCut);
  if (stale.length) alerts.push({
    kind: 'stale_open_checks', severity: 'high',
    title: stale.length + ' open check' + (stale.length > 1 ? 's' : '') + ' older than 24h',
    detail: 'Open checks that survived a full day are usually lost tabs — review and close or void them.',
    basis: stale.map((c) => ({ id: c.id, label: c.table_label || c.tab_name || ('Check ' + c.id), opened_at: c.opened_at })),
  });
  // 7-day void rate vs the 8% house threshold.
  let v7 = 0, s7 = 0;
  for (const [d, s] of days) { if (d >= addDays(today, -6)) { v7 += s.void_qty; for (const e of s.item_qty.values()) s7 += e.qty; } }
  const voidRate = (s7 + v7) > 0 ? (v7 / (s7 + v7)) * 100 : 0;
  if (voidRate > 8) {
    const vitems = new Map();
    for (const r of closedLines(db, SITE_ID)) {
      const d = tzDate(r.closed_at);
      if (!d || d < addDays(today, -6) || r.state !== 'cancelled') continue;
      vitems.set(r.item_name || ('Item ' + r.menu_item_id), (vitems.get(r.item_name || ('Item ' + r.menu_item_id)) || 0) + (r.qty || 0));
    }
    alerts.push({
      kind: 'void_rate', severity: 'warn',
      title: 'Void rate ' + pct1(voidRate) + ' over the last 7 days (threshold 8%)',
      detail: 'Voids are eating margin. Top voided items are listed — check prep errors, 86 discipline, or order-entry mistakes.',
      basis: [...vitems.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name, qty]) => ({ name, qty })),
    });
  }
  // Discount spike: this 7d vs prior 7d.
  let d1 = 0, d0 = 0;
  for (const [d, s] of days) {
    if (d >= addDays(today, -6)) d1 += s.discounts;
    else if (d >= addDays(today, -13)) d0 += s.discounts;
  }
  if (d1 >= 1000 && d0 > 0 && d1 / d0 >= 2) alerts.push({
    kind: 'discount_spike', severity: 'warn',
    title: 'Discounts ' + money(d1) + ' this week vs ' + money(d0) + ' last week',
    detail: 'Discount volume at least doubled week over week. Every discount is reason-coded in the audit log — sample them.',
    basis: { this_week_cents: d1, last_week_cents: d0 },
  });
  // 86 activity today (site-timezone day, like every other figure here).
  let n86 = 0;
  for (const r of db.prepare("SELECT created_at FROM menu_audit WHERE site_id = ? AND action = 'item.86'").all(SITE_ID)) {
    if (tzDate(r.created_at) === today) n86++;
  }
  if (n86 > 0) alerts.push({
    kind: 'eightysix', severity: 'info',
    title: n86 + ' item' + (n86 > 1 ? 's' : '') + ' 86\u2019d today',
    detail: 'Sold-out items block ordering instantly — no back-office round trip. Check the menu editor if 86s are piling up on the same items.',
    basis: { count_86_today: n86 },
  });
  if (labor.pct_of_sales != null && labor.pct_of_sales > 35) alerts.push({
    kind: 'labor_high', severity: 'warn',
    title: 'Labor ' + pct1(labor.pct_of_sales) + ' of net sales today (watch: 35%)',
    detail: 'Includes regular + OT + CA break premiums. Check the Schedule view against tonight\u2019s cover count.',
    basis: { labor_cents: labor.total_cents, net_sales_cents: t.net },
  });

  return {
    date: today,
    today: {
      sales_gross_cents: t.gross, sales_net_cents: t.net, covers: t.covers,
      check_count: t.checks, avg_ticket_cents: t.checks ? Math.round(t.gross / t.checks) : 0,
      tips_cents: t.tips, discounts_cents: t.discounts, void_qty_today: t.void_qty,
      baseline_gross_cents: baseline, baseline_samples: baseSamples.length, delta_pct: deltaPct,
    },
    movers: { up, down },
    // silent is inherently small (sold >=3 in prior 21d, zero this week);
    // dead_weight is capped — the UI shows the first 8.
    slow_sellers: { silent, dead_weight: dead.slice(0, 50) },
    servers, labor, alerts,
  };
}

/* ---------------------------------------------------------------------------
 * "Ask the restaurant anything" — deterministic intent parsing over the same
 * verified data. Unknown questions get the answerable-topics menu, never
 * invented figures.
 * ------------------------------------------------------------------------- */
const ANSWERABLE = [
  'What were sales today?', 'What were sales yesterday?', 'Sales this week vs last week?',
  'Who is our best seller?', 'What are our slowest sellers?', 'Who is our top server?',
  'What did labor cost today?', 'How much did we take in tips?', 'What is our void rate?',
  'Busiest hour today?', 'What is 86\u2019d right now?', 'How many checks are open?',
];

function askQuestion(ctx, question) {
  const { db, SITE_ID, tzDate, todaySite, addDays, dayLabor, SITE_TZ } = ctx;
  const q = String(question || '').toLowerCase().trim();
  const today = todaySite();
  const { days } = dailyStats(db, SITE_ID, tzDate, SITE_TZ, addDays(today, -60), today);
  const at = (d) => days.get(d) || { gross: 0, net: 0, covers: 0, checks: 0, tips: 0, discounts: 0, void_qty: 0, item_qty: new Map(), by_hour: new Map() };
  const say = (answer, figures, basis) => ({ intent: 'answered', answer, figures, basis });

  const dayLine = (d, s, label) =>
    say(`${label}: ${money(s.gross)} gross on ${s.checks} checks (${s.covers} covers), avg ticket ${money(s.checks ? Math.round(s.gross / s.checks) : 0)}, ${money(s.tips)} in tips.`,
      [{ label: 'Gross sales', value: money(s.gross) }, { label: 'Checks', value: String(s.checks) },
       { label: 'Covers', value: String(s.covers) }, { label: 'Tips', value: money(s.tips) }],
      { date: d, gross_cents: s.gross, checks: s.checks, covers: s.covers, tips_cents: s.tips });

  // 1. Explicit date.
  const dm = q.match(/(\d{4}-\d{2}-\d{2})/);
  if (dm) {
    if (!DATE_RE.test(dm[1])) return say('That date didn\u2019t parse — use YYYY-MM-DD.', [], { date: dm[1] });
    return dayLine(dm[1], at(dm[1]), 'Sales on ' + dm[1]);
  }
  // 2. Server performance (before item intents — "top server" contains "top").
  if (/\bserver\b/.test(q)) {
    const d = buildDigest(ctx);
    if (!d.servers.length) return say('No server sales recorded today yet.', [], { date: today });
    const top = d.servers[0];
    return say(`${top.name} leads today: ${money(top.sales_cents)} on ${top.checks} checks (avg ticket ${money(top.avg_ticket_cents)}), ${money(top.tips_cents)} in tips (${top.tip_pct}% of sales).`,
      d.servers.slice(0, 5).map((s) => ({ label: s.name, value: money(s.sales_cents) + ' · ' + s.checks + ' checks · ' + money(s.tips_cents) + ' tips' })),
      { date: today, servers: d.servers });
  }
  // 3. Best / worst seller (last 7 days).
  if (/\b(best|top|worst|slowest)\b/.test(q) && /\b(sell\w*|item|dish|menu|product)\b/.test(q)) {
    const w = sumItemQty(days, addDays(today, -6), today);
    const list = [...w.entries()].map(([id, e]) => ({ menu_item_id: id, name: e.name, qty: e.qty })).sort((a, b) => b.qty - a.qty);
    if (!list.length) return say('No item sales in the last 7 days.', [], { window: '7d' });
    if (/\b(worst|slowest)\b/.test(q)) {
      const w0 = list[list.length - 1];
      return say(`Slowest seller this week: ${w0.name} — ${w0.qty} sold in 7 days.`, [{ label: w0.name, value: w0.qty + ' sold' }], { window: '7d', item: w0 });
    }
    const b0 = list[0];
    return say(`Best seller this week: ${b0.name} — ${b0.qty} sold in 7 days.`, [{ label: b0.name, value: b0.qty + ' sold' }], { window: '7d', item: b0 });
  }
  // 4. Labor cost.
  if (/\blabor\b|\bpayroll\b|\bstaff cost\b/.test(q)) {
    let s = {};
    try { s = dayLabor(today).summary || {}; } catch { /* fall through with zeros */ }
    const total = s.total_cents || 0;
    const t = at(today);
    const p = t.net > 0 ? pct1((total / t.net) * 100) : 'n/a';
    return say(`Labor today: ${money(total)} — ${money(s.reg_cents || 0)} regular, ${money(s.ot_cents || 0)} overtime, ${money(s.premium_cents || 0)} break premiums. That\u2019s ${p} of net sales.`,
      [{ label: 'Total labor', value: money(total) }, { label: 'Regular', value: money(s.reg_cents || 0) },
       { label: '% of net sales', value: p }], { date: today, labor_cents: total });
  }
  // 5. Tips.
  if (/\btip\b/.test(q)) {
    const t = at(today);
    const p = t.gross > 0 ? pct1((t.tips / t.gross) * 100) : 'n/a';
    return say(`Tips today: ${money(t.tips)} on ${money(t.gross)} gross — a ${p} tip rate.`, [{ label: 'Tips', value: money(t.tips) }, { label: 'Tip rate', value: p }], { date: today, tips_cents: t.tips });
  }
  // 6. Voids.
  if (/\bvoid\b/.test(q)) {
    let v = 0, s = 0;
    for (let k = 0; k < 7; k++) { const st = at(addDays(today, -k)); v += st.void_qty; for (const e of st.item_qty.values()) s += e.qty; }
    const r = (s + v) > 0 ? pct1((v / (s + v)) * 100) : '0.0%';
    return say(`Void rate, last 7 days: ${r} (${v} voided units against ${s} sold).`, [{ label: 'Void rate (7d)', value: r }, { label: 'Voided units', value: String(v) }], { window: '7d', void_qty: v });
  }
  // 7. Discounts / comps.
  if (/\bdiscount\b|\bcomp\b/.test(q)) {
    let d = 0;
    for (let k = 0; k < 7; k++) d += at(addDays(today, -k)).discounts;
    return say(`Item-level discounts, last 7 days: ${money(d)}. Every discount is reason-coded in the audit log.`, [{ label: 'Discounts (7d)', value: money(d) }], { window: '7d', discounts_cents: d });
  }
  // 8. Covers / guests.
  if (/\bcover\b|\bguest\b/.test(q) && !/\bqr\b/.test(q)) {
    const t = at(today);
    return say(`${t.covers} covers on ${t.checks} checks today.`, [{ label: 'Covers', value: String(t.covers) }, { label: 'Checks', value: String(t.checks) }], { date: today, covers: t.covers });
  }
  // 9. Average ticket.
  if (/\baverage ticket\b|\bavg ticket\b|\bcheck average\b/.test(q)) {
    const t = at(today);
    const a = t.checks ? Math.round(t.gross / t.checks) : 0;
    return say(`Average ticket today: ${money(a)} (${money(t.gross)} across ${t.checks} checks).`, [{ label: 'Avg ticket', value: money(a) }], { date: today, avg_ticket_cents: a });
  }
  // 10. Week over week.
  if (/\bcompare\b|\bvs\b|\bversus\b|\bweek over week\b/.test(q) || (/\blast week\b/.test(q) && /\bsales\b/.test(q))) {
    let w1 = 0, w0 = 0;
    for (let k = 0; k < 7; k++) { w1 += at(addDays(today, -k)).gross; w0 += at(addDays(today, -7 - k)).gross; }
    const dp = w0 > 0 ? +(((w1 - w0) / w0) * 100).toFixed(1) : null;
    return say(`This week: ${money(w1)} vs last week: ${money(w0)} — ${dp == null ? 'no prior-week baseline' : (dp >= 0 ? '+' : '') + dp + '% week over week'}.`,
      [{ label: 'This week', value: money(w1) }, { label: 'Last week', value: money(w0) }], { this_week_cents: w1, last_week_cents: w0, delta_pct: dp });
  }
  // 11. Busiest / peak hour.
  if (/\bbusiest\b|\bpeak\b|\bslowest hour\b|\bquiet/.test(q)) {
    const t = at(today);
    const hours = [...t.by_hour.entries()].sort((a, b) => b[1] - a[1]);
    if (!hours.length) return say('No sales today yet — no peak hour to report.', [], { date: today });
    const fmtH = (h) => { const n = Number(h) % 24; const ap = n < 12 ? 'AM' : 'PM'; const hh = n % 12 === 0 ? 12 : n % 12; return hh + ' ' + ap; };
    return say(`Busiest hour today: ${fmtH(hours[0][0])} with ${money(hours[0][1])} in sales.`, hours.slice(0, 3).map(([h, c]) => ({ label: fmtH(h), value: money(c) })), { date: today, by_hour: Object.fromEntries(hours) });
  }
  // 12. 86'd right now.
  if (/\b86\b|\bsold out\b|\bout of\b/.test(q)) {
    const rows = db.prepare('SELECT name FROM menu_items WHERE site_id = ? AND active = 0 ORDER BY name').all(SITE_ID);
    if (!rows.length) return say('Nothing is 86\u2019d right now — the full menu is orderable.', [], {});
    return say(`${rows.length} item${rows.length > 1 ? 's' : ''} 86\u2019d right now: ${rows.map((r) => r.name).join(', ')}.`,
      rows.map((r) => ({ label: r.name, value: '86\u2019d' })), { count: rows.length });
  }
  // 13. Open checks / tabs.
  if (/\bopen\b/.test(q) && /\b(checks?|tabs?)\b/.test(q)) {
    const rows = db.prepare(
      `SELECT c.id, c.tab_name, t.label AS table_label FROM checks c LEFT JOIN tables t ON t.id = c.table_id
       WHERE c.site_id = ? AND c.status = 'open' ORDER BY c.opened_at`
    ).all(SITE_ID);
    if (!rows.length) return say('No open checks right now — the floor is clear.', [], {});
    return say(`${rows.length} open check${rows.length > 1 ? 's' : ''}: ${rows.map((r) => r.table_label || r.tab_name || ('#' + r.id)).join(', ')}.`,
      rows.map((r) => ({ label: r.table_label || r.tab_name || ('Check ' + r.id), value: 'open' })), { count: rows.length });
  }
  // 14. Sales today / yesterday / this week.
  if (/\bsales\b|\brevenue\b|\btook in\b|\bhow much\b/.test(q) || /\btoday\b/.test(q)) {
    if (/\byesterday\b/.test(q)) { const d = addDays(today, -1); return dayLine(d, at(d), 'Sales yesterday (' + d + ')'); }
    if (/\bthis week\b|\blast 7\b|\b7 days\b/.test(q)) {
      let g = 0, c = 0; for (let k = 0; k < 7; k++) { const s = at(addDays(today, -k)); g += s.gross; c += s.checks; }
      return say(`Sales, last 7 days: ${money(g)} across ${c} checks.`, [{ label: 'Gross (7d)', value: money(g) }, { label: 'Checks', value: String(c) }], { window: '7d', gross_cents: g });
    }
    if (/\blast week\b/.test(q)) {
      let g = 0, c = 0; for (let k = 7; k < 14; k++) { const s = at(addDays(today, -k)); g += s.gross; c += s.checks; }
      return say(`Sales, prior 7 days: ${money(g)} across ${c} checks.`, [{ label: 'Gross (prior 7d)', value: money(g) }], { window: 'prior-7d', gross_cents: g });
    }
    return dayLine(today, at(today), 'Sales today');
  }
  // 15. Fallback — the answerable menu, never invented figures.
  return {
    intent: 'unknown',
    answer: 'I can answer that from the restaurant\u2019s own data — try one of these:',
    figures: [], basis: {},
    suggestions: ANSWERABLE,
  };
}

/* ---------------------------------------------------------------------------
 * Registration
 * ------------------------------------------------------------------------- */
function register(app, ctx) {
  const { managerOnly } = ctx;

  app.get('/api/insights/digest', managerOnly(), (req, res) => {
    try { res.json(buildDigest(ctx)); }
    catch (e) { res.status(500).json({ error: 'digest failed: ' + (e.message || e) }); }
  });

  app.post('/api/insights/ask', managerOnly(), (req, res) => {
    const b = req.body || {};
    if (typeof b.question !== 'string' || !b.question.trim() || b.question.length > 300) {
      return res.status(400).json({ error: 'question must be a non-empty string of at most 300 characters' });
    }
    try { res.json(askQuestion(ctx, b.question.trim())); }
    catch (e) { res.status(500).json({ error: 'ask failed: ' + (e.message || e) }); }
  });
}

module.exports = { register, buildDigest, askQuestion };
