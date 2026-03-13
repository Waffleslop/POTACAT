# Win4Yaesu Setup

If you use Win4Yaesu Suite, both programs need access to the radio's serial port. The solution is **COM0COM** (free virtual COM port driver):

1. Install COM0COM (signed 64-bit version)
2. Create a virtual port pair (e.g. COM18 ↔ COM19)
3. In Win4Yaesu: assign COM18 to an AUX/CAT port
4. In POTACAT: set up Serial CAT (Kenwood) on COM19

```
POTACAT ←→ COM19 ──(COM0COM)── COM18 ←→ Win4Yaesu ←→ Radio
```

Win4Yaesu caches radio state, so POTACAT's polling doesn't add load on the radio. Multiple programs can run simultaneously on separate AUX/CAT ports.


