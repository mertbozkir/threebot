import assert from "node:assert/strict";
import { test } from "node:test";
import { buildOnce, entryChunk } from "./support.mts";
import { fileURLToPath } from "node:url";

const src = fileURLToPath(new URL("../src/", import.meta.url));
const bundle = await buildOnce({
  configFile: false,
  logLevel: "silent",
  plugins: [{
    name: "approval-command-text-test-entry",
    resolveId: (id) => id.endsWith("virtual:approval-command-text-test") ? "\0approval-command-text-test" : undefined,
    load: (id) => id === "\0approval-command-text-test"
      ? `export { buildEntries } from ${JSON.stringify(`${src}lib/transcript.ts`)};`
      : undefined,
  }],
  ssr: { noExternal: true },
  build: { ssr: "virtual:approval-command-text-test", write: false },
});
const entry = entryChunk(bundle);
assert.ok(entry, "test bundle has an entry point");
const { buildEntries } = await import(`data:text/javascript;base64,${Buffer.from(entry.code).toString("base64")}`);

const ctx = { bot: { name: "Strategy", workspaceRoot: "/w" }, botsByThread: new Map(), tasks: [], requests: {} };
const base = { threadId: "t", runId: "r", status: "completed", startedAt: "2026-11-20T09:12:49.000Z", completedAt: null, updatedAt: "2026-11-20T09:12:49.000Z", parentItemId: null };
const curl = 'curl -sS --max-time 8 "https://hn.algolia.com/api/v1/search?query=forward+deployed+engineer&tags=story&hitsPerPage=5" | head -c 500';

// The shapes T3 stores for an Antigravity shell call and its approval (one native tool call ID).
const command = (nativeId: string, input: string, title = "Ran command") => ({ ...base, id: `cmd-${nativeId}`, ordinal: 1, type: "command_execution", title, input, nativeItemRef: { driver: "antigravity", nativeId, strength: "strong" } });
const approval = (nativeId: string, prompt: string | undefined, requestKind = "command") => ({ ...base, id: `approval-${nativeId}`, ordinal: 2, type: "approval_request", title: null, status: "waiting", requestId: `req-${nativeId}`, requestKind, ...(prompt === undefined ? {} : { prompt }), nativeItemRef: { driver: "antigravity", nativeId, strength: "weak" } });
const card = (items: unknown[]) => buildEntries(items, ctx).find((e: { kind: string }) => e.kind === "approval").item;

test("an approval that only repeats the tool title shows the command it approves", () => {
  assert.equal(card([command("call_1", curl), approval("call_1", "Ran command")]).prompt, curl);
});

test("an approval with no prompt shows the command too", () => {
  assert.equal(card([command("call_2", "git status"), approval("call_2", undefined)]).prompt, "git status");
});

test("a real prompt is kept, as Claude, Codex and OpenCode send it", () => {
  assert.equal(card([command("call_3", "git status"), approval("call_3", "rm -rf build")]).prompt, "rm -rf build");
});

test("nothing to match keeps the card as it was", () => {
  assert.equal(card([approval("call_4", "Ran command")]).prompt, "Ran command");
  assert.equal(card([command("other", "ls"), approval("call_5", "Ran command")]).prompt, "Ran command");
  assert.equal(card([command("call_6", "ls", "Changed files"), approval("call_6", "Changed files", "file-change")]).prompt, "Changed files");
});

test("a command from another run, another driver or an ambiguous match never lands on the card", () => {
  const otherRun = { ...command("call_7", "rm -rf /tmp/x"), runId: "earlier-run" };
  assert.equal(card([otherRun, approval("call_7", "Ran command")]).prompt, "Ran command");
  const otherDriver = { ...command("call_8", "ls"), nativeItemRef: { driver: "codex", nativeId: "call_8", strength: "strong" } };
  assert.equal(card([otherDriver, approval("call_8", "Ran command")]).prompt, "Ran command");
  const twice = [command("call_9", "ls"), { ...command("call_9", "rm -rf build"), id: "cmd-call_9-b" }];
  assert.equal(card([...twice, approval("call_9", "Ran command")]).prompt, "Ran command");
});
