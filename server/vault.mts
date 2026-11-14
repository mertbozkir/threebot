// The Vault: logins (and API tokens) and contact info shared by all Bots, encrypted at rest.
//
// File format (version 1), JSON:
//   {"format":"bot-vault","version":1,"cipher":"aes-256-gcm","iv":b64,"tag":b64,"data":b64}
// `data` decrypts (key = 32 raw bytes in the key file, AAD "bot-vault:v1") to
//   {"items":[...], "updatedAt": iso}
// Writes are atomic (temp file + fsync + rename) and serialized.
//
// Never log or return passwords from here except through get(id, {reveal:true}) and exportCsv().
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const FORMAT = "bot-vault";
const VERSION = 1;
const AAD = Buffer.from(`${FORMAT}:v${VERSION}`);

// botCanRead: an API token or key the Bots may read (vault_secret_file). Other passwords are only ever typed into pages.
export const LOGIN_FIELDS = ["title", "website", "websites", "username", "password", "hints", "botCanRead"];
export const CONTACT_FIELDS = ["title", "label", "name", "email", "emails", "phone", "phones", "street", "apt", "city", "state", "zip", "country", "kind", "hints"];
const CONTACT_KINDS = ["home", "work", "other"];
const MAX_FIELD = 4000;
const MAX_ITEMS = 10000;

export type VaultItemType = "login" | "contact";
/** A saved item as stored (decrypted). Records written by older versions may lack newer fields. */
export interface VaultItem {
  id: string;
  type: VaultItemType;
  createdAt?: string;
  updatedAt?: string;
  title?: string;
  // login
  website?: string;
  websites?: string[];
  username?: string;
  password?: string;
  hints?: string;
  botCanRead?: boolean;
  // contact
  label?: string;
  name?: string;
  email?: string;
  emails?: string[];
  phone?: string;
  phones?: string[];
  street?: string;
  apt?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
  kind?: string;
  [field: string]: unknown;
}
/** Item fields as the app, Bots or an import send them (a JSON body); normalize() checks every field it keeps. */
export type VaultInput = Record<string, any>;
export interface VaultEnvelope { format: string; version: number; cipher: string; iv: string; tag: string; data: string }
interface VaultPayload { items?: unknown; updatedAt?: string }
type RepeatedField = "website" | "email" | "phone";
/** An item as the app list and Bots see it; logins also carry where they fill and whether a password is saved. */
export interface RedactedItem extends VaultItem { domain?: string; hasPassword?: boolean }

function httpError(status: number, message: string) {
  return Object.assign(new Error(message), { status });
}

// ---------- key ----------
export async function loadOrCreateKey(keyFile: string, { create = true }: { create?: boolean } = {}): Promise<Buffer> {
  try {
    const key = await fs.readFile(keyFile);
    if (key.length !== 32) throw httpError(500, "The vault key file is not a 32-byte key.");
    return key;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  if (!create) throw httpError(500, "The vault key file is missing, so the vault can't be opened. Restore it (VAULT_KEY_FILE).");
  await fs.mkdir(path.dirname(keyFile), { recursive: true, mode: 0o700 });
  const key = randomBytes(32);
  try {
    await fs.writeFile(keyFile, key, { mode: 0o600, flag: "wx" });
    return key;
  } catch (e) {
    // Another process created it first.
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return loadOrCreateKey(keyFile, { create: false });
    throw e;
  }
}

// ---------- encryption ----------
export function encrypt(key: Buffer, payload: unknown): VaultEnvelope {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(AAD);
  const data = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(payload), "utf8")), cipher.final()]);
  return { format: FORMAT, version: VERSION, cipher: "aes-256-gcm", iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
}

export function decrypt(key: Buffer, envelope: VaultEnvelope | null | undefined): VaultPayload {
  if (envelope?.format !== FORMAT) throw httpError(500, "This file is not a Bot vault.");
  if (envelope.version !== VERSION || envelope.cipher !== "aes-256-gcm") throw httpError(500, `Unsupported vault version ${envelope.version}.`);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
    decipher.setAAD(AAD);
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    const plain = Buffer.concat([decipher.update(Buffer.from(envelope.data, "base64")), decipher.final()]);
    return JSON.parse(plain.toString("utf8"));
  } catch {
    // Don't echo anything from the plaintext or the key.
    throw httpError(500, "Couldn't decrypt the vault. The key file doesn't match the vault file, or the file is damaged.");
  }
}

export async function writeAtomic(file: string, text: string) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const fh = await fs.open(tmp, "w", 0o600);
  try {
    await fh.writeFile(text);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, file);
}

// ---------- sites ----------
/** "https://www.GitHub.com/login" or "github.com" → URL, or null. */
export function parseSite(input: unknown): URL | null {
  const s = String(input ?? "").trim();
  if (!s) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (!u.hostname) return null;
    return u;
  } catch {
    return null;
  }
}

/** The domain a login fills on: the website's hostname without a leading "www.". */
export function siteDomain(website: unknown): string {
  const u = parseSite(website);
  if (!u) return "";
  return u.hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
}

/**
 * Whether a page URL is the login's saved site or one of its subdomains.
 * Lookalikes (google.com.evil.io, accounts-google.com, xn--ggle-…) don't match.
 * A page served over plain http only matches a login saved with an explicit http:// address.
 */
export function matchesSite(pageUrl: unknown, website: unknown): boolean {
  const domain = siteDomain(website);
  if (!domain) return false;
  let page: URL;
  try {
    page = new URL(String(pageUrl ?? ""));
  } catch {
    return false;
  }
  if (page.protocol !== "https:" && page.protocol !== "http:") return false;
  if (page.protocol === "http:" && !/^http:\/\//i.test(String(website).trim())) return false;
  const host = page.hostname.toLowerCase().replace(/\.$/, "");
  return host === domain || host.endsWith(`.${domain}`);
}

// ---------- items ----------
function clean(v: unknown, max = MAX_FIELD): string {
  if (v === undefined || v === null) return "";
  return String(v).slice(0, max);
}

function normalizeWebsite(w: unknown): string {
  const s = clean(w, 2000).trim();
  if (!s) return "";
  const u = parseSite(s);
  if (!u) return s;
  // Keep what the user typed, but give bare domains a scheme.
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`;
}

// Ordered values: first is primary. Scalar mirrors preserve existing records and callers.
const REPEATED = { website: 'websites', email: 'emails', phone: 'phones' } as const;
export function repeatedValues(item: VaultItem, field: RepeatedField): string[] {
  const values = item[REPEATED[field]];
  return Array.isArray(values) ? values : item[field] ? [item[field]] : [];
}
function normalizeRepeated(input: VaultInput, out: VaultItem, field: RepeatedField) {
  const plural = REPEATED[field];
  if (!(plural in input) && !(field in input)) return;
  let values: unknown[];
  if (plural in input) {
    if (!Array.isArray(input[plural]) || input[plural].length > 20 || input[plural].some(value => typeof value !== 'string' || value.length > MAX_FIELD)) {
      throw httpError(400, `${plural} must contain at most 20 text values.`);
    }
    values = input[plural];
  } else {
    // Older clients update the primary without silently discarding secondary values.
    values = [input[field], ...repeatedValues(out, field).slice(1)];
  }
  out[plural] = [...new Set(values.map(value => field === 'website' ? normalizeWebsite(value) : clean(value).trim()).filter(Boolean))];
  out[field] = out[plural][0] ?? '';
}

function normalize(input: VaultInput, existing: VaultItem | null = null): VaultItem {
  const type = existing?.type ?? input.type;
  if (type !== "login" && type !== "contact") throw httpError(400, "type must be login or contact");
  const fields = type === "login" ? LOGIN_FIELDS : CONTACT_FIELDS;
  const out: VaultItem = existing ? { ...existing } : { id: randomUUID(), type, createdAt: new Date().toISOString() };
  for (const f of fields) {
    if (!(f in input) || f in REPEATED || (Object.values(REPEATED) as readonly string[]).includes(f)) continue;
    if (f === "password") out.password = clean(input.password);
    else if (f === "botCanRead") out.botCanRead = input.botCanRead === true;
    else if (f === "kind") out.kind = CONTACT_KINDS.includes(input.kind) ? input.kind : "other";
    else out[f] = clean(input[f]).trim();
  }
  for (const field of type === "login" ? ["website"] as const : ["email", "phone"] as const) normalizeRepeated(input, out, field);
  if (type === "login") {
    if (!out.website && !out.title) throw httpError(400, "A login needs a website or a title.");
    if (!out.title) out.title = siteDomain(out.website) || out.website;
  } else {
    out.kind ??= "home";
    if (!out.title) out.title = out.label || out.name || out.email || "Contact info";
  }
  out.updatedAt = new Date().toISOString();
  return out;
}

/** What the app list and Bots may see: everything except the password. */
export function redact(item: VaultItem): RedactedItem {
  if (item.type !== "login") return { ...item };
  const { password, ...rest } = item;
  return { ...rest, domain: siteDomain(item.website), hasPassword: Boolean(password) };
}

// ---------- CSV export ----------
function csvCell(v: unknown) {
  const s = String(v ?? "");
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export function toCsv(rows: unknown[][]) {
  return rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
export const LOGIN_CSV_HEADER = ["name", "url", "username", "password", "note"];
export const CONTACT_CSV_HEADER = ["label", "name", "email", "phone", "street", "apt", "city", "state", "zip", "country", "kind", "note"];

// ---------- the store ----------
/** What a mutation hands back: the next item list and the caller's result. */
type Mutation<T> = { next: VaultItem[]; result: T };

export type Vault = ReturnType<typeof createVault>;
export function createVault({ file, keyFile }: { file: string; keyFile: string }) {
  let key: Buffer | null = null;
  let items: VaultItem[] | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  async function load(): Promise<VaultItem[]> {
    if (items) return items;
    let raw: string | null = null;
    try {
      raw = await fs.readFile(file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    // A new key is only made for a new vault; an existing vault without its key stays locked.
    key ??= await loadOrCreateKey(keyFile, { create: raw === null });
    if (raw === null) {
      items = [];
      return items;
    }
    let envelope;
    try {
      envelope = JSON.parse(raw);
    } catch {
      throw httpError(500, "The vault file is damaged.");
    }
    const payload = decrypt(key, envelope);
    items = Array.isArray(payload.items) ? payload.items : [];
    return items;
  }

  async function save(next: VaultItem[]) {
    // load() always runs first (in mutate), so the key is set.
    const envelope = encrypt(key!, { items: next, updatedAt: new Date().toISOString() });
    await writeAtomic(file, JSON.stringify(envelope) + "\n");
    items = next;
  }

  /** Runs fn(items) → next items under a lock and persists the result. */
  function mutate<T>(fn: (items: VaultItem[]) => Mutation<T>): Promise<T> {
    const run = queue.then(async () => {
      const current = await load();
      const { next, result } = await fn(current.slice());
      if (next.length > MAX_ITEMS) throw httpError(400, `The vault holds at most ${MAX_ITEMS} items.`);
      await save(next);
      return result;
    });
    queue = run.catch(() => {});
    return run;
  }

  async function find(id: string) {
    const all = await load();
    return all.find((i) => i.id === id) ?? null;
  }

  return {
    file,
    keyFile,
    async list() {
      return (await load()).map(redact);
    },
    /** The full item; the password only with reveal. */
    async get(id: string, { reveal = false }: { reveal?: boolean } = {}): Promise<VaultItem | null> {
      const item = await find(id);
      if (!item) return null;
      return reveal ? { ...item } : redact(item);
    },
    create(input?: VaultInput | null) {
      return mutate((all) => {
        const item = normalize(input ?? {});
        return { next: [...all, item], result: redact(item) };
      });
    },
    update(id: string, patch?: VaultInput | null) {
      return mutate((all) => {
        const i = all.findIndex((x) => x.id === id);
        if (i === -1) throw httpError(404, "Not found");
        const { id: _i, type: _t, createdAt: _c, ...rest } = patch ?? {};
        all[i] = normalize(rest, all[i]);
        return { next: all, result: redact(all[i]) };
      });
    },
    remove(id: string) {
      return mutate((all) => {
        const next = all.filter((x) => x.id !== id);
        if (next.length === all.length) throw httpError(404, "Not found");
        return { next, result: { ok: true } };
      });
    },
    /**
     * Saves a login a Bot collected with T3's secure card. A login with the same domain and username
     * is updated instead of duplicated.
     */
    saveLogin(input?: VaultInput | null) {
      return mutate((all) => {
        const item = normalize({ ...(input ?? {}), type: "login" });
        const domain = siteDomain(item.website);
        const i = all.findIndex((x) => x.type === "login" && domain && repeatedValues(x, "website").some(site => siteDomain(site) === domain) && (x.username ?? "") === (item.username ?? ""));
        if (i === -1) return { next: [...all, item], result: { item: redact(item), updated: false } };
        const patch: VaultInput = { ...input, ...("title" in (input ?? {}) ? {} : { title: all[i].title }) };
        // A password refresh through any already-saved site keeps the site's order.
        if (!("websites" in patch) && repeatedValues(all[i], "website").some(site => siteDomain(site) === domain)) delete patch.website;
        all[i] = normalize(patch, all[i]);
        return { next: all, result: { item: redact(all[i]), updated: true } };
      });
    },
    /**
     * Adds imported items. A login with the same domain and username as a saved one updates it
     * (password and hints); an identical one is skipped.
     */
    importItems(list: unknown) {
      if (!Array.isArray(list)) throw httpError(400, "items must be a list");
      return mutate((all) => {
        let added = 0, updated = 0, skipped = 0;
        for (const raw of list.slice(0, MAX_ITEMS)) {
          let item: VaultItem;
          try {
            item = normalize({ ...raw, type: raw?.type === "contact" ? "contact" : "login" });
          } catch {
            skipped++;
            continue;
          }
          if (item.type === "login") {
            const domain = siteDomain(item.website);
            const same = all.findIndex((x) => x.type === "login" && (domain ? repeatedValues(x, "website").some(site => siteDomain(site) === domain) : !siteDomain(x.website)) && (x.username ?? "") === (item.username ?? "") && (domain || x.title === item.title));
            if (same !== -1) {
              const prev = all[same];
              if ((prev.password ?? "") === (item.password ?? "") && (!item.hints || prev.hints === item.hints) && (!("websites" in raw) || JSON.stringify(repeatedValues(prev, "website")) === JSON.stringify(item.websites))) skipped++;
              else {
                all[same] = normalize({ password: item.password || prev.password, hints: item.hints || prev.hints, ...("websites" in raw ? { websites: raw.websites } : {}) }, prev);
                updated++;
              }
              continue;
            }
          } else {
            const same = all.some((x) => x.type === "contact" && CONTACT_FIELDS.every((f) => f === "title" || (f === "emails" || f === "phones" ? JSON.stringify(repeatedValues(x, f === "emails" ? "email" : "phone")) === JSON.stringify(repeatedValues(item, f === "emails" ? "email" : "phone")) : JSON.stringify(x[f] ?? "") === JSON.stringify(item[f] ?? ""))));
            if (same) {
              skipped++;
              continue;
            }
          }
          all.push(item);
          added++;
        }
        return { next: all, result: { added, updated, skipped } };
      });
    },
    /** CSV with passwords: logins in Chrome's format, or contact info in the Bot format. */
    async exportCsv(type = "login") {
      const all = await load();
      if (type === "contact") {
        const contacts = all.filter(i => i.type === "contact");
        const repeated = contacts.some(item => repeatedValues(item, "email").length > 1 || repeatedValues(item, "phone").length > 1);
        return toCsv([[...CONTACT_CSV_HEADER, ...(repeated ? ["emails", "phones"] : [])], ...contacts.map(c => [c.label || c.title, c.name, c.email, c.phone, c.street, c.apt, c.city, c.state, c.zip, c.country, c.kind, c.hints, ...(repeated ? [JSON.stringify(repeatedValues(c, "email")), JSON.stringify(repeatedValues(c, "phone"))] : [])])]);
      }
      const logins = all.filter(i => i.type === "login");
      const repeated = logins.some(item => repeatedValues(item, "website").length > 1);
      return toCsv([[...LOGIN_CSV_HEADER, ...(repeated ? ["websites"] : [])], ...logins.map(l => [l.title, l.website, l.username, l.password, l.hints, ...(repeated ? [JSON.stringify(repeatedValues(l, "website"))] : [])])]);
    },
  };
}
