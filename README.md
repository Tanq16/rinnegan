<div align="center">
  <img src=".github/assets/logo.svg" alt="Rinnegan logo" width="250">
  <h1>Rinnegan</h1>

  <a href="https://github.com/Tanq16/rinnegan/actions/workflows/release.yaml"><img alt="Build Workflow" src="https://github.com/Tanq16/rinnegan/actions/workflows/release.yaml/badge.svg"></a>&nbsp;<a href="https://github.com/Tanq16/rinnegan/releases"><img alt="GitHub Release" src="https://img.shields.io/github/v/release/Tanq16/rinnegan"></a><br><br>
  <a href="#features">Features</a> &bull; <a href="#screenshots">Screenshots</a> &bull; <a href="#installation-and-usage">Install & Use</a> &bull; <a href="#configuration">Configuration</a> &bull; <a href="#how-it-works">How It Works</a>
</div>

---

A minimal self-hosted **personal web terminal**: one password gets you a real interactive shell on the host, in your browser. Each browser connection owns its own shell — for persistence, panes, or long-running work, start `tmux` or `zellij` inside it (see [Terminal](#terminal)).

The intent is to bring the shell experience of my [CLI Productivity Suite](https://github.com/Tanq16/cli-Productivity-Suite) to remote use: a web terminal for remote systems, direct tunnel access, and a full host shell — the same environment, reachable from a browser.

It is **not** an IDE, a task manager, or a tmux manager — just a terminal frontend, like a web-based SSH client for a box you own. The common use case is a homelab workspace or a cloud VPS.

> [!NOTE]
> The shell experience rinnegan targets is the one from my [CLI Productivity Suite](https://github.com/Tanq16/cli-Productivity-Suite) — read that project's README for its specifics and requirements as needed.

## Features

- **Password in, shell out** — one field on the login page, then a real interactive shell sized to your browser window, streamed over WebSocket.
- **A shell per connection** — spawned on demand, killed with the socket; no server-owned always-on PTY. Durability is tmux's job. See [Terminal](#terminal).
- **Pick your shell** — `--shell zsh|bash|fish`, or any command string via `terminal.shell`. See [CLI](#cli).
- **Authenticated port tunnel** — forward your `localhost:<port>` to a `localhost` port on the server over an authenticated WebSocket (`rinnegan tunnel`) — `ssh -L` without SSH. See [CLI](#cli).
- **Host file transfer** — upload a clipboard image, a file, or a whole folder to `/tmp` over HTTP and get the path to paste (nothing is typed into your terminal); download any host file or directory, directories as `.tar.gz`. See [File transfer](#file-transfer).
- **Bundled self-signed HTTPS** — optional `serve --https` runs Caddy as a managed child to terminate TLS, with zero extra downloads.
- **Self-contained tarball** — each release bundles its own Node runtime and a platform-native `node-pty`; the host needs no Node, Python, compiler, or `make`.
- **Password + ephemeral-session auth** — a scrypt-hashed password, HMAC-signed cookies with a per-boot secret, no persisted revocation list.

## Screenshots

<details>
<summary>Click to expand screenshots</summary>

No screenshots yet — this section will be filled in with real captures of the terminal, the login page, and the control panel in a future update.

</details>

## Installation and Usage

Rinnegan is a single process you launch; it serves the terminal over HTTP and WebSocket. Point a browser at the address it prints. Grab the tarball for your platform from [Releases](https://github.com/Tanq16/rinnegan/releases) (Linux and macOS, x64 and arm64; no Windows build), then:

```sh
tar xf rinnegan-<os>-<arch>.tar.gz
cd rinnegan-<os>-<arch>
./bin/rinnegan
```

`./bin/rinnegan` with no subcommand runs the server (same as `serve`); it binds `127.0.0.1:8442` and runs as the invoking user. Each tarball is self-contained — its own Node runtime, a platform-native `node-pty`, the `bin/caddy` binary for [HTTPS](#serving-over-https), and third-party licenses under `licenses/` — so the host needs no Node, Python, compiler, or `make`.

**First run seeds no password.** Set one before serving — this is a shell on your machine, so pick a real password (input is never echoed):

```sh
./bin/rinnegan passwd
```

Then open **http://127.0.0.1:8442** and log in. There are no accounts and no usernames: one password guards the box, and changing it revokes every existing session within one access-TTL. `passwd` takes effect on a running server without a restart.

| Setup | On boot | You get |
| ----- | ------- | ------- |
| no `auth.json` | refuses to start | — (run `passwd`, or pass `--no-auth`) |
| `auth.json` present | login page | password in, terminal out |
| `serve --no-auth` | no login page | a host shell to anyone who reaches the port; no Log out |

`serve --no-auth` disables authentication entirely: the login page is skipped and anyone who reaches the port gets a host shell. It prints a single startup warning and is only for a trusted, isolated box.

**macOS.** The launcher best-effort strips `com.apple.quarantine` from the extracted bundle so Gatekeeper doesn't block the bundled `node`. If macOS still balks, download with `curl -fLO <asset-url>` or clear it manually:

```sh
xattr -dr com.apple.quarantine rinnegan-<os>-<arch>
```

**Updating.** Each bundle ships an `update.sh` that fetches the latest release for your OS/arch. Run it from the install directory:

```sh
./update.sh
```

It downloads and verifies the new build in a temp dir before touching anything — a failed download leaves the current install intact — then swaps it in place. Your `~/.config/rinnegan` state is never touched, and it prints a restart reminder rather than restarting the server for you.

### From source

Contributors work from a checkout, not a tarball:

```sh
git clone https://github.com/Tanq16/rinnegan
cd rinnegan
make          # install deps (node-pty from source), vendor assets, verify PTY
node bin/rinnegan.js passwd
npm run dev   # dev server reading ~/.config/rinnegan, restart on change
```

`make` uses **fnm** for the pinned Node (`.node-version`, 24.17.0) and **uv** for a node-gyp Python. `node-pty` is compiled from source (`npm_config_build_from_source=true`): Linux ships no prebuilt binary, and the macOS prebuild's `spawn-helper` lacks the execute bit and fails at runtime with `posix_spawnp failed`. `make verify` spawns a real PTY and fails loudly on regression. The end-to-end suite (`node test/e2e.mjs`) boots a server and drives it over HTTP + WebSocket.

## Configuration

All state lives in **`~/.config/rinnegan/`** (created mode 0700, regardless of the process working directory): `config.json` is self-seeded from the built-in defaults on first run (mode 0600), `auth.json` is operator-created via [`passwd`](#cli) and never auto-seeded (mode 0600), and `caddy-data/` (under `serve --https`) sits alongside. `config.json` is deep-merged over the built-in defaults, so set only what you change.

| Field | Default | Notes |
| ----- | ------- | ----- |
| `listen.host` | `127.0.0.1` | Bind localhost; put HTTPS in front for exposure |
| `listen.port` | `8442` | |
| `cookie.name` | `rinnegan` | Session cookie (HttpOnly, SameSite=Lax, Path=/) |
| `cookie.secure` | `false` | Set `true` over HTTPS; auto-forced under `serve --https` |
| `cookie.accessTtlSeconds` | `10800` | Access cookie lifetime; 60–604800 |
| `cookie.refreshTtlSeconds` | `604800` | Refresh cookie lifetime (scoped to `/refresh`); minimum 60 |
| `terminal.shell` | `/usr/bin/env zsh -l` | Split on whitespace into `(file, args)`; no shell quoting. `--shell` overrides it |
| `terminal.cwd` | `$HOME` | Falls back to your home directory when unset |
| `terminal.cols` / `rows` | `120` / `36` | Fallback grid only, used when a client reports a malformed size; normally your viewport decides |
| `terminal.env` | `TERM`, `COLORTERM`, `LANG`/`LC_ALL` | Merged over the server process env |
| `authFile` | `./auth.json` | The scrypt password record; resolved under `~/.config/rinnegan` |

- **Shell.** Defaults to `/usr/bin/env zsh -l`; zsh isn't preinstalled on some minimal Linux distros, so install it, pass `--shell bash`, or point `terminal.shell` at an existing shell. The config value is split on whitespace into executable + args with no shell quoting, so keep args simple.
- **Session secret.** The HMAC signing secret is regenerated on every boot and never persisted — restarting invalidates all sessions and you re-log in (deliberate; there is no revocation list). Nothing else is server-written.
- **Exposing beyond localhost.** Put HTTPS in front (see [Security](#security)) and set `cookie.secure: true`.

## How it works

### Terminal

Log in and you land in a shell. There is no lobby and no chooser — the browser asks for a terminal sized to its own window as soon as the socket is up, so the first prompt renders at the right width.

- **A shell per connection.** Nothing is spawned until a browser asks, and the shell is killed when that socket closes. There is no server-owned always-on PTY, no scrollback replay, and no reattach.
- **Exit is the restart path.** When the shell exits you get a card naming the exit code with one **Start new shell** button; there is no separate Restart action.
- **A dropped connection kills the shell.** This is the deliberate trade for dropping the shared PTY: a few seconds of lost connectivity destroys the running shell, and a reconnect lands on the same card rather than silently handing back an empty one. Durability is tmux's job — start `tmux` inside the shell and it daemonizes out of the session's process tree, so reconnect → Start → `tmux attach` resumes your work.
- **Sizing.** Every browser renders at a fixed font size (use browser zoom to scale) and sizes its shell to the grid that fits its own window, resizing the PTY as the window changes. `terminal.cols`/`rows` are only a fallback for a malformed size report.
- **Keystrokes never cross shells.** Input is tagged with the shell's epoch, so anything in flight when one dies is dropped rather than executed in its successor.
- It is a *shell*, not a sandbox: same OS user, filesystem, and visible processes as anything else on the box. Treat it with the same care.

### File transfer

`Ctrl-V` in a browser terminal can't reach a CLI that reads the *host's* clipboard — a pasted image is in your browser, not on the box the shell runs on. The Control panel's **Files** panel bridges both directions over plain HTTP; the WebSocket carries terminal traffic only.

**Upload** — `Upload…` offers three sources:

- **From clipboard** — grabs an image off your clipboard (needs a secure context: HTTPS or `localhost`).
- **Choose file…** — a normal file picker for any file.
- **Choose folder…** — a directory picker; every file in the tree goes up, one at a time.

Bytes are streamed to disk with a `POST`, with **no size cap** and a live progress bar you can hide or cancel. A single file lands at `/tmp/<5-random-alnum>-<name>` mode `0600`; the name is reduced to a bare basename in `[A-Za-z0-9._-]` (no separators, leading dots, traversal, or shell metacharacters; ≤100 chars) so the path is safe unquoted. A folder lands under `/tmp/<5-random-alnum>-<folder>/` with its relative tree preserved and each segment sanitized the same way — it is copy-the-files, not archive, so empty directories, symlinks, and permissions are not carried. A cancelled or failed upload's partial temp file is deleted; completed uploads are never deleted by rinnegan — `/tmp` is the OS's to reap. Upload needs only a login, and works whether or not a shell is running.

**Nothing is typed into your terminal.** The modal shows the finished path and copies it when the clipboard API is available (HTTPS or `localhost`); otherwise it says so and you select it. Paste it into a tool like [Claude Code](https://claude.com/claude-code) yourself — one `Cmd-V`, and you choose when and where.

**Download** — give the Files panel an absolute host path. It probes the path first, so a typo shows a real in-app error instead of a cryptic browser failure, then hands off to your browser's own download manager. A single file streams with real progress; a directory streams as `<dir>.tar.gz` (`tar xzf` it on the other end). Anyone logged in can download anything the server user can read — parity with the shell they already have (see [Security](#security)). Every upload and download is logged server-side with the path; with a single shared password there is no actor to attribute it to.

### Theme and fonts

- **Palette:** Catppuccin Mocha, hex values taken from the kitty config in [`Tanq16/cli-Productivity-Suite`](https://github.com/Tanq16/cli-Productivity-Suite) so the web terminal matches the native setup. Bold cells are not brightened (matching kitty); true 24-bit color is enabled end to end. Baked in, not configurable.
- **Cursor:** locked to a steady rosewater beam (kitty's `cursor_shape beam`, no blink) — OSC 10/11/12 color escapes are filtered and DECSCUSR blink bits stripped, so nothing run in the shell can recolor it or make it blink.
- **Fonts:** terminal in **JetBrains Mono Nerd Font Mono** (single-cell "Mono" variant, 400/700), UI in **Inter** (400/600), both bundled as woff2 with a `monospace` fallback. All font files are committed and shipped in every tarball, so no font tooling is needed to build or run.
- **Rendering:** GPU-accelerated via xterm's WebGL renderer, falling back to the DOM renderer when WebGL2 is unavailable — keeps full-screen TUI repaints (scrolling inside `tmux`, editors, or other TUIs) smooth.

### CLI

The launcher forwards its arguments straight to the bundled server:

```
./bin/rinnegan                              # start the server (default: serve)
./bin/rinnegan serve [--https] [--no-auth] [--shell zsh|bash|fish] [--refresh-caddyfile]
./bin/rinnegan passwd                       # set the single login password
./bin/rinnegan tunnel --server <url> --local <port> --remote <port> [--insecure]  # forward a local port to the server
./bin/rinnegan tunnel --config <path> [--insecure]  # forward many ports from a JSON config
```

Password prompts are never echoed. `auth.json` is re-read on every login, so `passwd` takes effect on a running server without a restart — and because the salt is regenerated, rotating the password (even to the same one) invalidates every live session within one access-TTL. `serve` refuses to start without `auth.json` unless `--no-auth` is given.

`--shell` accepts exactly **`zsh`**, **`bash`**, or **`fish`**, each expanding to `/usr/bin/env <name> -l`. Anything else is a startup error rather than a silent fallback — landing in the wrong shell just looks like a broken config. Precedence is `--shell` > `terminal.shell` in `config.json` > the default `/usr/bin/env zsh -l`; `terminal.shell` still takes an arbitrary command string, so the allowlist costs no capability. The binary's existence is not pre-flighted: a missing shell surfaces as a spawn error the first time you start a terminal.

`tunnel` forwards your `localhost:<local>` to the server's `localhost:<remote>` over an authenticated WebSocket (password prompted; `--insecure` accepts Caddy's self-signed cert or a bare IP); `--refresh-caddyfile` reseeds the runtime Caddyfile from the bundled template, discarding local edits.

`--config` forwards several ports over one login instead of a single `--local`/`--remote` pair. The file names the server once and lists the mappings (see `tunnel.example.json`); each `ports` entry is `"<local>:<remote>"`, a bare `"<port>"` (same on both sides), or a `[<local>, <remote>]` pair:

```json
{ "server": "https://example.com:8443", "ports": ["8080:80", "5432:5432", "3000"] }
```

### Security

**Treat rinnegan like SSH access — it is a shell on the machine it runs on.**

- Binds **`127.0.0.1`** by default; keep it there unless a properly authenticated, TLS-terminating proxy is in front.
- Auth is required everywhere by default: WebSocket upgrades are validated before completing and rejected with close code 4401 when unauthenticated. `serve --no-auth` is the one deliberate exception — it disables all authentication and hands a host shell to anyone who reaches the port, so use it only on a trusted, isolated box.
- Only a scrypt password hash is stored; passwords and session tokens are never logged.
- **One shared password, no accounts.** Everyone who can log in is the same principal, so nothing is attributable — transfer logs record the path, not an actor. Rotating the password is the only way to revoke access, and it does so within one access-TTL.
- **No login rate limiting** — with a single secret and no username to guess, this matters more per attempt than it would with accounts. Do not expose beyond a trusted network without HTTPS and network-level access controls.
- **No password is seeded on first run** — set one with `passwd` and make it a strong one; `serve` refuses to start without `auth.json` unless `--no-auth` is set.
- `~/.config/rinnegan` and its `config.json` and `auth.json` should be readable only by the running user (rinnegan creates the directory mode 0700 and those files mode 0600).

Recommended shape when exposing it: `browser → Caddy (HTTPS) → localhost-bound rinnegan`. The bundled wrapper below is the fastest way there.

#### Serving over HTTPS

```sh
./bin/rinnegan serve --https
```

Each tarball bundles **Caddy 2.11.4** (Apache-2.0; license at `licenses/caddy-LICENSE`), built with `xcaddy` so it also carries the DNS provider modules listed in `licenses/caddy-dns-modules.txt` — those matter only for [your own domain](#bring-your-own-domain) and change nothing here. This runs Caddy as a **managed child process** listening on `0.0.0.0:8443` and reverse-proxying to `127.0.0.1:8442`, so rinnegan itself stays localhost-only. Browse to **https://\<host\>:8443**, accept the one-time self-signed warning, and log in. `cookie.secure` is forced to `true` in this mode.

- **Certificate:** issued by Caddy's internal CA, so browsers warn on first visit. The warning returns whenever the leaf rotates, because browsers pin a click-through exception to that leaf's fingerprint — the bundled `Caddyfile` therefore pins a 30-day leaf instead of Caddy's 12-hour default. To be rid of the warning entirely, install the CA root (`~/.config/rinnegan/caddy-data/caddy/pki/authorities/local/root.crt`) in each client's trust store; it is stable for 10 years, so rotation stops mattering. Upgrading from an older release keeps your existing runtime Caddyfile — pass `serve --https --refresh-caddyfile` once to pick up the new lifetime.
- **State:** Caddy's CA and certs live in `~/.config/rinnegan/caddy-data/`, and its config is the runtime `~/.config/rinnegan/Caddyfile` (seeded from the bundled template on the first `--https` run, never clobbered after); delete `caddy-data/` and restart to regenerate the CA.
- **Ports:** if you change `listen.port`, edit `~/.config/rinnegan/Caddyfile`'s `reverse_proxy` target to match — that runtime copy persists across updates (`serve --https` warns if the port is not `8442`). The bundled template only reseeds when you pass `serve --https --refresh-caddyfile`, which discards any runtime edits.
- **Edge hardening:** the `Caddyfile` adds a `read_header` (10s) timeout, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, and strips `Server`. Request bodies are unbounded and untimed so [file transfer](#file-transfer) works through the HTTPS front; write/idle timeouts are omitted so long-lived WebSocket streams are not torn down.
- **Still no rate limiting** even over HTTPS — keep it on a trusted network.

rinnegan and Caddy can also run as two separate processes: `./bin/rinnegan serve`, then `./bin/caddy` with `XDG_DATA_HOME`/`XDG_CONFIG_HOME` pointed at a local directory.

#### Bring your own domain

The bundled `--https` path is self-signed. For a public domain with a real, browser-trusted certificate, run rinnegan localhost-only and put Caddy in front. Two ready-to-edit samples ship in every tarball — replace `example.com`, keep the rest:

| File | Certificate covers | Credentials | Use when |
| ---- | ------------------ | ----------- | -------- |
| `Caddyfile.domain.example` | exactly `term.example.com` | **none** | the box is publicly reachable on `:443` — the common case |
| `Caddyfile.wildcard.example` | `*.example.com` | DNS API token | you want the subdomain label kept out of Certificate Transparency logs, you serve several names, or the box is behind NAT |

The first uses the **TLS-ALPN-01** challenge: Let's Encrypt connects back to port 443 to verify the name, so there is no API token, no `_acme-challenge` record, and nothing to install. The second needs **DNS-01** because a wildcard can only be issued that way — Caddy writes a TXT record in your zone, which requires API access to whoever *hosts* your DNS (not whoever you bought the domain from; check with `dig NS example.com +short`).

`bin/caddy` is built with `xcaddy` and carries these DNS provider modules: **cloudflare, porkbun, namecheap, godaddy, duckdns, acmedns** (`./bin/caddy list-modules | grep dns.providers` to confirm; pinned versions are listed in `licenses/caddy-dns-modules.txt`). For any other DNS host, `acmedns` works universally — register once, add one permanent CNAME, and a token that could rewrite your real zone never lands on the box.

Both samples deliberately omit `default_sni` and any host-less site block, so a request to the server's bare IP sends no SNI, matches no certificate, and dies at the TLS handshake instead of offering something to click through. Each file's header comments carry the domain-side steps (A record, firewall, parking records) and the matching rinnegan settings.

Neither sample is ever auto-seeded — `~/.config/rinnegan/Caddyfile` stays the self-signed template — so edit a copy (the domain and the `email`) and run it one of three ways:

```sh
# 1. Two processes. Needs cookie.secure: true in config.json.
./bin/rinnegan serve
./bin/caddy run --config ./Caddyfile.domain.example

# 2. Managed child, explicit path.
./bin/rinnegan serve --https --caddyfile ~/.config/rinnegan/Caddyfile.domain

# 3. Managed child, no flag: install it as the runtime Caddyfile and plain --https loads it.
cp Caddyfile.domain.example ~/.config/rinnegan/Caddyfile
./bin/rinnegan serve --https
```

`serve --https` prints the Caddyfile it resolved, so you can confirm which one is live. It forces `cookie.secure` regardless of the file loaded; set that manually only on the two-process route. Option 3 is the least typing, but the runtime copy is exactly what `--refresh-caddyfile` overwrites — pass that flag again and you silently drop back to the self-signed template on `:8443`. Option 2 is immune.

Binding `:443` as rinnegan's non-root child needs `setcap cap_net_bind_service=+ep` on `bin/caddy`. **`./update.sh` replaces that binary, which drops the capability — re-apply it after every update**, or Caddy fails to bind and the server exits. Running Caddy as its own systemd service avoids both concerns.
