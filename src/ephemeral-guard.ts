// Ephemeral one-time-secret request guard (F9 review).
//
// A screen that mints a one-time secret must never publish a late response
// after the user backgrounded, discarded, unmounted, or changed account:
// the cleared secret would otherwise reappear. This module is the single
// reusable mechanism the native ticket UI and the contract tests share:
//   - tryAcquire() grants at most one in-flight request (double-tap safe:
//     the second tap before the first settles gets null, never a second
//     mint). Release is generation-scoped, so a late finally cannot free a
//     newer request's slot.
//   - invalidate() retires the current generation (clear / discard /
//     background / account change incl. logout→login to the SAME identity /
//     unmount) and frees any in-flight slot.
//   - isCurrent(gen) MUST be checked after EVERY await before publishing UI
//     state (ticket, handoff, or copy feedback). Expired arrivals are never
//     published (see shouldPublishTicketArrival).
// Wiping the OS clipboard on scope clear is deliberately NOT done here:
// ownership of the clipboard cannot be proven afterwards, and clearing it
// would destroy text the user copied themselves.

import { isActivationTicketExpired } from './backend-client.ts';
import type { ActivationTicket } from './backend-client.ts';

export class EphemeralRequestGuard {
  private generation = 0;
  private owner: number | null = null;

  /** Current generation; capture before an await, verify after. */
  current(): number {
    return this.generation;
  }

  /**
   * Claim the single in-flight slot. Returns the generation to fence the
   * request with, or null when a request is already in flight (double-tap).
   */
  tryAcquire(): number | null {
    if (this.owner !== null) return null;
    this.owner = this.generation;
    return this.generation;
  }

  /** Free the slot, but only when the caller still owns it. */
  release(generation: number): void {
    if (this.owner === generation) this.owner = null;
  }

  /** Retire the generation: cleared, discarded, backgrounded, account moved. */
  invalidate(): void {
    this.generation += 1;
    this.owner = null;
  }

  /** True when no invalidate() happened since the generation was captured. */
  isCurrent(generation: number): boolean {
    return generation === this.generation;
  }
}

/** Stable fingerprint for the account scope a ticket request belongs to. */
export function activationScopeFingerprint(input: {
  accountId: string | null;
  issuer: string | null;
  backendUrl: string | null;
  status: string;
}): string {
  return `${input.accountId ?? ''}|${input.issuer ?? ''}|${input.backendUrl ?? ''}|${input.status}`;
}

/** A just-arrived ticket may be published only when current AND unexpired. */
export function shouldPublishTicketArrival(
  ticket: ActivationTicket,
  generation: number,
  guard: EphemeralRequestGuard,
): boolean {
  return guard.isCurrent(generation) && !isActivationTicketExpired(ticket);
}

/** Stale copy feedback must never appear after a scope change or discard. */
export function shouldPublishCopyFeedback(
  generation: number,
  guard: EphemeralRequestGuard,
): boolean {
  return guard.isCurrent(generation);
}

/**
 * Honest message when a mint call returns without a ticket. The outcome is
 * genuinely unknown (a timeout may follow a server-side mint), so nothing
 * is asserted about what was or was not created, and nothing is retried
 * automatically. A fresh ticket can always be minted; any server-created
 * ticket expires on its own.
 */
export const UNKNOWN_TICKET_OUTCOME_MESSAGE =
  'The ticket request did not complete — its outcome is unknown and it was ' +
  'not retried automatically. Mint a fresh ticket when ready; any ticket ' +
  'the server may have created expires on its own.';
