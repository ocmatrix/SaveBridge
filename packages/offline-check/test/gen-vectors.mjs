// Regenerates ../vectors.json. Parse expectations are written BY HAND below (rules v1);
// hashes are computed with viem (an implementation independent of offline-check.mjs and of the page).
// Run: node test/gen-vectors.mjs
import { writeFileSync } from "node:fs";
import { encodeAbiParameters, hashDomain, hashStruct, hashTypedData, keccak256 } from "viem";

const A1 = "0x9272f360b98160c1662abb6d2df9e4f313b39502";
const A2 = "0x9dab17a9ad061cbda2bef607a6a330ee74076e90";
const A3 = "0x7afc830d90f3080dc754618a9e4f71775815c3ad";
const A4 = "0x0000000000000000000000000000000000000001";
const A5 = "0xffffffffffffffffffffffffffffffffffffffff";
const CONTRACT = "0x5FbDB2315678afecb367f032d93F642f64180aa3";

const cases = [
  { name: "csv-with-header-and-extra-columns", text: "address,parent,label\n0x9272f360b98160c1662abb6d2df9e4f313b39502,0x00,a\n0x9dab17a9ad061cbda2bef607a6a330ee74076e90,0x00,b\n",
    expect: { addresses: [A1, A2], errors: [], duplicates: [], headerSkipped: true } },
  { name: "unsorted-mixed-case-dupes-comments-crlf-bom-quotes",
    text: "﻿# 第一批\r\n0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF\r\n\r\n\"0x9dAb17a9Ad061cbDA2BeF607A6A330EE74076E90\"\r\n  0x0000000000000000000000000000000000000001  \r\n'0x7afc830d90f3080dc754618a9e4f71775815c3ad';x\r\n0x9DAB17A9AD061CBDA2BEF607A6A330EE74076E90\r\n0x9272f360b98160c1662abb6d2df9e4f313b39502\t🙂\r\n",
    expect: { addresses: [A4, A3, A1, A2, A5], errors: [], duplicates: [{ line: 7, address: A2, firstLine: 4 }], headerSkipped: false } },
  { name: "errors-block-hashing",
    text: "0x9272f360b98160c1662abb6d2df9e4f313b39502\n0x9dab17a9Ad061cbDA2BeF607A6A330EE74076E90\n0x0000000000000000000000000000000000000000\n0x1234\nhello\n0X7afc830d90f3080dc754618a9e4f71775815c3ad\n",
    expect: { addresses: [A1], errors: [
      { line: 2, text: "0x9dab17a9Ad061cbDA2BeF607A6A330EE74076E90", reason: "checksum" },
      { line: 3, text: "0x0000000000000000000000000000000000000000", reason: "zero" },
      { line: 4, text: "0x1234", reason: "format" },
      { line: 5, text: "hello", reason: "format" },
      { line: 6, text: "0X7afc830d90f3080dc754618a9e4f71775815c3ad", reason: "format" }], duplicates: [], headerSkipped: false } },
  { name: "semicolon-and-space-separators-batches-of-2", batchSize: 2,
    text: "addr;note\n0xffffffffffffffffffffffffffffffffffffffff;z\n0x7afc830d90f3080dc754618a9e4f71775815c3ad x\n0x0000000000000000000000000000000000000001\n0x9272f360b98160c1662abb6d2df9e4f313b39502,y\n0x9dab17a9ad061cbda2bef607a6a330ee74076e90\n",
    expect: { addresses: [A4, A3, A1, A2, A5], errors: [], duplicates: [], headerSkipped: true } },
  { name: "header-only-is-empty", text: "address\n\n# nothing\n", expect: { addresses: [], errors: [], duplicates: [], headerSkipped: true } },
  { name: "uppercase-0X-first-line-is-an-error-not-a-header", text: "0X9272f360b98160c1662abb6d2df9e4f313b39502\n0x9dab17a9ad061cbda2bef607a6a330ee74076e90\n",
    expect: { addresses: [A2], errors: [{ line: 1, text: "0X9272f360b98160c1662abb6d2df9e4f313b39502", reason: "format" }], duplicates: [], headerSkipped: false } },
  { name: "single-address-remove", allowed: false, text: "0x9272F360b98160c1662Abb6d2dF9e4F313B39502", expect: { addresses: [A1], errors: [], duplicates: [], headerSkipped: false } },
];

const params = { contract: CONTRACT, bscChainId: 31338, wantosChainId: 31337, bscNonce: 3, wantosNonce: 7, deadline: 1800000000 };
const types = { WhitelistBatch: [
  { name: "listHash", type: "bytes32" }, { name: "count", type: "uint32" }, { name: "allowed", type: "bool" },
  { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] };

const out = { rulesVersion: 1, params, cases: cases.map((c) => {
  const allowed = c.allowed ?? true;
  const size = c.batchSize ?? 500;
  const batches = [];
  if (c.expect.errors.length === 0) for (let i = 0; i < c.expect.addresses.length; i += size) {
    const addrs = c.expect.addresses.slice(i, i + size);
    const listHash = keccak256(encodeAbiParameters([{ type: "address[]" }], [addrs]));
    const b = { count: addrs.length, listHash };
    for (const [k, name, chainId, nonce0] of [["bsc", "BscVaultV2", params.bscChainId, params.bscNonce], ["wantos", "WantosBridgeV2", params.wantosChainId, params.wantosNonce]]) {
      const domain = { name, version: "1", chainId, verifyingContract: CONTRACT };
      const message = { listHash, count: addrs.length, allowed, nonce: BigInt(nonce0 + i / size), deadline: BigInt(params.deadline) };
      b[k] = {
        nonce: String(nonce0 + i / size),
        domainHash: hashDomain({ domain, types: { EIP712Domain: [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }] } }),
        messageHash: hashStruct({ data: message, primaryType: "WhitelistBatch", types }),
        digest: hashTypedData({ domain, types, primaryType: "WhitelistBatch", message }),
      };
    }
    batches.push(b);
  }
  return { name: c.name, text: c.text, allowed, batchSize: size, expect: c.expect, batches };
}) };
writeFileSync(new URL("../vectors.json", import.meta.url), JSON.stringify(out, null, 2) + "\n");
console.log("vectors.json written:", out.cases.length, "cases");
