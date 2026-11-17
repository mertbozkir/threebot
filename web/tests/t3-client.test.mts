import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, beforeEach, mock, test } from "node:test";
import { buildOnce, entryChunk } from "./support.mts";
import { fileURLToPath } from "node:url";

// Exercise the real RPC client. The transport controls connection lifetimes;
// no real Bot, browser, timers or server receives any request.
const directory = await mkdtemp(join(tmpdir(), "bot-t3-client-"));
const bundle = await buildOnce({ configFile: false, logLevel: "silent", build: { ssr: fileURLToPath(new URL("../src/lib/t3.ts", import.meta.url)), write: false } });
const entry = entryChunk(bundle);
assert.ok(entry);
const filename = join(directory, "client.mjs");
await writeFile(filename, entry.code);
const { T3Client, T3RpcError, threadKey, threadTarget, environmentHttp } = await import(pathToFileURL(filename).href);
let sockets, reconnects;
class Socket {
  static OPEN = 1;
  readyState = 0;
  sent: unknown[] = [];
  url: string;
  onopen: () => void;
  onclose: () => void;
  onmessage: (event: { data: string }) => void;
  constructor(url: string) { this.url = url; sockets.push(this); }
  send(message) { this.sent.push(JSON.parse(message)); }
  open() { this.readyState = 1; this.onopen(); }
  close() { this.readyState = 3; this.onclose(); }
  reply(request, value) { this.onmessage({ data: JSON.stringify({ _tag: "Exit", requestId: request.id, exit: { _tag: "Success", value } }) }); }
}
beforeEach(() => {
  sockets = []; reconnects = [];
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  globalThis.location = { protocol: "https:", host: "fixture.invalid" } as Location;
  globalThis.window = { setTimeout: (callback) => reconnects.push(callback), clearTimeout() {}, setInterval: () => 1, clearInterval() {} } as unknown as typeof window;
});
after(async () => { await rm(directory, { recursive: true }); });

test("a stalled send receipt times out and cannot later flush a restored draft", async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const client = new T3Client(); client.connect();
    const result = client.dispatch({ commandId: 'same-id', text: 'Local fixture' }, { timeoutMs: 30_000 }).catch(error => error);
    mock.timers.tick(30_000);
    assert.match((await result).message, /Couldn't confirm delivery/);
    sockets[0].open(); assert.deepEqual(sockets[0].sent, []);
    const retry = client.dispatch({ commandId: 'same-id', text: 'Local fixture' }, { timeoutMs: 30_000 });
    const request = sockets[0].sent[0];
    assert.equal(request.payload.commandId, 'same-id');
    sockets[0].reply(request, { sequence: 1 }); assert.deepEqual(await retry, { sequence: 1 });
    mock.timers.tick(30_000);
    assert.equal(sockets[0].sent.length, 1, 'successful receipts cancel their timer');
  } finally { mock.timers.reset(); }
});

test("a transmitted send times out without accepting its late receipt", async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const client = new T3Client(); client.connect(); sockets[0].open();
    const result = client.dispatch({ commandId: 'original' }, { timeoutMs: 30_000 }).catch(error => error);
    const request = sockets[0].sent[0]; mock.timers.tick(30_000);
    assert.ok(await result instanceof T3RpcError);
    assert.deepEqual(sockets[0].sent[1], { _tag: 'Interrupt', requestId: request.id });
    sockets[0].reply(request, { sequence: 1 });
    assert.equal(sockets[0].sent.length, 2);
  } finally { mock.timers.reset(); }
});

test("a rejected queued message is never transmitted on reconnect", async () => {
  const client = new T3Client(); client.connect();
  const result = client.dispatch({ type: "message.dispatch", commandId: "original", messageId: "original", text: "Original" }).catch((error) => error);
  sockets[0].close();
  assert.ok(await result instanceof T3RpcError);
  // The UI can now edit/discard the restored draft. Reconnection must not send
  // its rejected payload behind that user's back.
  reconnects.shift()(); sockets[1].open();
  assert.deepEqual(sockets[1].sent, []);
});

test("requests created after failure flush once and retain explicit send identity", async () => {
  const client = new T3Client(); client.connect(); sockets[0].close();
  const result = client.dispatch({ type: "message.dispatch", commandId: "retry", messageId: "retry", text: "Explicit retry" });
  reconnects.shift()(); sockets[1].open();
  assert.equal(sockets[1].sent.length, 1);
  const request = sockets[1].sent[0];
  assert.equal(request.payload.commandId, "retry"); assert.equal(request.payload.messageId, "retry");
  sockets[1].reply(request, { sequence: 7 });
  assert.deepEqual(await result, { sequence: 7 });
  sockets[1].close(); reconnects.shift()(); sockets[2].open();
  assert.deepEqual(sockets[2].sent, []);
});

test("closed-state listeners can enqueue a new live request after old calls reject", async () => {
  const client = new T3Client(); client.connect();
  const old = client.call("old").catch((error) => error);
  let fresh;
  client.onState((state) => { if (state === "closed") fresh = client.call("fresh"); });
  sockets[0].close(); assert.ok(await old instanceof T3RpcError);
  reconnects.shift()(); sockets[1].open();
  assert.deepEqual(sockets[1].sent.map((request) => request.tag), ["fresh"]);
  sockets[1].reply(sockets[1].sent[0], "fresh-result");
  assert.equal(await fresh, "fresh-result");
});

test("remote transport preflights its permission and never falls back to local RPC", async () => {
  const requests = [];
  globalThis.fetch = async (url) => { requests.push(url); return Response.json({ environmentId: "remote" }); };
  const client = new T3Client("remote"); client.connect();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(requests, ["/t3/environments/remote/.well-known/t3/environment"]);
  assert.equal(sockets[0].url, "wss://fixture.invalid/t3/environments/remote/ws");
  const result = client.call("orchestration.getThreadProjection", { threadId: "same-id" });
  sockets[0].open(); sockets[0].reply(sockets[0].sent[0], { thread: { id: "same-id" } });
  assert.equal((await result).thread.id, "same-id");
  assert.deepEqual(threadTarget(threadKey({ environmentId: "remote", threadId: "colon:id/with spaces" })), { environmentId: "remote", threadId: "colon:id/with spaces" });
  assert.notEqual(threadKey({ environmentId: "remote", threadId: "same-id" }), threadKey({ threadId: "same-id" }));
});

test("denied remote credential fails pending reads with an actionable error before any socket opens", async () => {
  globalThis.fetch = async () => Response.json({ error: "This machine has no scoped gateway access" }, { status: 403 });
  const client = new T3Client("denied");
  await assert.rejects(client.call("orchestration.getThreadProjection", { threadId: "same-id" }), /scoped gateway access/);
  assert.equal(sockets.length, 0);
  // Opening the conversation again after a permission failure must retry the preflight.
  const deniedStream = client.stream("orchestration.subscribeThread", { threadId: "same-id" }, () => {});
  await assert.rejects(deniedStream.done, /scoped gateway access/);
  await assert.rejects(environmentHttp("denied", "/api/assets/id"), /scoped gateway access/);
});

test("a stream cancelled before the socket opens is never sent", () => {
  const client = new T3Client(); client.connect();
  const dropped = client.stream("orchestration.subscribeThread", { threadId: "a" }, () => {});
  const kept = client.stream("orchestration.subscribeThread", { threadId: "b" }, () => {});
  dropped.cancel();
  sockets[0].open();
  assert.deepEqual(sockets[0].sent.map((m) => [m._tag, m.payload?.threadId]), [["Request", "b"]]);
  assert.equal(kept.live(), true, "a queued stream flushed on open is live on that socket");
  assert.equal(dropped.live(), false);
});

test("a stream is live only on the socket that carried it", () => {
  const client = new T3Client(); client.connect(); sockets[0].open();
  const handle = client.stream("orchestration.subscribeThread", { threadId: "a" }, () => {});
  assert.equal(handle.live(), true);
  sockets[0].close();
  assert.equal(handle.live(), false, "a lost connection ends the stream");
  reconnects.shift()(); sockets[1].open();
  assert.equal(handle.live(), false, "the old stream must be reopened on the new socket");
});

test("checkAlive closes a socket that doesn't answer a ping, and reconnects a closed one at once", () => {
  const client = new T3Client(); client.connect(); sockets[0].open();
  client.checkAlive(3000);
  assert.deepEqual(sockets[0].sent.at(-1), { _tag: "Ping" });
  const pongTimeout = reconnects.pop();
  sockets[0].onmessage({ data: JSON.stringify({ _tag: "Pong" }) });
  pongTimeout();
  assert.equal(sockets[0].readyState, 1, "a pong keeps the socket");
  client.checkAlive(3000);
  reconnects.pop()();
  assert.equal(sockets[0].readyState, 3, "no pong closes the socket");
  assert.equal(sockets.length, 1);
  client.checkAlive();
  assert.equal(sockets.length, 2, "a closed client reconnects without waiting for its retry timer");
  sockets[1].open();
  client.checkAlive(3000);
  assert.deepEqual(sockets[1].sent.at(-1), { _tag: "Ping" }, "a ping lost with its socket doesn't block later checks");
});

test("checkAlive never replaces a socket that is still closing", () => {
  const client = new T3Client(); client.connect(); sockets[0].open();
  sockets[0].readyState = 2;
  Socket.CLOSING = 2;
  client.checkAlive();
  assert.equal(sockets.length, 1, "the closing socket's own onclose reconnects");
  sockets[0].close();
  reconnects.at(-1)();
  assert.equal(sockets.length, 2);
  delete Socket.CLOSING;
});
