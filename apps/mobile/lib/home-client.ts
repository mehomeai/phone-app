// Mobile binding to the shared paired-home + backend coordination clients.
//
// The authoritative logic (enrollment state machine, storage split,
// request_key idempotency, task polling, error taxonomy) lives in the
// portable package at `phone-app/src/` and is imported here with explicit
// `.ts` extensions (allowed by `allowImportingTsExtensions` in tsconfig;
// Metro resolves the literal files). This module only adapts the native
// platform pieces: Expo SecureStore for secrets, AsyncStorage for the
// message cache, and loopback allowance for local development.
//
// Prototype note: the old bearer-token home adapter is gone. Enrollment uses
// a one-time invitation (invitation_id + invitation_secret); the home issues
// the device credential at pair time and short-lived sessions are renewed
// from SecureStore without repeating setup.

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import {
  AccountAuthManager,
  BackendCoordinator,
  DemoHomeAdapter,
  PairedHomeClient,
  createAsyncStorageCacheAdapter,
  createExpoSecureStoreAdapter,
  createMemoryCacheStorage,
  createMemorySecureStorage,
} from '../../../src/index.ts';
import type { SecureStorage } from '../../../src/index.ts';

declare const __DEV__: boolean;

export {
  AccountAuthManager,
  BackendCoordinator,
  DemoHomeAdapter,
  PairedHomeClient,
} from '../../../src/index.ts';
export {
  parseAuthConfig,
  isHostedReady,
  isTrustedIssuer,
  selectRedirectUri,
  buildLoginRequest,
  buildLoginExtraParams,
  accountIdentityChanged,
  AUTH_BUNDLE_KEY,
} from '../../../src/index.ts';
export type {
  AuthConfig,
  HostedAuthConfig,
  AccountInfo,
  AuthBundle,
} from '../../../src/index.ts';
export type {
  ActivationHandoff,
  ActivationTicket,
  ActivationTicketMode,
  ConnectionStatus,
  ConversationSnapshot,
  EnrollmentSummary,
  HomeChatMessage,
  IdentityTuple,
  MemberHome,
  MintActivationTicketInput,
  NotificationData,
  NotificationRegisterResult,
  NotificationStatusResult,
  SetupInvitation,
  TaskStatus,
  TaskView,
  ApprovalSummary,
  TaskRelations,
} from '../../../src/index.ts';
export {
  EphemeralRequestGuard,
  activationScopeFingerprint,
  errorForActivationStatus,
  isActivationTicketExpired,
  parseActivationTicket,
  shouldPublishCopyFeedback,
  shouldPublishTicketArrival,
  UNKNOWN_TICKET_OUTCOME_MESSAGE,
  randomUuidV4,
  reconcileOnEnrollmentChange,
  filterStateToScope,
  stampLinkScope,
  rebindLinksEndpoint,
  verifyEndpointIdentity,
  visibleConversations,
  linkScopeMatches,
  normalizeOrigin,
  scopeToken,
  summarizeApproval,
  parseTaskRelations,
  maskSensitiveValue,
  maskApprovalArgs,
  isBrowserFillAction,
  describeApprovalTarget,
  parseNotificationData,
  isNotificationForScope,
  NotificationDedupe,
  pushTokenSuffix,
  isExpoPushTokenFormat,
  parseSetupInvitation,
  NOTIFICATIONS_CONTRACT_VERSION,
} from '../../../src/index.ts';

/** Secrets live in SecureStore on native; web pairing stays disabled. */
export function createSecureStorage(): SecureStorage {
  return createExpoSecureStoreAdapter(SecureStore);
}

/** Message history cache: AsyncStorage, never for secrets. */
export function createCacheStorage() {
  return createAsyncStorageCacheAdapter(AsyncStorage);
}

/** In-memory fallbacks for tests and the web preview (no pairing on web). */
export function createMemoryStorages() {
  return {
    secure: createMemorySecureStorage(),
    cache: createMemoryCacheStorage(),
  };
}

export function createHomeClient(secure?: SecureStorage) {
  const secretStore = secure ?? createSecureStorage();
  return new PairedHomeClient(secretStore, createCacheStorage(), {
    allowInsecureLoopback: __DEV__,
  });
}

export function createBackendCoordinator(secure?: SecureStorage) {
  const secretStore = secure ?? createSecureStorage();
  return new BackendCoordinator(secretStore, {
    allowInsecureLoopback: __DEV__,
  });
}

export function isSecureStoreAvailable(): Promise<boolean> {
  if (typeof SecureStore.isAvailableAsync !== 'function') {
    return Promise.resolve(false);
  }
  return SecureStore.isAvailableAsync().catch(() => false);
}
