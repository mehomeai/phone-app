import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';
import { scriptedReply, SEED_CONVERSATIONS, SEED_PROFILES, SEED_SETTINGS, uid } from '@/lib/data';
declare const __DEV__: boolean | undefined;

import {
  AccountAuthManager,
  accountIdentityChanged,
  buildLoginRequest,
  createBackendCoordinator,
  createHomeClient,
  createSecureStorage,
  filterStateToScope,
  isHostedReady,
  isSecureStoreAvailable,
  NotificationDedupe,
  normalizeOrigin,
  parseSetupInvitation,
  randomUuidV4,
  reconcileOnEnrollmentChange,
  scopeToken,
  describeUpstreamSetupNeeded,
  resolveAppSelection,
  selectRedirectUri,
  stampLinkScope,
  verifyEndpointIdentity,
  visibleConversations,
} from '@/lib/home-client';
import {
  createUpstreamNative,
  dropUpstreamNativeFor,
  resetUpstreamNativeScope,
  upstreamNativeScope,
} from '@/lib/upstream-native';
import type {
  ChannelBinding,
  NativeApprovalDecision,
  NativeApprovalInbox,
  NativeBot,
  NativeBotTask,
  NativeTranscriptMessage,
} from '@/lib/home-client';
import {
  mergeLinkMetadata,
  NativeConversationController,
  ChannelSingleflight,
  DecisionGate,
  isNativeWorkPending,
  reconcilePendingSends,
  runNativeWatch,
  toDisplayMessages,
} from '@/lib/home-client';
import type {
  ActivationHandoff,
  ActivationTicket,
  BackendCoordinator,
  EnrollmentSummary,
  HomeChatMessage,
  HostedAuthConfig,
  IdentityTuple,
  MemberHome,
  MintActivationTicketInput,
  PairedHomeClient,
  TaskView,
  UpstreamCapability,
  UpstreamExecutionSelection,
  RequestedUpstreamMode,
} from '@/lib/home-client';
import { HomeClientError } from '../../../src/errors.ts';
import type { Conversation, Message, Profile, Settings } from '@/lib/types';
import type { SavedArtifact } from '@/lib/artifact-store';

const KEY = 'me-demo-state-v1';
const HOME_LINKS_KEY = 'me-home-links-v1';

interface HomeLink {
  /** Home-side conversation id (home-authoritative). In FULL native mode
   * this is the upstream channel id; in legacy mode the /v1 conversation id. */
  homeId: string;
  /** Last client request_key for retry dedupe (survives restart). */
  requestKey?: string;
  /** FULL native mode: the upstream Bot this channel talks to. */
  upstreamAgentId?: string;
  /** Full authenticated scope stamp (F4). Links without a complete stamp
   * are legacy/unscoped and never trusted for display. */
  homeOwner?: string;
  homeInstallationId?: string;
  homeDeviceId?: string;
  homeBaseUrl?: string;
}

interface Persisted {
  profiles: Profile[];
  activeProfileId: string;
  conversations: Conversation[];
  settings: Settings;
  liked: string[];
  saved: string[];
  onboardingCompleted: boolean;
  homeLinks: Record<string, HomeLink>;
}

type Status = 'loading' | 'ready' | 'error';
export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'offline' | 'error';

export interface BackendState {
  backendUrl: string;
  memberHomes: MemberHome[];
  presence: Record<string, { lastSeenAt?: number; lastStatus?: string }>;
  backendError: string | null;
}

export type AccountStatus =
  | 'signed-out'
  | 'signing-in'
  | 'signed-in'
  | 'not-ready'
  | 'cancelled'
  | 'error';

export interface AccountState {
  status: AccountStatus;
  accountId: string | null;
  issuer: string | null;
  backendUrl: string | null;
  claims: Record<string, unknown> | null;
  error: string | null;
}

/** Opt-in task-push state (F8). The Expo token itself is never stored here. */
export interface NotificationState {
  enabled: boolean;
  permissionGranted: boolean;
  /** Redacted suffix only (never the raw Expo token). */
  tokenSuffix: string | null;
  error: string | null;
  busy: boolean;
}

const seed = (): Persisted => ({
  profiles: SEED_PROFILES,
  activeProfileId: SEED_PROFILES[0].id,
  conversations: SEED_CONVERSATIONS,
  settings: SEED_SETTINGS,
  liked: [],
  saved: [],
  onboardingCompleted: false,
  homeLinks: {},
});

/**
 * Strict shape check for a persisted conversation (ported from the Replit
 * Nov 3 stability hardening). A saved record that fails this — e.g.
 * `messages: null` — must fail the whole hydration closed instead of being
 * rendered as a private chat.
 */
function isSavedConversation(value: unknown): value is Conversation {
  if (!value || typeof value !== 'object') return false;
  const conversation = value as Partial<Conversation>;
  return (
    typeof conversation.id === 'string' &&
    conversation.id.length > 0 &&
    typeof conversation.profileId === 'string' &&
    conversation.profileId.length > 0 &&
    typeof conversation.title === 'string' &&
    conversation.title.trim().length > 0 &&
    (conversation.assistantMode === undefined ||
      conversation.assistantMode === 'demo' ||
      conversation.assistantMode === 'home') &&
    Array.isArray(conversation.messages) &&
    conversation.messages.every(
      (message) =>
        !!message &&
        typeof message.id === 'string' &&
        message.id.length > 0 &&
        (message.role === 'user' || message.role === 'assistant') &&
        typeof message.text === 'string' &&
        Number.isFinite(message.createdAt),
    )
  );
}

function assertValidSavedConversations(value: unknown): asserts value is Conversation[] {
  if (!Array.isArray(value)) throw new Error('Saved data is invalid.');
  const seenIds = new Set<string>();
  for (const conversation of value) {
    if (!isSavedConversation(conversation) || seenIds.has(conversation.id)) {
      throw new Error('Saved data is invalid.');
    }
    seenIds.add(conversation.id);
  }
}

/**
 * Bounded storage read (ported from the Replit Nov 3 hardening, which
 * wraps storage operations in a 10s timeout). Without it, a storage read
 * whose promise never settles leaves the app on the loading screen
 * forever with no recovery path; with it, the read fails closed into
 * the standard read-error state and Try again stays available.
 */
const STORAGE_READ_TIMEOUT_MS = 10_000;

function withStorageReadTimeout<T>(operation: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error('Local data did not respond.')), STORAGE_READ_TIMEOUT_MS);
  });
  return Promise.race([operation, deadline]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

function toLocalMessage(m: HomeChatMessage): Message | null {
  if (m.role === 'system') return null;
  return {
    id: m.id,
    role: m.role,
    text: m.text,
    createdAt: m.createdAt,
  };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Me Home could not complete the request.';
}

interface Ctx extends Persisted {
  status: Status;
  saveError: boolean;
  /** Setup was completed only in memory because its save failed. */
  onboardingSessionCompleted: boolean;
  retry: () => void;
  /** Re-attempt persisting the current state; resolves true only when saved. */
  retrySave: () => Promise<boolean>;
  /** Keep a completed setup for this session only (its save keeps failing). */
  continueSetupInMemory: () => void;
  activeProfile: Profile;
  /** Mode-aware display list: demo follows profiles, home follows the paired identity. */
  visibleChats: Conversation[];
  /** Authenticated home user id, or null when no enrollment is loaded. */
  homeUserId: string | null;
  /** Full-scope token (user+installation+device+endpoint origin). Changes on
   * any credential/endpoint rotation; UI-local cached task state keys off it
   * so no previous-user preview can flash. */
  homeScopeKey: string;
  /** False until the enrollment load has been attempted (no previous-user flash). */
  identityResolved: boolean;
  typing: Record<string, boolean>;
  chatErrors: Record<string, string>;
  connectionStatus: ConnectionStatus;
  connectionError: string | null;
  hasHomeCredential: boolean;
  enrollment: EnrollmentSummary | null;
  backend: BackendState;
  tasksByConv: Record<string, TaskView[]>;
  tasksLoading: Record<string, boolean>;
  taskErrors: Record<string, string>;
  taskArtifacts: Record<string, TaskView['artifacts']>;
  activeCallId: string | null;
  beginCall: (conversationId: string) => boolean;
  endCall: (conversationId: string) => void;
  setActiveProfile: (id: string) => void;
  updateProfile: (id: string, patch: Partial<Profile>) => void;
  addProfile: (p: Omit<Profile, 'id'>) => string;
  /** Setup-time profile creation: dedupes by trimmed name + role, activates
   * the (new or existing) profile, and returns its id. */
  addSetupProfile: (p: Omit<Profile, 'id'>) => string;
  removeProfile: (id: string) => void;
  createConversation: (title?: string) => string;
  deleteConversation: (id: string) => void;
  openConversation: (id: string) => void;
  sendMessage: (convId: string | null, text: string) => string;
  retryMessage: (convId: string) => void;
  enrollHome: (input: { homeBaseUrl: string; invitationId: string; pairingSecret: string; installationId?: string; expectedUserId?: string }) => Promise<boolean>;
  /** Pair from a pasted trusted-local `home-pairing-v1` setup payload (S7). */
  enrollWithSetupJson: (text: string) => Promise<boolean>;
  revokeEnrollment: () => Promise<void>;
  useDemoMode: () => Promise<void>;
  verifyHomeConnection: () => Promise<void>;
  notifications: NotificationState;
  enableNotifications: () => Promise<boolean>;
  disableNotifications: () => Promise<void>;
  /** FULL upstream native-REST mode (Task D). Null = home reports nothing. */
  upstreamCapability: UpstreamCapability | null;
  /** Requested owner: 'full' default (advertised full home => full/setup-needed;
   * resolved old homes without capability fields stay legacy compat). */
  requestedUpstreamMode: RequestedUpstreamMode;
  setRequestedUpstreamMode: (mode: RequestedUpstreamMode) => void;
  /** Accessible upstream bot roster (FULL mode; null until refreshed). */
  upstreamBots: NativeBot[] | null;
  upstreamBotsLoading: boolean;
  upstreamBotsError: string | null;
  refreshUpstreamBots: () => Promise<void>;
  /** True when the conversation is bound to an upstream native channel. */
  isNativeConversation: (convId: string | null) => boolean;
  /** Native upstream tasks per local conversation (verified /api/tasks). */
  nativeTasksByConv: Record<string, NativeBotTask[]>;
  nativeTasksLoading: Record<string, boolean>;
  nativeTasksError: Record<string, string>;
  refreshNativeTasks: (convId: string) => Promise<void>;
  /** POST /api/tasks/:id/again (failed turn runs once more in its conversation). */
  retryNativeTask: (taskId: string) => Promise<void>;
  /** Personal native inbox across the user's chats (verified GET /api/approvals). */
  nativeApprovals: NativeApprovalInbox | null;
  nativeApprovalsLoading: boolean;
  nativeApprovalsError: string | null;
  /** Per-request busy guard: double-tap never fires a second decision. */
  nativeApprovalsBusy: Record<string, boolean>;
  refreshNativeApprovals: () => Promise<void>;
  /** Explicit allow/deny (verified POST decision; never a chat-reply bypass). */
  decideNativeApproval: (requestId: string, decision: NativeApprovalDecision) => Promise<void>;
  /** Draft answers for native questions, keyed by question id. */
  nativeAnswers: Record<string, string>;
  setNativeAnswer: (questionId: string, answer: string) => void;
  /** Explicit question answer (verified POST respond). */
  respondNativeQuestion: (questionId: string) => Promise<void>;
  /** Bounded foreground watch state per conversation ('watching' | 'stale'). */
  nativeWatchState: Record<string, 'watching' | 'stale'>;
  /** Honest derived selection: FULL requested but incomplete home => 'setup-needed' (never silent legacy). */
  upstreamSelection: UpstreamExecutionSelection;
  /** Operator-facing setup message when `upstreamSelection === 'setup-needed'`, else null. */
  upstreamSetupMessage: string | null;
  /** Fenced tap routing: fetch the verified task + conversation, return the
   * local conversation id to open (fixed Chat route), or null to stay put. */
  openTaskFromNotification: (taskId: string) => Promise<string | null>;
    configureBackend: (backendUrl: string, accountToken: string) => Promise<boolean>;
    clearBackend: () => Promise<void>;
    account: AccountState;
    refreshAccountConfig: () => Promise<void>;
    signInWithProvider: () => Promise<boolean>;
    signOutAccount: () => Promise<void>;
    retryAccountRefresh: () => Promise<void>;
    refreshBackendHomes: () => Promise<void>;
  joinBackendHome: (homeId: string, ticketSecret: string) => Promise<boolean>;
  selectBackendHome: (homeId: string) => Promise<boolean>;
  /**
   * Mint a one-time home-activation ticket (F9/B7, account auth). Single
   * attempt, no retries: returns the ticket + operator handoff or null.
   * Never touches the paired home (cloud outage/refresh never stops it) and
   * never persists the ticket — the caller holds it in ephemeral UI state.
   */
  mintActivationTicket: (input: MintActivationTicketInput) => Promise<{ ticket: ActivationTicket; handoff: ActivationHandoff } | null>;
  refreshTasks: (convId: string) => Promise<void>;
  submitHomeTask: (convId: string, input: { request: string; title?: string }) => Promise<void>;
  answerTaskQuestion: (taskId: string, questionId: string, answer: string) => Promise<void>;
  decideTaskApproval: (taskId: string, approvalId: string, decision: 'approve' | 'reject') => Promise<void>;
  cancelHomeTask: (taskId: string) => Promise<void>;
  loadTaskArtifacts: (taskId: string) => Promise<void>;
  downloadTaskArtifact: (taskId: string, artifactId: string) => Promise<{ name: string; bytes: Uint8Array }>;
  /** Fetch + save to the app-private scoped cache. Null when the pairing moved mid-flight (fenced). */
  saveTaskArtifact: (taskId: string, artifactId: string) => Promise<SavedArtifact | null>;
  updateSettings: (patch: Partial<Settings>) => void;
  toggleLike: (id: string) => void;
  toggleSave: (id: string) => void;
  /** Persists first and resolves true only when the flag was saved; on a
   * failed save the in-memory flag is left unchanged and it resolves false. */
  setOnboardingCompleted: (completed: boolean) => Promise<boolean>;
  resetDemo: () => Promise<void>;
}

const MeContext = createContext<Ctx | null>(null);

/** Never carry scripted demo history into a real home conversation (or vice versa). */
function sameModeTarget(
  conversations: Conversation[],
  convId: string | null,
  mode: 'demo' | 'home',
  activeProfileId: string,
  clean: string,
): { conversation: Conversation; created: boolean } {
  const previous = convId ? conversations.find((item) => item.id === convId) : undefined;
  const sameMode = previous && (previous.assistantMode ?? 'demo') === mode;
  if (sameMode && previous) return { conversation: previous, created: false };
  const id = uid();
  return {
    conversation: {
      id,
      profileId: activeProfileId,
      title: clean.slice(0, 42) || 'New conversation',
      messages: [],
      assistantMode: mode,
    },
    created: true,
  };
}

export function MeProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<Persisted>(seed);
  const [status, setStatus] = useState<Status>('loading');
  const [saveError, setSaveError] = useState(false);
  const [onboardingSessionCompleted, setOnboardingSessionCompleted] = useState(false);
  const [typing, setTyping] = useState<Record<string, boolean>>({});
  const [chatErrors, setChatErrors] = useState<Record<string, string>>({});
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected');
  useEffect(() => {
    connectionStatusRef.current = connectionStatus;
  }, [connectionStatus]);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [enrollment, setEnrollment] = useState<EnrollmentSummary | null>(null);
  const [backend, setBackend] = useState<BackendState>({ backendUrl: '', memberHomes: [], presence: {}, backendError: null });
  const [tasksByConv, setTasksByConv] = useState<Record<string, TaskView[]>>({});
  const [tasksLoading, setTasksLoading] = useState<Record<string, boolean>>({});
  const [taskErrors, setTaskErrors] = useState<Record<string, string>>({});
  const [taskArtifacts, setTaskArtifacts] = useState<Record<string, TaskView['artifacts']>>({});
  const [activeCallId, setActiveCallId] = useState<string | null>(null);
  /** Last known credential identity; transitions re-scope cached home state. */
  const identityRef = useRef<IdentityTuple | null>(null);
  /** Monotonic identity generation: fences late async responses from a previous identity. */
  const identityGenerationRef = useRef(0);
  const [identityResolved, setIdentityResolved] = useState(false);

  const [account, setAccount] = useState<AccountState>({
    status: 'signed-out',
    accountId: null,
    issuer: null,
    backendUrl: null,
    claims: null,
    error: null,
  });
  const accountRef = useRef<AccountState>({
    status: 'signed-out',
    accountId: null,
    issuer: null,
    backendUrl: null,
    claims: null,
    error: null,
  });
  accountRef.current = account;
  const accountAttempt = useRef(0);

  const clientRef = useRef<PairedHomeClient | null>(null);
  const backendRef = useRef<BackendCoordinator | null>(null);
  const accountManagerRef = useRef<AccountAuthManager | null>(null);
  const secureRef = useRef<ReturnType<typeof createSecureStorage> | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const activeCallRef = useRef<string | null>(null);
  const connectionAttempt = useRef(0);
  const startupVerificationStarted = useRef(false);
  const [attempt, setAttempt] = useState(0);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  /**
   * Pending native sends keyed by idempotency UUID (offline/response-loss
   * outbox + accepted-but-unanswered overlay). `accepted` marks a 202 (or
   * timeout-unknown) POST the home may already hold — flush never resends
   * those (no forced resend of accepted work; same-key manual retry stays
   * idempotent server-side). `echoed` marks a server user-echo sighting.
   */
  const nativeOutboxRef = useRef<Record<string, {
    localId: string; channelId: string; agentId: string; text: string; scopeKey: string;
    accepted: boolean; echoed?: boolean;
  }>>({});
  /** Last seen server user-message ids per conversation (echo baseline). */
  const lastServerUserIdsRef = useRef<Record<string, Set<string>>>({});
  /** Last opened conversation for foreground/reconnect reconciliation. */
  const lastOpenRef = useRef<{ localId: string; channelId?: string; agentId?: string } | null>(null);
  const connectionStatusRef = useRef<ConnectionStatus>('disconnected');
  const pollers = useRef(new Map<string, { cancelled: boolean }>());
  const replyCount = useRef(0);
  const deletedConversationIds = useRef(new Set<string>());
  const tasksByConvRef = useRef<Record<string, TaskView[]>>({});
  tasksByConvRef.current = tasksByConv;
  // F8 notification lifecycle: dedupe lives here (portable, scoped) so tap +
  // foreground callbacks share one bounded cache; the Expo token itself is
  // never stored (SDK memory only, suffix-only UI).
  const [notifications, setNotifications] = useState<NotificationState>({
    enabled: false,
    permissionGranted: false,
    tokenSuffix: null,
    error: null,
    busy: false,
  });
  const notifDedupe = useRef(new NotificationDedupe());
  const notifEpoch = useRef(0);
  /** FULL upstream capability report (Task D). Null until the home reports OPTIONAL fields. */
  const [upstreamCapability, setUpstreamCapability] = useState<UpstreamCapability | null>(null);
  /**
   * True once a capability fetch COMPLETED for the current pairing (success
   * or honest failure). Distinguishes "old home that never reports fields"
   * (explicit legacy compat) from "not yet asked" (setup-needed for new
   * work, never silent legacy).
   */
  const [capabilityResolved, setCapabilityResolved] = useState(false);
  /** Requested owner: 'full' default; resolved old homes stay legacy compat. */
  const [requestedUpstreamMode, setRequestedUpstreamMode] = useState<RequestedUpstreamMode>('full');
  /** FULL native bot roster (Task D native REST). Null until refreshed. */
  const [upstreamBots, setUpstreamBots] = useState<NativeBot[] | null>(null);
  const [upstreamBotsLoading, setUpstreamBotsLoading] = useState(false);
  const [upstreamBotsError, setUpstreamBotsError] = useState<string | null>(null);
  /** Native upstream tasks per local conversation (verified /api/tasks). */
  const [nativeTasksByConv, setNativeTasksByConv] = useState<Record<string, NativeBotTask[]>>({});
  const [nativeTasksLoading, setNativeTasksLoading] = useState<Record<string, boolean>>({});
  const [nativeTasksError, setNativeTasksError] = useState<Record<string, string>>({});
  /** Personal native approvals inbox (verified GET /api/approvals). */
  const [nativeApprovals, setNativeApprovals] = useState<NativeApprovalInbox | null>(null);
  const [nativeApprovalsLoading, setNativeApprovalsLoading] = useState(false);
  const [nativeApprovalsError, setNativeApprovalsError] = useState<string | null>(null);
  const [nativeApprovalsBusy, setNativeApprovalsBusy] = useState<Record<string, boolean>>({});
  const [nativeAnswers, setNativeAnswers] = useState<Record<string, string>>({});
  const [nativeWatchState, setNativeWatchState] = useState<Record<string, 'watching' | 'stale'>>({});
  /** Transient channel-creation dedup (per scope + conversation). */
  const channelSingleflightRef = useRef(new ChannelSingleflight());
  /** Watch epochs: bumping stops the matching foreground watch. */
  const nativeWatchEpochRef = useRef<Record<string, number>>({});
  const nativeApprovalsRef = useRef<NativeApprovalInbox | null>(null);
  nativeApprovalsRef.current = nativeApprovals;
  const nativeAnswersRef = useRef<Record<string, string>>({});
  const decisionGateRef = useRef(new DecisionGate());
  const nativeTasksByConvRef = useRef<Record<string, NativeBotTask[]>>({});
  nativeTasksByConvRef.current = nativeTasksByConv;
  const requestedUpstreamModeRef = useRef<RequestedUpstreamMode>('full');
  requestedUpstreamModeRef.current = requestedUpstreamMode;
  const upstreamCapabilityRef = useRef<UpstreamCapability | null>(null);
  upstreamCapabilityRef.current = upstreamCapability;
  const capabilityResolvedRef = useRef(false);
  capabilityResolvedRef.current = capabilityResolved;
  const NATIVE_OUTBOX_KEY = 'me-native-outbox-v1';
  const clearNotificationsForScope = useCallback((scopeKey: string | null) => {
    if (scopeKey) notifDedupe.current.clearScope(scopeKey);
    else notifDedupe.current.clearAll();
    notifEpoch.current += 1;
    setNotifications({ enabled: false, permissionGranted: false, tokenSuffix: null, error: null, busy: false });
  }, []);

  const getClients = useCallback(() => {
    if (!clientRef.current || !backendRef.current || !secureRef.current || !accountManagerRef.current) {
      const secure = createSecureStorage();
      secureRef.current = secure;
      clientRef.current = createHomeClient(secure);
      backendRef.current = createBackendCoordinator(secure);
      accountManagerRef.current = new AccountAuthManager(secure, {
        allowInsecureLoopback: typeof __DEV__ !== 'undefined' && __DEV__,
      });
    }
    return {
      client: clientRef.current!,
      backend: backendRef.current!,
      accountManager: accountManagerRef.current!,
      secure: secureRef.current!,
    };
  }, []);

  const setChatError = useCallback((convId: string, message: string | null) => {
    setChatErrors((current) => {
      const next = { ...current };
      if (message === null) delete next[convId];
      else next[convId] = message;
      return next;
    });
  }, []);

  const tupleOf = (summary: EnrollmentSummary | null): IdentityTuple | null =>
    summary
      ? {
          userId: summary.userId,
          deviceId: summary.deviceId,
          installationId: summary.homeId,
          homeBaseUrl: summary.homeBaseUrl,
        }
      : null;

  /**
   * Generation fencing for late async responses: capture the identity
   * generation + scope token before an await, then refuse to publish any
   * result when either moved on (re-enrollment, revoke, logout, restart).
   */
  const captureScope = useCallback(() => ({
    gen: identityGenerationRef.current,
    token: scopeToken(identityRef.current),
  }), []);
  const scopeChanged = useCallback((captured: { gen: number; token: string }) =>
    captured.gen !== identityGenerationRef.current ||
    captured.token !== scopeToken(identityRef.current),
  []);

  /** Drop cached home state for the given local ids (server history stays).
   * F6 privacy: also drops per-task UI state (artifacts keyed by task id,
   * loading flags) for tasks that belonged to the dropped conversations, and
   * stops their bounded pollers — so no previous-scope preview/answer can
   * resurface after a FULL scope change or conversation delete. */
  const dropHomeState = useCallback((droppedLocalIds: string[]) => {
    if (droppedLocalIds.length === 0) return;
    const dropped = new Set(droppedLocalIds);
    droppedLocalIds.forEach((id) => deletedConversationIds.current.add(id));
    // Collect task ids that belonged to the dropped conversations so the
    // task-keyed artifact cache can be pruned too (not just conv-keyed maps).
    const droppedTaskIds = new Set<string>();
    for (const convId of dropped) {
      for (const task of tasksByConvRef.current[convId] ?? []) {
        if (task?.id) droppedTaskIds.add(task.id);
      }
    }
    // Stop bounded pollers for dropped conversations (fencing also covers
    // late responses, this just stops the timers promptly).
    for (const [key, handle] of pollers.current.entries()) {
      if ([...dropped].some((convId) => key.startsWith(`${convId}:`))) {
        handle.cancelled = true;
        pollers.current.delete(key);
      }
    }
    // FULL native (Task D): drop cached upstream channels for the same ids.
    // The home stays source authority; the next sync re-resolves from it.
    dropUpstreamNativeFor(droppedLocalIds);
    // Drop transient singleflight entries and stop foreground watches: a
    // deleted conversation never publishes, and a later resend starts fresh.
    for (const id of droppedLocalIds) {
      channelSingleflightRef.current.drop(id);
      stopNativeWatch(id);
    }
    // Drop native task views and pending outbox entries for the same ids;
    // a deleted conversation never replays a stale key under any identity.
    setNativeTasksByConv((current) => {
      const next = { ...current };
      for (const id of dropped) delete next[id];
      return next;
    });
    setNativeTasksLoading((current) => {
      const next = { ...current };
      for (const id of dropped) delete next[id];
      return next;
    });
    setNativeTasksError((current) => {
      const next = { ...current };
      for (const id of dropped) delete next[id];
      return next;
    });
    const outbox = nativeOutboxRef.current;
    if (Object.values(outbox).some((entry) => dropped.has(entry.localId))) {
      const next: typeof outbox = {};
      for (const [externalId, entry] of Object.entries(outbox)) {
        if (!dropped.has(entry.localId)) next[externalId] = entry;
      }
      nativeOutboxRef.current = next;
      persistNativeOutbox();
    }
    if (lastOpenRef.current && dropped.has(lastOpenRef.current.localId)) {
      lastOpenRef.current = null;
    }
    const lastIds = lastServerUserIdsRef.current;
    if (Object.keys(lastIds).some((id) => dropped.has(id))) {
      const nextLast: typeof lastIds = {};
      for (const [id, ids] of Object.entries(lastIds)) {
        if (!dropped.has(id)) nextLast[id] = ids;
      }
      lastServerUserIdsRef.current = nextLast;
    }
    setState((current) => {
      const links = { ...current.homeLinks };
      for (const id of dropped) delete links[id];
      return {
        ...current,
        homeLinks: links,
        conversations: current.conversations.filter((c) => !dropped.has(c.id)),
      };
    });
    setTasksByConv((current) => {
      const next = { ...current };
      for (const id of dropped) delete next[id];
      return next;
    });
    setTasksLoading((current) => {
      const next = { ...current };
      for (const id of dropped) delete next[id];
      return next;
    });
    setTaskArtifacts((current) => {
      if (droppedTaskIds.size === 0) return current;
      const next = { ...current };
      for (const taskId of droppedTaskIds) delete next[taskId];
      return next;
    });
    setTaskErrors((current) => {
      const next = { ...current };
      for (const id of dropped) delete next[id];
      return next;
    });
    setChatErrors((current) => {
      const next = { ...current };
      for (const id of dropped) delete next[id];
      return next;
    });
    setTyping((current) => {
      const next = { ...current };
      for (const id of dropped) delete next[id];
      return next;
    });
  }, []);

  /** Best-effort removal of the previous pairing's cached artifact files. */
  const clearArtifactCacheFor = useCallback((prev: IdentityTuple | null) => {
    if (!prev) return;
    void import('@/lib/artifact-store')
      .then((mod) => mod.clearScopedArtifactCache(prev).catch(() => {}))
      .catch(() => {});
  }, []);

  // -- hydration: AsyncStorage holds demo/cache state only, never secrets --
  useEffect(() => {
    let alive = true;
    setStatus('loading');
    (async () => {
      try {
        const [raw, linksRaw, outboxRaw] = await withStorageReadTimeout(Promise.all([
          AsyncStorage.getItem(KEY),
          AsyncStorage.getItem(HOME_LINKS_KEY),
          AsyncStorage.getItem(NATIVE_OUTBOX_KEY),
        ]));
        // Parse the native outbox now; scope-validate it below once the
        // credential tuple is known (previous-pairing entries are dropped,
        // never replayed under a new family).
        let restoredOutbox: typeof nativeOutboxRef.current = {};
        try {
          const parsed = outboxRaw ? (JSON.parse(outboxRaw) as {
            scopeKey?: unknown;
            entries?: unknown;
          }) : null;
          if (parsed && typeof parsed === 'object' && parsed.entries && typeof parsed.entries === 'object') {
            restoredOutbox = parsed.entries as typeof nativeOutboxRef.current;
            void parsed.scopeKey;
          }
        } catch {
          restoredOutbox = {};
        }
        if (!alive) return;
        let fileLinks: Record<string, HomeLink> = {};
        try {
          fileLinks = linksRaw ? (JSON.parse(linksRaw) as Record<string, HomeLink>) : {};
        } catch {
          fileLinks = {};
        }
        // Build the full hydrated object locally — nothing is published yet.
        const base = seed();
        let hydrated: Persisted = { ...base, homeLinks: fileLinks };
        if (raw) {
          const parsed = JSON.parse(raw) as Partial<Persisted>;
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('Saved data is invalid.');
          }
          // Fail closed on malformed records: a corrupt saved conversation
          // is a read error (saved bytes preserved), never a rendered chat.
          if (parsed.conversations !== undefined) {
            assertValidSavedConversations(parsed.conversations);
          }
          const savedSettings = parsed.settings as Partial<Settings> | undefined;
          const migratedSettings: Settings = {
            ...base.settings,
            ...savedSettings,
            assistantMode: savedSettings?.assistantMode === 'home' ? 'home' : 'demo',
            homeUrl: typeof savedSettings?.homeUrl === 'string' ? savedSettings.homeUrl : '',
          };
          hydrated = {
            ...base,
            ...parsed,
            settings: migratedSettings,
            // A saved snapshot without a conversations key holds NO
            // conversations — never resurrect the seeded demo chats.
            conversations: parsed.conversations !== undefined ? parsed.conversations : [],
            homeLinks: { ...fileLinks, ...(parsed.homeLinks ?? {}) },
            onboardingCompleted: typeof parsed.onboardingCompleted === 'boolean' ? parsed.onboardingCompleted : true,
          };
        }
        // Load the credential tuple BEFORE first publication, then sanitize
        // the hydrated object against the FULL scope: same username on a
        // different installation/device/endpoint keeps nothing, and legacy
        // links without a complete scope stamp are dropped, not trusted.
        const { client, backend: coordinator, accountManager } = getClients();
        const summary = await client.summary().catch(() => null);
        if (!alive) return;
        const tuple = tupleOf(summary);
        const sanitized = filterStateToScope(
          hydrated.conversations,
          hydrated.homeLinks,
          tuple,
        );
        identityRef.current = tuple;
        identityGenerationRef.current += 1;
        // Keep only outbox entries stamped for this exact scope.
        const outboxScope = scopeToken(tuple);
        const scopedEntries: typeof nativeOutboxRef.current = {};
        for (const [externalId, entry] of Object.entries(restoredOutbox)) {
          if (
            entry &&
            typeof entry === 'object' &&
            typeof (entry as { localId?: unknown }).localId === 'string' &&
            typeof (entry as { channelId?: unknown }).channelId === 'string' &&
            typeof (entry as { agentId?: unknown }).agentId === 'string' &&
            typeof (entry as { text?: unknown }).text === 'string' &&
            (entry as { scopeKey?: unknown }).scopeKey === outboxScope
          ) {
            const restored = entry as (typeof nativeOutboxRef.current)[string];
            scopedEntries[externalId] = {
              ...restored,
              accepted: restored.accepted === true,
              ...(restored.echoed === true ? { echoed: true as const } : {}),
            };
          }
        }
        nativeOutboxRef.current = scopedEntries;
        setIdentityResolved(true);
        setEnrollment(summary);
        setState({ ...hydrated, conversations: sanitized.conversations, homeLinks: sanitized.links });
        const backendConfig = await coordinator.backendConfig().catch(() => null);
        if (!alive) return;
        if (backendConfig) {
          setBackend((current) => ({ ...current, backendUrl: backendConfig.backendUrl }));
        }
        // Restore the verified cloud account (SecureStore only, never the
        // AsyncStorage cache). Cloud expiry/offline never clears home here;
        // only an explicit logout or a verified identity change does.
        const bundle = await accountManager.loadBundle().catch(() => null);
        if (!alive) return;
        if (bundle) {
          setAccount({
            status: 'signed-in',
            accountId: bundle.accountId,
            issuer: bundle.issuer,
            backendUrl: bundle.backendUrl,
            claims: null,
            error: null,
          });
          setBackend((current) => ({
            ...current,
            backendUrl: current.backendUrl || bundle.backendUrl,
          }));
        }
        setStatus('ready');
      } catch {
        if (alive) setStatus('error');
      }
    })();
    return () => {
      alive = false;
    };
  }, [attempt, getClients]);

  // -- persist cache state (never secrets) after hydration --
  useEffect(() => {
    if (status !== 'ready') return;
    AsyncStorage.setItem(KEY, JSON.stringify(state))
      .then(() => setSaveError(false))
      .catch(() => setSaveError(true));
    AsyncStorage.setItem(HOME_LINKS_KEY, JSON.stringify(state.homeLinks)).catch(() => setSaveError(true));
  }, [state, status]);

  useEffect(() => {
    const map = timers.current;
    return () => map.forEach((timer) => clearTimeout(timer));
  }, []);

  const verifyHomeConnection = useCallback(async () => {
    const attemptId = ++connectionAttempt.current;
    setConnectionStatus('connecting');
    setConnectionError(null);
    try {
      const { client } = getClients();
      const summary = await client.summary();
      if (!summary) {
        if (connectionAttempt.current !== attemptId) return;
        setEnrollment(null);
        setConnectionStatus('disconnected');
        return;
      }
      // Renew the short-lived session from the stored device credential
      // (never repeats enrollment), then verify the live endpoint.
      try {
        await client.renewSession();
      } catch (error) {
        if (error instanceof HomeClientError && error.code === 'UNPAIRED') {
          // No usable session yet; health check decides reachability.
        } else {
          throw error;
        }
      }
      await client.checkHealth();
      if (connectionAttempt.current !== attemptId) return;
      const fresh = await client.summary().catch(() => summary);
      const freshTuple = tupleOf(fresh);
      // The identity may have changed mid-flight (re-enrollment elsewhere);
      // bind to whatever is current now rather than the stale snapshot.
      if (freshTuple && scopeToken(freshTuple) !== scopeToken(identityRef.current)) {
        identityRef.current = freshTuple;
        identityGenerationRef.current += 1;
      }
      setEnrollment(fresh);
      setConnectionStatus('connected');
      setConnectionError(null);
      // FULL native mode (Task D): read the home's OPTIONAL upstream
      // capability report now that the session is live. Absence (null) is
      // unknown, not an error — the selection derives setup-needed honestly.
      // A newer scope winning mid-flight drops this result. Resolution is
      // marked complete even on honest failure so resolved old homes fall
      // back to explicit legacy compat instead of blocking.
      // Bind the native scope cache to the verified identity as well.
      upstreamNativeScope().bindScope(scopeToken(tupleOf(fresh)));
      try {
        const fetched = await client.fetchUpstreamCapability().catch(() => null);
        if (connectionAttempt.current !== attemptId) return;
        setUpstreamCapability(fetched);
        setCapabilityResolved(true);
      } catch {
        // Capability is additive; the connection itself already succeeded.
        if (connectionAttempt.current === attemptId) setCapabilityResolved(true);
      }
    } catch (error) {
      if (connectionAttempt.current !== attemptId) return;
      // Unreachable/unpaired homes cannot confirm FULL: resolve to explicit
      // legacy compat so queued legacy work still sends; a later successful
      // verify refetches and upgrades to full when the home reports it.
      setCapabilityResolved(true);
      if (error instanceof HomeClientError && error.code === 'HOME_OFFLINE') {
        setConnectionStatus('offline');
        setConnectionError('Me Home is unreachable. It may be powered off or offline; queued messages will send on reconnect.');
      } else if (error instanceof HomeClientError && (error.code === 'DEVICE_REVOKED' || error.code === 'UNPAIRED')) {
        setConnectionStatus('error');
        setEnrollment(await getClients().client.summary().catch(() => null));
        setConnectionError(errorMessage(error));
      } else {
        setConnectionStatus('error');
        setConnectionError(errorMessage(error));
      }
    }
  }, [getClients]);

  // Re-verify after app startup; saved configuration is not a live connection.
  useEffect(() => {
    if (status !== 'ready' || startupVerificationStarted.current) return;
    startupVerificationStarted.current = true;
    if (stateRef.current.settings.assistantMode !== 'home') return;
    void verifyHomeConnection();
  }, [status, verifyHomeConnection]);

  // -- FULL native upstream (Task D native REST, pin 6bfee78) --
  //
  // Upstream owns conversations/history/tasks; the phone keeps a thin cache.
  // Routing is per-conversation: links stamped with `upstreamAgentId` use
  // the native delivery API (channel id in `homeId`); all others use the
  // legacy /v1 path. New sends follow the requested selection: FULL creates
  // native channels, legacy keeps /v1, setup-needed refuses honestly.
  // All network/cache/state work below is fenced against the immutable
  // captured scope (P0): a logout/re-pair mid-await never publishes the OLD
  // family's channel, cache entry, message, or state under a NEW identity.
  const currentUpstreamSelection = useCallback(() => {
    if (stateRef.current.settings.assistantMode === 'demo') return 'demo' as const;
    return resolveAppSelection({
      assistantMode: 'home',
      requested: requestedUpstreamModeRef.current,
      capability: upstreamCapabilityRef.current,
      capabilityResolved: capabilityResolvedRef.current,
    });
  }, []);

  const isNativeConversation = useCallback((convId: string | null): boolean => {
    if (!convId) return false;
    return (stateRef.current.homeLinks[convId]?.upstreamAgentId?.length ?? 0) > 0;
  }, []);

  /**
   * Fence adapter over the generation + scope-token capture. `isCurrent`
   * checks the capture against the LIVE identity (not against a stale
   * copy), so any enroll/revoke/unpair/switch that lands mid-await fences
   * every downstream cache write, state mutation, and follow-up request.
   */
  const fenceFor = useCallback((fenced: { gen: number; token: string }) => ({
    capture: () => ({ generation: fenced.gen, scopeKey: fenced.token }),
    isCurrent: (captured: { generation: number; scopeKey: string }) =>
      !scopeChanged({ gen: captured.generation, token: captured.scopeKey }),
  }), [scopeChanged]);

  const nativeSleep = useCallback((ms: number) => new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  }), []);

  /** Persist the native outbox (idempotent retry keys survive restart). */
  const persistNativeOutbox = useCallback(() => {
    const payload = JSON.stringify({
      scopeKey: scopeToken(identityRef.current),
      entries: nativeOutboxRef.current,
    });
    AsyncStorage.setItem(NATIVE_OUTBOX_KEY, payload).catch(() => {});
  }, [NATIVE_OUTBOX_KEY]);

  const refreshUpstreamBots = useCallback(async () => {
    const { client } = getClients();
    const fenced = captureScope();
    const fence = fenceFor(fenced);
    const captured = fence.capture();
    setUpstreamBotsLoading(true);
    setUpstreamBotsError(null);
    try {
      const native = createUpstreamNative(client);
      const bots = await native.listAgents();
      if (!fence.isCurrent(captured)) return;
      upstreamNativeScope().noteBots(bots);
      setUpstreamBots(bots);
      setUpstreamBotsError(null);
    } catch (error) {
      if (!fence.isCurrent(captured)) return;
      setUpstreamBotsError(errorMessage(error));
    } finally {
      if (fence.isCurrent(captured)) setUpstreamBotsLoading(false);
    }
  }, [getClients, captureScope, fenceFor]);

  /**
   * Resolve (or create) the upstream channel for a local conversation via
   * the portable controller. Concurrent initial sends share ONE in-flight
   * creation (per scope + conversation singleflight), so rapid parallel
   * sends bind the SAME channel instead of creating two. Fenced before
   * AND after every await (P0): the identity is never re-read after an
   * await; cache writes and state mutations publish only when the
   * ORIGINAL scope still holds.
   */
  const ensureUpstreamChannel = useCallback(async (
    localId: string,
    title: string,
  ): Promise<ChannelBinding> => {
    const { client } = getClients();
    const fenced = captureScope();
    const fence = fenceFor(fenced);
    const captured = fence.capture();
    const existing = stateRef.current.homeLinks[localId];
    const controller = new NativeConversationController(
      createUpstreamNative(client),
      randomUuidV4,
    );
    const binding = await channelSingleflightRef.current.bind(
      fenced.token,
      localId,
      () => controller.ensureBinding(
        existing?.homeId && existing?.upstreamAgentId
          ? { channelId: existing.homeId, agentId: existing.upstreamAgentId }
          : null,
        fence,
      ),
    );
    if (!fence.isCurrent(captured) || deletedConversationIds.current.has(localId)) {
      throw new HomeClientError(
        'UPSTREAM_SCOPE_RESET',
        'The scope changed during the upstream turn; the result was dropped.',
      );
    }
    const scope = identityRef.current;
    upstreamNativeScope().noteChannel(localId, {
      id: binding.channelId,
      name: title,
      agentIds: [binding.agentId],
      active: true,
    });
    setState((current) => ({
      ...current,
      homeLinks: {
        ...current.homeLinks,
        [localId]: mergeLinkMetadata(current.homeLinks[localId] ?? { homeId: '' }, {
          homeId: binding.channelId,
          upstreamAgentId: binding.agentId,
          ...(scope
            ? {
                homeOwner: scope.userId,
                homeInstallationId: scope.installationId,
                homeDeviceId: scope.deviceId,
                homeBaseUrl: scope.homeBaseUrl,
              }
            : {}),
        }),
      },
    }));
    return binding;
  }, [getClients, captureScope, fenceFor]);

  /**
   * Publish upstream-authoritative history with the accepted-but-unanswered
   * overlay. `receiveNative` only queues (`offerInbox`); the Intelligence
   * echo/turn lands asynchronously, so an accepted optimistic bubble must
   * NOT be erased merely because history is behind. Displayed messages are
   * the server list plus pending outbox bubbles for this conversation that
   * are neither echoed nor answered. Pending entries are keyed by
   * idempotency UUID (never text matching — repeated same-content sends
   * keep distinct bubbles and retire oldest-first on echo count). This is
   * overlay UX only: the server list is never rewritten, accepted work is
   * never force-resent, and older polls can only shrink the overlay by the
   * new-echo count, never erase server turns.
   */
  const publishNativeHistory = useCallback((
    localId: string,
    history: NativeTranscriptMessage[],
    answered: boolean,
  ) => {
    const serverUserIds = new Set<string>();
    for (const message of history) {
      if (message.role === 'user') serverUserIds.add(message.id);
    }
    const previous = lastServerUserIdsRef.current[localId];
    let newEchoes = 0;
    if (previous) {
      for (const id of serverUserIds) {
        if (!previous.has(id)) newEchoes += 1;
      }
    }
    lastServerUserIdsRef.current = { ...lastServerUserIdsRef.current, [localId]: serverUserIds };
    const entries = Object.entries(nativeOutboxRef.current).filter(
      ([, entry]) => entry.localId === localId,
    );
    // Single source of truth for the overlay rules (tested in
    // reconcilePendingSends): answered clears, otherwise oldest-first echo
    // retirement bounded by the new-echo count, nothing without a baseline.
    const kept = new Set(
      reconcilePendingSends(
        entries.map(([externalId]) => ({ externalId })),
        { answered, newUserEchoes: newEchoes, hadBaseline: previous !== undefined },
      ).map((entry) => entry.externalId),
    );
    let outboxChanged = false;
    if (answered && entries.length > 0) {
      // Turn completed: the server is authoritative from here.
      const next = { ...nativeOutboxRef.current };
      for (const [externalId] of entries) delete next[externalId];
      nativeOutboxRef.current = next;
      outboxChanged = true;
    } else if (!answered) {
      for (const [externalId, entry] of entries) {
        if (!entry.echoed && !kept.has(externalId)) {
          const next = { ...nativeOutboxRef.current };
          next[externalId] = { ...next[externalId], echoed: true };
          nativeOutboxRef.current = next;
          outboxChanged = true;
        }
      }
    }
    if (outboxChanged) persistNativeOutbox();
    const serverMapped: Message[] = toDisplayMessages(history, Date.now());
    const overlay: Message[] = [];
    for (const [externalId, entry] of Object.entries(nativeOutboxRef.current)) {
      if (entry.localId !== localId || entry.echoed) continue;
      overlay.push({ id: `pending-${externalId}`, role: 'user', text: entry.text, createdAt: Date.now() });
    }
    const scope = identityRef.current;
    setState((current) => ({
      ...current,
      homeLinks: scope ? stampLinkScope(current.homeLinks, localId, scope) : current.homeLinks,
      conversations: current.conversations.map((item) =>
        item.id === localId ? { ...item, messages: [...serverMapped, ...overlay] } : item,
      ),
    }));
    setChatError(localId, null);
  }, [persistNativeOutbox]);

  /** Hydrate a conversation from upstream-authoritative native history. */
  const hydrateNativeConversation = useCallback(async (
    localId: string,
    channelId: string,
    agentId: string,
  ) => {
    const { client } = getClients();
    const fenced = captureScope();
    const fence = fenceFor(fenced);
    const captured = fence.capture();
    setTyping((current) => ({ ...current, [localId]: true }));
    try {
      const native = createUpstreamNative(client);
      const history = await native.getHistory(channelId, agentId);
      if (!fence.isCurrent(captured) || deletedConversationIds.current.has(localId)) return;
      publishNativeHistory(localId, history, false);
    } catch (error) {
      if (!fence.isCurrent(captured) || deletedConversationIds.current.has(localId)) return;
      setChatError(localId, errorMessage(error));
    } finally {
      if (!fence.isCurrent(captured) || deletedConversationIds.current.has(localId)) return;
      setTyping((current) => {
        const next = { ...current };
        delete next[localId];
        return next;
      });
    }
  }, [getClients, setChatError, captureScope, fenceFor, publishNativeHistory]);

  /**
   * Refresh verified native tasks for a conversation (fixes
   * openConversation returning before tasks load: native questions/
   * approvals/tasks surface without a manual revisit). Fenced like every
   * other native call; another household member's tasks never leak (the
   * home scopes the list per owner, the phone additionally filters by the
   * bound channel id).
   */
  const refreshNativeTasks = useCallback(async (localId: string) => {
    const { client } = getClients();
    const link = stateRef.current.homeLinks[localId];
    if (!link?.homeId || !link?.upstreamAgentId) return;
    const fenced = captureScope();
    const fence = fenceFor(fenced);
    const captured = fence.capture();
    const channelId = link.homeId;
    setNativeTasksLoading((current) => ({ ...current, [localId]: true }));
    try {
      const native = createUpstreamNative(client);
      const all = await native.listNativeTasks();
      if (!fence.isCurrent(captured) || deletedConversationIds.current.has(localId)) return;
      const mine = all.filter((task) => task.channelId === channelId);
      setNativeTasksByConv((current) => ({ ...current, [localId]: mine }));
      setNativeTasksError((current) => {
        const next = { ...current };
        delete next[localId];
        return next;
      });
    } catch (error) {
      if (!fence.isCurrent(captured) || deletedConversationIds.current.has(localId)) return;
      setNativeTasksError((current) => ({ ...current, [localId]: errorMessage(error) }));
    } finally {
      if (!fence.isCurrent(captured) || deletedConversationIds.current.has(localId)) return;
      setNativeTasksLoading((current) => {
        const next = { ...current };
        delete next[localId];
        return next;
      });
    }
  }, [getClients, captureScope, fenceFor]);

  /**
   * Refresh the personal native inbox (verified GET /api/approvals).
   * Fenced: another user's requests never publish here (the home scopes
   * per owner AND the fence drops late callbacks after any scope change).
   */
  const refreshNativeApprovals = useCallback(async () => {
    const { client } = getClients();
    const fenced = captureScope();
    const fence = fenceFor(fenced);
    const captured = fence.capture();
    setNativeApprovalsLoading(true);
    try {
      const native = createUpstreamNative(client);
      const inbox = await native.getNativeApprovals();
      if (!fence.isCurrent(captured)) return;
      setNativeApprovals(inbox);
      setNativeApprovalsError(null);
    } catch (error) {
      if (!fence.isCurrent(captured)) return;
      setNativeApprovalsError(errorMessage(error));
    } finally {
      if (!fence.isCurrent(captured)) return;
      setNativeApprovalsLoading(false);
    }
  }, [getClients, captureScope, fenceFor]);

  /**
   * Release exactly the captured lease: the generation-guarded gate ignores
   * a stale release when the same id was re-acquired under a new scope, so
   * an old finally can never unlock new work. Busy-state writes happen only
   * when the captured scope still holds (no React writes when stale).
   */
  const releaseNativeDecision = useCallback((
    id: string,
    owner: number,
    isCurrent: boolean,
  ) => {
    decisionGateRef.current.release(id, owner);
    if (!isCurrent) return;
    setNativeApprovalsBusy((current) => {
      if (!(id in current)) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
  }, []);

  /**
   * Explicit approval decision (verified POST decision). Per-request busy
   * guard: double-tap never fires a second decision. Refreshes the inbox
   * after (approvals.tsx calls inbox.refresh() after every decision).
   * Client/fence capture and gate acquisition all happen inside the guarded
   * region: a throw before acquisition leaks nothing, and a stale finally
   * neither unlocks new work nor writes state.
   */
  const decideNativeApproval = useCallback(async (
    requestId: string,
    decision: NativeApprovalDecision,
  ) => {
    const { client } = getClients();
    const fenced = captureScope();
    const fence = fenceFor(fenced);
    const captured = fence.capture();
    let acquired = false;
    try {
      // Double-tap guard bound to this scope generation: the second tap in
      // the same frame is refused even before the disabled button re-renders.
      acquired = decisionGateRef.current.tryAcquire(requestId, fenced.gen);
      if (!acquired) return;
      setNativeApprovalsBusy((current) => ({ ...current, [requestId]: true }));
      const native = createUpstreamNative(client);
      await native.decideNativeApproval(requestId, decision);
      if (!fence.isCurrent(captured)) return;
      await refreshNativeApprovals();
    } catch (error) {
      if (!fence.isCurrent(captured)) return;
      setNativeApprovalsError(errorMessage(error));
    } finally {
      if (acquired) releaseNativeDecision(requestId, fenced.gen, fence.isCurrent(captured));
    }
  }, [getClients, captureScope, fenceFor, refreshNativeApprovals, releaseNativeDecision]);

  const setNativeAnswer = useCallback((questionId: string, answer: string) => {
    nativeAnswersRef.current = { ...nativeAnswersRef.current, [questionId]: answer };
    setNativeAnswers((current) => ({ ...current, [questionId]: answer }));
  }, []);

  /** Explicit question answer (verified POST respond with the draft text). */
  const respondNativeQuestion = useCallback(async (questionId: string) => {
    const { client } = getClients();
    const fenced = captureScope();
    const fence = fenceFor(fenced);
    const captured = fence.capture();
    let acquired = false;
    try {
      acquired = decisionGateRef.current.tryAcquire(questionId, fenced.gen);
      if (!acquired) return;
      const response = nativeAnswersRef.current[questionId] ?? '';
      setNativeApprovalsBusy((current) => ({ ...current, [questionId]: true }));
      const native = createUpstreamNative(client);
      await native.respondNativeQuestion(questionId, response);
      if (!fence.isCurrent(captured)) return;
      nativeAnswersRef.current = { ...nativeAnswersRef.current };
      delete nativeAnswersRef.current[questionId];
      setNativeAnswers((current) => {
        const next = { ...current };
        delete next[questionId];
        return next;
      });
      await refreshNativeApprovals();
    } catch (error) {
      if (!fence.isCurrent(captured)) return;
      setNativeApprovalsError(errorMessage(error));
    } finally {
      if (acquired) releaseNativeDecision(questionId, fenced.gen, fence.isCurrent(captured));
    }
  }, [getClients, captureScope, fenceFor, refreshNativeApprovals, releaseNativeDecision]);

  /** Fenced raw history read (no state writes): watch terminal checks. */
  const peekNativeHistory = useCallback(async (
    channelId: string,
    agentId: string,
    fence: { isCurrent: (captured: { generation: number; scopeKey: string }) => boolean },
    captured: { generation: number; scopeKey: string },
  ) => {
    const { client } = getClients();
    try {
      const native = createUpstreamNative(client);
      const history = await native.getHistory(channelId, agentId);
      if (!fence.isCurrent(captured)) return null;
      return history;
    } catch {
      // Transient: the watch keeps going on last-known state.
      return null;
    }
  }, [getClients]);

  const stopNativeWatch = useCallback((localId: string) => {
    nativeWatchEpochRef.current = {
      ...nativeWatchEpochRef.current,
      [localId]: (nativeWatchEpochRef.current[localId] ?? 0) + 1,
    };
    setNativeWatchState((current) => {
      if (!(localId in current)) return current;
      const next = { ...current };
      delete next[localId];
      return next;
    });
  }, []);

  const stopAllNativeWatches = useCallback(() => {
    const next: Record<string, number> = {};
    for (const localId of Object.keys(nativeWatchEpochRef.current)) {
      next[localId] = (nativeWatchEpochRef.current[localId] ?? 0) + 1;
    }
    nativeWatchEpochRef.current = next;
    setNativeWatchState({});
  }, []);

  /**
   * One bounded foreground watch per conversation (review item 3): re-reads
   * actual history/tasks/inbox with backoff until the work is terminal,
   * then settles; ceiling sets an honest manual-refresh state. Exactly one
   * runner per conversation (epoch-guarded); per-send watchers are never
   * created. No model spend — reads only. Stops on scope change, delete,
   * logout, and background.
   */
  const startNativeWatch = useCallback((localId: string, channelId: string, agentId: string) => {
    const epoch = (nativeWatchEpochRef.current[localId] ?? 0) + 1;
    nativeWatchEpochRef.current = { ...nativeWatchEpochRef.current, [localId]: epoch };
    setNativeWatchState((current) => ({ ...current, [localId]: 'watching' }));
    const fenced = captureScope();
    const fence = fenceFor(fenced);
    const watchFence = {
      capture: () => ({ generation: fenced.gen, scopeKey: fenced.token }),
      isCurrent: (captured: { generation: number; scopeKey: string }) =>
        !scopeChanged({ gen: captured.generation, token: captured.scopeKey }) &&
        !deletedConversationIds.current.has(localId) &&
        nativeWatchEpochRef.current[localId] === epoch,
    };
    void runNativeWatch({
      fence: watchFence,
      wait: nativeSleep,
      poll: async () => {
        await hydrateNativeConversation(localId, channelId, agentId);
        await refreshNativeTasks(localId);
        await refreshNativeApprovals();
        const capturedPoll = watchFence.capture();
        const history = await peekNativeHistory(channelId, agentId, watchFence, capturedPoll);
        const tasks = (nativeTasksByConvRef.current[localId] ?? []).filter(
          (task) => task.channelId === channelId,
        );
        const inbox = nativeApprovalsRef.current;
        const pendingApprovals = (inbox?.requests ?? []).filter(
          (request) => request.status === 'pending',
        ).length;
        const questions = (inbox?.questions ?? []).length;
        return !isNativeWorkPending({
          history: history ?? [],
          tasks,
          pendingApprovalCount: pendingApprovals,
          unansweredQuestionCount: questions,
        });
      },
      onStale: () => {
        stopNativeWatch(localId);
      },
    }).then((outcome) => {
      if (outcome === 'ceiling') {
        setNativeWatchState((current) => ({ ...current, [localId]: 'stale' }));
      } else if (outcome === 'settled') {
        stopNativeWatch(localId);
      }
    });
  }, [
    captureScope,
    fenceFor,
    nativeSleep,
    scopeChanged,
    hydrateNativeConversation,
    refreshNativeTasks,
    refreshNativeApprovals,
    peekNativeHistory,
    stopNativeWatch,
  ]);

  /** POST /api/tasks/:id/again for a native task, then refresh its conversation. */
  const retryNativeTask = useCallback(async (taskId: string) => {
    const { client } = getClients();
    const fenced = captureScope();
    const fence = fenceFor(fenced);
    const captured = fence.capture();
    const convId = Object.entries(nativeTasksByConvRef.current).find(([, tasks]) =>
      tasks.some((task) => task.id === taskId),
    )?.[0];
    try {
      const native = createUpstreamNative(client);
      await native.retryNativeTask(taskId);
      if (!fence.isCurrent(captured)) return;
      if (convId) await refreshNativeTasks(convId);
    } catch (error) {
      if (!fence.isCurrent(captured)) return;
      if (convId) {
        setNativeTasksError((current) => ({ ...current, [convId]: errorMessage(error) }));
      }
    }
  }, [getClients, captureScope, fenceFor, refreshNativeTasks]);

  /**
   * POST-202-then-poll send via the portable controller: the single
   * immediate GET after a 202 normally has no assistant yet, so poll
   * history (bounded, scope-fenced) until the answer lands. Response-loss
   * and offline sends keep the SAME externalId in the outbox — never a
   * duplicate, never a "not run" claim that cannot be known.
   */
  const requestNativeSend = useCallback(async (
    localId: string,
    channelId: string,
    agentId: string,
    text: string,
    externalId: string,
  ) => {
    const { client } = getClients();
    const fenced = captureScope();
    const fence = fenceFor(fenced);
    const captured = fence.capture();
    setTyping((current) => ({ ...current, [localId]: true }));
    setChatError(localId, null);
    const outboxScopeKey = fenced.token;
    try {
      const controller = new NativeConversationController(
        createUpstreamNative(client),
        randomUuidV4,
      );
      // Remember BEFORE the POST: a kill between accept and response still retries idempotently.
      nativeOutboxRef.current = {
        ...nativeOutboxRef.current,
        [externalId]: { localId, channelId, agentId, text, scopeKey: outboxScopeKey, accepted: false },
      };
      persistNativeOutbox();
      const result = await controller.sendAndSync({
        channelId,
        agentId,
        text,
        requestKey: externalId,
        fence,
        sleep: nativeSleep,
      });
      if (!fence.isCurrent(captured) || deletedConversationIds.current.has(localId)) return;
      // Accepted (202 or polled): the home may hold it, so mark accepted —
      // flush never resends accepted work, and the entry now only feeds the
      // overlay until the turn completes. Removal happens in publish on
      // answered/echoed, never on mere acceptance.
      nativeOutboxRef.current = {
        ...nativeOutboxRef.current,
        [externalId]: { localId, channelId, agentId, text, scopeKey: outboxScopeKey, accepted: true },
      };
      persistNativeOutbox();
      // Publish with the overlay: the accepted bubble stays visible until
      // the server echo/turn actually lands (history is often behind here).
      publishNativeHistory(localId, result.history, result.answered);
      // The polled answer may still be pending server-side; refresh tasks
      // and the inbox so native questions/approvals surface without a
      // manual revisit. Long research (>12s) continues under ONE bounded
      // foreground watch per conversation (no per-send watchers).
      void refreshNativeTasks(localId);
      void refreshNativeApprovals();
      if (!result.answered) {
        startNativeWatch(localId, channelId, agentId);
      }
    } catch (error) {
      if (!fence.isCurrent(captured) || deletedConversationIds.current.has(localId)) return;
      if (error instanceof HomeClientError && error.code === 'UPSTREAM_SCOPE_RESET') return;
      if (
        error instanceof HomeClientError &&
        (error.code === 'HOME_OFFLINE' || error.code === 'TIMEOUT')
      ) {
        setConnectionStatus((current) => (current === 'connected' ? 'offline' : current));
        setChatError(
          localId,
          'Delivery not confirmed — it may or may not have run upstream. Retry sends with the same ID so it will not duplicate.',
        );
      } else {
        setChatError(localId, errorMessage(error));
        setConnectionStatus((current) => (current === 'connected' ? current : 'error'));
      }
    } finally {
      if (!fence.isCurrent(captured) || deletedConversationIds.current.has(localId)) return;
      setTyping((current) => {
        const next = { ...current };
        delete next[localId];
        return next;
      });
    }
  }, [getClients, setChatError, captureScope, fenceFor, nativeSleep, persistNativeOutbox, refreshNativeTasks, refreshNativeApprovals, startNativeWatch]);

  /**
   * Flush device-queued messages after reconnect (same request_keys, no
   * duplicates). Routes by link kind (P0): native links resend through the
   * native delivery API with the SAME idempotency UUID (the legacy
   * client.sendMessage path would target the wrong engine with the wrong
   * id), then re-hydrate; native links without pending outbox entries
   * still re-hydrate to reconcile answers missed while offline. Legacy
   * links keep the existing cache-queue flush.
   */
  const flushQueued = useCallback(async () => {
    const { client } = getClients();
    const fenced = captureScope();
    const fence = fenceFor(fenced);
    const captured = fence.capture();
    const links = stateRef.current.homeLinks;
    for (const [localId, link] of Object.entries(links)) {
      if (!fence.isCurrent(captured) || deletedConversationIds.current.has(localId)) return;
      if (link.upstreamAgentId && link.homeId) {
        const channelId = link.homeId;
        const agentId = link.upstreamAgentId;
        try {
          // Resend only entries never confirmed accepted: accepted work is
          // never force-resent (the server dedupes by externalId, but the
          // phone does not re-fire turns on its own).
          const pending = Object.entries(nativeOutboxRef.current).filter(
            ([, entry]) => entry.localId === localId && !entry.accepted,
          );
          for (const [externalId, entry] of pending) {
            if (!fence.isCurrent(captured) || deletedConversationIds.current.has(localId)) return;
            try {
              await requestNativeSend(localId, channelId, agentId, entry.text, externalId);
            } catch {
              // Stays in the outbox; the next reconnect or manual retry handles it.
            }
          }
          // Reconcile answers missed while offline even with nothing pending.
          await hydrateNativeConversation(localId, channelId, agentId);
        } catch {
          // Per-conversation best effort; connection state already reflects reachability.
        }
        continue;
      }
      try {
        const cached = await client.readCachedConversation(link.homeId);
        if (scopeChanged(fenced) || deletedConversationIds.current.has(localId)) return;
        const queued = (cached?.messages ?? []).filter((m) => m.pending && m.role === 'user');
        for (const message of queued) {
          if (scopeChanged(fenced) || deletedConversationIds.current.has(localId)) return;
          const key = message.requestId ?? randomUuidV4();
          try {
            await client.sendMessage(link.homeId, message.text, { requestKey: key });
          } catch {
            // Stays queued; the next reconnect or manual retry handles it.
          }
        }
        if (queued.length > 0) {
          const snapshot = await client.syncConversation(link.homeId).catch(() => null);
          if (!snapshot || scopeChanged(fenced) || deletedConversationIds.current.has(localId)) continue;
          const mapped = snapshot.messages.map(toLocalMessage).filter((m): m is Message => m !== null);
          const scope = identityRef.current;
          setState((current) => ({
            ...current,
            homeLinks: scope ? stampLinkScope(current.homeLinks, localId, scope) : current.homeLinks,
            conversations: current.conversations.map((item) =>
              item.id === localId ? { ...item, messages: mapped } : item,
            ),
          }));
          setChatError(localId, null);
        }
      } catch {
        // Per-conversation best effort; connection state already reflects reachability.
      }
    }
    // One inbox refresh after reconnect (fenced): decisions/answers made on
    // another device appear without reopening each conversation.
    if (fence.isCurrent(captured)) {
      await refreshNativeApprovals();
    }
  }, [getClients, setChatError, captureScope, scopeChanged, fenceFor, requestNativeSend, hydrateNativeConversation, refreshNativeApprovals]);

  useEffect(() => {
    if (connectionStatus === 'connected') {
      void flushQueued();
    }
  }, [connectionStatus, flushQueued]);

  const clearTimer = (convId: string) => {
    const timer = timers.current.get(convId);
    if (timer) clearTimeout(timer);
    timers.current.delete(convId);
    setTyping((previous) => {
      const next = { ...previous };
      delete next[convId];
      return next;
    });
  };

  const activeProfile = state.profiles.find((profile) => profile.id === state.activeProfileId) ?? state.profiles[0] ?? SEED_PROFILES[0];

  // -- home conversation sync (home-authoritative: server snapshot replaces cache) --
  const pullHomeConversation = useCallback(async (localId: string, homeId: string) => {
    const { client } = getClients();
    const fenced = captureScope();
    setTyping((current) => ({ ...current, [localId]: true }));
    try {
      const snapshot = await client.syncConversation(homeId);
      if (deletedConversationIds.current.has(localId) || scopeChanged(fenced)) return;
      const mapped = snapshot.messages.map(toLocalMessage).filter((m): m is Message => m !== null);
      const scope = identityRef.current;
      setState((current) => ({
        ...current,
        homeLinks: scope ? stampLinkScope(current.homeLinks, localId, scope) : current.homeLinks,
        conversations: current.conversations.map((item) =>
          item.id === localId ? { ...item, messages: mapped } : item,
        ),
      }));
      setChatError(localId, null);
    } catch (error) {
      if (deletedConversationIds.current.has(localId) || scopeChanged(fenced)) return;
      setChatError(localId, errorMessage(error));
    } finally {
      setTyping((current) => {
        const next = { ...current };
        delete next[localId];
        return next;
      });
    }
  }, [getClients, setChatError, captureScope, scopeChanged]);



  const openConversation = useCallback((id: string) => {
    const conv = stateRef.current.conversations.find((item) => item.id === id);
    const link = stateRef.current.homeLinks[id];
    const homeId = link?.homeId;
    if (conv?.assistantMode === 'home' && homeId && connectionStatus !== 'disconnected') {
      // Track for foreground/reconnect reconciliation (native vs legacy kind).
      lastOpenRef.current = link?.upstreamAgentId
        ? { localId: id, channelId: homeId, agentId: link.upstreamAgentId }
        : { localId: id };
      if (link?.upstreamAgentId) {
        // Native open hydrates history AND tasks AND the inbox together
        // (P0: previously returned before tasks, so questions/approvals
        // never appeared). A cached pending state restarts the single
        // bounded foreground watch (it settles fast when already terminal).
        void hydrateNativeConversation(id, homeId, link.upstreamAgentId);
        void refreshNativeTasks(id);
        void refreshNativeApprovals();
        const cachedTasks = nativeTasksByConvRef.current[id] ?? [];
        const hasOpenWork = cachedTasks.some((task) =>
          task.status === 'needs_input' || task.status === 'working' ||
          task.status === 'ready_for_review');
        const messages = conv.messages;
        const awaitingReply = messages.length > 0 && messages[messages.length - 1].role === 'user';
        if (hasOpenWork || awaitingReply) {
          startNativeWatch(id, homeId, link.upstreamAgentId);
        }
        return;
      }
      void pullHomeConversation(id, homeId);
      void refreshTasksRef.current(id);
    }
  }, [connectionStatus, pullHomeConversation, hydrateNativeConversation, refreshNativeTasks, refreshNativeApprovals, startNativeWatch]);

  const requestHomeSend = useCallback(async (localId: string, homeId: string, text: string, requestKey: string) => {
    const { client } = getClients();
    const fenced = captureScope();
    setTyping((current) => ({ ...current, [localId]: true }));
    setChatError(localId, null);
    try {
      const result = await client.sendMessage(homeId, text, { requestKey });
      if (deletedConversationIds.current.has(localId) || scopeChanged(fenced)) return;
      if (!result.homeAccepted) {
        setConnectionStatus((current) => (current === 'connected' ? 'offline' : current));
        setChatError(localId, 'Me Home is offline. Your message is queued on this device and will send on reconnect.');
        return;
      }
      await pullHomeConversation(localId, homeId);
    } catch (error) {
      if (deletedConversationIds.current.has(localId)) return;
      if (error instanceof HomeClientError && error.code === 'HOME_OFFLINE') {
        setConnectionStatus((current) => (current === 'connected' ? 'offline' : current));
        setChatError(localId, 'Me Home is offline. Your message is queued on this device and will send on reconnect.');
      } else {
        setChatError(localId, errorMessage(error));
        setConnectionStatus((current) => (current === 'connected' ? current : 'error'));
      }
    } finally {
      setTyping((current) => {
        const next = { ...current };
        delete next[localId];
        return next;
      });
    }
  }, [getClients, pullHomeConversation, setChatError, captureScope, scopeChanged]);

  const sendMessage = useCallback((convId: string | null, text: string): string => {
    const clean = text.trim();
    if (!clean) return convId ?? '';
    const mode = stateRef.current.settings.assistantMode;
    if (mode === 'demo') {
      const { conversation } = sameModeTarget(stateRef.current.conversations, convId, 'demo', stateRef.current.activeProfileId, clean);
      const targetId = conversation.id;
      const userMessage = { id: uid(), role: 'user' as const, text: clean, createdAt: Date.now() };
      const updated: Conversation = {
        ...conversation,
        assistantMode: 'demo',
        title: conversation.messages.length === 0 ? clean.slice(0, 42) || conversation.title : conversation.title,
        messages: [...conversation.messages, userMessage],
      };
      setState((current) => ({
        ...current,
        conversations: [updated, ...current.conversations.filter((item) => item.id !== targetId)],
      }));
      setChatError(targetId, null);
      setTyping((current) => ({ ...current, [targetId]: true }));
      const index = replyCount.current++;
      const timer = setTimeout(() => {
        timers.current.delete(targetId);
        if (deletedConversationIds.current.has(targetId)) return;
        setTyping((current) => {
          const next = { ...current };
          delete next[targetId];
          return next;
        });
        setState((current) => {
          if (deletedConversationIds.current.has(targetId)) return current;
          const currentConversation = current.conversations.find((item) => item.id === targetId);
          if (!currentConversation || currentConversation.assistantMode !== 'demo') return current;
          const role = current.profiles.find((profile) => profile.id === currentConversation.profileId)?.role ?? 'adult';
          const reply = { id: uid(), role: 'assistant' as const, text: scriptedReply(role, index), createdAt: Date.now() };
          return {
            ...current,
            conversations: current.conversations.map((item) =>
              item.id === targetId ? { ...item, messages: [...item.messages, reply] } : item,
            ),
          };
        });
      }, 1400 + Math.random() * 900);
      timers.current.set(targetId, timer);
      return targetId;
    }

    // Home mode: local shell + server-bound send with a persisted request_key.
    // The shell link is stamped with the FULL authenticated scope up front;
    // pullHomeConversation re-stamps after every verified sync.
    const { conversation } = sameModeTarget(stateRef.current.conversations, convId, 'home', stateRef.current.activeProfileId, clean);
    const targetId = conversation.id;
    const requestKey = randomUuidV4();
    const scope = identityRef.current;
    const scopeStamp = scope
      ? {
          homeOwner: scope.userId,
          homeInstallationId: scope.installationId,
          homeDeviceId: scope.deviceId,
          homeBaseUrl: scope.homeBaseUrl,
        }
      : {};
    const userMessage = { id: uid(), role: 'user' as const, text: clean, createdAt: Date.now() };
    const updated: Conversation = {
      ...conversation,
      assistantMode: 'home',
      title: conversation.messages.length === 0 ? clean.slice(0, 42) || conversation.title : conversation.title,
      messages: [...conversation.messages, userMessage],
    };
    // P0: preserve the FULL existing link (mergeLinkMetadata) — dropping
    // `upstreamAgentId` here made every turn allocate a NEW upstream channel.
    // A fresh UUID is minted per message; retries reuse the stored key exactly.
    setState((current) => ({
      ...current,
      conversations: [updated, ...current.conversations.filter((item) => item.id !== targetId)],
      homeLinks: {
        ...current.homeLinks,
        [targetId]: mergeLinkMetadata(current.homeLinks[targetId] ?? { homeId: '' }, {
          homeId: current.homeLinks[targetId]?.homeId ?? '',
          requestKey,
          ...scopeStamp,
        }),
      },
    }));
    // FULL native mode sends through the upstream delivery API (channel id
    // in the link); legacy mode uses /v1. Setup-needed refuses honestly.
    const selection = currentUpstreamSelection();
    if (selection === 'setup-needed') {
      setChatError(
        targetId,
        describeUpstreamSetupNeeded(upstreamCapabilityRef.current),
      );
      return targetId;
    }
    const useNative = selection === 'full';
    // Fence the whole closure (P0): a scope change mid-create/mid-POST must
    // not publish under the new identity. The send closure catch is fenced
    // too — stale errors never surface after a switch.
    const fenced = captureScope();
    const fence = fenceFor(fenced);
    const capturedSend = fence.capture();
    void (async () => {
      try {
        if (useNative) {
          const { channelId, agentId } = await ensureUpstreamChannel(targetId, updated.title);
          if (!fence.isCurrent(capturedSend) || deletedConversationIds.current.has(targetId)) return;
          const link = stateRef.current.homeLinks[targetId];
          await requestNativeSend(
            targetId,
            channelId,
            agentId,
            clean,
            link?.requestKey ?? requestKey,
          );
          return;
        }
        const { client } = getClients();
        let link = stateRef.current.homeLinks[targetId];
        if (!link?.homeId) {
          const created = await client.createConversation(updated.title);
          link = mergeLinkMetadata(link, { homeId: created.id, requestKey });
          if (!fence.isCurrent(capturedSend) || deletedConversationIds.current.has(targetId)) return;
          setState((current) => ({
            ...current,
            homeLinks: { ...current.homeLinks, [targetId]: link! },
          }));
        }
        await requestHomeSend(targetId, link.homeId, clean, link.requestKey ?? requestKey);
      } catch (error) {
        if (!fence.isCurrent(capturedSend) || deletedConversationIds.current.has(targetId)) return;
        setChatError(targetId, errorMessage(error));
      }
    })();
    return targetId;
  }, [getClients, requestHomeSend, requestNativeSend, ensureUpstreamChannel, currentUpstreamSelection, setChatError, captureScope, fenceFor]);

  const retryMessage = useCallback((convId: string) => {
    const conversation = stateRef.current.conversations.find((item) => item.id === convId);
    if (!conversation || conversation.assistantMode !== 'home') return;
    const lastUser = [...conversation.messages].reverse().find((m) => m.role === 'user');
    if (!lastUser) return;
    const link = stateRef.current.homeLinks[convId];
    if (!link?.homeId) {
      // Never reached the home; re-run the send path with a fresh key.
      void sendMessage(convId, lastUser.text);
      return;
    }
    if (link.upstreamAgentId) {
      // Retry reuses the EXACT stored idempotency key (outbox entry when a
      // previous attempt never confirmed), never a fresh send.
      const outboxEntry = Object.entries(nativeOutboxRef.current).find(
        ([, entry]) => entry.localId === convId,
      );
      const retryKey = outboxEntry?.[0] ?? link.requestKey ?? randomUuidV4();
      const retryText = outboxEntry?.[1].text ?? lastUser.text;
      void requestNativeSend(convId, link.homeId, link.upstreamAgentId, retryText, retryKey);
      return;
    }
    void requestHomeSend(convId, link.homeId, lastUser.text, link.requestKey ?? randomUuidV4());
  }, [requestHomeSend, requestNativeSend, sendMessage]);

  /**
   * Stop any bounded task poller (conversation deleted, logout, unmount).
   * Declared before ALL references (including dep arrays): `revokeEnrollment`
   * and `useDemoMode` list it as a dependency, so a later declaration would
   * throw a temporal-dead-zone ReferenceError on first provider render.
   * Unconditional hook order is unchanged — only the position moved.
   */
  const stopPollersFor = useCallback((convId: string | null) => {
    for (const [key, handle] of pollers.current.entries()) {
      if (convId === null || key.startsWith(`${convId}:`)) {
        handle.cancelled = true;
        pollers.current.delete(key);
      }
    }
  }, []);

  /**
   * Best-effort home disable before credential forget (revoke/logout/unpair/
   * account switch). The home may be offline — treat as untrusted — so this
   * races a bounded timeout and never blocks the local forget. Private UI
   * state is dropped immediately regardless of the outcome.
   */
  const disableHomePushBestEffort = useCallback(async () => {
    try {
      const { client } = getClients();
      await Promise.race([
        client.disableNotifications().catch(() => ({ disabled: true })),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
    } catch {
      // Offline counts as untrusted: local forget still proceeds.
    }
  }, [getClients]);

  // -- one-time invitation enrollment (secrets never touch AsyncStorage) --
  const enrollHome = useCallback(async (input: { homeBaseUrl: string; invitationId: string; pairingSecret: string; installationId?: string; expectedUserId?: string }) => {
    const attemptId = ++connectionAttempt.current;
    setConnectionStatus('connecting');
    setConnectionError(null);
    try {
      if (Platform.OS === 'web') {
        throw new Error('Secure Me Home pairing is available in the native app, not the web preview.');
      }
      if (!(await isSecureStoreAvailable())) {
        throw new Error('Secure credential storage is unavailable on this device.');
      }
      const { client } = getClients();
      const prev = identityRef.current;
      const prevScopeKey = scopeToken(prev);
      const summary = await client.enrollOneTime(
        {
          homeBaseUrl: input.homeBaseUrl.trim(),
          invitationId: input.invitationId.trim(),
          pairingSecret: input.pairingSecret,
          ...(input.installationId ? { installationId: input.installationId } : {}),
          ...(input.expectedUserId ? { expectedUserId: input.expectedUserId } : {}),
        },
        { label: 'Me phone' },
      );
      if (connectionAttempt.current !== attemptId) return false;
      // When backend coordination already knows an installation identity for
      // this endpoint, the fresh enrollment must match it — never silently
      // adopt a different home (e.g. a reinstalled box on a reused address).
      try {
        const homes = await getClients().backend.discoverHomes().catch(() => []);
        const atEndpoint = homes.find(
          (h) => (h.endpointHint ?? '').replace(/\/+$/, '') === summary.homeBaseUrl,
        );
        if (atEndpoint?.installationId && !verifyEndpointIdentity(atEndpoint.installationId, summary.homeId)) {
          await client.enterDemoMode().catch(() => {});
          throw new HomeClientError(
            'INVITE_MISMATCH',
            'That invitation belongs to a different home installation than the coordinated one.',
          );
        }
      } catch (error) {
        if (error instanceof HomeClientError && error.code === 'INVITE_MISMATCH') throw error;
        // Backend unreachable: enrollment stands on the home's own authority.
      }
      const next = tupleOf(summary);
      const { droppedLocalIds } = reconcileOnEnrollmentChange(
        prev,
        next,
        stateRef.current.conversations,
        stateRef.current.homeLinks,
      );
      dropHomeState(droppedLocalIds);
      if (droppedLocalIds.length > 0) clearArtifactCacheFor(prev);
      // New pairing → new scope: drop the previous scope's push dedupe and
      // require explicit opt-in again (old tokenSuffix never carries over).
      clearNotificationsForScope(prevScopeKey);
      identityRef.current = next;
      identityGenerationRef.current += 1;
      // FULL upstream (Task D): a new pairing is a new scope — fence late
      // native callbacks and clear the roster/channel cache. The native
      // outbox belongs to the old scope and never moves across identities.
      resetUpstreamNativeScope('enroll');
      nativeOutboxRef.current = {};
      lastServerUserIdsRef.current = {};
      persistNativeOutbox();
      stopAllNativeWatches();
      decisionGateRef.current = new DecisionGate();
      setNativeApprovals(null);
      setNativeApprovalsError(null);
      setNativeApprovalsBusy({});
      setNativeAnswers({});
      nativeAnswersRef.current = {};
      setNativeWatchState({});
      upstreamNativeScope().bindScope(scopeToken(next));
      // Capability is per-pairing and unknown until the new home reports it.
      setUpstreamCapability(null);
      setCapabilityResolved(false);
      setNativeTasksByConv({});
      setNativeTasksLoading({});
      setNativeTasksError({});
      setUpstreamBots(null);
      setUpstreamBotsError(null);
      setIdentityResolved(true);
      setEnrollment(summary);
      setState((current) => ({
        ...current,
        settings: { ...current.settings, assistantMode: 'home', homeUrl: summary.homeBaseUrl },
      }));
      setConnectionStatus('connected');
      setConnectionError(null);
      // Capability is per-pairing: read the OPTIONAL report now that the
      // fresh enrollment is live (absence = unknown, never an error).
      // Resolution completes either way so old homes get legacy compat.
      try {
        const fetched = await client.fetchUpstreamCapability().catch(() => null);
        if (connectionAttempt.current !== attemptId) return false;
        setUpstreamCapability(fetched);
        setCapabilityResolved(true);
      } catch {
        // Additive only; enrollment already succeeded.
        if (connectionAttempt.current === attemptId) setCapabilityResolved(true);
      }
      return true;
    } catch (error) {
      if (connectionAttempt.current !== attemptId) return false;
      const message = errorMessage(error);
      setConnectionStatus(error instanceof HomeClientError && error.code === 'HOME_OFFLINE' ? 'offline' : 'error');
      setConnectionError(message);
      return false;
    }
  }, [dropHomeState, getClients, clearArtifactCacheFor, clearNotificationsForScope]);

  /**
   * Pair from a pasted trusted-local `home-pairing-v1` setup payload.
   * The JSON comes from the home itself (Setup S7); backend endpointHints
   * are never accepted here. Secrets stay in UI state only for the call and
   * the caller clears the paste field after use/identity change.
   */
  const enrollWithSetupJson = useCallback(async (text: string) => {
    const allowInsecureLoopback = typeof __DEV__ !== 'undefined' && __DEV__;
    const parsed = parseSetupInvitation(text, { allowInsecureLoopback });
    return enrollHome({
      homeBaseUrl: parsed.homeBaseUrl,
      invitationId: parsed.invitationId,
      pairingSecret: parsed.pairingSecret,
      installationId: parsed.installationId,
      expectedUserId: parsed.expectedUserId,
    });
  }, [enrollHome]);

  /** Revoke this device's enrollment at the home and drop local session state. */
  const revokeEnrollment = useCallback(async () => {
    connectionAttempt.current += 1;
    stopPollersFor(null);
    // Best-effort home disable before the credential forget (bounded).
    await disableHomePushBestEffort();
    try {
      const { client } = getClients();
      await client.revokeOwnDevice().catch(() => {});
      await client.enterDemoMode().catch(() => {});
    } finally {
      const prev = identityRef.current;
      clearNotificationsForScope(scopeToken(prev));
      identityRef.current = null;
      identityGenerationRef.current += 1;
      // FULL native (Task D): revocation ends the scope — fence late
      // native callbacks and clear the roster/channel cache.
      resetUpstreamNativeScope('revoke');
      nativeOutboxRef.current = {};
      lastServerUserIdsRef.current = {};
      persistNativeOutbox();
      stopAllNativeWatches();
      decisionGateRef.current = new DecisionGate();
      setUpstreamCapability(null);
      setCapabilityResolved(false);
      setNativeApprovals(null);
      setNativeApprovalsError(null);
      setNativeApprovalsBusy({});
      setNativeAnswers({});
      nativeAnswersRef.current = {};
      setNativeWatchState({});
      setNativeTasksByConv({});
      setNativeTasksLoading({});
      setNativeTasksError({});
      setUpstreamBots(null);
      setUpstreamBotsError(null);
      setRequestedUpstreamMode('full');
      setIdentityResolved(true);
      const { droppedLocalIds } = reconcileOnEnrollmentChange(
        prev,
        null,
        stateRef.current.conversations,
        stateRef.current.homeLinks,
      );
      dropHomeState(droppedLocalIds);
      clearArtifactCacheFor(prev);
      setEnrollment(null);
      setConnectionStatus('disconnected');
      setConnectionError('This device was revoked. Pair again with a new one-time invitation to reconnect.');
      setState((current) => ({ ...current, settings: { ...current.settings, assistantMode: 'demo' } }));
    }
  }, [dropHomeState, getClients, stopPollersFor, clearArtifactCacheFor, disableHomePushBestEffort, clearNotificationsForScope]);

  const useDemoMode = useCallback(async () => {
    connectionAttempt.current += 1;
    stopPollersFor(null);
    // Best-effort disable before unpair (bounded; offline treated untrusted).
    await disableHomePushBestEffort();
    try {
      const { client } = getClients();
      await client.enterDemoMode();
      const prev = identityRef.current;
      clearNotificationsForScope(scopeToken(prev));
      identityRef.current = null;
      identityGenerationRef.current += 1;
      // FULL native (Task D): unpairing ends the scope — fence late
      // native callbacks and clear the roster/channel cache.
      resetUpstreamNativeScope('unpair');
      nativeOutboxRef.current = {};
      lastServerUserIdsRef.current = {};
      persistNativeOutbox();
      stopAllNativeWatches();
      decisionGateRef.current = new DecisionGate();
      setUpstreamCapability(null);
      setCapabilityResolved(false);
      setNativeApprovals(null);
      setNativeApprovalsError(null);
      setNativeApprovalsBusy({});
      setNativeAnswers({});
      nativeAnswersRef.current = {};
      setNativeWatchState({});
      setNativeTasksByConv({});
      setNativeTasksLoading({});
      setNativeTasksError({});
      setUpstreamBots(null);
      setUpstreamBotsError(null);
      setRequestedUpstreamMode('full');
      setIdentityResolved(true);
      const { droppedLocalIds } = reconcileOnEnrollmentChange(
        prev,
        null,
        stateRef.current.conversations,
        stateRef.current.homeLinks,
      );
      dropHomeState(droppedLocalIds);
      clearArtifactCacheFor(prev);
      setEnrollment(null);
      setConnectionStatus('disconnected');
      setConnectionError(null);
      timers.current.forEach((_, conversationId) => clearTimer(conversationId));
      setState((current) => ({ ...current, settings: { ...current.settings, assistantMode: 'demo' } }));
    } catch {
      setEnrollment(null);
      setConnectionStatus('error');
      setConnectionError('Enrollment could not be removed from secure storage.');
      setState((current) => ({ ...current, settings: { ...current.settings, assistantMode: 'demo' } }));
    }
  }, [dropHomeState, getClients, stopPollersFor, clearArtifactCacheFor, disableHomePushBestEffort, clearNotificationsForScope]);

  // -- backend coordination (account membership, distinct from home identity) --
  // Dev manual token is ONLY allowed when /v1/auth/config reports dev AND
  // the build is __DEV__ with a loopback backend. Hosted backends must use
  // provider sign-in; there is no hosted manual-token fallback.
  const configureBackend = useCallback(async (backendUrl: string, accountToken: string) => {
    try {
      const { backend: coordinator, accountManager } = getClients();
      const origin = coordinator.normalizeBaseUrl(backendUrl);
      let authMode: string = 'dev';
      try {
        const config = await accountManager.fetchAuthConfig(origin);
        authMode = config.authMode === 'hosted' && !(config as { notReady?: boolean }).notReady
          ? 'hosted-ready'
          : (config as { notReady?: boolean }).notReady
            ? 'not-ready'
            : 'dev';
        if (config.authMode === 'hosted') {
          throw new HomeClientError(
            'INVALID_INPUT',
            'This backend uses secure provider sign-in. Use Sign in below instead of a manual token.',
          );
        }
      } catch (error) {
        if (error instanceof HomeClientError && error.code === 'INVALID_INPUT') throw error;
        // Offline: fall through to the dev-only gate below (loopback only).
      }
      const isDev = typeof __DEV__ !== 'undefined' && __DEV__;
      const parsed = new URL(origin);
      const loopback =
        parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1';
      if (!isDev || !loopback) {
        throw new HomeClientError(
          'INVALID_INPUT',
          'Manual account tokens are for local development only. Use provider sign-in.',
        );
      }
      void authMode;
      const saved = await coordinator.configureBackend(origin, accountToken);
      const changed = await accountManager.noteBackendUrlChanged(saved).catch(() => false);
      if (changed) {
        // Backend moved: the previous account binding is gone. Home state is
        // re-scoped via the F4 fence (server history stays).
        const prev = identityRef.current;
        const { droppedLocalIds } = reconcileOnEnrollmentChange(
          prev,
          prev,
          stateRef.current.conversations,
          stateRef.current.homeLinks,
        );
        void droppedLocalIds;
      }
      setBackend((current) => ({ ...current, backendUrl: saved, backendError: null }));
      return true;
    } catch (error) {
      setBackend((current) => ({ ...current, backendError: errorMessage(error) }));
      return false;
    }
  }, [getClients]);

  const clearBackend = useCallback(async () => {
    const { backend: coordinator } = getClients();
    await coordinator.clearBackend().catch(() => {});
    setBackend({ backendUrl: '', memberHomes: [], presence: {}, backendError: null });
  }, [getClients]);

  /** Clear the paired-home side when the cloud account actually changes. */
  const clearHomeForAccountChange = useCallback(async (reason: string) => {
    // Explicit account change: best-effort home disable first (bounded),
    // then drop private UI immediately. Cloud expiry/offline alone never
    // reaches here — home data is preserved independently (see retryAccountRefresh).
    await disableHomePushBestEffort();
    try {
      const { client } = getClients();
      await client.enterDemoMode().catch(() => {});
    } finally {
      const prev = identityRef.current;
      clearNotificationsForScope(scopeToken(prev));
      identityRef.current = null;
      identityGenerationRef.current += 1;
      // FULL upstream (Task D): the cloud account changed — the old home
      // scope ends here. Fence late native callbacks, clear the cache.
      resetUpstreamNativeScope('account-switch');
      nativeOutboxRef.current = {};
      lastServerUserIdsRef.current = {};
      persistNativeOutbox();
      stopAllNativeWatches();
      decisionGateRef.current = new DecisionGate();
      setUpstreamCapability(null);
      setCapabilityResolved(false);
      setNativeApprovals(null);
      setNativeApprovalsError(null);
      setNativeApprovalsBusy({});
      setNativeAnswers({});
      nativeAnswersRef.current = {};
      setNativeWatchState({});
      setNativeTasksByConv({});
      setNativeTasksLoading({});
      setNativeTasksError({});
      setUpstreamBots(null);
      setUpstreamBotsError(null);
      setRequestedUpstreamMode('full');
      setIdentityResolved(true);
      const { droppedLocalIds } = reconcileOnEnrollmentChange(
        prev,
        null,
        stateRef.current.conversations,
        stateRef.current.homeLinks,
      );
      dropHomeState(droppedLocalIds);
      clearArtifactCacheFor(prev);
      setEnrollment(null);
      setConnectionStatus('disconnected');
      setConnectionError(reason);
      setState((current) => ({ ...current, settings: { ...current.settings, assistantMode: 'demo' } }));
    }
  }, [dropHomeState, getClients, clearArtifactCacheFor, disableHomePushBestEffort, clearNotificationsForScope]);

  const refreshAccountConfig = useCallback(async () => {
    const backendUrl = backend.backendUrl || accountRef.current.backendUrl;
    if (!backendUrl) return;
    try {
      const { accountManager } = getClients();
      const config = await accountManager.fetchAuthConfig(backendUrl);
      if (config.authMode === 'dev') {
        setAccount((current) => current.status === 'signed-in'
          ? current
          : { ...current, status: 'signed-out', error: null });
      } else if ((config as { notReady?: boolean }).notReady) {
        setAccount((current) => ({
          ...current,
          status: current.status === 'signed-in' ? current.status : 'not-ready',
          error: 'Sign-in is not ready yet. The operator needs to configure login metadata.',
        }));
      } else {
        setAccount((current) => (current.status === 'signed-in'
          ? current
          : { ...current, status: 'signed-out', error: null }));
      }
    } catch (error) {
      if (error instanceof HomeClientError && error.code === 'SETUP_NOT_READY') {
        setAccount((current) => ({ ...current, status: 'not-ready', error: errorMessage(error) }));
      }
    }
  }, [backend.backendUrl, getClients]);

  const signInWithProvider = useCallback(async () => {
    const attemptId = ++accountAttempt.current;
    if (Platform.OS === 'web') {
      setAccount({
        status: 'error',
        accountId: null,
        issuer: null,
        backendUrl: null,
        claims: null,
        error: 'Secure sign-in needs the native app. The web preview cannot persist credentials.',
      });
      return false;
    }
    const backendUrl = backend.backendUrl || accountRef.current.backendUrl;
    if (!backendUrl) {
      setAccount((current) => ({
        ...current,
        status: 'error',
        error: 'Enter the backend address first, then sign in.',
      }));
      return false;
    }
    setAccount((current) => ({ ...current, status: 'signing-in', error: null }));
    try {
      if (!(await isSecureStoreAvailable())) {
        throw new Error('Secure credential storage is unavailable on this device.');
      }
      const { accountManager } = getClients();
      const generationAtStart = accountManager.beginLogin();
      const fencedHomeToken = scopeToken(identityRef.current);
      const fencedGen = identityGenerationRef.current;
      const config = await accountManager.fetchAuthConfig(backendUrl);
      if (accountAttempt.current !== attemptId) return false;
      if (config.authMode === 'dev') {
        throw new HomeClientError(
          'INVALID_INPUT',
          'This backend uses local-dev identity. Enter a dev account token instead of provider sign-in.',
        );
      }
      if ((config as { notReady?: boolean }).notReady || !isHostedReady(config)) {
        setAccount((current) => ({
          ...current,
          status: 'not-ready',
          error: 'Sign-in is not ready yet. The operator needs to configure login metadata.',
        }));
        return false;
      }
      const hosted = config as HostedAuthConfig;
      const bridge = await import('@/lib/account-auth');
      const redirectUri = selectRedirectUri(hosted.redirectUris, hosted.appScheme ?? bridge.ACCOUNT_APP_SCHEME);
      // AuthorizationCode + PKCE + state + exact redirect (no secrets here).
      buildLoginRequest(hosted, redirectUri);
      const allowInsecure = typeof __DEV__ !== 'undefined' && __DEV__;
      // Guarded discovery: well-known refuses redirects, metadata issuer
      // must equal the configured issuer before any endpoint is used.
      const discovery = await bridge.fetchTrustedDiscovery(hosted.issuer, allowInsecure);
      if (accountAttempt.current !== attemptId) return false;
      // ONE authorization attempt over the SAME SDK request object: the
      // browser prompt and the code+verifier exchange share the SDK-owned
      // PKCE verifier (never leaves SDK memory, never persisted/logged).
      const attempt = await bridge.beginAuthorizationAttempt(hosted, discovery, redirectUri, {
        allowInsecureLoopback: allowInsecure,
      });
      if (accountAttempt.current !== attemptId) return false;
      const tokens = await attempt.perform();
      if (!tokens.accessToken) {
        throw new HomeClientError('AUTH_FAILED', 'Sign-in failed: the provider returned no access token.');
      }
      // Backend MUST verify before marking signed-in or persisting.
      const { committed, account: verified } = await accountManager.verifyAndCommit(
        backendUrl,
        { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresIn: tokens.expiresIn },
        hosted,
        generationAtStart,
      );
      if (!committed) return false;
      if (
        fencedHomeToken !== scopeToken(identityRef.current) ||
        fencedGen !== identityGenerationRef.current ||
        accountAttempt.current !== attemptId
      ) {
        return false;
      }
      const prevAccount = accountRef.current.accountId
        ? { accountId: accountRef.current.accountId, issuer: accountRef.current.issuer ?? '', backendUrl: accountRef.current.backendUrl ?? '' }
        : null;
      const nextIdentity = { accountId: verified.accountId, issuer: verified.issuer, backendUrl: accountManager.normalizeBackendUrl(backendUrl) };
      setAccount({
        status: 'signed-in',
        accountId: verified.accountId,
        issuer: verified.issuer,
        backendUrl: nextIdentity.backendUrl,
        claims: (verified.claims ?? null) as Record<string, unknown> | null,
        error: null,
      });
      setBackend((current) => ({ ...current, backendUrl: nextIdentity.backendUrl, backendError: null }));
      // Account actually changed: forget the old home credential + private
      // chat/tasks/file preview via the F4/F5 fences (server history stays).
      if (accountIdentityChanged(prevAccount, nextIdentity)) {
        const { client } = getClients();
        const summary = await client.summary().catch(() => null);
        if (summary) {
          await clearHomeForAccountChange(
            'Signed in as a different account. The previous home pairing was cleared.',
          );
        }
      }
      await refreshBackendHomesRef.current();
      return true;
    } catch (error) {
      if (accountAttempt.current !== attemptId) return false;
      const cancelled = (error as { code?: string })?.code === 'AUTH_CANCELLED' ||
        (error instanceof HomeClientError && error.code === 'AUTH_CANCELLED');
      if (cancelled) {
        setAccount((current) => ({ ...current, status: 'cancelled', error: 'Sign-in was cancelled.' }));
        return false;
      }
      const message = errorMessage(error);
      const notReady = error instanceof HomeClientError && error.code === 'SETUP_NOT_READY';
      setAccount((current) => ({
        ...current,
        status: notReady ? 'not-ready' : 'error',
        error: message,
      }));
      return false;
    }
  }, [backend.backendUrl, clearHomeForAccountChange, getClients]);

  const signOutAccount = useCallback(async () => {
    accountAttempt.current += 1;
    const { accountManager } = getClients();
    try {
      await accountManager.logout();
    } finally {
      setAccount({ status: 'signed-out', accountId: null, issuer: null, backendUrl: null, claims: null, error: null });
      setBackend((current) => ({ ...current, memberHomes: [], presence: {} }));
      // Explicit logout always clears the home side locally (even offline).
      await clearHomeForAccountChange('Signed out. Pair again to reconnect this home.');
    }
  }, [clearHomeForAccountChange, getClients]);

  const retryAccountRefresh = useCallback(async () => {
    const current = await getClients().accountManager.loadBundle().catch(() => null);
    if (!current) {
      setAccount((prev) => ({ ...prev, error: 'No saved session to refresh. Sign in again.' }));
      return;
    }
    setAccount((prev) => ({ ...prev, status: prev.status === 'signed-in' ? prev.status : 'signing-in', error: null }));
    try {
      const { accountManager } = getClients();
      const config = await accountManager.fetchAuthConfig(current.backendUrl);
      if (!isHostedReady(config)) {
        setAccount((prev) => ({ ...prev, status: 'not-ready', error: 'Sign-in is not ready yet.' }));
        return;
      }
      const bridge = await import('@/lib/account-auth');
      const allowInsecure = typeof __DEV__ !== 'undefined' && __DEV__;
      const discovery = await bridge.fetchTrustedDiscovery(
        (config as HostedAuthConfig).issuer,
        allowInsecure,
      );
      const sdk = {
        exchangeCode: async () => { throw new Error('unused'); },
        refreshToken: async (refreshToken: string) =>
          bridge.refreshTokensNative(refreshToken, config as HostedAuthConfig, discovery, {
            allowInsecureLoopback: allowInsecure,
          }),
      };
      const rotated = await accountManager.refreshIfNeeded(sdk, config as HostedAuthConfig, discovery);
      if (rotated) {
        setAccount({
          status: 'signed-in',
          accountId: rotated.accountId,
          issuer: rotated.issuer,
          backendUrl: rotated.backendUrl,
          claims: accountRef.current.claims,
          error: null,
        });
      }
    } catch (error) {
      // Offline/expiry never stops the paired home agent: keep home, surface
      // the account error honestly for retry.
      setAccount((prev) => ({ ...prev, status: prev.status, error: errorMessage(error) }));
    }
  }, [getClients]);

  const refreshBackendHomesRef = useRef(() => Promise.resolve());

  const refreshBackendHomes = useCallback(async () => {
    try {
      const { backend: coordinator } = getClients();
      const homes = await coordinator.discoverHomes();
      setBackend((current) => ({ ...current, memberHomes: homes, backendError: null }));
      const presence: BackendState['presence'] = {};
      for (const home of homes) {
        try {
          const status = await coordinator.homeStatus(home.homeId);
          presence[home.homeId] = { lastSeenAt: status.lastSeenAt, lastStatus: status.lastStatus };
        } catch {
          presence[home.homeId] = {};
        }
      }
      setBackend((current) => ({ ...current, presence }));
    } catch (error) {
      setBackend((current) => ({ ...current, backendError: errorMessage(error) }));
    }
  }, [getClients]);

  useEffect(() => {
    refreshBackendHomesRef.current = refreshBackendHomes;
  }, [refreshBackendHomes]);

  const joinBackendHome = useCallback(async (homeId: string, ticketSecret: string) => {
    try {
      const { backend: coordinator } = getClients();
      await coordinator.joinHome(homeId, ticketSecret);
      await refreshBackendHomes();
      return true;
    } catch (error) {
      setBackend((current) => ({ ...current, backendError: errorMessage(error) }));
      return false;
    }
  }, [getClients, refreshBackendHomes]);

  /**
   * Mint a one-time home-activation ticket for the home operator (F9).
   *
   * Account-fenced: the signed-in identity is captured before the await and
   * a late result after logout/account/backend change is refused (null,
   * nothing published). Home state (enrollment, connection, tasks) is never
   * touched: a cloud outage only surfaces an honest error here. The ticket
   * itself is returned, never stored — the caller keeps it in ephemeral UI
   * state and clears it on expiry/account change/background/unmount.
   */
  const mintActivationTicket = useCallback(async (input: MintActivationTicketInput) => {
    const fencedAccount = accountRef.current.accountId
      ? {
        accountId: accountRef.current.accountId,
        issuer: accountRef.current.issuer ?? '',
        backendUrl: accountRef.current.backendUrl ?? '',
      }
      : null;
    if (accountRef.current.status !== 'signed-in' || !fencedAccount) {
      setBackend((current) => ({ ...current, backendError: 'Sign in with the home owner account first, then mint a ticket.' }));
      return null;
    }
    try {
      const { backend: coordinator } = getClients();
      const ticket = await coordinator.mintActivationTicket(input);
      const current = accountRef.current.accountId
        ? {
          accountId: accountRef.current.accountId,
          issuer: accountRef.current.issuer ?? '',
          backendUrl: accountRef.current.backendUrl ?? '',
        }
        : null;
      if (
        !current ||
        current.accountId !== fencedAccount.accountId ||
        current.issuer !== fencedAccount.issuer ||
        current.backendUrl !== fencedAccount.backendUrl
      ) {
        return null;
      }
      const handoff = coordinator.buildActivationHandoff(
        current.backendUrl || backend.backendUrl,
        ticket,
      );
      setBackend((prev) => ({ ...prev, backendError: null }));
      return { ticket, handoff };
    } catch (error) {
      setBackend((prev) => ({ ...prev, backendError: errorMessage(error) }));
      return null;
    }
  }, [backend.backendUrl, getClients]);

  /**
   * Backend home selection is DISCOVERY-ONLY (F8 endpoint-trust fix).
   *
   * A backend `endpointHint` is untrusted coordination metadata: it must
   * NEVER authorize forwarding the existing device secret/session to a new
   * URL. `verifyEndpointIdentity` compares only the PUBLIC installation id
   * (correlation, not server authentication), so a clone replaying the UUID
   * on an evil endpoint still fails here — no secret is sent and no pairing
   * is mutated before the refusal.
   *
   * Moving to a new URL requires a FRESH one-time invitation from trusted
   * local setup with the URL included (`home-pairing-v1` paste or the manual
   * endpoint + secret fields). The old pairing keeps working; nothing is
   * auto-erased from a cloud hint. Same-origin hints verify read-only and
   * report presence; this method never autofills the private pair URL.
   */
  const selectBackendHome = useCallback(async (homeId: string) => {
    try {
      const { client, backend: coordinator } = getClients();
      const homes = await coordinator.discoverHomes();
      const home = homes.find((h) => h.homeId === homeId);
      if (!home?.endpointHint) {
        throw new HomeClientError(
          'UNPAIRED',
          'That home has no endpoint registered. Ask the home owner to heartbeat first.',
        );
      }
      // Read-only liveness check of the hinted endpoint. checkHealth sends
      // no credentials (GET /healthz) and refuses cross-origin redirects.
      const health = await client.checkHealth(home.endpointHint).catch(() => null);
      if (!health) {
        throw new HomeClientError(
          'HOME_OFFLINE',
          'That home endpoint is unreachable. Your current pairing was left untouched.',
        );
      }
      // The UUID correlation is kept as a naming check only — it is NOT a
      // cryptographic proof and never authorizes a credential move.
      if (home.installationId && !verifyEndpointIdentity(home.installationId, health.installationId)) {
        throw new HomeClientError(
          'INVITE_MISMATCH',
          'That endpoint identifies a different home installation. Pair again with a fresh one-time invitation from trusted local setup.',
        );
      }
      const current = identityRef.current;
      if (current) {
        const hintOrigin = normalizeOrigin(home.endpointHint);
        const currentOrigin = normalizeOrigin(current.homeBaseUrl);
        if (hintOrigin && currentOrigin && hintOrigin !== currentOrigin) {
          // Different endpoint: refuse BEFORE any network-with-credentials
          // or store mutation. Old home keeps working.
          throw new HomeClientError(
            'PAIRING_REQUIRED',
            'That home has a new address. Pair again with a fresh one-time invitation from trusted local setup that includes the new URL. Your current pairing was left untouched.',
          );
        }
      }
      // Same origin (or unpaired): discovery only, no credential mutation.
      await refreshBackendHomes().catch(() => {});
      return true;
    } catch (error) {
      setBackend((current) => ({ ...current, backendError: errorMessage(error) }));
      return false;
    }
  }, [getClients, refreshBackendHomes]);

  // -- persisted home tasks (H2): owned by the home, never fabricated here --
  const refreshTasksRef = useRef((_convId: string) => Promise.resolve());

  const ensureHomeLink = useCallback(async (localId: string): Promise<string | null> => {
    const existing = stateRef.current.homeLinks[localId];
    if (existing?.homeId) return existing.homeId;
    const conv = stateRef.current.conversations.find((item) => item.id === localId);
    if (!conv) return null;
    try {
      const { client } = getClients();
      const created = await client.createConversation(conv.title);
      const scope = identityRef.current;
      setState((current) => ({
        ...current,
        homeLinks: {
          ...current.homeLinks,
          [localId]: {
            homeId: created.id,
            requestKey: current.homeLinks[localId]?.requestKey,
            ...(scope
              ? {
                  homeOwner: scope.userId,
                  homeInstallationId: scope.installationId,
                  homeDeviceId: scope.deviceId,
                  homeBaseUrl: scope.homeBaseUrl,
                }
              : {}),
          },
        },
      }));
      return created.id;
    } catch (error) {
      setTaskErrors((current) => ({ ...current, [localId]: errorMessage(error) }));
      return null;
    }
  }, [getClients]);

  const refreshTasks = useCallback(async (convId: string) => {
    const homeId = await ensureHomeLink(convId);
    if (!homeId) return;
    setTasksLoading((current) => ({ ...current, [convId]: true }));
    try {
      const { client } = getClients();
      const tasks = await client.listTasks(homeId);
      setTasksByConv((current) => ({ ...current, [convId]: tasks }));
      setTaskErrors((current) => {
        const next = { ...current };
        delete next[convId];
        return next;
      });
    } catch (error) {
      setTaskErrors((current) => ({ ...current, [convId]: errorMessage(error) }));
    } finally {
      setTasksLoading((current) => {
        const next = { ...current };
        delete next[convId];
        return next;
      });
    }
  }, [ensureHomeLink, getClients]);

  useEffect(() => {
    refreshTasksRef.current = refreshTasks;
  }, [refreshTasks]);

  useEffect(() => {
    const active = pollers.current;
    const subscription = AppState.addEventListener('change', (next) => {
      // Foreground sync: re-verify the live endpoint when returning, then
      // reconcile the last-opened conversation so answers that landed while
      // the app was closed actually appear (no local mock completion).
      if (next === 'active' && stateRef.current.settings.assistantMode === 'home') {
        void verifyHomeConnectionRef.current().finally(() => {
          void reconcileForegroundRef.current();
        });
      } else if (next === 'background') {
        // No background CPU: stop foreground watches; foreground return
        // restarts them when work is still pending.
        stopAllNativeWatchesRef.current();
      }
    });
    return () => {
      subscription.remove();
      for (const handle of active.values()) handle.cancelled = true;
      active.clear();
    };
  }, []);

  const verifyHomeConnectionRef = useRef(() => Promise.resolve());

  useEffect(() => {
    verifyHomeConnectionRef.current = verifyHomeConnection;
  }, [verifyHomeConnection]);

  const stopAllNativeWatchesRef = useRef(() => {});

  useEffect(() => {
    stopAllNativeWatchesRef.current = stopAllNativeWatches;
  }, [stopAllNativeWatches]);

  const reconcileForegroundRef = useRef(() => Promise.resolve());

  useEffect(() => {
    reconcileForegroundRef.current = async () => {
      const last = lastOpenRef.current;
      if (!last || connectionStatusRef.current !== 'connected') return;
      const conv = stateRef.current.conversations.find((item) => item.id === last.localId);
      if (!conv || conv.assistantMode !== 'home') return;
      if (last.channelId && last.agentId) {
        await hydrateNativeConversation(last.localId, last.channelId, last.agentId);
        await refreshNativeTasks(last.localId);
        await refreshNativeApprovals();
        // Restart the bounded watch when the refreshed state still shows
        // open work (research that finished while away settles immediately).
        const fenced = captureScope();
        if (scopeChanged(fenced)) return;
        const tasks = (nativeTasksByConvRef.current[last.localId] ?? []).filter(
          (task) => task.channelId === last.channelId,
        );
        const history = stateRef.current.conversations.find(
          (item) => item.id === last.localId,
        )?.messages ?? [];
        const hasUserText = history.some((m) => m.role === 'user');
        const openWork = tasks.some((task) =>
          task.status === 'needs_input' || task.status === 'working' ||
          task.status === 'ready_for_review');
        const approvalsOpen = (nativeApprovalsRef.current?.requests ?? []).some(
          (request) => request.status === 'pending',
        );
        if ((hasUserText && openWork) || approvalsOpen) {
          startNativeWatch(last.localId, last.channelId, last.agentId);
        }
      } else {
        const legacyHomeId = stateRef.current.homeLinks[last.localId]?.homeId;
        if (!legacyHomeId) return;
        await pullHomeConversation(last.localId, legacyHomeId);
      }
    };
  }, [hydrateNativeConversation, refreshNativeTasks, refreshNativeApprovals, pullHomeConversation, captureScope, scopeChanged, startNativeWatch]);

  const findTaskConv = useCallback((taskId: string): string | null => {
    for (const [convId, tasks] of Object.entries(tasksByConv)) {
      if (tasks.some((t) => t.id === taskId)) return convId;
    }
    return null;
  }, [tasksByConv]);

  /**
   * Bounded active-task polling: refresh the task view a few times, then
   * stop (no background loops). On a terminal status, sync the home
   * conversation so H3's exactly-once published assistant output appears
   * through the authoritative history path — never a local fabrication.
   * F6: waiting children are polled bounded within the same loop (same
   * maxAttempts/interval, best-effort per child) so a parent blocked on
   * children still progresses while other work continues; questions and
   * approvals stay isolated to their own task (one getTask per id).
   */
  const pollTaskUntilSettled = useCallback(async (
    convId: string,
    homeId: string,
    taskId: string,
    options: { intervalMs?: number; maxAttempts?: number } = {},
  ) => {
    const intervalMs = options.intervalMs ?? 2500;
    const maxAttempts = options.maxAttempts ?? 24;
    const key = `${convId}:${taskId}`;
    const previousPoller = pollers.current.get(key);
    if (previousPoller) previousPoller.cancelled = true;
    const handle = { cancelled: false };
    pollers.current.set(key, handle);
    const fenced = captureScope();
    try {
      const { client } = getClients();
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (handle.cancelled || deletedConversationIds.current.has(convId) || scopeChanged(fenced)) return;
        await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 0 : intervalMs));
        if (handle.cancelled || deletedConversationIds.current.has(convId) || scopeChanged(fenced)) return;
        let view = null;
        try {
          view = await client.getTask(taskId);
        } catch {
          return;
        }
        if (handle.cancelled || deletedConversationIds.current.has(convId) || scopeChanged(fenced)) return;
        setTasksByConv((current) => ({
          ...current,
          [convId]: [view!, ...(current[convId] ?? []).filter((t) => t.id !== taskId)],
        }));
        // Bounded waiting-children refresh: same budget, one getTask per
        // known child id, failures ignored (next listTasks refresh recovers).
        const waiting: string[] = Array.isArray((view as unknown as Record<string, unknown>)?.['waitingChildren'])
          ? ((view as unknown as Record<string, unknown>)['waitingChildren'] as string[]).filter((id) => typeof id === 'string')
          : Array.isArray((view as unknown as Record<string, unknown>)?.['childTaskIds'])
            ? ((view as unknown as Record<string, unknown>)['childTaskIds'] as string[]).filter((id) => typeof id === 'string').slice(0, 5)
            : [];
        for (const childId of waiting.slice(0, 5)) {
          if (handle.cancelled || deletedConversationIds.current.has(convId) || scopeChanged(fenced)) return;
          try {
            const childView = await client.getTask(childId);
            if (handle.cancelled || deletedConversationIds.current.has(convId) || scopeChanged(fenced)) return;
            setTasksByConv((current) => ({
              ...current,
              [convId]: [childView, ...(current[convId] ?? []).filter((t) => t.id !== childId)],
            }));
          } catch {
            // Best effort: a missing/forbidden child stays as listed.
          }
        }
        if (view.status === 'succeeded' || view.status === 'failed' || view.status === 'cancelled') {
          await pullHomeConversation(convId, homeId);
          return;
        }
      }
    } finally {
      if (pollers.current.get(key) === handle) pollers.current.delete(key);
    }
  }, [getClients, pullHomeConversation, captureScope, scopeChanged]);

  const syncAfterTerminal = useCallback(async (
    convId: string,
    view: { status: string; id: string } | null,
  ) => {
    if (!view) return;
    if (view.status !== 'succeeded' && view.status !== 'failed' && view.status !== 'cancelled') return;
    const homeId = stateRef.current.homeLinks[convId]?.homeId;
    if (!homeId) return;
    await pullHomeConversation(convId, homeId).catch(() => {});
  }, [pullHomeConversation]);

  const submitHomeTask = useCallback(async (convId: string, input: { request: string; title?: string }) => {
    const homeId = await ensureHomeLink(convId);
    if (!homeId) return;
    setTasksLoading((current) => ({ ...current, [convId]: true }));
    try {
      const { client } = getClients();
      const created = await client.submitTask(homeId, input);
      if (deletedConversationIds.current.has(convId)) return;
      setTasksByConv((current) => ({ ...current, [convId]: [created, ...(current[convId] ?? [])] }));
      // Bounded polling picks up progress and the terminal assistant output
      // via authoritative history — the Run button is the explicit control.
      void pollTaskUntilSettled(convId, homeId, created.id);
    } catch (error) {
      setTaskErrors((current) => ({ ...current, [convId]: errorMessage(error) }));
    } finally {
      setTasksLoading((current) => {
        const next = { ...current };
        delete next[convId];
        return next;
      });
    }
  }, [ensureHomeLink, getClients, pollTaskUntilSettled]);

  const answerTaskQuestion = useCallback(async (taskId: string, questionId: string, answer: string) => {
    const convId = findTaskConv(taskId);
    if (!convId) return;
    try {
      const { client } = getClients();
      const view = await client.answerTaskQuestions(taskId, [{ id: questionId, answer }]);
      if (deletedConversationIds.current.has(convId)) return;
      setTasksByConv((current) => ({
        ...current,
        [convId]: [view, ...(current[convId] ?? []).filter((t) => t.id !== taskId)],
      }));
      await syncAfterTerminal(convId, view);
    } catch (error) {
      setTaskErrors((current) => ({ ...current, [convId]: errorMessage(error) }));
    }
  }, [findTaskConv, getClients, syncAfterTerminal]);

  const decideTaskApproval = useCallback(async (taskId: string, approvalId: string, decision: 'approve' | 'reject') => {
    const convId = findTaskConv(taskId);
    if (!convId) return;
    try {
      const { client } = getClients();
      const view = await client.decideTaskApprovals(taskId, [{ id: approvalId, decision }]);
      if (deletedConversationIds.current.has(convId)) return;
      setTasksByConv((current) => ({
        ...current,
        [convId]: [view, ...(current[convId] ?? []).filter((t) => t.id !== taskId)],
      }));
      await syncAfterTerminal(convId, view);
    } catch (error) {
      setTaskErrors((current) => ({ ...current, [convId]: errorMessage(error) }));
    }
  }, [findTaskConv, getClients, syncAfterTerminal]);

  const cancelHomeTask = useCallback(async (taskId: string) => {
    const convId = findTaskConv(taskId);
    if (!convId) return;
    try {
      const { client } = getClients();
      const view = await client.cancelTask(taskId);
      if (deletedConversationIds.current.has(convId)) return;
      setTasksByConv((current) => ({
        ...current,
        [convId]: [view, ...(current[convId] ?? []).filter((t) => t.id !== taskId)],
      }));
      await syncAfterTerminal(convId, view);
    } catch (error) {
      setTaskErrors((current) => ({ ...current, [convId]: errorMessage(error) }));
    }
  }, [findTaskConv, getClients, syncAfterTerminal]);

  const loadTaskArtifacts = useCallback(async (taskId: string) => {
    try {
      const { client } = getClients();
      const artifacts = await client.listTaskArtifacts(taskId);
      setTaskArtifacts((current) => ({ ...current, [taskId]: artifacts ?? [] }));
    } catch (error) {
      const convId = findTaskConv(taskId);
      if (convId) setTaskErrors((current) => ({ ...current, [convId]: errorMessage(error) }));
    }
  }, [findTaskConv, getClients]);

  const downloadTaskArtifact = useCallback(async (taskId: string, artifactId: string) => {
    // F6 fence: never hand previous-scope bytes to the caller for preview.
    const fenced = captureScope();
    const { client } = getClients();
    const bytes = await client.fetchTaskArtifact(taskId, artifactId);
    if (scopeChanged(fenced)) {
      throw new Error('Pairing changed while loading; preview was discarded. Refresh and try again.');
    }
    const meta = (taskArtifacts[taskId] ?? []).find((a) => a?.id === artifactId);
    return { name: meta?.name ?? artifactId, bytes };
  }, [getClients, taskArtifacts, captureScope, scopeChanged]);

  /**
   * Fetch artifact bytes then save to the app-private scoped cache.
   * Reuses `fetchTaskArtifact`; preserves the F4 identity fence: capture
   * scope before the await, refuse to save or present when it moved.
   * Returns null when the pairing moved mid-flight (caller shows no file).
   */
  const saveTaskArtifact = useCallback(async (
    taskId: string,
    artifactId: string,
  ): Promise<SavedArtifact | null> => {
    const fenced = captureScope();
    const { client } = getClients();
    const bytes = await client.fetchTaskArtifact(taskId, artifactId);
    if (scopeChanged(fenced)) return null;
    const scope = identityRef.current;
    if (!scope) return null;
    const meta = (taskArtifacts[taskId] ?? []).find((a) => a?.id === artifactId);
    const name = typeof meta?.name === 'string' ? meta.name : artifactId;
    const { saveArtifactBytes } = await import('@/lib/artifact-store');
    const saved = await saveArtifactBytes(scope, artifactId, name, bytes);
    if (scopeChanged(fenced)) {
      // Pairing moved during the save: drop the just-written file's scope
      // dir rather than presenting a stale-identity file.
      await import('@/lib/artifact-store')
        .then((mod) => mod.clearScopedArtifactCache(scope).catch(() => {}))
        .catch(() => {});
      return null;
    }
    return saved;
  }, [captureScope, scopeChanged, getClients, taskArtifacts]);

  // -- Opt-in task push (F8): user-gated, metadata-only, scope-fenced --
  //
  // Nothing is prompted or registered until the user taps the opt-in button.
  // The Expo token never touches AsyncStorage/logs/task inputs; the status
  // surface keeps a redacted suffix only. Every async step captures the
  // full-scope epoch and drops late results after logout/unpair/revoke,
  // account switch, mode change, or endpoint change.
  const enableNotifications = useCallback(async () => {
    if (Platform.OS === 'web') {
      setNotifications((c) => ({ ...c, error: 'Push notifications need the native app. The web preview cannot receive them.' }));
      return false;
    }
    const scope = identityRef.current;
    if (!scope || !enrollment) {
      setNotifications((c) => ({ ...c, error: 'Pair with your home first, then enable notifications.' }));
      return false;
    }
    const epoch = notifEpoch.current;
    const fenced = captureScope();
    setNotifications((c) => ({ ...c, busy: true, error: null }));
    try {
      const sdkMod = await import('@/lib/notifications').catch(() => null);
      if (!sdkMod) throw new Error('Notification adapter is missing.');
      // Real SDK surface is loaded lazily; missing modules mean the native
      // build lacks Expo Notifications (declared deps only, no fake-enabled).
      let sdk: unknown = null;
      let projectId: string | null = null;
      let isDevice = true;
      try {
        const expoNotifications = (await import('expo-notifications').catch(() => null)) as unknown as Record<string, unknown> | null;
        const expoConstants = (await import('expo-constants').catch(() => null)) as unknown as { default?: unknown } | null;
        const expoDevice = (await import('expo-device').catch(() => null)) as unknown as { isDevice?: boolean } | null;
        const constants = (expoConstants?.default ?? expoConstants) as never;
        projectId = sdkMod.resolveExpoProjectId(constants as never);
        isDevice = expoDevice?.isDevice ?? true;
        sdk = expoNotifications?.default ?? expoNotifications;
      } catch {
        sdk = null;
      }
      if (epoch !== notifEpoch.current || scopeChanged(fenced)) return false;
      const availability = sdkMod.notificationAvailability({
        platform: Platform.OS,
        sdk: sdk as never,
        projectId,
        isDevice,
      });
      if (!availability.available) {
        setNotifications((c) => ({ ...c, busy: false, error: availability.reason }));
        return false;
      }
      await sdkMod.ensureAndroidChannel(sdk as never, Platform.OS);
      const opted = await sdkMod.optInForPushToken({ sdk: sdk as never, projectId: projectId as string });
      if (epoch !== notifEpoch.current || scopeChanged(fenced)) return false;
      if (!opted.granted || !opted.expoPushToken) {
        setNotifications((c) => ({ ...c, busy: false, permissionGranted: false, error: opted.reason ?? 'OS notification permission was denied.' }));
        return false;
      }
      const { client } = getClients();
      await client.registerPushToken({
        expoPushToken: opted.expoPushToken,
        permissionEnabled: true,
        ...(projectId ? { projectId } : {}),
      });
      if (epoch !== notifEpoch.current || scopeChanged(fenced)) return false;
      const status = await client.notificationStatus().catch(() => null);
      setNotifications({
        enabled: status?.enabled ?? true,
        permissionGranted: true,
        tokenSuffix: status?.tokenSuffix ?? opted.tokenSuffix,
        error: null,
        busy: false,
      });
      return true;
    } catch (error) {
      if (epoch !== notifEpoch.current || scopeChanged(fenced)) return false;
      const message = errorMessage(error);
      const disabled = message.includes('disabled');
      setNotifications((c) => ({
        ...c,
        busy: false,
        enabled: false,
        error: disabled
          ? 'Push notifications are disabled on this home (operator opt-in required).'
          : message,
      }));
      return false;
    }
  }, [captureScope, scopeChanged, enrollment, getClients]);

  const disableNotifications = useCallback(async () => {
    const fenced = captureScope();
    const epoch = notifEpoch.current;
    setNotifications((c) => ({ ...c, busy: true, error: null }));
    try {
      await disableHomePushBestEffort();
      if (epoch !== notifEpoch.current || scopeChanged(fenced)) return;
      notifDedupe.current.clearScope(scopeToken(identityRef.current));
      setNotifications({ enabled: false, permissionGranted: false, tokenSuffix: null, error: null, busy: false });
    } catch (error) {
      if (epoch !== notifEpoch.current || scopeChanged(fenced)) return;
      setNotifications((c) => ({ ...c, busy: false, error: errorMessage(error) }));
    }
  }, [captureScope, scopeChanged, disableHomePushBestEffort]);

  /**
   * Verified tap routing: fetch the ACTUAL task + conversation from the
   * CURRENT private home with the bearer session, then resolve the FIXED
   * existing Chat route's local conversation id from the verified snapshot.
   * Never navigates from push title/body/URLs. Returns null when the scope
   * moved mid-flight, the task is foreign, or nothing verified.
   */
  const openTaskFromNotification = useCallback(async (taskId: string): Promise<string | null> => {
    const clean = taskId.trim().slice(0, 128);
    if (!clean) return null;
    const fenced = captureScope();
    const scope = identityRef.current;
    if (!scope) return null;
    try {
      const { client } = getClients();
      const view = await client.getTask(clean);
      if (scopeChanged(fenced)) return null;
      const homeConversationId = view.conversationId;
      if (!homeConversationId) return null;
      const snapshot = await client.syncConversation(homeConversationId).catch(() => null);
      if (!snapshot || scopeChanged(fenced)) return null;
      if (snapshot.ownerUserId !== scope.userId) return null;
      const mapped = snapshot.messages.map(toLocalMessage).filter((m): m is Message => m !== null);
      // Find the existing local shell for this verified home conversation;
      // create a scope-stamped shell only when none exists (verified first).
      const existing = stateRef.current.conversations.find(
        (c) => (c.assistantMode ?? 'demo') === 'home' && stateRef.current.homeLinks[c.id]?.homeId === homeConversationId,
      );
      if (existing) {
        setState((current) => ({
          ...current,
          homeLinks: stampLinkScope(current.homeLinks, existing.id, scope),
          conversations: current.conversations.map((item) =>
            item.id === existing.id ? { ...item, messages: mapped } : item,
          ),
        }));
        setChatError(existing.id, null);
        return existing.id;
      }
      const id = uid();
      setState((current) => ({
        ...current,
        conversations: [
          { id, profileId: current.activeProfileId, title: snapshot.title || 'Task update', messages: mapped, assistantMode: 'home' },
          ...current.conversations,
        ],
        homeLinks: stampLinkScope(
          { ...current.homeLinks, [id]: { homeId: homeConversationId } },
          id,
          scope,
        ),
      }));
      return id;
    } catch {
      return null;
    }
  }, [captureScope, scopeChanged, getClients, setChatError]);

  const value: Ctx = useMemo(() => {
    // FULL native upstream (Task D): honest derived selection via the
    // actual app decision. Requested FULL + not-yet-resolved => setup-needed
    // (never silent legacy); resolved old homes without capability fields
    // stay legacy compat; demo stays demo.
    const upstreamSelection = resolveAppSelection({
      assistantMode: state.settings.assistantMode,
      requested: requestedUpstreamMode,
      capability: upstreamCapability,
      capabilityResolved,
    });
    const upstreamSetupMessage =
      upstreamSelection === 'setup-needed'
        ? describeUpstreamSetupNeeded(upstreamCapability)
        : null;
    return {
    ...state,
    status,
    saveError,
    onboardingSessionCompleted,
    typing,
    chatErrors,
    connectionStatus,
    connectionError,
    hasHomeCredential: enrollment !== null,
    enrollment,
    homeUserId: enrollment?.userId ?? null,
    homeScopeKey: scopeToken(tupleOf(enrollment)),
    identityResolved,
    visibleChats: visibleConversations(state.conversations, state.homeLinks, {
      mode: state.settings.assistantMode,
      activeProfileId: state.activeProfileId,
      homeScope: tupleOf(enrollment),
      identityResolved,
    }),
    backend,
    tasksByConv,
    tasksLoading,
    taskErrors,
    taskArtifacts,
    activeCallId,
    retry: () => setAttempt((current) => current + 1),
    retrySave: async () => {
      const completed = stateRef.current.onboardingCompleted || onboardingSessionCompleted;
      const nextState = { ...stateRef.current, onboardingCompleted: completed };
      try {
        await AsyncStorage.setItem(KEY, JSON.stringify(nextState));
      } catch {
        setSaveError(true);
        return false;
      }
      setOnboardingSessionCompleted(false);
      setSaveError(false);
      if (completed !== stateRef.current.onboardingCompleted) {
        setState((current) => ({ ...current, onboardingCompleted: completed }));
      }
      return true;
    },
    continueSetupInMemory: () => {
      setOnboardingSessionCompleted(true);
      setSaveError(true);
    },
    // Profile switching stays functional for demo/household UX but can never
    // impersonate in home mode: home display is bound to the authenticated
    // paired identity via visibleChats, not to the selected profile.
    setActiveProfile: (id) => setState((current) => ({ ...current, activeProfileId: id })),
    updateProfile: (id, patch) => setState((current) => ({ ...current, profiles: current.profiles.map((profile) => (profile.id === id ? { ...profile, ...patch } : profile)) })),
    addProfile: (profile) => {
      const id = uid();
      setState((current) => ({ ...current, profiles: [...current.profiles, { ...profile, id }] }));
      return id;
    },
    addSetupProfile: (profile) => {
      const current = stateRef.current;
      const normalizedName = profile.name.trim().toLocaleLowerCase();
      const existing = current.profiles.find(
        (candidate) => candidate.name.trim().toLocaleLowerCase() === normalizedName && candidate.role === profile.role,
      );
      if (existing) {
        if (current.activeProfileId !== existing.id) {
          setState((state) => ({ ...state, activeProfileId: existing.id }));
        }
        return existing.id;
      }
      const created = { ...profile, name: profile.name.trim(), id: uid() };
      setState((state) => ({ ...state, profiles: [...state.profiles, created], activeProfileId: created.id }));
      return created.id;
    },
    removeProfile: (id) =>
      setState((current) => {
        if (current.profiles.length <= 1) return current;
        const profiles = current.profiles.filter((profile) => profile.id !== id);
        return {
          ...current,
          profiles,
          // Demo profiles own demo conversations only; home conversations
          // are bound to the paired identity and stay (server-authoritative).
          conversations: current.conversations.filter((conversation) => conversation.profileId !== id || (conversation.assistantMode ?? 'demo') === 'home'),
          activeProfileId: current.activeProfileId === id ? profiles[0].id : current.activeProfileId,
        };
      }),
    createConversation: (title = 'New conversation') => {
      const id = uid();
      setState((current) => ({
        ...current,
        conversations: [{ id, profileId: current.activeProfileId, title, messages: [], assistantMode: current.settings.assistantMode }, ...current.conversations],
      }));
      return id;
    },
    deleteConversation: (id) => {
      deletedConversationIds.current.add(id);
      clearTimer(id);
      stopPollersFor(id);
      // FULL native (Task D): drop the cached upstream channel for the
      // deleted conversation (home stays source authority).
      dropUpstreamNativeFor([id]);
      // Prune task ids for this conversation so task-keyed artifact state
      // does not linger after the conversation is gone (F6 privacy).
      const taskIdsForConv = (tasksByConvRef.current[id] ?? [])
        .map((t) => t?.id)
        .filter((taskId): taskId is string => typeof taskId === 'string');
      setChatErrors((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      setTaskErrors((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      setTasksLoading((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      if (taskIdsForConv.length > 0) {
        setTaskArtifacts((current) => {
          const next = { ...current };
          for (const taskId of taskIdsForConv) delete next[taskId];
          return next;
        });
      }
      // Server history is home-authoritative and stays; this removes the device copy.
      setState((current) => {
        const nextLinks = { ...current.homeLinks };
        delete nextLinks[id];
        return {
          ...current,
          homeLinks: nextLinks,
          conversations: current.conversations.filter((conversation) => conversation.id !== id),
        };
      });
      setTasksByConv((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
    },
    openConversation,
    sendMessage,
    retryMessage,
    enrollHome,
    enrollWithSetupJson,
    revokeEnrollment,
    useDemoMode,
    verifyHomeConnection,
    notifications,
    enableNotifications,
    disableNotifications,
    upstreamCapability,
    requestedUpstreamMode,
    setRequestedUpstreamMode: (mode) => {
      requestedUpstreamModeRef.current = mode;
      setRequestedUpstreamMode(mode);
    },
    upstreamSelection,
    upstreamSetupMessage,
    upstreamBots,
    upstreamBotsLoading,
    upstreamBotsError,
    refreshUpstreamBots,
    isNativeConversation,
    nativeTasksByConv,
    nativeTasksLoading,
    nativeTasksError,
    refreshNativeTasks,
    retryNativeTask,
    nativeApprovals,
    nativeApprovalsLoading,
    nativeApprovalsError,
    nativeApprovalsBusy,
    refreshNativeApprovals,
    decideNativeApproval,
    nativeAnswers,
    setNativeAnswer,
    respondNativeQuestion,
    nativeWatchState,
    openTaskFromNotification,
    configureBackend,
    clearBackend,
    account,
    refreshAccountConfig,
    signInWithProvider,
    signOutAccount,
    retryAccountRefresh,
    refreshBackendHomes,
    joinBackendHome,
    selectBackendHome,
    mintActivationTicket,
    refreshTasks,
    submitHomeTask,
    answerTaskQuestion,
    decideTaskApproval,
    cancelHomeTask,
    loadTaskArtifacts,
    downloadTaskArtifact,
    saveTaskArtifact,
    beginCall: (conversationId) => {
      if (activeCallRef.current !== null) return false;
      activeCallRef.current = conversationId;
      setActiveCallId(conversationId);
      return true;
    },
    endCall: (conversationId) => {
      if (activeCallRef.current !== conversationId) return;
      activeCallRef.current = null;
      setActiveCallId(null);
    },
    activeProfile,
    updateSettings: (patch) => {
      if (patch.assistantMode === 'demo') void useDemoMode();
      else setState((current) => ({ ...current, settings: { ...current.settings, ...patch } }));
    },
    toggleLike: (id) => setState((current) => ({ ...current, liked: current.liked.includes(id) ? current.liked.filter((item) => item !== id) : [...current.liked, id] })),
    toggleSave: (id) => setState((current) => ({ ...current, saved: current.saved.includes(id) ? current.saved.filter((item) => item !== id) : [...current.saved, id] })),
    setOnboardingCompleted: async (completed) => {
      const nextState = { ...stateRef.current, onboardingCompleted: completed };
      try {
        await AsyncStorage.setItem(KEY, JSON.stringify(nextState));
      } catch {
        setSaveError(true);
        return false;
      }
      setOnboardingSessionCompleted(false);
      setSaveError(false);
      setState((current) => ({ ...current, onboardingCompleted: completed }));
      return true;
    },
    resetDemo: async () => {
      connectionAttempt.current += 1;
      timers.current.forEach((_, conversationId) => clearTimer(conversationId));
      stopPollersFor(null);
      deletedConversationIds.current.clear();
      const prev = identityRef.current;
      await disableHomePushBestEffort();
      clearNotificationsForScope(scopeToken(prev));
      try {
        await AsyncStorage.removeItem(KEY);
        await AsyncStorage.removeItem(HOME_LINKS_KEY);
        const { client, backend: coordinator, accountManager } = getClients();
        await client.enterDemoMode().catch(() => {});
        await coordinator.clearBackend().catch(() => {});
        await accountManager.logout().catch(() => {});
      identityRef.current = null;
      identityGenerationRef.current += 1;
      // FULL native (Task D): demo reset clears everything — fence late
      // native callbacks and clear the roster/channel cache.
      resetUpstreamNativeScope('reset-demo');
      nativeOutboxRef.current = {};
      lastServerUserIdsRef.current = {};
      persistNativeOutbox();
      stopAllNativeWatches();
      decisionGateRef.current = new DecisionGate();
      setOnboardingSessionCompleted(false);
      setCapabilityResolved(false);
      setNativeApprovals(null);
      setNativeApprovalsError(null);
      setNativeApprovalsBusy({});
      setNativeAnswers({});
      nativeAnswersRef.current = {};
      setNativeWatchState({});
      setNativeTasksByConv({});
      setNativeTasksLoading({});
      setNativeTasksError({});
      // FULL upstream capability is per-pairing; a demo reset clears it.
      setUpstreamCapability(null);
      setUpstreamBots(null);
      setUpstreamBotsError(null);
      setRequestedUpstreamMode('full');
      setIdentityResolved(true);
        setEnrollment(null);
        setAccount({ status: 'signed-out', accountId: null, issuer: null, backendUrl: null, claims: null, error: null });
        setBackend({ backendUrl: '', memberHomes: [], presence: {}, backendError: null });
        setConnectionStatus('disconnected');
        setConnectionError(null);
        setTasksByConv({});
        setTasksLoading({});
        setTaskErrors({});
        setTaskArtifacts({});
        clearArtifactCacheFor(prev);
      } catch {
        setSaveError(true);
      }
      setState(seed());
    },
  };
  }, [
    state, status, saveError, onboardingSessionCompleted, typing, chatErrors, connectionStatus, connectionError,
    enrollment, identityResolved, backend, account, tasksByConv, tasksLoading, taskErrors, taskArtifacts,
    activeCallId, activeProfile, notifications, openConversation, sendMessage, retryMessage,
    enrollHome, enrollWithSetupJson, revokeEnrollment, useDemoMode, verifyHomeConnection,
    enableNotifications, disableNotifications, openTaskFromNotification,
    upstreamCapability, requestedUpstreamMode, capabilityResolved,
    upstreamBots, upstreamBotsLoading, upstreamBotsError, refreshUpstreamBots, isNativeConversation,
    nativeTasksByConv, nativeTasksLoading, nativeTasksError, refreshNativeTasks, retryNativeTask,
    nativeApprovals, nativeApprovalsLoading, nativeApprovalsError, nativeApprovalsBusy,
    refreshNativeApprovals, decideNativeApproval, nativeAnswers, setNativeAnswer,
    respondNativeQuestion, nativeWatchState,
    configureBackend, clearBackend,
    refreshAccountConfig, signInWithProvider, signOutAccount, retryAccountRefresh,
    refreshBackendHomes, joinBackendHome, selectBackendHome, mintActivationTicket, refreshTasks,
    submitHomeTask, answerTaskQuestion, decideTaskApproval, cancelHomeTask,
    loadTaskArtifacts, downloadTaskArtifact, saveTaskArtifact, stopPollersFor, getClients,
    clearArtifactCacheFor,
  ]);

  return <MeContext.Provider value={value}>{children}</MeContext.Provider>;
}

export function useMe() {
  const context = useContext(MeContext);
  if (!context) throw new Error('useMe must be used within MeProvider');
  return context;
}
