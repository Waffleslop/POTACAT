# Remote Launcher from anywhere — scope

Status: BUILT on the desktop 2026-10-27 (Casey: option A, restart from anywhere ON by default).
Trigger: N8JMS (BUG-N8JMS-20261027-2EED1D), "restart POTACAT from ECHOCAT works on my home
WiFi, spins and times out anywhere else."

What was built, and what changed from the scope below:
- Phone (echocat, potacat-app 47adbbe): Tailscale fallback rung and device-token Bearer
  (steps 1 and 2 of `potacat-app/docs/desktop-handoffs/launcher-anywhere.md`). The open
  question in section 6 is answered: the phone dialled ONLY `device.host:7301` before this.
- Launcher (`scripts/launcher.js`): `authorize()` / `readPairedDevices()` read paired devices
  from the global file AND every profile (not just the active one), `routeOf()` for
  `/launcher/*`, `isTunnelRequest()`, `CloudReplica` (token passed as `TUNNEL_TOKEN` in the
  environment, never argv; polls launcher-config.json every 5 s). Requiring the script no
  longer starts it: `POTACAT.exe --launcher` calls `main()`.
- POTACAT: `launcherCloudSync()` keeps the config's `cloud` block in step with the tunnel,
  the launcher install and `launcherViaCloud`; Settings > ECHOCAT launcher card checkbox
  and status line; bug report `**Launcher:**` line.
- `CloudTunnelManager` respawns its own cloudflared when the cloud says healthy but no
  child is running (the replica makes "healthy" true while ours may be dead).
- Cloud: `DESKTOP_TO_CLOUD_HANDOFF_2026-10-27_LAUNCHER_INGRESS.md` (not deployed).
- Tests: `test/launcher-cloud-test.js`.

## What happens today, and why it is not a bug

The restart button on the phone talks to the Remote Launcher (`scripts/launcher.js`, a
zero-dependency Node script on port 7301 that outlives POTACAT). Two things keep it off the
internet, both deliberate:

1. **Auth is the callsign as a Bearer token.** A callsign is a public string. On the LAN or a
   tailnet that is acceptable; on `n8jms.potacat.com` it would let anyone restart the shack.
2. **The Cloud Tunnel dies with POTACAT.** cloudflared is POTACAT's child process
   (`CloudTunnelManager._spawnCloudflared`), and the cloud's ingress is fixed at
   `https://localhost:7300`. When POTACAT is down there is no tunnel and nothing behind it, so
   the one case a remote restart exists for is the one case the cloud path is gone. The report
   shows exactly this: every cloud dial is "closed before open", every LAN dial times out.

So "restart from anywhere" needs the launcher to carry its own tunnel connector and to accept a
real credential. Three sides: desktop (this repo), cloud (handoff), mobile (handoff).

## Design

### 1. Auth: the launcher accepts the ECHOCAT paired-device token

The phone already holds a per-shack device token (`settings.pairedDevices[].token`, 32 random
bytes, stored in the operator's settings file the launcher already reads for the callsign —
`getPassphrase()` walks the global file and `profiles/<activeProfile>/settings.json`, the same
walk finds `pairedDevices`). No new token, no cloud involvement, no change to pairing:

- `Authorization: Bearer <deviceToken>` is accepted everywhere, compared with
  `crypto.timingSafeEqual`, honouring `expiresAt` the way remote-server.js does.
- The callsign Bearer keeps working for **LAN and tailnet sources only** (the existing web status
  page on the LAN still works). It is refused on tunnel-sourced requests.
- A request is tunnel-sourced when it carries `cf-connecting-ip` (Cloudflare sets it on every
  proxied request) or its `Host` ends in `.potacat.com`. Either marks it.
- Tunnel-sourced rate limiting keys on `cf-connecting-ip`, not the socket address (every
  tunnel request arrives from 127.0.0.1 via cloudflared).
- A revoked device (removed from My devices) stops working at the launcher on its next read of
  the settings file. The launcher re-reads the file per request today; keep that.

### 2. Path: the launcher answers under `/launcher/` as well as `/`

cloudflared does not rewrite paths, so the cloud routes `<call>.potacat.com/launcher/*` to
`localhost:7301` and the launcher strips the prefix: `/launcher/status`, `/launcher/start`,
`/launcher/restart`, `/launcher/stop`. Bare `/status` etc. stay for the LAN.

Tunnel-sourced policy (the ECHOCAT Web gate lesson: nothing anonymous leaks version or call):
- `GET /launcher/` (the HTML status page) → 404. The page is a LAN convenience only.
- Every other `/launcher/*` without a valid device token → 401 with a constant body.
- `/status` already needs auth; the authed reply gains `cloud: 'replica-up' | 'replica-off' |
  'no-token'` so the phone and the bug report can see the state.

### 3. Process: the launcher runs a cloudflared **replica**

Cloudflare tunnels accept several connectors on the same tunnel token ("replicas"); requests
are balanced across them and the ingress rules belong to the tunnel, not the connector. So the
launcher runs its own `cloudflared tunnel run --protocol http2 --token <token>` beside
POTACAT's, same binary, same token:

- POTACAT up: two connectors, both pointing at the same localhost origins. Nothing changes.
- POTACAT down: the launcher's connector keeps `<call>.potacat.com` answering. `/` → 502 from
  cloudflared (nothing on 7300), which the phone can tell apart from "closed before open"
  (tunnel gone). `/launcher/*` → the launcher.
- Rejected alternative: the launcher owns the only cloudflared and POTACAT asks it. The
  launcher is opt-in, so every station without it would need the old path kept too, and
  `CloudTunnelManager` would grow a second mode. The replica leaves POTACAT's tunnel code
  untouched.

Supervision is the same shape as POTACAT's: spawn, exponential backoff on exit, stop on
SIGTERM/exit, log to stdout (the launcher's existing log). Memory cost is one more cloudflared
process (~40 MB) on launcher-equipped shacks only.

**Token handoff — decision for Casey.** POTACAT keeps the tunnel token encrypted with Electron
`safeStorage` in `cloud-tunnel.json`. The launcher is plain Node (`ELECTRON_RUN_AS_NODE`), so it
cannot decrypt it. Options:

- **A (recommended):** POTACAT writes `tunnelToken`, `cloudHost` and `cloudflaredPath` into
  `launcher-config.json` (mode 0600) whenever the tunnel is provisioned/persisted and the
  launcher is installed, and removes them on tunnel revoke or launcher uninstall. A plaintext
  copy of a secret that is otherwise encrypted — but the same file's neighbour already holds
  every device token in plaintext (`settings-secrets` decision: storage at rest is plaintext
  on purpose, same-user malware defeats keychain crypto). Survives reboots with no POTACAT
  run, which is the case that matters.
- **B:** POTACAT pushes the token to the running launcher over localhost
  (`POST 127.0.0.1:7301/reload`, callsign auth as today) and the launcher keeps it in memory
  only. No secret on disk; but after a reboot where POTACAT never came up, no replica, so no
  remote restart — exactly the scenario the feature is for.

Either way the launcher learns the change at once: fs.watch on `launcher-config.json` (A) or
the push (B).

`cloudflaredPath`: the launcher is copied to userData and cannot `require('lib/cloudflared')`;
POTACAT writes the resolved path into the config (A) so the arch-mismatch logic stays in one
place. The launcher falls back to a system `cloudflared` on PATH.

### 4. Desktop UI and diagnostics

- Settings > ECHOCAT, launcher card: a line "Reachable from anywhere through your Cloud Tunnel"
  when both are installed, "Install the Cloud Tunnel to restart from outside your network"
  otherwise. Setting `launcherViaCloud` (GLOBAL_KEY, default **on** — the launcher install is
  the opt-in, and the device token already controls the whole radio; Casey to confirm).
- Bug report gains a `**Launcher:**` line: installed / running / replica state / last error.
- `[Launcher]` log lines in session.log when POTACAT writes or removes the config.

### 5. Cloud (handoff, potacat-cloudlog)

- `POST /v1/cloud-tunnel/provision` adds an ingress rule **before** the catch-all:
  `{hostname: <call>.potacat.com, path: "^/launcher(/.*)?$", service: "http://localhost:7301"}`.
- Existing tunnels: a one-time migration over the Cloudflare configurations API, or lazily on
  the next status/provision call. Harmless for stations with no launcher (`/launcher/*` → 502).
- No new columns: the phone probes `/launcher/status` rather than reading a registration flag.
- `rateLimitPasses` tiers: `/launcher/*` POSTs count like pass-gate POSTs.

### 6. Mobile (handoff, potacat-app)

- Restart ladder: `lan:7301` → `ts:7301` → `https://<cloudHost>/launcher/restart`, all with
  `Authorization: Bearer <deviceToken>` (keep the callsign fallback for old launchers on LAN).
- Tell the states apart and say so: tunnel gone (closed before open) = "your Mac is off or
  asleep, nothing can reach it"; 502 on `/` + 200 on `/launcher/status` = "POTACAT is not
  running — Restart"; 502 on both = "launcher not installed on this shack".
- Open question for the app: does the restart button dial the launcher at `tsHost` today? If
  it does, Tailscale on both ends is the zero-build answer to N8JMS now.

## Phases and order

1. **Desktop, launcher auth + prefix + tunnel-source policy** (`scripts/launcher.js`,
   `test/launcher-cloud-test.js`: spawn the real launcher on a scratch config dir with fake
   settings; device token accepted, expired refused, callsign refused when `cf-connecting-ip`
   is present, `/launcher/` 404, prefix stripping, rate limit by `cf-connecting-ip`). Useful on
   its own over Tailscale: no more callsign-as-password.
2. **Desktop, replica** (token handoff per the decision above, spawn/supervise with a fake
   cloudflared in tests, UI line, bug-report line, remove on uninstall/revoke).
3. **Cloud ingress rule + migration.** Deploy before the desktop release; harmless on its own.
4. **Mobile ladder + UX.** OTA last, after a desktop release carries 1+2.

Rough size: desktop 1 day including tests; cloud an hour plus the migration; mobile half a day.

## Out of scope, noted

- The five stale device rows in N8JMS's cloud panel (old app installs, plus a second shack
  that is probably his old Mac). Harmless; removable from My devices. A "forget devices not
  seen in 90 days" sweep is a separate small cloud item.
- HTTPS on 7301 itself: unnecessary behind the tunnel (Cloudflare terminates TLS) and still
  blocked on the LAN by the iOS self-signed-cert problem noted in launcher.js.
- Waking a sleeping or powered-off Mac. No tunnel can do that.
