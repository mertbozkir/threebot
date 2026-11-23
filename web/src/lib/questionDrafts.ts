import { useApp } from "../store";
import { findRequest, type Question, type QuestionAnswers } from "./runtimeRequests";
import type { RuntimeRequest, TurnItem } from "./types";

type Identity = { threadId: string; requestId: string; itemId: string };
type ResponseState = "idle" | "submitting" | "submitted" | "error";
type Snapshot = {
  step: number;
  answers: QuestionAnswers;
  custom: string;
  showCustom: boolean;
  response: ResponseState;
};

function editor(question: Question | undefined) {
  return {
    custom: question?.allowCustomAnswer ? question.initialAnswer ?? "" : "",
    showCustom: question?.allowCustomAnswer === true && question.initialAnswer !== undefined,
  };
}

/** Owns unfinished answers and their one submission while the card is unmounted.
 * Question text stays in memory only; secret editors never use this store. */
class QuestionDraft {
  private snapshot: Snapshot;
  private active = true;
  private listeners = new Set<() => void>();
  private editors = new Map<string, Pick<Snapshot, "custom" | "showCustom">>();

  constructor(readonly identity: Identity, questions: Question[]) {
    this.snapshot = { step: 0, answers: {}, ...editor(questions[0]), response: "idle" };
  }

  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private update(patch: Partial<Snapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((listener) => listener());
  }

  get editable() {
    return this.active && this.snapshot.response !== "submitting" && this.snapshot.response !== "submitted";
  }

  setCustom = ({ custom, question }: { custom: string; question: Question }) => {
    if (!this.editable) return;
    const answers = { ...this.snapshot.answers };
    // T3 treats a custom answer as an alternative to offered selections,
    // including for multi-select questions. Keep its original string payload.
    if (custom.trim().length || question.initialAnswer !== undefined) delete answers[question.id];
    this.update({ custom, answers });
  };
  showCustom = () => { if (this.editable) this.update({ showCustom: true }); };
  setAnswers = (answers: QuestionAnswers) => { if (this.editable) this.update({ answers }); };
  selectAnswers = (answers: QuestionAnswers) => {
    if (this.editable) this.update({ answers, custom: "", showCustom: false });
  };

  advance = ({ fromStep, answers, question, nextQuestion }: { fromStep: number; answers: QuestionAnswers; question: Question; nextQuestion: Question }) => {
    if (!this.editable || this.snapshot.step !== fromStep) return;
    this.editors.set(question.id, { custom: this.snapshot.custom, showCustom: this.snapshot.showCustom });
    this.update({ step: fromStep + 1, answers, ...(this.editors.get(nextQuestion.id) ?? editor(nextQuestion)) });
  };

  back = ({ question, previousQuestion }: { question: Question; previousQuestion: Question }) => {
    if (!this.editable || this.snapshot.step === 0) return;
    this.editors.set(question.id, { custom: this.snapshot.custom, showCustom: this.snapshot.showCustom });
    this.update({ step: this.snapshot.step - 1, ...(this.editors.get(previousQuestion.id) ?? editor(previousQuestion)) });
  };

  send = async (action: () => Promise<void>, discard = false): Promise<boolean> => {
    if (!this.editable) return false;
    // Claim before invoking the transport, so another mounted card cannot send.
    this.update({ response: "submitting" });
    try {
      await action();
      if (this.active) {
        if (discard) this.editors.clear();
        this.update({ response: "submitted", ...(discard ? { answers: {}, custom: "", showCustom: false } : {}) });
      }
      return true;
    } catch {
      if (this.active) this.update({ response: "error" });
      return false;
    }
  };

  finish() {
    if (!this.active) return;
    this.active = false;
    this.editors.clear();
    this.update({ step: 0, answers: {}, custom: "", showCustom: false, response: "idle" });
  }
}

const drafts = new Map<string, QuestionDraft>();
const keyFor = ({ threadId, requestId }: Identity) => JSON.stringify([threadId, requestId]);
let stopWatching: (() => void) | null = null;

export function finishQuestionDraft(draft: QuestionDraft) {
  draft.finish();
  const key = keyFor(draft.identity);
  if (drafts.get(key) === draft) drafts.delete(key);
  if (!drafts.size) { stopWatching?.(); stopWatching = null; }
}

function terminal(item: TurnItem, request: RuntimeRequest | undefined) {
  return item.status === "completed" || item.status === "cancelled" || item.status === "expired" ||
    request?.status === "resolved" || request?.status === "cancelled" || request?.status === "expired" ||
    request?.responseCapability?.type === "not_resumable";
}

export function questionDraft(identity: Identity, questions: Question[]) {
  const key = keyFor(identity);
  let draft = drafts.get(key);
  if (!draft) {
    draft = new QuestionDraft(identity, questions);
    drafts.set(key, draft);
  }
  // Authoritative updates can arrive while another Bot is open. Clear those
  // completed drafts without waiting for their question card to mount again.
  stopWatching ??= useApp.subscribe(({ threadData }) => {
    for (const owner of drafts.values()) {
      const data = threadData[owner.identity.threadId];
      const item = data?.items[owner.identity.itemId];
      if (!item) continue;
      const request = findRequest(data.requests, owner.identity.requestId);
      if (terminal(item, request)) finishQuestionDraft(owner);
    }
  });
  return draft;
}
