import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, afterEach, beforeEach, test } from "node:test";
import { MessageChannel } from "node:worker_threads";
import { Window } from "happy-dom";
import { buildOnce, domWindow, entryChunk } from "./support.mts";
import { fileURLToPath } from "node:url";

// Real React DOM and the real Memory tab; only HTTP is mocked.
// React schedules through MessageChannel; the ports are closed at the end so the run can exit.
const channels: MessageChannel[] = [];
globalThis.MessageChannel = class extends MessageChannel { constructor() { super(); channels.push(this); } };
const window = domWindow(new Window({ url: "http://memory-tab.test" }));
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLTextAreaElement", "Element", "Node", "Event", "KeyboardEvent", "MouseEvent", "localStorage", "requestAnimationFrame", "cancelAnimationFrame", "IntersectionObserver"]) Object.defineProperty(globalThis, key, { configurable: true, value: window[key] });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.getComputedStyle = (element) => window.getComputedStyle(element);
const src = fileURLToPath(new URL("../src/", import.meta.url));
const bundle = await buildOnce({
  configFile: false, logLevel: "silent", define: { "process.env.NODE_ENV": '"development"' },
  plugins: [{ name: "memory-tab-test-entry", resolveId: (id) => id.endsWith("virtual:memory-tab-tests") ? "\0memory-tab-tests" : undefined,
    load: (id) => id === "\0memory-tab-tests" ? `
      export { createElement, act } from "react";
      export { createRoot } from "react-dom/client";
      export { MemoryTab } from ${JSON.stringify(`${src}components/Memory.tsx`)};
      export { useApp } from ${JSON.stringify(`${src}store.ts`)};` : undefined }],
  ssr: { noExternal: true }, build: { rollupOptions: { output: { inlineDynamicImports: true } }, ssr: "virtual:memory-tab-tests", write: false },
});
const testDir = await mkdtemp(join(tmpdir(), "bot-memory-tab-"));
const testEntry = join(testDir, "components.mjs");
await writeFile(testEntry, entryChunk(bundle).code);
const { createElement: h, act, createRoot, MemoryTab, useApp } = await import(pathToFileURL(testEntry).href);
after(async () => { for (const channel of channels) { channel.port1.close(); channel.port2.close(); } await window.happyDOM.close(); await rm(testDir, { recursive: true }); });

const bot = { slug: "alpha", name: "Alpha", mainThreadId: "t-alpha" };
const revision = (text: string) => `r${text.length}:${text.slice(-8)}`;
let root, host, disk, puts, tidies;
beforeEach(() => {
  useApp.setState({ tasks: [] });
  disk = { bot: "# Alpha memory\n\n## People\n- **Ana** runs payroll.\n", shared: "" };
  puts = [];
  tidies = [];
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    if (String(url) === "/api/memory/tidy") {
      const body = JSON.parse(String(init.body));
      tidies.push(body);
      return new Response(JSON.stringify({ frequency: body.frequency, task: { id: "task-1", enabled: body.frequency !== "off", threadId: null, schedule: {} } }), { status: 200 });
    }
    if (init.method === "PUT") {
      const body = JSON.parse(String(init.body));
      puts.push(body);
      const current = disk[body.scope];
      if (body.expectedRevision !== revision(current)) return new Response(JSON.stringify({ ok: false, code: "conflict", message: "Memory changed since you opened it.", revision: revision(current), text: current }), { status: 409 });
      disk[body.scope] = body.text;
      return new Response(JSON.stringify({ ok: true, revision: revision(body.text) }), { status: 200 });
    }
    assert.match(String(url), /^\/api\/memory\?slug=alpha$/u);
    return new Response(JSON.stringify({
      bot: { path: "memory/MEMORY.md", text: disk.bot, revision: revision(disk.bot) },
      shared: { path: ".botapp/shared-memory.md", text: disk.shared, revision: revision(disk.shared) },
      tidyPrompt: "Tidy your memory now.\n",
    }), { status: 200 });
  }) as typeof fetch;
  host = document.createElement("main"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0)); });
const button = (label: string, scope: Element = host) => [...scope.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === label || candidate.textContent?.includes(label));
const section = (label: string) => host.querySelector(`section[aria-label="${label}"]`);
async function click(target: Element | undefined) { assert.ok(target); await act(async () => { target.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); }); await settle(); }
async function type(textarea: HTMLTextAreaElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, value);
    textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}

test("the Memory tab shows the file as formatted Markdown and saves an edit", async () => {
  await act(async () => root.render(h(MemoryTab, { bot })));
  await settle();
  const mine = section("Alpha");
  assert.ok(mine);
  assert.equal(mine.querySelector(".memory-view h2")?.textContent, "People");
  assert.equal(mine.querySelector(".memory-view strong")?.textContent, "Ana");
  assert.match(mine.textContent ?? "", /memory\/MEMORY\.md/u);
  assert.match(section("Shared by all Bots")?.textContent ?? "", /Nothing shared yet/u);

  await click(button("Edit", mine));
  const editor = mine.querySelector("textarea") as HTMLTextAreaElement;
  assert.equal(editor.value, "# Alpha memory\n\n## People\n- **Ana** runs payroll.\n");
  await type(editor, `${editor.value}- Prefers short answers.\n`);
  await click(button("Save", mine));
  assert.deepEqual(puts.at(-1), { slug: "alpha", scope: "bot", text: "# Alpha memory\n\n## People\n- **Ana** runs payroll.\n- Prefers short answers.\n", expectedRevision: revision("# Alpha memory\n\n## People\n- **Ana** runs payroll.\n") });
  assert.equal(mine.querySelector("textarea"), null);
  assert.match(mine.querySelector(".memory-view")?.textContent ?? "", /Prefers short answers/u);
});

test("an edit the Bot made meanwhile is never overwritten without asking", async () => {
  await act(async () => root.render(h(MemoryTab, { bot })));
  await settle();
  const mine = section("Alpha")!;
  await click(button("Edit", mine));
  const editor = mine.querySelector("textarea") as HTMLTextAreaElement;
  await type(editor, "- Mine\n");
  disk.bot = "# Alpha memory\n\n- Bot edit\n";
  await click(button("Save", mine));
  assert.match(mine.querySelector('[role="alert"]')?.textContent ?? "", /Alpha changed this file while you were editing/u);
  assert.equal(disk.bot, "# Alpha memory\n\n- Bot edit\n");

  await click(button("Load theirs", mine));
  assert.equal((mine.querySelector("textarea") as HTMLTextAreaElement).value, "# Alpha memory\n\n- Bot edit\n");
  await type(mine.querySelector("textarea") as HTMLTextAreaElement, "# Alpha memory\n\n- Bot edit\n- Mine\n");
  await click(button("Save", mine));
  assert.equal(disk.bot, "# Alpha memory\n\n- Bot edit\n- Mine\n");
});

test("only one file is open in the editor at a time, so a draft is never dropped", async () => {
  await act(async () => root.render(h(MemoryTab, { bot })));
  await settle();
  await click(button("Edit", section("Alpha")!));
  await type(section("Alpha")!.querySelector("textarea") as HTMLTextAreaElement, "- Draft\n");
  const shared = section("Shared by all Bots")!;
  assert.ok([...shared.querySelectorAll("button")].every((control) => control.disabled));
  await click(button("Cancel", section("Alpha")!));
  assert.ok([...section("Shared by all Bots")!.querySelectorAll("button")].some((control) => !control.disabled));
});

test("a late reply for the previous Bot doesn't land under the next one", async () => {
  const served = globalThis.fetch;
  let releaseAlpha = () => {};
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (String(url).endsWith("slug=alpha")) await new Promise<void>((resolve) => { releaseAlpha = resolve; });
    if (String(url).endsWith("slug=beta")) return new Response(JSON.stringify({
      bot: { path: "memory/MEMORY.md", text: "# Beta memory\n\n- Beta's own fact.\n", revision: "beta" },
      shared: { path: ".botapp/shared-memory.md", text: "", revision: "s" },
    }), { status: 200 });
    return served(url, init);
  }) as typeof fetch;
  await act(async () => root.render(h(MemoryTab, { bot })));
  await act(async () => root.render(h(MemoryTab, { bot: { slug: "beta", name: "Beta", mainThreadId: "t-beta" } })));
  await settle();
  releaseAlpha();
  await settle();
  assert.match(section("Beta")?.querySelector(".memory-view")?.textContent ?? "", /Beta's own fact/u);
});

test("choosing a tidy frequency posts it and keeps the manual action", async () => {
  await act(async () => root.render(h(MemoryTab, { bot })));
  await settle();
  await click(button("Weekly"));
  assert.deepEqual(tidies, [{ slug: "alpha", frequency: "weekly" }]);
  assert.ok(button("Ask Alpha to tidy"));
});

test("the tidy frequency is one choice of three, and the routine link names its Bot", async () => {
  await act(async () => root.render(h(MemoryTab, { bot: { ...bot, projectId: "p-alpha" } })));
  await settle();
  const group = host.querySelector('[role="radiogroup"][aria-label="Tidy frequency"]');
  assert.ok(group);
  const options = [...group.querySelectorAll('[role="radio"]')];
  assert.deepEqual(options.map((option) => option.textContent), ["Off", "Weekly", "Nightly"]);
  assert.deepEqual(options.map((option) => option.getAttribute("aria-checked")), ["true", "false", "false"]);

  await act(async () => useApp.setState({ tasks: [{ id: "task-9", title: "Tidy memory", projectId: "p-alpha", enabled: true, threadId: "t-tidy", schedule: { type: "fixed_time", timeOfDay: "03:30" } }] }));
  await settle();
  const view = button("View runs");
  assert.equal(view?.getAttribute("aria-label"), "View tidy runs for Alpha");
});
