import { unzip, type UnzipFileInfo, type Unzipped } from "fflate";

export const OFFICE_LIMITS = { entries: 2000, totalBytes: 100 * 1024 * 1024, partBytes: 30 * 1024 * 1024, rows: 1000, columns: 100 };

export class OfficeFileError extends Error {
  name = "OfficeFileError";
}

export type SheetData = { name: string; rows: string[][]; columns: number; truncatedRows: boolean; truncatedColumns: boolean };
export type Workbook = { sheets: SheetData[] };
export type DocRun = { text: string; bold?: true; italic?: true; rtl?: true } | { image: number; alt: string; width?: number };
export type DocParagraph = { type: "paragraph"; heading: number; list?: { level: number; ordered: boolean }; rtl: boolean; runs: DocRun[] };
export type DocCell = { colSpan: number; rowSpan: number; blocks: DocBlock[] };
export type DocBlock = DocParagraph | { type: "table"; rows: DocCell[][] };
export type DocumentData = { blocks: DocBlock[]; images: { type: string; bytes: Uint8Array }[] };

type Zip = { read: (name: string) => Promise<Uint8Array | null> };

const MB = 1024 * 1024;
const notOffice = (label: string) => new OfficeFileError(`This isn't a readable ${label} file. It may be password-protected, damaged or in an older format.`);

function unzipAsync(data: Uint8Array, filter: (file: UnzipFileInfo) => boolean) {
  return new Promise<Unzipped>((resolve, reject) => {
    try { unzip(data, { filter }, (error, files) => error ? reject(error) : resolve(files)); } catch (error) { reject(error); }
  });
}

/** Sizes come from the central directory; fflate inflates into a buffer of the declared size, so they also bound memory. */
async function openZip(data: Uint8Array, label: string): Promise<Zip> {
  if (data.byteLength > OFFICE_LIMITS.totalBytes) throw new OfficeFileError(`This file is larger than ${OFFICE_LIMITS.totalBytes / MB} MB, so it isn't previewed.`);
  const names = new Map<string, string>();
  let total = 0;
  try {
    await unzipAsync(data, (file) => {
      if (names.size >= OFFICE_LIMITS.entries) throw new OfficeFileError(`This file has more than ${OFFICE_LIMITS.entries.toLocaleString("en-US")} parts, so it isn't previewed.`);
      if (file.name.includes("\\")) throw new OfficeFileError("This file has a part name with a backslash, so it isn't previewed.");
      const key = file.name.toLowerCase();
      if (names.has(key)) throw new OfficeFileError("This file has two parts with the same name, so it isn't previewed.");
      const size = Math.max(file.size, file.originalSize);
      if (size > OFFICE_LIMITS.partBytes) throw new OfficeFileError(`A part of this file is larger than ${OFFICE_LIMITS.partBytes / MB} MB, so it isn't previewed.`);
      total += size;
      if (total > OFFICE_LIMITS.totalBytes) throw new OfficeFileError(`This file unpacks to more than ${OFFICE_LIMITS.totalBytes / MB} MB, so it isn't previewed.`);
      names.set(key, file.name);
      return false;
    });
  } catch (error) {
    throw error instanceof OfficeFileError ? error : notOffice(label);
  }
  if (!names.has("[content_types].xml")) throw notOffice(label);
  return {
    read: async (name) => {
      const actual = names.get(name.toLowerCase());
      if (!actual) return null;
      try { return (await unzipAsync(data, (file) => file.name === actual))[actual] ?? null; } catch { throw notOffice(label); }
    },
  };
}

function parseXml(bytes: Uint8Array, label: string): Document {
  const text = new TextDecoder(bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le" : bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be" : "utf-8").decode(bytes);
  // Office parts never declare a DTD; refusing one rules out entity expansion.
  if (text.includes("<!DOCTYPE")) throw notOffice(label);
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.getElementsByTagNameNS("*", "parsererror").length) throw notOffice(label);
  return doc;
}

const kids = (element: Element | null | undefined, name?: string) => element ? [...element.children].filter((child) => !name || child.localName === name) : [];
const kid = (element: Element | null | undefined, name: string): Element | undefined => kids(element, name)[0];
const all = (root: Document | Element, name: string) => [...root.getElementsByTagNameNS("*", name)];
function attr(element: Element | null | undefined, name: string): string | null {
  for (const attribute of element?.attributes ?? []) if (attribute.localName === name) return attribute.value;
  return null;
}
const isOn = (element: Element | undefined) => !!element && !/^(0|false|off|none)$/i.test(attr(element, "val") ?? "");

function resolvePart(from: string, target: string) {
  let decoded = target;
  try { decoded = decodeURIComponent(target); } catch { /* A malformed escape is taken literally. */ }
  const parts = decoded.startsWith("/") ? [] : from.split("/").slice(0, -1);
  for (const part of decoded.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop(); else parts.push(part);
  }
  return parts.join("/");
}

async function relationships(zip: Zip, part: string, label: string) {
  const slash = part.lastIndexOf("/");
  const bytes = await zip.read(`${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels`);
  const map = new Map<string, { type: string; target: string }>();
  if (!bytes) return map;
  for (const rel of all(parseXml(bytes, label), "Relationship")) {
    const id = attr(rel, "Id"), target = attr(rel, "Target");
    if (id && target && attr(rel, "TargetMode") !== "External") map.set(id, { type: attr(rel, "Type") ?? "", target: resolvePart(part, target) });
  }
  return map;
}

async function openPackage(input: ArrayBuffer | Uint8Array, label: string, fallback: string, root: string) {
  const zip = await openZip(input instanceof Uint8Array ? input : new Uint8Array(input), label);
  const main = [...(await relationships(zip, "", label)).values()].find((rel) => rel.type.endsWith("/officeDocument"))?.target ?? fallback;
  const bytes = await zip.read(main);
  if (!bytes) throw notOffice(label);
  const doc = parseXml(bytes, label);
  if (doc.documentElement.localName !== root) throw notOffice(label);
  const rels = await relationships(zip, main, label);
  const related = async (type: string) => {
    const rel = [...rels.values()].find((value) => value.type.endsWith(type));
    const part = rel ? await zip.read(rel.target) : null;
    return part ? parseXml(part, label) : null;
  };
  return { zip, doc, rels, related };
}

type DateFormat = { date: boolean; time: boolean; seconds: boolean; elapsed: boolean };
const BUILTIN_DATE_FORMATS: Record<number, string> = { 14: "mm-dd-yy", 15: "d-mmm-yy", 16: "d-mmm", 17: "mmm-yy", 18: "h:mm AM/PM", 19: "h:mm:ss AM/PM", 20: "h:mm", 21: "h:mm:ss", 22: "m/d/yy h:mm", 45: "mm:ss", 46: "[h]:mm:ss", 47: "mmss.0" };

export function dateFormat(code: string): DateFormat | null {
  const clean = code.split(";")[0].replace(/"[^"]*"/g, "").replace(/\\.|[_*]./g, "");
  const elapsed = /\[(h+|m+|s+)\]/i.test(clean);
  const bare = clean.replace(/\[(h+|m+|s+)\]/gi, "$1").replace(/\[[^\]]*\]/g, "").replace(/AM\/PM|A\/P|General/gi, "");
  const time = /[hs]/i.test(bare);
  const date = /[yd]/i.test(bare) || (/m/i.test(bare) && !time);
  return date || time ? { date, time, seconds: /s/i.test(bare), elapsed } : null;
}

const pad = (value: number) => String(value).padStart(2, "0");

/** Excel serial dates. The 1900 system counts the nonexistent 1900-02-29 as day 60. */
export function formatSerialDate(serial: number, format: DateFormat, date1904: boolean): string | null {
  if (!Number.isFinite(serial) || serial < 0 || serial >= 2958466) return null;
  const seconds = Math.round(serial * 86400);
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : serial < 60 ? Date.UTC(1899, 11, 31) : Date.UTC(1899, 11, 30);
  const value = new Date(epoch + seconds * 1000);
  const parts: string[] = [];
  if (format.date) parts.push(!date1904 && Math.floor(serial) === 60 ? "1900-02-29" : `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`);
  if (format.time) {
    const hours = format.elapsed ? Math.floor(seconds / 3600) : value.getUTCHours();
    parts.push(`${pad(hours)}:${pad(value.getUTCMinutes())}${format.seconds ? `:${pad(value.getUTCSeconds())}` : ""}`);
  }
  return parts.join(" ");
}

const unescapeExcel = (text: string) => text.replace(/_x([\da-f]{4})_/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
// Phonetic runs (rPh) also hold <t>; only direct text and rich-text runs are the cell's value.
const richText = (element: Element | undefined) => unescapeExcel(kids(element).map((child) => child.localName === "t" ? child.textContent ?? "" : child.localName === "r" ? kids(child, "t").map((t) => t.textContent ?? "").join("") : "").join(""));
const generalNumber = (value: number) => String(Number(value.toPrecision(15)));

const columnNumber = (letters: string) => [...letters.toUpperCase()].reduce((total, letter) => total * 26 + letter.charCodeAt(0) - 64, 0);

export async function parseXlsx(input: ArrayBuffer | Uint8Array): Promise<Workbook> {
  const label = ".xlsx";
  const { zip, doc, rels, related } = await openPackage(input, label, "xl/workbook.xml", "workbook");
  const date1904 = /^(1|true)$/i.test(attr(all(doc, "workbookPr")[0], "date1904") ?? "");
  const sharedDoc = await related("/sharedStrings");
  const shared = sharedDoc ? kids(sharedDoc.documentElement, "si").map((si) => richText(si)) : [];
  const stylesDoc = await related("/styles");
  const custom = new Map(stylesDoc ? all(stylesDoc, "numFmt").map((format) => [Number(attr(format, "numFmtId")), attr(format, "formatCode") ?? ""] as const) : []);
  const styleDates = stylesDoc ? kids(all(stylesDoc, "cellXfs")[0], "xf").map((xf) => {
    const id = Number(attr(xf, "numFmtId") ?? 0);
    const code = custom.get(id) ?? BUILTIN_DATE_FORMATS[id];
    return code ? dateFormat(code) : null;
  }) : [];
  const cellText = (cell: Element) => {
    const value = kid(cell, "v")?.textContent ?? "";
    switch (attr(cell, "t") ?? "n") {
      case "s": return /^\d+$/.test(value) ? shared[Number(value)] ?? "" : "";
      case "inlineStr": return richText(kid(cell, "is"));
      case "b": return value === "" ? "" : /^(1|true)$/i.test(value) ? "TRUE" : "FALSE";
      case "str": return unescapeExcel(value);
      case "e": case "d": return value;
      default: {
        const number = value.trim() === "" ? NaN : Number(value);
        if (!Number.isFinite(number)) return value;
        const format = styleDates[Number(attr(cell, "s") ?? 0)];
        return (format && formatSerialDate(number, format, date1904)) ?? generalNumber(number);
      }
    }
  };
  const sheets: SheetData[] = [];
  for (const sheet of kids(all(doc, "sheets")[0], "sheet")) {
    const rel = rels.get(attr(sheet, "id") ?? "");
    if (!rel?.type.endsWith("/worksheet")) continue;
    const bytes = await zip.read(rel.target);
    if (!bytes) throw notOffice(label);
    const rows: string[][] = [];
    let columns = 0, rowNumber = 0, truncatedRows = false, truncatedColumns = false;
    rowLoop: for (const row of kids(all(parseXml(bytes, label), "sheetData")[0], "row")) {
      rowNumber = Number(attr(row, "r")) || rowNumber + 1;
      let column = 0;
      for (const cell of kids(row, "c")) {
        const ref = /^\$?([A-Z]{1,3})\$?\d+$/i.exec(attr(cell, "r") ?? "");
        column = ref ? columnNumber(ref[1]) : column + 1;
        const text = cellText(cell);
        if (text === "") continue;
        if (rowNumber > OFFICE_LIMITS.rows) { truncatedRows = true; break rowLoop; }
        if (column > OFFICE_LIMITS.columns) { truncatedColumns = true; continue; }
        (rows[rowNumber - 1] ??= [])[column - 1] = text;
        columns = Math.max(columns, column);
      }
    }
    sheets.push({ name: attr(sheet, "name") ?? `Sheet ${sheets.length + 1}`, rows: Array.from(rows, (row) => row ?? []), columns, truncatedRows, truncatedColumns });
  }
  return { sheets };
}

// No SVG: a blob URL is same-origin, so an SVG opened in its own tab would run its scripts as the app.
const IMAGE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", bmp: "image/bmp", webp: "image/webp", tif: "image/tiff", tiff: "image/tiff" };

export async function parseDocx(input: ArrayBuffer | Uint8Array): Promise<DocumentData> {
  const label = ".docx";
  const { zip, doc, rels, related } = await openPackage(input, label, "word/document.xml", "document");
  const headings = new Map<string, number>(), styleLists = new Map<string, Element>();
  const stylesDoc = await related("/styles");
  for (const style of stylesDoc ? all(stylesDoc, "style") : []) {
    const id = attr(style, "styleId"), name = attr(kid(style, "name"), "val") ?? "";
    const outline = Number(attr(kid(kid(style, "pPr"), "outlineLvl"), "val") ?? NaN);
    const level = /^title$/i.test(name) ? 1 : Number(/^heading ([1-6])$/i.exec(name)?.[1] ?? (outline >= 0 && outline <= 5 ? outline + 1 : 0));
    if (id && level) headings.set(id, level);
    const numPr = kid(kid(style, "pPr"), "numPr");
    if (id && numPr) styleLists.set(id, numPr);
  }
  const headingOf = (styleId: string) => headings.get(styleId) ?? (/^title$/i.test(styleId) ? 1 : Number(/^heading([1-6])$/i.exec(styleId)?.[1] ?? 0));
  const numberingDoc = await related("/numbering");
  const abstracts = new Map(numberingDoc ? all(numberingDoc, "abstractNum").map((abstract) => [attr(abstract, "abstractNumId"), abstract] as const) : []);
  const numbering = new Map(numberingDoc ? all(numberingDoc, "num").map((num) => [attr(num, "numId"), abstracts.get(attr(kid(num, "abstractNumId"), "val"))] as const) : []);
  const ordered = (numId: string, level: number) => {
    const format = attr(kid(kids(numbering.get(numId), "lvl").find((lvl) => attr(lvl, "ilvl") === String(level)), "numFmt"), "val");
    return !!format && format !== "bullet" && format !== "none";
  };
  const images: DocumentData["images"] = [];
  const imageIndex = new Map<string, number>();
  for (const [id, rel] of rels) {
    const type = IMAGE_TYPES[rel.target.split(".").at(-1)?.toLowerCase() ?? ""];
    const bytes = rel.type.endsWith("/image") && type ? await zip.read(rel.target) : null;
    if (bytes && type) imageIndex.set(id, images.push({ type, bytes }) - 1);
  }

  const run = (element: Element): DocRun[] => {
    const props = kid(element, "rPr");
    const style = { ...(isOn(kid(props, "b")) && { bold: true as const }), ...(isOn(kid(props, "i")) && { italic: true as const }), ...(isOn(kid(props, "rtl")) && { rtl: true as const }) };
    const out: DocRun[] = [];
    let text = "";
    const flush = () => { if (text) out.push({ text, ...style }); text = ""; };
    const image = (id: string | null, frame: Element) => {
      const index = imageIndex.get(id ?? "");
      if (index === undefined) return;
      flush();
      const docPr = all(frame, "docPr")[0], width = Number(attr(all(frame, "extent")[0], "cx"));
      out.push({ image: index, alt: attr(docPr, "descr") || attr(docPr, "title") || "", ...(width > 0 && { width: Math.round(width / 9525) }) });
    };
    const visit = (children: Element[]) => {
      for (const child of children) {
        switch (child.localName) {
          case "t": text += child.textContent ?? ""; break;
          case "tab": case "ptab": text += "\t"; break;
          case "br": case "cr": text += "\n"; break;
          case "noBreakHyphen": text += "‑"; break;
          case "softHyphen": text += "­"; break;
          case "drawing": for (const blip of all(child, "blip")) image(attr(blip, "embed"), child); break;
          case "pict": for (const data of all(child, "imagedata")) image(attr(data, "id"), child); break;
          case "AlternateContent": visit(kids(kid(child, "Choice"))); break;
        }
      }
    };
    visit(kids(element));
    flush();
    return out;
  };
  // Deleted and moved-away text is hidden: the preview shows the document as if changes were accepted.
  const inline = (element: Element): DocRun[] => kids(element).flatMap((child) => {
    switch (child.localName) {
      case "r": return run(child);
      case "pPr": case "rPr": case "sdtPr": case "del": case "moveFrom": return [];
      default: return inline(child);
    }
  });
  const paragraph = (element: Element): DocParagraph => {
    const props = kid(element, "pPr");
    const styleId = attr(kid(props, "pStyle"), "val") ?? "", heading = headingOf(styleId);
    // List styles such as "List Bullet" carry their numbering on the style, not the paragraph.
    const numPr = kid(props, "numPr") ?? styleLists.get(styleId), numId = attr(kid(numPr, "numId"), "val");
    const level = Math.min(Math.max(Number(attr(kid(numPr, "ilvl"), "val")) || 0, 0), 8);
    return { type: "paragraph", heading, ...(!heading && numId && numId !== "0" && { list: { level, ordered: ordered(numId, level) } }), rtl: isOn(kid(props, "bidi")), runs: inline(element) };
  };
  const table = (element: Element): DocBlock => {
    const open = new Map<number, DocCell>();
    return { type: "table", rows: kids(element, "tr").map((tr) => {
      const row: DocCell[] = [];
      let column = 0;
      for (const tc of kids(tr, "tc")) {
        const props = kid(tc, "tcPr"), span = Math.max(1, Number(attr(kid(props, "gridSpan"), "val")) || 1);
        const vMerge = kid(props, "vMerge"), merge = vMerge ? attr(vMerge, "val") ?? "continue" : null;
        const above = open.get(column);
        if (merge === "continue" && above) { above.rowSpan++; column += span; continue; }
        const cell: DocCell = { colSpan: span, rowSpan: 1, blocks: blocks(tc) };
        if (merge === "restart") open.set(column, cell); else open.delete(column);
        row.push(cell);
        column += span;
      }
      return row;
    }) };
  };
  const blocks = (element: Element | undefined): DocBlock[] => kids(element).flatMap((child) => {
    switch (child.localName) {
      case "p": return [paragraph(child)];
      case "tbl": return [table(child)];
      case "sdt": return blocks(kid(child, "sdtContent"));
      case "customXml": return blocks(child);
      default: return [];
    }
  });
  return { blocks: blocks(kid(doc.documentElement, "body")), images };
}
