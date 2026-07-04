# Mobile Handoff — Pairing takes ~30 s: race the dial legs, show progress

**Audience:** ECHOCAT mobile (iOS + Android) team
**Desktop status:** no desktop change needed — measured server-side pair time is <100 ms and the QR already carries every dial leg. This is a mobile connect-strategy + UI issue.
**Origin:** K3SBP 2026-07-03 — scanned a fresh pairing QR on an iPhone that was on **cellular** (not the shack Wi-Fi). Pairing succeeded but took ~30 s of blank waiting after the scan.

---

## TL;DR

The QR contains up to three dial legs. The app tries them **sequentially with a long (~30 s) connect timeout**: LAN first, then Tailscale, then cloud. When the phone isn't on the shack LAN, the LAN leg (`wss://192.168.10.x:7300`) is a routing black hole — SYNs go nowhere, no error comes back — so the user stares at nothing for a full OS-level connect timeout before the Tailscale leg is even attempted, and that leg then succeeds in ~1 s.

**Fix: race all legs in parallel (happy-eyeballs style), first success wins, cancel the losers.** With a short per-leg budget as a backstop, worst-case pairing drops from ~30 s to ~2–3 s on any network. Add per-leg progress UI so the wait — whatever remains of it — is visible instead of silent.

---

## Evidence (desktop log, 2026-07-03)

```
01:18:28.007  [Pair-Link] OK ttl=86400s reach=lan+ts        <- QR minted (legs: LAN + Tailscale)
   ... user scans; ~30 s of silence — NO LAN connection attempt ever arrives ...
01:19:03.871  [Echo CAT] socket connect from 100.117.157.35  <- first contact = Tailscale leg
01:19:03.968  [Echo CAT] [Pair] OK ... token=f508ed33…       <- redemption: 97 ms
01:19:04.736  [Echo CAT] New connection from 100.117.157.35  <- WS up
01:19:07.351  [Echo CAT Audio] ICE connected via host/host   <- audio streaming
```

Everything from first packet to working audio: ~3.5 s. Everything before the first packet: the phone timing out on an unreachable LAN dial. (`tailscale status` showed the phone active via a cellular endpoint at the time.)

---

## What the QR / pair link contains

`potacat://pair?token=…&name=…&exp=…&host=wss://<lanIP>:7300&fp=<SHA256hex>&tsHost=<name>.ts.net&cloudHost=<name>.potacat.com`

| param | leg | trust model |
|---|---|---|
| `host` | LAN (`wss://<lanIP>:7300`) | **pin `fp`** (cert SAN is the ts.net name, never the LAN IP) |
| `tsHost` | Tailscale (`wss://<tsHost>:7300`) | CA validation works (Tailscale-issued Let's Encrypt cert); `fp` also matches |
| `cloudHost` | Cloud Tunnel | standard CA validation (Cloudflare edge) |

`tsHost`/`cloudHost` are omitted when unavailable, so 1–3 legs. Desktop builder: `main.js` `pair-link-create` / `echocat-create-pairing-qr`.

---

## Mobile work requested

1. **Parallel leg race.** On scan/redeem, dial **all** legs concurrently. First leg to complete the TLS handshake + token redemption wins; cancel the rest. Keep the existing preference (LAN > Tailscale > cloud) only as a tie-break within a short grace window (e.g. if LAN succeeds within 250 ms of another leg, prefer LAN) — never as a serial gate.
2. **Short per-leg budget.** Even in the race, cap each connect attempt at ~5 s and surface which legs failed and why. Never inherit the OS default (~30–75 s) connect timeout for a leg that has siblings.
3. **Progress UI after scan.** The scan → connected gap must never be blank. Show the legs being tried ("Shack Wi-Fi… ✗ not reachable / Tailscale… ✓ connected") so a cellular user understands why LAN failed and that things are still moving.
4. **Distinct error surfaces.** Timeout ("couldn't reach"), TLS rejection ("reached it, but its certificate doesn't match — regenerate the QR"), and auth rejection (bad/expired token) are different failures needing different user actions. The existing cert-mismatch message is good — extend that clarity to the other two.
5. **Apply the same race to reconnect,** not just first pair. Saved rigs store `lanHost`/`tsHost`/`cloudHost`; today's sequential reconnect has the same worst case whenever the phone changes networks. Related: during a recent desktop-side stale-cert episode the app silently retried a rejected leg every 5–15 s for 14+ minutes with no user-visible state — persistent TLS rejection during background reconnect should surface a banner ("Can't verify <rig> — re-pair may be needed"), not spin forever.
6. **Android parity.** All of the above applies to the Android client; OkHttp's default connect timeout has the same sequential-black-hole failure mode.

---

## How to tell it's fixed (desktop side)

Scan a QR with the phone on **cellular** (Wi-Fi off). Desktop should log `socket connect from 100.x.x.x` **within ~2 s** of the scan, then `[Pair] OK` immediately after. With Wi-Fi on, expect a LAN `socket connect from 192.168.x.x` in the same window — and possibly a simultaneous, immediately-abandoned connect on the other legs (harmless; the desktop tolerates connects that never upgrade).

## Desktop references

- Pair link / QR construction (all legs + fp): `main.js` `pair-link-create` (~line 21303) and `echocat-create-pairing-qr`.
- Token redemption endpoint + logging: `lib/remote-server.js` (`[Pair] OK …` lines).
- Desktop's own three-leg dial (same pattern, also sequential today — candidate for the same race later): `main.js` `redeemPairLinkUrl()` and `lib/remote-client.js` `_legCandidates()`.
- Context: the cert the phone validates is the Tailscale LE cert; the desktop now auto-reissues it when the tailnet hostname changes (`lib/remote-server.js` `loadCachedTailscaleCert`/`getOrCreateTlsCert`, fixed 2026-07-03), so "stale cert forever" can't recur server-side.

---

## Mobile resolution (2026-07-03)

**Status: implemented on mobile.** One correction and one design note for the record:

- **Reconnect was already raced.** The WS client (`EchocatClient`) has had a
  happy-eyeballs leg race with per-leg no-open watchdogs since the
  cloud-restart-connect-1006-loop fix — item 5's "today's sequential
  reconnect" was stale. The 30 s incident was the **pairing HTTP redemption**
  (`/api/pair`), which WAS sequential with no per-attempt timeout. That's the
  path that got the race.
- **The redemption POST is not raced — probes are.** The pairing token is
  single-use, so racing the POST itself risks an out-of-order
  "already redeemed" rejection from a losing leg failing a pairing that
  succeeded on the winner. Mobile races cheap pinned GETs against **`/health`**
  (cert pin verified during the probe on LAN/TS legs; 5 s per-leg budget;
  250 ms LAN-preference grace), then submits the token once over the winner
  with a 10 s cap. Expect a burst of 1–3 `GET /health` hits right after a QR
  scan — that's the race, not a bug.
- Per-leg progress UI ("Shack Wi-Fi / Tailscale / POTACAT Cloud — trying /
  reachable / not reachable / connected") shows from scan to connected; the
  camera drops immediately on a valid QR parse instead of freezing for the
  exchange. Failure copy aggregates every leg's reason.
- Item 5's banner: pin rejections during background reconnect are now
  classified (native "pin mismatch"/"fingerprint mismatch" messages) and
  surface a persistent "Can't verify <rig>" banner instead of silent retries.
  No native-module change was needed.
- Verification per §"How to tell it's fixed" still applies: cellular-scan
  should produce first desktop contact (the `/health` probe) well under 2 s.
