# Serial CAT (Kenwood)

**Best for:** QRPLabs QMX/QDX, Kenwood, Elecraft, Yaesu (via FA/MD commands), and any radio that speaks Kenwood protocol over USB serial.

1. Add a new rig → select **Serial CAT (Kenwood)**
2. Choose your COM port
3. Set the baud rate
4. Check **Disable DTR/RTS** if your radio uses DTR for PTT
5. Click **Test Connection** to verify
6. Save

POTACAT sends only `FA` (frequency) and `MD` (mode) commands. Any radio that responds to `FA;` with a frequency will work.

**Yaesu radios** also support these commands — POTACAT auto-detects 9-digit (Yaesu) vs 11-digit (Kenwood) FA format from the radio's response.


