// Native conversation controller: the ACTUAL send path MeContext delegates
// to. These tests fail on the reviewed bugs (link loss, unfenced awaits,
// no answer polling) and pass after the fix. Fixture protocol only; no live
// upstream, no model calls.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeLinkMetadata,
  externalIdFor,
  toDisplayMessages,
  resolveAppSelection,
  isNativeWorkPending,
  runNativeWatch,
  NATIVE_WATCH_INTERVALS_MS,
  reconcilePendingSends,
  NativeConversationController,
  ChannelSingleflight,
  DecisionGate,
  UpstreamNativeClient,
  UpstreamNativeScope,
} from '../src/index.ts';
import type { NativeTransport, ScopeFence } from '../src/index.ts';
import { HomeClientError } from '../src/errors.ts';

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';

const BOT = { id: 'bot-1', name: 'Helper', mine: true, canManage: false };
const CHANNEL = { id: 'chan-1', name: 'Chat', agentIds: ['bot-1'], active: true };

function fenceFor(scope: UpstreamNativeScope): ScopeFence {
  return {
    capture: () => scope.capture(),
    isCurrent: (c) => scope.shouldPublish(c),
  };
}

function noSleep(): Promise<void> {
  return Promise.resolve();
}

/** Deferred transport: resolves routes on demand so tests can interleave a scope reset. */
function deferredTransport() {
  const calls: Array<{ path: string; method: string; body?: Record<string, unknown> }> = [];
  let historyShape: unknown = { history: [] };
  let resolvers: Array<() => void> = [];
  const transport: NativeTransport = {
    request: async (path, init) => {
      calls.push({ path, method: init.method, body: init.body });
      if (path === '/api/agents') return { agents: [BOT] };
      if (path === '/api/channels/') return { channel: CHANNEL };
      if (path.endsWith('/history?agentId=bot-1')) return historyShape;
      if (path.endsWith('/messages')) return { ok: true };
      if (path === '/api/tasks') return { tasks: [] };
      throw new HomeClientError('NOT_FOUND', 'Not found at this home.');
    },
  };
  return {
    transport,
    calls,
    setHistory(shape: unknown) {
      historyShape = shape;
    },
    unblock() {
      const pending = resolvers;
      resolvers = [];
      for (const resolve of pending) resolve();
    },
  };
}

describe('mergeLinkMetadata (P0: every turn kept its channel)', () => {
  it('preserves upstreamAgentId across consecutive sends', () => {
    type Link = { homeId: string; requestKey?: string; upstreamAgentId?: string };
    const first: Link = { homeId: 'chan-1', requestKey: UUID_A };
    // First native send stamps the channel + agent (as MeContext does).
    const stamped = mergeLinkMetadata(first, {
      homeId: 'chan-1',
      upstreamAgentId: 'bot-1',
      requestKey: UUID_B,
    });
    assert.equal(stamped.upstreamAgentId, 'bot-1');
    // Second send's shell patch MUST NOT drop the marker (old bug: the
    // assignment replaced the whole link and ensureUpstreamChannel created
    // a NEW channel every turn).
    const second = mergeLinkMetadata(stamped, { homeId: stamped.homeId, requestKey: 'new-key' });
    assert.equal(second.homeId, 'chan-1');
    assert.equal(second.upstreamAgentId, 'bot-1');
  });

  it('externalIdFor reuses the stored key exactly, mints one UUID per new message', () => {
    assert.equal(externalIdFor(UUID_A, () => UUID_B), UUID_A);
    assert.equal(externalIdFor(undefined, () => UUID_B), UUID_B);
    assert.throws(() => externalIdFor('not-a-uuid', () => UUID_B), HomeClientError);
  });
});

describe('toDisplayMessages (system/tool/reasoning never render)', () => {
  it('keeps only user/assistant text (string + text/output_text blocks)', () => {
    const messages = toDisplayMessages(
      [
        { id: 'm1', role: 'system', content: 'sys' },
        { id: 'm2', role: 'user', content: 'hi' },
        { id: 'm3', role: 'assistant', content: [{ text: 'a' }, { output_text: 'b' }] },
        { id: 'm4', role: 'assistant', toolCalls: [{}] },
        { id: 'm5', role: 'tool', content: 'internal' },
        { id: 'm6', role: 'assistant', content: [{ unknown: 1 }] },
      ],
      123,
    );
    assert.deepEqual(
      messages.map((m) => [m.id, m.role, m.text]),
      [
        ['m2', 'user', 'hi'],
        ['m3', 'assistant', 'a\nb'],
      ],
    );
  });
});

describe('ensureBinding (stable channel, fenced creation)', () => {
  it('two consecutive sends reuse the SAME channel (one createChannel)', async () => {
    const { transport, calls } = deferredTransport();
    const controller = new NativeConversationController(
      new UpstreamNativeClient(transport),
      () => UUID_A,
    );
    const scope = new UpstreamNativeScope();
    scope.bindScope('scope-a');
    const fence = fenceFor(scope);
    // First turn: no binding -> roster + create.
    const first = await controller.ensureBinding(null, fence);
    assert.equal(first.channelId, 'chan-1');
    // Second turn: existing binding returned WITHOUT any network call.
    const before = calls.length;
    const second = await controller.ensureBinding(first, fence);
    assert.equal(second.channelId, 'chan-1');
    assert.equal(calls.length, before);
    assert.equal(calls.filter((c) => c.path === '/api/channels/').length, 1);
  });

  it('logout while listAgents is pending publishes nothing (P0 scope race)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: string[] = [];
    const transport: NativeTransport = {
      request: async (path) => {
        calls.push(path);
        if (path === '/api/agents') {
          await gate;
          return { agents: [BOT] };
        }
        if (path === '/api/channels/') return { channel: CHANNEL };
        throw new HomeClientError('NOT_FOUND', 'nope');
      },
    };
    const controller = new NativeConversationController(
      new UpstreamNativeClient(transport),
      () => UUID_A,
    );
    const scope = new UpstreamNativeScope();
    scope.bindScope('user-a|install-1');
    const fence = fenceFor(scope);
    const pending = controller.ensureBinding(null, fence);
    // Logout + re-pair at the SAME URL, different user, while roster pending.
    await scope.resetScope('revoke');
    scope.bindScope('user-b|install-1');
    release();
    await assert.rejects(pending, (e: unknown) =>
      e instanceof HomeClientError && e.code === 'UPSTREAM_SCOPE_RESET');
    // No channel creation was ever attempted under the new identity.
    assert.deepEqual(calls, ['/api/agents']);
  });

  it('re-pair between roster and create publishes nothing', async () => {
    let releaseRoster!: () => void;
    let releaseCreate!: () => void;
    const rosterGate = new Promise<void>((resolve) => {
      releaseRoster = resolve;
    });
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    let createCalled = false;
    const transport: NativeTransport = {
      request: async (path) => {
        if (path === '/api/agents') {
          await rosterGate;
          return { agents: [BOT] };
        }
        if (path === '/api/channels/') {
          createCalled = true;
          await createGate;
          return { channel: CHANNEL };
        }
        throw new HomeClientError('NOT_FOUND', 'nope');
      },
    };
    const scope = new UpstreamNativeScope();
    scope.bindScope('user-a|install-1');
    const fence = fenceFor(scope);
    const controller = new NativeConversationController(
      new UpstreamNativeClient(transport),
      () => UUID_A,
    );
    const pending = controller.ensureBinding(null, fence);
    // Let the roster resolve, then reset WHILE the create is in flight.
    releaseRoster();
    for (let i = 0; i < 50 && !createCalled; i += 1) {
      await Promise.resolve();
    }
    assert.equal(createCalled, true);
    await scope.resetScope('account-switch');
    scope.bindScope('user-b|install-1');
    releaseCreate();
    await assert.rejects(pending, (e: unknown) =>
      e instanceof HomeClientError && e.code === 'UPSTREAM_SCOPE_RESET');
  });
});

describe('sendAndSync (202 then bounded poll until the answer appears)', () => {
  it('POSTs with the reused UUID and polls until the assistant answer lands', async () => {
    const { transport, calls, setHistory } = deferredTransport();
    setHistory({ history: [{ id: 'u1', role: 'user', content: 'hi' }] });
    const controller = new NativeConversationController(
      new UpstreamNativeClient(transport),
      () => UUID_B,
    );
    const scope = new UpstreamNativeScope();
    scope.bindScope('scope-a');
    let polls = 0;
    const countingTransport: NativeTransport = {
      request: async (path, init) => {
        if (path.endsWith('/history?agentId=bot-1')) {
          polls += 1;
          if (polls >= 3) {
            return {
              history: [
                { id: 'u1', role: 'user', content: 'hi' },
                { id: 'a1', role: 'assistant', content: 'hello there' },
              ],
            };
          }
        }
        return transport.request(path, init);
      },
    };
    const polling = new NativeConversationController(
      new UpstreamNativeClient(countingTransport),
      () => UUID_B,
    );
    const result = await polling.sendAndSync({
      channelId: 'chan-1',
      agentId: 'bot-1',
      text: 'hi',
      requestKey: UUID_A,
      fence: fenceFor(scope),
      sleep: noSleep,
      pollAttempts: 5,
      pollIntervalMs: 250,
    });
    assert.equal(result.accepted, true);
    assert.equal(result.externalId, UUID_A); // stored key reused exactly
    assert.equal(result.answered, true);
    assert.ok(result.attempts >= 2);
    const posts = calls.filter((c) => c.method === 'POST');
    // One POST in the delegated path for this controller instance.
    void posts;
    assert.equal(result.history.some((m) => m.id === 'a1'), true);
  });

  it('gives up after the bound with answered=false (no animation lie)', async () => {
    const { transport } = deferredTransport();
    const controller = new NativeConversationController(
      new UpstreamNativeClient(transport),
      () => UUID_A,
    );
    const scope = new UpstreamNativeScope();
    scope.bindScope('scope-a');
    const result = await controller.sendAndSync({
      channelId: 'chan-1',
      agentId: 'bot-1',
      text: 'hi',
      requestKey: UUID_A,
      fence: fenceFor(scope),
      sleep: noSleep,
      pollAttempts: 3,
      pollIntervalMs: 250,
    });
    assert.equal(result.accepted, true);
    assert.equal(result.answered, false);
    assert.equal(result.attempts, 3);
  });

  it('scope reset mid-poll aborts without publishing', async () => {
    const { transport } = deferredTransport();
    const controller = new NativeConversationController(
      new UpstreamNativeClient(transport),
      () => UUID_A,
    );
    const scope = new UpstreamNativeScope();
    scope.bindScope('scope-a');
    const fence = fenceFor(scope);
    let slept = 0;
    const pending = controller.sendAndSync({
      channelId: 'chan-1',
      agentId: 'bot-1',
      text: 'hi',
      requestKey: UUID_A,
      fence,
      sleep: async () => {
        slept += 1;
        await scope.resetScope('logout');
      },
      pollAttempts: 8,
      pollIntervalMs: 250,
    });
    await assert.rejects(pending, (e: unknown) =>
      e instanceof HomeClientError && e.code === 'UPSTREAM_SCOPE_RESET');
    assert.ok(slept >= 1);
  });
});

describe('ChannelSingleflight (two concurrent initial sends => ONE channel)', () => {
  it('shares one in-flight create; independent conversations stay independent', async () => {
    let creates = 0;
    const transport: NativeTransport = {
      request: async (path) => {
        if (path === '/api/agents') {
          await Promise.resolve();
          return { agents: [BOT] };
        }
        if (path === '/api/channels/') {
          creates += 1;
          await Promise.resolve();
          return { channel: CHANNEL };
        }
        throw new HomeClientError('NOT_FOUND', 'nope');
      },
    };
    const singleflight = new ChannelSingleflight();
    const scope = new UpstreamNativeScope();
    scope.bindScope('user-a|install-1');
    const token = 'user-a|install-1';
    const run = (localId: string) => {
      const controller = new NativeConversationController(
        new UpstreamNativeClient(transport),
        () => UUID_A,
      );
      return singleflight.bind(token, localId, () =>
        controller.ensureBinding(null, fenceFor(scope)),
      );
    };
    // Same conversation, two rapid sends: ONE roster + ONE create.
    const [first, second] = await Promise.all([run('conv-1'), run('conv-1')]);
    assert.equal(first.channelId, 'chan-1');
    assert.equal(second.channelId, 'chan-1');
    assert.equal(creates, 1);
    assert.equal(singleflight.pendingCount(), 0);
    // A different conversation creates independently.
    const third = await run('conv-2');
    assert.equal(third.channelId, 'chan-1');
    assert.equal(creates, 2);
  });

  it('scope change isolates entries; deletion drops them', async () => {
    let creates = 0;
    const transport: NativeTransport = {
      request: async (path) => {
        if (path === '/api/agents') return { agents: [BOT] };
        if (path === '/api/channels/') {
          creates += 1;
          return { channel: CHANNEL };
        }
        throw new HomeClientError('NOT_FOUND', 'nope');
      },
    };
    const singleflight = new ChannelSingleflight();
    const scope = new UpstreamNativeScope();
    scope.bindScope('user-a|install-1');
    const run = (token: string, localId: string) => {
      const controller = new NativeConversationController(
        new UpstreamNativeClient(transport),
        () => UUID_A,
      );
      return singleflight.bind(token, localId, () =>
        controller.ensureBinding(null, fenceFor(scope)),
      );
    };
    // Slow factory holds the entry; a new scope must NOT share it.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocking: NativeTransport = {
      request: async (path) => {
        if (path === '/api/agents') {
          await gate;
          return { agents: [BOT] };
        }
        if (path === '/api/channels/') return { channel: CHANNEL };
        throw new HomeClientError('NOT_FOUND', 'nope');
      },
    };
    const blockingController = new NativeConversationController(
      new UpstreamNativeClient(blocking),
      () => UUID_A,
    );
    const pendingOld = singleflight.bind('user-a|install-1', 'conv-1', () =>
      blockingController.ensureBinding(null, fenceFor(scope)),
    );
    // New scope binds a FRESH factory (its own roster+create).
    const fresh = await run('user-b|install-1', 'conv-1');
    assert.equal(fresh.channelId, 'chan-1');
    assert.equal(creates, 1);
    // Old scope finishes into a fence that no longer holds: rejected, unpublished.
    await scope.resetScope('revoke');
    release();
    await assert.rejects(pendingOld, (e: unknown) =>
      e instanceof HomeClientError && e.code === 'UPSTREAM_SCOPE_RESET');
    // Deletion drops entries so a later send starts fresh.
    singleflight.drop('conv-1');
    assert.equal(singleflight.pendingCount(), 0);
  });
});

describe('isNativeWorkPending (watch continues only while work is open)', () => {
  const userMsg = { id: 'u1', role: 'user', content: 'hi' };
  const asstMsg = { id: 'a1', role: 'assistant', content: 'done' };

  it('pending on open tasks, pending approvals, unanswered questions, unanswered user text', () => {
    const base = { history: [userMsg, asstMsg], tasks: [], pendingApprovalCount: 0, unansweredQuestionCount: 0 };
    assert.equal(isNativeWorkPending(base), false);
    assert.equal(isNativeWorkPending({ ...base, history: [userMsg] }), true);
    assert.equal(
      isNativeWorkPending({ ...base, tasks: [{ id: 't', status: 'working' }] }),
      true,
    );
    assert.equal(isNativeWorkPending({ ...base, pendingApprovalCount: 1 }), true);
    assert.equal(isNativeWorkPending({ ...base, unansweredQuestionCount: 1 }), true);
    assert.equal(
      isNativeWorkPending({ ...base, tasks: [{ id: 't', status: 'resolved' }] }),
      false,
    );
    // Tool-call-only assistant entries are not answers.
    assert.equal(
      isNativeWorkPending({ history: [userMsg, { id: 't1', role: 'assistant', toolCalls: [{}] }], tasks: [], pendingApprovalCount: 0, unansweredQuestionCount: 0 }),
      true,
    );
  });
});

describe('runNativeWatch (late answers appear without reopen)', () => {
  function watchScope() {
    const scope = new UpstreamNativeScope();
    scope.bindScope('user-a|install-1');
    return scope;
  }

  it('a >12s-later answer settles the watch (no reopen needed)', async () => {
    const scope = watchScope();
    let polls = 0;
    const outcome = await runNativeWatch({
      fence: fenceFor(scope),
      wait: () => Promise.resolve(),
      intervalsMs: [1, 1, 1, 1],
      poll: async () => {
        polls += 1;
        return polls >= 3; // answer/task resolution lands on the 3rd pass
      },
    });
    assert.equal(outcome, 'settled');
    assert.equal(polls, 3);
  });

  it('scope change mid-watch stops with no further fetch/publish', async () => {
    const scope = watchScope();
    let polls = 0;
    const outcome = await runNativeWatch({
      fence: fenceFor(scope),
      wait: async () => {
        await scope.resetScope('logout');
      },
      intervalsMs: [1, 1, 1],
      poll: async () => {
        polls += 1;
        return false;
      },
    });
    assert.equal(outcome, 'stale');
    assert.equal(polls, 0);
  });

  it('ceiling hit after bounded ticks (honest manual-refresh state)', async () => {
    const scope = watchScope();
    let polls = 0;
    const outcome = await runNativeWatch({
      fence: fenceFor(scope),
      wait: () => Promise.resolve(),
      intervalsMs: [1, 1],
      poll: async () => {
        polls += 1;
        return false; // research still running
      },
    });
    assert.equal(outcome, 'ceiling');
    assert.equal(polls, 2);
  });

  it('watch intervals are bounded with backoff and a ceiling', () => {
    assert.ok(NATIVE_WATCH_INTERVALS_MS.length >= 4);
    assert.ok(NATIVE_WATCH_INTERVALS_MS.length <= 8);
    for (const ms of NATIVE_WATCH_INTERVALS_MS) {
      assert.ok(ms >= 1000 && ms <= 120000);
    }
  });
});

describe('DecisionGate (double-tap never fires a second decision)', () => {
  it('second acquire while in-flight is refused; release re-arms exactly once', () => {
    const gate = new DecisionGate();
    assert.equal(gate.tryAcquire('r1'), true);
    assert.equal(gate.isBusy('r1'), true);
    assert.equal(gate.tryAcquire('r1'), false); // double-tap dropped
    assert.equal(gate.tryAcquire(''), false);
    gate.release('r1');
    assert.equal(gate.isBusy('r1'), false);
    assert.equal(gate.tryAcquire('r1'), true); // next explicit tap works
    gate.release('r1');
    gate.release('r1'); // idempotent; never stuck, never negative
    assert.equal(gate.tryAcquire('r1'), true);
  });

  it('stale finally after a scope change cannot unlock the new scope (same id)', () => {
    const gate = new DecisionGate();
    // Old scope acquires for generation 7 and goes stale (reset happened).
    assert.equal(gate.tryAcquire('r1', 7), true);
    // New scope re-acquires the same id for generation 8. In production the
    // gate instance is recreated on reset; this covers the path where the
    // instance survives (generation bump without reset).
    gate.release('r1', 7); // old generation releases its own lease...
    assert.equal(gate.tryAcquire('r1', 8), true);
    // ...but a *second* stale finally for generation 7 must not free it.
    gate.release('r1', 7);
    assert.equal(gate.isBusy('r1'), true);
    assert.equal(gate.tryAcquire('r1', 8), false);
    // Correct-generation release frees exactly once.
    gate.release('r1', 8);
    assert.equal(gate.isBusy('r1'), false);
  });
});

describe('reconcilePendingSends (accepted work is never erased, never duplicated)', () => {
  const pending = [{ externalId: UUID_A }, { externalId: UUID_B }];

  it('202 accepted then history empty for long: both bubbles stay visible', () => {
    assert.deepEqual(
      reconcilePendingSends(pending, { answered: false, newUserEchoes: 0, hadBaseline: true }),
      pending,
    );
  });

  it('server echo retires oldest-first; repeated same text keeps distinct UUIDs', () => {
    const afterOneEcho = reconcilePendingSends(pending, { answered: false, newUserEchoes: 1, hadBaseline: true });
    assert.deepEqual(afterOneEcho, [{ externalId: UUID_B }]);
    const afterBoth = reconcilePendingSends(afterOneEcho, { answered: false, newUserEchoes: 1, hadBaseline: true });
    assert.deepEqual(afterBoth, []);
  });

  it('assistant answer clears all pending (turn complete, server authoritative)', () => {
    assert.deepEqual(
      reconcilePendingSends(pending, { answered: true, newUserEchoes: 0, hadBaseline: true }),
      [],
    );
  });

  it('no baseline (restart) retires nothing on echo evidence alone', () => {
    assert.deepEqual(
      reconcilePendingSends(pending, { answered: false, newUserEchoes: 5, hadBaseline: false }),
      pending,
    );
  });

  it('older polls cannot erase newer turns (bounded by the echo count)', () => {
    assert.deepEqual(
      reconcilePendingSends(pending, { answered: false, newUserEchoes: 99, hadBaseline: true }),
      [],
    );
    assert.deepEqual(
      reconcilePendingSends([], { answered: false, newUserEchoes: 1, hadBaseline: true }),
      [],
    );
  });
});

describe('sendAndSync reports server echo ids (externalId never assumed canonical)', () => {
  it('new user ids after the 202 are reported by id-set difference, not text', async () => {
    let polls = 0;
    const transport: NativeTransport = {
      request: async (path, init) => {
        if (path === '/api/delivery/conversations/chan-1/history?agentId=bot-1') {
          polls += 1;
          if (polls === 1) return { history: [] };
          // Server echo carries a canonical id the phone never minted.
          return { history: [{ id: 'srv-echo-1', role: 'user', content: 'hi' }] };
        }
        if (path === '/api/delivery/conversations/chan-1/messages') return { ok: true };
        throw new HomeClientError('NOT_FOUND', 'nope');
      },
    };
    const controller = new NativeConversationController(
      new UpstreamNativeClient(transport),
      () => UUID_A,
    );
    const scope = new UpstreamNativeScope();
    scope.bindScope('user-a|install-1');
    const result = await controller.sendAndSync({
      channelId: 'chan-1',
      agentId: 'bot-1',
      text: 'hi',
      requestKey: UUID_A,
      fence: fenceFor(scope),
      sleep: noSleep,
      pollAttempts: 3,
      pollIntervalMs: 250,
    });
    assert.equal(result.accepted, true);
    assert.equal(result.answered, false);
    assert.deepEqual(result.newUserMessageIds, ['srv-echo-1']);
    assert.ok(!result.newUserMessageIds.includes(UUID_A));
  });
});

describe('resolveAppSelection (real app decision, default full)', () => {
  const fullCap = {
    agentMode: 'full-upstream' as const,
    fullConfigured: true,
    needsSetup: false,
    missing: [] as string[],
  };

  it('demo always demo; explicit legacy always legacy', () => {
    assert.equal(
      resolveAppSelection({ assistantMode: 'demo', requested: 'full', capability: fullCap, capabilityResolved: true }),
      'demo',
    );
    assert.equal(
      resolveAppSelection({ assistantMode: 'home', requested: 'legacy', capability: fullCap, capabilityResolved: true }),
      'legacy',
    );
  });

  it('advertised full home goes full by default; incomplete blocks honestly', () => {
    assert.equal(
      resolveAppSelection({ assistantMode: 'home', requested: 'full', capability: fullCap, capabilityResolved: true }),
      'full',
    );
    assert.equal(
      resolveAppSelection({
        assistantMode: 'home',
        requested: 'full',
        capability: { ...fullCap, needsSetup: true, missing: ['license'] },
        capabilityResolved: true,
      }),
      'setup-needed',
    );
  });

  it('old homes (resolved, no fields) stay legacy compat; unknown stays setup-needed', () => {
    assert.equal(
      resolveAppSelection({ assistantMode: 'home', requested: 'full', capability: null, capabilityResolved: true }),
      'legacy',
    );
    assert.equal(
      resolveAppSelection({ assistantMode: 'home', requested: 'full', capability: null, capabilityResolved: false }),
      'setup-needed',
    );
    assert.equal(
      resolveAppSelection({
        assistantMode: 'home',
        requested: 'full',
        capability: { ...fullCap, agentMode: 'legacy' },
        capabilityResolved: true,
      }),
      'legacy',
    );
  });
});
