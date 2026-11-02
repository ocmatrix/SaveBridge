#!/usr/bin/env python3
"""
Mutation testing for the deploy-prep code (keystore, Telegram, RPC policy, wiring).
Runs on an INDEPENDENT copy of the worktree (APFS clone / cp -R into a temp dir): the working tree is
never modified. Each mutant must make its targeted tests fail ("killed").

    python3 scripts/mutation-deploy-prep.py [--keep]
"""
import os, shutil, subprocess, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# (id, package, file, old, new, tests)
M = [
    ("K01", "ops", "src/keystore.ts", "    d.setAAD(aad(k));\n", "", "test/keystore.test.ts"),
    ("K02", "ops", "src/keystore.ts", "if (N < minN) throw", "if (N < 2) throw", "test/keystore.test.ts"),
    ("K03", "ops", "src/keystore.ts", "if ((st.mode & 0o077) !== 0) throw", "if ((st.mode & 0o007) !== 0) throw", "test/keystore.test.ts"),
    ("K04", "ops", "src/keystore.ts", "if (!st.isFile()) throw", "if (false) throw", "test/keystore.test.ts"),
    ("K05", "ops", "src/keystore.ts", "constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL", "constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC", "test/keystore.test.ts"),
    ("K06", "ops", "src/keystore.ts", "  } finally {\n    o.passphrase.fill(0);\n  }\n}", "  } finally {\n  }\n}", "test/keystore.test.ts"),
    ("K07", "ops", "src/keygen.ts", "      unlinkSync(o.out);", "      void unlinkSync;", "test/keystore.test.ts"),
    ("K08", "ops", "src/credentials.ts", "  if (end > 0 && b[end - 1] === 0x0a) end--;\n", "", "test/keystore.test.ts"),
    ("K09", "ops", "src/keygenCli.ts", "  if (bad) throw", "  if (false) throw", "test/keygenCli.test.ts"),
    ("T01", "ops", "src/telegram.ts", "if (m.level !== 1 && this.sentAt.length", "if (this.sentAt.length", "test/telegram.test.ts"),
    ("T02", "ops", "src/telegram.ts", "t - prev < (this.o.dedupWindowMs ?? 600_000)", "t - prev > (this.o.dedupWindowMs ?? 600_000)", "test/telegram.test.ts"),
    ("T03", "ops", "src/telegram.ts", "let text = redact(lines.join(\"\\n\"), known);", "let text = lines.join(\"\\n\");", "test/telegram.test.ts"),
    ("T04", "ops", "src/telegram.ts", "throw new TelegramError(`telegram unreachable: ${redact(e instanceof Error ? e.message : String(e), this.known)}`);", "throw new TelegramError(`telegram unreachable: ${e instanceof Error ? e.message : String(e)}`);", "test/telegram.test.ts"),
    ("P01", "ops", "src/rpcPolicy.ts", "if (o.role === \"read\" && WRITE_METHODS.has(method))", "if (false && WRITE_METHODS.has(method))", "test/rpcPolicy.test.ts"),
    ("P02", "ops", "src/rpcPolicy.ts", "    if (!READ_METHODS.has(method)) {", "    if (false) {", "test/rpcPolicy.test.ts"),
    ("P03", "ops", "src/rpcPolicy.ts", " || h.endsWith(`.${r.toLowerCase()}`)", "", "test/rpcPolicy.test.ts"),
    ("P04", "ops", "src/rpcPolicy.ts", "const sameNode = a.n !== undefined && a.n === b.n;", "const sameNode = false;", "test/rpcPolicy.test.ts"),
    ("P05", "ops", "src/rpcPolicy.ts", "coolUntil = now() + Math.min(", "coolUntil = 0 * Math.min(", "test/rpcPolicy.test.ts"),
    ("P06", "ops", "src/rpcPolicy.ts", "to - from + 1n > maxRange", "to - from > maxRange", "test/rpcPolicy.test.ts"),
    ("P07", "ops", "src/rpcPolicy.ts", "if (groups.length < o.required)", "if (groups.length < 1)", "test/rpcPolicy.test.ts"),
    ("P08", "ops", "src/rpcPolicy.ts", "if (readOnly && o.role === \"write\") throw", "if (false) throw", "test/rpcPolicy.test.ts"),
    ("R01", "relayer", "src/keystoreSigner.ts", "if (typeof tx.chainId !== \"number\" || !this.chainIds.has(tx.chainId))", "if (typeof tx.chainId !== \"number\")", "test/keystoreSigner.test.ts"),
    ("R02", "relayer", "src/keystoreSigner.ts", "if (t.type !== undefined && t.type !== \"legacy\") throw", "if (false) throw", "test/keystoreSigner.test.ts"),
    ("R03", "relayer", "src/bootstrap.ts", "  assertWriteEndpoint(wWrite.url, `WANTOS write endpoint (${wWrite.label})`);\n", "", "test/deployWiring.test.ts"),
    ("R04", "relayer", "src/bootstrap.ts", "      client: c.wantos.write, // sending + sender reads: rpc3 only", "      client: c.wantos.cross[0]!,", "test/keystoreE2E.test.ts"),
    ("R05", "relayer", "src/bootstrap.ts", "if (usesExternalReadOnly && cfg.poll.intervalMs < MIN_POLL_MS_WITH_EXTERNAL_RPC)", "if (false)", "test/deployWiring.test.ts"),
    ("R06", "relayer", "src/config.ts", "if (!LOOPBACK_HOSTS.includes(c.api.host)) throw", "if (false) throw", "test/deployWiring.test.ts"),
    ("R07", "relayer", "src/telegramSink.ts", "      this.enqueue({ a, at });\n    }\n  }", "    }\n  }", "test/deployWiring.test.ts"),
    ("R08", "relayer", "src/bootstrap.ts", "if (since !== null && (o.now ?? Date.now)() - since > (o.l1GraceMs ?? 10 * 60_000)) throw", "if (false) throw", "test/deployWiring.test.ts"),
    ("R09", "relayer", "src/bootstrap.ts", "if (isReadOnlyHost(primary.url)) throw", "if (false) throw", "test/deployWiring.test.ts"),
    ("R10", "relayer", "src/config.ts", "if (new Set(addrs).size !== 3) throw", "if (false) throw", "test/deployWiring.test.ts"),
    ("W01", "watcher", "src/deploy.ts", "    assertWriteEndpoint(url, `${c} pause() write endpoint (${name})`);\n", "", "test/unit/deploy.test.ts"),
    ("W02", "watcher", "src/deploy.ts", "!(tick >= MIN_TICK_SECONDS)", "!(tick >= 1)", "test/unit/deploy.test.ts"),
    ("W03", "watcher", "src/deploy.ts", "if (open.includes(key)) {", "if (true) {", "test/unit/deploy.test.ts"),
    ("W04", "watcher", "src/deploy.ts", "&& core.chains[c].maxBlockRange > runtime.externalRpc.maxLogsBlockRange", "&& false", "test/unit/deploy.test.ts"),
    ("W05", "watcher", "src/deploy.ts", "    if (got !== chainId) throw", "    if (false) throw", "test/integration/deploy-keystore-pause.test.ts"),
    ("W06", "watcher", "src/deploy.ts", "if (out.bsc.address.toLowerCase() === out.wantos.address.toLowerCase()) throw", "if (false) throw", "test/integration/deploy-keystore-pause.test.ts"),
]


def main() -> int:
    keep = "--keep" in sys.argv
    tmp = tempfile.mkdtemp(prefix="sb-mutation-")
    copy = os.path.join(tmp, "repo")
    # independent copy (copy-on-write clone on APFS when available), symlinks preserved
    r = subprocess.run(["cp", "-Rc", ROOT, copy])
    if r.returncode != 0:
        shutil.copytree(ROOT, copy, symlinks=True)
    killed, survived = [], []
    try:
        for mid, pkg, f, old, new, tests in M:
            path = os.path.join(copy, "packages", pkg, f)
            src = open(path).read()
            if src.count(old) != 1:
                print(f"{mid} INVALID: pattern found {src.count(old)} times in {pkg}/{f}")
                survived.append(mid)
                continue
            open(path, "w").write(src.replace(old, new))
            try:
                res = subprocess.run(["npx", "vitest", "run", *tests.split()], cwd=os.path.join(copy, "packages", pkg), capture_output=True, text=True, timeout=600)
            finally:
                open(path, "w").write(src)
            if res.returncode != 0:
                killed.append(mid)
                print(f"{mid} killed   {pkg}/{f}")
            else:
                survived.append(mid)
                print(f"{mid} SURVIVED {pkg}/{f}: {old.strip()[:70]!r}")
    finally:
        if not keep:
            shutil.rmtree(tmp, ignore_errors=True)
    print(f"\nmutants: {len(M)}  killed: {len(killed)}  survived: {len(survived)} {survived}")
    return 0 if not survived else 1


if __name__ == "__main__":
    sys.exit(main())
