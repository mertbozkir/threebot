import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { ArrowLeftRight, X } from "lucide-react";
import { Avatar } from "./Avatar";
import { botTextColor } from "../lib/character";
import { BotBubble } from "./Chat";
import { IconButton, Spinner } from "./ui";
import { openExchange, useApp, watchThread } from "../store";
import { botExchange } from "../lib/botMessages";
import type { Bot } from "../lib/types";

export function BotExchange({ bot, other }: { bot: Bot; other: Bot }) {
  const data = useApp((s) => s.threadData);
  const scroller = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const cleanups = [bot.mainThreadId, other.mainThreadId].flatMap((id) => id ? [watchThread(id, false)] : []);
    const previousFocus = document.activeElement;
    close.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !useApp.getState().dialog) openExchange(null); };
    window.addEventListener("keydown", onKey);
    return () => { for (const cleanup of cleanups) cleanup(); window.removeEventListener("keydown", onKey); if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true }); };
  }, [bot.mainThreadId, other.mainThreadId]);
  const left = bot.mainThreadId ? data[bot.mainThreadId] : undefined;
  const right = other.mainThreadId ? data[other.mainThreadId] : undefined;
  const entries = useMemo(() => botExchange([...Object.values(left?.items ?? {}), ...Object.values(right?.items ?? {})], bot.mainThreadId ?? "", other.mainThreadId ?? ""), [left?.items, right?.items, bot.mainThreadId, other.mainThreadId]);
  useLayoutEffect(() => { if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight; }, [entries.length]);
  const loaded = left?.loaded && right?.loaded;
  return <section className="bot-exchange absolute inset-0 z-30 flex flex-col bg-chat" aria-label={`Bot exchange between ${bot.name} and ${other.name}`}>
    <header className="flex min-h-[60px] shrink-0 items-center justify-center px-12">
      <div className="flex min-w-0 items-center gap-2 rounded-full bg-elevated px-3 py-2 text-[13.5px]"><Avatar shape={bot.shape} color={bot.color} picture={bot.avatarImage} size={22} /><span className="truncate">{bot.name}</span><ArrowLeftRight size={14} className="shrink-0 text-muted" /><Avatar shape={other.shape} color={other.color} picture={other.avatarImage} size={22} /><span className="truncate">{other.name}</span></div>
      <IconButton className="absolute right-3" onClick={() => openExchange(null)} aria-label="Close exchange"><X size={17} /></IconButton>
    </header>
    <div ref={scroller} className="scroll-thin min-h-0 flex-1 overflow-y-auto" aria-label="Bot exchange transcript">
      <div className="mx-auto flex max-w-[960px] flex-col gap-5 px-5 py-8">
        {!loaded && <div className="flex justify-center py-6 text-muted"><Spinner /></div>}
        {loaded && !entries.length && <p className="py-8 text-center text-[13px] text-muted">No messages between these Bots yet.</p>}
        {entries.map((entry) => {
          const sender = entry.senderThreadId === bot.mainThreadId ? bot : other;
          return <article key={entry.id} className="flex items-end gap-2"><Avatar shape={sender.shape} color={sender.color} picture={sender.avatarImage} size={23} /><div className="min-w-0"><div className="mb-1.5 ml-3 text-[12px]" style={{ color: botTextColor(sender.color) }}>{sender.name}<time className="ml-2 text-[11px] text-faint" dateTime={entry.at}>{new Date(entry.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</time></div><BotBubble text={entry.text} /></div></article>;
        })}
      </div>
    </div>
    <footer className="flex shrink-0 justify-center px-5 py-5"><button ref={close} onClick={() => openExchange(null)} className="rounded-full bg-elevated px-5 py-2.5 text-[14px] hover:bg-hover">Close Chat</button></footer>
  </section>;
}
