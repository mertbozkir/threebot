import { requestNotificationPermission, sendMessage, toast, uploadAttachment, type Attachment } from "../store";
import { T3RpcError, uuid } from "./t3";
import { parseReply, withReply } from "./reply";
import type { Bot } from "./types";

type DraftAttachment = { state: "uploading" | "ready"; attachment: Attachment };
type UnsentMessage = { id: string; text: string; attachments: Attachment[]; fresh?: boolean };
/** `fresh`: the next message starts a fresh session in this thread. */
type DraftSnapshot = { text: string; attachments: DraftAttachment[]; sending: boolean; failed: UnsentMessage[]; replyTo: string | null; fresh: boolean };

function readText(key: string) {
  try { return localStorage.getItem(key) ?? ""; }
  catch { return ""; }
}

// Only completed upload metadata survives reload. File bytes and blob URLs are
// owned by this document and must never be represented as durable attachments.
function readAttachments(value: unknown): Attachment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item: unknown) => {
    if (!item || typeof item !== "object" || !("type" in item) || !("id" in item) || !("name" in item) || !("mimeType" in item) || !("sizeBytes" in item)) return [];
    if ((item.type !== "image" && item.type !== "file") || typeof item.id !== "string" || typeof item.name !== "string" || typeof item.mimeType !== "string" || typeof item.sizeBytes !== "number" || !Number.isFinite(item.sizeBytes) || item.sizeBytes < 0) return [];
    return [{ type: item.type, id: item.id, name: item.name, mimeType: item.mimeType, sizeBytes: item.sizeBytes }];
  });
}

function unsentMessage(value: unknown): UnsentMessage | null {
  if (!value || typeof value !== "object" || !("id" in value) || !("text" in value) || !("attachments" in value) || typeof value.id !== "string" || typeof value.text !== "string") return null;
  return { id: value.id, text: value.text, attachments: readAttachments(value.attachments), ...("fresh" in value && value.fresh === true ? { fresh: true } : {}) };
}

function readMetadata(key: string): Pick<DraftSnapshot, "attachments" | "failed" | "replyTo" | "fresh"> & { retryMessageId: string | null } {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
    if (value && typeof value === "object" && "attachments" in value && "failed" in value) {
      const attachments = readAttachments(value.attachments).map((attachment): DraftAttachment => ({ state: "ready", attachment }));
      const failed = Array.isArray(value.failed) ? value.failed.flatMap((item: unknown) => { const parsed = unsentMessage(item); return parsed ? [parsed] : []; }) : [];
      const inFlight = "inFlight" in value ? unsentMessage(value.inFlight) : null;
      // A reload cannot establish delivery. Retain the payload without resending.
      if (inFlight && !failed.some((item) => item.id === inFlight.id)) failed.push(inFlight);
      const retryMessageId = "retryMessageId" in value && typeof value.retryMessageId === "string" ? value.retryMessageId : null;
      const replyTo = "replyTo" in value && typeof value.replyTo === "string" ? value.replyTo : null;
      return { attachments, failed, retryMessageId, replyTo, fresh: "fresh" in value && value.fresh === true };
    }
  } catch { /* Storage may be unavailable or contain an older/invalid value. */ }
  return { attachments: [], failed: [], retryMessageId: null, replyTo: null, fresh: false };
}

function metadata({ previewUrl: _preview, ...attachment }: Attachment) { return attachment; }
function release(attachment: Attachment) {
  if (attachment.previewUrl?.startsWith("blob:")) URL.revokeObjectURL(attachment.previewUrl);
}

function previouslyRejected(cause: unknown): boolean {
  if (Array.isArray(cause)) return cause.some(previouslyRejected);
  if (!cause || typeof cause !== "object" || !("_tag" in cause)) return false;
  return cause._tag === "OrchestratorCommandPreviouslyRejectedError" || (cause._tag === "Fail" && "error" in cause && previouslyRejected(cause.error));
}

/** One owner per conversation, independent of whichever Composer is mounted. */
class ChatDraft {
  private snapshot: DraftSnapshot;
  private revision = 0;
  private listeners = new Set<() => void>();
  private inFlight: UnsentMessage | null = null;
  private retryMessageId: string | null;

  constructor(private slug: string, private threadId: string | null, private textKey: string, private metadataKey: string) {
    const { retryMessageId, ...saved } = readMetadata(metadataKey);
    this.retryMessageId = retryMessageId;
    this.snapshot = { text: readText(textKey), ...saved, sending: false };
  }

  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private update(patch: Partial<DraftSnapshot>, edited = false) {
    if (edited) this.revision++;
    this.snapshot = { ...this.snapshot, ...patch };
    try {
      // Keep the original text keys, including their exact whitespace.
      localStorage.setItem(this.textKey, this.snapshot.text);
      localStorage.setItem(this.metadataKey, JSON.stringify({
        attachments: this.snapshot.attachments.filter((item) => item.state === "ready").map((item) => metadata(item.attachment)),
        failed: this.snapshot.failed.map((item) => ({ ...item, attachments: item.attachments.map(metadata) })),
        inFlight: this.inFlight ? { ...this.inFlight, attachments: this.inFlight.attachments.map(metadata) } : null,
        retryMessageId: this.retryMessageId,
        replyTo: this.snapshot.replyTo,
        fresh: this.snapshot.fresh,
      }));
    } catch { /* Quota/private-mode failures must not destroy the in-memory draft. */ }
    this.listeners.forEach((listener) => listener());
  }

  setText = (text: string) => { this.retryMessageId = null; this.update({ text }, true); };

  setReply = (replyTo: string | null) => { this.retryMessageId = null; this.update({ replyTo }, true); };

  setFresh = (fresh: boolean) => { this.retryMessageId = null; this.update({ fresh }, true); };

  removeAttachment = (id: string) => {
    const item = this.snapshot.attachments.find((item) => item.attachment.id === id);
    if (!item) return;
    this.retryMessageId = null;
    this.update({ attachments: this.snapshot.attachments.filter((item) => item.attachment.id !== id) }, true);
    release(item.attachment);
  };

  addFiles = async (files: FileList | File[]) => {
    this.retryMessageId = null;
    const selected = Array.from(files).map((file) => ({ file, attachment: {
      type: file.type.startsWith("image/") ? "image" : "file",
      id: uuid(), name: file.name, mimeType: file.type, sizeBytes: file.size,
      previewUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined,
    } satisfies Attachment }));
    // Reserve the entire selection before awaiting. All callbacks retain this
    // owner, even if the user navigates or removes a queued file in the meantime.
    this.update({ attachments: [...this.snapshot.attachments, ...selected.map(({ attachment }): DraftAttachment => ({ state: "uploading", attachment }))] }, true);
    for (const { file, attachment } of selected) {
      if (!this.snapshot.attachments.some((item) => item.attachment.id === attachment.id)) continue;
      try {
        const uploaded = await uploadAttachment(file);
        if (!this.snapshot.attachments.some((item) => item.attachment.id === attachment.id)) {
          release(uploaded);
          continue;
        }
        this.update({ attachments: this.snapshot.attachments.map((item) => item.attachment.id === attachment.id ? { state: "ready", attachment: uploaded } : item) });
        release(attachment);
      } catch {
        const present = this.snapshot.attachments.some((item) => item.attachment.id === attachment.id);
        this.removeAttachment(attachment.id);
        if (present) toast(`Couldn't attach ${file.name}`);
      }
    }
  };

  submit = () => {
    const { text, attachments, sending, replyTo, fresh } = this.snapshot;
    if (sending || (!text.trim() && !attachments.length) || attachments.some((item) => item.state === "uploading")) return;
    const message: UnsentMessage = { id: this.retryMessageId ?? uuid(), text: withReply(text, replyTo), attachments: attachments.map((item) => item.attachment), ...(fresh ? { fresh: true } : {}) };
    this.retryMessageId = null;
    this.inFlight = message;
    // Sending is what makes "tell me when this finishes" a reasonable question.
    requestNotificationPermission();
    // Claim synchronously, before React renders or another click/Enter arrives.
    this.update({ text: "", attachments: [], sending: true, replyTo: null, fresh: false }, true);
    void this.deliver(message, this.revision);
  };

  retry = (id: string) => {
    if (this.snapshot.sending) return;
    const message = this.snapshot.failed.find((item) => item.id === id);
    if (!message) return;
    this.inFlight = message;
    this.update({ sending: true, failed: this.snapshot.failed.filter((item) => item.id !== id) });
    void this.deliver(message, null);
  };

  restore = (id: string) => {
    if (this.snapshot.text || this.snapshot.attachments.length || this.snapshot.sending) return;
    const message = this.snapshot.failed.find((item) => item.id === id);
    if (!message) return;
    this.retryMessageId = message.id;
    const { quote, text } = parseReply(message.text);
    this.update({ text, replyTo: quote, fresh: message.fresh === true, attachments: message.attachments.map((attachment) => ({ state: "ready", attachment })), failed: this.snapshot.failed.filter((item) => item.id !== id) }, true);
  };

  discard = (id: string) => {
    const message = this.snapshot.failed.find((item) => item.id === id);
    if (!message) return;
    this.update({ failed: this.snapshot.failed.filter((item) => item.id !== id) });
    message.attachments.forEach(release);
  };

  private async deliver(message: UnsentMessage, clearedRevision: number | null, retryRejected = true): Promise<void> {
    try {
      await sendMessage(this.slug, message.text.trim(), message.attachments, this.threadId, message.id, message.fresh === true);
      this.inFlight = null;
      this.update({ sending: false });
      message.attachments.forEach(release);
    } catch (error) {
      // An accepted receipt is replayed with the same command ID. Only this
      // explicit server rejection proves a new command cannot duplicate it.
      if (retryRejected && error instanceof T3RpcError && previouslyRejected(error.cause)) {
        const replacement = { ...message, id: uuid() };
        this.inFlight = replacement;
        this.update({});
        return this.deliver(replacement, clearedRevision, false);
      }
      this.inFlight = null;
      if (clearedRevision === this.revision) {
        this.retryMessageId = message.id;
        const { quote, text } = parseReply(message.text);
        this.update({ text, replyTo: quote, fresh: message.fresh === true, attachments: message.attachments.map((attachment) => ({ state: "ready", attachment })), sending: false }, true);
      } else {
        // A failure cannot write over newer edits. Keep the exact original as a
        // separate recoverable message with its own retry/edit/discard actions.
        this.update({ failed: [...this.snapshot.failed, message], sending: false });
      }
      toast(error instanceof Error ? error.message : "Not delivered");
    }
  }
}

const drafts = new Map<string, ChatDraft>();
export function chatDraft(bot: Pick<Bot, "slug" | "mainThreadId">, threadId: string | null) {
  const key = JSON.stringify([bot.slug, threadId]);
  let draft = drafts.get(key);
  if (!draft) {
    const textKey = `bot.draft.${threadId === bot.mainThreadId ? bot.slug : threadId}`;
    draft = new ChatDraft(bot.slug, threadId, textKey, `bot.draft.state.${key}`);
    drafts.set(key, draft);
  }
  return draft;
}
