const assert = require('node:assert/strict');
const test = require('node:test');
const { checkSource } = require('../scripts/check-clip-sources.cjs');

const clip = {
  id: 'clip-nasa-orbit',
  sourceUrl: 'https://sources.example.test/videos/orbit.mp4?edition=1',
};

function makeResponse({ status, statusText, location }) {
  return {
    status,
    statusText,
    ok: status >= 200 && status < 300,
    headers: {
      get(name) {
        return name.toLowerCase() === 'location' ? location ?? null : null;
      },
    },
    body: null,
  };
}

test('HTTP failures report the clip ID and exact source URL', async () => {
  let request;
  const result = await checkSource(clip, {
    fetchImpl: async (url, options) => {
      request = { url, options };
      return makeResponse({ status: 503, statusText: 'Service Unavailable' });
    },
  });

  assert.equal(result, `${clip.id}: HTTP 503 Service Unavailable — ${clip.sourceUrl}`);
  assert.equal(request.url, clip.sourceUrl);
  assert.equal(request.options.method, 'GET');
  assert.equal(request.options.redirect, 'manual');
});

test('redirects report the clip ID, exact source URL, status, and destination', async () => {
  const destination = 'https://cdn.example.test/videos/orbit.mp4';
  const result = await checkSource(clip, {
    fetchImpl: async () => makeResponse({ status: 302, statusText: 'Found', location: destination }),
  });

  assert.equal(
    result,
    `${clip.id}: unexpected redirect, HTTP 302 (Location: ${destination}) — ${clip.sourceUrl}`,
  );
});

test('network errors report the clip ID and exact source URL', async () => {
  const result = await checkSource(clip, {
    fetchImpl: async () => {
      throw new Error('simulated network failure');
    },
  });

  assert.equal(result, `${clip.id}: request failed (simulated network failure) — ${clip.sourceUrl}`);
});
