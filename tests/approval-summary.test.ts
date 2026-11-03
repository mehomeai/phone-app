// Pure tests: reviewable approval summaries + task-relationship parsing.
// Run: part of `npm test`.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  summarizeApproval,
  parseTaskRelations,
  maskSensitiveValue,
} from '../src/index.ts';

describe('approval summaries (pure, reviewable)', () => {
  it('summarizes action/summary/reason/destination/expiry without blind approve', () => {
    const summary = summarizeApproval({
      id: 'task_1:a1',
      action: 'browser.open',
      summary: 'Open the docs page to verify the invoice',
      reason: 'Need to confirm the total before paying',
      url: 'https://example.invalid/invoice/123',
      selector: '#pay-button',
      expires_at: '2026-11-04T00:00:00.000Z',
      args: { url: 'https://example.invalid/invoice/123' },
    });
    assert.equal(summary.id, 'task_1:a1');
    assert.equal(summary.action, 'browser.open');
    assert.match(summary.summary, /invoice/);
    assert.match(summary.reason ?? '', /confirm/);
    assert.equal(summary.destination, 'https://example.invalid/invoice/123');
    assert.equal(summary.selector, '#pay-button');
    assert.ok(summary.expiresAt);
    assert.ok(summary.argsPreview.includes('example.invalid'));
  });

  it('masks sensitive arg values by default and flags them', () => {
    const summary = summarizeApproval({
      id: 'task_1:a2',
      action: 'api.call',
      args: {
        username: 'anna',
        password: 'hunter2-secret',
        nested: { api_key: 'key-123', ok: 'visible' },
      },
    });
    assert.equal(summary.hasSensitiveArgs, true);
    assert.ok(!summary.argsPreview.includes('hunter2-secret'));
    assert.ok(!summary.argsPreview.includes('key-123'));
    assert.ok(summary.argsPreview.includes('masked'));
    assert.ok(summary.argsPreview.includes('visible'));
    const masked = maskSensitiveValue('password', 'hunter2') as string;
    assert.equal(masked, '•••masked•••');
  });

  it('formats action sequences and optional technical metadata only when present', () => {
    const withSteps = summarizeApproval({
      id: 'a3',
      action: 'multi.step',
      steps: ['open page', { action: 'click', selector: '#ok' }, 42],
      args_hash: 'abc123',
      effective_caps: ['browser.read', 'files.write'],
    });
    assert.ok(withSteps.steps.length >= 2);
    assert.equal(withSteps.argsHash, 'abc123');
    assert.match(withSteps.effectiveCaps ?? '', /browser/);
    const bare = summarizeApproval({ id: 'a4' });
    assert.equal(bare.action, 'Approval requested');
    assert.equal(bare.hasArgs, false);
    assert.equal(bare.argsHash, undefined);
    assert.equal(bare.effectiveCaps, undefined);
    assert.equal(bare.steps.length, 0);
  });

  it('never throws on unknown approval shapes', () => {
    const summary = summarizeApproval({
      id: 'weird',
      totally_unknown_field: { deep: [1, 2, 3] },
    } as unknown as { id: string });
    assert.equal(summary.id, 'weird');
    assert.ok(summary.summary.length > 0);
  });
});

describe('task relationships (pure, compatible)', () => {
  it('parses snake_case and camelCase ids, ignores malformed lists', () => {
    const snake = parseTaskRelations({
      parent_task_id: 'task_parent',
      root_task_id: 'task_root',
      child_task_ids: ['task_c1', 'task_c2'],
      waiting_children: ['task_c1'],
    });
    assert.equal(snake.parentTaskId, 'task_parent');
    assert.equal(snake.rootTaskId, 'task_root');
    assert.deepEqual(snake.childTaskIds, ['task_c1', 'task_c2']);
    assert.deepEqual(snake.waitingChildren, ['task_c1']);
    const camel = parseTaskRelations({
      parentTaskId: 'p',
      childTaskIds: [{ id: 'c1' }, 'c2', 42, ''],
      waitingChildren: 'c1',
    });
    assert.equal(camel.parentTaskId, 'p');
    assert.deepEqual(camel.childTaskIds, ['c1', 'c2']);
    assert.deepEqual(camel.waitingChildren, ['c1']);
    const empty = parseTaskRelations({ status: 'running' });
    assert.equal(empty.parentTaskId, undefined);
    assert.deepEqual(empty.childTaskIds, []);
    assert.deepEqual(empty.waitingChildren, []);
  });
});
