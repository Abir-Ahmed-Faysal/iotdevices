#pragma once

#include <ETH.h>

constexpr char DEVICE_NAME[] = "Faysal IoT";
constexpr char DEVICE_HOSTNAME[] = "faysal-iot";
constexpr char MQTT_TOPIC_ROOT[] = "faysal-iot/v1/devices";
constexpr int RELAY_PIN = 4;
constexpr bool RELAY_ACTIVE_LOW = false;

// WT32-ETH01 LAN8720 Ethernet PHY configuration
constexpr eth_phy_type_t ETH_TYPE = ETH_PHY_LAN8720;
constexpr int ETH_ADDR = 1;
constexpr int ETH_MDC = 23;
constexpr int ETH_MDIO = 18;
constexpr int ETH_POWER = 16;
constexpr eth_clock_mode_t ETH_CLOCK_MODE = ETH_CLOCK_GPIO0_IN;

#ifndef AP_SETUP_PASSWORD
#define AP_SETUP_PASSWORD ""
#endif

#ifndef ENABLE_LOCAL_HTTP_CONTROL
#define ENABLE_LOCAL_HTTP_CONTROL 0
#endif

#ifndef LOCAL_CONTROL_TOKEN
#define LOCAL_CONTROL_TOKEN ""
#endif

constexpr bool LOCAL_CONTROL_ENABLED =
    ENABLE_LOCAL_HTTP_CONTROL != 0 && sizeof(LOCAL_CONTROL_TOKEN) > 32;

constexpr char AP_SSID[] = "FishVoice-IoT-Setup";
