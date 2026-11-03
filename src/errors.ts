// Error taxonomy for the paired-home client.
// Callers (MeContext/DevicePanel successors) can switch on `code` to render
// honest UI states instead of generic "something went wrong".

export type HomeClientErrorCode =
  | 'UNPAIRED'
  | 'DEVICE_REVOKED'
  | 'INVITE_EXPIRED'
  | 'INVITE_REUSED'
  | 'INVITE_MISMATCH'
  | 'HOME_MISMATCH'
  | 'OFFLINE'
  | 'HOME_OFFLINE'
  | 'TIMEOUT'
  | 'CONTRACT_MISMATCH'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'INVALID_INPUT'
  | 'STORAGE_UNAVAILABLE'
  | 'REQUEST_KEY_CONFLICT'
  | 'WRONG_STATE'
  | 'MODEL_NOT_CONFIGURED'
  | 'SETUP_NOT_READY'
  | 'AUTH_CANCELLED'
  | 'AUTH_FAILED'
  | 'NOTIFICATIONS_DISABLED'
  | 'REGISTRATION_LIMIT'
  | 'PAIRING_REQUIRED';

export class HomeClientError extends Error {
  readonly code: HomeClientErrorCode;
  readonly retryable: boolean;

  constructor(code: HomeClientErrorCode, message: string, retryable = false) {
    super(message);
    this.name = 'HomeClientError';
    this.code = code;
    this.retryable = retryable;
  }
}

export function isHomeClientError(error: unknown): error is HomeClientError {
  return error instanceof HomeClientError;
}

/** Map an HTTP status + optional server error code to the client taxonomy. */
export function errorForStatus(
  status: number,
  serverCode?: string,
): HomeClientError {
  if (status === 401) {
    if (serverCode === 'DEVICE_REVOKED') {
      return new HomeClientError(
        'DEVICE_REVOKED',
        'This device enrollment was revoked. Pair again with a new invitation.',
        false,
      );
    }
    return new HomeClientError(
      'UNPAIRED',
      'This phone is not paired with that home. Use a one-time invitation to enroll.',
      false,
    );
  }
  if (status === 403) {
    return new HomeClientError(
      'FORBIDDEN',
      'The home refused this request for the current user/device.',
      false,
    );
  }
  if (status === 404) {
    return new HomeClientError(
      'CONTRACT_MISMATCH',
      'The home is missing the required API route. It may run an incompatible contract version.',
      false,
    );
  }
  if (status === 409 && serverCode === 'INVITE_REUSED') {
    return new HomeClientError(
      'INVITE_REUSED',
      'That invitation was already used. Each invitation enrolls at most one device.',
      false,
    );
  }
  if (status === 410) {
    return new HomeClientError(
      'INVITE_EXPIRED',
      'That invitation expired. Ask the home for a new one.',
      false,
    );
  }
  if (status === 422 && serverCode === 'INVITE_MISMATCH') {
    return new HomeClientError(
      'INVITE_MISMATCH',
      'That invitation does not match this home, user, or device key.',
      false,
    );
  }
  return new HomeClientError(
    'HOME_OFFLINE',
    `The home returned an error (${status}).`,
    status >= 500,
  );
}
