// Native OIDC browser bridge (maintained Expo AuthSession + WebBrowser, SDK 58).
//
// Portable contract pieces (config parsing, redirect allowlist, verification,
// SecureStore bundle, generation guards) live in `src/account-auth.ts`.
// This module owns ONLY the native browser + IdP-transport steps that cannot
// run in the portable package:
//
//   PRODUCTION NOTE (F7 review): `AuthSession.exchangeCodeAsync` /
//   `refreshAsync` / `fetchDiscoveryAsync` all POST/GET through the SDK's
//   internal global `fetch` with default redirect-following and no issuer
//   check (verified against the SDK 58.0.16 published source). Two gaps
//   follow from that, both closed here rather than in caller code:
//   1. The PKCE `code_verifier` lives on the SAME `AuthRequest` instance
//      that prompts the browser. Splitting prompt and exchange into
//      separate calls drops the verifier and every real PKCE IdP rejects
//      the exchange. So this module performs ONE single-attempt operation
//      per authorization: prompt + code exchange inside one closure over
//      the same request object, `code_verifier` sent as
//      `extraParams.code_verifier` per the official authentication guide.
//      A missing verifier fails closed; the attempt is consumed once and
//      can never be replayed; the verifier is never persisted or logged.
//   2. Credential-bearing IdP POSTs (code, verifier, refresh token, revoke
//      token) must not follow a 307 to another origin. The SDK offers no
//      transport option, so token/revocation bodies are built with the
//      maintained request classes (`AccessTokenRequest`,
//      `RefreshTokenRequest`, `RevokeTokenRequest`: grant/params/headers
//      stay SDK-owned) but POSTED over this module's guarded transport
//      (`redirect: 'error'` + same-origin final-URL refusal, single attempt,
//      no retries against a foreign origin). Discovery metadata is fetched
//      over the same guarded transport and the metadata `issuer` must
//      equal the configured issuer exactly before any endpoint is used.
//
// The whole SDK surface is injectable (`NativeDeps`) so Node tests exercise
// THIS adapter — verifier reaching exchange extras exactly once, cancel,
// missing verifier, malicious discovery redirect / issuer mismatch / token
// endpoint redirect — instead of only testing the portable manager.

import type {
  AuthSdkDiscovery,
  HostedAuthConfig,
} from '../../../src/account-auth.ts';
import { HomeClientError } from '../../../src/errors.ts';

export const ACCOUNT_APP_SCHEME = 'me-mobile';
export const ACCOUNT_CALLBACK_PATH = 'auth/callback';

export interface ProviderDiscovery extends AuthSdkDiscovery {
  authorizationEndpoint: string;
}

/** Minimal maintained-SDK surface this adapter needs (injectable for tests). */
export interface SdkAuthRequest {
  readonly codeVerifier?: string;
  promptAsync(
    discovery: { authorizationEndpoint: string },
    options?: { showInRecents?: boolean },
  ): Promise<{ type: string; params?: Record<string, string>; error?: unknown }>;
}

export interface SdkTokenRequest {
  getQueryBody(): Record<string, string>;
  getHeaders(): Record<string, string>;
}

export interface SdkTokenResponse {
  accessToken?: string;
  refreshToken?: string;
  expiresIn?: number;
  issuedAt?: number;
}

export interface SdkSurface {
  maybeCompleteAuthSession(): void;
  responseTypeCode: string;
  createAuthRequest(config: {
    clientId: string;
    redirectUri: string;
    scopes: string[];
    responseType: string;
    usePKCE: boolean;
    extraParams: Record<string, string>;
  }): SdkAuthRequest;
  createAccessTokenRequest(config: {
    clientId: string;
    code: string;
    redirectUri: string;
    extraParams: Record<string, string>;
  }): SdkTokenRequest;
  createRefreshTokenRequest(config: {
    clientId: string;
    refreshToken: string;
  }): SdkTokenRequest;
  createRevokeTokenRequest(config: { clientId: string; token: string }): SdkTokenRequest;
  tokenResponseFromJson(json: Record<string, unknown>): SdkTokenResponse;
}

export interface NativeDeps {
  sdk?: SdkSurface;
  fetchImpl?: typeof fetch;
  allowInsecureLoopback?: boolean;
}

async function realSdkSurface(): Promise<SdkSurface> {
  const [AuthSession, WebBrowser] = await Promise.all([
    import('expo-auth-session'),
    import('expo-web-browser'),
  ]);
  const NS = AuthSession as unknown as Record<string, unknown>;
  const AuthRequestClass = NS['AuthRequest'] as new (config: Record<string, unknown>) => SdkAuthRequest;
  const AccessTokenRequestClass = NS['AccessTokenRequest'] as new (
    config: Record<string, unknown>,
  ) => SdkTokenRequest;
  const RefreshTokenRequestClass = NS['RefreshTokenRequest'] as new (
    config: Record<string, unknown>,
  ) => SdkTokenRequest;
  const RevokeTokenRequestClass = NS['RevokeTokenRequest'] as new (
    config: Record<string, unknown>,
  ) => SdkTokenRequest;
  const TokenResponseClass = NS['TokenResponse'] as new (
    response: Record<string, unknown>,
    raw: unknown,
  ) => SdkTokenResponse;
  const ResponseType = NS['ResponseType'] as { Code: string };
  const maybeComplete = (WebBrowser as unknown as { maybeCompleteAuthSession(): void })
    .maybeCompleteAuthSession.bind(WebBrowser);
  return {
    maybeCompleteAuthSession: () => maybeComplete(),
    responseTypeCode: ResponseType.Code,
    createAuthRequest: (config) => new AuthRequestClass({ ...config }),
    createAccessTokenRequest: (config) => new AccessTokenRequestClass({ ...config }),
    createRefreshTokenRequest: (config) => new RefreshTokenRequestClass({ ...config }),
    createRevokeTokenRequest: (config) => new RevokeTokenRequestClass({ ...config }),
    tokenResponseFromJson: (json) =>
      new TokenResponseClass(
        {
          accessToken: typeof json['access_token'] === 'string' ? json['access_token'] : undefined,
          refreshToken: typeof json['refresh_token'] === 'string' ? json['refresh_token'] : undefined,
          expiresIn: typeof json['expires_in'] === 'number' ? json['expires_in'] : undefined,
          issuedAt: typeof json['issued_at'] === 'number' ? json['issued_at'] : undefined,
          idToken: typeof json['id_token'] === 'string' ? json['id_token'] : undefined,
        },
        json,
      ),
  };
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

function isTrustedHttpUrl(value: string | undefined, allowInsecureLoopback: boolean): boolean {
  if (!value) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return true;
  return (
    allowInsecureLoopback && url.protocol === 'http:' && isLoopbackHost(url.hostname)
  );
}

function assertSameOrigin(requestTarget: string, finalUrl: string | undefined, what: string): void {
  if (!finalUrl) return;
  let requestOrigin: string;
  let finalOrigin: string;
  try {
    requestOrigin = new URL(requestTarget).origin;
    finalOrigin = new URL(finalUrl).origin;
  } catch {
    throw new HomeClientError(
      'CONTRACT_MISMATCH',
      `The ${what} returned an unreadable address. Refusing to continue.`,
    );
  }
  if (requestOrigin !== finalOrigin) {
    throw new HomeClientError(
      'CONTRACT_MISMATCH',
      `The ${what} redirected to a different origin. Credentials were not re-issued there.`,
    );
  }
}

/** App-owned callback URI for this build (must match a registered allowlist entry). */
export function appRedirectUri(scheme: string = ACCOUNT_APP_SCHEME): string {
  return `${scheme}://${ACCOUNT_CALLBACK_PATH}`;
}

/**
 * Guarded IdP POST: single attempt, form-urlencoded, `redirect: 'error'` +
 * same-origin final-URL refusal. Never retries against a foreign origin, so
 * a 307 to an attacker cannot receive the code/verifier/refresh token.
 */
export async function guardedTokenPost(
  url: string,
  headers: Record<string, string>,
  body: Record<string, string>,
  fetchImpl: typeof fetch = fetch,
  what = 'login provider',
  allowInsecureLoopback = false,
): Promise<Record<string, unknown>> {
  if (!isTrustedHttpUrl(url, allowInsecureLoopback)) {
    throw new HomeClientError('CONTRACT_MISMATCH', `The ${what} endpoint is not trusted.`);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
      redirect: 'error',
      signal: controller.signal,
    } as RequestInit);
    assertSameOrigin(url, response.url || undefined, what);
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new HomeClientError('AUTH_FAILED', `Sign-in failed at the ${what}.`);
    }
    if (!response.ok) {
      const message =
        json && typeof json === 'object' && typeof (json as Record<string, unknown>)['error_description'] === 'string'
          ? String((json as Record<string, unknown>)['error_description']).slice(0, 200)
          : `Sign-in failed at the ${what}.`;
      throw new HomeClientError('AUTH_FAILED', message);
    }
    if (!json || typeof json !== 'object' || Array.isArray(json)) {
      throw new HomeClientError('AUTH_FAILED', `Sign-in failed at the ${what}.`);
    }
    if ('error' in json) {
      throw new HomeClientError('AUTH_FAILED', `Sign-in failed at the ${what}.`);
    }
    return json as Record<string, unknown>;
  } catch (error) {
    if (error instanceof HomeClientError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new HomeClientError('TIMEOUT', 'The login provider did not respond in time.', true);
    }
    throw new HomeClientError('HOME_OFFLINE', 'Could not reach the login provider.', true);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Trusted provider discovery over the guarded transport (NOT the SDK's
 * redirect-following fetcher): well-known fetch refuses cross-origin
 * redirects, and the metadata `issuer` must equal the configured issuer
 * exactly before any endpoint is used. Endpoints on other origins are
 * allowed only via this trusted metadata (each still HTTPS-pinned).
 */
export async function fetchTrustedDiscovery(
  issuer: string,
  allowInsecureLoopback: boolean,
  fetchImpl: typeof fetch = fetch,
): Promise<ProviderDiscovery> {
  let issuerUrl: URL;
  try {
    issuerUrl = new URL(issuer);
  } catch {
    throw new HomeClientError('CONTRACT_MISMATCH', 'The configured login issuer is invalid.');
  }
  const trusted =
    issuerUrl.protocol === 'https:' ||
    (allowInsecureLoopback && issuerUrl.protocol === 'http:' && isLoopbackHost(issuerUrl.hostname));
  if (!trusted || issuerUrl.username || issuerUrl.password || issuerUrl.search || issuerUrl.hash) {
    throw new HomeClientError('CONTRACT_MISMATCH', 'The configured login issuer is not trusted.');
  }
  const wellKnown = `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  let metadata: Record<string, unknown>;
  try {
    const response = await fetchImpl(wellKnown, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      redirect: 'error',
      signal: controller.signal,
    } as RequestInit);
    assertSameOrigin(wellKnown, response.url || undefined, 'login provider metadata');
    if (!response.ok) {
      throw new HomeClientError('CONTRACT_MISMATCH', 'The login provider metadata is unavailable.');
    }
    try {
      const parsed: unknown = await response.json();
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new HomeClientError('CONTRACT_MISMATCH', 'The login provider metadata is invalid.');
      }
      metadata = parsed as Record<string, unknown>;
    } catch (error) {
      if (error instanceof HomeClientError) throw error;
      throw new HomeClientError('CONTRACT_MISMATCH', 'The login provider metadata is invalid.');
    }
  } catch (error) {
    if (error instanceof HomeClientError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new HomeClientError('TIMEOUT', 'The login provider did not respond in time.', true);
    }
    throw new HomeClientError('HOME_OFFLINE', 'Could not reach the login provider.', true);
  } finally {
    clearTimeout(timeout);
  }
  if (metadata['issuer'] !== issuer) {
    throw new HomeClientError(
      'CONTRACT_MISMATCH',
      'The login provider metadata issuer does not match the configured issuer. Refusing to continue.',
    );
  }
  const authorizationEndpoint =
    typeof metadata['authorization_endpoint'] === 'string' ? metadata['authorization_endpoint'] : undefined;
  const tokenEndpoint =
    typeof metadata['token_endpoint'] === 'string' ? metadata['token_endpoint'] : undefined;
  const revocationEndpoint =
    typeof metadata['revocation_endpoint'] === 'string' ? metadata['revocation_endpoint'] : undefined;
  if (!authorizationEndpoint || !tokenEndpoint) {
    throw new HomeClientError('CONTRACT_MISMATCH', 'The login provider metadata is incomplete.');
  }
  if (
    !isTrustedHttpUrl(authorizationEndpoint, allowInsecureLoopback) ||
    !isTrustedHttpUrl(tokenEndpoint, allowInsecureLoopback) ||
    (revocationEndpoint && !isTrustedHttpUrl(revocationEndpoint, allowInsecureLoopback))
  ) {
    throw new HomeClientError('CONTRACT_MISMATCH', 'The login provider endpoints are not trusted.');
  }
  return {
    authorizationEndpoint,
    tokenEndpoint,
    ...(revocationEndpoint ? { revocationEndpoint } : {}),
  };
}

export interface AuthorizationAttempt {
  readonly redirectUri: string;
  /** Single use: prompts the browser, then exchanges code+verifier. Second call throws. */
  perform(): Promise<NativeTokenSet>;
}

/**
 * Begin one authorization attempt bound to the SAME `AuthRequest` (and its
 * SDK-owned PKCE verifier) for both prompt and code exchange. The verifier
 * never leaves this closure: it is sent as `extraParams.code_verifier` and
 * never persisted or logged. A missing verifier fails closed.
 */
export async function beginAuthorizationAttempt(
  config: HostedAuthConfig,
  discovery: ProviderDiscovery,
  redirectUri: string,
  deps: NativeDeps = {},
): Promise<AuthorizationAttempt> {
  const sdk = deps.sdk ?? (await realSdkSurface());
  const fetchImpl = deps.fetchImpl ?? fetch;
  const allowInsecure = deps.allowInsecureLoopback ?? false;
  sdk.maybeCompleteAuthSession();
  const extraParams: Record<string, string> = { audience: config.audience };
  if (config.extraAudiences && config.extraAudiences.length > 0) {
    extraParams['resource'] = config.extraAudiences.join(' ');
  }
  const request = sdk.createAuthRequest({
    clientId: config.clientId,
    redirectUri,
    scopes: config.scopes,
    responseType: sdk.responseTypeCode,
    usePKCE: true,
    extraParams,
  });
  let consumed = false;
  return {
    redirectUri,
    async perform(): Promise<NativeTokenSet> {
      if (consumed) {
        throw new HomeClientError(
          'AUTH_FAILED',
          'This sign-in attempt was already used. Start a new sign-in.',
        );
      }
      consumed = true;
      const result = await request.promptAsync(
        { authorizationEndpoint: discovery.authorizationEndpoint },
        { showInRecents: true },
      );
      if (result.type === 'cancel' || result.type === 'dismiss') {
        throw new HomeClientError('AUTH_CANCELLED', 'Sign-in was cancelled before completing.');
      }
      if (result.type !== 'success') {
        throw new HomeClientError('AUTH_FAILED', 'Sign-in failed at the provider.');
      }
      const code = result.params?.['code'];
      if (!code) {
        throw new HomeClientError('AUTH_FAILED', 'Sign-in failed: the provider returned no authorization code.');
      }
      const verifier = request.codeVerifier;
      if (!verifier) {
        throw new HomeClientError(
          'AUTH_FAILED',
          'Sign-in failed: the secure verifier was unavailable. No code was exchanged.',
        );
      }
      // Maintained request class builds the form body (grant/code/redirect);
      // guarded transport POSTs it without following cross-origin redirects.
      const exchange = sdk.createAccessTokenRequest({
        clientId: config.clientId,
        code,
        redirectUri,
        extraParams: { code_verifier: verifier },
      });
      const json = await guardedTokenPost(
        discovery.tokenEndpoint,
        exchange.getHeaders(),
        exchange.getQueryBody(),
        fetchImpl,
        'login provider',
        allowInsecure,
      );
      const token = sdk.tokenResponseFromJson(json);
      if (!token.accessToken) {
        throw new HomeClientError(
          'AUTH_FAILED',
          'Sign-in failed: the provider returned no access token.',
        );
      }
      return {
        accessToken: token.accessToken,
        ...(token.refreshToken ? { refreshToken: token.refreshToken } : {}),
        ...(typeof token.expiresIn === 'number' ? { expiresIn: token.expiresIn } : {}),
        ...(typeof token.issuedAt === 'number' ? { issuedAt: token.issuedAt } : {}),
      };
    },
  };
}

export interface NativeTokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  issuedAt?: number;
}

/** Maintained-SDK refresh over the guarded transport (caller re-verifies before persisting). */
export async function refreshTokensNative(
  refreshToken: string,
  config: HostedAuthConfig,
  discovery: AuthSdkDiscovery,
  deps: NativeDeps = {},
): Promise<NativeTokenSet> {
  const sdk = deps.sdk ?? (await realSdkSurface());
  const fetchImpl = deps.fetchImpl ?? fetch;
  const request = sdk.createRefreshTokenRequest({ clientId: config.clientId, refreshToken });
  const json = await guardedTokenPost(
    discovery.tokenEndpoint,
    request.getHeaders(),
    request.getQueryBody(),
    fetchImpl,
    'login provider',
    deps.allowInsecureLoopback ?? false,
  );
  const token = sdk.tokenResponseFromJson(json);
  if (!token.accessToken) {
    throw new HomeClientError('AUTH_FAILED', 'The session could not be refreshed.');
  }
  return {
    accessToken: token.accessToken,
    ...(token.refreshToken ? { refreshToken: token.refreshToken } : {}),
    ...(typeof token.expiresIn === 'number' ? { expiresIn: token.expiresIn } : {}),
    ...(typeof token.issuedAt === 'number' ? { issuedAt: token.issuedAt } : {}),
  };
}

/** Best-effort revocation on explicit logout; failure never blocks logout. */
export async function revokeTokensNative(
  token: string,
  config: HostedAuthConfig,
  discovery: AuthSdkDiscovery,
  deps: NativeDeps = {},
): Promise<void> {
  if (!discovery.revocationEndpoint) return;
  try {
    const sdk = deps.sdk ?? (await realSdkSurface());
    const fetchImpl = deps.fetchImpl ?? fetch;
    const request = sdk.createRevokeTokenRequest({ clientId: config.clientId, token });
    await guardedTokenPost(
      discovery.revocationEndpoint,
      request.getHeaders(),
      request.getQueryBody(),
      fetchImpl,
      'login provider',
      deps.allowInsecureLoopback ?? false,
    );
  } catch {
    // Honest best-effort: logout still completes locally.
  }
}
