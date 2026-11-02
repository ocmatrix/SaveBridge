/**
 * Build-time replacement for `@reown/appkit/core` (WalletConnect's hosted QR modal). We render our own QR
 * (`showQrModal: false`), so the modal — and its remote assets/APIs, which a strict CSP would block anyway —
 * is kept out of the bundle entirely.
 */
export function createAppKit(): never {
  throw new Error("WalletConnect modal is disabled in this build");
}
