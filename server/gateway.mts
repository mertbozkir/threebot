// Bot gateway: serves the web app, guards it with a password, proxies T3 Code,
// and reads/writes the small JSON files that describe Bots. No database.
import { createCloudTranscription, MAX_AUDIO_BYTES, relayLiveDictation } from "./cloud-transcription.mts";
import http, { type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { promises as fs, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { renderAgentsMd, mergeManaged, type TemplateSettings } from "./bot-template.mts";
import { memorySignature, readMemoryFiles, readSnapshot, saveMemoryFile, writeTextAtomic, type MemorySnapshot } from "./memory.mts";
import { tokenForBot, tokenMatches } from "./bot-token.mts";
import { createSiteIcons, normalizeDomain } from "./site-icons.mts";
import { startProvisioner } from "./provisioner.mts";
import { archivedBotIdentities } from "./bot-identities.mts";
import { createMainBotRegistry, type Bot, type BotPatch } from "./main-bot.mts";
import {
  CLAUDE_FILE, CODEX_FILE, CONFIG_FILES, LOCAL_ENVIRONMENT, archiveAdoptedData, excludePatterns, gitRepo, mergeJsonFile, planAdoption,
  projectAgentsMd, readAdopted, registerAdopted, samePath, undoAdoptionFiles, unregisterAdopted, updateAdopted, withProjectAgents, within,
  writeExcludeBlock, type AdoptedBot, type AdoptedFile,
} from "./adopted-bots.mts";
import { createHash } from "node:crypto";
import { createEnvironmentRouter, environmentPath, type EnvironmentTarget } from "./environment-routes.mts";
import { createThreadLinkResolver } from "./thread-link.mts";
import { createMachines, pairedRoutesFile, readRoutes, type Machine, type PeerLink } from "./machines.mts";
import { createOutageAlerts, remoteThreads, type BotWork } from "./machine-alerts.mts";
import { createT3Mcp, T3ToolError } from "./t3-mcp.mts";
import type { CodingWork } from "./bot-template.mts";
import { accessTokenFrom, createAccessVerifier } from "./access.mts";
import { createVault } from "./vault.mts";
import { createBotTools, handleMcpHttp, type ExtraTools, type McpAuth } from "./vault-mcp.mts";
import { T3Client } from "./t3rpc.mts";
import { executorConfiguration, executorMcpDefinition, publicExecutorConfiguration, type ExecutorProfile } from "./executor-config.mts";
import { createExecutorClient } from "./executor-client.mts";
import { createThreadMeta, createThreadPreviews } from "./thread-meta.mts";
import { createRoutineHistoryRoutes } from "./routine-history.mts";
import { createPushNotifier, createPushStore, type PushPayload } from "./push.mts";
import { objectAvatarPatch } from "./object-avatars.mts";
import { avatarColorPatch } from "./avatar-color.mts";
import { allowedOrigins, sameOriginRequest } from "./request-origin.mts";
import { safeEqual } from "./safe-equal.mts";
import { createAccessStore, createRemoteAccess } from "./remote-access.mts";
import { channelFor, createUpdateChecker, currentVersion, installedRuntime, runtimePaths, startUpdateChecks, startUpdater, updateLogger } from "./release.mts";
import { botThreads, busyBotThreads, createAutoUpdateStore, createAutoUpdater, versionInstalled, type BotThread } from "./auto-update.mts";
import { exposureConfig, landingPath, onTailnet, tailnetUserAllowed } from "./exposure.mts";
import { createProjects } from "./projects.mts";
import { PROJECT_TOOLS, createProjectTools } from "./projects-mcp.mts";
import { createProjectRoutes } from "./projects-routes.mts";
import { BETA_DEFAULTS, betaSettings, patchBeta, settleBetaDefaults } from "./beta.mts";
import { aggregateTurnUsage, createTelemetry, MIN_T3_FOR_TOKENS, versionAtLeast, type PayloadInput } from "./telemetry.mts";
import { AVATAR_BODY_LIMIT, avatarImagePatch, decodeAvatarImage, storeAvatarImage, readAvatarImage } from "./avatar-images.mts";

/** What route handlers and helpers throw: an Error, optionally with the HTTP status and a code to show. */
type HttpError = Error & { status?: number; code?: string };
/** A browser tab as T3's preview.list reports it; only the fields used here. */
type PreviewSession = { runtime?: string; tabId: string; navStatus?: { url?: string; title?: string } };
/** A new Bot as the app posts it. objectAvatarPatch and decodeAvatarImage check the avatar fields. */
type NewBot = {
  name?: string; label?: string; shape?: string; color?: string; avatarDefinition?: unknown; avatarImage?: unknown;
  section?: string | null; pinned?: unknown; primary?: unknown; model?: unknown; [key: string]: unknown;
};
type McpServer = { type: string; url: string | undefined; headers: Record<string, string> };

const here = path.dirname(fileURLToPath(import.meta.url));
const resolveThreadLink = createThreadLinkResolver();
const dataRoot = process.env.THREEBOT_HOME ?? path.join(homedir(), ".threebot");
const cfg: {
  port: number; host: string; t3Url: string; botsRoot: string; staticDir: string; password: string;
  vaultFile: string; vaultKeyFile: string; t3SecretsDir: string; botMcpUrl?: string;
} = {
  port: Number(process.env.PORT ?? 3780),
  host: process.env.HOST ?? "127.0.0.1",
  t3Url: (process.env.T3_URL ?? "http://127.0.0.1:3773").replace(/\/$/, ""),
  botsRoot: process.env.BOTS_ROOT ?? path.join(dataRoot, "bots"),
  staticDir: process.env.STATIC_DIR ?? path.join(here, "..", "web", "dist"),
  password: process.env.BOT_PASSWORD ?? "",
  vaultFile: process.env.VAULT_FILE ?? path.join(dataRoot, "vault.enc"),
  vaultKeyFile: process.env.VAULT_KEY_FILE ?? path.join(dataRoot, ".vault-key"),
  // Where T3's request_secret (delivery "file") leaves values; vault_save_login moves them into the Vault.
  t3SecretsDir: process.env.T3_SECRETS_DIR ?? path.join(homedir(), ".t3", "userdata", "secrets", "files"),
};
const executorConfig = executorConfiguration();
// Bots reach their own tool server (the Vault) here, from this machine only.
cfg.botMcpUrl = (process.env.BOT_MCP_URL ?? `http://127.0.0.1:${cfg.port}/mcp/bot`).replace(/\/$/, "");
const token = (process.env.T3_TOKEN ?? readIfExists(process.env.T3_TOKEN_FILE ?? path.join(here, ".t3-token")) ?? "").trim();
if (!token) {
  console.error("No T3 token: set T3_TOKEN or T3_TOKEN_FILE");
  process.exit(1);
}
const appDir = path.join(cfg.botsRoot, ".botapp");
await fs.mkdir(appDir, { recursive: true });
// Direct routes to other machines: T3_ENVIRONMENTS_FILE wins over the ones paired in Settings → Machines.
const routeFiles = [process.env.T3_ENVIRONMENTS_FILE, pairedRoutesFile(appDir)];
const resolveEnvironment = createEnvironmentRouter({ local: { baseUrl: cfg.t3Url, token }, file: routeFiles });
const pushStore = createPushStore({ file: path.join(appDir, "push.json") });
const secretPath = path.join(appDir, "session-secret");
if (!existsSync(secretPath)) await fs.writeFile(secretPath, randomBytes(32).toString("hex"), { mode: 0o600 });
let sessionSecret = readFileSync(secretPath, "utf8").trim();
/** A new password signs everyone out: sessions from before it stop working. */
async function rotateSessionSecret() {
  sessionSecret = randomBytes(32).toString("hex");
  await fs.writeFile(secretPath, sessionSecret, { mode: 0o600 });
}
// Bearer for the Bots' tool server: BOT_MCP_TOKEN, or a random one kept next to the vault key.
const botMcpTokenPath = path.join(path.dirname(cfg.vaultKeyFile), ".bot-mcp-token");
let botMcpToken = (process.env.BOT_MCP_TOKEN ?? readIfExists(botMcpTokenPath) ?? "").trim();
if (!botMcpToken) {
  botMcpToken = randomBytes(32).toString("hex");
  await fs.mkdir(path.dirname(botMcpTokenPath), { recursive: true });
  await fs.writeFile(botMcpTokenPath, botMcpToken + "\n", { mode: 0o600 });
}
const vault = createVault({ file: cfg.vaultFile, keyFile: cfg.vaultKeyFile });
const cloudTranscription = createCloudTranscription({ file: path.join(path.dirname(cfg.vaultKeyFile), "transcription.json"), keyFile: cfg.vaultKeyFile });
// The Projects board, shared by the user and every Bot. APP_URL makes the links Bots share absolute.
const projectsFile = path.join(appDir, "projects.json");
const projects = createProjects({ file: projectsFile });
const appUrl = (process.env.APP_URL ?? "").replace(/\/$/, "");
const routineHistoryRoutes = createRoutineHistoryRoutes({ rpc: t3rpc, file: path.join(appDir, "routine-history.json") });
const threadMeta = createThreadMeta({ file: path.join(appDir, "thread-meta.json") });
const threadPreviews = createThreadPreviews({
  projection: async (threadId) => withTimeout((await withTimeout(t3rpc(), 10000, "T3 timed out")).call("orchestration.getThreadProjection", { threadId }), 15000, "T3 timed out"),
  nameFor: async () => {
    const names = new Map((await listBots()).map((bot) => [bot.mainThreadId, bot.name]));
    return (threadId) => names.get(threadId) ?? null;
  },
});

function readIfExists(p: string): string | null {
  try { return readFileSync(p, "utf8"); } catch { return null; }
}

// ---------- auth ----------
const COOKIE = "bot_session";
function sign(value: string) {
  return createHmac("sha256", sessionSecret).update(value).digest("hex");
}
function makeSession() {
  const exp = Date.now() + 30 * 24 * 3600 * 1000;
  const v = `v1.${exp}`;
  return `${v}.${sign(v)}`;
}
function validSession(raw: string | undefined) {
  if (!raw) return false;
  const i = raw.lastIndexOf(".");
  const v = raw.slice(0, i), sig = raw.slice(i + 1);
  const expected = sign(v);
  if (!safeEqual(sig, expected)) return false;
  return Number(v.split(".")[1]) > Date.now();
}
function cookies(req: IncomingMessage) {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k) out[k] = decodeURIComponent(rest.join("="));
  }
  return out;
}
// Login attempts per client: 5 failures lock that client out for 15 minutes.
const attempts = new Map<string, { count: number; last: number }>();
function clientIp(req: IncomingMessage) {
  // The last hop is the one our proxy (Tailscale Funnel) added; earlier entries come from the client.
  return String(req.headers["x-forwarded-for"] ?? "").split(",").pop()!.trim() || req.socket.remoteAddress || "?";
}
function loginBlocked(ip: string) {
  const a = attempts.get(ip);
  return Boolean(a && a.count >= 5 && Date.now() - a.last < 15 * 60 * 1000);
}
function loginFailed(ip: string) {
  const a = attempts.get(ip);
  const fresh = !a || Date.now() - a.last > 15 * 60 * 1000;
  attempts.set(ip, { count: fresh ? 1 : a.count + 1, last: Date.now() });
}
function isHttps(req: IncomingMessage) {
  return req.headers["x-forwarded-proto"] === "https";
}

// Requests that came through Cloudflare Access with a valid token for an allowed email skip the password.
const accessEmails = (process.env.CF_ACCESS_EMAILS ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
const verifyAccess = createAccessVerifier({
  teamDomain: process.env.CF_ACCESS_TEAM_DOMAIN,
  aud: process.env.CF_ACCESS_AUD,
  emails: accessEmails,
});

const originPolicy = { allowed: allowedOrigins(), allowLoopback: !verifyAccess };
const exposure = exposureConfig();
const envTailnet = exposure.tailnetPort > 0;
const version = currentVersion();
const checkUpdates = createUpdateChecker({ version });
const selfUpdating = installedRuntime() && process.env.THREEBOT_SERVICE === "1";
let tailnetServer: http.Server | null = null;
// Open WebSockets outlive the cookie or listener that let them in, so access changes close them.
// Upgrade requests arrive on the server's TCP sockets, so these are net.Sockets (closeTailnet reads localPort).
const upgraded = new Set<Socket>();
function dropUpgraded(match: (socket: Socket) => boolean = () => true) {
  for (const socket of upgraded) if (match(socket)) socket.destroy();
}
async function openTailnet(port: number, users: string[]) {
  // This port trusts the Tailscale-User-Login header, so only a local `tailscale serve` may reach it.
  if (!users.length) throw new Error("The Tailscale listener needs at least one allowed user");
  exposure.tailnetUsers = new Set(users.map((user) => String(user).toLowerCase()));
  if (tailnetServer && exposure.tailnetPort === port) return;
  await closeTailnet();
  const listener = http.createServer((req, res) => server.emit("request", req, res));
  listener.on("upgrade", (req, socket, head) => server.emit("upgrade", req, socket, head));
  await new Promise<void>((resolve, reject) => { listener.once("error", reject); listener.listen(port, "127.0.0.1", resolve); });
  tailnetServer = listener;
  exposure.tailnetPort = port;
  console.log(`tailnet listener on 127.0.0.1:${port}`);
}
async function closeTailnet() {
  const listener = tailnetServer, port = exposure.tailnetPort;
  tailnetServer = null;
  exposure.tailnetPort = 0;
  if (!listener) return;
  // closeAllConnections leaves upgraded sockets alone, and close() waits for them.
  dropUpgraded((socket) => socket.localPort === port);
  await new Promise<void>((resolve) => { listener.close(() => resolve()); listener.closeAllConnections?.(); });
}
const remoteAccess = createRemoteAccess({
  store: createAccessStore(path.join(appDir, "access.json")),
  home: dataRoot, localPort: cfg.port, urlFile: path.join(appDir, "tunnel-url"), exposure, envPassword: cfg.password, envTailnet, openTailnet, closeTailnet,
});
let updating: { version: string; startedAt: number } | null = null;
/**
 * Settings → Updates, and the automatic update: hand the update to `threebot update`, which swaps versions
 * and restarts this service. The automatic update passes the `target` it decided on, and `onExit` to hear
 * about an updater that ended while this gateway still runs (macOS: on Linux systemd-run returns at once).
 */
async function startSelfUpdate({ target, onExit }: { target?: string; onExit?: (version: string, code: number | null) => void } = {}) {
  if (!selfUpdating) {
    throw Object.assign(new Error("This copy can't update itself. Install Threebot with the installer and run it as a service, or update it with `git pull` and `npm run setup`."), { status: 409 });
  }
  const { updateAvailable, latest, error } = target ? { updateAvailable: true, latest: { version: target } } : await checkUpdates({ force: true });
  if (error) throw Object.assign(new Error(error), { status: 502 });
  if (!updateAvailable) return { started: false, version };
  // An available update always names its release.
  if (updating) return { started: true, version: latest!.version };
  const child = startUpdater(latest!.version, { preview: channelFor(version) === "preview" });
  updating = { version: latest!.version, startedAt: Date.now() };
  child.on("exit", (code) => { updating = null; if (process.platform !== "linux") onExit?.(latest!.version, code); });
  return { started: true, version: latest!.version };
}

/** The first item of a T3 subscription (its snapshot), then the subscription ends. */
async function firstOf<T>(tag: string, payload: object, pick: (event: any) => T | undefined): Promise<T> {
  const client = await withTimeout(t3rpc(), 10000, "T3 timed out");
  let stream: ReturnType<T3Client["stream"]> | undefined;
  return withTimeout(new Promise<T>((resolve, reject) => {
    stream = client.stream(tag, payload, (event) => { const value = pick(event); if (value !== undefined) resolve(value); });
    stream!.done.then(() => reject(new Error(`T3 ended ${tag}`)), reject);
  }), 15000, "T3 timed out").finally(() => { try { stream?.cancel(); } catch {} });
}
const shellThreads = (omitIdleSubagents = true) => firstOf<(BotThread & { updatedAt?: string | null })[]>("orchestration.subscribeShell", { omitIdleSubagents }, (event) => event.kind === "snapshot" ? event.snapshot?.threads ?? [] : undefined);
/** The Bot threads a restart would interrupt, from one look at T3's thread list. */
async function busyThreads() {
  return busyBotThreads(await shellThreads(), await listBots());
}
const updateLog = updateLogger(dataRoot, { print: null });
const autoUpdate = createAutoUpdater({
  store: createAutoUpdateStore(path.join(appDir, "auto-update.json")),
  // Its lines go to gateway.log and, with the updater's own, to logs/update.log.
  version, isBusy: busyThreads, installed: versionInstalled(runtimePaths(dataRoot).versions), log: (line) => { console.log(line); updateLog(line); },
  install: async (target) => {
    await startSelfUpdate({ target, onExit: (v, code) => void autoUpdate.failed(v, new Error(`the updater exited (${code}) without switching`)) });
  },
});
// Settings → Usage stats: off until the user says yes. One ping a day at most, from here, never the browser.
const telemetry = createTelemetry({ file: path.join(appDir, "telemetry.json"), collect: collectUsageStats, log: (line) => console.log(line) });
/** This install's numbers for a usage-stats ping. Anything T3 can't answer is left out rather than failing the ping. */
async function collectUsageStats({ since, until }: { since: number; until: number }): Promise<PayloadInput> {
  const [settings, bots, auto] = await Promise.all([getSettings(), listBots(), autoUpdate.status()]);
  const projectIds = new Set<string | null | undefined>(bots.map((bot) => bot.projectId).filter(Boolean));
  const mainThreads = new Set<string | null | undefined>(bots.map((bot) => bot.mainThreadId).filter(Boolean));
  const quietly = <T,>(promise: Promise<T>): Promise<T | null> => promise.catch(() => null);
  const [config, tasks, threads] = await Promise.all([
    quietly(withTimeout(t3rpc(), 10000, "T3 timed out").then((client) => withTimeout(client.call("server.getConfig", {}), 15000, "T3 timed out"))),
    quietly(firstOf<{ projectId?: string | null; threadId?: string | null; threadMode?: string }[]>("scheduledTasks.subscribe", {}, (event) => Array.isArray(event.tasks) ? event.tasks : undefined)),
    quietly(shellThreads(false)),
  ]);
  const t3code = typeof config?.environment?.serverVersion === "string" ? config.environment.serverVersion : null;
  const routines = tasks?.filter((task) => projectIds.has(task.projectId) || mainThreads.has(task.threadId)) ?? null;
  // Token counts: the provider turns of Bot threads that changed in the window, read one thread at a time.
  let tokens: PayloadInput["tokens"] = null;
  if (threads) {
    const recent = threads.filter((thread) => (Date.parse(thread.updatedAt ?? "") || until) > since);
    const projections: unknown[] = [];
    const deadline = Date.now() + 60_000;
    for (const thread of botThreads(recent, bots).slice(0, 200)) {
      if (Date.now() > deadline) break;
      const projection = await quietly(withTimeout(t3rpc(), 10000, "T3 timed out").then((client) => withTimeout(client.call("orchestration.getThreadProjection", { threadId: thread.id }), 15000, "T3 timed out")));
      if (projection) projections.push(projection);
    }
    const usage = aggregateTurnUsage(projections as Parameters<typeof aggregateTurnUsage>[0], { since, until });
    if (usage.seen || versionAtLeast(t3code, MIN_T3_FOR_TOKENS)) tokens = usage.models;
  }
  return {
    installId: (await telemetry.status()).installId, threebot: version, t3code, node: process.versions.node, os: process.platform, arch: process.arch,
    bots: bots.length, routines: routines?.length ?? null,
    features: { projects: settings.beta.projects, autoUpdate: auto.auto, freshSessionRoutines: routines?.some((task) => task.threadMode === "fresh_session") ?? false },
    tokens,
  };
}
const passwordRequired = async () => Boolean(cfg.password) || (await remoteAccess.hasPassword());
async function passwordMatches(password: string) {
  if (cfg.password) return safeEqual(password, cfg.password);
  return remoteAccess.verify(password);
}
const publicPortClosed = (req: IncomingMessage) => exposure.landingOnly && !onTailnet(req, exposure);
async function authed(req: IncomingMessage) {
  // Tailscale identity is the only way in on this port, and it counts nowhere else.
  if (onTailnet(req, exposure)) return tailnetUserAllowed(req, exposure);
  const jar = cookies(req);
  if (verifyAccess) {
    const accessToken = accessTokenFrom(req, jar);
    if (accessToken && (await verifyAccess(accessToken))) return true;
  }
  if (await passwordRequired()) return validSession(jar[COOKIE]);
  // No password: Cloudflare Access is the only way in. Without Access configured either, it's an open dev setup.
  return !verifyAccess;
}

// ---------- helpers ----------
function send(res: ServerResponse, status: number, body: unknown, headers: OutgoingHttpHeaders = {}) {
  const isJson = typeof body !== "string" && !Buffer.isBuffer(body);
  res.writeHead(status, { "content-type": isJson ? "application/json" : "text/plain", "x-content-type-options": "nosniff", ...headers });
  res.end(isJson ? JSON.stringify(body) : body);
}
// A request's JSON body, as the client sent it; each route reads the fields it needs.
async function readBody(req: IncomingMessage, limit = 1 << 20): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Object.assign(new Error("body too large"), { status: 413 });
    chunks.push(c);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    // JSON.parse errors quote the input, which may hold a password.
    throw Object.assign(new Error("invalid JSON body"), { status: 400 });
  }
}
/** Vault writes only accept JSON, so a cross-site form can't post to them. */
async function readRaw(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Object.assign(new Error("body too large"), { status: 413 });
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}
function requireJson(req: IncomingMessage) {
  if (!/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) throw Object.assign(new Error("content-type must be application/json"), { status: 415 });
}
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
function slugify(name: string) {
  return name.toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s_]+/g, "-").replace(/-+/g, "-").slice(0, 48) || "bot";
}
// The JSON on disk, as it was written; callers read the fields they need.
async function readJson<T>(p: string, fallback: T): Promise<any> {
  try { return JSON.parse(await fs.readFile(p, "utf8")); } catch { return fallback; }
}
async function writeJson(p: string, data: unknown) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  const tmp = p + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(data, null, 2) + "\n");
  await fs.rename(tmp, p);
}

// ---------- bots & settings ----------
const DEFAULT_SETTINGS = {
  userName: "",
  theme: "dark",
  palette: "amoled",
  accent: "bot",
  timezone: "",
  autoReview: true,
  rules: { alwaysAsk: [], allowWithoutAsking: [] },
  sections: [],
  defaultModel: null,
  avatarDrawingModel: null,
  beta: BETA_DEFAULTS,
  codingWork: null,
};
const settingsPath = path.join(appDir, "settings.json");
// Settings → Beta: decide the Projects board's default once, before anything reads the settings.
// An unreadable settings.json is left alone rather than replaced.
{
  const saved = await readJson(settingsPath, undefined);
  const settled = saved !== undefined || !existsSync(settingsPath) ? await settleBetaDefaults(saved, { projectsFile }) : null;
  if (settled) await writeJson(settingsPath, settled);
}
const siteIcons = createSiteIcons({ dir: path.join(appDir, "site-icons") });
async function getSettings() {
  const saved = (await readJson(settingsPath, {})) ?? {};
  return { ...DEFAULT_SETTINGS, ...saved, beta: betaSettings(saved.beta) };
}
/** The Projects board is a beta feature; off hides its routes, its Bot tools and its AGENTS.md section. */
const projectsOn = async () => (await getSettings()).beta.projects;
function botDir(slug: string) {
  if (!SLUG_RE.test(slug)) throw Object.assign(new Error("bad slug"), { status: 400 });
  return path.join(cfg.botsRoot, slug);
}
const mainBots = createMainBotRegistry({
  botsRoot: cfg.botsRoot,
  onBotChanged: async (bot) => {
    await writeAgentsMd(bot, await getSettings()).catch((error) => console.error("refreshing Bot instructions failed", error));
  },
});
const getBot = (slug: string) => mainBots.get(slug);
const listBots = () => mainBots.list();
/** A palette name or any hex spelling, stored as a name or "#rrggbb"; anything else is a 400. */
const colorPatch = <T extends { color?: unknown }>(patch: T): T => patch && patch.color !== undefined ? { ...patch, color: avatarColorPatch(patch.color) } : patch;
const saveBot = async (slug: string, patch: BotPatch) => {
  const bot = await getBot(slug);
  if (!bot) throw Object.assign(new Error("Bot not found"), { status: 404 });
  return mainBots.save(slug, await avatarImagePatch(bot, objectAvatarPatch(colorPatch(patch))));
};
// Codex only reads a project's .codex/config.toml when the project is trusted in its global config.
const codexGlobalConfig = path.join(process.env.CODEX_HOME ?? path.join(homedir(), ".codex"), "config.toml");
const codexTrustLines = (dir: string) => `[projects.${JSON.stringify(dir)}]\ntrust_level = "trusted"\n`;
/** Trusts a Bot folder in Codex's global config. True when this call added it. */
async function trustInCodex(dir: string) {
  const existing = await fs.readFile(codexGlobalConfig, "utf8").catch(() => "");
  const header = `[projects.${JSON.stringify(dir)}]`;
  if (existing.includes(header)) return false;
  const prefix = existing ? (existing.endsWith("\n") ? existing : existing + "\n") + "\n" : "# Bot folders are trusted so Codex loads each Bot's own .codex/config.toml (Executor MCP).\n";
  await fs.mkdir(path.dirname(codexGlobalConfig), { recursive: true });
  await fs.writeFile(codexGlobalConfig, `${prefix}${codexTrustLines(dir)}`, { mode: 0o600 });
  return true;
}
/** Takes back the trust entry adoption added, exactly as it was written. */
async function untrustInCodex(dir: string) {
  const existing = await fs.readFile(codexGlobalConfig, "utf8").catch(() => null);
  const lines = codexTrustLines(dir);
  if (existing === null || !existing.includes(lines)) return;
  await fs.writeFile(codexGlobalConfig, existing.replace(`\n${lines}`, "").replace(lines, ""), { mode: 0o600 });
}

async function writeMcpConfig(dir: string, slug: string, adoption?: AdoptedBot) {
  // Every Bot gets its own tool server (the Vault and Projects); Executor when it's configured.
  const botToken = tokenForBot(botMcpToken, slug);
  const servers: Record<string, McpServer> = { bot: { type: 'http', url: cfg.botMcpUrl, headers: { Authorization: `Bearer ${botToken}` } } };
  try { const definition = executorMcpDefinition(executorConfig.profile); if (definition) servers.executor = definition; }
  catch { console.error('Executor credential unavailable; managed Executor MCP is disabled.'); }
  if (adoption) return writeAdoptedMcpConfig(adoption, servers);
  const mcpPath = path.join(dir, ".mcp.json");
  const mcp = (await readJson(mcpPath, {})) ?? {};
  mcp.mcpServers = { ...(mcp.mcpServers ?? {}) };
  delete mcp.mcpServers.executor;
  for (const [name, definition] of Object.entries(servers)) mcp.mcpServers[name] = definition;
  await writeJson(mcpPath, mcp);
  await fs.chmod(mcpPath, 0o600).catch(() => {});
  const codexConfig = path.join(dir, ".codex", "config.toml");
  await fs.mkdir(path.dirname(codexConfig), { recursive: true });
  let toml = "# Written by the Bot gateway. bot = the Vault and other Bot tools; executor = connected apps.\n";
  for (const [name, s] of Object.entries(servers)) {
    const headers = Object.entries(s.headers).map(([key, value]) => `${JSON.stringify(key)} = ${JSON.stringify(value)}`).join(', ');
    toml += `[mcp_servers.${name}]\nurl = ${JSON.stringify(s.url)}\nhttp_headers = { ${headers} }\n`;
  }
  await fs.writeFile(codexConfig, toml, { mode: 0o600 });
  await fs.chmod(codexConfig, 0o600).catch(() => {});
  await trustInCodex(dir);
  const claudeSettings = path.join(dir, ".claude", "settings.json");
  const cs = (await readJson(claudeSettings, {})) ?? {};
  cs.enableAllProjectMcpServers = true;
  await writeJson(claudeSettings, cs);
  // Pi reads project MCP servers from .pi/mcp.json once the project is trusted.
  // T3 launches a Bot in its own folder, so this keeps the per-Bot bearer local to it.
  const piPath = path.join(dir, ".pi", "mcp.json");
  await fs.mkdir(path.dirname(piPath), { recursive: true });
  const pi = (await readJson(piPath, {})) ?? {};
  pi.mcpServers = { ...(pi.mcpServers ?? {}) };
  for (const [name, definition] of Object.entries(servers)) {
    if (!definition.url) continue;
    pi.mcpServers[name] = {
      type: "streamable-http",
      url: definition.url,
      headers: definition.headers,
      description: name === "bot" ? "Threebot Vault and Projects tools." : "The user's connected apps.",
    };
  }
  await writeJson(piPath, pi);
  await fs.chmod(piPath, 0o600).catch(() => {});
  return Boolean(servers.executor);
}

/**
 * The same tool-server configs for a Bot made from a project, written only where adoption's plan
 * allows: never a file git tracks, and only the Bot's own keys in a file the user already had.
 * Claude's switch goes in `.claude/settings.local.json`, the untracked twin of settings.json.
 */
async function writeAdoptedMcpConfig(adoption: AdoptedBot, servers: Record<string, McpServer>) {
  const dir = adoption.path;
  const plan = (file: string) => adoption.files.find((entry) => entry.path === file) ?? { path: file, mode: "skipped" as const };
  const before = JSON.stringify(adoption.files) + adoption.codexTrust;
  const write = async (file: string, values: Record<string, unknown>) => {
    const entry = plan(file);
    if (entry.mode === "skipped") return false;
    await mergeJsonFile(path.join(dir, file), values, entry as AdoptedFile);
    return true;
  };
  const named = (prefix: string, map: Record<string, unknown>) => Object.fromEntries(Object.entries(map).map(([name, value]) => [`${prefix}.${name}`, value]));
  await write(CONFIG_FILES.mcp, named("mcpServers", servers));
  await write(CONFIG_FILES.claude, { enableAllProjectMcpServers: true });
  await write(CONFIG_FILES.pi, named("mcpServers", Object.fromEntries(Object.entries(servers).filter(([, s]) => s.url).map(([name, s]) => [name, {
    type: "streamable-http", url: s.url, headers: s.headers, description: name === "bot" ? "Threebot Vault and Projects tools." : "The user's connected apps.",
  }]))));
  if (plan(CONFIG_FILES.codex).mode === "created") {
    const codexConfig = path.join(dir, CONFIG_FILES.codex);
    await fs.mkdir(path.dirname(codexConfig), { recursive: true });
    let toml = "# Written by the Bot gateway. bot = the Vault and other Bot tools; executor = connected apps.\n";
    for (const [name, s] of Object.entries(servers)) {
      const headers = Object.entries(s.headers).map(([key, value]) => `${JSON.stringify(key)} = ${JSON.stringify(value)}`).join(', ');
      toml += `[mcp_servers.${name}]\nurl = ${JSON.stringify(s.url)}\nhttp_headers = { ${headers} }\n`;
    }
    await fs.writeFile(codexConfig, toml, { mode: 0o600 });
    if (await trustInCodex(dir)) adoption.codexTrust = true;
  }
  if (JSON.stringify(adoption.files) + adoption.codexTrust !== before) await updateAdopted(cfg.botsRoot, adoption);
  return Boolean(servers.executor);
}

// Adopted Bots being turned back into plain projects: nothing may write their files meanwhile.
const releasing = new Set<string>();
async function writeAgentsMd(bot: Bot, settings: TemplateSettings, snapshot?: MemorySnapshot) {
  if (releasing.has(bot.slug)) return;
  const adoption = bot.adopted ? (await readAdopted(cfg.botsRoot)).find((entry) => entry.slug === bot.slug) : undefined;
  if (bot.adopted && !adoption) return;
  const dir = bot.workspaceRoot;
  const executorReady = await writeMcpConfig(dir, bot.slug, adoption);
  // Executor is only ready with a profile; skippedApps is only set on a Cloud profile.
  const executor = executorReady ? { kind: executorConfig.profile!.kind, publicUrl: executorConfig.profile!.publicUrl,
    organization: executorConfig.profile!.organization, skippedApps: (executorConfig.profile as ExecutorProfile & { skippedApps?: string[] }).skippedApps ?? [] } : null;
  const memory = snapshot ?? await readSnapshot({ botDir: bot.dataDir, sharedFile: path.join(cfg.botsRoot, ".botapp", "shared-memory.md") });
  const block = renderAgentsMd({ bot, settings, botsRoot: cfg.botsRoot, executor, memory });
  if (adoption) return writeAdoptedInstructions(adoption, block);
  const file = path.join(dir, "AGENTS.md");
  const existing = await fs.readFile(file, "utf8").catch(() => "");
  const content = mergeManaged(existing, block);
  await writeTextAtomic(file, content);
  if (Buffer.byteLength(content, "utf8") > 24_000) console.warn(`[memory] ${bot.slug}'s AGENTS.md is over 24 KB; some harnesses may cut it`);
  const claude = path.join(dir, "CLAUDE.md");
  if (!existsSync(claude)) await fs.symlink("AGENTS.md", claude).catch(() => {});
}
/**
 * A Bot made from a project reads its instructions from files git doesn't track: Claude from
 * CLAUDE.local.md (beside the project's CLAUDE.md), Codex from AGENTS.override.md (instead of the
 * project's AGENTS.md, whose text is copied in when the override is the Bot's own file).
 */
async function writeAdoptedInstructions(adoption: AdoptedBot, block: string) {
  for (const name of [CLAUDE_FILE, CODEX_FILE]) {
    const entry = adoption.files.find((file) => file.path === name);
    if (!entry || entry.mode === "skipped") continue;
    const file = path.join(adoption.path, name);
    const text = name === CODEX_FILE && entry.mode === "created" ? withProjectAgents(block, await projectAgentsMd(adoption.path)) : block;
    const content = mergeManaged(await fs.readFile(file, "utf8").catch(() => ""), text);
    await writeTextAtomic(file, content);
    if (Buffer.byteLength(content, "utf8") > 32_000) console.warn(`[memory] ${adoption.slug}'s ${name} is over 32 KB; Codex cuts project instructions there`);
  }
}
/** Rewrites a Bot's instructions when its memory changed, so a fresh session sees the new snapshot. */
function startMemoryWatcher() {
  const seen = new Map<string, string>();
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const [bots, settings] = await Promise.all([listBots(), getSettings()]);
      for (const bot of bots) {
        try {
          const snapshot = await readSnapshot({ botDir: bot.dataDir, sharedFile: path.join(cfg.botsRoot, ".botapp", "shared-memory.md") });
          // An adopted Bot's AGENTS.override.md also carries the project's AGENTS.md, so follow that file too.
          const signature = memorySignature(snapshot) + (bot.adopted ? createHash("sha256").update(await projectAgentsMd(bot.workspaceRoot)).digest("hex") : "");
          if (seen.get(bot.slug) === signature) continue;
          await writeAgentsMd(bot, settings, snapshot);
          seen.set(bot.slug, signature);
        } catch (error) {
          console.error(`refreshing ${bot.slug}'s memory snapshot failed`, error);
        }
      }
    } catch (error) {
      console.error("refreshing memory snapshots failed", error);
    } finally {
      busy = false;
    }
  }, 3_000);
  timer.unref();
}
async function createBot(input: NewBot) {
  input = objectAvatarPatch(colorPatch(input));
  const picture = input.avatarImage == null ? null : await decodeAvatarImage(input.avatarImage);
  const slug = await freeSlug(input.name ?? "bot");
  const dir = botDir(slug);
  await fs.mkdir(path.join(dir, "memory"), { recursive: true });
  await fs.mkdir(path.join(dir, "library"), { recursive: true });
  const mem = path.join(dir, "memory", "MEMORY.md");
  if (!existsSync(mem)) await fs.writeFile(mem, `# ${input.name} memory\n\n`);
  const log = path.join(dir, "memory", "log.md");
  if (!existsSync(log)) await fs.writeFile(log, `# Work log\n\n`);
  const shared = path.join(appDir, "shared-memory.md");
  if (!existsSync(shared)) await fs.writeFile(shared, "# Shared facts (all Bots)\n\n");
  const bot = await mainBots.save(slug, {
    name: input.name,
    label: input.label ?? "",
    shape: input.shape ?? "sphere",
    color: input.color ?? "teal",
    ...(input.avatarDefinition ? { avatarDefinition: input.avatarDefinition } : {}),
    ...(picture ? { avatarImage: await storeAvatarImage({ workspaceRoot: dir, slug }, picture) } : {}),
    section: input.section ?? null,
    pinned: Boolean(input.pinned),
    hidden: false,
    primary: Boolean(input.primary),
    notifications: true,
    projectId: null,
    mainThreadId: null,
    model: input.model ?? null,
    createdAt: new Date().toISOString(),
  }, { create: true });
  await provisioner.runNow();
  return (await getBot(slug)) ?? bot;
}
/** A slug no Bot uses yet: not a folder in BOTS_ROOT, and not a Bot made from a project. */
async function freeSlug(name: string) {
  const base = slugify(name);
  const adopted = new Set((await readAdopted(cfg.botsRoot)).map((entry) => entry.slug));
  let slug = base, n = 2;
  while (existsSync(path.join(cfg.botsRoot, slug)) || adopted.has(slug)) slug = `${base}-${n++}`;
  return slug;
}

// ---------- Bots made from existing projects ----------
/** A T3 project as /api/projects lists it; only the fields used here. */
type T3ProjectRow = { id: string; title?: string; workspaceRoot?: string; deletedAt?: string | null; archivedAt?: string | null };
async function t3Projects(): Promise<T3ProjectRow[]> {
  const client = await withTimeout(t3rpc(), 10000, "T3 timed out");
  const { projects } = await withTimeout(client.http("/api/projects"), 15000, "T3 timed out");
  return (projects ?? []).filter((project: T3ProjectRow) => project.id && project.workspaceRoot && !project.deletedAt);
}
/** This machine's T3 projects that could become Bots: not already a Bot, and not inside the Bots folder. */
async function adoptableProjects() {
  const [projects, bots] = await Promise.all([t3Projects(), listBots()]);
  const taken = (project: T3ProjectRow) => bots.some((bot) => bot.projectId === project.id || samePath(bot.workspaceRoot, project.workspaceRoot!))
    || within(cfg.botsRoot, project.workspaceRoot!);
  return Promise.all(projects.filter((project) => !taken(project)).map(async (project) => ({
    id: project.id, title: project.title ?? path.basename(project.workspaceRoot!), workspaceRoot: project.workspaceRoot!,
    environmentId: LOCAL_ENVIRONMENT, archived: Boolean(project.archivedAt), exists: existsSync(project.workspaceRoot!),
    git: await gitRepo(project.workspaceRoot!).then((repo) => Boolean(repo), () => false),
  })));
}
type AdoptRequest = NewBot & { projectId?: unknown; threadId?: unknown };
/**
 * Makes a Bot of an existing T3 project, in place: the Bot works in the project's folder and reuses
 * its T3 project, and either one of its threads (history included) or a new one as its main thread.
 */
async function adoptProject(input: AdoptRequest) {
  const projectId = typeof input.projectId === "string" ? input.projectId : "";
  const threadId = typeof input.threadId === "string" && input.threadId ? input.threadId : null;
  const project = (await t3Projects()).find((candidate) => candidate.id === projectId);
  if (!project) throw Object.assign(new Error("That T3 project isn't on this machine."), { status: 404 });
  const dir = project.workspaceRoot!;
  const bots = await listBots();
  if (bots.some((bot) => bot.projectId === project.id || samePath(bot.workspaceRoot, dir))) throw Object.assign(new Error("That project is already a Bot."), { status: 409 });
  if (within(cfg.botsRoot, dir)) throw Object.assign(new Error("Projects in the Bots folder are Bots already."), { status: 409 });
  if (!(await fs.stat(dir).then((stat) => stat.isDirectory(), () => false))) throw Object.assign(new Error("That project's folder isn't on this machine."), { status: 409 });
  if (threadId) {
    const thread = (await shellThreads(false)).find((candidate) => candidate.id === threadId) as (BotThread & { worktreePath?: string | null }) | undefined;
    if (!thread || thread.projectId !== project.id) throw Object.assign(new Error("That thread isn't in this project."), { status: 400 });
    // The Bot's files are in the project's own folder; a thread in another worktree would never read them.
    if (thread.worktreePath && !samePath(thread.worktreePath, dir)) throw Object.assign(new Error("That thread works in a separate worktree. Pick a thread in the project's own folder, or start a new conversation."), { status: 400 });
  }
  input = objectAvatarPatch(colorPatch(input));
  const picture = input.avatarImage == null ? null : await decodeAvatarImage(input.avatarImage);
  const name = typeof input.name === "string" && input.name.trim() ? input.name.trim() : (project.title ?? path.basename(dir));
  const slug = await freeSlug(name);
  const git = await gitRepo(dir);
  const { files, createdDirs } = await planAdoption(dir, git);
  const entry: AdoptedBot = { slug, path: dir, environmentId: LOCAL_ENVIRONMENT, projectId: project.id, adoptedAt: new Date().toISOString(), git, files, createdDirs, codexTrust: false };
  // Git ignores the Bot's files before the first one exists, so `git status` never shows them.
  if (git) await writeExcludeBlock(git.exclude, slug, excludePatterns(entry));
  try {
    const data = path.join(dir, ".bot");
    await fs.mkdir(path.join(data, "memory"), { recursive: true });
    await fs.mkdir(path.join(data, "library"), { recursive: true });
    await fs.writeFile(path.join(data, "memory", "MEMORY.md"), `# ${name} memory\n\n`);
    await fs.writeFile(path.join(data, "memory", "log.md"), `# Work log\n\n`);
    const shared = path.join(appDir, "shared-memory.md");
    if (!existsSync(shared)) await fs.writeFile(shared, "# Shared facts (all Bots)\n\n");
    await registerAdopted(cfg.botsRoot, entry);
    await mainBots.save(slug, {
      name,
      label: input.label ?? "",
      shape: input.shape ?? "sphere",
      color: input.color ?? "teal",
      ...(input.avatarDefinition ? { avatarDefinition: input.avatarDefinition } : {}),
      ...(picture ? { avatarImage: await storeAvatarImage({ workspaceRoot: dir, slug }, picture) } : {}),
      section: input.section ?? null,
      pinned: Boolean(input.pinned),
      hidden: false,
      primary: Boolean(input.primary),
      notifications: true,
      projectId: project.id,
      mainThreadId: threadId,
      model: input.model ?? null,
      createdAt: new Date().toISOString(),
    }, { create: true });
  } catch (error) {
    // Leave the project as it was found.
    await undoAdoption(entry).catch((undoError) => console.error(`undoing ${slug}'s adoption failed`, undoError));
    await fs.rm(path.join(dir, ".bot"), { recursive: true, force: true });
    throw error;
  }
  console.log(`bots: made ${slug} from the project at ${dir}${threadId ? " with its existing thread" : ""}`);
  await provisioner.runNow();
  return (await getBot(slug))!;
}
/** Everything but the archive: the Bot's files and exclude lines, Codex trust, and its registry entry. */
async function undoAdoption(entry: AdoptedBot) {
  await undoAdoptionFiles(entry);
  if (entry.codexTrust) await untrustInCodex(entry.path);
  await unregisterAdopted(cfg.botsRoot, entry.slug);
}
/**
 * "Turn back into a plain project": the project, its T3 project and its threads stay as they are; the
 * Bot's files go, and its profile, memory and library are archived under .botapp/adopted-archive/.
 */
async function releaseAdopted(slug: string) {
  let archive: string | null = null;
  const bots = await mainBots.release(slug, async (bot) => {
    const entry = (await readAdopted(cfg.botsRoot)).find((candidate) => candidate.slug === bot.slug);
    if (!entry) throw Object.assign(new Error("Bot not found"), { status: 404 });
    releasing.add(slug);
    try {
      await undoAdoptionFiles(entry);
      if (entry.codexTrust) await untrustInCodex(entry.path);
      archive = await archiveAdoptedData(cfg.botsRoot, entry);
      await unregisterAdopted(cfg.botsRoot, entry.slug);
    } finally { releasing.delete(slug); }
  });
  console.log(`bots: ${slug} is a plain project again${archive ? `; its memory and library are in ${archive}` : ""}`);
  return { bots, archive };
}

async function refreshAllAgentsMd() {
  await mainBots.refreshInstructions();
}

// ---------- Executor ----------
async function executorStatus() {
  const out: ReturnType<typeof publicExecutorConfiguration> & { connections: unknown[]; error?: string } = { ...publicExecutorConfiguration(executorConfig), connections: [] };
  if (!out.configured) return out;
  if (!out.hasToken) return { ...out, error: 'Executor needs a server access token.' };
  try { out.connections = await executorClient().apps(); }
  catch (error) { out.error = (error as Error).message; }
  return out;
}
function executorClient(backend: string = executorConfig.active) {
  if (backend !== executorConfig.active) throw Object.assign(new Error('This connection belongs to another Executor backend'), { status: 409 });
  return createExecutorClient(executorConfig.profile);
}

// ---------- Vault ----------
// A T3 RPC connection for looking up the Bots' browser tabs, opened on first use.
let rpcClient: T3Client | null = null;
async function t3rpc() {
  if (rpcClient) return rpcClient;
  const c = new T3Client({ baseUrl: cfg.t3Url, token, clientLabel: "bot-gateway-vault" });
  await c.connect();
  c.ws.addEventListener("close", () => {
    if (rpcClient === c) rpcClient = null;
  });
  rpcClient = c;
  return c;
}
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([promise, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(message)), ms)))]).finally(() => clearTimeout(timer));
}
async function listServerTabs(threadId: string) {
  let r;
  try {
    const c = await withTimeout(t3rpc(), 10000, "timeout");
    r = await withTimeout(c.call("preview.list", { threadId }), 10000, "timeout");
  } catch {
    throw new Error("Couldn't reach your browser on T3 right now. Try again in a moment.");
  }
  return (r?.sessions ?? []).filter((s: PreviewSession) => s.runtime === "server").map((s: PreviewSession) => ({ tabId: s.tabId, url: s.navStatus?.url ?? "", title: s.navStatus?.title ?? "" }));
}

/**
 * Types text into the focused element of a Bot's browser tab through T3's preview stream, like a
 * person using Take control: take control, insert the text, wait until it's applied, release.
 * Errors never include the text.
 */
function typeIntoTab({ threadId, tabId, text }: { threadId: string; tabId: string; text: string }) {
  return new Promise<void>((resolve, reject) => {
    const target = new URL(cfg.t3Url.replace(/^http/, "ws") + "/api/preview-stream/ws");
    for (const [k, v] of Object.entries({ threadId, tabId, interactive: "true", maxWidth: "320", maxHeight: "240", quality: "10" })) target.searchParams.set(k, v);
    const ws = new WebSocket(target, { headers: { authorization: `Bearer ${token}` } });
    let stage = "connecting"; // → taking → typing → releasing
    let settled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      try { ws.close(); } catch {}
      err ? reject(err) : resolve();
    };
    timers.push(setTimeout(() => finish(new Error(stage === "typing" ? "The browser didn't confirm the input. Take a fresh snapshot to check the field." : "The browser didn't respond in time.")), 15000));
    const sendJson = (m: Record<string, unknown>) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m));
    ws.on("open", () => {
      stage = "taking";
      sendJson({ type: "takeControl" });
    });
    ws.on("message", (data, isBinary) => {
      if (isBinary) return sendJson({ type: "ack" }); // frames are paced by acks
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.type === "control") {
        if (msg.canOperate === false) return finish(new Error("The gateway's T3 token can't operate the browser (it needs the preview:operate scope)."));
        if (stage === "taking" && msg.controller === "you") {
          stage = "typing";
          sendJson({ type: "text", text });
          // Viewer input runs in order, so the probe's answer means the text is in.
          timers.push(setTimeout(() => sendJson({ type: "probe", x: 1, y: 1 }), 150));
        } else if (stage === "taking" && msg.controller === "another-viewer") {
          finish(new Error("The user is controlling this tab right now (Take over). Try again when they're done."));
        } else if (stage === "releasing" && msg.controller !== "you") {
          finish();
        }
      } else if (msg.type === "probe" && stage === "typing") {
        stage = "releasing";
        sendJson({ type: "releaseControl" });
        timers.push(setTimeout(() => finish(), 1000));
      }
    });
    ws.on("unexpected-response", (_r, res) => finish(new Error(res.statusCode === 404 ? "That browser tab isn't open." : `The browser stream refused the connection (${res.statusCode}).`)));
    ws.on("error", () => finish(new Error("Couldn't connect to the browser.")));
    ws.on("close", (code) => {
      if (stage === "releasing") return finish();
      finish(new Error(code === 4404 ? "That browser tab was closed." : "The browser closed the connection before the text was typed."));
    });
  });
}

const projectTools = {
  tools: PROJECT_TOOLS,
  call: createProjectTools({ projects, appUrl, log: (line) => console.log(line) }),
  instructions: "Also the user's Projects board (projects_* tools): their projects, to-dos, machines, what runs where, repos and links, shown live on their Projects page.",
};

function combineExtras(...sources: (ExtraTools | null)[]): ExtraTools | null {
  const list = sources.filter((source): source is ExtraTools => Boolean(source));
  if (list.length === 0) return null;
  return {
    tools: list.flatMap((source) => source.tools),
    instructions: list.map((source) => source.instructions).filter(Boolean).join(" "),
    call(name, args, context) {
      const source = list.find((candidate) => candidate.tools.some((tool) => tool.name === name));
      if (!source) throw new Error(`Unknown tool ${name}`);
      return source.call(name, args, context);
    },
  };
}

/** Accept a Bot's own HMAC bearer, or the legacy shared bearer (Vault/Projects only). */
async function resolveMcpAuth(raw: string): Promise<McpAuth | null> {
  if (tokenMatches(raw, botMcpToken)) return { botSlug: null, legacy: true };
  for (const bot of await listBots()) {
    if (tokenMatches(raw, tokenForBot(botMcpToken, bot.slug))) return { botSlug: bot.slug, legacy: false };
  }
  return null;
}

const botTools = createBotTools({
  vault,
  async findBotByThread(threadId: string) {
    return (await listBots()).find((b) => b.mainThreadId === threadId) ?? null;
  },
  listTabs: listServerTabs,
  typeIntoTab,
  secretsDir: cfg.t3SecretsDir,
  tokenDir: path.join(path.dirname(cfg.vaultKeyFile), "bot-secrets"),
  log: (line) => console.log(line),
  extra: async () => combineExtras((await projectsOn()) ? projectTools : null),
});
const projectRoutes = createProjectRoutes({ projects, send, readBody, requireJson, enabled: projectsOn, log: (line) => console.log(line), checkOrigin: (req) => sameOriginRequest(req, originPolicy) });

async function vaultRoutes(req: IncomingMessage, res: ServerResponse, p: string, url: URL) {
  if (p === "/api/vault" && req.method === "GET") {
    const items = await vault.list();
    return send(res, 200, { items }, { "cache-control": "no-store" });
  }
  if (p === "/api/vault" && req.method === "POST") {
    requireJson(req);
    return send(res, 200, await vault.create(await readBody(req)));
  }
  if (p === "/api/vault/import" && req.method === "POST") {
    requireJson(req);
    const body = await readBody(req, 8 << 20);
    const result = await vault.importItems(body.items);
    console.log(`vault: imported ${result.added} added, ${result.updated} updated, ${result.skipped} skipped`);
    return send(res, 200, result);
  }
  if (p === "/api/vault/export.csv" && req.method === "GET") {
    const type = url.searchParams.get("type") === "contact" ? "contact" : "login";
    console.log(`vault: exported ${type}s as CSV`);
    const name = type === "contact" ? "bot-vault-contacts.csv" : "bot-vault-logins.csv";
    return send(res, 200, await vault.exportCsv(type), { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${name}"`, "cache-control": "no-store" });
  }
  const m = p.match(/^\/api\/vault\/([\w-]+)$/);
  if (m && req.method === "GET") {
    const reveal = url.searchParams.get("reveal") === "1";
    const item = await vault.get(m[1], { reveal });
    if (!item) return send(res, 404, { error: "not found" });
    if (reveal) console.log(`vault: revealed item ${m[1]} in the app`);
    return send(res, 200, item, { "cache-control": "no-store" });
  }
  if (m && req.method === "PUT") {
    requireJson(req);
    return send(res, 200, await vault.update(m[1], await readBody(req)));
  }
  if (m && req.method === "DELETE") return send(res, 200, await vault.remove(m[1]));
  return send(res, 404, { error: "not found" });
}

// ---------- T3 HTTP proxy ----------
async function proxyT3(req: IncomingMessage, res: ServerResponse, t3Path: string, target: EnvironmentTarget = { baseUrl: cfg.t3Url, token }) {
  const headers = { ...req.headers };
  delete headers.host;
  delete headers.cookie;
  delete headers.connection;
  headers.authorization = `Bearer ${target.token}`;
  delete headers["cf-access-jwt-assertion"];
  // Node's fetch streams a request body from any async iterable (with duplex: "half"), which the DOM's RequestInit doesn't describe.
  const upstream = await fetch(target.baseUrl + t3Path, {
    method: req.method,
    headers: headers as Record<string, string>,
    body: (req.method === "GET" || req.method === "HEAD" ? undefined : req) as unknown as BodyInit | undefined,
    duplex: "half",
    redirect: "manual",
  } as RequestInit);
  const out: Record<string, string> = {};
  upstream.headers.forEach((v, k) => {
    if (!["content-encoding", "content-length", "transfer-encoding", "connection", "set-cookie"].includes(k)) out[k] = v;
  });
  res.writeHead(upstream.status, out);
  if (upstream.body) for await (const chunk of upstream.body) res.write(chunk);
  res.end();
}

// ---------- static ----------
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".woff2": "font/woff2", ".webp": "image/webp", ".json": "application/json", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json", ".mp4": "video/mp4" };
async function serveStatic(req: IncomingMessage, res: ServerResponse, urlPath: string) {
  const safe = path.normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, "");
  // The public landing page is the one route outside the single-page app.
  let file = path.join(cfg.staticDir, /^\/welcome\/?$/.test(safe) ? "welcome/index.html" : safe);
  if (!file.startsWith(cfg.staticDir)) return send(res, 403, "forbidden");
  let stat = await fs.stat(file).catch(() => null);
  if (!stat || stat.isDirectory()) { file = path.join(cfg.staticDir, "index.html"); stat = await fs.stat(file).catch(() => null); }
  if (!stat) return send(res, 404, "web app not built");
  const ext = path.extname(file);
  // Cloudflare only answers Safari's range requests for a video it can cache at a known length.
  const cache = file.includes(`${path.sep}assets${path.sep}`) ? "public, max-age=31536000, immutable" : ext === ".mp4" ? "public, max-age=86400" : "no-cache";
  const headers = { "content-type": MIME[ext] ?? "application/octet-stream", "cache-control": cache };
  // Safari won't play a video unless it can ask for pieces of it.
  const range = ext === ".mp4" && /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? "");
  if (range) {
    const start = Number(range[1]), end = Math.min(range[2] ? Number(range[2]) : stat.size - 1, stat.size - 1);
    if (start > end) { res.writeHead(416, { "content-range": `bytes */${stat.size}` }); return res.end(); }
    res.writeHead(206, { ...headers, "accept-ranges": "bytes", "content-range": `bytes ${start}-${end}/${stat.size}`, "content-length": end - start + 1 });
    return res.end((await fs.readFile(file)).subarray(start, end + 1));
  }
  res.writeHead(200, ext === ".mp4" ? { ...headers, "accept-ranges": "bytes", "content-length": stat.size } : headers);
  res.end(await fs.readFile(file));
}

// ---------- router ----------
// A server request always has its url and method.
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url!, "http://x");
  const p = url.pathname;
  try {
    // Access leaves everything under /welcome public, so the landing page must be
    // the only thing that answers there, even for encoded paths that climb out of it.
    const landingAsset = /^\/welcome\/(img|fonts)\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(p);
    if (/^\/welcome(\/|\\|%2f|%5c)/i.test(p) && p !== "/welcome/" && !landingAsset) return send(res, 404, "not found");
    // A missing landing file must not fall through to the app shell.
    if (landingAsset && !existsSync(path.join(cfg.staticDir, p))) return send(res, 404, "not found");
    // Landing-only mode: the app isn't here at all. Bots still reach their local tool server.
    // The updater and `threebot up` wait on this; it only says the gateway is up and its version.
    if (p === "/api/health" && req.method === "GET") return send(res, 200, { ok: true, version });
    if (publicPortClosed(req)) {
      if (p === "/mcp/bot" && !req.headers["cf-ray"]) return await handleMcpHttp(req, res, { tools: botTools, resolveAuth: resolveMcpAuth, readBody });
      if (!["GET", "HEAD"].includes(req.method!) || !landingPath(p)) return send(res, 404, "not found");
      return await serveStatic(req, res, p === "/" ? "/welcome/" : p);
    }
    // Cookies travel on cross-site requests, so changes must also come from this app's own pages.
    if ((p.startsWith("/api/") || p.startsWith("/t3/")) && !["GET", "HEAD"].includes(req.method!) && !sameOriginRequest(req, originPolicy)) {
      return send(res, 403, { error: "cross-site request refused" });
    }
    if (p === "/api/login" && req.method === "POST") {
      const ip = clientIp(req);
      if (loginBlocked(ip)) return send(res, 429, { error: "Too many attempts. Try again in 15 minutes." });
      const { password } = await readBody(req, 4096);
      const ok = !(await passwordRequired()) || (await passwordMatches(password));
      if (!ok) {
        loginFailed(ip);
        console.warn(`failed login from ${ip}`);
        return send(res, 401, { error: "wrong password" });
      }
      attempts.delete(ip);
      const secure = isHttps(req) ? "; Secure" : "";
      return send(res, 200, { ok: true }, { "set-cookie": `${COOKIE}=${makeSession()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 24 * 3600}${secure}` });
    }
    // The Bots' own tool server: local callers with its bearer only, never the app's login.
    if (p === "/mcp/bot") return await handleMcpHttp(req, res, { tools: botTools, resolveAuth: resolveMcpAuth, readBody });

    if (p === "/api/session") {
      const needsPassword = await passwordRequired();
      // Cloudflare's login only helps requests that came through Cloudflare; on this machine or the LAN, use the password.
      const accessLogin = Boolean(verifyAccess) && !(needsPassword && !req.headers["cf-ray"]);
      return send(res, 200, { authenticated: await authed(req), passwordRequired: needsPassword, accessLogin });
    }
    if (p === "/api/logout") return send(res, 200, { ok: true }, { "set-cookie": `${COOKIE}=; Path=/; Max-Age=0` });

    if (p.startsWith("/api/") || p.startsWith("/t3/")) {
      if (!(await authed(req))) return send(res, 401, { error: "login required" });
    }
    if (p.startsWith("/t3/")) {
      const route = environmentPath(p);
      return await proxyT3(req, res, route.path + url.search, await resolveEnvironment(route.environmentId));
    }

    if (p === "/api/machines" && req.method === "GET") {
      const { machines: list, linksSupported } = await machines.list({ maxAge: url.searchParams.get("fresh") === "1" ? 0 : 15_000 });
      return send(res, 200, { machines: list, linksSupported }, { "cache-control": "no-store" });
    }
    const pairRoute = p.match(/^\/api\/machines\/([a-zA-Z0-9_-]{1,128})\/pair$/);
    if (pairRoute && req.method === "POST") {
      requireJson(req);
      const body = await readBody(req, 8192);
      const paired = await machines.pair(pairRoute[1], body?.code, typeof body?.url === "string" && body.url ? body.url : undefined);
      console.log(`machines: paired ${pairRoute[1]} directly at ${new URL(paired.baseUrl).host}`);
      return send(res, 200, paired);
    }
    if (pairRoute && req.method === "DELETE") return send(res, 200, await machines.unpair(pairRoute[1]));
    const remoteThread = p.match(/^\/api\/machines\/([a-zA-Z0-9_-]{1,128})\/threads\/([\w:.-]{1,256})(\/messages)?$/);
    if (remoteThread) {
      const [, environmentId, threadId, messages] = remoteThread;
      const machine = await machineFor(environmentId);
      if (machine.route === "none") return send(res, 409, { error: `The link to ${machine.label} has expired. Link it again in T3 Code.` });
      try {
        if (!messages && req.method === "GET") {
          const after = url.searchParams.get("after");
          return send(res, 200, { machine, read: await readLinkedThread(environmentId, threadId, after !== null && /^\d{1,9}$/.test(after) ? Number(after) : null) }, { "cache-control": "no-store" });
        }
        if (messages && req.method === "POST") {
          requireJson(req);
          const text = String((await readBody(req, 256 * 1024))?.text ?? "").trim();
          if (!text) return send(res, 400, { error: "Write a message first" });
          return send(res, 200, await t3Mcp.call("t3_thread_send", { environmentId, threadId, message: text, mode: "auto", clientRequestId: randomUUID() }));
        }
      } catch (error) {
        if (error instanceof T3ToolError) return send(res, machine.status === "online" ? error.status : 503, { error: machine.status === "online" ? error.message : `${machine.label} isn't reachable right now${machine.status === "asleep" ? " (it's asleep)" : ""}.` });
        throw error;
      }
      return send(res, 405, { error: "method not allowed" });
    }
    if (p === "/api/config") return send(res, 200, { botsRoot: cfg.botsRoot, accessLogout: Boolean(process.env.CF_ACCESS_TEAM_DOMAIN) && !onTailnet(req, exposure), executorUrl: executorConfig.profile?.credential ? executorConfig.profile.publicUrl : null });
    if (p === "/api/thread-link" && req.method === "GET") {
      const environmentId = url.searchParams.get("environmentId") ?? "";
      const threadId = url.searchParams.get("threadId") ?? "";
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(environmentId) || !/^[\w:%.-]{1,1024}$/.test(threadId)) return send(res, 400, { error: "Invalid thread reference" });
      // Machines the gateway can reach (paired, configured, or linked in T3) stay inside the app;
      // anything else keeps the existing T3 handoff.
      const reachable = await resolveEnvironment(environmentId).then(() => true, () => false)
        || (await machines.list().catch(() => null))?.machines.some((machine) => machine.environmentId === environmentId && !machine.local && machine.route !== "none");
      if (reachable) {
        res.writeHead(302, { location: `/?environment=${encodeURIComponent(environmentId)}&thread=${encodeURIComponent(threadId)}`, "cache-control": "no-store" });
        return res.end();
      }
      const href = await resolveThreadLink({ environmentId: url.searchParams.get("environmentId") ?? "", threadId: url.searchParams.get("threadId") ?? "" });
      res.writeHead(302, { location: href, "cache-control": "no-store", "referrer-policy": "no-referrer" });
      return res.end();
    }
    if (p === "/api/executor" && req.method === 'GET') return send(res, 200, await executorStatus());
    if (p === "/api/executor/catalog" && req.method === 'GET') return send(res, 200, await executorClient().catalog(url.searchParams.get('search') ?? ''));
    if (p === "/api/executor/install" && req.method === 'POST') return send(res, 200, await executorClient().install(await readBody(req)));
    if (p === '/api/executor/resolve-link' && req.method === 'POST') return send(res, 200, await executorClient().resolveLink((await readBody(req)).url));
    const executorAppRoute = p.match(/^\/api\/executor\/apps\/([^/]+)(?:\/(accounts|connections))?$/);
    if (executorAppRoute) {
      let id;
      try { id = decodeURIComponent(executorAppRoute[1]); } catch { return send(res, 400, { error: 'Invalid app identifier' }); }
      const client = executorClient();
      if (!executorAppRoute[2] && req.method === 'GET') return send(res, 200, { app: await client.app(id) });
      if (executorAppRoute[2] === 'accounts' && req.method === 'POST') return send(res, 200, await client.link(id, await readBody(req)));
      if (executorAppRoute[2] === 'connections' && req.method === 'POST') return send(res, 200, await client.connect(id, await readBody(req)));
    }
    const executorConnectionRoute = p.match(/^\/api\/executor\/connections\/([^/]+)$/);
    if (executorConnectionRoute && req.method === 'GET') {
      let id;
      try { id = decodeURIComponent(executorConnectionRoute[1]); } catch { return send(res, 400, { error: 'Invalid connection identifier' }); }
      return send(res, 200, await executorClient(url.searchParams.get('backend') ?? executorConfig.active).connection(id));
    }
    if (p === "/api/system" && req.method === "GET") {
      const updates = await checkUpdates({ force: url.searchParams.get("check") === "1" });
      return send(res, 200, { version, installed: installedRuntime(), service: process.env.THREEBOT_SERVICE === "1", ...updates, ...(await autoUpdate.status()) });
    }
    if (p === "/api/system/auto-update" && req.method === "PUT") {
      const { auto } = await readBody(req, 4096);
      if (typeof auto !== "boolean") return send(res, 400, { error: "auto must be true or false" });
      await autoUpdate.setAuto(auto);
      return send(res, 200, await autoUpdate.status());
    }
    if (p === "/api/system/update-notice" && req.method === "DELETE") {
      await autoUpdate.dismiss(url.searchParams.get("at"));
      return send(res, 200, await autoUpdate.status());
    }
    if (p === "/api/system/update" && req.method === "POST") return send(res, 202, await startSelfUpdate());
    if (p === "/api/access" && req.method === "GET") return send(res, 200, { ...(await remoteAccess.status()), cloudflareAccess: verifyAccess ? { emails: accessEmails } : null });
    if (p === "/api/access/password" && req.method === "PUT") {
      const { password } = await readBody(req, 4096);
      await remoteAccess.setPassword(password ?? null);
      // Everyone signs in again with the new password, open connections included; this browser gets a fresh session now.
      await rotateSessionSecret();
      dropUpgraded();
      const secure = isHttps(req) ? "; Secure" : "";
      return send(res, 200, await remoteAccess.status(), password ? { "set-cookie": `${COOKIE}=${makeSession()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 24 * 3600}${secure}` } : {});
    }
    if (p === "/api/access/tailscale" && req.method === "POST") {
      const { on } = await readBody(req, 1024);
      if (on) await remoteAccess.tailscaleOn(); else await remoteAccess.tailscaleOff();
      return send(res, 200, await remoteAccess.status());
    }
    if (p === "/api/access/tunnel" && req.method === "POST") {
      const { on } = await readBody(req, 1024);
      if (on) await remoteAccess.tunnelOn(); else await remoteAccess.tunnelOff();
      return send(res, 200, await remoteAccess.status());
    }
    if (p === "/api/telemetry" && req.method === "GET") return send(res, 200, await telemetry.status(), { "cache-control": "no-store" });
    if (p === "/api/telemetry" && req.method === "PUT") return send(res, 200, await telemetry.setEnabled((await readBody(req)).enabled));
    if (p === "/api/telemetry/preview" && req.method === "GET") return send(res, 200, await telemetry.preview(), { "cache-control": "no-store" });
    if (p === "/api/telemetry/reset-id" && req.method === "POST") return send(res, 200, await telemetry.resetId());
    if (p === "/api/voice/cloud" && req.method === "GET") return send(res, 200, await cloudTranscription.status(), { "cache-control": "no-store" });
    if (p === "/api/voice/cloud" && req.method === "PUT") {
      requireJson(req);
      return send(res, 200, await cloudTranscription.update(await readBody(req, 4096)), { "cache-control": "no-store" });
    }
    if (p === "/api/voice/cloud/transcribe" && req.method === "POST") {
      // A non-form content type means a cross-site page can't send this without a CORS preflight.
      if (!/^audio\/wav\b/i.test(String(req.headers["content-type"] ?? ""))) throw Object.assign(new Error("content-type must be audio/wav"), { status: 415 });
      const text = await cloudTranscription.transcribe(await readRaw(req, MAX_AUDIO_BYTES), url.searchParams.get("lang") ?? "");
      return send(res, 200, { text }, { "cache-control": "no-store" });
    }
    if (p === "/api/settings" && req.method === "GET") return send(res, 200, await getSettings());
    if (p === "/api/settings" && req.method === "PUT") {
      const patch = await readBody(req);
      const current = await getSettings();
      const next = { ...current, ...patch };
      if ("beta" in patch) next.beta = patchBeta(current.beta, patch.beta);
      if ("codingWork" in patch) next.codingWork = codingWorkPatch(patch.codingWork);
      await writeJson(settingsPath, next);
      if (!next.beta.projects) projectRoutes.closeStreams();
      if ("rules" in patch || "userName" in patch || "timezone" in patch || "codingWork" in patch || next.beta.projects !== current.beta.projects) await refreshAllAgentsMd();
      return send(res, 200, next);
    }
    if (p === "/api/vault" || p.startsWith("/api/vault/")) return await vaultRoutes(req, res, p, url);
    if (p === "/api/main-bot" && req.method === "PUT") {
      requireJson(req);
      const body = await readBody(req);
      return send(res, 200, { bots: await mainBots.select(body?.slug) }, { "cache-control": "no-store" });
    }
    if (p === "/api/push/key" && req.method === "GET") {
      return send(res, 200, { publicKey: await pushStore.publicKey() }, { "cache-control": "no-store" });
    }
    if (p === "/api/push/subscribe" && req.method === "POST") {
      requireJson(req);
      const result = await pushStore.subscribe((await readBody(req))?.subscription, req.headers.origin);
      if (!result.ok) return send(res, 400, { error: result.message });
      return send(res, 200, result, { "cache-control": "no-store" });
    }
    if (p === "/api/push/presence" && req.method === "POST") {
      requireJson(req);
      const body = await readBody(req);
      return send(res, 200, await pushStore.presence(body?.endpoint, body?.bot), { "cache-control": "no-store" });
    }
    if (p === "/api/push/unsubscribe" && req.method === "POST") {
      requireJson(req);
      return send(res, 200, await pushStore.unsubscribe((await readBody(req))?.endpoint), { "cache-control": "no-store" });
    }
    if (p === "/api/thread-previews" && req.method === "POST") {
      requireJson(req);
      return send(res, 200, { previews: await threadPreviews((await readBody(req))?.stamps) }, { "cache-control": "no-store" });
    }
    if (p === "/api/site-icon" && req.method === "GET") {
      if (!normalizeDomain(url.searchParams.get("domain"))) return send(res, 400, { error: "invalid domain" });
      const icon = await siteIcons.get(url.searchParams.get("domain"));
      if (!icon) return send(res, 404, { error: "no icon" }, { "cache-control": "private, max-age=86400" });
      return send(res, 200, icon.bytes, { "content-type": icon.type, "cache-control": "private, max-age=604800", "content-security-policy": "default-src 'none'", "x-content-type-options": "nosniff" });
    }
    if (await routineHistoryRoutes.handle(req, res, url)) return;
    if (await projectRoutes.handle(req, res, url)) return;
    if (p === "/api/thread-meta" && req.method === "GET") return send(res, 200, // A missing thread id is refused by threadMeta.get's own check.
      await threadMeta.get(url.searchParams.get("thread") as string), { "cache-control": "no-store" });
    if (p === "/api/thread-meta/reactions" && req.method === "POST") {
      requireJson(req);
      return send(res, 200, await threadMeta.toggleReaction(await readBody(req)));
    }
    if (p === "/api/thread-meta/voice-calls" && req.method === "POST") {
      requireJson(req);
      return send(res, 200, await threadMeta.addVoiceCall(await readBody(req)));
    }
    if (p === "/api/bots" && req.method === "GET") return send(res, 200, { bots: await listBots() }, { "cache-control": "no-store" });
    if (p === "/api/memory" && req.method === "GET") {
      const bot = await getBot(url.searchParams.get("slug") ?? "");
      if (!bot) return send(res, 404, { error: "Bot not found" });
      return send(res, 200, await readMemoryFiles({ botDir: bot.dataDir, sharedFile: path.join(appDir, "shared-memory.md"), botPath: bot.adopted ? ".bot/memory/MEMORY.md" : undefined }), { "cache-control": "no-store" });
    }
    if (p === "/api/memory" && req.method === "PUT") {
      requireJson(req);
      const body = await readBody(req);
      const bot = await getBot(String(body?.slug ?? ""));
      if (!bot) return send(res, 404, { error: "Bot not found" });
      const result = await saveMemoryFile({
        botDir: bot.dataDir,
        sharedFile: path.join(appDir, "shared-memory.md"),
        scope: body?.scope === "shared" ? "shared" : "bot",
        text: body?.text,
        expectedRevision: body?.expectedRevision,
      });
      // The memory watcher picks the change up within a few seconds and rewrites AGENTS.md.
      return send(res, result.ok ? 200 : result.code === "conflict" ? 409 : 400, result, { "cache-control": "no-store" });
    }
    if (p === "/api/bot-identities" && req.method === "GET") return send(res, 200, { bots: await archivedBotIdentities(path.join(appDir, "trash")) }, { "cache-control": "no-store" });
    if (p === "/api/bots" && req.method === "POST") {
      requireJson(req);
      return send(res, 200, await createBot(await readBody(req, AVATAR_BODY_LIMIT)));
    }
    if (p === "/api/adoptable-projects" && req.method === "GET") return send(res, 200, { projects: await adoptableProjects() }, { "cache-control": "no-store" });
    if (p === "/api/bots/adopt" && req.method === "POST") {
      requireJson(req);
      return send(res, 200, await adoptProject(await readBody(req, AVATAR_BODY_LIMIT)));
    }
    const release = p.match(/^\/api\/bots\/([a-z0-9][a-z0-9-]{0,62})\/release$/);
    if (release && req.method === "POST") {
      requireJson(req);
      return send(res, 200, await releaseAdopted(release[1]), { "cache-control": "no-store" });
    }
    const avatar = p.match(/^\/api\/bots\/([a-z0-9][a-z0-9-]{0,62})\/avatar\/([a-f0-9]{64})\.png$/);
    if (avatar && req.method === "GET") {
      const candidates = [await getBot(avatar[1]), ...await archivedBotIdentities(path.join(appDir, "trash"))].filter((b): b is NonNullable<typeof b> => b?.slug === avatar[1]);
      for (const bot of candidates) {
        try { return send(res, 200, await readAvatarImage(bot, p), { "content-type": "image/png", "content-security-policy": "default-src 'none'", "cache-control": "private, max-age=31536000, immutable" }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      return send(res, 404, { error: "not found" });
    }
    const m = p.match(/^\/api\/bots\/([^/]+)$/);
    if (m && req.method === "GET") {
      const b = await getBot(m[1]);
      return b ? send(res, 200, b) : send(res, 404, { error: "not found" });
    }
    if (m && req.method === "PUT") {
      requireJson(req);
      const patch = await readBody(req, AVATAR_BODY_LIMIT);
      if (patch && typeof patch === "object" && "codingWork" in patch) patch.codingWork = codingWorkPatch(patch.codingWork);
      return send(res, 200, await saveBot(m[1], patch));
    }
    if (m && req.method === "DELETE") { const bots = await mainBots.remove(m[1]); return send(res, 200, { ok: true, bots }); }
    if (p.startsWith("/api/")) return send(res, 404, { error: "not found" });

    return await serveStatic(req, res, p);
  } catch (err) {
    console.error(req.method, p, err);
    if (!res.headersSent) send(res, (err as HttpError).status ?? 500, { error: String((err as HttpError).message ?? err), ...((err as HttpError).status && (err as HttpError).code ? { code: (err as HttpError).code } : {}) });
    else res.end();
  }
});

// ---------- T3 browser stream (the Bots' computer screen) ----------
function proxyPreviewStream(req: IncomingMessage, socket: Duplex, head: Buffer, url: URL, environment: EnvironmentTarget) {
  wss.handleUpgrade(req, socket, head, (client) => {
    const target = new URL(environment.baseUrl.replace(/^http/, "ws") + "/api/preview-stream/ws");
    for (const [k, v] of url.searchParams) target.searchParams.set(k, v);
    const upstream = new WebSocket(target, { headers: { authorization: `Bearer ${environment.token}` } });
    const queue: { data: RawData; binary: boolean }[] = [];
    upstream.on("open", () => { for (const m of queue.splice(0)) upstream.send(m.data, { binary: m.binary }); });
    client.on("message", (data, isBinary) => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
      else queue.push({ data, binary: isBinary });
    });
    upstream.on("message", (data, isBinary) => client.readyState === WebSocket.OPEN && client.send(data, { binary: isBinary }));
    const close = (code: number, reason?: unknown) => {
      try { client.close(code >= 1000 && code < 5000 && code !== 1005 && code !== 1006 ? code : 1011, String(reason ?? "")); } catch {}
      try { upstream.close(); } catch {}
    };
    upstream.on("close", (code, reason) => close(code, reason));
    upstream.on("unexpected-response", (_r, res) => close(4000 + (res.statusCode! % 1000), `upstream ${res.statusCode}`));
    upstream.on("error", () => close(1011, "upstream error"));
    client.on("close", () => { try { upstream.close(); } catch {} });
    client.on("error", () => { try { upstream.close(); } catch {} });
  });
}

// ---------- T3 WebSocket proxy ----------
const wss = new WebSocketServer({ noServer: true });
/** Dictation streamed to OpenAI: the browser talks to us, we talk to OpenAI with the saved key. */
async function liveDictationUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, url: URL) {
  if (!(await authed(req).catch(() => false))) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    return socket.destroy();
  }
  let target: { key: string; model: string };
  try { target = await cloudTranscription.liveTarget(); } catch (error) {
    socket.end(`HTTP/1.1 ${(error as HttpError).status ?? 500} Live dictation unavailable\r\nConnection: close\r\n\r\n`); return;
  }
  wss.handleUpgrade(req, socket, head, (client) => {
    const upstream = new WebSocket("wss://api.openai.com/v1/realtime?intent=transcription", { headers: { authorization: `Bearer ${target.key}` } });
    relayLiveDictation(client, upstream, { model: target.model, lang: url.searchParams.get("lang") ?? "" });
  });
}

server.on("upgrade", async (req, socket, head) => {
  upgraded.add(socket as Socket);
  socket.once("close", () => upgraded.delete(socket as Socket));
  if (publicPortClosed(req)) {
    socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    return socket.destroy();
  }
  // Browsers let any website open a WebSocket here and attach the Access cookie.
  if (!sameOriginRequest(req, originPolicy)) {
    console.warn(`refused cross-site WebSocket from ${String(req.headers.origin ?? "unknown").slice(0, 120)}`);
    socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    return socket.destroy();
  }
  const url = new URL(req.url!, "http://x");
  if (url.pathname === "/api/voice/cloud/live") return liveDictationUpgrade(req, socket, head, url);
  let route;
  try { route = environmentPath(url.pathname); } catch { socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"); return; }
  const isPreview = route.path === "/api/preview-stream/ws";
  if ((route.path !== "/ws" && !isPreview) || !(await authed(req).catch(() => false))) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    return socket.destroy();
  }
  let environment: EnvironmentTarget;
  try { environment = await resolveEnvironment(route.environmentId); } catch (error) {
    socket.end(`HTTP/1.1 ${(error as HttpError).status ?? 502} Environment unavailable\r\nConnection: close\r\n\r\n`); return;
  }
  if (isPreview) return proxyPreviewStream(req, socket, head, url, environment);
  wss.handleUpgrade(req, socket, head, (client) => {
    const target = new URL(environment.baseUrl.replace(/^http/, "ws") + "/ws");
    target.searchParams.set("orchestrationProtocol", "2");
    target.searchParams.set("clientSurface", "web");
    target.searchParams.set("clientAppVersion", "bot-0.1.0");
    const upstream = new WebSocket(target, { headers: { authorization: `Bearer ${environment.token}` } });
    const queue: (RawData | string)[] = [];
    upstream.on("open", () => { for (const m of queue.splice(0)) upstream.send(m); });
    client.on("message", (data, isBinary) => {
      const msg = isBinary ? data : data.toString();
      if (upstream.readyState === WebSocket.OPEN) upstream.send(msg);
      else queue.push(msg);
    });
    upstream.on("message", (data, isBinary) => client.readyState === WebSocket.OPEN && client.send(isBinary ? data : data.toString()));
    const closeBoth = () => { try { client.close(); } catch {} try { upstream.close(); } catch {} };
    upstream.on("close", closeBoth);
    upstream.on("error", (e) => { console.error("upstream ws error", e.message); closeBoth(); });
    client.on("close", closeBoth);
    client.on("error", closeBoth);
  });
});

// ---------- machines ----------
// Settings → Machines, remote threads in the app, and offline alerts. See machines.mts.
const localDescriptor = async () => {
  const response = await fetch(cfg.t3Url + "/.well-known/t3/environment", { signal: AbortSignal.timeout(5000) });
  return response.ok ? response.json() : null;
};
const machines = createMachines({
  appDir, t3Url: cfg.t3Url, version, localDescriptor,
  // Feature-detected: T3 older than 0.1.9 has no links, and Threebot keeps only its direct routes.
  async listLinks() {
    if ((await localDescriptor().catch(() => null))?.capabilities?.peerLinks !== true) return null;
    const result = await withTimeout((await withTimeout(t3rpc(), 10000, "T3 timed out")).call("peerLinks.list", {}), 45000, "T3 timed out");
    return Array.isArray(result?.links) ? result.links as PeerLink[] : null;
  },
  async routeFiles() {
    const merged: Record<string, { baseUrl: string }> = {};
    for (const file of routeFiles.filter((name): name is string => Boolean(name)).reverse()) Object.assign(merged, await readRoutes(file).catch(() => ({})));
    return merged;
  },
});
const t3Mcp = createT3Mcp({ baseUrl: cfg.t3Url, token, file: path.join(appDir, "machines", "t3-mcp.json") });
async function machineFor(environmentId: string): Promise<Machine> {
  const machine = (await machines.list()).machines.find((candidate) => candidate.environmentId === environmentId && !candidate.local);
  if (!machine) throw Object.assign(new Error("That machine isn't linked to this T3 Code."), { status: 404 });
  return machine;
}
/** A remote thread read through T3's link: its latest messages, or the ones after `after`. */
async function readLinkedThread(environmentId: string, threadId: string, after: number | null) {
  const read = (afterPosition?: number) => t3Mcp.call("t3_thread_read", { environmentId, threadId, view: "messages", limit: 100, maxCharsPerItem: 20000, runLimit: 1, ...(afterPosition === undefined ? {} : { afterPosition }) });
  if (after !== null) return read(after);
  // No position yet: find the end, then read the tail of the conversation.
  const head = await read();
  const count = Number(head?.thread?.itemCount) || 0;
  return count > 200 && head?.hasMore ? read(count - 200) : head;
}
const outageAlerts = createOutageAlerts({
  file: path.join(appDir, "machines", "outages.json"), log: (line) => console.log(line),
  post: async (mainThreadId, text) => (await withTimeout(t3rpc(), 10000, "T3 timed out")).dispatch({
    type: "message.dispatch", threadId: mainThreadId, messageId: randomUUID(), text, attachments: [],
    createdBy: "agent", creationSource: "server", dispatchMode: { type: "queue_after_active" },
  }),
});
/** The Bots whose main threads have tasks still running on a machine. Throws after the rest if any couldn't be read, so they're tried again. */
async function botWorkOn(environmentId: string): Promise<BotWork[]> {
  const out: BotWork[] = [];
  const unread: string[] = [];
  for (const bot of await listBots()) {
    if (!bot.mainThreadId) continue;
    const projection = await withTimeout((await withTimeout(t3rpc(), 10000, "T3 timed out")).call("orchestration.getThreadProjection", { threadId: bot.mainThreadId }), 15000, "T3 timed out").catch(() => { unread.push(bot.slug); return null; });
    const threads = remoteThreads(projection, environmentId);
    if (threads.length) out.push({ slug: bot.slug, mainThreadId: bot.mainThreadId, threads });
  }
  if (unread.length) throw Object.assign(new Error(`couldn't read ${unread.join(", ")}`), { partial: out });
  return out;
}
function startMachineMonitor() {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try { await outageAlerts.observe((await machines.list({ maxAge: 0 })).machines, botWorkOn); }
    catch (error) { console.error("machines: monitor", (error as Error).message); }
    finally { busy = false; }
  };
  // THREEBOT_MACHINE_POLL_MS is for the disposable fixture; a minute is plenty for real outages.
  const every = Math.max(500, Number(process.env.THREEBOT_MACHINE_POLL_MS) || 60_000);
  setInterval(tick, every).unref();
  setTimeout(tick, Math.min(every, 5_000)).unref();
}
/** Settings → Machines → Where coding work runs, as stored: two machines by id, either may be empty. */
function codingWorkPatch(value: unknown): CodingWork | null {
  if (value === null) return null;
  const machine = (raw: unknown) => {
    if (raw === null || raw === undefined) return null;
    const candidate = raw as { environmentId?: unknown; label?: unknown };
    if (typeof candidate.environmentId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(candidate.environmentId)) throw Object.assign(new Error("Pick a linked machine"), { status: 400 });
    return { environmentId: candidate.environmentId, label: String(candidate.label ?? "").replace(/[\r\n`*]/g, " ").trim().slice(0, 80) || "Linked machine" };
  };
  if (!value || typeof value !== "object") throw Object.assign(new Error("codingWork must be an object or null"), { status: 400 });
  const work = value as { preferred?: unknown; fallback?: unknown };
  return { preferred: machine(work.preferred), fallback: machine(work.fallback) };
}

const provisioner = startProvisioner({ t3Url: cfg.t3Url, token, listBots, saveBot, getSettings });

// Bot instructions may have changed with this version of the gateway.
refreshAllAgentsMd().catch((e) => console.error("refreshing AGENTS.md failed", e));
startMemoryWatcher();
startMachineMonitor();

// Web Push: one shell subscription, one push per Bot transition. It reconnects if T3 restarts.
const pushNotifier = createPushNotifier({
  connect: t3rpc,
  bots: listBots,
  send: (payload: PushPayload) => pushStore.send(payload),
  preview: async (threadId, stamp) => {
    const previews = await threadPreviews({ [threadId]: stamp ?? new Date().toISOString() }).catch(() => null);
    return previews?.[threadId] ?? null;
  },
});
pushNotifier.start();

if (envTailnet) {
  if (!exposure.tailnetUsers.size) throw new Error("TAILNET_PORT needs TAILNET_USERS");
  await openTailnet(exposure.tailnetPort, [...exposure.tailnetUsers]);
}
// Tailscale and Cloudflare links switched on in Settings come back with the gateway.
remoteAccess.boot().catch((e) => console.error("remote access", e));
for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => { remoteAccess.stop(); process.exit(0); });
// An update this gateway's predecessor started either worked or rolled back; record which for the app.
await autoUpdate.settle().catch((error) => console.error("auto-update: couldn't read its state", error));
// Copies that can update themselves check on their own, so the sidebar's update button shows without
// anyone opening Settings, and an automatic update can start. The checker answers from its stored
// result until a check is due; the automatic update acts once per new answer.
if (selfUpdating) startUpdateChecks(() => checkUpdates().then(autoUpdate.consider).catch((error) => console.error("auto-update failed", error)));
telemetry.start();
server.listen(cfg.port, cfg.host, () => {
  console.log(`bot gateway on http://${cfg.host}:${cfg.port} → T3 ${cfg.t3Url}, bots in ${cfg.botsRoot}`);
});
