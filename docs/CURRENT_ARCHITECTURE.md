# Current JOY / FishVoice Architecture

**Evidence boundary:** Source/configuration review only. The deployment claims in `README.md`, physical hardware, broker, database, and Vercel settings were not independently tested.

## System context

```text
                         ┌────────────────────────┐
 Browser dashboard ─────┤                        │
 Android app ────────────┤ HTTPS / session cookie ├──> Next.js App Router API
 Google Home ────────────┤ OAuth bearer / intents │       │
                         └────────────────────────┘       ├── Prisma ─ PostgreSQL
                                                          │
                                                          └── MQTT/TLS
                                                               │
                                                         MQTT broker
                                                               │
                                             MQTT/TLS ─ WT32-ETH01
                                                               │
                                                        single relay output
```

The README identifies Vercel, Neon PostgreSQL, and EMQX Cloud as the intended services. Their active configuration and service health are **Needs Verification**.

## Components and source responsibilities

| Component | Source location | Responsibility / current boundary |
|---|---|---|
| Firmware configuration | `arduino/include/config.h` | One device name/topic root, one relay GPIO/polarity, WT32-ETH01 LAN8720 pins, emergency AP settings. |
| Firmware runtime | `arduino/src/main.cpp` | Relay initialization; local HTTP endpoints; Ethernet/Wi-Fi/AP selection; NTP; MQTT TLS; command subscription, retained state, heartbeat, LWT. |
| Firmware dependencies | `arduino/platformio.ini` | PlatformIO ESP32 Arduino target; ArduinoJson and espMqttClient. |
| MQTT operations | `frontend/lib/mqtt-device.ts` | Reads environment configuration; opens short-lived TLS clients; reads retained state; publishes commands and matches acknowledgments. |
| Web/API | `frontend/app/api/**` | Login/session, device status/control, activity/runtime, health, OAuth and Smart Home fulfillment. |
| Authentication | `frontend/lib/auth.ts` | HMAC session and OAuth code/token signing/validation; one configured admin identity. |
| State/activity | `frontend/lib/activity.ts` | Transactional observation update, transition events, and sampled runtime accumulation. |
| Database | `frontend/prisma/schema.prisma`, `frontend/prisma/migrations/**` | Activity events, one current observation per device ID, daily runtime per device/date. No user/home/relay inventory. |
| Web client | `frontend/app/dashboard.tsx` | Session login, dashboard controls, status/activity/runtime polling every 15 seconds. |
| Android API | `android/app/src/main/java/com/faysaliot/control/universal/IoTApi.kt` | HTTPS API client/session, local direct HTTP transport, auto fallback to AP/cloud. |
| Android session | `android/app/src/main/java/com/faysaliot/control/universal/SecureCookieJar.kt` | Encrypts session cookie with AES/GCM and AndroidKeyStore. |
| Android UI/voice | `android/app/src/main/java/com/faysaliot/control/universal/MainActivity.kt` and `VoiceAssistantManager.kt` | Dashboard, transport selection, voice parsing and confirmation. Not Google Home Cloud-to-cloud. |
| Android background | `android/app/src/main/java/com/faysaliot/control/universal/IoTBackgroundService.kt` | Optional polling and voice service; polls device status every 30 seconds. |

## Firmware and network lifecycle

1. `setup()` sets the relay pin to output and commands OFF.
2. If MQTT credentials and CA are configured, firmware sets broker TLS credentials, device ID as MQTT client ID, keepalive, command callback, and retained offline Last Will.
3. Ethernet LAN8720 is initialized; Wi-Fi enters AP+STA mode and starts STA connection.
4. `loop()` chooses Ethernet > connected STA > emergency AP. AP is disabled when either uplink returns.
5. NTP synchronization is required before MQTT TLS connection attempts.
6. On MQTT connect, firmware subscribes to the command topic and publishes a retained current-state payload. It publishes heartbeat status every 20 seconds.
7. A valid `on`/`off` command sets the relay and publishes status carrying the incoming request ID.
8. Local HTTP `/status`, `/on`, `/off` remain available without cloud MQTT.

The behavior is source-confirmed; actual electrical safety, failover timing, broker connection, AP setup, and firmware flash are **Needs Verification**.

## MQTT contract currently in source

```text
<root>/<configured-device-id>/command
  JSON: { "requestId": "...", "action": "on" | "off" }

<root>/<configured-device-id>/state
  JSON: { "name", "deviceId", "state", "ip", "network",
          "uptime", "online", optional "requestId" }
```

The source uses QoS 1 and retained state, and a retained Last Will with `online:false`. Preserve these topics and payloads during stabilization. Multi-device identity and ACL behavior are not established by the repository.

## Backend request lifecycle

### Dashboard command

`POST /api/device/[action]` requires same-origin and valid signed session. It calls `setDeviceState`, waits for a broker acknowledgment matching a server-generated UUID, writes an activity event, and returns device status.

### Dashboard status

`GET /api/device/status` requires a session, calls `getDeviceStatus` (connect + subscribe to retained state + wait up to two seconds), and persists the sample with `recordDeviceObservation`. Database updates are serialized per device ID.

### Google fulfillment

`POST /api/smarthome/fulfillment` checks a signed, active OAuth access-token grant and dispatches a subset of SYNC/QUERY/EXECUTE/DISCONNECT. It currently resolves only one configured device. DISCONNECT revokes the active grant. It does not update HomeGraph proactively.

## Data model

| Table | Current key/use | Not modeled |
|---|---|---|
| `activity_events` | Auto-increment event log, optional device ID | User/home ownership, actor identity on every event, retention/partitioning. |
| `device_activity_state` | One row per device ID; online, uptime, output, update time | Inventory/traits, network history, device-to-home membership. |
| `device_runtime_daily` | Composite device ID + date; sampled online/relay seconds | Provenance, gaps outside observation windows, user/home association. |
| `oauth_authorization_codes` | Hashed, expiring, single-use authorization codes bound to client and redirect URI | Google user mapping and code-consumption integration test evidence. |
| `oauth_grants` | Refresh-token hash, grant owner/client, expiry, revocation | Google account-link lifecycle beyond the current single-admin model. |

## Client behavior

- Web and Android poll status, activity, and runtime approximately every 15 seconds.
- Android background monitoring polls status every 30 seconds.
- Android supports cloud, local, and auto modes. Local requests use unauthenticated HTTP direct to the ESP32 and do not pass through backend auth, event recording, or MQTT acknowledgment.
- The Android manifest explicitly disables cleartext traffic; compatibility of direct local HTTP is **Needs Verification**.

OAuth client credentials and exact redirect URIs are now required; configure `GOOGLE_OAUTH_REDIRECT_URIS` to the Google Console allowlisted callback. Access-token lifetime is one hour and refresh tokens rotate. The grant tables require the new Prisma migration to be applied before OAuth endpoints are deployed. Existing stateless tokens require relinking.

## Scalability boundary

The currently modeled production boundary is one configured relay and one administrative account. A stable device registry, homes/memberships, relay output inventory, multi-user authorization, Google user links, centralized state ingestion, and command ledger are absent. MQTT operations are per API invocation rather than a persistent shared state stream.

## Configuration and unknowns

Secret-bearing files are ignored by Git; the audit did not inspect credential values. The following require environment/device/console access:

- Actual `MQTT_DEVICE_ID`, MQTT host/user/ACL, CA validity, network credentials, and session/admin secrets.
- Vercel/Neon/EMQX deployment state, quotas, connection pooling, and production code version.
- Google Home Developer Console, OAuth client registrations, fulfillment URL, HomeGraph API/service account, test/approval status.
- Hardware revision, exact board wiring, relay module, load, and observed fail-safe state.

See [SYSTEM_AUDIT_REPORT.md](./SYSTEM_AUDIT_REPORT.md) for risks and [RECOMMENDED_UPGRADE_ROADMAP.md](./RECOMMENDED_UPGRADE_ROADMAP.md) for phased work.
