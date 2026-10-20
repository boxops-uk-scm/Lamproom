# Lamproom: install, build, run the server, and start Claude Code with the plugin.
#
#   make build     build every package (core, server, cli, plugin, ui)
#   make login     sign in to the server from this terminal
#   make serve     run the server with GitHub sign-in (no dev user)
#   make claude    start Claude Code with the Lamproom plugin loaded
#   make up        both: server in the background, then Claude Code
#
# Settings live in .env (copy .env.example). It is sourced by the shell, so it
# overrides variables already in your environment; for a one-off, pass a make
# variable instead: `make serve PORT=5000`.

SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c
.DEFAULT_GOAL := help

ROOT := $(patsubst %/,%,$(dir $(abspath $(lastword $(MAKEFILE_LIST)))))
CLI := $(ROOT)/packages/cli/dist/lamproom.js
PLUGIN := $(ROOT)/packages/plugin
ENV_FILE ?= $(ROOT)/.env
RUN := $(ROOT)/.lamproom
LOG := $(RUN)/server.log
PIDFILE := $(RUN)/server.pid
DEFAULT_PORT := 4411

# The repository Lamproom should track: where `claude`, `init` and `status`
# run. Default to where make was invoked, which is not CURDIR: `make -C` means
# CURDIR is this file's directory, while the inherited PWD still names the
# directory you typed the command in. That is the whole point of running
# `make -C /path/to/lamproom claude` from the repository you want tracked.
DIR ?= $(if $(PWD),$(PWD),$(CURDIR))
# Extra arguments passed through to claude / lamproom, e.g. ARGS="--resume".
ARGS ?=
# One-off overrides; `serve --port/--host` beat the environment in the server.
PORT ?=
HOST ?=
# Development only, for `make dev-serve`: sign every request in as this login.
DEV_USER ?=
PORT_FLAG := $(if $(PORT),--port $(PORT),)
HOST_FLAG := $(if $(HOST),--host $(HOST),)

LOAD_ENV := set -a; if [ -f "$(ENV_FILE)" ]; then . "$(ENV_FILE)"; fi; set +a

# Production means GitHub sign-in: a dev user is refused, not silently honoured.
REQUIRE_GITHUB := unset LAMPROOM_DEV_USER; if [ -z "$${LAMPROOM_GITHUB_CLIENT_ID:-}" ] || [ -z "$${LAMPROOM_GITHUB_CLIENT_SECRET:-}" ]; then printf '%s\n' "Lamproom signs users in with a GitHub App, and none is configured." "" "  cp .env.example .env" "" "then fill in LAMPROOM_GITHUB_CLIENT_ID and LAMPROOM_GITHUB_CLIENT_SECRET." "Create the app under Settings > Developer settings, with callback URL" "  http://localhost:$(DEFAULT_PORT)/auth/github/callback" "Enable Device Flow ticked, the Metadata permission (read), and installed on" "the repositories you want to track. For development without an app:" "  make dev-serve DEV_USER=<login>" >&2; exit 1; fi

SERVER_URL := $${LAMPROOM_SERVER:-http://localhost:$${LAMPROOM_PORT:-$(DEFAULT_PORT)}}
TOKEN_FILE := $${LAMPROOM_CONFIG:-$${XDG_CONFIG_HOME:-$$HOME/.config}/lamproom/config.json}

.PHONY: help install build rebuild serve serve-bg stop restart logs claude up login logout init status dry-run fixtures test typecheck dev-ui dev-serve doctor clean

help: ## Show this help
	@printf 'Lamproom — a tracker for agentic development\n\nUsage: make <target> [DIR=/path/to/repo] [ARGS="..."]\n\n'
	@grep -hE '^[a-z][a-zA-Z0-9_-]*:.*## ' $(MAKEFILE_LIST) | awk 'BEGIN { FS = ":.*## " } { printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2 }'
	@printf '\nFrom another directory, name this one with -C:\n'
	@printf '  make -C %s claude\n' '$(ROOT)'
	@printf 'DIR then defaults to where you ran it, so that repository is the one tracked.\n'
	@printf '\nProduction sign-in needs LAMPROOM_GITHUB_CLIENT_ID and _SECRET in .env\n'

install: node_modules ## Install workspace dependencies

node_modules: package.json pnpm-lock.yaml
	@pnpm install
	@touch node_modules

build: node_modules ## Build every package
	@pnpm build

rebuild: clean build ## Build from scratch

# Everything that runs needs the CLI and the plugin bundled; build on demand so
# a fresh checkout works from one command.
$(CLI) $(PLUGIN)/dist/mcp.js $(PLUGIN)/dist/dryrun.js: node_modules
	@printf 'not built yet; building\n' >&2
	@pnpm build

serve: $(CLI) ## Run the server with GitHub sign-in (foreground)
	@$(LOAD_ENV); $(REQUIRE_GITHUB); \
	exec node "$(CLI)" serve $(PORT_FLAG) $(HOST_FLAG) $(ARGS)

serve-bg: $(CLI) ## Run the server in the background (log: .lamproom/server.log)
	@mkdir -p "$(RUN)"; \
	if [ -f "$(PIDFILE)" ] && kill -0 "$$(cat "$(PIDFILE)")" 2>/dev/null; then \
	  printf 'already running (pid %s)\n' "$$(cat "$(PIDFILE)")"; exit 0; \
	fi; \
	$(LOAD_ENV); $(REQUIRE_GITHUB); \
	url="$(SERVER_URL)"; \
	nohup node "$(CLI)" serve $(PORT_FLAG) $(HOST_FLAG) >>"$(LOG)" 2>&1 & \
	pid=$$!; echo "$$pid" > "$(PIDFILE)"; \
	for _ in $$(seq 40); do \
	  if ! kill -0 "$$pid" 2>/dev/null; then printf 'server exited; last lines of %s:\n' "$(LOG)" >&2; tail -20 "$(LOG)" >&2; rm -f "$(PIDFILE)"; exit 1; fi; \
	  if curl -sS -o /dev/null -m 2 "$$url/api/me" 2>/dev/null; then printf 'lamproom server  %s  (pid %s, log %s)\n' "$$url" "$$pid" "$(LOG)"; exit 0; fi; \
	  sleep 0.25; \
	done; \
	printf 'started (pid %s) but %s did not answer in 10s; see %s\n' "$$pid" "$$url" "$(LOG)" >&2; exit 1

stop: ## Stop the background server
	@if [ ! -f "$(PIDFILE)" ]; then printf 'not running\n'; exit 0; fi; \
	pid=$$(cat "$(PIDFILE)"); \
	if kill -0 "$$pid" 2>/dev/null; then kill "$$pid"; printf 'stopped (pid %s)\n' "$$pid"; else printf 'not running (stale pidfile)\n'; fi; \
	rm -f "$(PIDFILE)"

restart: stop serve-bg ## Restart the background server

logs: ## Follow the background server's log
	@touch "$(LOG)"; tail -f "$(LOG)"

claude: $(PLUGIN)/dist/mcp.js ## Start Claude Code with the plugin (DIR=repo to track)
	@$(LOAD_ENV); \
	url="$(SERVER_URL)"; \
	if ! curl -sS -o /dev/null -m 3 "$$url/api/me" 2>/dev/null; then \
	  printf 'no Lamproom server at %s — start one with: make serve-bg\n' "$$url" >&2; exit 1; \
	fi; \
	if [ -z "$${LAMPROOM_TOKEN:-}" ] && [ ! -f "$(TOKEN_FILE)" ]; then \
	  printf 'not signed in to %s — run: make login\n' "$$url" >&2; exit 1; \
	fi; \
	cd "$(DIR)"; \
	exec claude --plugin-dir "$(PLUGIN)" $(ARGS)

up: ## Server in the background, then Claude Code with the plugin
	@$(MAKE) --no-print-directory serve-bg
	@# DIR is passed on: a sub-make's PWD is this directory, not the caller's.
	@$(MAKE) --no-print-directory claude DIR="$(DIR)"

login: $(CLI) ## Sign in to the server from this terminal (GitHub device flow)
	@$(LOAD_ENV); exec node "$(CLI)" login $(ARGS)

logout: $(CLI) ## Discard this terminal's API token
	@$(LOAD_ENV); exec node "$(CLI)" logout $(ARGS)

init: $(CLI) ## Register DIR's origin repository as a project
	@$(LOAD_ENV); cd "$(DIR)"; exec node "$(CLI)" init $(ARGS)

status: $(CLI) ## Show the coal face for DIR's project
	@$(LOAD_ENV); cd "$(DIR)"; exec node "$(CLI)" status $(ARGS)

dry-run: $(PLUGIN)/dist/dryrun.js ## Rehearse the auto-tracking prompts, recording nothing
	@$(LOAD_ENV); cd "$(DIR)"; exec node "$(PLUGIN)/dist/dryrun.js" $(ARGS)

fixtures: $(PLUGIN)/dist/dryrun.js ## Dry-run every bundled fixture (costs about a cent)
	@$(LOAD_ENV); exec node "$(PLUGIN)/dist/dryrun.js" $(PLUGIN)/fixtures/*.json $(ARGS)

test: node_modules ## Run the core and server tests
	@pnpm test

typecheck: node_modules ## Typecheck every package
	@pnpm typecheck

dev-ui: node_modules ## Vite dev server for the UI (proxies to the API)
	@pnpm --filter @lamproom/ui dev

dev-serve: $(CLI) ## Run the server signed in as DEV_USER, no GitHub (development only)
	@$(LOAD_ENV); \
	if [ -n "$(DEV_USER)" ]; then export LAMPROOM_DEV_USER="$(DEV_USER)"; fi; \
	if [ -z "$${LAMPROOM_DEV_USER:-}" ]; then printf 'name a login: make dev-serve DEV_USER=tom\n' >&2; exit 1; fi; \
	exec node "$(CLI)" serve $(PORT_FLAG) $(HOST_FLAG) $(ARGS)

doctor: ## Check the toolchain and configuration
	@printf 'node     %s' "$$(node -v 2>/dev/null || printf 'MISSING')"; \
	major=$$(node -v 2>/dev/null | sed 's/^v//; s/\..*//'); \
	if [ -n "$$major" ] && [ "$$major" -lt 22 ]; then printf '  (Lamproom needs 22 or newer)'; fi; printf '\n'; \
	printf 'pnpm     %s\n' "$$(pnpm -v 2>/dev/null || printf 'MISSING')"; \
	printf 'claude   %s\n' "$$(claude --version 2>/dev/null || printf 'MISSING — agents cannot run')"; \
	printf 'gh       %s\n' "$$(gh --version 2>/dev/null | head -1 || printf 'MISSING — agents cannot open pull requests')"; \
	if gh auth status >/dev/null 2>&1; then printf 'gh auth  signed in\n'; else printf 'gh auth  NOT signed in — run: gh auth login\n'; fi; \
	printf 'built    %s\n' "$$(if [ -f "$(CLI)" ] && [ -f "$(PLUGIN)/dist/mcp.js" ]; then printf 'yes'; else printf 'no — run: make build'; fi)"; \
	printf '.env     %s\n' "$$(if [ -f "$(ENV_FILE)" ]; then printf '%s' "$(ENV_FILE)"; else printf 'none — cp .env.example .env'; fi)"; \
	$(LOAD_ENV); \
	printf 'sign-in  %s\n' "$$(if [ -n "$${LAMPROOM_GITHUB_CLIENT_ID:-}" ] && [ -n "$${LAMPROOM_GITHUB_CLIENT_SECRET:-}" ]; then printf 'GitHub app %s' "$$LAMPROOM_GITHUB_CLIENT_ID"; elif [ -n "$${LAMPROOM_DEV_USER:-}" ]; then printf 'dev user "%s" only — production serve will refuse' "$$LAMPROOM_DEV_USER"; else printf 'NOT configured'; fi)"; \
	printf 'token    %s\n' "$$(if [ -n "$${LAMPROOM_TOKEN:-}" ]; then printf 'LAMPROOM_TOKEN'; elif [ -f "$(TOKEN_FILE)" ]; then printf '%s' "$(TOKEN_FILE)"; else printf 'none — run: make login'; fi)"; \
	url="$(SERVER_URL)"; \
	printf 'server   %s\n' "$$(if curl -sS -o /dev/null -m 3 "$$url/api/me" 2>/dev/null; then printf '%s answering' "$$url"; else printf '%s not answering' "$$url"; fi)"

clean: ## Remove build output
	@rm -rf packages/*/dist packages/ui/src/theme/boxops.css packages/ui/src/theme/boxops.css.d.ts packages/ui/src/theme/boxops.js packages/ui/src/theme/boxops.d.ts
	@printf 'removed build output\n'
