#!/usr/bin/env bash
# Mainnet contract deployment for ONE chain (Deploy.s.sol, deployer EOA nonces 0/1/2). DRY-RUN unless --broadcast.
#   deploy/mainnet/deploy-contracts.sh bsc|wantos [--broadcast]
# Refuses to run unless: params file sha256 == the frozen hash below, deployer nonce == 0, predicted addresses
# have no code, deployer balance >= 3x the simulated cost. The keystore password is typed by the OWNER into
# forge's prompt (never passed on argv / env). Per-tx: --slow (wait for each tx before the next).
set -Eeuo pipefail
cd "$(git rev-parse --show-toplevel)"
side="${1:-}"; mode="${2:-}"
case "$side" in
  bsc)    RPC="${BSC_DEPLOY_RPC:-https://bsc-rpc.publicnode.com}"; CHAIN=56
          FROZEN=0cebc67aa62739b15ccc3b385f5545d657bd01f123005710d8685f71d96f502f ;;
  wantos) RPC="${WANTOS_DEPLOY_RPC:-https://rpc3.wantos.io}"; CHAIN=13555
          FROZEN=6067cc2a227707e649c42ad1529319a0eea3aaaf429cde07415e8c31330bfb71 ;;
  *) sed -n '2,7p' "$0"; exit 2 ;;
esac
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy; export NO_PROXY='*'
F="docs/deploy-params/$side.env"
got="$(shasum -a 256 "$F" | awk '{print $1}')"
[[ "$got" == "$FROZEN" ]] || { echo "REFUSED: $F hash $got != frozen $FROZEN" >&2; exit 1; }
set -a; source "$F"; set +a
[[ "$(cast chain-id --rpc-url "$RPC")" == "$CHAIN" ]] || { echo "REFUSED: RPC is not chain $CHAIN" >&2; exit 1; }
nonce="$(cast nonce "$DEPLOYER" --rpc-url "$RPC")"; [[ "$nonce" == 0 ]] || { echo "REFUSED: deployer nonce is $nonce, must be 0" >&2; exit 1; }
for n in 0 1 2; do
  a="$(cast compute-address "$DEPLOYER" --nonce "$n" | awk '{print $NF}')"
  [[ "$(cast code "$a" --rpc-url "$RPC")" == 0x ]] || { echo "REFUSED: predicted address $a already has code" >&2; exit 1; }
done
bal="$(cast balance "$DEPLOYER" --rpc-url "$RPC")"; echo "deployer balance (wei): $bal"
args=(contracts/script/Deploy.s.sol --rpc-url "$RPC" --sender "$DEPLOYER")
if [[ "$mode" == "--broadcast" ]]; then
  echo "BROADCAST on chain $CHAIN. Enter the deployer keystore password when asked (typed by the owner)."
  exec forge script "${args[@]}" --broadcast --slow --keystore "$HOME/.savebridge-deployer-new/deployer-20261103"
fi
echo "[dry-run] simulation only (add --broadcast to send):"
forge script "${args[@]}" 2>&1 | grep -E "Script ran|Error|revert|Estimated|timelock|proxy" | cut -c1-220
