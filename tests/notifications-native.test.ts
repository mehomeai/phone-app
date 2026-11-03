// Native push adapter with an injected SDK surface (no native modules).
// Run: npm test. Covers permission denial, missing projectId/module/device,
// web-preview refusal, rotation re-getting the EXPO token (never the raw
// APNs token), malicious URL payloads ignored, and subscription cleanup.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveExpoProjectId,
  notificationAvailability,
  optInForPushToken,
  refreshExpoTokenForRotation,
  ensureAndroidChannel,
  extractPushData,
  verifyPushDataForScope,
  removeSdkSubscription,
} from '../apps/mobile/lib/notifications.ts';
import type { NotificationSdk } from '../apps/mobile/lib/notifications.ts';

const EXPO_TOKEN = 'ExponentPushToken[cccccccccccccccccccccc]';

function fakeSdk(overrides: Partial<{
  granted: boolean;
  token: string | null;
  rawPushToken: unknown;
}> = {}): NotificationSdk & { calls: string[]; removed: unknown[]; rotatedRaw: unknown[] } {
  const calls: string[] = [];
  const removed: unknown[] = [];
  const rotatedRaw: unknown[] = [];
  const granted = overrides.granted ?? true;
  const token = overrides.token ?? EXPO_TOKEN;
  const sdk: NotificationSdk & { calls: string[]; removed: unknown[]; rotatedRaw: unknown[] } = {
    calls,
    removed,
    rotatedRaw,
    async getPermissionsAsync() {
      calls.push('getPermissions');
      return granted ? { status: 'granted', granted: true } : { status: 'denied', granted: false };
    },
    async requestPermissionsAsync() {
      calls.push('requestPermissions');
      return granted ? { status: 'granted', granted: true } : { status: 'denied', granted: false };
    },
    async getExpoPushTokenAsync() {
      calls.push('getExpoPushToken');
      if (!token) throw new Error('no token');
      return { data: token, type: 'expo' };
    },
    addNotificationReceivedListener() {
      calls.push('fg');
      return { remove() { calls.push('fg-remove'); } };
    },
    addNotificationResponseReceivedListener() {
      calls.push('tap');
      return { remove() { calls.push('tap-remove'); } };
    },
    addPushTokenListener(cb) {
      calls.push('rotation');
      // Simulate the OS handing the RAW APNs/FCM token — the adapter must
      // ignore it and re-get the EXPO token instead.
      queueMicrotask(() => {
        rotatedRaw.push(overrides.rawPushToken ?? 'raw-apns-device-token');
        void cb(overrides.rawPushToken ?? 'raw-apns-device-token');
      });
      return { remove() { calls.push('rotation-remove'); } };
    },
    removeNotificationSubscription(sub) {
      removed.push(sub);
    },
    async setNotificationChannelAsync() {
      calls.push('channel');
    },
  };
  return sdk;
}

describe('native push adapter (injected SDK)', () => {
  it('resolves the public project id; never a credential', () => {
    assert.equal(
      resolveExpoProjectId({ easConfig: { projectId: 'proj-123' } }),
      'proj-123',
    );
    assert.equal(
      resolveExpoProjectId({ expoConfig: { extra: { eas: { projectId: 'proj-456' } } } }),
      'proj-456',
    );
    assert.equal(resolveExpoProjectId(null), null);
    assert.equal(resolveExpoProjectId({}), null);
  });

  it('refuses web preview, missing module/project, and non-device', () => {
    const sdk = fakeSdk();
    assert.equal(
      notificationAvailability({ platform: 'web', sdk, projectId: 'p', isDevice: true }).available,
      false,
    );
    assert.match(
      notificationAvailability({ platform: 'ios', sdk: null, projectId: 'p', isDevice: true }).reason ?? '',
      /module/i,
    );
    assert.match(
      notificationAvailability({ platform: 'android', sdk, projectId: null, isDevice: true }).reason ?? '',
      /project ID/i,
    );
    assert.match(
      notificationAvailability({ platform: 'ios', sdk, projectId: 'p', isDevice: false }).reason ?? '',
      /physical device/i,
    );
    assert.equal(
      notificationAvailability({ platform: 'ios', sdk, projectId: 'p', isDevice: true }).available,
      true,
    );
  });

  it('permission denied yields no token and no false enabled claim', async () => {
    const sdk = fakeSdk({ granted: false });
    const out = await optInForPushToken({ sdk, projectId: 'proj-1' });
    assert.equal(out.granted, false);
    assert.equal(out.expoPushToken, null);
    assert.ok(out.reason);
    // No token was minted after denial.
    assert.ok(!sdk.calls.includes('getExpoPushToken'));
  });

  it('granted permission mints the EXPO token with the project id', async () => {
    const sdk = fakeSdk({ granted: true });
    const seen: Array<unknown> = [];
    const recording: NotificationSdk = {
      ...sdk,
      async getExpoPushTokenAsync(options) {
        seen.push(options);
        return sdk.getExpoPushTokenAsync(options);
      },
    };
    const out = await optInForPushToken({ sdk: recording, projectId: 'proj-9' });
    assert.equal(out.granted, true);
    assert.equal(out.expoPushToken, EXPO_TOKEN);
    assert.ok(out.tokenSuffix && !out.tokenSuffix.includes(EXPO_TOKEN.slice(18, 30)));
    assert.deepEqual(seen, [{ projectId: 'proj-9' }]);
  });

  it('rotation re-gets the EXPO token, never forwarding the raw APNs token', async () => {
    const sdk = fakeSdk({ granted: true, rawPushToken: 'raw-apns-xyz' });
    const refreshed = await refreshExpoTokenForRotation({ sdk, projectId: 'proj-1' });
    assert.equal(refreshed, EXPO_TOKEN);
    assert.ok(sdk.calls.includes('getExpoPushToken'));
    assert.ok(!String(refreshed).includes('raw-apns'));
  });

  it('malicious URL payloads are ignored; only scoped metadata verifies', () => {
    const scope = { installationId: 'install_1', deviceId: 'dev_1' };
    const evil = extractPushData({ data: undefined } as never);
    void evil;
    assert.equal(
      verifyPushDataForScope(
        { title: 'Action needed', body: 'open https://evil.invalid/x', url: 'https://evil.invalid/x' },
        scope,
      ),
      null,
    );
    const good = verifyPushDataForScope(
      {
        data: {
          installation_id: 'install_1',
          device_id: 'dev_1',
          task_id: 'task_9',
          kind: 'waiting_approval',
          event_id: 'task_9:waiting_approval:7',
        },
      },
      scope,
    );
    assert.ok(good && good.taskId === 'task_9');
    // Logout (scope gone): pending callbacks drop, no fetch for old user.
    assert.equal(verifyPushDataForScope({ data: good }, null), null);
  });

  it('subscriptions clean up on logout/unpair/revoke', async () => {
    const sdk = fakeSdk();
    await ensureAndroidChannel(sdk, 'android');
    assert.ok(sdk.calls.includes('channel'));
    const sub = sdk.addNotificationResponseReceivedListener(() => {});
    removeSdkSubscription(sdk, sub);
    assert.ok(sdk.calls.includes('tap-remove'));
    // Legacy object without .remove falls back to the SDK remover.
    const legacy = { id: 1 };
    removeSdkSubscription(sdk, legacy);
    assert.ok(sdk.removed.includes(legacy));
  });
});
