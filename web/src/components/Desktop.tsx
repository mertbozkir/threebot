import { useEffect, useRef, useState } from "react";
import { ComputerOverlay } from "./Computer";
import { ArrowLeft, Check, ClipboardPaste, Globe, Hand, Moon, Monitor } from "lucide-react";
import { Avatar } from "./Avatar";
import { ActivityAvatar } from "./ActivityAvatar";
import { Spinner } from "./ui";
import { botStatus, openDialog, useApp } from "../store";
import { api, type DesktopStatus } from "../lib/api";
import { modelPointToCanvas } from "../lib/desktopPointer";
import type { Bot } from "../lib/types";

// The Bot's own screen on the shared Linux desktop (Settings › Beta › Computer), shown with noVNC.
// The gateway lets a watcher only receive the picture and never wakes the desktop; "Take control"
// also passes keys and the pointer, and pauses the Bot's own computer calls until "I'm done".

type Rfb = {
  scaleViewport: boolean;
  viewOnly: boolean;
  background: string;
  qualityLevel: number;
  compressionLevel: number;
  focusOnClick: boolean;
  disconnect(): void;
  focus(): void;
  addEventListener(type: "connect" | "disconnect" | "securityfailure", listener: (event: CustomEvent) => void): void;
};

const POLL_MS = 5000;
const BUSY_POLL_MS = 700;
const LABEL: Record<DesktopStatus["state"], string> = {
  off: "Off", unavailable: "Unavailable", building: "Preparing the computer…", stopped: "Sleeping", starting: "Waking up…", healthy: "Live", stopping: "Going to sleep…", failed: "Didn't start",
};

function vncUrl(slug: string, mode: "watch" | "control") {
  const url = new URL(`/api/desktop/${encodeURIComponent(slug)}/vnc`, location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("mode", mode);
  return url.toString();
}

function useDesktopStatus(slug: string) {
  const [status, setStatus] = useState<DesktopStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = async () => {
      if (timer) clearTimeout(timer);
      let next: DesktopStatus | null = null;
      try { next = await api.desktop(slug); if (live) { setStatus(next); setError(null); } }
      catch (e) { if (live) setError(e instanceof Error ? e.message : "Couldn’t reach the computer"); }
      // Poll only while this view is open and visible; a busy Bot gets a closer watch.
      if (live) timer = setTimeout(() => { if (document.visibilityState === "visible") void load(); else timer = setTimeout(load, POLL_MS); }, next?.activity.busy ? BUSY_POLL_MS : POLL_MS);
    };
    refresh.current = load;
    void load();
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, [slug]);
  return { status, error, refresh: () => refresh.current() };
}

/** Where the Bot is acting: a dot at its last pointer position, a pulse on clicks, a pill while it works. */
function BotPointer({ activity, container }: { activity: DesktopStatus["activity"]; container: { current: HTMLDivElement | null } }) {
  const [canvas, setCanvas] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const [click, setClick] = useState<string | null>(null);
  const seenAt = useRef<string | null>(null);
  const last = activity.last;
  const spot = last && canvas ? modelPointToCanvas(last.x, last.y, canvas) : null;
  // The canvas appears and resizes only after the viewer connects, so keep measuring its letterboxed box.
  useEffect(() => {
    const measure = () => {
      const host = container.current, screen = host?.querySelector("canvas") ?? null;
      if (!host || !screen) return;
      const box = host.getBoundingClientRect(), rect = screen.getBoundingClientRect();
      setCanvas({ left: rect.left - box.left, top: rect.top - box.top, width: rect.width, height: rect.height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (container.current) {
      observer.observe(container.current);
      const screen = container.current.querySelector("canvas");
      if (screen) observer.observe(screen);
    }
    return () => observer.disconnect();
  }, [container, last?.at]);
  useEffect(() => {
    if (!last || seenAt.current === last.at) return;
    seenAt.current = last.at;
    if (!["click", "double_click", "right_click"].includes(last.type)) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    setClick(last.at);
    const timer = setTimeout(() => setClick(null), 550);
    return () => clearTimeout(timer);
  }, [last]);
  if (!activity.busy && !spot) return null;
  return <div className="pointer-events-none absolute inset-0">
    {activity.busy && <span className="absolute left-1/2 top-3 -translate-x-1/2 rounded-full bg-black/60 px-3 py-1 text-[12px] text-white/90">Using the computer</span>}
    {spot && <span className="absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-[0_0_0_2px_rgba(0,0,0,0.6)]" style={{ left: spot.left, top: spot.top }} />}
    {spot && click && click === last?.at && <span className="absolute -translate-x-1/2 -translate-y-1/2" style={{ left: spot.left, top: spot.top }}><span className="desktop-pointer-click block size-6 rounded-full border-2 border-white/90" /></span>}
  </div>;
}

/** The Details thumbnail: the Bot's screen, watch-only, while the desktop is awake. */
export function DesktopThumbnail({ bot }: { bot: Bot }) {
  const { status, refresh } = useDesktopStatus(bot.slug);
  const rfbRef = useRef<Rfb | null>(null);
  const live = status?.state === "healthy" && status.display !== null;
  return <button type="button" onClick={() => openDialog({ kind: "computer", slug: bot.slug })} className="relative flex aspect-[16/10] w-full overflow-hidden rounded-2xl border border-line bg-black text-left" aria-label={`Open ${bot.name}’s screen`}>
    {live ? <div className="pointer-events-none flex w-full"><DesktopScreen slug={bot.slug} control={false} activity={status.activity} onDisconnect={() => void refresh()} rfbRef={rfbRef} /></div>
      : <div className="grid w-full place-items-center text-center text-[13px] text-white/60"><div><Monitor size={22} className="mx-auto mb-2 opacity-60" />{status ? LABEL[status.state] : "Checking…"}</div></div>}
  </button>;
}

function DesktopScreen({ slug, control, activity, onDisconnect, rfbRef }: { slug: string; control: boolean; activity: DesktopStatus["activity"]; onDisconnect: () => void; rfbRef: { current: Rfb | null } }) {
  const box = useRef<HTMLDivElement>(null);
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    let rfb: Rfb | null = null;
    let cancelled = false;
    const hide = () => { if (document.visibilityState === "hidden") rfb?.disconnect(); };
    void import("@novnc/novnc").then(({ default: RFB }) => {
      if (cancelled || !box.current) return;
      rfb = new RFB(box.current, vncUrl(slug, control ? "control" : "watch")) as Rfb;
      rfbRef.current = rfb;
      rfb.scaleViewport = true;
      rfb.viewOnly = !control;
      rfb.focusOnClick = control;
      rfb.background = "#000";
      rfb.qualityLevel = 7;
      rfb.compressionLevel = 2;
      rfb.addEventListener("connect", () => { setConnected(true); if (control) rfb?.focus(); });
      rfb.addEventListener("disconnect", () => { setConnected(false); if (!cancelled) onDisconnect(); });
      rfb.addEventListener("securityfailure", () => { setConnected(false); });
    });
    // A hidden page closes the socket; reopening the view reconnects.
    document.addEventListener("visibilitychange", hide);
    return () => { cancelled = true; document.removeEventListener("visibilitychange", hide); rfb?.disconnect(); rfbRef.current = null; };
  }, [slug, control]);
  return <div className="relative min-h-0 flex-1">
    <div ref={box} className={control ? "absolute inset-0" : "desktop-watch absolute inset-0"} aria-label={control ? "Desktop, you're in control" : "Desktop, watching"} />
    {!control && <BotPointer activity={activity} container={box} />}
    {!connected && <div className="pointer-events-none absolute inset-0 grid place-items-center"><Spinner size={20} /></div>}
  </div>;
}

function HelpCard({ instruction, onTakeOver, busy }: { instruction: string; onTakeOver: () => void; busy: boolean }) {
  return <div className="shrink-0 border-t border-white/10 px-4 py-3">
    <p className="text-[12px] text-white/50">Waiting for you</p>
    <p className="mt-1 break-words text-[15px] leading-5">{instruction}</p>
    <button type="button" onClick={onTakeOver} disabled={busy} className="mt-3 inline-flex min-h-11 items-center gap-2 rounded-full border border-white/15 bg-white/10 px-4 text-[15px] text-white disabled:opacity-40">{busy ? <Spinner size={14} /> : <Hand size={16} />}{busy ? "Waking up…" : "Take over"}</button>
  </div>;
}

export function DesktopView({ bot, onBrowser }: { bot: Bot; onBrowser: () => void }) {
  const { status, error, refresh } = useDesktopStatus(bot.slug);
  const [control, setControl] = useState(false);
  const [waking, setWaking] = useState(false);
  const [wakeError, setWakeError] = useState<string | null>(null);
  const rfbRef = useRef<Rfb | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [paste, setPaste] = useState("");
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [typing, setTyping] = useState(false);
  const activity = useApp(s => botStatus(bot, s));
  const close = () => openDialog(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !control) close(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [control]);
  useEffect(() => { if (!control) { setPasteOpen(false); setPasteError(null); } }, [control]);
  const live = status?.state === "healthy";
  if (!live && control) setControl(false);
  const wake = async () => {
    setWaking(true); setWakeError(null);
    try { await api.wakeDesktop(bot.slug); } catch (e) { setWakeError(e instanceof Error ? e.message : "Couldn’t wake the computer"); }
    finally { setWaking(false); await refresh(); }
  };
  const help = status?.helpRequest ?? null;
  const takeOver = async () => { if (!live) await wake(); setControl(true); };
  const typeText = async () => {
    setTyping(true); setPasteError(null);
    try { await api.typeDesktop(bot.slug, paste); setPasteOpen(false); setPaste(""); rfbRef.current?.focus(); }
    catch (e) { setPasteError(e instanceof Error ? e.message : "Couldn’t type the text"); }
    finally { setTyping(false); }
  };
  const statusText = !status ? "Checking…" : live ? control ? "You're in control" : "Watching" : LABEL[status.state];
  return <div role="dialog" aria-modal="true" aria-label={`${bot.name}’s computer`} className="fixed inset-0 z-50 flex flex-col bg-black text-white" style={{ paddingTop: "env(safe-area-inset-top)", paddingBottom: "env(safe-area-inset-bottom)" }}>
    <header className="flex min-h-16 shrink-0 items-center gap-3 px-4 py-3">
      <button type="button" aria-label="Back to conversation" onClick={close} className="grid size-11 shrink-0 place-items-center rounded-full border border-white/15 bg-white/10"><ArrowLeft size={23} /></button>
      {control ? <Avatar shape={bot.shape} color={bot.color} picture={bot.avatarImage} size={28} state="waiting" /> : <ActivityAvatar threadId={bot.mainThreadId} status={activity} shape={bot.shape} color={bot.color} picture={bot.avatarImage} size={28} />}
      <span className="min-w-0 flex-1 truncate text-[18px]">{bot.name}</span>
      {status?.display ? <span className="shrink-0 text-[12px] text-white/50">Screen {status.display}</span> : null}
      <button type="button" onClick={onBrowser} className="inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-full border border-white/15 bg-white/10 px-3 text-[13px] text-white/80"><Globe size={14} />Browser</button>
    </header>
    <main className="relative flex min-h-0 flex-1 flex-col">
      {live ? <DesktopScreen key={String(control)} slug={bot.slug} control={control} activity={status?.activity ?? { busy: false, last: null }} onDisconnect={() => void refresh()} rfbRef={rfbRef} />
        : <div className="grid flex-1 place-items-center px-6 text-center text-[15px] text-white/60"><div>
          {status?.state === "stopped" ? <Moon size={30} className="mx-auto mb-4 opacity-60" /> : <Monitor size={30} className="mx-auto mb-4 opacity-60" />}
          <p>{error ?? (status ? LABEL[status.state] : "Checking…")}</p>
          {status?.reason && <p className="mx-auto mt-2 max-w-96 break-words text-[13px] leading-5">{status.reason}</p>}
          {status?.state === "stopped" && <p className="mx-auto mt-2 max-w-80 text-[13px] leading-5">It wakes when {bot.name} uses it, or now.</p>}
          {wakeError && <p role="alert" className="mx-auto mt-2 max-w-96 text-[13px] leading-5">{wakeError}</p>}
          {(status?.state === "stopped" || status?.state === "failed") && <button type="button" onClick={() => void wake()} disabled={waking} className="mx-auto mt-5 inline-flex min-h-11 items-center gap-2 rounded-full border border-white/15 bg-white/10 px-4 text-white disabled:opacity-40">{waking ? <Spinner size={14} /> : <Monitor size={16} />}{waking ? "Waking up…" : "Wake up"}</button>}
          {(status?.state === "building" || status?.state === "starting") && <div className="mt-5 grid place-items-center"><Spinner size={18} /></div>}
        </div></div>}
    </main>
    {help && !control ? <HelpCard instruction={help.instruction} onTakeOver={() => void takeOver()} busy={waking} /> : null}
    {control && pasteOpen ? <div className="shrink-0 border-t border-white/10 px-4 py-3">
      <textarea autoFocus rows={3} maxLength={2000} value={paste} placeholder={`Text to type into ${bot.name}’s screen`} onChange={(event) => setPaste(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); setPasteOpen(false); } }} className="w-full resize-none rounded-lg bg-white/10 px-3 py-2 text-[15px] leading-5 text-white outline-none placeholder:text-white/40 focus:ring-1 focus:ring-white/50" />
      {pasteError ? <p role="alert" className="mt-2 break-words text-[13px] leading-5 text-danger">{pasteError}</p> : null}
      <div className="mt-3 flex items-center gap-2">
        <button type="button" onClick={() => void typeText()} disabled={typing || !paste} className="inline-flex min-h-9 items-center gap-2 rounded-full border border-white/15 bg-white/10 px-4 text-[14px] text-white disabled:opacity-40">{typing ? <Spinner size={14} /> : null}Send</button>
        <button type="button" onClick={() => setPasteOpen(false)} className="inline-flex min-h-9 items-center rounded-full border border-white/15 bg-white/10 px-4 text-[14px] text-white/80">Cancel</button>
      </div>
    </div> : null}
    <footer className="flex min-h-16 shrink-0 items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0 text-[12px] text-white/50"><span role="status">{statusText}</span><span className="block">Shared desktop · files and sign-ins are shared by all Bots</span></div>
      {live ? control
        ? <div className="flex shrink-0 items-center gap-2">
          <button type="button" onClick={() => { setPasteOpen((open) => !open); setPasteError(null); }} className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-full border border-white/15 bg-white/10 px-4 text-[15px] text-white"><ClipboardPaste size={16} />Paste text</button>
          <button type="button" onClick={() => setControl(false)} className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-full border border-white/15 bg-white/10 px-4 text-[15px] text-white"><Check size={16} />I'm done</button>
        </div>
        : <button type="button" onClick={() => setControl(true)} className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-full border border-white/15 bg-white/10 px-4 text-[15px] text-white"><Hand size={16} />Take control</button>
        : null}
    </footer>
  </div>;
}

/** The Computer dialog: the Bot's desktop screen while Settings › Beta › Computer is on, else T3's browser. */
export function ComputerDialog({ slug }: { slug: string }) {
  const bot = useApp(s => s.bots[slug]);
  const desktopOn = useApp(s => s.settings?.beta?.desktop === true);
  const [browser, setBrowser] = useState(false);
  if (bot && desktopOn && !browser) return <DesktopView bot={bot} onBrowser={() => setBrowser(true)} />;
  return <ComputerOverlay slug={slug} />;
}
