import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { createCloudTranscription, extractText, languageHints, liveSessionConfig, providerMessage, relayLiveDictation } from "./cloud-transcription.mts";

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
  assert.equal(status.model, "gpt-live-transcribe", "the recommended model");
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
  await service.update({ model: "gpt-transcribe" });
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

test("older OpenAI models get no languages list, and the live-only model records with gpt-transcribe", async () => {
  const { service, calls } = await setup(() => Response.json({ text: "ok" }));
  await service.update({ apiKey: { provider: "openai", value: "sk-test" }, provider: "openai" });
  await service.update({ model: "gpt-4o-transcribe" });
  await service.transcribe(wav, "tr-TR");
  assert.equal((calls[0]!.init.body as FormData).get("model"), "gpt-4o-transcribe");
  assert.deepEqual((calls[0]!.init.body as FormData).getAll("languages[]"), []);
  await service.update({ model: "gpt-live-transcribe" });
  await service.transcribe(wav, "tr-TR");
  assert.equal((calls[1]!.init.body as FormData).get("model"), "gpt-transcribe");
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
  const { service } = await setup(() => Response.json({ error: { message: "Incorrect API key provided: sk-wrong. You can find your API key at https://platform.openai.com/account/api-keys." } }, { status: 401 }));
  await service.update({ apiKey: { provider: "openai", value: "sk-wrong" }, provider: "openai" });
  // OpenAI quotes the (masked) key it got; none of it reaches the browser or the log.
  await assert.rejects(service.transcribe(wav, "en-US"), (e: any) => e.status === 502 && /rejected the API key: Incorrect API key provided: \[key\]\. You can find/.test(e.message) && !/sk-/.test(e.message));
  assert.equal(providerMessage("API key not valid: AIzaSyD-abc_123. Please pass a valid API key."), "API key not valid: [key]. Please pass a valid API key.");
  await assert.rejects(service.transcribe(Buffer.alloc(0), "en-US"), (e: any) => e.status === 413);
});

test("language hints and transcript parsing", () => {
  assert.deepEqual(languageHints("tr-TR"), { iso: ["tr", "en"], bcp47: ["tr-TR", "en-US"] });
  assert.deepEqual(languageHints("en-GB"), { iso: ["en"], bcp47: ["en-GB"] });
  assert.deepEqual(languageHints("not a tag!"), { iso: [], bcp47: [] });
  assert.throws(() => extractText("openai", {}), /no transcript/);
  assert.throws(() => extractText("gemini", { candidates: [] }), /no transcript/);
});

class FakeSocket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  sent: string[] = [];
  closedWith: number | undefined;
  send(data: string) { this.sent.push(data); }
  close(code = 1000) { if (this.readyState === 3) return; this.readyState = 3; this.closedWith = code; this.emit("close"); }
  events() { return this.sent.map((text) => JSON.parse(text)); }
}
const upstreamEvent = (socket: FakeSocket, event: object) => socket.emit("message", Buffer.from(JSON.stringify(event)), false);

test("live relay: fast audio stops at five minutes, regardless of elapsed time", () => {
  const client = new FakeSocket(), upstream = new FakeSocket();
  relayLiveDictation(client, upstream, { model: "gpt-live-transcribe", lang: "en-US" });
  try {
    for (let i = 0; i < 200; i++) client.emit("message", Buffer.alloc(96_000), true);
    const bytes = upstream.events().filter(event => event.type === "input_audio_buffer.append")
      .reduce((sum, event) => sum + Buffer.byteLength(event.audio, "base64"), 0);
    assert.equal(bytes, 14_400_000, "at most 300 seconds of 24 kHz mono PCM16");
    assert.equal(client.events().filter(event => event.type === "limit").length, 1);
  } finally { client.close(); }
});

test("live relay: a connecting or slow upstream cannot accumulate an unbounded queue", () => {
  for (const connecting of [true, false]) {
    const client = new FakeSocket(), upstream = new FakeSocket();
    if (connecting) upstream.readyState = 0;
    else upstream.bufferedAmount = 2 * 1024 * 1024;
    relayLiveDictation(client, upstream, { model: "gpt-live-transcribe", lang: "en-US" });
    try {
      for (let i = 0; i < 20; i++) client.emit("message", Buffer.alloc(96_000), true);
      assert.equal(client.closedWith, 1013, "stops a stalled relay before memory keeps growing");
      assert.equal(upstream.readyState, 3);
    } finally { client.close(); }
  }
});

test("live relay: an upstream that never opens times out without sending queued audio later", async () => {
  const client = new FakeSocket(), upstream = new FakeSocket();
  upstream.readyState = 0;
  relayLiveDictation(client, upstream, { model: "gpt-live-transcribe", lang: "en-US", connectMs: 10 });
  client.emit("message", Buffer.alloc(4_800), true);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(client.closedWith, 1011);
  upstream.readyState = 1;
  upstream.emit("open");
  assert.equal(upstream.sent.length, 0, "does not flush after shutdown");
  upstream.close();
});

test("live relay: Stop preserves later audio across a delayed earlier commit", () => {
  const client = new FakeSocket(), upstream = new FakeSocket();
  relayLiveDictation(client, upstream, { model: "gpt-4o-transcribe", lang: "en-US" });
  try {
    client.emit("message", Buffer.alloc(4_800), true);
    client.emit("message", Buffer.alloc(4_800), true);
    upstreamEvent(upstream, { type: "input_audio_buffer.committed", item_id: "a" });
    client.emit("message", Buffer.from('{"type":"stop"}'), false);
    assert.equal(upstream.events().filter(event => event.type === "input_audio_buffer.commit").length, 1);
    upstreamEvent(upstream, { type: "conversation.item.input_audio_transcription.completed", item_id: "a", transcript: "First phrase." });
    assert.equal(client.closedWith, undefined, "earlier completion cannot end the final flush");
    upstreamEvent(upstream, { type: "input_audio_buffer.committed", item_id: "b", previous_item_id: "a" });
    upstreamEvent(upstream, { type: "input_audio_buffer.cleared" });
    assert.equal(client.closedWith, undefined, "waits for the final phrase's text");
    upstreamEvent(upstream, { type: "conversation.item.input_audio_transcription.completed", item_id: "b", transcript: "Last phrase." });
    assert.equal(client.events().filter(event => event.type === "done").at(-1).text, "Last phrase.");
    assert.equal(client.closedWith, 1000);
  } finally { client.close(); }
});

test("live relay: committed item order reaches the browser before out-of-order transcripts", () => {
  const client = new FakeSocket(), upstream = new FakeSocket();
  relayLiveDictation(client, upstream, { model: "gpt-4o-transcribe", lang: "en-US" });
  try {
    upstreamEvent(upstream, { type: "input_audio_buffer.committed", item_id: "a", previous_item_id: null });
    upstreamEvent(upstream, { type: "input_audio_buffer.committed", item_id: "b", previous_item_id: "a" });
    upstreamEvent(upstream, { type: "conversation.item.input_audio_transcription.completed", item_id: "b", transcript: "Second." });
    upstreamEvent(upstream, { type: "conversation.item.input_audio_transcription.completed", item_id: "a", transcript: "First." });
    assert.deepEqual(client.events().slice(0, 2), [
      { type: "committed", item: "a", previous: null },
      { type: "committed", item: "b", previous: "a" },
    ]);
  } finally { client.close(); }
});

test("live sessions: the live model has no voice detection; the others pause-detect; both get language hints", () => {
  const live = liveSessionConfig("gpt-live-transcribe", "tr-TR").session.audio.input;
  assert.deepEqual(live.format, { type: "audio/pcm", rate: 24_000 });
  assert.deepEqual(live.transcription, { model: "gpt-live-transcribe", languages: ["tr", "en"] });
  assert.equal(live.turn_detection, null);
  const phrases = liveSessionConfig("gpt-4o-transcribe", "tr-TR").session.audio.input;
  assert.deepEqual(phrases.transcription, { model: "gpt-4o-transcribe", language: "tr" });
  assert.equal(phrases.turn_detection?.type, "server_vad");
});

test("live relay: audio goes up as base64, text comes back, stop commits and closes after the last phrase", () => {
  const client = new FakeSocket(), upstream = new FakeSocket();
  relayLiveDictation(client as any, upstream as any, { model: "gpt-live-transcribe", lang: "tr-TR", log: { warn() {} } });
  assert.equal(upstream.events()[0].type, "session.update");
  client.emit("message", Buffer.from([1, 0, 2, 0]), true);
  client.emit("message", Buffer.from([1, 0, 2]), true); // odd length: not PCM16
  assert.deepEqual(upstream.events().slice(1), [{ type: "input_audio_buffer.append", audio: Buffer.from([1, 0, 2, 0]).toString("base64") }]);
  upstreamEvent(upstream, { type: "conversation.item.input_audio_transcription.delta", item_id: "a", delta: "Merhaba" });
  client.emit("message", Buffer.from(JSON.stringify({ type: "stop" })), false);
  assert.deepEqual(upstream.events().slice(-2).map(event => event.type), ["input_audio_buffer.commit", "input_audio_buffer.clear"]);
  client.emit("message", Buffer.from([1, 0]), true);
  assert.equal(upstream.events().filter((event) => event.type === "input_audio_buffer.append").length, 1, "no audio after stop");
  upstreamEvent(upstream, { type: "input_audio_buffer.committed", item_id: "a" });
  upstreamEvent(upstream, { type: "input_audio_buffer.cleared" });
  assert.equal(client.closedWith, undefined, "waits for the committed phrase");
  upstreamEvent(upstream, { type: "conversation.item.input_audio_transcription.completed", item_id: "a", transcript: "Merhaba dünya" });
  assert.deepEqual(client.events(), [{ type: "delta", item: "a", text: "Merhaba" }, { type: "committed", item: "a", previous: null }, { type: "done", item: "a", text: "Merhaba dünya" }]);
  assert.equal(client.closedWith, 1000);
  assert.equal(upstream.readyState, 3);
});

test("live relay: an empty final commit is fine, OpenAI errors reach the browser, and the cap stops a forgotten recording", async () => {
  const client = new FakeSocket(), upstream = new FakeSocket();
  relayLiveDictation(client as any, upstream as any, { model: "gpt-4o-transcribe", lang: "en-US", log: { warn() {} } });
  client.emit("message", Buffer.from([0, 0]), true);
  upstreamEvent(upstream, { type: "input_audio_buffer.committed", item_id: "a" });
  upstreamEvent(upstream, { type: "conversation.item.input_audio_transcription.completed", item_id: "a", transcript: "Hi." });
  client.emit("message", Buffer.from([0, 0]), true);
  client.emit("message", Buffer.from(JSON.stringify({ type: "stop" })), false);
  upstreamEvent(upstream, { type: "error", error: { code: "input_audio_buffer_commit_empty", message: "buffer too small" } });
  assert.equal(client.closedWith, undefined, "an empty commit still waits for the flush acknowledgement");
  upstreamEvent(upstream, { type: "input_audio_buffer.cleared" });
  assert.equal(client.closedWith, 1000);
  assert.ok(!client.events().some((event) => event.type === "error"));

  const client2 = new FakeSocket(), upstream2 = new FakeSocket();
  relayLiveDictation(client2 as any, upstream2 as any, { model: "gpt-4o-transcribe", lang: "en-US", log: { warn() {} } });
  upstreamEvent(upstream2, { type: "error", error: { code: "invalid_api_key", message: "Incorrect API key" } });
  assert.deepEqual(client2.events(), [{ type: "error", message: "OpenAI: Incorrect API key" }]);
  assert.equal(client2.closedWith, 1011);

  const client3 = new FakeSocket(), upstream3 = new FakeSocket();
  relayLiveDictation(client3 as any, upstream3 as any, { model: "gpt-4o-transcribe", lang: "en-US", maxMs: 20, finishMs: 20, log: { warn() {} } });
  client3.emit("message", Buffer.from([0, 0]), true);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(client3.events()[0].type, "limit");
  assert.ok(upstream3.events().some(event => event.type === "input_audio_buffer.commit"));
  assert.equal(client3.closedWith, 1000, "closes even if OpenAI never answers");
});
