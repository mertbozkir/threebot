import assert from 'node:assert/strict';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import net from 'node:net';
import type { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { Bot } from './main-bot.mts';

// This gateway only sees temporary fixture directories and an unreachable local T3 port.
// It never reads real credentials, connects to a real T3, or changes a user's Bots.
test('gateway main-Bot endpoints persist replacement and reject unsafe hides/deletes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'main-bot-api-'));
  const botsRoot = path.join(root, 'bots');
  for (const slug of ['alpha', 'beta']) {
    const dir = path.join(botsRoot, slug, '.bot');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'bot.json'), JSON.stringify({ name: slug, mainThreadId: `thread-${slug}`, primary: true, createdAt: '2026-01-01T00:00:00Z' }));
  }
  await mkdir(path.join(botsRoot, 'alpha', 'memory'), { recursive: true });
  await writeFile(path.join(botsRoot, 'alpha', 'memory', 'MEMORY.md'), '# Alpha memory\n\n- [preference] Prefers short answers.\n');
  const socket = net.createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const { port } = socket.address() as net.AddressInfo;
  await new Promise((resolve) => socket.close(resolve));
  // Typed through a cast so the closures below that assign it don't leave it narrowed to null.
  let processHandle = null as ChildProcessByStdio<null, Readable, Readable> | null;
  try {
    const start = async () => {
      processHandle = spawn(process.execPath, [fileURLToPath(new URL('./gateway.mts', import.meta.url))], {
        env: {
          PATH: process.env.PATH, HOME: root, CODEX_HOME: path.join(root, 'codex'),
          HOST: '127.0.0.1', PORT: String(port), BOTS_ROOT: botsRoot, T3_URL: 'http://127.0.0.1:1',
          T3_TOKEN: 'fixture-only', BOT_MCP_TOKEN: 'fixture-only', BOT_PASSWORD: '',
          VAULT_FILE: path.join(root, 'vault.enc'), VAULT_KEY_FILE: path.join(root, 'vault-key'),
        }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      processHandle.stderr.on('data', () => {});
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('fixture gateway did not start')), 5000);
        processHandle!.once('error', (error) => { clearTimeout(timeout); reject(error); });
        processHandle!.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`fixture gateway exited ${code}`)); });
        processHandle!.stdout.on('data', (chunk) => {
          output += String(chunk);
          if (output.includes('bot gateway on')) { clearTimeout(timeout); resolve(); }
        });
      });
    };
    const stop = async () => {
      const exited = once(processHandle!, 'exit');
      processHandle!.kill();
      await exited;
    };
    const request = async (route: string, method = 'GET', body?: unknown) => {
      const response = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      // The gateway's JSON replies, read field by field by the assertions below.
      return { status: response.status, body: (await response.json()) as any };
    };
    const mcp = async (token: string, body: unknown) => {
      const response = await fetch(`http://127.0.0.1:${port}/mcp/bot`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body),
      });
      return (await response.json()) as any;
    };
    const main = (bots: Bot[]) => bots.filter((bot) => bot.primary).map((bot) => bot.slug);
    await start();
    assert.deepEqual(main((await request('/api/bots')).body.bots), ['alpha']);
    const replacement = await request('/api/main-bot', 'PUT', { slug: 'beta' });
    assert.equal(replacement.status, 200);
    assert.deepEqual(main(replacement.body.bots), ['beta']);
    assert.equal((await request('/api/bots/alpha')).body.primary, false);
    assert.equal((await request('/api/bots/beta')).body.primary, true);
    assert.equal((await request('/api/bots/beta', 'PUT', { hidden: true })).status, 409);
    assert.equal((await request('/api/bots/beta', 'DELETE')).status, 409);
    assert.equal((await request('/api/main-bot', 'PUT', { slug: 'missing' })).status, 404);
    assert.equal((await request('/api/main-bot', 'PUT', null)).status, 400);

    assert.equal((await request('/api/bots/alpha', 'PUT', { creator: true })).body.creator, true);
    assert.equal((await request('/api/bots/beta', 'PUT', { creator: true })).status, 409);
    assert.equal((await request('/api/bots/alpha', 'GET')).body.creator, true);
    assert.equal((await request('/api/bots/alpha', 'PUT', { creator: false })).body.creator, false);

    // Instructions: the owner's part is editable; the managed block is left alone.
    const agents = path.join(botsRoot, 'alpha', 'AGENTS.md');
    await writeFile(agents, '<!-- bot:managed:start -->\n# You are Alpha\n\nManaged text.\n<!-- bot:managed:end -->\n\n## Mine\n- Review code.\n');
    const instructionsResponse = await request('/api/instructions?slug=alpha');
    assert.equal(instructionsResponse.status, 200);
    assert.match(instructionsResponse.body.text, /Review code/u);
    const savedInstructions = await request('/api/instructions', 'PUT', { slug: 'alpha', text: '## Mine\n- Be direct.\n', expectedRevision: instructionsResponse.body.revision });
    assert.equal(savedInstructions.status, 200);
    const rewritten = await readFile(agents, 'utf8');
    assert.match(rewritten, /<!-- bot:managed:start -->[\s\S]*Managed text\.[\s\S]*<!-- bot:managed:end -->/u);
    assert.match(rewritten, /## Mine\n- Be direct\.\n$/u);
    assert.equal((await request('/api/instructions', 'PUT', { slug: 'alpha', text: 'stale', expectedRevision: instructionsResponse.body.revision })).status, 409);

    // A new Bot can be born with its owner's instructions.
    const created = await request('/api/bots', 'POST', { name: 'Gamma', instructions: '## What this Bot does\n- Keep the docs true.\n' });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const gammaAgents = await readFile(path.join(botsRoot, 'gamma', 'AGENTS.md'), 'utf8');
    assert.match(gammaAgents, /## What this Bot does\n- Keep the docs true\.\n/u);
    assert.match(gammaAgents, /<!-- bot:managed:start -->/u);
    // Leave the rest of this fixture as it was: two Bots, one main.
    assert.equal((await request('/api/bots/gamma', 'DELETE')).status, 200);
    // The same 12k cap as the tab applies before the folder exists.
    const tooLong = await request('/api/bots', 'POST', { name: 'Delta', instructions: 'x'.repeat(12_001) });
    assert.equal(tooLong.status, 400);
    assert.equal((await request('/api/bots')).body.bots.some((bot: Bot) => bot.slug === 'delta'), false);
    assert.equal((await request('/api/bots/missing', 'PUT', { primary: true })).status, 404);
    // A colour is a palette name or a hex colour, stored as "#rrggbb"; anything else is refused.
    assert.equal((await request('/api/bots/alpha', 'PUT', { color: '#3FA7D6' })).body.color, '#3fa7d6');
    assert.equal((await request('/api/bots/alpha', 'PUT', { color: '#3fa' })).body.color, '#33ffaa');
    assert.equal((await request('/api/bots/alpha', 'PUT', { color: 'violet' })).body.color, 'violet');
    for (const color of ['3fa7d6', '#3fa7d', 'rgb(1, 2, 3)', 'url(#x)', '__proto__', 12, null]) {
      const refused = await request('/api/bots/alpha', 'PUT', { color });
      assert.equal(refused.status, 400, `${JSON.stringify(color)} should be refused`);
      assert.match(refused.body.error, /Invalid colour/);
    }
    assert.equal((await request('/api/bots/alpha')).body.color, 'violet');
    assert.deepEqual(main((await request('/api/bots')).body.bots), ['beta']);
    const instructions = await readFile(path.join(botsRoot, 'alpha/AGENTS.md'), 'utf8');
    assert.doesNotMatch(instructions, /You are the primary Bot/);
    assert.match(instructions, /<memory>/);
    assert.match(instructions, /Prefers short answers/);
    const alphaMcp = JSON.parse(await readFile(path.join(botsRoot, 'alpha/.mcp.json'), 'utf8'));
    const alphaToken = String(alphaMcp.mcpServers.bot.headers.Authorization).replace(/^Bearer\s+/u, '');
    assert.match(alphaToken, /^[a-f0-9]{64}$/u);
    assert.notEqual(alphaToken, 'fixture-only');
    const alphaPi = JSON.parse(await readFile(path.join(botsRoot, 'alpha/.pi/mcp.json'), 'utf8'));
    assert.equal(alphaPi.mcpServers.bot.url, `http://127.0.0.1:${port}/mcp/bot`);
    assert.equal(alphaPi.mcpServers.bot.type, 'streamable-http');
    assert.equal(alphaPi.mcpServers.bot.headers.Authorization, `Bearer ${alphaToken}`);
    const listed = await mcp(alphaToken, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const toolNames = listed.result.tools.map((tool: { name: string }) => tool.name);
    assert.ok(toolNames.includes('vault_list'));
    assert.ok(!toolNames.some((name: string) => name.startsWith('memory_')));
    const memoryFiles = await request('/api/memory?slug=alpha');
    assert.equal(memoryFiles.status, 200);
    assert.equal(memoryFiles.body.bot.text, '# Alpha memory\n\n- [preference] Prefers short answers.\n');
    assert.equal(memoryFiles.body.bot.path, 'memory/MEMORY.md');
    assert.match(memoryFiles.body.tidyPrompt, /snapshot budget/u);
    const saved = await request('/api/memory', 'PUT', { slug: 'alpha', scope: 'bot', text: '# Alpha memory\n\n- Prefers long answers.\n', expectedRevision: memoryFiles.body.bot.revision });
    assert.deepEqual([saved.status, saved.body.ok], [200, true]);
    assert.equal(await readFile(path.join(botsRoot, 'alpha/memory/MEMORY.md'), 'utf8'), '# Alpha memory\n\n- Prefers long answers.\n');
    const stale = await request('/api/memory', 'PUT', { slug: 'alpha', scope: 'bot', text: 'stale', expectedRevision: memoryFiles.body.bot.revision });
    assert.deepEqual([stale.status, stale.body.code, stale.body.text], [409, 'conflict', '# Alpha memory\n\n- Prefers long answers.\n']);
    assert.equal((await request('/api/memory', 'PUT', { slug: 'nobody', scope: 'bot', text: '', expectedRevision: '' })).status, 404);
    assert.match(await readFile(path.join(botsRoot, 'beta/AGENTS.md'), 'utf8'), /You are the primary Bot/);
    const pushKey = await request('/api/push/key');
    assert.equal(pushKey.status, 200);
    assert.equal(typeof pushKey.body.publicKey, 'string');
    const pushSub = await request('/api/push/subscribe', 'POST', { subscription: { endpoint: 'https://push.example/sub', keys: { p256dh: 'p256dh-value-1234567890', auth: 'auth-value-1234' } } });
    assert.equal(pushSub.status, 200);
    assert.equal(pushSub.body.ok, true);
    const watching = await request('/api/push/presence', 'POST', { endpoint: 'https://push.example/sub', bot: 'alpha' });
    assert.deepEqual([watching.status, watching.body], [200, { ok: true, watching: true }]);
    const away = await request('/api/push/presence', 'POST', { endpoint: 'https://push.example/sub', bot: null });
    assert.deepEqual([away.status, away.body], [200, { ok: true, watching: false }]);
    const roomWatch = await request('/api/push/presence', 'POST', { endpoint: 'https://push.example/sub', bot: null, room: 'room-1' });
    assert.deepEqual([roomWatch.status, roomWatch.body], [200, { ok: true, watching: true }]);
    const badRoom = await request('/api/push/presence', 'POST', { endpoint: 'https://push.example/sub', bot: null, room: { id: 'room-1' } });
    assert.deepEqual([badRoom.status, typeof badRoom.body.error], [400, 'string']);
    const badBot = await request('/api/push/presence', 'POST', { endpoint: 'https://push.example/sub', bot: '../../etc' });
    assert.equal(badBot.status, 400);
    await stop();
    await start();
    assert.deepEqual(main((await request('/api/bots')).body.bots), ['beta']);
    assert.equal((await request('/api/bots/alpha', 'DELETE')).status, 200);
    const archived = (await request('/api/bot-identities')).body.bots;
    assert.equal(archived[0].name, 'alpha');
    assert.equal(archived[0].mainThreadId, 'thread-alpha');
    assert.equal(archived[0].primary, false);
    assert.equal((await request('/api/bots/beta', 'DELETE')).status, 200);
    assert.deepEqual((await request('/api/bots')).body.bots, []);
    await stop();
    processHandle = null;
  } finally {
    if (processHandle && processHandle.exitCode === null) {
      const exited = once(processHandle, 'exit');
      processHandle.kill();
      await exited;
    }
    await rm(root, { recursive: true, force: true });
  }
});
