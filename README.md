# phone-app

Mobile companion application for Me Home AI.

Part of [Me Home AI](https://github.com/mehomeai), a privacy-first home agentic system.
Learn about the vision at [Me — Your intelligence. Yours.](https://mehomeai.replit.app/me/).

## Status

Portable paired-home + backend coordination clients (`src/`): full-scope
home link stamps (user+installation+device+endpoint origin), home identity
binding, sanitize-before-publish hydration, generation fencing, all UI
surfaces routed through identity-scoped `visibleChats`, namespaced approval
IDs with `reject`, redirect-hardened credential fetches, task completion
syncing authoritative history with bounded polling and foreground re-verify,
origin-locked endpoints (backend hints never move credentials;
`PAIRING_REQUIRED` before any mutation), opt-in H7 push
(register/status/disable + metadata-only guards/dedupe), `home-pairing-v1`
setup paste, R7 browser-fill masking with target descriptors, and the F9
one-time home-activation ticket mint (account auth, B7) with ephemeral
generation-fenced operator handoff (review: late arrivals never publish).
Implemented on `main`: the home-agent foundation merged via PR #1,
and the upstream agent infrastructure (native OpenBot conversations)
merged 2026-11-03 via PR #7. No deployed release. Verified
(finals, see `backend-server/docs/final-validation.md`):
`npm test` **86 pass / 0 fail**, `npm run test:real` **2 pass / 0 fail**
(pairing lifecycle incl. the B7 mint → home-operator activate → discovery →
paired home unaffected flow + real-home push lifecycle on a fake provider
only; one overloaded concurrent run showed polling-timeouts that passed on
focused rerun without source changes),
strict portable `tsc --noEmit` on `src/` clean (exit 0). Mobile
`apps/mobile/` (Expo SDK 58, wired to the real `home-api-v1` plus account
coordination, opt-in push, and the F9 ticket UI): all **52** TS/TSX files
transpile clean (syntax-only, separate from semantic), and the official
SDK-mirror `tsc --noEmit` (**51 real packages**, incl. clipboard +
RN virtualized-lists, zero ambient stubs, Expo `skipLibCheck`) reports zero
errors — a semantic type-graph check, not a native bundle. No private chat
relay via cloud; optional remote inference sends scoped prompt/history/tool
context only. Parked (manual, never CI): `apps/mobile` npm install,
`expo export`, native build, real-device pairing/OIDC/clipboard/share/
offline-queue/push-tap, per-OS redirect verification.
Native push/file save-share uses SDK 58 official deps declared in
`apps/mobile/package.json` only (not installed on disk); actual native
checks remain user-parked.

## Scope

Mobile interaction, device pairing, consent, and household controls.

## Layout

- `src/` — portable paired-home + backend coordination clients, error
  taxonomy, demo adapter, fixtures, test doubles. Zero runtime dependencies;
  no `node:` imports, so the mobile app consumes it directly.
- `tests/client.test.ts` — unit/fixture checks (run: `npm test`).
- `test/real-services.test.mjs` — self-contained real-services suite: starts
  the actual sibling H1 home and B1 backend in-process on loopback with temp
  state and synthetic users (run: `npm run test:real`). No skips, no env.
  Covers backend registration keyed by H1 `installation_id`, join tickets,
  discovery/presence, one-time pairing, private conversations, cross-user and
  unpaired denial, wrong-home rejection, restarts with persisted history,
  server-bound `request_key` idempotency, the full H2 task lifecycle
  (question/approval/artifact/cancel/fail, honest 503 without a model),
  device revocation, and membership removal.
- `scripts/run-live-integration.ts` — env-driven runner against arbitrary
  home/backend URLs (tunnel endpoints, deployed homes).
- `apps/mobile/` — the user-provided Expo frontend (imported verbatim, then
  wired). See `apps/mobile/TESTING.md` for commands and manual steps.

## Frontend import (what was copied, what was resolved)

Copied read-only from `Downloads/Personal-AI-Showcase-3/artifacts/me-mobile`:
`app/`, `assets/`, `components/`, `constants/`, `context/`, `hooks/`,
`lib/`, `tests/`, `app.json`, `metro.config.js`, `playwright.config.js`,
`scripts/check-clip-sources.cjs`. Not copied: `.expo/`, `.replit-artifact/`,
`expo-env.d.ts` (generated), `server/` + `scripts/build.js` +
`scripts/serve-test-build.js` (Replit workspace deploy pipeline; replaced by
`expo export` + `scripts/serve-web-dist.cjs`), credentials/`.env`/generated
modules (none present).

- `@tanstack/react-query: catalog:` → pinned `5.105.3` (only used by
  `QueryClientProvider` in `app/_layout.tsx`).
- `zod`, `zod-validation-error`: no imports anywhere → dropped.
- `@workspace/api-client-react: workspace:*`: no imports → dropped, with the
  unused `tsconfig.json` project reference.
- `create-launch` (Replit login): dropped; `dev` is plain `expo start`.
- Expo SDK `~58.0.16`, React Native `0.88.0`, React `19.3.0` targets preserved.
- `playwright.config.js`: only the webServer command changed
  (`pnpm run test:web` → `npm run test:web`); Chromium override via
  `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` retained.

## Wiring (F2)

`context/MeContext.tsx` keeps all demo/profile/feed/onboarding/simulated-call
state and now drives home mode through `PairedHomeClient` (SecureStore
enrollment + session renewal, home-authoritative sync replacing the local
cache, UUID `request_key` sends with persisted keys for restart-safe retry,
offline queue + reconnect flush) and `BackendCoordinator` (account token in
SecureStore, discovery/presence/join, endpointHint → home URL). `DevicePanel`
pairs with one-time invitations (secrets cleared after use) and manages
backend coordination separately from home identity. `TaskPanel` (new, existing
visual primitives) submits/polls/answers/approves/cancels/downloads H2 tasks;
nothing is fabricated — `MODEL_NOT_CONFIGURED` and other honest states are
shown. Browser stays user-directed; calls stay simulated with no audio.

## Existing frontend prototype

The Expo prototype this work started from lives in
`Personal-AI-Showcase-3/artifacts/me-mobile` (read-only reference; never
edited). Its inspected surface and integration map are in
[the inspected frontend and integration map](docs/frontend-prototype.md).
The imported copy under `apps/mobile/` is the working baseline; the client
binding is documented in [the paired-home client adapter](docs/client-adapter.md).

## Contributing

Start with the [contribution guide](https://github.com/mehomeai/.github/blob/main/CONTRIBUTING.md),
[code of conduct](https://github.com/mehomeai/.github/blob/main/CODE_OF_CONDUCT.md), and
[governance](https://github.com/mehomeai/.github/blob/main/GOVERNANCE.md).
Discuss substantial changes in an issue before implementing them. Pull requests
should include relevant tests and documentation once application code exists.

For questions and cross-project planning, use [community discussions](https://github.com/mehomeai/.github/discussions).
Report vulnerabilities privately through this repository's **Security → Report a vulnerability**;
see the [security policy](https://github.com/mehomeai/.github/blob/main/SECURITY.md).

## License

[Apache License 2.0](LICENSE). Third-party code, model weights, and datasets may
have their own terms and must be reviewed before inclusion.
