// Paired-home client: portable, dependency-free service adapter for the phone.
//
// Speaks the canonical H1 contract `home-api-v1`
// (infra-server/contracts/home-api-v1.md). Owns one-time enrollment, session
// renewal via the device credential, home-authoritative history sync,
// idempotent sends, revocation handling, and honest offline/error states.
// Designed to plug into the Expo prototype's MeContext (transport) and
// DevicePanel (pairing UI) without copying the UI.
//
// Security rules enforced here:
// - Tokens/device secrets/pairing secrets are stored ONLY in SecureStorage.
// - The message cache (CacheStorage) never holds secrets; unit tests assert this.
// - Secrets are never logged; use `summary()` (redacted) for display.
// - Invitations are single-use; renewal uses the device credential, never the
//   invitation again.
// - User/device identity always derives from the server session lookup; the
//   client never asserts a user id as identity.

import {
  CONTRACT_VERSION,
  ROUTES,
  SERVER_ERRORS,
} from './home-api-v1.ts';
import { HomeClientError } from './errors.ts';
import { redactHeaders } from './secure-storage.ts';
import type {
  CacheStorage,
  SecureStorage,
} from './secure-storage.ts';
import type {
  ConnectionStatus,
  ConversationId,
  ConversationSnapshot,
  EnrollmentSummary,
  HomeChatMessage,
  RequestId,
  SubmitTaskInput,
  TaskView,
  UserId,
} from './types.ts';
import {
  parseUpstreamCapability,
} from './upstream-capability.ts';
import type { UpstreamCapability } from './upstream-capability.ts';

export const ENROLLMENT_STORAGE_KEY = 'me.home.enrollment.v1';
export const CACHE_PREFIX = 'me.home.cache.v1.';

export interface DeviceKey {
  /** Human label shown in the home's device inventory, e.g. "Anna's phone". */
  label: string;
}

export interface Invitation {
  homeBaseUrl: string;
  invitationId: string;
  pairingSecret: string;
  /** Optional: must match the home's installation id (`wrong_home` if not). */
  installationId?: string;
  /**
   * Optional: verified against the server's enrollment reply. Never sent as
   * identity — identity always derives from the server session lookup.
   */
  expectedUserId?: UserId;
}

interface StoredEnrollment {
  installationId: string;
  homeBaseUrl: string;
  deviceId: string;
  deviceSecret: string;
  deviceLabel: string;
  userId: UserId;
  sessionToken: string | null;
  sessionExpiresAt: number | null;
  enrolledAt: number;
  revoked?: boolean;
}

export interface PairedHomeClientOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  generateId?: (prefix: string) => string;
  /** Allow http loopback for local home integration runs. */
  allowInsecureLoopback?: boolean;
  requestTimeoutMs?: number;
}

/** UUIDv4 from Math.random: uniqueness (not secrecy) for idempotency keys. */
export function randomUuidV4(): string {
  const hex = () =>
    Math.floor(Math.random() * 0xffff)
      .toString(16)
      .padStart(4, '0');
  const timeLow = hex() + hex();
  const timeMid = hex();
  const timeHi = (0x4000 | (Math.floor(Math.random() * 0x0fff))).toString(16).padStart(4, '0');
  const clockSeq = (0x8000 | Math.floor(Math.random() * 0x3fff)).toString(16).padStart(4, '0');
  return `${timeLow.slice(0, 8)}-${timeMid}-${timeHi}-${clockSeq}-${hex()}${hex()}${hex()}`.slice(0, 36);
}

export interface SendOptions {
  /** Server-bound idempotency key (H2). Auto-generated UUID when omitted;
   * reuse the same key across network retries, never across messages. */
  requestKey?: string;
  /** Deprecated alias for requestKey. */
  requestId?: RequestId;
}

export interface SendResult {
  message: HomeChatMessage;
  /** True when the home durably accepted; false means queued locally. */
  homeAccepted: boolean;
  /** True when the home confirms this key was already used (retry dedupe). */
  duplicate?: boolean;
}

type FetchImpl = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
    redirect?: 'error' | 'follow' | 'manual';
  },
) => Promise<{
  status: number;
  /** Final response URL when the stack reports it (undici does). */
  url?: string;
  json(): Promise<unknown>;
}>;

interface ServerErrorBody {
  error?: { code?: unknown; message?: unknown };
}

export class PairedHomeClient {
  readonly mode = 'home' as const;
  private readonly fetchImpl: FetchImpl;
  private readonly secure: SecureStorage;
  private readonly cache: CacheStorage;
  private readonly now: () => number;
  private readonly generateId: (prefix: string) => string;
  private readonly allowInsecureLoopback: boolean;
  private readonly requestTimeoutMs: number;

  constructor(
    secureStorage: SecureStorage,
    cacheStorage: CacheStorage,
    options: PairedHomeClientOptions = {},
  ) {
    this.secure = secureStorage;
    this.cache = cacheStorage;
    this.fetchImpl = (options.fetchImpl ?? fetch) as unknown as FetchImpl;
    this.now = options.now ?? Date.now;
    // Default keys are UUIDv4: H2 requires server-bound request_key values
    // to be UUIDs (non-UUID keys are 400 bad_request). Uniqueness is what
    // matters here, not secrecy; callers may inject a crypto-backed
    // generator via options.
    this.generateId = options.generateId ?? (() => randomUuidV4());
    this.allowInsecureLoopback = options.allowInsecureLoopback ?? false;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 20_000;
  }

  // -- URL handling (keeps the prototype's strict origin rule) --

  normalizeBaseUrl(value: string): string {
    let parsed: URL;
    try {
      parsed = new URL(value.trim());
    } catch {
      throw new HomeClientError(
        'INVALID_INPUT',
        'Enter a valid Me Home address.',
      );
    }
    const isLoopback =
      parsed.hostname === 'localhost' ||
      parsed.hostname === '127.0.0.1' ||
      parsed.hostname === '::1';
    const secureProtocol =
      parsed.protocol === 'https:' ||
      (this.allowInsecureLoopback &&
        parsed.protocol === 'http:' &&
        isLoopback);
    if (
      !secureProtocol ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      (parsed.pathname !== '' && parsed.pathname !== '/')
    ) {
      throw new HomeClientError(
        'INVALID_INPUT',
        'Use a trusted home address without a path, query, or password.',
      );
    }
    return parsed.origin;
  }

  // -- Enrollment (one-time invitation: POST /v1/pair + /v1/sessions) --

  /**
   * Enroll this phone with a single-use invitation. Never logs the secret.
   * Pairing returns the device credential (shown once); this method
   * immediately exchanges it for a session token and stores both in
   * SecureStorage. The caller-supplied device secret placeholder is never
   * used — the home issues the credential.
   */
  async enrollOneTime(
    invitation: Invitation,
    device: DeviceKey,
  ): Promise<EnrollmentSummary> {
    const baseUrl = this.normalizeBaseUrl(invitation.homeBaseUrl);
    const pairBody: Record<string, unknown> = {
      invitation_id: invitation.invitationId,
      invitation_secret: invitation.pairingSecret,
      device_label: device.label,
    };
    if (invitation.installationId) {
      pairBody['installation_id'] = invitation.installationId;
    }
    const paired = (await this.request(baseUrl, ROUTES.pair, {
      method: 'POST',
    }, pairBody)) as {
      device_id?: unknown;
      device_secret?: unknown;
      user_id?: unknown;
      installation_id?: unknown;
    };
    if (
      typeof paired.device_id !== 'string' ||
      typeof paired.device_secret !== 'string' ||
      typeof paired.user_id !== 'string' ||
      typeof paired.installation_id !== 'string'
    ) {
      throw new HomeClientError(
        'CONTRACT_MISMATCH',
        'The home pairing reply had an unexpected shape.',
      );
    }
    if (
      invitation.expectedUserId &&
      paired.user_id !== invitation.expectedUserId
    ) {
      throw new HomeClientError(
        'INVITE_MISMATCH',
        'That invitation belongs to a different household user.',
      );
    }
    const enrollment: StoredEnrollment = {
      installationId: paired.installation_id,
      homeBaseUrl: baseUrl,
      deviceId: paired.device_id,
      deviceSecret: paired.device_secret,
      deviceLabel: device.label,
      userId: paired.user_id,
      sessionToken: null,
      sessionExpiresAt: null,
      enrolledAt: this.now(),
    };
    await this.openSession(enrollment);
    await this.secure.setItem(
      ENROLLMENT_STORAGE_KEY,
      JSON.stringify(enrollment),
    );
    return this.summarize(enrollment);
  }

  /** Open (or renew) the short-lived session from the device credential. */
  async renewSession(): Promise<EnrollmentSummary> {
    const enrollment = await this.readEnrollment();
    if (!enrollment) {
      throw new HomeClientError(
        'UNPAIRED',
        'This phone is not paired with a home yet.',
      );
    }
    try {
      await this.openSession(enrollment);
    } catch (error) {
      if (
        error instanceof HomeClientError &&
        error.code === 'UNPAIRED'
      ) {
        // POST /v1/sessions 401 invalid_device: revoked or wrong secret.
        // Either way this device credential is dead; a new invitation is
        // required.
        throw new HomeClientError(
          'DEVICE_REVOKED',
          'This device credential was rejected. Pair again with a new invitation.',
        );
      }
      throw error;
    }
    await this.secure.setItem(
      ENROLLMENT_STORAGE_KEY,
      JSON.stringify(enrollment),
    );
    return this.summarize(enrollment);
  }

  private async openSession(enrollment: StoredEnrollment): Promise<void> {
    const response = (await this.request(
      enrollment.homeBaseUrl,
      ROUTES.sessions,
      { method: 'POST' },
      { device_id: enrollment.deviceId, device_secret: enrollment.deviceSecret },
    )) as { token?: unknown; expires_at?: unknown };
    if (typeof response.token !== 'string' || !response.token) {
      throw new HomeClientError(
        'CONTRACT_MISMATCH',
        'Session creation did not return session material.',
      );
    }
    enrollment.sessionToken = response.token;
    enrollment.sessionExpiresAt =
      typeof response.expires_at === 'number' ? response.expires_at : null;
    enrollment.revoked = false;
  }

  /** Read the redacted enrollment summary (safe for UI/logging). */
  async summary(): Promise<EnrollmentSummary | null> {
    const enrollment = await this.readEnrollment();
    return enrollment ? this.summarize(enrollment) : null;
  }

  /**
   * Endpoint-rotation guard (F8 trust fix).
   *
   * A backend `endpointHint` is an UNTRUSTED coordination hint: it must NEVER
   * authorize forwarding the existing device secret / session to a NEW URL.
   * A UUID match (`verifyEndpointIdentity`) compares only the PUBLIC
   * installation id — it is correlation, not server authentication — so a
   * clone replaying the UUID on an evil endpoint still fails here.
   *
   * This method therefore REJECTS any origin change with PAIRING_REQUIRED
   * BEFORE any network or store mutation (the old home keeps working).
   * Moving to a new URL requires a FRESH one-time invitation from trusted
   * local setup with the URL included (`home-pairing-v1`, see
   * setup-invitation.ts); old data stays home, nothing is auto-erased.
   *
   * Same-origin normalization (trailing slash / case) is allowed so stable
   * restarts that keep the URL unchanged keep working.
   */
  async rebindHomeBaseUrl(newBaseUrl: string): Promise<EnrollmentSummary> {
    const enrollment = await this.requireEnrollment();
    const origin = this.normalizeBaseUrl(newBaseUrl);
    let currentOrigin: string;
    try {
      currentOrigin = new URL(enrollment.homeBaseUrl).origin;
    } catch {
      throw new HomeClientError(
        'PAIRING_REQUIRED',
        'The paired home address is unreadable. Pair again with a fresh one-time invitation.',
      );
    }
    if (origin !== currentOrigin) {
      throw new HomeClientError(
        'PAIRING_REQUIRED',
        'That address differs from the paired home. Pair again with a fresh one-time invitation from trusted local setup that includes the new URL.',
      );
    }
    if (origin === enrollment.homeBaseUrl) return this.summarize(enrollment);
    const rebound: StoredEnrollment = { ...enrollment, homeBaseUrl: origin };
    await this.secure.setItem(ENROLLMENT_STORAGE_KEY, JSON.stringify(rebound));
    return this.summarize(rebound);
  }

  /** Switch to explicit demo mode: delete enrollment, keep cached history. */
  async enterDemoMode(): Promise<void> {
    await this.secure.deleteItem(ENROLLMENT_STORAGE_KEY);
  }

  // -- Home-authoritative conversation surface --

  async checkHealth(
    baseUrl?: string,
  ): Promise<{ reachable: boolean; status: string; installationId: string }> {
    const enrollment = await this.readEnrollment();
    const origin = baseUrl
      ? this.normalizeBaseUrl(baseUrl)
      : enrollment?.homeBaseUrl;
    if (!origin) {
      throw new HomeClientError(
        'UNPAIRED',
        'No paired home to check. Pair with a one-time invitation first.',
      );
    }
    try {
      const response = (await this.request(origin, ROUTES.health, {
        method: 'GET',
      })) as { status?: unknown; installation_id?: unknown; contract?: unknown };
      if (response?.status !== 'ok') {
        throw new HomeClientError(
          'CONTRACT_MISMATCH',
          'This address did not identify a ready Me Home service.',
        );
      }
      if (
        response.contract !== undefined &&
        response.contract !== CONTRACT_VERSION
      ) {
        throw new HomeClientError(
          'CONTRACT_MISMATCH',
          `The home speaks contract ${String(response.contract)}; this client speaks ${CONTRACT_VERSION}.`,
        );
      }
      return {
        reachable: true,
        status: 'ok',
        installationId:
          typeof response.installation_id === 'string'
            ? response.installation_id
            : '',
      };
    } catch (error) {
      if (error instanceof HomeClientError) throw error;
      throw new HomeClientError(
        'HOME_OFFLINE',
        'Could not reach the home. It may be powered off or offline.',
        true,
      );
    }
  }

  async createConversation(title: string): Promise<{ id: ConversationId; title: string }> {
    const clean = title.trim().slice(0, 120) || 'New conversation';
    const enrollment = await this.requireEnrollment();
    const response = (await this.authenticatedRequest(
      enrollment,
      ROUTES.conversations,
      { method: 'POST' },
      { title: clean },
    )) as { id?: unknown; title?: unknown };
    if (typeof response.id !== 'string') {
      throw new HomeClientError(
        'CONTRACT_MISMATCH',
        'Conversation creation had an unexpected shape.',
      );
    }
    return {
      id: response.id,
      title: typeof response.title === 'string' ? response.title : clean,
    };
  }

  async listConversations(): Promise<
    Array<{ id: ConversationId; title: string }>
  > {
    const enrollment = await this.requireEnrollment();
    const response = (await this.authenticatedRequest(
      enrollment,
      ROUTES.conversations,
      { method: 'GET' },
    )) as { conversations?: Array<{ id: string; title: string }> };
    if (!Array.isArray(response.conversations)) {
      throw new HomeClientError(
        'CONTRACT_MISMATCH',
        'Conversation list had an unexpected shape.',
      );
    }
    return response.conversations;
  }

  /**
   * Home-authoritative sync: the server snapshot REPLACES the local cache.
   * Phone persistence is a deliberate cache/offline UX decision, never the
   * source of truth. A conversation owned by another household user reads as
   * not-found (no existence leak) and surfaces as FORBIDDEN here.
   */
  async syncConversation(
    conversationId: ConversationId,
  ): Promise<ConversationSnapshot> {
    const enrollment = await this.requireEnrollment();
    let meta: { id?: unknown; owner_id?: unknown; title?: unknown };
    let messages: Array<{
      id?: unknown;
      author_user_id?: unknown;
      role?: unknown;
      body?: unknown;
      created_at?: unknown;
    }>;
    try {
      meta = (await this.authenticatedRequest(
        enrollment,
        ROUTES.conversation(conversationId),
        { method: 'GET' },
      )) as typeof meta;
      const body = (await this.authenticatedRequest(
        enrollment,
        ROUTES.conversationMessages(conversationId),
        { method: 'GET' },
      )) as { messages?: typeof messages };
      if (!Array.isArray(body.messages)) {
        throw new HomeClientError(
          'CONTRACT_MISMATCH',
          'Message list had an unexpected shape.',
        );
      }
      messages = body.messages;
    } catch (error) {
      if (
        error instanceof HomeClientError &&
        error.code === 'NOT_FOUND'
      ) {
        throw new HomeClientError(
          'FORBIDDEN',
          'That conversation was not found or belongs to another household user.',
        );
      }
      throw error;
    }
    if (meta.id !== conversationId || typeof meta.owner_id !== 'string') {
      throw new HomeClientError(
        'CONTRACT_MISMATCH',
        'Conversation detail had an unexpected shape.',
      );
    }
    if (meta.owner_id !== enrollment.userId) {
      throw new HomeClientError(
        'FORBIDDEN',
        'That conversation belongs to another household user.',
      );
    }
    const snapshot: ConversationSnapshot = {
      id: conversationId,
      ownerUserId: meta.owner_id,
      title: typeof meta.title === 'string' ? meta.title : 'Conversation',
      version: this.now(),
      cursor: `sync_${this.now()}`,
      messages: messages.map((m) =>
        this.toHomeMessage(conversationId, m),
      ),
    };
    await this.cache.setItem(
      CACHE_PREFIX + conversationId,
      JSON.stringify(snapshot),
    );
    return snapshot;
  }

  /** Read the local cache without hitting the network (offline UX). */
  async readCachedConversation(
    conversationId: ConversationId,
  ): Promise<ConversationSnapshot | null> {
    const raw = await this.cache.getItem(CACHE_PREFIX + conversationId);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as ConversationSnapshot;
    } catch {
      return null;
    }
  }

  /**
   * Send a message with a server-bound idempotency key (H2 `request_key`).
   * The same key with a byte-identical body returns the original message
   * (`duplicate: true`) instead of duplicating it; the same key with a
   * different body is a caller bug (`REQUEST_KEY_CONFLICT` — never reuse a
   * key across messages). A home-accepted message already cached under the
   * same key is returned without re-sending (covers reconnect replays while
   * the cache is intact). If the home is unreachable the message is queued
   * in the cache as pending (honest queued-offline state, never claimed as
   * executed).
   */
  async sendMessage(
    conversationId: ConversationId,
    text: string,
    options: SendOptions = {},
  ): Promise<SendResult> {
    const clean = text.trim();
    if (!clean) {
      throw new HomeClientError('INVALID_INPUT', 'Message text is empty.');
    }
    const enrollment = await this.requireEnrollment();
    const requestKey = options.requestKey ?? options.requestId ?? this.generateId('req');
    const cached = await this.readCachedConversation(conversationId);
    const prior = cached?.messages.find(
      (m) => m.requestId === requestKey && m.acceptedBy === 'home' && !m.pending,
    );
    if (prior) return { message: prior, homeAccepted: true };
    try {
      const response = (await this.authenticatedRequest(
        enrollment,
        ROUTES.conversationMessages(conversationId),
        { method: 'POST' },
        { body: clean, request_key: requestKey },
      )) as {
        id?: unknown;
        conversation_id?: unknown;
        author_user_id?: unknown;
        role?: unknown;
        body?: unknown;
        created_at?: unknown;
        duplicate?: unknown;
      };
      const accepted = this.toHomeMessage(conversationId, {
        id: response.id,
        author_user_id: response.author_user_id,
        role: response.role,
        body: response.body,
        created_at: response.created_at,
      });
      accepted.requestId = requestKey;
      const duplicate = response.duplicate === true;
      await this.mergeIntoCache(conversationId, enrollment.userId, accepted);
      return { message: accepted, homeAccepted: true, duplicate };
    } catch (error) {
      if (
        error instanceof HomeClientError &&
        (error.code === 'HOME_OFFLINE' || error.code === 'OFFLINE')
      ) {
        const queued: HomeChatMessage = {
          id: requestKey,
          conversationId,
          authorUserId: enrollment.userId,
          role: 'user',
          text: clean,
          createdAt: this.now(),
          acceptedBy: 'home',
          requestId: requestKey,
          pending: true,
        };
        await this.mergeIntoCache(conversationId, enrollment.userId, queued);
        return { message: queued, homeAccepted: false };
      }
      throw error;
    }
  }

  // -- Persisted tasks (H2, home-owned) --

  /**
   * Submit a persisted task in a conversation. The home owns the lifecycle
   * (queued → running → succeeded/failed/cancelled/waiting_input/
   * waiting_approval); output/progress/artifacts come only from home
   * execution, never fabricated on the phone. A home with no usable model
   * honestly refuses with MODEL_NOT_CONFIGURED instead of queueing dead
   * work; the model is home-selected and cannot be overridden.
   */
  async submitTask(
    conversationId: ConversationId,
    input: SubmitTaskInput,
  ): Promise<TaskView> {
    const enrollment = await this.requireEnrollment();
    const request = input.request?.trim() ?? '';
    if (!request) {
      throw new HomeClientError('INVALID_INPUT', 'Task request text is empty.');
    }
    const body: Record<string, unknown> = { request };
    if (input.title !== undefined) body['title'] = input.title;
    if (input.capabilities !== undefined) body['capabilities'] = input.capabilities;
    if (input.budgets !== undefined) body['budgets'] = input.budgets;
    const response = await this.authenticatedRequest(
      enrollment,
      ROUTES.conversationTasks(conversationId),
      { method: 'POST' },
      body,
    );
    return toTaskView(conversationId, response);
  }

  async listTasks(conversationId: ConversationId): Promise<TaskView[]> {
    const enrollment = await this.requireEnrollment();
    const response = (await this.authenticatedRequest(
      enrollment,
      ROUTES.conversationTasks(conversationId),
      { method: 'GET' },
    )) as { tasks?: unknown[] };
    if (!Array.isArray(response.tasks)) {
      throw new HomeClientError(
        'CONTRACT_MISMATCH',
        'Task list had an unexpected shape.',
      );
    }
    return response.tasks.map((t) => toTaskView(conversationId, t));
  }

  /** Poll one task: status, progress, questions, approvals, output. */
  async getTask(taskId: string): Promise<TaskView> {
    const enrollment = await this.requireEnrollment();
    try {
      const response = await this.authenticatedRequest(
        enrollment,
        ROUTES.task(taskId),
        { method: 'GET' },
      );
      return toTaskView(undefined, response);
    } catch (error) {
      throw mapTaskNotFound(error);
    }
  }

  /** Cancel a task. Terminal already-finished tasks refuse (WRONG_STATE). */
  async cancelTask(taskId: string): Promise<TaskView> {
    const enrollment = await this.requireEnrollment();
    try {
      const response = await this.authenticatedRequest(
        enrollment,
        ROUTES.taskCancel(taskId),
        { method: 'POST' },
      );
      return toTaskView(undefined, response);
    } catch (error) {
      throw mapTaskNotFound(error);
    }
  }

  /** Answer a task blocked on waiting_input; resumes that run explicitly. */
  async answerTaskQuestions(
    taskId: string,
    inputs: Array<{ id: string; answer: string }>,
  ): Promise<TaskView> {
    const enrollment = await this.requireEnrollment();
    if (!Array.isArray(inputs) || inputs.length === 0) {
      throw new HomeClientError('INVALID_INPUT', 'At least one answer is required.');
    }
    try {
      const response = await this.authenticatedRequest(
        enrollment,
        ROUTES.taskInputs(taskId),
        { method: 'POST' },
        { inputs },
      );
      return toTaskView(undefined, response);
    } catch (error) {
      throw mapTaskNotFound(error);
    }
  }

  /** Decide pending approvals on a waiting_approval task. Decisions are
   * canonical H3 `approve`/`reject`; approval IDs are opaque server values
   * (namespaced per task) — always use the IDs from the polled task view. */
  async decideTaskApprovals(
    taskId: string,
    approvals: Array<{ id: string; decision: 'approve' | 'reject'; note?: string }>,
  ): Promise<TaskView> {
    const enrollment = await this.requireEnrollment();
    if (!Array.isArray(approvals) || approvals.length === 0) {
      throw new HomeClientError('INVALID_INPUT', 'At least one decision is required.');
    }
    for (const approval of approvals) {
      if (approval.decision !== 'approve' && approval.decision !== 'reject') {
        throw new HomeClientError(
          'INVALID_INPUT',
          'Approval decisions must be "approve" or "reject".',
        );
      }
    }
    const body: Record<string, unknown> = { approvals };
    try {
      const response = await this.authenticatedRequest(
        enrollment,
        ROUTES.taskApprovals(taskId),
        { method: 'POST' },
        body,
      );
      return toTaskView(undefined, response);
    } catch (error) {
      throw mapTaskNotFound(error);
    }
  }

  /** Artifact metadata for a task (bytes via fetchTaskArtifact). */
  async listTaskArtifacts(taskId: string): Promise<TaskView['artifacts']> {
    const enrollment = await this.requireEnrollment();
    try {
      const response = (await this.authenticatedRequest(
        enrollment,
        ROUTES.taskArtifacts(taskId),
        { method: 'GET' },
      )) as { artifacts?: unknown };
      return Array.isArray(response.artifacts)
        ? (response.artifacts as TaskView['artifacts'])
        : [];
    } catch (error) {
      throw mapTaskNotFound(error);
    }
  }

  /** Download one artifact's bytes from home storage (never a filesystem path). */
  async fetchTaskArtifact(taskId: string, artifactId: string): Promise<Uint8Array> {
    const enrollment = await this.requireEnrollment();
    if (!enrollment.sessionToken) {
      throw new HomeClientError(
        'UNPAIRED',
        'No home session. Renew the device session first.',
      );
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const rawFetch = this.fetchImpl as unknown as typeof fetch;
      const target = `${enrollment.homeBaseUrl}${ROUTES.taskArtifact(taskId, artifactId)}`;
      const response = await rawFetch(
        target,
        {
          method: 'GET',
          headers: {
            Accept: 'application/octet-stream',
            Authorization: `Bearer ${enrollment.sessionToken}`,
          },
          redirect: 'error',
          signal: controller.signal,
        },
      );
      assertSameOrigin(target, response.url);
      if (response.status === 404) {
        throw mapTaskNotFound(
          new HomeClientError('NOT_FOUND', 'Artifact not found.'),
        );
      }
      if (!response.ok) {
        const code = response.status === 401 ? 'DEVICE_REVOKED' : undefined;
        void code;
        throw this.errorForResponse(response.status, null, ROUTES.taskArtifacts(taskId));
      }
      return new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      if (error instanceof HomeClientError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new HomeClientError('TIMEOUT', 'Artifact download timed out.', true);
      }
      throw new HomeClientError('HOME_OFFLINE', 'Could not reach the home.', true);
    } finally {
      clearTimeout(timeout);
    }
  }

  // -- Opt-in task push (H7/home-notifications-v1, F8) --

  /**
   * Register the phone's Expo push token on the CURRENTLY paired home.
   * Opt-in only: the caller passes the phone's CURRENT OS permission state;
   * `permissionEnabled:false` stores the binding as disabled (no delivery).
   * The token is bearer-credentialed like every home route (redirect:error
   * + same-origin guard); the raw token is never returned, logged, or
   * cached outside secure/native transport.
   */
  async registerPushToken(input: {
    expoPushToken: string;
    permissionEnabled: boolean;
    projectId?: string;
  }): Promise<{
    registered: boolean;
    enabled: boolean;
    provider: string;
    permissionEnabled: boolean;
    installationId: string;
  }> {
    const enrollment = await this.requireEnrollment();
    if (typeof input.expoPushToken !== 'string' || !input.expoPushToken) {
      throw new HomeClientError('INVALID_INPUT', 'A valid Expo push token is required.');
    }
    if (typeof input.permissionEnabled !== 'boolean') {
      throw new HomeClientError('INVALID_INPUT', 'OS notification permission state is required.');
    }
    const body: Record<string, unknown> = {
      expo_push_token: input.expoPushToken,
      provider: 'expo',
      permission_enabled: input.permissionEnabled,
    };
    if (input.projectId !== undefined) body['project_id'] = input.projectId;
    try {
      const response = (await this.authenticatedRequest(
        enrollment,
        ROUTES.notificationsRegister,
        { method: 'POST' },
        body,
      )) as {
        registered?: unknown;
        enabled?: unknown;
        provider?: unknown;
        permission_enabled?: unknown;
        installation_id?: unknown;
      };
      if (response.registered !== true) {
        throw new HomeClientError(
          'CONTRACT_MISMATCH',
          'Push registration had an unexpected shape.',
        );
      }
      return {
        registered: true,
        enabled: response.enabled === true,
        provider: typeof response.provider === 'string' ? response.provider : 'expo',
        permissionEnabled: response.permission_enabled === true,
        installationId:
          typeof response.installation_id === 'string' ? response.installation_id : '',
      };
    } catch (error) {
      throw mapNotificationError(error);
    }
  }

  /** Redacted push status for the session device (suffix only, never raw). */
  async notificationStatus(): Promise<{
    registered: boolean;
    enabled: boolean;
    provider: string;
    permissionEnabled: boolean;
    tokenSuffix?: string;
    installationId: string;
  }> {
    const enrollment = await this.requireEnrollment();
    try {
      const response = (await this.authenticatedRequest(
        enrollment,
        ROUTES.notificationsStatus,
        { method: 'GET' },
      )) as {
        registered?: unknown;
        enabled?: unknown;
        provider?: unknown;
        permission_enabled?: unknown;
        token_suffix?: unknown;
        installation_id?: unknown;
      };
      return {
        registered: response.registered === true,
        enabled: response.enabled === true,
        provider: typeof response.provider === 'string' ? response.provider : 'expo',
        permissionEnabled: response.permission_enabled === true,
        ...(typeof response.token_suffix === 'string' ? { tokenSuffix: response.token_suffix } : {}),
        installationId:
          typeof response.installation_id === 'string' ? response.installation_id : '',
      };
    } catch (error) {
      throw mapNotificationError(error);
    }
  }

  /** Explicit disable of the session-device binding (idempotent). */
  async disableNotifications(): Promise<{ disabled: boolean }> {
    const enrollment = await this.requireEnrollment();
    try {
      await this.authenticatedRequest(
        enrollment,
        ROUTES.notificationsDisable,
        { method: 'POST' },
      );
      return { disabled: true };
    } catch (error) {
      throw mapNotificationError(error);
    }
  }

  /**
   * Read the home's OPTIONAL upstream capability report (Task A additive
   * fields on `GET /v1/me`: `{agentMode, fullConfigured, needsSetup,
   * missing?}`). Returns null when the home reports nothing (unknown — not
   * an error) or when the shape is malformed (never guessed). The phone
   * treats null + requested FULL as `setup-needed`, never silent legacy.
   */
  async fetchUpstreamCapability(): Promise<UpstreamCapability | null> {
    const enrollment = await this.requireEnrollment();
    const response = await this.authenticatedRequest(
      enrollment,
      ROUTES.me,
      { method: 'GET' },
    );
    return parseUpstreamCapability(response);
  }

  /**
   * Call the pinned upstream native REST API through the paired home's own
   * authority (`{homeBaseUrl}/api/*`).
   *
   * Auth is ONLY the home session bearer (`Authorization: Bearer <ht1_*>`,
   * same as /v1/*). The upstream mobile client used a BetterAuth Cookie;
   * the phone MUST NOT forge one — the home exchanges ht1_* server-side and
   * asserts the mapped upstream principal. Private upstream material
   * (license, gateway URLs, agent tokens, model keys) is never accepted
   * here: bodies carrying those fields are refused client-side.
   *
   * Path rules: absolute `/api/` paths only (query allowed for
   * `?agentId=`/`?cursor=`), no `..`, no credentials. Methods: GET/POST/DELETE.
   * Same-origin + redirect guards are the shared `request()` guards.
   */
  async proxyNativeApi(
    path: string,
    options: { method?: string; body?: Record<string, unknown> } = {},
  ): Promise<unknown> {
    const method = (options.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'POST' && method !== 'DELETE') {
      throw new HomeClientError('INVALID_INPUT', 'Unsupported upstream call.');
    }
    if (!path.startsWith('/api/')) {
      throw new HomeClientError(
        'INVALID_INPUT',
        'Upstream calls use absolute OpenBot /api/ paths only.',
      );
    }
    if (
      path.includes('..') ||
      path.includes('\\') ||
      path.includes(' ') ||
      /[\u0000-\u001f]/.test(path)
    ) {
      throw new HomeClientError('INVALID_INPUT', 'The upstream path is not valid.');
    }
    if (options.body !== undefined) {
      assertNoPrivateUpstreamFields(options.body);
    }
    const enrollment = await this.requireEnrollment();
    return this.authenticatedRequest(
      enrollment,
      path,
      { method },
      options.body,
    );
  }

  /** Revoke this device (e.g. sign out everywhere from an admin session). */
  async revokeOwnDevice(): Promise<void> {
    const enrollment = await this.requireEnrollment();
    await this.authenticatedRequest(
      enrollment,
      ROUTES.revokeDevice(enrollment.deviceId),
      { method: 'POST' },
    );
    await this.secure.setItem(
      ENROLLMENT_STORAGE_KEY,
      JSON.stringify({ ...enrollment, revoked: true, sessionToken: null }),
    );
  }

  /** Connection state for UI: never claims execution before home acceptance. */
  async connectionState(): Promise<ConnectionStatus> {
    const enrollment = await this.readEnrollment();
    if (!enrollment) return 'disconnected';
    if (enrollment.revoked) return 'error';
    try {
      await this.checkHealth();
      return 'connected';
    } catch (error) {
      if (
        error instanceof HomeClientError &&
        (error.code === 'UNPAIRED' || error.code === 'DEVICE_REVOKED')
      ) {
        return 'disconnected';
      }
      if (error instanceof HomeClientError && error.code === 'HOME_OFFLINE') {
        return 'offline';
      }
      return 'error';
    }
  }

  // -- internals --

  private toHomeMessage(
    conversationId: ConversationId,
    raw: {
      id?: unknown;
      author_user_id?: unknown;
      role?: unknown;
      body?: unknown;
      created_at?: unknown;
    },
  ): HomeChatMessage {
    if (
      typeof raw.id !== 'string' ||
      typeof raw.body !== 'string' ||
      (raw.role !== 'user' &&
        raw.role !== 'assistant' &&
        raw.role !== 'system')
    ) {
      throw new HomeClientError(
        'CONTRACT_MISMATCH',
        'The home message had an unexpected shape.',
      );
    }
    return {
      id: raw.id,
      conversationId,
      authorUserId:
        typeof raw.author_user_id === 'string' ? raw.author_user_id : null,
      role: raw.role,
      text: raw.body,
      createdAt: typeof raw.created_at === 'number' ? raw.created_at : this.now(),
      acceptedBy: 'home',
      homeMessageId: raw.id,
      pending: false,
    };
  }

  private summarize(enrollment: StoredEnrollment): EnrollmentSummary {
    return {
      homeId: enrollment.installationId,
      homeBaseUrl: enrollment.homeBaseUrl,
      deviceId: enrollment.deviceId,
      userId: enrollment.userId,
      protocolVersion: CONTRACT_VERSION,
      enrolledAt: enrollment.enrolledAt,
      sessionExpiresAt: enrollment.sessionExpiresAt,
      redacted: true,
    };
  }

  private async readEnrollment(): Promise<StoredEnrollment | null> {
    let raw: string | null;
    try {
      raw = await this.secure.getItem(ENROLLMENT_STORAGE_KEY);
    } catch {
      throw new HomeClientError(
        'STORAGE_UNAVAILABLE',
        'Secure credential storage is unavailable on this device.',
      );
    }
    if (!raw) return null;
    try {
      const value = JSON.parse(raw) as Partial<StoredEnrollment>;
      if (
        typeof value.installationId !== 'string' ||
        typeof value.homeBaseUrl !== 'string' ||
        typeof value.deviceId !== 'string' ||
        typeof value.deviceSecret !== 'string' ||
        typeof value.userId !== 'string'
      ) {
        return null;
      }
      return value as StoredEnrollment;
    } catch {
      return null;
    }
  }

  private async requireEnrollment(): Promise<StoredEnrollment> {
    const enrollment = await this.readEnrollment();
    if (!enrollment) {
      throw new HomeClientError(
        'UNPAIRED',
        'This phone is not paired with a home yet.',
      );
    }
    if (enrollment.revoked) {
      throw new HomeClientError(
        'DEVICE_REVOKED',
        'This device enrollment was revoked. Pair again with a new invitation.',
      );
    }
    return enrollment;
  }

  private async mergeIntoCache(
    conversationId: ConversationId,
    ownerUserId: string,
    message: HomeChatMessage,
  ): Promise<void> {
    const existing = await this.readCachedConversation(conversationId);
    const base: ConversationSnapshot = existing ?? {
      id: conversationId,
      ownerUserId,
      title: 'Conversation',
      version: 0,
      cursor: 'local',
      messages: [],
    };
    const deduped = base.messages.filter(
      (m) =>
        m.id !== message.id &&
        !(message.requestId && m.requestId === message.requestId),
    );
    deduped.push(message);
    await this.cache.setItem(
      CACHE_PREFIX + conversationId,
      JSON.stringify({ ...base, messages: deduped }),
    );
  }

  private async authenticatedRequest(
    enrollment: StoredEnrollment,
    path: string,
    init: { method?: string },
    body?: Record<string, unknown>,
  ): Promise<unknown> {
    if (!enrollment.sessionToken) {
      throw new HomeClientError(
        'UNPAIRED',
        'No home session. Renew the device session first.',
      );
    }
    try {
      return await this.request(
        enrollment.homeBaseUrl,
        path,
        { method: init.method ?? 'GET', sessionToken: enrollment.sessionToken },
        body,
      );
    } catch (error) {
      if (
        error instanceof HomeClientError &&
        error.code === 'DEVICE_REVOKED'
      ) {
        await this.secure.setItem(
          ENROLLMENT_STORAGE_KEY,
          JSON.stringify({ ...enrollment, revoked: true, sessionToken: null }),
        );
      }
      throw error;
    }
  }

  private async request(
    baseUrl: string,
    path: string,
    auth: { method?: string; sessionToken?: string },
    body?: Record<string, unknown>,
  ): Promise<unknown> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (auth.sessionToken) {
      headers['Authorization'] = `Bearer ${auth.sessionToken}`;
    }
    void redactHeaders(headers);

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.requestTimeoutMs,
    );
    let status: number;
    let payload: unknown;
    try {
      const target = `${baseUrl}${path}`;
      const response = await this.fetchImpl(target, {
        method: auth.method ?? 'GET',
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
        // Credential-bearing requests must never be forwarded across
        // origins. Spec-compliant stacks refuse to follow here; stacks that
        // follow anyway (some native fetch implementations ignore this
        // option) are caught by the final-URL origin check below.
        redirect: 'error',
      });
      assertSameOrigin(target, response.url);
      status = response.status;
      try {
        payload = await response.json();
      } catch {
        throw new HomeClientError(
          'CONTRACT_MISMATCH',
          'The home returned an unreadable response.',
        );
      }
    } catch (error) {
      if (error instanceof HomeClientError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new HomeClientError(
          'TIMEOUT',
          'The home did not respond in time.',
          true,
        );
      }
      throw new HomeClientError(
        'HOME_OFFLINE',
        'Could not reach the home over the network.',
        true,
      );
    } finally {
      clearTimeout(timeout);
    }
    if (status! >= 200 && status! < 300) return payload;
    throw this.errorForResponse(status!, payload, path);
  }

  private errorForResponse(
    status: number,
    payload: unknown,
    path: string,
  ): HomeClientError {
    const code =
      payload && typeof payload === 'object'
        ? String(
            ((payload as ServerErrorBody).error?.code ?? '') as unknown,
          )
        : '';
    const serverMessage =
      payload && typeof payload === 'object'
        ? String(
            ((payload as ServerErrorBody).error?.message ?? '') as unknown,
          )
        : '';
    void serverMessage;
    if (status === 401) {
      if (path === ROUTES.sessions || code === SERVER_ERRORS.invalidDevice) {
        return new HomeClientError(
          'DEVICE_REVOKED',
          'This device credential was rejected. Pair again with a new invitation.',
        );
      }
      return new HomeClientError(
        'UNPAIRED',
        'The home session is missing or expired. Renew the device session.',
      );
    }
    if (status === 403) {
      if (
        code === SERVER_ERRORS.wrongHome ||
        code === SERVER_ERRORS.invalidInvitation
      ) {
        return new HomeClientError(
          'INVITE_MISMATCH',
          'That invitation does not match this home or is invalid.',
        );
      }
      if (
        path.startsWith('/v1/notifications') &&
        (code === 'notifications_disabled' || code === 'notificationsDisabled')
      ) {
        return new HomeClientError(
          'NOTIFICATIONS_DISABLED',
          'Push notifications are disabled on this home (operator opt-in required).',
        );
      }
      return new HomeClientError(
        'FORBIDDEN',
        'The home refused this request for the current user/device.',
      );
    }
    if (status === 429) {
      if (path.startsWith('/v1/notifications')) {
        return new HomeClientError(
          'REGISTRATION_LIMIT',
          'Too many active push registrations. Disable an old device first.',
          true,
        );
      }
      return new HomeClientError(
        'HOME_OFFLINE',
        `The home returned an error (${status}).`,
        true,
      );
    }
    if (status === 404) {
      if (path === ROUTES.pair) {
        return new HomeClientError(
          'INVITE_MISMATCH',
          'That invitation was not found at this home.',
        );
      }
      if (path.startsWith('/v1/conversations') || path.startsWith('/v1/tasks') || path.startsWith('/v1/devices')) {
        // No existence leak: another household member's conversation, task,
        // or device reads as not-found.
        return new HomeClientError('NOT_FOUND', 'Not found at this home.');
      }
      if (path.startsWith('/api/')) {
        // Pinned upstream native surface through the home proxy: a missing
        // route and a missing channel both read as not-found on this home
        // (upstream `ownedScope` refusals arrive as 400, not 404).
        return new HomeClientError('NOT_FOUND', 'Not found at this home.');
      }
      return new HomeClientError(
        'CONTRACT_MISMATCH',
        'The home is missing the required API route. It may run an incompatible contract version.',
      );
    }
    if (status === 409) {
      if (code === SERVER_ERRORS.requestKeyConflict) {
        return new HomeClientError(
          'REQUEST_KEY_CONFLICT',
          'That idempotency key was already used with different content. Use a fresh key per message.',
        );
      }
      if (code === SERVER_ERRORS.wrongState) {
        return new HomeClientError(
          'WRONG_STATE',
          'The task is not in a state that allows that transition (it may have moved on). Refresh it.',
        );
      }
      return new HomeClientError(
        'INVITE_REUSED',
        'That invitation was already used. Each invitation enrolls at most one device.',
      );
    }
    if (status === 503) {
      if (code === SERVER_ERRORS.modelNotConfigured) {
        return new HomeClientError(
          'MODEL_NOT_CONFIGURED',
          'The home has no usable model configured, so it refused the task instead of queueing dead work.',
        );
      }
      return new HomeClientError(
        'HOME_OFFLINE',
        `The home is unavailable (${status}).`,
        true,
      );
    }
    if (status === 410) {
      if (code === SERVER_ERRORS.invitationConsumed) {
        return new HomeClientError(
          'INVITE_REUSED',
          'That invitation was already used. Each invitation enrolls at most one device.',
        );
      }
      return new HomeClientError(
        'INVITE_EXPIRED',
        'That invitation expired. Ask the home for a new one.',
      );
    }
    if (status === 400) {
      return new HomeClientError(
        'INVALID_INPUT',
        'The home rejected the request as invalid.',
      );
    }
    return new HomeClientError(
      'HOME_OFFLINE',
      `The home returned an error (${status}).`,
      status >= 500,
    );
  }
}

/**
 * Final-URL origin guard. `redirect: 'error'` keeps spec-compliant stacks
 * from forwarding Authorization/device material across origins, but some
 * native fetch implementations follow redirects anyway. When the stack
 * reports the final URL, refuse any cross-origin outcome before the payload
 * is parsed, stored, or acted on — and never re-issue credentials there.
 */
export function assertSameOrigin(requestTarget: string, finalUrl: string | undefined): void {
  if (!finalUrl) return;
  let requestOrigin: string;
  let finalOrigin: string;
  try {
    requestOrigin = new URL(requestTarget).origin;
    finalOrigin = new URL(finalUrl).origin;
  } catch {
    throw new HomeClientError(
      'CONTRACT_MISMATCH',
      'The endpoint returned an unreadable address. Refusing to continue.',
    );
  }
  if (requestOrigin !== finalOrigin) {
    throw new HomeClientError(
      'CONTRACT_MISMATCH',
      'The endpoint redirected to a different origin. Credentials were not re-issued there; verify the home address before retrying.',
    );
  }
}

/** Notification routes: surface invalid-token shapes as invalid input. */
function mapNotificationError(error: unknown): unknown {
  if (error instanceof HomeClientError) {
    if (error.code === 'FORBIDDEN') {
      // Fallback when a home reports push refusal without the typed code.
      return error;
    }
    if (error.code === 'CONTRACT_MISMATCH') return error;
    // invalid_push_token / bad_request on register/status arrive as
    // INVALID_INPUT already via errorForResponse; pass through.
    return error;
  }
  return error;
}

/**
 * Defense-in-depth: the phone never holds private upstream material, so it
 * never sends it either. Refuse bodies carrying license / gateway / agent /
 * model secrets before they reach the network.
 */
const PRIVATE_UPSTREAM_FIELD_RE =
  /^(COPILOTKIT_LICENSE_TOKEN|CPK_INTELLIGENCE_API_KEY|INTELLIGENCE_GATEWAY_WS_URL|MANAGED_AGENT_TOKEN|AGENT_TOOL_TOKEN|SUPERVISOR_TOKEN|COMPUTER_TOKEN|BETTER_AUTH_SECRET|OPENAI_API_KEY|ANTHROPIC_API_KEY|GOOGLE_API_KEY)$/;

function assertNoPrivateUpstreamFields(body: Record<string, unknown>): void {
  for (const key of Object.keys(body)) {
    if (PRIVATE_UPSTREAM_FIELD_RE.test(key)) {
      throw new HomeClientError(
        'INVALID_INPUT',
        'Private upstream credentials must never reach the phone.',
      );
    }
  }
}

/** Owner-scoped task reads: another household member's task is not-found. */
function mapTaskNotFound(error: unknown): unknown {  if (error instanceof HomeClientError && error.code === 'NOT_FOUND') {
    return new HomeClientError(
      'FORBIDDEN',
      'That task was not found or belongs to another household user.',
    );
  }
  return error;
}

function toTaskView(
  conversationId: ConversationId | undefined,
  raw: unknown,
): TaskView {
  if (!raw || typeof raw !== 'object') {
    throw new HomeClientError(
      'CONTRACT_MISMATCH',
      'The task view had an unexpected shape.',
    );
  }
  const view = raw as Record<string, unknown>;
  const status = view['status'];
  if (
    typeof view['id'] !== 'string' ||
    (status !== 'queued' &&
      status !== 'running' &&
      status !== 'succeeded' &&
      status !== 'failed' &&
      status !== 'cancelled' &&
      status !== 'waiting_input' &&
      status !== 'waiting_approval')
  ) {
    throw new HomeClientError(
      'CONTRACT_MISMATCH',
      'The task view had an unexpected shape.',
    );
  }
  const resolvedConversation =
    conversationId ??
    (typeof view['conversation_id'] === 'string'
      ? view['conversation_id']
      : undefined);
  if (!resolvedConversation) {
    throw new HomeClientError(
      'CONTRACT_MISMATCH',
      'The task view is missing its conversation.',
    );
  }
  // Optional H6 hierarchy: accept snake_case + camelCase, ignore malformed.
  const asString = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() ? value.trim() : undefined;
  const asStringList = (value: unknown): string[] | undefined => {
    if (typeof value === 'string' && value.trim()) return [value.trim()];
    if (!Array.isArray(value)) return undefined;
    const out: string[] = [];
    for (const entry of value) {
      if (typeof entry === 'string' && entry.trim()) out.push(entry.trim());
      else if (
        entry &&
        typeof entry === 'object' &&
        typeof (entry as Record<string, unknown>)['id'] === 'string' &&
        ((entry as Record<string, unknown>)['id'] as string).trim()
      ) {
        out.push(((entry as Record<string, unknown>)['id'] as string).trim());
      }
    }
    return out.slice(0, 50);
  };
  const parentTaskId =
    asString(view['parent_task_id']) ??
    asString(view['parentTaskId']) ??
    asString(view['parent_id']) ??
    undefined;
  const rootTaskId =
    asString(view['root_task_id']) ??
    asString(view['rootTaskId']) ??
    asString(view['root_id']) ??
    undefined;
  const childTaskIds =
    asStringList(view['child_task_ids']) ??
    asStringList(view['childTaskIds']) ??
    asStringList(view['children']) ??
    asStringList(view['child_ids']) ??
    undefined;
  const waitingChildren =
    asStringList(view['waiting_children']) ??
    asStringList(view['waitingChildren']) ??
    asStringList(view['waiting_child_ids']) ??
    undefined;
  return {
    id: view['id'] as string,
    conversationId: resolvedConversation,
    title:
      typeof view['title'] === 'string' ? view['title'] : 'Untitled task',
    status,
    output: typeof view['output'] === 'string' ? view['output'] : undefined,
    error: typeof view['error'] === 'string' ? view['error'] : undefined,
    questions: Array.isArray(view['questions'])
      ? (view['questions'] as TaskView['questions'])
      : Array.isArray(view['question'])
        ? (view['question'] as TaskView['questions'])
        : undefined,
    pendingApprovals: Array.isArray(view['pending_approvals'])
      ? (view['pending_approvals'] as TaskView['pendingApprovals'])
      : Array.isArray(view['pendingApprovals'])
        ? (view['pendingApprovals'] as TaskView['pendingApprovals'])
        : undefined,
    progress: Array.isArray(view['progress'])
      ? (view['progress'] as TaskView['progress'])
      : undefined,
    artifacts: Array.isArray(view['artifacts'])
      ? (view['artifacts'] as TaskView['artifacts'])
      : undefined,
    ...(parentTaskId ? { parentTaskId } : {}),
    ...(rootTaskId ? { rootTaskId } : {}),
    ...(childTaskIds ? { childTaskIds } : {}),
    ...(waitingChildren ? { waitingChildren } : {}),
    model:
      view['model'] && typeof view['model'] === 'object'
        ? (view['model'] as TaskView['model'])
        : undefined,
    createdAt:
      typeof view['created_at'] === 'number' ? view['created_at'] : undefined,
    updatedAt:
      typeof view['updated_at'] === 'number' ? view['updated_at'] : undefined,
  };
}
