import { describe, expect, it } from "vitest";
import { BaseError, ContractFunctionRevertedError, encodeErrorResult, getAddress, recoverMessageAddress, type Address } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { bridgeTimelockAbi } from "@bridge/abi";
import { ConfigError, isPlaceholder, parseConfig } from "../../src/lib/config";
import { decodeRevert, describeError, type Signer } from "../../src/lib/chain";
import { createSession, sessionValid, siweMessage, SESSION_TTL_MS } from "../../src/lib/siwe";
import { AdminApi, ApiError } from "../../src/lib/api";
import { APPENDIX_A, defaultChecked, flagsFor, needsConfirm } from "../../src/lib/risk";
import { gate, gateWith } from "../../src/lib/perm";
import { executeErrorText, randomSalt } from "../../src/lib/timelock";
import { countdown, proofMessage } from "../../src/lib/handover";
import { buildCsp, buildHeadersFile } from "../../src/csp";
import { forward } from "../../worker/forward";
import { DEADLINE_AHEAD_S, writeOrder, isComplete, newJob } from "../../src/lib/whitelist";
import type { ChainState } from "../../src/lib/state";
import { classify, planKind } from "../../src/lib/params";

const B = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const env = {
  VITE_BSC_CHAIN_ID: "56",
  VITE_BSC_RPC_URL: "https://bsc.example",
  VITE_BSC_BRIDGE: B,
  VITE_WANTOS_CHAIN_ID: "13555",
  VITE_WANTOS_RPC_URL: "https://rpc.wantos.io",
  VITE_WANTOS_BRIDGE: B.toLowerCase(),
  VITE_WANTOS_FROM_BLOCK: "12",
};

describe("config", () => {
  it("parses and enforces", () => {
    const c = parseConfig(env);
    expect(c.wantos.bridge).toBe(B);
    expect(c.wantos.fromBlock).toBe(12n);
    expect(c.adminApi).toBeNull();
    expect(c.siweDomain).toBe("admin.wanto.pro");
    expect(isPlaceholder(c)).toBe(false);
    expect(isPlaceholder(parseConfig({ ...env, VITE_BSC_BRIDGE: "0x000000000000000000000000000000000000dEaD", VITE_WANTOS_BRIDGE: "0x000000000000000000000000000000000000dEaD" }))).toBe(true);
    for (const bad of [
      { VITE_BSC_CHAIN_ID: "" },
      { VITE_BSC_CHAIN_ID: "x" },
      { VITE_BSC_RPC_URL: "http://bsc.example" },
      { VITE_BSC_BRIDGE: "0x12" },
      { VITE_BSC_FROM_BLOCK: "-1" },
      { VITE_BSC_CHAIN_ID: "13555" },
      { VITE_BSC_BRIDGE: "0x0000000000000000000000000000000000000001" },
      { VITE_ADMIN_API: "http://evil.example" },
    ])
      expect(() => parseConfig({ ...env, ...bad })).toThrow(ConfigError);
    expect(parseConfig({ ...env, VITE_ADMIN_API: "https://admin.wanto.pro/api", VITE_BSC_RPC_URL: "http://127.0.0.1:8545" }).adminApi).toBe("https://admin.wanto.pro/api");
  });
  it("CSP lists only the RPC and API origins", () => {
    const c = parseConfig({ ...env, VITE_ADMIN_API: "https://admin.wanto.pro/api" });
    expect(buildCsp(c)).toContain("connect-src 'self' https://rpc.wantos.io https://bsc.example https://admin.wanto.pro");
    expect(buildCsp(c)).toContain("script-src 'self'");
    expect(buildHeadersFile(c)).toContain("Strict-Transport-Security");
  });
});

describe("errors", () => {
  it("decodes custom errors and maps rejection / unfit implementation", () => {
    const data = encodeErrorResult({ abi: bridgeTimelockAbi, errorName: "BridgeCheckFailed" });
    expect(decodeRevert(data)?.name).toBe("BridgeCheckFailed");
    expect(decodeRevert("0x")).toBeNull();
    expect(decodeRevert("0x12345678")).toBeNull();
    expect(describeError({ code: 4001, message: "x" })).toBe("钱包里拒绝了");
    expect(describeError("plain")).toBe("plain");
    const rev = (raw: `0x${string}`) =>
      new BaseError("call failed", { cause: Object.assign(new ContractFunctionRevertedError({ abi: bridgeTimelockAbi, functionName: "execute", data: raw }), {}) });
    expect(describeError(rev(data))).toContain("BridgeCheckFailed");
    expect(executeErrorText(rev(data))).toContain("不要重试");
    expect(executeErrorText(rev("0x"))).toContain("不要重试");
    expect(executeErrorText(rev("0xdeadbeef"))).toContain("不要重试");
    const expired = encodeErrorResult({ abi: bridgeTimelockAbi, errorName: "OperationExpired", args: [("0x" + "1".repeat(64)) as `0x${string}`] });
    expect(executeErrorText(rev(expired))).not.toContain("不要重试");
    expect(describeError(new BaseError("short"))).toContain("short");
    expect(randomSalt()).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe("SIWE session", () => {
  it("builds an EIP-4361 message, signs once, expires", async () => {
    const acct = privateKeyToAccount(generatePrivateKey());
    const log: string[] = [];
    const signer: Signer = { address: acct.address, write: async () => "0x", signTypedData: async () => "0x", signMessage: async (m) => (log.push(m), acct.signMessage({ message: m })) };
    const now = new Date("2026-11-02T00:00:00Z");
    const s = await createSession(signer, { domain: "admin.wanto.pro", chainId: 13555, now });
    const [b64, sig] = s.header.slice(5).split(".");
    const msg = new TextDecoder().decode(Uint8Array.from(atob(b64!), (c) => c.charCodeAt(0)));
    expect(msg).toBe(log[0]);
    expect(msg.split("\n")[0]).toBe("admin.wanto.pro wants you to sign in with your Ethereum account:");
    expect(msg).toContain("Expiration Time: 2026-11-02T00:15:00.000Z");
    expect(await recoverMessageAddress({ message: msg, signature: sig as `0x${string}` })).toBe(acct.address);
    expect(sessionValid(s, acct.address, now.getTime())).toBe(true);
    expect(sessionValid(s, acct.address, now.getTime() + SESSION_TTL_MS)).toBe(false);
    expect(sessionValid(s, "0x0000000000000000000000000000000000000001", now.getTime())).toBe(false);
    expect(sessionValid(null, acct.address)).toBe(false);
    expect(siweMessage({ domain: "d", address: acct.address.toLowerCase() as Address, chainId: 1, nonce: "n", issuedAt: now, expiresAt: now })).toContain(acct.address);
  });
});

describe("admin API client + Worker", () => {
  it("maps statuses", async () => {
    const mk = (status: number) => new AdminApi("https://x/api/", async () => "SIWE a.b", (async () => new Response("{}", { status })) as unknown as typeof fetch);
    await expect(mk(401).report()).rejects.toThrow("会话无效");
    await expect(mk(501).report()).rejects.toThrow("占位");
    await expect(mk(500).report()).rejects.toBeInstanceOf(ApiError);
    let seen = "";
    const ok = new AdminApi("https://x/api/", async () => "SIWE a.b", (async (u: string) => ((seen = u), new Response(JSON.stringify({ a: 1 })))) as unknown as typeof fetch);
    expect(await ok.addressInfo(["0x1"])).toEqual({ a: 1 });
    expect(seen).toBe("https://x/api/admin/address-info");
  });
  it("Worker forwards only /api/admin/* GET/POST with Authorization", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const f = (async (url: string, init: RequestInit) => (seen.push({ url, init }), new Response('{"ok":1}', { status: 200 }))) as unknown as typeof fetch;
    const envW = { RELAYER_ORIGIN: "https://relayer.internal" };
    expect((await forward(new Request("https://admin.wanto.pro/other"), envW, f)).status).toBe(404);
    expect((await forward(new Request("https://admin.wanto.pro/api/admin/x", { method: "DELETE" }), envW, f)).status).toBe(405);
    expect((await forward(new Request("https://admin.wanto.pro/api/admin/x"), { RELAYER_ORIGIN: "" }, f)).status).toBe(503);
    const r = await forward(new Request("https://admin.wanto.pro/api/admin/orders?status=REVIEW", { headers: { authorization: "SIWE a.b", cookie: "c=1" } }), envW, f);
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(seen[0]!.url).toBe("https://relayer.internal/admin/orders?status=REVIEW");
    const h = new Headers(seen[0]!.init.headers);
    expect(h.get("authorization")).toBe("SIWE a.b");
    expect(h.get("cookie")).toBeNull();
    await forward(new Request("https://admin.wanto.pro/api/admin/review", { method: "POST", body: '{"x":1}', headers: { "content-type": "application/json" } }), envW, f);
    expect(seen[1]!.init.body).toBe('{"x":1}');
  });
});

describe("risk flags", () => {
  it("🔴 starts unchecked; others checked", () => {
    const controlled = new Set(APPENDIX_A);
    expect(flagsFor(APPENDIX_A[0]!.toUpperCase().replace("0X", "0x"), { controlled, isContract: false })).toEqual(["red"]);
    expect(flagsFor("0x01", { controlled, info: { inNetwork: false, parent: null, bridgedOut: null, suspicious: true }, isContract: true })).toEqual(["orange", "yellow", "white"]);
    expect(flagsFor("0x01", { controlled, info: { inNetwork: null, parent: null, bridgedOut: null, suspicious: false }, isContract: false })).toEqual([]);
    expect(defaultChecked(["red", "white"])).toBe(false);
    expect(defaultChecked(["orange", "yellow", "white"])).toBe(true);
    expect(needsConfirm(["red"])).toBe(false);
    expect(APPENDIX_A.every((a) => a === a.toLowerCase() && getAddress(a))).toBe(true);
  });
});

describe("gates, handover text, misc", () => {
  const A = "0x00000000000000000000000000000000000000aa" as Address;
  const C = "0x00000000000000000000000000000000000000cc" as Address;
  const base: ChainState = {
    side: "wantos", chainId: 1, bridge: A, timelock: A, token: A, admin: A, wl: A, paused: false, frozen: false, wlNonce: 0n,
    pendingWl: { candidate: C, availableAt: 100n, expiresAt: 200n },
    wlRecovery: { active: true, candidate: C, readyAt: 100n, cooldownUntil: 0n },
    pendingAdmin: { candidate: C, expiresAt: 200n },
    adminRecovery: { active: true, candidate: C, readyAt: 100n, cooldownUntil: 0n },
    anyRecovery: false, epoch: 0n, minDelay: 0n, now: 150n,
  };
  it("candidate gates: window, expiry, recovery", () => {
    expect(gate("pendingWl", C, base).ok).toBe(true);
    expect(gate("pendingWl", C, { ...base, now: 50n }).reason).toContain("等待期未满");
    expect(gate("pendingWl", C, { ...base, now: 201n }).reason).toContain("已过期");
    expect(gate("pendingWl", C, { ...base, anyRecovery: true }).reason).toContain("恢复进行中");
    expect(gate("pendingWl", A, base).reason).toContain("不是被指定的新地址");
    expect(gate("wlRecoveryCandidate", C, base).ok).toBe(true);
    expect(gate("wlRecoveryCandidate", A, base).ok).toBe(false);
    expect(gate("wlRecoveryCandidate", C, { ...base, wlRecovery: { ...base.wlRecovery, active: false } }).ok).toBe(false);
    expect(gate("pendingAdmin", C, base).ok).toBe(true);
    expect(gate("pendingAdmin", C, { ...base, now: 201n }).reason).toContain("过期");
    expect(gate("pendingAdmin", C, { ...base, anyRecovery: true }).ok).toBe(false);
    expect(gate("pendingAdmin", A, base).ok).toBe(false);
    expect(gate("pendingAdmin", C, { ...base, pendingAdmin: null }).ok).toBe(false);
    expect(gate("adminRecoveryCandidate", C, base).ok).toBe(true);
    expect(gate("adminRecoveryCandidate", C, { ...base, now: 10n }).reason).toContain("14 天");
    expect(gate("adminRecoveryCandidate", A, base).ok).toBe(false);
    expect(gate("adminRecoveryCandidate", C, { ...base, adminRecovery: { ...base.adminRecovery, active: false } }).ok).toBe(false);
    expect(gate("adminOrWl", A, base).ok).toBe(true);
    expect(gateWith({ ok: true }, [true, "x"], [false, "y"])).toEqual({ ok: false, reason: "y" });
    expect(gateWith({ ok: false, reason: "z" }, [false, "y"]).reason).toBe("z");
  });
  it("countdown, proof text, whitelist helpers, params planning", () => {
    expect(countdown(100n, 200n)).toBe("已到");
    expect(countdown(200n + 86400n + 3600n + 60n, 200n)).toBe("1 天 1 小时 1 分");
    expect(countdown(260n, 200n)).toBe("0 小时 1 分");
    expect(proofMessage({ role: "admin", address: A, bridge: A, issuedAt: "t" })).toContain("role: admin-wallet");
    expect(writeOrder(true)).toEqual(["bsc", "wantos"]);
    expect(DEADLINE_AHEAD_S).toBe(23n * 3600n);
    const j = newJob([], true, 0n);
    expect(isComplete(j)).toBe(false);
    expect(isComplete({ ...j, runs: { bsc: { status: "done" }, wantos: { status: "skipped" } } })).toBe(true);
    const cur = { w2bMinAmount: 10n, w2bPerAddrDailyCap: 100n, b2wDailyCap: 1000n, b2wDelay: 900n };
    expect(classify("wantos", cur, { ...cur, w2bMinAmount: 11n, b2wDelay: 901n })).toEqual({ w2bMinAmount: "tighten", w2bPerAddrDailyCap: "same", b2wDailyCap: "same", b2wDelay: "tighten" });
    expect(planKind(classify("wantos", cur, { ...cur, w2bMinAmount: 9n }))).toBe("timelock");
    expect(planKind(classify("wantos", cur, { ...cur, b2wDailyCap: 999n }))).toBe("direct");
    expect(planKind(classify("wantos", cur, cur))).toBe("none");
  });
});
