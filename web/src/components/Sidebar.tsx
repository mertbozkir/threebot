import { useEffect, useMemo, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import clsx from "clsx";
import { Archive, ArrowLeftRight, FolderKanban, CircleCheck, ArrowUp, ArrowDown, RotateCcw, Check, ChevronDown, ChevronRight, ChevronUp, CloudDownload, Copy, Ellipsis, EyeOff, Eye, Folder, FolderInput, FolderPlus, Gauge, Grid2x2Plus, LayoutGrid, ListChecks, LogOut, MailOpen, Paperclip, Pencil, Pin, PinOff, Plus, Search, Send, Settings as SettingsIcon, Star, Trash2 } from "lucide-react";
import { ActivityAvatar } from "./ActivityAvatar";
import { Menu, Modal, Pill, RoundButton, type MenuItem } from "./ui";
import { useUsagePeak } from "./UsagePanel";
import { UpdatePopover, useUpdateNotice } from "./RemoteAccess";
import { archiveThread, archivedInT3, unarchiveBotProject, isSettled, setThreadDone, botStatus, mainThread, markThreadRead, markThreadUnread, openDialog, openProjects, saveSettings, select, toast, updateBot, useApp, useProjectsOn, type BotStatus } from "../store";
import { followBoard, isOpenTask, useBoard } from "../lib/projects";
import { copyText } from "../lib/t3";
import { api, signOutTarget } from "../lib/api";
import type { Bot, ThreadShell } from "../lib/types";

function preview(bot: Bot, status: BotStatus) {
  const s = useApp.getState();
  const latest = bot.mainThreadId ? s.previews[bot.mainThreadId] : undefined;
  if (status === "done") return { text: latest?.text ?? "Finished", tone: "muted" as const, icon: <Check size={15} />, at: latest?.at };
  if (status === "waiting") return { text: `Waiting for you${latest ? `: ${latest.text}` : ""}`, tone: "attention" as const, icon: null, at: latest?.at };
  if (!latest) return { text: bot.label || "New Bot", tone: "muted" as const, icon: null, at: null };
  const icon = latest.kind === "attachment" ? <Paperclip size={15} /> : latest.kind === "sent" ? <Send size={15} /> : latest.kind === "question" ? <ListChecks size={15} /> : null;
  return { text: latest.text, tone: "muted" as const, icon, at: latest.at };
}

const lastActivity = (bot: Bot, s = useApp.getState()) => {
  const thread = mainThread(bot, s);
  return (bot.mainThreadId ? s.previews[bot.mainThreadId]?.at : null) ?? thread?.updatedAt ?? bot.createdAt ?? "";
};

export function Sidebar({ wide = false }: { wide?: boolean }) {
  const bots = useApp((s) => s.bots);
  const projects = useApp((s) => s.projects);
  const threads = useApp((s) => s.threads);
  const previews = useApp((s) => s.previews);
  const selected = useApp((s) => s.selected);
  const settings = useApp((s) => s.settings);
  const compact = useApp((s) => s.sidebarCompact);
  const width = useApp((s) => s.sidebarWidth);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [deletingSection, setDeletingSection] = useState<string | null>(null);
  const [sectionBusy, setSectionBusy] = useState(false);
  const page = useApp((s) => s.page);
  const projectsOn = useProjectsOn();
  const [, tick] = useState(0);
  useEffect(() => { const timer = setInterval(() => tick((v) => v + 1), 30_000); return () => clearInterval(timer); }, []);
  const [showHidden, setShowHidden] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const list = useRef<HTMLDivElement>(null);
  const [attention, setAttention] = useState<"above" | "below" | null>(null);

  const { pinned, groups, hidden } = useMemo(() => {
    const all = Object.values(bots).sort((a, b) => lastActivity(b).localeCompare(lastActivity(a)));
    const off = (b: Bot) => b.hidden || archivedInT3(b, projects);
    const visible = all.filter((b) => !off(b));
    const pinned = visible.filter((b) => b.primary || b.pinned).sort((a, b) => Number(b.primary) - Number(a.primary) || (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
    const rest = visible.filter((b) => !b.primary && !b.pinned);
    const order = [...(settings?.sections ?? [])];
    for (const b of rest) if (b.section && !order.includes(b.section)) order.push(b.section);
    const groups = order.map((name) => ({ name, bots: rest.filter((b) => b.section === name) }));
    const unassigned = rest.filter((b) => !b.section || !order.includes(b.section));
    if (unassigned.length) groups.push({ name: groups.length ? "Unassigned" : "", bots: unassigned });
    return { pinned, groups, hidden: all.filter(off) };
    // threads and previews affect ordering
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bots, threads, previews, settings?.sections, projects]);

  // The native roster offers a way back to a waiting chat that has scrolled out of view.
  const measureAttention = () => {
    const scroller = list.current;
    if (!wide || !scroller) return setAttention(null);
    const view = scroller.getBoundingClientRect();
    const rows = Array.from(scroller.querySelectorAll<HTMLElement>('[data-status="waiting"]')).map((row) => row.getBoundingClientRect());
    if (rows.some((row) => row.bottom > view.top + 76 && row.top < view.bottom - 76)) return setAttention(null);
    setAttention(rows.some((row) => row.top <= view.top + 76) ? "above" : rows.length ? "below" : null);
  };
  useEffect(measureAttention);
  const jumpToAttention = () => {
    const scroller = list.current;
    const rows = Array.from(scroller?.querySelectorAll<HTMLElement>('[data-status="waiting"]') ?? []);
    (attention === "above" ? rows.at(-1) : rows[0])?.scrollIntoView({ block: "center", behavior: "smooth" });
  };

  const openSectionMenu = (event: MenuPoint, name: string) => {
    event.preventDefault();
    const sections = groups.map(group => group.name).filter(section => section && section !== "Unassigned");
    const index = sections.indexOf(name);
    const move = (offset: number) => {
      const next = [...sections];
      [next[index], next[index + offset]] = [next[index + offset], next[index]];
      void saveSettings({ sections: next }).catch(error => toast(error.message));
    };
    setMenu({ x: event.clientX, y: event.clientY, items: [
      // The audit did not establish the Android Rename form or desktop save behavior.
      { label: "Rename", icon: <Pencil size={14} />, disabled: true },
      { label: wide ? "Move Up" : "Move up", icon: <ArrowUp size={14} />, disabled: index <= 0, onSelect: () => move(-1) },
      { label: wide ? "Move Down" : "Move down", icon: <ArrowDown size={14} />, disabled: index < 0 || index === sections.length - 1, onSelect: () => move(1) },
      { label: "Delete", icon: <Trash2 size={14} />, danger: true, onSelect: () => setDeletingSection(name) },
    ] });
  };
  const deleteSection = async () => {
    if (!deletingSection || sectionBusy) return;
    setSectionBusy(true);
    try {
      // A section is organization only. Deleting it never deletes its Bots.
      for (const bot of Object.values(bots).filter(bot => bot.section === deletingSection)) await updateBot(bot.slug, { section: null });
      await saveSettings({ sections: (settings?.sections ?? []).filter(name => name !== deletingSection) });
      setDeletingSection(null);
    } catch (error) { toast(error instanceof Error ? error.message : "Couldn't update the Bot"); }
    finally { setSectionBusy(false); }
  };

  const openMenu = (e: MenuPoint, bot: Bot) => {
    e.preventDefault();
    const sections = settings?.sections ?? [];
    const thread = mainThread(bot);
    const report = (operation: Promise<unknown>) => operation.catch((error: unknown) => toast(error instanceof Error ? error.message : "Couldn't update the Bot"));
    const organizationItems: MenuItem[] = bot.primary ? [] : [
      { label: bot.pinned ? "Unpin" : "Pin", icon: bot.pinned ? <PinOff size={14} /> : <Pin size={14} />, onSelect: () => report(updateBot(bot.slug, { pinned: !bot.pinned })) },
      {
        label: "Move to new section",
        icon: <FolderPlus size={14} />,
        onSelect: () => {
          const name = prompt("Section name")?.trim();
          if (!name) return;
          report((async () => {
            if (!sections.includes(name)) await saveSettings({ sections: [...sections, name] });
            await updateBot(bot.slug, { section: name, pinned: false });
          })());
        },
      },
      ...sections
        .map((s) => ({ label: `Move to ${s}`, icon: bot.section === s ? <Check size={14} /> : <FolderInput size={14} />, onSelect: () => report(updateBot(bot.slug, { section: s, pinned: false })) })),
      ...(bot.section ? [{ label: "Move to Unassigned", icon: <FolderInput size={14} />, onSelect: () => report(updateBot(bot.slug, { section: null })) }] : []),
    ];
    const mainBotItem: MenuItem = bot.primary
      ? { label: wide ? "Replace Primary Bot…" : "Replace with different Bot", icon: <ArrowLeftRight size={14} />, onSelect: () => openDialog({ kind: "main-bot", intent: { kind: "replace" } }) }
      : { label: "Replace with different Bot", icon: <Star size={14} />, onSelect: () => openDialog({ kind: "main-bot", intent: { kind: "replace" }, initialSlug: bot.slug }) };
    const unread = botStatus(bot) === "unread";
    const unreadItem: MenuItem = { label: unread ? wide ? "Mark Read" : "Mark as Read" : "Mark as Unread", icon: unread && wide ? <CircleCheck size={14} /> : <MailOpen size={14} />, onSelect: () => bot.mainThreadId && report(unread ? markThreadRead(bot.mainThreadId) : markThreadUnread(bot.mainThreadId)) };
    const renameItem: MenuItem = { label: "Rename Bot", icon: <Pencil size={14} />, onSelect: () => openDialog({ kind: "rename-bot", slug: bot.slug }) };
    const copyIdItem: MenuItem = {
      label: "Copy conversation ID",
      icon: <Copy size={14} />,
      onSelect: () => {
        if (!bot.mainThreadId) { toast("Conversation ID unavailable"); return; }
        copyText(bot.mainThreadId).then(
          () => toast("Copied conversation ID"),
          () => toast("Couldn't copy conversation ID"),
        );
      },
    };
    const t3Archived = archivedInT3(bot, projects);
    const hideItem: MenuItem = bot.hidden || t3Archived
      ? { label: wide ? "Unhide" : "Show in sidebar", icon: <Eye size={14} />, onSelect: () => report((async () => { if (t3Archived) await unarchiveBotProject(bot); if (bot.hidden) await updateBot(bot.slug, { hidden: false }); })()) }
      : { label: wide ? "Hide" : "Hide from sidebar", danger: wide, icon: <EyeOff size={14} />, onSelect: () => bot.primary ? openDialog({ kind: "main-bot", intent: { kind: "hide", slug: bot.slug } }) : report(updateBot(bot.slug, { hidden: true, pinned: false })) };
    const deleteItem: MenuItem = { label: bot.adopted ? "Turn back into a plain project" : "Delete", icon: bot.adopted ? <FolderInput size={14} /> : <Trash2 size={14} />, danger: true, onSelect: () => bot.primary && Object.keys(bots).length > 1 ? openDialog({ kind: "main-bot", intent: { kind: "delete", slug: bot.slug } }) : openDialog({ kind: "delete-bot", slug: bot.slug }) };
    if (wide) {
      const [pinItem, ...moveItems] = organizationItems;
      const pinned = bot.primary || bot.pinned;
      const items: MenuItem[] = [
        ...(!pinned ? lifecycleItems(thread) : []),
        unreadItem,
        ...(pinItem ? [pinItem] : []),
        ...(bot.primary ? [mainBotItem] : []),
        ...(moveItems.length ? [{ label: "Move to", icon: <Folder size={14} />, items: moveItems }] : []),
        hideItem,
        { label: "More", icon: <Ellipsis size={14} />, items: [...(pinned ? lifecycleItems(thread) : []), ...(bot.primary ? [] : [mainBotItem]), renameItem, copyIdItem, deleteItem] },
      ];
      setMenu({ x: e.clientX, y: e.clientY, items });
      return;
    }
    const items: MenuItem[] = [
      ...lifecycleItems(thread),
      mainBotItem,
      ...organizationItems,
      unreadItem,
      renameItem,
      copyIdItem,
      hideItem,
      "divider",
      deleteItem,
    ];
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  if (!wide && compact) return <aside className="compact-sidebar flex h-full w-[88px] shrink-0 flex-col bg-sidebar" aria-label="Bots" aria-description="Toggle compact sidebar" aria-keyshortcuts="Meta+B">
    <div className="h-[52px] shrink-0" />
    <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-4">
      {[pinned, ...groups.map((g) => g.bots)].filter((group) => group.length).map((group, index) => <div key={index} className="flex flex-col items-center gap-2 border-b border-line py-3 last:border-0">{group.map((bot) => {
        const status = botStatus(bot);
        return <RosterButton key={bot.slug} title={`${bot.name}${bot.primary ? " · Main Bot" : ""}${status === "waiting" ? " · Waiting for you" : ""}`} aria-label={bot.name} aria-current={selected === bot.slug ? "page" : undefined} onClick={() => select(bot.slug)} onMenu={(event) => openMenu(event, bot)} className={clsx("relative grid size-[54px] place-items-center rounded-[14px]", selected === bot.slug ? "bg-active" : "hover:bg-hover")}><ActivityAvatar threadId={bot.mainThreadId} status={status} shape={bot.shape} color={bot.color} picture={bot.avatarImage} size={36} star={bot.primary} />{(status === "waiting" || status === "unread") && <Dot status={status} className="absolute right-1 bottom-1" />}</RosterButton>;
      })}</div>)}
    </div>
    <div className="flex shrink-0 flex-col items-center gap-2 pt-2">{projectsOn && <RoundButton onClick={() => openProjects()} title="Projects" aria-label="Projects" aria-current={page === "projects" ? "page" : undefined} className={page === "projects" ? "bg-active" : undefined}><FolderKanban size={17} /></RoundButton>}<RoundButton onClick={() => openDialog("new-bot")} title="New Bot" aria-label="New Bot"><Plus size={18} /></RoundButton><RoundButton onClick={() => openDialog("connect-apps")} title="Connect apps" aria-label="Connect apps"><LayoutGrid size={17} /></RoundButton><UpdateButton /></div>
    <AccountRow compact />
    {menu && <Menu {...menu} onClose={() => setMenu(null)} />}
  </aside>;

  return (
    <aside aria-description="Toggle compact sidebar" aria-keyshortcuts="Meta+B" className={clsx("bot-sidebar flex h-full shrink-0 flex-col bg-sidebar", wide ? "mobile-home w-full" : "")} style={wide ? undefined : { width }}>
      <div className="sidebar-header flex h-[52px] shrink-0 items-center justify-end gap-2 px-3">
        <RoundButton onClick={() => openDialog("search")} title="Search (⌘K)" aria-label="Search">
          <Search size={wide ? 19 : 15} />
        </RoundButton>
        {wide
          ? <button className="mobile-account grid size-11 place-items-center rounded-full border border-line bg-elevated text-[18px] font-semibold" aria-label="Settings" onClick={() => { useApp.setState({ settingsPane: "overview" }); openDialog("settings"); }}>{(settings?.userName || "You")[0].toUpperCase()}</button>
          : <RoundButton className="new-bot-button" onClick={() => openDialog("new-bot")} title="New Bot" aria-label="New Bot"><Plus size={16} /></RoundButton>}
      </div>

      {wide && attention && <button className="mobile-attention pop-in" aria-label={`Jump to the chat needing attention ${attention}`} onClick={jumpToAttention}>Needs attention{attention === "above" ? <ChevronUp size={18} aria-hidden="true" /> : <ChevronDown size={18} aria-hidden="true" />}</button>}

      <div ref={list} onScroll={wide ? measureAttention : undefined} className="bot-list scroll-thin min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {projectsOn && <ProjectsRow large={wide} current={page === "projects"} />}
        {pinned.length > 0 && (
          <div className="pinned-bots flex flex-wrap gap-1 px-1 pt-1 pb-3">
            {pinned.map((b) => {
              const st = botStatus(b);
              return (
                <div key={b.slug} className="relative" data-status={st}>
                <RosterButton
                  onClick={() => select(b.slug)}
                  onMenu={(e) => openMenu(e, b)}
                  aria-label={`${b.name}${b.primary ? ", main Bot" : ""}`}
                  className={clsx("pinned-bot flex w-[76px] flex-col items-center gap-1.5 rounded-2xl pt-2.5 pb-2 transition-colors", selected === b.slug ? "bg-active" : "hover:bg-hover")}
                >
                  <span className="relative">
                    <ActivityAvatar threadId={b.mainThreadId} status={st} quietWaiting={wide} shape={b.shape} color={b.color} picture={b.avatarImage} size={wide ? 52 : 60} star={b.primary} />
                    {(st === "waiting" || (!wide && st === "unread")) && <Dot status={st} className="absolute -top-0.5 -right-0.5" />}
                  </span>
                  <span className="pinned-name w-full truncate px-1 text-center text-[12px] text-fg/90">{b.name}{wide && st === "unread" && <Dot status={st} className="ml-1.5 inline-block align-middle" />}{b.primary && <span className="pinned-main-label block text-[10px] text-muted">Main Bot</span>}</span>
                </RosterButton>
                <button aria-label={`Options for ${b.name}`} title={`Options for ${b.name}`} onClick={(event) => openMenu(event, b)} className="absolute -top-1 right-0 grid size-7 place-items-center rounded-full bg-sidebar text-muted hover:bg-hover"><Ellipsis size={16} /></button>
                </div>
              );
            })}
          </div>
        )}

        {groups.map((g) => (
          <div key={g.name || "_"} className="mb-2">
            {g.name && (
              <RosterButton
                onMenu={(event) => { if (g.name !== "Unassigned") openSectionMenu(event, g.name); }}
                onClick={() => setCollapsed((c) => ({ ...c, [g.name]: !c[g.name] }))}
                aria-expanded={!collapsed[g.name]}
                aria-label={`${g.name}, ${g.bots.length} chat${g.bots.length === 1 ? "" : "s"}`}
                className="bot-section-title group flex h-7 w-full items-center gap-1 px-2.5 text-[12.5px] text-muted hover:text-fg"
              >
                {g.name}
                {collapsed[g.name] && <span className="section-count">{g.bots.length}</span>}
                <ChevronDown size={12} className={clsx("section-chevron opacity-0 transition group-hover:opacity-100", collapsed[g.name] && "-rotate-90")} />
              </RosterButton>
            )}
            {!collapsed[g.name] && !g.bots.length && <p className="section-empty px-2.5 py-2 text-[13px] text-muted">No chats</p>}
            {!collapsed[g.name] && g.bots.map((b) => <BotRow key={b.slug} large={wide} bot={b} selected={selected === b.slug} onMenu={openMenu} />)}
          </div>
        ))}

        {Object.keys(bots).length === 0 && (
          <div className="px-3 pt-6 text-center text-[13px] text-muted">
            No Bots yet.
            <button onClick={() => openDialog("new-bot")} className="mt-3 block w-full rounded-xl bg-hover py-2 text-fg hover:bg-active">
              Create your first Bot
            </button>
          </div>
        )}

        {hidden.length > 0 && (
          <div className="mt-1">
            <button onClick={() => setShowHidden((v) => !v)} className="flex h-7 w-full items-center gap-1 px-2.5 text-[12.5px] text-muted hover:text-fg">
              Hidden Bots {hidden.length}
              <ChevronRight size={12} className={clsx("transition", showHidden && "rotate-90")} />
            </button>
            {showHidden && hidden.map((b) => <BotRow key={b.slug} large={wide} bot={b} selected={selected === b.slug} onMenu={openMenu} />)}
          </div>
        )}
      </div>

      {wide ? <div className="mobile-home-toolbar flex shrink-0 items-center gap-3 px-4 py-3">
        <RoundButton className="size-11" onClick={() => openDialog("connect-apps")} aria-label="Connect apps"><Grid2x2Plus size={21} /></RoundButton>
        <UpdateButton large className="me-auto" />
        <button className="mobile-new-bot" onClick={() => openDialog("new-bot")} aria-label="New Bot"><Plus size={20} aria-hidden="true" /> New Bot</button>
      </div> : <AccountRow />}
      {menu && <Menu {...menu} onClose={() => setMenu(null)} />}
      {deletingSection && <Modal onClose={() => { if (!sectionBusy) setDeletingSection(null); }} className="section-delete w-[340px]">
        <div className="p-5 text-[18px]">Delete “{deletingSection}”</div>
        <div className="flex justify-end gap-3 p-4"><Pill variant="ghost" disabled={sectionBusy} onClick={() => setDeletingSection(null)}>Cancel</Pill><Pill variant="danger" disabled={sectionBusy} onClick={() => void deleteSection()}>Delete</Pill></div>
      </Modal>}
    </aside>
  );
}

/** The way to the Projects page, with the count of open to-dos once the board has loaded. */
function ProjectsRow({ large, current }: { large: boolean; current: boolean }) {
  // Following the board here keeps the count live while the app is open.
  useEffect(() => followBoard(), []);
  const open = useBoard((s) => (s.status === "ready" ? Object.values(s.items).filter(isOpenTask).length : null));
  return (
    <button onClick={() => openProjects()} aria-current={current ? "page" : undefined} className={clsx("projects-nav mb-1 flex w-full items-center gap-3 rounded-[10px] px-2 text-left transition-colors", large ? "py-[9px]" : "py-[7px]", current ? "bg-active" : "hover:bg-hover")}>
      <span className={clsx("grid shrink-0 place-items-center rounded-[12px] border border-line text-muted", large ? "size-11" : "size-9")}><FolderKanban size={large ? 20 : 17} /></span>
      <span className="min-w-0 flex-1"><span className="block truncate text-[13.5px] leading-5">Projects</span><span className="block truncate text-[12.5px] leading-[18px] text-muted">{open === null ? "To-dos, machines, what's running" : open ? `${open} open to-do${open === 1 ? "" : "s"}` : "Nothing open"}</span></span>
    </button>
  );
}

function Dot({ status, className }: { status: BotStatus; className?: string }) {
  return <span className={clsx("size-2 rounded-full ring-2 ring-[var(--bg-sidebar)]", status === "waiting" ? "bg-attention" : "bg-accent", className)} />;
}

function BotRow({ bot, selected, onMenu, large }: { large: boolean; bot: Bot; selected: boolean; onMenu: (e: MenuPoint, b: Bot) => void }) {
  useApp((s) => s.threads[bot.mainThreadId ?? ""]);
  const st = botStatus(bot);
  useApp((s) => s.previews[bot.mainThreadId ?? ""]);
  const p = preview(bot, st);
  return (
    <div className="relative" data-status={st}>
    <RosterButton
      aria-label={`Chat with ${bot.name}${st === "unread" ? ", unread" : st === "waiting" ? ", waiting for you" : ""}`}
      onClick={() => select(bot.slug)}
      onMenu={(e) => onMenu(e, bot)}
      className={clsx("bot-row flex w-full items-center gap-3 rounded-[10px] px-2 py-[9px] text-left transition-colors", selected ? "bg-active" : "hover:bg-hover")}
    >
      <ActivityAvatar threadId={bot.mainThreadId} status={st} quietWaiting={large} shape={bot.shape} color={bot.color} picture={bot.avatarImage} size={large ? 44 : 36} star={bot.primary} />
      <span className="min-w-0 flex-1 pr-7">
        <span className="flex items-baseline gap-2"><span className="bot-row-name block min-w-0 flex-1 truncate text-[13.5px] leading-5 text-fg">{bot.name}</span><span className="bot-row-time hidden shrink-0 text-[12px] text-faint">{messageDate(p.at ?? undefined)}</span></span>
        <span className={clsx("bot-row-preview flex min-w-0 items-center gap-1.5 text-[12.5px] leading-[18px]", p.tone === "attention" ? "text-attention" : "text-muted")}>{p.icon && <PreviewIcon>{p.icon}</PreviewIcon>}<span className="min-w-0 truncate">{p.text}</span></span>
      </span>
      {(st === "waiting" || st === "unread") && <span className={clsx("size-2 shrink-0 rounded-full", st === "waiting" ? "bg-attention" : "bg-accent")} />}
    </RosterButton>
    <button aria-label={`Options for ${bot.name}`} title={`Options for ${bot.name}`} onClick={(event) => onMenu(event, bot)} className="absolute top-1/2 right-1 grid size-7 -translate-y-1/2 place-items-center rounded-full text-muted hover:bg-hover"><Ellipsis size={16} /></button>
    </div>
  );
}

function PreviewIcon({ children }: { children: ReactNode }) {
  return <span className="shrink-0 opacity-70" aria-hidden="true">{children}</span>;
}

export function messageDate(iso?: string, now = new Date()) {
  if (!iso) return "";
  const date = new Date(iso);
  if (date.toDateString() === now.toDateString()) return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  if (now.getTime() - date.getTime() < 6 * 86_400_000) return date.toLocaleDateString([], { weekday: "long" });
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function AccountRow({ compact = false }: { compact?: boolean }) {
  const settings = useApp((s) => s.settings);
  const connection = useApp((s) => s.connection);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const name = settings?.userName || "You";
  return (
    <div className={clsx("flex h-[60px] shrink-0 items-center gap-2 px-3", compact && "justify-center")}>
      <button
        onClick={(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          setMenu({ x: r.left, y: r.top - 150 });
        }}
        aria-label="Open account menu"
        className={clsx("flex min-w-0 items-center gap-2.5 rounded-xl px-1.5 py-1.5 hover:bg-hover", !compact && "flex-1")}
      >
        <span className="relative grid size-7 place-items-center rounded-full bg-pill-soft text-[12px] font-medium">
          {name[0]?.toUpperCase()}
          <span className={clsx("absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-[var(--bg-sidebar)]", connection === "open" ? "bg-success" : connection === "connecting" ? "bg-attention" : "bg-danger")} title={`T3 ${connection}`} />
        </span>
        {!compact && <span className="truncate text-[13.5px]">{name}</span>}
      </button>
      {!compact && <RoundButton onClick={() => openDialog("connect-apps")} title="Connect apps" aria-label="Connect apps">
        <LayoutGrid size={15} />
      </RoundButton>}
      {!compact && <UpdateButton />}
      {menu && <AccountMenu {...menu} onClose={() => setMenu(null)} />}
    </div>
  );
}

/**
 * T3 Code's footer update button: shown once Settings → Updates could install a newer release. It opens
 * a popover with what's new in it and an Update button.
 */
function UpdateButton({ large = false, className }: { large?: boolean; className?: string }) {
  const update = useUpdateNotice();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  if (!update?.installable) return null;
  const label = `Update to v${update.version}`;
  return <>
    <button type="button" onClick={(e) => { const el = e.currentTarget; setAnchor((open) => open ? null : el); }} title={label} aria-label={label} aria-haspopup="dialog" aria-expanded={Boolean(anchor)}
      className={clsx("update-button grid shrink-0 place-items-center rounded-full bg-accent text-app transition-[filter] hover:brightness-110", large ? "size-11" : "size-[30px]", className)}>
      <CloudDownload size={large ? 21 : 16} aria-hidden="true" />
    </button>
    {anchor && <UpdatePopover anchor={anchor} release={update.release} onClose={() => setAnchor(null)} />}
  </>;
}

type MenuPoint = { clientX: number; clientY: number; preventDefault: () => void };
function RosterButton({ onMenu, onClick, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { onMenu: (point: MenuPoint) => void }) {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const held = useRef(false);
  const cancel = () => { clearTimeout(timer.current); };
  useEffect(() => cancel, []);
  return <button {...props} onPointerDown={(e) => {
    if (e.pointerType === "mouse" || e.button !== 0) return;
    held.current = false; origin.current = { x: e.clientX, y: e.clientY };
    const point = { clientX: e.clientX, clientY: e.clientY, preventDefault() {} };
    timer.current = setTimeout(() => { held.current = true; onMenu(point); }, 500);
  }} onPointerMove={(e) => { if (origin.current && Math.hypot(e.clientX - origin.current.x, e.clientY - origin.current.y) > 12) cancel(); }} onPointerUp={cancel} onPointerCancel={cancel} onContextMenu={(e) => { e.preventDefault(); cancel(); if (!held.current) onMenu(e); }} onClick={(e) => { if (held.current) { held.current = false; e.preventDefault(); return; } onClick?.(e); }} />;
}
function lifecycleItems(thread: ThreadShell | undefined): MenuItem[] {
  if (!thread) return [];
  const report = (promise: Promise<unknown>) => promise.catch((error: unknown) => toast(error instanceof Error ? error.message : "Couldn't update conversation"));
  return [
    { label: isSettled(thread) ? "Reopen" : "Mark as finished", icon: isSettled(thread) ? <RotateCcw size={14}/> : <Check size={14}/>, onSelect: () => report(setThreadDone(thread.id, !isSettled(thread))) },
    { label: thread.archivedAt ? "Unarchive conversation" : "Archive", icon: <Archive size={14}/>, onSelect: () => report(archiveThread(thread.id, !thread.archivedAt)) },
  ];
}

/** Mounted only while open, so usage is read when asked for rather than for the whole session. */
function AccountMenu({ x, y, onClose }: { x: number; y: number; onClose: () => void }) {
  const usagePeak = useUsagePeak();
  return (
    <Menu
      x={x}
      y={y}
      onClose={onClose}
      items={[
        { label: "Usage", icon: <Gauge size={14} />, detail: usagePeak === null ? undefined : `${usagePeak}% used`, chevron: true, onSelect: () => { useApp.setState({ settingsPane: "usage" }); openDialog("settings"); } },
        { label: "Settings", icon: <SettingsIcon size={14} />, onSelect: () => openDialog("settings") },
        "divider",
        {
          label: "Log out",
          icon: <LogOut size={14} />,
          onSelect: async () => {
            const target = await signOutTarget();
            await api.logout();
            location.href = target;
          },
        },
      ]}
    />
  );
}
