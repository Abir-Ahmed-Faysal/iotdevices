package com.faysaliot.control.universal

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
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
    private var statusPollJob: Job? = null
    private lateinit var api: IoTApi

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        api = IoTApi(applicationContext)
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (!IoTSettings.isBackgroundServiceEnabled(applicationContext)) {
            stopSelf()
            return START_NOT_STICKY
        }

        val notification = buildNotification("Faysal IoT Monitor", "Checking device status...")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
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
                    updateNotification("Faysal IoT Monitor", "Connecting to cloud...")
                }
                delay(30_000)
            }
        }
    }

    override fun onDestroy() {
        statusPollJob?.cancel()
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
                description = "Background device status monitoring"
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
