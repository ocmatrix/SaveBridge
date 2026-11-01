import { describe, expect, it } from "vitest";
import { buildCsp, buildHeadersFile } from "../../src/csp";
import { parseConfig } from "../../src/config";
import { testEnv, testConfig } from "../fixtures";

describe("CSP (DESIGN §8.1 / §8.4)", () => {
  const csp = buildCsp(testConfig);
  const dir = (name: string) => csp.split(";").map((s) => s.trim()).find((s) => s.startsWith(name + " "));

  it("has no unsafe-inline / unsafe-eval / wildcards", () => {
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|unsafe-hashes|wasm-unsafe-eval/);
    expect(csp).not.toMatch(/(^|\s)\*(\s|;|$)/);
  });
  it("only allows own scripts", () => {
    expect(dir("script-src")).toBe("script-src 'self'");
    expect(dir("default-src")).toBe("default-src 'none'");
    expect(dir("frame-ancestors")).toBe("frame-ancestors 'none'");
    expect(dir("object-src")).toBe("object-src 'none'");
  });
  it("connect-src = self + two RPC origins + WalletConnect relay only", () => {
    expect(dir("connect-src")).toBe(
      "connect-src 'self' https://rpc.wantos.io https://bsc-rpc.example.org wss://relay.walletconnect.com wss://relay.walletconnect.org",
    );
  });
  it("adds the relayer read-only API origin when configured", () => {
    const c = parseConfig({ ...testEnv, VITE_RELAYER_API: "https://api.example.org/base" });
    expect(buildCsp(c)).toContain(" https://api.example.org ");
  });
  it("headers file applies to all paths and adds hardening headers", () => {
    const h = buildHeadersFile(testConfig);
    expect(h.startsWith("/*\n")).toBe(true);
    expect(h).toContain("Content-Security-Policy: ");
    expect(h).toContain("X-Content-Type-Options: nosniff");
    expect(h).toContain("X-Frame-Options: DENY");
    expect(h).toContain("Referrer-Policy: no-referrer");
    expect(h).toContain("Strict-Transport-Security: max-age=");
  });
});
