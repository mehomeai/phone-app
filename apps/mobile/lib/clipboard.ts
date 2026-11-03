// Typed clipboard boundary (F9 one-time activation handoff copy).
//
// The app copies the one-time activation JSON via the maintained Expo
// Clipboard API (`expo-clipboard`, declared in apps/mobile/package.json).
// This module owns the MINIMAL typed surface the app needs so the call site
// stays honest (success/failure/unavailable) without importing the native
// module directly:
//
// - `setStringAsync` parity: resolves true when the OS accepted the text.
// - No read API is exposed: the one-time secret is write-only here and is
//   never read back from the OS clipboard.
//
// The default loader imports the OFFICIAL `expo-clipboard` SDK module and
// is typechecked against its real declarations (B6 mirror, 51 packages):
// no ambient shim, no `any`. On a real install Metro resolves the declared
// package; when the native module is missing the copy fails closed with an
// honest "copy unavailable" state instead of a fake success.

export interface ClipboardLike {
  setStringAsync(text: string): Promise<boolean>;
}

/**
 * Default loader: resolves the OFFICIAL `expo-clipboard` SDK module and
 * checks it against the narrow write-only surface at typecheck time (the
 * assignment below errors if the SDK signature ever drifts incompatibly).
 * A missing/unusable native module fails closed (null → honest UI state).
 */
export async function loadDefaultClipboard(): Promise<ClipboardLike | null> {
  try {
    const mod = await import('expo-clipboard');
    const checked: ClipboardLike = mod;
    if (typeof checked.setStringAsync !== 'function') return null;
    return checked;
  } catch {
    return null;
  }
}

async function loadClipboard(): Promise<ClipboardLike | null> {
  return loadDefaultClipboard();
}

export type CopyResult =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Copy text to the OS clipboard. Single attempt, no retries: reports the
 * real outcome so the UI can show an honest copied/failed state.
 */
export async function copyTextToClipboard(
  text: string,
  loader: () => Promise<ClipboardLike | null> = loadClipboard,
): Promise<CopyResult> {
  if (!text) {
    return { ok: false, reason: 'Nothing to copy.' };
  }
  const clipboard = await loader();
  if (!clipboard) {
    return {
      ok: false,
      reason: 'Copy is unavailable in this build (clipboard module missing). Long-press to select the text manually.',
    };
  }
  try {
    const accepted = await clipboard.setStringAsync(text);
    if (accepted !== true) {
      return { ok: false, reason: 'The system did not accept the copy.' };
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : 'Copy failed.',
    };
  }
}
