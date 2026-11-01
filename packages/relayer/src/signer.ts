import type { TransactionSerializableLegacy } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { Address, Hex } from "./types";

/**
 * Payout key abstraction (DESIGN §6.1): in production both payout keys live in a cloud KMS; the
 * relayer only ever sees the address and asks KMS to sign. No key material in code or config.
 */
export interface TxSigner {
  readonly address: Address;
  /** Returns the serialized signed transaction (raw). */
  signTransaction(tx: TransactionSerializableLegacy): Promise<Hex>;
}

/**
 * TEST ONLY: in-memory signer for local anvil tests (anvil dev keys or `generatePrivateKey()`).
 * Must never be wired in `main.ts` for a real chain.
 */
export class LocalTestSigner implements TxSigner {
  private readonly acct: PrivateKeyAccount;
  readonly address: Address;
  constructor(privateKey: Hex) {
    this.acct = privateKeyToAccount(privateKey);
    this.address = this.acct.address;
  }
  signTransaction(tx: TransactionSerializableLegacy): Promise<Hex> {
    return this.acct.signTransaction(tx);
  }
}

/**
 * Production KMS signer — interface placeholder.
 * TODO(PR-3 follow-up / ops): implement against the chosen cloud KMS (secp256k1 asymmetric key):
 *   1. `address` is derived once from the KMS public key and pinned in config (checked at startup).
 *   2. signTransaction: serialize the unsigned legacy tx (EIP-155, chainId set), keccak256 it,
 *      call KMS Sign(digest), parse DER (r,s), normalise s to the low half, recover v by trying
 *      both parities against `address`, then serialize with the signature.
 *   3. Every failure surfaces as an exception; TxSender turns it into a KMS_FAILURE alert.
 */
export class KmsSigner implements TxSigner {
  readonly address: Address;
  constructor(private readonly o: { keyId: string; address: Address }) {
    this.address = o.address;
  }
  async signTransaction(_tx: TransactionSerializableLegacy): Promise<Hex> {
    throw new Error(`KmsSigner(${this.o.keyId}): not implemented in PR-3 (interface only)`);
  }
}
