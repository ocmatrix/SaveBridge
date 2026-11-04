import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  getContractAddress,
  keccak256,
  parseAbiItem,
  zeroAddress,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { tokenAbi } from "../chain";
import { TL_ABI, abiOf, tok, type Ctx } from "../ctx";
import type { Side } from "../guard";

export const REPO = resolve(import.meta.dirname, "../../../../..");
const SIDES: Side[] = ["wantos", "bsc"];

export function fastArtifact(file: string, name: string): { abi: Abi; bytecode: Hex; deployed: Hex; immutableRefs: Record<string, { start: number; length: number }[]> } {
  const p = join(REPO, "out-fast", `${file}.sol`, `${name}.json`);
  if (!existsSync(p)) throw new Error(`missing ${p}: run the build stage`);
  const j = JSON.parse(readFileSync(p, "utf8")) as { abi: Abi; bytecode: { object: Hex }; deployedBytecode: { object: Hex; immutableReferences?: Record<string, { start: number; length: number }[]> } };
  return { abi: j.abi, bytecode: j.bytecode.object, deployed: j.deployedBytecode.object, immutableRefs: j.deployedBytecode.immutableReferences ?? {} };
}

/** Fast windows (seconds) the rehearsal relies on; checked against the deployed contracts in V13. */
export const FAST = { minDelay: 120, maxDelay: 420, expiry: 840, pendingAdminTtl: 420, adminRecovery: 840, cooldown: 180, sigTtl: 600, wlTransfer: 120, wlTransferTtl: 420, wlRecovery: 420, refund: 180 };

// ------------------------------------------------------------------ stage: build
export async function stageBuild(ctx: Ctx): Promise<void> {
  const run = (cmd: string, args: string[], env: Record<string, string> = {}) =>
    execFileSync(cmd, args, { cwd: REPO, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 << 20 }).toString();
  const gen = run("node", ["scripts/make-fast-variant.mjs"]);
  ctx.check("B1", "快速版生成（替换点计数全部吻合）", /substitutions applied/.test(gen), gen.split("\n").filter((l) => l.startsWith("make-fast-variant")).join(" "));
  const chk = run("node", ["scripts/check-fast-variant.mjs"]);
  ctx.check("B2", "快速版 = 主源码 + 清单替换 + chainid 防呆（逐字节 diff）", chk.includes("OK"), chk.trim());
  run("forge", ["build"], { FOUNDRY_PROFILE: "fast" });
  ctx.check("B3", "FOUNDRY_PROFILE=fast forge build → out-fast", existsSync(join(REPO, "out-fast/BscVaultV2.sol/BscVaultV2.json")));
}

// ------------------------------------------------------------------ stage: deploy
export async function stageDeploy(ctx: Ctx): Promise<void> {
  const { chains, keys, cfg } = ctx;
  if (ctx.state.deployment) {
    ctx.note("already deployed in this run dir; skipping (delete the run dir to start over)");
    ctx.check("D0", "已部署（续跑）", true, ctx.state.deployment.proxy);
    return;
  }
  const funder = keys.role("funder");
  const deployer = keys.role("deployer");
  // gas (local only; testnet balances are checked by the preflight, never auto-sent)
  const all = [...Object.values(keys.addresses())] as Address[];
  if (cfg.profile === "local") {
    for (const s of SIDES) for (const a of all) await chains[s].setBalance(a, BigInt(cfg.gasWei.role));
  } else {
    // testnet: the funder (filled by Testor / faucet after the owner's authorization) tops up every test key
    const users = new Set(keys.users(1, 100).map((u) => u.address));
    for (const s of SIDES) {
      const top: Array<{ to: Address; value: bigint }> = [];
      for (const a of all) {
        if (a === funder.address) continue;
        const need = BigInt(users.has(a) ? cfg.gasWei.user : cfg.gasWei.role);
        if ((await chains[s].pub.getBalance({ address: a })) < need / 2n) top.push({ to: a, value: need });
      }
      const total = top.reduce((x, t) => x + t.value, 0n);
      const have = await chains[s].pub.getBalance({ address: funder.address });
      ctx.check(`D0-gas-${s}`, `${s} 资助钱包余额足够给 ${top.length} 个测试钥匙补 gas`, have > total, `need ${total} wei, funder ${have} wei`);
      await chains[s].sendMany(funder, top);
    }
  }
  for (const s of SIDES) {
    const n = await chains[s].pub.getTransactionCount({ address: deployer.address });
    ctx.check(`D1-${s}`, `${s} 部署者 nonce = 0`, n === 0, `nonce ${n}`);
  }
  const pred = { timelock: getContractAddress({ from: deployer.address, nonce: 0n }), implementation: getContractAddress({ from: deployer.address, nonce: 1n }), proxy: getContractAddress({ from: deployer.address, nonce: 2n }) };
  for (const s of SIDES) {
    const codes = await Promise.all(Object.values(pred).map((a) => chains[s].pub.getCode({ address: a })));
    ctx.check(`D2-${s}`, `${s} 预测地址 n/n+1/n+2 无代码`, codes.every((c) => !c || c === "0x"));
  }

  // test USDT (18 decimals) on both chains, deployed by the funder (keeps the deployer at nonce 0)
  const mock = fastArtifact("MockToken", "MockToken");
  const token: Record<Side, Address> = { wantos: zeroAddress, bsc: zeroAddress };
  for (const s of SIDES) {
    const pre = cfg.chains[s].token;
    if (pre) token[s] = getAddress(pre);
    else {
      const r = await chains[s].send(funder, null, mock.bytecode);
      token[s] = getAddress(r.receipt.contractAddress!);
    }
    const dec = await chains[s].read<number>(token[s], tokenAbi, "decimals");
    ctx.check(`D3-${s}`, `${s} 测试 USDT decimals = 18`, Number(dec) === 18, token[s]);
  }
  // WANTON circulating test supply exists before deployment: supplyCeiling = totalSupply + headroom
  const mint = (to: Address, amount: bigint) => ({ to: token.wantos, data: encodeFunctionData({ abi: tokenAbi, functionName: "mint", args: [to, amount] }) });
  await chains.wantos.sendMany(funder, [...keys.users(1, 100).map((u) => mint(u.address, tok(5_000))), mint(funder.address, tok(cfg.reserves.wantos + 50_000))]);
  const supply = await chains.wantos.read<bigint>(token.wantos, tokenAbi, "totalSupply");
  const supplyCeiling = supply + tok(cfg.params.supplyHeadroom);

  const p = cfg.params;
  const env = (s: Side): Record<string, string> => ({
    FOUNDRY_PROFILE: "fast",
    ETH_RPC_URL: chains[s].url,
    SIDE: s === "bsc" ? "BSC" : "WANTOS",
    DEPLOYER: deployer.address,
    PR9_DEPLOYER_KEY: keys.file.roles.deployer,
    ADMIN_WALLET: keys.role("admin").address,
    WHITELIST_MANAGER: keys.role("wl").address,
    RELAYER: keys.role(s === "bsc" ? "bscRelayer" : "wantosRelayer").address,
    PAUSER: keys.role("pauser").address,
    TOKEN: token[s],
    PEER_CHAIN_ID: String(cfg.chains[s === "bsc" ? "wantos" : "bsc"].chainId),
    DAILY_CAP: tok(p.bsc.dailyCap).toString(),
    PER_ADDR_DAILY_CAP: tok(p.bsc.perAddrDailyCap).toString(),
    LARGE_THRESHOLD: tok(p.bsc.largeThreshold).toString(),
    RELEASE_DELAY: String(p.bsc.releaseDelaySec),
    MIN_DEPOSIT: tok(p.bsc.minDeposit).toString(),
    MAX_DEPOSIT_PER_TX: tok(p.bsc.maxDepositPerTx).toString(),
    W2B_MIN_AMOUNT: tok(p.wantos.w2bMinAmount).toString(),
    W2B_PER_ADDR_DAILY_CAP: tok(p.wantos.w2bPerAddrDailyCap).toString(),
    B2W_DAILY_CAP: tok(p.wantos.b2wDailyCap).toString(),
    B2W_DELAY: String(p.wantos.b2wDelaySec),
    SUPPLY_CEILING: supplyCeiling.toString(),
  });
  const forge = (s: Side, broadcast: boolean, extra: Record<string, string> = {}) => {
    const args = ["script", "contracts/testnet-fast/script/DeployFast.s.sol:DeployFast", "--rpc-url", chains[s].url, ...(broadcast ? ["--broadcast", "--slow"] : []), "--non-interactive"];
    return execFileSync("forge", args, { cwd: REPO, env: { ...process.env, ...env(s), ...extra }, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 << 20 }).toString();
  };
  // §3.2 failure rule, simulation only: a used (nonce ≠ 0) deployer is refused before anything is sent
  let refused = "";
  try {
    forge("bsc", false, { DEPLOYER: funder.address, PR9_DEPLOYER_KEY: keys.file.roles.funder });
  } catch (e) {
    const x = e as { stderr?: Buffer; stdout?: Buffer };
    refused = `${x.stdout?.toString() ?? ""}${x.stderr?.toString() ?? ""}${String(e)}`;
  }
  ctx.check("D4", "失败规程：nonce≠0 的部署者被 DeployFast 拒绝（只模拟，不广播）", /nonce must be 0/.test(refused), refused.match(/Deploy[^\n"]*nonce must be 0/)?.[0] ?? refused.slice(-300));

  const deployBlock = { wantos: "0", bsc: "0" } as Record<Side, string>;
  for (const s of ["bsc", "wantos"] as Side[]) {
    deployBlock[s] = (await chains[s].pub.getBlockNumber()).toString();
    const out = forge(s, true);
    ctx.check(`D5-${s}`, `${s} DeployFast 广播成功（timelock → 实现 → 代理+初始化）`, /ONCHAIN EXECUTION COMPLETE|Script ran successfully/.test(out));
  }
  for (const s of SIDES) {
    const n = await chains[s].pub.getTransactionCount({ address: deployer.address });
    const code = await chains[s].pub.getCode({ address: pred.proxy });
    ctx.check(`D6-${s}`, `${s} 三笔交易 nonce 0/1/2，代理在预测地址`, n === 3 && !!code && code.length > 2, pred.proxy);
  }
  ctx.state.deployment = { deployer: deployer.address, ...pred, token, deployBlock, supplyCeiling: supplyCeiling.toString() };
  ctx.save();
  ctx.check("D7", "两链代理地址完全相同", true, pred.proxy);
  ctx.note(`部署者 ${deployer.address} 之后不再使用（不持有任何角色）；结束时随运行目录一起销毁`);
}

// ------------------------------------------------------------------ stage: verify (PR-10 V1–V14 on the fast build)
export async function stageVerify(ctx: Ctx): Promise<void> {
  const { chains, keys, cfg } = ctx;
  const d = ctx.d;
  const ROLE0 = `0x${"00".repeat(32)}` as Hex;
  const RELAYER_ROLE = keccak256(new TextEncoder().encode("RELAYER_ROLE"));
  const PAUSER_ROLE = keccak256(new TextEncoder().encode("PAUSER_ROLE"));
  const roleGranted = parseAbiItem("event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)");
  const grantsOf = async (s: Side, at: Address, role: Hex): Promise<Address[]> => {
    const logs = await chains[s].pub.getLogs({ address: at, event: roleGranted, args: { role }, fromBlock: BigInt(d.deployBlock[s]), toBlock: "latest" });
    return logs.map((l) => getAddress(l.args.account!));
  };
  const implName = (s: Side) => (s === "bsc" ? "BscVaultV2" : "WantosBridgeV2");
  const mask = (code: Hex, refs: Record<string, { start: number; length: number }[]>): string => {
    const b = code.slice(2).split("");
    for (const rs of Object.values(refs)) for (const r of rs) for (let i = r.start * 2; i < (r.start + r.length) * 2; i++) b[i] = "0";
    return b.join("");
  };
  const codeHashes: Record<Side, Hex> = { wantos: "0x", bsc: "0x" };
  for (const s of SIDES) {
    const c = chains[s];
    const t = (fn: string, args: unknown[] = []) => c.read<unknown>(d.timelock, TL_ABI, fn, args);
    const b = (fn: string, args: unknown[] = []) => c.read<unknown>(d.proxy, abiOf(s), fn, args);
    // V1
    ctx.check(`V1-${s}`, "三个地址与预测一致（两链一致）", d.timelock === getContractAddress({ from: d.deployer, nonce: 0n }) && d.proxy === getContractAddress({ from: d.deployer, nonce: 2n }));
    // V2
    const slot = await c.pub.getStorageAt({ address: d.proxy, slot: "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" });
    const impl = getAddress(`0x${slot!.slice(26)}`);
    const art = fastArtifact(implName(s), implName(s));
    const onchain = (await c.pub.getCode({ address: impl }))!;
    codeHashes[s] = keccak256(onchain);
    ctx.check(`V2-${s}`, "代理实现 = nonce1；实现字节码与 out-fast 重放一致（屏蔽 immutable）", impl === d.implementation && mask(onchain, art.immutableRefs) === mask(art.deployed, art.immutableRefs), `codehash ${codeHashes[s]}, initcode keccak ${keccak256(art.bytecode)}`);
    // V3
    const admins = await grantsOf(s, d.proxy, ROLE0);
    ctx.check(`V3-${s}`, "DEFAULT_ADMIN_ROLE 只授给时间锁", admins.length === 1 && admins[0] === d.timelock && (await b("hasRole", [ROLE0, d.timelock])) === true);
    // V4
    const proposers = await grantsOf(s, d.timelock, (await t("PROPOSER_ROLE")) as Hex);
    const executors = await grantsOf(s, d.timelock, (await t("EXECUTOR_ROLE")) as Hex);
    const tlAdmins = await grantsOf(s, d.timelock, ROLE0);
    ctx.check(
      `V4-${s}`,
      "时间锁：提议人恰好一个=管理钱包、执行人=任何人、admin 只有自身、bridge=代理",
      proposers.length === 1 && proposers[0] === keys.role("admin").address && executors.length === 1 && executors[0] === zeroAddress && tlAdmins.every((a) => a === d.timelock) && getAddress((await t("bridge")) as Address) === d.proxy,
      `proposers ${proposers.join(",")}`,
    );
    // V5
    const relayers = await grantsOf(s, d.proxy, RELAYER_ROLE);
    const pausers = await grantsOf(s, d.proxy, PAUSER_ROLE);
    const relayerKey = keys.role(s === "bsc" ? "bscRelayer" : "wantosRelayer").address;
    ctx.check(
      `V5-${s}`,
      "adminWallet / whitelistManager 与输入一致；付款钥匙、暂停钥匙各恰好一个",
      getAddress((await b("adminWallet")) as Address) === keys.role("admin").address && getAddress((await b("whitelistManager")) as Address) === keys.role("wl").address && relayers.length === 1 && relayers[0] === relayerKey && pausers.length === 1 && pausers[0] === keys.role("pauser").address,
    );
    // V6
    const four = [keys.role("admin").address, keys.role("wl").address, relayerKey, keys.role("pauser").address];
    ctx.check(`V6-${s}`, "四类钥匙两两不同", new Set(four).size === 4);
    // V7
    const sample = keys.users(1, 3).map((u) => u.address);
    const wls = await Promise.all(sample.map((a) => b("whitelisted", [a])));
    ctx.check(`V7-${s}`, "白名单为空（whitelistNonce=0，抽样地址均未开通）", (await b("whitelistNonce")) === 0n && wls.every((x) => x === false));
    // V8
    const params = (await b("params")) as Record<string, bigint>;
    const p = cfg.params;
    const okParams =
      s === "bsc"
        ? params.dailyCap === tok(p.bsc.dailyCap) && params.perAddrDailyCap === tok(p.bsc.perAddrDailyCap) && params.largeThreshold === tok(p.bsc.largeThreshold) && params.releaseDelay === BigInt(p.bsc.releaseDelaySec) && params.minDeposit === tok(p.bsc.minDeposit) && params.maxDepositPerTx === tok(p.bsc.maxDepositPerTx)
        : params.w2bMinAmount === tok(p.wantos.w2bMinAmount) && params.w2bPerAddrDailyCap === tok(p.wantos.w2bPerAddrDailyCap) && params.b2wDailyCap === tok(p.wantos.b2wDailyCap) && params.b2wDelay === BigInt(p.wantos.b2wDelaySec) && (await b("supplyCeiling")) === BigInt(d.supplyCeiling);
    const peer = s === "bsc" ? "wantos" : "bsc";
    ctx.check(`V8-${s}`, "params / supplyCeiling / peerChainId / peerBridge 与部署参数一致", okParams && (await b("peerChainId")) === BigInt(cfg.chains[peer].chainId) && getAddress((await b("peerBridge")) as Address) === d.proxy);
    // V9
    ctx.check(`V9-${s}`, "未暂停、无恢复、未冻结、pendingAdmin 空", (await b("paused")) === false && (await b("anyRecoveryActive")) === false && (await b("whitelistFrozen")) === false && (await t("pendingAdmin")) === zeroAddress);
    // V10
    ctx.check(`V10-${s}`, "token() 正确且 decimals=18（两链一致）", getAddress((await b("token")) as Address) === d.token[s] && Number(await c.read(d.token[s], tokenAbi, "decimals")) === 18);
    // V11
    ctx.check(`V11-${s}`, "桥合约 USDT 余额 = 0（尚未注资）", (await ctx.tokenBalance(s, d.proxy)) === 0n);
    // V12
    const dep = d.deployer;
    const depRoles = await Promise.all([b("hasRole", [ROLE0, dep]), b("hasRole", [RELAYER_ROLE, dep]), b("hasRole", [PAUSER_ROLE, dep]), t("hasRole", [ROLE0, dep]), t("hasRole", [await t("PROPOSER_ROLE"), dep])]);
    ctx.check(`V12-${s}`, "部署者 EOA 不持有任何角色", depRoles.every((x) => x === false));
    // V13
    const w = await Promise.all(["MIN_DELAY", "getMinDelay", "MAX_DELAY", "EXPIRY_PERIOD", "ADMIN_RECOVERY_DELAY"].map((f) => t(f)));
    ctx.check(`V13-${s}`, "时间锁延迟 = 快速版 2 分钟（MAX 7 分 / 过期 14 分）—— 测试网专用值，非主网 48h", w.map(Number).join() === [FAST.minDelay, FAST.minDelay, FAST.maxDelay, FAST.expiry, FAST.adminRecovery].join(), w.join("/"));
    // V14
    const u = keys.user(1);
    const r = s === "wantos" ? await ctx.reverts("wantos", u, "bridgeOut", [tok(20)]) : await ctx.reverts("bsc", keys.role("bscRelayer"), "release", [1n, u.address, tok(20)]);
    ctx.check(`V14-${s}`, "空白名单实测（只读模拟）：bridgeOut / release 被拒", r === "NotWhitelisted", r);
  }
  // the PR-1 acceptance script (fast copy) as a second, independent implementation
  for (const s of SIDES) {
    const p = cfg.params;
    const enc =
      s === "bsc"
        ? encodeAbiParameters([{ type: "tuple", components: ["dailyCap", "perAddrDailyCap", "largeThreshold", "releaseDelay", "minDeposit", "maxDepositPerTx"].map((n) => ({ name: n, type: "uint256" })) }], [{ dailyCap: tok(p.bsc.dailyCap), perAddrDailyCap: tok(p.bsc.perAddrDailyCap), largeThreshold: tok(p.bsc.largeThreshold), releaseDelay: BigInt(p.bsc.releaseDelaySec), minDeposit: tok(p.bsc.minDeposit), maxDepositPerTx: tok(p.bsc.maxDepositPerTx) }])
        : encodeAbiParameters([{ type: "tuple", components: ["w2bMinAmount", "w2bPerAddrDailyCap", "b2wDailyCap", "b2wDelay"].map((n) => ({ name: n, type: "uint256" })) }], [{ w2bMinAmount: tok(p.wantos.w2bMinAmount), w2bPerAddrDailyCap: tok(p.wantos.w2bPerAddrDailyCap), b2wDailyCap: tok(p.wantos.b2wDailyCap), b2wDelay: BigInt(p.wantos.b2wDelaySec) }]);
    const out = execFileSync("forge", ["script", "contracts/testnet-fast/script/Verify.s.sol:Verify", "--rpc-url", chains[s].url, "--non-interactive"], {
      cwd: REPO,
      env: {
        ...process.env,
        FOUNDRY_PROFILE: "fast",
        ETH_RPC_URL: chains[s].url,
        SIDE: s === "bsc" ? "BSC" : "WANTOS",
        DEPLOYER: d.deployer,
        TIMELOCK: d.timelock,
        IMPLEMENTATION: d.implementation,
        IMPLEMENTATION_CODEHASH: codeHashes[s],
        PROXY: d.proxy,
        ADMIN_WALLET: keys.role("admin").address,
        WHITELIST_MANAGER: keys.role("wl").address,
        RELAYER: keys.role(s === "bsc" ? "bscRelayer" : "wantosRelayer").address,
        PAUSER: keys.role("pauser").address,
        TOKEN: d.token[s],
        PEER_CHAIN_ID: String(cfg.chains[s === "bsc" ? "wantos" : "bsc"].chainId),
        ENCODED_PARAMS: enc,
        SUPPLY_CEILING: s === "wantos" ? d.supplyCeiling : "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    }).toString();
    ctx.check(`V-forge-${s}`, "Verify.s.sol（快速版副本）全部通过", /all checks passed/.test(out));
  }
}
