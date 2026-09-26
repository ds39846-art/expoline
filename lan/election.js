'use strict';
/* LAN site brain — discovery + election.
 *
 * Discovery: every node multicasts a JSON heartbeat every heartbeatMs on
 *   EXPOLINE_LAN_MCAST:EXPILINE_LAN_MCAST_PORT (default 239.255.77.1:55477).
 *   Payload: {v, type:'hb', device_id, site_slug, priority, port, uptime_s, lamport, ts}.
 *   EXPOLINE_LAN_PEERS="host:port,..." adds unicast seeds for APs with
 *   client-isolation (multicast blocked) — heartbeats are unicast to each
 *   seed as well as multicast, AND each seed's /api/brain/status is polled
 *   over HTTP (TCP) every round as a heartbeat equivalent. Seed ports are
 *   the peer's HTTP ports.
 *
 * Election: each node independently computes the winner from the set of
 *   alive peers (same site_slug, seen within missedToDie heartbeats):
 *   lowest priority value wins; ties break on lexicographically smallest
 *   device_id. No leader messages, no split votes — every node reaches the
 *   same answer from the same peer set. The wall terminal is priority 0;
 *   handhelds 10+.
 *
 * This is the production counterpart of the offline-ladder brain.js
 * prototype (which simulated rounds in-process). RISKS.md #1 still applies:
 * real restaurant WiFi (AP isolation, multicast storms) needs on-site
 * testing; the unicast seed list is the documented fallback.
 */

const dgram = require('node:dgram');

function makeElection(cfg, siteSlug, getLamport) {
  const self = {
    device_id: cfg.deviceId,
    site_slug: siteSlug,
    priority: cfg.priority,
    port: cfg.port,
  };
  const peers = new Map(); // device_id -> {device_id, site_slug, priority, port, host, last_seen, uptime_s}
  let socket = null;
  let timer = null;
  let startedAt = Date.now();
  const log = (...a) => console.log('[lan/election]', ...a);

  function heartbeatPayload() {
    return JSON.stringify({
      v: 1, type: 'hb',
      device_id: self.device_id, site_slug: self.site_slug,
      priority: self.priority, port: self.port,
      uptime_s: Math.floor((Date.now() - startedAt) / 1000),
      lamport: getLamport(),
      ts: Date.now(),
    });
  }

  function onMessage(buf, rinfo) {
    let msg;
    try { msg = JSON.parse(buf.toString('utf8')); } catch { return; }
    if (!msg || msg.type !== 'hb' || msg.v !== 1) return;
    if (msg.device_id === self.device_id) return; // ignore our own echo
    if (msg.site_slug !== siteSlug) return;       // not our restaurant
    peers.set(msg.device_id, {
      device_id: String(msg.device_id),
      site_slug: String(msg.site_slug),
      priority: Number.isFinite(msg.priority) ? msg.priority : 99,
      port: Number.isFinite(msg.port) ? msg.port : 0,
      host: rinfo.address,
      uptime_s: msg.uptime_s | 0,
      last_seen: Date.now(),
    });
  }

  function sendHeartbeat() {
    if (!socket) return;
    const payload = heartbeatPayload();
    const buf = Buffer.from(payload, 'utf8');
    try { socket.send(buf, cfg.mcastPort, cfg.mcastGroup); } catch { /* ignore */ }
    for (const seed of cfg.seedPeers) {
      const [host, port] = seed.split(':');
      const p = parseInt(port || cfg.mcastPort, 10);
      if (host) { try { socket.send(buf, p, host); } catch { /* ignore */ } }
    }
  }

  /* HTTP seed poll (TCP fallback). Treats a live /api/brain/status as a
   * heartbeat: works through AP client isolation and where UDP is blocked.
   * Seed ports are the peer's HTTP ports. */
  async function pollSeeds() {
    for (const seed of cfg.seedPeers) {
      const [host, port] = seed.split(':');
      if (!host || !port) continue;
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 1500);
      try {
        const resp = await fetch(`http://${host}:${port}/api/brain/status`, { signal: ctl.signal });
        if (!resp.ok) continue;
        const body = await resp.json();
        const lan = body.lan || {};
        const deviceId = lan.device_id || body.device_id;
        if (!deviceId || deviceId === self.device_id) continue;
        if (body.site_slug && body.site_slug !== siteSlug) continue;
        peers.set(deviceId, {
          device_id: String(deviceId),
          site_slug: String(body.site_slug || siteSlug),
          priority: Number.isFinite(body.priority) ? body.priority : 99,
          port: parseInt(port, 10),
          host,
          uptime_s: body.uptime_s | 0,
          last_seen: Date.now(),
          via: 'http-seed',
        });
      } catch { /* peer not reachable this round */ }
      finally { clearTimeout(t); }
    }
  }

  function prune() {
    const deadline = Date.now() - cfg.missedToDie * cfg.heartbeatMs;
    for (const [id, p] of peers) {
      if (p.last_seen < deadline) peers.delete(id);
    }
  }

  /* Deterministic election: alive candidates sorted by
   * (priority asc, device_id asc); the first wins. */
  function computeBrain() {
    prune();
    const cands = [{
      device_id: self.device_id, priority: self.priority, self: true,
    }];
    for (const p of peers.values()) cands.push({ device_id: p.device_id, priority: p.priority, self: false, peer: p });
    cands.sort((a, b) => (a.priority - b.priority) ||
      (a.device_id < b.device_id ? -1 : a.device_id > b.device_id ? 1 : 0));
    return cands[0] || null;
  }

  function isBrain() {
    const w = computeBrain();
    return !!w && w.self === true;
  }

  function peerList() {
    prune();
    return [...peers.values()].map((p) => ({
      device_id: p.device_id, priority: p.priority, host: p.host, port: p.port,
      uptime_s: p.uptime_s, last_seen_ms_ago: Date.now() - p.last_seen,
    }));
  }

  function start() {
    socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    socket.on('error', (err) => {
      // Multicast may be unavailable in this environment; election can
      // still work via EXPOLINE_LAN_PEERS unicast seeds. Never crash boot.
      log('socket error (continuing without multicast):', err.message);
    });
    socket.on('message', onMessage);
    socket.bind(cfg.hbPort, () => {
      try {
        socket.addMembership(cfg.mcastGroup);
        socket.setMulticastLoopback(true);
        socket.setMulticastTTL(2); // stay on the LAN segment
      } catch (e) {
        log('multicast join failed (unicast seeds still work):', e.message);
      }
      try { socket.setBroadcast(true); } catch { /* ignore */ }
    });
    if (socket.unref) socket.unref();
    sendHeartbeat();
    pollSeeds();
    timer = setInterval(() => { sendHeartbeat(); pollSeeds(); prune(); }, cfg.heartbeatMs);
    if (timer.unref) timer.unref();
    log(`discovery on ${cfg.mcastGroup}:${cfg.mcastPort} (bind :${cfg.hbPort}) as ${self.device_id} (priority ${self.priority})`);
  }

  function stop() {
    if (timer) clearInterval(timer);
    if (socket) { try { socket.close(); } catch { /* ignore */ } socket = null; }
  }

  return {
    self, start, stop, isBrain, computeBrain, peerList,
    // test hook: inject a peer as if a heartbeat arrived
    _injectPeer: (p) => peers.set(p.device_id, Object.assign({ last_seen: Date.now() }, p)),
  };
}

module.exports = { makeElection };
