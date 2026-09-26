'use strict';
/* LAN site brain — HTTP surface.
 *
 *   POST /api/sync/batch   accept an array of op envelopes, apply via the
 *                          op log (idempotent), return per-op results keyed
 *                          by op_id. This is the one sync primitive; the
 *                          client outbox flushes through it.
 *   GET  /api/sync/status  brain role, lamport, log head, peer list
 *                          (used by standbys + diagnostics).
 *   GET  /api/sync/log?since=<lamport>
 *                          export op-log slice for gossip pull.
 *   POST /api/sync/gossip  {envelopes:[...]} — brain-to-brain log merge
 *                          (idempotent; used when a dead brain rejoins).
 *
 * Auth: staff Bearer token, server or manager role (same bar as the check
 * endpoints — manager-only ops like menu_update are additionally gated
 * per-op in store.applyOp). /api/brain/status stays public (discovery).
 */

const store = require('./store');

const MAX_BATCH_OPS = 1000;

function registerSyncRoutes(app, ctx) {
  const { db, siteSlug, election, helpers: h } = ctx;

  function requireStaff(req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    if (!['server', 'manager'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden: requires role server or manager' });
    }
    next();
  }

  app.post('/api/sync/batch', requireStaff, (req, res) => {
    const ops = req.body && req.body.ops;
    if (!Array.isArray(ops)) {
      return res.status(400).json({ ok: false, error: 'body.ops must be an array of envelopes' });
    }
    if (ops.length === 0) return res.json({ ok: true, results: [] });
    if (ops.length > MAX_BATCH_OPS) {
      return res.status(413).json({ ok: false, error: 'batch_too_large', max: MAX_BATCH_OPS });
    }
    const out = store.receiveBatch(db, h, siteSlug, req.user, ops);
    if (!out.ok && out.error === 'site_mismatch') {
      // Config bug, never retried on another rung — surface loudly.
      return res.status(400).json(out);
    }
    res.json(out);
  });

  app.get('/api/sync/status', requireStaff, (req, res) => {
    const brain = election.computeBrain();
    res.json({
      ok: true,
      device_id: election.self.device_id,
      is_brain: election.isBrain(),
      brain_device_id: brain ? brain.device_id : null,
      site_slug: siteSlug,
      lamport: store.lamport(db),
      op_log_length: store.logLength(db),
      wan_queued: db.prepare('SELECT COUNT(*) AS n FROM lan_wan_queue').get().n,
      peers: election.peerList(),
    });
  });

  app.get('/api/sync/log', requireStaff, (req, res) => {
    const since = parseInt(req.query.since || '0', 10) || 0;
    const envelopes = store.exportLog(db, since);
    res.json({ ok: true, since, count: envelopes.length, envelopes });
  });

  // Lightweight op_id set for anti-entropy reconcile (a full log export
  // every round would be chatty; RISKS.md #7 notes Merkle trees as the
  // future here — op_id sets are the honest v1).
  app.get('/api/sync/opids', requireStaff, (req, res) => {
    res.json({ ok: true, op_ids: store.opIds(db) });
  });

  app.post('/api/sync/gossip', requireStaff, (req, res) => {
    const envelopes = req.body && req.body.envelopes;
    if (!Array.isArray(envelopes)) {
      return res.status(400).json({ ok: false, error: 'body.envelopes must be an array' });
    }
    // Brain-to-brain gossip merge: ops were already authorized at the
    // source brain — re-apply without re-running manager/role gates.
    const out = store.receiveBatch(db, h, siteSlug, req.user, envelopes, { viaGossip: true });
    res.json(Object.assign({ merged: out.ok ? out.results.filter((r) => r.ok && !r.replayed).length : 0 }, out));
  });
}

module.exports = { registerSyncRoutes };
