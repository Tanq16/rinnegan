# node-pty is built from source on both platforms: required on Linux (no prebuilt) and avoids the broken macOS spawn-helper. Run make from a shell where fnm has activated .node-version.

.PHONY: help setup vendor verify bundle smoke version clean
.DEFAULT_GOAL := help

APP_NAME := rinnegan
VERSION ?= dev-build
NODE_VERSION := 24.17.0

VENDOR := public/vendor
FONTS_DIR := public/fonts
NERDFONT_URL := https://github.com/ryanoasis/nerd-fonts/releases/download/v3.2.1/JetBrainsMono.zip
# uvx is not always installed alongside uv; `uv tool run` is its exact equivalent.
UVX := uv tool run

CYAN := \033[0;36m
GREEN := \033[0;32m
NC := \033[0m

XTERM_VENDOR := $(VENDOR)/xterm.js $(VENDOR)/xterm.css
INTER_FONTS  := $(FONTS_DIR)/inter-400.woff2 $(FONTS_DIR)/inter-600.woff2
# The "Mono" font variant (single-cell icon advances) matches the team's kitty config.
NERD_FONTS   := $(FONTS_DIR)/JetBrainsMonoNerdFontMono-Regular.woff2 $(FONTS_DIR)/JetBrainsMonoNerdFontMono-Bold.woff2

help: ## Show this help
	@echo "$(CYAN)Available targets:$(NC)"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  $(GREEN)%-12s$(NC) %s\n", $$1, $$2}'

setup: node_modules vendor verify ## Install deps, vendor assets, verify node-pty

# PYTHON points node-gyp at uv's interpreter so it can compile node-pty.
node_modules: package-lock.json
	uv python install
	npm_config_build_from_source=true PYTHON="$$(uv python find)" npm ci
	@touch node_modules

vendor: $(XTERM_VENDOR) $(INTER_FONTS) $(NERD_FONTS) ## Vendor xterm.js + self-hosted woff2 fonts into public/

# Depending on node_modules (touched by npm ci) re-copies after every reinstall.
$(VENDOR)/xterm.js: node_modules
	@mkdir -p $(VENDOR)
	cp node_modules/@xterm/xterm/lib/xterm.js $@

$(VENDOR)/xterm.css: node_modules
	@mkdir -p $(VENDOR)
	cp node_modules/@xterm/xterm/css/xterm.css $@

$(FONTS_DIR)/inter-400.woff2: node_modules
	@mkdir -p $(FONTS_DIR)
	cp node_modules/@fontsource/inter/files/inter-latin-400-normal.woff2 $@

$(FONTS_DIR)/inter-600.woff2: node_modules
	@mkdir -p $(FONTS_DIR)
	cp node_modules/@fontsource/inter/files/inter-latin-600-normal.woff2 $@

# Multi-target pattern rule ('%' matches the literal '.') so make 3.81 treats one recipe run as producing both files.
$(FONTS_DIR)/JetBrainsMonoNerdFontMono-Regular%woff2 $(FONTS_DIR)/JetBrainsMonoNerdFontMono-Bold%woff2:
	@mkdir -p $(FONTS_DIR)
	@set -e; tmp="$$(mktemp -d)"; trap 'rm -rf "$$tmp"' EXIT; \
	echo "fetching $(NERDFONT_URL)"; \
	curl -fL -o "$$tmp/JetBrainsMono.zip" "$(NERDFONT_URL)"; \
	unzip -q -j "$$tmp/JetBrainsMono.zip" \
	  JetBrainsMonoNerdFontMono-Regular.ttf JetBrainsMonoNerdFontMono-Bold.ttf -d "$$tmp"; \
	$(UVX) --from "fonttools[woff]" fonttools ttLib.woff2 compress \
	  -o $(FONTS_DIR)/JetBrainsMonoNerdFontMono-Regular.woff2 "$$tmp/JetBrainsMonoNerdFontMono-Regular.ttf"; \
	$(UVX) --from "fonttools[woff]" fonttools ttLib.woff2 compress \
	  -o $(FONTS_DIR)/JetBrainsMonoNerdFontMono-Bold.woff2 "$$tmp/JetBrainsMonoNerdFontMono-Bold.ttf"

verify: ## Prove the node-pty native addon loads and runs
	@node --input-type=module -e "import pty from 'node-pty'; const t=pty.spawn('/usr/bin/env',['sh','-c','echo pty-ok'],{name:'xterm-256color',cols:120,rows:36,env:process.env}); let o=''; t.onData(d=>{o+=d;}); t.onExit(e=>{const ok=o.includes('pty-ok')&&e.exitCode===0; console.log(ok?'verify: node-pty spawns OK '+JSON.stringify(o.trim()):'verify: node-pty FAILED'); process.exit(ok?0:1);});"

bundle: vendor ## Assemble the runtime-bundled tarball for the host platform
	@bash scripts/bundle.sh "$$(node -p 'process.platform')" "$$(node -p 'process.arch')"

smoke: ## Smoke-test the built tarball with a scrubbed PATH (prove self-containment)
	@bash scripts/smoke-test.sh "$$(node -p 'process.platform')" "$$(node -p 'process.arch')"

version: ## Calculate next version from commit message
	@LATEST_TAG=$$(git tag --sort=-v:refname | head -n1 || echo "0.0.0"); \
	LATEST_TAG=$${LATEST_TAG#v}; \
	MAJOR=$$(echo "$$LATEST_TAG" | cut -d. -f1); \
	MINOR=$$(echo "$$LATEST_TAG" | cut -d. -f2); \
	PATCH=$$(echo "$$LATEST_TAG" | cut -d. -f3); \
	MAJOR=$${MAJOR:-0}; MINOR=$${MINOR:-0}; PATCH=$${PATCH:-0}; \
	COMMIT_MSG="$$(git log -1 --pretty=%B)"; \
	if echo "$$COMMIT_MSG" | grep -q "\[major-release\]"; then \
		MAJOR=$$((MAJOR + 1)); MINOR=0; PATCH=0; \
	elif echo "$$COMMIT_MSG" | grep -q "\[minor-release\]"; then \
		MINOR=$$((MINOR + 1)); PATCH=0; \
	else \
		PATCH=$$((PATCH + 1)); \
	fi; \
	echo "v$${MAJOR}.$${MINOR}.$${PATCH}"

# Vendored xterm + JetBrains woff2 are tracked in git and restoring them needs the uv toolchain, so clean leaves them in place.
clean: ## Remove node_modules and build output
	rm -rf node_modules dist
