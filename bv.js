// useForegroundService.js
//
// Thin JS wrapper around the native ForegroundServiceModule (Kotlin).
// Exposes three stable callbacks that MainScreen.js calls:
//
//   startForegroundService()  — starts the persistent Android foreground service
//   stopForegroundService()   — stops it (only called when user presses Stop)
//   updateServiceStatus(text) — updates the notification text
//
// All three are no-ops on iOS or if the native module is unavailable,
// so the app won't crash in a simulator.

import { useCallback } from 'react';
import { NativeModules, Platform } from 'react-native';

const { ForegroundServiceModule } = NativeModules;

export default function useForegroundService() {

  const startForegroundService = useCallback(() => {
    if (Platform.OS !== 'android' || !ForegroundServiceModule) return;
    try { ForegroundServiceModule.startService(); }
    catch (e) { console.error('startForegroundService error:', e); }
  }, []);

  const stopForegroundService = useCallback(() => {
    if (Platform.OS !== 'android' || !ForegroundServiceModule) return;
    try { ForegroundServiceModule.stopService(); }
    catch (e) { console.error('stopForegroundService error:', e); }
  }, []);

  const updateServiceStatus = useCallback((status) => {
    if (Platform.OS !== 'android' || !ForegroundServiceModule) return;
    if (!status) return;
    try { ForegroundServiceModule.updateStatus(String(status)); }
    catch (e) { console.error('updateServiceStatus error:', e); }
  }, []);

  return { startForegroundService, stopForegroundService, updateServiceStatus };
}