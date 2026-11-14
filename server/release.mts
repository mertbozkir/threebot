// Installed Threebot lives in $THREEBOT_HOME/runtime, laid out like T3 Code's: one folder per
// version, a `current` link the service runs, and the version before it kept for a rollback.
// Releases are GitHub release assets checked against the release's SHA256SUMS.
import { createHash } from "node:crypto";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO = "RokaSwK/threebot";

export type Channel = "stable" | "preview";
type Reply<Body> = ({ ok: true; status: number } & Body) | { ok: false; status: number };
/** The parts of `fetch` this file uses, so a mirror or a test can stand in for it. */
export type FetchJson = (url: string, init?: RequestInit) => Promise<Reply<{ json(): Promise<unknown> }>>;
export type FetchBytes = (url: string, init?: RequestInit) => Promise<Reply<{ arrayBuffer(): Promise<ArrayBuffer> }>>;
/** The fields of a GitHub release (from the releases API) this file reads. */
interface GitHubRelease {
  tag_name: string;
  draft?: boolean;
  prerelease?: boolean;
  body?: string | null;
  html_url?: string | null;
  published_at?: string | null;
  assets?: { name: string; browser_download_url: string }[];
}
/** A release found by findRelease: its version, download links and what GitHub says about it. */
export interface Release {
  version: string;
  archive: string;
  sums: string;
  notes: string;
  url: string;
  publishedAt: string | null;
}

export const packageRoot = path.resolve(here, "..");
export function currentVersion(root: string = packageRoot): string {
  // server/package.json carries the same version (pack-release writes both), for when only server/ is readable.
  for (const file of [path.join(root, "package.json"), path.join(root, "server", "package.json")]) {
    try { const version = JSON.parse(readFileSync(file, "utf8")).version; if (version) return version; } catch {}
  }
  return "0.0.0";
}

export function homeDir(env = process.env) {
  return env.THREEBOT_HOME || path.join(homedir(), ".threebot");
}
export function runtimePaths(home: string = homeDir()) {
  const runtime = path.join(home, "runtime");
  return { home, runtime, versions: path.join(runtime, "versions"), current: path.join(runtime, "current"), previous: path.join(runtime, "previous") };
}

/** True when this copy runs from an installed runtime, so it can update itself. */
export function installedRuntime(root: string = packageRoot, home: string = homeDir()): boolean {
  // Compare real paths: Node resolves the running file's links (/tmp is /private/tmp on macOS).
  const real = (p: string) => { try { return realpathSync(p); } catch { return path.resolve(p); } };
  return path.dirname(real(root)) === real(runtimePaths(home).versions);
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
export function compareVersions(a: string, b: string): number {
  const x = SEMVER.exec(String(a).replace(/^v/, "")), y = SEMVER.exec(String(b).replace(/^v/, ""));
  if (!x || !y) throw new Error(`Not a version: ${!x ? a : b}`);
  for (let i = 1; i <= 3; i++) if (Number(x[i]) !== Number(y[i])) return Number(x[i]) - Number(y[i]);
  // 1.0.0-preview.1 comes before 1.0.0.
  if (!x[4] || !y[4]) return x[4] ? -1 : y[4] ? 1 : 0;
  return x[4].localeCompare(y[4], "en", { numeric: true });
}

export const assetName = (version: string) => `threebot-${version}.tar.gz`;

/** GitHub's newest releases, drafts left out. THREEBOT_RELEASES_URL points at a GitHub-API-shaped list (for mirrors and tests). */
async function listReleases({ env = process.env, fetchImpl = fetch }: { env?: NodeJS.ProcessEnv; fetchImpl?: FetchJson } = {}): Promise<GitHubRelease[]> {
  const api = env.THREEBOT_RELEASES_URL || `https://api.github.com/repos/${REPO}/releases?per_page=30`;
  const res = await fetchImpl(api, { headers: { accept: "application/vnd.github+json", "user-agent": "threebot-updater" } });
  if (!res.ok) throw new Error(`Couldn't list releases (HTTP ${res.status})`);
  const list = await res.json();
  return Array.isArray(list) ? (list as GitHubRelease[]).filter((r) => r && typeof r.tag_name === "string" && !r.draft) : [];
}

const releaseUrl = (r: GitHubRelease) => r.html_url ?? `https://github.com/${REPO}/releases/tag/v${r.tag_name.replace(/^v/, "")}`;

/** Pick the release to install from a listing: the newest on the channel, or an exact version. THREEBOT_RELEASE_BASE_URL swaps the download host. */
function pickRelease(all: GitHubRelease[], { version, channel = "stable", env = process.env }: { version?: string; channel?: Channel; env?: NodeJS.ProcessEnv }): Release | null {
  const releases = all.filter((r) => channel === "preview" || !r.prerelease);
  const wanted = version ? releases.find((r) => r.tag_name.replace(/^v/, "") === String(version).replace(/^v/, "")) : releases
    .filter((r) => SEMVER.test(r.tag_name.replace(/^v/, "")))
    .sort((a, b) => compareVersions(b.tag_name, a.tag_name))[0];
  if (!wanted) return null;
  const v = wanted.tag_name.replace(/^v/, "");
  const base = env.THREEBOT_RELEASE_BASE_URL ? `${env.THREEBOT_RELEASE_BASE_URL.replace(/\/$/, "")}/v${v}` : null;
  const asset = (name: string) => base ? `${base}/${name}` : wanted.assets?.find((a) => a.name === name)?.browser_download_url;
  const archive = asset(assetName(v)), sums = asset("SHA256SUMS");
  if (!archive || !sums) return null;
  return { version: v, archive, sums, notes: wanted.body ?? "", url: releaseUrl(wanted), publishedAt: wanted.published_at ?? null };
}

/** The release to install: the newest stable one, or an exact version. */
export async function findRelease({ version, channel = "stable", env = process.env, fetchImpl = fetch }: { version?: string; channel?: Channel; env?: NodeJS.ProcessEnv; fetchImpl?: FetchJson } = {}): Promise<Release | null> {
  return pickRelease(await listReleases({ env, fetchImpl }), { version, channel, env });
}

export function expectedSum(sumsText: string, name: string): string | null {
  for (const line of String(sumsText).split("\n")) {
    const m = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
    if (m && m[2].trim() === name) return m[1].toLowerCase();
  }
  return null;
}

async function download(url: string, fetchImpl: FetchBytes): Promise<Buffer> {
  const res = await fetchImpl(url, { headers: { "user-agent": "threebot-updater" }, redirect: "follow" });
  if (!res.ok) throw new Error(`Download failed: ${url} (HTTP ${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

/** What run() rejects with when the command fails: its exit code and output come along. */
export type RunError = Error & { code?: number | string | null; stdout?: string; stderr?: string };
export function run(command: string, args: string[], options: SpawnOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
    let out = "", err = "";
    child.stdout?.on("data", (d) => { out += d; });
    child.stderr?.on("data", (d) => { err += d; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(out) : reject(Object.assign(new Error(`${command} ${args.join(" ")} failed (${code}): ${(err || out).trim().slice(-800)}`), { code, stdout: out, stderr: err })));
  });
}

/** Download, verify and unpack a release into versions/<version>, with its server dependencies installed. */
export async function installRelease(release: Pick<Release, "version" | "archive" | "sums">, { home = homeDir(), fetchImpl = fetch, log = () => {}, npm = "npm" }: { home?: string; fetchImpl?: FetchBytes; log?: (line: string) => void; npm?: string } = {}): Promise<string> {
  const paths = runtimePaths(home);
  const target = path.join(paths.versions, release.version);
  if (existsSync(path.join(target, ".install-complete"))) return target;
  await fs.mkdir(paths.versions, { recursive: true });
  log(`Downloading Threebot ${release.version}`);
  const [archive, sums] = await Promise.all([download(release.archive, fetchImpl), download(release.sums, fetchImpl)]);
  const expected = expectedSum(sums.toString("utf8"), assetName(release.version));
  if (!expected) throw new Error(`SHA256SUMS has no entry for ${assetName(release.version)}`);
  const actual = createHash("sha256").update(archive).digest("hex");
  if (actual !== expected) throw new Error(`Checksum mismatch for ${assetName(release.version)}: expected ${expected}, got ${actual}`);
  log(`Checksum OK (${actual.slice(0, 12)}…)`);
  const staging = await fs.mkdtemp(path.join(paths.versions, ".staging-"));
  try {
    const file = path.join(staging, assetName(release.version));
    await fs.writeFile(file, archive);
    await run("tar", ["-xzf", file, "-C", staging, "--strip-components=1"]);
    await fs.rm(file);
    const unpacked = currentVersion(staging);
    if (unpacked !== release.version) throw new Error(`The archive holds version ${unpacked}, not ${release.version}`);
    log("Installing server dependencies");
    await run(npm, ["ci", "--omit=dev", "--no-audit", "--no-fund"], { cwd: path.join(staging, "server") });
    await fs.writeFile(path.join(staging, ".install-complete"), new Date().toISOString() + "\n");
    await fs.rm(target, { recursive: true, force: true });
    await fs.rename(staging, target);
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true });
    throw error;
  }
  return target;
}

/**
 * logs/update.log. Every update writes its steps here, each line with the time, whoever started it:
 * `threebot update` in a terminal, Settings → Updates, or the automatic update. `print` also shows the
 * line (the terminal); pass null to only write it down.
 */
export const updateLogFile = (home: string = homeDir()) => path.join(home, "logs", "update.log");
export function updateLogger(home: string = homeDir(), { print = (line: string) => void process.stdout.write(line + "\n"), now = () => new Date() }: { print?: ((line: string) => void) | null; now?: () => Date } = {}) {
  const file = updateLogFile(home);
  return (line: string) => {
    print?.(line);
    // Written at once, so a line is down even when the process exits right after.
    try { mkdirSync(path.dirname(file), { recursive: true }); appendFileSync(file, `${now().toISOString()} ${line}\n`); } catch {}
  };
}

/**
 * Start `threebot update --yes <version>` in the background, the way Settings → Updates and the automatic
 * update do. It writes update.log itself (see updateLogger): on Linux systemd-run runs it with no
 * output of ours to write to, because systemd stops every process in the service's cgroup on restart,
 * so the updater has to run outside it. systemd-run also starts it with a clean environment, so pass
 * on what the updater needs.
 */
export function startUpdater(version: string, { preview = false, cli = path.join(here, "cli.mjs"), env = process.env, platform = process.platform }: { preview?: boolean; cli?: string; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {}): ChildProcess {
  const args = [process.execPath, cli, "update", "--yes", ...(preview ? ["--preview"] : []), version];
  const keep = ["PATH", "HOME", "THREEBOT_HOME", "THREEBOT_RELEASES_URL", "THREEBOT_RELEASE_BASE_URL"].filter((k) => env[k]).map((k) => `--setenv=${k}=${env[k]}`);
  const command = platform === "linux" ? ["systemd-run", "--user", "--collect", "--quiet", ...keep, ...args] : args;
  const child = spawn(command[0], command.slice(1), { detached: true, stdio: "ignore", env });
  child.unref();
  return child;
}

async function swapLink(link: string, target: string) {
  const temp = `${link}.${process.pid}.tmp`;
  await fs.rm(temp, { force: true });
  await fs.symlink(target, temp);
  await fs.rename(temp, link); // rename over a link is atomic, so `current` is never missing.
}
export async function readLink(link: string): Promise<string | null> {
  try { return path.resolve(path.dirname(link), await fs.readlink(link)); } catch { return null; }
}

/** Point `current` at a version and remember the one it replaces. Returns that previous folder. */
export async function activate(versionDir: string, home: string = homeDir()): Promise<string | null> {
  const paths = runtimePaths(home);
  await fs.mkdir(paths.runtime, { recursive: true });
  const before = await readLink(paths.current);
  if (before && path.resolve(before) !== path.resolve(versionDir)) await swapLink(paths.previous, before);
  await swapLink(paths.current, versionDir);
  return before;
}

/** Undo the last activate. */
export async function rollback(home: string = homeDir()): Promise<string> {
  const paths = runtimePaths(home);
  const previous = await readLink(paths.previous);
  if (!previous || !existsSync(previous)) throw new Error("There is no earlier version to go back to.");
  await swapLink(paths.current, previous);
  await fs.rm(paths.previous, { force: true });
  return previous;
}

/** Remove versions other than current and previous. */
export async function prune(home: string = homeDir()): Promise<string[]> {
  const paths = runtimePaths(home);
  const keep = new Set([await readLink(paths.current), await readLink(paths.previous)].filter(Boolean).map((p) => path.resolve(p!)));
  const removed: string[] = [];
  for (const name of await fs.readdir(paths.versions).catch(() => [])) {
    const dir = path.resolve(paths.versions, name);
    if (keep.has(dir)) continue;
    await fs.rm(dir, { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

export const channelFor = (version: string): Channel => String(version).includes("-") ? "preview" : "stable";

/**
 * What the app shows in Settings → Updates, and the footer's update button. The answer is stored and
 * reused until it is `ttlMs` old, so any number of tabs costs one GitHub call per period; concurrent
 * callers share one request. A failed check keeps the last good answer and waits longer each time
 * (up to `maxBackoffMs`) before trying again. A preview install follows previews.
 */
/** A release as the app shows it. `notes` is the raw release body, which the app parses as untrusted text. */
export interface ReleaseInfo { version: string; url: string; notes: string; publishedAt: string | null }
// Enough for the full changelog of a big release; the app shows at most 100 of its changes.
const MAX_NOTES = 60_000;
const releaseInfo = (r: { version: string; url: string; notes: string; publishedAt: string | null }): ReleaseInfo => ({ version: r.version, url: r.url, notes: r.notes.slice(0, MAX_NOTES), publishedAt: r.publishedAt });
export interface UpdateStatus {
  latest: ReleaseInfo | null;
  /** The release this copy runs, for "what changed" after an update. Null when GitHub doesn't list it (a dev build). */
  current: ReleaseInfo | null;
  updateAvailable: boolean;
  error: string | null;
  checkedAt: string | null;
}
export function createUpdateChecker({ env = process.env, fetchImpl = fetch, ttlMs = 15 * 60 * 1000, maxBackoffMs = 2 * 60 * 60 * 1000, version = currentVersion(), now = Date.now }: { env?: NodeJS.ProcessEnv; fetchImpl?: FetchJson; ttlMs?: number; maxBackoffMs?: number; version?: string; now?: () => number } = {}) {
  const channel = channelFor(version);
  let value: UpdateStatus = { latest: null, current: null, updateAvailable: false, error: null, checkedAt: null };
  let nextAt = 0, failures = 0, inflight: Promise<UpdateStatus> | null = null;
  const refresh = async (): Promise<UpdateStatus> => {
    const at = now();
    try {
      const all = await listReleases({ env, fetchImpl });
      const latest = pickRelease(all, { channel, env });
      // The running release needs no download links, only its notes.
      const mine = all.find((r) => r.tag_name.replace(/^v/, "") === version);
      const current = mine ? releaseInfo({ version, url: releaseUrl(mine), notes: mine.body ?? "", publishedAt: mine.published_at ?? null }) : null;
      value = { latest: latest && releaseInfo(latest), current, updateAvailable: Boolean(latest && compareVersions(latest.version, version) > 0), error: null, checkedAt: new Date(at).toISOString() };
      failures = 0;
      nextAt = at + ttlMs;
    } catch (error) {
      value = { ...value, error: error instanceof Error ? error.message : String(error), checkedAt: new Date(at).toISOString() };
      nextAt = at + Math.min(ttlMs * 2 ** failures++, maxBackoffMs);
    }
    return value;
  };
  return async function check({ force = false }: { force?: boolean } = {}): Promise<UpdateStatus> {
    if (!force && now() < nextAt) return value;
    return inflight ??= refresh().finally(() => { inflight = null; });
  };
}

/**
 * Keep a checker's stored answer fresh with nobody asking: look now, then every `everyMs`. Each look
 * only reaches GitHub when the checker says a check is due. Returns a function that stops it.
 */
export function startUpdateChecks(check: () => unknown, { everyMs = 60 * 1000 }: { everyMs?: number } = {}): () => void {
  const tick = () => void check();
  tick();
  const timer = setInterval(tick, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
