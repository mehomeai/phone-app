// Upstream capability profile: strict parsing + honest FULL gating.
// Run: npm test (no servers; pure unit checks).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseUpstreamCapability,
  selectExecutionMode,
  isUpstreamSetupNeeded,
  describeUpstreamSetupNeeded,
} from '../src/index.ts';

describe('parseUpstreamCapability (OPTIONAL home report, strict)', () => {
  it('returns null when the home reports nothing (unknown, not configured)', () => {
    assert.equal(parseUpstreamCapability(null), null);
    assert.equal(parseUpstreamCapability(undefined), null);
    assert.equal(parseUpstreamCapability({}), null);
  });

  it('accepts a complete legacy report', () => {
    assert.deepEqual(
      parseUpstreamCapability({
        agentMode: 'legacy',
        fullConfigured: false,
        needsSetup: false,
      }),
      { agentMode: 'legacy', fullConfigured: false, needsSetup: false, missing: [] },
    );
  });

  it('accepts a complete FULL report with bounded missing list', () => {
    assert.deepEqual(
      parseUpstreamCapability({
        agentMode: 'full-upstream',
        fullConfigured: true,
        needsSetup: false,
        missing: [],
      }),
      { agentMode: 'full-upstream', fullConfigured: true, needsSetup: false, missing: [] },
    );
  });

  it('rejects truthy-string booleans (real booleans only)', () => {
    assert.equal(
      parseUpstreamCapability({
        agentMode: 'full-upstream',
        fullConfigured: 'true',
        needsSetup: false,
      }),
      null,
    );
    assert.equal(
      parseUpstreamCapability({
        agentMode: 'full-upstream',
        fullConfigured: 1,
        needsSetup: 0,
      }),
      null,
    );
  });

  it('rejects unknown agent modes instead of guessing', () => {
    assert.equal(
      parseUpstreamCapability({
        agentMode: 'full',
        fullConfigured: true,
        needsSetup: false,
      }),
      null,
    );
    assert.equal(
      parseUpstreamCapability({
        agentMode: 'managed-cloud',
        fullConfigured: true,
        needsSetup: false,
      }),
      null,
    );
  });

  it('bounds the missing list (count, type, length)', () => {
    assert.equal(
      parseUpstreamCapability({
        agentMode: 'full-upstream',
        fullConfigured: false,
        needsSetup: true,
        missing: 'license',
      }),
      null,
    );
    assert.equal(
      parseUpstreamCapability({
        agentMode: 'full-upstream',
        fullConfigured: false,
        needsSetup: true,
        missing: new Array(21).fill('x'),
      }),
      null,
    );
    assert.equal(
      parseUpstreamCapability({
        agentMode: 'full-upstream',
        fullConfigured: false,
        needsSetup: true,
        missing: [''],
      }),
      null,
    );
    assert.equal(
      parseUpstreamCapability({
        agentMode: 'full-upstream',
        fullConfigured: false,
        needsSetup: true,
        missing: ['x'.repeat(201)],
      }),
      null,
    );
  });

  it('rejects arrays and non-objects', () => {
    assert.equal(parseUpstreamCapability([]), null);
    assert.equal(parseUpstreamCapability('full-upstream'), null);
    assert.equal(parseUpstreamCapability(42), null);
  });
});

describe('selectExecutionMode (FULL needs honest setup, never silent legacy)', () => {
  it('demo and legacy pass through', () => {
    assert.equal(selectExecutionMode('demo', null), 'demo');
    assert.equal(
      selectExecutionMode('legacy', {
        agentMode: 'full-upstream',
        fullConfigured: true,
        needsSetup: false,
        missing: [],
      }),
      'legacy',
    );
  });

  it('FULL with a complete capability runs full', () => {
    assert.equal(
      selectExecutionMode('full', {
        agentMode: 'full-upstream',
        fullConfigured: true,
        needsSetup: false,
        missing: [],
      }),
      'full',
    );
  });

  it('FULL without a capability report is setup-needed, not legacy', () => {
    assert.equal(selectExecutionMode('full', null), 'setup-needed');
    assert.equal(isUpstreamSetupNeeded('full', null), true);
    assert.equal(isUpstreamSetupNeeded('legacy', null), false);
  });

  it('FULL with incomplete setup is setup-needed, not legacy', () => {
    const incomplete = {
      agentMode: 'full-upstream' as const,
      fullConfigured: false,
      needsSetup: true,
      missing: ['license'],
    };
    assert.equal(selectExecutionMode('full', incomplete), 'setup-needed');
    const legacyHome = {
      agentMode: 'legacy' as const,
      fullConfigured: false,
      needsSetup: false,
      missing: [],
    };
    assert.equal(selectExecutionMode('full', legacyHome), 'setup-needed');
  });

  it('describes setup-needed honestly with bounded missing names', () => {
    const withoutReport = describeUpstreamSetupNeeded(null);
    assert.match(withoutReport, /isn't set up for the full agent/i);
    assert.match(withoutReport, /No capability report/i);
    const withMissing = describeUpstreamSetupNeeded({
      agentMode: 'full-upstream',
      fullConfigured: false,
      needsSetup: true,
      missing: ['license', 'model'],
    });
    assert.match(withMissing, /license/);
    assert.match(withMissing, /model/);
    const many = describeUpstreamSetupNeeded({
      agentMode: 'full-upstream',
      fullConfigured: false,
      needsSetup: true,
      missing: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
    });
    assert.match(many, /\(\+2 more\)/);
  });
});
