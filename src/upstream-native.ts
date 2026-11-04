// Native upstream REST client (portable, dependency-free).
//
// PROVENANCE (MIT, OpenBot at exact pin 6bfee780c8e8d05141375ea55ebde33eefb3dbc0;
// full notice in phone-app/THIRD-PARTY-NOTICES.md):
// - DTOs below are ADAPTED (not verbatim) from `mobile/src/api.ts` at that
//   pin (Bot, Conversation->NativeChannel, TranscriptMessage, ApprovalInbox,
//   CheckInItem, StartedItem, TaskStatus, BotTask, Routine, Memory,
//   RuleBehaviour, ApprovalRule, BEHAVIOUR_LABELS): shapes mirror the source,
//   names adjusted to this codebase, strict validation added.
// - Endpoint contracts mirror `server/src/delivery/routes.ts` at the same pin
//   (all behind `requireUser`; `ownedScope` enforces per-owner channel access):
//     GET    /api/agents                                    -> bot roster
//     POST   /api/channels/            {agentIds:[...]}     -> {channel}
//     GET    /api/channels/:id                              -> {channel}
//     GET    /api/delivery/conversations                     -> {conversations,nextCursor}
//     GET    /api/delivery/conversations/:id/history?agentId= -> {history}
//     POST   /api/delivery/conversations/:id/messages
//            strict {agentId, text, externalId:UUID}         -> 202 receiveNative
//     POST   /api/delivery/devices {id,token,projectId,platform} / DELETE .../:id
//     GET    /api/proactive/suggestions (+ :id/start|:id/dismiss)
//
// The phone NEVER talks to upstream directly. Every request goes through the
// paired home's own authority (`{homeBaseUrl}/api/*`) via
// `PairedHomeClient.proxyNativeApi`, which authenticates with ONLY the home
// session bearer (`Authorization: Bearer <ht1_*>`, same as /v1/*) and never
// forwards upstream Cookies, private Intelligence gateway URLs, license keys,
// agent tokens, or model keys. The upstream mobile `api()` used
// `authClient.getCookie()` + `credentials: omit`; the Me adaptation replaces
// the Cookie with the ht1 bearer and keeps same-origin hardening
// (`redirect: 'error'` + final-URL origin check lives in the transport).
//
// The upstream owns agent graph, task queue, threads, memory, approvals and
// policies. The phone keeps a thin offline cache only; upstream history is
// the authority and local mirrors are never a second source of truth.

import { HomeClientError } from './errors.ts';

/** Exact upstream source pin this client mirrors (full SHA, MIT). */
export const UPSTREAM_NATIVE_PIN =
  '6bfee780c8e8d05141375ea55ebde33eefb3dbc0';
export const UPSTREAM_NATIVE_SOURCE = 'CopilotKit/OpenBot';
/** Exact upstream mobile file the DTOs are copied from. */
export const UPSTREAM_NATIVE_API_PATH = 'mobile/src/api.ts';
/** Exact upstream server file the route contracts mirror. */
export const UPSTREAM_NATIVE_ROUTES_PATH = 'server/src/delivery/routes.ts';

// ---------------------------------------------------------------------------
// DTOs verbatim from upstream mobile/src/api.ts (renamed only where the
// phone already owns the name: Conversation -> NativeChannel).
// ---------------------------------------------------------------------------

/** A Bot as `GET /api/agents` returns it. */
export interface NativeBot {
  id: string;
  name: string;
  title?: string;
  roleDescription?: string;
  mine: boolean;
  canManage: boolean;
}

export interface NativeBotLifecycle {
  paused: boolean;
  pausedAt: string | null;
}

/** Upstream channel (upstream `Conversation`): person + Bot(s) thread. */
export interface NativeChannel {
  id: string;
  name: string;
  agentIds: string[];
  active: boolean;
}

export interface NativeTranscriptMessage {
  id: string;
  role: string;
  content?: string | unknown[];
  toolCalls?: unknown[];
}

/**
 * Verified native approvals callsite (mobile/app/approvals.tsx at pin):
 *   GET  /api/approvals
 *     -> ApprovalInbox { requests, questions? } (requireUser, per-owner)
 *   POST /api/approvals/:id/decision
 *     { decision: "allow_once" | "allow_always" | "deny" } -> refresh inbox
 *   POST /api/approvals/questions/:id/respond
 *     { response: answers[id] } -> refresh inbox
 * Pending requests render Allow once / Always allow (hidden when the
 * request's policy source is "task": tasks ask before every change, rules
 * or not) / Deny. The phone MUST NOT substitute natural-language replies
 * for these explicit decisions (that would bypass upstream policy).
 */
export interface NativeApprovalInbox {
  requests: {
    id: string;
    botId?: string;
    toolRef?: string;
    status: string;
    effect?: string;
    scope?: string;
    preview?: unknown;
    action?: {
      botId: string;
      toolRef: string;
      effect: string;
      scope: string;
      args: unknown;
      target?: unknown;
      /** Why it asked. A check-in task's approval (`source` "task") offers no standing rule. */
      policy?: { source: string; reason: string };
    };
  }[];
  questions?: {
    id: string;
    question: string;
    why?: string;
    botId: string;
    channelId?: string;
  }[];
}

/** Exact decisions the upstream decision endpoint accepts. */
export type NativeApprovalDecision = 'allow_once' | 'allow_always' | 'deny';

const NATIVE_APPROVAL_DECISIONS: ReadonlySet<string> = new Set([
  'allow_once',
  'allow_always',
  'deny',
]);

/**
 * Something a Bot's check-in found that needs the person, as `GET /api/proactive/suggestions` lists
 * it (open ones only). `detail` says why it was raised; `sourceApp` is the app it was read in.
 */
export interface NativeCheckInItem {
  id: string;
  agentId: string;
  title: string;
  detail: string;
  sourceApp: string | null;
  sourceLink: string | null;
  createdAt: string;
}

/** What `POST /api/proactive/suggestions/:id/start` made of an item: a task in its own conversation. */
export interface NativeStartedItem {
  task: { id: string; channelId: string };
}

export type NativeTaskStatus =
  | 'needs_input'
  | 'working'
  | 'resolved'
  | 'failed'
  | 'ready_for_review';

/** A task started from an item, as `GET /api/tasks` lists it. */
export interface NativeBotTask {
  id: string;
  agentId: string;
  channelId: string;
  title: string;
  status: NativeTaskStatus;
  /** Why its turn couldn't finish, while failed. */
  failure: string | null;
  /** The last thing said in its conversation. */
  next: string | null;
  updatedAt: string;
}

export type NativeRoutineStatus =
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'waiting';

export interface NativeRoutine {
  id: string;
  agentId: string;
  /** Display text from the server; never parsed here. */
  schedule: string;
  timezone: string;
  instruction: string;
  channel: { id: string; name: string | null; gone: boolean };
  enabled: boolean;
  nextRunAt: string;
  lastRun: { status: NativeRoutineStatus | null; at: string | null } | null;
}

export interface NativeMemory {
  id: string;
  content: string;
  provenance: string;
  enabled: boolean;
  reviewState: 'unreviewed' | 'confirmed' | 'edited';
  formedBy: 'person' | 'import' | 'bot';
  updatedAt: string;
}

export type NativeRuleBehaviour = 'allow' | 'pre_approved' | 'ask' | 'hand_off';

export const NATIVE_BEHAVIOUR_LABELS: Record<NativeRuleBehaviour, string> = {
  allow: 'Take action without asking',
  pre_approved: 'Take action if pre-approved',
  ask: 'Ask before taking action',
  hand_off: 'Hand off to you',
};

export interface NativeApprovalRule {
  id: string;
  botId: string;
  toolRef: string;
  effect: string;
  scope: string;
  behaviour: NativeRuleBehaviour;
}

// ---------------------------------------------------------------------------
// Bounds mirrored from server zod schemas (routes.ts, channels/routes.ts).
// ---------------------------------------------------------------------------

/** Server: `text: z.string().trim().min(1).max(16_000)`. */
export const NATIVE_MESSAGE_MAX_CHARS = 16_000;
/** Server delivery list page; channels list clamps similarly. */
export const NATIVE_PAGE_LIMIT_MAX = 100;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MANAGED_CLOUD_RE = /copilotkit\.ai/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

// ---------------------------------------------------------------------------
// Strict response parsers: malformed upstream shapes are CONTRACT_MISMATCH,
// never guessed. Extra fields are ignored (server may add additive fields).
// ---------------------------------------------------------------------------

export function parseNativeBot(value: unknown): NativeBot | null {
  if (!isRecord(value)) return null;
  const id = asNonEmptyString(value['id']);
  const name = asNonEmptyString(value['name']);
  if (id === null || name === null) return null;
  if (typeof value['mine'] !== 'boolean') return null;
  if (typeof value['canManage'] !== 'boolean') return null;
  const bot: NativeBot = { id, name, mine: value['mine'], canManage: value['canManage'] };
  if (typeof value['title'] === 'string') bot.title = value['title'];
  if (typeof value['roleDescription'] === 'string') {
    bot.roleDescription = value['roleDescription'];
  }
  return bot;
}

export function parseNativeBotList(value: unknown): NativeBot[] | null {
  const list = isRecord(value) && Array.isArray(value['agents'])
    ? value['agents']
    : Array.isArray(value)
      ? value
      : null;
  if (!Array.isArray(list)) return null;
  if (list.length > 500) return null;
  const out: NativeBot[] = [];
  for (const entry of list) {
    const bot = parseNativeBot(entry);
    if (!bot) return null;
    out.push(bot);
  }
  return out;
}

export function parseNativeChannel(value: unknown): NativeChannel | null {
  if (!isRecord(value)) return null;
  const id = asNonEmptyString(value['id']);
  const name = typeof value['name'] === 'string' ? value['name'] : null;
  const agentIds = Array.isArray(value['agentIds'])
    ? value['agentIds']
    : Array.isArray(value['agent_ids'])
      ? value['agent_ids']
      : null;
  if (id === null || name === null || agentIds === null) return null;
  if (!agentIds.every((a): a is string => typeof a === 'string' && a.length > 0)) {
    return null;
  }
  if (typeof value['active'] !== 'boolean') return null;
  return { id, name, agentIds, active: value['active'] };
}

export function parseNativeChannelEnvelope(value: unknown): NativeChannel | null {
  if (!isRecord(value)) return null;
  return parseNativeChannel(value['channel']);
}

export function parseNativeConversationPage(value: unknown): {
  channels: NativeChannel[];
  nextCursor: string | null;
} | null {
  if (!isRecord(value)) return null;
  const raw = value['conversations'] ?? value['channels'];
  if (!Array.isArray(raw)) return null;
  if (raw.length > NATIVE_PAGE_LIMIT_MAX + 1) return null;
  const channels: NativeChannel[] = [];
  for (const entry of raw) {
    // Delivery list rows may be summaries; require at least id + agentIds.
    const channel = parseNativeChannel(entry);
    if (!channel) return null;
    channels.push(channel);
  }
  const nextCursor = value['nextCursor'] ?? value['next_cursor'] ?? null;
  if (nextCursor !== null && typeof nextCursor !== 'string') return null;
  return { channels, nextCursor };
}

export function parseNativeHistory(value: unknown): NativeTranscriptMessage[] | null {
  // Exact upstream callsite (mobile/app/conversation.tsx:51-60):
  //   api<{ history: TranscriptMessage[] | { messages: TranscriptMessage[] } }>
  //   const messages = Array.isArray(history.data?.history)
  //     ? history.data.history : history.data?.history.messages;
  // Support EXACTLY these two shapes; anything else is malformed.
  if (!isRecord(value)) return null;
  const raw = value['history'];
  const list: unknown = Array.isArray(raw)
    ? raw
    : isRecord(raw) && Array.isArray(raw['messages'])
      ? raw['messages']
      : null;
  if (!Array.isArray(list)) return null;
  if (list.length > 2000) return null;
  const out: NativeTranscriptMessage[] = [];
  for (const entry of list) {
    if (!isRecord(entry)) return null;
    const id = asNonEmptyString(entry['id']);
    const role = asNonEmptyString(entry['role']);
    if (id === null || role === null) return null;
    const message: NativeTranscriptMessage = { id, role };
    if ('content' in entry) {
      const content = entry['content'];
      if (typeof content !== 'string' && !Array.isArray(content)) return null;
      message.content = content;
    }
    if (entry['toolCalls'] !== undefined) {
      if (!Array.isArray(entry['toolCalls'])) return null;
      message.toolCalls = entry['toolCalls'];
    }
    out.push(message);
  }
  return out;
}

/**
 * Strict `ApprovalInbox` parser (api.ts DTO verbatim). Pending-only
 * filtering happens at render (approvals.tsx filters status === "pending").
 */
export function parseNativeApprovalInbox(value: unknown): NativeApprovalInbox | null {
  if (!isRecord(value)) return null;
  const requests = value['requests'];
  if (!Array.isArray(requests)) return null;
  if (requests.length > 200) return null;
  for (const request of requests) {
    if (!isRecord(request)) return null;
    if (asNonEmptyString(request['id']) === null) return null;
    if (typeof request['status'] !== 'string') return null;
  }
  const questions = value['questions'];
  if (questions !== undefined) {
    if (!Array.isArray(questions)) return null;
    if (questions.length > 200) return null;
    for (const question of questions) {
      if (!isRecord(question)) return null;
      if (asNonEmptyString(question['id']) === null) return null;
      if (asNonEmptyString(question['question']) === null) return null;
      if (asNonEmptyString(question['botId']) === null) return null;
    }
  }
  return value as unknown as NativeApprovalInbox;
}

export function parseNativeApprovalDecision(value: unknown): NativeApprovalDecision | null {
  return typeof value === 'string' && NATIVE_APPROVAL_DECISIONS.has(value)
    ? (value as NativeApprovalDecision)
    : null;
}

const NATIVE_TASK_STATUSES: ReadonlySet<string> = new Set([
  'needs_input',
  'working',
  'resolved',
  'failed',
  'ready_for_review',
]);

/**
 * Strict `BotTask` parser ("as `GET /api/tasks` lists it", api.ts).
 * Unknown extra fields are ignored; wrong status/ids are CONTRACT_MISMATCH.
 */
export function parseNativeBotTask(value: unknown): NativeBotTask | null {
  if (!isRecord(value)) return null;
  const id = asNonEmptyString(value['id']);
  const agentId = asNonEmptyString(value['agentId']);
  const channelId = asNonEmptyString(value['channelId']);
  const title = typeof value['title'] === 'string' ? value['title'] : null;
  const status = typeof value['status'] === 'string' ? value['status'] : null;
  const updatedAt = typeof value['updatedAt'] === 'string' ? value['updatedAt'] : null;
  if (
    id === null ||
    agentId === null ||
    channelId === null ||
    title === null ||
    updatedAt === null
  ) {
    return null;
  }
  if (status === null || !NATIVE_TASK_STATUSES.has(status)) return null;
  const task: NativeBotTask = {
    id,
    agentId,
    channelId,
    title,
    status: status as NativeTaskStatus,
    failure: typeof value['failure'] === 'string' ? value['failure'] : null,
    next: typeof value['next'] === 'string' ? value['next'] : null,
    updatedAt,
  };
  return task;
}

// ---------------------------------------------------------------------------
// Transport: the phone sends ONLY the home bearer on the SAME authority.
// Implemented by PairedHomeClient.proxyNativeApi (token never leaves it) or
// by a fixture in tests. Cookie-based upstream sessions are never forged.
// ---------------------------------------------------------------------------

export interface NativeTransport {
  request(
    path: string,
    init: { method: string; body?: Record<string, unknown>; signal?: AbortSignal },
  ): Promise<unknown>;
}

/** Paths the phone may call through the home proxy (exact upstream API). */
export const NATIVE_ROUTES = {
  agents: '/api/agents',
  channels: '/api/channels/',
  channel: (id: string) => `/api/channels/${id}`,
  conversations: '/api/delivery/conversations',
  history: (id: string, agentId: string) =>
    `/api/delivery/conversations/${encodeURIComponent(id)}/history?agentId=${encodeURIComponent(agentId)}`,
  messages: (id: string) => `/api/delivery/conversations/${id}/messages`,
  devices: '/api/delivery/devices',
  device: (id: string) => `/api/delivery/devices/${id}`,
  // Verified in server/src/tasks/routes.ts (requireUser, owner-scoped;
  // "A task's page is its conversation, where the person replies as in any
  // other"). Approvals/proactive answer routes are NOT in the verified
  // sparse tree, so the phone sends no legacy API for them: replies in the
  // conversation are the answer path; otherwise the home app decides.
  tasks: '/api/tasks',
  task: (id: string) => `/api/tasks/${id}`,
  taskResolve: (id: string) => `/api/tasks/${id}/resolve`,
  taskReopen: (id: string) => `/api/tasks/${id}/reopen`,
  taskAgain: (id: string) => `/api/tasks/${id}/again`,
  // Verified mobile/app/approvals.tsx at pin (requireUser, per-owner actor).
  approvals: '/api/approvals',
  approvalDecision: (id: string) => `/api/approvals/${id}/decision`,
  questionRespond: (id: string) => `/api/approvals/questions/${id}/respond`,
} as const;

export interface NativeSendInput {
  agentId: string;
  text: string;
  /** UUID idempotency key (server: `externalId: z.string().uuid()`). */
  externalId?: string;
  generateId?: () => string;
}

function requireAgentId(agentId: string): void {
  if (!agentId || agentId.trim().length === 0) {
    throw new HomeClientError('INVALID_INPUT', 'Choose an accessible Bot for your conversation.');
  }
  if (agentId.length > 200) {
    throw new HomeClientError('INVALID_INPUT', 'The Bot id is not valid.');
  }
}

function requireChannelId(channelId: string): void {
  if (!channelId || channelId.trim().length === 0 || channelId.includes('..')) {
    throw new HomeClientError('INVALID_INPUT', 'The conversation id is not valid.');
  }
  if (channelId.length > 300) {
    throw new HomeClientError('INVALID_INPUT', 'The conversation id is not valid.');
  }
}

/**
 * Validate the paired-home base URL for native calls: same immutable paired
 * authority, no credentials/query, https except loopback http, never
 * managed-cloud. Mirrors the headless resolver's hardening without any
 * `/api/copilotkit` mount (native REST needs none).
 */
export function resolveUpstreamNativeBase(homeBaseUrl: string): string {
  const trimmed = homeBaseUrl?.trim() ?? '';
  if (!trimmed) {
    throw new HomeClientError(
      'UPSTREAM_NOT_CONFIGURED',
      'Full agent mode is not configured: no paired home URL. Pair a home first; managed cloud is never used.',
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new HomeClientError('INVALID_INPUT', 'The paired home URL is not a valid URL.');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new HomeClientError(
      'INVALID_INPUT',
      'Use the public home URL without credentials or query parameters.',
    );
  }
  if (MANAGED_CLOUD_RE.test(parsed.host) || MANAGED_CLOUD_RE.test(trimmed)) {
    throw new HomeClientError(
      'INVALID_INPUT',
      'Managed-cloud conversation storage is not used. Full mode runs on the paired home only.',
    );
  }
  if (parsed.protocol === 'http:') {
    const loopback =
      parsed.hostname === 'localhost' ||
      parsed.hostname === '127.0.0.1' ||
      parsed.hostname === '::1' ||
      parsed.hostname.endsWith('.localhost');
    if (!loopback) {
      throw new HomeClientError('INVALID_INPUT', 'Full agent mode requires HTTPS for non-local homes.');
    }
  } else if (parsed.protocol !== 'https:') {
    throw new HomeClientError(
      'INVALID_INPUT',
      'The paired home URL must be https (http loopback only for local development).',
    );
  }
  return parsed.origin;
}

export class UpstreamNativeClient {
  private readonly transport: NativeTransport;

  constructor(transport: NativeTransport) {
    this.transport = transport;
  }

  /** GET /api/agents — the accessible bot roster (requireUser, per-owner). */
  async listAgents(signal?: AbortSignal): Promise<NativeBot[]> {
    const raw = await this.transport.request(NATIVE_ROUTES.agents, {
      method: 'GET',
      ...(signal ? { signal } : {}),
    });
    const bots = parseNativeBotList(raw);
    if (!bots) {
      throw new HomeClientError(
        'CONTRACT_MISMATCH',
        'The bot roster had an unexpected shape.',
      );
    }
    return bots;
  }

  /** POST /api/channels/ — create the conversation for these Bot(s). */
  async createChannel(agentIds: string[], signal?: AbortSignal): Promise<NativeChannel> {
    const clean = [...new Set(agentIds.map((a) => a.trim()).filter((a) => a.length > 0))];
    if (clean.length === 0) {
      throw new HomeClientError('INVALID_INPUT', 'Choose at least one accessible Bot.');
    }
    if (clean.some((a) => a.length > 200)) {
      throw new HomeClientError('INVALID_INPUT', 'A Bot id is not valid.');
    }
    const raw = await this.transport.request(NATIVE_ROUTES.channels, {
      method: 'POST',
      body: { agentIds: clean },
      ...(signal ? { signal } : {}),
    });
    const channel = parseNativeChannelEnvelope(raw) ?? parseNativeChannel(raw);
    if (!channel) {
      throw new HomeClientError(
        'CONTRACT_MISMATCH',
        'Channel creation had an unexpected shape.',
      );
    }
    return channel;
  }

  /** GET /api/channels/:id — single channel (access-checked upstream). */
  async getChannel(channelId: string, signal?: AbortSignal): Promise<NativeChannel> {
    requireChannelId(channelId);
    const raw = await this.transport.request(NATIVE_ROUTES.channel(channelId), {
      method: 'GET',
      ...(signal ? { signal } : {}),
    });
    const channel = parseNativeChannelEnvelope(raw) ?? parseNativeChannel(raw);
    if (!channel) {
      throw new HomeClientError(
        'CONTRACT_MISMATCH',
        'The channel detail had an unexpected shape.',
      );
    }
    return channel;
  }

  /** GET /api/delivery/conversations — paged channel list. */
  async listConversations(
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<{ channels: NativeChannel[]; nextCursor: string | null }> {
    const path =
      cursor && cursor.length > 0
        ? `${NATIVE_ROUTES.conversations}?cursor=${encodeURIComponent(cursor)}`
        : NATIVE_ROUTES.conversations;
    const raw = await this.transport.request(path, {
      method: 'GET',
      ...(signal ? { signal } : {}),
    });
    const page = parseNativeConversationPage(raw);
    if (!page) {
      throw new HomeClientError(
        'CONTRACT_MISMATCH',
        'The conversation list had an unexpected shape.',
      );
    }
    return page;
  }

  /**
   * GET delivery history — the upstream-authoritative transcript for
   * (channelId, agentId). `ownedScope` is enforced upstream per owner.
   */
  async getHistory(
    channelId: string,
    agentId: string,
    signal?: AbortSignal,
  ): Promise<NativeTranscriptMessage[]> {
    requireChannelId(channelId);
    requireAgentId(agentId);
    const raw = await this.transport.request(
      NATIVE_ROUTES.history(channelId, agentId),
      { method: 'GET', ...(signal ? { signal } : {}) },
    );
    const history = parseNativeHistory(raw);
    if (!history) {
      throw new HomeClientError(
        'CONTRACT_MISMATCH',
        'The conversation history had an unexpected shape.',
      );
    }
    return history;
  }

  /**
   * POST native delivery message — strict `{agentId, text, externalId:UUID}`,
   * answered 202 via the real upstream router/worker (`receiveNative`).
   * The externalId is the UUID idempotency key: reuse the SAME key across
   * network retries, never across messages.
   */
  async sendNativeMessage(
    channelId: string,
    input: NativeSendInput,
    signal?: AbortSignal,
  ): Promise<{ accepted: boolean; externalId: string }> {
    requireChannelId(channelId);
    requireAgentId(input.agentId);
    const text = input.text.trim();
    if (!text) {
      throw new HomeClientError('INVALID_INPUT', 'Message text is empty.');
    }
    if (text.length > NATIVE_MESSAGE_MAX_CHARS) {
      throw new HomeClientError(
        'INVALID_INPUT',
        `Messages are limited to ${NATIVE_MESSAGE_MAX_CHARS} characters.`,
      );
    }
    const externalId = (input.externalId ?? input.generateId?.() ?? '').trim();
    if (!isUuid(externalId)) {
      throw new HomeClientError(
        'INVALID_INPUT',
        'The message idempotency key must be a UUID.',
      );
    }
    await this.transport.request(NATIVE_ROUTES.messages(channelId), {
      method: 'POST',
      body: { agentId: input.agentId, text, externalId },
      ...(signal ? { signal } : {}),
    });
    return { accepted: true, externalId };
  }

  /**
   * GET /api/tasks — the person's own tasks (verified tasks/routes.ts).
   * Each entry matches the mobile `BotTask` DTO ("as `GET /api/tasks`
   * lists it"): id/agentId/channelId/title/status/failure/next/updatedAt.
   */
  async listNativeTasks(signal?: AbortSignal): Promise<NativeBotTask[]> {
    const raw = await this.transport.request(NATIVE_ROUTES.tasks, {
      method: 'GET',
      ...(signal ? { signal } : {}),
    });
    if (!isRecord(raw) || !Array.isArray(raw['tasks'])) {
      throw new HomeClientError(
        'CONTRACT_MISMATCH',
        'The task list had an unexpected shape.',
      );
    }
    const out: NativeBotTask[] = [];
    for (const entry of raw['tasks']) {
      const task = parseNativeBotTask(entry);
      if (!task) {
        throw new HomeClientError(
          'CONTRACT_MISMATCH',
          'A task entry had an unexpected shape.',
        );
      }
      out.push(task);
    }
    return out;
  }

  /** GET /api/tasks/:id — one task (`{ task }` envelope). */
  async getNativeTask(taskId: string, signal?: AbortSignal): Promise<NativeBotTask> {
    if (!taskId || taskId.includes('..')) {
      throw new HomeClientError('INVALID_INPUT', 'The task id is not valid.');
    }
    const raw = await this.transport.request(NATIVE_ROUTES.task(taskId), {
      method: 'GET',
      ...(signal ? { signal } : {}),
    });
    const task = isRecord(raw) ? parseNativeBotTask(raw['task']) : null;
    if (!task) {
      throw new HomeClientError(
        'CONTRACT_MISMATCH',
        'The task detail had an unexpected shape.',
      );
    }
    return task;
  }

  /**
   * POST /api/tasks/:id/again — "Try again: the failed turn runs once more,
   * in the task's own conversation." Answered with the task as it stands.
   */
  async retryNativeTask(taskId: string, signal?: AbortSignal): Promise<NativeBotTask> {
    return this.mutateNativeTask(taskId, NATIVE_ROUTES.taskAgain(taskId), signal);
  }

  /** POST /api/tasks/:id/resolve — mark the task resolved. */
  async resolveNativeTask(taskId: string, signal?: AbortSignal): Promise<NativeBotTask> {
    return this.mutateNativeTask(taskId, NATIVE_ROUTES.taskResolve(taskId), signal);
  }

  /** POST /api/tasks/:id/reopen — reopen the task. */
  async reopenNativeTask(taskId: string, signal?: AbortSignal): Promise<NativeBotTask> {
    return this.mutateNativeTask(taskId, NATIVE_ROUTES.taskReopen(taskId), signal);
  }

  private async mutateNativeTask(
    taskId: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<NativeBotTask> {
    if (!taskId || taskId.includes('..')) {
      throw new HomeClientError('INVALID_INPUT', 'The task id is not valid.');
    }
    const raw = await this.transport.request(path, {
      method: 'POST',
      ...(signal ? { signal } : {}),
    });
    const task = isRecord(raw) ? parseNativeBotTask(raw['task']) : null;
    if (!task) {
      throw new HomeClientError(
        'CONTRACT_MISMATCH',
        'The task update had an unexpected shape.',
      );
    }
    return task;
  }

  /**
   * GET /api/approvals — the current user's personal inbox across their
   * chats (the DTO carries no channelId on requests, so the phone labels
   * it as the personal inbox, never guessing channel ownership).
   */
  async getNativeApprovals(signal?: AbortSignal): Promise<NativeApprovalInbox> {
    const raw = await this.transport.request(NATIVE_ROUTES.approvals, {
      method: 'GET',
      ...(signal ? { signal } : {}),
    });
    const inbox = parseNativeApprovalInbox(raw);
    if (!inbox) {
      throw new HomeClientError(
        'CONTRACT_MISMATCH',
        'The approvals inbox had an unexpected shape.',
      );
    }
    return inbox;
  }

  /**
   * POST /api/approvals/:id/decision — explicit allow/deny. Only the three
   * verified decision strings are ever sent; anything else is INVALID_INPUT
   * client-side (never a natural-language bypass of upstream policy).
   */
  async decideNativeApproval(
    requestId: string,
    decision: NativeApprovalDecision,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!requestId || requestId.includes('..')) {
      throw new HomeClientError('INVALID_INPUT', 'The request id is not valid.');
    }
    if (parseNativeApprovalDecision(decision) === null) {
      throw new HomeClientError('INVALID_INPUT', 'The approval decision is not valid.');
    }
    await this.transport.request(NATIVE_ROUTES.approvalDecision(requestId), {
      method: 'POST',
      body: { decision },
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * POST /api/approvals/questions/:id/respond — explicit answer to a Bot's
   * question (`{ response }`, approvals.tsx: `answers[id] ?? ""`).
   */
  async respondNativeQuestion(
    questionId: string,
    response: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!questionId || questionId.includes('..')) {
      throw new HomeClientError('INVALID_INPUT', 'The question id is not valid.');
    }
    await this.transport.request(NATIVE_ROUTES.questionRespond(questionId), {
      method: 'POST',
      body: { response },
      ...(signal ? { signal } : {}),
    });
  }
}

/**
 * Scope-fenced native session: roster/channel cache + generation fencing.
 * Owns no network code itself; every call goes through the injected
 * `UpstreamNativeClient`, so tests prove the phone uses the real native
 * endpoints. `resetScope()` MUST be called on logout/unpair/revoke/
 * device-revoke/account-switch; late callbacks after a reset never publish
 * (callers fence with `shouldPublish`).
 */
export class UpstreamNativeScope {
  private generation = 0;
  private scopeKey: string | null = null;
  private bots: NativeBot[] | null = null;
  private readonly channels = new Map<string, NativeChannel>();

  /** Bind this scope (call after enrollment/auth resolves). */
  bindScope(scopeKey: string): void {
    if (this.scopeKey !== scopeKey) {
      this.resetScope('scope-changed');
      this.scopeKey = scopeKey;
    }
  }

  capture(): { generation: number; scopeKey: string } {
    return { generation: this.generation, scopeKey: this.scopeKey ?? 'null' };
  }

  /** False for any callback captured before the latest reset/scope change. */
  shouldPublish(captured: { generation: number; scopeKey: string }): boolean {
    return (
      captured.generation === this.generation &&
      captured.scopeKey === (this.scopeKey ?? 'null')
    );
  }

  noteBots(bots: NativeBot[]): void {
    this.bots = bots;
  }

  cachedBots(): NativeBot[] | null {
    return this.bots;
  }

  /** Home conversation -> upstream channel (home is source authority). */
  noteChannel(homeConversationId: string, channel: NativeChannel): void {
    if (!homeConversationId || !channel?.id) return;
    this.channels.set(homeConversationId, channel);
  }

  channelFor(homeConversationId: string): NativeChannel | null {
    return this.channels.get(homeConversationId) ?? null;
  }

  channelCount(): number {
    return this.channels.size;
  }

  /** Drop cached channels for deleted / out-of-scope conversations. */
  dropConversations(homeConversationIds: string[]): void {
    for (const id of homeConversationIds) this.channels.delete(id);
  }

  /**
   * Logout/unpair/revoke/device-revoke/account-switch: clear the roster and
   * channel caches. In-flight requests complete but their late callbacks
   * MUST NOT publish (fenced by generation). Upstream stays authoritative;
   * the next sync re-resolves from it.
   */
  resetScope(_reason: string): void {
    this.generation += 1;
    this.bots = null;
    this.channels.clear();
  }
}

/**
 * Map an upstream transcript message to displayable text. Only actual
 * user/assistant text counts: plain strings plus text blocks carrying
 * `text` or `output_text`. Tool-call payloads, reasoning internals, and
 * unknown block shapes map to null (never rendered as assistant answers,
 * never fabricated prose).
 */
const DISPLAY_TEXT_FIELDS = ['text', 'output_text'] as const;

export function transcriptText(message: NativeTranscriptMessage): string | null {
  const content = message.content;
  if (typeof content === 'string') {
    const clean = content.trim();
    return clean.length > 0 ? clean : null;
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === 'string') {
        if (block.trim()) parts.push(block.trim());
        continue;
      }
      if (block && typeof block === 'object') {
        for (const field of DISPLAY_TEXT_FIELDS) {
          const text = (block as Record<string, unknown>)[field];
          if (typeof text === 'string' && text.trim()) {
            parts.push(text.trim());
            break;
          }
        }
      }
    }
    return parts.length > 0 ? parts.join('\n') : null;
  }
  return null;
}

/**
 * Display roles. Only `user` and `assistant` render; `system`,
 * tool/reasoning internals, and unknown roles are filtered (never shown
 * as assistant answers).
 */
export function isDisplayRole(role: string): boolean {
  return role === 'user' || role === 'assistant';
}
