import { automatedMessage, type AutomatedMessage } from "./automatedMessage";
import { REASONING_SELECT_DESCRIPTOR_IDS } from "./modelTraits";
import type { Bot, ModelSelection, Run, RuntimeRequest, ScheduledTask, TurnItem } from "./types";
import { botDelivery, shortToolName } from "./botMessages";
import { findRequest, questionAnswerMessageId } from "./runtimeRequests";
import { parseReply } from "./reply";

// Turns T3 turn items into chat entries: bubbles, cards and
// a few centered event lines. Raw tool activity stays hidden.

export type Entry =
  | { kind: "date"; id: string; label: string }
  | { kind: "user"; id: string; text: string; attachments: any[]; at: string; replyTo: string | null; runId: string | null }
  | { kind: "peer"; id: string; text: string; at: string; fromBot: Bot | null; fromName: string }
  | { kind: "bot"; id: string; text: string; at: string; streaming: boolean; attachments: any[]; runId: string | null }
  | { kind: "voice-call"; id: string; seconds: number; at: string }
  | { kind: "event"; id: string; icon?: "routine" | "memory" | "rename" | "send" | "task" | "stop" | "file" | "vault"; text: string; strong?: string; bot?: Bot | null }
  | { kind: "routine-report"; id: string; at: string; title: string; summary: string; threadId: string; failed: boolean }
  | { kind: "bot-event"; id: string; direction: "sent" | "received"; bots: Bot[]; runId: string | null }
  | { kind: "approval"; id: string; item: TurnItem; request?: RuntimeRequest }
  | { kind: "question"; id: string; item: TurnItem; request?: RuntimeRequest }
  | { kind: "secret"; id: string; item: TurnItem }
  | { kind: "subagent"; id: string; item: TurnItem }
  | { kind: "plan"; id: string; item: TurnItem }
  | { kind: "file"; id: string; path: string; item: TurnItem }
  | { kind: "image"; id: string; item: TurnItem; index: number }
  | { kind: "page"; id: string; attachmentId: string; title: string; heights: [number, number][]; height: number }
  | { kind: "error"; id: string; message: string }
  | { kind: "model-switch"; id: string; text: string }
  | { kind: "automated"; id: string; at: string; fromBot: Bot | null; message: AutomatedMessage };

type Ctx = {
  bot: Bot;
  botsByThread: Map<string, Bot>;
  tasks: ScheduledTask[];
  requests: Record<string, RuntimeRequest>;
  /** Vault login id → its site, for "Filling vault login for …" lines. */
  vaultSites?: Record<string, string>;
  voiceCalls?: { at: string; seconds: number }[];
  /** First message on a new model or effort → the divider above it. */
  modelSwitches?: Map<string, string>;
  /** A routine's last report, shown as a line in the Bot's chat without waking it. */
  routineReports?: { id: string; at: string; title: string; summary: string; threadId: string; failed: boolean }[];
};

const toolName = (i: TurnItem) => String(i.toolName ?? "");
const shortTool = shortToolName;

function parseInput(i: TurnItem): any {
  const v = i.input;
  if (typeof v === "string") {
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }
  return v ?? {};
}

function dayLabel(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const sameDay = d.toDateString() === now.toDateString();
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (sameDay) return `Today ${time}`;
  if (d.toDateString() === y.toDateString()) return `Yesterday ${time}`;
  const diff = (now.getTime() - d.getTime()) / 86400000;
  if (diff < 6) return `${d.toLocaleDateString([], { weekday: "long" })} ${time}`;
  return `${d.toLocaleDateString([], { month: "short", day: "numeric", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" })} ${time}`;
}

function relPath(fileName: string, root: string) {
  return fileName.startsWith(root) ? fileName.slice(root.length).replace(/^\/+/, "") : fileName.replace(/^\.\//, "");
}

const effortOf = (selection: ModelSelection) => selection.options?.find((option) => REASONING_SELECT_DESCRIPTOR_IDS.has(option.id))?.value;
const effortName = (value: unknown) => {
  const effort = String(value);
  return effort === "xhigh" ? "Extra high" : `${effort[0]?.toUpperCase() ?? ""}${effort.slice(1)}`;
};

/** Every run records its model, so this works on any T3 and for old conversations too. */
export function modelSwitches(runs: Run[], modelName: (selection: ModelSelection) => string) {
  const switches = new Map<string, string>();
  const ordered = runs.filter((run) => run.status !== "queued" && run.modelSelection && run.userMessageId).sort((a, b) => a.ordinal - b.ordinal);
  ordered.forEach((run, index) => {
    const before = ordered[index - 1]?.modelSelection, after = run.modelSelection;
    if (!before) return;
    const model = before.instanceId !== after.instanceId || before.model !== after.model;
    const from = effortOf(before), to = effortOf(after);
    const effort = from !== undefined && to !== undefined && from !== to;
    if (!model && !effort) return;
    const side = (selection: ModelSelection, level: unknown) => [model ? modelName(selection) : "", effort ? effortName(level) : ""].filter(Boolean).join(" ");
    switches.set(run.userMessageId!, `${side(before, from)} → ${side(after, to)}`);
  });
  return switches;
}

/**
 * Some agents (Antigravity) send the command under a name T3 doesn't read, so the approval's
 * prompt is only the tool's title ("Ran command"). The command item for the same native tool
 * call carries the command as `input`; show that instead.
 */
function withCommandText(approval: TurnItem, commandInputs: Map<string, { input: string; title: string | null } | null>): TurnItem {
  if (approval.requestKind !== "command" || approval.nativeItemRef?.driver !== "antigravity") return approval;
  const key = commandKey(approval);
  const tool = key ? commandInputs.get(key) : undefined;
  if (!tool || (approval.prompt && approval.prompt !== tool.title)) return approval;
  return { ...approval, prompt: tool.input };
}

/** One tool call: same run, same driver, same native id. A card the user approves must never borrow another call's command. */
function commandKey(item: TurnItem): string | null {
  const ref = item.nativeItemRef;
  return typeof ref?.nativeId === "string" && ref.nativeId ? JSON.stringify([item.runId ?? null, ref.driver ?? null, ref.nativeId]) : null;
}

export function buildEntries(items: TurnItem[], ctx: Ctx): Entry[] {
  const sorted = [...items].sort((a, b) => a.ordinal - b.ordinal || (a.startedAt ?? "").localeCompare(b.startedAt ?? ""));
  // null marks an ambiguous key (two command items for one call): such approvals keep their own text.
  const commandInputs = new Map<string, { input: string; title: string | null } | null>();
  for (const item of items) {
    const key = commandKey(item);
    if (item.type === "command_execution" && key && typeof item.input === "string" && item.input.trim()) {
      commandInputs.set(key, commandInputs.has(key) ? null : { input: item.input, title: item.title });
    }
  }
  // T3 can append the resumed message before the question's answer update.
  // Fold only messages whose answer card is actually present, in any order.
  const answeredMessages = new Set(items.flatMap((item) => {
    const id = questionAnswerMessageId(item);
    return id ? [id] : [];
  }));
  const out: Entry[] = [];
  let lastAt = 0;
  const memoryRuns = new Set<string>();
  const filesSeen = new Set<string>();
  const fillsSeen = new Set<string>();

  const stamp = (iso: string | null | undefined, id: string) => {
    if (!iso) return;
    const t = new Date(iso).getTime();
    if (t - lastAt > 45 * 60 * 1000) out.push({ kind: "date", id: `date-${id}`, label: dayLabel(iso) });
    lastAt = t;
  };

  for (const i of sorted) {
    switch (i.type) {
      case "user_message": {
        if (answeredMessages.has(i.messageId)) break;
        if (!i.text && !(i.attachments?.length > 0)) break;
        const at = i.startedAt ?? i.updatedAt;
        const switched = ctx.modelSwitches?.get(i.messageId);
        if (switched) out.push({ kind: "model-switch", id: `model-${i.id}`, text: switched });
        // T3 marks where a fresh session began (`/clear`, or a routine that starts fresh each run).
        if (i.freshContext === true) out.push({ kind: "model-switch", id: `fresh-${i.id}`, text: "New session" });
        if (i.scheduledTaskId) {
          const task = ctx.tasks.find((t) => t.id === i.scheduledTaskId);
          stamp(at, i.id);
          out.push({ kind: "event", id: i.id, icon: "routine", text: "Running routine", strong: task?.title ?? "Routine" });
          break;
        }
        const automated = automatedMessage(i);
        if (automated) {
          stamp(at, i.id);
          out.push({ kind: "automated", id: i.id, at, fromBot: [...ctx.botsByThread.values()].find((bot) => bot.name === automated.from) ?? null, message: automated });
          break;
        }
        const peer = i.senderThreadId ? ctx.botsByThread.get(i.senderThreadId) ?? null : null;
        const fromAgent = i.createdBy === "agent" || i.senderThreadId;
        if (fromAgent) {
          const m = /^From ([^:\n]{1,60}):\s*/.exec(i.text ?? "");
          const fromName = peer?.name ?? m?.[1] ?? "another Bot";
          stamp(at, i.id);
          if (peer) {
            const prev = out[out.length - 1];
            if (prev?.kind === "bot-event" && prev.direction === "received" && prev.runId === i.runId) {
              if (!prev.bots.some((b) => b.slug === peer.slug)) prev.bots.push(peer);
            } else out.push({ kind: "bot-event", id: `peer-h-${i.id}`, direction: "received", bots: [peer], runId: i.runId });
            break;
          }
          const prev = out[out.length - 1];
          if (!(prev?.kind === "peer" && prev.fromName === fromName)) out.push({ kind: "event", id: `peer-h-${i.id}`, icon: "send", text: "Message from", strong: fromName, bot: peer });
          out.push({ kind: "peer", id: i.id, text: m ? (i.text ?? "").slice(m[0].length) : i.text ?? "", at, fromBot: peer, fromName });
          break;
        }
        stamp(at, i.id);
        // T3 inlines attachment references as markdown images; the attachments render on their own.
        const { quote, text } = parseReply((i.text ?? "")
          .replace(/!\[[^\]]*\]\(t3-context:\/\/[^)]*\)/g, "")
          .replace(/^Ultrathink:\s*/i, "")
          .trim());
        out.push({ kind: "user", id: i.id, text, attachments: i.attachments ?? [], at, replyTo: quote, runId: i.runId });
        break;
      }
      case "assistant_message": {
        if (!i.text && !(i.attachments?.length > 0)) break;
        const at = i.startedAt ?? i.updatedAt;
        stamp(at, i.id);
        // Split on blank-line-separated "message breaks" the agent marks with a lone '---'? Keep one bubble per message.
        out.push({ kind: "bot", id: i.id, text: i.text ?? "", at, streaming: Boolean(i.streaming), attachments: i.attachments ?? [], runId: i.runId });
        break;
      }
      case "approval_request":
        out.push({ kind: "approval", id: i.id, item: withCommandText(i, commandInputs), request: findRequest(ctx.requests, i.requestId) });
        break;
      case "user_input_request":
        out.push({ kind: "question", id: i.id, item: i, request: findRequest(ctx.requests, i.requestId) });
        break;
      case "secret_request":
        out.push({ kind: "secret", id: i.id, item: i });
        break;
      case "subagent":
        out.push({ kind: "subagent", id: i.id, item: i });
        break;
      case "todo_list":
      case "proposed_plan":
        out.push({ kind: "plan", id: i.id, item: i });
        break;
      case "error":
        if (i.failure?.message) out.push({ kind: "error", id: i.id, message: i.failure.message });
        break;
      case "run_interrupt_result":
        out.push({ kind: "event", id: i.id, icon: "stop", text: "Stopped" });
        break;
      case "file_change": {
        if (i.status !== "completed") break;
        const p = relPath(String(i.fileName ?? ""), ctx.bot.workspaceRoot);
        // A Bot made from a project keeps its memory and library in .bot/.
        const own = ctx.bot.adopted ? ".bot/" : "";
        const other = /\/([a-z0-9][a-z0-9-]*)\/\.bot\/bot\.json$/.exec(String(i.fileName ?? ""));
        if (p !== ".bot/bot.json" && other && /createdBy/.test(String(i.newStr ?? i.diffStr ?? ""))) {
          const created = [...ctx.botsByThread.values()].find((b) => b.slug === other[1]) ?? null;
          const m = /"name"\s*:\s*"([^"]{1,80})"/.exec(String(i.newStr ?? i.diffStr ?? ""));
          out.push({ kind: "event", id: i.id, icon: "task", text: "Created", strong: created?.name ?? m?.[1] ?? other[1], bot: created });
          break;
        }
        if (p === ".bot/bot.json") {
          const m = /"name"\s*:\s*"([^"]{1,80})"/.exec(String(i.newStr ?? i.diffStr ?? ""));
          if (m) out.push({ kind: "event", id: i.id, icon: "rename", text: "Renamed to", strong: m[1] });
        } else if (p.startsWith(`${own}memory/`)) {
          const key = i.runId ?? i.id;
          if (memoryRuns.has(key)) break;
          memoryRuns.add(key);
          out.push({ kind: "event", id: i.id, icon: "memory", text: "Updated memory for", strong: ctx.bot.name, bot: ctx.bot });
        } else if (p.startsWith(`${own}library/`)) {
          const key = `${i.runId}:${p}`;
          if (filesSeen.has(key)) break;
          filesSeen.add(key);
          out.push({ kind: "file", id: i.id, path: p, item: i });
        }
        break;
      }
      case "dynamic_tool": {
        const name = shortTool(toolName(i));
        const input = parseInput(i);
        if (i.status === "failed") break;
        if (/vault_save_(login|contact)$/.test(name)) {
          const out_ = outputText(i);
          if (i.status !== "completed" || !/"saved"\s*:\s*true/.test(out_)) break;
          const strong = name.endsWith("contact") ? "contact info" : (/"title"\s*:\s*"([^"]{1,200})"/.exec(out_)?.[1] ?? /"site"\s*:\s*"([^"]{1,200})"/.exec(out_)?.[1] ?? "a login");
          out.push({ kind: "event", id: i.id, icon: "vault", text: "Saved to Vault", strong });
          break;
        }
        if (/vault_fill_(password|username)$/.test(name)) {
          const out_ = outputText(i);
          if (i.status === "completed" && !/"filled"\s*:\s*true/.test(out_)) break;
          const key = `${i.runId}:${input?.loginId}`;
          if (fillsSeen.has(key)) break;
          fillsSeen.add(key);
          const site = /"site"\s*:\s*"([^"]{1,200})"/.exec(out_)?.[1] ?? ctx.vaultSites?.[input?.loginId] ?? "a site";
          out.push({ kind: "event", id: i.id, icon: "vault", text: "Filling vault login for", strong: site });
          break;
        }
        if (name === "t3_project_update" && input?.title) {
          out.push({ kind: "event", id: i.id, icon: "rename", text: "Renamed to", strong: input.title });
        } else if (name === "schedule_task" && i.status === "completed") {
          out.push({ kind: "event", id: i.id, icon: "routine", text: "Created routine", strong: input?.title ?? input?.name ?? "routine" });
        } else if (name === "t3_thread_send") {
          const delivery = botDelivery(i);
          const target = delivery && ctx.botsByThread.get(delivery.recipientThreadId);
          if (target) {
            const prev = out[out.length - 1];
            if (prev?.kind === "bot-event" && prev.direction === "sent" && prev.runId === i.runId) {
              if (!prev.bots.some((b) => b.slug === target.slug)) prev.bots.push(target);
            } else out.push({ kind: "bot-event", id: i.id, direction: "sent", bots: [target], runId: i.runId });
          }
        } else if (name.endsWith("html_render") && i.status === "completed" && pageOf(i)) {
          const page = pageOf(i)!;
          out.push({ kind: "page", id: i.id, attachmentId: page.attachmentId, title: page.title ?? "", heights: page.heights ?? [], height: page.height ?? 480 });
        } else if (/^preview_(snapshot|screenshot)/.test(name) && i.status === "completed" && hasImage(i)) {
          out.push({ kind: "image", id: i.id, item: i, index: 0 });
        }
        break;
      }
      default:
        break;
    }
  }
  // A run that showed a page inline doesn't also need a card for the copy it saved to the Library.
  const pageRuns = new Set(out.flatMap((e) => (e.kind === "page" ? [items.find((i) => i.id === e.id)?.runId] : [])).filter(Boolean));
  const entries = out.filter((e) => !(e.kind === "file" && e.path.endsWith(".html") && pageRuns.has(e.item.runId)));
  for (const call of ctx.voiceCalls ?? []) {
    const next = entries.findIndex((e) => "at" in e && e.at > call.at);
    entries.splice(next < 0 ? entries.length : next, 0, { kind: "voice-call", id: `voice-${call.at}`, seconds: call.seconds, at: call.at });
  }
  for (const report of [...(ctx.routineReports ?? [])].sort((a, b) => a.at.localeCompare(b.at))) {
    const next = entries.findIndex((e) => "at" in e && e.at > report.at);
    entries.splice(next < 0 ? entries.length : next, 0, { kind: "routine-report", ...report, id: `routine-report:${report.id}` });
  }
  return entries;
}

/** A tool's output as text, whatever shape the runtime stored it in (escaped JSON included). */
function outputText(i: TurnItem): string {
  const o = i.output;
  if (o == null) return "";
  const s = typeof o === "string" ? o : JSON.stringify(o);
  return s.replace(/\\"/g, '"');
}

/** html_render stores the page as an attachment and reports its height at several widths. */
function pageOf(i: TurnItem): { attachmentId: string; title?: string; height?: number; heights?: [number, number][] } | null {
  let out = i.output;
  if (typeof out === "string") {
    try {
      out = JSON.parse(out);
    } catch {
      return null;
    }
  }
  const page = out?.htmlRender;
  return page && typeof page.attachmentId === "string" ? page : null;
}

function hasImage(i: TurnItem) {
  return Boolean(i.viewedImagePath) || (Array.isArray(i.outputImages) && i.outputImages.length > 0) || /"image"/.test(JSON.stringify(i.output ?? "").slice(0, 2000));
}

// ---------- working status ----------
const THINKING = ["Thinking it through", "Mulling it over", "Putting it together"];
const GENERIC = ["Working on it", "Making progress", "Chipping away", "Getting it done"];
const PHRASES: [RegExp, string[]][] = [
  [/^preview_|browser|computer/, ["Working on your computer", "Clicking around", "Clicking through pages"]],
  [/web_search|web_fetch|search/, ["Searching the web", "Digging around"]],
  [/schedule_task|scheduled_task/, ["Setting up a routine"]],
  [/delegate_task|t3_thread_launch|t3_thread_send|task_status/, ["Checking with another Bot"]],
  [/request_secret/, ["Needs your input"]],
  [/vault_save/, ["Saving to your Vault"]],
  [/vault_fill/, ["Signing in"]],
  [/^executor|mcp/, ["Working in a connected app"]],
  [/read|file/, ["Reading the file", "Doing some reading"]],
];

/** Candidate phrases for the live activity line; the chat rotates through them. */
export function workingPhrases(items: TurnItem[], runId: string | null): string[] {
  if (!runId) return THINKING;
  const active = items.filter((i) => i.runId === runId).sort((a, b) => b.ordinal - a.ordinal);
  const latest = active.find((i) => i.status === "running" || i.status === "inProgress" || i.status === "waiting") ?? active[0];
  if (!latest) return THINKING;
  switch (latest.type) {
    case "reasoning":
      return THINKING;
    case "command_execution":
      return latest.title === "Workspace ready" ? ["Getting ready"] : ["Running a few commands", "Waiting on results"];
    case "file_change":
      return /\.(ts|tsx|js|py|go|rs|sh|mjs)$/.test(String(latest.fileName ?? "")) ? ["Writing some code"] : ["Jotting it down"];
    case "web_search":
      return ["Searching the web", "Digging around"];
    case "file_search":
      return ["Doing some reading", "Digging around"];
    case "subagent":
      return ["Checking with another Bot", ...GENERIC];
    case "assistant_message":
      return THINKING;
    case "dynamic_tool": {
      const fullName = toolName(latest);
      if (/(?:^|[._-])executor(?:$|[._-])/.test(fullName)) return ["Working in a connected app"];
      const n = shortTool(fullName);
      return PHRASES.find(([re]) => re.test(n))?.[1] ?? GENERIC;
    }
    default:
      return GENERIC;
  }
}

export function isActiveRun(run: Run | undefined) {
  return Boolean(run && ["preparing", "queued", "starting", "running", "waiting"].includes(run.status));
}
