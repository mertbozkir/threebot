// Beta features: experimental parts of the app, each switched on or off in Settings → Beta.
// The switches live in settings.json under `beta`, because they change what Bots get.

import fs from "node:fs/promises";

/** The beta switches, each one on or off. */
export type BetaSettings = { projects: boolean; desktop: boolean };
/** Saved switches as read from settings.json: anything, until `betaSettings` cleans it up. */
export type SavedBeta = { readonly [key: string]: unknown } | null | undefined;
/** settings.json as saved, with the `beta` switches somewhere inside. */
export type SavedSettings = { beta?: SavedBeta; [key: string]: unknown };

export const BETA_DEFAULTS: Readonly<BetaSettings> = Object.freeze({ projects: false, desktop: false });

/** The saved switches with defaults filled in. Unknown keys and non-booleans are dropped. */
export function betaSettings(saved: SavedBeta): BetaSettings {
  const out: BetaSettings = { ...BETA_DEFAULTS };
  for (const key of Object.keys(BETA_DEFAULTS) as (keyof BetaSettings)[]) if (typeof saved?.[key] === "boolean") out[key] = saved[key];
  return out;
}

/** Merge a patch from the app into the current switches; anything but a known key with a boolean is refused. */
export function patchBeta(current: SavedBeta, patch: unknown): BetaSettings {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw Object.assign(new Error("beta must be an object"), { status: 400 });
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in BETA_DEFAULTS)) throw Object.assign(new Error(`Unknown beta feature: ${key}`), { status: 400 });
    if (typeof value !== "boolean") throw Object.assign(new Error(`beta.${key} must be true or false`), { status: 400 });
  }
  return { ...betaSettings(current), ...patch };
}

/** True when a Projects board file exists with at least one item. A file that can't be parsed but isn't empty counts, so a damaged board isn't hidden. */
export async function boardHasItems(file: string): Promise<boolean> {
  let text: string;
  try { text = await fs.readFile(file, "utf8"); } catch { return false; }
  try {
    const raw = JSON.parse(text);
    return !!raw?.items && typeof raw.items === "object" && Object.keys(raw.items).length > 0;
  } catch {
    return text.trim().length > 0;
  }
}

/**
 * Settings saved before the Beta tab existed have no `beta.projects`. Installs that already use the board
 * keep it on; new installs start with it off. Returns the settings to save, or null when nothing changes.
 * It is saved once, so emptying the board later doesn't switch it off.
 */
export async function settleBetaDefaults(saved: SavedSettings | null | undefined, { projectsFile }: { projectsFile: string }): Promise<(SavedSettings & { beta: BetaSettings }) | null> {
  if (typeof saved?.beta?.projects === "boolean") return null;
  return { ...(saved ?? {}), beta: { ...betaSettings(saved?.beta), projects: await boardHasItems(projectsFile) } };
}
