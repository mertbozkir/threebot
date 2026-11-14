import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, afterEach, beforeEach, test } from "node:test";
import { MessageChannel } from "node:worker_threads";
import { Window } from "happy-dom";
import { buildOnce, domWindow, entryChunk } from "./support.mts";

// Run the actual Composer, AttachmentPicker, React DOM and store. Only the RPC
// and upload HTTP boundaries are replaced; no shared browser or server is used.
const channels = [];
globalThis.MessageChannel = class extends MessageChannel {
  constructor() { super(); channels.push(this); }
};
const window = domWindow(new Window({ url: "http://composer.test", width: 390, height: 844 }));
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event", "MouseEvent", "KeyboardEvent", "ResizeObserver", "IntersectionObserver", "localStorage", "requestAnimationFrame", "cancelAnimationFrame"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: window[key] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
// happy-dom does not implement comma-separated media queries; use its actual
// width matcher for the app's mobile query in this phone-sized DOM.
const matchMedia = window.matchMedia.bind(window);
window.matchMedia = (query) => matchMedia(query === "(max-width: 760px), (pointer: coarse)" ? "(max-width: 760px)" : query);
const src = new URL("../src/", import.meta.url).pathname;
const bundle = await buildOnce({
  configFile: false, logLevel: "silent", define: { "process.env.NODE_ENV": '"development"' },
  plugins: [{
    name: "mobile-composer-test", resolveId: (id) => id.endsWith("virtual:mobile-composer") ? "\0mobile-composer" : undefined,
    load: (id) => id === "\0mobile-composer" ? `
      export { createElement, act } from "react";
      export { createRoot } from "react-dom/client";
      export { Composer, Chat } from ${JSON.stringify(`${src}components/Chat.tsx`)};
      export { useApp } from ${JSON.stringify(`${src}store.ts`)};
      export { t3 } from ${JSON.stringify(`${src}lib/t3.ts`)};` : undefined,
    transform: (code, id) => id === `${src}components/Chat.tsx` ? { code: `${code}\nexport { Composer };`, map: null } : undefined,
  }],
  ssr: { noExternal: true }, build: { ssr: "virtual:mobile-composer", write: false },
});
const entry = entryChunk(bundle);
assert.ok(entry);
const directory = await mkdtemp(join(tmpdir(), "bot-mobile-composer-"));
const filename = join(directory, "components.mjs");
await writeFile(filename, entry.code);
let runtime, root, host, bot, sends, uploads, createdUrls, revokedUrls, serial = 0;
const originalCreate = URL.createObjectURL, originalRevoke = URL.revokeObjectURL;
const load = () => import(`${pathToFileURL(filename).href}?instance=${serial++}`);
const deferred = <T = unknown,>() => { let resolve, reject; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
// The DOM types have no SpeechRecognition constructor; the app looks it up on window.
type SpeechWindow = typeof window & { SpeechRecognition?: new () => unknown };
function boundaries() {
  runtime.useApp.setState({ bots: { [bot.slug]: bot }, threads: { child: { id: "child", activeRunId: "active-run", modelSelection: { instanceId: "claude", model: "opus", options: [{ id: "effort", value: "medium" }] } } }, projects: {}, providers: [{
    instanceId: "claude", driver: "claudeCode", displayName: "Claude", enabled: true, status: "ready",
    models: [
      { slug: "opus", name: "Opus 5.5", capabilities: { optionDescriptors: [{ id: "effort", label: "Effort", type: "select", currentValue: "medium", options: [{ id: "medium", label: "Medium" }, { id: "high", label: "High" }] }] } },
      { slug: "sonnet", name: "Sonnet 5" },
    ],
  }] });
  runtime.t3.call = async (method, payload) => {
    assert.equal(method, "attachments.createUploadUrl");
    return { attachmentId: `uploaded-${payload.name}`, relativeUrl: `/upload/${payload.name}` };
  };
  runtime.t3.dispatch = (command) => { const result = deferred(); sends.push({ command, ...result }); return result.promise; };
  globalThis.fetch = (url, init) => { const result = deferred<Response>(); uploads.push({ url, init, ...result }); return result.promise; };
}
beforeEach(async () => {
  window.happyDOM.setWindowSize({ width: 390, height: 844 });
  localStorage.clear(); sends = []; uploads = []; createdUrls = []; revokedUrls = [];
  URL.createObjectURL = () => { const url = `blob:draft-${serial}-${createdUrls.length}`; createdUrls.push(url); return url; };
  URL.revokeObjectURL = (url) => revokedUrls.push(url);
  bot = { slug: `example-${serial}`, name: "Example", mainThreadId: `main-${serial}`, color: "teal", shape: "sphere", projectId: null };
  runtime = await load(); boundaries();
  host = document.createElement("main"); document.body.append(host); root = runtime.createRoot(host);
});
afterEach(async () => { await runtime.act(async () => root.unmount()); document.body.replaceChildren(); delete (window as SpeechWindow).SpeechRecognition; });
after(async () => {
  URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke;
  for (const channel of channels) { channel.port1.close(); channel.port2.close(); }
  await window.happyDOM.close(); await rm(directory, { recursive: true });
});
const render = async ({ threadId = "child", working = false, key = "composer" } = {}) => runtime.act(async () => root.render(runtime.createElement(runtime.Composer, { key, bot, threadId, working })));
const textarea = () => host.querySelector("textarea");
const send = () => host.querySelector('[title="Send"]');
const attachments = () => [...host.querySelectorAll(".chat-pending-attachment")];
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

const actions = () => host.querySelector('[aria-label="Composer actions"]');
const menuItems = () => [...host.querySelectorAll('[role="menuitem"]')].map((element) => element.textContent.trim());

test("the mobile writing row has no model controls and keeps the raw draft across remounts", async () => {
  await render();
  assert.equal(textarea().placeholder, "Ask Example");
  assert.equal(textarea().getAttribute("rows"), "1");
  assert.equal(host.querySelector('.composer-controls [aria-label="Opus 5.5"]'), null);
  assert.ok(host.querySelector('[title="Start voice input"]'));
  assert.equal(host.querySelector('[title="Voice call"]'), null);
  await type("  Keep my draft\nwhile choosing  ");
  await click(actions());
  assert.deepEqual(menuItems(), ["Choose File", "Take Photo", "Photo or Video"]);
  await runtime.act(async () => window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  assert.equal(host.querySelector('[role="menu"]'), null);
  assert.equal(textarea().value, "  Keep my draft\nwhile choosing  ");
  assert.equal(sends.length, 0);
  await render({ key: "remount" });
  assert.equal(textarea().value, "  Keep my draft\nwhile choosing  ");
});

test("compact controls still send the draft and stop all thread work", async () => {
  await render(); await type("  Send this\nexact thought  "); await click(send());
  assert.equal(sends.length, 1);
  assert.equal(sends[0].command.threadId, "child");
  assert.equal(sends[0].command.text, "Send this\nexact thought");
  assert.equal(textarea().value, "");
  await runtime.act(async () => sends[0].resolve({ sequence: 1 }));
  await render({ working: true });
  const stop = host.querySelector('[title="Stop"]');
  assert.ok(stop); assert.equal(send(), null);
  await click(stop);
  assert.equal(typeof sends[1].command.commandId, "string");
  const { commandId: _id, ...stopCommand } = sends[1].command;
  assert.deepEqual(stopCommand, { type: "thread.stop", threadId: "child", stopDelegatedTasks: true });
  await runtime.act(async () => sends[1].resolve({ sequence: 2 }));
});

test("attachment removal is available without a hover and removes only that file", async () => {
  await render(); await type("Keep the text"); await choose(file("one.txt"), file("two.txt"));
  await finishUpload(0); await finishUpload(1);
  const remove = host.querySelector('[title="Remove one.txt"]');
  assert.ok(remove); assert.equal(remove.hidden, false);
  await click(remove);
  assert.equal(attachments().length, 1);
  assert.ok(attachments()[0].textContent.includes("two.txt"));
  assert.equal(textarea().value, "Keep the text");
});

test("switching threads keeps each draft with its own thread", async () => {
  await render(); await type("Child draft");
  await render({ threadId: bot.mainThreadId });
  assert.equal(textarea().value, "");
  await render(); assert.equal(textarea().value, "Child draft");
});

test("the mobile mic starts real dictation only on an explicit tap", async () => {
  const recognitions = [];
  (window as SpeechWindow).SpeechRecognition = class {
    declare started: boolean;
    constructor() { recognitions.push(this); }
    start() { this.started = true; }
  };
  await render(); await click(actions());
  assert.equal(recognitions.length, 0);
  await runtime.act(async () => window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await click(host.querySelector('[title="Start voice input"]'));
  assert.equal(recognitions.length, 1); assert.equal(recognitions[0].started, true);
  assert.equal(host.querySelector('[title="Start voice input"]').getAttribute("aria-pressed"), "true");
  await runtime.act(async () => {
    recognitions[0].onresult({ results: [[{ transcript: "A spoken draft" }]] });
    recognitions[0].onend();
  });
  assert.equal(textarea().value, "A spoken draft"); assert.ok(send());
  assert.equal(sends.length, 0, "dictation creates a draft without sending it");
});

// What /t3/api/voice/status answers (the supported shapes of T3Status in src/lib/t3Speech.ts).
type FakeSpeechStatus = { supported: boolean; state: string; model: string; languages?: string[] };
function fakeT3Speech({ status = { supported: true, state: "ready", model: "Fixture model", languages: ["en", "es"] }, text = "Hola mundo", statusGate = null }: { status?: FakeSpeechStatus; text?: string; statusGate?: Promise<void> | null } = {}) {
  const calls = [], tracks = [];
  Object.defineProperty(window.navigator, "mediaDevices", { configurable: true, value: { getUserMedia: async () => {
    const track = { stopped: false, stop() { this.stopped = true; } };
    tracks.push(track);
    return { getTracks: () => [track] };
  } } });
  globalThis.MediaRecorder = class {
    state = "inactive"; mimeType = "audio/webm";
    declare ondataavailable: (event: { data: Blob }) => void; declare onstop: () => void;
    start() { this.state = "recording"; }
    stop() { this.state = "inactive"; this.ondataavailable({ data: new Blob([new Uint8Array(16)]) }); queueMicrotask(() => this.onstop()); }
  } as unknown as typeof MediaRecorder;
  window.AudioContext = class { async decodeAudioData() { return { duration: 1.5 }; } async close() {} } as unknown as typeof AudioContext;
  globalThis.OfflineAudioContext = class {
    frames: number; destination = {};
    constructor(channels, frames, rate) { calls.push({ offline: [channels, frames, rate] }); this.frames = frames; }
    createBufferSource() { return { connect() {}, start() {} }; }
    async startRendering() { const pcm = new Float32Array(this.frames).fill(0.25); pcm[0] = 1.2; pcm[1] = -1.3; return { getChannelData: () => pcm }; }
  } as unknown as typeof OfflineAudioContext;
  globalThis.fetch = async (url: string, init: RequestInit = {}) => {
    calls.push({ url, method: init.method ?? "GET", body: init.body });
    if (url === "/t3/api/voice/status") { await statusGate; return Response.json(status); }
    if (url === "/t3/api/voice/transcribe") return Response.json({ text });
    return new Response("{}", { status: 404 });
  };
  return { calls, tracks, restore() { Reflect.deleteProperty(window.navigator, "mediaDevices"); delete globalThis.MediaRecorder; delete window.AudioContext; delete globalThis.OfflineAudioContext; } };
}

test("without browser speech, a T3 Code that transcribes takes the dictation in the chosen language", async () => {
  const speech = fakeT3Speech();
  try {
    localStorage.setItem("bot.voice", JSON.stringify({ lang: "es-ES" }));
    runtime.useApp.setState({ runtimeFeatures: { ...runtime.useApp.getState().runtimeFeatures, voiceTranscription: true } });
    await render(); await type("Nota:");
    const mic = () => host.querySelector('.composer-dictate');
    await click(mic());
    assert.equal(mic().getAttribute("aria-pressed"), "true", "recording until the second tap");
    assert.equal(speech.tracks.length, 2, "the permission check and the recording each open the microphone");
    await click(mic());
    await runtime.act(async () => { for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(textarea().value, "Nota: Hola mundo");
    assert.ok(speech.tracks.every((track) => track.stopped), "the microphone is released");
    assert.deepEqual(speech.calls.find((call) => call.offline).offline, [1, 24000, 16000], "1.5 s resampled to 16 kHz mono");
    const posted = speech.calls.find((call) => call.url === "/t3/api/voice/transcribe");
    const body = posted.body, length = new DataView(body.buffer).getUint32(0, true);
    assert.equal(JSON.parse(new TextDecoder().decode(body.subarray(4, 4 + length))).speechLanguage, "es");
    assert.equal(body.byteLength - 4 - length, 24000 * 4, "Float32 PCM follows the options");
    const pcm = new Float32Array(body.slice(4 + length).buffer);
    assert.deepEqual([pcm[0], pcm[1], pcm[2]], [1, -1, 0.25], "overshoot is clamped to the range T3 accepts");
    assert.equal(sends.length, 0, "dictation creates a draft without sending it");
    assert.equal(mic().getAttribute("aria-pressed"), "false");
  } finally { speech.restore(); }
});

test("taps during a slow T3 start open one recording, and leaving the chat releases it", async () => {
  const gate = deferred<void>();
  const speech = fakeT3Speech({ statusGate: gate.promise });
  try {
    runtime.useApp.setState({ runtimeFeatures: { ...runtime.useApp.getState().runtimeFeatures, voiceTranscription: true } });
    await render();
    const mic = host.querySelector('.composer-dictate');
    await click(mic); await click(mic); await click(mic);
    await runtime.act(async () => { gate.resolve(); for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(speech.tracks.length, 2, "one permission check and one recording");
    assert.equal(host.querySelector('.composer-dictate').getAttribute("aria-pressed"), "true");
    await runtime.act(async () => root.unmount());
    assert.ok(speech.tracks.every((track) => track.stopped), "unmounting stops the microphone");
    root = runtime.createRoot(host);
  } finally { speech.restore(); }
});

test("leaving the chat while T3 dictation is starting never leaves the microphone on", async () => {
  const gate = deferred<void>();
  const speech = fakeT3Speech({ statusGate: gate.promise });
  try {
    runtime.useApp.setState({ runtimeFeatures: { ...runtime.useApp.getState().runtimeFeatures, voiceTranscription: true } });
    await render();
    await click(host.querySelector('.composer-dictate'));
    await runtime.act(async () => root.unmount());
    await runtime.act(async () => { gate.resolve(); for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.ok(speech.tracks.length > 0 && speech.tracks.every((track) => track.stopped), "a recording that starts after unmount is cancelled");
    root = runtime.createRoot(host);
  } finally { speech.restore(); }
});

test("browser dictation doesn't start if the chat closes while the microphone is being granted", async () => {
  const grant = deferred();
  Object.defineProperty(window.navigator, "mediaDevices", { configurable: true, value: { getUserMedia: () => grant.promise } });
  const recognitions = [];
  (window as SpeechWindow).SpeechRecognition = class { declare started: boolean; constructor() { recognitions.push(this); } start() { this.started = true; } };
  try {
    await render();
    await click(host.querySelector('.composer-dictate'));
    await runtime.act(async () => root.unmount());
    await runtime.act(async () => { grant.resolve({ getTracks: () => [] }); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(recognitions.length, 0);
    root = runtime.createRoot(host);
  } finally { Reflect.deleteProperty(window.navigator, "mediaDevices"); }
});

test("a T3 Code without a speech model leaves the browser's dictation in place", async () => {
  const speech = fakeT3Speech({ status: { supported: true, state: "missing-model", model: "None" } });
  const recognitions = [];
  (window as SpeechWindow).SpeechRecognition = class { declare started: boolean; constructor() { recognitions.push(this); } start() { this.started = true; } };
  try {
    localStorage.setItem("bot.voice", JSON.stringify({ t3: true }));
    runtime.useApp.setState({ runtimeFeatures: { ...runtime.useApp.getState().runtimeFeatures, voiceTranscription: true } });
    await render();
    await click(host.querySelector('.composer-dictate'));
    assert.equal(recognitions.length, 1); assert.equal(recognitions[0].started, true);
    assert.equal(speech.calls.some((call) => call.url === "/t3/api/voice/transcribe"), false);
  } finally { speech.restore(); }
});

test("desktop has no model controls in the writing row either", async () => {
  window.happyDOM.setWindowSize({ width: 1200, height: 900 });
  await render({ key: "desktop" });
  assert.equal(host.querySelector('.composer-controls [aria-label="Opus 5.5"]'), null);
  assert.equal(host.querySelector('.composer-controls [aria-label="Effort: Medium"]'), null);
  await click(actions());
  assert.deepEqual(menuItems(), ["Attach files"]);
});

test("full Chat keeps ordinary input and Stop while waiting, after acknowledgement, and during generation", async () => {
  runtime.t3.stream = () => ({ cancel() {}, done: Promise.resolve() });
  const shell = {
    ...runtime.useApp.getState().threads.child, title: "Example task", status: "waiting",
    lineage: { parentThreadId: bot.mainThreadId, rootThreadId: bot.mainThreadId, relationshipToParent: "subagent" },
    pendingRuntimeRequest: { id: "question", kind: "user_input", blocking: true },
  };
  const run = { id: "active-run", ordinal: 1, status: "waiting", requestedAt: "2026-01-01T00:00:00Z", modelSelection: shell.modelSelection };
  const data = { loaded: true, items: {}, requests: { question: { id: "question", kind: "user_input", status: "pending" } }, runs: { [run.id]: run } };
  runtime.useApp.setState({ threads: { child: shell }, threadData: { child: data } });
  await runtime.act(async () => root.render(runtime.createElement(runtime.Chat, { bot, threadId: "child" })));
  assert.equal(Boolean(host.querySelector('[title="Stop"]')), true, "waiting work remains stoppable");
  assert.ok(host.querySelector('[title="Start voice input"]'));
  await type("A message while the question is pending"); await click(send());
  assert.equal(sends.length, 1); assert.equal(sends[0].command.threadId, "child");
  assert.equal(sends[0].command.text, "A message while the question is pending");
  await runtime.act(async () => sends[0].resolve({ sequence: 1 }));
  assert.equal(Boolean(host.querySelector('[title="Stop"]')), true, "send acknowledgement does not complete waiting work");
  await runtime.act(async () => runtime.useApp.setState({
    threads: { child: { ...shell, pendingRuntimeRequest: null, status: "running" } },
    threadData: { child: { ...data, requests: {}, runs: { [run.id]: { ...run, status: "running" } } } },
  }));
  assert.ok(host.querySelector('[title="Stop"]'), "active generation remains interruptible");
  assert.ok(host.querySelector('[title="Start voice input"]'), "dictation stays available, as in the native composer");
  await click(host.querySelector('[title="Stop"]'));
  assert.equal(typeof sends[1].command.commandId, "string");
  const { commandId: _id, ...stopCommand } = sends[1].command;
  assert.deepEqual(stopCommand, { type: "thread.stop", threadId: "child", stopDelegatedTasks: true });
  await runtime.act(async () => sends[1].resolve({ sequence: 2 }));
  await runtime.act(async () => runtime.useApp.setState({ threadData: { child: { ...data, requests: {}, runs: { [run.id]: run } } } }));
  assert.ok(host.querySelector('[title="Stop"]'), "a waiting run without a human request remains active");
});

test("sending while working steers with no queue control and retains the draft through retry", async () => {
  await render({ working: true }); await type("Queue this small request");
  assert.equal([...host.querySelectorAll("button")].some(button => button.textContent === "Queue message"), false);
  assert.doesNotMatch(host.textContent, /Send to steer, or/);
  await click(send());
  assert.equal(sends.length, 1);
  assert.equal(sends[0].command.type, "message.dispatch");
  assert.equal(sends[0].command.deliveryIntent, "steer");
  assert.equal(textarea().value, "");
  await runtime.act(async () => sends[0].reject(new Error("connection lost")));
  assert.equal(textarea().value, "Queue this small request");
  await click(send());
  assert.equal(sends[1].command.commandId, sends[0].command.commandId);
  assert.equal(sends[1].command.messageId, sends[0].command.messageId);
  await runtime.act(async () => sends[1].resolve({ sequence: 2 }));
  assert.equal(textarea().value, "");
});

test("goal commands use separate turns even when the regular composer would Steer", async () => {
  await render({ working: true }); await type("/goal A small objective"); await click(send());
  assert.equal(sends[0].command.deliveryIntent, "auto");
  assert.equal(sends[0].command.dispatchMode.type, "queue_after_active");
  assert.equal(sends[0].command.text, "/goal A small objective");
  await runtime.act(async () => sends[0].resolve({ sequence: 1 }));
  assert.equal(textarea().value, "");
});

test("mobile Enter key does not submit, while Ctrl+Enter or desktop Enter submits", async () => {
  await render();
  await type("Mobile draft text");
  await runtime.act(async () => {
    textarea().dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  });
  assert.equal(sends.length, 0, "mobile Enter does not send");

  await runtime.act(async () => {
    textarea().dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true }));
  });
  assert.equal(sends.length, 1, "Ctrl+Enter sends the message");
  assert.equal(sends[0].command.text, "Mobile draft text");
  await runtime.act(async () => sends[0].resolve({ sequence: 1 }));
  assert.equal(textarea().value, "");

  // Desktop Enter behavior
  window.happyDOM.setWindowSize({ width: 1200, height: 900 });
  await render({ key: "desktop" });
  await type("Desktop draft text");
  await runtime.act(async () => {
    textarea().dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true }));
  });
  assert.equal(sends.length, 1, "Shift+Enter does not send");

  await runtime.act(async () => {
    textarea().dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  });
  assert.equal(sends.length, 2, "desktop Enter sends");
  assert.equal(sends[1].command.text, "Desktop draft text");
  await runtime.act(async () => sends[1].resolve({ sequence: 2 }));
  assert.equal(textarea().value, "");
});

test("a new line in a list item continues the list: Enter on mobile, Shift+Enter on desktop", async () => {
  const enter = (shiftKey = false) => runtime.act(async () => {
    textarea().selectionStart = textarea().selectionEnd = textarea().value.length;
    textarea().dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", shiftKey, bubbles: true, cancelable: true }));
  });
  await render();
  await type("- milk");
  await enter();
  assert.equal(textarea().value, "- milk\n- ");
  await enter();
  assert.equal(textarea().value, "- milk\n", "Enter on an empty item ends the list");
  assert.equal(sends.length, 0);

  window.happyDOM.setWindowSize({ width: 1200, height: 900 });
  await render({ key: "desktop-lists" });
  await type("1. First step");
  await enter(true);
  assert.equal(textarea().value, "1. First step\n2. ");
  await type("1. First step\n2. Second");
  await enter();
  assert.equal(sends.length, 1, "plain Enter still sends on desktop");
  assert.equal(sends[0].command.text, "1. First step\n2. Second", "the message is the Markdown as typed");
  await runtime.act(async () => sends[0].resolve({ sequence: 1 }));
});
