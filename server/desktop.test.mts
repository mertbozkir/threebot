import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import sharp from "sharp";
import { appleRuntime, CONTROLLED_MESSAGE, computerSetting, createDesktop, createDesktopTools, createRfbClientFilter, HELP_REQUESTED_MESSAGE, imageHash, pasteText, runArgs, shellQuote, spawnRun, sshDockerRuntime, xdotoolArgs, type Desktop, type DesktopOptions, type DesktopStatus, type Run } from "./desktop.mts";

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

test("the extended clipboard message (negative length) is dropped without stalling input behind it", () => {
  const filter = createRfbClientFilter("control");
  filter(handshake());
  const caps = Buffer.from([6, 0, 0, 0, 0xff, 0xff, 0xff, 0xf8, 0x1f, 0, 0, 1, 0, 0, 0x10, 0]);
  assert.deepEqual(filter(Buffer.concat([caps, pointer, key])), Buffer.concat([pointer, key]));
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
  const { desktop } = await slowSetup(t, 800);
  await desktop.enable();
  const batch = desktop.actions("alpha", [{ type: "click", x: 10, y: 10 }]);
  await new Promise((r) => setTimeout(r, 300));
  const release = desktop.takeControl("alpha");
  await assert.rejects(desktop.typeText("alpha", "hi"), /finishing a batch/);
  await batch;
  await desktop.typeText("alpha", "hi");
  release();
  await desktop.disable();
});

test("a refused second batch leaves the running batch's busy flag alone", async (t) => {
  const { desktop } = await slowSetup(t, 800);
  await desktop.enable();
  const first = desktop.actions("alpha", [{ type: "click", x: 10, y: 10 }]);
  await new Promise((r) => setTimeout(r, 300));
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

// ---------- runtimes: docker over ssh ----------

test("shellQuote always quotes and escapes single quotes", () => {
  assert.equal(shellQuote("plain"), "'plain'");
  assert.equal(shellQuote("a b"), "'a b'");
  assert.equal(shellQuote("it's"), "'it'\\''s'");
  assert.equal(shellQuote("$HOME `x` $(y)"), "'$HOME `x` $(y)'");
  assert.equal(shellQuote("a\nb"), "'a\nb'");
  assert.equal(shellQuote("-flag"), "'-flag'");
  assert.equal(shellQuote(""), "''");
});

test("the ssh runtime wraps every docker verb in one ssh line with each argument quoted", () => {
  const rt = sshDockerRuntime({ host: "box", controlPath: "/run/cm-%r" });
  const prefix = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=3", "-o", "ControlMaster=auto", "-o", "ControlPath=/run/cm-%r", "-o", "ControlPersist=10m", "box", "--"];
  assert.deepEqual(rt.command(["info"]), [...prefix, "docker", "'info'"]);
  assert.deepEqual(rt.command(["rm", "-f", "threebot-desktop"]), [...prefix, "docker", "'rm'", "'-f'", "'threebot-desktop'"]);
  assert.deepEqual(rt.command(["exec", "-u", "bot", "threebot-desktop", "xdotool", "type", "--", "a b"]), [...prefix, "docker", "'exec'", "'-u'", "'bot'", "'threebot-desktop'", "'xdotool'", "'type'", "'--'", "'a b'"]);
});

test("the ssh runtime probes home and uid, then docker, and maps its failures", async () => {
  const rt = sshDockerRuntime({ host: "box", controlPath: "/run/cm" });
  const calls: string[][] = [];
  const answers: { code: number; stdout: string; stderr: string }[] = [];
  const run: Run = async (args) => {
    calls.push(args);
    const next = answers.shift() ?? { code: 0, stdout: "", stderr: "" };
    return { code: next.code, stdout: Buffer.from(next.stdout), stderr: next.stderr };
  };
  answers.push({ code: 0, stdout: "/home/u\n1000\n", stderr: "" });
  answers.push({ code: 0, stdout: "28.1.1\n", stderr: "" });
  assert.equal(await rt.probe(run), null);
  assert.equal(calls.length, 2);
  assert.match(calls[0].at(-1)!, /printf "%s\\n" "\$HOME"; id -u; mkdir -p "\$HOME\/\.threebot-desktop\/vnc"; chmod 700 "\$HOME\/\.threebot-desktop\/vnc"/);
  assert.deepEqual(calls[1].slice(-4), ["docker", "'info'", "'--format'", "'{{.ServerVersion}}'"]);
  assert.equal(rt.label(), "Docker 28.1.1");
  // the screen folder is bind-mounted from the probed home, with the hardening flags and no socket publishing
  const started = rt.runArgs({ image: "img", hash: "h", screens: 2, socketDir: "/x" });
  assert.ok(!started.includes("--publish-socket"));
  assert.deepEqual(started.filter((_, i) => started[i - 1] === "-v").at(-1), "/home/u/.threebot-desktop/vnc:/tmp/vnc");
  assert.deepEqual(started.slice(started.indexOf("--cap-add"), -1), ["--cap-add", "NET_ADMIN", "--security-opt", "no-new-privileges", "--sysctl", "net.ipv6.conf.all.disable_ipv6=1"]);
  assert.equal(started.at(-1), "img");
  answers.push({ code: 0, stdout: "/home/u\n1001\n", stderr: "" });
  assert.match((await rt.probe(run))!, /The desktop needs uid 1000 on box \(yours is 1001\)/);
  answers.length = 0;
  answers.push({ code: 255, stdout: "", stderr: "ssh: connect to host box port 22: Connection refused" });
  assert.equal(await rt.probe(run), "Can't reach box over SSH.");
  answers.length = 0;
  answers.push({ code: 0, stdout: "/home/u\n1000\n", stderr: "" });
  answers.push({ code: 1, stdout: "", stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?" });
  assert.equal(await rt.probe(run), "Docker isn't running on box.");
  assert.equal(rt.unavailable({ code: 255, stdout: Buffer.alloc(0), stderr: "" }), "Can't reach box over SSH.");
  assert.equal(rt.unavailable({ code: 1, stdout: Buffer.alloc(0), stderr: "Cannot connect to the Docker daemon at unix" }), "Docker isn't running on box.");
  assert.equal(rt.unavailable({ code: 1, stdout: Buffer.alloc(0), stderr: "no such container" }), null);
  assert.equal(appleRuntime.unavailable({ code: 255, stdout: Buffer.alloc(0), stderr: "" }), null);
});

test("the runtime table: each runtime parses its own inspect output and shapes its own build", () => {
  assert.equal(appleRuntime.running([{ status: "running" }]), true);
  assert.equal(appleRuntime.running([{ status: "exited" }]), false);
  assert.equal(appleRuntime.running([{ State: { Status: "running" } }]), false);
  assert.equal(appleRuntime.running(null), false);
  const rt = sshDockerRuntime({ host: "box", controlPath: "/run/cm" });
  assert.equal(rt.running([{ State: { Status: "running" } }]), true);
  assert.equal(rt.running([{ State: { Status: "exited" } }]), false);
  assert.equal(rt.running([{ status: "running" }]), false);
  assert.equal(rt.running(null), false);
  assert.deepEqual(appleRuntime.buildArgs("img", "/dir"), { args: ["build", "-t", "img", "/dir"] });
  assert.deepEqual(rt.buildArgs("img", "/dir"), { args: ["build", "-t", "img", "-"], stdinFrom: "/dir" });
  assert.deepEqual(appleRuntime.buildArgs("img", "/dir", true), { args: ["build", "--pull", "--no-cache", "-t", "img", "/dir"] });
  assert.deepEqual(rt.buildArgs("img", "/dir", true), { args: ["build", "--pull", "--no-cache", "-t", "img", "-"], stdinFrom: "/dir" });
  assert.deepEqual(appleRuntime.removeArgs(), ["delete", "--force", "threebot-desktop"]);
  assert.deepEqual(rt.removeArgs(), ["rm", "-f", "threebot-desktop"]);
  assert.deepEqual(appleRuntime.volumeRemoveArgs("vol"), ["volume", "delete", "vol"]);
  assert.deepEqual(rt.volumeRemoveArgs("vol"), ["volume", "rm", "vol"]);
});

test("probe records a short runtime label", async () => {
  const answers: { code: number; stdout: string }[] = [];
  const run: Run = async () => {
    const next = answers.shift() ?? { code: 0, stdout: "" };
    return { code: next.code, stdout: Buffer.from(next.stdout), stderr: "" };
  };
  answers.push({ code: 0, stdout: "" }, { code: 0, stdout: "container CLI version 0.9.0 (build: release, commit: 3e49dce)\n" });
  assert.equal(await appleRuntime.probe(run), null);
  assert.equal(appleRuntime.label(), "container 0.9.0");
  answers.length = 0;
  answers.push({ code: 0, stdout: "" }, { code: 0, stdout: "" });
  await appleRuntime.probe(run);
  assert.equal(appleRuntime.label(), "Apple container");
  const rt = sshDockerRuntime({ host: "box", controlPath: "/run/cm" });
  assert.equal(rt.label(), null);
});

/** A fake Docker host behind ssh: every call must arrive as one quoted ssh line, and the image is built once. */
function fakeSshHost(png: Buffer) {
  const calls: { args: string[]; options?: { timeoutMs?: number; stdinFrom?: string }; remote: string[] }[] = [];
  let container = false;
  let image = false;
  let down = false;
  const run: Run = async (args, options) => {
    const remote = args.slice(args.indexOf("--") + 1);
    calls.push({ args, options, remote });
    if (down) return { code: 255, stdout: Buffer.alloc(0), stderr: "ssh: connect to host box port 22: Connection refused" };
    if (args[0] !== "-o") throw new Error(`expected ssh options first (spawnRun adds the binary), got: ${args[0]}`);
    const ok = (stdout: Buffer | string = "") => ({ code: 0, stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout), stderr: "" });
    if (remote[0] === "'sh'") return ok("/home/u\n1000\n");
    if (remote[0] === "docker") {
      switch (remote[1]) {
        case "'info'": return ok();
        case "'image'": return image ? ok() : { code: 1, stdout: Buffer.alloc(0), stderr: "no such image" };
        case "'build'": image = true; return ok();
        case "'run'": container = true; return ok();
        case "'rm'": container = false; return ok();
        case "'inspect'": return container ? ok(JSON.stringify([{ State: { Status: "running" } }])) : { code: 1, stdout: Buffer.alloc(0), stderr: "no such container" };
        case "'exec'": return remote.includes("'sh'") ? ok(png) : ok();
        default: return ok();
      }
    }
    return ok();
  };
  return { run, calls, fail: () => { down = true; }, recover: () => { down = false; } };
}

async function sshSetup(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(path.join(tmpdir(), "desktop-ssh-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const imageDir = path.join(root, "image");
  await mkdir(imageDir);
  await writeFile(path.join(imageDir, "Dockerfile"), "FROM scratch\n");
  const png = await sharp({ create: { width: 1920, height: 1200, channels: 3, background: "#ccc" } }).png().toBuffer();
  const fake = fakeSshHost(png);
  const desktop = createDesktop({ imageDir, socketDir: path.join(root, "vnc"), runtime: sshDockerRuntime({ host: "box", controlPath: path.join(root, "cm") }), run: fake.run, screens: 2, idleMs: 60_000 });
  return { desktop, fake, imageDir };
}

test("over ssh, the desktop probes, starts docker with the bind-mounted screen folder and hardening, and serves screenshots", async (t) => {
  const { desktop, fake } = await sshSetup(t);
  await desktop.enable();
  assert.equal(desktop.status(null).state, "stopped");
  await desktop.wake();
  assert.equal(desktop.status(null).state, "healthy");
  const started = fake.calls.find((call) => call.remote[1] === "'run'")!;
  assert.ok(!started.args.includes("'--publish-socket'"));
  assert.deepEqual(started.remote.filter((_, i) => started.remote[i - 1] === "'-v'").at(-1), "'/home/u/.threebot-desktop/vnc:/tmp/vnc'");
  for (const flag of ["'--cap-add'", "'NET_ADMIN'", "'--security-opt'", "'no-new-privileges'", "'--sysctl'", "'net.ipv6.conf.all.disable_ipv6=1'"]) assert.ok(started.remote.includes(flag), flag);
  const meta = await sharp(Buffer.from(await desktop.screenshot("alpha"), "base64")).metadata();
  assert.deepEqual([meta.width, meta.height], [1280, 800]);
  assert.match(desktop.vncSocket("beta")!, /2\.sock$/);
  await desktop.disable();
  assert.equal(fake.calls.filter((call) => call.remote.includes("'rm'")).length, 2);
});

test("an ssh build reads the image folder as a tar on stdin", async (t) => {
  const { desktop, fake, imageDir } = await sshSetup(t);
  await desktop.enable();
  const build = fake.calls.find((call) => call.remote[1] === "'build'")!;
  assert.equal(build.remote.at(-1), "'-'");
  assert.equal(build.options?.stdinFrom, imageDir);
  assert.equal(build.remote.filter((arg) => arg === "'build'").length, 1);
  await desktop.disable();
});

test("an ssh drop marks the desktop unavailable and the next call re-probes", async (t) => {
  const { desktop, fake } = await sshSetup(t);
  await desktop.enable();
  await desktop.wake();
  fake.fail();
  await assert.rejects(desktop.screenshot("alpha"), /Screenshot failed/);
  assert.equal(desktop.status(null).state, "unavailable");
  assert.equal(desktop.status(null).reason, "Can't reach box over SSH.");
  await assert.rejects(desktop.wake(), (error: unknown) => (error as { status?: number }).status === 503 && /Can't reach box over SSH/.test((error as Error).message));
  fake.recover();
  await desktop.wake();
  assert.equal(desktop.status(null).state, "healthy");
  await desktop.disable();
});

test("while the image is building, screenshot and actions fail fast instead of waiting for it", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "desktop-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const imageDir = path.join(root, "image");
  await mkdir(imageDir);
  await writeFile(path.join(imageDir, "Dockerfile"), "FROM scratch\n");
  const png = await sharp({ create: { width: 1920, height: 1200, channels: 3, background: "#ccc" } }).png().toBuffer();
  const base = fakeRuntime(png);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const run: Run = async (args, options) => {
    if (args[0] === "image") return { code: 1, stdout: Buffer.alloc(0), stderr: "" };
    if (args[0] === "build") { await gate; return { code: 0, stdout: Buffer.alloc(0), stderr: "" }; }
    return base.run(args, options);
  };
  const desktop = createDesktop({ imageDir, socketDir: path.join(root, "vnc"), run, screens: 2, idleMs: 60_000 });
  const enabling = desktop.enable();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(desktop.status(null).state, "building");
  await assert.rejects(desktop.screenshot("alpha"), /The computer is still being prepared\. Try again in a minute\./);
  await assert.rejects(desktop.actions("alpha", [{ type: "click", x: 1, y: 1 }]), /still being prepared/);
  release();
  await enabling;
  assert.equal(desktop.status(null).state, "stopped");
  await desktop.disable();
});

test("spawnRun pipes a tar of stdinFrom into the command's stdin", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "desktop-tar-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "Dockerfile"), "FROM scratch\n");
  const result = await spawnRun("cat")([], { stdinFrom: root });
  assert.equal(result.code, 0);
  assert.ok(result.stdout.includes(Buffer.from("Dockerfile")));
});

test("computerSetting accepts the default, mac and an ssh host, and rejects the rest", () => {
  assert.deepEqual(computerSetting(undefined), { where: "mac" });
  assert.deepEqual(computerSetting(null), { where: "mac" });
  assert.deepEqual(computerSetting({ where: "mac" }), { where: "mac" });
  assert.deepEqual(computerSetting({ where: "ssh", host: "box.lan" }), { where: "ssh", host: "box.lan" });
  assert.deepEqual(computerSetting({ where: "ssh", host: "me@10.0.0.9" }), { where: "ssh", host: "me@10.0.0.9" });
  assert.deepEqual(computerSetting({ where: "ssh", host: "a".repeat(253) }), { where: "ssh", host: "a".repeat(253) });
  const bad = (value: unknown) => assert.throws(() => computerSetting(value), (error: unknown) => (error as { status?: number }).status === 400);
  bad({ where: "ssh" }); bad({ where: "ssh", host: "" }); bad({ where: "ssh", host: "a b" });
  bad({ where: "ssh", host: "-box" }); bad({ where: "ssh", host: "a".repeat(254) }); bad({ where: "ssh", host: 7 });
  bad({ where: "cluster" }); bad("box"); bad(true);
});

// ---------- update, reset and the computer status ----------

/** A fake Apple `container` for the maintenance tests: records verbs, tracks the container (by its run label), the image and its build time. */
function fakeLifecycle(png: Buffer, options: { builtAt?: string; failBuild?: boolean; holdBuild?: boolean; volumeError?: string } = {}) {
  const calls: string[][] = [];
  let container: string | null = null;
  let image = "built";
  let builtAt = options.builtAt ?? null;
  let release: (() => void) | null = null;
  const gate = options.holdBuild ? new Promise<void>((resolve) => { release = resolve; }) : null;
  const ok = (stdout: Buffer | string = "") => ({ code: 0, stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout), stderr: "" });
  const run: Run = async (args) => {
    calls.push(args);
    switch (args[0]) {
      case "system": return ok();
      case "--version": return ok("container CLI version 0.9.0\n");
      case "run": container = args[args.indexOf("--label") + 1]?.split("=")[1] ?? null; return ok();
      case "delete": container = null; return ok();
      case "inspect":
        return container
          ? ok(JSON.stringify([{ status: "running", configuration: { labels: { "threebot.desktop": container } } }]))
          : { code: 1, stdout: Buffer.alloc(0), stderr: "no such container" };
      case "image":
        return args[1] === "inspect"
          ? image ? ok(JSON.stringify([{ Created: builtAt }])) : { code: 1, stdout: Buffer.alloc(0), stderr: "no such image" }
          : ok();
      case "build":
        if (gate) await gate;
        if (options.failBuild) return { code: 1, stdout: Buffer.alloc(0), stderr: "pull access denied for base" };
        image = "rebuilt"; builtAt = new Date().toISOString();
        return ok();
      case "volume":
        return options.volumeError ? { code: 1, stdout: Buffer.alloc(0), stderr: options.volumeError } : ok();
      case "exec": return args.includes("sh") ? ok(png) : ok();
      default: return ok();
    }
  };
  return {
    run, calls,
    get container() { return container; },
    get image() { return image; },
    get builtAt() { return builtAt; },
    set builtAt(value: string | null) { builtAt = value; },
    setContainer(hash: string | null) { container = hash; },
    releaseBuild: () => release?.(),
  };
}

async function lifecycleSetup(t: { after: (fn: () => Promise<void>) => void }, options: Parameters<typeof fakeLifecycle>[1] = {}, wrap?: (base: Run) => Run) {
  const root = await mkdtemp(path.join(tmpdir(), "desktop-maint-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const imageDir = path.join(root, "image");
  await mkdir(imageDir);
  await writeFile(path.join(imageDir, "Dockerfile"), "FROM scratch\n");
  const png = await sharp({ create: { width: 1920, height: 1200, channels: 3, background: "#ccc" } }).png().toBuffer();
  const fake = fakeLifecycle(png, options);
  const desktop = createDesktop({ imageDir, socketDir: path.join(root, "vnc"), run: wrap ? wrap(fake.run) : fake.run, screens: 2, idleMs: 60_000 });
  return { desktop, fake, imageDir };
}

/** Polls until the detached rebuild has landed, one way or the other (its final removal waits out the browser grace). */
async function untilSettled(desktop: Desktop) {
  for (let i = 0; i < 500; i++) {
    const state = desktop.status(null).state;
    if (state !== "building" && state !== "stopping") return;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail("the rebuild never settled");
}

test("update rebuilds with --pull --no-cache and drops the container only after the build succeeds", async (t) => {
  const { desktop, fake, imageDir } = await lifecycleSetup(t, { holdBuild: true });
  await desktop.enable();
  await desktop.wake();
  const current = await imageHash(imageDir);
  assert.equal(fake.container, current);
  const status = await desktop.update();
  assert.equal(status.state, "building");
  assert.equal(status.runtime, "container 0.9.0");
  assert.equal(status.image.current, `threebot-desktop:${current}`);
  const build = fake.calls.find((c) => c[0] === "build")!;
  assert.deepEqual(build, ["build", "--pull", "--no-cache", "-t", `threebot-desktop:${current}`, imageDir]);
  assert.equal(fake.container, current);
  fake.releaseBuild();
  await untilSettled(desktop);
  assert.equal(desktop.status(null).state, "stopped");
  assert.equal(fake.container, null);
  assert.ok(fake.calls.findIndex((c) => c[0] === "build") < fake.calls.findLastIndex((c) => c[0] === "delete"));
  const after = await desktop.computerStatus();
  assert.equal(after.image.running, null);
  assert.equal(after.image.builtAt, fake.builtAt);
  assert.equal(after.image.latest, true);
  await desktop.disable();
});

test("a failed update keeps the old container and image and says why", async (t) => {
  const { desktop, fake, imageDir } = await lifecycleSetup(t, { failBuild: true, builtAt: new Date(Date.now() - 30 * 24 * 3600_000).toISOString() });
  await desktop.enable();
  await desktop.wake();
  const current = await imageHash(imageDir);
  await desktop.update();
  await untilSettled(desktop);
  assert.equal(desktop.status(null).state, "failed");
  assert.match(desktop.status(null).reason!, /image build failed/);
  assert.equal(fake.container, current);
  assert.equal(fake.image, "built");
  const after = await desktop.computerStatus();
  assert.equal(after.image.running, `threebot-desktop:${current}`);
  assert.equal(after.image.latest, false);
  await desktop.disable();
});

test("reset removes the container, and the volumes only with erase", async (t) => {
  const { desktop, fake } = await lifecycleSetup(t);
  await desktop.enable();
  await desktop.wake();
  const volumes = () => fake.calls.filter((c) => c[0] === "volume");
  await desktop.reset({ erase: false });
  assert.equal(desktop.status(null).state, "stopped");
  assert.equal(fake.container, null);
  assert.deepEqual(volumes(), []);
  await desktop.wake();
  await desktop.reset({ erase: true });
  assert.equal(desktop.status(null).state, "stopped");
  assert.deepEqual(volumes(), [
    ["volume", "delete", "threebot-desktop-home"],
    ["volume", "delete", "threebot-desktop-workspace"],
  ]);
  await desktop.disable();
});

test("reset tolerates a volume that is already gone", async (t) => {
  const { desktop } = await lifecycleSetup(t, { volumeError: "Error: volume not found" });
  await desktop.enable();
  await desktop.wake();
  await desktop.reset({ erase: true });
  assert.equal(desktop.status(null).state, "stopped");
  await desktop.disable();
});

test("update and reset refuse while a person controls a screen", async (t) => {
  const { desktop } = await lifecycleSetup(t);
  await desktop.enable();
  await desktop.wake();
  const release = desktop.takeControl("alpha");
  const refused = (error: unknown) => (error as { status?: number }).status === 409 && /Hand the screen back first/.test((error as Error).message);
  await assert.rejects(desktop.update(), refused);
  await assert.rejects(desktop.reset({ erase: false }), refused);
  release();
  await desktop.disable();
});

test("update waits out a running Bot batch instead of failing", async (t) => {
  let releaseBatch!: () => void;
  const gate = new Promise<void>((resolve) => { releaseBatch = resolve; });
  const { desktop, fake } = await lifecycleSetup(t, { holdBuild: true }, (base) => async (args, options) => {
    if (args.includes("xdotool")) await gate;
    return base(args, options);
  });
  await desktop.enable();
  await desktop.wake();
  const batch = desktop.actions("alpha", [{ type: "click", x: 10, y: 10 }]);
  await new Promise((r) => setTimeout(r, 50));
  const updating = desktop.update();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(desktop.status(null).state, "building");
  releaseBatch();
  await batch;
  assert.equal((await updating).state, "building");
  fake.releaseBuild();
  await untilSettled(desktop);
  assert.equal(desktop.status(null).state, "stopped");
  await desktop.disable();
});

test("latest means the running tag matches the current one and the image is under 7 days old", async (t) => {
  const builtAt = new Date(Date.now() - 30 * 24 * 3600_000).toISOString();
  const { desktop, fake, imageDir } = await lifecycleSetup(t, { builtAt });
  await desktop.enable();
  const current = await imageHash(imageDir);
  let status = await desktop.computerStatus();
  assert.equal(status.image.current, `threebot-desktop:${current}`);
  assert.equal(status.image.running, null);
  assert.equal(status.image.builtAt, builtAt);
  assert.equal(status.image.latest, false);
  fake.setContainer(current);
  status = await desktop.computerStatus();
  assert.equal(status.image.running, `threebot-desktop:${current}`);
  assert.equal(status.image.latest, false);
  fake.builtAt = new Date().toISOString();
  status = await desktop.computerStatus();
  assert.equal(status.image.latest, true);
  fake.setContainer("stale");
  status = await desktop.computerStatus();
  assert.equal(status.image.latest, false);
  await desktop.disable();
});
