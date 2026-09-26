'use strict';
/* LAN site brain — lifecycle wiring.
 *
 * init(app, ctx) — called once from server.js (marked integration point).
 * Does nothing at all unless EXPOLINE_LAN=1, so single-server mode is
 * untouched. When enabled:
 *   1. runs the additive lan_* migrations,
 *   2. registers /api/sync/* routes,
 *   3. starts UDP heartbeat discovery + election,
 *   4. starts mDNS/DNS-SD advertisement (best-effort),
 *   5. starts the standby gossip-pull loop (converge toward the brain's log),
 *   6. starts the WAN upload-queue drain (no-op unless EXPOLINE_CLOUD_URL).
 *
 * Gossip direction: bidirectional anti-entropy. Standbys reconcile
 * op_id sets with the brain every round (GET /api/sync/opids): missing
 * ops are PULLED (GET /api/sync/log) and applied via receiveBatch, and
 * local-only ops are PUSHED back (POST /api/sync/gossip) — so a rejoined
 * dead brain's unique ops merge into the current brain without waiting
 * for it to be elected again. All idempotent, so a standby that missed an
 * hour converges without a full copy (RISKS.md #7 asks for Merkle
 * anti-entropy; op_id-set reconcile is the honest v1: correct, just
 * chattier than Merkle on long partitions).
 *
 * A restarted dead brain rejoins as a standby, pulls the current brain's
 * log, and pushes its own surviving ops — no confirmed op is ever lost
 * while its disk survives (DESIGN.md §6: the log is the database).
 */

const cfg = require('./config');
const store = require('./store');
const { makeElection } = require('./election');
const { makeMdns } = require('./mdns');
const { registerSyncRoutes } = require('./http');

function init(app, ctx) {
  const noop = { stop() {}, isBrain: () => false, status: () => ({ lan_enabled: false }) };
  if (!cfg.enabled) return noop;
  const { db, siteSlug } = ctx;
  const log = (...a) => console.log('[lan]', ...a);

  store.migrate(db);
  log(`migrations ok (device ${cfg.deviceId}, priority ${cfg.priority}, site ${siteSlug})`);

  const election = makeElection(cfg, siteSlug, () => store.lamport(db));
  registerSyncRoutes(app, Object.assign({}, ctx, { election }));
  election.start();

  const mdns = makeMdns(cfg, siteSlug);
  mdns.start();

  // --- standby gossip pull: converge toward the brain's op log ---
  // We need a staff token for the brain's authed endpoints. The token map
  // lives in server.js; ctx.tokenFor(pin) is the marked integration hook
  // (logs in the server PIN against the LOCAL db — same seed on all nodes).
  // --- standby gossip: bidirectional anti-entropy with the brain ---
  // Auth: bearer tokens are node-local, so the standby logs in to the
  // BRAIN with the configured gossip PIN (EXPOLINE_LAN_GOSSIP_PIN) and
  // caches the brain-issued token. Without the PIN there is no secure
  // cross-node auth — the loop warns once and skips.
  let gossipTimer = null;
  let lastBrainSeen = null;
  let brainToken = null;
  let brainTokenFor = null;
  let warnedNoPin = false;
  async function getBrainToken(brain) {
    if (brainToken && brainTokenFor === brain.device_id) return brainToken;
    brainToken = null; brainTokenFor = null;
    if (!cfg.gossipPin) {
      if (!warnedNoPin) {
        warnedNoPin = true;
        log('WARN: EXPOLINE_LAN_GOSSIP_PIN not set — standbys cannot authenticate to the brain, no gossip convergence');
      }
      return null;
    }
    try {
      const resp = await fetch(`http://${brain.peer.host}:${brain.peer.port}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: cfg.gossipPin }),
      });
      if (!resp.ok) { log(`gossip login to ${brain.device_id} failed: HTTP ${resp.status}`); return null; }
      const body = await resp.json();
      if (!body || !body.token) return null;
      brainToken = body.token; brainTokenFor = brain.device_id;
      return brainToken;
    } catch (e) {
      log('gossip login failed:', e.message);
      return null;
    }
  }
  async function gossipOnce() {
    try {
      if (election.isBrain()) { lastBrainSeen = election.self.device_id; return; }
      const brain = election.computeBrain();
      if (!brain || !brain.peer || !brain.peer.host || !brain.peer.port) return;
      if (lastBrainSeen !== brain.device_id) {
        log(`following new brain ${brain.device_id} (priority ${brain.priority})`);
        lastBrainSeen = brain.device_id;
      }
      const token = await getBrainToken(brain);
      if (!token) return;
      const base = `http://${brain.peer.host}:${brain.peer.port}`;
      const auth = { Authorization: 'Bearer ' + token };
      // Reconcile by op_id set (correct across partitions; lamport clocks
      // alone are not a safe "brain lacks this op" test).
      const idsResp = await fetch(`${base}/api/sync/opids`, { headers: auth });
      if (idsResp.status === 401) { brainToken = null; brainTokenFor = null; return; }
      if (!idsResp.ok) return;
      const brainIds = new Set((((await idsResp.json()) || {}).op_ids) || []);
      const myIds = store.opIds(db);
      const mySet = new Set(myIds);
      const toPull = [...brainIds].filter((id) => !mySet.has(id));
      const toPush = myIds.filter((id) => !brainIds.has(id));
      if (toPull.length) {
        const logResp = await fetch(`${base}/api/sync/log?since=0`, { headers: auth });
        if (!logResp.ok) return;
        const envelopes = ((((await logResp.json()) || {}).envelopes) || [])
          .filter((e) => e && toPull.includes(e.op_id));
        if (envelopes.length) {
          // Ops were already authorized at the brain — re-apply trusted.
          const out = store.receiveBatch(db, ctx.helpers, siteSlug, null, envelopes, { viaGossip: true });
          const applied = out.ok ? out.results.filter((r) => r.ok && !r.replayed).length : 0;
          if (applied) log(`gossip: pulled ${applied} ops from ${brain.device_id} (log now ${store.logLength(db)})`);
        }
      }
      if (toPush.length) {
        // A rejoined dead brain's unique ops merge back into the current
        // brain here — no confirmed op is lost while its disk survives
        // (DESIGN.md §6: the log is the database).
        const envelopes = store.envelopesFor(db, toPush);
        const pushResp = await fetch(`${base}/api/sync/gossip`, {
          method: 'POST',
          headers: Object.assign({ 'Content-Type': 'application/json' }, auth),
          body: JSON.stringify({ envelopes }),
        });
        if (pushResp.ok) {
          const body = await pushResp.json();
          if (body && body.merged) log(`gossip: pushed ${body.merged} ops to ${brain.device_id}`);
        }
      }
    } catch (e) {
      // Gossip is background convergence — never crash the server.
      log('gossip failed:', e.message);
    }
  }
  gossipTimer = setInterval(gossipOnce, cfg.gossipMs);
  if (gossipTimer.unref) gossipTimer.unref();

  // --- WAN upload queue drain (stub: no cloud endpoint in this build) ---
  let wanTimer = null;
  async function drainWanOnce() {
    try {
      if (!cfg.cloudUrl) return; // queue-only mode; nothing to drain to
      const n = db.prepare('SELECT COUNT(*) AS n FROM lan_wan_queue').get().n;
      if (!n) return;
      log(`wan drain: ${n} queued, cloud=${cfg.cloudUrl} (stub — not implemented in this build)`);
    } catch (e) { log('wan drain failed:', e.message); }
  }
  wanTimer = setInterval(drainWanOnce, cfg.cloudDrainMs);
  if (wanTimer.unref) wanTimer.unref();

  log('LAN site brain enabled');

  function stop() {
    if (gossipTimer) clearInterval(gossipTimer);
    if (wanTimer) clearInterval(wanTimer);
    try { mdns.stop(); } catch { /* ignore */ }
    try { election.stop(); } catch { /* ignore */ }
    log('stopped');
  }

  return {
    stop,
    isBrain: () => election.isBrain(),
    status: () => ({
      lan_enabled: true,
      device_id: election.self.device_id,
      is_brain: election.isBrain(),
      brain: election.computeBrain(),
      peers: election.peerList(),
      lamport: store.lamport(db),
      op_log_length: store.logLength(db),
    }),
  };
}

module.exports = { init, config: cfg };
