import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { useI18n } from "../context";
import type { WalletState } from "../wallet/useAutoConnect";

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

/** The wallet list: EVM wallets found in the browser, and WalletConnect (QR for a phone wallet) when configured. */
export function WalletPicker({ wallet }: { wallet: WalletState }) {
  const { t } = useI18n();
  if (!wallet.open) return null;
  return (
    <div className="picker" role="dialog" aria-label={t("wallet.choose")}>
      <div className="picker-head">
        <strong>{t("wallet.choose")}</strong>
        <button type="button" className="link" onClick={() => wallet.setOpen(false)}>
          {t("wallet.cancel")}
        </button>
      </div>
      {wallet.list.map((c) => (
        <button type="button" className="wallet-item" key={c.uid} disabled={wallet.connecting} onClick={() => void wallet.choose(c)}>
          {c.type === "walletConnect" ? t("wallet.walletconnect") : c.id === "injected" ? t("wallet.browser") : c.name}
        </button>
      ))}
      {wallet.uri && (
        <div className="qr-box">
          <p className="muted">{t("wallet.scanQr")}</p>
          <QrImage uri={wallet.uri} alt={t("wallet.scanQr")} />
        </div>
      )}
      {wallet.error && <p className="error">{wallet.error}</p>}
    </div>
  );
}
