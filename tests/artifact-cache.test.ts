// Pure artifact file-naming/scoping/limits (Node, no native I/O).
// Run: part of `npm test`.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ARTIFACT_MAX_BYTES,
  assertArtifactSizeOk,
  buildCachedArtifactFilename,
  canPreviewInline,
  decodeTextPreview,
  fnv1aHex,
  isBlockedInlinePreview,
  isPreviewableImage,
  isPreviewableText,
  mimeTypeForFilename,
  sanitizeArtifactFilename,
  scopedArtifactDirName,
} from '../src/index.ts';
import type { IdentityTuple } from '../src/index.ts';

const SCOPE_A: IdentityTuple = {
  userId: 'alice',
  deviceId: 'dev_a',
  installationId: 'install_1',
  homeBaseUrl: 'https://home.invalid',
};

describe('artifact cache policy (pure)', () => {
  it('sanitizes untrusted names to flat basenames, never paths', () => {
    assert.equal(sanitizeArtifactFilename('../../etc/passwd'), 'passwd');
    assert.equal(sanitizeArtifactFilename('/abs/path/notes.txt'), 'notes.txt');
    assert.equal(sanitizeArtifactFilename('C:\\win\\evil.mp4'), 'evil.mp4');
    assert.equal(sanitizeArtifactFilename('../..\\..'), 'artifact');
    assert.equal(sanitizeArtifactFilename(''), 'artifact');
    assert.equal(sanitizeArtifactFilename(null), 'artifact');
    assert.equal(sanitizeArtifactFilename('...'), 'artifact');
    // Query/fragment stripped, extension preserved.
    assert.equal(sanitizeArtifactFilename('clip.mp4?token=abc#frag'), 'clip.mp4');
    // Unsafe chars collapsed, length capped.
    const long = `${'a'.repeat(200)}.txt`;
    const capped = sanitizeArtifactFilename(long);
    assert.ok(capped.length <= 100);
    assert.ok(capped.endsWith('.txt'));
    assert.ok(!capped.includes('/'));
    assert.ok(!capped.includes('\\'));
    assert.ok(!capped.includes('..'));
  });

  it('prefixes a random hex segment and never emits a path', () => {
    const out = buildCachedArtifactFilename('art_1', '../../evil.txt', 'abcdef12');
    assert.equal(out, 'abcdef12-evil.txt');
    const fallback = buildCachedArtifactFilename('art_1', '', 'abcdef12');
    assert.ok(fallback.startsWith('abcdef12-artifact'));
    assert.ok(!out.includes('/'));
    assert.ok(!fallback.includes('\\'));
    // Invalid random segment is replaced, never trusted.
    const replaced = buildCachedArtifactFilename('art_1', 'notes.txt', '../../evil');
    assert.ok(/^[0-9a-f]{8}-notes\.txt$/.test(replaced));
  });

  it('scopes cache dirs by the FULL paired identity', () => {
    const a = scopedArtifactDirName(SCOPE_A);
    assert.match(a, /^artifacts-[0-9a-f]{8}$/);
    // Same username, different installation/device/endpoint: different dir.
    assert.notEqual(a, scopedArtifactDirName({ ...SCOPE_A, installationId: 'install_2' }));
    assert.notEqual(a, scopedArtifactDirName({ ...SCOPE_A, deviceId: 'dev_other' }));
    assert.notEqual(a, scopedArtifactDirName({ ...SCOPE_A, homeBaseUrl: 'https://other.invalid' }));
    // Endpoint normalization: trailing slash / case still match.
    assert.equal(
      a,
      scopedArtifactDirName({ ...SCOPE_A, homeBaseUrl: 'https://home.invalid/' }),
    );
    assert.equal(fnv1aHex('abc'), fnv1aHex('abc'));
    assert.notEqual(fnv1aHex('abc'), fnv1aHex('abd'));
  });

  it('enforces max bytes before any write', () => {
    assert.throws(() => assertArtifactSizeOk(ARTIFACT_MAX_BYTES + 1), /too large/);
    assert.throws(() => assertArtifactSizeOk(0), /empty/);
    assert.throws(() => assertArtifactSizeOk(-1), /unreadable/);
    assert.doesNotThrow(() => assertArtifactSizeOk(ARTIFACT_MAX_BYTES));
    assert.doesNotThrow(() => assertArtifactSizeOk(11));
  });

  it('allows bounded text and safe images inline; blocks HTML/SVG/JS', () => {
    assert.equal(isPreviewableText('notes.txt'), true);
    assert.equal(isPreviewableText('data.json'), true);
    assert.equal(isPreviewableText('clip.mp4'), false);
    assert.equal(isPreviewableImage('frame.png'), true);
    assert.equal(isPreviewableImage('anim.gif'), true);
    assert.equal(isPreviewableImage('photo.webp'), true);
    assert.equal(isPreviewableImage('notes.txt'), false);
    assert.equal(isBlockedInlinePreview('page.html'), true);
    assert.equal(isBlockedInlinePreview('vector.svg'), true);
    assert.equal(isBlockedInlinePreview('run.js'), true);
    assert.equal(isBlockedInlinePreview('notes.txt'), false);
    assert.equal(canPreviewInline('notes.txt'), true);
    assert.equal(canPreviewInline('anim.gif'), true);
    assert.equal(canPreviewInline('page.html'), false);
    assert.equal(canPreviewInline('vector.svg'), false);
    assert.equal(canPreviewInline('clip.mp4'), false);
    assert.equal(mimeTypeForFilename('anim.gif'), 'image/gif');
    assert.equal(mimeTypeForFilename('notes.txt'), 'text/plain');
    assert.equal(mimeTypeForFilename('unknown.xyz'), 'application/octet-stream');
  });

  it('bounds text previews', () => {
    const bytes = new TextEncoder().encode(`${'a'.repeat(5000)} end`);
    const preview = decodeTextPreview(bytes);
    assert.ok(preview.length <= 4000);
    assert.ok(!preview.includes('end'));
    const short = decodeTextPreview(new TextEncoder().encode('hello'));
    assert.equal(short, 'hello');
  });
});
