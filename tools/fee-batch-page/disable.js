"use strict";
// One-off emergency page: sends disableNativeFee() to the bridge proxy on BSC and on WANTOS. No inputs.
const ADMIN = "0x860f5B29f60F86c82b18f789E0219Cf966375669".toLowerCase();
const PROXY = "0x41e9900BF09553C46b6b3F267626FDa2b4711E44";
const DATA = "0x313a3da3"; // disableNativeFee()
const JOBS = {
  bsc: { chainId: "0x38", name: "BNB Smart Chain" },
  wantos: {
    chainId: "0x34f3",
    name: "WANTOS",
    add: { chainId: "0x34f3", chainName: "WANTOS", nativeCurrency: { name: "WANT", symbol: "WANT", decimals: 18 }, rpcUrls: ["https://rpc.wantos.io"], blockExplorerUrls: ["https://scan.wantos.io"] },
  },
};
let account = null;
const $ = (id) => document.getElementById(id);
const eth = () => window.ethereum;
const say = (id, msg, cls) => { const e = $(id); e.textContent = msg; e.className = "status " + (cls || ""); };

async function connect() {
  try {
    if (!eth()) return say("account", "没有检测到钱包。请在钱包 App 自带的浏览器里打开本页。", "err");
    const accs = await eth().request({ method: "eth_requestAccounts" });
    account = (accs[0] || "").toLowerCase();
    if (account !== ADMIN) {
      for (const k of Object.keys(JOBS)) $("send-" + k).disabled = true;
      return say("account", "连接的是 " + account + "，不是管理钱包 0x860f…5669。请切换到管理钱包后再点一次。", "err");
    }
    say("account", "已连接管理钱包 " + account, "ok");
    for (const k of Object.keys(JOBS)) $("send-" + k).disabled = false;
  } catch (e) { say("account", "连接失败：" + (e && e.message ? e.message : e), "err"); }
}

async function ensureChain(job) {
  const cur = await eth().request({ method: "eth_chainId" });
  if (String(cur).toLowerCase() === job.chainId) return;
  try {
    await eth().request({ method: "wallet_switchEthereumChain", params: [{ chainId: job.chainId }] });
  } catch (e) {
    if (job.add && e && (e.code === 4902 || e.code === -32603)) await eth().request({ method: "wallet_addEthereumChain", params: [job.add] });
    else throw e;
  }
  const now = await eth().request({ method: "eth_chainId" });
  if (String(now).toLowerCase() !== job.chainId) throw new Error("钱包没有切换到 " + job.name);
}

async function send(key) {
  const job = JOBS[key], out = "out-" + key, btn = $("send-" + key);
  try {
    if (account !== ADMIN) return say(out, "先连接管理钱包。", "err");
    btn.disabled = true;
    say(out, "正在切换网络…");
    await ensureChain(job);
    say(out, "请在钱包里确认这笔交易（调用 disableNativeFee()，金额 0）…");
    const hash = await eth().request({ method: "eth_sendTransaction", params: [{ from: account, to: PROXY, data: DATA, value: "0x0" }] });
    say(out, "已发送。交易哈希：" + hash + "  请把它发给 Claude。", "ok");
  } catch (e) {
    btn.disabled = false;
    say(out, "没有发出：" + (e && e.message ? e.message : e), "err");
  }
}

$("connect").addEventListener("click", connect);
$("send-bsc").addEventListener("click", () => send("bsc"));
$("send-wantos").addEventListener("click", () => send("wantos"));
