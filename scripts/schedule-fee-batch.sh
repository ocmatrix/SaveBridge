#!/bin/bash
# Plan A of docs/NATIVE-FEE-UPGRADE-RUNBOOK.md: schedule ONE timelock batch per chain
#   [ upgradeToAndCall(newImpl, 0x), setNativeFeeConfig(...) | setNativeFeeTiers(...) ]  with delay 172800 (48 h).
# The batch executes by itself when it is due (the relayer's auto-executor), so run this only when you mean it.
#
# usage:  SIGN="<cast signer flags>" bash scripts/schedule-fee-batch.sh bsc|wantos [--dry]
#   SIGN examples: "--ledger"   "--trezor"   "--account <keystore name>"   "--interactive"
#   --dry : checks, simulation from the admin address and the summary only; nothing is signed or sent.
set -euo pipefail
export PATH="$PATH:/Users/ark/.local/bin"
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy

CHAIN="${1:-}"; DRY="${2:-}"
PROXY=0x41e9900BF09553C46b6b3F267626FDa2b4711E44
TL=0xE962600e3F9c608Cf7E0e80aB450ffE63b563618
ADMIN=0x860f5B29f60F86c82b18f789E0219Cf966375669
RCPT=0xADCDe89431978C79ef66956Cfed67ac925426957
OLD_IMPL=0x668698e8683167f412550aea9d72537435176297
ZERO32=0x0000000000000000000000000000000000000000000000000000000000000000
SALT=0x19c272a3cd21e2d5f65d3a215901be4050033742c25c99dfe143def703496f25   # keccak("native-fee-batch-20261104")
DELAY=172800
SLOT=0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc

case "$CHAIN" in
  bsc)
    RPC=https://bsc-rpc.publicnode.com; NEW=0xdfeE8c9bc21d2a7bf9f0c8d55115135aF5634A59
    EXPECT_ID=0x10868fc9571a399a12b30d117f6af6f1b844d1077266a7540c25284009a7457b
    D2=$(cast calldata "setNativeFeeConfig(address,uint256)" "$RCPT" 50)
    D2_SIG="setNativeFeeConfig(address,uint256)"; D2_PREFIX=0x4fca6e8d ;;
  wantos)
    RPC=https://rpc3.wantos.io; NEW=0xcBa30ff023f576ffa915bA322b34D6A835F330B7
    EXPECT_ID=0x0c755dfaefab596b0983c5343282c7d0d47683a97ed5c5c30b8032d021e98d8f
    D2_SIG="setNativeFeeTiers((address,uint256,uint256,uint256,uint256,uint256,uint256,uint256))"
    D2=$(cast calldata "$D2_SIG" "($RCPT,200000000000000000000,1000000000000000000000,5000000000000000000000,2500000000000000000,12000000000000000000,50000000000000000000,120000000000000000000)")
    D2_PREFIX=0x33db5f5c ;;
  *) echo "usage: SIGN=\"--ledger\" bash $0 bsc|wantos [--dry]"; exit 2 ;;
esac
D1=$(cast calldata "upgradeToAndCall(address,bytes)" "$NEW" 0x)

say() { printf '\n== %s\n' "$*"; }
fail() { echo "STOP: $*"; exit 1; }

say "1. state of the chain ($CHAIN)"
IMPL_NOW=0x$(cast storage "$PROXY" "$SLOT" --rpc-url "$RPC" | cut -c27-66)
PAUSED=$(cast call "$PROXY" "paused()(bool)" --rpc-url "$RPC")
EPOCH=$(cast call "$TL" "epoch()(uint256)" --rpc-url "$RPC")
WLREC=$(cast call "$PROXY" "whitelistRecoveryActive()(bool)" --rpc-url "$RPC")
ADMREC=$(cast call "$TL" "adminRecoveryActive()(bool)" --rpc-url "$RPC")
ADMIN_ON=$(cast call "$TL" "adminWallet()(address)" --rpc-url "$RPC")
echo "current implementation : $IMPL_NOW"
echo "paused / epoch / whitelist recovery / admin recovery : $PAUSED / $EPOCH / $WLREC / $ADMREC"
echo "admin wallet on chain  : $ADMIN_ON"
[ "$(echo "$IMPL_NOW" | tr A-F a-f)" = "$OLD_IMPL" ] || fail "the live implementation is not the expected old one"
[ "$PAUSED" = "false" ] || fail "the bridge is paused: the batch would fail"
[ "$EPOCH" = "0" ] || fail "timelock epoch changed"
[ "$WLREC" = "false" ] && [ "$ADMREC" = "false" ] || fail "a recovery is in progress"
[ "$(echo "$ADMIN_ON" | tr A-F a-f)" = "$(echo "$ADMIN" | tr A-F a-f)" ] || fail "admin wallet differs from the expected one"
[ "$(cast code "$NEW" --rpc-url "$RPC")" != "0x" ] || fail "no code at the new implementation address"
[ "$(cast code "$RCPT" --rpc-url "$RPC")" = "0x" ] || fail "the fee recipient has contract code"

say "2. what will be proposed (CHECK EVERY LINE)"
echo "target (both calls)   : $PROXY   (the bridge proxy)"
echo "call 1                : upgradeToAndCall(newImplementation, 0x)   prefix ${D1:0:10}  (expect 0x4f1ef286)"
cast calldata-decode "upgradeToAndCall(address,bytes)" "$D1"
echo "call 2                : $D2_SIG   prefix ${D2:0:10}  (expect $D2_PREFIX)"
cast calldata-decode "$D2_SIG" "$D2"
echo "delay                 : $DELAY s (48 h)   salt $SALT"
[ "${D1:0:10}" = "0x4f1ef286" ] && [ "${D2:0:10}" = "$D2_PREFIX" ] || fail "unexpected calldata prefix"

say "3. operation id"
ID=$(cast call "$TL" "hashOperationBatch(address[],uint256[],bytes[],bytes32,bytes32)(bytes32)" "[$PROXY,$PROXY]" "[0,0]" "[$D1,$D2]" "$ZERO32" "$SALT" --rpc-url "$RPC")
echo "computed : $ID"; echo "expected : $EXPECT_ID"
[ "$ID" = "$EXPECT_ID" ] || fail "operation id differs from the prepared one"
[ "$(cast call "$TL" "isOperation(bytes32)(bool)" "$ID" --rpc-url "$RPC")" = "false" ] || fail "this operation already exists on chain"

say "4. simulation from the admin address (no signature, no gas)"
cast call --from "$ADMIN" "$TL" "scheduleBatch(address[],uint256[],bytes[],bytes32,bytes32,uint256)" "[$PROXY,$PROXY]" "[0,0]" "[$D1,$D2]" "$ZERO32" "$SALT" "$DELAY" --rpc-url "$RPC" >/dev/null && echo "OK: the call would succeed"

if [ "$DRY" = "--dry" ]; then echo; echo "DRY RUN finished: nothing was signed or sent."; exit 0; fi
[ -n "${SIGN:-}" ] || fail "set SIGN to your cast signer flags, e.g. SIGN=\"--ledger\""

printf '\nThis starts the 48 h countdown on %s. When it is due the relayer executes it by itself.\nType YES to sign and send: ' "$CHAIN"
read -r ANSWER
[ "$ANSWER" = "YES" ] || fail "not confirmed"

say "5. sending (sign on your wallet)"
# shellcheck disable=SC2086
cast send "$TL" "scheduleBatch(address[],uint256[],bytes[],bytes32,bytes32,uint256)" "[$PROXY,$PROXY]" "[0,0]" "[$D1,$D2]" "$ZERO32" "$SALT" "$DELAY" --rpc-url "$RPC" --from "$ADMIN" $SIGN

say "6. check on chain"
sleep 3
echo "pending : $(cast call "$TL" "isOperationPending(bytes32)(bool)" "$ID" --rpc-url "$RPC")   (expect true)"
TS=$(cast call "$TL" "getTimestamp(bytes32)(uint256)" "$ID" --rpc-url "$RPC" | awk '{print $1}')
echo "due at  : $TS  =  $(date -r "$TS" '+%Y-%m-%d %H:%M:%S %Z')   (now $(date '+%Y-%m-%d %H:%M:%S %Z'))"
echo "Tell Claude the transaction hash above and run the other chain right away."
