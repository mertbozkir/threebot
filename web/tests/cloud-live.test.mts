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
const { toPcm16, liveTranscript } = await import(pathToFileURL(file).href);
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
