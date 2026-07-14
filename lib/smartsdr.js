// SmartSDR TCP API client — pushes spot markers to FlexRadio panadapter
const net = require('net');
const dgram = require('dgram');
const { EventEmitter } = require('events');

const SOURCE_COLORS_NORMAL = {
  pota: '#FF4ECCA3',
  sota: '#FFF0A500',
  dxc:  '#FFE040FB',
  rbn:  '#FF4FC3F7',
  pskr: '#FFFF6B6B',
  net:  '#FFFFD740',
};
const SOURCE_COLORS_CB = {
  pota: '#FF4FC3F7',
  sota: '#FFFFB300',
  dxc:  '#FFE040FB',
  rbn:  '#FF81D4FA',
  pskr: '#FFFFA726',
  net:  '#FFFFD740',
};
let SOURCE_COLORS = { ...SOURCE_COLORS_NORMAL };

const SOURCE_LIFETIMES = {
  pota: 600,
  sota: 600,
  dxc:  300,
  rbn:  120,
  pskr: 300,
  net:  3600,
};

class SmartSdrClient extends EventEmitter {
  constructor() {
    super();
    this._sock = null;
    this._seq = 1;
    this._buf = '';
    this._reconnectTimer = null;
    this._probeTimer = null;
    this._probeIntervalMs = 60 * 1000; // post-give-up background probe cadence
    this.connected = false;
    this._host = null;
    this._activeSpots = new Set();   // callsigns added in current push cycle
    this._previousSpots = new Set(); // callsigns from last push cycle (for pruning)
    this._spotFreqs = new Map();     // callsign -> last pushed freqMHz (for band-change dedup)
    this._clientHandle = null;       // our client handle from SmartSDR (H<hex>)
    this._ownHandles = new Set();    // every handle WE'VE used this session — lets a
                                     // reconnect recognize its own stale GUI client
                                     // (old handle) instead of binding to the ghost
    this._persistentId = null;       // persistent client_id for client gui
    // CW state
    this._needsCw = false;           // true when CW keyer is active
    this._cwBound = false;           // true if client bind succeeded
    this._bindSeq = null;            // seq of client bind command
    this._discoveredGuiClients = []; // UUIDs of discovered GUI clients from status messages
    this._guiClientHandle = null;    // hex handle of GUI client (e.g. '4E1DDC50') for cw key
    this._cwKeyIndex = 0;            // incrementing index for cw key dedup
    this._cwPttActive = false;       // true when cw ptt is active
    this._cwPttTimer = null;         // holdoff timer to release cw ptt
    this._cwPttHoldoff = 1500;       // ms to hold PTT after last key event (avoids re-keying between words)
    // --- Flex Direct: self-host as a GUI client so POTACAT can run with no
    //     SmartSDR / AetherSDR open. See _promoteOrBind() / _parseSliceStatus().
    this._guiMode = 'none';          // 'none' | 'self' (we ran client gui) | 'bound'
    this._multiflex = true;          // Self-host as our OWN gui client alongside SmartSDR
                                     // (multiFlex) so RX+TX both work with SmartSDR open.
                                     // Requires multiFlex enabled on the radio; falls back
                                     // to bound if the radio refuses a 2nd client.
    this._guiReady = false;          // true once our `client gui` succeeds
    this._guiSeq = null;             // seq of our `client gui` command
    this._ourSliceIndex = null;      // slice rx index the radio bound to our handle
    this._sliceDax = {};             // idx -> DAX channel each slice is routed to (0 = off); read from slice status
    this._slicePan = {};             // idx -> panadapter stream id (0x4000000x); read from slice status.
                                     // WNB is a PAN property, not a slice one — display pan set needs this id.
    this._selfHostTimer = null;      // grace-window timer before we self-host
    this._lastSliceFreq = null;      // last RF_frequency emitted (Hz), for dedup
    this._lastSliceMode = null;      // last mode emitted, for dedup
  }

  /** True after a successful `client bind` for CW keying — main uses this
   *  to decide whether the SmartSDR cwx path is the right CW backend for
   *  a Flex (vs. falling back to WinKeyer / CAT). */
  get cwBound() { return this._cwBound; }

  /** True once POTACAT has self-registered as a GUI client (Flex Direct) —
   *  the radio has restored a slice we can tune over the native API. */
  get guiReady() { return this._guiMode === 'self' && this._guiReady; }

  /** Slice rx index POTACAT tunes in Flex Direct mode (normally 0 / index A,
   *  whatever the radio's band persistence restored on `client gui`). */
  get ourSliceIndex() { return this._ourSliceIndex; }

  /** POTACAT's own client_id once it has self-registered as a GUI client.
   *  The dedicated audio connection (lib/smartsdr-audio.js) binds to this so
   *  RX/TX audio routes in Flex Direct mode — there's no external SmartSDR
   *  GUI client to bind to. */
  get clientId() { return this.guiReady ? this._persistentId : null; }

  /** Current GUI-client role: 'none' | 'self' (Flex Direct) | 'bound'. */
  get mode() { return this._guiMode; }

  /** True when smartSdr can drive a slice — self-host with `client gui` acked
   *  AND a slice index resolved, OR bound to an external GUI client with that
   *  client's active slice tracked. This is what the tune path and the
   *  CAT-status pill key off; `guiReady` alone is too strict for bound mode
   *  (AetherSDR / SmartSDR-Win running). */
  get canTune() {
    if (!this.connected) return false;
    // Self-host: need our `client gui` acked AND the radio's restored slice found.
    if (this._guiMode === 'self')  return this._guiReady && this._ourSliceIndex != null;
    // Bound: ride the host's slice. If the host never advertised it (no active=1
    // and no in_use=1 — e.g. an AetherSDR build that's stingy with slice status),
    // still allow tuning; the tune/audio paths default to slice 0 rather than
    // refusing every QSY.
    if (this._guiMode === 'bound') return true;
    return false;
  }

  setPersistentId(id) {
    this._persistentId = id || null;
  }

  /** multiFlex: when true (default) POTACAT registers its OWN gui client even
   *  when SmartSDR is open, so it owns transmit (TX works open-or-closed). A
   *  `client gui` rejection falls back to bound. False = ride along (bound). */
  setMultiflex(on) { this._multiflex = !!on; }

  /** Single-GUI-slot handoff: when true, POTACAT YIELDS the GUI slot to a
   *  launching external GUI client (SmartSDR/AetherSDR) — it waits for that
   *  client to register and then binds, instead of re-grabbing the slot itself.
   *  Re-grabbing is exactly what locks SmartSDR out ("In use: POTACAT"). The
   *  caller (main.js handoff) sets this when the radio has multiFlex disabled
   *  and only one GUI client can hold the slot at a time. */
  setYieldToExternal(on) { this._yieldToExternal = !!on; }

  setNeedsCw(needs) {
    this._needsCw = !!needs;
    // If we're already connected and CW just became needed, try to bind
    if (this._needsCw && this.connected && !this._cwBound) {
      this._tryClientBind();
    }
  }

  setNeedsBind(needs) {
    this._needsBind = !!needs;
    if (this._needsBind && this.connected && !this._cwBound) {
      this._tryClientBind();
    }
  }

  connect(host) {
    this.disconnect();
    this._host = host || '127.0.0.1';
    this._connectFailures = 0;
    this._gaveUp = false;
    this._doConnect();
  }

  _doConnect() {
    const sock = new net.Socket();
    sock.setNoDelay(true);
    this._sock = sock;

    sock.on('connect', () => {
      this.connected = true;
      this._connectFailures = 0;
      this._gaveUp = false;
      this._cwBound = false;
      this._discoveredGuiClients = [];
      this._cwKeyIndex = 0;
      this._guiMode = 'none';
      this._guiReady = false;
      this._guiSeq = null;
      this._ourSliceIndex = null;
      this._yieldDeadline = null; // fresh yield window per connect (intent survives)
      this._lastRfPower = null;   // re-emit power on reconnect even if unchanged

      // Subscribe to client updates so we can discover GUI clients for binding
      this._send('sub client all');
      // Subscribe to ATU so atu set commands work
      this._send('sub atu all');
      // Subscribe to slice meters and set up UDP for binary meter data
      this._send('sub meter all');
      // Flex Direct: track slice + panadapter status so we can find the slice
      // the radio restores for us and surface its frequency/mode to the UI.
      this._send('sub slice all');
      this._send('sub pan all');
      // Transmit status — authoritative rfpower readback (phone VFO showed
      // 0W on Flex because this path was write-only: we could SET rfpower
      // but never subscribed to read it; CAT rigs get watts from the PC;
      // poll). The subscribe also delivers one full transmit status
      // immediately, so power is correct within a second of connect.
      this._send('sub tx all');
      this._setupMeterUdp();
      // Re-request meter list after a delay to ensure definitions are parsed
      setTimeout(() => {
        if (this.connected) this._send('meter list');
      }, 1500);

      // If CW keyer or rig controls need binding, bind to an existing GUI
      // client — but NOT in multiFlex mode, where we self-host and CW auth
      // comes from our own gui client. The bind only returns as a fallback if
      // `client gui` is rejected.
      if ((this._needsCw || this._needsBind) && !this._multiflex) {
        setTimeout(() => this._tryClientBind(), 500);
      }
      // Flex Direct: after a grace window for GUI-client discovery, either ride
      // along with an existing SmartSDR/AetherSDR or — if none is open —
      // register POTACAT itself as a GUI client. See _promoteOrBind().
      this._selfHostTimer = setTimeout(() => this._promoteOrBind(), 1600);

      this.emit('connected');
    });

    sock.on('data', (chunk) => {
      this._buf += chunk.toString();
      let nl;
      while ((nl = this._buf.indexOf('\n')) !== -1) {
        const line = this._buf.slice(0, nl).replace(/\r$/, '');
        this._buf = this._buf.slice(nl + 1);
        this._handleLine(line);
      }
    });

    sock.on('error', (err) => {
      this.emit('error', err);
    });

    sock.on('close', () => {
      const wasConnected = this.connected;
      // Were we the active GUI head? disconnect() resets _guiMode/_guiReady
      // BEFORE closing the socket, so this is only true for a RADIO-side close
      // (a kick), never our own teardown.
      const wasGuiHead = this._guiMode === 'self' && this._guiReady;
      this.connected = false;
      this._sock = null;
      this._cwBound = false;
      if (wasConnected) this.emit('disconnected');
      // Kicked off while we were the GUI head: on a single-GUI-slot Flex that
      // means another GUI client (AetherSDR / SmartSDR / Maestro) is taking the
      // slot — AetherSDR does this when you evict POTACAT from its station
      // dialog. Reconnect FAST in yield mode and bind to them instead of
      // re-grabbing the slot (which would fight or lock them out). The yield
      // times out in _promoteOrBind and self-hosts if nobody appears, so a plain
      // network blip still recovers.
      if (wasConnected && wasGuiHead && this._host) {
        this._yieldToExternal = true;
        this._yieldDeadline = null; // fresh window, started in _promoteOrBind
        this._connectFailures = 0;
        console.log('[SmartSDR] Kicked off the radio while GUI head — a client is taking over; reconnecting to bind…');
        this._reconnectTimer = setTimeout(() => {
          this._reconnectTimer = null;
          if (!this.connected && this._host) this._doConnect();
        }, 800);
        return;
      }
      this._scheduleReconnect();
    });

    sock.connect(4992, this._host);
  }

  _tryClientBind() {
    if (this._cwBound) return;
    // Bind to an existing GUI client so CW key/speed/power work correctly
    if (this._discoveredGuiClients.length === 0) {
      console.log('[SmartSDR] No GUI clients discovered to bind to. CW key commands may still work.');
      this.emit('cw-auth', { method: 'unbound', ok: true });
      return;
    }
    const targetId = this._discoveredGuiClients[0];
    console.log(`[SmartSDR] Attempting client bind to GUI client ${targetId}...`);
    this._bindSeq = this._send(`client bind client_id=${targetId}`);
  }

  /** After the GUI-client discovery grace window: if a SmartSDR / AetherSDR
   *  GUI client is present, ride along with it (today's behavior). If none is
   *  open, register POTACAT itself as a GUI client — the radio's band
   *  persistence then restores a slice bound to our handle that we tune over
   *  the native API. This is what lets POTACAT run with no SmartSDR open. */
  _promoteOrBind() {
    this._selfHostTimer = null;
    if (!this.connected || this._guiMode !== 'none') return;
    const haveExternal = this._discoveredGuiClients.length > 0;
    // Ride along (bound) when (a) multiFlex is off and a GUI client is open, or
    // (b) we've been told to YIELD the slot to a launching SmartSDR/AetherSDR.
    if (haveExternal && (!this._multiflex || this._yieldToExternal)) {
      this._yieldDeadline = null;
      this._guiMode = 'bound';
      this.emit('gui-mode', 'bound'); // main.js starts the audio client on this
      return;
    }
    // Yielding, but the external GUI client hasn't registered on the radio yet
    // (it can take several seconds, longer than this grace window). Do NOT grab
    // the slot — that locks SmartSDR out ("In use: POTACAT"). Keep waiting and
    // bind the moment it appears. main.js clears the yield + reconnects to
    // self-host when the 5002 CAT shim drops (SmartSDR actually closed). But
    // TIME OUT: if we were kicked by a plain network blip (not a real handoff),
    // no external GUI will ever appear — fall back to self-hosting so the radio
    // doesn't stay uncontrollable.
    if (this._yieldToExternal && !haveExternal) {
      if (this._yieldDeadline == null) this._yieldDeadline = Date.now() + 10000;
      if (Date.now() >= this._yieldDeadline) {
        console.log('[SmartSDR] Yield timed out — no external GUI registered; self-hosting.');
        this._yieldToExternal = false;
        this._yieldDeadline = null;
        // fall through to self-host below
      } else {
        console.log('[SmartSDR] Yielding the GUI slot — waiting for SmartSDR/AetherSDR to register, then will bind…');
        this._selfHostTimer = setTimeout(() => this._promoteOrBind(), 700);
        return;
      }
    }
    console.log(haveExternal
      ? '[SmartSDR] Registering POTACAT as an independent GUI client (multiFlex — alongside the open SmartSDR/AetherSDR)'
      : '[SmartSDR] No external GUI client found — registering POTACAT as a GUI client (Flex Direct)');
    this._guiMode = 'self';
    this.emit('gui-mode', 'self'); // audio defers until gui-ready (clientId)
    // Reclaim our persistent registration when we have one, so a reconnect
    // re-adopts the same GUI client instead of stacking a fresh ghost (the
    // ghost is exactly what a reconnect used to bind to, going tuneless +
    // silent). First run (no id) lets the radio assign one; we save it.
    this._guiSeq = this._persistentId
      ? this._send(`client gui ${this._persistentId}`)
      : this._send('client gui');
    this._send('client station POTACAT');
  }

  _handleLine(line) {
    // Parse client handle: H<hex>
    const hMatch = line.match(/^H([0-9A-Fa-f]+)/);
    if (hMatch) {
      this._clientHandle = hMatch[1];
      this._ownHandles.add(this._clientHandle.toUpperCase());
      console.log(`[SmartSDR] handle: ${this._clientHandle}`);
      return;
    }

    // Version
    if (line.startsWith('V')) {
      console.log(`[SmartSDR] version: ${line.slice(1)}`);
      return;
    }

    // Parse status messages: S<handle>|<status content>
    if (line.startsWith('S')) {
      this._parseStatusMessage(line);
      this._parseSliceStatus(line);
      this._parsePanStatus(line);
      this._parseTransmitStatus(line);
      return;
    }

    // Parse command responses: R<seq>|<status code>|<message>
    const rMatch = line.match(/^R(\d+)\|([0-9A-Fa-f]+)/);
    if (rMatch) {
      const seq = parseInt(rMatch[1]);
      const status = parseInt(rMatch[2], 16);

      // Check if this is the response to our client bind command
      if (this._bindSeq !== null && seq === this._bindSeq) {
        this._bindSeq = null;
        if (status === 0) {
          console.log('[SmartSDR] client bind succeeded — bound to GUI client for CW');
          this._cwBound = true;
          this.emit('cw-auth', { method: 'bind', ok: true });
        } else {
          console.log(`[SmartSDR] client bind failed (status 0x${status.toString(16)}). CW key commands may still work.`);
          this.emit('cw-auth', { method: 'unbound', ok: true });
        }
        return;
      }

      // Response to our `client gui` registration (Flex Direct). Payload is
      // the radio-assigned client_id: R<seq>|0|<uuid>
      if (this._guiSeq !== null && seq === this._guiSeq) {
        this._guiSeq = null;
        if (status === 0) {
          const id = (line.split('|')[2] || '').trim();
          if (id) this._persistentId = id;
          this._guiReady = true;
          // We ARE the GUI client now — our own handle is the cw key target.
          this._guiClientHandle = this._clientHandle;
          this._cwBound = true;
          console.log(`[SmartSDR] GUI client registered (Flex Direct) — client_id=${this._persistentId}`);
          this.emit('gui-ready', { clientId: this._persistentId });
          this.emit('cw-auth', { method: 'gui', ok: true });
        } else {
          this._guiMode = 'none';
          // Radio rejected our gui client. If SmartSDR/AetherSDR holds the only
          // GUI slot (no multiFlex enabled), fall back to riding along (bound)
          // so RX + CW keep working — only TX-with-SmartSDR-open is lost there.
          if (this._discoveredGuiClients.length > 0) {
            console.log(`[SmartSDR] client gui rejected (status 0x${status.toString(16)}) — no free GUI client; falling back to bound mode`);
            this._guiMode = 'bound';
            this._guiReady = false;
            this.emit('gui-mode', 'bound'); // start the (bound) audio client now
            if (this._needsCw || this._needsBind) this._tryClientBind();
          } else {
            console.log(`[SmartSDR] client gui failed (status 0x${status.toString(16)}) — Flex Direct unavailable`);
          }
        }
        return;
      }

      // Parse meter definitions from 'meter list' response
      if (status === 0 && line.includes('.src=') && line.includes('.nam=')) {
        this._parseStatusMessage(line);
      }

      // Only log errors — suppress successful spot ACKs
      if (status !== 0 && status !== 0x50001000) {
        console.log(`[SmartSDR] cmd error: R${seq}|${status.toString(16)}|${line}`);
        this.emit('cmd-error', { seq, status, line });
      }
    }
  }

  // --- UDP meter binary stream ---
  _setupMeterUdp() {
    if (this._meterSock) return;
    this._meterIds = {}; // id -> { src, num, nam, unit }
    this._smeterMeterId = null;
    this._swrMeterId = null;

    const sock = dgram.createSocket('udp4');
    this._meterSock = sock;

    sock.on('message', (buf) => this._parseUdpPacket(buf));
    sock.on('error', (err) => console.error('[SmartSDR] UDP error:', err.message));

    sock.bind(0, () => {
      const port = sock.address().port;
      console.log(`[SmartSDR] Meter UDP listening on port ${port}`);
      this._send(`client udpport ${port}`);
    });
  }

  _closeMeterUdp() {
    if (this._meterSock) {
      try { this._meterSock.close(); } catch {}
      this._meterSock = null;
    }
  }

  // Dispatcher for VITA-49 packets on this client's UDP port. Audio
  // subscriptions live on a separate non-GUI TCP connection (see
  // lib/smartsdr-audio.js) with its own UDP socket — so on the
  // primary client we only ever expect meter packets here.
  _parseUdpPacket(buf) {
    if (buf.length < 28) return;
    if ((buf[0] & 0xF8) !== 0x38) return;
    const streamId = buf.readUInt32BE(4);
    if (streamId === 0x00000700) {
      this._parseMeterPacket(buf);
    }
    // Ignore unknown streams silently (Flex may emit pan/waterfall etc.).
  }

  _parseMeterPacket(buf) {
    const streamId = buf.readUInt32BE(4);
    if (streamId !== 0x00000700) return;
    // Verify packet class = 0x8002 (meter)
    const packetClass = buf.readUInt16BE(14);
    if (packetClass !== 0x8002) return;

    // Payload starts at byte 28, each meter entry is 4 bytes
    const payloadStart = 28;
    const numMeters = Math.floor((buf.length - payloadStart) / 4);

    for (let i = 0; i < numMeters; i++) {
      const offset = payloadStart + i * 4;
      const meterId = buf.readUInt16BE(offset);
      const rawValue = buf.readInt16BE(offset + 2);

      if (meterId === this._smeterMeterId) {
        // S-meter: dBm, divide by 128
        const dbm = rawValue / 128.0;
        // Convert dBm to 0-255: -120 dBm = 0, S9 (-73) ≈ 109, 0 dBm = 255
        const scaled = Math.max(0, Math.min(255, Math.round((dbm + 120) * 255 / 110)));
        this.emit('smeter', scaled);
      } else if (meterId === this._swrMeterId) {
        // SWR: divide by 128
        const swr = rawValue / 128.0;
        if (swr >= 1.0) {
          this.emit('swr-ratio', swr);
        }
      }
    }
  }

  _parseStatusMessage(line) {
    // Parse meter definitions to find S-meter and SWR meter IDs
    if (line.includes('.src=') && line.includes('.nam=')) {
      const entries = line.split('#').filter(s => s.includes('='));
      const meters = {};
      for (const entry of entries) {
        // No ^ anchor — first entry may have S0|meter or R5|0| prefix
        const m = entry.match(/(\d+)\.(\w+)=(.*)$/);
        if (m) {
          const id = m[1];
          if (!meters[id]) meters[id] = {};
          meters[id][m[2]] = m[3];
        }
      }
      for (const [id, m] of Object.entries(meters)) {
        const numId = parseInt(id, 10);
        if (m.src && m.nam) {
          this._meterIds[numId] = m;
          // Find S-meter: src=SLC, nam=LEVEL, num=0 (slice A)
          if (m.src === 'SLC' && m.nam === 'LEVEL' && (m.num === '0' || !this._smeterMeterId)) {
            this._smeterMeterId = numId;
            console.log(`[SmartSDR] S-meter: meter id ${numId} (${m.desc || 'LEVEL'})`);
          }
          // Find SWR: src=TX-, nam=SWR (or src starts with TX)
          if (m.nam === 'SWR' && !this._swrMeterId) {
            this._swrMeterId = numId;
            console.log(`[SmartSDR] SWR meter: meter id ${numId} (src=${m.src})`);
          }
        } else if (m.nam) {
          // Meter has nam but no src — log for diagnostics
          console.log(`[SmartSDR] meter ${numId}: nam=${m.nam} src=${m.src || '?'} num=${m.num || '?'}`);
        }
      }
    }

    // Status messages look like:
    // S<handle>|client 0x4E1DDC50 connected local_ptt=1 client_id=FC77859A-... program=SmartSDR-Win station=...
    // We need both the client_id UUID (for client bind) and the hex handle (for cw key client_handle=)
    const idMatch = line.match(/client_id=([0-9A-Fa-f-]+)/);
    const handleMatch = line.match(/\|client\s+0x([0-9A-Fa-f]+)/);
    if (idMatch) {
      const clientId = idMatch[1];
      // Skip our OWN client record so we never "ride along with" ourselves.
      // A POTACAT must never bind to a POTACAT GUI client — that's either our
      // own stale registration after a reconnect (the ghost that left us tuneless
      // with silent audio) or a second instance; binding to it is always wrong.
      // We recognize ourselves four ways, because on reconnect the ghost reports
      // a different handle (our OLD one) and often client_id=0, so the UUID/
      // current-handle checks alone miss it:
      //   1. client_id == our persistent id   2. program/station == POTACAT
      //   3. handle is one WE'VE used this session   4. handle == current handle
      const prog = (line.match(/program=(\S+)/) || [])[1];
      const stn = (line.match(/station=(\S+)/) || [])[1];
      const isPotacat = (prog && prog.toUpperCase() === 'POTACAT') ||
                        (stn && stn.toUpperCase() === 'POTACAT');
      const handleHex = handleMatch ? handleMatch[1].toUpperCase() : null;
      const isOurHandle = handleHex && (this._ownHandles.has(handleHex) ||
        (this._clientHandle && handleHex === this._clientHandle.toUpperCase()));
      // A real bindable GUI client always has a UUID. client_id=0 (or empty) is
      // a zombie — the radio's placeholder for a GUI registration that's being
      // torn down, almost always OUR OWN just-released slot after a handoff
      // reconnect (new instance → no _ownHandles memory → the UUID/handle checks
      // miss it). Binding to it routes audio to a corpse; treat it as self/skip.
      const isZombie = !clientId || clientId === '0' || clientId === '0x0';
      const isSelf = isZombie || (clientId === this._persistentId) || isPotacat || isOurHandle;
      if (isSelf && handleHex) this._ownHandles.add(handleHex); // remember the ghost's handle too
      if (!isSelf && !this._discoveredGuiClients.includes(clientId)) {
        this._discoveredGuiClients.push(clientId);
        // Capture the hex handle for cw key client_handle= parameter
        if (handleMatch && !this._guiClientHandle) {
          this._guiClientHandle = handleMatch[1];
          console.log(`[SmartSDR] Discovered GUI client: id=${clientId} handle=0x${this._guiClientHandle}`);
        } else {
          console.log(`[SmartSDR] Discovered GUI client_id: ${clientId} (total: ${this._discoveredGuiClients.length})`);
        }
      }
    }

    // Host GUI client left. When the client we're BOUND to disconnects, the
    // radio sends `S<h>|client 0x<HANDLE> disconnected` (or connected=0) and its
    // slice vanishes — every tune then errors "Invalid slice receiver". For
    // SmartSDR-Win the 5002 shim drop signals this; AetherSDR has no shim, so we
    // detect it here and reclaim. Only fires in bound mode for OUR host's handle.
    if (this._guiMode === 'bound' && handleMatch && this._guiClientHandle) {
      const h = handleMatch[1].toUpperCase();
      const rest = (line.split(/\|client\s+0x[0-9A-Fa-f]+/)[1] || '');
      const left = /(?:^|\s)disconnected(?:\s|$)/.test(rest) || /connected=0\b/.test(rest);
      if (left && h === this._guiClientHandle.toUpperCase()) {
        console.log(`[SmartSDR] Bound host GUI client (0x${h}) disconnected — reclaiming the radio.`);
        this.emit('gui-client-left', { handle: h });
      }
    }
  }

  /** Flex Direct: identify the slice the radio bound to our client handle
   *  after `client gui`, and surface its frequency/mode so the renderer
   *  status bar works without the SmartSDR-Win CAT shim (port 5002). */
  /**
   * Transmit status: S<handle>|transmit rfpower=NN tune_power=NN
   * mic_level=NN compander_on=0 vox_enable=0 mon=0 ...
   * Lines are deltas — any transmit-field change resends the block — so
   * 'power' is deduped on value while the full parsed map goes out on
   * every line as 'transmit-status' (authoritative readback for toggles
   * the phone tracks optimistically; see desktop-ask flex-txpower-readback).
   * rfpower is 0-100, which on the 6000/8000 series is watts.
   */
  _parseTransmitStatus(line) {
    const m = line.match(/\|transmit (.+)$/);
    if (!m) return;
    const kv = {};
    for (const part of m[1].split(' ')) {
      const eq = part.indexOf('=');
      if (eq > 0) kv[part.slice(0, eq)] = part.slice(eq + 1);
    }
    this.emit('transmit-status', kv);
    if (kv.rfpower != null) {
      const watts = parseInt(kv.rfpower, 10);
      if (Number.isFinite(watts) && watts !== this._lastRfPower) {
        this._lastRfPower = watts;
        this.emit('power', watts);
      }
    }
  }

  _parseSliceStatus(line) {
    const m = line.match(/\|slice (\d+) (.+)$/);
    if (!m) return;
    const idx = parseInt(m[1], 10);
    const body = m[2];
    const get = (k) => {
      const mm = body.match(new RegExp('(?:^| )' + k + '=([^ ]+)'));
      return mm ? mm[1] : null;
    };
    // Our slice = the one the radio tagged with our own client handle.
    if (this._guiMode === 'self' && this._clientHandle) {
      const handle = get('client_handle');
      if (handle && handle.replace(/^0x/i, '').toUpperCase() === this._clientHandle.toUpperCase()) {
        if (this._ourSliceIndex !== idx) {
          this._ourSliceIndex = idx;
          console.log(`[SmartSDR] Flex Direct: tuning slice ${idx} (index ${get('index_letter') || '?'})`);
          this.emit('slice-ready', { index: idx });
        }
      }
    }
    // Bound mode: follow the host GUI client's active slice. SmartSDR-Win and
    // AetherSDR flag exactly one slice per panadapter as active=1 — that's
    // the slice the operator is tuning. Mirror it so tuneRadio / frequency
    // events have a target. The 'self' branch above already handles its own
    // slice via client_handle; this only matters when we're bound to an
    // external GUI client. Casey + 8600 + AetherSDR 2026-05-23: without this,
    // _ourSliceIndex stayed null in bound mode and tunes had nowhere to go.
    if (this._guiMode === 'bound') {
      const active = get('active');
      const inUse = get('in_use');
      if (active === '1' && this._ourSliceIndex !== idx) {
        // Strongest signal: the host flags exactly one slice active. Always honor.
        this._ourSliceIndex = idx;
        console.log(`[SmartSDR] Bound mode: following active slice ${idx} (index ${get('index_letter') || '?'})`);
        this.emit('slice-ready', { index: idx });
      } else if (this._ourSliceIndex == null && inUse === '1') {
        // Fallback: some GUI clients don't advertise active=1 (AetherSDR 26.6.3 —
        // K3SBP 2026-06-26: _ourSliceIndex stayed null → canTune false → every
        // tune "ignored"). Adopt the first in-use slice so we have a tune target;
        // a later active=1 line upgrades the choice.
        this._ourSliceIndex = idx;
        console.log(`[SmartSDR] Bound mode: following in-use slice ${idx} (host sent no active flag)`);
        this.emit('slice-ready', { index: idx });
      }
    }
    // Surface freq/mode for our slice (handles full and partial status lines).
    if (idx === this._ourSliceIndex) {
      const f = get('RF_frequency');
      if (f) {
        const hz = Math.round(parseFloat(f) * 1e6);
        if (hz && hz !== this._lastSliceFreq) {
          this._lastSliceFreq = hz;
          this.emit('frequency', hz);
        }
      }
      const md = get('mode');
      if (md && md !== this._lastSliceMode) {
        this._lastSliceMode = md;
        this.emit('mode', md);
      }
    }
    // DAX channel the slice is routed to — emit for ANY slice (not just our
    // followed one) so main.js can watch the user-configured Flex slice. If a
    // slice isn't on the channel POTACAT's dax_rx listens on, audio packets
    // arrive but are silent (the "Slice A not on DAX 1 → feedAudio all zeros"
    // trap, which has no error). Tracked per-slice for change detection.
    const dax = get('dax');
    if (dax != null) {
      const ch = parseInt(dax, 10);
      if (!Number.isNaN(ch) && this._sliceDax[idx] !== ch) {
        this._sliceDax[idx] = ch;
        this.emit('slice-dax', { index: idx, channel: ch });
      }
    }
    // Panadapter the slice rides on — the WNB commands and pan-status
    // readback below key off this id.
    const pan = get('pan');
    if (pan && /^0x[0-9A-Fa-f]+$/.test(pan)) this._slicePan[idx] = pan;
  }

  /** Pan id of the slice we're following (tune target), falling back to the
   *  first pan any slice reported. Null until slice status has arrived. */
  get ourPanId() {
    if (this._ourSliceIndex != null && this._slicePan[this._ourSliceIndex]) {
      return this._slicePan[this._ourSliceIndex];
    }
    const first = Object.values(this._slicePan)[0];
    return first || null;
  }

  /** Pan status carries the WNB (wideband noise blanker) state — a PAN
   *  property, unlike the slice DSP fields. Emitting the readback keeps the
   *  UI in sync even when the op toggles WNB in SmartSDR/AetherSDR (the
   *  slice DSP toggles don't have this yet; WNB gets it for free because we
   *  had to parse pan status for the id anyway). Partial lines are normal —
   *  only the keys present are forwarded. */
  _parsePanStatus(line) {
    const m = line.match(/\|display pan (0x[0-9A-Fa-f]+) (.+)$/);
    if (!m) return;
    const panId = m[1];
    const body = m[2];
    const get = (k) => {
      const mm = body.match(new RegExp('(?:^| )' + k + '=([^ ]+)'));
      return mm ? mm[1] : null;
    };
    const out = { panId };
    const wnb = get('wnb');
    if (wnb != null) out.wnb = wnb === '1';
    const wnbLevel = get('wnb_level');
    if (wnbLevel != null) {
      const v = parseInt(wnbLevel, 10);
      if (!Number.isNaN(v)) out.wnbLevel = Math.max(0, Math.min(100, v));
    }
    if (out.wnb !== undefined || out.wnbLevel !== undefined) {
      this.emit('pan-status', out);
    }
  }

  /** DAX channel a slice is currently routed to (0 = DAX off, undefined = not
   *  yet seen). main.js compares the configured slice's channel to the one the
   *  audio client subscribes to. */
  sliceDaxChannel(idx) { return this._sliceDax[idx]; }

  /** DAX RX channels currently used by slices OTHER than `exceptIdx`. In
   *  multiFlex POTACAT can't share a DAX channel with SmartSDR's slice, so the
   *  caller picks a free one for its own slice. */
  usedDaxChannels(exceptIdx) {
    const used = new Set();
    for (const k of Object.keys(this._sliceDax)) {
      const ch = this._sliceDax[k];
      if (Number(k) !== exceptIdx && ch > 0) used.add(ch);
    }
    return used;
  }

  _scheduleReconnect() {
    if (this._reconnectTimer || this._probeTimer) return;
    // Already gave up (banner shown once) — this is a failed background
    // probe. Stay quiet and keep probing; connect success resets the state.
    if (this._gaveUp) { this._scheduleProbe(); return; }
    this._connectFailures = (this._connectFailures || 0) + 1;

    // After 3 consecutive failures, stop the fast retry loop and surface the
    // problem ONCE instead of hammering the log every 5 seconds. The caller
    // can start a fresh cycle by invoking connect(host) again — Rig settings
    // save, or the phone's rig-reconnect command. We do NOT stay dead,
    // though: a slow background probe keeps sniffing for the radio so a
    // power-cycled Flex (storm shutdown, K3SBP 2026-07-06) reconnects by
    // itself within a probe interval of coming back on the network.
    if (this._connectFailures >= 3) {
      this._gaveUp = true;
      this.emit('give-up', { host: this._host, attempts: this._connectFailures });
      this._scheduleProbe();
      return;
    }

    // Light backoff: 5 s, 10 s, 20 s (we give up before hitting longer waits)
    const delays = [5000, 10000, 20000];
    const delay = delays[Math.min(this._connectFailures - 1, delays.length - 1)];
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (!this.connected && this._host) {
        this._doConnect();
      }
    }, delay);
  }

  // Low-cadence post-give-up retry. One TCP dial a minute against a radio
  // that's off costs nothing and means recovery needs no human when it
  // comes back. Cleared by disconnect(); made moot by a successful connect
  // (which resets _gaveUp/_connectFailures).
  _scheduleProbe() {
    if (this._probeTimer) return;
    this._probeTimer = setTimeout(() => {
      this._probeTimer = null;
      if (!this.connected && this._host) this._doConnect();
    }, this._probeIntervalMs);
  }

  _send(cmd) {
    if (!this._sock || !this.connected) return null;
    const seq = this._seq++;
    this._sock.write(`C${seq}|${cmd}\n`);
    return seq;
  }

  addSpot(spot) {
    const freqMHz = typeof spot.freqMHz === 'number' ? spot.freqMHz : parseFloat(spot.freqMHz);
    if (!freqMHz || isNaN(freqMHz)) return;
    const callsign = (spot.callsign || '').replace(/\s/g, '');
    if (!callsign) return;
    const mode = spot.mode || '';
    const color = SOURCE_COLORS[spot.source] || SOURCE_COLORS.pota;
    const lifetime = SOURCE_LIFETIMES[spot.source] || 600;
    const comment = (spot.reference || spot.parkName || '').slice(0, 40).replace(/\s/g, '_');

    // If this callsign was previously at a different frequency, remove the old spot first
    const prevFreq = this._spotFreqs.get(callsign);
    if (prevFreq !== undefined && Math.abs(prevFreq - freqMHz) > 0.0005) {
      this._send(`spot remove callsign=${callsign} source=POTACAT`);
    }

    this._send(
      `spot add rx_freq=${freqMHz.toFixed(6)} callsign=${callsign} mode=${mode} color=${color} source=POTACAT trigger_action=tune lifetime_seconds=${lifetime}` +
      (comment ? ` comment=${comment}` : '')
    );
    this._activeSpots.add(callsign);
    this._spotFreqs.set(callsign, freqMHz);
  }

  /**
   * Remove spots that are no longer in the current spot list.
   * Call after adding all current spots to clean up stale ones.
   */
  pruneStaleSpots() {
    for (const call of this._previousSpots) {
      if (!this._activeSpots.has(call)) {
        this._send(`spot remove callsign=${call} source=POTACAT`);
        this._spotFreqs.delete(call);
      }
    }
    this._previousSpots = new Set(this._activeSpots);
    this._activeSpots.clear();
  }

  clearSpots() {
    this._send('spot clear');
    this._activeSpots.clear();
    this._previousSpots.clear();
    this._spotFreqs.clear();
  }

  /**
   * Tune a slice to a frequency and optionally set mode and filter.
   * @param {number} sliceIndex - 0=A, 1=B, 2=C, 3=D
   * @param {number} freqMhz - Frequency in MHz (e.g. 7.074000)
   * @param {string} [mode] - FlexRadio mode string (e.g. 'DIGU', 'USB', 'CW')
   * @param {number} [filterWidth] - Filter passband width in Hz (0 = radio default)
   */
  tuneSlice(sliceIndex, freqMhz, mode, filterWidth) {
    this._send(`slice tune ${sliceIndex} ${freqMhz.toFixed(6)}`);
    if (mode) {
      this._send(`slice set ${sliceIndex} mode=${mode}`);
    }
    if (filterWidth > 0 && mode) {
      const m = (mode || '').toUpperCase();
      let lo, hi;
      if (m === 'CW') {
        lo = Math.max(0, 600 - Math.round(filterWidth / 2));
        hi = 600 + Math.round(filterWidth / 2);
      } else {
        lo = 100;
        hi = 100 + filterWidth;
      }
      this._send(`slice set ${sliceIndex} filter_lo=${lo} filter_hi=${hi}`);
    }
  }

  // --- CW keying methods ---
  // Direct key-down/key-up via `cw key 0|1` with timestamps and client_handle.
  // The radio uses timestamps to measure network jitter and buffer appropriately,
  // reproducing the operator's exact fist timing on air.
  // Format: cw key <0|1> time=0x<NNNN> index=<N> client_handle=0x<HANDLE>

  /**
   * Direct CW key command — preserves operator's exact fist timing.
   * Timestamps let the radio compensate for network jitter.
   * @param {boolean} down - true for key down, false for key up
   */
  cwKey(down) {
    const ts = Date.now() & 0xFFFF;
    const tsHex = ts.toString(16).toUpperCase().padStart(4, '0');
    const idx = this._cwKeyIndex++;
    let cmd = `cw key ${down ? 1 : 0} time=0x${tsHex} index=${idx}`;
    if (this._guiClientHandle) {
      cmd += ` client_handle=0x${this._guiClientHandle}`;
    }
    this._send(cmd);
  }

  /**
   * CW PTT — activate/deactivate transmit for CW keying.
   * Uses `cw ptt` (not `xmit`) which works with the CW keying system.
   * Auto-releases after holdoff period of no key activity.
   */
  cwPttOn() {
    if (!this._cwPttActive) {
      const ts = Date.now() & 0xFFFF;
      const tsHex = ts.toString(16).toUpperCase().padStart(4, '0');
      const idx = this._cwKeyIndex++;
      let cmd = `cw ptt 1 time=0x${tsHex} index=${idx}`;
      if (this._guiClientHandle) {
        cmd += ` client_handle=0x${this._guiClientHandle}`;
      }
      console.log(`[SmartSDR] CW PTT on`);
      this._send(cmd);
      this._cwPttActive = true;
    }
    // Reset holdoff timer on every call
    if (this._cwPttTimer) clearTimeout(this._cwPttTimer);
    this._cwPttTimer = setTimeout(() => this.cwPttRelease(), this._cwPttHoldoff);
  }

  cwPttRelease() {
    if (this._cwPttTimer) { clearTimeout(this._cwPttTimer); this._cwPttTimer = null; }
    if (this._cwPttActive) {
      const ts = Date.now() & 0xFFFF;
      const tsHex = ts.toString(16).toUpperCase().padStart(4, '0');
      const idx = this._cwKeyIndex++;
      let cmd = `cw ptt 0 time=0x${tsHex} index=${idx}`;
      if (this._guiClientHandle) {
        cmd += ` client_handle=0x${this._guiClientHandle}`;
      }
      console.log(`[SmartSDR] CW PTT off`);
      this._send(cmd);
      this._cwPttActive = false;
    }
  }

  /**
   * Voice PTT — activate/deactivate transmit for SSB/AM/FM (not CW).
   * Uses `xmit` which is the proper voice transmit command.
   */
  setTransmit(state) {
    if (!this.connected) return;
    this._send(`xmit ${state ? 1 : 0}`);
    console.log(`[SmartSDR] Voice PTT ${state ? 'on' : 'off'}`);
  }

  setSliceFilter(idx, lo, hi) {
    // The passband is set with the dedicated `filt <slice> <lo> <hi>` command.
    // `slice set ... filter_lo=` is NOT a valid slice field — the radio rejects
    // it ("Bad field 'filter_lo='"), so filter changes silently did nothing.
    this._send(`filt ${idx} ${Math.round(lo)} ${Math.round(hi)}`);
  }

  setSliceNb(idx, on) {
    this._send(`slice set ${idx} nb=${on ? 1 : 0}`);
  }

  /** Bind a slice to a DAX channel so RX/TX audio routes to the dedicated
   *  audio connection (lib/smartsdr-audio.js). In Flex Direct POTACAT owns
   *  the slice, so it must set this itself — SmartSDR isn't there to do it. */
  setSliceDax(idx, channel) {
    this._send(`slice set ${idx} dax=${channel}`);
  }

  /** Mute / unmute the slice's monitor audio — the mix that feeds the
   *  radio's onboard outputs (front-panel speaker, headphone, lineout) and
   *  the GUI client's remote-audio stream. This is the SmartSDR "MUT" button:
   *  it is INDEPENDENT of the DAX tap, so POTACAT's RX audio for JTCAT/SSTV
   *  (slice dax=N) keeps flowing while the radio's own speaker goes silent.
   *
   *  Why this matters: in Flex Direct (`client gui`) POTACAT becomes the
   *  radio's GUI head, so an 8000-series (8400/8600) routes the active
   *  slice to its built-in speaker — the operator hears the band even
   *  though they only wanted POTACAT to hunt. Both Casey (8600M) and W2ECK
   *  (8600) reported the speaker waking up after the Flex Direct upgrade.
   *  Per-output `mixer headphone/lineout mute` was accepted but did NOT
   *  silence the front-panel speaker (see scripts/probe-flex-audio.js); the
   *  per-slice audio_mute sits upstream of all three outputs. */
  /** Set the slice's monitor AF level (0–100, SmartSDR field `audio_level`) —
   *  the level of the radio's onboard speaker / headphone / lineout. The DAX RX
   *  tap is full-scale and independent of this, so audio_level=0 should silence
   *  the PHYSICAL speaker while DAX RX (POTACAT's PC monitor + JTCAT/SSTV
   *  decoders) keeps full audio. We use this instead of audio_mute in solo Flex
   *  Direct because on 4.2.x audio_mute=1 ALSO kills the DAX feed (K3SBP
   *  2026-06-26: muting the slice silenced the PC monitor too), but the operator
   *  still wants the band on the computer without the radio's own speaker
   *  blaring (no front-panel volume on the 8600 to turn it down).
   *  NOTE: the field is `audio_level`, NOT `audio_gain` — the radio rejects
   *  audio_gain as "Bad field" on the 1.4.0.0 API. */
  setSliceAudioLevel(idx, level) {
    const n = Math.max(0, Math.min(100, parseInt(level, 10) || 0));
    this._send(`slice set ${idx} audio_level=${n}`);
  }

  setOnboardAudioMute(idx, mute) {
    this._send(`slice set ${idx} audio_mute=${mute ? 1 : 0}`);
  }

  setActiveSlice(idx) {
    this._send(`slice set ${idx} active=1`);
  }

  setTxSlice(idx) {
    this._send(`slice set ${idx} tx=1`);
  }

  // Per-slice antenna selection. SmartSDR fields are `rxant` and `txant`;
  // values are radio-defined strings like ANT1 / ANT2 / XVTR_A / XVTR_B.
  // Either argument may be null/empty to skip that direction — useful
  // when the user only wants to set TX (or only RX) for a band. Sends
  // separate commands so the radio applies them atomically per leg
  // (a combined `rxant=X txant=Y` is also valid but harder to log when
  // diagnosing per-direction issues).
  setSliceAntenna(idx, antRx, antTx) {
    if (antRx) this._send(`slice set ${idx} rxant=${antRx}`);
    if (antTx) this._send(`slice set ${idx} txant=${antTx}`);
  }

  setSliceXit(idx, on, freqHz) {
    if (on && freqHz != null) {
      this._send(`slice set ${idx} xit_on=1 xit_freq=${Math.round(freqHz)}`);
    } else {
      this._send(`slice set ${idx} xit_on=0`);
    }
  }

  setAtu(on) {
    this._send(on ? 'atu start' : 'atu bypass');
  }

  setRfGain(idx, dB) {
    this._send(`slice set ${idx} rfgain=${Math.round(dB)}`);
  }

  setTxPower(pct) {
    this._send(`transmit set rfpower=${Math.round(pct)}`);
  }

  // --- Extended slice + transmit modifiers (Phase 1 rig-popover expansion) ---
  // The Flex 6000 / 8000 series exposes far more receiver and transmit
  // settings than the original ATU+NB+RFGain+TxPower+Filter popover covers.
  // SmartSDR API surface for these is well-documented in the FlexLib SDK;
  // we expose the ones POTACAT users actually toggle during ops. K3SBP
  // 2026-05-25 review (Flex 8600M).

  setCompressor(idx, on) {
    // `transmit set` is global — slice index is ignored. Kept in the
    // signature so the call sites match the rest of the slice modifiers.
    this._send(`transmit set compander_on=${on ? 1 : 0}`);
  }

  setNoiseReduction(idx, on) {
    this._send(`slice set ${idx} nr=${on ? 1 : 0}`);
  }

  setAutoNotch(idx, on) {
    this._send(`slice set ${idx} anf=${on ? 1 : 0}`);
  }

  // Audio Peak Filter — the CW receive peaking filter. `apf` is a slice field
  // parallel to `anf`/`nr` (apf_level / apf_tune set strength + peak offset).
  setApf(idx, on) {
    this._send(`slice set ${idx} apf=${on ? 1 : 0}`);
  }

  setVox(on) {
    this._send(`transmit set vox_enable=${on ? 1 : 0}`);
  }

  /**
   * @param {number} idx — slice index
   * @param {string} mode — 'off'|'fast'|'med'|'slow'
   */
  setAgc(idx, mode) {
    const valid = ['off', 'fast', 'med', 'slow'];
    const m = valid.includes(mode) ? mode : 'med';
    this._send(`slice set ${idx} agc_mode=${m}`);
  }

  // --- Phase 2 level + monitor controls ---
  // The Phase-1 toggles flipped the feature on/off; Phase 2 adds the
  // continuous level for the ones where 0–100% makes the difference
  // between "useless" and "actually cleaning up the signal", plus the
  // self-monitor for ops who want to hear their own audio path.

  setNrLevel(idx, pct) {
    const v = Math.max(0, Math.min(100, Math.round(pct)));
    this._send(`slice set ${idx} nr_level=${v}`);
  }

  // --- Extended firmware DSP (8000-series / Aurora only) ---
  // BigBend/DragonFire firmware adds four more slice NR engines beyond nr/anf:
  // lms_nr (NRL, LMS adaptive), speex_nr (NRS, spectral subtraction), rnnoise
  // (RNN, neural — toggle-only, no level) and nrf. Slice params confirmed
  // against AetherSDR's SliceModel; a 6000 ignores them (caps-gated upstream
  // anyway). Levels follow the nr_level 0–100 pattern. Note the firmware
  // quirk: profile recall does not persist speex_nr_level (reports 50).

  // WNB — wideband noise blanker, all 6000/8000 models. A PANADAPTER
  // property (`display pan set`), not a slice one; targets the pan our
  // followed slice rides on. No-op (with log) until slice status has
  // revealed a pan id.
  setWnb(on) {
    const pan = this.ourPanId;
    if (!pan) { console.log('[SmartSDR] WNB: no panadapter id known yet — ignored'); return; }
    this._send(`display pan set ${pan} wnb=${on ? 1 : 0}`);
  }

  setWnbLevel(pct) {
    const pan = this.ourPanId;
    if (!pan) { console.log('[SmartSDR] WNB level: no panadapter id known yet — ignored'); return; }
    const v = Math.max(0, Math.min(100, Math.round(pct)));
    this._send(`display pan set ${pan} wnb_level=${v}`);
  }

  setNrl(idx, on) {
    this._send(`slice set ${idx} lms_nr=${on ? 1 : 0}`);
  }

  setNrlLevel(idx, pct) {
    const v = Math.max(0, Math.min(100, Math.round(pct)));
    this._send(`slice set ${idx} lms_nr_level=${v}`);
  }

  setNrs(idx, on) {
    this._send(`slice set ${idx} speex_nr=${on ? 1 : 0}`);
  }

  setNrsLevel(idx, pct) {
    const v = Math.max(0, Math.min(100, Math.round(pct)));
    this._send(`slice set ${idx} speex_nr_level=${v}`);
  }

  setRnn(idx, on) {
    this._send(`slice set ${idx} rnnoise=${on ? 1 : 0}`);
  }

  setNrf(idx, on) {
    this._send(`slice set ${idx} nrf=${on ? 1 : 0}`);
  }

  setNrfLevel(idx, pct) {
    const v = Math.max(0, Math.min(100, Math.round(pct)));
    this._send(`slice set ${idx} nrf_level=${v}`);
  }

  setNbLevel(idx, pct) {
    const v = Math.max(0, Math.min(100, Math.round(pct)));
    this._send(`slice set ${idx} nb_level=${v}`);
  }

  setVoxLevel(pct) {
    const v = Math.max(0, Math.min(100, Math.round(pct)));
    this._send(`transmit set vox_level=${v}`);
  }

  setMonitor(on) {
    this._send(`transmit set mon=${on ? 1 : 0}`);
  }

  setMonLevel(pct) {
    const v = Math.max(0, Math.min(100, Math.round(pct)));
    this._send(`transmit set mon_gain=${v}`);
  }

  setRit(idx, on) {
    this._send(`slice set ${idx} rit_on=${on ? 1 : 0}`);
  }

  /**
   * Toggle the radio's local CW sidetone playback. The Flex normally
   * plays a tone out of whichever audio path the slice is routed to
   * (built-in speaker / headphones / DAX) whenever the radio is keyed,
   * including external keying via WinKeyer or rear-panel KEY jack. For
   * operators who have the radio in the same room and key from a
   * separate device (WinKeyer with its own sidetone), this doubles up
   * audibly and makes keying painful. Disabling sidetone stops the
   * monitor playback without affecting actual RF TX.
   */
  setCwSidetone(on) {
    // Send the SET command. The Flex API also accepts properties via
    // `cw sidetone <0|1>` (space-delimited like `cw wpm 25` / `cw key 0`),
    // and a handful of forum threads suggest some firmware versions only
    // honor one form or the other. Send BOTH so whichever the radio's
    // CW subsystem actually accepts will fire. The other is dropped
    // silently (the FlexLib parser ignores unknown commands).
    const v = on ? 1 : 0;
    this._send(`cw sidetone=${v}`);
    this._send(`cw sidetone ${v}`);
  }

  setCwSpeed(wpm) {
    this._send(`cw wpm ${wpm}`);
  }

  cwStop() {
    this.cwKey(false);
    this.cwPttRelease();
  }

  /**
   * Send CW text via SmartSDR `cwx send` command.
   * The radio's internal text-keyer plays the message at the current CW speed.
   * fc578e1 shipped this as `cw send "..."` which isn't a recognized SmartSDR
   * command — the radio silently dropped it, so phone macros + desktop macros
   * via the Flex path produced "[SmartSDR] CW send: ..." in the log but no
   * actual RF. K3SBP 2026-05-13 caught it the same evening as the WinKeyer-
   * priority issue. Historical comment at the cwx call site noted the
   * encoding rule: a space byte gets sent as 0x7F (ASCII DEL).
   * @param {string} text - CW text to send (uppercase, spaces between words)
   */
  sendCwText(text) {
    if (!this.connected || !text) return;
    const cleaned = text.replace(/"/g, '').toUpperCase();
    const escaped = cleaned.replace(/ /g, '\x7F');
    this._send(`cwx send "${escaped}"`);
    console.log(`[SmartSDR] CW send: ${cleaned}`);
  }

  /**
   * Set CW keyer speed via SmartSDR.
   * @param {number} wpm - words per minute
   */
  setCwSpeed(wpm) {
    if (!this.connected) return;
    this._send(`cw wpm ${Math.max(5, Math.min(100, wpm || 20))}`);
  }

  /** Return the SmartSDR command table for the Rig Commands tab UI */
  getCommandTable() {
    return [
      { key: 'tuneSlice', label: 'Tune Slice', value: 'slice tune {slice} {freqMHz}' },
      { key: 'setMode', label: 'Set Mode', value: 'slice set {slice} mode={mode}' },
      { key: 'setFilter', label: 'Set Filter', value: 'slice set {slice} filter_lo={lo} filter_hi={hi}' },
      { key: 'setNbOn', label: 'NB On', value: 'slice set {slice} nb=1' },
      { key: 'setNbOff', label: 'NB Off', value: 'slice set {slice} nb=0' },
      { key: 'setRfGain', label: 'RF Gain', value: 'slice set {slice} rfgain={dB}' },
      { key: 'setPower', label: 'TX Power', value: 'transmit set rfpower={pct}' },
      { key: 'atuStart', label: 'ATU Start', value: 'atu start' },
      { key: 'atuBypass', label: 'ATU Bypass', value: 'atu bypass' },
      { key: 'setTransmitOn', label: 'PTT On', value: 'xmit 1' },
      { key: 'setTransmitOff', label: 'PTT Off', value: 'xmit 0' },
      { key: 'setActiveSlice', label: 'Active Slice', value: 'slice set {slice} active=1' },
      { key: 'setTxSlice', label: 'TX Slice', value: 'slice set {slice} tx=1' },
      { key: 'setXitOn', label: 'XIT On', value: 'slice set {slice} xit_on=1 xit_freq={hz}' },
      { key: 'setXitOff', label: 'XIT Off', value: 'slice set {slice} xit_on=0' },
      { key: 'cwSend', label: 'CW Text', value: 'cwx send "{text}"' },
      { key: 'cwSpeed', label: 'CW Speed', value: 'cw wpm {wpm}' },
      { key: 'spotAdd', label: 'Add Spot', value: 'spot add rx_freq={MHz} callsign={call} ...' },
      { key: 'spotClear', label: 'Clear Spots', value: 'spot clear' },
    ];
  }

  disconnect() {
    this.cwPttRelease();
    this._closeMeterUdp();
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._probeTimer) {
      clearTimeout(this._probeTimer);
      this._probeTimer = null;
    }
    if (this._selfHostTimer) {
      clearTimeout(this._selfHostTimer);
      this._selfHostTimer = null;
    }
    this._guiMode = 'none';
    this._guiReady = false;
    this._ourSliceIndex = null;
    this._host = null;
    if (this._sock) {
      try {
        this._sock.end();
        const sock = this._sock;
        setTimeout(() => { try { sock.destroy(); } catch {} }, 500);
      } catch { /* ignore */ }
      this._sock = null;
    }
    this.connected = false;
    this._cwBound = false;
  }

  // Slice audio subscription lives on a separate non-GUI TCP
  // connection — see lib/smartsdr-audio.js. The primary connection
  // here is `client bind`-ed to an existing GUI client so CW + spot
  // markers work, and the Flex rejects audio subscribe commands
  // (modern AND legacy syntax) on a GUI-bound TCP with 0x500000aa.
}

function setColorblindMode(enabled) {
  Object.assign(SOURCE_COLORS, enabled ? SOURCE_COLORS_CB : SOURCE_COLORS_NORMAL);
}

module.exports = { SmartSdrClient, setColorblindMode };
