import { useState } from "react";
import { getAddress } from "viem";
import { describeError } from "../lib/chain";
import { parseAddressList, REASON_TEXT, type ParseError } from "../lib/normalize";
import { readWhitelisted } from "../lib/whitelist";
import { Section, useApp } from "../ui";

export const MAX_LOOKUP = 500;

interface Row {
  address: string;
  bsc: boolean;
  wantos: boolean;
}

/** /lookup — is this address on the whitelist of each chain? Read-only (no wallet needed); same address rules as the add flow. */
export function LookupPage() {
  const { chains } = useApp();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [res, setRes] = useState<{ rows: Row[]; errors: ParseError[] } | null>(null);

  const query = async () => {
    setErr(null);
    setRes(null);
    const p = parseAddressList(text);
    if (p.addresses.length === 0) return setErr("没有可查询的地址：请输入至少一个有效地址（每行一个）");
    if (p.addresses.length > MAX_LOOKUP) return setErr(`一次最多查 ${MAX_LOOKUP} 个，请分批查询`);
    setBusy(true);
    try {
      const [b, w] = await Promise.all([readWhitelisted(chains.bsc, p.addresses), readWhitelisted(chains.wantos, p.addresses)]);
      setRes({ rows: p.addresses.map((address, i) => ({ address, bsc: b[i]!, wantos: w[i]! })), errors: p.errors });
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const count = (f: (r: Row) => boolean) => (res ? res.rows.filter(f).length : 0);
  return (
    <div>
      <Section title="白名单查询">
        <p className="hint">输入地址（每行一个，最多 {MAX_LOOKUP} 个），查它在 BSC 和 WANTOS 上是否在白名单。只读链上，不需要连接钱包。</p>
        <textarea aria-label="查询地址" rows={6} value={text} onChange={(e) => setText(e.target.value)} placeholder="0x…" />
        <span className="action">
          <button type="button" disabled={busy || text.trim() === ""} onClick={() => void query()}>
            {busy ? "查询中…" : "查询"}
          </button>
        </span>
        {err && (
          <p className="err" role="alert">
            {err}
          </p>
        )}
      </Section>
      {res && (
        <Section title="结果">
          <ul data-testid="lookup-summary" style={{ listStyle: "none", padding: 0, margin: "0 0 12px" }}>
            <li>两条链都在 {count((r) => r.bsc && r.wantos)} 个</li>
            <li>只在一条链 {count((r) => r.bsc !== r.wantos)} 个</li>
            <li>都不在 {count((r) => !r.bsc && !r.wantos)} 个</li>
          </ul>
          {res.errors.length > 0 && (
            <div className="warn" data-testid="lookup-errors">
              有 {res.errors.length} 行不是有效地址，未查询：
              <ul>
                {res.errors.map((e) => (
                  <li key={e.line}>
                    第 {e.line} 行 {e.text}：{REASON_TEXT[e.reason]}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <table>
            <thead>
              <tr>
                <th>地址</th>
                <th>BSC</th>
                <th>WANTOS</th>
              </tr>
            </thead>
            <tbody>
              {res.rows.map((r) => (
                <tr key={r.address} data-testid={`lookup-row-${getAddress(r.address)}`}>
                  <td>
                    <code className="addr">{getAddress(r.address)}</code>
                  </td>
                  <td>BSC {r.bsc ? "是" : "否"}</td>
                  <td>WANTOS {r.wantos ? "是" : "否"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}
    </div>
  );
}
