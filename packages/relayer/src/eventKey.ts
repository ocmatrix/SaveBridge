import { encodeAbiParameters, keccak256, getAddress } from "viem";
import type { Address, Hex } from "./types";

/** PR1-NOTES §5.1 EVENT_KEY_TAG. */
export const EVENT_KEY_TAG = "WANTOS-BSC-BRIDGE-V2";

/**
 * PR1-NOTES §5.2:
 * eventKey = keccak256(abi.encode(string("WANTOS-BSC-BRIDGE-V2"), uint256 srcChainId, address srcBridge, uint256 srcEventNonce))
 * `to` and `amount` never participate.
 */
export function computeEventKey(srcChainId: bigint, srcBridge: Address, srcEventNonce: bigint): Hex {
  if (srcEventNonce < 1n) throw new Error("srcEventNonce must be >= 1 (ids start at 1)");
  return keccak256(
    encodeAbiParameters(
      [{ type: "string" }, { type: "uint256" }, { type: "address" }, { type: "uint256" }],
      [EVENT_KEY_TAG, srcChainId, getAddress(srcBridge), srcEventNonce],
    ),
  );
}

/** W2B: srcChainId = WANTOS chain id, srcBridge = WANTOS bridge proxy, nonce = orderId. */
export function w2bEventKey(a: { wantosChainId: bigint; wantosBridge: Address; orderId: bigint }): Hex {
  return computeEventKey(a.wantosChainId, a.wantosBridge, a.orderId);
}

/** B2W: srcChainId = BSC chain id (WANTOS `peerChainId`), srcBridge = BSC vault proxy, nonce = Deposited.nonce. */
export function b2wEventKey(a: { bscChainId: bigint; bscVault: Address; depositNonce: bigint }): Hex {
  return computeEventKey(a.bscChainId, a.bscVault, a.depositNonce);
}
