import assert from 'node:assert/strict';
import { test, after, beforeEach, afterEach } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MessageChannel } from 'node:worker_threads';
import { Window } from 'happy-dom';
import { buildOnce, domWindow, entryChunk } from './support.mts';
import { fileURLToPath } from "node:url";

const channels = []; globalThis.MessageChannel = class extends MessageChannel { constructor() { super(); channels.push(this); } };
const window = domWindow(new Window({ url: 'http://board.test/' }));
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'FocusEvent', 'localStorage', 'requestAnimationFrame', 'cancelAnimationFrame', 'IntersectionObserver', 'ResizeObserver', 'location', 'history', 'matchMedia']) {
  if (window[key] !== undefined) Object.defineProperty(globalThis, key, { configurable: true, value: typeof window[key] === 'function' && key === 'matchMedia' ? window[key].bind(window) : window[key] });
}
globalThis.getComputedStyle = window.getComputedStyle.bind(window); globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// A stand-in EventSource the tests drive by hand.
class FakeEventSource {
  url: string; listeners: Record<string, ((event: { data: string }) => void)[]> = {}; closed = false;
  constructor(url: string) { this.url = url; sources.push(this); }
  addEventListener(type: string, fn: (event: { data: string }) => void) { (this.listeners[type] ??= []).push(fn); }
  emit(type: string, data: unknown) { for (const fn of this.listeners[type] ?? []) fn({ data: JSON.stringify(data) }); }
  close() { this.closed = true; }
}
const sources: FakeEventSource[] = [];
globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;

const src = fileURLToPath(new URL('../src/', import.meta.url));
const bundle = await buildOnce({
  configFile: false, logLevel: 'silent', define: { 'process.env.NODE_ENV': '"development"' },
  plugins: [{
    name: 'board-tests',
    resolveId: (id) => id.endsWith('virtual:board') ? '\0board' : undefined,
    load: (id) => id === '\0board' ? `export {createElement,act} from 'react'; export {createRoot} from 'react-dom/client'; export * from ${JSON.stringify(src + 'lib/projects.ts')}; export {ProjectsPage, BoardItemChip, parseLinkInput} from ${JSON.stringify(src + 'components/Projects.tsx')}; export {useApp, openProjects} from ${JSON.stringify(src + 'store.ts')}; export {chatDraft} from ${JSON.stringify(src + 'lib/chatDrafts.ts')}; export {navigationFor, navigationUrl, readNavigation, restoreNavigation} from ${JSON.stringify(src + 'lib/navigation.ts')};` : undefined,
  }],
  ssr: { noExternal: true }, build: { rollupOptions: { output: { inlineDynamicImports: true } }, ssr: 'virtual:board', write: false },
});
const temp = await mkdtemp(join(tmpdir(), 'bot-board-tests-')); const file = join(temp, 'test.mjs');
await writeFile(file, entryChunk(bundle).code);
const b = await import(pathToFileURL(file).href);
const { createElement: h, act, createRoot, useBoard, useApp } = b;
after(async () => { for (const c of channels) { c.port1.close(); c.port2.close(); } await window.happyDOM.close(); await rm(temp, { recursive: true, force: true }); });

const stamp = '2026-11-03T09:00:00.000Z';
const item = (fields) => ({ fields: {}, links: [], pinned: false, archived: false, createdAt: stamp, updatedAt: stamp, createdBy: { type: 'user' }, updatedBy: { type: 'user' }, ...fields });
const board = () => [
  item({ id: 'proj0001', kind: 'project', title: 'Threebot', status: 'active', area: 'personal' }),
  item({ id: 'task0001', kind: 'task', title: 'Ship the page', status: 'doing', parentId: 'proj0001', fields: { priority: 'high' } }),
  item({ id: 'task0002', kind: 'task', title: 'Book movers', status: 'todo', area: 'personal', fields: { due: '2026-11-14' } }),
  item({ id: 'task0003', kind: 'task', title: 'Triage escalations', status: 'todo', area: 'work' }),
  item({ id: 'mach0001', kind: 'machine', title: 'NAS', status: 'online' }),
  item({ id: 'serv0001', kind: 'service', title: 'bot-gateway', status: 'running', machineId: 'mach0001', fields: { port: 3780 } }),
];

let calls, root, host;
function serve(items = board(), version = 3) {
  globalThis.fetch = (async (url: RequestInfo | URL, init: { method?: string; body?: string } = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null });
    if (String(url) === '/api/projects') return new Response(JSON.stringify({ version, items, activity: [] }), { status: 200 });
    if (String(url) === '/api/projects/items') {
      const saved = JSON.parse(init.body).items.map((input) => ({ ...(items.find((i) => i.id === input.id) ?? item({ id: 'new00001', kind: input.kind })), ...input }));
      return new Response(JSON.stringify({ version: version + 1, items: saved }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
}
const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); });
beforeEach(() => {
  calls = []; sources.length = 0;
  useBoard.setState({ status: 'idle', error: null, version: 0, items: {}, activity: [], live: false, flashes: {} });
  useApp.setState({ bots: { ops: { slug: 'ops', name: 'Ops', shape: 'sphere', color: 'teal', primary: true, hidden: false, projectId: 'p-ops', mainThreadId: 'thread-ops', createdAt: stamp } }, threads: {}, projects: {}, page: 'projects', projectItemId: null, selected: null });
  host = document.createElement('main'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); document.body.replaceChildren(); try { localStorage.clear(); } catch {} });
const button = (text) => [...document.querySelectorAll('button')].find((el) => el.textContent.trim() === text);

test('item links are recognised on this app only, relative or absolute', () => {
  assert.equal(b.parseItemLink('/?item=abcd2345', 'http://board.test'), 'abcd2345');
  assert.equal(b.parseItemLink('?item=abcd2345', 'http://board.test'), 'abcd2345');
  assert.equal(b.parseItemLink('http://board.test/?item=abcd2345', 'http://board.test'), 'abcd2345');
  assert.equal(b.parseItemLink('https://elsewhere.test/?item=abcd2345', 'http://board.test'), null);
  assert.equal(b.parseItemLink('/?item=../../etc', 'http://board.test'), null);
  assert.equal(b.parseItemLink('https://github.com/x', 'http://board.test'), null);
  assert.equal(b.itemUrl('abcd2345', 'https://bot.example/'), 'https://bot.example/?item=abcd2345');
  assert.deepEqual(b.parseLinkInput('t3-thread://v2/env-1/thread-9'), { type: 'thread', threadId: 'thread-9', environmentId: 'env-1' });
  assert.deepEqual(b.parseLinkInput('https://example.com/a'), { type: 'url', url: 'https://example.com/a' });
  assert.deepEqual(b.parseLinkInput('http://board.test/?item=abcd2345'), { type: 'item', id: 'abcd2345' });
  assert.equal(b.parseLinkInput('javascript:alert(1)'), null);
});

test('the Projects page has its own address and history entry', () => {
  const state = { selected: 'ops', selectedThreadId: null, exchangeBotSlug: null, detailsOpen: true, dialog: null, page: 'projects', projectItemId: 'task0001' };
  const route = b.navigationFor(state, false);
  assert.deepEqual(route, { view: 'projects', itemId: 'task0001' });
  assert.equal(b.navigationUrl(route, '/'), '/?item=task0001');
  assert.equal(b.navigationUrl({ view: 'projects', itemId: null }, '/'), '/?page=projects');
  assert.deepEqual(b.readNavigation({ view: 'projects', itemId: null }), { view: 'projects', itemId: null });
  assert.equal(b.readNavigation({ view: 'projects', itemId: '<script>' }), null);
  assert.equal(b.restoreNavigation({ view: 'chat', slug: 'ops', threadId: null }, { ops: {} }).page, null);
  assert.equal(b.restoreNavigation({ view: 'projects', itemId: null }, {}).page, 'projects');
});

test('live changes apply in order, a missed one reloads, and a Bot\'s edit is pointed out', async () => {
  serve();
  const stop = b.followBoard();
  await settle();
  assert.equal(useBoard.getState().status, 'ready');
  assert.equal(useBoard.getState().version, 3);
  const source = sources[0];
  assert.equal(source.url, '/api/projects/events');
  source.emit('change', { version: 4, items: [item({ id: 'task0002', kind: 'task', title: 'Book movers', status: 'done' })], removed: [], activity: [{ seq: 1, at: stamp, actor: { type: 'bot', name: 'Ops', slug: 'ops' }, itemId: 'task0002', kind: 'task', title: 'Book movers', action: 'completed', changed: ['status'] }] });
  assert.equal(useBoard.getState().items.task0002.status, 'done');
  assert.equal(useBoard.getState().flashes.task0002.who, 'Ops');
  const before = calls.filter((c) => c.url === '/api/projects').length;
  serve(board(), 9);
  source.emit('change', { version: 9, items: [], removed: ['task0003'], activity: [] });
  await settle();
  assert.equal(calls.filter((c) => c.url === '/api/projects').length, before + 1, 'a gap in versions reloads the board');
  source.emit('hello', { version: 3 });
  await settle();
  stop();
  assert.equal(source.closed, true);
});

test('board helpers: areas inherit from projects, to-dos sort by state, priority and date', () => {
  const items = Object.fromEntries(board().map((i) => [i.id, i]));
  assert.equal(b.inArea(items.task0001, 'personal', items), true, 'a to-do takes its project\'s area');
  assert.equal(b.inArea(items.task0003, 'personal', items), false);
  assert.deepEqual(b.sortTasks(board().filter(b.isOpenTask)).map((t) => t.id), ['task0001', 'task0002', 'task0003']);
  assert.deepEqual(b.areasOf(board()), ['personal', 'work']);
  assert.equal(b.dueLabel('2026-11-03', new Date('2026-11-03T12:00:00')).text, 'Today');
  assert.equal(b.dueLabel('2026-11-01', new Date('2026-11-03T12:00:00')).tone, 'late');
  assert.match(b.askAboutText(items.task0001), /^About this to-do: \[Ship the page\]\(http:\/\/board\.test\/\?item=task0001\) $/);
});

test('the page shows to-dos, projects and machines, and ticking a to-do saves it as done', async () => {
  serve();
  await act(async () => root.render(h(b.ProjectsPage, { narrow: false })));
  await settle();
  const text = document.body.textContent;
  for (const words of ['Ship the page', 'Book movers', 'Triage escalations', 'Threebot', 'NAS', 'bot-gateway', ':3780', 'Running now']) assert.ok(text.includes(words), words);
  const check = document.querySelector<HTMLElement>('[aria-label="Mark “Book movers” done"]');
  await act(async () => check.click());
  await settle();
  const save = calls.find((c) => c.url === '/api/projects/items');
  assert.deepEqual(save.body, { items: [{ id: 'task0002', status: 'done' }] });
});

test('choosing an area narrows the board; machines stay', async () => {
  serve();
  await act(async () => root.render(h(b.ProjectsPage, { narrow: false })));
  await settle();
  await act(async () => button('work').click());
  const text = document.body.textContent;
  assert.ok(text.includes('Triage escalations'));
  assert.ok(!text.includes('Book movers'));
  assert.ok(text.includes('NAS'));
});

test('adding a to-do from the overview saves it under the chosen area', async () => {
  serve();
  await act(async () => root.render(h(b.ProjectsPage, { narrow: false })));
  await settle();
  await act(async () => button('personal').click());
  const input = document.querySelector('input[aria-label="Add a to-do"]');
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value').set;
    setter.call(input, 'Renew passport');
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  await act(async () => input.closest('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
  await settle();
  const save = calls.find((c) => c.url === '/api/projects/items');
  assert.deepEqual(save.body, { items: [{ kind: 'task', title: 'Renew passport', area: 'personal' }] });
});

test('an item opens in its panel, and Ask a Bot hands its link to that Bot\'s chat', async () => {
  serve();
  useApp.setState({ projectItemId: 'proj0001' });
  await act(async () => root.render(h(b.ProjectsPage, { narrow: false })));
  await settle();
  const panel = document.querySelector('aside[aria-label="Threebot"]');
  assert.ok(panel, 'the item panel is open');
  assert.equal(panel.querySelector<HTMLTextAreaElement>('textarea[aria-label="Title"]').value, 'Threebot');
  assert.ok(panel.textContent.includes('Ship the page'), 'its to-dos are listed');
  await act(async () => [...panel.querySelectorAll('button')].find((el) => el.textContent.includes('Ask a Bot')).click());
  await act(async () => button('Ops').click());
  assert.equal(useApp.getState().selected, 'ops');
  assert.equal(useApp.getState().page, null);
  assert.equal(b.chatDraft({ slug: 'ops', mainThreadId: 'thread-ops' }, 'thread-ops').snapshot.text, 'About this project: [Threebot](http://board.test/?item=proj0001) ');
});

test('an empty board offers to have the main Bot set it up', async () => {
  serve([], 0);
  await act(async () => root.render(h(b.ProjectsPage, { narrow: false })));
  await settle();
  const ask = button('Ask Ops to set it up');
  assert.ok(ask);
  await act(async () => ask.click());
  assert.equal(useApp.getState().selected, 'ops');
  assert.match(b.chatDraft({ slug: 'ops', mainThreadId: 'thread-ops' }, 'thread-ops').snapshot.text, /^Set up my Projects board/);
});

test('a snapshot older than a change already seen is fetched again instead of erasing it', async () => {
  const replies = [{ version: 0, items: [], activity: [] }, { version: 1, items: [item({ id: 'task0009', kind: 'task', title: 'Fresh', status: 'todo' })], activity: [] }];
  let release;
  const first = new Promise((resolve) => { release = resolve; });
  let n = 0;
  globalThis.fetch = async (url) => {
    calls.push({ url: String(url) });
    const reply = replies[Math.min(n, 1)];
    if (n++ === 0) await first;
    return new Response(JSON.stringify(reply), { status: 200 });
  };
  const stop = b.followBoard();
  sources[0].emit('change', { version: 1, items: [item({ id: 'task0009', kind: 'task', title: 'Fresh', status: 'todo' })], removed: [], activity: [] });
  release();
  await settle();
  assert.equal(useBoard.getState().version, 1);
  assert.equal(useBoard.getState().items.task0009?.title, 'Fresh');
  stop();
});

test('a save reply older than the board leaves newer Bot changes in place', async () => {
  serve();
  const stop = b.followBoard();
  await settle();
  let release;
  const reply = new Promise((resolve) => { release = resolve; });
  globalThis.fetch = async () => { await reply; return new Response(JSON.stringify({ version: 4, items: [item({ id: 'task0002', kind: 'task', title: 'Old', status: 'todo' })] }), { status: 200 }); };
  const saving = b.saveItems([{ id: 'task0002', title: 'Old' }]);
  sources[0].emit('change', { version: 4, items: [item({ id: 'task0002', kind: 'task', title: 'Old', status: 'todo' })], removed: [], activity: [] });
  sources[0].emit('change', { version: 5, items: [item({ id: 'task0002', kind: 'task', title: 'New', status: 'todo' })], removed: [], activity: [] });
  release();
  await saving;
  assert.equal(useBoard.getState().items.task0002.title, 'New');
  stop();
});
