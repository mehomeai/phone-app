# One-time home activation (phone F9, against B7)

Owner-phone mint of the one-time home ↔ Me Backend activation ticket,
against `backend-server/docs/home-activation-v1.md` (B7, the wire source of
truth) and `infra-server/docs/home-h8-handoff.md` (H8/S7 companion). The
phone mints; the home operator redeems by pasting into home setup (stdin).
The phone NEVER calls `POST /v1/homes/activate` — there is no such client
method, and the suites assert it stays that way.

## App surface

- `DevicePanel` → **Home activation ticket** (visible only while signed in
  as the owner account). Cloud account membership and trusted local home
  pairing are labeled as separate systems throughout; the ticket flow never
  autofills the private pairing URL and never rebinds credentials from a
  backend hint (F8 `PAIRING_REQUIRED` behavior unchanged).
- Inputs: installation ID copied from the physical home's setup prepare
  step (required, verbatim), optional display name (new homes only), and a
  New / Recover picker. Recovery lists only the account's owned homes from
  member discovery, each labeled installation-match/mismatch; anything else
  is refused locally before sending (the backend still decides
  authoritatively: `404` hidden non-member, `403` non-owner/mismatch).
- Mint is a single attempt with no autonomous retries. A transport failure
  leaves the outcome unknown; minting again is an explicit user action.
  A null result reports the outcome as unknown (never "nothing was
  minted"); a fresh ticket can be minted and any server-created ticket
  expires on its own.
- Lifecycle fence (review): one reusable `EphemeralRequestGuard` invalidates
  on clear/discard/background/account change (including logout→login to the
  same identity)/unmount, `isCurrent` is checked after every await, expired
  arrivals are never published, a ref busy guard blocks double-tap mints,
  and stale copy feedback is refused without wiping the OS clipboard.
- The one-time handoff JSON
  `{ backend_url, ticketId, activationSecret, installationId, mode, homeId?,
  expiresAt }` is rendered masked by default (deliberate Reveal toggle),
  copies via the maintained Expo Clipboard API with an honest
  copied/failed state, and is ephemeral: in-memory UI state only, never
  persisted, cached, or logged. It is discarded on expiry (~5 min ticket
  TTL), account change/logout, app background, screen unmount, or explicit
  Discard. No QR is offered (the app has no secure QR pairing surface).
- Cloud outage or account refresh never touches the paired home: mint
  failures surface an honest error in place; enrollment/connection/tasks
  state is untouched.

## Portable contract (`src/backend-client.ts`)

- `mintActivationTicket({ installationId, displayName?, existingHomeId? })`:
  validates input (printable-ASCII 1–128 installation; 1–100 display
  name), pre-checks recovery against `discoverHomes()` (owner role + exact
  installation, normalized from B7 `membershipRole`), then one
  `POST /v1/homes/activation-tickets` with the account bearer. Body never
  carries `homeId`/`accountId`/`ownerId` or token material.
- `parseActivationTicket` enforces the exact capability shape (mode must
  match the request, installation must echo, recovery `homeId` must equal
  the requested home, expiry must parse) and refuses any leaked reusable
  credential (`homeToken` field or `me_home_` material → contract
  mismatch). `errorForActivationStatus` maps B7 §6 (`401/403/404/410/429/
  400`, retryable only on 5xx).
- `buildActivationHandoff(backendUrl, ticket)` projects the operator JSON
  (refuses expired tickets); `isActivationTicketExpired` fails closed for
  the UI fence.

## Verification status

- `npm test` — 7 portable checks in `tests/activation-tickets.test.ts`
  (see `apps/mobile/TESTING.md` for the full 79-count breakdown).
- `npm run test:real` — B7 byte-driver inside the lifecycle suite: mint →
  wrong-installation `403` without burning → operator activate `201` →
  replay `410` → homeToken heartbeat `200` → account discovery (owner) →
  paired-home sync unaffected → recovery mint/activate (same `homeId`,
  rotated token, old verifier `401`) → non-owner pre-check refusal.
- `expo-clipboard ~58.0.4` is declared in `apps/mobile/package.json`
  (SDK 58 line) but not installed on disk: copy on a real install uses
  the real module; the portable clipboard adapter (`lib/clipboard.ts`)
  fails closed with an honest message when it is missing.

## Manual native test (on a phone or simulator, once per OS release)

1. Sign in as the home owner account (Me → Me Home → Sign in).
2. Home activation ticket → enter the installation ID from home setup
   prepare → Mint one-time ticket.
3. Expected: one-time JSON appears masked; Reveal shows the secret; Copy
   reports Copied; the bytes paste cleanly into home setup stdin and the
   home activates (`201`, private file written `0600`).
4. Lock/background the app: reopening shows no ticket (discarded, with an
   honest expiry/cleared note). Sign out mid-display: same.
5. Let a ticket lapse (~5 min): the UI discards it and says it expired.
6. Use the backend endpoint-hint Check (Account coordination): confirm the
   paired home is untouched by any ticket step, and that an endpoint
   change still demands a fresh local invitation.
