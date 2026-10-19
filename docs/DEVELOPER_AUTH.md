# ICARUS developer sign-in

## Source baseline and existing route

Inspected 19 October 2026. The following baseline describes the pre-change routes; deployment and acceptance evidence appears below.

- ICARUS baseline: `b9499b0392bbc1f67808b0f884775474f9749ae0`.
- HIVEMIND baseline: `2e06d360e63fcc102ffb3310707b4ef254dda6bd`.
- Da-vinci baseline: `21adf7b11c905a580c9c1f55a7775a5a07261198`.
- Existing CLI start: `https://api.singulancelabs.com/auth/cli/start?callback=<loopback>&state=<random>`.
- Existing branded login: `https://next.singulancelabs.com/hivemind/login?cli_return_to=<encoded-start-url>`.
- Existing confirmation: `/hivemind/cli-verified?code=<one-shot>&email=<address>`;
  browser posts to `/auth/cli/exchange`, then navigates to localhost with the customer API key.
  That legacy customer path remains separate; the new ICARUS developer path never uses it.

## Developer flow

1. `icarus connect` or TUI `/connect` binds only `127.0.0.1` on an ephemeral port and creates
   random state plus an S256 PKCE verifier/challenge. Local setup asks first; skipping is the default.
2. Open `https://api.singulancelabs.com/auth/developer/cli/start?callback=http%3A%2F%2F127.0.0.1%3A<port>%2Fcallback&state=<random>&code_challenge=<S256>&code_challenge_method=S256`.
3. A missing browser session redirects to the existing
   `https://next.singulancelabs.com/hivemind/login?account=developer&cli_return_to=<encoded-start-url>`.
   The page displays **ICARUS developer account**, email and Google. It does not show customer
   creation or company/plan onboarding. The issuer origin and exact route select the developer UI;
   `account=developer` alone never grants enrollment authority.
4. Email reuses `/auth/email/start` and `/auth/email/verify`, existing encrypted OTP challenges,
   rate limits, Turnstile and delivery. New verified identities are allowed only for the validated
   developer CLI return. Google reuses `/auth/google` and `/auth/google/callback`, with consumed
   server state and a verified Google email. Developer login skips tenant selection and customer
   activation workflows. Customer invitation admission remains in force for ordinary signup.
5. The backend checks the authenticated person and sends only a **60-second one-shot code** and
   state to `http://127.0.0.1:<port>/callback`. The terminal rejects wrong state and posts code,
   verifier and exact callback to `/auth/developer/cli/exchange` over HTTPS.
6. The exchange returns a distinct encrypted, authenticated `icarus_dev_` credential. Its audience
   is `icarus-developer`, scope is `developer:identity`, and organization is always null. It expires
   after seven days or when its issuing browser session is revoked. The parent session ID is
   encrypted inside the credential, never exposed as a reusable browser session identifier.
7. The CLI writes `config.developer` in `~/.icarus/config.json` (or the existing ICARUS home
   override), chmod `0600`. `config.hivemind` remains the explicit customer API connection.
   The developer credential works only with `GET /auth/developer/me`; it grants no customer API,
   hosted memory, billing, Runtime, Bus or Computer Use permissions.
8. `icarus connect --logout` removes the local developer credential. It does not terminate other
   browser sessions. Local memory never depends on this credential. Existing customer API keys
   can still be supplied explicitly with `icarus connect --token <key> --api-url <core-url>`.

No reusable credential enters a developer browser URL or log. The CLI does not accept arbitrary
remote callbacks or a plaintext remote issuer. Loopback requests with wrong state are ignored;
timeout/cancel removes the listener and signal handlers. Redis auth-state consumption is atomic,
preventing concurrent redemption of a one-shot code.

## Source ownership

- CLI and storage: `crate/mneme-node/cli-lib.js`, `mneme-cli.js`, `tui.js` in this repository.
- Backend: sibling `HIVEMIND-icarus-developer/core/src/auth/developer-cli.js`, wired from
  `core/src/control-plane-server.js`; existing `auth/email-identity-service.js` and user identity
  tables remain authoritative. No new tenant or parallel identity database is created.
- Frontend: sibling `HIVEMIND-icarus-developer/frontend/Da-vinci/src/components/hivemind/app/auth/LoginPage.jsx`
  and `developer-auth-return.mjs`, on its own local frontend branch.
- Native Harness credential services are not the owner of browser identity enrollment. No Harness
  or Runtime implementation or release is included.

## Release and acceptance — 19 October 2026

- CLI **v0.3.90**: source/tag `53d99eda62e59e91b11f36625439ed46a175ee8c`,
  [published release](https://github.com/amar3012005/ICARUS/releases/tag/v0.3.90).
  Release workflow `39265537628` passed all five platform builds, publication, Windows and
  Linux ARM64 cold checks. The release contains binaries, checksums and SBOMs. The public macOS
  ARM64 artifact passed checksum, version and GitHub provenance verification. Staged macOS ARM64
  and Linux x64 artifacts also passed offline save/recall checks. The npm engine was not published.
- Control plane: source `44dbea8bf435a5c85983df5e938b838d53a2a2ac`, canonical scoped release,
  image `hivemind/control-plane:sha-44dbea8b`, image ID
  `sha256:b8d75bbd722823ea9a1ee871c64c462d826ce116335d0622aa60ab0b4b2cb16d`.
  Release manifest: `/root/releases/manifests/44dbea8b/20261019T135333Z/RELEASE_MANIFEST.json`.
  Health returned 200. Only the control-plane service was recreated; Brain/Runtime were not released.
- Frontend: developer UI source `e67d40339225` was promoted and deployed as Worker
  `f3c9ccbd-e633-4119-9696-316d76cadbdb`. Subsequent independent onboarding releases preserve this
  change; the observed active Worker at 14:12:34 UTC was
  `abef1a7a-f419-4750-b1e7-7f1b11ee09c0`. Login returned 200 and missing JS returned 404.
- Rollback references at this release: control-plane image
  `hivemind/control-plane:selected-erasure-09558097`, image ID
  `sha256:e6ac7e0a359f28f385510895fbbf3307249b848bb72764992e909850998840d2`;
  prior frontend Worker `e607c168-54e1-4f21-a1d9-4b0b6d9fcdc7`. Reconcile newer independent releases
  before any rollback.

Real Google provider selection and consent completed the native CLI callback for the requested
existing developer identity. Real email delivery used the ICARUS-specific Cloudflare template;
the user entered the emailed code in Chrome. The browser returned to the original loopback
callback after the terminal's 180-second wait had expired. A fresh native CLI handoff reused the
now email-verified browser session and completed successfully, without another email or code.
The browser visibly confirmed that the developer account was signed in, and the CLI saved its
credential. Both flows returned 200 from `/auth/developer/me`, with `developer:identity` and null
organization. The recovered email credential was stored with mode 0600, no customer credential,
and `hivemind.connected: false`. It returned 401 from both `/auth/session` and hosted Core recall.
A separate session-revocation check returned 401 for the revoked developer credential; a replayed
one-shot authorization code returned 400.

Ordinary customer Google sign-in still reached the normal customer app. Ordinary email UI,
provider routing and unchanged customer template were regression checked; a full ordinary customer
email-code round trip was not performed. A previously unused email alias received the ICARUS
email, but its verification was not completed: new-identity enrollment has automated coverage,
not a completed live acceptance claim. No company setup, purchase or private Bus publication
was performed.

Validation passed: 152 CLI tests, 37 backend/email/provider/session/admission tests, three release
configuration preservation tests, 11 rendered-login/mobile Jest tests and five frontend Node
tests. Shell/JS syntax and Git whitespace checks passed. Two older source-contract tests also
fail on the unmodified backend baseline: `login-org-resolution-contract.test.js` expects the old
`joinedAt` shape, and `oauth-login-redirect-contract.test.js` expects the former MCP login query.
No global agent configuration was changed.

The v0.3.90 CLI waited three minutes for browser completion, shorter than the ten-minute email
code validity. The v0.3.91 patch waits fifteen minutes and reports the deadline and cancellation
option. It explains how to run `icarus connect` again after timeout when the browser is already
verified. A retry always creates fresh state, PKCE and a callback; it never revives an expired
authorization code. Server email/code expiry is unchanged. Automated fake-clock coverage verifies
the default deadline, and a real loopback recovery test rejects the prior state before completing
a fresh PKCE exchange. Local memory continues to work throughout. Bus/Computer Use source
presence is independent of this account flow.


## Timeout patch release — v0.3.91

Published [v0.3.91](https://github.com/amar3012005/ICARUS/releases/tag/v0.3.91) from
`8cef678df854c2404f305ffbe461cbeb8cb3f440`. Workflow `39268732885` passed all five platform
builds, publication, and Windows/Linux ARM64 cold-download checks. All 154 CLI tests passed,
including default-timeout and fresh-state/PKCE recovery coverage. The built macOS ARM64 binary
passed checksum, version and provenance verification and a real browser-to-terminal handoff
using the email-verified session. It visibly reported the fifteen-minute wait, stored a mode-0600
developer credential, and returned identity 200 with null organization and no customer connection.
This patch changes the CLI only; it does not require another backend or frontend deployment.
