# Local, project-scoped setup for the shared web terminal. Works on macOS and Linux.
#
#   Node   -> pinned in .node-version, provided by fnm (auto-switches on cd).
#   Python -> provided by uv; only used by node-gyp to compile node-pty.
#   C/C++  -> system toolchain (Apple clang / gcc). Nothing project-specific.
#
# node-pty is compiled from source on both platforms (npm_config_build_from_source),
# which is required on Linux (no prebuilt binary) and avoids the broken prebuilt
# spawn-helper on macOS. npm prints a cosmetic "unknown config" warning for that flag;
# the source build still runs and `make verify` confirms it. Run `make` from a shell
# where fnm has activated .node-version.

.DEFAULT_GOAL := setup
.PHONY: setup verify vendor clean

# Full local setup: install deps (node-pty from source), vendor frontend assets,
# and prove the PTY works.
setup: node_modules vendor verify

# Reinstall only when the lockfile or npm config changes. `uv python install` ensures
# an interpreter for node-gyp; PYTHON points node-gyp at uv's Python.
node_modules: package-lock.json
	uv python install
	npm_config_build_from_source=true PYTHON="$$(uv python find)" npm ci
	@touch node_modules

# --- vendored frontend assets -------------------------------------------------
# Everything the browser loads from /vendor/: xterm dist files copied out of
# node_modules, plus JetBrains Mono Nerd Font Mono (Regular + Bold) fetched from the
# pinned nerd-fonts release and converted ttf -> woff2 with uv-provided fonttools.
# The "Mono" variant (single-cell icon advances) matches the team's kitty config.
# All file-based and idempotent: nothing runs when outputs are up to date.

VENDOR := public/vendor
NERDFONT_URL := https://github.com/ryanoasis/nerd-fonts/releases/download/v3.2.1/JetBrainsMono.zip
# uvx is not always installed alongside uv; `uv tool run` is its exact equivalent.
UVX := uv tool run

XTERM_VENDOR := $(VENDOR)/xterm.js $(VENDOR)/xterm.css
FONT_VENDOR  := $(VENDOR)/JetBrainsMonoNerdFontMono-Regular.woff2 $(VENDOR)/JetBrainsMonoNerdFontMono-Bold.woff2

vendor: $(XTERM_VENDOR) $(FONT_VENDOR)

# Depending on node_modules (touched by npm ci) re-copies after every reinstall.
$(VENDOR)/xterm.js: node_modules
	@mkdir -p $(VENDOR)
	cp node_modules/@xterm/xterm/lib/xterm.js $@

$(VENDOR)/xterm.css: node_modules
	@mkdir -p $(VENDOR)
	cp node_modules/@xterm/xterm/css/xterm.css $@

# One download yields both weights. Multi-target *pattern* rule ('%' matches the
# literal '.') so make 3.81 knows a single recipe run produces both files; work
# happens in a temp dir and only the two woff2 files land in public/vendor/.
$(VENDOR)/JetBrainsMonoNerdFontMono-Regular%woff2 $(VENDOR)/JetBrainsMonoNerdFontMono-Bold%woff2:
	@mkdir -p $(VENDOR)
	@set -e; tmp="$$(mktemp -d)"; trap 'rm -rf "$$tmp"' EXIT; \
	echo "fetching $(NERDFONT_URL)"; \
	curl -fL -o "$$tmp/JetBrainsMono.zip" "$(NERDFONT_URL)"; \
	unzip -q -j "$$tmp/JetBrainsMono.zip" \
	  JetBrainsMonoNerdFontMono-Regular.ttf JetBrainsMonoNerdFontMono-Bold.ttf -d "$$tmp"; \
	$(UVX) --from "fonttools[woff]" fonttools ttLib.woff2 compress \
	  -o $(VENDOR)/JetBrainsMonoNerdFontMono-Regular.woff2 "$$tmp/JetBrainsMonoNerdFontMono-Regular.ttf"; \
	$(UVX) --from "fonttools[woff]" fonttools ttLib.woff2 compress \
	  -o $(VENDOR)/JetBrainsMonoNerdFontMono-Bold.woff2 "$$tmp/JetBrainsMonoNerdFontMono-Bold.ttf"

# Spawn a real PTY and confirm output round-trips. Fast, no extra files.
verify:
	@node --input-type=module -e "import pty from 'node-pty'; const t=pty.spawn('/usr/bin/env',['sh','-c','echo pty-ok'],{name:'xterm-256color',cols:120,rows:36,env:process.env}); let o=''; t.onData(d=>{o+=d;}); t.onExit(e=>{const ok=o.includes('pty-ok')&&e.exitCode===0; console.log(ok?'verify: node-pty spawns OK '+JSON.stringify(o.trim()):'verify: node-pty FAILED'); process.exit(ok?0:1);});"

clean:
	rm -rf node_modules
