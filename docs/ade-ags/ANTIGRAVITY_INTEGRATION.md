# Antigravity in ADE

Verified CLI: `agy 1.2.14` on Windows.

ADE supports the native system OAuth account, model discovery through `agy models`,
and print-mode execution as a Squad Lead or worker in Mission/Fleet.
Select **Antigravity**, not **Gemini CLI**, to use the models from this login.
Gemini CLI is a separate executable and account integration.

## Execution isolation

Each process receives a newly created temporary home containing only its MCP
configuration and permission policy. Its working directory is also private; the
Task workspace/worktree is added using `--add-dir` and identified in the prompt.
The native OS keyring continues to supply the system login. ADE does not read,
copy or store OAuth credentials.

The MCP server has a unique name for each execution. Its `ags mcp --task <id>`
arguments bind every request to the Task; Run authorization remains enforced by
the ADE backend. `disabledTools` hides every ADE tool outside the Task's allowed
list. Only the allowed tools receive native `mcp(server/tool)` permission grants.
The bridge retains the original ADE instance handshake and OS home.
Global and workspace MCP files are never rewritten.

Lead policy denies file writes, commands, unsandboxed commands and browser
actuation. Workers may edit their workspace; shell commands require permission
and remain denied in unattended print mode. Neither role uses
`--dangerously-skip-permissions`. Native subagents are not the ADE task scheduler.
Task profiles are removed when the owned process finishes, including launch
failures. A forced OS termination can leave a temporary profile; it is not reused.

Native NDJSON events supply conversation ID, progress, result and usage.
Only terminal `SUCCESS` with exit code zero succeeds. Missing results,
cancellation, waiting states and process errors fail. Final results, raw events,
handoffs and Run snapshots persist through ADE's existing database/history.
Native conversation resume from the temporary profile is not supported.

## Models and effort

Use the exact IDs returned by `agy models`. IDs such as
`gemini-3.8-flash-high` already pin effort. Only the matching `high` override is
valid; selecting a different effort requires selecting a different native model
variant. Models without an effort suffix do not receive explicit effort options.
For example, `claude-sonnet-4-6` rejects `--effort` in this CLI version.
Prices and context limits remain unknown rather than being fabricated.

## Multiple OAuth accounts — experimental/incomplete

The current CLI's documented login uses the OS keyring and exposes a system
session, not named OAuth profiles or a per-process account selector. A separate
configuration home successfully reads the native permission file and queries
account status without another login: configuration isolation is not credential
isolation. ADE therefore keeps `supports_accounts = false` for Antigravity.

To switch the system account, finish active runs, open the native terminal,
use `/logout`, and log in with the other account. This affects all processes
using the same system account; ADE never performs logout automatically.

For simultaneous accounts, the integration needs either an official per-account
credential selector from the CLI, or separate OS user identities, each with its
own keyring and a worker service authenticated to that identity. Supporting the
latter requires explicit process/service routing, manual login for each identity,
account-scoped model discovery and validation that one worker cannot use another
account's credentials. Merely adding account rows or copying profile directories
does not provide those guarantees.

The official Gemini API-key mode is another authentication option, but it is a
Gemini API account, with its own models and billing; it does not duplicate the
Antigravity OAuth subscription or its Claude model access.

## Experimental ADE-owned desktop OAuth client (not exposed in the UI)

The backend contains an experimental Google OAuth account manager. Its setup
form was removed from the user interface because registering a Google Cloud
client is not the requested Antigravity multi-account login experience.
Existing vault entries and metadata are preserved. This manager uses a configured
desktop client, authorization code grant with PKCE S256, a random state and a
short-lived loopback listener bound to 127.0.0.1. It never uses 9router at runtime
or its embedded client credentials. Tokens and client settings are stored only in
the Windows credential vault; SQLite v23 stores account ID, Google subject,
display name, email and creation time. The v22 Handoff migration is retained.

Each subject is deduplicated; connecting another Google identity creates another
account. Verification refreshes that account's grant when needed and checks its
Google subject. A changed client requires reconnection. Cancelling login stops its listener; the setup panel is no longer exposed. No grant is supplied to the native agy CLI.

The following developer registration notes describe that experimental backend;
they are not prerequisites for users of the native Antigravity integration.
They do not make Antigravity multi-account execution available:

1. Create/select a project. Open Google Auth Platform and configure Branding.
2. Configure Audience (External if appropriate); in Testing, add every Google
   account you will connect as a test user.
3. Configure Data Access for `openid`, `email`, `profile` and
   `https://www.googleapis.com/auth/cloud-platform`.
4. In Clients, create an OAuth client with application type **Desktop app**.
   A web client is not interchangeable with this flow. ADE uses a dynamic
   loopback port, supported for desktop clients.
5. The backend has configuration and connection commands, but the setup form
   is not exposed in ADE. These notes do not describe an available user flow.
6. Backend identity verification checks Google login, not model entitlement.

Google External/Testing refresh tokens may expire after seven days with the
cloud-platform scope. Production consent/verification depends on Google's rules.
Registering a client does not grant access to private Cloud Code/Antigravity APIs
or reproduce the official client's model subscription. Account-scoped inference,
model discovery and Mission routing are still pending Google authorization and
a dedicated ADE executor. Saved OAuth accounts are deliberately not advertised
as selectable execution profiles. Native agy continues to use its system login.

## Validation

The account-scoped discovery command verifies Google identity for the exact stored
account, refreshes that account's grant, then queries `loadCodeAssist` and
`fetchAvailableModels`. Requests use a fixed Google HTTPS destination, no redirects,
a 30-second timeout and a 1 MiB response limit. No automatic onboarding, fallback
account, fabricated model list or impersonated IDE fingerprint is used.
The result explicitly reports `inferenceVerified: false`. HTTP 401/403/429 are
reported without exposing upstream bodies or grants. Fixture tests cover project
formats, malformed responses, deterministic model ordering and separate catalogues.

This discovery command has not been validated against a real authenticated
Antigravity account. It is not wired into the Squad roster or advertised as a
working multi-account executor. An authorized provider OAuth client and a real
account consent are still required before login/access and inference can be proven.

Unit tests cover profile isolation, Task identity, tool filtering, Lead policy,
workspace preservation, launch flags, effort constraints, result parsing,
cancellation and missing/nonzero process results. The ignored native metadata
test loads the generated MCP server and Lead permissions without submitting a
prompt:

```powershell
cargo test --lib native_cli_loads_task_mcp_and_lead_permissions_without_inference -- --ignored
```

The existing local Mission `teste` records a completed native Antigravity Lead
and four Codex workers, with four structured handoffs. This is evidence for that
native system-account execution, not experimental multi-account inference.
The documentation stabilization smoke uses existing history without new inference;
metadata and fixture tests alone do not replace execution validation.

Official references:

- https://antigravity.google/docs/cli/install/
- https://antigravity.google/docs/cli/headless/
- https://antigravity.google/docs/mcp/
- https://antigravity.google/docs/permissions/
