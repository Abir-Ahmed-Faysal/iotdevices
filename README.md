# JOY IoT / Faysal IoT

JOY IoT (also named Faysal IoT) is a production-grade, multi-tier smart relay control platform. The architecture comprises an **ESP32 WT32-ETH01 firmware**, a **Next.js App Router serverless backend** deployed on Vercel with PostgreSQL persistence (Neon DB), and a **Native Kotlin Jetpack Compose Android app**.

---

## Architecture Overview

```
[Phone / Android App] ---> (HTTPS / TLS 443) ---> [Vercel Next.js Backend]
                                                         |
                                                  (MQTTS / TLS 8883)
                                                         |
                                                         v
                                              [EMQX Cloud MQTT Broker]
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
3. **Emergency SoftAP Fallback**: Emergency Wi-Fi Access Point (`JOY-IoT-Setup` / `faysaliotsetup`, IP `192.168.4.1`) automatically enabled if both Ethernet and Wi-Fi STA fail for > 15s.
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
- `POST /api/device/on`, `POST /api/device/off` — Publish MQTTS command `{requestId, action}` to `faysal-iot/v1/devices/<deviceId>/command` and wait up to 4.5s for matching `requestId` ACK on `/state` topic.
- `GET /api/device/status` — Get reported device state, IP, uptime, and online status.
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
- **[JoyTileService.kt](file:///C:/WorkSpace/ardino/android/app/src/main/java/com/faysaliot/control/universal/JoyTileService.kt)** — Quick Settings Tile for 1-tap voice control from top notification shade.

### Building Android App
```powershell
cd android
$env:JAVA_HOME="C:\Program Files\Android\Android Studio\jbr"
$env:ANDROID_HOME="C:\Users\dream\AppData\Local\Android\Sdk"
.\gradlew.bat installDebug
```

---

## Local HTTP Endpoints

When connected to local LAN or emergency SoftAP (`192.168.4.1`), direct HTTP endpoints are available:
```powershell
curl.exe http://<ESP_IP>/status
curl.exe http://<ESP_IP>/on
curl.exe http://<ESP_IP>/off
```
