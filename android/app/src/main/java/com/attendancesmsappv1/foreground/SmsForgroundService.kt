// C:\Attendance\AttendanceSMS\android\app\src\main\java\com\attendancesmsappv1\foreground\SmsForgroundService.kt

package com.attendancesmsappv1.foreground

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat
import com.attendancesmsappv1.MainActivity
import com.attendancesmsappv1.R

/**
 * SmsForgroundService
 *
 * 🔧 FIXED — "app sleeps/dies when unplugged from charger even while
 * running". The wake lock is now acquired WITH a timeout and RENEWED
 * every 9 minutes (released + reacquired), and re-verified on every
 * onStartCommand. If Samsung/any OEM ROM silently drops it, it's
 * reacquired within minutes instead of staying dropped for hours.
 * setReferenceCounted(false) avoids acquire/release count mismatches.
 *
 * NOTE: this cannot, by itself, stop Samsung's own "Sleeping apps" /
 * "Deep sleeping apps" background-process killer — that requires the
 * user to set the app to Unrestricted battery usage manually (handled
 * via the prompt in MainActivity.kt). This fix ensures the wake lock
 * itself is as resilient as code alone can make it.
 */
class SmsForgroundService : Service() {

    companion object {
        private const val TAG = "SmsForgroundService"
        const val CHANNEL_ID      = "sms_notifier_channel"
        const val CHANNEL_NAME    = "SMS Notifier Service"
        const val NOTIFICATION_ID = 1001
        const val ACTION_UPDATE   = "UPDATE_STATUS"
        const val ACTION_STOP     = "STOP_SERVICE"
        const val EXTRA_STATUS    = "status"

        private const val WAKE_LOCK_TIMEOUT_MS = 10 * 60 * 1000L // 10 min
        private const val WAKE_LOCK_RENEW_MS   =  9 * 60 * 1000L // renew @ 9 min
    }

    private var wakeLock: PowerManager.WakeLock? = null
    private val renewHandler = Handler(Looper.getMainLooper())
    private var renewRunnable: Runnable? = null

    // ── onCreate ─────────────────────────────────────────────────────────────
    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        startForeground(NOTIFICATION_ID, buildNotification("SMS Notifier is running 24/7..."))
        acquireWakeLock()
        scheduleWakeLockRenewal()
    }

    // ── onStartCommand ────────────────────────────────────────────────────────
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        ensureWakeLockHeld()

        when (intent?.action) {
            ACTION_UPDATE -> {
                val status = intent.getStringExtra(EXTRA_STATUS) ?: return START_STICKY
                updateNotification(status)
            }
            ACTION_STOP -> {
                stopForegroundService()
                return START_NOT_STICKY
            }
        }
        return START_STICKY
    }

    // ── onBind ────────────────────────────────────────────────────────────────
    override fun onBind(intent: Intent?): IBinder? = null

    // ── onDestroy ─────────────────────────────────────────────────────────────
    override fun onDestroy() {
        renewRunnable?.let { renewHandler.removeCallbacks(it) }
        releaseWakeLock()
        super.onDestroy()
    }

    // ── onTaskRemoved ─────────────────────────────────────────────────────────
    override fun onTaskRemoved(rootIntent: Intent?) {
        val restartIntent = Intent(applicationContext, SmsForgroundService::class.java)
        restartIntent.setPackage(packageName)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(restartIntent)
        } else {
            startService(restartIntent)
        }
        super.onTaskRemoved(rootIntent)
    }

    // ── Notification channel ──────────────────────────────────────────────────
    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                CHANNEL_NAME,
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Keeps the SMS attendance notifier running 24/7"
                setShowBadge(false)
            }
            val manager = getSystemService(NotificationManager::class.java)
            manager?.createNotificationChannel(channel)
        }
    }

    private fun buildNotification(text: String): Notification {
        val openIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK
        }
        val pendingFlags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        } else {
            PendingIntent.FLAG_UPDATE_CURRENT
        }
        val pendingIntent = PendingIntent.getActivity(this, 0, openIntent, pendingFlags)

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("School SMS Notifier")
            .setContentText(text)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build()
    }

    private fun updateNotification(text: String) {
        val manager = getSystemService(NotificationManager::class.java)
        manager?.notify(NOTIFICATION_ID, buildNotification(text))
    }

    // ── WakeLock ──────────────────────────────────────────────────────────────
    private fun acquireWakeLock() {
        try {
            val pm = getSystemService(POWER_SERVICE) as? PowerManager ?: return
            if (wakeLock == null) {
                wakeLock = pm.newWakeLock(
                    PowerManager.PARTIAL_WAKE_LOCK,
                    "SmsNotifier::WakeLock"
                ).apply { setReferenceCounted(false) }
            }
            wakeLock?.let {
                if (!it.isHeld) {
                    it.acquire(WAKE_LOCK_TIMEOUT_MS)
                    Log.i(TAG, "WakeLock acquired (${WAKE_LOCK_TIMEOUT_MS}ms)")
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "acquireWakeLock failed: ${e.message}")
        }
    }

    private fun ensureWakeLockHeld() {
        try {
            if (wakeLock?.isHeld != true) {
                Log.w(TAG, "WakeLock not held — reacquiring")
                acquireWakeLock()
            }
        } catch (e: Exception) {
            Log.e(TAG, "ensureWakeLockHeld failed: ${e.message}")
        }
    }

    private fun scheduleWakeLockRenewal() {
        renewRunnable = Runnable {
            try {
                wakeLock?.let { if (it.isHeld) it.release() }
            } catch (e: Exception) { /* ignore */ }
            acquireWakeLock()
            renewHandler.postDelayed(renewRunnable!!, WAKE_LOCK_RENEW_MS)
        }
        renewHandler.postDelayed(renewRunnable!!, WAKE_LOCK_RENEW_MS)
    }

    private fun releaseWakeLock() {
        try {
            wakeLock?.let { if (it.isHeld) it.release() }
        } catch (e: Exception) { /* ignore */ }
        wakeLock = null
    }

    // ── Stop ──────────────────────────────────────────────────────────────────
    private fun stopForegroundService() {
        renewRunnable?.let { renewHandler.removeCallbacks(it) }
        releaseWakeLock()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } else {
            @Suppress("DEPRECATION")
            stopForeground(true)
        }
        stopSelf()
    }
}