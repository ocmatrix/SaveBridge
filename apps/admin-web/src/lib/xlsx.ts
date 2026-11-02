import { readSheet } from "read-excel-file/browser";

/**
 * Hard limits for an upload (the file is only read in this browser, never uploaded).
 * 500KB, not more: fflate (inside read-excel-file) inflates archives under 512KB synchronously, but starts a Web Worker
 * from a Blob URL for bigger well-compressed ones, and the page CSP (default-src 'none', no worker-src) blocks that.
 * Staying under 512KB keeps the Worker path unreachable instead of loosening the CSP.
 */
export const XLSX_MAX_BYTES = 500 * 1024;
export const TEXT_MAX_BYTES = 2 * 1024 * 1024;
export const UPLOAD_MAX_ROWS = 5000;

export class XlsxError extends Error {}

export const readFileAsArrayBuffer = (f: Blob): Promise<ArrayBuffer> =>
  typeof f.arrayBuffer === "function"
    ? f.arrayBuffer()
    : new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result as ArrayBuffer);
        r.onerror = () => reject(r.error ?? new Error("read failed"));
        r.readAsArrayBuffer(f);
      });

/** `PK\x03\x04`: an .xlsx is a zip, whatever the picker called it (phones often hand over files without an extension). */
export const looksLikeZip = (b: ArrayBuffer): boolean => {
  const u = new Uint8Array(b, 0, Math.min(4, b.byteLength));
  return u.length === 4 && u[0] === 0x50 && u[1] === 0x4b && u[2] === 0x03 && u[3] === 0x04;
};

/**
 * First sheet, first column only, one cell per line. The text then goes through exactly the same rules v1 as pasted or
 * CSV text (header skip, EIP-55 check, dedupe, sort, any bad line blocks the whole file), so a spreadsheet can never
 * be more lenient than a text file. Anything that would silently change the row count is refused instead:
 * a cell holding a line break (would become several addresses) and a row whose first column is empty while other
 * columns hold data (an empty / uncalculated formula cell would otherwise just vanish).
 */
export async function xlsxToText(file: ArrayBuffer): Promise<string> {
  if (file.byteLength > XLSX_MAX_BYTES) throw new XlsxError("文件超过 500KB，请拆分后再上传");
  let rows: unknown[][];
  try {
    rows = (await readSheet(file)) as unknown[][];
  } catch {
    throw new XlsxError("无法读取这个文件，请确认是 .xlsx 表格");
  }
  if (rows.length > UPLOAD_MAX_ROWS) throw new XlsxError(`表格超过 ${UPLOAD_MAX_ROWS} 行，请拆分后再上传`);
  return rows
    .map((r, i) => {
      const first = r[0] === null || r[0] === undefined ? "" : String(r[0]).trim();
      if (/[\r\n]/.test(first)) throw new XlsxError(`第 ${i + 1} 行的单元格里有换行，请改成一个单元格一个地址`);
      if (first === "" && r.slice(1).some((c) => c !== null && c !== undefined && String(c).trim() !== "")) throw new XlsxError(`第 ${i + 1} 行第一列是空的，但这一行其他列有内容`);
      return first;
    })
    .join("\n");
}

/** Any supported upload (.xlsx, .csv, .txt) as the text the address rules read. Throws XlsxError with a readable reason. */
export async function fileToText(f: File): Promise<string> {
  if (f.size > TEXT_MAX_BYTES) throw new XlsxError("文件太大，请拆分后再上传");
  const buf = await readFileAsArrayBuffer(f).catch(() => {
    throw new XlsxError("无法读取这个文件");
  });
  if (looksLikeZip(buf) || /\.xlsx$/i.test(f.name)) return xlsxToText(buf);
  const text = new TextDecoder().decode(buf);
  if (text.split(/\r\n|\n|\r/).length > UPLOAD_MAX_ROWS) throw new XlsxError(`文件超过 ${UPLOAD_MAX_ROWS} 行，请拆分后再上传`);
  return text;
}
