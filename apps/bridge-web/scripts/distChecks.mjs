// Pure checks over build output (used by check-dist.mjs and unit-tested in test/unit/distChecks.test.ts).

/** anvil's well-known default test keys/mnemonic + generic secret markers. Must never appear in the bundle. */
export const SECRET_PATTERNS = [
  /ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80/i,
  /59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d/i,
  /5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a/i,
  /test test test test test test test test test test test junk/,
  /PRIVATE_KEY|MNEMONIC|SECRET_KEY/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

/** Unlimited-approval markers: MaxUint256 as hex / decimal / identifier / expression. */
export const MAX_APPROVE_PATTERNS = [
  /0x[fF]{64}(?![0-9a-fA-F])/,
  /115792089237316195423570985008687907853269984665640564039457584007913129639935/,
  /\b[mM]axUint256\b/,
  /2n\s*\*\*\s*256n/,
];

export function checkCsp(headers) {
  const errs = [];
  if (!headers) return ["_headers missing"];
  const line = headers.split("\n").find((l) => l.trim().startsWith("Content-Security-Policy:"));
  if (!line) errs.push("no Content-Security-Policy in _headers");
  else {
    if (/unsafe-inline|unsafe-eval|unsafe-hashes/.test(line)) errs.push("CSP contains unsafe-*");
    if (!/script-src 'self'(;|$)/.test(line)) errs.push("script-src is not exactly 'self'");
    if (!/default-src 'none'/.test(line)) errs.push("default-src is not 'none'");
  }
  return errs;
}

export function checkIndexHtml(html) {
  const errs = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (!/\bsrc=/.test(m[1]) || m[2].trim()) errs.push("inline <script> in index.html");
  }
  if (/<style\b/i.test(html)) errs.push("inline <style> in index.html");
  if (/\son[a-z]+\s*=/i.test(html)) errs.push("inline event handler in index.html");
  return errs;
}

/**
 * viem itself keeps `2n**256n-1n` as a numeric bound (fee validation, ABI uint256 range). In the bundle that
 * expression is therefore only flagged when it appears near an `approve`; every other marker is flagged anywhere.
 */
const LIB_BOUND = /2n\s*\*\*\s*256n/;
const NEAR_APPROVE = /approve[\s\S]{0,300}2n\s*\*\*\s*256n|2n\s*\*\*\s*256n[\s\S]{0,300}approve/;

export function checkFile(name, text) {
  const errs = [];
  if (/(^|\/)\.env/.test(name)) errs.push(`env file shipped: ${name}`);
  for (const p of SECRET_PATTERNS) if (p.test(text)) errs.push(`${name}: secret-like content ${p}`);
  for (const p of MAX_APPROVE_PATTERNS) if (p !== MAX_APPROVE_PATTERNS[3] && p.test(text)) errs.push(`${name}: MaxUint256 marker ${p}`);
  if (LIB_BOUND.test(text) && NEAR_APPROVE.test(text)) errs.push(`${name}: 2n**256n near approve`);
  if (/\beval\s*\(|new Function\s*\(/.test(text)) errs.push(`${name}: eval/new Function (blocked by CSP)`);
  return errs;
}

const WC = new Set(["wss://relay.walletconnect.com", "wss://relay.walletconnect.org"]);

/** Real builds: connect-src = 'self' + ≤3 https origins (two RPCs, optional relayer API) + WalletConnect relay only. */
export function checkConnectSrc(headers) {
  const line = (headers ?? "").split("\n").find((l) => l.includes("Content-Security-Policy:")) ?? "";
  const dir = line.split(";").map((d) => d.trim()).find((d) => d.startsWith("connect-src ") || d.includes(" connect-src "));
  if (!dir) return ["no connect-src"];
  const srcs = dir.slice(dir.indexOf("connect-src ") + 12).split(/\s+/).filter(Boolean);
  const errs = [];
  const others = srcs.filter((s) => s !== "'self'" && !WC.has(s));
  for (const s of others) if (!/^https:\/\/[^/]+$/.test(s) || /localhost|127\.0\.0\.1|\[::1\]/.test(s)) errs.push(`connect-src origin not allowed in a real build: ${s}`);
  if (others.length < 2 || others.length > 3) errs.push(`connect-src must list the two RPCs (+ optional relayer API), got ${others.length}`);
  if (!/frame-ancestors 'none'/.test(line)) errs.push("frame-ancestors is not 'none'");
  return errs;
}
