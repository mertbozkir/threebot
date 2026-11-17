import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, afterEach, beforeEach, test } from "node:test";
import { MessageChannel } from "node:worker_threads";
import { Window } from "happy-dom";
import postcss, { type Declaration, type Rule } from "postcss";
import { buildOnce, domWindow, entryChunk, isModule, writeBundle } from "./support.mts";
import { fileURLToPath } from "node:url";

// DOM lifecycle and CSS conditions/declarations only: happy-dom does not prove
// browser geometry, scrolling, safe areas, or software keyboard behavior.
const channels = [];
globalThis.MessageChannel = class extends MessageChannel {
  constructor() { super(); channels.push(this); }
};
const window = domWindow(new Window({ url: "http://mobile-layout.test", width: 390, height: 844, settings: { device: { prefersReducedMotion: "reduce" } } }));
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event", "localStorage", "history", "location", "requestAnimationFrame", "cancelAnimationFrame", "IntersectionObserver", "ResizeObserver"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: window[key] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
const nativeMatchMedia = window.matchMedia.bind(window);
let pointer = "coarse";
// Supply pointer input and comma-query OR missing from happy-dom; use its width
// matcher against the actual production conditions rather than duplicate limits.
function matches(query) {
  return query.split(",").some((condition) => nativeMatchMedia(condition
    .replace(/\(not \(pointer: coarse\)\)/g, pointer !== "coarse" ? "(min-width: 0px)" : "(width < 0px)")
    .replace(/\(pointer: (coarse|fine|none)\)/g, (_, value) => value === pointer ? "(min-width: 0px)" : "(width < 0px)")
  ).matches);
}
// A MediaQueryList stand-in that the test can flip as the viewport changes.
type MediaChange = { matches: boolean; media: string };
type FakeMediaList = {
  media: string; matches: boolean; listeners: Set<(event: MediaChange) => void>;
  addEventListener(type: string, listener: (event: MediaChange) => void): void;
  removeEventListener(type: string, listener: (event: MediaChange) => void): void;
};
const mediaLists = new Set<FakeMediaList>();
window.matchMedia = globalThis.matchMedia = (media) => {
  const listeners: FakeMediaList["listeners"] = new Set();
  const list: FakeMediaList = {
    media, matches: matches(media), listeners,
    addEventListener(type, listener) { assert.equal(type, "change"); listeners.add(listener); },
    removeEventListener(type, listener) { assert.equal(type, "change"); listeners.delete(listener); },
  };
  mediaLists.add(list); return list as unknown as MediaQueryList;
};
function viewport(width, height, nextPointer) {
  pointer = nextPointer;
  window.happyDOM.setWindowSize({ width, height });
  for (const list of mediaLists) {
    const next = matches(list.media);
    if (next !== list.matches) {
      list.matches = next;
      for (const listener of list.listeners) listener({ matches: next, media: list.media });
    }
  }
}
const src = fileURLToPath(new URL("../src/", import.meta.url));
const bundle = await buildOnce({
  configFile: false, logLevel: "silent", define: { "process.env.NODE_ENV": '"development"' },
  plugins: [{
    name: "mobile-layout-test",
    resolveId: (id) => id.endsWith("virtual:mobile-layout") ? "\0mobile-layout" : undefined,
    load: (id) => id === "\0mobile-layout" ? `
      export { createElement, act } from "react";
      export { createRoot } from "react-dom/client";
      export { Shell, useNarrow } from ${JSON.stringify(`${src}App.tsx`)};
      export { MOBILE_LAYOUT_QUERY } from ${JSON.stringify(`${src}lib/layout.ts`)};
      export { Details } from ${JSON.stringify(`${src}components/Details.tsx`)};
      export { useApp } from ${JSON.stringify(`${src}store.ts`)};
      export { t3 } from ${JSON.stringify(`${src}lib/t3.ts`)};` : undefined,
    transform: (code, id) => isModule(id, `${src}App.tsx`) ? { code: `${code}\nexport { Shell, useNarrow };`, map: null } : undefined,
  }],
  ssr: { noExternal: true }, build: { rollupOptions: { output: { inlineDynamicImports: true } }, ssr: "virtual:mobile-layout", write: false },
});
const entry = entryChunk(bundle);
assert.ok(entry);
const directory = await mkdtemp(join(tmpdir(), "bot-mobile-layout-"));
const filename = await writeBundle(bundle, directory, "components.mjs");
const { createElement: h, act, createRoot, Shell, useNarrow, MOBILE_LAYOUT_QUERY, Details, useApp, t3 } = await import(pathToFileURL(filename).href);
const sheets = await Promise.all(["index.css", "mobile-chat.css", "mobile-settings.css"].map(async (name) => ({
  name, css: postcss.parse(await readFile(join(src, name), "utf8")),
})));
// Select source branches explicitly; don't imply happy-dom parses these queries
// or lays out the result as a browser does.
function stylesForViewport() {
  const style = document.createElement("style");
  style.textContent = sheets.map(({ css }) => {
    const selected = css.clone();
    selected.walkAtRules("media", (rule) => {
      if (matches(rule.params)) rule.replaceWith(...rule.nodes);
      else rule.remove();
    });
    selected.walkAtRules((rule) => { rule.remove(); });
    return selected.toString();
  }).join("\n");
  document.head.append(style); return style;
}
const cases = [
  [320, 568, "coarse", true], [390, 844, "coarse", true],
  [760, 390, "fine", true], [760.5, 390, "fine", false], [761, 390, "fine", false],
  [844, 390, "coarse", true], [844, 390, "fine", false], [844, 390, "none", false],
  [1024, 768, "coarse", true], [1024, 768, "fine", false],
  [1024.5, 768, "coarse", false], [1025, 768, "coarse", false],
  [1440, 900, "fine", false], [1920, 1080, "coarse", false],
];
let root, host;
const bot = { slug: "example", name: "Example", mainThreadId: "main", color: "teal", shape: "sphere", projectId: null, workspaceRoot: "/example" };
beforeEach(() => {
  viewport(390, 844, "coarse"); localStorage.clear(); history.replaceState(null, "", "/");
  t3.stream = () => ({ cancel() {}, done: Promise.resolve(), live: () => false });
  t3.call = async (method) => {
    if (method === "preview.list") return { sessions: [] };
    if (method === "projects.listEntries") return { entries: [], truncated: false };
    throw new Error(`Unexpected RPC: ${method}`);
  };
  globalThis.fetch = async () => { throw new Error("Unexpected HTTP request"); };
  useApp.setState({ bots: { example: bot }, historicalBots: {}, selected: "example", selectedThreadId: "main", threads: {}, threadData: {}, tasks: [], providers: [], projects: {}, detailsOpen: false, detailsTab: "details", dialog: null, toast: null, exchangeBotSlug: null, sidebarCompact: false, sidebarWidth: 280, detailsWidth: 320, settings: { userName: "", sections: [], theme: "system" } });
  host = document.createElement("main"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  assert.equal([...mediaLists].filter((list) => list.media === MOBILE_LAYOUT_QUERY).reduce((count, list) => count + list.listeners.size, 0), 0, "layout media listeners removed on unmount");
  mediaLists.clear(); document.body.replaceChildren(); document.head.replaceChildren();
});
after(async () => {
  for (const channel of channels) { channel.port1.close(); channel.port2.close(); }
  await window.happyDOM.close(); await rm(directory, { recursive: true });
});
function Probe() { return h("output", null, String(useNarrow())); }

for (const [width, height, input, mobile] of cases) test(`layout hook/CSS: ${width}x${height} ${input} => ${mobile ? "mobile" : "desktop"}`, async () => {
  viewport(width, height, input); await act(async () => root.render(h(Probe)));
  assert.equal(host.textContent, String(mobile));
  assert.ok([...mediaLists].every((list) => list.media === MOBILE_LAYOUT_QUERY));
  for (const { name, css } of sheets) css.walkAtRules("media", (rule) => {
    if (rule.params.includes("width")) {
      const desktop = rule.params === "(width > 760px) and (not (pointer: coarse)), (width > 1024px)";
      assert.ok(desktop || rule.params === MOBILE_LAYOUT_QUERY, `${name} uses the shared mobile condition or its desktop inverse`);
      assert.equal(matches(rule.params), desktop ? !mobile : mobile, `${name}: ${rule.params}`);
    }
  });
});

test("live pointer/width changes update the hook", async () => {
  await act(async () => root.render(h(Probe)));
  for (const [width, height, input, mobile] of cases) {
    await act(async () => viewport(width, height, input)); assert.equal(host.textContent, String(mobile));
  }
});

test("breakpoint transitions retain chat, draft, dialog nodes and desktop resizing", async () => {
  await act(async () => root.render(h(Shell)));
  const chat = host.querySelector(".chat-view"), textarea = host.querySelector("textarea");
  assert.ok(chat); assert.ok(textarea); assert.equal(textarea.readOnly, true);
  assert.notEqual(document.activeElement, textarea, "opening chat does not focus composer");
  await act(async () => {
    textarea.dispatchEvent(new window.Event("pointerdown", { bubbles: true }));
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set.call(textarea, "Unsent landscape draft");
    textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
    useApp.setState({ dialog: { kind: "main-bot", intent: { kind: "replace" } } });
  });
  const dialog = document.querySelector('[role="dialog"]'); assert.ok(dialog);
  for (const [width, height, input, mobile] of [[844, 390, "coarse", true], [844, 390, "fine", false], [1440, 900, "fine", false], [1024, 768, "coarse", true], [390, 844, "coarse", true]]) {
    await act(async () => viewport(width, height, input));
    assert.equal(host.querySelector(".chat-view"), chat); assert.equal(host.querySelector("textarea"), textarea);
    assert.equal(textarea.value, "Unsent landscape draft"); assert.equal(document.querySelector('[role="dialog"]'), dialog);
    assert.equal(host.querySelectorAll('[role="separator"]').length, mobile ? 0 : 1);
    assert.equal(Boolean(chat.querySelector('[aria-label="Back"]')), mobile);
    if (mobile) assert.notEqual(document.activeElement, textarea, "mobile transitions do not focus composer");
  }
  await act(async () => useApp.setState({ dialog: null }));
  await act(async () => viewport(844, 390, "coarse"));
  assert.equal(textarea.readOnly, true);
  await act(async () => textarea.focus());
  assert.notEqual(document.activeElement, textarea, "programmatic focus cannot enable mobile editing");
  await act(async () => useApp.setState({ detailsOpen: true }));
  const details = host.querySelector(".bot-details"); assert.ok(details);
  assert.ok(details.parentElement.classList.contains("fixed"));
  await act(async () => viewport(1440, 900, "fine"));
  assert.equal(host.querySelector(".bot-details"), details); assert.equal(host.querySelectorAll('[role="separator"]').length, 2);
  const divider = host.querySelector('[aria-label="Resize details"]');
  await act(async () => divider.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));
  assert.equal(useApp.getState().detailsWidth, 328);
});

for (const tab of ["details", "library", "computer"]) test(`Details ${tab} profile visibility follows mobile condition`, async () => {
  useApp.setState({ detailsTab: tab }); await act(async () => root.render(h(Details, { bot, threadId: "main" })));
  const profile = host.querySelector(".details-profile"); assert.ok(profile);
  for (const [width, height, input, mobile] of [[390, 844, "coarse", true], [844, 390, "coarse", true], [844, 390, "fine", false], [1024, 768, "coarse", true], [1920, 1080, "coarse", false]]) {
    viewport(width, height, input); const style = stylesForViewport();
    assert.equal(getComputedStyle(profile).display === "none", mobile && tab !== "details"); style.remove();
  }
});

test("mobile Details lists Memory beside Instructions", async () => {
  useApp.setState({ detailsTab: "details", detailsOpen: true });
  await act(async () => root.render(h(Details, { bot, threadId: "main" })));
  const labels = [...host.querySelectorAll(".profile-actions button")].map((button) => button.textContent ?? "");
  assert.ok(labels.some((label) => label.includes("Instructions")));
  assert.ok(labels.some((label) => label.includes("Memory")));
  const memory = [...host.querySelectorAll(".profile-actions button")].find((button) => button.textContent?.includes("Memory"));
  await act(async () => memory!.click());
  assert.equal(useApp.getState().detailsTab, "memory");
});

test("coarse landscape retains content scrolling and bounded Settings/dialog declarations", () => {
  viewport(844, 390, "coarse"); stylesForViewport();
  host.innerHTML = '<section class="chat-view"><div class="chat-scroller"></div><div class="md"><pre><code>wide code</code></pre><table><tbody><tr><td>wide table</td></tr></tbody></table></div></section><div class="bot-modal-backdrop"><div data-bot-modal class="settings-modal"><div class="dialog-body"></div></div></div>';
  const computed = (selector) => getComputedStyle(host.querySelector(selector));
  assert.equal(computed(".chat-scroller").overflowX, "hidden");
  for (const selector of ["pre", "table"]) {
    assert.equal(computed(selector).overflowX, "auto"); assert.equal(computed(selector).maxInlineSize, "100%");
  }
  assert.equal(computed("pre code").whiteSpace, "pre");
  assert.equal(computed(".settings-modal").position, "static"); assert.equal(computed(".settings-modal").maxHeight, "100%");
  // happy-dom cannot compute dvh; inspect that declaration directly.
  const backdrop = sheets.find(({ name }) => name === "mobile-settings.css").css.nodes.find((rule): rule is Rule => rule.type === "rule" && rule.selector === ".bot-modal-backdrop");
  assert.equal(backdrop.nodes.find((declaration): declaration is Declaration => declaration.type === "decl" && declaration.prop === "height").value, "100dvh");
  assert.equal(computed(".settings-modal").maxWidth, "100%");
  assert.equal(computed(".dialog-body").overflowY, "auto");
});
