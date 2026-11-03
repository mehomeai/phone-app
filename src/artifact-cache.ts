// Portable artifact file-naming / scoping / limits (pure, zero deps).
//
// Task deliverables (animation/code outputs) must be usable: the phone saves
// fetched artifact bytes to its app-private cache and lets the user Open/Share
// them via the native sheet. This module owns ONLY the pure, Node-testable
// policy so native code cannot get it wrong:
//
// - Scoping: cached files live under a directory derived from the FULL
//   paired identity (user + installation + device + endpoint origin). A
//   different user/installation/device/endpoint gets a different directory;
//   unenroll/identity-change clears the previous scope directory.
// - Naming: server-supplied names are NEVER trusted as paths. They are
//   sanitized to a flat `[A-Za-z0-9._-]` basename (no `/`, `\`, `..`,
//   drive, or null bytes) and prefixed with a random hex segment.
// - Limits: hard max bytes (refuse-to-save), bounded text preview length,
//   image allowlist. HTML/SVG/JS never render inline (no arbitrary code
//   execution); they are share-only via the native viewer, never WebView.
// - Credentials are never files: only artifact bytes are written; device
//   secrets/session tokens stay in SecureStorage and are never passed here.
//
// Native I/O lives in `apps/mobile/lib/artifact-store.ts` (Expo FileSystem +
// Sharing, web blob fallback). That layer must report success ONLY after the
// write completes, and must check the F4 identity fence before presenting.

import type { IdentityTuple } from './home-identity.ts';
import { normalizeOrigin, scopeToken } from './home-identity.ts';

/** Refuse-to-save ceiling: artifacts larger than this are never cached. */
export const ARTIFACT_MAX_BYTES = 10 * 1024 * 1024;

/** Inline text preview is bounded (chars, not bytes). */
export const ARTIFACT_TEXT_PREVIEW_MAX_CHARS = 4000;

/** Random filename segment length (hex chars). */
export const ARTIFACT_RANDOM_HEX_LEN = 8;

/** Sanitized basename ceiling (incl. extension). */
export const ARTIFACT_BASENAME_MAX_LEN = 100;

const SAFE_CHARS_RE = /[^A-Za-z0-9._-]/g;
const RANDOM_HEX_RE = /^[0-9a-f]{8,16}$/;

const TEXT_EXTS = new Set(['.txt', '.md', '.markdown', '.json', '.log', '.csv']);
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const BLOCKED_INLINE_EXTS = new Set([
  '.html',
  '.htm',
  '.xhtml',
  '.svg',
  '.js',
  '.mjs',
  '.cjs',
]);

const MIME_BY_EXT: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.json': 'application/json',
  '.log': 'text/plain',
  '.csv': 'text/csv',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
};

export function artifactExt(name: string): string {
  const base = String(name ?? '').split(/[?#]/)[0] ?? '';
  const dot = base.lastIndexOf('.');
  if (dot < 0) return '';
  const ext = base.slice(dot).toLowerCase();
  return /^[.][a-z0-9]{1,10}$/.test(ext) ? ext : '';
}

/**
 * Sanitize an untrusted server-supplied artifact name to a flat basename.
 * Never returns a path: no slashes, no `..`, no drive, no leading dots.
 * Falls back to `artifact` (+ safe extension when recognizable).
 */
export function sanitizeArtifactFilename(name: unknown): string {
  const raw = typeof name === 'string' ? name : '';
  // Take only the final segment across both separators; drop query/fragment.
  const cut = raw.split(/[?#]/)[0] ?? '';
  const segments = cut.split(/[\\/]/);
  let base = segments[segments.length - 1] ?? '';
  // Strip null bytes and trim.
  base = base.replace(/\0/g, '').trim();
  // Preserve a recognizable extension, sanitize stem and ext separately.
  const ext = artifactExt(base);
  let stem = ext ? base.slice(0, -ext.length) : base;
  stem = stem.replace(SAFE_CHARS_RE, '_').replace(/_+/g, '_');
  stem = stem.replace(/^[._-]+/, '').replace(/[._-]+$/, '');
  if (!stem) stem = 'artifact';
  let out = ext ? `${stem}${ext}` : stem;
  // Enforce ceiling while keeping the extension.
  if (out.length > ARTIFACT_BASENAME_MAX_LEN) {
    if (ext) {
      const keep = ARTIFACT_BASENAME_MAX_LEN - ext.length;
      out = `${stem.slice(0, Math.max(1, keep))}${ext}`;
    } else {
      out = stem.slice(0, ARTIFACT_BASENAME_MAX_LEN);
    }
  }
  if (out === '.' || out === '..') return 'artifact';
  return out;
}

/** FNV-1a 32-bit hex (stable, dependency-free scope hash). */
export function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** Scope token hash for directory naming (no secrets: tuple holds IDs only). */
export function scopedArtifactDirName(scope: IdentityTuple | null | undefined): string {
  if (!scope) return 'artifacts-unscoped';
  const token = scopeToken({
    userId: scope.userId,
    deviceId: scope.deviceId,
    installationId: scope.installationId,
    homeBaseUrl: normalizeOrigin(scope.homeBaseUrl) ?? scope.homeBaseUrl,
  });
  return `artifacts-${fnv1aHex(token)}`;
}

export function randomArtifactHex(rand: () => number = Math.random): string {
  let out = '';
  while (out.length < ARTIFACT_RANDOM_HEX_LEN) {
    out += Math.floor(rand() * 0xffff)
      .toString(16)
      .padStart(4, '0');
  }
  return out.slice(0, ARTIFACT_RANDOM_HEX_LEN);
}

/**
 * Build the cached filename: `<randomHex>-<sanitized>`. The random prefix
 * prevents collisions and stops a malicious name from predicting paths.
 */
export function buildCachedArtifactFilename(
  artifactId: unknown,
  name: unknown,
  randomHex?: string,
): string {
  const safeRandom =
    typeof randomHex === 'string' && RANDOM_HEX_RE.test(randomHex)
      ? randomHex
      : randomArtifactHex();
  const fallback = typeof artifactId === 'string' && artifactId.trim()
    ? `artifact-${sanitizeArtifactFilename(artifactId)}`
    : 'artifact';
  const sanitized = sanitizeArtifactFilename(name);
  const base = sanitized === 'artifact' ? fallback : sanitized;
  return `${safeRandom}-${base}`;
}

/** Throw when the byte length exceeds the refuse-to-save ceiling. */
export function assertArtifactSizeOk(length: number): void {
  if (!Number.isFinite(length) || length < 0) {
    throw new Error('Artifact has an unreadable size.');
  }
  if (length > ARTIFACT_MAX_BYTES) {
    throw new Error(
      `Artifact is too large to save on this device (${length} bytes; limit ${ARTIFACT_MAX_BYTES}).`,
    );
  }
  if (length === 0) {
    throw new Error('Artifact is empty; nothing was saved.');
  }
}

export function isPreviewableText(name: unknown): boolean {
  return TEXT_EXTS.has(artifactExt(typeof name === 'string' ? name : ''));
}

export function isPreviewableImage(name: unknown): boolean {
  return IMAGE_EXTS.has(artifactExt(typeof name === 'string' ? name : ''));
}

/**
 * Blocked from INLINE rendering (arbitrary HTML/JS execution risk, SVG
 * scriptability). These remain share-only via the native viewer — never a
 * WebView, never an <img> with scriptable content, never openURL.
 */
export function isBlockedInlinePreview(name: unknown): boolean {
  return BLOCKED_INLINE_EXTS.has(artifactExt(typeof name === 'string' ? name : ''));
}

/** Inline preview is allowed only for bounded text or safe raster images. */
export function canPreviewInline(name: unknown): boolean {
  if (isBlockedInlinePreview(name)) return false;
  return isPreviewableText(name) || isPreviewableImage(name);
}

export function mimeTypeForFilename(name: unknown): string {
  const ext = artifactExt(typeof name === 'string' ? name : '');
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

/** Bounded UTF-8 text preview (never the full file for large artifacts). */
export function decodeTextPreview(
  bytes: Uint8Array,
  maxChars: number = ARTIFACT_TEXT_PREVIEW_MAX_CHARS,
): string {
  const cap = Math.max(0, Math.min(maxChars, ARTIFACT_TEXT_PREVIEW_MAX_CHARS));
  try {
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    return text.length > cap ? text.slice(0, cap) : text;
  } catch {
    return '';
  }
}
