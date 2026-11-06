package com.faysaliot.control.universal

import android.content.Context
import android.content.SharedPreferences

object IoTSettings {
    private const val PREFS_NAME = "faysal_iot_settings"
    private const val KEY_BACKGROUND_SERVICE = "background_service_enabled"
    private const val KEY_WAKE_WORD = "wake_word_enabled"
    private const val KEY_VOICE_LANGUAGE = "voice_language"
    private const val KEY_PREFERRED_TRANSPORT = "preferred_transport"
    private const val KEY_LOCAL_DEVICE_IP = "local_device_ip"

    private fun prefs(context: Context): SharedPreferences =
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    fun isBackgroundServiceEnabled(context: Context): Boolean =
        prefs(context).getBoolean(KEY_BACKGROUND_SERVICE, false)

    fun setBackgroundServiceEnabled(context: Context, enabled: Boolean) {
        prefs(context).edit().putBoolean(KEY_BACKGROUND_SERVICE, enabled).apply()
    }

    fun isWakeWordEnabled(context: Context): Boolean =
        prefs(context).getBoolean(KEY_WAKE_WORD, false)

    fun setWakeWordEnabled(context: Context, enabled: Boolean) {
        prefs(context).edit().putBoolean(KEY_WAKE_WORD, enabled).apply()
    }

    fun getVoiceLanguage(context: Context): String =
        prefs(context).getString(KEY_VOICE_LANGUAGE, "bn-BD") ?: "bn-BD"

    fun setVoiceLanguage(context: Context, lang: String) {
        prefs(context).edit().putString(KEY_VOICE_LANGUAGE, lang).apply()
    }

    fun getPreferredTransport(context: Context): String =
        prefs(context).getString(KEY_PREFERRED_TRANSPORT, "auto") ?: "auto"

    fun setPreferredTransport(context: Context, transport: String) {
        prefs(context).edit().putString(KEY_PREFERRED_TRANSPORT, transport).apply()
    }

    fun getLocalDeviceIp(context: Context): String =
        prefs(context).getString(KEY_LOCAL_DEVICE_IP, "192.168.4.1") ?: "192.168.4.1"

    fun setLocalDeviceIp(context: Context, ip: String) {
        prefs(context).edit().putString(KEY_LOCAL_DEVICE_IP, ip.trim()).apply()
    }
}
