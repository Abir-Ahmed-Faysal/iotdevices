package com.faysaliot.control.universal

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import java.util.Locale

class VoiceAssistantManager(
    private val context: Context,
    private var language: String = "bn-BD",
) : TextToSpeech.OnInitListener {

    private var tts: TextToSpeech? = TextToSpeech(context, this)
    private var isTtsReady = false
    private val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
    private var focusRequest: AudioFocusRequest? = null

    override fun onInit(status: Int) {
        if (status == TextToSpeech.SUCCESS) {
            val locale = if (language == "bn-BD") Locale("bn", "BD") else Locale.US
            val result = tts?.setLanguage(locale)
            if (result == TextToSpeech.LANG_MISSING_DATA || result == TextToSpeech.LANG_NOT_SUPPORTED) {
                tts?.language = Locale.US
            }
            isTtsReady = true
        }
    }

    fun setLanguage(lang: String) {
        language = lang
        if (isTtsReady) {
            val locale = if (lang == "bn-BD") Locale("bn", "BD") else Locale.US
            val res = tts?.setLanguage(locale)
            if (res == TextToSpeech.LANG_MISSING_DATA || res == TextToSpeech.LANG_NOT_SUPPORTED) {
                tts?.language = Locale.US
            }
        }
    }

    fun speak(text: String, onComplete: (() -> Unit)? = null) {
        if (!isTtsReady) {
            onComplete?.invoke()
            return
        }

        requestAudioFocus()

        val utteranceId = "FishVoice_TTS_${System.currentTimeMillis()}"
        tts?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(id: String?) = Unit
            override fun onDone(id: String?) {
                if (id == utteranceId) {
                    abandonAudioFocus()
                    onComplete?.invoke()
                }
            }

            @Deprecated("Deprecated in Java")
            override fun onError(id: String?) {
                if (id == utteranceId) {
                    abandonAudioFocus()
                    onComplete?.invoke()
                }
            }
        })

        tts?.speak(text, TextToSpeech.QUEUE_FLUSH, null, utteranceId)
    }

    private fun requestAudioFocus() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
                .setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_ASSISTANT)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build()
                )
                .build()
            focusRequest = request
            audioManager?.requestAudioFocus(request)
        } else {
            @Suppress("DEPRECATION")
            audioManager?.requestAudioFocus(null, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
        }
    }

    private fun abandonAudioFocus() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            focusRequest?.let { audioManager?.abandonAudioFocusRequest(it) }
        } else {
            @Suppress("DEPRECATION")
            audioManager?.abandonAudioFocus(null)
        }
    }

    fun destroy() {
        tts?.stop()
        tts?.shutdown()
        tts = null
    }

    companion object {
        fun isWakeWord(raw: String): Boolean {
            val text = raw.lowercase(Locale.ROOT).trim()
            val wakePhrases = listOf(
                "hey FishVoice", "hi FishVoice", "FishVoice", "hey zoy", "hi zoy",
                "হে জয়", "জয়", "হেই জয়", "হে জয়", "জয়",
            )
            return wakePhrases.any { text.contains(it) }
        }

        fun getGreetingText(language: String): String {
            return if (language == "bn-BD") {
                "হ্যাঁ ফয়সাল, আমি কীভাবে সাহায্য করতে পারি?"
            } else {
                "Yes Faysal, how can I assist you?"
            }
        }

        fun getConfirmationPromptText(action: String, target: String, language: String): String {
            val actionBn = if (action == "on") "চালু" else "বন্ধ"
            val actionEn = if (action == "on") "turn ON" else "turn OFF"
            return if (language == "bn-BD") {
                "হ্যাঁ ফয়সাল, $target $actionBn করতে চান? নিশ্চিত করতে 'হ্যাঁ' বলুন।"
            } else {
                "Yes Faysal, do you want to $actionEn $target? Say yes to confirm."
            }
        }

        fun getSuccessResultText(action: String, target: String, language: String): String {
            val actionBn = if (action == "on") "চালু" else "বন্ধ"
            val actionEn = if (action == "on") "turned ON" else "turned OFF"
            return if (language == "bn-BD") {
                "$target সফলভাবে $actionBn করা হয়েছে।"
            } else {
                "$target has been $actionEn successfully."
            }
        }

        fun getCancelResultText(language: String): String {
            return if (language == "bn-BD") {
                "কমান্ড বাতিল করা হয়েছে।"
            } else {
                "Command canceled."
            }
        }

        fun parseAssistantIntent(raw: String): Pair<String, String>? {
            val text = raw.lowercase(Locale.ROOT)
                .replace(Regex("[.!?,।:]"), " ")
                .trim()

            val isOn = text.contains("turn on") || text.contains("switch on") ||
                    text.contains("on") || text.contains("চালু") || text.contains("অন") ||
                    text.contains("start") || text.contains("chalu")
            val isOff = text.contains("turn off") || text.contains("switch off") ||
                    text.contains("off") || text.contains("বন্ধ") || text.contains("অফ") ||
                    text.contains("stop") || text.contains("bondho")

            val action = when {
                isOn && !isOff -> "on"
                isOff && !isOn -> "off"
                else -> return null
            }

            val target = when {
                text.contains("motor 1") || text.contains("মোটর ১") || text.contains("motor one") -> "Motor 1"
                text.contains("motor 2") || text.contains("মোটর ২") || text.contains("motor two") -> "Motor 2"
                text.contains("motor 3") || text.contains("মোটর ৩") || text.contains("motor three") -> "Motor 3"
                text.contains("motor") || text.contains("মোটর") -> "Motor"
                text.contains("relay") || text.contains("রিলে") -> "Relay"
                text.contains("light") || text.contains("লাইটিং") || text.contains("বাতি") -> "Light"
                else -> "Device Output"
            }

            return action to target
        }

        fun parseConfirmation(raw: String): Boolean? {
            val text = raw.lowercase(Locale.ROOT).trim()
            val positive = listOf(
                "yes", "yeah", "confirm", "do it", "sure", "ok", "okay",
                "হ্যাঁ", "হাঁ", "করো", "চালু করো", "বন্ধ করো", "নিশ্চিত", "হ্যা", "ha", "yes please",
            )
            val negative = listOf(
                "no", "cancel", "don't", "stop", "never", "na",
                "না", "বাতিল", "থাক", "করো না",
            )
            val isPos = positive.any { text.contains(it) }
            val isNeg = negative.any { text.contains(it) }

            return when {
                isPos && !isNeg -> true
                isNeg && !isPos -> false
                else -> null
            }
        }
    }
}
