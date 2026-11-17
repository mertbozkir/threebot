import config from "../../../server/avatar-config.json";
import type { Bot, ThreadShell, TurnItem } from "./types";

export type ThreadTarget =
  | { kind: "local"; threadId: string }
  | { kind: "remote"; threadId: string; environmentId: string; label: string };

/** T3 follows the real shell snapshot with a project-only one; its empty thread list is not the roster. */
export function isProjectEnrichment(item: { resolvedRepositoryIdentityRoots?: unknown; snapshot: { threads: unknown[]; archivedThreads?: unknown[] } }) {
  return item.resolvedRepositoryIdentityRoots !== undefined && !item.snapshot.threads.length && !item.snapshot.archivedThreads?.length;
}

export function sameTaskBot(a: Bot, b: Bot) {
  return a.slug === b.slug && a.mainThreadId === b.mainThreadId && a.name === b.name && a.shape === b.shape && a.color === b.color && a.avatarImage === b.avatarImage;
}

/** A run's ordinal, from the projection's runs or the T3 run id ("…:ordinal:N"). */
export function runOrdinal(runId: unknown, runs: Record<string, { ordinal?: number }> = {}): number | null {
  if (typeof runId !== "string") return null;
  const known = runs[runId]?.ordinal;
  if (typeof known === "number") return known;
  const parsed = /:ordinal:(\d+)$/.exec(runId)?.[1];
  return parsed ? Number(parsed) : null;
}

/**
 * The oldest run a partially loaded thread holds rows for, or null when the whole history is loaded.
 * Records from older runs (subagents, plans) belong to rows not loaded yet and must not show at the end.
 */
export function loadedRunFloor(items: readonly TurnItem[], runs: Record<string, { ordinal?: number }>, partial: boolean): number | null {
  if (!partial) return null;
  let floor: number | null = null;
  for (const item of items) {
    const ordinal = runOrdinal(item.runId, runs);
    if (ordinal !== null && (floor === null || ordinal < floor)) floor = ordinal;
  }
  return floor;
}

const taskItems = new WeakMap<object, TurnItem>();
/** Some native/delegated tasks have a projection record without a visible turn item. */
/**
 * Records without a row are placed where they started, after the last row that started before them, not at the end.
 * runFloor: in a partly loaded thread, records from older runs, or that started before the oldest loaded row, are left out.
 */
export function supplementSubagents(items: TurnItem[], agents: unknown[], threadId: string, runFloor: number | null = null): TurnItem[] {
  const represented = new Set(items.filter(item => item.type === "subagent").map(item => item.subagentId));
  const timeline = items.flatMap(item => {
    const at = Date.parse(item.startedAt ?? "");
    return Number.isFinite(at) ? [[at, item.ordinal] as const] : [];
  }).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const last = Math.max(0, ...items.map(item => item.ordinal));
  const additions: TurnItem[] = [];
  for (const value of agents) {
    const agent = record(value);
    if (!agent || typeof agent.id !== "string" || typeof agent.status !== "string" || represented.has(agent.id) || !value || typeof value !== "object") continue;
    if (runFloor !== null && (runOrdinal(agent.runId) ?? Infinity) < runFloor) continue;
    const at = Date.parse(typeof agent.startedAt === "string" ? agent.startedAt : "");
    let ordinal = last + additions.length + 1;
    if (Number.isFinite(at) && timeline.length) {
      let before: number | null = null;
      for (const [time, rowOrdinal] of timeline) if (time <= at) before = rowOrdinal; else break;
      if (before === null && runFloor !== null) continue;
      ordinal = (before ?? timeline[0][1] - 1) + 0.5 + additions.length / 1000;
    }
    let item = taskItems.get(value);
    if (!item || item.ordinal !== ordinal) {
      item = { ...agent, id: `subagent-record:${agent.id}`, subagentId: agent.id, threadId, runId: typeof agent.runId === "string" ? agent.runId : null, ordinal, status: agent.status, title: typeof agent.title === "string" ? agent.title : null, type: "subagent", startedAt: typeof agent.startedAt === "string" ? agent.startedAt : null, completedAt: typeof agent.completedAt === "string" ? agent.completedAt : null, updatedAt: typeof agent.updatedAt === "string" ? agent.updatedAt : "", parentItemId: null };
      taskItems.set(value, item);
    }
    additions.push(item);
  }
  return additions.length ? [...items, ...additions] : items;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? Object.fromEntries(Object.entries(value)) : null;
}

/** Remote delegates have no local childThreadId. Never open the parent in their place. */
export function subagentTarget(item: TurnItem): ThreadTarget | null {
  const remote = record(item.remoteChild);
  if (typeof remote?.threadId === "string" && typeof remote.environmentId === "string") {
    return { kind: "remote", threadId: remote.threadId, environmentId: remote.environmentId, label: typeof remote.label === "string" ? remote.label : "Another machine" };
  }
  return typeof item.childThreadId === "string" && item.childThreadId ? { kind: "local", threadId: item.childThreadId } : null;
}

export function threadLink(target: ThreadTarget) {
  return target.kind === "remote" ? `/api/thread-link?environmentId=${encodeURIComponent(target.environmentId)}&threadId=${encodeURIComponent(target.threadId)}` : `?thread=${encodeURIComponent(target.threadId)}`;
}

export function subagentStatus(status: string) {
  switch (status) {
    case "pending": case "preparing": case "queued": case "starting": case "running": return "Working";
    case "waiting": return "Waiting";
    case "completed": return "Done";
    case "failed": return "Failed";
    case "cancelled": return "Cancelled";
    case "interrupted": return "Stopped";
    case "rolled_back": return "Rolled back";
    case "idle": return "Idle";
    default: return "Unknown";
  }
}

/** Native children can have an idle shell and no runs even after completion.
 * Use their subagent record, and never let an older family read undo an event. */
export function agentStatus({ thread, fallback, updatedAt }: { thread?: ThreadShell; fallback?: string; updatedAt?: string } = {}) {
  if (!thread) return fallback ?? "unknown";
  if (thread.pendingRuntimeRequest) return "waiting";
  const status = thread.activityRunStatus ?? thread.status;
  const newer = updatedAt && updatedAt > thread.updatedAt;
  if (newer && fallback) return fallback;
  if (["pending", "preparing", "queued", "starting", "running", "waiting", "failed", "cancelled", "interrupted", "rolled_back"].includes(status)) return status;
  if (thread.settledOverride === "settled" || (thread.settledOverride === undefined && thread.settledAt)) return "completed";
  if (status === "idle" && fallback) return fallback;
  return status;
}

function canonicalShape(shape: string) {
  const alias = Object.entries(config.shapeAliases).find(([name]) => name === shape)?.[1];
  return alias ?? (config.shapes.includes(shape) || config.specialShapes.some(avatar => avatar.id === shape) ? shape : "blob");
}

/** Stable across ordering, refreshes, and surfaces; every child differs from its parent. */
export function variantShape(parent: string, id: string) {
  const shapes = config.shapes.filter((shape) => shape !== canonicalShape(parent));
  let hash = 0;
  for (const char of id) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
  return shapes[hash % shapes.length];
}

export function threadIdentity(bot: Bot, threadId: string, threads: Record<string, ThreadShell>): { name: string; shape: string; color: string; avatarImage?: string | null } {
  const ancestors: string[] = [];
  const seen = new Set<string>();
  let current: string | null = threadId;
  while (current && current !== bot.mainThreadId && !seen.has(current)) {
    seen.add(current);
    ancestors.unshift(current);
    current = threads[current]?.lineage.parentThreadId ?? null;
  }
  let shape = bot.shape;
  for (const id of ancestors) shape = variantShape(shape, id);
  return { name: threadId === bot.mainThreadId ? bot.name : threads[threadId]?.title || "Subagent", shape, color: bot.color, ...(threadId === bot.mainThreadId && bot.avatarImage ? { avatarImage: bot.avatarImage } : {}) };
}

export function localAncestors(threadId: string, threads: Record<string, ThreadShell>) {
  const result: ThreadShell[] = [];
  const seen = new Set([threadId]);
  let id = threads[threadId]?.lineage.parentThreadId;
  while (id && !seen.has(id)) {
    seen.add(id);
    const parent = threads[id];
    if (!parent) break;
    result.unshift(parent);
    id = parent.lineage.parentThreadId;
  }
  return result;
}
