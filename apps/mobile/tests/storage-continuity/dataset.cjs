'use strict';

/**
 * PR C (SDK 58) — AsyncStorage data-continuity dataset.
 *
 * Every key and value shape below is taken from the app's real AsyncStorage
 * usage, inventoried 2026-11-05 on phone-app main 8003e80 (see
 * PRC-CONTINUITY-PROOF-PLAN.md for the full inventory):
 *
 *   - `me-demo-state-v1`   — context/MeContext.tsx KEY; JSON.stringify of the
 *                            Persisted state object (profiles, conversations,
 *                            settings, liked/saved, clipCollectionsByProfile,
 *                            onboardingCompleted, homeLinks).
 *   - `me-home-links-v1`   — context/MeContext.tsx HOME_LINKS_KEY;
 *                            JSON.stringify(state.homeLinks):
 *                            Record<conversationId, HomeLink>.
 *   - `me-native-outbox-v1`— context/MeContext.tsx NATIVE_OUTBOX_KEY;
 *                            JSON.stringify({ scopeKey, entries }) where
 *                            entries is Record<externalId, { localId,
 *                            channelId, agentId, text, scopeKey, accepted,
 *                            echoed? }>.
 *   - `me.home.cache.v1.<conversationId>` — src/paired-home-client.ts
 *                            CACHE_PREFIX (also src/demo-adapter.ts), written
 *                            through createAsyncStorageCacheAdapter in
 *                            apps/mobile/lib/home-client.ts;
 *                            JSON.stringify(ConversationSnapshot).
 *
 * The app only ever calls getItem / setItem / removeItem on the default
 * export, and every stored value is a JSON string. There are no raw-string,
 * merged-object, multiGet/multiSet, or getAllKeys call sites in app code.
 *
 * All fixture content is deterministic (fixed ids and timestamps) so the
 * expected snapshot is byte-stable across runs and machines. Unicode,
 * emoji, CJK, and a long repeated text are included on purpose: byte
 * identity must survive encoding, not just ASCII equality.
 */

const DEMO_STATE = {
  profiles: [
    { id: 'profile-parent-1', name: 'Alex Parent', role: 'parent' },
    { id: 'profile-child-1', name: 'Jamie Kid', role: 'child' },
  ],
  activeProfileId: 'profile-parent-1',
  conversations: [
    {
      id: 'conv-demo-1',
      profileId: 'profile-parent-1',
      title: 'Weekend plans',
      assistantMode: 'demo',
      createdAt: 1762000000000,
      messages: [
        {
          id: 'msg-1',
          role: 'user',
          text: 'What should we cook on Saturday?',
          createdAt: 1762000001000,
        },
        {
          id: 'msg-2',
          role: 'assistant',
          text: 'How about pancakes — with blueberries 🫐 and a Café au lait ☕?',
          createdAt: 1762000002000,
        },
      ],
    },
    {
      id: 'conv-home-1',
      profileId: 'profile-parent-1',
      title: 'Home chat',
      assistantMode: 'home',
      createdAt: 1762000100000,
      messages: [
        {
          id: 'msg-3',
          role: 'user',
          text: 'Turn off the porch light',
          createdAt: 1762000101000,
        },
      ],
    },
  ],
  settings: {
    assistantMode: 'home',
    homeUrl: 'http://me-home.local:8080',
    model: 'me-balanced',
    learningMix: 65,
    topics: ['cooking', 'astronomy', '日本語'],
    approvalRequired: true,
  },
  liked: ['clip-nasa-orbit', 'clip-deep-sea'],
  saved: ['clip-nasa-orbit'],
  clipCollectionsByProfile: {
    'profile-parent-1': {
      liked: ['clip-nasa-orbit', 'clip-deep-sea'],
      saved: ['clip-nasa-orbit'],
    },
    'profile-child-1': { liked: [], saved: ['clip-garden-tour'] },
  },
  onboardingCompleted: true,
  homeLinks: {
    'conv-home-1': {
      homeId: 'home-conv-aaa',
      requestKey: 'req-fixture-0001',
      upstreamAgentId: 'agent-main',
      homeOwner: 'profile-parent-1',
      homeInstallationId: 'install-fixture-1',
      homeDeviceId: 'device-fixture-1',
      homeBaseUrl: 'http://me-home.local:8080',
    },
  },
};

const HOME_LINKS = {
  'conv-home-1': {
    homeId: 'home-conv-aaa',
    requestKey: 'req-fixture-0001',
    upstreamAgentId: 'agent-main',
    homeOwner: 'profile-parent-1',
    homeInstallationId: 'install-fixture-1',
    homeDeviceId: 'device-fixture-1',
    homeBaseUrl: 'http://me-home.local:8080',
  },
  // Minimal legacy/unscoped link shape: only homeId is guaranteed.
  'conv-legacy-1': { homeId: 'home-conv-bbb' },
};

const NATIVE_OUTBOX = {
  scopeKey: 'scope-fixture-v1',
  entries: {
    'ext-req-0001': {
      localId: 'conv-home-1',
      channelId: 'home-conv-aaa',
      agentId: 'agent-main',
      text: 'Turn off the porch light',
      scopeKey: 'scope-fixture-v1',
      accepted: true,
      echoed: true,
    },
    'ext-req-0002': {
      localId: 'conv-home-1',
      channelId: 'home-conv-aaa',
      agentId: 'agent-main',
      text: 'Add milk to the list ✓ — 牛乳も',
      scopeKey: 'scope-fixture-v1',
      accepted: false,
    },
  },
};

const LONG_TEXT =
  'Porch status report: ' +
  'the quick brown fox jumps over the lazy dog. '.repeat(40);

const CACHE_HOME_CONV = {
  id: 'conv-home-1',
  ownerUserId: 'profile-parent-1',
  title: 'Home chat',
  version: 3,
  cursor: 'sync_1762000200000',
  messages: [
    {
      id: 'hm-1',
      conversationId: 'conv-home-1',
      authorUserId: 'profile-parent-1',
      role: 'user',
      text: 'Turn off the porch light',
      createdAt: 1762000101000,
      acceptedBy: 'home',
      homeMessageId: 'srv-100',
      requestId: 'ext-req-0001',
    },
    {
      id: 'hm-2',
      conversationId: 'conv-home-1',
      authorUserId: null,
      role: 'system',
      text: 'Porch light turned off.',
      createdAt: 1762000102000,
      acceptedBy: 'home',
      homeMessageId: 'srv-101',
    },
    {
      id: 'hm-3',
      conversationId: 'conv-home-1',
      authorUserId: 'profile-parent-1',
      role: 'user',
      text: 'And lock the door 🔒 — merci!',
      createdAt: 1762000103000,
      acceptedBy: 'home',
      pending: true,
      requestId: 'ext-req-0002',
    },
    {
      id: 'hm-4',
      conversationId: 'conv-home-1',
      authorUserId: null,
      role: 'assistant',
      text: LONG_TEXT,
      createdAt: 1762000104000,
      acceptedBy: 'home',
      homeMessageId: 'srv-102',
    },
  ],
};

const CACHE_DEMO_CONV = {
  id: 'conv-demo-1',
  ownerUserId: 'profile-parent-1',
  title: 'Weekend plans',
  version: 0,
  cursor: 'demo',
  messages: [
    {
      id: 'dm-1',
      conversationId: 'conv-demo-1',
      authorUserId: 'profile-parent-1',
      role: 'user',
      text: 'What should we cook on Saturday?',
      createdAt: 1762000001000,
      acceptedBy: 'demo',
    },
    {
      id: 'dm-2',
      conversationId: 'conv-demo-1',
      authorUserId: null,
      role: 'assistant',
      text: 'How about pancakes — with blueberries 🫐 and a Café au lait ☕?',
      createdAt: 1762000002000,
      acceptedBy: 'demo',
    },
  ],
};

const CACHE_EMPTY_CONV = {
  id: 'conv-empty-1',
  ownerUserId: 'profile-child-1',
  title: 'New conversation',
  version: 0,
  cursor: 'local',
  messages: [],
};

/** Ordered [key, value] pairs exactly as the app would write them. */
const ENTRIES = [
  ['me-demo-state-v1', JSON.stringify(DEMO_STATE)],
  ['me-home-links-v1', JSON.stringify(HOME_LINKS)],
  ['me-native-outbox-v1', JSON.stringify(NATIVE_OUTBOX)],
  ['me.home.cache.v1.conv-home-1', JSON.stringify(CACHE_HOME_CONV)],
  ['me.home.cache.v1.conv-demo-1', JSON.stringify(CACHE_DEMO_CONV)],
  ['me.home.cache.v1.conv-empty-1', JSON.stringify(CACHE_EMPTY_CONV)],
];

/** Keys the app itself removes (MeContext reset flow, lines 3549-3550). */
const REMOVABLE_KEYS = ['me-demo-state-v1', 'me-home-links-v1'];

const crypto = require('node:crypto');

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * The recorded expected snapshot: sorted key list plus, per key, the exact
 * value, its UTF-8 byte length, and its SHA-256. Capture mode persists this
 * next to the store; verify mode demands byte identity against it.
 */
function expectedSnapshot() {
  const values = {};
  const hashes = {};
  const byteLengths = {};
  for (const [key, value] of ENTRIES) {
    values[key] = value;
    hashes[key] = sha256(value);
    byteLengths[key] = Buffer.byteLength(value, 'utf8');
  }
  return {
    keys: ENTRIES.map(([key]) => key).sort(),
    values,
    hashes,
    byteLengths,
  };
}

module.exports = { ENTRIES, REMOVABLE_KEYS, expectedSnapshot, sha256 };
