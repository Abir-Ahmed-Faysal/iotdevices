package com.faysaliot.control.universal

import android.content.Context
import android.content.SharedPreferences

object IoTSettings {
    private const val PREFS_NAME = "faysal_iot_settings"
    private const val KEY_BACKGROUND_SERVICE = "background_service_enabled"

    private fun prefs(context: Context): SharedPreferences =
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    fun isBackgroundServiceEnabled(context: Context): Boolean =
        prefs(context).getBoolean(KEY_BACKGROUND_SERVICE, false)

    fun setBackgroundServiceEnabled(context: Context, enabled: Boolean) {
        prefs(context).edit().putBoolean(KEY_BACKGROUND_SERVICE, enabled).apply()
    }

}
