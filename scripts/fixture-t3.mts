// Deliberately small protocol-2 stub. Nothing here calls an agent or a real T3.
import http from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { ACTIVITY_SAMPLES, AVATAR_PROVIDERS, AVATAR_SAMPLES, LANDING_SAMPLES, fixtureReleases, landingData, seedActivity, seedAvatars, seedInteractions, seedLatestT3, validateScenario, FIXTURE_SPEECH_MAX_BODY } from './fixture-scenarios.mts';
import type { FixtureInteractions, FixtureItem, FixtureModel, FixtureProject, FixtureRequest, FixtureRun, FixtureSample, FixtureThread } from './fixture-scenarios.mts';
const require = createRequire(new URL('../server/package.json', import.meta.url));
const { WebSocketServer } = require('ws');

// The parts of a ws WebSocket the fixture uses (ws ships no types here).
type FixtureSocket = {
  send(data: string): void; close(code?: number, reason?: string): void;
  on(event: string, listener: (raw: unknown) => void): void;
};

export const MODEL: FixtureModel = { instanceId: 'fixture', model: 'fixture-idle' };
export const STAMP = '2026-01-01T12:00:00.000Z';
export const SAMPLES: FixtureSample[] = [
  { slug: 'alpha', name: 'Alpha', shape: 'sphere', color: 'teal', primary: true },
  { slug: 'beta', name: 'Beta', shape: 'clover', color: 'orange', primary: false },
  { slug: 'gamma', name: 'Gamma', shape: 'sparkle', color: 'purple', primary: false },
];
export const SAMPLE_IMAGE = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#128c87"/><text x="40" y="190" font-size="40" fill="white">Generic fixture image</text></svg>');
export const SAMPLE_BARS = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="480" height="600"><rect width="480" height="600" fill="#f4f1ea"/><rect x="60" y="340" width="90" height="200" fill="#e0703a"/><rect x="195" y="200" width="90" height="340" fill="#3a7be0"/><rect x="330" y="110" width="90" height="430" fill="#7a4fd0"/><text x="60" y="80" font-size="34" fill="#222">Generic sample bars</text></svg>');
export const SAMPLE_TEXT = Buffer.from('Generic attachment. No user data.\n');
export const samplesFor = (scenario: string): FixtureSample[] => scenario === 'landing' ? LANDING_SAMPLES : scenario === 'avatars' ? AVATAR_SAMPLES : scenario === 'activity' ? ACTIVITY_SAMPLES : SAMPLES;

/** A machine the fake T3 links (T3's peer links), with threads reached only through its forwarded tools. */
export type FixtureLink = {
  environmentId: string; label: string; urls: string[]; status: 'reachable' | 'unreachable' | 'expired';
  threads: { threadId: string; title: string; status: string; messages: { type: 'user_message' | 'assistant_message'; text: string }[] }[];
  /** Tasks a local thread runs there (a Bot's delegate_task with target.environmentId). */
  tasks?: { parentThreadId: string; threadId: string; title: string }[];
};
export const FIXTURE_PAIRING_CODE = 'FIXTURE-PAIR-ONLY';

export async function startFakeT3(root: string, port = 0, { scenario = 'basic', executor, environmentId = 'fixture-only', links }: {
  scenario?: string; executor?: { app: string; connection: string }; environmentId?: string; links?: FixtureLink[];
} = {}) {
  validateScenario(scenario);
  const samples = samplesFor(scenario);
  const landing = scenario === 'landing' ? landingData() : null;
  const projects = samples.map((bot): FixtureProject => ({ id: `project-${bot.slug}`, title: bot.name,
    workspaceRoot: landing ? `/Users/sam/Threebot/${bot.slug}` : path.join(root, 'bots', bot.slug), defaultModelSelection: MODEL, createdAt: STAMP, updatedAt: STAMP }));
  const makeThread = (slug: string, child = false): FixtureThread => ({ id: `thread-${slug}${child ? '-child' : ''}`,
    projectId: `project-${slug}`, title: child ? (landing?.child.title ?? 'Sample child review') : samples.find((bot) => bot.slug === slug)!.name,
    status: 'idle', activeRunId: null, latestRunId: null, modelSelection: MODEL, runtimeMode: 'auto',
    pendingRuntimeRequest: null, latestVisibleMessage: null, latestRunCompletedAt: STAMP, latestUserMessageAt: STAMP,
    lineage: { parentThreadId: child ? `thread-${slug}` : null, relationshipToParent: child ? 'subagent' : null, rootThreadId: `thread-${slug}` },
    archivedAt: null, settledOverride: null, settledAt: null, unsettledAt: null, snoozedUntil: null, autoSettleDisabledAt: null, lastVisitedAt: STAMP, createdAt: STAMP, updatedAt: STAMP });
  const threads = [...samples.map((bot) => makeThread(bot.slug)), ...(scenario === 'avatars' ? [] : [makeThread(landing?.child.parent ?? 'alpha', true)])];
  // adopt: a plain T3 project in a disposable git repo, with threads of its own, that can become a Bot.
  if (scenario === 'adopt') {
    projects.push({ id: 'project-app', title: 'Sample App', workspaceRoot: path.join(root, 'projects', 'sample-app'), defaultModelSelection: MODEL, createdAt: STAMP, updatedAt: STAMP });
    for (const [id, title] of [['thread-app-1', 'Fix the sample login form'], ['thread-app-2', 'Sample release notes']]) {
      threads.push({ ...makeThread('alpha'), id, projectId: 'project-app', title, lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id } });
    }
    // A thread in its own git worktree, which can't be the Bot's main thread.
    threads.push({ ...makeThread('alpha'), id: 'thread-app-wt', projectId: 'project-app', title: 'Sample worktree branch', worktreePath: path.join(root, 'projects', 'sample-app-wt'), lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: 'thread-app-wt' } } as FixtureThread);
  }
  const item = (threadId: string, ordinal: number, type: string, extra: Partial<FixtureItem>): FixtureItem => ({ id: `${threadId}-${ordinal}`, threadId, ordinal, type,
    runId: null, status: 'completed', title: null, startedAt: STAMP, completedAt: STAMP,
    updatedAt: STAMP, parentItemId: null, ...extra });
  const attachments = new Map([
    ['sample-image', { bytes: SAMPLE_IMAGE, mimeType: 'image/svg+xml' }],
    ['sample-file', { bytes: SAMPLE_TEXT, mimeType: 'text/plain' }],
  ]);
  // Synthetic Library resources; fixed IDs and no filesystem or provider access.
  const library = new Map<string, { mimeType: string; bytes: Buffer }>(scenario === 'library' ? [
    ['library/counter.html', { mimeType: 'text/html', bytes: Buffer.from('<!doctype html><html><body><h1>Sample counter card</h1><p>A disposable UI test with made-up data: increment the count or reset it to zero.</p><section style="margin-top:64px"><h2>Counter</h2><p id="count" style="font-size:48px;font-weight:600;margin:12px 0 28px">0</p><button onclick="document.getElementById(\'count\').textContent=++window.count">Increment</button> <button onclick="window.count=0;document.getElementById(\'count\').textContent=0">Reset</button><p style="margin-top:32px">The count lives only in this view and starts at zero each time the page opens.</p></section><script>window.count=0</script></body></html>') }],
    ['library/sample.csv', { mimeType: 'text/csv', bytes: Buffer.from('name,value\n"A,B",2\nC,3\n') }],
    ['library/photo.svg', { mimeType: 'image/svg+xml', bytes: SAMPLE_IMAGE }],
    ['library/bars.svg', { mimeType: 'image/svg+xml', bytes: SAMPLE_BARS }],
    ['library/notes.txt', { mimeType: 'text/plain', bytes: SAMPLE_TEXT }],
    ['library/audio.wav', { mimeType: 'audio/wav', bytes: (() => { const data=Buffer.alloc(44+1600);data.write('RIFF');data.writeUInt32LE(data.length-8,4);data.write('WAVEfmt ',8);data.writeUInt32LE(16,16);data.writeUInt16LE(1,20);data.writeUInt16LE(1,22);data.writeUInt32LE(8000,24);data.writeUInt32LE(16000,28);data.writeUInt16LE(2,32);data.writeUInt16LE(16,34);data.write('data',36);data.writeUInt32LE(1600,40);return data; })() }],
  ] : []);
  const items = new Map<string, FixtureItem[]>(threads.map((thread) => [thread.id, [
    item(thread.id, 1, 'user_message', { text: 'Please review these generic examples. This is disposable local fixture data.',
      attachments: [{ id: 'sample-image', type: 'image', name: 'sample-image.svg', mimeType: 'image/svg+xml', sizeBytes: SAMPLE_IMAGE.length },
        { id: 'sample-file', type: 'file', name: 'sample-notes-with-a-long-generic-attachment-name.txt', mimeType: 'text/plain', sizeBytes: SAMPLE_TEXT.length }] }),
    item(thread.id, 2, 'assistant_message', { text: 'Local fixture only. The provider is idle; no model runs.\n\n' +
      `https://example.invalid/${'long-generic-path-segment/'.repeat(18)}?sample=disposable\n\n` +
      '```js\nconst sample = "' + 'wide-code-example-'.repeat(20) + '";\n```\n\n' +
      '```\n  Generic plain code with Unicode: 雪 🪁\n\tsecond line\n\n```\n\n' +
      '| Sample | Details |\n| --- | --- |\n| Wide table | ' + 'generic_table_value_'.repeat(18) + ' |\n\n' +
      'Inline identifier: `' + 'long_identifier_'.repeat(22) + '`.\n\n' +
      '# Generic report heading\n\n## Sample section\n\n### Review checklist\n\n' +
      'A paragraph with **strong text**, *emphasis*, ~~removed text~~ and [a sample link](https://example.invalid/sample).\n\n' +
      '1. Review the first generic item.\n2. Review the second item.\n   - Nested supporting detail.\n   - Another nested detail.\n\n' +
      '- [x] A completed sample task.\n- [ ] A pending sample task.\n\n' +
      '> A generic quotation.\n>\n> A second quoted paragraph.\n\n' +
      [
        ['bash', 'echo "hello"'], ['ts', 'const count: number = 42;'],
        ['jsx', 'const view = <div title="hi">雪</div>;'], ['tsx', 'const view = <div title="hi">雪</div>;'],
        ['json', '{"answer": 42}'], ['python', 'def hello():\n    return 42'],
        ['html', '<div class="hello">雪</div>'], ['css', '.hello { color: red; }'],
        ['sql', 'SELECT answer FROM examples;'], ['yaml', 'answer: true'],
        ['unknown-fixture-language', 'Uncolored sample text: 雪 🪁'],
      ].map(([language, source]) => `\`\`\`${language}\n${source}\n\`\`\`\n\n`).join('') +
      'Attachment previews and child navigation use the local stub.' }),
    ...(thread.id === 'thread-alpha' ? [item(thread.id, 3, 'subagent', { title: 'Sample child review', childThreadId: 'thread-alpha-child', subagentId: 'sample-child' })] : []),
    ...(scenario === 'executor' && executor && thread.id === 'thread-alpha' ? [item(thread.id, 4, 'assistant_message', {
      text: `Manage this disposable sample app:\n\n[Connect Generic Service](${executor.app})\n\nContinue the seeded sample connection:\n\n[Connect Generic Service](${executor.connection})`,
    })] : []),
  ]]));
  if (scenario === 'library') {
    const at = new Date(Date.now() - 86400000).toISOString();
    for (const thread of threads) items.get(thread.id)!.push(item(thread.id, 10, 'assistant_message', {
      text: '[Sample counter card](library/counter.html) and [sample.csv](library/sample.csv)',
      startedAt: at, updatedAt: at, completedAt: at,
    }), item(thread.id, 11, 'assistant_message', {
      text: 'Two sample images from the Bot folder:\n\n![Generic fixture image: a teal card with white text](library/photo.svg)\n\n![Generic sample bars: three rising bars in orange, blue and purple](library/bars.svg)',
      startedAt: at, updatedAt: at, completedAt: at,
    }));
  }
  if (landing) {
    // Replace the generic transcripts with the invented personal ones, dated relative to now.
    const requests = new Map<string, FixtureRequest[]>(threads.map(({ id }) => [id, []]));
    for (const thread of threads) {
      const slug = thread.id.slice('thread-'.length);
      const entries = landing.transcripts[slug] ?? [];
      items.set(thread.id, entries.map(({ type, at, text, requestId, questions, ...extra }, index) => {
        const base = item(thread.id, index + 1, type, { startedAt: at, completedAt: at, updatedAt: at, ...extra });
        if (type === 'user_input_request') {
          requests.get(thread.id)!.push({ id: requestId!, nodeId: `node-${requestId}`, providerTurnId: null, nativeRequestRef: null, kind: 'user_input', status: 'pending',
            responseCapability: { type: 'live', providerSessionId: 'fixture-session' }, createdAt: at, resolvedAt: null });
          thread.pendingRuntimeRequest = { id: requestId!, kind: 'user_input', blocking: true };
          return { ...base, requestId, nodeId: `node-${requestId}`, questions, status: 'waiting', completedAt: null };
        }
        if (type === 'user_message') return { ...base, messageId: `${thread.id}-message-${index + 1}`, text, createdBy: 'user', creationSource: 'web', inputIntent: 'turn_start', attachments: [] };
        if (type === 'assistant_message') return { ...base, messageId: `${thread.id}-message-${index + 1}`, text };
        return base;
      }));
      const times = entries.map((entry) => entry.at).sort();
      const lastUser = entries.filter((entry) => entry.type === 'user_message').map((entry) => entry.at).sort().at(-1);
      const lastAssistant = entries.filter((entry) => entry.type === 'assistant_message').map((entry) => entry.at).sort().at(-1);
      const last = times.at(-1) ?? STAMP;
      const created = new Date(Date.parse(last) - 30 * 86400000).toISOString();
      Object.assign(thread, { createdAt: created, updatedAt: last, latestUserMessageAt: lastUser ?? created, latestRunCompletedAt: lastAssistant ?? created,
        lastVisitedAt: landing.unread.includes(slug) ? created : new Date(Date.parse(last) + 1000).toISOString() });
    }
    var landingInteractions: FixtureInteractions = { requests, inspect: () => ({ fixtureOnly: true, scenario: 'landing', liveDelivery: false }), armFailure: () => false, respond: () => null };
  }
  const runs = new Map<string, FixtureRun[]>(threads.map(thread => [thread.id, []]));
  const latest = scenario === 'latest-t3' ? seedLatestT3({ threads, items, runs, projects, model: MODEL, stamp: STAMP }) : null;
  const avatars = scenario === 'avatars' ? seedAvatars({ threads, items, runs, model: MODEL }) : null;
  const activity = scenario === 'activity' ? seedActivity({ threads, items, runs, model: MODEL }) : null;
  const interactions: FixtureInteractions | null = scenario === 'interactions' ? seedInteractions({ threads, items, stamp: STAMP }) : landing ? landingInteractions! : latest ?? avatars;
  const receipts = new Map<string, { sequence: number }>();
  const subscriptions = new Map<FixtureSocket, Map<string, { tag: string; threadId?: string }>>();
  let nextAttachment = 0;
  let sequence = 0;
  // T3 projections carry user messages beside turn items; Threebot counts them for PR chips.
  // Remote tasks show up on the local parent the way T3 records them: a subagent with remoteChild.
  const remoteTasks = (threadId: string) => (links ?? []).flatMap((link) => (link.tasks ?? []).filter((task) => task.parentThreadId === threadId).map((task) => ({
    id: `remote-task-${task.threadId}`, threadId, runId: null, status: link.threads.find((t) => t.threadId === task.threadId)?.status === 'completed' ? 'completed' : 'running',
    title: task.title, prompt: task.title, childThreadId: null, createdAt: STAMP, updatedAt: STAMP, startedAt: STAMP, completedAt: null,
    remoteChild: { environmentId: link.environmentId, threadId: task.threadId, label: link.label, title: task.title },
  })));
  const projection = (threadId: string) => ({ ...(remoteTasks(threadId).length ? { subagents: remoteTasks(threadId) } : {}), thread: threads.find((thread) => thread.id === threadId), turnItems: items.get(threadId) ?? [], messages: (items.get(threadId) ?? []).filter((item) => item.type === 'user_message').map((item) => ({ id: item.messageId ?? item.id, threadId, role: 'user', text: item.text, attachments: item.attachments ?? [], createdBy: item.createdBy, creationSource: item.creationSource })), runs: runs.get(threadId) ?? [], runtimeRequests: interactions?.requests.get(threadId) ?? [], ...(latest?.usage.get(threadId) ?? {}) });
  const chunk = (ws: FixtureSocket, id: string, value: unknown) => ws.send(JSON.stringify({ _tag: 'Chunk', requestId: id, values: [value] }));
  const exit = (ws: FixtureSocket, id: string, value: unknown) => ws.send(JSON.stringify({ _tag: 'Exit', requestId: id, exit: { _tag: 'Success', value } }));
  const fail = (ws: FixtureSocket, id: string, message: string) => ws.send(JSON.stringify({ _tag: 'Exit', requestId: id,
    exit: { _tag: 'Failure', cause: [{ _tag: 'Fail', error: { message } }] } }));
  const publish = () => {
    for (const [ws, subs] of subscriptions) for (const [id, sub] of subs) {
      if (sub.tag === 'orchestration.subscribeShell') chunk(ws, id, { kind: 'snapshot', snapshot: { projects, threads: threads.filter((t) => !t.archivedAt) } });
      if (sub.tag === 'orchestration.subscribeThread') chunk(ws, id, { kind: 'snapshot', projection: projection(sub.threadId!) });
      if (sub.tag === 'scheduledTasks.subscribe' && latest) chunk(ws, id, { tasks: latest.tasks });
    }
  };
  const stopActivity = activity?.start(publish);
  const readText = async (req: http.IncomingMessage) => { const chunks: Buffer[] = []; for await (const buffer of req) chunks.push(buffer); return Buffer.concat(chunks).toString('utf8'); };
  // T3's MCP sign-in, as the gateway runs it with its own bearer: register, approve, swap the code.
  const mcpTokens = new Set<string>();
  const mcpOAuth = async (req: http.IncomingMessage, res: http.ServerResponse, route: string) => {
    const text = await readText(req);
    if (route === '/oauth/mcp/register') return json(res, 201, { client_id: 'fixture-client', client_name: 'Threebot', redirect_uris: JSON.parse(text).redirect_uris, grant_types: ['authorization_code'], response_types: ['code'], token_endpoint_auth_method: 'none' });
    const signedIn = req.headers.authorization === 'Bearer fixture-only';
    if (route === '/oauth/mcp/approval') return json(res, 200, { clientName: 'Threebot', redirectHost: '127.0.0.1', environmentHost: '127.0.0.1', ...(signedIn ? { csrfToken: 'fixture-csrf', oneClickAccess: ['read-only', 'auto'] } : {}) });
    if (route === '/oauth/mcp/decision') {
      const body = JSON.parse(text);
      if (!signedIn || body.decision?.csrfToken !== 'fixture-csrf') return json(res, 400, { _tag: 'AuthMcpApprovalError', message: 'Your session cannot approve this request.' });
      return json(res, 200, { redirectTo: `${body.authorization.redirect_uri}?code=fixture-code&state=${body.authorization.state}` });
    }
    if (route === '/oauth/mcp/token') {
      const form = new URLSearchParams(text);
      if (form.get('code') !== 'fixture-code' || !form.get('code_verifier')) return json(res, 400, { error: 'invalid_grant', error_description: 'Bad code' });
      const issued = `fixture-mcp-${mcpTokens.size + 1}`;
      mcpTokens.add(issued);
      return json(res, 200, { access_token: issued, token_type: 'Bearer', expires_in: 2592000, scope: 'orchestration:read orchestration:operate' });
    }
    return json(res, 404, { error: 'not found' });
  };
  // T3's tool server, forwarding thread reads and sends to the linked machine like the real one.
  const mcpCall = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    if (!mcpTokens.has(String(req.headers.authorization ?? '').replace(/^Bearer /, ''))) return json(res, 401, { error: 'Only MCP client sessions are accepted here.' });
    const body = JSON.parse(await readText(req));
    if (body.method === 'initialize') { res.setHeader('mcp-session-id', 'fixture-mcp-session'); return json(res, 200, { jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'T3 Code', version: 'fixture' } } }); }
    if (!body.id) { res.writeHead(202); return res.end(); }
    const toolResult = (value: unknown, isError = false) => json(res, 200, { jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify(value) }], ...(isError ? { isError: true } : {}) } });
    const args = body.params?.arguments ?? {};
    const link = links!.find((candidate) => candidate.environmentId === args.environmentId);
    if (!link) return toolResult({ message: 'That environment is not linked.' }, true);
    if (link.status !== 'reachable') return toolResult({ message: `${link.label} did not answer.` }, true);
    const thread = link.threads.find((candidate) => candidate.threadId === args.threadId);
    if (!thread) return toolResult({ message: 'Thread not found there.' }, true);
    if (body.params.name === 't3_thread_read') {
      const after = typeof args.afterPosition === 'number' ? args.afterPosition : -1;
      const all = thread.messages.map((message, position) => ({ position, itemId: `${thread.threadId}-${position}`, type: message.type, text: message.text, textTruncated: false, status: 'completed', createdBy: message.type === 'user_message' ? 'user' : 'agent', updatedAt: STAMP }));
      const visible = all.filter((entry) => entry.position > after);
      return toolResult({ thread: { threadId: thread.threadId, title: thread.title, status: thread.status, itemCount: all.length, activeRunId: null, updatedAt: STAMP }, items: visible, nextPosition: visible.at(-1)?.position ?? null, hasMore: false });
    }
    if (body.params.name === 't3_thread_send') {
      thread.messages.push({ type: 'user_message', text: String(args.message) });
      return toolResult({ threadId: thread.threadId, messageId: `fixture-remote-${thread.messages.length}`, runId: 'fixture-remote-run', status: 'running', delivery: 'started' });
    }
    return toolResult({ message: `Unavailable in local fixture: ${body.params.name}` }, true);
  };
  const json = (res: http.ServerResponse, status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url!, 'http://127.0.0.1');
      if (url.pathname === '/api/auth/websocket-ticket/rpc' && req.method === 'POST') return json(res, 200, { ticket: 'fixture-only' });
      if (url.pathname === '/api/projects' && req.method === 'GET') return json(res, 200, { projects });
      if (scenario === 'release-notes' && url.pathname === '/fixture/releases' && req.method === 'GET') return json(res, 200, fixtureReleases(String(url.searchParams.get('current'))).list);
      if (latest && url.pathname === '/api/voice/status' && req.method === 'GET') return json(res, 200, latest.voiceStatus);
      if (latest && url.pathname === '/api/voice/transcribe' && req.method === 'POST') {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const buffer of req) {
          size += buffer.length;
          if (size > FIXTURE_SPEECH_MAX_BODY) return json(res, 400, latest.transcribe(Buffer.alloc(0)).body);
          chunks.push(buffer);
        }
        const result = latest.transcribe(Buffer.concat(chunks));
        return json(res, result.status, result.body);
      }
      if (url.pathname === '/.well-known/t3/environment') return json(res, 200, { label: 'Disposable local fixture (fake T3)', serverVersion: 'fixture', environmentId, platform: { os: 'fixture', arch: 'fixture', machine: links ? 'server' : 'laptop' }, ...(links ? { capabilities: { peerLinks: true } } : {}) });
      // T3's token exchange for a one-time pairing code; only the fixture's own code works.
      if (url.pathname === '/oauth/token' && req.method === 'POST') {
        const form = new URLSearchParams(await readText(req));
        return form.get('subject_token') === FIXTURE_PAIRING_CODE ? json(res, 200, { access_token: 'fixture-only', issued_token_type: 'urn:ietf:params:oauth:token-type:access_token', token_type: 'Bearer', expires_in: 3600, scope: 'orchestration:read' }) : json(res, 400, { error: 'invalid_grant' });
      }
      if (links && url.pathname.startsWith('/oauth/mcp/')) return mcpOAuth(req, res, url.pathname);
      if (links && url.pathname === '/mcp' && req.method === 'POST') return mcpCall(req, res);
      if (interactions && url.pathname === '/fixture/interactions' && req.method === 'GET') return json(res, 200, interactions.inspect());
      if (interactions && url.pathname === '/fixture/interactions/fail-once' && req.method === 'POST') {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const buffer of req) {
          size += buffer.length;
          if (size > 1024) return json(res, 413, { error: 'Fixture control body too large.' });
          chunks.push(buffer);
        }
        let body: unknown;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { return json(res, 400, { error: 'Invalid fixture control body.' }); }
        return interactions.armFailure(body) ? json(res, 200, { fixtureOnly: true, armed: true }) :
          json(res, 400, { error: 'Fixture control requires a known pending targetId.' });
      }
      if (url.pathname.startsWith('/fixture/library/') && req.method === 'GET') {
        const resource = library.get('library/' + decodeURIComponent(url.pathname.slice('/fixture/library/'.length)));
        if (!resource) return json(res, 404, { error: 'File unavailable' });
        if (url.searchParams.get('signature') !== 'fixture+read/') return json(res, 403, { error: 'Invalid fixture signature' });
        const headers: Record<string, string> = { 'content-type': resource.mimeType, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'accept-ranges': 'bytes' };
        if (url.searchParams.get('download') === '1') headers['content-disposition'] = 'attachment';
        if (req.headers.range) {
          const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
          const start = match ? Number(match[1]) : NaN;
          const end = match?.[2] ? Math.min(Number(match[2]), resource.bytes.length - 1) : resource.bytes.length - 1;
          if (!Number.isInteger(start) || start > end || start >= resource.bytes.length) { res.writeHead(416, headers); return res.end(); }
          res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${resource.bytes.length}` });
          return res.end(resource.bytes.subarray(start, end + 1));
        }
        res.writeHead(200, headers);
        return res.end(resource.bytes);
      }
      const match = /^\/fixture\/attachments\/([a-z0-9-]+)$/.exec(url.pathname);
      const attachment = match && attachments.get(match[1]);
      if (attachment && req.method === 'POST' && !match[1].startsWith('sample-')) {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const buffer of req) {
          size += buffer.length;
          if (size > 8 * 1024 * 1024) return json(res, 413, { error: 'Fixture upload limit is 8 MiB' });
          chunks.push(buffer);
        }
        attachment.bytes = Buffer.concat(chunks);
        return json(res, 200, { ok: true, fixtureOnly: true });
      }
      if (attachment && req.method === 'GET') {
        res.writeHead(200, { 'content-type': attachment.mimeType, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        return res.end(attachment.bytes);
      }
      json(res, 501, { error: interactions ? 'Unavailable in local fixture. No real T3 or model is connected.' : `Unavailable in local fixture: ${req.method} ${url.pathname}` });
    } catch (error) { json(res, 500, { error: interactions ? 'Fixture HTTP request failed.' : (error as Error).message }); }
  });
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws: FixtureSocket) => {
    const subs = new Map<string, { tag: string; threadId?: string }>();
    subscriptions.set(ws, subs);
    ws.on('close', () => subscriptions.delete(ws));
    ws.on('message', (raw) => {
      try {
        const message = JSON.parse(String(raw));
        if (message._tag === 'Ping') return ws.send(JSON.stringify({ _tag: 'Pong' }));
        if (message._tag === 'Interrupt') { subs.delete(message.requestId); return exit(ws, message.requestId, null); }
        if (message._tag === 'Eof') return ws.close();
        if (message._tag !== 'Request') return;
        const { id, tag, payload = {} } = message;
        const response = interactions?.respond(tag, payload, { publish });
        if (response) {
          if (response.error) return fail(ws, id, response.error);
          exit(ws, id, 'value' in response ? response.value : tag === 'secrets.answerRequest' ? null : { sequence: ++sequence });
          publish();
          return;
        }
        if (tag === 'orchestration.subscribeShell') {
          subs.set(id, { tag });
          return chunk(ws, id, { kind: 'snapshot', snapshot: { projects, threads: threads.filter((t) => !t.archivedAt) } });
        }
        if (tag === 'scheduledTasks.subscribe') { subs.set(id, { tag }); return chunk(ws, id, { tasks: landing?.tasks ?? latest?.tasks ?? [] }); }
        if (tag === 'orchestration.getThreadProjection') {
          if (!items.has(payload.threadId)) return fail(ws, id, 'Unknown fixture thread');
          return exit(ws, id, projection(payload.threadId));
        }
        if (tag === 'orchestration.subscribeThread') {
          if (!items.has(payload.threadId)) return fail(ws, id, 'Unknown fixture thread');
          subs.set(id, { tag, threadId: payload.threadId });
          return chunk(ws, id, { kind: 'snapshot', projection: projection(payload.threadId) });
        }
        if (tag === 'peerLinks.list' && links) return exit(ws, id, { links: links.map(({ threads: _threads, tasks: _tasks, ...link }) => ({ ...link, access: 'full-access', linkedAt: STAMP, expiresAt: '2099-01-01T00:00:00.000Z', lastReachedAt: STAMP, lastError: null })) });
        if (tag === 'server.getConfig') return exit(ws, id, { providers: [landing ? { instanceId: 'fixture', driver: 'fixture', displayName: 'Claude Code', enabled: true, status: 'ready', models: [{ slug: MODEL.model, name: 'Opus 5.5', isDefault: true }] } : { instanceId: 'fixture', driver: 'fixture', displayName: 'Fixture provider (no inference)', enabled: true, status: 'ready', models: [{ slug: MODEL.model, name: 'Fixture idle model', isDefault: true }] }, ...(avatars ? AVATAR_PROVIDERS : [])], shellOlderSettled: true, threadFind: true, threadResumeCompletionMarker: true, ...(latest ?? avatars ? { environment: { capabilities: (latest ?? avatars)!.capabilities, ...(latest ? { serverVersion: latest.serverVersion } : {}) } } : {}), settings: { providerModelPreferences: {}, snoozePresets: [{ kind: "after", minutes: 60 }, { kind: "after", minutes: 180 }, { kind: "at", day: "tomorrow", time: "09:00" }] } });
        if (tag === 'orchestration.getThreadFamily') return exit(ws, id, { threads: threads.filter((thread) => thread.lineage.rootThreadId === threads.find((t) => t.id === payload.threadId)?.lineage.rootThreadId) });
        if (tag === 'orchestration.getArchivedShellSnapshot') return exit(ws, id, { snapshotSequence: sequence, projects, threads: threads.filter((t) => t.archivedAt) });
        if (tag === 'orchestration.getOlderSettledThreads') return exit(ws, id, { snapshotSequence: sequence, threads: threads.filter((t) => t.settledAt && !t.archivedAt && (t.settledAt < payload.before.settledAt || (t.settledAt === payload.before.settledAt && t.id > (payload.before.threadId ?? '\uffff')))).sort((a,b) => b.settledAt!.localeCompare(a.settledAt!) || a.id.localeCompare(b.id)).slice(0, payload.limit), counts: [] });
        if (tag === 'orchestration.searchThreads') return exit(ws, id, { matches: threads.flatMap((t) => (items.get(t.id) ?? []).filter((item) => /^(user|assistant)_message$/.test(item.type) && item.text!.toLowerCase().includes(payload.query.toLowerCase())).slice(0,1).map((item) => ({ threadId: t.id, projectId: t.projectId, messageId: item.id, snippet: item.text!.slice(0,240), source: item.type === 'user_message' ? 'user' : 'assistant', messageCreatedAt: item.updatedAt }))).slice(0, payload.limit) });
        if (tag === 'orchestration.searchThread') { const match = (items.get(payload.threadId) ?? []).find((item) => item.text?.toLowerCase().includes(payload.query.toLowerCase())); return exit(ws, id, { snapshotSequence: sequence, totalMatches: match ? 1 : 0, activeIndex: 0, match: match ? { entryId: match.id, runId: match.runId, occurrence: 0 } : null, navigation: [] }); }
        if (scenario === 'adopt' && tag === 'orchestration.launchThread') {
          if (!projects.some((p) => p.id === payload.projectId)) return fail(ws, id, 'Unknown fixture project');
          const thread = { ...makeThread('alpha'), id: payload.threadId, projectId: payload.projectId, title: payload.title, lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: payload.threadId } };
          threads.push(thread);
          items.set(thread.id, []);
          runs.set(thread.id, []);
          publish();
          return exit(ws, id, { sequence: ++sequence });
        }
        if (tag === 'projects.searchEntries') return exit(ws, id, { entries: 'sample-notes.txt'.includes(payload.query.toLowerCase()) ? [{ path: 'sample-notes.txt', kind: 'file' }] : [], truncated: false });
        if (tag === 'projects.listEntries') return exit(ws, id, { entries: payload.directoryPath === 'library' && projects.some(p => p.workspaceRoot === payload.cwd) ? [...library.keys()].map(path => ({ path, kind: 'file' })) : [], truncated: false });
        if (tag === 'projects.readFile') return exit(ws, id, { contents: null });
        if (tag === 'projects.mutate' && payload.type === 'project.update') {
          const project = projects.find((p) => p.id === payload.projectId);
          if (!project) return fail(ws, id, 'Unknown fixture project');
          for (const key of ['title', 'faviconPath', 'projectIcon', 'defaultModelSelection'] as const) if (key in payload) project[key] = payload[key];
          if (typeof payload.archived === 'boolean') project.archivedAt = payload.archived ? (project.archivedAt ?? new Date().toISOString()) : null;
          publish();
          return exit(ws, id, { sequence: ++sequence });
        }
        // Scripted ACK and running/Stop lifecycle only. Never starts a provider.
        if (tag === 'orchestration.dispatchCommand' && ['message.dispatch', 'thread.stop'].includes(payload.type)) {
          const thread = threads.find(thread => thread.id === payload.threadId);
          if (!thread) return fail(ws, id, 'Unknown fixture thread');
          if (receipts.has(payload.commandId)) return exit(ws, id, receipts.get(payload.commandId));
          const now = new Date().toISOString();
          const threadRuns = runs.get(thread.id)!;
          if (payload.type === 'message.dispatch') {
            if (typeof payload.text !== 'string' || typeof payload.messageId !== 'string') return fail(ws, id, 'Unavailable in local fixture: a scripted message requires an explicit message ID. No real T3 or model is connected.');
            let run = threadRuns.find(run => run.status === 'running');
            if (!run) {
              run = { id: `fixture-run-${threadRuns.length + 1}-${thread.id}`, userMessageId: payload.messageId, ordinal: threadRuns.length + 1, status: 'running', requestedAt: now, startedAt: now, completedAt: null, modelSelection: MODEL };
              threadRuns.push(run);
            }
            const entries = items.get(thread.id)!;
            entries.push(item(thread.id, entries.length + 1, 'user_message', { messageId: payload.messageId, text: payload.text, runId: run.id, createdBy: payload.createdBy === 'agent' ? 'agent' : 'user', creationSource: payload.creationSource === 'server' ? 'server' : 'web', attachments: payload.attachments ?? [], ...(payload.freshContext === true ? { freshContext: true } : {}), updatedAt: now }));
            Object.assign(thread, { status: 'running', activityRunStatus: 'running', activeRunId: run.id, latestRunId: run.id, latestRunStartedAt: now });
            avatars?.afterMessage(thread, payload.text, publish);
          } else {
            for (const run of threadRuns) if (run.status === 'running') Object.assign(run, { status: 'interrupted', completedAt: now });
            Object.assign(thread, { status: 'idle', activityRunStatus: null, activeRunId: null, pendingRuntimeRequest: null });
          }
          thread.updatedAt = now;
          const receipt = { sequence: ++sequence };
          receipts.set(payload.commandId, receipt);
          exit(ws, id, receipt);
          publish();
          return;
        }
        if (tag === 'orchestration.dispatchCommand' && ['thread.visit', 'thread.mark-unread', 'thread.settle', 'thread.unsettle', 'thread.snooze', 'thread.unsnooze', 'thread.archive', 'thread.unarchive', 'thread.auto-settle.set', 'thread.runtime-mode.set', 'thread.model-selection.set'].includes(payload.type)) {
          const thread = threads.find((t) => t.id === payload.threadId);
          if (!thread) return fail(ws, id, 'Unknown fixture thread');
          const now = new Date().toISOString();
          if (payload.type === 'thread.settle') { thread.settledOverride = 'settled'; thread.settledAt = now; thread.unsettledAt = null; }
          if (payload.type === 'thread.unsettle') { thread.settledOverride = 'active'; thread.settledAt = null; thread.unsettledAt = now; }
          if (payload.type === 'thread.snooze') thread.snoozedUntil = payload.snoozedUntil;
          if (payload.type === 'thread.unsnooze') thread.snoozedUntil = null;
          if (payload.type === 'thread.archive') thread.archivedAt = now;
          if (payload.type === 'thread.unarchive') thread.archivedAt = null;
          if (payload.type === 'thread.auto-settle.set') thread.autoSettleDisabledAt = payload.enabled ? null : now;
          if (payload.type === 'thread.mark-unread') thread.lastVisitedAt = new Date(Date.parse(thread.latestRunCompletedAt ?? STAMP) - 1).toISOString();
          thread.updatedAt = now;
          if (payload.type === 'thread.visit') thread.lastVisitedAt = payload.visitedAt;
          if (payload.type === 'thread.runtime-mode.set') thread.runtimeMode = payload.runtimeMode;
          if (payload.type === 'thread.model-selection.set') thread.modelSelection = payload.modelSelection;
          publish();
          return exit(ws, id, { sequence: ++sequence });
        }
        if (tag === 'attachments.createUploadUrl') {
          if (payload.sizeBytes > 8 * 1024 * 1024) return fail(ws, id, 'Fixture upload limit is 8 MiB');
          const attachmentId = `upload-${++nextAttachment}`;
          attachments.set(attachmentId, { bytes: Buffer.alloc(0), mimeType: payload.mimeType || 'application/octet-stream' });
          return exit(ws, id, { attachmentId, relativeUrl: `/fixture/attachments/${attachmentId}` });
        }
        if (tag === 'assets.createUrl' && ['workspace-file', 'media-file'].includes(payload.resource?._tag) && library.has(payload.resource.path)) {
          if (!threads.some(thread => thread.id === payload.resource.threadId)) return fail(ws, id, 'Unknown fixture thread');
          const resource = payload.resource;
          // Mirror T3 AssetAccess's distinct preview and generic-download contracts.
          if (resource._tag === 'workspace-file' && !/\.(html?|pdf|svg|png)$/i.test(resource.path)) return fail(ws, id, 'Only browser documents and images can be previewed.');
          if (resource._tag === 'media-file' && resource.disposition !== 'attachment' && !/\.(wav|mp4|svg|png|html?|pdf)$/i.test(resource.path)) return fail(ws, id, 'Only images, videos, audio, HTML, and PDF files can be previewed.');
          return exit(ws, id, { relativeUrl: '/fixture/' + resource.path + '?signature=fixture%2Bread%2F' + (resource.disposition === 'attachment' ? '&download=1' : '') });
        }
        if (tag === 'assets.createUrl' && payload.resource?._tag === 'media-file' && payload.resource.disposition === 'attachment' && payload.resource.path === 'sample-notes.txt') {
          if (!threads.some(thread => thread.id === payload.resource.threadId)) return fail(ws, id, 'Unknown fixture thread');
          return exit(ws, id, { relativeUrl: '/fixture/attachments/sample-file' });
        }
        if (tag === 'assets.createUrl' && attachments.has(payload.resource?.attachmentId)) return exit(ws, id, { relativeUrl: `/fixture/attachments/${payload.resource.attachmentId}` });
        fail(ws, id, interactions ? 'Unavailable in local fixture. No real T3 or model is connected.' : `Unavailable in local fixture: ${tag}${payload.type ? ` (${payload.type})` : ''}. No real T3 or model is connected.`);
      } catch { ws.close(1003, 'Invalid fixture RPC'); }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return {
    port: (server.address() as AddressInfo).port,
    async close() {
      stopActivity?.();
      for (const ws of wss.clients) ws.terminate();
      await new Promise((resolve) => wss.close(resolve));
      await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    },
  };
}
