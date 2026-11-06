package com.faysaliot.control.universal

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class SecureCookieJar(context: Context) : CookieJar {
    private val preferences = context.getSharedPreferences("secure_session", Context.MODE_PRIVATE)
    private val lock = Any()
    private val apiHost = BuildConfig.API_BASE_URL.toHttpUrl().host
    private var sessionCookie: Cookie? = restoreCookie()

    override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) {
        synchronized(lock) {
            val newCookie = cookies.lastOrNull { it.name == SESSION_COOKIE && it.matches(url) }
            if (newCookie == null || newCookie.expiresAt <= System.currentTimeMillis()) {
                sessionCookie = null
                preferences.edit().remove(COOKIE_KEY).apply()
                return
            }

            sessionCookie = newCookie
            preferences.edit().putString(
                COOKIE_KEY,
                encrypt("${newCookie.value}\n${newCookie.expiresAt}"),
            ).apply()
        }
    }

    override fun loadForRequest(url: HttpUrl): List<Cookie> = synchronized(lock) {
        val cookie = sessionCookie
        if (url.host != apiHost || cookie == null || cookie.expiresAt <= System.currentTimeMillis()) {
            sessionCookie = null
            preferences.edit().remove(COOKIE_KEY).apply()
            emptyList()
        } else {
            listOf(cookie)
        }
    }

    fun clear() {
        synchronized(lock) {
            sessionCookie = null
            preferences.edit().remove(COOKIE_KEY).apply()
        }
    }

    private fun restoreCookie(): Cookie? {
        val encrypted = preferences.getString(COOKIE_KEY, null) ?: return null
        return runCatching {
            val (value, expiresAtString) = decrypt(encrypted).split('\n', limit = 2)
            val expiresAt = expiresAtString.toLong()
            if (expiresAt <= System.currentTimeMillis()) return null
            Cookie.Builder()
                .name(SESSION_COOKIE)
                .value(value)
                .hostOnlyDomain(apiHost)
                .path("/")
                .expiresAt(expiresAt)
                .secure()
                .httpOnly()
                .build()
        }.getOrNull()
    }

    private fun encrypt(value: String): String {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey())
        val encrypted = cipher.doFinal(value.toByteArray(Charsets.UTF_8))
        return Base64.encodeToString(cipher.iv + encrypted, Base64.NO_WRAP)
    }

    private fun decrypt(value: String): String {
        val encrypted = Base64.decode(value, Base64.NO_WRAP)
        require(encrypted.size > GCM_IV_BYTES) { "Invalid encrypted session." }
        val iv = encrypted.copyOfRange(0, GCM_IV_BYTES)
        val ciphertext = encrypted.copyOfRange(GCM_IV_BYTES, encrypted.size)
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(), GCMParameterSpec(GCM_TAG_BITS, iv))
        return cipher.doFinal(ciphertext).toString(Charsets.UTF_8)
    }

    private fun getOrCreateKey(): SecretKey {
        val keyStore = KeyStore.getInstance(ANDROID_KEY_STORE).apply { load(null) }
        (keyStore.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }

        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEY_STORE).run {
            init(
                KeyGenParameterSpec.Builder(
                    KEY_ALIAS,
                    KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                )
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setRandomizedEncryptionRequired(true)
                    .build(),
            )
            generateKey()
        }
    }

    private companion object {
        const val SESSION_COOKIE = "faysal_session"
        const val COOKIE_KEY = "session_cookie"
        const val KEY_ALIAS = "faysal_iot_session_key"
        const val ANDROID_KEY_STORE = "AndroidKeyStore"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val GCM_IV_BYTES = 12
        const val GCM_TAG_BITS = 128
    }
}
