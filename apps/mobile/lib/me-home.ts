// Stable `@/lib/me-home` import path: re-exports the real mobile binding.
// The prototype's bearer-token helpers (askMeHome/checkMeHome against
// POST /api/assistant/chat) are removed — home-api-v1 owns the contract now.

export * from '@/lib/home-client';
