'use strict';
/**
 * Cert SAN regeneration policy — the pure half of cert-pin Phase 1
 * (work item cert-pin-spki-migration).
 *
 * The old rule regenerated the TLS cert whenever ANY non-internal IPv4 on
 * ANY interface was absent from the SAN. A Docker bridge, Hyper-V switch,
 * VPN adapter, or fresh DHCP lease appearing at restart minted a new cert
 * (and, worse, a new KEYPAIR), and every phone pinning the old cert showed
 * "Can't verify <hostname>" with no way forward but re-pairing. The update
 * in "breaks after every update" was incidental — the restart was the
 * trigger.
 *
 * The new rule: regenerate ONLY when the cert fails to cover an identity we
 * actually SERVE OR ADVERTISE —
 *   - the DNS names phones dial: os.hostname(), hostname.local, and the
 *     CURRENT Tailscale MagicDNS name (the tailnet-rename case: a stale
 *     tailscale name in the cert broke iOS pairing until eager reissue was
 *     added — that protection is deliberately KEPT, narrowed, not removed);
 *   - 127.0.0.1 plus the addresses the pairing surface hands out
 *     (RemoteServer.getLocalIPs() — already routed-address filtered, and
 *     the exact list pair links, QRs, and the heartbeat advertise).
 * An interface nobody is told to dial can no longer invalidate every
 * pairing on the account.
 */

/** Build the required-coverage sets from what the server serves/advertises. */
function requiredSanSet({ advertisedIps, hostname, tailscaleHostname }) {
  const ips = new Set(['127.0.0.1']);
  for (const ip of advertisedIps || []) {
    if (ip && typeof ip === 'string') ips.add(ip);
  }
  const dns = new Set();
  if (hostname) {
    dns.add(hostname);
    if (!/\.local$/i.test(hostname)) dns.add(hostname + '.local');
  }
  if (tailscaleHostname) dns.add(tailscaleHostname);
  return { ips, dns };
}

/**
 * Compare a cached cert's SAN coverage against the required set.
 * Returns { regen, missingIps, missingDns } — regen true only when a
 * REQUIRED identity is uncovered.
 */
function certCoverageGaps({ sanIps, sanDns, required }) {
  const missingIps = [...required.ips].filter((ip) => !sanIps.has(ip));
  const missingDns = [...required.dns].filter((d) => !sanDns.has(d));
  return { regen: missingIps.length > 0 || missingDns.length > 0, missingIps, missingDns };
}

module.exports = { requiredSanSet, certCoverageGaps };
