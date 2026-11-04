#!/usr/bin/env node
// Compares the runtime bytecode on chain with a local forge artifact. A correct deployment of the same source differs
// ONLY in the three UUPS `__self` immutables (3 x 20 bytes), and possibly the 32-byte metadata hash (it depends on paths).
// usage: node scripts/compare-impl.mjs <rpcUrl> <implAddress> <path/to/Artifact.json>
import { readFileSync } from "node:fs";

const [rpc, address, artifactPath] = process.argv.slice(2);
if (!rpc || !address || !artifactPath) {
  console.error("usage: node scripts/compare-impl.mjs <rpcUrl> <implAddress> <Artifact.json>");
  process.exit(2);
}
// no dependencies: one plain JSON-RPC call
const res = await fetch(rpc, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getCode", params: [address, "latest"] }),
  signal: AbortSignal.timeout(30_000),
});
const body = await res.json();
if (typeof body.result !== "string") fail(`eth_getCode failed: ${JSON.stringify(body.error ?? body).slice(0, 200)}`);
const chain = body.result.slice(2);
const local = JSON.parse(readFileSync(artifactPath, "utf8")).deployedBytecode.object.slice(2);
if (chain.length === 0) fail("no code at that address");
if (chain.length !== local.length) fail(`length differs: chain ${chain.length / 2} B, local ${local.length / 2} B`);

const spans = [];
let start = -1;
for (let i = 0; i < chain.length; i += 2) {
  const same = chain.slice(i, i + 2) === local.slice(i, i + 2);
  if (!same && start < 0) start = i / 2;
  if (same && start >= 0) (spans.push([start, i / 2 - start]), (start = -1));
}
if (start >= 0) spans.push([start, chain.length / 2 - start]);

const total = chain.length / 2;
// allowed: exactly the 3 UUPS `__self` immutables (20 bytes each) and, only when the compile path differs, the 32-byte
// metadata hash which sits within the last 64 bytes of the code
const immutables = spans.filter(([, n]) => n === 20);
const rest = spans.filter(([, n]) => n !== 20);
const metaOk = rest.length === 0 || (rest.length === 1 && rest[0][1] === 32 && rest[0][0] >= total - 64);
const ok = immutables.length === 3 && spans.length === immutables.length + rest.length && metaOk;
console.log(`bytes: ${total}; differing spans (offset,len): ${JSON.stringify(spans)}`);
if (!ok) fail("differences are NOT limited to the 3 immutable addresses (+ an optional 32-byte metadata hash near the end)");
console.log(`OK: identical except 3 immutable addresses${rest.length ? " and the metadata hash" : ""}`);

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}
