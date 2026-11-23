import { readdir } from "node:fs/promises";
import { createJsonCache } from "./cached-json.mts";
import path from "node:path";

const caches = new Map<string, ReturnType<typeof createJsonCache>>();

/** Recoverable Bot metadata is enough to render old mentions without reviving a Bot. */
export async function archivedBotIdentities(trashRoot: string) {
  const folders = await readdir(trashRoot, { withFileTypes: true }).catch(() => []);
  let cache = caches.get(trashRoot);
  if (!cache) { cache = createJsonCache(); caches.set(trashRoot, cache); }
  const files = new Set(folders.filter((folder) => folder.isDirectory()).map((folder) => path.join(trashRoot, folder.name, ".bot/bot.json")));
  cache.retain(files);
  const identities = await Promise.all(folders.map(async (folder) => {
    if (!folder.isDirectory()) return null;
    const match = /^([a-z0-9][a-z0-9-]{0,62})-(\d+)$/.exec(folder.name);
    if (!match) return null;
    const workspaceRoot = path.join(trashRoot, folder.name);
    const meta = await cache.read(path.join(workspaceRoot, ".bot/bot.json"), null).catch(() => null);
    if (!meta || typeof meta.mainThreadId !== "string" || typeof meta.name !== "string") return null;
    return {
      slug: match[1], workspaceRoot, name: meta.name, label: typeof meta.label === "string" ? meta.label : "",
      shape: typeof meta.shape === "string" ? meta.shape : "blob", color: typeof meta.color === "string" ? meta.color : "gray",
      ...(typeof meta.avatarImage === "string" ? { avatarImage: meta.avatarImage } : {}),
      section: null, pinned: false, hidden: true, primary: false, creator: false, notifications: false,
      projectId: typeof meta.projectId === "string" ? meta.projectId : null, mainThreadId: meta.mainThreadId,
      createdAt: typeof meta.createdAt === "string" ? meta.createdAt : new Date(Number(match[2])).toISOString(),
    };
  }));
  return identities.filter((identity) => identity !== null);
}
