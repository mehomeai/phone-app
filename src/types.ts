// Shared identity and message types for the phone-app paired-home adapter.
//
// Identity rule (product-architecture.md): user, phone/device, conversation,
// task, and model invocation are different identities. Never reuse one session
// id for all of them. The home owns authoritative history; the phone keeps a
// cache for offline UX only.

export type UserId = string;
export type DeviceId = string;
export type ConversationId = string;
export type MessageId = string;
export type RequestId = string;

export type AssistantMode = 'demo' | 'home';

/** Distinguishes a request the home durably accepted from demo/scripted output. */
export type AcceptedBy = 'home' | 'demo';

export type ConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'error'
  | 'offline';

export interface HomeChatMessage {
  /** Home-authoritative id once acknowledged; client-generated id before that. */
  id: MessageId;
  conversationId: ConversationId;
  /** Null for home/system notices; otherwise the authoring household user. */
  authorUserId: UserId | null;
  role: 'user' | 'assistant' | 'system';
  text: string;
  createdAt: number;
  acceptedBy: AcceptedBy;
  /** Present only after the home durably accepts the message. */
  homeMessageId?: MessageId;
  /** Idempotency key used for the send; used to dedupe reconnect replays. */
  requestId?: RequestId;
  /** True while the message is queued locally but not yet home-acknowledged. */
  pending?: boolean;
}

export interface ConversationSnapshot {
  id: ConversationId;
  ownerUserId: UserId;
  title: string;
  /** Monotonic per-conversation version for cache comparison/replay cursors. */
  version: number;
  /** Opaque replay cursor for incremental sync. */
  cursor: string;
  messages: HomeChatMessage[];
}

export interface EnrollmentSummary {
  homeId: string;
  homeBaseUrl: string;
  deviceId: DeviceId;
  userId: UserId;
  protocolVersion: string;
  enrolledAt: number;
  sessionExpiresAt: number | null;
  /** Never includes secrets/tokens. */
  redacted: true;
}

export type TaskStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'waiting_input'
  | 'waiting_approval';

export interface TaskQuestion {
  id: string;
  prompt?: string;
  [key: string]: unknown;
}

export interface TaskApproval {
  id: string;
  [key: string]: unknown;
}

export interface TaskProgressEvent {
  date?: string;
  kind?: string;
  title?: string;
  [key: string]: unknown;
}

export interface TaskArtifactMeta {
  id: string;
  name?: string;
  sha256?: string;
  size?: number;
  created_at?: number;
  [key: string]: unknown;
}

/** Home-owned persisted task view (H2). No workspace paths or secrets. */
export interface TaskView {
  id: string;
  conversationId: string;
  title: string;
  status: TaskStatus;
  output?: string;
  error?: string;
  questions?: TaskQuestion[];
  pendingApprovals?: TaskApproval[];
  progress?: TaskProgressEvent[];
  artifacts?: TaskArtifactMeta[];
  /** Optional H6 hierarchy (compatible: absent when the home omits it). */
  parentTaskId?: string;
  rootTaskId?: string;
  childTaskIds?: string[];
  /** Child ids still blocking this task; other work can continue. */
  waitingChildren?: string[];
  model?: { provider?: string; model?: string };
  createdAt?: number;
  updatedAt?: number;
}

export interface SubmitTaskInput {
  request: string;
  title?: string;
  /** Narrow-only capability grants; home clamps to its policy. */
  capabilities?: Record<string, boolean>;
  budgets?: Record<string, number>;
}
