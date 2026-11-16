# JOY / FishVoice IoT System Audit

**Audit date:** 2026-11-12  
**Scope:** Repository source, configuration, and documentation in the current worktree. No device, broker, cloud-console, or production-environment access was used.  
**Change boundary:** The initial audit added documentation only. After the user approved a separate OAuth-focused follow-up, OAuth source, schema, migration, and tests were updated. Hardware, MQTT topics/payloads, and local-control code were not changed.

## 1. Executive Summary

The repository contains a working-looking end-to-end design for one WT32-ETH01 relay: the firmware selects Ethernet, Wi-Fi STA, or a setup AP; the ESP32 and Next.js backend communicate with an MQTT-over-TLS broker; the backend serves the Android and web clients; and the database stores activity and polled runtime observations.

There is a Google Smart Home fulfillment route and OAuth-shaped authorization/token routes. This is **not evidence of a working Google Home integration**. The account-linking redirect cannot complete after a fresh login, OAuth checks in the current worktree are materially weaker than the checked-in baseline, fulfillment accepts refresh tokens as bearer credentials, and the required proactive Google Home Report State call is absent. Console, HomeGraph, deployment, and real-device behavior are not verifiable from this repository.

The largest scalability constraint is the system model, not just throughput: one configured `MQTT_DEVICE_ID`, one relay GPIO, one administrative username, one configured home/device in fulfillment, and no user/home/device ownership relationships. Backend status/control opens short-lived MQTT connections per request, while clients poll every 15 seconds. That is suitable for a small installation only if the broker and serverless quotas tolerate it; it does not provide an event-driven fleet state service.

**Recommended decision:** retain the current firmware topics, payloads, and relay behavior for initial stabilization. First secure local control and restore a verifiable OAuth flow; then add Google Home state reporting and integration tests. Introduce a multi-user/home/device model only as an explicit staged migration. Do not rebuild into microservices.

### Top findings

| Priority | Status | Finding |
|---|---|---|
| P0 | Partially Implemented / Broken | Current uncommitted OAuth edits allow absent client credentials and omit authorization-code client/redirect binding. See [Google audit](./GOOGLE_HOME_INTEGRATION_AUDIT.md#oauth-flow). |
| P0 | Missing | Google Home Report State / HomeGraph integration. Google's Cloud-to-cloud documentation says Report State is required for submission. |
| P0 | Broken / Needs Verification | A fresh OAuth authorization redirects to the dashboard with a `redirect` query, but the login UI does not consume it or resume authorization. |
| P0 | Working as coded, unsafe | ESP32 `/on` and `/off` are unauthenticated HTTP GET handlers; local LAN and emergency-AP access is sufficient to control the relay. The AP credential is fixed in source/configuration and is also present in existing project documentation; its value is intentionally not repeated here. |
| P1 | Partially Implemented | Refresh tokens are accepted by the Smart Home fulfillment authentication function; OAuth `DISCONNECT` does not revoke tokens. |
| P1 | Partially Implemented | Firmware and server configuration represent one device and one relay, with no home, user membership, or relay entity model. |
| P1 | Partially Implemented | Serverless status requests create MQTT clients and subscribe to retained state; web/Android clients poll every 15 seconds. This creates connection churn and state freshness limits. |
| P1 | Needs Verification | Android advertises `usesCleartextTraffic="false"` while its direct local transport uses `http://`; local control may be blocked by Android cleartext policy. |
| P2 | Partially Implemented | Activity/runtime data is inferred from successful backend status polling, not a continuous device event stream; gaps are intentionally not counted. |
| P2 | Needs Verification | Broker ACLs, unique per-device credentials, deployed environment variables, Google Developer Console settings, and production behavior were not available for inspection. |

### Source evidence map

| Finding | Source location and responsible function |
|---|---|
| One relay, relay boot OFF, MQTT command/status | [`arduino/src/main.cpp`](../arduino/src/main.cpp#L52): `setRelay`; [`onMqttMessage`](../arduino/src/main.cpp#L124); [`setup`](../arduino/src/main.cpp#L235); constants in [`config.h`](../arduino/include/config.h). |
| No authentication on local HTTP relay routes | [`arduino/src/main.cpp`](../arduino/src/main.cpp#L175): `setupRoutes`. |
| Ethernet/STA/AP selection and MQTT retry | [`arduino/src/main.cpp`](../arduino/src/main.cpp#L195): `onNetworkEvent`; [`loop`](../arduino/src/main.cpp#L282). |
| Per-request broker connections and command ACK | [`frontend/lib/mqtt-device.ts`](../frontend/lib/mqtt-device.ts#L159): `getDeviceStatus`; [`setDeviceState`](../frontend/lib/mqtt-device.ts#L194). |
| OAuth client/code/token validation | [`frontend/lib/auth.ts`](../frontend/lib/auth.ts#L48): `authenticateOAuthClient`; [`verifyOAuthCode`](../frontend/lib/auth.ts#L142); [`verifyOAuthToken`](../frontend/lib/auth.ts#L177); token endpoint [`POST`](../frontend/app/api/auth/oauth/token/route.ts#L29). |
| Authorization redirect and login return path | [`frontend/app/api/auth/oauth/authorize/route.ts`](../frontend/app/api/auth/oauth/authorize/route.ts#L7): `GET`; dashboard session/login handlers in [`dashboard.tsx`](../frontend/app/dashboard.tsx#L241) and [`signIn`](../frontend/app/dashboard.tsx#L271). |
| Google bearer token, intent implementations, and DISCONNECT | [`frontend/app/api/smarthome/fulfillment/route.ts`](../frontend/app/api/smarthome/fulfillment/route.ts#L10): `authenticateGoogleRequest`; `POST` intent branches at lines 35, 63, 92, and 142. |
| Poll-driven persistence and runtime sampling | [`frontend/app/api/device/status/route.ts`](../frontend/app/api/device/status/route.ts#L10): `GET`; [`frontend/lib/activity.ts`](../frontend/lib/activity.ts#L51): `recordDeviceObservation`. |
| Android direct local HTTP and cleartext mismatch | [`IoTApi.kt`](../android/app/src/main/java/com/faysaliot/control/universal/IoTApi.kt#L119): `directLocalStatus`; [`directLocalSetDeviceState`](../android/app/src/main/java/com/faysaliot/control/universal/IoTApi.kt#L140); [`AndroidManifest.xml`](../android/app/src/main/AndroidManifest.xml#L23). |

## 2. Existing System Overview

The checked-in implementation is a single-relay control system:

1. `arduino/src/main.cpp` initializes the relay in the OFF state, starts Ethernet and Wi-Fi STA, and exposes a local HTTP server.
2. The device builds `faysal-iot/v1/devices/<MQTT_DEVICE_ID>/command` and `/state` topics from the root in `arduino/include/config.h`.
3. It subscribes to commands over TLS, applies `on`/`off`, and publishes retained state. It configures a retained Last Will with `online:false`.
4. `frontend/lib/mqtt-device.ts` creates an MQTT client for status or command operations. Commands use a UUID `requestId`, QoS 1, and wait up to 4.5 seconds for a matching state acknowledgment.
5. Next.js API routes enforce the signed dashboard session for regular status/control, and Prisma persists events, last observations, and daily runtime.
6. The Next.js dashboard and Android app poll status/activity/runtime every 15 seconds. Android can also attempt direct local HTTP control.
7. `frontend/app/api/smarthome/fulfillment/route.ts` implements a subset of Google Smart Home intents and sends relay commands through the same MQTT helper.

This flow is supported by source. Claims in [README.md](../README.md) about Vercel, Neon, and the production URL describe intended/deployed architecture but could not be independently verified.

## 3. Technology Stack

| Area | Evidence in repository | Audit status |
|---|---|---|
| Device | ESP32 Arduino framework, PlatformIO `wt32-eth01`, LAN8720 Ethernet, Wi-Fi, `espMqttClient`, ArduinoJson | Partially verified from configuration/source; physical board and wiring need verification. |
| Firmware networking | Ethernet + Wi-Fi STA + emergency SoftAP; HTTP server on port 80 | Implemented in source; physical failover and AP recovery need device tests. |
| MQTT | MQTT.js backend dependency; broker TLS configured by runtime environment; firmware TLS CA and credentials included from ignored headers | Implementation present; broker, ACL, and credential configuration not inspected. |
| Backend | Next.js App Router, TypeScript, Node.js route runtime, bcryptjs, MQTT.js | Verified in `frontend/package.json` and route files. |
| Database | PostgreSQL through Prisma; activity, current observed state, daily runtime models | Verified in `frontend/prisma/schema.prisma`; database connection/migrations not tested. |
| Android | Kotlin, Jetpack Compose, OkHttp, AndroidKeyStore AES-GCM cookie storage | Verified in Android source/build configuration. |
| Web | Next.js client dashboard, browser same-origin requests | Verified in `frontend/app/dashboard.tsx`. |
| Google Home | OAuth route handlers and one Smart Home fulfillment route | Partial code exists; no console/deployment evidence and required state reporting is missing. |

No separate worker, durable queue, WebSocket/SSE service, Google HomeGraph client, or multi-tenant device registry was found in the inspected source.

## 4. Complete System Architecture

```text
Dashboard (browser) ── HTTPS/session cookie ──┐
Android app ────────── HTTPS/session cookie ──┼─> Next.js API (Vercel per README)
Android local mode ── HTTP to ESP32 ─────────┘       │
                                                     ├─ Prisma ─ PostgreSQL (Neon per README)
Google Home ─ OAuth access token ─ fulfillment ─────┤
                                                     └─ short-lived MQTT/TLS client
                                                           │
                                                     EMQX Cloud (per README)
                                                           │
                                  MQTT/TLS ───────── WT32-ETH01 firmware
                                                           │
                                                    one configured relay
```

### Forward command path

**Dashboard:** user action → `POST /api/device/on|off` → same-origin and session checks → `setDeviceState()` → connect to broker → subscribe to the configured state topic → publish command → wait for state payload with matching `requestId` and expected output → return status and record an activity event.

**Google Home (intended):** voice command → Google fulfillment request → verify bearer token → `EXECUTE` handler → `setDeviceState()` → MQTT publish/acknowledgment → return `SUCCESS` or `deviceOffline`. Token type and target-ID checks are incomplete.

**Android local mode:** app → HTTP GET to ESP32 `/on`, `/off`, or `/status`; this bypasses cloud session authorization, MQTT acknowledgment, and backend activity/runtime recording.

### Reverse state path

ESP32 publishes retained state on connection, on command result, and every 20 seconds. Dashboard/API status requests open a broker connection and subscribe to the retained state topic; the status API records the resulting observation in PostgreSQL. There is no MQTT-to-database event consumer or push path from a device state transition to Google Home. Google QUERY is pull-based; the implementation has no Report State call.

### Main failure boundaries

- Device power/reset or relay electrical/wiring failure.
- Ethernet/Wi-Fi reachability, DNS/NTP, broker TLS, credentials, or ACL.
- MQTT connection loss, retained/LWT freshness, or command ACK timeout.
- Vercel execution/concurrency limits and per-request MQTT handshakes.
- PostgreSQL availability/migration state.
- OAuth browser continuation, token validation/revocation, Google account linking, or fulfillment timeout.
- Android background-service and Android cleartext-network policy.

## 5. Hardware and Firmware Analysis

**Working (source-level):**

- `arduino/include/config.h` declares WT32-ETH01 LAN8720 pins/clock, one relay pin, a single output polarity, MQTT topic root, and setup-AP settings.
- `setup()` initializes the relay output and calls `setRelay(false)`, so the software default is OFF after boot.
- MQTT command parsing accepts only `on`/`off`; status includes device ID, relay state, IP/network, uptime, online flag, and optional request ID.
- MQTT state publishes at QoS 1 with retain enabled. MQTT Last Will advertises offline.
- The command handler rejects incomplete/chunked messages and malformed JSON and bounds request ID length.
- Local HTTP routes `/status`, `/on`, `/off` are present.

**Partially implemented / risk:**

- A compiled device ID and one relay pin do not describe multiple outputs, relay metadata, or device provisioning. Cloning the same identity can cause MQTT client-ID collisions and ambiguous topic ownership.
- QoS 1 permits duplicate delivery. `requestId` is returned but not persisted/deduplicated by firmware. `on`/`off` are idempotent GPIO assignments today, but future non-idempotent actions would need deduplication.
- Local control uses unauthenticated HTTP GET. GET is also vulnerable to accidental invocation by link prefetching/crawlers and has no command authorization or replay protection.
- State is not persisted; reset intentionally drives output OFF. This is a safe default only if it matches the connected load and electrical design.
- Firmware includes secret and CA headers ignored by Git; their values and validity were not inspected. No physical relay polarity/load test was performed.

**Needs verification:** actual WT32-ETH01 variant, UART/TTL flashing/debug setup, GPIO wiring and relay module polarity, load-safe behavior, boot transients, firmware build/flash, RF/environmental performance, and the behavior of the deployed firmware.

## 6. Network Architecture and Failover

`loop()` selects Ethernet when `ethConnected`, otherwise connected Wi-Fi STA, otherwise enables SoftAP once the boot-relative fallback timer reaches 15 seconds. Wi-Fi STA retries periodically when no uplink is connected. When Ethernet or STA becomes available, the AP is disabled. Firmware tracks link/IP events and starts NTP before attempting MQTT TLS.

**Partially implemented:** this is interface/link failover, not end-to-end reachability or cloud-health failover. A connected Ethernet/Wi-Fi interface can still lack DNS, Internet, NTP, or broker reachability. MQTT retries are fixed-interval and do not use exponential backoff/jitter. SoftAP uses a fixed configuration; local HTTP remains unauthenticated. The fallback timer is measured from boot, not from the most recent loss of all uplinks, so a later outage may enable AP immediately rather than after a fresh grace period.

The ESP32 local HTTP server is unencrypted on port 80. Android's manifest sets `usesCleartextTraffic="false"` even though `IoTApi` makes `http://` local requests. **Broken / Needs Verification:** test on supported Android OS versions; this manifest policy is likely to block the intended direct-local path.

**Needs verification:** DHCP/router behavior, actual STA/ETH failover timing, reconnect after prolonged outage, AP accessibility, DNS/NTP failure, TLS clock recovery, and whether local AP credentials are unique/rotatable in deployed units.

## 7. MQTT Architecture

| Concern | Current behavior |
|---|---|
| Topic structure | Root `faysal-iot/v1/devices`, then one configured ID, `/command` or `/state`. Do not change during stabilization. |
| Device connection | TLS client ID is the configured device ID; MQTT credentials and CA come from firmware configuration. |
| Backend connection | `mqtt-device.ts` creates a random client ID, clean session, TLS verification, and disables auto-reconnect. |
| Status | Subscribe to retained state; return offline after a two-second wait if no valid state arrives. |
| Command | Subscribe, publish non-retained QoS 1 JSON with UUID, wait 4.5 seconds for a matching state/UUID. |
| Liveness | Firmware heartbeat every 20 seconds; retained Last Will reports offline when broker detects disconnection. |

**Scalability limitation:** every status and command invocation creates/closes its own MQTT connection. Web/Android polling is every 15 seconds, so each active client repeatedly performs TLS/MQTT connection setup. Concurrent users, fulfillment requests, and serverless instances multiply broker connections and handshakes. The status route consumes retained state rather than a centralized live state cache.

**Reliability risks:** a retained online payload can be stale until the broker publishes/processes LWT; backend `lastSeen` is receipt time, not device-originated time. Command QoS/UUID acknowledgment is a useful baseline, but there is no device deduplication, durable command queue, command expiry, or explicit delivery result separate from the latest state. Broker authentication, per-device ACLs, quotas, and availability are not verifiable.

## 8. Backend and Database Analysis

Next.js route handlers provide login/logout/session, device on/off/status/runtime, activity history, health, OAuth authorization/token, and Smart Home fulfillment. `lib/mqtt-device.ts` contains the broker operations; `lib/auth.ts` contains HMAC session/OAuth token helpers; `lib/activity.ts` persists observations and runtime.

The Prisma schema contains `ActivityEvent`, `DeviceActivityState` (keyed by device ID), and `DeviceRuntimeDaily` (device ID + day). It has no user, home, membership, device inventory, relay/output, OAuth-link, or token-revocation model. Activity and runtime rows are device-keyed but not ownership-scoped.

**Concurrency:** `recordDeviceObservation()` serializes updates per `deviceId` using a PostgreSQL advisory transaction lock. This prevents a class of concurrent runtime-update races. Prisma's global singleton is used only for development hot reload; production serverless instances can still create separate database pools. Pool sizing/Neon configuration and load tests were not available.

**State persistence limitation:** only authenticated backend status requests call `recordDeviceObservation()`. Google QUERY/EXECUTE, Android background polling, and direct-local access do not feed a unified observation stream. The runtime endpoint explicitly describes runtime as counted only between successful dashboard checks no more than 30 seconds apart. Missing intervals are not reconstructed.

Activity is cursor-paginated, but no retention/archival policy was found. Health routes prove only that the route executes; they do not prove DB, broker, or device readiness.

## 9. Android and Web Application Integration

The web dashboard stores no credential in browser local storage; it uses same-origin requests and a `httpOnly`, `sameSite=strict` session cookie, with `secure` enabled in production. Login uses bcrypt comparison; logout clears the cookie. CSRF-like origin checks exist on login, logout, and device commands. No visible login throttling, MFA, or user/role model exists in source; any platform edge protection needs verification.

Android uses the same API/session model and encrypts the session cookie with AndroidKeyStore AES-GCM. It exposes local/auto/cloud transport selection, and the Android app has its own English/Bengali speech parser and confirmation flow. That speech assistant is not Google Home Cloud-to-cloud.

Both clients poll status, activity, and runtime every 15 seconds when signed in. This is straightforward for one installation but contributes to MQTT connection churn and backend/database load. The Android foreground service separately polls status every 30 seconds.

## 10. Google Home Integration Audit

**Overall: Partially Implemented, not verified functional.** A complete per-item assessment, OAuth details, and console checklist are in [GOOGLE_HOME_INTEGRATION_AUDIT.md](./GOOGLE_HOME_INTEGRATION_AUDIT.md).

Implemented source includes `/api/auth/oauth/authorize`, `/api/auth/oauth/token`, and `/api/smarthome/fulfillment`, with a single Switch/OnOff device and branches for SYNC, QUERY, EXECUTE, DISCONNECT. Missing or broken: login continuation, strong client/code binding in the current worktree, refresh-token type enforcement at fulfillment, token revocation/disconnect, multi-account mapping, target validation, and Report State/HomeGraph.

Google Home Developer Console project, OAuth URLs/client settings, integration ID, HomeGraph API enablement, service account, test users, and approval/test status are **Needs Verification**. No repository file proves those settings.

## 11. End-to-End Command Flow

### Cloud command

```text
Google Assistant voice
  -> Google Home / HomeGraph
  -> POST /api/smarthome/fulfillment (Google bearer token)
  -> OAuth token verification
  -> EXECUTE OnOff
  -> Next.js setDeviceState()
  -> MQTT TLS command (QoS 1, requestId)
  -> ESP32 command subscription
  -> GPIO relay assignment
  -> retained MQTT state + matching requestId
  -> backend acknowledgment
  -> Google EXECUTE result
```

This path exists in source but account linking and reporting gaps mean successful production use is unverified.

### Reverse state synchronization

```text
Relay state or network heartbeat
  -> ESP32 retained MQTT state (every 20 seconds / after command)
  -> backend status request subscribes and reads retained state
  -> dashboard / Android poll and display
```

There is no observed path from an unsolicited MQTT state change to a Google HomeGraph Report State call. Google will rely on fulfillment QUERY rather than proactively updated HomeGraph state, and Google's current submission guidance requires Report State.

## 12. Scalability Limitations

1. **Identity/topology:** a single configured ID and GPIO; no device registry, output index, homes, ownership, or membership.
2. **User model:** one configured admin username/password; no shared-home or multi-user authorization.
3. **Google linking:** fulfillment uses one device ID and one admin identity; there is no mapping between Google-linked users and device permissions.
4. **Connection pattern:** per-request MQTT clients and 15-second polling create connection/handshake pressure; no shared consumer/cache or bounded queue.
5. **Command concurrency:** concurrent invocations have independent MQTT clients; no centralized ordering, conflict resolution, or durable command tracking.
6. **Observation:** status is pull-driven; database values and runtime metrics depend on dashboard polling.
7. **Data growth:** activity events have no visible retention policy; no partitioning/archival procedure.
8. **Operational limits:** Vercel function duration/concurrency, broker connections, Prisma pool limits, and database plan limits are not configured/verified in repository.

The first scaling goal should be a normalized registry and explicit authorization, not splitting the app into many services.

## 13. Security and Reliability Assessment

| Finding | Status | Evidence / impact |
|---|---|---|
| Unauthenticated local relay HTTP | Working as coded; high risk | `setupRoutes()` controls relay through HTTP GET without authentication or TLS. Any reachable LAN/AP client can control the output. |
| Fixed emergency AP settings | Partially implemented; high risk | AP settings are compiled constants and the existing README repeats the credential. Do not reuse this fixed credential for deployments; never place it in audit output. |
| OAuth client auth bypass in current worktree | Broken security check; critical | The uncommitted `authenticateOAuthClient()` returns true if client ID and/or secret are absent. The token route therefore accepts missing credentials. See exact working-tree state in [OAuth audit](./GOOGLE_HOME_INTEGRATION_AUDIT.md#working-tree-changes). |
| OAuth authorization-code binding | Broken in current worktree; high | Token route verifies the signed code but no longer compares its embedded client ID and redirect URI with the submitted values. Authorization route also accepts any syntactically valid redirect URI rather than an allowlist. |
| Refresh-token acceptance at fulfillment | Partially implemented; high | Fulfillment verifies signature/expiry but does not require token type `access`; refresh tokens are bearer-accepted there. |
| Token lifetime and revocation | Partially implemented; high | Tokens are signed for one year; codes are signed and expire after ten minutes but are not single-use; DISCONNECT does not revoke; no refresh-token rotation/revocation store. |
| One shared administrator identity | Partially implemented; high | Login and Google flow use one configured admin identity; no per-user, home, device, or relay authorization. |
| Device/MQTT identity and ACL | Needs Verification; high | Unique IDs and per-device broker ACLs are required for fleet isolation, but broker settings and device secret issuance were not accessible. |
| HTTP local transport | Working as coded; high | Local route is plain HTTP and unauthenticated; Android uses direct HTTP. |
| Login brute-force controls | Needs Verification; medium | No rate limiting/account lockout is visible in the route code; CDN/WAF settings not inspected. |
| Safe behavior during disconnection | Partially implemented | Firmware leaves current output unchanged during network failover but sets OFF at boot. Hardware reset/relay electrical safety must be validated for the load. |
| Duplicate/reordered commands | Partially implemented | QoS 1 and request IDs help acknowledgment correlation but firmware has no deduplication/expiry or ordering policy. |
| Offline reporting | Partially implemented | Retained LWT and heartbeat exist. QUERY failure returns an offline state with `on:false`, conflating unknown output with OFF; stale retained/last-will timing needs broker testing. |

The exact OAuth security defects listed above are based on the **current worktree**, not a claim about a deployed release. The working tree already had modifications in two OAuth files at audit start; no source files were changed by this audit.

## 14. Identified Bugs and Technical Risks

1. **Fresh-link OAuth flow fails to resume:** authorize redirects unauthenticated users to `/` with a `redirect` parameter; dashboard login code does not consume that parameter or navigate back to authorize.
2. **Token exchange is not bound to the code's client/redirect in current worktree:** current token handler reads `redirect_uri` but does not compare it to the signed code.
3. **Missing token endpoint client credentials pass current helper:** empty values are not rejected in the modified auth helper.
4. **Refresh bearer token accepted by fulfillment:** token type is not checked.
5. **DISCONNECT is not unlink/revocation:** returns `{}` and leaves signed tokens usable until expiration.
6. **No Report State implementation:** no HomeGraph client/configuration or call on state changes.
7. **Misleading offline state:** QUERY exception path returns `online:false,on:false`, although output is unknown when unreachable.
8. **No strict fulfillment target/intent validation:** EXECUTE forwards any target IDs to the one configured device; unsupported executions can yield an empty results array.
9. **Local controls bypass backend auth/logging:** direct local requests have no authentication; local status/command traffic does not enter database observations.
10. **Android local cleartext policy mismatch:** manifest denies cleartext while local API uses HTTP.
11. **Metrics are sampled rather than measured:** runtime is inferred from dashboard polling; offline/restart events can be missed.
12. **No visible throttling/retention/load evidence:** login, activity growth, MQTT connect fan-out, and DB pool behavior require operational validation.

## 15. Recommended Architecture

Keep the current monolithic Next.js application and current MQTT topic/payload contract during initial stabilization.

```text
Web / Android / Google
       -> HTTPS API + OAuth authorization
       -> one authorization/service layer
       -> PostgreSQL registry + latest state + audit events
       -> MQTT TLS (current topics retained initially)
       -> uniquely provisioned ESP32 devices
```

Recommended evolutionary changes:

- Add normalized `User`, `Home`, `HomeMembership`, `Device`, `Relay/Output`, `GoogleAccountLink`, and revocable OAuth grant records. Start with one home/device and migrate the current singleton as seeded data.
- Resolve each Google SYNC device set from the linked principal's authorized homes; use a stable opaque `agentUserId`, not a shared admin username. Enforce ownership on QUERY/EXECUTE/DISCONNECT.
- Enforce OAuth client credentials, redirect URI registration, authorization-code one-time use, code/client/redirect binding, token-type/audience checks, short-lived access tokens, refresh rotation/revocation, and unlink semantics.
- Implement HomeGraph Report State with least-privilege service-account credentials held only in production secret storage. Send full current trait state after confirmed relay changes and device online/offline transitions; retry/report failures observably.
- Secure local provisioning/control: unique setup credentials, explicit authenticated provisioning, and an authenticated local command channel. Keep existing relay GPIO and MQTT payload/topic behavior unchanged until a separately approved protocol migration.
- Reduce request-driven MQTT churn. For a small first deployment, measure broker connection limits and rate; then move state ingestion to a single bounded consumer/managed bridge with a database latest-state cache and command correlation. This can remain a small component, not a microservice fleet.
- Add command records with request ID, idempotency, expiry, status, and timeout outcome before supporting non-idempotent/multi-output operations.
- Add database indexes and retention/archival for high-volume event data; size Prisma pools and serverless concurrency against broker and database limits.
- Expose health/readiness separately for API, DB, broker, and device freshness without exposing secrets.

## 16. Prioritized Improvement Plan

| Order | Work | Why now | Exit criterion |
|---|---|---|---|
| 0 | Protect local physical control and rotate fixed deployment credentials | A reachable local client can control relay | Authenticated local path; unique credentials; safe load test. |
| 1 | Reconcile/review current OAuth working-tree changes; restore strict client/code binding | Current modified code weakens a trust boundary | Tests prove blank/wrong client credentials and mismatched code/redirect are rejected. |
| 2 | Finish OAuth authorize-login continuation, token-type checks, revocation/DISCONNECT | Account linking cannot reliably complete or unlink | End-to-end code-flow tests and revocation tests pass. |
| 3 | Verify Google Console and deploy a test integration; implement Report State | Required for practical Google Home status and submission | Test SYNC/QUERY/EXECUTE/DISCONNECT and HomeGraph state propagation. |
| 4 | Add per-device and per-user/home data model while preserving protocol | Required for multiple devices/users | Two-device/two-user isolation tests; current device remains compatible. |
| 5 | Measure and bound MQTT/DB/polling concurrency | Avoid premature infrastructure and discover actual limits | Load profile meets explicit target without broker/DB/function saturation. |
| 6 | Production release checklist and operational monitoring | Reduce deployment risk | Rollback plan, secret rotation, health metrics, alerting, staged rollout. |

## 17. Implementation Roadmap

The requested eight phases, including dependencies, risks, and validation, are specified in [RECOMMENDED_UPGRADE_ROADMAP.md](./RECOMMENDED_UPGRADE_ROADMAP.md).

## 18. Testing and Validation Strategy

No firmware build, Android build, web build, production request, database migration, or hardware test was run as part of this documentation-only audit. The following validation is required before representing any feature as working:

1. **Unit/contract tests:** OAuth grants, signatures, expiration, code reuse, client/redirect binding, token types, fulfillment schemas, MQTT payload parsing, status freshness, DB observation transitions.
2. **Local API integration:** unauthenticated vs authenticated dashboard calls, origin checks, bad/large payloads, command acknowledgment timeout, broker error, offline response.
3. **Google Home test project:** link fresh account, login continuation, SYNC, QUERY online/offline, EXECUTE, DISCONNECT/relink, multiple linked household users, HomeGraph Report State.
4. **Firmware bench:** relay OFF at boot, expected polarity/load behavior, MQTT duplicate QoS 1 delivery, bad JSON, command acknowledgment, LWT, retained state, restart, Ethernet/Wi-Fi/AP transitions.
5. **Android matrix:** cloud sign-in/control, local LAN and SoftAP transports on supported API levels, cleartext policy, cookie persistence/logout, background restrictions, voice confirmation.
6. **Load/resilience:** concurrent status/control, multiple devices, MQTT connection caps, database pool exhaustion, Vercel duration/concurrency, broker restart, network partition, delayed/stale state, duplicate commands.
7. **Security:** fixed/default credential removal and rotation; MQTT per-device ACL isolation; login throttling; OAuth replay/revocation and redirect tests; local-network access controls; secret scanning and safe logs.

## Audit Limitations and Evidence Rules

- **Verified** means visible in repository source/configuration, not proven on deployed hardware/cloud.
- **Needs Verification** means source does not establish runtime/deployment behavior or required console settings.
- Credentials and secret values were not included in this report. Secret-bearing ignored files were not inspected for their values.
- Google Home documentation consulted: [Account linking](https://developers.home.google.com/cloud-to-cloud/primer/account-linking) and [Report State](https://developers.home.google.com/cloud-to-cloud/integration/report-state). The latter states Report State is required to submit a Cloud-to-cloud integration.
- At audit start, `git status` showed pre-existing edits in `frontend/app/api/auth/oauth/token/route.ts` and `frontend/lib/auth.ts`. A later user-approved OAuth follow-up incorporated and corrected those edits; the original diff was not discarded.

## Follow-up After Audit: Approved OAuth Stabilization

The user approved an OAuth-only follow-up. The current working tree now adds registered redirect URI validation, strict client credential checks, login continuation, atomic one-time authorization-code exchange, short-lived signed access tokens, hashed/rotated refresh tokens, and persistent grant revocation used by fulfillment. OAuth tables and a migration were added. Existing opaque/legacy Google tokens will not validate under the new grant model and require account relinking after the database migration and deployment.

Validation run: 5 Node built-in OAuth unit tests passed; Prisma schema validation passed; Prisma Client generation passed; frontend TypeScript typecheck and production build passed. After applying the migration to the approved production database, a separate ephemeral Docker PostgreSQL instance was also migrated and used for local HTTP flow tests: login, authorization, code exchange, replay rejection, redirect mismatch rejection, refresh rotation/reuse rejection, disconnect, and post-revocation token rejection all passed. No OAuth test grant was created in production. No actual Google account/Developer Console linking, deployed service, or hardware test was performed. Configure `GOOGLE_OAUTH_REDIRECT_URIS` to the exact URI(s) registered in Google before deployment; test values are not production settings.
