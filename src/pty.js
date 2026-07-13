import pty from 'node-pty';

// Spawn a bare shell PTY: command string split on whitespace into file+args,
// server env merged under the configured overrides. No ring buffer, no restart
// logic — the caller owns the handle's lifetime. Split-session PTYs use this
// directly; kill them only via pty.kill() (the shell process, never a process
// group or its child tree), so a daemonized tmux server survives for reattach.
export function spawnRawPty({ shell, cwd, cols, rows, env = {} }) {
  const [file, ...args] = shell.trim().split(/\s+/);
  return pty.spawn(file, args, {
    name: env.TERM || 'xterm-256color',
    cols,
    rows,
    cwd,
    env: { ...process.env, ...env },
  });
}

export function createPtySession({ shell, cwd, cols, rows, env = {}, maxBufferBytes }) {
  const size = { cols, rows };
  // procs killed via kill()/restart(): their late data/exit callbacks must be suppressed
  const dead = new WeakSet();
  let proc = null;
  let chunks = [];
  let totalBytes = 0;
  let dataListener = null;
  let exitListener = null;

  function append(chunk) {
    chunks.push(chunk);
    totalBytes += chunk.length;
    while (totalBytes > maxBufferBytes && chunks.length > 0) {
      totalBytes -= chunks.shift().length;
    }
  }

  function clearBuffer() {
    chunks = [];
    totalBytes = 0;
  }

  function spawn() {
    if (proc) throw new Error('shell already running');
    const p = spawnRawPty({ shell, cwd, cols: size.cols, rows: size.rows, env });
    p.onData((data) => {
      if (dead.has(p)) return;
      const chunk = Buffer.from(data, 'utf8');
      append(chunk);
      if (dataListener) dataListener(chunk);
    });
    p.onExit(({ exitCode, signal }) => {
      if (proc === p) proc = null;
      if (!dead.has(p) && exitListener) exitListener({ exitCode, signal });
    });
    proc = p;
  }

  function kill() {
    if (!proc) return;
    const p = proc;
    proc = null;
    dead.add(p);
    p.kill();
  }

  return {
    spawn,
    kill,
    restart(onCleared) {
      kill();
      clearBuffer();
      if (onCleared) onCleared();
      spawn();
    },
    write(data) {
      if (proc) proc.write(data);
    },
    resize(newCols, newRows) {
      size.cols = newCols;
      size.rows = newRows;
      if (proc) proc.resize(newCols, newRows);
    },
    getSize() {
      return { cols: size.cols, rows: size.rows };
    },
    isRunning() {
      return proc !== null;
    },
    getBuffer() {
      return Buffer.concat(chunks);
    },
    onData(fn) {
      dataListener = fn;
    },
    onExit(fn) {
      exitListener = fn;
    },
  };
}
