// Phone-side binding to the canonical H1 contract `home-api-v1`.
// Owner: infra-server. Local contract copies (read-only, never edited here):
//   infra-server/contracts/home-api-v1.md          (authoritative for H1)
//   infra-server/contracts/home-api-v1.openapi.json (machine-readable)
//
// Identity rule (contract §Authenticated): user/device identity ALWAYS derives
// from the session-token lookup. This client never sends a user id as identity.

export const CONTRACT_VERSION = 'home-api-v1';
export const PROTOCOL_VERSION = 'me-pairing-1';

/** Expected H1 contract location, relative to the me monorepo root. */
export const H1_CONTRACT_PATH = 'infra-server/contracts/home-api-v1.md';
export const H1_OPENAPI_PATH = 'infra-server/contracts/home-api-v1.openapi.json';

export const ROUTES = {
  health: '/healthz',
  ready: '/readyz',
  pair: '/v1/pair',
  sessions: '/v1/sessions',
  me: '/v1/me',
  conversations: '/v1/conversations',
  conversation: (id: string) => `/v1/conversations/${id}`,
  conversationMessages: (id: string) => `/v1/conversations/${id}/messages`,
  conversationTasks: (id: string) => `/v1/conversations/${id}/tasks`,
  task: (id: string) => `/v1/tasks/${id}`,
  taskCancel: (id: string) => `/v1/tasks/${id}/cancel`,
  taskInputs: (id: string) => `/v1/tasks/${id}/inputs`,
  taskApprovals: (id: string) => `/v1/tasks/${id}/approvals`,
  taskArtifacts: (id: string) => `/v1/tasks/${id}/artifacts`,
  taskArtifact: (taskId: string, artifactId: string) =>
    `/v1/tasks/${taskId}/artifacts/${artifactId}`,
  revokeDevice: (deviceId: string) => `/v1/devices/${deviceId}/revoke`,
  notificationsRegister: '/v1/notifications/register',
  notificationsStatus: '/v1/notifications/status',
  notificationsDisable: '/v1/notifications/disable',
} as const;

/**
 * Frozen companion contract for opt-in task push (H7/H7.1):
 * `infra-server/contracts/home-notifications-v1.md`.
 * Register/status/disable shapes and the push `data` fields are frozen for
 * the F8 phone consumer. The home never creates real push resources unless
 * the operator opts in AND the phone registers with permission_enabled:true.
 */
export const NOTIFICATIONS_CONTRACT_VERSION = 'home-notifications-v1';
export const NOTIFICATIONS_CONTRACT_PATH =
  'infra-server/contracts/home-notifications-v1.md';

/** Push `data.kind` values carried in the metadata-only payload. */
export type NotificationKind =
  | 'waiting_input'
  | 'waiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** Server error codes documented in home-notifications-v1.md. */
export const NOTIFICATION_ERRORS = {
  badRequest: 'bad_request',
  invalidPushToken: 'invalid_push_token',
  notificationsDisabled: 'notifications_disabled',
  registrationLimit: 'registration_limit',
  unauthorized: 'unauthorized',
} as const;

/** Server error codes documented in home-api-v1.md. */
export const SERVER_ERRORS = {
  badRequest: 'bad_request',
  wrongHome: 'wrong_home',
  invalidInvitation: 'invalid_invitation',
  invitationNotFound: 'invitation_not_found',
  invitationExpired: 'invitation_expired',
  invitationConsumed: 'invitation_consumed',
  invalidDevice: 'invalid_device',
  unauthorized: 'unauthorized',
  notFound: 'not_found',
  unsupportedRole: 'unsupported_role',
  requestKeyConflict: 'request_key_conflict',
  wrongState: 'wrong_state',
  modelNotConfigured: 'model_not_configured',
  modelOverrideDenied: 'model_override_denied',
  capabilityDenied: 'capability_denied',
} as const;

/** Task lifecycle states owned by the home (H2). */
export type TaskStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'waiting_input'
  | 'waiting_approval';
