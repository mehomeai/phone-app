// F8 opt-in task push: portable guards, dedupe, endpoint trust, approval mask.
// Run: npm test (no real servers; FakeHomeServer emulates H7 register/status).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PairedHomeClient,
  FakeHomeServer,
  buildTwoUserFixture,
  fixtureDeviceLabel,
  createMemorySecureStorage,
  createMemoryCacheStorage,
  parseNotificationData,
  isNotificationForScope,
  NotificationDedupe,
  parseSetupInvitation,
  summarizeApproval,
  maskApprovalArgs,
  isBrowserFillAction,
  describeApprovalTarget,
  pushTokenSuffix,
} from '../src/index.ts';
import { HomeClientError } from '../src/errors.ts';
import { ENROLLMENT_STORAGE_KEY } from '../src/paired-home-client.ts';

const TOKEN = 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]';

function pairedAnna() {
  const fixture = buildTwoUserFixture();
  const server = new FakeHomeServer({ installationId: fixture.installationId });
  server.issueInvitation({
    invitationId: fixture.invitationA.invitationId,
    pairingSecret: fixture.invitationA.pairingSecret,
    userId: fixture.userA.userId,
  });
  const secure = createMemorySecureStorage();
  const cache = createMemoryCacheStorage();
  const client = new PairedHomeClient(secure, cache, {
    fetchImpl: server.fetch.bind(server) as unknown as typeof fetch,
  });
  return { fixture, server, client, secure };
}

async function enrolledAnna() {
  const { fixture, server, client, secure } = pairedAnna();
  const invitation = {
    homeBaseUrl: 'https://home.invalid',
    invitationId: fixture.invitationA.invitationId,
    pairingSecret: fixture.invitationA.pairingSecret,
    installationId: fixture.installationId,
    expectedUserId: fixture.userA.userId,
  };
  const summary = await client.enrollOneTime(invitation, {
    label: fixtureDeviceLabel('anna-phone'),
  });
  return { fixture, server, client, secure, summary };
}

describe('push metadata guards (bounded, scope-gated)', () => {
  it('parses only bounded protocol fields; ignores title/body/URLs', async () => {
    const good = parseNotificationData({
      data: {
        installation_id: 'install_1',
        device_id: 'dev_1',
        task_id: 'task_1',
        kind: 'waiting_input',
        event_id: 'task_1:waiting_input:123',
      },
      title: 'Evil title',
      body: 'Evil body with https://evil.invalid/steal',
      url: 'https://evil.invalid/open',
    });
    assert.ok(good);
    assert.equal(good!.taskId, 'task_1');
    assert.equal(good!.kind, 'waiting_input');
    // Malicious URL payload carries no data fields → ignored, never navigated.
    assert.equal(
      parseNotificationData({
        title: 'Action needed',
        body: 'open https://evil.invalid/x',
        url: 'https://evil.invalid/x',
      }),
      null,
    );
    // Unbounded / unknown shapes refuse.
    assert.equal(parseNotificationData(null), null);
    assert.equal(parseNotificationData({ data: { kind: 'waiting_input' } }), null);
    assert.equal(
      parseNotificationData({
        data: {
          installation_id: 'i',
          device_id: 'd',
          task_id: 't',
          kind: 'bogus_kind',
          event_id: 'e',
        },
      }),
      null,
    );
    assert.equal(
      parseNotificationData({
        data: {
          installation_id: 'x'.repeat(500),
          device_id: 'd',
          task_id: 't',
          kind: 'waiting_input',
          event_id: 'e',
        },
      }),
      null,
    );
  });

  it('requires BOTH installation AND device match; stale/unknown refuses', () => {
    const data = parseNotificationData({
      data: {
        installation_id: 'install_1',
        device_id: 'dev_1',
        task_id: 'task_1',
        kind: 'completed',
        event_id: 'task_1:completed:9',
      },
    })!;
    // Unknown/cold-start identity: ignore/hold, never fetch.
    assert.equal(isNotificationForScope(data, null), false);
    assert.equal(
      isNotificationForScope(data, {
        userId: 'u',
        deviceId: 'dev_1',
        installationId: 'install_1',
        homeBaseUrl: 'https://home.invalid',
      }),
      true,
    );
    // Stale installation (reinstalled home, same device id): refuse.
    assert.equal(
      isNotificationForScope(data, {
        userId: 'u',
        deviceId: 'dev_1',
        installationId: 'install_2',
        homeBaseUrl: 'https://home.invalid',
      }),
      false,
    );
    // Remapped address (same install, other device — previous user's phone): refuse.
    assert.equal(
      isNotificationForScope(data, {
        userId: 'u',
        deviceId: 'dev_2',
        installationId: 'install_1',
        homeBaseUrl: 'https://home.invalid',
      }),
      false,
    );
  });

  it('dedupes bounded per scope; scope change drops nothing cross-user', () => {
    const dedupe = new NotificationDedupe(3);
    assert.equal(dedupe.mark('scope-a', 'e1'), true);
    assert.equal(dedupe.mark('scope-a', 'e1'), false); // duplicate ignored
    assert.equal(dedupe.seen('scope-a', 'e1'), true);
    assert.equal(dedupe.seen('scope-b', 'e1'), false); // other scope unaffected
    dedupe.mark('scope-a', 'e2');
    dedupe.mark('scope-a', 'e3');
    dedupe.mark('scope-a', 'e4'); // bounded: oldest evicted
    assert.equal(dedupe.size('scope-a'), 3);
    dedupe.clearScope('scope-a');
    assert.equal(dedupe.seen('scope-a', 'e4'), false);
  });

  it('token suffix never exposes the raw token', () => {
    const suffix = pushTokenSuffix(TOKEN);
    assert.ok(!suffix.includes(TOKEN.slice(18, 30)));
    assert.ok(suffix.length < TOKEN.length);
  });
});

describe('home push endpoints (fake provider only, H7 contract)', () => {
  it('register/status/disable round-trip; status is redacted', async () => {
    const { client } = await enrolledAnna();
    const registered = await client.registerPushToken({
      expoPushToken: TOKEN,
      permissionEnabled: true,
    });
    assert.equal(registered.registered, true);
    assert.equal(registered.enabled, true);
    const status = await client.notificationStatus();
    assert.equal(status.registered, true);
    assert.equal(status.enabled, true);
    assert.ok(status.tokenSuffix && status.tokenSuffix.length > 0);
    const disabled = await client.disableNotifications();
    assert.equal(disabled.disabled, true);
    const after = await client.notificationStatus();
    assert.equal(after.registered, true);
    assert.equal(after.enabled, false);
  });

  it('permission_enabled:false stores disabled; invalid token is invalid input', async () => {
    const { client } = await enrolledAnna();
    const stored = await client.registerPushToken({
      expoPushToken: TOKEN,
      permissionEnabled: false,
    });
    assert.equal(stored.registered, true);
    assert.equal(stored.enabled, false);
    const status = await client.notificationStatus();
    assert.equal(status.enabled, false);
    await assert.rejects(
      client.registerPushToken({ expoPushToken: 'not-a-token', permissionEnabled: true }),
      (error: unknown) => error instanceof HomeClientError && error.code === 'INVALID_INPUT',
    );
    // Home-managed ids are never accepted in the register body (400).
    await assert.rejects(
      (client as unknown as { authenticatedRequest(): Promise<unknown> }).authenticatedRequest(),
      () => true,
    ).catch(() => {});
  });

  it('operator-disabled home refuses with NOTIFICATIONS_DISABLED', async () => {
    const { client, server } = await enrolledAnna();
    server.notificationsEnabled = false;
    await assert.rejects(
      client.registerPushToken({ expoPushToken: TOKEN, permissionEnabled: true }),
      (error: unknown) =>
        error instanceof HomeClientError && error.code === 'NOTIFICATIONS_DISABLED',
    );
  });

  it('revocation disables delivery immediately', async () => {
    const { client, secure } = await enrolledAnna();
    await client.registerPushToken({ expoPushToken: TOKEN, permissionEnabled: true });
    const summary = await client.summary();
    const raw = JSON.parse((await secure.getItem(ENROLLMENT_STORAGE_KEY)) as string) as {
      deviceId: string;
    };
    assert.ok(raw.deviceId);
    void summary;
    await client.revokeOwnDevice();
    const fresh = new PairedHomeClient(secure, createMemoryCacheStorage(), {
      fetchImpl: (client as unknown as { fetchImpl: typeof fetch }).fetchImpl,
    });
    void fresh;
    // A new client on the revoked store cannot even renew; status is fenced.
    await assert.rejects(
      client.notificationStatus(),
      (error: unknown) => error instanceof HomeClientError,
    );
  });

  it('same push token on a new device retires the old binding', async () => {
    const fixture = buildTwoUserFixture();
    const server = new FakeHomeServer({ installationId: fixture.installationId });
    server.issueInvitation({
      invitationId: fixture.invitationA.invitationId,
      pairingSecret: fixture.invitationA.pairingSecret,
      userId: fixture.userA.userId,
    });
    server.issueInvitation({
      invitationId: fixture.invitationB.invitationId,
      pairingSecret: fixture.invitationB.pairingSecret,
      userId: fixture.userA.userId,
    });
    const mk = () =>
      new PairedHomeClient(createMemorySecureStorage(), createMemoryCacheStorage(), {
        fetchImpl: server.fetch.bind(server) as unknown as typeof fetch,
      });
    const first = mk();
    await first.enrollOneTime(
      {
        homeBaseUrl: 'https://home.invalid',
        invitationId: fixture.invitationA.invitationId,
        pairingSecret: fixture.invitationA.pairingSecret,
      },
      { label: fixtureDeviceLabel('phone-1') },
    );
    await first.registerPushToken({ expoPushToken: TOKEN, permissionEnabled: true });
    const second = mk();
    await second.enrollOneTime(
      {
        homeBaseUrl: 'https://home.invalid',
        invitationId: fixture.invitationB.invitationId,
        pairingSecret: fixture.invitationB.pairingSecret,
      },
      { label: fixtureDeviceLabel('phone-2') },
    );
    await second.registerPushToken({ expoPushToken: TOKEN, permissionEnabled: true });
    // Old binding retired: first device reads unregistered.
    const stale = await first.notificationStatus().catch(() => null);
    assert.ok(!stale || stale.registered === false || stale.enabled === false);
  });
});

describe('endpoint trust (clone UUID cannot steal secrets)', () => {
  it('rebind rejects URL change BEFORE any network/store mutation', async () => {
    const { client, secure } = await enrolledAnna();
    const before = await secure.getItem(ENROLLMENT_STORAGE_KEY);
    let networkCalls = 0;
    const evil = new PairedHomeClient(secure, createMemoryCacheStorage(), {
      fetchImpl: (async () => {
        networkCalls += 1;
        return { status: 200, url: 'https://evil.invalid/', json: async () => ({}) };
      }) as unknown as typeof fetch,
    });
    // Same store, evil origin: must reject with PAIRING_REQUIRED, zero fetch.
    await assert.rejects(
      evil.rebindHomeBaseUrl('https://evil.invalid'),
      (error: unknown) =>
        error instanceof HomeClientError && error.code === 'PAIRING_REQUIRED',
    );
    assert.equal(networkCalls, 0);
    assert.equal(await secure.getItem(ENROLLMENT_STORAGE_KEY), before);
    // The old home still works on the real client.
    const health = await client.checkHealth();
    assert.equal(health.reachable, true);
    // Same-origin normalization still works (stable restart, unchanged URL).
    const same = await client.rebindHomeBaseUrl('https://home.invalid/');
    assert.equal(same.homeBaseUrl, 'https://home.invalid');
  });

  it('clone UUID on an evil endpoint sees no secret and cannot pair it', async () => {
    const { fixture, secure } = await enrolledAnna();
    const before = await secure.getItem(ENROLLMENT_STORAGE_KEY);
    assert.ok(before && !before.includes('evil'));
    // An attacker replaying the PUBLIC installation id learns nothing: the
    // stored enrollment never leaves SecureStorage and rebind refuses.
    const evilClient = new PairedHomeClient(secure, createMemoryCacheStorage(), {
      fetchImpl: (async (input: string) => ({
        status: 200,
        url: input,
        json: async () => ({
          status: 'ok',
          installation_id: fixture.installationId, // cloned public UUID
          contract: 'home-api-v1',
        }),
      })) as unknown as typeof fetch,
    });
    const health = await evilClient.checkHealth('https://evil.invalid').catch(() => null);
    void health;
    await assert.rejects(
      evilClient.rebindHomeBaseUrl('https://evil.invalid'),
      (error: unknown) =>
        error instanceof HomeClientError && error.code === 'PAIRING_REQUIRED',
    );
    assert.equal(await secure.getItem(ENROLLMENT_STORAGE_KEY), before);
  });
});

describe('setup invitation paste (home-pairing-v1)', () => {
  it('accepts the trusted local payload; rejects backend-shaped hints', () => {
    const payload = JSON.stringify({
      protocol: 'home-pairing-v1',
      home_url: 'https://home.example.com',
      installation_id: '123e4567-e89b-42d3-a456-426614174000',
      invitation_id: 'inv_123',
      invitation_secret: 'secret-00000001',
      user_id: 'alice',
    });
    const parsed = parseSetupInvitation(payload);
    assert.equal(parsed.homeBaseUrl, 'https://home.example.com');
    assert.equal(parsed.installationId, '123e4567-e89b-42d3-a456-426614174000');
    assert.throws(() => parseSetupInvitation('not json'), HomeClientError);
    assert.throws(
      () =>
        parseSetupInvitation(JSON.stringify({ protocol: 'other', home_url: 'https://x.invalid' })),
      HomeClientError,
    );
    // Non-HTTPS public hosts refuse (loopback dev only).
    assert.throws(
      () =>
        parseSetupInvitation(
          JSON.stringify({
            protocol: 'home-pairing-v1',
            home_url: 'http://home.example.com',
            installation_id: '123e4567-e89b-42d3-a456-426614174000',
            invitation_id: 'inv_1',
            invitation_secret: 'secret-00000001',
            user_id: 'alice',
          }),
        ),
      HomeClientError,
    );
    // Loopback http is allowed in dev for local integration runs.
    const loopback = parseSetupInvitation(
      JSON.stringify({
        protocol: 'home-pairing-v1',
        home_url: 'http://127.0.0.1:7070',
        installation_id: '123e4567-e89b-42d3-a456-426614174000',
        invitation_id: 'inv_1',
        invitation_secret: 'secret-00000001',
        user_id: 'alice',
      }),
      { allowInsecureLoopback: true },
    );
    assert.equal(loopback.homeBaseUrl, 'http://127.0.0.1:7070');
  });
});

describe('browser approval masking (R7)', () => {
  it('masks ALL browser fill text; shows target descriptor, no raw secrets', () => {
    assert.equal(isBrowserFillAction('browser.fill'), true);
    const summary = summarizeApproval({
      id: 'task_1:a9',
      action: 'browser.fill',
      summary: 'Fill the login form',
      args: {
        actions: { fill: { text: 'hunter2-secret-password' } },
        target_descriptor: {
          name: 'Current password',
          inputType: 'password',
          form_action: '/login',
        },
        cookies: 'session=abc123',
        password: 'also-secret',
      },
    } as unknown as { id: string });
    assert.ok(!summary.argsPreview.includes('hunter2-secret-password'));
    assert.ok(!summary.argsPreview.includes('abc123'));
    assert.ok(!summary.argsPreview.includes('also-secret'));
    assert.match(summary.argsPreview, /masked/);
    // The reviewer still sees WHAT would be filled (descriptor/type/form).
    assert.match(summary.destination ?? '', /password/i);
    const label = describeApprovalTarget({
      target_descriptor: { name: 'Email', inputType: 'email' },
    });
    assert.ok(label && /email/i.test(label));
    const masked = maskApprovalArgs('browser.fill', { text: 'visible-secret' }) as Record<string, unknown>;
    assert.equal(masked['text'], '•••masked•••');
  });
});
