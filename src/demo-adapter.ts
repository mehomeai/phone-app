// Explicit demo adapter: same call shape as the paired client for the
// prototype's demo branch, but permanently marked `acceptedBy: 'demo'`.
// Demo history is local-only and must never be mistaken for home-authoritative
// state (prototype: separate by `assistantMode`; see MeContext.tsx).

import type { CacheStorage } from './secure-storage.ts';
import { createMemoryCacheStorage } from './secure-storage.ts';
import type {
  ConversationId,
  ConversationSnapshot,
  HomeChatMessage,
} from './types.ts';

const SCRIPTED: Record<string, string> = {
  adult: 'Demo reply: I can help with that. Pair a home for live answers.',
  parent: 'Demo reply: noted for the household. Pair a home for live answers.',
  child: 'Demo reply: great question! Pair a home for live answers.',
};

export class DemoHomeAdapter {
  readonly mode = 'demo' as const;
  private readonly cache: CacheStorage;
  private replyIndex = 0;

  constructor(cache?: CacheStorage) {
    this.cache = cache ?? createMemoryCacheStorage();
  }

  demoReply(role: string): string {
    const reply = SCRIPTED[role] ?? SCRIPTED.adult;
    this.replyIndex += 1;
    return reply;
  }

  async sendLocal(
    conversationId: ConversationId,
    ownerUserId: string,
    text: string,
    role = 'adult',
  ): Promise<{ user: HomeChatMessage; assistant: HomeChatMessage }> {
    const now = Date.now();
    const user: HomeChatMessage = {
      id: `demo_user_${now}_${this.replyIndex}`,
      conversationId,
      authorUserId: ownerUserId,
      role: 'user',
      text: text.trim(),
      createdAt: now,
      acceptedBy: 'demo',
      pending: false,
    };
    const assistant: HomeChatMessage = {
      id: `demo_asst_${now}_${this.replyIndex}`,
      conversationId,
      authorUserId: null,
      role: 'assistant',
      text: this.demoReply(role),
      createdAt: now,
      acceptedBy: 'demo',
      pending: false,
    };
    const existing = await this.readCached(conversationId);
    const snapshot: ConversationSnapshot = existing ?? {
      id: conversationId,
      ownerUserId,
      title: text.trim().slice(0, 42) || 'New conversation',
      version: 0,
      cursor: 'demo',
      messages: [],
    };
    snapshot.messages.push(user, assistant);
    await this.cache.setItem(
      `me.home.cache.v1.${conversationId}`,
      JSON.stringify(snapshot),
    );
    return { user, assistant };
  }

  async readCached(
    conversationId: ConversationId,
  ): Promise<ConversationSnapshot | null> {
    const raw = await this.cache.getItem(
      `me.home.cache.v1.${conversationId}`,
    );
    if (!raw) return null;
    try {
      return JSON.parse(raw) as ConversationSnapshot;
    } catch {
      return null;
    }
  }
}
