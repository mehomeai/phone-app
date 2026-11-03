// One-time home-activation tickets (home-activation-v1, F9/B7) portable contract.
// Run: npm test
// No real servers: the B7 backend is a stub fetch shaped exactly like
// backend-server/docs/home-activation-v1.md §1 (mint) — success shape,
// recovery rules, and §6 error codes. The real-backend B7 lifecycle
// (mint → home-operator activate → discovery → paired home unaffected) runs
// in test/real-services.test.mjs. The phone NEVER calls POST /v1/homes/activate
// (home operator redeems via stdin); this suite asserts no such method or
// request exists on the phone path.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BackendCoordinator,
  BACKEND_ACCOUNT_TOKEN_KEY,
  BACKEND_URL_KEY,
  createMemoryCacheStorage,
  createMemorySecureStorage,
  errorForActivationStatus,
  isActivationTicketExpired,
  parseActivationTicket,
} from '../src/index.ts';
import type { SecureStorage } from '../src/index.ts';
import { HomeClientError } from '../src/errors.ts';

const BACKEND = 'http://127.0.0.1:8787';
const INSTALLATION = '123e4567-e89b-42d3-a456-426614174000';
const OWNER_HOME = 'home_abc123def456';
const MEMBER_HOME = 'home_xyz789ghi012';

function recordingSecure(inner: SecureStorage) {
  const writes: Array<{ key: string; value: string }> = [];
  return {
    inner,
    writes,
    storage: {
      getItem: (k: string) => inner.getItem(k),
      setItem: async (k: string, v: string) => {
        writes.push({ key: k, value: v });
        await inner.setItem(k, v);
      },
      deleteItem: (k: string) => inner.deleteItem(k),
    } as SecureStorage,
  };
}

interface SeenCall {
  url: string;
  method?: string;
  auth: string | null;
  redirect: unknown;
  body: unknown;
}

function stubBackend(routes: {
  homes: Array<{ homeId: string; installationId?: string; membershipRole?: string }>;
  mint?: { status: number; body: unknown };
}) {
  const seen: SeenCall[] = [];
  const impl = (async (input: string, init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    redirect?: 'error' | 'follow' | 'manual';
  }) => {
    const url = new URL(input);
    let parsedBody: unknown;
    try {
      parsedBody = init?.body === undefined ? undefined : JSON.parse(init.body);
    } catch {
      parsedBody = undefined;
    }
    seen.push({
      url: input,
      method: init?.method,
      auth: init?.headers?.['Authorization'] ?? null,
      redirect: init?.redirect,
      body: parsedBody,
    });
    if (url.pathname === '/v1/homes' && (init?.method ?? 'GET') === 'GET') {
      return { status: 200, url: input, json: async () => ({ homes: routes.homes }) };
    }
    if (url.pathname === '/v1/homes/activation-tickets' && init?.method === 'POST') {
      const route = routes.mint ?? { status: 500, body: {} };
      return { status: route.status, url: input, json: async () => route.body };
    }
    return { status: 404, url: input, json: async () => ({}) };
  }) as unknown as typeof fetch;
  return { impl, seen };
}

function mintSuccessBody(overrides: Record<string, unknown> = {}) {
  return {
    ticketId: 'act_0123456789abcdef',
    activationSecret: 's3cr3t-base64url-0123456789abcdef01234567',
    installationId: INSTALLATION,
    mode: 'new',
    homeId: null,
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    ...overrides,
  };
}

async function configuredCoordinator(
  backend: ReturnType<typeof stubBackend>,
  rec: ReturnType<typeof recordingSecure>,
) {
  const coordinator = new BackendCoordinator(rec.storage, {
    fetchImpl: backend.impl as unknown as typeof fetch,
    allowInsecureLoopback: true,
  });
  await coordinator.configureBackend(BACKEND, 'test-account-token');
  return coordinator;
}

function mintPosts(seen: SeenCall[]) {
  return seen.filter((c) => c.url.endsWith('/v1/homes/activation-tickets'));
}

describe('activation tickets (portable, phone mints / home redeems)', () => {
  it('phone has no activate path: no method, no request', async () => {
    const rec = recordingSecure(createMemorySecureStorage());
    const backend = stubBackend({ homes: [], mint: { status: 201, body: mintSuccessBody() } });
    const coordinator = await configuredCoordinator(backend, rec);
    assert.equal(
      (coordinator as unknown as Record<string, unknown>)['activate'],
      undefined,
    );
    // A full mint still never touches the home-operator redeem route.
    await coordinator.mintActivationTicket({ installationId: INSTALLATION });
    for (const call of backend.seen) {
      assert.ok(!call.url.endsWith('/v1/homes/activate'), 'phone must never call activate');
    }
  });

  it('mints new-mode ticket and builds the exact one-time handoff JSON', async () => {
    const rec = recordingSecure(createMemorySecureStorage());
    const backend = stubBackend({ homes: [], mint: { status: 201, body: mintSuccessBody() } });
    const coordinator = await configuredCoordinator(backend, rec);
    const ticket = await coordinator.mintActivationTicket({ installationId: INSTALLATION });
    assert.equal(ticket.ticketId, 'act_0123456789abcdef');
    assert.equal(ticket.mode, 'new');
    assert.equal(ticket.homeId, null);
    assert.equal(ticket.installationId, INSTALLATION);
    // Request shape: account bearer, redirect error, no identity/token smuggling.
    const posts = mintPosts(backend.seen);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].auth, 'Bearer test-account-token');
    assert.equal(posts[0].redirect, 'error');
    const sentBody = posts[0].body as Record<string, unknown>;
    assert.deepEqual(Object.keys(sentBody).sort(), ['installationId']);
    assert.ok(!('homeId' in sentBody || 'accountId' in sentBody || 'ownerId' in sentBody));
    assert.ok(!JSON.stringify(sentBody).includes('me_home_'));
    // Handoff JSON: exact keys, no homeToken, no account/provider material.
    const handoff = coordinator.buildActivationHandoff(BACKEND, ticket);
    assert.deepEqual(Object.keys(handoff).sort(), [
      'activationSecret',
      'backend_url',
      'expiresAt',
      'installationId',
      'mode',
      'ticketId',
    ]);
    assert.equal(handoff.backend_url, BACKEND);
    assert.ok(!JSON.stringify(handoff).includes('me_home_'));
    assert.ok(!JSON.stringify(handoff).includes('test-account-token'));
    // Ephemeral: mint persists nothing (config keys only) and caches nothing.
    const ticketWrites = rec.writes.filter(
      (w) => w.key !== BACKEND_URL_KEY && w.key !== BACKEND_ACCOUNT_TOKEN_KEY,
    );
    assert.deepEqual(ticketWrites, []);
  });

  it('mints recovery only for owned, installation-matching homes', async () => {
    // B7-faithful: discovery carries `membershipRole`, normalized to `role`.
    const homes = [
      { homeId: OWNER_HOME, installationId: INSTALLATION, membershipRole: 'owner' },
      { homeId: MEMBER_HOME, installationId: INSTALLATION, membershipRole: 'member' },
    ];
    const recoveryBody = mintSuccessBody({ mode: 'recovery', homeId: OWNER_HOME });
    // Unknown home: refused locally, no mint POST.
    {
      const rec = recordingSecure(createMemorySecureStorage());
      const backend = stubBackend({ homes, mint: { status: 201, body: recoveryBody } });
      const coordinator = await configuredCoordinator(backend, rec);
      await assert.rejects(
        coordinator.mintActivationTicket({ installationId: INSTALLATION, existingHomeId: 'home_notseen000001' }),
        (e: unknown) => e instanceof HomeClientError && e.code === 'NOT_FOUND',
      );
      assert.deepEqual(mintPosts(backend.seen), []);
    }
    // Non-owner: refused locally, no mint POST.
    {
      const rec = recordingSecure(createMemorySecureStorage());
      const backend = stubBackend({ homes, mint: { status: 201, body: recoveryBody } });
      const coordinator = await configuredCoordinator(backend, rec);
      await assert.rejects(
        coordinator.mintActivationTicket({ installationId: INSTALLATION, existingHomeId: MEMBER_HOME }),
        (e: unknown) => e instanceof HomeClientError && e.code === 'FORBIDDEN',
      );
      assert.deepEqual(mintPosts(backend.seen), []);
    }
    // Installation mismatch: refused locally, no mint POST.
    {
      const rec = recordingSecure(createMemorySecureStorage());
      const backend = stubBackend({ homes, mint: { status: 201, body: recoveryBody } });
      const coordinator = await configuredCoordinator(backend, rec);
      await assert.rejects(
        coordinator.mintActivationTicket({
          installationId: '999e4567-e89b-42d3-a456-426614174999',
          existingHomeId: OWNER_HOME,
        }),
        (e: unknown) => e instanceof HomeClientError && e.code === 'FORBIDDEN',
      );
      assert.deepEqual(mintPosts(backend.seen), []);
    }
    // Owner + exact installation: single mint POST with existingHomeId only.
    {
      const rec = recordingSecure(createMemorySecureStorage());
      const backend = stubBackend({ homes, mint: { status: 201, body: recoveryBody } });
      const coordinator = await configuredCoordinator(backend, rec);
      const ticket = await coordinator.mintActivationTicket({
        installationId: INSTALLATION,
        displayName: 'Cabin Home',
        existingHomeId: OWNER_HOME,
      });
      assert.equal(ticket.mode, 'recovery');
      assert.equal(ticket.homeId, OWNER_HOME);
      const posts = mintPosts(backend.seen);
      assert.equal(posts.length, 1);
      const sentBody = posts[0].body as Record<string, unknown>;
      assert.deepEqual(Object.keys(sentBody).sort(), ['displayName', 'existingHomeId', 'installationId']);
      assert.equal(sentBody['existingHomeId'], OWNER_HOME);
      const handoff = coordinator.buildActivationHandoff(BACKEND, ticket);
      assert.equal(handoff.homeId, OWNER_HOME);
    }
  });

  it('rejects invalid mint input without sending', async () => {
    const rec = recordingSecure(createMemorySecureStorage());
    const backend = stubBackend({ homes: [] });
    const coordinator = await configuredCoordinator(backend, rec);
    await assert.rejects(
      coordinator.mintActivationTicket({ installationId: '' }),
      (e: unknown) => e instanceof HomeClientError && e.code === 'INVALID_INPUT',
    );
    await assert.rejects(
      coordinator.mintActivationTicket({ installationId: 'has\nnewline' }),
      (e: unknown) => e instanceof HomeClientError && e.code === 'INVALID_INPUT',
    );
    await assert.rejects(
      coordinator.mintActivationTicket({ installationId: INSTALLATION, displayName: '' }),
      (e: unknown) => e instanceof HomeClientError && e.code === 'INVALID_INPUT',
    );
    await assert.rejects(
      coordinator.mintActivationTicket({ installationId: INSTALLATION, existingHomeId: 'BAD ID!!' }),
      (e: unknown) => e instanceof HomeClientError && e.code === 'INVALID_INPUT',
    );
    assert.deepEqual(backend.seen, []);
  });

  it('rejects malformed capability shapes and leaked credential material', () => {
    const req = { installationId: INSTALLATION, expectedMode: 'new' as const };
    assert.throws(
      () => parseActivationTicket(mintSuccessBody({ activationSecret: undefined }), req),
      (e: unknown) => e instanceof HomeClientError && e.code === 'CONTRACT_MISMATCH',
    );
    assert.throws(
      () => parseActivationTicket(mintSuccessBody({ mode: 'recovery', homeId: OWNER_HOME }), req),
      (e: unknown) => e instanceof HomeClientError && e.code === 'CONTRACT_MISMATCH',
    );
    assert.throws(
      () => parseActivationTicket(mintSuccessBody({ installationId: 'other' }), req),
      (e: unknown) => e instanceof HomeClientError && e.code === 'CONTRACT_MISMATCH',
    );
    assert.throws(
      () => parseActivationTicket(mintSuccessBody({ homeId: OWNER_HOME }), req),
      (e: unknown) => e instanceof HomeClientError && e.code === 'CONTRACT_MISMATCH',
    );
    assert.throws(
      () => parseActivationTicket(mintSuccessBody({ expiresAt: 'not-a-date' }), req),
      (e: unknown) => e instanceof HomeClientError && e.code === 'CONTRACT_MISMATCH',
    );
    // Leaked homeToken field or me_home_ material is never accepted.
    assert.throws(
      () => parseActivationTicket(mintSuccessBody({ homeToken: 'me_home_leaked' }), req),
      (e: unknown) => e instanceof HomeClientError && e.code === 'CONTRACT_MISMATCH',
    );
    assert.throws(
      () => parseActivationTicket(mintSuccessBody({ activationSecret: 'me_home_conflated' }), req),
      (e: unknown) => e instanceof HomeClientError && e.code === 'CONTRACT_MISMATCH',
    );
    // Recovery requires the exact requested home back.
    const recoveryReq = {
      installationId: INSTALLATION,
      expectedMode: 'recovery' as const,
      existingHomeId: OWNER_HOME,
    };
    assert.throws(
      () => parseActivationTicket(mintSuccessBody({ mode: 'recovery', homeId: null }), recoveryReq),
      (e: unknown) => e instanceof HomeClientError && e.code === 'CONTRACT_MISMATCH',
    );
    assert.throws(
      () => parseActivationTicket(mintSuccessBody({ mode: 'recovery', homeId: MEMBER_HOME }), recoveryReq),
      (e: unknown) => e instanceof HomeClientError && e.code === 'CONTRACT_MISMATCH',
    );
  });

  it('maps activation error statuses without retries', async () => {
    assert.equal(errorForActivationStatus(401).code, 'UNPAIRED');
    assert.equal(errorForActivationStatus(403).code, 'FORBIDDEN');
    assert.equal(errorForActivationStatus(404).code, 'NOT_FOUND');
    assert.equal(errorForActivationStatus(410).code, 'INVITE_EXPIRED');
    assert.equal(errorForActivationStatus(429).code, 'REGISTRATION_LIMIT');
    assert.equal(errorForActivationStatus(400).code, 'INVALID_INPUT');
    const offline = errorForActivationStatus(500);
    assert.equal(offline.code, 'HOME_OFFLINE');
    assert.equal(offline.retryable, true);
    // End-to-end through mint: single attempt only (one POST, then throw).
    for (const [status, code] of [
      [401, 'UNPAIRED'],
      [403, 'FORBIDDEN'],
      [404, 'NOT_FOUND'],
      [410, 'INVITE_EXPIRED'],
      [429, 'REGISTRATION_LIMIT'],
      [400, 'INVALID_INPUT'],
    ] as Array<[number, string]>) {
      const rec = recordingSecure(createMemorySecureStorage());
      const backend = stubBackend({ homes: [], mint: { status, body: { error: 'x' } } });
      const coordinator = await configuredCoordinator(backend, rec);
      await assert.rejects(
        coordinator.mintActivationTicket({ installationId: INSTALLATION }),
        (e: unknown) => e instanceof HomeClientError && e.code === code,
      );
      assert.equal(mintPosts(backend.seen).length, 1, `status ${status} must be a single attempt`);
    }
  });

  it('expiry helper fails closed for the ephemeral UI', () => {
    const fresh = {
      ticketId: 'act_x',
      activationSecret: 's',
      installationId: INSTALLATION,
      mode: 'new' as const,
      homeId: null,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const stale = { ...fresh, expiresAt: new Date(Date.now() - 1000).toISOString() };
    const garbage = { ...fresh, expiresAt: 'not-a-date' };
    assert.equal(isActivationTicketExpired(fresh), false);
    assert.equal(isActivationTicketExpired(stale), true);
    assert.equal(isActivationTicketExpired(garbage), true);
    void createMemoryCacheStorage;
  });
});
