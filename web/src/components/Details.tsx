import { useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { ArrowLeft, Brain, ChevronsRight, ChevronLeft, ChevronRight, CircleUser, Clock, FileText, Folder, Library as LibraryIcon, Monitor, Play, Plus, Trash2 } from "lucide-react";
import { ModelPicker } from "./ModelPicker";
import { CodingWorkRows } from "./MachinesPane";
import { t3 } from "../lib/t3";
import { Avatar } from "./Avatar";
import { Library } from "./Library";
import { MemoryTab } from "./Memory";
import { InstructionsTab } from "./Instructions";
import { ThreadFamily } from "./ThreadFamily";
import { SideChatList } from "./SideChat";
import { subagentStatus, threadIdentity } from "../lib/threadFamily";
import { AvatarEditorDialog } from "./AvatarEditor";
import { IconButton, Pill, Switch } from "./ui";
import { botStatus, conversationStatus, openDialog, selectThread, setDetailsOpen, toast, updateBot, useApp, setBotModel } from "../store";
import { sharedObjects } from "../lib/objectAvatars";
import { useAvatarDrawing } from "./useAvatarDrawing";
import { ComputerScreen, useBotTabs } from "./Computer";
import type { Bot, ModelSelection, ScheduledTask } from "../lib/types";

import { chatDraft } from "../lib/chatDrafts";
import { enablePushNotifications } from "../lib/push";
import { formatTokens, readBotUsage, totalIn } from "../lib/usageApi";
import "./routines.css";
import { changeRoutineEnabled, changeRoutineFreshSession, copyWebhookUrl, displayTimezone, removeRoutine, routineDate, routineHistory, scheduleText, testRoutine, threadMode } from "../lib/routines";
export { scheduleText } from "../lib/routines";

/**
 * The five sections of the Details panel. At narrow panel widths the inactive tabs show only
 * their icon and the selected one keeps its label, so every destination stays visible and
 * clickable without a hidden carousel (see `.details-tabs` in index.css).
 */
const DETAILS_TABS = [
  { id: "details", label: "Details", icon: CircleUser },
  { id: "instructions", label: "Instructions", icon: FileText },
  { id: "library", label: "Library", icon: LibraryIcon },
  { id: "computer", label: "Computer", icon: Monitor },
  { id: "memory", label: "Memory", icon: Brain },
] as const;

export function Details({ bot, threadId }: { bot: Bot; threadId: string | null }) {
  const threads = useApp((s) => s.threads);
  useApp((s) => s.threadData);
  const width = useApp((s) => s.detailsWidth);
  const archived = useApp((s) => s.bots[bot.slug]?.mainThreadId !== bot.mainThreadId);
  const identity = threadId ? threadIdentity(bot, threadId, threads) : bot;
  const [showRoutines, setShowRoutines] = useState(false);
  const tab = useApp((s) => s.detailsTab);
  const [picker, setPicker] = useState(false);
  const [editing, setEditing] = useState<"name" | "label" | null>(null);
  const [draft, setDraft] = useState("");
  const [routine, setRoutine] = useState<string | null>(null);
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const allTasks = useApp((s) => s.tasks);
  const tasks = useMemo(() => allTasks.filter((t) => t.projectId === bot.projectId), [allTasks, bot.projectId]);
  const openRoutine = tasks.find((t) => t.id === routine);
  useEffect(() => { setRoutine(null); setShowRoutines(false); }, [bot.slug]);
  const tabs = DETAILS_TABS;

  const onTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const ids = tabs.map((entry) => entry.id);
    let next = index;
    if (event.key === "ArrowRight") next = (index + 1) % ids.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + ids.length) % ids.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = ids.length - 1;
    else return;
    event.preventDefault();
    const id = ids[next];
    useApp.setState({ detailsTab: id });
    requestAnimationFrame(() => tabRefs.current[id]?.focus());
  };

  const routineChat = (text: string) => {
    const draft = chatDraft(bot, bot.mainThreadId);
    draft.setText([draft.getSnapshot().text, text].filter(Boolean).join("\n\n"));
    if (bot.mainThreadId) selectThread(bot, bot.mainThreadId);
    setRoutine(null);
    setDetailsOpen(false);
  };

  const commit = () => {
    if (editing && draft.trim() !== (bot[editing] ?? "")) updateBot(bot.slug, { [editing]: editing === "name" ? draft.trim() || bot.name : draft.trim() });
    setEditing(null);
  };

  return (
    <aside className={clsx("bot-details flex h-full shrink-0 flex-col border-l border-line bg-details", (showRoutines || openRoutine) && "routine-page")} style={{ width }} aria-label="Conversation details">
      <div className="details-header flex h-[52px] shrink-0 items-center justify-end px-3">
        <IconButton onClick={() => { if (openRoutine) { setRoutine(null); return; } if (tab !== "details" || showRoutines) { useApp.setState({ detailsTab: "details" }); setShowRoutines(false); } else setDetailsOpen(false); }} title="Back" className="details-back mr-auto hidden"><ChevronLeft size={20} /></IconButton>
        <span className="details-page-title hidden flex-1 text-center text-[17px] font-medium">{openRoutine ? "Routine" : tab === "library" ? "Library" : tab === "computer" ? "Computer" : tab === "memory" ? "Memory" : tab === "instructions" ? "Instructions" : showRoutines ? "Routines" : ""}</span>
        <IconButton onClick={() => setDetailsOpen(false)} title="Hide details" className="details-close"><ChevronsRight size={16} /></IconButton>
      </div>
      {openRoutine ? (
        <RoutineDetail key={`routine-detail:${openRoutine.id}`} bot={bot} task={openRoutine} onBack={() => setRoutine(null)} onEdit={() => routineChat(`Edit your routine: ${openRoutine.title}`)} />
      ) : (
        <div className="details-content scroll-thin min-h-0 flex-1 overflow-y-auto px-4 pb-6">
          <div className={clsx("details-profile flex flex-col items-center pt-1 pb-4", (tab !== "details" || showRoutines) && "details-profile-mobile-hidden")}>
            <button disabled={archived || threadId !== bot.mainThreadId} onClick={() => setPicker(true)} title="Change avatar" className="rounded-full transition-transform enabled:hover:scale-105">
              <Avatar shape={identity.shape} color={identity.color} picture={identity.avatarImage} size={88} star={bot.primary && threadId === bot.mainThreadId} />
            </button>
            {editing === "name" ? (
              <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && commit()} className="mt-3 w-full bg-transparent text-center text-[18px] font-medium outline-none" />
            ) : (
              <button disabled={archived || threadId !== bot.mainThreadId} onClick={() => { setEditing("name"); setDraft(bot.name); }} className="mt-3 max-w-full rounded-lg px-2 text-[18px] font-medium [overflow-wrap:anywhere] enabled:hover:bg-hover">
                {identity.name}
              </button>
            )}
            {threadId && threads[threadId] && <p className="mt-1 text-[12px] text-muted">{subagentStatus(conversationStatus(threadId))}{threads[threadId]?.settledOverride === "settled" ? " · Settled" : ""}</p>}
            {editing === "label" ? (
              <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && commit()} placeholder="Add a label" className="mt-1 w-full bg-transparent text-center text-[13px] text-muted outline-none" />
            ) : (
              <button disabled={archived} onClick={() => { setEditing("label"); setDraft(bot.label ?? ""); }} className="mt-0.5 rounded-lg px-2 text-[13px] text-muted enabled:hover:bg-hover">
                {archived ? "Archived Bot" : bot.label || "Add a label"}
              </button>
            )}
            {!archived && threadId === bot.mainThreadId && <Pill variant="soft" className="profile-edit mt-3 hidden" onClick={() => openDialog({ kind: "rename-bot", slug: bot.slug })}>Edit</Pill>}
          </div>

          <div className="details-tabs mb-4 flex justify-center gap-1" role="tablist" aria-label="Bot details sections">
            {tabs.map((entry, index) => {
              const Icon = entry.icon;
              return (
                <button
                  key={entry.id}
                  ref={(element) => { tabRefs.current[entry.id] = element; }}
                  type="button"
                  role="tab"
                  id={`details-tab-${entry.id}`}
                  aria-selected={tab === entry.id}
                  aria-controls={`details-panel-${entry.id}`}
                  tabIndex={tab === entry.id ? 0 : -1}
                  title={entry.label}
                  onClick={() => useApp.setState({ detailsTab: entry.id })}
                  onKeyDown={(event) => onTabKeyDown(event, index)}
                  className={clsx("details-tab inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[13px]", tab === entry.id ? "bg-active text-fg" : "text-muted hover:text-fg")}
                >
                  <Icon size={14} className="details-tab-icon" />
                  <span className="details-tab-label">{entry.label}</span>
                </button>
              );
            })}
          </div>

          <div role="tabpanel" id={`details-panel-${tab}`} aria-labelledby={`details-tab-${tab}`}>
          {tab === "details" && <>
            {!showRoutines && <div className="profile-actions mb-6 hidden overflow-hidden rounded-[20px] bg-card px-4">
              <ProfileAction icon={<Clock size={20} />} label="Routines" detail={`${tasks.filter((t) => t.enabled).length} on`} onClick={() => setShowRoutines(true)} />
              <ProfileAction icon={<FileText size={20} />} label="Instructions" onClick={() => useApp.setState({ detailsTab: "instructions" })} />
              <ProfileAction icon={<LibraryIcon size={20} />} label="Library" onClick={() => useApp.setState({ detailsTab: "library" })} />
              <ProfileAction icon={<Monitor size={20} />} label="Computer" detail={botStatus(bot) === "working" ? "Working" : "Idle"} onClick={() => useApp.setState({ detailsTab: "computer" })} />
            </div>}
            {!showRoutines && !archived && <ModelSection bot={bot} threadId={threadId} />}
            {!showRoutines && !archived && threadId === bot.mainThreadId && <CodingWorkSection bot={bot} />}
            {!showRoutines && !archived && <BotUsageLine bot={bot} />}
            {!showRoutines && threadId && <ThreadFamily bot={bot} threadId={threadId} />}
            {!showRoutines && threadId && <SideChatList parentThreadId={threadId} />}
            {threadId && threadId !== bot.mainThreadId && bot.mainThreadId && <Pill variant="soft" className="mb-4" onClick={() => bot.mainThreadId && selectThread(bot, bot.mainThreadId)}>Back to {bot.name}</Pill>}
            {!archived && <div className={showRoutines ? "" : "profile-routines"}><DetailsTab bot={bot} tasks={tasks} onOpenRoutine={setRoutine} onCreate={() => routineChat("Set up a routine")} routinesOnly={showRoutines} /></div>}
          </>}
          {tab === "library" && <Library bot={bot} />}
          {tab === "instructions" && <InstructionsTab bot={bot} />}
          {tab === "computer" && <ComputerTab bot={bot} />}
          {tab === "memory" && <MemoryTab bot={bot} />}
          </div>
        </div>
      )}
      {picker && <AvatarDialog key={bot.slug} bot={bot} onClose={() => setPicker(false)} />}
    </aside>
  );
}

/** Which model answers here. Lives with the Bot's other settings rather than in the writing row. */
function ModelSection({ bot, threadId }: { bot: Bot; threadId: string | null }) {
  const shell = useApp((s) => threadId ? s.threads[threadId] : undefined);
  const project = useApp((s) => (bot.projectId ? s.projects[bot.projectId] : undefined));
  const model = shell?.modelSelection ?? project?.defaultModelSelection ?? null;
  const change = (selection: ModelSelection) => (threadId && threadId !== bot.mainThreadId
    ? t3.dispatch({ type: "thread.model-selection.set", threadId, modelSelection: selection })
    : setBotModel(bot.slug, selection)).catch((error: unknown) => toast(error instanceof Error ? error.message : "Couldn't change the model"));
  return <div className="details-model"><Section title="Model"><div className="flex min-h-11 items-center rounded-2xl bg-card px-2.5 py-1.5"><ModelPicker value={model} onChange={change} /></div></Section></div>;
}

/** This Bot's own "Where coding work runs", over the default in Settings → Machines. Shown once other machines exist. */
function CodingWorkSection({ bot }: { bot: Bot }) {
  const machines = useApp((s) => s.machines);
  const global = useApp((s) => s.settings?.codingWork ?? null);
  if (!machines || machines.length < 2) return null;
  const inherit = `Default (${global?.preferred?.label ?? "This machine"})`;
  return <div className="details-coding-work"><Section title="Where coding work runs"><div className="overflow-hidden rounded-2xl bg-card">
    <CodingWorkRows value={bot.codingWork ?? null} machines={machines} inherit={inherit}
      onChange={(codingWork) => void updateBot(bot.slug, { codingWork })} />
  </div></Section></div>;
}

/** This Bot's token use this week; the line opens Settings → Usage. */
function BotUsageLine({ bot }: { bot: Bot }) {
  const [total, setTotal] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    readBotUsage(7).then((data) => {
      if (live) setTotal(data.rows.filter((row) => row.bot === bot.slug).reduce((sum, row) => sum + totalIn(row) + row.output, 0));
    }).catch(() => {});
    return () => { live = false; };
  }, [bot.slug]);
  if (total === null) return null;
  return <div className="details-usage mb-5"><Section title="Usage">
    <button onClick={() => { useApp.setState({ settingsPane: "usage" }); openDialog("settings"); }} className="flex min-h-11 w-full items-center rounded-2xl bg-card px-3.5 text-left text-[13px] text-muted enabled:hover:text-fg">
      {formatTokens(total)} tokens this week
    </button>
  </Section></div>;
}

function AvatarDialog({ bot, onClose }: { bot: Bot; onClose: () => void }) {
  const bots = useApp((s) => s.bots);
  const shared = useMemo(() => sharedObjects(Object.values(bots)), [bots]);
  const draw = useAvatarDrawing(bot);
  return <AvatarEditorDialog initial={{ shape: bot.shape, color: bot.color, avatarImage: bot.avatarImage, avatarDefinition: bot.avatarDefinition }} onSave={draft => updateBot(bot.slug, draft)} onClose={onClose} shared={shared} draw={draw} />;
}

function Section({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="mb-5">
      <div className="mb-1.5 flex items-center px-1 text-[12.5px] text-muted">
        {title}
        <span className="ml-auto">{action}</span>
      </div>
      {children}
    </div>
  );
}

function ProfileAction({ icon, label, detail, onClick }: { icon: React.ReactNode; label: string; detail?: string; onClick: () => void }) {
  return <button className="flex w-full items-center gap-3 border-b border-line py-4 text-left last:border-0" onClick={onClick}><span className="text-muted">{icon}</span><span className="flex-1 text-[17px]">{label}</span><span className="text-[15px] text-muted">{detail}</span><ChevronRight size={18} className="text-muted" /></button>;
}

function DetailsTab({ bot, tasks, onOpenRoutine, onCreate, routinesOnly }: { bot: Bot; tasks: ScheduledTask[]; onOpenRoutine: (id: string) => void; onCreate: () => void; routinesOnly: boolean }) {
  return (
    <>
      <div className={routinesOnly ? "" : "routine-section"}><Section title={routinesOnly ? "" : "Routines"} action={<button onClick={onCreate} disabled={!bot.projectId} aria-label="New routine" className="flex min-h-9 items-center gap-1 text-fg disabled:opacity-40"><Plus size={14} /> New</button>}>
        {tasks.length === 0 ? (
          <div className={clsx("rounded-2xl px-3.5 py-3 leading-relaxed text-muted", routinesOnly ? "flex min-h-[calc(100dvh-322px)] items-center justify-center text-center text-[18px]" : "bg-card text-[13px]")}>Routines are recurring tasks this Bot runs on a schedule. Ask it in chat to set one up.</div>
        ) : (
          <div className="overflow-hidden rounded-2xl bg-card">
            {tasks.map((t) => <RoutineRow key={t.id} task={t} onOpen={() => onOpenRoutine(t.id)} />)}
          </div>
        )}
      </Section>
      </div>
      {!routinesOnly && <><div className="notifications-setting"><Section title="Notifications">
        <div className="flex items-center gap-3 rounded-2xl bg-card px-3.5 py-3">
          <div className="notifications-label hidden min-w-0 flex-1 text-[17px]">Notifications</div>
          <div className="notifications-inline min-w-0 flex-1 text-[13px] text-muted">Get notified when this Bot finishes or is waiting for you.</div>
          <Switch checked={bot.notifications !== false} onChange={(v) => updateBot(bot.slug, { notifications: v })} label="Notifications" />
        </div>
        <p className="notifications-below hidden">Get notified when this Bot finishes or is waiting for you</p>
        {typeof Notification !== "undefined" && Notification.permission !== "granted" && <Pill variant="soft" className="mt-2" onClick={() => void enablePushNotifications().then((ok) => toast(ok ? "Push notifications enabled" : "Notifications were not enabled"))}>Enable push on this device</Pill>}
      </Section></div>
      <Section title="Folder">
        <div className="flex items-center gap-2 rounded-2xl bg-card px-3.5 py-3 font-mono text-[11.5px] text-muted">
          <Folder size={13} className="shrink-0" />
          <span className="truncate" title={bot.workspaceRoot}>{bot.workspaceRoot}</span>
        </div>
      </Section></>}
    </>
  );
}

function RoutineRow({ task, onOpen }: { task: ScheduledTask; onOpen: () => void }) {
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const [error, setError] = useState("");
  const timezone = useApp((s) => s.settings?.timezone ?? "");
  const toggle = async (enabled: boolean) => {
    if (busy.current) return;
    busy.current = true;
    setPending(true); setError("");
    try { await changeRoutineEnabled(task, enabled); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Couldn't update this routine"); }
    finally { busy.current = false; setPending(false); }
  };
  return <div className="border-b border-line last:border-0">
    <div className="flex items-center gap-3 px-3.5 py-2.5">
      <button onClick={onOpen} className="min-w-0 flex-1 text-left hover:text-muted"><span className="block truncate text-[13.5px]">{task.title}</span><span className="block text-[12px] text-muted">{task.blockedByPolicy ? "Blocked · " : !task.enabled && "Paused · "}{scheduleText(task, timezone)}</span></button>
      <span aria-busy={pending} className={pending ? "pointer-events-none opacity-50" : ""}><Switch checked={task.enabled} onChange={(v) => void toggle(v)} label={`${task.enabled ? "Pause" : "Resume"} ${task.title}`} /></span>
    </div>
    {error && <p role="alert" className="px-3.5 pb-2 text-[12px] text-danger">{error}</p>}
  </div>;
}

function RoutineDetail({ bot, task, onBack, onEdit }: { bot: Bot; task: ScheduledTask; onBack: () => void; onEdit: () => void }) {
  const [confirm, setConfirm] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const busy = useRef(false);
  const [error, setError] = useState("");
  const timezone = displayTimezone(useApp((s) => s.settings?.timezone ?? ""));
  // Older T3 versions keep every bound routine in the same conversation and ignore a mode.
  const modes = useApp((s) => s.runtimeFeatures.scheduledTaskThreadModes);
  const mode = threadMode(task);
  const action = async (label: string, work: () => Promise<unknown>) => {
    if (busy.current) return;
    busy.current = true;
    setPending(label); setError("");
    try { await work(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Couldn't update this routine"); }
    finally { busy.current = false; setPending(null); }
  };
  return <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-4 pb-6">
    <div className="routine-detail-back mb-3 flex items-center gap-2"><IconButton onClick={onBack} aria-label="Back to routines"><ArrowLeft size={16} /></IconButton><span className="text-[14px] font-medium">Routine</span></div>
    <div className="mb-4 flex flex-col items-center gap-2 pt-2 text-center"><span className="grid size-12 place-items-center rounded-2xl bg-card text-muted"><Clock size={20} /></span><div className="max-w-full break-words text-[16px] font-medium">{task.title}</div><div className="text-[13px] text-muted">{!task.enabled && "Paused · "}{scheduleText(task, timezone)}</div></div>
    <div className="mb-5 flex flex-wrap justify-center gap-2">
      <Pill variant="soft" disabled={!!pending} onClick={() => void action("state", () => changeRoutineEnabled(task, !task.enabled))}>{pending === "state" ? "Saving…" : task.enabled ? "Pause" : "Resume"}</Pill>
      <Pill variant="soft" disabled={!!pending} onClick={onEdit}>Edit</Pill>
      {task.schedule.type !== "webhook" && <Pill disabled={!!pending || task.lastRunStatus === "running"} onClick={() => void action("test", async () => { await testRoutine(task); })}><Play size={12} fill="currentColor" />{pending === "test" || task.lastRunStatus === "running" ? "Running…" : "Test"}</Pill>}
    </div>
    {error && <p role="alert" className="mb-4 break-words text-[13px] text-danger">{error}</p>}
    {task.blockedByPolicy && <p role="status" className="mb-4 break-words rounded-2xl bg-card px-3.5 py-3 text-[13px]">This routine can’t run: {task.blockedByPolicy}</p>}
    <Section title="Instruction"><div className="whitespace-pre-wrap break-words rounded-2xl bg-card px-3.5 py-3 text-[13.5px]">{task.prompt}</div></Section>
    <Section title="When to run"><div className="rounded-2xl bg-card px-3.5 py-3 text-[13px]">{scheduleText(task, timezone)}{!task.enabled && <p className="mt-1 text-muted">{task.schedule.type === "webhook" ? "Paused. Webhook deliveries will not dispatch work." : "Paused. Scheduled runs are off; Test still dispatches work."}</p>}{task.schedule.type === "fixed_time" && <p className="mt-1 text-[12px] text-muted">Uses the T3 server’s clock and daylight saving rules. Changing your display timezone does not change this schedule.</p>}</div></Section>
    {modes && mode !== "new_thread" && <Section title="Conversation"><div className="rounded-2xl bg-card px-3.5 py-3 text-[13px]">
      <div className="flex items-center gap-3"><span className="flex-1">Start fresh each run</span>{pending === "fresh" ? <span className="text-muted">Saving…</span> : <Switch label="Start fresh each run" checked={mode === "fresh_session"} onChange={(on) => void action("fresh", () => changeRoutineFreshSession(task, bot, on))} />}</div>
      <p className="mt-1 text-[12px] text-muted">{mode === "fresh_session" ? `Each run starts a fresh session here instead of re-reading the whole chat. ${bot.name} keeps its memory and files, and your next message carries on from the run.` : "Each run continues the conversation, re-reading the chat so far."}</p>
    </div></Section>}
    {task.schedule.type === "webhook" && <WebhookDetails task={task} />}
    <RoutineHistory task={task} timezone={timezone} />
    {confirm ? <div className="flex flex-wrap items-center gap-2"><span className="flex-1 text-[13px]">Delete this routine?</span><Pill variant="soft" disabled={!!pending} onClick={() => setConfirm(false)}>Cancel</Pill><Pill variant="danger" disabled={!!pending} onClick={() => void action("delete", async () => { await removeRoutine(task); onBack(); })}>{pending === "delete" ? "Deleting…" : "Delete"}</Pill></div> : <button onClick={() => setConfirm(true)} className="flex min-h-10 items-center gap-2 px-1 text-[13px] text-danger hover:underline"><Trash2 size={13} /> Delete routine</button>}
  </div>;
}

function RoutineHistory({ task, timezone }: { task: ScheduledTask; timezone: string }) {
  const [result, setResult] = useState<Awaited<ReturnType<typeof routineHistory>> | null>(null);
  const [error, setError] = useState(""); const [revision, refresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setError("");
    routineHistory(task.id, controller.signal).then(setResult).catch((cause: unknown) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Couldn't read history"); });
    return () => controller.abort();
  }, [task.id, task.lastRunAt, task.lastRunStatus, task.runCount, revision]);
  return <Section title="History" action={<button className="min-h-9 hover:text-fg" onClick={() => refresh((r) => r + 1)}>Refresh</button>}>
    <div className="rounded-2xl bg-card px-3.5 py-3 text-[13px] text-muted">
      {error ? <p role="status">{error}</p> : !result ? <p role="status">Loading…</p> : <>
        {!result.observing && <p role="status" className="mb-2">History is unavailable. Try again.</p>}
        {!result.rows.length && <p>No history yet.</p>}
        {result.rows.map((row) => <div key={row.id} className="border-b border-line py-2 last:border-0"><span className="capitalize text-fg">{row.status.replaceAll("_", " ")}</span><div className="mt-1 text-[12px]">{routineDate(row.at, timezone)}</div>{row.threadId && row.runId && <button className="mt-1 min-h-8 text-fg hover:underline" onClick={() => { const bot = Object.values(useApp.getState().bots).find((b) => b.projectId === task.projectId); if (bot && row.threadId) selectThread(bot, row.threadId); }}>Open conversation</button>}</div>)}
        {result.incomplete && <p className="mt-2 text-[12px]">Some history may be missing.</p>}
      </>}
    </div>
  </Section>;
}
function WebhookDetails({ task }: { task: ScheduledTask }) {
  const [error, setError] = useState("");
  return <Section title="Webhook URL"><div className="space-y-3 rounded-2xl bg-card px-3.5 py-3 text-[13px]">
    <p className="text-muted">The address an outside service sends its request to. Each request runs this routine once. It is the "POST to" field.</p>
    <Pill variant="soft" onClick={() => void copyWebhookUrl(task).then(() => toast("Copied")).catch(() => setError("Couldn't load the webhook URL and key"))}>Copy</Pill>
    {error && <p role="alert" className="text-muted">{error}</p>}
  </div></Section>;
}

function ComputerTab({ bot }: { bot: Bot }) {
  const tabs = useBotTabs(bot.mainThreadId);
  const tab = tabs?.[tabs.length - 1];
  const open = () => openDialog({ kind: "computer", slug: bot.slug });
  return (
    <div>
      <button onClick={open} className="block w-full overflow-hidden rounded-2xl border border-line bg-card text-left">
        {tab && bot.mainThreadId ? (
          <ComputerScreen threadId={bot.mainThreadId} tabId={tab.tabId} interactive={false} className="pointer-events-none aspect-[16/10] w-full" />
        ) : (
          <div className="grid aspect-[16/10] place-items-center text-center text-[13px] text-muted">
            <div>
              <Monitor size={22} className="mx-auto mb-2 opacity-60" />
              {tabs === null ? "Waking up…" : "Computer is asleep"}
            </div>
          </div>
        )}
      </button>
      <div className="mt-2 flex items-center px-1 text-[12px] text-muted">
        <span className="min-w-0 flex-1 truncate">{tab ? tab.title || tab.url : `${bot.name}'s screen`}</span>
        {tab && (
          <button onClick={open} className="ml-2 shrink-0 text-fg hover:underline">
            Open
          </button>
        )}
      </div>
    </div>
  );
}
