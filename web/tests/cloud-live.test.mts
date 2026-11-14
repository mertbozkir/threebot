import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { buildOnce, entryChunk } from "./support.mts";

const bundle = await buildOnce({ configFile: false, logLevel: "silent", build: { ssr: new URL("../src/lib/cloudLive.ts", import.meta.url).pathname, write: false }, ssr: { noExternal: true } });
const directory = await mkdtemp(join(tmpdir(), "bot-cloud-live-"));
const file = join(directory, "module.mjs");
await writeFile(file, entryChunk(bundle).code);
const { toPcm16, liveTranscript, startLiveDictation } = await import(pathToFileURL(file).href);
await rm(directory, { recursive: true });

test("microphone audio becomes 24 kHz PCM16, clamped", () => {
  const out: Int16Array = toPcm16(new Float32Array([0, 0.5, 1, 2, -1, Number.NaN, 0, 0]), 48_000);
  assert.equal(out.length, 4, "48 kHz halves");
  assert.deepEqual(Array.from(out), [0, 32767, -32768, 0]);
  assert.equal(toPcm16(new Float32Array(16_000), 16_000).length, 24_000, "16 kHz grows by half");
});

test("phrases keep their order and a phrase's final text replaces its running pieces", () => {
  const transcript = liveTranscript();
  transcript.delta("a", "Merhaba");
  transcript.delta("a", ", bugün");
  transcript.delta("b", "deploy");
  assert.equal(String(transcript), "Merhaba, bugün deploy");
  transcript.done("a", "Merhaba, bugün yeni feature.");
  transcript.done("b", "Deploy edeceğim.");
  transcript.done("c", "  ");
  assert.equal(String(transcript), "Merhaba, bugün yeni feature. Deploy edeceğim.");
});

test("committed speech order wins over reversed transcript completion", () => {
  const transcript = liveTranscript();
  transcript.committed("a", null);
  transcript.committed("b", "a");
  transcript.done("b", "Second phrase.");
  transcript.delta("a", "First");
  assert.equal(String(transcript), "First Second phrase.");
  transcript.done("a", "First phrase.");
  assert.equal(String(transcript), "First phrase. Second phrase.");
});

test("late and repeated ordering events reconcile existing text without duplication", () => {
  const transcript = liveTranscript();
  transcript.done("b", "Second.");
  transcript.done("a", "First.");
  transcript.committed("b", "a");
  transcript.committed("a", null);
  transcript.committed("b", "a");
  assert.equal(String(transcript), "First. Second.");
});

test("live dictation applies socket turn metadata without editing a draft before text arrives", async () => {
  let socket!: FakeWebSocket;
  class FakeWebSocket {
    static OPEN = 1;
    static CONNECTING = 0;
    readyState = 1;
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: ((event: { code: number }) => void) | null = null;
    constructor() { socket = this; }
    send() {}
    close() { this.readyState = 3; this.onclose?.({ code: 1000 }); }
  }
  class FakeAudioContext {
    state = "running";
    destination = {};
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createScriptProcessor() { return { connect() {}, disconnect() {}, onaudioprocess: null }; }
    async close() {}
  }
  const globals = {
    navigator: { mediaDevices: { async getUserMedia() { return { getTracks: () => [{ stop() {} }] }; } } },
    window: { AudioContext: FakeAudioContext },
    location: { protocol: "http:", host: "gateway.invalid" },
    WebSocket: FakeWebSocket,
  };
  const originals = Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const written: string[] = [];
  let dictation: { cancel: () => void } | undefined;
  try {
    dictation = await startLiveDictation({ lang: "en-US", onText: (text: string) => written.push(text), onError: assert.fail, onLimit() {}, onEnd() {} });
    const receive = (event: object) => socket.onmessage!({ data: JSON.stringify(event) });
    receive({ type: "committed", item: "a", previous: null });
    receive({ type: "committed", item: "b", previous: "a" });
    assert.deepEqual(written, [], "turn metadata alone must not change the draft");
    receive({ type: "done", item: "b", text: "Second phrase." });
    receive({ type: "done", item: "a", text: "First phrase." });
    assert.equal(written.at(-1), "First phrase. Second phrase.");
  } finally {
    dictation?.cancel();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
