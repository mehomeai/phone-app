// Narrow end-to-end runner against the ACTUAL H1 home service.
// Run: npm run test:live
//
// This is NOT a fixture test. It exercises the real `home-api-v1` service.
// Without a reachable home it exits 0 with a precise SKIP handoff (never a
// false pass, never a false failure).
//
// Environment:
//   ME_HOME_BASE_URL        default http://127.0.0.1:7070 (loopback http allowed)
//   ME_HOME_INVITE_A        JSON {invitationId, pairingSecret, expectedUserId?}
//   ME_HOME_INVITE_B        JSON {invitationId, pairingSecret, expectedUserId?}
//   ME_HOME_INSTALLATION    optional expected installation id (wrong_home probe)
//   ME_BACKEND_BASE_URL     optional; when set, checks backend reachability
//   H1_CONTRACT_PATH        optional override of the H1 contract file path
//
// Cases (each reported separately):
//  1. health: home reachable, contract field compatible
//  2. two users: enroll A+B via one-time invitations, create one conversation
//     each, verify private lists do not intersect and cross-read is denied
//  3. restart: fresh client on the same secure storage renews without invite
//  4. denied access: unpaired device gets nothing; revoked device is refused
//  5. demo mode stays explicit (no server contact)

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  PairedHomeClient,
  DemoHomeAdapter,
  createMemorySecureStorage,
  createMemoryCacheStorage,
} from '../src/index.ts';
import { H1_CONTRACT_PATH, CONTRACT_VERSION } from '../src/home-api-v1.ts';
import { HomeClientError } from '../src/errors.ts';

interface Check {
  name: string;
  status: 'PASS' | 'FAIL' | 'SKIP';
  detail: string;
}

const checks: Check[] = [];
function record(name: string, status: Check['status'], detail: string) {
  checks.push({ name, status, detail });
  console.log(`[${status}] ${name}: ${detail}`);
}

function need(name: string, detail: string) {
  record(name, 'SKIP', detail);
}

function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : undefined;
}

function parseInvite(raw: string | undefined, label: string) {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (
      typeof value['invitationId'] !== 'string' ||
      typeof value['pairingSecret'] !== 'string'
    ) {
      throw new Error('bad shape');
    }
    return value as {
      invitationId: string;
      pairingSecret: string;
      expectedUserId?: string;
    };
  } catch {
    record(label, 'FAIL', `Could not parse ${label} as JSON invitation.`);
    return undefined;
  }
}

async function main() {
  const homeBaseUrl = env('ME_HOME_BASE_URL') ?? 'http://127.0.0.1:7070';
  const backendBaseUrl = env('ME_BACKEND_BASE_URL');

  // H1 contract visibility: confirm the canonical contract exists.
  const contractPath =
    env('H1_CONTRACT_PATH') ??
    resolve(process.cwd(), '..', H1_CONTRACT_PATH);
  if (existsSync(contractPath)) {
    record(
      'h1-contract-present',
      'PASS',
      `Canonical contract ${CONTRACT_VERSION} found at ${contractPath}.`,
    );
  } else {
    record(
      'h1-contract-present',
      'FAIL',
      `Canonical contract missing at ${contractPath}; client speaks ${CONTRACT_VERSION}.`,
    );
  }

  if (backendBaseUrl) {
    try {
      const response = await fetch(`${backendBaseUrl}/api/healthz`);
      record(
        'backend-reachable',
        response.ok ? 'PASS' : 'FAIL',
        `Backend ${backendBaseUrl} answered HTTP ${response.status}.`,
      );
    } catch (error) {
      record(
        'backend-reachable',
        'FAIL',
        `Backend unreachable: ${error instanceof Error ? error.message : error}`,
      );
    }
  } else {
    need(
      'backend-reachable',
      'ME_BACKEND_BASE_URL unset (B1 interface pending); backend coordination check skipped.',
    );
  }

  // 1. health against the real home.
  const probe = new PairedHomeClient(
    createMemorySecureStorage(),
    createMemoryCacheStorage(),
    { allowInsecureLoopback: true },
  );
  try {
    const health = await probe.checkHealth(homeBaseUrl);
    record(
      'home-health',
      'PASS',
      `Home answered status=ok installation=${health.installationId || '(unset)'}.`,
    );
  } catch (error) {
    record(
      'home-health',
      'FAIL',
      `Home health failed at ${homeBaseUrl}: ${error instanceof Error ? error.message : error}`,
    );
    need(
      'two-users-private-conversations',
      'Home unreachable; cannot enroll test devices.',
    );
    need('restart-renews-without-invite', 'Home unreachable.');
    need('unpaired-access-denied', 'Home unreachable.');
    need('revoked-access-denied', 'Home unreachable.');
    record(
      'demo-mode-explicit',
      (await demoCheck()) ? 'PASS' : 'FAIL',
      'Demo adapter marks output acceptedBy=demo with no server contact.',
    );
    return summarize();
  }

  const inviteA = parseInvite(env('ME_HOME_INVITE_A'), 'invite-a-parse');
  const inviteB = parseInvite(env('ME_HOME_INVITE_B'), 'invite-b-parse');
  const expectedInstallation = env('ME_HOME_INSTALLATION');

  if (!inviteA || !inviteB) {
    for (const name of [
      'two-users-private-conversations',
      'restart-renews-without-invite',
      'unpaired-access-denied',
      'revoked-access-denied',
    ]) {
      need(
        name,
        'ME_HOME_INVITE_A/B unset; create two one-time invitations at the home ' +
          '(node src/cli.mjs bootstrap --user=<alice|bob>) and export as JSON ' +
          '{invitationId, pairingSecret}.',
      );
    }
    record(
      'demo-mode-explicit',
      (await demoCheck()) ? 'PASS' : 'FAIL',
      'Demo adapter marks output acceptedBy=demo with no server contact.',
    );
    return summarize();
  }

  // 2. two users enroll and hold private conversations.
  const secureA = createMemorySecureStorage();
  const secureB = createMemorySecureStorage();
  const clientA = new PairedHomeClient(secureA, createMemoryCacheStorage(), {
    allowInsecureLoopback: true,
  });
  const clientB = new PairedHomeClient(secureB, createMemoryCacheStorage(), {
    allowInsecureLoopback: true,
  });
  let convA = '';
  let convB = '';
  try {
    const summaryA = await clientA.enrollOneTime(
      {
        homeBaseUrl,
        invitationId: inviteA.invitationId,
        pairingSecret: inviteA.pairingSecret,
        installationId: expectedInstallation,
        expectedUserId: inviteA.expectedUserId,
      },
      { label: 'live-runner phone A' },
    );
    const summaryB = await clientB.enrollOneTime(
      {
        homeBaseUrl,
        invitationId: inviteB.invitationId,
        pairingSecret: inviteB.pairingSecret,
        installationId: expectedInstallation,
        expectedUserId: inviteB.expectedUserId,
      },
      { label: 'live-runner phone B' },
    );
    convA = (await clientA.createConversation('Live runner A')).id;
    convB = (await clientB.createConversation('Live runner B')).id;
    await clientA.sendMessage(convA, 'hello from live user A');
    await clientB.sendMessage(convB, 'hello from live user B');
    const listA = await clientA.listConversations();
    const listB = await clientB.listConversations();
    const idsA = new Set(listA.map((c) => c.id));
    const overlap = listB.filter((c) => idsA.has(c.id));
    const isolated =
      overlap.length === 0 &&
      listA.some((c) => c.id === convA) &&
      !listB.some((c) => c.id === convA) &&
      listB.some((c) => c.id === convB) &&
      !listA.some((c) => c.id === convB);
    record(
      'two-users-private-conversations',
      isolated ? 'PASS' : 'FAIL',
      isolated
        ? `A=${summaryA.userId} B=${summaryB.userId}; lists isolated, sends landed in own conversations.`
        : `Isolation breach: overlap=${overlap.map((c) => c.id).join(',') || 'none'} A=[${listA.map((c) => c.id)}] B=[${listB.map((c) => c.id)}].`,
    );
    // Cross-read: B must not read A's conversation (404, no existence leak).
    try {
      await clientB.syncConversation(convA);
      record(
        'cross-user-read-denied',
        'FAIL',
        'Cross-user conversation read unexpectedly succeeded.',
      );
    } catch (error) {
      const denied =
        error instanceof HomeClientError &&
        (error.code === 'FORBIDDEN' || error.code === 'NOT_FOUND');
      record(
        'cross-user-read-denied',
        denied ? 'PASS' : 'FAIL',
        denied
          ? 'Other household user IDs fail authorization as required.'
          : `Unexpected error: ${error instanceof Error ? error.message : error}`,
      );
    }
  } catch (error) {
    record(
      'two-users-private-conversations',
      'FAIL',
      `Enrollment/private-conversation probe failed: ${error instanceof Error ? error.message : error}`,
    );
  }

  // 3. restart: same secure storage, fresh client instance, renew, verify.
  try {
    const restarted = new PairedHomeClient(
      secureA,
      createMemoryCacheStorage(),
      { allowInsecureLoopback: true },
    );
    await restarted.renewSession();
    const snapshot = convA
      ? await restarted.syncConversation(convA)
      : null;
    const survived =
      snapshot !== null &&
      snapshot.messages.some((m) => m.text === 'hello from live user A');
    record(
      'restart-renews-without-invite',
      survived ? 'PASS' : 'FAIL',
      survived
        ? 'Session renewed from the stored device credential; history survived.'
        : 'Renewal succeeded but history did not survive.',
    );
  } catch (error) {
    record(
      'restart-renews-without-invite',
      'FAIL',
      `Renewal after restart failed: ${error instanceof Error ? error.message : error}`,
    );
  }

  // 4a. unpaired access denied.
  try {
    const stranger = new PairedHomeClient(
      createMemorySecureStorage(),
      createMemoryCacheStorage(),
      { allowInsecureLoopback: true },
    );
    await stranger.checkHealth(homeBaseUrl);
    await stranger.listConversations();
    record(
      'unpaired-access-denied',
      'FAIL',
      'Unpaired phone unexpectedly read private data.',
    );
  } catch (error) {
    const denied =
      error instanceof HomeClientError &&
      (error.code === 'UNPAIRED' || error.code === 'FORBIDDEN');
    record(
      'unpaired-access-denied',
      denied ? 'PASS' : 'FAIL',
      denied
        ? 'Unpaired phone knowing the URL gets no private data.'
        : `Unexpected error: ${error instanceof Error ? error.message : error}`,
    );
  }

  // 4b. revoked access denied: revoke A's device, then verify it is refused.
  try {
    await clientA.revokeOwnDevice();
    try {
      await clientA.listConversations();
      record(
        'revoked-access-denied',
        'FAIL',
        'Revoked device unexpectedly retained access.',
      );
    } catch (error) {
      const denied =
        error instanceof HomeClientError &&
        (error.code === 'DEVICE_REVOKED' || error.code === 'UNPAIRED');
      record(
        'revoked-access-denied',
        denied ? 'PASS' : 'FAIL',
        denied
          ? 'Revoked device lost further access as required.'
          : `Unexpected error: ${error instanceof Error ? error.message : error}`,
      );
    }
  } catch (error) {
    record(
      'revoked-access-denied',
      'FAIL',
      `Revocation probe failed: ${error instanceof Error ? error.message : error}`,
    );
  }

  record(
    'demo-mode-explicit',
    (await demoCheck()) ? 'PASS' : 'FAIL',
    'Demo adapter marks output acceptedBy=demo with no server contact.',
  );
  summarize();
}

async function demoCheck(): Promise<boolean> {
  const demo = new DemoHomeAdapter();
  const { assistant } = await demo.sendLocal('conv_live_demo', 'u', 'hi');
  return demo.mode === 'demo' && assistant.acceptedBy === 'demo';
}

function summarize(): void {
  const failed = checks.filter((c) => c.status === 'FAIL');
  const skipped = checks.filter((c) => c.status === 'SKIP');
  console.log(
    `\nLive integration: ${checks.length - failed.length - skipped.length} passed, ` +
      `${failed.length} failed, ${skipped.length} skipped.`,
  );
  if (failed.length > 0) process.exitCode = 1;
}

await main();
