(() => {
  'use strict';

  // Catppuccin Mocha — values must match the team's kitty config (see README).
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
  const REFRESH_MARGIN_MS = 5 * 60 * 1000;
  const REFRESH_BACKOFF_MS = [10000, 20000, 40000];
  const STATE_CHECK_MS = 60000; // periodic UX check; the server's slide is the real keep-alive
  const PROBE_FONT_PX = 16; // matches #probe font-size in styles.css
  const DEFAULT_FONT = 16; // fixed render size, both modes; browser zoom is the scaling control
  const RESIZE_MS = 200;
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
    pPending: $('p-pending'), pMode: $('p-mode'), pStatus: $('p-status'),
    takeBtn: $('take-btn'), releaseBtn: $('release-btn'),
    pSession: $('p-session'), sessionBtn: $('session-btn'), leaveBtn: $('leave-btn'), sessionBadge: $('session-badge'),
    altEsc: $('alt-esc'),
    adminSection: $('admin-section'), modeSelect: $('mode-select'),
    restartBtn: $('restart-btn'), kickBtn: $('kick-btn'),
    requestBar: $('request-bar'), requestText: $('request-text'),
    grantBtn: $('grant-btn'), denyBtn: $('deny-btn'),
    endedBar: $('ended-bar'), endedRestart: $('ended-restart'),
    logoutForm: $('logout-form'),
    overlay: $('overlay'), overlayMsg: $('overlay-msg'), reconnectBtn: $('reconnect-btn'),
    chooser: $('chooser'), chooserNote: $('chooser-note'), chooserInfo: $('chooser-info'),
    chooseShared: $('choose-shared'), chooseSplit: $('choose-split'),
    uploadOpen: $('upload-open'), uploadModal: $('upload-modal'),
    uploadChooser: $('upload-chooser'),
    uploadClipboard: $('upload-clipboard'), uploadPick: $('upload-pick'),
    uploadPickFolder: $('upload-pick-folder'), uploadCancel: $('upload-cancel'),
    uploadError: $('upload-error'), uploadFile: $('upload-file'), uploadFolder: $('upload-folder'),
    uploadProgress: $('upload-progress'), uploadFileLabel: $('upload-file-label'),
    uploadBarFill: $('upload-bar-fill'), uploadStats: $('upload-stats'),
    uploadAbort: $('upload-abort'), uploadHide: $('upload-hide'),
    uploadResult: $('upload-result'), uploadResultMsg: $('upload-result-msg'),
    uploadResultPath: $('upload-result-path'), uploadDone: $('upload-done'),
    transferIndicator: $('transfer-indicator'), transferNotice: $('transfer-notice'),
    transferNoticeText: $('transfer-notice-text'), transferNoticePath: $('transfer-notice-path'),
    transferNoticeClose: $('transfer-notice-close'),
    downloadPath: $('download-path'), downloadBtn: $('download-btn'),
    toast: $('toast'),
  };

  let term = null;
  let ws = null;
  let hbTimer = null;
  let reconnectTimer = null;
  let toastTimer = null;
  let backoffIdx = 0;
  let me = { username: null, role: null };
  let offerShared = false; // server tier: false ⇒ terminal-only lobby, no shared session or admin panel
  let authOn = true;
  let accessExpiresAt = null;
  let refreshTimer = null;
  let refreshRetry = 0;
  let recovering = false; // one 4401 recovery attempt per closed socket; guards against reconnect loops
  let grid = { cols: 120, rows: 36 };
  let state = { controller: null, mode: 'soft', viewers: 0, pending: null };
  let sess = 'lobby'; // this connection's session: 'lobby' | 'shared' | 'split' (own shell)
  let lastSess = null; // null on page load lands at chooser; a dropped shared WS rejoins silently
  let epoch = 0; // echoed in input/resize so the server drops keystrokes in flight across a session switch
  let splitGrid = { cols: 0, rows: 0 }; // viewport-derived grid while split
  let resizeTimer = null;
  let splitEnded = false; // a splitExited arrived; the lobby chooser notes it
  let replayLeft = 0; // bytes of buffer replay still expected after a mode frame
  let replayGen = 0; // invalidates stale write-callbacks from a superseded replay
  let clipboardArmed = false; // OSC 52 honored only for live output, not replay
  let transfer = null; // at most one upload in flight; null when idle

  const isAdmin = () => me.role === 'admin';
  const isController = () => me.username !== null && state.controller === me.username;

  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }
  const sendInput = (data) => {
    if (sess === 'lobby') return; // lobby has no session to type into
    send({ t: 'input', data, e: epoch });
  };

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
    if (ev.code === 4401) { recover4401(); return; }
    if (ev.code === 4000) {
      // an admin kick must land at the chooser on Reconnect, never silently rejoin shared
      cancelRefresh();
      lastSess = null;
      setStatus('disconnected');
      showOverlay('Disconnected by admin.');
      return;
    }
    setStatus('reconnecting');
    const delay = BACKOFF_MS[Math.min(backoffIdx, BACKOFF_MS.length - 1)];
    backoffIdx++;
    reconnectTimer = setTimeout(connect, delay);
  }

  function cancelRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }

  function checkAccessState() {
    if (typeof accessExpiresAt !== 'number') return;
    if (accessExpiresAt * 1000 - Date.now() <= REFRESH_MARGIN_MS) doRefresh();
  }

  function resumeRefresh() {
    refreshRetry = 0;
    checkAccessState();
  }

  async function doRefresh() {
    if (typeof accessExpiresAt !== 'number') return;
    cancelRefresh();
    let res;
    try {
      res = await fetch('/refresh', { method: 'POST' });
    } catch {
      return retryRefresh();
    }
    if (res.status === 401) { location.href = '/login'; return; }
    if (!res.ok) return retryRefresh();
    let body;
    try { body = await res.json(); } catch { return retryRefresh(); }
    accessExpiresAt = body.accessExpiresAt;
    refreshRetry = 0;
  }

  // Transient-only backoff: a real 401 (doRefresh) is the sole route to /login; exhaustion waits for the next periodic check.
  function retryRefresh() {
    if (refreshRetry >= REFRESH_BACKOFF_MS.length) { refreshRetry = 0; return; }
    refreshTimer = setTimeout(doRefresh, REFRESH_BACKOFF_MS[refreshRetry++]);
  }

  async function recover4401() {
    if (recovering) { location.href = '/login'; return; }
    recovering = true;
    let res;
    try { res = await fetch('/refresh', { method: 'POST' }); }
    catch { location.href = '/login'; return; }
    if (res.status !== 200) { location.href = '/login'; return; }
    let body;
    try { body = await res.json(); } catch { location.href = '/login'; return; }
    if (typeof body.accessExpiresAt === 'number') accessExpiresAt = body.accessExpiresAt;
    lastSess = null; // genuinely gone: reconnect into the lobby, not a silent shared rejoin
    connect();
  }

  function onMessage(ev) {
    if (ev.data instanceof ArrayBuffer) {
      if (term && sess !== 'lobby') { // lobby receives no PTY output
        const bytes = new Uint8Array(ev.data);
        if (replayLeft > 0) {
          replayLeft -= bytes.byteLength;
          if (replayLeft <= 0) {
            // arm OSC 52 only after every replayed byte is parsed, and only if no newer replay superseded this one
            const g = replayGen;
            term.write(bytes, () => { if (g === replayGen) clipboardArmed = true; });
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
        if (!term || sess !== 'shared') break; // only shared follows the min-grid
        grid = { cols: msg.cols, rows: msg.rows };
        term.resize(grid.cols, grid.rows);
        fitShared();
        break;
      case 'mode':
        onMode(msg);
        break;
      case 'splitExited':
        splitEnded = true;
        toast('shell exited');
        break;
      case 'splitError':
        toast('split failed: ' + msg.msg);
        break;
      case 'state':
        state = { controller: msg.controller, mode: msg.mode, viewers: msg.viewers, pending: msg.pending };
        renderPanel();
        break;
      case 'request':
        toast(msg.from + ' requests control');
        break;
      case 'ended':
        if (sess !== 'shared') break; // shared shell state is invisible elsewhere
        els.endedBar.hidden = false;
        els.endedRestart.hidden = !isAdmin();
        break;
      case 'error':
        toast(msg.msg);
        break;
    }
  }

  // Suppress OSC 52 until the shared replay is consumed (see the binary branch of onMessage).
  function armReplay(bufferBytes) {
    replayGen++; // a still-parsing older replay must not re-arm the clipboard
    replayLeft = bufferBytes;
    clipboardArmed = replayLeft === 0;
  }

  function onHello(msg) {
    me = msg.you;
    offerShared = msg.offerShared === true;
    authOn = msg.authOn === true;
    accessExpiresAt = typeof msg.accessExpiresAt === 'number' ? msg.accessExpiresAt : null;
    grid = { cols: msg.size.cols, rows: msg.size.rows };
    state = msg.state;
    sess = 'lobby'; // no replay follows hello
    epoch = msg.epoch;
    clearTimeout(resizeTimer);
    armReplay(0); // a replay interrupted by the reconnect must stay disarmed
    backoffIdx = 0;
    recovering = false;
    hideOverlay();
    els.endedBar.hidden = true;
    setStatus('connected');
    if (!term) {
      createTerminal();
    } else {
      term.reset(); // the shared mode reply's replay (if any) rebuilds the grid
    }
    if (offerShared && lastSess === 'shared') {
      // silent rejoin after an auto-reconnect: the mode reply + replay restores the terminal, skipping the chooser
      const want = computeNatural() || {}; // absent size: server uses config
      send({ t: 'shared', cols: want.cols, rows: want.rows });
      hideChooser();
    } else {
      showChooser(null);
    }
    resumeRefresh();
    renderPanel();
  }

  function onMode(msg) {
    if (!term) return;
    epoch = msg.epoch; // keystrokes from before this frame carried the old epoch
    clearTimeout(resizeTimer);
    term.reset();
    if (msg.mode === 'split') {
      sess = 'split';
      splitGrid = { cols: msg.cols, rows: msg.rows };
      // own shell: live output only, no replay — OSC 52 is armed immediately
      armReplay(0);
      els.endedBar.hidden = true;
      term.options.fontSize = DEFAULT_FONT;
      term.resize(splitGrid.cols, splitGrid.rows);
      hideChooser();
      term.focus();
    } else if (msg.mode === 'lobby') {
      // split shell exited: back to the chooser, never auto-shared
      sess = 'lobby';
      armReplay(0);
      els.endedBar.hidden = true;
      showChooser(splitEnded ? 'shell exited' : null);
    } else {
      sess = 'shared';
      grid = { cols: msg.cols, rows: msg.rows }; // the min-grid may have moved
      term.resize(grid.cols, grid.rows);
      fitShared();
      armReplay(msg.bufferBytes);
      hideChooser();
      term.focus();
    }
    splitEnded = false;
    lastSess = sess;
    renderPanel();
  }

  function createTerminal() {
    term = new Terminal({
      cols: grid.cols,
      rows: grid.rows,
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: DEFAULT_FONT,
      fontWeight: 400,
      fontWeightBold: 700,
      letterSpacing: 0,
      cursorStyle: 'bar', // kitty: cursor_shape beam
      cursorBlink: false, // kitty: cursor_blink_interval 0
      drawBoldTextInBrightColors: false, // kitty does not brighten bold; keep palettes identical
      scrollback: 5000,
      scrollSensitivity: 2,
      theme: THEME,
    });
    term.open(els.terminal);
    try {
      const webgl = new WebglAddon.WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch {
      // WebGL2 unavailable: keep xterm's default DOM renderer
    }
    // Swallow OSC 10/11/12 color-set escapes so a shell can't recolor the terminal (a side door to the cursor color); queries ("?") fall through so TUIs can still detect theme colors.
    for (const color of [10, 11, 12]) {
      term.parser.registerOscHandler(color, (data) => data !== '?');
    }
    // Honor DECSCUSR shapes but always strip the blink bit: the shell re-asserts blinking-bar (\e[5 q) each prompt, so cursorBlink:false alone isn't enough.
    term.parser.registerCsiHandler({ intermediates: ' ', final: 'q' }, (params) => {
      const p = typeof params[0] === 'number' ? params[0] : 0;
      if (p <= 6) {
        term.options.cursorStyle = p === 0 ? 'bar' : p <= 2 ? 'block' : p <= 4 ? 'underline' : 'bar';
        term.options.cursorBlink = false;
      }
      return true; // handled: never let the default handler enable blinking
    });
    // OSC 52: honor WRITE/copy only (live output, see clipboardArmed); the "?" read form is consumed unanswered — answering would leak every viewer's clipboard to the shared shell.
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
    // anything else (arrows, Enter, Backspace…): xterm's macOptionIsMeta path already emits correct sequences
    if (!k) return true;
    ev.preventDefault(); // never let the composed char reach xterm or the page
    sendInput('\x1b' + k);
    return false;
  }

  // Natural grid: cols/rows that fit this viewport at DEFAULT_FONT, from the #probe's text metrics.
  function computeNatural() {
    const probe = els.probe.getBoundingClientRect();
    if (!probe.width || !probe.height) return null;
    const cellW = (probe.width / 10 / PROBE_FONT_PX) * DEFAULT_FONT;
    const cellH = (probe.height / PROBE_FONT_PX) * DEFAULT_FONT;
    return {
      cols: Math.max(20, Math.min(500, Math.floor((els.stage.clientWidth - 16) / cellW))),
      rows: Math.max(5, Math.min(200, Math.floor((els.stage.clientHeight - 16) / cellH))),
    };
  }

  // Shared grid comes from the server — never resize it locally; render at DEFAULT_FONT letterboxed, stepping the font down only if the server grid transiently doesn't fit.
  function fitShared() {
    if (!term || sess !== 'shared') return;
    const availW = els.stage.clientWidth - 16; // 2 × #stage padding
    const availH = els.stage.clientHeight - 16;
    const probe = els.probe.getBoundingClientRect();
    if (!probe.width || !probe.height) return;
    const cw = probe.width / 10 / PROBE_FONT_PX;
    const ch = probe.height / PROBE_FONT_PX;
    let f = Math.min(DEFAULT_FONT, availW / (grid.cols * cw), availH / (grid.rows * ch));
    f = Math.max(8, f);
    term.options.fontSize = f;
    // xterm's cell metrics differ slightly from the probe's: step down past device-px rounding until it actually fits
    const screen = els.terminal.querySelector('.xterm-screen');
    if (screen) {
      for (let i = 0; i < 40 && f > 8; i++, f -= 0.05) {
        if (term.options.fontSize !== f) term.options.fontSize = f;
        const m = screen.getBoundingClientRect();
        if (m.width <= availW && m.height <= availH) break;
      }
    }
  }

  // Debounced viewport follow-up: split resizes its own PTY; shared reports its natural grid and the server answers only if the min-grid moved.
  function refitViewport() {
    if (!term) return;
    const want = computeNatural();
    if (!want) return;
    if (sess === 'split') {
      if (want.cols !== splitGrid.cols || want.rows !== splitGrid.rows) {
        splitGrid = want;
        term.resize(want.cols, want.rows);
        send({ t: 'resize', cols: want.cols, rows: want.rows, e: epoch }); // own pty, no gate
      }
    } else if (sess === 'shared') {
      send({ t: 'resize', cols: want.cols, rows: want.rows, e: epoch });
      fitShared(); // re-letterbox while the report is in flight
    }
  }

  function onViewportResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(refitViewport, RESIZE_MS);
  }

  function renderPanel() {
    els.pUser.textContent = me.username ? me.username + ' (' + me.role + ')' : '–';
    els.pViewers.textContent = String(state.viewers);
    els.pController.textContent = state.controller ?? 'none';
    els.pPending.textContent = state.pending ?? 'none';
    els.pMode.textContent = state.mode;

    const shared = sess === 'shared';
    const split = sess === 'split';
    els.pSession.textContent = split ? 'Terminal' : sess;
    els.pSession.dataset.mode = sess;
    els.sessionBtn.hidden = sess === 'lobby' || !offerShared;
    els.sessionBtn.textContent = split ? 'Return to shared' : 'Terminal session';
    els.leaveBtn.hidden = sess === 'lobby';
    els.sessionBadge.hidden = !shared;

    // input gating is shared-only: split is your own shell, lobby has no session
    const ctrl = isController();
    document.body.classList.toggle('readonly', shared && !ctrl);

    els.takeBtn.hidden = ctrl || !shared; // take/request ignored from split and lobby
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

    els.adminSection.hidden = !(isAdmin() && offerShared);
    els.modeSelect.value = state.mode;
    els.endedRestart.hidden = !isAdmin();
    els.logoutForm.hidden = !authOn;

    els.chooserInfo.textContent = state.viewers + (state.viewers === 1 ? ' viewer' : ' viewers')
      + ' · controller: ' + (state.controller ?? 'none');

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

  function showChooser(note) {
    els.chooserNote.textContent = note ?? '';
    els.chooserNote.hidden = !note;
    els.chooseShared.hidden = !offerShared;
    els.chooserInfo.hidden = !offerShared;
    els.chooser.hidden = false;
    (offerShared ? els.chooseShared : els.chooseSplit).focus();
  }

  function hideChooser() {
    els.chooser.hidden = true;
  }

  function fmtBytes(n) {
    const units = ['KB', 'MB', 'GB'];
    if (n < 1024) return n + ' B';
    let v = n / 1024;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return v.toFixed(1) + ' ' + units[i];
  }

  function showUploadState(which) {
    els.uploadChooser.hidden = which !== 'chooser';
    els.uploadProgress.hidden = which !== 'progress';
    els.uploadResult.hidden = which !== 'result';
  }

  function chooserError(msg) {
    els.uploadError.textContent = msg;
    els.uploadError.hidden = !msg;
  }

  function openUploadModal() {
    els.uploadModal.hidden = false;
    if (transfer) {
      transfer.hidden = false;
      els.transferIndicator.hidden = true;
      showUploadState('progress');
      els.uploadHide.focus();
      return;
    }
    chooserError('');
    showUploadState('chooser');
    els.uploadPick.focus();
  }

  function closeUploadModal() {
    els.uploadModal.hidden = true;
  }

  function hideTransfer() {
    transfer.hidden = true;
    els.uploadModal.hidden = true;
    els.transferIndicator.hidden = false;
  }

  // Escape and backdrop-click are reflexive gestures: in progress they Hide, never abort.
  function dismissUploadModal() {
    if (transfer && !els.uploadProgress.hidden) return hideTransfer();
    closeUploadModal();
  }

  function showNotice(text, p, isErr) {
    els.transferNoticeText.textContent = text;
    els.transferNoticePath.textContent = p;
    els.transferNoticePath.hidden = !p;
    els.transferNotice.classList.toggle('err', isErr);
    els.transferNotice.hidden = false;
  }

  function hideNotice() {
    els.transferNotice.hidden = true;
  }

  function renderProgress(sent) {
    if (!transfer) return;
    const pct = transfer.total > 0 ? Math.floor((sent / transfer.total) * 100) : 100;
    els.uploadFileLabel.textContent = transfer.label;
    els.uploadBarFill.style.width = pct + '%';
    els.uploadStats.textContent = fmtBytes(sent) + ' / ' + fmtBytes(transfer.total) + ' · ' + pct + '%';
    els.transferIndicator.textContent = 'uploading ' + pct + '%';
  }

  function beginTransfer(label, total) {
    hideNotice();
    transfer = { label, total, done: 0, xhr: null, hidden: false, cancelled: false };
    els.uploadModal.hidden = false;
    showUploadState('progress');
    renderProgress(0);
    els.uploadHide.focus();
  }

  function finishTransfer(r) {
    const wasHidden = transfer.hidden;
    transfer = null;
    els.transferIndicator.hidden = true;
    if (wasHidden) {
      showNotice(r.notice, r.path, !r.ok);
      return;
    }
    els.uploadResultMsg.textContent = r.msg;
    els.uploadResultPath.textContent = r.path;
    els.uploadResultPath.hidden = !r.path;
    els.uploadDone.textContent = r.ok ? 'Done' : 'Close';
    showUploadState('result');
    els.uploadDone.focus();
  }

  async function completeTransfer(p) {
    let copied = false;
    // navigator.clipboard is undefined on plain HTTP (the default deployment): claim "copied" only if it resolved.
    if (navigator.clipboard && navigator.clipboard.writeText) {
      copied = await navigator.clipboard.writeText(p).then(() => true, () => false);
    }
    finishTransfer({
      ok: true,
      path: p,
      msg: copied ? 'Uploaded — path copied to clipboard.' : 'Uploaded — select the path below and copy it.',
      notice: copied ? 'uploaded — copied:' : 'uploaded:',
    });
  }

  function failTransfer(e) {
    if (transfer.cancelled) {
      return finishTransfer({ ok: false, path: '', msg: 'Upload cancelled.', notice: 'upload cancelled' });
    }
    const m = e && e.message || String(e);
    finishTransfer({ ok: false, path: '', msg: 'Upload failed: ' + m, notice: 'upload failed: ' + m });
  }

  // xhr, not fetch: only XHR reports upload progress, and xhr.send(file) streams from disk with no JS-side buffer.
  function xhrUpload(url, blob, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      transfer.xhr = xhr;
      xhr.open('POST', url);
      xhr.upload.onprogress = (e) => onProgress(e.loaded);
      xhr.onload = () => {
        if (xhr.status !== 200) return reject(new Error(xhr.responseText || 'error (' + xhr.status + ')'));
        try { resolve(JSON.parse(xhr.responseText)); } catch { reject(new Error('bad server response')); }
      };
      xhr.onerror = () => reject(new Error('network error'));
      xhr.onabort = () => reject(new Error('aborted'));
      xhr.send(blob);
    });
  }

  async function startFileUpload(blob, name) {
    if (transfer) return;
    beginTransfer(name, blob.size);
    let r;
    try {
      r = await xhrUpload('/upload?name=' + encodeURIComponent(name), blob, renderProgress);
    } catch (e) {
      return failTransfer(e);
    }
    await completeTransfer(r.path);
  }

  // webkitRelativePath is '' for loose-file and clipboard picks, so rel falls back to the bare name.
  async function startBatchUpload(files, root) {
    if (transfer) return;
    let total = 0;
    for (const f of files) total += f.size;
    beginTransfer(root + ' — file 1/' + files.length, total);
    const t = transfer;
    let dest;
    try {
      const res = await fetch('/upload/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: root }),
      });
      if (!res.ok) throw new Error(await res.text() || 'error (' + res.status + ')');
      const batch = await res.json();
      for (let i = 0; i < files.length; i++) {
        if (t.cancelled) throw new Error('aborted');
        const f = files[i];
        const rel = f.webkitRelativePath.split('/').slice(1).join('/') || f.name;
        t.label = root + ' — file ' + (i + 1) + '/' + files.length;
        renderProgress(t.done);
        try {
          await xhrUpload('/upload?batch=' + encodeURIComponent(batch.batchId) + '&path=' + encodeURIComponent(rel),
            f, (loaded) => renderProgress(t.done + loaded));
        } catch (e) {
          if (t.cancelled) throw e;
          throw new Error(rel + ': ' + (e && e.message || e));
        }
        t.done += f.size;
        renderProgress(t.done);
      }
      dest = batch.root;
    } catch (e) {
      return failTransfer(e);
    }
    await completeTransfer(dest);
  }

  async function uploadFromClipboard() {
    if (!navigator.clipboard || !navigator.clipboard.read) {
      return chooserError('clipboard read needs HTTPS — use Choose files…');
    }
    let items;
    try {
      items = await navigator.clipboard.read();
    } catch (e) {
      return chooserError('clipboard blocked: ' + (e && e.message || e));
    }
    const imgs = [];
    for (const item of items) {
      const type = item.types.find((t) => t.startsWith('image/'));
      if (!type) continue;
      const ext = (type.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '') || 'png';
      imgs.push({ blob: await item.getType(type), type, ext });
    }
    if (imgs.length === 0) return chooserError('no image found in the clipboard');
    if (imgs.length === 1) return startFileUpload(imgs[0].blob, 'clipboard-image.' + imgs[0].ext);
    const files = imgs.map((im, i) => new File([im.blob], 'clipboard-image-' + (i + 1) + '.' + im.ext, { type: im.type }));
    return startBatchUpload(files, 'clipboard');
  }

  async function startDownload() {
    const p = els.downloadPath.value.trim();
    if (!p) return els.downloadPath.focus();
    const url = '/download?path=' + encodeURIComponent(p);
    let res;
    // Probe first: <a download> reports a 404 only as a bare "Failed — No file", and location.href would navigate the terminal away.
    try {
      res = await fetch(url, { method: 'HEAD' });
    } catch (e) {
      return toast('download failed: ' + (e && e.message || e));
    }
    if (!res.ok) {
      if (res.status === 404) return toast('no such path: ' + p);
      if (res.status === 400) return toast('use an absolute path');
      if (res.status === 401) return toast('session expired — reload the page');
      return toast('download failed (' + res.status + ')');
    }
    const a = document.createElement('a');
    a.href = url;
    a.download = '';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

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

    els.chooseShared.addEventListener('click', () => {
      const want = computeNatural() || {}; // absent size: server uses config
      send({ t: 'shared', cols: want.cols, rows: want.rows });
    });
    els.chooseSplit.addEventListener('click', () => {
      const want = computeNatural() || {};
      send({ t: 'split', cols: want.cols, rows: want.rows });
    });

    els.sessionBtn.addEventListener('click', () => {
      const want = computeNatural() || {}; // absent size: server uses config
      if (sess === 'split') {
        send({ t: 'shared', cols: want.cols, rows: want.rows });
      } else if (sess === 'shared') {
        send({ t: 'split', cols: want.cols, rows: want.rows });
      }
      if (term) term.focus();
    });
    // leaving: shared just detaches (the shell lives on server-side); split ends the split shell
    els.leaveBtn.addEventListener('click', () => send({ t: 'lobby' }));

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

    els.uploadOpen.addEventListener('click', openUploadModal);
    els.uploadCancel.addEventListener('click', closeUploadModal);
    els.uploadModal.addEventListener('click', (e) => { if (e.target === els.uploadModal) dismissUploadModal(); });
    els.uploadModal.addEventListener('keydown', (e) => { if (e.key === 'Escape') dismissUploadModal(); });
    // un-awaited and the modal stays open: navigator.clipboard.read() must run inside the click's user-activation window
    els.uploadClipboard.addEventListener('click', () => { uploadFromClipboard(); });
    els.uploadPick.addEventListener('click', () => els.uploadFile.click());
    els.uploadPickFolder.addEventListener('click', () => els.uploadFolder.click());
    els.uploadFile.addEventListener('change', () => {
      const files = Array.from(els.uploadFile.files || []);
      els.uploadFile.value = ''; // allow re-picking the same file
      if (files.length === 1) startFileUpload(files[0], files[0].name);
      else if (files.length > 1) startBatchUpload(files, 'files');
    });
    els.uploadFolder.addEventListener('change', () => {
      const files = Array.from(els.uploadFolder.files || []);
      els.uploadFolder.value = '';
      if (!files.length) return chooserError('folder is empty (or unreadable)');
      startBatchUpload(files, files[0].webkitRelativePath.split('/')[0] || 'folder');
    });
    els.uploadAbort.addEventListener('click', () => {
      if (!transfer) return;
      transfer.cancelled = true;
      if (transfer.xhr) transfer.xhr.abort();
    });
    els.uploadHide.addEventListener('click', hideTransfer);
    els.uploadDone.addEventListener('click', closeUploadModal);
    els.transferIndicator.addEventListener('click', openUploadModal);
    els.transferNoticeClose.addEventListener('click', hideNotice);

    els.downloadBtn.addEventListener('click', startDownload);
    els.downloadPath.addEventListener('keydown', (e) => { if (e.key === 'Enter') startDownload(); });

    els.reconnectBtn.addEventListener('click', () => {
      hideOverlay();
      backoffIdx = 0;
      connect();
    });

    window.addEventListener('resize', onViewportResize);
    document.fonts.ready.then(onViewportResize); // webfont metrics differ from fallback

    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') resumeRefresh(); });
    window.addEventListener('online', resumeRefresh);
    setInterval(checkAccessState, STATE_CHECK_MS);

    connect();
  }

  init();
})();
