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
  // gpt-4o-transcribe and gpt-4o-mini-transcribe shut down on 2027-02-26.
  openai: ["gpt-transcribe", "gpt-4o-transcribe", "gpt-4o-mini-transcribe"],
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
        form.set("model", model);
        // gpt-transcribe takes a list of possible languages; the older models take one.
        if (model === "gpt-transcribe") for (const code of hints.iso) form.append("languages[]", code);
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

  return { status, update, transcribe };
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
