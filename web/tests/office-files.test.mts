import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, afterEach, beforeEach, test } from "node:test";
import { MessageChannel } from "node:worker_threads";
import { strToU8, zipSync, type Zippable } from "fflate";
import { JSDOM } from "jsdom";
import { Window } from "happy-dom";
import { buildOnce, domWindow, entryChunk } from "./support.mts";
import { OFFICE_LIMITS, dateFormat, formatSerialDate, parseDocx, parseXlsx } from "../src/lib/office.ts";
import { workspaceFileKind } from "../src/lib/workspaceLinks.ts";

// The parser runs on real zips built here with fflate and on jsdom's XML DOMParser (namespace-aware, like browsers').
globalThis.DOMParser = new JSDOM("").window.DOMParser;

const S = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));
const types = (main: string, kind: string) => `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/${main}" ContentType="application/vnd.openxmlformats-officedocument.${kind}"/></Types>`;
const rels = (items: [string, string, string][]) => `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.map(([id, type, target]) => `<Relationship Id="${id}" Type="${R}/${type}" Target="${target}"/>`).join("")}</Relationships>`;
const zip = (files: Record<string, string | Uint8Array>) => zipSync(Object.fromEntries(Object.entries(files).map(([name, value]) => [name, typeof value === "string" ? strToU8(value) : value])) as Zippable);

function xlsx({ sheet1, sheet2 = `<worksheet xmlns="${S}"><sheetData/></worksheet>`, date1904 = false, extra = {} }: { sheet1: string; sheet2?: string; date1904?: boolean; extra?: Record<string, string | Uint8Array> }) {
  return zip({
    "[Content_Types].xml": types("xl/workbook.xml", "spreadsheetml.sheet.main+xml"),
    "_rels/.rels": rels([["rId1", "officeDocument", "xl/workbook.xml"]]),
    "xl/workbook.xml": `${XML}<workbook xmlns="${S}" xmlns:r="${R}"><workbookPr${date1904 ? ' date1904="1"' : ""}/><sheets><sheet name="Özet ıİşğ" sheetId="1" r:id="rId1"/><sheet name="Empty" sheetId="2" r:id="rId2"/><sheet name="Chart" sheetId="3" r:id="rId9"/></sheets><calcPr calcId="191029"/></workbook>`,
    "xl/_rels/workbook.xml.rels": rels([["rId1", "worksheet", "worksheets/sheet1.xml"], ["rId2", "worksheet", "/xl/worksheets/sheet2.xml"], ["rId3", "styles", "styles.xml"], ["rId4", "sharedStrings", "sharedStrings.xml"], ["rId9", "chartsheet", "chartsheets/sheet1.xml"]]),
    "xl/styles.xml": `${XML}<styleSheet xmlns="${S}"><numFmts count="3"><numFmt numFmtId="164" formatCode="dd.mm.yyyy hh:mm"/><numFmt numFmtId="165" formatCode="0.00 &quot;TL&quot;"/><numFmt numFmtId="166" formatCode="[h]:mm:ss"/></numFmts><fonts count="2"><font/><font><b/></font></fonts><cellXfs count="6"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/><xf numFmtId="164" applyNumberFormat="1"/><xf numFmtId="165" applyNumberFormat="1"/><xf numFmtId="166" applyNumberFormat="1"/><xf numFmtId="0" fontId="1" applyFont="1"/></cellXfs></styleSheet>`,
    "xl/sharedStrings.xml": `${XML}<sst xmlns="${S}" count="4" uniqueCount="4"><si><t>Name</t></si><si><r><rPr><b/></rPr><t>Bold</t></r><r><t xml:space="preserve"> part</t></r></si><si><t>漢字</t><rPh sb="0" eb="2"><t>かんじ</t></rPh></si><si><t>Tab_x0009_here</t></si></sst>`,
    "xl/worksheets/sheet1.xml": sheet1,
    "xl/worksheets/sheet2.xml": sheet2,
    ...extra,
  });
}

const SHEET1 = `${XML}<worksheet xmlns="${S}" xmlns:r="${R}"><sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c></row>
<row r="2"><c r="A2"><v>2</v></c><c r="B2"><f>A2*2</f><v>4</v></c><c r="C2"><f t="shared" ref="C2:C3" si="0">A2+1</f><v>3</v></c><c r="D2" s="5"><v>0.30000000000000004</v></c></row>
<row r="3"><c r="A3"><v>5</v></c><c r="C3"><f t="shared" si="0"/><v>6</v></c><c r="D3" t="b"><v>1</v></c><c r="E3" t="e"><v>#DIV/0!</v></c><c r="F3" t="str"><f>"a"&amp;"b"</f><v>ab</v></c><c r="G3" t="inlineStr"><is><t>Inline ıİşğ</t></is></c></row>
<row r="5"><c r="A5" s="1"><v>45366</v></c><c r="B5" s="2"><v>45366.75</v></c><c r="C5" s="3"><v>12.5</v></c><c r="D5" s="4"><v>1.5</v></c><c r="E5" s="1"><v>60</v></c><c r="F5" s="5"/></row>
<row><c><v>7</v></c><c><v>8</v></c></row>
<row r="7"><c r="A7" t="inlineStr"><is><t>Merged</t></is></c><c r="B7" s="5"/><c r="C7" s="5"/></row>
</sheetData><mergeCells count="1"><mergeCell ref="A7:C7"/></mergeCells><drawing r:id="rId1"/><legacyDrawing r:id="rId2"/></worksheet>`;
const SHEET1_PARTS = {
  "xl/worksheets/_rels/sheet1.xml.rels": rels([["rId1", "drawing", "../drawings/drawing1.xml"], ["rId2", "vmlDrawing", "../drawings/vmlDrawing1.vml"], ["rId3", "comments", "../comments1.xml"]]),
  "xl/comments1.xml": `${XML}<comments xmlns="${S}"><authors><author>Sample</author></authors><commentList><comment ref="A2" authorId="0"><text><t>A sample comment</t></text></comment></commentList></comments>`,
  "xl/drawings/drawing1.xml": `${XML}<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${R}"><xdr:oneCellAnchor><xdr:pic><xdr:blipFill><a:blip r:embed="rId1"/></xdr:blipFill></xdr:pic></xdr:oneCellAnchor></xdr:wsDr>`,
  "xl/drawings/_rels/drawing1.xml.rels": rels([["rId1", "image", "../media/image1.png"]]),
  "xl/drawings/vmlDrawing1.vml": "<xml></xml>",
  "xl/media/image1.png": PNG,
};
const grid = (sheet) => sheet.rows.map((row) => Array.from({ length: sheet.columns }, (_, i) => row[i] ?? ""));

test("workspaceFileKind sends .xlsx and .docx to the Office viewer, in any case, and leaves older formats alone", () => {
  for (const [path, kind] of [["library/budget.xlsx", "sheet"], ["REPORT.XLSX", "sheet"], ["notes/Memo.DocX", "doc"], ["memo.docx", "doc"], ["old.xls", "file"], ["macro.xlsm", "file"], ["old.doc", "file"], ["slides.pptx", "file"], ["budget.xlsx.txt", "text"]]) assert.equal(workspaceFileKind(path), kind, path);
});

test("a workbook shows sheet names, cached values, shared and rich strings, and dates in its own number formats", async () => {
  const { sheets } = await parseXlsx(xlsx({ sheet1: SHEET1, extra: SHEET1_PARTS }));
  assert.deepEqual(sheets.map((sheet) => sheet.name), ["Özet ıİşğ", "Empty"], "chart sheets are skipped");
  assert.deepEqual(grid(sheets[0]), [
    ["Name", "Bold part", "漢字", "Tab\there", "", "", ""],
    ["2", "4", "3", "0.3", "", "", ""],
    ["5", "", "6", "TRUE", "#DIV/0!", "ab", "Inline ıİşğ"],
    ["", "", "", "", "", "", ""],
    ["2024-03-15", "2024-03-15 18:00", "12.5", "36:00:00", "1900-02-29", "", ""],
    ["7", "8", "", "", "", "", ""],
    ["Merged", "", "", "", "", "", ""],
  ]);
  assert.equal(sheets[0].truncatedRows, false);
  assert.deepEqual({ rows: sheets[1].rows, columns: sheets[1].columns }, { rows: [], columns: 0 });
});

test("a 1904 workbook counts dates from 1904-01-01", async () => {
  const sheet1 = `<worksheet xmlns="${S}"><sheetData><row r="1"><c r="A1" s="1"><v>43904</v></c><c r="B1" s="1"><v>0</v></c><c r="C1" s="2"><v>43904.5</v></c></row></sheetData></worksheet>`;
  const { sheets } = await parseXlsx(xlsx({ sheet1, date1904: true }));
  assert.deepEqual(grid(sheets[0]), [["2024-03-15", "1904-01-01", "2024-03-15 12:00"]]);
});

test("date formats are told apart from number formats, and serials convert in both date systems", () => {
  for (const code of ["m/d/yyyy", "dd.mm.yyyy", "mmm-yy", "[$-41F]d mmmm yyyy;@", "yyyy\\-mm\\-dd"]) assert.equal(dateFormat(code)?.date, true, code);
  for (const code of ["h:mm AM/PM", "mm:ss", "[h]:mm:ss"]) assert.deepEqual([dateFormat(code)?.date, dateFormat(code)?.time], [false, true], code);
  for (const code of ["General", "0.00", '#,##0 "days"', "[Red]0.00", "0.00E+00", '0" m"', "_(* #,##0_)"]) assert.equal(dateFormat(code), null, code);
  const date = { date: true, time: false, seconds: false, elapsed: false };
  assert.equal(formatSerialDate(1, date, false), "1900-01-01");
  assert.equal(formatSerialDate(59, date, false), "1900-02-28");
  assert.equal(formatSerialDate(61, date, false), "1900-03-01");
  assert.equal(formatSerialDate(1, date, true), "1904-01-02");
  assert.equal(formatSerialDate(-1, date, false), null);
});

test("prefixed spreadsheet XML (x:) parses the same as the default namespace", async () => {
  const P = (name: string, body: string, attrs = "") => `<x:${name}${attrs}>${body}</x:${name}>`;
  const bytes = zip({
    "[Content_Types].xml": types("xl/workbook.xml", "spreadsheetml.sheet.main+xml"),
    "_rels/.rels": rels([["rId1", "officeDocument", "xl/workbook.xml"]]),
    "xl/workbook.xml": `${XML}<x:workbook xmlns:x="${S}" xmlns:r="${R}"><x:sheets><x:sheet name="Prefixed" sheetId="1" r:id="rId1"/></x:sheets></x:workbook>`,
    "xl/_rels/workbook.xml.rels": rels([["rId1", "worksheet", "worksheets/sheet1.xml"], ["rId2", "sharedStrings", "sharedStrings.xml"]]),
    "xl/sharedStrings.xml": `<x:sst xmlns:x="${S}">${P("si", P("t", "Shared"))}</x:sst>`,
    "xl/worksheets/sheet1.xml": `<x:worksheet xmlns:x="${S}">${P("sheetData", P("row", `<x:c r="A1" t="inlineStr">${P("is", P("t", "Inline"))}</x:c><x:c r="B1" t="s"><x:v>0</x:v></x:c><x:c r="C1"><x:v>1.5</x:v></x:c>`, ' r="1"'))}</x:worksheet>`,
  });
  assert.deepEqual(grid((await parseXlsx(bytes)).sheets[0]), [["Inline", "Shared", "1.5"]]);
});

test("a long sheet shows its first 1,000 rows and a wide one its first 100 columns", async () => {
  const rows = Array.from({ length: 1200 }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}"><v>${i + 1}</v></c>${i === 0 ? '<c r="FA1"><v>9</v></c>' : ""}</row>`).join("");
  const [sheet] = (await parseXlsx(xlsx({ sheet1: `<worksheet xmlns="${S}"><sheetData>${rows}</sheetData></worksheet>` }))).sheets;
  assert.equal(sheet.rows.length, OFFICE_LIMITS.rows);
  assert.equal(sheet.rows.at(-1)[0], "1000");
  assert.equal(sheet.columns, 1);
  assert.deepEqual([sheet.truncatedRows, sheet.truncatedColumns], [true, true]);
});

const DOCUMENT = `${XML}<w:document xmlns:w="${W}" xmlns:r="${R}" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>
<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>Quarterly report</w:t></w:r></w:p>
<w:p><w:pPr><w:pStyle w:val="Balk1"/></w:pPr><w:r><w:t>Özet</w:t></w:r></w:p>
<w:p><w:pPr><w:pStyle w:val="Details2"/></w:pPr><w:r><w:t>Details</w:t></w:r></w:p>
<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Bold </w:t></w:r><w:r><w:rPr><w:i/><w:b w:val="0"/></w:rPr><w:t>italic</w:t></w:r><w:r><w:tab/><w:t>tabbed</w:t><w:br/><w:t>next line</w:t></w:r></w:p>
<w:p><w:r><w:t>Iğdır'da şişe İçin ılık</w:t></w:r></w:p>
<w:p><w:pPr><w:bidi/></w:pPr><w:r><w:rPr><w:rtl/></w:rPr><w:t>שלום עולם</w:t></w:r></w:p>
<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>First bullet</w:t></w:r></w:p>
<w:p><w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Nested bullet</w:t></w:r></w:p>
<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr></w:pPr><w:r><w:t>Step one</w:t></w:r></w:p>
<w:p><w:pPr><w:pStyle w:val="ListNumber"/></w:pPr><w:r><w:t>Step two</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve">Kept </w:t></w:r><w:ins w:id="1" w:author="Sample"><w:r><w:t>inserted</w:t></w:r></w:ins><w:del w:id="2" w:author="Sample"><w:r><w:delText>deleted</w:delText></w:r></w:del></w:p>
<w:p><w:r><w:t xml:space="preserve">Page </w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>3</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r><w:r><w:t xml:space="preserve"> of </w:t></w:r><w:fldSimple w:instr=" NUMPAGES "><w:r><w:t>9</w:t></w:r></w:fldSimple></w:p>
<w:p><w:r><w:drawing><wp:inline><wp:extent cx="952500" cy="952500"/><wp:docPr id="1" name="Picture 1" descr="Sample chart"/><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="rIdImg"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>
<w:tbl><w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>Wide</w:t></w:r></w:p></w:tc><w:tc><w:tcPr><w:vMerge w:val="restart"/></w:tcPr><w:p><w:r><w:t>Tall</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>a</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>b</w:t></w:r></w:p></w:tc><w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p/></w:tc></w:tr></w:tbl>
<w:p><w:commentRangeStart w:id="0"/><w:r><w:t xml:space="preserve">Commented </w:t></w:r><w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r><w:hyperlink r:id="rIdLink"><w:r><w:t>link</w:t></w:r></w:hyperlink></w:p>
<w:sectPr/></w:body></w:document>`;
const docx = (document: string, extra: Record<string, string | Uint8Array> = {}) => zip({
  "[Content_Types].xml": types("word/document.xml", "wordprocessingml.document.main+xml"),
  "_rels/.rels": rels([["rId1", "officeDocument", "word/document.xml"]]),
  "word/document.xml": document,
  "word/_rels/document.xml.rels": `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="${R}/styles" Target="styles.xml"/><Relationship Id="rIdNum" Type="${R}/numbering" Target="numbering.xml"/><Relationship Id="rIdImg" Type="${R}/image" Target="media/image1.png"/><Relationship Id="rIdComments" Type="${R}/comments" Target="comments.xml"/><Relationship Id="rIdLink" Type="${R}/hyperlink" Target="https://example.com/" TargetMode="External"/></Relationships>`,
  "word/styles.xml": `${XML}<w:styles xmlns:w="${W}"><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/></w:style><w:style w:type="paragraph" w:styleId="Balk1"><w:name w:val="heading 1"/></w:style><w:style w:type="paragraph" w:styleId="Details2"><w:name w:val="Custom"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="ListNumber"><w:name w:val="List Number"/><w:pPr><w:numPr><w:numId w:val="2"/></w:numPr></w:pPr></w:style></w:styles>`,
  "word/numbering.xml": `${XML}<w:numbering xmlns:w="${W}"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum><w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>`,
  "word/comments.xml": `${XML}<w:comments xmlns:w="${W}"><w:comment w:id="0" w:author="Sample"><w:p><w:r><w:t>A sample comment</w:t></w:r></w:p></w:comment></w:comments>`,
  "word/media/image1.png": PNG,
  ...extra,
});
const p = (runs, extra = {}) => ({ type: "paragraph", heading: 0, rtl: false, runs, ...extra });

test("a document keeps headings, runs, Turkish and RTL text, paragraph and style lists, accepted changes, field results, images and tables", async () => {
  const { blocks, images } = await parseDocx(docx(DOCUMENT));
  assert.deepEqual(blocks, [
    p([{ text: "Quarterly report" }], { heading: 1 }),
    p([{ text: "Özet" }], { heading: 1 }),
    p([{ text: "Details" }], { heading: 2 }),
    p([{ text: "Bold ", bold: true }, { text: "italic", italic: true }, { text: "\ttabbed\nnext line" }]),
    p([{ text: "Iğdır'da şişe İçin ılık" }]),
    p([{ text: "שלום עולם", rtl: true }], { rtl: true }),
    p([{ text: "First bullet" }], { list: { level: 0, ordered: false } }),
    p([{ text: "Nested bullet" }], { list: { level: 1, ordered: false } }),
    p([{ text: "Step one" }], { list: { level: 0, ordered: true } }),
    p([{ text: "Step two" }], { list: { level: 0, ordered: true } }),
    p([{ text: "Kept " }, { text: "inserted" }]),
    p([{ text: "Page " }, { text: "3" }, { text: " of " }, { text: "9" }]),
    p([{ image: 0, alt: "Sample chart", width: 100 }]),
    { type: "table", rows: [
      [{ colSpan: 2, rowSpan: 1, blocks: [p([{ text: "Wide" }])] }, { colSpan: 1, rowSpan: 2, blocks: [p([{ text: "Tall" }])] }],
      [{ colSpan: 1, rowSpan: 1, blocks: [p([{ text: "a" }])] }, { colSpan: 1, rowSpan: 1, blocks: [p([{ text: "b" }])] }],
    ] },
    p([{ text: "Commented " }, { text: "link" }]),
  ]);
  assert.deepEqual(images.map((image) => [image.type, Buffer.from(image.bytes).equals(Buffer.from(PNG))]), [["image/png", true]]);
});

test("unprefixed WordprocessingML without styles or numbering still finds headings and lists", async () => {
  const bytes = zip({
    "[Content_Types].xml": types("word/document.xml", "wordprocessingml.document.main+xml"),
    "word/document.xml": `<document xmlns="${W}"><body><p><pPr><pStyle val="Heading3"/></pPr><r><t>Plain</t></r></p><p><pPr><numPr><ilvl val="0"/><numId val="4"/></numPr></pPr><r><t>Item</t></r></p><p><pPr><numPr><numId val="0"/></numPr></pPr><r><t>Not a list</t></r></p></body></document>`,
  });
  assert.deepEqual((await parseDocx(bytes)).blocks, [p([{ text: "Plain" }], { heading: 3 }), p([{ text: "Item" }], { list: { level: 0, ordered: false } }), p([{ text: "Not a list" }])]);
});

/** Rewrite central-directory records, the sizes and names unzip trusts before inflating. */
function patchCentral(bytes: Uint8Array, change: (entry: { name: string; setSize: (size: number) => void; setName: (name: string) => void }) => void) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  while (view.getUint32(end, true) !== 0x06054b50) end--;
  let at = view.getUint32(end + 16, true);
  for (let n = view.getUint16(end + 10, true); n > 0; n--) {
    const length = view.getUint16(at + 28, true), start = at + 46;
    change({ name: Buffer.from(bytes.subarray(start, start + length)).toString(), setSize: (size) => view.setUint32(at + 24, size, true), setName: (name) => { assert.equal(name.length, length); bytes.set(strToU8(name), start); } });
    at = start + length + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
  }
  return bytes;
}

test("refuses zip bombs, duplicate and backslash names, OLE and other non-zip bytes, and packages without their parts", async () => {
  const sheet1 = `<worksheet xmlns="${S}"><sheetData/></worksheet>`;
  const refused = async (bytes: Uint8Array, pattern: RegExp, parse: (bytes: Uint8Array) => Promise<unknown> = parseXlsx) => assert.rejects(parse(bytes), (error: Error) => { assert.equal(error.name, "OfficeFileError"); assert.match(error.message, pattern); return true; });
  await refused(xlsx({ sheet1, extra: { "xl/media/zeros.bin": new Uint8Array(40 * 1024 * 1024) } }), /larger than 30 MB/);
  await refused(patchCentral(xlsx({ sheet1, extra: { "xl/a.bin": "a", "xl/b.bin": "b", "xl/c.bin": "c", "xl/d.bin": "d" } }), (entry) => { if (/\/[a-d]\.bin$/.test(entry.name)) entry.setSize(29 * 1024 * 1024); }), /more than 100 MB/);
  await refused(xlsx({ sheet1, extra: Object.fromEntries(Array.from({ length: OFFICE_LIMITS.entries }, (_, i) => [`xl/parts/${i}.xml`, "<a/>"])) }), /more than 2,000 parts/);
  await refused(patchCentral(xlsx({ sheet1, extra: { "xl/dupe-b.xml": "<b/>", "xl/dupe-a.xml": "<a/>" } }), (entry) => { if (entry.name === "xl/dupe-b.xml") entry.setName("xl/dupe-a.xml"); }), /same name/);
  await refused(xlsx({ sheet1, extra: { "xl/DUPE.xml": "<a/>", "xl/dupe.xml": "<b/>" } }), /same name/);
  await refused(xlsx({ sheet1, extra: { "xl\\evil.xml": "<a/>" } }), /backslash/);
  const notOffice = /isn't a readable \.xlsx file. It may be password-protected/;
  await refused(Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, ...new Uint8Array(4096)]), notOffice);
  await refused(strToU8("name,value\nA,1\n"), notOffice);
  await refused(zip({ "xl/workbook.xml": `<workbook xmlns="${S}"/>` }), notOffice);
  await refused(zip({ "[Content_Types].xml": types("xl/workbook.xml", "spreadsheetml.sheet.main+xml") }), notOffice);
  await refused(docx(DOCUMENT), notOffice);
  await refused(xlsx({ sheet1: `<!DOCTYPE worksheet [<!ENTITY a "aaaa">]><worksheet xmlns="${S}"><sheetData/></worksheet>` }), notOffice);
  await refused(xlsx({ sheet1: `<worksheet xmlns="${S}"><sheetData>` }), notOffice);
  await refused(xlsx({ sheet1, extra: {} }).slice(0, 200), notOffice);
  await refused(xlsx({ sheet1 }), /isn't a readable \.docx file/, parseDocx);
});

// The viewer itself, in React DOM: T3's signing RPC and the file fetch are the boundaries.
const channels = [];
globalThis.MessageChannel = class extends MessageChannel { constructor() { super(); channels.push(this); } };
const window = domWindow(new Window({ url: "https://office.test/chat", settings: { navigation: { disableChildFrameNavigation: true }, enableImageFileLoading: false } }));
for (const key of ["window", "document", "navigator", "history", "location", "HTMLElement", "Element", "Node", "Event", "MouseEvent", "KeyboardEvent", "IntersectionObserver", "localStorage", "requestAnimationFrame", "cancelAnimationFrame"]) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: window[key] });
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const src = new URL("../src/", import.meta.url).pathname;
const bundle = await buildOnce({
  configFile: false, logLevel: "silent", define: { "process.env.NODE_ENV": '"development"' },
  plugins: [{ name: "office-test", resolveId: (id) => id.endsWith("virtual:office") ? "\0office" : undefined,
    load: (id) => id === "\0office" ? `
      export { createElement, act } from "react";
      export { createRoot } from "react-dom/client";
      export { WorkspaceResourceViewer } from ${JSON.stringify(src + "components/WorkspaceResource.tsx")};
      export { t3 } from ${JSON.stringify(src + "lib/t3.ts")};` : undefined }],
  ssr: { noExternal: true }, build: { ssr: "virtual:office", write: false, rollupOptions: { output: { codeSplitting: false } } },
});
const directory = await mkdtemp(join(tmpdir(), "bot-office-"));
const filename = join(directory, "components.mjs"); await writeFile(filename, entryChunk(bundle).code);
const { createElement: h, act, createRoot, WorkspaceResourceViewer, t3 } = await import(pathToFileURL(filename).href);
after(async () => { for (const channel of channels) { channel.port1.close(); channel.port2.close(); } await window.happyDOM.close(); await rm(directory, { recursive: true }); });

let root, host, signed, fetched, body: Uint8Array;
const realFetch = globalThis.fetch;
const settle = async (done: () => boolean) => { for (let tries = 0; tries < 100 && !done(); tries++) await act(() => new Promise((resolve) => setTimeout(resolve, 10))); };
const open = async (path: string) => {
  await act(async () => { root.render(h(WorkspaceResourceViewer, { resource: { _tag: "workspace-file", threadId: "main", path }, title: path.split("/").at(-1), onClose() {} })); });
  await settle(() => !document.querySelector('[role="dialog"] [role="status"]') || !!document.querySelector(".office-note"));
};
beforeEach(() => {
  signed = []; fetched = [];
  t3.call = async (tag, payload) => { assert.equal(tag, "assets.createUrl"); signed.push(payload.resource); return { relativeUrl: `/assets/signed-${signed.length}` }; };
  globalThis.fetch = async (url) => { fetched.push(String(url)); return new Response(body as Uint8Array<ArrayBuffer>); };
  host = document.createElement("main"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); document.body.replaceChildren(); globalThis.fetch = realFetch; });

test("the viewer opens a workbook through the media-file download route and draws tabs, a grid and the row note", async () => {
  const rows = Array.from({ length: 1001 }, (_, i) => `<row r="${i + 1}"><c r="B${i + 1}"><v>${i + 1}</v></c></row>`).join("");
  body = xlsx({ sheet1: `<worksheet xmlns="${S}"><sheetData>${rows}</sheetData></worksheet>` });
  await open("library/budget.xlsx");
  assert.deepEqual(signed, [{ _tag: "media-file", threadId: "main", path: "library/budget.xlsx", disposition: "attachment" }]);
  assert.deepEqual(fetched, ["/t3/assets/signed-1"]);
  const tabs = [...document.querySelectorAll<HTMLElement>('[role="tab"]')];
  assert.deepEqual(tabs.map((tab) => [tab.textContent, tab.getAttribute("aria-selected")]), [["Özet ıİşğ", "true"], ["Empty", "false"]]);
  assert.deepEqual([...document.querySelectorAll(".office-grid thead th")].map((th) => th.textContent), ["", "A", "B"]);
  assert.equal(document.querySelectorAll(".office-grid tbody tr").length, 1000);
  assert.deepEqual([...document.querySelectorAll(".office-grid tbody tr")].at(-1).textContent, "10001000");
  assert.match(document.querySelector(".office-note").textContent, /Showing the first 1,000 rows/);
  assert.equal(document.querySelector('[role="dialog"] a').textContent, "Open original file");
  await act(async () => { tabs[1].click(); });
  assert.match(document.querySelector('[role="dialog"]').textContent, /This sheet is empty/);
  assert.equal(document.querySelector(".office-note"), null);
});

test("the viewer draws a document as headings, paragraphs, lists, tables and a blob image, with RTL direction", async () => {
  body = docx(DOCUMENT);
  await open("library/memo.docx");
  assert.deepEqual(signed[0], { _tag: "media-file", threadId: "main", path: "library/memo.docx", disposition: "attachment" });
  const article = document.querySelector(".office-doc");
  assert.deepEqual([...article.querySelectorAll("h1, h2")].map((heading) => `${heading.tagName}:${heading.textContent}`), ["H1:Quarterly report", "H1:Özet", "H2:Details"]);
  assert.equal(article.querySelector("strong").textContent, "Bold ");
  assert.equal(article.querySelector("em").textContent, "italic");
  assert.equal([...article.querySelectorAll("p")].find((p) => p.textContent === "שלום עולם").getAttribute("dir"), "rtl");
  assert.deepEqual([...article.querySelectorAll("ul > li")].map((li) => li.textContent), ["First bullet", "Nested bullet"]);
  assert.deepEqual([...article.querySelectorAll("ol > li")].map((li) => li.textContent), ["Step one", "Step two"]);
  assert.ok(!article.textContent.includes("deleted") && !article.textContent.includes("PAGE"));
  const image = article.querySelector("img");
  assert.match(image.getAttribute("src"), /^blob:/);
  assert.equal(image.getAttribute("alt"), "Sample chart");
  assert.deepEqual([...article.querySelectorAll("table td")].map((td) => [td.textContent, td.getAttribute("colspan"), td.getAttribute("rowspan")]), [["Wide", "2", null], ["Tall", null, "2"], ["a", null, null], ["b", null, null]]);
});

test("a refused file explains why and keeps the original-file link", async () => {
  body = Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, ...new Uint8Array(512)]);
  await open("library/locked.docx");
  assert.match(document.querySelector('[role="dialog"] [role="alert"]').textContent, /isn't a readable \.docx file. It may be password-protected/);
  assert.equal(document.querySelector('[role="dialog"] a').getAttribute("href"), "/t3/assets/signed-1");
});
