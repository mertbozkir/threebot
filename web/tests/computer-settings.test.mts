// The Connection pill and the update note under Settings › Computer (lib/computerStatus).
import assert from "node:assert/strict";
import { test } from "node:test";
import { connectionPill, updateNote } from "../src/lib/computerStatus.ts";

test("the connection pill reads Connected · runtime while usable and the reason otherwise", () => {
  assert.deepEqual(connectionPill({ state: "healthy", reason: null, runtime: "Docker 28.1.1" }), { text: "Connected · Docker 28.1.1", tone: "good" });
  assert.deepEqual(connectionPill({ state: "healthy", reason: null, runtime: null }), { text: "Connected", tone: "good" });
  assert.deepEqual(connectionPill({ state: "stopped", reason: null, runtime: "Docker 28.1.1" }), { text: "Sleeping", tone: "attention" });
  assert.deepEqual(connectionPill({ state: "building", reason: null, runtime: null }), { text: "Updating…", tone: "attention" });
  assert.deepEqual(connectionPill({ state: "failed", reason: "Can't reach build-box over SSH", runtime: null }), { text: "Can't reach build-box over SSH", tone: "attention" });
});

test("the update note separates latest, available and building", () => {
  const image = (latest: boolean) => ({ current: "img-7", running: latest ? "img-7" : "img-6", builtAt: "2026-11-16T10:00:00Z", latest });
  assert.deepEqual(updateNote({ state: "healthy", image: image(true) }), { text: "✓ Your computer is on the latest version" });
  assert.deepEqual(updateNote({ state: "stopped", image: image(false) }), { text: "An update is available" });
  assert.deepEqual(updateNote({ state: "building", image: image(false) }), { text: "Rebuilding with fresh packages…" });
});
