import { promises as fs } from "node:fs";
import path from "node:path";
import { createJsonCache } from "./cached-json.mts";
import { ADOPTED_DATA, readAdopted, type AdoptedBot } from "./adopted-bots.mts";

/** A Bot as the app sees it: its `.bot/bot.json`, with defaults filled in, plus where its folder is. */
export interface Bot {
  slug: string; workspaceRoot: string; name: string; label: string; shape: string; color: string;
  section: string | null; pinned: boolean; hidden: boolean; primary: boolean; notifications: boolean;
  projectId: string | null; mainThreadId: string | null; createdAt: string; updatedAt?: string;
  /** Made from an existing T3 project: it lives in that project's folder, with its own things in `.bot/`. */
  adopted: boolean;
  /** The machine the Bot's folder is on ("local": this one). */
  environmentId: string;
  /** Where its memory/ and library/ are: the folder itself, or `<folder>/.bot` for an adopted Bot. */
  dataDir: string;
  /** How Executor answers app approval prompts for this Bot; absent keeps the configured URL's default. */
  executorApproval?: 'ask' | 'automatic';
  // Whatever else the Bot or the app keeps in bot.json (model, brief, avatarImage, ...).
  [key: string]: unknown;
}
/** Fields a caller asks to change. It comes from request bodies and provisioning, so nothing is assumed. */
export type BotPatch = { [key: string]: unknown };

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** Fields the registry works out from where the Bot lives; never written to bot.json. */
const DERIVED = ["slug", "workspaceRoot", "adopted", "environmentId", "dataDir"] as const;
const withoutDerived = (value: { [key: string]: unknown }) => Object.fromEntries(Object.entries(value).filter(([key]) => !(DERIVED as readonly string[]).includes(key)));
const failure = (message: string, status = 409) => Object.assign(new Error(message), { status });

// The parsed file is whatever JSON is on disk; callers check the fields they use.
async function readJson<T>(file: string, fallback: T): Promise<any> {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback; throw error; }
}

async function writeJson(file: string, value: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(`${file}.tmp`, JSON.stringify(value, null, 2) + "\n");
  await fs.rename(`${file}.tmp`, file);
}

/** One writer owns the selection and its compatibility flags, including provisioning writes. */
export function createMainBotRegistry({ botsRoot, onBotChanged = async () => {} }: { botsRoot: string; onBotChanged?: (bot: Bot) => Promise<unknown> }) {
  const selectionFile = path.join(botsRoot, ".botapp", "main-bot.json");
  let pending: Promise<unknown> = Promise.resolve();
  const metadataCache = createJsonCache();
  function exclusive<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = pending.then(operation);
    pending = result.catch(() => {});
    return result;
  }
  // Adopted Bots by slug, as of the last load. Every operation loads first, so this is current.
  let adopted = new Map<string, AdoptedBot>();
  function directory(slug: unknown): string {
    if (typeof slug !== "string" || !SLUG.test(slug)) throw failure("bad slug", 400);
    return adopted.get(slug)?.path ?? path.join(botsRoot, slug);
  }
  const metadataFile = (slug: string) => path.join(directory(slug), ".bot", "bot.json");

  async function loadBots() {
    adopted = new Map((await readAdopted(botsRoot)).map((entry) => [entry.slug, entry]));
    const entries = await fs.readdir(botsRoot, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const bots: Bot[] = [];
    const add = async (slug: string, entry: AdoptedBot | null) => {
      const meta = await metadataCache.read(metadataFile(slug), null);
      if (!meta) return;
      const createdAt = meta.createdAt ?? (await fs.stat(metadataFile(slug))).birthtime.toISOString();
      const workspaceRoot = directory(slug);
      bots.push({
        label: "", shape: "sphere", color: "teal", section: null, pinned: false,
        hidden: false, primary: false, notifications: true, projectId: null, mainThreadId: null,
        ...meta, name: typeof meta.name === "string" && meta.name.trim() ? meta.name : slug,
        createdAt, slug, workspaceRoot, adopted: Boolean(entry), environmentId: entry?.environmentId ?? "local",
        dataDir: entry ? path.join(workspaceRoot, ADOPTED_DATA) : workspaceRoot,
      });
    };
    const local = entries.filter((entry) => entry.isDirectory() && SLUG.test(entry.name) && !adopted.has(entry.name));
    const external = [...adopted.values()].filter((entry) => SLUG.test(entry.slug));
    metadataCache.retain(new Set([...local.map((entry) => metadataFile(entry.name)), ...external.map((entry) => metadataFile(entry.slug))]));
    await Promise.all([...local.map((entry) => add(entry.name, null)), ...external.map((entry) => add(entry.slug, entry))]);
    return bots.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.slug.localeCompare(b.slug));
  }

  async function persistMetadata(bot: { slug: string; [key: string]: unknown }) {
    metadataCache.clear();
    await writeJson(metadataFile(bot.slug), withoutDerived(bot));
  }

  async function reconcile() {
    const bots = await loadBots();
    const selection = await readJson(selectionFile, null);
    // A persisted choice outranks every legacy/self-written primary flag.
    const visible = bots.filter((bot) => !bot.hidden);
    const main = bots.find((bot) => bot.slug === selection?.slug)
      ?? (selection === null ? visible.find((bot) => bot.primary) : null)
      ?? visible[0] ?? bots[0] ?? null;
    if (selection === null || selection.slug !== (main?.slug ?? null)) {
      await writeJson(selectionFile, { slug: main?.slug ?? null });
    }
    for (const bot of bots) {
      const primary = bot.slug === main?.slug;
      if (bot.primary !== primary || (primary && bot.hidden)) {
        bot.primary = primary;
        if (primary) bot.hidden = false;
        await persistMetadata(bot);
        await onBotChanged(bot);
      }
    }
    return bots;
  }

  async function choose(slug: string): Promise<Bot[]> {
    directory(slug);
    const bots = await reconcile();
    const target = bots.find((bot) => bot.slug === slug);
    if (!target) throw failure("Bot not found", 404);
    // Commit the authority first. A restart repairs flags if interrupted afterward.
    await writeJson(selectionFile, { slug });
    if (target.hidden) {
      target.hidden = false;
      await persistMetadata(target);
    }
    return reconcile();
  }

  return {
    list: () => exclusive(reconcile),
    refreshInstructions: () => exclusive(async () => {
      for (const bot of await reconcile()) await onBotChanged(bot);
    }),
    get: (slug: string) => exclusive(async () => {
      directory(slug);
      return (await reconcile()).find((bot) => bot.slug === slug) ?? null;
    }),
    select: (slug: string) => exclusive(() => choose(slug)),
    save: (slug: string, patch: BotPatch, { create = false }: { create?: boolean } = {}) => exclusive(async () => {
      directory(slug);
      const bots = await reconcile();
      const current = bots.find((bot) => bot.slug === slug);
      if (!current && !create) throw failure("Bot not found", 404);
      if ("primary" in patch && typeof patch.primary !== "boolean") throw failure("primary must be a boolean", 400);
      if ("hidden" in patch && typeof patch.hidden !== "boolean") throw failure("hidden must be a boolean", 400);
      if (current?.primary && (patch.hidden === true || patch.primary === false)) {
        throw failure("Choose another main Bot first.");
      }
      const { primary: requestedMain, ...clean } = withoutDerived(patch);
      const next = { ...current, ...clean, slug, primary: current?.primary ?? false, updatedAt: new Date().toISOString() };
      if (requestedMain === true) next.hidden = false;
      await persistMetadata(next);
      const updated = requestedMain === true ? await choose(slug) : await reconcile();
      // Just written, so the reload has it.
      const saved = updated.find((bot) => bot.slug === slug)!;
      await onBotChanged(saved);
      return saved;
    }),
    remove: (slug: string) => exclusive(async () => {
      directory(slug);
      const bots = await reconcile();
      const current = bots.find((bot) => bot.slug === slug);
      if (!current) throw failure("Bot not found", 404);
      // Its folder is the user's project: it is never moved to the trash.
      if (current.adopted) throw failure("This Bot was made from a project. Turn it back into a plain project instead.");
      if (current.primary && bots.length > 1) throw failure("Choose another main Bot before deleting this Bot.");
      const trash = path.join(botsRoot, ".botapp", "trash");
      await fs.mkdir(trash, { recursive: true });
      metadataCache.clear();
      await fs.rename(directory(slug), path.join(trash, `${slug}-${Date.now()}`));
      return reconcile();
    }),
    /**
     * Turns an adopted Bot back into a plain project: `undo` takes its files away and unregisters it,
     * while no other change to the Bots can run.
     */
    release: (slug: string, undo: (bot: Bot) => Promise<unknown>) => exclusive(async () => {
      directory(slug);
      const bots = await reconcile();
      const current = bots.find((bot) => bot.slug === slug);
      if (!current) throw failure("Bot not found", 404);
      if (!current.adopted) throw failure("Only a Bot made from a project can be turned back into one.");
      if (current.primary && bots.length > 1) throw failure("Choose another main Bot first.");
      metadataCache.clear();
      await undo(current);
      return reconcile();
    }),
  };
}
