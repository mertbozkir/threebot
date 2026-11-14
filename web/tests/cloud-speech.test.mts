import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, test } from "node:test";
import { buildOnce, entryChunk } from "./support.mts";

const bundle = await buildOnce({ configFile: false, logLevel: "silent", build: { ssr: new URL("../src/lib/cloudSpeech.ts", import.meta.url).pathname, write: false }, ssr: { noExternal: true } });
const directory = await mkdtemp(join(tmpdir(), "bot-cloud-speech-"));
const file = join(directory, "module.mjs");
await writeFile(file, entryChunk(bundle).code);
const { encodeWav, transcribeInCloud } = await import(pathToFileURL(file).href);
await rm(directory, { recursive: true });

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

test("recordings become 16 kHz mono 16-bit WAV with clamped samples", () => {
  const wav: Uint8Array = encodeWav(new Float32Array([0, 1, -1, 2, Number.NaN]));
  const view = new DataView(wav.buffer);
  const text = (offset: number, length: number) => String.fromCharCode(...wav.slice(offset, offset + length));
  assert.equal(text(0, 4), "RIFF");
  assert.equal(text(8, 4), "WAVE");
  assert.equal(view.getUint16(22, true), 1, "mono");
  assert.equal(view.getUint32(24, true), 16_000);
  assert.equal(view.getUint16(34, true), 16, "16-bit");
  assert.equal(view.getUint32(40, true), 10, "data bytes");
  assert.equal(wav.length, 54);
  assert.deepEqual([0, 1, 2, 3, 4].map((i) => view.getInt16(44 + i * 2, true)), [0, 32767, -32768, 32767, 0]);
});

test("transcription posts WAV with the voice language and surfaces the gateway's error", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return Response.json({ text: " Merhaba " }); }) as typeof fetch;
  assert.equal(await transcribeInCloud(new Float32Array(16), "tr-TR"), "Merhaba");
  assert.equal(calls[0]!.url, "/api/voice/cloud/transcribe?lang=tr-TR");
  assert.equal((calls[0]!.init.headers as Record<string, string>)["content-type"], "audio/wav");
  globalThis.fetch = (async () => Response.json({ error: "OpenAI rejected the API key" }, { status: 502 })) as typeof fetch;
  await assert.rejects(transcribeInCloud(new Float32Array(16), "tr-TR"), /rejected the API key/);
});
