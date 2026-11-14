import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { DEFAULT_PALETTE, PALETTES, paletteLabel } from "../lib/themes";
import clsx from "clsx";
import { Activity, Bot as BotIcon, Sun, Moon, ChevronRight, Download, FlaskConical, FolderGit2, Globe, Monitor, Network, Pencil, Plug, Settings as Gear, Shield, Trash2, Vault, Palette } from "lucide-react";
import { Avatar } from "./Avatar";
import { UsagePanel, useUsagePeak } from "./UsagePanel";
import { SkillsDialog } from "./SkillsDialog";
import { ModelPicker } from "./ModelPicker";
import { VaultPane } from "./Vault";
import { ConnectApps } from "./ConnectApps";
import { IconButton, Modal, Pill, Spinner, Switch } from "./ui";
import { Group, H, Row } from "./SettingsParts";
import { RemoteAccessPane, UpdatesPane, useUpdateNotice } from "./RemoteAccess";
import { UsageStatsPane } from "./UsageStats";
import { MachinesPane } from "./MachinesPane";
import { fastDrawingModel } from "../lib/avatarDrawing";
import { defaultModel, openDialog, saveFallbackModel, saveSettings, toast, useApp } from "../store";
import { api, signOutTarget } from "../lib/api";
import { t3http } from "../lib/t3";
import type { ModelSelection, Settings } from "../lib/types";
import { saveVoiceSettings } from "../lib/voiceChat";
import { cloudTranscription, PROVIDER_LABELS, saveCloudTranscription, type CloudProvider, type CloudTranscription, type CloudTranscriptionPatch } from "../lib/cloudSpeech";
import { useVoiceSettings, voiceLanguageOptions } from "./VoiceDock";

const PANES = [
  { id: "general", label: "General", icon: <Gear size={15} /> },
  { id: "bots", label: "Bots", icon: <BotIcon size={15} /> },
  { id: "appearance", label: "Appearance", icon: <Palette size={15} /> },
  { id: "computer", label: "Computer", icon: <Monitor size={15} /> },
  { id: "machines", label: "Machines", icon: <Network size={15} /> },
  { id: "permissions", label: "Permissions", icon: <Shield size={15} /> },
  { id: "vault", label: "Vault", icon: <Vault size={15} /> },
  { id: "access", label: "Remote access", icon: <Globe size={15} /> },
  { id: "updates", label: "Updates", icon: <Download size={15} /> },
  { id: "beta", label: "Beta", icon: <FlaskConical size={15} /> },
  { id: "usage-stats", label: "Usage stats", icon: <Activity size={15} /> },
];

type SaveSettings = (patch: Partial<Settings>) => Promise<boolean>;
const SettingsSave = createContext<SaveSettings>(async () => false);

export function SettingsDialog() {
  const pane = useApp((s) => s.settingsPane);
  const settings = useApp((s) => s.settings);
  const content = useRef<HTMLDivElement>(null);
  const overviewScroll = useRef(0);
  const previousPane = useRef(pane);
  const navigatePane = (settingsPane: string) => { if (pane === "overview") overviewScroll.current = content.current?.scrollTop ?? 0; useApp.setState({ settingsPane }); };
  useLayoutEffect(() => { if (pane === "overview" && previousPane.current !== "overview" && content.current) content.current.scrollTop = overviewScroll.current; previousPane.current = pane; }, [pane]);
  const [apps, setApps] = useState(false);
  const [skills, setSkills] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const save: SaveSettings = async (patch) => {
    setPending(true);
    setError("");
    try {
      await saveSettings(patch);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Couldn't save settings";
      setError(message);
      toast(message);
      return false;
    } finally { setPending(false); }
  };
  return (
    <SettingsSave.Provider value={save}>
      <Modal onClose={() => openDialog(null)} title={pane === "overview" ? <span className="sr-only">Settings</span> : pane === "vault" ? "Vault" : pane === "usage" ? "Usage" : pane === "appearance" ? "Appearance" : pane === "account" ? "Account" : pane === "timezone" ? "Time Zone" : PANES.find((p) => p.id === pane)?.label ?? "Settings"} onBack={pane !== "overview" ? () => navigatePane("overview") : undefined} className={`settings-modal h-[min(640px,88vh)] w-[min(880px,94vw)] ${pane === "appearance" ? "settings-appearance" : ""}`}>
        <div className="relative flex h-full min-h-0 flex-col sm:flex-row">
          <nav aria-label="Settings categories" className="settings-nav scroll-thin flex shrink-0 gap-1 overflow-x-auto border-b border-line p-2 pr-12 sm:block sm:w-[200px] sm:overflow-visible sm:border-r sm:border-b-0 sm:p-3">
            {PANES.map((p) => (
              <button key={p.id} onClick={() => navigatePane(p.id)} aria-current={pane === p.id ? "page" : undefined}
                className={clsx("flex h-9 shrink-0 items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] sm:w-full", pane === p.id ? "bg-active" : "hover:bg-hover")}>
                <span className="text-muted">{p.icon}</span>{p.label}
              </button>
            ))}
            <button onClick={() => setApps(true)} className="flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] hover:bg-hover sm:w-full"><Plug size={15} className="text-muted" />Connect apps</button>
          </nav>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {pending && <div role="status" className="shrink-0 px-4 py-2 text-[13px] text-muted">Saving…</div>}
            {error && <div role="alert" className="shrink-0 px-4 py-2 text-[13px] text-danger">Couldn't save: {error}</div>}
            <div ref={content} key={pane} className="settings-content scroll-thin min-h-0 min-w-0 flex-1 overflow-y-auto px-4 py-5 sm:px-8 sm:py-6">
              {!settings ? <div role="status" className="grid h-32 place-items-center"><Spinner /></div> : <fieldset disabled={pending} className="min-w-0">
                {pane === "overview" && <SettingsHome s={settings} onPane={navigatePane} onApps={() => setApps(true)} onSkills={() => setSkills(true)} />}
                {pane === "general" && <General s={settings} />}
                {pane === "account" && <General s={settings} accountOnly />}
                {pane === "timezone" && <TimeZoneSettings s={settings} />}
                {pane === "computer" && <Computer />}
                {pane === "bots" && <BotsPane />}
                {pane === "machines" && <MachinesPane save={save} />}
                {pane === "permissions" && <Permissions s={settings} />}
                {pane === "vault" && <VaultPane />}
                {pane === "access" && <RemoteAccessPane />}
                {pane === "updates" && <UpdatesPane t3={<T3Version />} />}
                {pane === "beta" && <Beta s={settings} />}
                {pane === "usage-stats" && <UsageStatsPane />}
                {pane === "usage" && <UsagePanel />}
                {pane === "appearance" && <Appearance s={settings} />}
              </fieldset>}
            </div>
          </div>
        </div>
      </Modal>
      {skills && <SkillsDialog onClose={() => setSkills(false)} />}
      {apps && <ConnectApps onClose={() => setApps(false)} onBack={() => setApps(false)} />}
    </SettingsSave.Provider>
  );
}

function SettingsHome({ s, onApps, onSkills, onPane: pane }: { s: Settings; onApps: () => void; onSkills: () => void; onPane: (pane: string) => void }) {
  const save = useContext(SettingsSave);
  const timezone = s.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const rules = s.rules.alwaysAsk.length + s.rules.allowWithoutAsking.length;
  const [signingOut, setSigningOut] = useState(false);
  const voiceSettings = useVoiceSettings();
  const usagePeak = useUsagePeak();
  const update = useUpdateNotice();
  const signOut = async () => {
    if (signingOut) return;
    setSigningOut(true);
    try { const target = await signOutTarget(); await api.logout(); location.href = target; }
    catch { setSigningOut(false); toast("Couldn't sign out. Try again."); }
  };
  return <div className="settings-home pt-16">
    <Group>
      <button onClick={() => pane("account")} className="settings-home-row flex w-full items-center gap-3 border-b border-line px-4 py-5 text-left"><span className="grid size-10 shrink-0 place-items-center rounded-full border border-line-strong bg-app text-[18px] font-semibold">{(s.userName || "You")[0].toUpperCase()}</span><span className="min-w-0 flex-1"><span className="block text-[17px]">{s.userName || "You"}</span><span className="block text-[13px] text-muted">Account</span></span><ChevronRight size={20} className="text-muted" /></button>
      <SettingsHomeLink title="Usage" detail={usagePeak === null ? undefined : `${usagePeak}%`} onClick={() => pane("usage")} />
      <SettingsHomeLink title="Vault" description="Logins and contact info your Bots can use" onClick={() => pane("vault")} />
    </Group>
    <Group><SettingsHomeLink title="Connect apps" description="Search plugins" onClick={onApps} /></Group>
    <Group title="Bot">
      <SettingsHomeLink title="Permissions" description={`${s.autoReview !== false ? "Auto-review on" : "Auto-review off"} · ${rules} rules`} onClick={() => pane("permissions")} />
      <Row title="Set Time Zone Automatically" desc="Use this device’s time zone in Bot settings."><Switch checked={!s.timezone} onChange={(auto) => save({ timezone: auto ? "" : timezone })} label="Set Time Zone Automatically" /></Row>
      <SettingsHomeLink title="Time Zone" detail={timezone} disabled={!s.timezone} onClick={() => pane("timezone")} />
      <SettingsHomeLink title="Bots" description="Make a Bot from one of your projects" onClick={() => pane("bots")} />
      <SettingsHomeLink title="Bot Computer" onClick={() => pane("computer")} />
      <SettingsHomeLink title="Machines" description="Your linked computers and where coding work runs" onClick={() => pane("machines")} />
    </Group>
    <Group title="Voice">
      <Row title="Voice language" desc="Used for dictation and voice calls.">
        <select aria-label="Voice language" value={voiceSettings.lang} onChange={(e) => saveVoiceSettings({ lang: e.target.value, voice: null })} className="h-8 rounded-lg border border-line bg-elevated px-2 text-[13px] outline-none">
          {voiceLanguageOptions().map(([code, label]) => <option key={code} value={code}>{label}</option>)}
        </select>
      </Row>
      <T3DictationRow />
    </Group>
    <Group><SettingsHomeLink title="Appearance" detail={`${s.theme === "system" ? "System" : s.theme === "dark" ? "Dark" : "Light"} · ${paletteLabel(s.palette)}`} onClick={() => pane("appearance")} /></Group>
    <Group><SettingsHomeLink title="Remote access" description="Open Threebot on your phone and other computers" onClick={() => pane("access")} /></Group>
    <Group><SettingsHomeLink title="Skills" onClick={onSkills} /><SettingsHomeLink title="Updates" detail={update ? `${update.version} available` : undefined} onClick={() => pane("updates")} /><SettingsHomeLink title="Beta" description="Try experimental features" onClick={() => pane("beta")} /><SettingsHomeLink title="Usage stats" description="Anonymous, off unless you turn them on" onClick={() => pane("usage-stats")} /></Group>
    <Group><SettingsHomeLink title={signingOut ? "Signing out…" : "Sign Out"} disabled={signingOut} onClick={() => void signOut()} /></Group>
  </div>;
}

function SettingsHomeLink({ title, description, detail, onClick, disabled = false }: { title: string; description?: string; detail?: string; disabled?: boolean; onClick: () => void }) {
  return <button disabled={disabled} onClick={onClick} className="settings-home-row flex w-full items-center gap-3 border-b border-line px-4 py-4 text-left last:border-0 hover:bg-hover"><span className="min-w-0 flex-1"><span className="block text-[17px]">{title}</span>{description && <span className="mt-1 block text-[13px] leading-5 text-muted">{description}</span>}</span>{detail && <span className="min-w-0 truncate text-[14px] text-muted">{detail}</span>}<ChevronRight size={18} className="shrink-0 text-muted" /></button>;
}

function Select<T extends string>({ label, value, onChange, options }: { label: string; value: T; onChange: (v: T) => void; options: readonly (readonly [T, string])[] }) {
  return (
    <select aria-label={label} value={value} onChange={(e) => {
      const option = options.find(([value]) => value === e.target.value);
      if (option) onChange(option[0]);
    }} className="h-8 rounded-lg border border-line bg-elevated px-2 text-[13px] outline-none">
      {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  );
}

function General({ s, accountOnly = false }: { s: Settings; accountOnly?: boolean }) {
  const save = useContext(SettingsSave);
  const [name, setName] = useState(s.userName);
  useEffect(() => setName(s.userName), [s.userName]);
  const voiceSettings = useVoiceSettings();
  const knownTimezones = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  const tzs = [...new Set([s.timezone, Intl.DateTimeFormat().resolvedOptions().timeZone, "UTC", ...knownTimezones])].filter(Boolean);
  const saveName = async () => {
    if (name.trim() !== s.userName && !(await save({ userName: name.trim() }))) setName(s.userName);
    else setName(name.trim());
  };
  return (
    <>
      <H>{accountOnly ? "Account" : "General"}</H>
      <Group title="Account">
        <Row title="Your name" desc="Your Bots use it when they talk to you.">
          <input aria-label="Your name" value={name} onChange={(e) => setName(e.target.value)} onBlur={saveName} onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") { e.stopPropagation(); setName(s.userName); } }} placeholder="Enter your name" className="h-8 w-48 rounded-lg border border-line bg-elevated px-2.5 text-[13px] outline-none" />
        </Row>
      </Group>
      {!accountOnly && <Group title="Bot">
        <Row title="Timezone" desc="Display preference. T3 routines use the server’s time zone.">
          <Select label="Timezone" value={s.timezone || ""} onChange={(v) => save({ timezone: v })} options={[["", "Computer default"], ...tzs.map((z): [string, string] => [z, z])]} />
        </Row>
        <Row title="Default model" desc="Used for new Bots. Each Bot can switch in its details.">
          <ModelPicker value={s.defaultModel ?? defaultModel()} onChange={(m) => save({ defaultModel: m })} />
        </Row>
        <BackupModelRow />
        <AvatarDrawingModelRow s={s} />
      </Group>}
      {!accountOnly && <Group title="Voice">
        <Row title="Voice language" desc="Used for dictation and voice calls.">
          <Select label="Voice language" value={voiceSettings.lang} onChange={(lang) => saveVoiceSettings({ lang, voice: null })} options={voiceLanguageOptions()} />
        </Row>
        <T3DictationRow />
      </Group>}
    </>
  );
}

/** Dictation through OpenAI or Gemini. The gateway keeps the key encrypted and never sends it back. */
function CloudDictationRows() {
  const [state, setState] = useState<CloudTranscription | null>(null);
  const [failed, setFailed] = useState(false);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  // What the menu shows: a provider can be picked before its key is saved and it can be turned on.
  const [picked, setPicked] = useState<CloudProvider | null | undefined>(undefined);
  useEffect(() => { cloudTranscription().then(setState, () => setFailed(true)); }, []);
  const apply = async (patch: CloudTranscriptionPatch) => {
    setBusy(true);
    try { setState(await saveCloudTranscription(patch)); return true; }
    catch (error) { toast(error instanceof Error ? error.message : "Couldn't save"); return false; }
    finally { setBusy(false); }
  };
  if (failed) return <Row title="Cloud transcription" desc="Couldn't load this setting from the gateway." />;
  if (!state) return null;
  const provider = picked === undefined ? state.provider : picked;
  return <>
    <Row title={<span className="inline-flex items-center gap-2">Transcribe with OpenAI or Gemini<span className="rounded-full border border-line px-1.5 text-[11px] leading-[18px] text-muted">Beta</span></span>} desc="Dictation records here and the gateway sends the audio to the provider you pick. Better with mixed languages (it expects your voice language and English). Off keeps the browser or T3 Code.">
      <Select<"" | CloudProvider> label="Cloud transcription" value={provider ?? ""} onChange={(value) => {
        const next = value || null;
        setPicked(next);
        if (next === null || state.hasKey[next]) void apply({ provider: next });
      }} options={[["", "Off"], ["openai", "OpenAI"], ["gemini", "Gemini"]]} />
    </Row>
    {provider && <Row title={`${PROVIDER_LABELS[provider]} API key`} desc={state.hasKey[provider] ? "Saved and encrypted on the gateway. Paste a new one to replace it." : `Paste a key from ${provider === "openai" ? "platform.openai.com" : "aistudio.google.com"} to turn this on.`}>
      <form className="flex items-center gap-2" onSubmit={(event) => { event.preventDefault(); if (!key.trim()) return; void apply({ apiKey: { provider, value: key }, provider }).then((ok) => { if (ok) setKey(""); }); }}>
        <input type="password" autoComplete="off" aria-label={`${PROVIDER_LABELS[provider]} API key`} value={key} onChange={(event) => setKey(event.target.value)} placeholder={state.hasKey[provider] ? "••••••••" : "API key"} className="h-8 w-44 rounded-lg border border-line bg-elevated px-2.5 text-[13px] outline-none" />
        <button type="submit" disabled={busy || !key.trim()} className="text-[12.5px] text-muted hover:text-fg disabled:opacity-50">Save</button>
        {state.hasKey[provider] && state.provider !== provider && <button type="button" disabled={busy} className="text-[12.5px] text-muted hover:text-fg" onClick={() => void apply({ apiKey: { provider, value: "" } })}>Remove</button>}
      </form>
    </Row>}
    {provider && state.provider === provider && <Row title="Transcription model" desc={provider === "openai" ? "gpt-4o-transcribe and gpt-4o-mini-transcribe stop working on 26 February 2027." : "Gemini's model for recorded speech."}>
      <Select label="Transcription model" value={state.models[provider]} onChange={(model) => void apply({ model })} options={state.options[provider].map((model) => [model, model] as const)} />
    </Row>}
  </>;
}

/** Only T3 Code servers that advertise transcription (0.1.8 nightly and later) offer this. */
function T3DictationRow() {
  const available = useApp((state) => state.runtimeFeatures.voiceTranscription);
  const voiceSettings = useVoiceSettings();
  if (!available) return null;
  return <Row title="Transcribe on T3 Code" desc="Dictation records here and your T3 Code server transcribes it, then discards the audio. Used automatically when this browser has no voice input.">
    <Switch checked={voiceSettings.t3} onChange={(t3) => saveVoiceSettings({ t3 })} label="Transcribe on T3 Code" />
  </Row>;
}

function BackupModelRow() {
  const fallback = useApp((state) => state.fallbackModel);
  const change = (selection: ModelSelection | null) => saveFallbackModel(selection).catch((error) => toast(error instanceof Error ? error.message : "Couldn't save the backup model"));
  return <Row title="Backup model" desc="T3 uses it for new threads when the default model is out of usage. Routines keep their own model.">
    <div className="backup-model-actions flex items-center gap-2">
      <ModelPicker value={fallback} onChange={(selection) => void change(selection)} />
      {fallback && <button type="button" className="text-[12.5px] text-muted hover:text-fg" onClick={() => void change(null)}>Turn off</button>}
    </div>
  </Row>;
}

/** Draws new avatar objects. Automatic is a fast model from what T3 offers; see lib/avatarDrawing. */
function AvatarDrawingModelRow({ s }: { s: Settings }) {
  const save = useContext(SettingsSave);
  const providers = useApp((state) => state.providers);
  const chosen = s.avatarDrawingModel ?? null;
  const automatic = fastDrawingModel(providers);
  return <Row title="Avatar drawing model" desc={chosen ? "Draws new avatar objects." : automatic ? "Draws new avatar objects. Automatic picks a fast model: GPT-6 Luna (Fast), else Claude Haiku." : "Draws new avatar objects. No fast model is available, so each Bot draws with its own model."}>
    <div className="flex items-center gap-2">
      <ModelPicker value={chosen ?? automatic} onChange={(selection) => save({ avatarDrawingModel: selection })} />
      {chosen && <button type="button" className="text-[12.5px] text-muted hover:text-fg" onClick={() => save({ avatarDrawingModel: null })}>Automatic</button>}
    </div>
  </Row>;
}

function TimeZoneSettings({ s }: { s: Settings }) {
  const save = useContext(SettingsSave);
  const zones = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : ["UTC"];
  const options = [...new Set([s.timezone, "UTC", ...zones])].filter(Boolean).map((zone): [string, string] => [zone, zone]);
  return <Group><Row title="Time Zone" desc="Display preference. T3 routines use the server’s time zone."><Select label="Time Zone" value={s.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone} onChange={(timezone) => save({ timezone })} options={options} /></Row></Group>;
}

function Appearance({ s }: { s: Settings }) {
  const save = useContext(SettingsSave);
  const themes = [["system", "Follow System", <svg width="28" height="28" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2" /><path d="M12 3a9 9 0 0 1 0 18Z" fill="currentColor" /></svg>], ["light", "Light", <Sun size={28} />], ["dark", "Dark", <Moon size={28} fill="currentColor" />]] satisfies [Settings["theme"], string, React.ReactNode][];
  const accents = [["black", "Black"], ["bot", "Bot color"]] satisfies [Settings["accent"], string][];
  const palette = s.palette ?? DEFAULT_PALETTE;
  return <div className="appearance-panel"><div className="appearance-themes" role="radiogroup" aria-label="Theme">{themes.map(([theme, label, icon]) => <button key={theme} role="radio" aria-checked={s.theme === theme} onClick={() => save({ theme })}><span className="appearance-tile">{icon}</span><span>{label}</span></button>)}</div>
    <div className="appearance-palettes" role="radiogroup" aria-label="Colors">{PALETTES.map((item) => { const dark = document.documentElement.classList.contains("dark"); const [bg, accent] = (dark ? item.dark : item.light) ?? item.dark; return <button key={item.id} role="radio" aria-checked={palette === item.id} onClick={() => save({ palette: item.id })}><span className="appearance-tile appearance-swatch" style={{ background: bg }}><span style={{ background: accent }} />{!item.light && <small>Dark only</small>}</span><span>{item.label}</span></button>; })}</div>
    <div className="appearance-accents" role="radiogroup" aria-label="Accent">{accents.map(([accent, label]) => <button key={accent} role="radio" aria-checked={s.accent === accent} onClick={() => save({ accent })}><span className="appearance-tile"><span className={accent === "bot" ? "appearance-spectrum" : "appearance-black"} /></span><span>{label}</span></button>)}</div></div>;
}

function RuleList({ title, desc, rules, onChange }: { title: string; desc: string; rules: string[]; onChange: (r: string[]) => Promise<boolean> }) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const commit = async () => {
    const v = draft.trim();
    if (!v || !(await onChange(editing === null ? [...rules, v] : rules.map((r, i) => (i === editing ? v : r))))) return;
    setAdding(false);
    setEditing(null);
    setDraft("");
  };
  return (
    <div className="mb-6">
      <div className="mb-2 flex items-end gap-3">
        <div className="flex-1">
          <div className="text-[13.5px]">{title}</div>
          <div className="text-[12.5px] text-muted">{desc}</div>
        </div>
        <Pill variant="soft" onClick={() => { setAdding(true); setEditing(null); setDraft(""); }} disabled={rules.length >= 20}>
          Add Rule
        </Pill>
      </div>
      <div className="settings-rules-card overflow-hidden rounded-2xl bg-card">
        {rules.length === 0 && <p className="px-4 py-4 text-muted">No rules yet</p>}
        {rules.map((r, i) => <div key={i} className="group flex items-center gap-2 border-b border-line px-4 py-4 text-[15px] last:border-0"><span className="settings-rule-text min-w-0 flex-1">{r}</span><IconButton className="settings-rule-actions" onClick={() => { setEditing(i); setDraft(r); setAdding(false); }} aria-label="Edit rule"><Pencil size={14} /></IconButton><IconButton className="settings-rule-actions" onClick={() => onChange(rules.filter((_, j) => j !== i))} aria-label="Delete rule"><Trash2 size={14} /></IconButton></div>)}
      </div>
      {(adding || editing !== null) && <Modal title={editing === null ? "New Rule" : "Edit Rule"} onBack={() => { setAdding(false); setEditing(null); }} onClose={() => { setAdding(false); setEditing(null); }} className="rule-editor-sheet w-[460px]">
        <RuleEditor placeholder={title === "Always Ask" ? "Purchases over $50" : "Emails to my team at acme.com"} draft={draft} setDraft={setDraft} commit={commit} cancel={() => { setAdding(false); setEditing(null); }} />
      </Modal>}
    </div>
  );
}

function RuleEditor({ draft, setDraft, commit, cancel, placeholder }: { placeholder: string; draft: string; setDraft: (v: string) => void; commit: () => void; cancel: () => void }) {
  return (
    <>
      <div className="rule-editor-body"><label htmlFor="permission-rule">Applies to</label><textarea id="permission-rule" autoFocus value={draft} maxLength={1000} onChange={(e) => setDraft(e.target.value)} placeholder={placeholder} rows={3} /><p>Name the action and who or what it affects, like "Emails to dana@acme.com".</p></div>
      <div className="rule-editor-footer"><Pill onClick={commit} disabled={!draft.trim()}>Add rule</Pill><Pill variant="ghost" onClick={cancel}>Cancel</Pill></div>
    </>
  );
}

function Permissions({ s }: { s: Settings }) {
  const save = useContext(SettingsSave);
  const rules = s.rules ?? { alwaysAsk: [], allowWithoutAsking: [] };
  return (
    <>
      <Group>
        <Row title="Auto-Review" desc="Use provider approval checks before actions run.">
          <Switch checked={s.autoReview !== false} onChange={(v) => save({ autoReview: v })} label="Auto-Review" />
        </Row>
      </Group>
      <RuleList title="Always Ask" desc="Stop and ask when an action matches these rules" rules={rules.alwaysAsk} onChange={(r) => save({ rules: { ...rules, alwaysAsk: r } })} />
      <RuleList title="Allow without Asking" desc="Continue automatically when an action matches these rules" rules={rules.allowWithoutAsking} onChange={(r) => save({ rules: { ...rules, allowWithoutAsking: r } })} />
      <p className="permissions-boundary">Rules are instructions for your Bots. Provider approval policies determine which actions require confirmation.</p>
    </>
  );
}

/** Experimental features, each with its own switch. Saved on the server: they change what Bots get. */
const BETA_FEATURES = [
  { key: "projects", title: "Projects board", desc: "A live board of your projects, to-dos, machines and what runs where, kept up to date by you and your Bots." },
] as const;

function Beta({ s }: { s: Settings }) {
  const save = useContext(SettingsSave);
  const beta = s.beta ?? { projects: false };
  return (
    <>
      <p className="mb-4 text-[13px] text-muted">Features that are still taking shape. Switching one off hides it from you and your Bots; nothing is deleted.</p>
      <Group>
        {BETA_FEATURES.map((f) => (
          <Row key={f.key} title={<span className="inline-flex items-center gap-2">{f.title}<span className="rounded-full border border-line px-1.5 text-[11px] leading-[18px] text-muted">Beta</span></span>} desc={f.desc}>
            <Switch checked={beta[f.key] === true} onChange={(v) => save({ beta: { ...beta, [f.key]: v } })} label={f.title} />
          </Row>
        ))}
      </Group>
      <Group title="Cloud transcription">
        <CloudDictationRows />
      </Group>
    </>
  );
}

type Environment = { label: string; serverVersion: string; protocol: string };
type EnvironmentState = { kind: "loading" } | { kind: "ready"; value: Environment } | { kind: "error" };

function useEnvironment() {
  const [state, setState] = useState<EnvironmentState>({ kind: "loading" });
  const [attempt, retry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: "loading" });
    t3http<unknown>("/.well-known/t3/environment", { signal: controller.signal }).then((value) => {
      if (!value || typeof value !== "object") throw new Error("Missing computer information");
      const label = "label" in value && typeof value.label === "string" ? value.label : "Server";
      const serverVersion = "serverVersion" in value && typeof value.serverVersion === "string" ? value.serverVersion : "Not reported";
      const protocol = "orchestrationProtocolVersion" in value && (typeof value.orchestrationProtocolVersion === "string" || typeof value.orchestrationProtocolVersion === "number") ? String(value.orchestrationProtocolVersion) : "Not reported";
      if (!controller.signal.aborted) setState({ kind: "ready", value: { label, serverVersion, protocol } });
    }).catch(() => { if (!controller.signal.aborted) setState({ kind: "error" }); });
    return () => controller.abort();
  }, [attempt]);
  return { state, retry: () => retry((n) => n + 1) };
}

function EnvironmentError({ retry }: { retry: () => void }) {
  return <div role="alert" className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-line p-3 text-[13px] text-muted"><span className="flex-1">Couldn't load computer information.</span><Pill variant="soft" onClick={retry}>Retry</Pill></div>;
}

function Computer() {
  const { state, retry } = useEnvironment();
  const botsRoot = useApp((s) => s.botsRoot);
  const connection = useApp((s) => s.connection);
  return (
    <>
      <H>Computer</H>
      {state.kind === "error" && <EnvironmentError retry={retry} />}
      <Group title="Bot's computer">
        <Row title={state.kind === "ready" ? state.value.label : "Server"} desc="All your Bots share this computer: its files, browser and sign-ins.">
          <span className={clsx("shrink-0 rounded-full px-2.5 py-1 text-[12px]", connection === "open" ? "bg-success/15 text-success" : "bg-attention/15 text-attention")}>{connection === "open" ? "Connected" : connection === "connecting" ? "Connecting" : "Disconnected"}</span>
        </Row>
        <Row title="Bots folder" desc={botsRoot || "Not reported"} />
        <Row title="Agent runtime" desc={state.kind === "loading" ? "Loading…" : state.kind === "ready" ? `T3 Code ${state.value.serverVersion}` : "Unavailable"} />
      </Group>
    </>
  );
}

/** Settings → Bots: every Bot and its folder; projects can become Bots here, and Bots made from projects can turn back. */
function BotsPane() {
  const bots = useApp((s) => s.bots);
  const list = Object.values(bots).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return (
    <>
      <H>Bots</H>
      <Group>
        <button onClick={() => openDialog("adopt-project")} className="settings-adopt flex w-full items-center gap-3 px-4 py-3.5 text-left hover:bg-hover">
          <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-active"><FolderGit2 size={17} /></span>
          <span className="min-w-0 flex-1"><span className="block text-[13.5px]">Make a Bot from a project</span><span className="mt-0.5 block text-[12.5px] text-muted">Pick one of this computer's T3 projects. The Bot works in its folder, and git never sees its files.</span></span>
          <ChevronRight size={18} className="shrink-0 text-muted" />
        </button>
      </Group>
      <Group title="Your Bots">
        {list.length === 0 ? <Row title="No Bots yet" /> : list.map((bot) => (
          <div key={bot.slug} className="settings-bot-row flex items-center gap-3 border-b border-line px-4 py-3 last:border-0">
            <span className="grid size-8 shrink-0 place-items-center overflow-hidden"><Avatar shape={bot.shape} color={bot.color} picture={bot.avatarImage} size={32} /></span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-[13.5px]"><span className="truncate">{bot.name}</span>{bot.adopted && <span className="shrink-0 rounded-full bg-active px-2 py-0.5 text-[11.5px] text-muted">From a project</span>}</div>
              <div className="mt-0.5 truncate font-mono text-[12px] text-muted" title={bot.workspaceRoot}>{bot.workspaceRoot}</div>
            </div>
            {bot.adopted && <Pill variant="soft" onClick={() => openDialog({ kind: "delete-bot", slug: bot.slug })}>Turn back into a plain project</Pill>}
          </div>
        ))}
      </Group>
    </>
  );
}

function T3Version() {
  const { state, retry } = useEnvironment();
  return <>
    {state.kind === "error" && <EnvironmentError retry={retry} />}
    <Row title="T3 Code" desc={state.kind === "loading" ? "Loading…" : state.kind === "ready" ? `Server ${state.value.serverVersion} · protocol ${state.value.protocol}` : "Unavailable"}>
      <BotIcon size={15} className="shrink-0 text-muted" />
    </Row>
  </>;
}
