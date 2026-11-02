#!/usr/bin/env bash
# SaveBridge payout server (ss02: Linode, Debian 13, 1 vCPU / 2 GB, shares the host with nginx + coturn).
#
#   sudo deploy/ss02-payout/deploy.sh <step> [args] [--apply] [--allow-overwrite]
#
# DRY-RUN by default; every step is idempotent and can be run on its own. Order (see deploy/README.md):
#   preflight → system → postgres → node → release <tar> <sha256> → keys → credentials → config
#   → systemd → cloudflared → firewall → verify     (start / backup are separate, owner-authorised)
# Never edits nginx / coturn / existing firewall input rules / journald / sshd.
set -Eeuo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/common.sh
source "$HERE/../lib/common.sh"
# shellcheck source=../lib/app.sh
source "$HERE/../lib/app.sh"

SB_USER=savebridge
SB_OPT=/opt/savebridge
SB_ETC=/etc/savebridge
SB_STATE=/var/lib/savebridge
SB_LOG=/var/log/savebridge
SB_PKG=@bridge/relayer
SB_CREDSTORE=/etc/credstore.encrypted
NEIGHBOURS=(nginx coturn)
BASELINE_DIR=/root/savebridge-baseline
PG_DB=savebridge

step="${1:-help}"; shift || true
sb_parse_common_flags "$@"
pos=(); for a in "$@"; do [[ "$a" == --* ]] || pos+=("$a"); done

step_preflight() {
  # read-only: baseline for the before/after comparison (stored once; later runs keep the first one)
  local f="$BASELINE_DIR/before.txt"
  # shellcheck disable=SC2016 # expanded by the inner sh
  sb_log "OS: $(probe sh -c '. /etc/os-release; echo "$PRETTY_NAME"')"
  sb_log "systemd: $(systemd_major)"
  for s in "${NEIGHBOURS[@]}"; do sb_log "$s: $(probe systemctl is-active "$s")"; done
  sb_log "free memory:"; probe free -m >&2
  sb_log "disk /:"; probe df -h / >&2
  if id "$SB_USER" >/dev/null 2>&1; then sb_log "user $SB_USER already exists: $(getent passwd "$SB_USER")"; fi
  for p in 5432 8080; do
    if probe ss -ltn "sport = :$p" | grep -q LISTEN; then sb_warn "port $p is already in use — check before continuing"; fi
  done
  if [[ "$SB_APPLY" == 1 ]]; then
    install -d -m 0700 "$BASELINE_DIR"
    if [[ -e "$f" ]]; then sb_log "baseline exists: $f (kept)"; else snapshot "$f" "${NEIGHBOURS[@]}"; sb_log "baseline written: $f"; fi
  else
    printf '[dry-run] write baseline snapshot (listeners, services, memory, swap, disk, firewall) to %s\n' "$f"
  fi
  cat >&2 <<'TXT'
Pre-deployment checklist (answer each before --apply on any other step):
  [ ] nginx and coturn are active and their listeners are in the baseline
  [ ] >= 700 MB available memory and >= 5 GB free disk on /
  [ ] no existing user/group named savebridge / savebridge-tunnel, ports 5432 / 8080 free on loopback
  [ ] outbound HTTPS (443) to nodejs.org, registry.npmjs.org, pkg.cloudflare.com, api.telegram.org, RPC providers works
  [ ] the owner is reachable for the authorisation gates (keys, start)
TXT
}

step_system() {
  require_root
  ensure_system_user "$SB_USER" "$SB_STATE"
  ensure_system_user savebridge-tunnel /nonexistent
  ensure_dir "$SB_ETC" 0750 "root:$SB_USER"
  ensure_dir "$SB_STATE" 0700 "$SB_USER:$SB_USER"
  ensure_dir "$SB_STATE/keystore" 0700 "$SB_USER:$SB_USER"
  ensure_dir "$SB_LOG" 0750 "$SB_USER:$SB_USER"
  ensure_dir /var/backups/savebridge 0700 "$SB_USER:$SB_USER"
  ensure_dir "$SB_CREDSTORE" 0700 root:root
  put_file /etc/logrotate.d/savebridge 0644 root:root <"$HERE/files/logrotate-savebridge"
  # 2 GB swap only if the host has none (does not change an existing swap setup)
  if [[ -n "$(probe swapon --noheadings --show)" ]]; then
    sb_log "swap already configured — left as is"
  elif [[ -e /swapfile.savebridge ]]; then
    sb_log "/swapfile.savebridge exists — enabling only"; run swapon /swapfile.savebridge
  else
    run fallocate -l 2G /swapfile.savebridge
    run chmod 600 /swapfile.savebridge
    run mkswap /swapfile.savebridge
    run swapon /swapfile.savebridge
    if ! grep -q '^/swapfile.savebridge ' /etc/fstab 2>/dev/null; then
      if [[ "$SB_APPLY" == 1 ]]; then cp -p /etc/fstab "/etc/fstab.savebridge-bak-$SB_TS"; echo '/swapfile.savebridge none swap sw 0 0' >>/etc/fstab; else echo '[dry-run] append "/swapfile.savebridge none swap sw 0 0" to /etc/fstab (backup first)'; fi
    fi
  fi
  printf 'vm.swappiness = 10\n' | put_file /etc/sysctl.d/90-savebridge-swappiness.conf 0644 root:root
  run sysctl -q -p /etc/sysctl.d/90-savebridge-swappiness.conf
  run apt-get update
  run apt-get install -y --no-install-recommends age curl gnupg xz-utils ca-certificates
}

step_postgres() {
  require_root
  run apt-get update
  run apt-get install -y --no-install-recommends postgresql
  local ver conf
  ver="$(probe sh -c "ls /etc/postgresql 2>/dev/null | sort -V | tail -1")"
  [[ -n "$ver" || "$SB_APPLY" != 1 ]] || sb_die "PostgreSQL config dir not found"
  ver="${ver:-17}"
  conf="/etc/postgresql/$ver/main/conf.d"
  ensure_dir "$conf" 0755 postgres:postgres
  put_file "$conf/90-savebridge.conf" 0644 postgres:postgres <"$HERE/files/postgresql-savebridge.conf"
  ensure_dir "/etc/systemd/system/postgresql@$ver-main.service.d" 0755 root:root
  put_file "/etc/systemd/system/postgresql@$ver-main.service.d/90-savebridge.conf" 0644 root:root <"$HERE/files/postgresql-override.conf"
  run systemctl daemon-reload
  run systemctl restart "postgresql@$ver-main"
  # role + database owned by the service user; peer authentication over the unix socket (no password)
  if [[ "$SB_APPLY" == 1 ]]; then
    if ! runuser -u postgres -- psql -tAc "select 1 from pg_roles where rolname='$SB_USER'" | grep -q 1; then runuser -u postgres -- createuser --no-superuser --no-createdb --no-createrole "$SB_USER"; fi
    if ! runuser -u postgres -- psql -tAc "select 1 from pg_database where datname='$PG_DB'" | grep -q 1; then runuser -u postgres -- createdb --owner="$SB_USER" "$PG_DB"; fi
    runuser -u postgres -- psql -tAc "show listen_addresses" | grep -qx 'localhost' || sb_die "listen_addresses is not localhost"
  else
    echo "[dry-run] createuser $SB_USER (no superuser) and createdb $PG_DB owned by it, if missing; assert listen_addresses = localhost"
  fi
}

step_config() {
  require_root
  local cfg="${pos[0]:-}"
  [[ -n "$cfg" && -f "$cfg" ]] || sb_die "usage: config <filled relayer.json> (from deploy/relayer.config.example.json; addresses from the key ceremony)"
  if grep -Eq '[0-9a-fA-F]{64}' "$cfg"; then sb_die "$cfg contains a 64-hex string (private key?) — refusing"; fi
  if grep -Eq '://' <(grep -v 'corsOrigins' "$cfg"); then sb_die "$cfg contains a URL outside corsOrigins — RPC URLs belong in rpc.env"; fi
  put_file "$SB_ETC/relayer.json" 0640 "root:$SB_USER" <"$cfg"
  if [[ ! -e "$SB_ETC/rpc.env" ]]; then
    put_file "$SB_ETC/rpc.env" 0600 root:root <"$HERE/files/rpc.env.example"
    sb_warn "edit $SB_ETC/rpc.env with the real RPC URLs (root-only file)"
  else
    sb_log "$SB_ETC/rpc.env exists (not shown, not changed)"; run chmod 0600 "$SB_ETC/rpc.env"; run chown root:root "$SB_ETC/rpc.env"
  fi
  [[ -s "$SB_ETC/backup-recipients.txt" ]] || sb_warn "put the owner's PUBLIC age recipient(s) in $SB_ETC/backup-recipients.txt"
}

step_systemd() {
  require_root
  put_file /etc/systemd/system/savebridge-relayer.service 0644 root:root <"$HERE/files/savebridge-relayer.service"
  put_file /etc/systemd/system/savebridge-backup.service 0644 root:root <"$HERE/files/savebridge-backup.service"
  put_file /etc/systemd/system/savebridge-backup.timer 0644 root:root <"$HERE/files/savebridge-backup.timer"
  if (( $(systemd_major) < 250 )) && [[ "$SB_APPLY" == 1 ]]; then sb_die "systemd < 250: LoadCredentialEncrypted unsupported (Debian 13 ships 257 — check the host)"; fi
  run systemctl daemon-reload
  if have systemd-analyze; then probe systemd-analyze security savebridge-relayer.service | tail -1 >&2; fi
  sb_log "units installed but NOT enabled / started (start is an owner-authorised step: '$0 start --apply')"
}

step_cloudflared() {
  require_root
  if ! have cloudflared; then
    ensure_dir /usr/share/keyrings 0755 root:root
    run sh -c 'curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg'
    sb_log "verify the key fingerprint: gpg --show-keys /usr/share/keyrings/cloudflare-main.gpg (compare with https://pkg.cloudflare.com/)"
    printf 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main\n' | put_file /etc/apt/sources.list.d/cloudflared.list 0644 root:root
    run apt-get update
    run apt-get install -y cloudflared
  else
    sb_log "cloudflared present: $(probe cloudflared --version)"
  fi
  ensure_dir /usr/local/lib/savebridge 0755 root:root
  put_file /usr/local/lib/savebridge/cloudflared-run.sh 0755 root:root <"$HERE/files/cloudflared-run.sh"
  put_file /etc/systemd/system/savebridge-cloudflared.service 0644 root:root <"$HERE/files/savebridge-cloudflared.service"
  run systemctl daemon-reload
  sb_log "store the tunnel token: '$0 credential cf-tunnel-token --apply' (Cloudflare side: see README §Cloudflare)"
}

step_firewall() {
  # Inbound rules are NEVER changed. Outbound: only checked; rules are added only if egress is filtered.
  local need=0
  if have ufw && probe ufw status verbose | grep -qi 'Status: active'; then
    if probe ufw status verbose | grep -qi 'deny (outgoing)\|reject (outgoing)'; then need=1; fi
  fi
  if have nft && probe nft list ruleset | grep -Eq 'hook output .*policy drop'; then need=2; fi
  if [[ "$need" == 0 ]]; then
    sb_log "egress is not filtered: no firewall change needed (inbound untouched)"
    return 0
  fi
  sb_warn "egress is filtered; outbound rules needed: tcp/443 (RPC, npm, nodejs.org, Telegram, Cloudflare), tcp+udp/7844 (cloudflared), udp/53, udp/123"
  if [[ "$need" == 1 ]]; then
    run ufw allow out 443/tcp comment savebridge
    run ufw allow out 7844 comment savebridge-cloudflared
    run ufw allow out 53/udp comment savebridge
    run ufw allow out 123/udp comment savebridge
  else
    sb_warn "nftables output policy drop: add the outbound rules above to YOUR ruleset by hand (this script does not edit nftables)"
  fi
}

step_start() {
  require_root
  [[ -f "$SB_ETC/relayer.json" ]] || sb_die "config missing"
  run systemctl enable --now savebridge-relayer.service
  run systemctl enable --now savebridge-backup.timer
  if [[ -e "$SB_CREDSTORE/cf-tunnel-token" ]]; then run systemctl enable --now savebridge-cloudflared.service; else sb_warn "tunnel token missing: cloudflared not started"; fi
}

step_verify() {
  local f="$BASELINE_DIR/after-$SB_TS.txt"
  probe systemctl --no-pager status savebridge-relayer.service | head -5 >&2
  for s in "${NEIGHBOURS[@]}"; do sb_log "$s: $(probe systemctl is-active "$s")"; done
  probe ss -ltnp "sport = :8080" >&2
  if probe ss -ltn | awk '{print $4}' | grep -E ':8080$' | grep -vqE '^(127\.0\.0\.1|\[::1\]):'; then sb_die "API is listening on a non-loopback address"; fi
  probe curl -fsS -m 10 http://127.0.0.1:8080/v1/quota >&2 || sb_warn "API /v1/quota not answering (check journalctl -u savebridge-relayer)"
  probe journalctl -u savebridge-relayer --since -10min --no-pager | grep -E '"event":"(signers_loaded|started|fatal|rpc_warning)"' >&2 || true
  probe systemctl show savebridge-relayer -p MemoryCurrent -p CPUUsageNSec >&2
  if [[ -e "$BASELINE_DIR/before.txt" ]]; then
    install -d -m 0700 "$BASELINE_DIR" 2>/dev/null || true
    snapshot "$f" "${NEIGHBOURS[@]}" 2>/dev/null || true
    if [[ -e "$f" ]]; then compare_listeners "$BASELINE_DIR/before.txt" "$f"; fi
  else
    sb_warn "no baseline found: run preflight --apply before deploying next time"
  fi
}

step_backup_keystore() {
  require_root
  backup_dir_age "$SB_STATE/keystore" "/var/backups/savebridge/keystore-$SB_TS.tar.age" "$SB_ETC/backup-recipients.txt"
  sb_log "copy it OFF the host (owner's machine); the keystore passphrases and the age identity are kept separately"
}

case "$step" in
  preflight) step_preflight ;;
  system) step_system ;;
  postgres) step_postgres ;;
  node) require_root; step_node ;;
  release) require_root; step_release "${pos[0]:-}" "${pos[1]:-}" ;;
  keys) require_root; for k in relayer-wantos relayer-bsc submitter; do step_keygen "$k"; done ;;
  credentials) require_root; for c in telegram-bot-token telegram-chat-id heartbeat-url; do put_credential "$c"; done ;;
  credential) require_root; put_credential "${pos[0]:-}" ;;
  config) step_config ;;
  systemd) step_systemd ;;
  cloudflared) step_cloudflared ;;
  firewall) step_firewall ;;
  start) step_start ;;
  verify) step_verify ;;
  backup-keystore) step_backup_keystore ;;
  *) sed -n '2,12p' "$0"; exit 2 ;;
esac
