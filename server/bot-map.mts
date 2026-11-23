import { promises as fs } from "node:fs";
import path from "node:path";
import { botThreadOwner, type BotThread } from "./auto-update.mts";
import type { Bot } from "./main-bot.mts";
import type { T3Client } from "./t3rpc.mts";

type MapBot = Pick<Bot, "slug" | "projectId" | "mainThreadId"> & { hidden?: boolean; adopted?: boolean };
type MapThread = Pick<BotThread, "id" | "projectId" | "lineage">;
type MapItem = { id?: string; messageId?: string; type?: string; senderThreadId?: unknown };
type ItemRow = (MapItem & { item?: MapItem | null }) | null;
type Messages = Record<string, string>;
type Receiver = { sequence: number; messages: Messages };
type ThreadRead = Receiver & { full: boolean };
type State = { receivers: Record<string, Receiver>; senders: Record<string, MapThread> };
type Edge = { from: string; to: string; count: number };

const REFRESH_MS = 60_000;
const READ_TIMEOUT_MS = 120_000;

export function aggregateBotEdges(bots: MapBot[], senders: State["senders"], receivers: State["receivers"]): Edge[] {
  const owner = botThreadOwner(bots);
  const edges = new Map<string, Edge>();
  for (const { slug: to, mainThreadId } of bots) {
    const receiver = mainThreadId && receivers[mainThreadId];
    if (!receiver) continue;
    for (const id of Object.values(receiver.messages)) {
      const from = owner(senders[id] ?? { id })?.slug;
      if (!from || from === to) continue;
      const key = `${from}:${to}`;
      const edge = edges.get(key);
      if (edge) edge.count++;
      else edges.set(key, { from, to, count: 1 });
    }
  }
  return [...edges.values()];
}

function collectMessage(messages: Map<string, string>, row: ItemRow) {
  const item = row?.item ?? row;
  const messageId = item?.messageId ?? item?.id;
  if (item?.type === "user_message" && typeof messageId === "string" && typeof item.senderThreadId === "string") {
    messages.set(messageId, item.senderThreadId);
  }
}

export async function readBotMapThread(client: Pick<T3Client, "stream">, threadId: string, afterSequence?: number): Promise<ThreadRead> {
  let stream: ReturnType<T3Client["stream"]> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<ThreadRead>((resolve, reject) => {
      let sequence = afterSequence;
      const messages = new Map<string, string>();
      timer = setTimeout(() => reject(new Error("T3 thread read timed out")), READ_TIMEOUT_MS);
      stream = client.stream("orchestration.subscribeThread", {
        threadId, afterSequence, requestCompletionMarker: true, acceptBoundedSnapshot: false,
      }, (frame) => {
        if (frame.kind === "snapshot") {
          const rows = frame.projection?.turnItems ?? frame.projection?.visibleTurnItems;
          if (frame.hasMoreHistory || !Array.isArray(rows) || !Number.isSafeInteger(frame.snapshotSequence)) {
            reject(new Error("T3 did not send a complete thread snapshot"));
            return;
          }
          messages.clear();
          for (const row of rows) collectMessage(messages, row);
          resolve({ sequence: frame.snapshotSequence, full: true, messages: Object.fromEntries(messages) });
        } else if (frame.kind === "event" && sequence !== undefined && Number.isSafeInteger(frame.sequence)) {
          sequence = Math.max(sequence, frame.sequence);
          if (frame.event?.type === "turn-item.updated") collectMessage(messages, frame.event.payload);
        } else if (frame.kind === "synchronized" && sequence !== undefined) {
          resolve({ sequence, full: false, messages: Object.fromEntries(messages) });
        }
      });
      void stream.done.then(() => reject(new Error("T3 ended the thread read before catch-up")), reject);
    });
  } finally {
    clearTimeout(timer);
    try { stream?.cancel(); } catch {}
  }
}

export function createBotMap({ file, bots, threads, readThread, log = () => {} }: {
  file: string;
  bots: () => Promise<MapBot[]>;
  threads: () => Promise<MapThread[]>;
  readThread: (threadId: string, afterSequence?: number) => Promise<ThreadRead>;
  log?: (message: string, error: unknown) => void;
}) {
  let state: Promise<State> | undefined;
  let pending: Promise<void> | undefined;
  let refreshedAt = 0;

  function load(): Promise<State> {
    return state ??= fs.readFile(file, "utf8").then((raw) => JSON.parse(raw) as State)
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return { receivers: {}, senders: {} };
        state = undefined;
        throw error;
      });
  }

  async function save(next: State) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(next) + "\n", { mode: 0o600 });
    await fs.rename(tmp, file);
    state = Promise.resolve(next);
  }

  const visibleBots = async () => (await bots()).filter((bot) => !bot.hidden);
  function refresh(roster?: MapBot[]): Promise<void> {
    return pending ??= (async () => {
      let current = await load();
      const visible = roster ?? await visibleBots();
      const mainThreads = new Set(visible.flatMap((bot) => bot.mainThreadId ? [bot.mainThreadId] : []));
      if (!mainThreads.size) return;
      const shell = await threads().catch((error) => {
        log("Bot Map could not read sender threads", error);
        return [];
      });
      const byThread = new Map(shell.map(({ id, projectId, lineage }) => [id, { id, projectId, lineage }]));
      const senderDetails = (receivers: State["receivers"]) => {
        const senders = { ...current.senders };
        for (const { messages } of Object.values(receivers)) {
          for (const id of Object.values(messages)) {
            const thread = byThread.get(id);
            if (thread) senders[id] = thread;
          }
        }
        return senders;
      };
      for (const threadId of mainThreads) {
        try {
          const previous = current.receivers[threadId];
          const next = await readThread(threadId, previous?.sequence);
          if (!next.full && next.sequence === previous?.sequence && !Object.keys(next.messages).length) continue;
          const messages = next.full ? next.messages : { ...previous?.messages, ...next.messages };
          const receivers = { ...current.receivers, [threadId]: { sequence: next.sequence, messages } };
          const updated = { receivers, senders: senderDetails(receivers) };
          await save(updated);
          current = updated;
        } catch (error) {
          log(`Bot Map could not refresh thread ${threadId}`, error);
        }
      }
      const senders = senderDetails(current.receivers);
      if (JSON.stringify(senders) !== JSON.stringify(current.senders)) await save({ ...current, senders });
    })().catch((error) => log("Bot Map refresh failed", error)).finally(() => {
      refreshedAt = Date.now();
      pending = undefined;
    });
  }

  return {
    refresh: () => refresh(),
    async read() {
      const [visible, current] = await Promise.all([visibleBots(), load()]);
      if (Date.now() - refreshedAt >= REFRESH_MS) void refresh(visible);
      return {
        edges: aggregateBotEdges(visible, current.senders, current.receivers),
        unread: visible.filter((bot) => bot.mainThreadId && !current.receivers[bot.mainThreadId]).map((bot) => bot.slug),
      };
    },
  };
}
