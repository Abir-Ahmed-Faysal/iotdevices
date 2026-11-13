# FishVoice IoT / Faysal IoT

FishVoice IoT (also named Faysal IoT) is a production-grade, multi-tier smart relay control platform. The architecture comprises an **ESP32 WT32-ETH01 firmware**, a **Next.js App Router serverless backend** deployed on Vercel with PostgreSQL persistence (Neon DB), and a **Native Kotlin Jetpack Compose Android app**.

---

## Architecture Overview

```
[Phone / Android App] ---> (HTTPS / TLS 443) ---> [Vercel Next.js Backend]
                                                         |
                                                  (MQTTS / TLS 8883)
                                                         |
                                                         v
                                              [EMQX Cloud MQTT Broker]
                                                         |
                                          (authenticated state webhook)
                                                         v
 [Google Home] <--- (HomeGraph Report State / Request Sync) --- [Vercel Next.js Backend]
                                                         ^
                                                         |
                                                  (MQTTS / TLS 8883)
                                                         |
[ESP32 / WT32-ETH01] <--- (Ethernet / WiFi STA / SoftAP) --+
```

---

## Project Layout

- `arduino/` — PlatformIO project & WT32-ETH01 firmware (Ethernet LAN8720, Wi-Fi STA, Emergency SoftAP, TLS MQTTS, HTTP server).
- `frontend/` — Next.js App Router dashboard & API routes built with TypeScript, Tailwind CSS, Prisma ORM, and Neon PostgreSQL.
- `android/` — Native Kotlin & Jetpack Compose Android app with Keystore AES-GCM session storage, background monitoring, Voice Assistant (Bengali/English), and Quick Settings tile.

---

## 1. Firmware Network State Manager (`arduino/`)

The firmware ([main.cpp](file:///C:/WorkSpace/ardino/arduino/src/main.cpp)) implements a priority-based, non-blocking **Network State Manager** for `WT32-ETH01`:

1. **Primary Interface**: Ethernet LAN8720 RMII PHY (`ETH_PHY_ADDR = 1`, `ETH_PHY_POWER = 16`, `ETH_PHY_MDC = 23`, `ETH_PHY_MDIO = 18`, `ETH_CLK_MODE = ETH_CLOCK_GPIO0_IN`).
2. **Secondary Backup**: 2.4 GHz Wi-Fi STA mode (`WIFI_SSID` / `WIFI_PASSWORD`).
3. **Emergency SoftAP Fallback**: The setup access point is available only after a unique per-device passphrase is provisioned; it remains disabled when no valid passphrase is configured.
4. **Safety & Auto-Recovery**: Network transitions maintain current relay state (no relay toggling during failover). When Primary Ethernet or Secondary Wi-Fi STA link recovers, the firmware automatically disables SoftAP and returns to the primary network.

### Flashing Firmware
```powershell
# Build PlatformIO firmware
& "C:\Users\dream\.platformio\penv\Scripts\platformio.exe" run -d arduino

# Upload firmware to board (e.g. COM4)
& "C:\Users\dream\.platformio\penv\Scripts\platformio.exe" run -d arduino -t upload --upload-port COM4

# Monitor serial logs at 115200 baud
& "C:\Users\dream\.platformio\penv\Scripts\platformio.exe" device monitor --port COM4 --baud 115200
```

---

## 2. Next.js Serverless Backend (`frontend/`)

Deployed on Vercel at `https://iotpro.vercel.app/`.

### API Routes
- `POST /api/auth/login` — Sign in and set stateless HMAC-SHA256 12-hour session cookie (`faysal_session`).
- `GET /api/auth/me` — Verify active session cookie.
- `POST /api/auth/logout` — Clear session cookie.
- `POST /api/device/on`, `POST /api/device/off` — Publish MQTTS command `{requestId, action, relayIndex}` to `faysal-iot/v1/devices/<deviceId>/command` and wait up to 4.5s for matching `requestId` ACK on `/state` topic. Missing `relayIndex` means relay 1. Send an `Idempotency-Key` header to make retries safe.
- `GET /api/device/status` — Get reported device state, IP, uptime, and online status.
- `POST /api/webhooks/emqx/state` — Authenticated EMQX Data Integration webhook for retained device state and LWT; updates PostgreSQL and reports state to linked Google Home accounts.
- `POST /api/smarthome/request-sync` — Authenticated same-origin request to refresh Google Home inventory.
- `GET /api/device/runtime` — Fetch daily cumulative online & relay-ON runtime (Dhaka calendar).
- `GET /api/activity` — Retrieve cursor-paginated activity event log.

---

## 3. Native Android App (`android/`)

Built with Kotlin and Jetpack Compose targeting Android SDK 37 (targetSdk 36, minSdk 26).

### Key Components
- **[MainActivity.kt](file:///C:/WorkSpace/ardino/android/app/src/main/java/com/faysaliot/control/universal/MainActivity.kt)** — Main Compose UI with connection status, relay controls, activity log, runtime graph, and voice control.
- **[SecureCookieJar.kt](file:///C:/WorkSpace/ardino/android/app/src/main/java/com/faysaliot/control/universal/SecureCookieJar.kt)** — Encrypts session cookies using AES-256-GCM backed by `AndroidKeyStore`.
- **[IoTBackgroundService.kt](file:///C:/WorkSpace/ardino/android/app/src/main/java/com/faysaliot/control/universal/IoTBackgroundService.kt)** — Foreground service (`foregroundServiceType="dataSync|microphone"`) polling status and handling background speech detection.
- **[IoTBootReceiver.kt](file:///C:/WorkSpace/ardino/android/app/src/main/java/com/faysaliot/control/universal/IoTBootReceiver.kt)** — `ACTION_BOOT_COMPLETED` receiver auto-starting background service on boot.
- **[VoiceAssistantManager.kt](file:///C:/WorkSpace/ardino/android/app/src/main/java/com/faysaliot/control/universal/VoiceAssistantManager.kt)** — Text-To-Speech engine in Bengali (`bn-BD`) & English (`en-US`), audio focus ducking, and intent parser.
- **[FishVoiceTileService.kt](file:///C:/WorkSpace/ardino/android/app/src/main/java/com/faysaliot/control/universal/FishVoiceTileService.kt)** — Quick Settings Tile for 1-tap voice control from top notification shade.

### Building Android App
```powershell
cd android
$env:JAVA_HOME="C:\Program Files\Android\Android Studio\jbr"
$env:ANDROID_HOME="C:\Users\dream\AppData\Local\Android\Sdk"
.\gradlew.bat installDebug
```

---

## Local HTTP Endpoints

When connected to the local LAN or configured emergency SoftAP (`192.168.4.1`), the read-only status endpoint is available:
```powershell
curl.exe http://<ESP_IP>/status
```

Local relay-control endpoints are disabled by default. If explicitly enabled for a provisioned deployment, they require a device-specific bearer token; use the authenticated backend for normal control.

## MQTT relay state and provisioning

The existing topics remain unchanged:

- Command: `faysal-iot/v1/devices/<deviceId>/command` with JSON `{ "requestId": "...", "action": "on|off", "relayIndex": 1 }` (QoS 1).
- State: `faysal-iot/v1/devices/<deviceId>/state` with a retained JSON snapshot. The root `state` remains relay 1 for older clients; `relays` reports each configured relay. Missing command `relayIndex` defaults to 1.
- Device state webhook: configure EMQX Data Integration to POST `{ "topic": "<topic>", "payload": "<JSON payload>" }` to `/api/webhooks/emqx/state`, with the `x-emqx-webhook-secret` header set to the same random secret as `EMQX_WEBHOOK_SECRET` (at least 32 characters). Restrict the integration to the device `/state` topics and use the broker ACL to limit device credentials to their own command and state topics.
- HomeGraph: set `GOOGLE_HOME_SERVICE_ACCOUNT_JSON` to the Google service-account JSON in the deployment environment. Enable the HomeGraph API and grant the service account permission to call it. Do not commit the service-account JSON or place it in client-side configuration.
- Backend commands are serialized per device using a PostgreSQL lease and recorded in `device_commands`; retries with the same idempotency key and relay do not publish a second command after completion. A lease expires after an interrupted request, allowing the same pending request ID to resume.

For WT32-ETH01 relay outputs, the firmware configuration supports IO4, IO14, IO32, and IO33 only. RMII Ethernet uses IO0, IO16, IO18, IO19, IO21, IO22, IO23, IO25, IO26, and IO27. Configure each relay's pin and `activeLow` value in `arduino/include/config.h`; relay outputs are initialized OFF before setting the pins to OUTPUT. Verify the relay module's electrical compatibility and boot behavior on the actual hardware before connecting any load.
