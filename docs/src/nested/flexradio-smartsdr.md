# FlexRadio (SmartSDR)

**Best for:** FlexRadio 6000/8000 series running SmartSDR.

POTACAT connects to SmartSDR's built-in CAT server over TCP. No additional software or cables needed.

1. Add a new rig → select **FlexRadio (SmartSDR)**
2. Choose your slice (A, B, C, or D)
3. Save

SmartSDR exposes Kenwood-compatible CAT on TCP ports 5002–5005:

| Slice | Port |
|-------|------|
| A     | 5002 |
| B     | 5003 |
| C     | 5004 |
| D     | 5005 |

If SmartSDR is on a different computer, use **IP Radio (TCP CAT)** instead with the Flex's IP address.


