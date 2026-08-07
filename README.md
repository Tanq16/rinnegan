<div align="center">
  <img src=".github/assets/logo.svg" alt="Rinnegan logo" width="250">
  <h1>Rinnegan</h1>

  <a href="https://github.com/Tanq16/rinnegan/actions/workflows/release.yaml"><img alt="Build Workflow" src="https://github.com/Tanq16/rinnegan/actions/workflows/release.yaml/badge.svg"></a>&nbsp;<a href="https://github.com/Tanq16/rinnegan/releases"><img alt="GitHub Release" src="https://img.shields.io/github/v/release/Tanq16/rinnegan"></a><br><br>
  <a href="#features">Features</a> &bull; <a href="#install">Install</a> &bull; <a href="#cli">CLI</a> &bull; <a href="#configuration">Configuration</a> &bull; <a href="#security">Security</a>
</div>

---

Rinnegan is a self-hosted web terminal. One password gets you a real interactive shell on the host, in your browser.

It exists to reach a [CLI Productivity Suite](https://github.com/Tanq16/cli-Productivity-Suite) setup from anywhere, on a homelab box or a VPS. It is not an IDE or a tmux manager, and it is a terminal frontend for a machine you already own.

## Features

- **Password in, shell out**: one password on the login page gives you a real interactive shell over WebSocket, sized to your window.
- **A shell per connection**: every browser connection spawns its own shell, which dies when the socket closes.
- **Pick your shell**: rinnegan starts zsh, bash, or fish.
- **Fifteen themes**: the control panel switches between the same palettes `cps theme` deploys to kitty, and each browser remembers its own choice.
- **Port tunnel**: rinnegan forwards a local port to the server over an authenticated WebSocket, the way `ssh -L` does without SSH.
- **File transfer**: you upload files, folders, or a clipboard image to `/tmp`, and download any host path.
- **Self-contained tarball**: every release bundles its own Node runtime, so the host needs no Node, Python, or compiler.

## Screenshots

<details>
<summary>Click to expand</summary>

There are no screenshots yet.

</details>

## Install

Download the tarball for your platform from [Releases](https://github.com/Tanq16/rinnegan/releases). Builds cover Linux and macOS on x64 and arm64.

```sh
tar xf rinnegan-<os>-<arch>.tar.gz
cd rinnegan-<os>-<arch>
./bin/rinnegan passwd    # set the login password
./bin/rinnegan           # serve on 127.0.0.1:8442
```

Open **http://127.0.0.1:8442** and log in. No password is seeded on first run, and `serve` refuses to start until you set one. Passing `--no-auth` skips the login page entirely, which hands a shell to anyone who reaches the port.

**Updating**: run `./update.sh` from the install directory. It verifies the download before swapping it in, and it leaves `~/.config/rinnegan` untouched.

**macOS**: Gatekeeper may block the bundled `node`. The launcher clears the quarantine flag on startup, and you can clear it yourself with `xattr -dr com.apple.quarantine rinnegan-<os>-<arch>`.

### From source

```sh
git clone https://github.com/Tanq16/rinnegan
cd rinnegan
make          # deps, vendored assets, PTY check
npm run dev
```

The build needs **fnm** for the pinned Node in `.node-version` and **uv** for the Python that node-gyp calls. It compiles `node-pty` from source, because Linux ships no prebuilt binary and the macOS prebuild's `spawn-helper` is not executable.

`scripts/gen-themes.mjs` regenerates the palettes from a [CLI Productivity Suite](https://github.com/Tanq16/cli-Productivity-Suite) checkout. Pass it the theme directory plus `css` for the `public/styles.css` blocks, `html` for the dropdown, or no argument for a contrast audit.

## CLI

```
./bin/rinnegan                              # serve (default)
./bin/rinnegan serve [--no-auth] [--shell zsh|bash|fish]
./bin/rinnegan passwd                       # set the login password
./bin/rinnegan tunnel --server <url> --local <port> --remote <port> [--insecure]
./bin/rinnegan tunnel --config <path> [--insecure]
```

`passwd` takes effect on a running server without a restart. Rotating the password kills every live session within one access-TTL.

`--shell` accepts only `zsh`, `bash`, or `fish`, and anything else is a startup error. Set `terminal.shell` in the config for any other command.

`tunnel --config` forwards several ports over a single login. Each `ports` entry is `"<local>:<remote>"`, a bare `"<port>"`, or `[<local>, <remote>]`.

```json
{ "server": "https://term.example.com", "ports": ["8080:80", "5432:5432", "3000"] }
```

## Configuration

All state lives in `~/.config/rinnegan/`, created mode 0700. `config.json` is seeded on first run and deep-merged over the defaults, so you set only what you change. `auth.json` holds the scrypt password record.

| Field | Default | Notes |
| ----- | ------- | ----- |
| `listen.host` | `127.0.0.1` | Keep it here, and put a TLS proxy in front to expose it |
| `listen.port` | `8442` | |
| `cookie.name` | `rinnegan` | HttpOnly, SameSite=Lax |
| `cookie.secure` | `false` | Set it to `true` once TLS is in front |
| `cookie.accessTtlSeconds` | `10800` | Accepts 60 to 604800 |
| `cookie.refreshTtlSeconds` | `604800` | Minimum is 60 |
| `terminal.shell` | `/usr/bin/env zsh -l` | Split on whitespace, with no shell quoting |
| `terminal.cwd` | `$HOME` | |
| `terminal.cols` / `rows` | `120` / `36` | A fallback grid, since your viewport normally decides |
| `terminal.env` | `TERM`, `COLORTERM`, `LANG` | Merged over the server env |
| `authFile` | `./auth.json` | Resolved under `~/.config/rinnegan` |

zsh is the default and is missing from some minimal distros, so install it or point `terminal.shell` at another shell.

## Notes

- **Shell lifetime**: a dropped connection kills the shell, so run `tmux` inside it when you need to reattach.
- **Sessions**: the signing secret is regenerated on every boot, so a restart logs everyone out.
- **Uploads**: files land in `/tmp` under a random prefix, and the modal shows you the path to paste rather than typing it into your terminal.
- **Downloads**: the Files panel takes an absolute host path and streams a directory back as `.tar.gz`.
- **Clipboard**: browsers gate clipboard access on a secure context, so reading an image and copying a path work only over HTTPS or `localhost`.
- **Themes**: the dropdown carries Catppuccin, Gruvbox, Dracula, Tokyo Night, Monokai Pro, Atom One, Everforest, and Nord, in dark and light pairs wherever upstream publishes both.
- **Theme reach**: a theme recolors the page and the terminal's ANSI palette, so a program drawing in ANSI 0-15 follows it while one carrying its own colors does not.
- **Color**: the terminal renders 24-bit color end to end, and it leaves bold text unbrightened the way kitty does.
- **Cursor**: the cursor is a steady beam in the theme's cursor color, and nothing running in the shell can recolor it or make it blink.
- **Fonts**: the terminal uses JetBrains Mono Nerd Font and the interface uses Inter, both bundled as woff2.
- **Rendering**: xterm draws through WebGL and falls back to the DOM renderer when WebGL2 is unavailable.

## Security

**Treat rinnegan like SSH access, because it is a shell on the machine it runs on.**

- Rinnegan binds `127.0.0.1`, and it should stay there unless a TLS proxy sits in front.
- There is one shared password and no accounts, so no action is attributable to a person.
- Rotating the password is the only way to revoke access, and it takes one access-TTL.
- Rinnegan does no login rate limiting, so do not expose it without network-level access control.
- `--no-auth` disables authentication completely, so use it only on a trusted, isolated box.
- Only a scrypt hash is stored, and passwords and tokens are never logged.

### Exposing it

Rinnegan serves plain HTTP and terminates no TLS, so you put your own proxy in front. That proxy has to pass WebSocket upgrades through, impose no request-body cap or read timeout, and you set `cookie.secure` to `true` once it is running.

See [docs/exposing.md](docs/exposing.md) for working Caddy and nginx configs.
