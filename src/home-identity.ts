// Home identity binding (portable, pure, UI-agnostic).
//
// Threat addressed: local profile switching (demo household profiles) must
// never relabel or reveal another home user's cached private data — and the
// same local username on a DIFFERENT home (installation/device/endpoint)
// must never inherit a prior home's cache. In home mode, displayed
// conversations are bound to the FULL authenticated scope
// (user + installation + device + endpoint origin), not to the selected
// demo profile and not to a bare username. Demo mode keeps profile switching
// fully functional.
//
// Rules enforced by these helpers and their MeContext integration:
// - Home-mode visibility requires a resolved identity; before the enrollment
//   is known (e.g. right after restart) no home conversation is shown, so no
//   previous-user data can flash.
// - Any scope change (user, installation, device, endpoint) or logout
//   drops every home-mode conversation and link; demo state is untouched
//   (no blanket storage clear). Legacy links without a full scope stamp are
//   treated as unscoped and dropped — never trusted.

export interface IdentityTuple {
  userId: string;
  deviceId: string;
  installationId: string;
  homeBaseUrl: string;
}

export interface ConversationRef {
  id: string;
  profileId?: string;
  assistantMode?: 'demo' | 'home';
}

export interface HomeLinkRef {
  homeId: string;
  /** Legacy owner-only stamp (F3). Unscoped without the fields below. */
  homeOwner?: string;
  homeInstallationId?: string;
  homeDeviceId?: string;
  homeBaseUrl?: string;
  requestKey?: string;
}

export interface VisibleOptions {
  mode: 'demo' | 'home';
  activeProfileId: string;
  /** Full authenticated scope; null while unresolved. */
  homeScope: IdentityTuple | null;
  identityResolved: boolean;
}

/** Origin-normalized endpoint for scope comparison (trailing slash/case). */
export function normalizeOrigin(value: string | undefined | null): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * Strict scope match for a persisted link. Every field must be present and
 * equal (endpoint compared as origin). Legacy owner-only links never match.
 */
export function linkScopeMatches(
  link: HomeLinkRef | undefined | null,
  scope: IdentityTuple | null | undefined,
): boolean {
  if (!link?.homeId || !scope) return false;
  if (link.homeOwner !== scope.userId) return false;
  if (link.homeInstallationId !== scope.installationId) return false;
  if (link.homeDeviceId !== scope.deviceId) return false;
  const linkOrigin = normalizeOrigin(link.homeBaseUrl);
  const scopeOrigin = normalizeOrigin(scope.homeBaseUrl);
  if (!linkOrigin || !scopeOrigin || linkOrigin !== scopeOrigin) return false;
  return true;
}

/**
 * Which conversations the UI may display. Home mode ignores the demo
 * profile entirely: only conversations whose persisted link matches the
 * FULL current scope are visible, and nothing is visible until the
 * identity resolves.
 */
export function visibleConversations<T extends ConversationRef>(
  conversations: T[],
  links: Record<string, HomeLinkRef>,
  options: VisibleOptions,
): T[] {
  if (options.mode === 'demo') {
    return conversations.filter(
      (c) =>
        (c.assistantMode ?? 'demo') === 'demo' &&
        (c.profileId === undefined || c.profileId === options.activeProfileId),
    );
  }
  if (!options.identityResolved || !options.homeScope) return [];
  return conversations.filter(
    (c) =>
      (c.assistantMode ?? 'demo') === 'home' &&
      linkScopeMatches(links[c.id], options.homeScope),
  );
}

export interface ReconcileResult {
  keepConversationIds: Set<string>;
  droppedLocalIds: string[];
  links: Record<string, HomeLinkRef>;
}

/**
 * Re-scope cached state on enrollment change. Any scope-tuple change (user,
 * installation, device, endpoint) or logout (next === null) drops every
 * home-mode conversation and link; demo conversations are untouched.
 * Callers must additionally drop per-conversation UI state (tasks, typing,
 * errors, pending requests) for `droppedLocalIds`.
 */
export function reconcileOnEnrollmentChange<T extends ConversationRef>(
  prev: IdentityTuple | null,
  next: IdentityTuple | null,
  conversations: T[],
  links: Record<string, HomeLinkRef>,
): ReconcileResult {
  const same =
    prev !== null &&
    next !== null &&
    prev.userId === next.userId &&
    prev.deviceId === next.deviceId &&
    prev.installationId === next.installationId &&
    normalizeOrigin(prev.homeBaseUrl) === normalizeOrigin(next.homeBaseUrl);
  const changed = !same && (prev !== null || next !== null);
  if (!changed) {
    return {
      keepConversationIds: new Set(conversations.map((c) => c.id)),
      droppedLocalIds: [],
      links,
    };
  }
  const droppedLocalIds: string[] = [];
  const nextLinks: Record<string, HomeLinkRef> = {};
  const keepConversationIds = new Set<string>();
  for (const c of conversations) {
    if ((c.assistantMode ?? 'demo') === 'home') {
      droppedLocalIds.push(c.id);
    } else {
      keepConversationIds.add(c.id);
      if (links[c.id]) nextLinks[c.id] = links[c.id]!;
    }
  }
  return { keepConversationIds, droppedLocalIds, links: nextLinks };
}

/**
 * Sanitize a hydrated state object against the loaded credential tuple
 * BEFORE first publication: keep demo rows, keep only scope-matching home
 * rows, prune orphan links. Pure — no setState/read-timing dependence.
 */
export function filterStateToScope<
  T extends ConversationRef,
>(conversations: T[], links: Record<string, HomeLinkRef>, scope: IdentityTuple | null): {
  conversations: T[];
  links: Record<string, HomeLinkRef>;
  droppedLocalIds: string[];
} {
  const kept = conversations.filter(
    (c) => (c.assistantMode ?? 'demo') !== 'home' || linkScopeMatches(links[c.id], scope),
  );
  const keepIds = new Set(kept.map((c) => c.id));
  const droppedLocalIds = conversations
    .filter((c) => !keepIds.has(c.id))
    .map((c) => c.id);
  const prunedLinks: Record<string, HomeLinkRef> = {};
  for (const [id, link] of Object.entries(links)) {
    if (keepIds.has(id)) prunedLinks[id] = link;
  }
  return { conversations: kept, links: prunedLinks, droppedLocalIds };
}

/** Stamp a link with the full authenticated scope after a verified sync/send. */
export function stampLinkScope(
  links: Record<string, HomeLinkRef>,
  localId: string,
  scope: IdentityTuple,
): Record<string, HomeLinkRef> {
  const existing = links[localId];
  if (!existing) return links;
  return {
    ...links,
    [localId]: {
      ...existing,
      homeOwner: scope.userId,
      homeInstallationId: scope.installationId,
      homeDeviceId: scope.deviceId,
      homeBaseUrl: normalizeOrigin(scope.homeBaseUrl) ?? scope.homeBaseUrl,
    },
  };
}

/**
 * Rewrite stored link endpoints after an authorized same-installation
 * rebind (endpoint rotation). Identity fields are untouched.
 */
export function rebindLinksEndpoint(
  links: Record<string, HomeLinkRef>,
  newBaseUrl: string,
): Record<string, HomeLinkRef> {
  const origin = normalizeOrigin(newBaseUrl) ?? newBaseUrl;
  const next: Record<string, HomeLinkRef> = {};
  for (const [id, link] of Object.entries(links)) {
    next[id] = { ...link, homeBaseUrl: origin };
  }
  return next;
}

/**
 * Endpoint rotation guard: a backend-discovered endpoint may only rebind the
 * client when the live installation identity matches the registered one.
 * Missing or mismatched identities refuse — never silently pair a
 * different home.
 */
export function verifyEndpointIdentity(
  recordedInstallationId: string | undefined | null,
  observedInstallationId: string | undefined | null,
): boolean {
  if (!recordedInstallationId || !observedInstallationId) return false;
  return recordedInstallationId === observedInstallationId;
}

/** Scope token for fencing late async responses against identity changes. */
export function scopeToken(scope: IdentityTuple | null): string {
  if (!scope) return 'null';
  return `${scope.userId}|${scope.installationId}|${scope.deviceId}|${normalizeOrigin(scope.homeBaseUrl) ?? scope.homeBaseUrl}`;
}
