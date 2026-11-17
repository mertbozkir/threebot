import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, afterEach, beforeEach, test } from "node:test";
import { MessageChannel } from "node:worker_threads";
import { Window } from "happy-dom";
import { buildOnce, domWindow, entryChunk, isModule } from "./support.mts";

// Real React DOM, store and section; only HTTP is mocked.
const channels: MessageChannel[] = [];
globalThis.MessageChannel = class extends MessageChannel { constructor() { super(); channels.push(this); } };
const window = domWindow(new Window({ url: "http://connected-apps.test" }));
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event", "MouseEvent", "localStorage", "requestAnimationFrame", "cancelAnimationFrame", "IntersectionObserver"]) Object.defineProperty(globalThis, key, { configurable: true, value: window[key] });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.getComputedStyle = (element) => window.getComputedStyle(element);
const src = fileURLToPath(new URL("../src/", import.meta.url));
const bundle = await buildOnce({
  configFile: false, logLevel: "silent", define: { "process.env.NODE_ENV": '"development"' },
  plugins: [{ name: "connected-apps-test-entry", resolveId: (id) => id.endsWith("virtual:connected-apps-tests") ? "\0connected-apps-tests" : undefined,
    load: (id) => id === "\0connected-apps-tests" ? `
      export { createElement, act } from "react";
      export { createRoot } from "react-dom/client";
      export { ConnectedAppsSection } from ${JSON.stringify(`${src}components/Details.tsx`)};
      export { useApp } from ${JSON.stringify(`${src}store.ts`)};` : undefined,
    transform: (code, id) => isModule(id, `${src}components/Details.tsx`) ? { code: `${code}\nexport { ConnectedAppsSection };`, map: null } : undefined }],
  ssr: { noExternal: true }, build: { ssr: "virtual:connected-apps-tests", write: false, rollupOptions: { output: { inlineDynamicImports: true } } },
});
const testDir = await mkdtemp(join(tmpdir(), "bot-connected-apps-"));
const testEntry = join(testDir, "components.mjs");
await writeFile(testEntry, entryChunk(bundle).code);
const { createElement: h, act, createRoot, ConnectedAppsSection, useApp } = await import(pathToFileURL(testEntry).href);
after(async () => { for (const channel of channels) { channel.port1.close(); channel.port2.close(); } await window.happyDOM.close(); await rm(testDir, { recursive: true }); });

const bot = { slug: "alpha", name: "Alpha", mainThreadId: "t-alpha", executorApproval: "automatic" };
const deferred = () => Promise.withResolvers<void>();
let root, host, saved, hold;
beforeEach(() => {
  saved = [];
  hold = null;
  useApp.setState({ executorUrl: "https://mcp.executor.sh/org/workspace/mcp", bots: { alpha: bot } });
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    if (String(url) === "/api/bots/alpha" && init.method === "PUT") {
      const patch = JSON.parse(String(init.body));
      saved.push(patch);
      if (hold) await hold.promise;
      return new Response(JSON.stringify({ ...bot, ...patch }), { status: 200 });
    }
    if (String(url) === "/api/bots") {
      const latest = saved.at(-1) ?? {};
      return new Response(JSON.stringify({ bots: [{ ...bot, ...latest }] }), { status: 200 });
    }
    throw new Error(`unexpected ${init.method ?? "GET"} ${url}`);
  }) as typeof fetch;
  host = document.createElement("main"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0)); });
const render = async (value = bot) => { await act(async () => root.render(h(ConnectedAppsSection, { bot: value }))); await settle(); };
const control = () => host.querySelector('[role="switch"]') as HTMLButtonElement;

test("the approval switch takes its name from the visible title, not a second label", async () => {
  await render();
  const switchControl = control();
  assert.equal(switchControl.getAttribute("aria-label"), null);
  const title = document.getElementById(switchControl.getAttribute("aria-labelledby") ?? "");
  assert.equal(title?.textContent, "Automatic app approval");
  const note = document.getElementById(switchControl.getAttribute("aria-describedby") ?? "");
  assert.equal(note?.textContent, "Applies to new sessions. T3 permissions still decide what this Bot may run.");
  assert.equal(switchControl.getAttribute("aria-checked"), "true");
  assert.match(host.textContent ?? "", /without asking/u);
});

test("the switch is disabled and marked busy until the save comes back", async () => {
  await render();
  hold = deferred();
  const switchControl = control();
  await act(async () => { switchControl.click(); });
  assert.equal(saved.at(-1)?.executorApproval, "ask");
  assert.equal(control().disabled, true);
  assert.equal(control().getAttribute("aria-busy"), "true");

  hold.resolve();
  await settle();
  assert.equal(control().disabled, false);
  assert.equal(control().getAttribute("aria-busy"), null);

  await render({ ...bot, executorApproval: "ask" });
  assert.equal(control().getAttribute("aria-checked"), "false");
  assert.match(host.textContent ?? "", /asks before writing/u);
});
