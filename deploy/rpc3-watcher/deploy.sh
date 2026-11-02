#!/usr/bin/env bash
# SaveBridge watcher on rpc3 (Tencent Cloud HK, Ubuntu, 43.128.14.237) — next to the archive node,
# Blockscout, its database and the write shim, which must not be affected.
#
#   sudo deploy/rpc3-watcher/deploy.sh <step> [args] [--apply] [--allow-overwrite]
#
# DRY-RUN by default; idempotent; each step on its own. Order (deploy/README.md):
#   preflight → system → node → release <tar> <sha256> → keys → credentials → config → systemd → verify
#   (start is an owner-authorised step). Never touches the node, Blockscout, the shim, nginx or the firewall.
set -Eeuo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/common.sh
source "$HERE/../lib/common.sh"
# shellcheck source=../lib/app.sh
source "$HERE/../lib/app.sh"

SB_USER=savebridge-watcher
SB_OPT=/opt/savebridge-watcher
SB_ETC=/etc/savebridge-watcher
SB_STATE=/var/lib/savebridge-watcher
SB_PKG=@bridge/watcher
SB_CREDSTORE=/etc/credstore.encrypted
BASELINE_DIR=/root/savebridge-watcher-baseline
# existing services to watch for side effects (names as found by preflight; adjust if they differ)
read -r -a NEIGHBOURS <<<"${SB_NEIGHBOURS:-evmd wantd nginx docker postgresql}"

step="${1:-help}"; shift || true
sb_parse_common_flags "$@"
pos=(); for a in "$@"; do [[ "$a" == --* ]] || pos+=("$a"); done

step_preflight() {
  local f="$BASELINE_DIR/before.txt"
  # shellcheck disable=SC2016 # expanded by the inner sh
  sb_log "OS: $(probe sh -c '. /etc/os-release; echo "$PRETTY_NAME"')  systemd: $(systemd_major)"
  if (( $(systemd_major) < 250 )); then sb_warn "systemd < 250: no LoadCredentialEncrypted — the systemd step installs the unit with LoadCredential= and the credentials are root-only 0600 files (README §4 note)"; fi
  sb_log "running services (look for the node / blockscout / shim names):"; probe systemctl list-units --type=service --state=running --no-pager --plain | awk '{print $1}' | head -60 >&2
  for s in "${NEIGHBOURS[@]}"; do sb_log "$s: $(probe systemctl is-active "$s")"; done
  probe free -m >&2; probe df -h / /data >&2
  if id "$SB_USER" >/dev/null 2>&1; then sb_log "user $SB_USER already exists: $(getent passwd "$SB_USER")"; fi
  sb_log "WANTOS local RPC answering on 127.0.0.1:8545? $(probe curl -s -m 3 -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' http://127.0.0.1:8545)"
  if [[ "$SB_APPLY" == 1 ]]; then
    install -d -m 0700 "$BASELINE_DIR"
    if [[ -e "$f" ]]; then sb_log "baseline exists: $f (kept)"; else snapshot "$f" "${NEIGHBOURS[@]}"; sb_log "baseline written: $f"; fi
  else
    printf '[dry-run] write baseline snapshot to %s\n' "$f"
  fi
  cat >&2 <<'TXT'
Pre-deployment checklist:
  [ ] node / Blockscout / shim / nginx active and in the baseline; block height advancing
  [ ] >= 500 MB available memory, >= 2 GB free disk on /
  [ ] no existing user savebridge-watcher; the watcher will NOT reuse any existing account
  [ ] outbound HTTPS to the BSC providers, rpc.wantos.io, rpc2.wantos.io, api.telegram.org, the heartbeat service
  [ ] NTP synchronised (timedatectl) — the watcher alerts on clock skew
TXT
}

step_system() {
  require_root
  ensure_system_user "$SB_USER" "$SB_STATE"
  ensure_dir "$SB_ETC" 0750 "root:$SB_USER"
  ensure_dir "$SB_STATE" 0700 "$SB_USER:$SB_USER"
  ensure_dir "$SB_STATE/state" 0700 "$SB_USER:$SB_USER"
  ensure_dir "$SB_STATE/keystore" 0700 "$SB_USER:$SB_USER"
  ensure_dir "$SB_STATE/ack" 0700 "$SB_USER:$SB_USER"
  ensure_dir "$SB_CREDSTORE" 0700 root:root
  run apt-get install -y --no-install-recommends age curl gnupg gpgv xz-utils ca-certificates
}

step_config() {
  require_root
  local cfg="${pos[0]:-}"
  [[ -n "$cfg" && -f "$cfg" ]] || sb_die "usage: config <filled watcher.json> (from deploy/watcher.config.example.json)"
  if grep -Eq '[0-9a-fA-F]{64}' "$cfg"; then sb_die "$cfg contains a 64-hex string (private key?) — refusing"; fi
  if grep -v '"_comment"' "$cfg" | grep -Eq '://'; then sb_die "$cfg contains a URL — RPC URLs belong in rpc.env"; fi
  put_file "$SB_ETC/watcher.json" 0640 "root:$SB_USER" <"$cfg"
  if [[ ! -e "$SB_ETC/rpc.env" ]]; then
    put_file "$SB_ETC/rpc.env" 0600 root:root <"$HERE/files/rpc.env.example"
    sb_warn "edit $SB_ETC/rpc.env with the real BSC provider URLs (root-only file)"
  else
    sb_log "$SB_ETC/rpc.env exists (not shown, not changed)"; run chmod 0600 "$SB_ETC/rpc.env"; run chown root:root "$SB_ETC/rpc.env"
  fi
}

step_systemd() {
  require_root
  put_file /etc/systemd/system/savebridge-watcher.service 0644 root:root < <(unit_for_systemd "$HERE/files/savebridge-watcher.service")
  run systemctl daemon-reload
  if have systemd-analyze; then probe systemd-analyze security savebridge-watcher.service | tail -1 >&2; fi
  sb_log "unit installed but NOT enabled / started (owner-authorised: '$0 start --apply')"
}

step_dry_run_service() {
  # one tick without the ability to pause, as the service user, to validate config + RPCs (no writes)
  require_root
  local creds=() c
  for c in pauser-bsc-pass pauser-wantos-pass telegram-bot-token telegram-chat-id heartbeat-url; do creds+=(-p "$(cred_property)=$c:$SB_CREDSTORE/$c"); done
  run systemd-run --wait --pipe --uid="$SB_USER" --gid="$SB_USER" -p EnvironmentFile=/etc/savebridge-watcher/rpc.env "${creds[@]}" \
    -p WorkingDirectory="$SB_OPT/current/packages/watcher" /opt/node/bin/node --import tsx src/main.ts --config "$SB_ETC/watcher.json" --dry-run --once
}

step_start() {
  require_root
  run systemctl enable --now savebridge-watcher.service
}

step_verify() {
  local f="$BASELINE_DIR/after-$SB_TS.txt"
  probe systemctl --no-pager status savebridge-watcher.service | head -5 >&2
  for s in "${NEIGHBOURS[@]}"; do sb_log "$s: $(probe systemctl is-active "$s")"; done
  probe journalctl -u savebridge-watcher --since -10min --no-pager | grep -E '"event":"(pauser_loaded|fatal|rpc_warning|rpc_guard)"' | tail -20 >&2 || true
  probe systemctl show savebridge-watcher -p MemoryCurrent -p CPUUsageNSec >&2
  if [[ -e "$BASELINE_DIR/before.txt" ]]; then
    snapshot "$f" "${NEIGHBOURS[@]}" 2>/dev/null || true
    if [[ -e "$f" ]]; then compare_listeners "$BASELINE_DIR/before.txt" "$f"; fi
  else
    sb_warn "no baseline found"
  fi
}

step_ack() {
  # owner-instructed acknowledgement of a level-1 alert (stops its 24h repeats)
  local key="${pos[0]:-}"
  [[ -n "$key" && ${#key} -le 200 ]] || sb_die "usage: ack <key shown in the Telegram message>"
  if [[ "$SB_APPLY" == 1 ]]; then
    printf '%s\n' "$key" | runuser -u "$SB_USER" -- sh -c "umask 077; cat > '$SB_STATE/ack/$SB_TS.ack'"
    sb_log "ack queued; applied on the next tick (journalctl -u savebridge-watcher | grep ack_)"
  else
    printf '[dry-run] queue ack for key %s in %s/ack\n' "$key" "$SB_STATE"
  fi
}

case "$step" in
  preflight) step_preflight ;;
  system) step_system ;;
  node) require_root; step_node ;;
  release) require_root; step_release "${pos[0]:-}" "${pos[1]:-}" ;;
  keys) require_root; for k in pauser-bsc pauser-wantos; do step_keygen "$k"; done ;;
  credentials) require_root; for c in telegram-bot-token telegram-chat-id heartbeat-url; do put_credential "$c"; done ;;
  credential) require_root; put_credential "${pos[0]:-}" ;;
  config) step_config ;;
  systemd) step_systemd ;;
  dry-run-service) step_dry_run_service ;;
  start) step_start ;;
  verify) step_verify ;;
  ack) step_ack ;;
  backup-keystore) require_root; backup_dir_age "$SB_STATE/keystore" "/root/savebridge-watcher-keystore-$SB_TS.tar.age" "$SB_ETC/backup-recipients.txt" ;;
  *) sed -n '2,11p' "$0"; exit 2 ;;
esac
