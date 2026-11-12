# JOY / FishVoice Recommended Upgrade Roadmap

This roadmap is advisory. The original audit made no source changes; the later approved follow-up changed OAuth/backend code only. Hardware configuration, GPIO, MQTT topics, and message formats remain untouched. Keep the existing firmware and MQTT contract stable through the first phases.

**Progress note (2026-11-12):** After user approval, OAuth-specific stabilization was implemented in the working tree (strict client credentials/redirect allowlist, login continuation, single-use code and grant storage, refresh rotation, revocation, and tests). The OAuth migration is not applied and deployment/Google linking are not verified. Other Phase 1 items, especially local ESP32 access/AP security and Android local transport, remain pending approval and work.

## Phase 1: Existing System Stabilization

**Required changes**

- Establish source/deployment baselines and decide how to reconcile the already-modified OAuth files.
- Add regression tests for current API, MQTT payloads, device state, login/session, and database observation behavior.
- Validate the one-device relay boot state and network failover on the actual WT32-ETH01.
- Replace unauthenticated local control with a deliberately designed authenticated local provisioning/control model; do not make an unreviewed GPIO or topic change.
- Resolve the Android cleartext-policy mismatch before claiming local direct mode works.
- Add login throttling/abuse controls and safe operational logs; define secrets rotation.

**Relevant modules:** `arduino/src/main.cpp`, `arduino/include/config.h`, ignored firmware secret headers (values excluded), `frontend/lib/mqtt-device.ts`, `frontend/lib/auth.ts`, `frontend/app/api/device/**`, `frontend/app/api/auth/**`, `android/app/src/main/AndroidManifest.xml`, `android/.../IoTApi.kt`.

**Dependencies:** physical device and load, broker credentials/ACL review, platform environment access, baseline tests.

**Risks:** unintended relay behavior or loss of local recovery if authentication/provisioning design is rushed.

**Testing:** relay boot/polarity bench test; unauthorized local request denied; MQTT connection/ACK/offline tests; Android supported-OS local test; web/Android login and logout regression.

**Expected outcome:** verified and secure baseline for one device without changing current topics or relay assignment.

## Phase 2: Google Home Cloud-to-Cloud Integration

**Required changes**

- Verify/create Google Home Developer Console cloud-to-cloud project and matching GCP project.
- Configure and verify the HTTPS fulfillment URL and test integration account.
- Inventory required SYNC/QUERY/EXECUTE/DISCONNECT and Report State behavior; add contract tests before enabling real users.
- Implement/verify HomeGraph API and service-account access as a planned dependency, but coordinate detailed implementation with Phases 3–5.

**Relevant modules:** `frontend/app/api/smarthome/fulfillment/route.ts`, Google Console/GCP settings (outside repository), new fulfillment tests (to be designed).

**Dependencies:** stable deployed HTTPS URL, OAuth endpoints, Google project/account access.

**Risks:** console project/credential mismatch; test behavior differing from local source; sensitive service-account key exposure.

**Testing:** Google Home test tool; endpoint reachability; SYNC response schema; invalid/expired bearer behavior.

**Expected outcome:** verified Google project and test-integration configuration, with remaining fulfillment gaps tracked explicitly.

## Phase 3: OAuth and Account Linking

**Required changes**

- Make OAuth client ID and secret mandatory, validate registered redirect URIs, and bind authorization code to client and redirect.
- Enforce one-time authorization codes, access-token-only fulfillment, short-lived access credentials, refresh rotation/revocation, and effective DISCONNECT.
- Make login resume the original authorization request safely; preserve and validate state.
- Replace shared admin identity in the integration path with stable opaque `agentUserId` mapped to application users/authorized homes.
- Design account sharing and token storage for multiple Google users without leaking device inventory.

**Relevant modules:** `frontend/app/api/auth/oauth/authorize/route.ts`, `frontend/app/api/auth/oauth/token/route.ts`, `frontend/lib/auth.ts`, `frontend/app/dashboard.tsx`, `frontend/app/api/smarthome/fulfillment/route.ts`; database schema/migrations when the user/home link model is approved.

**Dependencies:** Phase 1 test baseline and Google test client/redirect settings.

**Risks:** breaking existing Google links or dashboard sessions; token invalidation requires user relinking.

**Testing:** missing/wrong client credentials, redirect mismatch, expired/replayed code, refresh rotation, access-vs-refresh, unlink then replay, fresh browser login continuation, multiple Google accounts.

**Expected outcome:** secure and testable authorization-code account-linking flow with enforceable unlink and per-user identity.

## Phase 4: Device Discovery and Voice Command Execution

**Required changes**

- Drive SYNC from an authorized device/output registry; return only devices accessible to the linked principal.
- Validate all requested device IDs and supported OnOff commands; return explicit per-device/per-execution errors for unsupported input.
- Map each output to a stable Google device ID and accurately describe traits/names.
- Preserve `faysal-iot/v1/devices/<id>/{command,state}` topics and current payloads while the registry adopts the existing device.

**Relevant modules:** `frontend/app/api/smarthome/fulfillment/route.ts`, `frontend/lib/mqtt-device.ts`, `frontend/prisma/schema.prisma`, migrations, device registry API/model.

**Dependencies:** Phase 3 identity/ownership and a reviewed device/output inventory model.

**Risks:** ID mismatch can cause Google to control the wrong physical output; multi-device loops can exceed function duration.

**Testing:** one/two-device SYNC; cross-home denial; valid/invalid target IDs; offline execution; duplicate and simultaneous commands; function deadline.

**Expected outcome:** account-scoped discovery and validated OnOff execution with clear offline/error results.

## Phase 5: Device-State Synchronization

**Required changes**

- Implement Google HomeGraph Report State with service-account credentials in managed secret storage.
- Report full trait state after confirmed commands, device state transitions, and device online/offline changes.
- Add bounded retries/outbox and idempotent state reconciliation; expose state age and report failures.
- Separate unknown/offline from known OFF; document runtime estimate quality.

**Relevant modules:** device state ingestion around `frontend/lib/mqtt-device.ts`, `frontend/lib/activity.ts`, fulfillment module, database state/outbox additions, deployment secret configuration.

**Dependencies:** Phase 2 Google HomeGraph setup, Phase 3 stable `agentUserId`, Phase 4 device IDs.

**Risks:** wrong account/device association, stale HomeGraph state, lost event due serverless termination, credential leakage.

**Testing:** command-to-report propagation; unsolicited state change; offline/reconnect; token/API outage/retry; full OnOff trait payload; HomeGraph state check.

**Expected outcome:** reliable proactive Google state synchronization with observable delivery status.

## Phase 6: IoT Scalability Improvements

**Required changes**

- Add normalized users/homes/memberships/devices/outputs and migrate the current one-device setup.
- Introduce per-device unique credentials and broker ACLs; prevent duplicate device IDs.
- Add command ledger, idempotency/deadlines, event retention, indexes, and explicit state freshness.
- Measure request-driven MQTT connection churn; add a single bounded consumer/managed bridge and state cache only if measured limits require it.
- Expand firmware only as a separately tested feature when multiple outputs per ESP32 are approved.

**Relevant modules:** `frontend/prisma/**`, `frontend/lib/mqtt-device.ts`, `frontend/lib/activity.ts`, device/status/command API routes, firmware `config.h`/`main.cpp` only for approved multi-output/identity changes.

**Dependencies:** phases 1–5, agreed capacity targets, migration/rollback plan.

**Risks:** tenant isolation bugs, protocol compatibility regressions, service sprawl, database pool and broker overload during migration.

**Testing:** two devices, multiple outputs, two homes/users, per-device ACL test, concurrency/load, migration rollback, legacy firmware compatibility.

**Expected outcome:** controlled multi-device/home foundation while retaining existing protocol unless separately versioned and approved.

## Phase 7: Security, Reliability, and Performance Testing

**Required changes**

- Threat-model local access, device identity, OAuth, account linking, MQTT ACLs, tenant boundaries, and state reporting.
- Validate safe relay behavior during boot, network loss, broker loss, duplicate commands, and firmware reset.
- Add monitoring/alerts for device freshness, command acknowledgment, MQTT/DB health, OAuth errors, Report State age, and activity growth.
- Set explicit load targets and test Vercel concurrency/function duration, broker caps, and database pool limits.

**Relevant modules:** all API/OAuth/fulfillment modules, firmware, Android, observability and deployment configuration.

**Dependencies:** roadmap phases 1–6, production-like test environment, hardware test plan.

**Risks:** test commands can energize physical loads; security testing must use approved devices and non-production credentials.

**Testing:** security test matrix; fault injection; load/soak; failover; recovery; alarm delivery; backup/restore and migration rollback.

**Expected outcome:** evidence-based readiness against defined reliability/security SLOs.

## Phase 8: Production Deployment

**Required changes**

- Configure production OAuth/Google project, HTTPS endpoints, credentials, HomeGraph, database, broker ACLs, and firmware provisioning.
- Remove all defaults/test credentials from deployable configurations; rotate any values exposed in repository or prior documentation.
- Stage rollout with canary device/account, database backup, migration rollback, firmware rollback, and support runbooks.
- Document ownership, incident response, token revocation, device recovery, and credential rotation.

**Relevant modules:** Vercel/GCP/Google Home Console, Neon/EMQX service configuration, firmware release artifacts, Android release configuration, operational runbooks.

**Dependencies:** phases 1–7 exit criteria and approval from project owner.

**Risks:** account unlinking, stale Google Home state, firmware/device incompatibility, secret exposure, or unsafe physical actuation.

**Testing:** end-to-end production smoke tests with a safe load; staged cohort; rollback drill; alert/incident drill; Google relink and disconnect.

**Expected outcome:** controlled, monitored deployment with recovery path and explicit operational ownership.

## Exit gate

Do not treat “code route exists” as successful Google integration. Production readiness requires verified account linking, authorized discovery/commands, Report State, physical fail-safe behavior, tenant isolation, operational quotas, and rollback evidence. Source changes remain subject to explicit approval after this audit.
