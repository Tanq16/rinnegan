# rinnegan

A minimal self-hosted **shared web terminal**: one server-owned shell PTY, many
authenticated browser viewers, and exactly one active keyboard controller at a time.
Everyone sees the same live output in their browser; users take or request control to type.
The shell behaves like a normal interactive shell on the host — anyone who wants
persistence, panes, or long-running workflows starts `tmux`/`zellij`/Claude Code themselves
inside it.

It is **not** an IDE, a task manager, or a tmux manager. It is a shared terminal frontend
and nothing more. Treat it like SSH access: it is a real shell on the machine it runs on.

Each release is a **fully self-contained** per-platform tarball — it bundles its own Node
runtime and a platform-native `node-pty`, so the host needs no Node, python, compiler, or
`make`. Download, extract, run.

## Download and run

Grab the tarball for your OS/architecture from the
[GitHub Releases](https://github.com/tanq16/rinnegan/releases) page:

| Platform | Asset |
| --- | --- |
| Linux, x86-64 | `rinnegan-linux-x64.tar.gz` |
| Linux, ARM64 (aarch64) | `rinnegan-linux-arm64.tar.gz` |
| macOS, Intel | `rinnegan-darwin-x64.tar.gz` |
| macOS, Apple Silicon | `rinnegan-darwin-arm64.tar.gz` |

There is no Windows build.

```sh
tar xf rinnegan-<os>-<arch>.tar.gz
cd rinnegan-<os>-<arch>
./bin/rinnegan
```

Then open **http://127.0.0.1:8787** in your browser and log in with the seeded account:

- username: `admin`
- password: `changeme`

**Change the default password immediately** — this is a shell on your machine:

```sh
./bin/rinnegan user passwd --username admin
```

You will be prompted for the new password (input is never echoed). It takes effect on the
next login without restarting the server. `./bin/rinnegan` with no subcommand runs the
server (equivalent to `./bin/rinnegan serve`).

## Self-contained

Each tarball ships everything it needs:

- **Its own Node 24.17.0 runtime** at `runtime/bin/node` — the launcher always uses it and
  never touches any Node on your `PATH`.
- **A platform-native `node-pty`** compiled for that exact OS/arch (with a working
  `spawn-helper`), so the PTY works out of the box.

The host needs **no Node, python, C/C++ compiler, or `make`**. `rinnegan` runs entirely in
userspace as the invoking user and binds to `127.0.0.1:8787` (localhost only) by default.

**macOS note.** The launcher best-effort strips the `com.apple.quarantine` extended
attribute from the extracted bundle so Gatekeeper does not block the bundled `node` binary
on a browser-downloaded tarball. If macOS still balks, either download the tarball with
`curl -fLO <asset-url>` (which does not set the quarantine flag) or clear it manually:

```sh
xattr -dr com.apple.quarantine rinnegan-<os>-<arch>
```

## Configuration

Configuration lives in `config.json` sitting next to the bundle (the launcher passes
`--config <bundle>/config.json` automatically unless you supply your own `--config`).
`users.json` and `state.json` live beside it as well. The file is deep-merged over built-in
defaults, so you only set what you want to change.

| Field | Default | Notes |
| ----- | ------- | ----- |
| `listen.host` | `127.0.0.1` | Bind localhost; put HTTPS in front for exposure |
| `listen.port` | `8787` | |
| `cookie.name` | `rinnegan` | Session cookie (HttpOnly, SameSite=Lax, Path=/) |
| `cookie.secure` | `false` | Set `true` when serving over HTTPS |
| `cookie.ttlSeconds` | `86400` | 24h session; minimum 60 |
| `terminal.shell` | `/usr/bin/env zsh -l` | Split on whitespace into `(file, args)`; no shell quoting |
| `terminal.cwd` | `$HOME` | Omitted from the seed so it defaults to your home directory |
| `terminal.cols` / `rows` | `120` / `36` | Canonical shared grid; every browser renders this size |
| `terminal.autoRestartShell` | `false` | Keep `false`: a dead shell shows a Restart action instead of crash-looping |
| `terminal.env` | `TERM=xterm-256color`, `COLORTERM=truecolor`, `LANG`/`LC_ALL=en_US.UTF-8` | Merged over the server process env |
| `control.mode` | `soft` | `soft` or `fast` (see Control model) |
| `control.staleControllerSeconds` | `120` | Grace period after a controller disconnects |
| `control.requestTimeoutSeconds` | `60` | Pending control-request expiry |
| `buffer.maxBytes` | `2097152` | In-memory replay ring buffer (2 MB); minimum 65536 |
| `usersFile` | `./users.json` | scrypt password records only |
| `stateFile` | `./state.json` | Persists **only** the current control mode; written mode 0600 |

The shell defaults to **`/usr/bin/env zsh -l`**. Note that zsh is not preinstalled on some
minimal Linux distributions (e.g. stock Ubuntu/Debian) — install it there, or point
`terminal.shell` at a shell that exists, for example:

```jsonc
{
  "terminal": { "shell": "/usr/bin/env bash -l" }
}
```

The value is split on whitespace into an executable and its arguments; there is no shell
quoting, so keep arguments simple.

**Session secret.** The HMAC signing secret is regenerated from `crypto.randomBytes` on
every server boot and is not persisted. Restarting the server invalidates all sessions and
everyone re-logs in — a deliberate simplification. The state file keeps only the control
mode; there is no revocation list, and logout clears the cookie.

**Exposing beyond localhost.** Put HTTPS in front (see below) and set `cookie.secure` to
`true` so the session cookie is only sent over TLS.

## Control model

- **Soft mode (default):** you *request* control. The current controller sees the request
  and can Grant or Deny; one pending request at a time (a newer one replaces it), expiring
  after `control.requestTimeoutSeconds` or when the requester disconnects. If nobody holds
  control, a request grants immediately.
- **Fast mode:** any authenticated user takes control instantly; the previous controller
  loses input rights.
- **First connect / controller disconnect:** the first user to connect when there is no
  controller is auto-assigned control. On disconnect, control is reserved for
  `control.staleControllerSeconds` (120s default); reconnecting in time keeps it, otherwise
  control is released.
- **Admins** can additionally take control immediately even in soft mode, force-release the
  current controller, switch fast/soft mode, restart the shell, and kick all connections
  (drops every socket, including their own, with close code 4000).
- The controller (or an admin) resizes the canonical terminal — presets 100×30, 120×36,
  140×42, 160×48, or ±cols/±rows steppers; the server clamps to 20–500 cols and 5–200 rows.
  Every browser re-renders at the new grid. Keyboard input from non-controllers is silently
  ignored server-side.

Because the whole team shares one terminal, viewers render a **fixed canonical grid**
letterboxed into their viewport (largest font size whose cols×rows fits) rather than each
fitting independently — mismatched local sizes would break line wrapping.

## Theme and fonts

The terminal and UI chrome share one palette: **Catppuccin Mocha**, with exact hex values
taken from the kitty config in
[`tanq16/cli-Productivity-Suite`](https://github.com/tanq16/cli-Productivity-Suite) so the
web terminal matches the native terminal setup. Bold cells are not brightened
(`drawBoldTextInBrightColors: false`, matching kitty), and true 24-bit color is enabled end
to end (`COLORTERM=truecolor`). The theme is baked into the frontend and not configurable.

The font is **JetBrains Mono Nerd Font Mono** (the single-cell-icon "Mono" variant),
bundled as woff2 in Regular (400) and Bold (700) weights with a `monospace` fallback — real
bold glyphs and full Nerd Font coverage for powerline prompts and TUIs. The font files are
committed to the repo and shipped inside every tarball, so no font tooling is needed to
build or run.

## CLI

The launcher forwards arguments to the CLI and injects `--config <bundle>/config.json`
automatically when you do not pass `--config` yourself:

```
./bin/rinnegan                              # start the server (default subcommand: serve)
./bin/rinnegan serve                        # start the server explicitly
./bin/rinnegan user add    --username <name> [--role admin|user]
./bin/rinnegan user passwd --username <name>
./bin/rinnegan user list
```

`--role` defaults to `user`. Password prompts are interactive and never echoed. `users.json`
is re-read on every login attempt, so `user add` / `user passwd` take effect on a running
server without a restart.

## Security

**Treat `rinnegan` like SSH access — it is a shell on the machine it runs on.**

- It binds **`127.0.0.1`** (localhost) by default and should stay there unless you put a
  properly authenticated, TLS-terminating proxy in front.
- Authentication is required everywhere. WebSocket upgrades are validated before completing
  and rejected with close code 4401 when unauthenticated.
- Only scrypt password hashes are stored; passwords and session tokens are never logged.
- There is **no login rate limiting**. Do not expose it beyond a trusted network without
  HTTPS and network-level access controls.
- **Change the default `admin` / `changeme` password immediately** after first run.
- `config.json`, `users.json`, and `state.json` should be readable only by the user running
  the process (the seed writes `users.json` with mode 0600).

Recommended shape when exposing it: `browser → Caddy (HTTPS) → localhost-bound rinnegan`.
A minimal Caddyfile:

```caddyfile
terminal.example.com {
  reverse_proxy 127.0.0.1:8787
}
```

Remember to set `cookie.secure: true` in `config.json` when behind HTTPS.

## Build from source (contributors)

Contributors work from a checkout of the repo, not a release tarball:

```sh
git clone https://github.com/tanq16/rinnegan
cd rinnegan
make          # install deps (node-pty compiled from source), vendor assets, verify PTY
npm run dev   # run the dev server against ./config.json, restart on change
```

For local development, copy the example config and create a user:

```sh
cp config.example.json config.json
node bin/rinnegan.js user add --config ./config.json --username admin --role admin
```

`make` uses **fnm** to provide the pinned Node (`.node-version`, 24.17.0) and **uv** to
provide a Python for node-gyp. **`node-pty` is compiled from source**
(`npm_config_build_from_source=true`): Linux ships no prebuilt binary, and the macOS
prebuild's `spawn-helper` lacks the execute bit and fails at runtime with `posix_spawnp
failed` — forcing a source build gives one consistent, working path. `make verify` spawns a
real PTY and fails loudly if the build ever regresses.

The end-to-end suite boots a server and drives it over HTTP + WebSocket:

```sh
node test/e2e.mjs
```

## License

MIT © 2026 Tanishq Rupaal. See [LICENSE](LICENSE).
