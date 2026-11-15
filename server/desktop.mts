// The Bots' computer (Settings › Beta › Computer): one Linux desktop container shared by all Bots,
// with one screen (X display) per Bot. It starts on first use and stops after an idle period;
// files and browser sign-ins live on volumes, so they survive the stop. It runs on Apple's
// `container` (one VM per container). Each screen's VNC server is a Unix socket that the
// runtime publishes into a private folder on the host; nothing listens on the network.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import sharp from "sharp";

export type DesktopState = "off" | "unavailable" | "building" | "stopped" | "starting" | "healthy" | "stopping" | "failed";
export interface RunResult { code: number; stdout: Buffer; stderr: string }
export type Run = (args: string[], options?: { timeoutMs?: number }) => Promise<RunResult>;

/** Tools work in this coordinate space; the screens are bigger and get scaled. */
export const MODEL_WIDTH = 1280;
export const MODEL_HEIGHT = 800;
export const SCREEN_WIDTH = 1920;
export const SCREEN_HEIGHT = 1200;
export const MAX_ACTIONS = 20;
export const CONTAINER_NAME = "threebot-desktop";
const IMAGE_REPO = "threebot-desktop";
const HOME_VOLUME = "threebot-desktop-home";
const WORKSPACE_VOLUME = "threebot-desktop-workspace";
const LABEL = "threebot.desktop";
const START_TIMEOUT_MS = 30_000;
const BUILD_TIMEOUT_MS = 15 * 60_000;
const READY_TIMEOUT_MS = 45_000;
const EXEC_TIMEOUT_MS = 60_000;

export const CONTROLLED_MESSAGE = "The person is using your screen. Take a new screenshot after they hand it back.";
export const HELP_REQUESTED_MESSAGE = "The person has been asked to take over your screen. Stop using the computer until they hand it back; you'll get a message in this thread when they do.";
const IDLE_ACTIVITY: DesktopActivity = { busy: false, last: null };

/** sha256 of every file under dir (sorted relative paths and contents), so a changed image rebuilds. */
export async function imageHash(dir: string): Promise<string> {
  const files: string[] = [];
  const walk = async (sub: string) => {
    for (const entry of await fs.readdir(path.join(dir, sub), { withFileTypes: true })) {
      const rel = path.join(sub, entry.name);
      if (entry.isDirectory()) await walk(rel); else if (entry.isFile()) files.push(rel);
    }
  };
  await walk("");
  const hash = createHash("sha256");
  for (const rel of files.sort()) {
    hash.update(rel.split(path.sep).join("/") + "\0");
    hash.update(await fs.readFile(path.join(dir, rel)));
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}

export function runArgs({ image, hash, screens, socketDir }: { image: string; hash: string; screens: number; socketDir: string }): string[] {
  const memoryMb = 1024 + 512 * screens;
  const sockets = Array.from({ length: screens }, (_, i) => ["--publish-socket", `${path.join(socketDir, `${i + 1}.sock`)}:/tmp/vnc/${i + 1}.sock`]).flat();
  return [
    "run", "-d", "--name", CONTAINER_NAME, "--label", `${LABEL}=${hash}`,
    "-e", `SCREENS=${screens}`, "-e", `GEOMETRY=${SCREEN_WIDTH}x${SCREEN_HEIGHT}`,
    "--memory", `${memoryMb}m`, "--cpus", "2",
    "-v", `${HOME_VOLUME}:/home/bot`, "-v", `${WORKSPACE_VOLUME}:/workspace`,
    ...sockets,
    image,
  ];
}

function inspectedRunning(inspect: unknown): boolean {
  const item = Array.isArray(inspect) ? inspect[0] : inspect;
  return item?.status === "running";
}

// ---------- actions ----------
const KEYS_RE = /^[A-Za-z0-9_]+(\+[A-Za-z0-9_]+)*( [A-Za-z0-9_]+(\+[A-Za-z0-9_]+)*)*$/;
const SCROLL_BUTTON = { up: "4", down: "5", left: "6", right: "7" } as const;

function point(action: Record<string, unknown>, xKey: string, yKey: string): [string, string] {
  const x = action[xKey], y = action[yKey];
  if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`${xKey}/${yKey} must be numbers`);
  if (x < 0 || y < 0 || x >= MODEL_WIDTH || y >= MODEL_HEIGHT) throw new Error(`${xKey},${yKey} must be inside ${MODEL_WIDTH}x${MODEL_HEIGHT}`);
  return [String(Math.round((x * SCREEN_WIDTH) / MODEL_WIDTH)), String(Math.round((y * SCREEN_HEIGHT) / MODEL_HEIGHT))];
}

/**
 * Model actions → xdotool argument lists (no shell), run in order. `type` takes every argument after it as
 * text, so each one ends its list. Throws on anything it can't do safely.
 */
export function xdotoolArgs(actions: unknown): string[][] {
  if (!Array.isArray(actions) || actions.length === 0) throw new Error("actions must be a non-empty list");
  if (actions.length > MAX_ACTIONS) throw new Error(`At most ${MAX_ACTIONS} actions per call`);
  const runs: string[][] = [];
  let out: string[] = [];
  for (const raw of actions) {
    const action = (raw ?? {}) as Record<string, unknown>;
    switch (action.type) {
      case "move": out.push("mousemove", ...point(action, "x", "y")); break;
      case "click": out.push("mousemove", ...point(action, "x", "y"), "click", "1"); break;
      case "double_click": out.push("mousemove", ...point(action, "x", "y"), "click", "--repeat", "2", "--delay", "80", "1"); break;
      case "right_click": out.push("mousemove", ...point(action, "x", "y"), "click", "3"); break;
      case "drag": out.push("mousemove", ...point(action, "x", "y"), "mousedown", "1", "mousemove", ...point(action, "toX", "toY"), "mouseup", "1"); break;
      case "scroll": {
        const direction = action.direction as keyof typeof SCROLL_BUTTON;
        if (!(direction in SCROLL_BUTTON)) throw new Error("scroll direction must be up, down, left or right");
        const amount = action.amount === undefined ? 3 : action.amount;
        if (!Number.isInteger(amount) || (amount as number) < 1 || (amount as number) > 30) throw new Error("scroll amount must be 1..30");
        out.push("mousemove", ...point(action, "x", "y"), "click", "--repeat", String(amount), "--delay", "30", SCROLL_BUTTON[direction]);
        break;
      }
      case "type": {
        if (typeof action.text !== "string" || !action.text || action.text.length > 2000) throw new Error("type text must be 1..2000 characters");
        out.push("type", "--delay", "12", "--", action.text);
        runs.push(out);
        out = [];
        break;
      }
      case "key": {
        if (typeof action.keys !== "string" || !KEYS_RE.test(action.keys)) throw new Error("key must look like ctrl+l, Return or ctrl+shift+t");
        out.push("key", "--clearmodifiers", ...action.keys.split(" "));
        break;
      }
      case "wait": {
        const ms = action.ms;
        if (typeof ms !== "number" || ms < 0 || ms > 10_000) throw new Error("wait ms must be 0..10000");
        out.push("sleep", String(ms / 1000));
        break;
      }
      default: throw new Error(`Unknown action type: ${String(action.type)}`);
    }
  }
  if (out.length) runs.push(out);
  return runs;
}

/** The pointer position a watcher sees for an action, in model coordinates; a drag points where it ends. */
function pointerSpot(action: Record<string, unknown>): { type: string; x: number; y: number } | null {
  switch (action.type) {
    case "move": case "click": case "double_click": case "right_click": case "scroll": return { type: action.type as string, x: action.x as number, y: action.y as number };
    case "drag": return { type: "drag", x: action.toX as number, y: action.toY as number };
    default: return null;
  }
}

// ---------- the viewer's RFB stream ----------
/**
 * Checks what a viewer's browser sends to a screen's VNC server, message by message. Watchers may
 * only ask for pictures; key, pointer, clipboard and resize messages are dropped. Control adds keys
 * and the pointer. Anything this doesn't recognise ends the connection, so an unknown extension can
 * never slip input through. The server allows no clipboard or resizing either (start.sh).
 */
export function createRfbClientFilter(mode: "watch" | "control") {
  let buffer = Buffer.alloc(0);
  let stage: "version" | "security" | "init" | "messages" = "version";
  const control = mode === "control";
  /** Bytes of the complete message at the front of the buffer, null while it is still arriving. */
  function messageLength(): number | null {
    const need = (n: number) => (buffer.length >= n ? n : null);
    switch (buffer[0]) {
      case 0: return need(20); // SetPixelFormat
      case 2: return buffer.length < 4 ? null : need(4 + 4 * buffer.readUInt16BE(2)); // SetEncodings
      case 3: return need(10); // FramebufferUpdateRequest
      case 4: return need(8); // KeyEvent
      case 5: return need(6); // PointerEvent
      case 6: return buffer.length < 8 ? null : need(8 + buffer.readUInt32BE(4)); // ClientCutText
      case 150: return need(10); // EnableContinuousUpdates
      case 248: return buffer.length < 9 ? null : need(9 + buffer[8]); // ClientFence
      case 251: return buffer.length < 8 ? null : need(8 + 16 * buffer[6]); // SetDesktopSize
      case 255: return buffer.length < 2 ? null : buffer[1] === 0 ? need(12) : -1; // QEMU extended key event
      default: return -1;
    }
  }
  function allowed(type: number): boolean {
    if (type === 0 || type === 2 || type === 3 || type === 150 || type === 248) return true;
    if (type === 4 || type === 5 || type === 255) return control;
    return false;
  }
  /** Returns the bytes to pass on; throws when the stream must be closed. */
  return (chunk: Buffer): Buffer => {
    buffer = Buffer.concat([buffer, chunk]);
    const out: Buffer[] = [];
    for (;;) {
      if (stage === "version") {
        if (buffer.length < 12) break;
        if (buffer.subarray(0, 12).toString("latin1") !== "RFB 003.008\n") throw new Error("unsupported RFB version");
        out.push(buffer.subarray(0, 12)); buffer = buffer.subarray(12); stage = "security";
      } else if (stage === "security") {
        if (buffer.length < 1) break;
        if (buffer[0] !== 1) throw new Error("only the None security type is offered");
        out.push(buffer.subarray(0, 1)); buffer = buffer.subarray(1); stage = "init";
      } else if (stage === "init") {
        if (buffer.length < 1) break;
        out.push(Buffer.from([1])); buffer = buffer.subarray(1); stage = "messages"; // always shared
      } else {
        if (buffer.length === 0) break;
        const length = messageLength();
        if (length === -1) throw new Error(`unknown RFB message ${buffer[0]}`);
        if (length === null) break;
        if (allowed(buffer[0])) out.push(buffer.subarray(0, length));
        buffer = buffer.subarray(length);
      }
      if (buffer.length > 1 << 20) throw new Error("RFB message too large");
    }
    if (buffer.length > 1 << 20) throw new Error("RFB message too large");
    return Buffer.concat(out);
  };
}

// ---------- the module ----------
export interface DesktopOptions {
  imageDir: string;
  /** Private (0700) folder where the screens' VNC sockets appear. Keep the path short: macOS allows 104 bytes. */
  socketDir: string;
  /** False where Apple's `container` can't run (anything but macOS). */
  supported?: boolean;
  run?: Run;
  screens?: number;
  idleMs?: number;
  log?: (line: string) => void;
  /** The person handed a screen back while its Bot had a pending help request; the gateway tells the Bot's thread. */
  onHelpReturned?: (slug: string, instruction: string) => void;
}

export interface DesktopActivity { busy: boolean; last: { type: string; x: number; y: number; at: string } | null }
export interface DesktopStatus { state: DesktopState; reason: string | null; screens: number; display: number | null; controlled: boolean; helpRequest: { instruction: string; at: string } | null; activity: DesktopActivity }

export function spawnRun(cli = "container"): Run {
  return (args, { timeoutMs = START_TIMEOUT_MS } = {}) => new Promise((resolve) => {
    const child = spawn(cli, args, { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = []; let err = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => { err = (err + chunk.toString()).slice(-4000); });
    child.on("error", (error) => { clearTimeout(timer); resolve({ code: -1, stdout: Buffer.alloc(0), stderr: String(error.message) }); });
    child.on("close", (code, signal) => { clearTimeout(timer); resolve({ code: code ?? (signal ? -2 : -1), stdout: Buffer.concat(out), stderr: signal === "SIGKILL" ? `timed out after ${timeoutMs} ms` : err }); });
  });
}

export function createDesktop({ imageDir, socketDir, supported = true, run = spawnRun(), screens = 4, idleMs = 120_000, log = () => {}, onHelpReturned }: DesktopOptions) {
  let state: DesktopState = "off";
  let reason: string | null = null;
  let hash: string | null = null;
  let building: Promise<void> | null = null;
  let chain: Promise<unknown> = Promise.resolve();
  let idleTimer: NodeJS.Timeout | null = null;
  let busy = 0;
  const leases = new Map<string, number>();
  const controlled = new Map<string, number>();
  const helpRequests = new Map<string, { instruction: string; at: string }>();
  const activities = new Map<string, DesktopActivity>();
  const screenBusy = new Set<number>();

  /** One transition at a time. */
  const serial = <T,>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn);
    chain = next.catch(() => {});
    return next;
  };
  const image = () => `${IMAGE_REPO}:${hash}`;
  const fail = (why: string) => { state = "failed"; reason = why.trim().split("\n").slice(-3).join(" ").slice(0, 500); log(`desktop: failed: ${reason}`); };

  async function inspect(): Promise<unknown | null> {
    const result = await run(["inspect", CONTAINER_NAME]);
    if (result.code !== 0) return null;
    try { const parsed = JSON.parse(result.stdout.toString()); return Array.isArray(parsed) && parsed.length === 0 ? null : parsed; } catch { return null; }
  }
  async function remove() {
    // Browsers write cookies on a clean exit; give them a moment so sign-ins survive the stop.
    if (state === "healthy" || state === "stopping") {
      await run(["exec", "-u", "bot", CONTAINER_NAME, "pkill", "-TERM", "chromium"], { timeoutMs: 5000 });
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    await run(["delete", "--force", CONTAINER_NAME]);
  }
  async function exec(args: string[], { user = "bot", display, timeoutMs = EXEC_TIMEOUT_MS }: { user?: string; display?: number; timeoutMs?: number } = {}) {
    const env = display ? ["-e", `DISPLAY=:${display}`, "-e", "HOME=/home/bot"] : [];
    return run(["exec", "-u", user, ...env, CONTAINER_NAME, ...args], { timeoutMs });
  }

  function scheduleIdle() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    if (state !== "healthy" || busy > 0 || controlled.size > 0) return;
    idleTimer = setTimeout(() => { idleTimer = null; void stop("idle").catch(() => {}); }, idleMs);
    idleTimer.unref?.();
  }

  async function ensureImage() {
    hash = await imageHash(imageDir);
    if ((await run(["image", "inspect", image()])).code === 0) return;
    if (!building) {
      building = (async () => {
        state = "building"; reason = null;
        log(`desktop: building ${image()}`);
        const result = await run(["build", "-t", image(), imageDir], { timeoutMs: BUILD_TIMEOUT_MS });
        if (result.code !== 0) throw new Error(`image build failed: ${result.stderr}`);
        log(`desktop: built ${image()}`);
      })().finally(() => { building = null; });
    }
    await building;
  }

  async function probe(): Promise<boolean> {
    if (!supported) { state = "unavailable"; reason = "The computer runs on macOS with Apple's container for now."; return false; }
    const result = await run(["system", "status"], { timeoutMs: 10_000 });
    if (result.code === 0) return true;
    state = "unavailable";
    reason = result.code === -1 ? "Apple's container isn't installed (github.com/apple/container)." : "Apple's container isn't running. Start it with: container system start";
    return false;
  }

  /** Switched on: check the runtime, build the image if needed, adopt a matching container or remove a stale one. */
  function enable() {
    return serial(async () => {
      if (state !== "off" && state !== "unavailable" && state !== "failed") return;
      if (!(await probe())) return;
      try { await ensureImage(); } catch (error) { return fail(String((error as Error).message)); }
      // A container left from an earlier gateway is restarted fresh rather than adopted.
      if (await inspect()) await remove();
      state = "stopped"; reason = null;
    });
  }

  function stop(why: string) {
    return serial(async () => {
      if (state !== "healthy" && state !== "starting" && state !== "failed") return;
      if (why === "idle" && (busy > 0 || controlled.size > 0)) return;
      state = "stopping";
      log(`desktop: stopping (${why})`);
      await remove();
      leases.clear(); screenBusy.clear();
      state = "stopped";
    });
  }

  /** Switched off: stop and forget. */
  function disable() {
    return serial(async () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = null;
      if (state === "healthy" || state === "starting" || state === "failed" || state === "stopped") await remove();
      leases.clear(); controlled.clear(); screenBusy.clear();
      state = "off"; reason = null;
    });
  }

  function wake(): Promise<void> {
    if (state === "healthy") return Promise.resolve();
    return serial(async () => {
      if (state === "healthy") return;
      if (state === "off") throw Object.assign(new Error("The computer is switched off in Settings › Beta."), { status: 404 });
      if (state === "unavailable" && !(await probe())) throw Object.assign(new Error(`Computer unavailable: ${reason}`), { status: 503 });
      try { await ensureImage(); } catch (error) { fail(String((error as Error).message)); throw Object.assign(new Error(`Computer unavailable: ${reason}`), { status: 503 }); }
      state = "starting"; reason = null;
      await remove();
      await fs.mkdir(socketDir, { recursive: true, mode: 0o700 });
      await fs.chmod(socketDir, 0o700);
      for (let display = 1; display <= screens; display++) await fs.rm(path.join(socketDir, `${display}.sock`), { force: true });
      const started = await run(runArgs({ image: image(), hash: hash!, screens, socketDir }), { timeoutMs: START_TIMEOUT_MS });
      if (started.code !== 0) { fail(started.stderr); throw Object.assign(new Error(`The computer didn't start: ${reason}`), { status: 503 }); }
      const deadline = Date.now() + READY_TIMEOUT_MS;
      while (Date.now() < deadline) {
        const ready = await exec(["test", "-f", "/tmp/desktop-ready"], { timeoutMs: 5000 });
        if (ready.code === 0) break;
        if (!inspectedRunning(await inspect())) break;
        await new Promise((r) => setTimeout(r, 400));
      }
      const found = await inspect();
      const ready = found && inspectedRunning(found) ? (await exec(["test", "-f", "/tmp/desktop-ready"], { timeoutMs: 5000 })).code === 0 : false;
      if (!ready) {
        const logs = await run(["logs", CONTAINER_NAME], { timeoutMs: 5000 });
        fail(`not ready: ${logs.stdout.toString().slice(-500) || logs.stderr}`);
        await remove();
        throw Object.assign(new Error(`The computer didn't start: ${reason}`), { status: 503 });
      }
      state = "healthy";
      log(`desktop: healthy with ${screens} screens`);
      scheduleIdle();
    });
  }

  /** The Bot's screen number, taking the lowest free one the first time. */
  function lease(slug: string): number {
    const held = leases.get(slug);
    if (held) return held;
    const taken = new Set(leases.values());
    for (let display = 1; display <= screens; display++) {
      if (!taken.has(display)) { leases.set(slug, display); return display; }
    }
    throw Object.assign(new Error(`All ${screens} screens are busy.`), { status: 409 });
  }

  /** Runs one Bot call against its screen, counting it as activity so the desktop isn't stopped under it. */
  async function withScreen<T>(slug: string, fn: (display: number) => Promise<T>): Promise<T> {
    busy++;
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    try {
      if (controlled.has(slug)) throw new Error(CONTROLLED_MESSAGE);
      await wake();
      const display = lease(slug);
      if (screenBusy.has(display)) throw new Error("Your screen is busy with another batch of actions. Wait for it to finish.");
      screenBusy.add(display);
      try { return await fn(display); } finally { screenBusy.delete(display); }
    } finally { busy--; scheduleIdle(); }
  }

  async function capture(display: number): Promise<string> {
    const file = `/tmp/shot-${display}.png`;
    const shot = await exec(["sh", "-c", `scrot -o -z ${file} && cat ${file} && rm -f ${file}`], { display });
    if (shot.code !== 0 || shot.stdout.length === 0) throw new Error(`Screenshot failed: ${shot.stderr.trim().slice(-300)}`);
    const scaled = await sharp(shot.stdout).resize(MODEL_WIDTH, MODEL_HEIGHT, { fit: "fill" }).png({ compressionLevel: 6 }).toBuffer();
    return scaled.toString("base64");
  }

  return {
    enable,
    disable,
    wake,
    stop,
    status(slug: string | null): DesktopStatus {
      return { state, reason, screens, display: slug ? leases.get(slug) ?? null : null, controlled: slug ? controlled.has(slug) : false, helpRequest: slug ? helpRequests.get(slug) ?? null : null, activity: (slug ? activities.get(slug) : undefined) ?? IDLE_ACTIVITY };
    },
    /** The Bot's screen socket, for the gateway's viewer connection. Watching vs control is the gateway's filter. */
    vncSocket(slug: string): string | null {
      if (state !== "healthy") return null;
      return path.join(socketDir, `${lease(slug)}.sock`);
    },
    /** A person takes over a Bot's screen; Bot calls return at once until every control session ends. */
    takeControl(slug: string) {
      controlled.set(slug, (controlled.get(slug) ?? 0) + 1);
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      return () => {
        const left = (controlled.get(slug) ?? 1) - 1;
        if (left > 0) { controlled.set(slug, left); return; }
        controlled.delete(slug);
        // Handing the screen back is also the answer to a pending help request.
        const help = helpRequests.get(slug);
        if (help) { helpRequests.delete(slug); onHelpReturned?.(slug, help.instruction); }
        scheduleIdle();
      };
    },
    /** The Bot asks the person to take over; a newer request replaces an older one. */
    requestHelp(slug: string, instruction: unknown) {
      const text = typeof instruction === "string" ? instruction.trim() : "";
      if (!text) throw new Error("instruction is required");
      if (text.length > 500) throw new Error("instruction must be at most 500 characters");
      helpRequests.set(slug, { instruction: text, at: new Date().toISOString() });
    },
    screenshot(slug: string) { return withScreen(slug, capture); },
    async actions(slug: string, actions: unknown) {
      const args = xdotoolArgs(actions);
      // A watcher follows the batch: busy for its whole run, the pointer at each action as it happens.
      activities.set(slug, { busy: true, last: activities.get(slug)?.last ?? null });
      // The same split into runs as xdotoolArgs makes, so the recorded pointer tracks execution.
      const groups: Record<string, unknown>[][] = [[]];
      for (const action of actions as Record<string, unknown>[]) {
        groups.at(-1)!.push(action);
        if (action.type === "type") groups.push([]);
      }
      if (!groups.at(-1)!.length) groups.pop();
      try {
        return await withScreen(slug, async (display) => {
          for (let i = 0; i < args.length; i++) {
            for (const action of groups[i]) {
              const spot = pointerSpot(action);
              if (spot) activities.set(slug, { busy: true, last: { ...spot, at: new Date().toISOString() } });
            }
            const result = await exec(["xdotool", ...args[i]], { display });
            if (result.code !== 0) throw new Error(`Actions failed: ${result.stderr.trim().slice(-300)}`);
          }
          // Let the screen settle before the screenshot.
          await new Promise((resolve) => setTimeout(resolve, 400));
          return capture(display);
        });
      } finally {
        activities.set(slug, { busy: false, last: activities.get(slug)?.last ?? null });
      }
    },
  };
}

export type Desktop = ReturnType<typeof createDesktop>;

// ---------- the Bots' tools (on the `bot` MCP server while the beta is on) ----------
export const DESKTOP_TOOLS = [
  {
    name: "computer_screenshot",
    title: "See your screen",
    description: `A ${MODEL_WIDTH}x${MODEL_HEIGHT} screenshot of your own screen on the shared desktop. Starts the desktop if it's asleep (up to about 45 seconds).`,
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: "computer_actions",
    title: "Use your screen",
    description: `Run up to ${MAX_ACTIONS} actions on your screen in order, then return a screenshot. Coordinates are in ${MODEL_WIDTH}x${MODEL_HEIGHT}. Actions: {type:"click"|"double_click"|"right_click"|"move", x, y}, {type:"drag", x, y, toX, toY}, {type:"scroll", x, y, direction:"up"|"down"|"left"|"right", amount?}, {type:"type", text}, {type:"key", keys:"ctrl+l" or "Return"}, {type:"wait", ms}.`,
    inputSchema: {
      type: "object",
      required: ["actions"],
      properties: { actions: { type: "array", maxItems: MAX_ACTIONS, items: { type: "object", required: ["type"], properties: { type: { type: "string", enum: ["move", "click", "double_click", "right_click", "drag", "scroll", "type", "key", "wait"] } } } } },
    },
  },
  {
    name: "computer_request_help",
    title: "Ask for a hand",
    description: `Ask the person to take over your screen for a step only they can do (signing in, 2FA, a CAPTCHA). Stop using the computer until they hand it back; that arrives as a message in your thread.`,
    inputSchema: { type: "object", required: ["instruction"], properties: { instruction: { type: "string", maxLength: 500 } } },
  },
] as const;

type ToolContent = { content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[]; isError?: boolean };

export function createDesktopTools(desktop: Pick<Desktop, "screenshot" | "actions" | "requestHelp">) {
  return async (name: string, args: Record<string, unknown>, { auth }: { auth: { botSlug: string | null } }): Promise<ToolContent> => {
    // The screen is chosen by the caller's own bearer, never by an argument, so a Bot can't drive another Bot's screen.
    if (!auth.botSlug) return { content: [{ type: "text", text: "The computer needs your own Bot token. Restart your session so it picks it up." }], isError: true };
    try {
      if (name === "computer_request_help") {
        desktop.requestHelp(auth.botSlug, args.instruction);
        return { content: [{ type: "text", text: HELP_REQUESTED_MESSAGE }] };
      }
      const data = name === "computer_actions" ? await desktop.actions(auth.botSlug, args.actions) : await desktop.screenshot(auth.botSlug);
      return { content: [{ type: "image", data, mimeType: "image/png" }] };
    } catch (error) {
      return { content: [{ type: "text", text: String((error as Error).message ?? error) }], isError: true };
    }
  };
}
