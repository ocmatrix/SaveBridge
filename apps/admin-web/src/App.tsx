import { useMemo, useRef, useState, type ReactNode } from "react";
import type { Chains, Signer } from "./lib/chain";
import { isPlaceholder, type AppConfig } from "./lib/config";
import { AdminApi } from "./lib/api";
import { createSession, sessionValid, type Session } from "./lib/siwe";
import { Ctx, useBothStates, type AppCtx } from "./ui";
import { WhitelistPage } from "./pages/WhitelistPage";
import { EmergencyPage } from "./pages/EmergencyPage";
import { TimelockPage } from "./pages/TimelockPage";
import { ParamsPage } from "./pages/ParamsPage";
import { HandoverPage } from "./pages/HandoverPage";
import { ReviewPage } from "./pages/ReviewPage";
import { ReservesPage } from "./pages/ReservesPage";

export const ROUTES: { path: string; title: string; page: () => ReactNode }[] = [
  { path: "/", title: "白名单", page: () => <WhitelistPage /> },
  { path: "/emergency", title: "紧急", page: () => <EmergencyPage /> },
  { path: "/timelock", title: "时间锁", page: () => <TimelockPage /> },
  { path: "/params", title: "参数", page: () => <ParamsPage /> },
  { path: "/handover", title: "交接与恢复", page: () => <HandoverPage /> },
  { path: "/review", title: "订单审核与退款", page: () => <ReviewPage /> },
  { path: "/reserves", title: "储备与对账", page: () => <ReservesPage /> },
];

export interface AppProps {
  cfg: AppConfig;
  chains: Chains;
  signer: Signer | null;
  /** wallet connect / disconnect UI (wagmi in the real app; nothing in tests) */
  walletSlot?: ReactNode;
  initialPath?: string;
  fetchFn?: typeof fetch;
}

export function App(p: AppProps) {
  const [path, setPath] = useState(p.initialPath ?? (typeof location !== "undefined" ? location.pathname : "/"));
  const { both, err, reload } = useBothStates(p.chains);
  const session = useRef<Session | null>(null);
  const signerRef = useRef(p.signer);
  signerRef.current = p.signer;
  const api = useMemo(
    () =>
      p.cfg.adminApi
        ? new AdminApi(
            p.cfg.adminApi,
            async () => {
              const s = signerRef.current;
              if (!s) throw new Error("未连接钱包");
              if (!sessionValid(session.current, s.address)) session.current = await createSession(s, { domain: p.cfg.siweDomain, chainId: p.cfg.wantos.chainId });
              return session.current!.header;
            },
            p.fetchFn,
          )
        : null,
    [p.cfg, p.fetchFn],
  );
  const ctx: AppCtx = { cfg: p.cfg, chains: p.chains, signer: p.signer, api, both, loadError: err, reload };
  const route = ROUTES.find((r) => r.path === path) ?? ROUTES[0]!;
  const go = (to: string) => {
    setPath(to);
    if (typeof history !== "undefined") history.pushState(null, "", to);
  };
  return (
    <Ctx.Provider value={ctx}>
      <header>
        <h1>WANTOS 桥管理后台</h1>
        {isPlaceholder(p.cfg) && <p className="err">占位构建：没有真实合约地址</p>}
        <div className="wallet">
          {p.signer ? (
            <span>
              已连接 <code>{p.signer.address}</code>
              {both && <RoleBadge addr={p.signer.address} ctx={ctx} />}
            </span>
          ) : (
            <span>未连接钱包（所有写操作不可用）</span>
          )}
          {p.walletSlot}
        </div>
        <nav>
          {ROUTES.map((r) => (
            <a
              key={r.path}
              href={r.path}
              aria-current={r.path === route.path ? "page" : undefined}
              onClick={(e) => {
                e.preventDefault();
                go(r.path);
              }}
            >
              {r.title}
            </a>
          ))}
        </nav>
        {err && <p className="err">读取链上状态失败：{err}</p>}
        {both && (both.bsc.paused || both.wantos.paused) && (
          <p className="warn">
            暂停中：{[both.bsc.paused && "BSC", both.wantos.paused && "WANTOS"].filter(Boolean).join("、")}
          </p>
        )}
      </header>
      <main>{route.page()}</main>
      <footer>
        桥合约（两条链相同）<code>{p.cfg.bsc.bridge}</code>；页面只信任链上读数。
      </footer>
    </Ctx.Provider>
  );
}

function RoleBadge({ addr, ctx }: { addr: string; ctx: AppCtx }) {
  const b = ctx.both!;
  const a = addr.toLowerCase();
  const roles = [
    (b.bsc.admin.toLowerCase() === a || b.wantos.admin.toLowerCase() === a) && "管理钱包",
    (b.bsc.wl.toLowerCase() === a || b.wantos.wl.toLowerCase() === a) && "白名单钱包",
  ].filter(Boolean);
  return <strong data-testid="role">（链上身份：{roles.length ? roles.join("、") : "无"}）</strong>;
}
