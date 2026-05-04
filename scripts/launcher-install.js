#!/usr/bin/env node
// POTACAT Remote Launcher — installer/uninstaller
// Sets up auto-start at logon so the launcher runs in the background.
// Auth uses your callsign from POTACAT settings (no token to remember).
//
// Usage:
//   node scripts/launcher-install.js            — install
//   node scripts/launcher-install.js --uninstall — remove

const { execSync } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const DEFAULT_PORT = 7301;

function getConfigDir() {
  if (IS_WIN) return path.join(process.env.APPDATA || '', 'potacat');
  if (IS_MAC) return path.join(os.homedir(), 'Library', 'Application Support', 'potacat');
  return path.join(os.homedir(), '.config', 'potacat');
}

const CONFIG_DIR = getConfigDir();
const CONFIG_PATH = path.join(CONFIG_DIR, 'launcher-config.json');
const SETTINGS_PATH = path.join(CONFIG_DIR, 'settings.json');

// --- Uninstall ---
function uninstall() {
  console.log('Removing POTACAT Launcher...\n');

  if (IS_WIN) {
    const vbsPath = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'POTACAT-Launcher.vbs');
    if (fs.existsSync(vbsPath)) {
      fs.unlinkSync(vbsPath);
      console.log('  Removed startup script');
    } else {
      console.log('  No startup script found (already removed)');
    }
    const batPath = path.join(CONFIG_DIR, 'launcher-start.bat');
    if (fs.existsSync(batPath)) fs.unlinkSync(batPath);
  } else if (IS_MAC) {
    const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.potacat.launcher.plist');
    if (fs.existsSync(plistPath)) {
      try { execSync(`launchctl unload "${plistPath}"`, { stdio: 'pipe' }); } catch {}
      fs.unlinkSync(plistPath);
      console.log('  Removed LaunchAgent');
    }
  } else {
    const autostartPath = path.join(os.homedir(), '.config', 'autostart', 'potacat-launcher.desktop');
    if (fs.existsSync(autostartPath)) {
      fs.unlinkSync(autostartPath);
      console.log('  Removed autostart entry');
    }
  }

  if (fs.existsSync(CONFIG_PATH)) {
    console.log(`\n  Config preserved at: ${CONFIG_PATH}`);
    console.log('  Delete manually if no longer needed.');
  }

  console.log('\nDone.');
}

// --- Install ---
function install() {
  console.log('Installing POTACAT Remote Launcher...\n');

  // Create config dir
  fs.mkdirSync(CONFIG_DIR, { recursive: true });

  // Load or create config (just port + https, no token).
  // https defaults to false — see comment in scripts/launcher.js. The
  // self-signed cert is rejected by iOS / Android fetch without cert
  // pinning which the mobile app doesn't yet implement. Existing installs
  // with https:true in their config keep that setting (the spread below
  // preserves user choice).
  let config = { port: DEFAULT_PORT, potacatPath: 'auto', https: false };
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const existing = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      config = { ...config, ...existing };
      // Remove old token field if present
      delete config.token;
      console.log('  Existing config found — preserving settings');
    } catch {}
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  console.log(`  Config saved to: ${CONFIG_PATH}`);

  // Check for callsign in settings
  let callsign = null;
  try {
    const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    callsign = settings.launcherPassphrase || settings.myCallsign || null;
  } catch {}

  // Resolve paths
  const launcherScript = path.resolve(__dirname, 'launcher.js');
  const nodeExe = process.execPath;

  // Platform-specific auto-start
  if (IS_WIN) {
    installWindows(nodeExe, launcherScript);
  } else if (IS_MAC) {
    installMac(nodeExe, launcherScript);
  } else {
    installLinux(nodeExe, launcherScript);
  }

  // Print access info
  const proto = config.https ? 'https' : 'http';
  console.log('\n  ===================================');
  console.log('  POTACAT Remote Launcher installed!');
  console.log('  ===================================\n');

  if (callsign) {
    console.log(`  Passphrase: your callsign (${callsign})\n`);
  } else {
    console.log('  Passphrase: set your callsign in POTACAT Settings first!\n');
  }

  console.log(`  Local URL:   ${proto}://127.0.0.1:${config.port}/`);
  const interfaces = os.networkInterfaces();
  for (const addrs of Object.values(interfaces)) {
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) {
        const label = addr.address.startsWith('100.') ? ' (Tailscale)' : '';
        console.log(`  Network URL: ${proto}://${addr.address}:${config.port}/${label}`);
      }
    }
  }

  console.log('\n  Open the URL on your phone, enter your callsign, done.');
  console.log('  The launcher auto-starts when you log in to Windows.');
  console.log(`\n  To start now:  node "${launcherScript}"`);
  console.log(`  To uninstall:  node "${path.resolve(__dirname, 'launcher-install.js')}" --uninstall`);
}

function installWindows(nodeExe, launcherScript) {
  const startupDir = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  const vbsPath = path.join(startupDir, 'POTACAT-Launcher.vbs');
  const vbsContent = `Set WshShell = CreateObject("WScript.Shell")\r\nWshShell.Run """${nodeExe}"" ""${launcherScript}""", 0, False\r\n`;
  fs.writeFileSync(vbsPath, vbsContent);
  console.log(`  Created startup script: ${vbsPath}`);
}

function installMac(nodeExe, launcherScript) {
  const plistDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
  fs.mkdirSync(plistDir, { recursive: true });
  const plistPath = path.join(plistDir, 'com.potacat.launcher.plist');
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.potacat.launcher</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodeExe}</string>
    <string>${launcherScript}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${path.join(CONFIG_DIR, 'launcher.log')}</string>
  <key>StandardErrorPath</key><string>${path.join(CONFIG_DIR, 'launcher.log')}</string>
</dict>
</plist>`;
  fs.writeFileSync(plistPath, plist);
  try { execSync(`launchctl load "${plistPath}"`, { stdio: 'pipe' }); } catch {}
  console.log(`  Created LaunchAgent: ${plistPath}`);
}

function installLinux(nodeExe, launcherScript) {
  const autostartDir = path.join(os.homedir(), '.config', 'autostart');
  fs.mkdirSync(autostartDir, { recursive: true });
  const desktopPath = path.join(autostartDir, 'potacat-launcher.desktop');
  const desktop = `[Desktop Entry]
Type=Application
Name=POTACAT Launcher
Exec=${nodeExe} ${launcherScript}
Hidden=false
NoDisplay=true
X-GNOME-Autostart-enabled=true
`;
  fs.writeFileSync(desktopPath, desktop);
  console.log(`  Created autostart entry: ${desktopPath}`);
}

// --- Main ---
if (process.argv.includes('--uninstall')) {
  uninstall();
} else {
  install();
}
