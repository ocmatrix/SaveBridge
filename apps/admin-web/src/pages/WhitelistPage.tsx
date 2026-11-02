import { useEffect, useMemo, useRef, useState } from "react";
import { formatUnits, getAddress, type Address } from "viem";
import { chainNow, erc20Abi } from "../lib/chain";
import { SIDE_NAME, SIDES, type Side } from "../lib/config";
import { chunk, MAX_BATCH, parseAddressList, REASON_TEXT } from "../lib/normalize";
import { gate, gateWith, type Gate } from "../lib/perm";
import { FLAG_ICON, FLAG_TEXT, flagsFor, type Flag } from "../lib/risk";
import type { AddressInfo } from "../lib/api";
import {
  DEADLINE_AHEAD_S,
  diffChains,
  invalidateNonce,
  isComplete,
  prepareJob,
  readWhitelisted,
  runJob,
  whitelistHistory,
  writeOrder,
  type BatchJob,
  type WhitelistHistory,
} from "../lib/whitelist";
import { ActionButton, Addr, me, Section, ts, useApp } from "../ui";

interface RowInfo {
  isContract: Record<Side, boolean>;
  whitelisted: Record<Side, boolean>;
  balance: string | null;
  api?: AddressInfo;
}

const STATUS_TEXT: Record<string, string> = { pending: "待写入", signing: "等待钱包签名…", submitting: "提交中…", done: "已写入", skipped: "已是目标状态（跳过）", failed: "失败" };

export function WhitelistPage() {
  const { cfg, chains, signer, api, both } = useApp();
  const [text, setText] = useState("");
  const [allowed, setAllowed] = useState(true);
  const parsed = useMemo(() => parseAddressList(text), [text]);
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(0);
  const [info, setInfo] = useState<Record<string, RowInfo>>({});
  const [apiNote, setApiNote] = useState<string | null>(null);
  const [batchIdx, setBatchIdx] = useState(0);
  const [job, setJob] = useState<BatchJob | null>(null);
  const [jobBatch, setJobBatch] = useState(0); // 1-based batch number the prepared job belongs to
  const [running, setRunning] = useState(false);
  const [hist, setHist] = useState<Record<Side, WhitelistHistory> | null>(null);
  const [histErr, setHistErr] = useState<string | null>(null);

  /** Any change to what would be signed (list, selection, batch, add/remove) voids the prepared job and its hashes. */
  // Generation counter: every form change bumps it; an in-flight prepare/run whose generation is stale is discarded
  // (round-2 A-1). The form is also locked while preparing/running, so this is the second line of defence.
  const gen = useRef(0);
  const [preparing, setPreparing] = useState(false);
  const [formNote, setFormNote] = useState<string | null>(null);
  const resetJob = () => {
    gen.current++;
    setJob(null);
    setJobBatch(0);
    setFormNote(null);
  };
  const pages = useMemo(() => chunk(parsed.addresses), [parsed]);
  const pageAddrs = pages[page] ?? [];

  const flagsOf = (a: string): Flag[] => flagsFor({ info: info[a]?.api, isContract: !!info[a] && (info[a]!.isContract.bsc || info[a]!.isContract.wantos) });
  // a new list starts fully selected (hints never pre-select or block anything)
  useEffect(() => {
    setUnchecked(new Set());
    setPage(0);
    resetJob();
    setBatchIdx(0);
  }, [parsed]);

  // reference info for the visible page only (≤ 500 rows)
  useEffect(() => {
    let live = true;
    const todo = pageAddrs.filter((a) => !info[a]);
    if (todo.length === 0) return;
    (async () => {
      const code = async (s: Side, a: string) => ((await chains[s].client.getCode({ address: a as Address })) ?? "0x") !== "0x";
      const [wb, ww] = await Promise.all([readWhitelisted(chains.bsc, todo), readWhitelisted(chains.wantos, todo)]);
      const token = both?.wantos.token;
      const dec = token ? Number(await chains.wantos.client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" })) : 18;
      const rows: Record<string, RowInfo> = {};
      await Promise.all(
        todo.map(async (a, i) => {
          const [cb, cw, bal] = await Promise.all([
            code("bsc", a),
            code("wantos", a),
            token ? (chains.wantos.client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [a as Address] }) as Promise<bigint>) : Promise.resolve(null),
          ]);
          rows[a] = { isContract: { bsc: cb, wantos: cw }, whitelisted: { bsc: wb[i]!, wantos: ww[i]! }, balance: bal === null ? null : formatUnits(bal, dec) };
        }),
      );
      if (api) {
        try {
          const ai = await api.addressInfo(todo);
          for (const a of todo) if (rows[a] && ai[a]) rows[a]!.api = ai[a];
        } catch (e) {
          setApiNote(`网体、上级、历史跨出暂不可用（${(e as Error).message}）`);
        }
      } else setApiNote("未配置管理接口：网体、上级、历史跨出显示为 —");
      if (live) setInfo((x) => ({ ...x, ...rows }));
    })().catch((e) => live && setApiNote(`参考信息读取失败：${(e as Error).message}`));
    return () => {
      live = false;
    };
  }, [pageAddrs, chains, api, both?.wantos.token]); // eslint-disable-line react-hooks/exhaustive-deps

  const selected = useMemo(() => parsed.addresses.filter((a) => !unchecked.has(a)), [parsed, unchecked]);
  const batches = useMemo(() => chunk(selected), [selected]);
  const batch = batches[batchIdx] ?? [];
  const removedByHand = parsed.addresses.length - selected.length;

  const toggle = (a: string, on: boolean) => {
    setUnchecked((s) => {
      const n = new Set(s);
      if (on) n.delete(a);
      else n.add(a);
      return n;
    });
    resetJob();
  };

  const writeGate = (s: Side): Gate =>
    both
      ? gateWith(
          gate("wl", me(signer), both[s]),
          [!both[s].anyRecovery, `${SIDE_NAME[s]} 恢复进行中，白名单禁止写入`],
          [!(allowed && both[s].frozen), `${SIDE_NAME[s]} 白名单已冻结，只能移除`],
        )
      : { ok: false, reason: "读取链上状态中…" };
  const bothGate: Gate = (() => {
    for (const s of SIDES) {
      const g = writeGate(s);
      if (!g.ok) return g;
    }
    return batch.length === 0 ? { ok: false, reason: "没有要写入的地址" } : parsed.errors.length > 0 ? { ok: false, reason: "地址文件有错误" } : { ok: true };
  })();

  const prepare = async () => {
    const g = ++gen.current;
    // never leave the previous batch's hashes on screen if this fails
    setJob(null);
    setJobBatch(0);
    setFormNote(null);
    setPreparing(true);
    try {
      const deadline = (await chainNow(chains.bsc)) + DEADLINE_AHEAD_S;
      const j = await prepareJob(chains, batch, allowed, deadline);
      if (g !== gen.current) {
        setFormNote("准备期间表单已改动，请重新准备");
        return;
      }
      setJob(j);
      setJobBatch(batchIdx + 1);
    } finally {
      setPreparing(false);
    }
  };
  const runningRef = useRef(false); // double-click guard (state would be stale inside this closure)
  const run = async () => {
    if (!job || !signer || runningRef.current) return;
    runningRef.current = true;
    const g = gen.current;
    const live = () => g === gen.current;
    setRunning(true);
    try {
      const done = await runJob(job, { chains, signer, onProgress: (j) => live() && setJob(j), shouldStop: () => !live() });
      if (!live()) {
        setFormNote("签名期间表单已改动，已停止；请重新准备");
        return;
      }
      setJob(done);
      if (!isComplete(done)) {
        // the button must not show 「已完成」 when a chain failed or the run stopped
        const bad = (["bsc", "wantos"] as Side[]).find((s) => done.runs[s].status === "failed");
        throw new Error(bad ? (done.runs[bad].error ?? `${SIDE_NAME[bad]}：失败`) : "未完成");
      }
    } finally {
      runningRef.current = false;
      setRunning(false);
    }
  };
  const locked = preparing || running;
  const loadHistory = async () => {
    try {
      setHistErr(null);
      const [b, w] = await Promise.all([whitelistHistory(chains.bsc), whitelistHistory(chains.wantos)]);
      setHist({ bsc: b, wantos: w });
    } catch (e) {
      setHistErr((e as Error).message);
    }
  };
  /** Exports the PREPARED batch (contents and file name from the job, never from the form). */
  const exportPrepared = () => {
    if (!job) return;
    const url = URL.createObjectURL(new Blob([job.addresses.map((a) => getAddress(a)).join("\n") + "\n"], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `whitelist-${job.allowed ? "add" : "remove"}-batch${jobBatch}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };
  // Everything shown for checking comes from the prepared job (what will actually be signed), never from the form.
  const ready = job && job.runs.bsc.hashes && job.runs.wantos.hashes && job.runs.bsc.nonce !== undefined && job.runs.wantos.nonce !== undefined ? job : null;
  const offlineCmd = ready
    ? `node offline-check.mjs <原始文件> --action ${ready.allowed ? "add" : "remove"} --contract ${cfg.bsc.bridge} --bsc-chain-id ${cfg.bsc.chainId} --wantos-chain-id ${cfg.wantos.chainId} --batch ${jobBatch} --bsc-nonce ${ready.runs.bsc.nonce} --wantos-nonce ${ready.runs.wantos.nonce} --deadline ${ready.deadline} --expect-list-hash ${ready.runs.bsc.hashes!.listHash}`
    : null;
  const opAllowed = job ? job.allowed : allowed;
  const needsPrepare = !!job && (job.runs.bsc.needsPrepare || job.runs.wantos.needsPrepare);

  return (
    <div>
      <Section title="1. 上传或粘贴地址">
        <p className="hint">CSV / TXT / 粘贴均可；每行取第一列；第一行不是地址会当表头跳过；# 开头为注释。规则与离线核对工具（rules v1）完全相同。</p>
        <input
          type="file"
          accept=".csv,.txt,text/plain,text/csv"
          aria-label="选择地址文件"
          disabled={locked}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void f.text().then(setText);
          }}
        />
        <textarea aria-label="地址列表" disabled={locked} rows={6} value={text} onChange={(e) => setText(e.target.value)} placeholder="0x…" />
        <fieldset>
          <label>
            <input type="radio" name="mode" disabled={locked} checked={allowed} onChange={() => (setAllowed(true), resetJob())} /> 添加
          </label>
          <label>
            <input type="radio" name="mode" disabled={locked} checked={!allowed} onChange={() => (setAllowed(false), resetJob())} /> 移除
          </label>
        </fieldset>
        {parsed.errors.length > 0 && (
          <div className="err" role="alert">
            地址文件有 {parsed.errors.length} 处错误，修好原始文件后再上传：
            <ul>
              {parsed.errors.map((e) => (
                <li key={e.line}>
                  第 {e.line} 行 <code>{e.text}</code> {REASON_TEXT[e.reason]}
                </li>
              ))}
            </ul>
          </div>
        )}
        <p data-testid="parse-summary">
          有效地址 {parsed.addresses.length} 个（去重、排序后）；重复 {parsed.duplicates.length} 个；表头{parsed.headerSkipped ? "已跳过" : "无"}
        </p>
      </Section>

      {parsed.addresses.length > 0 && parsed.errors.length === 0 && (
        <Section title="2. 逐行参考信息（只作提示）">
          {apiNote && <p className="hint">{apiNote}</p>}
          <p className="hint">
            🟡 不在网体内　⚪ 合约地址（只作提示；风控只靠白名单本身）
          </p>
          {pages.length > 1 && (
            <p>
              第 {page + 1}/{pages.length} 页
              <button type="button" disabled={page === 0} onClick={() => setPage(page - 1)}>
                上一页
              </button>
              <button type="button" disabled={page >= pages.length - 1} onClick={() => setPage(page + 1)}>
                下一页
              </button>
            </p>
          )}
          <table>
            <thead>
              <tr>
                <th>选</th>
                <th>地址</th>
                <th>标记</th>
                <th>网体/上级</th>
                <th>历史跨出</th>
                <th>WANTOS-USDT 余额</th>
                <th>当前白名单 BSC / WANTOS</th>
              </tr>
            </thead>
            <tbody>
              {pageAddrs.map((a) => {
                const r = info[a];
                const flags = flagsOf(a);
                return (
                  <tr key={a} data-testid={`row-${a}`}>
                    <td>
                      <input type="checkbox" disabled={locked} aria-label={`选择 ${a}`} checked={!unchecked.has(a)} onChange={(e) => toggle(a, e.target.checked)} />
                    </td>
                    <td>
                      <Addr a={a} />
                    </td>
                    <td title={flags.map((f) => FLAG_TEXT[f]).join("、")}>{flags.map((f) => FLAG_ICON[f]).join("")}</td>
                    <td>{r?.api ? `${r.api.inNetwork === null ? "—" : r.api.inNetwork ? "在网体" : "不在网体"}${r.api.parent ? ` / ${r.api.parent}` : ""}` : "—"}</td>
                    <td>{r?.api?.bridgedOut ?? "—"}</td>
                    <td>{r?.balance ?? "—"}</td>
                    <td>{r ? `${r.whitelisted.bsc ? "是" : "否"} / ${r.whitelisted.wantos ? "是" : "否"}` : "…"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Section>
      )}

      {selected.length > 0 && parsed.errors.length === 0 && (
        <Section title="3. 核对并签名">
          {removedByHand > 0 && (
            <p className="warn" role="alert">
              你在页面上取消了 {removedByHand} 个地址：离线核对前，请先在原始文件里删掉它们（或核对下面导出的清单），否则 listHash 对不上是正常的。
            </p>
          )}
          <p>
            共 {selected.length} 个地址，分 {batches.length} 批（每批 ≤ {MAX_BATCH}）。
            {batches.length > 1 && (
              <select aria-label="选择批次" disabled={locked} value={batchIdx} onChange={(e) => (setBatchIdx(Number(e.target.value)), resetJob())}>
                {batches.map((b, i) => (
                  <option key={i} value={i}>
                    第 {i + 1} 批（{b.length} 个）
                  </option>
                ))}
              </select>
            )}
            <button type="button" onClick={exportPrepared} disabled={!ready}>
              导出已准备批次的清单（txt）
            </button>
            <span className="hint">（仅供对照查看；离线核对请用你自己的原始文件）</span>
          </p>
          <p>
            操作：<strong data-testid="op">{opAllowed ? "添加" : "移除"}</strong>；写入顺序：{writeOrder(opAllowed).map((s) => SIDE_NAME[s]).join(" → ")}
          </p>
          <p className="hint" data-testid="d1-note">
            每批在每条链上要在钱包里确认两次：一次签名（EIP-712）+ 一次发交易（applyWhitelistBatch），两条链共 4 次（提交服务接通前，见 PR6-NOTES D1）。白名单钱包需要在两条链上都备 gas（BSC 上 BNB、WANTOS 上 WANT）。
          </p>
          <ActionButton label="准备本批（生成 deadline 与哈希）" gate={running ? { ok: false, reason: "签名写入进行中" } : bothGate} run={prepare} />
          {formNote && (
            <p className="err" role="alert">
              {formNote}
            </p>
          )}
          {ready && (
            <div className="hashes" data-testid="hashes">
              <p>
                第 {jobBatch} 批　listHash <code data-testid="listHash">{ready.runs.bsc.hashes!.listHash}</code>　count <code data-testid="count">{ready.runs.bsc.hashes!.count}</code>　deadline{" "}
                <code>{String(ready.deadline)}</code>（{ts(ready.deadline)}）
              </p>
              {writeOrder(ready.allowed).map((s) => (
                <p key={s} data-testid={`chain-${s}`}>
                  {SIDE_NAME[s]}（chainId {chains[s].cfg.chainId}，nonce <span data-testid={`nonce-${s}`}>{String(ready.runs[s].nonce)}</span>）<br />
                  domain hash <code data-testid={`domain-${s}`}>{ready.runs[s].hashes!.domainHash}</code>
                  <br />
                  message hash <code data-testid={`msg-${s}`}>{ready.runs[s].hashes!.messageHash}</code>
                </p>
              ))}
              <p className="hint">在另一台设备离线运行（结果一致才签）：</p>
              <pre data-testid="offline-cmd">{offlineCmd}</pre>
            </div>
          )}
          {job && (
            <div>
              <ActionButton label={isComplete(job) ? "已完成" : job.runs.bsc.status === "pending" && job.runs.wantos.status === "pending" ? "签名并写入两条链" : "重试未完成的链"} gate={isComplete(job) || running || needsPrepare ? { ok: false, reason: isComplete(job) ? "两条链都已完成" : needsPrepare ? "需要重新准备本批并重新离线核对" : "进行中" } : bothGate} run={run} />
              <ul data-testid="progress">
                {writeOrder(job.allowed).map((s) => (
                  <li key={s}>
                    {SIDE_NAME[s]}：{STATUS_TEXT[job.runs[s].status]}
                    {job.runs[s].nonce !== undefined && `（nonce ${job.runs[s].nonce}）`}
                    {job.runs[s].txHash && (
                      <>
                        　交易 <code>{job.runs[s].txHash}</code>
                      </>
                    )}
                    {job.runs[s].error && <span className="err">　{job.runs[s].error}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Section>
      )}

      <Section title="当前白名单、批次记录、两链不一致">
        <button type="button" onClick={() => void loadHistory()}>
          读取链上记录
        </button>
        {histErr && <p className="err">{histErr}</p>}
        {hist && <History hist={hist} />}
        <h3>作废已签名未提交的批次</h3>
        {SIDES.map((s) => (
          <p key={s}>
            {SIDE_NAME[s]}：
            <ActionButton
              label={`作废 ${SIDE_NAME[s]} 当前批次 nonce`}
              gate={both ? gate("wl", me(signer), both[s]) : { ok: false, reason: "读取中" }}
              confirmText="作废后，已签名未提交的批次全部失效。确定？"
              run={() => invalidateNonce(chains[s], signer!)}
            />
          </p>
        ))}
      </Section>
    </div>
  );
}

function History({ hist }: { hist: Record<Side, WhitelistHistory> }) {
  const d = diffChains(hist.bsc.current, hist.wantos.current);
  return (
    <div data-testid="history">
      <p>
        BSC 当前 {hist.bsc.current.length} 个；WANTOS 当前 {hist.wantos.current.length} 个
      </p>
      {d.onlyBsc.length + d.onlyWantos.length > 0 ? (
        <div className="warn">
          两链不一致（把这些地址按原操作再提交一次即可补齐：已完成的链会自动跳过）：
          {d.onlyBsc.length > 0 && <p>只在 BSC：{d.onlyBsc.join("、")}</p>}
          {d.onlyWantos.length > 0 && <p>只在 WANTOS：{d.onlyWantos.join("、")}</p>}
        </div>
      ) : (
        <p className="ok">两链一致</p>
      )}
      {SIDES.map((s) => (
        <details key={s}>
          <summary>
            {SIDE_NAME[s]} 批次记录（{hist[s].batches.length}）与紧急移除（{hist[s].emergency.length}）
          </summary>
          <ul>
            {hist[s].batches.map((b) => (
              <li key={b.tx}>
                nonce {String(b.nonce)} {b.allowed ? "添加" : "移除"} {String(b.count)} 个 listHash <code>{b.listHash}</code> 区块 {String(b.block)}
              </li>
            ))}
            {hist[s].emergency.map((b) => (
              <li key={b.tx}>
                紧急移除 {String(b.count)} 个（{b.by}）区块 {String(b.block)}
              </li>
            ))}
          </ul>
        </details>
      ))}
    </div>
  );
}
