# CW Keyer

POTACAT includes a built-in CW keyer for FlexRadio users with a MIDI paddle (e.g. HaliKey).

**Setup:**
1. Enable CW Keyer in Settings → CW Keyer
2. Select your **Keyer Mode**: Iambic B, Iambic A, or Straight key
3. Set your **Speed** (WPM)
4. Click **Refresh** to detect MIDI devices, then select yours
5. Use the **Learn** buttons to map dit and dah MIDI notes from your paddle
6. Enable **Local sidetone** and adjust pitch/volume

**How it works:** POTACAT reads MIDI paddle events via the Web MIDI API, runs an Iambic keyer state machine, and sends `cw key` commands directly to your FlexRadio via the SmartSDR TCP API. This preserves your exact fist timing — no buffering.

**CW status:** The CW pill in the status bar shows keyer state. Click it for a popover with volume and WPM controls. The sidetone requires one click anywhere in the app to unlock (browser audio policy).

---


