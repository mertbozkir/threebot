import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, afterEach, beforeEach, test } from "node:test";
import { MessageChannel } from "node:worker_threads";
import { Window } from "happy-dom";
import { buildOnce, domWindow, entryChunk, isModule } from "./support.mts";
import { fileURLToPath } from "node:url";

// Run the actual Composer, AttachmentPicker, React DOM and store. Only the RPC
// and upload HTTP boundaries are replaced; no shared browser or server is used.
const channels = [];
globalThis.MessageChannel = class extends MessageChannel {
  constructor() { super(); channels.push(this); }
};
const window = domWindow(new Window({ url: "http://drafts.test", width: 390, height: 844 }));
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event", "MouseEvent", "KeyboardEvent", "localStorage", "requestAnimationFrame", "cancelAnimationFrame"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: window[key] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
// happy-dom does not implement comma-separated media queries; use its actual
// width matcher for the app's mobile query in this phone-sized DOM.
const matchMedia = window.matchMedia.bind(window);
window.matchMedia = (query) => matchMedia(query === "(max-width: 760px), (pointer: coarse)" ? "(max-width: 760px)" : query);
const src = fileURLToPath(new URL("../src/", import.meta.url));
const bundle = await buildOnce({
  configFile: false, logLevel: "silent", define: { "process.env.NODE_ENV": '"development"' },
  plugins: [{
    name: "chat-drafts-test", resolveId: (id) => id.endsWith("virtual:chat-drafts") ? "\0chat-drafts" : undefined,
    load: (id) => id === "\0chat-drafts" ? `
      export { createElement, act } from "react";
      export { createRoot } from "react-dom/client";
      export { Composer } from ${JSON.stringify(`${src}components/Chat.tsx`)};
      export { Modal } from ${JSON.stringify(`${src}components/ui.tsx`)};
      export { useApp } from ${JSON.stringify(`${src}store.ts`)};
      export { t3, T3RpcError } from ${JSON.stringify(`${src}lib/t3.ts`)};
      export { chatDraft } from ${JSON.stringify(`${src}lib/chatDrafts.ts`)};` : undefined,
    transform: (code, id) => isModule(id, `${src}components/Chat.tsx`) ? { code: `${code}\nexport { Composer };`, map: null } : undefined,
  }],
  ssr: { noExternal: true }, build: { rollupOptions: { output: { inlineDynamicImports: true } }, ssr: "virtual:chat-drafts", write: false },
});
const entry = entryChunk(bundle);
assert.ok(entry);
const directory = await mkdtemp(join(tmpdir(), "bot-chat-drafts-"));
const filename = join(directory, "components.mjs");
await writeFile(filename, entry.code);
let runtime, root, host, bot, sends, uploads, createdUrls, revokedUrls, serial = 0;
const originalCreate = URL.createObjectURL, originalRevoke = URL.revokeObjectURL;
const load = () => import(`${pathToFileURL(filename).href}?instance=${serial++}`);
const deferred = <T = unknown,>() => { let resolve, reject; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function boundaries() {
  runtime.useApp.setState({ bots: { [bot.slug]: bot }, threads: {}, projects: {}, providers: [] });
  runtime.t3.stream = () => ({cancel(){},done:Promise.resolve()});
  runtime.t3.call = async (method, payload) => {
    assert.equal(method, "attachments.createUploadUrl");
    return { attachmentId: `uploaded-${payload.name}`, relativeUrl: `/upload/${payload.name}` };
  };
  runtime.t3.dispatch = (command) => { const result = deferred(); sends.push({ command, ...result }); return result.promise; };
  globalThis.fetch = (url, init) => { const result = deferred<Response>(); uploads.push({ url, init, ...result }); return result.promise; };
}
beforeEach(async () => {
  localStorage.clear(); sends = []; uploads = []; createdUrls = []; revokedUrls = [];
  URL.createObjectURL = () => { const url = `blob:draft-${serial}-${createdUrls.length}`; createdUrls.push(url); return url; };
  URL.revokeObjectURL = (url) => revokedUrls.push(url);
  bot = { slug: `example-${serial}`, name: "Example", mainThreadId: `main-${serial}`, color: "teal", shape: "sphere", projectId: null };
  runtime = await load(); boundaries();
  host = document.createElement("main"); document.body.append(host); root = runtime.createRoot(host);
});
afterEach(async () => { await runtime.act(async () => root.unmount()); document.body.replaceChildren(); });
after(async () => {
  URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke;
  for (const channel of channels) { channel.port1.close(); channel.port2.close(); }
  await window.happyDOM.close(); await rm(directory, { recursive: true });
});
const render = async (threadId = bot.mainThreadId, { keyed = false, working = false } = {}) => runtime.act(async () => root.render([runtime.createElement(runtime.Composer, { key: keyed ? threadId : "composer", bot, threadId, working })]));
const textarea = () => host.querySelector("textarea");
const send = () => host.querySelector('[title="Send"]');
const attachments = () => [...host.querySelectorAll(".chat-pending-attachment")];
// The remove button is named after its file, so a screen reader can tell two pictures apart.
const remove = (chip) => chip.querySelector('[aria-label^="Remove "]');
const click = async (element) => { assert.ok(element, "control exists"); await runtime.act(async () => element.click()); };
const type = async (value) => runtime.act(async () => {
  const element = textarea();
  element.dispatchEvent(new window.Event("pointerdown", { bubbles: true })); element.focus();
  Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set.call(element, value);
  element.dispatchEvent(new window.Event("input", { bubbles: true }));
});
const choose = async (...files) => runtime.act(async () => {
  const input = host.querySelector('input[aria-label="Files"]');
  const transfer = new window.DataTransfer(); files.forEach((file) => transfer.items.add(file)); input.files = transfer.files;
  input.dispatchEvent(new window.Event("change", { bubbles: true }));
});
const file = (name = "note.txt", type = "text/plain") => new window.File(["generic content"], name, { type });
const finishUpload = async (index = 0) => runtime.act(async () => uploads[index].resolve(Response.json({})));
const rejectSend = async (index = 0) => runtime.act(async () => sends[index].reject(new Error("Offline")));

test("mobile click-only activation recovers the idle read-only composer after remount", async () => {
  await render();
  assert.equal(textarea().disabled, false);
  assert.equal(textarea().readOnly, true);
  // Accessibility activation can deliver click without a preceding pointerdown.
  await click(textarea());
  assert.equal(textarea().readOnly, false);
  assert.equal(document.activeElement, textarea());
  await type("Synthetic local message");
  await click(send());
  assert.equal(sends.length, 1);
  await runtime.act(async () => sends[0].resolve({ sequence: 1 }));
  await render("child", { keyed: true });
  await render(bot.mainThreadId, { keyed: true });
  await click(textarea());
  assert.equal(textarea().readOnly, false);
  assert.equal(document.activeElement, textarea());
});

for (const keyed of [false, true]) test(`text and attachments survive switching and returning (${keyed ? "remount" : "same mount"})`, async () => {
  await render(bot.mainThreadId, { keyed }); await type("Main draft"); await choose(file()); await finishUpload();
  assert.equal(attachments().length, 1);
  await render("child", { keyed }); assert.equal(textarea().value, ""); assert.equal(attachments().length, 0);
  await type("Child draft"); await render(bot.mainThreadId, { keyed });
  assert.equal(textarea().value, "Main draft"); assert.equal(attachments().length, 1, "uploaded main attachment must survive navigation");
  await render("child", { keyed }); assert.equal(textarea().value, "Child draft");
});

test("a rejected old-thread send cannot replace the selected thread's draft", async () => {
  await render(); await type("Original main send"); await choose(file()); await finishUpload(); await click(send());
  await render("child"); await type("New child draft"); await rejectSend();
  assert.equal(textarea().value, "New child draft"); assert.equal(attachments().length, 0);
  await render(); assert.equal(textarea().value, "Original main send"); assert.equal(attachments().length, 1);
});

test("a rejected send retains newer edits and offers the exact failed payload separately", async () => {
  await render(); await type("  Original raw text\n"); await choose(file()); await finishUpload(); await click(send());
  await type("A newer draft"); await rejectSend();
  assert.equal(textarea().value, "A newer draft", "failure must never overwrite a newer edit");
  const recovery = host.querySelector('[aria-label="Unsent message"]');
  assert.ok(recovery, "the original payload remains available for recovery");
  assert.ok(recovery.textContent.includes("  Original raw text\n")); assert.ok(recovery.textContent.includes("note.txt"));
  await click(recovery.querySelector('[aria-label="Retry failed message"]'));
  assert.equal(textarea().value, "A newer draft"); assert.equal(sends.length, 2);
  assert.equal(sends[1].command.text, "Original raw text");
  assert.deepEqual(sends[1].command.attachments, sends[0].command.attachments);
  await runtime.act(async () => sends[1].resolve({ sequence: 1 }));
});

test("sequential selection reserves every file for its originating thread", async () => {
  await render(); await choose(file("one.txt"), file("two.txt"));
  await render("child"); await type("Child text"); await finishUpload(0);
  assert.equal(uploads.length, 2); assert.equal(attachments().length, 0, "the next queued file must not appear in the selected child");
  await finishUpload(1); await render(); assert.equal(attachments().length, 2);
  await render("child"); assert.equal(textarea().value, "Child text"); assert.equal(attachments().length, 0);
});

test("a reply sends its quote, shows a chip, and a failed send restores both without raw markup", async () => {
  await render();
  await runtime.act(async () => runtime.chatDraft(bot, bot.mainThreadId).setReply("Quoted message"));
  assert.match(host.querySelector(".composer-reply").textContent, /Quoted message/);
  assert.equal(host.querySelector(".composer-controls").getAttribute("data-expanded"), "true");
  await type("My answer"); await click(send());
  assert.equal(sends[0].command.text, "<reply-context>\nQuoted message\n</reply-context>\n\nMy answer");
  assert.equal(host.querySelector(".composer-reply"), null, "the chip clears once sending starts");
  await rejectSend();
  assert.equal(textarea().value, "My answer");
  assert.match(host.querySelector(".composer-reply").textContent, /Quoted message/);
  await click(host.querySelector('[aria-label="Cancel reply"]'));
  assert.equal(host.querySelector(".composer-reply"), null);
  await click(send());
  assert.equal(sends[1].command.text, "My answer");
});

test("same-turn duplicate send events dispatch a payload once", async () => {
  await render(); await type("Send once");
  const button = send(); await runtime.act(async () => { button.click(); button.click(); });
  assert.equal(sends.length, 1, "two clicks before React renders must claim the draft only once");
  await runtime.act(async () => sends[0].resolve({ sequence: 1 }));
});

test("pending uploads survive keyed remounts and cannot send until ready", async () => {
  await render(bot.mainThreadId, { keyed: true }); await type("With photo"); await choose(file("photo.png", "image/png"));
  const pendingUrl = attachments()[0].querySelector("img").src;
  assert.equal(send().disabled, true);
  await render("child", { keyed: true }); await render(bot.mainThreadId, { keyed: true });
  assert.equal(textarea().value, "With photo"); assert.equal(attachments()[0].querySelector("img").src, pendingUrl);
  assert.deepEqual(revokedUrls, [], "navigation must retain the owner's preview");
  await finishUpload(); assert.equal(send().disabled, false);
  const readyUrl = attachments()[0].querySelector("img").src;
  assert.notEqual(readyUrl, pendingUrl); assert.deepEqual(revokedUrls, [pendingUrl]);
  await click(send()); await runtime.act(async () => sends[0].resolve({ sequence: 1 }));
  assert.deepEqual(revokedUrls, [pendingUrl, readyUrl], "successful delivery releases its last local preview");
  assert.equal(sends[0].command.deliveryIntent, "steer"); assert.equal(sends[0].command.attachments[0].previewUrl, undefined);
});

test("removing an active upload and a queued selection never resurrects either file", async () => {
  await render(); await choose(file("active.png", "image/png"), file("queued.png", "image/png"));
  assert.equal(attachments().length, 2, "the entire selection is visible immediately"); assert.equal(uploads.length, 1);
  await click(remove(attachments()[1]));
  await click(remove(attachments()[0]));
  assert.equal(revokedUrls.length, 2); await render("child"); await finishUpload();
  assert.equal(attachments().length, 0); assert.equal(uploads.length, 1, "removed queued files are never uploaded");
  await render(); assert.equal(attachments().length, 0);
  assert.equal(createdUrls.length, 3); assert.equal(new Set(revokedUrls).size, 3); assert.equal(revokedUrls.length, 3);
});

test("upload failures clean up their owner and continue its remaining selection", async () => {
  await render(); await choose(file("failed.png", "image/png"), file("ok.txt"));
  await render("child"); await type("Keep child");
  await runtime.act(async () => uploads[0].resolve(new Response(null, { status: 503 })));
  assert.equal(uploads.length, 2); assert.equal(attachments().length, 0); assert.equal(textarea().value, "Keep child");
  await finishUpload(1); await render();
  assert.equal(attachments().length, 1); assert.match(attachments()[0].textContent, /ok.txt/); assert.equal(revokedUrls.length, 1);
});

test("failed sends restore exact whitespace and keep previews until removal", async () => {
  await render(); const original = "  A photo\n\n"; await type(original); await choose(file("photo.png", "image/png")); await finishUpload();
  const readyUrl = attachments()[0].querySelector("img").src;
  await click(send()); await render("child", { keyed: true }); await rejectSend(); await render(bot.mainThreadId, { keyed: true });
  assert.equal(textarea().value, original); assert.equal(attachments()[0].querySelector("img").src, readyUrl);
  assert.ok(!revokedUrls.includes(readyUrl));
  await click(remove(attachments()[0])); assert.ok(revokedUrls.includes(readyUrl));
});

test("failure recovery cannot replace a newer upload or an intentionally cleared draft", async () => {
  await render(); await type("Old message"); await click(send()); await choose(file("new.txt")); await rejectSend();
  assert.equal(textarea().value, ""); assert.equal(attachments().length, 1);
  const recovery = host.querySelector('[aria-label="Unsent message"]'); assert.ok(recovery);
  assert.equal(recovery.querySelector('[aria-label="Edit failed message"]').disabled, true);
  await finishUpload(); await click(remove(attachments()[0]));
  await click(recovery.querySelector('[aria-label="Edit failed message"]'));
  assert.equal(textarea().value, "Old message"); assert.equal(host.querySelector('[aria-label="Unsent message"]'), null);
  await click(send()); await type("Temporary edit"); await type(""); await rejectSend(1);
  assert.equal(textarea().value, "", "even a newer cleared draft must remain untouched");
  assert.ok(host.querySelector('[aria-label="Unsent message"]'));
});

test("retry and discard retain the newer draft and release failed attachment URLs once", async () => {
  await render(); await type("Original"); await choose(file("photo.png", "image/png")); await finishUpload();
  const readyUrl = attachments()[0].querySelector("img").src;
  await click(send()); await type("Newer"); await rejectSend();
  const retry = host.querySelector('[aria-label="Retry failed message"]'); await runtime.act(async () => { retry.click(); retry.click(); });
  assert.equal(sends.length, 2); await rejectSend(1);
  assert.equal(textarea().value, "Newer"); assert.ok(!revokedUrls.includes(readyUrl));
  await click(host.querySelector('[aria-label="Discard failed message"]'));
  assert.equal(textarea().value, "Newer"); assert.equal(host.querySelector('[aria-label="Unsent message"]'), null);
  assert.equal(revokedUrls.filter((url) => url === readyUrl).length, 1);
});

test("successful old sends cannot clear new drafts or alter another thread", async () => {
  await render(); await type("Original"); await click(send()); await type("Newer");
  assert.equal(send().disabled, true, "new draft stays editable while the first send is unresolved");
  await render("child"); await type("Child"); await click(send());
  assert.equal(sends.length, 2, "the pending lock is scoped to its own conversation");
  await runtime.act(async () => sends[0].resolve({ sequence: 1 }));
  await render(); assert.equal(textarea().value, "Newer"); assert.equal(send().disabled, false);
  await rejectSend(1); await render("child"); assert.equal(textarea().value, "Child");
});

test("legacy text keys and ready metadata survive a fresh runtime without live blob URLs", async () => {
  localStorage.setItem(`bot.draft.${bot.slug}`, "  Saved main\n"); localStorage.setItem("bot.draft.child", "Saved child");
  await render(); assert.equal(textarea().value, "  Saved main\n");
  await choose(file("photo.png", "image/png")); await finishUpload();
  await render("child"); assert.equal(textarea().value, "Saved child"); await render();
  assert.equal(localStorage.getItem(`bot.draft.${bot.slug}`), "  Saved main\n"); assert.equal(localStorage.getItem("bot.draft.child"), "Saved child");
  for (let index = 0; index < localStorage.length; index++) assert.ok(!localStorage.getItem(localStorage.key(index)).includes("blob:"));
  await runtime.act(async () => root.unmount()); runtime = await load(); boundaries(); root = runtime.createRoot(host); await render();
  assert.equal(textarea().value, "  Saved main\n"); assert.equal(attachments().length, 1); assert.match(attachments()[0].textContent, /photo.png/);
  assert.equal(attachments()[0].querySelector("img"), null, "expired document blob previews are not restored");
  await click(send()); assert.deepEqual(sends[0].command.attachments, [{ type: "image", id: "uploaded-photo.png", name: "photo.png", mimeType: "image/png", sizeBytes: 15 }]);
  await runtime.act(async () => sends[0].resolve({ sequence: 1 }));
});

test("pending File bytes are document-local while completed uploads survive reload", async () => {
  await render(); await choose(file("complete.txt")); await finishUpload(); await choose(file("pending.txt"));
  await runtime.act(async () => root.unmount()); runtime = await load(); boundaries(); root = runtime.createRoot(host); await render();
  assert.equal(attachments().length, 1); assert.match(attachments()[0].textContent, /complete.txt/); assert.doesNotMatch(host.textContent, /pending.txt/);
  await finishUpload(1); assert.equal(attachments().length, 1, "an old document's upload cannot insert a new runtime attachment");
});

test("failed payload metadata and newer text remain separate across reload", async () => {
  await render(); await type("Original"); await choose(file()); await finishUpload(); await click(send()); await type("Newer"); await rejectSend();
  await runtime.act(async () => root.unmount()); runtime = await load(); boundaries(); root = runtime.createRoot(host); await render();
  assert.equal(textarea().value, "Newer"); const recovery = host.querySelector('[aria-label="Unsent message"]'); assert.match(recovery.textContent, /Original/); assert.match(recovery.textContent, /note.txt/);
  await click(recovery.querySelector('[aria-label="Retry failed message"]')); assert.equal(sends[1].command.text, "Original"); assert.deepEqual(sends[1].command.attachments, sends[0].command.attachments);
  await runtime.act(async () => sends[1].resolve({ sequence: 1 }));
});

test("reload during an unresolved send retains its payload without automatically resending", async () => {
  await render(); await type("Original in-flight message"); await choose(file()); await finishUpload(); await click(send()); await type("Newer draft");
  const original = sends[0].command;
  assert.equal(original.commandId, original.messageId);
  await runtime.act(async () => root.unmount()); runtime = await load(); boundaries(); root = runtime.createRoot(host); await render();
  assert.equal(sends.length, 1, "reload must not automatically transmit a message");
  assert.equal(textarea().value, "Newer draft");
  const recovery = host.querySelector('[aria-label="Unsent message"]');
  assert.match(recovery.textContent, /Delivery not confirmed/); assert.match(recovery.textContent, /Original in-flight message/); assert.match(recovery.textContent, /note.txt/);
  await click(recovery.querySelector('[aria-label="Retry failed message"]'));
  assert.deepEqual(sends[1].command, original, "explicit retry reuses the exact accepted command and payload");
  await runtime.act(async () => sends[1].resolve({ sequence: 1 }));
});

test("unchanged restored drafts reuse send identity; editing creates a new message", async () => {
  await render(); await type("Original"); await click(send()); await rejectSend(); await click(send());
  assert.equal(sends[1].command.commandId, sends[0].command.commandId);
  assert.equal(sends[1].command.messageId, sends[0].command.messageId);
  await rejectSend(1); await type("Edited original"); await click(send());
  assert.notEqual(sends[2].command.commandId, sends[0].command.commandId);
  assert.equal(sends[2].command.commandId, sends[2].command.messageId);
  await runtime.act(async () => sends[2].resolve({ sequence: 1 }));
});

test("only an explicit previously-rejected receipt permits one fresh command identity", async () => {
  await render(); await type("Original"); await click(send());
  const rejected = new runtime.T3RpcError("Previously rejected", [{ _tag: "Fail", error: { _tag: "OrchestratorCommandPreviouslyRejectedError" } }]);
  await runtime.act(async () => sends[0].reject(rejected));
  assert.equal(sends.length, 2); assert.equal(sends[1].command.text, sends[0].command.text);
  assert.notEqual(sends[1].command.commandId, sends[0].command.commandId);
  await runtime.act(async () => sends[1].reject(rejected));
  assert.equal(sends.length, 2, "a repeated rejection cannot loop or repeatedly send");
  assert.equal(textarea().value, "Original");
});

test("portal focus restoration and navigation retain drafts without reopening mobile editing", async () => {
  await render(); await type("Keep text"); await choose(file()); await finishUpload();
  const element = textarea(); assert.equal(document.activeElement, element); assert.equal(element.readOnly, false);
  const composer = runtime.createElement(runtime.Composer, { key: "composer", bot, threadId: bot.mainThreadId, working: false });
  await runtime.act(async () => root.render([composer, runtime.createElement(runtime.Modal, { key: "modal", onClose() {}, title: "Example dialog" }, "Contents")]));
  await runtime.act(async () => root.render([composer]));
  assert.equal(textarea().value, "Keep text"); assert.equal(attachments().length, 1); assert.equal(textarea().readOnly, true); assert.notEqual(document.activeElement, textarea());
  await render("child", { keyed: true }); await render(bot.mainThreadId, { keyed: true });
  assert.equal(textarea().readOnly, true); assert.notEqual(document.activeElement, textarea()); assert.equal(attachments().length, 1);
  await type("Explicit tap still edits"); assert.equal(textarea().readOnly, false);
});

test("all three native picker sources keep their selected thread after the menu closes", async () => {
  await render();
  for (const [action, label, name] of [["Photo or Video", "Photo library", "library.png"], ["Take Photo", "Take photo", "camera.png"], ["Choose File", "Files", "files.txt"]]) {
    await click(host.querySelector('[aria-label="Composer actions"]'));
    await click([...host.querySelectorAll('[role="menuitem"]')].find((element) => element.textContent.trim() === action));
    assert.equal(host.querySelector('[role="menu"]'), null);
    const input = host.querySelector(`input[aria-label="${label}"]`); const transfer = new window.DataTransfer(); transfer.items.add(file(name));
    await runtime.act(async () => { input.files = transfer.files; input.dispatchEvent(new window.Event("change", { bubbles: true })); });
    await finishUpload(uploads.length - 1);
  }
  assert.equal(attachments().length, 3);
  await choose(); assert.equal(uploads.length, 3, "cancelling a picker does not alter the draft");
});

test("a native picker result remains owned by the thread that opened it", async () => {
  await render(); await click(host.querySelector('[aria-label="Composer actions"]'));
  await click([...host.querySelectorAll('[role="menuitem"]')].find((element) => element.textContent.trim() === "Choose File"));
  const input = host.querySelector('input[aria-label="Files"]');
  await render("child");
  const transfer = new window.DataTransfer(); transfer.items.add(file());
  await runtime.act(async () => { input.files = transfer.files; input.dispatchEvent(new window.Event("change", { bubbles: true })); });
  await finishUpload(); assert.equal(attachments().length, 0, "a late native result cannot populate the selected child");
  await render(); assert.equal(attachments().length, 1);
});

test("plain Stop survives drafts, sending and send acknowledgement",async()=>{
 await render(bot.mainThreadId,{working:true});
 assert.ok(host.querySelector('[aria-label="Stop"]'));
 await type('Generic message');
 assert.ok(host.querySelector('[aria-label="Stop"]')); assert.ok(send());
 await click(send());
 assert.ok(host.querySelector('[aria-label="Stop"]'),'Stop remains while sending');
 await runtime.act(async()=>sends[0].resolve({sequence:1}));
 assert.equal(textarea().value,'');
 assert.ok(host.querySelector('[aria-label="Stop"]'),'Stop remains after ACK');
 await type('Next unsent draft');
 await click(host.querySelector('[aria-label="Stop"]'));
 assert.equal(sends[1].command.type,'thread.stop'); assert.equal(sends[1].command.stopDelegatedTasks,true);
 assert.equal(textarea().value,'Next unsent draft');
 await runtime.act(async()=>sends[1].resolve({sequence:2}));
});

test("a pending runtime request still exposes Stop when the thinking indicator is idle",async()=>{
 runtime.useApp.setState({threads:{[bot.mainThreadId]:{pendingRuntimeRequest:{requestId:'generic-request'},status:'waiting'}}});
 await render();
 assert.ok(host.querySelector('[aria-label="Stop"]'));
});

test("/clear arms a fresh session only where T3 supports it, and the next send carries it once", async () => {
  const features = runtime.useApp.getState().runtimeFeatures;
  runtime.useApp.setState({ runtimeFeatures: { ...features, freshContext: false } });
  await render(); await type("/clear"); await click(send());
  assert.equal(sends.length, 0, "older T3 never receives /clear as a prompt");
  assert.equal(textarea().value, "/clear");
  assert.match(runtime.useApp.getState().toast ?? "", /newer T3 Code/);
  await runtime.act(async () => runtime.useApp.setState({ runtimeFeatures: { ...features, freshContext: true } }));
  await click(send());
  assert.equal(sends.length, 0); assert.equal(textarea().value, "");
  assert.match(host.textContent, /next message starts a fresh session/);
  await click(host.querySelector('[aria-label="Keep the current session"]'));
  assert.doesNotMatch(host.textContent, /fresh session/);
  await click(host.querySelector('[aria-label="Composer actions"]'));
  await click([...host.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent.includes("Start fresh")));
  assert.match(host.textContent, /next message starts a fresh session/);
  await type("Start over"); await click(send());
  assert.equal(sends[0].command.freshContext, true); assert.equal(sends[0].command.text, "Start over");
  await rejectSend();
  assert.match(host.textContent, /next message starts a fresh session/, "a failed fresh send restores the arm with its text");
  await click(send());
  assert.equal(sends[1].command.freshContext, true);
  await runtime.act(async () => sends[1].resolve({ sequence: 2 }));
  await type("Carry on"); await click(send());
  assert.equal("freshContext" in sends[2].command, false);
});

test("a linked machine's thread never offers a fresh session", async () => {
  runtime.useApp.setState({ runtimeFeatures: { ...runtime.useApp.getState().runtimeFeatures, freshContext: true } });
  await render("environment:remote:thread"); await type("/clear"); await click(send());
  assert.equal(sends.length, 0); assert.doesNotMatch(host.textContent, /fresh session/);
});
