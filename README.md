<div align="center">
  <img src=".github/assets/logo.svg" alt="Rinnegan logo" width="250">
  <h1>Rinnegan</h1>

  <a href="https://github.com/Tanq16/rinnegan/actions/workflows/release.yaml"><img alt="Build Workflow" src="https://github.com/Tanq16/rinnegan/actions/workflows/release.yaml/badge.svg"></a>&nbsp;<a href="https://github.com/Tanq16/rinnegan/releases"><img alt="GitHub Release" src="https://img.shields.io/github/v/release/Tanq16/rinnegan"></a><br><br>
  <a href="#features">Features</a> &bull; <a href="#install">Install</a> &bull; <a href="#cli">CLI</a> &bull; <a href="#configuration">Configuration</a> &bull; <a href="#security">Security</a>
</div>

---

A self-hosted **web terminal**. One password, and you get a real shell on the host in your browser. Built to reach the [CLI Productivity Suite](https://github.com/Tanq16/cli-Productivity-Suite) setup from anywhere — homelab or VPS.

Not an IDE, not a tmux manager. A terminal frontend for a box you own.

## Features

- **Password in, shell out** — real interactive shell over WebSocket, sized to your window.
- **A shell per connection** — spawned on demand, dies with the socket. Run `tmux` inside it for persistence.
- **Pick your shell** — zsh, bash, or fish.
- **Themes** — switchable from the control panel, remembered per browser.
- **Port tunnel** — forward a local port to the server over an authenticated WebSocket. `ssh -L` without SSH.
- **File transfer** — upload files, folders, or a clipboard image to `/tmp`; download any host path (directories as `.tar.gz`).
- **Self-contained tarball** — bundles its own Node runtime. No Node, Python, or compiler needed on the host.

## Screenshots

<details>
<summary>Click to expand</summary>

No screenshots yet.

</details>

## Install

Grab the tarball for your platform from [Releases](https://github.com/Tanq16/rinnegan/releases) (Linux and macOS, x64 and arm64).

```sh
tar xf rinnegan-<os>-<arch>.tar.gz
cd rinnegan-<os>-<arch>
./bin/rinnegan passwd    # set the login password
./bin/rinnegan           # serve on 127.0.0.1:8442
```

Open **http://127.0.0.1:8442** and log in. No password is seeded, and `serve` refuses to start without one — use `--no-auth` to skip login entirely (anyone who reaches the port gets a shell).

**Update** with `./update.sh` from the install directory. It verifies the download before swapping it in and leaves `~/.config/rinnegan` alone.

**macOS** may block the bundled `node`. The launcher clears the quarantine flag itself; if it still balks, run `xattr -dr com.apple.quarantine rinnegan-<os>-<arch>`.

### From source

```sh
git clone https://github.com/Tanq16/rinnegan
cd rinnegan
make          # deps, vendored assets, PTY check
npm run dev
```

Needs **fnm** (Node 24.17.0, pinned in `.node-version`) and **uv** (Python for node-gyp). `node-pty` is compiled from source — Linux has no prebuilt, and the macOS prebuild's `spawn-helper` is not executable.

## CLI

```
./bin/rinnegan                              # serve (default)
./bin/rinnegan serve [--no-auth] [--shell zsh|bash|fish]
./bin/rinnegan passwd                       # set the login password
./bin/rinnegan tunnel --server <url> --local <port> --remote <port> [--insecure]
./bin/rinnegan tunnel --config <path> [--insecure]
```

`passwd` takes effect without a restart, and rotating it kills every live session within one access-TTL.

`--shell` takes only `zsh`, `bash`, or `fish`; anything else is a startup error. For anything more, set `terminal.shell` in the config.

`tunnel --config` forwards several ports over one login. Each `ports` entry is `"<local>:<remote>"`, a bare `"<port>"`, or `[<local>, <remote>]`:

```json
{ "server": "https://term.example.com", "ports": ["8080:80", "5432:5432", "3000"] }
```

## Configuration

Everything lives in `~/.config/rinnegan/` (mode 0700). `config.json` is seeded on first run and deep-merged over the defaults, so set only what you change. `auth.json` holds the scrypt password record.

| Field | Default | Notes |
| ----- | ------- | ----- |
| `listen.host` | `127.0.0.1` | Keep it here; put a TLS proxy in front to expose |
| `listen.port` | `8442` | |
| `cookie.name` | `rinnegan` | HttpOnly, SameSite=Lax |
| `cookie.secure` | `false` | Set `true` once TLS is in front |
| `cookie.accessTtlSeconds` | `10800` | 60–604800 |
| `cookie.refreshTtlSeconds` | `604800` | Minimum 60 |
| `terminal.shell` | `/usr/bin/env zsh -l` | Split on whitespace, no shell quoting |
| `terminal.cwd` | `$HOME` | |
| `terminal.cols` / `rows` | `120` / `36` | Fallback only; your viewport normally decides |
| `terminal.env` | `TERM`, `COLORTERM`, `LANG` | Merged over the server env |
| `authFile` | `./auth.json` | Resolved under `~/.config/rinnegan` |

zsh is the default and isn't on every minimal distro — install it or point `terminal.shell` elsewhere.

## Notes

- **Shell lifetime.** A dropped connection kills the shell; there is no reattach. Start `tmux` inside it and reconnect with `tmux attach`.
- **Sessions.** The signing secret is regenerated every boot, so a restart logs everyone out. There is no revocation list.
- **File transfer.** Uploads land in `/tmp` with a random prefix and are never typed into your terminal — the modal shows the path to paste. Nothing is size-capped. Downloads take an absolute host path.
- **Clipboard needs HTTPS.** Browsers gate clipboard access on a secure context, so reading an image from the clipboard and copying the upload path only work over HTTPS or `localhost`.
- **Themes** recolor the page and the terminal's ANSI palette. Programs with their own colorscheme (vim, tmux) are unaffected.
- **Fonts** are JetBrains Mono Nerd Font and Inter, bundled as woff2. Rendering is GPU-accelerated via WebGL, falling back to DOM.

## Security

**Treat it like SSH access — it is a shell on the machine it runs on.**

- Binds `127.0.0.1`. Keep it there unless a TLS proxy is in front.
- One shared password, no accounts. Nothing is attributable, and rotating the password is the only way to revoke access.
- **No login rate limiting.** Don't expose it to the internet without network-level access control.
- `--no-auth` disables authentication completely. Trusted, isolated boxes only.
- Only a scrypt hash is stored; passwords and tokens are never logged.

### Exposing it

Rinnegan serves plain HTTP and terminates no TLS — put your own proxy in front. It needs three things from it: WebSocket upgrades passed through, no request-body cap or read timeout, and `cookie.secure: true` in your config.

See **[docs/exposing.md](docs/exposing.md)** for working Caddy and nginx configs.
