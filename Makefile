# node-pty is built from source on both platforms: required on Linux (no prebuilt) and avoids the broken macOS spawn-helper. Run make from a shell where fnm has activated .node-version.

.DEFAULT_GOAL := setup
.PHONY: setup verify vendor clean

setup: node_modules vendor verify

# PYTHON points node-gyp at uv's interpreter so it can compile node-pty.
node_modules: package-lock.json
	uv python install
	npm_config_build_from_source=true PYTHON="$$(uv python find)" npm ci
	@touch node_modules

# The "Mono" font variant (single-cell icon advances) matches the team's kitty config.

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

# Multi-target pattern rule ('%' matches the literal '.') so make 3.81 treats one recipe run as producing both files.
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

verify:
	@node --input-type=module -e "import pty from 'node-pty'; const t=pty.spawn('/usr/bin/env',['sh','-c','echo pty-ok'],{name:'xterm-256color',cols:120,rows:36,env:process.env}); let o=''; t.onData(d=>{o+=d;}); t.onExit(e=>{const ok=o.includes('pty-ok')&&e.exitCode===0; console.log(ok?'verify: node-pty spawns OK '+JSON.stringify(o.trim()):'verify: node-pty FAILED'); process.exit(ok?0:1);});"

clean:
	rm -rf node_modules
