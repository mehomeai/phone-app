// Pure helper tests: home identity binding (no servers, no UI).
// Run: part of `npm test`.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  visibleConversations,
  reconcileOnEnrollmentChange,
  filterStateToScope,
  stampLinkScope,
  rebindLinksEndpoint,
  linkScopeMatches,
  normalizeOrigin,
  verifyEndpointIdentity,
} from '../src/index.ts';
import type { IdentityTuple } from '../src/index.ts';

const HOME_A: IdentityTuple = {
  userId: 'alice',
  deviceId: 'dev_a',
  installationId: 'install_1',
  homeBaseUrl: 'https://home.invalid',
};
// Same username, DIFFERENT home: must never inherit Alice's cache.
const HOME_A2: IdentityTuple = {
  userId: 'alice',
  deviceId: 'dev_a2',
  installationId: 'install_2',
  homeBaseUrl: 'https://home2.invalid',
};
const BOB: IdentityTuple = {
  userId: 'bob',
  deviceId: 'dev_b',
  installationId: 'install_1',
  homeBaseUrl: 'https://home.invalid',
};

function linkFor(scope: IdentityTuple, homeId = 'hc1') {
  return {
    homeId,
    homeOwner: scope.userId,
    homeInstallationId: scope.installationId,
    homeDeviceId: scope.deviceId,
    homeBaseUrl: scope.homeBaseUrl,
  };
}

describe('home identity binding (pure)', () => {
  it('demo keeps profile switching; home binds to the full scope', () => {
    const conversations = [
      { id: 'd1', profileId: 'p-maya', assistantMode: 'demo' as const },
      { id: 'd2', profileId: 'p-theo', assistantMode: 'demo' as const },
      { id: 'h1', profileId: 'p-maya', assistantMode: 'home' as const },
      { id: 'h2', profileId: 'p-theo', assistantMode: 'home' as const },
    ];
    const links = { h1: linkFor(HOME_A), h2: linkFor(BOB, 'hc2') };
    // Demo: profile-scoped as before.
    assert.deepEqual(
      visibleConversations(conversations, links, {
        mode: 'demo',
        activeProfileId: 'p-maya',
        homeScope: null,
        identityResolved: true,
      }).map((c) => c.id),
      ['d1'],
    );
    // Home: bound to the full scope regardless of profile.
    assert.deepEqual(
      visibleConversations(conversations, links, {
        mode: 'home',
        activeProfileId: 'p-theo',
        homeScope: HOME_A,
        identityResolved: true,
      }).map((c) => c.id),
      ['h1'],
    );
    // Unresolved identity shows nothing: no previous-user flash.
    assert.deepEqual(
      visibleConversations(conversations, links, {
        mode: 'home',
        activeProfileId: 'p-maya',
        homeScope: HOME_A,
        identityResolved: false,
      }),
      [],
    );
    // Unlinked or differently-owned home rows stay hidden.
    assert.deepEqual(
      visibleConversations(
        [...conversations, { id: 'h3', assistantMode: 'home' as const }],
        links,
        { mode: 'home', activeProfileId: 'p-maya', homeScope: HOME_A, identityResolved: true },
      ).map((c) => c.id),
      ['h1'],
    );
  });

  it('same username on a different home sees nothing (installation/device/endpoint)', () => {
    const conversations = [
      { id: 'h1', assistantMode: 'home' as const },
    ];
    const links = { h1: linkFor(HOME_A) };
    const opts = (homeScope: IdentityTuple | null) => ({
      mode: 'home' as const,
      activeProfileId: 'p',
      homeScope,
      identityResolved: true,
    });
    // Same installation/user, different device (reinstalled phone): hidden.
    assert.deepEqual(
      visibleConversations(conversations, links, opts({ ...HOME_A, deviceId: 'dev_other' })),
      [],
    );
    // Same user/device, different installation (reinstalled home): hidden.
    assert.deepEqual(visibleConversations(conversations, links, opts(HOME_A2)), []);
    // Same everything except endpoint (rotated tunnel URL): hidden until rebind.
    assert.deepEqual(
      visibleConversations(conversations, links, opts({ ...HOME_A, homeBaseUrl: 'https://home2.invalid' })),
      [],
    );
    // Endpoint normalization still matches (trailing slash / case).
    assert.deepEqual(
      visibleConversations(
        conversations,
        { h1: { ...linkFor(HOME_A), homeBaseUrl: 'https://home.invalid/' } },
        opts({ ...HOME_A, homeBaseUrl: 'HTTPS://HOME.INVALID' }),
      ).map((c) => c.id),
      ['h1'],
    );
    // Legacy owner-only links (no scope stamp) never match.
    assert.deepEqual(
      visibleConversations(conversations, { h1: { homeId: 'hc1', homeOwner: 'alice' } }, opts(HOME_A)),
      [],
    );
  });

  it('hydration sanitize keeps same-scope rows and drops cross-scope rows', () => {
    const conversations = [
      { id: 'd1', profileId: 'p', assistantMode: 'demo' as const },
      { id: 'mine', profileId: 'p', assistantMode: 'home' as const },
      { id: 'other-user', profileId: 'p', assistantMode: 'home' as const },
      { id: 'other-home', profileId: 'p', assistantMode: 'home' as const },
      { id: 'legacy', profileId: 'p', assistantMode: 'home' as const },
    ];
    const links = {
      mine: linkFor(HOME_A),
      'other-user': linkFor(BOB),
      'other-home': linkFor(HOME_A2),
      legacy: { homeId: 'hc9', homeOwner: 'alice' },
    };
    const sanitized = filterStateToScope(conversations, links, HOME_A);
    assert.deepEqual(
      sanitized.conversations.map((c) => c.id).sort(),
      ['d1', 'mine'],
    );
    assert.deepEqual(Object.keys(sanitized.links).sort(), ['mine']);
    assert.deepEqual(sanitized.droppedLocalIds.sort(), ['legacy', 'other-home', 'other-user']);
    // No identity at all: only demo survives.
    const loggedOut = filterStateToScope(conversations, links, null);
    assert.deepEqual(loggedOut.conversations.map((c) => c.id), ['d1']);
  });

  it('any credential change drops home state and keeps demo', () => {
    const conversations = [
      { id: 'd1', profileId: 'p', assistantMode: 'demo' as const },
      { id: 'h1', profileId: 'p', assistantMode: 'home' as const },
    ];
    const links = { h1: linkFor(HOME_A) };
    // Same tuple: no-op.
    const same = reconcileOnEnrollmentChange(HOME_A, { ...HOME_A }, conversations, links);
    assert.deepEqual(same.droppedLocalIds, []);
    // Trailing-slash endpoint difference alone is not a change.
    const slash = reconcileOnEnrollmentChange(
      HOME_A,
      { ...HOME_A, homeBaseUrl: 'https://home.invalid/' },
      conversations,
      links,
    );
    assert.deepEqual(slash.droppedLocalIds, []);
    // New user/device/installation: home state dropped, demo kept.
    const switched = reconcileOnEnrollmentChange(HOME_A, BOB, conversations, links);
    assert.deepEqual(switched.droppedLocalIds, ['h1']);
    assert.ok(switched.keepConversationIds.has('d1'));
    assert.deepEqual(switched.links, {});
    // Same username, different installation: dropped.
    const reinstalled = reconcileOnEnrollmentChange(HOME_A, HOME_A2, conversations, links);
    assert.deepEqual(reinstalled.droppedLocalIds, ['h1']);
    // Logout: same clearing, demo survives.
    const logout = reconcileOnEnrollmentChange(HOME_A, null, conversations, links);
    assert.deepEqual(logout.droppedLocalIds, ['h1']);
  });

  it('stamps, rebinds, and verifies endpoint identity strictly', () => {
    const stamped = stampLinkScope({ h1: { homeId: 'hc1' } }, 'h1', HOME_A);
    assert.equal(stamped.h1?.homeOwner, 'alice');
    assert.equal(stamped.h1?.homeInstallationId, 'install_1');
    assert.equal(stamped.h1?.homeDeviceId, 'dev_a');
    assert.ok(linkScopeMatches(stamped.h1, HOME_A));
    assert.ok(!linkScopeMatches(stamped.h1, HOME_A2));
    const rebound = rebindLinksEndpoint(stamped, 'https://home3.invalid/');
    assert.equal(rebound.h1?.homeBaseUrl, 'https://home3.invalid');
    assert.equal(rebound.h1?.homeOwner, 'alice');
    assert.ok(!linkScopeMatches(rebound.h1, HOME_A));
    assert.equal(normalizeOrigin('https://H.INVALID///path'), 'https://h.invalid');
    assert.equal(normalizeOrigin('not a url'), null);
    assert.equal(verifyEndpointIdentity('install_1', 'install_1'), true);
    assert.equal(verifyEndpointIdentity('install_1', 'install_2'), false);
    assert.equal(verifyEndpointIdentity(undefined, 'install_1'), false);
    assert.equal(verifyEndpointIdentity('install_1', ''), false);
    assert.equal(verifyEndpointIdentity(null, null), false);
  });
});
