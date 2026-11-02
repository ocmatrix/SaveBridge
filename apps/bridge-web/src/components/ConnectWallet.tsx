import { useEffect, useState } from "react";
import { useConnect, useConnection, useConnectors, useDisconnect, type Connector } from "wagmi";
import QRCode from "qrcode";
import { useI18n } from "../context";
import { describeError, translateError } from "../lib/errors";

export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

function QrImage({ uri, alt }: { uri: string; alt: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    QRCode.toDataURL(uri, { margin: 1, width: 240 }).then((s) => live && setSrc(s), () => live && setSrc(null));
    return () => {
      live = false;
    };
  }, [uri]);
  return src ? <img className="qr" src={src} alt={alt} width={240} height={240} /> : null;
}

export function ConnectWallet() {
  const { t, lang } = useI18n();
  const { address, status } = useConnection();
  const connectors = useConnectors();
  const { mutateAsync: connect, isPending } = useConnect();
  const { mutate: disconnect } = useDisconnect();
  const [open, setOpen] = useState(false);
  const [uri, setUri] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (status === "connected" && address) {
    return (
      <div className="wallet">
        <span className="addr" title={address}>
          {short(address)}
        </span>
        <button type="button" className="secondary" onClick={() => disconnect()}>
          {t("wallet.disconnect")}
        </button>
      </div>
    );
  }

  // Prefer EIP-6963-announced wallets; show the generic injected connector only when none announced itself.
  const announced = connectors.filter((c) => c.type === "injected" && c.id !== "injected");
  const list = connectors.filter((c) => c.type !== "injected" || c.id !== "injected" || announced.length === 0);

  async function choose(c: Connector) {
    setError(null);
    const onMessage = (m: { type: string; data?: unknown }) => {
      if (m.type === "display_uri" && typeof m.data === "string") setUri(m.data);
    };
    c.emitter.on("message", onMessage);
    try {
      await connect({ connector: c });
      setOpen(false);
    } catch (e) {
      const name = (e as { name?: string }).name;
      setError(name === "ProviderNotFoundError" ? t("wallet.noWallet") : describeError(translateError(e, { decimals: 18 }), lang));
    } finally {
      c.emitter.off("message", onMessage);
      setUri(null);
    }
  }

  return (
    <div className="wallet">
      <button type="button" onClick={() => setOpen((o) => !o)} disabled={isPending}>
        {isPending ? t("wallet.connecting") : t("wallet.connect")}
      </button>
      {open && (
        <div className="wallet-list" role="dialog" aria-label={t("wallet.choose")}>
          {list.length === 0 && <p>{t("wallet.noWallet")}</p>}
          {list.map((c) => (
            <button type="button" key={c.uid} onClick={() => void choose(c)} disabled={isPending}>
              {c.type === "walletConnect" ? t("wallet.walletconnect") : c.name}
            </button>
          ))}
          {uri && (
            <div className="qr-box">
              <p>{t("wallet.scanQr")}</p>
              <QrImage uri={uri} alt={t("wallet.scanQr")} />
            </div>
          )}
          {error && <p className="error">{error}</p>}
        </div>
      )}
    </div>
  );
}
