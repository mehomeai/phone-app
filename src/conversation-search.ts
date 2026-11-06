/**
 * Conversation search: find past conversations by what was said in them.
 *
 * Pure, in-memory, zero-dependency. The index keeps ONLY display text —
 * titles plus the text `transcriptText` would render for user/assistant
 * messages — so tool payloads, reasoning internals, and system content
 * are never searchable, mirroring the codebase's never-render rule for
 * those shapes (see upstream-native.ts). This is a search facility, not
 * a redaction boundary: display text and titles can themselves contain
 * sensitive information. Nothing here logs or persists.
 */

import type { NativeTranscriptMessage } from './upstream-native.ts';
import { isDisplayRole, transcriptText } from './upstream-native.ts';

export interface ConversationSearchInput {
  id: string;
  title?: string;
  updatedAt?: number;
  messages: readonly NativeTranscriptMessage[];
}

export interface ConversationSearchOptions {
  maxResults?: number;
}

export interface ConversationSearchHit {
  conversationId: string;
  title?: string;
  matchedMessages: number;
  snippet: string;
}

const SNIPPET_MAX_CODE_POINTS = 120;
const SNIPPET_CONTEXT_CODE_POINTS = 40;
const DEFAULT_MAX_RESULTS = 20;
const HARD_MAX_RESULTS = 50;
const PREFIX_MIN_CODE_POINTS = 3;

const TOKEN_CHAR = /[\p{L}\p{M}\p{N}]/u;

interface IndexedToken {
  norm: string;
  start: number; // code-point offset into the collapsed text
  end: number;
}

interface IndexedText {
  codePoints: string[];
  tokens: IndexedToken[];
  tokenSet: Set<string>;
}

interface IndexedConversation {
  id: string;
  title?: string;
  updatedSort: number;
  titleText: IndexedText | null;
  messages: IndexedText[];
}

/** Opaque search index; build with buildConversationSearchIndex. */
export interface ConversationSearchIndex {
  readonly conversations: readonly IndexedConversation[];
}

function normalizeToken(raw: string): string {
  return raw.normalize('NFKC').toLowerCase();
}

/**
 * Collapse whitespace, split into code points, and record each token's
 * normalized form plus its span in the collapsed text, so snippets can
 * quote the original spelling/case around a normalized match.
 */
function indexText(raw: string): IndexedText {
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  const codePoints = [...collapsed];
  const tokens: IndexedToken[] = [];
  const tokenSet = new Set<string>();
  let i = 0;
  while (i < codePoints.length) {
    const ch = codePoints[i] as string;
    if (!TOKEN_CHAR.test(ch)) {
      i += 1;
      continue;
    }
    const start = i;
    while (i < codePoints.length && TOKEN_CHAR.test(codePoints[i] as string)) {
      i += 1;
    }
    const norm = normalizeToken(codePoints.slice(start, i).join(''));
    if (norm.length > 0) {
      tokens.push({ norm, start, end: i });
      tokenSet.add(norm);
    }
  }
  return { codePoints, tokens, tokenSet };
}

function tokenizeQuery(query: string): string[] {
  const normalized = query.normalize('NFKC').toLowerCase();
  const codePoints = [...normalized];
  const out: string[] = [];
  const seen = new Set<string>();
  let i = 0;
  while (i < codePoints.length) {
    const ch = codePoints[i] as string;
    if (!TOKEN_CHAR.test(ch)) {
      i += 1;
      continue;
    }
    const start = i;
    while (i < codePoints.length && TOKEN_CHAR.test(codePoints[i] as string)) {
      i += 1;
    }
    const token = codePoints.slice(start, i).join('');
    if (token.length > 0 && !seen.has(token)) {
      seen.add(token);
      out.push(token);
    }
  }
  return out;
}

function tokenSatisfiedBy(tokenSet: Set<string>, queryToken: string): boolean {
  if (tokenSet.has(queryToken)) return true;
  if ([...queryToken].length < PREFIX_MIN_CODE_POINTS) return false;
  for (const candidate of tokenSet) {
    if (candidate.startsWith(queryToken)) return true;
  }
  return false;
}

function firstMatchingToken(
  text: IndexedText,
  queryTokens: readonly string[],
): IndexedToken | null {
  for (const token of text.tokens) {
    for (const queryToken of queryTokens) {
      if (
        token.norm === queryToken ||
        ([...queryToken].length >= PREFIX_MIN_CODE_POINTS &&
          token.norm.startsWith(queryToken))
      ) {
        return token;
      }
    }
  }
  return null;
}

/**
 * Bounded excerpt around a token span: at most 120 code points including
 * ellipses, original spelling/case, whitespace already collapsed.
 */
function snippetAround(text: IndexedText, token: IndexedToken): string {
  const cps = text.codePoints;
  if (cps.length <= SNIPPET_MAX_CODE_POINTS) return cps.join('');
  const contentBudget = SNIPPET_MAX_CODE_POINTS - 2; // both ellipses
  let start = token.start - SNIPPET_CONTEXT_CODE_POINTS;
  if (start < 0) start = 0;
  const maxStart = cps.length - contentBudget;
  if (start > maxStart) start = maxStart;
  const prefix = start > 0 ? '…' : '';
  const suffix = start + contentBudget < cps.length ? '…' : '';
  return prefix + cps.slice(start, start + contentBudget).join('') + suffix;
}

export function buildConversationSearchIndex(
  conversations: readonly ConversationSearchInput[],
): ConversationSearchIndex {
  const seenIds = new Set<string>();
  const indexed: IndexedConversation[] = [];
  for (const conversation of conversations) {
    if (seenIds.has(conversation.id)) {
      throw new Error(`duplicate conversation id: ${conversation.id}`);
    }
    seenIds.add(conversation.id);
    const title =
      typeof conversation.title === 'string' && conversation.title.trim()
        ? conversation.title
        : undefined;
    const messages: IndexedText[] = [];
    for (const message of conversation.messages) {
      if (!isDisplayRole(message.role)) continue;
      const text = transcriptText(message);
      if (text === null) continue;
      messages.push(indexText(text));
    }
    indexed.push({
      id: conversation.id,
      title,
      updatedSort:
        typeof conversation.updatedAt === 'number' &&
        Number.isFinite(conversation.updatedAt)
          ? conversation.updatedAt
          : Number.NEGATIVE_INFINITY,
      titleText: title ? indexText(title) : null,
      messages,
    });
  }
  return { conversations: indexed };
}

function resolveMaxResults(opts?: ConversationSearchOptions): number {
  const raw = opts?.maxResults;
  if (raw === undefined || !Number.isFinite(raw)) return DEFAULT_MAX_RESULTS;
  const floored = Math.floor(raw);
  if (floored < 0) return 0;
  return floored > HARD_MAX_RESULTS ? HARD_MAX_RESULTS : floored;
}

export function searchConversations(
  index: ConversationSearchIndex,
  query: string,
  opts?: ConversationSearchOptions,
): ConversationSearchHit[] {
  const queryTokens = tokenizeQuery(query);
  if (queryTokens.length === 0) return [];
  const limit = resolveMaxResults(opts);
  if (limit === 0) return [];

  interface Scored {
    hit: ConversationSearchHit;
    titleCoverage: number;
    updatedSort: number;
  }
  const scored: Scored[] = [];
  for (const conversation of index.conversations) {
    const satisfied = new Set<string>();
    let titleCoverage = 0;
    if (conversation.titleText) {
      for (const queryToken of queryTokens) {
        if (tokenSatisfiedBy(conversation.titleText.tokenSet, queryToken)) {
          satisfied.add(queryToken);
          titleCoverage += 1;
        }
      }
    }
    let matchedMessages = 0;
    let snippet: string | null = null;
    for (const message of conversation.messages) {
      let messageMatches = false;
      for (const queryToken of queryTokens) {
        if (tokenSatisfiedBy(message.tokenSet, queryToken)) {
          satisfied.add(queryToken);
          messageMatches = true;
        }
      }
      if (messageMatches) {
        matchedMessages += 1;
        if (snippet === null) {
          const token = firstMatchingToken(message, queryTokens);
          if (token) snippet = snippetAround(message, token);
        }
      }
    }
    if (satisfied.size < queryTokens.length) continue;
    if (snippet === null) {
      // Title-only hit: snippet from the title around its first match.
      if (!conversation.titleText) continue;
      const token = firstMatchingToken(conversation.titleText, queryTokens);
      if (!token) continue;
      snippet = snippetAround(conversation.titleText, token);
    }
    const hit: ConversationSearchHit = {
      conversationId: conversation.id,
      matchedMessages,
      snippet,
    };
    if (conversation.title !== undefined) hit.title = conversation.title;
    scored.push({ hit, titleCoverage, updatedSort: conversation.updatedSort });
  }

  scored.sort((a, b) => {
    if (b.titleCoverage !== a.titleCoverage) {
      return b.titleCoverage - a.titleCoverage;
    }
    if (b.hit.matchedMessages !== a.hit.matchedMessages) {
      return b.hit.matchedMessages - a.hit.matchedMessages;
    }
    if (b.updatedSort !== a.updatedSort) return b.updatedSort - a.updatedSort;
    if (a.hit.conversationId < b.hit.conversationId) return -1;
    if (a.hit.conversationId > b.hit.conversationId) return 1;
    return 0;
  });
  return scored.slice(0, limit).map((entry) => entry.hit);
}
