import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildOnce, entryChunk } from './support.mts';
const src = new URL('../src/lib/', import.meta.url).pathname;
const bundle = await buildOnce({ configFile: false, logLevel: 'silent', build: { ssr: true, write: false, rollupOptions: { input: 'virtual:usage-helpers' } }, plugins: [{ name: 'usage-helpers', resolveId: (id) => id === 'virtual:usage-helpers' ? '\0usage-helpers' : undefined, load: (id) => id === '\0usage-helpers' ? `export * from ${JSON.stringify(src + 'usageApi.ts')};` : undefined }] });
const { groupUsage, limitGroups, totalIn, formatTokens, parseProviderUsage } = await import(`data:text/javascript;base64,${Buffer.from(entryChunk(bundle).code).toString('base64')}`);

const row = (over = {}) => ({ day: '2026-11-16', bot: 'oso', source: 'you', model: 'claude-opus-5-5', input: 0, cached: 0, cacheWrite: 0, output: 0, turns: 1, ...over });

test('totalIn counts cache reads and writes with the uncached input', () => {
  assert.equal(totalIn({ input: 10, cached: 20, cacheWrite: 30 }), 60);
  assert.equal(totalIn(row({ input: 5 })), 5);
});

test('token formatter shows 1.2M, 340k and 980', () => {
  assert.equal(formatTokens(1_200_000), '1.2M');
  assert.equal(formatTokens(12_400_000), '12M');
  assert.equal(formatTokens(1_360_000_000), '1.4B');
  assert.equal(formatTokens(340_000), '340k');
  assert.equal(formatTokens(3_400), '3.4k');
  assert.equal(formatTokens(980), '980');
  assert.equal(formatTokens(0), '0');
});

test('groupUsage folds the smallest series into Other and aligns per-day arrays to days', () => {
  const days = ['2026-11-14', '2026-11-15', '2026-11-16'];
  const rows = [
    row({ bot: 'oso', day: '2026-11-14', input: 100, output: 10 }),
    row({ bot: 'oso', day: '2026-11-16', input: 200, output: 20, cached: 50 }),
    row({ bot: 'net', day: '2026-11-15', input: 60, output: 6 }),
    row({ bot: 'chief', day: '2026-11-16', input: 30, output: 3 }),
    row({ bot: 'ghost', day: '2026-11-16', input: 5, output: 1 }),
    row({ bot: 'ops', day: '2026-11-16', input: 2 }),
  ];
  const series = groupUsage(rows, 'bot', { oso: 'Open Source Officer', net: 'Network Officer' }, days);
  assert.deepEqual(series.map((s) => s.name), ['Open Source Officer', 'Network Officer', 'chief', 'ghost', 'Other']);
  assert.deepEqual(series[0].inp, [100, 0, 200]);
  assert.deepEqual(series[0].out, [10, 0, 20]);
  assert.deepEqual(series[1].inp, [0, 60, 0]);
  assert.deepEqual(series[1].out, [0, 6, 0]);
  assert.equal(series[0].totalIn, 300);
  assert.equal(series[0].totalOut, 30);
  // ops, the smallest, folds into Other with its totals kept.
  assert.equal(series[4].name, 'Other');
  assert.equal(series[4].totalIn, 2);
  assert.equal(series[4].totalOut, 0);
  assert.deepEqual(series[4].inp, [0, 0, 2]);
});

test('groupUsage keeps at most four named series and orders colors by size', () => {
  const rows = ['a', 'b', 'c', 'd', 'e', 'f'].map((bot, i) => row({ bot, input: (6 - i) * 100 }));
  const series = groupUsage(rows, 'bot');
  assert.deepEqual(series.map((s) => s.key), ['a', 'b', 'c', 'd', 'other']);
  assert.equal(series[4].totalIn, 300);
  assert.deepEqual(groupUsage([], 'bot'), []);
  // Source grouping uses its display names.
  const sources = groupUsage([row({ source: 'routine', input: 7 }), row({ source: 'bot', input: 3 })], 'source', { you: 'You', routine: 'Routines', bot: 'Other Bots' });
  assert.deepEqual(sources.map((s) => s.name), ['Routines', 'Other Bots']);
});

test('limitGroups cards session and weekly windows together and the rest per provider', () => {
  const providers = parseProviderUsage({ providers: [
    { instanceId: 'codex', driver: 'codex', displayName: 'Codex', usageLimits: { windows: [
      { id: '5h', label: 'Session', usedPercent: 18, resetsAt: '2026-11-16T18:00:00Z' },
      { id: 'weekly', label: 'Weekly', usedPercent: 84 },
      { id: 'daily', label: 'Daily', usedPercent: 40 },
    ] } },
    { instanceId: 'ngc', driver: 'claudeAgent', displayName: 'Claude (ngc)', usageLimits: { windows: [
      { id: 'hourly', label: 'Rolling hour', usedPercent: 21 },
      { id: 'week', label: 'This week', usedPercent: 44 },
    ] } },
  ] });
  const cards = limitGroups(providers);
  assert.deepEqual(cards.map((card) => card.title), ['Session limits', 'Weekly limits', 'Codex limits']);
  assert.deepEqual(cards[0].rows, [{ provider: 'Codex', kind: 'codex', percent: 18, resetsAt: '2026-11-16T18:00:00Z' }, { provider: 'Claude (ngc)', kind: 'claudeAgent', percent: 21, resetsAt: null }]);
  assert.deepEqual(cards[1].rows.map((r) => r.provider), ['Codex', 'Claude (ngc)']);
  assert.deepEqual(cards[2].rows, [{ provider: 'Codex', kind: 'codex', percent: 40, resetsAt: null }]);
  const named = limitGroups(parseProviderUsage({ providers: [{ instanceId: 'ngc', driver: 'claudeAgent', displayName: 'NGC', usageLimits: { windows: [
    { id: 'w', label: 'Weekly', usedPercent: 50 }, { id: 'wf', label: 'Weekly · Fable', usedPercent: 3 }, { id: 'g', label: 'Go · Session', usedPercent: 1 }, { id: 'h', label: '5-hour', usedPercent: 2 },
  ] } }] }));
  assert.deepEqual(named.find((c) => c.title === 'Weekly limits')?.rows.map((r) => r.provider), ['NGC', 'NGC · Fable']);
  assert.deepEqual(named.find((c) => c.title === 'Session limits')?.rows.map((r) => r.provider), ['NGC · Go', 'NGC']);
  assert.deepEqual(limitGroups([]), []);
});
