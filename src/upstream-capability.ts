// Upstream capability profile (portable, pure, UI-agnostic).
//
// The home backend MAY report which agent profile it serves (Task A owns the
// fields; phone never invents endpoints). Until Task A publishes the OPTIONAL
// capability fields, every value here parses to null (unknown) and the phone
// honestly stays on explicit legacy compat or demo — never silently claiming
// FULL upstream execution.
//
// Rules enforced here:
// - Only real booleans count (truthy strings never enable FULL; mirrors the
//   home H3 hardening for capability values).
// - Bounded `missing` list (<=20 entries, each <=200 chars).
// - `selectExecutionMode('full', ...)` without a complete FULL capability
//   returns 'setup-needed', never a silent legacy fallback.

export type UpstreamAgentMode = 'legacy' | 'full-upstream';

export interface UpstreamCapability {
  agentMode: UpstreamAgentMode;
  fullConfigured: boolean;
  needsSetup: boolean;
  /** Bounded operator-facing missing pieces (e.g. license, model, OAuth). */
  missing: string[];
}

/** What the phone may actually execute for a conversation. */
export type UpstreamExecutionSelection =
  | 'demo'
  | 'legacy'
  | 'full'
  | 'setup-needed';

export type RequestedUpstreamMode = 'demo' | 'legacy' | 'full';

const MAX_MISSING_ENTRIES = 20;
const MAX_MISSING_CHARS = 200;

/**
 * Parse an OPTIONAL home capability report. Returns null when the home does
 * not report a capability (unknown — not an error). Returns null for any
 * malformed value rather than guessing.
 */
export function parseUpstreamCapability(
  value: unknown,
): UpstreamCapability | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const agentMode = record['agentMode'];
  if (agentMode !== 'legacy' && agentMode !== 'full-upstream') return null;
  const fullConfigured = record['fullConfigured'];
  const needsSetup = record['needsSetup'];
  if (typeof fullConfigured !== 'boolean') return null;
  if (typeof needsSetup !== 'boolean') return null;
  const missingRaw = record['missing'];
  let missing: string[] = [];
  if (missingRaw !== undefined) {
    if (!Array.isArray(missingRaw)) return null;
    if (missingRaw.length > MAX_MISSING_ENTRIES) return null;
    for (const entry of missingRaw) {
      if (typeof entry !== 'string') return null;
      const trimmed = entry.trim();
      if (trimmed.length === 0 || trimmed.length > MAX_MISSING_CHARS) {
        return null;
      }
      missing = [...missing, trimmed];
    }
  }
  return { agentMode, fullConfigured, needsSetup, missing };
}

/**
 * Decide what the phone may execute. A requested FULL mode without a
 * complete FULL capability resolves to 'setup-needed' — the UI must show the
 * home-setup state instead of silently running the legacy engine.
 */
export function selectExecutionMode(
  requested: RequestedUpstreamMode,
  capability: UpstreamCapability | null,
): UpstreamExecutionSelection {
  if (requested === 'demo') return 'demo';
  if (requested === 'legacy') return 'legacy';
  if (
    capability !== null &&
    capability.agentMode === 'full-upstream' &&
    capability.fullConfigured === true &&
    capability.needsSetup === false
  ) {
    return 'full';
  }
  return 'setup-needed';
}

/** True when FULL was requested but the home is not ready for it. */
export function isUpstreamSetupNeeded(
  requested: RequestedUpstreamMode,
  capability: UpstreamCapability | null,
): boolean {
  return selectExecutionMode(requested, capability) === 'setup-needed';
}

export interface AppSelectionInput {
  /** Demo never touches the home, regardless of anything else. */
  assistantMode: 'demo' | 'home';
  /** Owner default is 'full' (section 3): advertised full homes go
   * full/setup-needed without any manual toggle. */
  requested: RequestedUpstreamMode;
  /** Latest parsed OPTIONAL home report (null = none received/parsable). */
  capability: UpstreamCapability | null;
  /**
   * True once a capability fetch has COMPLETED (success or honest failure)
   * for the current pairing. Distinguishes "old home that never reports
   * fields" (explicit legacy compat) from "not yet asked" (setup-needed,
   * never silent legacy for new work).
   */
  capabilityResolved: boolean;
}

/**
 * Actual app decision (tested against real capability reports, not only the
 * pure selectExecutionMode matrix). New FULL work on an incomplete or
 * not-yet-known home resolves to 'setup-needed' and the UI must block it
 * honestly; resolved old homes without capability fields stay 'legacy'
 * compat (existing legacy rows keep working, no channel conversion).
 */
export function resolveAppSelection(input: AppSelectionInput): UpstreamExecutionSelection {
  if (input.assistantMode === 'demo') return 'demo';
  if (input.requested === 'legacy') return 'legacy';
  const capability = input.capability;
  if (!input.capabilityResolved) return 'setup-needed';
  if (capability === null) return 'legacy';
  if (capability.agentMode === 'legacy') return 'legacy';
  if (capability.fullConfigured === true && capability.needsSetup === false) {
    return 'full';
  }
  return 'setup-needed';
}

/**
 * Honest operator-facing message for the setup-needed state. Bounded: at
 * most the first 5 missing entries are named; never echoes secrets (the
 * parser only keeps short display strings).
 */
export function describeUpstreamSetupNeeded(
  capability: UpstreamCapability | null,
): string {
  const base =
    "This home isn't set up for the full agent yet. Whoever runs your home needs to finish setup before it can run here.";
  if (capability === null) {
    return `${base} No capability report was received from this home.`;
  }
  if (capability.missing.length === 0) {
    return base;
  }
  const named = capability.missing.slice(0, 5).join(', ');
  const rest =
    capability.missing.length > 5
      ? ` (+${capability.missing.length - 5} more)`
      : '';
  return `${base} Missing: ${named}${rest}.`;
}
