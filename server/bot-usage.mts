// Bot token usage: a small ledger the gateway appends to every 15 minutes from Bot thread
// projections, and the two API shapes Settings › Usage reads. Counts only — no prompts, no
// thread titles, no transcript paths leave this file.
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export type UsageSource = "you" | "routine" | "bot";
export type UsageEntry = { key: string; day: string; bot: string; source: UsageSource; model: string; input: number; cached: number; cacheWrite: number; output: number };
export type UsageRow = { day: string; bot: string; source: UsageSource; model: string; input: number; cached: number; cacheWrite: number; output: number; turns: number };
export type UsageLedgerFile = { version: 1; since: string; seen: string[]; entries: UsageEntry[] };

// The parts of T3's `orchestration.getThreadProjection` result read here (same turns as telemetry.mts,
// plus the message/run fields that tell a routine or another Bot from the person).
export type UsageProjection = {
  threadId?: unknown;
  providerTurns?: { id?: unknown; runAttemptId?: unknown; completedAt?: unknown; turnTokenUsage?: unknown }[] | null;
  messages?: { id?: unknown; scheduledTaskId?: unknown; createdBy?: unknown; creationSource?: unknown }[] | null;
  attempts?: { id?: unknown; runId?: unknown }[] | null;
  runs?: { id?: unknown; userMessageId?: unknown; modelSelection?: { model?: unknown } | null }[] | null;
};

const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:@/[\]-]{0,99}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const SOURCES = new Set<string>(["you", "routine", "bot"]);
const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
const cost = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
const text = (value: unknown, max: number) => typeof value === "string" && value ? value.slice(0, max) : null;
const cleanModel = (value: unknown) => typeof value === "string" && MODEL.test(value) ? value : null;

/** YYYY-MM-DD of an instant in a zone; an unusable zone falls back to UTC. */
export function dayIn(timeZone: string | undefined, ms: number): string {
  try { return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms); }
  catch { return new Date(ms).toISOString().slice(0, 10); }
}

/** The `days` calendar days ending today, oldest first, in the zone. */
export function usageDays(days: number, timeZone: string | undefined, now = Date.now()): { since: string; until: string; days: string[] } {
  const [y, m, d] = dayIn(timeZone, now).split("-").map(Number);
  const list: string[] = [];
  for (let back = (days === 30 ? 30 : 7) - 1; back >= 0; back--) {
    const t = new Date(Date.UTC(y!, m! - 1, d! - back));
    list.push(`${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`);
  }
  return { since: list[0]!, until: list[list.length - 1]!, days: list };
}

/**
 * The finished provider turns of one projection as ledger entries. `bot` is the Bot's slug; a turn whose
 * run started from a routine message is "routine", one started by an agent or the server is another "bot",
 * and everything else is "you".
 */
export function turnsFromProjection(projection: UsageProjection | null | undefined, { bot, timeZone }: { bot: string; timeZone?: string }): UsageEntry[] {
  if (!projection || !Array.isArray(projection.providerTurns)) return [];
  const threadId = text(projection.threadId, 200);
  if (!threadId) return [];
  const runOfAttempt = new Map((projection.attempts ?? []).map((attempt) => [text(attempt.id, 200), text(attempt.runId, 200)]).filter(([id]) => id) as [string, string | null][]);
  const runOfId = new Map((projection.runs ?? []).map((run) => [text(run.id, 200), run]).filter(([id]) => id) as [string, NonNullable<UsageProjection["runs"]>[number]][]);
  const messageOfId = new Map((projection.messages ?? []).map((message) => [text(message.id, 200), message]).filter(([id]) => id) as [string, NonNullable<UsageProjection["messages"]>[number]][]);
  const entries: UsageEntry[] = [];
  for (const turn of projection.providerTurns) {
    if (!turn || typeof turn !== "object") continue;
    const usage = turn.turnTokenUsage;
    if (!usage || typeof usage !== "object") continue;
    const u = usage as { usageStatus?: unknown; localCommand?: unknown; inputTokens?: unknown; outputTokens?: unknown; cachedInputTokens?: unknown; cacheCreationTokens?: unknown; models?: unknown; otherUsage?: { inputTokens?: unknown; outputTokens?: unknown } | null };
    if (u.usageStatus === "unavailable" || u.localCommand === true) continue;
    const completedAt = typeof turn.completedAt === "string" && Number.isFinite(Date.parse(turn.completedAt)) ? turn.completedAt : null;
    if (!completedAt) continue;
    const attemptId = text(turn.runAttemptId, 200);
    const run = runOfId.get(attemptId ? runOfAttempt.get(attemptId) ?? "" : "");
    const message = run ? messageOfId.get(text(run.userMessageId, 200) ?? "") : undefined;
    const source: UsageSource = message?.scheduledTaskId != null && typeof message.scheduledTaskId === "string" ? "routine"
      : message?.createdBy === "agent" || message?.creationSource === "server" ? "bot" : "you";
    const reported = Array.isArray(u.models) ? u.models.map(cleanModel).filter((m): m is string => !!m) : [];
    const model = reported.length === 1 ? reported[0] : reported.length > 1 ? "multiple"
      : cleanModel(run?.modelSelection?.model) ?? "unknown";
    const id = text(turn.id, 200) ?? `${attemptId ?? ""}:${completedAt}`;
    entries.push({
      key: `${threadId}:${id}`, day: dayIn(timeZone, Date.parse(completedAt)), bot: bot.slice(0, 100), source, model,
      input: count(u.inputTokens) + count(u.otherUsage?.inputTokens),
      cached: count(u.cachedInputTokens), cacheWrite: count(u.cacheCreationTokens),
      output: count(u.outputTokens) + count(u.otherUsage?.outputTokens),
    });
  }
  return entries;
}

const validEntry = (value: unknown): value is UsageEntry => {
  if (!value || typeof value !== "object") return false;
  const e = value as UsageEntry;
  return typeof e.key === "string" && e.key.length > 0 && e.key.length <= 500
    && typeof e.day === "string" && DAY.test(e.day)
    && typeof e.bot === "string" && e.bot.length > 0 && e.bot.length <= 100
    && typeof e.source === "string" && SOURCES.has(e.source)
    && typeof e.model === "string" && e.model.length > 0 && e.model.length <= 100
    && count(e.input) === e.input && count(e.cached) === e.cached && count(e.cacheWrite) === e.cacheWrite && count(e.output) === e.output;
};

const PRUNE_DAYS = 90 * 24 * 60 * 60 * 1000;

export function createUsageLedger({ file, now = Date.now }: { file: string; now?: () => number }) {
  let state: UsageLedgerFile | null = null;
  const load = async (): Promise<UsageLedgerFile> => {
    if (state) return state;
    let saved: UsageLedgerFile | null = null;
    try { saved = JSON.parse(await fs.readFile(file, "utf8")); } catch { /* Missing or broken file: start over. */ }
    state = saved && (saved as UsageLedgerFile).version === 1 && typeof saved.since === "string" && Array.isArray(saved.seen) && Array.isArray(saved.entries)
      ? { version: 1, since: saved.since, seen: saved.seen.filter((key) => typeof key === "string"), entries: saved.entries.filter(validEntry) }
      : { version: 1, since: new Date(now()).toISOString(), seen: [], entries: [] };
    return state;
  };
  const prune = () => {
    const cutoff = new Date(now() - PRUNE_DAYS).toISOString().slice(0, 10);
    const kept = state!.entries.filter((entry) => entry.day >= cutoff);
    if (kept.length !== state!.entries.length) {
      const live = new Set(kept.map((entry) => entry.key));
      state!.seen = state!.seen.filter((key) => live.has(key));
      state!.entries = kept;
    }
  };
  return {
    load,
    /** Merges entries by key (the newest read of a turn wins) and drops anything older than 90 days. */
    async add(entries: readonly UsageEntry[]) {
      const s = await load();
      const byKey = new Map(s.entries.map((entry) => [entry.key, entry]));
      for (const entry of entries) if (validEntry(entry)) byKey.set(entry.key, entry);
      s.entries = [...byKey.values()];
      s.seen = [...new Set([...s.seen, ...s.entries.map((entry) => entry.key)])];
      prune();
    },
    save: async () => {
      const s = await load();
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await fs.writeFile(`${file}.tmp`, JSON.stringify(s) + "\n", { mode: 0o600 });
      await fs.rename(`${file}.tmp`, file);
    },
    /** Totals per day, Bot, source and model over the last 7 or 30 days in the zone. */
    async rows({ days, timeZone }: { days: number; timeZone?: string }) {
      const s = await load();
      let zone = timeZone?.trim() || undefined;
      try { new Intl.DateTimeFormat("en-CA", { timeZone: zone }); } catch { zone = undefined; }
      const { since, until, days: list } = usageDays(days, zone, now());
      const totals = new Map<string, UsageRow>();
      for (const entry of s.entries) {
        if (entry.day < since || entry.day > until) continue;
        const key = `${entry.day}|${entry.bot}|${entry.source}|${entry.model}`;
        const row = totals.get(key) ?? { day: entry.day, bot: entry.bot, source: entry.source, model: entry.model, input: 0, cached: 0, cacheWrite: 0, output: 0, turns: 0 };
        row.input += entry.input; row.cached += entry.cached; row.cacheWrite += entry.cacheWrite; row.output += entry.output; row.turns += 1;
        totals.set(key, row);
      }
      return { since, until, timeZone: zone ?? Intl.DateTimeFormat().resolvedOptions().timeZone, ledgerSince: s.since, days: list, rows: [...totals.values()] };
    },
  };
}

/**
 * A transcript root as a provider label, or null when it isn't one of the known homes (the caller then
 * shows T3's provider kind instead). Never returns a path.
 */
export function providerForSourcePath(sourcePath: unknown, home: string = homedir()): string | null {
  if (typeof sourcePath !== "string") return null;
  const root = home.replace(/\/+$/, "");
  const p = root && sourcePath.startsWith(`${root}/`) ? `~${sourcePath.slice(root.length)}` : sourcePath;
  const named = /^~\/\.claude-([^/]{1,64})\/projects(?:\/|$)/.exec(p);
  if (named) return `Claude (${named[1]})`;
  if (/^~\/\.claude\/projects(?:\/|$)/.test(p)) return "Claude";
  if (/^~\/\.codex\/(?:archived_)?sessions(?:\/|$)/.test(p)) return "Codex";
  if (/^~\/\.grok(?:\/|$)/.test(p)) return "Grok";
  return null;
}

export type AccountUsage = { account: string; input: number; cached: number; cacheWrite: number; output: number; costUsd: number };

/** T3's usage-summary buckets as per-account totals; transcript paths become labels here, never in the browser. */
export function accountsFromBuckets(buckets: unknown, home: string = homedir()): AccountUsage[] {
  const num = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
  const totals = new Map<string, AccountUsage>();
  for (const bucket of Array.isArray(buckets) ? buckets : []) {
    if (!bucket || typeof bucket !== "object") continue;
    const b = bucket as { sourcePath?: unknown; provider?: unknown; inputTokens?: unknown; cachedInputTokens?: unknown; cacheCreationTokens?: unknown; outputTokens?: unknown; costUsd?: unknown };
    const account = providerForSourcePath(b.sourcePath, home) ?? (typeof b.provider === "string" && b.provider.trim() ? b.provider.trim().slice(0, 60) : "Unknown");
    const row = totals.get(account) ?? { account, input: 0, cached: 0, cacheWrite: 0, output: 0, costUsd: 0 };
    row.input += num(b.inputTokens); row.cached += num(b.cachedInputTokens); row.cacheWrite += num(b.cacheCreationTokens); row.output += num(b.outputTokens); row.costUsd += num(b.costUsd);
    totals.set(account, row);
  }
  return [...totals.values()];
}
