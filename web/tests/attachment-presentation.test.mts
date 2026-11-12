import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, afterEach, beforeEach, mock, test } from "node:test";
import { MessageChannel } from "node:worker_threads";
import { Window } from "happy-dom";
import { buildOnce, domWindow, entryChunk } from "./support.mts";

// Real attachment tiles, viewer, React DOM and signed-resource adapter. RPC,
// signed HTTP responses and browser downloads are the external boundaries.
const channels = [];
globalThis.MessageChannel = class extends MessageChannel { constructor() { super(); channels.push(this); } };
const window = domWindow(new Window({ url: "https://attachment-presentation.test/", settings: { navigation: { disableChildFrameNavigation: true }, enableImageFileLoading: false } }));
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event", "MouseEvent", "KeyboardEvent", "IntersectionObserver", "localStorage", "requestAnimationFrame", "cancelAnimationFrame", "history"]) Object.defineProperty(globalThis, key, { configurable: true, value: window[key] });
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const src = new URL("../src/", import.meta.url).pathname;
const bundle = await buildOnce({
  configFile: false, logLevel: "silent", define: { "process.env.NODE_ENV": '"development"' },
  plugins: [{ name: "attachment-presentation-test", resolveId: (id) => id.endsWith("virtual:attachment-presentation") ? "\0attachment-presentation" : undefined,
    load: (id) => id === "\0attachment-presentation" ? `
      export { createElement, act } from "react";
      export { createRoot } from "react-dom/client";
      export { ChatAttachmentList } from ${JSON.stringify(src + "components/ChatAttachments.tsx")};
      export { t3 } from ${JSON.stringify(src + "lib/t3.ts")};` : undefined }],
  ssr: { noExternal: true }, build: { ssr: "virtual:attachment-presentation", write: false },
});
const entry = entryChunk(bundle);
assert.ok(entry);
const directory = await mkdtemp(join(tmpdir(), "bot-attachment-presentation-"));
const filename = join(directory, "components.mjs"); await writeFile(filename, entry.code);
const { createElement: h, act, createRoot, ChatAttachmentList, t3 } = await import(pathToFileURL(filename).href);
after(async () => { for (const channel of channels) { channel.port1.close(); channel.port2.close(); } await window.happyDOM.close(); await rm(directory, { recursive: true }); });
let root, host, calls, downloads, fetches;
const flush = () => new Promise((resolve) => setImmediate(resolve));
const button = (label) => [...document.querySelectorAll("button")].find((element) => element.getAttribute("aria-label") === label || element.textContent.trim() === label);
const render = async (attachments) => act(async () => { root.render(h(ChatAttachmentList, { attachments })); await flush(); });
const click = async (label) => { const element = button(label); assert.ok(element, label + " exists"); await act(async () => { element.click(); await flush(); }); };
beforeEach(() => {
  calls = []; downloads = []; fetches = [];
  t3.call = async (tag, payload) => { assert.equal(tag, "assets.createUrl"); calls.push(payload.resource); return { relativeUrl: `/assets/current-${calls.length}` }; };
  globalThis.fetch = async (url) => { fetches.push(url); return new Response("name,value\nexample,1", { status: 200, headers: servedType ? { "content-type": servedType } : {} }); };
  mock.method(window.HTMLAnchorElement.prototype, "click", function () { downloads.push({ href: this.getAttribute("href"), filename: this.download }); });
  host = document.createElement("main"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); document.body.replaceChildren(); mock.restoreAll(); });

let servedType: string | undefined;

test("CSV tile shows native-style basename, actual type/size and a signed table preview", async () => {
  await render([{ id: "csv", type: "file", name: "sample.csv", mimeType: "text/csv", sizeBytes: 27 }]);
  const open = button("Open sample.csv");
  assert.equal(open.textContent, "sampleCSV · 27 B");
  assert.equal(open.title, "sample.csv");
  assert.ok(open.querySelector("svg.lucide-file-spreadsheet"));
  assert.equal(button("Download sample.csv").title, "Download sample.csv");
  await click("Open sample.csv");
  assert.deepEqual([...document.querySelectorAll('[role="dialog"] td')].map((cell) => cell.textContent), ["example", "1"]);
  assert.deepEqual(calls, [{ _tag: "attachment", attachmentId: "csv", disposition: "inline" }]);
  assert.deepEqual(fetches, ["/t3/assets/current-1"]);
  assert.equal(document.querySelector('[role="dialog"] a').getAttribute("href"), "/t3/assets/current-1");
});

test("file sizes include genuine zero and scale valid byte counts without invented metadata", async () => {
  for (const [bytes, detail] of [[0, "0 B"], [1023, "1023 B"], [1024, "1 KB"], [1572864, "1.5 MB"]]) {
    await render([{ id: "size", name: "archive.bin", sizeBytes: bytes }]);
    assert.equal(button("Open archive.bin").textContent, "archiveBIN · " + detail);
  }
  for (const invalid of [undefined, null, "27", -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await render([{ id: "size", name: "archive.bin", sizeBytes: invalid }]);
    assert.equal(button("Open archive.bin").textContent, "archiveBIN");
  }
});

test("extensionless image MIME survives thumbnail failure and opens the real image without inventing a filename", async () => {
  await render([{ id: "photo", type: "file", name: "holiday", mimeType: " Image/PNG ; charset=binary ", sizeBytes: 512 }]);
  const thumbnail = button("Open holiday").querySelector("img");
  assert.equal(thumbnail.getAttribute("src"), "/t3/assets/current-1");
  await act(async () => thumbnail.dispatchEvent(new window.Event("error")));
  assert.equal(button("Open holiday").textContent, "holidayPNG · 512 B");
  assert.ok(button("Open holiday").querySelector("svg.lucide-file-image"));
  await click("Open holiday");
  const image = document.querySelector<HTMLImageElement>('[role="dialog"] img');
  assert.equal(image.getAttribute("src"), "/t3/assets/current-2");
  assert.equal(image.alt, "holiday");
  assert.deepEqual(calls.slice(0, 2), Array(2).fill({ _tag: "attachment", attachmentId: "photo", disposition: "inline" }));
  await click("Close"); await click("Download holiday");
  assert.deepEqual(calls[2], { _tag: "attachment", attachmentId: "photo", disposition: "attachment" });
  assert.deepEqual(downloads, [{ href: "/t3/assets/current-3", filename: "holiday" }]);
});

test("unknown formats and invalid MIME retain full accessible names and a working original-file action", async () => {
  const name = "really-long-name-".repeat(30) + ".mystery";
  await render([null, { id: "" }, { id: "unknown", name, mimeType: "image/not-a-supported-format", sizeBytes: "27" }]);
  const open = button("Open " + name);
  assert.equal(open.textContent, name.slice(0, -8) + "MYSTERY");
  assert.ok(open.querySelector("svg.lucide-file"));
  assert.equal(open.title, name);
  assert.deepEqual(calls, [], "an unknown image MIME does not initiate thumbnail work");
  await click("Open " + name);
  assert.match(document.querySelector('[role="dialog"]').textContent, /Preview isn't available/);
  assert.deepEqual(calls, [{ _tag: "attachment", attachmentId: "unknown" }]);
  assert.equal(document.querySelector('[role="dialog"] a').getAttribute("href"), "/t3/assets/current-1");
  await click("Close");
  for (const mimeType of ["not a MIME", "text/x-unrecognized", "application/octet-stream"]) {
    await render([{ id: "bare", name: ".env", mimeType }]);
    assert.equal(button("Open .env").textContent, ".envFile");
  }
});

for (const [mimeType, selector, detail] of [["application/pdf", "iframe", "PDF"], ["video/mp4", "video", "MP4"], ["text/plain", "pre", "Text"], ["text/html", "iframe", "HTML"]]) {
  test(`extensionless ${mimeType} uses metadata for the actual resource viewer`, async () => {
    servedType = mimeType;
    await render([{ id: "extensionless", name: "resource", mimeType, sizeBytes: 27 }]);
    assert.equal(button("Open resource").textContent, "resource" + detail + " · 27 B");
    await click("Open resource");
    const preview = document.querySelector('[role="dialog"] ' + selector);
    assert.ok(preview);
    if (selector === "pre") assert.equal(preview.textContent, "name,value\nexample,1");
    else assert.equal(preview.getAttribute("src"), "/t3/assets/current-1");
    if (selector === "iframe") assert.equal(preview.getAttribute("sandbox"), mimeType === "text/html" ? "allow-scripts" : null);
    assert.deepEqual(calls, [{ _tag: "attachment", attachmentId: "extensionless", disposition: "inline" }]);
  });
}
