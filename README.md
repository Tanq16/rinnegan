<div align="center">
  <img src=".github/assets/logo.svg" alt="Rinnegan logo" width="250">
  <h1>Rinnegan</h1>

  <a href="https://github.com/Tanq16/rinnegan/actions/workflows/release.yaml"><img alt="Build Workflow" src="https://github.com/Tanq16/rinnegan/actions/workflows/release.yaml/badge.svg"></a>&nbsp;<a href="https://github.com/Tanq16/rinnegan/releases"><img alt="GitHub Release" src="https://img.shields.io/github/v/release/Tanq16/rinnegan"></a><br><br>
  <a href="#features">Features</a> &bull; <a href="#screenshots">Screenshots</a> &bull; <a href="#installation-and-usage">Install & Use</a> &bull; <a href="#configuration">Configuration</a> &bull; <a href="#how-it-works">How It Works</a>
</div>

---

A minimal self-hosted **shared web terminal**: one server-owned shell PTY, many authenticated browser viewers, and exactly one active keyboard controller at a time. Everyone sees the same live output; users take or request control to type. The shell is a normal interactive shell on the host — for persistence, panes, or long-running work, start `tmux` or `zellij` inside it, in the shared session or a per-user [split session](#split-sessions).

It is **not** an IDE, a task manager, or a tmux manager — just a shared terminal frontend, like a web-based SSH client for a small trusted team collaborating in one environment. The common use case is a homelab workspace or a cloud VPS.

## Features

- **Shared, server-owned PTY** — one shell process on the host, streamed live to every browser over WebSocket; no one's local state drifts.
- **Exactly one keyboard controller** — soft (request/grant) or fast (take instantly); admins can force, release, or switch modes. See [Control](#control).
- **Per-user split sessions** — your own fresh shell on the same host without disturbing the shared terminal, torn down on disconnect. See [Split sessions](#split-sessions).
- **Host file transfer** — upload a clipboard image, a file, or a whole folder to `/tmp` over HTTP and get the path to paste (nothing is typed into your terminal); download any host file or directory, directories as `.tar.gz`. See [File transfer](#file-transfer).
- **Bundled self-signed HTTPS** — optional `serve --https` runs Caddy as a managed child to terminate TLS, with zero extra downloads.
- **Self-contained tarball** — each release bundles its own Node runtime and a platform-native `node-pty`; the host needs no Node, Python, compiler, or `make`.
- **Password + ephemeral-session auth** — scrypt-hashed passwords, HMAC-signed cookies with a per-boot secret, no persisted revocation list.

## Screenshots

<details>
<summary>Click to expand screenshots</summary>

No screenshots yet — this section will be filled in with real captures of the shared terminal, control panel, and split-session chooser in a future update.

</details>

## Installation and Usage

Rinnegan is a single process you launch; it serves the shared terminal over HTTP and WebSocket. Point a browser at the address it prints. Grab the tarball for your platform from [Releases](https://github.com/Tanq16/rinnegan/releases) (Linux and macOS, x64 and arm64; no Windows build), then:

```sh
tar xf rinnegan-<os>-<arch>.tar.gz
cd rinnegan-<os>-<arch>
./bin/rinnegan
```

Open **http://127.0.0.1:8442** and log in with the seeded `admin` / `changeme` account. `./bin/rinnegan` with no subcommand runs the server (same as `serve`); it binds `127.0.0.1:8442` and runs as the invoking user. Each tarball is self-contained — its own Node runtime, a platform-native `node-pty`, the `bin/caddy` binary for [HTTPS](#serving-over-https), and third-party licenses under `licenses/` — so the host needs no Node, Python, compiler, or `make`.

**Change the default password immediately** — this is a shell on your machine:

```sh
./bin/rinnegan user passwd --username admin
```

It takes effect on the next login without a restart (input is never echoed).

**macOS.** The launcher best-effort strips `com.apple.quarantine` from the extracted bundle so Gatekeeper doesn't block the bundled `node`. If macOS still balks, download with `curl -fLO <asset-url>` or clear it manually:

```sh
xattr -dr com.apple.quarantine rinnegan-<os>-<arch>
```

### From source

Contributors work from a checkout, not a tarball:

```sh
git clone https://github.com/Tanq16/rinnegan
cd rinnegan
make          # install deps (node-pty from source), vendor assets, verify PTY
node bin/rinnegan.js user add --username admin --role admin
npm run dev   # dev server reading ~/.config/rinnegan, restart on change
```

`make` uses **fnm** for the pinned Node (`.node-version`, 24.17.0) and **uv** for a node-gyp Python. `node-pty` is compiled from source (`npm_config_build_from_source=true`): Linux ships no prebuilt binary, and the macOS prebuild's `spawn-helper` lacks the execute bit and fails at runtime with `posix_spawnp failed`. `make verify` spawns a real PTY and fails loudly on regression. The end-to-end suite (`node test/e2e.mjs`) boots a server and drives it over HTTP + WebSocket.

## Configuration

All state lives in **`~/.config/rinnegan/`** (created mode 0700, regardless of the process working directory): `config.json` is self-seeded from the built-in defaults on first run (mode 0600), `users.json` is operator-created via [`user add`](#cli) and never auto-seeded (mode 0600), and `state.json` (plus `caddy-data/` under `serve --https`) sits alongside. `config.json` is deep-merged over the built-in defaults, so set only what you change.

| Field | Default | Notes |
| ----- | ------- | ----- |
| `listen.host` | `127.0.0.1` | Bind localhost; put HTTPS in front for exposure |
| `listen.port` | `8442` | |
| `cookie.name` | `rinnegan` | Session cookie (HttpOnly, SameSite=Lax, Path=/) |
| `cookie.secure` | `false` | Set `true` over HTTPS; auto-forced under `serve --https` |
| `cookie.ttlSeconds` | `86400` | 24h session; minimum 60 |
| `terminal.shell` | `/usr/bin/env zsh -l` | Split on whitespace into `(file, args)`; no shell quoting |
| `terminal.cwd` | `$HOME` | Falls back to your home directory when unset |
| `terminal.cols` / `rows` | `120` / `36` | Initial shared grid until the first viewer attaches; after that it follows the smallest attached viewer (see [Control](#control)) |
| `terminal.autoRestartShell` | `false` | Keep `false`: a dead shell shows a Restart action instead of crash-looping |
| `terminal.env` | `TERM`, `COLORTERM`, `LANG`/`LC_ALL` | Merged over the server process env |
| `control.mode` | `soft` | `soft` or `fast` (see [Control](#control)) |
| `control.staleControllerSeconds` | `120` | Grace period after a controller disconnects |
| `control.requestTimeoutSeconds` | `60` | Pending control-request expiry |
| `buffer.maxBytes` | `2097152` | In-memory replay ring buffer (2 MB); minimum 65536 |
| `usersFile` | `./users.json` | scrypt password records; resolved under `~/.config/rinnegan` |
| `stateFile` | `./state.json` | Persists **only** the current control mode; resolved under `~/.config/rinnegan`, written mode 0600 |

- **Shell.** Defaults to `/usr/bin/env zsh -l`; zsh isn't preinstalled on some minimal Linux distros, so install it or point `terminal.shell` at an existing shell (e.g. `/usr/bin/env bash -l`). The value is split on whitespace into executable + args with no shell quoting, so keep args simple.
- **Session secret.** The HMAC signing secret is regenerated on every boot and never persisted — restarting invalidates all sessions and everyone re-logs in (deliberate; there is no revocation list). The state file keeps only the control mode.
- **Exposing beyond localhost.** Put HTTPS in front (see [Security](#security)) and set `cookie.secure: true`.

## How it works

### Control

- **Soft mode (default):** you *request* control; the current controller Grants or Denies. One pending request at a time (a newer one replaces it), expiring after `control.requestTimeoutSeconds` or when the requester disconnects. With no controller, a request grants immediately.
- **Fast mode:** any authenticated user takes control instantly; the previous controller loses input.
- **First join / disconnect:** the first user to join the shared session with no controller is auto-assigned control. On disconnect it is reserved for `control.staleControllerSeconds` (120s); re-attaching to the *shared session* in time keeps it, otherwise it is released (sitting in the lobby chooser does not hold it).
- **Admins** can take control immediately even in soft mode, force-release the controller, switch mode, restart the shell, and kick all connections (close code 4000, including their own).
- Non-controller keyboard input is silently ignored server-side.

The whole team shares one grid, sized like tmux to its smallest attached client: every browser renders at a fixed font size (use browser zoom to scale), reports the grid that fits its window, and the shared terminal sizes to the smallest viewer's grid. That viewer fills their window; for everyone else the leftover space is painted in the terminal background as padding, not a letterbox. Joining from a small window shrinks the grid for everyone — deliberate. `terminal.cols`/`rows` are only the initial grid before the first viewer attaches; split sessions size to your own viewport instead.

### Split sessions

A **split** gives you your own fresh shell on the same host while everyone else keeps the shared terminal.

- Every connection starts in a **lobby**: after login you pick **Shared** or **Split**; nothing shows until you choose. A split shell exit returns you to the chooser (noting the exit); an auto-reconnect after a network blip silently rejoins the shared session; a fresh page load always starts at the chooser.
- **Leave session** (Control panel) returns you to the chooser from either mode. Leaving Shared detaches only *you* — the server-owned shell keeps running for everyone else. Leaving a split ends that shell.
- Splitting releases control immediately if you held it, and typing in your split never needs control. Keystrokes never cross sessions: input is tagged with its session, and anything in flight during a switch is dropped, not misdelivered.
- A split lives only while you are attached — switching to Shared, closing the tab, or losing the connection kills it, with no scrollback or reattach. Durability is tmux's job: start `tmux` inside a split and it daemonizes out of the split's process tree, so reconnect → Split → `tmux attach` resumes your work.
- It is your own *shell*, not a sandbox: same OS user, filesystem, and visible processes as the shared session. Treat it with the same care.

### File transfer

`Ctrl-V` in a browser terminal can't reach a CLI that reads the *host's* clipboard — a pasted image is in your browser, not on the box the shell runs on. The Control panel's **Files** panel bridges both directions over plain HTTP; the WebSocket carries terminal traffic only.

**Upload** — `Upload…` offers three sources:

- **From clipboard** — grabs an image off your clipboard (needs a secure context: HTTPS or `localhost`).
- **Choose file…** — a normal file picker for any file.
- **Choose folder…** — a directory picker; every file in the tree goes up, one at a time.

Bytes are streamed to disk with a `POST`, with **no size cap** and a live progress bar you can hide or cancel. A single file lands at `/tmp/<5-random-alnum>-<name>` mode `0600`; the name is reduced to a bare basename in `[A-Za-z0-9._-]` (no separators, leading dots, traversal, or shell metacharacters; ≤100 chars) so the path is safe unquoted. A folder lands under `/tmp/<5-random-alnum>-<folder>/` with its relative tree preserved and each segment sanitized the same way — it is copy-the-files, not archive, so empty directories, symlinks, and permissions are not carried. A cancelled or failed upload's partial temp file is deleted; completed uploads are never deleted by rinnegan — `/tmp` is the OS's to reap. Upload needs only a login: no terminal control, and it works from the lobby.

**Nothing is typed into your terminal.** The modal shows the finished path and copies it when the clipboard API is available (HTTPS or `localhost`); otherwise it says so and you select it. Paste it into a tool like [Claude Code](https://claude.com/claude-code) yourself — one `Cmd-V`, and you choose when and where.

**Download** — give the Files panel an absolute host path. It probes the path first, so a typo shows a real in-app error instead of a cryptic browser failure, then hands off to your browser's own download manager. A single file streams with real progress; a directory streams as `<dir>.tar.gz` (`tar xzf` it on the other end). Any logged-in user can download anything the server user can read — parity with the shell they already have (see [Security](#security)). Every upload and download is logged server-side with the user and the path.

### Theme and fonts

- **Palette:** Catppuccin Mocha, hex values taken from the kitty config in [`Tanq16/cli-Productivity-Suite`](https://github.com/Tanq16/cli-Productivity-Suite) so the web terminal matches the native setup. Bold cells are not brightened (matching kitty); true 24-bit color is enabled end to end. Baked in, not configurable.
- **Cursor:** locked to a steady rosewater beam (kitty's `cursor_shape beam`, no blink) — OSC 10/11/12 color escapes are filtered and DECSCUSR blink bits stripped, so nothing run in the shell can recolor it or make it blink.
- **Fonts:** terminal in **JetBrains Mono Nerd Font Mono** (single-cell "Mono" variant, 400/700), UI in **Inter** (400/600), both bundled as woff2 with a `monospace` fallback. All font files are committed and shipped in every tarball, so no font tooling is needed to build or run.

### CLI

The launcher forwards its arguments straight to the bundled server:

```
./bin/rinnegan                              # start the server (default: serve)
./bin/rinnegan serve                        # start the server explicitly
./bin/rinnegan user add    --username <name> [--role admin|user]
./bin/rinnegan user passwd --username <name>
./bin/rinnegan user list
```

`--role` defaults to `user`; password prompts are never echoed. `users.json` is re-read on every login, so `user add`/`user passwd` take effect on a running server without a restart.

### Security

**Treat rinnegan like SSH access — it is a shell on the machine it runs on.**

- Binds **`127.0.0.1`** by default; keep it there unless a properly authenticated, TLS-terminating proxy is in front.
- Auth is required everywhere; WebSocket upgrades are validated before completing and rejected with close code 4401 when unauthenticated.
- Only scrypt password hashes are stored; passwords and session tokens are never logged.
- **No login rate limiting** — do not expose beyond a trusted network without HTTPS and network-level access controls.
- **Change the default `admin` / `changeme` password immediately.**
- `~/.config/rinnegan` and its `config.json`, `users.json`, and `state.json` should be readable only by the running user (rinnegan creates the directory mode 0700 and those files mode 0600).

Recommended shape when exposing it: `browser → Caddy (HTTPS) → localhost-bound rinnegan`. The bundled wrapper below is the fastest way there.

#### Serving over HTTPS

```sh
./bin/rinnegan serve --https
```

Each tarball bundles **Caddy 2.11.4** (Apache-2.0; license at `licenses/caddy-LICENSE`). This runs Caddy as a **managed child process** listening on `0.0.0.0:8443` and reverse-proxying to `127.0.0.1:8442`, so rinnegan itself stays localhost-only. Browse to **https://\<host\>:8443**, accept the one-time self-signed warning, and log in. `cookie.secure` is forced to `true` in this mode.

- **Certificate:** issued by Caddy's internal CA, so browsers warn once per client; removing the warning means installing the CA on every client (out of scope).
- **State:** Caddy's CA and certs live in `~/.config/rinnegan/caddy-data/` (via `XDG_DATA_HOME`/`XDG_CONFIG_HOME`); delete it and restart to regenerate the CA.
- **Ports:** if you change `listen.port`, edit the bundled `Caddyfile` so its `reverse_proxy` target matches (`serve --https` warns if the port is not `8442`).
- **Edge hardening:** the `Caddyfile` adds a `read_header` (10s) timeout, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, and strips `Server`. Request bodies are unbounded and untimed so [file transfer](#file-transfer) works through the HTTPS front; write/idle timeouts are omitted so long-lived WebSocket streams are not torn down.
- **Still no rate limiting** even over HTTPS — keep it on a trusted network.

rinnegan and Caddy can also run as two separate processes: `./bin/rinnegan serve`, then `./bin/caddy` with `XDG_DATA_HOME`/`XDG_CONFIG_HOME` pointed at a local directory.

#### Bring your own domain

The bundled `--https` path is self-signed. For a public domain with a real, browser-trusted certificate, run rinnegan localhost-only and put your own Caddy in front:

```caddyfile
terminal.example.com {
  reverse_proxy 127.0.0.1:8442
}
```

Set `cookie.secure: true` in `config.json` when behind HTTPS this way.
