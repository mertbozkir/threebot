import { useEffect, useRef, useState } from "react";
import { ComputerOverlay } from "./Computer";
import { ArrowLeft, Check, Globe, Hand, Moon, Monitor } from "lucide-react";
import { Avatar } from "./Avatar";
import { ActivityAvatar } from "./ActivityAvatar";
import { Spinner } from "./ui";
import { botStatus, openDialog, useApp } from "../store";
import { api, type DesktopStatus } from "../lib/api";
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
      try { const next = await api.desktop(slug); if (live) { setStatus(next); setError(null); } }
      catch (e) { if (live) setError(e instanceof Error ? e.message : "Couldn’t reach the computer"); }
      // Poll only while this view is open and visible.
      if (live) timer = setTimeout(() => { if (document.visibilityState === "visible") void load(); else timer = setTimeout(load, POLL_MS); }, POLL_MS);
    };
    refresh.current = load;
    void load();
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, [slug]);
  return { status, error, refresh: () => refresh.current() };
}

function DesktopScreen({ slug, control, onDisconnect }: { slug: string; control: boolean; onDisconnect: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    let rfb: Rfb | null = null;
    let cancelled = false;
    const hide = () => { if (document.visibilityState === "hidden") rfb?.disconnect(); };
    void import("@novnc/novnc").then(({ default: RFB }) => {
      if (cancelled || !box.current) return;
      rfb = new RFB(box.current, vncUrl(slug, control ? "control" : "watch")) as Rfb;
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
    return () => { cancelled = true; document.removeEventListener("visibilitychange", hide); rfb?.disconnect(); };
  }, [slug, control]);
  return <div className="relative min-h-0 flex-1">
    <div ref={box} className="absolute inset-0" aria-label={control ? "Desktop, you're in control" : "Desktop, watching"} />
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
  const activity = useApp(s => botStatus(bot, s));
  const close = () => openDialog(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !control) close(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [control]);
  const live = status?.state === "healthy";
  if (!live && control) setControl(false);
  const wake = async () => {
    setWaking(true); setWakeError(null);
    try { await api.wakeDesktop(bot.slug); } catch (e) { setWakeError(e instanceof Error ? e.message : "Couldn’t wake the computer"); }
    finally { setWaking(false); await refresh(); }
  };
  const help = status?.helpRequest ?? null;
  const takeOver = async () => { if (!live) await wake(); setControl(true); };
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
      {live ? <DesktopScreen key={String(control)} slug={bot.slug} control={control} onDisconnect={() => void refresh()} />
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
    <footer className="flex min-h-16 shrink-0 items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0 text-[12px] text-white/50"><span role="status">{statusText}</span><span className="block">Shared desktop · files and sign-ins are shared by all Bots</span></div>
      {live ? control
        ? <button type="button" onClick={() => setControl(false)} className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-full border border-white/15 bg-white/10 px-4 text-[15px] text-white"><Check size={16} />I'm done</button>
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
