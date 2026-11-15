import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, mock, test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildOnce, domWindow, entryChunk } from './support.mts';
import { Window } from 'happy-dom';

const window = domWindow(new Window({ url: 'https://bot.example/', settings: { navigation: { disableChildFrameNavigation: true }, enableImageFileLoading: false } }));
for (const key of ['window', 'document', 'localStorage', 'location', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'IntersectionObserver', 'ResizeObserver']) globalThis[key] = key === 'window' ? window : window[key];
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
const channels = [];
const NativeMessageChannel = globalThis.MessageChannel;
globalThis.MessageChannel = class extends NativeMessageChannel { constructor() { super(); channels.push(this); } };
after(async () => { for (const channel of channels) { channel.port1.close(); channel.port2.close(); } await window.happyDOM.close(); });
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const source = (path) => new URL(`../src/${path}`, import.meta.url).pathname;
const chat = source('components/Chat.tsx');
const bundle = await buildOnce({
  configFile: false, logLevel: 'silent', define: { 'process.env.NODE_ENV': JSON.stringify('development') }, ssr: { noExternal: true },
  plugins: [{
    name: 'workspace-library-test',
    resolveId: (id) => id.endsWith('virtual:workspace-test') ? '\0workspace-test' : undefined,
    load: (id) => id === '\0workspace-test' ? `
      export * from ${JSON.stringify(source('lib/workspaceLinks.ts'))};
      export * from ${JSON.stringify(source('lib/library.ts'))};
      export * from ${JSON.stringify(source('components/WorkspaceResource.tsx'))};
      export { Library } from ${JSON.stringify(source('components/Library.tsx'))};
      export { Chat, MessageContent } from ${JSON.stringify(chat)};
      export { useApp } from ${JSON.stringify(source('store.ts'))};
      export { t3, T3Client, environmentT3, threadKey } from ${JSON.stringify(source('lib/t3.ts'))};
      export { workspaceAssetUrl } from ${JSON.stringify(source('lib/workspaceAssets.ts'))};
      export { createElement, act } from 'react';
      export { createRoot } from 'react-dom/client';
    ` : undefined,
    transform: (code, id) => id === chat ? { code: code + '\nexport { MessageContent };', map: null } : undefined,
  }], build: { ssr: 'virtual:workspace-test', write: false },
});
const entry = entryChunk(bundle);
assert.ok(entry);
const temporary = await mkdtemp(join(tmpdir(), 'bot-workspace-test-'));
let loaded;
try {
  const file = join(temporary, 'test.mjs');
  await writeFile(file, entry.code);
  loaded = await import(pathToFileURL(file).href);
} finally { await rm(temporary, { force: true, recursive: true }); }
const { libraryAge, libraryGroups, workspaceLinkPath, conversationLibrary, workspaceListingEntries, mergeLibraryEntries, filterLibraryEntries, WorkspaceResourceViewer, WorkspaceFileContext, MessageContent, Library, Chat, useApp, t3, createElement: h, createRoot, act } = loaded;
const rootPath = '/workspace/bots/example';
const bot = { slug: 'example', workspaceRoot: rootPath, name: 'Example', mainThreadId: 'main', projectId: 'project', shape: 'blob', color: 'teal' };
const workspace = { workspaceRoot: rootPath, threadId: 'main' };
const message = (text) => ({ id: 'message', ordinal: 1, type: 'assistant_message', text, startedAt: '2026-10-30T00:00:00Z', updatedAt: '2026-10-30T00:00:00Z', status: 'completed' });
let mounted;
let container;
let calls;
let rpc;
let fetches;
let fetchResponse;
const flush = () => new Promise((resolve) => setImmediate(resolve));
async function mount(node) { await act(async () => { mounted.render(node); await flush(); }); }
async function click(element) { assert.ok(element, 'control exists'); await act(async () => { element.click(); await flush(); }); }
const button = (text) => [...document.querySelectorAll('button')].find((element) => element.textContent === text);

for (const [name, kind] of [['parity-note.txt', 'text'], ['parity-silence.wav', 'audio']]) test(`T3 preview contract opens ${name} while rejecting workspace-file signing`, async () => {
  rpc = async (tag, payload) => {
    assert.equal(tag, 'assets.createUrl');
    if (payload.resource._tag === 'workspace-file') throw new Error('Only browser documents and images can be previewed.');
    assert.deepEqual(payload.resource, { _tag: 'media-file', threadId: 'main', path: `library/${name}`, ...(kind === 'text' ? { disposition: 'attachment' } : {}) });
    return { relativeUrl: `/api/assets/fixture/${name}?signature=fixture` };
  };
  fetchResponse = () => new Response('Disposable text fixture.');
  await mount(h(WorkspaceResourceViewer, { resource: { _tag: 'workspace-file', threadId: 'main', path: `library/${name}` }, title: name, onClose() {} }));
  assert.equal(!!document.querySelector('[role=alert]'), false, 'the supported resource opens without an error');
  if (kind === 'text') assert.match(document.querySelector('pre').textContent, /Disposable text fixture/);
  else assert.ok(document.querySelector('audio').controls);
});

test('workspace asset signing keeps linked environment scope and raw thread identity for text, audio and Office files', async () => {
  mock.method(loaded.T3Client.prototype, 'connect', () => {});
  const remote = loaded.environmentT3('fixture-remote');
  const signed = [];
  mock.method(remote, 'call', async (tag, payload) => { signed.push({ tag, payload }); return { relativeUrl: '/api/assets/fixture?token=a%2Bb%2F' }; });
  const threadId = loaded.threadKey({ environmentId: 'fixture-remote', threadId: 'same-id' });
  for (const [name, disposition] of [['notes.txt', 'attachment'], ['audio.wav', undefined], ['budget.xlsx', 'attachment'], ['memo.docx', 'attachment']]) {
    const url = await loaded.workspaceAssetUrl({ _tag: 'workspace-file', threadId, path: 'library/' + name });
    assert.equal(url, '/t3/environments/fixture-remote/api/assets/fixture?token=a%2Bb%2F');
    assert.deepEqual(signed.at(-1), { tag: 'assets.createUrl', payload: { resource: { _tag: 'media-file', threadId: 'same-id', path: 'library/' + name, ...(disposition ? { disposition } : {}) } } });
  }
  assert.equal(calls.length, 0, 'no request falls back to the local T3');
});

test('resource diagnostics identify signing, HTTP and native media boundaries without signed query values', async () => {
  const diagnostics = [];
  mock.method(console, 'error', (...args) => diagnostics.push(args));
  rpc = async () => { throw new Error('Only browser documents and images can be previewed.'); };
  await mount(h(WorkspaceResourceViewer, { resource: { _tag: 'workspace-file', threadId: 'main', path: 'library/notes.txt' }, title: 'notes.txt', onClose() {} }));
  assert.equal(diagnostics.at(-1)[1].stage, 'sign');
  assert.match(diagnostics.at(-1)[1].message, /Only browser documents/);
  rpc = async () => ({ relativeUrl: '/api/assets/fixture?token=private-signature' });
  fetchResponse = () => new Response('Unavailable', { status: 403 });
  await click(button('Retry'));
  assert.deepEqual(diagnostics.at(-1)[1], { stage: 'fetch', resourceType: 'workspace-file', fileKind: 'text', message: 'Asset HTTP 403' });
  await mount(h(WorkspaceResourceViewer, { resource: { _tag: 'workspace-file', threadId: 'main', path: 'library/audio.wav' }, title: 'audio.wav', onClose() {} }));
  const audio = document.querySelector('audio');
  Object.defineProperty(audio, 'error', { value: { code: 4 } });
  await act(async () => audio.dispatchEvent(new Event('error')));
  assert.equal(diagnostics.at(-1)[1].stage, 'render');
  assert.equal(diagnostics.at(-1)[1].message, 'Media error 4');
  assert.doesNotMatch(JSON.stringify(diagnostics), /private-signature/);
});

beforeEach(() => {
  mock.restoreAll();
  calls = []; fetches = [];
  rpc = async (tag) => tag === 'assets.createUrl' ? { relativeUrl: '/assets/signed?token=fixture' } : { entries: [], truncated: false };
  fetchResponse = () => new Response('<html><body>Report</body></html>', { status: 200 });
  mock.method(t3, 'call', async (tag, payload) => { calls.push({ tag, payload }); return rpc(tag, payload); });
  mock.method(t3, 'stream', () => ({ cancel() {}, done: Promise.resolve() }));
  mock.method(globalThis, 'fetch', async (url) => { fetches.push(url); return fetchResponse(); });
  localStorage.clear();
  useApp.setState({ bots: { example: bot }, historicalBots: {}, threads: {}, tasks: [], selected: 'example', selectedThreadId: null, exchangeBotSlug: null, detailsOpen: false, settings: null, threadData: { main: { loaded: true, items: {}, runs: {}, requests: {} } } });
  container = document.createElement('div'); document.body.append(container);
  mounted = createRoot(container);
});
afterEach(async () => { await act(async () => mounted.unmount()); container.remove(); });

test('workspace resolver accepts only local files contained by the owning Bot workspace', () => {
  for (const href of [`${rootPath}/library/report.html`, `file://${rootPath}/library/report.html`, 'library/report.html', './library/report.html']) assert.equal(workspaceLinkPath(href, rootPath), 'library/report.html');
  assert.equal(workspaceLinkPath('report.html', rootPath, 'library/index.md'), 'library/report.html');
  assert.equal(workspaceLinkPath('../report.html', rootPath, 'library/nested/index.md'), 'library/report.html');
  assert.equal(workspaceLinkPath(`file://${rootPath}/library/a%20report.html`, rootPath), 'library/a report.html');
  for (const href of [
    'https://external.example/library/report.html', `https://bot.example${rootPath}/library/report.html`,
    '//external.example/library/report.html', '/etc/passwd', '/workspace/bots/example-other/report.html',
    '../other/report.html', 'library/../../outside.html', `${rootPath}/../other/report.html`,
    'file:///etc/passwd', `file://remote${rootPath}/library/report.html`,
    'library/%2e%2e/%2e%2e/outside.html', 'library/%252e%252e/outside.html',
    'library/unsafe\\name.html', 'library/bad%00.html', 'library/%broken.html', 'javascript:alert(1)', '%68ttps://external.example/report.html', '%2f%2fexternal.example/report.html', '#section', '/api/session',
  ]) assert.equal(workspaceLinkPath(href, rootPath), null, href);
});

test('conversation and workspace references merge; Pages, Media, Links and Files are distinct', () => {
  const conversation = conversationLibrary([message(`[Report](${rootPath}/library/report.html) [Again](file://${rootPath}/library/report.html) ![Image](library/photo.PNG) [Video](./library/clip.mp4) [Site](https://external.example/report.html)`)], workspace);
  const files = workspaceListingEntries({ entries: [{ path: 'library/report.html', kind: 'file' }, { path: 'library/photo.PNG', kind: 'file' }, { path: 'library/clip.mp4', kind: 'file' }, { path: 'library/subdir', kind: 'directory' }], truncated: false }, workspace);
  const all = mergeLibraryEntries(conversation, files);
  assert.equal(all.length, 4);
  assert.equal(filterLibraryEntries(all, 'Media').length, 2);
  assert.equal(filterLibraryEntries(all, 'Files').length, 0);
  assert.equal(filterLibraryEntries(all, 'Pages').length, 1);
  assert.equal(filterLibraryEntries(all, 'Links')[0].href, 'https://external.example/report.html');
  assert.deepEqual(all.find((entry) => entry.title === 'report.html').resource, { _tag: 'workspace-file', threadId: 'main', path: 'library/report.html' });
  assert.equal(conversationLibrary([message('[Report](library/report(1).html)')], workspace)[0].resource.path, 'library/report(1).html');
  assert.equal(workspaceListingEntries({ entries: [{ path: 'library/literal%20name.txt', kind: 'file' }] }, workspace)[0].resource.path, 'library/literal%20name.txt', 'RPC paths are filenames, not URL-encoded references');
  for (const result of [null, {}, { entries: [{ path: '/etc/passwd', kind: 'file' }] }, { entries: [{ path: 'library/../../outside.html', kind: 'file' }] }]) assert.throws(() => workspaceListingEntries(result, workspace), /Couldn't load/);
});

test('actual Markdown renders validated workspace links as actions, preserves external and Bot links, and blocks host paths', async () => {
  let opened;
  await mount(h(WorkspaceFileContext, { value: { ...workspace, openFile: (path) => { opened = path; } } }, h(MessageContent, { text: `[Report](${rootPath}/library/report.html) [Local](file://${rootPath}/library/local.html) [External](https://external.example/library/report.html) [Outside](/etc/passwd) [Other](../other/report.html) @Example` })));
  await click(button('Report')); assert.equal(opened, 'library/report.html');
  await click(button('Local')); assert.equal(opened, 'library/local.html');
  assert.equal(document.querySelector('a[href="https://external.example/library/report.html"]').textContent, 'External');
  assert.equal(document.querySelector('a[href="/etc/passwd"]'), null);
  assert.equal(document.querySelector('a[href*="../other"]'), null);
  assert.ok(document.querySelector('.bot-mention'));
  assert.equal(calls.length, 0, 'rendering a link does not access a file');
});

test('actual signed viewer reports HTTP failure, retries with a fresh URL, and previews the real resource', async () => {
  let attempts = 0;
  fetchResponse = () => ++attempts === 1 ? new Response('Missing', { status: 404 }) : new Response('<html>Report</html>', { status: 200 });
  await mount(h(WorkspaceResourceViewer, { resource: { _tag: 'workspace-file', threadId: 'child', path: 'library/report.html' }, title: 'report.html', onClose() {} }));
  assert.match(document.querySelector('[role="alert"]').textContent, /Couldn't open/);
  assert.equal(document.querySelector('iframe'), null);
  await click(button('Retry'));
  assert.deepEqual(calls.filter((call) => call.tag === 'assets.createUrl').map((call) => call.payload), Array(2).fill({ resource: { _tag: 'workspace-file', threadId: 'child', path: 'library/report.html' } }));
  assert.equal(document.querySelector('iframe').getAttribute('src'), '/t3/assets/signed?token=fixture');
  assert.equal(document.querySelector('iframe').getAttribute('sandbox'), 'allow-scripts');
  assert.deepEqual(fetches, ['/t3/assets/signed?token=fixture', '/t3/assets/signed?token=fixture']);
});

test('signing errors and media errors expose Retry; video uses native playback controls', async () => {
  rpc = async () => { throw new Error('offline'); };
  await mount(h(WorkspaceResourceViewer, { resource: { _tag: 'workspace-file', threadId: 'main', path: 'library/clip.mp4' }, title: 'clip.mp4', onClose() {} }));
  assert.ok(button('Retry'));
  rpc = async () => ({ relativeUrl: '/assets/new-signature' });
  await click(button('Retry'));
  const video = document.querySelector('video');
  assert.ok(video.controls);
  assert.equal(video.getAttribute('src'), '/t3/assets/new-signature');
  assert.equal(document.querySelector('a').getAttribute('href'), '/t3/assets/new-signature');
  assert.equal(fetches.length, 0, 'native playback loads the signed URL without a JS prefetch');
  await act(async () => video.dispatchEvent(new Event('error')));
  assert.match(document.querySelector('[role="alert"]').textContent, /Couldn't open/);
});

test('Library failure is visible and retry loads deduplicated workspace media with signed playback', async () => {
  let listed = 0;
  rpc = async (tag) => {
    if (tag === 'assets.createUrl') return { relativeUrl: '/assets/clip' };
    if (++listed === 1) throw new Error('offline');
    return { entries: [{ path: 'library/photo.png', kind: 'file' }, { path: 'library/clip.mp4', kind: 'file' }], truncated: false };
  };
  useApp.setState({ threadData: { main: { loaded: true, items: { message: message('[Photo](library/photo.png)') }, runs: {}, requests: {} } } });
  await mount(h(Library, { bot }));
  assert.match(container.textContent, /Couldn't load workspace files/);
  await click(button('Retry'));
  await click(button('All'));
  assert.equal(document.querySelectorAll('.library-row').length, 2);
  await click(button('Files'));
  assert.equal(document.querySelectorAll('.library-row').length, 0);
  await click(button('Media'));
  assert.equal(document.querySelectorAll('.library-row').length, 2);
  await click([...document.querySelectorAll('.library-row')].find((row) => row.textContent.includes('clip.mp4')));
  assert.ok(document.querySelector('video'));
  assert.deepEqual(calls.find((call) => call.tag === 'assets.createUrl' && call.payload.resource.path.endsWith('clip.mp4')).payload.resource, { _tag: 'media-file', threadId: 'main', path: 'library/clip.mp4' });
});

test('opening and closing a workspace report retains the actual chat scroller, conversation and composer draft', async () => {
  localStorage.setItem('bot.draft.example', 'Keep this draft');
  useApp.setState({ threadData: { main: { loaded: true, items: { message: message(`[Report](${rootPath}/library/report.html)`) }, runs: {}, requests: {} } } });
  await mount(h(Chat, { bot }));
  const scroller = document.querySelector('.chat-scroller');
  const composer = document.querySelector('textarea');
  assert.equal(composer.value, 'Keep this draft');
  scroller.scrollTop = 137;
  await act(async () => scroller.dispatchEvent(new Event('scroll')));
  await click(button('Report'));
  assert.ok(document.querySelector('iframe'));
  await click(document.querySelector('[aria-label="Close"]'));
  assert.equal(document.querySelector('[role="dialog"]'), null);
  assert.equal(document.querySelector('.chat-scroller'), scroller);
  assert.equal(scroller.scrollTop, 137);
  assert.equal(document.querySelector('textarea'), composer);
  assert.equal(composer.value, 'Keep this draft');
  assert.ok(button('Report'));
});

test('workspace Markdown images request the owner resource and show retry on decode failure', async () => {
  await mount(h(WorkspaceFileContext, { value: { ...workspace, openFile() {} } }, h(MessageContent, { text: '![Photo](file:///workspace/bots/example/library/photo.png)' })));
  assert.deepEqual(calls[0].payload.resource, { _tag: 'workspace-file', threadId: 'main', path: 'library/photo.png' });
  const image = document.querySelector('img');
  assert.equal(image.getAttribute('src'), '/t3/assets/signed?token=fixture');
  await act(async () => image.dispatchEvent(new Event('error')));
  assert.ok(button('Retry'));
  await click(button('Retry'));
  assert.equal(calls.length, 2);
});

test('missing thread resources and malformed signing responses never produce a file link', async () => {
  await mount(h(WorkspaceResourceViewer, { resource: null, title: 'Unavailable', onClose() {} }));
  assert.ok(button('Retry'));
  assert.equal(calls.length, 0);
  rpc = async () => ({});
  await mount(h(WorkspaceResourceViewer, { resource: { _tag: 'workspace-file', threadId: 'main', path: 'library/report.html' }, title: 'Report', onClose() {} }));
  assert.match(document.querySelector('[role="alert"]').textContent, /Couldn't open/);
  assert.equal(fetches.length, 0);
  assert.equal(document.querySelector('a'), null);
});

test('Markdown file contents use the signed response and resolve links relative to that document', async () => {
  fetchResponse = () => new Response('[Nested report](report.html)', { status: 200 });
  useApp.setState({ threadData: { main: { loaded: true, items: { message: message('[Index](library/index.md)') }, runs: {}, requests: {} } } });
  await mount(h(Chat, { bot }));
  await click(button('Index'));
  assert.ok(button('Nested report'));
  fetchResponse = () => new Response('<html>Nested report</html>', { status: 200 });
  await click(button('Nested report'));
  assert.ok(document.querySelector('iframe'));
  assert.deepEqual(calls.filter((call) => call.tag === 'assets.createUrl').map((call) => call.payload.resource.path), ['library/index.md', 'library/report.html']);
  assert.equal(calls.some((call) => call.tag === 'projects.readFile'), false);
});


test('Library lists workspace files and Pages without a file search control', async () => {
  const reads = [];
  rpc = async (tag, payload) => {
    reads.push({tag,payload});
    assert.equal(tag, 'projects.listEntries');
    return { entries: [{name:'report.html',path:'library/report.html',kind:'file'}, {name:'data.csv',path:'library/data.csv',kind:'file'}], truncated:false };
  };
  await mount(h(Library, { bot }));
  assert.equal(document.querySelector('[aria-label="Search files"]'), null);
  assert.equal(document.querySelector('input[type=checkbox]'), null);
  assert.equal(document.querySelectorAll('.library-row').length, 2);
  await click(button('Pages')); assert.equal(document.querySelectorAll('.library-row').length, 1); assert.match(container.textContent, /report.html/);
  await click(button('Files')); assert.equal(document.querySelectorAll('.library-row').length, 1); assert.match(container.textContent, /data.csv/);
  assert.equal(reads.length,1);
});

test('Library uses a fixed tab order, real transcript links, Image/Video thumbnails and exclusive Files', async () => {
  rpc = async (tag) => tag === 'assets.createUrl' ? { relativeUrl: '/api/assets/fixture?token=fixture' } : { entries: [
    { path: 'library/notes.txt', kind: 'file' }, { path: 'library/counter.html', kind: 'file' },
    { path: 'library/photo.png', kind: 'file' }, { path: 'library/clip.mp4', kind: 'file' },
  ], truncated: false };
  useApp.setState({ threadData: { main: { loaded: true, items: { message: message('[Documentation](https://example.com/docs) https://example.com/docs javascript:alert(1)') }, runs: {}, requests: {} } } });
  await mount(h(Library, { bot }));
  assert.deepEqual([...document.querySelectorAll('[role=tab]')].map(e => e.textContent), ['All', 'Pages', 'Media', 'Links', 'Files']);
  assert.equal(document.querySelectorAll('.library-row').length, 5);
  await click(button('Media'));
  assert.equal(document.querySelectorAll('.library-row').length, 2);
  assert.match(container.textContent, /Image/); assert.match(container.textContent, /Video/);
  assert.ok(document.querySelector('.library-row img[src^="/t3/"]'));
  assert.ok(document.querySelector('.library-row video[src^="/t3/"]'));
  await click(button('Files'));
  assert.equal(document.querySelectorAll('.library-row').length, 1);
  assert.match(container.textContent, /notes.txt/);
  await click(button('Links'));
  const links = [...document.querySelectorAll('.library-row')];
  assert.equal(links.length, 1);
  assert.equal(links[0].getAttribute('href'), 'https://example.com/docs');
  assert.equal(links[0].getAttribute('rel'), 'noreferrer');
  assert.match(links[0].textContent, /example.com/);
  await act(async () => { useApp.setState({ threadData: { main: { loaded: true, items: {}, runs: {}, requests: {} } } }); await flush(); });
  assert.equal(document.querySelectorAll('.library-row').length, 0, 'no invented links when the transcript has none');
});


test('CSV preview parses quoted cells and keeps markup as text', async () => {
  fetchResponse = () => new Response('name,value\n"A,B","<script>unsafe</script>"\nC,2', { status: 200 });
  await mount(h(WorkspaceResourceViewer, { resource: { _tag: 'workspace-file', threadId: 'main', path: 'library/sample.csv' }, title: 'sample.csv', onClose() {} }));
  assert.deepEqual([...document.querySelectorAll('.csv-preview td')].map((cell) => cell.textContent), ['A,B', '<script>unsafe</script>', 'C', '2']);
  assert.equal(document.querySelector('.csv-preview script'), null);
});


test('HTML previews keep scripts sandboxed and apply the current app theme to the actual signed content', async () => {
  document.documentElement.classList.add('dark');
  fetchResponse = () => new Response('<!doctype html><html><head></head><body><h1>Counter</h1><script>window.counter=0</script></body></html>', { status: 200 });
  await mount(h(WorkspaceResourceViewer, { resource: { _tag: 'workspace-file', threadId: 'main', path: 'library/counter.html' }, title: 'counter.html', onClose() {} }));
  const frame = document.querySelector('iframe');
  assert.equal(frame.getAttribute('sandbox'), 'allow-scripts'); assert.match(frame.srcdoc, /color-scheme:dark/); assert.match(frame.srcdoc, /window.counter=0/); assert.equal(document.querySelector('pre'), null);
  await act(async () => { document.documentElement.classList.remove('dark'); await flush(); });
  assert.match(frame.srcdoc, /color-scheme:light/);
});


test('audio streams the signed resource and native failures can retry without a prefetch', async () => {
  await mount(h(WorkspaceResourceViewer, { resource: { _tag: 'workspace-file', threadId: 'main', path: 'library/audio.wav' }, title: 'audio.wav', onClose() {} }));
  const audio = document.querySelector('audio');
  assert.ok(audio.controls);
  assert.equal(audio.getAttribute('src'), '/t3/assets/signed?token=fixture');
  assert.equal(audio.getAttribute('preload'), 'metadata');
  assert.deepEqual(fetches, []);
  await act(async () => audio.dispatchEvent(new Event('error')));
  assert.ok(button('Retry'));
  await click(button('Retry'));
  assert.equal(calls.filter(call => call.tag === 'assets.createUrl').length, 2);
  assert.ok(document.querySelector('audio'));
  assert.deepEqual(fetches, []);
});

test('a completed Library listing does not wait indefinitely for transcript history', async () => {
  useApp.setState({ threadData: { main: { loaded: false, items: {}, runs: {}, requests: {} } } });
  await mount(h(Library, { bot }));
  assert.doesNotMatch(container.textContent, /Loading…/);
  assert.match(container.textContent, /Files and Pages shared with Example appear here/);
});

test('Library ages and groups use actual timestamps and leave undated rows unlabeled', () => {
  const now = new Date('2026-10-31T12:00:00Z');
  assert.equal(libraryAge('2026-10-30T12:00:00Z', now), '1d');
  for (const at of ['', 'invalid', '2026-11-01T00:00:00Z']) assert.equal(libraryAge(at, now), null);
  const entries = ['2026-10-31T10:00:00Z', '2026-10-30T12:00:00Z', '2026-10-01T12:00:00Z', ''].map((at, i) => ({...workspaceLibraryFixture(i), at}));
  assert.deepEqual(libraryGroups(entries, now).map(group => group.label), ['Today', 'This week', 'Older', '']);
  assert.equal(workspaceListingEntries({entries:[{path:'library/undated.wav',kind:'file'}]}, workspace)[0].at, '');
});
function workspaceLibraryFixture(id) { return {kind:'file', id:String(id), title:'sample.txt', detail:'File', resource:{_tag:'workspace-file',threadId:'main',path:'library/sample.txt'}}; }
