'use strict';

/**
 * PR C (SDK 58) — AsyncStorage data-continuity harness.
 *
 * Proves the harness itself is sound (run on the CURRENT library version):
 * the dataset in tests/storage-continuity/dataset.cjs — built only from
 * key/value shapes the app really writes — round-trips byte-identically,
 * and the verify oracle actually detects tampering, deletion, and extra
 * keys. The real PR C re-runs this same harness in two phases across the
 * 3.1.1 -> 2.2.0 downgrade (CI via the library driver, on-device per
 * Ticket 4); any mismatch there is the stop condition.
 *
 * Run:  npm run test:storage-continuity   (from apps/mobile)
 *
 * Single-phase mode (used by the PR C procedure):
 *   ME_CONTINUITY_MODE=capture|verify \
 *   ME_CONTINUITY_STORE=<store.json> ME_CONTINUITY_SNAPSHOT=<snapshot.json> \
 *     node --test tests/storage-continuity.test.cjs
 * In phase mode the store is the file driver (persists across processes).
 * The library-driver phase pair runs through phase-runner.cjs instead,
 * because the shipped Jest mocks are in-memory.
 */

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  ENTRIES,
  REMOVABLE_KEYS,
  expectedSnapshot,
} = require('./storage-continuity/dataset.cjs');
const {
  createFileDriver,
  loadLibraryDriver,
} = require('./storage-continuity/drivers.cjs');
const {
  captureInto,
  readSnapshot,
  diffSnapshots,
} = require('./storage-continuity/verify.cjs');

const PHASE_RUNNER = path.join(
  __dirname,
  'storage-continuity',
  'phase-runner.cjs',
);

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'me-continuity-'));
  return {
    dir,
    store: path.join(dir, 'store.json'),
    snapshot: path.join(dir, 'snapshot.json'),
  };
}

function runPhase(phase, store, snapshot) {
  return execFileSync(
    process.execPath,
    [
      PHASE_RUNNER,
      phase,
      '--driver',
      'file',
      '--store',
      store,
      '--snapshot',
      snapshot,
    ],
    { encoding: 'utf8' },
  );
}

const PHASE_MODE = process.env.ME_CONTINUITY_MODE;

if (PHASE_MODE === 'capture' || PHASE_MODE === 'verify') {
  test(`continuity phase: ${PHASE_MODE}`, async () => {
    const store = process.env.ME_CONTINUITY_STORE;
    const snapshot = process.env.ME_CONTINUITY_SNAPSHOT;
    assert.ok(store, 'ME_CONTINUITY_STORE is required in phase mode');
    assert.ok(snapshot, 'ME_CONTINUITY_SNAPSHOT is required in phase mode');
    const output = runPhase(PHASE_MODE, store, snapshot);
    process.stdout.write(output);
  });
} else {
  test('dataset: deterministic snapshot built from real key shapes', () => {
    const first = expectedSnapshot();
    const second = expectedSnapshot();
    assert.deepEqual(first, second);
    assert.deepEqual(first.keys, [
      'me-demo-state-v1',
      'me-home-links-v1',
      'me-native-outbox-v1',
      'me.home.cache.v1.conv-demo-1',
      'me.home.cache.v1.conv-empty-1',
      'me.home.cache.v1.conv-home-1',
    ]);
    for (const [key, value] of ENTRIES) {
      assert.equal(typeof value, 'string', `${key} value must be a string`);
      // Every value the app writes is a JSON string.
      assert.doesNotThrow(() => JSON.parse(value), `${key} must be JSON`);
      assert.ok(
        first.byteLengths[key] > 0,
        `${key} must have a non-zero byte length`,
      );
      assert.equal(first.values[key], value);
    }
  });

  test('file driver: capture then verify is byte-identical', async () => {
    const { store } = tmpStore();
    const driver = createFileDriver(store);
    const captured = await captureInto(driver);
    assert.deepEqual(diffSnapshots(captured, expectedSnapshot()), []);
    const reread = await readSnapshot(driver);
    assert.deepEqual(diffSnapshots(reread, expectedSnapshot()), []);
    assert.deepEqual(reread.keys, expectedSnapshot().keys);
  });

  test('file driver: two-process capture/verify via phase-runner', () => {
    const { store, snapshot } = tmpStore();
    const captureOut = runPhase('capture', store, snapshot);
    assert.match(captureOut, /captured 6 keys/);
    const verifyOut = runPhase('verify', store, snapshot);
    assert.match(verifyOut, /verified 6 keys byte-identical/);
  });

  test('negative control: tampered, deleted, and extra keys are detected', () => {
    const { store, snapshot } = tmpStore();
    runPhase('capture', store, snapshot);
    const original = fs.readFileSync(store, 'utf8');

    // Tamper one byte inside one value.
    const tampered = JSON.parse(original);
    tampered['me-home-links-v1'] = tampered['me-home-links-v1'].replace(
      'home-conv-aaa',
      'home-conv-zzz',
    );
    fs.writeFileSync(store, JSON.stringify(tampered));
    assert.throws(
      () => runPhase('verify', store, snapshot),
      (error) => {
        const text = `${error.stdout || ''}${error.stderr || ''}`;
        return (
          error.status === 1 &&
          text.includes('value mismatch: me-home-links-v1')
        );
      },
    );

    // Delete a key entirely.
    const deleted = JSON.parse(original);
    delete deleted['me-native-outbox-v1'];
    fs.writeFileSync(store, JSON.stringify(deleted));
    assert.throws(
      () => runPhase('verify', store, snapshot),
      (error) => {
        const text = `${error.stdout || ''}${error.stderr || ''}`;
        return (
          error.status === 1 && text.includes('missing key: me-native-outbox-v1')
        );
      },
    );

    // Add a key the app never wrote.
    const extra = JSON.parse(original);
    extra['me.unexpected.v1'] = '{}';
    fs.writeFileSync(store, JSON.stringify(extra));
    assert.throws(
      () => runPhase('verify', store, snapshot),
      (error) => {
        const text = `${error.stdout || ''}${error.stderr || ''}`;
        return error.status === 1 && text.includes('extra key: me.unexpected.v1');
      },
    );
  });

  test('removeItem: the keys the app removes round-trip to null', async () => {
    const { store } = tmpStore();
    const driver = createFileDriver(store);
    await captureInto(driver);
    for (const key of REMOVABLE_KEYS) {
      await driver.removeItem(key);
      assert.equal(await driver.getItem(key), null, `${key} must read null`);
    }
    const remaining = await readSnapshot(driver);
    const expected = expectedSnapshot();
    assert.deepEqual(
      remaining.keys,
      expected.keys.filter((key) => !REMOVABLE_KEYS.includes(key)),
    );
    for (const key of remaining.keys) {
      assert.equal(remaining.values[key], expected.values[key]);
    }
    // Re-writing the removed keys restores full parity (post-remove writes
    // must work after a downgrade too).
    for (const [key, value] of ENTRIES) {
      if (REMOVABLE_KEYS.includes(key)) await driver.setItem(key, value);
    }
    const restored = await readSnapshot(driver);
    assert.deepEqual(diffSnapshots(restored, expectedSnapshot()), []);
  });

  test('library driver: installed async-storage mock round-trips the dataset', async (t) => {
    let driver;
    try {
      driver = await loadLibraryDriver();
    } catch (error) {
      t.skip(
        `async-storage not installed/resolvable here: ${error.message}`,
      );
      return;
    }
    const captured = await captureInto(driver);
    assert.deepEqual(
      diffSnapshots(captured, expectedSnapshot()),
      [],
      `round trip via ${driver.description}`,
    );
    for (const key of REMOVABLE_KEYS) {
      await driver.removeItem(key);
      assert.equal(await driver.getItem(key), null, `${key} must read null`);
    }
    const remaining = await readSnapshot(driver);
    assert.deepEqual(
      remaining.keys,
      expectedSnapshot().keys.filter(
        (key) => !REMOVABLE_KEYS.includes(key),
      ),
    );
    await driver.clear();
  });
}
