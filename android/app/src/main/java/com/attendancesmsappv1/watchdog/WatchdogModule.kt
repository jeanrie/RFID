// C:\Attendance\AttendanceSMS\android\app\src\main\java\com\attendancesmsappv1\watchdog\WatchdogModule.kt
package com.attendancesmsappv1.watchdog

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.Process
import android.telephony.SmsManager
import android.util.Log
import com.attendancesmsappv1.foreground.RestartReceiver
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule

/**
 * WatchdogModule
 *
 * Runs on its own HandlerThread — independent of the React Native JS thread.
 *
 * ── FIX #1 (root cause of the 3-hour restart never firing, historical) ─────
 * The original version called `handlerThread.quitSafely()` in
 * onCatalystInstanceDestroy(). Fixed by never quitting the thread and
 * self-healing it via ensureHandlerAlive().
 *
 * ── FIX #2 (stuck after 6 hours, no alert) ──────────────────────────────────
 * A soft "restart signal" set from JS (via watchdogAlert -> _requestRestart)
 * is USELESS if the JS thread itself is frozen inside a hung await (e.g. a
 * dead MSSQL connection or a stalled native SmsModule call that never
 * resolves). The JS listener that would react to watchdogAlert never gets a
 * chance to run — same wedged thread — so no SMS/email ever goes out and
 * nothing actually restarts.
 *
 * Fix: this module has a SECOND, independent threshold — hardRestartGraceMs
 * — measured from the same lastPingMs. If heartbeat silence continues for
 * (stuckThresholdMs + hardRestartGraceMs) with no recovery, the watchdog
 * assumes JS is genuinely wedged and does NOT rely on JS at all:
 *   1. Sends an emergency SMS directly via native SmsManager (no JS involved)
 *   2. Schedules an AlarmManager broadcast to relaunch MainActivity in a
 *      few seconds (survives process death — nothing else can, since killing
 *      the process also kills the foreground service)
 *   3. Force-kills the whole app process
 * This is mechanically identical to you manually force-closing and
 * reopening the app — just automatic.
 * (Per explicit requirement, this hard-restart backstop is NOT removed.)
 *
 * ── FIX #3 (daily restart follows user's start/end time, hour+minute) ──────
 * Two independent boundaries — dailyStartRestartHour/Minute and
 * dailyEndRestartHour/Minute — each with its own "already fired today"
 * date-guard.
 *
 * ── FIX #4 (reconnect never recovers / app closes silently overnight,
 *    no alert) ────────────────────────────────────────────────────────────
 * Root cause was on the JS side (MSSQL.close() hanging with no timeout,
 * wedging the whole JS thread inside the reconnect catch-block — see
 * MainScreen.js). That fix stops the JS thread from wedging in the first
 * place. This module adds a SECOND, independent safety net so that even if
 * something else unexpected wedges JS again in the future, there's a way to
 * verify recovery without depending on JS/React at all:
 *
 *   - Every heartbeat ping, every start(), and every updateEmergencyContacts()
 *     call now also persists to SharedPreferences (RECOVERY_PREFS_NAME) —
 *     last heartbeat timestamp, admin numbers, device name, running flag.
 *   - RestartReceiver (fired right before this module kills the process)
 *     now ALSO schedules a RecoveryCheckReceiver a few minutes later.
 *   - RecoveryCheckReceiver reads SharedPreferences DIRECTLY — no
 *     ReactContext, no JS bridge — so it works even if the relaunch
 *     silently fails or the JS loop wedges again immediately. If no fresh
 *     heartbeat shows up, it retries the relaunch and sends an independent
 *     "RECOVERY FAILED" SMS so admins actually find out, instead of the
 *     app just going dark overnight with zero notification.
 *
 * ── FIX #5 (this revision — "4x duplicate Auto-Restart notices right when
 *    the SMS window opens") ─────────────────────────────────────────────────
 * ROOT CAUSE: when the SMS window opens (e.g. 8:00 AM), JS's window
 * scheduler starts a BRAND NEW lifecycleCoordinator() run via
 * _activateProcessing() — this call to start() below IS effectively the
 * "daily restart" for that boundary. But scheduleDailyRestartCheck() below
 * had no idea that start() had just been called BECAUSE of that exact
 * boundary — it only checks "is now within DAILY_RESTART_FIRE_WINDOW_MIN
 * of the boundary AND hasn't fired today", which is independently true a
 * few seconds/minutes later, so it fired dailyRestartDue AGAIN for a
 * boundary that had already just been satisfied by the very start() call
 * that armed this watchdog — causing a redundant, duplicate restart cycle
 * (and a matching duplicate pair of STARTING/COMPLETE SMS notices). The
 * JS-side fallback in MainScreen.js runLoop() had the exact same blind
 * spot, compounding it further.
 *
 * FIX: start() now checks, at the moment it's called, whether "now" falls
 * within DAILY_RESTART_FIRE_WINDOW_MIN of either configured boundary. If
 * so, that boundary's "already fired today" guard is pre-marked for today
 * BEFORE scheduling ever begins — so scheduleDailyRestartCheck() will not
 * independently re-fire dailyRestartDue for a boundary this very start()
 * call already represents. (Matching JS-side fix is in MainScreen.js's
 * runLoop().)
 *
 * ── FIX #6 (this revision — "hard to reconnect / hard to process again
 *    after the app has been running for 6+ hours") ─────────────────────────
 * ROOT CAUSE: the periodic 3-hour auto-restart was a "soft" restart only —
 * JS tears down its loop and reconnects, but the OS process itself never
 * dies. Any native-side resource the MSSQL module fails to fully release
 * on a hung/timed-out close() (a socket, a connection-pool slot, a native
 * thread) is invisible to and unreclaimable by JS, and just accumulates
 * across restart cycles. One 3-hour cycle's leak usually isn't enough to
 * matter; two cycles' worth (i.e. 6+ hours in) reliably is.
 *
 * FIX: the periodic 3-hour restart is now a REAL full-process kill+relaunch
 * (triggerNativeRestart(), the same guaranteed-clean mechanism the
 * emergency stuck-heartbeat hard-restart already used) instead of a soft
 * JS-only restart. A process kill is the only way to GUARANTEE the OS
 * reclaims every native resource, leaked or not — so native resource usage
 * now resets to a clean zero every single cycle, and nothing ever
 * accumulates across two or more cycles again. It's silent (no admin SMS)
 * since this is routine, expected maintenance rather than an error.
 *
 * JS usage:
 *   WatchdogModule.start(stuckThresholdMs, autoRestartIntervalMs,
 *                        dailyStartHour, dailyStartMinute,
 *                        dailyEndHour, dailyEndMinute,
 *                        hardRestartGraceMs, adminNumbersCsv, deviceName);
 *   WatchdogModule.updateDailyRestartWindow(startHour, startMinute, endHour, endMinute);
 *   WatchdogModule.updateEmergencyContacts(adminNumbersCsv, deviceName);
 *   WatchdogModule.pingHeartbeat();
 *   WatchdogModule.stop();
 */
class WatchdogModule(private val reactContext: ReactApplicationContext)
    : ReactContextBaseJavaModule(reactContext) {

    companion object {
        private const val TAG = "WatchdogModule"

        const val EVENT_ALERT         = "watchdogAlert"
        const val EVENT_AUTO_RESTART  = "autoRestartDue"
        const val EVENT_DAILY_RESTART = "dailyRestartDue"
        const val EVENT_HARD_RESTART  = "hardRestartTriggered"

        private const val DAILY_RESTART_FIRE_WINDOW_MIN = 5

        private val PHONE_REGEX = Regex("^(?:\\+63|0)9\\d{9}$")

        // persisted independently of the ReactContext/JS lifecycle,
        // so a plain BroadcastReceiver (no RN bridge needed) can check
        // "is the loop actually alive" even after this module instance has
        // been torn down by a process kill/relaunch. Keys are public so
        // RecoveryCheckReceiver can read them by exact name.
        const val RECOVERY_PREFS_NAME   = "watchdog_recovery_prefs"
        const val KEY_LAST_HEARTBEAT_MS = "lastHeartbeatMs"
        const val KEY_ADMIN_NUMBERS     = "adminNumbersCsv"
        const val KEY_DEVICE_NAME       = "deviceName"
        const val KEY_IS_RUNNING        = "isRunning"
    }

    private var handlerThread = HandlerThread("WatchdogThread").also { it.start() }
    private var handler       = Handler(handlerThread.looper)

    // ── Mutable config (set by JS via start()) ────────────────────────────────
    @Volatile private var stuckThresholdMs: Long      = 10 * 60 * 1000L
    @Volatile private var autoRestartIntervalMs: Long = 3 * 60 * 60 * 1000L
    @Volatile private var hardRestartGraceMs: Long    = 15 * 60 * 1000L

    // Dual daily-restart boundaries (hour+minute), synced with the JS-side
    // user-editable SMS Start Time / End Time.
    @Volatile private var dailyStartRestartHour: Int   = 7
    @Volatile private var dailyStartRestartMinute: Int = 0
    @Volatile private var dailyEndRestartHour: Int     = 21
    @Volatile private var dailyEndRestartMinute: Int   = 0

    // ── Emergency contact info, kept fresh independently of start() ──────────
    @Volatile private var adminNumbersCsv: String   = ""
    @Volatile private var deviceNameForAlert: String = ""

    // ── Runtime state ─────────────────────────────────────────────────────────
    @Volatile private var lastPingMs: Long   = 0L
    @Volatile private var isRunning: Boolean = false
    @Volatile private var alertFired: Boolean = false
    @Volatile private var hardRestartTriggered: Boolean = false

    private val HEARTBEAT_CHECK_MS    = 30_000L
    private val AUTO_RESTART_CHECK_MS = 60_000L
    private val DAILY_CHECK_MS        = 60_000L

    @Volatile private var autoRestartAccumulatedMs: Long = 0L
    @Volatile private var lastAutoRestartCheckMs: Long   = 0L

    // Separate "already fired today" guards per boundary.
    @Volatile private var dailyStartRestartFiredDate: String = ""
    @Volatile private var dailyEndRestartFiredDate: String   = ""

    override fun getName(): String = "WatchdogModule"

    private fun ensureHandlerAlive() {
        if (!handlerThread.isAlive || handlerThread.looper == null) {
            Log.w(TAG, "HandlerThread was dead — recreating (self-heal path)")
            handlerThread = HandlerThread("WatchdogThread").also { it.start() }
            handler = Handler(handlerThread.looper)
        }
    }

    // writes the current heartbeat timestamp to SharedPreferences.
    // This is the ONLY thing RecoveryCheckReceiver relies on to decide
    // whether the app truly recovered after a hard restart.
    private fun persistHeartbeat() {
        try {
            reactContext.applicationContext
                .getSharedPreferences(RECOVERY_PREFS_NAME, Context.MODE_PRIVATE)
                .edit()
                .putLong(KEY_LAST_HEARTBEAT_MS, System.currentTimeMillis())
                .apply()
        } catch (e: Exception) {
            Log.e(TAG, "persistHeartbeat failed: ${e.message}")
        }
    }

    // writes admin contact info + running flag, so a plain
    // BroadcastReceiver can send an alert SMS without any JS/RN dependency.
    private fun persistEmergencyContacts() {
        try {
            reactContext.applicationContext
                .getSharedPreferences(RECOVERY_PREFS_NAME, Context.MODE_PRIVATE)
                .edit()
                .putString(KEY_ADMIN_NUMBERS, adminNumbersCsv)
                .putString(KEY_DEVICE_NAME, deviceNameForAlert)
                .putBoolean(KEY_IS_RUNNING, isRunning)
                .apply()
        } catch (e: Exception) {
            Log.e(TAG, "persistEmergencyContacts failed: ${e.message}")
        }
    }

    // 🔧 NEW — if start() is being (re)called right at/near a configured
    // daily-restart boundary, pre-mark that boundary's "already fired
    // today" guard so scheduleDailyRestartCheck() doesn't independently
    // re-fire a redundant dailyRestartDue event for a boundary this very
    // start() call already represents (e.g. the SMS window just opened,
    // which is exactly why start() is being called right now). See FIX #5
    // in the file header for the full explanation.
    private fun preMarkBoundaryIfStartingAtOne() {
        val cal = java.util.Calendar.getInstance()
        val nowMinutesOfDay = cal.get(java.util.Calendar.HOUR_OF_DAY) * 60 +
            cal.get(java.util.Calendar.MINUTE)
        val dateStr = "%04d-%02d-%02d".format(
            cal.get(java.util.Calendar.YEAR),
            cal.get(java.util.Calendar.MONTH),
            cal.get(java.util.Calendar.DAY_OF_MONTH)
        )

        val startBoundaryMin = dailyStartRestartHour * 60 + dailyStartRestartMinute
        val endBoundaryMin   = dailyEndRestartHour * 60 + dailyEndRestartMinute

        if (nowMinutesOfDay >= startBoundaryMin &&
            nowMinutesOfDay < startBoundaryMin + DAILY_RESTART_FIRE_WINDOW_MIN) {
            dailyStartRestartFiredDate = dateStr
            Log.i(TAG, "start() called at/near START boundary — pre-marking as handled for $dateStr")
        }
        if (nowMinutesOfDay >= endBoundaryMin &&
            nowMinutesOfDay < endBoundaryMin + DAILY_RESTART_FIRE_WINDOW_MIN) {
            dailyEndRestartFiredDate = dateStr
            Log.i(TAG, "start() called at/near END boundary — pre-marking as handled for $dateStr")
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    @ReactMethod
    fun start(
        stuckThresholdMsParam: Double,
        autoRestartIntervalMsParam: Double,
        dailyStartHourParam: Double,
        dailyStartMinuteParam: Double,
        dailyEndHourParam: Double,
        dailyEndMinuteParam: Double,
        hardRestartGraceMsParam: Double,
        adminNumbersCsvParam: String,
        deviceNameParam: String
    ) {
        ensureHandlerAlive()

        stuckThresholdMs      = stuckThresholdMsParam.toLong()
        autoRestartIntervalMs = autoRestartIntervalMsParam.toLong()
        hardRestartGraceMs    = hardRestartGraceMsParam.toLong()

        dailyStartRestartHour   = dailyStartHourParam.toInt()
        dailyStartRestartMinute = dailyStartMinuteParam.toInt()
        dailyEndRestartHour     = dailyEndHourParam.toInt()
        dailyEndRestartMinute   = dailyEndMinuteParam.toInt()

        adminNumbersCsv       = adminNumbersCsvParam
        deviceNameForAlert    = deviceNameParam

        lastPingMs                 = System.currentTimeMillis()
        alertFired                 = false
        hardRestartTriggered       = false
        autoRestartAccumulatedMs   = 0L
        lastAutoRestartCheckMs     = System.currentTimeMillis()
        dailyStartRestartFiredDate = ""
        dailyEndRestartFiredDate   = ""
        isRunning                  = true

        // 🔧 NEW — see FIX #5. Must run AFTER the boundary hour/minute
        // fields above are set and AFTER the "" reset above, so it can
        // correctly re-mark today's boundary if this start() call is
        // itself happening because of that boundary.
        preMarkBoundaryIfStartingAtOne()

        persistHeartbeat()
        persistEmergencyContacts()

        handler.removeCallbacksAndMessages(null)

        Log.i(TAG, "Watchdog started — stuck=${stuckThresholdMs}ms " +
            "autoRestart=${autoRestartIntervalMs}ms " +
            "dailyStart=${dailyStartRestartHour}:${"%02d".format(dailyStartRestartMinute)} " +
            "dailyEnd=${dailyEndRestartHour}:${"%02d".format(dailyEndRestartMinute)} " +
            "hardRestartGrace=${hardRestartGraceMs}ms (thread alive=${handlerThread.isAlive})")

        scheduleHeartbeatCheck()
        scheduleAutoRestartCheck()
        scheduleDailyRestartCheck()
    }

    @ReactMethod
    fun pingHeartbeat() {
        lastPingMs = System.currentTimeMillis()
        alertFired = false
        hardRestartTriggered = false
        persistHeartbeat()
        Log.v(TAG, "Heartbeat ping received")
    }

    @ReactMethod
    fun stop() {
        isRunning = false
        handler.removeCallbacksAndMessages(null)
        try {
            reactContext.applicationContext
                .getSharedPreferences(RECOVERY_PREFS_NAME, Context.MODE_PRIVATE)
                .edit()
                .putBoolean(KEY_IS_RUNNING, false)
                .apply()
        } catch (e: Exception) {
            Log.e(TAG, "stop() persist failed: ${e.message}")
        }
        Log.i(TAG, "Watchdog stopped")
    }

    @ReactMethod
    fun resetAutoRestartTimer() {
        ensureHandlerAlive()
        autoRestartAccumulatedMs = 0L
        lastAutoRestartCheckMs   = System.currentTimeMillis()
        Log.i(TAG, "Auto-restart timer reset")
    }

    @ReactMethod
    fun updateDailyRestartWindow(
        startHourParam: Double,
        startMinuteParam: Double,
        endHourParam: Double,
        endMinuteParam: Double
    ) {
        dailyStartRestartHour   = startHourParam.toInt()
        dailyStartRestartMinute = startMinuteParam.toInt()
        dailyEndRestartHour     = endHourParam.toInt()
        dailyEndRestartMinute   = endMinuteParam.toInt()
        Log.i(TAG, "Daily restart window updated — " +
            "start=${dailyStartRestartHour}:${"%02d".format(dailyStartRestartMinute)} " +
            "end=${dailyEndRestartHour}:${"%02d".format(dailyEndRestartMinute)}")
    }

    // ── Keep emergency contact info fresh even if start() isn't re-called ────
    @ReactMethod
    fun updateEmergencyContacts(numbersCsv: String, deviceName: String) {
        adminNumbersCsv = numbersCsv
        deviceNameForAlert = deviceName
        persistEmergencyContacts()
    }

    @ReactMethod
    fun getDiagnostics(promise: Promise) {
        val map = Arguments.createMap()
        map.putBoolean("isRunning", isRunning)
        map.putBoolean("threadAlive", handlerThread.isAlive)
        map.putDouble("msSinceLastPing", (System.currentTimeMillis() - lastPingMs).toDouble())
        map.putDouble("autoRestartAccumulatedMs", autoRestartAccumulatedMs.toDouble())
        map.putDouble("autoRestartIntervalMs", autoRestartIntervalMs.toDouble())
        map.putDouble("hardRestartGraceMs", hardRestartGraceMs.toDouble())
        map.putInt("dailyStartRestartHour", dailyStartRestartHour)
        map.putInt("dailyStartRestartMinute", dailyStartRestartMinute)
        map.putInt("dailyEndRestartHour", dailyEndRestartHour)
        map.putInt("dailyEndRestartMinute", dailyEndRestartMinute)
        promise.resolve(map)
    }

    @ReactMethod
    fun addListener(eventName: String) { /* no-op — required by RN */ }

    @ReactMethod
    fun removeListeners(count: Double) { /* no-op — required by RN */ }

    // ─────────────────────────────────────────────────────────────────────────
    private fun scheduleHeartbeatCheck() {
        ensureHandlerAlive()
        handler.postDelayed({
            if (!isRunning) return@postDelayed

            val elapsed = System.currentTimeMillis() - lastPingMs

            if (elapsed >= stuckThresholdMs && !alertFired) {
                alertFired = true
                val mins = (elapsed / 60_000).toInt()
                Log.w(TAG, "Watchdog ALERT — no heartbeat for ${mins}m")
                sendEvent(EVENT_ALERT, mapOf(
                    "reason"      to "No heartbeat for ${mins} minutes",
                    "elapsedMs"   to elapsed.toDouble(),
                    "elapsedMins" to mins.toDouble(),
                    "timestamp"   to System.currentTimeMillis().toDouble(),
                ))
            }

            // ── HARD RESTART: JS has had its chance (stuckThresholdMs) plus a
            // grace period to recover on its own and never pinged back. Assume
            // it's wedged and force-restart the whole process natively.
            // (Kept intact per requirement — do NOT remove.)
            if (elapsed >= (stuckThresholdMs + hardRestartGraceMs) && !hardRestartTriggered) {
                hardRestartTriggered = true
                Log.e(TAG, "HARD RESTART — no heartbeat for ${elapsed}ms. Forcing process restart.")
                performHardRestart(elapsed)
                return@postDelayed // process is going down — don't reschedule
            }

            scheduleHeartbeatCheck()
        }, HEARTBEAT_CHECK_MS)
    }

    private fun scheduleAutoRestartCheck() {
        ensureHandlerAlive()
        handler.postDelayed({
            if (!isRunning) return@postDelayed

            val now   = System.currentTimeMillis()
            val delta = now - lastAutoRestartCheckMs
            lastAutoRestartCheckMs = now
            autoRestartAccumulatedMs += delta

            if (autoRestartAccumulatedMs >= autoRestartIntervalMs) {
                autoRestartAccumulatedMs = 0L

                // 🔧 FIXED — this used to just emit EVENT_AUTO_RESTART so JS
                // could do a "soft" restart (tear down the JS loop, call
                // MSSQL close()+connect() again) while the OS process kept
                // running. That soft restart can never guarantee any
                // native-side resource (a socket, a connection-pool slot, a
                // native thread — anything the underlying MSSQL module might
                // fail to release on a hung close()) actually gets freed. If
                // it doesn't, it just quietly accumulates across cycles —
                // which is exactly why reconnecting/processing would get
                // harder specifically after 6+ hours (two 3-hour cycles'
                // worth of leaked resources stacked together).
                //
                // Fix: this is now a REAL full-process restart (same
                // guaranteed-clean mechanism as the emergency stuck-heartbeat
                // hard-restart below), so native resource usage is reset to
                // a clean zero every single 3-hour cycle — nothing ever gets
                // the chance to accumulate across two or more cycles again.
                // It's silent (no SMS) since this is routine, expected
                // maintenance, not an error condition. MainScreen.js's
                // existing auto-resume-on-launch logic (appShouldRun flag)
                // picks the schedule right back up automatically once the
                // process relaunches.
                Log.i(TAG, "Scheduled full-process restart due (accumulated ${autoRestartIntervalMs}ms) " +
                    "— restarting the whole process to guarantee native resources are reclaimed")
                isRunning = false // process is going down; nothing left to schedule
                triggerNativeRestart("scheduled ${autoRestartIntervalMs / 3_600_000}hr full-process restart", null)
                return@postDelayed // do NOT reschedule — the process is restarting
            }

            scheduleAutoRestartCheck()
        }, AUTO_RESTART_CHECK_MS)
    }

    private fun scheduleDailyRestartCheck() {
        ensureHandlerAlive()
        handler.postDelayed({
            if (!isRunning) return@postDelayed

            val cal  = java.util.Calendar.getInstance()
            val hour = cal.get(java.util.Calendar.HOUR_OF_DAY)
            val min  = cal.get(java.util.Calendar.MINUTE)
            val nowMinutesOfDay = hour * 60 + min
            val dateStr = "%04d-%02d-%02d".format(
                cal.get(java.util.Calendar.YEAR),
                cal.get(java.util.Calendar.MONTH),
                cal.get(java.util.Calendar.DAY_OF_MONTH)
            )

            val startBoundaryMin = dailyStartRestartHour * 60 + dailyStartRestartMinute
            val endBoundaryMin   = dailyEndRestartHour * 60 + dailyEndRestartMinute

            if (
                nowMinutesOfDay >= startBoundaryMin &&
                nowMinutesOfDay < startBoundaryMin + DAILY_RESTART_FIRE_WINDOW_MIN &&
                dailyStartRestartFiredDate != dateStr
            ) {
                dailyStartRestartFiredDate = dateStr
                Log.i(TAG, "Daily restart due (START boundary) at " +
                    "${dailyStartRestartHour}:${"%02d".format(dailyStartRestartMinute)}")
                sendEvent(EVENT_DAILY_RESTART, mapOf(
                    "reason"    to "Scheduled daily restart at SMS window start " +
                        "(${dailyStartRestartHour}:${"%02d".format(dailyStartRestartMinute)})",
                    "boundary"  to "start",
                    "timestamp" to System.currentTimeMillis().toDouble(),
                ))
            }

            if (
                nowMinutesOfDay >= endBoundaryMin &&
                nowMinutesOfDay < endBoundaryMin + DAILY_RESTART_FIRE_WINDOW_MIN &&
                dailyEndRestartFiredDate != dateStr
            ) {
                dailyEndRestartFiredDate = dateStr
                Log.i(TAG, "Daily restart due (END boundary) at " +
                    "${dailyEndRestartHour}:${"%02d".format(dailyEndRestartMinute)}")
                sendEvent(EVENT_DAILY_RESTART, mapOf(
                    "reason"    to "Scheduled daily restart at SMS window end " +
                        "(${dailyEndRestartHour}:${"%02d".format(dailyEndRestartMinute)})",
                    "boundary"  to "end",
                    "timestamp" to System.currentTimeMillis().toDouble(),
                ))
            }

            scheduleDailyRestartCheck()
        }, DAILY_CHECK_MS)
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Nuclear fallback — entirely native, does not depend on JS in any way.
    // NOT removed — this is the exact "App frozen - force restarting" flow.
    // Refactored (this revision) to share its relaunch+kill mechanics with
    // the new proactive scheduled restart via triggerNativeRestart() below.
    // ─────────────────────────────────────────────────────────────────────────
    private fun performHardRestart(elapsedMs: Long) {
        val mins = (elapsedMs / 60_000).toInt()
        val message =
            "APP FROZEN - MANUAL RESTART NEEDED\n\n" +
            "Device: $deviceNameForAlert\n" +
            "No response for ${mins} minutes. Please close and reopen the app"

        sendEvent(EVENT_HARD_RESTART, mapOf(
            "reason"    to "No heartbeat for ${mins} minutes — forcing process restart",
            "timestamp" to System.currentTimeMillis().toDouble(),
        ))

        triggerNativeRestart("stuck heartbeat (${mins}m)", message)
    }

    // 🔧 NEW — shared relaunch+kill mechanics, extracted from
    // performHardRestart() so the same guaranteed-clean restart path can
    // also be used PROACTIVELY (see scheduleAutoRestartCheck() below) —
    // not just reactively when the heartbeat goes stale.
    //
    // WHY THIS EXISTS (root cause of "hard to reconnect after 6+ hours"):
    // the periodic 3-hour auto-restart used to be a "soft" restart — JS
    // tears down its own loop and calls MSSQL close()+connect() again, but
    // the underlying OS PROCESS never actually dies. If the native MSSQL
    // module ever leaves ANY resource behind on a close() that hung/timed
    // out (a socket, a native connection-pool slot, a native thread — any
    // of which is entirely possible and outside what JS can inspect or
    // force-free), that resource is never reclaimed by a soft restart. It
    // just quietly accumulates, restart after restart. One 3-hour cycle's
    // worth usually isn't enough to matter — which is exactly why this
    // always seems to appear "after 6+ hours" (i.e. after the SECOND
    // 3-hour cycle's leak stacks on top of the first) rather than
    // immediately.
    //
    // A full process kill+relaunch is the ONLY way to GUARANTEE the OS
    // reclaims every native resource, leaked or not — there is no JS-level
    // trick that can substitute for that guarantee against a native
    // module's internal behavior. So the periodic 3-hour restart is now a
    // real process restart (same mechanism as the emergency hard-restart),
    // which resets native resource usage to a clean zero every single
    // cycle — nothing is ever given the chance to accumulate across two or
    // more cycles again.
    //
    // smsMessage == null means this is routine, expected maintenance (the
    // scheduled 3hr restart) — silent by design, no admin SMS, so this
    // stays invisible/non-disruptive in normal operation. Only the
    // reactive stuck-heartbeat path (which indicates something actually
    // went wrong) sends an alert.
    private fun triggerNativeRestart(reasonForLog: String, smsMessage: String?) {
        // 1) Optional SMS straight from native code — no JS thread involved.
        //    Only sent for the reactive/abnormal case (smsMessage != null);
        //    routine scheduled restarts stay silent.
        if (smsMessage != null) {
            try {
                val numbers = adminNumbersCsv.split(",", ";")
                    .map { it.trim() }
                    .filter { it.matches(PHONE_REGEX) }
                if (numbers.isNotEmpty()) {
                    val smsManager = SmsManager.getDefault()
                    for (num in numbers) {
                        try {
                            val parts = smsManager.divideMessage(smsMessage)
                            smsManager.sendMultipartTextMessage(num, null, parts, null, null)
                            Log.i(TAG, "Restart notice SMS dispatched to $num")
                        } catch (e: Exception) {
                            Log.e(TAG, "Restart notice SMS to $num failed: ${e.message}")
                        }
                    }
                } else {
                    Log.w(TAG, "No valid admin numbers configured for restart notice SMS")
                }
            } catch (e: Exception) {
                Log.e(TAG, "Restart notice SMS block failed: ${e.message}")
            }
        }

        // 2) Schedule a relaunch BEFORE killing the process — nothing survives
        // a process kill except an OS-level alarm. RestartReceiver (fired by
        // this alarm) also arms RecoveryCheckReceiver to independently verify
        // the relaunch actually worked, with no JS/React dependency at all.
        try {
            val ctx = reactContext.applicationContext
            val restartIntent = Intent(ctx, RestartReceiver::class.java).apply {
                action = RestartReceiver.ACTION_RESTART_APP
            }
            val pendingIntent = PendingIntent.getBroadcast(
                ctx, 9911, restartIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
            val alarmManager = ctx.getSystemService(Context.ALARM_SERVICE) as AlarmManager
            val triggerAt = System.currentTimeMillis() + 5000L
            alarmManager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, pendingIntent)
            Log.i(TAG, "Restart alarm scheduled for +5s ($reasonForLog)")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to schedule restart alarm: ${e.message}")
        }

        // 3) Give SMS + alarm scheduling a moment to actually flush, then kill
        // the whole process — this is what actually reclaims native
        // resources; nothing short of this can guarantee it.
        handler.postDelayed({
            Log.w(TAG, "Killing process now for restart ($reasonForLog)")
            Process.killProcess(Process.myPid())
        }, 2500L)
    }

    // ─────────────────────────────────────────────────────────────────────────
    private fun sendEvent(eventName: String, params: Map<String, Any>) {
        try {
            val args = Arguments.createMap()
            params.forEach { (k, v) ->
                when (v) {
                    is String  -> args.putString(k, v)
                    is Double  -> args.putDouble(k, v)
                    is Int     -> args.putInt(k, v)
                    is Boolean -> args.putBoolean(k, v)
                }
            }
            reactContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit(eventName, args)
            Log.i(TAG, "sendEvent($eventName) emitted OK")
        } catch (e: Exception) {
            Log.e(TAG, "sendEvent($eventName) failed: ${e.message}")
        }
    }

    override fun onCatalystInstanceDestroy() {
        stop()
        super.onCatalystInstanceDestroy()
    }
}