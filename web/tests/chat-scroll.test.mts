import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, afterEach, beforeEach, test } from 'node:test';
import { MessageChannel } from 'node:worker_threads';
import { Window } from 'happy-dom';
import { buildOnce, domWindow, entryChunk } from './support.mts';
import { fileURLToPath } from "node:url";

// Real React lifecycle with controlled scroll metrics. Browser geometry and
// native scrolling still require the real fixture comparison.
const window = domWindow(new Window({ url: 'http://chat-scroll.test', width: 390, height: 844 }));
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'localStorage', 'location', 'requestAnimationFrame', 'cancelAnimationFrame', 'IntersectionObserver']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: window[key] });
}
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const channels = [];
globalThis.MessageChannel = class extends MessageChannel { constructor() { super(); channels.push(this); } };
class FakeResizeObserver {
  callback: (entries: ResizeObserverEntry[]) => void; targets = new Set<Element>();
  constructor(callback: (entries: ResizeObserverEntry[]) => void) { this.callback = callback; }
  observe(target: Element) { this.targets.add(target); observers.add(this); }
  disconnect() { observers.delete(this); }
}
const observers = new Set<FakeResizeObserver>();
globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
let height = 1000;
let viewportHeight = 300;
const tops = new WeakMap();
Object.defineProperties(window.HTMLElement.prototype, {
  scrollHeight: { configurable: true, get() { return this.classList.contains('chat-scroller') ? height : 0; } },
  clientHeight: { configurable: true, get() { return this.classList.contains('chat-scroller') ? viewportHeight : 0; } },
  scrollTop: {
    configurable: true, get() { return tops.get(this) ?? 0; },
    set(value) { tops.set(this, this.classList.contains('chat-scroller') ? Math.max(0, Math.min(value, height - viewportHeight)) : value); },
  },
});
const src = fileURLToPath(new URL('../src/', import.meta.url));
const bundle = await buildOnce({
  configFile: false, logLevel: 'silent', define: { 'process.env.NODE_ENV': '"development"' },
  plugins: [{
    name: 'chat-scroll-test', enforce: 'pre', resolveId: (id) => id.endsWith('virtual:chat-scroll') ? '\0chat-scroll' : undefined,
    load: (id) => id === '\0chat-scroll' ? `
      export { Chat } from ${JSON.stringify(src + 'components/Chat.tsx')};
      export { useApp } from ${JSON.stringify(src + 'store.ts')};
      export { t3 } from ${JSON.stringify(src + 'lib/t3.ts')};
      export { createElement, act } from 'react';
      export { createRoot } from 'react-dom/client';` : undefined,
    transform: (code, id) => id.endsWith('/components/RichMarkdown.tsx') ? code.replace('export function RichMarkdown({ children, bots = [], components, urlTransform }: RichMarkdownProps) {', 'export function RichMarkdown({ children, bots = [], components, urlTransform }: RichMarkdownProps) { globalThis.markdownParses = (globalThis.markdownParses ?? 0) + 1;') : undefined,
  }], ssr: { noExternal: true }, build: { rollupOptions: { output: { inlineDynamicImports: true } }, ssr: 'virtual:chat-scroll', write: false },
});
const entry = entryChunk(bundle);
assert.ok(entry);
const directory = await mkdtemp(join(tmpdir(), 'bot-chat-scroll-'));
const filename = join(directory, 'components.mjs'); await writeFile(filename, entry.code);
const { Chat, useApp, t3, createElement: h, act, createRoot } = await import(pathToFileURL(filename).href);
let host, root, alpha, beta, childId, data, counter = 0;
const message = (id, ordinal = 1) => ({ id, ordinal, type: 'assistant_message', text: '```js\nconst example = "wide";\n```\n\n| A | B |\n| --- | --- |\n| x | y |', status: 'completed', updatedAt: '2026-01-01T00:00:00Z' });
const projection = (id) => ({ loaded: true, items: { [id]: message(id) }, requests: {}, runs: {} });
beforeEach(() => {
  const suffix = ++counter;
  alpha = { slug: 'alpha', name: 'Alpha', mainThreadId: `alpha-${suffix}`, workspaceRoot: '/generic/alpha', color: 'teal', shape: 'sphere', projectId: 'project-alpha' };
  beta = { ...alpha, slug: 'beta', name: 'Beta', mainThreadId: `beta-${suffix}` };
  childId = `child-${suffix}`;
  data = { [alpha.mainThreadId]: projection(`parent-${suffix}`), [beta.mainThreadId]: projection(`beta-${suffix}`), [childId]: projection(`child-${suffix}`) };
  t3.stream = () => ({ cancel() {}, done: Promise.resolve() });
  t3.call = async () => ({ entries: [], threads: [], sessions: [] });
  globalThis.fetch = async () => { throw new Error('Unexpected HTTP'); };
  useApp.setState({ bots: { alpha, beta }, historicalBots: {}, threads: {}, threadData: data, tasks: [], providers: [], projects: {}, selected: 'alpha', selectedThreadId: null, exchangeBotSlug: null, detailsOpen: false, vault: [], settings: { userName: '', sections: [], theme: 'system' } });
  localStorage.clear(); height = 1000; viewportHeight = 300;
  host = document.createElement('main'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); assert.equal(observers.size, 0, 'resize observers released'); });
after(async () => { for (const channel of channels) { channel.port1.close(); channel.port2.close(); } await window.happyDOM.close(); await rm(directory, { recursive: true }); });
const render = async (bot = alpha, threadId = bot.mainThreadId, keyed = false) => act(async () => root.render(h(Chat, { key: keyed ? bot.slug : 'chat', bot, threadId })));
const scroller = () => host.querySelector('.chat-scroller');
const position = () => [scroller().scrollTop, host.querySelector('pre').scrollLeft, host.querySelector('table').scrollLeft];
async function scroll(target, top, left = target.scrollLeft) { await act(async () => { target.scrollTop = top; target.scrollLeft = left; target.dispatchEvent(new window.Event('scroll')); }); }
async function readAt(top, code = 110, table = 70) { await scroll(scroller(), top); await scroll(host.querySelector('pre'), 0, code); await scroll(host.querySelector('table'), 0, table); }

test('opening a large child bounds rendered history and earlier messages remain reachable', async () => {
  const items = Object.fromEntries(Array.from({ length: 750 }, (_, index) => {
    const value = { ...message(`history-${index}`, index), text: `Message ${index}` };
    return [value.id, value];
  }));
  await act(async () => useApp.setState({ threadData: { ...data, [childId]: { loaded: true, items, runs: {}, requests: {} } } }));
  await render(alpha, childId);
  assert.ok(host.querySelectorAll('[data-chat-entry]').length <= 20, 'opening does not mount and parse the entire transcript');
  assert.match(host.textContent, /Message 749/);
  assert.doesNotMatch(host.textContent, /Message 0\b/);
  const earlier = () => [...host.querySelectorAll('button')].find(button => button.textContent.includes('Load earlier'));
  assert.ok(earlier());
  await scroll(scroller(), 40);
  await act(async () => { earlier().click(); height += 500; });
  assert.equal(scroller().scrollTop, 540, 'prepending preserves the reading position');
  assert.ok(host.querySelectorAll('[data-chat-entry]').length <= 40);
  const count = host.querySelectorAll('[data-chat-entry]').length;
  await render(beta); await render(alpha, childId);
  assert.equal(host.querySelectorAll('[data-chat-entry]').length, count, 'return preserves expanded history');
  while (earlier()) await act(async () => earlier().click());
  assert.equal(host.querySelector('[data-chat-entry="history-0"]')?.textContent, 'Message 0');
  assert.match(host.textContent, /Message 749/);
});

test('unchanged messages are not reparsed on shell events or identical Bot polling', async () => {
  globalThis.markdownParses = 0;
  await render();
  const parsed = globalThis.markdownParses;
  assert.ok(parsed > 0, 'observing the real Markdown renderer');
  await act(async () => useApp.setState({ threads: { other: { id: 'other' } }, bots: { alpha: { ...alpha }, beta: { ...beta } } }));
  assert.equal(globalThis.markdownParses, parsed);
  await act(async () => useApp.setState({ bots: { alpha: { ...alpha, name: 'Renamed' }, beta } }));
  assert.ok(globalThis.markdownParses > parsed, 'changed mention names invalidate Markdown');
});

for (const keyed of [false, true]) test(`return to a Bot restores transcript and code/table positions (${keyed ? 'remount' : 'reuse'})`, async () => {
  await render(alpha, alpha.mainThreadId, keyed); await readAt(40);
  await render(beta, beta.mainThreadId, keyed); await readAt(90, 25, 15);
  await render(alpha, alpha.mainThreadId, keyed);
  assert.deepEqual(position(), [40, 110, 70]);
  await render(beta, beta.mainThreadId, keyed); assert.deepEqual(position(), [90, 25, 15]);
});

test('parent and child retain independent scroll positions in the same Chat', async () => {
  await render(); const original = scroller(); await readAt(40);
  await render(alpha, childId); assert.equal(scroller(), original); await readAt(250, 55, 35);
  await render(); assert.deepEqual(position(), [40, 110, 70]);
  await render(alpha, childId); assert.deepEqual(position(), [250, 55, 35]);
});

test('return waits for the transcript and does not overwrite saved positions with loading scroll events', async () => {
  await render(); await readAt(400); await render(beta);
  await act(async () => useApp.setState({ threadData: { ...data, [alpha.mainThreadId]: { loaded: false, items: {}, runs: {}, requests: {} } } }));
  await render(); await scroll(scroller(), 0);
  await act(async () => useApp.setState({ threadData: data }));
  assert.deepEqual(position(), [400, 110, 70]);
});

test('new content follows the bottom only while the reader is following latest', async () => {
  await render(); assert.equal(scroller().scrollTop, 700);
  await readAt(40);
  height = 1200;
  const next = { ...data[alpha.mainThreadId], items: { ...data[alpha.mainThreadId].items, extra: message('extra', 2) } };
  await act(async () => useApp.setState({ threadData: { ...data, [alpha.mainThreadId]: next } }));
  assert.equal(scroller().scrollTop, 40);
  assert.ok(host.querySelector('[aria-label="Scroll to latest"]'));
  await scroll(scroller(), 900);
  height = 1400;
  await act(async () => useApp.setState({ threadData: { ...data, [alpha.mainThreadId]: { ...next, items: { ...next.items, last: message('last', 3) } } } }));
  assert.equal(scroller().scrollTop, 1100);
});

test('delayed content restores a clamped position without mistaking programmatic scroll for reader input', async () => {
  await render(); await readAt(400); await render(beta);
  height = 320; await render(); assert.equal(scroller().scrollTop, 20);
  await act(async () => scroller().dispatchEvent(new window.Event('scroll')));
  height = 1000;
  await act(async () => { for (const observer of observers) observer.callback([]); });
  assert.deepEqual(position(), [400, 110, 70]);
  await scroll(scroller(), 8);
  height = 1200;
  await act(async () => { for (const observer of observers) observer.callback([]); });
  assert.equal(scroller().scrollTop, 8, 'later content does not undo the reader scroll');
});

test('a genuine near-bottom reading offset survives return and new content', async () => {
  await render(); await readAt(660); await render(beta); await render();
  assert.deepEqual(position(), [660, 110, 70]);
  height = 1200;
  const next = { ...data[alpha.mainThreadId], items: { ...data[alpha.mainThreadId].items, extra: message('extra', 2) } };
  await act(async () => useApp.setState({ threadData: { ...data, [alpha.mainThreadId]: next } }));
  assert.equal(scroller().scrollTop, 660);
});

test('viewport-only height changes keep bottom followers at latest and leave readers in place', async () => {
  await render(); assert.equal(scroller().scrollTop, 700);
  const resizeViewport = async (height) => act(async () => {
    viewportHeight = height;
    // A viewport resize does not resize the intrinsic transcript contents.
    for (const observer of observers) if (observer.targets.has(scroller())) observer.callback([]);
  });
  await resizeViewport(200); assert.equal(scroller().scrollTop, 800);
  await readAt(40); await resizeViewport(100); assert.equal(scroller().scrollTop, 40);
});

test('a layout clamp before ResizeObserver delivery cannot replace the saved reading position', async () => {
  await render(); await readAt(660); await render(beta); await render();
  height = 900;
  await scroll(scroller(), 660); // Browser clamps to600 before notifying resize.
  height = 1000;
  await act(async () => { for (const observer of observers) observer.callback([]); });
  assert.deepEqual(position(), [660, 110, 70]);
});

test('explicit wheel input cancels pending restoration even during a layout change', async () => {
  await render(); await readAt(660); await render(beta); await render();
  height = 900;
  await act(async () => scroller().dispatchEvent(new window.Event('wheel', { bubbles: true })));
  await scroll(scroller(), 500);
  height = 1000;
  await act(async () => { for (const observer of observers) observer.callback([]); });
  assert.equal(scroller().scrollTop, 500);
});
