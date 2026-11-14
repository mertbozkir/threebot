// Dictation transcribed by a hosted model (OpenAI or Gemini) instead of the browser or T3 Code.
// The browser records and sends 16 kHz mono WAV here; the gateway adds the API key and calls the
// provider, so the key never reaches the browser. Off until the user picks a provider and saves a key.
// Keys are stored encrypted with the Vault's key, in their own file.
import fs from "node:fs/promises";
import { decrypt, encrypt, loadOrCreateKey, writeAtomic, type VaultEnvelope } from "./vault.mts";

export const PROVIDERS = ["openai", "gemini"] as const;
export type Provider = (typeof PROVIDERS)[number];

/** Models each provider offers for recorded speech. The first is the default. */
export const MODELS: Record<Provider, readonly string[]> = {
  // Dictation streams to OpenAI live (see relayLiveDictation). gpt-live-transcribe writes word by word and,
  // measured on mixed Turkish and English, kept English terms that gpt-4o-transcribe garbled when it
  // transcribed each pause on its own. gpt-4o-transcribe and gpt-4o-mini-transcribe shut down on 2027-02-26.
  openai: ["gpt-live-transcribe", "gpt-4o-transcribe", "gpt-transcribe", "gpt-4o-mini-transcribe"],
  gemini: ["gemini-3.5-transcribe"],
};

/** 5 minutes of 16 kHz mono 16-bit PCM is 9.6 MB; OpenAI accepts at most 25 MB. */
export const MAX_AUDIO_BYTES = 12 * 1024 * 1024;
const TIMEOUT_MS = 90_000;

type Stored = { provider: Provider | null; models: Record<Provider, string>; keys: Partial<Record<Provider, string>> };
export type CloudTranscriptionStatus = { provider: Provider | null; model: string | null; models: Record<Provider, string>; options: typeof MODELS; hasKey: Record<Provider, boolean> };
export type CloudTranscriptionPatch = { provider?: Provider | null; model?: string; apiKey?: { provider: Provider; value: string } };

const DEFAULTS: Stored = { provider: null, models: { openai: MODELS.openai[0]!, gemini: MODELS.gemini[0]! }, keys: {} };

function httpError(status: number, message: string) {
  return Object.assign(new Error(message), { status });
}

const isProvider = (value: unknown): value is Provider => PROVIDERS.includes(value as Provider);

/** The language hints both providers take: the user's voice language plus English, for mixed speech. */
export function languageHints(lang: string): { iso: string[]; bcp47: string[] } {
  const tag = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(lang) ? lang : "";
  const base = tag.split("-")[0] ?? "";
  if (!base) return { iso: [], bcp47: [] };
  return base === "en" ? { iso: ["en"], bcp47: [tag] } : { iso: [base, "en"], bcp47: [tag, "en-US"] };
}

export function createCloudTranscription({ file, keyFile, fetch: request = globalThis.fetch }: { file: string; keyFile: string; fetch?: typeof globalThis.fetch }) {
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T,>(task: () => Promise<T>) => { const next = queue.then(task, task); queue = next.catch(() => {}); return next; };

  async function load(): Promise<Stored> {
    let text: string;
    try { text = await fs.readFile(file, "utf8"); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(DEFAULTS); throw e; }
    const saved = decrypt(await loadOrCreateKey(keyFile), JSON.parse(text) as VaultEnvelope) as unknown as Partial<Stored>;
    const models = { ...DEFAULTS.models };
    for (const provider of PROVIDERS) if (MODELS[provider].includes(saved.models?.[provider] ?? "")) models[provider] = saved.models![provider];
    const keys: Stored["keys"] = {};
    for (const provider of PROVIDERS) if (typeof saved.keys?.[provider] === "string" && saved.keys[provider]) keys[provider] = saved.keys[provider];
    return { provider: isProvider(saved.provider) ? saved.provider : null, models, keys };
  }

  const save = async (stored: Stored) => writeAtomic(file, JSON.stringify(encrypt(await loadOrCreateKey(keyFile), stored)));

  const view = (stored: Stored): CloudTranscriptionStatus => ({
    provider: stored.provider,
    model: stored.provider ? stored.models[stored.provider] : null,
    models: stored.models,
    options: MODELS,
    hasKey: { openai: !!stored.keys.openai, gemini: !!stored.keys.gemini },
  });

  async function status() { return view(await load()); }

  function update(patch: CloudTranscriptionPatch) {
    return serial(async () => {
      const stored = await load();
      if (patch.apiKey !== undefined) {
        const { provider, value } = patch.apiKey ?? {};
        if (!isProvider(provider) || typeof value !== "string" || value.length > 512 || /[\s\x00-\x1f]/.test(value.trim())) throw httpError(400, "That API key doesn't look right.");
        if (value.trim()) stored.keys[provider] = value.trim(); else delete stored.keys[provider];
      }
      if (patch.provider !== undefined) {
        if (patch.provider !== null && !isProvider(patch.provider)) throw httpError(400, "Unknown transcription provider.");
        stored.provider = patch.provider;
      }
      if (patch.model !== undefined) {
        const provider = stored.provider;
        if (!provider || !MODELS[provider].includes(patch.model)) throw httpError(400, "Pick one of the listed models.");
        stored.models[provider] = patch.model;
      }
      if (stored.provider && !stored.keys[stored.provider]) throw httpError(400, "Save an API key for this provider first.");
      await save(stored);
      return view(stored);
    });
  }

  async function transcribe(wav: Buffer, lang: string): Promise<string> {
    const stored = await load();
    const provider = stored.provider;
    const key = provider ? stored.keys[provider] : undefined;
    if (!provider || !key) throw httpError(409, "Cloud transcription is off. Turn it on in Settings › Voice.");
    if (!wav.length || wav.length > MAX_AUDIO_BYTES) throw httpError(413, "That recording is too long to transcribe.");
    const hints = languageHints(lang);
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    const model = stored.models[provider];
    let res: Response;
    try {
      if (provider === "openai") {
        const form = new FormData();
        form.set("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "speech.wav");
        // gpt-transcribe takes a list of possible languages; the older models take one.
        // gpt-live-transcribe only streams; its file counterpart is gpt-transcribe.
        const fileModel = model === "gpt-live-transcribe" ? "gpt-transcribe" : model;
        form.set("model", fileModel);
        if (fileModel === "gpt-transcribe") for (const code of hints.iso) form.append("languages[]", code);
        form.set("response_format", "json");
        res = await request("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { authorization: `Bearer ${key}` }, body: form, signal });
      } else {
        const body = {
          contents: [{ parts: [{ inline_data: { mime_type: "audio/wav", data: wav.toString("base64") } }] }],
          generationConfig: { audioTranscriptionConfig: { languageCodes: hints.bcp47 } },
        };
        res = await request(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
          method: "POST", headers: { "x-goog-api-key": key, "content-type": "application/json" }, body: JSON.stringify(body), signal,
        });
      }
    } catch (e) {
      const name = (e as Error)?.name;
      throw httpError(502, name === "TimeoutError" ? `${label(provider)} took too long to transcribe.` : `Couldn't reach ${label(provider)}.`);
    }
    const data: unknown = await res.json().catch(() => null);
    if (!res.ok) throw httpError(502, providerError(provider, res.status, data));
    return extractText(provider, data);
  }

  /** The key and model for a live session, or why there can't be one. */
  async function liveTarget() {
    const stored = await load();
    if (stored.provider !== "openai" || !stored.keys.openai) throw httpError(409, "Live dictation needs OpenAI. Turn it on in Settings › Beta.");
    return { key: stored.keys.openai, model: stored.models.openai };
  }

  return { status, update, transcribe, liveTarget };
}

/** 5 minutes of dictation, plus time to finish the last phrase. Stops a recording left on by mistake. */
export const MAX_LIVE_MS = 5 * 60 * 1000 + 15_000;
const FINISH_MS = 8_000;

/** The parts of a WebSocket both ends use: `ws` on the server, a fake in tests. */
export type LiveSocket = {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "message", listener: (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => void): unknown;
  on(event: "close", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "open", listener: () => void): unknown;
};
const OPEN = 1;

/** OpenAI's session settings: the live model has no voice detection, so the session commits once at the end. */
export function liveSessionConfig(model: string, lang: string) {
  const hints = languageHints(lang);
  const live = model === "gpt-live-transcribe";
  const transcription = live || model === "gpt-transcribe"
    ? { model, ...(hints.iso.length ? { languages: hints.iso } : {}) }
    : { model, ...(hints.iso[0] ? { language: hints.iso[0] } : {}) };
  return {
    type: "session.update",
    session: { type: "transcription", audio: { input: {
      format: { type: "audio/pcm", rate: 24_000 },
      transcription,
      noise_reduction: { type: "near_field" },
      turn_detection: live ? null : { type: "server_vad", silence_duration_ms: 500 },
    } } },
  };
}

/**
 * Relays one dictation: the browser sends 24 kHz mono PCM16 frames and {"type":"stop"}; OpenAI's text
 * comes back as {"type":"delta"|"done", item, text} and {"type":"error", message}. The key stays here.
 */
export function relayLiveDictation(client: LiveSocket, upstream: LiveSocket, { model, lang, maxMs = MAX_LIVE_MS, finishMs = FINISH_MS, log = console }: { model: string; lang: string; maxMs?: number; finishMs?: number; log?: Pick<Console, "warn"> }) {
  const pending = new Set<string>();
  const queued: string[] = [];
  let stopping = false;
  let closed = false;
  let audioSinceCommit = false;
  const toClient = (event: object) => { if (client.readyState === OPEN) client.send(JSON.stringify(event)); };
  const toUpstream = (event: object) => {
    const text = JSON.stringify(event);
    if (upstream.readyState === OPEN) upstream.send(text); else queued.push(text);
  };
  const finish = (code = 1000, reason = "done") => {
    if (closed) return;
    closed = true;
    clearTimeout(cap);
    clearTimeout(finishTimer);
    if (upstream.readyState <= OPEN) upstream.close();
    if (client.readyState <= OPEN) client.close(code, reason);
  };
  let finishTimer: ReturnType<typeof setTimeout> | undefined;
  const maybeFinish = () => { if (stopping && pending.size === 0 && !audioSinceCommit) finish(); };
  const stop = () => {
    if (stopping) return;
    stopping = true;
    if (audioSinceCommit) toUpstream({ type: "input_audio_buffer.commit" });
    finishTimer = setTimeout(() => finish(), finishMs);
    maybeFinish();
  };
  const cap = setTimeout(() => { toClient({ type: "limit" }); stop(); }, maxMs);

  toUpstream(liveSessionConfig(model, lang));
  upstream.on("open", () => { for (const text of queued.splice(0)) upstream.send(text); });
  upstream.on("message", (data) => {
    let event: { type?: string; item_id?: string; delta?: string; transcript?: string; error?: { message?: string; code?: string } };
    try { event = JSON.parse(String(data)); } catch { return; }
    switch (event.type) {
      case "input_audio_buffer.committed":
        if (event.item_id) pending.add(event.item_id);
        audioSinceCommit = false;
        return;
      case "conversation.item.input_audio_transcription.delta":
        if (event.item_id && typeof event.delta === "string") toClient({ type: "delta", item: event.item_id, text: event.delta });
        return;
      case "conversation.item.input_audio_transcription.completed":
        if (event.item_id) { pending.delete(event.item_id); toClient({ type: "done", item: event.item_id, text: String(event.transcript ?? "") }); }
        return maybeFinish();
      case "conversation.item.input_audio_transcription.failed":
        if (event.item_id) pending.delete(event.item_id);
        toClient({ type: "error", message: "OpenAI couldn't transcribe part of that." });
        return maybeFinish();
      case "error":
        // Stopping right after a phrase was committed leaves nothing to commit; that's fine.
        if (stopping && event.error?.code === "input_audio_buffer_commit_empty") { audioSinceCommit = false; return maybeFinish(); }
        log.warn(`live dictation: OpenAI error ${event.error?.code ?? ""}`);
        toClient({ type: "error", message: `OpenAI: ${String(event.error?.message ?? "error").slice(0, 300)}` });
        return finish(1011, "upstream error");
    }
  });
  upstream.on("error", () => { toClient({ type: "error", message: "Couldn't reach OpenAI." }); finish(1011, "upstream error"); });
  upstream.on("close", () => finish(stopping ? 1000 : 1011, stopping ? "done" : "upstream closed"));

  client.on("message", (data, isBinary) => {
    if (closed) return;
    if (isBinary) {
      if (stopping) return;
      const frame = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
      // An odd byte count can't be PCM16; drop it rather than shift every later sample.
      if (!frame.length || frame.length % 2 || frame.length > 96_000) return;
      audioSinceCommit = true;
      toUpstream({ type: "input_audio_buffer.append", audio: frame.toString("base64") });
      return;
    }
    try { if (JSON.parse(String(data))?.type === "stop") stop(); } catch { /* ignore */ }
  });
  client.on("close", () => finish());
  client.on("error", () => finish());
  return { stop };
}

const label = (provider: Provider) => provider === "openai" ? "OpenAI" : "Gemini";

/** The provider's own message helps ("invalid API key", "quota exceeded"); it never contains the key. */
function providerError(provider: Provider, status: number, data: unknown) {
  const message = (data as { error?: { message?: unknown } } | null)?.error?.message;
  const detail = typeof message === "string" ? `: ${message.slice(0, 300)}` : "";
  if (status === 401 || status === 403) return `${label(provider)} rejected the API key${detail}`;
  if (status === 429) return `${label(provider)} is rate limiting or out of quota${detail}`;
  return `${label(provider)} couldn't transcribe that (HTTP ${status})${detail}`;
}

export function extractText(provider: Provider, data: unknown): string {
  if (provider === "openai") {
    const text = (data as { text?: unknown } | null)?.text;
    if (typeof text !== "string") throw httpError(502, "OpenAI returned no transcript.");
    return text.trim();
  }
  const parts = (data as { candidates?: { content?: { parts?: { text?: unknown }[] } }[] } | null)?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) throw httpError(502, "Gemini returned no transcript.");
  return parts.map((part) => typeof part.text === "string" ? part.text : "").join("").trim();
}
