// Native artifact persistence: app-private cache + Share sheet + preview.
//
// Pure policy (names, scoping, limits, preview allowlist) lives in the
// portable `src/artifact-cache.ts` and is imported here with an explicit
// `.ts` extension (same pattern as `@/lib/home-client`). This module only
// performs the platform I/O:
//
// - Native: Expo FileSystem (SDK58 `File`/`Directory`/`Paths`) under
//   `Paths.cache/<scopedArtifactDirName(scope)>`, then `expo-sharing`
//   `shareAsync` for the user-invoked Share sheet and `File.preview()` for
//   user-invoked Open. Success is reported ONLY after the write verifies.
// - Web: blob download fallback (`URL.createObjectURL` + anchor).
// - Unsupported/missing native modules produce clear prerequisite errors,
//   never a fabricated "saved" status.
//
// Security rules enforced here:
// - Server names are never paths (`sanitizeArtifactFilename` + random prefix).
// - Directories are scoped by the FULL paired identity; unenroll/identity
//   change clears the previous scope directory (see `clearScopedArtifactCache`
//   and the MeContext calls on revoke/logout/switch).
// - No WebView, no `openURL` to uncredentialed APIs, no inline HTML/SVG/JS:
//   inline preview is bounded text or safe raster images only.
// - Credentials are never written: only artifact bytes reach the filesystem.

import { Platform } from 'react-native';
import {
  assertArtifactSizeOk,
  buildCachedArtifactFilename,
  canPreviewInline,
  decodeTextPreview,
  isPreviewableImage,
  isPreviewableText,
  mimeTypeForFilename,
  sanitizeArtifactFilename,
  scopedArtifactDirName,
} from '../../../src/artifact-cache.ts';
import type { IdentityTuple } from '../../../src/index.ts';

export type { IdentityTuple };
export {
  assertArtifactSizeOk,
  buildCachedArtifactFilename,
  canPreviewInline,
  decodeTextPreview,
  isPreviewableImage,
  isPreviewableText,
  mimeTypeForFilename,
  sanitizeArtifactFilename,
  scopedArtifactDirName,
};

export interface SavedArtifact {
  /** Display name (server-supplied, sanitized for display only). */
  name: string;
  /** Actual cached filename (random prefix + sanitized, flat). */
  fileName: string;
  /** Native file URI (`file://…`) or web blob URI. */
  fileUri: string;
  size: number;
  mimeType: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyModule = any;

async function loadFileSystem(): Promise<AnyModule | null> {
  try {
    // @ts-ignore optional native module: present on device builds.
    const mod = await import('expo-file-system');
    return mod;
  } catch {
    return null;
  }
}

async function loadSharing(): Promise<AnyModule | null> {
  try {
    // @ts-ignore optional native module: present on device builds.
    const mod = await import('expo-sharing');
    return mod;
  } catch {
    return null;
  }
}

export function isWebPlatform(): boolean {
  return Platform.OS === 'web';
}

/**
 * Save artifact bytes to the app-private cache scoped by identity.
 * Resolves ONLY after the write verifies (exists + size match).
 */
export async function saveArtifactBytes(
  scope: IdentityTuple,
  artifactId: string,
  name: string,
  bytes: Uint8Array,
): Promise<SavedArtifact> {
  assertArtifactSizeOk(bytes.length);
  const displayName = sanitizeArtifactFilename(name || artifactId);
  const fileName = buildCachedArtifactFilename(artifactId, name || artifactId);
  const mimeType = mimeTypeForFilename(displayName);
  const dirName = scopedArtifactDirName(scope);

  if (isWebPlatform()) {
    return saveArtifactOnWeb(displayName, fileName, bytes, mimeType);
  }

  const FS = await loadFileSystem();
  if (!FS || !FS.Paths?.cache || !FS.Directory || !FS.File) {
    throw new Error(
      'Saving files needs the native file module (expo-file-system, SDK58). ' +
        'Run the native app build (see TESTING.md); the Expo web preview cannot save to a device cache.',
    );
  }
  const dir = new FS.Directory(FS.Paths.cache, dirName);
  try {
    if (!dir.exists) dir.create();
  } catch (error) {
    throw new Error(
      `Could not create the device cache folder: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const file = new FS.File(dir, fileName);
  try {
    if (file.exists) file.delete();
  } catch {
    // Fresh random name should not exist; ignore a failed pre-clean.
  }
  await file.write(bytes);
  // Verify before claiming success: no fabricated saved statuses.
  if (!file.exists) {
    throw new Error('The file write did not complete; nothing was saved.');
  }
  let writtenSize = -1;
  try {
    writtenSize = file.size;
  } catch {
    writtenSize = -1;
  }
  if (writtenSize >= 0 && writtenSize !== bytes.length) {
    try {
      file.delete();
    } catch {
      // Best effort cleanup of a partial write.
    }
    throw new Error('The file write was incomplete; nothing was saved.');
  }
  return {
    name: displayName,
    fileName,
    fileUri: String(file.uri),
    size: bytes.length,
    mimeType,
  };
}

/** Web fallback: blob download (usable on web; no device cache). */
export async function saveArtifactOnWeb(
  displayName: string,
  fileName: string,
  bytes: Uint8Array,
  mimeType: string,
): Promise<SavedArtifact> {
  assertArtifactSizeOk(bytes.length);
  if (typeof document === 'undefined' || typeof URL === 'undefined') {
    throw new Error('Downloads are not supported in this preview.');
  }
  // Copy into a plain ArrayBuffer so BlobPart typing stays narrow.
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  const blob = new Blob([copy as BlobPart], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = displayName || fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoke after the click has been dispatched.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return {
    name: displayName,
    fileName,
    fileUri: url,
    size: bytes.length,
    mimeType,
  };
}

/** User-invoked Share via the native sheet. Never called automatically. */
export async function shareArtifactFile(fileUri: string, mimeType: string): Promise<void> {
  if (isWebPlatform()) {
    throw new Error('Sharing is available in the native app; on web use the downloaded file.');
  }
  const Sharing = await loadSharing();
  if (!Sharing || typeof Sharing.isAvailableAsync !== 'function') {
    throw new Error(
      'Sharing needs the native share module (expo-sharing, SDK58). ' +
        'Run the native app build (see TESTING.md).',
    );
  }
  const available = await Sharing.isAvailableAsync().catch(() => false);
  if (!available) {
    throw new Error('Sharing is not available on this device.');
  }
  await Sharing.shareAsync(fileUri, {
    dialogTitle: 'Share artifact',
    mimeType,
  });
}

/**
 * User-invoked Open in the platform viewer (Quick Look / ACTION_VIEW).
 * Rejects when the platform cannot preview so callers fall back to Share.
 */
export async function previewArtifactFile(fileUri: string): Promise<void> {
  if (isWebPlatform()) {
    throw new Error('Preview opens in the native app viewer; on web use the downloaded file.');
  }
  const FS = await loadFileSystem();
  if (!FS || !FS.File) {
    throw new Error(
      'Preview needs the native file module (expo-file-system, SDK58). ' +
        'Run the native app build (see TESTING.md).',
    );
  }
  const file = new FS.File(fileUri);
  const canPreview =
    typeof FS.File.canPreview === 'function'
      ? await FS.File.canPreview(file).catch(() => false)
      : await file.canPreview?.().catch(() => false);
  if (!canPreview) {
    throw new Error('This file type cannot be previewed on this device; use Share instead.');
  }
  if (typeof FS.File.preview === 'function') {
    await FS.File.preview(file);
  } else {
    await file.preview();
  }
}

/**
 * Delete the scoped cache directory for an identity (unenroll/change).
 * Best-effort: missing directory or missing native module is not fatal,
 * but a present directory that fails to delete surfaces honestly.
 */
export async function clearScopedArtifactCache(
  scope: IdentityTuple | null | undefined,
): Promise<void> {
  if (!scope) return;
  if (isWebPlatform()) return;
  const FS = await loadFileSystem();
  if (!FS || !FS.Paths?.cache || !FS.Directory) return;
  try {
    const dir = new FS.Directory(FS.Paths.cache, scopedArtifactDirName(scope));
    if (dir.exists) dir.delete();
  } catch (error) {
    throw new Error(
      `Could not clear cached files for the previous pairing: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
