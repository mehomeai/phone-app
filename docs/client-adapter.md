# Paired-home client adapter (F1/F2/F3/F8)

> F8 endpoint-trust rule: a backend `endpointHint` is untrusted coordination
> metadata and NEVER authorizes moving the device secret/session to a new
> URL. `rebindHomeBaseUrl` rejects any origin change with `PAIRING_REQUIRED`
> before any network or store mutation (same-origin normalization still
> works for stable restarts). Moving endpoints requires a fresh one-time
> invitation from trusted local setup (`home-pairing-v1`, see below). The
> `verifyEndpointIdentity` UUID comparison is correlation only — not a
> cryptographic proof — and never authorizes a credential move.

Portable, dependency-free service/client layer for `phone-app` (`src/` has no
`node:` imports, so the Expo app at `apps/mobile/` consumes it directly via
`lib/home-client.ts`). It drives `MeContext` transport, `DevicePanel`
pairing/coordination, and the `TaskPanel` persisted-task surface.

## Transport protection

Every credential-bearing fetch sets `redirect: 'error'` and verifies the
final response URL stays same-origin before parsing (`assertSameOrigin` /
`assertBackendSameOrigin`); cross-origin outcomes are refused with
`CONTRACT_MISMATCH` and never retried with credentials there. Node/undici
fails closed (real 307 regression in the integration suite: harvester sees
zero requests). React Native stacks may ignore `redirect` — the final-URL
guard still refuses the payload, but headers a non-compliant stack already
forwarded cannot be un-sent; per-OS manual verification is documented in
`apps/mobile/TESTING.md` and required before release pairing on untrusted
networks.

## Identity binding

Home-mode display is bound to the authenticated paired identity, never to
the demo profile (`src/home-identity.ts` pure helpers, unit-tested):
`visibleConversations` filters home conversations by recorded owner and shows
nothing until the identity resolves; `reconcileOnEnrollmentChange` drops all
home-mode conversations/links/tasks/pending state on any user, device,
installation, or endpoint change (demo state untouched, no blanket storage
clear). Endpoint rotation via backend discovery verifies the live
installation id against the registered one before `rebindHomeBaseUrl` —
mismatch refuses instead of silently pairing a different home; a genuinely
reinstalled home requires explicit re-pairing.

## What lives here

| Path | Purpose |
| --- | --- |
| `src/paired-home-client.ts` | `PairedHomeClient`: one-time enrollment, session renewal, home-authoritative sync, UUID `request_key` sends, revocation, reconnect/offline states, H2 task/question/approval/artifact methods, H7 push register/status/disable, origin-locked `rebindHomeBaseUrl` (`PAIRING_REQUIRED` on change) |
| `src/notifications.ts` | Portable F8 guards: bounded `parseNotificationData` (metadata only), `isNotificationForScope` (installation AND device must match), bounded `NotificationDedupe`, `pushTokenSuffix`/`isExpoPushTokenFormat` |
| `src/setup-invitation.ts` | Trusted-local `home-pairing-v1` paste parser (HTTPS except loopback-dev, bounded fields); backend hints are never accepted here |
| `src/home-api-v1.ts` | + frozen `home-notifications-v1` route table (`notificationsRegister/Status/Disable`), `NOTIFICATIONS_CONTRACT_VERSION`, `NOTIFICATION_ERRORS`; `NOTIFICATION_KINDS` |
| `src/backend-client.ts` | `BackendCoordinator`: B1 account/home membership (discovery, join tickets, presence, endpointHint resolution). Coordination only |
| `src/home-api-v1.ts` | Binding to the canonical H1 contract `home-api-v1` (route table, contract version). Read-only mirror; owner is `infra-server` |
| `src/secure-storage.ts` | `SecureStorage` (secrets only) vs `CacheStorage` (history cache). Expo adapters without expo imports |
| `src/demo-adapter.ts` | Explicit demo mode, always `acceptedBy: 'demo'`, no network |
| `src/fake-home-server.ts` | Test double emulating `home-api-v1` (+H2) shapes for unit/fixture tests only. Not a server implementation |
| `src/fixtures.ts` | Two-user/private-conversation + invitation fixtures (synthetic secrets) |
| `tests/client.test.ts` | Unit/fixture tests (`npm test`). No real servers |
| `test/real-services.test.mjs` | Real-services suite (`npm run test:real`). Actual H1+B1 in-process, temp state, no env |
| `scripts/run-live-integration.ts` | Env-driven runner against arbitrary home/backend URLs (`npm run test:live`) |

## Contract status

Aligned to H1 `infra-server/contracts/home-api-v1.md` (+ openapi json),
`contract: home-api-v1`, including the H2 task/message extensions:

- `GET /healthz` (+ contract-field check), `POST /v1/pair` (single-use
  invitation → server-issued device credential), `POST /v1/sessions`
  (device credential → short-lived `ht1_` token), `GET /v1/me`,
  `GET+POST /v1/conversations`, `GET /v1/conversations/:id`,
  `GET+POST /v1/conversations/:id/messages` (`{body, request_key?}`; same key
  + identical body → `200 duplicate:true`; different body → `409
  request_key_conflict`; non-UUID → `400`), `POST
  /v1/conversations/:id/tasks`, `GET /v1/tasks/:id`, `POST
  /v1/tasks/:id/{cancel,inputs,approvals}`, `GET /v1/tasks/:id/artifacts`
  (+ bytes download), `POST /v1/devices/:id/revoke`. Approval decisions are
  canonical `approve`/`reject` (H3); approval IDs are opaque server values
  namespaced per task — always use the IDs from the polled task view.
- The client always generates UUID `request_key` values (reuse only across
  network retries) and keeps a client-side cache guard so a home-accepted
  message is never re-sent while its cache is intact.
- Identity always derives from the session-token lookup; the client never
  sends a user id as identity (`expectedUserId` is verified against the
  pairing reply, never asserted).
- Owner-scoped 404s (conversations, tasks, devices) map to `NOT_FOUND`, and
  task reads map further to `FORBIDDEN` — no existence leak across household
  members. `503 model_not_configured` maps to `MODEL_NOT_CONFIGURED` (honest,
  never queued-but-dead); the model is home-selected and the client has no
  field to override it. Stale answer/approval/cancel transitions surface as
  `WRONG_STATE`.
- B1 `backend-server/docs/backend-api-v1.md` is published; the coordinator
  speaks discovery/join/presence and resolves the home endpoint from
  `endpointHint`. Backend `homeId` correlates with H1 `installation_id`;
  backend ticket secrets and H1 invitation secrets are never conflated.

## Mobile wiring (F2)

- `apps/mobile/lib/home-client.ts` adapts the shared clients to Expo
  SecureStore/AsyncStorage (`allowInsecureLoopback` only under `__DEV__`).
- `MeContext` keeps all demo/profile/feed/onboarding/simulated-call state;
  home mode enrolls via one-time invitation, renews sessions on startup,
  syncs home-authoritative history (server snapshot replaces the cache),
  sends with persisted UUID keys (restart-safe retry, offline queue +
  reconnect flush with the same keys), and exposes backend membership plus
  per-conversation H2 task state (submit/refresh/answer/decide/cancel/
  artifacts/download, explicit refresh — no fabricated progress).
- `DevicePanel` pairs with one-time invitations (secrets cleared after use),
  accepts a pasted `home-pairing-v1` setup code from trusted local setup,
  shows the redacted enrollment, manages backend coordination separately
  (backend URL + account token in SecureStore, member homes, join tickets,
  presence — discovery/read-only, Check never rebases credentials and never
  autofills the pair URL), and hosts the opt-in Task notifications card
  (user-gated, generic copy, suffix-only status, explicit disable).
  `TaskPanel` reuses `Card`/`Button`/`StatusDot` for the H2 surface inside
  `ChatComposer`.
- Push (F8, `apps/mobile/lib/notifications.ts` + `components/NotificationGate.tsx`):
  Expo Notifications SDK 58 (declared only), public projectId from app
  config, opt-in button → OS permission → `getExpoPushTokenAsync({projectId})`
  → `POST /v1/notifications/register` on the CURRENT paired home.
  Metadata-only taps (installation AND device must match) fetch the real
  task + conversation and open the fixed Chat route; foreground and tap use
  separate paths, cold-start last response is handled once, rotation re-gets
  the EXPO token, and logout/unpair/revoke/account-switch best-effort
  disables (bounded) then drops private UI. Web preview subscribes to
  nothing. Approval cards mask ALL browser fill text (R7) while showing the
  target descriptor (name/type/form action) for review.

## Verification

- `npm test` — 86 checks: the 52 pre-existing (client, identity,
  approval-summary, account-auth, account-auth-native) plus F8 portable
  guards (metadata parse/scope/dedupe, fake-provider register/status/
  disable incl. permission-false + disabled-operator + revocation + token
  retirement, clone-UUID rebind refusal with zero network, setup-invitation
  validation, R7 browser-fill masking), the injected native-adapter
  suite (permission denial, missing project/module/device, web refusal,
  rotation re-get, malicious-URL ignore, subscription cleanup), the 7
  F9 portable activation-ticket checks (new mint + exact handoff shape, no
  activate path, owner/installation recovery pre-checks, invalid input,
  malformed/leaked-credential shapes, activation error mapping with single
  attempts, expiry fail-closed), and the 7 review lifecycle checks against
  the real `EphemeralRequestGuard` (single in-flight mint, late-arrival
  refusal on background/discard/unmount/same-identity relogin, expired
  arrival refusal, stale copy-feedback refusal, honest copy mapping,
  unknown-outcome wording).
- `npm run test:real` — 2 pass: the full H1+B1+client lifecycle (now incl.
  the B7 mint → home-operator activate → discovery → paired home
  unaffected flow, recovery rotation invalidating the old homeToken, and
  non-owner pre-check refusal) plus the real-home H7 push lifecycle
  against a fake provider only
  (register/status-redacted/disable, operator-disabled 403).
