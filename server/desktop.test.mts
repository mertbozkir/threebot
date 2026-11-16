import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import sharp from "sharp";
import { CONTROLLED_MESSAGE, createDesktop, createDesktopTools, createRfbClientFilter, HELP_REQUESTED_MESSAGE, imageHash, pasteText, runArgs, xdotoolArgs, type Desktop, type DesktopOptions, type DesktopStatus, type Run } from "./desktop.mts";

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

async function setup(t: { after: (fn: () => Promise<void>) => void }, idleMs = 60_000, options: Partial<DesktopOptions> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "desktop-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const imageDir = path.join(root, "image");
  await mkdir(imageDir);
  await writeFile(path.join(imageDir, "Dockerfile"), "FROM scratch\n");
  const png = await sharp({ create: { width: 1920, height: 1200, channels: 3, background: "#ccc" } }).png().toBuffer();
  const runtime = fakeRuntime(png);
  const desktop = createDesktop({ imageDir, socketDir: path.join(root, "vnc"), run: runtime.run, screens: 2, idleMs, ...options });
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

test("paste text is 1..2000 characters with no control characters beyond newline and tab", () => {
  const bad = (text: unknown) => assert.throws(() => pasteText(text), (error: unknown) => (error as { status?: number }).status === 400);
  bad(""); bad("a".repeat(2001)); bad(null); bad(5); bad("a\0b"); bad("a\rb"); bad("a\x1bb"); bad("a\x7fb");
  for (const good of ["a", "a".repeat(2000), "line\nbreak\ttab", "héllo → 🚀", "- --looks like a flag"]) assert.equal(pasteText(good), good);
});

test("typeText types into the Bot's own display while the person controls it, without Bot activity", async (t) => {
  const { desktop, runtime } = await setup(t);
  await desktop.enable();
  await assert.rejects(desktop.typeText("alpha", "hi"), /Take control/);
  const early = desktop.takeControl("alpha");
  await assert.rejects(desktop.typeText("alpha", "hi"), /no screen/);
  early();
  await desktop.wake();
  // The viewer connects before taking control, which is what leases the screen.
  assert.match(desktop.vncSocket("alpha")!, /1\.sock$/);
  const release = desktop.takeControl("alpha");
  await assert.rejects(desktop.actions("alpha", [{ type: "type", text: "x" }]), new RegExp(CONTROLLED_MESSAGE.slice(0, 20)));
  await desktop.typeText("alpha", "hi there");
  assert.match(desktop.vncSocket("beta")!, /2\.sock$/);
  await assert.rejects(desktop.typeText("beta", "x"), /Take control/);
  const releaseBeta = desktop.takeControl("beta");
  await desktop.typeText("beta", "-- --delay=1");
  releaseBeta();
  assert.deepEqual(runtime.calls.filter((c) => c.includes("xdotool")), [
    ["exec", "-u", "bot", "-e", "DISPLAY=:1", "-e", "HOME=/home/bot", "threebot-desktop", "xdotool", "type", "--delay", "12", "--", "hi there"],
    ["exec", "-u", "bot", "-e", "DISPLAY=:2", "-e", "HOME=/home/bot", "threebot-desktop", "xdotool", "type", "--delay", "12", "--", "-- --delay=1"],
  ]);
  assert.deepEqual(desktop.status("alpha").activity, { busy: false, last: null });
  release();
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

test("computer_request_help validates the instruction and records it for the calling Bot only", async (t) => {
  const { desktop } = await setup(t);
  await desktop.enable();
  const call = createDesktopTools(desktop);
  const missing = await call("computer_request_help", {}, { auth: { botSlug: "alpha" } });
  assert.equal(missing.isError, true);
  const blank = await call("computer_request_help", { instruction: "   " }, { auth: { botSlug: "alpha" } });
  assert.equal(blank.isError, true);
  const tooLong = await call("computer_request_help", { instruction: "a".repeat(501) }, { auth: { botSlug: "alpha" } });
  assert.equal(tooLong.isError, true);
  assert.equal(tooLong.content[0].type, "text");
  assert.match((tooLong.content[0] as { text: string }).text, /500/);
  assert.equal(desktop.status("alpha").helpRequest, null);
  const asked = await call("computer_request_help", { instruction: "  Sign in to Google  " }, { auth: { botSlug: "alpha" } });
  assert.equal(asked.isError, undefined);
  assert.equal(asked.content[0].type, "text");
  assert.match((asked.content[0] as { text: string }).text, new RegExp(HELP_REQUESTED_MESSAGE.slice(0, 30)));
  const help = desktop.status("alpha").helpRequest;
  assert.equal(help?.instruction, "Sign in to Google");
  assert.ok(!Number.isNaN(Date.parse(help!.at)));
  assert.equal(desktop.status("beta").helpRequest, null);
  await call("computer_request_help", { instruction: "Enter the 2FA code" }, { auth: { botSlug: "alpha" } });
  assert.equal(desktop.status("alpha").helpRequest?.instruction, "Enter the 2FA code");
  await desktop.disable();
});

test("handing the screen back clears a pending help request and notifies exactly once", async (t) => {
  const returned: { slug: string; instruction: string }[] = [];
  const { desktop } = await setup(t, 60_000, { onHelpReturned: (slug, instruction) => returned.push({ slug, instruction }) });
  await desktop.enable();
  await desktop.wake();
  desktop.requestHelp("alpha", "Sign in to Google");
  const release = desktop.takeControl("alpha");
  release();
  assert.deepEqual(returned, [{ slug: "alpha", instruction: "Sign in to Google" }]);
  assert.equal(desktop.status("alpha").helpRequest, null);
  const releaseAgain = desktop.takeControl("alpha");
  releaseAgain();
  assert.equal(returned.length, 1);
  await desktop.disable();
});

test("actions show up in status: busy while the batch runs, with each pointer type's position", async (t) => {
  const png = await sharp({ create: { width: 1920, height: 1200, channels: 3, background: "#ccc" } }).png().toBuffer();
  const real = fakeRuntime(png);
  let desktop!: Desktop;
  let failActions = false;
  const seen: DesktopStatus["activity"][] = [];
  const run: Run = async (args) => {
    if (args.includes("xdotool")) {
      seen.push(desktop.status("alpha").activity);
      if (failActions) return { code: 1, stdout: Buffer.alloc(0), stderr: "button press failed" };
    }
    return real.run(args);
  };
  ({ desktop } = await setup(t, 60_000, { run }));
  await desktop.enable();
  const typed = { type: "type", text: "x" };
  await desktop.actions("alpha", [
    { type: "move", x: 100, y: 200 }, typed,
    { type: "click", x: 300, y: 400 }, typed,
    { type: "double_click", x: 10, y: 20 }, typed,
    { type: "right_click", x: 500, y: 600 }, typed,
    { type: "drag", x: 1, y: 2, toX: 640, toY: 400 }, typed,
    { type: "scroll", x: 700, y: 100, direction: "down" }, { type: "key", keys: "Return" }, { type: "wait", ms: 5 },
  ]);
  assert.equal(seen.length, 6);
  assert.ok(seen.every((activity) => activity.busy));
  assert.deepEqual(seen.map((activity) => activity.last && { type: activity.last.type, x: activity.last.x, y: activity.last.y }), [
    { type: "move", x: 100, y: 200 },
    { type: "click", x: 300, y: 400 },
    { type: "double_click", x: 10, y: 20 },
    { type: "right_click", x: 500, y: 600 },
    { type: "drag", x: 640, y: 400 },
    { type: "scroll", x: 700, y: 100 },
  ]);
  const after = desktop.status("alpha").activity;
  assert.equal(after.busy, false);
  assert.ok(!Number.isNaN(Date.parse(after.last!.at)));
  await desktop.actions("beta", [{ type: "type", text: "hi" }, { type: "key", keys: "ctrl+a" }, { type: "wait", ms: 1 }]);
  assert.deepEqual(desktop.status("beta").activity, { busy: false, last: null });
  failActions = true;
  await assert.rejects(desktop.actions("alpha", [{ type: "click", x: 5, y: 5 }]), /Actions failed/);
  assert.equal(desktop.status("alpha").activity.busy, false);
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

/** A fake runtime whose xdotool calls take `ms`, so a test can act while a batch is running. */
async function slowSetup(t: { after: (fn: () => Promise<void>) => void }, ms: number) {
  const { runtime } = await setup(t);
  const slow: Run = async (args, options) => { if (args.includes("xdotool") && !args.includes("type")) await new Promise((r) => setTimeout(r, ms)); return runtime.run(args, options); };
  return setup(t, 60_000, { run: slow });
}

test("a person can't type into a screen while the Bot's batch is still running", async (t) => {
  const { desktop } = await slowSetup(t, 150);
  await desktop.enable();
  const batch = desktop.actions("alpha", [{ type: "click", x: 10, y: 10 }]);
  await new Promise((r) => setTimeout(r, 60));
  const release = desktop.takeControl("alpha");
  await assert.rejects(desktop.typeText("alpha", "hi"), /finishing a batch/);
  await batch;
  await desktop.typeText("alpha", "hi");
  release();
  await desktop.disable();
});

test("a refused second batch leaves the running batch's busy flag alone", async (t) => {
  const { desktop } = await slowSetup(t, 150);
  await desktop.enable();
  const first = desktop.actions("alpha", [{ type: "click", x: 10, y: 10 }]);
  await new Promise((r) => setTimeout(r, 60));
  await assert.rejects(desktop.actions("alpha", [{ type: "move", x: 5, y: 5 }]), /busy with another batch/);
  assert.equal(desktop.status("alpha").activity.busy, true);
  await first;
  assert.equal(desktop.status("alpha").activity.busy, false);
  await desktop.disable();
});

test("stopping forgets the pointer; switching off also forgets help requests", async (t) => {
  const { desktop } = await setup(t);
  await desktop.enable();
  await desktop.actions("alpha", [{ type: "click", x: 10, y: 10 }]);
  desktop.requestHelp("alpha", "Sign in");
  await desktop.stop("test");
  assert.deepEqual(desktop.status("alpha").activity, { busy: false, last: null });
  assert.equal(desktop.status("alpha").helpRequest?.instruction, "Sign in");
  await desktop.disable();
  assert.equal(desktop.status("alpha").helpRequest, null);
});
