# VARA HF and VARA FM in POTACAT Winlink — plan

**Status (2026-10-23): planned, not started.** Owner: desktop. Casey asked for the plan after the
gateway census below. Decision context: Casey prefers open modems (ARDOP is bundled, Mercury is
listed); VARA is **bring-your-own** — nothing of VARA is ever shipped, downloaded, licensed or
configured for the operator beyond pointing Pat at it. VARA HF is already built behind a hidden
setting (`winlinkShowVara`); this plan exposes it properly and adds VARA FM.

## Why (the Winlink gateway census, FN20, 2026-10-23 from Pat's rmslist)

| Mode | ≤ 60 km | ≤ 150 km | ≤ 400 km | worldwide | In POTACAT today |
|---|---|---|---|---|---|
| Packet (VHF/UHF) | 7 | 44 | 147 | 1,261 | yes (Windows/Linux, needs a sound-card VHF rig) |
| VARA FM (VHF/UHF) | 6 | 38 | 114 | 1,036 | **no** |
| VARA HF | 2 | 12 | 30 | 361 | built, hidden |
| Pactor | 1 | 1 | 4 | 142 | no (hardware modem) |
| ARDOP (HF) | 0 | 1 | 4 | 122 | yes (bundled) |

ARDOP reaches one gateway within 150 km of Casey (KG4OCM, 86 km, 7102.1). VARA HF triples that
and VARA FM is the other half of nearly every 2 m packet gateway. Nearest VARA: N3MEL-11 (22 km,
VARA 500 on 3596 / VARA FM 145.670), KB3PCY (32 km, VARA on 3592), K3FZT (64 km, VARA 2750 on
3585; VARA FM WIDE 145.670), W3PLG (66 km, VARA 500 on 7105.5), KG4OCM (86 km, VARA 2750 7102.1).

## Facts (verified unless marked SPIKE)

| Fact | Source |
|---|---|
| Pat 1.0.0 has both transports: `varahf` and `varafm` (`MethodVaraHF/FM`), each with its own config section `{addr, bandwidth?, rig, ptt_ctrl}`; defaults `localhost:8300` for BOTH. `varahf.bandwidth` 500/2300/2750 is sent to the modem at init (`m.SetBandwidth`); `varafm` has no bandwidth. With `ptt_ctrl: true` Pat keys through the named Hamlib rig — our loopback rigctld shim, exactly as ARDOP does today. | pat `cfg_config.go` 231-243, 431-436; `app_connect.go` initVARA |
| Gateway list: Pat classifies `VARA FM` / `VARA FM WIDE` rows as `varafm` and every other `VARA…` row (`VARA`, `VARA 500`, `VARA 2750`) as `varahf`. Connect URLs: `varahf:///CALL?bw=2750&freq=7102.1`, `varafm:///CALL?freq=145670`. | `app_rmslist.go` IsMode/toTransport |
| POTACAT already writes `varahf` into Pat's config (`lib/winlink-pat.js buildPatConfig`, `transport.varaAddr/varaBw`), builds `varahf:///` URLs (`sessionUrl`), gates the mode (`lib/winlink-modes.js`, `showVara`, Windows-only, Mercury port clash), has `winlinkVaraPort`/`winlinkVaraBw` settings and hidden Settings fields, and names the failure (`VARA HF is not answering on port N — start VARA (and set its PTT to None) first`). Mercury already rides Pat's `varahf` transport, so the session machinery (acquire radio, QSY DIGU, shim PTT + 30 s failsafe, cap, watchdog, dial restore) is proven on this exact path. | main.js 8446-8661, 9156-9200, lib/winlink-pat.js |
| The Flex TX-audio switch for a sound-device modem exists (`winlinkFlexDaxOn/Restore`, the DAX era of ARDOP) and is skipped on the socket route. VARA is closed source, so it is a DAX / USB-CODEC modem, never the socket one. | main.js 9231-9260 |
| VARA's TNC control protocol is the one Mercury emulates: `MYCALL`, `LISTEN ON/OFF`, `BW500/2300/2750`, `CONNECT`, `DISCONNECT`, `VERSION`, replies `OK/WRONG/PENDING/CANCELPENDING/CONNECTED/DISCONNECTED/BUSY ON|OFF/PTT ON|OFF/BUFFER`. `lib/mercury-client.js parseControlLine` already parses it — a VARA pre-check can reuse it. | lib/mercury-client.js, Mercury's VARA-compatibility claim |
| VARA HF and VARA FM are separate Windows programs (EA5HVK, rosmodem.wordpress.com — already in the open-external allowlist). Both default to command port 8300 / data 8301, so both cannot run at once unchanged; VARA FM's port is changed in its own Settings. Wide/narrow for VARA FM is a setting in VARA FM's own GUI, not a TNC command. Sound devices are chosen in each program's own Settings and saved in its `.ini` beside the exe. Unlicensed copies run speed-limited; a licence is bought from the author. **SPIKE: exact exe paths, ini key names, the free-version limits wording, and whether VARA emits `PTT` lines when its own PTT is "None" (Pat relies on it).** | author's site; to confirm on a Windows PC with VARA installed |
| Mercury and VARA HF are the same Pat transport, so only one of them can own `varahf.addr` at a time — the session rewrites Pat's config and reloads before connecting (already done for Mercury). | main.js 9188-9191 |

## Design

**One sentence:** VARA HF and VARA FM become two more entries in Send via, available on Windows
when the operator has installed VARA, with POTACAT launching the program, pointing Pat at it,
keying the radio through the shim as for every other mode, and the gateway list, waterfall,
power/SWR, abort, cap and dial restore unchanged.

### Settings (Settings > Station > Winlink (email over radio))

A "VARA (your own copy, Windows)" row replacing the hidden fields:
- **Use VARA HF** (`enableVaraHf`, default off) — path to `VARA.exe` (auto-found, Browse), port (8300),
  bandwidth 500/2300/2750 (`winlinkVaraBw`, exists).
- **Use VARA FM** (`enableVaraFm`, default off) — path to `VARAFM.exe` (auto-found, Browse), port
  (default **8310**, because VARA FM ships on 8300 too; the help text says to set 8310 in VARA FM's
  Settings).
- **Start VARA for me** (`varaAutoLaunch`, default on): POTACAT launches the program minimised at
  session start if it is not already running, and leaves it running (the operator's window; never
  killed, like JS8Call).
- Copy: "VARA is EA5HVK's modem, installed and licensed by you; POTACAT points its Winlink client
  at it. In VARA, set PTT to **None** (POTACAT keys the radio) and choose your radio's sound card.
  Without a licence VARA runs at reduced speed." Links: rosmodem.wordpress.com.
- Path, ports and auto-launch are GLOBAL_KEYS (machine); enable flags and bandwidth per profile.
- `winlinkShowVara` is retired (migrated: true → `enableVaraHf`).

### Mode gating (`lib/winlink-modes.js`, pure)

- `vara` (label "VARA HF (radio, your own VARA)") and new `varafm` ("VARA FM (radio, your own VARA FM)").
- Available only when: Windows, the enable flag, the exe found (or the port answering), the rig's
  audio is a sound device (Flex Direct → DAX must be running: reason "Start DAX and pick DAX RX/TX
  in VARA"; Icom Network → unavailable, "no other program can open this radio's audio"), not remote.
- Port clash reasons: VARA HF vs Mercury (exists), VARA HF vs VARA FM.

### Launch and pre-check (`lib/vara-process.js`, pure + main glue)

- `varaPathCandidates({settings, kind:'hf'|'fm'})`: explicit path, then `C:\VARA\VARA.exe`,
  `C:\VARA FM\VARAFM.exe`, `%ProgramFiles(x86)%\VARA\…` (SPIKE confirms).
- `spawnVara(kind)` modelled on `spawnMercury` but **detached, never killed**, stdout ignored (it is a
  GUI); `windowsHide:false`.
- `probeVara(port)`: connect to the command port, send `VERSION`, parse with `parseControlLine`,
  2 s timeout → `{ok, version}`. Used by the mode gate (every `winlinkPush`, cached 10 s) and by
  session start (start the program, wait ≤ 15 s for the port, then connect).
- `readVaraIni(path)` (read-only, SPIKE for keys): the sound devices VARA will open, shown in the
  mail window's "Radio sound:" line ("VARA: DAX Audio RX 1 / DAX Audio TX") and compared with the
  rig's devices — a mismatch is a warning, never a block.

### Session (main.js `winlinkStartSession`)

- `vara`: as today (Pat `varahf`, `bw=` from `winlinkVaraBw`, QSY DIGU, `winlinkFlexDaxOn()` on a
  Flex). New: launch/probe first; the "not answering" message names the port and the fix.
- `varafm`: Pat `varafm` config section (`addr: 127.0.0.1:<fmPort>, rig:'potacat', ptt_ctrl:true`),
  URL `varafm:///CALL?freq=`, QSY **FM** (like packet), bands 2m/1.25m/70cm, gateway rows
  `VARA FM` / `VARA FM WIDE` (the row says which; the operator's VARA FM must be set to match —
  shown in the row and the session text).
- PTT: Pat keys through the shim on VARA's `PTT ON/OFF` (as Mercury). The 30 s failsafe, cap and
  no-progress watchdog apply unchanged. SWR guard abort applies.
- Mercury vs VARA HF on `varahf.addr`: rewritten per session (exists).

### Surfaces

- Mail window / ECHOCAT Web / app: nothing new — the two modes arrive in `winlink-state.modes`
  with reasons, the band picker already handles VHF bands for packet. Mobile handoff: one line
  ("two more mode ids: `vara`, `varafm`; FM bands as packet").
- Bug report `**Winlink:**` line gains `vara hf: <version|not running>`, `vara fm: …`.

### Tests

- `test/vara-process-test.js`: path candidates, ini reader on fixtures, probe against a fake VARA
  (net server answering `VERSION`), port-clash and gating cases in `winlink-units-test`.
- `winlink-pat-test`: `varafm` config section shape, `varafm:///` URL, no `bw` on FM.
- `winlink-main-wiring-test`: session start probes/launches before connecting; QSY FM for varafm;
  nothing of VARA in `extraResources`, `scripts/build-winlink-helpers.sh` or NOTICE (never bundled).

## Phases

1. **Spike (Windows PC with VARA HF + VARA FM trial installed):** exe/ini paths and keys, `VERSION`
   reply, PTT lines with PTT=None, VARA FM port change, a trial-licence session each to the nearest
   gateway (VARA HF: KG4OCM 7102.1 from the 8600 over DAX; VARA FM needs a 2 m FM radio on a sound
   card — Casey's station has none today, so FM is verified by the first user who has one).
2. **VARA HF exposed:** settings row, auto-launch, probe, ini readout, DAX gate, retire
   `winlinkShowVara`. Release note: "VARA HF, if you have it installed (Windows)".
3. **VARA FM:** `varafm` transport, FM QSY, VHF bands, wide/narrow in the row text.
4. **Docs/handoffs:** docs page section (install VARA, PTT None, sound card, port 8310 for FM),
   mobile one-liner, privacy policy unchanged (same Winlink network).

## Risks

- VARA emits no `PTT` lines unless its PTT is configured (SPIKE); if so Pat never keys and the
  session times out — the pre-check must detect it (send a `PTT` test? no: VARA keys only on
  connect) → fall back to telling the operator the exact VARA setting.
- DAX on a Flex is back in the loop for VARA (closed source, no socket backend): the DAX-era
  failures (0 W into the DAX TX endpoint, device numbering) return for this mode only. The ARDOP
  socket route stays the recommendation; VARA is "if you need those gateways".
- Two programs on 8300: the FM default of 8310 avoids it only if the operator changes VARA FM's
  port; the probe tells them when both answer on the same port.
- Licence: POTACAT must never enter, store or automate a VARA licence key, and must not imply the
  free version is full speed.
