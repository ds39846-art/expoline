'use strict';
/* LAN site brain — mDNS / DNS-SD advertisement (best-effort).
 *
 * Announces `_expoline._tcp.local` so devices and diagnostic tools on the
 * restaurant LAN can discover the brain with zero configuration:
 *   PTR  _expoline._tcp.local        → <device>._expoline._tcp.local
 *   SRV  <device>._expoline._tcp.local → <host>.local:<port>
 *   TXT  site=<slug> priority=<n> device=<id> ver=1
 *   A    <host>.local                → this node's LAN IPv4
 *
 * Minimal RFC 6762/6763 subset: we answer PTR/SRV/TXT/A queries for our
 * records and send periodic unsolicited announcements. Unknown query types
 * are ignored. Everything is wrapped so a failure here never affects boot
 * or the heartbeat election channel (lan/election.js is authoritative for
 * failover; mDNS is the human/tooling discovery half).
 */

const dgram = require('node:dgram');
const os = require('node:os');

const MDNS_GROUP = '224.0.0.251';
const MDNS_PORT = 5353;
const SERVICE = '_expoline._tcp.local';

function lanIpv4() {
  for (const ifs of Object.values(os.networkInterfaces() || {})) {
    for (const i of ifs || []) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return '127.0.0.1';
}

/* ---- minimal DNS codec ---- */
function encodeName(name) {
  const parts = [];
  for (const label of name.split('.')) {
    const b = Buffer.from(label, 'utf8');
    parts.push(Buffer.from([b.length]), b);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}
function decodeName(buf, off) {
  const labels = [];
  let jumped = false;
  let end = off;
  let guard = 0;
  while (guard++ < 64) {
    const len = buf[off];
    if (len === 0) { if (!jumped) end = off + 1; break; }
    if ((len & 0xc0) === 0xc0) {
      const ptr = ((len & 0x3f) << 8) | buf[off + 1];
      if (!jumped) end = off + 2;
      off = ptr; jumped = true;
      continue;
    }
    labels.push(buf.slice(off + 1, off + 1 + len).toString('utf8'));
    off += 1 + len;
    if (!jumped) end = off;
  }
  return { name: labels.join('.'), end };
}
function rr(name, type, ttl, rdata) {
  return Buffer.concat([encodeName(name),
    Buffer.from([(type >> 8) & 0xff, type & 0xff, 0, 1]), // CLASS IN
    Buffer.from([(ttl >>> 24) & 0xff, (ttl >>> 16) & 0xff, (ttl >>> 8) & 0xff, ttl & 0xff]),
    Buffer.from([(rdata.length >> 8) & 0xff, rdata.length & 0xff]), rdata]);
}
const TYPE = { PTR: 12, SRV: 33, TXT: 16, A: 1, ANY: 255 };

function makeMdns(cfg, siteSlug) {
  const log = (...a) => console.log('[lan/mdns]', ...a);
  const instanceName = `${cfg.deviceId}._expoline._tcp.local`;
  const hostName = `${os.hostname().split('.')[0]}.local`;
  const ip = lanIpv4();
  const txtEntries = [
    `site=${siteSlug}`,
    `priority=${cfg.priority}`,
    `device=${cfg.deviceId}`,
    `ver=1`,
  ].map((s) => { const b = Buffer.from(s, 'utf8'); return Buffer.concat([Buffer.from([b.length]), b]); });

  function recordsFor(qname, qtype) {
    const out = [];
    const q = qname.toLowerCase();
    if ((q === SERVICE || qtype === TYPE.ANY)) {
      if (qtype === TYPE.PTR || qtype === TYPE.ANY) {
        out.push(rr(SERVICE, TYPE.PTR, 120, encodeName(instanceName)));
      }
    }
    if (q === instanceName.toLowerCase()) {
      if (qtype === TYPE.SRV || qtype === TYPE.ANY) {
        const rdata = Buffer.concat([
          Buffer.from([0, 0, 0, 0, (cfg.port >> 8) & 0xff, cfg.port & 0xff]),
          encodeName(hostName),
        ]);
        out.push(rr(instanceName, TYPE.SRV, 120, rdata));
      }
      if (qtype === TYPE.TXT || qtype === TYPE.ANY) {
        out.push(rr(instanceName, TYPE.TXT, 120, Buffer.concat(txtEntries)));
      }
    }
    if (q === hostName.toLowerCase() && (qtype === TYPE.A || qtype === TYPE.ANY)) {
      out.push(rr(hostName, TYPE.A, 120, Buffer.from(ip.split('.').map((x) => parseInt(x, 10)))));
    }
    return out;
  }

  function buildResponse(answers, id) {
    const header = Buffer.alloc(12);
    header.writeUInt16BE(id || 0, 0);
    header.writeUInt16BE(0x8400, 2); // response + authoritative
    header.writeUInt16BE(0, 4);
    header.writeUInt16BE(answers.length, 6);
    header.writeUInt16BE(0, 8);
    header.writeUInt16BE(0, 10);
    return Buffer.concat([header, ...answers]);
  }

  function onMessage(buf) {
    if (buf.length < 12) return;
    const id = buf.readUInt16BE(0);
    const flags = buf.readUInt16BE(2);
    if (flags & 0x8000) return; // ignore responses (we don't browse here)
    const qd = buf.readUInt16BE(4);
    let off = 12;
    const answers = [];
    for (let i = 0; i < qd && off < buf.length; i++) {
      const { name, end } = decodeName(buf, off);
      if (end + 4 > buf.length) break;
      const qtype = buf.readUInt16BE(end);
      off = end + 4;
      for (const r of recordsFor(name, qtype)) answers.push(r);
    }
    if (answers.length && socket) {
      try { socket.send(buildResponse(answers, id), MDNS_PORT, MDNS_GROUP); } catch { /* ignore */ }
    }
  }

  function announce() {
    if (!socket) return;
    const answers = [
      ...recordsFor(SERVICE, TYPE.PTR),
      ...recordsFor(instanceName, TYPE.ANY),
      ...recordsFor(hostName, TYPE.A),
    ];
    try { socket.send(buildResponse(answers, 0), MDNS_PORT, MDNS_GROUP); } catch { /* ignore */ }
  }

  let socket = null;
  let timer = null;

  function start() {
    if (!cfg.mdnsEnabled) { log('disabled via EXPOLINE_LAN_MDNS=0'); return; }
    try {
      socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    } catch (e) { log('socket create failed:', e.message); return; }
    socket.on('error', (err) => log('socket error (continuing):', err.message));
    socket.on('message', onMessage);
    try {
      socket.bind(MDNS_PORT, () => {
        try {
          socket.addMembership(MDNS_GROUP);
          socket.setMulticastLoopback(true);
          socket.setMulticastTTL(2);
        } catch (e) { log('multicast join failed:', e.message); }
        announce();
      });
    } catch (e) { log('bind failed:', e.message); socket = null; return; }
    if (socket.unref) socket.unref();
    // Periodic re-announcement (RFC 6762 §8.3 suggests ~2min; we use 30s so
    // newly-joined devices discover the brain quickly on a quiet LAN).
    timer = setInterval(announce, 30000);
    if (timer.unref) timer.unref();
    log(`advertising ${SERVICE} as ${instanceName} → ${hostName}:${cfg.port} (${ip})`);
  }

  function stop() {
    if (timer) clearInterval(timer);
    // Goodbye packet would go here; skip — TTL expiry handles it.
    if (socket) { try { socket.close(); } catch { /* ignore */ } socket = null; }
  }

  return { start, stop, serviceName: SERVICE, instanceName };
}

module.exports = { makeMdns };
