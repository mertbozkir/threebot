import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FILE_STACK_LIMIT, MEDIA_ROW_LIMIT, fileGlyphKind, mediaDuration, mediaFileKind, mediaRowTiles,
  messageFileLinks, soloMarkdownLink, stackPage,
} from "../src/lib/fileCards.ts";
import { workspaceLinkPath } from "../src/lib/workspaceLinks.ts";

const resolve = (href: string) => workspaceLinkPath(href, "/Users/mert/project");

test("message file links collect workspace links in order from any position", () => {
  const sentence = "I created [lorem.pdf](library/lorem.pdf) and [notes.md](library/notes.md) for you.";
  assert.deepEqual(messageFileLinks(sentence, resolve).map((link) => link.path), ["library/lorem.pdf", "library/notes.md"]);
  const list = "Created the files:\n\n- [a.xlsx](library/a.xlsx) has rows and [b.xlsx](library/b.xlsx) is blank\n- [c.docx](library/c.docx) has a title";
  assert.deepEqual(messageFileLinks(list, resolve).map((link) => link.path), ["library/a.xlsx", "library/b.xlsx", "library/c.docx"]);
  const table = "| File | Notes |\n| --- | --- |\n| [d.pdf](library/d.pdf) | one page |";
  assert.deepEqual(messageFileLinks(table, resolve).map((link) => link.path), ["library/d.pdf"]);
});

test("message file links dedupe by path and skip external links and code", () => {
  const text = "[a.pdf](library/a.pdf) and again [same](library/a.pdf). See [web](https://example.com/a.pdf). Code `[b.md](library/b.md)` stays inline.";
  assert.deepEqual(messageFileLinks(text, resolve).map((link) => link.path), ["library/a.pdf"]);
  const fenced = "```\n[f.md](library/f.md)\n```\nThen [real.md](library/real.md).";
  assert.deepEqual(messageFileLinks(fenced, resolve).map((link) => link.path), ["library/real.md"]);
  assert.deepEqual(messageFileLinks("No files here.", resolve), []);
});

test("paragraph-only links are excluded from the stack, other positions are kept", () => {
  const text = "[report.pdf](library/report.pdf)\n\nAlso see [data.xlsx](library/data.xlsx) inline.";
  const solo = new Set(
    text.split("\n\n").flatMap((part) => soloMarkdownLink(part, resolve)?.path ?? []),
  );
  const stacked = messageFileLinks(text, resolve).filter((link) => !solo.has(link.path));
  assert.deepEqual(stacked.map((link) => link.path), ["library/data.xlsx"]);
  assert.match(String(soloMarkdownLink("  [deck.pptx](library/deck.pptx)  ", resolve)?.path), /deck\.pptx/);
  assert.equal(soloMarkdownLink("See [deck.pptx](library/deck.pptx) here", resolve), null);
  assert.equal(soloMarkdownLink("[outside.pdf](../elsewhere/outside.pdf)", resolve), null);
});

test("the stack caps at twelve cards and expands on demand", () => {
  const files = Array.from({ length: 15 }, (_, index) => ({ href: `library/f${index}.pdf`, path: `library/f${index}.pdf`, text: `f${index}` }));
  const page = stackPage(files, false);
  assert.equal(page.files.length, FILE_STACK_LIMIT);
  assert.equal(page.hidden, 3);
  assert.deepEqual(stackPage(files, true), { files, hidden: 0 });
  assert.deepEqual(stackPage(files.slice(0, 12), false), { files: files.slice(0, 12), hidden: 0 });
});

test("glyph kinds map each file family", () => {
  for (const [name, kind] of [
    ["doc.pdf", "pdf"],
    ["sheet.xlsx", "sheet"], ["table.csv", "sheet"], ["table.tsv", "sheet"], ["old.xls", "sheet"], ["sheet.ods", "sheet"],
    ["memo.docx", "doc"], ["memo.doc", "doc"], ["memo.odt", "doc"],
    ["deck.pptx", "slides"], ["deck.ppt", "slides"], ["deck.key", "slides"], ["deck.odp", "slides"],
    ["data.json", "json"],
    ["notes.txt", "text"], ["notes.md", "text"], ["page.html", "text"], ["feed.xml", "text"],
    ["conf.yaml", "text"], ["conf.yml", "text"], ["app.py", "text"], ["app.ts", "text"], ["app.tsx", "text"],
    ["app.js", "text"], ["app.jsx", "text"], ["run.sh", "text"], ["style.css", "text"], ["main.go", "text"],
    ["lib.rs", "text"], ["App.java", "text"],
    ["bundle.zip", "archive"], ["backup.tar", "archive"], ["logs.gz", "archive"], ["pkg.7z", "archive"], ["disk.rar", "archive"],
    ["song.mp3", "audio"], ["song.wav", "audio"], ["song.m4a", "audio"], ["song.ogg", "audio"],
    ["binary.bin", "other"], ["noextension", "other"],
  ] as const) assert.equal(fileGlyphKind(name), kind, name);
});

test("media kinds cover audio, video and image files", () => {
  for (const [name, kind] of [
    ["a.mp3", "audio"], ["a.wav", "audio"], ["a.m4a", "audio"], ["a.ogg", "audio"],
    ["v.mp4", "video"], ["v.mov", "video"], ["v.webm", "video"],
    ["i.png", "image"], ["i.jpg", "image"], ["i.jpeg", "image"], ["i.gif", "image"], ["i.webp", "image"], ["i.svg", "image"],
    ["d.pdf", null], ["t.txt", null],
  ] as const) assert.equal(mediaFileKind(name), kind, name);
  assert.equal(mediaDuration(2.4), "0:02");
  assert.equal(mediaDuration(61), "1:01");
  assert.equal(mediaDuration(NaN), "0:00");
});

test("media rows show three tiles and overlay the count beyond the first two", () => {
  assert.deepEqual(mediaRowTiles(1), { visible: 1, overlay: null });
  assert.deepEqual(mediaRowTiles(3), { visible: MEDIA_ROW_LIMIT, overlay: null });
  assert.deepEqual(mediaRowTiles(4), { visible: 3, overlay: 2 });
  assert.deepEqual(mediaRowTiles(5), { visible: 3, overlay: 3 });
});
