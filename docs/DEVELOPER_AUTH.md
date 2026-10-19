# ICARUS developer sign-in

## Source baseline and existing route

Inspected 19 October 2026. These are source-derived canonical URLs, not a production acceptance claim.

- ICARUS baseline: `b9499b0392bbc1f67808b0f884775474f9749ae0`.
- HIVEMIND baseline: `2e06d360e63fcc102ffb3310707b4ef254dda6bd`.
- Da-vinci baseline: `21adf7b11c905a580c9c1f55a7775a5a07261198`.
- Existing CLI start: `https://api.singulancelabs.com/auth/cli/start?callback=<loopback>&state=<random>`.
- Existing branded login: `https://next.singulancelabs.com/hivemind/login?cli_return_to=<encoded-start-url>`.
- Existing confirmation: `/hivemind/cli-verified?code=<one-shot>&email=<address>`;
  browser posts to `/auth/cli/exchange`, then navigates to localhost with the customer API key.
  That legacy customer path remains separate; the new ICARUS developer path never uses it.

## New developer flow (local implementation, unreleased)

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

## Checks and release gates

Passed focused checks: 21 backend/email/session/invitation tests, 17 CLI/argument/installer tests,
5 frontend Node tests, and 11 rendered-login/mobile Jest tests. Backend provider route tests use
mocked Google/email IO; the CLI test uses a real local HTTP exchange fixture. Shell/JS syntax and
Git whitespace checks passed. No global agent configuration was changed.

Two older source-contract tests also fail on the unmodified backend baseline:
`login-org-resolution-contract.test.js` expects the old `joinedAt` shape, and
`oauth-login-redirect-contract.test.js` expects the former MCP login query. They were not changed.

No deployment, package publication or real provider enrollment was performed. Before release:
verify the actual configured frontend/issuer origins, Google callback credentials, email mode and
sender/Turnstile configuration; build the frontend and packaged CLI; perform email and Google
browser-to-terminal acceptance for new/existing developers; confirm normal customer login and
hosted-API denial for a developer credential. Publish matching backend/frontend first and then
CLI/installer artifacts. The source branch deliberately does not fall back to the older customer
browser flow when developer endpoints are absent: sign-in fails clearly and local memory remains
available. Bus/Computer Use source presence is independent of this account flow.
