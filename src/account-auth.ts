// Native OIDC account sign-in (account-auth-v1, F7).
//
// Portable, dependency-free helper for the phone's real IdP login. The
// maintained Expo SDK (AuthSession + WebBrowser, PKCE) owns the browser,
// code verifier, code exchange, and refresh; this module owns ONLY the
// backend-contract pieces so they stay unit-testable without native imports:
//   - GET /v1/auth/config parsing (dev / hosted-ready / hosted-not-ready)
//   - trusted issuer + exact redirect-allowlist selection
//   - login request params (clientId/scopes/redirect/audience, no secrets)
//   - GET /v1/account verification before marking signed-in / persisting
//   - SecureStore-only auth bundle (access/refresh/expiry/verified
//     accountId+issuer+backend binding), generation-guarded commits so a late
//     browser callback after logout or backend-URL change cannot resurrect a
//     session, refresh identity re-verification (fail closed on mismatch).
//
// Security rules enforced here:
// - No passwords, no provider secrets, no client secrets, no token-URL logs.
// - ACCESS token only; an ID token never verifies and never persists.
// - redirect: 'error' + same-origin final-URL guard on every
//   credential-bearing fetch (mirrors paired-home-client.ts).
// - Issuer must be trusted https (loopback http only in explicit test/dev).
// - No token-derived key URLs, no user-supplied OAuth endpoints or redirects.

import { HomeClientError } from './errors.ts';
import { assertBackendSameOrigin, BACKEND_ACCOUNT_TOKEN_KEY } from './backend-client.ts';
import type { SecureStorage } from './secure-storage.ts';

export const AUTH_BUNDLE_KEY = 'me.backend.auth-bundle.v1';
export const AUTH_BACKEND_URL_KEY = 'me.backend.url.v1';

export interface DevAuthConfig {
  protocol: 'account-auth-v1';
  authMode: 'dev';
  devOnly: true;
}

export interface HostedAuthConfig {
  protocol: 'account-auth-v1';
  authMode: 'hosted';
  issuer: string;
  audience: string;
  clientId: string;
  scopes: string[];
  redirectUris: string[];
  appScheme?: string;
  extraAudiences?: string[];
  expectedTokenUse?: string;
}

export interface NotReadyAuthConfig {
  protocol: 'account-auth-v1';
  authMode: 'hosted';
  notReady: true;
  issuer?: string;
  audience?: string;
}

export type AuthConfig = DevAuthConfig | HostedAuthConfig | NotReadyAuthConfig;

export function isHostedReady(config: AuthConfig): config is HostedAuthConfig {
  return config.authMode === 'hosted' && !(config as NotReadyAuthConfig).notReady;
}

export interface AccountInfo {
  accountId: string;
  issuer: string;
  claims?: Record<string, unknown>;
}

export interface AuthBundle {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number | null;
  accountId: string;
  issuer: string;
  audience: string;
  backendUrl: string;
  verifiedAt: number;
}

export interface AuthSdkTokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  issuedAt?: number;
}

export interface AuthSdkDiscovery {
  tokenEndpoint: string;
  revocationEndpoint?: string;
  authorizationEndpoint?: string;
}

/** Minimal maintained-SDK surface the portable manager needs (injected). */
export interface AccountAuthSdk {
  exchangeCode(
    code: string,
    redirectUri: string,
    config: HostedAuthConfig,
    discovery: AuthSdkDiscovery,
  ): Promise<AuthSdkTokenSet>;
  refreshToken(
    refreshToken: string,
    config: HostedAuthConfig,
    discovery: AuthSdkDiscovery,
  ): Promise<AuthSdkTokenSet>;
  revokeToken?(
    token: string,
    config: HostedAuthConfig,
    discovery: AuthSdkDiscovery,
  ): Promise<void>;
}

type FetchImpl = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
    redirect?: 'error' | 'follow' | 'manual';
  },
) => Promise<{ status: number; url?: string; json(): Promise<unknown> }>;

export interface AccountAuthManagerOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  allowInsecureLoopback?: boolean;
  refreshSkewMs?: number;
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

export function isTrustedIssuer(issuer: string, allowInsecureLoopback = false): boolean {
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    return false;
  }
  if (url.protocol === 'https:' && !url.username && !url.password) return true;
  if (
    allowInsecureLoopback &&
    url.protocol === 'http:' &&
    isLoopbackHost(url.hostname) &&
    !url.username &&
    !url.password
  ) {
    return true;
  }
  return false;
}

function urlScheme(value: string): string | null {
  const idx = value.indexOf(':');
  if (idx <= 0) return null;
  return value.slice(0, idx).toLowerCase();
}

/** Strict redirect URI shape: absolute URI with a scheme, no credentials. */
export function validateRedirectUri(uri: string): string {
  const trimmed = uri.trim();
  if (!trimmed || trimmed.includes('*')) {
    throw new HomeClientError('INVALID_INPUT', 'The registered login redirect is invalid.');
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new HomeClientError('INVALID_INPUT', 'The registered login redirect is invalid.');
  }
  if (!parsed.protocol || parsed.protocol === ':' || parsed.username || parsed.password) {
    throw new HomeClientError('INVALID_INPUT', 'The registered login redirect is invalid.');
  }
  return trimmed;
}

/**
 * Select the app-owned redirect: the first allowlist entry whose scheme
 * matches this build's app scheme (exact match, never user-supplied).
 * Falls back to the first entry when no scheme hint is configured.
 */
export function selectRedirectUri(redirectUris: string[], appScheme?: string): string {
  if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
    throw new HomeClientError('INVALID_INPUT', 'No registered login redirect is configured.');
  }
  const seen = new Set<string>();
  for (const uri of redirectUris) {
    const clean = validateRedirectUri(uri);
    if (seen.has(clean)) {
      throw new HomeClientError('INVALID_INPUT', 'The registered login redirects contain duplicates.');
    }
    seen.add(clean);
  }
  if (appScheme) {
    const want = appScheme.trim().toLowerCase().replace(/:$/, '');
    const match = redirectUris.map((u) => u.trim()).find((u) => urlScheme(u) === want);
    if (!match) {
      throw new HomeClientError(
        'INVALID_INPUT',
        'This app build has no registered login redirect. Ask the operator to register the app callback.',
      );
    }
    return match;
  }
  return redirectUris[0]!.trim();
}

/** Extra params for the authorization request: API audience (+ hints). */
export function buildLoginExtraParams(config: HostedAuthConfig): Record<string, string> {
  const params: Record<string, string> = { audience: config.audience };
  if (config.extraAudiences && config.extraAudiences.length > 0) {
    params['resource'] = config.extraAudiences.join(' ');
  }
  return params;
}

export interface LoginRequest {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  responseType: 'code';
  usePKCE: true;
  extraParams: Record<string, string>;
}

/** AuthorizationCode + PKCE + state + exact redirect. No secrets here. */
export function buildLoginRequest(config: HostedAuthConfig, redirectUri: string): LoginRequest {
  const exact = validateRedirectUri(redirectUri);
  if (!config.redirectUris.map((u) => u.trim()).includes(exact)) {
    throw new HomeClientError(
      'INVALID_INPUT',
      'The login redirect is not in the registered allowlist. Refusing to start browser login.',
    );
  }
  if (!config.clientId || !config.clientId.trim()) {
    throw new HomeClientError('INVALID_INPUT', 'The login metadata is missing the public client ID.');
  }
  if (config.clientId === config.audience) {
    throw new HomeClientError(
      'CONTRACT_MISMATCH',
      'The login metadata is invalid: public client ID must differ from the API audience.',
    );
  }
  return {
    clientId: config.clientId,
    redirectUri: exact,
    scopes: [...config.scopes],
    responseType: 'code',
    usePKCE: true,
    extraParams: buildLoginExtraParams(config),
  };
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Parse GET /v1/auth/config into dev / hosted-ready / hosted-not-ready. */
export function parseAuthConfig(raw: unknown): AuthConfig {
  if (!raw || typeof raw !== 'object') {
    throw new HomeClientError('CONTRACT_MISMATCH', 'The login metadata had an unexpected shape.');
  }
  const body = raw as Record<string, unknown>;
  if (body['protocol'] !== 'account-auth-v1') {
    throw new HomeClientError('CONTRACT_MISMATCH', 'The login metadata had an unexpected shape.');
  }
  if (body['authMode'] === 'dev') return { protocol: 'account-auth-v1', authMode: 'dev', devOnly: true };
  if (body['authMode'] !== 'hosted') {
    throw new HomeClientError('CONTRACT_MISMATCH', 'The login metadata had an unexpected shape.');
  }
  if (body['error'] === 'configure_not_ready') {
    const out: NotReadyAuthConfig = { protocol: 'account-auth-v1', authMode: 'hosted', notReady: true };
    const issuer = asString(body['issuer']);
    const audience = asString(body['audience']);
    if (issuer) out.issuer = issuer;
    if (audience) out.audience = audience;
    return out;
  }
  const issuer = asString(body['issuer']);
  const audience = asString(body['audience']);
  const clientId = asString(body['clientId']);
  const scopes = body['scopes'];
  const redirectUris = body['redirectUris'];
  if (!issuer || !audience || !clientId) {
    throw new HomeClientError('CONTRACT_MISMATCH', 'The login metadata is incomplete.');
  }
  if (!Array.isArray(scopes) || scopes.length === 0 || scopes.length > 10) {
    throw new HomeClientError('CONTRACT_MISMATCH', 'The login metadata has invalid scopes.');
  }
  if (!Array.isArray(redirectUris) || redirectUris.length === 0 || redirectUris.length > 10) {
    throw new HomeClientError('CONTRACT_MISMATCH', 'The login metadata has no registered redirects.');
  }
  const cleanScopes = scopes.map((s) => (typeof s === 'string' ? s.trim() : '')).filter(Boolean);
  if (cleanScopes.length === 0) {
    throw new HomeClientError('CONTRACT_MISMATCH', 'The login metadata has invalid scopes.');
  }
  const cleanRedirects = redirectUris.map((u) => (typeof u === 'string' ? u.trim() : ''));
  const seen = new Set<string>();
  for (const uri of cleanRedirects) {
    validateRedirectUri(uri);
    if (seen.has(uri)) {
      throw new HomeClientError('CONTRACT_MISMATCH', 'The login metadata has duplicate redirects.');
    }
    seen.add(uri);
    if (uri.includes('*')) {
      throw new HomeClientError('CONTRACT_MISMATCH', 'The login metadata has an invalid redirect.');
    }
  }
  if (clientId === audience) {
    throw new HomeClientError(
      'CONTRACT_MISMATCH',
      'The login metadata is invalid: public client ID must differ from the API audience.',
    );
  }
  const extra = body['extraAudiences'];
  let extraAudiences: string[] | undefined;
  if (extra !== undefined) {
    if (!Array.isArray(extra) || extra.length > 5) {
      throw new HomeClientError('CONTRACT_MISMATCH', 'The login metadata has invalid extra audiences.');
    }
    extraAudiences = (extra as unknown[]).map((e) => (typeof e === 'string' ? e.trim() : '')).filter(Boolean);
  }
  const appSchemeRaw = asString(body['appScheme']);
  const expectedTokenUse = asString(body['expectedTokenUse']);
  return {
    protocol: 'account-auth-v1',
    authMode: 'hosted',
    issuer,
    audience,
    clientId,
    scopes: cleanScopes,
    redirectUris: cleanRedirects,
    ...(appSchemeRaw ? { appScheme: appSchemeRaw } : {}),
    ...(extraAudiences && extraAudiences.length > 0 ? { extraAudiences } : {}),
    ...(expectedTokenUse ? { expectedTokenUse } : {}),
  };
}

function parseAccountInfo(raw: unknown): AccountInfo {
  if (!raw || typeof raw !== 'object') {
    throw new HomeClientError('CONTRACT_MISMATCH', 'The account verification had an unexpected shape.');
  }
  const body = raw as Record<string, unknown>;
  const accountId = asString(body['accountId']);
  const issuer = asString(body['issuer']);
  if (!accountId || !issuer) {
    throw new HomeClientError('CONTRACT_MISMATCH', 'The account verification had an unexpected shape.');
  }
  const claims = body['claims'];
  const info: AccountInfo = { accountId, issuer };
  if (claims && typeof claims === 'object' && !Array.isArray(claims)) {
    info.claims = claims as Record<string, unknown>;
  }
  return info;
}

function validateBundle(raw: unknown): AuthBundle | null {
  if (!raw || typeof raw !== 'object') return null;
  const b = raw as Record<string, unknown>;
  if (
    typeof b['accessToken'] !== 'string' ||
    !b['accessToken'] ||
    typeof b['accountId'] !== 'string' ||
    !b['accountId'] ||
    typeof b['issuer'] !== 'string' ||
    !b['issuer'] ||
    typeof b['audience'] !== 'string' ||
    !b['audience'] ||
    typeof b['backendUrl'] !== 'string' ||
    !b['backendUrl']
  ) {
    return null;
  }
  const bundle: AuthBundle = {
    accessToken: b['accessToken'] as string,
    accountId: b['accountId'] as string,
    issuer: b['issuer'] as string,
    audience: b['audience'] as string,
    backendUrl: b['backendUrl'] as string,
    verifiedAt: typeof b['verifiedAt'] === 'number' ? (b['verifiedAt'] as number) : 0,
  };
  if (typeof b['refreshToken'] === 'string' && b['refreshToken']) {
    bundle.refreshToken = b['refreshToken'] as string;
  }
  if (typeof b['expiresAt'] === 'number') bundle.expiresAt = b['expiresAt'] as number;
  else bundle.expiresAt = null;
  return bundle;
}

/** True when the verified account identity actually changed (fail-closed clear). */
export function accountIdentityChanged(
  prev: { accountId: string; issuer: string; backendUrl: string } | null,
  next: { accountId: string; issuer: string; backendUrl: string } | null,
): boolean {
  if (prev === null || next === null) return prev !== next && (prev !== null || next !== null);
  return (
    prev.accountId !== next.accountId ||
    prev.issuer !== next.issuer ||
    prev.backendUrl !== next.backendUrl
  );
}

export class AccountAuthManager {
  private readonly secure: SecureStorage;
  private readonly fetchImpl: FetchImpl;
  private readonly now: () => number;
  private readonly allowInsecureLoopback: boolean;
  private readonly refreshSkewMs: number;
  private readonly requestTimeoutMs = 20_000;
  private generation = 0;

  constructor(secureStorage: SecureStorage, options: AccountAuthManagerOptions = {}) {
    this.secure = secureStorage;
    this.fetchImpl = (options.fetchImpl ?? fetch) as unknown as FetchImpl;
    this.now = options.now ?? Date.now;
    this.allowInsecureLoopback = options.allowInsecureLoopback ?? false;
    this.refreshSkewMs = options.refreshSkewMs ?? 5 * 60_000;
  }

  /** Monotonic login generation: capture before opening the browser. */
  beginLogin(): number {
    return this.generation;
  }

  currentGeneration(): number {
    return this.generation;
  }

  normalizeBackendUrl(value: string): string {
    let parsed: URL;
    try {
      parsed = new URL(value.trim());
    } catch {
      throw new HomeClientError('INVALID_INPUT', 'Enter a trusted backend address.');
    }
    const isLoopback = isLoopbackHost(parsed.hostname);
    if (
      (parsed.protocol !== 'https:' &&
        !(this.allowInsecureLoopback && parsed.protocol === 'http:' && isLoopback)) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      (parsed.pathname !== '' && parsed.pathname !== '/')
    ) {
      throw new HomeClientError(
        'INVALID_INPUT',
        'Use a trusted backend address without a path, query, or password.',
      );
    }
    return parsed.origin;
  }

  async fetchAuthConfig(backendUrl: string): Promise<AuthConfig> {
    const origin = this.normalizeBackendUrl(backendUrl);
    const payload = await this.request(origin, '/v1/auth/config', { method: 'GET' });
    if (payload && typeof payload === 'object' && (payload as Record<string, unknown>)['error'] === 'configure_not_ready') {
      return parseAuthConfig(payload);
    }
    return parseAuthConfig(payload);
  }

  async verifyAccount(backendUrl: string, accessToken: string): Promise<AccountInfo> {
    const origin = this.normalizeBackendUrl(backendUrl);
    const token = accessToken.trim();
    if (!token) {
      throw new HomeClientError('UNPAIRED', 'The sign-in credential was empty.');
    }
    try {
      const payload = await this.request(origin, '/v1/account', { method: 'GET' }, undefined, token);
      return parseAccountInfo(payload);
    } catch (error) {
      if (error instanceof HomeClientError && error.code === 'UNPAIRED') {
        throw new HomeClientError('UNPAIRED', 'Sign-in failed: the account credential was rejected.');
      }
      throw error;
    }
  }

  async loadBundle(): Promise<AuthBundle | null> {
    let raw: string | null;
    try {
      raw = await this.secure.getItem(AUTH_BUNDLE_KEY);
    } catch {
      throw new HomeClientError(
        'STORAGE_UNAVAILABLE',
        'Secure credential storage is unavailable on this device.',
      );
    }
    if (!raw) return null;
    try {
      return validateBundle(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  /**
   * Commit a verified bundle. Fenced by the generation captured before the
   * browser opened: a logout or backend-URL change meanwhile refuses the
   * late callback (returns false, nothing persisted).
   */
  async commitVerifiedBundle(
    bundle: AuthBundle,
    generationAtStart: number,
  ): Promise<boolean> {
    if (generationAtStart !== this.generation) return false;
    if (!isTrustedIssuer(bundle.issuer, this.allowInsecureLoopback)) {
      throw new HomeClientError('CONTRACT_MISMATCH', 'The verified issuer is not trusted.');
    }
    await this.secure.setItem(AUTH_BUNDLE_KEY, JSON.stringify(bundle));
    // Mirror the access token for the existing BackendCoordinator dev APIs.
    await this.secure.setItem(BACKEND_ACCOUNT_TOKEN_KEY, bundle.accessToken);
    await this.secure.setItem(AUTH_BACKEND_URL_KEY, bundle.backendUrl);
    return true;
  }

  /** Verify the IdP access token against the backend, then persist (fenced). */
  async verifyAndCommit(
    backendUrl: string,
    tokenSet: AuthSdkTokenSet,
    config: HostedAuthConfig,
    generationAtStart: number,
  ): Promise<{ committed: boolean; account: AccountInfo }> {
    if (generationAtStart !== this.generation) return { committed: false, account: { accountId: '', issuer: '' } };
    if (!tokenSet.accessToken || !tokenSet.accessToken.trim()) {
      throw new HomeClientError('AUTH_FAILED', 'Sign-in failed: the provider returned no access token.');
    }
    const origin = this.normalizeBackendUrl(backendUrl);
    if (!isTrustedIssuer(config.issuer, this.allowInsecureLoopback)) {
      throw new HomeClientError('CONTRACT_MISMATCH', 'The login issuer is not trusted.');
    }
    const account = await this.verifyAccount(origin, tokenSet.accessToken);
    if (account.issuer !== config.issuer) {
      throw new HomeClientError('AUTH_FAILED', 'Sign-in failed: the verified issuer does not match.');
    }
    const now = this.now();
    const bundle: AuthBundle = {
      accessToken: tokenSet.accessToken,
      accountId: account.accountId,
      issuer: account.issuer,
      audience: config.audience,
      backendUrl: origin,
      verifiedAt: now,
    };
    if (tokenSet.refreshToken) bundle.refreshToken = tokenSet.refreshToken;
    if (typeof tokenSet.expiresIn === 'number' && Number.isFinite(tokenSet.expiresIn) && tokenSet.expiresIn > 0) {
      const issuedAt = typeof tokenSet.issuedAt === 'number' ? tokenSet.issuedAt * 1000 : now;
      bundle.expiresAt = issuedAt + tokenSet.expiresIn * 1000;
    } else {
      bundle.expiresAt = null;
    }
    const committed = await this.commitVerifiedBundle(bundle, generationAtStart);
    return { committed, account };
  }

  /** Explicit logout: local cleanup always, even offline. Bumps generation. */
  async logout(options: {
    sdk?: AccountAuthSdk;
    config?: HostedAuthConfig;
    discovery?: AuthSdkDiscovery;
  } = {}): Promise<void> {
    this.generation += 1;
    const bundle = await this.loadBundle().catch(() => null);
    if (bundle && options.sdk && options.config && options.discovery?.revocationEndpoint) {
      try {
        await options.sdk.revokeToken?.(bundle.refreshToken ?? bundle.accessToken, options.config, options.discovery);
      } catch {
        // Revocation is best-effort; logout still completes locally.
      }
    }
    await this.secure.deleteItem(AUTH_BUNDLE_KEY).catch(() => {});
    await this.secure.deleteItem(BACKEND_ACCOUNT_TOKEN_KEY).catch(() => {});
    await this.secure.deleteItem(AUTH_BACKEND_URL_KEY).catch(() => {});
  }

  /** Backend URL change fences in-flight logins (bumps generation when changed). */
  async noteBackendUrlChanged(nextBackendUrl: string): Promise<boolean> {
    const bundle = await this.loadBundle().catch(() => null);
    const next = this.normalizeBackendUrl(nextBackendUrl);
    if (bundle && bundle.backendUrl !== next) {
      this.generation += 1;
      await this.secure.deleteItem(AUTH_BUNDLE_KEY).catch(() => {});
      await this.secure.deleteItem(BACKEND_ACCOUNT_TOKEN_KEY).catch(() => {});
      return true;
    }
    return false;
  }

  bundleNeedsRefresh(bundle: AuthBundle): boolean {
    if (!bundle.refreshToken) return false;
    if (bundle.expiresAt === null || bundle.expiresAt === undefined) return false;
    return bundle.expiresAt - this.now() <= this.refreshSkewMs;
  }

  /**
   * Maintained-SDK refresh + re-verification before commit. Identity
   * mismatch fails closed (bundle cleared). Network failure keeps the old
   * bundle so an offline home agent is never stopped by cloud expiry.
   */
  async refreshIfNeeded(
    sdk: AccountAuthSdk,
    config: HostedAuthConfig,
    discovery: AuthSdkDiscovery,
  ): Promise<AuthBundle | null> {
    const bundle = await this.loadBundle();
    if (!bundle) return null;
    if (!this.bundleNeedsRefresh(bundle)) return bundle;
    if (!bundle.refreshToken) return bundle;
    const gen = this.generation;
    let next: AuthSdkTokenSet;
    try {
      next = await sdk.refreshToken(bundle.refreshToken, config, discovery);
    } catch {
      return bundle;
    }
    if (gen !== this.generation) return null;
    if (!next.accessToken || !next.accessToken.trim()) return bundle;
    let account: AccountInfo;
    try {
      account = await this.verifyAccount(bundle.backendUrl, next.accessToken);
    } catch {
      return bundle;
    }
    if (account.accountId !== bundle.accountId || account.issuer !== bundle.issuer) {
      await this.logout();
      throw new HomeClientError(
        'AUTH_FAILED',
        'The refreshed account identity changed. Signed out to protect the previous session.',
      );
    }
    const now = this.now();
    const rotated: AuthBundle = {
      ...bundle,
      accessToken: next.accessToken,
      refreshToken: next.refreshToken ?? bundle.refreshToken,
      verifiedAt: now,
    };
    if (typeof next.expiresIn === 'number' && Number.isFinite(next.expiresIn) && next.expiresIn > 0) {
      const issuedAt = typeof next.issuedAt === 'number' ? next.issuedAt * 1000 : now;
      rotated.expiresAt = issuedAt + next.expiresIn * 1000;
    }
    const committed = await this.commitVerifiedBundle(rotated, gen);
    if (!committed) return null;
    return rotated;
  }

  private async request(
    baseUrl: string,
    path: string,
    init: { method?: string },
    body?: Record<string, unknown>,
    accountToken?: string,
  ): Promise<unknown> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (accountToken) headers['Authorization'] = `Bearer ${accountToken}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    let status: number;
    let payload: unknown;
    try {
      const target = `${baseUrl}${path}`;
      const response = await this.fetchImpl(target, {
        method: init.method ?? 'GET',
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
        redirect: 'error',
      });
      assertBackendSameOrigin(target, response.url);
      status = response.status;
      try {
        payload = await response.json();
      } catch {
        throw new HomeClientError(
          'CONTRACT_MISMATCH',
          'The backend returned an unreadable response.',
        );
      }
    } catch (error) {
      if (error instanceof HomeClientError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new HomeClientError('TIMEOUT', 'The backend did not respond in time.', true);
      }
      throw new HomeClientError('HOME_OFFLINE', 'Could not reach the backend.', true);
    } finally {
      clearTimeout(timeout);
    }
    if (status! >= 200 && status! < 300) return payload;
    if (status! === 401) {
      throw new HomeClientError('UNPAIRED', 'The backend rejected the account credential.');
    }
    if (status! === 503) {
      const body = payload as Record<string, unknown> | null;
      if (body && typeof body === 'object' && body['error'] === 'configure_not_ready') {
        throw new HomeClientError(
          'SETUP_NOT_READY',
          'Sign-in is not ready: the operator has not configured public login metadata.',
        );
      }
    }
    throw new HomeClientError(
      'HOME_OFFLINE',
      `The backend returned an error (${status!}).`,
      status! >= 500,
    );
  }
}
