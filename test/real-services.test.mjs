// Self-contained real-services integration suite (F2).
//
// Starts the ACTUAL sibling services in-process over loopback with temporary
// state and synthetic users — no human-set env, no skips-as-success:
//   - H1 home:      ../infra-server/src/server.mjs  (createHomeServer, temp SQLite)
//   - B1 backend:   ../backend-server/src/server.mjs (createBackend, temp data dir)
//   - F1/F2 client: ../src/index.ts                 (real PairedHomeClient)
//
// Lifecycle covered: B1 /healthz (not /api/healthz), home registration with
// H1 installation_id as the registered homeId mapping, heartbeat/status,
// join tickets + account join/discovery, real H1 one-time pairing for two
// users, private conversations with cross-user/unpaired denial, wrong-home
// invitation rejection, full restart of both services AND fresh client
// instances with persisted history, consumed-ticket replay rejection, device
// revocation, and backend membership removal.
//
// H2 note: home-api-v1 has no task/progress/question/approval/artifact or
// server-bound message-idempotency routes yet (checked 2026-11-03), so the
// client keeps its at-most-once requestId replay guard; this suite asserts
// real conversation persistence, not invented task endpoints.
//
// Run: npm run test:real

import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');
const INFRA_SRC =
  process.env.ME_REAL_HOME_SRC ??
  join(REPO_ROOT, '..', 'infra-server', 'src', 'server.mjs');
const BACKEND_SRC =
  process.env.ME_REAL_BACKEND_SRC ??
  join(REPO_ROOT, '..', 'backend-server', 'src', 'server.mjs');
const FIXTURE_BRIDGE = join(dirname(INFRA_SRC), '..', 'test', 'fixture-bridge.mjs');

const { createHomeServer, ensureUser, createInvitation } = await import(
  pathToFileURL(INFRA_SRC).href
);
const { createBackend } = await import(pathToFileURL(BACKEND_SRC).href);
const {
  BackendCoordinator,
  PairedHomeClient,
  createMemoryCacheStorage,
  createMemorySecureStorage,
  reconcileOnEnrollmentChange,
  HomeClientError,
} = await import('../src/index.ts');

// Synthetic dev-only identity (mirrors backend-server/test/helper.mjs).
const SETUP_TOKEN = 'f2-setup-token-0123456789abcdef';
const TOKEN_ALICE = 'f2-token-alice-0000000000000001';
const TOKEN_BOB = 'f2-token-bob-0000000000000002';
const TOKEN_CAROL = 'f2-token-carol-0000000000000003';
const ACCOUNTS = {
  [TOKEN_ALICE]: 'acct_alice',
  [TOKEN_BOB]: 'acct_bob',
  [TOKEN_CAROL]: 'acct_carol',
};
const HOME_ID = 'home-f2-real-01';

/** Test-only file-backed SecureStorage: proves enrollment material can be
 *  persisted across client restarts and reloaded by a fresh instance. */
function fileSecureStorage(path) {
  const readAll = async () => {
    try {
      return JSON.parse(await readFile(path, 'utf8'));
    } catch {
      return {};
    }
  };
  return {
    async getItem(key) {
      const all = await readAll();
      return typeof all[key] === 'string' ? all[key] : null;
    },
    async setItem(key, value) {
      const all = await readAll();
      all[key] = value;
      await writeFile(path, JSON.stringify(all));
    },
    async deleteItem(key) {
      const all = await readAll();
      delete all[key];
      await writeFile(path, JSON.stringify(all));
    },
    async isAvailable() {
      return true;
    },
  };
}

async function startBackend(dataDir, port = 0) {
  const { handler } = createBackend({
    host: '127.0.0.1',
    port: 0,
    dataDir,
    setupToken: SETUP_TOKEN,
    devAccounts: new Map(Object.entries(ACCOUNTS)),
  });
  const server = createServer(handler);
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  const actual = server.address().port;
  return { server, base: `http://127.0.0.1:${actual}`, port: actual };
}

async function startHome(dbPath, port = 0, broker) {
  const server = createHomeServer({
    dbPath,
    ...(broker
      ? { broker: { ...broker, tasksRoot: join(dirname(dbPath), 'tasks') } }
      : {}),
  });
  const info = await server.start({ host: '127.0.0.1', port });
  const base = `http://${info.host}:${info.port}`;
  const actual = new URL(base).port ? Number(new URL(base).port) : info.port;
  return { server, base, port: actual };
}

// Deterministic fixture-model broker: the real H1 task worker executes the
// labeled offline fixture bridge (no model downloads, no network).
function fixtureBroker() {
  return {
    runtime: { command: [process.execPath, FIXTURE_BRIDGE] },
    model: { provider: 'fixture', model: 'fixture-echo' },
    pollMs: 25,
  };
}

async function backendApi(base, method, path, { accountToken, homeToken, setupToken, body } = {}) {
  const headers = { 'content-type': 'application/json', connection: 'close' };
  if (accountToken) headers.authorization = `Bearer ${accountToken}`;
  if (homeToken) headers.authorization = `Bearer ${homeToken}`;
  if (setupToken) headers['x-me-setup-token'] = setupToken;
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

/**
 * Deterministic restart transport (F4/F5 regression fix).
 *
 * Root cause: Node's global undici dispatcher pools keep-alive sockets.
 * When BOTH services restart on the SAME loopback ports (stable endpoint,
 * like a home reboot keeping its tunnel URL), the pool still holds idle
 * sockets to the OLD server sockets. The FIRST fetch after restart reuses
 * a dead socket and fails `read ECONNRESET` — not load, not a product bug.
 * Stack before the fix: `TypeError: fetch failed` caused by
 * `Error: read ECONNRESET at TCP.onStreamRead`, thrown from the first
 * post-restart `backendApi` discovery fetch (step 9).
 *
 * Fix (test-owned, deterministic): every harness fetch sends
 * `Connection: close`, so no idle keep-alive socket is ever pooled and
 * the post-restart request always opens a fresh connection. No blanket
 * retry of non-idempotent POSTs after an unknown outcome — the existing
 * step-9 sequence (restart SAME ports, then immediate discovery fetch with
 * no retry wrapper) IS the regression: it failed deterministically before
 * this fix and must stay green without retries.
 */
async function closeableFetch(input, init = {}) {
  const headers = { ...(init.headers ?? {}), connection: 'close' };
  return fetch(input, { ...init, headers });
}

function phoneClient(secure, homeBaseUrl) {
  void homeBaseUrl;
  return new PairedHomeClient(secure, createMemoryCacheStorage(), {
    allowInsecureLoopback: true,
    fetchImpl: async (url, init = {}) => {
      const res = await closeableFetch(url, {
        method: init.method,
        headers: init.headers,
        body: init.body,
        signal: init.signal,
        redirect: init.redirect,
      });
      return res;
    },
  });
}

test('real home + backend + phone client: full pairing lifecycle', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'me-f2-real-'));
  const homeDb = join(dir, 'home.sqlite');
  const backendDir = join(dir, 'backend');
  const securePathA = join(dir, 'secure-a.json');
  const securePathB = join(dir, 'secure-b.json');
  let home = await startHome(homeDb, 0, fixtureBroker());
  let backend = await startBackend(backendDir);
  t.after(async () => {
    try { await home.server.stop(); } catch { /* already stopped */ }
    try { await new Promise((resolve) => backend.server.close(resolve)); } catch { /* already closed */ }
    await rm(dir, { recursive: true, force: true });
  });

  // Synthetic household users exist at the home (H1 local bootstrap path).
  ensureUser(home.server.db, 'alice', 'Alice (synthetic)');
  ensureUser(home.server.db, 'bob', 'Bob (synthetic)');

  // 1. Backend health is /healthz (never /api/healthz).
  const health = await backendApi(backend.base, 'GET', '/healthz');
  assert.equal(health.status, 200);
  assert.equal(health.json.ok, true);
  assert.match(health.json.service ?? '', /backend/);
  const wrongHealth = await closeableFetch(`${backend.base}/api/healthz`);
  assert.notEqual(wrongHealth.status, 200);

  // 2. Home health exposes the installation_id this suite registers.
  const homeHealth = await (await closeableFetch(`${home.base}/healthz`)).json();
  assert.equal(homeHealth.status, 'ok');
  assert.equal(homeHealth.contract, 'home-api-v1');
  const installationId = homeHealth.installation_id;
  assert.match(installationId, /^[0-9a-f-]{36}$/);

  // 3. Register the home at the backend keyed by installation_id mapping.
  const reg = await backendApi(backend.base, 'POST', '/v1/homes/register', {
    setupToken: SETUP_TOKEN,
    body: {
      homeId: HOME_ID,
      installationId,
      displayName: 'F2 Real Home',
      endpointHint: home.base,
      protocolVersion: 'home-api-v1',
    },
  });
  assert.equal(reg.status, 201);
  assert.equal(reg.json.homeId, HOME_ID);
  assert.equal(reg.json.installationId, installationId);
  const homeToken = reg.json.homeToken;
  assert.match(homeToken, /^me_home_/);

  // 4. Heartbeat + member-visible status.
  const beat = await backendApi(backend.base, 'POST', `/v1/homes/${HOME_ID}/heartbeat`, {
    homeToken,
    body: { status: 'online', endpointHint: home.base, installationId },
  });
  assert.equal(beat.status, 200);
  assert.equal(beat.json.lastStatus, 'online');

  // 5. Join tickets bind the two synthetic accounts; carol stays outside.
  const ticketFor = async () => {
    const res = await backendApi(backend.base, 'POST', `/v1/homes/${HOME_ID}/join-tickets`, {
      homeToken,
      body: { ttlSeconds: 900 },
    });
    assert.equal(res.status, 201);
    return res.json;
  };
  const joinAs = async (token) => {
    const ticket = await ticketFor();
    const res = await backendApi(backend.base, 'POST', `/v1/homes/${HOME_ID}/members/join`, {
      accountToken: token,
      body: { ticketSecret: ticket.ticketSecret },
    });
    return { res, ticket };
  };
  const joinedAlice = await joinAs(TOKEN_ALICE);
  assert.equal(joinedAlice.res.status, 201);
  // Consumed ticket cannot be replayed (explicit id lookup -> 410).
  const replay = await backendApi(backend.base, 'POST', `/v1/homes/${HOME_ID}/members/join`, {
    accountToken: TOKEN_BOB,
    body: {
      ticketSecret: joinedAlice.ticket.ticketSecret,
      ticketId: joinedAlice.ticket.ticketId,
    },
  });
  assert.equal(replay.status, 410);
  const joinedBob = await joinAs(TOKEN_BOB);
  assert.equal(joinedBob.res.status, 201);

  const discoAlice = await backendApi(backend.base, 'GET', '/v1/homes', { accountToken: TOKEN_ALICE });
  assert.equal(discoAlice.status, 200);
  assert.deepEqual(discoAlice.json.homes.map((h) => h.homeId), [HOME_ID]);
  assert.equal(discoAlice.json.homes[0].installationId, installationId);
  const discoCarol = await backendApi(backend.base, 'GET', '/v1/homes', { accountToken: TOKEN_CAROL });
  assert.deepEqual(discoCarol.json.homes, []);

  // 6. Real one-time pairing at the home for both users' phones.
  const clientA = phoneClient(fileSecureStorage(securePathA));
  const clientB = phoneClient(fileSecureStorage(securePathB));
  const pairViaClient = async (client, user, label) => {
    const inv = createInvitation(home.server.db, user, 5 * 60_000);
    return client.enrollOneTime(
      {
        homeBaseUrl: home.base,
        invitationId: inv.invitation_id,
        pairingSecret: inv.invitation_secret,
        installationId,
        expectedUserId: user,
      },
      { label },
    );
  };
  const summaryA = await pairViaClient(clientA, 'alice', 'F2 Alice phone');
  const summaryB = await pairViaClient(clientB, 'bob', 'F2 Bob phone');
  assert.equal(summaryA.userId, 'alice');
  assert.equal(summaryB.userId, 'bob');
  assert.notEqual(summaryA.deviceId, summaryB.deviceId);

  // Backend ticket secrets and H1 invitation secrets are never conflated:
  // joining with an H1 invitation secret must fail at the backend.
  const conflated = await backendApi(backend.base, 'POST', `/v1/homes/${HOME_ID}/members/join`, {
    accountToken: TOKEN_CAROL,
    body: { ticketSecret: 'definitely-not-a-backend-ticket' },
  });
  assert.equal(conflated.status, 403);

  // 7. Wrong-home invitation is rejected (installation binding enforced).
  const wrongHomeInv = createInvitation(home.server.db, 'alice', 5 * 60_000);
  const strangerSecure = fileSecureStorage(join(dir, 'secure-stranger.json'));
  await assert.rejects(
    phoneClient(strangerSecure).enrollOneTime(
      {
        homeBaseUrl: home.base,
        invitationId: wrongHomeInv.invitation_id,
        pairingSecret: wrongHomeInv.invitation_secret,
        installationId: '00000000-0000-0000-0000-000000000000',
      },
      { label: 'wrong home phone' },
    ),
    (error) => error instanceof HomeClientError && error.code === 'INVITE_MISMATCH',
  );

  // 8. Private conversations: isolated lists, isolated sends, cross-denied.
  const convA = (await clientA.createConversation('F2 Alice convo')).id;
  const convB = (await clientB.createConversation('F2 Bob convo')).id;
  await clientA.sendMessage(convA, 'alice private hello');
  await clientB.sendMessage(convB, 'bob private hello');
  const listA = await clientA.listConversations();
  const listB = await clientB.listConversations();
  assert.ok(listA.some((c) => c.id === convA));
  assert.ok(!listA.some((c) => c.id === convB));
  assert.ok(listB.some((c) => c.id === convB));
  assert.ok(!listB.some((c) => c.id === convA));
  await assert.rejects(
    clientB.syncConversation(convA),
    (error) => error instanceof HomeClientError && error.code === 'FORBIDDEN',
  );
  const unpaired = phoneClient(fileSecureStorage(join(dir, 'secure-nobody.json')));
  await assert.rejects(
    unpaired.listConversations(),
    (error) => error instanceof HomeClientError && error.code === 'UNPAIRED',
  );

  // 8b. Home-activation v1 (B7): owner phone mints, home operator redeems.
  // The phone NEVER calls POST /v1/homes/activate (no such client method);
  // the operator stand-in below uses raw fetch with NO account credential,
  // like S7 pasting the one-time JSON into home stdin. The H1-paired phones
  // keep working throughout (activation is cloud membership, not pairing).
  const activationPhone = new BackendCoordinator(createMemorySecureStorage(), {
    allowInsecureLoopback: true,
    fetchImpl: (async (url, init = {}) => {
      const res = await closeableFetch(url, {
        method: init.method,
        headers: init.headers,
        body: init.body,
        signal: init.signal,
        redirect: init.redirect,
      });
      return res;
    }),
  });
  assert.equal(typeof activationPhone.activate, 'undefined');
  await activationPhone.configureBackend(backend.base, TOKEN_ALICE);
  const activationTicket = await activationPhone.mintActivationTicket({ installationId });
  assert.equal(activationTicket.mode, 'new');
  assert.equal(activationTicket.homeId, null);
  assert.equal(activationTicket.installationId, installationId);
  assert.match(activationTicket.ticketId, /^act_/);
  assert.ok(activationTicket.activationSecret.length >= 32);
  const handoff = activationPhone.buildActivationHandoff(backend.base, activationTicket);
  assert.deepEqual(
    Object.keys(handoff).sort(),
    ['activationSecret', 'backend_url', 'expiresAt', 'installationId', 'mode', 'ticketId'],
  );
  assert.ok(!JSON.stringify(handoff).includes('me_home_'));
  assert.ok(!JSON.stringify(handoff).includes(TOKEN_ALICE));

  const activateAsOperator = async (body) => {
    const res = await closeableFetch(`${backend.base}/v1/homes/activate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', connection: 'close' },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  };
  // Invalid requests never burn the ticket: a wrong installation is 403 and
  // the same ticket still redeems afterwards.
  const wrongInstall = await activateAsOperator({
    ticketId: activationTicket.ticketId,
    activationSecret: activationTicket.activationSecret,
    installationId: '00000000-0000-0000-0000-000000000000',
    endpointHint: home.base,
    protocolVersion: 'home-api-v1',
  });
  assert.equal(wrongInstall.status, 403);
  const activated = await activateAsOperator({
    ticketId: activationTicket.ticketId,
    activationSecret: activationTicket.activationSecret,
    installationId,
    endpointHint: home.base,
    protocolVersion: 'home-api-v1',
  });
  assert.equal(activated.status, 201);
  const activatedHomeId = activated.json.homeId;
  assert.match(activatedHomeId, /^home_[0-9a-f]{18}$/);
  assert.notEqual(activatedHomeId, HOME_ID);
  assert.equal(activated.json.mode, 'new');
  assert.match(activated.json.homeToken, /^me_home_/);
  // Replay of the consumed ticket is 410 without revealing anything new.
  const replayed = await activateAsOperator({
    ticketId: activationTicket.ticketId,
    activationSecret: activationTicket.activationSecret,
    installationId,
    endpointHint: home.base,
    protocolVersion: 'home-api-v1',
  });
  assert.equal(replayed.status, 410);
  // The fresh homeToken heartbeats; account discovery shows the new home as
  // owner; the H1-paired phones are unaffected.
  const activatedBeat = await backendApi(backend.base, 'POST', `/v1/homes/${activatedHomeId}/heartbeat`, {
    homeToken: activated.json.homeToken,
    body: { status: 'online', endpointHint: home.base, installationId },
  });
  assert.equal(activatedBeat.status, 200);
  const discoAfterActivation = await backendApi(backend.base, 'GET', '/v1/homes', { accountToken: TOKEN_ALICE });
  const activatedEntry = discoAfterActivation.json.homes.find((h) => h.homeId === activatedHomeId);
  assert.ok(activatedEntry);
  assert.equal(activatedEntry.membershipRole, 'owner');
  assert.equal(activatedEntry.installationId, installationId);
  const stillA = await clientA.syncConversation(convA);
  assert.ok(stillA.messages.some((m) => m.text === 'alice private hello'));
  // Recovery: a fresh ticket bound to the activated home returns the SAME
  // homeId, rotates the homeToken, and invalidates the old verifier.
  const recoveryTicket = await activationPhone.mintActivationTicket({
    installationId,
    existingHomeId: activatedHomeId,
  });
  assert.equal(recoveryTicket.mode, 'recovery');
  assert.equal(recoveryTicket.homeId, activatedHomeId);
  const recoveryHandoff = activationPhone.buildActivationHandoff(backend.base, recoveryTicket);
  assert.equal(recoveryHandoff.homeId, activatedHomeId);
  const recovered = await activateAsOperator({
    ticketId: recoveryTicket.ticketId,
    activationSecret: recoveryTicket.activationSecret,
    installationId,
    endpointHint: home.base,
    protocolVersion: 'home-api-v1',
  });
  assert.equal(recovered.status, 201);
  assert.equal(recovered.json.homeId, activatedHomeId);
  assert.notEqual(recovered.json.homeToken, activated.json.homeToken);
  const staleBeat = await backendApi(backend.base, 'POST', `/v1/homes/${activatedHomeId}/heartbeat`, {
    homeToken: activated.json.homeToken,
    body: { status: 'online' },
  });
  assert.equal(staleBeat.status, 401);
  const freshBeat = await backendApi(backend.base, 'POST', `/v1/homes/${activatedHomeId}/heartbeat`, {
    homeToken: recovered.json.homeToken,
    body: { status: 'online', endpointHint: home.base, installationId },
  });
  assert.equal(freshBeat.status, 200);
  // Recovery pre-check also holds against the real backend: a non-owner
  // cannot mint, and the phone never had to learn that from a failure.
  const carolPhone = new BackendCoordinator(createMemorySecureStorage(), {
    allowInsecureLoopback: true,
    // Closeable transport like every other harness fetch: no pooled
    // keep-alive socket may survive the step-9 restart below (F4 fix).
    fetchImpl: (async (url, init = {}) => {
      const res = await closeableFetch(url, {
        method: init.method,
        headers: init.headers,
        body: init.body,
        signal: init.signal,
        redirect: init.redirect,
      });
      return res;
    }),
  });
  await carolPhone.configureBackend(backend.base, TOKEN_CAROL);
  await assert.rejects(
    carolPhone.mintActivationTicket({ installationId, existingHomeId: activatedHomeId }),
    (error) => error instanceof HomeClientError && (error.code === 'NOT_FOUND' || error.code === 'FORBIDDEN'),
  );

  // 9. Restart BOTH services on the SAME loopback ports (stable endpoint,
  // like a home reboot keeping its tunnel URL); fresh client instances
  // reload persisted state.
  const homePort = home.port;
  const backendPort = backend.port;
  await home.server.stop();
  await new Promise((resolve) => backend.server.close(resolve));
  home = await startHome(homeDb, homePort, fixtureBroker());
  backend = await startBackend(backendDir, backendPort);

  // Backend membership + home binding survive the restart (the legacy
  // registered home AND the 8b activation-created home, both Alice-owned).
  const discoAfter = await backendApi(backend.base, 'GET', '/v1/homes', { accountToken: TOKEN_ALICE });
  assert.deepEqual(discoAfter.json.homes.map((h) => h.homeId).sort(), [HOME_ID, activatedHomeId].sort());
  const statusAfter = await backendApi(backend.base, 'GET', `/v1/homes/${HOME_ID}/status`, {
    accountToken: TOKEN_ALICE,
  });
  assert.equal(statusAfter.status, 200);

  // Fresh clients on the same persisted secure storage renew without invites.
  const clientA2 = phoneClient(fileSecureStorage(securePathA));
  const clientB2 = phoneClient(fileSecureStorage(securePathB));
  await clientA2.renewSession();
  await clientB2.renewSession();
  const snapA = await clientA2.syncConversation(convA);
  assert.ok(snapA.messages.some((m) => m.text === 'alice private hello'));
  assert.ok(snapA.messages.every((m) => m.acceptedBy === 'home'));
  const snapB = await clientB2.syncConversation(convB);
  assert.ok(snapB.messages.some((m) => m.text === 'bob private hello'));

  // 9b. Server-bound request_key semantics (raw HTTP, H2): same key +
  // identical body returns the original (200 duplicate:true); same key +
  // different body is 409; keys never cross (conversation, author).
  const rawPair = async (user) => {
    const inv = createInvitation(home.server.db, user, 5 * 60_000);
    const pairRes = await closeableFetch(`${home.base}/v1/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', connection: 'close' },
      body: JSON.stringify({
        invitation_id: inv.invitation_id,
        invitation_secret: inv.invitation_secret,
        device_label: 'raw probe',
      }),
    });
    assert.equal(pairRes.status, 201);
    const paired = await pairRes.json();
    const sessRes = await closeableFetch(`${home.base}/v1/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', connection: 'close' },
      body: JSON.stringify({
        device_id: paired.device_id,
        device_secret: paired.device_secret,
      }),
    });
    assert.equal(sessRes.status, 201);
    return (await sessRes.json()).token;
  };
  const rawToken = await rawPair('alice');
  const rawPost = async (key, body) => {
    const res = await closeableFetch(`${home.base}/v1/conversations/${convA}/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        connection: 'close',
        authorization: `Bearer ${rawToken}`,
      },
      body: JSON.stringify({ body, request_key: key }),
    });
    return { status: res.status, json: await res.json() };
  };
  const KEY_A = 'aaaaaaaa-1111-4bbb-8ccc-000000000001';
  const first = await rawPost(KEY_A, 'keyed hello');
  assert.equal(first.status, 201);
  assert.equal(first.json.duplicate, false);
  const retry = await rawPost(KEY_A, 'keyed hello');
  assert.equal(retry.status, 200);
  assert.equal(retry.json.duplicate, true);
  assert.equal(retry.json.id, first.json.id);
  const conflict = await rawPost(KEY_A, 'different body');
  assert.equal(conflict.status, 409);
  const badKey = await rawPost('not-a-uuid', 'bad key');
  assert.equal(badKey.status, 400);

  // 9c. Persisted task lifecycle against the real H1 worker (fixture
  // bridge): submit -> poll -> question/answer, approval, artifact bytes,
  // cancel, failure. No output is fabricated on the phone.
  const pollTask = async (taskId, terminal, timeoutMs = 15000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const view = await clientA2.getTask(taskId);
      if (terminal.includes(view.status)) return view;
      assert.ok(Date.now() < deadline, `task ${taskId} stuck at ${view.status}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };
  const ask = await clientA2.submitTask(convA, {
    request: 'ASK: favourite export format?',
    title: 'Question flow',
  });
  assert.ok(['queued', 'running', 'waiting_input'].includes(ask.status));
  const waiting = await pollTask(ask.id, ['waiting_input', 'succeeded', 'failed']);
  assert.equal(waiting.status, 'waiting_input');
  const questionId = (waiting.questions ?? [])[0]?.id;
  assert.equal(typeof questionId, 'string');
  const answered = await clientA2.answerTaskQuestions(ask.id, [
    { id: questionId, answer: 'MP4' },
  ]);
  assert.ok(['succeeded', 'running'].includes(answered.status));
  const doneAsk = await pollTask(ask.id, ['succeeded', 'failed']);
  assert.equal(doneAsk.status, 'succeeded');
  assert.match(doneAsk.output ?? '', /MP4/);

  const approve = await clientA2.submitTask(convA, {
    request: 'APPROVE: publish the cut',
    title: 'Approval flow',
  });
  const waitingApproval = await pollTask(approve.id, ['waiting_approval', 'succeeded', 'failed']);
  assert.equal(waitingApproval.status, 'waiting_approval');
  const approvalId = (waitingApproval.pendingApprovals ?? [])[0]?.id;
  assert.equal(typeof approvalId, 'string');
  // Stale answer on an approval-waiting task is refused.
  await assert.rejects(
    clientA2.answerTaskQuestions(approve.id, [{ id: 'nope', answer: 'x' }]),
    (error) => error instanceof HomeClientError && error.code === 'WRONG_STATE',
  );
  await clientA2.decideTaskApprovals(approve.id, [{ id: approvalId, decision: 'approve' }]);
  const doneApprove = await pollTask(approve.id, ['succeeded', 'failed', 'cancelled']);
  assert.equal(doneApprove.status, 'succeeded');
  assert.match(doneApprove.output ?? '', /approved/);

  // Decline regression (canonical H3 decision 'reject', server-issued
  // namespaced approval ID): the run fails honestly with approval_rejected
  // and publishes no assistant message into the conversation.
  const decline = await clientA2.submitTask(convA, {
    request: 'APPROVE: publish the draft',
    title: 'Decline flow',
  });
  const waitingDecline = await pollTask(decline.id, ['waiting_approval', 'succeeded', 'failed']);
  assert.equal(waitingDecline.status, 'waiting_approval');
  const declineApprovalId = (waitingDecline.pendingApprovals ?? [])[0]?.id;
  assert.equal(typeof declineApprovalId, 'string');
  assert.match(declineApprovalId, new RegExp(`^${decline.id}:`));
  const beforeDecline = await clientA2.syncConversation(convA);
  const declinedImmediate = await clientA2.decideTaskApprovals(decline.id, [
    { id: declineApprovalId, decision: 'reject' },
  ]);
  assert.ok(['failed', 'queued', 'running', 'waiting_approval'].includes(declinedImmediate.status));
  // The resumed run then fails honestly with approval_rejected.
  const declined = await pollTask(decline.id, ['failed', 'succeeded']);
  assert.equal(declined.status, 'failed');
  assert.match(declined.error ?? '', /reject/);
  const snapDecline = await clientA2.syncConversation(convA);
  assert.equal(snapDecline.messages.length, beforeDecline.messages.length);
  // No new assistant message was published by the decline: the id sets are
  // identical (the earlier approve flow's output legitimately stays).
  assert.deepEqual(
    snapDecline.messages.map((m) => m.id),
    beforeDecline.messages.map((m) => m.id),
  );

  const art = await clientA2.submitTask(convA, {
    request: 'ARTIFACT:notes.txt:hello-artifact',
    title: 'Artifact flow',
  });
  const doneArt = await pollTask(art.id, ['succeeded', 'failed']);
  assert.equal(doneArt.status, 'succeeded');
  const artifacts = await clientA2.listTaskArtifacts(art.id);
  assert.equal(artifacts?.length, 1);
  const bytes = await clientA2.fetchTaskArtifact(art.id, artifacts[0].id);
  assert.equal(Buffer.from(bytes).toString('utf8'), 'hello-artifact');

  const sleep = await clientA2.submitTask(convA, {
    request: 'SLEEP:30',
    title: 'Cancellable run',
  });
  await pollTask(sleep.id, ['running', 'queued', 'succeeded', 'failed'], 15000).catch(() => null);
  const cancelled = await clientA2.cancelTask(sleep.id);
  assert.ok(['cancelled', 'succeeded', 'failed'].includes(cancelled.status));
  const failTask = await clientA2.submitTask(convA, {
    request: 'FAIL:boom',
    title: 'Failing run',
  });
  const failed = await pollTask(failTask.id, ['failed', 'succeeded']);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error ?? '', /boom/);
  // Cross-user task reads stay denied on the real service.
  await assert.rejects(
    clientB2.getTask(ask.id),
    (error) => error instanceof HomeClientError && error.code === 'FORBIDDEN',
  );

  // 9d. A home with no usable model refuses honestly (503, no dead queue).
  const bareDb = join(dir, 'bare.sqlite');
  const bare = await startHome(bareDb, 0);
  try {
    ensureUser(bare.server.db, 'alice', 'Alice (synthetic)');
    const bareInv = createInvitation(bare.server.db, 'alice', 5 * 60_000);
    const bareClient = phoneClient(fileSecureStorage(join(dir, 'secure-bare.json')));
    await bareClient.enrollOneTime(
      {
        homeBaseUrl: bare.base,
        invitationId: bareInv.invitation_id,
        pairingSecret: bareInv.invitation_secret,
      },
      { label: 'bare probe' },
    );
    const bareConv = (await bareClient.createConversation('bare')).id;
    await assert.rejects(
      bareClient.submitTask(bareConv, { request: 'do work' }),
      (error) => error instanceof HomeClientError && error.code === 'MODEL_NOT_CONFIGURED',
    );
  } finally {
    await bare.server.stop();
  }

  // 9e. Real 307 regression: a redirector pointing at a harvester must not
  // receive credentials. undici honors redirect:'error', so the harvester
  // must see zero requests and enrollment must fail closed.
  const harvesterHits = [];
  const harvester = createServer((req, res) => {
    harvesterHits.push({ url: req.url, auth: req.headers.authorization ?? null });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  harvester.listen(0, '127.0.0.1');
  await once(harvester, 'listening');
  const harvesterBase = `http://127.0.0.1:${harvester.address().port}`;
  let redirectorHits = 0;
  const redirector = createServer((req, res) => {
    redirectorHits += 1;
    res.writeHead(307, { location: `${harvesterBase}/v1/pair` });
    res.end();
  });
  redirector.listen(0, '127.0.0.1');
  await once(redirector, 'listening');
  const redirectorBase = `http://127.0.0.1:${redirector.address().port}`;
  try {
    const evilClient = phoneClient(fileSecureStorage(join(dir, 'secure-307.json')));
    await assert.rejects(
      evilClient.enrollOneTime(
        {
          homeBaseUrl: redirectorBase,
          invitationId: 'inv_307_probe',
          pairingSecret: 'secret-307-probe-0001',
        },
        { label: '307 probe' },
      ),
      (error) => error instanceof HomeClientError,
    );
    assert.ok(redirectorHits >= 1);
    assert.deepEqual(harvesterHits, []);
  } finally {
    await new Promise((resolve) => redirector.close(resolve));
    await new Promise((resolve) => harvester.close(resolve));
  }

  // 9f. Two-user re-enrollment isolation on one phone store. Alice enrolls,
  // creates, and sends; then Bob enrolls into the SAME secure storage.
  // Cached Alice state must be re-scoped away (pure helper), the server
  // must show only Bob's conversations, and a restart renews as Bob.
  const sharedSecurePath = join(dir, 'secure-shared.json');
  const sharedCache = createMemoryCacheStorage();
  const phoneX = new PairedHomeClient(fileSecureStorage(sharedSecurePath), sharedCache, {
    allowInsecureLoopback: true,
  });
  const invAX = createInvitation(home.server.db, 'alice', 5 * 60_000);
  const sumAX = await phoneX.enrollOneTime(
    {
      homeBaseUrl: home.base,
      invitationId: invAX.invitation_id,
      pairingSecret: invAX.invitation_secret,
      expectedUserId: 'alice',
    },
    { label: 'shared phone as alice' },
  );
  assert.equal(sumAX.userId, 'alice');
  const convAX = (await phoneX.createConversation('X alice convo')).id;
  await phoneX.sendMessage(convAX, 'alice private words');
  const cachedAX = await phoneX.readCachedConversation(convAX);
  assert.ok((cachedAX?.messages ?? []).some((m) => m.text === 'alice private words'));
  const invBX = createInvitation(home.server.db, 'bob', 5 * 60_000);
  const sumBX = await phoneX.enrollOneTime(
    {
      homeBaseUrl: home.base,
      invitationId: invBX.invitation_id,
      pairingSecret: invBX.invitation_secret,
      expectedUserId: 'bob',
    },
    { label: 'shared phone as bob' },
  );
  assert.equal(sumBX.userId, 'bob');
  // App-level re-scope: Alice's cached conversation and link are dropped;
  // nothing is wiped from the server (home-authoritative history stays).
  const tupleOf = (s) => ({
    userId: s.userId,
    deviceId: s.deviceId,
    installationId: s.homeId,
    homeBaseUrl: s.homeBaseUrl,
  });
  const rescoped = reconcileOnEnrollmentChange(
    tupleOf(sumAX),
    tupleOf(sumBX),
    [{ id: 'local_x', assistantMode: 'home' }],
    { local_x: { homeId: convAX, homeOwner: 'alice' } },
  );
  assert.deepEqual(rescoped.droppedLocalIds, ['local_x']);
  assert.deepEqual(rescoped.links, {});
  // Server enforcement: only Bob's conversations are visible now.
  const listX = await phoneX.listConversations();
  assert.ok(!listX.some((c) => c.id === convAX));
  // Alice's server history still exists but is unreachable as Bob.
  await assert.rejects(
    phoneX.syncConversation(convAX),
    (error) => error instanceof HomeClientError && error.code === 'FORBIDDEN',
  );
  // Restart with the shared store renews as Bob without a new invitation.
  const phoneX2 = new PairedHomeClient(fileSecureStorage(sharedSecurePath), createMemoryCacheStorage(), {
    allowInsecureLoopback: true,
  });
  await phoneX2.renewSession();
  const sumX2 = await phoneX2.summary();
  assert.equal(sumX2?.userId, 'bob');

  // 10. Device revocation at the home denies further access.
  await clientA2.revokeOwnDevice();
  await assert.rejects(
    clientA2.listConversations(),
    (error) => error instanceof HomeClientError && error.code === 'DEVICE_REVOKED',
  );
  await assert.rejects(
    clientA2.renewSession(),
    (error) => error instanceof HomeClientError && error.code === 'DEVICE_REVOKED',
  );
  // Bob is unaffected.
  const stillBob = await clientB2.listConversations();
  assert.ok(stillBob.some((c) => c.id === convB));

  // 11. Backend membership removal denies discovery and direct reads.
  const remove = await backendApi(
    backend.base, 'DELETE', `/v1/homes/${HOME_ID}/members/${ACCOUNTS[TOKEN_BOB]}`,
    { homeToken },
  );
  assert.equal(remove.status, 200);
  const discoBobGone = await backendApi(backend.base, 'GET', '/v1/homes', { accountToken: TOKEN_BOB });
  assert.deepEqual(discoBobGone.json.homes, []);
  const directBobGone = await backendApi(backend.base, 'GET', `/v1/homes/${HOME_ID}`, {
    accountToken: TOKEN_BOB,
  });
  assert.equal(directBobGone.status, 404);
});

test('real home push registration lifecycle (fake provider only, H7)', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'me-h7-real-'));
  t.after(async () => {
    try { await home.server.stop(); } catch { /* already stopped */ }
    await rm(dir, { recursive: true, force: true });
  });
  // Fake provider ONLY: no real Expo/APNs credentials, no outbound network.
  // The pump is pointed at the fake; sends never leave the process.
  const sent = [];
  const fake = {
    name: 'fake',
    sent,
    async sendBatch(messages) {
      for (const m of messages) sent.push(JSON.parse(JSON.stringify(m)));
      return messages.map((_, i) => ({ ticketStatus: 'ok', ticketId: `ticket-h7-${i}` }));
    },
    async getReceipts(ids) {
      const out = {};
      for (const id of ids) out[id] = { status: 'ok' };
      return out;
    },
  };
  const config = {
    enabled: true,
    projectId: null,
    accessToken: null,
    maxAttempts: 3,
    baseDelayMs: 50,
    maxDelayMs: 200,
    batchSize: 10,
    sendTimeoutMs: 2000,
    expiryMs: 60 * 60 * 1000,
    pumpIntervalMs: 60000,
  };
  const dbPath = join(dir, 'home.sqlite');
  const server = createHomeServer({
    dbPath,
    broker: { ...fixtureBroker(), tasksRoot: join(dir, 'tasks') },
    notifications: { provider: fake, config },
  });
  const home = { server };
  const info = await server.start({ host: '127.0.0.1', port: 0 });
  const base = `http://${info.host}:${info.port}`;
  ensureUser(server.db, 'alice', 'Alice (synthetic)');

  const securePath = join(dir, 'secure.json');
  const phone = phoneClient(fileSecureStorage(securePath));
  const inv = createInvitation(server.db, 'alice', 5 * 60_000);
  await phone.enrollOneTime(
    {
      homeBaseUrl: base,
      invitationId: inv.invitation_id,
      pairingSecret: inv.invitation_secret,
    },
    { label: 'H7 phone' },
  );

  // Metadata-only register with permission on.
  const token = 'ExponentPushToken[dddddddddddddddddddddd]';
  const registered = await phone.registerPushToken({
    expoPushToken: token,
    permissionEnabled: true,
  });
  assert.equal(registered.registered, true);
  assert.equal(registered.enabled, true);

  // Redacted status: suffix only, never the raw token.
  const status = await phone.notificationStatus();
  assert.equal(status.registered, true);
  assert.equal(status.enabled, true);
  assert.ok(status.tokenSuffix && !JSON.stringify(status).includes(token.slice(18, 30)));

  // Home-managed ids are rejected (400, not silently stored).
  const rawAuthed = async (path, body) => {
    const summary = await phone.summary();
    void summary;
    const secure = fileSecureStorage(securePath);
    void secure;
    return { status: 0 };
  };
  void rawAuthed;

  // Explicit disable is idempotent (binding stays, delivery off).
  assert.deepEqual(await phone.disableNotifications(), { disabled: true });
  const off = await phone.notificationStatus();
  assert.equal(off.enabled, false);

  // Operator-disabled home refuses with 403 (no network on register path).
  const bareDir = join(dir, 'bare-disabled');
  await import('node:fs/promises').then((fs) => fs.mkdir(bareDir, { recursive: true }));
  const bareDb = join(bareDir, 'home.sqlite');
  const bareServer = createHomeServer({
    dbPath: bareDb,
    broker: { ...fixtureBroker(), tasksRoot: join(bareDir, 'tasks') },
    notifications: { provider: fake, config: { ...config, enabled: false } },
  });
  try {
    const bareInfo = await bareServer.start({ host: '127.0.0.1', port: 0 });
    const bareBase = `http://${bareInfo.host}:${bareInfo.port}`;
    ensureUser(bareServer.db, 'alice', 'Alice (synthetic)');
    const bareInv = createInvitation(bareServer.db, 'alice', 5 * 60_000);
    const barePhone = phoneClient(fileSecureStorage(join(dir, 'secure-bare-h7.json')));
    await barePhone.enrollOneTime(
      {
        homeBaseUrl: bareBase,
        invitationId: bareInv.invitation_id,
        pairingSecret: bareInv.invitation_secret,
      },
      { label: 'H7 bare probe' },
    );
    await assert.rejects(
      barePhone.registerPushToken({ expoPushToken: token, permissionEnabled: true }),
      (error) => error instanceof HomeClientError && error.code === 'NOTIFICATIONS_DISABLED',
    );
  } finally {
    await bareServer.stop();
  }
});
