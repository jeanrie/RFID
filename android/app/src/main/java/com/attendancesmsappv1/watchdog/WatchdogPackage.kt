// C:\Attendance\AttendanceSMS\android\app\src\main\java\com\attendancesmsappv1\watchdog\WatchdogPackage.kt
package com.attendancesmsappv1.watchdog

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

/**
 * WatchdogPackage
 *
 * Registers WatchdogModule with the React Native bridge.
 *
 * Add to MainApplication.kt inside the packageList lambda:
 *
 *   add(com.attendancesmsappv1.watchdog.WatchdogPackage())
 */
class WatchdogPackage : ReactPackage {

    override fun createNativeModules(
        reactContext: ReactApplicationContext
    ): List<NativeModule> = listOf(WatchdogModule(reactContext))

    override fun createViewManagers(
        reactContext: ReactApplicationContext
    ): List<ViewManager<*, *>> = emptyList()
}