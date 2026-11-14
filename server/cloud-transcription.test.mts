import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCloudTranscription, extractText, languageHints } from "./cloud-transcription.mts";

type Call = { url: string; init: RequestInit };

async function setup(reply: (call: Call) => Response) {
  const dir = await mkdtemp(path.join(tmpdir(), "threebot-transcription-"));
  const calls: Call[] = [];
  const service = createCloudTranscription({
    file: path.join(dir, "transcription.json"),
    keyFile: path.join(dir, ".vault-key"),
    fetch: (async (url: string, init: RequestInit) => { const call = { url: String(url), init }; calls.push(call); return reply(call); }) as typeof fetch,
  });
  return { dir, calls, service };
}

const wav = Buffer.from("RIFF....WAVEfmt fake audio");

test("off by default, and a provider needs its key before it can be chosen", async () => {
  const { service, calls } = await setup(() => new Response("{}"));
  const status = await service.status();
  assert.equal(status.provider, null);
  assert.deepEqual(status.hasKey, { openai: false, gemini: false });
  await assert.rejects(service.update({ provider: "openai" }), /API key/);
  await assert.rejects(service.transcribe(wav, "tr-TR"), (e: any) => e.status === 409);
  assert.equal(calls.length, 0);
});

test("keys are stored encrypted and never returned", async () => {
  const { service, dir } = await setup(() => new Response("{}"));
  const status = await service.update({ apiKey: { provider: "openai", value: " sk-secret-123 " }, provider: "openai" });
  assert.equal(status.provider, "openai");
  assert.equal(status.model, "gpt-transcribe");
  assert.equal(status.hasKey.openai, true);
  assert.doesNotMatch(JSON.stringify(status), /sk-secret/);
  assert.doesNotMatch(await readFile(path.join(dir, "transcription.json"), "utf8"), /sk-secret/);
  await assert.rejects(service.update({ model: "whisper-1" }), /listed models/);
  await assert.rejects(service.update({ apiKey: { provider: "gemini", value: "has space" } }), /doesn't look right/);
  // Removing the key of the chosen provider would leave dictation broken; turn it off first.
  await assert.rejects(service.update({ apiKey: { provider: "openai", value: "" } }), /API key/);
  assert.equal((await service.update({ provider: null, apiKey: { provider: "openai", value: "" } })).hasKey.openai, false);
});

test("OpenAI gets the WAV, the model, and the voice language plus English as hints", async () => {
  const { service, calls } = await setup(() => Response.json({ text: " Merhaba, deploy ettim. " }));
  await service.update({ apiKey: { provider: "openai", value: "sk-test" }, provider: "openai" });
  assert.equal(await service.transcribe(wav, "tr-TR"), "Merhaba, deploy ettim.");
  const [call] = calls;
  assert.equal(call!.url, "https://api.openai.com/v1/audio/transcriptions");
  assert.equal((call!.init.headers as Record<string, string>).authorization, "Bearer sk-test");
  const form = call!.init.body as FormData;
  assert.equal(form.get("model"), "gpt-transcribe");
  assert.deepEqual(form.getAll("languages[]"), ["tr", "en"]);
  assert.equal((form.get("file") as File).type, "audio/wav");
  assert.equal(Buffer.from(await (form.get("file") as File).arrayBuffer()).toString(), wav.toString());
});

test("older OpenAI models get no languages list", async () => {
  const { service, calls } = await setup(() => Response.json({ text: "ok" }));
  await service.update({ apiKey: { provider: "openai", value: "sk-test" }, provider: "openai" });
  await service.update({ model: "gpt-4o-transcribe" });
  await service.transcribe(wav, "tr-TR");
  assert.deepEqual((calls[0]!.init.body as FormData).getAll("languages[]"), []);
});

test("Gemini gets inline WAV with language codes and returns the joined text", async () => {
  const { service, calls } = await setup(() => Response.json({ candidates: [{ content: { parts: [{ text: "Toplantı " }, { text: "yarın." }] } }] }));
  await service.update({ apiKey: { provider: "gemini", value: "AIza-test" }, provider: "gemini" });
  assert.equal(await service.transcribe(wav, "tr-TR"), "Toplantı yarın.");
  const [call] = calls;
  assert.equal(call!.url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-transcribe:generateContent");
  assert.equal((call!.init.headers as Record<string, string>)["x-goog-api-key"], "AIza-test");
  const body = JSON.parse(String(call!.init.body));
  assert.equal(body.contents[0].parts[0].inline_data.mime_type, "audio/wav");
  assert.equal(Buffer.from(body.contents[0].parts[0].inline_data.data, "base64").toString(), wav.toString());
  assert.deepEqual(body.generationConfig.audioTranscriptionConfig.languageCodes, ["tr-TR", "en-US"]);
});

test("provider failures become readable errors without the key", async () => {
  const { service } = await setup(() => Response.json({ error: { message: "Incorrect API key provided" } }, { status: 401 }));
  await service.update({ apiKey: { provider: "openai", value: "sk-wrong" }, provider: "openai" });
  await assert.rejects(service.transcribe(wav, "en-US"), (e: any) => e.status === 502 && /rejected the API key: Incorrect API key/.test(e.message) && !/sk-wrong/.test(e.message));
  await assert.rejects(service.transcribe(Buffer.alloc(0), "en-US"), (e: any) => e.status === 413);
});

test("language hints and transcript parsing", () => {
  assert.deepEqual(languageHints("tr-TR"), { iso: ["tr", "en"], bcp47: ["tr-TR", "en-US"] });
  assert.deepEqual(languageHints("en-GB"), { iso: ["en"], bcp47: ["en-GB"] });
  assert.deepEqual(languageHints("not a tag!"), { iso: [], bcp47: [] });
  assert.throws(() => extractText("openai", {}), /no transcript/);
  assert.throws(() => extractText("gemini", { candidates: [] }), /no transcript/);
});
