#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// WANTOS ⇄ BSC 白名单跨链桥 v2 —— 离线核对工具（DESIGN §4.4 / §8.3）
//
// 单文件、零依赖、只用 Node.js（>= 18）内置功能；不联网、不读写任何密钥。
// 请在【另一台设备】上运行，拿它算出的 listHash / count / domain hash / message hash
// 与管理后台屏幕、硬件钱包屏幕逐项比对；不一致就不要签。
//
// 用法：
//   node offline-check.mjs <地址文件|-> --action add|remove --contract 0x… \
//        --bsc-nonce N --wantos-nonce M --deadline <unix 秒> \
//        [--bsc-chain-id 56] [--wantos-chain-id 13555] [--batch-size 500] \
//        [--expect-list-hash 0x…] [--list] [--json]
//   node offline-check.mjs --decode <calldata 0x…>      # 解码时间锁提议 / 管理交易的 calldata
//
//   多批时第 i 批（从 0 起）使用 nonce = 起始 nonce + i（与管理后台一致）。
//   --expect-list-hash：与屏幕上的 listHash 比对，不一致退出码 2。
//
// 地址文件规则（rules v1，与管理后台完全相同，测试向量见 vectors.json）：
//   R1 去掉 UTF-8 BOM；按 \r\n、\n、\r 分行（行号从 1 起）。
//   R2 每行去掉首尾空白；空行和以 # 开头的行忽略。
//   R3 每行只取第一个字段（遇到 , ; 制表符 空格 为止），去掉两侧成对的 " 或 '。
//   R4 第一条有效行的第一个字段若不以 0x/0X 开头，视为表头跳过（只跳一次）。
//   R5 字段必须是 0x + 40 位十六进制；大小写混写时必须是正确的 EIP-55 校验和；零地址拒绝。
//   R6 转小写后去重（保留第一次出现，重复记为提示）。
//   R7 按数值升序排序。
//   R8 按批大小（默认 500，最大 500）顺序切批。
//   R9 有任何错误就拒绝输出哈希。
//
// 哈希（与合约 BridgeBase / PR1-NOTES §5.4 相同）：
//   listHash   = keccak256(abi.encode(address[] sorted))
//   domainHash = keccak256(abi.encode(EIP712Domain typehash, keccak(name), keccak("1"), chainId, verifyingContract))
//                name = "BscVaultV2"（BSC）| "WantosBridgeV2"（WANTOS）
//   messageHash= keccak256(abi.encode(WhitelistBatch typehash, listHash, uint32 count, bool allowed, nonce, deadline))
//   digest     = keccak256(0x1901 ‖ domainHash ‖ messageHash)

export const RULES_VERSION = 1;
export const MAX_BATCH = 500;

// ---------------------------------------------------------------- keccak-256（Keccak-f[1600]，原始 Keccak 填充 0x01）

const MASK64 = (1n << 64n) - 1n;
const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
// 旋转量 r[x][y]，下标 x + 5y
const ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];

const rotl = (v, n) => (n === 0 ? v : ((v << BigInt(n)) | (v >> BigInt(64 - n))) & MASK64);

function keccakF(A) {
  const C = new Array(5);
  const B = new Array(25);
  for (let round = 0; round < 24; round++) {
    for (let x = 0; x < 5; x++) C[x] = A[x] ^ A[x + 5] ^ A[x + 10] ^ A[x + 15] ^ A[x + 20];
    for (let x = 0; x < 5; x++) {
      const D = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1);
      for (let y = 0; y < 25; y += 5) A[y + x] ^= D;
    }
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(A[x + 5 * y], ROT[x + 5 * y]);
    for (let x = 0; x < 5; x++)
      for (let y = 0; y < 5; y++) A[x + 5 * y] = B[x + 5 * y] ^ (~B[((x + 1) % 5) + 5 * y] & MASK64 & B[((x + 2) % 5) + 5 * y]);
    A[0] ^= RC[round];
  }
}

/** keccak256(bytes) → Uint8Array(32) */
export function keccak256(bytes) {
  const rate = 136;
  const len = bytes.length;
  const p = new Uint8Array(len + (rate - (len % rate)));
  p.set(bytes);
  p[len] ^= 0x01;
  p[p.length - 1] ^= 0x80;
  const A = new Array(25).fill(0n);
  for (let off = 0; off < p.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n;
      for (let b = 7; b >= 0; b--) lane = (lane << 8n) | BigInt(p[off + i * 8 + b]);
      A[i] ^= lane;
    }
    keccakF(A);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) for (let b = 0; b < 8; b++) out[i * 8 + b] = Number((A[i] >> BigInt(8 * b)) & 0xffn);
  return out;
}

// ---------------------------------------------------------------- 字节工具

export const toHex = (u8) => "0x" + Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join("");
export function fromHex(h) {
  const s = h.startsWith("0x") || h.startsWith("0X") ? h.slice(2) : h;
  if (s.length % 2 !== 0 || /[^0-9a-fA-F]/.test(s)) throw new Error(`不是十六进制：${h}`);
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return out;
}
const utf8 = (s) => new TextEncoder().encode(s);
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
/** 32 字节大端无符号整数 */
export function word(n) {
  let v = BigInt(n);
  if (v < 0n || v >= 1n << 256n) throw new Error(`整数超出 uint256：${n}`);
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}
const addrWord = (a) => concat(new Uint8Array(12), fromHex(a));
export const keccakHex = (bytes) => toHex(keccak256(bytes));

// ---------------------------------------------------------------- 地址：EIP-55 与规范化（rules v1）

export function toChecksum(lowerAddr) {
  const hex = lowerAddr.slice(2);
  const h = keccak256(utf8(hex));
  let out = "0x";
  for (let i = 0; i < 40; i++) {
    const nibble = (h[i >> 1] >> (i % 2 === 0 ? 4 : 0)) & 0xf;
    out += nibble >= 8 ? hex[i].toUpperCase() : hex[i];
  }
  return out;
}

const ZERO = "0x" + "0".repeat(40);

/** 校验单个字段；返回 { address } 或 { reason } */
export function checkField(field) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(field)) return { reason: "format" };
  const lower = field.toLowerCase();
  const body = field.slice(2);
  const mixed = body !== body.toLowerCase() && body !== body.toUpperCase();
  if (mixed && toChecksum(lower) !== field) return { reason: "checksum" };
  if (lower === ZERO) return { reason: "zero" };
  return { address: lower };
}

/**
 * 解析地址文本（rules v1）。
 * 返回 { addresses: 小写升序去重, errors: [{line, text, reason}], duplicates: [{line, address, firstLine}], headerSkipped }
 */
export function parseAddressList(text) {
  const lines = text.replace(/^﻿/, "").split(/\r\n|\n|\r/);
  const errors = [];
  const duplicates = [];
  const seen = new Map();
  let first = true;
  let headerSkipped = false;
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    let field = line.split(/[,;\t ]/)[0].trim();
    const q = field[0];
    if (field.length >= 2 && (q === '"' || q === "'") && field[field.length - 1] === q) field = field.slice(1, -1).trim();
    if (first) {
      first = false;
      if (!/^0x/i.test(field)) {
        headerSkipped = true;
        return;
      }
    }
    const r = checkField(field);
    if (r.reason) {
      errors.push({ line: i + 1, text: field, reason: r.reason });
      return;
    }
    if (seen.has(r.address)) duplicates.push({ line: i + 1, address: r.address, firstLine: seen.get(r.address) });
    else seen.set(r.address, i + 1);
  });
  const addresses = [...seen.keys()].sort();
  return { addresses, errors, duplicates, headerSkipped };
}

/** 按批切分（已排序的地址按顺序切；每批仍严格递增） */
export function chunk(addresses, batchSize = MAX_BATCH) {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH) throw new Error(`批大小必须在 1～${MAX_BATCH}`);
  const out = [];
  for (let i = 0; i < addresses.length; i += batchSize) out.push(addresses.slice(i, i + batchSize));
  return out;
}

/** listHash = keccak256(abi.encode(address[])) */
export function listHash(sorted) {
  return keccakHex(concat(word(32), word(sorted.length), ...sorted.map(addrWord)));
}

// ---------------------------------------------------------------- EIP-712

export const DOMAIN_TYPEHASH = keccakHex(utf8("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"));
export const BATCH_TYPEHASH = keccakHex(utf8("WhitelistBatch(bytes32 listHash,uint32 count,bool allowed,uint256 nonce,uint256 deadline)"));
export const CONTRACT_NAME = { bsc: "BscVaultV2", wantos: "WantosBridgeV2" };

export function domainHash({ name, chainId, verifyingContract }) {
  return keccakHex(
    concat(fromHex(DOMAIN_TYPEHASH), keccak256(utf8(name)), keccak256(utf8("1")), word(chainId), addrWord(verifyingContract)),
  );
}

export function messageHash({ listHash: lh, count, allowed, nonce, deadline }) {
  if (count < 0 || count > 0xffffffff) throw new Error("count 超出 uint32");
  return keccakHex(concat(fromHex(BATCH_TYPEHASH), fromHex(lh), word(count), word(allowed ? 1 : 0), word(nonce), word(deadline)));
}

export function digest(domain, message) {
  return keccakHex(concat(new Uint8Array([0x19, 0x01]), fromHex(domain), fromHex(message)));
}

/**
 * 完整核对：文本 → 批次 → 每批每条链的 domain / message / digest。
 * opts: { allowed, contract, deadline, bscNonce, wantosNonce, bscChainId=56, wantosChainId=13555, batchSize=500 }
 */
export function computeBatches(text, opts) {
  const parsed = parseAddressList(text);
  if (parsed.errors.length > 0) return { ok: false, ...parsed, batches: [] };
  if (parsed.addresses.length === 0) return { ok: false, ...parsed, errors: [{ line: 0, text: "", reason: "empty" }], batches: [] };
  const chains = [
    { key: "bsc", chainId: opts.bscChainId ?? 56, nonce: opts.bscNonce },
    { key: "wantos", chainId: opts.wantosChainId ?? 13555, nonce: opts.wantosNonce },
  ];
  const batches = chunk(parsed.addresses, opts.batchSize ?? MAX_BATCH).map((addrs, i) => {
    const lh = listHash(addrs);
    const perChain = {};
    for (const c of chains) {
      const d = domainHash({ name: CONTRACT_NAME[c.key], chainId: c.chainId, verifyingContract: opts.contract });
      const nonce = c.nonce === undefined ? undefined : BigInt(c.nonce) + BigInt(i);
      const m =
        nonce === undefined || opts.deadline === undefined
          ? undefined
          : messageHash({ listHash: lh, count: addrs.length, allowed: opts.allowed, nonce, deadline: opts.deadline });
      perChain[c.key] = { chainId: c.chainId, nonce: nonce?.toString(), domainHash: d, messageHash: m, digest: m ? digest(d, m) : undefined };
    }
    return { index: i, count: addrs.length, listHash: lh, addresses: addrs, ...perChain };
  });
  return { ok: true, ...parsed, batches };
}

// ---------------------------------------------------------------- calldata 解码（时间锁提议 / 管理交易）

const SIGNATURES = [
  // 两条链共有（BridgeBase）
  "applyWhitelistBatch(address[],bool,uint256,uint256,bytes)",
  "invalidateWhitelistNonce()",
  "freezeWhitelist()",
  "unfreezeWhitelist()",
  "emergencyRemove(address[])",
  "beginWhitelistManagerTransfer(address)",
  "cancelWhitelistManagerTransfer()",
  "acceptWhitelistManagerTransfer()",
  "startWhitelistRecovery(address)",
  "cancelWhitelistRecovery()",
  "acceptWhitelistRecovery()",
  "pause()",
  "unpause()",
  "grantRole(bytes32,address)",
  "revokeRole(bytes32,address)",
  "revokeKey(bytes32,address)",
  "voidSource(uint256)",
  "voidSourceBatch(uint256[])",
  "cancelRelease(uint256)",
  "withdraw(address,uint256)",
  "upgradeToAndCall(address,bytes)",
  // BSC
  "setParams((uint256,uint256,uint256,uint256,uint256,uint256))",
  "payLegacyBatch(bytes32[],address[],uint256[])",
  "requestDepositRefund(uint256)",
  "cancelDepositRefund(uint256)",
  // WANTOS
  "setParams((uint256,uint256,uint256,uint256))",
  "setSupplyCeiling(uint256)",
  "requestRefund(uint256)",
  "requestRefundBatch(uint256[])",
  "cancelRefund(uint256)",
  // BridgeTimelock
  "schedule(address,uint256,bytes,bytes32,bytes32,uint256)",
  "scheduleBatch(address[],uint256[],bytes[],bytes32,bytes32,uint256)",
  "execute(address,uint256,bytes,bytes32,bytes32)",
  "executeBatch(address[],uint256[],bytes[],bytes32,bytes32)",
  "cancel(bytes32)",
  "transferAdmin(address)",
  "updateDelay(uint256)",
  "startAdminRecovery(address)",
  "cancelAdminRecovery()",
  "acceptAdmin()",
];

export const KNOWN_ROLES = {
  [keccakHex(utf8("RELAYER_ROLE"))]: "RELAYER_ROLE",
  [keccakHex(utf8("PAUSER_ROLE"))]: "PAUSER_ROLE",
  ["0x" + "0".repeat(64)]: "DEFAULT_ADMIN_ROLE",
};

export const SELECTORS = Object.fromEntries(SIGNATURES.map((s) => [keccakHex(utf8(s)).slice(0, 10), s]));

function splitTypes(inner) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (const ch of inner) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}
const isTuple = (t) => t.startsWith("(");
const isDynamic = (t) => t === "bytes" || t === "string" || t.endsWith("[]") || (isTuple(t) && splitTypes(t.slice(1, -1)).some(isDynamic));
const headSize = (t) => (isTuple(t) && !isDynamic(t) ? splitTypes(t.slice(1, -1)).reduce((n, x) => n + headSize(x), 0) : 32);

function readWord(data, off) {
  if (off + 32 > data.length) throw new Error("calldata 太短");
  return data.slice(off, off + 32);
}
const wordToBig = (w) => BigInt(toHex(w));

function decodeValue(t, data, base, off) {
  if (isTuple(t)) {
    const types = splitTypes(t.slice(1, -1));
    if (isDynamic(t)) return decodeList(types, data, base + Number(wordToBig(readWord(data, base + off))));
    return decodeList(types, data, base + off);
  }
  if (t.endsWith("[]")) {
    const start = base + Number(wordToBig(readWord(data, base + off)));
    const n = Number(wordToBig(readWord(data, start)));
    const el = t.slice(0, -2);
    return decodeList(new Array(n).fill(el), data, start + 32);
  }
  if (t === "bytes") {
    const start = base + Number(wordToBig(readWord(data, base + off)));
    const n = Number(wordToBig(readWord(data, start)));
    if (start + 32 + n > data.length) throw new Error("calldata 太短");
    return toHex(data.slice(start + 32, start + 32 + n));
  }
  const w = readWord(data, base + off);
  if (t === "address") return toChecksum(toHex(w.slice(12)));
  if (t === "bool") return wordToBig(w) !== 0n;
  if (t === "bytes32") return toHex(w);
  return wordToBig(w).toString(); // uint*
}

function decodeList(types, data, base) {
  const out = [];
  let off = 0;
  for (const t of types) {
    out.push(decodeValue(t, data, base, off));
    off += headSize(t);
  }
  return out;
}

/** 解码 calldata；对 schedule / scheduleBatch / execute* 的内层 data 递归解码。 */
export function decodeCalldata(hex) {
  const data = fromHex(hex);
  if (data.length < 4) throw new Error("calldata 太短");
  const selector = toHex(data.slice(0, 4));
  const signature = SELECTORS[selector];
  if (!signature) return { selector, signature: null, args: [] };
  const types = splitTypes(signature.slice(signature.indexOf("(") + 1, -1));
  const body = data.slice(4);
  const args = decodeList(types, body, 0).map((v, i) => {
    const t = types[i];
    if (t === "bytes32" && KNOWN_ROLES[v]) return { type: t, value: v, label: KNOWN_ROLES[v] };
    if (t === "bytes" && /^(schedule|execute)\(/.test(signature) && v.length >= 10) return { type: t, value: v, inner: decodeCalldata(v) };
    if (t === "bytes[]" && /^(schedule|execute)Batch/.test(signature)) return { type: t, value: v, inner: v.map((x) => (x.length >= 10 ? decodeCalldata(x) : null)) };
    return { type: t, value: v };
  });
  return { selector, signature, args };
}

// ---------------------------------------------------------------- 命令行

function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--list" || a === "--json") o[a.slice(2)] = true;
    else if (a.startsWith("--")) {
      if (i + 1 >= argv.length) throw new Error(`${a} 缺少值`);
      o[a.slice(2)] = argv[++i];
    } else o._.push(a);
  }
  return o;
}

const REASON = { format: "格式错误（应为 0x + 40 位十六进制）", checksum: "大小写校验和（EIP-55）错误", zero: "零地址", empty: "文件里没有地址" };

function fmtDecoded(d, indent = "") {
  if (!d.signature) return `${indent}未知函数 selector ${d.selector}`;
  const lines = [`${indent}${d.signature}`];
  d.args.forEach((a, i) => {
    const v = Array.isArray(a.value) ? `[${a.value.join(", ")}]` : String(a.value);
    lines.push(`${indent}  #${i} ${a.type} = ${v}${a.label ? `（${a.label}）` : ""}`);
    if (a.inner && !Array.isArray(a.inner)) lines.push(fmtDecoded(a.inner, indent + "    "));
    if (Array.isArray(a.inner)) a.inner.forEach((x) => x && lines.push(fmtDecoded(x, indent + "    ")));
  });
  return lines.join("\n");
}

/** 运行命令行；返回 { code, out }（便于测试）。readFile 由调用方提供。 */
export function runCli(argv, readFile) {
  const a = parseArgs(argv);
  if (a.decode) {
    const d = decodeCalldata(a.decode);
    return { code: d.signature ? 0 : 1, out: a.json ? JSON.stringify(d, null, 2) : fmtDecoded(d) };
  }
  const file = a._[0];
  if (!file) return { code: 64, out: "用法见文件开头注释：node offline-check.mjs <地址文件> --action add|remove --contract 0x… --bsc-nonce N --wantos-nonce M --deadline T" };
  if (a.action !== "add" && a.action !== "remove") return { code: 64, out: "--action 必须是 add 或 remove" };
  const contract = a.contract;
  if (!contract || !/^0x[0-9a-fA-F]{40}$/.test(contract)) return { code: 64, out: "--contract 必须是桥合约地址（两条链相同）" };
  const num = (k) => (a[k] === undefined ? undefined : /^\d+$/.test(a[k]) ? BigInt(a[k]) : NaN);
  const opts = {
    allowed: a.action === "add",
    contract,
    deadline: num("deadline"),
    bscNonce: num("bsc-nonce"),
    wantosNonce: num("wantos-nonce"),
    bscChainId: a["bsc-chain-id"] ? Number(a["bsc-chain-id"]) : 56,
    wantosChainId: a["wantos-chain-id"] ? Number(a["wantos-chain-id"]) : 13555,
    batchSize: a["batch-size"] ? Number(a["batch-size"]) : MAX_BATCH,
  };
  for (const k of ["deadline", "bscNonce", "wantosNonce"]) if (Number.isNaN(opts[k])) return { code: 64, out: `${k} 必须是十进制整数` };
  const r = computeBatches(readFile(file), opts);
  if (a.json) {
    const replacer = (_k, v) => (typeof v === "bigint" ? v.toString() : v);
    const mismatch = a["expect-list-hash"] && !(r.batches.length === 1 && r.batches[0].listHash === a["expect-list-hash"].toLowerCase());
    return { code: !r.ok ? 1 : mismatch ? 2 : 0, out: JSON.stringify({ rulesVersion: RULES_VERSION, ...r }, replacer, 2) };
  }
  const out = [`WANTOS 桥 v2 离线核对（rules v${RULES_VERSION}）`];
  if (!r.ok) {
    out.push("❌ 文件有错误，拒绝计算哈希：");
    for (const e of r.errors) out.push(`  第 ${e.line} 行  ${e.text}  ${REASON[e.reason]}`);
    return { code: 1, out: out.join("\n") };
  }
  out.push(`地址 ${r.addresses.length} 个（去重后）；重复 ${r.duplicates.length} 个；表头${r.headerSkipped ? "已跳过" : "无"}`);
  for (const d of r.duplicates) out.push(`  提示：第 ${d.line} 行与第 ${d.firstLine} 行重复 ${d.address}`);
  out.push(`操作 ${a.action === "add" ? "添加 (allowed=true)" : "移除 (allowed=false)"}；合约 ${toChecksum(contract.toLowerCase())}；deadline ${opts.deadline ?? "（未给）"}${opts.deadline !== undefined ? `（${new Date(Number(opts.deadline) * 1000).toISOString()}）` : ""}`);
  out.push(`共 ${r.batches.length} 批（每批 ≤ ${opts.batchSize}）`);
  let code = 0;
  for (const b of r.batches) {
    out.push("", `第 ${b.index + 1}/${r.batches.length} 批  count = ${b.count}`, `  listHash    ${b.listHash}`);
    for (const k of ["bsc", "wantos"]) {
      const c = b[k];
      out.push(`  ${k === "bsc" ? "BSC   " : "WANTOS"} chainId ${c.chainId}  nonce ${c.nonce ?? "（未给）"}`);
      out.push(`    domainHash  ${c.domainHash}`);
      out.push(`    messageHash ${c.messageHash ?? "（缺 nonce/deadline）"}`);
      out.push(`    digest      ${c.digest ?? "（缺 nonce/deadline）"}`);
    }
    if (a.list) for (const x of b.addresses) out.push(`    ${toChecksum(x)}`);
  }
  if (a["expect-list-hash"]) {
    const exp = a["expect-list-hash"].toLowerCase();
    const hit = r.batches.find((b) => b.listHash === exp);
    out.push("", hit ? `✅ 屏幕 listHash 与第 ${hit.index + 1} 批一致` : `❌ 屏幕 listHash ${exp} 与本文件任何一批都不一致 —— 不要签名`);
    if (!hit) code = 2;
  }
  return { code, out: out.join("\n") };
}

// 直接运行时
const isMain =
  typeof process !== "undefined" && process.argv?.[1] !== undefined && import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href;
if (isMain) {
  const { readFileSync } = await import("node:fs");
  try {
    const { code, out } = runCli(process.argv.slice(2), (f) => readFileSync(f === "-" ? 0 : f, "utf8"));
    console.log(out);
    process.exit(code);
  } catch (e) {
    console.error(`错误：${e.message}`);
    process.exit(1);
  }
}
