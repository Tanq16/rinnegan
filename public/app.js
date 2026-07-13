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
  const DEFAULT_FONT = 16; // fixed render size, both modes; browser zoom is the scaling control
  const RESIZE_MS = 200; // debounce for viewport-driven grid reports/resizes
  const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // mirrors the server cap
  const UPLOAD_CHUNK = 512 * 1024; // raw bytes/chunk; base64 stays under the WS 1MB maxPayload
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
    overlay: $('overlay'), overlayMsg: $('overlay-msg'), reconnectBtn: $('reconnect-btn'),
    chooser: $('chooser'), chooserNote: $('chooser-note'), chooserInfo: $('chooser-info'),
    chooseShared: $('choose-shared'), chooseSplit: $('choose-split'),
    uploadOpen: $('upload-open'), uploadModal: $('upload-modal'),
    uploadClipboard: $('upload-clipboard'), uploadPick: $('upload-pick'),
    uploadCancel: $('upload-cancel'), uploadFile: $('upload-file'),
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
  let sess = 'lobby'; // this connection's session: 'lobby' | 'shared' | 'split' (own shell)
  let lastSess = null; // sess before a reconnect; null on page load so a fresh
  // load always lands at the chooser, while a dropped shared WS rejoins silently
  let epoch = 0; // session epoch from hello/mode frames, echoed in input/resize
  // so the server drops keystrokes in flight across a session switch
  let splitGrid = { cols: 0, rows: 0 }; // viewport-derived grid while split
  let resizeTimer = null;
  let splitEnded = false; // a splitExited arrived; the lobby chooser notes it
  let replayLeft = 0; // bytes of buffer replay still expected after a mode frame
  let replayGen = 0; // invalidates stale write-callbacks from a superseded replay
  let clipboardArmed = false; // OSC 52 honored only for live output, not replay
  let uploadSeq = 0; // per-connection upload id counter
  let uploading = false; // one upload at a time (server enforces too)
  let uploadTimer = null; // resets `uploading` if the server never answers

  const isAdmin = () => me.role === 'admin';
  const isController = () => me.username !== null && state.controller === me.username;

  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }
  const sendInput = (data) => {
    if (sess === 'lobby') return; // lobby has no session to type into
    send({ t: 'input', data, e: epoch });
  };

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
    if (ev.code === 4000) {
      // an admin kick is deliberate, not a network blip: the Reconnect button
      // must land at the chooser, never silently rejoin the shared session
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

  function onMessage(ev) {
    if (ev.data instanceof ArrayBuffer) {
      if (term && sess !== 'lobby') { // lobby receives no PTY output
        const bytes = new Uint8Array(ev.data);
        if (replayLeft > 0) {
          replayLeft -= bytes.byteLength;
          if (replayLeft <= 0) {
            // write callbacks fire after the chunk is parsed, so this arms the
            // clipboard only once every replayed byte has gone through the
            // parser — and only if no newer replay has been armed meanwhile
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
        // the lobby mode message that follows lands on the chooser
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
      case 'uploaded':
        onUploaded(msg.path);
        break;
      case 'upload-error':
        uploading = false;
        clearTimeout(uploadTimer);
        toast('upload failed: ' + msg.msg);
        break;
      case 'error':
        toast(msg.msg);
        break;
    }
  }

  // The file is on the host at msg.path. If this connection can type into a
  // terminal (own split, or shared while holding control), insert the path at
  // the cursor with a trailing space and NO Enter — so Claude Code picks it up
  // and the user can add a prompt first. Otherwise (lobby, or a shared viewer
  // without control) there is nowhere to type, so surface the path and copy it.
  function onUploaded(p) {
    uploading = false;
    clearTimeout(uploadTimer);
    const canType = sess === 'split' || (sess === 'shared' && isController());
    if (canType) {
      sendInput(p + ' ');
      if (term) term.focus();
      toast('uploaded — inserted ' + p);
    } else {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(p).catch(() => {});
      }
      const why = sess === 'lobby' ? '' : ' (take control to insert)';
      toast('uploaded to ' + p + ' — copied' + why);
    }
  }

  // A buffer replay follows the shared mode message (attach/return-to-shared):
  // suppress OSC 52 until it is consumed (see the binary branch of onMessage).
  function armReplay(bufferBytes) {
    replayGen++; // a still-parsing older replay must not re-arm the clipboard
    replayLeft = bufferBytes;
    clipboardArmed = replayLeft === 0;
  }

  function onHello(msg) {
    me = msg.you;
    grid = { cols: msg.size.cols, rows: msg.size.rows };
    state = msg.state;
    sess = 'lobby'; // connections land in the lobby; no replay follows hello
    epoch = msg.epoch;
    clearTimeout(resizeTimer);
    armReplay(0); // a replay interrupted by the reconnect must stay disarmed
    backoffIdx = 0;
    hideOverlay();
    els.endedBar.hidden = true;
    setStatus('connected');
    if (!term) {
      createTerminal();
    } else {
      term.reset(); // the shared mode reply's replay (if any) rebuilds the grid
    }
    if (lastSess === 'shared') {
      // silent rejoin after an automatic reconnect (not a page load): the mode
      // reply + replay restores the terminal without a trip through the chooser
      const want = computeNatural() || {}; // absent size: server uses config
      send({ t: 'shared', cols: want.cols, rows: want.rows });
      hideChooser();
    } else {
      showChooser(null);
    }
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

  // --- terminal ---

  function createTerminal() {
    term = new Terminal({
      cols: grid.cols,
      rows: grid.rows,
      fontFamily: "'JetBrainsMono Nerd Font Mono', monospace",
      fontSize: DEFAULT_FONT,
      fontWeight: 400,
      fontWeightBold: 700,
      letterSpacing: 0,
      cursorStyle: 'bar', // kitty: cursor_shape beam
      cursorBlink: false, // kitty: cursor_blink_interval 0
      drawBoldTextInBrightColors: false, // kitty does not brighten bold; keep palettes identical
      scrollback: 5000,
      theme: THEME,
    });
    term.open(els.terminal);
    // v1 theme is locked: swallow OSC 10/11/12 color sets from the PTY stream /
    // replay buffer so nothing run in a shell can recolor the terminal. 10/11
    // matter too: this xterm build spills extra OSC 10/11 params into the next
    // special-color slots (fg;bg;cursor), a side door to the cursor color.
    // Queries ("?") fall through so TUIs can still detect the theme colors.
    for (const color of [10, 11, 12]) {
      term.parser.registerOscHandler(color, (data) => data !== '?');
    }
    // kitty never blinks (cursor_blink_interval 0): honor DECSCUSR shapes but
    // always strip the blink bit; 0 restores the kitty default (steady beam).
    // The shell re-asserts blinking-bar (\e[5 q) at every prompt (rc-base.zsh),
    // so without this the cursor blinks forever despite cursorBlink: false.
    term.parser.registerCsiHandler({ intermediates: ' ', final: 'q' }, (params) => {
      const p = typeof params[0] === 'number' ? params[0] : 0;
      if (p <= 6) {
        term.options.cursorStyle = p === 0 ? 'bar' : p <= 2 ? 'block' : p <= 4 ? 'underline' : 'bar';
        term.options.cursorBlink = false;
      }
      return true; // handled: never let the default handler enable blinking
    });
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

  // Natural grid: what fits this viewport at DEFAULT_FONT, from the #probe's
  // true text metrics. Reported to the server on shared attach/resize (the
  // shared grid is the elementwise min over members) and used directly in split.
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

  // Shared grid comes from the server ({t:'size'}/{t:'mode'}) — never resize it
  // locally. Render at DEFAULT_FONT, letterboxed: the remainder stays painted in
  // the terminal background (see #stage), the same way kitty pads a window that
  // isn't an exact multiple of the cell. If the server grid transiently does not
  // fit (window shrank/zoomed before the server applied our natural report),
  // step the font down just enough to fit; the next call restores DEFAULT_FONT
  // as soon as it fits again.
  function fitShared() {
    if (!term || sess !== 'shared') return;
    const availW = els.stage.clientWidth - 16; // 2 × #stage padding
    const availH = els.stage.clientHeight - 16;
    const probe = els.probe.getBoundingClientRect();
    if (!probe.width || !probe.height) return;
    // probe metrics: cell px per 1px of font-size; fractional sizes render fine
    const cw = probe.width / 10 / PROBE_FONT_PX;
    const ch = probe.height / PROBE_FONT_PX;
    let f = Math.min(DEFAULT_FONT, availW / (grid.cols * cw), availH / (grid.rows * ch));
    f = Math.max(8, f);
    term.options.fontSize = f;
    // xterm's real cell metrics differ slightly from the probe's: step down
    // past any device-px rounding until the rendered grid actually fits
    const screen = els.terminal.querySelector('.xterm-screen');
    if (screen) {
      for (let i = 0; i < 40 && f > 8; i++, f -= 0.05) {
        if (term.options.fontSize !== f) term.options.fontSize = f;
        const m = screen.getBoundingClientRect();
        if (m.width <= availW && m.height <= availH) break;
      }
    }
  }

  // Debounced viewport follow-up, both modes: split resizes its own PTY; shared
  // reports its natural grid (any member, no gate) and the server answers with
  // {t:'size'} only if the min-grid moved.
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
      send({ t: 'resize', cols: want.cols, rows: want.rows, e: epoch }); // natural-size report
      fitShared(); // re-letterbox (or fall back) while the report is in flight
    }
    // lobby: nothing to size
  }

  function onViewportResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(refitViewport, RESIZE_MS);
  }

  // --- panel / ui state ---

  function renderPanel() {
    els.pUser.textContent = me.username ? me.username + ' (' + me.role + ')' : '–';
    els.pViewers.textContent = String(state.viewers);
    els.pController.textContent = state.controller ?? 'none';
    els.pPending.textContent = state.pending ?? 'none';
    els.pMode.textContent = state.mode;

    const shared = sess === 'shared';
    const split = sess === 'split';
    els.pSession.textContent = sess;
    els.pSession.dataset.mode = sess;
    els.sessionBtn.hidden = sess === 'lobby'; // the chooser owns lobby transitions
    els.sessionBtn.textContent = split ? 'Return to shared' : 'Split session';
    els.leaveBtn.hidden = sess === 'lobby'; // already at the chooser
    els.sessionBadge.hidden = !shared;

    // split = your own shell, lobby = no session: input gating is shared-only
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

    els.adminSection.hidden = !isAdmin();
    els.modeSelect.value = state.mode;
    els.endedRestart.hidden = !isAdmin();

    // the chooser's subtle status line stays fresh while sitting in the lobby
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
    els.chooser.hidden = false;
    els.chooseShared.focus();
  }

  function hideChooser() {
    els.chooser.hidden = true;
  }

  function openUploadModal() {
    els.uploadModal.hidden = false;
    els.uploadPick.focus();
  }

  function closeUploadModal() {
    els.uploadModal.hidden = true;
  }

  // --- file upload ---

  // btoa over a large typed array blows the argument limit, so build the binary
  // string in fixed windows first (each byte is 0..255, so Latin-1 is exact).
  function bytesToB64(bytes) {
    let bin = '';
    const N = 0x8000;
    for (let i = 0; i < bytes.length; i += N) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + N));
    }
    return btoa(bin);
  }

  async function uploadBlob(blob, filename) {
    if (uploading) return toast('an upload is already in progress');
    if (!blob || blob.size === 0) return toast('nothing to upload');
    if (blob.size > MAX_UPLOAD_BYTES) return toast('file too large (max 25 MB)');
    if (!ws || ws.readyState !== WebSocket.OPEN) return toast('not connected');
    uploading = true;
    const id = 'u' + (++uploadSeq);
    try {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      send({ t: 'upload-begin', id, name: filename, size: bytes.length });
      for (let off = 0; off < bytes.length; off += UPLOAD_CHUNK) {
        send({ t: 'upload-chunk', id, data: bytesToB64(bytes.subarray(off, off + UPLOAD_CHUNK)) });
      }
      send({ t: 'upload-end', id });
      toast('uploading ' + filename + '…');
      clearTimeout(uploadTimer);
      uploadTimer = setTimeout(() => {
        if (uploading) { uploading = false; toast('upload timed out'); }
      }, 30000);
    } catch (e) {
      uploading = false;
      toast('upload failed: ' + (e && e.message || e));
    }
  }

  async function uploadFromClipboard() {
    if (!navigator.clipboard || !navigator.clipboard.read) {
      return toast('clipboard read needs HTTPS — use Choose file…');
    }
    let items;
    try {
      items = await navigator.clipboard.read();
    } catch (e) {
      return toast('clipboard blocked: ' + (e && e.message || e));
    }
    for (const item of items) {
      const type = item.types.find((t) => t.startsWith('image/'));
      if (type) {
        const blob = await item.getType(type);
        const ext = (type.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '') || 'png';
        return uploadBlob(blob, 'clipboard-image.' + ext);
      }
    }
    toast('no image found in the clipboard');
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
    // leave the current session for the chooser: shared just detaches (the shell
    // lives on server-side); split ends the split shell, same as any exit
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
    // click the backdrop or press Escape to dismiss
    els.uploadModal.addEventListener('click', (e) => { if (e.target === els.uploadModal) closeUploadModal(); });
    els.uploadModal.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeUploadModal(); });
    // read the clipboard within the click's gesture, then close the modal
    els.uploadClipboard.addEventListener('click', () => { uploadFromClipboard(); closeUploadModal(); });
    els.uploadPick.addEventListener('click', () => els.uploadFile.click());
    els.uploadFile.addEventListener('change', () => {
      const f = els.uploadFile.files && els.uploadFile.files[0];
      els.uploadFile.value = ''; // allow re-picking the same file
      if (f) { closeUploadModal(); uploadBlob(f, f.name); }
    });

    els.reconnectBtn.addEventListener('click', () => {
      hideOverlay();
      backoffIdx = 0;
      connect();
    });

    window.addEventListener('resize', onViewportResize);
    document.fonts.ready.then(onViewportResize); // webfont metrics differ from fallback

    connect();
  }

  init();
})();
