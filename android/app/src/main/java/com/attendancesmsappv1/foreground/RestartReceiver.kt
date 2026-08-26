// C:\Attendance\AttendanceSMS\android\app\src\main\java\com\attendancesmsappv1\foreground\RestartReceiver.kt
package com.attendancesmsappv1.foreground

import android.app.AlarmManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import com.attendancesmsappv1.MainActivity
import com.attendancesmsappv1.R

/**
 * RestartReceiver
 *
 * 🔧 FIXED (this revision — "app did not reopen after the 3-hour restart,
 * consistently, on Android 15"):
 *
 * ROOT CAUSE: since Android 10, a plain BroadcastReceiver (no visible
 * activity, no foreground UI at the moment it runs) is NOT allowed to call
 * startActivity() and reliably have it succeed — the OS silently blocks
 * background activity starts outside a small set of exemptions. This was
 * always a latent risk in the old implementation; it just happened to work
 * often enough on some OEM/Android version combos to go unnoticed. On
 * Android 15 the restriction is enforced consistently, so the relaunch was
 * failing silently every single time — no crash, no log the user could
 * see, the app just never came back.
 *
 * FIX: use a FULL-SCREEN INTENT NOTIFICATION as the primary relaunch
 * mechanism instead. Full-screen intents (the same mechanism incoming-call
 * and alarm apps use) carry an explicit OS exemption from the background-
 * activity-start restriction — IF the user has granted the
 * "Full screen notifications" permission (required separately since
 * Android 14; see MainActivity.kt's onCreate() for the one-time request
 * flow). A direct startActivity() attempt is still made first as a
 * best-effort (harmless if blocked, and still works fine on older Android
 * versions / devices where it's not restricted), with the full-screen
 * notification as the mechanism actually relied upon to work.
 *
 * The belt-and-suspenders foreground-service start is unchanged and still
 * fires — starting a foreground SERVICE (as opposed to an Activity) from a
 * background alarm broadcast is allowed, so this part was never the
 * problem.
 */
class RestartReceiver : BroadcastReceiver() {

    companion object {
        const val ACTION_RESTART_APP = "com.attendancesmsappv1.ACTION_RESTART_APP"
        const val RECOVERY_CHECK_DELAY_MS = 3 * 60 * 1000L // 3 minutes

        private const val RESTART_CHANNEL_ID   = "app_restart_channel"
        private const val RESTART_CHANNEL_NAME = "App Restart"
        private const val RESTART_NOTIFICATION_ID = 2001
    }

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_RESTART_APP) return

        val launchIntent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or
                    Intent.FLAG_ACTIVITY_CLEAR_TASK or
                    Intent.FLAG_ACTIVITY_CLEAR_TOP
        }

        // Best-effort direct attempt — harmless if the OS blocks it, still
        // works fine on Android versions/OEMs where it isn't restricted.
        try {
            context.startActivity(launchIntent)
        } catch (e: Exception) {
            e.printStackTrace()
        }

        // 🔧 NEW — the mechanism actually relied upon: a full-screen
        // intent notification, which is explicitly exempted from the
        // background-activity-start restriction (same mechanism used by
        // calling/alarm apps). Requires the user to have granted "Full
        // screen notifications" — requested once from MainActivity.kt.
        try {
            triggerFullScreenRelaunch(context, launchIntent)
        } catch (e: Exception) {
            e.printStackTrace()
        }

        // Starting a foreground SERVICE (not an Activity) from a
        // background alarm broadcast is allowed — unaffected by the
        // restriction above, kept as-is.
        val serviceIntent = Intent(context, SmsForgroundService::class.java)
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(serviceIntent)
            } else {
                context.startService(serviceIntent)
            }
        } catch (e: Exception) {
            e.printStackTrace()
        }

        scheduleRecoveryCheck(context, attempt = 1)
    }

    private fun triggerFullScreenRelaunch(context: Context, launchIntent: Intent) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                RESTART_CHANNEL_ID,
                RESTART_CHANNEL_NAME,
                NotificationManager.IMPORTANCE_HIGH
            ).apply {
                description = "Relaunches the app after an automatic restart"
                setShowBadge(false)
            }
            val manager = context.getSystemService(NotificationManager::class.java)
            manager?.createNotificationChannel(channel)
        }

        val fullScreenPendingIntent = PendingIntent.getActivity(
            context, 9933, launchIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notification = NotificationCompat.Builder(context, RESTART_CHANNEL_ID)
            .setContentTitle("School SMS Notifier")
            .setContentText("Restarting…")
            .setSmallIcon(R.drawable.ic_notification)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setFullScreenIntent(fullScreenPendingIntent, true)
            .setContentIntent(fullScreenPendingIntent)
            .setAutoCancel(true)
            .setOngoing(false)
            .build()

        val manager = context.getSystemService(NotificationManager::class.java)
        manager?.notify(RESTART_NOTIFICATION_ID, notification)
    }

    private fun scheduleRecoveryCheck(context: Context, attempt: Int) {
        try {
            val checkIntent = Intent(context, RecoveryCheckReceiver::class.java).apply {
                action = RecoveryCheckReceiver.ACTION_CHECK_RECOVERY
                putExtra(RecoveryCheckReceiver.EXTRA_ATTEMPT, attempt)
            }
            val pendingIntent = PendingIntent.getBroadcast(
                context, 9922, checkIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
            val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
            val triggerAt = System.currentTimeMillis() + RECOVERY_CHECK_DELAY_MS
            alarmManager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, pendingIntent)
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }
}