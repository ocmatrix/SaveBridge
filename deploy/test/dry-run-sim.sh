#!/usr/bin/env bash
# Local simulation of the deploy scripts in DRY-RUN mode (no server, no network, no root).
# Every system command the scripts could call is replaced by a stub that only records its invocation;
# the test fails if any state-changing command was executed in dry-run, or if a guard does not fire.
#   bash deploy/test/dry-run-sim.sh            (needs bash >= 4)
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin"
LOG="$T/calls.log"
: >"$LOG"

# read-only probes allowed in dry-run (recorded but harmless)
for c in ss free df uptime getent nft ufw iptables journalctl systemd-analyze timedatectl; do
  printf '#!/bin/sh\necho "RO %s $*" >> "%s"\nexit 0\n' "$c" "$LOG" >"$T/bin/$c"
done
# commands that change state: must never run in dry-run
for c in useradd install chmod chown apt-get mkswap fallocate sysctl ln mv tar gpgv gpg runuser systemd-creds createuser createdb psql cp systemd-run sha256sum_never age; do
  printf '#!/bin/sh\necho "RW %s $*" >> "%s"\nexit 0\n' "$c" "$LOG" >"$T/bin/$c"
done
# systemctl / swapon: read-only sub-commands allowed, others are writes
cat >"$T/bin/systemctl" <<STUB
#!/bin/sh
for a in "\$@"; do case "\$a" in is-active|status|show|list-units|--version) echo "RO systemctl \$*" >> "$LOG"; [ "\$a" = --version ] && echo "systemd 257 (257.4-1)"; exit 0;; esac; done
echo "RW systemctl \$*" >> "$LOG"
STUB
cat >"$T/bin/curl" <<STUB
#!/bin/sh
case "\$*" in *http://127.0.0.1:*) echo "RO curl \$*" >> "$LOG"; exit 0;; esac
echo "RW curl \$*" >> "$LOG"
STUB
cat >"$T/bin/swapon" <<STUB
#!/bin/sh
case "\$*" in *--show*) echo "RO swapon \$*" >> "$LOG"; exit 0;; esac
echo "RW swapon \$*" >> "$LOG"
STUB
chmod +x "$T/bin/"*
export PATH="$T/bin:$PATH"

fail=0
check_no_writes() {
  if grep -q '^RW ' "$LOG"; then echo "FAIL [$1]: state-changing command executed in dry-run:"; grep '^RW ' "$LOG"; fail=1; else echo "ok   [$1]: dry-run executed no state-changing command"; fi
  : >"$LOG"
}
expect_fail() {
  local name="$1"; shift
  if "$@" >"$T/out" 2>&1; then echo "FAIL [$name]: expected a refusal"; fail=1; else echo "ok   [$name]: refused ($(grep -m1 -o 'ERROR: .*' "$T/out" | cut -c1-90))"; fi
  : >"$LOG"
}

SS="$ROOT/deploy/ss02-payout/deploy.sh"
RW="$ROOT/deploy/rpc3-watcher/deploy.sh"
for s in preflight system postgres node keys credentials systemd cloudflared firewall verify; do
  bash "$SS" "$s" >"$T/out" 2>&1 || { echo "FAIL [ss02 $s] exited non-zero:"; tail -5 "$T/out"; fail=1; }
  check_no_writes "ss02 $s"
done
for s in preflight system node keys credentials systemd verify; do
  bash "$RW" "$s" >"$T/out" 2>&1 || { echo "FAIL [rpc3 $s] exited non-zero:"; tail -5 "$T/out"; fail=1; }
  check_no_writes "rpc3 $s"
done

# config: the shipped templates pass the secret/URL guards in dry-run
if bash "$SS" config "$ROOT/deploy/relayer.config.example.json" >"$T/out" 2>&1; then check_no_writes "ss02 config template"; else echo "FAIL [ss02 config]"; cat "$T/out"; fail=1; fi
if bash "$RW" config "$ROOT/deploy/watcher.config.example.json" >"$T/out" 2>&1; then check_no_writes "rpc3 config template"; else echo "FAIL [rpc3 config]"; cat "$T/out"; fail=1; fi

# guards
printf '{"x":"0x%s"}\n' "$(printf '11%.0s' {1..32})" >"$T/leak.json"
expect_fail "config with a private key" bash "$SS" config "$T/leak.json"
printf '{"rpc":"https://bsc.example/key"}\n' >"$T/url.json"
expect_fail "config with an RPC URL" bash "$SS" config "$T/url.json"
expect_fail "rpc3 config with an RPC URL" bash "$RW" config "$T/url.json"
echo "not a release" >"$T/savebridge-test.tar.gz"
expect_fail "release with a wrong sha256" bash "$SS" release "$T/savebridge-test.tar.gz" 0000
expect_fail "release without args" bash "$SS" release
expect_fail "apply without root" bash "$SS" system --apply
expect_fail "rpc3 ack without key" bash "$RW" ack

# release with the right sha256: dry-run only prints
sha="$( (sha256sum "$T/savebridge-test.tar.gz" 2>/dev/null || shasum -a 256 "$T/savebridge-test.tar.gz") | awk '{print $1}')"
PATH="${PATH//$T\/bin:/}" bash "$SS" release "$T/savebridge-test.tar.gz" "$sha" >"$T/out" 2>&1 || { echo "FAIL [release ok sha]"; cat "$T/out"; fail=1; }
if grep -q '\[dry-run\] .*pnpm install --frozen-lockfile --ignore-scripts --filter @bridge/relayer...' "$T/out"; then echo "ok   [release]: verified sha256, dry-run plans a filtered frozen install"; else echo "FAIL [release plan]"; cat "$T/out"; fail=1; fi

# put_file: a differing existing file is never overwritten without --allow-overwrite
# shellcheck source=../lib/common.sh disable=SC2034
( source "$ROOT/deploy/lib/common.sh"; SB_APPLY=1; echo old >"$T/f"; if echo new | put_file "$T/f" 0644 "$(id -un):$(id -gn)" >/dev/null 2>&1; then echo "FAIL [put_file overwrite guard]"; exit 1; fi; [[ "$(cat "$T/f")" == old ]] && echo "ok   [put_file]: differing file kept without --allow-overwrite" ) || fail=1

exit "$fail"
