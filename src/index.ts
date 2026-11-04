// Public surface of the portable paired-home adapter.
// Expo hosts import from here; Node tests import the same modules.

export type {
  AssistantMode,
  AcceptedBy,
  ConnectionStatus,
  ConversationId,
  ConversationSnapshot,
  DeviceId,
  EnrollmentSummary,
  HomeChatMessage,
  MessageId,
  RequestId,
  SubmitTaskInput,
  TaskArtifactMeta,
  TaskApproval,
  TaskProgressEvent,
  TaskQuestion,
  TaskStatus,
  TaskView,
  UserId,
} from './types.ts';
export type { SecureStorage, CacheStorage } from './secure-storage.ts';
export {
  createMemorySecureStorage,
  createMemoryCacheStorage,
  createExpoSecureStoreAdapter,
  createAsyncStorageCacheAdapter,
  cacheLeaksSecrets,
  redactHeaders,
} from './secure-storage.ts';
export {
  CONTRACT_VERSION,
  PROTOCOL_VERSION,
  ROUTES,
  H1_CONTRACT_PATH,
  H1_OPENAPI_PATH,
  SERVER_ERRORS,
  NOTIFICATIONS_CONTRACT_VERSION,
  NOTIFICATIONS_CONTRACT_PATH,
  NOTIFICATION_ERRORS,
} from './home-api-v1.ts';
export type { NotificationKind } from './home-api-v1.ts';
export {
  parseNotificationData,
  isNotificationForScope,
  NotificationDedupe,
  pushTokenSuffix,
  isExpoPushTokenFormat,
} from './notifications.ts';
export type {
  NotificationData,
  NotificationRegisterInput,
  NotificationRegisterResult,
  NotificationStatusResult,
} from './notifications.ts';
export { parseSetupInvitation } from './setup-invitation.ts';
export type { SetupInvitation } from './setup-invitation.ts';
export {
  HomeClientError,
  isHomeClientError,
  errorForStatus,
} from './errors.ts';
export type { HomeClientErrorCode } from './errors.ts';
export {
  PairedHomeClient,
  ENROLLMENT_STORAGE_KEY,
  CACHE_PREFIX,
  randomUuidV4,
  assertSameOrigin,
} from './paired-home-client.ts';
export type {
  VisibleOptions,
  ReconcileResult,
  IdentityTuple,
  ConversationRef,
  HomeLinkRef,
} from './home-identity.ts';
export type { ApprovalSummary, TaskRelations } from './approval-summary.ts';
export {
  summarizeApproval,
  parseTaskRelations,
  maskSensitiveValue,
  maskApprovalArgs,
  isBrowserFillAction,
  describeApprovalTarget,
} from './approval-summary.ts';
export {
  visibleConversations,
  reconcileOnEnrollmentChange,
  filterStateToScope,
  stampLinkScope,
  rebindLinksEndpoint,
  verifyEndpointIdentity,
  linkScopeMatches,
  normalizeOrigin,
  scopeToken,
} from './home-identity.ts';
export {
  BackendCoordinator,
  BACKEND_URL_KEY,
  BACKEND_ACCOUNT_TOKEN_KEY,
  assertBackendSameOrigin,
} from './backend-client.ts';
export type {
  MemberHome,
  BackendCoordinatorOptions,
  ActivationTicket,
  ActivationTicketMode,
  ActivationHandoff,
  MintActivationTicketInput,
} from './backend-client.ts';
export {
  EphemeralRequestGuard,
  activationScopeFingerprint,
  shouldPublishTicketArrival,
  shouldPublishCopyFeedback,
  UNKNOWN_TICKET_OUTCOME_MESSAGE,
} from './ephemeral-guard.ts';
export {
  parseActivationTicket,
  errorForActivationStatus,
  isActivationTicketExpired,
} from './backend-client.ts';
export {
  AccountAuthManager,
  AUTH_BUNDLE_KEY,
  AUTH_BACKEND_URL_KEY,
  parseAuthConfig,
  isHostedReady,
  isTrustedIssuer,
  validateRedirectUri,
  selectRedirectUri,
  buildLoginRequest,
  buildLoginExtraParams,
  accountIdentityChanged,
} from './account-auth.ts';
export type {
  AuthConfig,
  DevAuthConfig,
  HostedAuthConfig,
  NotReadyAuthConfig,
  AccountInfo,
  AuthBundle,
  AuthSdkTokenSet,
  AuthSdkDiscovery,
  AccountAuthSdk,
  LoginRequest,
  AccountAuthManagerOptions,
} from './account-auth.ts';
export type {
  DeviceKey,
  Invitation,
  PairedHomeClientOptions,
  SendOptions,
  SendResult,
} from './paired-home-client.ts';
export { DemoHomeAdapter } from './demo-adapter.ts';
export { FakeHomeServer } from './fake-home-server.ts';
export { buildTwoUserFixture, fixtureDeviceLabel } from './fixtures.ts';
export {
  ARTIFACT_MAX_BYTES,
  ARTIFACT_TEXT_PREVIEW_MAX_CHARS,
  ARTIFACT_RANDOM_HEX_LEN,
  ARTIFACT_BASENAME_MAX_LEN,
  artifactExt,
  sanitizeArtifactFilename,
  fnv1aHex,
  scopedArtifactDirName,
  randomArtifactHex,
  buildCachedArtifactFilename,
  assertArtifactSizeOk,
  isPreviewableText,
  isPreviewableImage,
  isBlockedInlinePreview,
  canPreviewInline,
  mimeTypeForFilename,
  decodeTextPreview,
} from './artifact-cache.ts';
export type {
  UpstreamAgentMode,
  UpstreamCapability,
  UpstreamExecutionSelection,
  RequestedUpstreamMode,
  AppSelectionInput,
} from './upstream-capability.ts';
export {
  parseUpstreamCapability,
  selectExecutionMode,
  isUpstreamSetupNeeded,
  describeUpstreamSetupNeeded,
  resolveAppSelection,
} from './upstream-capability.ts';
export type {
  NativeBot,
  NativeBotLifecycle,
  NativeChannel,
  NativeTranscriptMessage,
  NativeApprovalInbox,
  NativeApprovalDecision,
  NativeCheckInItem,
  NativeStartedItem,
  NativeTaskStatus,
  NativeBotTask,
  NativeRoutineStatus,
  NativeRoutine,
  NativeMemory,
  NativeRuleBehaviour,
  NativeApprovalRule,
  NativeTransport,
  NativeSendInput,
} from './upstream-native.ts';
export {
  UPSTREAM_NATIVE_PIN,
  UPSTREAM_NATIVE_SOURCE,
  UPSTREAM_NATIVE_API_PATH,
  UPSTREAM_NATIVE_ROUTES_PATH,
  NATIVE_BEHAVIOUR_LABELS,
  NATIVE_MESSAGE_MAX_CHARS,
  NATIVE_PAGE_LIMIT_MAX,
  NATIVE_ROUTES,
  isUuid,
  parseNativeBot,
  parseNativeBotList,
  parseNativeChannel,
  parseNativeChannelEnvelope,
  parseNativeConversationPage,
  parseNativeHistory,
  parseNativeApprovalInbox,
  parseNativeApprovalDecision,
  parseNativeBotTask,
  resolveUpstreamNativeBase,
  isDisplayRole,
  transcriptText,
  UpstreamNativeClient,
  UpstreamNativeScope,
} from './upstream-native.ts';
export type {
  ChannelBinding,
  DisplayMessage,
  PendingSend,
  ScopeCapture,
  ScopeFence,
  SleepFn,
  SendSyncInput,
  SendSyncResult,
  WatchSnapshotInput,
  WatchRunnerInput,
  WatchRunnerOutcome,
} from './upstream-conversation.ts';
export {
  mergeLinkMetadata,
  externalIdFor,
  toDisplayMessages,
  isNativeWorkPending,
  runNativeWatch,
  NATIVE_WATCH_INTERVALS_MS,
  reconcilePendingSends,
  NativeConversationController,
  ChannelSingleflight,
  DecisionGate,
} from './upstream-conversation.ts';
