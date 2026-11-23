import { useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { ArrowLeft, Brain, ChevronsRight, ChevronLeft, ChevronRight, CircleUser, Clock, FileText, Folder, Library as LibraryIcon, Monitor, Play, Plus, Trash2 } from "lucide-react";
import { ModelLabel, ModelPicker, modelDisplayName } from "./ModelPicker";
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
import { botStatus, botThreadStatus, openDialog, selectThread, setDetailsOpen, toast, updateBot, useApp, setBotModel } from "../store";
import { sharedObjects } from "../lib/objectAvatars";
import { useAvatarDrawing } from "./useAvatarDrawing";
import { ComputerScreen, useBotTabs } from "./Computer";
import { DesktopThumbnail } from "./Desktop";
import type { Bot, ModelSelection, ScheduledTask } from "../lib/types";

import { chatDraft } from "../lib/chatDrafts";
import { formatTokens, readBotUsage, totalIn } from "../lib/usageApi";
import { pushDeviceStatus, type PushDeviceStatus } from "../lib/push";
import "./routines.css";
import { findTidyTask } from "../lib/memoryTidy";
import { reportsToChat } from "../lib/routineReports";
import { changeRoutineEnabled, changeRoutineFreshSession, chatModelFrom, copyWebhookUrl, displayTimezone, moveRoutineToChat, removeRoutine, routineDate, routineDestination, routineHistory, scheduleText, setRoutineModel, testRoutine, threadMode } from "../lib/routines";
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
  // Beta → "Settle Bot threads in T3 Code" settles every quiet Bot, so on the main thread settled just means idle.
  const mainSettledByBeta = useApp((s) => s.settings?.beta?.settleBotThreads === true) && threadId === bot.mainThreadId;
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
        <IconButton onClick={() => { if (openRoutine) { setRoutine(null); return; } if (tab !== "details" || showRoutines) { useApp.setState({ detailsTab: "details" }); setShowRoutines(false); } else setDetailsOpen(false); }} title="Back" aria-label="Back" className="details-back mr-auto hidden"><ChevronLeft size={20} /></IconButton>
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
            {threadId && threads[threadId] && <p className="mt-1 text-[12px] text-muted">{subagentStatus(botThreadStatus(bot, threadId))}{!mainSettledByBeta && threads[threadId]?.settledOverride === "settled" ? " · Settled" : ""}</p>}
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
              <ProfileAction icon={<Brain size={20} />} label="Memory" onClick={() => useApp.setState({ detailsTab: "memory" })} />
              <ProfileAction icon={<LibraryIcon size={20} />} label="Library" onClick={() => useApp.setState({ detailsTab: "library" })} />
              <ProfileAction icon={<Monitor size={20} />} label="Computer" detail={botStatus(bot) === "working" ? "Working" : "Idle"} onClick={() => useApp.setState({ detailsTab: "computer" })} />
            </div>}
            {!showRoutines && !archived && <ModelSection bot={bot} threadId={threadId} />}
            {!showRoutines && !archived && <ConnectedAppsSection bot={bot} />}
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

/** Executor's own approval, not a T3 permission mode: it decides whether app writes wait for the Bot. */
function ConnectedAppsSection({ bot }: { bot: Bot }) {
  const executorUrl = useApp((s) => s.executorUrl);
  const [busy, setBusy] = useState(false);
  if (!executorUrl) return null;
  const automatic = bot.executorApproval === "automatic";
  const titleId = `connected-apps-title-${bot.slug}`;
  const noteId = `${titleId}-note`;
  const change = async (on: boolean) => {
    if (busy) return;
    setBusy(true);
    try { await updateBot(bot.slug, { executorApproval: on ? "automatic" : "ask" }); }
    catch (error) { toast(error instanceof Error ? error.message : "Couldn't change app approval"); }
    finally { setBusy(false); }
  };
  return <div className="details-connected-apps"><Section title="Connected apps">
    <div className="rounded-2xl bg-card px-3.5 py-3">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div id={titleId} className="text-[17px]">Automatic app approval</div>
          <p id={noteId} className="mt-1 text-[12px] leading-relaxed text-muted">Applies to new sessions. T3 permissions still decide what this Bot may run.</p>
        </div>
        <Switch checked={automatic} onChange={(on) => void change(on)} labelledBy={titleId} describedBy={noteId} busy={busy} disabled={busy} />
      </div>
      <p className={`mt-3 text-[13px] leading-relaxed ${automatic ? "text-attention" : "text-muted"}`}>{automatic
        ? `Executor approves every connected app write for ${bot.name}, without asking. All apps, not one tool.`
        : `Executor asks before writing to an app. ${bot.name} relays the request to you; one it doesn't relay expires after 15 minutes.`}</p>
    </div>
  </Section></div>;
}

/** Which model answers here. Lives with the Bot's other settings rather than in the writing row. */
function ModelSection({ bot, threadId }: { bot: Bot; threadId: string | null }) {
  const shell = useApp((s) => threadId ? s.threads[threadId] : undefined);
  const project = useApp((s) => (bot.projectId ? s.projects[bot.projectId] : undefined));
  const model = threadId === bot.mainThreadId ? chatModelFrom(bot, shell, project) : shell?.modelSelection ?? project?.defaultModelSelection ?? null;
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
        <div className="overflow-hidden rounded-2xl bg-card">
          <div className="flex items-center gap-3 px-3.5 py-3">
            <div className="notifications-label hidden min-w-0 flex-1 text-[17px]">Notifications</div>
            <div className="notifications-inline min-w-0 flex-1 text-[13px] text-muted">Get notified when this Bot finishes or is waiting for you.</div>
            <Switch checked={bot.notifications !== false} onChange={(v) => updateBot(bot.slug, { notifications: v })} label="Notifications" />
          </div>
          <DevicePushRow />
        </div>
        <p className="notifications-below hidden">Get notified when this Bot finishes or is waiting for you</p>
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

function DevicePushRow() {
  const [status, setStatus] = useState<PushDeviceStatus | null>(null);
  useEffect(() => {
    void pushDeviceStatus().then(setStatus);
  }, []);
  const stateLabel = !status ? null : !status.supported || !status.secure ? "Unavailable" : status.subscribed ? "On" : "Off";
  return (
    <button
      type="button"
      onClick={() => {
        useApp.setState({ settingsPane: "notifications" });
        openDialog("settings");
      }}
      className="flex min-h-10 w-full items-center justify-between border-t border-line px-3.5 py-2.5 text-left text-[12.5px] text-muted transition-colors hover:bg-hover hover:text-fg"
    >
      <span>Push on this device</span>
      <span className="flex items-center gap-1.5 font-medium">
        {stateLabel && <span className={clsx("rounded-full px-2 py-0.5 text-[11px]", status?.subscribed ? "bg-active text-fg" : "text-muted")}>{stateLabel}</span>}
        <ChevronRight size={14} className="text-muted" />
      </span>
    </button>
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
  const [moveTo, setMoveTo] = useState<ModelSelection | null>(null);
  const [confirmBack, setConfirmBack] = useState(false);
  const timezone = displayTimezone(useApp((s) => s.settings?.timezone ?? ""));
  // Older T3 versions keep every bound routine in the same conversation and ignore a mode.
  const modes = useApp((s) => s.runtimeFeatures.scheduledTaskThreadModes);
  const mode = threadMode(task);
  const destination = routineDestination(task, bot);
  const ownThreadId = destination === "own" ? task.threadId : null;
  const ownThread = useApp((s) => (ownThreadId ? s.threads[ownThreadId] : undefined));
  const chatThread = useApp((s) => (bot.mainThreadId ? s.threads[bot.mainThreadId] : undefined));
  const project = useApp((s) => (bot.projectId ? s.projects[bot.projectId] : undefined));
  const chatModel = chatModelFrom(bot, chatThread, project);
  const providers = useApp((s) => s.providers);
  // Only a conversation started for the routine (or the memory tidy's) reports to the chat.
  const tidyId = useApp((s) => findTidyTask(bot, s.tasks)?.id);
  const nameOf = (selection: ModelSelection | null | undefined) => modelDisplayName(selection, providers) || "its model";
  const model = destination === "own" ? ownThread?.modelSelection ?? task.modelSelection ?? null : destination === "chat" ? chatModel : task.modelSelection ?? null;
  // A run in progress owns the thread until it ends; moving the routine then is a change nobody asked for.
  const running = task.lastRunStatus === "running";
  const picker = useRef<HTMLButtonElement>(null);
  const modelAction = useRef<HTMLButtonElement>(null);
  const backAction = useRef<HTMLButtonElement>(null);
  const confirmBox = useRef<HTMLDivElement>(null);
  const status = useRef<HTMLParagraphElement>(null);
  const previousDestination = useRef(destination);
  const busyBlock = pending === "model" || pending === "move" || pending === "back" || pending === "fresh";
  // The region is mounted empty: a node that appears already filled is not announced by every reader.
  const announce = (text: string) => {
    const node = status.current;
    if (!node) return;
    node.textContent = "";
    window.setTimeout(() => { if (status.current === node) node.textContent = text; }, 20);
  };
  // Moving the routine replaces the control that had focus; send it to the control that appears.
  useEffect(() => {
    if (previousDestination.current === destination) return;
    previousDestination.current = destination;
    (destination === "own" ? picker : modelAction).current?.focus();
  }, [destination]);
  useEffect(() => {
    if (!moveTo && !confirmBack) return;
    confirmBox.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [moveTo, confirmBack]);
  const action = async (label: string, work: () => Promise<unknown>) => {
    if (busy.current) return;
    busy.current = true;
    setPending(label); setError("");
    try { await work(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Couldn't update this routine"); }
    finally { busy.current = false; setPending(null); }
  };
  // In the chat, the chat owns the model; picking another one starts the move to a conversation of its own.
  const chooseModel = (selection: ModelSelection) => {
    if (destination === "chat") {
      if (chatModel && selection.instanceId === chatModel.instanceId && selection.model === chatModel.model) { setMoveTo(null); return; }
      setMoveTo(selection);
      return;
    }
    void action("model", async () => {
      await setRoutineModel(task, bot, selection);
      announce(`Model set to ${nameOf(selection)}.`);
    });
  };
  const moveOut = () => {
    if (!moveTo) return;
    void action("move", async () => {
      await setRoutineModel(task, bot, moveTo);
      setMoveTo(null);
      announce(`Moved to its own conversation on ${nameOf(moveTo)}.`);
    });
  };
  const moveBack = () => {
    void action("back", async () => {
      await moveRoutineToChat(task, bot);
      setConfirmBack(false);
      announce("Back in the chat. Its old conversation is still open.");
    });
  };
  const destinationNote = destination === "chat"
    ? `Runs with the model of ${bot.name}’s chat. Change it there and this routine follows.`
    : destination === "own"
      ? !ownThread?.latestRunId
        ? `Runs on ${nameOf(model)} in its own conversation. Nothing there until the first run.`
        : reportsToChat(task, tidyId) && !ownThread.archivedAt
          ? `Runs on ${nameOf(model)} in its own conversation. ${bot.name}’s chat gets a one-line summary.`
          : `Runs on ${nameOf(model)} in its own conversation.`
      : destination === "own-pending"
        ? "The first run starts its own conversation with this model."
        : "Each run starts a new thread with this model.";
  const freshNote = mode === "fresh_session"
    ? destination === "chat"
      ? `Each run starts a fresh session instead of re-reading the whole chat. ${bot.name} keeps its memory and files, and your next message carries on from the run.`
      : "Each run starts a fresh session instead of re-reading the earlier runs."
    : destination === "chat"
      ? "Each run continues the conversation, re-reading the chat so far."
      : "Each run continues the conversation, re-reading the earlier runs.";
  return <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-4 pb-6">
    <div className="routine-detail-back mb-3 flex items-center gap-2"><IconButton onClick={onBack} aria-label="Back to routines"><ArrowLeft size={16} /></IconButton><span className="text-[14px] font-medium">Routine</span></div>
    <div className="mb-4 flex flex-col items-center gap-2 pt-2 text-center"><span className="grid size-12 place-items-center rounded-2xl bg-card text-muted"><Clock size={20} /></span><div className="max-w-full break-words text-[16px] font-medium">{task.title}</div><div className="text-[13px] text-muted">{!task.enabled && "Paused · "}{scheduleText(task, timezone)}</div></div>
    <div className="mb-5 flex flex-wrap justify-center gap-2">
      <Pill variant="soft" disabled={!!pending} onClick={() => void action("state", () => changeRoutineEnabled(task, !task.enabled))}>{pending === "state" ? "Saving…" : task.enabled ? "Pause" : "Resume"}</Pill>
      <Pill variant="soft" disabled={!!pending} onClick={onEdit}>Edit</Pill>
      {task.schedule.type !== "webhook" && <Pill disabled={!!pending || task.lastRunStatus === "running"} onClick={() => void action("test", async () => {
        await testRoutine(task);
        if (destination === "own" && task.threadId) toast("Test run started in its own conversation.", { href: "#", label: "Open", open: () => selectThread(bot, task.threadId!) });
        else if (destination !== "chat") toast("Test run started in a new thread.");
      })}><Play size={12} fill="currentColor" />{pending === "test" || task.lastRunStatus === "running" ? "Running…" : "Test"}</Pill>}
    </div>
    {error && <p role="alert" id="routine-error" className="mb-4 break-words text-[13px] text-danger">{error}</p>}
    {task.blockedByPolicy && <p role="status" className="mb-4 break-words rounded-2xl bg-card px-3.5 py-3 text-[13px]">This routine can’t run: {task.blockedByPolicy}</p>}
    <Section title="Instruction"><div className="whitespace-pre-wrap break-words rounded-2xl bg-card px-3.5 py-3 text-[13.5px]">{task.prompt}</div></Section>
    <Section title="When to run"><div className="rounded-2xl bg-card px-3.5 py-3 text-[13px]">{scheduleText(task, timezone)}{!task.enabled && <p className="mt-1 text-muted">{task.schedule.type === "webhook" ? "Paused. Webhook deliveries will not dispatch work." : "Paused. Scheduled runs are off; Test still dispatches work."}</p>}{task.schedule.type === "fixed_time" && <p className="mt-1 text-[12px] text-muted">Uses the T3 server’s clock and daylight saving rules. Changing your display timezone does not change this schedule.</p>}</div></Section>
    <Section title="Where it runs"><div role="group" aria-label="Where it runs" className={clsx("rounded-2xl bg-card px-3.5 py-3 text-[13px]", busyBlock && "opacity-60")} aria-busy={busyBlock || undefined}>
      {destination === "chat" ? <>
        <div className="flex min-w-0 items-center gap-2"><ModelLabel value={chatModel} wrap /></div>
        <p id="routine-destination-note" className="mt-1 text-[12px] leading-relaxed text-muted">{destinationNote}</p>
        <ModelPicker value={chatModel} onChange={chooseModel} closeOnPick trigger={(open) => <button ref={modelAction} type="button" onClick={open} disabled={running} aria-describedby={`routine-destination-note${error ? " routine-error" : ""}`} className="mt-1 flex min-h-10 items-center text-[13px] text-fg hover:underline disabled:text-muted disabled:hover:no-underline max-sm:min-h-11">Use its own model…</button>} title="Model for this routine" note={`A model of its own means a conversation of its own. ${bot.name}’s chat keeps its model.`} />
      </> : <>
        <ModelPicker value={model} onChange={chooseModel} triggerRef={picker} triggerClassName="min-h-11" describedBy={`routine-destination-note${error ? " routine-error" : ""}`} title="Model for this routine" />
        <p id="routine-destination-note" className="mt-1 text-[12px] leading-relaxed text-muted">{destinationNote}</p>
      </>}
      {destination === "own" && <div className="mt-1 flex flex-wrap items-center gap-x-4">
        {!!ownThread?.latestRunId && <button type="button" className="flex min-h-10 items-center text-[13px] text-fg hover:underline max-sm:min-h-11" onClick={() => { if (task.threadId) selectThread(bot, task.threadId); }}>Open conversation</button>}
        <button ref={backAction} type="button" onClick={() => setConfirmBack(true)} disabled={running} className="flex min-h-10 items-center text-[13px] text-fg hover:underline disabled:text-muted disabled:hover:no-underline max-sm:min-h-11">Move it back to the chat</button>
      </div>}
      {running && destination !== "new-thread" && <p className="mt-1 text-[12px] text-muted">A run is in progress. You can move it when the run finishes.</p>}
      {moveTo && destination === "chat" && <div ref={confirmBox} className="mt-2.5 border-t border-line pt-2.5">
        <p className="text-[13px]">Move it to its own conversation on <span className="font-medium">{nameOf(moveTo)}</span>? Future runs answer there; {bot.name}’s chat gets a one-line summary.</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Pill variant="soft" disabled={pending === "move" || running} onClick={moveOut}>{pending === "move" ? "Moving…" : "Move it"}</Pill>
          <Pill variant="soft" disabled={pending === "move"} onClick={() => { setMoveTo(null); modelAction.current?.focus(); }}>Keep it here</Pill>
        </div>
      </div>}
      {confirmBack && <div ref={confirmBox} className="mt-2.5 border-t border-line pt-2.5">
        <p className="text-[13px]">Move it back to {bot.name}’s chat? Its old conversation stays open.</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Pill variant="soft" disabled={pending === "back" || running} onClick={moveBack}>{pending === "back" ? "Moving…" : "Move it back"}</Pill>
          <Pill variant="soft" disabled={pending === "back"} onClick={() => { setConfirmBack(false); backAction.current?.focus(); }}>Keep it here</Pill>
        </div>
      </div>}
      {modes && destination !== "new-thread" && <>
        <div className="mt-2.5 flex items-center gap-3 border-t border-line pt-2.5">
          <span className="flex-1" id="routine-fresh-label">Start fresh each run</span>
          <Switch labelledBy="routine-fresh-label" describedBy="routine-fresh-note" busy={pending === "fresh"} disabled={!!pending} checked={mode === "fresh_session"} onChange={(on) => void action("fresh", async () => {
            await changeRoutineFreshSession(task, bot, on);
            announce(on ? "Each run now starts a fresh session." : "Each run now continues the conversation.");
          })} />
        </div>
        <p id="routine-fresh-note" className="mt-1 text-[12px] leading-relaxed text-muted">{freshNote}</p>
      </>}
      <p role="status" aria-live="polite" aria-atomic="true" className="sr-only" ref={status} />
    </div></Section>
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
  const desktopOn = useApp(s => s.settings?.beta?.desktop === true);
  return desktopOn ? <DesktopThumbnail bot={bot} /> : <BrowserTab bot={bot} />;
}

function BrowserTab({ bot }: { bot: Bot }) {
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
