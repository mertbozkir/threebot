import assert from "node:assert/strict";
import { test } from "node:test";
import { FILE_CARD_COLORS, aboutFilePrompt, cachedFileSize, fileCardAccent, fileSizeCache, fileSizeFromHead, fileTypeLabel, formatSize, soloFileLinkParagraph } from "../src/lib/fileCards.ts";

test("file card accents map file types to their band colors", () => {
  assert.deepEqual(FILE_CARD_COLORS, { pdf: "#fc2d3e", sheet: "#14c370", doc: "#1784fc", slides: "#fa6710", other: "#98989d" });
  for (const [name, accent] of [
    ["doc.pdf", "pdf"], ["DOC.PDF", "pdf"],
    ["sheet.xlsx", "sheet"], ["old.xls", "sheet"], ["table.csv", "sheet"], ["sheet.ods", "sheet"],
    ["memo.docx", "doc"], ["memo.doc", "doc"], ["memo.odt", "doc"],
    ["deck.pptx", "slides"], ["deck.ppt", "slides"], ["deck.odp", "slides"],
    ["notes.txt", "other"], ["archive.bin", "other"], ["noextension", "other"],
  ]) assert.equal(fileCardAccent(name), accent, name);
  assert.equal(fileTypeLabel("doc.pdf"), "PDF document");
  assert.equal(fileTypeLabel("sheet.xlsx"), "Spreadsheet");
  assert.equal(fileTypeLabel("memo.docx"), "Word document");
  assert.equal(fileTypeLabel("deck.pptx"), "Presentation");
  assert.equal(fileTypeLabel("notes.txt"), "File");
});

test("sizes format compactly as B, kB and MB", () => {
  for (const [bytes, label] of [[null, null], [0, "0B"], [21, "21B"], [512, "512B"], [1023, "1023B"], [1024, "1kB"], [1946, "1.9kB"], [36864, "36kB"], [1_048_576, "1MB"], [1_258_291, "1.2MB"], [1_572_864, "1.5MB"], [1_610_612_736, "1.5GB"]] as const) {
    assert.equal(formatSize(bytes), label, String(bytes));
  }
});

test("content-length probes cache per key and survive failures", async () => {
  fileSizeCache.clear();
  let probes = 0;
  const probe = () => {
    probes++;
    return probes === 1 ? Promise.resolve(1946) : Promise.reject(new Error("offline"));
  };
  assert.equal(await cachedFileSize("library/report.pdf", probe), 1946);
  assert.equal(await cachedFileSize("library/report.pdf", probe), 1946, "the second read reuses the cached probe");
  assert.equal(probes, 1);
  assert.equal(await cachedFileSize("library/broken.pdf", () => Promise.reject(new Error("offline"))), null, "a failed probe resolves to null");
  assert.equal(await cachedFileSize("library/broken.pdf", () => Promise.resolve(1)), null, "the failure stays cached");
  assert.equal(await cachedFileSize("library/other.pdf", () => Promise.resolve(36864)), 36864, "distinct keys probe separately");
  fileSizeCache.clear();
});

test("fileSizeFromHead reads Content-Length and rejects nothing", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (() => Promise.resolve(new Response(null, { status: 200, headers: { "Content-Length": "1946" } }))) as typeof fetch;
  try {
    assert.equal(await fileSizeFromHead("https://assets.example/library/report.pdf"), 1946);
    globalThis.fetch = (() => Promise.resolve(new Response(null, { status: 404 }))) as typeof fetch;
    assert.equal(await fileSizeFromHead("https://assets.example/library/report.pdf"), null, "a missing file has no size");
    globalThis.fetch = (() => Promise.reject(new Error("offline"))) as typeof fetch;
    assert.equal(await fileSizeFromHead("https://assets.example/library/report.pdf"), null, "a failed request resolves to null");
    // The asset proxy answers HEAD without a length; a one-byte range request carries the total.
    globalThis.fetch = ((_url: string, init?: RequestInit) => Promise.resolve(init?.method === "HEAD"
      ? new Response(null, { status: 200 })
      : new Response("x", { status: 206, headers: { "Content-Range": "bytes 0-0/36864" } }))) as typeof fetch;
    assert.equal(await fileSizeFromHead("https://assets.example/library/report.docx"), 36864);
    globalThis.fetch = ((_url: string, init?: RequestInit) => Promise.resolve(init?.method === "HEAD" ? new Response(null, { status: 200 }) : new Response("whole file", { status: 200 }))) as typeof fetch;
    assert.equal(await fileSizeFromHead("https://assets.example/library/report.docx"), null, "no range support means no size, never a guess");
  } finally {
    globalThis.fetch = original;
  }
});

test("the About prompt prefixes the file name and workspace path", () => {
  assert.equal(aboutFilePrompt("report.pdf", "library/report.pdf", "summarize this"), "About “report.pdf” (library/report.pdf): summarize this");
  assert.equal(aboutFilePrompt("report.pdf", null, "summarize this"), "About “report.pdf”: summarize this");
});

test("a paragraph renders as a file card only when a workspace link is its entire content", () => {
  const text = (value: string) => ({ type: "text", value });
  const link = (href: string, value: string) => ({ type: "element", tagName: "a", properties: { href }, children: [text(value)] });
  const paragraph = (children: unknown[]) => ({ type: "element", tagName: "p", properties: {}, children });
  const resolve = (href: string) => (href.startsWith("library/") ? href : null);
  assert.deepEqual(soloFileLinkParagraph(paragraph([link("library/report.pdf", "Report")]), resolve), { href: "library/report.pdf", path: "library/report.pdf", text: "Report" });
  assert.equal(soloFileLinkParagraph(paragraph([link("library/report.pdf", "")]), resolve)?.path, "library/report.pdf", "the caller falls back to the path basename");
  assert.equal(soloFileLinkParagraph(paragraph([link("library/report.pdf", "Report"), text(" and more")]), resolve), null, "sibling text keeps the paragraph inline");
  assert.equal(soloFileLinkParagraph(paragraph([text("See "), link("library/report.pdf", "Report")]), resolve), null);
  assert.equal(soloFileLinkParagraph(paragraph([link("https://external.example/report.pdf", "Report")]), resolve), null, "external links never become file cards");
  assert.equal(soloFileLinkParagraph(paragraph([{ type: "element", tagName: "img", properties: {}, children: [] }]), resolve), null);
  assert.equal(soloFileLinkParagraph({ type: "element", tagName: "div", properties: {}, children: [link("library/report.pdf", "Report")] }, resolve), null);
  assert.equal(soloFileLinkParagraph(null, resolve), null);
});
