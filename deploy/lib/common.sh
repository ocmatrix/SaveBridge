#!/usr/bin/env bash
# Shared helpers for the SaveBridge deploy scripts. Sourced, never executed.
#
# Safety model:
#   - DRY-RUN BY DEFAULT: every state-changing command goes through `run` / `put_file`, which only
#     print what they would do unless the step is invoked with --apply.
#   - Idempotent: each helper checks the current state first and does nothing when it already matches.
#   - Destructive actions (overwrite a differing file, replace a release) need --apply AND an explicit
#     --allow-overwrite; existing files are backed up next to themselves first (*.savebridge-bak-<ts>).
#   - Never touches other services' configuration: callers only write under their own paths.
# shellcheck shell=bash

set -Eeuo pipefail

SB_APPLY=0
SB_ALLOW_OVERWRITE=0
SB_TS="$(date -u +%Y%m%dT%H%M%SZ)"

sb_log()  { printf '[savebridge] %s\n' "$*" >&2; }
sb_warn() { printf '[savebridge] WARNING: %s\n' "$*" >&2; }
sb_die()  { printf '[savebridge] ERROR: %s\n' "$*" >&2; exit 1; }

sb_parse_common_flags() {
  local a
  for a in "$@"; do
    case "$a" in
      --apply) SB_APPLY=1 ;;
      --dry-run) SB_APPLY=0 ;;
      --allow-overwrite) SB_ALLOW_OVERWRITE=1 ;;
    esac
  done
  if [[ "$SB_APPLY" == 1 ]]; then sb_log "mode: APPLY"; else sb_log "mode: DRY-RUN (nothing is changed; re-run with --apply)"; fi
}

# run CMD ARGS... : executes only with --apply; prints the command either way.
run() {
  if [[ "$SB_APPLY" == 1 ]]; then
    sb_log "+ $*"
    "$@"
  else
    printf '[dry-run] %s\n' "$*"
  fi
}

# Read-only probe: always runs, never fails the script.
probe() { "$@" 2>&1 || true; }

have() { command -v "$1" >/dev/null 2>&1; }

require_root() {
  if [[ "$SB_APPLY" == 1 && "$(id -u)" != 0 ]]; then sb_die "--apply must run as root (sudo)"; fi
}

# put_file DEST MODE OWNER:GROUP  (content on stdin)
# Creates DEST if missing; if it exists with identical content only fixes mode/owner; if it differs,
# shows the diff and refuses unless --allow-overwrite (then backs it up first).
put_file() {
  local dest="$1" mode="$2" owner="$3" tmp
  tmp="$(mktemp)"
  cat >"$tmp"
  if [[ -e "$dest" ]]; then
    if cmp -s "$tmp" "$dest"; then
      sb_log "unchanged: $dest"
      run chmod "$mode" "$dest"
      run chown "$owner" "$dest"
      rm -f "$tmp"
      return 0
    fi
    sb_warn "$dest differs from the desired content:"
    diff -u "$dest" "$tmp" >&2 || true
    if [[ "$SB_ALLOW_OVERWRITE" != 1 ]]; then
      rm -f "$tmp"
      if [[ "$SB_APPLY" == 1 ]]; then sb_die "refusing to overwrite $dest (re-run with --allow-overwrite after reviewing the diff)"; fi
      sb_warn "[dry-run] --apply would REFUSE to overwrite $dest without --allow-overwrite"
      return 0
    fi
    run cp -p "$dest" "$dest.savebridge-bak-$SB_TS"
  else
    sb_log "create: $dest"
    [[ "$SB_APPLY" == 1 ]] || sed 's/^/[dry-run]   | /' "$tmp"
  fi
  run install -m "$mode" -o "${owner%%:*}" -g "${owner##*:}" "$tmp" "$dest"
  rm -f "$tmp"
}

# ensure_dir PATH MODE OWNER:GROUP
ensure_dir() {
  local p="$1" mode="$2" owner="$3"
  if [[ -d "$p" ]]; then
    sb_log "exists: $p"
    run chmod "$mode" "$p"
    run chown "$owner" "$p"
  else
    run install -d -m "$mode" -o "${owner%%:*}" -g "${owner##*:}" "$p"
  fi
}

# ensure_system_user NAME HOME : nologin system user + same-named group, never reused from another service.
ensure_system_user() {
  local u="$1" home="$2"
  if id "$u" >/dev/null 2>&1; then
    local shell
    shell="$(getent passwd "$u" | cut -d: -f7)"
    case "$shell" in
      */nologin|*/false) sb_log "user $u exists (shell $shell)" ;;
      *) sb_die "user $u exists with a login shell ($shell): it is not ours, stop and investigate" ;;
    esac
  else
    run useradd --system --user-group --home-dir "$home" --no-create-home --shell /usr/sbin/nologin "$u"
  fi
}

# Baseline snapshot of listeners / services / resources, for the before/after comparison.
snapshot() {
  local out="$1"; shift
  {
    echo "### date"; date -u
    echo "### listeners (ss -ltnup)"; probe ss -ltnup
    echo "### services"; for s in "$@"; do printf '%s: ' "$s"; probe systemctl is-active "$s"; done
    echo "### memory"; probe free -m
    echo "### swap"; probe swapon --show
    echo "### disk"; probe df -h /
    echo "### load"; probe uptime
    echo "### firewall (nft)"; probe nft list ruleset
    echo "### firewall (ufw)"; probe ufw status verbose
    echo "### firewall (iptables)"; probe iptables -S
  } >"$out"
}

# Compare listener sets of two snapshots: new listeners must be on loopback only.
compare_listeners() {
  local before="$1" after="$2"
  local b a
  b="$(sed -n '/### listeners/,/### services/p' "$before" | awk 'NR>2{print $1,$5}' | sort -u)"
  a="$(sed -n '/### listeners/,/### services/p' "$after" | awk 'NR>2{print $1,$5}' | sort -u)"
  local added removed
  added="$(comm -13 <(echo "$b") <(echo "$a") || true)"
  removed="$(comm -23 <(echo "$b") <(echo "$a") || true)"
  echo "listeners removed since baseline:"; echo "${removed:-  (none)}"
  echo "listeners added since baseline:"; echo "${added:-  (none)}"
  if [[ -n "$removed" ]]; then sb_warn "a listener disappeared: check nginx/coturn/other services NOW"; fi
  if echo "$added" | grep -v -E '(127\.0\.0\.1|\[::1\]|^$)' | grep -q .; then sb_warn "a NON-loopback listener appeared: investigate before going on"; return 1; fi
}
