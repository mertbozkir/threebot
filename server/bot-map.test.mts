import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("Map counts delivered messages by Bot and skips self and unknown senders", async () => {
  const { aggregateBotEdges } = await import("./bot-map.mts");
  const bots = [
    { slug: "alpha", projectId: "project-a", mainThreadId: "main-a" },
    { slug: "beta", projectId: "project-b", mainThreadId: "main-b" },
  ];
  const senders = {
    "side-a": { id: "side-a", projectId: "project-a" },
    other: { id: "other", projectId: "project-other" },
  };
  const receivers = {
    "main-a": { sequence: 1, messages: { one: "main-b", two: "side-a" } },
    "main-b": { sequence: 1, messages: { one: "main-a", two: "side-a", three: "main-b", four: "other", five: "missing" } },
    "side-a": { sequence: 1, messages: { one: "main-b" } },
    other: { sequence: 1, messages: { one: "main-a" } },
  };
  assert.deepEqual(aggregateBotEdges(bots, senders, receivers), [
    { from: "beta", to: "alpha", count: 1 },
    { from: "alpha", to: "beta", count: 2 },
  ]);
});

test("Bot Map keeps counts on failure, deduplicates replay, and reloads its cursor", async (t) => {
  const { createBotMap } = await import("./bot-map.mts");
  const directory = await mkdtemp(join(tmpdir(), "threebot-map-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "bot-map.json");
  const alpha = { slug: "alpha", projectId: "project-a", mainThreadId: "main-a" };
  const beta = { slug: "beta", projectId: "project-b", mainThreadId: "main-b" };
  const edge = (count: number) => ({ from: "alpha", to: "beta", count });
  let pass = 0;
  const reads: { threadId: string; afterSequence?: number }[] = [];
  const options = {
    file,
    bots: async () => [alpha, beta],
    threads: async () => [{ id: "side-a", projectId: "project-a" }],
    readThread: async (threadId: string, afterSequence?: number) => {
      reads.push({ threadId, afterSequence });
      if (threadId === "main-a" || pass === 2) throw new Error("T3 timed out");
      const messages: Record<string, string> = { one: "side-a" };
      if (pass === 0) return { sequence: 7, full: true, messages };
      messages.two = "side-a";
      return { sequence: 9, full: false, messages };
    },
  };
  await writeFile(file + ".tmp", "stale");
  await chmod(file + ".tmp", 0o644);
  const map = createBotMap(options);
  assert.deepEqual(await map.read(), { edges: [], unread: ["alpha", "beta"] });
  assert.deepEqual(await map.read(), { edges: [], unread: ["alpha", "beta"] });
  await map.refresh();
  assert.deepEqual(await map.read(), { edges: [edge(1)], unread: ["alpha"] });
  if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o777, 0o600);

  pass = 1;
  await map.refresh();
  assert.deepEqual(await map.read(), { edges: [edge(2)], unread: ["alpha"] });

  pass = 2;
  await map.refresh();
  assert.deepEqual(await map.read(), { edges: [edge(2)], unread: ["alpha"] });
  assert.deepEqual(reads.filter((read) => read.threadId === "main-b").map((read) => read.afterSequence), [undefined, 7, 9]);

  const restored = createBotMap({
    ...options,
    bots: async () => [{ ...alpha, slug: "renamed" }, beta],
    threads: async () => { throw new Error("T3 is down"); },
  });
  assert.deepEqual(await restored.read(), { edges: [{ ...edge(2), from: "renamed" }], unread: ["renamed"] });
  await restored.refresh();
  assert.equal(reads.filter((read) => read.threadId === "main-b").at(-1)?.afterSequence, 9);
});

test("T3 thread reads stop at catch-up and accept a full snapshot fallback", async () => {
  const { readBotMapThread } = await import("./bot-map.mts");
  const message = { id: "turn-item", messageId: "message", type: "user_message", senderThreadId: "sender" };
  const event = (sequence: number, payload = message) => ({ kind: "event", sequence, event: { type: "turn-item.updated", payload } });
  const snapshot = { kind: "snapshot", snapshotSequence: 15, projection: { visibleTurnItems: [{ item: message }] } };
  const replay = [event(10), event(11, { ...message, type: "assistant_message" }), { kind: "synchronized" }, event(12, { ...message, messageId: "late" })];
  for (const [afterSequence, frames, expected] of [
    [undefined, [snapshot], { sequence: 15, full: true, messages: { message: "sender" } }],
    [9, replay, { sequence: 11, full: false, messages: { message: "sender" } }],
    [9, [snapshot], { sequence: 15, full: true, messages: { message: "sender" } }],
  ] as const) {
    let cancelled = false;
    const result = await readBotMapThread({
      stream(tag, payload, onItem) {
        assert.equal(tag, "orchestration.subscribeThread");
        assert.deepEqual(payload, { threadId: "receiver", afterSequence, requestCompletionMarker: true, acceptBoundedSnapshot: false });
        queueMicrotask(() => frames.forEach(onItem));
        return { done: new Promise(() => {}), cancel: () => { cancelled = true; } };
      },
    }, "receiver", afterSequence);
    assert.deepEqual(result, expected);
    assert.equal(cancelled, true);
  }
});
