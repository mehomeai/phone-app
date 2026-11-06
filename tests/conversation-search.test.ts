// Conversation search: display-text-only indexing, AND semantics,
// deterministic ranking, bounded snippets. Fixtures only; no live calls.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildConversationSearchIndex,
  searchConversations,
} from '../src/index.ts';
import type {
  ConversationSearchInput,
  NativeTranscriptMessage,
} from '../src/index.ts';

function msg(
  id: string,
  role: string,
  content?: string | unknown[],
  toolCalls?: unknown[],
): NativeTranscriptMessage {
  const message: NativeTranscriptMessage = { id, role };
  if (content !== undefined) message.content = content;
  if (toolCalls !== undefined) message.toolCalls = toolCalls;
  return message;
}

function conv(
  id: string,
  messages: NativeTranscriptMessage[],
  extra: Partial<ConversationSearchInput> = {},
): ConversationSearchInput {
  return { id, messages, ...extra };
}

describe('conversation search', () => {
  it('indexes only display-role transcript text and excludes tool payloads and reasoning', () => {
    const index = buildConversationSearchIndex([
      conv('c1', [
        msg('m1', 'assistant', 'the deploy checklist is ready'),
        msg('m2', 'system', 'systemonlyword reminder'),
        msg('m3', 'tool', undefined, [{ name: 'run', args: 'toolonlyword' }]),
        msg('m4', 'assistant', [
          { type: 'tool-call', toolName: 'run', args: { cmd: 'payloadonlyword' } },
        ]),
      ]),
    ]);
    assert.equal(searchConversations(index, 'deploy').length, 1);
    assert.deepEqual(searchConversations(index, 'systemonlyword'), []);
    assert.deepEqual(searchConversations(index, 'toolonlyword'), []);
    assert.deepEqual(searchConversations(index, 'payloadonlyword'), []);
  });

  it('normalizes Unicode and case and tokenizes punctuation consistently', () => {
    const index = buildConversationSearchIndex([
      conv('c1', [msg('m1', 'user', 'Hello, WORLD!')], { title: 'Café ﬁnance' }),
    ]);
    assert.equal(searchConversations(index, 'CAFÉ').length, 1);
    assert.equal(searchConversations(index, 'finance').length, 1);
    assert.equal(searchConversations(index, 'hello world').length, 1);
    assert.deepEqual(searchConversations(index, '!!!'), []);
  });

  it('supports exact matches and prefixes only for query tokens of three code points', () => {
    const index = buildConversationSearchIndex([
      conv('c1', [msg('m1', 'user', 'running late again')]),
      conv('c2', [msg('m1', 'user', 'ru is a syllable')]),
    ]);
    assert.deepEqual(
      searchConversations(index, 'run').map((h) => h.conversationId),
      ['c1'],
    );
    assert.deepEqual(
      searchConversations(index, 'ru').map((h) => h.conversationId),
      ['c2'],
    );
  });

  it('requires every distinct query token across title and messages', () => {
    const index = buildConversationSearchIndex([
      conv('c1', [msg('m1', 'user', 'buy basil tomorrow')], {
        title: 'Kitchen plan',
      }),
    ]);
    assert.equal(searchConversations(index, 'kitchen basil').length, 1);
    assert.deepEqual(searchConversations(index, 'kitchen basil missingword'), []);
    // Duplicate query tokens count once.
    assert.equal(searchConversations(index, 'basil basil').length, 1);
  });

  it('ranks title coverage before matching-message count', () => {
    const index = buildConversationSearchIndex([
      conv('body-heavy', [
        msg('m1', 'user', 'garden gate'),
        msg('m2', 'user', 'garden gate again'),
        msg('m3', 'user', 'more garden gate'),
        msg('m4', 'user', 'garden gate once more'),
      ]),
      conv('title-hit', [msg('m1', 'user', 'unrelated words here')], {
        title: 'Garden gate project',
      }),
    ]);
    const hits = searchConversations(index, 'garden gate');
    assert.deepEqual(
      hits.map((h) => h.conversationId),
      ['title-hit', 'body-heavy'],
    );
  });

  it('counts each matching message once regardless of repeated occurrences', () => {
    const index = buildConversationSearchIndex([
      conv('c1', [
        msg('m1', 'user', 'deploy deploy deploy deploy'),
        msg('m2', 'assistant', 'deploy confirmed'),
        msg('m3', 'assistant', 'nothing relevant'),
      ]),
    ]);
    const hits = searchConversations(index, 'deploy');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].matchedMessages, 2);
  });

  it('breaks ranking ties by recency then ordinal conversation ID', () => {
    const index = buildConversationSearchIndex([
      conv('b-id', [msg('m1', 'user', 'needle')], { updatedAt: 100 }),
      conv('a-id', [msg('m1', 'user', 'needle')], { updatedAt: 100 }),
      conv('newer', [msg('m1', 'user', 'needle')], { updatedAt: 200 }),
      conv('undated', [msg('m1', 'user', 'needle')]),
    ]);
    assert.deepEqual(
      searchConversations(index, 'needle').map((h) => h.conversationId),
      ['newer', 'a-id', 'b-id', 'undated'],
    );
  });

  it('builds bounded source-preserving snippets from the earliest matching message', () => {
    const filler = Array(30).fill('filler').join(' ');
    const index = buildConversationSearchIndex([
      conv('c1', [
        msg('m1', 'user', `${filler}   \n  NeedleWord   ${filler}`),
        msg('m2', 'user', 'NeedleWord appears again later'),
      ]),
    ]);
    const hits = searchConversations(index, 'needleword');
    assert.equal(hits.length, 1);
    const snippet = hits[0].snippet;
    assert.ok([...snippet].length <= 120, `snippet too long: ${[...snippet].length}`);
    assert.ok(snippet.includes('NeedleWord'), 'original case preserved');
    assert.ok(snippet.startsWith('…') && snippet.endsWith('…'));
    assert.ok(!snippet.includes('  '), 'whitespace collapsed');
    assert.ok(!snippet.includes('again later'), 'earliest matching message wins');
  });

  it('handles title-only hits, empty queries, and result limits', () => {
    const index = buildConversationSearchIndex([
      conv('c1', [msg('m1', 'user', 'nothing here')], { title: 'Visa renewal' }),
    ]);
    const titleHits = searchConversations(index, 'visa');
    assert.equal(titleHits.length, 1);
    assert.equal(titleHits[0].matchedMessages, 0);
    assert.ok(titleHits[0].snippet.includes('Visa'));
    assert.deepEqual(searchConversations(index, ''), []);
    assert.deepEqual(searchConversations(index, '   '), []);

    const many = buildConversationSearchIndex(
      Array.from({ length: 60 }, (_, i) =>
        conv(`c${String(i).padStart(2, '0')}`, [msg('m1', 'user', 'needle')]),
      ),
    );
    assert.equal(searchConversations(many, 'needle').length, 20);
    assert.equal(searchConversations(many, 'needle', { maxResults: 999 }).length, 50);
    assert.equal(searchConversations(many, 'needle', { maxResults: 2 }).length, 2);
    assert.deepEqual(searchConversations(many, 'needle', { maxResults: 0 }), []);
  });

  it('snapshots inputs without mutation and rejects duplicate IDs', () => {
    const messages: NativeTranscriptMessage[] = [
      msg('m1', 'user', 'original words'),
    ];
    const input: ConversationSearchInput[] = [
      { id: 'c1', title: 'Original', messages },
    ];
    const before = JSON.stringify(input);
    const index = buildConversationSearchIndex(input);
    assert.equal(JSON.stringify(input), before, 'build must not mutate input');
    // Mutating the input after the build must not change the index.
    messages.push(msg('m2', 'user', 'lateraddedword'));
    input[0]!.title = 'Changed';
    assert.deepEqual(searchConversations(index, 'lateraddedword'), []);
    assert.deepEqual(searchConversations(index, 'changed'), []);
    assert.equal(searchConversations(index, 'original').length, 1);
    assert.throws(
      () =>
        buildConversationSearchIndex([
          conv('dup', [msg('m1', 'user', 'x')]),
          conv('dup', [msg('m1', 'user', 'y')]),
        ]),
      /duplicate conversation id/,
    );
  });
});
