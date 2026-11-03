// Portable opt-in task notification helpers (F8, zero deps).
//
// Speaks the frozen companion contract `home-notifications-v1`
// (infra-server/contracts/home-notifications-v1.md). The home never creates
// real push resources unless the operator opts in AND the phone registers
// with permission_enabled:true. Push payloads are metadata-only; the phone
// never navigates from push text, titles, or URLs.
//
// Rules enforced here:
// - parse ONLY the bounded protocol metadata
//   (installation_id/device_id/task_id/kind/event_id); ignore title/body/URLs.
// - Both installation AND device must match the CURRENT paired full identity
//   before any fetch; stale/unknown/cold-start identities refuse.
// - Dedupe on event_id (at-least-once delivery after home restarts).
// - Foreground delivery and tap are handled separately so a seen banner does
//   NOT swallow a later legitimate user open.
// - Expo push tokens never touch AsyncStorage/logs/task inputs; the native
//   adapter keeps the token in SDK memory/cache only and shows a suffix.

import type { IdentityTuple } from './home-identity.ts';
import type { NotificationKind } from './home-api-v1.ts';

export type { NotificationKind };

export interface NotificationData {
  installationId: string;
  deviceId: string;
  taskId: string;
  kind: NotificationKind;
  eventId: string;
}

export interface NotificationRegisterInput {
  expoPushToken: string;
  permissionEnabled: boolean;
  /** Optional public project id (app config, never a credential). */
  projectId?: string;
}

export interface NotificationRegisterResult {
  registered: boolean;
  enabled: boolean;
  provider: string;
  permissionEnabled: boolean;
  installationId: string;
}

export interface NotificationStatusResult {
  registered: boolean;
  enabled: boolean;
  provider: string;
  permissionEnabled: boolean;
  /** Non-reversible suffix only; never the raw token. */
  tokenSuffix?: string;
  createdAt?: number;
  updatedAt?: number;
  installationId: string;
}

const KIND_SET: ReadonlySet<string> = new Set([
  'waiting_input',
  'waiting_approval',
  'completed',
  'failed',
  'cancelled',
]);

const ID_CHARS_RE = /^[A-Za-z0-9:_\-.]{1,128}$/;
const EVENT_CHARS_RE = /^[A-Za-z0-9:_\-.]{1,256}$/;

function asBoundedId(value: unknown, max: number, pattern: RegExp): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) return null;
  if (!pattern.test(trimmed)) return null;
  return trimmed;
}

/**
 * Parse ONLY the bounded protocol metadata from a push payload.
 * Ignores title/body/URLs entirely — callers must never navigate from them.
 * Returns null for any malformed, unbounded, or unknown-shape payload.
 */
export function parseNotificationData(raw: unknown): NotificationData | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  // Accept either the bare data object or { data: {...} } (Expo wraps data).
  const data =
    record['data'] && typeof record['data'] === 'object' && !Array.isArray(record['data'])
      ? (record['data'] as Record<string, unknown>)
      : record;
  const installationId = asBoundedId(data['installation_id'], 128, ID_CHARS_RE);
  const deviceId = asBoundedId(data['device_id'], 128, ID_CHARS_RE);
  const taskId = asBoundedId(data['task_id'], 128, ID_CHARS_RE);
  const eventId = asBoundedId(data['event_id'], 256, EVENT_CHARS_RE);
  const kindRaw = typeof data['kind'] === 'string' ? data['kind'].trim() : '';
  if (!installationId || !deviceId || !taskId || !eventId) return null;
  if (!KIND_SET.has(kindRaw)) return null;
  return {
    installationId,
    deviceId,
    taskId,
    kind: kindRaw as NotificationKind,
    eventId,
  };
}

/**
 * Scope gate: BOTH installation AND device must match the CURRENT paired
 * full identity before any fetch. Unknown/stale/cold-start identities
 * (null scope) refuse — the caller holds the tap until identity resolves
 * or drops it. Endpoint origin is part of the scope tuple upstream; a
 * same-UUID clone on a different endpoint never passes because the tuple's
 * installation match is only one of several gates (the client also refuses
 * to forward credentials cross-origin and refuses endpoint rebinds).
 */
export function isNotificationForScope(
  data: NotificationData,
  scope: IdentityTuple | null | undefined,
): boolean {
  if (!scope) return false;
  if (!scope.installationId || !scope.deviceId) return false;
  return (
    data.installationId === scope.installationId &&
    data.deviceId === scope.deviceId
  );
}

/**
 * Bounded scoped event dedupe: duplicates after a home restart/outbox retry
 * are ignored. Scoped by the full identity token so a re-pair never
 * inherits the previous user's seen set. Bounded (default 200 entries) —
 * no unbounded growth from a hostile or chatty sender.
 */
export class NotificationDedupe {
  private readonly maxEntries: number;
  private readonly seenByScope = new Map<string, Map<string, number>>();

  constructor(maxEntries = 200) {
    this.maxEntries = Math.max(1, Math.min(maxEntries, 2000));
  }

  /** True when this scoped event was already seen (duplicate). */
  seen(scopeTokenValue: string, eventId: string): boolean {
    const scoped = this.seenByScope.get(scopeTokenValue);
    return scoped ? scoped.has(eventId) : false;
  }

  /** Mark a scoped event seen. Returns true when it was new. */
  mark(scopeTokenValue: string, eventId: string, now = Date.now()): boolean {
    let scoped = this.seenByScope.get(scopeTokenValue);
    if (!scoped) {
      scoped = new Map();
      this.seenByScope.set(scopeTokenValue, scoped);
    }
    if (scoped.has(eventId)) return false;
    scoped.set(eventId, now);
    // Bounded: evict oldest first.
    while (scoped.size > this.maxEntries) {
      const oldest = scoped.keys().next();
      if (oldest.done) break;
      scoped.delete(oldest.value);
    }
    // Bound the number of scopes too (paired phone rotates rarely).
    while (this.seenByScope.size > 8) {
      const oldestScope = this.seenByScope.keys().next();
      if (oldestScope.done) break;
      this.seenByScope.delete(oldestScope.value);
    }
    return true;
  }

  /** Drop one scope (logout/unpair/revoke/mode/endpoint change). */
  clearScope(scopeTokenValue: string): void {
    this.seenByScope.delete(scopeTokenValue);
  }

  clearAll(): void {
    this.seenByScope.clear();
  }

  size(scopeTokenValue: string): number {
    return this.seenByScope.get(scopeTokenValue)?.size ?? 0;
  }
}

/** Redacted token suffix for debug UI (never the raw token). */
export function pushTokenSuffix(token: string): string {
  const s = String(token ?? '');
  return s.length <= 8 ? `…${s}` : `…${s.slice(-8)}`;
}

/** Strict Expo push-token shape (mirrors the home validator). */
export function isExpoPushTokenFormat(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (value.length < 20 || value.length > 256) return false;
  return /^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9\-_]{1,128}\]$/.test(value);
}
