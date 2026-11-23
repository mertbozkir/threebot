import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, beforeEach, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MessageChannel } from "node:worker_threads";
import { Window } from "happy-dom";
import { buildOnce, domWindow, isModule, writeBundle } from "./support.mts";
import type { Question } from "../src/lib/runtimeRequests.ts";
import type { RuntimeRequest, TurnItem } from "../src/lib/types.ts";

const channels: MessageChannel[] = [];
globalThis.MessageChannel = class extends MessageChannel {
  constructor() { super(); channels.push(this); }
};
const window = domWindow(new Window({ url: "http://composer-question.test" }));
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event", "MouseEvent", "localStorage", "requestAnimationFrame", "cancelAnimationFrame"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: window[key] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);

const src = fileURLToPath(new URL("../src/", import.meta.url));
const chatPath = `${src}components/Chat.tsx`;
const bundle = await buildOnce({
  configFile: false, logLevel: "silent", define: { "process.env.NODE_ENV": '"development"' },
  plugins: [{
    name: "composer-question-test",
    resolveId: (id) => id.endsWith("virtual:composer-question") ? "\0composer-question" : undefined,
    load: (id) => id === "\0composer-question" ? `
      export { createElement, act } from "react";
      export { createRoot } from "react-dom/client";
      export { Composer } from ${JSON.stringify(chatPath)};
      export { QuestionCard } from ${JSON.stringify(`${src}components/Cards.tsx`)};
      export { buildEntries } from ${JSON.stringify(`${src}lib/transcript.ts`)};
      export { useApp } from ${JSON.stringify(`${src}store.ts`)};
      export { t3 } from ${JSON.stringify(`${src}lib/t3.ts`)};` : undefined,
    transform: (code, id) => isModule(id, chatPath) ? { code: `${code}\nexport { Composer };`, map: null } : undefined,
  }],
  ssr: { noExternal: true }, build: { ssr: "virtual:composer-question", write: false },
});
const directory = await mkdtemp(join(tmpdir(), "bot-composer-question-"));
const filename = await writeBundle(bundle, directory, "components.mjs");
const { act, buildEntries, Composer, createElement: h, createRoot, QuestionCard, t3, useApp } =
  await import(pathToFileURL(filename).href);

const bot = { slug: "example", name: "Example", mainThreadId: "main", color: "teal", shape: "sphere", projectId: null };
const question: Question = { id: "example", question: "Which example?", options: [{ label: "First", value: "first" }] };
const answer = "A different example";
const at = "2026-11-23T00:00:00Z";
const sent: Record<string, unknown>[] = [];
let host: HTMLElement;
let root: ReturnType<typeof createRoot>;
function ask(id: string, questions: Question[]) {
  const request: RuntimeRequest = { id, kind: "user_input", status: "pending", responseCapability: { type: "message" } };
  const item: TurnItem = {
    id: `item-${id}`, requestId: id, questions, type: "user_input_request", status: "waiting",
    threadId: bot.mainThreadId, runId: "run", ordinal: 1, title: null, parentItemId: null,
    startedAt: at, completedAt: null, updatedAt: at,
  };
  return { item, request };
}

beforeEach(() => {
  sent.length = 0;
  host = document.createElement("main");
  document.body.append(host);
  root = createRoot(host);
  useApp.setState({ bots: { [bot.slug]: bot }, threads: {}, threadData: {} });
  t3.dispatch = async (command: Record<string, unknown>) => { sent.push(command); return { sequence: 1 }; };
  t3.call = async (method: string) => {
    assert.equal(method, "attachments.createUploadUrl");
    return { attachmentId: "upload-1", relativeUrl: "/upload" };
  };
  globalThis.fetch = async () => Response.json({});
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
after(async () => {
  for (const channel of channels) { channel.port1.close(); channel.port2.close(); }
  await window.happyDOM.close();
  await rm(directory, { recursive: true });
});

async function render(...questions: ReturnType<typeof ask>[]) {
  const items = Object.fromEntries(questions.map(({ item }) => [item.id, item]));
  const requests = Object.fromEntries(questions.map(({ request }) => [request.id, request]));
  await act(async () => {
    useApp.setState({ threadData: { [bot.mainThreadId]: { items, requests, loaded: true, runs: {}, subagents: {} } } });
    const cards = buildEntries(Object.values(items), { bot, requests, botsByThread: new Map(), tasks: [] })
      .filter((entry) => entry.kind === "question")
      .map((entry) => h(QuestionCard, { key: entry.id, entry, threadId: bot.mainThreadId }));
    root.render([...cards, h(Composer, { key: "composer", bot, threadId: bot.mainThreadId, working: false })]);
  });
}

async function sendText(withAttachment = false) {
  const text = host.querySelector("textarea");
  assert.ok(text);
  await act(async () => {
    text.focus();
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set.call(text, answer);
    text.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  if (withAttachment) {
    const picker = host.querySelector<HTMLInputElement>('input[aria-label="Files"]');
    assert.ok(picker);
    const transfer = new window.DataTransfer();
    transfer.items.add(new window.File(["notes"], "notes.txt", { type: "text/plain" }));
    picker.files = transfer.files;
    await act(async () => picker.dispatchEvent(new window.Event("change", { bubbles: true })));
  }
  const send = host.querySelector<HTMLButtonElement>('[title="Send"]');
  assert.ok(send);
  assert.equal(send.disabled, false);
  await act(async () => send.click());
  assert.equal(sent.length, 1);
}

test("composer text answers the single pending custom question", async () => {
  const pending = ask("pending", [question]);
  await render(pending);
  await sendText();
  assert.deepEqual(sent.map(({ type, threadId, requestId, answers }) => ({ type, threadId, requestId, answers })), [{
    type: "runtime-request.respond", threadId: bot.mainThreadId, requestId: pending.request.id,
    answers: { [question.id]: answer },
  }]);
  assert.match(host.textContent ?? "", /Waiting for confirmation/);
  const resolved = { ...pending.request, status: "resolved" as const, answers: { [question.id]: answer } };
  await render({ item: { ...pending.item, status: "completed" }, request: resolved });
  assert.match(host.querySelector('[aria-label="Answered question"]')?.textContent ?? "", /A different example/);
  assert.equal(host.querySelector("textarea")?.value, "");
});

const fallbacks = [
  { name: "several questions", questions: [ask("multi", [question, { ...question, id: "second" }])] },
  { name: "no custom option", questions: [ask("choice-only", [{ ...question, allowCustomAnswer: false }])] },
  { name: "an attachment", questions: [ask("with-file", [question])], attachment: true },
  { name: "several pending requests", questions: [ask("first", [question]), ask("second", [question])] },
  { name: "no pending request", questions: [] },
];

for (const { name, questions, attachment } of fallbacks) {
  test(`composer sends a normal message with ${name}`, async () => {
    await render(...questions);
    await sendText(attachment);
    assert.equal(sent[0].type, "message.dispatch");
    assert.equal(sent[0].threadId, bot.mainThreadId);
    assert.equal(sent[0].text, answer);
    assert.deepEqual(sent[0].attachments, attachment ? [
      { type: "file", id: "upload-1", name: "notes.txt", mimeType: "text/plain", sizeBytes: 5 },
    ] : []);
  });
}
