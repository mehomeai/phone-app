// Native tap/foreground routing for opt-in task push (F8).
//
// Mounted once inside MeProvider (see app/_layout.tsx). Subscribes the real
// Expo SDK listeners ONLY on native when paired; the web preview subscribes
// to nothing. All routing derives from verified home data:
//
// - Parse ONLY bounded protocol metadata (installation/device/task/kind/
//   event); push title/body/URLs are never used for data or navigation.
// - BOTH installation AND device must match the CURRENT paired full identity
//   before any fetch; stale/unknown/cold-start-unresolved taps are held
//   until identity resolves, then dropped if they still mismatch.
// - The tap fetches the ACTUAL task + conversation from the CURRENT private
//   home (bearer) via `openTaskFromNotification`, then navigates the FIXED
//   existing Chat route (`/chat/[localId]`) — never an untrusted push URL.
// - Foreground delivery and tap use SEPARATE paths so a seen banner does NOT
//   swallow a later legitimate user open; duplicate tap callbacks for the
//   same event are ignored (no swarm).
// - Router-root-mounted + identity-resolved gates; logout pending callbacks
//   drop old-user data via scope-key fencing. Cold-start last response is
//   handled once per launch and marked so repeats are ignored.

import React, { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import { router } from 'expo-router';
import { useMe } from '@/context/MeContext';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySdk = any;

function scopeOf(enrollment: { homeId: string; deviceId: string } | null) {
  if (!enrollment) return null;
  return { installationId: enrollment.homeId, deviceId: enrollment.deviceId };
}

export function NotificationGate() {
  const { enrollment, identityResolved, homeScopeKey, enableNotifications, openTaskFromNotification } = useMe();
  const seenTapEvents = useRef(new Map<string, Set<string>>());
  const coldStartHandled = useRef(false);
  const pendingTap = useRef<string | null>(null);
  const stateRef = useRef({ enrollment, identityResolved, homeScopeKey, openTaskFromNotification });
  stateRef.current = { enrollment, identityResolved, homeScopeKey, openTaskFromNotification };

  // Cold-start + listener setup. Re-runs on scope change (logout/unpair/
  // revoke/account switch/mode/endpoint rotation cleans the old scope).
  useEffect(() => {
    if (Platform.OS === 'web') return;
    if (!identityResolved || !enrollment) {
      pendingTap.current = null;
      return;
    }
    let alive = true;
    const subs: Array<{ remove(): void }> = [];
    const scopeKeyAtSubscribe = homeScopeKey;
    const markTapSeen = (eventId: string): boolean => {
      let set = seenTapEvents.current.get(scopeKeyAtSubscribe);
      if (!set) {
        set = new Set();
        seenTapEvents.current.set(scopeKeyAtSubscribe, set);
      }
      if (set.has(eventId)) return false;
      set.add(eventId);
      if (set.size > 200) {
        const first = set.values().next();
        if (!first.done) set.delete(first.value);
      }
      return true;
    };

    const navigateToTask = async (taskId: string) => {
      const current = stateRef.current;
      if (!current.identityResolved || !current.enrollment) {
        // Cold-start race: hold until identity resolves, then re-check.
        pendingTap.current = taskId;
        return;
      }
      if (current.homeScopeKey !== scopeKeyAtSubscribe) return; // scope moved: drop
      const localId = await current.openTaskFromNotification(taskId);
      if (!alive) return;
      if (stateRef.current.homeScopeKey !== scopeKeyAtSubscribe) return;
      if (localId) {
        try {
          router.replace(`/chat/${localId}` as never);
        } catch {
          pendingTap.current = taskId;
        }
      }
    };

    (async () => {
      let sdk: AnySdk = null;
      let helpers: typeof import('@/lib/notifications') | null = null;
      try {
        helpers = await import('@/lib/notifications');
        const mod = (await import('expo-notifications').catch(() => null)) as AnySdk;
        sdk = mod?.default ?? mod;
      } catch {
        return;
      }
      if (!alive || !sdk || !helpers) return;
      // Foreground delivery: verify metadata only (no fetch, no navigation,
      // no tap-dedupe mark) so the banner never consumes the later tap.
      try {
        const fg = sdk.addNotificationReceivedListener?.((event: { request: { content: { data?: unknown } } }) => {
          const current = stateRef.current;
          if (!current.identityResolved || !current.enrollment) return;
          if (current.homeScopeKey !== scopeKeyAtSubscribe) return;
          const raw = helpers!.extractPushData(event?.request?.content as never);
          const verified = helpers!.verifyPushDataForScope(raw, scopeOf(current.enrollment));
          if (!verified) return;
          // No navigation, no fetch: the OS banner stands; the tap path
          // performs the verified fetch + fixed-route navigation.
        });
        if (fg) subs.push(fg);
      } catch { /* best effort */ }
      // Tap: verify scope + tap-dedupe, then fetch + fixed-route navigate.
      try {
        const tap = sdk.addNotificationResponseReceivedListener?.((response: { notification: { request: { content: { data?: unknown } } } }) => {
          const current = stateRef.current;
          if (!current.identityResolved || !current.enrollment) {
            // Hold malformed-unknown/cold-start taps until identity resolves.
            try {
              const raw = helpers!.extractPushData(response?.notification?.request?.content as never);
              const parsed = helpers!.parseNotificationData(raw);
              if (parsed) pendingTap.current = parsed.taskId;
            } catch { /* drop */ }
            return;
          }
          if (current.homeScopeKey !== scopeKeyAtSubscribe) return;
          let verified: { taskId: string; eventId: string } | null = null;
          try {
            const raw = helpers!.extractPushData(response?.notification?.request?.content as never);
            verified = helpers!.verifyPushDataForScope(raw, scopeOf(current.enrollment));
          } catch {
            return;
          }
          if (!verified) return;
          if (!markTapSeen(verified.eventId)) return; // duplicate callback: no swarm
          void navigateToTask(verified.taskId);
        });
        if (tap) subs.push(tap);
      } catch { /* best effort */ }
      // Rotation: re-get the EXPO token (never the raw APNs/FCM token) and
      // re-register on the current home via the fenced opt-in path.
      try {
        const rot = sdk.addPushTokenListener?.(() => {
          if (stateRef.current.homeScopeKey !== scopeKeyAtSubscribe) return;
          void enableNotifications().catch(() => {});
        });
        if (rot) subs.push(rot);
      } catch { /* best effort */ }
      // Cold start: handle the last response once per launch, then mark it
      // so repeats are ignored (cleared after verified handling).
      if (!coldStartHandled.current) {
        coldStartHandled.current = true;
        try {
          const last = await sdk.getLastNotificationResponseAsync?.();
          if (!alive) return;
          const raw = helpers.extractPushData(
            (last as { notification?: { request?: { content?: { data?: unknown } } } } | null)?.notification?.request?.content as never,
          );
          const current = stateRef.current;
          const verified = raw ? helpers.verifyPushDataForScope(raw, scopeOf(current.enrollment)) : null;
          if (verified && current.identityResolved && current.homeScopeKey === scopeKeyAtSubscribe) {
            if (markTapSeen(verified.eventId)) await navigateToTask(verified.taskId);
          } else if (verified) {
            pendingTap.current = verified.taskId;
          }
        } catch { /* drop cold-start failures */ }
      }
    })();
    return () => {
      alive = false;
      for (const sub of subs) {
        try {
          if (typeof sub.remove === 'function') sub.remove();
        } catch { /* best effort */ }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identityResolved, enrollment?.deviceId, enrollment?.homeId]);

  // Flush a held tap once identity resolves (drop when the scope moved on).
  useEffect(() => {
    if (!identityResolved || !enrollment || !pendingTap.current) return;
    const taskId = pendingTap.current;
    pendingTap.current = null;
    void (async () => {
      const localId = await openTaskFromNotification(taskId);
      if (localId) {
        try {
          router.replace(`/chat/${localId}` as never);
        } catch {
          // Router not mounted yet: re-hold for the next pass.
          pendingTap.current = taskId;
        }
      }
    })();
  }, [identityResolved, enrollment, openTaskFromNotification]);

  return null;
}
