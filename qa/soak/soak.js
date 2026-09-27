/* Expoline 7-day soak test harness.
 * Runs a realistic restaurant workload nonstop against a dedicated soak
 * server instance (port 4320, db/soak.db), with periodic load spikes and
 * chaos (SIGKILL) events. Every invariant failure is logged CRITICAL.
 * STATUS file: qa/soak/STATUS  (RUNNING | COMPLETE | FAILED:<reason>)
 */
'use strict';
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SOAK_DIR = __dirname;
const BASE = 'http://localhost:4320';
const DB_FILE = path.join(ROOT, 'db', 'soak.db');
// Direct-DB chaos checks must inspect the database the live server is actually
// using. In our deployment the server runs separately with the persistent DB,
// so point the read-only chaos checks at it via SOAK_CHAOS_DB. (Default keeps
// the harness self-contained: its own spawned server uses DB_FILE.)
const CHAOS_DB_FILE = process.env.SOAK_CHAOS_DB || DB_FILE;
const DURATION_MS = parseInt(process.env.SOAK_DURATION_MS || String(7 * 24 * 3600 * 1000), 10);
const SPIKE_EVERY_MS = parseInt(process.env.SOAK_SPIKE_EVERY_MS || String(6 * 3600 * 1000), 10);
const SPIKE_ORDERS = parseInt(process.env.SOAK_SPIKE_ORDERS || '400', 10);
const CHAOS_EVERY_MS = parseInt(process.env.SOAK_CHAOS_EVERY_MS || String(12 * 3600 * 1000), 10);
const WORKERS = parseInt(process.env.SOAK_WORKERS || '6', 10);

const logFile = path.join(SOAK_DIR, 'soak.log');
const statusFile = path.join(SOAK_DIR, 'STATUS');
const metricsFile = path.join(SOAK_DIR, 'metrics.json');

const metrics = {
  started_at: new Date().toISOString(), lifecycles: 0, items_added: 0,
  payments: 0, spikes: 0, chaos_kills: 0, invariant_checks: 0,
  criticals: 0, errors: 0, spike_results: [],
};
function setStatus(s) { fs.writeFileSync(statusFile, s + '\n'); }
function log(level, msg) {
  const line = `${new Date().toISOString()} [${level}] ${msg}\n`;
  fs.appendFileSync(logFile, line);
}
function critical(msg) {
  metrics.criticals++;
  log('CRITICAL', msg);
  saveMetrics();
}
function saveMetrics() {
  metrics.updated_at = new Date().toISOString();
  fs.writeFileSync(metricsFile, JSON.stringify(metrics, null, 2));
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// ---- Disk-space guard (2026-09-27) ----
// /tmp exhaustion silently killed a soak run on 2026-09-26. df-based, no new
// dependencies. At startup, refuse to run below the hard floor (clear FATAL
// on stderr instead of dying mid-run). Below the soft threshold, rotate the
// runaway logs (truncate to last ROTATE_KEEP_LINES lines — append-mode
// writers keep working after truncation) and sweep only our own
// /tmp/soak-scratch-* files older than 24h. Thresholds are env-overridable.
const DISK_WARN_MB = parseFloat(process.env.SOAK_DISK_WARN_MB || '500');
const DISK_FATAL_MB = parseFloat(process.env.SOAK_DISK_FATAL_MB || '100');
const ROTATE_KEEP_LINES = 2000;
const stdoutLogFile = path.join(SOAK_DIR, 'soak_stdout.log');
function diskFreeMB(dir) {
  try {
    const out = execFileSync('df', ['-k', '--output=avail', dir],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const last = out.trim().split('\n').pop().trim();
    const kb = parseInt(last, 10);
    return Number.isNaN(kb) ? null : kb / 1024;
  } catch { return null; } // df unavailable: skip rather than crash
}
function diskCheckDirs() {
  // Colon-separated override exists for unit tests.
  if (process.env.SOAK_DISK_CHECK_DIRS) return process.env.SOAK_DISK_CHECK_DIRS.split(':');
  return ['/tmp', SOAK_DIR];
}
function rotateLogs(files) {
  for (const f of files || [logFile, stdoutLogFile]) {
    try {
      if (!fs.existsSync(f)) continue;
      const lines = fs.readFileSync(f, 'utf8').split('\n');
      if (lines.length > ROTATE_KEEP_LINES) {
        fs.writeFileSync(f, lines.slice(-ROTATE_KEEP_LINES).join('\n'));
        log('WARN', `DISK: rotated ${path.basename(f)} to last ${ROTATE_KEEP_LINES} lines`);
      }
    } catch { /* best effort: rotation must never crash the harness */ }
  }
  try {
    const cutoff = Date.now() - 24 * 3600 * 1000;
    for (const name of fs.readdirSync('/tmp')) {
      if (!name.startsWith('soak-scratch-')) continue;
      const p = path.join('/tmp', name);
      const st = fs.statSync(p);
      if (st.isFile() && st.mtimeMs < cutoff) {
        fs.unlinkSync(p);
        log('WARN', `DISK: removed stale scratch ${name}`);
      }
    }
  } catch { /* best effort */ }
}
// Returns 'ok' | 'warn' | 'unknown'. fatalOk=true only at startup: below the
// hard floor we exit(1) with a FATAL instead of starting and dying mid-run.
function diskGuard(fatalOk) {
  let dir = null, free = Infinity;
  for (const d of diskCheckDirs()) {
    const f = diskFreeMB(d);
    if (f === null) continue;
    if (f < free) { dir = d; free = f; }
  }
  if (dir === null) return 'unknown';
  if (free < DISK_FATAL_MB && fatalOk) {
    const msg = `DISK FATAL: only ${free.toFixed(0)}MB free on ${dir} (floor ${DISK_FATAL_MB}MB) — refusing to start soak`;
    try { log('FATAL', msg); } catch {}
    console.error(msg);
    process.exit(1);
  }
  if (free < DISK_WARN_MB) {
    log('WARN', `DISK: only ${free.toFixed(0)}MB free on ${dir} (warn ${DISK_WARN_MB}MB) — rotating runaway logs`);
    rotateLogs();
    return 'warn';
  }
  return 'ok';
}

let serverProc = null;
function startServer() {
  return new Promise((resolve, reject) => {
    serverProc = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: { ...process.env, EXPOLINE_PORT: '4320', EXPOLINE_DB: DB_FILE },
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    serverProc.on('error', reject);
    const t0 = Date.now();
    (async () => {
      while (Date.now() - t0 < 30000) {
        try {
          const r = await fetch(BASE + '/api/health');
          if (r.ok) return resolve();
        } catch {}
        await sleep(500);
      }
      reject(new Error('server did not become healthy'));
    })();
  });
}
function killServer() {
  return new Promise((resolve) => {
    if (!serverProc || serverProc.exitCode !== null) return resolve();
    serverProc.on('exit', () => resolve());
    try { process.kill(serverProc.pid, 'SIGKILL'); } catch {}
    setTimeout(resolve, 5000);
  });
}

const tokens = {};
async function login(pin, role) {
  if (tokens[role]) return tokens[role];
  const r = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin }),
  });
  const d = await r.json();
  tokens[role] = d.token;
  return d.token;
}
async function api(method, path, role, body, pin) {
  const pins = { server: '1111', kitchen: '2222', manager: '2580' };
  let tok = await login(pin || pins[role], role);
  let r = await fetch(BASE + path, {
    method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401) {
    delete tokens[role];
    tok = await login(pins[role], role);
    r = await fetch(BASE + path, {
      method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok },
      body: body ? JSON.stringify(body) : undefined,
    });
  }
  let data = null;
  try { data = await r.json(); } catch {}
  return { status: r.status, data };
}

let MENU = [];
async function loadMenu() {
  const { data } = await api('GET', '/api/menu', 'server');
  MENU = data;
}
const allItems = () => MENU.flatMap(c => c.items.map(i => ({ ...i, cat: c.name })));

/* ---- invariant: money math on a check ---- */
async function verifyCheckMath(checkId) {
  const { data } = await api('GET', `/api/checks/${checkId}`, 'server');
  if (!data || !data.totals) { critical(`check ${checkId}: no totals returned`); return; }
  const t = data.totals;
  const items = (data.items || []).filter(i => ['held', 'sent', 'fulfilled'].includes(i.state));
  const sub = items.reduce((s, i) => s + i.qty * i.unit_price_cents, 0);
  const sur = Math.round(sub * 0.05);
  const sc = (data.guest_count || 0) >= 8 ? Math.round(sub * 0.18) : 0;
  const tax = Math.round((sub + sur + sc) * 0.0775); // CA: mandatory service charge is part of the taxable sale (CDTFA Pub 22)
  const total = sub + sur + sc + tax;
  metrics.invariant_checks += 5;
  if (t.subtotal !== sub) critical(`check ${checkId}: subtotal ${t.subtotal} != ${sub}`);
  if (t.surcharge !== sur) critical(`check ${checkId}: surcharge ${t.surcharge} != ${sur}`);
  if (t.service_charge !== sc) critical(`check ${checkId}: service_charge ${t.service_charge} != ${sc}`);
  if (t.tax !== tax) critical(`check ${checkId}: tax ${t.tax} != ${tax}`);
  if (t.total !== total) critical(`check ${checkId}: total ${t.total} != ${total}`);
}

/* ---- one full diner-party lifecycle ---- */
async function lifecycle(workerId) {
  const items = allItems();
  const foods = items.filter(i => (i.item_type === 'food' || !i.item_type) && i.price_cents > 0);
  const drinks = items.filter(i => i.item_type === 'drink');
  // find a free table
  const { data: zones } = await api('GET', '/api/zones', 'server');
  const tables = zones.flatMap(z => z.tables.map(t => ({ ...t, zone: z.name })));
  const free = tables.filter(t => !t.open_check_id);
  if (!free.length) { await sleep(5000); return; }
  const table = pick(free);
  const guests = rnd(1, 8);
  const open = await api('POST', '/api/checks', 'server',
    { table_id: table.id, guest_count: guests, tab_name: `soak-w${workerId}` });
  if (open.status !== 201) { metrics.errors++; return; }
  const checkId = open.data.id;

  const nItems = rnd(1, 6);
  for (let k = 0; k < nItems; k++) {
    const pool = Math.random() < 0.35 && drinks.length ? drinks : foods;
    const it = pick(pool);
    const seat = rnd(1, guests);
    const qty = Math.random() < 0.15 ? 2 : 1;
    const r = await api('POST', `/api/checks/${checkId}/items`, 'server',
      { menu_item_id: it.id, seat, qty });
    if (r.status === 201) metrics.items_added++;
  }
  await api('POST', `/api/checks/${checkId}/send`, 'server', {});

  // kitchen bumps a sample of tickets
  if (Math.random() < 0.7) {
    const { data: tickets } = await api('GET', '/api/kds/tickets', 'kitchen');
    for (const t of (tickets || []).slice(0, 3)) {
      await api('POST', `/api/kds/tickets/${t.id}/bump`, 'kitchen', { status: 'fulfilled' });
    }
  }

  // occasional split (never on 8-tops — API blocks it); follow the children after
  let activeChecks = [checkId];
  if (guests < 8 && Math.random() < 0.2) {
    const sp = await api('POST', `/api/checks/${checkId}/split`, 'server', { mode: 'even', parts: 2 });
    if (sp.status === 200 && Array.isArray(sp.data.checks) && sp.data.checks.length) {
      activeChecks = sp.data.checks; // source auto-closes when emptied — pay/close the children
    }
  }

  // pay off every active check in full
  for (const cid of activeChecks) {
    const det = await api('GET', `/api/checks/${cid}`, 'server');
    if (!det.data || det.data.status === 'closed') continue;
    let balance = det.data?.totals?.balance ?? 0;
  if (balance > 0) {
    if (Math.random() < 0.4 && balance > 1000) {
      // split tender: cash partial + card remainder
      const cashPart = Math.floor(balance / 2);
      await api('POST', `/api/checks/${cid}/payments`, 'server',
        { method: 'cash', amount_cents: cashPart });
      metrics.payments++;
      const d2 = await api('GET', `/api/checks/${cid}`, 'server');
      balance = d2.data?.totals?.balance ?? 0;
    }
    if (balance > 0) {
      const tip = Math.random() < 0.6 ? Math.round(balance * 0.2) : 0;
      const pr = await api('POST', `/api/checks/${cid}/payments`, 'server',
        { method: Math.random() < 0.7 ? 'card_demo' : 'cash', amount_cents: balance, tip_cents: tip });
      if (pr.status === 201) metrics.payments++;
      else { metrics.errors++; log('ERROR', `payment failed on check ${cid}: ${pr.status}`); }
    }
    await verifyCheckMath(cid);
    const close = await api('POST', `/api/checks/${cid}/close`, 'server', {});
    if (close.status !== 200) { metrics.errors++; log('ERROR', `close failed on check ${cid}: ${close.status}`); }
    } // end if balance > 0
  } // end for activeChecks
  // rare manager refund (on the first active check)
  if (Math.random() < 0.03) {
    const d3 = await api('GET', `/api/checks/${activeChecks[0]}`, 'server');
    const pay = (d3.data?.payments || []).find(p => p.method === 'card_demo' && (p.refunded_cents || 0) < p.amount_cents);
    if (pay) await api('POST', `/api/payments/${pay.id}/refund`, 'manager', { amount_cents: Math.min(500, pay.amount_cents) });
  }
  metrics.lifecycles++;
}

/* ---- spike: N concurrent order bursts ---- */
async function spike(n, expectChaos = false) {
  log('INFO', `SPIKE starting: ${n} concurrent order bursts${expectChaos ? ' (chaos burst — failures expected)' : ''}`);
  const t0 = Date.now();
  const items = allItems().filter(i => i.price_cents > 0);
  async function openOnFreeTable(i) {
    // retry a few times: under 400-way contention another task may grab the table first
    for (let attempt = 0; attempt < 6; attempt++) {
      const { data: zones } = await api('GET', '/api/zones', 'server');
      const free = zones.flatMap(z => z.tables).filter(t => !t.open_check_id);
      if (!free.length) { await sleep(rnd(50, 300)); continue; }
      const table = pick(free);
      const open = await api('POST', '/api/checks', 'server',
        { table_id: table.id, guest_count: rnd(1, 6), tab_name: `spike-${i}` });
      if (open.status === 201) return open.data.id;
      if (open.status === 400) continue; // table taken by a racing task — retry
      return 'open-fail:' + open.status;
    }
    return 'table-contention';
  }
  const tasks = Array.from({ length: n }, async (_, i) => {
    try {
      const cid = await openOnFreeTable(i);
      if (typeof cid === 'string') return cid;
      const it = pick(items);
      await api('POST', `/api/checks/${cid}/items`, 'server', { menu_item_id: it.id, seat: 1, qty: 1 });
      await api('POST', `/api/checks/${cid}/send`, 'server', {});
      const det = await api('GET', `/api/checks/${cid}`, 'server');
      const bal = det.data?.totals?.balance ?? 0;
      if (bal > 0) await api('POST', `/api/checks/${cid}/payments`, 'server', { method: 'card_demo', amount_cents: bal });
      await api('POST', `/api/checks/${cid}/close`, 'server', {});
      await verifyCheckMath(cid);
      return 'ok';
    } catch (e) { return 'error:' + e.message; }
  });
  const results = await Promise.allSettled(tasks);
  const vals = results.map(r => r.status === 'fulfilled' ? r.value : 'rejected');
  const ok = vals.filter(v => v === 'ok').length;
  const contention = vals.filter(v => v === 'table-contention').length;
  const dt = Date.now() - t0;
  metrics.spikes++;
  metrics.spike_results.push({ at: new Date().toISOString(), n, ok, contention, ms: dt });
  log('INFO', `SPIKE done: ${ok}/${n} ok, ${contention} table-contention, in ${dt}ms`);
  if (!expectChaos && ok < n * 0.95) critical(`spike success rate ${(100 * ok / n).toFixed(1)}% below 95%`);
  saveMetrics();
}

/* ---- chaos: SIGKILL the server mid-burst, restart, verify integrity ---- */
async function chaos() {
  log('INFO', 'CHAOS: killing server mid-service');
  // start a burst, then kill halfway through (burst failures expected — exempt from threshold)
  const burst = spike(60, true);
  await sleep(rnd(500, 2000));
  await killServer();
  metrics.chaos_kills++;
  log('INFO', 'CHAOS: server killed, verifying port down');
  await sleep(3000);
  let down = false;
  try { await fetch(BASE + '/api/health'); } catch { down = true; }
  if (!down) critical('chaos: server still responding after SIGKILL');
  await burst.catch(() => {});
  log('INFO', 'CHAOS: restarting server');
  await startServer();
  // integrity check
  try {
    const out = execFileSync(process.execPath, ['-e',
      `const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(${JSON.stringify(CHAOS_DB_FILE)});console.log(JSON.stringify(db.prepare('PRAGMA integrity_check').get()));`
    ], { cwd: ROOT }).toString();
    if (!out.includes('ok')) critical('chaos: integrity_check failed: ' + out);
    else log('INFO', 'CHAOS: integrity_check ok');
  } catch (e) { critical('chaos: integrity_check error: ' + e.message); }
  // invariant: no paid/closed check with positive balance; totals reconcile
  try {
    const out = execFileSync(process.execPath, ['-e', `
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync(${JSON.stringify(CHAOS_DB_FILE)});
const bad=db.prepare("SELECT id,total_cents FROM checks WHERE status IN ('paid','closed') AND (total_cents - (SELECT COALESCE(SUM(amount_cents),0)-COALESCE(SUM(refunded_cents),0) FROM payments WHERE payments.check_id=checks.id)) > 0").all();
console.log(JSON.stringify(bad));`], { cwd: ROOT }).toString();
    const bad = JSON.parse(out);
    if (bad.length) critical('chaos: checks with positive balance after pay/close: ' + JSON.stringify(bad.slice(0, 5)));
    else log('INFO', 'CHAOS: no balance anomalies');
  } catch (e) { critical('chaos: anomaly query error: ' + e.message); }
  // finance reconciliation
  try {
    const d = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const { data } = await api('GET', `/api/finance/payouts?date=${d}`, 'manager');
    const lhs = (data.card_volume_cents || 0) - (data.refunds_cents || 0) - (data.stripe_fees_cents || 0);
    metrics.invariant_checks++;
    if (data.expected_payout_cents !== lhs) critical(`chaos: finance mismatch ${data.expected_payout_cents} != ${lhs}`);
    else log('INFO', `CHAOS: finance reconciles (vol=${data.card_volume_cents} ref=${data.refunds_cents} fees=${data.stripe_fees_cents})`);
  } catch (e) { critical('chaos: finance check error: ' + e.message); }
  await loadMenu();
  saveMetrics();
}

async function worker(id) {
  while (Date.now() < END) {
    try { await lifecycle(id); }
    catch (e) { metrics.errors++; log('ERROR', `worker ${id}: ${e.message}`); }
    await sleep(rnd(2000, 10000));
  }
}

const END = Date.now() + DURATION_MS;
async function main() {
  // Disk guard FIRST: refuse to start below the hard floor rather than
  // dying mid-run. (Writes FATAL to stderr + exits before any server/DB work.)
  diskGuard(true);
  setStatus('RUNNING');
  log('INFO', `soak starting: ${DURATION_MS / 3600 / 1000}h, ${WORKERS} workers`);
  // fresh DB
  for (const f of [DB_FILE, DB_FILE + '-wal', DB_FILE + '-shm']) {
    try { fs.unlinkSync(f); } catch {}
  }
  await startServer();
  await loadMenu();
  log('INFO', 'server healthy, menu loaded');

  // Periodic disk guard (warn + rotate only; never exits mid-run).
  setInterval(() => { try { diskGuard(false); } catch {} }, 15 * 60 * 1000).unref();

  let nextSpike = Date.now() + SPIKE_EVERY_MS;
  let nextChaos = Date.now() + CHAOS_EVERY_MS;
  const workers = Array.from({ length: WORKERS }, (_, i) => worker(i));
  const scheduler = (async () => {
    while (Date.now() < END) {
      const now = Date.now();
      if (now >= nextChaos) { nextChaos = now + CHAOS_EVERY_MS; await chaos().catch(e => critical('chaos failed: ' + e.message)); }
      else if (now >= nextSpike) { nextSpike = now + SPIKE_EVERY_MS; await spike(SPIKE_ORDERS).catch(e => critical('spike failed: ' + e.message)); }
      saveMetrics();
      await sleep(30000);
    }
  })();
  await Promise.all([...workers, scheduler]);
  saveMetrics();
  if (metrics.criticals > 0) {
    setStatus('FAILED:' + metrics.criticals + ' criticals');
    log('INFO', `soak COMPLETE with ${metrics.criticals} CRITICALs`);
  } else {
    setStatus('COMPLETE');
    log('INFO', 'soak COMPLETE: all green');
  }
  await killServer();
  process.exit(0);
}

// Gate the entry point so the disk-guard helpers are unit-testable via
// require() without launching a soak run.
if (require.main === module) {
  main().catch(e => {
    try { log('FATAL', e.stack || e.message); } catch {}
    try { setStatus('FAILED:' + e.message); } catch {}
    process.exit(1);
  });
} else {
  module.exports = { diskFreeMB, diskGuard, rotateLogs, diskCheckDirs, DISK_WARN_MB, DISK_FATAL_MB };
}
