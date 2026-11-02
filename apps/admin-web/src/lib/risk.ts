import type { AddressInfo } from "./api";

/** DESIGN §8.2 hints: 🔴 controlled source; 🟠 suspicious list / source hit; 🟡 not in the network; ⚪ contract address. */
export type Flag = "red" | "orange" | "yellow" | "white";
export const FLAG_ICON: Record<Flag, string> = { red: "🔴", orange: "🟠", yellow: "🟡", white: "⚪" };
export const FLAG_TEXT: Record<Flag, string> = { red: "受控来源", orange: "可疑名单或来源命中", yellow: "不在网体内", white: "合约地址" };

/**
 * DESIGN 附录 A — built-in copy of the controlled set (lower-case), used as a hint even when the relayer API is not
 * reachable; the live set from the relayer is merged in. A hint only: never blocks anything on its own.
 */
export const APPENDIX_A = [
  "0x9272f360b98160c1662abb6d2df9e4f313b39502",
  "0x9dab17a9ad061cbda2bef607a6a330ee74076e90",
  "0x7afc830d90f3080dc754618a9e4f71775815c3ad",
  "0x8dfd39e98f478688a41cdbe40bc544d672f0a9e3",
  "0xac979ae2ff58267bb2534779da4693271ce32964",
  "0xe6c5a61de6c1bddf45d19332db81cdcfe579d6c7",
  "0xc08187977f550f63b810da45b4ab8472f61df003",
  "0x293e61e0c855f9a5a16e7a191684ceb5ab44b916",
  "0xf974868f63a711d3f36b35a02e3a8fcbd2087c4b",
  "0xcca46deb8f1b7cc61e96bd25fc4db3953ccb3ec1",
  "0xeabd18c995c0c5feda5db3ca0d010e49f41a0bb4",
  "0xb7a4e1fb7f6acb6416fe701c6ebb7c863cb13523",
  "0xfd7627bbc0e5d8edf1123042649ab1a51ac68e94",
  "0xe49d28397fa4dccbcd087276e6c3c98b81645e17",
  "0x765bcb1dfc9cb9ec4c47e052daf4b31ec76292af",
  "0x14477d9608ecdf66790a6ccd6bf605d3c6e0b437",
  "0xe2dd3b4c4f46d81cc129f1e4830341166216f8fc",
  "0xeead2ec17823bc8cb803a1e60d9ce031435c2b67",
  "0x6317f6d23ad85058ca3cf5872827e70d05a42938",
  "0x778b7d2cf7fde555798449c813616191f6b3f3d6",
  "0x7fd935d53afbe71ffeb6bd5b1a0ff25d29d01b24",
  "0xb7f476ce42782f23f6e04143855cb61337b2791f",
];

export function flagsFor(addr: string, o: { controlled: ReadonlySet<string>; info?: AddressInfo; isContract: boolean }): Flag[] {
  const a = addr.toLowerCase();
  const f: Flag[] = [];
  if (o.controlled.has(a)) f.push("red");
  if (o.info?.suspicious) f.push("orange");
  if (o.info?.inNetwork === false) f.push("yellow");
  if (o.isContract) f.push("white");
  return f;
}

/** 🔴 rows start unchecked and need a second confirmation; everything else starts checked. */
export const defaultChecked = (flags: readonly Flag[]) => !flags.includes("red");
export const needsConfirm = defaultChecked;
