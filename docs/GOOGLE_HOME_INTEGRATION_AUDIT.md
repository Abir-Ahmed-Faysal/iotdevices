# Google Home Cloud-to-Cloud Integration Audit

**Result:** **Partially Implemented; not verified functional.** Repository source was inspected. Google Home Developer Console, production endpoints, and real Google account linking were not accessible. An approved OAuth-only follow-up is documented below; it does not complete Google Home setup or Report State.

## Status summary

| Requirement | Status | Repository evidence / gap |
|---|---|---|
| Developer Console project, cloud-to-cloud integration, project ID | Needs Verification | No console export, project config, or deployment evidence in repository. |
| Fulfillment endpoint | Partially Implemented | `POST /api/smarthome/fulfillment` accepts intent-shaped JSON. Deployment URL and Google request reachability are unverified. |
| OAuth authorization endpoint | Partially Implemented / Broken flow | `/api/auth/oauth/authorize` checks response type and client ID, creates signed code, and redirects. Does not allowlist redirect URI; login continuation is not resumed by dashboard. |
| OAuth token endpoint | Partially Implemented; unsafe current worktree | Supports authorization-code and refresh grants. Current uncommitted changes allow absent client credentials and no longer bind code to submitted client/redirect. |
| Access/refresh token | Partially Implemented | HMAC-signed stateless tokens; one-year lifetime; no rotation/revocation store. |
| SYNC | Partially Implemented | Returns one Switch with OnOff trait and configured device ID. No ownership/home inventory or per-linked-user device set. |
| QUERY | Partially Implemented | Reads current MQTT status; broad failure returns offline and `on:false`. Does not persist observation. |
| EXECUTE | Partially Implemented | Supports OnOff only; target device IDs are not validated against configured device; unsupported operations can return an empty command result list. |
| DISCONNECT | Broken / Incomplete | Returns empty object; does not invalidate OAuth grant or unlink a Google user. |
| Device traits | Partially Implemented | One `SWITCH` and `OnOff`; no other trait/device type implemented. |
| Report State / HomeGraph | Missing | No HomeGraph API client, state report call, service account configuration, or report-on-change path. |
| Offline errors | Partially Implemented | EXECUTE catches failure as `deviceOffline`; QUERY's catch returns 200 with `online:false,on:false`, which presents unknown state as OFF. |
| Multiple Google users/households | Missing | One configured admin username/device ID; no Google link or authorization mapping in schema. |
| Console OAuth/test configuration | Needs Verification | Client IDs/redirect URLs, test users, HomeGraph API, service account, test/approval status not in source. |

## OAuth flow

### Authorization endpoint

`GET /api/auth/oauth/authorize` requires `response_type=code`, a nonempty client ID matching the configured ID, and a redirect URI. If the browser lacks the dashboard session, it redirects to `/` and adds the original authorize route as a `redirect` query parameter. After dashboard login, `frontend/app/dashboard.tsx` does not read or follow that parameter. **A fresh account-linking session therefore does not return to authorization.**

When already authenticated, the handler signs a ten-minute code that includes username, client ID, redirect URI, and expiration, then redirects to the supplied URI with `code` and `state`. The route does not enforce a registered redirect URI allowlist. The code is signed but not stored, so replay prevention/single-use enforcement is absent.

### Token endpoint

`POST /api/auth/oauth/token` parses form-encoded or JSON parameters, reads Basic or body client credentials, handles `authorization_code` and `refresh_token`, and returns signed HMAC tokens. The response advertises a one-year `expires_in`.

The checked-in baseline compared code client ID and redirect URI with the request and expected configured client. **At audit start, this file had uncommitted edits** that remove those comparisons. `redirect_uri` is read but unused. The `authenticateOAuthClient()` implementation in the current dirty `frontend/lib/auth.ts` also returns true when either credential is blank, rather than requiring both. Consequently the current worktree cannot be described as enforcing client authentication or authorization-code binding.

The OAuth helper in `frontend/lib/auth.ts` has no persistent grant/token table, one-time code state, audience/scopes enforcement, refresh rotation, or revocation mechanism. `DISCONNECT` simply returns an empty object, and old signed tokens remain valid until their expiry.

### Fulfillment bearer-token check

`authenticateGoogleRequest()` verifies token signature/expiry, then returns its username. It does **not** require `verified.type === "access"` or validate a client/audience. The endpoint therefore accepts a valid refresh token as a bearer token. Access and refresh grants are both produced by the token helper.

### Required correction principles (recommendations only; no source changed)

1. Require both expected client ID and secret; never permit blank credentials to authenticate.
2. Bind authorization code, client ID, exact registered redirect URI, and grant type at exchange; reject mismatches and consume the code once.
3. Validate redirect URI against configured Google OAuth redirect URLs before redirecting.
4. Validate access-token type/audience at fulfillment; never treat refresh tokens as fulfillment bearer tokens.
5. Use short-lived access tokens and revocable/rotating refresh grants; make DISCONNECT revoke/link removal effective.
6. Preserve `state` exactly through authorization and test CSRF/linking flow; make login return to the stored authorization request.
7. Use stable opaque per-account `agentUserId` values and enforce account-to-home/device membership.

## Intent behavior and contract gaps

### SYNC

Returns `agentUserId: username` and one `action.devices.types.SWITCH` with `action.devices.traits.OnOff`; name is fixed to a Motor/relay. This is an appropriate basic trait for one switch, but it does not reflect user-specific devices and uses the admin username as the Google identity. Google documentation expects account linking and supports multiple Google users linking to the same service account; current data model cannot express that relationship.

### QUERY

Calls `getDeviceStatus()` and returns `{ online, on }` for the one configured ID. On any exception it returns `online:false,on:false`. Offline should not imply a known OFF output; device state is unknown in that situation. It does not call `recordDeviceObservation()`, so Google queries do not update DB observation/runtime.

### EXECUTE

Only recognizes `action.devices.commands.OnOff`. It does not check that the requested device IDs equal the discovered device ID, and it always controls the globally configured device through `setDeviceState()`. The response IDs echo request IDs. Each recognized execution waits on the MQTT command/ack helper; unsupported commands may produce an empty `commands` array instead of an explicit per-command error. Activity persistence is launched asynchronously and may not finish before serverless invocation completion.

### DISCONNECT

Returns `{}` with no grant revocation or account-link removal. Since tokens are stateless and there is no revocation list, a previously issued token remains usable until expiration.

## State reporting and synchronization

The firmware publishes retained state and a heartbeat to MQTT, but there is no code to call Google HomeGraph `reportStateAndNotification`, no HomeGraph API/auth client, and no device-state-to-Google event bridge. Dashboard/Android polling is not a substitute for Google Home Report State.

Google's current [Report State guidance](https://developers.home.google.com/cloud-to-cloud/integration/report-state) states that Report State is required to submit a Cloud-to-cloud integration. It requires enabling HomeGraph API, service-account authentication with the `homegraph` scope, and reporting state keyed by the same `agentUserId` and device IDs returned from SYNC. All are **Missing or Needs Verification** here.

## Console and deployment checklist (not verifiable from source)

Confirm these directly in Google Home Developer Console and Google Cloud Console:

- Cloud-to-cloud integration/project ID and linked GCP project match.
- Fulfillment URL points to the deployed `/api/smarthome/fulfillment` route and is reachable over HTTPS.
- Authorization and token URLs point to the deployed OAuth routes.
- OAuth client ID/secret and allowed redirect URLs match backend secret configuration exactly.
- Test users and test integration state are set as intended.
- HomeGraph API enabled; service account and IAM permissions are least privilege.
- Account linking, device SYNC, query, command, disconnect, unlink/relink, and Report State pass Google's test tool and real Google Home devices.
- Production privacy policy, support, terms, security review, certification/launch requirements, and deployment settings are complete.

Google's [account linking documentation](https://developers.home.google.com/cloud-to-cloud/primer/account-linking) requires OAuth authorization-code flow and describes multiple Google users linking to the same service account.

## Working-tree changes noticed during audit

At audit start, `git status` showed these files modified before the audit:

- `frontend/app/api/auth/oauth/token/route.ts`
- `frontend/lib/auth.ts`

The original edits replaced form-data parsing with URL-encoded parsing (reasonable for a form-encoded token request), but also removed authorization-code client/redirect comparisons and allowed empty OAuth credentials. Those original defects were preserved as evidence in the audit. After the user approved an OAuth-only follow-up, the current changes restored strict validation while retaining URL-encoded form support.

## Approved OAuth Follow-up

The following changes are now present in the working tree; they are source-verified but not production/runtime verified:

- Client ID and secret are mandatory; default development client credentials were removed.
- `GOOGLE_OAUTH_REDIRECT_URIS` is now required and checked as an exact allowlist (HTTPS, with loopback HTTP permitted for local development). Configure it to the exact Google Console redirect URI before account-linking tests.
- Login returns to the original same-origin OAuth authorization request.
- Authorization codes are random, stored by hash, bound to client and redirect URI, expire after ten minutes, and are consumed exactly once within the same transaction that creates the grant.
- Access tokens expire after one hour and are signed; refresh tokens are opaque, stored hashed, and rotated on use.
- Fulfillment accepts only active access-token grants; DISCONNECT revokes the grant. An offline QUERY no longer claims the output is OFF.
- Prisma models and migration `frontend/prisma/migrations/20261112021500_add_oauth_grants/migration.sql` store authorization codes and OAuth grants.
- Five unit tests cover client credentials, redirect allowlisting, token signature/tampering, and rejecting refresh tokens as access tokens.

**Deployment caveats:** Apply the migration before deploying code that uses it. Existing tokens from the old stateless scheme are intentionally rejected; relinking will be required. The database-backed exchange/refresh/revoke flow, configured Google redirect URI, and Google Console linking flow still need integration testing. Report State, dynamic multi-user discovery, and Google account-to-user mapping remain incomplete.

**Local verification completed:** Using an isolated ephemeral Docker PostgreSQL database (not Neon production), local HTTP tests passed for login, authorize redirect/state, code exchange, code replay rejection, redirect mismatch rejection, refresh rotation and old-token rejection, DISCONNECT revocation, and rejection of the revoked access token. Missing/wrong OAuth client credentials, an unregistered redirect, and unauthenticated authorization behavior were also checked. No credentials or token values were printed. These checks do not substitute for Google Console linking or a production deployment test.

## Sources

- Local fulfillment: `frontend/app/api/smarthome/fulfillment/route.ts`
- Authorization: `frontend/app/api/auth/oauth/authorize/route.ts`
- Token exchange: `frontend/app/api/auth/oauth/token/route.ts`
- OAuth/session helpers: `frontend/lib/auth.ts`
- Login UI: `frontend/app/dashboard.tsx`
- MQTT status/control: `frontend/lib/mqtt-device.ts`
- Google [account linking](https://developers.home.google.com/cloud-to-cloud/primer/account-linking)
- Google [Report State](https://developers.home.google.com/cloud-to-cloud/integration/report-state)
