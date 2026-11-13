package com.faysaliot.control.universal

import android.content.Context
import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

data class DeviceStatus(
    val online: Boolean,
    val state: String,
    val ip: String,
    val uptime: Long?,
    val lastSeen: String?,
    val activityWarning: String?,
    val transport: String = "cloud_mqtt",
)

data class HomeRelay(
    val relayIndex: Int,
    val name: String,
    val gpio: Int,
    val activeLow: Boolean,
    val state: String,
)

data class HomeDevice(
    val deviceId: String,
    val name: String,
    val online: Boolean,
    val lastSeen: String?,
    val relays: List<HomeRelay>,
)

data class ActivityEntry(
    val id: String,
    val eventType: String,
    val message: String,
    val createdAt: String,
)

data class ActivityPage(
    val entries: List<ActivityEntry>,
    val nextCursor: String?,
)

data class RuntimeDay(
    val day: Int,
    val onlineSeconds: Int,
    val relayOnSeconds: Int,
)

data class RuntimeMonth(
    val key: String,
    val label: String,
    val daysInMonth: Int,
    val throughDay: Int,
    val days: List<RuntimeDay>,
)

class ApiException(val statusCode: Int, message: String) : IOException(message)

class IoTApi(private val context: Context) {
    private val cookieJar = SecureCookieJar(context)
    private val client = OkHttpClient.Builder()
        .cookieJar(cookieJar)
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .callTimeout(20, TimeUnit.SECONDS)
        .addInterceptor { chain ->
            chain.proceed(
                chain.request().newBuilder()
                    .header("Origin", API_ORIGIN)
                    .header("Accept", "application/json")
                    .build(),
            )
        }
        .build()

    suspend fun signIn(username: String, password: String): Pair<String, String?> {
        val body = JSONObject()
            .put("username", username)
            .put("password", password)
            .toString()
        val json = execute("/api/auth/login", "POST", body)
        return json.getString("username") to json.optStringOrNull("activityWarning")
    }

    suspend fun currentUser(): String = execute("/api/auth/me").getString("username")

    suspend fun signOut() {
        try {
            execute("/api/auth/logout", "POST", "")
        } finally {
            cookieJar.clear()
        }
    }

    suspend fun devices(): List<HomeDevice> {
        val array = execute("/api/devices").getJSONArray("devices")
        return array.mapObjects { item ->
            HomeDevice(
                deviceId = item.getString("deviceId"),
                name = item.getString("name"),
                online = item.optBoolean("online"),
                lastSeen = item.optStringOrNull("lastSeen"),
                relays = item.getJSONArray("relays").mapObjects { relay ->
                    HomeRelay(
                        relayIndex = relay.getInt("relayIndex"),
                        name = relay.getString("name"),
                        gpio = relay.getInt("gpio"),
                        activeLow = relay.optBoolean("activeLow"),
                        state = relay.optString("state", "unknown"),
                    )
                },
            )
        }
    }

    suspend fun deviceStatus(deviceId: String? = null): DeviceStatus {
        val json = execute(devicePath("/api/device/status", deviceId))
        return DeviceStatus(
            online = json.optBoolean("online"),
            state = json.optString("state", "unknown"),
            ip = json.optString("ip", "-"),
            uptime = json.optLongOrNull("uptime"),
            lastSeen = json.optStringOrNull("lastSeen"),
            activityWarning = json.optStringOrNull("activityWarning"),
            transport = "cloud_mqtt",
        )
    }

    suspend fun setDeviceState(
        action: String,
        deviceId: String? = null,
        relayIndex: Int = 1,
    ): String? {
        require(action == "on" || action == "off")
        require(relayIndex in 1..4)
        return execute(devicePath("/api/device/$action", deviceId, relayIndex), "POST", "")
            .optStringOrNull("activityWarning")
    }

    suspend fun smartDeviceStatus(deviceId: String? = null): DeviceStatus {
        return deviceStatus(deviceId)
    }

    suspend fun smartSetDeviceState(
        action: String,
        deviceId: String? = null,
        relayIndex: Int = 1,
    ): String? {
        return setDeviceState(action, deviceId, relayIndex)
    }

    suspend fun activities(cursor: String? = null): ActivityPage {
        val path = buildString {
            append("/api/activity")
            if (cursor != null) append("?cursor=").append(cursor)
        }
        val json = execute(path)
        val array = json.getJSONArray("activity")
        return ActivityPage(
            entries = array.mapObjects { item ->
                ActivityEntry(
                    id = item.getString("id"),
                    eventType = item.getString("eventType"),
                    message = item.getString("message"),
                    createdAt = item.getString("createdAt"),
                )
            },
            nextCursor = json.optStringOrNull("nextCursor"),
        )
    }

    suspend fun runtime(): List<RuntimeMonth> {
        val json = execute("/api/device/runtime")
        return json.getJSONArray("months").mapObjects { month ->
            RuntimeMonth(
                key = month.getString("key"),
                label = month.getString("label"),
                daysInMonth = month.getInt("daysInMonth"),
                throughDay = month.getInt("throughDay"),
                days = month.getJSONArray("days").mapObjects { day ->
                    RuntimeDay(
                        day = day.getInt("day"),
                        onlineSeconds = day.getInt("onlineSeconds"),
                        relayOnSeconds = day.getInt("relayOnSeconds"),
                    )
                },
            )
        }
    }

    private fun devicePath(path: String, deviceId: String?, relayIndex: Int? = null): String {
        val parameters = mutableListOf<String>()
        if (deviceId != null) {
            parameters.add("deviceId=${java.net.URLEncoder.encode(deviceId, Charsets.UTF_8.name())}")
        }
        if (relayIndex != null) parameters.add("relayIndex=$relayIndex")
        return if (parameters.isEmpty()) path else "$path?${parameters.joinToString("&")}"
    }

    private suspend fun execute(
        path: String,
        method: String = "GET",
        body: String? = null,
    ): JSONObject {
        val requestBody = body?.toRequestBody(JSON_MEDIA_TYPE)
        val builder = Request.Builder()
            .url(BuildConfig.API_BASE_URL.toHttpUrl().resolve(path) ?: error("Invalid API path."))
        when (method) {
            "GET" -> builder.get()
            "POST" -> builder.post(requestBody ?: ByteArray(0).toRequestBody(null))
            else -> error("Unsupported API method.")
        }

        val response = await(client.newCall(builder.build()))
        response.use {
            val responseText = it.body.string()
            if (!it.isSuccessful) {
                val message = runCatching {
                    JSONObject(responseText).optString("error").takeIf(String::isNotBlank)
                }.getOrNull() ?: "Request failed (${it.code})."
                throw ApiException(it.code, message)
            }
            if (responseText.isBlank()) return JSONObject()
            return JSONObject(responseText)
        }
    }

    private suspend fun await(call: Call): Response = suspendCancellableCoroutine { continuation ->
        continuation.invokeOnCancellation { call.cancel() }
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, error: IOException) {
                if (continuation.isActive) continuation.resumeWithException(error)
            }

            override fun onResponse(call: Call, response: Response) {
                if (continuation.isActive) continuation.resume(response)
                else response.close()
            }
        })
    }

    private companion object {
        const val API_ORIGIN = "https://iotpro.vercel.app"
        val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
    }
}

private fun JSONObject.optStringOrNull(key: String): String? =
    optString(key).takeIf { it.isNotBlank() && it != "null" }

private fun JSONObject.optLongOrNull(key: String): Long? =
    if (has(key) && !isNull(key)) optLong(key).takeIf { it >= 0 } else null

private inline fun <T> JSONArray.mapObjects(transform: (JSONObject) -> T): List<T> =
    (0 until length()).map { index -> transform(getJSONObject(index)) }
