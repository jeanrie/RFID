// C:\Attendance\AttendanceSMS\android\app\src\main\java\com\attendancesmsappv1\foreground\ForegroundServicePackage.kt

package com.attendancesmsappv1.foreground

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

/**
 * ForegroundServicePackage
 *
 * Registers ForegroundServiceModule with the React Native bridge.
 *
 * Add this to MainApplication.kt inside the packageList block:
 *
 *   add(com.attendancesmsappv1.foreground.ForegroundServicePackage())
 */
class ForegroundServicePackage : ReactPackage {

    override fun createNativeModules(
        reactContext: ReactApplicationContext
    ): List<NativeModule> = listOf(ForegroundServiceModule(reactContext))

    override fun createViewManagers(
        reactContext: ReactApplicationContext
    ): List<ViewManager<*, *>> = emptyList()
}