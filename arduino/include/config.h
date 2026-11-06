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

// Emergency SoftAP Fallback Configuration
constexpr char AP_SSID[] = "FishVoice-IoT-Setup";
constexpr char AP_PASSWORD[] = "faysaliotsetup";
