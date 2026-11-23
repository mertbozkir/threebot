import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { createMainBotRegistry, type Bot } from './main-bot.mts';
import { archivedBotIdentities } from './bot-identities.mts';
import { renderAgentsMd } from './bot-template.mts';

async function fixture(t: TestContext, entries: Record<string, Record<string, unknown>>) {
  const botsRoot = await mkdtemp(path.join(tmpdir(), 'main-bot-'));
  t.after(() => rm(botsRoot, { recursive: true, force: true }));
  const file = (slug: string) => path.join(botsRoot, slug, '.bot', 'bot.json');
  for (const [slug, meta] of Object.entries(entries)) {
    await mkdir(path.dirname(file(slug)), { recursive: true });
    await writeFile(file(slug), JSON.stringify({ name: slug, createdAt: '2026-01-01T00:00:00Z', ...meta }));
  }
  const instructions = new Map<string, string>();
  const registry = createMainBotRegistry({ botsRoot, onBotChanged: async (bot) => {
    instructions.set(bot.slug, renderAgentsMd({ bot, settings: {}, botsRoot }));
  } });
  return { botsRoot, file, registry, instructions };
}
function assertMain(bots: Bot[], slug: string | null) {
  assert.deepEqual(bots.filter((bot) => bot.primary).map((bot) => bot.slug), slug ? [slug] : []);
  if (slug) assert.equal(bots.find((bot) => bot.slug === slug)!.hidden, false);
}

test('legacy duplicates migrate once to a deterministic visible main; selection survives restart and stale self-written flags', async (t) => {
  const { registry, botsRoot, file, instructions } = await fixture(t, { alpha: { primary: true }, beta: { primary: true }, gamma: { primary: true, hidden: true } });
  assertMain(await registry.list(), 'alpha');
  assertMain(await registry.select('beta'), 'beta');
  assert.match(instructions.get('beta')!, /You are the primary Bot/);
  assert.doesNotMatch(instructions.get('alpha')!, /You are the primary Bot/);
  const alpha = JSON.parse(await readFile(file('alpha'), 'utf8'));
  await writeFile(file('alpha'), JSON.stringify({ ...alpha, primary: true }));
  const restarted = createMainBotRegistry({ botsRoot });
  assertMain(await restarted.list(), 'beta');
  assert.equal((await restarted.get('alpha'))!.primary, false);
  assert.equal(JSON.parse(await readFile(file('alpha'), 'utf8')).primary, false);
  assert.deepEqual(JSON.parse(await readFile(path.join(botsRoot, '.botapp/main-bot.json'), 'utf8')), { slug: 'beta' });
});

test('first creation supplies a main automatically; explicit creation replaces it and provisioning saves preserve that choice', async (t) => {
  const { registry } = await fixture(t, {});
  assert.equal((await registry.save('alpha', { name: 'Alpha', mainThreadId: 'thread-a' }, { create: true })).primary, true);
  assert.equal((await registry.save('beta', { name: 'Beta', primary: true }, { create: true })).primary, true);
  await registry.save('alpha', { projectId: 'project-a', mainThreadId: 'thread-a' });
  await registry.save('beta', { projectId: 'project-b', mainThreadId: 'thread-b', model: null });
  assertMain(await registry.list(), 'beta');
  assert.equal((await registry.get('alpha'))!.mainThreadId, 'thread-a');
});

test('concurrent selection and provisioning updates leave one main and retain unrelated identity metadata', async (t) => {
  const { registry, file } = await fixture(t, { alpha: { primary: true, shape: 'clover' }, beta: { label: 'Research', color: 'purple' } });
  await Promise.all([registry.select('beta'), registry.save('beta', { mainThreadId: 'thread-b' }), registry.select('alpha'), registry.save('alpha', { label: 'Planning' })]);
  assertMain(await registry.list(), 'alpha');
  assert.equal((await registry.get('beta'))!.mainThreadId, 'thread-b');
  assert.equal((await registry.get('beta'))!.color, 'purple');
  assert.equal((await registry.get('alpha'))!.shape, 'clover');
  assert.equal(JSON.parse(await readFile(file('beta'), 'utf8')).primary, false);
});

test('hiding or deleting a main with other Bots requires explicit replacement; hidden alternatives can be selected', async (t) => {
  const { registry, botsRoot } = await fixture(t, { alpha: { primary: true }, beta: { hidden: true } });
  await assert.rejects(registry.save('alpha', { hidden: true }), { status: 409 });
  await assert.rejects(registry.save('alpha', { primary: false }), { status: 409 });
  await assert.rejects(registry.remove('alpha'), { status: 409 });
  assertMain(await registry.list(), 'alpha');
  assertMain(await registry.select('beta'), 'beta');
  await registry.save('alpha', { hidden: true });
  assert.equal((await registry.get('alpha'))!.hidden, true);
  await registry.remove('alpha');
  assertMain(await registry.list(), 'beta');
  await registry.remove('beta');
  assertMain(await registry.list(), null);
  assert.deepEqual(JSON.parse(await readFile(path.join(botsRoot, '.botapp/main-bot.json'), 'utf8')), { slug: null });
});

test('deletion preserves exact archived identities, and reusing a slug does not revive a primary flag', async (t) => {
  const { registry, botsRoot } = await fixture(t, { alpha: { primary: true, mainThreadId: 'old-thread', shape: 'flower', color: 'pink' } });
  await registry.remove('alpha');
  const historical = await archivedBotIdentities(path.join(botsRoot, '.botapp/trash'));
  assert.equal(historical.length, 1);
  assert.equal(historical[0].mainThreadId, 'old-thread');
  assert.equal(historical[0].shape, 'flower');
  assert.equal(historical[0].primary, false);
  await registry.save('beta', { name: 'Beta' }, { create: true });
  await registry.save('alpha', { name: 'New Alpha', mainThreadId: 'new-thread' }, { create: true });
  assertMain(await registry.list(), 'beta');
});

test('a missing selection target fails without changing the selection; malformed slugs and unknown update targets never create Bots', async (t) => {
  const { registry } = await fixture(t, { alpha: { primary: true } });
  await assert.rejects(registry.select('missing'), { status: 404 });
  await assert.rejects(registry.select('../outside'), { status: 400 });
  await assert.rejects(registry.save('missing', { primary: true }), { status: 404 });
  await assert.rejects(registry.save('alpha', { primary: 'yes' }), { status: 400 });
  assertMain(await registry.list(), 'alpha');
});

test('external removal repairs the authority and interrupted mirror updates cannot create multiple main flags', async (t) => {
  const { registry, botsRoot, file } = await fixture(t, { alpha: { primary: true }, beta: {} });
  await registry.list();
  await writeFile(path.join(botsRoot, '.botapp/main-bot.json'), JSON.stringify({ slug: 'beta' }));
  assertMain(await registry.list(), 'beta');
  assert.equal(JSON.parse(await readFile(file('alpha'), 'utf8')).primary, false);
  await rm(path.join(botsRoot, 'beta'), { recursive: true });
  assertMain(await registry.list(), 'alpha');
});

test('a self-written hidden flag cannot silently replace the persisted main', async (t) => {
  const { registry, file } = await fixture(t, { alpha: { primary: true }, beta: {} });
  await registry.list();
  const alpha = JSON.parse(await readFile(file('alpha'), 'utf8'));
  await writeFile(file('alpha'), JSON.stringify({ ...alpha, hidden: true }));
  assertMain(await registry.list(), 'alpha');
  assert.equal(JSON.parse(await readFile(file('alpha'), 'utf8')).hidden, false);
});

test('settings instruction refresh and replacement share the writer, so old prompts cannot overwrite the new main', async (t) => {
  const { registry, instructions } = await fixture(t, { alpha: { primary: true }, beta: {} });
  await Promise.all([registry.refreshInstructions(), registry.select('beta'), registry.refreshInstructions()]);
  assert.doesNotMatch(instructions.get('alpha')!, /You are the primary Bot/);
  assert.match(instructions.get('beta')!, /You are the primary Bot/);
});

test('cached roster follows external metadata, additions, removals, trash and restore', async (t) => {
  const { registry, botsRoot, file } = await fixture(t, { alpha: { primary: true }, beta: { mainThreadId: 'thread-b' } });
  const first = await registry.list();
  assert.deepEqual(await registry.list(), first);
  const beta = JSON.parse(await readFile(file('beta'), 'utf8'));
  await writeFile(file('beta'), JSON.stringify({ ...beta, name: 'Changed' }));
  assert.equal((await registry.get('beta'))?.name, 'Changed');
  await mkdir(path.dirname(file('gamma')), { recursive: true });
  await writeFile(file('gamma'), JSON.stringify({ name: 'Gamma', createdAt: '2026-01-01' }));
  assert.equal((await registry.list()).length, 3);
  await rm(path.join(botsRoot, 'gamma'), { recursive: true });
  assert.equal((await registry.list()).length, 2);
  const trash = path.join(botsRoot, '.botapp/trash');
  assert.deepEqual(await archivedBotIdentities(trash), []);
  await registry.remove('beta');
  const archived = await archivedBotIdentities(trash);
  assert.equal(archived[0].name, 'Changed');
  assert.deepEqual(await archivedBotIdentities(trash), archived);
  await writeFile(path.join(archived[0].workspaceRoot, '.bot/bot.json'), JSON.stringify({ ...beta, name: 'Archived edit' }));
  assert.equal((await archivedBotIdentities(trash))[0].name, 'Archived edit');
  await rename(archived[0].workspaceRoot, path.join(botsRoot, 'beta'));
  assert.deepEqual(await archivedBotIdentities(trash), []);
  assert.equal((await registry.get('beta'))?.name, 'Archived edit');
});

test('cached metadata does not expose mutable nested state and external primary flags are repaired', async (t) => {
  const { registry, file } = await fixture(t, { alpha: { primary: true, extra: { value: 1 } }, beta: {} });
  const first = await registry.list();
  (first[0].extra as { value: number }).value = 99;
  assert.equal(((await registry.get('alpha'))!.extra as { value: number }).value, 1);
  const beta = JSON.parse(await readFile(file('beta'), 'utf8'));
  await writeFile(file('beta'), JSON.stringify({ ...beta, primary: true }));
  assertMain(await registry.list(), 'alpha');
  assert.equal(JSON.parse(await readFile(file('beta'), 'utf8')).primary, false);
});

test('Bot Creator can move to another Bot, be removed, and cannot also be Main Bot', async (t) => {
  const { registry, file } = await fixture(t, { alpha: { primary: true }, beta: {}, gamma: {} });
  assert.equal((await registry.get('beta'))?.creator, false);
  await assert.rejects(registry.save('alpha', { creator: true }), { status: 409 });
  await assert.rejects(registry.save('beta', { creator: 'yes' }), { status: 400 });
  await Promise.all([registry.save('beta', { creator: true }), registry.save('gamma', { creator: true })]);
  assert.deepEqual((await registry.list()).filter((bot) => bot.creator).map((bot) => bot.slug), ['gamma']);
  assert.equal(JSON.parse(await readFile(file('beta'), 'utf8')).creator, false);
  assert.equal((await registry.save('gamma', { creator: false })).creator, false);
  await registry.save('beta', { creator: true });
  const promoted = (await registry.select('beta')).find((bot) => bot.slug === 'beta');
  assert.equal(promoted?.primary, true);
  assert.equal(promoted?.creator, false);
});

test('loading duplicate Creator flags keeps the latest visible non-main Bot and clears the other flags on disk', async (t) => {
  const { registry, file } = await fixture(t, {
    alpha: { primary: true, creator: true },
    beta: { creator: true },
    gamma: { creator: true, updatedAt: '2026-02-01T00:00:00Z' },
    delta: { creator: true, hidden: true, updatedAt: '2026-03-01T00:00:00Z' },
  });
  assert.deepEqual((await registry.list()).filter((bot) => bot.creator).map((bot) => bot.slug), ['gamma']);
  for (const slug of ['alpha', 'beta', 'delta']) {
    assert.equal(JSON.parse(await readFile(file(slug), 'utf8')).creator, false);
  }
});

test('hiding, archiving or deleting the Bot Creator clears its role', async (t) => {
  const { botsRoot, file } = await fixture(t, {
    alpha: { primary: true },
    beta: { creator: true, projectId: 'project-b', mainThreadId: 'thread-b' },
  });
  const archived = new Set<string>();
  const registry = createMainBotRegistry({ botsRoot, archivedProjects: async () => archived });
  assert.equal((await registry.save('beta', { hidden: true })).creator, false);
  await registry.save('beta', { hidden: false, creator: true });
  archived.add('project-b');
  assert.equal((await registry.get('beta'))?.creator, false);
  assert.equal(JSON.parse(await readFile(file('beta'), 'utf8')).creator, false);
  archived.clear();
  await registry.save('beta', { creator: true });
  assert.equal((await registry.remove('beta')).some((bot) => bot.creator), false);
  const [historical] = await archivedBotIdentities(path.join(botsRoot, '.botapp/trash'));
  assert.equal(historical.creator, false);
  assert.equal((await registry.save('beta', { name: 'New Beta' }, { create: true })).creator, false);
});
