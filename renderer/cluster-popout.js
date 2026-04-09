// DX Cluster Terminal Pop-out — renderer logic
(function () {
  'use strict';

  const SPOT_RE = /^DX\s+de\s+/i;
  const SPOT_PARSE_RE = /^DX\s+de\s+\S+:\s+(\d+\.?\d*)\s+(\S+)\s+(.*?)\s+\d{4}Z/i;
  const MAX_LINES = 500;

  // Simple mode inference from comment text and frequency
  function inferMode(comment, freqKhz) {
    const c = (comment || '').toUpperCase();
    if (c.includes('FT8')) return 'FT8';
    if (c.includes('FT4')) return 'FT4';
    if (c.includes('CW'))  return 'CW';
    if (c.includes('RTTY')) return 'RTTY';
    if (c.includes('SSB') || c.includes('USB') || c.includes('LSB')) return 'SSB';
    if (c.includes('FM'))  return 'FM';
    // Frequency-based fallback
    const cwTop = { 1850:1, 3600:1, 7050:1, 10150:1, 14070:1, 18110:1, 21070:1, 24930:1, 28070:1 };
    const digiTop = { 3600:1, 7080:1, 14100:1, 18110:1, 21110:1, 24930:1, 28150:1 };
    for (const [edge] of Object.entries(cwTop)) {
      if (freqKhz <= Number(edge)) return 'CW';
    }
    return 'SSB';
  }

  function parseSpotLine(text) {
    const m = text.match(SPOT_PARSE_RE);
    if (!m) return null;
    const freqKhz = parseFloat(m[1]);
    const callsign = m[2];
    const comment = m[3].trim();
    const mode = inferMode(comment, freqKhz);
    return { freqKhz, callsign, mode };
  }

  const BANNER = [
    ' ____   ___ _____  _    ____    _  _____',
    '|  _ \\ / _ \\_   _|/ \\  / ___|  / \\|_   _|',
    '| |_) | | | || | / _ \\| |     / _ \\ | |',
    '|  __/| |_| || |/ ___ \\ |___ / ___ \\| |',
    '|_|    \\___/ |_/_/   \\_\\____/_/   \\_\\_|',
    '',
    'DX Cluster Terminal',
    '',
  ];

  const terminalEl = document.getElementById('terminal');
  const terminalWrap = document.getElementById('terminal-wrap');
  const tabsEl = document.getElementById('node-tabs');
  const noNodesMsg = document.getElementById('no-nodes-msg');
  const cmdInput = document.getElementById('cmd-input');
  const cmdSend = document.getElementById('cmd-send');

  // Per-node line buffers: Map<nodeId, string[]>
  const nodeBuffers = new Map();
  let activeNodeId = null;
  let nodes = []; // [{id, name, host, connected}]
  let userScrolled = false;

  // --- Titlebar controls ---
  document.getElementById('tb-min').addEventListener('click', () => window.api.minimize());
  document.getElementById('tb-max').addEventListener('click', () => window.api.maximize());
  document.getElementById('tb-close').addEventListener('click', () => window.api.close());

  // --- Auto-scroll tracking ---
  terminalWrap.addEventListener('scroll', () => {
    const { scrollTop, scrollHeight, clientHeight } = terminalWrap;
    userScrolled = (scrollHeight - scrollTop - clientHeight) > 20;
  });

  function scrollToBottom() {
    if (!userScrolled) {
      terminalWrap.scrollTop = terminalWrap.scrollHeight;
    }
  }

  // --- Render terminal buffer for active node ---
  function renderTerminal() {
    const lines = nodeBuffers.get(activeNodeId) || [];
    const frag = document.createDocumentFragment();
    for (const entry of lines) {
      frag.appendChild(makeLineEl(entry.text, entry.cls));
    }
    terminalEl.innerHTML = '';
    terminalEl.appendChild(frag);
    scrollToBottom();
  }

  // --- Append a single line (if for the active node, render incrementally) ---
  function appendLine(nodeId, text, cls) {
    if (!nodeBuffers.has(nodeId)) nodeBuffers.set(nodeId, []);
    const buf = nodeBuffers.get(nodeId);
    buf.push({ text, cls: cls || '' });
    if (buf.length > MAX_LINES) buf.shift();

    if (nodeId === activeNodeId) {
      terminalEl.appendChild(makeLineEl(text, cls));
      // Trim DOM to match buffer
      while (terminalEl.children.length > MAX_LINES) {
        terminalEl.removeChild(terminalEl.firstChild);
      }
      scrollToBottom();
    }
  }

  // --- Node tabs ---
  function renderTabs() {
    tabsEl.innerHTML = '';
    if (nodes.length === 0) {
      tabsEl.appendChild(noNodesMsg);
      return;
    }
    for (const node of nodes) {
      const tab = document.createElement('div');
      tab.className = 'node-tab' + (node.id === activeNodeId ? ' active' : '');
      tab.innerHTML = `<span class="tab-dot ${node.connected ? 'connected' : 'disconnected'}"></span>${escapeHtml(node.name)}`;
      tab.addEventListener('click', () => {
        activeNodeId = node.id;
        renderTabs();
        renderTerminal();
      });
      tabsEl.appendChild(tab);
    }
  }

  function escapeHtml(str) {
    const d = document.createElement('span');
    d.textContent = str;
    return d.innerHTML;
  }

  // Build a terminal line element — spot lines are clickable for QSY
  function makeLineEl(text, cls) {
    const div = document.createElement('div');
    div.textContent = text;
    if (cls) div.className = cls;
    if (cls === 'term-line-spot') {
      const spot = parseSpotLine(text);
      if (spot) {
        div.classList.add('term-line-clickable');
        div.title = `Tune to ${spot.callsign} on ${spot.freqKhz} kHz (${spot.mode})`;
        div.addEventListener('click', () => {
          window.api.tune(String(spot.freqKhz), spot.mode);
          // Brief flash to confirm click
          div.style.background = 'rgba(224, 64, 251, 0.25)';
          setTimeout(() => { div.style.background = ''; }, 300);
        });
      }
    }
    return div;
  }

  // --- Incoming raw line from cluster ---
  window.api.onClusterLine(({ nodeId, line }) => {
    const cls = SPOT_RE.test(line) ? 'term-line-spot' : '';
    appendLine(nodeId, line, cls);
  });

  // --- Node list updates ---
  const announcedState = new Map(); // nodeId → last announced connected state
  window.api.onNodes((newNodes) => {
    nodes = newNodes;
    // Auto-select first node if nothing selected or current node removed
    if (!activeNodeId || !nodes.find(n => n.id === activeNodeId)) {
      activeNodeId = nodes.length > 0 ? nodes[0].id : null;
    }
    // Announce connection state changes
    for (const node of nodes) {
      const prev = announcedState.get(node.id);
      if (prev !== node.connected) {
        announcedState.set(node.id, node.connected);
        const msg = node.connected
          ? `Connected to ${node.name} (${node.host})`
          : `Disconnected from ${node.name}`;
        appendLine(node.id, '--- ' + msg + ' ---', 'term-line-cmd');
      }
    }
    renderTabs();
  });

  // --- Command Help Panel ---
  const HELP_COMMANDS = [
    { section: 'Spots', cmds: [
      { cmd: 'SH/DX', desc: 'Show last 10 spots' },
      { cmd: 'SH/DX 25', desc: 'Show last 25 spots' },
      { cmd: 'SH/DX on 20m', desc: 'Spots on 20 meters' },
      { cmd: 'SH/DX/BAND 40m', desc: 'Spots on 40 meters' },
    ]},
    { section: 'Info', cmds: [
      { cmd: 'SH/WWV', desc: 'Solar and propagation data' },
      { cmd: 'SH/WCY', desc: 'Geomagnetic data' },
      { cmd: 'SHOW/TIME', desc: 'Server time' },
      { cmd: 'SH/MUF', desc: 'MUF predictions' },
    ]},
    { section: 'Filters', cmds: [
      { cmd: 'SET/FILTER', desc: 'Show current filters' },
      { cmd: 'REJECT/SPOTS ON 160M', desc: 'Hide 160m spots' },
      { cmd: 'ACCEPT/SPOTS ON 20M', desc: 'Only show 20m spots' },
      { cmd: 'CLEAR/SPOTS ALL', desc: 'Clear all filters' },
    ]},
  ];

  const helpPanel = document.getElementById('help-panel');
  const cmdHelp = document.getElementById('cmd-help');

  function buildHelpPanel() {
    helpPanel.innerHTML = '';
    for (const section of HELP_COMMANDS) {
      const sec = document.createElement('div');
      sec.className = 'help-section';
      const title = document.createElement('div');
      title.className = 'help-section-title';
      title.textContent = section.section;
      sec.appendChild(title);
      for (const { cmd, desc } of section.cmds) {
        const row = document.createElement('div');
        row.className = 'help-row';
        const cmdEl = document.createElement('span');
        cmdEl.className = 'help-cmd';
        cmdEl.textContent = cmd;
        cmdEl.title = 'Click to send';
        cmdEl.addEventListener('click', () => {
          cmdInput.value = cmd;
          cmdInput.focus();
        });
        const descEl = document.createElement('span');
        descEl.className = 'help-desc';
        descEl.textContent = desc;
        row.appendChild(cmdEl);
        row.appendChild(descEl);
        sec.appendChild(row);
      }
      helpPanel.appendChild(sec);
    }
  }

  buildHelpPanel();

  cmdHelp.addEventListener('click', () => {
    const showing = !helpPanel.classList.contains('hidden');
    helpPanel.classList.toggle('hidden');
    cmdHelp.classList.toggle('active', !showing);
  });

  // --- Send command ---
  function sendCommand() {
    const text = cmdInput.value.trim();
    if (!text) return;
    cmdInput.value = '';
    // Echo command locally
    appendLine(activeNodeId || '__local', '> ' + text, 'term-line-cmd');
    window.api.sendCommand(text, activeNodeId);
  }

  cmdInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      sendCommand();
    }
  });
  cmdSend.addEventListener('click', sendCommand);

  // --- Theme ---
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme === 'light' ? 'light' : '');
  }

  window.api.onTheme(applyTheme);

  // Init: load settings for initial theme
  window.api.getSettings().then((s) => {
    if (s.lightMode) applyTheme('light');
  });

  // Show ASCII banner on load
  const frag = document.createDocumentFragment();
  for (const line of BANNER) {
    const div = document.createElement('div');
    div.textContent = line;
    div.style.color = '#e040fb';
    frag.appendChild(div);
  }
  terminalEl.appendChild(frag);

  // --- VFO Lock: tune-blocked toast ---
  window.api.onTuneBlocked((msg) => {
    let t = document.getElementById('tune-blocked-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'tune-blocked-toast';
      t.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:#e94560;color:#fff;padding:12px 24px;border-radius:8px;font-size:15px;font-weight:bold;z-index:9999;pointer-events:none;box-shadow:0 4px 20px rgba(233,69,96,0.5);opacity:0;transition:opacity 0.2s';
      document.body.appendChild(t);
    }
    t.textContent = msg || 'VFO Locked — Unlock VFO to change frequency';
    t.style.opacity = '1';
    clearTimeout(t._timer);
    t._timer = setTimeout(() => { t.style.opacity = '0'; }, 2000);
  });

  // Focus command input on load
  cmdInput.focus();
})();
