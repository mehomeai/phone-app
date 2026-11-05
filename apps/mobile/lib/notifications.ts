// Native task-push adapter (F8, Expo Notifications SDK 58).
//
// The maintained `expo-notifications` SDK owns the OS permission prompt, the
// Expo push token, foreground/cold-start delivery, and token rotation. This
// module owns ONLY the app wiring so it stays unit-testable without native
// modules: everything native is injected through `NotificationSdk` (tests
// inject a fake; the app injects the real SDK surface). No file here imports
// `expo-notifications` at the top level, so Node syntax checks and portable
// tests run with zero native installs.
//
// Declared SDK (apps/mobile/package.json, not installed on disk here):
//   expo-notifications ~58.1.8, expo-device ~58.0.1, expo-constants ~58.0.12.
// Official API used (Expo SDK 58 docs):
//   getPermissionsAsync / requestPermissionsAsync,
//   getExpoPushTokenAsync({ projectId }),
//   addNotificationReceivedListener / addNotificationResponseReceivedListener,
//   setNotificationChannelAsync (+ AndroidImportance.DEFAULT) for the default
//   channel on Android.
// Subscription removal uses EventSubscription.remove() on the object each
// add*Listener call returns; expo-notifications 58.1.8 exports no
// removeNotificationSubscription (verified against the published types), so
// the injected SDK keeps it only as an optional fallback in
// removeSdkSubscription below.
//
// Security/privacy rules enforced by the caller (MeContext) with helpers here:
// - No first-launch surprise: nothing is prompted or registered until the
//   user taps the opt-in button (DevicePanel "Notify me on this phone").
// - projectId is the PUBLIC Expo project id from app config
//   (Constants.easConfig.projectId / extra.eas.projectId) — never a home
//   admin/provider key. Missing projectId/module/non-device → unavailable,
//   never a fake-enabled state.
// - The Expo token never touches AsyncStorage/logs/task inputs; the SDK
//   keeps it and the UI shows a redacted suffix only.
// - Web preview: unavailable, no insecure fake push.
// - Rotation: the SDK push-token listener yields the RAW APNs/FCM token —
//   the adapter always re-gets the EXPO token via getExpoPushTokenAsync
//   before any home register.
// - Full-scope epoch fencing: every async callback captures the scope
//   generation + token and drops late results after logout/unpair/revoke,
//   account switch, mode change, or endpoint change.

import {
  isExpoPushTokenFormat,
  parseNotificationData,
  pushTokenSuffix,
} from '../../../src/notifications.ts';
import type { NotificationData } from '../../../src/notifications.ts';

export type { NotificationData };
/** Re-exported canonical parser (used by NotificationGate's hold path). */
export { parseNotificationData };

/** Minimal injected surface of `expo-notifications` (real or fake). */
export interface NotificationSdkSubscription {
  remove(): void;
}

export interface NotificationSdk {
  getPermissionsAsync(): Promise<{ status: string; granted?: boolean }>;
  requestPermissionsAsync(): Promise<{ status: string; granted?: boolean }>;
  getExpoPushTokenAsync(options: { projectId?: string }): Promise<{ data?: string; type?: string } | { toString(): string }>;
  addNotificationReceivedListener(
    cb: (event: { request: { content: { data?: unknown; title?: string | null; body?: string | null } } }) => void,
  ): NotificationSdkSubscription | { remove(): void };
  addNotificationResponseReceivedListener(
    cb: (response: { notification: { request: { content: { data?: unknown } } } }) => void,
  ): NotificationSdkSubscription | { remove(): void };
  /** Optional rotation listener (device push token changed). */
  addPushTokenListener?(
    cb: (token: unknown) => void,
  ): NotificationSdkSubscription | { remove(): void };
  removeNotificationSubscription?(sub: unknown): void;
  setNotificationChannelAsync?(id: string, opts: Record<string, unknown>): Promise<void>;
}

export interface NotificationProjectConstants {
  easConfig?: { projectId?: string | null } | null;
  expoConfig?: { extra?: { eas?: { projectId?: string | null } } | null } | null;
  extra?: { eas?: { projectId?: string | null } } | null;
}

/** Resolve the PUBLIC Expo project id from app config (never a credential). */
export function resolveExpoProjectId(
  constants: NotificationProjectConstants | null | undefined,
): string | null {
  const direct = constants?.easConfig?.projectId;
  if (typeof direct === 'string' && direct.trim()) return direct.trim().slice(0, 128);
  const nested = constants?.expoConfig?.extra?.eas?.projectId;
  if (typeof nested === 'string' && nested.trim()) return nested.trim().slice(0, 128);
  const extra = constants?.extra?.eas?.projectId;
  if (typeof extra === 'string' && extra.trim()) return extra.trim().slice(0, 128);
  return null;
}

export interface NotificationAvailability {
  available: boolean;
  reason: string | null;
}

/**
 * Gate: web preview, missing module, missing projectId, or non-device
 * (simulator without push support) → unavailable with an honest reason.
 * Never reports a fake-enabled state.
 */
export function notificationAvailability(input: {
  platform: string;
  sdk: NotificationSdk | null | undefined;
  projectId: string | null | undefined;
  isDevice: boolean;
}): NotificationAvailability {
  if (input.platform === 'web') {
    return { available: false, reason: 'Push notifications need the native app; the web preview cannot receive them.' };
  }
  if (!input.sdk) {
    return { available: false, reason: 'Notification module is missing. Rebuild the native app with Expo Notifications.' };
  }
  if (!input.projectId) {
    return { available: false, reason: 'Expo project ID is missing from app config. Rebuild with the EAS project ID.' };
  }
  if (!input.isDevice) {
    return { available: false, reason: 'Push tokens need a physical device or a push-capable emulator.' };
  }
  return { available: true, reason: null };
}

function permissionGranted(result: { status: string; granted?: boolean }): boolean {
  if (typeof result.granted === 'boolean') return result.granted;
  return result.status === 'granted';
}

function tokenToString(token: unknown): string | null {
  if (typeof token === 'string' && token) return token;
  if (token && typeof token === 'object') {
    const record = token as Record<string, unknown>;
    if (typeof record['data'] === 'string' && record['data']) return record['data'] as string;
    try {
      const text = (token as { toString(): string }).toString();
      if (typeof text === 'string' && text.startsWith('ExponentPushToken')) return text;
    } catch {
      return null;
    }
  }
  return null;
}

export interface OptInResult {
  granted: boolean;
  expoPushToken: string | null;
  /** Redacted suffix for UI only (never the raw token). */
  tokenSuffix: string | null;
  reason: string | null;
}

/**
 * User-initiated opt-in: ask OS permission, then mint the EXPO push token
 * with the app's public projectId. Returns the token for immediate home
 * registration (caller never persists it). Permission denied → granted:false
 * with no token (caller skips registration or registers disabled-state only
 * when a token already exists — never a false enabled claim).
 */
export async function optInForPushToken(input: {
  sdk: NotificationSdk;
  projectId: string;
}): Promise<OptInResult> {
  const current = await input.sdk.getPermissionsAsync().catch(() => null);
  let granted = current ? permissionGranted(current) : false;
  if (!granted) {
    const asked = await input.sdk.requestPermissionsAsync();
    granted = permissionGranted(asked);
  }
  if (!granted) {
    return { granted: false, expoPushToken: null, tokenSuffix: null, reason: 'OS notification permission was denied.' };
  }
  const raw = await input.sdk.getExpoPushTokenAsync({ projectId: input.projectId });
  const token = tokenToString(raw);
  if (!token || !isExpoPushTokenFormat(token)) {
    return { granted: true, expoPushToken: null, tokenSuffix: null, reason: 'The push token was unreadable. Try again.' };
  }
  return { granted: true, expoPushToken: token, tokenSuffix: pushTokenSuffix(token), reason: null };
}

/**
 * Rotation: re-get the EXPO token (never forward the raw APNs/FCM token the
 * listener hands over) and hand it to the caller for home re-registration.
 * The caller fences on the full-scope epoch before registering.
 */
export async function refreshExpoTokenForRotation(input: {
  sdk: NotificationSdk;
  projectId: string;
}): Promise<string | null> {
  try {
    const raw = await input.sdk.getExpoPushTokenAsync({ projectId: input.projectId });
    const token = tokenToString(raw);
    return token && isExpoPushTokenFormat(token) ? token : null;
  } catch {
    return null;
  }
}

/** Default Android channel (generic, no task content in the channel). */
export async function ensureAndroidChannel(
  sdk: NotificationSdk,
  platform: string,
): Promise<void> {
  if (platform !== 'android' || !sdk.setNotificationChannelAsync) return;
  await sdk
    .setNotificationChannelAsync('me-tasks', {
      name: 'Task updates',
      description: 'Human-wait and completion alerts from your Me Home.',
      importance: 'default',
      sound: 'default',
    })
    .catch(() => {});
}

/** Extract the raw `data` object from a foreground/response notification. */
export function extractPushData(content: { data?: unknown } | null | undefined): unknown {
  if (!content || typeof content !== 'object') return null;
  const data = (content as { data?: unknown }).data ?? content;
  return data ?? null;
}

/**
 * Parse + scope-gate a push payload in one step for the tap/foreground path.
 * Returns the verified metadata or null (malformed, or installation/device
 * mismatch against the CURRENT paired scope → drop before any fetch).
 */
export function verifyPushDataForScope(
  rawData: unknown,
  scope: { installationId: string; deviceId: string } | null | undefined,
): NotificationData | null {
  const parsed = parseNotificationData(rawData);
  if (!parsed) return null;
  if (!scope) return null;
  if (parsed.installationId !== scope.installationId) return null;
  if (parsed.deviceId !== scope.deviceId) return null;
  return parsed;
}

export function removeSdkSubscription(
  sdk: NotificationSdk,
  sub: unknown,
): void {
  try {
    if (sub && typeof (sub as { remove?: unknown }).remove === 'function') {
      (sub as { remove(): void }).remove();
      return;
    }
    sdk.removeNotificationSubscription?.(sub);
  } catch {
    // Best effort cleanup.
  }
}
