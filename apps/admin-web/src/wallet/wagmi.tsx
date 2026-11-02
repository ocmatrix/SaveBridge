import { createConfig, http, useConnect, useConnection, useConnectors, useDisconnect, type CreateConnectorFn } from "wagmi";
import { injected } from "wagmi/connectors";
import { getWalletClient, switchChain } from "wagmi/actions";
import type { Address, Hex, TypedDataDefinition } from "viem";
import type { Chains, Signer, WriteRequest } from "../lib/chain";

/**
 * Injected wallets only (MetaMask / Rabby / OKX / TP DApp browsers; hardware wallets through them). No hosted modal
 * → strict CSP. WalletConnect for a future multisig is a PR-6 open item (PR6-NOTES).
 */
export function createWagmiConfig(chains: Chains, connectors?: CreateConnectorFn[]) {
  const list = [chains.wantos.chain, chains.bsc.chain] as const;
  return createConfig({
    chains: list,
    connectors: connectors ?? [injected({ shimDisconnect: true })],
    transports: { [chains.wantos.chain.id]: http(chains.wantos.cfg.rpcUrl), [chains.bsc.chain.id]: http(chains.bsc.cfg.rpcUrl) },
    multiInjectedProviderDiscovery: true,
  });
}
export type AdminWagmiConfig = ReturnType<typeof createWagmiConfig>;

/** Signer over the connected wallet: switches chain before each chain-bound request; signing happens in the wallet. */
export function wagmiSigner(config: AdminWagmiConfig, address: Address): Signer {
  const onChain = async (chainId: number) => {
    await switchChain(config, { chainId: chainId as AdminWagmiConfig["chains"][number]["id"] });
    return getWalletClient(config, { chainId: chainId as AdminWagmiConfig["chains"][number]["id"], account: address });
  };
  return {
    address,
    async write(chainId: number, req: WriteRequest): Promise<Hex> {
      const wc = await onChain(chainId);
      return wc.writeContract({ address: req.address, abi: req.abi, functionName: req.functionName, args: req.args ?? [], account: address, chain: wc.chain });
    },
    async signTypedData(chainId: number, td: TypedDataDefinition): Promise<Hex> {
      const wc = await onChain(chainId);
      return wc.signTypedData({ ...(td as Parameters<typeof wc.signTypedData>[0]), account: address });
    },
    async signMessage(message: string): Promise<Hex> {
      const wc = await getWalletClient(config, { account: address });
      return wc.signMessage({ message, account: address });
    },
  };
}

export function WalletButtons() {
  const { status } = useConnection();
  const connectors = useConnectors();
  const { mutate: connect, isPending } = useConnect();
  const { mutate: disconnect } = useDisconnect();
  if (status === "connected") return <button type="button" onClick={() => disconnect()}>断开</button>;
  const announced = connectors.filter((c) => c.id !== "injected");
  const list = announced.length ? announced : connectors;
  return (
    <span>
      {list.map((c) => (
        <button key={c.uid} type="button" disabled={isPending} onClick={() => connect({ connector: c })}>
          连接 {c.name}
        </button>
      ))}
    </span>
  );
}
