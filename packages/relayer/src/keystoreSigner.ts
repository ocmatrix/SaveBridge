import type { TransactionSerializableLegacy } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { loadKeystoreAccount } from "@bridge/ops";
import type { TxSigner } from "./signer";
import type { Address, Hex } from "./types";

/**
 * Production interim signer (deploy-prep, until AWS KMS): the key lives in an AES-256-GCM / scrypt
 * keystore file on the payout server and is decrypted into memory once at startup
 * (`@bridge/ops` keystore). Implements the unchanged `TxSigner` interface; the sender's existing
 * KMS_FAILURE path turns every refusal / failure here into an alert (fail-closed: nothing is sent).
 *
 * Extra guards (defence in depth, cheap): only EIP-155 legacy transactions, only the chain ids this
 * key is configured for, all fee/nonce/gas fields explicit.
 */
export class LocalKeystoreSigner implements TxSigner {
  readonly address: Address;
  private readonly chainIds: ReadonlySet<number>;

  private constructor(
    private readonly acct: PrivateKeyAccount,
    allowedChainIds: readonly number[],
  ) {
    this.address = acct.address;
    this.chainIds = new Set(allowedChainIds);
  }

  /** Reads + decrypts the keystore, pins `expectedAddress`, wipes `passphrase`. Throws (fail-closed) on any mismatch. */
  static async load(o: { keystorePath: string; passphrase: Buffer; expectedAddress: Address; allowedChainIds: readonly number[]; minN?: number }): Promise<LocalKeystoreSigner> {
    if (o.allowedChainIds.length === 0) {
      o.passphrase.fill(0);
      throw new Error("LocalKeystoreSigner: at least one allowed chain id is required");
    }
    const acct = await loadKeystoreAccount({ path: o.keystorePath, passphrase: o.passphrase, expectedAddress: o.expectedAddress, minN: o.minN });
    return new LocalKeystoreSigner(acct, o.allowedChainIds);
  }

  async signTransaction(tx: TransactionSerializableLegacy): Promise<Hex> {
    const t = tx as TransactionSerializableLegacy & Record<string, unknown>;
    if (t.type !== undefined && t.type !== "legacy") throw new Error(`LocalKeystoreSigner: refusing non-legacy transaction type ${String(t.type)}`);
    for (const f of ["maxFeePerGas", "maxPriorityFeePerGas", "accessList", "authorizationList", "blobVersionedHashes"])
      if (t[f] !== undefined) throw new Error(`LocalKeystoreSigner: refusing field ${f} on a legacy transaction`);
    if (typeof tx.chainId !== "number" || !this.chainIds.has(tx.chainId))
      throw new Error(`LocalKeystoreSigner: refusing chainId ${String(tx.chainId)} (EIP-155 chain id required; allowed ${[...this.chainIds].join(",")})`);
    if (tx.nonce === undefined || tx.gas === undefined || tx.gasPrice === undefined) throw new Error("LocalKeystoreSigner: nonce, gas and gasPrice must be explicit");
    return this.acct.signTransaction({ ...tx, type: "legacy" });
  }
}
