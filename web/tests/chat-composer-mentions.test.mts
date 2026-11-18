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

const channels: any[] = [];
globalThis.MessageChannel = class extends MessageChannel {
  constructor() {
    super();
    channels.push(this);
  }
} as any;

const window = domWindow(new Window({ url: "http://composer-mentions.test", width: 800, height: 600 }));
for (const key of [
  "window", "document", "navigator", "HTMLElement", "Element", "Node",
  "Event", "MouseEvent", "KeyboardEvent", "ResizeObserver", "IntersectionObserver",
  "localStorage", "requestAnimationFrame", "cancelAnimationFrame",
]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: (window as any)[key] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);

const src = fileURLToPath(new URL("../src/", import.meta.url));
const bundle = await buildOnce({
  configFile: false,
  logLevel: "silent",
  define: { "process.env.NODE_ENV": '"development"' },
  plugins: [{
    name: "composer-mentions-test",
    resolveId: (id) => (id.endsWith("virtual:composer-mentions") ? "\0composer-mentions" : undefined),
    load: (id) =>
      id === "\0composer-mentions"
        ? `
      export { createElement, act } from "react";
      export { createRoot } from "react-dom/client";
      export { Composer } from ${JSON.stringify(`${src}components/Chat.tsx`)};
      export { useApp } from ${JSON.stringify(`${src}store.ts`)};
      export { t3 } from ${JSON.stringify(`${src}lib/t3.ts`)};`
        : undefined,
    transform: (code, id) =>
      isModule(id, `${src}components/Chat.tsx`) ? { code: `${code}\nexport { Composer };`, map: null } : undefined,
  }],
  ssr: { noExternal: true },
  build: { rollupOptions: { output: { inlineDynamicImports: true } }, ssr: "virtual:composer-mentions", write: false },
});

const entry = entryChunk(bundle);
assert.ok(entry);
const directory = await mkdtemp(join(tmpdir(), "bot-composer-mentions-"));
const filename = join(directory, "components.mjs");
await writeFile(filename, entry.code);

let runtime: any, root: any, host: HTMLElement, bot: any, otherBot: any, thirdBot: any, sends: any[] = [], serial = 0;
const load = () => import(`${pathToFileURL(filename).href}?instance=${serial++}`);
const deferred = () => {
  let resolve: any, reject: any;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

beforeEach(async () => {
  localStorage.clear();
  sends = [];
  bot = { slug: `cur-${serial}`, name: "CurrentBot", mainThreadId: `thread-cur-${serial}`, color: "teal", shape: "sphere", projectId: null };
  otherBot = { slug: `alpha-${serial}`, name: "Alpha", label: "Assistant", mainThreadId: `thread-alpha-${serial}`, color: "blue", shape: "blob", projectId: null };
  thirdBot = { slug: `beta-${serial}`, name: "Beta", label: "Helper", mainThreadId: `thread-beta-${serial}`, color: "green", shape: "cloud", projectId: null };

  runtime = await load();
  runtime.useApp.setState({
    bots: {
      [bot.slug]: bot,
      [otherBot.slug]: otherBot,
      [thirdBot.slug]: thirdBot,
    },
    threads: {
      [bot.mainThreadId]: { id: bot.mainThreadId, status: "idle" },
    },
    projects: {},
    runtimeFeatures: { sideChats: false },
  });

  runtime.t3.dispatch = (command: any) => {
    const res = deferred();
    sends.push({ command, ...res });
    return res.promise;
  };

  host = document.createElement("main");
  document.body.append(host);
  root = runtime.createRoot(host);
});

afterEach(async () => {
  await runtime.act(async () => root.unmount());
  document.body.replaceChildren();
});

after(async () => {
  for (const ch of channels) {
    ch.port1.close();
    ch.port2.close();
  }
  await (window as any).happyDOM.close();
  await rm(directory, { recursive: true });
});

const render = async () =>
  runtime.act(async () => {
    root.render(runtime.createElement(runtime.Composer, {
      bot,
      threadId: bot.mainThreadId,
      working: false,
      embedded: false,
      inVoiceChat: false,
      onVoiceChat: () => {},
    }));
  });

const textarea = () => host.querySelector("textarea") as HTMLTextAreaElement;
const menu = () => host.querySelector('[role="listbox"]') as HTMLElement | null;
const options = () => Array.from(host.querySelectorAll('[role="option"]')) as HTMLElement[];

/**
 * Comparing a DOM node with null through assert.equal/assert.strictEqual is a trap: on failure
 * Node inspects the node to build the message, happy-dom walks parent -> document -> window and
 * the process grows to tens of GB (measured: 13.5 GB and a hang). A boolean costs milliseconds
 * and the message is just as clear.
 */
const assertNoMenu = (message = "menu closed") => assert.ok(menu() === null, message);

const type = async (value: string) => {
  await runtime.act(async () => {
    const el = textarea();
    el.focus();
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set.call(el, value);
    el.setSelectionRange(value.length, value.length);
    el.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
};

const keyDown = async (key: string, init: any = {}) => {
  await runtime.act(async () => {
    const el = textarea();
    el.dispatchEvent(new (window as any).KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
  });
};

test("typing @ opens mention menu with other bots and excludes self", async () => {
  await render();
  assertNoMenu();

  await type("Hello @");
  assert.ok(menu(), "menu opened");

  const opts = options();
  assert.equal(opts.length, 2);
  assert.equal(opts[0].getAttribute("aria-label"), "Alpha");
  assert.equal(opts[1].getAttribute("aria-label"), "Beta");
});

test("arrow keys navigate menu and Enter picks without sending", async () => {
  await render();
  await type("Check @");
  assert.ok(menu());

  const opts = options();
  assert.equal(opts[0].getAttribute("aria-selected"), "true");
  assert.equal(opts[1].getAttribute("aria-selected"), "false");

  // Move down
  await keyDown("ArrowDown");
  assert.equal(options()[0].getAttribute("aria-selected"), "false");
  assert.equal(options()[1].getAttribute("aria-selected"), "true");

  // Move down wraps to top
  await keyDown("ArrowDown");
  assert.equal(options()[0].getAttribute("aria-selected"), "true");

  // Move up wraps to bottom
  await keyDown("ArrowUp");
  assert.equal(options()[1].getAttribute("aria-selected"), "true");

  // Enter picks Beta
  await keyDown("Enter");
  assertNoMenu("menu closed");
  assert.equal(textarea().value, "Check @Beta ");
  assert.equal(sends.length, 0, "Enter did not dispatch send");
});

test("Escape closes menu and Enter with menu closed sends", async () => {
  await render();
  await type("Ask @");
  assert.ok(menu());

  // Escape closes
  await keyDown("Escape");
  assertNoMenu();

  // Enter sends
  await keyDown("Enter");
  assert.equal(sends.length, 1);
  assert.equal(sends[0].command.text, "Ask @");
});

test("Escape dismisses the menu only until you type again", async () => {
  await render();
  await type("Ask @");
  assert.ok(menu(), "menu opened");

  await keyDown("Escape");
  assertNoMenu();

  // Typing again invalidates the dismissal: the menu must come back.
  await type("Ask @A");
  assert.ok(menu(), "menu reopened after typing");
});

test("picking a bot inserts @Name and allows typing to continue", async () => {
  await render();
  await type("@Al");
  assert.ok(menu());
  assert.equal(options().length, 1);
  assert.equal(options()[0].getAttribute("aria-label"), "Alpha");

  // Pick via Enter
  await keyDown("Enter");
  assert.equal(textarea().value, "@Alpha ");

  // Continue typing
  await type("@Alpha please review");
  assert.equal(textarea().value, "@Alpha please review");
  assertNoMenu();
});

test("a query no Bot matches shows nothing and Enter still sends", async () => {
  await render();
  await type("Mail me at @nobody");
  assertNoMenu("no empty panel");
  await keyDown("Enter");
  assert.equal(sends.length, 1);
});
