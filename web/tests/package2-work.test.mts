import assert from "node:assert/strict";
import { after, afterEach, beforeEach, test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { MessageChannel } from "node:worker_threads";
import { Window } from "happy-dom";
import { buildOnce, domWindow, entryChunk, isModule } from "./support.mts";
import { fileURLToPath } from "node:url";
const channels = [];
globalThis.MessageChannel = class extends MessageChannel {
  constructor() {
    super();
    channels.push(this);
  }
};
const window = domWindow(new Window({ url: "http://package2.test" }));
for (const key of [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "Element",
  "Node",
  "Event",
  "MouseEvent",
  "localStorage",
  "location",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "IntersectionObserver",
])
  Object.defineProperty(globalThis, key, {
    configurable: true,
    value: window[key],
  });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver = class {
  observe() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;
const src = fileURLToPath(new URL("../src/", import.meta.url));
const bundle = await buildOnce({
  configFile: false,
  logLevel: "silent",
  define: { "process.env.NODE_ENV": '"development"' },
  plugins: [
    {
      name: "package2-tests",
      enforce: "pre",
      resolveId: (id) =>
        id.endsWith("virtual:package2-tests") ? "\0package2-tests" : undefined,
      transform: (code, id) => {
        if (isModule(id, src + "components/ThreadFamily.tsx"))
          return code.replace(
            "  const update = useApp",
            "  globalThis.package2ChildRenders = (globalThis.package2ChildRenders ?? 0) + 1;\n  const update = useApp",
          );
        if (isModule(id, src + "components/PlanMessage.tsx"))
          return code.replace(
            "  const text =",
            "  globalThis.package2PlanRenders = (globalThis.package2PlanRenders ?? 0) + 1;\n  const text =",
          );
      },
      load: (id) =>
        id === "\0package2-tests"
          ? `
export { createElement, act, StrictMode } from 'react'; export { createRoot } from 'react-dom/client';
export * from ${JSON.stringify(src + "lib/runtimeApi.ts")};
export { buildEntries } from ${JSON.stringify(src + "lib/transcript.ts")};
export { findTidyTask, tidyState } from ${JSON.stringify(src + "lib/memoryTidy.ts")};
export { Chat } from ${JSON.stringify(src + "components/Chat.tsx")};
export { QueuedWork } from ${JSON.stringify(src + "components/QueuedWork.tsx")};
export { PlanMessage } from ${JSON.stringify(src + "components/PlanMessage.tsx")};
export { GoalCard } from ${JSON.stringify(src + "components/GoalCard.tsx")};
export { TaskChanges, PR_DONE_LINGER_MS } from ${JSON.stringify(src + "components/TaskChanges.tsx")};
export { supplementSubagents, loadedRunFloor } from ${JSON.stringify(src + "lib/threadFamily.ts")};
export { SubagentRow } from ${JSON.stringify(src + "components/ThreadFamily.tsx")};
export { useApp } from ${JSON.stringify(src + "store.ts")}; export { t3 } from ${JSON.stringify(src + "lib/t3.ts")};`
          : undefined,
    },
  ],
  ssr: { noExternal: true },
  build: { ssr: "virtual:package2-tests", write: false },
});
const dir = await mkdtemp(join(tmpdir(), "package2-tests-")),
  filename = join(dir, "entry.mjs");
await writeFile(
  filename,
  entryChunk(bundle).code,
);
const {
  createElement: h,
  StrictMode,
  act,
  createRoot,
  decodeWorkProjection,
  decodePlan,
  decodePR,
  prStatus,
  PR_DONE_LINGER_MS,
  queuedWork,
  reduceWorkEvent,
  currentGoal,
  goalControls,
  messageCommand,
  runtimeWork,
  readWorkDiff,
  supplementSubagents,
  loadedRunFloor,
  QueuedWork,
  PlanMessage,
  GoalCard,
  TaskChanges,
  SubagentRow,
  Chat,
  useApp,
  t3,
  buildEntries,
  findTidyTask,
  tidyState,
} = await import(pathToFileURL(filename).href);
after(async () => {
  for (const c of channels) {
    c.port1.close();
    c.port2.close();
  }
  await window.happyDOM.close();
  await rm(dir, { recursive: true });
});
const run = (id, status = "queued", position = 1) => ({
  id,
  status,
  ordinal: position,
  queuePosition: position,
  queueHeld: true,
  userMessageId: `m-${id}`,
});
const projection = (extra = {}) => ({
  thread: {
    id: "work",
    projectId: "project",
    modelSelection: { instanceId: "codex" },
    activeProviderThreadId: "provider",
  },
  runs: [run("b", "queued", 2), run("a", "queued", 1)],
  messages: [
    {
      id: "m-a",
      role: "user",
      text: "First prompt",
      attachments: [{ name: "keep.csv" }],
    },
    { id: "m-b", role: "user", text: "Second prompt", attachments: [] },
  ],
  plans: [],
  providerThreads: [],
  subagents: [],
  checkpoints: [],
  ...extra,
});
let host, root, calls, p, streams, failDispatch, prDetail, prChecks;
beforeEach(() => {
  p = projection();
  calls = [];
  streams = [];
  failDispatch = false;
  prDetail = {};
  prChecks = {};
  t3.stream = (tag, payload, callback) => {
    const stream = { tag, payload, callback, cancelled: false };
    streams.push(stream);
    return {
      cancel() {
        stream.cancelled = true;
      },
      done: new Promise(() => {}),
    };
  };
  t3.call = async (tag, payload) => {
    calls.push({ tag, payload });
    if (tag === "orchestration.dispatchCommand") {
      if (failDispatch) throw Error("Disconnected");
      return { sequence: 1 };
    }
    if (tag === "orchestration.getThreadProjection") return p;
    if (tag === "pullRequests.detail") return prDetail;
    if (tag === "pullRequests.checks") return prChecks;
    if (tag === "orchestration.getThreadFamily") return { threads: [] };
    if (
      tag === "orchestration.getTurnDiff" ||
      tag === "orchestration.getFullThreadDiff"
    )
      return { diff: "diff --git a/later.txt b/later.txt\n+hello" };
    return {};
  };
  useApp.setState({
    bots: {},
    historicalBots: {},
    threads: {},
    threadData: {},
    tasks: [],
    providers: [],
    projects: {},
    vault: [],
    settings: { userName: "", theme: "dark" },
    exchangeBotSlug: null,
    detailsOpen: false,
  });
  host = document.createElement("main");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
const render = async (component, props) =>
  act(async () => root.render(h(component, props)));
const button = (label) =>
  [...host.querySelectorAll("button")].find(
    (b) =>
      b.textContent === label ||
      b.getAttribute("aria-label") === label ||
      b.title === label,
  );
const click = async (label) => {
  const b = button(label);
  assert.ok(b, `Button ${label}`);
  await act(async () => b.click());
};
const commands = () =>
  calls
    .filter((c) => c.tag === "orchestration.dispatchCommand")
    .map((c) => c.payload);
test("queue uses run position and matching messages; unknown states remain unknown", () => {
  const state = decodeWorkProjection(p);
  assert.deepEqual(
    queuedWork(state).map(({ run, message }) => [run.id, message.text]),
    [
      ["a", "First prompt"],
      ["b", "Second prompt"],
    ],
  );
  assert.equal(
    decodePlan({
      id: "plan",
      kind: "todo_list",
      steps: [{ id: "step", text: "Future", status: "future" }],
    }).steps[0].status,
    "future",
  );
  assert.throws(() => decodeWorkProjection({ projection: p }));
});
test("assistant deltas and unrelated shell events preserve snapshot identity", () => {
  const state = decodeWorkProjection(p);
  for (const event of [
    {
      type: "message.updated",
      payload: { id: "assistant", role: "assistant", text: "token" },
    },
    {
      type: "turn-item.updated",
      payload: { type: "assistant_message", text: "token" },
    },
    { type: "thread.visited", payload: { id: "work", updatedAt: "later" } },
    { type: "run.updated", payload: p.runs[0] },
  ])
    assert.equal(reduceWorkEvent(state, event), state);
});
test("queued work stays visible until a confirmed cancellation without offering controls", async () => {
  const state = decodeWorkProjection(p);
  await render(QueuedWork, { state });
  assert.equal(host.querySelectorAll('[data-queued-run]').length, 2);
  assert.equal(host.querySelectorAll('button').length, 0);
  assert.match(host.textContent, /First prompt/);
  await render(QueuedWork, { state: reduceWorkEvent(state, { type:'run.updated', payload:{...p.runs[1],status:'cancelled'} }) });
  assert.equal(host.querySelectorAll('[data-queued-run]').length, 1);
  assert.deepEqual(commands(), []);
});

test("ambiguous goal retry keeps original command identity", async () => {
  const state = decodeWorkProjection(projection({ providerThreads:[{id:'provider',driver:'codex',goal:{objective:'Read project',status:'active'}}] }));
  failDispatch = true;
  await render(GoalCard, { threadId:'work', state });
  await click('Pause');
  failDispatch = false;
  await click('Retry');
  assert.equal(commands().length, 2);
  assert.equal(commands()[0].commandId, commands()[1].commandId);
});

test("queued work preserves backend order and offers no reorder or promote controls", async () => {
  p = projection({runs:[run('active','running',0),...p.runs]});
  const state = decodeWorkProjection(p);
  await render(QueuedWork, {state});
  assert.deepEqual([...host.querySelectorAll('[data-queued-run]')].map(row=>row.dataset.queuedRun),['a','b']);
  for (const label of ['Move queued message down','Steer now','Up next']) assert.equal(button(label),undefined);
  assert.deepEqual(commands(),[]);
});

test("quiet queue retains message text and attachments without an edit control", async () => {
  const state = decodeWorkProjection(p), before = structuredClone(state);
  await render(QueuedWork,{state});
  assert.match(host.textContent,/First prompt/);
  assert.match(host.textContent,/keep.csv/);
  assert.equal(button('Edit'),undefined);
  assert.equal(host.querySelector('textarea'),null);
  assert.deepEqual(state,before);
  assert.deepEqual(commands(),[]);
});

test("held queues stay quiet and an empty queue renders nothing", async () => {
  await render(QueuedWork,{state:decodeWorkProjection(p)});
  assert.match(host.textContent,/2 queued messages/);
  assert.equal(host.querySelector('button'),null);
  assert.deepEqual(commands(),[]);
  await render(QueuedWork,{state:decodeWorkProjection(projection({runs:[]}))});
  assert.equal(host.textContent,'');
  assert.equal(host.querySelector('section'),null);
});

test("structured plan reaches the transcript as normal message content", async () => {
  const plan = decodePlan({
    id: "p",
    kind: "todo_list",
    status: "active",
    steps: [
      { id: "1", text: "Read", status: "completed" },
      { id: "2", text: "Build", status: "running" },
      { id: "3", text: "Future", status: "future" },
    ],
  });
  await render(PlanMessage, { plan });
  assert.match(host.textContent, /Read/);
  assert.match(host.textContent, /Build/);
  assert.match(host.textContent, /Future/);
  assert.doesNotMatch(host.textContent, /Plan progress|Proposed plan|View plan|1 of 3/);
  assert.ok(host.querySelector(".bubble"));
  const entries = buildEntries(
    [
      {
        id: "todo",
        type: "todo_list",
        planId: "p",
        steps: plan.steps,
        ordinal: 1,
      },
    ],
    {
      bot: { workspaceRoot: "/test" },
      botsByThread: new Map(),
      tasks: [],
      requests: {},
    },
  );
  assert.equal(entries[0].kind, "plan");
});
test("active provider wins; Claude only clears; goals dispatch a separate queued turn", async () => {
  const goal = {
    objective: "Small objective",
    status: "active",
    tokensUsed: 12,
    tokenBudget: 100,
    timeUsedSeconds: 62,
  };
  p = projection({
    runs: [run("active", "running")],
    providerThreads: [
      {
        id: "provider",
        providerInstanceId: "codex",
        driver: "claudeAgent",
        goal,
        updatedAt: "2026-01-01",
      },
      {
        id: "old",
        providerInstanceId: "codex",
        driver: "codex",
        goal: { ...goal, objective: "Old" },
        updatedAt: "2026-02-01",
      },
    ],
  });
  const state = decodeWorkProjection(p);
  assert.equal(currentGoal(state).goal.objective, "Small objective");
  assert.deepEqual(goalControls("claudeAgent", goal), ["clear"]);
  await render(GoalCard, { threadId: "work", state });
  assert.equal(button("Pause"), undefined);
  await click("Clear goal");
  const command = commands()[0];
  assert.equal(command.text, "/goal clear");
  assert.equal(command.deliveryIntent, "auto");
  assert.equal(command.dispatchMode.type, "queue_after_active");
  assert.equal(
    messageCommand("work", "/goal x", false).dispatchMode.type,
    "start_immediately",
  );
});
test("checkpoints and turn diffs render nothing and never read or restore workspace files", async () => {
  const state=decodeWorkProjection(projection({checkpoints:[{id:'cp',scopeId:'scope',appRunOrdinal:1,status:'ready',files:[{path:'earlier.txt',additions:2,deletions:0}]}]}));
  const before=structuredClone(state);
  await render(TaskChanges,{state});
  assert.equal(host.childElementCount,0);
  assert.deepEqual(calls,[]);
  assert.deepEqual(state,before);
});

const prLink = (number, snapshot = { state: "open" }) => ({ host: "github.com", repository: "test/example", number, url: `https://github.com/test/example/pull/${number}`, source: "manual", snapshot, watch: {} });
const withPRs = (prs, extra = {}) => decodeWorkProjection(projection({ thread: { ...p.thread, pullRequests: prs }, ...extra }));
const chips = () => [...host.querySelectorAll("a")].map((a) => a.textContent);
const settle = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });

test("PR chips map state, draft and checks to their label and tone", () => {
  const pr = (snapshot) => decodePR(prLink(7, snapshot));
  const cases = [
    [{ state: "merged" }, "PR #7 · Merged", "merged", ""],
    [{ state: "closed", checksState: "failing" }, "PR #7 · Closed", "closed", ""],
    [{ state: "open", checksState: "passing" }, "PR #7 · Open · Checks passing", "open", "passing"],
    [{ state: "open", checksState: "failing" }, "PR #7 · Open · Checks failing", "open", "failing"],
    [{ state: "open", checksState: "pending" }, "PR #7 · Open · Checks running", "open", "pending"],
    [{ state: "open" }, "PR #7 · Open", "open", ""],
    [{ state: "open", isDraft: true, checksState: "pending" }, "PR #7 · Draft · Checks running", "draft", "pending"],
    [{}, "PR #7", "unknown", ""],
  ];
  for (const [snapshot, label, tone, checks] of cases) assert.deepEqual(prStatus(pr(snapshot)), { label, tone, checks });
});

test("PR chips read live status on mount, keep the link and title, and refresh on focus", async () => {
  prDetail = { title: "Fix Safari forms", state: "open", isDraft: false };
  prChecks = { checks: [{ name: "ci", status: "success" }, { name: "lint", status: "pending" }] };
  await render(TaskChanges, { state: withPRs([prLink(4)]) });
  await settle();
  const link = host.querySelector("a");
  assert.equal(link.textContent, "PR #4 · Open · Checks running");
  assert.equal(link.href, "https://github.com/test/example/pull/4");
  assert.equal(link.title, "Fix Safari forms");
  assert.equal(link.dataset.prState, "open");
  assert.deepEqual(calls.map((c) => c.tag).sort(), ["pullRequests.checks", "pullRequests.detail"]);
  assert.deepEqual(calls[0].payload, { projectId: "project", host: "github.com", repository: "test/example", number: 4 });
  window.dispatchEvent(new Event("focus"));
  await settle();
  assert.equal(calls.length, 2, "focus inside the throttle window does not refetch");
});

test("PRs already merged or closed when the thread loads show no chip", async () => {
  // #2's snapshot is stale ("open") but T3 reports it merged: that is how Roka's chips looked stuck.
  prDetail = { state: "merged" };
  await render(TaskChanges, { state: withPRs([prLink(2), prLink(10, { state: "merged" }), prLink(11, { state: "closed" })]) });
  await settle();
  assert.deepEqual(chips(), []);
  assert.equal(host.querySelector("div")?.childElementCount ?? 0, 0);
});

test("a stale finished snapshot still reads T3, so a reopened PR keeps its chip", async () => {
  prDetail = { state: "open" };
  await render(TaskChanges, { state: withPRs([prLink(6, { state: "closed" })]) });
  await settle();
  assert.deepEqual(chips(), ["PR #6 · Open"]);
});

test("chips appear under StrictMode's effect replay without waiting for a focus", async () => {
  prDetail = { state: "open" };
  await act(async () => root.render(h(StrictMode, null, h(TaskChanges, { state: withPRs([prLink(8)]) }))));
  await settle();
  assert.deepEqual(chips(), ["PR #8 · Open"]);
});

test("a PR merged while open flips to Merged, then leaves at the next user message", async () => {
  prDetail = { state: "open" };
  const open = withPRs([prLink(4)]);
  await render(TaskChanges, { state: open });
  await settle();
  assert.deepEqual(chips(), ["PR #4 · Open"]);
  const merged = reduceWorkEvent(open, { type: "thread.pull-request-link-updated", payload: prLink(4, { state: "merged" }) });
  await render(TaskChanges, { state: merged });
  assert.deepEqual(chips(), ["PR #4 · Merged"]);
  assert.equal(host.querySelector("a").dataset.prState, "merged");
  await render(TaskChanges, { state: { ...merged } });
  assert.deepEqual(chips(), ["PR #4 · Merged"], "other updates keep the flipped chip");
  const next = reduceWorkEvent(merged, { type: "message.updated", payload: { id: "m-c", role: "user", text: "Thanks", attachments: [] } });
  await render(TaskChanges, { state: next });
  assert.deepEqual(chips(), []);
  assert.ok(!calls.some((c) => !c.tag.startsWith("pullRequests.")), "display only: nothing is unlinked in T3");
});

test("a PR closed while open leaves after an hour without a new message", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  prDetail = { state: "open" };
  const open = withPRs([prLink(5)]);
  await render(TaskChanges, { state: open });
  await settle();
  await render(TaskChanges, { state: reduceWorkEvent(open, { type: "thread.pull-request-link-updated", payload: prLink(5, { state: "closed" }) }) });
  assert.deepEqual(chips(), ["PR #5 · Closed"]);
  await act(async () => t.mock.timers.tick(PR_DONE_LINGER_MS - 1));
  assert.deepEqual(chips(), ["PR #5 · Closed"]);
  await act(async () => t.mock.timers.tick(1));
  assert.deepEqual(chips(), []);
});

test("subscription filters streaming deltas, reconciles children and releases stream", () => {
  const source = runtimeWork("unique-work");
  let updates = 0;
  const unsubscribe = source.subscribe(() => updates++);
  const stream = streams.at(-1);
  stream.callback({ kind: "snapshot", projection: p });
  const snapshot = source.getSnapshot();
  stream.callback({
    kind: "event",
    event: {
      type: "message.updated",
      payload: { id: "a", role: "assistant", text: "token" },
    },
  });
  assert.equal(source.getSnapshot(), snapshot);
  assert.equal(updates, 1);
  stream.callback({
    kind: "event",
    event: {
      type: "subagent.updated",
      payload: { id: "child", status: "running" },
    },
  });
  assert.equal(source.getSnapshot().background, true);
  stream.callback({
    kind: "event",
    event: {
      type: "subagent.updated",
      payload: { id: "child", status: "completed" },
    },
  });
  assert.equal(source.getSnapshot().background, false);
  unsubscribe();
  assert.equal(stream.cancelled, true);
});
test("real composer Stop sends thread.stop including delegated work", async () => {
  const bot = {
    slug: "lab",
    name: "Lab",
    mainThreadId: "work",
    workspaceRoot: "/generic/lab",
    color: "teal",
    shape: "blob",
    projectId: "project",
  };
  const active = {
    ...run("active", "running"),
    requestedAt: "2026-01-01T00:00:00Z",
    startedAt: null,
    completedAt: null,
    modelSelection: { instanceId: "codex", model: "example" },
  };
  useApp.setState({
    bots: { lab: bot },
    threadData: {
      work: {
        loaded: true,
        items: {},
        runs: { active },
        requests: {},
        subagents: {},
      },
    },
    threads: {
      work: {
        id: "work",
        status: "running",
        activeRunId: "active",
        latestRunId: "active",
        lineage: { parentThreadId: null },
        modelSelection: active.modelSelection,
      },
    },
    selected: "lab",
  });
  await render(Chat, { bot, threadId: "work" });
  await click("Stop");
  const command = commands().at(-1);
  assert.equal(command.type, "thread.stop");
  assert.equal(command.stopDelegatedTasks, true);
  assert.equal(command.runId, undefined);
});
test("diff refuses unavailable checkpoint before a network call", async () => {
  await assert.rejects(readWorkDiff("work", { status: "missing", turn: 1 }));
  assert.equal(calls.length, 0);
});

test("an explicit null checkpoint ordinal means thread start; an absent ordinal stays unavailable", () => {
  const state = decodeWorkProjection(
    projection({
      checkpoints: [
        {
          id: "start",
          scopeId: "scope",
          appRunOrdinal: null,
          status: "ready",
          files: [],
        },
        { id: "unknown-range", scopeId: "scope", status: "ready", files: [] },
      ],
    }),
  );
  assert.equal(state.checkpoints[0].turn, 0);
  assert.equal(state.checkpoints[1].turn, null);
});

test("child task stop uses authoritative subagent ID and preserves remote target and result", async () => {
  const bot = {
    slug: "lab",
    name: "Lab",
    mainThreadId: "work",
    color: "teal",
    shape: "blob",
  };
  const item = {
    id: "row",
    subagentId: "task",
    runId: "run",
    status: "running",
    title: "Read task",
    updatedAt: "2026-01-01",
    remoteChild: {
      environmentId: "remote-machine",
      threadId: "remote-child",
      label: "Remote",
    },
  };
  useApp.setState({ bots: { lab: bot } });
  await render(SubagentRow, { bot, parentThreadId: "work", item, card: true });
  assert.match(
    host.querySelector("a").href,
    /environmentId=remote-machine&threadId=remote-child/,
  );
  await click("Stop task");
  const command = commands()[0];
  assert.equal(command.type, "subagent.stop");
  assert.equal(command.subagentId, "task");
  assert.equal(command.runId, "run");
  await render(SubagentRow, {
    bot,
    parentThreadId: "work",
    item: {
      ...item,
      status: "completed",
      result: "Task finished",
      updatedAt: "2026-01-02",
    },
    card: true,
  });
  assert.equal(button("Stop task"), undefined);
  assert.match(host.textContent, /Task finished/);
});

test("projection-only child tasks appear once and keep their real ID", () => {
  const agent = {
    id: "task",
    runId: "run",
    status: "running",
    updatedAt: "2026-01-01",
    childThreadId: "child",
  };
  const items = supplementSubagents([], [agent], "work");
  assert.equal(items.length, 1);
  assert.equal(items[0].subagentId, "task");
  assert.equal(items[0].childThreadId, "child");
  assert.equal(supplementSubagents([], [agent], "work")[0], items[0]);
  assert.equal(supplementSubagents(items, [agent], "work").length, 1);
});

test("a partly loaded thread adds only child tasks from the runs it holds rows for", () => {
  const row = { id: "row", type: "assistant_message", runId: "run:thread:t:ordinal:214", ordinal: 1 };
  const runs = { "run:thread:t:ordinal:214": { ordinal: 214 } };
  assert.equal(loadedRunFloor([row], runs, false), null, "a complete thread has no floor");
  const floor = loadedRunFloor([row], runs, true);
  assert.equal(floor, 214);
  const old = { id: "old", runId: "run:thread:t:ordinal:198", status: "failed", updatedAt: "2026-01-01" };
  const recent = { id: "recent", runId: "run:thread:t:ordinal:216", status: "running", updatedAt: "2026-01-02" };
  const items = supplementSubagents([row], [old, recent], "t", floor);
  assert.deepEqual(items.map((item) => item.subagentId ?? item.id), ["row", "recent"]);
});

test("ambiguous Queue payload keeps both IDs and dispatch mode across reconstruction", () => {
  const first = messageCommand(
    "reload-test",
    "Keep the same queued prompt",
    true,
  );
  const replay = messageCommand(
    "reload-test",
    "Keep the same queued prompt",
    false,
  );
  assert.equal(replay.commandId, first.commandId);
  assert.equal(replay.messageId, first.messageId);
  assert.deepEqual(replay.dispatchMode, first.dispatchMode);
  const edited = messageCommand(
    "reload-test",
    "A deliberately edited prompt",
    false,
  );
  assert.notEqual(edited.commandId, first.commandId);
});

test("an older projection read cannot overwrite a newer stream event", async () => {
  const source = runtimeWork("read-race-test");
  const unsubscribe = source.subscribe(() => {});
  const stream = streams.at(-1);
  stream.callback({ kind: "snapshot", projection: p });
  let resolve;
  t3.call = () =>
    new Promise((done) => {
      resolve = done;
    });
  const reading = source.refresh();
  stream.callback({
    kind: "event",
    event: {
      type: "run.updated",
      payload: { ...p.runs[1], status: "cancelled" },
    },
  });
  resolve(p);
  await reading;
  assert.equal(
    source.getSnapshot().runs.find((run) => run.id === "a").status,
    "cancelled",
  );
  unsubscribe();
});

test("chat plan and task cards do not render again for identical Bot polling or shell updates", async () => {
  globalThis.package2ChildRenders = 0;
  globalThis.package2PlanRenders = 0;
  const bot = {
    slug: "quiet-lab",
    name: "Quiet lab",
    mainThreadId: "quiet-root",
    workspaceRoot: "/generic/lab",
    color: "teal",
    shape: "blob",
    projectId: "project",
  };
  const shell = {
    id: "quiet-root",
    title: "Quiet lab",
    status: "completed",
    modelSelection: { instanceId: "codex" },
    lineage: { parentThreadId: null },
    updatedAt: "2026-01-01",
    pendingRuntimeRequest: null,
  };
  const child = {
    ...shell,
    id: "quiet-child",
    title: "Task",
    lineage: { parentThreadId: "quiet-root" },
  };
  const plan = {
    id: "quiet-plan",
    planId: "plan",
    type: "todo_list",
    ordinal: 1,
    status: "active",
    steps: [{ id: "1", text: "Read project", status: "completed" }],
  };
  const task = {
    id: "quiet-task",
    subagentId: "task",
    type: "subagent",
    runId: "run",
    ordinal: 2,
    status: "completed",
    childThreadId: "quiet-child",
    updatedAt: "2026-01-01",
  };
  useApp.setState({
    bots: { "quiet-lab": bot },
    threads: { "quiet-root": shell, "quiet-child": child },
    threadData: {
      "quiet-root": {
        loaded: true,
        items: { plan, task },
        subagents: {},
        runs: {},
        requests: {},
      },
    },
  });
  await render(Chat, { bot, threadId: bot.mainThreadId });
  const counts = [
    globalThis.package2PlanRenders,
    globalThis.package2ChildRenders,
  ];
  assert.deepEqual(counts, [1, 1]);
  await act(async () =>
    useApp.setState({
      bots: { "quiet-lab": { ...bot } },
      threads: { "quiet-root": { ...shell }, "quiet-child": { ...child } },
    }),
  );
  await render(Chat, { bot: { ...bot }, threadId: bot.mainThreadId });
  assert.deepEqual(
    [globalThis.package2PlanRenders, globalThis.package2ChildRenders],
    counts,
  );
  await act(async () => {
    for (const stream of streams.filter(
      (stream) => stream.payload.threadId === bot.mainThreadId,
    ))
      stream.callback({
        kind: "event",
        event: {
          type: "plan.updated",
          payload: {
            id: "plan",
            kind: "todo_list",
            status: "active",
            steps: [{ id: "1", text: "Read project", status: "pending" }],
          },
        },
      });
  });
  assert.equal(host.querySelectorAll('[aria-label="Plan progress"]').length, 0);
  assert.equal([...host.querySelectorAll('.bubble')].filter(node=>node.textContent.includes('Read project')).length,1);
});

test('proposed plan text is visible without an extra View plan step',async()=>{
 await render(PlanMessage,{plan:decodePlan({id:'proposal',kind:'proposed_plan',markdown:'## A useful proposal\n\nKeep every detail.',status:'proposed'})});
 assert.match(host.textContent,/A useful proposal/);assert.match(host.textContent,/Keep every detail/);
 assert.equal(host.querySelector('details'),null);assert.equal(host.querySelector('section'),null);
});

test("a tidy routine reads as a preset and its report is a transcript line", () => {
  const bot = { slug: "tester", name: "Tester", projectId: "project-1", mainThreadId: "thread-main" };
  const task = { id: "task-1", title: "Tidy memory", enabled: true, projectId: "project-1", threadId: "thread-routine", schedule: { type: "fixed_time", timeOfDay: "03:30" }, runCount: 1, lastRunAt: "2026-11-16T10:09:10.000Z", lastRunStatus: "succeeded" };
  assert.equal(tidyState(task), "nightly");
  assert.equal(tidyState({ ...task, schedule: { ...task.schedule, weekdays: [1] } }), "weekly");
  assert.equal(tidyState({ ...task, enabled: false }), "off");
  assert.equal(findTidyTask(bot, [task])?.id, "task-1");
  const report = { id: "task-1", at: task.lastRunAt, title: "Tidy memory", summary: "Nothing changed.", threadId: "thread-routine", failed: false };
  const entries = buildEntries([{ id: "m1", type: "user_message", text: "hello", messageId: "m1", startedAt: "2026-11-16T10:10:00.000Z", ordinal: 1 }], { bot, botsByThread: new Map(), tasks: [], requests: {}, routineReports: [report] });
  const kinds = entries.map((entry) => entry.kind);
  assert.ok(kinds.includes("routine-report"));
  assert.ok(kinds.indexOf("routine-report") < kinds.indexOf("user"));
});
