// C:\Attendance\AttendanceSMS\android\app\src\main\java\com\attendancesmsappv1\foreground\RecoveryCheckReceiver.kt
package com.attendancesmsappv1.foreground

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.telephony.SmsManager
import android.util.Log
import com.attendancesmsappv1.watchdog.WatchdogModule

/**
 * RecoveryCheckReceiver
 *
 * Fired a few minutes after RestartReceiver relaunches the app following a
 * native hard-restart. Reads the heartbeat timestamp WatchdogModule
 * persists to SharedPreferences — DIRECTLY, with no React/JS dependency at
 * all — so this works even if the relaunch failed entirely, or the JS loop
 * wedged again immediately after coming back up.
 *
 * If no fresh heartbeat is found: retries the relaunch (capped at
 * MAX_RETRY_ATTEMPTS) and, from the 2nd failed check onward, sends an
 * independent SMS alert saying automatic recovery is NOT working — so
 * admins actually find out, instead of the app just going silent overnight
 * with no notification at all.
 */
class RecoveryCheckReceiver : BroadcastReceiver() {

    companion object {
        private const val TAG = "RecoveryCheckReceiver"
        const val ACTION_CHECK_RECOVERY = "com.attendancesmsappv1.ACTION_CHECK_RECOVERY"
        const val EXTRA_ATTEMPT = "attempt"

        // If a heartbeat came in more recently than this, the loop is
        // considered successfully recovered.
        private const val FRESH_HEARTBEAT_MS = 2 * 60 * 1000L // 2 minutes
        private const val MAX_RETRY_ATTEMPTS = 3
        private const val RETRY_DELAY_MS = 3 * 60 * 1000L

        private val PHONE_REGEX = Regex("^(?:\\+63|0)9\\d{9}$")
    }

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_CHECK_RECOVERY) return

        val attempt = intent.getIntExtra(EXTRA_ATTEMPT, 1)
        val prefs = context.getSharedPreferences(
            WatchdogModule.RECOVERY_PREFS_NAME, Context.MODE_PRIVATE
        )

        val lastHeartbeat = prefs.getLong(WatchdogModule.KEY_LAST_HEARTBEAT_MS, 0L)
        val elapsed = System.currentTimeMillis() - lastHeartbeat

        if (lastHeartbeat > 0L && elapsed in 0..FRESH_HEARTBEAT_MS) {
            Log.i(TAG, "Recovery check OK — heartbeat ${elapsed}ms ago (attempt $attempt)")
            return
        }

        Log.e(TAG, "Recovery check FAILED — no fresh heartbeat (attempt $attempt, " +
            "elapsed=${elapsed}ms)")

        // Retry the relaunch.
        val launchIntent = Intent(context, com.attendancesmsappv1.MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or
                    Intent.FLAG_ACTIVITY_CLEAR_TASK or
                    Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        try {
            context.startActivity(launchIntent)
        } catch (e: Exception) {
            e.printStackTrace()
        }

        val deviceName = prefs.getString(WatchdogModule.KEY_DEVICE_NAME, "") ?: ""
        val adminNumbersCsv = prefs.getString(WatchdogModule.KEY_ADMIN_NUMBERS, "") ?: ""

        // From the 2nd failed check onward, this isn't just a blip — alert.
        if (attempt >= 2) {
            sendRecoveryFailedSms(adminNumbersCsv, deviceName, attempt)
        }

        if (attempt < MAX_RETRY_ATTEMPTS) {
            scheduleNextCheck(context, attempt + 1)
        } else {
            Log.e(TAG, "Recovery check giving up after $MAX_RETRY_ATTEMPTS attempts — " +
                "device likely needs manual attention")
        }
    }

    private fun scheduleNextCheck(context: Context, nextAttempt: Int) {
        try {
            val checkIntent = Intent(context, RecoveryCheckReceiver::class.java).apply {
                action = ACTION_CHECK_RECOVERY
                putExtra(EXTRA_ATTEMPT, nextAttempt)
            }
            val pendingIntent = PendingIntent.getBroadcast(
                context, 9922, checkIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
            val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
            val triggerAt = System.currentTimeMillis() + RETRY_DELAY_MS
            alarmManager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, pendingIntent)
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    private fun sendRecoveryFailedSms(adminNumbersCsv: String, deviceName: String, attempt: Int) {
        try {
            val numbers = adminNumbersCsv.split(",", ";")
                .map { it.trim() }
                .filter { it.matches(PHONE_REGEX) }
            if (numbers.isEmpty()) return

            val message =
                "⚠️ SMS NOTIFIER RECOVERY FAILED\n\n" +
                "Device: $deviceName\n" +
                "The app force-restarted earlier but has NOT resumed normally " +
                "(check #$attempt). Please check the device in person."

            val smsManager = SmsManager.getDefault()
            for (num in numbers) {
                try {
                    val parts = smsManager.divideMessage(message)
                    smsManager.sendMultipartTextMessage(num, null, parts, null, null)
                    Log.i(TAG, "Recovery-failed SMS dispatched to $num")
                } catch (e: Exception) {
                    Log.e(TAG, "Recovery-failed SMS to $num failed: ${e.message}")
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "sendRecoveryFailedSms failed: ${e.message}")
        }
    }
}