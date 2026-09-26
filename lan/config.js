'use strict';
/* LAN site brain — configuration.
 * Every knob is an env var; LAN features default OFF so single-server mode
 * is byte-for-byte untouched unless explicitly enabled. */
const os = require('node:os');

function intEnv(name, dflt) {
  const v = parseInt(process.env[name] || '', 10);
  return Number.isFinite(v) && v > 0 ? v : dflt;
}

const PORT = intEnv('EXPOLINE_PORT', intEnv('PORT', 4317));

const cfg = {
  // Master switch. Off by default — single-server mode unchanged.
  enabled: process.env.EXPOLINE_LAN === '1',

  // Stable identity for election tie-breaks. Defaults to host+port so two
  // instances on one box (QA) still get distinct ids.
  deviceId: process.env.EXPOLINE_DEVICE_ID || `${os.hostname()}-${PORT}`,

  // Election: lower priority value wins. The wall-mounted expo terminal
  // should be priority 0 (always plugged in); handhelds/tablets 10+.
  priority: intEnv('EXPOLINE_BRAIN_PRIORITY', 0),

  // Heartbeat channel. UDP multicast; EXPOLINE_LAN_PEERS (comma-separated
  // "host:port") adds unicast seeds for APs with client isolation.
  // Seeds are contacted TWO ways: UDP unicast heartbeat AND an HTTP poll of
  // the peer's /api/brain/status (TCP) — the HTTP poll is the fallback that
  // works through client-isolated APs (and in sandboxes where UDP is
  // blocked). Seed ports are the peer's HTTP ports.
  // EXPOLINE_LAN_HB_PORT overrides the local UDP bind port (needed when
  // several nodes share one host and multicast is unavailable — e.g. in QA).
  mcastGroup: process.env.EXPOLINE_LAN_MCAST || '239.255.77.1',
  mcastPort: intEnv('EXPOLINE_LAN_MCAST_PORT', 55477),
  hbPort: intEnv('EXPOLINE_LAN_HB_PORT', 0) || intEnv('EXPOLINE_LAN_MCAST_PORT', 55477),
  heartbeatMs: intEnv('EXPOLINE_HEARTBEAT_MS', 1000),
  missedToDie: 3, // missed heartbeats before a peer is declared dead
  seedPeers: (process.env.EXPOLINE_LAN_PEERS || '')
    .split(',').map((s) => s.trim()).filter(Boolean),

  // Gossip: standbys pull the brain's op log this often.
  gossipMs: intEnv('EXPOLINE_LAN_GOSSIP_MS', 2000),

  // Staff PIN the standby uses to log in to the BRAIN for gossip.
  // All nodes at a site share the same seed staff/PINs, so one configured
  // PIN works cluster-wide. Without it, cross-node gossip auth fails
  // (bearer tokens are node-local) and standbys cannot converge — the loop
  // logs a one-time warning instead of silently doing nothing.
  gossipPin: process.env.EXPOLINE_LAN_GOSSIP_PIN || null,

  // WAN upload queue drain target. Unset = queue only (no cloud in this
  // build); the queue table is the durable half, drain is a no-op hook.
  cloudUrl: process.env.EXPOLINE_CLOUD_URL || '',
  cloudDrainMs: intEnv('EXPOLINE_CLOUD_DRAIN_MS', 5000),

  // mDNS/DNS-SD advertisement of _expoline._tcp.local (best-effort).
  mdnsEnabled: process.env.EXPOLINE_LAN_MDNS !== '0',
  port: PORT,
};

module.exports = cfg;
