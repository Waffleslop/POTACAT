# Mobile Handoff — "Floating PTT" in landscape (ECHOCAT Web pattern)

**Audience:** ECHOCAT native mobile (iOS) team
**Purpose:** document how ECHOCAT Web turns its docked bottom PTT bar into a
floating, thumb-reachable PTT pill in phone landscape, so the native app can
match the behavior.
**Source of truth:** `renderer/remote.html`, `renderer/remote.css`,
`renderer/remote.js` (the ECHOCAT Web client served by `lib/remote-server.js`).

---

## TL;DR

In **portrait**, PTT lives in a full-width bar docked to the bottom of the
layout (normal document flow). In **phone landscape** (`orientation: landscape`
AND `max-height: 500px`) the *same* `#bottom-bar` element is re-laid-out by a
media query into a **floating rounded pill, `position: fixed`, anchored to the
bottom-right corner**, with a blurred translucent background, sitting *over* the
scrollable content. Controls shrink, and the scroll views get extra
`padding-bottom` so their last rows aren't hidden under the pill.

There is **no separate "floating PTT" widget** — it's the bottom bar reflowed by
CSS. Nothing in JS toggles it; it's purely the media query.

---

## Why landscape needs this

A landscape phone has ~330–430 px of vertical room. A full-width bar across the
short axis eats a large fraction of it and pushes the spot list / VFO off-screen.
Floating the controls into a corner pill:

- frees the vertical space (content scrolls full-height under the pill),
- keeps PTT under the **right thumb** (phone held in landscape), and
- keeps HALT / audio / scan grouped with it without a full-width chrome strip.

---

## The mechanism (CSS)

### Base / portrait — docked, in-flow (`remote.css:1041`)

```css
#bottom-bar {
  display: flex; align-items: center; justify-content: center;
  gap: 16px;
  padding: 12px 16px;
  padding-bottom: calc(12px + var(--safe-bottom));
  background: var(--bg-header);
  border-top: 1px solid #333;
  flex-shrink: 0;               /* part of the column flex layout */
}
.ptt-button {
  width: 100px; height: 100px; border-radius: 50%;
  background: var(--accent); color: #fff;
  border: 4px solid #333;
  touch-action: none;          /* critical — see Gotchas */
}
```

### Phone landscape — floating pill (`remote.css:3230`)

```css
@media (orientation: landscape) and (max-height: 500px) {
  #bottom-bar {
    position: fixed;
    bottom: calc(6px + var(--safe-bottom));
    right:  calc(6px + env(safe-area-inset-right, 0px));
    width: auto;                       /* shrink-wrap the controls */
    gap: 8px;
    padding: 6px 10px;
    background: rgba(15, 52, 96, 0.85); /* translucent so content shows behind */
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 32px;               /* pill */
    border-top: none;                  /* drop the docked top divider */
    z-index: 50;                       /* above scroll content */
    box-shadow: 0 2px 12px rgba(0,0,0,0.4);
  }

  /* Shrunk controls so the pill stays compact */
  .ptt-button  { width: 52px; height: 52px; font-size: 14px; border-width: 3px; }
  .estop-button{ width: 36px; height: 36px; }
  .audio-button, .speaker-button { width: 36px; height: 36px; }

  /* Keep the last list/view rows clear of the floating pill */
  #spot-list, #spot-map, #log-tab-view, #log-view,
  #logbook-view, #ft8-view, #dir-view { padding-bottom: 56px; }
}
```

Key points the native port must preserve:

1. **Anchored to the bottom-trailing corner**, not centered. (Right-thumb reach
   in landscape. It is *not* currently handed/mirrored for left-thumb — a known
   simplification, fine to improve natively.)
2. **Inside the safe area** — `env(safe-area-inset-right)` + `--safe-bottom`
   keep it clear of the home indicator and the rounded corner. `--safe-bottom`
   is the app's `env(safe-area-inset-bottom)` wrapper.
3. **Floats over content** (`z-index: 50`, translucent + blur). Content is *not*
   resized to make room; instead scroll views add `padding-bottom: 56px` so
   their tail clears the pill.
4. **Same element, no JS** — the transition between docked and floating is the
   media query alone. Don't build a separate floating component that you
   show/hide; reflow the one control cluster.

> Tablet landscape (`min-width:768px and orientation:landscape`, `remote.css:3314`)
> does **not** float — there's room, so the bar stays docked and just grows.

---

## The control cluster (what's in the pill) — `remote.html:1341`

```html
<div id="bottom-bar">
  <div id="bb-controls" class="bb-controls">
    <div class="bb-stack"> Live / Vol / SDR </div>
    <button id="scan-btn"  class="bb-round-btn">Scan</button>
    <button id="ptt-btn"   class="ptt-button">PTT</button>   <!-- the PTT -->
    <div class="bb-halt-stack">
      <button id="speakermic-btn" class="bb-mic-btn">Mic</button>
      <button id="estop-btn"      class="bb-halt-btn">HALT</button>
    </div>
  </div>
</div>
```

PTT and HALT are the load-bearing controls in the pill; the audio/scan/mic
buttons ride along.

---

## PTT press/release semantics — `remote.js:3058`

Momentary (push-to-talk, hold-to-transmit). The native app should mirror this
exactly, including the audio gating and the WS protocol.

```js
function pttStart() {
  if (ssbPlayingIdx >= 0) { stopSsbPlayback(); return; } // tap cancels a macro
  if (pttDown) return;
  pttDown = true;
  pttBtn.classList.add('active');
  txBanner.classList.remove('hidden');
  muteRxAudio(true);                       // duck RX so you don't hear yourself
  localAudioStream...tracks.enabled = true; // open the mic to the modulator
  ws.send(JSON.stringify({ type: 'ptt', state: true }));
}
function pttStop() {
  if (!pttDown) return;
  pttDown = false;
  pttBtn.classList.remove('active');
  txBanner.classList.add('hidden');
  muteRxAudio(kiwiRxConnected);            // stay ducked only if SDR RX is live
  localAudioStream...tracks.enabled = false; // re-mute mic (kills VOX/feedback)
  ws.send(JSON.stringify({ type: 'ptt', state: false }));
}
```

Bindings (`remote.js:3093`):

```js
pttBtn.addEventListener('touchstart',  e => { e.preventDefault(); pttStart(); });
pttBtn.addEventListener('touchend',    e => { e.preventDefault(); pttStop();  });
pttBtn.addEventListener('touchcancel', e => { e.preventDefault(); pttStop();  });
pttBtn.addEventListener('mousedown',   e => { e.preventDefault(); pttStart(); });
pttBtn.addEventListener('mouseup',     e => { e.preventDefault(); pttStop();  });
pttBtn.addEventListener('mouseleave',  () => { if (pttDown) pttStop(); });
// Spacebar PTT for the iPad keyboard case (guarded by isInputFocused()).
```

Server → client safety messages (`remote.js:1344`): `ptt-timeout` and
`ptt-force-rx` both force `pttDown = false` and clear `.active`. The native app
**must** honor these (the host can yank you back to RX).

---

## Visibility gating

PTT is only meaningful in a voice mode. The bar hides the button when the rig
isn't in a voice mode (`remote.js:1808`):

```js
pttBtn.classList.toggle('hidden', !isVoice); // CW/digital → no software PTT
```

---

## Don't confuse it with the *other* PTT

There are **two** PTT controls in ECHOCAT Web:

| Control | Element | Where it's used | Positioning |
|---|---|---|---|
| **Bottom-bar PTT** (this doc) | `#ptt-btn` / `.ptt-button` | main spot/log/map UI | docked (portrait) → **floating pill (phone landscape)** |
| **VFO PTT row** | `#vf-ptt` / `.vf-ptt-row` / `.vf-ptt-btn` (`remote.css:3726`) | the VFO full-view panel | fixed to viewport bottom; at **≥1000px** it docks into the VFO sidebar and the bottom-bar PTT is hidden (`remote.css:3996`) |

So at iPad-landscape widths (≥1000px) PTT lives only in the VFO panel and the
bottom-bar PTT is suppressed. The "floating PTT in landscape" you were asked
about is specifically the **phone-landscape bottom-bar pill**.

---

## Gotchas to carry into native

- **`touch-action: none` on the PTT element** — without it the browser steals
  the press for scroll/zoom and PTT stutters. Native equivalent: make the PTT
  hit-target consume the gesture; don't let a parent scroll view cancel it.
- **`preventDefault()` on touch events** — stops the synthetic mouse event and
  page scroll. Native: claim the touch on down.
- **`mouseleave` releases** — if the pointer slides off the button mid-press it
  must release (avoid a stuck key). Native: treat drag-off / gesture-cancel as
  release.
- **Floats *over* content; don't reflow content under it** — pad the scroll
  area instead (`padding-bottom: 56px`) so the pill never hides the last row.
- **Safe area is non-negotiable in landscape** — anchor inside
  `safe-area-inset-right` + bottom, or the pill sits under the home indicator /
  rounded corner.
- **Defensive `ptt:false` on reconnect** — see
  [`mobile-handoff-reconnect-defensive-ptt.md`](mobile-handoff-reconnect-defensive-ptt.md):
  do **not** fire a bare `{type:'ptt',state:false}` on WS reconnect while the
  desktop FT8 engine owns TX. The desktop now ignores it, but the native client
  should self-identify a defensive reset rather than send a real release.

---

## Native reimplementation checklist

- [ ] One PTT control cluster; reflow by orientation, don't build a 2nd widget.
- [ ] Landscape (short height): anchor it bottom-trailing, inside the safe area,
      as a compact pill floating above scrollable content (blur/translucent bg).
- [ ] Portrait: dock it full-width at the bottom in normal flow.
- [ ] Pad scroll content so nothing hides behind the floating pill.
- [ ] Momentary press = TX; release/drag-off/cancel = RX. Duck RX + open mic on
      press; re-mute mic on release.
- [ ] Send `{type:'ptt',state:true/false}` over the control WS; honor
      `ptt-timeout` / `ptt-force-rx` from the host.
- [ ] Hide PTT when the rig isn't in a voice mode.
- [ ] Suppress bottom PTT when a docked VFO panel owns PTT (large widths).
```
