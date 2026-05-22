# Push relay — desktop calls /push on incoming-call event

Status: open
Filed: 2026-05-06
Repo for changes: d:/projects/potacat-dev

## Context

iOS Phase 2D ships a Cloudflare Worker push relay (`echocat-relay`) and a PushKit native module (`expo-echocat-push`). The phone registers itself with the relay at boot. **Desktop now needs to call the relay's `/push` endpoint when it wants to wake the phone** — typically when a CQ is heard, an FT8 decode of the operator's call lands, or the operator manually pings the phone.

Without this, the phone never gets pushed and audio doesn't wake from suspend on iOS. Phase 2C already keeps audio alive while the bridge is running and the phone is locked; Phase 2D is the cold-start path.

## What the iOS app already does

- New module `expo-echocat-push` registers a PushKit VoIP token.
- `src/services/PushRelay.ts` POSTs `{ subId, platform, pushToken }` to `<relayUrl>/register` at boot. The `subId` is the paired-device id (`Devices.getActiveId()`) — already known to the desktop side from the original pairing exchange.
- `addIncomingPushListener` fires `onIncomingPush` when APNs delivers; the JS handler (currently) brings up the audio bridge and logs the metadata.
- Relay URL configured via `app.json` `extra.pushRelayUrl` (default `https://relay.potacat.com`).

No protocol additions needed on the desktop side beyond making the outbound HTTP call.

## What needs to change on desktop

### 1. Add a relay client module

Probably in `lib/push-relay.js`:

```js
// HMAC-SHA256 auth — ts:hex(hmac(secret, ts))
async function relayAuth(secret) {
  const ts = Math.floor(Date.now() / 1000).toString(16);
  const mac = crypto.createHmac('sha256', secret).update(ts).digest('hex');
  return `${ts}:${mac}`;
}

async function pushToPhone(subId, ciphertext, opts = {}) {
  const cfg = settings.pushRelay; // see #2 below
  if (!cfg?.url || !cfg.hmacKey) return;
  await fetch(`${cfg.url}/push`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-relay-auth': await relayAuth(cfg.hmacKey),
    },
    body: JSON.stringify({
      subId,
      ciphertext,
      priority: opts.priority || 'high',
      ttlSec: opts.ttlSec || 30,
    }),
  });
}
```

### 2. Settings — relay URL + HMAC key

Add settings:
- `pushRelay.url` (default `https://relay.potacat.com`)
- `pushRelay.hmacKey` — random 32-byte hex; same value goes into the Worker's `PAIRING_HMAC_KEY` secret. Generate at desktop install or first push attempt.

### 3. Trigger points — what events should push?

Three obvious triggers, in priority order:

1. **Operator's callsign heard.** Watch RBN / PSKR / cluster spots; if `myCallsign` appears as the callsign on a fresh spot, push. *De-dupe per band per 15 min so we don't push 50× during a contest.*
2. **Operator-initiated ping.** A button on the desktop's ECHOCAT panel: "📱 Wake my phone" — POSTs a heartbeat push. Useful for "I want to start listening, my phone is in my pocket."
3. **FT8 decode of the operator's call.** When `jtcat-decode` results contain `myCallsign`, push.

For each trigger, build the ciphertext (v1: just JSON cleartext for now, encryption is v1.5):

```js
const ciphertext = JSON.stringify({
  reason: 'cq-heard',
  callsign: spot.callsign,
  freqKhz: spot.frequency,
  mode: spot.mode,
  ts: Date.now(),
});
await pushToPhone(subId, ciphertext, { priority: 'high' });
```

### 4. Sub-id mapping

Each paired phone has a `subId` matching `Devices.getActiveId()` on the iOS side. Desktop knows this from the pairing exchange (it stored a record of every paired device). Maintain a list of active subIds so push can be sent to all of them, or just the "primary" one.

## Test path

1. Apply this change.
2. Configure relay URL and HMAC key in desktop settings (matching the Worker's `PAIRING_HMAC_KEY` secret).
3. Phone on iOS, registered with relay (verify `[push]` log on app boot).
4. Lock the iOS device.
5. From desktop, click "📱 Wake my phone" (or wait for a spot of `myCallsign`).
6. iOS PushKit fires within ~1s; `onIncomingPush` triggers; audio bridge starts.

## Reference

- Worker source: `D:\Projects\potacat-app\relay\src\worker.ts`.
- iOS PushKit module: `D:\Projects\potacat-app\modules\expo-echocat-push\ios\EchocatPushModule.swift`.
- iOS-side service: `D:\Projects\potacat-app\src\services\PushRelay.ts`.
- Relay README + setup: `D:\Projects\potacat-app\relay\README.md`.

## Open question

Encryption of the push payload (v1 sends cleartext JSON via `ciphertext` field). The relay design supports E2E encryption with a per-pairing key shared during the pairing handshake. Worth wiring before going to App Store production but not required for TestFlight Internal.
