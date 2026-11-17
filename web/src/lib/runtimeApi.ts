import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { automatedMessage } from "./automatedMessage";
import { t3, uuid, type StreamHandle } from "./t3";

// The v0.1.5 projection is returned directly by RPC, wrapped by the stream.
// Decode only fields used here; do not opt into compact/deduplicated bodies.
export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}
const rows = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown): string =>
  typeof value === "string" ? value : "";
const number = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
export type WorkRun = {
  id: string;
  status: string;
  ordinal: number;
  queuePosition: number | null;
  queueHeld: boolean;
  userMessageId: string;
};
export type WorkMessage = {
  id: string;
  text: string;
  attachments: { name: string }[];
  createdBy?: string;
  creationSource?: string;
  scheduledTaskId?: string;
  senderThreadId?: string;
};
export type PlanStep = { id: string; text: string; status: string };
export type WorkPlan = {
  id: string;
  status: string;
  detailInTurnItem?: boolean;
} & (
  | { kind: "todo_list"; steps: PlanStep[]; explanation: string }
  | { kind: "proposed_plan"; markdown: string }
);
export type WorkGoal = {
  objective: string;
  status: string;
  tokensUsed: number | null;
  tokenBudget: number | null;
  timeUsedSeconds: number | null;
};
export type Checkpoint = {
  id: string;
  scopeId: string;
  status: string;
  turn: number | null;
  files: { path: string; additions: number; deletions: number }[];
};
export type WorkPR = {
  host: string;
  repository: string;
  number: number;
  url: string;
  title: string;
  state: string;
  draft: boolean;
  checks: string;
  review: string;
  watching: boolean;
  layers: { number: number; state: string; branch: string }[];
};
type GoalSource = {
  id: string;
  instance: string;
  driver: string;
  updatedAt: string;
  goal: WorkGoal | null;
  background: boolean;
};
export type WorkState = {
  loaded: boolean;
  error: boolean;
  runs: WorkRun[];
  messages: WorkMessage[];
  plans: WorkPlan[];
  checkpoints: Checkpoint[];
  goals: GoalSource[];
  instance: string;
  activeProviderThreadId: string;
  projectId: string;
  pullRequests: WorkPR[];
  rollbackFailure: string | null;
  background: boolean;
  children: { id: string; status: string }[];
};
export const emptyWorkState = (): WorkState => ({
  loaded: false,
  error: false,
  runs: [],
  messages: [],
  plans: [],
  checkpoints: [],
  goals: [],
  instance: "",
  activeProviderThreadId: "",
  projectId: "",
  pullRequests: [],
  rollbackFailure: null,
  background: false,
  children: [],
});
export function decodePlan(value: unknown): WorkPlan | null {
  const r = record(value),
    id = text(r.planId) || text(r.id),
    kind = r.kind ?? r.type;
  if (!id) return null;
  const base = {
    id,
    status: text(r.status) || "unknown",
    detailInTurnItem: r.detailInTurnItem === true,
  };
  if (kind === "proposed_plan" && typeof r.markdown === "string")
    return { ...base, kind, markdown: r.markdown };
  if (kind === "todo_list" && Array.isArray(r.steps))
    return {
      ...base,
      kind,
      explanation: text(r.explanation),
      steps: r.steps.flatMap((value) => {
        const s = record(value);
        return typeof s.id === "string" &&
          typeof s.text === "string" &&
          typeof s.status === "string"
          ? [{ id: s.id, text: s.text, status: s.status }]
          : [];
      }),
    };
  return null;
}
function decodeRun(value: unknown): WorkRun | null {
  const r = record(value);
  return typeof r.id === "string" && typeof r.status === "string"
    ? {
        id: r.id,
        status: r.status,
        ordinal: number(r.ordinal) ?? 0,
        queuePosition: number(r.queuePosition),
        queueHeld: r.queueHeld === true,
        userMessageId: text(r.userMessageId),
      }
    : null;
}
function decodeMessage(value: unknown): WorkMessage | null {
  const r = record(value);
  return typeof r.id === "string"
    ? {
        id: r.id,
        text: text(r.text),
        attachments: rows(r.attachments).map((a) => ({
          name: text(record(a).name) || "Attachment",
        })),
        createdBy: text(r.createdBy) || undefined,
        creationSource: text(r.creationSource) || undefined,
        scheduledTaskId: text(r.scheduledTaskId) || undefined,
        senderThreadId: text(r.senderThreadId) || undefined,
      }
    : null;
}
function decodeCheckpoint(value: unknown): Checkpoint | null {
  const r = record(value);
  if (typeof r.id !== "string" || typeof r.scopeId !== "string") return null;
  return {
    id: r.id,
    scopeId: r.scopeId,
    status: text(r.status),
    // v0.1.5 uses explicit null for the thread-start checkpoint (turn zero).
    // A missing field is different: that server has not supplied the range.
    turn: r.appRunOrdinal === null ? 0 : number(r.appRunOrdinal),
    files: rows(r.files).flatMap((value) => {
      const f = record(value);
      return typeof f.path === "string"
        ? [
            {
              path: f.path,
              additions: number(f.additions) ?? 0,
              deletions: number(f.deletions) ?? 0,
            },
          ]
        : [];
    }),
  };
}
function decodeGoalSource(value: unknown): GoalSource | null {
  const r = record(value),
    g = record(r.goal);
  if (typeof r.id !== "string") return null;
  const goal =
    typeof g.objective === "string" && typeof g.status === "string"
      ? {
          objective: g.objective,
          status: g.status,
          tokensUsed: number(g.tokensUsed),
          tokenBudget: number(g.tokenBudget),
          timeUsedSeconds: number(g.timeUsedSeconds),
        }
      : null;
  return {
    id: r.id,
    driver: text(r.driver),
    instance: text(r.providerInstanceId),
    updatedAt: text(r.updatedAt),
    goal,
    background: rows(r.pendingBackgroundTasks).length > 0,
  };
}
export function decodePR(value: unknown): WorkPR | null {
  const r = record(value),
    s = record(r.snapshot),
    stack = record(r.stack),
    n = number(r.number);
  if (
    typeof r.host !== "string" ||
    typeof r.repository !== "string" ||
    !n ||
    typeof r.url !== "string" ||
    !/^https?:\/\//.test(r.url) ||
    r.source === "stack-dismissed"
  )
    return null;
  return {
    host: r.host,
    repository: r.repository,
    number: n,
    url: r.url,
    title: text(s.title),
    state: text(s.state) || "unknown",
    draft: s.isDraft === true,
    checks: text(s.checksState),
    review: text(s.reviewDecision),
    watching: r.watch != null,
    layers: rows(stack.layers).flatMap((value) => {
      const layer = record(value),
        num = number(layer.number);
      return num
        ? [
            {
              number: num,
              state: text(layer.state) || "unknown",
              branch: text(layer.headBranch),
            },
          ]
        : [];
    }),
  };
}
function decoded<T>(value: unknown, parse: (value: unknown) => T | null): T[] {
  return rows(value).flatMap((v) => {
    const parsed = parse(v);
    return parsed === null ? [] : [parsed];
  });
}
export function decodeWorkProjection(value: unknown): WorkState {
  const p = record(value),
    thread = record(p.thread);
  if (typeof thread.id !== "string" || !Array.isArray(p.runs))
    throw new Error("Conversation work unavailable");
  const itemPlans = rows(p.turnItems).flatMap((item) => {
    const plan = decodePlan(item);
    return plan ? [plan] : [];
  });
  const plans = decoded(p.plans, decodePlan).map((plan) =>
    record(rows(p.plans).find((value) => record(value).id === plan.id))
      .detailInTurnItem === true
      ? (itemPlans.find((item) => item.id === plan.id) ?? plan)
      : plan,
  );
  const children = decoded(p.subagents, decodeChild),
    goals = decoded(p.providerThreads, decodeGoalSource);
  return {
    loaded: true,
    error: false,
    runs: decoded(p.runs, decodeRun),
    messages: decoded(
      rows(p.messages).filter((value) => record(value).role === "user"),
      decodeMessage,
    ),
    plans,
    checkpoints: decoded(p.checkpoints, decodeCheckpoint),
    goals,
    instance: text(record(thread.modelSelection).instanceId),
    activeProviderThreadId: text(thread.activeProviderThreadId),
    projectId: text(thread.projectId),
    pullRequests: decoded(thread.pullRequests, decodePR),
    rollbackFailure: text(record(thread.rollbackFailure).requestId) || null,
    background:
      children.some((child) => childActive(child.status)) ||
      goals.some((source) => source.background),
    children,
  };
}
const childActive = (status: string) =>
  ["pending", "running", "waiting"].includes(status);
function decodeChild(value: unknown) {
  const r = record(value);
  return typeof r.id === "string" && typeof r.status === "string"
    ? { id: r.id, status: r.status }
    : null;
}
function replace<T extends { id: string }>(values: T[], next: T | null): T[] {
  if (!next) return values;
  const current = values.find((value) => value.id === next.id);
  if (JSON.stringify(current) === JSON.stringify(next)) return values;
  return current
    ? values.map((value) => (value.id === next.id ? next : value))
    : [...values, next];
}
/** Unrelated text/tool deltas keep the identical snapshot and do not render cards. */
export function reduceWorkEvent(state: WorkState, value: unknown): WorkState {
  const event = record(value),
    p = record(event.payload);
  let patch: Partial<WorkState> = {};
  switch (event.type) {
    case "run.created":
    case "run.updated":
      patch = { runs: replace(state.runs, decodeRun(p)) };
      break;
    case "message.updated": {
      // Only queued prompts belong to these cards; assistant streaming is ignored.
      if (p.role !== "user") return state;
      patch = { messages: replace(state.messages, decodeMessage(p)) };
      break;
    }
    case "plan.updated":
      patch = { plans: replace(state.plans, decodePlan(p)) };
      break;
    case "checkpoint.captured":
      patch = { checkpoints: replace(state.checkpoints, decodeCheckpoint(p)) };
      break;
    case "provider-thread.updated": {
      const next = decodeGoalSource(p),
        previous = state.goals.find((source) => source.id === next?.id);
      const goals =
        previous &&
        next &&
        JSON.stringify({ ...previous, updatedAt: "" }) ===
          JSON.stringify({ ...next, updatedAt: "" })
          ? state.goals
          : replace(state.goals, next);
      patch = {
        goals,
        background:
          state.children.some((child) => childActive(child.status)) ||
          goals.some((source) => source.background),
      };
      break;
    }
    case "subagent.updated": {
      const children = replace(state.children, decodeChild(p));
      patch = {
        children,
        background:
          children.some((child) => childActive(child.status)) ||
          state.goals.some((source) => source.background),
      };
      break;
    }
    case "thread.pull-request-link-updated": {
      const pr = decodePR(p);
      const previous = state.pullRequests.filter(
        (pr) =>
          !(
            pr.host === p.host &&
            pr.repository === p.repository &&
            pr.number === p.number
          ),
      );
      patch = { pullRequests: pr ? [...previous, pr] : previous };
      break;
    }
    default:
      if (
        typeof event.type === "string" &&
        event.type.startsWith("thread.") &&
        typeof p.id === "string"
      ) {
        if ("pullRequests" in p)
          patch.pullRequests = decoded(p.pullRequests, decodePR);
        if ("modelSelection" in p)
          patch.instance = text(record(p.modelSelection).instanceId);
        if ("activeProviderThreadId" in p)
          patch.activeProviderThreadId = text(p.activeProviderThreadId);
        if ("rollbackFailure" in p)
          patch.rollbackFailure =
            text(record(p.rollbackFailure).requestId) || null;
      } else return state;
  }
  return Object.entries(patch).every(
    ([key, value]) =>
      JSON.stringify(record(state)[key]) === JSON.stringify(value),
  )
    ? state
    : { ...state, ...patch };
}
export function queuedWork(state: WorkState) {
  return state.runs
    .filter((run) => run.status === "queued")
    .sort(
      (a, b) =>
        (a.queuePosition ?? Infinity) - (b.queuePosition ?? Infinity) ||
        a.ordinal - b.ordinal,
    )
    .map((run) => ({
      run,
      message:
        state.messages.find((message) => message.id === run.userMessageId) ??
        null,
    }));
}
export type QueuedSender = { kind: "routine" | "agent" | "server"; label: string; text: string };
/** Null for your own messages. Anything else folds to one line naming where it came from. */
export function queuedSender(
  message: WorkMessage | null,
  names: { routine: (id: string) => string | undefined; thread: (id: string) => string | undefined },
): QueuedSender | null {
  if (!message) return null;
  if (message.scheduledTaskId)
    return { kind: "routine", label: names.routine(message.scheduledTaskId) ?? "Routine", text: message.text };
  const automated = automatedMessage(message);
  if (automated) return { kind: "agent", label: automated.from, text: automated.text };
  if (message.senderThreadId || (message.createdBy === "agent" && message.creationSource !== "server")) {
    const prefix = /^From ([^:\n]{1,60}):\s*/.exec(message.text);
    const named = message.senderThreadId ? names.thread(message.senderThreadId) : undefined;
    return { kind: "agent", label: named ?? prefix?.[1] ?? "Another thread", text: prefix ? message.text.slice(prefix[0].length) : message.text };
  }
  return message.createdBy === "agent" ? { kind: "server", label: "T3 Code", text: message.text } : null;
}
export const activeWork = (state: WorkState) =>
  state.runs.findLast((run) =>
    ["preparing", "starting", "running", "waiting"].includes(run.status),
  );
export function checkpointReverted(
  state: WorkState,
  checkpoint: Checkpoint,
): boolean {
  const turn = checkpoint.turn;
  if (turn === null || state.rollbackFailure !== null) return false;
  const later = state.runs.filter(
    (run) => run.ordinal > turn && run.status !== "queued",
  );
  return later.length > 0 && later.every((run) => run.status === "rolled_back");
}
export function currentGoal(state: WorkState) {
  return (
    state.goals.find((source) => source.id === state.activeProviderThreadId) ??
    state.goals
      .filter((source) => source.instance === state.instance)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ??
    null
  );
}
export function goalControls(driver: string, goal: WorkGoal | null) {
  if (!goal || !["codex", "claudeAgent"].includes(driver)) return [];
  return driver === "codex"
    ? [
        ...(goal.status === "complete"
          ? []
          : [goal.status === "paused" ? "resume" : "pause"]),
        "clear",
      ]
    : ["clear"];
}

class RuntimeWork {
  private state = emptyWorkState();
  private listeners = new Set<() => void>();
  private stream: StreamHandle | null = null;
  private reconnect: (() => void) | null = null;
  private generation = 0;
  private revision = 0;
  constructor(readonly threadId: string) {}
  getSnapshot = () => this.state;
  private update(state: WorkState) {
    if (state === this.state) return;
    this.revision++;
    this.state = state;
    this.listeners.forEach((fn) => fn());
  }
  refresh = async () => {
    const generation = this.generation;
    const revision = this.revision;
    const projection = await t3.call<unknown>(
      "orchestration.getThreadProjection",
      { threadId: this.threadId },
    );
    if (generation === this.generation && revision === this.revision)
      this.update(decodeWorkProjection(projection));
  };
  private open = () => {
    this.stream?.cancel();
    const generation = ++this.generation;
    this.stream = t3.stream(
      "orchestration.subscribeThread",
      { threadId: this.threadId, requestCompletionMarker: true, acceptBoundedSnapshot: true },
      (value: unknown) => {
        if (generation !== this.generation) return;
        const r = record(value);
        try {
          if (r.kind === "snapshot")
            this.update(decodeWorkProjection(r.projection));
          else if (r.kind === "event")
            this.update(reduceWorkEvent(this.state, r.event));
        } catch {
          this.update({ ...this.state, error: true });
        }
      },
    );
    void this.stream.done.catch(() => {
      if (generation === this.generation)
        this.update({ ...this.state, error: true });
    });
  };
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) {
      // A stream already sent on the new socket (queued before it opened) is live; don't open it twice.
      this.reconnect = t3.onReconnect(() => { if (!this.stream?.live()) this.open(); });
      this.open();
    }
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) {
        ++this.generation;
        this.stream?.cancel();
        this.stream = null;
        this.reconnect?.();
        this.reconnect = null;
      }
    };
  };
}
const work = new Map<string, RuntimeWork>();
export function runtimeWork(threadId: string) {
  let value = work.get(threadId);
  if (!value) {
    value = new RuntimeWork(threadId);
    work.set(threadId, value);
  }
  return value;
}
export function useRuntimeWork(threadId: string) {
  const source = useMemo(() => runtimeWork(threadId), [threadId]);
  return useSyncExternalStore(
    source.subscribe,
    source.getSnapshot,
    source.getSnapshot,
  );
}
export function useRuntimePlan(threadId: string, planId: string) {
  const source = useMemo(() => runtimeWork(threadId), [threadId]);
  const getPlan = useCallback(
    () => source.getSnapshot().plans.find((plan) => plan.id === planId),
    [source, planId],
  );
  return useSyncExternalStore(source.subscribe, getPlan, getPlan);
}
export type WorkAttachment = {
  type: "image" | "file";
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
};
export type WorkCommand = { threadId: string; commandId?: string } & (
  | { type: "thread.stop"; stopDelegatedTasks: true }
  | { type: "subagent.stop"; runId: string; subagentId: string }
  | { type: "queue.resume" }
  | { type: "queued-run.cancel" | "queued-run.start"; runId: string }
  | { type: "queued-run.edit"; runId: string; text: string }
  | { type: "queued-run.reorder"; runId: string; beforeRunId: string | null }
  | {
      type: "queued-message.promote-to-steer";
      queuedRunId: string;
      targetRunId: string;
    }
  | {
      type: "checkpoint.rollback";
      scopeId: string;
      checkpointId: string;
      restoreFiles: boolean;
    }
  | {
      type: "message.dispatch";
      messageId: string;
      text: string;
      attachments: WorkAttachment[];
      createdBy: "user";
      creationSource: "web";
      deliveryIntent: "auto";
      dispatchMode: { type: "queue_after_active" | "start_immediately" };
    }
);
/** Retains command identity after ambiguous errors. A receipt never hides a card. */
export function useWorkCommand(version: string) {
  const [state, setState] = useState<
    "idle" | "sending" | "submitted" | "error"
  >("idle");
  const pending = useRef<{
    command: WorkCommand;
    commandId: string;
    sending: boolean;
    onAccepted?: () => void;
  } | null>(null);
  useEffect(() => {
    pending.current = null;
    setState("idle");
  }, [version]);
  const send = async (
    command: WorkCommand,
    onAccepted?: () => void,
  ): Promise<boolean> => {
    if (pending.current?.sending || state === "submitted") return false;
    const request = pending.current ?? {
      command,
      commandId:
        typeof command.commandId === "string" ? command.commandId : uuid(),
      sending: false,
      onAccepted,
    };
    pending.current = request;
    request.sending = true;
    setState("sending");
    try {
      await t3.dispatch({ ...request.command, commandId: request.commandId }, { timeoutMs: 30_000 });
      acknowledgeMessage(request.command);
      if (pending.current === request) setState("submitted");
      request.onAccepted?.();
      // Stream remains authoritative; a direct read also catches events received before ACK.
      try {
        await runtimeWork(command.threadId).refresh();
      } catch {
        /* Keep waiting for the authoritative stream. */
      }
      return true;
    } catch {
      if (pending.current === request) setState("error");
      return false;
    } finally {
      request.sending = false;
    }
  };
  return {
    state,
    send,
    disabled: state === "sending" || state === "submitted",
    retry: () => {
      const request = pending.current;
      if (request) void send(request.command);
    },
  };
}
export function messageCommand(
  threadId: string,
  text: string,
  active: boolean,
  extra: { attachments?: WorkAttachment[] } = {},
): WorkCommand {
  const payload = { text, extra };
  let messageId = uuid();
  let mode: "queue_after_active" | "start_immediately" = active
    ? "queue_after_active"
    : "start_immediately";
  // A reload after an ambiguous Queue/goal send must replay the same receipt.
  // This is tab-scoped metadata, like the existing composer draft, never a token.
  try {
    const saved = record(
      JSON.parse(window.sessionStorage.getItem(messageKey(threadId)) ?? "null"),
    );
    if (
      saved.signature === JSON.stringify(payload) &&
      typeof saved.messageId === "string" &&
      (saved.mode === "queue_after_active" ||
        saved.mode === "start_immediately")
    ) {
      messageId = saved.messageId;
      mode = saved.mode;
    }
    window.sessionStorage.setItem(
      messageKey(threadId),
      JSON.stringify({ signature: JSON.stringify(payload), messageId, mode }),
    );
  } catch {
    /* Private browsing may disable storage; in-memory retries still retain IDs. */
  }
  return {
    type: "message.dispatch",
    threadId,
    messageId,
    commandId: messageId,
    text,
    attachments: [],
    createdBy: "user",
    creationSource: "web",
    deliveryIntent: "auto",
    dispatchMode: { type: mode },
    ...extra,
  };
}
const messageKey = (threadId: string) => `bot.workMessage.${threadId}`;
function acknowledgeMessage(command: WorkCommand) {
  if (command.type !== "message.dispatch") return;
  try {
    const saved = record(
      JSON.parse(
        window.sessionStorage.getItem(messageKey(command.threadId)) ?? "null",
      ),
    );
    if (saved.messageId === command.messageId)
      window.sessionStorage.removeItem(messageKey(command.threadId));
  } catch {
    /* Storage is optional; a confirmed message remains confirmed. */
  }
}
export async function readWorkDiff(
  threadId: string,
  checkpoint: Checkpoint,
  full = false,
): Promise<string> {
  if (checkpoint.status !== "ready" || checkpoint.turn === null)
    throw new Error("Checkpoint files unavailable");
  const toTurnCount = checkpoint.turn;
  const result = record(
    await t3.call<unknown>(
      full ? "orchestration.getFullThreadDiff" : "orchestration.getTurnDiff",
      {
        threadId,
        toTurnCount,
        ...(!full ? { fromTurnCount: Math.max(0, toTurnCount - 1) } : {}),
      },
    ),
  );
  if (typeof result.diff !== "string") throw new Error("Changes unavailable");
  return result.diff;
}
export async function readRollbackFiles(
  threadId: string,
  checkpoint: Checkpoint,
  toTurnCount: number,
): Promise<string[]> {
  if (checkpoint.turn === null) throw new Error("Checkpoint range unavailable");
  const result = record(
    await t3.call<unknown>("orchestration.getTurnDiff", {
      threadId,
      fromTurnCount: checkpoint.turn,
      toTurnCount,
    }),
  );
  if (typeof result.diff !== "string")
    throw new Error("Checkpoint preview unavailable");
  const headers = result.diff
    .split("\n")
    .filter((line) => line.startsWith("diff --git "));
  const paths = Array.from(
    result.diff.matchAll(/^diff --git a\/(.*?) b\/(.*)$/gm),
    (match) => match[2],
  );
  if (headers.length !== paths.length || (result.diff.trim() && !paths.length))
    throw new Error("Checkpoint paths unavailable");
  return [...new Set(paths)];
}
export async function readPR(projectId: string, pr: WorkPR): Promise<WorkPR> {
  const reference = {
    projectId,
    host: pr.host,
    repository: pr.repository,
    number: pr.number,
  };
  const [detail, checks] = await Promise.all([
    t3.call<unknown>("pullRequests.detail", reference),
    t3.call<unknown>("pullRequests.checks", reference),
  ]);
  const d = record(detail),
    statuses = new Set(
      rows(record(checks).checks).map((check) => text(record(check).status)),
    );
  // Same rollup as T3 Code's checksState; no reported checks stays unknown.
  return {
    ...pr,
    title: text(d.title) || pr.title,
    state: text(d.state) || pr.state,
    draft: typeof d.isDraft === "boolean" ? d.isDraft : pr.draft,
    checks:
      statuses.has("failure") || statuses.has("cancelled")
        ? "failing"
        : statuses.has("pending") || statuses.has("action-required")
          ? "pending"
          : statuses.has("success")
            ? "passing"
            : "",
  };
}
/** Merged or closed: nothing left to wait on. */
export const prDone = (pr: WorkPR) => /^(merged|closed)$/i.test(pr.state);
export type PRTone = "merged" | "open" | "draft" | "closed" | "unknown";
const PR_STATES: Record<string, [string, PRTone]> = {
  merged: ["Merged", "merged"],
  closed: ["Closed", "closed"],
  open: ["Open", "open"],
};
const PR_CHECKS: Record<string, string> = {
  passing: "Checks passing",
  failing: "Checks failing",
  pending: "Checks running",
};
/** What a PR chip says: "PR #11 · Merged", "PR #4 · Open · Checks failing". */
export function prStatus(pr: WorkPR): {
  label: string;
  tone: PRTone;
  checks: string;
} {
  const known = PR_STATES[pr.state.toLowerCase()];
  const [state, tone]: [string, PRTone] =
    known?.[1] === "open" && pr.draft ? ["Draft", "draft"] : (known ?? ["", "unknown"]);
  const checks =
    tone === "open" || tone === "draft" ? PR_CHECKS[pr.checks.toLowerCase()] ?? "" : "";
  return {
    label: [`PR #${pr.number}`, state, checks].filter(Boolean).join(" · "),
    tone,
    checks: checks ? pr.checks.toLowerCase() : "",
  };
}
