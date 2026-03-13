# Other Rig (Hamlib)

**Best for:** Icom, Yaesu, and radios that don't speak Kenwood protocol.

POTACAT bundles **Hamlib 4.6.5** (rigctld) — no separate installation needed. Supports 200+ radio models.

1. Add a new rig → select **Other Rig (Hamlib)**
2. Search for your radio model
3. Choose your COM port and baud rate
4. Click **Test Connection**
5. Save

POTACAT spawns a `rigctld` process, connects via TCP, and translates commands to your radio's native protocol.


