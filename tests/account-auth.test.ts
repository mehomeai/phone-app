// Native OIDC account sign-in (account-auth-v1, F7) portable contract tests.
// Run: npm test
// No real IdP, no browser, no native modules: the maintained Expo SDK is
// injected as a fake (code exchange / refresh), the backend as a stub fetch
// shaped exactly like B4's GET /v1/auth/config + GET /v1/account. One case
// ALSO verifies against the actual sibling B4 backend with a local JWKS when
// the sibling checkout is present (falls back to the identical stub shape in
// CI, where siblings are absent); native browser/IdP login stays a manual
// on-device check documented in docs/account-login.md.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
import {
  AccountAuthManager,
  accountIdentityChanged,
  buildLoginRequest,
  createMemorySecureStorage,
  createMemoryCacheStorage,
  isHostedReady,
  isTrustedIssuer,
  parseAuthConfig,
  selectRedirectUri,
  validateRedirectUri,
  AUTH_BUNDLE_KEY,
  BACKEND_ACCOUNT_TOKEN_KEY,
  reconcileOnEnrollmentChange,
  cacheLeaksSecrets,
} from '../src/index.ts';
import { HomeClientError } from '../src/errors.ts';

const ISSUER = 'https://issuer.example.test';
const AUDIENCE = 'me-backend-api';
const CLIENT_ID = 'me-mobile-public-client';
const REDIRECTS = ['me-mobile://auth/callback'];
const BACKEND = 'https://backend.example.test';

function hostedConfigRaw(overrides: Record<string, unknown> = {}) {
  return {
    protocol: 'account-auth-v1',
    authMode: 'hosted',
    issuer: ISSUER,
    audience: AUDIENCE,
    clientId: CLIENT_ID,
    scopes: ['openid', 'profile', 'email'],
    redirectUris: [...REDIRECTS],
    appScheme: 'me-mobile',
    ...overrides,
  };
}

function stubFetch(routes: Record<string, { status: number; body: unknown }>) {
  const seen: Array<{ url: string; redirect: unknown; auth: string | null }> = [];
  const impl = (async (input: string, init?: {
    method?: string;
    headers?: Record<string, string>;
    redirect?: 'error' | 'follow' | 'manual';
  }) => {
    const url = new URL(input);
    seen.push({
      url: input,
      redirect: init?.redirect,
      auth: init?.headers?.['Authorization'] ?? null,
    });
    const route = routes[url.pathname];
    if (!route) {
      return { status: 404, url: input, json: async () => ({}) };
    }
    return { status: route.status, url: input, json: async () => route.body };
  }) as unknown as typeof fetch;
  return { impl, seen };
}

function fakeSdk(tokens: Record<string, { accessToken: string; refreshToken?: string; expiresIn?: number }>) {
  return {
    async exchangeCode(code: string) {
      const found = tokens[code];
      if (!found) throw new Error('bad code');
      return found;
    },
    async refreshToken(refreshToken: string) {
      const found = Object.values(tokens).find((t) => t.refreshToken === refreshToken);
      if (!found) throw new Error('bad refresh');
      return found;
    },
  };
}

describe('account-auth contract (portable, PKCE code flow only)', () => {
  it('parses hosted config and builds an AuthorizationCode+PKCE request', () => {
    const config = parseAuthConfig(hostedConfigRaw());
    assert.equal(isHostedReady(config), true);
    if (!isHostedReady(config)) throw new Error('unreachable');
    assert.equal(config.clientId, CLIENT_ID);
    const redirect = selectRedirectUri(config.redirectUris, 'me-mobile');
    assert.equal(redirect, 'me-mobile://auth/callback');
    const request = buildLoginRequest(config, redirect);
    assert.equal(request.responseType, 'code');
    assert.equal(request.usePKCE, true);
    assert.equal(request.clientId, CLIENT_ID);
    assert.equal(request.redirectUri, redirect);
    assert.equal(request.extraParams['audience'], AUDIENCE);
    // No secrets, no password/ID-token fields anywhere in the request shape.
    assert.ok(!JSON.stringify(request).includes('secret'));
    assert.ok(!JSON.stringify(request).includes('password'));
    assert.ok(!JSON.stringify(request).toLowerCase().includes('id_token'));
  });

  it('rejects bad metadata, bad redirects, and untrusted issuers', () => {
    // 503 setup-not-ready shape parses to not-ready (no fake provider).
    const notReady = parseAuthConfig({
      protocol: 'account-auth-v1',
      authMode: 'hosted',
      error: 'configure_not_ready',
      message: 'operator action needed',
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    assert.equal(isHostedReady(notReady), false);
    // Missing public client id is not a login: fail closed.
    assert.throws(
      () => parseAuthConfig(hostedConfigRaw({ clientId: undefined })),
      (e: unknown) => e instanceof HomeClientError,
    );
    // clientId MUST differ from audience (no ID-token fallback).
    assert.throws(
      () => parseAuthConfig(hostedConfigRaw({ clientId: AUDIENCE })),
      (e: unknown) => e instanceof HomeClientError && e.code === 'CONTRACT_MISMATCH',
    );
    // Malformed redirects and wildcards are refused at shape level.
    assert.throws(
      () => validateRedirectUri('https://evil.invalid/*.cb'),
      (e: unknown) => e instanceof HomeClientError && e.code === 'INVALID_INPUT',
    );
    assert.throws(
      () => validateRedirectUri('https://user:pass@evil.invalid/cb'),
      (e: unknown) => e instanceof HomeClientError && e.code === 'INVALID_INPUT',
    );
    assert.throws(
      () => selectRedirectUri(['other-app://auth/callback'], 'me-mobile'),
      (e: unknown) => e instanceof HomeClientError && e.code === 'INVALID_INPUT',
    );
    const config = parseAuthConfig(hostedConfigRaw());
    if (!isHostedReady(config)) throw new Error('unreachable');
    assert.throws(
      () => buildLoginRequest(config, 'https://evil.invalid/cb'),
      (e: unknown) => e instanceof HomeClientError && e.code === 'INVALID_INPUT',
    );
    // Issuer trust: https only; loopback http only with the explicit flag.
    assert.equal(isTrustedIssuer(ISSUER), true);
    assert.equal(isTrustedIssuer('http://127.0.0.1:9999'), false);
    assert.equal(isTrustedIssuer('http://127.0.0.1:9999', true), true);
    assert.equal(isTrustedIssuer('http://evil.invalid'), false);
    assert.equal(isTrustedIssuer('http://evil.invalid', true), false);
  });

  it('verifies the access token before persisting; 401 never signs in', async () => {
    const secure = createMemorySecureStorage();
    const { impl, seen } = stubFetch({
      '/v1/account': {
        status: 401,
        body: { error: 'Account authorization required.' },
      },
    });
    const manager = new AccountAuthManager(secure, { fetchImpl: impl as unknown as typeof fetch });
    await assert.rejects(
      manager.verifyAccount(BACKEND, 'bad-token'),
      (e: unknown) => e instanceof HomeClientError && e.code === 'UNPAIRED',
    );
    assert.equal(await secure.getItem(AUTH_BUNDLE_KEY), null);
    assert.equal(await secure.getItem(BACKEND_ACCOUNT_TOKEN_KEY), null);
    // Credential-bearing fetch uses redirect:error + same-origin guard.
    assert.ok(seen.length >= 1);
    for (const call of seen) assert.equal(call.redirect, 'error');
  });

  it('commits only ACCESS tokens after verification; empty/ID-only fails', async () => {
    const secure = createMemorySecureStorage();
    const { impl } = stubFetch({
      '/v1/auth/config': { status: 200, body: hostedConfigRaw() },
      '/v1/account': {
        status: 200,
        body: { protocol: 'account-auth-v1', authMode: 'hosted', accountId: 'acct_abc', issuer: ISSUER },
      },
    });
    const manager = new AccountAuthManager(secure, { fetchImpl: impl as unknown as typeof fetch });
    const config = parseAuthConfig(hostedConfigRaw());
    if (!isHostedReady(config)) throw new Error('unreachable');
    const gen = manager.beginLogin();
    // Empty access token (e.g. ID-token-only response) never persists.
    await assert.rejects(
      manager.verifyAndCommit(BACKEND, { accessToken: '' }, config, gen),
      (e: unknown) => e instanceof HomeClientError && e.code === 'AUTH_FAILED',
    );
    assert.equal(await secure.getItem(AUTH_BUNDLE_KEY), null);
    // Verified access token persists to SecureStore only + coordinator mirror.
    const { committed, account } = await manager.verifyAndCommit(
      BACKEND,
      { accessToken: 'idp-access-1', refreshToken: 'idp-refresh-1', expiresIn: 3600 },
      config,
      gen,
    );
    assert.equal(committed, true);
    assert.equal(account.accountId, 'acct_abc');
    const bundleRaw = await secure.getItem(AUTH_BUNDLE_KEY);
    assert.ok(bundleRaw && bundleRaw.includes('acct_abc'));
    assert.equal(await secure.getItem(BACKEND_ACCOUNT_TOKEN_KEY), 'idp-access-1');
  });

  it('late callbacks after logout or backend change never resurrect', async () => {
    const secure = createMemorySecureStorage();
    const { impl } = stubFetch({
      '/v1/account': {
        status: 200,
        body: { protocol: 'account-auth-v1', authMode: 'hosted', accountId: 'acct_abc', issuer: ISSUER },
      },
    });
    const manager = new AccountAuthManager(secure, { fetchImpl: impl as unknown as typeof fetch });
    const config = parseAuthConfig(hostedConfigRaw());
    if (!isHostedReady(config)) throw new Error('unreachable');
    const gen = manager.beginLogin();
    await manager.logout();
    const late = await manager.verifyAndCommit(BACKEND, { accessToken: 'late-token' }, config, gen);
    assert.equal(late.committed, false);
    assert.equal(await secure.getItem(AUTH_BUNDLE_KEY), null);
    // Backend URL change also fences in-flight logins.
    const gen2 = manager.beginLogin();
    await manager.commitVerifiedBundle(
      {
        accessToken: 't', accountId: 'acct_abc', issuer: ISSUER,
        audience: AUDIENCE, backendUrl: BACKEND, verifiedAt: Date.now(),
      },
      gen2,
    );
    const changed = await manager.noteBackendUrlChanged('https://other-backend.example.test');
    assert.equal(changed, true);
    assert.equal(await secure.getItem(AUTH_BUNDLE_KEY), null);
  });

  it('refresh rotates then re-verifies; identity mismatch fails closed', async () => {
    const secure = createMemorySecureStorage();
    const accountFor: Record<string, { accountId: string }> = {
      'access-old': { accountId: 'acct_abc' },
      'access-new': { accountId: 'acct_abc' },
    };
    const { impl } = stubFetch({
      '/v1/account': { status: 200, body: {} },
    });
    void impl;
    const verifyingFetch = (async (input: string, init?: { headers?: Record<string, string>; redirect?: string }) => {
      const token = (init?.headers?.['Authorization'] ?? '').replace('Bearer ', '');
      const found = accountFor[token];
      if (!found) return { status: 401, url: input, json: async () => ({}) };
      return {
        status: 200, url: input,
        json: async () => ({ protocol: 'account-auth-v1', authMode: 'hosted', accountId: found.accountId, issuer: ISSUER }),
      };
    }) as unknown as typeof fetch;
    const manager = new AccountAuthManager(secure, { fetchImpl: verifyingFetch });
    const config = parseAuthConfig(hostedConfigRaw());
    if (!isHostedReady(config)) throw new Error('unreachable');
    const gen = manager.beginLogin();
    await manager.commitVerifiedBundle(
      {
        accessToken: 'access-old', refreshToken: 'refresh-1', expiresAt: Date.now() - 1000,
        accountId: 'acct_abc', issuer: ISSUER, audience: AUDIENCE, backendUrl: BACKEND, verifiedAt: Date.now() - 10_000,
      },
      gen,
    );
    // Rotation with the same identity commits the new access token.
    const sdk = fakeSdk({ new: { accessToken: 'access-new', refreshToken: 'refresh-1', expiresIn: 3600 } });
    const rotated = await manager.refreshIfNeeded(
      { exchangeCode: async () => { throw new Error('unused'); }, refreshToken: () => sdk.refreshToken('refresh-1') },
      config,
      { tokenEndpoint: 'https://issuer.example.test/token' },
    );
    assert.equal(rotated?.accessToken, 'access-new');
    // A refresh that verifies as a DIFFERENT account fails closed (cleared).
    accountFor['access-evil'] = { accountId: 'acct_evil' };
    const evilSdk = fakeSdk({ x: { accessToken: 'access-evil', refreshToken: 'refresh-1', expiresIn: 3600 } });
    const gen2 = manager.beginLogin();
    await manager.commitVerifiedBundle(
      {
        accessToken: 'access-old', refreshToken: 'refresh-1', expiresAt: Date.now() - 1000,
        accountId: 'acct_abc', issuer: ISSUER, audience: AUDIENCE, backendUrl: BACKEND, verifiedAt: Date.now(),
      },
      gen2,
    );
    await assert.rejects(
      manager.refreshIfNeeded(
        { exchangeCode: async () => { throw new Error('unused'); }, refreshToken: () => evilSdk.refreshToken('refresh-1') },
        config,
        { tokenEndpoint: 'https://issuer.example.test/token' },
      ),
      (e: unknown) => e instanceof HomeClientError && e.code === 'AUTH_FAILED',
    );
    assert.equal(await secure.getItem(AUTH_BUNDLE_KEY), null);
  });

  it('explicit logout works offline; refresh failures keep the home agent alive', async () => {
    const secure = createMemorySecureStorage();
    const offlineFetch = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const manager = new AccountAuthManager(secure, { fetchImpl: offlineFetch });
    const gen = manager.beginLogin();
    await manager.commitVerifiedBundle(
      {
        accessToken: 'stale-access', refreshToken: 'refresh-1', expiresAt: Date.now() - 1000,
        accountId: 'acct_abc', issuer: ISSUER, audience: AUDIENCE, backendUrl: BACKEND, verifiedAt: Date.now(),
      },
      gen,
    );
    // Refresh with no network keeps the old bundle (home agent unaffected).
    const kept = await manager.refreshIfNeeded(
      {
        exchangeCode: async () => { throw new Error('unused'); },
        refreshToken: async () => { throw new Error('network down'); },
      },
      parseAuthConfig(hostedConfigRaw()) as never,
      { tokenEndpoint: 'https://issuer.example.test/token' },
    );
    assert.equal(kept?.accessToken, 'stale-access');
    // Explicit logout clears locally even while offline.
    await manager.logout();
    assert.equal(await secure.getItem(AUTH_BUNDLE_KEY), null);
    assert.equal(await secure.getItem(BACKEND_ACCOUNT_TOKEN_KEY), null);
  });

  it('account change drops the old home cache via F4 fences (server history untouched)', () => {
    assert.equal(
      accountIdentityChanged(
        { accountId: 'acct_alice', issuer: ISSUER, backendUrl: BACKEND },
        { accountId: 'acct_alice', issuer: ISSUER, backendUrl: BACKEND },
      ),
      false,
    );
    assert.equal(
      accountIdentityChanged(
        { accountId: 'acct_alice', issuer: ISSUER, backendUrl: BACKEND },
        { accountId: 'acct_bob', issuer: ISSUER, backendUrl: BACKEND },
      ),
      true,
    );
    // Full-scope re-scope drops Bob-visible home rows when Alice takes over.
    const rescoped = reconcileOnEnrollmentChange(
      { userId: 'alice', deviceId: 'd1', installationId: 'i1', homeBaseUrl: 'https://home.invalid' },
      { userId: 'bob', deviceId: 'd1', installationId: 'i1', homeBaseUrl: 'https://home.invalid' },
      [{ id: 'local_1', assistantMode: 'home' as const }],
      { local_1: { homeId: 'convA', homeOwner: 'alice' } },
    );
    assert.deepEqual(rescoped.droppedLocalIds, ['local_1']);
    assert.deepEqual(rescoped.links, {});
  });

  it('auth bundle never leaks into the message cache', async () => {
    const secure = createMemorySecureStorage();
    const cache = createMemoryCacheStorage();
    const manager = new AccountAuthManager(secure);
    const gen = manager.beginLogin();
    await manager.commitVerifiedBundle(
      {
        accessToken: 'secret-access-0123456789', refreshToken: 'secret-refresh-0123456789',
        expiresAt: null, accountId: 'acct_abc', issuer: ISSUER,
        audience: AUDIENCE, backendUrl: BACKEND, verifiedAt: Date.now(),
      },
      gen,
    );
    await cache.setItem('me.home.cache.v1.conv1', JSON.stringify({ messages: ['hello'] }));
    const cached = (await cache.getItem('me.home.cache.v1.conv1')) ?? '';
    assert.equal(
      cacheLeaksSecrets(cached, ['secret-access-0123456789', 'secret-refresh-0123456789']),
      false,
    );
    const bundleRaw = (await secure.getItem(AUTH_BUNDLE_KEY)) ?? '';
    assert.ok(bundleRaw.includes('secret-access-0123456789'));
  });

  it('B4 local-JWKS backend flow verifies (real sibling when present, stub otherwise)', async (t) => {
    const serverPath = join(HERE, '..', '..', 'backend-server', 'src', 'server.mjs');
    const josePath = join(HERE, '..', '..', 'backend-server', 'node_modules', 'jose');
    if (!existsSync(serverPath) || !existsSync(josePath)) {
      // CI has no sibling checkouts: assert the identical contract shape
      // against a stub so the manager path is still verified.
      t.diagnostic('sibling backend-server absent; verifying stub B4 shape');
      const secure = createMemorySecureStorage();
      const { impl } = stubFetch({
        '/v1/auth/config': { status: 200, body: hostedConfigRaw() },
        '/v1/account': {
          status: 200,
          body: { protocol: 'account-auth-v1', authMode: 'hosted', accountId: 'acct_stub', issuer: ISSUER },
        },
      });
      const manager = new AccountAuthManager(secure, { fetchImpl: impl as unknown as typeof fetch });
      const config = await manager.fetchAuthConfig(BACKEND);
      assert.equal(isHostedReady(config), true);
      const account = await manager.verifyAccount(BACKEND, 'stub-access');
      assert.equal(account.accountId, 'acct_stub');
      return;
    }
    const dir = await mkdtemp(join(tmpdir(), 'me-f7-jwks-'));
    t.after(async () => {
      await rm(dir, { recursive: true, force: true });
    });
    const { generateKeyPairSync, createPublicKey } = await import('node:crypto');
    const { createServer } = await import('node:http');
    const { once } = await import('node:events');
    const { createBackend } = await import(pathToFileURL(serverPath).href);
    const jose = await import(pathToFileURL(join(josePath, 'dist', 'webapi', 'index.js')).href);
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const publicKey = createPublicKey(privateKey);
    const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
    const kid = 'f7-test-key-1';
    const publicJwk = { ...jwk, kid, alg: 'RS256', use: 'sig' };
    const privateJwk = (privateKey.export({ format: 'jwk' }) as Record<string, unknown>);
    const backend = createBackend({
      host: '127.0.0.1',
      port: 0,
      dataDir: dir,
      authMode: 'hosted',
      oidc: {
        issuer: ISSUER,
        audience: AUDIENCE,
        jwks: { keys: [publicJwk] },
        algorithms: ['RS256'],
        insecureIssuerAllowed: false,
        clientId: CLIENT_ID,
        scopes: ['openid', 'profile', 'email'],
        redirectUris: [...REDIRECTS],
        appScheme: 'me-mobile',
        extraAudiences: [],
        expectedTokenUse: null,
      },
    });
    const server = createServer(backend.handler);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    try {
      const secure = createMemorySecureStorage();
      const manager = new AccountAuthManager(secure, { allowInsecureLoopback: true });
      // Public metadata matches the B4 contract exactly.
      const config = await manager.fetchAuthConfig(base);
      assert.equal(isHostedReady(config), true);
      if (!isHostedReady(config)) throw new Error('unreachable');
      assert.equal(config.issuer, ISSUER);
      assert.equal(config.audience, AUDIENCE);
      assert.equal(config.clientId, CLIENT_ID);
      assert.deepEqual(config.redirectUris, REDIRECTS);
      // A real RS256 provider access token verifies; wrong audience does not.
      const key = await jose.importJWK({ ...privateJwk, kid, alg: 'RS256' } as never, 'RS256');
      const good = await new jose.SignJWT({ token_use: 'access' })
        .setProtectedHeader({ alg: 'RS256', kid })
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setSubject('sub-f7-user')
        .setExpirationTime('5m')
        .sign(key);
      const account = await manager.verifyAccount(base, good);
      assert.match(account.accountId, /^acct_[0-9a-f]{32}$/);
      assert.equal(account.issuer, ISSUER);
      const badAud = await new jose.SignJWT({})
        .setProtectedHeader({ alg: 'RS256', kid })
        .setIssuer(ISSUER)
        .setAudience('someone-else')
        .setSubject('sub-f7-user')
        .setExpirationTime('5m')
        .sign(key);
      await assert.rejects(
        manager.verifyAccount(base, badAud),
        (e: unknown) => e instanceof HomeClientError && e.code === 'UNPAIRED',
      );
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
