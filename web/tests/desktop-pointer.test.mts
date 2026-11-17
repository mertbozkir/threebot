import assert from "node:assert/strict";
import { test } from "node:test";
import { buildOnce, entryChunk } from "./support.mts";

const source = new URL("../src/lib/desktopPointer.ts", import.meta.url).pathname;
const bundle = await buildOnce({ configFile: false, logLevel: "silent", build: { ssr: source, write: false } });
const entry = entryChunk(bundle);
assert.ok(entry, "test bundle has an entry point");
const { modelPointToCanvas } = await import(`data:text/javascript;base64,${Buffer.from(entry.code).toString("base64")}`);

test("model points land on the letterboxed canvas, not the container", () => {
  // A 1280x800 picture scaled into a 400x300 box letterboxes to 400x250, centered vertically.
  const letterboxed = { left: 0, top: 25, width: 400, height: 250 };
  assert.deepEqual(modelPointToCanvas(0, 0, letterboxed), { left: 0, top: 25 });
  assert.deepEqual(modelPointToCanvas(640, 400, letterboxed), { left: 200, top: 150 });
  assert.deepEqual(modelPointToCanvas(1280, 800, letterboxed), { left: 400, top: 275 });
  // Pillarboxed instead: narrower than the container, offset from its left edge.
  const pillarboxed = { left: 60, top: 0, width: 280, height: 175 };
  assert.deepEqual(modelPointToCanvas(320, 200, pillarboxed), { left: 130, top: 43.75 });
  assert.deepEqual(modelPointToCanvas(1280, 800, pillarboxed), { left: 340, top: 175 });
});
