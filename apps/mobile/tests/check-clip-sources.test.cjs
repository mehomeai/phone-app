const assert = require('node:assert/strict');
const test = require('node:test');
const { checkSource, runChecks } = require('../scripts/check-clip-sources.cjs');
const { checkMedia } = require('../scripts/check-clip-media.cjs');

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

test('timed-out requests report the clip ID and exact source URL without waiting', async () => {
  let timeoutCallback;
  let timeoutDelay;
  let requestedSignal;
  let clearedTimer;
  const timer = {};
  const errors = [];

  const resultPromise = runChecks({
    clipList: [clip],
    fetchImpl: (_sourceUrl, { signal }) => {
      requestedSignal = signal;
      return new Promise((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => reject(signal.reason),
          { once: true },
        );
      });
    },
    setTimeoutImpl: (callback, delay) => {
      timeoutCallback = callback;
      timeoutDelay = delay;
      return timer;
    },
    clearTimeoutImpl: (handle) => {
      clearedTimer = handle;
    },
    log: () => {},
    error: (message) => errors.push(message),
  });

  assert.equal(typeof timeoutCallback, 'function');
  assert.equal(timeoutDelay, 15_000);
  assert.equal(requestedSignal.aborted, false);
  timeoutCallback();

  const result = await resultPromise;
  const failure = `${clip.id}: request failed (Request timed out after 15000 ms) — ${clip.sourceUrl}`;
  assert.equal(requestedSignal.aborted, true);
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.failures, [failure]);
  assert.deepEqual(errors, [`\n1 clip source check(s) failed:`, `- ${failure}`]);
  assert.equal(clearedTimer, timer);
});

test('source checks time out if response-body cleanup hangs after headers arrive', async () => {
  let timeoutCallback;
  let requestedSignal;
  let clearedTimer;
  const timer = {};
  const resultPromise = checkSource(clip, {
    fetchImpl: async (_sourceUrl, { signal }) => {
      requestedSignal = signal;
      return {
        ...makeResponse({ status: 200, statusText: 'OK' }),
        body: { cancel: () => new Promise(() => {}) },
      };
    },
    setTimeoutImpl: (callback) => {
      timeoutCallback = callback;
      return timer;
    },
    clearTimeoutImpl: (handle) => {
      clearedTimer = handle;
    },
  });

  await Promise.resolve();
  assert.equal(typeof timeoutCallback, 'function');
  assert.equal(requestedSignal.aborted, false);
  timeoutCallback();

  assert.equal(
    await resultPromise,
    `${clip.id}: request failed (Request timed out after 15000 ms) — ${clip.sourceUrl}`,
  );
  assert.equal(requestedSignal.aborted, true);
  assert.equal(clearedTimer, timer);
});

test('reports every failed clip and exact source URL using only mocked requests', async () => {
  const failedClips = [
    {
      id: 'clip-photosynthesis',
      sourceUrl: 'https://cdn.example.test/lessons/photosynthesis.mp4?edition=student',
    },
    {
      id: 'clip-circuits',
      sourceUrl: 'https://media.example.test/classes/circuits.mp4',
    },
  ];
  const requestedUrls = [];
  const output = [];
  const errors = [];
  const expectedFailures = failedClips.map(
    ({ id, sourceUrl }) =>
      `${id}: request failed (simulated network failure) — ${sourceUrl}`,
  );

  const result = await runChecks({
    clipList: failedClips,
    fetchImpl: async (sourceUrl) => {
      requestedUrls.push(sourceUrl);
      assert.equal(new URL(sourceUrl).hostname.endsWith('.example.test'), true);
      throw new Error('simulated network failure');
    },
    log: (message) => output.push(message),
    error: (message) => errors.push(message),
  });

  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.failures, expectedFailures);
  assert.deepEqual(requestedUrls, failedClips.map((entry) => entry.sourceUrl));
  assert.deepEqual(output, ['Checking 2 clip source URL(s)...']);
  assert.deepEqual(errors, [
    '\n2 clip source check(s) failed:',
    ...expectedFailures.map((failure) => `- ${failure}`),
  ]);
});

test('reports a clear all-reachable result when every source responds successfully', async () => {
  const output = [];
  const errors = [];
  const result = await runChecks({
    clipList: [clip],
    fetchImpl: async () => makeResponse({ status: 206, statusText: 'Partial Content' }),
    log: (message) => output.push(message),
    error: (message) => errors.push(message),
  });

  assert.deepEqual(result, { failures: [], exitCode: 0 });
  assert.deepEqual(output, [
    'Checking 1 clip source URL(s)...',
    `OK ${clip.id}: ${clip.sourceUrl}`,
    'All clip source URLs are reachable without redirects.',
  ]);
  assert.deepEqual(errors, []);
});

test('dead video URLs report their HTTP status and exact URL', async () => {
  const videoUrl = 'https://media.example.test/orbit.mp4?version=2';
  const result = await checkMedia(
    { id: 'clip-orbit', video: videoUrl },
    {
      fetchImpl: async (url, options) => {
        assert.equal(url, videoUrl);
        assert.equal(options.method, 'GET');
        assert.equal(options.redirect, 'manual');
        return {
          status: 404,
          statusText: 'Not Found',
          ok: false,
          headers: { get: () => null },
          body: null,
        };
      },
    },
  );
  assert.equal(result, `clip-orbit: HTTP 404 Not Found — ${videoUrl}`);
});

test('redirected video URLs report the destination without following it', async () => {
  const videoUrl = 'https://media.example.test/orbit.mp4?version=2';
  const destination = 'https://cdn.example.test/orbit.mp4';
  const result = await checkMedia(
    { id: 'clip-orbit', video: videoUrl },
    {
      fetchImpl: async (_url, options) => {
        assert.equal(options.redirect, 'manual');
        return {
          status: 302,
          statusText: 'Found',
          ok: false,
          headers: { get: (name) => name.toLowerCase() === 'location' ? destination : null },
          body: null,
        };
      },
    },
  );
  assert.equal(result, `clip-orbit: unexpected redirect, HTTP 302 (Location: ${destination}) — ${videoUrl}`);
});
