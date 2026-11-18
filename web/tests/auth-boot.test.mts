import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, mock, test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MessageChannel } from 'node:worker_threads';
import { Window } from 'happy-dom';
import { buildOnce, domWindow } from './support.mts';
import { fileURLToPath } from "node:url";
const channels = [];
globalThis.MessageChannel = class extends MessageChannel { constructor() { super(); channels.push(this); } };
const window = domWindow(new Window({ url: 'https://bot.example/?bot=sample&thread=thread-sample', width: 390, height: 844, settings: { device: { prefersReducedMotion: 'reduce' } } }));
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'localStorage', 'location', 'history', 'requestAnimationFrame', 'cancelAnimationFrame', 'IntersectionObserver', 'ResizeObserver']) Object.defineProperty(globalThis, key, { configurable: true, value: window[key] });
globalThis.matchMedia = window.matchMedia.bind(window);
globalThis.getComputedStyle = window.getComputedStyle.bind(window); globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const directory = await mkdtemp(join(tmpdir(), 'bot-auth-boot-'));
const src = fileURLToPath(new URL('../src/', import.meta.url));
const bundle = await buildOnce({ configFile: false, logLevel: 'silent', define: { 'process.env.NODE_ENV': '"development"' }, ssr: { noExternal: true },
 plugins: [{ name: 'auth-boot-test', resolveId: id => id.endsWith('virtual:auth-boot') ? '\0auth-boot' : undefined,
 load: id => id === '\0auth-boot' ? `export { createElement as h, act, StrictMode } from 'react'; export { createRoot } from 'react-dom/client'; export { default as App } from ${JSON.stringify(`${src}App.tsx`)}; export { boot, useApp } from ${JSON.stringify(`${src}store.ts`)}; export { api } from ${JSON.stringify(`${src}lib/api.ts`)}; export { t3 } from ${JSON.stringify(`${src}lib/t3.ts`)};` : undefined }],
 build: { ssr: 'virtual:auth-boot', write: false, rollupOptions: { output: { entryFileNames: 'entry.mjs', inlineDynamicImports: true } } } });
for (const output of bundle.output) { const file = join(directory, output.fileName); await mkdir(dirname(file), { recursive: true }); await writeFile(file, output.type === 'chunk' ? output.code : output.source); }
let serial = 0, app, root, host, handler, calls, runtime, intervals;
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => Promise.withResolvers();
const settings = { userName: 'Sample', theme: 'light', accent: 'bot', timezone: 'UTC', sections: [], autoReview: true, rules: { alwaysAsk: [], allowWithoutAsking: [] } };
const originalInterval = window.setInterval;
beforeEach(async () => {
 localStorage.clear(); calls = []; runtime = { states: 0, reconnects: 0, connects: 0 }; intervals = [];
 window.setInterval = (fn, delay) => { intervals.push({ fn, delay }); return intervals.length; };
 app = await import(`${pathToFileURL(join(directory, 'entry.mjs')).href}?test=${++serial}`);
 app.t3.onState = () => { runtime.states++; return () => {}; }; app.t3.onReconnect = () => { runtime.reconnects++; return () => {}; }; app.t3.connect = () => { runtime.connects++; };
 handler = async url => {
  if (url === '/api/session') return Response.json({ authenticated: true, passwordRequired: false, accessLogin: true });
  if (url === '/api/config') return Response.json({ botsRoot: '/generic/bots', executorUrl: null });
  if (url === '/api/settings') return Response.json(settings);
  if (url === '/api/bots' || url === '/api/bot-identities') return Response.json({ bots: [] });
  if (url === '/api/vault') return Response.json([]);
  throw new Error(`Unexpected request ${url}`);
 };
 globalThis.fetch = async (url, init = {}) => { calls.push({ url, ...init }); return handler(url, init); };
 host = document.createElement('main'); document.body.append(host); root = app.createRoot(host);
});
afterEach(async () => { await app.act(async () => root.unmount()); host.remove(); window.setInterval = originalInterval; });
after(async () => { for (const channel of channels) { channel.port1.close(); channel.port2.close(); } await window.happyDOM.close(); await rm(directory, { recursive: true }); });
const render = (strict = false) => app.act(async () => { root.render(strict ? app.h(app.StrictMode, {}, app.h(app.App)) : app.h(app.App)); await flush(); });
const click = label => app.act(async () => { const b = [...document.querySelectorAll('button')].find(e => e.textContent.trim() === label); assert.ok(b, label); b.click(); await flush(); });

test('session network failure never guesses password login and offers retry', async () => {
 handler = async () => { throw new Error('private transport detail'); }; await render();
 assert.equal(document.querySelector('input[type=password]'), null); assert.match(document.body.textContent, /Couldn't load Bot/); assert.ok([...document.querySelectorAll('button')].some(e => e.textContent.trim() === 'Try again')); assert.doesNotMatch(document.body.innerHTML, /private transport detail/);
});
test('session loading never flashes a password form', async () => {
 const wait = deferred(); handler = () => wait.promise; await render(); assert.equal(document.querySelector('input[type=password]'), null); assert.ok(document.querySelector('[role=status]'));
 await app.act(async () => { wait.resolve(Response.json({ authenticated: false, passwordRequired: false, accessLogin: true })); await flush(); });
 assert.equal(document.querySelector('input[type=password]'), null); assert.match(document.body.textContent, /Sign in with Cloudflare/);
});
for (const [name, response] of ([
 ['HTML login response', () => new Response('<html>private login form</html>', { headers: { 'content-type': 'text/html' } })],
 ['empty object', () => Response.json({})],
 ['invalid field types', () => Response.json({ authenticated: 'yes', passwordRequired: false, accessLogin: true })],
 ['missing mode', () => Response.json({ authenticated: false, passwordRequired: false })],
 ['redirected response', () => { const r = Response.json({ authenticated: true, passwordRequired: false, accessLogin: true }); Object.defineProperty(r, 'redirected', { value: true }); return r; }],
] satisfies [string, () => Response][])) test(`session boundary rejects ${name} instead of guessing a mode`, async () => {
 handler = async () => response(); await assert.rejects(app.api.session()); await render(); assert.equal(document.querySelector('input[type=password]'), null); assert.match(document.body.textContent, /Couldn't load Bot/);
});
test('an Access redirect on an expired session offers sign-in instead of a load error', async () => {
 const redirect = new Response(null, { status: 200 }); Object.defineProperty(redirect, 'type', { value: 'opaqueredirect' });
 handler = async () => redirect; await render();
 assert.ok([...document.querySelectorAll('a')].some(e => e.textContent.trim() === 'Sign in with Cloudflare')); assert.doesNotMatch(document.body.textContent, /Couldn't load Bot/);
 assert.equal(calls.find(c => c.url === '/api/session').redirect, 'manual');
});
test('a session that ends while the app is open offers sign-in', async () => {
 await render(); const refresh = intervals.find(i => i.delay === 5_000); assert.ok(refresh);
 const redirect = new Response(null, { status: 200 }); Object.defineProperty(redirect, 'type', { value: 'opaqueredirect' });
 handler = async url => { if (url === '/api/session') return redirect; throw new TypeError('Failed to fetch'); };
 await app.act(async () => { refresh.fn(); await flush(); await flush(); });
 assert.ok([...document.querySelectorAll('a')].some(e => e.textContent.trim() === 'Sign in with Cloudflare'));
});
for (const [next, expected] of [['%2F%3Fbot%3Dsample', '/?bot=sample'], ['https%3A%2F%2Fevil.example%2F', '/'], ['%2F%2Fevil.example%2F', '/']]) test(`returning from Cloudflare with next=${next} stays on this origin`, async () => {
 const start = location.pathname + location.search; history.replaceState(null, '', `/login?next=${next}`);
 const replace = history.replaceState, targets = []; history.replaceState = function (state, title, url) { targets.push(String(url)); return replace.call(this, state, title, url); };
 try { await render(); assert.equal(targets[0], expected); } finally { history.replaceState = replace; history.replaceState(null, '', start); }
});
test('confirmed Cloudflare sign-out preserves requested route without password', async () => {
 handler = async () => Response.json({ authenticated: false, passwordRequired: false, accessLogin: true }); await render();
 const link = [...document.querySelectorAll('a')].find(e => e.textContent.trim() === 'Sign in with Cloudflare'); assert.ok(link); assert.equal(link.origin, location.origin); assert.equal(link.pathname, '/login'); assert.equal(new URLSearchParams(link.search).get('next'), location.pathname + location.search); assert.equal(document.querySelector('input[type=password]'), null); assert.equal(calls.filter(c => c.url === '/api/session').length, 1);
});
test('only confirmed password mode offers a password, without autofocus', async () => {
 handler = async () => Response.json({ authenticated: false, passwordRequired: true, accessLogin: false }); await render(); const input = document.querySelector('input[type=password]'); assert.ok(input); assert.equal(input.hasAttribute('autofocus'), false); assert.notEqual(document.activeElement, input);
});
test('Cloudflare remains primary when both sign-in modes are enabled', async () => {
 handler = async () => Response.json({ authenticated: false, passwordRequired: true, accessLogin: true }); await render(); assert.match(document.body.textContent, /Sign in with Cloudflare/); assert.equal(document.querySelector('input[type=password]'), null);
});
test('failed bootstrap is caught and retry reaches ready without duplicate setup', async () => {
 const original = handler; let failing = true; handler = (url, init) => url === '/api/settings' && failing ? Promise.reject(new Error('private settings failure')) : original(url, init);
 await app.act(async () => { await app.boot(); }); await render(); assert.match(document.body.textContent, /Couldn't load Bot/); assert.equal(runtime.connects, 0);
 failing = false; await click('Try again'); assert.equal(app.useApp.getState().auth, 'ready'); assert.match(document.body.textContent, /Meet your first Bot/);
 await app.boot(); assert.deepEqual(runtime, { states: 1, reconnects: 1, connects: 1 }); assert.equal(intervals.filter(i => i.delay === 5000).length, 1);
});
test('overlapping boot and StrictMode mounts share startup', async () => {
 const wait = deferred(), original = handler; handler = (url, init) => url === '/api/session' ? wait.promise : original(url, init);
 const first = app.boot(), second = app.boot(); await render(true); assert.equal(calls.filter(c => c.url === '/api/session').length, 1);
 await app.act(async () => { wait.resolve(Response.json({ authenticated: true, passwordRequired: false, accessLogin: true })); await Promise.all([first, second]); await flush(); });
 assert.equal(app.useApp.getState().auth, 'ready'); assert.deepEqual(runtime, { states: 1, reconnects: 1, connects: 1 }); assert.equal(calls.filter(c => c.url === '/api/config').length, 1); assert.equal(intervals.filter(i => i.delay === 5000).length, 1);
});


test('a stalled initial GET times out; retry succeeds and a late old response cannot replace it', async () => {
 const original = handler, old = deferred(); let first = true;
 handler = (url, init) => url === '/api/config' ? first ? old.promise : Response.json({ botsRoot: '/current/bots', executorUrl: null }) : original(url, init);
 mock.timers.enable({ apis: ['setTimeout'] });
 try {
  const attempt = app.boot(); await flush(); await flush();
  const oldCall = calls.find(c => c.url === '/api/config'); assert.ok(oldCall?.signal);
  mock.timers.tick(14999); assert.equal(app.useApp.getState().auth, 'loading');
  mock.timers.tick(1); await attempt; assert.equal(app.useApp.getState().auth, 'error'); assert.equal(oldCall.signal.aborted, true);
  first = false; await app.boot(); assert.equal(app.useApp.getState().auth, 'ready'); assert.equal(app.useApp.getState().botsRoot, '/current/bots');
  old.resolve(Response.json({ botsRoot: '/stale/bots', executorUrl: null })); await flush();
  assert.equal(app.useApp.getState().auth, 'ready'); assert.equal(app.useApp.getState().botsRoot, '/current/bots'); assert.deepEqual(runtime, { states: 1, reconnects: 1, connects: 1 });
 } finally { mock.timers.reset(); }
});
