# rig-presets.js grown: FIELDS, rules, Guest Pass tune (appendix 10/24)

Recorded 2026-10-24 (date is when the note was written, taken from the text or the nearest release). Moved verbatim from the desktop CLAUDE.md on 2026-11-09; the original is archived in the potacat workspace at docs/history/CLAUDE-desktop-2026-11-09.md.

Originally a stray appendix at the bottom of CLAUDE.md, dated "(10/24)".

**rig-presets.js grown: FIELDS, rules, Guest Pass tune (appendix 10/24)** (10/24) rig-presets.js grown: FIELDS (levels, filterWidth, nb/nr/anf/comp/vox/preamp/att, agc), sanitizeRules/matchTrigger/describeRule; decideModePreset takes band + prevMatchId (prevMatchId undefined → derived from prevFamily, old contract). main: rigPresetBand/rigPresetOnBand (sendCatFrequency), settings.rigPresetRules. Renderer: rigPresetsMount(root) ×2 (#rig-preset-root, #settings-preset-root under Settings tab data-tab="profiles"). Guest Pass: tune never refused by class; TX gates take freqHz/mode; pass sessions get tune-blocked + ptt-applied false; _settingsFor forces hideOutOfBand false. lib/serial-port-presence.js: connectCat waits for a missing COM port; settings.catNone remembers "None". rigctld: bridge models (1,2,4,5,6) resolved by name; Jupiter/Argonaut V get dtr/rts ON.
