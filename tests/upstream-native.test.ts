// FULL native upstream REST: pinned OpenBot delivery API via the paired home.
// Run: npm test (fixtures only; no live Intelligence, no model calls).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  UPSTREAM_NATIVE_PIN,
  UPSTREAM_NATIVE_SOURCE,
  NATIVE_ROUTES,
  NATIVE_MESSAGE_MAX_CHARS,
  isUuid,
  parseNativeBot,
  parseNativeBotList,
  parseNativeChannel,
  parseNativeChannelEnvelope,
  parseNativeConversationPage,
  parseNativeHistory,
  parseNativeBotTask,
  resolveUpstreamNativeBase,
  transcriptText,
  UpstreamNativeClient,
  UpstreamNativeScope,
  PairedHomeClient,
  createMemorySecureStorage,
  createMemoryCacheStorage,
  parseUpstreamCapability,
  selectExecutionMode,
} from '../src/index.ts';
import type { NativeTransport } from '../src/index.ts';
import { HomeClientError } from '../src/errors.ts';
import { randomUuidV4 } from '../src/paired-home-client.ts';

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';

function fixtureTransport(
  routes: Record<string, unknown>,
  seen: Array<{ path: string; method: string; body?: Record<string, unknown> }> = [],
): NativeTransport {
  return {
    request: async (path, init) => {
      seen.push({ path, method: init.method, body: init.body });
      if (!(path in routes)) {
        throw new HomeClientError('NOT_FOUND', 'Not found at this home.');
      }
      return routes[path];
    },
  };
}

describe('native pin (verified actual upstream, not assumed SDK)', () => {
  it('pins the exact OpenBot source the DTOs/routes mirror', () => {
    assert.equal(UPSTREAM_NATIVE_PIN, '6bfee780c8e8d05141375ea55ebde33eefb3dbc0');
    assert.equal(UPSTREAM_NATIVE_SOURCE, 'CopilotKit/OpenBot');
    assert.equal(NATIVE_ROUTES.agents, '/api/agents');
    assert.equal(NATIVE_ROUTES.channels, '/api/channels/');
    assert.equal(
      NATIVE_ROUTES.messages('chan-1'),
      '/api/delivery/conversations/chan-1/messages',
    );
  });

  it('routes stay under /api/ (same paired authority, no cloud)', () => {
    for (const path of Object.values(NATIVE_ROUTES)) {
      if (typeof path === 'string') assert.match(path, /^\/api\//);
    }
  });
});

describe('resolveUpstreamNativeBase (same home authority, never managed cloud)', () => {
  it('derives origin without any /api/copilotkit mount', () => {
    assert.equal(
      resolveUpstreamNativeBase('https://home.example/'),
      'https://home.example',
    );
    assert.equal(
      resolveUpstreamNativeBase('https://home.example:8443/tunnel/'),
      'https://home.example:8443',
    );
  });

  it('allows http loopback for local development only', () => {
    assert.equal(
      resolveUpstreamNativeBase('http://127.0.0.1:8080'),
      'http://127.0.0.1:8080',
    );
  });

  it('refuses non-loopback http, managed cloud, credentials, empty', () => {
    assert.throws(
      () => resolveUpstreamNativeBase('http://home.example/'),
      (e: unknown) => e instanceof HomeClientError,
    );
    assert.throws(
      () => resolveUpstreamNativeBase('https://app.copilotkit.ai/'),
      (e: unknown) => e instanceof HomeClientError,
    );
    assert.throws(
      () => resolveUpstreamNativeBase('https://user:pass@home.example/'),
      (e: unknown) => e instanceof HomeClientError,
    );
    assert.throws(
      () => resolveUpstreamNativeBase(''),
      (e: unknown) =>
        e instanceof HomeClientError && e.code === 'UPSTREAM_NOT_CONFIGURED',
    );
  });
});

describe('strict native parsers (malformed upstream shapes are null)', () => {
  const bot = { id: 'bot-1', name: 'Helper', mine: true, canManage: false };

  it('parses the roster in both envelope and bare shapes', () => {
    assert.deepEqual(parseNativeBotList({ agents: [bot] })?.length, 1);
    assert.deepEqual(parseNativeBotList([bot])?.length, 1);
    assert.equal(parseNativeBotList({ agents: [{ ...bot, mine: 'yes' }] }), null);
    assert.equal(parseNativeBotList({}), null);
    assert.equal(parseNativeBot({ id: '', name: 'x', mine: true, canManage: false }), null);
  });

  it('parses channels, envelopes, and both page keys', () => {
    const channel = { id: 'chan-1', name: 'Chat', agentIds: ['bot-1'], active: true };
    assert.deepEqual(parseNativeChannel(channel)?.id, 'chan-1');
    assert.deepEqual(parseNativeChannelEnvelope({ channel })?.id, 'chan-1');
    assert.deepEqual(
      parseNativeConversationPage({ conversations: [channel], nextCursor: null })?.channels.length,
      1,
    );
    assert.deepEqual(
      parseNativeConversationPage({ channels: [channel], nextCursor: 'c2' })?.nextCursor,
      'c2',
    );
    assert.equal(parseNativeConversationPage({ conversations: [{ id: 'x' }] }), null);
  });

  it('parses BOTH exact upstream history shapes (conversation.tsx:51-60)', () => {
    // Shape 1: { history: TranscriptMessage[] }.
    const arrayShape = {
      history: [
        { id: 'm1', role: 'user', content: 'hi' },
        { id: 'm2', role: 'assistant', content: [{ text: 'hello' }] },
      ],
    };
    assert.equal(parseNativeHistory(arrayShape)?.length, 2);
    // Shape 2 (Intelligence response): { history: { messages: [...] } }.
    const nestedShape = {
      history: {
        messages: [
          { id: 'm1', role: 'user', content: 'hi' },
          { id: 'm2', role: 'assistant', content: [{ output_text: 'hello' }] },
        ],
      },
    };
    const nested = parseNativeHistory(nestedShape);
    assert.equal(nested?.length, 2);
    assert.equal(nested?.[1].content !== undefined, true);
    // Malformed: neither shape, bad items, unbounded nesting guesses.
    assert.equal(parseNativeHistory({ history: [{ id: 'm1' }] }), null);
    assert.equal(parseNativeHistory({ history: { messages: [{ id: 'm1' }] } }), null);
    assert.equal(parseNativeHistory({ history: { other: [] } }), null);
    assert.equal(parseNativeHistory({}), null);
    assert.equal(parseNativeHistory({ history: 'nope' }), null);
  });

  it('parses native BotTasks strictly (GET /api/tasks list shape)', () => {
    const entry = {
      id: 'task-1',
      agentId: 'bot-1',
      channelId: 'chan-1',
      title: 'Check inbox',
      status: 'working',
      failure: null,
      next: 'reading mail',
      updatedAt: '2026-01-01T00:00:00Z',
    };
    assert.equal(parseNativeBotTask(entry)?.id, 'task-1');
    assert.equal(parseNativeBotTask({ ...entry, status: 'bogus' }), null);
    assert.equal(parseNativeBotTask({ ...entry, id: '' }), null);
    assert.equal(parseNativeBotTask({ ...entry, updatedAt: undefined }), null);
  });
});

describe('UpstreamNativeClient (real native endpoints, ht1 bearer transport)', () => {
  const bot = { id: 'bot-1', name: 'Helper', mine: true, canManage: false };
  const channel = { id: 'chan-1', name: 'Chat', agentIds: ['bot-1'], active: true };

  it('lists agents and creates channels with strict input validation', async () => {
    const seen: Array<{ path: string; method: string; body?: Record<string, unknown> }> = [];
    const client = new UpstreamNativeClient(
      fixtureTransport({ '/api/agents': { agents: [bot] }, '/api/channels/': { channel } }, seen),
    );
    const bots = await client.listAgents();
    assert.equal(bots[0].id, 'bot-1');
    const created = await client.createChannel([' bot-1 ', 'bot-1']);
    assert.equal(created.id, 'chan-1');
    // Trimmed + deduped before sending.
    assert.deepEqual(seen[1].body, { agentIds: ['bot-1'] });
    await assert.rejects(() => client.createChannel([]), HomeClientError);
    await assert.rejects(() => client.createChannel(['']), HomeClientError);
  });

  it('rejects contract-mismatched rosters instead of guessing', async () => {
    const client = new UpstreamNativeClient(
      fixtureTransport({ '/api/agents': { agents: 'nope' } }),
    );
    await assert.rejects(() => client.listAgents(), (e: unknown) =>
      e instanceof HomeClientError && e.code === 'CONTRACT_MISMATCH');
  });

  it('hydrates history per (channel, agent) with ownedScope enforced upstream', async () => {
    const seen: Array<{ path: string; method: string }> = [];
    const history = { history: [{ id: 'm1', role: 'assistant', content: 'hello' }] };
    const client = new UpstreamNativeClient(
      fixtureTransport({
        '/api/delivery/conversations/chan-1/history?agentId=bot-1': history,
      }, seen),
    );
    const messages = await client.getHistory('chan-1', 'bot-1');
    assert.equal(messages.length, 1);
    assert.equal(seen[0].path, '/api/delivery/conversations/chan-1/history?agentId=bot-1');
    await assert.rejects(() => client.getHistory('chan-1', ''), HomeClientError);
    await assert.rejects(() => client.getHistory('../evil', 'bot-1'), HomeClientError);
  });

  it('sends native messages with UUID idempotency, strict bounds', async () => {
    const seen: Array<{ path: string; method: string; body?: Record<string, unknown> }> = [];
    const client = new UpstreamNativeClient(
      fixtureTransport({ '/api/delivery/conversations/chan-1/messages': { ok: true } }, seen),
    );
    const receipt = await client.sendNativeMessage('chan-1', {
      agentId: 'bot-1',
      text: '  hello  ',
      externalId: UUID_A,
    });
    assert.equal(receipt.accepted, true);
    assert.equal(receipt.externalId, UUID_A);
    // Exact strict body the server zod expects; same key reusable for retries.
    assert.deepEqual(seen[0].body, { agentId: 'bot-1', text: 'hello', externalId: UUID_A });
    await client.sendNativeMessage('chan-1', { agentId: 'bot-1', text: 'retry', externalId: UUID_A });
    assert.deepEqual(seen[1].body?.['externalId'], UUID_A);
    // Guards: empty text, non-UUID key, over-limit text, empty agent.
    await assert.rejects(
      () => client.sendNativeMessage('chan-1', { agentId: 'bot-1', text: '   ', externalId: UUID_A }),
      (e: unknown) => e instanceof HomeClientError && e.code === 'INVALID_INPUT',
    );
    await assert.rejects(
      () => client.sendNativeMessage('chan-1', { agentId: 'bot-1', text: 'hi', externalId: 'not-a-uuid' }),
      (e: unknown) => e instanceof HomeClientError && e.code === 'INVALID_INPUT',
    );
    await assert.rejects(
      () => client.sendNativeMessage('chan-1', { agentId: 'bot-1', text: 'x'.repeat(NATIVE_MESSAGE_MAX_CHARS + 1), externalId: UUID_A }),
      (e: unknown) => e instanceof HomeClientError && e.code === 'INVALID_INPUT',
    );
    await assert.rejects(
      () => client.sendNativeMessage('chan-1', { agentId: '', text: 'hi', externalId: UUID_A }),
      (e: unknown) => e instanceof HomeClientError && e.code === 'INVALID_INPUT',
    );
  });

  it('generates no key silently: caller supplies UUID or explicit generator', async () => {
    const client = new UpstreamNativeClient(
      fixtureTransport({ '/api/delivery/conversations/chan-1/messages': {} }),
    );
    await assert.rejects(
      () => client.sendNativeMessage('chan-1', { agentId: 'bot-1', text: 'hi' }),
      (e: unknown) => e instanceof HomeClientError && e.code === 'INVALID_INPUT',
    );
    const receipt = await client.sendNativeMessage('chan-1', {
      agentId: 'bot-1',
      text: 'hi',
      generateId: () => UUID_B,
    });
    assert.equal(receipt.externalId, UUID_B);
    assert.ok(isUuid(randomUuidV4()));
  });

  it('lists native tasks and mutates via verified routes only', async () => {
    const seen: Array<{ path: string; method: string }> = [];
    const entry = {
      id: 'task-1',
      agentId: 'bot-1',
      channelId: 'chan-1',
      title: 'Check inbox',
      status: 'failed',
      failure: 'timeout',
      next: null,
      updatedAt: '2026-01-01T00:00:00Z',
    };
    const client = new UpstreamNativeClient(
      fixtureTransport(
        {
          '/api/tasks': { tasks: [entry] },
          '/api/tasks/task-1': { task: entry },
          '/api/tasks/task-1/again': {
            task: { ...entry, status: 'working', failure: null },
          },
        },
        seen,
      ),
    );
    const tasks = await client.listNativeTasks();
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].status, 'failed');
    const retried = await client.retryNativeTask('task-1');
    assert.equal(retried.status, 'working');
    assert.deepEqual(
      seen.map((s) => `${s.method} ${s.path}`),
      ['GET /api/tasks', 'POST /api/tasks/task-1/again'],
    );
    await assert.rejects(() => client.retryNativeTask('../evil'), HomeClientError);
    await assert.rejects(
      () => new UpstreamNativeClient(fixtureTransport({ '/api/tasks': { tasks: 'nope' } })).listNativeTasks(),
      (e: unknown) => e instanceof HomeClientError && e.code === 'CONTRACT_MISMATCH',
    );
  });

  it('reads and decides the verified approvals inbox (approvals.tsx callsites)', async () => {
    const seen: Array<{ path: string; method: string; body?: Record<string, unknown> }> = [];
    const inbox = {
      requests: [
        {
          id: 'r1',
          botId: 'bot-1',
          toolRef: 'mail.send',
          status: 'pending',
          effect: 'send',
          scope: 'mail',
          preview: { to: 'x' },
          action: { botId: 'bot-1', toolRef: 'mail.send', effect: 'send', scope: 'mail', args: {} },
        },
        { id: 'r2', status: 'resolved' },
      ],
      questions: [{ id: 'q1', question: 'Which day?', botId: 'bot-1', channelId: 'chan-1' }],
    };
    const client = new UpstreamNativeClient(
      fixtureTransport(
        {
          '/api/approvals': inbox,
          '/api/approvals/r1/decision': {},
          '/api/approvals/questions/q1/respond': {},
        },
        seen,
      ),
    );
    const fetched = await client.getNativeApprovals();
    assert.equal(fetched.requests.length, 2);
    assert.equal(fetched.questions?.length, 1);
    // Exact verified request shapes: decision union only, response passthrough.
    await client.decideNativeApproval('r1', 'allow_once');
    await client.decideNativeApproval('r1', 'allow_always');
    await client.decideNativeApproval('r1', 'deny');
    await client.respondNativeQuestion('q1', 'Tuesday');
    assert.deepEqual(
      seen.slice(1).map((s) => `${s.method} ${s.path} ${JSON.stringify(s.body)}`),
      [
        'POST /api/approvals/r1/decision {"decision":"allow_once"}',
        'POST /api/approvals/r1/decision {"decision":"allow_always"}',
        'POST /api/approvals/r1/decision {"decision":"deny"}',
        'POST /api/approvals/questions/q1/respond {"response":"Tuesday"}',
      ],
    );
    // Guards: invented decisions never sent; bad ids rejected.
    await assert.rejects(
      // @ts-expect-error invented decision string
      () => client.decideNativeApproval('r1', 'approve'),
      (e: unknown) => e instanceof HomeClientError && e.code === 'INVALID_INPUT',
    );
    await assert.rejects(() => client.decideNativeApproval('../evil', 'deny'), HomeClientError);
    await assert.rejects(() => client.respondNativeQuestion('', 'x'), HomeClientError);
    await assert.rejects(
      () => new UpstreamNativeClient(fixtureTransport({ '/api/approvals': { requests: 'nope' } })).getNativeApprovals(),
      (e: unknown) => e instanceof HomeClientError && e.code === 'CONTRACT_MISMATCH',
    );
  });
});

describe('transcriptText (never fabricates prose)', () => {
  it('maps string, text/output_text blocks; tool/reasoning/unknown map to null', () => {
    assert.equal(transcriptText({ id: 'm1', role: 'assistant', content: '  hi  ' }), 'hi');
    assert.equal(
      transcriptText({ id: 'm2', role: 'assistant', content: [{ text: 'a' }, { output_text: 'b' }] }),
      'a\nb',
    );
    assert.equal(transcriptText({ id: 'm3', role: 'assistant', toolCalls: [{}] }), null);
    assert.equal(transcriptText({ id: 'm4', role: 'assistant', content: '   ' }), null);
    assert.equal(transcriptText({ id: 'm5', role: 'assistant', content: [{ reasoning: 'x' }] }), null);
  });
});

describe('proxyNativeApi guards (token never leaves PairedHomeClient)', () => {
  function unpaired(): PairedHomeClient {
    return new PairedHomeClient(createMemorySecureStorage(), createMemoryCacheStorage());
  }

  it('refuses non-/api/ paths, traversal, bad methods, private fields', async () => {
    const client = unpaired();
    await assert.rejects(() => client.proxyNativeApi('/v1/me'), HomeClientError);
    await assert.rejects(
      () => client.proxyNativeApi('https://evil.invalid/api/agents'),
      HomeClientError,
    );
    await assert.rejects(() => client.proxyNativeApi('/api/../evil'), HomeClientError);
    await assert.rejects(
      () => client.proxyNativeApi('/api/agents', { method: 'PUT' }),
      HomeClientError,
    );
    await assert.rejects(
      () =>
        client.proxyNativeApi('/api/delivery/conversations/c/messages', {
          method: 'POST',
          body: { agentId: 'b', text: 'hi', COPILOTKIT_LICENSE_TOKEN: 'secret' },
        }),
      (e: unknown) => e instanceof HomeClientError && e.code === 'INVALID_INPUT',
    );
    // Validation fires before auth: unpaired maps to UNPAIRED only for valid calls.
    await assert.rejects(
      () => client.proxyNativeApi('/api/agents'),
      (e: unknown) => e instanceof HomeClientError && e.code === 'UNPAIRED',
    );
  });
});

describe('UpstreamNativeScope (generation fencing, no second store)', () => {
  const bot = { id: 'bot-1', name: 'Helper', mine: true, canManage: false };
  const channel = { id: 'chan-1', name: 'Chat', agentIds: ['bot-1'], active: true };

  it('prunes only dropped conversations and clears on reset', () => {
    const scope = new UpstreamNativeScope();
    scope.bindScope('scope-a');
    scope.noteBots([bot]);
    scope.noteChannel('keep', channel);
    scope.noteChannel('drop', channel);
    scope.dropConversations(['drop']);
    assert.equal(scope.channelFor('keep')?.id, 'chan-1');
    assert.equal(scope.channelFor('drop'), null);
    assert.equal(scope.channelCount(), 1);
  });

  it('late callbacks after logout never publish', async () => {
    const scope = new UpstreamNativeScope();
    scope.bindScope('scope-a');
    const before = scope.capture();
    assert.equal(scope.shouldPublish(before), true);
    await scope.resetScope('logout');
    assert.equal(scope.channelCount(), 0);
    assert.equal(scope.cachedBots(), null);
    assert.equal(scope.shouldPublish(before), false);
    assert.equal(scope.shouldPublish(scope.capture()), true);
  });

  it('rebinding to a new scope resets the old cache', async () => {
    const scope = new UpstreamNativeScope();
    scope.bindScope('scope-a');
    scope.noteChannel('c1', channel);
    scope.bindScope('scope-b');
    assert.equal(scope.channelCount(), 0);
  });
});

describe('ready gating (FULL only on a complete capability, never silent legacy)', () => {
  it('full + complete capability runs full; otherwise setup-needed', () => {
    const complete = parseUpstreamCapability({
      agentMode: 'full-upstream',
      fullConfigured: true,
      needsSetup: false,
      user_id: 'u1',
    });
    assert.equal(selectExecutionMode('full', complete), 'full');
    assert.equal(selectExecutionMode('full', null), 'setup-needed');
    assert.equal(selectExecutionMode('legacy', complete), 'legacy');
    assert.equal(selectExecutionMode('demo', complete), 'demo');
  });
});
