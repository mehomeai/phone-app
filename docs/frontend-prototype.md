# Existing Me mobile prototype

Inspected 2026-11-02. The user identified this as the frontend currently being
prototyped. Use it as the starting point for `phone-app`, preserving its design
and working interactions instead of replacing it with another product's UI.
This is a living prototype, not a frozen production specification.

## Source and stack

Current local source:
`/Users/kgensupertramp/Downloads/Personal-AI-Showcase-3/artifacts/me-mobile`.

Its package is `@workspace/me-mobile`. The inspected manifest declares Expo
`~58.0.16`, Expo Router `~58.0.24`, React Native `0.88.0`, React `19.3.0`, and
TypeScript `~6.0.3`. Source directories include `app`, `components`, `context`,
`hooks`, `lib`, `constants`, and `assets`.

The documented workspace entry is `pnpm --filter @workspace/me-mobile dev`;
`pnpm dev` inside the package invokes the same script. That script currently
contains Replit-specific environment/proxy/login handling and a `$PORT` binding.
Preserve the existing development path during prototyping; make local and
production configuration explicit when migrating it into this repository.

No source was copied or edited in Downloads. This inspection did not launch the
app or run its UI suite; node_modules are absent in the inspected workspace.

## Existing experience to reuse

| Surface | Current implementation | Production integration |
| --- | --- | --- |
| Feed | Full-screen video feed, topics/learning-mix controls, likes/saves, static sourced content and local ranking | Authorized feed/content service and per-user preferences; connect `feed-algorithm` |
| Chat | Composer, new conversations, history, profile filtering, retries/errors, scripted demo replies and an HTTPS chat adapter | Home-authoritative conversation service, authenticated backend routing, task/event streaming and reconnect |
| Me | Overview, Me Home device panel, Apps and Settings sections | Home registration/status, household access, real connector state, server-enforced policy |
| Household profiles | Parent/adult/child roles, add/edit/switch profile, profile-associated conversations | Authenticated user membership, authorized profile switching and actual guardian rules |
| Onboarding | Profile selection, chat/feed explanation and simulated pairing walkthrough | Real account/home pairing linked to `setup-infra` |
| Browser | URL/search shortcuts launch `expo-web-browser` on user selection | Retain user-directed browsing if desired; add a separate view of the home agent's browser when that capability exists |
| Calls | Simulated start/mute/hang-up/timer and active-call lock | Voice transport/agent integration is separate work; current UI does not connect audio |
| Apps/connectors | Searchable connector catalogue and local toggle previews | Real authorization, account ownership, scopes, connection status and disconnect/revocation |

UI primitives, colors, fonts, haptics, hydration/error states, keyboard handling,
navigation, preview assets and applicable tests are reusable work already done.
Do not discard them to adopt OpenMuse wholesale.

## Existing data and network seams

`context/MeContext.tsx` coordinates profiles, conversations, settings, liked/saved
items, onboarding, typing/errors and connection state. It persists the demo state,
including message history, in AsyncStorage. On native, it stores the configured
home address/token in Expo SecureStore; web pairing is deliberately disabled.
Scripted and home conversations are separated by `assistantMode`.

`lib/me-home.ts` currently validates an HTTPS origin, checks
`GET /api/healthz` for `{ "status": "ok" }`, and calls
`POST /api/assistant/chat` expecting `{ "reply": "..." }`. Requests use a bearer
token, reject redirects and time out after 20 seconds. The context supplies a
conversation ID, profile name/role, and the last 20 messages.

These are observed prototype assumptions, not the agreed final backend contract.
The 2026-11-03 clarification adds a protected tunnel URL and one-time phone
pairing. The hosted backend coordinates accounts/home discovery; paired phones
may access the home endpoint directly. Direct versus backend-relayed data traffic
is to be validated, so the existing home-URL adapter remains useful integration
material rather than an assumption to remove automatically.
The home stores authoritative conversations and user data; phone persistence is
a deliberate cache/offline UX decision rather than the only copy of history.

Preserve a small transport/service interface around the existing context instead
of scattering server calls into screens. Implement an explicit demo adapter and
a production backend/home adapter. Authentication must establish user/profile
identity; names and roles supplied in a chat request cannot authorize access.

The production contract needs durable message/task IDs, acknowledgments,
conversation versions/cursors, task progress, questions/answers, approval records,
artifacts, cancellation, and event replay. A long-running task must survive the
20-second request boundary. Distinguish backend reachability, home connectivity,
and agent execution readiness in state and UI.

Model presets and the approval toggle are currently prototype settings. The
inspected chat adapter does not send the selected model. Actual model availability
must come from the home; consequential actions must consult home policy rather
than trust a local boolean. Apps catalogue toggles are component-local preview
state, not OAuth connections.

## Existing checks to retain

`tests/ui/chat-and-call.spec.ts` covers demo chat drafts/history, local profile
switching, deletion versus delayed replies, and simulated call behavior.
`tests/check-clip-sources.test.cjs` and the clip-source script validate feed
metadata. `TESTING.md` describes the existing checks. These are valuable baseline
tests; UI profile filtering does not by itself prove server-side user isolation.

Migration must account for workspace dependencies/catalog versions, the
`../../lib/api-client-react` TypeScript project reference, asset paths, Expo
configuration, native module requirements, and test/runtime setup. Do not copy a
single package and assume it is independently buildable unchanged.

## Updated integration order

1. Continue the current frontend prototype as the UI baseline. Import its code
   and necessary workspace dependencies into `phone-app` in a focused migration,
   preserving applicable notices and behavior.
2. Stabilize the hosted-backend/home conversation, identity and task contracts
   against the prototype's concrete screens and state requirements.
3. Adapt the transport to the chosen paired-device/tunnel/hosted coordination contract and
   synchronize conversation history from the home while retaining explicit demo
   mode and a defined local cache policy.
4. Add real pairing, progress/tasks, durable questions, approvals and artifacts
   using the established visual components.
5. Verify two authenticated users/multiple conversations, app restart, home
   reconnect, task continuation, and data/access isolation end to end.

Reuse other open-source applications primarily for missing agent/runtime/tool
functionality. Borrow individual UI components only where this prototype lacks a
needed surface and the component fits its existing design and dependencies.
