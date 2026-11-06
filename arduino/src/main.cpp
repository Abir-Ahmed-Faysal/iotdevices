#include <Arduino.h>
#include <ArduinoJson.h>
#include <ETH.h>
#include <WebServer.h>
#include <WiFi.h>
#include <espMqttClient.h>
#include <time.h>

#include "config.h"
#include "mqtt_ca.h"
#include "secrets.h"

enum NetworkMode {
  NET_NONE,
  NET_ETHERNET,
  NET_WIFI_STA,
  NET_WIFI_AP
};

NetworkMode currentNetworkMode = NET_NONE;
bool ethConnected = false;

WebServer server(80);
espMqttClientSecure mqttClient(espMqttClientTypes::UseInternalTask::NO);

constexpr unsigned long RECONNECT_INTERVAL_MS = 10000;
constexpr unsigned long MQTT_RETRY_INTERVAL_MS = 5000;
constexpr unsigned long MQTT_STATUS_INTERVAL_MS = 20000;
constexpr unsigned long TIME_SYNC_LOG_INTERVAL_MS = 10000;
constexpr unsigned long AP_FALLBACK_TIMEOUT_MS = 15000;
constexpr time_t TLS_VALID_TIME_EPOCH = 1700000000;

unsigned long lastReconnectAttempt = 0;
unsigned long lastMqttReconnectAttempt = 0;
unsigned long lastMqttStatusPublish = 0;
unsigned long lastTimeSyncLog = 0;
unsigned long networkStartTime = 0;
bool previouslyConnected = false;
bool timeSyncStarted = false;
bool clockSynchronized = false;
bool relayIsOn = false;
bool apModeActive = false;

char mqttCommandTopic[112];
char mqttStateTopic[112];

bool mqttIsConfigured() {
  return MQTT_HOST[0] != '\0' && MQTT_USERNAME[0] != '\0' &&
         MQTT_PASSWORD[0] != '\0' && MQTT_ROOT_CA[0] != '\0';
}

void setRelay(bool turnOn) {
  relayIsOn = turnOn;
  const bool outputHigh = RELAY_ACTIVE_LOW ? !turnOn : turnOn;
  digitalWrite(RELAY_PIN, outputHigh ? HIGH : LOW);
}

String getDeviceIp() {
  if (ethConnected) {
    return ETH.localIP().toString();
  }
  if (WiFi.isConnected()) {
    return WiFi.localIP().toString();
  }
  if (apModeActive) {
    return WiFi.softAPIP().toString();
  }
  return "0.0.0.0";
}

const char* getNetworkModeName() {
  switch (currentNetworkMode) {
    case NET_ETHERNET: return "ethernet";
    case NET_WIFI_STA: return "wifi_sta";
    case NET_WIFI_AP:  return "wifi_ap";
    default:           return "none";
  }
}

bool publishMqttStatus(const char* requestId = nullptr) {
  if (!mqttClient.connected()) {
    return false;
  }

  StaticJsonDocument<256> status;
  status["name"] = DEVICE_NAME;
  status["deviceId"] = MQTT_DEVICE_ID;
  status["state"] = relayIsOn ? "on" : "off";
  status["ip"] = getDeviceIp();
  status["network"] = getNetworkModeName();
  status["uptime"] = millis() / 1000;
  status["online"] = true;
  if (requestId != nullptr) {
    status["requestId"] = requestId;
  }

  char payload[256];
  const size_t length = serializeJson(status, payload, sizeof(payload));
  if (length == 0 || length >= sizeof(payload)) {
    Serial.println("Could not serialize MQTT status.");
    return false;
  }

  const uint16_t packetId = mqttClient.publish(
      mqttStateTopic, 1, true,
      reinterpret_cast<const uint8_t*>(payload), length);
  return packetId != 0;
}

void onMqttConnect(bool sessionPresent) {
  Serial.println("Connected to MQTT over TLS.");
  (void)sessionPresent;
  if (mqttClient.subscribe(mqttCommandTopic, 1) == 0) {
    Serial.println("Could not subscribe to MQTT command topic.");
  }
  publishMqttStatus();
  lastMqttStatusPublish = millis();
}

void onMqttDisconnect(espMqttClientTypes::DisconnectReason reason) {
  Serial.printf("MQTT disconnected (%u).\n", static_cast<uint8_t>(reason));
}

void onMqttMessage(const espMqttClientTypes::MessageProperties& properties,
                   const char* topic, const uint8_t* payload, size_t length,
                   size_t index, size_t total) {
  (void)properties;
  if (strcmp(topic, mqttCommandTopic) != 0 || index != 0 || length != total) {
    return;
  }

  StaticJsonDocument<192> command;
  const DeserializationError error = deserializeJson(command, payload, length);
  if (error) {
    Serial.println("Ignored invalid MQTT command JSON.");
    return;
  }

  const char* action = command["action"] | "";
  const char* requestId = command["requestId"] | "";
  if (strlen(requestId) > 64) {
    Serial.println("Ignored MQTT command with an invalid request ID.");
    return;
  }

  if (strcmp(action, "on") == 0) {
    setRelay(true);
  } else if (strcmp(action, "off") == 0) {
    setRelay(false);
  } else {
    Serial.println("Ignored unsupported MQTT command.");
    return;
  }

  if (!publishMqttStatus(requestId[0] == '\0' ? nullptr : requestId)) {
    Serial.println("Could not publish MQTT command result.");
  }
}

String makeStatusJson() {
  const String state = relayIsOn ? "on" : "off";
  const String ip = getDeviceIp();
  const unsigned long uptimeSeconds = millis() / 1000;

  return "{\"name\":\"" + String(DEVICE_NAME) + "\",\"deviceId\":\"" +
         String(MQTT_DEVICE_ID) + "\",\"state\":\"" + state +
         "\",\"ip\":\"" + ip + "\",\"network\":\"" + String(getNetworkModeName()) +
         "\",\"uptime\":" + String(uptimeSeconds) + "}";
}

void sendStatus() {
  server.send(200, "application/json", makeStatusJson());
}

void setupRoutes() {
  server.on("/on", HTTP_GET, []() {
    setRelay(true);
    sendStatus();
  });

  server.on("/off", HTTP_GET, []() {
    setRelay(false);
    sendStatus();
  });

  server.on("/status", HTTP_GET, sendStatus);

  server.onNotFound([]() {
    server.send(404, "application/json", "{\"error\":\"Not found\"}");
  });

  server.begin();
}

void onNetworkEvent(WiFiEvent_t event) {
  switch (event) {
    case ARDUINO_EVENT_ETH_START:
      Serial.println("Ethernet interface started.");
      ETH.setHostname(DEVICE_HOSTNAME);
      break;
    case ARDUINO_EVENT_ETH_CONNECTED:
      Serial.println("Ethernet link connected.");
      break;
    case ARDUINO_EVENT_ETH_GOT_IP:
      Serial.print("Ethernet acquired IP: ");
      Serial.println(ETH.localIP());
      ethConnected = true;
      currentNetworkMode = NET_ETHERNET;
      break;
    case ARDUINO_EVENT_ETH_DISCONNECTED:
      Serial.println("Ethernet link disconnected.");
      ethConnected = false;
      break;
    case ARDUINO_EVENT_ETH_STOP:
      Serial.println("Ethernet interface stopped.");
      ethConnected = false;
      break;
    case ARDUINO_EVENT_WIFI_STA_GOT_IP:
      Serial.print("WiFi STA acquired IP: ");
      Serial.println(WiFi.localIP());
      if (!ethConnected) {
        currentNetworkMode = NET_WIFI_STA;
      }
      break;
    case ARDUINO_EVENT_WIFI_STA_DISCONNECTED:
      if (!ethConnected) {
        Serial.println("WiFi STA disconnected.");
      }
      break;
    default:
      break;
  }
}

void setup() {
  Serial.begin(115200);

  snprintf(mqttCommandTopic, sizeof(mqttCommandTopic), "%s/%s/command",
           MQTT_TOPIC_ROOT, MQTT_DEVICE_ID);
  snprintf(mqttStateTopic, sizeof(mqttStateTopic), "%s/%s/state",
           MQTT_TOPIC_ROOT, MQTT_DEVICE_ID);

  pinMode(RELAY_PIN, OUTPUT);
  setRelay(false);

  if (mqttIsConfigured()) {
    static const char offlinePayload[] =
        "{\"name\":\"Faysal IoT\",\"deviceId\":\"" MQTT_DEVICE_ID
        "\",\"online\":false}";
    mqttClient.setServer(MQTT_HOST, MQTT_PORT);
    mqttClient.setClientId(MQTT_DEVICE_ID);
    mqttClient.setCredentials(MQTT_USERNAME, MQTT_PASSWORD);
    mqttClient.setCACert(MQTT_ROOT_CA);
    mqttClient.setKeepAlive(30);
    mqttClient.setTimeout(5);
    mqttClient.setWill(mqttStateTopic, 1, true, offlinePayload);
    mqttClient.onConnect(onMqttConnect);
    mqttClient.onDisconnect(onMqttDisconnect);
    mqttClient.onMessage(onMqttMessage);
  } else {
    Serial.println("Cloud MQTT is not configured; local HTTP control is available.");
  }

  WiFi.onEvent(onNetworkEvent);

  // Initialize Ethernet LAN8720
  Serial.println("Initializing Ethernet (LAN8720)...");
  ETH.begin(ETH_ADDR, ETH_POWER, ETH_MDC, ETH_MDIO, ETH_TYPE, ETH_CLOCK_MODE);

  // Initialize Wi-Fi STA as secondary
  WiFi.setHostname(DEVICE_HOSTNAME);
  WiFi.mode(WIFI_AP_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  networkStartTime = millis();
  lastReconnectAttempt = millis();

  setupRoutes();
  Serial.println("HTTP server started on port 80.");
}

void loop() {
  server.handleClient();
  mqttClient.loop();

  const unsigned long now = millis();

  // Determine active network mode (Priority: Ethernet -> Wi-Fi STA -> Emergency SoftAP)
  if (ethConnected) {
    currentNetworkMode = NET_ETHERNET;
    if (apModeActive) {
      WiFi.softAPdisconnect(true);
      apModeActive = false;
      Serial.println("Emergency SoftAP disabled; Ethernet link active.");
    }
  } else if (WiFi.isConnected()) {
    currentNetworkMode = NET_WIFI_STA;
    if (apModeActive) {
      WiFi.softAPdisconnect(true);
      apModeActive = false;
      Serial.println("Emergency SoftAP disabled; WiFi STA active.");
    }
  } else {
    // Check if emergency fallback SoftAP should be enabled
    if (!apModeActive && (now - networkStartTime >= AP_FALLBACK_TIMEOUT_MS)) {
      WiFi.softAP(AP_SSID, AP_PASSWORD);
      apModeActive = true;
      currentNetworkMode = NET_WIFI_AP;
      Serial.print("Emergency SoftAP enabled: ");
      Serial.println(AP_SSID);
      Serial.print("SoftAP IP: ");
      Serial.println(WiFi.softAPIP());
    }
  }

  const bool isOnline = ethConnected || WiFi.isConnected();
  if (isOnline && !previouslyConnected) {
    Serial.print("Network active (");
    Serial.print(getNetworkModeName());
    Serial.print("). IP: ");
    Serial.println(getDeviceIp());
    if (!timeSyncStarted) {
      configTime(0, 0, "pool.ntp.org", "time.nist.gov");
      timeSyncStarted = true;
      Serial.println("Synchronizing system clock for TLS...");
    }
  } else if (!isOnline && previouslyConnected) {
    Serial.println("Network disconnected. Waiting for link...");
  }
  previouslyConnected = isOnline;

  if (isOnline && timeSyncStarted && !clockSynchronized) {
    if (time(nullptr) >= TLS_VALID_TIME_EPOCH) {
      clockSynchronized = true;
      Serial.println("System clock synchronized.");
    } else if (now - lastTimeSyncLog >= TIME_SYNC_LOG_INTERVAL_MS) {
      lastTimeSyncLog = now;
      Serial.println("Waiting for internet time sync before MQTT TLS.");
    }
  }

  if (!isOnline && !ethConnected && now - lastReconnectAttempt >= RECONNECT_INTERVAL_MS) {
    lastReconnectAttempt = now;
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    Serial.println("Retrying WiFi STA connection...");
  }

  if (isOnline && clockSynchronized && mqttIsConfigured() && !mqttClient.connected() &&
      now - lastMqttReconnectAttempt >= MQTT_RETRY_INTERVAL_MS) {
    lastMqttReconnectAttempt = now;
    if (!mqttClient.connect()) {
      Serial.println("MQTT connection attempt failed; will retry.");
    }
  }

  if (isOnline && mqttClient.connected() &&
      now - lastMqttStatusPublish >= MQTT_STATUS_INTERVAL_MS) {
    lastMqttStatusPublish = now;
    if (!publishMqttStatus()) {
      Serial.println("MQTT heartbeat publish failed.");
    }
  }
}
