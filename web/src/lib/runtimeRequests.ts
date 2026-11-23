import type { RuntimeRequest, TurnItem } from "./types";

// These fields mirror T3's orchestrationV2 request contracts. TurnItem's
// provider-specific fields arrive untyped, so narrow them at this boundary.
export type ApprovalDecision = "accept" | "acceptForSession" | "acceptAlways" | "decline" | "cancel";
export type ApprovalOption = { decision: ApprovalDecision; label: string; warning?: string };
export type QuestionAnswer = string | string[];
export type QuestionAnswers = Record<string, QuestionAnswer>;
export type Question = {
  id: string;
  header?: string;
  question: string;
  options: { label: string; description?: string; value?: string }[];
  multiSelect?: boolean;
  allowCustomAnswer?: boolean;
  initialAnswer?: string;
};
export type RequestStatus = RuntimeRequest["status"] | "unavailable";

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : undefined;
}

function decision(value: unknown): ApprovalDecision | undefined {
  switch (value) {
    case "accept": case "acceptForSession": case "acceptAlways": case "decline": case "cancel": return value;
    default: return undefined;
  }
}

export function findRequest(reqs: Record<string, RuntimeRequest>, requestId: unknown) {
  if (typeof requestId !== "string" || !requestId) return undefined;
  return reqs[requestId] ?? Object.values(reqs).find((r) => r.id.endsWith(requestId) || requestId.endsWith(r.id));
}

export function requestStatus(item: TurnItem, request?: RuntimeRequest): RequestStatus {
  if (request && request.status !== "pending") return request.status;
  // Terminal turn items must not become actionable if a request snapshot lags.
  if (item.status === "cancelled" || item.status === "expired") return item.status;
  if (item.status === "completed") return "resolved";
  if (request?.responseCapability?.type === "not_resumable") return "unavailable";
  return item.status === "waiting" || item.status === "running" ? "pending" : "unavailable";
}

export function approvalDecision(item: TurnItem, request?: RuntimeRequest): ApprovalDecision | undefined {
  return decision(record(request)?.decision) ?? decision(item.decision);
}

export function approvalOptions(value: unknown): ApprovalOption[] {
  if (!Array.isArray(value)) return [
    { decision: "accept", label: "Allow once" },
    { decision: "acceptAlways", label: "Always allow" },
    { decision: "decline", label: "Deny" },
  ];
  return value.flatMap((value: unknown) => {
    const option = record(value);
    const parsedDecision = decision(option?.decision);
    return option && parsedDecision && typeof option.label === "string"
      ? [{ decision: parsedDecision, label: option.label, warning: typeof option.warning === "string" ? option.warning : undefined }]
      : [];
  });
}

export function requestQuestions(value: unknown): Question[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((value: unknown) => {
    const q = record(value);
    if (!q || typeof q.id !== "string" || typeof q.question !== "string" || !Array.isArray(q.options)) return [];
    const options = q.options.flatMap((value: unknown) => {
      const option = record(value);
      return option && typeof option.label === "string" ? [{
        label: option.label,
        description: typeof option.description === "string" ? option.description : undefined,
        value: typeof option.value === "string" ? option.value : undefined,
      }] : [];
    });
    return [{ id: q.id, question: q.question, options, header: typeof q.header === "string" ? q.header : undefined, multiSelect: q.multiSelect === true, allowCustomAnswer: q.allowCustomAnswer !== false, initialAnswer: typeof q.initialAnswer === "string" ? q.initialAnswer : undefined }];
  });
}

export function customQuestionAnswer(question: Question, text: string): string | null {
  const trimmed = text.trim();
  if (!question.allowCustomAnswer || !trimmed) return null;
  return question.initialAnswer === undefined ? trimmed : text;
}

export function questionAnswers(item: TurnItem, request?: RuntimeRequest): QuestionAnswers {
  const answers = record(record(request)?.answers) ?? record(record(item.questionAnswer)?.answers) ?? {};
  return Object.fromEntries(Object.entries(answers).flatMap<[string, QuestionAnswer]>(([id, answer]) => {
    if (typeof answer === "string") return [[id, answer]];
    if (Array.isArray(answer) && answer.every((value: unknown): value is string => typeof value === "string")) return [[id, answer]];
    return [];
  }));
}

/** The matching turn answer owns the selection shown in the transcript. */
export function questionAnswerMessageId(item: TurnItem): string | undefined {
  if (item.type !== "user_input_request") return;
  const requestId = record(item.questionAnswer)?.requestId;
  return typeof requestId === "string" && requestId.length > 0 ? `async-answer:${requestId}` : undefined;
}

/** An http(s) page, or null for anything else, so an agent can't make the card open another scheme. */
function webPage(value: string): URL | null {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.host !== "" ? url : null;
  } catch { return null; }
}

/**
 * The sign-in or setup page a secret card opens: the agent's `url` (newer T3 Code), else the one
 * link in its reason, as T3 Code's own card does. A bare link drops trailing sentence punctuation.
 */
export function secretLink(item: TurnItem): { href: string; host: string } | null {
  if (typeof item.url === "string") {
    const url = webPage(item.url.trim());
    return url && { href: url.href, host: url.host };
  }
  const found = typeof item.reason === "string" ? item.reason.match(/https?:\/\/[^\s<>"'`[\]()]+/g) ?? [] : [];
  const pages = new Map<string, URL>();
  for (const raw of found) {
    const url = webPage(raw.replace(/[.,;:!?*]+$/, ""));
    if (url) pages.set(url.href, url);
  }
  if (pages.size !== 1) return null;
  const [url] = pages.values();
  return { href: url.href, host: url.host };
}

export function secretStatus(item: TurnItem): RequestStatus | "saved" | "declined" {
  if (item.secretStatus === "saved" || item.secretStatus === "declined" || item.secretStatus === "cancelled") return item.secretStatus;
  // Secrets have no RuntimeRequest record; cancellation is on the turn item.
  return item.secretStatus === "pending" ? requestStatus(item) : "unavailable";
}
