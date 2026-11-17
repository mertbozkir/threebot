// Browser client for T3 Code's WebSocket RPC (Effect RPC, JSON, protocol 2),
// reached through the gateway at /t3/ws. See docs/t3-api.md.

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  onChunk?: (v: any) => void;
  stream?: boolean;
};

/** live: the request reached the current socket and is still streaming, so a reconnect hook need not open it again. */
export type StreamHandle = { cancel: () => void; done: Promise<void>; live: () => boolean };

export class T3RpcError extends Error {
  constructor(message: string, public cause?: unknown) {
    super(message);
  }
}

type Listener = (state: "connecting" | "open" | "closed") => void;

export class T3Client {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<string, Pending>();
  private queue: string[] = [];
  private pingTimer: number | undefined;
  private reconnectDelay = 500;
  private reconnectTimer: number | undefined;
  private socketId = 0;
  private sentOn = new Map<string, number>();
  private pongWait: number | undefined;
  private listeners = new Set<Listener>();
  private reconnectHooks = new Set<() => void>();
  state: "connecting" | "open" | "closed" = "closed";

  constructor(readonly environmentId?: string) {}

  lastError: T3RpcError | null = null;
  private checking = false;
  connect() {
    if (this.environmentId) {
      if (this.checking || (this.ws && this.ws.readyState <= WebSocket.OPEN)) return;
      this.checking = true;
      this.setState("connecting");
      void environmentHttp(this.environmentId, "/.well-known/t3/environment").then(() => { this.lastError = null; this.openSocket(); }).catch((error: unknown) => {
        this.lastError = error instanceof T3RpcError ? error : new T3RpcError("Couldn't reach the linked machine");
        this.queue = [];
        for (const pending of this.pending.values()) pending.reject(this.lastError);
        this.pending.clear(); this.setState("closed");
      }).finally(() => { this.checking = false; });
      return;
    }
    this.openSocket();
  }
  private openSocket() {
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return;
    this.setState("connecting");
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}${environmentPrefix(this.environmentId)}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.reconnectDelay = 500;
      this.socketId++;
      this.setState("open");
      for (const m of this.queue.splice(0)) this.send(ws, m);
      window.clearInterval(this.pingTimer);
      this.pingTimer = window.setInterval(() => this.raw({ _tag: "Ping" }), 15_000);
      for (const h of this.reconnectHooks) h();
    };
    ws.onmessage = (ev) => this.onMessage(ev.data);
    ws.onclose = () => {
      window.clearInterval(this.pingTimer);
      // Once a caller is rejected it owns retry/discard. Never transmit its
      // queued request later after the UI has restored or edited the payload.
      this.queue = [];
      for (const [id, p] of this.pending) {
        if (p.stream) p.resolve(undefined);
        else p.reject(new T3RpcError("connection lost"));
        this.pending.delete(id);
      }
      this.setState("closed");
      window.clearTimeout(this.pongWait);
      this.reconnectTimer = window.setTimeout(() => this.connect(), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 10_000);
    };
  }

  /**
   * After the page was hidden or offline, the socket may be dead while still reading OPEN, and a
   * pending retry may be seconds away. Reconnect now, or close the socket if a ping gets no pong.
   */
  checkAlive(timeoutMs = 3000) {
    if (this.environmentId && this.state === "closed" && !this.checking) return this.connect();
    if (!this.ws || this.ws.readyState > WebSocket.OPEN) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectDelay = 500;
      return this.connect();
    }
    if (this.ws.readyState !== WebSocket.OPEN || this.pongWait !== undefined) return;
    const ws = this.ws;
    const timer: number = window.setTimeout(() => {
      if (this.pongWait !== timer) return;
      this.pongWait = undefined;
      if (this.ws === ws) ws.close();
    }, timeoutMs);
    this.pongWait = timer;
    this.raw({ _tag: "Ping" });
  }

  private send(ws: WebSocket, text: string) {
    ws.send(text);
    const id = /^\{"_tag":"Request","id":"([^"]+)"/.exec(text)?.[1];
    if (id && this.pending.get(id)?.stream) this.sentOn.set(id, this.socketId);
  }

  onState(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Called after every (re)connect, so subscriptions can be restored. */
  onReconnect(fn: () => void) {
    this.reconnectHooks.add(fn);
    return () => this.reconnectHooks.delete(fn);
  }

  private setState(s: T3Client["state"]) {
    this.state = s;
    for (const l of this.listeners) l(s);
  }

  private raw(msg: unknown) {
    const text = JSON.stringify(msg);
    if (this.ws?.readyState === WebSocket.OPEN) this.send(this.ws, text);
    else this.queue.push(text);
  }

  private onMessage(raw: string) {
    const data = JSON.parse(raw);
    for (const msg of Array.isArray(data) ? data : [data]) {
      if (msg._tag === "Pong") { window.clearTimeout(this.pongWait); this.pongWait = undefined; continue; }
      if (msg._tag === "Defect") {
        console.error("[t3 defect]", msg.defect);
        continue;
      }
      const id = String(msg.requestId);
      const p = this.pending.get(id);
      if (!p) continue;
      if (msg._tag === "Chunk") {
        this.raw({ _tag: "Ack", requestId: id });
        for (const v of msg.values) {
          try {
            p.onChunk?.(v);
          } catch (e) {
            console.error("stream handler failed", e);
          }
        }
      } else if (msg._tag === "Exit") {
        this.pending.delete(id);
        if (msg.exit._tag === "Success") p.resolve(msg.exit.value);
        else if (p.stream && isInterrupt(msg.exit.cause)) p.resolve(undefined);
        else p.reject(new T3RpcError(describeCause(msg.exit.cause), msg.exit.cause));
      }
    }
  }

  call<T = any>(tag: string, payload: unknown = {}, options: { timeoutMs?: number } = {}): Promise<T> {
    if (this.environmentId && this.state === "closed") this.connect();
    const id = String(this.nextId++);
    return new Promise<T>((resolve, reject) => {
      const message = { _tag: "Request", id, tag, payload, headers: [] };
      const timer = options.timeoutMs === undefined ? undefined : setTimeout(() => {
        this.pending.delete(id);
        // A timed-out queued command must never be sent after its draft has
        // been restored. A transmitted command retains its ID for safe retry.
        this.queue = this.queue.filter(queued => queued !== JSON.stringify(message));
        if (this.ws?.readyState === WebSocket.OPEN) this.raw({ _tag: "Interrupt", requestId: id });
        reject(new T3RpcError("Couldn't confirm delivery. Try again."));
      }, options.timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value as T); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.raw(message);
    });
  }

  stream(tag: string, payload: unknown, onItem: (item: any) => void): StreamHandle {
    if (this.environmentId && this.state === "closed") this.connect();
    const id = String(this.nextId++);
    const done = new Promise<void>((resolve, reject) => {
      this.pending.set(id, { resolve: () => resolve(), reject, onChunk: onItem, stream: true });
    });
    done.catch((e) => console.warn(`stream ${tag} ended`, e));
    const request = JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] });
    if (this.ws?.readyState === WebSocket.OPEN) this.send(this.ws, request);
    else this.queue.push(request);
    void done.finally(() => this.sentOn.delete(id)).catch(() => {});
    return {
      done,
      live: () => this.pending.has(id) && this.sentOn.get(id) === this.socketId,
      cancel: () => {
        const pending = this.pending.get(id);
        if (!pending) return;
        // Never sent: drop it, so the server doesn't build a snapshot nobody reads.
        if (this.queue.includes(request)) {
          this.queue = this.queue.filter((queued) => queued !== request);
          this.pending.delete(id);
          pending.resolve(undefined);
          return;
        }
        this.raw({ _tag: "Interrupt", requestId: id });
      },
    };
  }

  dispatch(command: Record<string, unknown>, options: { timeoutMs?: number } = {}) {
    return this.call<{ sequence: number }>("orchestration.dispatchCommand", { commandId: uuid(), ...command }, options);
  }
}

function isInterrupt(cause: any): boolean {
  return Array.isArray(cause) && cause.length > 0 && cause.every((c) => c?._tag === "Interrupt");
}

function describeCause(cause: any): string {
  if (!cause) return "unknown failure";
  if (Array.isArray(cause)) return cause.map(describeCause).join("; ");
  if (cause._tag === "Interrupt") return "interrupted";
  if (cause._tag === "Fail") return cause.error?.message ?? cause.error?._tag ?? JSON.stringify(cause.error);
  if (cause._tag === "Die") return "defect: " + (typeof cause.defect === "string" ? cause.defect : JSON.stringify(cause.defect));
  return JSON.stringify(cause);
}

export function uuid(): string {
  // crypto.randomUUID only exists on HTTPS or localhost; the app is usually opened over plain LAN HTTP.
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export async function copyText(text: string) {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
  if (typeof document.execCommand !== "function") throw new Error("Clipboard unavailable");
  const previousFocus = document.activeElement;
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.readOnly = true;
  ta.style.position = "fixed";
  ta.style.top = "0";
  ta.style.left = "0";
  ta.style.width = "1px";
  ta.style.height = "1px";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  try {
    ta.focus({ preventScroll: true });
    ta.select();
    if (!document.execCommand("copy")) throw new Error("Copy failed");
  } finally {
    ta.remove();
    if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true });
  }
}

export const t3 = new T3Client();
const environments = new Map<string, T3Client>();
export function environmentPrefix(environmentId?: string) {
  return environmentId ? `/t3/environments/${encodeURIComponent(environmentId)}` : "/t3";
}
/** One transport per machine; never route a remote id to the local server. */
export function environmentT3(environmentId?: string): T3Client {
  if (!environmentId) return t3;
  let client = environments.get(environmentId);
  if (!client) { client = new T3Client(environmentId); environments.set(environmentId, client); client.connect(); }
  return client;
}
/** Every open transport: the local one and each linked machine's. */
export function allT3Clients(): T3Client[] {
  return [t3, ...environments.values()];
}
export type ThreadTarget = { threadId: string; environmentId?: string };
export function threadKey({ threadId, environmentId }: ThreadTarget) {
  return environmentId ? `environment:${encodeURIComponent(environmentId)}:${encodeURIComponent(threadId)}` : threadId;
}
export function threadTarget(key: string): ThreadTarget {
  const match = /^environment:([^:]+):(.+)$/.exec(key);
  return match ? { environmentId: decodeURIComponent(match[1]), threadId: decodeURIComponent(match[2]) } : { threadId: key };
}
export function threadClient(key: string) { return environmentT3(threadTarget(key).environmentId); }
export async function environmentHttp<T = unknown>(environmentId: string | undefined, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(environmentPrefix(environmentId) + path, { ...init, headers: { "x-t3-orchestration-protocol": "2", ...init.headers } });
  if (!res.ok) {
    const error = await res.json().catch(() => null);
    throw new T3RpcError(error?.error ?? `T3 HTTP ${res.status}`);
  }
  const body = await res.text();
  return (body ? JSON.parse(body) : undefined) as T;
}

/** Authenticated HTTP to T3 through the gateway. */
export async function t3http<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  return environmentHttp<T>(undefined, path, init);
}
