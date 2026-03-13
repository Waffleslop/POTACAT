# Tested Radios

| Radio | Connection | Baud | DTR/RTS Off? | Notes |
|-------|-----------|------|:------------:|-------|
| FlexRadio 6000/8000 | FlexRadio (SmartSDR) | — | — | Works out of the box |
| QRPLabs QMX | Serial CAT (Kenwood) | 38400 | No | Don't use Hamlib; power cycle if stuck in terminal mode |
| QRPLabs QDX | Serial CAT (Kenwood) | 38400 | Yes | DTR = PTT on QDX |
| Yaesu FTX-1 | Serial CAT (Kenwood) | 38400 | No | Hamlib backend failed in testing |
| Xiegu G90 | Other Rig (Hamlib) | 19200 | Only with Digirig | CI-V protocol; try X5105 or IC-718 backend as fallback |
| Kenwood TS-480/590/2000 | Serial CAT (Kenwood) | 9600 | No | Also works with Hamlib |
| Elecraft KX2/KX3/K3 | Serial CAT (Kenwood) | 38400 | No | |
| Elecraft K4 | IP Radio (TCP CAT) | — | — | Ethernet TCP CAT |

If your rig isn't listed, try **Serial CAT (Kenwood)** first — many radios support FA/MD commands — then fall back to **Hamlib**.


