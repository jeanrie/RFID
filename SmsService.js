import { NativeModules, Platform } from 'react-native';

const { SmsServiceModule } = NativeModules;

export const startSmsService = () => {
  if (Platform.OS === 'android' && SmsServiceModule?.startService) {
    SmsServiceModule.startService();
  }
};

export const stopSmsService = () => {
  if (Platform.OS === 'android' && SmsServiceModule?.stopService) {
    SmsServiceModule.stopService();
  }
};
