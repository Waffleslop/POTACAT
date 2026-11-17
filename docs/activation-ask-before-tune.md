# Activation start: ask before the radio moves (GitHub #146)

Written 2026-11-17. Desktop half built on branch `fix/146-activation-ask-before-tune`; the phone
half is a handoff to the ECHOCAT repo (DESKTOP_TO_ECHOCAT_HANDOFF_2026-11-17_ACTIVATION_ASK_BEFORE_TUNE.md).

## The problem

Starting a POTA activation from the ECHOCAT phone moved the home radio. An operator at a park
starts an activation on his phone while the shack radio at home is on another frequency, perhaps
in use by someone else in the house, by a Guest Pass operator, or running FT8. The radio was moved
under them with no question.

## Casey's rule (2026-11-07)

POTACAT never retunes the radio silently for a phone activation. It asks first, and with more
than one radio it asks which one.

## Today's flow (before this change)

1. ECHOCAT activation start screen, step 2 shows a frequency and mode that mirror the radio. The
   operator may edit them.
2. Start (echocat `src/screens/ActScreen.tsx:677`, `onStart`): if the step-2 frequency or mode
   differs from what the phone believes the radio is on, the phone sends a plain
   `{type: 'tune', freqKhz, mode}` (ActScreen.tsx:696), then at once calls
   `useActivation.start()` (ActScreen.tsx:719), which sends `set-activator-park`
   (`src/state/activation.ts:487`) and waits for the `activator-state` ack.
3. Desktop, `lib/remote-server.js` `case 'tune'` (master: line 3856) rate-limits, checks the VFO
   lock and emits `tune`. `main.js` `remoteServer.on('tune')` (master: line 27482) calls
   `tuneRadio()`. **This is the silent retune.**
4. Desktop, `case 'set-activator-park'` (master: remote-server.js:4013) emits
   `set-activator-park`; `main.js` (master: line 28678) sets activator mode, the park refs, the
   on-air call and the county, pushes `activator-state`, resets the session contacts and starts
   the activation clock. This handler never tuned and still does not.

The tune and the start are two separate messages; the desktop could not tell the activation's
tune from any other tune. The desktop's own activator panel seeds its frequency from the radio
and does not tune on mode entry (renderer/app.js `setAppMode`); ECHOCAT Web's start
(renderer/remote.js `doStartActivation`) and the desktop-to-desktop client
(main.js `pushActivationToRemoteShack`) send no frequency.

## The new flow

1. A device that knows the question (hello `capabilities` includes `activation-ask-tune`) on a
   shack that advertises `activation-ask-tune` sends NO bare tune. It puts the wanted frequency
   on the start: `set-activator-park.tuneTo = {freqKhz, mode}`.
2. The shack starts the activation exactly as before and does not tune.
3. `main.js activationTuneAskFollow()` asks `lib/activation-tune-ask.js decide()` with the facts
   (wanted frequency, the radio's link, frequency and mode, the configured rigs, the active rig,
   whether a Guest Pass operator is connected, whether the device can be asked):
   - nothing wanted, or the radio is already there (same frequency within 50 Hz and the same mode
     family, so USB = SSB and DIGU = FT8): nothing is sent.
   - the device can be asked: `activation-tune-ask` to that device only.
   - one radio and it is not connected: a `tune-blocked` notice in words, no question.
   - the device cannot be asked (older phone): a `tune-blocked` notice in words.
4. The device shows the question. Yes: `activation-tune-answer {id, tune: true, rigId?}`. The
   shack tunes (through the same `tune` path every phone tune takes, so VFO lock, no-CAT and
   SDR routing all still apply). With a different radio chosen, the shack switches to it as a
   phone `switch-rig` does, waits up to 20 s for its link, then tunes; if it never connects the
   device gets a `tune-blocked` saying so. No, or no answer within 120 s: the radio stays.

## Wire contract

Capability `activation-ask-tune`, both directions (server hello: the shack asks; client hello:
the device can show the question).

| Message | Dir | Fields |
|---|---|---|
| `set-activator-park` | C→S | existing fields + optional `tuneTo: {freqKhz: number, mode?: string}` |
| `activation-tune-ask` | S→C | `id` string, `freqKhz` number, `mode` string, `current` `{freqKhz, mode}` or null, `rigs` `[{id, name, active, connected}]` (empty for one radio), `activeRigId`, `guestOnAir` boolean, `text` (the question, ready to show), `expiresInMs` (120000) |
| `activation-tune-answer` | C→S | `id` string, `tune` boolean, optional `rigId` |
| `tune-blocked` | S→C | existing; used for the notices (every shipped app shows it) |

Question text, as built by `lib/activation-tune-ask.js`:
- one radio: `Move the radio to 14.285.00 MHz SSB for this activation? It is on 14.074.00 MHz DIGU now.`
- several: `Move a radio to 14.285.00 MHz SSB for this activation? Choose the radio. It is on ...`
- with a Guest Pass operator connected, `A Guest Pass operator is connected to this station.` is added.

Notices:
- older device: `Your activation started. POTACAT did not move the radio: it stays on 14.074.00 MHz DIGU. To use 14.285.00 MHz SSB, tune there from the VFO screen.`
- not connected: `Your activation started. The radio is not connected, so POTACAT did not move it to 14.285.00 MHz SSB.`
- late answer: `That question has expired. POTACAT did not move the radio.`

Full table: docs/echocat-protocol.md, "Activator mode".

## Edge cases

| Case | What happens |
|---|---|
| Radio not connected, one radio | Activation starts; notice "The radio is not connected, so POTACAT did not move it". No question. |
| Radio not connected, several radios | Asked, with the rig picker; choosing another radio switches to it and tunes once it connects. |
| One radio | Yes/no question, no picker (`rigs` empty). |
| Several radios | Question lists every configured radio, the active one marked; default choice is the active one. The shack runs one radio at a time, so choosing another is a rig switch. |
| The phone is the only operator at the shack | Same question on the phone; the desktop screen is never asked (the person who knows is holding the phone). The desktop's CAT log records each step (`[activation] ...`). |
| A Guest Pass operator connected | The question says so (`guestOnAir`, and a sentence in `text`). A guest never starts an activation (`set-activator-park` is refused for a Guest Pass) and never gets or answers the question (`activation-tune-answer` is on the guest wall's denied list). |
| Desktop-to-desktop remote client | Sends `set-activator-park` with no frequency; never asked, unchanged. Its tunes are never held. |
| ECHOCAT Web | Its start screen has no frequency field and never sent a tune, so there is nothing to ask; unchanged. Its tunes are never held. |
| No answer / timeout | After 120 s the question is dead; the radio stays. An answer after that gets "That question has expired". |
| The phone sleeps during the question | Re-sent on reconnect (2026-11-17): the question belongs to the paired device, not its socket. If that device reconnects (a new socket, same pairing) while the question is still open, the shack sends the same `activation-tune-ask` again, with the same `id` and contents and `expiresInMs` set to the time that is left; an `activation-tune-answer` from the new socket is accepted. Treat a second ask with an `id` already on screen as the same question. |
| Answer from another device | Ignored: only the device that started the activation may answer. |
| VFO locked | A yes gets the usual `tune-blocked` "VFO Locked". |
| Old phone (no capability) | Its plain tunes (no `channelId`, `bearing`, `pickSideband`) are held 400 ms. A `set-activator-park` from the same phone within that time drops the held tune, starts the activation, and sends the "did not move the radio" notice. Any other held tune goes through 400 ms late. Old phones show `tune-blocked` as an alert, so the operator is told. |
| New phone, older shack | The server hello lacks `activation-ask-tune`: the phone must ask on its own screen before it sends a bare tune (handoff). |
| Activation end | `end: true` never carries or asks for a frequency. |

## Who does what

Desktop (this branch):
- `lib/activation-tune-ask.js`: the rule (decide, answer, who is an older phone, which tunes are held). Test: `test/activation-tune-ask-test.js`.
- `lib/remote-server.js`: advertises `activation-ask-tune`; holds an older phone's plain tunes; takes `tuneTo` (or the held tune) off the start; keeps open questions per device; sends the question and notices; accepts the one answer from the asked device.
- `main.js`: `activationTuneAskFollow()` after the start; `remoteServer.on('activation-tune-answer')` tunes, switching radios first when asked to.
- `lib/echocat-protocol.js`, `docs/echocat-protocol.md`: the messages and the capability.

Phone (ECHOCAT handoff):
- Advertise `activation-ask-tune` in its hello.
- On a shack that advertises it: send `tuneTo` on `set-activator-park`, never a bare tune at start.
- Show `activation-tune-ask` (question text, rig picker when `rigs` has two or more, Yes / Leave it), answer with `activation-tune-answer`, dismiss after `expiresInMs`.
- On an older shack: ask on the phone before sending the bare tune.

## Decisions for Casey

- The 400 ms hold on an older phone's plain tunes is the only way to keep an older phone from
  moving the radio: its start tune looks like any other tune. Dial spins and spot taps from an
  older phone arrive 400 ms later until the phone is updated (tunes are already limited to one per
  500 ms). Channel taps, band buttons and rotor tunes are not held.
- Choosing another radio in the question switches the shack to it (the same as a phone rig switch).
