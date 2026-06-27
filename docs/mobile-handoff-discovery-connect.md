# Mobile Handoff — "Discovered" tap connects to nothing

**Audience:** ECHOCAT mobile (iOS) team
**Desktop status:** desktop change shipped (mDNS TXT now carries the LAN IP). Mobile must read it and dial it on tap.
**Origin:** K3SBP 2026-06-27 — phone shows the rig under "Discovered" (mDNS) but tapping it does nothing; the desktop logs *no connection at all*. A saved/paired rig connecting to the same desktop over the same LAN works fine (proven same session: `New connection from 192.168.10.214`, `echocat-mobile/1.0.8 (build 57)`, audio streamed).

---

## TL;DR

The saved-rig connect path works (LAN IP + fingerprint pinning). The **"Discovered" tap path does not** — almost certainly because the only address in the mDNS record is the desktop's **custom SRV host `potacat-<N>-<hostname>.local`**, which the phone can't cleanly resolve/validate (the served cert is `*.ts.net`, trusted **by pinned fingerprint, not by name**). So the tap has no usable dial target.

**Desktop fix (done):** the mDNS **TXT now includes `addr` (this interface's LAN IP) and `port`.** On "Discovered" tap, dial `wss://<addr>:<port>` and **pin the TXT `fingerprint`** — identical to the saved-rig path that already works. Then run the normal v1 handshake.

This is desktop reachability/firewall/cert **all confirmed working** — the only gap is the app's discovery→connect step using a non-dialable name instead of the IP.

---

## mDNS record the app now receives

Service: `_potacat._tcp`, SRV port `7300`, SRV host `potacat-<N>-<hostname>.local`.

TXT keys (all strings):
| key | example | use |
|---|---|---|
| `proto` | `echocat` | sanity filter |
| `name` | `DESKTOP-ABC` | display name for the discovered rig |
| `version` | `1.8.18` | display / compat |
| `fingerprint` | `18:31:99:4C:58:EC:7A:F1:…` (SHA-256, colon-hex, upper) | **pin this** — the cert is `*.ts.net`, so validate by fingerprint, NOT hostname |
| **`addr`** | `192.168.10.237` | **NEW — the LAN IP to dial** |
| **`port`** | `7300` | **NEW — the port to dial** |

> One TXT is published per real LAN interface, each carrying *its own* `addr`. The phone discovers on the interface it can reach, so the `addr` it sees is the one routable from the phone.

---

## Mobile work requested

1. **On "Discovered" tap, build the URL from TXT:** `wss://<addr>:<port>` (e.g. `wss://192.168.10.237:7300`). Prefer TXT `addr`; if absent (older desktop), fall back to the Bonjour-resolved IPv4 address — **do not** dial the `…local` SRV hostname.
2. **Pin the cert by `fingerprint`** from TXT (SHA-256, colon-separated hex, compare case-insensitively). Accept the cert when the fingerprint matches, regardless of the cert's CN/SAN (it's the `*.ts.net` Tailscale cert; the LAN IP won't be in its SAN). This is the same trust path the working saved-rig connect already uses.
3. **Then run the standard v1 handshake** (`hello` → `auth-mode` → `auth-ok` / token) exactly as the paired path does. The desktop side from the WS upgrade onward is unchanged.
4. Optional: store `{addr, port, fingerprint, name}` as a paired rig on first successful connect so subsequent launches skip discovery.

---

## How to tell it's fixed (desktop side)

The desktop now logs the full connection lifecycle (added this session for exactly this debugging). After a correct discovery-tap you should see, in order:
```
[Echo CAT] socket connect from 192.168.10.214      <- TCP reached us (was ABSENT before)
[Echo CAT] New connection from 192.168.10.214       <- WS upgraded
[Echo CAT] Client hello: protocol=1 platform=ios …
```
If instead you see `socket connect …` **then** `TLS handshake failed … client rejected our cert` → the app dialed the IP but isn't pinning the fingerprint (fix step 2). If you see **nothing**, the app still isn't dialing a reachable address (fix step 1).

---

## Desktop references

- mDNS publish + TXT (now with `addr`/`port`): `lib/remote-server.js` `_startMdns()`.
- Connection + TLS-error logging: `lib/remote-server.js` `start()` (`socket connect from`, `tlsClientError`, `clientError`) and `_handleConnection()` (`New connection from`).
- Cert served on 7300 / fingerprint source: `getOrCreateTlsCert()` (Tailscale LE cert preferred; fingerprint published in mDNS is of that exact cert).
