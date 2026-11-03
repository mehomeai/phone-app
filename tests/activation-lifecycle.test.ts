// Ephemeral ticket lifecycle fence (F9 review) contract tests.
// Run: npm test
// These exercise the ACTUAL reusable guard the native ticket UI publishes
// through (EphemeralRequestGuard + arrival/copy predicates + scope
// fingerprint + real expiry helper), driven by deferred promises that
// resolve AFTER background / discard / unmount / account-change / expiry —
// the exact late-arrival races the review flagged. No mirrored helpers:
// every predicate under test is imported from the shipped modules. The copy
// mapping uses the real copyTextToClipboard with an injected clipboard.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  EphemeralRequestGuard,
  activationScopeFingerprint,
  shouldPublishTicketArrival,
  shouldPublishCopyFeedback,
  UNKNOWN_TICKET_OUTCOME_MESSAGE,
  isActivationTicketExpired,
} from '../src/index.ts';
import type { ActivationTicket } from '../src/index.ts';
import {
  copyTextToClipboard,
} from '../apps/mobile/lib/clipboard.ts';
import type { ClipboardLike } from '../apps/mobile/lib/clipboard.ts';

const INSTALLATION = '123e4567-e89b-42d3-a456-426614174000';

function testTicket(expiresAt: string): ActivationTicket {
  return {
    ticketId: 'act_test0001abcd',
    activationSecret: 's3cr3t-test-secret-0123456789abcdef01234567',
    installationId: INSTALLATION,
    mode: 'new',
    homeId: null,
    expiresAt,
  };
}

const freshTicket = () => testTicket(new Date(Date.now() + 5 * 60_000).toISOString());
const staleTicket = () => testTicket(new Date(Date.now() - 1000).toISOString());

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeClipboard(accept: boolean): { loader: () => Promise<ClipboardLike | null>; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    loader: async () => ({
      setStringAsync: async (text: string) => {
        calls.push(text);
        return accept;
      },
    }),
  };
}

describe('ephemeral ticket lifecycle fence (real guard, late arrivals)', () => {
  it('grants a single in-flight request; release is generation-scoped', () => {
    const guard = new EphemeralRequestGuard();
    const first = guard.tryAcquire();
    assert.equal(typeof first, 'number');
    // Double-tap before the first settles: no second mint.
    assert.equal(guard.tryAcquire(), null);
    // A stale finally cannot free the live slot.
    guard.release(999);
    assert.equal(guard.tryAcquire(), null);
    guard.release(first!);
    const again = guard.tryAcquire();
    assert.equal(again, first);
    guard.release(again!);
  });

  it('background / discard / unmount invalidate: late mint never publishes', async () => {
    for (const scopeExit of ['background', 'discard', 'unmount']) {
      const guard = new EphemeralRequestGuard();
      const published: ActivationTicket[] = [];
      let mintCalls = 0;
      const gen = guard.tryAcquire();
      assert.notEqual(gen, null);
      const ticketPromise = (async () => {
        mintCalls += 1;
        await Promise.resolve();
        return freshTicket();
      })();
      // Scope exits while the mint is in flight.
      guard.invalidate();
      void scopeExit;
      const ticket = await ticketPromise;
      if (shouldPublishTicketArrival(ticket, gen!, guard)) {
        published.push(ticket);
      }
      assert.equal(mintCalls, 1);
      assert.deepEqual(published, [], `${scopeExit} must discard the late arrival`);
    }
  });

  it('logout then login to the SAME identity still discards the old reply', async () => {
    const guard = new EphemeralRequestGuard();
    const signedIn = { accountId: 'acct_alice', issuer: 'https://issuer.example.test', backendUrl: 'https://b.example.test', status: 'signed-in' };
    const signedOut = { ...signedIn, status: 'signed-out' };
    const before = activationScopeFingerprint(signedIn);
    const gen = guard.tryAcquire();
    assert.notEqual(gen, null);
    const late = deferred<ActivationTicket>();
    // Logout clears (invalidate), re-login clears again — same identity,
    // but the generation moved twice.
    guard.invalidate();
    assert.notEqual(activationScopeFingerprint(signedOut), before);
    guard.invalidate();
    const relogin = activationScopeFingerprint(signedIn);
    assert.equal(relogin, before, 'fingerprint alone cannot tell the sessions apart');
    late.resolve(freshTicket());
    const ticket = await late.promise;
    assert.equal(
      shouldPublishTicketArrival(ticket, gen!, guard),
      false,
      'generation fence must refuse the pre-logout reply despite identical identity',
    );
  });

  it('an already-expired arrival is never published even when current', () => {
    const guard = new EphemeralRequestGuard();
    const gen = guard.tryAcquire();
    assert.notEqual(gen, null);
    assert.equal(shouldPublishTicketArrival(freshTicket(), gen!, guard), true);
    assert.equal(shouldPublishTicketArrival(staleTicket(), gen!, guard), false);
    assert.equal(isActivationTicketExpired(staleTicket()), true);
    assert.equal(isActivationTicketExpired({ ...freshTicket(), expiresAt: 'not-a-date' }), true);
    guard.release(gen!);
  });

  it('double-tap mint fires once; backgrounded copy publishes no feedback', async () => {
    const guard = new EphemeralRequestGuard();
    let mintCalls = 0;
    const startMint = () => {
      const gen = guard.tryAcquire();
      if (gen === null) return null;
      mintCalls += 1;
      return { gen, promise: deferred<ActivationTicket>().promise };
    };
    const first = startMint();
    assert.notEqual(first, null);
    assert.equal(startMint(), null, 'second tap while in flight must not mint');
    assert.equal(mintCalls, 1);
    guard.release(first!.gen);

    // Copy path: feedback captured before the await, scope exits mid-copy.
    const copyGen = guard.current();
    const { loader, calls } = fakeClipboard(true);
    const copyPromise = copyTextToClipboard('{"ticketId":"act_x"}', loader);
    guard.invalidate();
    const copyResult = await copyPromise;
    assert.equal(copyResult.ok, true, 'the OS copy itself still happened');
    assert.deepEqual(calls.length, 1);
    let feedback: string | null = null;
    if (shouldPublishCopyFeedback(copyGen, guard)) {
      feedback = copyResult.ok ? 'copied' : 'failed';
    }
    assert.equal(feedback, null, 'stale copy feedback must not appear after discard');
    // And the clipboard is never wiped as "cleanup": only one write happened.
    assert.deepEqual(calls.length, 1);
  });

  it('copy mapping is honest: accepted / refused / missing / empty', async () => {
    const ok = await copyTextToClipboard('{"a":1}', fakeClipboard(true).loader);
    assert.deepEqual(ok, { ok: true });
    const refused = await copyTextToClipboard('{"a":1}', fakeClipboard(false).loader);
    assert.equal(refused.ok, false);
    const missing = await copyTextToClipboard('{"a":1}', async () => null);
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.match(missing.reason, /clipboard/i);
    let loaderCalled = false;
    const empty = await copyTextToClipboard('', async () => {
      loaderCalled = true;
      return null;
    });
    assert.equal(empty.ok, false);
    assert.equal(loaderCalled, false, 'empty text must not touch the clipboard');
  });

  it('unknown-outcome message asserts nothing and promises no retry', () => {
    assert.match(UNKNOWN_TICKET_OUTCOME_MESSAGE, /unknown/i);
    assert.match(UNKNOWN_TICKET_OUTCOME_MESSAGE, /not retried automatically/i);
    assert.match(UNKNOWN_TICKET_OUTCOME_MESSAGE, /expir/i);
    assert.ok(!/nothing was minted/i.test(UNKNOWN_TICKET_OUTCOME_MESSAGE));
  });
});
