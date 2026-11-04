// Expo binding for the FULL native upstream REST transport.
//
// The REAL upstream surface is OpenBot's own native mobile REST (pin
// 6bfee780c8e8d05141375ea55ebde33eefb3dbc0, `mobile/src/api.ts`), NOT the
// headless SDK: the upstream's own phone delivers via
// `POST /api/delivery/conversations/:id/messages` and hydrates via
// `GET .../history?agentId=`, with the real router/worker turn behind it.
// This module binds that surface to the paired home: every call goes through
// `PairedHomeClient.proxyNativeApi` on the SAME paired authority with ONLY
// the home session bearer (`ht1_*`). No upstream Cookie is forged, no
// private Intelligence gateway URL/license/model key ever reaches the phone,
// and nothing falls back to managed cloud.
//
// Scope contract (mirrors `MeContext.dropHomeState` + full-scope handlers):
// `dropUpstreamNativeFor()` prunes cached channels for dropped/deleted
// conversations; every FULL scope reset (pair/enroll change, revoke,
// unpair/demo, account switch, sign-out) calls `resetUpstreamNativeScope()`
// which bumps the generation so late native callbacks after the reset never
// publish (callers fence with `shouldPublish`). The upstream stays source
// authority; the next sync re-resolves from it.

import {
  PairedHomeClient,
  UpstreamNativeClient,
  UpstreamNativeScope,
  UPSTREAM_NATIVE_PIN,
  NATIVE_ROUTES,
  parseNativeBotList,
} from '@/lib/home-client';
import type {
  NativeBot,
  NativeChannel,
  NativeTranscriptMessage,
} from '@/lib/home-client';

/** Re-exported for docs/tests; the pinned upstream source of truth. */
export { UPSTREAM_NATIVE_PIN, NATIVE_ROUTES, UpstreamNativeScope };
export type { NativeBot, NativeChannel, NativeTranscriptMessage };

/** Parse helper re-export for UI/tests (strict roster shapes). */
export { parseNativeBotList };

/**
 * Bind the native client to a paired home. The session token never leaves
 * `PairedHomeClient`; this only forwards absolute `/api/` paths through its
 * authenticated proxy.
 */
export function createUpstreamNative(
  paired: PairedHomeClient,
): UpstreamNativeClient {
  return new UpstreamNativeClient({
    request: (path, init) =>
      paired.proxyNativeApi(path, { method: init.method, body: init.body }),
  });
}

/** Singleton native scope for the current app scope. */
let singleton: UpstreamNativeScope | null = null;

export function upstreamNativeScope(): UpstreamNativeScope {
  if (!singleton) singleton = new UpstreamNativeScope();
  return singleton;
}

/** Prune cached upstream channels for dropped/deleted conversations. */
export function dropUpstreamNativeFor(homeConversationIds: string[]): void {
  upstreamNativeScope().dropConversations(homeConversationIds);
}

/** FULL scope reset: clear roster/channel caches, fence late callbacks. */
export function resetUpstreamNativeScope(reason: string): void {
  upstreamNativeScope().resetScope(reason);
}
