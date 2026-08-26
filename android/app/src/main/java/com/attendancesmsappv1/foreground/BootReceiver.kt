// C:\Attendance\AttendanceSMS\android\app\src\main\java\com\attendancesmsappv1\foreground\BootReceiver.kt

package com.attendancesmsappv1.foreground

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build

/**
 * BootReceiver
 *
 * Listens for BOOT_COMPLETED (and HTC/Xiaomi QUICKBOOT variants).
 * Automatically restarts SmsForgroundService after a device reboot so
 * 24/7 operation resumes without any manual action.
 *
 * Registered in AndroidManifest.xml with RECEIVE_BOOT_COMPLETED permission.
 */
class BootReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action ?: return

        val isBoot = action == Intent.ACTION_BOOT_COMPLETED ||
                     action == "android.intent.action.QUICKBOOT_POWERON" ||
                     action == "com.htc.intent.action.QUICKBOOT_POWERON"

        if (!isBoot) return

        val serviceIntent = Intent(context, SmsForgroundService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(serviceIntent)
        } else {
            context.startService(serviceIntent)
        }
    }
}