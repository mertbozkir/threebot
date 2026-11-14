import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Copy, ExternalLink, RefreshCw, X } from "lucide-react";
import { api, type AccessState, type ReleaseInfo, type SystemInfo, type UpdateNotice } from "../lib/api";
import { timeAgo } from "../lib/projects";
import { openDialog, toast, useApp } from "../store";
import { ReleaseNotesView } from "./ReleaseNotes";
import { Group, H, Row } from "./SettingsParts";
import { IconButton, Pill, Spinner, Switch } from "./ui";

const ACCESS_GUIDE = "https://github.com/RokaSwK/threebot/blob/main/docs/cloudflare-access.md";
const message = (error: unknown) => (error instanceof Error ? error.message : "Something went wrong");

async function copy(text: string) {
  try { await navigator.clipboard.writeText(text); toast("Link copied"); } catch { toast(text); }
}

function Link({ href, children }: { href: string; children: React.ReactNode }) {
  return <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex shrink-0 items-center gap-1 rounded-full bg-hover px-3 py-1.5 text-[13px] hover:bg-active">{children}<ExternalLink size={13} aria-hidden="true" /></a>;
}

function Address({ url }: { url: string }) {
  return <span className="mt-1 flex min-w-0 items-center gap-1.5">
    <a href={url} target="_blank" rel="noopener noreferrer" className="min-w-0 truncate text-accent underline-offset-2 hover:underline">{url}</a>
    <IconButton type="button" onClick={() => void copy(url)} aria-label="Copy link" title="Copy link" className="size-7 shrink-0"><Copy size={14} /></IconButton>
  </span>;
}

/** Settings → Remote access: the one-click Tailscale and Cloudflare setups. */
export function RemoteAccessPane() {
  const [state, setState] = useState<AccessState | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [password, setPassword] = useState("");

  const load = async () => {
    try { setState(await api.access()); setError(""); } catch (e) { setError(message(e)); }
  };
  useEffect(() => { void load(); }, []);

  const act = async (name: string, run: () => Promise<AccessState>) => {
    setBusy(name);
    try { setState(await run()); setError(""); }
    catch (e) { setError(message(e)); void load(); }
    finally { setBusy(null); }
  };

  if (!state) return <><H>Remote access</H>{error ? <p role="alert" className="text-[13px] text-danger">{error}</p> : <div role="status" className="grid h-24 place-items-center"><Spinner /></div>}</>;
  const ts = state.tailscale, tunnel = state.tunnel;

  let tsDesc: React.ReactNode, tsAction: React.ReactNode = null;
  if (ts.fromEnv) tsDesc = "Set up in .env (TAILNET_PORT).";
  else if (!ts.installed) { tsDesc = "Tailscale isn't installed on this machine."; tsAction = <Link href="https://tailscale.com/download">Get Tailscale</Link>; }
  else if (ts.needsLogin) { tsDesc = "Tailscale is signed out on this machine."; tsAction = ts.authUrl ? <Link href={ts.authUrl}>Sign in</Link> : <span className="text-[12.5px] text-muted">Open Tailscale and sign in</span>; }
  else if (!ts.running) tsDesc = "Tailscale isn't running on this machine. Start it, then check again.";
  else if (!ts.https) { tsDesc = "HTTPS certificates are off for your tailnet. Threebot needs them to work as an app on your phone."; tsAction = <Link href="https://login.tailscale.com/admin/dns">Turn on HTTPS</Link>; }
  else if (ts.enabled && ts.url) {
    tsDesc = <>{ts.serving === false ? "Tailscale isn't serving this link right now. Turn it off and on again." : `Only ${ts.users.join(", ")} can open it, from devices on your tailnet.`}<Address url={ts.url} /></>;
    tsAction = <Pill variant="soft" disabled={busy !== null} onClick={() => void act("tailscale", () => api.tailscale(false))}>{busy === "tailscale" ? "Turning off…" : "Turn off"}</Pill>;
  } else {
    tsDesc = `A private https link that only ${ts.login ?? "you"} can open, from devices on your tailnet.`;
    tsAction = <Pill disabled={busy !== null} onClick={() => void act("tailscale", () => api.tailscale(true))}>{busy === "tailscale" ? "Setting up…" : "Turn on"}</Pill>;
  }

  return <>
    <H>Remote access</H>
    <p className="mb-5 text-[13px] leading-5 text-muted">Open Threebot on your phone and other computers. Tailscale keeps it private to your own devices. A Cloudflare link works from anywhere and asks for a password.</p>
    {error && <p role="alert" className="mb-4 text-[13px] text-danger">{error}</p>}
    <Group title="Private · Tailscale">
      <Row title="Tailscale" desc={tsDesc}>
        {tsAction}
        {!ts.enabled && !ts.fromEnv && <IconButton type="button" onClick={() => void act("check", api.access)} aria-label="Check again" title="Check again" className="size-8"><RefreshCw size={14} /></IconButton>}
      </Row>
    </Group>
    <Group title="Your own domain · Google sign-in">
      <Row title="Cloudflare Access" desc={state.cloudflareAccess ? `On. ${state.cloudflareAccess.emails.join(", ")} can sign in with Google on your domain.` : "Put Threebot on your own domain and sign in with Google instead of a password. Takes about 15 minutes in Cloudflare and Google."}>
        {!state.cloudflareAccess && <Link href={ACCESS_GUIDE}>Guide</Link>}
      </Row>
    </Group>
    <Group title="Public link · Cloudflare">
      <Row title="Password" desc={state.password.fromEnv ? "Set by BOT_PASSWORD in .env." : state.password.set ? "Set. Changing it signs out every other device." : "Anyone with a public link sees the sign-in page first, so set a password before turning one on."}>
        {!state.password.fromEnv && <form className="flex shrink-0 items-center gap-2" onSubmit={(e) => { e.preventDefault(); const value = password; setPassword(""); void act("password", () => api.setPassword(value)); }}>
          <input type="password" autoComplete="new-password" aria-label={state.password.set ? "New password" : "Password"} placeholder={state.password.set ? "New password" : "Password"} minLength={8} required value={password} onChange={(e) => setPassword(e.target.value)} className="h-8 w-40 rounded-lg border border-line bg-elevated px-2.5 text-[13px] outline-none" />
          <Pill type="submit" variant="soft" disabled={busy !== null || password.length < 8}>{busy === "password" ? "Saving…" : "Save"}</Pill>
        </form>}
      </Row>
      <Row title="Cloudflare link" desc={(tunnel.url ? undefined : tunnel.error ?? "A trycloudflare.com link with no account needed. It changes each time Threebot restarts.")}>
        {tunnel.enabled
          ? <Pill variant="soft" disabled={busy !== null} onClick={() => void act("tunnel", () => api.tunnel(false))}>{busy === "tunnel" ? "Turning off…" : "Turn off"}</Pill>
          : <Pill disabled={busy !== null || !state.password.set} title={state.password.set ? undefined : "Set a password first"} onClick={() => void act("tunnel", () => api.tunnel(true))}>{busy === "tunnel" ? (tunnel.available ? "Starting…" : "Downloading cloudflared…") : "Turn on"}</Pill>}
      </Row>
      {tunnel.url && <div className="border-t border-line px-4 py-3 text-[12.5px] text-muted">Anyone with this link sees the sign-in page.<Address url={tunnel.url} /></div>}
    </Group>
  </>;
}

/** Cheap: the gateway answers from the result of its own 15-minute check, without asking GitHub. */
const UPDATE_POLL_MS = 2 * 60 * 1000;

/**
 * The newer release Settings → Updates would offer, or null. `installable` says this copy can update
 * itself from Settings (an installed runtime run as a service), which the sidebar's update button needs.
 */
export function useUpdateNotice() {
  const [notice, setNotice] = useState<{ version: string; installable: boolean; release: ReleaseInfo } | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => api.system().then((s) => {
      if (live) setNotice(s.updateAvailable && s.latest ? { version: s.latest.version, installable: s.installed && s.service, release: s.latest } : null);
    }).catch(() => { /* Offline or rate-limited: keep what we had and try again later. */ });
    load();
    const timer = setInterval(load, UPDATE_POLL_MS);
    return () => { live = false; clearInterval(timer); };
  }, []);
  return notice;
}

/** The one line the app shows after an automatic update, with a link to the release's notes. */
export function updateNoticeText(notice: UpdateNotice): { text: string; link: string } {
  const v = `v${notice.version}`;
  if (notice.kind === "updated") return { text: `Updated to ${v}.`, link: "What's new" };
  if (notice.kind === "rolledBack") return { text: `${v} didn't start, so Threebot went back to v${notice.from}.`, link: `About ${v}` };
  if (notice.kind === "failed") return { text: `Couldn't update to ${v} automatically. Update from Settings → Updates when you like.`, link: `About ${v}` };
  return { text: `${v} is ready, but your Bots have been busy for a day. Update from Settings → Updates when they're free.`, link: "What's new" };
}

/** Settings → Updates, where the notes of the running version and of a newer one show. */
export function openUpdates() {
  useApp.setState({ settingsPane: "updates" });
  openDialog("settings");
}

/** Shows what the last automatic update did, once: the gateway forgets it as soon as it's been shown. */
export function useAutoUpdateNotice() {
  useEffect(() => {
    let live = true;
    const load = () => api.system().then((s) => {
      if (!live || !s.notice) return;
      const { text, link } = updateNoticeText(s.notice);
      // "What's new" opens the notes in the app; a rollback or failure links to the release on GitHub.
      const inApp = s.notice.kind === "updated" || s.notice.kind === "waited";
      toast(text, { href: s.notice.url, label: link, ...(inApp ? { open: openUpdates } : {}) });
      void api.dismissUpdateNotice(s.notice.at).catch(() => {});
    }).catch(() => { /* Offline or signed out: look again later. */ });
    load();
    const timer = setInterval(load, UPDATE_POLL_MS);
    return () => { live = false; clearInterval(timer); };
  }, []);
}

/**
 * Start `threebot update` on the server and reload once the gateway answers with the new version.
 * Resolves with an error message when it didn't finish, or nothing when there was nothing to install.
 */
async function runUpdate(onStarted: (version: string) => void): Promise<string | null> {
  const { started, version } = await api.startUpdate();
  if (!started) return null;
  onStarted(version);
  const end = Date.now() + 4 * 60 * 1000;
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, 2000));
    try { if ((await api.health()).version === version) { location.reload(); return null; } } catch { /* restarting */ }
  }
  return "The update didn't finish. Threebot keeps running the version it had; its log is in ~/.threebot/logs/update.log.";
}

/**
 * The update button's popover, like T3 Code's: what's new in the offered release and an Update button.
 * Anchored above the button on a wide screen; a sheet along the bottom on a phone.
 */
export function UpdatePopover({ anchor, release, onClose }: { anchor: HTMLElement; release: ReleaseInfo; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<React.CSSProperties>({ visibility: "hidden" });
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState("");
  useLayoutEffect(() => {
    const r = anchor.getBoundingClientRect();
    const sheet = window.innerWidth < 640;
    setPlace(sheet ? { left: 8, right: 8, bottom: 8, maxHeight: "min(80vh, calc(100vh - 16px))" }
      : { left: Math.max(8, Math.min(r.left, window.innerWidth - 368)), bottom: Math.max(8, window.innerHeight - r.top + 8), width: 360, maxHeight: Math.max(240, r.top - 16) });
  }, [anchor]);
  useEffect(() => {
    ref.current?.focus();
    const away = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node) && !anchor.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); anchor.focus(); } };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", key, true);
    return () => { document.removeEventListener("pointerdown", away); document.removeEventListener("keydown", key, true); };
  }, [anchor, onClose]);
  const update = async () => {
    setError("");
    try { const failed = await runUpdate(() => setUpdating(true)); if (failed) { setUpdating(false); setError(failed); } }
    catch (e) { setUpdating(false); setError(message(e)); }
  };
  return createPortal(<div ref={ref} role="dialog" aria-label={`Update to v${release.version}`} tabIndex={-1}
    className="update-popover pop-in fixed z-[60] flex flex-col overflow-hidden rounded-2xl border border-line bg-elevated text-fg shadow-[var(--shadow-pop)] outline-none" style={place}>
    <div className="flex items-center gap-2 border-b border-line px-4 py-3">
      <span className="min-w-0 flex-1 text-[14px] font-medium">Update available</span>
      <IconButton onClick={onClose} aria-label="Close" className="-me-1.5 size-7"><X size={15} /></IconButton>
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3">
      <ReleaseNotesView release={release} />
    </div>
    <div className="flex items-center gap-2 border-t border-line px-4 py-3">
      {error ? <p role="alert" className="min-w-0 flex-1 text-[12.5px] text-danger">{error}</p>
        : <p className="min-w-0 flex-1 text-[12.5px] text-muted">{updating ? "Updating. Threebot restarts and this page reloads." : "Threebot restarts to update. Your Bots keep their work."}</p>}
      {updating ? <Spinner /> : <Pill onClick={() => void update()}>Update</Pill>}
    </div>
  </div>, document.body);
}

/** Settings → Updates: the same flow as T3 Code's, through `threebot update` on the server. */
export function UpdatesPane({ t3 }: { t3: React.ReactNode }) {
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);
  const [updating, setUpdating] = useState<string | null>(null);

  const check = async (force: boolean) => {
    setChecking(true);
    try { setInfo(await api.system(force)); setError(""); } catch (e) { setError(message(e)); }
    finally { setChecking(false); }
  };
  useEffect(() => { void check(false); }, []);

  const update = async () => {
    setError("");
    try {
      let started = false;
      // The gateway restarts on the new version; runUpdate reloads once it answers with it.
      const failed = await runUpdate((version) => { started = true; setUpdating(version); });
      if (!started) return void check(true);
      if (failed) { setUpdating(null); setError(failed); }
    } catch (e) { setUpdating(null); setError(message(e)); }
  };

  const latest = info?.latest;
  let desc = "Checking…";
  if (info) {
    if (updating) desc = `Updating to ${updating}. Threebot restarts and this page reloads.`;
    else if (info.updateAvailable && latest) desc = `Version ${info.version}. Version ${latest.version} is available.`;
    else if (info.error) desc = `Version ${info.version}. Couldn't check for updates: ${info.error}`;
    else desc = `Version ${info.version}. Up to date.`;
  }
  const canUpdate = info?.installed && info.service;
  const setAuto = async (auto: boolean) => {
    setInfo((i) => i && { ...i, auto });
    try { const saved = await api.setAutoUpdate(auto); setInfo((i) => i && { ...i, ...saved }); }
    catch (e) { setInfo((i) => i && { ...i, auto: !auto }); setError(message(e)); }
  };
  const autoDesc = !canUpdate ? "Needs Threebot installed with the installer and running as a service."
    : info?.waiting ? `${info.waiting.version} is waiting for your Bots to finish what they're doing.`
    : "Installs new releases when no Bot is working or waiting on you, and restarts Threebot.";

  return <>
    <H>Updates</H>
    {error && <p role="alert" className="mb-4 text-[13px] text-danger">{error}</p>}
    <Group>
      <Row title="Threebot" desc={desc}>
        {updating ? <Spinner /> : <span className="flex shrink-0 items-center gap-3">
          {info?.checkedAt && <span className="text-[12.5px] text-muted">Last checked {timeAgo(info.checkedAt)}</span>}
          {info?.updateAvailable && canUpdate
            ? <Pill onClick={() => void update()}>Update</Pill>
            : <Pill variant="soft" disabled={checking} onClick={() => void check(true)}>{checking ? "Checking…" : "Check now"}</Pill>}
        </span>}
      </Row>
      {info && <Row title="Update automatically" desc={autoDesc}>
        <Switch checked={info.auto} onChange={(v) => void setAuto(v)} label="Update automatically" />
      </Row>}
      {t3}
    </Group>
    {info?.updateAvailable && latest && !canUpdate && <p className="mb-3 text-[12.5px] leading-5 text-muted">{info.installed ? <>Run <code>threebot update</code> on the server to install it.</> : <>This copy runs from a git checkout. Update it with <code>git pull &amp;&amp; npm run setup</code>, then restart it.</>}</p>}
    {info?.updateAvailable && latest && <Group title="What's new"><ReleaseNotesView release={latest} className="px-4 py-3.5" /></Group>}
    {info?.current
      ? <Group title={info.updateAvailable ? "Your version" : "What's new in your version"}><ReleaseNotesView release={info.current} className="px-4 py-3.5" /></Group>
      : latest && !info?.updateAvailable && <p className="text-[12.5px] text-muted"><a href={latest.url} target="_blank" rel="noopener noreferrer" className="underline-offset-2 hover:underline">What's new in {latest.version}</a></p>}
  </>;
}
