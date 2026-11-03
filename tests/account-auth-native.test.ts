// Native OIDC adapter tests (F7 review hardening): exercise the REAL
// apps/mobile bridge (prompt + PKCE exchange + guarded transport), not just
// the portable manager. The maintained SDK is injected as a fake surface;
// the backend as stub fetch shaped like B4. Run: npm test

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AccountAuthManager,
  createMemorySecureStorage,
  parseAuthConfig,
  isHostedReady,
} from '../src/index.ts';
import { HomeClientError } from '../src/errors.ts';
import {
  beginAuthorizationAttempt,
  fetchTrustedDiscovery,
  refreshTokensNative,
  revokeTokensNative,
} from '../apps/mobile/lib/account-auth.ts';
import type { HostedAuthConfig } from '../apps/mobile/lib/account-auth.ts';

const ISSUER = 'https://issuer.example.test';
const AUDIENCE = 'me-backend-api';
const CLIENT_ID = 'me-mobile-public-client';
const REDIRECT = 'me-mobile://auth/callback';
const BACKEND = 'https://backend.example.test';

function hostedConfig(): HostedAuthConfig {
  const parsed = parseAuthConfig({
    protocol: 'account-auth-v1',
    authMode: 'hosted',
    issuer: ISSUER,
    audience: AUDIENCE,
    clientId: CLIENT_ID,
    scopes: ['openid', 'profile', 'email'],
    redirectUris: [REDIRECT],
    appScheme: 'me-mobile',
  });
  if (!isHostedReady(parsed)) throw new Error('unreachable');
  return parsed;
}

interface PromptResult {
  type: string;
  params?: Record<string, string>;
}

function fakeTokenRequest(config: Record<string, unknown>) {
  const extra = (config['extraParams'] ?? {}) as Record<string, string>;
  return {
    getQueryBody() {
      return {
        grant_type: 'authorization_code',
        client_id: String(config['clientId'] ?? ''),
        ...(typeof config['code'] === 'string' ? { code: config['code'] } : {}),
        ...(typeof config['redirectUri'] === 'string' ? { redirect_uri: config['redirectUri'] } : {}),
        ...(typeof config['refreshToken'] === 'string' ? { refresh_token: config['refreshToken'] } : {}),
        ...(typeof config['token'] === 'string' ? { token: config['token'] } : {}),
        ...extra,
      };
    },
    getHeaders() {
      return { Accept: 'application/json' };
    },
  };
}

function makeFakeSdk(options: {
  verifier?: string | null;
  prompt?: PromptResult;
} = {}) {
  const calls: Array<{ kind: string; config?: unknown }> = [];
  let exchangeCalls = 0;
  const verifier =
    options.verifier === undefined ? 'fake-verifier-pkce-001' : options.verifier;
  const request = {
    ...(verifier === null ? {} : { codeVerifier: verifier }),
    async promptAsync() {
      calls.push({ kind: 'prompt' });
      return (
        options.prompt ?? { type: 'success', params: { code: 'auth-code-1', state: 's' } }
      );
    },
  };
  return {
    calls,
    request,
    get exchangeCalls() {
      return exchangeCalls;
    },
    surface: {
      maybeCompleteAuthSession() {},
      responseTypeCode: 'code',
      createAuthRequest(config: {
        clientId: string;
        redirectUri: string;
        scopes: string[];
        responseType: string;
        usePKCE: boolean;
        extraParams: Record<string, string>;
      }) {
        calls.push({ kind: 'createAuth', config });
        return request;
      },
      createAccessTokenRequest(config: Record<string, unknown>) {
        exchangeCalls += 1;
        calls.push({ kind: 'exchange', config });
        return fakeTokenRequest(config);
      },
      createRefreshTokenRequest(config: Record<string, unknown>) {
        calls.push({ kind: 'refresh', config });
        return fakeTokenRequest(config);
      },
      createRevokeTokenRequest(config: Record<string, unknown>) {
        calls.push({ kind: 'revoke', config });
        return fakeTokenRequest(config);
      },
      tokenResponseFromJson(json: Record<string, unknown>) {
        return {
          ...(typeof json['access_token'] === 'string' ? { accessToken: json['access_token'] as string } : {}),
          ...(typeof json['refresh_token'] === 'string' ? { refreshToken: json['refresh_token'] as string } : {}),
          ...(typeof json['expires_in'] === 'number' ? { expiresIn: json['expires_in'] as number } : {}),
        };
      },
    },
  };
}

interface SeenCall {
  url: string;
  redirect: unknown;
  body: string;
}

function tokenFetch(
  tokenJson: Record<string, unknown>,
  seen: SeenCall[],
  finalUrl?: string,
  status = 200,
) {
  return (async (input: string, init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    redirect?: string;
  }) => {
    seen.push({ url: input, redirect: init?.redirect, body: init?.body ?? '' });
    return {
      ok: status >= 200 && status < 300,
      status,
      url: finalUrl ?? input,
      json: async () => tokenJson,
    };
  }) as unknown as typeof fetch;
}

const TOKEN_JSON = {
  access_token: 'idp-access-1',
  refresh_token: 'idp-refresh-1',
  expires_in: 3600,
};

const DISCOVERY = {
  authorizationEndpoint: 'https://issuer.example.test/authorize',
  tokenEndpoint: 'https://issuer.example.test/token',
};

describe('native OIDC adapter (real bridge, injected SDK)', () => {
  it('sends the SAME-request verifier as code_verifier exactly once', async () => {
    const fake = makeFakeSdk();
    const seen: SeenCall[] = [];
    const attempt = await beginAuthorizationAttempt(hostedConfig(), DISCOVERY, REDIRECT, {
      sdk: fake.surface,
      fetchImpl: tokenFetch(TOKEN_JSON, seen),
    });
    const tokens = await attempt.perform();
    assert.equal(tokens.accessToken, 'idp-access-1');
    assert.equal(tokens.refreshToken, 'idp-refresh-1');
    // Exactly one credential-bearing POST, redirect-guarded.
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.redirect, 'error');
    assert.equal(seen[0]?.url, DISCOVERY.tokenEndpoint);
    // The SDK-generated verifier reached the exchange body (production bug
    // was its loss here: every real PKCE IdP rejects without it).
    const body = seen[0]?.body ?? '';
    assert.ok(body.includes('code_verifier=fake-verifier-pkce-001'));
    assert.ok(body.includes('code=auth-code-1'));
    // The verifier sent equals the prompting request's own verifier.
    const exchangeConfig = fake.calls.find((c) => c.kind === 'exchange')?.config as
      | Record<string, unknown>
      | undefined;
    assert.equal(
      (exchangeConfig?.['extraParams'] as Record<string, string>)?.['code_verifier'],
      fake.request.codeVerifier,
    );
    // The attempt is consumed: a second perform throws, no second POST.
    await assert.rejects(
      attempt.perform(),
      (e: unknown) => e instanceof HomeClientError && e.code === 'AUTH_FAILED',
    );
    assert.equal(seen.length, 1);
  });

  it('fails closed when the verifier is missing (zero exchange POSTs)', async () => {
    const fake = makeFakeSdk({ verifier: null });
    const seen: SeenCall[] = [];
    const attempt = await beginAuthorizationAttempt(hostedConfig(), DISCOVERY, REDIRECT, {
      sdk: fake.surface,
      fetchImpl: tokenFetch(TOKEN_JSON, seen),
    });
    await assert.rejects(
      attempt.perform(),
      (e: unknown) => e instanceof HomeClientError && e.code === 'AUTH_FAILED',
    );
    assert.equal(seen.length, 0);
    assert.equal(fake.exchangeCalls, 0);
  });

  it('cancel/dismiss rejects without exchanging; provider error fails', async () => {
    for (const type of ['cancel', 'dismiss']) {
      const fake = makeFakeSdk({ prompt: { type } });
      const seen: SeenCall[] = [];
      const attempt = await beginAuthorizationAttempt(hostedConfig(), DISCOVERY, REDIRECT, {
        sdk: fake.surface,
        fetchImpl: tokenFetch(TOKEN_JSON, seen),
      });
      await assert.rejects(
        attempt.perform(),
        (e: unknown) => e instanceof HomeClientError && e.code === 'AUTH_CANCELLED',
      );
      assert.equal(seen.length, 0);
    }
    const fake = makeFakeSdk({ prompt: { type: 'error' } });
    const attempt = await beginAuthorizationAttempt(hostedConfig(), DISCOVERY, REDIRECT, {
      sdk: fake.surface,
      fetchImpl: tokenFetch(TOKEN_JSON, []),
    });
    await assert.rejects(
      attempt.perform(),
      (e: unknown) => e instanceof HomeClientError && e.code === 'AUTH_FAILED',
    );
  });

  it('ID-token-only exchange response fails (no ID-token fallback)', async () => {
    const fake = makeFakeSdk();
    const seen: SeenCall[] = [];
    const attempt = await beginAuthorizationAttempt(hostedConfig(), DISCOVERY, REDIRECT, {
      sdk: fake.surface,
      fetchImpl: tokenFetch({ id_token: 'some-id-token' }, seen),
    });
    await assert.rejects(
      attempt.perform(),
      (e: unknown) => e instanceof HomeClientError && e.code === 'AUTH_FAILED',
    );
    assert.equal(seen.length, 1);
  });

  it('late callback after logout never resurrects (generation fenced)', async () => {
    const fake = makeFakeSdk();
    const seen: SeenCall[] = [];
    const secure = createMemorySecureStorage();
    const accountFetch = (async (input: string) => ({
      status: 200,
      url: input,
      json: async () => ({
        protocol: 'account-auth-v1',
        authMode: 'hosted',
        accountId: 'acct_abc',
        issuer: ISSUER,
      }),
    })) as unknown as typeof fetch;
    const manager = new AccountAuthManager(secure, { fetchImpl: accountFetch });
    const config = hostedConfig();
    const gen = manager.beginLogin();
    const attempt = await beginAuthorizationAttempt(config, DISCOVERY, REDIRECT, {
      sdk: fake.surface,
      fetchImpl: tokenFetch(TOKEN_JSON, seen),
    });
    const tokens = await attempt.perform();
    await manager.logout();
    const late = await manager.verifyAndCommit(
      BACKEND,
      { accessToken: tokens.accessToken },
      config,
      gen,
    );
    assert.equal(late.committed, false);
    assert.equal(await secure.getItem('me.backend.auth-bundle.v1'), null);
  });

  it('malicious discovery redirect is refused before any endpoint is used', async () => {
    const calls: string[] = [];
    // Simulates a non-compliant stack that followed a 307 to evil anyway.
    const evilFetch = (async (input: string) => {
      calls.push(input);
      return {
        ok: true,
        status: 200,
        url: 'https://evil.invalid/.well-known/openid-configuration',
        json: async () => ({
          issuer: 'https://evil.invalid',
          authorization_endpoint: 'https://evil.invalid/authorize',
          token_endpoint: 'https://evil.invalid/token',
        }),
      };
    }) as unknown as typeof fetch;
    await assert.rejects(
      fetchTrustedDiscovery(ISSUER, false, evilFetch),
      (e: unknown) => e instanceof HomeClientError && e.code === 'CONTRACT_MISMATCH',
    );
    assert.deepEqual(calls, [`${ISSUER}/.well-known/openid-configuration`]);
  });

  it('well-known HTTP error fails closed without endpoint use', async () => {
    const redirectFetch = (async (input: string) => ({
      ok: false,
      status: 307,
      url: input,
      json: async () => ({}),
    })) as unknown as typeof fetch;
    await assert.rejects(
      fetchTrustedDiscovery(ISSUER, false, redirectFetch),
      (e: unknown) => e instanceof HomeClientError,
    );
  });

  it('metadata issuer mismatch is refused', async () => {
    const mismatchFetch = (async (input: string) => ({
      ok: true,
      status: 200,
      url: input,
      json: async () => ({
        issuer: 'https://attacker.invalid',
        authorization_endpoint: 'https://attacker.invalid/authorize',
        token_endpoint: 'https://attacker.invalid/token',
      }),
    })) as unknown as typeof fetch;
    await assert.rejects(
      fetchTrustedDiscovery(ISSUER, false, mismatchFetch),
      (e: unknown) => e instanceof HomeClientError && e.code === 'CONTRACT_MISMATCH',
    );
  });

  it('token-endpoint redirect refuses without forwarding secrets', async () => {
    const fake = makeFakeSdk();
    const seen: SeenCall[] = [];
    const attempt = await beginAuthorizationAttempt(hostedConfig(), DISCOVERY, REDIRECT, {
      sdk: fake.surface,
      // Non-compliant stack followed a 307 to evil: final URL is foreign.
      fetchImpl: tokenFetch(TOKEN_JSON, seen, 'https://evil.invalid/token'),
    });
    await assert.rejects(
      attempt.perform(),
      (e: unknown) => e instanceof HomeClientError && e.code === 'CONTRACT_MISMATCH',
    );
    // Exactly one POST, redirect-guarded; nothing re-issued to the evil origin.
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.redirect, 'error');
    assert.equal(seen[0]?.url, DISCOVERY.tokenEndpoint);
    assert.ok((seen[0]?.body ?? '').includes('code_verifier='));
  });

  it('trusted metadata may declare endpoints on another https origin', async () => {
    const otherOriginFetch = (async (input: string) => {
      if (input.endsWith('/.well-known/openid-configuration')) {
        return {
          ok: true,
          status: 200,
          url: input,
          json: async () => ({
            issuer: ISSUER,
            authorization_endpoint: 'https://login.other-origin.test/authorize',
            token_endpoint: 'https://login.other-origin.test/token',
          }),
        };
      }
      throw new Error(`unexpected fetch: ${input}`);
    }) as unknown as typeof fetch;
    const discovery = await fetchTrustedDiscovery(ISSUER, false, otherOriginFetch);
    assert.equal(discovery.tokenEndpoint, 'https://login.other-origin.test/token');
    const fake = makeFakeSdk();
    const seen: SeenCall[] = [];
    const attempt = await beginAuthorizationAttempt(hostedConfig(), discovery, REDIRECT, {
      sdk: fake.surface,
      fetchImpl: tokenFetch(TOKEN_JSON, seen, 'https://login.other-origin.test/token'),
    });
    const tokens = await attempt.perform();
    assert.equal(tokens.accessToken, 'idp-access-1');
  });

  it('refresh posts over the guarded transport (no verifier in body)', async () => {
    const fake = makeFakeSdk();
    const seen: SeenCall[] = [];
    const tokens = await refreshTokensNative('idp-refresh-1', hostedConfig(), DISCOVERY, {
      sdk: fake.surface,
      fetchImpl: tokenFetch(
        { access_token: 'idp-access-2', refresh_token: 'idp-refresh-2', expires_in: 3600 },
        seen,
      ),
    });
    assert.equal(tokens.accessToken, 'idp-access-2');
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.redirect, 'error');
    assert.ok((seen[0]?.body ?? '').includes('refresh_token=idp-refresh-1'));
    assert.ok(!(seen[0]?.body ?? '').includes('code_verifier'));
  });

  it('revocation failure never blocks logout', async () => {
    const fake = makeFakeSdk();
    const failingFetch = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    await revokeTokensNative('some-token', hostedConfig(), {
      ...DISCOVERY,
      revocationEndpoint: 'https://issuer.example.test/revoke',
    }, { sdk: fake.surface, fetchImpl: failingFetch });
    // Resolves (no throw): best-effort.
  });
});
