import assert from "node:assert/strict";
import test from "node:test";

test("Map counts delivered messages by Bot and skips self and unknown senders", async () => {
  const { aggregateBotEdges } = await import("./bot-map.mts");
  const bots = [
    { slug: "alpha", projectId: "project-a", mainThreadId: "main-a" },
    { slug: "beta", projectId: "project-b", mainThreadId: "main-b" },
  ];
  const threads = [
    { id: "main-a", projectId: "project-a" },
    { id: "side-a", projectId: "project-a" },
    { id: "main-b", projectId: "project-b" },
    { id: "other", projectId: "project-other" },
  ];
  const message = (senderThreadId?: string) => ({ type: "user_message", senderThreadId });
  const recentItems = [
    { threadId: "main-b", items: [
      message("main-a"), { item: message("side-a") }, message("main-b"),
      message("other"), message("missing"), message(), { type: "assistant_message", senderThreadId: "main-a" },
    ] },
    { threadId: "main-a", items: [message("main-b"), message("side-a")] },
    { threadId: "side-a", items: [message("main-b")] },
    { threadId: "other", items: [message("main-a")] },
  ];
  assert.deepEqual(aggregateBotEdges(bots, threads, recentItems), [
    { from: "alpha", to: "beta", count: 2 },
    { from: "beta", to: "alpha", count: 1 },
  ]);
});
