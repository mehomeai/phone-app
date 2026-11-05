'use strict';

/**
 * PR C (SDK 58) — shared capture/diff logic for the data-continuity harness.
 * Used by both the node:test suite (storage-continuity.test.cjs) and the
 * standalone phase runner (phase-runner.cjs).
 */

const { ENTRIES, expectedSnapshot, sha256 } = require('./dataset.cjs');

/** Write the whole dataset through a driver and read it back. */
async function captureInto(driver) {
  await driver.clear();
  for (const [key, value] of ENTRIES) {
    await driver.setItem(key, value);
  }
  return readSnapshot(driver);
}

/** Read every dataset key plus the full key list from a driver. */
async function readSnapshot(driver) {
  const values = {};
  const hashes = {};
  const byteLengths = {};
  for (const [key] of ENTRIES) {
    const value = await driver.getItem(key);
    values[key] = value;
    hashes[key] = value === null ? null : sha256(value);
    byteLengths[key] = value === null ? null : Buffer.byteLength(value, 'utf8');
  }
  const allKeys = (await driver.getAllKeys()).slice().sort();
  return { keys: allKeys, values, hashes, byteLengths };
}

/**
 * Compare an actual snapshot (from readSnapshot) against an expected one
 * (from dataset.expectedSnapshot(), or a snapshot JSON written by a prior
 * capture phase). Returns human-readable mismatches; [] means the store is
 * byte-identical and key-complete. This is the harness's stop-condition
 * oracle: ANY non-empty result after a downgrade aborts it.
 */
function diffSnapshots(actual, expected) {
  const mismatches = [];
  const actualKeySet = new Set(actual.keys);
  const expectedKeySet = new Set(expected.keys);
  for (const key of expected.keys) {
    if (!actualKeySet.has(key)) mismatches.push(`missing key: ${key}`);
  }
  for (const key of actual.keys) {
    if (!expectedKeySet.has(key)) mismatches.push(`extra key: ${key}`);
  }
  for (const key of expected.keys) {
    if (!actualKeySet.has(key)) continue;
    const expectedValue = expected.values[key];
    const actualValue = actual.values[key];
    if (actualValue === null || actualValue === undefined) {
      mismatches.push(`key read back null: ${key}`);
    } else if (actualValue !== expectedValue) {
      mismatches.push(
        `value mismatch: ${key} ` +
          `(expected ${expected.byteLengths[key]} bytes sha256=${expected.hashes[key]}, ` +
          `got ${Buffer.byteLength(actualValue, 'utf8')} bytes sha256=${sha256(actualValue)})`,
      );
    }
  }
  return mismatches;
}

module.exports = { captureInto, readSnapshot, diffSnapshots, expectedSnapshot };
