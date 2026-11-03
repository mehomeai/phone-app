// Local setup invitation paste protocol: `home-pairing-v1` (S7/F8).
//
// Trusted LOCAL setup (the home itself, e.g. Setup S7 screen) emits this
// payload; the user pastes it into the phone to pair. It is NOT a backend
// cloud hint and the backend endpointHint must never mint it.
//
// {
//   "protocol": "home-pairing-v1",
//   "home_url": "https://home.example.com",
//   "installation_id": "<uuid>",
//   "invitation_id": "inv_...",
//   "invitation_secret": "<one-time secret>",
//   "user_id": "alice"
// }
//
// Validation: bounded fields, strict protocol tag, HTTPS except explicit
// loopback-dev allowance. Returns the normalized Invitation fields plus the
// expected installation/user bindings for `enrollOneTime`. Callers clear the
// pasted secret from UI state after use/identity change and never persist it
// to AsyncStorage (SecureStore enrollment only).

import { HomeClientError } from './errors.ts';

export interface SetupInvitation {
  /** Normalized home origin (no path/query/password). */
  homeBaseUrl: string;
  installationId: string;
  invitationId: string;
  pairingSecret: string;
  expectedUserId: string;
}

const PROTOCOL_TAG = 'home-pairing-v1';
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function boundedString(value: unknown, min: number, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) return null;
  return trimmed;
}

/** Parse + validate a pasted `home-pairing-v1` invitation payload. */
export function parseSetupInvitation(
  text: string,
  options: { allowInsecureLoopback?: boolean } = {},
): SetupInvitation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HomeClientError(
      'INVALID_INPUT',
      'That setup code is not valid JSON. Copy the full invitation from the home.',
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HomeClientError('INVALID_INPUT', 'That setup code has an unexpected shape.');
  }
  const record = parsed as Record<string, unknown>;
  const protocol = boundedString(record['protocol'], 1, 64);
  if (protocol !== PROTOCOL_TAG) {
    throw new HomeClientError(
      'INVALID_INPUT',
      'That setup code is not a home pairing invitation.',
    );
  }
  const homeUrl = boundedString(record['home_url'], 8, 512);
  const installationId = boundedString(record['installation_id'], 1, 128);
  const invitationId = boundedString(record['invitation_id'], 1, 128);
  const secret = typeof record['invitation_secret'] === 'string' ? record['invitation_secret'] : null;
  const userId = boundedString(record['user_id'], 1, 128);
  if (!homeUrl || !installationId || !invitationId || !secret || !userId) {
    throw new HomeClientError(
      'INVALID_INPUT',
      'That setup code is missing fields. Copy the full invitation from the home.',
    );
  }
  if (secret.length < 8 || secret.length > 512 || /\s/.test(secret)) {
    throw new HomeClientError('INVALID_INPUT', 'That setup code has an invalid secret.');
  }
  if (!UUID_RE.test(installationId)) {
    throw new HomeClientError('INVALID_INPUT', 'That setup code names an invalid home installation.');
  }
  // URL rules mirror PairedHomeClient.normalizeBaseUrl: trusted origin only.
  let origin: string;
  try {
    const parsedUrl = new URL(homeUrl);
    const isLoopback =
      parsedUrl.hostname === 'localhost' ||
      parsedUrl.hostname === '127.0.0.1' ||
      parsedUrl.hostname === '::1';
    const secureProtocol =
      parsedUrl.protocol === 'https:' ||
      (options.allowInsecureLoopback && parsedUrl.protocol === 'http:' && isLoopback);
    if (
      !secureProtocol ||
      parsedUrl.username ||
      parsedUrl.password ||
      parsedUrl.search ||
      parsedUrl.hash ||
      (parsedUrl.pathname !== '' && parsedUrl.pathname !== '/')
    ) {
      throw new Error('untrusted');
    }
    origin = parsedUrl.origin;
  } catch {
    throw new HomeClientError(
      'INVALID_INPUT',
      'That setup code names an untrusted home address.',
    );
  }
  return {
    homeBaseUrl: origin,
    installationId,
    invitationId,
    pairingSecret: secret,
    expectedUserId: userId,
  };
}
