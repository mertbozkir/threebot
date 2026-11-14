import type { CloudTranscription, CloudTranscriptionPatch } from "./cloudSpeech";
import type { AdoptableProject, Bot, Machine, Settings, ThreadMeta, ThreadPreview } from "./types";

type Session = { authenticated: boolean; passwordRequired: boolean; accessLogin: boolean };

async function session(): Promise<Session> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch("/api/session", { signal: controller.signal, redirect: "manual", cache: "no-store" });
    // Cloudflare Access answers an ended session with a redirect to its login host.
    if (response.type === "opaqueredirect") return { authenticated: false, passwordRequired: false, accessLogin: true };
    if (!response.ok || response.redirected || response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw new Error("Couldn't verify your session.");
    const value: unknown = await response.json();
    if (!value || typeof value !== "object" || !("authenticated" in value) || typeof value.authenticated !== "boolean"
      || !("passwordRequired" in value) || typeof value.passwordRequired !== "boolean"
      || !("accessLogin" in value) || typeof value.accessLogin !== "boolean") throw new Error("Couldn't verify your session.");
    return { authenticated: value.authenticated, passwordRequired: value.passwordRequired, accessLogin: value.accessLogin };
  } finally {
    clearTimeout(timer);
  }
}

async function req<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: init.body ? { "content-type": "application/json", ...(init.headers ?? {}) } : init.headers,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error ?? `HTTP ${res.status}`), { status: res.status });
  return body as T;
}

/** What the last automatic update did, until the app has shown it once. */
export type UpdateNotice = { kind: "updated" | "rolledBack" | "failed" | "waited"; version: string; from: string; url: string; at: string };
/** A release as the gateway passes it on; `notes` is the raw GitHub body, parsed by lib/releaseNotes. */
export type ReleaseInfo = { version: string; url: string; notes: string; publishedAt: string | null };
export type SystemInfo = { version: string; installed: boolean; service: boolean; latest: ReleaseInfo | null; current?: ReleaseInfo | null; updateAvailable: boolean; error: string | null; checkedAt: string | null;
  auto: boolean; waiting: { version: string; since: number } | null; notice: UpdateNotice | null };
export type TailscaleState = { installed: boolean; running?: boolean; needsLogin?: boolean; state?: string; authUrl: string | null; dnsName?: string | null; https?: boolean; login?: string | null; enabled: boolean; fromEnv: boolean; users: string[]; url?: string; serving?: boolean; error?: string };
export type AccessState = {
  password: { set: boolean; fromEnv: boolean };
  tailscale: TailscaleState;
  tunnel: { enabled: boolean; url: string | null; error: string | null; available: boolean };
  cloudflareAccess: { emails: string[] } | null;
};

/** Settings → Usage stats. `choice` is null until the user has answered the one-time question. */
export type TelemetryStatus = { enabled: boolean; choice: boolean | null; asked: boolean; blockedBy: "DO_NOT_TRACK" | "THREEBOT_TELEMETRY" | null;
  installId: string; lastSentAt: string | null; lastAttemptAt: string | null; lastError: string | null; endpoint: boolean };

/** One message of a thread on another machine, as T3's t3_thread_read returns it. */
export type RemoteItem = { position: number; itemId: string; type: string; createdBy?: string; text?: string | null; textTruncated?: boolean; updatedAt?: string; status?: string };
export type RemoteRead = {
  thread: { threadId: string; title: string; status: string; itemCount: number; activeRunId: string | null; pendingRequestCount?: number; updatedAt: string } | null;
  items: RemoteItem[]; nextPosition: number | null; hasMore: boolean;
};

export const api = {
  machines: (fresh = false) => req<{ machines: Machine[]; linksSupported: boolean }>(`/api/machines${fresh ? "?fresh=1" : ""}`),
  pairMachine: (environmentId: string, code: string, url?: string) => req<{ environmentId: string; baseUrl: string }>(`/api/machines/${encodeURIComponent(environmentId)}/pair`, { method: "POST", body: JSON.stringify({ code, ...(url ? { url } : {}) }) }),
  unpairMachine: (environmentId: string) => req<unknown>(`/api/machines/${encodeURIComponent(environmentId)}/pair`, { method: "DELETE" }),
  remoteThread: (environmentId: string, threadId: string, after: number | null) => req<{ machine: Machine; read: RemoteRead }>(`/api/machines/${encodeURIComponent(environmentId)}/threads/${encodeURIComponent(threadId)}${after === null ? "" : `?after=${after}`}`),
  sendRemote: (environmentId: string, threadId: string, text: string) => req<{ delivery?: string }>(`/api/machines/${encodeURIComponent(environmentId)}/threads/${encodeURIComponent(threadId)}/messages`, { method: "POST", body: JSON.stringify({ text }) }),
  telemetry: () => req<TelemetryStatus>("/api/telemetry"),
  setTelemetry: (enabled: boolean) => req<TelemetryStatus>("/api/telemetry", { method: "PUT", body: JSON.stringify({ enabled }) }),
  telemetryPreview: () => req<Record<string, unknown>>("/api/telemetry/preview"),
  resetTelemetryId: () => req<TelemetryStatus>("/api/telemetry/reset-id", { method: "POST", body: "{}" }),
  session,
  system: (check = false) => req<SystemInfo>(`/api/system${check ? "?check=1" : ""}`),
  setAutoUpdate: (auto: boolean) => req<Pick<SystemInfo, "auto" | "waiting" | "notice">>("/api/system/auto-update", { method: "PUT", body: JSON.stringify({ auto }) }),
  dismissUpdateNotice: (at: string) => req<unknown>(`/api/system/update-notice?at=${encodeURIComponent(at)}`, { method: "DELETE" }),
  startUpdate: () => req<{ started: boolean; version: string }>("/api/system/update", { method: "POST", body: "{}" }),
  health: () => req<{ ok: boolean; version: string }>("/api/health"),
  access: () => req<AccessState>("/api/access"),
  setPassword: (password: string | null) => req<AccessState>("/api/access/password", { method: "PUT", body: JSON.stringify({ password }) }),
  tailscale: (on: boolean) => req<AccessState>("/api/access/tailscale", { method: "POST", body: JSON.stringify({ on }) }),
  tunnel: (on: boolean) => req<AccessState>("/api/access/tunnel", { method: "POST", body: JSON.stringify({ on }) }),
  login: (password: string) => req("/api/login", { method: "POST", body: JSON.stringify({ password }) }),
  logout: () => req("/api/logout"),
  config: (signal?: AbortSignal) => req<{ botsRoot: string; accessLogout?: boolean; executorUrl?: string | null }>("/api/config", { signal }),
  settings: (signal?: AbortSignal) => req<Settings>("/api/settings", { signal }),
  saveSettings: (patch: Partial<Settings>) => req<Settings>("/api/settings", { method: "PUT", body: JSON.stringify(patch) }),
  cloudTranscription: () => req<CloudTranscription>("/api/voice/cloud", { cache: "no-store" }),
  saveCloudTranscription: (patch: CloudTranscriptionPatch) => req<CloudTranscription>("/api/voice/cloud", { method: "PUT", body: JSON.stringify(patch) }),
  bots: (signal?: AbortSignal) => req<{ bots: Bot[] }>("/api/bots", { signal }).then((r) => r.bots),
  botIdentities: (signal?: AbortSignal) => req<{ bots: Bot[] }>("/api/bot-identities", { signal }).then((r) => r.bots),
  createBot: (input: Partial<Bot>) => req<Bot>("/api/bots", { method: "POST", body: JSON.stringify(input) }),
  saveBot: (slug: string, patch: Partial<Bot>) => req<Bot>(`/api/bots/${slug}`, { method: "PUT", body: JSON.stringify(patch) }),
  setMainBot: (slug: string) => req<{ bots: Bot[] }>("/api/main-bot", { method: "PUT", body: JSON.stringify({ slug }) }),
  deleteBot: (slug: string) => req<{ ok: true; bots: Bot[] }>(`/api/bots/${slug}`, { method: "DELETE" }),
  adoptableProjects: () => req<{ projects: AdoptableProject[] }>("/api/adoptable-projects").then((r) => r.projects),
  adoptProject: (input: Partial<Bot> & { projectId: string; threadId: string | null }) => req<Bot>("/api/bots/adopt", { method: "POST", body: JSON.stringify(input) }),
  releaseBot: (slug: string) => req<{ bots: Bot[]; archive: string | null }>(`/api/bots/${slug}/release`, { method: "POST", body: "{}" }),
  threadPreviews: (stamps: Record<string, string>) => req<{ previews: Record<string, ThreadPreview> }>("/api/thread-previews", { method: "POST", body: JSON.stringify({ stamps }) }).then((r) => r.previews),
  threadMeta: (threadId: string) => req<ThreadMeta>(`/api/thread-meta?thread=${encodeURIComponent(threadId)}`),
  toggleReaction: (threadId: string, itemId: string, emoji: string) => req<ThreadMeta>("/api/thread-meta/reactions", { method: "POST", body: JSON.stringify({ threadId, itemId, emoji }) }),
  addVoiceCall: (threadId: string, seconds: number) => req<ThreadMeta>("/api/thread-meta/voice-calls", { method: "POST", body: JSON.stringify({ threadId, seconds }) }),
};

/** Behind Cloudflare Access, signing out means ending the Access session too. Ask before the local session goes. */
export async function signOutTarget() {
  try { return (await api.config()).accessLogout ? "/cdn-cgi/access/logout" : "/"; } catch { return "/"; }
}
