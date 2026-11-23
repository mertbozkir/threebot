import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import clsx from "clsx";
import { ChevronDown, Copy, Download, ExternalLink, Eye, EyeOff, FileUp, KeyRound, Search, UserRound, X } from "lucide-react";
import { IconButton, Modal, Pill, Spinner, Switch } from "./ui";
import { toast, useApp } from "../store";
import { addressLines, contactSummary, exportUrl, siteDomain, siteUrl, vaultApi, type ContactInput, type LoginInput, type VaultContact, type VaultItem, type VaultLogin } from "../lib/vault";
import { parseVaultCsv, type CsvImport } from "../lib/vaultCsv";
import { siteIconUrl } from "../lib/siteIcons";

// Settings › Vault: tabs with counts, search, New item, a list of logins and
// contact info, and a dialog per item. Passwords are fetched only to reveal or copy them.

type Tab = "all" | "login" | "payment" | "contact";
type Sheet = null | { kind: "view"; id: string } | { kind: "edit"; id: string } | { kind: "new"; type: "login" | "contact" } | { kind: "import" };

export function VaultPane() {
  const items = useApp((s) => s.vault);
  const [tab, setTab] = useState<Tab>("all");
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState(false);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [error, setError] = useState("");
  const [attempt, retry] = useState(0);
  const newItemMenu = useRef<HTMLDivElement>(null);
  const openFromMenu = (next: Exclude<Sheet, null>) => {
    // The clicked menu item disappears. Give the dialog a persistent return target.
    newItemMenu.current?.querySelector("button")?.focus({ preventScroll: true });
    setMenu(false);
    setSheet(next);
  };
  useEffect(() => {
    let active = true;
    setError("");
    vaultApi.list().then((vault) => { if (active) useApp.setState({ vault }); }).catch((error: unknown) => {
      if (active) setError(error instanceof Error ? error.message : "Couldn't load Vault");
    });
    return () => { active = false; };
  }, [attempt]);
  useEffect(() => {
    if (!menu) return;
    const closeMenu = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setMenu(false);
    };
    window.addEventListener("keydown", closeMenu, true);
    return () => window.removeEventListener("keydown", closeMenu, true);
  }, [menu]);

  const logins = (items ?? []).filter((i): i is VaultLogin => i.type === "login");
  const contacts = (items ?? []).filter((i): i is VaultContact => i.type === "contact");
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const pool = tab === "payment" ? [] : tab === "login" ? logins : tab === "contact" ? contacts : [...logins, ...contacts];
    return pool
      .filter((i) => !q || [i.title, i.type === "login" ? `${(i.websites ?? [i.website]).join(" ")} ${i.username} ${i.hints}` : `${contactSummary(i)} ${i.label} ${addressLines(i).join(" ")}`].join(" ").toLowerCase().includes(q))
      .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }));
  }, [items, tab, query]);

  const tabs: [Tab, string, number][] = [
    ["all", "All", logins.length + contacts.length],
    ["login", "Logins", logins.length],
    ["payment", "Payments", 0],
    ["contact", "Contact info", contacts.length],
  ];

  return (
    <div className="vault-pane">
      <p className="vault-inline-description mb-4 text-[12.5px] text-muted">Logins and contact info your Bots can type in for you.</p>

      <div className="vault-tabs scroll-thin -mx-1 mb-3 flex gap-1 overflow-x-auto px-1 pb-0.5">
        {tabs.map(([id, label, n]) => (
          <button key={id} onClick={() => setTab(id)} aria-pressed={tab === id} className={clsx("flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-[13px]", tab === id ? "bg-active text-fg" : "text-muted hover:bg-hover hover:text-fg")}>
            {label}
            <span className="text-[12px] text-faint">{n}</span>
          </button>
        ))}
      </div>

      <div className="vault-toolbar mb-3 flex items-center gap-2">
        <label className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-full border border-line bg-elevated px-3 focus-within:border-line-strong">
          <Search size={14} className="shrink-0 text-muted" />
          <input aria-label="Search Vault" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search Vault" className="min-w-0 flex-1 bg-transparent text-[13.5px] outline-none placeholder:text-faint" />
          {query && (
            <button onClick={() => setQuery("")} className="text-muted hover:text-fg" aria-label="Clear search">
              <X size={13} />
            </button>
          )}
        </label>
        <div ref={newItemMenu} className="vault-new-item relative shrink-0">
          <Pill onClick={() => setMenu((v) => !v)} aria-label="New item" aria-expanded={menu} className="h-9">
            New item <ChevronDown size={14} />
          </Pill>
          {menu && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setMenu(false)} />
              <div className="pop-in absolute top-10 right-0 z-50 w-[200px] rounded-xl border border-line bg-elevated p-1 shadow-[var(--shadow-pop)]">
                <MenuButton icon={<KeyRound size={14} />} onClick={() => openFromMenu({ kind: "new", type: "login" })}>Login</MenuButton>
                <MenuButton icon={<UserRound size={14} />} onClick={() => openFromMenu({ kind: "new", type: "contact" })}>Contact info</MenuButton>
                <div className="my-1 h-px bg-line" />
                <MenuButton icon={<FileUp size={14} />} onClick={() => openFromMenu({ kind: "import" })}>Import from CSV…</MenuButton>
              </div>
            </>
          )}
        </div>
      </div>

      {error && <div role="alert" className="mb-3 flex flex-wrap items-center gap-2 rounded-xl bg-danger/10 p-3.5 text-[13px] text-danger"><span className="min-w-0 flex-1 break-words">Couldn't load Vault: {error}</span><Pill variant="soft" onClick={() => retry((n) => n + 1)}>Retry</Pill></div>}
      {tab === "payment" ? <div role="status" className="vault-payments-boundary"><h3>Payments aren’t available yet</h3><p>Vault supports logins and contact info. Saving cards requires a secure payment provider.</p></div> : items === null && !error ? (
        <div className="grid h-32 place-items-center text-muted">
          <Spinner />
        </div>
      ) : items === null ? null : shown.length === 0 ? (
        <Empty icon={<KeyRound size={18} />}>{query ? "No matches." : "Nothing saved yet. Add a login or contact info with New item."}</Empty>
      ) : (
        <div className="vault-items overflow-hidden rounded-[18px] border border-line bg-card">
          {shown.map((i) => (
            <button key={i.id} onClick={() => setSheet({ kind: "view", id: i.id })} className="flex w-full items-center gap-3 px-5 py-3 text-left hover:bg-hover">
              <ItemIcon item={i} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px]">{i.title}</span>
                <span className="block truncate text-[12.5px] text-muted">{i.type === "login" ? i.username || i.domain || "No username" : contactSummary(i) || "Contact info"}</span>
              </span>
              {i.type === "contact" && i.kind && <span className="shrink-0 rounded-full bg-active px-2 py-0.5 text-[11px] text-muted capitalize">{i.kind}</span>}
            </button>
          ))}
        </div>
      )}

      <div className="vault-boundary mt-4 text-[12px] leading-relaxed text-muted">
        Your Bots can fill website passwords without reading them. API tokens marked as readable and contact info are available to your Bots.
      </div>
      <div className="vault-exports mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px]">
        <a href={exportUrl("login")} download className="inline-flex items-center gap-1 text-muted underline-offset-2 hover:text-fg hover:underline">
          <Download size={12} /> Export logins (CSV)
        </a>
        <a href={exportUrl("contact")} download className="inline-flex items-center gap-1 text-muted underline-offset-2 hover:text-fg hover:underline">
          <Download size={12} /> Export contact info (CSV)
        </a>
      </div>

      {sheet?.kind === "view" && <ItemDialog id={sheet.id} onEdit={() => setSheet({ kind: "edit", id: sheet.id })} onClose={() => setSheet(null)} />}
      {sheet?.kind === "edit" && <EditDialog item={items?.find((i) => i.id === sheet.id) ?? null} onClose={() => setSheet({ kind: "view", id: sheet.id })} />}
      {sheet?.kind === "new" && <EditDialog type={sheet.type} item={null} onClose={() => setSheet(null)} />}
      {sheet?.kind === "import" && <ImportDialog onClose={() => setSheet(null)} />}
    </div>
  );
}

function MenuButton({ icon, children, onClick }: { icon: ReactNode; children: ReactNode; onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] hover:bg-hover">
      <span className="grid w-4 place-items-center text-muted">{icon}</span>
      {children}
    </button>
  );
}

function Empty({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-line px-6 py-10 text-center text-[13px] text-muted">
      <span className="grid size-9 place-items-center rounded-full bg-card">{icon}</span>
      {children}
    </div>
  );
}

export function SiteIcon({ domain, size = 32 }: { domain: string; size?: number }) {
  const [broken, setBroken] = useState("");
  const logo = domain && broken !== domain;
  return (
    <span className={clsx("grid shrink-0 place-items-center overflow-hidden rounded-lg text-muted ring-1 ring-line", logo ? "bg-white" : "bg-card-inner")} style={{ width: size, height: size, fontSize: size * 0.42 }}>
      {logo ? <img src={siteIconUrl(domain)} alt="" loading="lazy" className="object-contain" style={{ width: size * 0.68, height: size * 0.68 }} onError={() => setBroken(domain)} /> : domain ? domain[0].toUpperCase() : <KeyRound size={size * 0.45} />}
    </span>
  );
}

function ItemIcon({ item, size = 32 }: { item: VaultItem; size?: number }) {
  if (item.type === "login") return <SiteIcon domain={item.domain} size={size} />;
  return (
    <span className="grid shrink-0 place-items-center rounded-lg bg-card-inner text-muted ring-1 ring-line" style={{ width: size, height: size }}>
      <UserRound size={size * 0.5} />
    </span>
  );
}

// ---------- sheets ----------

/** A dialog above the Settings dialog. Escape closes only this one. */
function Sheet({ title, icon, onClose, children, footer, headerActions, className }: { title: ReactNode; icon?: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; headerActions?: ReactNode; className?: string }) {
  return (
    <Modal onClose={onClose} onBack={onClose} headerActions={headerActions} className={clsx("vault-sheet w-[460px]", className)} title={<span className="flex min-w-0 items-center gap-3"><span className="vault-title-icon">{icon}</span><span className="min-w-0 truncate">{title}</span></span>}>
      <div className="dialog-body scroll-thin px-4 py-4">{children}</div>
      {footer && <div className="dialog-footer flex items-center gap-2 border-t border-line px-4 py-3">{footer}</div>}
    </Modal>
  );
}

function copy(text: string, what: string) {
  if (!navigator.clipboard) { toast("Clipboard is unavailable"); return; }
  navigator.clipboard.writeText(text).then(
    () => toast(`${what} copied`),
    () => toast("Couldn't copy"),
  );
}

function ItemDialog({ id, onEdit, onClose }: { id: string; onEdit: () => void; onClose: () => void }) {
  const item = useApp((s) => s.vault?.find((i) => i.id === id));
  const [password, setPassword] = useState<string | null>(null);
  const [reveal, setReveal] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!item) return null;

  const fetchPassword = async () => {
    if (password !== null) return password;
    const full = await vaultApi.reveal(id);
    setPassword(full.password ?? "");
    return full.password ?? "";
  };
  const remove = async () => {
    if (!confirmRemove) return setConfirmRemove(true);
    setBusy(true);
    try {
      await vaultApi.remove(id);
      useApp.setState((s) => ({ vault: s.vault?.filter((item) => item.id !== id) ?? null }));
      toast("Removed from Vault");
      onClose();
    } catch (e: any) {
      toast(e.message);
      setBusy(false);
    }
  };

  return (
    <Sheet
      title={item.title}
      icon={<ItemIcon item={item} size={30} />}
      onClose={onClose}
      footer={
        <>
          <Pill variant={confirmRemove ? "danger" : "ghost"} onClick={remove} disabled={busy} className={confirmRemove ? "" : "!text-danger"}>
            {confirmRemove ? "Remove for good" : "Remove"}
          </Pill>
          <span className="flex-1" />
          <Pill variant="soft" onClick={onEdit}>
            Edit
          </Pill>
          <Pill onClick={onClose}>Done</Pill>
        </>
      }
    >
      {item.type === "login" ? (
        <div className="overflow-hidden rounded-xl border border-line">
          <ViewRow label="Website">
            {siteUrl(item.website) ? (
              <a href={siteUrl(item.website)!} target="_blank" rel="noreferrer noopener" className="inline-flex min-w-0 items-center gap-1 hover:underline">
                <span className="truncate">{item.website}</span> <ExternalLink size={12} className="shrink-0 text-muted" />
              </a>
            ) : (
              <span className="text-muted">{item.website || "None"}</span>
            )}
          </ViewRow>
          {(item.websites ?? []).slice(1).map(website => <ViewRow key={website} label="Website">{siteUrl(website) ? <a href={siteUrl(website) ?? undefined} target="_blank" rel="noreferrer" className="underline">{website}</a> : website}</ViewRow>)}
          <ViewRow label="Username" action={item.username ? <CopyButton onClick={() => copy(item.username!, "Username")} /> : null}>
            {item.username || <span className="text-muted">None</span>}
          </ViewRow>
          <ViewRow
            label="Password"
            action={
              item.hasPassword ? (
                <>
                  <IconButton
                    className="size-7"
                    aria-label={reveal ? "Hide password" : "Show password"}
                    onClick={async () => {
                      try {
                        if (!reveal) await fetchPassword();
                        setReveal(!reveal);
                      } catch (error) { toast(error instanceof Error ? error.message : "Couldn't reveal password"); }
                    }}
                  >
                    {reveal ? <EyeOff size={14} /> : <Eye size={14} />}
                  </IconButton>
                  <CopyButton onClick={() => fetchPassword().then((p) => copy(p, "Password"), (e) => toast(e.message))} />
                </>
              ) : null
            }
          >
            {!item.hasPassword ? <span className="text-muted">None</span> : reveal && password !== null ? <span className="font-mono text-[13px] break-all">{password}</span> : <span className="tracking-[0.2em] text-muted">••••••••••</span>}
          </ViewRow>
          <ViewRow label="Hints">{item.hints || <span className="text-muted">Tell Bot when to use this entry</span>}</ViewRow>
          {item.botCanRead && <ViewRow label="Bots">Can read it as an API token</ViewRow>}
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-line">
          {item.label && <ViewRow label="Label">{item.label}</ViewRow>}
          <ViewRow label="Name">{item.name || <span className="text-muted">None</span>}</ViewRow>
          <ViewRow label="Email" action={item.email ? <CopyButton onClick={() => copy(item.email!, "Email")} /> : null}>
            {item.email || <span className="text-muted">None</span>}
          </ViewRow>
          <ViewRow label="Phone" action={item.phone ? <CopyButton onClick={() => copy(item.phone!, "Phone")} /> : null}>
            {item.phone || <span className="text-muted">None</span>}
          </ViewRow>
          {(item.emails ?? []).slice(1).map((email, index) => <ViewRow key={email} label={`Email address ${index + 2}`} action={<CopyButton onClick={() => copy(email, "Email")} />}>{email}</ViewRow>)}
          {(item.phones ?? []).slice(1).map((phone, index) => <ViewRow key={phone} label={`Phone ${index + 2}`} action={<CopyButton onClick={() => copy(phone, "Phone")} />}>{phone}</ViewRow>)}
          <ViewRow label="Address">
            {addressLines(item).length ? addressLines(item).map((l) => <div key={l}>{l}</div>) : <span className="text-muted">None</span>}
          </ViewRow>
          <ViewRow label="Type">
            <span className="capitalize">{item.kind ?? "home"}</span>
          </ViewRow>
          {item.hints && <ViewRow label="Hints">{item.hints}</ViewRow>}
        </div>
      )}
      {item.type === "login" && item.domain && !item.botCanRead && <div className="mt-3 text-[12px] text-muted">Fills on {item.domain} and its subdomains</div>}
    </Sheet>
  );
}

function ViewRow({ label, children, action }: { label: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-start gap-3 border-b border-line px-3.5 py-2.5 last:border-0">
      <div className="min-w-0 flex-1">
        <div className="text-[11.5px] text-muted">{label}</div>
        <div className="mt-0.5 min-w-0 text-[13.5px] break-words">{children}</div>
      </div>
      {action && <div className="flex shrink-0 items-center gap-0.5 self-center">{action}</div>}
    </div>
  );
}

function CopyButton({ onClick }: { onClick: () => void }) {
  return (
    <IconButton className="size-7" onClick={onClick} aria-label="Copy">
      <Copy size={13} />
    </IconButton>
  );
}

// ---------- forms ----------

export function Field({ label, desktopLabel, children, hint }: { label: string; desktopLabel?: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className={`vault-field vault-field-${label.toLowerCase().replace(/[^a-z]+/g, "-")}`}>
      <span className="mb-1 block text-[12px] text-muted"><span className={desktopLabel ? "vault-mobile-label" : undefined}>{label}</span>{desktopLabel && <span className="vault-desktop-label">{desktopLabel}</span>}</span>
      {children}
      {hint && <span className="mt-1 block text-[11.5px] text-muted">{hint}</span>}
    </label>
  );
}

export const inputClass = "settings-input w-full placeholder:text-faint";

export function PasswordInput({ value, onChange, placeholder, autoFocus }: { value: string; onChange: (v: string) => void; placeholder?: string; autoFocus?: boolean }) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <input type={show ? "text" : "password"} autoComplete="new-password" autoFocus={autoFocus} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className={clsx(inputClass, "pr-9")} />
      <button type="button" onClick={() => setShow(!show)} className="absolute top-1/2 right-1.5 grid size-6 -translate-y-1/2 place-items-center rounded-md text-muted hover:text-fg" aria-label={show ? "Hide password" : "Show password"}>
        {show ? <EyeOff size={14} /> : <Eye size={14} />}
      </button>
    </div>
  );
}

type RepeatedField = "website" | "phone" | "email";
function repeated(values: string[] | undefined, primary: string | undefined): string[] {
  return values?.length ? values : [primary ?? ""];
}

function RepeatedFields({ kind, values, onChange }: { kind: RepeatedField; values: string[]; onChange: (values: string[]) => void }) {
  const label = kind === "website" ? "Website" : kind === "phone" ? "Phone" : "Email";
  return <div className={`vault-repeated-fields vault-repeated-${kind}`}>
    {values.map((value, index) => <div key={index} className="vault-repeated-row">
      <Field label={index === 0 || kind === "website" ? label : kind === "phone" ? `Phone ${index + 1}` : `Email address ${index + 1}`}>
        <input value={value} onChange={event => onChange(values.map((entry, at) => at === index ? event.target.value : entry))} type={kind === "phone" ? "tel" : kind === "email" ? "email" : "text"} inputMode={kind === "website" ? "url" : undefined} autoComplete={kind === "phone" ? "tel" : kind === "email" ? "email" : "off"} placeholder={kind === "website" ? "https://example.com" : kind === "phone" ? "(555) 555-5555" : "name@example.com"} className={inputClass} />
      </Field>
      {(index > 0 || (kind === "website" && values.length > 1)) && <div className="vault-repeated-actions">
        {index > 0 && kind !== "website" && <button type="button" onClick={() => onChange([value, ...values.filter((_, at) => at !== index)])}>Make primary</button>}
        <button type="button" className={kind === "website" ? "text-muted" : "text-danger"} onClick={() => onChange(values.filter((_, at) => at !== index))}>Remove</button>
      </div>}
    </div>)}
    <button type="button" className="vault-add-field" disabled={values.length >= 20} onClick={() => onChange([...values, ""])}>{kind === "website" ? "Add website" : kind === "phone" ? "Add phone" : "Add email"}</button>
  </div>;
}

export function ContactFields({ value, onChange, compact }: { value: ContactInput; onChange: (v: ContactInput) => void; compact?: boolean }) {
  const f = (k: Exclude<keyof ContactInput, "emails" | "phones">) => ({ value: value[k] ?? "", onChange: (e: React.ChangeEvent<HTMLInputElement>) => onChange({ ...value, [k]: e.target.value }) });
  return <div className="vault-contact-fields space-y-2.5">
    <div className="vault-contact-group">
      {!compact && <Field label="Label"><input {...f("label")} placeholder="Home" className={inputClass} /></Field>}
      <Field label="Full name"><input {...f("name")} autoComplete="name" placeholder="Optional" className={inputClass} /></Field>
      <RepeatedFields kind="phone" values={repeated(value.phones, value.phone)} onChange={phones => onChange({ ...value, phones, phone: phones[0] ?? "" })} />
      <RepeatedFields kind="email" values={repeated(value.emails, value.email)} onChange={emails => onChange({ ...value, emails, email: emails[0] ?? "" })} />
    </div>
    <p className="vault-contact-caption">Contact info needs an address, a phone number, or an email address.</p>
    <div className="vault-address-title">Address</div>
    <div className="vault-contact-group">
      <Field label="Country"><input {...f("country")} placeholder="US" autoComplete="country" className={inputClass} /></Field>
      <Field label="Street" desktopLabel="Address"><input {...f("street")} autoComplete="address-line1" placeholder="Street address" className={inputClass} /></Field>
      <Field label="Apt or unit" desktopLabel="Address line 2"><input {...f("apt")} autoComplete="address-line2" placeholder="Optional" className={inputClass} /></Field>
      <Field label="City"><input {...f("city")} placeholder="City" autoComplete="address-level2" className={inputClass} /></Field>
      <Field label="State" desktopLabel="State or region"><input {...f("state")} placeholder="State" autoComplete="address-level1" className={inputClass} /></Field>
      <Field label="ZIP code" desktopLabel="ZIP or postal code"><input {...f("zip")} placeholder="ZIP code" autoComplete="postal-code" className={inputClass} /></Field>
    </div>
    <div className="flex gap-1">{(["home", "work", "other"] satisfies NonNullable<ContactInput["kind"]>[]).map((kind) => <button key={kind} type="button" onClick={() => onChange({ ...value, kind })} className={clsx("h-8 rounded-full px-3 text-[13px] capitalize", (value.kind ?? "home") === kind ? "bg-pill text-pill-fg" : "bg-pill-soft hover:bg-active")}>{kind}</button>)}</div>
  </div>;
}

function EditDialog({ item, type, onClose }: { item: VaultItem | null; type?: "login" | "contact"; onClose: () => void }) {
  const kind = item?.type ?? type ?? "login";
  const [login, setLogin] = useState<LoginInput>(() => (item?.type === "login" ? { title: item.title, website: item.website ?? "", websites: item.websites, username: item.username ?? "", hints: item.hints ?? "", botCanRead: item.botCanRead === true } : { website: "", username: "", password: "", hints: "", botCanRead: false }));
  const [password, setPassword] = useState("");
  const [contact, setContact] = useState<ContactInput>(() => {
    if (item?.type !== "contact") return { kind: "home" };
    const { id: _i, type: _t, createdAt: _c, updatedAt: _u, title: _ti, ...rest } = item;
    return rest;
  });
  const [busy, setBusy] = useState(false);
  const websites = repeated(login.websites, login.website);
  const domain = siteDomain(websites.find(value => value.trim()));
  const wasDomainTitle = item?.type === "login" && (item.title === item.domain || !item.title);

  const canSave = kind === "login" ? Boolean(domain || login.title?.trim()) : Boolean(repeated(contact.emails, contact.email).some(value => value.trim()) || repeated(contact.phones, contact.phone).some(value => value.trim()) || contact.street?.trim());
  const save = async () => {
    if (!canSave || busy) return;
    setBusy(true);
    try {
      let saved: VaultItem;
      if (kind === "login") {
        const title = !login.title?.trim() || wasDomainTitle ? domain || login.title : login.title;
        const body: LoginInput = { ...login, title };
        if (!item || password) body.password = password;
        saved = item ? await vaultApi.update(item.id, body) : await vaultApi.create({ type: "login", ...body });
      } else {
        const title = contact.label || contact.name || contact.email || "Contact info";
        saved = item ? await vaultApi.update(item.id, { ...contact, title }) : await vaultApi.create({ type: "contact", ...contact, title });
      }
      useApp.setState((s) => ({ vault: [...(s.vault ?? []).filter((entry) => entry.id !== saved.id), saved] }));
      toast(item ? "Saved" : "Saved to Vault");
      onClose();
    } catch (e: any) {
      toast(e.message);
      setBusy(false);
    }
  };

  return (
    <Sheet
      title={item ? `Edit ${item.title}` : kind === "login" ? "New login" : "New contact info"}
      className={clsx("vault-edit-sheet", kind === "login" ? "vault-login-sheet" : "vault-contact-sheet")}
      headerActions={kind === "login" ? <Pill className="vault-header-save" variant="soft" onClick={save} disabled={!canSave || busy}>{busy ? <Spinner /> : "Save"}</Pill> : undefined}
      icon={kind === "login" ? <SiteIcon domain={domain} size={30} /> : <UserRound size={18} className="text-muted" />}
      onClose={onClose}
      footer={
        <>
          <span className="flex-1" />
          <Pill className="vault-cancel-edit" variant="soft" onClick={onClose}>
            Cancel
          </Pill>
          <Pill onClick={save} disabled={!canSave || busy}>
            {busy && <Spinner />} {kind === "login" ? "Save login" : "Save contact info"}
          </Pill>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <fieldset disabled={busy} className="min-w-0 space-y-2.5">
          {kind === "login" ? (
            <>
              <Field label="Name"><input value={login.title ?? ""} onChange={(e) => setLogin({ ...login, title: e.target.value })} className={inputClass} /></Field>
              <RepeatedFields kind="website" values={websites} onChange={websites => setLogin({ ...login, websites, website: websites[0] ?? "" })} />
              <div className="vault-credentials">
              <Field label="Username or email">
                <input value={login.username ?? ""} onChange={(e) => setLogin({ ...login, username: e.target.value })} autoComplete="off" className={inputClass} />
              </Field>
              <Field label="Password">
                <PasswordInput value={password} onChange={setPassword} placeholder={item?.type === "login" && item.hasPassword ? "Unchanged" : ""} />
              </Field>
              </div>
              <Field label="Hints">
                <textarea value={login.hints ?? ""} onChange={(e) => setLogin({ ...login, hints: e.target.value })} rows={2} className={clsx(inputClass, "h-auto resize-none py-2")} />
              </Field>
              <p className="vault-hints-helper">Tell Bot when to use this entry</p>
              <div className="flex items-center gap-3 rounded-xl bg-card px-3 py-2.5">
                <span className="min-w-0 flex-1">
                  <span className="block text-[13.5px]">API token or key</span>
                  <span className="block text-[12px] text-muted">Bots can read it to call an API. Leave off for website passwords, which Bots only type into the sign-in page.</span>
                </span>
                <Switch checked={login.botCanRead === true} onChange={(v) => setLogin({ ...login, botCanRead: v })} label="API token or key" />
              </div>

            </>
          ) : (
            <>
              <ContactFields value={contact} onChange={setContact} />
              <Field label="Hints">
                <textarea value={contact.hints ?? ""} onChange={(e) => setContact({ ...contact, hints: e.target.value })} rows={2} className={clsx(inputClass, "h-auto resize-none py-2")} />
              </Field><p className="vault-hints-helper">Tell Bot when to use this entry</p>
            </>
          )}
          <button type="submit" hidden />
        </fieldset>
      </form>
    </Sheet>
  );
}

function ImportDialog({ onClose }: { onClose: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [parsed, setParsed] = useState<(CsvImport & { fileName: string }) | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const logins = parsed?.items.filter((i) => i.type === "login").length ?? 0;
  const contacts = (parsed?.items.length ?? 0) - logins;

  const read = async (file: File) => {
    setError("");
    setParsed(null);
    if (file.size > 20 * 1024 * 1024) return setError("That file is too big for a password export.");
    try {
      const result = parseVaultCsv(await file.text());
      if (!result.items.length) return setError("No logins or contact info found in that file. Export a CSV from your password manager and try again.");
      setParsed({ ...result, fileName: file.name });
    } catch {
      setError("Couldn't read that file as CSV.");
    }
  };
  const doImport = async () => {
    if (!parsed) return;
    setBusy(true);
    try {
      const r = await vaultApi.import(parsed.items);
      try { useApp.setState({ vault: await vaultApi.list() }); }
      catch { toast("Import completed, but couldn't refresh Vault. Reopen Vault to reload it."); onClose(); return; }
      toast(`Imported ${r.added + r.updated} item${r.added + r.updated === 1 ? "" : "s"}${r.skipped ? ` (${r.skipped} already saved)` : ""}`);
      onClose();
    } catch (e: any) {
      setError(e.message);
      setBusy(false);
    }
  };

  return (
    <Sheet
      title="Import from CSV"
      icon={<FileUp size={18} className="text-muted" />}
      onClose={onClose}
      footer={
        <>
          <span className="flex-1" />
          <Pill className="vault-cancel-edit" variant="soft" onClick={onClose}>
            Cancel
          </Pill>
          <Pill onClick={doImport} disabled={!parsed || busy}>
            {busy && <Spinner />} Import {parsed ? parsed.items.length : ""} items
          </Pill>
        </>
      }
    >
      <p className="text-[13px] text-muted">Export a CSV from 1Password, Chrome or Edge, Safari or Apple Passwords, Firefox, Bitwarden or LastPass, then choose it here.</p>
      <p className="mt-2 text-[13px] text-muted">The file is read on this device and never uploaded. Only the items in it are saved to your Vault.</p>
      <input ref={input} type="file" accept=".csv,text/csv" hidden onChange={(e) => e.target.files?.[0] && read(e.target.files[0])} />
      <Pill variant="soft" className="mt-4" onClick={() => input.current?.click()}>
        <FileUp size={14} /> Choose CSV file
      </Pill>
      {parsed && (
        <div className="mt-4 rounded-xl border border-line px-3.5 py-3 text-[13px]">
          <div className="truncate font-medium">{parsed.fileName}</div>
          <div className="mt-0.5 text-muted">
            {parsed.format} export · {logins} login{logins === 1 ? "" : "s"}
            {contacts ? ` · ${contacts} contact info` : ""}
            {parsed.skipped ? ` · ${parsed.skipped} skipped (notes, cards or empty rows)` : ""}
          </div>
          <div className="mt-2 text-[12px] text-muted">Logins already in your Vault for the same site and username are updated.</div>
        </div>
      )}
      {error && <div className="mt-3 text-[13px] text-danger">{error}</div>}
      <p className="mt-4 text-[12px] text-muted">Delete the exported file afterwards; it holds your passwords in plain text.</p>
    </Sheet>
  );
}
