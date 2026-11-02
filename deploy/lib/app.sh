#!/usr/bin/env bash
# Steps shared by the payout (ss02) and watcher (rpc3) deployments. Sourced after common.sh.
# Callers set: SB_USER SB_OPT SB_ETC SB_STATE SB_PKG (e.g. @bridge/relayer) SB_CREDSTORE
# shellcheck shell=bash

NODE_VERSION="${NODE_VERSION:-22.20.0}"          # pin; re-check the latest 22.x LTS patch before deploying
NODE_DIST="https://nodejs.org/dist/v${NODE_VERSION}"
NODE_KEYRING_URL="${NODE_KEYRING_URL:-https://raw.githubusercontent.com/nodejs/release-keys/main/gpg-only-active-keys/pubring.kbx}"
PNPM_VERSION="10.34.5"                           # = repo's pinned pnpm

node_arch() {
  case "$(uname -m)" in
    x86_64|amd64) echo x64 ;;
    aarch64|arm64) echo arm64 ;;
    *) sb_die "unsupported architecture $(uname -m)" ;;
  esac
}

# Node 22 from the official tarball: GPG-verified SHASUMS256 (Node release keys) + sha256 of the tarball.
# Optional NODE_SHA256=<hex> pins the tarball hash (cross-checked on a second machine) and is enforced.
step_node() {
  local arch tar dir="/var/cache/savebridge-node" dest="/opt/node-v${NODE_VERSION}"
  arch="$(node_arch)"
  tar="node-v${NODE_VERSION}-linux-${arch}.tar.xz"
  if [[ -x "$dest/bin/node" ]] && [[ "$("$dest/bin/node" --version)" == "v${NODE_VERSION}" ]]; then
    sb_log "node v${NODE_VERSION} already installed at $dest"
  else
    ensure_dir "$dir" 0700 root:root
    run curl -fsSLo "$dir/$tar" "$NODE_DIST/$tar"
    run curl -fsSLo "$dir/SHASUMS256.txt.asc" "$NODE_DIST/SHASUMS256.txt.asc"
    run curl -fsSLo "$dir/node-release-keys.kbx" "$NODE_KEYRING_URL"
    run gpgv --keyring "$dir/node-release-keys.kbx" "$dir/SHASUMS256.txt.asc"
    sb_log "COMPARE the signing key fingerprint printed by gpgv with the list in https://github.com/nodejs/node#release-keys before continuing"
    if [[ "$SB_APPLY" == 1 ]]; then
      local want got
      # only lines inside the signed section (gpgv above verified it)
      want="$(sed -n '/^-----BEGIN PGP SIGNED MESSAGE-----$/,/^-----BEGIN PGP SIGNATURE-----$/p' "$dir/SHASUMS256.txt.asc" | awk -v f="$tar" '$2==f{print $1}')"
      got="$(sha256sum "$dir/$tar" | awk '{print $1}')"
      [[ -n "$want" && "$want" == "$got" ]] || sb_die "node tarball sha256 mismatch (signed list: ${want:-none}, file: $got)"
      if [[ -n "${NODE_SHA256:-}" && "$NODE_SHA256" != "$got" ]]; then sb_die "node tarball sha256 differs from the pinned NODE_SHA256"; fi
      sb_log "node tarball sha256 OK: $got"
    else
      printf '[dry-run] verify sha256(%s) against the GPG-verified SHASUMS256 (and NODE_SHA256 if set)\n' "$tar"
    fi
    run install -d -m 0755 "$dest"
    run tar -xJf "$dir/$tar" -C "$dest" --strip-components=1 --no-same-owner
  fi
  # corepack ships with Node; it verifies the pnpm package signature from the npm registry
  run env COREPACK_HOME=/opt/corepack "$dest/bin/corepack" prepare "pnpm@${PNPM_VERSION}" --activate
  run ln -sfn "$dest" /opt/node
}

# step_release TARBALL SHA256 : verify, unpack into $SB_OPT/releases/<name>, install deps of $SB_PKG only,
# then atomically switch $SB_OPT/current. The previous release is kept for rollback.
step_release() {
  local tarball="${1:-}" sha="${2:-}"
  [[ -n "$tarball" && -n "$sha" ]] || sb_die "usage: release <savebridge-<commit>.tar.gz> <sha256 from build-release.sh, received over a second channel>"
  [[ -f "$tarball" ]] || sb_die "$tarball not found"
  local got name rel
  got="$(sha256sum "$tarball" 2>/dev/null | awk '{print $1}' || shasum -a 256 "$tarball" | awk '{print $1}')"
  [[ "$got" == "$sha" ]] || sb_die "release sha256 mismatch: expected $sha, got $got"
  name="$(basename "$tarball" .tar.gz)"
  rel="$SB_OPT/releases/$name"
  ensure_dir "$SB_OPT" 0755 root:root
  ensure_dir "$SB_OPT/releases" 0755 root:root
  if [[ -d "$rel" ]]; then
    sb_log "release $name already unpacked"
  else
    run install -d -m 0755 "$rel"
    run tar -xzf "$tarball" -C "$rel" --strip-components=1 --no-same-owner
  fi
  # dependencies of the one package this host runs (+ its workspace deps); no install scripts.
  run env -C "$rel" COREPACK_HOME=/opt/corepack PATH="/opt/node/bin:$PATH" pnpm install --frozen-lockfile --ignore-scripts --filter "${SB_PKG}..."
  run chown -R root:root "$rel"
  run chmod -R go-w "$rel"
  if [[ -L "$SB_OPT/current" ]]; then sb_log "previous release: $(readlink "$SB_OPT/current") (kept for rollback: ln -sfn <it> $SB_OPT/current)"; fi
  run ln -sfn "$rel" "$SB_OPT/current.new"
  run mv -T "$SB_OPT/current.new" "$SB_OPT/current"
}

systemd_major() { systemctl --version 2>/dev/null | awk 'NR==1{print $2}' || echo 0; }

# put_credential NAME : reads a secret from the terminal (no echo, never argv / env / history) and stores it
# encrypted with the host credential key (systemd-creds, systemd >= 250) under $SB_CREDSTORE/NAME.
# On older systemd it falls back to a 0600 root-only file that the unit loads with LoadCredential=.
put_credential() {
  local name="$1" v1 v2
  [[ "$name" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$ ]] || sb_die "bad credential name"
  if [[ -e "$SB_CREDSTORE/$name" && "$SB_ALLOW_OVERWRITE" != 1 ]]; then sb_log "credential $name exists (use --allow-overwrite to replace)"; return 0; fi
  if [[ "$SB_APPLY" != 1 ]]; then printf '[dry-run] prompt (no echo) for credential %s and store it in %s/%s\n' "$name" "$SB_CREDSTORE" "$name"; return 0; fi
  [[ -t 0 ]] || sb_die "put-credential needs an interactive terminal"
  ensure_dir "$SB_CREDSTORE" 0700 root:root
  IFS= read -r -s -p "Value for $name: " v1; echo >&2
  IFS= read -r -s -p "Repeat: " v2; echo >&2
  [[ -n "$v1" && "$v1" == "$v2" ]] || { unset v1 v2; sb_die "empty or not matching"; }
  if [[ -e "$SB_CREDSTORE/$name" ]]; then cp -p "$SB_CREDSTORE/$name" "$SB_CREDSTORE/$name.savebridge-bak-$SB_TS"; fi
  if (( $(systemd_major) >= 250 )); then
    printf '%s' "$v1" | systemd-creds encrypt --name="$name" - "$SB_CREDSTORE/$name"
  else
    (umask 077; printf '%s' "$v1" >"$SB_CREDSTORE/$name")
  fi
  unset v1 v2
  chmod 0600 "$SB_CREDSTORE/$name"
  sb_log "stored credential $name"
}

# keygen NAME : passphrase typed twice (no echo) → stored as credential NAME-pass AND piped into
# savebridge-keygen running as $SB_USER, which writes $SB_STATE/keystore/NAME.json (0600) and prints
# ONLY the address / public key. Never overwrites an existing keystore.
step_keygen() {
  local name="$1" out="$SB_STATE/keystore/$1.json" p1 p2
  [[ "$name" =~ ^[a-z0-9][a-z0-9._-]{0,63}$ ]] || sb_die "bad key name"
  ensure_dir "$SB_STATE/keystore" 0700 "$SB_USER:$SB_USER"
  if [[ -e "$out" ]]; then sb_log "keystore $out exists — not touched (never overwritten)"; return 0; fi
  if [[ "$SB_APPLY" != 1 ]]; then printf '[dry-run] prompt passphrase for %s (>=16 chars, keep a copy OFFLINE), store credential %s-pass, run savebridge-keygen as %s -> %s\n' "$name" "$name" "$SB_USER" "$out"; return 0; fi
  [[ -t 0 ]] || sb_die "keygen needs an interactive terminal"
  IFS= read -r -s -p "Passphrase for $name (>=16 chars; write it down OFFLINE): " p1; echo >&2
  IFS= read -r -s -p "Repeat: " p2; echo >&2
  [[ ${#p1} -ge 16 && "$p1" == "$p2" ]] || { unset p1 p2; sb_die "passphrase too short or not matching"; }
  ensure_dir "$SB_CREDSTORE" 0700 root:root
  if (( $(systemd_major) >= 250 )); then
    printf '%s' "$p1" | systemd-creds encrypt --name="$name-pass" - "$SB_CREDSTORE/$name-pass"
  else
    (umask 077; printf '%s' "$p1" >"$SB_CREDSTORE/$name-pass")
  fi
  printf '%s' "$p1" | runuser -u "$SB_USER" -- env -i PATH=/opt/node/bin:/usr/bin:/bin HOME=/nonexistent \
    sh -c "cd '$SB_OPT/current/packages/ops' && exec node --import tsx src/keygenCli.ts create --out '$out' --label '$name'"
  unset p1 p2
  sb_log "record the address above in the deployment record; it goes into the config and the contracts"
}

# encrypted backup of a directory to the owner's age recipient(s); the age identity and the keystore
# passphrases are kept OFFLINE and SEPARATELY by the owner.
backup_dir_age() {
  local src="$1" out="$2" recipients="$3"
  [[ -s "$recipients" ]] || sb_die "age recipients file $recipients missing (owner's PUBLIC age key)"
  have age || sb_die "age is not installed"
  if [[ "$SB_APPLY" != 1 ]]; then printf '[dry-run] tar %s | age -R %s > %s\n' "$src" "$recipients" "$out"; return 0; fi
  (umask 077; tar -C "$(dirname "$src")" -cf - "$(basename "$src")" | age -R "$recipients" >"$out")
  sb_log "encrypted backup written: $out ($(stat -c %s "$out" 2>/dev/null || echo ?) bytes)"
}
