export type Role = 'parent' | 'child' | 'adult';
export interface Profile { id: string; name: string; role: Role }
export interface Message { id: string; role: 'user' | 'assistant'; text: string; createdAt: number }
export interface Conversation { id: string; profileId: string; title: string; messages: Message[]; assistantMode?: 'demo' | 'home' }
export type ModelId = 'me-small' | 'me-balanced' | 'me-deep';
export interface Settings {
  assistantMode: 'demo' | 'home';
  homeUrl: string;
  model: ModelId;
  learningMix: number; // 0 = wander widely, 100 = stay on my topics
  topics: string[];
  approvalRequired: boolean;
}
export interface FeedItem {
  id: string;
  topic: string;
  title: string;
  question: string;
  body: string;
  video: string;
  sourceName: string;
  sourceUrl: string;
  transcript: string;
}
