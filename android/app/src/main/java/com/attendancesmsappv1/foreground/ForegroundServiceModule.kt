// C:\Attendance\AttendanceSMS\android\app\src\main\java\com\attendancesmsappv1\foreground\ForegroundServiceModule.kt

package com.attendancesmsappv1.foreground

import android.content.Intent
import android.os.Build
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * ForegroundServiceModule
 *
 * React Native bridge that exposes foreground service control to JavaScript.
 * Registered in MainApplication.kt via ForegroundServicePackage.
 *
 * JS usage (in MainScreen.js via useForegroundService hook):
 *   import { NativeModules } from 'react-native';
 *   const { ForegroundServiceModule } = NativeModules;
 *   ForegroundServiceModule.startService();
 *   ForegroundServiceModule.updateStatus('Idle cycle 42...');
 *   ForegroundServiceModule.stopService();
 */
class ForegroundServiceModule(
    private val reactContext: ReactApplicationContext
) : ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "ForegroundServiceModule"

    // ── Start the persistent foreground service ───────────────────────────────
    @ReactMethod
    fun startService() {
        val intent = Intent(reactContext, SmsForgroundService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            reactContext.startForegroundService(intent)
        } else {
            reactContext.startService(intent)
        }
    }

    // ── Update the notification text (called every ~10 idle cycles) ──────────
    @ReactMethod
    fun updateStatus(status: String) {
        val intent = Intent(reactContext, SmsForgroundService::class.java).apply {
            action = SmsForgroundService.ACTION_UPDATE
            putExtra(SmsForgroundService.EXTRA_STATUS, status)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            reactContext.startForegroundService(intent)
        } else {
            reactContext.startService(intent)
        }
    }

    // ── Stop the service (only called from the manual Stop button) ───────────
    @ReactMethod
    fun stopService() {
        val intent = Intent(reactContext, SmsForgroundService::class.java).apply {
            action = SmsForgroundService.ACTION_STOP
        }
        reactContext.startService(intent)
    }
}