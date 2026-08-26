// C:\Attendance\AttendanceSMS\android\app\src\main\java\com\attendancesmsappv1\MainApplication.kt

package com.attendancesmsappv1

import android.app.Application
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost

class MainApplication : Application(), ReactApplication {

  override val reactHost: ReactHost by lazy {
    getDefaultReactHost(
      context = applicationContext,
      packageList =
        PackageList(this).packages.apply {
          add(com.attendancesmsappv1.sms.SmsPackage())
          add(com.attendancesmsappv1.battery.BatteryPackage())
          add(com.attendancesmsappv1.foreground.ForegroundServicePackage())
          add(com.attendancesmsappv1.watchdog.WatchdogPackage())
        },
    )
  }

  override fun onCreate() {
    super.onCreate()
    loadReactNative(this)
  }
}