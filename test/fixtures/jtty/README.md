# JTTY fixtures

`260807_134110.wav` is WSJT-X's JTTY sample, `samples/JTTY/260807_134110.wav`
at tag v3.2.0-rc1 (GPL-3.0, the WSJT-X team), 12 000 Hz 16-bit mono, 725 992
bytes, SHA-256 `4c3f7ef7266d6ad32a7cb630066376e25e7e104a3afa06c8dbe92842d8e49afc`.

WSJT-X 3.2.0-rc1 decodes it as one message at 1507 Hz, time 13:41:13:

    RAN ALL NIGHT ON BAND NOISE - NO FALSE DECODES!

(the user guide's JTTY screenshot). That is the Phase 2 decoder's acceptance
case in docs/jtty-integration-plan.md. The user guide calls the signal weak
enough that 45.45-baud RTTY would decode it marginally.

## `sjtty-16dB/`

Five of the ten noise files `sjtty` (WSJT-X v3.2.0-rc1, built from source)
generated for `CQ K1ABC CQ` at −16 dB, with `rjtty`'s verdict on each in
`verdicts.json`. The decoder test asserts our receiver makes the same five
decisions; across the full −14 to −17 dB sets it matched rjtty on all 40
files. Keep these bytes as they are: the point is that WSJT-X's own tools
made them.
