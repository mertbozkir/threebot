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

// Real React DOM and the real Instructions tab; only HTTP is mocked.
const channels: MessageChannel[] = [];
globalThis.MessageChannel = class extends MessageChannel { constructor() { super(); channels.push(this); } };
const window = domWindow(new Window({ url: "http://instructions-tab.test" }));
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLTextAreaElement", "Element", "Node", "Event", "KeyboardEvent", "MouseEvent", "localStorage", "requestAnimationFrame", "cancelAnimationFrame", "IntersectionObserver"]) Object.defineProperty(globalThis, key, { configurable: true, value: window[key] });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.getComputedStyle = (element) => window.getComputedStyle(element);
const src = fileURLToPath(new URL("../src/", import.meta.url));
const bundle = await buildOnce({
  configFile: false, logLevel: "silent", define: { "process.env.NODE_ENV": '"development"' },
  plugins: [{ name: "instructions-tab-test-entry", resolveId: (id) => id.endsWith("virtual:instructions-tab-tests") ? "\0instructions-tab-tests" : undefined,
    load: (id) => id === "\0instructions-tab-tests" ? `
      export { createElement, act } from "react";
      export { createRoot } from "react-dom/client";
      export { InstructionsTab } from ${JSON.stringify(`${src}components/Instructions.tsx`)};
      export { useApp } from ${JSON.stringify(`${src}store.ts`)};` : undefined }],
  ssr: { noExternal: true }, build: { rollupOptions: { output: { inlineDynamicImports: true } }, ssr: "virtual:instructions-tab-tests", write: false },
});
const testDir = await mkdtemp(join(tmpdir(), "bot-instructions-tab-"));
const testEntry = join(testDir, "components.mjs");
await writeFile(testEntry, entryChunk(bundle).code);
const { createElement: h, act, createRoot, InstructionsTab, useApp } = await import(pathToFileURL(testEntry).href);
after(async () => { for (const channel of channels) { channel.port1.close(); channel.port2.close(); } await window.happyDOM.close(); await rm(testDir, { recursive: true }); });

const bot = { slug: "alpha", name: "Alpha", label: "Code reviewer" } as any;
const revision = (text: string) => `r${text.length}:${text.slice(-8)}`;
const baseText = "## What this Bot is for\n- Review code changes.\n";
let root, host, disk, puts;
beforeEach(() => {
  disk = { text: baseText, total: 19000 };
  puts = [];
  useApp.setState({ bots: { alpha: bot } });
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    if (init.method === "PUT") {
      const body = JSON.parse(String(init.body));
      puts.push(body);
      if (body.expectedRevision !== revision(disk.text)) {
        return new Response(JSON.stringify({ ok: false, code: "conflict", message: "The instructions changed since you opened them.", revision: revision(disk.text), text: disk.text }), { status: 409 });
      }
      disk.text = body.text;
      return new Response(JSON.stringify({ ok: true, revision: revision(body.text), bytes: body.text.length, totalBytes: disk.total - 40 + body.text.length }), { status: 200 });
    }
    assert.match(String(url), /^\/api\/instructions\?slug=alpha$/u);
    return new Response(JSON.stringify({
      path: "AGENTS.md", text: disk.text, revision: revision(disk.text), bytes: disk.text.length,
      totalBytes: disk.total, maxChars: 12000, warnAt: 24000, maxTotalBytes: 32000, managed: true,
    }), { status: 200 });
  }) as typeof fetch;
  host = document.createElement("main"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0)); });
const button = (label: string, scope: Element = host) => [...scope.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === label || candidate.textContent?.includes(label));
const dialog = () => document.querySelector('[role="dialog"]') as HTMLElement | null;
async function click(target: Element | undefined) { assert.ok(target); await act(async () => { target.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); }); await settle(); }
async function type(textarea: HTMLTextAreaElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, value);
    textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}

test("the Instructions tab shows the owner's part and saves an edit", async () => {
  await act(async () => root.render(h(InstructionsTab, { bot })));
  await settle();
  assert.match(host.textContent ?? "", /Review code changes/u);
  await click(button("Edit"));
  const modal = dialog();
  assert.ok(modal);
  const editor = modal.querySelector("textarea") as HTMLTextAreaElement;
  assert.equal(editor.value, baseText);
  await type(editor, `${editor.value}- Reproduce the bug first.\n`);
  await click(button("Save", modal));
  assert.deepEqual(puts.at(-1), { slug: "alpha", text: `${baseText}- Reproduce the bug first.\n`, expectedRevision: revision(baseText) });
  assert.equal(dialog(), null);
  assert.equal(host.querySelector("textarea"), null);
  assert.match(host.textContent ?? "", /Reproduce the bug first/u);
});

test("an edit the Bot made meanwhile is never overwritten without asking", async () => {
  await act(async () => root.render(h(InstructionsTab, { bot })));
  await settle();
  await click(button("Edit"));
  const modal = dialog();
  assert.ok(modal);
  const editor = modal.querySelector("textarea") as HTMLTextAreaElement;
  await type(editor, "- Mine\n");
  disk.text = "## What this Bot is for\n- Bot edit\n";
  await click(button("Save", modal));
  assert.match(modal.querySelector('[role="alert"]')?.textContent ?? "", /These instructions changed while you were editing/u);
  assert.equal(disk.text, "## What this Bot is for\n- Bot edit\n");

  await click(button("Load theirs", modal));
  assert.equal((modal.querySelector("textarea") as HTMLTextAreaElement).value, "## What this Bot is for\n- Bot edit\n");
});

test("an empty Instructions tab offers a written example and a way in", async () => {
  disk.text = "";
  await act(async () => root.render(h(InstructionsTab, { bot })));
  await settle();
  assert.match(host.textContent ?? "", /No instructions yet/u);
  assert.match(host.textContent ?? "", /Review code changes and tell me what blocks a merge/u);
  await click(button("Write"));
  assert.ok(dialog()?.querySelector("textarea"));
});

test("an older refresh cannot replace a newer file", async () => {
  await act(async () => root.render(h(InstructionsTab, { bot })));
  await settle();
  const pending: ((text: string) => void)[] = [];
  globalThis.fetch = (async () => await new Promise<Response>((resolve) => {
    pending.push((text) => resolve(new Response(JSON.stringify({
      path: "AGENTS.md", text, revision: revision(text), bytes: text.length,
      totalBytes: 19000, maxChars: 12000, warnAt: 24000, maxTotalBytes: 32000, managed: true,
    }), { status: 200 })));
  })) as typeof fetch;
  const refresh = () => host.querySelector('button[aria-label="Refresh instructions"]');
  await click(refresh()!);
  await click(refresh()!);
  assert.equal(pending.length, 2);
  await act(async () => { pending[1]!("## Newer\n"); });
  await settle();
  assert.match(host.textContent ?? "", /Newer/u);
  await act(async () => { pending[0]!("## Older\n"); });
  await settle();
  assert.match(host.textContent ?? "", /Newer/u);
  assert.doesNotMatch(host.textContent ?? "", /Older/u);
});

test("closing a dirty editor asks before throwing the draft away", async () => {
  await act(async () => root.render(h(InstructionsTab, { bot })));
  await settle();
  await click(button("Edit"));
  const modal = dialog();
  assert.ok(modal);
  await type(modal.querySelector("textarea") as HTMLTextAreaElement, "- Unsaved\n");
  await click(button("Cancel", modal));
  assert.match(modal.textContent ?? "", /Discard unsaved changes\?/u);
  assert.ok(dialog());
  await click(button("Keep editing", modal));
  assert.equal(dialog(), modal);
  await click(button("Cancel", modal));
  await click(button("Discard", modal));
  assert.equal(dialog(), null);
});

test("the editor has a write/preview view switch", async () => {
  await act(async () => root.render(h(InstructionsTab, { bot })));
  await settle();
  await click(button("Edit"));
  const modal = dialog();
  assert.ok(modal);
  const shell = modal.querySelector(".instructions-editor-shell") as HTMLElement;
  assert.equal(shell.dataset.view, "write");
  await click(button("Preview", modal));
  assert.equal(shell.dataset.view, "preview");
  assert.match(modal.textContent ?? "", /Review code changes/u);
  await click(button("Write", modal));
  assert.equal(shell.dataset.view, "write");
});

test("a failed load is an error state with a retry, not a crashed tab", async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: "Bot not found" }), { status: 404, headers: { "content-type": "application/json" } })) as typeof fetch;
  await act(async () => root.render(h(InstructionsTab, { bot })));
  await settle();
  assert.match(host.textContent ?? "", /Couldn't load instructions/u);
  assert.match(host.textContent ?? "", /Bot not found/u);
  assert.ok(button("Retry"));
});
