(() => {
  'use strict';

  // Catppuccin Mocha — exact values matching the team's kitty config (see README).
  const THEME = {
    background: '#1e1e2e',
    foreground: '#cdd6f4',
    cursor: '#f5e0dc',
    cursorAccent: '#1e1e2e',
    selectionForeground: '#1e1e2e',
    selectionBackground: '#f5e0dc',
    black: '#45475a',
    red: '#f38ba8',
    green: '#a6e3a1',
    yellow: '#f9e2af',
    blue: '#89b4fa',
    magenta: '#f5c2e7',
    cyan: '#94e2d5',
    white: '#bac2de',
    brightBlack: '#585b70',
    brightRed: '#f38ba8',
    brightGreen: '#a6e3a1',
    brightYellow: '#f9e2af',
    brightBlue: '#89b4fa',
    brightMagenta: '#f5c2e7',
    brightCyan: '#94e2d5',
    brightWhite: '#a6adc8',
  };

  const BACKOFF_MS = [500, 1000, 2000, 5000, 10000];
  const PROBE_FONT_PX = 16; // matches #probe font-size in styles.css
  const COL_STEP = 10;
  const ROW_STEP = 3;
  const KEY_SEQS = { 'esc': '\x1b', 'ctrl-c': '\x03', 'ctrl-d': '\x04', 'ctrl-z': '\x1a' };
  // US-layout [unshifted, shifted] chars per ev.code, for Alt-as-Escape (M-= etc.)
  const ALT_BASE = {
    Minus: '-_', Equal: '=+', BracketLeft: '[{', BracketRight: ']}',
    Backslash: '\\|', Semicolon: ';:', Quote: '\'"', Backquote: '`~',
    Comma: ',<', Period: '.>', Slash: '/?',
    Digit1: '1!', Digit2: '2@', Digit3: '3#', Digit4: '4$', Digit5: '5%',
    Digit6: '6^', Digit7: '7&', Digit8: '8*', Digit9: '9(', Digit0: '0)',
  };

  const $ = (id) => document.getElementById(id);
  const els = {
    stage: $('stage'), terminal: $('terminal'), probe: $('probe'),
    toggle: $('control-toggle'), panel: $('panel'),
    pUser: $('p-user'), pViewers: $('p-viewers'), pController: $('p-controller'),
    pPending: $('p-pending'), pMode: $('p-mode'), pStatus: $('p-status'), pSize: $('p-size'),
    takeBtn: $('take-btn'), releaseBtn: $('release-btn'),
    sizeSection: $('size-section'),
    colsDec: $('cols-dec'), colsInc: $('cols-inc'),
    rowsDec: $('rows-dec'), rowsInc: $('rows-inc'),
    altEsc: $('alt-esc'),
    adminSection: $('admin-section'), modeSelect: $('mode-select'),
    restartBtn: $('restart-btn'), kickBtn: $('kick-btn'),
    requestBar: $('request-bar'), requestText: $('request-text'),
    grantBtn: $('grant-btn'), denyBtn: $('deny-btn'),
    endedBar: $('ended-bar'), endedRestart: $('ended-restart'),
    overlay: $('overlay'), overlayMsg: $('overlay-msg'), reconnectBtn: $('reconnect-btn'),
    toast: $('toast'),
  };

  let term = null;
  let ws = null;
  let hbTimer = null;
  let reconnectTimer = null;
  let toastTimer = null;
  let backoffIdx = 0;
  let me = { username: null, role: null };
  let grid = { cols: 120, rows: 36 };
  let state = { controller: null, mode: 'soft', viewers: 0, pending: null };
  let replayLeft = 0; // bytes of buffer replay still expected after hello
  let clipboardArmed = false; // OSC 52 honored only for live output, not replay

  const isAdmin = () => me.role === 'admin';
  const isController = () => me.username !== null && state.controller === me.username;

  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }
  const sendInput = (data) => send({ t: 'input', data });

  // --- websocket lifecycle ---

  function connect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    setStatus('connecting');
    ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      hbTimer = setInterval(() => send({ t: 'hb' }), 30000);
    };
    ws.onmessage = onMessage;
    ws.onclose = onClose;
  }

  function onClose(ev) {
    clearInterval(hbTimer);
    hbTimer = null;
    ws = null;
    if (ev.code === 4401) { location.href = '/login'; return; }
    if (ev.code === 4000) { setStatus('disconnected'); showOverlay('Disconnected by admin.'); return; }
    setStatus('reconnecting');
    const delay = BACKOFF_MS[Math.min(backoffIdx, BACKOFF_MS.length - 1)];
    backoffIdx++;
    reconnectTimer = setTimeout(connect, delay);
  }

  function onMessage(ev) {
    if (ev.data instanceof ArrayBuffer) {
      if (term) {
        const bytes = new Uint8Array(ev.data);
        if (replayLeft > 0) {
          replayLeft -= bytes.byteLength;
          if (replayLeft <= 0) {
            // write callbacks fire after the chunk is parsed, so this arms the
            // clipboard only once every replayed byte has gone through the parser
            term.write(bytes, () => { clipboardArmed = true; });
          } else {
            term.write(bytes);
          }
        } else {
          term.write(bytes);
        }
        els.endedBar.hidden = true; // fresh output ⇒ shell is alive again
      }
      return;
    }
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    switch (msg.t) {
      case 'hello':
        onHello(msg);
        break;
      case 'size':
        if (!term) break;
        grid = { cols: msg.cols, rows: msg.rows };
        term.resize(grid.cols, grid.rows);
        fitFont();
        renderPanel();
        break;
      case 'state':
        state = { controller: msg.controller, mode: msg.mode, viewers: msg.viewers, pending: msg.pending };
        renderPanel();
        break;
      case 'request':
        toast(msg.from + ' requests control');
        break;
      case 'ended':
        els.endedBar.hidden = false;
        els.endedRestart.hidden = !isAdmin();
        break;
      case 'error':
        toast(msg.msg);
        break;
    }
  }

  function onHello(msg) {
    me = msg.you;
    grid = { cols: msg.size.cols, rows: msg.size.rows };
    state = msg.state;
    replayLeft = msg.bufferBytes;
    clipboardArmed = replayLeft === 0;
    backoffIdx = 0;
    hideOverlay();
    els.endedBar.hidden = true;
    setStatus('connected');
    if (!term) {
      createTerminal();
    } else {
      // reconnect: rebuild from the buffer replay that follows
      term.reset();
      term.resize(grid.cols, grid.rows);
    }
    fitFont();
    renderPanel();
  }

  // --- terminal ---

  function createTerminal() {
    term = new Terminal({
      cols: grid.cols,
      rows: grid.rows,
      fontFamily: "'JetBrainsMono Nerd Font Mono', monospace",
      fontSize: PROBE_FONT_PX,
      fontWeight: 400,
      fontWeightBold: 700,
      letterSpacing: 0,
      drawBoldTextInBrightColors: false, // kitty does not brighten bold; keep palettes identical
      scrollback: 5000,
      theme: THEME,
    });
    term.open(els.terminal);
    // v1 theme is locked: swallow OSC 12 cursor-color sets from the PTY stream /
    // replay buffer so nothing run in the shared shell can recolor the cursor.
    // Queries ("?") fall through so xterm still reports the theme color.
    term.parser.registerOscHandler(12, (data) => data !== '?');
    // OSC 52 copy (tmux load-buffer -w, remote shells): set the local clipboard.
    // Only live output is honored (see clipboardArmed) so reconnect replays don't
    // re-copy stale data; the "?" read form is consumed unanswered — answering
    // would let anything in the shared shell read every viewer's clipboard.
    term.parser.registerOscHandler(52, (data) => {
      const payload = data.slice(data.indexOf(';') + 1);
      if (!clipboardArmed || !payload || payload === '?') return true;
      try {
        const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
        navigator.clipboard.writeText(new TextDecoder().decode(bytes)).catch(() => {});
      } catch { /* malformed base64: drop */ }
      return true;
    });
    term.onData(sendInput); // send always; server ignores non-controllers
    term.attachCustomKeyEventHandler(altEscHandler);
    term.options.macOptionIsMeta = els.altEsc.checked;
    term.focus();
  }

  function altEscHandler(ev) {
    if (!els.altEsc.checked || ev.type !== 'keydown' || !ev.altKey || ev.ctrlKey || ev.metaKey) return true;
    // ev.key is unreliable under Option on macOS (composed chars); derive from ev.code
    let k = null;
    const letter = /^Key([A-Z])$/.exec(ev.code);
    if (letter) k = ev.shiftKey ? letter[1] : letter[1].toLowerCase();
    else if (ALT_BASE[ev.code]) k = ALT_BASE[ev.code][ev.shiftKey ? 1 : 0];
    // anything else (arrows, Enter, Backspace…): xterm's macOptionIsMeta path
    // already emits correct ESC-/CSI-modified sequences from stable keyCodes
    if (!k) return true;
    ev.preventDefault(); // never let the composed char reach xterm or the page
    sendInput('\x1b' + k);
    return false;
  }

  // Fixed canonical grid: never resize from fit logic — pick the largest font
  // size whose cols×rows cell grid fits the viewport (letterboxed by flexbox).
  function fitFont() {
    if (!term) return;
    const rect = els.probe.getBoundingClientRect();
    const cellW = rect.width / 10 / PROBE_FONT_PX; // px per 1px of font-size
    const cellH = rect.height / PROBE_FONT_PX;
    if (!cellW || !cellH) return;
    const availW = els.stage.clientWidth - 16; // 2 × #stage padding
    const availH = els.stage.clientHeight - 16;
    // 0.25px steps: fractional font sizes render exactly (cell width scales
    // linearly), and integer steps waste up to ~0.6px × cols of width as letterbox
    let f = Math.floor(Math.min(availW / (grid.cols * cellW), availH / (grid.rows * cellH)) * 4) / 4;
    f = Math.max(8, Math.min(32, f));
    // xterm's DOM renderer rounds cell metrics to whole pixels, so the probe
    // estimate can overshoot: apply, measure the real grid, step down to fit.
    const screen = els.terminal.querySelector('.xterm-screen');
    for (; f > 8; f -= 0.25) {
      if (term.options.fontSize !== f) term.options.fontSize = f;
      if (!screen) return;
      const r = screen.getBoundingClientRect();
      if (r.width <= availW && r.height <= availH) return;
    }
    if (term.options.fontSize !== f) term.options.fontSize = f;
  }

  // --- panel / ui state ---

  function renderPanel() {
    els.pUser.textContent = me.username ? me.username + ' (' + me.role + ')' : '–';
    els.pViewers.textContent = String(state.viewers);
    els.pController.textContent = state.controller ?? 'none';
    els.pPending.textContent = state.pending ?? 'none';
    els.pMode.textContent = state.mode;
    els.pSize.textContent = grid.cols + '×' + grid.rows;

    const ctrl = isController();
    document.body.classList.toggle('readonly', !ctrl);

    els.takeBtn.hidden = ctrl;
    if (!ctrl) {
      if (state.pending === me.username) {
        els.takeBtn.disabled = true;
        els.takeBtn.textContent = 'Request pending…';
      } else {
        els.takeBtn.disabled = false;
        els.takeBtn.textContent = (state.mode === 'fast' || isAdmin()) ? 'Take Control' : 'Request Control';
      }
    }

    const canRelease = ctrl || (isAdmin() && state.controller !== null);
    els.releaseBtn.hidden = !canRelease;
    els.releaseBtn.textContent = ctrl ? 'Release Control' : 'Force Release';

    const canResize = ctrl || isAdmin();
    els.sizeSection.querySelectorAll('button').forEach((b) => { b.disabled = !canResize; });

    els.adminSection.hidden = !isAdmin();
    els.modeSelect.value = state.mode;
    els.endedRestart.hidden = !isAdmin();

    const showReq = Boolean(state.pending) && state.pending !== me.username && (ctrl || isAdmin());
    els.requestBar.hidden = !showReq;
    if (showReq) els.requestText.textContent = state.pending + ' requests control';
  }

  function setStatus(s) {
    els.pStatus.textContent = s;
    els.pStatus.dataset.state = s;
  }

  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { els.toast.hidden = true; }, 4000);
  }

  function showOverlay(msg) {
    els.overlayMsg.textContent = msg;
    els.overlay.hidden = false;
  }

  function hideOverlay() {
    els.overlay.hidden = true;
  }

  function sendResize(cols, rows) {
    cols = Math.max(20, Math.min(500, Math.round(cols)));
    rows = Math.max(5, Math.min(200, Math.round(rows)));
    send({ t: 'resize', cols, rows });
  }

  // --- wiring ---

  function init() {
    els.toggle.addEventListener('click', () => {
      const open = els.panel.classList.toggle('open');
      els.toggle.setAttribute('aria-expanded', String(open));
    });

    els.takeBtn.addEventListener('click', () => {
      if (state.mode === 'fast' || isAdmin()) send({ t: 'take' });
      else send({ t: 'request' });
    });
    els.releaseBtn.addEventListener('click', () => send({ t: 'release' }));

    els.sizeSection.querySelectorAll('.preset').forEach((btn) => {
      btn.addEventListener('click', () => sendResize(Number(btn.dataset.cols), Number(btn.dataset.rows)));
    });
    els.colsDec.addEventListener('click', () => sendResize(grid.cols - COL_STEP, grid.rows));
    els.colsInc.addEventListener('click', () => sendResize(grid.cols + COL_STEP, grid.rows));
    els.rowsDec.addEventListener('click', () => sendResize(grid.cols, grid.rows - ROW_STEP));
    els.rowsInc.addEventListener('click', () => sendResize(grid.cols, grid.rows + ROW_STEP));

    document.querySelectorAll('button.seq').forEach((btn) => {
      btn.addEventListener('click', () => {
        sendInput(KEY_SEQS[btn.dataset.seq]);
        if (term) term.focus();
      });
    });
    els.altEsc.addEventListener('change', () => {
      if (term) term.options.macOptionIsMeta = els.altEsc.checked;
    });

    els.modeSelect.addEventListener('change', () => send({ t: 'mode', mode: els.modeSelect.value }));
    els.restartBtn.addEventListener('click', () => send({ t: 'restart' }));
    els.endedRestart.addEventListener('click', () => send({ t: 'restart' }));
    els.kickBtn.addEventListener('click', () => {
      if (confirm('Disconnect every viewer (including you)?')) send({ t: 'kickAll' });
    });

    els.grantBtn.addEventListener('click', () => {
      if (state.pending) send({ t: 'grant', to: state.pending });
    });
    els.denyBtn.addEventListener('click', () => send({ t: 'deny' }));

    els.reconnectBtn.addEventListener('click', () => {
      hideOverlay();
      backoffIdx = 0;
      connect();
    });

    window.addEventListener('resize', fitFont);
    document.fonts.ready.then(fitFont); // webfont metrics differ from fallback

    connect();
  }

  init();
})();
