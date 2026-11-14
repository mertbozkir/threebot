import { Component, useEffect, useRef, useState, type ReactNode } from "react";
import { Avatar } from "./components/Avatar";
import { Chat } from "./components/Chat";
import { RemoteThread } from "./components/RemoteThread";
import { ComputerOverlay } from "./components/Computer";
import { ConnectApps } from "./components/ConnectApps";
import { Details } from "./components/Details";
import { DeleteBotDialog, NewBotDialog, RenameBotDialog } from "./components/NewBotDialog";
import { AdoptProjectDialog } from "./components/AdoptProjectDialog";
import { SearchDialog } from "./components/SearchDialog";
import { SettingsDialog } from "./components/SettingsDialog";
import { UsageStatsPrompt } from "./components/UsageStats";
import { Sidebar } from "./components/Sidebar";
import { useAutoUpdateNotice } from "./components/RemoteAccess";
import { ProjectsPage } from "./components/Projects";
import { ColumnDivider } from "./components/ColumnDivider";
import { Modal, Pill, Spinner } from "./components/ui";
import { boot, botStatus, machineOf, openDialog, select, setDetailsOpen, setMainBot, setSidebarCompact, updateBot, useApp, useProjectsOn, type MainBotIntent } from "./store";
import { api } from "./lib/api";
import { MOBILE_LAYOUT_QUERY } from "./lib/layout";
import { navigationFor, navigationUrl, readNavigation, restoreNavigation } from "./lib/navigation";
import "./home-avatar.css";
import { DEFAULT_PALETTE, isDarkMode } from "./lib/themes";

function useTheme() {
  const theme = useApp((s) => s.settings?.theme ?? "dark");
  const palette = useApp((s) => s.settings?.palette ?? DEFAULT_PALETTE);
  useEffect(() => {
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark = isDarkMode(theme, mq.matches);
      document.documentElement.classList.toggle("dark", dark);
      // AMOLED has no light face; a light mode with it falls back to our own light palette.
      document.documentElement.dataset.palette = !dark && palette === "amoled" ? "midnight" : palette;
      document.querySelector('meta[name="theme-color"]')?.setAttribute("content", getComputedStyle(document.documentElement).getPropertyValue("--bg-app").trim() || "#000000");
    };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [theme, palette]);
}

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (e.key === "k") { e.preventDefault(); openDialog("search"); }
      else if (e.key === ",") { e.preventDefault(); openDialog("settings"); }
      else if (e.key === "n" && !e.shiftKey) { e.preventDefault(); openDialog("new-bot"); }
      else if (e.key === "b") { e.preventDefault(); if (e.altKey) setDetailsOpen(!useApp.getState().detailsOpen); else setSidebarCompact(!useApp.getState().sidebarCompact); }
      else if (/^[1-9]$/.test(e.key)) {
        const bots = Object.values(useApp.getState().bots).filter((b) => !b.hidden);
        const pinned = bots.filter((b) => b.primary || b.pinned).sort((a, b) => Number(b.primary) - Number(a.primary) || a.createdAt.localeCompare(b.createdAt));
        const ordered = [...pinned, ...bots.filter((b) => !b.primary && !b.pinned)];
        const b = ordered[Number(e.key) - 1];
        if (b) { e.preventDefault(); select(b.slug); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

export default function App() {
  const auth = useApp((s) => s.auth);
  const picture = useApp(s => s.selected ? s.bots[s.selected]?.avatarImage : null);
  useEffect(() => {
    const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (icon) icon.href = picture ?? "/favicon-32.png";
  }, [picture]);
  useTheme();
  useShortcuts();
  useEffect(() => {
    boot();
  }, []);
  if (auth === "unknown" || auth === "loading") return <div className="grid h-full place-items-center bg-app"><div role="status" className="flex items-center gap-2 text-[14px] text-muted"><Spinner size={16} />Loading Bot…</div></div>;
  if (auth === "error") return <div className="grid h-full place-items-center bg-app"><div className="flex w-full max-w-[340px] flex-col items-center px-5 text-center"><h1 className="text-[22px] font-medium">Couldn't load Bot</h1><p role="alert" className="mt-2 text-[13.5px] text-muted">Check your connection and try again.</p><Pill className="mt-5 h-10 w-full text-[14px]" onClick={() => { void boot(); }}>Try again</Pill><a href={`${location.pathname}${location.search}`} className="mt-3 text-[13.5px] text-muted underline">Reload page</a></div></div>;
  if (auth === "access") return <AccessLogin />;
  if (auth === "password") return <Login />;
  return (
    <ErrorBoundary>
      <Shell />
    </ErrorBoundary>
  );
}

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="grid flex-1 place-items-center bg-chat p-8 text-center">
        <div>
          <div className="text-[15px] font-medium">Something went wrong</div>
          <div className="mt-2 max-w-[420px] font-mono text-[12px] text-muted">{this.state.error.message}</div>
          <Pill className="mt-4" onClick={() => this.setState({ error: null })}>Try again</Pill>
        </div>
      </div>
    );
  }
}

function useTitleBadge() {
  const bots = useApp((s) => s.bots);
  const threads = useApp((s) => s.threads);
  useEffect(() => {
    const n = Object.values(bots).filter((b) => !b.hidden && ["unread", "waiting"].includes(botStatus(b))).length;
    document.title = n ? `(${n}) Threebot` : "Threebot";
  }, [bots, threads]);
}

function Shell() {
  useTitleBadge();
  const bots = useApp((s) => s.bots);
  const selected = useApp((s) => s.selected);
  const historicalBots = useApp((s) => s.historicalBots);
  const detailsOpen = useApp((s) => s.detailsOpen);
  const sidebarCompact = useApp((s) => s.sidebarCompact);
  const selectedThreadId = useApp((s) => s.selectedThreadId);
  const settings = useApp((s) => s.settings);
  // A thread on a machine Threebot reaches only through T3's link reads over the gateway.
  const remoteLinked = useApp((s) => { const route = machineOf(s.selectedThreadId, s.machines)?.route; return route === "linked" || route === "none"; });
  const projectsOn = useProjectsOn();
  // Settings → Beta → Projects board off: the page (and links to it) lead home instead.
  const page = useApp((s) => s.page === "projects" && !projectsOn ? null : s.page);
  const bot = selected ? bots[selected] ?? historicalBots[selected] : undefined;
  const narrow = useNarrow();
  useNavigationHistory(narrow);

  useEffect(() => {
    if (settings && !projectsOn && useApp.getState().page === "projects") useApp.setState({ page: null, projectItemId: null });
  }, [settings, projectsOn]);

  useEffect(() => {
    if (!narrow && !bot && Object.keys(bots).length) {
      const first = Object.values(bots).find((b) => b.primary && !b.hidden) ?? Object.values(bots).find((b) => !b.hidden);
      if (first) select(first.slug);
    }
  }, [bot, bots, narrow]);

  return (
    <div className="flex h-full bg-app">
      <div className={narrow && (bot || page) ? "hidden" : "contents"}><Sidebar wide={narrow} /></div>
      {!narrow && !sidebarCompact && <ColumnDivider column="sidebar" />}
      <main className={narrow ? bot || page ? "flex min-w-0 flex-1 overflow-hidden" : "hidden" : "flex min-w-0 flex-1 overflow-hidden rounded-tl-[14px] border-t border-l border-line"}>
        {page === "projects" ? (
          <ErrorBoundary key="projects"><ProjectsPage narrow={narrow} onBack={narrow ? () => history.back() : undefined} /></ErrorBoundary>
        ) : bot ? (
          <ErrorBoundary key={bot.slug}>
            {remoteLinked
              ? <RemoteThread bot={bot} threadId={selectedThreadId!} onBack={narrow ? () => history.back() : undefined} />
              : <Chat bot={bot} threadId={selectedThreadId ?? bot.mainThreadId} onBack={narrow ? () => history.back() : undefined} />}
            {detailsOpen && <div className={narrow ? "fixed inset-0 z-40 flex justify-end bg-[var(--overlay)]" : "contents"} onClick={(event) => { if (narrow && event.target === event.currentTarget) setDetailsOpen(false); }}>
              {!narrow && <ColumnDivider key="divider" column="details" />}
              <Details key="details" bot={bot} threadId={remoteLinked ? bot.mainThreadId : selectedThreadId ?? bot.mainThreadId} />
            </div>}
          </ErrorBoundary>
        ) : settings ? (
          <Welcome />
        ) : null}
      </main>
      <Dialogs />
    </div>
  );
}

function useNavigationHistory(narrow: boolean) {
  const narrowRef = useRef(narrow);
  narrowRef.current = narrow;
  useEffect(() => {
    const initialNarrow = narrowRef.current;
    if (initialNarrow) useApp.setState({ detailsOpen: false });
    const initial = navigationFor(useApp.getState(), initialNarrow);
    if (initialNarrow && initial.view !== "list") {
      history.replaceState({ view: "list" }, "", location.pathname);
      history.pushState(initial, "", navigationUrl(initial, location.pathname));
    } else history.replaceState(initial, "", navigationUrl(initial, location.pathname));
    let restoring = false;
    const onPop = (event: PopStateEvent) => {
      const route = readNavigation(event.state);
      if (!route) return;
      restoring = true;
      const s = useApp.getState();
      useApp.setState(restoreNavigation(route, { ...s.historicalBots, ...s.bots }));
      restoring = false;
    };
    window.addEventListener("popstate", onPop);
    const unsubscribe = useApp.subscribe((s, prev) => {
      const narrow = narrowRef.current;
      if (s.selected !== prev.selected) {
        if (s.selected) localStorage.setItem("bot.selected", s.selected);
        else localStorage.removeItem("bot.selected");
      }
      if (restoring) return;
      const chatChanged = s.selected !== prev.selected || s.selectedThreadId !== prev.selectedThreadId || s.page !== prev.page || s.projectItemId !== prev.projectItemId;
      if (chatChanged || s.searchResultRevision !== prev.searchResultRevision) {
        if (narrow && s.detailsOpen) {
          restoring = true;
          useApp.setState({ detailsOpen: false });
          restoring = false;
        }
        const next = navigationFor(useApp.getState(), narrow);
        history.pushState(next, "", navigationUrl(next, location.pathname));
        return;
      }
      if (s.exchangeBotSlug !== prev.exchangeBotSlug) {
        if (!s.exchangeBotSlug && history.state?.view === "exchange") history.back();
        else { const next = navigationFor(s, narrow); history.pushState(next, "", navigationUrl(next, location.pathname)); }
        return;
      }
      if (!narrow && s.dialog !== "search" && prev.dialog !== "search") return;
      const overlayOpen = (narrow && s.detailsOpen && s.selected) || s.dialog;
      const wasOpen = (narrow && prev.detailsOpen && prev.selected) || prev.dialog;
      if (overlayOpen && !wasOpen) { const next = navigationFor(s, narrow); history.pushState(next, "", navigationUrl(next, location.pathname)); }
      else if (!overlayOpen && wasOpen && history.state?.view === "overlay") history.back();
    });
    return () => { window.removeEventListener("popstate", onPop); unsubscribe(); };
  }, []);
  useEffect(() => {
    const current = navigationFor(useApp.getState(), narrow);
    history.replaceState(current, "", navigationUrl(current, location.pathname));
  }, [narrow]);
}

function useNarrow() {
  const [narrow, setNarrow] = useState(() => matchMedia(MOBILE_LAYOUT_QUERY).matches);
  useEffect(() => {
    const mq = matchMedia(MOBILE_LAYOUT_QUERY);
    const on = () => setNarrow(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return narrow;
}

function Dialogs() {
  const dialog = useApp((s) => s.dialog);
  const toastMsg = useApp((s) => s.toast);
  const toastLink = useApp((s) => s.toastLink);
  useAutoUpdateNotice();
  const bots = useApp((s) => s.bots);
  return (
    <>
      {typeof dialog === "object" && dialog?.kind === "computer" && <ComputerOverlay slug={dialog.slug} />}
      {dialog === "new-bot" && <NewBotDialog />}
      {dialog === "adopt-project" && <AdoptProjectDialog />}
      {dialog === "settings" && <SettingsDialog />}
      {dialog === "search" && <SearchDialog />}
      {dialog === "connect-apps" && <ConnectApps />}
      {typeof dialog === "object" && dialog?.kind === "connect-apps" && <ConnectApps initialUrl={dialog.url} />}
      {typeof dialog === "object" && dialog?.kind === "rename-bot" && <RenameBotDialog slug={dialog.slug} />}
      {typeof dialog === "object" && dialog?.kind === "delete-bot" && (bots[dialog.slug]?.primary && Object.keys(bots).length > 1
        ? <MainBotDialog intent={{ kind: "delete", slug: dialog.slug }} />
        : <DeleteBotDialog slug={dialog.slug} />)}
      {typeof dialog === "object" && dialog?.kind === "main-bot" && <MainBotDialog intent={dialog.intent} initialSlug={dialog.initialSlug} />}
      <UsageStatsPrompt />
      {toastMsg && <div className="pop-in fixed bottom-6 left-1/2 z-[70] w-max max-w-[calc(100vw-32px)] -translate-x-1/2 rounded-2xl bg-pill px-4 py-2 text-[13px] text-pill-fg shadow-[var(--shadow-pop)]" role="status">{toastMsg}{toastLink && <> <a href={toastLink.href} target="_blank" rel="noopener noreferrer" onClick={toastLink.open && ((e) => { e.preventDefault(); toastLink.open!(); useApp.setState({ toast: null, toastLink: null }); })} className="font-medium underline underline-offset-2">{toastLink.label}</a></>}</div>}
    </>
  );
}

function MainBotDialog({ intent, initialSlug }: { intent: MainBotIntent; initialSlug?: string }) {
  const bots = useApp((s) => s.bots);
  const main = Object.values(bots).find((bot) => bot.primary);
  const candidates = Object.values(bots).filter((bot) => !bot.primary).sort((a, b) => a.name.localeCompare(b.name));
  const narrow = useNarrow();
  const [query, setQuery] = useState("");
  const matches = candidates.filter((bot) => `${bot.name} ${bot.label}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const [choice, setChoice] = useState<string | null>(initialSlug ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const close = () => { if (!busy) openDialog(null); };
  const replace = async () => {
    if (!choice || !bots[choice] || bots[choice].primary) return;
    setBusy(true);
    setError("");
    try {
      await setMainBot(choice);
      if (intent.kind === "hide") await updateBot(intent.slug, { hidden: true, pinned: false });
      openDialog(intent.kind === "delete" ? { kind: "delete-bot", slug: intent.slug } : null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't change the main Bot");
      setBusy(false);
    }
  };
  return <Modal title="Choose a primary Bot" onClose={close} className="w-[440px] max-w-full">
    <div className="min-h-0 overflow-y-auto p-4">
      <p className="mb-3 text-[13.5px] text-muted">{intent.kind === "replace" ? `Choose a Bot to replace ${main?.name ?? "your main Bot"}.` : `Choose another main Bot before ${intent.kind === "hide" ? "hiding" : "deleting"} ${bots[intent.slug]?.name ?? "this Bot"}.`} Your main Bot appears first with a star.</p>
      <input autoFocus={!narrow} type="search" aria-label="Search Bots" placeholder="Search Bots" disabled={busy} value={query} onChange={(event) => setQuery(event.target.value)} className="mb-3 h-10 w-full rounded-xl border border-line bg-transparent px-3 text-[16px] outline-none focus:border-line-strong" />
      {candidates.length ? <div role="radiogroup" aria-label="Main Bot" className="space-y-1">
        {matches.map((bot) => <label key={bot.slug} className={`flex w-full cursor-pointer items-center gap-3 rounded-xl border px-3 py-2 text-left focus-within:border-line-strong ${choice === bot.slug ? "border-line-strong bg-active" : "border-transparent hover:bg-hover"}`}>
          <Avatar shape={bot.shape} color={bot.color} picture={bot.avatarImage} size={36} />
          <span className="min-w-0 flex-1"><span className="block truncate text-[14px]">{bot.name}</span>{bot.hidden && <span className="text-[12px] text-muted">Hidden · will be shown in sidebar</span>}</span>
          <input type="radio" name="primary-bot" value={bot.slug} checked={choice === bot.slug} disabled={busy} onChange={() => setChoice(bot.slug)} className="size-4 shrink-0 accent-[var(--fg)]" />
        </label>)}
        {!matches.length && <p role="status" className="py-3 text-[13.5px] text-muted">No Bots match your search.</p>}
      </div> : <p className="text-[13.5px] text-muted">Create another Bot to choose a different main Bot.</p>}
      {error && <p role="alert" className="mt-3 text-[13px] text-danger">{error}</p>}
    </div>
    <div className="flex shrink-0 justify-end gap-2 border-t border-line p-3">
      <Pill variant="soft" disabled={busy} onClick={close}>Cancel</Pill>
      {!candidates.length && <Pill variant="soft" onClick={() => openDialog("new-bot")}>Create Bot</Pill>}
      <Pill disabled={busy || !choice || !bots[choice] || bots[choice].primary} onClick={replace}>{busy && <Spinner />} Confirm</Pill>
    </div>
  </Modal>;
}

function Welcome() {
  return (
    <div className="grid flex-1 place-items-center bg-chat">
      <div className="flex flex-col items-center text-center">
        <div className="flex -space-x-2">
          <Avatar shape="sphere" color="white" size={56} state="happy" />
          <Avatar shape="sparkle" color="teal" size={56} />
          <Avatar shape="clover" color="orange" size={56} />
        </div>
        <h1 className="mt-6 text-[26px] font-medium tracking-tight">Threebot</h1>
        <p className="mt-2 max-w-[360px] text-[14px] text-muted">Your personal agents.</p>
        <Pill className="mt-6 h-10 px-5 text-[14px]" onClick={() => openDialog("new-bot")}>
          Meet your first Bot
        </Pill>
      </div>
    </div>
  );
}

function Login() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  return (
    <div className="grid h-full place-items-center bg-app">
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api.login(password);
            location.reload();
          } catch {
            setError("Wrong password");
          }
        }}
        className="flex w-[300px] flex-col items-center"
      >
        <Avatar shape="sphere" color="white" size={64} state="happy" />
        <h1 className="mt-5 text-[22px] font-medium">Threebot</h1>
        <p className="mt-1 text-[13.5px] text-muted">Your personal agents.</p>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" className="mt-6 h-10 w-full rounded-full border border-line bg-transparent px-4 text-[14px] outline-none focus:border-line-strong" />
        {error && <div className="mt-2 text-[12.5px] text-danger">{error}</div>}
        <Pill type="submit" className="mt-3 h-10 w-full text-[14px]">
          Sign in →
        </Pill>
      </form>
    </div>
  );
}

function AccessLogin() {
  // The installed worker answers normal navigations from its cache, so only /login reaches Cloudflare.
  return <div className="grid h-full place-items-center bg-app"><div className="flex w-full max-w-[340px] flex-col items-center px-5 text-center">
    <Avatar shape="sphere" color="black" size={64} state="sleeping" />
    <h1 className="mt-5 text-[22px] font-medium">Threebot</h1>
    <p className="mt-2 text-[13.5px] text-muted">Your session ended. Sign in again with your account.</p>
    <a href={`login?next=${encodeURIComponent(location.pathname + location.search)}`} className="mt-5 flex h-10 w-full items-center justify-center rounded-full bg-pill px-4 text-[14px] font-medium text-pill-fg">Sign in with Cloudflare</a>
  </div></div>;
}
