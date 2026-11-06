package com.faysaliot.control.universal

import android.Manifest
import android.content.Intent
import android.os.Bundle
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Divider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.text.DateFormat
import java.util.Date
import java.util.Locale

private val Navy = Color(0xFF071229)
private val Panel = Color(0xFF11203E)
private val PanelBorder = Color(0xFF293C62)
private val Blue = Color(0xFF35A4FF)
private val Green = Color(0xFF06D98C)
private val Muted = Color(0xFF9BACC8)
private val TextPrimary = Color(0xFFF1F5FF)
private val ErrorRed = Color(0xFFFF8585)
private val DarkColors = darkColorScheme(
    primary = Blue,
    secondary = Green,
    background = Navy,
    surface = Panel,
    onPrimary = Color.White,
    onBackground = TextPrimary,
    onSurface = TextPrimary,
)

class MainActivity : ComponentActivity() {
    private val autoStartVoice = mutableStateOf(false)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val api = IoTApi(applicationContext)
        checkVoiceIntent(intent)
        setContent {
            MaterialTheme(colorScheme = DarkColors) {
                Surface(modifier = Modifier.fillMaxSize(), color = Navy) {
                    FaysalApp(api, autoStartVoice.value) { autoStartVoice.value = false }
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        checkVoiceIntent(intent)
    }

    private fun checkVoiceIntent(intent: Intent?) {
        if (intent?.getBooleanExtra("EXTRA_START_VOICE", false) == true) {
            autoStartVoice.value = true
        }
    }
}

@Composable
private fun FaysalApp(api: IoTApi, autoStartVoice: Boolean = false, onVoiceConsumed: () -> Unit = {}) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var signedIn by remember { mutableStateOf(false) }
    var checkingSession by remember { mutableStateOf(true) }
    var username by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var loginError by remember { mutableStateOf("") }
    var deviceError by remember { mutableStateOf("") }
    var activityError by remember { mutableStateOf("") }
    var status by remember { mutableStateOf<DeviceStatus?>(null) }
    val activity = remember { mutableStateListOf<ActivityEntry>() }
    var activityCursor by remember { mutableStateOf<String?>(null) }
    var showAllActivity by remember { mutableStateOf(false) }
    var loadingOlder by remember { mutableStateOf(false) }
    var months by remember { mutableStateOf<List<RuntimeMonth>>(emptyList()) }
    var runtimeError by remember { mutableStateOf("") }

    var backgroundServiceEnabled by remember { mutableStateOf(IoTSettings.isBackgroundServiceEnabled(context)) }
    var wakeWordEnabled by remember { mutableStateOf(IoTSettings.isWakeWordEnabled(context)) }
    var voiceLanguage by remember { mutableStateOf(IoTSettings.getVoiceLanguage(context)) }
    var preferredTransport by remember { mutableStateOf(IoTSettings.getPreferredTransport(context)) }
    var localDeviceIp by remember { mutableStateOf(IoTSettings.getLocalDeviceIp(context)) }
    var voiceMessage by remember { mutableStateOf("") }

    var pendingVoiceAction by remember { mutableStateOf<String?>(null) }
    var pendingVoiceTarget by remember { mutableStateOf("Device Output") }

    val voiceAssistant = remember(voiceLanguage) { VoiceAssistantManager(context, voiceLanguage) }
    DisposableEffect(voiceAssistant) {
        onDispose { voiceAssistant.destroy() }
    }

    suspend fun refreshStatus() {
        try {
            status = api.smartDeviceStatus()
            deviceError = ""
            status?.activityWarning?.let { activityError = it }
        } catch (error: Exception) {
            deviceError = error.message ?: "Could not load device status."
            if (error is ApiException && error.statusCode == 401) signedIn = false
        }
    }

    suspend fun refreshActivity() {
        try {
            val page = api.activities()
            activity.clear()
            activity.addAll(page.entries)
            activityCursor = page.nextCursor
            activityError = ""
        } catch (error: Exception) {
            activityError = error.message ?: "Could not load activity history."
        }
    }

    suspend fun refreshRuntime() {
        try {
            months = api.runtime()
            runtimeError = ""
        } catch (error: Exception) {
            runtimeError = error.message ?: "Could not load runtime history."
        }
    }

    suspend fun performCommand(action: String, target: String = "Device Output") {
        busy = true
        deviceError = ""
        try {
            val warning = api.smartSetDeviceState(action)
            status = api.smartDeviceStatus()
            runCatching {
                val page = api.activities()
                activity.clear()
                activity.addAll(page.entries)
                activityCursor = page.nextCursor
            }
            activityError = warning ?: status?.activityWarning.orEmpty()
            val resultMsg = VoiceAssistantManager.getSuccessResultText(action, target, voiceLanguage)
            voiceMessage = resultMsg
            voiceAssistant.speak(resultMsg)
        } catch (error: Exception) {
            if (error is ApiException && error.statusCode == 401) {
                signedIn = false
            } else {
                deviceError = error.message ?: "Device command failed."
            }
        } finally {
            busy = false
        }
    }

    LaunchedEffect(Unit) {
        try {
            username = api.currentUser()
            signedIn = true
        } catch (_: Exception) {
            signedIn = false
        } finally {
            checkingSession = false
        }
    }

    LaunchedEffect(signedIn) {
        if (!signedIn) return@LaunchedEffect
        while (true) {
            refreshStatus()
            refreshActivity()
            refreshRuntime()
            delay(15_000)
        }
    }

    if (checkingSession) {
        LoadingScreen()
    } else if (!signedIn) {
        LoginScreen(
            username = username,
            password = password,
            busy = busy,
            error = loginError,
            onUsernameChange = { username = it },
            onPasswordChange = { password = it },
            onSignIn = {
                scope.launch {
                    busy = true
                    loginError = ""
                    try {
                        val result = api.signIn(username.trim(), password)
                        username = result.first
                        password = ""
                        signedIn = true
                        result.second?.let { activityError = it }
                    } catch (error: Exception) {
                        loginError = error.message ?: "Sign in failed."
                    } finally {
                        busy = false
                    }
                }
            },
        )
    } else {
        DashboardScreen(
            username = username,
            status = status,
            activity = activity,
            activityCursor = activityCursor,
            showAllActivity = showAllActivity,
            loadingOlder = loadingOlder,
            months = months,
            busy = busy,
            deviceError = deviceError,
            activityError = activityError,
            runtimeError = runtimeError,
            backgroundServiceEnabled = backgroundServiceEnabled,
            wakeWordEnabled = wakeWordEnabled,
            preferredTransport = preferredTransport,
            localDeviceIp = localDeviceIp,
            onToggleBackgroundService = { enabled ->
                backgroundServiceEnabled = enabled
                IoTSettings.setBackgroundServiceEnabled(context, enabled)
                if (enabled) {
                    IoTBackgroundService.start(context)
                } else {
                    IoTBackgroundService.stop(context)
                }
            },
            onToggleWakeWord = { enabled ->
                wakeWordEnabled = enabled
                IoTSettings.setWakeWordEnabled(context, enabled)
            },
            onTransportChange = { mode ->
                preferredTransport = mode
                IoTSettings.setPreferredTransport(context, mode)
                scope.launch { refreshStatus() }
            },
            onLocalIpChange = { ip ->
                localDeviceIp = ip
                IoTSettings.setLocalDeviceIp(context, ip)
            },
            voiceMessage = voiceMessage,
            voiceLanguage = voiceLanguage,
            onVoiceLanguageChange = { lang ->
                voiceLanguage = lang
                IoTSettings.setVoiceLanguage(context, lang)
                voiceAssistant.setLanguage(lang)
            },
            onVoiceResult = { recognized ->
                voiceMessage = recognized
                if (wakeWordEnabled && VoiceAssistantManager.isWakeWord(recognized)) {
                    val greeting = VoiceAssistantManager.getGreetingText(voiceLanguage)
                    voiceMessage = greeting
                    voiceAssistant.speak(greeting)
                } else {
                    val assistantIntent = VoiceAssistantManager.parseAssistantIntent(recognized)
                    if (assistantIntent != null) {
                        pendingVoiceAction = assistantIntent.first
                        pendingVoiceTarget = assistantIntent.second
                        val prompt = VoiceAssistantManager.getConfirmationPromptText(
                            assistantIntent.first,
                            assistantIntent.second,
                            voiceLanguage,
                        )
                        voiceMessage = prompt
                        voiceAssistant.speak(prompt)
                    } else if (pendingVoiceAction != null) {
                        when (VoiceAssistantManager.parseConfirmation(recognized)) {
                            true -> {
                                val action = pendingVoiceAction!!
                                val target = pendingVoiceTarget
                                pendingVoiceAction = null
                                scope.launch { performCommand(action, target) }
                            }
                            false -> {
                                pendingVoiceAction = null
                                val cancelMsg = VoiceAssistantManager.getCancelResultText(voiceLanguage)
                                voiceMessage = cancelMsg
                                voiceAssistant.speak(cancelMsg)
                            }
                            null -> {
                                when (val action = parseVoiceCommand(recognized)) {
                                    "on", "off" -> {
                                        pendingVoiceAction = action
                                        pendingVoiceTarget = "Device Output"
                                        val prompt = VoiceAssistantManager.getConfirmationPromptText(
                                            action,
                                            "Device Output",
                                            voiceLanguage,
                                        )
                                        voiceMessage = prompt
                                        voiceAssistant.speak(prompt)
                                    }
                                    else -> {
                                        voiceMessage = if (voiceLanguage == "bn-BD") {
                                            "কমান্ড বোঝা যায়নি। 'হে জয়', 'মোটর ১ चालू করো' বা 'রিলে বন্ধ করো' বলুন।"
                                        } else {
                                            "Command not recognized. Try 'Hey Joy', 'Turn on motor 1', or 'Turn off relay'."
                                        }
                                    }
                                }
                            }
                        }
                    } else {
                        when (val action = parseVoiceCommand(recognized)) {
                            "on", "off" -> {
                                pendingVoiceAction = action
                                pendingVoiceTarget = "Device Output"
                                val prompt = VoiceAssistantManager.getConfirmationPromptText(
                                    action,
                                    "Device Output",
                                    voiceLanguage,
                                )
                                voiceMessage = prompt
                                voiceAssistant.speak(prompt)
                            }
                            else -> {
                                voiceMessage = if (voiceLanguage == "bn-BD") {
                                    "কমান্ড বোঝা যায়নি। 'হে জয়', 'মোটর ১ चालू করো' বা 'রিলে বন্ধ করো' বলুন।"
                                } else {
                                    "Command not recognized. Try 'Hey Joy', 'Turn on motor 1', or 'Turn off relay'."
                                }
                            }
                        }
                    }
                }
            },
            onDeviceAction = { action ->
                scope.launch { performCommand(action) }
            },
            onLoadOlder = {
                val cursor = activityCursor
                if (cursor != null && !loadingOlder) {
                    scope.launch {
                        loadingOlder = true
                        try {
                            val page = api.activities(cursor)
                            activity.addAll(page.entries)
                            activityCursor = page.nextCursor
                        } catch (error: Exception) {
                            activityError = error.message ?: "Could not load older activity."
                        } finally {
                            loadingOlder = false
                        }
                    }
                }
            },
            onToggleActivity = { showAllActivity = !showAllActivity },
            onRefresh = {
                scope.launch {
                    refreshStatus()
                    refreshActivity()
                    refreshRuntime()
                }
            },
            onSignOut = {
                scope.launch {
                    busy = true
                    try {
                        api.signOut()
                        signedIn = false
                        status = null
                        activity.clear()
                        months = emptyList()
                    } catch (error: Exception) {
                        deviceError = error.message ?: "Sign out failed."
                    } finally {
                        busy = false
                    }
                }
            },
            pendingVoiceAction = pendingVoiceAction,
            pendingVoiceTarget = pendingVoiceTarget,
            onConfirmPendingVoice = {
                pendingVoiceAction?.let { action ->
                    val target = pendingVoiceTarget
                    pendingVoiceAction = null
                    scope.launch { performCommand(action, target) }
                }
            },
            onDismissPendingVoice = {
                pendingVoiceAction = null
                val cancelMsg = VoiceAssistantManager.getCancelResultText(voiceLanguage)
                voiceMessage = cancelMsg
                voiceAssistant.speak(cancelMsg)
            },
        )
    }
}

@Composable
private fun LoadingScreen() {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        CircularProgressIndicator(color = Blue)
    }
}

@Composable
private fun LoginScreen(
    username: String,
    password: String,
    busy: Boolean,
    error: String,
    onUsernameChange: (String) -> Unit,
    onPasswordChange: (String) -> Unit,
    onSignIn: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 24.dp),
        verticalArrangement = Arrangement.Center,
    ) {
        Text("F", color = Blue, fontSize = 42.sp, fontWeight = FontWeight.Black)
        Text("Faysal IoT", fontSize = 28.sp, fontWeight = FontWeight.Bold)
        Text("Secure device control", color = Muted)
        Spacer(Modifier.height(24.dp))
        OutlinedTextField(
            value = username,
            onValueChange = onUsernameChange,
            modifier = Modifier.fillMaxWidth(),
            label = { Text("Username") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(
                capitalization = KeyboardCapitalization.None,
                autoCorrectEnabled = false,
                keyboardType = KeyboardType.Email,
                imeAction = ImeAction.Next,
            ),
        )
        Spacer(Modifier.height(12.dp))
        OutlinedTextField(
            value = password,
            onValueChange = onPasswordChange,
            modifier = Modifier.fillMaxWidth(),
            label = { Text("Password") },
            visualTransformation = PasswordVisualTransformation(),
            singleLine = true,
            keyboardOptions = KeyboardOptions(
                keyboardType = KeyboardType.Password,
                imeAction = ImeAction.Done,
            ),
        )
        if (error.isNotBlank()) {
            Spacer(Modifier.height(8.dp))
            Text(error, color = ErrorRed, fontSize = 14.sp)
        }
        Spacer(Modifier.height(18.dp))
        Button(
            onClick = onSignIn,
            modifier = Modifier.fillMaxWidth().height(52.dp),
            enabled = !busy && username.isNotBlank() && password.isNotBlank(),
            shape = RoundedCornerShape(14.dp),
        ) {
            if (busy) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
            else Text("Sign in")
        }
    }
}

@Composable
private fun DashboardScreen(
    username: String,
    status: DeviceStatus?,
    activity: List<ActivityEntry>,
    activityCursor: String?,
    showAllActivity: Boolean,
    loadingOlder: Boolean,
    months: List<RuntimeMonth>,
    busy: Boolean,
    deviceError: String,
    activityError: String,
    runtimeError: String,
    backgroundServiceEnabled: Boolean,
    wakeWordEnabled: Boolean,
    preferredTransport: String,
    localDeviceIp: String,
    onToggleBackgroundService: (Boolean) -> Unit,
    onToggleWakeWord: (Boolean) -> Unit,
    onTransportChange: (String) -> Unit,
    onLocalIpChange: (String) -> Unit,
    voiceMessage: String,
    voiceLanguage: String,
    onVoiceLanguageChange: (String) -> Unit,
    onVoiceResult: (String) -> Unit,
    onDeviceAction: (String) -> Unit,
    onLoadOlder: () -> Unit,
    onToggleActivity: () -> Unit,
    onRefresh: () -> Unit,
    onSignOut: () -> Unit,
    pendingVoiceAction: String?,
    pendingVoiceTarget: String,
    onConfirmPendingVoice: () -> Unit,
    onDismissPendingVoice: () -> Unit,
) {
    val context = LocalContext.current
    var listening by remember { mutableStateOf(false) }
    var voiceError by remember { mutableStateOf("") }
    var manualVoiceText by remember { mutableStateOf("") }
    val onVoiceResultLatest by rememberUpdatedState(onVoiceResult)

    val speechIntentLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) { result ->
        listening = false
        if (result.resultCode == android.app.Activity.RESULT_OK) {
            val matches = result.data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)
            val spoken = matches?.firstOrNull()
            if (!spoken.isNullOrBlank()) {
                onVoiceResultLatest(spoken)
            } else {
                voiceError = "No speech detected. Please try again."
            }
        }
    }

    val microphonePermission = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        if (granted) {
            voiceError = ""
            val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                putExtra(RecognizerIntent.EXTRA_LANGUAGE, voiceLanguage)
                putExtra(RecognizerIntent.EXTRA_PROMPT, if (voiceLanguage == "bn-BD") "হে জয় বলুন বা কমান্ড দিন" else "Say Hey Joy or turn on motor")
            }
            try {
                speechIntentLauncher.launch(intent)
                listening = true
            } catch (_: Exception) {
                listening = false
                voiceError = "Speech recognition dialog failed. You can type or use keyboard dictation below."
            }
        } else {
            voiceError = "Microphone permission is needed for voice commands."
        }
    }

    val notificationPermission = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { _ -> }

    Scaffold(containerColor = Navy) { insets ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(insets)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 16.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text("Faysal IoT", fontWeight = FontWeight.Bold, fontSize = 20.sp)
                    Text(
                        "Welcome, $username",
                        color = Muted,
                        fontSize = 12.sp,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    TextButton(onClick = onRefresh, enabled = !busy) { Text("Refresh") }
                    TextButton(onClick = onSignOut, enabled = !busy) { Text("Sign out") }
                }
            }

            SummaryCard(
                title = "Connection",
                value = if (status?.online == true) "Online" else "Offline",
                detail = when (status?.transport) {
                    "local_lan" -> "Direct Local LAN (${status.ip})"
                    "soft_ap" -> "Emergency SoftAP (${status.ip})"
                    else -> if (status?.online == true) "Cloud MQTTS (${status.ip})" else "Waiting for device"
                },
                accent = if (status?.online == true) Green else ErrorRed,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                SummaryCard(
                    title = "Output",
                    value = status?.state?.uppercase() ?: "UNKNOWN",
                    detail = "GPIO4 · relay not connected",
                    accent = Blue,
                    modifier = Modifier.weight(1f),
                )
                SummaryCard(
                    title = "Uptime",
                    value = formatUptime(status?.uptime),
                    detail = "Since device restart",
                    accent = Color(0xFFB7A0FF),
                    modifier = Modifier.weight(1f),
                )
            }

            Panel(title = "Relay control") {
                Text("Choose an action. The device starts OFF after restart.", color = Muted, fontSize = 13.sp)
                Spacer(Modifier.height(14.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Button(
                        onClick = { onDeviceAction("on") },
                        modifier = Modifier.weight(1f),
                        enabled = status?.online == true && !busy,
                        colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF00B96B)),
                    ) { Text("⏻  Turn ON") }
                    OutlinedButton(
                        onClick = { onDeviceAction("off") },
                        modifier = Modifier.weight(1f),
                        enabled = status?.online == true && !busy,
                    ) { Text("⏻  Turn OFF") }
                }
                if (status?.lastSeen != null) {
                    Spacer(Modifier.height(10.dp))
                    Text("Last update ${formatDate(status.lastSeen)}", color = Muted, fontSize = 12.sp)
                }
            }

            Panel(title = "App & Background Settings") {
                Text(
                    "Network transport, background service & Joy Voice Assistant",
                    color = Muted,
                    fontSize = 13.sp,
                )
                Spacer(Modifier.height(10.dp))
                Text("Transport Mode", fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
                Spacer(Modifier.height(4.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    TransportButton("Auto Smart", preferredTransport == "auto") { onTransportChange("auto") }
                    TransportButton("Cloud MQTTS", preferredTransport == "cloud") { onTransportChange("cloud") }
                    TransportButton("Local Direct", preferredTransport == "local") { onTransportChange("local") }
                }
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = localDeviceIp,
                    onValueChange = onLocalIpChange,
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text("Local Device IP / SoftAP") },
                    singleLine = true,
                )
                Spacer(Modifier.height(12.dp))
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text("Background Device Service", fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
                        Text(
                            "Runs in background and on boot like location_tracker",
                            color = Muted,
                            fontSize = 11.sp,
                        )
                    }
                    Switch(
                        checked = backgroundServiceEnabled,
                        onCheckedChange = { enabled ->
                            onToggleBackgroundService(enabled)
                            if (enabled && android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU) {
                                notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
                            }
                        },
                    )
                }
                Spacer(Modifier.height(8.dp))
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text("Joy Wake Word (\"Hey Joy\" / \"হে জয়\")", fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
                        Text(
                            "Activates voice greeting (\"Yes Faysal\") & command confirmation",
                            color = Muted,
                            fontSize = 11.sp,
                        )
                    }
                    Switch(
                        checked = wakeWordEnabled,
                        onCheckedChange = onToggleWakeWord,
                    )
                }
            }

            Panel(title = "Voice control") {
                Text("Push to talk · confirm before sending a command", color = Muted, fontSize = 13.sp)
                Spacer(Modifier.height(10.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    LanguageButton("বাংলা", voiceLanguage == "bn-BD") { onVoiceLanguageChange("bn-BD") }
                    LanguageButton("English", voiceLanguage == "en-US") { onVoiceLanguageChange("en-US") }
                }
                Spacer(Modifier.height(8.dp))
                Button(
                    onClick = {
                        voiceError = ""
                        microphonePermission.launch(Manifest.permission.RECORD_AUDIO)
                    },
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(if (listening) "Listening…" else "🎙  Speak a command")
                }
                Spacer(Modifier.height(8.dp))
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    OutlinedTextField(
                        value = manualVoiceText,
                        onValueChange = { manualVoiceText = it },
                        modifier = Modifier.weight(1f),
                        placeholder = { Text(if (voiceLanguage == "bn-BD") "কমান্ড টাইপ করুন (যেমন: হে জয়, মোটর ১ चालू করো)" else "Type command (e.g. Hey Joy, turn on motor 1)") },
                        singleLine = true,
                    )
                    Button(
                        onClick = {
                            if (manualVoiceText.isNotBlank()) {
                                val text = manualVoiceText
                                manualVoiceText = ""
                                onVoiceResult(text)
                            }
                        },
                        enabled = manualVoiceText.isNotBlank(),
                    ) {
                        Text("Send")
                    }
                }
                if (voiceMessage.isNotBlank()) {
                    Spacer(Modifier.height(6.dp))
                    Text(voiceMessage, color = Blue, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                }
                if (voiceError.isNotBlank()) {
                    Spacer(Modifier.height(6.dp))
                    Text(voiceError, color = ErrorRed, fontSize = 13.sp)
                }
                Spacer(Modifier.height(4.dp))
                Text(
                    "Voice is processed by your device's speech-recognition provider, which may use the internet. No audio is stored by this app.",
                    color = Muted,
                    fontSize = 11.sp,
                )
            }

            if (deviceError.isNotBlank()) MessageText(deviceError)
            if (activityError.isNotBlank()) MessageText(activityError)

            Panel(title = "Activity") {
                activity.take(if (showAllActivity) activity.size else 5).forEach { entry ->
                    ActivityRow(entry)
                }
                if (activity.isEmpty()) Text("No activity recorded yet.", color = Muted, fontSize = 13.sp)
                if (activity.size > 5 || activityCursor != null) {
                    TextButton(onClick = onToggleActivity) {
                        Text(if (showAllActivity) "Show recent" else "See all")
                    }
                }
                if (showAllActivity && activityCursor != null) {
                    TextButton(onClick = onLoadOlder, enabled = !loadingOlder) {
                        Text(if (loadingOlder) "Loading…" else "Load older")
                    }
                }
            }

            Panel(title = "Monthly uptime") {
                Text(
                    "Cumulative online and relay-ON time by day",
                    color = Muted,
                    fontSize = 13.sp,
                )
                if (runtimeError.isNotBlank()) MessageText(runtimeError)
                months.forEach { month ->
                    Spacer(Modifier.height(12.dp))
                    RuntimeChart(month)
                }
                Spacer(Modifier.height(8.dp))
                Text(
                    "Measured from successful status checks. Runtime tracking requires an active monitor.",
                    color = Muted,
                    fontSize = 11.sp,
                )
            }
            Spacer(Modifier.height(12.dp))
        }
    }

    if (pendingVoiceAction != null) {
        AlertDialog(
            onDismissRequest = onDismissPendingVoice,
            title = { Text("Confirm voice command") },
            text = {
                Text(
                    if (pendingVoiceAction == "on") {
                        "The app heard a request to turn the device ON. Send this command?"
                    } else {
                        "The app heard a request to turn the device OFF. Send this command?"
                    },
                )
            },
            confirmButton = {
                TextButton(onClick = onConfirmPendingVoice, enabled = status?.online == true) {
                    Text("Confirm")
                }
            },
            dismissButton = { TextButton(onClick = onDismissPendingVoice) { Text("Cancel") } },
        )
    }
}

@Composable
private fun SummaryCard(
    title: String,
    value: String,
    detail: String,
    accent: Color,
    modifier: Modifier = Modifier,
) {
    Card(
        modifier = modifier,
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(containerColor = Panel),
        border = androidx.compose.foundation.BorderStroke(1.dp, PanelBorder),
    ) {
        Column(
            modifier = Modifier.fillMaxWidth().padding(15.dp),
            verticalArrangement = Arrangement.spacedBy(5.dp),
        ) {
            Text(title, color = Muted, fontSize = 12.sp)
            Text(value, color = accent, fontSize = 18.sp, fontWeight = FontWeight.Bold)
            Text(detail, color = Muted, fontSize = 11.sp)
        }
    }
}

@Composable
private fun Panel(title: String, content: @Composable () -> Unit) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(containerColor = Panel),
        border = androidx.compose.foundation.BorderStroke(1.dp, PanelBorder),
    ) {
        Column(Modifier.fillMaxWidth().padding(16.dp)) {
            Text(title, fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.height(10.dp))
            content()
        }
    }
}

@Composable
private fun LanguageButton(label: String, selected: Boolean, onClick: () -> Unit) {
    if (selected) {
        Button(onClick = onClick) { Text(label) }
    } else {
        OutlinedButton(onClick = onClick) { Text(label) }
    }
}

@Composable
private fun ActivityRow(entry: ActivityEntry) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Box(
            Modifier.padding(top = 5.dp).size(8.dp).background(Blue, CircleShape),
        )
        Spacer(Modifier.width(9.dp))
        Column {
            Text(entry.message, fontSize = 13.sp)
            Text(formatDate(entry.createdAt), color = Muted, fontSize = 11.sp)
        }
    }
}

@Composable
private fun RuntimeChart(month: RuntimeMonth) {
    val onlineTotal = month.days.sumOf { it.onlineSeconds.toLong() }
    val relayTotal = month.days.sumOf { it.relayOnSeconds.toLong() }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(month.label, fontWeight = FontWeight.SemiBold)
        Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            Text("● Online ${formatUptime(onlineTotal)}", color = Blue, fontSize = 12.sp)
            Text("● Relay ON ${formatUptime(relayTotal)}", color = Green, fontSize = 12.sp)
        }
        val onlineDaily = cumulativeValues(month, relay = false)
        val relayDaily = cumulativeValues(month, relay = true)
        val maxHours = maxOf(1f, onlineDaily.maxOrNull() ?: 0f)
        Canvas(
            modifier = Modifier.fillMaxWidth().height(150.dp),
        ) {
            val left = 34.dp.toPx()
            val right = 8.dp.toPx()
            val top = 8.dp.toPx()
            val bottom = 18.dp.toPx()
            val plotWidth = size.width - left - right
            val plotHeight = size.height - top - bottom
            for (step in 0..2) {
                val fraction = step / 2f
                val lineY = top + plotHeight * (1f - fraction)
                drawLine(Color(0x334A5D80), androidx.compose.ui.geometry.Offset(left, lineY), androidx.compose.ui.geometry.Offset(size.width - right, lineY))
            }
            fun path(values: List<Float>): Path {
                val result = Path()
                values.forEachIndexed { index, value ->
                    val x = left + if (values.size <= 1) 0f else index * plotWidth / (values.size - 1)
                    val y = top + plotHeight * (1f - value / maxHours)
                    if (index == 0) result.moveTo(x, y) else result.lineTo(x, y)
                }
                return result
            }
            if (onlineDaily.isNotEmpty()) {
                drawPath(path(onlineDaily), Blue, style = Stroke(width = 3.dp.toPx(), cap = StrokeCap.Round))
                drawPath(path(relayDaily), Green, style = Stroke(width = 3.dp.toPx(), cap = StrokeCap.Round))
            }
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text("1", color = Muted, fontSize = 10.sp)
            Text("${month.daysInMonth} days", color = Muted, fontSize = 10.sp)
        }
    }
}

private fun cumulativeValues(month: RuntimeMonth, relay: Boolean): List<Float> {
    val byDay = month.days.associateBy { it.day }
    var sum = 0L
    return (1..month.daysInMonth).map { day ->
        if (day <= month.throughDay) {
            val value = byDay[day]
            sum += if (relay) value?.relayOnSeconds ?: 0 else value?.onlineSeconds ?: 0
        }
        sum / 3600f
    }
}

@Composable
private fun MessageText(message: String) {
    Text(message, color = ErrorRed, fontSize = 12.sp)
}

private fun startSpeechRecognition(
    recognizer: SpeechRecognizer?,
    language: String,
    onResult: (String) -> Unit,
    onError: (String) -> Unit,
    onStarted: (Boolean) -> Unit,
) {
    if (recognizer == null) {
        onError("Speech recognition is not available on this device.")
        onStarted(false)
        return
    }
    recognizer.setRecognitionListener(object : android.speech.RecognitionListener {
        override fun onReadyForSpeech(params: Bundle?) = Unit
        override fun onBeginningOfSpeech() = Unit
        override fun onRmsChanged(rmsdB: Float) = Unit
        override fun onBufferReceived(buffer: ByteArray?) = Unit
        override fun onEndOfSpeech() = Unit
        override fun onPartialResults(partialResults: Bundle?) = Unit
        override fun onEvent(eventType: Int, params: Bundle?) = Unit
        override fun onError(error: Int) {
            onError("Voice recognition failed (code $error). You can use the manual controls.")
        }
        override fun onResults(results: Bundle?) {
            val words = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
            val first = words?.firstOrNull()
            if (first.isNullOrBlank()) onError("No voice command was detected.")
            else onResult(first)
        }
    })
    val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
        putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
        putExtra(RecognizerIntent.EXTRA_LANGUAGE, language)
        putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 3)
        putExtra(RecognizerIntent.EXTRA_PROMPT, if (language == "bn-BD") "কমান্ড বলুন" else "Say turn on or turn off")
    }
    try {
        recognizer.startListening(intent)
        onStarted(true)
    } catch (error: RuntimeException) {
        onError("Could not start voice recognition. Try manual control.")
        onStarted(false)
    }
}

internal fun parseVoiceCommand(raw: String): String? {
    val text = raw.lowercase(Locale.ROOT)
        .replace(Regex("[.!?,।]"), " ")
        .trim()
    if (Regex("\\b(no|not|never|don't|do not|cancel)\\b").containsMatchIn(text) ||
        text.contains("না")
    ) return null
    val onPhrases = listOf(
        "turn on", "switch on", "power on", "relay on", "turn the light on",
        "চালু কর", "চালু করুন", "চালু করো", "অন কর", "অন করুন", "অন করো",
        "chalu koro", "chalu korun", "on koro", "on korun",
    )
    val offPhrases = listOf(
        "turn off", "switch off", "power off", "relay off", "turn the light off",
        "বন্ধ কর", "বন্ধ করুন", "বন্ধ করো", "অফ কর", "অফ করুন", "অফ করো",
        "bondho koro", "bondho korun", "off koro", "off korun",
    )
    val on = onPhrases.any(text::contains)
    val off = offPhrases.any(text::contains)
    return when {
        on && !off -> "on"
        off && !on -> "off"
        else -> null
    }
}

private fun formatUptime(seconds: Long?): String {
    if (seconds == null) return "—"
    val days = seconds / 86_400
    val hours = (seconds % 86_400) / 3_600
    val minutes = (seconds % 3_600) / 60
    return if (days > 0) "${days}d ${hours}h ${minutes}m" else "${hours}h ${minutes}m"
}

private fun formatDate(value: String): String = runCatching {
    val date = javax.xml.datatype.DatatypeFactory.newInstance().newXMLGregorianCalendar(value).toGregorianCalendar().time
    DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(date)
}.getOrDefault(value)

@Composable
private fun TransportButton(label: String, selected: Boolean, onClick: () -> Unit) {
    if (selected) {
        Button(onClick = onClick) { Text(label, fontSize = 12.sp) }
    } else {
        OutlinedButton(onClick = onClick) { Text(label, fontSize = 12.sp) }
    }
}
