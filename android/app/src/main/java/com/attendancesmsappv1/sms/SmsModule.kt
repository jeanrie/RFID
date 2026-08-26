//C:\Attendance\AttendanceSMS\android\app\src\main\java\com\attendancesmsappv1\sms\SmsModule.kt
package com.attendancesmsappv1.sms

import android.app.Activity
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Handler
import android.os.Looper
import android.telephony.SmsManager
import com.facebook.react.bridge.*
import java.util.concurrent.atomic.AtomicInteger

class SmsModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

    companion object {
        // 🔧 NEW — see the fix comment on sendSMS() below. A monotonically
        // increasing counter used to build a UNIQUE broadcast action (and
        // PendingIntent request code) for every single sendSMS() call, so
        // concurrent/overlapping sends can never cross-talk with each other.
        private val requestCounter = AtomicInteger(0)
        private const val SENT_ACTION_PREFIX = "com.attendancesmsappv1.SMS_SENT_"

        // Safety net: if the OS never delivers the "sent" confirmation
        // broadcast (lost broadcast, extremely slow/unresponsive carrier),
        // force-settle after this long so the receiver can never leak
        // indefinitely and the JS promise never hangs forever either.
        // Kept slightly under MainScreen.js's own SMS_OP_TIMEOUT_MS (20s)
        // so this native safety net resolves first when possible.
        private const val RECEIVER_TIMEOUT_MS = 18_000L
    }

    override fun getName(): String = "SmsModule"

    /**
     * 🔧 FIXED (this revision — "parent receives 2 identical SMS for the
     * same attendance log, smsprocessing ends up at 2 instead of 1"):
     *
     * ROOT CAUSE: every previous call to sendSMS() used the EXACT SAME
     * hardcoded broadcast action string ("SMS_SENT_ACTION") and the EXACT
     * SAME PendingIntent request code (0) for its "message sent"
     * confirmation — regardless of which phone number or message was
     * being sent. Every call also registered a brand-new anonymous
     * BroadcastReceiver filtered on that SAME shared action via
     * `registerReceiver(receiver, IntentFilter(action))`, and only ever
     * unregistered itself from inside its own onReceive() — meaning if
     * that particular broadcast was ever delayed or lost, the receiver
     * stayed registered indefinitely.
     *
     * Android delivers a broadcast to EVERY currently-registered receiver
     * whose IntentFilter matches the action — not just the "intended"
     * one. So if sendSMS() was called again (a different number, a
     * different attendance log's message, or simply the NEXT call in the
     * loop) WHILE a previous call's receiver was still registered
     * (because its own confirmation broadcast hadn't arrived yet — e.g.
     * the JS side had already given up after its own SMS_OP_TIMEOUT_MS of
     * 20s while the carrier was still slow to confirm), BOTH receivers
     * were listening on the identical action. A single real "sent"
     * broadcast — meant for only ONE of those sends — could trigger BOTH
     * receivers' onReceive() at once, reporting a success/failure result
     * for the wrong send entirely.
     *
     * When this produced a FALSE NEGATIVE (`success: false`) for an SMS
     * that had, in reality, already been delivered fine, the caller
     * (MainScreen.js) never marked that attendance log's `smssent` flag
     * in the database. The exact same record was then picked up and
     * re-sent on the very next loop iteration — the parent receives the
     * identical message twice, and `smsprocessing` ends up at 2 for a
     * record that only ever needed to go out once.
     *
     * FIX: every call now builds a UNIQUE action string AND a unique
     * PendingIntent request code (both derived from an atomic, per-call
     * counter), so its receiver can ONLY ever be triggered by a broadcast
     * meant for THAT specific send — zero cross-talk between
     * concurrent/overlapping calls, no matter how many are in flight at
     * once. A safety-net timeout also force-unregisters the receiver
     * (and settles the promise) if the confirmation broadcast is ever
     * lost or excessively delayed, so a receiver can never leak
     * indefinitely either — which also removes one more potential
     * contributor to native resource buildup over long uptimes.
     */
    @ReactMethod
    fun sendSMS(phoneNumber: String, message: String, promise: Promise) {
        try {
            val context = reactApplicationContext

            // Check SEND_SMS permission
            if (context.checkSelfPermission(android.Manifest.permission.SEND_SMS)
                != android.content.pm.PackageManager.PERMISSION_GRANTED
            ) {
                promise.reject("NO_PERMISSION", "SEND_SMS permission not granted")
                return
            }

            val smsManager: SmsManager = SmsManager.getDefault()
            val parts = smsManager.divideMessage(message)

            // 🔧 NEW — unique per-call identifiers, see fix comment above.
            // Using a fresh action string PER CALL guarantees this specific
            // PendingIntent/receiver pair can never be matched by a
            // broadcast meant for any other in-flight sendSMS() call.
            val requestId = requestCounter.incrementAndGet()
            val action    = SENT_ACTION_PREFIX + requestId

            val intent = Intent(action)
            intent.setPackage(context.packageName)

            val sentIntent = PendingIntent.getBroadcast(
                context, requestId, intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )

            val sentIntents = ArrayList<PendingIntent>()
            for (i in parts.indices) sentIntents.add(sentIntent)

            // Track parts sent
            var partsSent = 0
            var failed = false
            // 🔧 NEW — guards against the receiver (or the timeout
            // fallback below) settling the promise more than once.
            var settled = false

            val mainHandler = Handler(Looper.getMainLooper())
            var timeoutRunnable: Runnable? = null

            val receiver = object : BroadcastReceiver() {
                override fun onReceive(ctx: Context?, receivedIntent: Intent?) {
                    if (settled) return
                    partsSent++
                    if (resultCode != Activity.RESULT_OK) failed = true

                    // When all parts are sent, resolve promise
                    if (partsSent >= parts.size) {
                        settled = true
                        timeoutRunnable?.let { mainHandler.removeCallbacks(it) }
                        val map = Arguments.createMap()
                        map.putBoolean("success", !failed)
                        try { promise.resolve(map) } catch (e: Exception) { /* already settled */ }
                        try { context.unregisterReceiver(this) } catch (e: Exception) { /* already gone */ }
                    }
                }
            }

            // Register dynamic receiver — scoped to THIS call's unique
            // action, so it can only ever match broadcasts meant for it.
            context.registerReceiver(
                receiver,
                IntentFilter(action),
                Context.RECEIVER_EXPORTED
            )

            // 🔧 NEW — safety net: if the OS never delivers the
            // confirmation broadcast (lost, or an unusually slow
            // carrier), don't leave this receiver registered forever and
            // don't leave the JS promise hanging past its own timeout.
            timeoutRunnable = Runnable {
                if (settled) return@Runnable
                settled = true
                try { context.unregisterReceiver(receiver) } catch (e: Exception) { /* already gone */ }
                try {
                    promise.reject("SMS_SENT_TIMEOUT", "No sent-confirmation received for $phoneNumber")
                } catch (e: Exception) { /* already settled */ }
            }
            mainHandler.postDelayed(timeoutRunnable!!, RECEIVER_TIMEOUT_MS)

            // Send SMS (multipart if needed)
            if (parts.size > 1) {
                smsManager.sendMultipartTextMessage(phoneNumber, null, parts, sentIntents, null)
            } else {
                smsManager.sendTextMessage(phoneNumber, null, message, sentIntent, null)
            }

        } catch (e: Exception) {
            promise.reject("SMS_FAILED", e.message)
        }
    }
}