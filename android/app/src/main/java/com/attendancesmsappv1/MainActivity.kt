// C:\Attendance\AttendanceSMS\android\app\src\main\java\com\attendancesmsappv1\MainActivity.kt

package com.attendancesmsappv1

import android.app.AlertDialog
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.util.Log
import android.view.WindowManager
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

class MainActivity : ReactActivity() {

    companion object {
        private const val TAG = "MainActivity"
        private const val PREFS_NAME = "onboarding_prefs"
        private const val KEY_SAMSUNG_PROMPT_SHOWN = "samsungBatteryPromptShown"
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        setTheme(R.style.LaunchTheme)
        super.onCreate(savedInstanceState)

        requestIgnoreBatteryOptimizations()
        requestOverlayPermission()
        requestFullScreenIntentPermission()
        requestSamsungBatterySettings()

        // Keep screen on while app is in foreground
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }

    // ── Standard Android battery-optimization exemption ─────────────────────
    private fun requestIgnoreBatteryOptimizations() {
        try {
            val pm = getSystemService(POWER_SERVICE) as PowerManager
            if (!pm.isIgnoringBatteryOptimizations(packageName)) {
                val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
                intent.data = Uri.parse("package:$packageName")
                startActivity(intent)
            }
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    // ── Display-over-other-apps permission ───────────────────────────────────
    private fun requestOverlayPermission() {
        try {
            if (!Settings.canDrawOverlays(this)) {
                val intent = Intent(
                    Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                    Uri.parse("package:$packageName")
                )
                startActivity(intent)
            }
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    // ── Full-screen-intent permission (Android 14+) ──────────────────────────
    private fun requestFullScreenIntentPermission() {
        try {
            if (Build.VERSION.SDK_INT >= 34) { // UPSIDE_DOWN_CAKE
                val notificationManager = getSystemService(NotificationManager::class.java)
                val canUseFullScreenIntent = notificationManager
                    ?.javaClass
                    ?.getMethod("canUseFullScreenIntent")
                    ?.invoke(notificationManager) as? Boolean ?: true

                if (!canUseFullScreenIntent) {
                    val intent = Intent(
                        "android.settings.MANAGE_APP_USE_FULL_SCREEN_INTENT"
                    ).apply { data = Uri.parse("package:$packageName") }
                    startActivity(intent)
                }
            }
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    /**
     * 🔧 Samsung-specific fix — "app sleeps/dies when unplugged even
     * though it's running".
     *
     * ROOT CAUSE: Samsung One UI has its OWN app-killer on top of stock
     * Android battery optimization — "Put unused apps to sleep" /
     * "Sleeping apps" / "Deep sleeping apps" (Settings → Battery and
     * device care → Background usage limits). This is SEPARATE from
     * ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS above — an app can be
     * exempted from standard Android battery optimization and STILL get
     * frozen/killed by Samsung once the phone is unplugged and idle for
     * a while, unless the app's battery usage is explicitly set to
     * "Unrestricted" in Samsung's own battery screen.
     *
     * There's no Intent that opens that exact per-app battery sub-screen
     * directly across all One UI versions, so this opens the app's
     * system "App info" page (which has a "Battery" entry with an
     * "Unrestricted" option) and shows an explicit instruction dialog,
     * since this step genuinely cannot be fully automated. Shown once
     * per install via the persisted flag.
     */
    private fun requestSamsungBatterySettings() {
        try {
            if (!Build.MANUFACTURER.equals("samsung", ignoreCase = true)) return

            val prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            if (prefs.getBoolean(KEY_SAMSUNG_PROMPT_SHOWN, false)) return
            prefs.edit().putBoolean(KEY_SAMSUNG_PROMPT_SHOWN, true).apply()

            AlertDialog.Builder(this)
                .setTitle("⚠️ Important Samsung Setting")
                .setMessage(
                    "To keep this app running when NOT charging, you must " +
                    "manually set it to Unrestricted battery usage:\n\n" +
                    "1. Tap OK below (opens App info)\n" +
                    "2. Tap \"Battery\"\n" +
                    "3. Select \"Unrestricted\"\n\n" +
                    "Then also go to:\n" +
                    "Settings → Battery and device care → Background usage limits " +
                    "→ Sleeping apps / Deep sleeping apps\n" +
                    "and make sure this app is NOT listed there.\n\n" +
                    "Without this, Samsung will freeze the app overnight or " +
                    "whenever the phone is unplugged for a while."
                )
                .setCancelable(false)
                .setPositiveButton("OK") { _, _ ->
                    try {
                        val intent = Intent(
                            Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                            Uri.parse("package:$packageName")
                        )
                        startActivity(intent)
                    } catch (e: Exception) {
                        e.printStackTrace()
                    }
                }
                .show()
        } catch (e: Exception) {
            Log.e(TAG, "requestSamsungBatterySettings failed: ${e.message}")
        }
    }

    override fun getMainComponentName(): String = "AttendanceSMSAppv1"

    override fun createReactActivityDelegate(): ReactActivityDelegate =
        DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)
}