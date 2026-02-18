# Installing POTA CAT on Windows

## Standard Install

1. Download `POTA CAT Setup x.x.x.exe` from [GitHub Releases](https://github.com/Waffleslop/POTA-CAT/releases)
2. Run the installer and follow the prompts
3. Launch POTA CAT from the desktop or Start Menu shortcut

## If the Installer Won't Run

POTA CAT is not yet code-signed, so Windows may block it. Here's how to fix that:

### Step 1: Unblock the file

Right-click the downloaded `.exe` file → **Properties** → check the **Unblock** box at the bottom → click **OK**.

![Unblock](https://github.com/Waffleslop/POTA-CAT/assets/unblock-example.png)

### Step 2: Run as Administrator

Right-click the installer → **Run as administrator**.

### Step 3: If it still won't run — check file permissions

Right-click the installer → **Properties** → **Security** tab → select your username → click **Edit** → check **Full Control** → **OK**.

### Step 4: SmartScreen warning

If you see "Windows protected your PC", click **More info** → **Run anyway**.

## Alternative: Portable Version

If the installer gives you trouble, download the **portable** version instead:

1. Download `POTA CAT-x.x.x-portable.exe` from [GitHub Releases](https://github.com/Waffleslop/POTA-CAT/releases)
2. You may need to **Unblock** it (Step 1 above)
3. Double-click to run — no installation needed

The portable version works identically to the installed version. Your settings are stored in the same location either way.

## Still Having Problems?

- Join the [POTA CAT Discord](https://discord.gg/JjdKSshej) for help
- Open an [issue on GitHub](https://github.com/Waffleslop/POTA-CAT/issues)
- A diagnostic log file (`pota-cat-install.log`) is created next to the installer — include it when reporting issues
