# Zeus and Thetis TCI test

In a standard POTACAT launch, select **Radios running Thetis or Zeus (TCI server)** in the welcome wizard or in **Settings → Radio → Add Rig**. Create a rig for each TCI server you want to use. Choose the server application, enter its host and port, and select **Test connection**. The standard rig supports tuning and JTCAT receive and transmit audio for FT8, FT4, FT2, JS8, JTTY, and PSK31. Transmit requires split off, matching receive and transmit dials, USB or DIGU, and Fake It off. WSPR beacon transmit is unavailable until TCI power-cap control is implemented.

## Standard rig checks

- Keep separate rig entries for Zeus and Thetis so each recalls its host, port, and AGC choices. The initial ports are 40001 for Zeus and 50001 for Thetis. Use the port shown in the radio application's TCI settings if it differs.
- Open JTCAT and confirm RX audio, waterfall, and decodes. The **Peak** readout beside **Auto RX Level** shows incoming audio in dBFS and flags samples near full scale. It is display-only. **Auto RX Level** measures five seconds of receive audio. On a supported local Zeus engine it can balance fixed gain and receiver volume toward the middle of the slider range.
- Start FT8 from EchoCAT while the radio is already on a standard FT8 dial. The TCI dial should initialize the new session's transmit check. Verify Hunt on that band, then verify that an actual dial mismatch blocks transmit and reports both frequencies.
- In EchoCAT, confirm that **RF Gain** presets highlight at 0%, 25%, 50%, 75%, and 100% when the radio reports the corresponding attenuation. Thetis uses its RX1 step attenuator when enabled. **TX Power** sets radio Drive in percent. The **PWR** meter displays measured forward watts.
- On Zeus, tap **NB** and **NR** and check the temporary EchoCAT mode notifications. NB2 requires a server that reports support. Full NR1–NR5 cycling uses the local Zeus engine when available. The TCI-only NR cycle offers Off, NR1, NR2, and NR4.

## Code paths

| Area | Implementation |
| --- | --- |
| Rig setup and connection | `renderer/index.html` and `renderer/app.js` add the Zeus and Thetis choices to the normal rig editor and welcome wizard. `lib/rig-setup-notes.js` supplies setup guidance. `connectTciTestRadio` in `main.js` also serves normal TCI rigs, and retries a failed connection every five seconds. Closing or switching rigs cancels the retry. `probeTci` verifies the handshake without tuning or keying. |
| TCI transport | `lib/tci-jtcat-rx.js` handles RX1 Float32 audio, dial and mode readback, meters, TX pacing and PTT release. `main.js` routes that audio to JTCAT and the EchoCAT bridge. Transmit checks the live RX and TX dials, split and mode before keying. |
| Zeus engine integration | `lib/zeus-engine-port.js` reads the local engine state, redetects a refused engine port, and selects Zeus NR algorithms that TCI does not expose. `lib/zeus-ft8-rx.js` handles exact DSP save and restore in the isolated prototype when its engine port is configured. |
| Band display | Upstream v1.14.3 opens JTCAT by tuning to the saved band. The TCI startup path skips that tune, so the toolbar previously could stay on 20 m while the receiver was on 10 m. `tciJtcatBandDisplay` supplies the confirmed band on window load and on dial changes. `jpApplyBandFollow` updates the display without saving a tune selection. The separate TX dial guard still validates the actual dial. |
| Receive controls | The TCI controller measures peaks about four times per second and shares the sample scan with Auto RX Level. `preload-jtcat-popout.js` carries the peak to JTCAT. Local Zeus Auto RX needs fixed-gain readback to balance around 50% receiver volume. Manual TCI RX changes commit on release, and Zeus's matching whole-dB reply preserves the requested precision. Successful adjustments clear after five seconds. |
| Drive, RF gain, and DSP | The TCI controller translates gain presets to attenuation and back. Thetis exposes its enabled RX1 step attenuator and reports live drive. Hermes-Lite's Thetis drive range of 0–90 is converted to 0–100%. Zeus can return a session-default 50% on a fresh TCI link, so `main.js` prefers engine readback. `lib/rig-power-view.js` and `renderer/radio-level-slider.css` keep the desktop controls consistent. EchoCAT receives `txDrivePct`, `zeusNbLevel`, and `zeusNrLevel` in status. |
| Contact and activation power | JTCAT records measured TCI forward power in watts. Manual logging can use a recent measurement for the same rig and dial. A drive percentage is never stored as watts. |

## Regression checks

- For the band display, start EchoCAT Hunt on 10 m FT8 and open JTCAT. Confirm its toolbar shows **10 m** while the radio stays at **28.074 MHz**. Verify a completed contact shows 10 m in the log. Exercise the off-dial transmit check separately.
- For receive gain, verify **Auto RX Level**, the live **Peak** readout, the five-second result, and an RX slider move **100% → 50% → 100%**. On Zeus those settings correspond to +20 dB, +13.98 dB, and +20 dB RX trim.
- For logging, complete a TCI contact and inspect its transmit power in the logbook and ADIF export.
- The corresponding automated coverage is in `test/tci-jtcat-rx-test.js`, `test/jtcat-dial-follow-test.js`, `test/vfo-tx-power-test.js`, `test/qso-expand-test.js`, and `test/activation-log-test.js`.

## Troubleshooting

- If the TCI connection drops, the standard rig retries every five seconds. Test the TCI host and port from the rig editor while the radio application is running.
- For a local Zeus rig, leave the **Zeus engine port** blank to auto-detect it. Zeus can pick a different engine port after a restart. Auto RX Level needs fixed-gain readback to balance a local Zeus rig. A remote Zeus connection can use volume-only adjustment. The result clears after five seconds.
- Check an EchoCAT-initiated FT8 contact in the logbook after a completed TCI transmission. ADIF `TX_PWR` should contain measured forward watts when the radio supplied usable meter readings.

## Isolated development profile

The test uses an isolated Electron profile. Start Zeus or Thetis, enable its TCI server, then launch POTACAT from source with a dedicated profile:

```sh
POTACAT_TCI_TEST_DATA="$(mktemp -d)" npm start
```

Use the same dedicated path on later launches to keep the test settings and logbook. Choose **Set up TCI radio** in the welcome wizard or open the TCI editor under **Settings → Radio**. Select Zeus or Thetis and enter its host and port. Each server keeps its own address. The initial port is 40001 for Zeus (or the value of `POTACAT_TCI_TEST_PORT`) and 50001 for Thetis. **Test connection** waits for the server handshake without issuing commands. The test instance follows the current radio dial at startup.

The test defaults to receive. Launch with `POTACAT_TCI_TEST_TX=qso` to use JTCAT's transmit controls for FT8, FT4, FT2, JS8, JTTY, and PSK31. JTCAT's usual transmit watchdog applies to the slotted FT modes. Use `POTACAT_TCI_TEST_TX=1` for an isolated test of one FT8 slot. WSPR transmit needs control of the beacon's RF power cap. Voice and CW use separate transmit paths.

Keep other radio clients disarmed. The transmitter requires matching RX and TX dials in USB or DIGU and releases PTT on completion, Halt, an audio stall, or the waveform deadline. In `qso` mode, the operator can start transmitting again after a halt once the radio is ready. If Zeus cannot be reached after a transport failure, the station's own TX timeout is the backstop. The test ADIF records Zeus's peak forward watts from completed bursts for that QSO.

Set `POTACAT_ZEUS_ENGINE_PORT` to the local Zeus engine HTTP port to enable FT8 RX DSP recall. When changing modes from POTACAT, FT8 saves the original settings and temporarily uses fixed gain with receive noise processing disabled. The next non-FT8 mode selection restores the saved settings. This recall uses Zeus-specific state and receive endpoints, separate from TCI.

### EchoCAT voice on the local network

Launch the isolated profile with `POTACAT_TCI_TEST_ECHOCAT=1`. In **Settings → Network → ECHOCAT**, select **Local network and Cloud**, enable the access password, and use a separate listener port such as 17300. The test build leaves Cloud Tunnel off. Pair your phone with the test instance's own EchoCAT QR code, connect audio, and select USB or LSB. The EchoCAT flag enables voice independently of the digital transmit flag.

EchoCAT sends Zeus receive audio to the phone and feeds the phone microphone back to Zeus while PTT is held. It releases PTT on release, loss of the phone or audio connection, missing mic audio, TCI stream stalls, or the PTT timeout. Voice requires matching receive and transmit dials. Use a dummy load for the first phone test and confirm both modulation and return to receive.
