// Unit/fixture tests for the paired-home client (no real servers).
// Run: npm test
// These use FakeHomeServer (an emulated `home-api-v1`) only.
// Live verification against the real H1 service is separate:
// npm run test:live (skips honestly when no home is configured).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PairedHomeClient,
  DemoHomeAdapter,
  FakeHomeServer,
  buildTwoUserFixture,
  fixtureDeviceLabel,
  createMemorySecureStorage,
  createMemoryCacheStorage,
  cacheLeaksSecrets,
  ENROLLMENT_STORAGE_KEY,
} from '../src/index.ts';
import { HomeClientError } from '../src/errors.ts';

function makeClient(server: FakeHomeServer) {
  const secure = createMemorySecureStorage();
  const cache = createMemoryCacheStorage();
  const client = new PairedHomeClient(secure, cache, {
    fetchImpl: server.fetch.bind(server) as unknown as typeof fetch,
  });
  return { client, secure, cache };
}

function inviteOf(
  fixture: ReturnType<typeof buildTwoUserFixture>,
  which: 'A' | 'B' | 'race',
) {
  const source =
    which === 'A'
      ? fixture.invitationA
      : which === 'B'
        ? fixture.invitationB
        : fixture.racedInvitation;
  return {
    homeBaseUrl: fixture.homeBaseUrl,
    invitationId: source.invitationId,
    pairingSecret: source.pairingSecret,
    installationId: fixture.installationId,
    expectedUserId: source.expectedUserId,
  };
}

describe('paired-home client (fixture, home-api-v1)', () => {
  it('enrolls with a one-time invitation and rejects reuse', async () => {
    const fixture = buildTwoUserFixture();
    const server = new FakeHomeServer({
      installationId: fixture.installationId,
    });
    server.issueInvitation({
      invitationId: fixture.invitationA.invitationId,
      pairingSecret: fixture.invitationA.pairingSecret,
      userId: fixture.userA.userId,
    });
    const { client } = makeClient(server);
    const summary = await client.enrollOneTime(
      inviteOf(fixture, 'A'),
      { label: fixtureDeviceLabel('anna-phone') },
    );
    assert.equal(summary.userId, fixture.userA.userId);
    assert.equal(summary.redacted, true);
    assert.ok(summary.deviceId.length > 0);

    // Reuse of the same invitation must fail, even from a second device.
    const second = makeClient(server);
    await assert.rejects(
      second.client.enrollOneTime(inviteOf(fixture, 'A'), {
        label: fixtureDeviceLabel('attacker-phone'),
      }),
      (error: unknown) =>
        error instanceof HomeClientError && error.code === 'INVITE_REUSED',
    );
    assert.equal(server.deviceCount(), 1);
  });

  it('at most one device wins a raced invitation', async () => {
    const fixture = buildTwoUserFixture();
    const server = new FakeHomeServer({
      installationId: fixture.installationId,
    });
    server.issueInvitation({
      invitationId: fixture.racedInvitation.invitationId,
      pairingSecret: fixture.racedInvitation.pairingSecret,
      userId: fixture.racedInvitation.expectedUserId,
    });
    const first = makeClient(server);
    const second = makeClient(server);
    const results = await Promise.allSettled([
      first.client.enrollOneTime(inviteOf(fixture, 'race'), {
        label: fixtureDeviceLabel('race-a'),
      }),
      second.client.enrollOneTime(inviteOf(fixture, 'race'), {
        label: fixtureDeviceLabel('race-b'),
      }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    assert.equal(fulfilled.length, 1);
    assert.equal(server.deviceCount(), 1);
  });

  it('two users hold private conversations; cross-access is forbidden', async () => {
    const fixture = buildTwoUserFixture();
    const server = new FakeHomeServer({
      installationId: fixture.installationId,
    });
    server.issueInvitation({
      invitationId: fixture.invitationA.invitationId,
      pairingSecret: fixture.invitationA.pairingSecret,
      userId: fixture.userA.userId,
    });
    server.issueInvitation({
      invitationId: fixture.invitationB.invitationId,
      pairingSecret: fixture.invitationB.pairingSecret,
      userId: fixture.userB.userId,
    });
    server.seedConversation({
      id: fixture.userA.conversationId,
      ownerUserId: fixture.userA.userId,
    });
    server.seedConversation({
      id: fixture.userB.conversationId,
      ownerUserId: fixture.userB.userId,
    });
    const anna = makeClient(server);
    const ben = makeClient(server);
    await anna.client.enrollOneTime(inviteOf(fixture, 'A'), {
      label: fixtureDeviceLabel('anna-phone'),
    });
    await ben.client.enrollOneTime(inviteOf(fixture, 'B'), {
      label: fixtureDeviceLabel('ben-phone'),
    });

    const annaList = await anna.client.listConversations();
    assert.deepEqual(
      annaList.map((c) => c.id),
      [fixture.userA.conversationId],
    );
    // Ben's conversation is invisible/forbidden to Anna (404, no leak).
    await assert.rejects(
      anna.client.syncConversation(fixture.userB.conversationId),
      (error: unknown) =>
        error instanceof HomeClientError && error.code === 'FORBIDDEN',
    );
    // Each user's send lands only in their own conversation.
    await anna.client.sendMessage(fixture.userA.conversationId, 'hello home');
    const snapshot = await anna.client.syncConversation(
      fixture.userA.conversationId,
    );
    assert.equal(snapshot.messages.length, 1);
    assert.equal(snapshot.messages[0]?.acceptedBy, 'home');
    const benSnapshot = await ben.client.syncConversation(
      fixture.userB.conversationId,
    );
    assert.equal(benSnapshot.messages.length, 0);
  });

  it('history is home-authoritative: sync replaces divergent local cache', async () => {
    const fixture = buildTwoUserFixture();
    const server = new FakeHomeServer({
      installationId: fixture.installationId,
    });
    server.issueInvitation({
      invitationId: fixture.invitationA.invitationId,
      pairingSecret: fixture.invitationA.pairingSecret,
      userId: fixture.userA.userId,
    });
    server.seedConversation({
      id: fixture.userA.conversationId,
      ownerUserId: fixture.userA.userId,
    });
    const { client, cache } = makeClient(server);
    await client.enrollOneTime(inviteOf(fixture, 'A'), {
      label: fixtureDeviceLabel('anna-phone'),
    });
    await client.sendMessage(fixture.userA.conversationId, 'real message');
    // Corrupt/diverge the local cache; sync must restore the home snapshot.
    await cache.setItem(
      `me.home.cache.v1.${fixture.userA.conversationId}`,
      JSON.stringify({ id: 'x', messages: [{ fake: true }] }),
    );
    const snapshot = await client.syncConversation(
      fixture.userA.conversationId,
    );
    assert.equal(snapshot.messages.length, 1);
    assert.equal(snapshot.messages[0]?.text, 'real message');
  });

  it('reconnect replays with the same request_key without duplicating', async () => {
    const fixture = buildTwoUserFixture();
    const server = new FakeHomeServer({
      installationId: fixture.installationId,
    });
    server.issueInvitation({
      invitationId: fixture.invitationA.invitationId,
      pairingSecret: fixture.invitationA.pairingSecret,
      userId: fixture.userA.userId,
    });
    server.seedConversation({
      id: fixture.userA.conversationId,
      ownerUserId: fixture.userA.userId,
    });
    const { client } = makeClient(server);
    await client.enrollOneTime(inviteOf(fixture, 'A'), {
      label: fixtureDeviceLabel('anna-phone'),
    });
    const key = '123e4567-e89b-42d3-a456-426614174000';
    const first = await client.sendMessage(
      fixture.userA.conversationId,
      'dedupe me',
      { requestKey: key },
    );
    assert.equal(first.duplicate, false);
    // Server-bound replay: same key + identical body returns the original.
    const replay = await client.sendMessage(
      fixture.userA.conversationId,
      'dedupe me',
      { requestKey: key },
    );
    assert.equal(first.message.id, replay.message.id);
    const snapshot = await client.syncConversation(
      fixture.userA.conversationId,
    );
    assert.equal(snapshot.messages.length, 1);
    // Same key with different content is a caller bug.
    await assert.rejects(
      client.sendMessage(fixture.userA.conversationId, 'different body', {
        requestKey: key,
      }),
      (error: unknown) =>
        error instanceof HomeClientError &&
        error.code === 'REQUEST_KEY_CONFLICT',
    );
    // Non-UUID keys are rejected by the home.
    await assert.rejects(
      client.sendMessage(fixture.userA.conversationId, 'bad key', {
        requestKey: 'not-a-uuid',
      }),
      (error: unknown) =>
        error instanceof HomeClientError && error.code === 'INVALID_INPUT',
    );
  });

  it('restart drops sessions but renewal restores access without a new invite', async () => {
    const fixture = buildTwoUserFixture();
    const server = new FakeHomeServer({
      installationId: fixture.installationId,
    });
    server.issueInvitation({
      invitationId: fixture.invitationA.invitationId,
      pairingSecret: fixture.invitationA.pairingSecret,
      userId: fixture.userA.userId,
    });
    server.seedConversation({
      id: fixture.userA.conversationId,
      ownerUserId: fixture.userA.userId,
    });
    // Share one SecureStorage across "restarts" (same phone storage).
    const secure = createMemorySecureStorage();
    const makeWithSharedSecure = () =>
      new PairedHomeClient(secure, createMemoryCacheStorage(), {
        fetchImpl: server.fetch.bind(server) as unknown as typeof fetch,
      });
    await makeWithSharedSecure().enrollOneTime(inviteOf(fixture, 'A'), {
      label: fixtureDeviceLabel('anna-phone'),
    });
    server.restart();
    const afterRestart = makeWithSharedSecure();
    // Old session is dead...
    await assert.rejects(
      afterRestart.listConversations(),
      (error: unknown) => error instanceof HomeClientError,
    );
    // ...but renewal via the stored device credential restores access.
    await afterRestart.renewSession();
    const list = await afterRestart.listConversations();
    assert.deepEqual(
      list.map((c) => c.id),
      [fixture.userA.conversationId],
    );
  });

  it('revoked devices lose access and unpaired phones get nothing', async () => {
    const fixture = buildTwoUserFixture();
    const server = new FakeHomeServer({
      installationId: fixture.installationId,
    });
    server.issueInvitation({
      invitationId: fixture.invitationA.invitationId,
      pairingSecret: fixture.invitationA.pairingSecret,
      userId: fixture.userA.userId,
    });
    const { client } = makeClient(server);
    const summary = await client.enrollOneTime(inviteOf(fixture, 'A'), {
      label: fixtureDeviceLabel('anna-phone'),
    });
    server.revokeDevice(summary.deviceId);
    await assert.rejects(
      client.listConversations(),
      (error: unknown) => error instanceof HomeClientError,
    );

    const stranger = makeClient(server);
    await assert.rejects(
      stranger.client.listConversations(),
      (error: unknown) =>
        error instanceof HomeClientError && error.code === 'UNPAIRED',
    );
  });

  it('secrets stay in secure storage, never in the cache or logs', async () => {
    const fixture = buildTwoUserFixture();
    const server = new FakeHomeServer({
      installationId: fixture.installationId,
    });
    server.issueInvitation({
      invitationId: fixture.invitationA.invitationId,
      pairingSecret: fixture.invitationA.pairingSecret,
      userId: fixture.userA.userId,
    });
    server.seedConversation({
      id: fixture.userA.conversationId,
      ownerUserId: fixture.userA.userId,
    });
    const { client, secure, cache } = makeClient(server);
    await client.enrollOneTime(inviteOf(fixture, 'A'), {
      label: fixtureDeviceLabel('anna-phone'),
    });
    await client.sendMessage(fixture.userA.conversationId, 'secret check');
    const summary = await client.summary();
    const summaryText = JSON.stringify(summary);
    assert.equal(summary?.redacted, true);
    const enrollmentRaw =
      (await secure.getItem(ENROLLMENT_STORAGE_KEY)) ?? '';
    const stored = JSON.parse(enrollmentRaw) as {
      deviceSecret?: unknown;
      sessionToken?: unknown;
    };
    assert.equal(typeof stored.deviceSecret, 'string');
    assert.equal(typeof stored.sessionToken, 'string');
    assert.ok(!summaryText.includes(String(stored.deviceSecret)));
    assert.ok(!summaryText.includes(String(stored.sessionToken)));
    // The single-use pairing secret is never persisted.
    assert.ok(!enrollmentRaw.includes(fixture.invitationA.pairingSecret));
    const cachedRaw =
      (await cache.getItem(
        `me.home.cache.v1.${fixture.userA.conversationId}`,
      )) ?? '';
    assert.ok(
      !cacheLeaksSecrets(cachedRaw, [
        typeof stored.deviceSecret === 'string'
          ? stored.deviceSecret
          : undefined,
        typeof stored.sessionToken === 'string'
          ? stored.sessionToken
          : undefined,
        fixture.invitationA.pairingSecret,
      ]),
    );
  });

  it('demo mode is explicit and never claims home acceptance', async () => {
    const demo = new DemoHomeAdapter();
    assert.equal(demo.mode, 'demo');
    const { assistant } = await demo.sendLocal(
      'conv_demo_1',
      'user_demo',
      'hello demo',
    );
    assert.equal(assistant.acceptedBy, 'demo');
  });
});

describe('credential transport protection', () => {
  it('sends redirect:error on every credential-bearing request', async () => {
    const seen: Array<{ url: string; redirect: unknown; auth: string | null }> = [];
    const stubFetch = (async (input: string, init?: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
      redirect?: 'error' | 'follow' | 'manual';
    }) => {
      seen.push({
        url: input,
        redirect: init?.redirect,
        auth: init?.headers?.['Authorization'] ?? null,
      });
      const path = new URL(input).pathname;
      if (path === '/v1/pair') {
        return {
          status: 201,
          url: input,
          json: async () => ({
            device_id: 'dev_1',
            device_secret: 'devsec_1',
            user_id: 'user_fixture_anna',
            installation_id: 'install_fixture_1',
            contractVersion: 'home-api-v1',
          }),
        };
      }
      if (path === '/v1/sessions') {
        return {
          status: 201,
          url: input,
          json: async () => ({ token: 'ht1_x', expires_at: Date.now() + 1000 }),
        };
      }
      if (path === '/v1/conversations') {
        return {
          status: 200,
          url: input,
          json: async () => ({ conversations: [] }),
        };
      }
      return {
        status: 200,
        url: input,
        json: async () => ({ status: 'ok', installation_id: 'install_fixture_1', contract: 'home-api-v1' }),
      };
    }) as unknown as typeof fetch;
    const client = new PairedHomeClient(
      createMemorySecureStorage(),
      createMemoryCacheStorage(),
      { fetchImpl: stubFetch },
    );
    await client.enrollOneTime(
      {
        homeBaseUrl: 'https://home.invalid',
        invitationId: 'inv_1',
        pairingSecret: 'secret-00000001',
      },
      { label: 'phone' },
    );
    await client.checkHealth();
    await client.listConversations();
    assert.ok(seen.length >= 4);
    for (const call of seen) {
      assert.equal(call.redirect, 'error');
    }
    assert.ok(seen.some((call) => call.auth?.startsWith('Bearer ht1_')));
  });

  it('refuses cross-origin final URLs without re-issuing credentials', async () => {
    const requested: string[] = [];
    const evilFetch = (async (input: string, init?: {
      headers?: Record<string, string>;
      redirect?: 'error' | 'follow' | 'manual';
    }) => {
      requested.push(input);
      // Simulates a native stack that followed a redirect to an
      // attacker origin despite redirect:'error', forwarding headers.
      assert.equal(init?.redirect, 'error');
      return {
        status: 200,
        url: 'https://evil.invalid/v1/me',
        json: async () => ({ user_id: 'attacker' }),
      };
    }) as unknown as typeof fetch;
    // Seed an enrollment directly so the guarded path is exercised.
    const secure = createMemorySecureStorage();
    await secure.setItem(
      ENROLLMENT_STORAGE_KEY,
      JSON.stringify({
        installationId: 'install_fixture_1',
        homeBaseUrl: 'https://home.invalid',
        deviceId: 'dev_1',
        deviceSecret: 'devsec_1',
        deviceLabel: 'phone',
        userId: 'user_fixture_anna',
        sessionToken: 'ht1_x',
        sessionExpiresAt: Date.now() + 1000,
        enrolledAt: Date.now(),
      }),
    );
    const guarded = new PairedHomeClient(secure, createMemoryCacheStorage(), {
      fetchImpl: evilFetch,
    });
    await assert.rejects(
      guarded.listConversations(),
      (error: unknown) =>
        error instanceof HomeClientError && error.code === 'CONTRACT_MISMATCH',
    );
    // Exactly one request was issued; the client never retried or followed
    // up against the evil origin with credentials.
    assert.deepEqual(requested, ['https://home.invalid/v1/conversations']);
  });
});

describe('paired-home tasks (fixture, H2)', () => {
  async function pairedAnna() {
    const fixture = buildTwoUserFixture();
    const server = new FakeHomeServer({
      installationId: fixture.installationId,
    });
    server.issueInvitation({
      invitationId: fixture.invitationA.invitationId,
      pairingSecret: fixture.invitationA.pairingSecret,
      userId: fixture.userA.userId,
    });
    server.issueInvitation({
      invitationId: fixture.invitationB.invitationId,
      pairingSecret: fixture.invitationB.pairingSecret,
      userId: fixture.userB.userId,
    });
    server.seedConversation({
      id: fixture.userA.conversationId,
      ownerUserId: fixture.userA.userId,
    });
    const anna = makeClient(server);
    const ben = makeClient(server);
    await anna.client.enrollOneTime(inviteOf(fixture, 'A'), {
      label: fixtureDeviceLabel('anna-phone'),
    });
    await ben.client.enrollOneTime(inviteOf(fixture, 'B'), {
      label: fixtureDeviceLabel('ben-phone'),
    });
    return { fixture, server, anna: anna.client, ben: ben.client };
  }

  it('submits, lists, polls, and cancels tasks; cross-user reads denied', async () => {
    const { fixture, anna, ben } = await pairedAnna();
    const submitted = await anna.submitTask(fixture.userA.conversationId, {
      request: 'summarise this thread',
      title: 'Notes',
    });
    assert.equal(submitted.status, 'queued');
    assert.equal(submitted.conversationId, fixture.userA.conversationId);
    const listed = await anna.listTasks(fixture.userA.conversationId);
    assert.ok(listed.some((t) => t.id === submitted.id));
    const polled = await anna.getTask(submitted.id);
    assert.equal(polled.id, submitted.id);
    // Ben cannot see Anna's task (owner-scoped, no existence leak).
    await assert.rejects(
      ben.getTask(submitted.id),
      (error: unknown) =>
        error instanceof HomeClientError && error.code === 'FORBIDDEN',
    );
    const cancelled = await anna.cancelTask(submitted.id);
    assert.equal(cancelled.status, 'cancelled');
    // Cancelling a terminal task is a stale transition.
    await assert.rejects(
      anna.cancelTask(submitted.id),
      (error: unknown) =>
        error instanceof HomeClientError && error.code === 'WRONG_STATE',
    );
  });

  it('answers waiting questions and refuses wrong-state transitions', async () => {
    const { fixture, server, anna } = await pairedAnna();
    server.seedWaitingTask({
      id: 'task_wait_1',
      conversationId: fixture.userA.conversationId,
      ownerUserId: fixture.userA.userId,
      questionId: 'q1',
    });
    const answered = await anna.answerTaskQuestions('task_wait_1', [
      { id: 'q1', answer: 'MP4' },
    ]);
    assert.equal(answered.status, 'succeeded');
    assert.match(answered.output ?? '', /MP4/);
    // Answering again is a stale transition.
    await assert.rejects(
      anna.answerTaskQuestions('task_wait_1', [{ id: 'q1', answer: 'x' }]),
      (error: unknown) =>
        error instanceof HomeClientError && error.code === 'WRONG_STATE',
    );
    // Approving a non-waiting task is refused.
    await assert.rejects(
      anna.decideTaskApprovals('task_wait_1', [{ id: 'task_wait_1:a1', decision: 'approve' }]),
      (error: unknown) =>
        error instanceof HomeClientError && error.code === 'WRONG_STATE',
    );
    // Unknown question ids are caller bugs.
    server.seedWaitingTask({
      id: 'task_wait_2',
      conversationId: fixture.userA.conversationId,
      ownerUserId: fixture.userA.userId,
    });
    await assert.rejects(
      anna.answerTaskQuestions('task_wait_2', [{ id: 'nope', answer: 'x' }]),
      (error: unknown) =>
        error instanceof HomeClientError && error.code === 'INVALID_INPUT',
    );
    // Model selection is home-managed: the client surface has no model
    // field to send (SubmitTaskInput omits it by design).
    const artifacts = await anna.listTaskArtifacts('task_wait_1');
    assert.deepEqual(artifacts, []);
  });

  it('uses opaque namespaced approval IDs; reject fails honestly', async () => {
    const { fixture, server, anna, ben } = await pairedAnna();
    server.seedWaitingTask({
      id: 'task_wait_appr',
      conversationId: fixture.userA.conversationId,
      ownerUserId: fixture.userA.userId,
      approvalRuntimeId: 'a1',
    });
    // The client must use the server-issued ID opaquely — a bare runtime id
    // is unknown to the home.
    const view = await anna.getTask('task_wait_appr');
    assert.equal(view.status, 'waiting_approval');
    const serverId = view.pendingApprovals?.[0]?.id;
    assert.ok(serverId?.startsWith('task_wait_appr:'));
    await assert.rejects(
      anna.decideTaskApprovals('task_wait_appr', [{ id: 'a1', decision: 'reject' }]),
      (error: unknown) =>
        error instanceof HomeClientError && error.code === 'INVALID_INPUT',
    );
    const declined = await anna.decideTaskApprovals('task_wait_appr', [
      { id: serverId!, decision: 'reject' },
    ]);
    assert.equal(declined.status, 'failed');
    assert.match(declined.error ?? '', /approval_rejected/);
    // Client-side validation rejects the old 'deny' value before any fetch.
    await assert.rejects(
      anna.decideTaskApprovals('task_wait_appr', [
        // @ts-expect-error the canonical decision is 'reject', not 'deny'
        { id: serverId!, decision: 'deny' },
      ]),
      (error: unknown) =>
        error instanceof HomeClientError && error.code === 'INVALID_INPUT',
    );
    // Another household member cannot decide Anna's approvals.
    server.seedWaitingTask({
      id: 'task_wait_ben',
      conversationId: fixture.userA.conversationId,
      ownerUserId: fixture.userA.userId,
      approvalRuntimeId: 'a1',
    });
    await assert.rejects(
      ben.decideTaskApprovals('task_wait_ben', [{ id: 'x', decision: 'reject' }]),
      (error: unknown) =>
        error instanceof HomeClientError && error.code === 'FORBIDDEN',
    );
  });
});
