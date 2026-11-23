import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

/** Recoverable Bot metadata is enough to render old mentions without reviving a Bot. */
export async function archivedBotIdentities(trashRoot: string) {
  const folders = await readdir(trashRoot, { withFileTypes: true }).catch(() => []);
  const identities = [];
  for (const folder of folders) {
    if (!folder.isDirectory()) continue;
    const match = /^([a-z0-9][a-z0-9-]{0,62})-(\d+)$/.exec(folder.name);
    if (!match) continue;
    const workspaceRoot = path.join(trashRoot, folder.name);
    const meta = await readFile(path.join(workspaceRoot, ".bot/bot.json"), "utf8").then(JSON.parse).catch(() => null);
    if (!meta || typeof meta.mainThreadId !== "string" || typeof meta.name !== "string") continue;
    identities.push({
      slug: match[1], workspaceRoot, name: meta.name, label: typeof meta.label === "string" ? meta.label : "",
      shape: typeof meta.shape === "string" ? meta.shape : "blob", color: typeof meta.color === "string" ? meta.color : "gray",
      ...(typeof meta.avatarImage === "string" ? { avatarImage: meta.avatarImage } : {}),
      section: null, pinned: false, hidden: true, primary: false, creator: false, notifications: false,
      projectId: typeof meta.projectId === "string" ? meta.projectId : null, mainThreadId: meta.mainThreadId,
      createdAt: typeof meta.createdAt === "string" ? meta.createdAt : new Date(Number(match[2])).toISOString(),
    });
  }
  return identities;
}
