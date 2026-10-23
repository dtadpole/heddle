#!/bin/sh
# Rebuild the Rust preview from main when main changed the binary, and restart it.
#
#   ./preview.sh            rebuild and restart when main changed rust/crates/heddle or heddle-server since the build
#   ./preview.sh --check    say whether the preview is behind, and change nothing (exit 10 when it is)
#   ./preview.sh --force    rebuild and restart even when nothing it serves changed
#
# The preview is a second service beside the deployment: the binary built from `origin/main` in a scratch checkout
# (PREVIEW_CHECKOUT, default ~/heddle--rust-preview), served by its own agent on PREVIEW_PORT (3097) with its own
# HEDDLE_HOME and session store (PREVIEW_HOME, default ~/.heddle-rust-preview; sessions in its sessions/, because the
# profile pins the session root to the deployment's store otherwise). The one order: fetch, move the scratch checkout to the tip
# (refused when it has changes), build release inside a build slot, dry-run `web`, swap the binary by rename so the
# running server keeps its file, reinstall with the checkout's own installer, verify the port, record the commit in
# PREVIEW_HOME/built-from-main, and print the owner's new link. It never touches the deployment's agent or ports.
set -eu

checkout="${PREVIEW_CHECKOUT:-$HOME/heddle--rust-preview}"
home="${PREVIEW_HOME:-$HOME/.heddle-rust-preview}"
port="${PREVIEW_PORT:-3097}"
label="${PREVIEW_LABEL:-com.dtadpole.heddle-web-rust-preview}"
mode="${1:-run}"
case "$mode" in run|--check|--force) ;; *) echo "preview.sh: unknown option $mode" >&2; exit 2 ;; esac
case "$port" in 3082|8082) echo "preview.sh: port $port belongs to the deployment" >&2; exit 2 ;; esac
[ "$label" = com.dtadpole.heddle-web ] && { echo "preview.sh: $label is the deployment's agent" >&2; exit 2; }

say() { printf 'preview: %s\n' "$*"; }
git_at() { git -C "$checkout" "$@"; }
git_at rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "preview.sh: $checkout is not a git checkout" >&2; exit 2; }

git_at fetch --quiet origin
tip=$(git_at rev-parse refs/remotes/origin/main)
built=$(cat "$home/built-from-main" 2>/dev/null || true)
short() { printf '%s' "$1" | cut -c1-7; }

# What the binary is made of: the two crates the coordinator named, and the lockfile that pins their dependencies.
changed=""
if [ -z "$built" ]; then
  changed="no recorded build"
elif ! git_at cat-file -e "$built^{commit}" 2>/dev/null; then
  changed="recorded build $(short "$built") is unknown here"
else
  changed=$(git_at diff --name-only "$built" "$tip" -- rust/crates/heddle rust/crates/heddle-server rust/Cargo.lock | head -3)
fi

if [ "$mode" = --check ]; then
  if [ -n "$changed" ]; then say "behind: built from $(short "${built:-none}"), main $(short "$tip"): $(printf '%s' "$changed" | tr '\n' ' ')"; exit 10; fi
  say "current: built from $(short "$built"); main $(short "$tip") changed nothing it serves"
  exit 0
fi
if [ -z "$changed" ] && [ "$mode" != --force ]; then
  say "current: main $(short "$tip") changed nothing it serves since $(short "$built")"
  exit 0
fi

[ -z "$(git_at status --porcelain)" ] || { echo "preview.sh: $checkout has changes; a scratch checkout is moved only when clean" >&2; exit 2; }
git_at checkout --quiet --detach "$tip"
say "building $(short "$tip") (was $(short "${built:-none}"))"
(cd "$checkout" && sh _tools_/local-build/run build --release --manifest-path rust/Cargo.toml -p heddle) >/dev/null 2>&1 \
  || { echo "preview.sh: the release build failed at $(short "$tip"); the preview still serves the previous binary" >&2; exit 1; }
binary="$checkout/rust/target/release/heddle"
HEDDLE_HOME="$home" "$binary" web --host 127.0.0.1 --port "$port" --config "$checkout/cordis.yml" --dry-run >/dev/null 2>&1 \
  || { echo "preview.sh: the new binary's web --dry-run failed; the preview still serves the previous binary" >&2; exit 1; }

mkdir -p "$home/bin"
cp "$binary" "$home/bin/heddle.new"
chmod 755 "$home/bin/heddle.new"
mv "$home/bin/heddle.new" "$home/bin/heddle"
HEDDLE_WEB_LABEL="$label" HEDDLE_WEB_UNIT="heddle-web-rust-preview.service" HEDDLE_WEB_PORT="$port" \
  HEDDLE_WEB_HOME="$home" HEDDLE_WEB_LOG="$home/web.log" HEDDLE_WEB_SESSION_ROOT="$home/sessions" \
  HEDDLE_BIN="$home/bin/heddle" HEDDLE_ALLOW_DIRTY_INSTALL=1 \
  sh "$checkout/_tools_/web-daemon/install.sh" --restart >/dev/null \
  || { echo "preview.sh: the installer refused or the port did not answer; see its message above" >&2; exit 1; }
printf '%s\n' "$tip" > "$home/built-from-main"
link=$(grep -o "http://127.0.0.1:$port/?token=[A-Za-z0-9_-]*" "$home/web.log" 2>/dev/null | tail -1 || true)
say "serving main $(short "$tip") on $port"
say "link: ${link:-not in the log yet}"
