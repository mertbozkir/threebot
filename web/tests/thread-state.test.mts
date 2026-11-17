import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { buildOnce, entryChunk } from './support.mts';
import { fileURLToPath } from "node:url";

globalThis.localStorage = { getItem: () => null, setItem() {} } as unknown as Storage;
globalThis.location = new URL('http://thread-state.test') as unknown as Location;
globalThis.window = { setInterval() {}, clearInterval() {} } as unknown as typeof window;
const src = fileURLToPath(new URL('../src/', import.meta.url));
const bundle = await buildOnce({ configFile: false, logLevel: 'silent', plugins: [{ name: 'thread-state',
  resolveId: id => id.endsWith('virtual:thread-state') ? '\0thread-state' : undefined,
  load: id => id === '\0thread-state' ? `export * from ${JSON.stringify(src + 'store.ts')}; export { t3 } from ${JSON.stringify(src + 'lib/t3.ts')}; export { api } from ${JSON.stringify(src + 'lib/api.ts')};` : undefined,
}], ssr: { noExternal: true }, build: { ssr: 'virtual:thread-state', write: false } });
const entry = entryChunk(bundle);
const { boot, useApp, t3, api, loadThreadFamily, loadOlderMessages, watchThread, conversationStatus, botStatus, botThreadStatus } = await import(`data:text/javascript;base64,${Buffer.from(entry.code).toString('base64')}`);
const streams = new Map(); const payloads = new Map(); let reconnect;
t3.onState = () => () => {};
t3.onReconnect = fn => { reconnect = fn; return () => {}; };
t3.connect = () => {};
t3.stream = (tag, payload, receive) => { streams.set(tag, receive); payloads.set(tag, payload); return { cancel() {}, done: new Promise(() => {}), live: () => false }; };
t3.call = async tag => tag === 'server.getConfig' ? { providers: [] } : { threads: [] };
api.session = async () => ({ authenticated: true }); api.config = async () => ({}); api.settings = async () => ({}); api.bots = async () => []; api.botIdentities = async () => [];
globalThis.fetch = async () => Response.json([]);
await boot(); reconnect();
const root = { id: 'root', title: 'Root', status: 'completed', lineage: { parentThreadId: null }, updatedAt: '2026-01-01T00:00:00Z' };
const child = { id: 'child', title: 'Child', status: 'idle', lineage: { parentThreadId: 'root', relationshipToParent: 'subagent' }, settledOverride: null, settledAt: null, updatedAt: root.updatedAt };
const shell = snapshot => streams.get('orchestration.subscribeShell')({ kind: 'snapshot', snapshot: { projects: [], threads: snapshot } });
after(() => { shell([]); });

test('family children survive omitted shell snapshots and concurrent reads share one request', async () => {
  let resolve, calls = 0;
  t3.call = (tag) => { assert.equal(tag, 'orchestration.getThreadFamily'); calls++; return new Promise(done => { resolve = done; }); };
  const first = loadThreadFamily('root'), second = loadThreadFamily('root');
  assert.equal(calls, 1); resolve({ threads: [root, child] }); await Promise.all([first, second]);
  shell([root]); assert.equal(useApp.getState().threads.child.id, 'child');
  shell([]); assert.equal(useApp.getState().threads.child.id, 'child'); assert.equal(useApp.getState().threads.root, undefined, 'an empty authoritative shell removes absent roots');
  streams.get('orchestration.subscribeShell')({ kind: 'thread.removed', threadId: 'child' });
  assert.equal(useApp.getState().threads.child, undefined);
});

test('a Bot keeps its main thread through a shell snapshot that omits it', () => {
  useApp.setState({ bots: { money: { slug: 'money', mainThreadId: 'root' } }, threads: { root } });
  shell([]);
  assert.equal(useApp.getState().threads.root?.id, 'root');
  streams.get('orchestration.subscribeShell')({ kind: 'thread.removed', threadId: 'root' });
  assert.equal(useApp.getState().threads.root, undefined, 'an explicit removal still wins');
  useApp.setState({ bots: {} });
});

test('subagent snapshot and updates resolve native idle children without a turn-item resend', () => {
  useApp.setState({ threads: { root, child } });
  const stop = watchThread('root'); const receive = streams.get('orchestration.subscribeThread');
  const agent = { id: 'agent', childThreadId: 'child', status: 'running', updatedAt: root.updatedAt };
  t3.call = async () => ({ threads: [root, child] });
  receive({ kind: 'snapshot', projection: { thread: root, turnItems: [], runs: [], subagents: [agent] } });
  assert.equal(conversationStatus('child'), 'running');
  receive({ kind: 'event', event: { type: 'subagent.updated', payload: { ...agent, status: 'completed', updatedAt: '2026-01-02T00:00:00Z' } } });
  assert.equal(conversationStatus('child'), 'completed'); stop();
});

test('settled and unsettled lifecycle events reach Details state and settled Bots are done', () => {
  useApp.setState({ threads: { root } });
  const stop = watchThread('root'); const receive = streams.get('orchestration.subscribeThread');
  receive({ kind: 'event', event: { type: 'thread.settled', payload: { ...root, settledOverride: 'settled', settledAt: root.updatedAt, unsettledAt: null } } });
  assert.equal(conversationStatus('root'), 'completed'); assert.equal(botStatus({ mainThreadId: 'root' }), 'done');
  receive({ kind: 'event', event: { type: 'thread.unsettled', payload: { ...root, status: 'idle', settledOverride: 'active', settledAt: null, unsettledAt: '2026-01-02T00:00:00Z' } } });
  assert.equal(conversationStatus('root'), 'idle'); assert.equal(botStatus({ mainThreadId: 'root' }), 'idle'); stop();
});

test('a settled Bot whose last reply was never read stays unread', () => {
  const settled = { ...root, settledOverride: 'settled', settledAt: '2026-01-09T00:00:00Z', latestRunCompletedAt: '2026-01-02T00:00:00Z', lastVisitedAt: '2026-01-01T00:00:00Z' };
  useApp.setState({ threads: { root: settled }, selected: null });
  assert.equal(botStatus({ slug: 'money', mainThreadId: 'root' }), 'unread');
  useApp.setState({ threads: { root: { ...settled, lastVisitedAt: '2026-01-03T00:00:00Z' } } });
  assert.equal(botStatus({ slug: 'money', mainThreadId: 'root' }), 'done');
});

test('with Beta → Settle Bot threads on, a settled Bot reads as idle, not finished', () => {
  const settled = { ...root, settledOverride: 'settled', settledAt: '2026-01-09T00:00:00Z', latestRunCompletedAt: '2026-01-02T00:00:00Z', lastVisitedAt: '2026-01-03T00:00:00Z' };
  useApp.setState({ threads: { root: settled }, selected: null, settings: { beta: { projects: false, settleBotThreads: true } } as never });
  assert.equal(botStatus({ slug: 'money', mainThreadId: 'root' }), 'idle');
  useApp.setState({ settings: { beta: { projects: false, settleBotThreads: false } } as never });
  assert.equal(botStatus({ slug: 'money', mainThreadId: 'root' }), 'done');
  useApp.setState({ settings: null as never });
});

test('with Beta → Settle Bot threads on, Details reads a settled main thread as idle and a settled subagent as done', () => {
  const settled = { ...root, settledOverride: 'settled', settledAt: '2026-01-09T00:00:00Z' };
  useApp.setState({ threads: { root: settled }, settings: { beta: { projects: false, settleBotThreads: true } } as never });
  assert.equal(botThreadStatus({ mainThreadId: 'root' }, 'root'), 'idle');
  assert.equal(botThreadStatus({ mainThreadId: 'other' }, 'root'), 'completed');
  useApp.setState({ settings: null as never });
  assert.equal(botThreadStatus({ mainThreadId: 'root' }, 'root'), 'completed');
});

test('a long thread opens bounded, resumes from its last sequence, and loads older rows by cursor', async () => {
  useApp.setState({ threads: { root } });
  let stop = watchThread('root');
  assert.equal(payloads.get('orchestration.subscribeThread').acceptBoundedSnapshot, true);
  assert.equal(payloads.get('orchestration.subscribeThread').afterSequence, undefined, 'a first open takes a snapshot');
  const item = (id, text) => ({ id, type: 'assistant_message', text });
  streams.get('orchestration.subscribeThread')({ kind: 'snapshot', snapshotSequence: 10, historyCursor: 'c1', hasMoreHistory: true, projection: { thread: root, visibleTurnItems: [{ item: item('new', 'recent') }], runs: [], subagents: [] } });
  assert.deepEqual([useApp.getState().threadData.root.hasMoreHistory, useApp.getState().threadData.root.historyCursor], [true, 'c1']);
  streams.get('orchestration.subscribeThread')({ kind: 'event', sequence: 12, event: { type: 'turn-item.updated', payload: item('newer', 'live') } });
  stop();
  stop = watchThread('root');
  assert.equal(payloads.get('orchestration.subscribeThread').afterSequence, 12, 'reopening replays events after the last one seen');
  const requested = [];
  globalThis.fetch = async (url) => { requested.push(String(url)); return Response.json({ items: [{ item: item('old', 'older') }], nextCursor: null, hasMoreHistory: false }); };
  assert.equal(await loadOlderMessages('root'), true);
  assert.match(requested[0], /\/t3\/api\/orchestration\/threads\/root\/history\?cursor=c1$/);
  const data = useApp.getState().threadData.root;
  assert.deepEqual(Object.keys(data.items).sort(), ['new', 'newer', 'old']);
  assert.equal(data.hasMoreHistory, false);
  assert.equal(await loadOlderMessages('root'), false, 'nothing more to load');
  globalThis.fetch = async () => Response.json([]);
  stop();
});

test('rooms read whole histories, and a history page from an older snapshot is dropped', async () => {
  useApp.setState({ threads: { root } });
  const stop = watchThread('room-member', false);
  assert.equal(payloads.get('orchestration.subscribeThread').acceptBoundedSnapshot, undefined);
  stop();
  const stopRoot = watchThread('root');
  const receive = streams.get('orchestration.subscribeThread');
  receive({ kind: 'snapshot', snapshotSequence: 20, historyCursor: 'c2', hasMoreHistory: true, projection: { thread: root, visibleTurnItems: [{ item: { id: 'x', type: 'assistant_message', text: 'x' } }], turnItems: [{ id: 'stop', type: 'run_interrupt_request' }], runs: [], subagents: [] } });
  assert.ok(useApp.getState().threadData.root.items.stop, 'interrupt requests kept only in turnItems survive');
  let answer;
  globalThis.fetch = () => new Promise<Response>((resolve) => { answer = resolve; });
  const pending = loadOlderMessages('root');
  receive({ kind: 'snapshot', snapshotSequence: 30, historyCursor: 'c3', hasMoreHistory: true, projection: { thread: root, visibleTurnItems: [], runs: [], subagents: [] } });
  answer(Response.json({ items: [{ item: { id: 'stale', type: 'assistant_message', text: 's' } }], nextCursor: null, hasMoreHistory: false }));
  assert.equal(await pending, false);
  assert.equal(useApp.getState().threadData.root.historyCursor, 'c3', 'the newer snapshot keeps its cursor');
  globalThis.fetch = async () => Response.json([]);
  stopRoot();
});

test('a room opened on a thread its chat already reads bounded reopens it with the whole history', async () => {
  useApp.setState({ threads: { root } });
  const stopChat = watchThread('shared');
  assert.equal(payloads.get('orchestration.subscribeThread').acceptBoundedSnapshot, true);
  streams.get('orchestration.subscribeThread')({ kind: 'snapshot', snapshotSequence: 5, historyCursor: 'c', hasMoreHistory: true, projection: { thread: root, visibleTurnItems: [], runs: [], subagents: [] } });
  const stopRoom = watchThread('shared', false);
  const reopened = payloads.get('orchestration.subscribeThread');
  assert.equal(reopened.acceptBoundedSnapshot, undefined, 'the room gets a full snapshot');
  assert.equal(reopened.afterSequence, undefined, 'a partial thread is not resumed from its bounded sequence');
  stopRoom();
  stopChat();
});

test('a history page never merges rows that name another thread', async () => {
  useApp.setState({ threads: { root } });
  const stop = watchThread('root');
  streams.get('orchestration.subscribeThread')({ kind: 'snapshot', snapshotSequence: 40, historyCursor: 'c4', hasMoreHistory: true, projection: { thread: root, visibleTurnItems: [], runs: [], subagents: [] } });
  globalThis.fetch = async () => Response.json({ items: [{ item: { id: 'mine', threadId: 'root', type: 'assistant_message', text: 'a' } }, { item: { id: 'foreign', threadId: 'other', type: 'assistant_message', text: 'b' } }], nextCursor: null, hasMoreHistory: false });
  assert.equal(await loadOlderMessages('root'), true);
  const items = useApp.getState().threadData.root.items;
  assert.ok(items.mine);
  assert.equal(items.foreign, undefined);
  globalThis.fetch = async () => Response.json([]);
  stop();
});
