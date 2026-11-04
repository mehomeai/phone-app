# Third-party notices

This app's own code is licensed under the Apache License 2.0 (see
`LICENSE`). The following upstream component is reused under its own
license. Nothing here changes the app license.

## OpenBot (MIT)

- Source: CopilotKit/OpenBot, exact pin
  `6bfee780c8e8d05141375ea55ebde33eefb3dbc0`
- Provenance: DTOs and call-site logic are *adapted* (not verbatim) from
  the pinned tree — `mobile/src/api.ts` (bot/channel/transcript/task
  shapes), `server/src/delivery/routes.ts` + `server/src/channels/routes.ts`
  + `server/src/tasks/routes.ts` (native REST contracts), and
  `mobile/app/conversation.tsx` + `mobile/app/approvals.tsx` (send/history/
  decision/respond call shapes). Names were adjusted to the phone codebase
  (e.g. upstream `Conversation` is `NativeChannel` here), strict validation
  added, and auth adapted from the upstream Cookie session to the paired
  home bearer — behavior reuse, not a copy.
- License text (exact, upstream `LICENSE` at the pin):

```
MIT License

Copyright (c) 2026 CopilotKit

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
