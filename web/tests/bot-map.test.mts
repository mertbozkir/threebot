import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MessageChannel } from "node:worker_threads";
import { Window } from "happy-dom";
import { buildOnce, domWindow, entryChunk } from "./support.mts";

const channels: MessageChannel[] = [];
globalThis.MessageChannel = class extends MessageChannel {
  constructor() { super(); channels.push(this); }
};
const window = domWindow(new Window({ url: "http://bot-map.test" }));
for (const key of ["window", "document", "navigator", "localStorage", "HTMLElement", "Event", "ResizeObserver"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: window[key] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.fetch = async () => new Response("{}", { status: 404 });

const src = fileURLToPath(new URL("../src/", import.meta.url));
const bundle = await buildOnce({
  configFile: false, logLevel: "silent", define: { "process.env.NODE_ENV": '"development"' },
  plugins: [{
    name: "bot-map-test",
    resolveId: (id) => id.endsWith("virtual:bot-map") ? "\0bot-map" : undefined,
    load: (id) => id === "\0bot-map" ? `
      export { createElement, act } from "react";
      export { createRoot } from "react-dom/client";
      export { Sidebar } from ${JSON.stringify(join(src, "components/Sidebar.tsx"))};
      export { useApp } from ${JSON.stringify(join(src, "store.ts"))};` : undefined,
  }],
  ssr: { noExternal: true }, build: { ssr: "virtual:bot-map", write: false },
});
const directory = await mkdtemp(join(tmpdir(), "bot-map-test-"));
const file = join(directory, "sidebar.mjs");
await writeFile(file, entryChunk(bundle).code);
const { createElement: h, act, createRoot, Sidebar, useApp } = await import(pathToFileURL(file).href);
after(async () => {
  for (const channel of channels) { channel.port1.close(); channel.port2.close(); }
  await window.happyDOM.close();
  await rm(directory, { recursive: true });
});

test("sidebar opens Map with Projects off or on", async () => {
  const root = createRoot(document.body);
  try {
    for (const projects of [false, true]) {
      await act(async () => {
        useApp.setState({ settings: { sections: [], beta: { projects } }, page: null });
        root.render(h(Sidebar));
      });
      const map = document.querySelector<HTMLButtonElement>('button[aria-label="Map"]');
      assert.ok(map, `Map entry with Projects ${projects ? "on" : "off"}`);
      assert.equal(Boolean(document.querySelector(".projects-nav")), projects);
      assert.equal(map.textContent?.trim(), projects ? "" : "Map");
      if (projects) assert.equal(map.previousElementSibling?.classList.contains("projects-nav"), true);
      await act(async () => map.click());
      assert.equal(useApp.getState().page, "map");
      assert.equal(map.getAttribute("aria-current"), "page");
    }
  } finally {
    await act(async () => root.unmount());
  }
});
