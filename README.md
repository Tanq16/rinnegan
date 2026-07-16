<div align="center">
  <img src=".github/assets/logo.svg" alt="rinnegan logo" width="200">
  <h1>Rinnegan</h1>

  <a href="https://github.com/Tanq16/rinnegan/actions/workflows/release.yaml"><img alt="Build Workflow" src="https://github.com/Tanq16/rinnegan/actions/workflows/release.yaml/badge.svg"></a>&nbsp;<a href="https://github.com/Tanq16/rinnegan/releases"><img alt="GitHub Release" src="https://img.shields.io/github/v/release/Tanq16/rinnegan"></a><br><br>
  <a href="#features">Features</a> &bull; <a href="#screenshots">Screenshots</a> &bull; <a href="#installation-and-usage">Install & Use</a> &bull; <a href="#configuration">Configuration</a> &bull; <a href="#control-model">Control Model</a> &bull; <a href="#split-sessions">Split Sessions</a> &bull; <a href="#file-upload">File Upload</a> &bull; <a href="#security">Security</a>
</div>

---

A minimal self-hosted **shared web terminal**: one server-owned shell PTY, many authenticated browser viewers, and exactly one active keyboard controller at a time. Everyone sees the same live output in their browser; users take or request control to type. The shell behaves like a normal interactive shell on the host — anyone who wants persistence, panes, or long-running workflows starts `tmux` or `zellij` inside it, in the shared session or in a per-user split session (see [Split sessions](#split-sessions)).

It is **not** an IDE, a task manager, or a tmux manager. It is a shared terminal frontend and nothing more. Treat it as a web-based SSH client for multiple users to collaborate in a specific environment. The most common use case is to deploy it on homelab workspaces and cloud VPSs.

## Features

- **Shared, server-owned PTY** — one shell process on the host, streamed live to every connected browser over WebSocket; nobody's local shell state can drift from anyone else's.
- **Exactly one active keyboard controller** — soft mode (request/grant) or fast mode (take instantly); admins can always force control, release it, or switch modes. See [Control model](#control-model).
- **Per-user split sessions** — jump into your own fresh shell on the same host without disturbing the shared terminal, with automatic teardown on disconnect. See [Split sessions](#split-sessions).
- **Host file upload** — bridges the browser clipboard/file-picker to the host filesystem and types the resulting path straight into your terminal. See [File upload](#file-upload).
- **Bundled self-signed HTTPS** — an optional `serve --https` mode runs Caddy as a managed child process to terminate TLS on the network with zero extra downloads.
- **Self-contained per-platform tarball** — each release bundles its own Node runtime and a platform-native `node-pty`; the host needs no Node, python, compiler, or `make`.
- **Password + ephemeral-session auth** — scrypt-hashed passwords, HMAC-signed session cookies with a per-boot secret, and no persisted revocation list.

## Screenshots

<details>
<summary>Click to expand screenshots</summary>

No screenshots yet — this section will be filled in with real captures of the shared terminal, control panel, and split-session chooser in a future update.

</details>

## Installation and Usage

rinnegan is a single process you launch and it serves the shared terminal over HTTP and WebSocket. Point a browser at the address it prints.

### Tarball (recommended)

Grab the tarball for your OS/architecture from the [GitHub Releases](https://github.com/Tanq16/rinnegan/releases) page:

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

Then open **http://127.0.0.1:8442** in your browser and log in with the seeded account:

- username: `admin`
- password: `changeme`

**Change the default password immediately** — this is a shell on your machine:

```sh
./bin/rinnegan user passwd --username admin
```

You will be prompted for the new password (input is never echoed). It takes effect on the next login without restarting the server. `./bin/rinnegan` with no subcommand runs the server (equivalent to `./bin/rinnegan serve`).

Each tarball also ships **the Caddy binary** at `bin/caddy` for optional bundled HTTPS (see [HTTPS on the network](#https-on-the-network)) and third-party licenses under `licenses/` (Node and Caddy). It runs entirely in userspace as the invoking user and binds to `127.0.0.1:8442` (localhost only) by default.

**macOS note.** The launcher best-effort strips the `com.apple.quarantine` extended attribute from the extracted bundle so Gatekeeper does not block the bundled `node` binary on a browser-downloaded tarball. If macOS still balks, either download the tarball with `curl -fLO <asset-url>` (which does not set the quarantine flag) or clear it manually:

```sh
xattr -dr com.apple.quarantine rinnegan-<os>-<arch>
```

#### HTTPS quickstart

To serve over HTTPS on the network, run the bundled Caddy wrapper instead:

```sh
./bin/rinnegan serve --https
```

This starts a bundled Caddy that terminates TLS on `:8443` and reverse-proxies to the localhost rinnegan server. Then browse to **https://\<host\>:8443**, accept the one-time self-signed certificate warning, and log in with the same seeded account. In this mode `cookie.secure` is set to `true` automatically, since all real traffic arrives over TLS via Caddy. See [HTTPS on the network](#https-on-the-network) for details.

### From source (contributors)

Contributors work from a checkout of the repo, not a release tarball:

```sh
git clone https://github.com/Tanq16/rinnegan
cd rinnegan
make          # install deps (node-pty compiled from source), vendor assets, verify PTY
npm run dev   # run the dev server against ./config.json, restart on change
```

For local development, copy the example config and create a user:

```sh
cp config.example.json config.json
node bin/rinnegan.js user add --config ./config.json --username admin --role admin
```

`make` uses **fnm** to provide the pinned Node (`.node-version`, 24.17.0) and **uv** to provide a Python for node-gyp. **`node-pty` is compiled from source** (`npm_config_build_from_source=true`): Linux ships no prebuilt binary, and the macOS prebuild's `spawn-helper` lacks the execute bit and fails at runtime with `posix_spawnp failed` — forcing a source build gives one consistent, working path. `make verify` spawns a real PTY and fails loudly if the build ever regresses.

The end-to-end suite boots a server and drives it over HTTP + WebSocket:

```sh
node test/e2e.mjs
```

## Configuration

Configuration lives in `config.json` sitting next to the bundle (the launcher passes `--config <bundle>/config.json` automatically unless you supply your own `--config`). `users.json` and `state.json` live beside it as well. The file is deep-merged over built-in defaults, so you only set what you want to change.

| Field | Default | Notes |
| ----- | ------- | ----- |
| `listen.host` | `127.0.0.1` | Bind localhost; put HTTPS in front for exposure |
| `listen.port` | `8442` | |
| `cookie.name` | `rinnegan` | Session cookie (HttpOnly, SameSite=Lax, Path=/) |
| `cookie.secure` | `false` | Set `true` when serving over HTTPS; auto-forced to `true` under `serve --https` |
| `cookie.ttlSeconds` | `86400` | 24h session; minimum 60 |
| `terminal.shell` | `/usr/bin/env zsh -l` | Split on whitespace into `(file, args)`; no shell quoting |
| `terminal.cwd` | `$HOME` | Omitted from the seed so it defaults to your home directory |
| `terminal.cols` / `rows` | `120` / `36` | Initial shared grid, used only until the first viewer attaches; after that the grid follows the smallest attached viewer (see [Control model](#control-model)) |
| `terminal.autoRestartShell` | `false` | Keep `false`: a dead shell shows a Restart action instead of crash-looping |
| `terminal.env` | `TERM=xterm-256color`, `COLORTERM=truecolor`, `LANG`/`LC_ALL=en_US.UTF-8` | Merged over the server process env |
| `control.mode` | `soft` | `soft` or `fast` (see [Control model](#control-model)) |
| `control.staleControllerSeconds` | `120` | Grace period after a controller disconnects |
| `control.requestTimeoutSeconds` | `60` | Pending control-request expiry |
| `buffer.maxBytes` | `2097152` | In-memory replay ring buffer (2 MB); minimum 65536 |
| `usersFile` | `./users.json` | scrypt password records only |
| `stateFile` | `./state.json` | Persists **only** the current control mode; written mode 0600 |

The shell defaults to **`/usr/bin/env zsh -l`**. Note that zsh is not preinstalled on some minimal Linux distributions (e.g. stock Ubuntu/Debian) — install it there, or point `terminal.shell` at a shell that exists, for example:

```jsonc
{
  "terminal": { "shell": "/usr/bin/env bash -l" }
}
```

The value is split on whitespace into an executable and its arguments; there is no shell quoting, so keep arguments simple.

**Session secret.** The HMAC signing secret is regenerated from `crypto.randomBytes` on every server boot and is not persisted. Restarting the server invalidates all sessions and everyone re-logs in — a deliberate simplification. The state file keeps only the control mode; there is no revocation list, and logout clears the cookie.

**Exposing beyond localhost.** Put HTTPS in front (see below) and set `cookie.secure` to `true` so the session cookie is only sent over TLS.

## Control model

- **Soft mode (default):** you *request* control. The current controller sees the request and can Grant or Deny; one pending request at a time (a newer one replaces it), expiring after `control.requestTimeoutSeconds` or when the requester disconnects. If nobody holds control, a request grants immediately.
- **Fast mode:** any authenticated user takes control instantly; the previous controller loses input rights.
- **First join / controller disconnect:** the first user to join the shared session when there is no controller is auto-assigned control. On disconnect, control is reserved for `control.staleControllerSeconds` (120s default); re-attaching to the shared session in time keeps it, otherwise control is released — reconnecting only as far as the lobby chooser does not hold the reservation.
- **Admins** can additionally take control immediately even in soft mode, force-release the current controller, switch fast/soft mode, restart the shell, and kick all connections (drops every socket, including their own, with close code 4000).
- Keyboard input from non-controllers is silently ignored server-side.

Because the whole team shares one terminal, everyone must agree on one grid — mismatched local sizes would break line wrapping. Sizing works the way tmux sizes a session to its smallest attached client: every browser renders at a **fixed font size** (browser zoom is your scaling control, exactly like a native terminal emulator), reports the grid that fits its own window, and the shared terminal sizes itself to the **smallest attached viewer's grid**. The smallest viewer fills their window; for everyone else the leftover space is painted in the terminal background color, so it reads as terminal padding (the way kitty pads a window that isn't an exact multiple of the cell size) rather than a letterbox border. Joining from a small window shrinks the shared grid for everyone — deliberate, tmux-style. `terminal.cols`/`rows` in the config are only the initial grid before the first viewer ever attaches. Split sessions do not use the shared grid — they size to your own viewport like a normal terminal emulator.

## Split sessions

Every connection starts in a **lobby**: after login you choose **Shared session** or **Split session**, and nothing is shown until you pick. When a split shell exits you land back at the chooser (with a note that the shell exited) rather than being dropped into the shared session — the explicit Shared button while split still switches directly. An automatic reconnect after a network blip silently rejoins the shared session you were in; a fresh page load always starts at the chooser.

**Leave session** (in the Control panel) returns you to the chooser from either mode. Leaving the shared session only detaches *you* — the shared shell is server-owned and keeps running for everyone else, so it is there when you rejoin. Leaving a split ends that split shell, exactly like exiting it or switching to Shared.

A **split** gives you your own fresh shell on the same host while everyone else keeps the shared terminal. Splitting releases control immediately if you held it, and typing in your split never requires control — it is your shell. Keystrokes never cross sessions: input is tagged with the session it was typed into, and anything still in flight when a switch happens (including the drop back to the lobby when a split shell exits) is dropped rather than delivered to a session you were not looking at.

The split shell lives only as long as you are attached to it: switching back to Shared, closing the tab, or losing the connection kills it immediately, and the server keeps no record of it — no scrollback, no reattach, nothing to clean up. Durability is tmux's job, not rinnegan's. Start `tmux` inside your split: the tmux server daemonizes out of the split shell's process tree, so it survives the split shell's death, and reconnect → Split → `tmux attach` resumes your work where you left it. rinnegan deliberately knows nothing about tmux.

A split is *your own shell*, not your own environment: it runs as the same OS user as the shared session, with the same filesystem and visible processes. It is not a sandbox — treat it with the same care as the shared shell.

## File upload

`Ctrl-V` in a browser terminal can't reach a CLI that reads the *host's* clipboard — a pasted image is in your browser, not on the box the shell (or an SSH hop from it) runs on. The Control panel's **Upload file** button bridges that gap. It opens a small chooser with two sources:

- **From clipboard** — grabs an image off your clipboard (needs a secure context, i.e. the HTTPS setup below or `localhost`).
- **Choose file…** — a normal file picker for any file.

The file is streamed over the WebSocket (chunked, 25 MB cap) and written to `/tmp` on the host as `/tmp/<5-random-lowercase-alnum>-<name>` with mode `0600`. The random prefix keeps repeats unique; the original name is reduced to a bare basename in `[A-Za-z0-9._-]` (no path separators, no leading dots, no traversal, no shell metacharacters, truncated to 100 chars) so the path is safe to use unquoted. rinnegan never deletes these — `/tmp` is the OS's to reap.

Once the file lands, its path is **typed into your terminal at the cursor with a trailing space and no Enter**, so a tool like [Claude Code](https://claude.com/claude-code) reads the image (it auto-detects image paths) and you can still add a prompt before submitting. In the shared session this needs control (it types into the shared shell); without it — or from the lobby — the path is shown and copied to your clipboard instead, so you can place it yourself.

## Theme and fonts

The terminal and UI chrome share one palette: **Catppuccin Mocha**, with exact hex values taken from the kitty config in [`Tanq16/cli-Productivity-Suite`](https://github.com/Tanq16/cli-Productivity-Suite) so the web terminal matches the native terminal setup. Bold cells are not brightened (`drawBoldTextInBrightColors: false`, matching kitty), and true 24-bit color is enabled end to end (`COLORTERM=truecolor`). The theme is baked into the frontend and not configurable. The cursor is locked to a steady rosewater beam, matching kitty's `cursor_shape beam` and `cursor_blink_interval 0`: color-set escapes (OSC 10/11/12) are filtered out and DECSCUSR blink bits are stripped, so nothing run inside a shell can recolor the cursor or make it blink.

The terminal is set in **JetBrains Mono Nerd Font Mono** (the single-cell-icon "Mono" variant), bundled as woff2 in Regular (400) and Bold (700) weights with a `monospace` fallback — real bold glyphs and full Nerd Font coverage for powerline prompts and TUIs. UI chrome (login, the lobby, session controls) is set in **Inter** (400/600), also bundled as woff2. All font files are committed to the repo and shipped inside every tarball, so no font tooling is needed to build or run.

## CLI

The launcher forwards arguments to the CLI and injects `--config <bundle>/config.json` automatically when you do not pass `--config` yourself:

```
./bin/rinnegan                              # start the server (default subcommand: serve)
./bin/rinnegan serve                        # start the server explicitly
./bin/rinnegan user add    --username <name> [--role admin|user]
./bin/rinnegan user passwd --username <name>
./bin/rinnegan user list
```

`--role` defaults to `user`. Password prompts are interactive and never echoed. `users.json` is re-read on every login attempt, so `user add` / `user passwd` take effect on a running server without a restart.

## Security

**Treat `rinnegan` like SSH access — it is a shell on the machine it runs on.**

- It binds **`127.0.0.1`** (localhost) by default and should stay there unless you put a properly authenticated, TLS-terminating proxy in front.
- Authentication is required everywhere. WebSocket upgrades are validated before completing and rejected with close code 4401 when unauthenticated.
- Only scrypt password hashes are stored; passwords and session tokens are never logged.
- There is **no login rate limiting**. Do not expose it beyond a trusted network without HTTPS and network-level access controls.
- **Change the default `admin` / `changeme` password immediately** after first run.
- `config.json`, `users.json`, and `state.json` should be readable only by the user running the process (the seed writes `users.json` with mode 0600).

Recommended shape when exposing it: `browser → Caddy (HTTPS) → localhost-bound rinnegan`. The fastest way to get there is the bundled `serve --https` wrapper described below.

## HTTPS on the network

Each tarball bundles **Caddy 2.11.4** (Apache-2.0; its license is shipped at `licenses/caddy-LICENSE`) so you can serve HTTPS on the network with no extra downloads.

```sh
./bin/rinnegan serve --https
```

This runs Caddy as a **managed child process**: it listens on `0.0.0.0:8443` and reverse-proxies to `127.0.0.1:8442`, so rinnegan itself stays localhost-only and is never directly network-exposed. Browse to **https://\<host\>:8443** and log in.

- **Self-signed certificate.** Caddy issues the certificate from its own internal CA, so browsers show a **one-time warning** you accept once per client. There is no way to remove that warning without installing the CA on every client machine, which is out of scope here.
- **Self-contained state.** Caddy's state (its CA and issued certificates) is stored in a `caddy-data/` directory inside the bundle via `XDG_DATA_HOME`/`XDG_CONFIG_HOME`, keeping it fully self-contained. To regenerate the CA, delete `caddy-data/` and restart.
- **Changing the port.** If you change `listen.port` in `config.json`, you must edit the bundled `Caddyfile` so its `reverse_proxy` target matches. `serve --https` also prints a warning if `listen.port` is not the expected `8442`.
- **Edge hardening.** The bundled `Caddyfile` adds a few defense-in-depth measures at the proxy: a 4 MB request-body cap, `read_header` (10s) / `read_body` (30s) timeouts to blunt slowloris, and response headers `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, and `Referrer-Policy: no-referrer` (plus stripping the `Server` header). Write/idle timeouts are deliberately omitted so long-lived WebSocket streams are not torn down.
- **Still no rate limiting.** There is still **no login rate limiting** — keep it on a trusted network even over HTTPS.

Under `--https`, `cookie.secure` is forced to `true` automatically, since all real traffic arrives over TLS via Caddy.

If you prefer, rinnegan and Caddy can also run as **two separate processes**: run `./bin/rinnegan serve`, then in another shell run `./bin/caddy` manually with `XDG_DATA_HOME` pointed at a local directory (and `XDG_CONFIG_HOME` alongside it).

### Bring-your-own domain with a real certificate

The bundled `--https` path uses a self-signed certificate. If instead you have a **public domain** and want a **real, browser-trusted certificate**, run rinnegan localhost-only and put your own Caddy in front for that domain. A minimal Caddyfile:

```caddyfile
terminal.example.com {
  reverse_proxy 127.0.0.1:8442
}
```

Remember to set `cookie.secure: true` in `config.json` when behind HTTPS this way.
