// Live dictation: the microphone streams to the gateway, which relays it to OpenAI with the saved
// key, and the text comes back while you speak. Protocol: we send 24 kHz mono PCM16 frames and
// {"type":"stop"}; the gateway sends {"type":"committed", item, previous},
// {"type":"delta"|"done", item, text}, {"type":"limit"} and
// {"type":"error", message}, then closes once the last phrase is written.

export const LIVE_RATE = 24_000;
/** A recording left on stops itself; the gateway enforces the same cap. */
export const MAX_LIVE_SECONDS = 5 * 60;

/** Linear resampling to 24 kHz and PCM16: speech needs nothing finer, and it runs on every frame. */
export function toPcm16(input: Float32Array, fromRate: number, toRate = LIVE_RATE): Int16Array<ArrayBuffer> {
  const length = Math.floor(input.length * toRate / fromRate);
  const out = new Int16Array(length);
  const step = fromRate / toRate;
  for (let i = 0; i < length; i++) {
    const position = i * step;
    const index = Math.floor(position);
    const next = Math.min(index + 1, input.length - 1);
    // `|| 0` turns a NaN sample into silence without spoiling its neighbour.
    const from = input[index] || 0, to = input[next] || 0;
    const clamped = Math.max(-1, Math.min(1, from + (to - from) * (position - index)));
    out[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  return out;
}

/** Phrases in the order they started; a phrase's final text replaces its running deltas. */
export function liveTranscript() {
  const order: string[] = [];
  const text = new Map<string, string>();
  const previous = new Map<string, string | null>();
  const remember = (item: string) => { if (!order.includes(item)) order.push(item); };
  return {
    committed(item: string, before: string | null) { remember(item); previous.set(item, before); },
    delta(item: string, piece: string) { remember(item); text.set(item, (text.get(item) ?? "") + piece); },
    done(item: string, full: string) { remember(item); text.set(item, full); },
    toString() {
      const sorted: string[] = [];
      const visited = new Set<string>();
      const visit = (item: string) => {
        if (visited.has(item)) return;
        visited.add(item);
        const before = previous.get(item);
        if (before) visit(before);
        sorted.push(item);
      };
      order.forEach(visit);
      return sorted.map(item => text.get(item)?.trim()).filter(Boolean).join(" ");
    },
  };
}

export type LiveDictation = { stop: () => void; cancel: () => void };

export async function startLiveDictation({ lang, onText, onError, onLimit, onEnd }: {
  lang: string;
  onText: (text: string) => void;
  onError: (message: string) => void;
  onLimit: () => void;
  onEnd: () => void;
}): Promise<LiveDictation> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const context = new Context();
  const source = context.createMediaStreamSource(stream);
  // ScriptProcessor is deprecated but runs everywhere without a separate worklet file; 4096 frames is ~85 ms.
  const processor = context.createScriptProcessor(4096, 1, 1);
  const socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/voice/cloud/live?lang=${encodeURIComponent(lang)}`);
  socket.binaryType = "arraybuffer";
  const transcript = liveTranscript();
  const early: ArrayBuffer[] = [];
  let ended = false;
  let stopped = false;
  let failed = false;

  const releaseAudio = () => {
    processor.onaudioprocess = null;
    try { source.disconnect(); processor.disconnect(); } catch { /* already disconnected */ }
    for (const track of stream.getTracks()) track.stop();
    void context.close().catch(() => {});
  };
  const end = () => {
    if (ended) return;
    ended = true;
    clearTimeout(limit);
    releaseAudio();
    onEnd();
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    releaseAudio();
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "stop" }));
    else if (socket.readyState === WebSocket.CONNECTING) socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "stop" })), { once: true });
    else end();
  };

  processor.onaudioprocess = (event) => {
    if (stopped) return;
    const pcm = toPcm16(event.inputBuffer.getChannelData(0), context.sampleRate).buffer;
    if (socket.readyState === WebSocket.OPEN) socket.send(pcm);
    else if (socket.readyState === WebSocket.CONNECTING) early.push(pcm);
  };
  source.connect(processor);
  // A ScriptProcessor only runs while connected to the output; it writes silence there.
  processor.connect(context.destination);

  socket.onopen = () => { for (const pcm of early.splice(0)) socket.send(pcm); };
  socket.onmessage = (message) => {
    let event: { type?: string; item?: string; previous?: string | null; text?: string; message?: string };
    try { event = JSON.parse(String(message.data)); } catch { return; }
    if (event.type === "committed" && event.item) {
      transcript.committed(event.item, event.previous ?? null);
      const spoken = transcript.toString();
      if (spoken) onText(spoken);
    }
    else if (event.type === "delta" && event.item) { transcript.delta(event.item, event.text ?? ""); onText(transcript.toString()); }
    else if (event.type === "done" && event.item) { transcript.done(event.item, event.text ?? ""); onText(transcript.toString()); }
    else if (event.type === "limit") onLimit();
    else if (event.type === "error") { failed = true; onError(event.message ?? "Live dictation failed."); }
  };
  socket.onclose = (event) => {
    if (!failed && !stopped && event.code !== 1000) onError(event.code === 1006 ? "Couldn't start live dictation. Check Settings › Beta." : `Live dictation stopped (${event.code}).`);
    end();
  };
  const limit = setTimeout(() => { onLimit(); stop(); }, MAX_LIVE_SECONDS * 1000);
  if (context.state === "suspended") await context.resume().catch(() => {});

  return { stop, cancel: () => { stopped = true; releaseAudio(); socket.close(); end(); } };
}
