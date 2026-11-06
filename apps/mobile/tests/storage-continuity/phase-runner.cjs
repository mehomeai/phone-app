'use strict';

/**
 * PR C (SDK 58) — standalone two-phase runner for the data-continuity proof.
 *
 *   node phase-runner.cjs capture --driver file --store <store.json> --snapshot <snapshot.json>
 *   node phase-runner.cjs verify  --driver file --store <store.json> --snapshot <snapshot.json>
 *
 * capture: clears the store, writes the dataset (dataset.cjs) through the
 * driver, reads it back, and persists the read-back snapshot (keys, values,
 * byte lengths, SHA-256) to the snapshot file.
 *
 * verify: reads the store through the driver and demands byte identity
 * against the snapshot file — every key present, no extras, every value
 * byte-identical. Exit 0 on parity; exit 1 with one mismatch per line on
 * stderr otherwise. This is the stop-condition check: a non-zero exit after
 * a downgrade means STOP, do not ship.
 *
 * The file driver persists across processes, so these two commands are the
 * exact two-phase shape the real PR C uses: capture under the old version,
 * change the version, verify under the new one. (--driver library works too
 * but its mock is in-memory; it only proves something within one process,
 * so phase runs use the file driver or the real on-device store.)
 */

const fs = require('node:fs');
const { createFileDriver, loadLibraryDriver } = require('./drivers.cjs');
const { captureInto, readSnapshot, diffSnapshots } = require('./verify.cjs');

function argValue(args, name) {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : undefined;
}

async function main() {
  const [phase, ...rest] = process.argv.slice(2);
  const driverKind = argValue(rest, '--driver') || 'file';
  const storePath = argValue(rest, '--store');
  const snapshotPath = argValue(rest, '--snapshot');
  if (!snapshotPath || (driverKind === 'file' && !storePath)) {
    console.error(
      'usage: phase-runner.cjs <capture|verify> --driver file|library ' +
        '--store <store.json> --snapshot <snapshot.json>',
    );
    process.exit(2);
  }
  const driver =
    driverKind === 'file'
      ? createFileDriver(storePath)
      : await loadLibraryDriver();

  if (phase === 'capture') {
    const snapshot = await captureInto(driver);
    const payload = {
      dataset: 'storage-continuity-v1',
      capturedVia: driver.description,
      ...snapshot,
    };
    fs.writeFileSync(snapshotPath, JSON.stringify(payload, null, 2));
    console.log(
      `captured ${snapshot.keys.length} keys via ${driver.description}`,
    );
    return;
  }
  if (phase === 'verify') {
    const expected = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
    const actual = await readSnapshot(driver);
    const mismatches = diffSnapshots(actual, expected);
    if (mismatches.length > 0) {
      for (const mismatch of mismatches) console.error(mismatch);
      console.error(
        `FAIL: ${mismatches.length} continuity mismatch(es) via ${driver.description}`,
      );
      process.exit(1);
    }
    console.log(
      `verified ${expected.keys.length} keys byte-identical via ${driver.description}`,
    );
    return;
  }
  console.error(`unknown phase: ${phase}`);
  process.exit(2);
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(2);
});
