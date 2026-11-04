// Narrow pure/testable controller for native conversation turns.
//
// This is the ACTUAL controller path MeContext delegates to (not a
// standalone wrapper): link-metadata merging, scope-fenced channel
// resolution, and POST-202-then-poll send/sync. Every async boundary is
// fenced against the immutable captured scope, so a logout/re-pair while
// listAgents/createChannel/POST is pending can never publish the OLD
// family's channel, cache entry, message, or state under the NEW identity.
//
// Upstream sources: mobile/app/conversation.tsx at pin 6bfee78 (per-send
// Crypto.randomUUID externalId, immediate history refresh after POST) and
// server/src/delivery/routes.ts (strict message body, 202 receiveNative).

import { HomeClientError } from './errors.ts';
import {
  NATIVE_MESSAGE_MAX_CHARS,
  isDisplayRole,
  isUuid,
  transcriptText,
} from './upstream-native.ts';
import type {
  NativeTranscriptMessage,
  UpstreamNativeClient,
} from './upstream-native.ts';

/** Minimal native binding: upstream channel + the Bot it talks to. */
export interface ChannelBinding {
  channelId: string;
  agentId: string;
}

export interface ScopeCapture {
  generation: number;
  scopeKey: string;
}

/** Generation-fenced scope. `isCurrent` is false for any capture taken
 * before the latest reset/scope change (logout/unpair/revoke/switch). */
export interface ScopeFence {
  capture(): ScopeCapture;
  isCurrent(captured: ScopeCapture): boolean;
}

export type SleepFn = (ms: number) => Promise<void>;

/**
 * Merge link metadata WITHOUT loss: every previous field survives unless
 * explicitly overwritten. (P0 regression: dropping `upstreamAgentId` here
 * made every turn create a NEW upstream channel.)
 */
export function mergeLinkMetadata<T extends object>(
  prev: T | undefined,
  patch: Partial<T>,
): T {
  return { ...(prev ?? {} as Partial<T>), ...patch } as T;
}

/**
 * Idempotency key for a send: reuse the EXACT stored key on
 * retry/offline/response-loss; mint one UUID per NEW message only.
 */
export function externalIdFor(
  requestKey: string | undefined,
  generateId: () => string,
): string {
  const key = (requestKey ?? '').trim() || generateId().trim();
  if (!isUuid(key)) {
    throw new HomeClientError(
      'INVALID_INPUT',
      'The message idempotency key must be a UUID.',
    );
  }
  return key;
}

/** Display message (local cache shape; upstream stays authoritative). */
export interface DisplayMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: number;
}

/**
 * Upstream history -> display messages. Only `user`/`assistant` roles with
 * actual text render; system/tool/reasoning internals never become bubbles.
 */
export function toDisplayMessages(
  history: NativeTranscriptMessage[],
  now: number,
): DisplayMessage[] {
  const out: DisplayMessage[] = [];
  for (const item of history) {
    if (!isDisplayRole(item.role)) continue;
    const text = transcriptText(item);
    if (text === null) continue;
    out.push({
      id: item.id,
      role: item.role as 'user' | 'assistant',
      text,
      createdAt: now,
    });
  }
  return out;
}

function staleScope(): HomeClientError {
  return new HomeClientError(
    'UPSTREAM_SCOPE_RESET',
    'The scope changed during the upstream turn; the result was dropped.',
  );
}

/**
 * Per-scope + per-conversation singleflight for channel creation (review
 * item 2). Rapid parallel initial sends with no binding share ONE in-flight
 * promise, so they bind the SAME channel (transient dedup only — never a
 * second store; the upstream channel stays authoritative). Entries are
 * keyed by scopeKey + localId, so a scope change or a different
 * conversation never shares; deletion drops the entry.
 */
export class ChannelSingleflight {
  private readonly inflight = new Map<string, Promise<ChannelBinding>>();

  private key(scopeKey: string, localId: string): string {
    return `${scopeKey}\u0000${localId}`;
  }

  bind(
    scopeKey: string,
    localId: string,
    factory: () => Promise<ChannelBinding>,
  ): Promise<ChannelBinding> {
    const key = this.key(scopeKey, localId);
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const pending = factory().finally(() => {
      if (this.inflight.get(key) === pending) this.inflight.delete(key);
    });
    this.inflight.set(key, pending);
    return pending;
  }

  /** Drop a conversation's entry (delete/unpair/scope end). */
  drop(localId: string): void {
    for (const key of [...this.inflight.keys()]) {
      if (key.endsWith(`\u0000${localId}`)) this.inflight.delete(key);
    }
  }

  pendingCount(): number {
    return this.inflight.size;
  }
}

/**
 * Per-request double-tap gate for explicit decisions/answers: the first
 * tap acquires, concurrent taps on the same id are dropped. Acquisition is
 * bound to a caller generation (the scope generation at call time):
 * `release` only frees a lease held by the SAME generation, so a stale
 * finally after a scope change can never unlock a NEW scope's in-flight
 * decision for the same id — and React busy-state writes stay fenced by
 * the caller (no writes when stale). The UI disables the button from
 * mirrored state, but the gate itself is synchronous so the second tap in
 * the same frame is refused even before re-render.
 */
export class DecisionGate {
  private readonly busy = new Map<string, number | string | undefined>();

  tryAcquire(id: string, owner?: number | string): boolean {
    if (!id || this.busy.has(id)) return false;
    this.busy.set(id, owner);
    return true;
  }

  release(id: string, owner?: number | string): void {
    if (!this.busy.has(id)) return;
    if (owner !== undefined && this.busy.get(id) !== owner) return;
    this.busy.delete(id);
  }

  isBusy(id: string): boolean {
    return this.busy.has(id);
  }
}

/**
 * Terminal-work predicate for the foreground watch (review item 3): work
 * is pending while a needs_input/working/ready_for_review task exists for
 * the channel, a pending approval request exists, an unanswered question
 * exists, or the latest user message has no later assistant reply. The
 * phone never spends model calls here — it only re-reads history/tasks.
 */
export interface WatchSnapshotInput {
  history: NativeTranscriptMessage[];
  tasks: { id: string; status: string }[];
  pendingApprovalCount: number;
  unansweredQuestionCount: number;
}

export function isNativeWorkPending(input: WatchSnapshotInput): boolean {
  if (input.pendingApprovalCount > 0) return true;
  if (input.unansweredQuestionCount > 0) return true;
  for (const task of input.tasks) {
    if (
      task.status === 'needs_input' ||
      task.status === 'working' ||
      task.status === 'ready_for_review'
    ) {
      return true;
    }
  }
  let lastUserIndex = -1;
  for (let i = input.history.length - 1; i >= 0; i -= 1) {
    if (input.history[i].role === 'user') {
      lastUserIndex = i;
      break;
    }
  }
  if (lastUserIndex === -1) return false;
  for (let i = lastUserIndex + 1; i < input.history.length; i += 1) {
    const message = input.history[i];
    if (message.role === 'assistant' && transcriptText(message) !== null) {
      return false;
    }
  }
  return true;
}

/** Bounded foreground watch intervals: limited rate, backoff, ceiling. */
export const NATIVE_WATCH_INTERVALS_MS = [5000, 10000, 20000, 30000, 30000, 60000];

export interface WatchRunnerInput {
  fence: ScopeFence;
  wait: SleepFn;
  /**
   * One reconciliation pass: re-read history/tasks/inbox and publish when
   * the fence holds. Returns true when the watch may stop (terminal work
   * state reached). Throws UPSTREAM_SCOPE_RESET (or returns stale) when
   * the scope moved — the runner stops without further fetch/publish.
   */
  poll: () => Promise<boolean>;
  intervalsMs?: number[];
  onStale?: () => void;
}

export type WatchRunnerOutcome = 'settled' | 'ceiling' | 'stale';

/**
 * One active-conversation foreground watch (review item 3): sequential
 * bounded polls with backoff. Exactly one runner per conversation exists
 * (MeContext owns it); per-send watchers are never created. No model
 * spend — only history/task/inbox re-reads.
 */
export async function runNativeWatch(input: WatchRunnerInput): Promise<WatchRunnerOutcome> {
  const intervals = input.intervalsMs ?? NATIVE_WATCH_INTERVALS_MS;
  const captured = input.fence.capture();
  const live = (): boolean => input.fence.isCurrent(captured);
  for (let tick = 0; tick < intervals.length; tick += 1) {
    if (!live()) {
      input.onStale?.();
      return 'stale';
    }
    await input.wait(intervals[tick] ?? 30000);
    if (!live()) {
      input.onStale?.();
      return 'stale';
    }
    let done = false;
    try {
      done = await input.poll();
    } catch (error) {
      if (error instanceof HomeClientError && error.code === 'UPSTREAM_SCOPE_RESET') {
        input.onStale?.();
        return 'stale';
      }
      // Transient fetch failure: keep watching within the bound (the next
      // foreground/reconnect pass retries too). Do NOT publish the error as
      // terminal state.
      done = false;
    }
    if (!live()) {
      input.onStale?.();
      return 'stale';
    }
    if (done) return 'settled';
  }
  return 'ceiling';
}

export interface SendSyncInput {
  channelId: string;
  agentId: string;
  text: string;
  /** Stored key reused EXACTLY on retry; undefined only for a new message. */
  requestKey?: string;
  /** Message ids already displayed (server echo is not an answer). */
  knownIds?: ReadonlySet<string>;
  fence: ScopeFence;
  sleep: SleepFn;
  /** Bounded foreground poll attempts after the 202 (default 8). */
  pollAttempts?: number;
  /** Delay between history polls in ms (default 1500). */
  pollIntervalMs?: number;
}

export interface SendSyncResult {
  accepted: boolean;
  externalId: string;
  /** True when a NEW assistant text message appears in history. */
  answered: boolean;
  attempts: number;
  history: NativeTranscriptMessage[];
  /**
   * Ids of user-role messages in the final history that were absent from
   * the pre-send baseline. The server turns the accepted text into a turn
   * asynchronously (`receiveNative` only queues via `offerInbox`), and the
   * canonical message id is minted server-side (toolkit `run-turn` mints
   * `crypto.randomUUID()` unless the caller supplies the message) — so
   * externalId is NEVER assumed to equal the canonical id. Callers use this
   * set-difference (never text matching, which would collapse repeated
   * same-content sends with distinct UUIDs) to retire optimistic bubbles.
   */
  newUserMessageIds: string[];
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/**
 * The actual send controller. Owns no React state: MeContext supplies the
 * fence/sleep and publishes results only when the fence still holds.
 */
export class NativeConversationController {
  private readonly native: UpstreamNativeClient;
  private readonly generateId: () => string;

  constructor(native: UpstreamNativeClient, generateId: () => string) {
    this.native = native;
    this.generateId = generateId;
  }

  /**
   * Resolve the binding, creating ONE channel when none exists. Fenced
   * before AND after every await: a scope change mid-roster or mid-create
   * throws UPSTREAM_SCOPE_RESET and publishes nothing.
   */
  async ensureBinding(
    existing: ChannelBinding | null,
    fence: ScopeFence,
  ): Promise<ChannelBinding> {
    if (existing?.channelId && existing?.agentId) return existing;
    const captured = fence.capture();
    const check = (): void => {
      if (!fence.isCurrent(captured)) throw staleScope();
    };
    check();
    const bots = await this.native.listAgents();
    check();
    if (bots.length === 0) {
      throw new HomeClientError(
        'NOT_FOUND',
        'No assistants are available on this home yet. Ask whoever runs your home to grant access.',
      );
    }
    // Accessible roster is already per-owner; the first Bot is the default.
    // A future picker can choose explicitly; the binding records the choice.
    const agentId = bots[0].id;
    const channel = await this.native.createChannel([agentId]);
    check();
    return { channelId: channel.id, agentId: channel.agentIds[0] ?? agentId };
  }

  /**
   * POST the native message (202 via the real router/worker), then poll
   * history until a NEW assistant text message appears or the bound is
   * hit. POST-then-one-GET normally shows no answer yet; without this poll
   * the reply only appears on a manual refresh.
   */
  async sendAndSync(input: SendSyncInput): Promise<SendSyncResult> {
    const channelId = input.channelId;
    const agentId = input.agentId;
    if (!channelId || channelId.includes('..')) {
      throw new HomeClientError('INVALID_INPUT', 'The conversation id is not valid.');
    }
    if (!agentId || !agentId.trim()) {
      throw new HomeClientError('INVALID_INPUT', 'Choose an accessible Bot for your conversation.');
    }
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
    const externalId = externalIdFor(input.requestKey, this.generateId);
    const captured = input.fence.capture();
    const check = (): void => {
      if (!input.fence.isCurrent(captured)) throw staleScope();
    };
    check();
    const before = await this.native.getHistory(channelId, agentId);
    check();
    const known = new Set<string>(input.knownIds ?? []);
    for (const message of before) known.add(message.id);
    const beforeUserIds = new Set<string>();
    for (const message of before) {
      if (message.role === 'user') beforeUserIds.add(message.id);
    }
    await this.native.sendNativeMessage(channelId, { agentId, text, externalId });
    check();
    const maxAttempts = clampInt(input.pollAttempts, 8, 1, 12);
    const intervalMs = clampInt(input.pollIntervalMs, 1500, 250, 5000);
    let history = before;
    let attempts = 0;
    let answered = false;
    while (attempts < maxAttempts) {
      check();
      await input.sleep(intervalMs);
      check();
      history = await this.native.getHistory(channelId, agentId);
      check();
      attempts += 1;
      answered = history.some(
        (message) =>
          !known.has(message.id) &&
          message.role === 'assistant' &&
          transcriptText(message) !== null,
      );
      if (answered) break;
    }
    const newUserMessageIds: string[] = [];
    for (const message of history) {
      if (message.role === 'user' && !beforeUserIds.has(message.id)) {
        newUserMessageIds.push(message.id);
      }
    }
    return { accepted: true, externalId, answered, attempts, history, newUserMessageIds };
  }
}

/**
 * Pending-send reconciliation (pure, overlay UX only — never a second
 * store). `pending` is insertion-ordered (oldest first). Rules:
 * - answered (a new assistant reply landed): the turn completed, the server
 *   is authoritative from here — drop ALL pending for the conversation.
 * - otherwise, when a pre-send baseline exists, retire the oldest pending
 *   entry per newly arrived server user id (count-preserving; repeated
 *   same-text sends keep distinct UUIDs and retire in order).
 * - without a baseline (e.g. first hydrate after a restart) retire nothing
 *   on echo evidence alone — only `answered` clears.
 * Older polls can never erase newer turns: this function only removes from
 * the pending overlay, never from server history, and removals are bounded
 * by the new-echo count.
 */
export interface PendingSend {
  externalId: string;
}

export function reconcilePendingSends<T extends PendingSend>(
  pending: readonly T[],
  opts: { answered: boolean; newUserEchoes: number; hadBaseline: boolean },
): T[] {
  if (opts.answered) return [];
  if (!opts.hadBaseline) return [...pending];
  const drop = Math.min(pending.length, Math.max(0, Math.floor(opts.newUserEchoes)));
  return pending.slice(drop);
}
