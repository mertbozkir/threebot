import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { after, afterEach, beforeEach, test } from "node:test";
import { MessageChannel } from "node:worker_threads";
import { Window } from "happy-dom";
import { buildOnce, domWindow, entryChunk, isModule } from "./support.mts";

// The real room composer, the real store call and the real HTTP boundary: only T3's upload RPC and
// the gateway's room API are answered by this test.
const channels = [];
globalThis.MessageChannel = class extends MessageChannel {
  constructor() { super(); channels.push(this); }
};
const window = domWindow(new Window({ url: "http://room-composer.test", width: 390, height: 844 }));
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event", "MouseEvent", "KeyboardEvent", "localStorage", "requestAnimationFrame", "cancelAnimationFrame"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: window[key] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
const matchMedia = window.matchMedia.bind(window);
window.matchMedia = (query) => matchMedia(query === "(max-width: 760px), (pointer: coarse)" ? "(max-width: 760px)" : query);

const src = fileURLToPath(new URL("../src/", import.meta.url));
const roomView = `${src}components/RoomView.tsx`;
const bundle = await buildOnce({
  configFile: false, logLevel: "silent", define: { "process.env.NODE_ENV": '"development"' },
  plugins: [{
    name: "room-composer-test",
    resolveId: (id) => id.endsWith("virtual:room-composer") ? "\0room-composer" : undefined,
    load: (id) => id === "\0room-composer" ? `
      export { createElement, act } from "react";
      export { createRoot } from "react-dom/client";
      export { RoomComposer } from ${JSON.stringify(roomView)};
      export { useApp } from ${JSON.stringify(`${src}store.ts`)};
      export { t3 } from ${JSON.stringify(`${src}lib/t3.ts`)};
      export { readRoomDraft } from ${JSON.stringify(`${src}lib/roomDrafts.ts`)};` : undefined,
    transform: (code, id) => isModule(id, roomView) ? { code: `${code}\nexport { RoomComposer };`, map: null } : undefined,
  }],
  ssr: { noExternal: true }, build: { ssr: "virtual:room-composer", write: false },
});
const entry = entryChunk(bundle);
assert.ok(entry);
const directory = await mkdtemp(join(tmpdir(), "bot-room-composer-"));
const filename = join(directory, "room.mjs");
await writeFile(filename, entry.code);
// One module instance: a second import would bring its own copy of React and break hooks.
const loaded = import(pathToFileURL(filename).href);
let runtime, root, host, requests, uploads, serial = 0;
const originalCreate = URL.createObjectURL, originalRevoke = URL.revokeObjectURL;
const members = [
  { slug: "alpha", name: "Alpha", label: "", color: "teal", shape: "sphere", avatarImage: null, threadId: "thread-alpha", status: "ready", model: null, runtimeMode: "auto", lastTurnAt: null },
  { slug: "beta", name: "Beta", label: "", color: "violet", shape: "blob", avatarImage: null, threadId: "thread-beta", status: "ready", model: null, runtimeMode: "auto", lastTurnAt: null },
];
const props = { roomId: "room-1", members, mentionPolicy: "anywhere", lead: "alpha", defaultResponder: "lead", running: false, stopping: false, onStop() {} };

const deferred = <T = unknown,>() => { let resolve!: (value: T) => void; let reject!: (reason?: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const file = (name = "photo.png") => new window.File(["data"], name, { type: "image/png" });
const composerActions = () => host.querySelector('[aria-label="Composer actions"]');
const menuItem = (label) => [...host.querySelectorAll('[role="menuitem"]')].find((element) => element.textContent.trim() === label);
const pending = () => host.querySelectorAll(".chat-pending-attachment");
const send = () => host.querySelector('[aria-label="Send"]');
const textarea = () => host.querySelector("textarea");
const click = async (element) => runtime.act(async () => { element.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); });
const type = async (value) => runtime.act(async () => {
  const element = textarea();
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
  setter.call(element, value);
  element.dispatchEvent(new window.Event("input", { bubbles: true }));
});
const choose = async (name = "photo.png") => {
  await click(composerActions());
  await click(menuItem("Choose File"));
  const input = host.querySelector('input[aria-label="Files"]');
  const transfer = new window.DataTransfer(); transfer.items.add(file(name));
  await runtime.act(async () => { input.files = transfer.files; input.dispatchEvent(new window.Event("change", { bubbles: true })); });
};
const finishUpload = async (index = 0) => {
  const upload = uploads[index];
  await runtime.act(async () => upload.resolve(new Response("", { status: 200 })));
  await runtime.act(async () => {});
};

beforeEach(async () => {
  localStorage.clear();
  requests = []; uploads = [];
  // happy-dom's File is not a Node Blob, so the preview URL is stubbed like the chat tests do.
  URL.createObjectURL = () => `blob:room-${serial}-${uploads.length}`;
  URL.revokeObjectURL = () => {};
  runtime = await loaded;
  runtime.t3.stream = () => ({ cancel() {}, done: Promise.resolve(), live: () => false });
  runtime.t3.call = async (method, payload) => {
    assert.equal(method, "attachments.createUploadUrl");
    return { attachmentId: `uploaded-${payload.name}`, relativeUrl: `/upload/${payload.name}` };
  };
  globalThis.fetch = (input: any, init?: any): Promise<Response> => {
    const url = String(input);
    if (url.startsWith("/t3/upload/")) { const result = deferred<Response>(); uploads.push({ url, init, ...result }); return result.promise; }
    if (url.endsWith("/reset")) {
      const result = deferred<Response>();
      requests.push({ url: String(url), init, ...result });
      return result.promise;
    }
    // The gateway's other room routes are irrelevant here; a failed poll is what the store expects.
    if (!url.endsWith("/messages")) return Promise.resolve(new Response("{}", { status: 500 }));
    const result = deferred<Response>();
    requests.push({ url, init, ...result });
    return result.promise;
  };
  host = document.createElement("main");
  document.body.append(host);
  root = runtime.createRoot(host);
});
afterEach(async () => { await runtime.act(async () => root.unmount()); document.body.replaceChildren(); });
after(async () => {
  URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke;
  for (const channel of channels) { channel.port1.close(); channel.port2.close(); }
  await window.happyDOM.close(); await rm(directory, { recursive: true });
});

const mount = async () => {
  const { RoomComposer } = await loaded;
  await runtime.act(async () => root.render(runtime.createElement(RoomComposer, props)));
};

test("a draft keeps a file whose upload was interrupted", async () => {
  localStorage.setItem("threebot.room.draft.room-1", JSON.stringify({
    text: "Hola",
    attachments: [],
    uploading: [{ type: "image", id: "u1", name: "foto.png", mimeType: "image/png", sizeBytes: 4 }],
  }));
  const draft = runtime.readRoomDraft("room-1");
  assert.equal(draft.text, "Hola");
  assert.equal(draft.uploading.length, 1);
  assert.equal(draft.uploading[0].name, "foto.png");
});

test("an empty composer has no attachment strip", async () => {
  await mount();
  assert.equal(host.querySelector(".composer-pending"), null, "the empty strip is not rendered");
  await choose();
  assert.ok(host.querySelector(".composer-pending"), "the strip appears with a pending file");
});

test("a file can be sent on its own, and the room message carries its metadata", async () => {
  await mount();
  assert.equal(send(), null, "no send button while there is nothing to send");
  await choose();
  assert.equal(pending().length, 1, "the chip shows while it uploads");
  assert.equal(send().disabled, true, "an unfinished upload cannot be sent");
  await finishUpload();
  assert.ok(send(), "a ready file offers Send without text");
  await click(send());
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/api/rooms/room-1/messages");
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    text: "", mentions: [], replyTo: null,
    attachments: [{ type: "image", id: "uploaded-photo.png", name: "photo.png", mimeType: "image/png", sizeBytes: 4 }],
  });
  await runtime.act(async () => requests[0].resolve(Response.json({ turn: { id: "t1" } })));
  assert.equal(pending().length, 0, "the composer empties after the send");
  assert.equal(textarea().value, "");
});

test("start over sits in the composer menu, asks first and keeps the draft", async () => {
  await mount();
  await type("Hola");
  await choose();
  await finishUpload();
  await click(composerActions());
  await click(menuItem("Start over"));
  const confirm = host.querySelector('[role="group"][aria-label="Start over"]');
  assert.ok(confirm, "the confirmation replaces the menu");
  assert.match(confirm.textContent, /fresh session/);
  await click([...confirm.querySelectorAll("button")].find((button) => button.textContent.trim() === "Start over"));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/api/rooms/room-1/reset");
  assert.equal(requests[0].init.method, "POST");
  await runtime.act(async () => requests[0].resolve(Response.json({ room: { id: "room-1" } })));
  assert.equal(textarea().value, "Hola", "unsent text is not part of the conversation being cleared");
  assert.equal(pending().length, 1, "a chosen file is still there to send into the new session");
  assert.equal(host.querySelector('[role="group"][aria-label="Start over"]'), null);
});

test("the menu takes focus on its first item, moves with arrows and returns it to the plus", async () => {
  await mount();
  await click(composerActions());
  const items = () => [...host.querySelectorAll('[role="menuitem"]')];
  assert.equal(document.activeElement, items()[0], "a menu opens on its first item");
  await runtime.act(async () => {
    items()[0].dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  });
  assert.equal(document.activeElement, items()[1], "ArrowDown moves to the next action");
  await runtime.act(async () => {
    items()[1].dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  assert.equal(host.querySelector('[role="menu"]'), null, "Escape closes the menu");
  assert.equal(document.activeElement, composerActions(), "and the plus holds focus again");
});

test("changing the room closes the composer menu", async () => {
  await mount();
  await click(composerActions());
  assert.ok(host.querySelector('[role="menu"]'));
  await runtime.act(async () => {
    const { RoomComposer } = await loaded;
    root.render(runtime.createElement(RoomComposer, { ...props, roomId: "room-2" }));
  });
  assert.equal(host.querySelector('[role="menu"]'), null, "the menu does not follow the composer to another room");
});

test("cancel on the reset question gives the plus its focus back", async () => {
  await mount();
  await click(composerActions());
  await click(menuItem("Start over"));
  const confirm = host.querySelector('[role="group"][aria-label="Start over"]');
  const cancel = [...confirm.querySelectorAll("button")].find((button) => button.textContent.trim() === "Cancel");
  assert.equal(document.activeElement, cancel, "the calm answer holds focus, not the reset");
  await click(cancel);
  assert.equal(host.querySelector('[role="group"][aria-label="Start over"]'), null);
  assert.equal(document.activeElement, composerActions());
});

test("a pending file is named in its picture and in its remove button", async () => {
  await mount();
  await choose("informe.pdf");
  assert.equal(host.querySelector(".chat-pending-attachment img").getAttribute("alt"), "informe.pdf");
  assert.equal(host.querySelector(".chat-pending-attachment button").getAttribute("aria-label"), "Remove informe.pdf");
});

test("a removed file is not sent, and text alone still sends", async () => {
  await mount();
  await choose();
  await finishUpload();
  await click(host.querySelector(".chat-pending-attachment button"));
  assert.equal(pending().length, 0);
  assert.equal(send(), null);
  await type("Hola");
  await click(send());
  assert.equal(requests.length, 1);
  assert.deepEqual(JSON.parse(requests[0].init.body), { text: "Hola", mentions: [], replyTo: null, attachments: [] });
});

test("the draft keeps its text and its uploaded files across a remount", async () => {
  await mount();
  await type("Pendiente");
  await choose("informe.pdf");
  await finishUpload();
  await runtime.act(async () => root.unmount());
  host.replaceChildren();
  root = runtime.createRoot(host);
  await mount();
  assert.equal(textarea().value, "Pendiente");
  assert.equal(pending().length, 1, "the file survives without its blob preview");
});
