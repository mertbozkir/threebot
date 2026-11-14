// Dictation transcribed by OpenAI or Gemini through the gateway, which holds the API key.
// The browser records (see t3Speech's startRecording), encodes 16 kHz mono WAV and posts it.
import { api } from "./api";
import { SPEECH_SAMPLE_RATE } from "./t3Speech";

export type CloudProvider = "openai" | "gemini";
export type CloudTranscription = {
  provider: CloudProvider | null;
  model: string | null;
  models: Record<CloudProvider, string>;
  options: Record<CloudProvider, string[]>;
  hasKey: Record<CloudProvider, boolean>;
};
export type CloudTranscriptionPatch = { provider?: CloudProvider | null; model?: string; apiKey?: { provider: CloudProvider; value: string } };

export const PROVIDER_LABELS: Record<CloudProvider, string> = { openai: "OpenAI", gemini: "Gemini" };

export const cloudTranscription = () => api.cloudTranscription();
export const saveCloudTranscription = (patch: CloudTranscriptionPatch) => api.saveCloudTranscription(patch);

/** 16-bit PCM WAV: both providers accept it, and it is half the size of Float32. */
export function encodeWav(pcm: Float32Array, sampleRate = SPEECH_SAMPLE_RATE): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(44 + pcm.length * 2);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) => { for (let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i); };
  text(0, "RIFF"); view.setUint32(4, 36 + pcm.length * 2, true); text(8, "WAVE");
  text(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, "data"); view.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) {
    const sample = Math.max(-1, Math.min(1, pcm[i] || 0));
    view.setInt16(44 + i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return bytes;
}

export async function transcribeInCloud(pcm: Float32Array, lang: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch(`/api/voice/cloud/transcribe?lang=${encodeURIComponent(lang)}`, {
    method: "POST", headers: { "content-type": "audio/wav" }, body: new Blob([encodeWav(pcm)], { type: "audio/wav" }), signal,
  });
  const body: unknown = await res.json().catch(() => null);
  const error = body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : null;
  if (!res.ok) throw new Error(error ?? `Couldn't transcribe that (HTTP ${res.status}).`);
  if (!body || typeof body !== "object" || !("text" in body) || typeof body.text !== "string") throw new Error("No transcript came back.");
  return body.text.trim();
}
