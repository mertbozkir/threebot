import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import sharp from "sharp";
import { CONTROLLED_MESSAGE, createDesktop, createDesktopTools, createRfbClientFilter, imageHash, runArgs, xdotoolArgs, type Run } from "./desktop.mts";

const handshake = () => Buffer.concat([Buffer.from("RFB 003.008\n", "latin1"), Buffer.from([1]), Buffer.from([0])]);
const key = Buffer.from([4, 1, 0, 0, 0, 0, 0, 0x61]);
const pointer = Buffer.from([5, 1, 0, 10, 0, 20]);
const cut = Buffer.concat([Buffer.from([6, 0, 0, 0, 0, 0, 0, 3]), Buffer.from("abc")]);
const updateRequest = Buffer.from([3, 1, 0, 0, 0, 0, 7, 128, 4, 176]);
const encodings = Buffer.from([2, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 7]);

test("a watcher's stream keeps picture requests and drops input and clipboard", () => {
  const filter = createRfbClientFilter("watch");
  const out = filter(Buffer.concat([handshake(), encodings, key, pointer, cut, updateRequest]));
  // ClientInit is forced to shared.
  assert.deepEqual(out, Buffer.concat([Buffer.from("RFB 003.008\n", "latin1"), Buffer.from([1, 1]), encodings, updateRequest]));
});

test("control passes keys and the pointer but never the clipboard", () => {
  const filter = createRfbClientFilter("control");
  filter(handshake());
  assert.deepEqual(filter(Buffer.concat([key, cut, pointer])), Buffer.concat([key, pointer]));
});

test("messages split across chunks are reassembled before deciding", () => {
  const filter = createRfbClientFilter("watch");
  filter(handshake());
  assert.equal(filter(updateRequest.subarray(0, 4)).length, 0);
  assert.deepEqual(filter(Buffer.concat([updateRequest.subarray(4), key.subarray(0, 3)])), updateRequest);
  assert.equal(filter(key.subarray(3)).length, 0);
});

test("unknown messages, other versions and other security types close the stream", () => {
  assert.throws(() => createRfbClientFilter("watch")(Buffer.from("RFB 003.003\n", "latin1")), /version/);
  assert.throws(() => createRfbClientFilter("watch")(Buffer.concat([Buffer.from("RFB 003.008\n", "latin1"), Buffer.from([2])])), /security/);
  const filter = createRfbClientFilter("control");
  filter(handshake());
  assert.throws(() => filter(Buffer.from([200, 0, 0, 0])), /unknown RFB message 200/);
});

test("actions become xdotool runs in model space, split after typing", () => {
  const runs = xdotoolArgs([{ type: "click", x: 640, y: 400 }, { type: "type", text: "a b" }, { type: "key", keys: "Return" }]);
  assert.deepEqual(runs, [["mousemove", "960", "600", "click", "1", "type", "--delay", "12", "--", "a b"], ["key", "--clearmodifiers", "Return"]]);
  assert.throws(() => xdotoolArgs([{ type: "click", x: 1280, y: 0 }]), /inside 1280x800/);
  assert.throws(() => xdotoolArgs([{ type: "key", keys: "ctrl+l; rm -rf /" }]), /key must look like/);
  assert.throws(() => xdotoolArgs([{ type: "exec" }]), /Unknown action type/);
  assert.throws(() => xdotoolArgs(Array.from({ length: 21 }, () => ({ type: "wait", ms: 1 }))), /At most 20/);
});

test("the container publishes only its screen sockets and no ports", () => {
  const args = runArgs({ image: "img", hash: "h", screens: 2, socketDir: "/x/vnc" });
  assert.ok(!args.includes("-p") && !args.includes("--publish"));
  assert.deepEqual(args.filter((_, i) => args[i - 1] === "--publish-socket"), ["/x/vnc/1.sock:/tmp/vnc/1.sock", "/x/vnc/2.sock:/tmp/vnc/2.sock"]);
  assert.ok(!args.some((arg) => /PASSWORD/.test(arg)));
});

/** A fake Apple `container`: records calls and answers like a healthy runtime. */
function fakeRuntime(png: Buffer) {
  const calls: string[][] = [];
  let running = false;
  const run: Run = async (args) => {
    calls.push(args);
    const ok = (stdout: Buffer | string = "") => ({ code: 0, stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout), stderr: "" });
    switch (args[0]) {
      case "system": case "image": return ok();
      case "run": running = true; return ok();
      case "delete": running = false; return ok();
      case "inspect": return running ? ok(JSON.stringify([{ status: "running" }])) : { code: 1, stdout: Buffer.alloc(0), stderr: "not found" };
      case "exec": return args.includes("sh") ? ok(png) : ok();
      default: return ok();
    }
  };
  return { run, calls, get running() { return running; } };
}

async function setup(t: { after: (fn: () => Promise<void>) => void }, idleMs = 60_000) {
  const root = await mkdtemp(path.join(tmpdir(), "desktop-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const imageDir = path.join(root, "image");
  await mkdir(imageDir);
  await writeFile(path.join(imageDir, "Dockerfile"), "FROM scratch\n");
  const png = await sharp({ create: { width: 1920, height: 1200, channels: 3, background: "#ccc" } }).png().toBuffer();
  const runtime = fakeRuntime(png);
  const desktop = createDesktop({ imageDir, socketDir: path.join(root, "vnc"), run: runtime.run, screens: 2, idleMs });
  return { desktop, runtime, root };
}

test("concurrent wakes start the container once; Bots get their own screens until all are taken", async (t) => {
  const { desktop, runtime } = await setup(t);
  await desktop.enable();
  await Promise.all([desktop.wake(), desktop.wake(), desktop.wake()]);
  assert.equal(runtime.calls.filter((c) => c[0] === "run").length, 1);
  assert.match(desktop.vncSocket("alpha")!, /1\.sock$/);
  assert.match(desktop.vncSocket("beta")!, /2\.sock$/);
  assert.match(desktop.vncSocket("alpha")!, /1\.sock$/);
  assert.throws(() => desktop.vncSocket("gamma"), /All 2 screens are busy/);
  await desktop.disable();
});

test("screenshots are scaled to the model's 1280x800", async (t) => {
  const { desktop } = await setup(t);
  await desktop.enable();
  const meta = await sharp(Buffer.from(await desktop.screenshot("alpha"), "base64")).metadata();
  assert.deepEqual([meta.width, meta.height], [1280, 800]);
  await desktop.disable();
});

test("while a person controls the screen, the Bot's calls return at once", async (t) => {
  const { desktop } = await setup(t);
  await desktop.enable();
  const release = desktop.takeControl("alpha");
  await assert.rejects(desktop.screenshot("alpha"), new RegExp(CONTROLLED_MESSAGE.slice(0, 20)));
  release();
  await desktop.screenshot("alpha");
  await desktop.disable();
});

test("the desktop stops after the idle time, not during a call, and a control session keeps it awake", async (t) => {
  const { desktop, runtime } = await setup(t, 50);
  await desktop.enable();
  await desktop.wake();
  const release = desktop.takeControl("alpha");
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(runtime.running, true);
  release();
  await new Promise((r) => setTimeout(r, 2400));
  assert.equal(runtime.running, false);
  assert.equal(desktop.status(null).state, "stopped");
});

test("tools identify the Bot by its own token, never by an argument", async (t) => {
  const { desktop } = await setup(t);
  await desktop.enable();
  const call = createDesktopTools(desktop);
  const legacy = await call("computer_screenshot", { threadId: "x" }, { auth: { botSlug: null } });
  assert.equal(legacy.isError, true);
  const own = await call("computer_screenshot", {}, { auth: { botSlug: "alpha" } });
  assert.equal(own.content[0].type, "image");
  await desktop.disable();
});

test("off where Apple's container can't run", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "desktop-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const desktop = createDesktop({ imageDir: root, socketDir: path.join(root, "vnc"), supported: false, run: async () => { throw new Error("must not run"); } });
  await desktop.enable();
  assert.equal(desktop.status(null).state, "unavailable");
});

test("the image hash changes with any file in the image folder", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "desktop-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "a"), "1");
  const before = await imageHash(root);
  await writeFile(path.join(root, "a"), "2");
  assert.notEqual(await imageHash(root), before);
});
