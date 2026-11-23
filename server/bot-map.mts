import { botThreadOwner, type BotThread } from "./auto-update.mts";
import type { Bot } from "./main-bot.mts";

type MapBot = Pick<Bot, "slug" | "projectId" | "mainThreadId">;
type MapThread = Pick<BotThread, "id" | "projectId" | "lineage">;
type MapItem = { type?: string; senderThreadId?: unknown };
type ItemRow = (MapItem & { item?: MapItem | null }) | null;
type Projection = { visibleTurnItems?: ItemRow[] | null; turnItems?: ItemRow[] | null };
type RecentItems = { threadId: string; items: ItemRow[] };
type Edge = { from: string; to: string; count: number };

const WINDOW_SIZE = 200;
const CACHE_MS = 60_000;
const CONCURRENCY = 4;

export function aggregateBotEdges(bots: MapBot[], threads: MapThread[], recent: RecentItems[]): Edge[] {
  const owner = botThreadOwner(bots);
  const byThread = new Map(threads.map((thread) => [thread.id, thread]));
  const mainByThread = new Map(bots.map((bot) => [bot.mainThreadId, bot.slug]));
  const edges = new Map<string, Edge>();
  for (const { threadId, items } of recent) {
    const to = mainByThread.get(threadId);
    if (!to) continue;
    for (const row of items) {
      const item = row?.item ?? row;
      if (item?.type !== "user_message" || typeof item.senderThreadId !== "string") continue;
      const id = item.senderThreadId;
      const from = owner(byThread.get(id) ?? { id })?.slug;
      if (!from || from === to) continue;
      const key = `${from}:${to}`;
      const edge = edges.get(key);
      if (edge) edge.count++;
      else edges.set(key, { from, to, count: 1 });
    }
  }
  return [...edges.values()];
}

export function createBotMap({ bots, threads, projection }: {
  bots: () => Promise<Bot[]>;
  threads: () => Promise<MapThread[]>;
  projection: (threadId: string) => Promise<Projection>;
}) {
  async function load(): Promise<Edge[]> {
    const visible = (await bots()).filter((bot) => !bot.hidden);
    const mainThreads = visible.flatMap((bot) => bot.mainThreadId ? [bot.mainThreadId] : []);
    if (!mainThreads.length) return [];
    const shell = await threads();
    const recent: RecentItems[] = [];
    for (let start = 0; start < mainThreads.length; start += CONCURRENCY) {
      recent.push(...await Promise.all(mainThreads.slice(start, start + CONCURRENCY).map(async (threadId) => {
        const snapshot = await projection(threadId).catch(() => null);
        const rows = snapshot?.visibleTurnItems ?? snapshot?.turnItems ?? [];
        return { threadId, items: rows.slice(-WINDOW_SIZE) };
      })));
    }
    return aggregateBotEdges(visible, shell, recent);
  }

  let pending: Promise<Edge[]> | undefined;
  let cached: { edges: Edge[]; expiresAt: number } | undefined;
  return () => {
    if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.edges);
    return pending ??= load().catch(() => []).then((edges) => {
      cached = { edges, expiresAt: Date.now() + CACHE_MS };
      return edges;
    }).finally(() => { pending = undefined; });
  };
}
