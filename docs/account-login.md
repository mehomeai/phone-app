# Native account sign-in (account-auth-v1, F7)

Real OIDC provider login for the phone app, against the B4 contract
(`../backend-server/docs/account-auth-v1.md`, the source of truth for
metadata shape, verification rules, and errors). The backend publishes
public login metadata and verifies provider JWT access-tokens; the phone
performs PKCE directly against the trusted IdP with the maintained Expo SDK.
No passwords, no provider secrets, no client secrets, no hand-rolled crypto,
no token proxy through the backend.

## How it works

1. `GET <backend>/v1/auth/config` (public, no auth):
   - `devOnly` → local-dev identity. Enter the dev account token (loopback
     `__DEV__` builds only). No browser, no OAuth.
   - `503 configure_not_ready` → hosted but the operator has not configured
     public metadata. The app shows "sign-in is not ready yet" and offers no
     fake provider button. Token verification itself still works.
   - `200 hosted` → continue with `issuer`/`clientId`/`scopes`/`redirectUris`.
2. Login: ONE single-attempt operation over the SAME `AuthSession.AuthRequest`
   (`apps/mobile/lib/account-auth.ts` `beginAuthorizationAttempt` +
   `perform()`): the browser prompt and the code exchange share the
   SDK-owned PKCE verifier. `audience=<config.audience>` (plus any
   `config.extraAudiences` hint) is requested so the IdP returns a JWT
   **access-token** with `aud` = this API. Requesting only an ID token fails
   verification by design. Splitting prompt and exchange into separate calls
   drops the verifier and every real PKCE IdP rejects the exchange — the
   adapter structurally prevents this (missing verifier fails closed, the
   attempt is consumed once, the verifier is never persisted or logged).
3. Callback: `code` + `code_verifier` are exchanged **directly with the IdP
   token endpoint** (public client, no secret, no backend proxy). The form
   body/headers are built with the maintained SDK request classes, but the
   POST runs over the adapter's guarded transport (`redirect: 'error'` +
   same-origin final-URL refusal, single attempt, no cross-origin retry),
   because the SDK's internal fetcher follows redirects. The same guarded
   transport fetches discovery metadata (well-known refuses redirects, the
   metadata `issuer` must equal the configured issuer exactly) and carries
   refresh/revocation. The code verifier lives in SDK memory only.
4. Verify: `GET <backend>/v1/account` with
   `Authorization: Bearer <IdP access_token>`. `200` persists the auth
   bundle in SecureStore and mirrors the access token for the existing
   backend coordinator; `401` discards the token and never signs in.
5. Refresh: the maintained SDK refresh flow, then **re-verification** via
   `GET /v1/account` before committing. A refresh that verifies as a
   different account/issuer fails closed (bundle cleared, home side dropped).

## Storage and lifecycle

- SecureStore holds ONLY the protected auth bundle
  (`accessToken`/`refreshToken`/`expiresAt`/`verified accountId`+`issuer`+
  backend binding, key `me.backend.auth-bundle.v1`). The message cache
  (AsyncStorage) never holds tokens; unit tests assert this.
- Generation-guarded commits: the generation captured before the browser
  opens must still be current when the callback lands. A logout or backend
  URL change in between refuses the late callback — nothing resurrects.
- Only safe API reads are retried after renewal. Non-idempotent POSTs are
  never blanket-replayed after an unknown outcome.
- Cloud expiry or offline NEVER stops the already-paired home agent. Only
  an explicit logout or a verified account/issuer/backend change forgets
  the old home credential plus private chat/tasks/file preview (F4/F5
  fences, so a Bob cloud account can never inherit Alice's home cache).
  Server history is never deleted by sign-out.
- Explicit logout cleans up locally even offline. Optional SDK revocation
  is best-effort: its failure is reported honestly and never blocks logout.

## App surface

- `DevicePanel` → **Me account**: Sign in / Sign out, verified identity
  (account prefix + issuer), and honest states for loading, error,
  cancelled, and not-ready. Copy is written for the phone app; the web
  preview has no sign-in button because it cannot persist credentials.
- Local-dev token field stays for loopback `__DEV__` backends reporting
  `devOnly`. Hosted backends refuse manual tokens and require provider
  sign-in.
- Callback route `app/auth/callback.tsx` exists so the app-owned scheme
  (`me-mobile://auth/callback`, registered in `app.json` as the public
  scheme `me-mobile`) lands inside Expo Router. It persists nothing and
  never reads tokens from the URL.
- The Me demo profile and local home-user labels are untouched. The cloud
  account is displayed separately and never impersonates a prototype
  profile.

## Provider registration (operator)

Register the **exact** callback with your IdP (examples differ per
provider console; the value must match byte-for-byte):

- Allowed callback URL: `me-mobile://auth/callback`
- Application type: native / mobile public client (PKCE, **no client
  secret**)
- Scopes: `openid profile email` (or the backend's configured scopes)
- Audience: the backend's `ME_BACKEND_OIDC_AUDIENCE` (the API identifier),
  requested as the `audience` parameter so the access token carries it
- Client ID: the backend's `ME_BACKEND_OIDC_CLIENT_ID` (public mobile
  client; must differ from the audience)

Backend variables (see the B4 doc for the full table):
`ME_BACKEND_OIDC_ISSUER`, `ME_BACKEND_OIDC_AUDIENCE`,
`ME_BACKEND_OIDC_JWKS` (or `_FILE` / `_URL`),
`ME_BACKEND_OIDC_CLIENT_ID`, `ME_BACKEND_OIDC_REDIRECT_URIS`
(must include `me-mobile://auth/callback`),
`ME_BACKEND_AUTH_APP_SCHEME=me-mobile`, plus optional
`ME_BACKEND_OIDC_EXTRA_AUDIENCES` / `ME_BACKEND_OIDC_EXPECT_TOKEN_USE`.

## Verification status

- `npm test` — 52 pass (30 pre-existing + 10 portable account-auth
  contract checks: PKCE/code shape, bad metadata/redirect/cancel/401
  denial, refresh rotation + mismatch fail-closed, concurrent logout/late
  callback, account-change home fencing, no cache leaks, plus the B4
  local-JWKS flow against the real sibling backend when present, + 12
  native-adapter checks in `tests/account-auth-native.test.ts` running the
  REAL bridge with an injected SDK surface: same-request verifier reaching
  the exchange exactly once, missing-verifier fail-closed, cancel without
  exchange, ID-token-only refusal, late-callback fencing, malicious
  discovery redirect / issuer mismatch / token-endpoint redirect refusal,
  cross-origin trusted endpoints, guarded refresh, best-effort revoke).
- `npm run test:real` — unchanged real home + backend + client pairing
  lifecycle (no account-OIDC dependency; still must pass).
- Mobile syntax + portable strict TS + hygiene — see TESTING.md.
- **Not claimed**: production readiness. Native browser + real-IdP login
  is a manual on-device check (below), and provider credentials remain
  parked per the B4 doc.

## Manual native test (on a phone or simulator, once per OS release)

1. Configure the backend for hosted OIDC with the redirect allowlist
   containing exactly `me-mobile://auth/callback`, and register the same
   URL at the IdP as a native public-client callback.
2. In the app: Me → Me Home → enter the backend address → **Sign in**.
   The system browser opens at the provider; complete login there.
3. Expected: the app shows `SIGNED IN · acct_…`, discovery lists member
   homes, and the access token never appears in logs or URLs.
4. Cancel once: cancel the browser → the app shows "Sign-in was
   cancelled. Nothing was saved."
5. Sign out: **Sign out** works offline, clears the account bundle, and
   drops the paired home side locally (server history stays). Signing in
   as a different account never shows the previous account's home cache.
6. Redirect hygiene (same rule as the home client): credentialed fetches
   use `redirect: 'error'` + same-origin final-URL guards; on unknown
   Wi-Fi (captive portals redirect), pair/sign in only on trusted
   networks.
