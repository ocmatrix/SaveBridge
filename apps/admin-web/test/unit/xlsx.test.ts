import { describe, expect, it } from "vitest";
import writeXlsxFile from "write-excel-file/node";
import { parseAddressList } from "../../src/lib/normalize";
import { fileToText, looksLikeZip, xlsxToText, XlsxError, UPLOAD_MAX_ROWS as XLSX_MAX_ROWS, XLSX_MAX_BYTES } from "../../src/lib/xlsx";

const A = "0x222A4223a4046671e68346ABEde37E583050258c";
const B = "0x63Fcb75b54e0fdDCFC3b422A543A191B55225554";
const toArrayBuffer = (b: Buffer) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
const sheet = async (rows: unknown[][]) => toArrayBuffer(await (writeXlsxFile(rows.map((r) => r.map((v) => ({ value: v }))) as never)).toBuffer());

describe("xlsxToText (first sheet, first column only)", () => {
  it("returns one line per row of column A and feeds the same rules v1 as pasted text", async () => {
    const text = await xlsxToText(await sheet([["地址"], [A], [B], [A]]));
    expect(text.split("\n").filter(Boolean)).toEqual(["地址", A, B, A]);
    const p = parseAddressList(text);
    expect(p.errors).toEqual([]);
    expect(p.headerSkipped).toBe(true);
    expect(p.addresses).toEqual([A.toLowerCase(), B.toLowerCase()]);
    expect(p.duplicates.length).toBe(1);
  });

  it("ignores every column but the first", async () => {
    const text = await xlsxToText(await sheet([[A, "备注 1", "0x1111111111111111111111111111111111111111"], [B, "备注 2"]]));
    expect(text.split("\n").filter(Boolean)).toEqual([A, B]);
  });

  it("keeps a bad cell as a bad line so the page can reject the whole file (no partial import)", async () => {
    const text = await xlsxToText(await sheet([[A], ["0x12ab"], [B]]));
    const p = parseAddressList(text);
    expect(p.errors.length).toBe(1);
  });

  it("refuses a file that is not an xlsx", async () => {
    await expect(xlsxToText(new TextEncoder().encode("not a zip").buffer as ArrayBuffer)).rejects.toBeInstanceOf(XlsxError);
  });

  it(`refuses files over ${XLSX_MAX_BYTES} bytes before parsing`, async () => {
    await expect(xlsxToText(new ArrayBuffer(XLSX_MAX_BYTES + 1))).rejects.toThrow(/500KB/);
  });

  it("the size cap stays under 512KB, so fflate never starts a Worker (the page CSP would block it)", () => {
    expect(XLSX_MAX_BYTES).toBeLessThan(512 * 1024);
  });

  it("refuses a cell with a line break (it would turn into several addresses)", async () => {
    await expect(xlsxToText(await sheet([[A], [`${B}\n${A}`]]))).rejects.toThrow(/第 2 行.*换行/);
  });

  it("refuses a row whose first column is empty while other columns hold data (no silent row loss)", async () => {
    await expect(xlsxToText(await sheet([[A], ["", "0x1111111111111111111111111111111111111111"], [B]]))).rejects.toThrow(/第 2 行第一列是空的/);
  });

  it("empty rows are fine (ignored like blank lines)", async () => {
    const text = await xlsxToText(await sheet([[A], [""], [B]]));
    expect(parseAddressList(text).addresses.length).toBe(2);
  });

  it("recognises an xlsx by its zip signature even without a .xlsx name", async () => {
    const buf = await sheet([[A], [B]]);
    expect(looksLikeZip(buf)).toBe(true);
    expect(looksLikeZip(new TextEncoder().encode("0x1").buffer as ArrayBuffer)).toBe(false);
    const f = new File([new Uint8Array(buf)], "download");
    expect(parseAddressList(await fileToText(f)).addresses.length).toBe(2);
  });

  it("uploaded text files get the same row cap", async () => {
    const big = Array.from({ length: XLSX_MAX_ROWS + 1 }, () => A).join("\n");
    await expect(fileToText(new File([big], "big.csv"))).rejects.toThrow(/5000/);
  });

  it(`refuses more than ${XLSX_MAX_ROWS} rows`, async () => {
    const rows = Array.from({ length: XLSX_MAX_ROWS + 1 }, (_, i) => [`0x${(i + 1).toString(16).padStart(40, "0")}`]);
    await expect(xlsxToText(await sheet(rows))).rejects.toThrow(/5000/);
  });
});
