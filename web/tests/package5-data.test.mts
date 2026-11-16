import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildOnce, entryChunk } from './support.mts';
const src = new URL('../src/lib/', import.meta.url).pathname;
const bundle = await buildOnce({ configFile: false, logLevel: 'silent', build: { ssr: true, write: false, rollupOptions: { input: 'virtual:package5' } }, plugins: [{ name: 'package5-data', resolveId: (id) => id === 'virtual:package5' ? '\0package5' : undefined, load: (id) => id === '\0package5' ? `export * from ${JSON.stringify(src + 'usageApi.ts')}; export * from ${JSON.stringify(src + 'skillsApi.ts')}; export * from ${JSON.stringify(src + 'librarySearch.ts')}; export * as transport from ${JSON.stringify(src + 't3.ts')};` : undefined }] });
const entry = entryChunk(bundle);
const { parseProviderUsage, peakUsage, resetsIn, parseUsageSummary, usageRange, parseSkills, parseFileSearch, isLibraryPage, searchLibrary, transport } = await import(`data:text/javascript;base64,${Buffer.from(entry.code).toString('base64')}`);

test('quota windows preserve actual provider percent, reset and availability without inventing entitlements', () => {
  const rows = parseProviderUsage({ providers: [{ instanceId: 'codex', driver: 'codex', displayName: 'Codex', usageLimits: { checkedAt: '2026-10-31T00:00:00Z', windows: [{ id: 'weekly', label: 'Weekly', usedPercent: 53, resetsAt: '2026-11-04T00:00:00Z' }, { id: 'bad', label: 'Future', usedPercent: 900 }], resetCredits: { availableCount: 1 }, externalUsage: { url: 'javascript:unsafe' } } }, { instanceId: 'other', displayName: 'Other', usageLimits: { unavailable: { reason: 'unsupported' }, windows: [] } }] });
  assert.deepEqual(rows[0], { id: 'codex', name: 'Codex', kind: 'codex', windows: [{ id: 'weekly', label: 'Weekly', percent: 53, resetsAt: '2026-11-04T00:00:00Z' }], checkedAt: '2026-10-31T00:00:00Z', unavailable: false, resetCredits: 1, externalUrl: null });
  assert.equal(rows[1].unavailable, true); assert.deepEqual(rows[1].windows, []);
  assert.throws(() => parseProviderUsage({}));
});

test('cost totals count cache categories once and exclude reasoning already included in output', () => {
  const totals = { uncachedInputTokens: 10, cachedInputTokens: 20, cacheCreationTokens: 30, outputTokens: 40, reasoningTokens: 35 };
  assert.deepEqual(parseUsageSummary({ contractVersion: 6, buckets: [{ provider: 'codex', totals, costUsd: 1.25, unpricedRecords: 1 }, { provider: 'codex', totals, costUsd: 0.5, unpricedRecords: 0 }, { type: 'future' }] }), [{ provider: 'codex', tokens: 200, cost: 1.75, unpricedRecords: 1 }]);
  assert.throws(() => parseUsageSummary({ buckets: [] }), /unsupported/);
  assert.deepEqual(usageRange(new Date('2026-10-31T23:30:00Z'), 'Europe/Madrid'), { sinceDay: '2026-10-26', untilDay: '2026-11-01', timeZone: 'Europe/Madrid' });
});

test('skills select exact cwd snapshots and retain provider-qualified identity and invocation permissions', () => {
  const skill = (name, extra = {}) => ({ name, enabled: true, ...extra });
  const provider = { instanceId: 'codex', displayName: 'Codex', skills: [skill('global')], workspaceSnapshots: [{ cwd: '/lab', skills: [skill('local'), skill('agent-only', { userInvocable: false }), skill('off', { enabled: false })] }, { cwd: '/private', skills: [skill('wrong-workspace')] }] };
  assert.deepEqual(parseSkills({ providers: [provider] }, '/lab').map(({ key, invocable, enabled, cwd }) => ({ key, invocable, enabled, cwd })), [{ key: 'codex:local', invocable: true, enabled: true, cwd: '/lab' }, { key: 'codex:agent-only', invocable: false, enabled: true, cwd: '/lab' }, { key: 'codex:off', invocable: true, enabled: false, cwd: '/lab' }]);
  assert.equal(parseSkills({ providers: [provider] }, '/unknown')[0].name, 'global');
  assert.equal(parseSkills({ providers: [provider] }, null)[0].cwd, null);
});

test('backend search retains owner thread, deduplicates content hits and rejects paths escaping the workspace', () => {
  const workspace = { workspaceRoot: '/lab', threadId: 'lab-thread' };
  const result = parseFileSearch({ truncated: true, matches: [{ path: 'unloaded/report.html', lineNumber: 1, lineContent: 'needle' }, { path: 'unloaded/report.html', lineNumber: 2, lineContent: 'needle again' }, { path: '../other/secret.txt', lineNumber: 1, lineContent: 'unsafe' }, { path: '/etc/passwd' }] }, workspace, true);
  assert.equal(result.truncated, true); assert.equal(result.entries.length, 1); assert.deepEqual(result.entries[0].resource, { _tag: 'workspace-file', threadId: 'lab-thread', path: 'unloaded/report.html' }); assert.equal(isLibraryPage(result.entries[0]), true);
  assert.throws(() => parseFileSearch({ entries: [] }, workspace, false), /unsupported/);
});


test('a legacy transport refuses remote file search before sending any local RPC', { skip: 'threadClient' in transport }, async () => {
  const original = transport.t3.call;
  let calls = 0;
  transport.t3.call = async () => { calls++; return { entries: [], truncated: false }; };
  try {
    await assert.rejects(searchLibrary({ workspaceRoot: '/remote/bot', threadId: 'environment:peer:remote-thread' }, 'report', false), /environment-scoped transport/);
    assert.equal(calls, 0);
  } finally { transport.t3.call = original; }
});

test('usage hides disabled providers, reads resets the native way and finds the peak limit', () => {
  const limits = (usedPercent) => ({ windows: [{ id: 'weekly', label: 'Weekly', usedPercent, resetsAt: null }] });
  const rows = parseProviderUsage({ providers: [{ instanceId: 'a', displayName: 'A', enabled: true, usageLimits: limits(58) }, { instanceId: 'b', displayName: 'B', enabled: true, usageLimits: limits(96) }, { instanceId: 'c', displayName: 'C', enabled: false, usageLimits: limits(100) }] });
  assert.deepEqual(rows.map((row) => row.id), ['a', 'b']);
  assert.equal(peakUsage(rows), 96);
  assert.equal(peakUsage([]), null);
  const now = Date.parse('2026-10-31T00:00:00Z'), at = (minutes) => new Date(now + minutes * 60000).toISOString();
  assert.equal(resetsIn(at(5760), now), 'Resets in 4 days');
  assert.equal(resetsIn(at(540), now), 'Resets in 9 hours');
  assert.equal(resetsIn(at(45), now), 'Resets in 45 minutes');
  assert.equal(resetsIn(at(1), now), 'Resets in 1 minute');
  assert.equal(resetsIn(at(-5), now), 'Resets soon');
});
