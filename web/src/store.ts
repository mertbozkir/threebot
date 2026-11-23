import { create } from "zustand";
import { api } from "./lib/api";
import { isCustomColor } from "../../server/avatar-color.mts";
import { rememberColor } from "./lib/recentColors";
import { enablePushNotifications, pushTurnedOff } from "./lib/push";
import { botBadge, notificationContent, notificationTarget, waitingThread } from "./lib/notification";
import { allT3Clients, t3, t3http, uuid, environmentT3, environmentHttp, environmentPrefix, threadClient, threadTarget, threadKey, type ThreadTarget, type StreamHandle } from "./lib/t3";
import { vaultApi, type VaultItem } from "./lib/vault";
import { columnWidth, type Column } from "./lib/layout";
import { createRoom as createRoomApi, deleteRoom as deleteRoomApi, fetchRoom, fetchRooms, resetRoom as resetRoomApi, sendRoomMessage as sendRoomMessageApi, stopRoom as stopRoomApi, updateRoom as updateRoomApi, type CreateRoomInput, type RoomSummary, type RoomView, type RoomTurn, type UpdateRoomInput } from "./lib/rooms";
import { clearRoomDraft } from "./lib/roomDrafts";
import { agentStatus, isProjectEnrichment } from "./lib/threadFamily";
import { FORGET_CHANNEL, ROOM_VIEW_BYTES, clearCache, deletedRecords, forgetRecords, forgetRoom, readBoot, readRoom, readRooms, readView, stopCacheWrites, writeBoot, writeRoom, writeRooms, writeView, type CachedBoot } from "./lib/threadCache";
import { resetAssetCopies, revokeAssetHandles } from "./lib/assetCopies";
import { canStartSideChat, isSideChat, sideChatTitle } from "./lib/sideChats";
import { DRAWING_JOB_TITLE, DRAWING_OPTIONS, drawingModel, drawingsOf, drawingPending, drawingPrompt, drawingResult, drawingTitle, fixPrompt, isDrawingJob, type DrawingOption } from "./lib/avatarDrawing";
import type { Bot, DetailsTab, Machine, ModelSelection, ProjectShell, Provider, ProviderModelPreferences, Run, RuntimeRequest, ScheduledTask, Settings, SnoozePreset, RuntimeFeatures, Subagent, ThreadMeta, ThreadPreview, ThreadShell, TurnItem } from "./lib/types";

export type ThreadData = {
  items: Record<string, TurnItem>;
  runs: Record<string, Run>;
  requests: Record<string, RuntimeRequest>;
  subagents: Record<string, Subagent>;
  loaded: boolean;
  /** Painted from this device's own copy; T3's snapshot has not landed yet, so it says nothing about now. */
  stale?: boolean;
  /** The copy was looked for and found empty: what is missing is on the server, not on its way. */
  copyChecked?: boolean;
  /** Bounded snapshots hold only recent rows; older ones load page by page from this cursor. */
  historyCursor?: string | null;
  hasMoreHistory?: boolean;
};

export type MainBotIntent = { kind: "replace" } | { kind: "hide"; slug: string } | { kind: "delete"; slug: string };
export type Dialog = null | "new-bot" | "settings" | "search" | "connect-apps" | { kind: "connect-apps"; url: string } | { kind: "delete-bot"; slug: string } | "adopt-project" | { kind: "rename-bot"; slug: string } | { kind: "computer"; slug: string } | { kind: "main-bot"; intent: MainBotIntent; initialSlug?: string } | { kind: "room"; id?: string } | "mobile";

export type SearchFilter = "All" | "Messages" | "Bots" | "Rooms" | "Routines" | "Files" | "Apps";
export type SearchSession = { query: string; filter: SearchFilter; index: number; scrollTop: number };


const PREVIEWS_KEY = "bot.previews";
function loadPreviews(): Record<string, ThreadPreview> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(PREVIEWS_KEY) ?? "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, ThreadPreview> : {};
  } catch {
    return {};
  }
}

type State = {
  runtimeFeatures: RuntimeFeatures;
  snoozePresets: SnoozePreset[];
  /** T3's backup for new threads when the default model is out of usage. */
  fallbackModel: ModelSelection | null;
  /** The side chat open beside its parent conversation. */
  sideChat: { parentThreadId: string; threadId: string } | null;
  archiveError: string | null;
  olderSettledCursor: { settledAt: string; threadId?: string } | null;
  archivedThreads: Record<string, ThreadShell>;
  auth: "unknown" | "loading" | "access" | "password" | "error" | "ready";
  connection: "connecting" | "open" | "closed";
  /** This page opened from what the device kept, or lost a socket it had: what is on screen is the last copy. */
  offline: boolean;
  /** The open room is the copy this device kept; its poll has not answered yet. */
  roomStale: boolean;
  /** This device has no copy of the open room: what is missing is on the server, not on its way. */
  roomMissing: boolean;
  /** The gateway says the open room is gone (deleted on another device); its copy must not come back. */
  roomGone: boolean;
  /** One short line for the live region: only state changes say anything, never the first paint. */
  announcement: string;
  botsRoot: string;
  executorUrl: string | null;
  settings: Settings | null;
  bots: Record<string, Bot>;
  historicalBots: Record<string, Bot>;
  projects: Record<string, ProjectShell>;
  threads: Record<string, ThreadShell>;
  /** Roster lines from the gateway, cached here so home paints before it answers. */
  previews: Record<string, ThreadPreview>;
  threadMeta: Record<string, ThreadMeta>;
  providers: Provider[];
  /** T3's per-provider hidden models and model order (`server.getConfig().settings`). */
  providerModelPreferences: ProviderModelPreferences;
  /** Model picker favorites, kept in this browser. */
  tasks: ScheduledTask[];
  threadData: Record<string, ThreadData>;
  selected: string | null;
  selectedThreadId: string | null;
  exchangeBotSlug: string | null;
  detailsOpen: boolean;
  sidebarCompact: boolean;
  sidebarWidth: number;
  detailsWidth: number;
  detailsTab: DetailsTab;
  dialog: Dialog;
  searchSession: SearchSession;
  searchResultRevision: number;
  settingsPane: string;
  toast: string | null;
  /** A link shown after the toast's text, such as release notes. `open` handles it in the app instead. */
  toastLink: ToastLink | null;
  page: "projects" | "map" | "room" | null;
  projectItemId: string | null;
  /** Rooms: summaries for the sidebar, the open room and its 2 s view poll. */
  rooms: Record<string, RoomSummary>;
  roomView: RoomView | null;
  selectedRoom: string | null;
  roomError: string | null;
  /** When this browser last opened each room; drives the sidebar's unread dot. */
  roomSeen: Record<string, string>;
  /** The Vault without passwords (null until loaded). */
  vault: VaultItem[] | null;
  /** Settings → Machines: this machine first, then the ones T3 links or Threebot reaches directly. Null until loaded. */
  machines: Machine[] | null;
};

function readRoomSeen(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem("threebot.rooms.seen") ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, string> : {};
  } catch { return {}; }
}

export const useApp = create<State>(() => ({
  runtimeFeatures: { shellOlderSettled: false, threadFind: false, threadResumeCompletionMarker: false, sideChats: false, threadForceStop: false, voiceTranscription: false, freshContext: false, scheduledTaskThreadModes: false },
  snoozePresets: [],
  fallbackModel: null,
  sideChat: null,
  archiveError: null,
  olderSettledCursor: null,
  archivedThreads: {},
  auth: "unknown",
  connection: "closed",
  offline: false,
  roomStale: false,
  roomMissing: false,
  roomGone: false,
  announcement: "",
  botsRoot: "",
  executorUrl: null,
  settings: null,
  bots: {},
  historicalBots: {},
  projects: {},
  threads: {},
  previews: loadPreviews(),
  threadMeta: {},
  providers: [],
  providerModelPreferences: {},
  tasks: [],
  threadData: {},
  selected: localStorage.getItem("bot.selected"),
  selectedThreadId: null,
  exchangeBotSlug: null,
  detailsOpen: localStorage.getItem("bot.details") !== "0",
  sidebarCompact: localStorage.getItem("bot.sidebar.compact") === "1",
  sidebarWidth: columnWidth("sidebar", localStorage.getItem("bot.sidebar.width")),
  detailsWidth: columnWidth("details", localStorage.getItem("bot.details.width")),
  detailsTab: "details",
  dialog: null,
  searchSession: { query: "", filter: "All", index: 0, scrollTop: 0 },
  searchResultRevision: 0,
  settingsPane: "general",
  toast: null,
  toastLink: null,
  page: null,
  projectItemId: null,
  rooms: {},
  roomView: null,
  selectedRoom: null,
  roomError: null,
  roomSeen: readRoomSeen(),
  vault: null,
  machines: null,
}));

const set = useApp.setState;
const get = useApp.getState;

// ---------- boot ----------
let booted = false;
let runtimeStarted = false;
let bootRequest: Promise<void> | null = null;
export function boot(): Promise<void> {
  if (booted) return Promise.resolve();
  if (bootRequest) return bootRequest;
  bootRequest = Promise.resolve().then(initialize).finally(() => { bootRequest = null; });
  return bootRequest;
}

async function initialData() {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("Bot startup timed out"));
    }, 15_000);
  });
  try {
    return await Promise.race([
      Promise.all([api.config(controller.signal), api.settings(controller.signal), api.bots(controller.signal), api.botIdentities(controller.signal).catch(() => [])]),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

/** Access returns here after sign-in; the app itself only lives at the route it came from. */
function leaveLoginRoute() {
  if (!/\/login\/?$/.test(location.pathname)) return;
  const next = new URLSearchParams(location.search).get("next") ?? location.pathname.replace(/login\/?$/, "");
  const target = new URL(next, location.origin);
  history.replaceState(null, "", target.origin === location.origin ? target.pathname + target.search : location.pathname.replace(/login\/?$/, ""));
}

async function initialize() {
  set({ auth: "loading" });
  try {
    leaveLoginRoute();
    const boot = await readBoot();
    // A device that opened this app before paints what it kept at once; the gateway is asked behind
    // that paint, so no launch waits on a timeout a phone may take seconds to give.
    if (boot) {
      openFromCopy(boot);
      void confirmLaunch();
      return;
    }
    const session = await api.session();
    if (!session.authenticated) return signedOut(session);
    const [config, settings, bots, historical] = await initialData();
    set({ botsRoot: config.botsRoot, executorUrl: config.executorUrl ?? null, settings, bots: Object.fromEntries(bots.map((b) => [b.slug, b])), historicalBots: Object.fromEntries(historical.map((b) => [`archived:${b.mainThreadId}`, b])) });
    keepBoot({ botsRoot: config.botsRoot, executorUrl: config.executorUrl ?? null, settings, bots, historical });
    openRoute(bots, historical);
    void loadRooms().catch(() => {});
    startRuntime();
    t3.connect();
    void loadVault();
    void loadMachines();
    booted = true;
    set({ auth: "ready" });
  } catch {
    set({ auth: "error" });
  }
}

/**
 * The launch that painted from the copy on screen: ask the gateway properly, now that nobody is
 * waiting. A changed password wins over the copy; a refused launch leaves the copy on screen.
 */
async function confirmLaunch() {
  const session = await api.session().catch(() => null);
  // Asked and unanswered: the gateway is not reachable, unless the socket opened in the meantime.
  if (!session) return get().connection === "open" ? undefined : set({ offline: true });
  if (!session.authenticated) return signedOut(session);
  try {
    const revision = botsRevision;
    const [config, settings, bots, historical] = await initialData();
    if (get().auth !== "ready") return;
    set({ botsRoot: config.botsRoot, executorUrl: config.executorUrl ?? null, settings });
    // A Bot created or deleted while this was in flight is newer than the roster it fetched.
    if (revision === botsRevision && !pendingBotMutations) {
      set({ bots: Object.fromEntries(bots.map((b) => [b.slug, b])), historicalBots: Object.fromEntries(historical.map((b) => [`archived:${b.mainThreadId}`, b])) });
      keepBoot({ botsRoot: config.botsRoot, executorUrl: config.executorUrl ?? null, settings, bots, historical });
    }
    // A Bot or room the copy did not know about (added on another device) is still reachable by URL.
    openRoute(Object.values(get().bots), Object.values(get().historicalBots));
    void loadRooms().catch(() => {});
    // The copy carries neither of these, and the first paint must not be the last word on them.
    void loadVault();
    void loadMachines();
  } catch {
    // The gateway answered the session but not the rest: the copy stays, the socket keeps trying.
  }
}

/**
 * Where the URL points: a Bot, a thread on a linked machine, the Projects page, or a room.
 * The URL's room is opened once per launch: asking the gateway again must not close what is on screen.
 */
let routeRoomOpened = false;
function openRoute(bots: Bot[], historical: Bot[]) {
  const route = new URLSearchParams(location.search);
  const routeRoom = /^[A-Za-z0-9_-]{1,64}$/.test(route.get("room")?.trim() ?? "") ? route.get("room")!.trim() : null;
  const routeBot = bots.find((b) => b.slug === route.get("bot")) ?? historical.find((b) => `archived:${b.mainThreadId}` === route.get("bot"));
  if (!routeBot && route.get("environment") && route.get("thread")) set({ selected: bots.find((bot) => bot.slug === get().selected)?.slug ?? bots.find((bot) => bot.primary)?.slug ?? bots[0]?.slug ?? null, selectedThreadId: threadKey({ environmentId: route.get("environment")!, threadId: route.get("thread")! }) });
  if (route.get("page") === "projects" || route.get("item")) set({ page: "projects", projectItemId: /^[a-z0-9]{4,24}$/.test(route.get("item") ?? "") ? route.get("item") : null });
  else if (route.get("page") === "map") openBotMap();
  if (routeBot) set({ selected: bots.includes(routeBot) ? routeBot.slug : `archived:${routeBot.mainThreadId}`, selectedThreadId: route.get("thread") && route.get("environment") ? threadKey({ environmentId: route.get("environment")!, threadId: route.get("thread")! }) : route.get("thread"), exchangeBotSlug: bots.some((b) => b.slug === route.get("exchange")) ? route.get("exchange") : null });
  if (routeRoom && !routeRoomOpened) {
    routeRoomOpened = true;
    selectRoom(routeRoom);
  }
}

/**
 * What this device kept, painted at once. "Offline" is claimed only when the browser already knows
 * there is no network; otherwise the copy is simply a copy until the socket proves otherwise.
 */
function openFromCopy(boot: CachedBoot) {
  copied = true;
  set({ botsRoot: boot.botsRoot, executorUrl: boot.executorUrl, settings: boot.settings, bots: Object.fromEntries(boot.bots.map((b) => [b.slug, b])), historicalBots: Object.fromEntries(boot.historical.map((b) => [`archived:${b.mainThreadId}`, b])) });
  // The URL still points where the user was: a room opens from its copy, a thread from its view.
  openRoute(boot.bots, boot.historical);
  void hydrateRooms();
  void loadRooms().catch(() => {});
  startRuntime();
  t3.connect();
  booted = true;
  set({ auth: "ready", offline: navigator.onLine === false });
}

/** What the next launch needs when the gateway cannot be reached. Best effort: a full quota changes nothing here. */
function keepBoot(boot: Omit<CachedBoot, "v" | "savedAt">) {
  void writeBoot(boot);
}

/**
 * The gateway no longer knows this browser (signed out elsewhere, a changed password, an expired
 * sign-in): whoever signs in next must not be shown what the last session kept.
 */
function signedOut(session: { accessLogin: boolean; passwordRequired: boolean }) {
  void forgetDeviceCopy();
  set({ auth: session.accessLogin ? "access" : session.passwordRequired ? "password" : "error" });
}

/** This launch painted a copy before asking: the one thing that makes an offline claim honest later. */
let copied = false;
/** Signing out is the last write: nothing on screen may be saved after it. */
let forgetting = false;

function startRuntime() {
  if (runtimeStarted) return;
  let live = false;
  let failures = 0;
  t3.onState((connection) => {
    if (connection === "open") {
      const was = get().offline;
      live = true;
      failures = 0;
      set({ connection, offline: false });
      // Same page, new state: a screen reader hears the change, a first paint stays quiet.
      if (copied && was) announce("Connected");
      return;
    }
    // Connecting says nothing about reachability, and a retry must not undo what we already know.
    if (connection !== "closed") return set({ connection });
    failures++;
    const known = navigator.onLine === false || live;
    // A socket that never opened gets two tries before the copy is called offline: one dropped
    // attempt on a phone is a retry, not news.
    const offlineNow = known || get().offline || (copied && failures >= 2);
    if (offlineNow && !get().offline) announce(navigator.onLine === false ? "Offline. Showing saved copies." : "Disconnected. Showing saved copies.");
    set({ connection, offline: offlineNow });
  });
  t3.onReconnect(() => {
    subscribeShell();
    subscribeTasks();
    loadProviders();
    void loadArchivedThreads();
    resubscribeThreads();
  });
  // A phone suspends the page: on return the socket may be dead or waiting out a retry.
  const wake = () => { if (document.visibilityState === "visible") for (const client of allT3Clients()) client.checkAlive(); };
  document.addEventListener("visibilitychange", wake);
  window.addEventListener("online", () => {
    // A socket that stayed open never fires "open" again: the radio coming back is enough to trust it.
    if (get().offline && get().connection === "open") {
      set({ offline: false });
      announce("Connected");
    }
    wake();
  });
  window.addEventListener("pageshow", wake);
  // A page that leaves keeps whatever is on screen: the next launch starts from it.
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushCache(); });
  window.addEventListener("pagehide", flushCache);
  try { forgetListener = new BroadcastChannel(FORGET_CHANNEL); forgetListener.onmessage = () => stopSaving();
    // Node (the tests) keeps a process alive for an open channel; a browser page does not care.
    (forgetListener as BroadcastChannel & { unref?: () => void }).unref?.(); } catch { /* a single tab is all there is */ }
  // The radio is the fastest and most reliable witness: it says "offline" before any request fails.
  window.addEventListener("offline", () => {
    if (!get().offline) announce(copied ? "Offline. Showing saved copies." : "Offline.");
    set({ offline: true });
  });
  window.setInterval(() => { if (navigator.onLine !== false) void refreshBots(); }, 5_000);
  window.setInterval(() => { if (document.visibilityState === "visible" && navigator.onLine !== false) void loadMachines(); }, 60_000);
  runtimeStarted = true;
}

/** Runs the launch again in a test, where one process gets one real launch. */
export function resetBootForTest() {
  booted = false;
  bootRequest = null;
  routeRoomOpened = false;
  forgetting = false;
}

/** Says one short line to assistive tech, and clears it so the same words can be said again later. */
let clearAnnouncement: ReturnType<typeof setTimeout> | undefined;
export function announce(text: string) {
  clearTimeout(clearAnnouncement);
  set({ announcement: text });
  clearAnnouncement = setTimeout(() => set({ announcement: "" }), 4_000);
}

// ---------- vault ----------
/**
 * Signing out (or handing the device to someone else) must leave nothing readable behind. Saving
 * stops first: a page that leaves flushes what is on screen, and that must not undo the erase.
 */
export async function forgetDeviceCopy() {
  // Every other open tab stops saving too, so none writes a transcript back after the erase.
  try { const channel = new BroadcastChannel(FORGET_CHANNEL); channel.postMessage("forget"); channel.close(); } catch { /* no other tabs to tell */ }
  stopSaving();
  await clearCache().catch(() => {});
}

let forgetListener: BroadcastChannel | null = null;
function stopSaving() {
  forgetting = true;
  for (const timer of cacheTimers.values()) clearTimeout(timer);
  cacheTimers.clear();
  stopCacheWrites();
  resetAssetCopies();
}

export async function loadVault() {
  const items = await vaultApi.list().catch(() => null);
  if (items) set({ vault: items });
  return items;
}

export async function refreshBots() {
  const revision = botsRevision;
  // A phone that cannot reach the gateway must not queue a request every five seconds.
  const [bots, historical] = await Promise.all([api.bots(deadline(GATEWAY_PATIENCE_MS)).catch(() => null), api.botIdentities(deadline(GATEWAY_PATIENCE_MS)).catch(() => null)]);
  if (!bots) {
    const session = await api.session().catch(() => null);
    if (session && !session.authenticated) signedOut(session);
    return;
  }
  if (revision !== botsRevision || pendingBotMutations) return;
  set({ bots: Object.fromEntries(bots.map((b) => [b.slug, b])) });
  if (historical) set({ historicalBots: Object.fromEntries(historical.map((b) => [`archived:${b.mainThreadId}`, b])) });
  keepBoot({ botsRoot: get().botsRoot, executorUrl: get().executorUrl, settings: get().settings, bots, historical: historical ?? Object.values(get().historicalBots) });
}

async function loadProviders() {
  const cfg = await t3.call("server.getConfig", {}).catch(() => null);
  if (cfg)
    set({
      providers: cfg.providers.filter((p: Provider) => p.enabled && p.status === "ready"),
      providerModelPreferences: cfg.settings?.providerModelPreferences ?? {},
      runtimeFeatures: { shellOlderSettled: cfg.shellOlderSettled === true, threadFind: cfg.threadFind === true, threadResumeCompletionMarker: cfg.threadResumeCompletionMarker === true, sideChats: cfg.environment?.capabilities?.sideChats === true, threadForceStop: cfg.environment?.capabilities?.threadForceStop === true, voiceTranscription: cfg.environment?.capabilities?.voiceTranscription === true, freshContext: cfg.environment?.capabilities?.freshContext === true, scheduledTaskThreadModes: cfg.environment?.capabilities?.scheduledTaskThreadModes === true },
      snoozePresets: cfg.settings?.snoozePresets ?? [],
      fallbackModel: cfg.settings?.fallbackModelSelection ?? null,
    });
}

let shellSub: StreamHandle | null = null;
// The shell intentionally omits idle children. Retain families fetched for open
// conversations across reconnect snapshots, without retaining removed roots.
const familyThreadIds = new Set<string>();
// A Bot's conversation stays known through a partial snapshot. Details reads its model and status from it.
const mainThreadIds = (s: { bots: Record<string, Bot> }) => new Set(Object.values(s.bots).map((bot) => bot.mainThreadId));
function subscribeShell() {
  shellSub?.cancel();
  shellSub = t3.stream("orchestration.subscribeShell", { omitIdleSubagents: true }, (it) => {
    if (it.kind === "snapshot") {
      const snap = it.snapshot;
      if (isProjectEnrichment(it)) {
        set((s) => ({ projects: { ...s.projects, ...Object.fromEntries(snap.projects.map((p: ProjectShell) => [p.id, p])) } }));
        return;
      }
      set((s) => ({
        projects: { ...s.projects, ...Object.fromEntries(snap.projects.map((p: ProjectShell) => [p.id, p])) },
        threads: { ...Object.fromEntries(Object.entries(s.threads).filter(([id]) => familyThreadIds.has(id) || mainThreadIds(s).has(id))), ...s.archivedThreads, ...Object.fromEntries(snap.threads.map((t: ThreadShell) => [t.id, t])) },
      }));
      schedulePreviews();
      closeAnsweredNotifications();
    } else if (it.kind === "project.updated") {
      set((s) => ({ projects: { ...s.projects, [it.project.id]: it.project } }));
    } else if (it.kind === "project.removed") {
      set((s) => {
        const projects = { ...s.projects };
        delete projects[it.projectId];
        return { projects };
      });
    } else if (it.kind === "thread.updated") {
      if (it.location === "archive") {
        closeThreadNotices(it.thread.id);
        queueMicrotask(closeAnsweredNotifications);
        set((s) => ({ archivedThreads: { ...s.archivedThreads, [it.thread.id]: it.thread }, threads: { ...s.threads, [it.thread.id]: it.thread } }));
        return;
      }
      const prev = get().threads[it.thread.id];
      set((s) => { const archivedThreads = { ...s.archivedThreads }; delete archivedThreads[it.thread.id]; return { archivedThreads, threads: { ...s.threads, [it.thread.id]: it.thread } }; });
      schedulePreviews();
      notifyIfNeeded(prev, it.thread);
    } else if (it.kind === "thread.removed") {
      forgetThreadCopy([it.threadId]);
      closeThreadNotices(it.threadId);
      queueMicrotask(closeAnsweredNotifications);
      set((s) => {
        const threads = { ...s.threads };
        delete threads[it.threadId];
        familyThreadIds.delete(it.threadId);
        const archivedThreads = { ...s.archivedThreads }; delete archivedThreads[it.threadId];
        return { threads, archivedThreads };
      });
    }
  });
}

// ---------- roster previews ----------
let previewTimer: ReturnType<typeof setTimeout> | undefined;
function schedulePreviews() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => void refreshPreviews(), 400);
}

export async function refreshPreviews() {
  const { bots, threads } = get();
  const stamps = Object.fromEntries(Object.values(bots).flatMap((bot) => {
    const thread = bot.mainThreadId ? threads[bot.mainThreadId] : undefined;
    return thread ? [[thread.id, thread.updatedAt]] : [];
  }));
  if (!Object.keys(stamps).length) return {};
  const previews = await api.threadPreviews(stamps).catch(() => null);
  if (!previews) return {};
  const current = Object.fromEntries(Object.entries(previews).filter(([id]) => get().threads[id]?.updatedAt === stamps[id]));
  set((s) => ({ previews: { ...s.previews, ...current } }));
  try { localStorage.setItem(PREVIEWS_KEY, JSON.stringify(get().previews)); }
  catch { /* The cache only speeds up the next launch. */ }
  return current;
}

// ---------- reactions and voice call log ----------
export async function loadThreadMeta(threadId: string) {
  if (threadTarget(threadId).environmentId) return;
  const meta = await api.threadMeta(threadId).catch(() => null);
  if (meta) set((s) => ({ threadMeta: { ...s.threadMeta, [threadId]: { ...meta, voiceCalls: (meta.voiceCalls ?? []).filter((call) => call.seconds >= 10) } } }));
}

export async function toggleReaction(threadId: string, itemId: string, emoji: string) {
  if (threadTarget(threadId).environmentId) throw new Error("Reactions are not available on this linked machine");
  const meta = await api.toggleReaction(threadId, itemId, emoji);
  set((s) => ({ threadMeta: { ...s.threadMeta, [threadId]: { ...meta, voiceCalls: (meta.voiceCalls ?? []).filter((call) => call.seconds >= 10) } } }));
}

export async function recordVoiceCall(threadId: string, seconds: number) {
  if (seconds < 10) return;
  if (threadTarget(threadId).environmentId) return;
  const meta = await api.addVoiceCall(threadId, seconds);
  set((s) => ({ threadMeta: { ...s.threadMeta, [threadId]: { ...meta, voiceCalls: (meta.voiceCalls ?? []).filter((call) => call.seconds >= 10) } } }));
}

let taskSub: StreamHandle | null = null;
function subscribeTasks() {
  taskSub?.cancel();
  taskSub = t3.stream("scheduledTasks.subscribe", {}, (it) => set({ tasks: it.tasks ?? [] }));
}


// ---------- notifications ----------
/** The Bot the user is looking at right now, if any: nothing about it needs a notification. */
export function watchedBot(): string | null {
  return document.visibilityState === "visible" && document.hasFocus() ? get().selected : null;
}

/**
 * What this device has open and in focus, as the presence key the gateway compares against a push.
 * A room wins when the room page is showing. The selected Bot counts only when its chat is showing.
 * Returning both null means the page is not looking at either, so nothing should be held back.
 */
export function watchedView(): { bot: string | null; room: string | null } {
  if (document.visibilityState !== "visible" || !document.hasFocus()) return { bot: null, room: null };
  const state = get();
  if (state.page === "room" && state.selectedRoom) return { bot: null, room: state.selectedRoom };
  if (state.page) return { bot: null, room: null };
  return { bot: state.selected, room: null };
}
const ACTIVE = ["preparing", "queued", "starting", "running", "waiting"];
function notifyIfNeeded(prev: ThreadShell | undefined, next: ThreadShell) {
  if (!prev) return;
  const side = isSideChat(next);
  const ownerThreadId = side ? next.lineage.parentThreadId : next.id;
  const bot = Object.values(get().bots).find((b) => b.mainThreadId === ownerThreadId);
  if (!bot) return;
  // The request is gone: its notification is a stale reminder, even (above all) when it was answered
  // right here in the Bot this page is looking at.
  // closeAnsweredNotifications also clears an older per-Bot notice once this was the Bot's last wait.
  if (prev.pendingRuntimeRequest && !next.pendingRuntimeRequest) closeAnsweredNotifications();
  if (bot.notifications === false || bot.hidden) return;
  if (watchedBot() === bot.slug || next.archivedAt || isSnoozed(next)) return;
  if (!prev.pendingRuntimeRequest && next.pendingRuntimeRequest) {
    void notify(bot, side ? "A side chat is waiting for you" : "Waiting for you", "waiting", next.id);
  } else if (!side && ACTIVE.includes(prev.activityRunStatus ?? prev.status) && next.status === "completed") {
    void completionNotification(bot, next).catch(() => {});
  }
}

/** On a fresh shell: close "waiting" notices whose request was answered while this page was closed. */
function closeAnsweredNotifications() {
  const waits = (thread?: ThreadShell) => !!thread?.pendingRuntimeRequest && !thread.archivedAt;
  // State is read per notice, after the tray read: a conversation that starts waiting meanwhile keeps its notice.
  void closeNotifications((tag, body) => {
    const { threads, bots } = get();
    const id = waitingThread(tag);
    if (id !== null) return !!threads[id] && !waits(threads[id]);
    // Before per-conversation tags, a wait used the Bot's own tag: close it once none of that Bot's
    // conversations waits. A completion (any other text) keeps its notice.
    const bot = Object.values(bots).find((b) => b.slug === tag);
    if (!bot || !LEGACY_WAITING.has(body)) return false;
    return !Object.values(threads).some((thread) => waits(thread) && (thread.id === bot.mainThreadId || (isSideChat(thread) && thread.lineage.parentThreadId === bot.mainThreadId)));
  });
}
const LEGACY_WAITING = new Set(["Waiting for you", "A side chat is waiting for you"]);

export async function completionNotification(bot: Bot, completed: ThreadShell) {
  // Require output from this run; a stale cache or the user's prompt is not a completion body.
  const previews = await refreshPreviews();
  const preview = previews[completed.id];
  const runStarted = completed.latestRunStartedAt ?? completed.latestRunRequestedAt ?? completed.latestUserMessageAt;
  const fresh = preview?.role === "assistant" && preview.at && (!runStarted || preview.at >= runStarted);
  const current = get().threads[completed.id];
  if (current && current.latestRunId !== completed.latestRunId) return;
  return notify(bot, fresh ? preview.text.slice(0, 140) : "Finished", "finished", completed.id);
}

/** A waiting notification is per thread; a completion is per Bot, so three runs leave one notice. */
async function notify(bot: Bot, body: string, kind: "finished" | "waiting", threadId: string) {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  const target = notificationTarget(bot.slug, kind, threadId);
  const { title, options } = notificationContent({
    title: bot.name,
    body,
    tag: target.tag,
    url: target.url,
    icon: `/api/bots/${encodeURIComponent(bot.slug)}/avatar.png`,
    badge: botBadge(bot),
    timestamp: Date.now(),
  });
  // A request answered while the notice was still being shown (its icon loads first) must not stay.
  const stale = () => {
    const thread = get().threads[threadId];
    return kind === "waiting" && (!thread?.pendingRuntimeRequest || !!thread.archivedAt);
  };
  // Android has no page Notification constructor; only the worker can show one.
  const registration = await navigator.serviceWorker?.getRegistration();
  if (registration) {
    await registration.showNotification(title, options);
    if (stale()) void closeNotifications((tag) => tag === target.tag);
    return;
  }
  const notification = new Notification(title, options);
  pageNotices.get(target.tag)?.close();
  pageNotices.set(target.tag, notification);
  notification.onclose = () => { if (pageNotices.get(target.tag) === notification) pageNotices.delete(target.tag); };
  notification.onclick = () => {
    window.focus();
    // A waiting notice opens its own conversation (a side chat), as the worker's click does.
    if (kind === "waiting" && threadId !== bot.mainThreadId) selectThread(bot, threadId);
    else select(bot.slug);
    notification.close();
  };
  if (stale()) notification.close();
}

/** Notices made with the page's Notification constructor (no service worker, or the Mac app's bridge), by tag. */
const pageNotices = new Map<string, Notification>();

/** Best effort: iOS may accept this call and do nothing. */
async function closeNotifications(match: (tag: string, body: string) => boolean) {
  try {
    const registration = typeof navigator === "undefined" ? undefined : await navigator.serviceWorker?.getRegistration();
    for (const [tag, notification] of pageNotices) if (match(tag, notification.body)) notification.close();
    if (!registration?.getNotifications) return;
    for (const notification of await registration.getNotifications()) if (match(notification.tag, notification.body)) notification.close();
  } catch { /* A closed or unsupported notification is not an error worth showing. */ }
}

/** A thread that was archived or removed no longer waits for anyone. */
const closeThreadNotices = (threadId: string) => void closeNotifications((tag) => waitingThread(tag) === threadId);

export function requestNotificationPermission() {
  // Asked on a first message; a device where push was turned off in Settings stays off.
  if (pushTurnedOff()) return;
  void enablePushNotifications();
}

// ---------- thread subscriptions ----------
const threadSubs = new Map<string, { handle: StreamHandle; refs: number; bounded: boolean }>();
const environmentReconnects = new Set<string>();

function emptyThread(): ThreadData {
  return { items: {}, runs: {}, requests: {}, subagents: {}, loaded: false };
}

function patchThread(threadId: string, fn: (d: ThreadData) => ThreadData) {
  set((s) => ({ threadData: { ...s.threadData, [threadId]: fn(s.threadData[threadId] ?? emptyThread()) } }));
  scheduleCache(threadId);
}

function scopedShell(thread: ThreadShell, environmentId?: string): ThreadShell {
  if (!environmentId) return thread;
  const key = (id: string) => threadKey({ threadId: id, environmentId });
  return { ...thread, id: key(thread.id), environmentId, lineage: { ...thread.lineage, parentThreadId: thread.lineage.parentThreadId ? key(thread.lineage.parentThreadId) : null, rootThreadId: key(thread.lineage.rootThreadId) } };
}
/** The last stream sequence seen per thread, so reopening resumes from it instead of taking a new snapshot. */
const threadSequences = new Map<string, number>();
/** Threads whose received rows are their whole history (a full snapshot, or every older page loaded). */
const completeThreads = new Set<string>();
/** Bumped on every snapshot, so a history page requested against an older snapshot is dropped. */
const snapshotGenerations = new Map<string, number>();

/** The newest stream opened per thread; a replaced stream's late frames are ignored. */
const streamGenerations = new Map<string, number>();
/** Threads a room reads in full. Their copy keeps less: the room shows the recent turns. */
const roomThreads = new Set<string>();
/** Which room a member conversation belongs to, so the room's deletion takes its copy (former members too). */
const roomOfThread = new Map<string, string>();
function noteRoomMembers(room: RoomView) {
  for (const member of [...(room.members ?? []), ...(room.formerMembers ?? [])]) if (typeof member.threadId === "string" && member.threadId) roomOfThread.set(member.threadId, room.id);
}
/** Rooms deleted while this page was open: a list fetched before the deletion must not name them. */
const deletedRooms = new Set<string>();

/** bounded: open with recent rows only. Rooms read whole member histories, so they pass false. */
function openThreadStream(threadId: string, bounded = true): StreamHandle {
  const target = threadTarget(threadId);
  const stream = (streamGenerations.get(threadId) ?? 0) + 1;
  streamGenerations.set(threadId, stream);
  if (bounded) roomThreads.delete(threadId); else roomThreads.add(threadId);
  if (target.environmentId) familyThreadIds.add(threadId);
  // acceptBoundedSnapshot: a long thread opens with its recent rows only (older T3 ignores it and sends everything).
  // acceptCompactTurnItems: the rows a chat shows lead the full list, so T3 leaves their items out of turnItems
  // instead of sending each one twice. This client paints from visibleTurnItems, and reads turnItems only for
  // interrupt requests, which T3 keeps there as a retained dependency.
  const afterSequence = bounded || completeThreads.has(threadId) ? threadSequences.get(threadId) : undefined;
  const handle = threadClient(threadId).stream("orchestration.subscribeThread", { threadId: target.threadId, ...(bounded ? { acceptBoundedSnapshot: true, acceptCompactTurnItems: true } : {}), ...(afterSequence !== undefined ? { afterSequence } : {}), ...(!target.environmentId && get().runtimeFeatures.threadResumeCompletionMarker ? { requestCompletionMarker: true } : {}) }, (it) => {
    // A cancelled stream can still deliver its snapshot; it must not replace the newer stream's rows (a room's full history).
    if (streamGenerations.get(threadId) !== stream) return;
    if (it.kind === "snapshot") {
      const p = it.projection;
      if (p.thread) p.thread = scopedShell(p.thread, target.environmentId);
      if (p.thread) set((s) => ({ threads: { ...s.threads, [p.thread.id]: { ...s.threads[p.thread.id], ...p.thread } } }));
      const items: Record<string, TurnItem> = {};
      for (const v of p.visibleTurnItems ?? []) items[v.item.id] = v.item;
      // With turnItemsOmitLocalVisible the rows above are the whole answer: T3 left their items out of turnItems.
      if (!p.visibleTurnItems?.length) for (const i of p.turnItems ?? []) items[i.id] = i;
      // Run controls read interrupt requests, which T3 may keep only in turnItems.
      else for (const i of p.turnItems ?? []) if (i.type === "run_interrupt_request" && !items[i.id]) items[i.id] = i;
      patchThread(threadId, () => ({
        items,
        runs: Object.fromEntries((p.runs ?? []).map((r: Run) => [r.id, r])),
        requests: Object.fromEntries((p.runtimeRequests ?? []).map((r: RuntimeRequest) => [r.id, r])),
        subagents: Object.fromEntries((p.subagents ?? []).map((agent: Subagent) => [agent.id, agent])),
        loaded: true,
        stale: false,
        historyCursor: it.hasMoreHistory ? it.historyCursor ?? null : null,
        hasMoreHistory: it.hasMoreHistory === true && typeof it.historyCursor === "string",
      }));
      if (typeof it.snapshotSequence === "number") threadSequences.set(threadId, it.snapshotSequence);
      snapshotGenerations.set(threadId, (snapshotGenerations.get(threadId) ?? 0) + 1);
      if (it.hasMoreHistory === true) completeThreads.delete(threadId); else completeThreads.add(threadId);
      if (p.subagents?.length) void loadThreadFamily(threadId);
    } else if (it.kind === "synchronized") {
      patchThread(threadId, (d) => ({ ...d, loaded: true }));
    } else if (it.kind === "event") {
      if (typeof it.sequence === "number" && it.sequence > (threadSequences.get(threadId) ?? -1)) threadSequences.set(threadId, it.sequence);
      const ev = it.event;
      if (ev.type === "turn-item.updated") patchThread(threadId, (d) => ({ ...d, items: { ...d.items, [ev.payload.id]: ev.payload } }));
      else if (ev.type === "run.created" || ev.type === "run.updated") patchThread(threadId, (d) => ({ ...d, runs: { ...d.runs, [ev.payload.id]: ev.payload } }));
      else if (ev.type === "runtime-request.updated") patchThread(threadId, (d) => ({ ...d, requests: { ...d.requests, [ev.payload.id]: ev.payload } }));
      else if (ev.type === "subagent.updated") {
        patchThread(threadId, (d) => ({ ...d, subagents: { ...d.subagents, [ev.payload.id]: { ...d.subagents?.[ev.payload.id], ...ev.payload } } }));
        if (ev.payload.childThreadId) void loadThreadFamily(threadId);
      } else if (["thread.settled", "thread.unsettled", "thread.snoozed", "thread.unsnoozed"].includes(ev.type)) {
        set((s) => ({ threads: { ...s.threads, [threadId]: { ...s.threads[threadId], ...ev.payload, id: threadId } } }));
      }
    }
  });
  // Paint this device's copy while T3 builds the snapshot; the snapshot replaces it whole.
  void hydrateThread(threadId, stream);
  return handle;
}

// ---------- the device's own copy ----------
/** A write pending per conversation, so a streaming turn saves at most once a second instead of per frame. */
const cacheTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** Conversations deleted while this page was open: a late frame must not save them back. */
const forgottenThreads = new Set<string>();

/** A deleted conversation leaves no copy on this device. */
export function forgetThreadCopy(threadIds: string[]) {
  for (const threadId of threadIds) {
    forgottenThreads.add(threadId);
    clearTimeout(cacheTimers.get(threadId));
    cacheTimers.delete(threadId);
  }
  // Its kept pictures go too, and the handles already drawn from them stop working.
  void forgetRecords(threadIds.map((threadId) => `view:${threadId}`), { deleted: true }).then(revokeAssetHandles);
  set((s) => {
    const threadData = { ...s.threadData };
    for (const threadId of threadIds) if (threadData[threadId]?.stale) delete threadData[threadId];
    return { threadData };
  });
}

function scheduleCache(threadId: string) {
  if (forgetting || cacheTimers.has(threadId) || forgottenThreads.has(threadId)) return;
  cacheTimers.set(threadId, setTimeout(() => { cacheTimers.delete(threadId); void saveThread(threadId); }, 1200));
}

/** Keeps the newest window for the next cold start. Never the source of a paint: the snapshot always replaces it. */
async function saveThread(threadId: string) {
  if (forgetting || forgottenThreads.has(threadId)) return;
  // A linked machine keeps its history in its own T3; this cache is for this machine's threads.
  if (threadTarget(threadId).environmentId) return;
  const data = get().threadData[threadId];
  // A stale thread is what a cache read put here: writing it back would renew a copy nobody refreshed.
  if (!data?.loaded || data.stale) return;
  await writeView({
    v: 1,
    key: threadId,
    savedAt: Date.now(),
    thread: get().threads[threadId] ?? null,
    // A restored or partially built projection may carry only what it needs; the copy takes it as it is.
    items: Object.values(data.items ?? {}),
    runs: Object.values(data.runs ?? {}),
    requests: Object.values(data.requests ?? {}),
    subagents: Object.values(data.subagents ?? {}),
    historyCursor: data.historyCursor ?? null,
    hasMoreHistory: data.hasMoreHistory === true,
  }, roomThreads.has(threadId) ? ROOM_VIEW_BYTES : undefined, roomOfThread.has(threadId) ? `room:${roomOfThread.get(threadId)}` : undefined);
}

function flushCache() {
  if (forgetting) return;
  for (const [threadId, timer] of cacheTimers) {
    clearTimeout(timer);
    cacheTimers.delete(threadId);
    void saveThread(threadId);
  }
}

/** Paints the last copy while T3 builds the snapshot. A snapshot, or a newer stream, wins over it. */
async function hydrateThread(threadId: string, generation: number) {
  if (get().threadData[threadId]?.loaded) return;
  const view = await readView(threadId);
  if (!view) {
    // Nothing kept for this conversation: say so instead of leaving a spinner over an empty screen.
    if (streamGenerations.get(threadId) === generation) patchThread(threadId, (data) => data.loaded ? data : { ...data, copyChecked: true });
    return;
  }
  // A snapshot that landed while the read was in flight, or a stream that replaced this one, is the truth.
  if (get().threadData[threadId]?.loaded || streamGenerations.get(threadId) !== generation || forgottenThreads.has(threadId)) return;
  if (view.thread && !get().threads[view.thread.id]) set((s) => ({ threads: { ...s.threads, [view.thread!.id]: view.thread! } }));
  patchThread(threadId, (data) => data.loaded ? data : {
    items: Object.fromEntries(view.items.flatMap((item) => item && typeof item.id === "string" ? [[item.id, item] as const] : [])),
    runs: Object.fromEntries(view.runs.flatMap((run) => run && typeof run.id === "string" ? [[run.id, run] as const] : [])),
    requests: Object.fromEntries(view.requests.flatMap((request) => request && typeof request.id === "string" ? [[request.id, request] as const] : [])),
    subagents: Object.fromEntries(view.subagents.flatMap((agent) => agent && typeof agent.id === "string" ? [[agent.id, agent] as const] : [])),
    loaded: true,
    stale: true,
    copyChecked: true,
    historyCursor: view.historyCursor,
    hasMoreHistory: view.hasMoreHistory,
  });
}

const olderLoads = new Set<string>();/** Prepends the next page of older rows of a bounded thread. Resolves true when rows were added. */
export async function loadOlderMessages(threadId: string): Promise<boolean> {
  const data = get().threadData[threadId];
  // A saved copy's cursor is old news: older rows load once the live snapshot is in.
  if (!data?.hasMoreHistory || !data.historyCursor || data.stale || olderLoads.has(threadId)) return false;
  olderLoads.add(threadId);
  const generation = snapshotGenerations.get(threadId);
  try {
    const target = threadTarget(threadId);
    const page = await environmentHttp<{ items?: { item: TurnItem }[]; nextCursor?: string | null; hasMoreHistory?: boolean }>(target.environmentId, `/api/orchestration/threads/${encodeURIComponent(target.threadId)}/history?cursor=${encodeURIComponent(data.historyCursor)}`);
    if (snapshotGenerations.get(threadId) !== generation) return false;
    // Rows a fork (a side chat) inherits keep their source thread's threadId, as in the snapshot, so they are kept.
    const older = Object.fromEntries((page.items ?? []).flatMap((row) => {
      const item = row?.item;
      return item && typeof item.id === "string" ? [[item.id, item]] : [];
    }));
    if (page.hasMoreHistory !== true) completeThreads.add(threadId);
    patchThread(threadId, (d) => ({ ...d, items: { ...older, ...d.items }, historyCursor: page.nextCursor ?? null, hasMoreHistory: page.hasMoreHistory === true && typeof page.nextCursor === "string" }));
    return Object.keys(older).length > 0;
  } catch (error) {
    toast(error instanceof Error ? error.message : "Couldn't load earlier messages");
    return false;
  } finally {
    olderLoads.delete(threadId);
  }
}

export function watchThread(threadId: string, bounded = true) {
  const existing = threadSubs.get(threadId);
  if (existing) {
    existing.refs++;
    // A room needs the whole history: a bounded stream already open on this thread (its chat) reopens with a full snapshot.
    if (existing.bounded && !bounded) {
      existing.handle.cancel();
      existing.bounded = false;
      existing.handle = subscribedThread(threadId, false);
    }
  } else {
    const environmentId = threadTarget(threadId).environmentId;
    if (environmentId && !environmentReconnects.has(environmentId)) {
      environmentReconnects.add(environmentId);
      threadClient(threadId).onReconnect(() => {
        for (const [key, sub] of threadSubs) if (threadTarget(key).environmentId === environmentId && !sub.handle.live()) {
          sub.handle.cancel(); sub.handle = subscribedThread(key, sub.bounded);
        }
      });
    }
    threadSubs.set(threadId, { handle: subscribedThread(threadId, bounded), refs: 1, bounded });
  }
  return () => {
    const sub = threadSubs.get(threadId);
    if (!sub) return;
    if (--sub.refs <= 0) {
      sub.handle.cancel();
      threadSubs.delete(threadId);
    }
  };
}

function subscribedThread(threadId: string, bounded: boolean) {
  const handle = openThreadStream(threadId, bounded);
  void handle.done.catch((error: unknown) => {
    patchThread(threadId, (data) => ({ ...data, loaded: true }));
    toast(error instanceof Error ? error.message : "Couldn't read this conversation");
  });
  return handle;
}
/** After a (re)connect: reopen each watched thread whose stream didn't reach this socket. Streams sent on it already are live. */
function resubscribeThreads() {
  for (const [threadId, sub] of threadSubs) {
    if (threadTarget(threadId).environmentId || sub.handle.live()) continue;
    sub.handle.cancel();
    sub.handle = subscribedThread(threadId, sub.bounded);
  }
}

// ---------- selectors ----------
export function botProject(bot: Bot, s = get()) {
  return bot.projectId ? s.projects[bot.projectId] : undefined;
}

export function mainThread(bot: Bot, s = get()) {
  return bot.mainThreadId ? s.threads[bot.mainThreadId] : undefined;
}

export function conversationStatus(threadId: string, s = get()) {
  const thread = s.threads[threadId];
  const parent = thread?.lineage.parentThreadId;
  const data = parent ? s.threadData[parent] : undefined;
  const agent = [...Object.values(data?.items ?? {}), ...Object.values(data?.subagents ?? {})]
    .filter((item) => item.childThreadId === threadId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  return agentStatus({ thread, fallback: agent?.status, updatedAt: agent?.updatedAt });
}

/** conversationStatus, except that with Beta → "Settle Bot threads in T3 Code" a settled Bot main thread is idle, not finished. */
export function botThreadStatus(bot: Pick<Bot, "mainThreadId">, threadId: string, s = get()) {
  const status = conversationStatus(threadId, s);
  return status === "completed" && threadId === bot.mainThreadId && s.settings?.beta?.settleBotThreads === true ? "idle" : status;
}

export function isSnoozed(thread: ThreadShell | undefined, now = Date.now()) { return !!thread?.snoozedUntil && Date.parse(thread.snoozedUntil) > now; }
export function isSettled(thread: ThreadShell | undefined) { return thread?.settledOverride === "settled" || (thread?.settledOverride !== "active" && !!thread?.settledAt); }
export type BotStatus = "idle" | "working" | "waiting" | "failed" | "unread" | "new" | "done";

export function botStatus(bot: Bot, s = get()): BotStatus {
  const t = mainThread(bot, s);
  if (!t) return "new";
  if (t.pendingRuntimeRequest) return "waiting";
  if (["preparing", "queued", "starting", "running", "waiting"].includes(t.activityRunStatus ?? t.status)) return "working";
  const last = t.latestVisibleMessage;
  // mark-unread rewinds the visit to one millisecond before run completion,
  // which can be later than the final assistant message. Older servers omit it.
  const unreadAt = t.latestRunCompletedAt === undefined ? (last?.role === "assistant" ? last.updatedAt : null) : t.latestRunCompletedAt;
  // A settled thread (T3 settles idle ones) can still hold a reply nobody has read.
  if (unreadAt && (!t.lastVisitedAt || unreadAt > t.lastVisitedAt) && s.selected !== bot.slug) return "unread";
  // With Beta → "Settle Bot threads in T3 Code" every quiet Bot is settled, so settled isn't "finished".
  if (isSettled(t) && s.settings?.beta?.settleBotThreads !== true) return t.status === "failed" ? "failed" : "done";
  if (t.status === "failed" || t.lastErrorClass) return "failed";
  return "idle";
}

// The user's T3 defaults: Claude Opus 5.5 at medium effort, then GPT-6.1 Sol.
const PREFERRED_MODEL: ModelSelection = { instanceId: "claudeAgent", model: "claude-opus-5-5", options: [{ id: "effort", value: "medium" }] };
const FALLBACK_MODEL: ModelSelection = { instanceId: "codex", model: "gpt-6.1-sol" };

export function defaultModel(s = get()): ModelSelection | null {
  if (s.settings?.defaultModel) return s.settings.defaultModel;
  // Before T3 reports its providers, assume the preferred default (the gateway uses the same one).
  if (s.providers.length === 0) return PREFERRED_MODEL;
  const available = (sel: ModelSelection) => s.providers.some((p) => p.instanceId === sel.instanceId && p.models.some((m) => m.slug === sel.model));
  if (available(PREFERRED_MODEL)) return PREFERRED_MODEL;
  if (available(FALLBACK_MODEL)) return FALLBACK_MODEL;
  const first = s.providers.find((p) => p.models.length > 0);
  return first ? { instanceId: first.instanceId, model: (first.models.find((m) => m.isDefault) ?? first.models[0]).slug } : null;
}


export function runtimeMode(s = get()) {
  return s.settings?.autoReview === false ? "full-access" : "auto";
}

// ---------- actions ----------
export function select(slug: string | null) {
  stopRoomPoll();
  set({ selected: slug, selectedThreadId: null, exchangeBotSlug: null, page: null, projectItemId: null, selectedRoom: null, roomView: null, roomStale: false, roomMissing: false, roomGone: false, roomError: null });
  if (slug) localStorage.setItem("bot.selected", slug);
  const bot = slug ? get().bots[slug] : null;
  if (bot?.mainThreadId) t3.dispatch({ type: "thread.visit", threadId: bot.mainThreadId, visitedAt: new Date().toISOString() }).catch(() => {});
}

// ---------- rooms ----------
let roomPoll: ReturnType<typeof setInterval> | null = null;
let roomPollId: string | null = null;
let roomPollBusy = false;
let roomPollTick = 0;

export function stopRoomPoll() {
  if (roomPoll !== null) clearInterval(roomPoll);
  roomPoll = null;
  roomPollId = null;
  roomPollTick = 0;
}

/** A request to this gateway that has not answered in this long is not going to. */
const GATEWAY_PATIENCE_MS = 8_000;
const deadline = (ms: number) => (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(ms) : undefined);

/**
 * The sidebar's room list: what this device kept answers first, the gateway refreshes behind it.
 * A phone that cannot reach the network does not hold the list until a request times out.
 */
export async function loadRooms() {
  await hydrateRooms();
  const fetched = await fetchRooms(deadline(GATEWAY_PATIENCE_MS)).catch(() => null);
  if (!fetched) return Object.values(get().rooms);
  // A list fetched before a room was deleted (in this tab or another) must not bring it back.
  const tombstoned = await deletedRecords(fetched.map((room) => `room:${room.id}`));
  const list = fetched.filter((room) => !deletedRooms.has(room.id) && !tombstoned.has(`room:${room.id}`));
  set({ rooms: Object.fromEntries(list.map((room) => [room.id, room])) });
  void writeRooms(list);
  return list;
}

/** Paints the kept list once, before any request: a cold start with no network still names the rooms. */
async function hydrateRooms() {
  if (Object.keys(get().rooms).length) return;
  const saved = await readRooms().catch(() => null);
  if (!saved || Object.keys(get().rooms).length) return;
  // Another tab may have deleted a room after this list was saved.
  const gone = await deletedRecords(saved.map((room) => `room:${room.id}`));
  const kept = saved.filter((room) => !gone.has(`room:${room.id}`) && !deletedRooms.has(room.id));
  if (Object.keys(get().rooms).length) return;
  set({ rooms: Object.fromEntries(kept.map((room) => [room.id, room])) });
}

/** Everything the room view renders; a poll that changes none of it must not replace the object. */
function roomFingerprint(room: RoomView): string {
  return [
    room.name,
    room.description,
    room.section ?? "",
    String(room.pinned),
    JSON.stringify(room.settings),
    room.members.map((member) => `${member.slug}:${member.threadId}:${member.status}:${member.lastTurnAt}`).join(","),
    (room.formerMembers ?? []).map((member) => `${member.slug}:${member.threadId}`).join(","),
    room.turns.map((turn) => `${turn.id}:${turn.status}:${turn.runs.map((run) => `${run.slug}:${run.runId}:${run.status ?? ""}:${run.late ?? ""}`).join("+")}`).join(","),
  ].join("|");
}

function roomActivity(room: RoomView): string | null {
  return [
    room.turns.at(-1)?.at ?? null,
    ...room.members.map((member) => member.lastTurnAt),
  ].filter((at): at is string => !!at).sort().at(-1) ?? null;
}

function summaryPatch(room: RoomView, existing: RoomSummary): RoomSummary {
  const lastTurn = room.turns.at(-1);
  return {
    ...existing,
    id: room.id,
    name: room.name,
    description: room.description,
    section: room.section,
    pinned: room.pinned,
    mode: room.settings.mode,
    members: room.members,
    lastTurnAt: lastTurn?.at ?? existing.lastTurnAt,
    lastActivityAt: roomActivity(room) ?? existing.lastActivityAt,
    lastText: lastTurn?.text.slice(0, 80) ?? room.description,
    queued: room.turns.filter((turn) => turn.status === "queued").length,
    running: room.turns.some((turn) => turn.status === "running"),
  };
}

export function markRoomSeen(id: string) {
  const roomSeen = { ...get().roomSeen, [id]: new Date().toISOString() };
  try { localStorage.setItem("threebot.rooms.seen", JSON.stringify(roomSeen)); } catch { /* private mode */ }
  set({ roomSeen });
}

export async function loadRoom(id: string, quiet = false) {
  try {
    const room = await fetchRoom(id, deadline(GATEWAY_PATIENCE_MS));
    if (get().selectedRoom !== id) return;
    // An answer that left before the room was found deleted is older than the deletion.
    if (deletedRooms.has(id) || get().roomGone || (await deletedRecords([`room:${id}`])).size) return;
    if (get().selectedRoom !== id || deletedRooms.has(id) || get().roomGone) return;
    const previous = get().roomView?.id === id ? get().roomView : null;
    noteRoomMembers(room);
    // The 2 s poll is for turns other devices start; an identical room must not re-render the page.
    // A saved copy is always replaced by the first live answer: its fingerprint does not cover everything it shows.
    if (previous && !get().roomStale && roomFingerprint(previous) === roomFingerprint(room)) {
      if (!quiet && get().roomError) set({ roomError: null });
      return;
    }
    set((s) => ({
      roomView: room,
      roomStale: false,
      roomMissing: false,
      roomGone: false,
      roomError: null,
      // Keep the sidebar row in step without another list request.
      rooms: s.rooms[room.id] ? { ...s.rooms, [room.id]: summaryPatch(room, s.rooms[room.id]) } : s.rooms,
    }));
    // A reply that arrives while the room is open has been seen; leaving the room must not mark
    // the row unread for something the user just read.
    if (get().selectedRoom === id) markRoomSeen(id);
    void writeRoom(room);
  } catch (error) {
    if (get().selectedRoom !== id) return;
    // Deleted on another device: the copy is not a way back in, and retrying will not bring it back.
    if ((error as { status?: number })?.status === 404 && !get().roomGone) {
      stopRoomPoll();
      void forgetRoomCopy(id);
      set((s) => {
        const rooms = { ...s.rooms };
        delete rooms[id];
        return { rooms, roomView: null, roomStale: false, roomMissing: false, roomGone: true, roomError: null };
      });
      void writeRooms(Object.values(get().rooms));
      return;
    }
    // A poll failure is transient; only the first load replaces the view with an error.
    if (quiet) return;
    const kept = await readRoom(id);
    if (get().selectedRoom !== id) return;
    // A room this device opened before opens again from its copy; the poll keeps trying to go live.
    if (kept) noteRoomMembers(kept);
    if (kept) return set({ roomView: kept, roomStale: true, roomMissing: false, roomError: null, rooms: get().rooms[id] ? { ...get().rooms, [id]: summaryPatch(kept, get().rooms[id]) } : get().rooms });
    set({ roomMissing: true, roomError: error instanceof Error ? error.message : "Couldn't load the room" });
  }
}

/** A deleted room leaves nothing behind: its copy, and the copies of the conversations it held. */
async function forgetRoomCopy(id: string) {
  deletedRooms.add(id);
  const room = get().roomView?.id === id ? get().roomView : await readRoom(id).catch(() => null);
  const members = new Set((room?.members ?? []).flatMap((member) => typeof member.threadId === "string" && member.threadId ? [member.threadId] : []));
  for (const [threadId, roomId] of roomOfThread) if (roomId === id) members.add(threadId);
  forgetThreadCopy([...members]);
  // Member copies saved for this room (former members too) and the pictures it showed go with it.
  revokeAssetHandles(await forgetRoom(id));
}

/**
 * Paints the room this device kept while the gateway answers; the poll replaces it whole.
 * Finding nothing is an answer too, and it comes from storage: the page must not wait for a
 * network timeout to say the room is not here.
 */
async function hydrateRoom(id: string) {
  const kept = await readRoom(id);
  if (get().selectedRoom !== id || get().roomView || get().roomGone) return;
  if (!kept) return set({ roomMissing: true });
  noteRoomMembers(kept);
  set((s) => ({ roomView: kept, roomStale: true, roomMissing: false, roomError: null, rooms: s.rooms[id] ? { ...s.rooms, [id]: summaryPatch(kept, s.rooms[id]) } : s.rooms }));
}

/** Opens a room. The view polls every 2 s until another Bot or page is selected. */
export function selectRoom(id: string | null) {
  stopRoomPoll();
  if (!id) {
    set({ selectedRoom: null, roomView: null, roomStale: false, roomMissing: false, roomGone: false, roomError: null, page: get().page === "room" ? null : get().page });
    return;
  }
  set({ selectedRoom: id, roomView: null, roomStale: false, roomMissing: false, roomGone: false, roomError: null, page: "room", projectItemId: null, exchangeBotSlug: null });
  markRoomSeen(id);
  void hydrateRoom(id);
  void loadRoom(id);
  startRoomPoll(id);
}

/** RoomView calls this after history restore put the room page back without `selectRoom`. */
export function ensureRoom(id: string) {
  if (get().selectedRoom !== id) {
    if (get().roomView?.id === id) {
      // A fixture or a restored view already holds the room; only wire the page and the poll.
      set({ selectedRoom: id, page: "room", projectItemId: null, exchangeBotSlug: null });
      markRoomSeen(id);
      if (roomPollId !== id) startRoomPoll(id);
      return;
    }
    selectRoom(id);
    return;
  }
  if (roomPollId === id) return;
  markRoomSeen(id);
  void loadRoom(id);
  startRoomPoll(id);
}

function startRoomPoll(id: string) {
  stopRoomPoll();
  roomPollId = id;
  let resumed = false;
  roomPoll = window.setInterval(() => {
    // With no network the poll only burns requests; the socket coming back (or a manual retry) resumes it.
    if (get().offline || navigator.onLine === false) { resumed = true; return; }
    if (roomPollId !== id || get().selectedRoom !== id || document.visibilityState !== "visible" || roomPollBusy) return;
    roomPollTick += 1;
    // While a turn is in flight the view needs 2 s; an idle room only needs to notice a message
    // another device sent, and 10 s is enough for that.
    const active = (get().roomView?.turns ?? []).some((turn) => turn.status === "running" || turn.status === "queued");
    // Back from offline, the copy on screen is replaced at once rather than on the idle cadence.
    if (!active && roomPollTick % 5 !== 0 && !resumed) return;
    resumed = false;
    roomPollBusy = true;
    void loadRoom(id, true).finally(() => { roomPollBusy = false; });
  }, 2_000);
}

/** Creates the room. It does not open it: the caller decides with `showRoom` how the page moves. */
export async function createRoom(input: CreateRoomInput) {
  const room = await createRoomApi(input);
  await loadRooms().catch(() => {});
  return room;
}

/**
 * Closes the open dialog and opens the room in one update. Creating a room used to call `selectRoom`
 * while the dialog was still open: on mobile that pushed an overlay history entry, and closing the
 * dialog popped back into it, so the create form came back blank until the X was pressed.
 */
export function showRoom(id: string) {
  stopRoomPoll();
  set({ dialog: null, selectedRoom: id, roomView: null, roomStale: false, roomMissing: false, roomGone: false, roomError: null, page: "room", projectItemId: null, exchangeBotSlug: null });
  markRoomSeen(id);
  void hydrateRoom(id);
  void loadRoom(id);
  startRoomPoll(id);
}

export async function saveRoom(id: string, input: UpdateRoomInput) {
  const room = await updateRoomApi(id, input);
  const fallback: RoomSummary = {
    id: room.id, name: room.name, description: room.description, section: room.section, pinned: room.pinned,
    mode: room.settings.mode, members: [], lastTurnAt: null, lastActivityAt: null, lastText: "", queued: 0, running: false,
  };
  set((s) => ({
    rooms: { ...s.rooms, [room.id]: summaryPatch(room, s.rooms[room.id] ?? fallback) },
    roomView: s.selectedRoom === room.id ? room : s.roomView,
    ...(s.selectedRoom === room.id ? { roomStale: false } : {}),
  }));
  void writeRoom(room);
  return room;
}

export async function removeRoom(id: string) {
  const result = await deleteRoomApi(id);
  clearRoomDraft(id);
  void forgetRoomCopy(id);
  try {
    const roomSeen = { ...get().roomSeen };
    delete roomSeen[id];
    localStorage.setItem("threebot.rooms.seen", JSON.stringify(roomSeen));
    set({ roomSeen });
  } catch { /* private mode */ }
  const leaving = get().selectedRoom === id;
  stopRoomPoll();
  set((s) => {
    const rooms = { ...s.rooms };
    delete rooms[id];
    return { rooms, ...(leaving ? { selectedRoom: null, roomView: null, roomStale: false, roomMissing: false, roomGone: false, roomError: null, page: s.page === "room" ? null : s.page } : {}) };
  });
  // The saved sidebar list must not name a deleted room on the next launch.
  void writeRooms(Object.values(get().rooms));
  return result;
}

/** Start over: the room forgets its messages and every Bot opens a new session on its next answer. */
/** A room on screen from its saved copy may have changed: nothing is changed in it until it is live. */
function liveRoom(id: string) {
  if (get().selectedRoom === id && get().roomStale) throw new Error("This room is a saved copy. Try again once it has loaded.");
}

export async function resetRoom(id: string) {
  liveRoom(id);
  const room = await resetRoomApi(id);
  set((s) => ({ roomView: s.selectedRoom === id ? room : s.roomView, ...(s.selectedRoom === id ? { roomStale: false } : {}) }));
  void writeRoom(room);
  await loadRooms().catch(() => {});
  return room;
}

/** Sends from the room composer; the turn index is re-read so the user's bubble lands at once. */
export async function sendRoomMessage(id: string, text: string, mentions: string[], replyTo: string | null = null, attachments: Attachment[] = []): Promise<RoomTurn> {
  // The room keeps the metadata; T3 keeps the bytes, and every addressed member claims its own copy.
  const turn = await sendRoomMessageApi(id, { text, mentions, replyTo, attachments: attachments.map(({ previewUrl: _preview, environmentId: _environment, ...attachment }) => attachment) });
  await loadRoom(id, true);
  void loadRooms().catch(() => {});
  return turn;
}

export async function stopRoom(id: string) {
  liveRoom(id);
  await stopRoomApi(id);
  await loadRoom(id, true);
  void loadRooms().catch(() => {});
}

// Back/forward can leave the room page without going through `select` or `selectThread`.
useApp.subscribe((state, prev) => {
  if (prev.page === "room" && state.page !== "room" && state.selectedRoom) {
    stopRoomPoll();
    set({ selectedRoom: null, roomView: null, roomError: null });
  }
});

export async function loadMachines(fresh = false) {
  const result = await api.machines(fresh).catch(() => null);
  if (result) set({ machines: result.machines });
  return result;
}
/** The machine a thread key belongs to, once the list has loaded; undefined for this machine's threads. */
export function machineOf(threadId: string | null | undefined, machines = get().machines): Machine | undefined {
  const environmentId = threadId ? threadTarget(threadId).environmentId : undefined;
  return environmentId ? machines?.find((machine) => machine.environmentId === environmentId) : undefined;
}
/** Threads Threebot reaches only through T3's link are read over the gateway, not a live T3 connection. */
export function linkedOnly(threadId: string | null | undefined) {
  const machine = machineOf(threadId);
  return machine?.route === "linked" || machine?.route === "none";
}

export function selectThread(bot: Bot, threadId: string, fromSearch = false) {
  set({ selected: botReferenceKey(bot), selectedThreadId: threadId === bot.mainThreadId ? null : threadId, exchangeBotSlug: null, page: null, projectItemId: null, ...(fromSearch ? { dialog: null, searchResultRevision: get().searchResultRevision + 1 } : {}) });
  if (linkedOnly(threadId)) return;
  threadClient(threadId).dispatch({ type: "thread.visit", threadId: threadTarget(threadId).threadId, visitedAt: new Date().toISOString() }).catch(() => {});
  loadThreadFamily(threadId);
}

export async function markThreadRead(threadId: string) {
  await threadClient(threadId).dispatch({ type: "thread.visit", threadId: threadTarget(threadId).threadId, visitedAt: new Date().toISOString() });
  await reconcileThread(threadId);
}

export async function markThreadUnread(threadId: string) {
  await threadClient(threadId).dispatch({ type: "thread.mark-unread", threadId: threadTarget(threadId).threadId });
}

export function openExchange(otherSlug: string | null) {
  if (otherSlug && !get().bots[otherSlug] && !get().historicalBots[otherSlug]) return;
  set({ exchangeBotSlug: otherSlug });
}

export function botReferenceKey(bot: Bot) {
  return get().bots[bot.slug]?.mainThreadId === bot.mainThreadId ? bot.slug : `archived:${bot.mainThreadId}`;
}

const familyLoads = new Map<string, Promise<void>>();
export function loadThreadFamily(threadId: string): Promise<void> {
  const pending = familyLoads.get(threadId);
  if (pending) return pending;
  const target = threadTarget(threadId);
  const request = threadClient(threadId).call<{ threads: ThreadShell[] }>("orchestration.getThreadFamily", { threadId: target.threadId }).then((family) => {
    family.threads = family.threads.map((thread) => scopedShell(thread, target.environmentId));
    for (const thread of family.threads) if (target.environmentId || thread.lineage.relationshipToParent === "subagent") familyThreadIds.add(thread.id);
    set((s) => ({ threads: { ...s.threads, ...Object.fromEntries(family.threads.map((thread) => [thread.id, s.threads[thread.id]?.updatedAt > thread.updatedAt ? s.threads[thread.id] : thread])) } }));
  }).catch(() => {
    // The conversation stream remains usable if family metadata is unavailable.
  }).finally(() => { familyLoads.delete(threadId); });
  familyLoads.set(threadId, request);
  return request;
}

export function setDetailsOpen(open: boolean) {
  set({ detailsOpen: open });
  localStorage.setItem("bot.details", open ? "1" : "0");
}

export function setSidebarCompact(compact: boolean) {
  set({ sidebarCompact: compact });
  localStorage.setItem("bot.sidebar.compact", compact ? "1" : "0");
}

export function setColumnWidth({ column, width, persist = true }: { column: Column; width: number; persist?: boolean }) {
  const next = columnWidth(column, width);
  set(column === "sidebar" ? { sidebarWidth: next } : { detailsWidth: next });
  if (persist) localStorage.setItem(`bot.${column}.width`, String(next));
}

/** Settings → Beta → Projects board. Off until the settings say otherwise. */
export const useProjectsOn = () => useApp((s) => s.settings?.beta?.projects === true);

/** Open the Projects page, optionally on one item. */
export function openProjects(itemId: string | null = null) {
  set({ page: "projects", projectItemId: itemId, exchangeBotSlug: null, dialog: null });
}

export function openBotMap() {
  set({ page: "map", projectItemId: null, exchangeBotSlug: null, dialog: null, detailsOpen: false });
}

export function openDialog(dialog: Dialog) {
  set({ dialog });
}

export type ToastLink = { href: string; label: string; open?: () => void };
export function toast(msg: string, link: ToastLink | null = null) {
  set({ toast: msg, toastLink: link });
  window.setTimeout(() => get().toast === msg && set({ toast: null, toastLink: null }), msg.length > 80 || link ? 12_000 : 3500);
}

export async function createBot(input: { name: string; label?: string; instructions?: string; shape: string; color: string; avatarImage?: string | null; avatarDefinition?: unknown; model?: ModelSelection | null; section?: string | null; primary?: boolean }) {
  const model = input.model ?? defaultModel();
  if (!model) throw new Error("No agent provider is ready on T3");
  // The gateway creates the folder, the T3 project and the main thread.
  const bot = await mutateBots(async () => {
    const created = await api.createBot({ ...input, section: input.section ?? null, model });
    if (isCustomColor(input.color)) rememberColor(input.color);
    publishBots(await api.bots());
    if (!created.mainThreadId) throw new Error("The Bot was created but T3 didn't start its conversation");
    return created;
  });
  select(bot.slug);
  return bot;
}

let botsRevision = 0;
let pendingBotMutations = 0;
let botMutations: Promise<unknown> = Promise.resolve();
function publishBots(bots: Bot[]) {
  set({ bots: Object.fromEntries(bots.map((bot) => [bot.slug, bot])) });
}
function mutateBots<T>(operation: () => Promise<T>): Promise<T> {
  botsRevision++;
  pendingBotMutations++;
  const result = botMutations.then(operation).finally(() => { pendingBotMutations--; botsRevision++; });
  botMutations = result.catch(() => {});
  return result;
}

export function setMainBot(slug: string) {
  return mutateBots(async () => {
    const { bots } = await api.setMainBot(slug);
    publishBots(bots);
  });
}

export function updateBot(slug: string, patch: Partial<Bot>) {
  return mutateBots(async () => {
    const bot = get().bots[slug];
    if (!bot) return;
    await api.saveBot(slug, patch);
    if (isCustomColor(patch.color)) rememberColor(patch.color);
    publishBots(await api.bots());
    // A project the Bot was made from keeps the name the user gave it.
    if (patch.name && bot.projectId && !bot.adopted) {
      await t3.call("projects.mutate", { type: "project.update", commandId: uuid(), projectId: bot.projectId, title: patch.name }).catch(() => {});
    }
  });
}

/**
 * Makes a Bot of an existing T3 project, in place. The gateway reuses the project and, when one is
 * picked, its thread as the main conversation; otherwise it starts a new one there.
 */
export async function adoptProject(input: { projectId: string; threadId: string | null; name: string; shape: string; color: string; avatarImage?: string | null; avatarDefinition?: unknown; primary?: boolean }) {
  const model = defaultModel();
  const bot = await mutateBots(async () => {
    const created = await api.adoptProject({ ...input, section: null, model });
    if (isCustomColor(input.color)) rememberColor(input.color);
    publishBots(await api.bots());
    if (!created.mainThreadId) throw new Error("The Bot was made but T3 didn't start its conversation");
    return created;
  });
  select(bot.slug);
  return bot;
}

/** Turns a Bot made from a project back into that plain project. Its T3 project and threads stay. */
export function releaseBot(slug: string) {
  return mutateBots(async () => {
    const { bots, archive } = await api.releaseBot(slug);
    publishBots(bots);
    set((s) => ({ selected: s.selected === slug ? null : s.selected, selectedThreadId: s.selected === slug ? null : s.selectedThreadId, exchangeBotSlug: s.exchangeBotSlug === slug ? null : s.exchangeBotSlug }));
    return archive;
  });
}

export function deleteBot(slug: string) {
  return mutateBots(async () => {
    const bot = get().bots[slug];
    if (!bot) return;
    // A Bot made from a project never deletes that project; it is turned back into it instead.
    if (bot.adopted) throw new Error("This Bot was made from a project. Turn it back into a plain project instead.");
    // The gateway must accept deletion before any T3 conversation/project is stopped.
    const { bots } = await api.deleteBot(slug);
    publishBots(bots);
    keepBoot({ botsRoot: get().botsRoot, executorUrl: get().executorUrl, settings: get().settings, bots, historical: Object.values(get().historicalBots) });
    forgetThreadCopy(Object.values(get().threads).filter((thread) => thread.id === bot.mainThreadId || (bot.projectId && thread.projectId === bot.projectId)).map((thread) => thread.id).concat(bot.mainThreadId ? [bot.mainThreadId] : []));
    set((s) => ({ selected: s.selected === slug ? null : s.selected, selectedThreadId: s.selected === slug ? null : s.selectedThreadId, exchangeBotSlug: s.exchangeBotSlug === slug ? null : s.exchangeBotSlug }));
    if (bot.mainThreadId) set((s) => ({ historicalBots: { ...s.historicalBots, [`archived:${bot.mainThreadId}`]: { ...bot, hidden: true, pinned: false, primary: false, notifications: false } } }));
    if (bot.mainThreadId) await t3.dispatch({ type: "thread.stop", threadId: bot.mainThreadId }).catch(() => {});
    if (bot.projectId) await t3.call("projects.mutate", { type: "project.delete", commandId: uuid(), projectId: bot.projectId, force: true }).catch((e) => console.warn(e));
  });
}

export async function setBotModel(slug: string, model: ModelSelection) {
  const bot = get().bots[slug];
  if (!bot?.projectId) return;
  await t3.call("projects.mutate", { type: "project.update", commandId: uuid(), projectId: bot.projectId, defaultModelSelection: model });
  if (bot.mainThreadId) await t3.dispatch({ type: "thread.model-selection.set", threadId: bot.mainThreadId, modelSelection: model });
}

export type Attachment = { type: "image" | "file"; id: string; name: string; mimeType: string; sizeBytes: number; previewUrl?: string; environmentId?: string };

export async function uploadAttachment(file: File, environmentId?: string): Promise<Attachment> {
  const type = file.type.startsWith("image/") ? "image" : "file";
  const { attachmentId, relativeUrl } = await environmentT3(environmentId).call("attachments.createUploadUrl", { type, name: file.name, mimeType: file.type || "application/octet-stream", sizeBytes: file.size });
  const res = await fetch(`${environmentPrefix(environmentId)}${relativeUrl}`, { method: "POST", body: file, headers: { "content-type": file.type || "application/octet-stream" } });
  if (!res.ok) throw new Error(`upload failed (${res.status})`);
  return { type, id: attachmentId, ...(environmentId ? { environmentId } : {}), name: file.name, mimeType: file.type || "application/octet-stream", sizeBytes: file.size, previewUrl: type === "image" ? URL.createObjectURL(file) : undefined };
}

/** `fresh` starts a new provider session in the same thread (T3's `/clear`). Only send it where T3 reports `freshContext`. */
export async function sendMessage(slug: string, text: string, attachments: Attachment[] = [], threadId = get().bots[slug]?.mainThreadId, messageId = uuid(), fresh = false) {
  if (!threadId) throw new Error("This Bot has no conversation yet");
  if (attachments.some((attachment) => attachment.environmentId !== threadTarget(threadId).environmentId)) throw new Error("Upload attachments to the conversation’s machine before sending");
  // Claude's Ultrathink is a prompt prefix rather than an effort setting (as in T3 Code).
  const effort = get().threads[threadId]?.modelSelection?.options?.find((o) => o.id === "effort")?.value;
  const body = effort === "ultrathink" && text && !/^ultrathink:/i.test(text) ? `Ultrathink: ${text}` : text;
  await threadClient(threadId).dispatch({
    commandId: messageId,
    type: "message.dispatch",
    threadId: threadTarget(threadId).threadId,
    messageId,
    text: body,
    attachments: attachments.map(({ previewUrl: _p, environmentId: _environment, ...a }) => a),
    createdBy: "user",
    creationSource: "web",
    // Resolve against T3's live run, so stale browser state or saved defaults cannot queue a send.
    deliveryIntent: "steer",
    dispatchMode: { type: "start_immediately" },
    // T3 queues a fresh send behind a running turn instead of steering it.
    ...(fresh ? { freshContext: true } : {}),
  }, { timeoutMs: 30_000 });
}

export async function interrupt(threadId: string) {
  const t = get().threads[threadId];
  const runId = t?.activeRunId ?? t?.latestRunId;
  if (runId) await threadClient(threadId).dispatch({ type: "run.interrupt", threadId: threadTarget(threadId).threadId, runId });
}

/** A Bot whose T3 project was archived in T3 Code. The main Bot always stays in the sidebar. */
export function archivedInT3(bot: Bot, projects: Record<string, ProjectShell>) {
  return !bot.primary && !!bot.projectId && !!projects[bot.projectId]?.archivedAt;
}

export async function unarchiveBotProject(bot: Bot) {
  if (!bot.projectId) return;
  await t3.call("projects.mutate", { type: "project.update", commandId: uuid(), projectId: bot.projectId, archived: false });
  set((s) => { const project = bot.projectId ? s.projects[bot.projectId] : undefined; return project ? { projects: { ...s.projects, [project.id]: { ...project, archivedAt: null } } } : {}; });
}

/** Whether a send to this thread can start a fresh session. Linked machines may run older T3 versions, so only the local one counts. */
export function canStartFresh(threadId: string | null, state = get()) {
  return !!threadId && state.runtimeFeatures.freshContext && !threadTarget(threadId).environmentId;
}

/** For a run that ignored Stop. Passing its runId means a newer run is never hit. */
export async function forceStopThread(threadId: string, runId: string) {
  const result = await threadClient(threadId).call<{ outcome?: string; sharedWithThreadIds?: string[] }>("orchestration.forceStopThread", { threadId: threadTarget(threadId).threadId, runId });
  if (result?.outcome === "releasing") toast("Stopped. The agent is still shutting down.");
  else if (result?.outcome === "shared") toast("Stopped. The agent process kept running because other threads share it.");
}

/** A request card painted from the saved copy may already be answered: act only on the live one. */
function liveOnly(threadId: string) {
  if (get().threadData[threadId]?.stale) throw new Error("This is a saved copy. Try again once the conversation has loaded.");
}

export async function respondRequest(threadId: string, requestId: string, decision: "accept" | "acceptForSession" | "acceptAlways" | "decline" | "cancel") {
  liveOnly(threadId);
  await threadClient(threadId).dispatch({ type: "runtime-request.respond", threadId: threadTarget(threadId).threadId, requestId, decision });
}

export async function answerQuestion(threadId: string, requestId: string, answers: Record<string, unknown>) {
  liveOnly(threadId);
  await threadClient(threadId).dispatch({ type: "runtime-request.respond", threadId: threadTarget(threadId).threadId, requestId, answers });
}

export async function dismissQuestion(threadId: string, requestId: string) {
  liveOnly(threadId);
  await threadClient(threadId).dispatch({ type: "thread.user-input.dismiss", threadId: threadTarget(threadId).threadId, requestId });
}

export async function answerSecret(threadId: string, turnItemId: string, secret: string | null) {
  liveOnly(threadId);
  await threadClient(threadId).call("secrets.answerRequest", { threadId: threadTarget(threadId).threadId, turnItemId, answer: secret === null ? { type: "decline" } : { type: "save", secret } });
}

let settingsSaves: Promise<unknown> = Promise.resolve();
export function saveSettings(patch: Partial<Settings>) {
  const result = settingsSaves.then(() => persistSettings(patch));
  settingsSaves = result.catch(() => {});
  return result;
}

async function persistSettings(patch: Partial<Settings>) {
  let next: Settings;
  try { next = await api.saveSettings(patch); }
  catch (error) {
    // A network failure may happen after the server has committed the write.
    const confirmed = await api.settings().catch(() => null);
    if (confirmed) set({ settings: confirmed });
    throw error;
  }
  set({ settings: next });
  if ("autoReview" in patch) {
    const mode = runtimeMode();
    await Promise.all(
      Object.values(get().bots)
        .filter((b) => b.mainThreadId)
        .map((b) => t3.dispatch({ type: "thread.runtime-mode.set", threadId: b.mainThreadId, runtimeMode: mode }).catch(() => {})),
    );
  }
}

export async function setTaskEnabled(id: string, enabled: boolean) {
  await t3.call("scheduledTasks.setEnabled", { id, enabled });
}

export async function runTaskNow(id: string) {
  await t3.call("scheduledTasks.runNow", { id });
}

export async function deleteTask(id: string) {
  await t3.call("scheduledTasks.delete", { id });
}

export async function assetUrl(resource: Record<string, unknown>, environmentId?: string) {
  const target = typeof resource.threadId === "string" ? threadTarget(resource.threadId) : null;
  if (environmentId && target?.environmentId && environmentId !== target.environmentId) throw new Error("The file belongs to a different machine");
  const scope = environmentId ?? target?.environmentId;
  const { relativeUrl } = await environmentT3(scope).call("assets.createUrl", { resource: target ? { ...resource, threadId: target.threadId } : resource });
  return `${environmentPrefix(scope)}${relativeUrl}`;
}

export async function listFiles(cwd: string, directoryPath?: string, environmentId?: string): Promise<{ entries: { path: string; kind: string }[]; truncated: boolean } | null> {
  return environmentT3(environmentId).call("projects.listEntries", directoryPath ? { cwd, directoryPath } : { cwd }).catch(() => null);
}

export async function readFile(cwd: string, relativePath: string, environmentId?: string): Promise<string | null> {
  const r = await environmentT3(environmentId).call("projects.readFile", { cwd, relativePath, allowMissing: true }).catch(() => null);
  return r?.contents ?? null;
}

export { t3http };

// Shared integration for conversation, browser and Library packages.
export { environmentT3, environmentHttp, threadClient, threadKey, threadTarget };
export function selectEnvironmentThread(bot: Bot, target: ThreadTarget) { selectThread(bot, threadKey(target)); }
export async function setThreadDone(threadId: string, done: boolean) {
  await threadClient(threadId).dispatch({ type: done ? "thread.settle" : "thread.unsettle", threadId: threadTarget(threadId).threadId, ...(!done ? { reason: "user" } : {}) });
  await reconcileThread(threadId);
}
export async function setThreadAutoSettle(threadId: string, enabled: boolean) {
  await threadClient(threadId).dispatch({ type: "thread.auto-settle.set", threadId: threadTarget(threadId).threadId, enabled });
  await reconcileThread(threadId);
}
export async function snoozeThread(threadId: string, snoozedUntil: string | null) {
  if (snoozedUntil && (!Number.isFinite(Date.parse(snoozedUntil)) || Date.parse(snoozedUntil) <= Date.now())) throw new Error("Choose a future snooze time");
  await threadClient(threadId).dispatch({ type: snoozedUntil ? "thread.snooze" : "thread.unsnooze", threadId: threadTarget(threadId).threadId, ...(snoozedUntil ? { snoozedUntil } : { reason: "user" }) });
  await reconcileThread(threadId);
}
async function reconcileThread(key: string) {
  const target = threadTarget(key);
  const projection = await threadClient(key).call<{ thread: ThreadShell }>("orchestration.getThreadProjection", { threadId: target.threadId });
  const thread = scopedShell(projection.thread, target.environmentId);
  set((s) => { const archivedThreads = { ...s.archivedThreads }; if (thread.archivedAt) archivedThreads[key] = thread; else delete archivedThreads[key]; return { archivedThreads, threads: { ...s.threads, [key]: thread } }; });
}
export async function archiveThread(threadId: string, archived: boolean) {
  await threadClient(threadId).dispatch({ type: archived ? "thread.archive" : "thread.unarchive", threadId: threadTarget(threadId).threadId });
  await reconcileThread(threadId);
}
export async function loadArchivedThreads() {
  try {
    const snapshot = await t3.call<{ threads: ThreadShell[]; projects: ProjectShell[] }>("orchestration.getArchivedShellSnapshot", {});
    // A drawing job thread is archived only to keep it out of sight.
    const archivedThreads = Object.fromEntries(snapshot.threads.filter((t) => !isDrawingJob(t)).map((t) => [t.id, t]));
    set((s) => ({ archiveError: null, archivedThreads: { ...Object.fromEntries(Object.entries(s.archivedThreads).filter(([id]) => !!threadTarget(id).environmentId)), ...archivedThreads }, threads: { ...Object.fromEntries(Object.entries(s.threads).filter(([id,t]) => !!threadTarget(id).environmentId || !t.archivedAt)), ...archivedThreads }, projects: { ...s.projects, ...Object.fromEntries(snapshot.projects.map((p) => [p.id, p])) } }));
  } catch (error) { set({ archiveError: error instanceof Error ? error.message : "Couldn't load archived conversations" }); }
}
export async function loadOlderDone() {
  if (!get().runtimeFeatures.shellOlderSettled) throw new Error("This T3 server does not support older done conversations");
  const page = await t3.call<{ threads: ThreadShell[] }>("orchestration.getOlderSettledThreads", { before: get().olderSettledCursor ?? { settledAt: new Date().toISOString() }, limit: 30 });
  for (const t of page.threads) familyThreadIds.add(t.id);
  const last = page.threads.at(-1);
  set((s) => ({ threads: { ...s.threads, ...Object.fromEntries(page.threads.map((t) => [t.id, t])) }, olderSettledCursor: last?.settledAt ? { settledAt: last.settledAt, threadId: last.id } : s.olderSettledCursor }));
  return page.threads.length;
}
function threadArrives(threadId: string, timeoutMs = 10_000) {
  if (get().threads[threadId]) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const finish = (arrived: boolean) => { clearTimeout(timer); stop(); resolve(arrived); };
    const timer = setTimeout(() => finish(false), timeoutMs);
    const stop = useApp.subscribe((state) => { if (state.threads[threadId]) finish(true); });
  });
}

let sideChatStarting = false;
/** Fork the conversation into a hidden side chat, optionally ask there, then open it beside the parent. */
export async function startSideChat(bot: Bot, parentThreadId: string, prompt = "") {
  if (sideChatStarting) return false;
  if (!get().runtimeFeatures.sideChats || !canStartSideChat(get().threads[parentThreadId])) {
    toast("Side chats aren't available in this conversation");
    return false;
  }
  sideChatStarting = true;
  const threadId = uuid();
  // T3 keeps an empty fork when a start fails halfway, so take it back.
  const discard = () => void t3.dispatch({ type: "thread.delete", threadId, onlyIfUnused: true }).catch(() => {});
  try {
    await t3.dispatch({ type: "thread.fork", createdBy: "user", creationSource: "web", sourceThreadId: parentThreadId, targetThreadId: threadId, sourcePoint: { type: "latest_stable" }, sideChat: true, title: sideChatTitle(prompt) }, { timeoutMs: 30_000 });
    if (!await threadArrives(threadId)) throw new Error("The side chat didn't reach this device. Try again.");
    if (prompt) await sendMessage(bot.slug, prompt, [], threadId);
    set({ sideChat: { parentThreadId, threadId } });
    return true;
  } catch (error) {
    discard();
    toast(error instanceof Error ? error.message : "Couldn't start a side chat");
    return false;
  } finally {
    sideChatStarting = false;
  }
}

export function openSideChat(parentThreadId: string, threadId: string) {
  set({ sideChat: { parentThreadId, threadId } });
  void markThreadRead(threadId).catch(() => {});
}

export function closeSideChat() {
  const open = get().sideChat;
  if (!open) return;
  set({ sideChat: null });
  if (!get().threads[open.threadId]) return;
  void markThreadRead(open.threadId).catch(() => {});
  // An unused side chat leaves nothing behind; a used one stays in details.
  void t3.dispatch({ type: "thread.delete", threadId: open.threadId, onlyIfUnused: true }).catch(() => {});
}

export async function bringBackSideChat(threadId: string, parentThreadId: string, runId: string) {
  await t3.dispatch({ type: "thread.merge_back", createdBy: "user", creationSource: "web", sourceThreadId: threadId, targetThreadId: parentThreadId, sourcePoint: { type: "run", runId } });
}

export async function deleteSideChat(threadId: string) {
  await t3.dispatch({ type: "thread.delete", threadId });
  forgetThreadCopy([threadId]);
  if (get().sideChat?.threadId === threadId) set({ sideChat: null });
}

/** The model a Bot's drawing runs on: the Avatar drawing model setting, a fast model, or the Bot's own. */
export function avatarDrawingModel(bot: Bot, s = get()) {
  const own = (bot.mainThreadId ? s.threads[bot.mainThreadId]?.modelSelection : null) ?? (bot.projectId ? s.projects[bot.projectId]?.defaultModelSelection : null) ?? defaultModel(s);
  return drawingModel(s.providers, s.settings?.avatarDrawingModel, own ?? null);
}

/**
 * Draw a new avatar as its own small job (see lib/avatarDrawing): an empty, archived thread in the Bot's
 * project on a fast model, with each option in a hidden side chat of it. Replaces any earlier drawing.
 */
export async function startAvatarDrawing(bot: Bot, description: string, options = DRAWING_OPTIONS) {
  const main = bot.mainThreadId ? get().threads[bot.mainThreadId] : undefined;
  if (!get().runtimeFeatures.sideChats || !bot.projectId || !canStartSideChat(main)) throw new Error("Drawing needs a newer T3 Code, with side chats.");
  const model = avatarDrawingModel(bot);
  if (!model) throw new Error("No model is available to draw with.");
  await discardAvatarDrawing(drawingsOf(get().threads, bot));
  const jobId = uuid();
  const actor = { createdBy: "user", creationSource: "web" };
  try {
    await t3.dispatch({ type: "thread.create", ...actor, threadId: jobId, projectId: bot.projectId, title: DRAWING_JOB_TITLE, modelSelection: model, runtimeMode: runtimeMode(), interactionMode: "default", branch: null, worktreePath: null }, { timeoutMs: 30_000 });
    await t3.dispatch({ type: "thread.archive", threadId: jobId });
    const started = await Promise.allSettled(Array.from({ length: options }, async (_, index) => {
      const threadId = uuid();
      await t3.dispatch({ type: "thread.fork", ...actor, sourceThreadId: jobId, targetThreadId: threadId, sourcePoint: { type: "latest_stable" }, sideChat: true, title: drawingTitle(description) }, { timeoutMs: 30_000 });
      try {
        if (!await threadArrives(threadId)) throw new Error("The drawing didn't reach this device. Try again.");
        await sendMessage(bot.slug, drawingPrompt(description, index + 1, options), [], threadId);
      } catch (error) {
        // An option that never started would spin forever; the others go on without it.
        await t3.dispatch({ type: "thread.delete", threadId }).catch(() => {});
        throw error;
      }
      return threadId;
    }));
    const running = started.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    if (!running.length) throw (started[0] as PromiseRejectedResult).reason;
    superviseDrawing(running);
  } catch (error) {
    // Deleting the job takes any options that did start with it.
    void t3.dispatch({ type: "thread.delete", threadId: jobId }).catch(() => {});
    throw error;
  }
}

// Read once per finished run, shared by the editor and the supervisor, so a fix is only ever asked once.
const drawingReads = new Map<string, Promise<DrawingOption>>();
const drawingReadKey = (thread: ThreadShell) => `${thread.id}:${thread.latestRunId}:${thread.latestRunCompletedAt ?? ""}`;

/** A finished option: its avatar, or its error. A first reply that doesn't validate goes back once to be fixed. */
export function readDrawingOption(thread: ThreadShell): Promise<DrawingOption> {
  const key = drawingReadKey(thread);
  const known = drawingReads.get(key);
  if (known) return known;
  const read = threadClient(thread.id).call<{ turnItems: TurnItem[]; runs?: Run[] }>("orchestration.getThreadProjection", { threadId: threadTarget(thread.id).threadId })
    .then(async (projection): Promise<DrawingOption> => {
      const { retry, ...result } = drawingResult(thread, projection.turnItems ?? [], projection.runs ?? []);
      if (retry === undefined) return result;
      const bot = Object.values(get().bots).find((candidate) => candidate.projectId === thread.projectId);
      if (!bot) return { status: "failed", thread, error: retry };
      await sendMessage(bot.slug, fixPrompt(retry), [], thread.id);
      return result;
    })
    .catch((): DrawingOption => { drawingReads.delete(key); return { status: "failed", thread, error: "Couldn't read the drawing. Try again." }; });
  drawingReads.set(key, read);
  return read;
}

/** Reads each option as it finishes, so its fix goes out even while the editor is closed. */
function superviseDrawing(threadIds: string[]) {
  const settled = new Set<string>();
  const seen = new Set<string>();
  const check = (state: State) => {
    for (const id of threadIds) {
      const thread = state.threads[id];
      if (!thread) { settled.add(id); continue; }
      if (settled.has(id) || drawingPending(thread)) continue;
      const key = drawingReadKey(thread);
      if (seen.has(key)) continue;
      seen.add(key);
      void readDrawingOption(thread).then((option) => { if (option.status !== "fixing") settled.add(id); });
    }
    if (threadIds.every((id) => settled.has(id))) { clearTimeout(timer); stop(); }
  };
  const stop = useApp.subscribe(check);
  const timer = setTimeout(stop, 10 * 60_000);
}

/** Stop and remove drawings: their options, then the empty jobs they hang off. */
export async function discardAvatarDrawing(options: ThreadShell[]) {
  const mains = new Set(Object.values(get().bots).map((bot) => bot.mainThreadId));
  const jobs = new Set(options.map((thread) => thread.lineage.parentThreadId).filter((id): id is string => !!id && !mains.has(id)));
  await Promise.all(options.map(async (thread) => {
    if (get().threads[thread.id]?.activeRunId) await interrupt(thread.id).catch(() => {});
    await t3.dispatch({ type: "thread.delete", threadId: thread.id });
  }));
  for (const job of jobs) await t3.dispatch({ type: "thread.delete", threadId: job }).catch(() => {});
  const gone = new Set(options.map((thread) => thread.id));
  set((s) => ({ threads: Object.fromEntries(Object.entries(s.threads).filter(([id]) => !gone.has(id))) }));
}

export async function saveFallbackModel(selection: ModelSelection | null) {
  const settings = await t3.call("server.updateSettings", { patch: { fallbackModelSelection: selection } });
  set({ fallbackModel: settings?.fallbackModelSelection ?? null });
}

export function resolvedSnoozes(presets = get().snoozePresets, now = new Date()) {
  return presets.flatMap((preset) => {
    const date = new Date(now);
    let label: string;
    if (preset.kind === "after") { date.setMinutes(date.getMinutes() + preset.minutes); label = preset.minutes < 60 ? `For ${preset.minutes} minutes` : preset.minutes === 60 ? "For 1 hour" : `For ${preset.minutes / 60} hours`; }
    else {
      const [hours, minutes] = preset.time.split(":").map(Number); date.setHours(hours, minutes, 0, 0);
      if (preset.day === "tomorrow") date.setDate(date.getDate() + 1);
      else if (preset.day !== "today") { const day = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"].indexOf(preset.day); date.setDate(date.getDate() + ((day - date.getDay() + 7) % 7 || 7)); }
      label = `${preset.day[0].toUpperCase()}${preset.day.slice(1)} at ${preset.time}`;
    }
    return date > now ? [{ label, snoozedUntil: date.toISOString() }] : [];
  });
}

/** Preserve the backend hit id for conversation packages and reveal older rendered entries. */
export async function navigateSearchHit(bot: Bot, hit: { threadId: string; messageId?: string; query: string }) {
  selectThread(bot, hit.threadId, true);
  const projection = await threadClient(hit.threadId).call<{ turnItems: TurnItem[]; visibleTurnItems?: { item: TurnItem }[] }>("orchestration.getThreadProjection", { threadId: threadTarget(hit.threadId).threadId });
  const current = () => get().selected === botReferenceKey(bot) && (get().selectedThreadId ?? bot.mainThreadId) === hit.threadId && get().dialog !== "search";
  if (!current()) return;
  const items = projection.visibleTurnItems?.map((row) => row.item) ?? projection.turnItems;
  let entryId = hit.messageId ? items.find((item) => item.id === hit.messageId || item.messageId === hit.messageId)?.id : undefined;
  if (!entryId && get().runtimeFeatures.threadFind) {
    const result = await threadClient(hit.threadId).call<{ match: { entryId: string } | null }>("orchestration.searchThread", { threadId: threadTarget(hit.threadId).threadId, query: hit.query });
    entryId = result.match?.entryId;
  }
  if (!entryId) { toast("Opened the conversation; this server did not identify the matching entry"); return; }
  const id = entryId;
  // A bounded thread may not hold the match yet: page older rows in until it does or history ends.
  for (let wait = 0; wait < 100 && !get().threadData[hit.threadId]?.loaded; wait++) await new Promise((resolve) => setTimeout(resolve, 100));
  for (let page = 0; page < 50 && current() && !get().threadData[hit.threadId]?.items[id] && get().threadData[hit.threadId]?.hasMoreHistory; page++) {
    if (!(await loadOlderMessages(hit.threadId))) break;
  }
  const observer = new MutationObserver(reveal);
  const timer = setTimeout(() => { observer.disconnect(); toast("Opened the conversation; the matching entry could not be displayed"); }, 10000);
  function reveal() {
    if (!current()) { observer.disconnect(); clearTimeout(timer); return; }
    const entries = Array.from(document.querySelectorAll<HTMLElement>("[data-chat-entry]"));
    const element = entries.find((entry) => entry.dataset.chatEntry === id);
    if (element) {
      element.closest(".chat-scroller")?.dispatchEvent(new Event("chat-search-reveal"));
      const bubble = element.querySelector<HTMLElement>(".bubble");
      const target = bubble ?? (element.firstElementChild instanceof HTMLElement ? element.firstElementChild : element);
      target.scrollIntoView({ block: "center" });
      target.animate([{ backgroundColor: "var(--bg-active)" }, { backgroundColor: getComputedStyle(target).backgroundColor }], { duration: 1800 });
      observer.disconnect(); clearTimeout(timer);
    } else {
      const earlier = Array.from(document.querySelectorAll<HTMLButtonElement>(".chat-messages button")).find((button) => button.textContent === "Load earlier messages");
      earlier?.click();
    }
  }
  observer.observe(document.body, { childList: true, subtree: true });
  reveal();
}
