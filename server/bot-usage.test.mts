import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { accountsFromBuckets, createUsageLedger, nextScanWatermark, providerForSourcePath, turnsFromProjection, usageDays, type UsageEntry, type UsageProjection } from "./bot-usage.mts";

const NOW = Date.parse("2026-11-16T12:00:00Z");
const tokens = { inputTokens: 10, cachedInputTokens: 2, cacheCreationTokens: 1, outputTokens: 5, models: ["model-a"] };
const projection = (over: Partial<UsageProjection> = {}): UsageProjection => ({
  thread: { id: "th1" },
  providerTurns: [{ id: "t1", runAttemptId: "a1", completedAt: "2026-11-16T10:00:00Z", turnTokenUsage: { ...tokens } }],
  messages: [{ id: "msg1", createdBy: "user" }],
  attempts: [{ id: "a1", runId: "r1" }],
  runs: [{ id: "r1", userMessageId: "msg1", modelSelection: { model: "fallback-model" } }],
  ...over,
});
const entry = (over: Partial<UsageEntry>): UsageEntry => ({ key: "th1:t1", day: "2026-11-16", bot: "scout", source: "you", model: "model-a", input: 10, cached: 2, cacheWrite: 1, output: 5, ...over });

async function ledgerHarness() {
  const dir = await mkdtemp(path.join(tmpdir(), "bot-usage-test-"));
  const file = path.join(dir, "usage", "ledger.json");
  const ledger = createUsageLedger({ file, now: () => NOW });
  return { dir, file, ledger, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("a turn run by the person, a routine or another Bot is classified so", () => {
  const [you] = turnsFromProjection(projection(), { bot: "scout", timeZone: "UTC" });
  assert.equal(you!.source, "you");
  const [routine] = turnsFromProjection(projection({ messages: [{ id: "msg1", scheduledTaskId: "task-1" }] }), { bot: "scout", timeZone: "UTC" });
  assert.equal(routine!.source, "routine");
  const [agent] = turnsFromProjection(projection({ messages: [{ id: "msg1", createdBy: "agent" }] }), { bot: "scout", timeZone: "UTC" });
  assert.equal(agent!.source, "bot");
  const [server] = turnsFromProjection(projection({ messages: [{ id: "msg1", creationSource: "server" }] }), { bot: "scout", timeZone: "UTC" });
  assert.equal(server!.source, "bot");
  // A run whose message is missing counts as the person's, not a Bot's.
  const [lost] = turnsFromProjection(projection({ runs: [] }), { bot: "scout", timeZone: "UTC" });
  assert.equal(lost!.source, "you");
});

test("the turn's reported model wins, then the run's, then unknown", () => {
  assert.equal(turnsFromProjection(projection(), { bot: "s" })[0]!.model, "model-a");
  assert.equal(turnsFromProjection(projection({ providerTurns: [{ id: "t1", runAttemptId: "a1", completedAt: "2026-11-16T10:00:00Z", turnTokenUsage: { ...tokens, models: ["m1", "m2"] } }] }), { bot: "s" })[0]!.model, "multiple");
  const noReport = turnsFromProjection(projection({ providerTurns: [{ id: "t1", runAttemptId: "a1", completedAt: "2026-11-16T10:00:00Z", turnTokenUsage: { inputTokens: 1, outputTokens: 1 } }] }), { bot: "s" });
  assert.equal(noReport[0]!.model, "fallback-model");
  const noRun = turnsFromProjection(projection({ attempts: [], runs: [], providerTurns: [{ id: "t1", runAttemptId: "a9", completedAt: "2026-11-16T10:00:00Z", turnTokenUsage: { inputTokens: 1, outputTokens: 1 } }] }), { bot: "s" });
  assert.equal(noRun[0]!.model, "unknown");
  // A junk model name is dropped and the run's model is used instead.
  const junk = turnsFromProjection(projection({ providerTurns: [{ id: "t1", runAttemptId: "a1", completedAt: "2026-11-16T10:00:00Z", turnTokenUsage: { ...tokens, models: ["not a model!"] } }] }), { bot: "s" });
  assert.equal(junk[0]!.model, "fallback-model");
});

test("subagent usage rides on the turn's counts, junk ignored", () => {
  const withOther = turnsFromProjection(projection({ providerTurns: [{ id: "t1", runAttemptId: "a1", completedAt: "2026-11-16T10:00:00Z", turnTokenUsage: { ...tokens, otherUsage: { inputTokens: 7, outputTokens: 3 } } }] }), { bot: "s" })[0]!;
  // inputTokens 10 include 2 cached and 1 cache write, so 7 are uncached; the subagent adds 7.
  assert.deepEqual([withOther.input, withOther.output], [14, 8]);
  assert.deepEqual([withOther.cached, withOther.cacheWrite], [2, 1]);
  const badOther = turnsFromProjection(projection({ providerTurns: [{ id: "t1", runAttemptId: "a1", completedAt: "2026-11-16T10:00:00Z", turnTokenUsage: { ...tokens, otherUsage: { inputTokens: -4, outputTokens: "3" } } }] }), { bot: "s" })[0]!;
  assert.deepEqual([badOther.input, badOther.output], [7, 5]);
});

test("malformed turns and counts are ignored, not guessed", () => {
  const entries = turnsFromProjection(projection({
    providerTurns: [
      { id: "ok", runAttemptId: "a1", completedAt: "2026-11-16T10:00:00Z", turnTokenUsage: { inputTokens: -5, outputTokens: "12", cachedInputTokens: 1.5, cacheCreationTokens: Number.NaN, models: ["model-a"] } },
      { id: "skipped-status", runAttemptId: "a1", completedAt: "2026-11-16T10:01:00Z", turnTokenUsage: { usageStatus: "unavailable", inputTokens: 99, models: ["model-a"] } },
      { id: "skipped-local", runAttemptId: "a1", completedAt: "2026-11-16T10:02:00Z", turnTokenUsage: { localCommand: true, inputTokens: 99, models: ["model-a"] } },
      { id: "skipped-date", runAttemptId: "a1", completedAt: "not a date", turnTokenUsage: { inputTokens: 99, models: ["model-a"] } },
      { id: "no-usage", runAttemptId: "a1", completedAt: "2026-11-16T10:03:00Z" },
    ],
  }), { bot: "scout", timeZone: "UTC" });
  assert.equal(entries.length, 1);
  assert.deepEqual([entries[0]!.input, entries[0]!.cached, entries[0]!.cacheWrite, entries[0]!.output], [0, 0, 0, 0]);
  assert.equal(entries[0]!.key, "th1:ok");
  assert.deepEqual(turnsFromProjection(projection({ thread: undefined }), { bot: "s" }), []);
  assert.deepEqual(turnsFromProjection(projection({ providerTurns: null }), { bot: "s" }), []);
  assert.deepEqual(turnsFromProjection(null, { bot: "s" }), []);
});

test("a turn is bucketed on the day it finished, in the reader's zone", () => {
  const p = projection({ providerTurns: [{ id: "t1", runAttemptId: "a1", completedAt: "2026-11-16T23:30:00Z", turnTokenUsage: { ...tokens } }] });
  assert.equal(turnsFromProjection(p, { bot: "s", timeZone: "Europe/Istanbul" })[0]!.day, "2026-11-17");
  assert.equal(turnsFromProjection(p, { bot: "s", timeZone: "UTC" })[0]!.day, "2026-11-16");
  // An unusable zone falls back to UTC rather than throwing.
  assert.equal(turnsFromProjection(p, { bot: "s", timeZone: "Not/AZone" })[0]!.day, "2026-11-16");
});

test("a second pass with the same turn replaces its entry instead of doubling it", async () => {
  const h = await ledgerHarness();
  try {
    await h.ledger.add([entry({})]);
    await h.ledger.add([entry({ input: 20, output: 9 })]);
    await h.ledger.save();
    const { rows } = await h.ledger.rows({ days: 7, timeZone: "UTC" });
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0]!.input, rows[0]!.output, rows[0]!.turns], [20, 9, 1]);
    const state = JSON.parse(await readFile(h.file, "utf8"));
    assert.deepEqual(state.seen, ["th1:t1"]);
  } finally { await h.cleanup(); }
});

test("entries older than 90 days are dropped with their keys", async () => {
  const h = await ledgerHarness();
  try {
    await h.ledger.add([entry({ key: "old", day: "2026-08-01" }), entry({ key: "kept", day: "2026-08-20" }), entry({ key: "fresh", day: "2026-11-16" })]);
    await h.ledger.save();
    const state = JSON.parse(await readFile(h.file, "utf8"));
    assert.deepEqual(state.entries.map((e: UsageEntry) => e.key).sort(), ["fresh", "kept"]);
    assert.deepEqual(state.seen.sort(), ["fresh", "kept"]);
    assert.match(state.since as string, /^2026-11-16T/);
  } finally { await h.cleanup(); }
});

test("rows aggregate per day, Bot, source and model over exactly 7 or 30 days", async () => {
  const h = await ledgerHarness();
  try {
    await h.ledger.add([
      entry({ key: "1", day: "2026-11-16", bot: "scout", source: "you", model: "model-a" }),
      entry({ key: "2", day: "2026-11-16", bot: "scout", source: "you", model: "model-a", input: 5, cached: 0, cacheWrite: 0, output: 0 }),
      entry({ key: "3", day: "2026-11-16", bot: "scout", source: "routine", model: "model-a" }),
      entry({ key: "4", day: "2026-11-15", bot: "scribe", source: "you", model: "model-b", output: 7 }),
      entry({ key: "5", day: "2026-11-09", bot: "scout", source: "you", model: "model-a" }),
    ]);
    const week = await h.ledger.rows({ days: 7, timeZone: "UTC" });
    assert.deepEqual([week.since, week.until, week.days[0], week.days.length], ["2026-11-10", "2026-11-16", "2026-11-10", 7]);
    assert.match(week.ledgerSince, /^2026-11-16T/);
    assert.equal(week.rows.length, 3);
    const mine = week.rows.find((row) => row.source === "you" && row.bot === "scout")!;
    assert.deepEqual([mine.day, mine.model, mine.input, mine.output, mine.turns], ["2026-11-16", "model-a", 15, 5, 2]);
    assert.deepEqual(week.rows.filter((row) => row.day === "2026-11-09").length, 0);
    const month = await h.ledger.rows({ days: 30, timeZone: "UTC" });
    assert.equal(month.days.length, 30);
    assert.equal(month.rows.length, 4);
    assert.equal((await h.ledger.rows({ days: 7, timeZone: "Europe/Istanbul" })).timeZone, "Europe/Istanbul");
    assert.equal(typeof (await h.ledger.rows({ days: 7, timeZone: "Not/AZone" })).timeZone, "string");
  } finally { await h.cleanup(); }
});

test("the ledger file is written atomically, 0600, and reads back", async () => {
  const h = await ledgerHarness();
  try {
    await h.ledger.add([entry({})]);
    await h.ledger.save();
    assert.equal(((await stat(h.file)).mode & 0o777), 0o600);
    assert.equal((await stat(path.join(h.dir, "usage")).then((s) => s.mode & 0o777)), 0o700);
    const reopened = createUsageLedger({ file: h.file, now: () => NOW });
    const { rows } = await reopened.rows({ days: 7, timeZone: "UTC" });
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0]!.bot, rows[0]!.input, rows[0]!.turns], ["scout", 10, 1]);
  } finally { await h.cleanup(); }
});

test("transcript roots map to provider labels, never to a path", () => {
  const home = "/home/u";
  assert.equal(providerForSourcePath("/home/u/.claude/projects/abc", home), "Claude");
  assert.equal(providerForSourcePath("/home/u/.claude-ngc/projects/abc", home), "Claude (ngc)");
  assert.equal(providerForSourcePath("/home/u/.codex/sessions/abc", home), "Codex");
  assert.equal(providerForSourcePath("/home/u/.codex/archived_sessions/abc", home), "Codex");
  assert.equal(providerForSourcePath("/home/u/.grok/sessions/abc", home), "Grok");
  assert.equal(providerForSourcePath("/home/u/.gemini/tmp/abc", home), null);
  assert.equal(providerForSourcePath("/etc/passwd", home), null);
  assert.equal(providerForSourcePath(42, home), null);
  for (const path of ["/home/u/.claude/projects/abc", "/home/u/.claude-ngc/projects/abc", "/home/u/.codex/sessions/abc", "/home/u/.grok/sessions/abc"]) {
    const label = providerForSourcePath(path, home)!;
    assert.ok(label && !label.includes("/") && !label.includes(home), `${label} is a label, not a path`);
  }
  const window = usageDays(7, "UTC", NOW);
  assert.deepEqual([window.since, window.until, window.days.length], ["2026-11-10", "2026-11-16", 7]);
});

test("usage-summary buckets become per-account totals without their paths", () => {
  const accounts = accountsFromBuckets([
    { sourcePath: "/home/u/.claude/projects/abc", totals: { uncachedInputTokens: 10, cachedInputTokens: 2, cacheCreationTokens: 1, outputTokens: 5 }, costUsd: 0.5 },
    { sourcePath: "/home/u/.claude/projects/def", totals: { uncachedInputTokens: 4, outputTokens: 1 }, costUsd: 0.25 },
    { provider: "gemini", totals: { uncachedInputTokens: 3, outputTokens: 2 }, costUsd: -1 },
    { provider: "   ", totals: { uncachedInputTokens: 1 } },
    "junk",
  ], "/home/u");
  assert.deepEqual(accounts, [
    { account: "Claude", input: 14, cached: 2, cacheWrite: 1, output: 6, costUsd: 0.75 },
    { account: "gemini", input: 3, cached: 0, cacheWrite: 0, output: 2, costUsd: 0 },
    { account: "Unknown", input: 1, cached: 0, cacheWrite: 0, output: 0, costUsd: 0 },
  ]);
  assert.ok(!JSON.stringify(accounts).includes("sourcePath") && !JSON.stringify(accounts).includes("/home/u"));
  assert.deepEqual(accountsFromBuckets(null), []);
});

test("the scan watermark stops below the oldest thread a pass didn't read", () => {
  assert.equal(nextScanWatermark(100, [{ updatedAt: 300, read: true }, { updatedAt: 200, read: true }]), 300);
  // A newer thread read fine must not carry the mark past an older one that failed or was over the cap.
  assert.equal(nextScanWatermark(100, [{ updatedAt: 300, read: true }, { updatedAt: 200, read: false }, { updatedAt: 150, read: true }]), 150);
  assert.equal(nextScanWatermark(100, [{ updatedAt: 200, read: true }, { updatedAt: 200, read: false }]), 199);
  assert.equal(nextScanWatermark(100, [{ updatedAt: 101, read: false }]), 100);
  assert.equal(nextScanWatermark(100, []), 100);
});
