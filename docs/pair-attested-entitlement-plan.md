# Pair-Attested Entitlement — Design Spec

> **Status (2026-06-05):** Design only. No code written. Targets POTACAT
> Cloud + desktop + iOS app; coordinated three-repo work. This document
> is the contract between those three pieces.

This document specifies the mechanism by which a **POTACAT Cloud
subscription bought on iOS via in-app purchase grants Cloud Tunnel
entitlement to a paired Desktop**, without requiring the desktop to sign
into the same cloud account separately.

It is written for an engineer (or another Claude Code session) picking
this up cold. Read it whole before writing code.

---

## 1. The problem

Today, three accounts can exist in a single user's POTACAT install:

| Surface | Cloud account? | Subscription attaches to? |
|---|---|---|
| iOS app | Maybe (signed in to enable IAP) | The iOS user account |
| Paired desktop | Maybe (only if user explicitly signed in) | The desktop user account |
| The pair handshake | None — pair token is shack-local | N/A |

The QR pair-handshake (`/api/pair` on the desktop, no cloud involvement)
doesn't touch any cloud account. So after a user pairs their iOS app
to their desktop, **the cloud has no idea those two devices belong to
the same person.**

If the iOS user later buys a POTACAT Cloud subscription via Apple's
StoreKit, the subscription attaches to the iOS user's cloud account.
The desktop — which may not be signed in, or may be signed in to a
DIFFERENT cloud account (different OAuth provider, different email) —
sees no entitlement. **The user pays but the rig doesn't get Cloud
Tunnel.** This is a silent failure mode that's easy to fall into.

The fix this document specifies: **the pair handshake itself creates a
trust link in the cloud**, so the iOS account's subscription
automatically extends to any shack it has paired.

---

## 2. User journeys

### 2.1 The journey we're fixing

1. User installs POTACAT Desktop, configures their FT-991. No Cloud
   account on the desktop.
2. User installs POTACAT iOS, signs in with Sign-in-with-Apple.
3. User opens **Pair my device** on the desktop, scans the QR with
   iOS. Pair completes. iOS can now talk to the desktop over LAN.
4. User leaves home, opens iOS — can't reach the rig (no tunnel).
5. User taps "Enable remote access" → triggers IAP. Subscribes.
6. **TODAY:** Nothing happens on the desktop. User has paid, rig
   stays unreachable. They have to figure out that they ALSO need to
   sign into Cloud on the desktop with the same account, and even
   that's impossible if their iOS sign-in was Apple (the desktop
   Cloud sign-in is Google OAuth today).
7. **AFTER THIS SPEC:** Within 60 seconds of the IAP, the desktop's
   Cloud Tunnel quietly comes up, billed to the iOS user. A toast on
   the desktop shows: *"Remote access enabled via paired iPhone
   (KM4CFT). Tunnel: k3sbp.potacat.com."*

### 2.2 The journey we keep working

The existing "desktop signs into its own Cloud account, buys
subscription directly" flow continues to work. That's for users who
want their billing on the desktop (and for club stations / multi-op
shacks where there's no single iOS user).

### 2.3 Edge case journeys

- **Multi-pair, single sub:** Casey + spouse both pair their iPhones
  to one shack. Only Casey buys IAP. Tunnel comes up. If Casey's sub
  lapses but spouse's is active, tunnel keeps working under spouse's
  account. We don't need to pick one — any active pair wins.
- **Unpair:** iOS user removes the shack from their paired list →
  iOS calls `DELETE /v1/shacks/claim/:fp` → cloud marks claim revoked
  → desktop loses entitlement on next 60s poll → tunnel tears down
  gracefully (15-second warning toast first).
- **Sub cancellation:** Apple cancels the sub, RC webhook fires on
  cloud → user `subscription_status='inactive'` → entitlement endpoint
  reflects → desktop tears down. Same as the existing direct-billed
  path.
- **Apple ID change / restore on iOS:** iOS app re-establishes the
  Cloud sign-in. The claim survives (it's keyed on the user account,
  not the iOS install). The user might have to re-pair if their
  paired-device list got wiped, but billing continuity isn't lost.

---

## 3. Data model

### 3.1 New table — `claimed_shacks`

The trust link between a cloud-account-having user and a paired shack.

```sql
CREATE TABLE claimed_shacks (
  id                INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  shack_fingerprint TEXT NOT NULL,    -- SHA-256 of the desktop's TLS cert
  shack_name        TEXT,              -- display ("Casey's home shack")
  claimed_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at        TIMESTAMPTZ,       -- soft delete; iOS unpair sets this
  last_seen_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, shack_fingerprint)
);

CREATE INDEX idx_claimed_shacks_fp_active
  ON claimed_shacks (shack_fingerprint) WHERE revoked_at IS NULL;

CREATE INDEX idx_claimed_shacks_user
  ON claimed_shacks (user_id) WHERE revoked_at IS NULL;
```

**Why a separate table** rather than reusing `cloud_devices` (mig 012):
`cloud_devices` ties a device to a user that's signed in ON that
device. `claimed_shacks` ties a user to a shack the user has PAIRED
WITH — possibly without ever signing into the cloud on the shack
itself. Different semantics; muddling them would force NULL juggling
across queries.

### 3.2 No new columns on `users` or `passes`

The existing `users.subscription_status` is the source of truth for
"who is paying." This spec doesn't change the subscription model —
only adds a way to project entitlement from a paying user to a
non-signed-in shack.

---

## 4. API surface

All new endpoints; no breaking changes to existing ones.

### 4.1 iOS-facing — pair claim management

#### `POST /v1/shacks/claim`

Called by iOS immediately after a successful QR pair to the desktop.
Requires bearer JWT (iOS user must be signed in to POTACAT Cloud to
make a claim — that's the whole point).

```
Authorization: Bearer <iOS user JWT>
Content-Type: application/json

{
  "shack_fingerprint": "AB:CD:EF:...",  // from the QR pair URL
  "shack_name": "K3SBP Home Shack"
}
```

**Behavior:**
- Upserts on `(user_id, shack_fingerprint)`. Re-claim is idempotent
  and refreshes `last_seen_at`.
- Revoked claims (revoked_at NOT NULL) are un-revoked by re-claim.
- Returns `200 { ok: true, claim_id, claimed_at, shack_name }`.
- `400` if fingerprint format invalid (non-hex, wrong length).
- `401` if no JWT.

#### `DELETE /v1/shacks/claim/:fingerprint`

Called by iOS when the user unpairs the shack from their paired-devices
list. Bearer JWT required.

- Sets `revoked_at = NOW()` for `(user_id, fingerprint)` rows.
- Idempotent — returns 200 whether anything was revoked or not.

#### `GET /v1/shacks/claim`

Lists the iOS user's active claims. Used by the iOS paired-devices UI
to show "subscription extends to: K3SBP Home Shack."

- Returns `[{shack_fingerprint, shack_name, claimed_at, last_seen_at}]`.
- Only non-revoked rows.

### 4.2 Desktop-facing — entitlement check (no auth)

This is the load-bearing one — the desktop calls it without being
signed in.

#### `GET /v1/shacks/entitlement?fp=<fingerprint>`

**No authentication.** The fingerprint IS the identity claim. The
risk model: anyone can probe a fingerprint and learn whether it has
an active claimant. Fingerprints are 256-bit hashes — not feasibly
enumerable, and learning "this fingerprint is entitled" leaks one
bit, not the underlying account info.

```
GET /v1/shacks/entitlement?fp=ABCDEF...
```

Response:
```json
{
  "entitled": true,
  "expires_at": "2026-07-05T18:00:00Z",
  "claimant_callsign": "KM4CFT",   // public, claimant's user.callsign
  "claimant_user_id": 12345,        // for the desktop to send in next call
  "source": "paired-user"
}
```

Or when not entitled:
```json
{ "entitled": false }
```

**SQL behind it (one query, no JOINs needed since users has the data):**
```sql
SELECT u.id, u.callsign, u.subscription_expires_at, u.subscription_status
  FROM claimed_shacks c
  JOIN users u ON u.id = c.user_id
 WHERE c.shack_fingerprint = $1
   AND c.revoked_at IS NULL
   AND u.subscription_status = 'active'
   AND (u.subscription_expires_at IS NULL OR u.subscription_expires_at > NOW())
 ORDER BY u.subscription_expires_at DESC NULLS FIRST
 LIMIT 1;
```

`ORDER BY` picks the longest-running active claim so the desktop's UI
doesn't bounce between claimants on every poll.

#### `POST /v1/shacks/heartbeat`

```
GET-friendly equivalent: GET /v1/shacks/heartbeat?fp=...
```

Called by the desktop every 5 minutes when entitled. Updates
`last_seen_at` on every non-revoked claim for that fingerprint. Used
for the abandoned-shack cleanup sweep (claims with no heartbeat in
90 days get auto-revoked).

### 4.3 Cloud Tunnel provisioning — extended

Today's `POST /v1/cloud-tunnel/provision` requires JWT + active
subscription. We add a parallel path that accepts a fingerprint
attestation.

#### `POST /v1/cloud-tunnel/provision-via-claim`

```
Content-Type: application/json
(no Authorization header)

{
  "shack_fingerprint": "AB:CD:EF:...",
  "claimant_user_id": 12345    // from the entitlement check response
}
```

**Behavior:**
- Verifies a non-revoked claim exists for `(user_id, fingerprint)`.
- Verifies the claimant has an active subscription.
- Runs the existing CF tunnel provisioning logic AS the claimant
  user (so the tunnel resources are billed to / cleaned up via that
  user's account).
- Returns the same `{cloudHost, tunnelToken, ...}` shape as the
  authenticated path.

**Why two endpoints instead of one with optional auth:** the
authenticated path runs as `req.user.id` (the desktop user). The
pair-attested path runs as `claimed_shacks.user_id` (the iOS user).
Mixing the two through a single endpoint would mean awkward "if JWT
present use that user, else use the fingerprint user" logic — easy
to mis-implement. Two endpoints, two narrow code paths.

#### `POST /v1/cloud-tunnel/revoke-via-claim`

Mirror of the existing revoke. Called by the desktop on graceful
shutdown OR by the cloud's reconcile job when a claim or sub is lost.

### 4.4 Cleanup hooks

The existing `reconcileSubscription` in `routes/subscription.js` is
called by the RevenueCat webhook on subscription state change. It
already calls `revokeCloudTunnel(userId)` to tear down the user's own
tunnel when entitlement is lost. **Extend it to also tear down any
tunnels provisioned via claim** when the user's entitlement drops:

```js
// In reconcileSubscription, after the existing revokeCloudTunnel:
if (newStatus !== 'active') {
  // Find shacks that were entitled via THIS user's claim and have no
  // OTHER active claimant — tear those down too.
  const { rows: orphans } = await pool.query(
    `SELECT c.shack_fingerprint
       FROM claimed_shacks c
      WHERE c.user_id = $1
        AND c.revoked_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM claimed_shacks c2
            JOIN users u2 ON u2.id = c2.user_id
           WHERE c2.shack_fingerprint = c.shack_fingerprint
             AND c2.id != c.id
             AND c2.revoked_at IS NULL
             AND u2.subscription_status = 'active'
        )`,
    [userId]
  );
  for (const { shack_fingerprint } of orphans) {
    await revokeCloudTunnelByFingerprint(shack_fingerprint);
  }
}
```

The `NOT EXISTS` clause is the multi-pair safety: if Casey's spouse is
still subscribed and her phone is also paired, the shack stays up.

---

## 5. Desktop integration

### 5.1 Cloud Tunnel lifecycle (lib/cloud-tunnel.js)

Today's state machine: `off → provisioning → connecting → live →
reconnecting → error`. The transition into `provisioning` today
requires a signed-in cloud session.

Add a new **upstream check** before requiring sign-in:

```
on enable():
  1. fingerprint = computeOwnFingerprint()
  2. r = await fetch(`/v1/shacks/entitlement?fp=${fingerprint}`)
  3. if r.entitled:
       → provision via /provision-via-claim
       → state = 'provisioning'
       → notify renderer: "Tunnel enabled via paired user X"
  4. else if user signed in AND has subscription:
       → existing flow
  5. else:
       → state = 'needs-entitlement'
       → notify renderer: "Sign in OR pair an iPhone with subscription"
```

### 5.2 Background polling

When tunnel is `live`, poll `/v1/shacks/entitlement` every 60s
(piggyback on the existing 5-min health-check; entitlement is cheap).
Already on the existing free-tier health-check cadence — no new
Cloudflare API calls; this is a lookup against our own DB.

State machine additions:
- `live → reconnecting` if entitlement flips false → wait 15s
  grace → tear down via `/revoke-via-claim`.
- Notify the renderer: *"Your paired iPhone's subscription has ended.
  Tunnel will close in 15 s — sign into Cloud directly to keep it
  running."*

### 5.3 UI surfaces

**On the Settings → ECHOCAT card** (the Cloud Tunnel pill):

- **Entitled-via-claim, tunnel live:**
  ```
  🟩 Cloud Tunnel · k3sbp.potacat.com
     Billed to paired iPhone (KM4CFT) · expires 2026-07-05
  ```
- **Entitled-via-claim, claimant sub lapsed (15s grace):**
  ```
  🟨 Tunnel ending in 15s — paired iPhone's subscription ended
     [ Sign in to keep it running ]
  ```
- **No entitlement and no sign-in:**
  ```
  ⬜ Cloud Tunnel: off
     [ Sign in to POTACAT Cloud ] or pair an iPhone with a subscription
  ```

**Toasts:**
- *"Cloud Tunnel enabled via paired iPhone (KM4CFT)."* on first
  entitle.
- *"Your paired iPhone's subscription has ended. Tunnel closing in
  15s."* on entitle → un-entitle.

### 5.4 Desktop never gets a JWT in the claim flow

The desktop never authenticates against the cloud in this path. All
its API calls (`entitlement`, `provision-via-claim`,
`revoke-via-claim`, `heartbeat`) are unauthenticated and identify the
shack by fingerprint. This is intentional:

- The desktop may have no Cloud account at all.
- The desktop's TLS private key is the secret that backs its
  fingerprint claim. To impersonate, you'd need the key.
- The fingerprint is already public (mDNS TXT, QR codes, pair URLs)
  — knowing it lets you check entitlement, not change it.

---

## 6. iOS integration

The iOS app already has a paired-devices UI (per
`docs/echocat-mobile-plan.md` and the existing PairingService.ts in
`potacat-app`). Two hooks needed:

### 6.1 After QR pair succeeds

In `PairingService.ts`, after the `POST /api/pair` to the shack returns
the `deviceToken`, IF the iOS user is signed in to POTACAT Cloud:

```ts
await fetch(`${API_BASE}/v1/shacks/claim`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${cloudJwt}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    shack_fingerprint: pairResult.fingerprint,
    shack_name: pairResult.serverName || 'Remote shack',
  }),
});
```

Failure is non-fatal — the pair completes regardless. If the user
later signs into Cloud and goes to their paired-devices UI, we can
back-fill the claim for shacks that weren't claimed at pair time.

### 6.2 On unpair

When the iOS user removes a shack from their paired list:
```ts
await fetch(`${API_BASE}/v1/shacks/claim/${fingerprint}`, {
  method: 'DELETE',
  headers: { Authorization: `Bearer ${cloudJwt}` },
});
```

### 6.3 On Cloud sign-in (if user pairs first, signs in second)

When the user signs into Cloud on iOS for the first time AND they
already have local paired shacks, offer to claim them all:

> "You have 2 paired shacks. Link them to your POTACAT Cloud
> subscription so they can use Cloud Tunnel when you have an active
> subscription? [Link both / Pick one / Not now]"

The "Link both" path issues `/v1/shacks/claim` for each fingerprint in
the local paired-devices list.

### 6.4 The "what does the user see in iOS" surface

In the iOS paired-shacks list, add a per-shack indicator:

- **Subscription extends to this shack:** "✓ Cloud Tunnel ready —
  this shack will get remote access when your subscription is active."
- **Not yet claimed:** "⚠ This shack is paired but not linked to your
  subscription. [Link]"

---

## 7. Migration strategy

### 7.1 Backward compatibility

- Existing users with direct desktop sign-in keep working. Their
  Cloud Tunnel still uses `/v1/cloud-tunnel/provision`. Nothing
  changes for them.
- Existing paired iOS users without claims still pair successfully.
  They just won't get pair-attested entitlement until they (a) sign in
  to Cloud on iOS and (b) re-trigger the claim (or pair again).

### 7.2 The migration file

```sql
-- POTACAT Cloud - Migration 015: claimed_shacks
--
-- Trust links from cloud-account-having users to paired shacks they
-- own. Powers pair-attested Cloud Tunnel entitlement (iOS-buys-IAP →
-- desktop-gets-tunnel) without forcing the desktop to sign in.
-- See docs/pair-attested-entitlement-plan.md in potacat-dev.

BEGIN;

CREATE TABLE IF NOT EXISTS claimed_shacks (
  id                INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  shack_fingerprint TEXT NOT NULL,
  shack_name        TEXT,
  claimed_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at        TIMESTAMPTZ,
  last_seen_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, shack_fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_claimed_shacks_fp_active
  ON claimed_shacks (shack_fingerprint) WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_claimed_shacks_user
  ON claimed_shacks (user_id) WHERE revoked_at IS NULL;

INSERT INTO schema_version (version) VALUES (15) ON CONFLICT DO NOTHING;

COMMIT;
```

### 7.3 The reconcile cleanup migration

Not a schema migration — a code change to `reconcileSubscription` in
`routes/subscription.js` (see §4.4). Ships in the same release as the
new endpoints.

### 7.4 Cleanup sweep

A cron job (daily) revokes claims with `last_seen_at < NOW() -
INTERVAL '90 days'` — abandoned shacks whose desktops never
heartbeated for three months. Conservative threshold so a vacation
doesn't lose the claim.

---

## 8. Security & abuse considerations

### 8.1 Fingerprint forgery

The desktop's identity is its TLS public-key SHA-256. To claim
entitlement against a fingerprint you don't own:
- You'd need to mint a TLS cert with that exact SHA-256, which means
  finding the private key — cryptographically infeasible.
- The pair handshake (QR scan) already requires possession of the
  private key (the desktop's HTTPS server uses it during the WSS
  handshake). So pairing already proves ownership.

Therefore: **anyone with the fingerprint AND a paired iOS account can
claim entitlement on a shack.** This is by design — they already had
the rig in their possession.

### 8.2 Claim hijack

If user A pairs an iOS to shack X, then user B somehow pairs THEIR
iOS to the same shack X (e.g. they share access for Field Day), both
users are now claimants. Either's active sub keeps the tunnel up.

This is actually correct behavior. If you don't want shared
entitlement, don't share pair links.

### 8.3 Enumeration of fingerprints

`GET /v1/shacks/entitlement?fp=...` reveals `entitled: bool` to
unauthenticated callers. Risks:
- An attacker enumerating fingerprints could discover "this
  fingerprint is entitled" → learn that a desktop with that
  fingerprint exists with an active subscription.
- Fingerprints are 256-bit hashes. Brute-force enumeration is
  infeasible.
- Even if they find one, they can't do anything with it (provisioning
  requires both a valid fingerprint AND a user_id from the entitlement
  response that they could only know if they queried entitlement, which
  in turn requires knowing the fingerprint).

**Net:** the leak is single-bit and the attacker needs the rare
fingerprint already. Acceptable.

### 8.4 Rate limiting

The new endpoints all need rate-limiting. Reuse the existing
`rateLimitPasses`-style limiter (per-IP, sliding window). Hot paths:

- `entitlement?fp=...` — heartbeat-rate from real users, possibly
  scanned by abusers. Limit: 60 req/min/IP.
- `provision-via-claim` — once per tunnel lifecycle. Limit: 10 req/hr/IP.
- `claim` / `claim/:fp` (DELETE) — once per pair / unpair. Limit:
  30 req/hr/user.

### 8.5 RevenueCat webhook ordering

The cleanup hook in §4.4 runs synchronously in `reconcileSubscription`.
If the webhook fires before the desktop has provisioned its tunnel via
claim, the desktop sees `entitled: false` on its next poll and just
doesn't bring the tunnel up. No race condition.

If the webhook fires WHILE the tunnel is live, the cleanup tears it
down. The desktop sees the WS close as a normal reconnect attempt and
will discover via entitlement check that it's no longer entitled.

---

## 9. Phasing

This is a multi-repo, multi-release effort. Recommended order:

### Phase 1 — Cloud-side foundation (potacat-cloudlog)

- Migration 015 (claimed_shacks).
- Endpoints: `POST /v1/shacks/claim`, `DELETE /v1/shacks/claim/:fp`,
  `GET /v1/shacks/claim`, `GET /v1/shacks/entitlement`,
  `POST /v1/shacks/heartbeat`.
- Cloud Tunnel provision-via-claim + revoke-via-claim endpoints.
- reconcileSubscription extension for orphan tear-down.
- 90-day cleanup sweep cron.

Deploy without ANY desktop or iOS changes. New endpoints sit unused.
The existing flows are unaffected.

### Phase 2 — iOS side (potacat-app)

- `PairingService.ts`: claim on pair success, revoke on unpair.
- Paired-shacks UI: per-shack "subscription extends" badge.
- Sign-in flow: back-fill claims for already-paired shacks.

iOS app store release. Users on the new app start populating
`claimed_shacks` rows. Desktop sees nothing yet.

### Phase 3 — Desktop side (potacat-dev)

- `lib/cloud-tunnel.js`: entitlement check before sign-in
  requirement, polling, state-machine additions.
- Renderer: ECHOCAT card surfaces — "Billed to paired iPhone" badge,
  toasts, grace-period UI.
- Update the existing "Sign in to POTACAT Cloud" prompt to
  acknowledge pair-attested as an alternative.

Desktop release. Existing users see the new pair-attested entitlement
take effect automatically if their iOS app is on the Phase-2 build
AND has an active sub.

### Phase 4 — Polish & analytics

- Admin dashboard: stats on pair-attested tunnels.
- Per-claim usage tracking (extension of mig 010 cloud_tunnel_daily).
- Pair-attested entitlement may dramatically increase tunnel
  utilization — watch CF tunnel cost.

---

## 10. Open questions

1. **Apple's "Sign in with Apple" restriction.** Apple's App Store
   review (rule 4.8) requires SiwA to be offered if any third-party
   sign-in is offered. The desktop today only offers Google OAuth.
   This spec works around that — the desktop can be entitled WITHOUT
   ever signing in — but should the desktop ALSO offer SiwA (so a
   user who prefers SiwA can sign into Cloud directly on the desktop
   too)? Out of scope for this spec; flagging.

2. **Claim cap per user.** Should there be a cap on how many shacks
   one user can claim? Club ops might have legitimately 5+ shacks.
   Recommend 10 initially, log warnings above that.

3. **Cross-account claim merge.** If Casey starts on Sign-in-with-
   Apple on iOS, then later signs into POTACAT Cloud on the desktop
   with Google OAuth, are those two accounts the same person? We
   can't safely auto-merge without verification. Recommend: leave
   them separate, surface the situation in the UI ("you have 2
   POTACAT Cloud accounts — link them?").

4. **Tunnel hostname under claim.** When the desktop is entitled via
   claim, the tunnel hostname is `<iOS-user-callsign>.potacat.com`,
   not the desktop's own callsign. Is that the right call? Pros: it
   reflects who's paying. Cons: confusing if the desktop's operator
   has a different callsign than the paying iOS user. Recommend
   `<paying-callsign>.potacat.com` for billing alignment; surface the
   actual hostname clearly in the desktop UI.

5. **What if iOS uninstalls without unpairing?** The claim persists.
   The 90-day heartbeat-cleanup catches it eventually. Should iOS
   send a "tombstone unpair" via cloud when the app is wiped? Apple's
   IDFA-style erase notification could trigger this, but it's
   unreliable. Recommend: don't over-engineer; the 90-day sweep is
   enough.

---

## 11. Test plan

### 11.1 Cloud-side

- New user → `POST /v1/shacks/claim` → row created.
- Re-claim same fingerprint → idempotent, refreshes last_seen_at.
- DELETE → revoked_at set, GET returns empty.
- Two users claim same fingerprint → entitlement query returns the
  one with active sub; if both active, returns longest-running.
- User's sub cancels via RC webhook → reconcileSubscription tears
  down claim-based tunnel iff no other claimant.
- Entitlement endpoint smoke test: `entitled: true` only when
  fingerprint has at least one non-revoked claim with active sub.

### 11.2 Desktop-side

- Fresh install, no Cloud account, paired iOS with sub: tunnel comes
  up automatically within 60s.
- iOS sub cancellation: desktop tears down within 60s + 15s grace.
- iOS unpair from desktop: same — tear down on next poll.
- Desktop signs in to its own Cloud account with own sub WHILE
  pair-attested tunnel is live: gracefully transitions to direct-billed
  with no disruption.

### 11.3 iOS-side

- Pair → claim happens automatically; verify backend row exists.
- Unpair → DELETE fires; verify revoked_at set.
- Sign in to Cloud after pairing → back-fill prompt; verify claims
  created for each local paired shack.

---

## 12. Where to start

For the engineer picking this up:

1. **Cloud first.** Build migration 015, the 5 endpoints, and the
   reconcileSubscription extension. Run §11.1 tests in
   staging. **Ship to prod independently** — costs nothing if iOS and
   desktop don't yet use it.
2. **Desktop second.** Wire `lib/cloud-tunnel.js` to check the new
   entitlement endpoint. Use a real shack fingerprint in dev and a
   manually-crafted claimed_shacks row in staging to verify the
   tunnel comes up without local Cloud sign-in.
3. **iOS last.** Add the claim call to PairingService + the back-fill
   prompt. Ship the app-store update.

When all three are in production, the journey described in §2.1
works end-to-end. Users on older builds keep using the existing direct-
billed path — no regression.

---

## 13. Cross-references

- `potacat-cloudlog/db/migrations/006_cloud_tunnel.sql` — the
  existing cloud_tunnel_id column on users.
- `potacat-cloudlog/routes/cloud-tunnel.js` — existing provision/revoke
  flow that the claim path piggybacks on.
- `potacat-cloudlog/routes/subscription.js` — where reconcileSubscription
  lives.
- `potacat-cloudlog/db/migrations/012_cloud_devices.sql` — different
  but related schema for desktop-to-desktop pairing. Keep claim model
  separate per §3.1.
- `docs/remote-desktop-plan.md` — the desktop-to-desktop initiative
  (Phase 1) this spec builds on top of conceptually.
- `potacat-app/src/services/PairingService.ts` — iOS pair handshake.
