import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { ADOPT_REPO, createFixture, gatewayInvocation, smokeFixture } from './fixture.mts';
import { FIXTURE_PAIRING_CODE, startFakeT3, type FixtureLink } from './fixture-t3.mts';
import { APPROVAL_OPTIONS, DUMMY_SECRET, INITIAL_ANSWER, INTERACTION_IDS, fixtureReleases } from './fixture-scenarios.mts';
import { T3Client } from '../server/t3rpc.mts';
import { EXECUTOR_FIXTURE_IDS, EXECUTOR_FIXTURE_TOKEN } from './fixture-executor.mts';

// Projections, inspection bodies, bundles and RPC results are untyped JSON from the fixture
// servers and the real gateway; the assertions below check their shape.
type Json = any;

test('real built frontend and gateway persist selection/settings, proxy fixture RPC, reset and clean up', { timeout: 30000 }, async () => {
  const fixture = await createFixture();
  try {
    const html = await (await fetch(fixture.url)).text();
    const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^" ]+)"/g)].map((match) => match[1]);
    assert.ok(assets.some((asset) => asset.endsWith('.js')));
    assert.ok(assets.some((asset) => asset.endsWith('.css')));
    for (const asset of assets) {
      const response = await fetch(fixture.url + asset);
      assert.equal(response.status, 200);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), await readFile(new URL('../web/dist' + asset, import.meta.url)));
    }
    await smokeFixture(fixture);
  } finally { await fixture.close(); }
  await assert.rejects(access(fixture.root), { code: 'ENOENT' });
  await assert.rejects(fetch(fixture.url, { signal: AbortSignal.timeout(1000) }));
});

test('the landing page is served by itself and shares nothing with the app', { timeout: 15000 }, async () => {
  const fixture = await createFixture();
  try {
    for (const route of ['/welcome', '/welcome/']) {
      const response = await fetch(fixture.url + route);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type')!, /text\/html/);
      const html = await response.text();
      assert.match(html, /<title>Threebot:/);
      assert.doesNotMatch(html, /\/assets\//, 'public page must not load the app bundle');
    }
    // The page's own pictures and font are public too; nothing else under the path is.
    const image = await fetch(fixture.url + '/welcome/img/ball.webp');
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('content-type'), 'image/webp');
    const font = await fetch(fixture.url + '/welcome/fonts/rubik.woff2');
    assert.equal(font.status, 200);
    assert.equal(font.headers.get('content-type'), 'font/woff2');
    // Cloudflare leaves this whole path public, so nothing from the app may answer under it.
    for (const route of ['/welcome/img/gone.webp', '/welcome/fonts/gone.woff2', '/welcome/anything', '/welcome/..%2findex.html', '/welcome/..%2Fsw.js', '/welcome/..%5cindex.html', '/welcome/..%2fapi/bots', '/welcome/%2e%2e%2fassets/x.js', '/welcome%2f..%2findex.html', '/welcome/img/..%2f..%2findex.html', '/welcome/img/%2e%2e/index.html', '/welcome/img/../index.html', '/welcome/fonts/x/y.woff2']) {
      const response = await fetch(fixture.url + route);
      assert.equal(response.status, 404, route);
      assert.doesNotMatch(await response.text(), /\/assets\/|BOT_BUILD|caches\.open/, route);
    }
    assert.doesNotMatch(await (await fetch(fixture.url + '/')).text(), /Personal agents that are/);
    assert.doesNotMatch(await (await fetch(fixture.url + '/some-chat')).text(), /Personal agents that are/);
  } finally { await fixture.close(); }
});

test('gateway permissions deny writes and reads outside fixture and deny subprocesses', { timeout: 15000 }, async () => {
  const outside = await mkdtemp(path.join(tmpdir(), 'bot-parity-outside-'));
  const fixture = await createFixture();
  try {
    const sentinel = path.join(outside, 'sentinel.txt');
    await writeFile(sentinel, 'unchanged');
    const { command, args, env } = gatewayInvocation(fixture.root, 12345, 12346);
    assert.equal(env.HOME, path.join(fixture.root, 'home'));
    assert.equal(env.CODEX_HOME, path.join(fixture.root, 'codex'));
    assert.equal(env.HOST, '127.0.0.1');
    assert.equal(env.T3_URL, 'http://127.0.0.1:12346');
    for (const key of ['NODE_OPTIONS', 'CF_ACCESS_TEAM_DOMAIN', 'EXECUTOR_TOKEN', 'T3_CLI', 'HTTPS_PROXY']) assert.equal((env as Record<string, string | undefined>)[key], undefined);
    const probe = `
      const assert = require('node:assert/strict');
      const fs = require('node:fs');
      const { spawn } = require('node:child_process');
      const [inside, outside] = process.argv.slice(1);
      fs.writeFileSync(inside, 'allowed');
      const denied = (error) => ['ERR_ACCESS_DENIED', 'EPERM', 'EACCES'].includes(error.code);
      assert.throws(() => fs.writeFileSync(outside, 'forbidden'), denied);
      assert.throws(() => fs.readFileSync(outside), denied);
      assert.throws(() => spawn(process.execPath, ['-e', '']), denied);
      console.log('permissions enforced');
    `;
    const child = spawn(command, [...args.slice(0, -1), '-e', probe, path.join(fixture.root, 'allowed.txt'), sentinel], { cwd: fixture.root, env });
    let output = '';
    child.stdout.on('data', (data) => { output += data; });
    child.stderr.on('data', (data) => { output += data; });
    const [code] = await once(child, 'exit');
    assert.equal(code, 0, output);
    assert.match(output, /permissions enforced/);
    assert.equal(await readFile(sentinel, 'utf8'), 'unchanged');
    assert.equal(await readFile(path.join(fixture.root, 'allowed.txt'), 'utf8'), 'allowed');
  } finally { await fixture.close(); await rm(outside, { recursive: true, force: true }); }
});

test('real Vault contact and login writes are encrypted and survive gateway restart', {
  timeout: 30000, skip: process.platform !== 'darwin' && 'Node permissions forbid fsync; durable Vault fixture requires macOS sandbox-exec',
}, async () => {
  const fixture = await createFixture();
  try {
    assert.equal(fixture.isolation, 'macos-sandbox');
    const contact = await fixture.request('/api/vault', 'POST', { type: 'contact', title: 'Generic Contact', name: 'Generic Person' });
    assert.equal(contact.status, 200, JSON.stringify(contact.body));
    const password = 'generic-fixture-value-not-a-real-credential';
    const login = await fixture.request('/api/vault', 'POST', { type: 'login', title: 'Generic Login', website: 'example.invalid', username: 'fixture', password });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    assert.equal(login.body.hasPassword, true);
    assert.equal(login.body.password, undefined);
    const ciphertext = await readFile(path.join(fixture.root, 'vault', 'vault.enc'), 'utf8');
    assert.equal(JSON.parse(ciphertext).cipher, 'aes-256-gcm');
    assert.ok(!ciphertext.includes(password));
    assert.ok(!ciphertext.includes('Generic Person'));
    await fixture.restart();
    const list = await fixture.request('/api/vault');
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.items.map(({ id }: Json) => id), [contact.body.id, login.body.id]);
    assert.equal(list.body.items[0].name, 'Generic Person');
    assert.equal(list.body.items[1].password, undefined);
    assert.equal((await fixture.request(`/api/vault/${login.body.id}?reveal=1`)).body.password, password);
    assert.equal((await fixture.request(`/api/vault/${contact.body.id}`, 'PUT', { name: 'Edited Generic Person' })).status, 200);
    await fixture.restart();
    assert.equal((await fixture.request(`/api/vault/${contact.body.id}`)).body.name, 'Edited Generic Person');
    assert.equal((await fixture.request(`/api/vault/${login.body.id}`, 'DELETE')).status, 200);
    await fixture.restart();
    assert.equal((await fixture.request(`/api/vault/${login.body.id}`)).status, 404);
    await fixture.reset();
    assert.deepEqual((await fixture.request('/api/vault')).body.items, []);
  } finally { await fixture.close(); }
});

test('an occupied port fails without stopping the existing server', { timeout: 15000 }, async () => {
  const server = http.createServer((_req, res) => res.end('other server stays alive'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    await assert.rejects(createFixture({ port }), /EADDRINUSE|Gateway exited/);
    assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), 'other server stays alive');
  } finally { await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }); }
});

test('foreground CLI restarts/resets on command and SIGTERM removes only its own fixture', { timeout: 20000 }, async () => {
  const child = spawn(process.execPath, [new URL('./fixture.mts', import.meta.url).pathname], { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  let fixtureRoot;
  const lineWaiters = new Set<() => void>();
  child.stdout.on('data', (data) => {
    output += data;
    for (const waiter of lineWaiters) waiter();
  });
  child.stderr.on('data', (data) => { output += data; });
  const waitFor = (pattern: RegExp) => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { lineWaiters.delete(check); reject(new Error(`CLI output missing ${pattern}\n${output}`)); }, 8000);
    const check = () => { if (pattern.test(output)) { clearTimeout(timer); lineWaiters.delete(check); resolve(); } };
    lineWaiters.add(check);
    check();
  });
  try {
    await waitFor(/Commands: restart/);
    fixtureRoot = /Fixture directory: (.+)/.exec(output)![1];
    const url = /Local URL: (.+)/.exec(output)![1];
    assert.equal((await fetch(url + '/api/session')).status, 200);
    child.stdin.write('restart\n');
    await waitFor(/Ready:/);
    output = '';
    child.stdin.write('reset\n');
    await waitFor(/Ready:/);
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    const [code] = await exited;
    assert.equal(code, 0, output);
    await assert.rejects(access(fixtureRoot), { code: 'ENOENT' });
    await assert.rejects(fetch(url, { signal: AbortSignal.timeout(1000) }));
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    }
  }
});

const bounded = <T,>(promise: Promise<T>) => new Promise<T>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Fixture test RPC timed out')), 5000);
  promise.then(resolve, reject).finally(() => clearTimeout(timer));
});

function watchThread(rpc: T3Client, threadId: string) {
  let latest: Json;
  const waiting = new Set<() => void>();
  const stream = rpc.stream('orchestration.subscribeThread', { threadId }, (event) => {
    assert.equal(event.kind, 'snapshot');
    latest = event.projection;
    for (const check of waiting) check();
  });
  return {
    stream,
    wait(predicate: (projection: Json) => boolean = () => true) {
      return new Promise<Json>((resolve, reject) => {
        const timer = setTimeout(() => { waiting.delete(check); reject(new Error('Fixture snapshot timed out')); }, 5000);
        const check = () => {
          if (latest && predicate(latest)) { clearTimeout(timer); waiting.delete(check); resolve(latest); }
        };
        waiting.add(check);
        check();
      });
    },
  };
}

test('activity scenario shows Bots in different activities and walks Alpha through a turn', { timeout: 20000 }, async () => {
  const fake = await startFakeT3('/unused', 0, { scenario: 'activity' });
  const rpc = new T3Client({ baseUrl: `http://127.0.0.1:${fake.port}`, token: 'fixture-only' });
  try {
    await bounded(rpc.connect());
    const watched = watchThread(rpc, 'thread-alpha');
    const first = await watched.wait();
    const shells = Object.fromEntries((await bounded(rpc.call('orchestration.getThreadFamily', { threadId: 'thread-delta' }))).threads.map((t: Json) => [t.id, t]));
    assert.ok(shells['thread-delta'].pendingRuntimeRequest);
    const live = (projection: Json) => projection.turnItems.filter((item: Json) => item.runId && item.status === 'running').map((item: Json) => item.type);
    assert.deepEqual(live(first), ['reasoning']);
    const next = await watched.wait((projection) => live(projection)[0] === 'web_search');
    assert.equal(next.thread.status, 'running');
    watched.stream.cancel();
  } finally { rpc.close(); await fake.close(); }
});

test('basic protocol remains unchanged and interaction handlers are opt-in', { timeout: 15000 }, async () => {
  await assert.rejects(startFakeT3('/unused', 0, { scenario: 'unknown' }), /Scenario must be basic, interactions, executor, library, landing, latest-t3, avatars, activity, adopt or release-notes/);
  await assert.rejects(createFixture({ scenario: 'unknown' }), /Scenario must be basic, interactions, executor, library, landing, latest-t3, avatars, activity, adopt or release-notes/);
  const fake = await startFakeT3('/unused');
  const rpc = new T3Client({ baseUrl: `http://127.0.0.1:${fake.port}`, token: 'fixture-only' });
  try {
    await bounded(rpc.connect());
    const watched = watchThread(rpc, 'thread-alpha');
    const projection = await watched.wait();
    assert.equal(projection.turnItems.length, 3);
    assert.deepEqual(projection.runtimeRequests, []);
    assert.equal(projection.thread.pendingRuntimeRequest, null);
    assert.equal(projection.turnItems[2].childThreadId, 'thread-alpha-child');
    assert.equal((await fetch(`http://127.0.0.1:${fake.port}/fixture/interactions`)).status, 501);
    await assert.rejects(bounded(rpc.dispatch({ type: 'runtime-request.respond', threadId: 'thread-alpha', requestId: INTERACTION_IDS.initial, answers: { draft: 'Generic' } })), /Unavailable in local fixture/);
    await assert.rejects(bounded(rpc.call('secrets.answerRequest', { threadId: 'thread-alpha', turnItemId: INTERACTION_IDS.save, answer: { type: 'decline' } })), /Unavailable in local fixture/);
    watched.stream.cancel();
  } finally { rpc.close(); await fake.close(); }
  await assert.rejects(fetch(`http://127.0.0.1:${fake.port}/api/projects`, { signal: AbortSignal.timeout(1000) }));
});

test('interactions use exact paired messages and runtime cards through the real gateway, with sanitized retry and terminal snapshots', { timeout: 45000 }, async () => {
  const fixture = await createFixture({ scenario: 'interactions' });
  let rpc!: T3Client;
  const streams: ReturnType<T3Client['stream']>[] = [];
  const connect = async () => {
    rpc = new T3Client({ baseUrl: fixture.url + '/t3', token: 'fixture-only' });
    await bounded(rpc.connect());
    const watched = Object.fromEntries(['alpha', 'beta', 'gamma'].map((slug) => {
      const watch = watchThread(rpc, `thread-${slug}`); streams.push(watch.stream); return [slug, watch];
    }));
    return watched;
  };
  const inspect = async () => {
    const response = await fixture.request('/t3/fixture/interactions');
    assert.equal(response.status, 200);
    assert.ok(!JSON.stringify(response.body).includes(DUMMY_SECRET), 'inspection never includes a secret value');
    return response.body;
  };
  const metadata = async (id: string) => (await inspect()).targets.find((target: Json) => target.id === id);
  const arm = async (targetId: string) => assert.equal((await fixture.request('/t3/fixture/interactions/fail-once', 'POST', { targetId })).status, 200);
  const respond = (requestId: string, fields: object, threadId = 'thread-alpha') => bounded(rpc.dispatch({ type: 'runtime-request.respond', threadId, requestId, ...fields }));
  const secret = (turnItemId: string, answer: object) => bounded(rpc.call('secrets.answerRequest', { threadId: 'thread-alpha', turnItemId, answer }));
  const request = (projection: Json, id: string) => projection.runtimeRequests.find((request: Json) => request.id === id);
  const item = (projection: Json, id: string) => projection.turnItems.find((item: Json) => item.id === id || item.requestId === id);
  const disconnect = () => { for (const stream of streams.splice(0)) stream.cancel(); rpc?.close(); };
  const pid = fixture.gatewayPid;
  const t3Port = fixture.t3Port;
  try {
    const watched = await connect();
    const alpha = await watched.alpha.wait();
    const beta = await watched.beta.wait();
    const gamma = await watched.gamma.wait();
    for (const projection of [alpha, beta, gamma]) for (const item of projection.turnItems) {
      if (item.completedAt && item.startedAt) assert.ok(item.completedAt >= item.startedAt, 'completion cannot precede start');
    }
    assert.equal(alpha.runtimeRequests.length, INTERACTION_IDS.approvals.length + 3);
    assert.equal(alpha.thread.pendingRuntimeRequest.id, INTERACTION_IDS.initial);
    assert.ok(alpha.turnItems.some((item: Json) => /Ask @Beta and @Gamma/.test(item.text)));
    assert.ok(alpha.turnItems.filter((item: Json) => item.type === 'assistant_message').length >= 26, 'enough parent history for a scroll restoration check');
    const draft = item(alpha, INTERACTION_IDS.initial);
    assert.equal(draft.questions[0].initialAnswer, INITIAL_ANSWER);
    assert.equal(draft.status, 'waiting');
    assert.deepEqual(request(alpha, INTERACTION_IDS.initial), {
      id: INTERACTION_IDS.initial, nodeId: `node-${INTERACTION_IDS.initial}`, providerTurnId: null,
      nativeRequestRef: null, kind: 'user_input', status: 'pending', responseCapability: { type: 'live', providerSessionId: 'fixture-session' },
      createdAt: draft.startedAt, resolvedAt: null,
    });
    assert.equal(item(alpha, INTERACTION_IDS.multi).questions[0].multiSelect, true);
    assert.equal(item(alpha, INTERACTION_IDS.multi).questions[1].initialAnswer, INITIAL_ANSWER);
    for (const id of INTERACTION_IDS.approvals) assert.deepEqual(item(alpha, id).options, APPROVAL_OPTIONS);
    for (const status of ['resolved', 'expired', 'cancelled']) assert.equal(request(beta, `fixture-terminal-question-${status}`).status, status);
    for (const status of ['saved', 'declined', 'cancelled']) assert.equal(item(gamma, `fixture-secret-${status}`).secretStatus, status);
    assert.ok((await inspect()).targets.every(({ attempts, accepted }: Json) => attempts === 0 && accepted === 0), 'seed and subscriptions do not submit anything');

    // Exercise the same real transcript/exchange functions used by the frontend.
    const requireWeb = createRequire(new URL('../web/package.json', import.meta.url));
    const { build } = await import(pathToFileURL(requireWeb.resolve('vite')).href);
    const bundle = await build({ configFile: false, logLevel: 'silent', build: {
      ssr: new URL('../web/src/lib/transcript.ts', import.meta.url).pathname, write: false,
    }, ssr: { noExternal: true } });
    const entry = bundle.output.find((output: Json) => output.type === 'chunk' && output.isEntry);
    const { buildEntries } = await import(`data:text/javascript;base64,${Buffer.from(entry.code).toString('base64')}`);
    const exchangeBundle = await build({ configFile: false, logLevel: 'silent', build: {
      ssr: new URL('../web/src/lib/botMessages.ts', import.meta.url).pathname, write: false,
    }, ssr: { noExternal: true } });
    const exchangeEntry = exchangeBundle.output.find((output: Json) => output.type === 'chunk' && output.isEntry);
    const { botExchange } = await import(`data:text/javascript;base64,${Buffer.from(exchangeEntry.code).toString('base64')}`);
    const bots = (await fixture.request('/api/bots')).body.bots;
    const ctx = { bot: bots.find((bot: Json) => bot.slug === 'alpha'), botsByThread: new Map(bots.map((bot: Json) => [bot.mainThreadId, bot])), tasks: [], requests: Object.fromEntries(alpha.runtimeRequests.map((request: Json) => [request.id, request])) };
    const entries = buildEntries(alpha.turnItems, ctx);
    assert.deepEqual(entries.filter((entry: Json) => entry.kind === 'bot-event').map((entry: Json) => [entry.direction, entry.bots.map((bot: Json) => bot.name)]), [['sent', ['Beta', 'Gamma']], ['received', ['Beta']]]);
    assert.equal(entries.filter((entry: Json) => entry.kind === 'question').length, 3);
    assert.equal(entries.filter((entry: Json) => entry.kind === 'approval').length, 5);
    assert.equal(entries.filter((entry: Json) => entry.kind === 'secret').length, 2);
    const pair = botExchange([...alpha.turnItems, ...beta.turnItems, ...gamma.turnItems], 'thread-alpha', 'thread-beta');
    assert.deepEqual(pair.map(({ id, senderThreadId, recipientThreadId, text }: Json) => ({ id, senderThreadId, recipientThreadId, text })), [
      { id: 'fixture-alpha-beta', senderThreadId: 'thread-alpha', recipientThreadId: 'thread-beta', text: 'Please review the generic sample.' },
      { id: 'fixture-beta-alpha', senderThreadId: 'thread-beta', recipientThreadId: 'thread-alpha', text: 'The generic sample is ready.' },
    ]);
    for (const message of pair) {
      const sent = [...alpha.turnItems, ...beta.turnItems].find((item) => item.output?.messageId === message.id);
      const received = [...alpha.turnItems, ...beta.turnItems].find((item) => item.messageId === message.id);
      assert.equal(sent.input.message, received.text);
      assert.equal(sent.output.threadId, received.threadId);
      assert.equal(sent.threadId, received.senderThreadId);
    }

    await assert.rejects(respond(INTERACTION_IDS.initial, { answers: { draft: 'Generic' } }, 'thread-beta'), /Unknown fixture interaction target/);
    assert.equal((await metadata(INTERACTION_IDS.initial)).attempts, 0);
    await arm(INTERACTION_IDS.initial);
    const edited = '  Edited generic draft\n\nRetain trailing space  \n';
    await assert.rejects(respond(INTERACTION_IDS.initial, { answers: { draft: edited } }), /failed once/);
    assert.equal((await metadata(INTERACTION_IDS.initial)).status, 'pending');
    const afterFailure = watchThread(rpc, 'thread-alpha'); streams.push(afterFailure.stream);
    const retained = await afterFailure.wait();
    assert.deepEqual(request(retained, INTERACTION_IDS.initial), request(alpha, INTERACTION_IDS.initial), 'a fresh subscription confirms failure left the exact request intact');
    assert.deepEqual(item(retained, INTERACTION_IDS.initial), draft);
    await respond(INTERACTION_IDS.initial, { answers: { draft: edited } });
    const answered = await watched.alpha.wait((projection) => request(projection, INTERACTION_IDS.initial).status === 'resolved');
    assert.deepEqual(request(answered, INTERACTION_IDS.initial).answers, { draft: edited });
    assert.deepEqual(item(answered, INTERACTION_IDS.initial).questionAnswer.answers, { draft: edited });
    await assert.rejects(respond(INTERACTION_IDS.initial, { answers: { draft: 'Conflicting duplicate' } }), /already answered/);
    assert.deepEqual([...(await metadata(INTERACTION_IDS.initial)).answerFields], [{ id: 'draft', type: 'string' }]);
    const initialCounts = await metadata(INTERACTION_IDS.initial);
    assert.deepEqual([initialCounts.attempts, initialCounts.accepted, initialCounts.failed, initialCounts.rejected], [3, 1, 1, 1]);
    await assert.rejects(respond(INTERACTION_IDS.multi, { answers: { choices: ['first-id'] } }), /complete valid answers/);
    const multiAnswers = { choices: ['first-id', 'second-id'], detail: INITIAL_ANSWER };
    const multiCommand = { commandId: 'fixture-multi-response', type: 'runtime-request.respond', threadId: 'thread-alpha', requestId: INTERACTION_IDS.multi, answers: multiAnswers };
    await bounded(rpc.call('orchestration.dispatchCommand', multiCommand));
    const multiAnswered = await watched.alpha.wait((projection) => request(projection, INTERACTION_IDS.multi).status === 'resolved');
    assert.deepEqual(request(multiAnswered, INTERACTION_IDS.multi).answers, multiAnswers);
    const resumedAnswer = multiAnswered.turnItems.find((item: Json) => item.messageId === `async-answer:${INTERACTION_IDS.multi}`);
    assert.ok(resumedAnswer, 'message-capability questions include the actual runtime continuation record');
    assert.equal(resumedAnswer.type, 'user_message');
    assert.ok(!buildEntries(multiAnswered.turnItems, ctx).some((entry: Json) => entry.kind === 'user' && entry.id === resumedAnswer.id), 'the accepted choice is displayed only in its question card');
    await assert.rejects(bounded(rpc.call('orchestration.dispatchCommand', multiCommand)), /already answered/);
    assert.equal((await metadata(INTERACTION_IDS.multi)).accepted, 1, 'identical command replay does not apply twice');

    await arm(INTERACTION_IDS.approvals[0]);
    await assert.rejects(respond(INTERACTION_IDS.approvals[0], { decision: 'accept' }), /failed once/);
    assert.equal((await metadata(INTERACTION_IDS.approvals[0])).status, 'pending');
    await assert.rejects(respond(INTERACTION_IDS.approvals[0], { decision: 'invented' }), /Unsupported fixture approval decision/);
    for (const [index, option] of APPROVAL_OPTIONS.entries()) {
      const id = INTERACTION_IDS.approvals[index];
      await respond(id, { decision: option.decision });
      const projection = await watched.alpha.wait((projection) => request(projection, id).status !== 'pending');
      assert.equal(request(projection, id).decision, option.decision);
      assert.equal(request(projection, id).status, 'resolved');
      assert.equal(item(projection, id).status, ['decline', 'cancel'].includes(option.decision) ? 'cancelled' : 'completed');
      await assert.rejects(respond(id, { decision: option.decision }), /already answered/);
      assert.equal((await metadata(id)).accepted, 1);
    }
    for (const terminal of beta.runtimeRequests) await assert.rejects(respond(terminal.id, terminal.kind === 'user_input' ? { answers: { draft: 'Generic' } } : { decision: 'accept' }, 'thread-beta'), /already answered or terminal/);

    await arm(INTERACTION_IDS.save);
    let invalidError: Error | undefined;
    try { await secret(INTERACTION_IDS.save, { type: 'save', secret: 'unaccepted-generic-input' }); } catch (error) { invalidError = error as Error; }
    assert.match(invalidError?.message!, /fixed dummy fixture value/);
    assert.ok(!invalidError!.message.includes('unaccepted-generic-input'), 'validation failure never echoes submitted data');
    await assert.rejects(secret(INTERACTION_IDS.save, { type: 'save', secret: DUMMY_SECRET }), (error: Error) => /failed once/.test(error.message) && !error.message.includes(DUMMY_SECRET));
    assert.equal((await metadata(INTERACTION_IDS.save)).status, 'pending');
    await secret(INTERACTION_IDS.save, { type: 'save', secret: DUMMY_SECRET });
    const saved = await watched.alpha.wait((projection) => item(projection, INTERACTION_IDS.save).secretStatus === 'saved');
    assert.equal(item(saved, INTERACTION_IDS.save).status, 'completed');
    assert.ok(!JSON.stringify(saved).includes(DUMMY_SECRET), 'authoritative snapshot never contains a secret value');
    await assert.rejects(secret(INTERACTION_IDS.save, { type: 'decline' }), /already answered/);
    await arm(INTERACTION_IDS.decline);
    await assert.rejects(secret(INTERACTION_IDS.decline, { type: 'decline' }), /failed once/);
    await secret(INTERACTION_IDS.decline, { type: 'decline' });
    await watched.alpha.wait((projection) => item(projection, INTERACTION_IDS.decline).secretStatus === 'declined');
    assert.equal((await metadata(INTERACTION_IDS.save)).accepted, 1);
    assert.equal((await metadata(INTERACTION_IDS.decline)).accepted, 1);
    assert.equal((await fixture.request('/t3/fixture/interactions/fail-once', 'POST', { targetId: INTERACTION_IDS.save })).status, 400);
    const malformed = await fetch(fixture.url + '/t3/fixture/interactions/fail-once', { method: 'POST', body: DUMMY_SECRET });
    assert.equal(malformed.status, 400); assert.ok(!(await malformed.text()).includes(DUMMY_SECRET));
    const unknownTarget = await fixture.request('/t3/fixture/interactions/fail-once', 'POST', { targetId: DUMMY_SECRET });
    assert.equal(unknownTarget.status, 400); assert.ok(!JSON.stringify(unknownTarget.body).includes(DUMMY_SECRET));
    await assert.rejects(bounded(rpc.call(DUMMY_SECRET, { type: DUMMY_SECRET })), (error: Error) => /Unavailable in local fixture/.test(error.message) && !error.message.includes(DUMMY_SECRET));
    const oversized = await fetch(fixture.url + '/t3/fixture/interactions/fail-once', { method: 'POST', body: 'x'.repeat(1025) });
    assert.equal(oversized.status, 413);
    for (const [tag, payload] of [
      ['orchestration.dispatchCommand', { type: 'message.dispatch', threadId: 'thread-alpha', text: 'Generic' }],
      ['orchestration.dispatchCommand', { type: 'thread.create', threadId: 'new-fixture-thread' }],
      ['projects.createNew', {}], ['shell.execute', { command: 'ignored' }],
      ['secrets.consume', { secretRef: 'ignored' }], ['t3_thread_send', { threadId: 'thread-beta', message: 'Generic' }],
    ] as [string, object][]) await assert.rejects(bounded(rpc.call(tag, payload)), /Unavailable in local fixture/);
    assert.equal((await fixture.request('/t3/api/not-supported')).status, 501);
    assert.ok((await inspect()).targets.every(({ accepted }: Json) => accepted <= 1));
    assert.ok(!fixture.logs.includes(DUMMY_SECRET), 'gateway logs never contain a secret value');

    disconnect();
    await fixture.restart();
    const restarted = await connect();
    assert.equal(item(await restarted.alpha.wait(), INTERACTION_IDS.save).secretStatus, 'saved');
    assert.deepEqual(request(await restarted.alpha.wait(), INTERACTION_IDS.initial).answers, { draft: edited });
    assert.equal((await metadata(INTERACTION_IDS.initial)).attempts, 3);
    disconnect();
    await fixture.reset();
    assert.equal(fixture.t3Port, t3Port);
    const reset = await connect();
    const resetAlpha = await reset.alpha.wait();
    assert.deepEqual(resetAlpha, alpha, 'reset restores the exact seed including timestamps and pending records');
    assert.ok((await inspect()).targets.every(({ attempts, accepted, failOnce }: Json) => attempts === 0 && accepted === 0 && !failOnce));
    await bounded(rpc.call('orchestration.dispatchCommand', { commandId: 'fixture-dismiss', type: 'thread.user-input.dismiss', threadId: 'thread-alpha', requestId: INTERACTION_IDS.multi }));
    const dismissed = await reset.alpha.wait((projection) => request(projection, INTERACTION_IDS.multi).status === 'resolved');
    assert.equal(item(dismissed, INTERACTION_IDS.multi).status, 'cancelled');
    assert.equal(item(dismissed, INTERACTION_IDS.multi).questionAnswer, undefined);
    assert.ok(!dismissed.turnItems.some((item: Json) => item.messageId === `async-answer:${INTERACTION_IDS.multi}`), 'dismissal does not send a synthetic answer');
  } finally { disconnect(); await fixture.close(); }
  await assert.rejects(access(fixture.root), { code: 'ENOENT' });
  assert.throws(() => process.kill(pid!, 0), { code: 'ESRCH' });
  assert.throws(() => process.kill(fixture.gatewayPid!, 0), { code: 'ESRCH' });
  await assert.rejects(fetch(fixture.url, { signal: AbortSignal.timeout(1000) }));
  await assert.rejects(fetch(`http://127.0.0.1:${t3Port}/api/projects`, { signal: AbortSignal.timeout(1000) }));
});

test('Executor scenario drives real gateway account completion, restart/reset and all-listener cleanup', { timeout: 30000 }, async () => {
  const fixture = await createFixture({ scenario: 'executor' });
  const executorUrl = fixture.executorUrl, t3Port = fixture.t3Port;
  const raw = async (route: string, method = 'GET', body?: unknown) => {
    const response = await fetch(executorUrl + route, { method, signal: AbortSignal.timeout(5000),
      headers: { authorization: `Bearer ${EXECUTOR_FIXTURE_TOKEN}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  try {
    assert.equal((await fetch(executorUrl + '/api/organizations/fixture/apps')).status, 401);
    assert.equal((await fetch(executorUrl + '/api/organizations/fixture/apps', { headers: { authorization: 'Bearer wrong-fixture-token' } })).status, 401);
    const initial = await fixture.request('/api/executor');
    assert.equal(initial.status, 200); assert.equal(initial.body.backend, 'self-hosted');
    assert.deepEqual(initial.body.connections.map(({ id, status }: Json) => ({ id, status })), [
      { id: EXECUTOR_FIXTURE_IDS.service, status: 'needs-connection' }, { id: EXECUTOR_FIXTURE_IDS.single, status: 'needs-connection' }, { id: EXECUTOR_FIXTURE_IDS.ready, status: 'ready' },
    ]);
    assert.doesNotMatch(JSON.stringify(initial.body), /fixture-only|credentialsFingerprint|access_token/);
    const catalog = await fixture.request('/api/executor/catalog?search=generic');
    assert.deepEqual(catalog.body.entries.map(({ id }: Json) => id), [EXECUTOR_FIXTURE_IDS.catalog]);
    const input = { entry: EXECUTOR_FIXTURE_IDS.catalog, name: 'Installed sample' };
    await raw('/fixture/executor/fail-once', 'POST', { operation: 'install' });
    assert.equal((await fixture.request('/api/executor/install', 'POST', input)).status, 502);
    const installed = await fixture.request('/api/executor/install', 'POST', input);
    assert.equal(installed.status, 200); assert.equal(installed.body.app.name, 'Installed sample');
    assert.equal(installed.body.app.status, 'needs-connection');
    assert.equal((await raw('/fixture/executor')).body.installs, 1);

    const app = EXECUTOR_FIXTURE_IDS.service;
    const launch = await fixture.request(`/api/executor/apps/${app}/connections`, 'POST', { scope: 'user', requirement: 'service' });
    assert.equal(launch.status, 200); assert.equal(launch.body.status, 'pending');
    const connection = launch.body;
    assert.equal(connection.backend, 'self-hosted');
    assert.equal((await fetch(connection.url)).status, 200);
    assert.match(await (await fetch(connection.url)).text(), /Finish sample sign-in/);
    assert.equal((await fixture.request(`/api/executor/connections/${connection.id}?backend=self-hosted`)).body.status, 'pending', 'opening the page does not connect');
    const resolved = await fixture.request('/api/executor/resolve-link', 'POST', { url: connection.url });
    assert.equal(resolved.body.kind, 'connection'); assert.equal(resolved.body.connection.id, connection.id);
    assert.equal((await fixture.request('/api/executor/resolve-link', 'POST', { url: `${executorUrl}/org/fixture/apps/${app}` })).body.app.id, app);
    const complete = await fetch(connection.url + '/complete', { method: 'POST', redirect: 'manual' });
    assert.equal(complete.status, 303);
    assert.equal((await fixture.request(`/api/executor/connections/${connection.id}?backend=self-hosted`)).body.status, 'completed');
    const connected = (await fixture.request(`/api/executor/apps/${app}`)).body.app;
    assert.equal(connected.status, 'connected');
    assert.deepEqual(connected.requirements[0].accounts.map(({ linked, signIn }: Json) => ({ linked, signIn })), [{ linked: true, signIn: 'saved' }]);
    const accountId = connected.requirements[0].accounts[0].id;
    const unlinked = await fixture.request(`/api/executor/apps/${app}/accounts`, 'POST', { scope: 'user', requirement: 'service', account: accountId, linked: false });
    assert.equal(unlinked.body.app.status, 'needs-connection');
    assert.equal(unlinked.body.app.requirements[0].accounts[0].linked, false);
    assert.equal((await fixture.request(`/api/executor/apps/${app}/accounts`, 'POST', { scope: 'user', requirement: 'service', account: accountId, linked: true })).body.app.status, 'connected');
    const one = EXECUTOR_FIXTURE_IDS.single;
    for (const account of ['acct_single_personal', 'acct_single_work']) assert.equal((await fixture.request(`/api/executor/apps/${one}/accounts`, 'POST', { scope: 'app', requirement: 'service', account, linked: true })).status, 200);
    assert.deepEqual((await fixture.request(`/api/executor/apps/${one}`)).body.app.requirements[0].accounts.map(({ id, linked }: Json) => ({ id, linked })), [
      { id: 'acct_single_personal', linked: false }, { id: 'acct_single_work', linked: true },
    ]);
    for (const [action, status] of [['cancel', 'cancelled'], ['expire', 'expired']]) {
      const sample = (await fixture.request(`/api/executor/apps/${app}/connections`, 'POST', { scope: 'user', requirement: 'service' })).body;
      assert.equal((await fetch(sample.url + '/' + action, { method: 'POST', redirect: 'manual' })).status, 303);
      assert.equal((await fixture.request(`/api/executor/connections/${sample.id}`)).body.status, status);
      assert.equal((await fixture.request(`/api/executor/apps/${app}`)).body.app.status, 'connected', 'a cancelled new connection must preserve the saved account');
    }
    const rpc = new T3Client({ baseUrl: fixture.url + '/t3', token: 'fixture-only' });
    try {
      await bounded(rpc.connect());
      const watched = watchThread(rpc, 'thread-alpha');
      const projection = await watched.wait();
      assert.match(projection.turnItems.at(-1).text, /Connect Generic Service/);
      assert.ok(projection.turnItems.at(-1).text.includes(`${executorUrl}/org/fixture/connections/con_fixture_seed`));
      watched.stream.cancel();
    } finally { rpc.close(); }
    const previousPid = fixture.gatewayPid;
    await fixture.restart();
    assert.notEqual(fixture.gatewayPid, previousPid);
    assert.equal(fixture.executorUrl, executorUrl);
    assert.equal((await fixture.request(`/api/executor/apps/${app}`)).body.app.status, 'connected');
    assert.equal((await fixture.request('/api/executor')).body.connections.length, 4);
    await fixture.reset();
    assert.equal(fixture.executorUrl, executorUrl); assert.equal(fixture.t3Port, t3Port);
    assert.equal((await fixture.request(`/api/executor/apps/${app}`)).body.app.status, 'needs-connection');
    assert.equal((await fixture.request('/api/executor')).body.connections.length, 3);
    assert.equal((await fixture.request(`/api/executor/connections/${connection.id}`)).status, 404);
    assert.deepEqual((await raw('/fixture/executor')).body, { fixtureOnly: true, installs: 0, links: 0, launches: 0, completions: 0, apps: 4, accounts: 2, connections: [{ id: 'con_fixture_seed', status: 'pending' }] });
  } finally { await fixture.close(); }
  await assert.rejects(access(fixture.root), { code: 'ENOENT' });
  await assert.rejects(fetch(fixture.url, { signal: AbortSignal.timeout(1000) }));
  await assert.rejects(fetch(executorUrl!, { signal: AbortSignal.timeout(1000) }));
  await assert.rejects(fetch(`http://127.0.0.1:${t3Port}/api/projects`, { signal: AbortSignal.timeout(1000) }));
});

test('Executor CLI startup failure closes its fake listeners and preserves occupied-port owner', { timeout: 15000 }, async () => {
  const server = http.createServer((_req, res) => res.end('existing owner'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const child = spawn(process.execPath, [new URL('./fixture.mts', import.meta.url).pathname, '--scenario', 'executor', '--port', String((server.address() as AddressInfo).port)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { output += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
    try { const [code, signal] = await once(child, 'exit'); assert.equal(code, 1, output); assert.equal(signal, null); }
    finally { clearTimeout(timer); }
    assert.match(output, /EADDRINUSE|Gateway exited/);
    assert.equal(await (await fetch(url)).text(), 'existing owner');
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});

test('inbox lifecycle reconciles across socket reloads and never changes Bot visibility', { timeout: 30000 }, async () => {
  const fixture = await createFixture();
  let rpc: T3Client | undefined;
  const connect = async () => {
    const c = new T3Client({ baseUrl: fixture.url + '/t3', token: 'fixture-only' });
    await bounded(c.connect()); return c;
  };
  try {
    rpc = await connect();
    const id = 'thread-beta';
    await bounded(rpc.dispatch({ type: 'thread.settle', threadId: id }));
    rpc.close(); rpc = await connect();
    const read = async () => (await bounded(rpc!.call('orchestration.getThreadProjection', { threadId: id }))).thread;
    assert.equal((await read()).settledOverride, 'settled');
    await bounded(rpc.dispatch({ type: 'thread.unsettle', threadId: id, reason: 'user' }));
    assert.equal((await read()).settledOverride, 'active');
    const snoozedUntil = new Date(Date.now() + 3600000).toISOString();
    await bounded(rpc.dispatch({ type: 'thread.snooze', threadId: id, snoozedUntil }));
    assert.equal((await read()).snoozedUntil, snoozedUntil);
    await bounded(rpc.dispatch({ type: 'thread.unsnooze', threadId: id, reason: 'user' }));
    await bounded(rpc.dispatch({ type: 'thread.auto-settle.set', threadId: id, enabled: false }));
    assert.ok((await read()).autoSettleDisabledAt);
    await bounded(rpc.dispatch({ type: 'thread.archive', threadId: id }));
    assert.equal((await bounded(rpc.call('orchestration.getArchivedShellSnapshot'))).threads[0].id, id);
    assert.equal((await fixture.request('/api/bots')).body.bots.find((bot: Json) => bot.slug === 'beta').hidden, false);
    await bounded(rpc.dispatch({ type: 'thread.unarchive', threadId: id }));
    assert.equal((await read()).archivedAt, null);
    await assert.rejects(bounded(rpc.dispatch({ type: 'message.dispatch', threadId: id, text: 'Must never run' })), /Unavailable in local fixture/);
  } finally { rpc?.close(); await fixture.close(); }
});

test('scoped gateway HTTP, RPC and assets use only the requested machine; missing scope fails closed', { timeout: 30000 }, async () => {
  const fixture = await createFixture(); let peer, remote;
  try {
    peer = await startFakeT3(fixture.root, 0, { environmentId: 'fixture-peer' });
    await writeFile(path.join(fixture.root, 'peer-token'), 'peer-only', { mode: 0o600 });
    await writeFile(path.join(fixture.root, 'environments.json'), JSON.stringify({ 'fixture-peer': { baseUrl: `http://127.0.0.1:${peer.port}`, tokenFile: path.join(fixture.root, 'peer-token') } }), { mode: 0o600 });
    await fixture.restart();
    const prefix = fixture.url + '/t3/environments/fixture-peer';
    const discovery = await (await fetch(prefix + '/.well-known/t3/environment')).json();
    assert.equal(discovery.environmentId, 'fixture-peer');
    const denied = await fetch(fixture.url + '/t3/environments/not-authorized/.well-known/t3/environment');
    assert.equal(denied.status, 403); assert.match((await denied.json()).error, /scoped gateway access/);
    remote = new T3Client({ baseUrl: prefix, token: 'fixture-only' }); await bounded(remote.connect());
    await bounded(remote.dispatch({ type: 'thread.settle', threadId: 'thread-beta' }));
    assert.equal((await bounded(remote.call('orchestration.getThreadProjection', { threadId: 'thread-beta' }))).thread.settledOverride, 'settled');
    const local = new T3Client({ baseUrl: fixture.url + '/t3', token: 'fixture-only' });
    try { await bounded(local.connect()); assert.equal((await bounded(local.call('orchestration.getThreadProjection', { threadId: 'thread-beta' }))).thread.settledOverride, null); } finally { local.close(); }
    const asset = await bounded(remote.call('assets.createUrl', { resource: { _tag: 'attachment', attachmentId: 'sample-file' } }));
    const response = await fetch(prefix + asset.relativeUrl); assert.equal(response.status, 200); assert.match(await response.text(), /Generic attachment/);
    const link = await fetch(fixture.url + '/api/thread-link?environmentId=fixture-peer&threadId=thread-beta', { redirect: 'manual' });
    assert.equal(link.headers.get('location'), '/?environment=fixture-peer&thread=thread-beta');
  } finally { remote?.close(); await peer?.close(); await fixture.close(); }
});

 test('scripted message receipts stay idempotent and running work requires Stop', {timeout:15000},async()=>{
 const fixture=await createFixture(); let rpc: T3Client | undefined;
 try {
  rpc=new T3Client({baseUrl:fixture.url+'/t3',token:'fixture-only'}); await rpc.connect();
  const command={commandId:'fixture-message-command',type:'message.dispatch',threadId:'thread-beta',messageId:'fixture-message',text:'Generic scripted running work',attachments:[]};
  const receipt=await rpc.dispatch(command);
  assert.deepEqual(await rpc.dispatch(command),receipt);
  const read=()=>rpc!.call('orchestration.getThreadProjection',{threadId:'thread-beta'});
  const running=await read();
  assert.equal(running.runs.length,1); assert.equal(running.runs[0].status,'running');
  assert.equal(running.turnItems.filter((item: Json)=>item.messageId==='fixture-message').length,1);
  await rpc.dispatch({type:'thread.stop',commandId:'fixture-stop-command',threadId:'thread-beta',stopDelegatedTasks:true});
  const stopped=await read(); assert.equal(stopped.thread.activeRunId,null); assert.equal(stopped.runs[0].status,'interrupted');
 } finally {rpc?.close();await fixture.close();}
});

test('Library fixture supplies real signed resources and rejects missing files and unknown owners', { timeout: 30000 }, async () => {
  const fixture = await createFixture({ scenario: 'library' });
  const rpc = new T3Client({ baseUrl: `${fixture.url}/t3`, token: 'fixture-only' });
  try {
    await bounded(rpc.connect());
    const bots = (await fixture.request('/api/bots')).body.bots;
    const bot = bots.find((bot: Json) => bot.slug === 'beta');
    const listing = await bounded(rpc.call('projects.listEntries', { cwd: bot.workspaceRoot, directoryPath: 'library' }));
    assert.deepEqual(listing.entries.map((entry: Json) => entry.path), ['library/counter.html', 'library/sample.csv', 'library/photo.svg', 'library/bars.svg', 'library/notes.txt', 'library/report.pdf', 'library/audio.wav']);
    const signed = await bounded(rpc.call('assets.createUrl', { resource: { _tag: 'workspace-file', threadId: bot.mainThreadId, path: 'library/counter.html' } }));
    const response = await fetch(fixture.url + '/t3' + signed.relativeUrl);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /window.count=0/);
    for (const [name, mime] of [['notes.txt', 'text/plain'], ['audio.wav', 'audio/wav'], ['sample.csv', 'text/csv']]) {
      const resource = { threadId: bot.mainThreadId, path: 'library/' + name };
      await assert.rejects(bounded(rpc.call('assets.createUrl', { resource: { ...resource, _tag: 'workspace-file' } })), /Only browser documents and images/);
      const download = name !== 'audio.wav';
      const signed = await bounded(rpc.call('assets.createUrl', { resource: { ...resource, _tag: 'media-file', ...(download ? { disposition: 'attachment' } : {}) } }));
      const url = fixture.url + '/t3' + signed.relativeUrl;
      const opened = await fetch(url);
      assert.equal(opened.status, 200); assert.equal(opened.headers.get('content-type'), mime);
      const bytes = Buffer.from(await opened.arrayBuffer());
      if (name === 'audio.wav') {
        assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
        const range = await fetch(url, { headers: { Range: 'bytes=0-43' } });
        assert.equal(range.status, 206); assert.equal((await range.arrayBuffer()).byteLength, 44);
      } else assert.match(bytes.toString(), name === 'notes.txt' ? /Generic/ : /name,value/);
      assert.equal((await fetch(url.replace('fixture%2Bread%2F', 'wrong'))).status, 403);
    }
    // The PDF sample the file viewer draws with pdf.js.
    const pdf = await bounded(rpc.call('assets.createUrl', { resource: { _tag: 'workspace-file', threadId: bot.mainThreadId, path: 'library/report.pdf' } }));
    const pdfResponse = await fetch(fixture.url + '/t3' + pdf.relativeUrl);
    assert.equal(pdfResponse.headers.get('content-type'), 'application/pdf');
    assert.match(Buffer.from(await pdfResponse.arrayBuffer()).toString('latin1'), /^%PDF-1\.4[\s\S]*\/Count 2[\s\S]*%%EOF\n$/);
    // The chat image sample: a Bot-posted workspace image the image viewer opens.
    const bars = await bounded(rpc.call('assets.createUrl', { resource: { _tag: 'workspace-file', threadId: bot.mainThreadId, path: 'library/bars.svg' } }));
    assert.equal((await fetch(fixture.url + '/t3' + bars.relativeUrl)).headers.get('content-type'), 'image/svg+xml');
    assert.equal((await fetch(fixture.url + '/t3/fixture/library/missing.html')).status, 404);
    await assert.rejects(bounded(rpc.call('assets.createUrl', { resource: { _tag: 'workspace-file', threadId: 'unknown', path: 'library/counter.html' } })), /Unknown fixture thread/);
    assert.deepEqual((await bounded(rpc.call('projects.listEntries', { cwd: '/unknown', directoryPath: 'library' }))).entries, []);
  } finally { rpc.close(); await fixture.close(); }
});

test('repeatable Vault values survive real gateway restart and invalid arrays do not overwrite them', {timeout:30000,skip:process.platform!=='darwin'}, async () => {
  const fixture=await createFixture();
  try {
    const login=await fixture.request('/api/vault','POST',{type:'login',websites:['first.invalid','second.invalid'],username:'generic',password:'fixture-only-value'});
    assert.equal(login.status,200);
    assert.deepEqual(login.body.websites,['https://first.invalid','https://second.invalid']);
    const contact=await fixture.request('/api/vault','POST',{type:'contact',emails:['first@example.invalid','second@example.invalid'],phones:['111','222']});
    assert.equal(contact.status,200);
    await fixture.restart();
    assert.deepEqual((await fixture.request('/api/vault/'+login.body.id)).body.websites,login.body.websites);
    const changed=await fixture.request('/api/vault/'+contact.body.id,'PUT',{emails:['second@example.invalid','first@example.invalid'],phones:['222']});
    assert.equal(changed.status,200); assert.equal(changed.body.email,'second@example.invalid');
    assert.equal((await fixture.request('/api/vault/'+login.body.id,'PUT',{websites:[null]})).status,400);
    assert.deepEqual((await fixture.request('/api/vault/'+login.body.id)).body.websites,login.body.websites);
    const raw=await readFile(path.join(fixture.root,'vault','vault.enc'),'utf8');
    for(const value of ['fixture-only-value','first@example.invalid','second.invalid'])assert.equal(raw.includes(value),false);
    await fixture.restart();
    assert.deepEqual((await fixture.request('/api/vault/'+contact.body.id)).body.emails,['second@example.invalid','first@example.invalid']);
  } finally {await fixture.close();}
});

test('latest-t3 scenario serves T3 0.1.6–0.1.8 shapes through the real gateway', { timeout: 30000 }, async () => {
  const fixture = await createFixture({ scenario: 'latest-t3' });
  const rpc = new T3Client({ baseUrl: fixture.url + '/t3', token: 'fixture-only' });
  const first = (tag: string, payload: unknown) => new Promise<Json>((resolve) => { const handle = rpc.stream(tag, payload, (value) => { handle.cancel(); resolve(value); }); });
  try {
    await rpc.connect();
    const { capabilities } = (await rpc.call('server.getConfig')).environment;
    assert.equal(capabilities.threadForceStop, true); assert.equal(capabilities.freshContext, true); assert.equal(capabilities.scheduledTaskThreadModes, true);
    const { tasks } = await first('scheduledTasks.subscribe', {});
    assert.deepEqual(tasks.map((task: Json) => task.threadMode), ['continue', 'continue']);
    assert.deepEqual(tasks.map((task: Json) => task.schedule.type), ['once', 'fixed_time']);
    assert.match(tasks[1].blockedByPolicy, /Example Org/);
    const shell = (await first('orchestration.subscribeShell', {})).snapshot;
    assert.ok(shell.projects.find((p: Json) => p.id === 'project-gamma').archivedAt);
    assert.equal(shell.threads.find((t: Json) => t.id === 'thread-alpha-child').pendingRuntimeRequest.kind, 'command');
    await assert.rejects(rpc.dispatch({ type: 'runtime-request.respond', threadId: 'thread-alpha', requestId: 'fixture-child-approval', decision: 'accept' }), /child thread/);
    await rpc.dispatch({ type: 'runtime-request.respond', threadId: 'thread-alpha-child', requestId: 'fixture-child-approval', decision: 'accept' });
    assert.deepEqual(await rpc.call('orchestration.forceStopThread', { threadId: 'thread-beta', runId: 'fixture-run-stuck' }), { outcome: 'killed', sharedWithThreadIds: [] });
    assert.deepEqual(shell.threads.find((t: Json) => t.id === 'thread-alpha').pullRequests.map((pr: Json) => pr.number), [2, 10, 11, 21, 22, 23, 24]);
    const pr = (number: number) => ({ projectId: 'project-alpha', host: 'github.com', repository: 'example/generic', number });
    assert.equal((await rpc.call('pullRequests.detail', pr(2))).state, 'merged', 'stale open snapshot, merged upstream');
    assert.equal((await rpc.call('pullRequests.detail', pr(22))).isDraft, true);
    assert.deepEqual((await rpc.call('pullRequests.checks', pr(23))).checks.map((c: Json) => c.status), ['success', 'failure']);
    assert.equal((await rpc.call('pullRequests.detail', pr(24))).state, 'open');
    assert.equal((await rpc.call('pullRequests.detail', pr(24))).state, 'merged', '#24 merges after its first read');
    await rpc.call('projects.mutate', { type: 'project.update', commandId: 'unarchive', projectId: 'project-gamma', archived: false });
    const once = tasks[0];
    await rpc.call('scheduledTasks.upsert', { ...once, requireExisting: true, commandId: 'fresh-routine', threadMode: 'fresh_session' });
    await rpc.call('scheduledTasks.upsert', { ...once, threadMode: undefined, requireExisting: true, commandId: 'keep-mode' });
    await rpc.dispatch({ type: 'message.dispatch', commandId: 'fresh-send', threadId: 'thread-alpha', messageId: 'fresh-send', text: 'Start over', attachments: [], freshContext: true });
    const sent = (await rpc.call('orchestration.getThreadProjection', { threadId: 'thread-alpha' })).turnItems.filter((item: Json) => item.freshContext === true).map((item: Json) => item.messageId);
    assert.deepEqual(sent, ['fixture-fresh-routine-run', 'fresh-send']);
    const inspect = await (await fetch(`http://127.0.0.1:${fixture.t3Port}/fixture/interactions`)).json();
    assert.equal(inspect.tasks[0].threadMode, 'fresh_session');
    assert.equal(inspect.request, 'resolved'); assert.equal(inspect.decision, 'accept'); assert.equal(inspect.run, 'interrupted'); assert.equal(inspect.gammaArchived, false);
  } finally { rpc.close(); await fixture.close(); }
});

test('avatars scenario draws in side chats of an empty, archived job and never touches the main thread', { timeout: 60000 }, async () => {
  const fixture = await createFixture({ scenario: 'avatars' });
  const rpc = new T3Client({ baseUrl: fixture.url + '/t3', token: 'fixture-only' });
  const actor = { createdBy: 'user', creationSource: 'web' };
  const replies = async (threadId: string, count: number) => {
    for (let i = 0; i < 60; i++) {
      const found = (await rpc.call('orchestration.getThreadProjection', { threadId })).turnItems.filter((item: Json) => item.type === 'assistant_message');
      if (found.length >= count) return found;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`no reply ${count} in ${threadId}`);
  };
  try {
    await rpc.connect();
    const config = await rpc.call('server.getConfig');
    assert.equal(config.environment.capabilities.sideChats, true);
    assert.ok(config.providers.some((provider: Json) => provider.driver === 'codex' && provider.models.some((model: Json) => model.slug === 'gpt-6-luna')), 'a fast model to draw with');
    const bots = (await (await fetch(fixture.url + '/api/bots')).json()).bots;
    assert.ok(bots.filter((bot: Json) => bot.shape.startsWith('object:')).length >= 12);
    assert.equal(bots.find((bot: Json) => bot.slug === 'bean').avatarDefinition.name, 'Bean');
    assert.deepEqual(['ink', 'paper', 'neon', 'plum'].map((slug) => bots.find((bot: Json) => bot.slug === slug).color), ['#15131c', '#fbf9f2', '#39ff14', '#5b2a86'], 'custom colours come back as stored');
    const main = (await rpc.call('orchestration.getThreadProjection', { threadId: 'thread-cat' })).turnItems.length;
    const fast = { instanceId: 'codex', model: 'gpt-6-luna', options: [{ id: 'serviceTier', value: 'priority' }] };
    await rpc.dispatch({ type: 'thread.create', ...actor, threadId: 'job', projectId: 'project-cat', title: 'Avatar drawing job', modelSelection: fast, runtimeMode: 'auto', interactionMode: 'default', branch: null, worktreePath: null });
    await rpc.dispatch({ type: 'thread.archive', threadId: 'job' });
    let shell: Json;
    const stream = rpc.stream('orchestration.subscribeShell', {}, (item: Json) => { if (item.kind === 'snapshot') shell = item.snapshot; });
    await new Promise((resolve) => setTimeout(resolve, 200)); stream.cancel();
    assert.equal(shell.threads.some((thread: Json) => thread.id === 'job'), false, 'the job is archived, out of every list');
    await rpc.dispatch({ type: 'thread.fork', ...actor, sourceThreadId: 'job', targetThreadId: 'drawing', sourcePoint: { type: 'latest_stable' }, sideChat: true, title: 'Avatar drawing: a broken acorn' });
    assert.equal((await rpc.call('orchestration.getThreadProjection', { threadId: 'drawing' })).turnItems.length, 0, 'none of the Bot conversation');
    await rpc.dispatch({ type: 'message.dispatch', threadId: 'drawing', messageId: 'drawing-1', text: 'Draw one object avatar: a broken acorn.', ...actor });
    const [first] = await replies('drawing', 1);
    assert.match(first.text, /"path":""/, 'a broken drawing first');
    await rpc.dispatch({ type: 'message.dispatch', threadId: 'drawing', messageId: 'drawing-2', text: "That avatar didn't validate: body.path: path is empty", ...actor });
    const [, fixed] = await replies('drawing', 2);
    assert.match(fixed.text, /"name": "Acorn"/, 'and a valid one once asked to fix it');
    const inspect = await (await fetch(`http://127.0.0.1:${fixture.t3Port}/fixture/interactions`)).json();
    assert.deepEqual(inspect.calls.find((call: Json) => call.type === 'message.dispatch').model, fast, 'the option runs on the job model');
    assert.equal((await rpc.call('orchestration.getThreadProjection', { threadId: 'thread-cat' })).turnItems.length, main);
    await rpc.dispatch({ type: 'thread.delete', threadId: 'job' });
    await assert.rejects(rpc.call('orchestration.getThreadProjection', { threadId: 'drawing' }), /Unknown fixture thread/, 'deleting the job takes its options');
  } finally { rpc.close(); await fixture.close(); }
});

test('latest-t3 transcribes dictation audio carried by the real gateway', { timeout: 30000 }, async () => {
  const fixture = await createFixture({ scenario: 'latest-t3' });
  const rpc = new T3Client({ baseUrl: fixture.url + '/t3', token: 'fixture-only' });
  try {
    await rpc.connect();
    assert.equal((await rpc.call('server.getConfig')).environment.capabilities.voiceTranscription, true);
    const voice = (path: string, init: RequestInit = {}) => fetch(fixture.url + '/t3/api/voice/' + path, { ...init, headers: { origin: fixture.url, 'content-type': 'application/octet-stream', ...(init.headers as Record<string, string>) } });
    const status = await (await voice('status')).json();
    assert.equal(status.supported, true); assert.equal(status.state, 'ready'); assert.deepEqual(status.languages, ['en', 'es']);
    // Two minutes of audio, larger than any JSON body the gateway itself accepts.
    const options = Buffer.from(JSON.stringify({ speechLanguage: 'es', speechTranslateToEnglish: false, speechCustomWords: [], speechRemoveFillerWords: true, speechSilenceFiltering: true }));
    const pcm = Buffer.from(new Float32Array(16000 * 120).fill(0.1).buffer);
    const head = Buffer.alloc(4); head.writeUInt32LE(options.length);
    const res = await voice('transcribe', { method: 'POST', body: Buffer.concat([head, options, pcm]) });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { text: 'Fixture transcript: 120.0 seconds in es' });
    const bad = await voice('transcribe', { method: 'POST', body: Buffer.concat([head, options, pcm.subarray(0, 6)]) });
    assert.equal(bad.status, 400); assert.equal((await bad.json()).reason, 'invalid_audio');
  } finally { rpc.close(); await fixture.close(); }
});

test('usage stats: off and unasked by default, with an exact preview from the real gateway', { timeout: 30000 }, async () => {
  const fixture = await createFixture();
  try {
    const status = (await fixture.request('/api/telemetry')).body;
    assert.deepEqual({ enabled: status.enabled, asked: status.asked, choice: status.choice, blockedBy: status.blockedBy, lastSentAt: status.lastSentAt }, { enabled: false, asked: false, choice: null, blockedBy: null, lastSentAt: null });
    const preview = (await fixture.request('/api/telemetry/preview')).body;
    assert.equal(preview.installId, status.installId);
    // The basic fixture's fake T3 reports no version and no provider turns, like T3 Code before 0.1.5: no token section.
    assert.deepEqual({ ...preview, installId: 'x', threebot: 'x', node: 'x', os: 'x', arch: 'x' }, { schema: 1, installId: 'x', threebot: 'x', t3code: null, node: 'x', os: 'x', arch: 'x', bots: '2-5', routines: '0', features: { projects: false, autoUpdate: false, freshSessionRoutines: false } });
    assert.equal((await fixture.request('/api/telemetry', 'PUT', { enabled: 'yes' })).status, 400);
    assert.equal((await fixture.request('/api/telemetry', 'PUT', { enabled: true })).body.enabled, true);
    const reset = (await fixture.request('/api/telemetry/reset-id', 'POST', {})).body;
    assert.notEqual(reset.installId, status.installId);
    // Saved across restarts.
    await fixture.restart();
    assert.deepEqual([(await fixture.request('/api/telemetry')).body.enabled, (await fixture.request('/api/telemetry')).body.installId], [true, reset.installId]);
  } finally { await fixture.close(); }
});

test('usage stats count Bot token usage per model from T3 provider turns (latest-t3)', { timeout: 30000 }, async () => {
  const fixture = await createFixture({ scenario: 'latest-t3' });
  try {
    const preview = (await fixture.request('/api/telemetry/preview')).body;
    assert.equal(preview.t3code, '0.1.8-nightly.20261106.4275');
    assert.equal(preview.routines, '2-5');
    assert.deepEqual(preview.tokens, {
      // Two turns in Alpha's main thread and one in its child, with the models T3 reported.
      'fixture-opus': { turns: 3, inputTokens: 15400, cachedInputTokens: 11500, cacheCreationTokens: 500, outputTokens: 1040 },
      // Beta's turn names no model, so its run's selected model is used.
      'fixture-idle': { turns: 1, inputTokens: 500, cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 50 },
    });
    assert.doesNotMatch(JSON.stringify(preview), /Alpha|Beta|Gamma|Generic|thread-|project-|\/bots\//);
  } finally { await fixture.close(); }
});

test('a T3 project in a git repo becomes a Bot in place, keeps git status clean, and turns back without losing anything', { timeout: 60000 }, async () => {
  const fixture = await createFixture({ scenario: 'adopt' });
  try {
    const repo = path.join(fixture.root, ADOPT_REPO);
    const gitEnv = { PATH: process.env.PATH, HOME: path.join(fixture.root, 'home'), GIT_CONFIG_NOSYSTEM: '1', XDG_CONFIG_HOME: path.join(fixture.root, 'home', '.config') };
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: gitEnv });
    const status = () => git('status', '--porcelain', '--untracked-files=all');
    const read = (file: string) => readFile(path.join(repo, file), 'utf8');
    const before = { status: status(), head: git('rev-parse', 'HEAD'), exclude: await read('.git/info/exclude'), claude: await read('CLAUDE.md'), agents: await read('AGENTS.md'), gitignore: await read('.gitignore') };
    assert.equal(before.status, '');

    const listed = await fixture.request('/api/adoptable-projects');
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body.projects.map((p: Json) => [p.id, p.workspaceRoot, p.git, p.environmentId]), [['project-app', repo, true, 'local']], 'only the plain project, not the Bots');

    const worktree = await fixture.request('/api/bots/adopt', 'POST', { projectId: 'project-app', threadId: 'thread-app-wt', name: 'App Keeper' });
    assert.equal(worktree.status, 400, 'a thread in another worktree would never read the Bot\'s files');
    assert.match(worktree.body.error, /separate worktree/);
    assert.equal(status(), '', 'a refused adoption leaves nothing behind');
    const adopted = await fixture.request('/api/bots/adopt', 'POST', { projectId: 'project-app', threadId: 'thread-app-1', name: 'App Keeper', shape: 'sphere', color: 'teal' });
    assert.equal(adopted.status, 200, JSON.stringify(adopted.body));
    assert.equal(adopted.body.slug, 'app-keeper');
    assert.equal(adopted.body.adopted, true);
    assert.equal(adopted.body.workspaceRoot, repo);
    assert.equal(adopted.body.projectId, 'project-app');
    assert.equal(adopted.body.mainThreadId, 'thread-app-1', 'the picked thread, history included, is the main conversation');
    assert.equal(adopted.body.environmentId, 'local');

    // Instructions in the files each provider reads, the repo's own files untouched, git clean.
    const claudeLocal = await read('CLAUDE.local.md');
    assert.match(claudeLocal, /You are \*\*App Keeper\*\*/);
    assert.match(claudeLocal, /`\.bot\/memory\/MEMORY\.md`/);
    const override = await read('AGENTS.override.md');
    assert.match(override, /You are \*\*App Keeper\*\*/);
    assert.match(override, /Run the sample tests before pushing\./, "Codex's override carries the repo's AGENTS.md");
    assert.equal(JSON.parse(await read('.bot/bot.json')).name, 'App Keeper');
    assert.match(await read('.bot/memory/MEMORY.md'), /App Keeper memory/);
    assert.ok(JSON.parse(await read('.mcp.json')).mcpServers.bot.url.endsWith('/mcp/bot'));
    assert.equal(JSON.parse(await read('.claude/settings.local.json')).enableAllProjectMcpServers, true);
    assert.match(await read('.codex/config.toml'), /\[mcp_servers\.bot\]/);
    assert.match(await read('.git/info/exclude'), /# threebot:app-keeper:start[^\n]*\n\/\.bot\/\n\/CLAUDE\.local\.md\n\/AGENTS\.override\.md\n/);
    assert.equal(await read('CLAUDE.md'), before.claude);
    assert.equal(await read('AGENTS.md'), before.agents);
    assert.equal(await read('.gitignore'), before.gitignore);
    assert.equal(status(), '', 'git status stays clean');
    assert.equal(git('rev-parse', 'HEAD'), before.head);
    const registry = JSON.parse(await readFile(path.join(fixture.root, 'bots', '.botapp', 'adopted.json'), 'utf8'));
    assert.deepEqual(registry.bots.map((b: Json) => [b.slug, b.path, b.environmentId, b.projectId]), [['app-keeper', repo, 'local', 'project-app']]);

    // Discovery, memory and the T3 project, which keeps its own name.
    const bot = (await fixture.request('/api/bots')).body.bots.find((b: Json) => b.slug === 'app-keeper');
    assert.equal(bot.workspaceRoot, repo);
    const memory = await fixture.request('/api/memory?slug=app-keeper');
    assert.equal(memory.body.bot.path, '.bot/memory/MEMORY.md');
    assert.match(memory.body.bot.text, /App Keeper memory/);
    const saved = await fixture.request('/api/memory', 'PUT', { slug: 'app-keeper', scope: 'bot', text: '# App Keeper memory\n\n- The sample app ships on Fridays.\n', expectedRevision: memory.body.bot.revision });
    assert.equal(saved.status, 200);
    for (let i = 0; i < 50 && !(await read('CLAUDE.local.md')).includes('ships on Fridays'); i++) await new Promise((r) => setTimeout(r, 200));
    assert.match(await read('CLAUDE.local.md'), /ships on Fridays/, 'memory reaches the instructions');
    assert.match(await read('AGENTS.override.md'), /ships on Fridays/);
    const t3projects = (await fixture.request('/t3/api/projects')).body.projects;
    assert.equal(t3projects.find((p: Json) => p.id === 'project-app').title, 'Sample App');
    assert.equal(status(), '');
    assert.deepEqual((await fixture.request('/api/adoptable-projects')).body.projects, []);
    assert.equal((await fixture.request('/api/bots/adopt', 'POST', { projectId: 'project-app', name: 'Again' })).status, 409);
    assert.equal((await fixture.request('/api/bots/app-keeper', 'DELETE')).status, 409, 'deleting never trashes the project');

    // Turn back into a plain project.
    const released = await fixture.request('/api/bots/app-keeper/release', 'POST', {});
    assert.equal(released.status, 200, JSON.stringify(released.body));
    assert.ok(!released.body.bots.some((b: Json) => b.slug === 'app-keeper'));
    for (const gone of ['.bot', 'CLAUDE.local.md', 'AGENTS.override.md', '.mcp.json', '.claude', '.codex', '.pi']) assert.equal(existsSync(path.join(repo, gone)), false, gone);
    assert.equal(await read('.git/info/exclude'), before.exclude);
    assert.equal(status(), '');
    assert.equal(git('rev-parse', 'HEAD'), before.head);
    assert.equal(await read('CLAUDE.md'), before.claude);
    assert.equal(await read('AGENTS.md'), before.agents);
    const archive = released.body.archive;
    assert.ok(archive.startsWith(path.join(fixture.root, 'bots', '.botapp', 'adopted-archive', 'app-keeper-')));
    assert.match(await readFile(path.join(archive, 'memory', 'MEMORY.md'), 'utf8'), /ships on Fridays/);
    assert.ok(existsSync(path.join(archive, 'library')));
    assert.deepEqual(JSON.parse(await readFile(path.join(fixture.root, 'bots', '.botapp', 'adopted.json'), 'utf8')).bots, []);
    const projectsAfter = (await fixture.request('/t3/api/projects')).body.projects;
    assert.equal(projectsAfter.find((p: Json) => p.id === 'project-app').title, 'Sample App', 'the T3 project stays');
    assert.ok(!(await readFile(path.join(fixture.root, 'codex', 'config.toml'), 'utf8').catch(() => '')).includes(repo), 'Codex trust adoption added is taken back');

    // Again, with a new main conversation instead of an existing thread.
    const fresh = await fixture.request('/api/bots/adopt', 'POST', { projectId: 'project-app', threadId: null, name: 'App Keeper', shape: 'sphere', color: 'teal' });
    assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
    assert.ok(fresh.body.mainThreadId && !['thread-app-1', 'thread-app-2'].includes(fresh.body.mainThreadId), 'a new main thread');
    assert.equal(status(), '');
    assert.equal((await fixture.request(`/api/bots/${fresh.body.slug}/release`, 'POST', {})).status, 200);
    assert.equal(status(), '');
    assert.equal(await read('.git/info/exclude'), before.exclude);
  } finally { await fixture.close(); }
});

test('linked machines: discovered from T3, remote threads read and messaged in the app, one offline alert per outage, pairing for a direct route', { timeout: 60000 }, async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'bot-peer-'));
  const peer = await startFakeT3(scratch, 0, { environmentId: 'fixture-peer' });
  const links: FixtureLink[] = [{
    environmentId: 'fixture-peer', label: 'Fixture laptop', urls: [`http://127.0.0.1:${peer.port}`], status: 'reachable',
    threads: [{ threadId: 'remote-1', title: 'Remote sample work', status: 'running', messages: [
      { type: 'user_message', text: 'Fix the generic sample' }, { type: 'assistant_message', text: 'Working on the **generic sample**.' }] }],
    tasks: [{ parentThreadId: 'thread-alpha', threadId: 'remote-1', title: 'Remote sample work' }],
  }];
  const fixture = await createFixture({ links }); let rpc: T3Client | undefined;
  const until = async (what: string, check: () => Promise<boolean>, ms = 15000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 250)); }
    assert.fail(`timed out waiting for ${what}\n${fixture.logs}`);
  };
  const alphaMessages = async () => (await bounded(rpc!.call('orchestration.getThreadProjection', { threadId: 'thread-alpha' }))).turnItems.filter((item: Json) => item.type === 'user_message' && item.text.startsWith('From Threebot:')).map((item: Json) => item.text);
  try {
    rpc = new T3Client({ baseUrl: `http://127.0.0.1:${fixture.t3Port}`, token: 'fixture-only' }); await bounded(rpc.connect());
    // Discovery through the local T3, no routes file: this machine first, the linked one with its versions.
    const { machines, linksSupported } = (await fixture.request('/api/machines?fresh=1')).body;
    assert.equal(linksSupported, true);
    assert.deepEqual(machines.map((m: Json) => [m.environmentId, m.local, m.status, m.route]), [['fixture-only', true, 'online', 'local'], ['fixture-peer', false, 'online', 'linked']]);
    assert.equal(machines[1].t3Version, 'fixture');
    assert.equal(machines[1].laptop, true);
    // Remote threads open inside the app, and read and send through T3's forwarded tools.
    const link = await fetch(fixture.url + '/api/thread-link?environmentId=fixture-peer&threadId=remote-1', { redirect: 'manual' });
    assert.equal(link.headers.get('location'), '/?environment=fixture-peer&thread=remote-1');
    const read = (await fixture.request('/api/machines/fixture-peer/threads/remote-1')).body.read;
    assert.equal(read.thread.title, 'Remote sample work');
    assert.deepEqual(read.items.map((item: Json) => item.text), ['Fix the generic sample', 'Working on the **generic sample**.']);
    assert.equal((await fixture.request('/api/machines/fixture-peer/threads/remote-1/messages', 'POST', { text: 'A generic follow-up' })).status, 200);
    assert.equal(links[0].threads[0].messages.at(-1)!.text, 'A generic follow-up');
    assert.equal((await fixture.request('/api/machines/elsewhere/threads/remote-1')).status, 404);
    // The machine goes quiet with the Bot's task running there: one message to Alpha, then one when it's back.
    links[0].status = 'unreachable';
    await until('the offline alert', async () => (await alphaMessages()).length === 1);
    const [alert] = await alphaMessages();
    assert.match(alert, /^From Threebot: Fixture laptop went to sleep with this thread running:\n- \[Remote sample work\]\(t3-thread:\/\/v2\/fixture-peer\/remote-1\)/);
    const away = await fixture.request('/api/machines/fixture-peer/threads/remote-1');
    assert.equal(away.status, 503); assert.match(away.body.error, /Fixture laptop isn't reachable right now \(it's asleep\)/);
    await new Promise((resolve) => setTimeout(resolve, 3000));
    assert.equal((await alphaMessages()).length, 1, 'no repeat while it stays away');
    links[0].status = 'reachable';
    await until('the back-online message', async () => (await alphaMessages()).length === 2);
    assert.match((await alphaMessages())[1], /^From Threebot: Fixture laptop is back online/);
    // Pairing swaps a code for a direct route: live T3 traffic and files then go straight to that machine.
    assert.equal((await fixture.request('/api/machines/fixture-peer/pair', 'POST', { code: 'WRONG' })).status, 502);
    assert.equal((await fixture.request('/api/machines/fixture-peer/pair', 'POST', { code: FIXTURE_PAIRING_CODE })).status, 200);
    assert.equal((await fixture.request('/api/machines?fresh=1')).body.machines[1].route, 'direct');
    assert.equal((await (await fetch(fixture.url + '/t3/environments/fixture-peer/.well-known/t3/environment')).json()).environmentId, 'fixture-peer');
    const asset = await fetch(fixture.url + '/t3/environments/fixture-peer/fixture/attachments/sample-image');
    assert.equal(asset.headers.get('content-type'), 'image/svg+xml');
    // Where coding work runs reaches every Bot's instructions.
    assert.equal((await fixture.request('/api/settings', 'PUT', { codingWork: { preferred: { environmentId: 'fixture-peer', label: 'Fixture laptop' }, fallback: { environmentId: 'local', label: 'This machine' } } })).status, 200);
    const agents = await readFile(path.join(fixture.root, 'bots/alpha/AGENTS.md'), 'utf8');
    assert.match(agents, /## Where coding work runs\n- Coding work .* runs on \*\*Fixture laptop\*\* \(environmentId `fixture-peer`\)/);
    assert.equal((await fixture.request('/api/settings', 'PUT', { codingWork: { preferred: { environmentId: '../x' } } })).status, 400);
  } finally { rpc?.close(); await fixture.close(); await peer.close(); await rm(scratch, { recursive: true, force: true }); }
});

test('release-notes scenario: the real gateway passes on the offered and the running release notes, and the update notice', { timeout: 30000 }, async () => {
  const fixture = await createFixture({ scenario: 'release-notes' });
  try {
    const { status, body } = await fixture.request('/api/system');
    assert.equal(status, 200);
    const { next } = fixtureReleases(body.version);
    assert.equal(body.updateAvailable, true);
    assert.equal(body.latest.version, next);
    assert.match(body.latest.notes, new RegExp(`^\\*\\*v${next.replace(/\./g, '\\.')}\\*\\* · 9 changes from 4 contributors`));
    assert.match(body.latest.notes, /<summary>Full changelog<\/summary>/);
    assert.equal(body.current.version, body.version);
    assert.match(body.current.notes, /^## What's Changed\n\* Landing: show the GitHub star count by @RokaSwK/);
    assert.deepEqual([body.notice.kind, body.notice.version], ['updated', body.version]);
  } finally { await fixture.close(); }
});
