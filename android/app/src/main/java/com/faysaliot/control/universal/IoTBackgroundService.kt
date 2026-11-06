package com.faysaliot.control.universal

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import androidx.core.app.NotificationCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

class IoTBackgroundService : Service() {

    private val serviceJob = SupervisorJob()
    private val serviceScope = CoroutineScope(Dispatchers.IO + serviceJob)
    private val mainHandler = Handler(Looper.getMainLooper())

    private var statusPollJob: Job? = null
    private lateinit var api: IoTApi
    private var voiceAssistant: VoiceAssistantManager? = null
    private var speechRecognizer: SpeechRecognizer? = null
    private var audioRecordDetector: AudioRecordVoiceDetector? = null
    private var isListening = false

    private var assistantState = STATE_IDLE
    private var pendingAction: String? = null
    private var pendingTarget: String = "Device Output"

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        api = IoTApi(applicationContext)
        voiceAssistant = VoiceAssistantManager(applicationContext, IoTSettings.getVoiceLanguage(applicationContext))
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (!IoTSettings.isBackgroundServiceEnabled(applicationContext)) {
            stopSelf()
            return START_NOT_STICKY
        }

        val notification = buildNotification("Faysal IoT Monitor", "Background monitoring & Huawei / FishVoice Voice active")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE,
            )
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }

        _isServiceRunning.value = true

        startStatusPolling()
        startBackgroundVoiceListening()

        return START_STICKY
    }

    private fun startStatusPolling() {
        statusPollJob?.cancel()
        statusPollJob = serviceScope.launch {
            while (isActive) {
                try {
                    val status = api.deviceStatus()
                    _latestStatus.value = status
                    val text = if (status.online) {
                        "Device ONLINE · Output: ${status.state.uppercase()}"
                    } else {
                        "Device OFFLINE · Waiting for device"
                    }
                    updateNotification("Faysal IoT Monitor", text)
                } catch (_: Exception) {
                    updateNotification("Faysal IoT Monitor", "Connecting to Vercel cloud...")
                }
                delay(30_000)
            }
        }
    }

    private fun startBackgroundVoiceListening() {
        if (!IoTSettings.isWakeWordEnabled(applicationContext)) return

        mainHandler.post {
            createOrResetSpeechRecognizer()
            if (speechRecognizer != null) {
                listenLoop()
            } else {
                startAudioRecordFallback()
            }
        }
    }

    private fun getHuaweiVoicePackage(): String? {
        val candidates = listOf(
            "com.huawei.hiassistantoversea",
            "com.huawei.hiai",
            "com.huawei.vassistant",
            "com.huawei.intelligent",
        )
        return candidates.firstOrNull { pkg ->
            runCatching { applicationContext.packageManager.getPackageInfo(pkg, 0) }.isSuccess
        }
    }

    private fun startAudioRecordFallback() {
        audioRecordDetector?.stop()
        audioRecordDetector = AudioRecordVoiceDetector {
            mainHandler.post {
                if (assistantState == STATE_IDLE) {
                    assistantState = STATE_AWAITING_COMMAND
                    val lang = IoTSettings.getVoiceLanguage(applicationContext)
                    val greeting = VoiceAssistantManager.getGreetingText(lang)
                    updateNotification("Huawei / FishVoice Assistant", greeting)
                    voiceAssistant?.speak(greeting)
                }
            }
        }
        audioRecordDetector?.start()
    }

    private fun createOrResetSpeechRecognizer() {
        runCatching {
            speechRecognizer?.destroy()
        }
        speechRecognizer = null

        val hwPackage = getHuaweiVoicePackage()
        if (hwPackage != null) {
            runCatching {
                speechRecognizer = SpeechRecognizer.createSpeechRecognizer(
                    applicationContext,
                    ComponentName(hwPackage, "$hwPackage.SpeechRecognitionService"),
                )
            }.getOrNull()
        }

        if (speechRecognizer == null && SpeechRecognizer.isRecognitionAvailable(applicationContext)) {
            runCatching {
                speechRecognizer = SpeechRecognizer.createSpeechRecognizer(applicationContext)
            }.getOrNull()
        }

        speechRecognizer?.setRecognitionListener(object : RecognitionListener {
            override fun onReadyForSpeech(params: Bundle?) {
                isListening = true
            }
            override fun onBeginningOfSpeech() = Unit
            override fun onRmsChanged(rmsdB: Float) = Unit
            override fun onBufferReceived(buffer: ByteArray?) = Unit
            override fun onEndOfSpeech() {
                isListening = false
            }
            override fun onPartialResults(partialResults: Bundle?) = Unit
            override fun onEvent(eventType: Int, params: Bundle?) = Unit

            override fun onError(error: Int) {
                isListening = false
                scheduleNextListen(1000)
            }

            override fun onResults(results: Bundle?) {
                isListening = false
                val matches = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                val spoken = matches?.firstOrNull().orEmpty()
                handleBackgroundSpeech(spoken)
            }
        })
    }

    private fun listenLoop() {
        if (!IoTSettings.isWakeWordEnabled(applicationContext)) return
        if (speechRecognizer == null) {
            createOrResetSpeechRecognizer()
        }
        val recognizer = speechRecognizer ?: run {
            startAudioRecordFallback()
            return
        }

        val lang = IoTSettings.getVoiceLanguage(applicationContext)
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang)
            putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 3)
            getHuaweiVoicePackage()?.let { setPackage(it) }
        }
        try {
            isListening = true
            recognizer.startListening(intent)
        } catch (_: Exception) {
            isListening = false
            startAudioRecordFallback()
        }
    }

    private fun scheduleNextListen(delayMs: Long) {
        mainHandler.removeCallbacksAndMessages(null)
        mainHandler.postDelayed({ listenLoop() }, delayMs)
    }

    private fun handleBackgroundSpeech(spoken: String) {
        if (spoken.isBlank()) {
            scheduleNextListen(800)
            return
        }

        val lang = IoTSettings.getVoiceLanguage(applicationContext)
        voiceAssistant?.setLanguage(lang)

        when (assistantState) {
            STATE_IDLE -> {
                val hasWakeWord = VoiceAssistantManager.isWakeWord(spoken)
                val intent = VoiceAssistantManager.parseAssistantIntent(spoken)

                if (hasWakeWord && intent != null) {
                    pendingAction = intent.first
                    pendingTarget = intent.second
                    assistantState = STATE_AWAITING_CONFIRMATION
                    val prompt = VoiceAssistantManager.getConfirmationPromptText(intent.first, intent.second, lang)
                    updateNotification("FishVoice Voice Assistant", prompt)
                    voiceAssistant?.speak(prompt) {
                        scheduleNextListen(500)
                    }
                } else if (hasWakeWord) {
                    assistantState = STATE_AWAITING_COMMAND
                    val greeting = VoiceAssistantManager.getGreetingText(lang)
                    updateNotification("FishVoice Voice Assistant", greeting)
                    voiceAssistant?.speak(greeting) {
                        scheduleNextListen(500)
                    }
                } else if (intent != null) {
                    pendingAction = intent.first
                    pendingTarget = intent.second
                    assistantState = STATE_AWAITING_CONFIRMATION
                    val prompt = VoiceAssistantManager.getConfirmationPromptText(intent.first, intent.second, lang)
                    updateNotification("FishVoice Voice Assistant", prompt)
                    voiceAssistant?.speak(prompt) {
                        scheduleNextListen(500)
                    }
                } else {
                    scheduleNextListen(800)
                }
            }

            STATE_AWAITING_COMMAND -> {
                val intent = VoiceAssistantManager.parseAssistantIntent(spoken)
                if (intent != null) {
                    pendingAction = intent.first
                    pendingTarget = intent.second
                    assistantState = STATE_AWAITING_CONFIRMATION
                    val prompt = VoiceAssistantManager.getConfirmationPromptText(intent.first, intent.second, lang)
                    updateNotification("FishVoice Voice Assistant", prompt)
                    voiceAssistant?.speak(prompt) {
                        scheduleNextListen(500)
                    }
                } else {
                    val fallbackAction = parseVoiceCommand(spoken)
                    if (fallbackAction != null) {
                        pendingAction = fallbackAction
                        pendingTarget = "Device Output"
                        assistantState = STATE_AWAITING_CONFIRMATION
                        val prompt = VoiceAssistantManager.getConfirmationPromptText(fallbackAction, "Device Output", lang)
                        updateNotification("FishVoice Voice Assistant", prompt)
                        voiceAssistant?.speak(prompt) {
                            scheduleNextListen(500)
                        }
                    } else {
                        assistantState = STATE_IDLE
                        scheduleNextListen(800)
                    }
                }
            }

            STATE_AWAITING_CONFIRMATION -> {
                when (VoiceAssistantManager.parseConfirmation(spoken)) {
                    true -> {
                        val action = pendingAction
                        val target = pendingTarget
                        assistantState = STATE_IDLE
                        pendingAction = null
                        if (action != null) {
                            serviceScope.launch {
                                try {
                                    api.setDeviceState(action)
                                    val successMsg = VoiceAssistantManager.getSuccessResultText(action, target, lang)
                                    updateNotification("Faysal IoT", successMsg)
                                    mainHandler.post {
                                        voiceAssistant?.speak(successMsg) {
                                            scheduleNextListen(1000)
                                        }
                                    }
                                } catch (_: Exception) {
                                    updateNotification("Faysal IoT", "Command execution failed.")
                                    scheduleNextListen(1000)
                                }
                            }
                        } else {
                            scheduleNextListen(800)
                        }
                    }
                    false -> {
                        assistantState = STATE_IDLE
                        pendingAction = null
                        val cancelMsg = VoiceAssistantManager.getCancelResultText(lang)
                        updateNotification("FishVoice Voice Assistant", cancelMsg)
                        voiceAssistant?.speak(cancelMsg) {
                            scheduleNextListen(1000)
                        }
                    }
                    null -> {
                        assistantState = STATE_IDLE
                        pendingAction = null
                        scheduleNextListen(800)
                    }
                }
            }
        }
    }

    override fun onDestroy() {
        statusPollJob?.cancel()
        mainHandler.removeCallbacksAndMessages(null)
        audioRecordDetector?.stop()
        audioRecordDetector = null
        runCatching { speechRecognizer?.destroy() }
        speechRecognizer = null
        voiceAssistant?.destroy()
        voiceAssistant = null
        super.onDestroy()
        serviceScope.cancel()
        _isServiceRunning.value = false
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Faysal IoT Service",
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = "Background device monitoring service & hands-free FishVoice assistant"
            }
            val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            manager.createNotificationChannel(channel)
        }
    }

    private fun buildNotification(title: String, contentText: String): Notification {
        val intent = Intent(this, MainActivity::class.java)
        val pendingIntent = PendingIntent.getActivity(
            this,
            0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(contentText)
            .setSmallIcon(R.drawable.fishvoice)
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    private fun updateNotification(title: String, contentText: String) {
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.notify(NOTIFICATION_ID, buildNotification(title, contentText))
    }

    companion object {
        const val CHANNEL_ID = "faysal_iot_background_channel"
        const val NOTIFICATION_ID = 2001

        private const val STATE_IDLE = 0
        private const val STATE_AWAITING_COMMAND = 1
        private const val STATE_AWAITING_CONFIRMATION = 2

        private val _isServiceRunning = MutableStateFlow(false)
        val isServiceRunning: StateFlow<Boolean> = _isServiceRunning.asStateFlow()

        private val _latestStatus = MutableStateFlow<DeviceStatus?>(null)
        val latestStatus: StateFlow<DeviceStatus?> = _latestStatus.asStateFlow()

        fun start(context: Context) {
            if (!IoTSettings.isBackgroundServiceEnabled(context)) return
            val intent = Intent(context, IoTBackgroundService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stop(context: Context) {
            val intent = Intent(context, IoTBackgroundService::class.java)
            context.stopService(intent)
        }
    }
}

class AudioRecordVoiceDetector(
    private val onVoiceDetected: () -> Unit,
) {
    private var isRecording = false
    private var audioRecord: AudioRecord? = null
    private var thread: Thread? = null
    private var lastTriggerTime = 0L

    fun start() {
        if (isRecording) return
        val sampleRate = 16000
        val channelConfig = AudioFormat.CHANNEL_IN_MONO
        val audioFormat = AudioFormat.ENCODING_PCM_16BIT
        val minBufferSize = AudioRecord.getMinBufferSize(sampleRate, channelConfig, audioFormat)
        val bufferSize = maxOf(minBufferSize, 4096)

        try {
            audioRecord = AudioRecord(
                MediaRecorder.AudioSource.MIC,
                sampleRate,
                channelConfig,
                audioFormat,
                bufferSize,
            )
            if (audioRecord?.state != AudioRecord.STATE_INITIALIZED) {
                return
            }
            audioRecord?.startRecording()
            isRecording = true
            thread = Thread {
                val buffer = ShortArray(1024)
                while (isRecording) {
                    val read = audioRecord?.read(buffer, 0, buffer.size) ?: 0
                    if (read > 0) {
                        var sum = 0.0
                        for (i in 0 until read) {
                            sum += buffer[i] * buffer[i]
                        }
                        val rms = Math.sqrt(sum / read)
                        val now = System.currentTimeMillis()
                        if (rms > 2800 && now - lastTriggerTime > 5000) {
                            lastTriggerTime = now
                            onVoiceDetected()
                        }
                    }
                }
            }.apply { start() }
        } catch (_: Exception) {
            isRecording = false
        }
    }

    fun stop() {
        isRecording = false
        thread?.interrupt()
        thread = null
        try {
            audioRecord?.stop()
            audioRecord?.release()
        } catch (_: Exception) {}
        audioRecord = null
    }
}
