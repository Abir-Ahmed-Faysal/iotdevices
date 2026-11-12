# FishVoice IoT Architecture Audit

**Phase:** 1 — read-only audit
**Audit date:** 2026-11-13
**Scope:** Repository source, tracked configuration, dependency metadata, and local build/test commands. No application, firmware, environment, database, broker, or Google Console settings were changed. `frontend/.env`, `.env.local`, and ignored device-secret headers were not read.
**Severity:** Critical / High / Medium / Low. “Needs verification” means the repository alone cannot prove the deployed or physical behavior.

## 1. Project map

### Current topology

```text
Browser dashboard ─┐
                   ├─ HTTPS/session cookie ─> Next.js App Router API (Vercel per README)
Android app ───────┘                            ├─ Prisma ─> PostgreSQL (Neon per README)
                                                 └─ short-lived MQTT/TLS client
                                                           │
                                             EMQX Cloud (per README; live instance unverified)
                                                           │ MQTT/TLS
                                            WT32-ETH01 firmware / LAN8720
                                                           ├─ one relay output
                                                           └─ local HTTP + emergency SoftAP

Google Home ─ OAuth account linking + Smart Home fulfillment API ─┘
```

| Area | Entry points and dependencies | Evidence / status |
|---|---|---|
| Firmware | `arduino/src/main.cpp`; PlatformIO project in `arduino/platformio.ini`; ArduinoJson and `espMqttClient`; board `wt32-eth01`. | Ethernet/Wi-Fi/AP, local `WebServer`, and MQTT lifecycle are in `arduino/src/main.cpp:1-7, 23-24, 235-363`. Platform and library versions are in `arduino/platformio.ini:1-9`. |
| Firmware configuration | `arduino/include/config.h`; local-only `secrets.h` and `mqtt_ca.h` are included by firmware. | GPIO, LAN8720, topic-root, and AP configuration are in `arduino/include/config.h:5-21`; includes are in `arduino/src/main.cpp:9-11`. |
| Backend and web UI | Next.js App Router, TypeScript, Node.js runtime, MQTT.js, Prisma, bcryptjs. | Dependencies/scripts: `frontend/package.json:5-32`. UI entry: `frontend/app/page.tsx:1-5`; dashboard: `frontend/app/dashboard.tsx`. APIs include auth, device control/status, activity/runtime, health, OAuth, and fulfillment under `frontend/app/api/`. |
| Persistence | PostgreSQL through Prisma; singleton Prisma client. | Connection variables and models: `frontend/prisma/schema.prisma:5-8, 11-67`; client reuse: `frontend/lib/prisma.ts:1-11`. |
| Android | Native Kotlin/Jetpack Compose, OkHttp, Android Keystore cookie storage, background service and voice parsing. | API client: `android/app/src/main/java/com/faysaliot/control/universal/IoTApi.kt`; Android manifest: `android/app/src/main/AndroidManifest.xml`; app dependencies/API URL: `android/app/build.gradle.kts:6-17, 47-57`. |
| Deployment claims | README describes Vercel, Neon, and EMQX Cloud. | `README.md:3, 10-17, 58-64`. These are documented claims, not independently verified live services. |

There is **no Express server, MongoDB driver/model, or Express route structure** in the tracked project. The current backend is Next.js API routes with PostgreSQL/Prisma.

## 2. Gap analysis against the target architecture

| ID | Severity | Finding and evidence |
|---|---|---|
| A1 | **High** | **Backend/database differ from target.** Existing API and UI are Next.js, and persistence is Prisma/PostgreSQL—not Express/MongoDB. Replacing them is a migration, not a configuration change. `README.md:3, 10-17, 28`; `frontend/package.json:18-32`; `frontend/prisma/schema.prisma:5-8`. |
| A2 | **High** | **MQTT contract differs.** Firmware uses `faysal-iot/v1/devices/{deviceId}/command` and `/state`, with JSON command/status payloads. The target uses `home/{deviceId}/relay{n}/set` and `/state` with plain `ON|OFF`, plus a separate status topic. `arduino/include/config.h:7`; `arduino/src/main.cpp:80-108, 238-241`; `frontend/lib/mqtt-device.ts:232-235`. A topic/payload change needs a coordinated compatibility/migration plan. |
| A3 | **High** | **No N-relay or device registry model.** Firmware defines one `RELAY_PIN` and one `relayIsOn`; backend selects one environment-configured device; Google SYNC returns one device. `arduino/include/config.h:8-9`; `arduino/src/main.cpp:41-55`; `frontend/lib/mqtt-device.ts:59-64`; `frontend/app/api/smarthome/fulfillment/route.ts:45-75`. |
| A4 | **High** | **Backend is not a single state source of truth.** App/Google status reads query MQTT directly; PostgreSQL is updated on authenticated dashboard status polling, not by a persistent MQTT state consumer. Android can bypass the backend and issue local HTTP commands. `frontend/app/api/device/status/route.ts:14-23`; `frontend/app/api/smarthome/fulfillment/route.ts:78-103`; `frontend/lib/activity.ts:51-58, 115-128`; `android/app/src/main/java/com/faysaliot/control/universal/IoTApi.kt:119-152, 162-202`. |
| A5 | **High** | **Per-device broker isolation is not represented or verifiable.** Firmware configuration has one credential set and ID per build; the backend has one MQTT username/password/device ID configuration. No EMQX ACL or provisioning definition is tracked. `arduino/include/secrets.h.example:6-10`; `frontend/lib/mqtt-device.ts:59-80`; `README.md:15`. Actual broker users and ACLs require EMQX inspection. |
| A6 | **Medium** | **Google Home proactive state synchronization is incomplete.** SYNC declares `willReportState: true`, but no HomeGraph Report State or Request Sync implementation exists in tracked source. `frontend/app/api/smarthome/fulfillment/route.ts:50-75`; repository search found only SYNC/QUERY/EXECUTE/DISCONNECT handlers at `:50,78,106,156`. |
| A7 | **Medium** | **No multi-user/home ownership boundary.** Authentication and OAuth grants use a single configured admin username; there are no users, homes, memberships, devices, or relays with ownership relations. `frontend/app/api/auth/login/route.ts:55-58`; `frontend/lib/auth.ts:33-47, 105-115`; `frontend/prisma/schema.prisma:11-67`. |

## 3. Firmware review

### Ethernet and GPIO

- The firmware declares LAN8720, PHY address 1, MDC 23, MDIO 18, power 16, and clock on GPIO0. Relay GPIO4 is one of the user-specified safe pins and does not overlap the stated RMII pins. `arduino/include/config.h:8,11-17`.
- PlatformIO pins `espressif32@6.10.0` and `wt32-eth01`; the firmware build succeeded against that configured toolchain. `arduino/platformio.ini:1-4`; build result: success, 48,680 bytes RAM (14.9%) and 986,641 bytes flash (75.3% of the reported application region).
- **Needs verification:** no physical WT32-ETH01/Ethernet link test or second Arduino-ESP32 core-version build was performed. The configured PlatformIO platform is pinned, but the project does not separately document/test a core 2.x/3.x compatibility matrix.

### Relays and electrical behavior

- Current single relay is GPIO4; active-low behavior is configurable. `arduino/include/config.h:8-9`; `arduino/src/main.cpp:52-55`.
- Firmware calls `pinMode(RELAY_PIN, OUTPUT)` before setting OFF. On active-low hardware, the GPIO output latch/pin transition at boot could briefly energize the relay before the OFF level is written. The current setting is active-high, but physical relay polarity and boot waveform are **Needs verification**. `arduino/src/main.cpp:243-244`.
- No configurable relay array/count, per-relay state, output metadata, or validation of future GPIO choices exists. `arduino/include/config.h:8-9`; `arduino/src/main.cpp:41-55`.
- No physical manual-override input or load/fail-safe assumptions are documented in firmware. This audit cannot certify isolation, contact rating, load protection, or electrical safety.

### MQTT, TLS, and reconnection

- Firmware uses TLS CA validation (`setCACert`), a device client ID/credentials, QoS 1 retained JSON state, and re-subscribes to the command topic in its connect callback. No `setInsecure` call was found. `arduino/src/main.cpp:104-116, 250-258`.
- The Last Will is published to the **state** topic as JSON, not the target's separate retained `home/{deviceId}/status` topic with `online|offline`. `arduino/src/main.cpp:246-256`.
- Firmware polls `mqttClient.loop()` and retries connection every fixed five seconds; Wi-Fi retries every ten seconds. Backoff/jitter and retry counters are absent. `arduino/src/main.cpp:26-30, 283-284, 343-352`.
- Broker TLS in backend uses `mqtts://`, certificate validation, and an explicitly supplied CA. `frontend/lib/mqtt-device.ts:73-96`. Firmware’s real `mqtt_ca.h` and `secrets.h` are ignored local files; the tracked CA template is a placeholder, so a clean checkout needs out-of-repository provisioning before it can build. `.gitignore:6-7`; `arduino/include/mqtt_ca.h.example:1-7`; `arduino/include/secrets.h.example:1-10`.

### Runtime, memory, watchdog, and OTA

- No explicit `delay()`, task-watchdog configuration/feed, or OTA handler/library was found in the firmware source. The loop handles synchronous `WebServer` requests and MQTT processing. `arduino/src/main.cpp:23-24, 283-284`.
- MQTT payloads use fixed-size `StaticJsonDocument` buffers, but local status builds dynamic Arduino `String` values. No heap/fragmentation telemetry is present. `arduino/src/main.cpp:80-108, 160-169`.
- No OTA partition/configuration or firmware update endpoint is present. Current PlatformIO build uses 75.3% of the reported app flash region; remaining OTA capacity/layout must be checked before OTA is designed.

## 4. Backend review

### MQTT connection and command acknowledgments

- Each status/command request creates a fresh MQTT client, uses `reconnectPeriod: 0`, subscribes, and closes it. This is request-scoped connection churn rather than a persistent reconnecting/resubscribing service. `frontend/lib/mqtt-device.ts:83-99, 159-192, 194-247`.
- Command handling does wait for a matching device state and request ID, verifies the reported state, and times out instead of treating publish as success. This is a useful existing behavior to preserve. `frontend/lib/mqtt-device.ts:206-240`; dashboard command route returns the resulting status: `frontend/app/api/device/[action]/route.ts:24-39`.
- Connect and command timeouts are bounded, but parallel opposite commands are not serialized or recorded in a durable command ledger. Firmware applies each received command immediately; simultaneous app/Google requests can race. `frontend/lib/mqtt-device.ts:194-240`; `arduino/src/main.cpp:125-157`.
- App/API and Google both use the same command helper, but local Android commands bypass it. Google success depends on MQTT state acknowledgment. `frontend/app/api/device/[action]/route.ts:24-39`; `frontend/app/api/smarthome/fulfillment/route.ts:114-143`; `android/app/src/main/java/com/faysaliot/control/universal/IoTApi.kt:140-152, 182-202`.

### State, validation, and errors

- `device_activity_state` and daily runtime are observations, not an always-current state service. The dashboard polls every 15 seconds; Android background polling is every 30 seconds; device state is otherwise fetched from MQTT on demand. `frontend/app/dashboard.tsx:258-267`; `android/app/src/main/java/com/faysaliot/control/universal/IoTBackgroundService.kt:95-110`; `frontend/lib/activity.ts:51-58`.
- Status persistence happens through the dashboard device-status API only. Local HTTP changes do not publish to MQTT; Google QUERY reads MQTT but does not update the database. `frontend/app/api/device/status/route.ts:14-23`; `frontend/app/api/smarthome/fulfillment/route.ts:78-103`; `arduino/src/main.cpp:175-186`.
- Dashboard action accepts only `on|off`, requires same-origin plus session, and logs activity. Login has a bounded body size and bcrypt comparison. `frontend/app/api/device/[action]/route.ts:14-25`; `frontend/app/api/auth/login/route.ts:26-58`.
- Google EXECUTE does not validate target IDs against the discovered device ID, coerces missing/non-boolean `params.on` to OFF, and silently omits a result for unsupported execution commands. This is a protocol-validation risk, especially before adding multiple devices. `frontend/app/api/smarthome/fulfillment/route.ts:106-153`.
- Google fulfillment parses JSON without an explicit request-size limit. OAuth token/login have content-length checks; there is no visible shared API body-size/rate-limit middleware. `frontend/app/api/smarthome/fulfillment/route.ts:40-42`; `frontend/app/api/auth/oauth/token/route.ts:18-22`; `frontend/app/api/auth/login/route.ts:30-32`.
- Several API operations log failures through `console.error`; there is no structured logger, correlation ID policy, or documented redaction policy. Example: `frontend/app/api/device/[action]/route.ts:34-45`.

## 5. Google Home integration review

| Intent / feature | Status | Evidence |
|---|---|---|
| SYNC | Implemented for one hard-coded/configured device; returns a SWITCH with OnOff and `agentUserId` equal to the one app username. | `frontend/app/api/smarthome/fulfillment/route.ts:45-75`. There is no user-specific device inventory. |
| QUERY | Implemented by querying MQTT; failure returns `online:false`. This is a live pull, not a HomeGraph state cache. | `frontend/app/api/smarthome/fulfillment/route.ts:78-104`. |
| EXECUTE | Supports OnOff and waits for MQTT acknowledgment; failure maps to `deviceOffline`. Target ID and parameter validation are incomplete. | `frontend/app/api/smarthome/fulfillment/route.ts:106-153`; `frontend/lib/mqtt-device.ts:194-240`. |
| DISCONNECT | Revokes the OAuth grant. | `frontend/app/api/smarthome/fulfillment/route.ts:156-164`. |
| Report State | Missing despite `willReportState: true`. | `frontend/app/api/smarthome/fulfillment/route.ts:65`; no HomeGraph client/service-account integration found. |
| Request Sync | Missing; no call or endpoint integration found. | No source references to HomeGraph `requestSync` were found outside generated build output. |
| Offline behavior | QUERY returns `online:false` on MQTT failure. | `frontend/app/api/smarthome/fulfillment/route.ts:92-103`. |
| Account linking / OAuth | Authorization and token routes exist. Exact redirect URI allowlisting, client authentication, expiring single-use authorization codes, access-token expiry, refresh rotation, active-grant checks, and DISCONNECT revocation are implemented. | `frontend/app/api/auth/oauth/authorize/route.ts:14-67`; `frontend/app/api/auth/oauth/token/route.ts:11-135`; `frontend/lib/auth.ts:49-95, 167-231, 238-249, 259-363`. |
| Google project configuration | **Needs verification.** The repo cannot prove Console client/secret, redirect values, integration project ID, tester status, HomeGraph API, or live fulfillment URL. `.env.example` contains placeholders: `frontend/.env.example:1-24`. |

The existing OAuth tests exercise helper behavior (five tests); there are no automated SYNC/QUERY/EXECUTE route tests or mock-MQTT command/ack tests. `frontend/tests/auth.test.mjs:1-84`; `frontend/package.json:5-10`.

## 6. Security review

| ID | Severity | Finding |
|---|---|---|
| S1 | **High** | **Unauthenticated local relay control.** ESP32 `/on` and `/off` are plain HTTP GET routes with no authentication, and the README documents direct access. Anyone with LAN/SoftAP access can toggle the output. `arduino/src/main.cpp:175-186`; `README.md:93-100`. |
| S2 | **High** | **Static SoftAP credential is embedded in source and documented in README.** It is a shared default, not per-device provisioning; treat it as publicly known, rotate it, and do not reproduce it in reports/logs. `arduino/include/config.h:19-21`; `README.md:37-40`. |
| S3 | **High** | **No per-user/home/device authorization boundary.** All sessions map to one admin identity and Google SYNC exposes the same configured device. This is not safe for multi-user or multi-home expansion. `frontend/app/api/auth/login/route.ts:55-58`; `frontend/app/api/smarthome/fulfillment/route.ts:45-75`; `frontend/prisma/schema.prisma:11-67`. |
| S4 | **High** | **npm audit reported three High-severity package entries** in the locked dependency tree: `prisma`, `@prisma/config`, and `deepmerge-ts`; `deepmerge-ts` is version 7.1.5 and has GHSA-ggr8-5vv4-36mx (recursive-graph stack exhaustion). The audit reports the available Prisma fix as a major-version update, so assess compatibility before applying. `frontend/package.json:18-32`; `frontend/package-lock.json:764-775, 1478-1481, 1916-1925`. Runtime exploitability of build/config paths was not independently established. |
| S5 | **Medium** | **No login/token/fulfillment rate limit is visible.** Same-origin and body-size checks are useful but do not prevent repeated password guesses or OAuth endpoint abuse. `frontend/app/api/auth/login/route.ts:26-32`; `frontend/app/api/auth/oauth/token/route.ts:18-22`; `frontend/app/api/smarthome/fulfillment/route.ts:28-42`. |
| S6 | **Medium** | **Android local HTTP conflicts with its cleartext policy.** `IoTApi` calls `http://<device>/on|off`, while the app manifest sets `usesCleartextTraffic="false"` and no network-security override is present; direct local control may be blocked on supported Android versions. `android/app/src/main/AndroidManifest.xml:18-23`; `android/app/src/main/java/com/faysaliot/control/universal/IoTApi.kt:119-152`. |
| S7 | **Medium** | **Broker ACL is not auditable from this repository.** No ACL rules/configuration or broker API integration are tracked. Verify that device credentials cannot publish/subscribe outside that device’s topics and that backend credentials have only required rights. `README.md:15`; `arduino/include/secrets.h.example:6-10`; `frontend/lib/mqtt-device.ts:59-80`. |
| S8 | **Medium** | **No repository-level rate/body/CORS/security-header policy is configured.** `next.config.mjs` is empty; auth/action routes do explicit same-origin checks, but fulfillment and token are public protocol endpoints. Platform/Vercel edge behavior, HTTPS redirection, HSTS, and CORS must be verified in deployment. `frontend/next.config.mjs:1-4`; `frontend/app/api/auth/login/route.ts:26-32`; `frontend/app/api/smarthome/fulfillment/route.ts:28-42`. |
| S9 | **Low** | **Credential-file handling is improved but not sufficient proof of secret hygiene.** `.env.local`, `frontend/.env`, `arduino/include/secrets.h`, and `arduino/include/mqtt_ca.h` are ignored/not tracked in current HEAD; targeted Git-history lookup for those paths found none. No `gitleaks`/`trufflehog` executable was installed, so a comprehensive historical secret scan was not possible. `.gitignore:6-15`; `frontend/.gitignore:1-2`. Rotate credentials previously exposed outside the repository if rotation is not already complete. |

Positive controls: browser login/action/logout enforce same-origin; session cookies are HttpOnly/SameSite Strict and Secure in production; OAuth redirect URIs are exact-allowlisted; token endpoint authenticates the OAuth client; fulfillment verifies a signed access token and active grant. `frontend/lib/auth.ts:82-95, 105-145`; `frontend/app/api/auth/login/route.ts:26-28`; `frontend/app/api/auth/logout/route.ts:8-14`; `frontend/app/api/smarthome/fulfillment/route.ts:14-25`.

## 7. Data model review and proposed MongoDB schema

### Existing model

Current PostgreSQL tables are `activity_events`, `device_activity_state`, `device_runtime_daily`, `oauth_authorization_codes`, and `oauth_grants`. There are no persisted user, home, membership, device-inventory, relay, or Google-account-link entities. `frontend/prisma/schema.prisma:11-67`.

`device_activity_state` is keyed by device ID and stores one output state; it has no foreign key to an inventory/owner. Runtime is sampled only across observations no more than 30 seconds apart. `frontend/prisma/schema.prisma:22-39`; `frontend/lib/activity.ts:11, 92-100`.

### Target MongoDB proposal (not implemented)

- `users`: `_id`, unique normalized `username/email`, `passwordHash` or external identity, `status`, timestamps.
- `homes`: `_id`, `ownerUserId`, `name`, `timezone`, timestamps.
- `homeMembers`: `homeId`, `userId`, `role`, status; unique `{homeId,userId}`.
- `devices`: immutable unique `deviceId`, `homeId`, model/firmware, claim lifecycle, last-seen/online, broker credential reference (never plaintext password), timestamps.
- `relays`: embed an array in each device with `{relayNo, gpio, activeLow, label, onOffState, updatedAt}`; validate unique relay numbers per device and the approved GPIO allowlist.
- `commands`: `requestId`, `deviceId`, `relayNo`, desired state, actor, issued/expiry/completion time, result; unique `requestId`, bounded retention.
- `googleLinks`: Google integration principal/opaque `agentUserId`, authorized user/home IDs, grant lifecycle, token hashes and timestamps. Enforce one ownership/membership check for every SYNC/QUERY/EXECUTE.
- `activityEvents`: home/device/relay/actor IDs, event type, observed timestamp, source and request ID.

Recommended indexes: unique user identity, unique `{homeId,userId}`, unique `deviceId`, unique `{deviceId,relayNo}` if relays are a collection, `{homeId,updatedAt}`, and TTL indexes only for short-lived codes/commands—not long-lived audit records. Use a replica-set deployment if transactions are required. Store broker secrets in a managed secret store or provisioner, not user/device documents.

Migration must preserve current activity/runtime data and the existing device/OAuth grant state, provide rollback/dual-read validation, and avoid moving secrets into MongoDB. User approval and a selected MongoDB deployment/backup plan are required before implementation.

## 8. Reliability and operations

- Both `/health` and `/api/health` return `{ok:true}` without checking database, MQTT broker, or device reachability. `frontend/app/health/route.ts:3-8`; `frontend/app/api/health/route.ts:3-8`.
- README claims Vercel serverless deployment, so a separate process manager/graceful-shutdown hook is not currently applicable to the deployed Next.js functions. If moved to Express, define signal handling, bounded MQTT shutdown, and a process/container manager. `README.md:3,58`; `frontend/package.json:5-8`.
- No structured logger, metrics, alerting, broker connection health, command latency/error SLO, or device-offline alert is evident in tracked source. Current status polling is client-driven. `frontend/app/dashboard.tsx:258-267`; `android/app/src/main/java/com/faysaliot/control/universal/IoTBackgroundService.kt:95-110`.
- MQTT state freshness depends on a new broker connection and retained message; backend `lastSeen` is assigned when that message is read rather than preserving a device-reported timestamp. `frontend/lib/mqtt-device.ts:123-144, 159-192`.
- Prisma is cached on the global object only outside production; production serverless connection-pool sizing is deployment-dependent and **Needs verification**. `frontend/lib/prisma.ts:3-11`.
- Authenticated status and command handlers surface errors; some Google QUERY/EXECUTE failures collapse into offline/deviceOffline, limiting diagnosis. `frontend/app/api/device/status/route.ts:24-30`; `frontend/app/api/smarthome/fulfillment/route.ts:92-103, 137-143`.

## 9. Electrical safety notes visible from code

- Current output pin GPIO4 is in the supplied safe-pin list and is not one of the specified WT32-ETH01 RMII pins. `arduino/include/config.h:8,11-17`.
- Firmware intends OFF at boot and supports active-low output, but output mode is set before OFF is written; an active-low board may experience a startup pulse. Verify with the actual relay module/load and use an electrically safe default before connecting hazardous loads. `arduino/src/main.cpp:52-55, 243-244`.
- Firmware exposes direct unauthenticated HTTP relay commands on LAN and SoftAP. Do not treat network isolation or the setup AP as authorization. `arduino/src/main.cpp:175-186, 305-307`.
- Only one relay is currently configured. Two/three-relay expansion requires an approved GPIO map, per-relay safe-state behavior, and boot/brownout/failover tests. `arduino/include/config.h:8-9`.
- No manual physical override or load-specific safety behavior is established by code. Physical inspection and electrician/hardware review remain necessary.

## 10. Prioritized fix plan

Effort is an engineering estimate, not a delivery commitment. “Risk” refers to implementation/rollout risk.

| Order | Task | Effort | Risk | Scope / completion gate |
|---|---|---:|---|---|
| 1 | Secure local control and rotate shared defaults | 1–2 days | High | Remove shared AP default; authenticate or deliberately disable local relay endpoints; define Android local transport safely. Verify unauthorized LAN/AP requests cannot switch outputs and valid local setup still works. |
| 2 | Confirm broker topology and per-device EMQX ACL | 1–2 days plus EMQX access | High | Inspect live EMQX deployment, credential count and ACL. Provision one identity/device; prove it cannot access another device’s topics. Keep secrets out of repo. |
| 3 | Agree migration boundaries and MongoDB deployment | 1–2 days design + 2–5 days migration | High | Select MongoDB replica-set/backup/restore plan; map current PostgreSQL/OAuth/activity records; stage migration with rollback and compare counts/state before cutover. |
| 4 | Build device/home/user/relay inventory and ownership checks | 3–5 days | High | Add normalized logical models, device claiming/provisioning, multi-user access checks, and seed the existing device without exposing it cross-home. |
| 5 | Introduce N-relay firmware safely | 2–4 days plus hardware validation | High | Use a validated relay array and safe GPIO allowlist; set boot levels before output enable; verify active-high/low boot, brownout, failover, and physical load behavior. |
| 6 | Migrate MQTT contract with compatibility window | 2–4 days | High | Coordinate firmware/backend/ACL changes for per-relay set/state and separate retained presence/LWT; test QoS, retained state, reconnect, legacy firmware, and rollback. Do not switch production topics without a migration note and approved rollout. |
| 7 | Make backend the canonical state/command service | 3–5 days | High | Add a persistent or managed MQTT state consumer, database state timestamps/version, command ledger, per-device serialization/idempotency and ack timeout; route app and Google through this service. |
| 8 | Complete Google Home account/state lifecycle | 3–5 days | High | Map OAuth grants to authorized users/homes; validate every target ID/parameter; implement Report State, Request Sync, offline semantics and HomeGraph retries; verify Console configuration with test accounts. |
| 9 | Extract/replace API with modular Express service | 4–7 days | High | If Express remains a hard requirement, introduce routes/services/models/middleware behind a compatibility boundary; preserve Next.js UI/API behavior during staged cutover. Otherwise explicitly approve retaining Next.js and update the target architecture. |
| 10 | Security, dependency, and operational gates | 2–4 days | Medium | Fix npm audit findings with Prisma compatibility tests; rate-limit auth/protocol endpoints; add structured redacted logs, deep health checks, alerts, MQTT mock and Google intent tests, Android tests, load/soak and deployment verification. |

### Assumptions and items that need external verification

1. README’s Vercel, Neon, and EMQX Cloud descriptions are treated as intended/current architecture only; live deployment, broker, databases, TLS, ACLs, and quotas were not accessed.
2. No live Google Home Console, test-user, account-linking, HomeGraph service-account, or Report State configuration was available.
3. This audit assumes the current relay is connected to GPIO4 and follows the configured active-high polarity; the physical module and load are not verified.
4. The actual ignored `.env` and device-secret headers were intentionally not read. Rotation status for credentials previously exposed outside the repository cannot be confirmed.
5. A clean checkout’s firmware provisioning process is not documented; local ignored secret/CA headers were present for the successful local PlatformIO build.
6. Android unit tests were blocked because no Android SDK location was configured in this environment. Java was available after using Android Studio’s JBR, but `ANDROID_HOME`/`sdk.dir` was missing.

## Validation performed

- PlatformIO firmware build: **passed** with the configured `espressif32@6.10.0` environment; no hardware was attached.
- Frontend tests: **5/5 passed** (`npm test`).
- TypeScript check: **passed** (`npm run typecheck`).
- `npm audit`: **3 High-severity package entries**, 0 Critical; upgrade path reported requires a major Prisma version.
- Android `testDebugUnitTest`: **not run to completion**; Gradle could not find Android SDK (`ANDROID_HOME`/`sdk.dir`).
- Secret handling: checked tracking/ignore status and history paths for local `.env`/secret-header filenames without reading their values. Comprehensive Git history secret scanning remains **Needs verification**.
