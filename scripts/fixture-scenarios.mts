// Scripted protocol fixtures, never an agent runner or a real T3 connection.
// Shapes follow runtime-cards.test.mts, bot-messages.test.mts and the installed
// T3 OrchestrationV2RuntimeRequest, ProviderApprovalDecision and
// SecretRequestAnswerInput contracts.
import { RICH_MESSAGES } from './fixture-rich-content.mts';

// Loose shapes of the fake T3 records the fixtures build and mutate. Only the fields
// the fixtures read are named; the rest pass through as plain JSON.
export type FixtureModel = { instanceId: string; model: string };
export type FixtureSample = { slug: string; name: string; shape: string; color: string; primary: boolean; pinned?: boolean; section?: string };
export type FixtureOption = { label: string; value?: string; description?: string };
export type FixtureQuestion = {
  id: string; question: string; header?: string; options: FixtureOption[];
  allowCustomAnswer?: boolean; multiSelect?: boolean; initialAnswer?: string;
};
export type FixtureApprovalOption = { decision: string; label: string; warning?: string };
export interface FixtureItem {
  id: string; threadId: string; ordinal: number; type: string; status: string; runId: string | null;
  startedAt: string; completedAt: string | null; updatedAt: string; title?: string | null; parentItemId?: string | null;
  text?: string; nodeId?: string | null; secretStatus?: string; questions?: FixtureQuestion[]; options?: FixtureApprovalOption[];
  questionAnswer?: unknown;
  [key: string]: unknown;
}
export type FixtureRequest = {
  id: string; nodeId?: string | null; providerTurnId?: null; nativeRequestRef?: null; kind: string; status: string;
  responseCapability: { type: string; providerSessionId?: string }; createdAt: string; resolvedAt: string | null;
  decision?: string; answers?: Record<string, string | string[]>;
};
export interface FixtureThread {
  id: string; projectId: string; title: string; status: string; activeRunId: string | null; latestRunId: string | null;
  modelSelection: FixtureModel; runtimeMode: string; pendingRuntimeRequest: { id: string; kind: string; blocking: boolean } | null;
  latestVisibleMessage: null; latestRunCompletedAt: string | null; latestUserMessageAt: string;
  lineage: { parentThreadId: string | null; relationshipToParent: string | null; rootThreadId: string; sideChat?: boolean };
  archivedAt: string | null; settledOverride: string | null; settledAt: string | null; unsettledAt: string | null;
  snoozedUntil: string | null; autoSettleDisabledAt: string | null; lastVisitedAt: string; createdAt: string; updatedAt: string;
  activityRunStatus?: string | null; latestRunStartedAt?: string;
  pullRequests?: { host: string; repository: string; number: number; url: string; source: string; snapshot: { state: string; title: string }; watch: null }[];
}
export type FixtureRun = {
  id: string; userMessageId?: string; ordinal: number; status: string; requestedAt: string; startedAt: string;
  completedAt: string | null; modelSelection: FixtureModel;
};
export type FixtureProject = {
  id: string; title: string; workspaceRoot: string; defaultModelSelection: FixtureModel; createdAt: string; updatedAt: string;
  archivedAt?: string | null; faviconPath?: unknown; projectIcon?: unknown;
};
export type FixtureResponse = { error?: string; ok?: boolean; value?: unknown; tasks?: boolean };
/** A scripted scenario's runtime-request handlers, as the fake T3 server calls them. */
export interface FixtureInteractions {
  requests: Map<string, FixtureRequest[]>;
  inspect(): unknown;
  // Fixture control body and RPC payloads are untyped JSON from the client.
  armFailure(body: any): boolean;
  respond(tag: string, payload: any, context?: { publish?: () => void }): FixtureResponse | null;
  /** After a message lands in a thread (the avatars scenario answers drawing requests). */
  afterMessage?(thread: FixtureThread, text: string, publish: () => void): void;
  capabilities?: Record<string, boolean>;
}
type LandingEntry = {
  type: string; at: string; text?: string; requestId?: string; questions?: FixtureQuestion[];
  title?: string; childThreadId?: string; subagentId?: string;
};

export const DUMMY_SECRET = 'fixture-dummy-only';
export const INITIAL_ANSWER = '  Proposed generic message\n\nKeep this second line  \n';
export const APPROVAL_OPTIONS: FixtureApprovalOption[] = [
  { decision: 'accept', label: 'Allow once' },
  { decision: 'acceptForSession', label: 'Allow for session', warning: 'Synthetic session only' },
  { decision: 'acceptAlways', label: 'Always allow', warning: 'Synthetic fixture only' },
  { decision: 'decline', label: 'Deny' },
  { decision: 'cancel', label: 'Cancel action' },
];
export const INTERACTION_IDS = {
  initial: 'fixture-question-initial', multi: 'fixture-question-multi', layout: 'fixture-question-layout',
  approvals: APPROVAL_OPTIONS.map(({ decision }) => `fixture-approval-${decision}`),
  save: 'fixture-secret-save', decline: 'fixture-secret-decline',
};

export function validateScenario(scenario: string) {
  if (!['basic', 'interactions', 'executor', 'library', 'landing', 'latest-t3', 'avatars', 'activity', 'adopt', 'release-notes'].includes(scenario)) throw new Error('Scenario must be basic, interactions, executor, library, landing, latest-t3, avatars, activity, adopt or release-notes.');
}

// A believable personal setup for product screenshots. Everything here is invented;
// no provider runs and nothing can be sent or answered.
export const LANDING_SAMPLES: FixtureSample[] = [
  { slug: 'morning', name: 'Morning', shape: 't3', color: 'purple', primary: true },
  { slug: 'money', name: 'Money', shape: 'clover', color: 'pink', primary: false, pinned: true },
  { slug: 'trips', name: 'Trips', shape: 'sparkle', color: 'blue', primary: false, section: 'personal' },
  { slug: 'site', name: 'Side project', shape: 'hex', color: 'purple', primary: false, section: 'work' },
];
export const LANDING_SECTIONS = ['personal', 'work'];
export const LANDING_USER = 'Sam';

export function landingData(now = new Date()) {
  const at = (daysAgo: number, hour: number, minute = 0) => { const d = new Date(now); d.setDate(d.getDate() - daysAgo); d.setHours(hour, minute, 0, 0); return d.toISOString(); };
  const transcripts: Record<string, LandingEntry[]> = {
    morning: [
      { type: 'user_message', at: at(0, 8, 2), text: 'What do I need to deal with today?' },
      { type: 'assistant_message', at: at(0, 8, 2), text: 'Two things.\n\n1. Your car insurance renews on Friday. The new quote is €412, up from €388 last year.\n2. The dentist moved you to Thursday at 4:30.\n\nThe rest of the week is clear.' },
      { type: 'user_message', at: at(0, 8, 4), text: 'Check this for me every morning.' },
      { type: 'assistant_message', at: at(0, 8, 4), text: 'Done. I\'ll look at your calendar and inbox at 8:00 every day, and only message you when something needs you.' },
    ],
    money: [
      { type: 'user_message', at: at(0, 7, 41), text: 'Anything unusual this week?' },
      { type: 'assistant_message', at: at(0, 7, 42), text: 'One thing. A €49 charge from a streaming service you cancelled in September. Everything else matches last month.' },
      { type: 'user_input_request', at: at(0, 7, 42), requestId: 'landing-money-dispute', questions: [{
        id: 'dispute', question: 'Dispute the €49 charge?', allowCustomAnswer: false,
        options: [{ label: 'Yes, dispute it', value: 'dispute' }, { label: 'Leave it', value: 'leave' }],
      }] },
    ],
    trips: [
      { type: 'user_message', at: at(1, 18, 10), text: 'Find a hotel in Lisbon for the 14th to the 17th. Walkable, under €180 a night.' },
      { type: 'assistant_message', at: at(1, 18, 16), text: 'Booked Lisboa Pessoa, €164 a night, three minutes from Baixa-Chiado. The confirmation is in your email and in Library.' },
    ],
    site: [
      { type: 'user_message', at: at(3, 14, 5), text: 'The login page breaks on Safari. Can you fix it?' },
      { type: 'subagent', at: at(3, 14, 6), title: 'Safari regression check', childThreadId: 'thread-site-child', subagentId: 'safari-check' },
      { type: 'assistant_message', at: at(3, 14, 31), text: 'Found it. The form used a `:has()` selector that Safari 16 doesn\'t support. Fixed, tested on Safari 16 and 17, and opened PR #42.' },
    ],
    'site-child': [
      { type: 'assistant_message', at: at(3, 14, 20), text: 'Login renders and submits on Safari 16.6 and 17.2. No regressions on Chrome or Firefox.' },
    ],
  };
  const tasks = [
    { id: 'landing-routine-morning', title: 'Morning check', prompt: 'Check my calendar and inbox. Tell me what needs me today.', enabled: true,
      schedule: { type: 'fixed_time', timeOfDay: '08:00' }, projectId: 'project-morning', threadId: 'thread-morning',
      nextRunAt: at(-1, 8), lastRunAt: at(0, 8), lastRunStatus: 'completed', runCount: 23 },
    { id: 'landing-routine-money', title: 'Weekly recap', prompt: 'Sum up what went out this week and flag anything unusual.', enabled: true,
      schedule: { type: 'fixed_time', timeOfDay: '18:00', weekdays: [0] }, projectId: 'project-money', threadId: 'thread-money',
      nextRunAt: at(-6, 18), lastRunAt: at(1, 18), lastRunStatus: 'completed', runCount: 9 },
  ];
  return { samples: LANDING_SAMPLES, sections: LANDING_SECTIONS, userName: LANDING_USER, transcripts, tasks, unread: ['trips'], child: { parent: 'site', title: 'Safari regression check' } };
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const onlyKeys = (value: unknown, keys: string[]) => record(value) && Object.keys(value).every((key) => keys.includes(key));

export function seedInteractions({ threads, items, stamp }: { threads: FixtureThread[]; items: Map<string, FixtureItem[]>; stamp: string }): FixtureInteractions {
  const requests = new Map<string, FixtureRequest[]>(threads.map(({ id }) => [id, []]));
  const targets = new Map<string, { item: FixtureItem; request?: FixtureRequest }>();
  let tick = 0;
  const now = () => new Date(Date.parse(stamp) + ++tick * 1000).toISOString();
  const append = (threadId: string, type: string, extra: Partial<FixtureItem> = {}) => {
    const ordinal = Math.max(0, ...items.get(threadId)!.map((item) => item.ordinal)) + 1;
    const at = now();
    const item: FixtureItem = { id: `${threadId}-interaction-${ordinal}`, threadId, ordinal, type,
      runId: null, nodeId: null, providerThreadId: null, providerTurnId: null, nativeItemRef: null,
      parentItemId: null, status: 'completed', title: null, startedAt: at, completedAt: at, updatedAt: at, ...extra };
    items.get(threadId)!.push(item);
    return item;
  };
  const message = (threadId: string, type: string, text: string, extra: Partial<FixtureItem> = {}) => append(threadId, type, {
    messageId: `${threadId}-fixture-message-${items.get(threadId)!.length}`, text,
    ...(type === 'user_message' ? { createdBy: 'user', creationSource: 'web', inputIntent: 'turn_start', attachments: [] } : {}), ...extra,
  });
  for (let index = 1; index <= 12; index++) message('thread-alpha', 'assistant_message',
    `Generic history ${index}. This fixed paragraph gives the parent transcript a measurable scroll position.\n\nOnly disposable scripted data is present.`);
  message('thread-alpha', 'assistant_message', 'Exchange return anchor. Ask @Beta and @Gamma. Thread reference: t3-thread://v1/thread-beta.\n\nThese are paired synthetic messages, not live Bot delivery.');
  const exchange = (sender: string, recipient: string, id: string, text: string) => {
    append(`thread-${sender.toLowerCase()}`, 'dynamic_tool', { toolName: 't3-code.t3_thread_send',
      input: { threadId: `thread-${recipient.toLowerCase()}`, message: `From ${sender}: ${text}` },
      output: { threadId: `thread-${recipient.toLowerCase()}`, messageId: id } });
    message(`thread-${recipient.toLowerCase()}`, 'user_message', `From ${sender}: ${text}`, {
      senderThreadId: `thread-${sender.toLowerCase()}`, messageId: id, createdBy: 'agent', creationSource: 'mcp',
    });
  };
  exchange('Alpha', 'Beta', 'fixture-alpha-beta', 'Please review the generic sample.');
  exchange('Alpha', 'Gamma', 'fixture-alpha-gamma', 'Please check the generic layout.');
  exchange('Beta', 'Alpha', 'fixture-beta-alpha', 'The generic sample is ready.');

  const addRequest = (id: string, type: string, extra: Partial<FixtureItem>, status = 'pending', threadId = 'thread-alpha', decision?: string) => {
    const item = append(threadId, type, { id: `${id}-item`, requestId: id, nodeId: `node-${id}`,
      status: status === 'pending' ? 'waiting' : status === 'cancelled' || decision === 'decline' || decision === 'cancel' ? 'cancelled' : 'completed',
      ...(status === 'pending' ? { completedAt: null } : {}), ...extra });
    const request: FixtureRequest = { id, nodeId: item.nodeId, providerTurnId: null, nativeRequestRef: null,
      kind: type === 'user_input_request' ? 'user_input' : 'command', status,
      responseCapability: { type: 'live', providerSessionId: 'fixture-session' },
      createdAt: item.startedAt, resolvedAt: status === 'pending' ? null : item.completedAt,
      ...(decision ? { decision } : {}) };
    requests.get(threadId)!.push(request);
    targets.set(id, { item, request });
  };
  const initialQuestion: FixtureQuestion = { id: 'draft', header: 'Generic draft', question: 'Review the proposed generic message',
    options: [], allowCustomAnswer: true, initialAnswer: INITIAL_ANSWER };
  addRequest(INTERACTION_IDS.initial, 'user_input_request', { questions: [initialQuestion] });
  addRequest(INTERACTION_IDS.multi, 'user_input_request', { questions: [
    { id: 'choices', header: 'Generic choices', question: 'Which generic samples should be checked?', multiSelect: true,
      allowCustomAnswer: false, options: [{ label: 'First sample', description: 'Generic first sample', value: 'first-id' },
        { label: 'Second sample', description: 'Generic second sample', value: 'second-id' }] },
    { ...initialQuestion, id: 'detail', question: 'Review the generic detail' },
  ] });
  // Asynchronous questions resume the provider through a synthetic message.
  // The real transcript must fold that message into its answered question.
  targets.get(INTERACTION_IDS.multi)!.request!.responseCapability = { type: 'message' };
  for (const id of INTERACTION_IDS.approvals) addRequest(id, 'approval_request', {
    requestKind: 'command', title: `Generic approval: ${id.slice('fixture-approval-'.length)}`,
    reason: 'Synthetic decision only. No command executes and no permission is granted.',
    prompt: 'Review the generic sample', options: structuredClone(APPROVAL_OPTIONS),
  });
  for (const [status, decision] of [['resolved', 'accept'], ['resolved', 'decline'], ['expired'], ['cancelled']]) {
    const suffix = decision ?? status;
    addRequest(`fixture-terminal-approval-${suffix}`, 'approval_request', { requestKind: 'command',
      title: `Generic ${suffix} approval`, options: structuredClone(APPROVAL_OPTIONS) }, status, 'thread-beta', decision);
  }
  for (const status of ['resolved', 'expired', 'cancelled']) addRequest(`fixture-terminal-question-${status}`,
    'user_input_request', { questions: [{ ...initialQuestion, question: `Generic ${status} question` }] }, status, 'thread-beta');
  const addSecret = (id: string, status = 'pending', threadId = 'thread-alpha') => {
    const item = append(threadId, 'secret_request', { id,
      label: `Generic secret: ${id.slice('fixture-secret-'.length)}`,
      reason: 'Synthetic only. Use DUMMY_SECRET from scripts/fixture-scenarios.mts. No value is stored or delivered.',
      placeholder: 'Fixed dummy fixture value only', secretStatus: status,
      status: status === 'pending' ? 'waiting' : status === 'cancelled' ? 'cancelled' : 'completed',
      ...(status === 'pending' ? { completedAt: null } : {}) });
    targets.set(id, { item });
  };
  addSecret(INTERACTION_IDS.save);
  addSecret(INTERACTION_IDS.decline);
  for (const status of ['saved', 'declined', 'cancelled']) addSecret(`fixture-secret-${status}`, status, 'thread-gamma');
  for (let index = 1; index <= 12; index++) message('thread-alpha', 'assistant_message',
    `Generic continuation ${index}. Return to the exchange anchor above to check exact parent scroll restoration.\n\nNo provider or real T3 runs in this scenario.`);
  addRequest(INTERACTION_IDS.layout, 'user_input_request', { questions: [{ id: 'layout',
    question: 'Which layout do you prefer?', allowCustomAnswer: false,
    options: [{ label: 'Compact', value: 'compact' }, { label: 'Spacious', value: 'spacious' }],
  }] });
  targets.get(INTERACTION_IDS.layout)!.request!.responseCapability = { type: 'message' };

  // Dedicated populated comparison lane; original Alpha acceptance specimens stay unchanged.
  message('thread-gamma', 'user_message', 'Please compare these disposable UI specimens.', { id: 'fixture-rich-user' });
  for (const [name, text] of RICH_MESSAGES) message('thread-gamma', 'assistant_message', text, {
    id: `fixture-rich-${name}`, runId: 'fixture-rich-request-id',
  });
  const layout: FixtureQuestion = { id: 'layout', question: 'Pick a layout', allowCustomAnswer: true,
    options: [{ label: 'Compact', value: 'compact' }, { label: 'Spacious', value: 'spacious' }] };
  addRequest('fixture-rich-choice', 'user_input_request', { questions: [layout] }, 'pending', 'thread-gamma');
  targets.get('fixture-rich-choice')!.request!.responseCapability = { type: 'message' };
  addRequest('fixture-rich-custom', 'user_input_request', { questions: [{...layout, question:'Choose format'}] }, 'pending', 'thread-gamma');
  targets.get('fixture-rich-custom')!.request!.responseCapability = { type: 'message' };
  addRequest('fixture-rich-review', 'user_input_request', { questions: [layout, {
    id: 'sections', question: 'Pick sections', multiSelect: true, allowCustomAnswer: false,
    options: [{label:'Summary', value:'summary'}, {label:'Code sample', value:'code'}],
  }], questionAnswer: { requestId:'fixture-rich-review', answers: {layout:'compact', sections:['summary','code']} } }, 'resolved', 'thread-gamma');
  targets.get('fixture-rich-review')!.request!.answers = {layout:'compact', sections:['summary','code']};

  const counters = new Map([...targets].map(([id]) => [id, { attempts: 0, accepted: 0, failed: 0, rejected: 0, failOnce: false }]));
  const statusOf = ({ item, request }: { item: FixtureItem; request?: FixtureRequest }) => request?.status ?? item.secretStatus;
  const updateShell = () => {
    for (const thread of threads) {
      const pending = requests.get(thread.id)!.find((request) => request.status === 'pending');
      thread.pendingRuntimeRequest = pending ? { id: pending.id, kind: pending.kind, blocking: true } : null;
    }
  };
  updateShell();
  const validAnswers = (questions: FixtureQuestion[], answers: Record<string, unknown>) => onlyKeys(answers, questions.map(({ id }) => id)) &&
    Object.keys(answers).length === questions.length && questions.every((question) => {
      const answer = answers[question.id];
      const values = question.options.map((option) => option.value ?? option.label);
      const text = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 4096 &&
        (question.allowCustomAnswer !== false || values.includes(value));
      return question.multiSelect
        ? typeof answer === 'string' ? question.allowCustomAnswer !== false && text(answer)
          : Array.isArray(answer) && answer.length > 0 && new Set(answer).size === answer.length && answer.every(text)
        : text(answer);
    });

  return {
    requests,
    inspect() {
      return { fixtureOnly: true, scenario: 'interactions', liveDelivery: false,
        targets: [...targets].map(([id, target]) => ({ id, threadId: target.item.threadId,
          kind: target.item.type, status: statusOf(target), ...counters.get(id),
          ...(target.request?.decision ? { decision: target.request.decision } : {}),
          ...(target.request?.answers ? { answerFields: Object.entries(target.request.answers).map(([id, value]) => ({ id, type: Array.isArray(value) ? 'array' : 'string' })) } : {}),
        })) };
    },
    armFailure(body: any) {
      if (!onlyKeys(body, ['targetId']) || typeof body.targetId !== 'string') return false;
      const target = targets.get(body.targetId);
      if (!target || statusOf(target) !== 'pending') return false;
      counters.get(body.targetId)!.failOnce = true;
      return true;
    },
    // Returns null for RPCs outside this deliberately narrow scenario.
    respond(tag: string, payload: any): FixtureResponse | null {
      const secret = tag === 'secrets.answerRequest';
      const dismiss = tag === 'orchestration.dispatchCommand' && payload?.type === 'thread.user-input.dismiss';
      if (!secret && !dismiss && !(tag === 'orchestration.dispatchCommand' && payload?.type === 'runtime-request.respond')) return null;
      const target = targets.get(secret ? payload?.turnItemId : payload?.requestId);
      if (!target || target.item.threadId !== payload?.threadId || secret !== (target.item.type === 'secret_request')) return { error: 'Unknown fixture interaction target.' };
      const count = counters.get(secret ? payload.turnItemId : payload.requestId)!;
      count.attempts++;
      const reject = (error: string) => { count.rejected++; return { error }; };
      if (statusOf(target) !== 'pending') return reject('Fixture interaction already answered or terminal.');
      if (secret) {
        if (!onlyKeys(payload, ['threadId', 'turnItemId', 'answer']) ||
          !(onlyKeys(payload.answer, ['type']) && payload.answer.type === 'decline' ||
            onlyKeys(payload.answer, ['type', 'secret']) && payload.answer.type === 'save' && payload.answer.secret === DUMMY_SECRET)) {
          return reject('Fixture secret response rejected. Use only the fixed dummy fixture value or decline.');
        }
      } else {
        if (typeof payload.commandId !== 'string' || !payload.commandId.length) return reject('Fixture response requires a commandId.');
        if (dismiss) {
          if (!onlyKeys(payload, ['commandId', 'type', 'threadId', 'requestId']) || target.request!.kind !== 'user_input' ||
            target.request!.responseCapability.type !== 'message') return reject('This fixture question needs an answer.');
        } else if (target.request!.kind === 'user_input') {
          if (!onlyKeys(payload, ['commandId', 'type', 'threadId', 'requestId', 'answers']) || !validAnswers(target.item.questions!, payload.answers)) return reject('Fixture question requires complete valid answers.');
        } else if (!onlyKeys(payload, ['commandId', 'type', 'threadId', 'requestId', 'decision']) ||
          !target.item.options!.some(({ decision }) => decision === payload.decision)) return reject('Unsupported fixture approval decision.');
      }
      if (count.failOnce) {
        count.failOnce = false;
        count.failed++;
        return { error: 'Synthetic fixture response failed once. Try again.' };
      }
      // Never retain, echo, log, hash or write the submitted secret value.
      const at = now();
      // T3 resolves the request for every decision, while decline/cancel mark
      // the associated action item cancelled (dispatchRuntimeRequestRespond).
      target.item.status = dismiss || !secret && ['decline', 'cancel'].includes(payload.decision) ? 'cancelled' : 'completed';
      target.item.completedAt = at;
      target.item.updatedAt = at;
      if (secret) target.item.secretStatus = payload.answer.type === 'save' ? 'saved' : 'declined';
      else {
        target.request!.status = 'resolved';
        target.request!.resolvedAt = at;
        if (dismiss) target.request!.decision = 'cancel';
        else if (target.request!.kind === 'user_input') {
          target.request!.answers = structuredClone(payload.answers);
          target.item.questionAnswer = { requestId: target.request!.id, answers: structuredClone(payload.answers), attachmentsByQuestionId: {},
            questionTextById: Object.fromEntries(target.item.questions!.map(({ id, question }) => [id, question])) };
          if (target.request!.responseCapability.type === 'message') {
            const text = target.item.questions!.map(({ id, question }) => {
              const answer = payload.answers[id];
              return `${question}\n${Array.isArray(answer) ? answer.join(', ') : answer}`;
            }).join('\n\n');
            message(target.item.threadId, 'user_message', text, {
              messageId: `async-answer:${target.request!.id}`, creationSource: 'server',
            });
          }
        } else target.request!.decision = payload.decision;
      }
      count.accepted++;
      updateShell();
      return { ok: true };
    },
  };
}

// Shapes added in T3 Code 0.1.6–0.1.8, so the app can be checked without a real T3:
// a child waiting on an approval, a Stop the agent ignored, one-time and policy-blocked
// routines, and a Bot whose project was archived in T3 Code. Synthetic data only.
export const LATEST_T3_IDS = { childApproval: 'fixture-child-approval', stuckRun: 'fixture-run-stuck', once: 'fixture-routine-once', blocked: 'fixture-routine-blocked' };
export function seedLatestT3({ threads, items, runs, projects, model, stamp }: {
  threads: FixtureThread[]; items: Map<string, FixtureItem[]>; runs: Map<string, FixtureRun[]>; projects: FixtureProject[]; model: FixtureModel; stamp: string;
}) {
  const requests = new Map<string, FixtureRequest[]>(threads.map(({ id }) => [id, []]));
  const ordinal = (threadId: string) => Math.max(0, ...items.get(threadId)!.map((item) => item.ordinal)) + 1;
  const base = (threadId: string, type: string, extra: Partial<FixtureItem>): FixtureItem => ({ id: `${threadId}-latest-${ordinal(threadId)}`, threadId, ordinal: ordinal(threadId), type,
    runId: null, status: 'completed', title: null, startedAt: stamp, completedAt: stamp, updatedAt: stamp, parentItemId: null, ...extra });
  projects.find((p) => p.id === 'project-gamma')!.archivedAt = stamp;

  const child = threads.find((t) => t.id === 'thread-alpha-child')!;
  const approval = base(child.id, 'approval_request', { requestId: LATEST_T3_IDS.childApproval, requestKind: 'command', status: 'waiting', completedAt: null,
    title: 'Delete the generic build folder', reason: 'Synthetic decision only. No command executes.', prompt: 'rm -rf ./generic-build',
    options: [{ decision: 'accept', label: 'Allow once' }, { decision: 'decline', label: 'Deny' }] });
  items.get(child.id)!.push(approval);
  const request: FixtureRequest = { id: LATEST_T3_IDS.childApproval, kind: 'command', status: 'pending', responseCapability: { type: 'live', providerSessionId: 'fixture-session' }, createdAt: stamp, resolvedAt: null };
  requests.get(child.id)!.push(request);
  child.pendingRuntimeRequest = { id: request.id, kind: 'command', blocking: true };

  const beta = threads.find((t) => t.id === 'thread-beta')!;
  const run: FixtureRun = { id: LATEST_T3_IDS.stuckRun, ordinal: 1, status: 'running', requestedAt: stamp, startedAt: stamp, completedAt: null, modelSelection: model };
  runs.get(beta.id)!.push(run);
  Object.assign(beta, { status: 'running', activityRunStatus: 'running', activeRunId: run.id, latestRunId: run.id, latestRunStartedAt: stamp });
  items.get(beta.id)!.push(base(beta.id, 'run_interrupt_request', { runId: run.id, message: 'Stop', unresponsiveAt: stamp }));

  const task = (id: string, title: string, schedule: { type: string; runAt?: string; timeOfDay?: string; weekdays?: number[] }, extra: { enabled?: boolean; blockedByPolicy?: string } = {}) => ({ id, title, prompt: `Generic routine: ${title}`, enabled: false, schedule, projectId: 'project-alpha', threadId: 'thread-alpha',
    threadMode: 'continue', workspaceStrategy: { type: 'root' }, modelSelection: model, runtimeMode: 'auto', interactionMode: 'default', nextRunAt: null, lastRunAt: null, lastRunStatus: null, lastRunError: null, runCount: 0, ...extra });
  const tasks = [
    task(LATEST_T3_IDS.once, 'Send the generic reminder once', { type: 'once', runAt: '2026-12-01T08:30:00.000Z' }),
    task(LATEST_T3_IDS.blocked, 'Generic weekday check', { type: 'fixed_time', timeOfDay: '09:00', weekdays: [1, 2, 3, 4, 5] }, { enabled: true, blockedByPolicy: 'Scheduled tasks are turned off by Example Org.' }),
  ];
  // PR chips in every state. Snapshots are stale on purpose; pullRequests.detail is the truth.
  // #2, #10 and #11 finished before load (no chip); #24 merges after its first read (flips on focus).
  const alpha = threads.find((t) => t.id === 'thread-alpha')!;
  const prs = ([
    [2, 'merged', false, [], 'open'], [10, 'merged', false, [], 'merged'], [11, 'closed', false, [], 'open'],
    [21, 'open', false, ['success', 'success'], 'open'], [22, 'open', true, ['pending'], 'open'],
    [23, 'open', false, ['success', 'failure'], 'open'], [24, 'open', false, ['pending', 'success'], 'open'],
  ] as [number, string, boolean, string[], string][]).map(([number, state, isDraft, checks, stale]) => ({ number, state, isDraft, checks, stale, reads: 0 }));
  alpha.pullRequests = prs.map(({ number, stale }) => ({ host: 'github.com', repository: 'example/generic', number,
    url: `https://github.com/example/generic/pull/${number}`, source: 'manual', snapshot: { state: stale, title: `Generic change ${number}` }, watch: null }));
  // T3 0.1.8 nightlies: a run can start a fresh session in the same thread.
  items.get(alpha.id)!.push(base(alpha.id, 'user_message', { messageId: 'fixture-fresh-routine-run', text: tasks[0].prompt, scheduledTaskId: tasks[0].id, freshContext: true, createdBy: 'user', creationSource: 'web', attachments: [] }));
  // T3 0.1.5+: provider turns carry token usage (0.1.7+ also names the models). Synthetic counts only.
  // They finished an hour ago, so a usage-stats preview (the last day) counts them.
  const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const turn = (id: string, runAttemptId: string, usage: Record<string, unknown>) => ({ id, providerThreadId: `${id}-provider`, nodeId: `${id}-node`, runAttemptId, nativeTurnRef: null, ordinal: 1, status: 'completed', startedAt: recent, completedAt: recent,
    turnTokenUsage: { usageScope: 'main_agent', usageStatus: 'complete', hasSubagents: false, ...usage } });
  const usage = new Map<string, { providerTurns: unknown[]; attempts: unknown[] }>([
    [alpha.id, { attempts: [], providerTurns: [turn('fixture-turn-1', 'fixture-attempt-x', { inputTokens: 12000, outputTokens: 800, cachedInputTokens: 9000, cacheCreationTokens: 500, models: ['fixture-opus'] }),
      turn('fixture-turn-2', 'fixture-attempt-x', { inputTokens: 3000, outputTokens: 200, cachedInputTokens: 2500, cacheCreationTokens: 0, models: ['fixture-opus'] })] }],
    // A Bot's child thread counts too.
    [child.id, { attempts: [], providerTurns: [turn('fixture-turn-3', 'fixture-attempt-y', { inputTokens: 400, outputTokens: 40, models: ['fixture-opus'] })] }],
    // Without reported models (T3 0.1.5–0.1.6), the run's selected model is used.
    [beta.id, { attempts: [{ id: 'fixture-attempt-beta', runId: run.id }], providerTurns: [turn('fixture-turn-4', 'fixture-attempt-beta', { inputTokens: 500, outputTokens: 50 })] }],
  ]);
  for (const thread of [alpha, child, beta]) thread.updatedAt = recent;
  const calls: Record<string, unknown>[] = [];
  return {
    requests, tasks, usage, serverVersion: '0.1.8-nightly.20261106.4275',
    capabilities: { sideChats: true, threadForceStop: true, voiceTranscription: true, freshContext: true, scheduledTaskThreadModes: true },
    voiceStatus: { supported: true, state: 'ready', modelId: 'fixture/speech', model: 'Fixture speech (no model)', size: 0, supportsStreaming: false, supportsTranslation: false,
      languages: ['en', 'es'], supportsLanguageDetection: false, acceleration: 'auto', modelUnloadTimeout: 'min_5', gpuDevices: [] },
    transcribe: fixtureTranscribe,
    inspect: () => ({ fixtureOnly: true, scenario: 'latest-t3', liveDelivery: false, request: request.status, decision: request.decision ?? null, run: run.status, gammaArchived: !!projects.find((p) => p.id === 'project-gamma')!.archivedAt, tasks: tasks.map(({ id, enabled, threadMode }) => ({ id, enabled, threadMode })), calls }),
    armFailure: () => false,
    respond(tag: string, payload: any): FixtureResponse | null {
      if (tag === 'orchestration.dispatchCommand' && payload?.type === 'runtime-request.respond' && payload.requestId === request.id) {
        if (payload.threadId !== child.id) return { error: 'This approval belongs to the child thread.' };
        if (request.status !== 'pending') return { error: 'Fixture approval already answered.' };
        Object.assign(request, { status: 'resolved', decision: payload.decision, resolvedAt: new Date().toISOString() });
        Object.assign(approval, { status: payload.decision === 'decline' ? 'cancelled' : 'completed', completedAt: request.resolvedAt, updatedAt: request.resolvedAt });
        child.pendingRuntimeRequest = null;
        calls.push({ tag, threadId: payload.threadId, decision: payload.decision });
        return { ok: true };
      }
      if (tag === 'orchestration.forceStopThread') {
        if (payload?.threadId !== beta.id || payload.runId !== run.id) return { error: 'Fixture force stop needs the stuck run.' };
        const at = new Date().toISOString();
        Object.assign(run, { status: 'interrupted', completedAt: at });
        Object.assign(beta, { status: 'interrupted', activityRunStatus: null, activeRunId: null, updatedAt: at });
        items.get(beta.id)!.push(base(beta.id, 'run_interrupt_result', { runId: run.id, scopeId: 'fixture', files: [] }));
        calls.push({ tag, threadId: payload.threadId, runId: payload.runId });
        return { ok: true, value: { outcome: 'killed', sharedWithThreadIds: [] } };
      }
      if (tag === 'pullRequests.detail' || tag === 'pullRequests.checks') {
        const pr = prs.find((p) => p.number === payload?.number && payload.repository === 'example/generic');
        if (!pr) return { error: 'Unknown fixture pull request.' };
        if (tag === 'pullRequests.checks') return { value: { checks: pr.checks.map((status, i) => ({ name: `generic-check-${i + 1}`, status })) } };
        if (pr.number === 24 && pr.reads++ > 0) pr.state = 'merged';
        return { value: { number: pr.number, title: `Generic change ${pr.number}`, state: pr.state, isDraft: pr.isDraft } };
      }
      if (tag === 'scheduledTasks.upsert') {
        const found = tasks.find((t) => t.id === payload?.id);
        if (!found || payload.requireExisting !== true) return { error: 'Fixture routines can only be edited.' };
        if (payload.threadMode !== undefined && !['new_thread', 'continue', 'fresh_session'].includes(payload.threadMode)) return { error: 'Unknown thread mode.' };
        // Like T3: an omitted mode keeps the stored one.
        Object.assign(found, { title: payload.title, prompt: payload.prompt, enabled: payload.enabled, schedule: payload.schedule, threadMode: payload.threadMode ?? found.threadMode });
        calls.push({ tag, id: found.id, threadMode: payload.threadMode ?? null });
        return { ok: true, value: { task: found }, tasks: true };
      }
      if (tag === 'scheduledTasks.setEnabled') {
        const found = tasks.find((t) => t.id === payload?.id);
        if (!found || typeof payload.enabled !== 'boolean') return { error: 'Unknown fixture routine.' };
        found.enabled = payload.enabled;
        calls.push({ tag, id: found.id, enabled: found.enabled });
        return { ok: true, value: { task: found }, tasks: true };
      }
      return null;
    },
  };
}

// Many object avatars (the sidebar's live cost, the editor's shared objects) and drawings. A drawing is
// an empty, archived "Avatar drawing job" thread with one hidden side chat per option; each side chat
// titled "Avatar drawing: …" answers with a scripted definition. No model draws anything.
const definition = (id: string, name: string, path: string) => ({ version: 1, id, name, body: { path }, eyes: { x: 50, y: 50, spacing: 15, scale: 1 } });
export const AVATAR_OWN = [
  definition('fixture-bean', 'Bean', 'M32 12 C56 6 86 16 88 42 C90 68 72 90 48 90 C24 90 10 72 12 50 C14 30 18 16 32 12 Z'),
  definition('fixture-pebble', 'Pebble', 'M50 14 C74 14 90 30 90 54 C90 76 74 88 50 88 C26 88 10 76 10 54 C10 30 26 14 50 14 Z'),
];
export const AVATAR_DRAWN = definition('fixture-acorn', 'Acorn', 'M50 10 C72 10 88 22 88 38 L82 42 C84 68 70 90 50 90 C30 90 16 68 18 42 L12 38 C12 22 28 10 50 10 Z');
export const AVATAR_SAMPLES = [
  { slug: 'alpha', name: 'Alpha', shape: 'sphere', color: 'teal', primary: true, pinned: true },
  ...['cat', 'ghost', 'rocket', 'mug', 'cloud', 'book', 'bunny', 'lightbulb', 'sprout', 'controller'].map((id, index) => ({
    slug: id, name: id[0].toUpperCase() + id.slice(1), shape: `object:${id}`, primary: false, pinned: true,
    color: ['orange', 'purple', 'blue', 'pink', 'green', 'red', 'yellow', 'teal', 'green', 'violet'][index] })),
  ...AVATAR_OWN.map((own, index) => ({ slug: own.id.slice('fixture-'.length), name: own.name, shape: `object:${own.id}`, avatarDefinition: own, color: ['brown', 'gray'][index], primary: false, pinned: true })),
  // Custom colours at the edges: near-black, near-white and very saturated, on a shape and an object.
  { slug: 'ink', name: 'Ink', shape: 'ball', color: '#15131c', primary: false, pinned: true },
  { slug: 'paper', name: 'Paper', shape: 'squircle', color: '#fbf9f2', primary: false, pinned: true },
  { slug: 'neon', name: 'Neon', shape: 'star', color: '#39ff14', primary: false, pinned: true },
  { slug: 'plum', name: 'Plum', shape: 'object:ghost', color: '#5b2a86', primary: false, pinned: true },
];
export const AVATAR_DRAWING_TITLE = 'Avatar drawing: ';
export const AVATAR_DRAWING_JOB = 'Avatar drawing job';
/** What the avatars scenario says it offers, so the editor's automatic drawing model has a fast pick. */
export const AVATAR_PROVIDERS = [{ instanceId: 'codex', driver: 'codex', displayName: 'Codex', enabled: true, status: 'ready', models: [
  { slug: 'gpt-6-luna', name: 'GPT-6-Luna', capabilities: { optionDescriptors: [
    { id: 'reasoningEffort', label: 'Reasoning', type: 'select', currentValue: 'medium', options: [{ id: 'low', label: 'Low' }, { id: 'medium', label: 'Medium' }] },
    { id: 'serviceTier', label: 'Speed', type: 'select', currentValue: 'default', options: [{ id: 'default', label: 'Standard' }, { id: 'priority', label: 'Fast' }] }] } }] }];

export function seedAvatars({ threads, items, runs, model }: { threads: FixtureThread[]; items: Map<string, FixtureItem[]>; runs: Map<string, FixtureRun[]>; model: FixtureModel }) {
  const calls: Record<string, unknown>[] = [];
  const finish = (thread: FixtureThread, text: string, publish: () => void) => {
    const now = new Date().toISOString();
    const run = runs.get(thread.id)?.find((candidate) => candidate.status === 'running');
    if (!run || !thread.title.startsWith(AVATAR_DRAWING_TITLE)) return;
    const entries = items.get(thread.id)!;
    entries.push({ id: `${thread.id}-${entries.length + 1}`, threadId: thread.id, ordinal: entries.length + 1, type: 'assistant_message', messageId: `${thread.id}-reply-${entries.length + 1}`,
      runId: run.id, status: 'completed', title: null, text, startedAt: now, completedAt: now, updatedAt: now, parentItemId: null });
    Object.assign(run, { status: 'completed', completedAt: now });
    Object.assign(thread, { status: 'completed', activityRunStatus: null, activeRunId: null, latestRunCompletedAt: now, updatedAt: now });
    publish();
  };
  return {
    requests: new Map<string, FixtureRequest[]>(threads.map(({ id }) => [id, []])),
    capabilities: { sideChats: true, threadForceStop: true },
    inspect: () => ({ fixtureOnly: true, scenario: 'avatars', liveDelivery: false, calls }),
    armFailure: () => false,
    respond(tag: string, payload: any, { publish }: { publish?: () => void } = {}): FixtureResponse | null {
      // A drawing's empty job: a thread in the Bot's project, archived at once.
      if (tag === 'orchestration.dispatchCommand' && payload?.type === 'thread.create') {
        if (payload.title !== AVATAR_DRAWING_JOB) return { error: 'Fixture creates only avatar drawing jobs.' };
        const now = new Date().toISOString();
        threads.push({ ...threads[0], id: payload.threadId, projectId: payload.projectId, title: payload.title, modelSelection: payload.modelSelection, runtimeMode: payload.runtimeMode, status: 'idle', activityRunStatus: null, activeRunId: null, latestRunId: null,
          latestRunCompletedAt: null, latestVisibleMessage: null, lastVisitedAt: now, createdAt: now, updatedAt: now, lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: payload.threadId } });
        items.set(payload.threadId, []); runs.set(payload.threadId, []);
        calls.push({ type: 'thread.create', title: payload.title, modelSelection: payload.modelSelection });
        return { value: { sequence: 0 } };
      }
      // "refused" turns down option 2's message, as a T3 that rejects one dispatch would.
      if (tag === 'orchestration.dispatchCommand' && payload?.type === 'message.dispatch' && /option 2 of/.test(payload.text ?? '')
        && /refused/i.test(threads.find((thread) => thread.id === payload.threadId)?.title ?? '')) return { error: 'Fixture refused this drawing option.' };
      if (tag === 'orchestration.dispatchCommand' && payload?.type === 'thread.archive') {
        const job = threads.find((thread) => thread.id === payload.threadId && thread.title === AVATAR_DRAWING_JOB);
        if (!job) return null;
        job.archivedAt = new Date().toISOString();
        calls.push({ type: 'thread.archive' });
        return { value: { sequence: 0 } };
      }
      if (tag === 'orchestration.dispatchCommand' && payload?.type === 'thread.fork') {
        const source = threads.find((thread) => thread.id === payload.sourceThreadId);
        if (!source || !payload.sideChat) return { error: 'Fixture forks are side chats of a known thread.' };
        const now = new Date().toISOString();
        // A side chat starts from its source's history; a drawing job has none.
        threads.push({ ...source, archivedAt: null, id: payload.targetThreadId, title: payload.title ?? 'Side chat', status: 'idle', activityRunStatus: null, activeRunId: null, latestRunId: null,
          latestRunCompletedAt: null, lastVisitedAt: now, createdAt: now, updatedAt: now, lineage: { parentThreadId: source.id, relationshipToParent: 'fork', rootThreadId: source.lineage.rootThreadId, sideChat: true } });
        items.set(payload.targetThreadId, []); runs.set(payload.targetThreadId, []);
        if (source.title !== AVATAR_DRAWING_JOB) items.set(payload.targetThreadId, [...(items.get(source.id) ?? [])]);
        calls.push({ type: 'thread.fork', title: payload.title, sourceThreadId: source.id, history: items.get(payload.targetThreadId)!.length });
        return { value: { sequence: 0 } };
      }
      if (tag === 'orchestration.dispatchCommand' && payload?.type === 'thread.delete') {
        const index = threads.findIndex((thread) => thread.id === payload.threadId);
        if (index < 0 || !(threads[index].lineage.sideChat || threads[index].title === AVATAR_DRAWING_JOB)) return { error: 'Fixture deletes only side chats and drawing jobs.' };
        // As in T3, deleting a thread takes its side chats with it.
        for (const doomed of threads.filter((thread) => thread.id === payload.threadId || thread.lineage.parentThreadId === payload.threadId).map((thread) => thread.id)) {
          threads.splice(threads.findIndex((thread) => thread.id === doomed), 1); items.delete(doomed); runs.delete(doomed);
        }
        calls.push({ type: 'thread.delete' });
        return { value: { sequence: 0 } };
      }
      return null;
    },
    /**
     * After a drawing request lands: a valid definition. "broken" answers with an invalid one first and a
     * valid one when asked to fix it; "hopeless" never validates. "slow" takes 30s; the rest take 6s.
     */
    afterMessage(thread: FixtureThread, text: string, publish: () => void) {
      if (!thread.title.startsWith(AVATAR_DRAWING_TITLE)) return;
      calls.push({ type: 'message.dispatch', threadId: thread.id, text, model: thread.modelSelection });
      const option = Number(text.match(/option (\d+) of/)?.[1] ?? 1);
      const fixing = /didn't validate/.test(text);
      const broken = /hopeless/i.test(thread.title) || (/broken/i.test(thread.title) && !fixing);
      const drawn = { ...AVATAR_DRAWN, id: `${AVATAR_DRAWN.id}-${option}`, name: ['Acorn', 'Tall acorn', 'Round acorn'][option - 1] ?? 'Acorn' };
      const reply = broken
        ? 'Here it is:\n\n```json\n' + JSON.stringify({ ...drawn, body: { path: '' } }) + '\n```'
        : 'Here it is:\n\n```json\n' + JSON.stringify(drawn, null, 2) + '\n```';
      setTimeout(() => finish(thread, reply, publish), /slow/i.test(thread.title) ? 30000 : fixing ? 2000 : 6000);
    },
    model,
  };
}

// Bots doing different things at once, for the activity-driven avatars. Alpha walks
// through a scripted turn (thinking, searching, writing, a command, a subagent, a
// message to another Bot) and finishes; the rest hold one shell-level activity, and
// Theta keeps waking up for short runs. Synthetic shells and items only.
export const ACTIVITY_SAMPLES = [
  { slug: 'alpha', name: 'Alpha', shape: 't3', color: 'purple', primary: true },
  { slug: 'beta', name: 'Beta', shape: 'clover', color: 'orange', primary: false },
  { slug: 'gamma', name: 'Gamma', shape: 'sparkle', color: 'purple', primary: false },
  { slug: 'delta', name: 'Delta', shape: 'hex', color: 'blue', primary: false },
  { slug: 'epsilon', name: 'Epsilon', shape: 'pebble', color: 'pink', primary: false },
  { slug: 'zeta', name: 'Zeta', shape: 'object:ghost', color: 'teal', primary: false },
  { slug: 'eta', name: 'Eta', shape: 'drop', color: 'green', primary: false },
  { slug: 'theta', name: 'Theta', shape: 'cloud', color: 'teal', primary: false },
  { slug: 'iota', name: 'Iota', shape: 't3', color: 'purple', primary: false },
  { slug: 'kappa', name: 'Kappa', shape: 'squircle', color: 'blue', primary: false },
  { slug: 'lambda', name: 'Lambda', shape: 'flower', color: 'pink', primary: false },
  { slug: 'mu', name: 'Mu', shape: 'gem', color: 'orange', primary: false },
  { slug: 'nu', name: 'Nu', shape: 't3', color: 'purple', primary: false },
  { slug: 'xi', name: 'Xi', shape: 'star', color: 'green', primary: false },
];
export const ACTIVITY_STEP_MS = 2600;
const ALPHA_SCRIPT: [string, { title?: string; [key: string]: unknown }][] = [
  ['reasoning', {}],
  ['web_search', { query: 'generic sample query' }],
  ['assistant_message', { text: 'Writing a generic sample reply…', streaming: true }],
  ['command_execution', { command: 'echo sample', title: 'Run a sample command' }],
  ['subagent', { title: 'Sample helper' }],
  ['dynamic_tool', { toolName: 'mcp__t3-code__t3_thread_send' }],
  ['file_change', { fileName: 'notes/sample.md' }],
  ['done', {}],
  ['rest', {}],
];

export function seedActivity({ threads, items, runs, model }: { threads: FixtureThread[]; items: Map<string, FixtureItem[]>; runs: Map<string, FixtureRun[]>; model: FixtureModel }) {
  const now = () => new Date().toISOString();
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
  const thread = (slug: string) => threads.find((t) => t.id === `thread-${slug}`)!;
  const start = (t: FixtureThread, status = 'running') => {
    const list = runs.get(t.id)!;
    const run: FixtureRun = { id: `${t.id}-run-${list.length + 1}`, ordinal: list.length + 1, status, requestedAt: now(), startedAt: now(), completedAt: null, modelSelection: model };
    list.push(run);
    Object.assign(t, { status, activityRunStatus: status, activeRunId: run.id, latestRunId: run.id, latestRunStartedAt: run.startedAt, latestRunCompletedAt: null, updatedAt: now() });
    return run;
  };
  const finish = (t: FixtureThread, startedAgo = 0) => {
    const at = now();
    for (const run of runs.get(t.id)!) if (run.status === 'running') Object.assign(run, { status: 'completed', completedAt: at });
    Object.assign(t, { status: 'completed', activityRunStatus: null, activeRunId: null, latestRunCompletedAt: at, lastVisitedAt: at, updatedAt: at,
      ...(startedAgo ? { latestRunStartedAt: ago(startedAgo) } : {}) });
  };
  for (const t of threads) Object.assign(t, { lastVisitedAt: now(), latestRunCompletedAt: ago(5 * 60_000), latestUserMessageAt: ago(5 * 60_000), createdAt: ago(86_400_000), status: 'completed' });
  for (const slug of ['beta', 'iota', 'kappa', 'lambda', 'mu', 'nu', 'xi', 'zeta']) start(thread(slug));
  start(thread('gamma'), 'starting');
  Object.assign(thread('delta'), { pendingRuntimeRequest: { id: 'fixture-activity-question', kind: 'user_input', blocking: true } });
  Object.assign(thread('epsilon'), { status: 'failed', lastErrorClass: 'provider_error', lastError: 'Synthetic failure for the fixture.' });
  Object.assign(thread('eta'), { latestRunCompletedAt: ago(40 * 60_000), latestUserMessageAt: ago(40 * 60_000) });
  Object.assign(thread('theta'), { latestRunCompletedAt: ago(5 * 3_600_000), latestUserMessageAt: ago(5 * 3_600_000) });

  const alpha = thread('alpha');
  let step = 0;
  let run: FixtureRun | null = null;
  let thetaTicks = 0;
  const advance = () => {
    const [type, extra] = ALPHA_SCRIPT[step % ALPHA_SCRIPT.length];
    const list = items.get(alpha.id)!;
    for (const item of list) if (item.runId && item.status === 'running') Object.assign(item, { status: 'completed', streaming: false, completedAt: now(), updatedAt: now() });
    if (type === 'done') { finish(alpha, 3 * 60_000); run = null; }
    else if (type !== 'rest') {
      if (!run) run = start(alpha);
      const ordinal = Math.max(0, ...list.map((item) => item.ordinal)) + 1;
      list.push({ id: `${alpha.id}-activity-${ordinal}`, threadId: alpha.id, ordinal, type, runId: run.id, status: 'running', title: extra.title ?? null,
        startedAt: now(), completedAt: null, updatedAt: now(), parentItemId: null, ...extra });
    }
    step++;
    // Theta sleeps, wakes for a short run, cheers, and nods off again.
    const theta = thread('theta');
    thetaTicks++;
    if (thetaTicks % 6 === 2) start(theta);
    else if (thetaTicks % 6 === 4) finish(theta);
    else if (thetaTicks % 6 === 0) Object.assign(theta, { latestRunCompletedAt: ago(5 * 3_600_000), latestUserMessageAt: ago(5 * 3_600_000), status: 'completed' });
  };
  advance();
  return {
    start(publish: () => void) {
      const timer = setInterval(() => { advance(); publish(); }, ACTIVITY_STEP_MS);
      timer.unref?.();
      return () => clearInterval(timer);
    },
  };
}

// T3 0.1.8 nightly: 4-byte little-endian options length, options JSON, then 16 kHz mono Float32 PCM (at most 5 minutes).
const SPEECH_MAX_PCM = 16000 * 4 * 300;
export const FIXTURE_SPEECH_MAX_BODY = SPEECH_MAX_PCM + 128000 + 4;
function fixtureTranscribe(body: Buffer): { status: number; body: Record<string, unknown> } {
  const invalid = { status: 400, body: { _tag: 'EnvironmentRequestInvalidError', code: 'invalid_request', reason: 'invalid_audio', traceId: 'fixture' } };
  if (body.length < 4) return invalid;
  const length = body.readUInt32LE(0);
  if (length > 128000 || 4 + length >= body.length) return invalid;
  let options: Record<string, unknown>;
  try { options = JSON.parse(body.subarray(4, 4 + length).toString('utf8')); } catch { return invalid; }
  const keys = ['speechLanguage', 'speechTranslateToEnglish', 'speechCustomWords', 'speechRemoveFillerWords'];
  if (!options || typeof options !== 'object' || keys.some((key) => !(key in options)) || typeof options.speechLanguage !== 'string' || options.speechLanguage.length < 2) return invalid;
  const pcm = body.length - 4 - length;
  if (pcm % 4 || pcm > SPEECH_MAX_PCM) return invalid;
  return { status: 200, body: { text: `Fixture transcript: ${(pcm / 4 / 16000).toFixed(1)} seconds in ${options.speechLanguage}` } };
}

/**
 * The release-notes scenario: a GitHub-API-shaped release list the gateway reads through
 * THREEBOT_RELEASES_URL. The next version has notes in scripts/release-notes.mts's format (T3 Code's);
 * the running one has GitHub's own generated notes, as Threebot's releases had before. Invented content,
 * except the logins, which are this repo's real contributors so their avatars load.
 */
export function fixtureReleases(current: string) {
  const [major, minor, patch] = current.split(/[.-]/).map(Number);
  const next = `${major}.${minor}.${patch + 1}`, previous = `${major}.${minor}.${Math.max(0, patch - 1)}`;
  const repo = 'https://github.com/RokaSwK/threebot';
  const pr = (n: number) => `${repo}/pull/${n}`;
  const asset = (v: string, name: string) => ({ name, browser_download_url: `http://127.0.0.1:9/v${v}/${name}` });
  const release = (v: string, body: string, publishedAt: string) => ({ tag_name: `v${v}`, draft: false, prerelease: false, body, html_url: `${repo}/releases/tag/v${v}`, published_at: publishedAt,
    assets: [asset(v, `threebot-${v}.tar.gz`), asset(v, 'SHA256SUMS')] });
  const nextBody = `**v${next}** · 9 changes from 4 contributors

- **Release notes in the app.** See what changed in an update, with who made each change.
- **Web Push.** Get a notification on your phone when a Bot needs you.
- **Mac app.** Run Threebot in its own window on your Mac (beta).

### Plus 6 more changes.

<details>
<summary>Full changelog</summary>

## What's Changed
* Show release notes with their authors in the app by @RokaSwK in ${pr(59)}
* Add Web Push notifications by @cristianbdev in ${pr(41)}
* Mac app: Threebot in a native window by @mertbozkir in ${pr(43)}
* Keep the model picker's favorites per machine by @cristianbdev in ${pr(52)}
* Bump vite from 7.1.0 to 7.1.2 by @dependabot in ${pr(53)}
* Fix the update chip on narrow sidebars by @RokaSwK in ${pr(54)}
* <img src=x onerror="alert('release body')">Release bodies are untrusted text by @RokaSwK in ${pr(55)}
* Show linked machines' threads in search by @t3dotgg in ${pr(56)}
* Threebot ${next} by @RokaSwK in ${pr(57)}

## New Contributors
* @t3dotgg made their first contribution in ${pr(56)}

**Full Changelog**: ${repo}/compare/v${current}...v${next}

</details>
`;
  const currentBody = `## What's Changed
* Landing: show the GitHub star count by @RokaSwK in ${pr(35)}
* Add durable Bot memory by @cristianbdev in ${pr(39)}
* Make memory a Markdown file that the Bot and you both edit by @RokaSwK in ${pr(46)}
* Threebot ${current} by @RokaSwK in ${pr(48)}

**Full Changelog**: ${repo}/compare/v${previous}...v${current}`;
  return {
    next, previous,
    list: [release(next, nextBody, new Date(Date.now() - 2 * 3600_000).toISOString()), release(current, currentBody, new Date(Date.now() - 3 * 86400_000).toISOString())],
  };
}
