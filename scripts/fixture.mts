#!/usr/bin/env node
// Real built frontend + real gateway, with disposable state and a separate fake T3.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import type { ChildProcess, ChildProcessByStdio } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { Interface } from 'node:readline';
import type { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MODEL, SAMPLE_IMAGE, SAMPLE_TEXT, samplesFor, STAMP, startFakeT3, type FixtureLink } from './fixture-t3.mts';
import { T3Client } from '../server/t3rpc.mts';
import { LANDING_SECTIONS, LANDING_USER, fixtureReleases, validateScenario } from './fixture-scenarios.mts';
import { startFakeExecutor } from './fixture-executor.mts';

const repo = fileURLToPath(new URL('../', import.meta.url));
const serverDir = path.join(repo, 'server');
const staticDir = path.join(repo, 'web', 'dist');
// The version the gateway reports (package.json), for the release-notes scenario's releases.
const packageVersion: string = JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8')).version;

// Node's permission model forbids fsync even for an allowed FileHandle. On macOS,
// enforce paths in the OS instead so the real Vault's atomic writes stay intact.
function macSandboxProfile(root: string, git: string | null = null) {
  const executable = realpathSync(process.execPath);
  const runtimeReads = [path.resolve(path.dirname(executable), '../lib')];
  for (const binary of git ? [executable, git] : [executable]) {
    const cellar = binary.match(/^(.*\/Cellar)\//)?.[1];
    if (cellar) runtimeReads.push(cellar, path.join(path.dirname(cellar), 'opt'));
  }
  // The adopt scenario's gateway runs git (and only git) on the fixture's own repo.
  if (git) runtimeReads.push(path.resolve(path.dirname(git), '..'));
  const subpaths = [root, serverDir, staticDir, '/System', '/usr/lib', ...runtimeReads];
  return `(version 1)
(allow default)
(deny file-read-data)
(deny file-write*)
${git ? '' : '(deny process-fork)\n'}(deny process-exec)
(deny network*)
(allow file-read-data (literal "/") (literal ${JSON.stringify(executable)})
  ${subpaths.map((dir) => `(subpath ${JSON.stringify(dir)})`).join(' ')}
  (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom"))
(allow file-write* (subpath ${JSON.stringify(root)}) (literal "/dev/null"))
(allow process-exec (literal ${JSON.stringify(executable)})${git ? ` (literal ${JSON.stringify(git)})` : ''})
(allow network-bind (local ip "localhost:*"))
(allow network-inbound (local ip "localhost:*"))
(allow network-outbound (remote ip "localhost:*"))`;
}

// An allowlist, never {...process.env}: ignore production URLs, tokens, NODE_OPTIONS,
// proxy settings, CF Access, executors, T3_CLI, and the user's actual HOME.
export function gatewayInvocation(root: string, port: number, t3Port: number, executorPort?: number, { git = false, releases = false }: { git?: boolean; releases?: boolean } = {}) {
  if (executorPort !== undefined && (!Number.isInteger(executorPort) || executorPort < 1 || executorPort > 65535)) throw new Error('Invalid local Executor fixture port');
  if (!process.allowedNodeEnvironmentFlags.has('--permission')) throw new Error('Use Node >= 22.13 with --permission support.');
  const osSandbox = process.platform === 'darwin';
  const gitBinary = git ? findGit() : null;
  return {
    command: osSandbox ? '/usr/bin/sandbox-exec' : process.execPath,
    isolation: osSandbox ? 'macos-sandbox' : 'node-permissions',
    args: [...(osSandbox ? ['-p', macSandboxProfile(root, gitBinary), process.execPath] :
      ['--permission', `--allow-fs-read=${serverDir}`, `--allow-fs-read=${staticDir}`,
      `--allow-fs-read=${root}`, `--allow-fs-write=${root}`,
      ...(gitBinary ? ['--allow-child-process'] : []),
      ...['--allow-net', '--allow-addons'].filter((flag) => process.allowedNodeEnvironmentFlags.has(flag))]),
      path.join(serverDir, 'gateway.mts')],
    env: {
      PATH: [path.dirname(process.execPath), ...(gitBinary ? [path.dirname(gitBinary)] : [])].join(path.delimiter),
      ...(gitBinary ? { GIT_CONFIG_NOSYSTEM: '1', XDG_CONFIG_HOME: path.join(root, 'home', '.config') } : {}),
      HOME: path.join(root, 'home'), CODEX_HOME: path.join(root, 'codex'),
      TMPDIR: path.join(root, 'tmp'), TMP: path.join(root, 'tmp'), TEMP: path.join(root, 'tmp'),
      OPENSSL_CONF: path.join(root, 'tmp', 'openssl.cnf'),
      HOST: '127.0.0.1', PORT: String(port), BOTS_ROOT: path.join(root, 'bots'), STATIC_DIR: staticDir,
      T3_URL: `http://127.0.0.1:${t3Port}`, T3_TOKEN: 'fixture-only', BOT_MCP_TOKEN: 'fixture-only', BOT_PASSWORD: '',
      ...(existsSync(path.join(root, 'environments.json')) ? { T3_ENVIRONMENTS_FILE: path.join(root, 'environments.json') } : {}),
      T3_TOKEN_FILE: path.join(root, 'unused-token'), T3_SECRETS_DIR: path.join(root, 'secrets'),
      VAULT_FILE: path.join(root, 'vault', 'vault.enc'), VAULT_KEY_FILE: path.join(root, 'vault', 'vault-key'),
      BOT_MCP_URL: `http://127.0.0.1:${port}/mcp/bot`,
      // Never send a fixture's usage-stats ping to the real collector (port 9 is discard; the send just fails).
      THREEBOT_TELEMETRY_URL: 'http://127.0.0.1:9/v1/ping',
      // Look at linked machines every second, so an outage shows within a test's time.
      THREEBOT_MACHINE_POLL_MS: '1000',
      // The release-notes scenario's fake releases, from the fake T3; otherwise GitHub's real list.
      ...(releases ? { THREEBOT_RELEASES_URL: `http://127.0.0.1:${t3Port}/fixture/releases?current=${encodeURIComponent(packageVersion)}` } : {}),
      ...(executorPort === undefined ? {} : { EXECUTOR_BACKEND: 'self-hosted', EXECUTOR_URL: `http://127.0.0.1:${executorPort}`,
        EXECUTOR_PUBLIC_URL: `http://127.0.0.1:${executorPort}`, EXECUTOR_ORG: 'fixture', EXECUTOR_TOKEN: 'fixture-only' }),
    },
  };
}

/** The real path of this machine's git, for the adopt scenario; the test process runs it too. */
function findGit() {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const candidate = path.join(dir, 'git');
    if (existsSync(candidate)) return realpathSync(candidate);
  }
  throw new Error('The adopt scenario needs git on PATH.');
}
export const ADOPT_REPO = path.join('projects', 'sample-app');
/** A disposable git repo with its own tracked CLAUDE.md, AGENTS.md and .gitignore, committed and clean. */
async function seedRepo(root: string) {
  const dir = path.join(root, ADOPT_REPO);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'CLAUDE.md'), '# Sample app\nThe repo\'s own Claude rules.\n');
  await writeFile(path.join(dir, 'AGENTS.md'), '# Sample app\nRun the sample tests before pushing.\n');
  await writeFile(path.join(dir, '.gitignore'), 'node_modules/\n');
  await writeFile(path.join(dir, 'index.js'), 'console.log("sample");\n');
  const run = (...args: string[]) => execFileSync(findGit(), ['-C', dir, ...args], { env: { PATH: process.env.PATH, HOME: path.join(root, 'home'), GIT_CONFIG_NOSYSTEM: '1', XDG_CONFIG_HOME: path.join(root, 'home', '.config') } });
  run('init', '-q');
  run('add', '-A');
  run('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Sample app');
}

async function seed(root: string, scenario = 'basic') {
  for (const dir of ['home', 'codex', 'tmp', 'secrets', 'vault', 'samples', 'bots/.botapp']) await mkdir(path.join(root, dir), { recursive: true });
  await writeFile(path.join(root, 'tmp', 'openssl.cnf'), '# Disposable fixture: use the default OpenSSL providers.\n');
  await writeFile(path.join(root, 'samples/sample-image.svg'), SAMPLE_IMAGE);
  await writeFile(path.join(root, 'samples/sample-notes.txt'), SAMPLE_TEXT);
  const landing = scenario === 'landing';
  for (const sample of samplesFor(scenario)) {
    const dir = path.join(root, 'bots', sample.slug, '.bot');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'bot.json'), JSON.stringify({ ...sample,
      label: landing ? '' : 'Disposable local sample', projectId: `project-${sample.slug}`, mainThreadId: `thread-${sample.slug}`,
      createdAt: STAMP, model: MODEL, notifications: false,
    }, null, 2) + '\n');
  }
  const settings = landing
    ? { userName: LANDING_USER, theme: 'dark', palette: 'amoled', timezone: 'UTC', defaultModel: MODEL, sections: LANDING_SECTIONS }
    : { userName: 'Sample User', theme: scenario === 'activity' ? 'system' : 'light', timezone: 'UTC', defaultModel: MODEL };
  await writeFile(path.join(root, 'bots/.botapp/settings.json'), JSON.stringify(settings) + '\n');
  if (scenario === 'adopt') await seedRepo(root);
  // The notice an automatic update leaves: the app shows "Updated to v…" once.
  if (scenario === 'release-notes') await writeFile(path.join(root, 'bots/.botapp/auto-update.json'), JSON.stringify({ auto: true, notice: { kind: 'updated', version: packageVersion,
    from: fixtureReleases(packageVersion).previous, url: `https://github.com/RokaSwK/threebot/releases/tag/v${packageVersion}`, at: new Date().toISOString() } }) + '\n');
}

async function freePort() {
  const socket = net.createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const { port } = socket.address() as AddressInfo;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

async function stopChild(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
  try { await exited; } finally { clearTimeout(timer); }
}

export async function createFixture({ port = 0, scenario = 'basic', links }: { port?: number; scenario?: string; links?: FixtureLink[] } = {}) {
  validateScenario(scenario);
  await access(path.join(staticDir, 'index.html')).catch(() => {
    throw new Error('Missing web/dist/index.html. Run npm ci --prefix web && npm run build --prefix web first.');
  });
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Port must be an integer between 0 and 65535.');
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'bot-parity-')));
  await writeFile(path.join(root, 'fixture.json'), JSON.stringify({ fixtureOnly: true, pid: process.pid, repo }) + '\n');
  let fake: Awaited<ReturnType<typeof startFakeT3>> | undefined;
  let executor: Awaited<ReturnType<typeof startFakeExecutor>> | undefined;
  let child: ChildProcessByStdio<null, Readable, Readable> | undefined;
  let closed = false;
  let logs = '';
  const gatewayPort = port || await freePort();
  const fixture = {
    root, scenario, url: `http://127.0.0.1:${gatewayPort}`,
    isolation: process.platform === 'darwin' ? 'macos-sandbox' : 'node-permissions',
    get gatewayPid() { return child?.pid; },
    get t3Port() { return fake?.port; },
    get executorUrl() { return executor?.origin ?? null; },
    get logs() { return logs; },
    async request(route: string, method = 'GET', body?: unknown) {
      const response = await fetch(fixture.url + route, { method, signal: AbortSignal.timeout(5000),
        headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    },
    async restart() {
      if (closed) throw new Error('Fixture already closed');
      await stopChild(child);
      const invocation = gatewayInvocation(root, gatewayPort, fake!.port, executor?.port, { git: scenario === 'adopt', releases: scenario === 'release-notes' });
      child = spawn(invocation.command, invocation.args, { env: invocation.env, cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
      logs = '';
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => finish(new Error(`Gateway startup timed out.\n${logs}`)), 30000);
        const finish = (error?: Error) => {
          clearTimeout(timer);
          child!.off('error', onError);
          child!.off('exit', onExit);
          error ? reject(error) : resolve();
        };
        const onError = (error: Error) => finish(error);
        const onExit = (code: number | null, signal: NodeJS.Signals | null) => finish(new Error(`Gateway exited (${code ?? signal}).\n${logs}`));
        child!.once('error', onError);
        child!.once('exit', onExit);
        child!.stderr.on('data', (data: Buffer) => { logs = (logs + data).slice(-30000); });
        child!.stdout.on('data', (data: Buffer) => {
          logs = (logs + data).slice(-30000);
          if (logs.includes('bot gateway on')) finish();
        });
      });
    },
    async reset() {
      if (closed) throw new Error('Fixture already closed');
      await stopChild(child);
      const t3Port = fake!.port;
      await fake!.close();
      for (const dir of ['home', 'codex', 'tmp', 'secrets', 'vault', 'samples', 'bots', 'projects']) await rm(path.join(root, dir), { recursive: true, force: true });
      await seed(root, scenario);
      executor?.reset();
      fake = await startFakeT3(root, t3Port, { scenario, executor: executor?.links, links });
      await fixture.restart();
    },
    async close() {
      if (closed) return;
      closed = true;
      await stopChild(child);
      await fake?.close();
      await executor?.close();
      await rm(root, { recursive: true, force: true });
    },
  };
  try {
    await seed(root, scenario);
    if (scenario === 'executor') executor = await startFakeExecutor();
    fake = await startFakeT3(root, 0, { scenario, executor: executor?.links, links });
    await fixture.restart();
    return fixture;
  } catch (error) { await fixture.close(); throw error; }
}

type Fixture = Awaited<ReturnType<typeof createFixture>>;

// API smoke evidence only. Confirm/Cancel gestures and mobile layout require root's UI check.
export async function smokeFixture(fixture: Fixture) {
  const main = async () => (await fixture.request('/api/bots')).body.bots.filter((bot: { primary: boolean }) => bot.primary).map((bot: { slug: string }) => bot.slug);
  const page = await fetch(fixture.url);
  assert.equal(page.status, 200);
  assert.equal(await page.text(), await readFile(path.join(staticDir, 'index.html'), 'utf8'));
  assert.equal((await fixture.request('/api/session')).body.authenticated, true);
  assert.deepEqual(await main(), ['alpha']);
  // Read-only candidate browsing must leave the real persisted selection untouched.
  await fixture.request('/api/bots/beta');
  assert.deepEqual(await main(), ['alpha']);
  assert.equal((await fixture.request('/api/main-bot', 'PUT', { slug: 'beta' })).status, 200);
  assert.deepEqual(await main(), ['beta']);
  assert.equal((await fixture.request('/api/main-bot', 'PUT', { slug: 'missing' })).status, 404);
  assert.equal((await fixture.request('/api/bots/beta', 'PUT', { hidden: true })).status, 409);
  const patch = { userName: 'Edited Sample', theme: 'dark', timezone: 'Europe/Madrid', autoReview: false,
    rules: { alwaysAsk: ['Ask before deleting sample files'], allowWithoutAsking: ['Read sample files'] }, defaultModel: MODEL };
  assert.equal((await fixture.request('/api/settings', 'PUT', patch)).status, 200);
  const selectionFile = path.join(fixture.root, 'bots/.botapp/main-bot.json');
  assert.deepEqual(JSON.parse(await readFile(selectionFile, 'utf8')), { slug: 'beta' });
  await fixture.restart();
  assert.deepEqual(await main(), ['beta']);
  const settings = (await fixture.request('/api/settings')).body;
  for (const [key, value] of Object.entries(patch)) assert.deepEqual(settings[key], value);
  assert.match(await readFile(path.join(fixture.root, 'bots/beta/AGENTS.md'), 'utf8'), /Edited Sample/);
  assert.doesNotMatch(await readFile(path.join(fixture.root, 'bots/alpha/AGENTS.md'), 'utf8'), /You are the primary Bot/);
  assert.equal((await fixture.request('/t3/api/projects')).body.projects.length, 3);
  assert.equal((await fixture.request('/t3/.well-known/t3/environment')).body.label, 'Disposable local fixture (fake T3)');
  assert.equal((await fetch(fixture.url + '/t3/fixture/attachments/sample-image')).headers.get('content-type'), 'image/svg+xml');
  assert.equal((await fixture.request('/t3/api/not-supported')).status, 501);
  if (fixture.scenario === 'executor') {
    const connected = await fixture.request('/api/executor');
    assert.equal(connected.status, 200);
    assert.equal(connected.body.backend, 'self-hosted');
    assert.deepEqual(connected.body.connections.map(({ name, status }: { name: string; status: string }) => ({ name, status })), [
      { name: 'Generic Service', status: 'needs-connection' }, { name: 'Generic Single', status: 'needs-connection' }, { name: 'Generic Ready', status: 'ready' },
    ]);
  }
  const rpc = new T3Client({ baseUrl: fixture.url + '/t3', token: 'fixture-only' });
  const bounded = <T,>(promise: Promise<T>) => new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Fixture RPC smoke timed out')), 5000);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
  try {
    await bounded(rpc.connect());
    assert.equal((await bounded(rpc.call('server.getConfig'))).providers[0].models[0].slug, MODEL.model);
    const firstChunk = async (tag: string, payload: unknown) => {
      let handle: ReturnType<typeof rpc.stream> | undefined;
      try {
        // A stream chunk is an untyped RPC frame.
        return await bounded(new Promise<any>((resolve) => { handle = rpc.stream(tag, payload, resolve); }));
      } finally { handle?.cancel(); }
    };
    const shell = await firstChunk('orchestration.subscribeShell', {});
    assert.equal(shell.snapshot.threads.length, 4);
    const projection = (await firstChunk('orchestration.subscribeThread', { threadId: 'thread-alpha' })).projection;
    assert.equal(projection.turnItems[0].attachments.length, 2);
    assert.match(projection.turnItems[1].text, /long-generic-path-segment/);
    assert.equal(projection.turnItems[2].childThreadId, 'thread-alpha-child');
    assert.equal((await bounded(rpc.call('orchestration.getThreadFamily', { threadId: 'thread-alpha-child' }))).threads.length, 2);
    const upload = await bounded(rpc.call('attachments.createUploadUrl', { type: 'file', name: 'smoke.txt', mimeType: 'text/plain', sizeBytes: 13 }));
    assert.equal((await fetch(fixture.url + '/t3' + upload.relativeUrl, { method: 'POST', body: 'fixture smoke' })).status, 200);
    const asset = await bounded(rpc.call('assets.createUrl', { resource: { _tag: 'attachment', attachmentId: upload.attachmentId } }));
    assert.equal(await (await fetch(fixture.url + '/t3' + asset.relativeUrl)).text(), 'fixture smoke');
    await assert.rejects(bounded(rpc.dispatch({ type: 'message.dispatch', threadId: 'thread-alpha', text: 'Generic smoke' })), /Unavailable in local fixture/);
  } finally { rpc.close(); }
  assert.doesNotMatch(fixture.logs, /ERR_ACCESS_DENIED|\[provisioner\]|refreshing .* failed/);
  await fixture.reset();
  assert.deepEqual(await main(), ['alpha']);
  assert.equal((await fixture.request('/api/settings')).body.userName, 'Sample User');
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('Usage: node scripts/fixture.mts [--port PORT] [--scenario basic|interactions|executor|library|latest-t3|avatars|activity|adopt|release-notes] [--check]\nInteractive: restart, reset, quit. Ctrl-C cleans up. --check runs API smoke checks and removes the fixture.');
    return;
  }
  let port = 0;
  let check = false;
  let scenario = 'basic';
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--check') check = true;
    else if (args[index] === '--port') port = Number(args[++index]);
    else if (args[index] === '--scenario') scenario = args[++index];
    else throw new Error(`Unknown argument: ${args[index]}`);
  }
  const fixture = await createFixture({ port, scenario });
  let queue = Promise.resolve();
  let quitting = false;
  const quit = async () => {
    if (quitting) return;
    quitting = true;
    await queue.catch(() => {});
    await fixture.close();
    console.log('Fixture stopped; its temporary directory was removed.');
    input?.close();
    process.stdin.pause();
  };
  let input: Interface | undefined;
  process.once('SIGINT', () => void quit().catch(fatal));
  process.once('SIGTERM', () => void quit().catch(fatal));
  console.log(`Local URL: ${fixture.url}\nFixture directory: ${fixture.root}\nReal gateway PID: ${fixture.gatewayPid}\nFake T3: http://127.0.0.1:${fixture.t3Port}`);
  console.log(`Isolation: ${fixture.isolation}${fixture.isolation === 'node-permissions' ? ' (Vault writes unavailable: Node forbids fsync)' : ' (real durable Vault writes supported)'}`);
  console.log('Generic disposable data only. No real T3, inference, or device integration.');
  if (scenario === 'interactions') console.log('Scenario: interactions. Synthetic paired messages and runtime responses only; no live delivery or credential storage.');
  if (scenario === 'executor') console.log(`Scenario: executor. Fake Executor: ${fixture.executorUrl}. Synthetic account links only; not Cloud OAuth or MCP authentication.`);
  if (check) {
    try { await smokeFixture(fixture); console.log('PASS: built HTML, real gateway selection/settings persistence, restart, reset, local proxy.'); }
    finally { await quit(); }
    return;
  }
  console.log('Commands: restart (preserve data), reset (restore samples), quit (remove data).');
  input = createInterface({ input: process.stdin });
  input.on('line', (line) => {
    const command = line.trim();
    if (quitting) return;
    if (['quit', 'q'].includes(command)) return void quit().catch(fatal);
    queue = queue.then(async () => {
      if (command === 'restart') await fixture.restart();
      else if (command === 'reset') await fixture.reset();
      else { console.log('Commands: restart, reset, quit'); return; }
      console.log(`Ready: ${fixture.url} (gateway PID ${fixture.gatewayPid})`);
    }).catch((error) => { console.error(error); });
  });
}

function fatal(error: unknown) { console.error(error); process.exitCode = 1; }
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(fatal);
