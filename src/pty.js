import pty from 'node-pty';

// The single spawn chokepoint. Shells are killed via pty.kill() only (never a process group) so a daemonized tmux survives.
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
