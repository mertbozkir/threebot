import { isRecord, providerRecords } from "./providerData";
import { apiRequest } from "./api";
import { t3 } from "./t3";

export type UsageWindow = { id: string; label: string; percent: number; resetsAt: string | null };
export type ProviderUsage = { id: string; name: string; windows: UsageWindow[]; checkedAt: string | null; unavailable: boolean; resetCredits: number | null; externalUrl: string | null };
export function parseProviderUsage(value: unknown): ProviderUsage[] {
  return providerRecords(value).flatMap((provider) => {
    // A disabled provider can still carry a stale limits record.
    if (provider.enabled === false || typeof provider.instanceId !== "string" || typeof provider.displayName !== "string" || !isRecord(provider.usageLimits)) return [];
    const limits = provider.usageLimits;
    const windows = (Array.isArray(limits.windows) ? limits.windows : []).flatMap((window): UsageWindow[] => {
      if (!isRecord(window) || typeof window.id !== "string" || typeof window.label !== "string" || typeof window.usedPercent !== "number" || !Number.isFinite(window.usedPercent) || window.usedPercent < 0 || window.usedPercent > 100) return [];
      return [{ id: window.id, label: window.label, percent: window.usedPercent, resetsAt: typeof window.resetsAt === "string" && Number.isFinite(Date.parse(window.resetsAt)) ? window.resetsAt : null }];
    });
    const external = isRecord(limits.externalUsage) && typeof limits.externalUsage.url === "string" && /^https:\/\//.test(limits.externalUsage.url) ? limits.externalUsage.url : null;
    return [{ id: provider.instanceId, name: provider.displayName, windows, checkedAt: typeof limits.checkedAt === "string" ? limits.checkedAt : null, unavailable: !!limits.unavailable, resetCredits: isRecord(limits.resetCredits) && typeof limits.resetCredits.availableCount === "number" ? limits.resetCredits.availableCount : null, externalUrl: external }];
  });
}

/** The native reset wording: the time left, in its largest whole unit. */
export function resetsIn(iso: string, now = Date.now()) {
  const minutes = Math.ceil((Date.parse(iso) - now) / 60_000);
  if (minutes <= 0) return "Resets soon";
  const [count, unit] = minutes >= 2880 ? [Math.round(minutes / 1440), "day"] : minutes >= 90 ? [Math.round(minutes / 60), "hour"] : [minutes, "minute"];
  return `Resets in ${count} ${unit}${count === 1 ? "" : "s"}`;
}

export const peakUsage = (providers: ProviderUsage[]) => {
  const percents = providers.flatMap((provider) => provider.windows.map((window) => window.percent));
  return percents.length ? Math.round(Math.max(...percents)) : null;
};

export type UsageCost = { provider: string; cost: number; tokens: number; unpricedRecords: number };
export function parseUsageSummary(value: unknown): UsageCost[] {
  if (!isRecord(value) || typeof value.contractVersion !== "number" || !Array.isArray(value.buckets)) throw new Error("This server's usage summary format is unsupported.");
  const totals = new Map<string, UsageCost>();
  for (const bucket of value.buckets) {
    if (!isRecord(bucket) || typeof bucket.provider !== "string" || typeof bucket.costUsd !== "number" || !Number.isFinite(bucket.costUsd) || !isRecord(bucket.totals)) continue;
    const tokens = [bucket.totals.uncachedInputTokens, bucket.totals.cachedInputTokens, bucket.totals.cacheCreationTokens, bucket.totals.outputTokens];
    if (!tokens.every((n): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0)) continue;
    const current = totals.get(bucket.provider) ?? { provider: bucket.provider, cost: 0, tokens: 0, unpricedRecords: 0 };
    current.cost += bucket.costUsd; current.tokens += tokens.reduce((sum, n) => sum + n, 0); current.unpricedRecords += typeof bucket.unpricedRecords === "number" ? bucket.unpricedRecords : 0;
    totals.set(bucket.provider, current);
  }
  return [...totals.values()];
}
export function usageRange(now = new Date(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  const day = (date: Date) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  return { sinceDay: day(new Date(now.getTime() - 6 * 86400000)), untilDay: day(now), timeZone };
}
export const readUsageSummary = (range: ReturnType<typeof usageRange>) => t3.call<unknown>("server.getUsageSummary", range).then(parseUsageSummary);

/** One aggregated ledger row, as the gateway's /api/usage/bots returns it. */
export type UsageRow = { day: string; bot: string; source: "you" | "routine" | "bot"; model: string; input: number; cached: number; cacheWrite: number; output: number; turns: number };
export type BotUsage = { since: string; until: string; timeZone: string; ledgerSince: string; days: string[]; rows: UsageRow[] };
export type UsageAccount = { account: string; input: number; cached: number; cacheWrite: number; output: number; costUsd: number };
export type UsageAccounts = { since: string; until: string; timeZone: string; accounts: UsageAccount[] };
export const readBotUsage = (days: 7 | 30) => apiRequest<BotUsage>(`/api/usage/bots?days=${days}`);
export const readUsageAccounts = (days: 7 | 30) => apiRequest<UsageAccounts>(`/api/usage/accounts?days=${days}`);

/** Everything charged as input, cache reads and writes included (output never is). */
export const totalIn = (row: Pick<UsageRow, "input" | "cached" | "cacheWrite">) => row.input + row.cached + row.cacheWrite;

/** 1.2M / 340k / 980 */
export const formatTokens = (n: number) => {
  if (n >= 1e6) { const m = n / 1e6; return `${m >= 10 ? Math.round(m) : m.toFixed(1)}M`; }
  if (n >= 1e3) { const k = n / 1e3; return `${k >= 100 ? Math.round(k) : k.toFixed(1)}k`; }
  return `${Math.round(n)}`;
};

export type UsageSeries = { key: string; name: string; inp: number[]; out: number[]; totalIn: number; totalOut: number };

/** Rows as at most four series (largest first by in+out, the rest folded into "Other"), with per-day arrays aligned to `days`. */
export function groupUsage(rows: readonly UsageRow[], by: "bot" | "source" | "model", names: Record<string, string> = {}, days: readonly string[] = []): UsageSeries[] {
  const empty = () => Array.from({ length: days.length }, () => 0);
  const buckets = new Map<string, UsageSeries>();
  for (const row of rows) {
    const key = row[by];
    let series = buckets.get(key);
    if (!series) { series = { key, name: names[key] ?? key, inp: empty(), out: empty(), totalIn: 0, totalOut: 0 }; buckets.set(key, series); }
    const at = days.indexOf(row.day);
    if (at >= 0) { series.inp[at] += row.input; series.out[at] += row.output; }
    series.totalIn += row.input; series.totalOut += row.output;
  }
  const sorted = [...buckets.values()].sort((a, b) => b.totalIn + b.totalOut - (a.totalIn + a.totalOut));
  const top = sorted.slice(0, 4), rest = sorted.slice(4);
  if (!rest.length) return top;
  const other: UsageSeries = { key: "other", name: "Other", inp: empty(), out: empty(), totalIn: 0, totalOut: 0 };
  for (const series of rest) {
    series.inp.forEach((value, at) => { other.inp[at] += value; });
    series.out.forEach((value, at) => { other.out[at] += value; });
    other.totalIn += series.totalIn; other.totalOut += series.totalOut;
  }
  return [...top, other];
}

export type UsageLimitRow = { provider: string; percent: number; resetsAt: string | null };
export type UsageLimitCard = { title: string; rows: UsageLimitRow[] };

/** Provider windows as cards: session and weekly together, every other window under its provider. */
export function limitGroups(providers: readonly ProviderUsage[]): UsageLimitCard[] {
  const session: UsageLimitRow[] = [], weekly: UsageLimitRow[] = [], others = new Map<string, UsageLimitRow[]>();
  for (const provider of providers) for (const window of provider.windows) {
    const row: UsageLimitRow = { provider: provider.name, percent: window.percent, resetsAt: window.resetsAt };
    const text = `${window.label} ${window.id}`.toLowerCase();
    if (/session|5h|hour/.test(text)) session.push(row);
    else if (text.includes("week")) weekly.push(row);
    else { const rows = others.get(provider.name) ?? []; rows.push(row); others.set(provider.name, rows); }
  }
  const cards: UsageLimitCard[] = [];
  if (session.length) cards.push({ title: "Session limits", rows: session });
  if (weekly.length) cards.push({ title: "Weekly limits", rows: weekly });
  for (const [provider, rows] of others) cards.push({ title: `${provider} limits`, rows });
  return cards;
}
