import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ChangeEvent } from "react";
import { flushSync } from "react-dom";
import clsx from "clsx";
import { Check, Clock, ExternalLink, FileText, KeyRound, Lock, Maximize2, Monitor, Pencil, Send, ShieldAlert, Square, Sparkles, X } from "lucide-react";
import { Avatar } from "./Avatar";
import { SubagentRow } from "./ThreadFamily";
import { sameTaskBot } from "../lib/threadFamily";
import { Pill, Spinner } from "./ui";
import { answerQuestion, answerSecret, assetUrl, dismissQuestion, openDialog, respondRequest, selectThread, useApp } from "../store";
import { timeAgo } from "../lib/projects";
import { assetKey, assetSource } from "../lib/assetCopies";
import type { Entry } from "../lib/transcript";
import type { Bot } from "../lib/types";
import { approvalDecision, approvalOptions, customQuestionAnswer, questionAnswers, requestQuestions, requestStatus, secretLink, secretStatus, type ApprovalDecision, type QuestionAnswers } from "../lib/runtimeRequests";
import { finishQuestionDraft, questionDraft } from "../lib/questionDrafts";
import "./RequestCards.css";
import "./AutomatedCard.css";
import "./PageCard.css";

export function DateSep({ label }: { label: string }) {
  return <div className="py-3 text-center text-[12px] text-muted">{label}</div>;
}

const EVENT_ICON = {
  routine: <Clock size={13} />,
  memory: <Sparkles size={13} />,
  rename: <Pencil size={12} />,
  send: <Send size={12} />,
  task: <Sparkles size={13} />,
  stop: <Square size={11} />,
  file: <FileText size={13} />,
  vault: <KeyRound size={12} />,
};

export function EventLine({ entry }: { entry: Extract<Entry, { kind: "event" }> }) {
  return (
    <div className="fade-up flex items-center justify-center gap-1.5 py-2 text-[13px] text-muted">
      <span>{entry.text}</span>
      {entry.bot ? <Avatar shape={entry.bot.shape} color={entry.bot.color} picture={entry.bot.avatarImage} size={14} /> : entry.icon && entry.icon !== "send" && <span className="opacity-80">{EVENT_ICON[entry.icon]}</span>}
      {entry.strong && <span className="text-fg">{entry.strong}</span>}
    </div>
  );
}

/** A routine's report, derived from T3's run; it is not a model turn and never wakes the Bot. */
export function RoutineReportLine({ entry, bot }: { entry: Extract<Entry, { kind: "routine-report" }>; bot: Bot }) {
  return (
    <div className="fade-up flex flex-wrap items-center justify-start gap-x-2 gap-y-1 py-2 text-left text-[13px] text-muted sm:justify-center sm:text-center">
      <Sparkles size={13} className="shrink-0 opacity-80" aria-hidden="true" />
      <span className="break-words text-fg">{entry.title}</span>
      <span className={clsx("line-clamp-2 min-w-0 flex-1 sm:line-clamp-1 sm:flex-none", entry.failed ? "text-danger" : "text-fg")}>{entry.summary}</span>
      <time dateTime={entry.at} className="shrink-0 text-[12px]">{timeAgo(entry.at)}</time>
      <button type="button" aria-label={`Open the ${entry.title} conversation`} className="inline-flex min-h-6 min-w-6 shrink-0 items-center px-1 underline underline-offset-2 hover:text-fg max-sm:min-h-11" onClick={() => selectThread(bot, entry.threadId)}>Open</button>
    </div>
  );
}

export function AutomatedCard({ entry }: { entry: Extract<Entry, { kind: "automated" }> }) {
  const { message, fromBot } = entry;
  return <div className="automated-card fade-up">
    <div className="automated-head">
      {fromBot ? <Avatar shape={fromBot.shape} color={fromBot.color} picture={fromBot.avatarImage} size={20} /> : <Clock size={15} aria-hidden="true" />}
      <span className="automated-title">{message.summary}</span>
      <span className="automated-from">From {message.from}</span>
    </div>
    {message.issues.length > 0 && <ul className="automated-issues">
      {message.issues.map((issue) => <li key={issue.id} data-level={issue.level} title={issue.detail}>
        <span className="automated-dot" aria-hidden="true" />
        <span className="automated-issue">{issue.title}</span>
        {issue.state && <span className="automated-state">{issue.state}</span>}
        <span className="sr-only">{issue.level}</span>
      </li>)}
    </ul>}
    <details className="automated-details">
      <summary>Instructions</summary>
      <div className="automated-body">{message.text}</div>
    </details>
  </div>;
}

function CardShell({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={clsx("fade-up my-1.5 w-full max-w-[560px] rounded-[18px] bg-card p-1.5", className)}>{children}</div>;
}

function CardHeader({ icon, title, status }: { icon: React.ReactNode; title: string; status?: React.ReactNode }) {
  return (
    <div className="flex h-8 items-center gap-2 px-2.5 text-[13px]">
      <span className="text-muted">{icon}</span>
      <span className="font-medium">{title}</span>
      <span className="ml-auto text-[12.5px] text-muted">{status}</span>
    </div>
  );
}

// A fulfilled RPC acknowledges submission. Only server snapshots resolve cards.
// The ref also guards multiple events before React commits disabled controls.
type ResponseState = "idle" | "submitting" | "submitted" | "error";
function useRequestResponse(pending: boolean) {
  const [state, setState] = useState<ResponseState>("idle");
  const locked = useRef(false);
  const canRespond = useRef(pending);
  canRespond.current = pending;
  const send = async (action: () => Promise<void>, onSubmitted?: () => void) => {
    if (!canRespond.current || locked.current) return;
    locked.current = true;
    setState("submitting");
    try {
      await action();
      onSubmitted?.();
      setState("submitted");
    } catch {
      // Never render raw transport errors: secret providers may echo input.
      locked.current = false;
      setState("error");
    }
  };
  return { state, send, disabled: !pending || state === "submitting" || state === "submitted" };
}

function ResponseFeedback({ pending, state }: { pending: boolean; state: ResponseState }) {
  if (!pending || state === "idle") return null;
  return <div role={state === "error" ? "alert" : "status"} className={clsx("px-2.5 pt-2 pb-1 text-[12.5px]", state === "error" ? "text-danger" : "text-muted")}>
    {state === "error" ? "Couldn't send your response. Try again." : state === "submitting" ? "Sending response…" : "Response sent. Waiting for confirmation…"}
  </div>;
}

// ---------- approval ----------
type ApprovalProps = { entry: Extract<Entry, { kind: "approval" }>; threadId: string };
export function ApprovalCard(props: ApprovalProps) {
  return <ApprovalRequestCard key={`${props.threadId}:${props.entry.item.id}:${props.entry.item.requestId}`} {...props} />;
}

function ApprovalRequestCard({ entry, threadId }: ApprovalProps) {
  const { item, request } = entry;
  const status = requestStatus(item, request);
  const pending = status === "pending";
  const response = useRequestResponse(pending);
  const decided = approvalDecision(item, request);
  const options = approvalOptions(item.options);
  const kindLabel: Record<string, string> = { command: "Run a command", "file-change": "Change files", "file-read": "Read files", permission: "Use a tool", "mcp-elicitation": "Use a connected app" };
  const statusLabel = pending ? "Waiting for you" : status === "expired" ? "Expired" : status === "cancelled" || decided === "cancel" ? "Cancelled" : status === "unavailable" ? "Unavailable" : decided === "decline" ? "Denied" : decided ? "Allowed" : "Resolved";
  const act = (decision: ApprovalDecision) => response.send(() => respondRequest(threadId, request?.id ?? item.requestId, decision));
  return (
    <CardShell>
      <CardHeader icon={<ShieldAlert size={14} />} title="Review an action" status={statusLabel} />
      <div className="rounded-[13px] bg-card-inner px-3.5 py-3">
        <div className="text-[14px]">{item.title || kindLabel[item.requestKind] || "Approve this action?"}</div>
        {item.reason && <div className="mt-1 text-[13px] text-muted">{item.reason}</div>}
        {item.prompt && <pre className="mt-2.5 max-h-48 overflow-auto rounded-lg bg-active px-3 py-2 font-mono text-[12px] whitespace-pre-wrap" style={item.requestKind === "command" && item.nativeItemRef?.driver === "antigravity" ? { overflowWrap: "anywhere" } : undefined}>{item.prompt}</pre>}
      </div>
      {pending && (
        <div className="flex flex-wrap gap-2 px-1.5 pt-2 pb-1">
          {options.map((option, index) => <div key={option.decision} className={clsx("min-w-0", option.decision === "decline" && "ml-auto")}>
            <Pill onClick={() => act(option.decision)} disabled={response.disabled} variant={index === 0 ? "primary" : option.decision === "decline" || option.decision === "cancel" ? "ghost" : "soft"}>
              {option.label}
            </Pill>
            {option.warning && <div className="mt-1 max-w-48 text-[12px] text-muted">{option.warning}</div>}
          </div>)}
        </div>
      )}
      <ResponseFeedback pending={pending} state={response.state} />
    </CardShell>
  );
}

// ---------- question ----------
type QuestionProps = { entry: Extract<Entry, { kind: "question" }>; threadId: string };
export function QuestionCard(props: QuestionProps) {
  return <QuestionRequestCard key={`${props.threadId}:${props.entry.item.id}:${props.entry.item.requestId}`} {...props} />;
}

function QuestionRequestCard({ entry, threadId }: QuestionProps) {
  const { item, request } = entry;
  const questions = requestQuestions(item.questions);
  const draft = useMemo(() => questionDraft({ threadId, itemId: item.id, requestId: typeof item.requestId === "string" ? item.requestId : item.id }, questions), [threadId, item.id, item.requestId]);
  const { step, answers, custom, showCustom, response: responseState } = useSyncExternalStore(draft.subscribe, draft.getSnapshot, draft.getSnapshot);
  const [reviewStep, setReviewStep] = useState(0);
  const editor = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  // Dismiss resolves the runtime request, while cancelling the question item.
  const status = item.status === "cancelled" && request?.status === "resolved" ? "cancelled" : requestStatus(item, request);
  const pending = status === "pending";
  const resolved = status === "resolved";
  const response = { state: responseState, disabled: !pending || !draft.editable, send: draft.send };
  useEffect(() => { if (!pending) finishQuestionDraft(draft); }, [pending, draft]);
  const answered = questionAnswers(item, request);
  const activeStep = Math.min(pending ? step : resolved ? reviewStep : 0, questions.length - 1);
  const q = questions[activeStep];
  const bot = useApp((s) => Object.values(s.bots).find((b) => b.mainThreadId === threadId));
  if (!q) return null;
  const takeOver = pending && bot && /take over|sign in|log ?in|2fa|captcha|verify/i.test(`${q.header ?? ""} ${q.question}`);
  const canEdit = () => pending && !response.disabled && draft.editable && step === draft.getSnapshot().step;
  const submit = (next: QuestionAnswers) => {
    if (!canEdit()) return;
    if (step < questions.length - 1) {
      draft.advance({ fromStep: step, answers: next, question: q, nextQuestion: questions[step + 1] });
      return;
    }
    draft.setAnswers(next);
    void response.send(() => answerQuestion(threadId, request?.id ?? item.requestId, next));
  };
  const choose = (value: string) => {
    if (!canEdit()) return;
    const current = draft.getSnapshot().answers;
    const answer = current[q.id];
    const selected = Array.isArray(answer) ? answer : [];
    const nextValue = q.multiSelect
      ? selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]
      : value;
    const next = { ...current, [q.id]: nextValue };
    draft.selectAnswers(next);
    if (!q.multiSelect) submit(next);
  };
  const selection = pending ? answers[q.id] : resolved ? answered[q.id] : undefined;
  const chosen = (value: string) => Array.isArray(selection) ? selection.includes(value) : selection === value;
  const values = resolved ? Array.isArray(selection) ? selection : typeof selection === "string" ? [selection] : [] : [];
  const customValues = values.filter((value) => !q.options.some((option) => (option.value ?? option.label) === value));
  const customAnswer = showCustom ? customQuestionAnswer(q, custom) : null;
  const currentAnswer = customAnswer ?? (Array.isArray(selection) ? selection.length ? selection : null : typeof selection === "string" && selection.length ? selection : null);
  const submitCurrent = () => { if (currentAnswer !== null) submit({ ...draft.getSnapshot().answers, [q.id]: currentAnswer }); };
  const statusLabel = resolved ? "Answered" : status === "expired" ? "Expired" : status === "cancelled" ? "Cancelled" : status === "unavailable" ? "Unavailable" : "Waiting for you";
  const customField = {
    ref: (element: HTMLInputElement | HTMLTextAreaElement | null) => { editor.current = element; },
    disabled: response.disabled, value: custom,
    onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => draft.setCustom({ custom: event.target.value, question: q }),
    placeholder: "Your own answer", "aria-label": "Your own answer", className: "question-custom-editor",
  };
  const revealCustom = () => {
    if (!canEdit()) return;
    // Keep reveal and focus in this explicit tap, so mobile keyboards may open.
    flushSync(() => draft.showCustom());
    editor.current?.focus({ preventScroll: true });
  };
  const multiple = questions.length > 1;
  const showFooter = (multiple && (pending || resolved)) || (pending && q.multiSelect === true);
  const last = activeStep === questions.length - 1;
  const row = q.options.length <= 3 && q.options.every((option) => option.label.length <= 24);
  const notes = q.options.map((option) => option.description).filter(Boolean).join(" · ");

  return (
    <section className={clsx("question-card fade-up", resolved && "question-card-answered")} aria-label={resolved ? "Answered question" : "Question"} data-question-status={status}>
      <div className="question-card-header">
        <h3 className="question-card-title">{q.question}</h3>
        {pending && request?.responseCapability?.type === "message" && <button type="button" disabled={response.disabled} onClick={() => response.send(() => dismissQuestion(threadId, request.id), true)} className="question-dismiss" aria-label="Dismiss"><X size={18} /></button>}
      </div>
      {resolved && <span className="sr-only">Answered</span>}
      {!pending && !resolved && <p className="question-terminal-status">{statusLabel}</p>}
      {pending && q.multiSelect && <p className="question-hint">Choose all that apply</p>}
      {takeOver && <div className="pb-2"><Pill onClick={() => openDialog({ kind: "computer", slug: bot.slug })} className="w-full"><Monitor size={14} /> Take over</Pill></div>}
      {resolved && <div className="question-answer-summary"><span>Your answer</span><p>{values.map(value => q.options.find(option => (option.value ?? option.label) === value)?.label ?? value).join(", ")}</p></div>}
      {/* Short choices are small pills in a row, with what they mean in one quiet line underneath. */}
      <div className="question-options" data-layout={row ? "row" : "stack"}>
        {q.options.map((option, index) => {
          const value = option.value ?? option.label;
          if (resolved && !chosen(value)) return null;
          return <button type="button" key={value} disabled={response.disabled} aria-pressed={chosen(value)} onClick={() => choose(value)} className="question-option">
            <span className="question-option-badge">{String.fromCharCode(65 + index)}</span>
            <span className="question-option-copy"><span className="question-option-label">{option.label}</span>{!row && option.description && !resolved && <span className="question-option-description">{option.description}</span>}</span>
          </button>;
        })}
        {customValues.map((value, index) => <p key={index} className="question-custom-answer">{value}</p>)}
        {pending && q.allowCustomAnswer && (showCustom
          ? <form onSubmit={(event) => { event.preventDefault(); submitCurrent(); }} className="question-custom-form">
              {q.initialAnswer !== undefined ? <textarea {...customField} rows={4} /> : <input {...customField} />}
              {!showFooter && <Pill type="submit" disabled={currentAnswer === null || response.disabled}>Send</Pill>}
            </form>
          : <button type="button" disabled={response.disabled} onClick={revealCustom} className="question-custom-trigger">Something else</button>)}
      </div>
      {row && pending && notes && <p className="question-option-notes">{notes}</p>}
      {showFooter && <div className="question-card-footer">
        {multiple && <div role="status" className="question-progress" aria-label={`Question ${activeStep + 1} of ${questions.length}`}><span className="question-step-label">Step {activeStep + 1} of {questions.length}</span>{questions.map((question, index) => <span key={question.id} aria-hidden="true" className="question-progress-dot" data-active={index === activeStep} />)}</div>}
        <div className="question-navigation-actions">
          {pending && activeStep > 0 && <Pill variant="soft" className="question-navigation" disabled={response.disabled} onClick={() => draft.back({ question: q, previousQuestion: questions[step - 1] })}>Back</Pill>}
          {pending && <Pill className="question-navigation" disabled={response.disabled || currentAnswer === null} onClick={submitCurrent}>{last ? "Done" : "Next"}</Pill>}
          {resolved && <>
            <Pill variant="soft" className="question-navigation" disabled={activeStep === 0} onClick={() => setReviewStep(activeStep - 1)}>Back</Pill>
            <Pill className="question-navigation" disabled={last} onClick={() => setReviewStep(activeStep + 1)}>Next</Pill>
          </>}
        </div>
      </div>}
      <ResponseFeedback pending={pending} state={response.state} />
    </section>
  );
}

// ---------- secret ----------
type SecretProps = { entry: Extract<Entry, { kind: "secret" }>; threadId: string };
export function SecretCard(props: SecretProps) {
  return <SecretRequestCard key={`${props.threadId}:${props.entry.item.id}`} {...props} />;
}

function SecretRequestCard({ entry, threadId }: SecretProps) {
  const { item } = entry;
  const privateInput = useRef<HTMLInputElement>(null);
  // Keep the ref stable while typing, but clear detached nodes before effects
  // run when another client resolves the request or the card unmounts.
  const attachPrivateInput = useCallback((element: HTMLInputElement | null) => {
    if (privateInput.current && privateInput.current !== element) privateInput.current.value = "";
    privateInput.current = element;
  }, []);
  const [hasValue, setHasValue] = useState(false);
  const status = secretStatus(item);
  const pending = status === "pending";
  const response = useRequestResponse(pending);
  // Clear private input as soon as the authoritative card closes, including
  // cancellation by another client while a save is still in flight.
  const clearPrivateInput = () => {
    if (privateInput.current) privateInput.current.value = "";
    setHasValue(false);
  };
  useEffect(() => { if (!pending) clearPrivateInput(); }, [pending]);
  const save = (secret: string | null) => response.send(() => answerSecret(threadId, item.id, secret), clearPrivateInput);
  const link = pending ? secretLink(item) : null;
  const statusLabel = status === "saved" ? "Saved securely" : status === "declined" ? "Declined" : status === "cancelled" ? "Cancelled" : status === "expired" ? "Expired" : pending ? "Waiting for you" : "Unavailable";
  return (
    <CardShell>
      <CardHeader icon={<KeyRound size={14} />} title={item.label || "Secret"} status={statusLabel} />
      <div className="rounded-[13px] bg-card-inner px-3 py-2.5">
        {item.reason && <div className="mb-2 text-[13px] text-muted">{item.reason}</div>}
        {link && (
          <div className="mb-2.5 flex min-w-0 flex-col items-start gap-1">
            <a href={link.href} target="_blank" rel="noopener noreferrer" className="inline-flex h-8 max-w-full items-center gap-1.5 rounded-full bg-pill-soft px-3.5 text-[13px] font-medium text-fg hover:bg-active">
              <span className="truncate">Open {link.host}</span><ExternalLink size={13} className="shrink-0" />
            </a>
            {/* A link found in the reason is already shown there. */}
            {typeof item.url === "string" && <div className="font-mono text-[11.5px] break-all text-faint">{link.href}</div>}
          </div>
        )}
        {pending ? (
          <form onSubmit={(e) => { e.preventDefault(); const secret = privateInput.current?.value; if (secret) void save(secret); }} className="flex items-center gap-2">
            <Lock size={14} className="text-muted" />
            <input ref={attachPrivateInput} type="password" autoComplete="off" disabled={response.disabled} onChange={(e) => setHasValue(e.target.value.length > 0)} placeholder={item.placeholder || "Paste it here"} aria-label={item.label || "Secret"} className="min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-faint" />
            <Pill type="submit" disabled={!hasValue || response.disabled}>Save securely</Pill>
          </form>
        ) : (
          <div className="flex items-center gap-2 text-[13px] text-muted">
            {status === "saved" ? <><Check size={14} /> Saved securely and kept private</> : "No secret was shared"}
          </div>
        )}
      </div>
      <div className="px-2.5 pt-1.5 pb-0.5 text-[11.5px] text-faint">
        Stored securely, never shown in the conversation.
        {pending && <button disabled={response.disabled} onClick={() => save(null)} className="ml-2 underline hover:text-fg disabled:opacity-40">Decline</button>}
      </div>
      <ResponseFeedback pending={pending} state={response.state} />
    </CardShell>
  );
}

// ---------- subagent ----------
export const SubagentCard = memo(function SubagentCard({ entry, bot, threadId }: { entry: Extract<Entry, { kind: "subagent" }>; bot: Bot; threadId: string }) {
  return <div className="subagent-card fade-up w-full max-w-[560px]"><SubagentRow bot={bot} parentThreadId={threadId} item={entry.item} /></div>;
}, (previous, next) => previous.entry.item === next.entry.item && previous.threadId === next.threadId && sameTaskBot(previous.bot, next.bot));

// ---------- file ----------
export function FileCard({ entry, bot, onOpen }: { entry: Extract<Entry, { kind: "file" }>; bot: Bot; onOpen: (path: string) => void }) {
  const name = entry.path.split("/").pop() ?? entry.path;
  return (
    <button onClick={() => onOpen(entry.path)} className="fade-up my-1 flex w-full max-w-[360px] items-center gap-3 rounded-2xl bg-card px-3 py-2.5 text-left hover:bg-active">
      <span className="grid size-9 place-items-center rounded-xl bg-card-inner text-muted">
        <FileText size={16} />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[14px]">{name}</span>
        <span className="block truncate text-[12px] text-muted">{bot.name}'s Library</span>
      </span>
    </button>
  );
}

// ---------- tool screenshot ----------
export function ToolImage({ entry, threadId, botName }: { entry: Extract<Entry, { kind: "image" }>; threadId: string; botName: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    assetSource(
      () => assetUrl({ _tag: "tool-output-image", threadId, itemId: entry.item.id, index: entry.index }),
      assetKey({ _tag: "tool-output-image", threadId, itemId: entry.item.id, index: entry.index }),
      { owner: `view:${threadId}` },
    ).then(setUrl).catch(() => setUrl(null));
  }, [threadId, entry.item.id, entry.index]);
  if (!url) return null;
  // Signed on every open: the URL behind the thumbnail may have expired, or be this device's copy.
  const openOriginal = () => {
    const tab = window.open("", "_blank");
    assetUrl({ _tag: "tool-output-image", threadId, itemId: entry.item.id, index: entry.index })
      .then((signed) => { if (!signed.startsWith("/t3/")) throw new Error("Invalid asset response"); if (tab) { tab.opener = null; tab.location.href = signed; } })
      .catch(() => tab?.close());
  };
  return (
    <CardShell className="max-w-[420px]">
      <CardHeader icon={<Monitor size={14} />} title="Computer" status="Done" />
      {/* The picture may be this device's copy; the original opens from a URL signed now. */}
      <button type="button" aria-label={`Open ${botName}'s screen`} className="block w-full cursor-pointer overflow-hidden rounded-[13px] bg-card-inner p-0" onClick={openOriginal} onAuxClick={(event) => { if (event.button === 1) openOriginal(); }}>
        <img src={url} alt={`${botName}'s screen`} className="w-full" />
      </button>
    </CardShell>
  );
}

export function ErrorLine({ message }: { message: string }) {
  return <div className="fade-up my-1 max-w-[560px] rounded-2xl border border-danger/30 bg-danger/10 px-3.5 py-2.5 text-[13px] text-danger">{message}</div>;
}

export function useBotsByThread() {
  const bots = useApp((s) => s.bots);
  const historical = useApp((s) => s.historicalBots);
  return useMemo(() => new Map([...Object.values(historical), ...Object.values(bots)].flatMap((b) => b.mainThreadId ? [[b.mainThreadId, b]] : [])), [bots, historical]);
}

// ---------- page (html_render) ----------
// Chat shows a cropped, noninteractive preview. Opening the card creates the interactive Page.
// Both views receive the app's theme, font, and chart palette inside the sandbox.

const PAGE_THEME = (dark: boolean) => {
  const t = dark
    ? { fg: "#f5f5f5", muted: "rgba(245,245,245,.62)", subtle: "rgba(245,245,245,.06)", line: "rgba(245,245,245,.09)", input: "rgba(245,245,245,.13)" }
    : { fg: "#1c1c1c", muted: "rgba(28,28,28,.62)", subtle: "rgba(28,28,28,.05)", line: "rgba(28,28,28,.09)", input: "rgba(28,28,28,.16)" };
  return `:root{color-scheme:${dark ? "dark" : "light"};--background:transparent;--foreground:${t.fg};--muted:${t.subtle};--muted-foreground:${t.muted};--card:${t.subtle};--card-foreground:${t.fg};--popover:${dark ? "#1f1f1f" : "#fff"};--popover-foreground:${t.fg};--secondary:${t.subtle};--secondary-foreground:${t.fg};--border:${t.line};--input:${t.input};--ring:#3f7ff0;--primary:${dark ? "#f5f5f5" : "#1c1c1c"};--primary-foreground:${dark ? "#121212" : "#fff"};--accent:#3f7ff0;--accent-foreground:#fff;--accent-surface:${t.subtle};--accent-surface-foreground:${t.fg};--destructive:#e5484d;--destructive-foreground:#e5484d;--destructive-surface:rgba(229,72,77,.12);--warning:#f0a83a;--warning-foreground:#f0a83a;--warning-surface:rgba(240,168,58,.12);--success:#4fb661;--success-foreground:#4fb661;--info:#3f7ff0;--info-foreground:#3f7ff0;--code-background:${t.subtle};--code-foreground:${t.fg};--chart-1:#3f7ff0;--chart-2:#5bb5a2;--chart-3:#f0a83a;--chart-4:#8a5cf5;--chart-5:#e2509c;--chart-6:#4fb661;--radius:0.75rem;--font-sans:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;--font-mono:ui-monospace,SFMono-Regular,Menlo,monospace}html,body{background:transparent!important}body{margin:0;font-family:var(--font-sans);-webkit-font-smoothing:antialiased}`;
};

const RESIZE_SCRIPT = `<script>(()=>{const post=()=>parent.postMessage({botPageHeight:Math.ceil(document.documentElement.scrollHeight)},"*");new ResizeObserver(post).observe(document.documentElement);addEventListener("load",post);post();})()</script>`;

function themedPage(html: string, dark: boolean) {
  const style = `<style id="t3-theme">${PAGE_THEME(dark)}</style>`;
  let out = /<style id="t3-theme">[\s\S]*?<\/style>/.test(html)
    ? html.replace(/<style id="t3-theme">[\s\S]*?<\/style>/, style)
    : /<head[^>]*>/i.test(html)
      ? html.replace(/<head[^>]*>/i, (m) => m + style)
      : /<html[^>]*>/i.test(html)
        ? html.replace(/<html[^>]*>/i, (m) => `${m}<head>${style}</head>`)
        : style + html;
  out = out.includes("</body>") ? out.replace("</body>", RESIZE_SCRIPT + "</body>") : out + RESIZE_SCRIPT;
  return out;
}

type PageEntry = Extract<Entry, { kind: "page" }>;
type PageLoad = { kind: "loading" } | { kind: "ready"; html: string; url: string } | { kind: "error" };
const pageHeight = (height: number) => Number.isFinite(height) && height > 0 ? Math.min(Math.max(height, 240), 1400) : 480;
const pageIsDark = () => typeof document !== "undefined" && document.documentElement.classList.contains("dark");
function subscribePageTheme(changed: () => void) {
  const observer = new window.MutationObserver(changed);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
}

export function PageCard({ entry }: { entry: PageEntry }) {
  return <PagePreview key={entry.attachmentId} entry={entry} />;
}

function PagePreview({ entry }: { entry: PageEntry }) {
  const [load, setLoad] = useState<PageLoad>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [height, setHeight] = useState(() => pageHeight(entry.height));
  const [full, setFull] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const dark = useSyncExternalStore(subscribePageTheme, pageIsDark, () => false);
  const title = entry.title.trim() || "Untitled page";
  const doc = load.kind === "ready" ? themedPage(load.html, dark) : null;

  useEffect(() => {
    const controller = new AbortController();
    setLoad({ kind: "loading" });
    const read = async () => {
      try {
        const url = await assetUrl({ _tag: "attachment", attachmentId: entry.attachmentId, disposition: "inline" });
        if (controller.signal.aborted) return;
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error("Page unavailable");
        const html = await response.text();
        if (!controller.signal.aborted) setLoad({ kind: "ready", html, url });
      } catch {
        if (!controller.signal.aborted) setLoad({ kind: "error" });
      }
    };
    void read();
    return () => controller.abort();
  }, [entry.attachmentId, attempt]);

  useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>) => {
      const data = event.data;
      if (event.source !== frame.current?.contentWindow || !data || typeof data !== "object" || !("botPageHeight" in data) || typeof data.botPageHeight !== "number") return;
      if (Number.isFinite(data.botPageHeight) && data.botPageHeight > 0) setHeight(pageHeight(data.botPageHeight));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    if (!full || !dialog.current) return;
    const panel = dialog.current;
    const overflow = document.body.style.overflow;
    panel.showModal();
    close.current?.focus({ preventScroll: true });
    document.body.style.overflow = "hidden";
    return () => {
      panel.close();
      document.body.style.overflow = overflow;
      opener.current?.focus({ preventScroll: true });
    };
  }, [full]);

  return (
    <div className="page-card fade-up">
      {doc ? <>
        <div className="page-card-preview">
          <iframe ref={frame} srcDoc={doc} title={title} sandbox="allow-scripts" style={{ height }} />
        </div>
        <button ref={opener} type="button" onClick={() => setFull(true)} className="page-card-expand" aria-label={`Open page, ${title}`} title="Open full screen"><Maximize2 size={16} aria-hidden="true" /></button>
      </> : <div className="page-card-placeholder">
        {load.kind === "error" ? <div role="alert"><p>Couldn't load this page.</p><button type="button" onClick={() => setAttempt(value => value + 1)}>Retry</button></div> : <span role="status" aria-label="Loading page"><Spinner /></span>}
      </div>}
      {full && doc && load.kind === "ready" && <dialog ref={dialog} className="page-viewer" aria-label={title} onCancel={event => { event.preventDefault(); setFull(false); }} onClose={() => setFull(false)}>
        <div className="page-viewer-header">
          <button ref={close} type="button" onClick={() => setFull(false)} className="page-viewer-action" aria-label="Close page"><X size={22} /></button>
          <span className="page-viewer-title">{title}</span>
          <a href={load.url} target="_blank" rel="noreferrer" className="page-viewer-action" aria-label="Open in new tab"><ExternalLink size={20} /></a>
        </div>
        <div className="page-viewer-content">
          <iframe srcDoc={doc} title={title} sandbox="allow-scripts allow-popups" />
        </div>
      </dialog>}
    </div>
  );
}
