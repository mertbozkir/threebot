import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, afterEach, beforeEach, mock, test } from "node:test";
import { MessageChannel } from "node:worker_threads";
import { Window } from "happy-dom";
import { buildOnce, domWindow, entryChunk } from "./support.mts";

// Real chat entries, React DOM, clipboard helper, signed-resource adapter and
// resource viewer. Only clipboard, RPC, HTTP and browser download are boundaries.
const channels = [];
globalThis.MessageChannel = class extends MessageChannel { constructor() { super(); channels.push(this); } };
const window = domWindow(new Window({ url: "https://chat-actions.test/", width: 390, height: 844, settings: { navigation: { disableChildFrameNavigation: true }, enableImageFileLoading: false } }));
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event", "MouseEvent", "PointerEvent", "KeyboardEvent", "IntersectionObserver", "localStorage", "requestAnimationFrame", "cancelAnimationFrame", "history"]) Object.defineProperty(globalThis, key, { configurable: true, value: window[key] });
Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const matchMedia = window.matchMedia.bind(window);
window.matchMedia = (query) => matchMedia(query === "(max-width: 760px), (pointer: coarse)" ? "(max-width: 760px)" : query);
const actionStyle = document.createElement("style");
actionStyle.textContent = await readFile(new URL("../src/components/ChatMessageActions.css", import.meta.url), "utf8");
document.head.append(actionStyle);
const src = new URL("../src/", import.meta.url).pathname;
const chat = `${src}components/Chat.tsx`;
const bundle = await buildOnce({
  configFile: false, logLevel: "silent", define: { "process.env.NODE_ENV": '"development"' },
  plugins: [{
    name: "chat-actions-test", resolveId: (id) => id.endsWith("virtual:chat-actions-tests") ? "\0chat-actions-tests" : undefined,
    load: (id) => id === "\0chat-actions-tests" ? `
      export { createElement, act } from "react";
      export { createRoot } from "react-dom/client";
      export { EntryView, AttachmentList } from ${JSON.stringify(chat)};
      export { Sidebar } from ${JSON.stringify(`${src}components/Sidebar.tsx`)};
      export { useApp } from ${JSON.stringify(`${src}store.ts`)};
      export { t3 } from ${JSON.stringify(`${src}lib/t3.ts`)};` : undefined,
    transform: (code, id) => id === chat ? { code: `${code}\nexport { EntryView, AttachmentList };`, map: null } : undefined,
  }], ssr: { noExternal: true }, build: { ssr: "virtual:chat-actions-tests", write: false },
});
const entry = entryChunk(bundle);
assert.ok(entry);
const directory = await mkdtemp(join(tmpdir(), "bot-chat-actions-"));
const filename = join(directory, "components.mjs");
await writeFile(filename, entry.code);
const { createElement: h, act, createRoot, EntryView, AttachmentList, Sidebar, useApp, t3 } = await import(pathToFileURL(filename).href);
after(async () => { for (const channel of channels) { channel.port1.close(); channel.port2.close(); } await window.happyDOM.close(); await rm(directory, { recursive: true }); });

const bot = { slug: "example", name: "Example", mainThreadId: "main", workspaceRoot: "/workspace/example", shape: "blob", color: "gray" };
const file = { id: "file-example", type: "file", name: "report.pdf" };
const photo = { id: "photo-example", type: "image", name: "photo.png", previewUrl: "https://expired.example/old-thumbnail.png" };
let root, host, copied, copy, calls, rpc, fetches, fetchResponse, downloads, commands, dispatch;
const flush = () => new Promise((resolve) => setImmediate(resolve));
const defer = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const button = (label) => [...document.querySelectorAll("button")].find((element) => element.getAttribute("aria-label") === label || element.textContent.trim() === label);
const click = async (element) => { assert.ok(element, "control exists"); await act(async () => { element.click(); await flush(); }); };
const render = async (kind, text, attachments = [], threadId = "main") => act(async () => {
  root.render(h(EntryView, { entry: { kind, id: "message-example", at: "2026-01-01T00:00:00Z", text, attachments }, bot, threadId, accent: "monochrome", onOpenFile() {} }));
  await flush();
});
const renderAttachments = async (attachments) => act(async () => { root.render(h(AttachmentList, { attachments })); await flush(); });
const contextMenu = async (element) => {
  assert.ok(element, "message exists"); const event = new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 100, clientY: 100 });
  await act(async () => element.dispatchEvent(event)); return event;
};
beforeEach(() => {
  window.happyDOM.setWindowSize({ width: 390, height: 844 });
  mock.restoreAll();
  copied = []; calls = []; fetches = []; downloads = []; commands = [];
  dispatch = async () => ({ sequence: 1 });
  t3.dispatch = (command) => { commands.push(command); return dispatch(command); };
  copy = async (text) => { copied.push(text); };
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: (text) => copy(text) } });
  rpc = async () => ({ relativeUrl: `/assets/current-${calls.length}` });
  t3.call = async (tag, payload) => { assert.equal(tag, "assets.createUrl"); calls.push({ tag, payload }); return rpc(tag, payload); };
  fetchResponse = () => new Response("Generic fixture contents", { status: 200 });
  globalThis.fetch = async (url) => { fetches.push(url); return fetchResponse(url); };
  mock.method(window.HTMLAnchorElement.prototype, "click", function () { downloads.push({ href: this.getAttribute("href"), name: this.download }); });
  useApp.setState({ bots: { example: bot }, historicalBots: {}, threads: {}, threadData: {}, toast: null });
  host = document.createElement("main"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); window.getSelection()?.removeAllRanges(); document.body.replaceChildren(); mock.restoreAll(); });

for (const kind of ["user", "bot"]) test(`${kind} message Copy uses its displayed text and confirms success`, async () => {
  const text = "  Original **formatting**\n\nSecond paragraph  \n";
  await render(kind, text); await click(button("Message actions")); await click(button("Copy message"));
  assert.deepEqual(copied, [kind === "user" ? text : "Original formatting\nSecond paragraph"]);
  assert.match(document.querySelector('[role="status"]').textContent, /Message copied/);
  assert.equal(document.activeElement, button("Message actions"));
});

test("message context menu offers Copy and Escape restores focus without changing chat text", async () => {
  await render("bot", "A message to copy");
  const event = await contextMenu(host.querySelector(".bubble"));
  assert.equal(event.defaultPrevented, true);
  assert.ok(document.querySelector('[role="menu"]'));
  assert.equal(document.activeElement, button("Copy message"));
  await act(async () => window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  assert.equal(document.querySelector('[role="menu"]'), null);
  assert.equal(document.activeElement, button("Message actions"));
  assert.match(host.textContent, /A message to copy/);
  assert.deepEqual(copied, []);
});

test("copy failures show a safe retry and do not claim success", async () => {
  copy = async () => { throw new Error("Private clipboard diagnostic"); };
  await render("bot", "Retry this message"); await click(button("Message actions")); await click(button("Copy message"));
  assert.match(document.querySelector('[role="alert"]').textContent, /Couldn't copy message.*Try again/);
  assert.doesNotMatch(document.body.textContent, /Private clipboard diagnostic|Message copied/);
  copy = async (text) => { copied.push(text); };
  await click(button("Copy message")); assert.deepEqual(copied, ["Retry this message"]);
  assert.match(document.querySelector('[role="status"]').textContent, /Message copied/);
});

test("same-turn copy clicks make one clipboard write and old completions cannot confirm changed text", async () => {
  const pending = defer(); copy = (text) => { copied.push(text); return pending.promise; };
  await render("bot", "Old text"); await click(button("Message actions"));
  const target = button("Copy message"); await act(async () => { target.click(); target.click(); });
  assert.deepEqual(copied, ["Old text"]);
  await render("bot", "Replacement text"); await act(async () => pending.resolve());
  assert.doesNotMatch(document.body.textContent, /Message copied/);
  copy = async (text) => { copied.push(text); };
  await click(button("Message actions")); await click(button("Copy message"));
  assert.deepEqual(copied, ["Old text", "Replacement text"]);
});

test("touch long-press opens Copy but scrolling cancels the gesture", async () => {
  await render("user", "Touch message"); const bubble = host.querySelector(".bubble");
  await act(async () => { bubble.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, pointerType: "touch", clientX: 20, clientY: 20 })); await new Promise((resolve) => setTimeout(resolve, 550)); });
  assert.ok(button("Copy message"));
  await act(async () => window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" })));
  await act(async () => {
    bubble.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, pointerType: "touch", clientX: 20, clientY: 20 }));
    bubble.dispatchEvent(new window.PointerEvent("pointermove", { bubbles: true, pointerType: "touch", clientX: 20, clientY: 70 }));
    await new Promise((resolve) => setTimeout(resolve, 550));
  });
  assert.equal(document.querySelector('[role="menu"]'), null);
  assert.deepEqual(copied, []);
});

test("interactive message links retain their own context menu", async () => {
  await render("bot", "[Original link](https://example.test/)");
  const event = await contextMenu(host.querySelector("a"));
  assert.equal(event.defaultPrevented, false);
  assert.equal(document.querySelector('[role="menu"]'), null);
});

test("an attachment-only message offers file actions without an empty text-copy action", async () => {
  await render("user", "", [photo]);
  assert.equal(button("Message actions"), undefined);
  assert.ok(button("Open photo.png"));
  assert.ok(button("Download photo.png"));
  assert.deepEqual(copied, []);
});

for (const kind of ["user", "bot"]) test(`${kind} photo attachment opens a fresh signed preview and preserves the message`, async () => {
  await render(kind, "Keep this message mounted", [photo]);
  await click(button("Open photo.png"));
  assert.ok(document.querySelector('[role="dialog"]'));
  assert.equal(document.querySelector('[role="dialog"] img').getAttribute("src"), "/t3/assets/current-1");
  assert.deepEqual(calls[0].payload.resource, { _tag: "attachment", attachmentId: photo.id, disposition: "inline" });
  assert.deepEqual(fetches, [], "native media loads the signed URL without an extra JS prefetch");
  assert.match(host.textContent, /Keep this message mounted/);
  await click(button("Close"));
  assert.equal(document.querySelector('[role="dialog"]'), null);
  assert.match(host.textContent, /Keep this message mounted/);
});

test("file attachments preview PDFs and expose their current original file", async () => {
  fetchResponse = () => new Response("%PDF-1.4", { status: 200, headers: { "content-type": "application/pdf" } });
  await renderAttachments([file]); await click(button("Open report.pdf"));
  const frame = document.querySelector('[role="dialog"] iframe');
  assert.equal(frame.getAttribute("src"), "/t3/assets/current-1");
  // WebKit draws nothing for a PDF in a sandboxed frame.
  assert.equal(frame.hasAttribute("sandbox"), false);
  assert.equal(document.querySelector('[role="dialog"] a').getAttribute("href"), "/t3/assets/current-1");
});

test("a PDF preview that is not served as a PDF never loads in the unsandboxed frame", async () => {
  fetchResponse = () => new Response("<script>parent.x=1</script>", { status: 200, headers: { "content-type": "text/html" } });
  await renderAttachments([file]); await click(button("Open report.pdf"));
  assert.equal(document.querySelector('[role="dialog"] iframe'), null);
  assert.match(document.querySelector('[role="alert"]').textContent, /Couldn't open/);
});

test("attachment failures retry with a new signed URL and unsupported formats keep a real original-file action", async () => {
  let attempts = 0; fetchResponse = () => ++attempts === 1 ? new Response("Missing", { status: 404 }) : new Response("Binary fixture", { status: 200 });
  await renderAttachments([{ ...file, name: "archive.bin" }]); await click(button("Open archive.bin"));
  assert.match(document.querySelector('[role="alert"]').textContent, /Couldn't open/);
  await click(button("Retry"));
  assert.match(document.querySelector('[role="dialog"]').textContent, /Preview isn't available/);
  assert.equal(document.querySelector('[role="dialog"] a').getAttribute("href"), "/t3/assets/current-2");
  assert.equal(calls.length, 2);
});

test("Download uses the attachment disposition and handles signing failure with explicit retry", async () => {
  let attempts = 0; rpc = async () => { if (++attempts === 1) throw new Error("Private signing diagnostic"); return { relativeUrl: "/assets/fresh-download" }; };
  await renderAttachments([file]); await click(button("Download report.pdf"));
  assert.match(document.querySelector('[role="alert"]').textContent, /Couldn't download.*Try again/);
  assert.doesNotMatch(document.body.textContent, /Private signing diagnostic|Download started/);
  assert.deepEqual(downloads, []);
  await click(button("Download report.pdf"));
  assert.deepEqual(calls.map((call) => call.payload.resource), Array(2).fill({ _tag: "attachment", attachmentId: file.id, disposition: "attachment" }));
  assert.deepEqual(downloads, [{ href: "/t3/assets/fresh-download", name: file.name }]);
  assert.match(document.querySelector('[role="status"]').textContent, /Download started/);
});

for (const kind of ["user", "bot"]) for (const threadId of ["main", "child"]) test(`${kind} message marks its actual ${threadId} conversation unread with pending and success feedback`, async () => {
  const pending = defer(); dispatch = () => pending.promise;
  await render(kind, "Keep the original message", [], threadId); await click(button("Message actions"));
  const mark = button("Mark conversation as unread"); assert.ok(mark, "the real thread has an unread action");
  await act(async () => { mark.click(); mark.click(); });
  assert.deepEqual(commands, [{ type: "thread.mark-unread", threadId }]);
  assert.equal(mark.disabled, true);
  assert.match(document.querySelector('[role="status"]').textContent, /Marking conversation unread/);
  assert.deepEqual(useApp.getState().threads, {}, "command dispatch never invents a read watermark");
  await act(async () => pending.resolve({ sequence: 1 }));
  assert.equal(Boolean(document.querySelector('[role="menu"]')), false);
  assert.match(document.querySelector('[role="status"]').textContent, /Conversation marked as unread/);
  assert.match(host.textContent, /Keep the original message/);
  assert.equal(document.activeElement, button("Message actions"));
  assert.deepEqual(copied, []);
});

test("mark-unread failures retain the menu and offer an explicit safe retry", async () => {
  dispatch = async () => { throw new Error("Private transport diagnostic"); };
  await render("bot", "Retain this message"); await click(button("Message actions")); await click(button("Mark conversation as unread"));
  assert.match(document.querySelector('[role="alert"]').textContent, /Couldn't mark conversation as unread/);
  assert.doesNotMatch(document.body.textContent, /Private transport diagnostic|Conversation marked as unread/);
  dispatch = async () => ({ sequence: 2 });
  await click(button("Retry marking conversation as unread"));
  assert.deepEqual(commands, Array(2).fill({ type: "thread.mark-unread", threadId: "main" }));
  assert.match(document.querySelector('[role="status"]').textContent, /Conversation marked as unread/);
});

test("an old unread command cannot confirm success in a different owning thread", async () => {
  const pending = defer(); dispatch = () => pending.promise;
  await render("bot", "Same text"); await click(button("Message actions")); await click(button("Mark conversation as unread"));
  await render("bot", "Same text", [], "child"); await act(async () => pending.resolve({ sequence: 1 }));
  assert.doesNotMatch(document.body.textContent, /Conversation marked as unread/);
  dispatch = async () => ({ sequence: 2 });
  await click(button("Message actions")); await click(button("Mark conversation as unread"));
  assert.deepEqual(commands, [{ type: "thread.mark-unread", threadId: "main" }, { type: "thread.mark-unread", threadId: "child" }]);
  assert.match(document.querySelector('[role="status"]').textContent, /Conversation marked as unread/);
});

test("message menu keyboard navigation reaches Copy, Mark as unread and Select Text", async () => {
  await render("user", "Keyboard message"); await click(button("Message actions"));
  const key = async (value) => act(async () => document.activeElement.dispatchEvent(new window.KeyboardEvent("keydown", { key: value, bubbles: true })));
  const focused = () => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.textContent.trim();
  await key("ArrowDown"); assert.equal(focused(), "Select Text");
  await key("Home"); assert.equal(focused(), "Mark conversation as unread");
  await key("End"); assert.equal(focused(), "Select Text");
  await key("ArrowUp"); assert.equal(focused(), "Copy message");
});

test("the existing sidebar reports a rejected unread command instead of swallowing it", async () => {
  dispatch = async () => { throw new Error("This conversation has no completed run to mark unread."); };
  await act(async () => root.render(h(Sidebar, { wide: true })));
  await contextMenu(host.querySelector(".bot-row")); await click(button("Mark as Unread"));
  assert.deepEqual(commands, [{ type: "thread.mark-unread", threadId: "main" }]);
  assert.equal(useApp.getState().toast, "This conversation has no completed run to mark unread.");
});

test("Copy reads rendered Markdown DOM, keeps visible labels and emits math once without tool controls", async () => {
  await render("bot", "# Heading\n\nA **bold** [visible link](https://example.test/) and `inline code`.\n\n```ts\nconst value = 1;\n  console.log(value);\n```\n\nMath $\\frac{3}{4}=0.75$.");
  await click(button("Copy code"));
  await act(async () => { host.querySelector("h1").textContent = "Actual rendered heading"; });
  await click(button("Message actions")); await click(button("Copy message"));
  const plain = copied[1];
  assert.match(plain, /^Actual rendered heading\n/);
  assert.match(plain, /A bold visible link and inline code\./);
  assert.match(plain, /const value = 1;/);
  assert.match(plain, /console\.log\(value\);/);
  assert.equal(plain.split("\\frac{3}{4}=0.75").length - 1, 1);
  assert.doesNotMatch(plain, /Copy code|Code copied|Copied|Mark as unread|Select Text|```|\*\*|https:\/\/example/);
  assert.equal(document.querySelector('[inert][aria-hidden="true"]'), null, "temporary copy DOM is removed");
});

test("Select Text selects the existing rendered message and leaves the browser context menu available", async () => {
  await render("bot", "# Selection heading\n\nSome **bold** text.");
  const body = host.querySelector("[data-message-body]");
  assert.equal(window.getComputedStyle(body).userSelect, "none", "mobile long press belongs to the action sheet until selection is requested");
  await click(button("Message actions")); await click(button("Select Text"));
  const selection = window.getSelection();
  assert.equal(selection.isCollapsed, false);
  assert.equal(selection.getRangeAt(0).commonAncestorContainer === body, true);
  assert.match(selection.toString(), /Selection heading/); assert.match(selection.toString(), /Some bold text/);
  assert.equal(Boolean(document.querySelector('[role="menu"]')), false);
  assert.equal(host.querySelector(".chat-message-actions").getAttribute("data-selecting"), "true");
  assert.equal(window.getComputedStyle(body).userSelect, "text");
  assert.equal((await contextMenu(host.querySelector(".bubble"))).defaultPrevented, false);
  assert.match(document.querySelector('[role="status"]').textContent, /Message text selected/);
  await act(async () => window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  assert.equal(selection.rangeCount, 0);
  assert.equal(host.querySelector(".chat-message-actions").getAttribute("data-selecting"), "false");
  assert.equal(document.activeElement?.getAttribute("aria-label"), "Message actions");
});

test("browser Copy on an inline selection uses only selected rendered text", async () => {
  await render("bot", "Choose **this part** and leave the rest.");
  await click(button("Message actions")); await click(button("Select Text"));
  const selected = host.querySelector("strong"); const range = document.createRange(); range.selectNodeContents(selected);
  const selection = window.getSelection(); await act(async () => { selection.removeAllRanges(); selection.addRange(range); });
  const clipboardData = new window.DataTransfer();
  const event = new window.ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData });
  await act(async () => selected.dispatchEvent(event));
  assert.equal(event.defaultPrevented, true);
  assert.equal(clipboardData.getData("text/plain"), "this part");
  assert.deepEqual(copied, [], "native clipboard event has no extra full-message clipboard write");
});

test("native selection Copy also excludes code controls and duplicate KaTeX trees", async () => {
  await render("bot", "```js\nconst answer = 42;\n```\n\nAnswer $x^2$.");
  await click(button("Copy code"));
  await click(button("Message actions")); await click(button("Select Text"));
  const clipboardData = new window.DataTransfer();
  const event = new window.ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData });
  await act(async () => host.querySelector("[data-message-body]").dispatchEvent(event));
  const plain = clipboardData.getData("text/plain");
  assert.match(plain, /const answer = 42;/); assert.match(plain, /Answer x\^2\./);
  assert.doesNotMatch(plain, /Copied|Code copied|Copy code|Select Text/);
  assert.equal(plain.split("x^2").length - 1, 1);
});

test("mobile actions form a bottom sheet with supported groups and dismiss without click-through", async () => {
  await render("bot", "Mobile actions"); await click(button("Message actions"));
  const menu = document.querySelector('[role="menu"]');
  assert.equal(window.getComputedStyle(menu).bottom, "0px");
  assert.equal(window.getComputedStyle(menu).left, "0px");
  assert.equal(document.body.style.overflow, "hidden");
  assert.deepEqual([...menu.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent.trim()), ["Mark as unread", "Copy", "Select Text"]);
  assert.equal(menu.querySelectorAll('[role="group"]').length, 3);
  assert.equal(menu.querySelectorAll('[aria-label="Reactions"] button').length, 12);
  const backdrop = document.querySelector(".chat-message-action-backdrop");
  await act(async () => backdrop.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true })));
  assert.equal(Boolean(document.querySelector('[role="menu"]')), true, "the backdrop survives until its click consumes the gesture");
  await click(backdrop);
  assert.equal(Boolean(document.querySelector('[role="menu"]')), false);
  assert.equal(document.body.style.overflow, ""); assert.deepEqual(commands, []);
});

test("desktop keeps the anchored action menu and does not lock page scrolling", async () => {
  window.happyDOM.setWindowSize({ width: 1200, height: 900 });
  await render("bot", "Desktop actions"); await contextMenu(host.querySelector(".bubble"));
  const menu = document.querySelector('[role="menu"]');
  assert.equal(window.getComputedStyle(menu).left, "100px"); assert.equal(window.getComputedStyle(menu).top, "100px");
  assert.equal(window.getComputedStyle(button("Close message actions")).display, "none");
  assert.equal(document.body.style.overflow, "");
  await click(button("Copy message")); assert.deepEqual(copied, ["Desktop actions"]);
});
