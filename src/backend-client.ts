// Backend coordination adapter (B1): account/home membership distinct from
// home user identity. The hosted backend coordinates accounts, home
// registration/discovery, join tickets, and presence — it never sees private
// traffic, H1 device credentials, or session tokens. Identity always derives
// from the presented credential; this client never sends account/user ids.

import { HomeClientError } from './errors.ts';
import { redactHeaders } from './secure-storage.ts';
import type { SecureStorage } from './secure-storage.ts';

export const BACKEND_URL_KEY = 'me.backend.url.v1';
export const BACKEND_ACCOUNT_TOKEN_KEY = 'me.backend.account-token.v1';

export interface MemberHome {
  homeId: string;
  displayName?: string;
  installationId?: string;
  endpointHint?: string;
  protocolVersion?: string;
  createdAt?: number;
  lastSeenAt?: number;
  lastStatus?: string;
  role?: string;
}

/**
 * One-time home-activation capability (home-activation-v1, F9/B7).
 *
 * Minted by the logged-in owner phone with its account bearer; redeemed by
 * the home operator over HTTPS with the ticket alone (NO account JWT ever
 * leaves the phone). Capability-only: never a homeToken, never account
 * credentials, never provider secrets. The phone NEVER calls
 * POST /v1/homes/activate — this client has no such method by design.
 */
export type ActivationTicketMode = 'new' | 'recovery';

export interface ActivationTicket {
  ticketId: string;
  activationSecret: string;
  installationId: string;
  mode: ActivationTicketMode;
  homeId: string | null;
  expiresAt: string;
}

export interface MintActivationTicketInput {
  /** Physical home installationId copied from home setup prepare (H1 verbatim). */
  installationId: string;
  /** Optional display name for the to-be-created home (new-only). */
  displayName?: string;
  /** Recovery-only: must be an owned, installation-matching home (pre-checked). */
  existingHomeId?: string;
}

/**
 * One-time handoff JSON the owner copies to the home operator (S7 stdin).
 * Ephemeral by contract: displayed/copied once, never persisted or logged.
 */
export interface ActivationHandoff {
  backend_url: string;
  ticketId: string;
  activationSecret: string;
  installationId: string;
  mode: ActivationTicketMode;
  homeId?: string;
  expiresAt: string;
}

const INSTALLATION_ID_RE = /^[\x20-\x7E]{1,128}$/;
const HOME_ID_RE = /^[a-z0-9][a-z0-9_-]{2,63}$/;

/** Fail-closed expiry check for the ephemeral one-time ticket UI. */
export function isActivationTicketExpired(ticket: ActivationTicket, now: number = Date.now()): boolean {
  const parsed = Date.parse(ticket.expiresAt);
  if (Number.isNaN(parsed)) return true;
  return parsed <= now;
}

export interface BackendCoordinatorOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  requestTimeoutMs?: number;
  allowInsecureLoopback?: boolean;
}

export class BackendCoordinator {
  private readonly fetchImpl: (
    input: string,
    init?: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
      signal?: AbortSignal;
      redirect?: 'error' | 'follow' | 'manual';
    },
  ) => Promise<{ status: number; url?: string; json(): Promise<unknown> }>;
  private readonly secure: SecureStorage;
  private readonly requestTimeoutMs: number;
  private readonly allowInsecureLoopback: boolean;

  constructor(secureStorage: SecureStorage, options: BackendCoordinatorOptions = {}) {
    this.secure = secureStorage;
    this.fetchImpl = (options.fetchImpl ?? fetch) as unknown as BackendCoordinator['fetchImpl'];
    this.requestTimeoutMs = options.requestTimeoutMs ?? 20_000;
    this.allowInsecureLoopback = options.allowInsecureLoopback ?? false;
  }

  normalizeBaseUrl(value: string): string {
    let parsed: URL;
    try {
      parsed = new URL(value.trim());
    } catch {
      throw new HomeClientError('INVALID_INPUT', 'Enter a valid backend address.');
    }
    const isLoopback =
      parsed.hostname === 'localhost' ||
      parsed.hostname === '127.0.0.1' ||
      parsed.hostname === '::1';
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

  /** Persist backend coordination config (account token stays in SecureStorage). */
  async configureBackend(backendUrl: string, accountToken: string): Promise<string> {
    const origin = this.normalizeBaseUrl(backendUrl);
    const token = accountToken.trim();
    if (!token) {
      throw new HomeClientError('INVALID_INPUT', 'Enter an account token for this backend.');
    }
    await this.secure.setItem(BACKEND_URL_KEY, origin);
    await this.secure.setItem(BACKEND_ACCOUNT_TOKEN_KEY, token);
    return origin;
  }

  async clearBackend(): Promise<void> {
    await this.secure.deleteItem(BACKEND_URL_KEY);
    await this.secure.deleteItem(BACKEND_ACCOUNT_TOKEN_KEY);
  }

  async backendConfig(): Promise<{ backendUrl: string } | null> {
    const backendUrl = await this.secure.getItem(BACKEND_URL_KEY);
    const token = await this.secure.getItem(BACKEND_ACCOUNT_TOKEN_KEY);
    if (!backendUrl || !token) return null;
    return { backendUrl };
  }

  async checkHealth(
    backendUrl?: string,
  ): Promise<{ ok: boolean; service: string }> {
    const origin = backendUrl ?? (await this.secure.getItem(BACKEND_URL_KEY));
    if (!origin) {
      throw new HomeClientError('UNPAIRED', 'No backend configured.');
    }
    const payload = (await this.request(origin, '/healthz', {
      method: 'GET',
    })) as { ok?: unknown; service?: unknown };
    if (payload.ok !== true) {
      throw new HomeClientError(
        'CONTRACT_MISMATCH',
        'This address did not identify a Me backend service.',
      );
    }
    return {
      ok: true,
      service: typeof payload.service === 'string' ? payload.service : '',
    };
  }

  /** Homes this account belongs to (members-only discovery). */
  async discoverHomes(): Promise<MemberHome[]> {
    const { origin, token } = await this.requireConfig();
    const payload = (await this.request(
      origin,
      '/v1/homes',
      { method: 'GET' },
      undefined,
      token,
    )) as { homes?: Array<MemberHome & { membershipRole?: unknown }> };
    if (!Array.isArray(payload.homes)) {
      throw new HomeClientError(
        'CONTRACT_MISMATCH',
        'Home discovery had an unexpected shape.',
      );
    }
    // B7 discovery carries the caller's membership as `membershipRole`;
    // normalize onto `role` so recovery pre-checks read one field.
    return payload.homes.map((home) => {
      if (home && typeof home === 'object' && typeof home.membershipRole === 'string') {
        const { membershipRole, ...rest } = home;
        return { ...rest, role: membershipRole };
      }
      return home;
    });
  }

  /** Presence for one member home (stale/absent heartbeat = offline). */
  async homeStatus(
    homeId: string,
  ): Promise<{ homeId: string; lastSeenAt?: number; lastStatus?: string }> {
    const { origin, token } = await this.requireConfig();
    return (await this.request(
      origin,
      `/v1/homes/${encodeURIComponent(homeId)}/status`,
      { method: 'GET' },
      undefined,
      token,
    )) as { homeId: string; lastSeenAt?: number; lastStatus?: string };
  }

  /**
   * Join a home with a single-use join ticket (account↔home membership).
   * This is coordination-only: it is NOT the H1 one-time pairing invitation
   * for device enrollment, and the two secrets must never be conflated.
   */
  async joinHome(homeId: string, ticketSecret: string): Promise<void> {
    const { origin, token } = await this.requireConfig();
    if (!ticketSecret.trim()) {
      throw new HomeClientError('INVALID_INPUT', 'Enter the join ticket secret.');
    }
    await this.request(
      origin,
      `/v1/homes/${encodeURIComponent(homeId)}/members/join`,
      { method: 'POST' },
      { ticketSecret: ticketSecret.trim() },
      token,
    );
  }

  /**
   * Mint a one-time home-activation ticket (account auth, B7).
   *
   * Single attempt, no autonomous retries: a transport failure leaves the
   * outcome unknown and the caller decides explicitly (minting again is a
   * deliberate user action, never an automatic loop). Recovery
   * (`existingHomeId`) is pre-checked against the account's own discovered
   * homes (owner role + exact installation match) and refused locally before
   * any mint POST; the backend remains authoritative and re-checks.
   *
   * The returned ticket is ephemeral caller-owned state: this client never
   * persists, caches, or logs it (no SecureStorage/cache writes here).
   */
  async mintActivationTicket(input: MintActivationTicketInput): Promise<ActivationTicket> {
    const { origin, token } = await this.requireConfig();
    const installationId = (input.installationId ?? '').trim();
    if (!INSTALLATION_ID_RE.test(installationId)) {
      throw new HomeClientError(
        'INVALID_INPUT',
        'Enter the installation ID exactly as shown by the home setup prepare step.',
      );
    }
    let displayName: string | undefined;
    if (input.displayName !== undefined) {
      const clean = input.displayName.trim();
      if (!clean || clean.length > 100) {
        throw new HomeClientError(
          'INVALID_INPUT',
          'The display name must be 1–100 characters.',
        );
      }
      displayName = clean;
    }
    const expectedMode: ActivationTicketMode =
      input.existingHomeId === undefined ? 'new' : 'recovery';
    let existingHomeId: string | undefined;
    if (input.existingHomeId !== undefined) {
      const clean = input.existingHomeId.trim();
      if (!HOME_ID_RE.test(clean)) {
        throw new HomeClientError('INVALID_INPUT', 'That recovery home ID is invalid.');
      }
      // Recovery pre-check: only an owned home with the exact installation.
      // Backend-authoritative — this is a local refuse-before-send only.
      const homes = await this.discoverHomes();
      const home = homes.find((h) => h.homeId === clean);
      if (!home) {
        throw new HomeClientError(
          'NOT_FOUND',
          'That home is not visible to this account. Recovery mint refused before sending.',
        );
      }
      if (home.role !== 'owner') {
        throw new HomeClientError(
          'FORBIDDEN',
          'Only the home owner can mint a recovery ticket. Nothing was sent.',
        );
      }
      if (home.installationId && home.installationId !== installationId) {
        throw new HomeClientError(
          'FORBIDDEN',
          'That recovery home belongs to a different installation. Nothing was sent.',
        );
      }
      existingHomeId = clean;
    }
    const body: Record<string, unknown> = { installationId };
    if (displayName !== undefined) body['displayName'] = displayName;
    if (existingHomeId !== undefined) body['existingHomeId'] = existingHomeId;
    // Never smuggle identity or credential fields: homeId/accountId/ownerId
    // and any token material are rejected 400 server-side and never built here.
    const payload = await this.request(
      origin,
      '/v1/homes/activation-tickets',
      { method: 'POST' },
      body,
      token,
      errorForActivationStatus,
    );
    return parseActivationTicket(payload, { installationId, expectedMode, existingHomeId });
  }

  /**
   * Build the one-time handoff JSON for the home operator. Pure projection:
   * backend URL + ticket fields only, never credentials or token material.
   */
  buildActivationHandoff(backendUrl: string, ticket: ActivationTicket): ActivationHandoff {
    const origin = this.normalizeBaseUrl(backendUrl);
    if (isActivationTicketExpired(ticket)) {
      throw new HomeClientError(
        'INVITE_EXPIRED',
        'That activation ticket already expired. Mint a fresh one.',
      );
    }
    const handoff: ActivationHandoff = {
      backend_url: origin,
      ticketId: ticket.ticketId,
      activationSecret: ticket.activationSecret,
      installationId: ticket.installationId,
      mode: ticket.mode,
      expiresAt: ticket.expiresAt,
    };
    if (ticket.mode === 'recovery' && ticket.homeId) {
      handoff.homeId = ticket.homeId;
    }
    return handoff;
  }

  /** Resolve the protected home endpoint from backend discovery metadata. */
  async resolveHomeBaseUrl(homeId: string): Promise<string> {
    const homes = await this.discoverHomes();
    const home = homes.find((h) => h.homeId === homeId);
    if (!home?.endpointHint) {
      throw new HomeClientError(
        'UNPAIRED',
        'That home has no endpoint registered. Ask the home owner to heartbeat first.',
      );
    }
    return home.endpointHint;
  }

  private async requireConfig(): Promise<{ origin: string; token: string }> {
    const origin = await this.secure.getItem(BACKEND_URL_KEY);
    const token = await this.secure.getItem(BACKEND_ACCOUNT_TOKEN_KEY);
    if (!origin || !token) {
      throw new HomeClientError(
        'UNPAIRED',
        'No backend coordination configured. Enter the backend address and account token first.',
      );
    }
    return { origin, token };
  }

  private async request(
    baseUrl: string,
    path: string,
    init: { method?: string },
    body?: Record<string, unknown>,
    accountToken?: string,
    mapError: (status: number) => HomeClientError = (status) => this.errorForStatus(status),
  ): Promise<unknown> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (accountToken) headers['Authorization'] = `Bearer ${accountToken}`;
    void redactHeaders(headers);
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
        // Account credentials must never be forwarded across origins.
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
    throw mapError(status!);
  }

  private errorForStatus(status: number): HomeClientError {    if (status === 401) {
      return new HomeClientError(
        'UNPAIRED',
        'The backend rejected the account credential.',
      );
    }
    if (status === 403) {
      return new HomeClientError(
        'FORBIDDEN',
        'That ticket is invalid for this home, or the account is not a member.',
      );
    }
    if (status === 404) {
      return new HomeClientError(
        'NOT_FOUND',
        'That home is not visible to this account.',
      );
    }
    if (status === 409) {
      return new HomeClientError(
        'INVITE_REUSED',
        'This account already joined that home.',
      );
    }
    if (status === 410) {
      return new HomeClientError(
        'INVITE_EXPIRED',
        'That join ticket was already used or expired. Ask for a new one.',
      );
    }
    if (status === 400) {
      return new HomeClientError('INVALID_INPUT', 'The backend rejected the request.');
    }
    return new HomeClientError(
      'HOME_OFFLINE',
      `The backend returned an error (${status}).`,
      status >= 500,
    );
  }
}

/**
 * Strict capability-shape validation for POST /v1/homes/activation-tickets.
 * Rejects anything that is not exactly the documented capability: wrong
 * mode, mismatched installation, missing/extra identity, unparseable
 * expiry, or any leaked homeToken/account-credential material.
 */
export function parseActivationTicket(
  raw: unknown,
  request: { installationId: string; expectedMode: ActivationTicketMode; existingHomeId?: string },
): ActivationTicket {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new HomeClientError(
      'CONTRACT_MISMATCH',
      'The activation ticket had an unexpected shape.',
    );
  }
  const body = raw as Record<string, unknown>;
  const fail = (): never => {
    throw new HomeClientError(
      'CONTRACT_MISMATCH',
      'The activation ticket had an unexpected shape.',
    );
  };
  const ticketId = body['ticketId'];
  const activationSecret = body['activationSecret'];
  const installationId = body['installationId'];
  const mode = body['mode'];
  const homeId = body['homeId'];
  const expiresAt = body['expiresAt'];
  if (
    typeof ticketId !== 'string' ||
    !ticketId.startsWith('act_') ||
    typeof activationSecret !== 'string' ||
    !activationSecret ||
    typeof installationId !== 'string' ||
    (mode !== 'new' && mode !== 'recovery') ||
    typeof expiresAt !== 'string' ||
    Number.isNaN(Date.parse(expiresAt))
  ) {
    fail();
  }
  if ((installationId as string) !== request.installationId) fail();
  if ((mode as ActivationTicketMode) !== request.expectedMode) fail();
  if (request.expectedMode === 'recovery') {
    if (typeof homeId !== 'string' || homeId !== request.existingHomeId) fail();
  } else if (homeId !== null && homeId !== undefined) {
    fail();
  }
  // Privacy rule (load-bearing): the capability must never carry reusable
  // credential material — no homeToken, no account JWT, no provider secret.
  if ('homeToken' in body || 'home_token' in body || 'accountToken' in body) fail();
  if ((activationSecret as string).startsWith('me_home_')) fail();
  try {
    if (JSON.stringify(body).includes('me_home_')) fail();
  } catch {
    fail();
  }
  return {
    ticketId: ticketId as string,
    activationSecret: activationSecret as string,
    installationId: installationId as string,
    mode: mode as ActivationTicketMode,
    homeId: request.expectedMode === 'recovery' ? (homeId as string) : null,
    expiresAt: expiresAt as string,
  };
}

/** Activation-mint error taxonomy (home-activation-v1 §6). No retries. */
export function errorForActivationStatus(status: number): HomeClientError {
  if (status === 401) {
    return new HomeClientError(
      'UNPAIRED',
      'The backend rejected the account credential. Sign in again.',
    );
  }
  if (status === 403) {
    return new HomeClientError(
      'FORBIDDEN',
      'The backend refused the ticket request: not the home owner, installation mismatch, or wrong ticket type. Nothing was minted.',
    );
  }
  if (status === 404) {
    return new HomeClientError(
      'NOT_FOUND',
      'That home is not visible to this account.',
    );
  }
  if (status === 410) {
    return new HomeClientError(
      'INVITE_EXPIRED',
      'That activation ticket expired or was already used. Mint a fresh one.',
    );
  }
  if (status === 429) {
    return new HomeClientError(
      'REGISTRATION_LIMIT',
      'Too many active activation tickets for this account. Use one or let them expire.',
    );
  }
  if (status === 400) {
    return new HomeClientError('INVALID_INPUT', 'The backend rejected the activation request.');
  }
  return new HomeClientError(
    'HOME_OFFLINE',
    `The backend returned an error (${status}).`,
    status >= 500,
  );
}

/**
 * Final-URL origin guard for account-credentialed backend requests.
 * Mirrors the home client's protection: `redirect: 'error'` plus a refusal
 * on any reported cross-origin outcome. See `assertSameOrigin` in
 * paired-home-client.ts for the native-stack rationale.
 */
export function assertBackendSameOrigin(requestTarget: string, finalUrl: string | undefined): void {
  if (!finalUrl) return;
  let requestOrigin: string;
  let finalOrigin: string;
  try {
    requestOrigin = new URL(requestTarget).origin;
    finalOrigin = new URL(finalUrl).origin;
  } catch {
    throw new HomeClientError(
      'CONTRACT_MISMATCH',
      'The backend returned an unreadable address. Refusing to continue.',
    );
  }
  if (requestOrigin !== finalOrigin) {
    throw new HomeClientError(
      'CONTRACT_MISMATCH',
      'The backend redirected to a different origin. Credentials were not re-issued there; verify the backend address before retrying.',
    );
  }
}
