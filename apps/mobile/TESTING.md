# Mobile checks (imported prototype + F2 wiring)

Imported verbatim from the user-provided `me-mobile` prototype, then wired to
the real `home-api-v1` client. Import resolutions are recorded in the root
README (workspace catalog pins, dropped unused references, Replit pipeline
replaced).

## Run without installs (works now)

From `phone-app/`:

```sh
npm test          # portable client unit/fixture tests (40 checks, incl. account-auth)
npm run test:real # real H1 home + B1 backend + phone client, temp state, no env
node --test apps/mobile/tests/check-clip-sources.test.cjs
MOBILE_TYPESCRIPT_PATH=/path/to/typescript.js node scripts/check-mobile-syntax.cjs
```

Verified 2026-11-03 (F9 + review): `npm test` 86 pass / 0 fail
(79 pre-existing incl. the 7 portable F9 activation-ticket checks — new
mint + exact handoff JSON, no phone activate path, owner/installation
recovery pre-checks, invalid input refused without sending, malformed
shapes + leaked-credential (`homeToken`/`me_home_`) refusal, activation
error mapping with single attempts only, expiry fail-closed — + 7 review
lifecycle checks in `tests/activation-lifecycle.test.ts`: single
in-flight mint with generation-scoped release, background/discard/unmount
late-arrival refusal, logout→login-to-same-identity reply discard,
expired-arrival refusal, stale copy-feedback refusal with no clipboard
wipe, honest copy mapping, unknown-outcome wording); `npm run test:real`
2 pass / 0 fail (full pairing lifecycle incl. H2 tasks AND the B7 mint →
home-operator activate → discovery → paired home unaffected flow with
recovery rotation + non-owner pre-check refusal, + real-home H7 push
lifecycle against a fake provider only);
`scripts/check-mobile-syntax.cjs` with the absolute compiler override
`MOBILE_TYPESCRIPT_PATH=…/lib/typescript.js` (TS 6.0.3): 52 files checked,
52 ok, 0 failed, syntax-only (NOT a full typecheck). Portable strict
`tsc --noEmit`-equivalent on `src/*.ts` incl. `ephemeral-guard.ts`
(TS 6.0.3 program, strict): 0 diagnostics.
Root `python3 scripts/check_repository.py`: pass.
`apps/mobile/tests/check-clip-sources.test.cjs`: 3 pass / 0 fail via
`NODE_PATH=…/ts-pkg/lib` (no installs; the `typescript` module resolves
from the verification compiler checkout).
Semantic check (actual `tsc`, B6 types-only mirror, read-only + two
authorized real-package additions): ZERO errors, stable graph, 51
packages (`@react-native/virtualized-lists@0.88.0` +
`expo-clipboard@58.0.4`, both hash-checked public types, fetched with the
existing `fetch-types.py --pkg` helper; manifest `keptBytes` sum
9,677,574; temp-tsconfig path entries for both). The 4 remaining
`noImplicitAny` list-screen diagnostics are fixed and verified clear
against the REAL graph: `FlatList<Conversation>` / `<FeedItem>` /
`<Message>` plus `ListRenderItemInfo<Conversation|FeedItem|Message>`
annotations imported from `react-native` itself (no `any`, no stubs, no
exclusions, no suppression) in `chats.tsx:184`, `feed.tsx:76`,
`ChatComposer.tsx:174`. The earlier ambient `expo-clipboard.d.ts` shim
is REMOVED: `lib/clipboard.ts` imports the official SDK module and is
checked against its real `setStringAsync(text, options?)` declaration
(the narrow `ClipboardLike` assignment errors if the SDK drifts).
Ticket-UI lifecycle (F9 review): a single reusable
`EphemeralRequestGuard` (`src/ephemeral-guard.ts`) fences every async
publish — invalidate on clear/discard/background/account change/unmount,
`isCurrent` after every await, expired arrivals never published, ref
busy guard against double-tap mints, stale copy feedback refused, no
clipboard wipe; null mint results report the tested unknown-outcome
wording (no "nothing was minted" assertion, no autoretries). No
native-bundle claim from transpile.

Account sign-in specifics live in `docs/account-login.md`: contract flow,
provider registration with the exact callback `me-mobile://auth/callback`,
and the manual native/IdP test (no production-ready claim without it).
Declared SDK 58 versions (`expo-auth-session ~58.0.16`,
`expo-web-browser ~58.0.7`, `expo-crypto ~58.0.7`,
`expo-notifications ~58.0.11`, `expo-device ~58.0.1`,
`expo-constants ~58.0.12`) match the Expo SDK 58 docs / npm metadata; the
packages are declared only (no installs on disk).

The clip-sources check needs the `typescript` module (required by
`scripts/check-clip-sources.cjs`); it runs after `npm install` (parked, see
below). The Playwright UI suite is retained and adapted (`tests/ui/`) but
also needs installs plus a Chromium binary.

## Run after `npm install` in `apps/mobile` (parked: disk)

```sh
cd apps/mobile
npm install            # Expo SDK 58 / RN 0.88 / React 19.3 pins (large download)
npm run typecheck      # tsc --noEmit (expo base + allowImportingTsExtensions)
npm run test:clip-sources
npm run test:ui        # expo export + local static server + Playwright 400x720
```

`npm run test:ui` preserves the prototype's checks: clean drafts, first-message
persistence + reload, profile isolation, simulated-call lifecycle. Set
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` if Chromium is not on the default path.

## Manual device check (native, on a phone or simulator)

1. Start the home and backend locally (see root README), create an invitation
   (`bootstrap --user=<you>`) and a join ticket.
2. In the app: Me → Me Home → enter backend address + account token → Connect
   account → Refresh my homes → Join home (home ID + ticket) → Use (fills the
   home endpoint from the backend's endpointHint) — or enter the endpoint
   directly.
3. Pair: endpoint + invitation ID + secret → Pair with one-time invitation.
   The secret field clears; the header shows home/device/user prefixes only.
4. Chat: messages sync from the home; kill and reopen the app — history
   survives via home sync + session renewal. Airplane mode → OFFLINE · WILL
   QUEUE; reconnect → queued messages send with the same request keys.
5. Tasks: open a conversation → HOME TASKS → Run → Refresh. Answer questions,
    then review each approval card (action, summary, reason, target URL /
    selector or action steps, expiry, masked args preview) before
    Approve/Reject — never blind-approve. URLs render as text only and are
    never auto-opened; sensitive values stay masked; args hash / caps stay
    behind Show technical details. Subtask/parent labels and waiting-children
    status appear inline from the home-authoritative list (no invented
    tasks); waiting children poll bounded with the parent. Then Save
    artifacts: bytes are written to the app-private
   scoped cache (`Paths.cache/artifacts-<identity-hash>`, random/safe
   filename, 10 MB refuse-to-save ceiling) and "Saved … bytes" appears ONLY
   after the write verifies. Saved files show bounded text preview (4000
   chars) or safe image/GIF preview; HTML/SVG/JS never render inline. Use
   Open (platform viewer) or Share (native sheet) explicitly. Missing native
   modules surface a clear prerequisite error (run the native build). Web
   falls back to a blob download. Revoke this device → pairing is refused
   until a new invitation is used, and the previous pairing's cached files
   are cleared on unenroll/identity change.

Native on-device pairing/notification checks and credential-provider tests are
parked as user checks (no device harness in this environment). For task
push specifically: on a physical phone (push needs a real device), pair,
tap Notify me on this phone, grant OS permission, background the app, let a
task reach waiting_input/approval (or completion), confirm a generic banner
arrives (no task text), tap it, and confirm the app opens the right chat
with home-fetched history. Deny permission → status stays off with an
honest error. Kill + relaunch cold → tap still routes once. Log out → no
further alerts for the old user. Toggle the home flag
`HOME_NOTIFICATIONS_ENABLED` off → register refuses honestly
(`NOTIFICATIONS_DISABLED`). Endpoint change on the backend member list →
Check reports PAIRING_REQUIRED, old pairing untouched; only a fresh
setup-code/manual re-pair moves endpoints.

Native artifact save/share verification is likewise a user on-device check
(implementation is complete, not a stub): on a simulator or phone, save a
task artifact, confirm the "Saved … bytes" note appears only after the
write, preview bounded text / safe images, Open via the platform viewer,
Share via the native sheet, and confirm unenroll clears the scoped cache.
Portable policy (naming/scoping/limits/preview allowlist) is covered by
`npm test` (`tests/artifact-cache.test.ts`); approval summarization,
masking, and task-relationship parsing are covered by
`tests/approval-summary.test.ts`; native I/O has no Node harness
by design. Switching paired identity or conversation clears local answers,
saved handles, text previews, and notes (verify no previous-user preview
flashes); artifact bytes/downloads are fenced and discarded mid-flight.

## Native redirect semantics (manual device verification)

All credential-bearing fetches in `src/` set `redirect: 'error'` and verify
the final response URL stays same-origin before parsing anything
(`assertSameOrigin` / `assertBackendSameOrigin`), refusing with
`CONTRACT_MISMATCH` instead of re-issuing credentials. Undici (Node, and the
integration suite's real 307 regression) honors `redirect: 'error'` and fails
closed with zero requests reaching the redirect target.

React Native's fetch does not guarantee this: some native stacks ignore the
`redirect` option and follow redirects automatically (forwarding the
Authorization/device headers once before the JS layer can intervene). The
client's final-URL guard still refuses the payload and never retries against
the foreign origin, but it cannot un-send headers a non-compliant stack
already forwarded. Manual verification on a real device, once before release:

1. Run a local redirector + harvester (see `test/real-services.test.mjs`
   section 9e) reachable from the phone (same Wi-Fi, loopback does not work
   from a physical phone — use the machine LAN IP with a dev tunnel).
2. Enter the redirector URL as the home endpoint and attempt pairing.
3. Expected: pairing fails closed (connection error, no enrollment stored)
   and the harvester log shows zero requests. If any request arrives, the
   native stack forwarded credentials and pairing over redirects must stay
   disabled on that platform until the OS behavior is pinned.
4. Repeat for the backend address field with the harvester as redirect
   target: expected `backendError` set, zero harvester hits.

Until this is verified per OS release, treat unknown Wi-Fi (captive portals
issue redirects) as hostile: pair only on trusted networks.
