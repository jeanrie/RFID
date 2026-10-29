// useForegroundService.js


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