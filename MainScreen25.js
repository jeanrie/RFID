// MainScreen.js
import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, Platform,
  Image, Alert, Dimensions, Keyboard, TouchableWithoutFeedback,
  PermissionsAndroid, NativeModules, NativeEventEmitter, Vibration, AppState,
} from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import MSSQL from 'react-native-mssql';
import Sound from 'react-native-sound';
import { GoogleSignin } from '@react-native-google-signin/google-signin';
import { fetchAccessToken, sendEmailViaGmailAPI } from './email';
import KeepAwake from 'react-native-keep-awake';
import useForegroundService from './useForegroundService';

const SmsModule      = NativeModules.SmsModule;
const BatteryModule  = NativeModules.BatteryModule;
const WatchdogModule = NativeModules.WatchdogModule;

const { width, height } = Dimensions.get('window');

const WEB_CLIENT_ID =
  '651284152046-22s1bs6beejjmd6jkop35rdi6hsaapqt.apps.googleusercontent.com';


const AUTO_RESTART_INTERVAL_MS    = 3 * 60 * 60 * 1000;  // 3 hours
const WATCHDOG_STUCK_THRESHOLD_MS = 5 * 60 * 1000;       // 5 minutes

const HARD_RESTART_GRACE_MS = 5 * 60 * 1000;

const DB_OP_TIMEOUT_MS = 45 * 1000;

const SMS_OP_TIMEOUT_MS   = 20 * 1000;
const EMAIL_OP_TIMEOUT_MS = 20 * 1000;
const SAFE_CLOSE_TIMEOUT_MS = 10 * 1000;
const RECONNECT_OVERALL_TIMEOUT_MS = 60 * 1000;
const DAILY_RESTART_FIRE_WINDOW_MIN = 5;
const WINDOW_SCHEDULE_FALLBACK_MS = 60 * 1000;
const APP_SHOULD_RUN_KEY = 'appShouldRun';

const SMS_MAX_PROCESSING = 5;
const MAX_ERROR_CYCLES   = 30;

const SIGNAL_NONE    = null;
const SIGNAL_RESTART = 'restart';
const SIGNAL_STOP    = 'stop';


const RESTART_NOTIF_COOLDOWN_MS = 30 * 1000;


const RECONNECT_BACKOFF_BASE_MS = 5 * 1000;
const RECONNECT_BACKOFF_MAX_MS  = 60 * 1000;
const RECONNECT_RENOTIFY_INTERVAL_MS = 5 * 60 * 1000;
const RECONNECT_STUCK_RESTART_MS = 5 * 60 * 1000;


let ACTIVE_LOOP_ID = 0;                    
const GLOBAL_SENDING_SEEDS = new Set();    
const SENT_NUMBERS = new Map();           
const SENT_TS = new Map();                 
const DUPLICATE_LOG_WINDOW_SEC = 60;       

// Admin failure-notice guards 
const INVALID_NOTIFIED = new Set();               // seeds already emailed for an invalid number
const FAIL_NOTIFY_TS = {};                      
const FAIL_NOTIFY_COOLDOWN_MS = 30 * 60 * 1000;   // one email per kind per 30 min


// delivery report can be matched back to a student
const PENDING_DELIVERY = {};
const DELIVERY_NOTIFIED = new Set();              
const PENDING_DELIVERY_TTL_MS = 2 * 60 * 60 * 1000;

// Critical-alert throttle for logs where NO number could be texted
const CRITICAL_ALERTED = new Map();                  
const CRITICAL_REMIND_MS = 6 * 60 * 60 * 1000;       

const SENT_STORE_KEY = 'sentNumbersStore';
const SENT_STORE_TTL_MS = 2 * 24 * 60 * 60 * 1000;
let SENT_STORE_LOADED = false;
let persistChain = Promise.resolve();


const persistSentNumbers = () => {
  persistChain = persistChain.then(async () => {
    const obj = {};
    SENT_NUMBERS.forEach((set, seed) => {
      obj[seed] = { n: [...set], t: SENT_TS.get(seed) || Date.now() };
    });
    await AsyncStorage.setItem(SENT_STORE_KEY, JSON.stringify(obj));
  }).catch((e) => console.warn('persistSentNumbers failed:', e?.message || e));
  return persistChain;
};

// Load once (after a restart/crash)
const loadSentNumbers = async () => {
  if (SENT_STORE_LOADED) return;
  try {
    const raw = await AsyncStorage.getItem(SENT_STORE_KEY);
    if (raw) {
      const obj = JSON.parse(raw);
      const now = Date.now();
      Object.keys(obj).forEach((seed) => {
        const e = obj[seed];
        if (e && Array.isArray(e.n) && now - (e.t || 0) < SENT_STORE_TTL_MS) {
          SENT_NUMBERS.set(seed, new Set(e.n));
          SENT_TS.set(seed, e.t || now);
        }
      });
    }
  } catch (e) { console.warn('loadSentNumbers failed:', e?.message || e); }
  SENT_STORE_LOADED = true;
};

export default function MainScreen() {


  const [isRunning,        setIsRunning]        = useState(false);
  const [isScheduled,      setIsScheduled]      = useState(false);
  const [numStudents,      setNumStudents]      = useState('10');
  const [idleSeconds,      setIdleSeconds]      = useState('20');

  const defaultStart = new Date(); defaultStart.setHours(6,  0, 0, 0);
  const defaultEnd   = new Date(); defaultEnd.setHours(21, 0, 0, 0);
  const [startTime,        setStartTime]        = useState(defaultStart);
  const [endTime,          setEndTime]          = useState(defaultEnd);
  const [showStartPicker,  setShowStartPicker]  = useState(false);
  const [showEndPicker,    setShowEndPicker]    = useState(false);

  const [deviceName,       setDeviceName]       = useState('');
  const [serverName,       setServerName]       = useState('');
  const [databaseName,     setDatabaseName]     = useState('');
  const [username,         setUsername]         = useState('');
  const [password,         setPassword]         = useState('');
  const [arrivalMessage,   setArrivalMessage]   = useState('');
  const [departureMessage, setDepartureMessage] = useState('');
  const [displayDashboard, setDisplayDashboard] = useState(false);
  const [batteryThreshold, setBatteryThreshold] = useState(20);
  const [adminNumbers,     setAdminNumbers]     = useState('');
  const [adminEmails,      setAdminEmails]      = useState('');
  const [cycleCount,       setCycleCount]       = useState(0);
  const [statusMessage,    setStatusMessage]    = useState('');

  //  Foreground service hook 
  const {
    startForegroundService,
    stopForegroundService,
    updateServiceStatus,
  } = useForegroundService();

  
  const isRunningRef             = useRef(false);
  const cycleCountRef            = useRef(0);
  const failedSendsRef           = useRef({});
  const batteryAlertSentRef      = useRef(false);
  const emailQueueRef            = useRef([]);
  const sendingEmailRef          = useRef(false);
  const smsPermissionGrantedRef  = useRef(false);
  const networkErrorSentRef      = useRef(false);

  // Reconnect-stuck escalation refs.
  const reconnectFailStreakRef   = useRef(0);
  const reconnectStuckSinceRef   = useRef(0);
  const lastNetworkErrorNotifRef = useRef(0);

  
  const restartSignalRef         = useRef(SIGNAL_NONE);
  const restartReasonRef         = useRef('');
  const coordinatorRunningRef    = useRef(false);
  const coordinatorRestartingRef = useRef(false);
  const restartStartNotifiedRef  = useRef(false);
  const lastRestartNotifSentAtRef = useRef(0);

  // JS-side fallback restart timers 
  const loopStartTimestampRef        = useRef(0);
  const dailyStartRestartFiredDateRef = useRef(null);
  const dailyEndRestartFiredDateRef   = useRef(null);


  const autoStartAttemptedRef    = useRef(false);

  // SMS-window scheduler refs
  const windowSchedulerActiveRef = useRef(false);
  const windowScheduleTimeoutRef = useRef(null);
  const applyWindowScheduleRef   = useRef(() => {});
  const windowNotifSentRef       = useRef({ open: false, close: false });

  const activatingRef            = useRef(false);

  const watchdogSubsRef          = useRef([]);

  const serverNameRef       = useRef(serverName);
  const usernameRef         = useRef(username);
  const passwordRef         = useRef(password);
  const databaseNameRef     = useRef(databaseName);
  const deviceNameRef       = useRef(deviceName);
  const adminNumbersRef     = useRef(adminNumbers);
  const adminEmailsRef      = useRef(adminEmails);
  const batteryThresholdRef = useRef(batteryThreshold);
  const numStudentsRef      = useRef(numStudents);
  const idleSecondsRef      = useRef(idleSeconds);
  const startTimeRef        = useRef(startTime);
  const endTimeRef          = useRef(endTime);
  const arrivalMessageRef   = useRef(arrivalMessage);
  const departureMessageRef = useRef(departureMessage);

  useEffect(() => { serverNameRef.current       = serverName;       }, [serverName]);
  useEffect(() => { usernameRef.current         = username;         }, [username]);
  useEffect(() => { passwordRef.current         = password;         }, [password]);
  useEffect(() => { databaseNameRef.current     = databaseName;     }, [databaseName]);
  useEffect(() => { deviceNameRef.current       = deviceName;       }, [deviceName]);
  useEffect(() => { adminNumbersRef.current     = adminNumbers;     }, [adminNumbers]);
  useEffect(() => { adminEmailsRef.current      = adminEmails;      }, [adminEmails]);
  useEffect(() => { batteryThresholdRef.current = batteryThreshold; }, [batteryThreshold]);
  useEffect(() => { numStudentsRef.current      = numStudents;      }, [numStudents]);
  useEffect(() => { idleSecondsRef.current      = idleSeconds;      }, [idleSeconds]);
  useEffect(() => { startTimeRef.current        = startTime;        }, [startTime]);
  useEffect(() => { endTimeRef.current          = endTime;          }, [endTime]);
  useEffect(() => { arrivalMessageRef.current   = arrivalMessage;   }, [arrivalMessage]);
  useEffect(() => { departureMessageRef.current = departureMessage; }, [departureMessage]);
  useEffect(() => { isRunningRef.current        = isRunning;        }, [isRunning]);


  useEffect(() => {
    try { WatchdogModule?.updateEmergencyContacts?.(adminNumbers || '', deviceName || ''); }
    catch {}
  }, [adminNumbers, deviceName]);

  // Keep the native watchdog's daily-restart window in sync with the SMS window.
  useEffect(() => {
    if (!isRunningRef.current) return;
    try {
      WatchdogModule?.updateDailyRestartWindow?.(
        startTime.getHours(), startTime.getMinutes(),
        endTime.getHours(),   endTime.getMinutes(),
      );
    } catch {}
  }, [startTime, endTime]);

  useEffect(() => {
    if (windowSchedulerActiveRef.current) {
      applyWindowScheduleRef.current?.();
    }
  }, [startTime, endTime]);


  useEffect(() => {
    KeepAwake.activate();
    return () => { KeepAwake.deactivate(); };
  }, []);


  useEffect(() => {
    const sub = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') {
        if (isRunningRef.current) startForegroundService();
        applyWindowScheduleRef.current?.();
      }
    });
    return () => sub.remove();
  }, [startForegroundService]);

  // Battery optimization 
  useEffect(() => {
    (async () => {
      try {
        const prompted = await AsyncStorage.getItem('batteryOptPrompted');
        if (!prompted && Platform.OS === 'android') {
          await AsyncStorage.setItem('batteryOptPrompted', '1');
          Alert.alert(
            '⚡ Allow Background Operation',
            'To keep this app running 24/7, please go to:\n\n' +
            'Settings → Apps → AttendanceSMSApp → Battery → "Unrestricted"\n\n' +
            'This prevents Android from stopping the app at night.',
            [{ text: 'OK' }]
          );
        }
      } catch {}
    })();
  }, []);

 
  useEffect(() => {
    const GlobalErrorUtils = global.ErrorUtils;
    if (!GlobalErrorUtils || !GlobalErrorUtils.setGlobalHandler) return;

    const previousHandler =
      GlobalErrorUtils.getGlobalHandler && GlobalErrorUtils.getGlobalHandler();

    const emergencyCrashHandler = (error, isFatal) => {
      console.error(
        `🔥 GLOBAL JS ERROR${isFatal ? ' (FATAL)' : ' (non-fatal)'}:`,
        error
      );

      if (isFatal) {
        try {
          const nums = getValidNumbers(adminNumbersRef.current);
          const devName = deviceNameRef.current || 'device';
          const errText = String(error?.message || error || 'Unknown error').slice(0, 300);
          const msg =
            `💥 APP CRASHED — ${devName}\n\n` +
            `${errText}\n\n` +
            `The app may close or restart now. Please check the device ` +
            `and make sure the SMS process is still running.`;

  
          if (nums.length > 0 && SmsModule?.sendSMS) {
            nums.forEach((num) => {
              try { SmsModule.sendSMS(num, msg).catch(() => {}); } catch {}
            });
          }
        } catch (notifyErr) {
          console.error('Emergency crash SMS attempt failed:', notifyErr);
        }
      }

      if (previousHandler) previousHandler(error, isFatal);
    };

    GlobalErrorUtils.setGlobalHandler(emergencyCrashHandler);

    return () => {
      if (previousHandler) GlobalErrorUtils.setGlobalHandler(previousHandler);
    };
  }, []);

  // Google Sign-In
  useEffect(() => {
    (async () => {
      try {
        GoogleSignin.configure({
          webClientId: WEB_CLIENT_ID,
          offlineAccess: true,
          scopes: ['email', 'profile', 'https://mail.google.com/'],
        });
        await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
        const user = await GoogleSignin.getCurrentUser();
        if (!user) await GoogleSignin.signIn();
      } catch (err) { console.error('Google Sign-In init error:', err); }
    })();
  }, []);


  useEffect(() => {
    if (!SmsModule || Platform.OS !== 'android') return;
    const emitter = new NativeEventEmitter(SmsModule);
    const sub = emitter.addListener('smsDeliveryReport', (e) => {
      try {
        const info = PENDING_DELIVERY[e?.number];
        if (!info) return;                       // not a parent SMS (e.g. admin alert)
        delete PENDING_DELIVERY[e.number];
        if (!e.permanentFail) return;            // delivered or unknown 

        const key = `${info.seed}|${e.number}`;
        if (DELIVERY_NOTIFIED.has(key)) return;
        DELIVERY_NOTIFIED.add(key);

        console.warn(`Delivery FAILED for ${e.number} (status ${e.status})`);

        if (adminEmailsRef.current?.trim()) {
          queueEmailStable(
            'SMS Delivery Failed - Parent Number',
            `SMS DELIVERY FAILED\n\n` +
            `Student: ${info.studentName}\n` +
            `Parent/Guardian Number: ${e.number}\n` +
            `Device: ${deviceNameRef.current}\n\n` +
            `The carrier accepted the SMS for processing, but the message was not successfully delivered ` +
            `(carrier status code: ${e.status}).\n\n` +
            `Possible reasons include an inactive or unreachable number, network-related issues, ` +
            `or other carrier restrictions.\n\n` +
            `The message will not be automatically retried. Please verify the parent/guardian number ` +
            `in the student record and update it if necessary.`
          );
        }
      } catch (err) { console.warn('delivery report handler failed:', err?.message || err); }
    });
    return () => { try { sub.remove(); } catch {} };

  }, []);

  // ── Load saved config ────────────────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const saved = await AsyncStorage.getItem('appConfig');
        if (saved) {
          const c = JSON.parse(saved);
          setDeviceName(c.deviceName || '');
          setServerName(c.serverName || '');
          setDatabaseName(c.databaseName || '');
          setUsername(c.username || '');
          setPassword(c.password || '');
          setArrivalMessage(c.arrivalMessage || '');
          setDepartureMessage(c.departureMessage || '');
          setDisplayDashboard(!!c.displayDashboard);
          setBatteryThreshold(c.batteryThreshold || 20);
          setAdminNumbers(c.adminNumbers || '');
          setAdminEmails(c.adminEmails || '');
          if (c.smsStartTime) {
            const d = new Date(c.smsStartTime);
            if (!isNaN(d.getTime())) setStartTime(d);
          }
          if (c.smsEndTime) {
            const d = new Date(c.smsEndTime);
            if (!isNaN(d.getTime())) setEndTime(d);
          }
        }
      } catch (err) { console.error('Failed to load config:', err); }
    })();
  }, []);


  useEffect(() => {
    (async () => {
      try {
        const saved = await AsyncStorage.getItem('appConfig');
        const c = saved ? JSON.parse(saved) : {};
        c.smsStartTime = startTime.toISOString();
        c.smsEndTime   = endTime.toISOString();
        await AsyncStorage.setItem('appConfig', JSON.stringify(c));
      } catch (err) { console.error('Failed to persist SMS window:', err); }
    })();
  }, [startTime, endTime]);

  
  useEffect(() => {
    const id = setInterval(() => {
      applyWindowScheduleRef.current?.();
    }, WINDOW_SCHEDULE_FALLBACK_MS);
    return () => clearInterval(id);
  }, []);

 
  useEffect(() => {
    return () => {
      _unsubscribeWatchdog();
      WatchdogModule?.stop?.();
      restartSignalRef.current = SIGNAL_STOP;
      if (windowScheduleTimeoutRef.current) clearTimeout(windowScheduleTimeoutRef.current);
    };

  }, []);

 
  useEffect(() => {
    (async () => {
      if (autoStartAttemptedRef.current) return;
      autoStartAttemptedRef.current = true;
      try {
        const shouldRun = await AsyncStorage.getItem(APP_SHOULD_RUN_KEY);
        if (shouldRun !== 'true') return;

        const saved = await AsyncStorage.getItem('appConfig');
        const c = saved ? JSON.parse(saved) : {};
        if (!c.deviceName || !c.serverName || !c.databaseName) {
          console.log('Auto-resume skipped: config incomplete');
          return;
        }

        await sleep(300);

        console.log('🔁 Auto-resuming SMS schedule (was on duty before restart)');
        await doStart();
      } catch (err) {
        console.error('Auto-resume check failed:', err);
      }
    })();

  }, [doStart]);

  const navigation = useNavigation();

  const errorSound = new Sound('alert.mp3', Sound.MAIN_BUNDLE, (err) => {
    if (err && __DEV__) console.error('Failed to load sound', err);
  });


  const sleep        = (ms) => new Promise(r => setTimeout(r, ms));
  const isValidPhone = (num) => /^(?:\+63|0)9\d{9}$/.test(num);

  // Normalize (+63 → 0) and de-duplicate, so "+63917..." and "0917..." count

  const normalizePhone = (n) => n.replace(/^\+63/, '0');
  const uniqueNumbers  = (arr) =>
    [...new Set(arr.map(n => String(n).trim()).filter(isValidPhone).map(normalizePhone))];

  const getValidNumbers = (raw) =>
    raw ? uniqueNumbers(raw.split(/[,;]+/)) : [];


  const withTimeout = (promise, ms, label) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`${label} timed out after ${ms}ms`));
      }, ms);
      Promise.resolve(promise).then(
        (v) => { clearTimeout(timer); resolve(v); },
        (e) => { clearTimeout(timer); reject(e); }
      );
    });

  // DB helpers
  const dbUpdate = useCallback((sql) =>
    withTimeout(MSSQL.executeUpdate(sql), DB_OP_TIMEOUT_MS, 'DB update'), []);
  const dbQuery = useCallback((sql) =>
    withTimeout(MSSQL.executeQuery(sql), DB_OP_TIMEOUT_MS, 'DB query'), []);

  const formatTime = (time) => {
    const h = time.getHours(), m = time.getMinutes(), ampm = h >= 12 ? 'PM' : 'AM';
    return `${h % 12 || 12}:${m < 10 ? '0' + m : m} ${ampm}`;
  };

 
  const pad2 = (n) => (n < 10 ? '0' + n : String(n));
  const formatSqlTime = (date) => `${pad2(date.getHours())}:${pad2(date.getMinutes())}:00`;

  const formatLogDateTime = (sqlDate, sqlTime) => {
    try {
      const dt = new Date(`${sqlDate.split(' ')[0]}T${sqlTime}`);
      return `${dt.toLocaleTimeString('en-US', {
        hour: '2-digit', minute: '2-digit', hour12: true,
      }).toLowerCase()} ${dt.toLocaleDateString('en-US', {
        year: 'numeric', month: 'long', day: 'numeric',
      })}`;
    } catch { return sqlTime; }
  };

  const getBatteryLevel = async () => {
    try { return BatteryModule?.getLevel ? await BatteryModule.getLevel() : 100; }
    catch { return 100; }
  };

  // MSSQL.close() with a timeout 
  const safeClose = async () => {
    try {
      if (MSSQL?.close) {
        await withTimeout(MSSQL.close(), SAFE_CLOSE_TIMEOUT_MS, 'MSSQL.close');
      }
    } catch (e) {
      console.error('safeClose (ignored, continuing):', e?.message || e);
    }
  };

  // SMS window check 
  const isSmsWindowOpen = useCallback(() => {
    const now      = new Date();
    const nowMin   = now.getHours() * 60 + now.getMinutes();
    const st       = startTimeRef.current;
    const et       = endTimeRef.current;
    const startMin = st.getHours() * 60 + st.getMinutes();
    const endMin   = et.getHours() * 60 + et.getMinutes();
    return nowMin >= startMin && nowMin < endMin;
  }, []);

  // Validates a LOG RECORD's own `time` field against the configured window.
  const isLogTimeWithinWindow = useCallback((logTimeStr) => {
    if (!logTimeStr) return false;
    const parts = String(logTimeStr).split(':');
    const h = parseInt(parts[0], 10);
    const m = parseInt(parts[1], 10);
    if (isNaN(h) || isNaN(m)) return false;
    const logMin   = h * 60 + m;
    const st       = startTimeRef.current;
    const et       = endTimeRef.current;
    const startMin = st.getHours() * 60 + st.getMinutes();
    const endMin   = et.getHours() * 60 + et.getMinutes();
    return logMin >= startMin && logMin < endMin;
  }, []);

  const msUntilNextBoundary = useCallback(() => {
    const now = new Date();
    const st  = startTimeRef.current;
    const et  = endTimeRef.current;

    const mkToday = (h, m) => { const d = new Date(now); d.setHours(h, m, 0, 0); return d; };
    let startDt = mkToday(st.getHours(), st.getMinutes());
    let endDt   = mkToday(et.getHours(), et.getMinutes());

    if (startDt.getTime() <= now.getTime()) startDt = new Date(startDt.getTime() + 24 * 60 * 60 * 1000);
    if (endDt.getTime()   <= now.getTime()) endDt   = new Date(endDt.getTime()   + 24 * 60 * 60 * 1000);

    return Math.min(startDt.getTime(), endDt.getTime()) - now.getTime();
  }, []);


  const _requestRestart = useCallback((reason) => {
    if (restartSignalRef.current !== SIGNAL_NONE) return;
    console.log(`📨 Restart requested: ${reason}`);
    restartReasonRef.current  = reason;
    restartSignalRef.current  = SIGNAL_RESTART;
  }, []);

  const _requestStop = useCallback(() => {
    restartReasonRef.current = '';
    restartSignalRef.current = SIGNAL_STOP;
  }, []);


  const _subscribeWatchdog = useCallback(() => {
    if (!WatchdogModule) return;
    _unsubscribeWatchdog();

    const emitter = new NativeEventEmitter(WatchdogModule);

    const s1 = emitter.addListener('watchdogAlert', async (e) => {
      if (!isRunningRef.current) return;
      if (coordinatorRestartingRef.current) return;
      if (restartSignalRef.current !== SIGNAL_NONE) return;

      const reason = e.reason || 'Watchdog: no heartbeat';
      const mins   = Math.round((e.elapsedMs || 0) / 60000);
      console.warn(`🚨 Native watchdog alert: ${reason}`);

      const stuckMsg =
        `🚨 SMS LOOP STUCK (NATIVE WATCHDOG) 🚨\n\n` +
        `Device: ${deviceNameRef.current}\n\n` +
        `The JS main loop has not pinged the native watchdog for ${mins} minutes.\n` +
        `This usually means a DB/SMS call stalled. A soft restart is being ` +
        `triggered now; if it doesn't recover, the app will force-restart itself.`;

      updateServiceStatus(`⚠️ Loop stuck ${mins}m — restarting`);
      const stuckNowTs = Date.now();
      if (stuckNowTs - lastRestartNotifSentAtRef.current >= RESTART_NOTIF_COOLDOWN_MS) {
        lastRestartNotifSentAtRef.current = stuckNowTs;
        if (adminEmailsRef.current?.trim()) {
          try { queueEmailStable('🚨 SMS Loop Stuck (Native Watchdog)', stuckMsg); } catch {}
        }
        if (isSmsWindowOpen()) {
          const nums = getValidNumbers(adminNumbersRef.current);
          if (nums.length > 0) {
            try { await withTimeout(sendSMSStable(nums, stuckMsg), SMS_OP_TIMEOUT_MS, 'alert SMS'); }
            catch (err) { console.warn('Alert SMS failed/timed out:', err?.message); }
          }
        }
      } else {
        console.log('🔕 Suppressing duplicate LOOP STUCK notice (cooldown)');
      }
      restartStartNotifiedRef.current = true;
      _requestRestart(reason);
    });

    const s2 = emitter.addListener('autoRestartDue', (e) => {
      if (!isRunningRef.current) return;
      if (coordinatorRestartingRef.current) return;
      if (restartSignalRef.current !== SIGNAL_NONE) return;
      const reason = e.reason || 'Scheduled 3hr auto-restart';
      console.log(`🔄 Native auto-restart event: ${reason}`);
      _requestRestart(reason);
    });

    const s3 = emitter.addListener('dailyRestartDue', (e) => {
      if (!isRunningRef.current) return;
      if (coordinatorRestartingRef.current) return;
      if (restartSignalRef.current !== SIGNAL_NONE) return;
      const boundary = e.boundary ? ` (${e.boundary} boundary)` : '';
      const reason = e.reason || `Daily restart (native)${boundary}`;
      console.log(`🌅 Native daily restart event${boundary}: ${reason}`);
      _requestRestart(reason);
    });


    const s4 = emitter.addListener('hardRestartTriggered', (e) => {
      console.error(`💀 Native hard-restart triggered: ${e.reason || ''}`);
    });

    watchdogSubsRef.current = [s1, s2, s3, s4];
  
  }, [_requestRestart, updateServiceStatus, isSmsWindowOpen]);

  const _unsubscribeWatchdog = useCallback(() => {
    watchdogSubsRef.current.forEach(s => { try { s.remove(); } catch {} });
    watchdogSubsRef.current = [];
  }, []);


  useEffect(() => {
    _subscribeWatchdog();
    return () => { _unsubscribeWatchdog(); };

  }, []);

  const _startNativeWatchdog = useCallback(() => {
    if (!WatchdogModule) {
      console.warn('WatchdogModule not available');
      return;
    }
    WatchdogModule.start(
      WATCHDOG_STUCK_THRESHOLD_MS,
      AUTO_RESTART_INTERVAL_MS,
      startTimeRef.current.getHours(),
      startTimeRef.current.getMinutes(),
      endTimeRef.current.getHours(),
      endTimeRef.current.getMinutes(),
      HARD_RESTART_GRACE_MS,
      adminNumbersRef.current || '',
      deviceNameRef.current || '',
    );
    console.log(
      `✅ Native watchdog started (daily restarts @ ${formatTime(startTimeRef.current)} & ` +
      `${formatTime(endTimeRef.current)}, hard-restart backstop enabled)`
    );
  }, [_subscribeWatchdog]);

  const _stopNativeWatchdog = useCallback(() => {
    try { WatchdogModule?.stop?.(); } catch {}
  }, []);

  const ensureSmsPermission = useCallback(async () => {
    if (smsPermissionGrantedRef.current) return true;
    if (Platform.OS !== 'android') return true;
    const perm = PermissionsAndroid.PERMISSIONS.SEND_SMS;
    if (await PermissionsAndroid.check(perm)) {
      smsPermissionGrantedRef.current = true; return true;
    }
    const r = await PermissionsAndroid.request(perm, {
      title: 'SMS Permission', message: 'App needs to send SMS.', buttonPositive: 'OK',
    });
    if (r === PermissionsAndroid.RESULTS.GRANTED) {
      smsPermissionGrantedRef.current = true; return true;
    }
    return false;
  }, []);


  const sendSMSStable = useCallback(async (numbers = [], message, doneSet = null, persist = null, failInfo = null) => {
    try {
      if (!await ensureSmsPermission()) {
        if (failInfo) failInfo.__permission = true;
        return false;
      }
      if (!Array.isArray(numbers) || numbers.length === 0 || !message) return true;
      const valid = numbers.filter(isValidPhone);
      if (valid.length === 0) return true;
      let allOk = true;
      for (const num of valid) {
        if (doneSet?.has(num)) continue;           

    
        doneSet?.add(num);
        if (persist) await persist();

        try {
          const r = await withTimeout(
            SmsModule.sendSMS(num, message), SMS_OP_TIMEOUT_MS, 'SmsModule.sendSMS'
          );
          if (!(r && r.success)) {
            doneSet?.delete(num);                    
            if (persist) await persist();
            if (failInfo) failInfo[num] = { code: r?.code ?? 0, reason: r?.reason || 'UNKNOWN' };
            allOk = false;
          }
          await sleep(1500);
        } catch (e) {
          const m = String(e?.message || e);
          if (m.includes('timed out') || e?.code === 'SMS_SENT_TIMEOUT') {
            console.warn(`SMS to ${num} unconfirmed — assuming sent (no resend)`);
           
          } else {
            console.error(`SMS error on ${num}`, e);
            doneSet?.delete(num);                      
            if (persist) await persist();
            if (failInfo) failInfo[num] = { code: -1, reason: m };
            allOk = false;
          }
        }
      }
      return allOk;
    } catch (e) { console.error('sendSMS fatal:', e); return false; }
  }, [ensureSmsPermission]);


  const processEmailQueue = useCallback(async () => {
    if (sendingEmailRef.current) return;
    sendingEmailRef.current = true;
    try {
      const recipients = (adminEmailsRef.current || '')
        .split(/[;,]+/).map(s => s.trim()).filter(Boolean);
      if (recipients.length === 0) { emailQueueRef.current = []; return; }
      const accessToken = await withTimeout(fetchAccessToken(), EMAIL_OP_TIMEOUT_MS, 'fetchAccessToken');
      if (!accessToken) return;
      while (emailQueueRef.current.length > 0) {
        const { subject, message } = emailQueueRef.current[0];
        const ok = await withTimeout(
          sendEmailViaGmailAPI(recipients.join(','), subject, message, accessToken),
          EMAIL_OP_TIMEOUT_MS,
          'sendEmailViaGmailAPI'
        );
        if (ok) emailQueueRef.current.shift(); else break;
      }
    } catch (e) {
      console.error('processEmailQueue failed/timed out:', e?.message);
    } finally { sendingEmailRef.current = false; }
  }, []);

  const queueEmailStable = useCallback((subject, message) => {
    emailQueueRef.current.push({ subject, message });
    processEmailQueue();
  }, [processEmailQueue]);


  const reconnect = useCallback(async () => {
    await withTimeout((async () => {
      await safeClose();
      await sleep(1000);
      await withTimeout(MSSQL.connect({
        server:   serverNameRef.current,
        username: usernameRef.current,
        password: passwordRef.current,
        database: databaseNameRef.current,
        port:     1433,
        timeout:  15,
      }), DB_OP_TIMEOUT_MS, 'MSSQL.connect');
    })(), RECONNECT_OVERALL_TIMEOUT_MS, 'reconnect');
  }, []);

  // Final mark (smssent=1) AFTER the send, with retries.
  const markSent = useCallback(async (seed, devName) => {
    for (let i = 0; i < 3; i++) {
      try {
        await dbUpdate(
          `UPDATE logs SET smssent=1, smsmac='${devName}', smssenttime=GETDATE(),` +
          ` smsprocessing=ISNULL(smsprocessing,0)+1 WHERE seed='${seed}'`
        );
        return true;
      } catch (e) {
        console.error(`markSent attempt ${i + 1} failed:`, e?.message || e);
        await sleep(1000);
      }
    }
    return false;
  }, [dbUpdate]);


  const lockSending = useCallback(async (seed, devName) => {
    const rows = await dbQuery(
      `UPDATE logs SET smssenttime=GETDATE()
       OUTPUT inserted.seed
       WHERE seed='${seed}' AND smssent=0 AND smssenttime IS NULL AND smsmac='${devName}';`
    );
    return Array.isArray(rows) && rows.length > 0;
  }, [dbQuery]);

  // Definite fail: release the lock so the log can be retried.
  const releaseLock = useCallback(async (seed, devName) => {
    for (let i = 0; i < 2; i++) {
      try {
        await dbUpdate(
          `UPDATE logs SET smssenttime=NULL, smsprocessing=ISNULL(smsprocessing,0)+1` +
          ` WHERE seed='${seed}' AND smsmac='${devName}' AND smssent=0`
        );
        return;
      } catch (e) { console.error('releaseLock failed:', e?.message || e); }
    }
  }, [dbUpdate]);

  
  const recoverStaleLocks = useCallback(async (devName) => {
    try {
      await dbUpdate(
        `UPDATE logs SET smssenttime=NULL
         WHERE smssent=0 AND smssenttime IS NOT NULL AND smsmac='${devName}'
           AND CONVERT(VARCHAR(10),date,120)=CONVERT(VARCHAR(10),GETDATE(),120)
           AND smssenttime < DATEADD(MINUTE,-5,GETDATE())`
      );
    } catch (e) { console.warn('recoverStaleLocks failed:', e?.message || e); }
  }, [dbUpdate]);

  const isDuplicateLog = useCallback(async (log) => {
    try {
      const rows = await dbQuery(
        `SELECT TOP 1 seed FROM logs
         WHERE studentid='${log.studentid}' AND trans='${log.trans}'
           AND seed<>'${log.seed}' AND smssent=1
           AND CONVERT(VARCHAR(10),date,120)=CONVERT(VARCHAR(10),GETDATE(),120)
           AND ABS(DATEDIFF(SECOND, CONVERT(TIME,time), CONVERT(TIME,'${log.time}'))) <= ${DUPLICATE_LOG_WINDOW_SEC}`
      );
      return Array.isArray(rows) && rows.length > 0;
    } catch { return false; }
  }, [dbQuery]);


  const handleMaxFailures = useCallback(async (log, validNumbers, studentName, failedThisCycle, devName) => {
    const seed = log.seed;
    const done = SENT_NUMBERS.get(seed);
    const sentNums   = validNumbers.filter(n => done?.has(n));
    const missedNums = validNumbers.filter(n => !done?.has(n));
    delete failedSendsRef.current[seed];

    if (sentNums.length > 0) {
      const marked = await markSent(seed, devName);
      if (marked) {
        SENT_NUMBERS.delete(seed);
        SENT_TS.delete(seed);
        await persistSentNumbers();
      }
      failedThisCycle.push({ studentName, seed, partial: { sent: sentNums, missed: missedNums } });
    } else {
      failedThisCycle.push({ studentName, seed });
    }
  }, [markSent]);

  const notifyNetworkError = useCallback(async (errorMsg) => {
    try {
      const msg =
        `NETWORK/SERVER ERROR\n\n` +
        `Device: ${deviceNameRef.current}\n\n` +
        `Error:\n${errorMsg}\n\n` +
        `The device cannot connect to the server.`;
      if (adminEmailsRef.current?.trim()) queueEmailStable('Network/Server Error', msg);
      if (isSmsWindowOpen()) {
        const nums = getValidNumbers(adminNumbersRef.current);
        if (nums.length > 0) await sendSMSStable(nums, msg);
      }
    } catch (e) { console.log('notifyNetworkError failed:', e); }
  }, [sendSMSStable, queueEmailStable, isSmsWindowOpen]);

  
  const notifySmsWindowOpen = useCallback(async () => {
    if (windowNotifSentRef.current.open) return;
    windowNotifSentRef.current.open  = true;
    windowNotifSentRef.current.close = false;
    const st = startTimeRef.current, et = endTimeRef.current;
    const msg =
      `🌅 SMS WINDOW OPENED — PROCESS STARTED\n\n` +
      `Device: ${deviceNameRef.current}\n` +
      `The SMS process has automatically started, ` +
      `active ${formatTime(st)} – ${formatTime(et)}.`;
    updateServiceStatus(`📨 SMS window open — sending enabled`);
    if (adminEmailsRef.current?.trim()) queueEmailStable('SMS Window Opened', msg);
    const nums = getValidNumbers(adminNumbersRef.current);
    if (nums.length > 0) { try { await sendSMSStable(nums, msg); } catch {} }
  }, [sendSMSStable, queueEmailStable, updateServiceStatus]);

  const notifySmsWindowClose = useCallback(async () => {
    if (windowNotifSentRef.current.close) return;
    windowNotifSentRef.current.close = true;
    windowNotifSentRef.current.open  = false;
    const st = startTimeRef.current;
    const msg =
      `🌙 SMS WINDOW CLOSED — PROCESS STOPPED\n\n` +
      `Device: ${deviceNameRef.current}\n` +
      `The SMS process has automatically stopped. ` +
      `It will automatically start again at ${formatTime(st)}.\n` +
      `Email notifications continue 24/7.`;
    updateServiceStatus(`😴 Stopped — resumes ${formatTime(st)}`);
    if (adminEmailsRef.current?.trim()) queueEmailStable('SMS Window Closed', msg);
  }, [queueEmailStable, updateServiceStatus]);


  const runLoop = useCallback(async () => {
    const limit   = parseInt(numStudentsRef.current, 10) || 5;
    const idleMs  = (parseInt(idleSecondsRef.current, 10) || 5) * 1000;
    const devName = deviceNameRef.current;

    setStatusMessage('Starting SMS process...');
    updateServiceStatus('Starting SMS process...');

    loopStartTimestampRef.current = Date.now();
    const myLoopId = ++ACTIVE_LOOP_ID;    

   
    {
      const nowAtLoopStart  = new Date();
      const todayKeyAtStart = nowAtLoopStart.toDateString();
      const nowMinAtStart   = nowAtLoopStart.getHours() * 60 + nowAtLoopStart.getMinutes();
      const stAtStart = startTimeRef.current;
      const etAtStart = endTimeRef.current;
      const startBoundaryMinAtStart = stAtStart.getHours() * 60 + stAtStart.getMinutes();
      const endBoundaryMinAtStart   = etAtStart.getHours() * 60 + etAtStart.getMinutes();

      if (nowMinAtStart >= startBoundaryMinAtStart &&
          nowMinAtStart < startBoundaryMinAtStart + DAILY_RESTART_FIRE_WINDOW_MIN) {
        dailyStartRestartFiredDateRef.current = todayKeyAtStart;
      }
      if (nowMinAtStart >= endBoundaryMinAtStart &&
          nowMinAtStart < endBoundaryMinAtStart + DAILY_RESTART_FIRE_WINDOW_MIN) {
        dailyEndRestartFiredDateRef.current = todayKeyAtStart;
      }
    }

    reconnectFailStreakRef.current   = 0;
    reconnectStuckSinceRef.current   = 0;
    lastNetworkErrorNotifRef.current = 0;

    try {
    
      try {
        await reconnect();
      } catch (initialConnectErr) {
        console.error('Initial connect failed — deferring to in-loop recovery logic:',
          initialConnectErr?.message || initialConnectErr);
      }

      
      await loadSentNumbers();
      try { await recoverStaleLocks(devName); } catch {}

      while (restartSignalRef.current === SIGNAL_NONE && myLoopId === ACTIVE_LOOP_ID) {

        
        try { WatchdogModule?.pingHeartbeat?.(); } catch {}

       
        if (Date.now() - loopStartTimestampRef.current >= AUTO_RESTART_INTERVAL_MS) {
          _requestRestart('JS fallback: 3-hour interval elapsed (native timer did not fire)');
        }

        if (restartSignalRef.current === SIGNAL_NONE) {
          const nowDt    = new Date();
          const todayKey = nowDt.toDateString();
          const nowMinutesOfDay = nowDt.getHours() * 60 + nowDt.getMinutes();
          const st = startTimeRef.current;
          const et = endTimeRef.current;
          const startBoundaryMin = st.getHours() * 60 + st.getMinutes();
          const endBoundaryMin   = et.getHours() * 60 + et.getMinutes();

          if (restartSignalRef.current === SIGNAL_NONE &&
              nowMinutesOfDay >= startBoundaryMin &&
              nowMinutesOfDay < startBoundaryMin + DAILY_RESTART_FIRE_WINDOW_MIN &&
              dailyStartRestartFiredDateRef.current !== todayKey) {
            dailyStartRestartFiredDateRef.current = todayKey;
            _requestRestart(`JS fallback: daily restart at SMS window start (${formatTime(st)})`);
          }

          if (restartSignalRef.current === SIGNAL_NONE &&
              nowMinutesOfDay >= endBoundaryMin &&
              nowMinutesOfDay < endBoundaryMin + DAILY_RESTART_FIRE_WINDOW_MIN &&
              dailyEndRestartFiredDateRef.current !== todayKey) {
            dailyEndRestartFiredDateRef.current = todayKey;
            _requestRestart(`JS fallback: daily restart at SMS window end (${formatTime(et)})`);
          }
        }

        if (restartSignalRef.current !== SIGNAL_NONE) break;

       
        const startHH = formatSqlTime(startTimeRef.current);
        const endHH   = formatSqlTime(endTimeRef.current);

        try {
         
          await dbUpdate(`
            UPDATE logs SET smsmac='${devName}'
            WHERE seed IN (
              SELECT TOP (${limit}) seed FROM logs
              WHERE smssent=0 AND smssenttime IS NULL AND (smsmac IS NULL OR smsmac='')
                AND CONVERT(VARCHAR(10),date,120)=CONVERT(VARCHAR(10),GETDATE(),120)
                AND time >= '${startHH}' AND time < '${endHH}'
              ORDER BY smsprocessing ASC, date ASC, time ASC)`);

          const claimed = await dbQuery(`
            SELECT TOP (${limit})
              l.seed, l.studentid, l.date, l.time, l.trans,
              ISNULL(l.smsprocessing,0) as smsprocessing,
              s.studentname, s.smsnotify, s.yearlevel, s.section
            FROM logs l
            INNER JOIN student s ON l.studentid=s.studentid
            WHERE l.smssent=0 AND l.smssenttime IS NULL AND l.smsmac='${devName}'
              AND CONVERT(VARCHAR(10),l.date,120)=CONVERT(VARCHAR(10),GETDATE(),120)
              AND l.time >= '${startHH}' AND l.time < '${endHH}'
            ORDER BY l.smsprocessing ASC, l.date ASC, l.time ASC;`);

          try { WatchdogModule?.pingHeartbeat?.(); } catch {}

          if (!claimed || claimed.length === 0) {
          
            cycleCountRef.current += 1;
            setCycleCount(cycleCountRef.current);
            setStatusMessage(
              `No new records. Idle cycle ${cycleCountRef.current} — waiting ${idleSecondsRef.current}s...`
            );
            if (cycleCountRef.current % 10 === 0) {
              updateServiceStatus(`Idle cycle ${cycleCountRef.current} — sending active`);
              await recoverStaleLocks(devName);
            }

          } else {
           
            cycleCountRef.current = 0;
            setCycleCount(0);
            updateServiceStatus(`Processing ${claimed.length} record(s)...`);

            const failedThisCycle = [];

            for (const log of claimed) {
              if (restartSignalRef.current !== SIGNAL_NONE || myLoopId !== ACTIVE_LOOP_ID) break;

              // Outside the window 
              if (!isSmsWindowOpen() || !isLogTimeWithinWindow(log.time)) {
                try {
                  await dbUpdate(
                    `UPDATE logs SET smsmac=NULL WHERE seed='${log.seed}' AND smssent=0 AND smssenttime IS NULL`
                  );
                } catch {}
                continue;
              }

              if (GLOBAL_SENDING_SEEDS.has(log.seed)) continue;
              GLOBAL_SENDING_SEEDS.add(log.seed);

              try {
                const studentName = log.studentname || 'Student';
                const trans       = log.trans || '';
                const fmtDT       = formatLogDateTime(log.date, log.time);
                const yr          = log.yearlevel || '';
                const sec         = log.section   || '';

                const tpl = trans === 'TI' ? arrivalMessageRef.current
                          : trans === 'TO' ? departureMessageRef.current
                          : null;
                const message = tpl
                  ? tpl.replace('{student}', studentName).replace('{time}', fmtDT)
                      .replace('{year}', yr).replace('{section}', sec)
                  : `${studentName} ${trans} at ${fmtDT}.`;

                const validNumbers = uniqueNumbers(
                  log.smsnotify ? log.smsnotify.split(/[,;]+/) : []
                );

                // Numbers with a wrong format (not 09xxxxxxxxx / +639xxxxxxxxx)
                const rawNumbers = (log.smsnotify ? log.smsnotify.split(/[,;]+/) : [])
                  .map(n => n.trim()).filter(Boolean);
                const invalidNumbers = rawNumbers.filter(n => !isValidPhone(n));

                if (invalidNumbers.length > 0 && !INVALID_NOTIFIED.has(log.seed)) {
                  INVALID_NOTIFIED.add(log.seed);
                  if (adminEmailsRef.current?.trim()) {
                    queueEmailStable(
                      '⚠️ Invalid Parent Number',
                      `INVALID PARENT NUMBER\n\n` +
                      `Student: ${studentName} (${yr} ${sec})\n` +
                      `Device: ${devName}\n` +
                      `Invalid number(s): ${invalidNumbers.join(', ')}\n\n` +
                      (validNumbers.length > 0
                        ? `May SMS pa ring ipinadala sa ibang number ng parent.`
                        : `WALANG SMS na naipadala, walang valid na number ang student.`) +
                      `\n\nPaki-ayos ang number sa student record.`
                    );
                  }
                }

                if (validNumbers.length === 0) {
                  await markSent(log.seed, devName);
                  continue;
                }

                // Exceeded max attempts
                if (log.smsprocessing >= SMS_MAX_PROCESSING) {
                  failedSendsRef.current[log.seed] = (failedSendsRef.current[log.seed] || 0) + 1;
                  if (failedSendsRef.current[log.seed] >= MAX_ERROR_CYCLES) {
                    await handleMaxFailures(log, validNumbers, studentName, failedThisCycle, devName);
                  }
                  continue;
                }

                
                if (await isDuplicateLog(log)) {
                  console.log(`🔕 Duplicate log ${log.seed} — skipped`);
                  await markSent(log.seed, devName);
                  continue;
                }

                
                if (!(await lockSending(log.seed, devName))) continue;

                try { WatchdogModule?.pingHeartbeat?.(); } catch {}

                if (!SENT_NUMBERS.has(log.seed)) {
                  SENT_NUMBERS.set(log.seed, new Set());
                  SENT_TS.set(log.seed, Date.now());
                }
                const done = SENT_NUMBERS.get(log.seed);

                {
                  const nowP = Date.now();
                  Object.keys(PENDING_DELIVERY).forEach((k) => {
                    if (nowP - PENDING_DELIVERY[k].ts > PENDING_DELIVERY_TTL_MS) delete PENDING_DELIVERY[k];
                  });
                  validNumbers.forEach((n) => {
                    PENDING_DELIVERY[n] = { studentName, seed: log.seed, ts: nowP };
                  });
                }

                const failInfo = {};
                let ok = false;
                try { ok = await sendSMSStable(validNumbers, message, done, persistSentNumbers, failInfo); }
                catch (e) { console.error('send threw:', e); ok = false; }

                if (ok) {
                  const marked = await markSent(log.seed, devName);
                  if (marked) {
                    SENT_NUMBERS.delete(log.seed);
                    SENT_TS.delete(log.seed);
                    await persistSentNumbers();
                    delete failedSendsRef.current[log.seed];
                  } else {
                    
                    console.warn(`markSent failed for ${log.seed} — keeping SENT_NUMBERS to prevent resend`);
                  }
                } else {
                
                  {
                    const entries = Object.entries(failInfo).filter(([k]) => k !== '__permission');
                    const codes = entries.map(([, v]) => v.code);
                    let kind, subject, detail;

                    if (failInfo.__permission) {
                      kind = 'NO_PERMISSION';
                      subject = '🚫 SMS Permission Required';
                      detail = 'The application does not have SEND_SMS permission. Please enable SMS permission in the device Settings and try again.';
                    } else if (codes.includes(2) || codes.includes(4)) {
                      kind = 'NO_SIGNAL';
                      subject = 'SMS Sending Failed - No Signal';
                      detail = 'The device has no available mobile signal or the radio is turned off (NO_SERVICE / RADIO_OFF). Please check the SIM card, mobile signal, and device network settings.';
                    } else if (codes.includes(1)) {
                      kind = 'NO_LOAD';
                      subject = 'SMS Sending Failed - Insufficient Load/Credit';
                      detail = 'The SMS could not be sent due to a GENERIC_FAILURE. Please verify that the SIM card has sufficient load or SMS credit. The issue may also be related to the mobile carrier.';
                    } else {
                      kind = 'OTHER';
                      subject = 'SMS Sending Failed';
                      detail =
                        'The SMS could not be sent due to an unidentified error.\n\n' +
                        'Please review the failure details below for further investigation.';
                    }

                    const nowF = Date.now();

                    if (nowF - (FAIL_NOTIFY_TS[kind] || 0) >= FAIL_NOTIFY_COOLDOWN_MS) {
                      FAIL_NOTIFY_TS[kind] = nowF;

                      if (adminEmailsRef.current?.trim()) {
                        queueEmailStable(
                          subject,
                          `${subject}\n\n` +
                          `Device: ${devName}\n` +
                          `Student: ${studentName}\n` +
                          `${detail}\n\n` +
                          `Failed SMS Number(s):\n` +
                          (entries.map(([n, v]) => `• ${n} → ${v.reason}`).join('\n') || '(No additional details available)') +
                          `\n\nThe application will automatically retry sending the SMS up to ${SMS_MAX_PROCESSING} time(s).`
                        );
                      }
                    }
                  }

                  await releaseLock(log.seed, devName);
                  failedSendsRef.current[log.seed] = (failedSendsRef.current[log.seed] || 0) + 1;
                  if (failedSendsRef.current[log.seed] >= MAX_ERROR_CYCLES) {
                    await handleMaxFailures(log, validNumbers, studentName, failedThisCycle, devName);
                  }
                }
              } finally {
                GLOBAL_SENDING_SEEDS.delete(log.seed);
              }
            }

            if (failedThisCycle.length > 0) {
              const nowC = Date.now();
              const partialList = failedThisCycle.filter(f => f.partial);
              
              const totalList = failedThisCycle.filter(f => !f.partial).filter(f => {
                const last = CRITICAL_ALERTED.get(f.seed) || 0;
                if (nowC - last < CRITICAL_REMIND_MS) return false;
                CRITICAL_ALERTED.set(f.seed, nowC);
                return true;
              });

             
              if (partialList.length > 0) {
                const lines = partialList.map(f =>
                  `• Student: ${f.studentName}\n` +
                  `   Delivered to: ${f.partial.sent.join(', ')}\n` +
                  `   Not delivered to: ${f.partial.missed.join(', ')}`
                ).join('\n\n');

                Alert.alert(
                  'Partial SMS Delivery',
                  `The SMS could not be delivered to one or more recipients after ` +
                  `${MAX_ERROR_CYCLES} attempts. The record has been marked as sent because ` +
                  `at least one recipient received the message.`
                );

                if (adminEmailsRef.current?.trim()) {
                  queueEmailStable(
                    'Partial SMS Delivery - Record Marked as Sent',
                    `PARTIAL SMS DELIVERY\n\n` +
                    `Device: ${devName}\n\n` +
                    `${lines}\n\n` +
                    `The message was delivered to at least one recipient, so the record has been ` +
                    `marked as sent and will not be retried.\n\n` +
                    `Recommended action: verify the SIM card balance and confirm that the number listed under "Not delivered to" is active and correct in the student record.`
                  );
                }
              }

             
              if (totalList.length > 0) {
                const failedNames = totalList.map(f => f.studentName).join(', ');
                Alert.alert(
                  'SMS Sending Error',
                  `Failed to send SMS after ${MAX_ERROR_CYCLES} cycles. Check SIM load/credit.`
                );
                if (adminEmailsRef.current?.trim()) {
                  queueEmailStable(
                    'Critical SMS Error',
                    `Failed SMS recipients:\n${failedNames}\n\n` +
                    `Device: ${devName}\n⚠️ Check SIM card credit/load.`
                  );
                }
              }

              if (partialList.length > 0 || totalList.length > 0) {
                try {
                  errorSound?.setVolume(1.0);
                  errorSound?.play(() => {});
                  Vibration.vibrate([0, 1000, 500, 1000, 500, 1000], false);
                } catch {}
              }
            }

            setStatusMessage('Processed new records. Cycle counter reset.');
          }

          // Battery check
          try {
            const level = await getBatteryLevel();
            if (level <= batteryThresholdRef.current && !batteryAlertSentRef.current) {
              const msg =
                `⚠️ LOW BATTERY ALERT ⚠️\n\n` +
                `Device: ${deviceNameRef.current}\n` +
                `Battery Level: ${level}%\n\nPlease plug in the device immediately.`;
              if (adminEmailsRef.current?.trim()) queueEmailStable('Low Battery Alert', msg);
              const nums = getValidNumbers(adminNumbersRef.current);
              if (nums.length > 0) await sendSMSStable(nums, msg);
              batteryAlertSentRef.current = true;
              updateServiceStatus(`⚠️ Low battery: ${level}%`);
            } else if (level > batteryThresholdRef.current) {
              batteryAlertSentRef.current = false;
            }
          } catch {}

          await sleep(idleMs);

        } catch (loopErr) {
       
          if (myLoopId !== ACTIVE_LOOP_ID) break;

          console.error('Loop iteration error:', loopErr);
          const errMsg = String(loopErr?.message || loopErr).toLowerCase();
          const isNetworkish =
            errMsg.includes('network') || errMsg.includes('timeout') ||
            errMsg.includes('timed out') || errMsg.includes('connection');

          if (reconnectFailStreakRef.current === 0) {
            reconnectStuckSinceRef.current = Date.now();
          }
          const nowErr   = Date.now();
          const stuckMs  = reconnectStuckSinceRef.current ? nowErr - reconnectStuckSinceRef.current : 0;
          const stuckMin = Math.max(1, Math.round(stuckMs / 60000));

          if (isNetworkish) {
            const sinceLastNotif = nowErr - lastNetworkErrorNotifRef.current;
            if (!networkErrorSentRef.current || sinceLastNotif >= RECONNECT_RENOTIFY_INTERVAL_MS) {
              lastNetworkErrorNotifRef.current = nowErr;
              networkErrorSentRef.current = true;
              await notifyNetworkError(
                `${errMsg}\n\nStill stuck reconnecting after ${stuckMin} min ` +
                `(attempt #${reconnectFailStreakRef.current + 1}).`
              );
            }
          }

          setStatusMessage(`⚠️ Reconnecting... (${stuckMin}m, attempt #${reconnectFailStreakRef.current + 1})`);
          updateServiceStatus(`⚠️ Reconnecting to server (${stuckMin}m)...`);

          if (stuckMs >= RECONNECT_STUCK_RESTART_MS) {
            console.warn(`🚨 Reconnect stuck for ${stuckMin} min — forcing full restart`);
            reconnectFailStreakRef.current = 0;
            reconnectStuckSinceRef.current = 0;
            _requestRestart(`Stuck reconnecting for ${stuckMin}+ minutes`);
            break;
          }

          reconnectFailStreakRef.current += 1;
          const backoffMs = Math.min(
            RECONNECT_BACKOFF_BASE_MS * reconnectFailStreakRef.current,
            RECONNECT_BACKOFF_MAX_MS
          );

          try {
            await reconnect();
            networkErrorSentRef.current    = false;
            reconnectFailStreakRef.current = 0;
            reconnectStuckSinceRef.current = 0;
          } catch (e) {
            console.log('Reconnect failed:', e);
          }

          try { WatchdogModule?.pingHeartbeat?.(); } catch {}
          await sleep(backoffMs);
        }
      } // end while

    } catch (outerErr) {
      console.error('Main loop outer error:', outerErr);
      await notifyNetworkError(String(outerErr));
      Alert.alert('Error', 'Something went wrong with the SMS process.');
    } finally {
      
      if (myLoopId === ACTIVE_LOOP_ID) await safeClose();
    }

   
    return myLoopId !== ACTIVE_LOOP_ID ? 'superseded' : 'ended';
  }, [
    reconnect, sendSMSStable, queueEmailStable, markSent, notifyNetworkError,
    updateServiceStatus, isSmsWindowOpen, isLogTimeWithinWindow, _requestRestart,
    dbUpdate, dbQuery, lockSending, releaseLock, recoverStaleLocks, isDuplicateLog,
    handleMaxFailures,
  ]);


  const lifecycleCoordinator = useCallback(async () => {
    if (coordinatorRunningRef.current) {
      console.log('lifecycleCoordinator: already running, ignoring');
      return;
    }
    coordinatorRunningRef.current = true;

    let isFirstRun = true;

    while (true) {
      restartSignalRef.current         = SIGNAL_NONE;
      restartReasonRef.current         = '';
      coordinatorRestartingRef.current = false;
      restartStartNotifiedRef.current  = false;
      cycleCountRef.current            = 0; setCycleCount(0);
      networkErrorSentRef.current      = false;

      setIsRunning(true);
      isRunningRef.current = true;

      _startNativeWatchdog();

      try { WatchdogModule?.resetAutoRestartTimer?.(); } catch {}

      if (!isFirstRun) {
        const reason = restartReasonRef.current || 'Scheduled restart';
        const nowTs  = Date.now();
        if (nowTs - lastRestartNotifSentAtRef.current >= RESTART_NOTIF_COOLDOWN_MS) {
          lastRestartNotifSentAtRef.current = nowTs;
          const msg =
            `🔄 AUTO-RESTART COMPLETE\n\n` +
            `Device: ${deviceNameRef.current}\n` +
            `Reason: ${reason}\n\n` +
            `The SMS loop has been automatically restarted.`;
          if (adminEmailsRef.current?.trim()) {
            try { queueEmailStable('SMS Loop Auto-Restart', msg); } catch {}
          }
          if (isSmsWindowOpen()) {
            const nums = getValidNumbers(adminNumbersRef.current);
            if (nums.length > 0) { try { await sendSMSStable(nums, msg); } catch {} }
          }
        } else {
          console.log('🔕 Suppressing duplicate AUTO-RESTART COMPLETE notice (cooldown)');
        }
        setStatusMessage(`🔄 Restarted (${reason}). Running...`);
        updateServiceStatus(`🔄 Restarted: ${reason}`);
      }
      isFirstRun = false;

      let loopResult;
      try { loopResult = await runLoop(); }
      catch (e) { console.error('lifecycleCoordinator: runLoop threw:', e); }

     
      if (loopResult === 'superseded') {
        console.log('⏭️ Coordinator: superseded by a newer loop — exiting quietly');
        return;
      }

      const signal = restartSignalRef.current;
      _stopNativeWatchdog();

      if (signal === SIGNAL_STOP) {
        console.log('🛑 Coordinator: clean stop');
        break;
      }

    
      if (signal === SIGNAL_NONE) {
        console.warn(
          '⚠️ Coordinator: runLoop exited without a restart/stop signal — ' +
          'treating as an unexpected failure and auto-restarting instead of stopping silently'
        );
        if (!restartReasonRef.current) {
          restartReasonRef.current = 'Unexpected exit with no signal — auto-recovering';
        }
      }

      const reason = restartReasonRef.current || 'Scheduled auto-restart';
      console.log(`🔄 Coordinator: restarting — ${reason}`);

      coordinatorRestartingRef.current = true;
      setStatusMessage(`🔄 Auto-restarting (${reason})...`);
      updateServiceStatus(`🔄 Restarting: ${reason}`);

      
      const nowTsStart = Date.now();
      if (
        !restartStartNotifiedRef.current &&
        nowTsStart - lastRestartNotifSentAtRef.current >= RESTART_NOTIF_COOLDOWN_MS
      ) {
        lastRestartNotifSentAtRef.current = nowTsStart;
        const preMsg =
          `🔄 AUTO-RESTART STARTING\n\n` +
          `Device: ${deviceNameRef.current}\n` +
          `Reason: ${reason}\n\n` +
          `The SMS loop is stopping for restart. It will resume in a few seconds.`;
        if (adminEmailsRef.current?.trim()) {
          try { queueEmailStable('SMS Loop Restarting', preMsg); } catch {}
        }
        if (isSmsWindowOpen()) {
          const nums = getValidNumbers(adminNumbersRef.current);
          if (nums.length > 0) { try { await sendSMSStable(nums, preMsg); } catch {} }
        }
      } else if (restartStartNotifiedRef.current) {
        console.log('🔕 Skipping generic "AUTO-RESTART STARTING" notice — already notified for this event');
      } else {
        console.log('🔕 Suppressing duplicate AUTO-RESTART STARTING notice (cooldown)');
      }

      await sleep(6000);
      coordinatorRestartingRef.current = false;
    }

    coordinatorRunningRef.current = false;
    setIsRunning(false);
    isRunningRef.current = false;

    if (windowSchedulerActiveRef.current) {
      const st = startTimeRef.current;
      if (!isSmsWindowOpen()) {
        setStatusMessage(`🔴 Stopped (SMS window closed). Auto-starts at ${formatTime(st)}.`);
        updateServiceStatus(`Stopped — auto-starts ${formatTime(st)}`);
      } else {
        setStatusMessage('⚠️ Stopped unexpectedly while window was still open — will retry automatically.');
        updateServiceStatus('⚠️ Stopped unexpectedly — retrying');
      }
    }

    console.log('🛑 Coordinator: exited');
  }, [
    runLoop, sendSMSStable, queueEmailStable,
    _startNativeWatchdog, _stopNativeWatchdog,
    updateServiceStatus, isSmsWindowOpen,
  ]);


  const _activateProcessing = useCallback(async () => {
    if (coordinatorRunningRef.current || activatingRef.current) return;
    activatingRef.current = true;
    console.log('▶️ SMS window OPEN — activating processing (same as Start)');
    restartSignalRef.current = SIGNAL_NONE;
    try {
      try { await notifySmsWindowOpen(); } catch {}
      await lifecycleCoordinator();
    } finally {
      activatingRef.current = false;
    }
  }, [lifecycleCoordinator, notifySmsWindowOpen]);

  const _deactivateProcessing = useCallback(() => {
    if (!coordinatorRunningRef.current) return;
    if (restartSignalRef.current !== SIGNAL_NONE) return;
    console.log('⏸️ SMS window CLOSED — deactivating processing (same as Stop)');

    const st = startTimeRef.current;
    setStatusMessage(`⏹ SMS window closed — stopping now. Will auto-start at ${formatTime(st)}.`);
    updateServiceStatus(`⏹ Stopping — resumes ${formatTime(st)}`);

    try { notifySmsWindowClose(); } catch {}
    _requestStop();
  }, [_requestStop, notifySmsWindowClose, updateServiceStatus]);

 
  const _scheduleNextPreciseCheck = useCallback(() => {
    if (windowScheduleTimeoutRef.current) {
      clearTimeout(windowScheduleTimeoutRef.current);
      windowScheduleTimeoutRef.current = null;
    }
    if (!windowSchedulerActiveRef.current) return;
    const ms = Math.max(1000, msUntilNextBoundary() + 1000);
    windowScheduleTimeoutRef.current = setTimeout(() => {
      applyWindowScheduleRef.current?.();
    }, ms);
  }, [msUntilNextBoundary]);

  const applyWindowSchedule = useCallback(() => {
    if (!windowSchedulerActiveRef.current) return;

    const open = isSmsWindowOpen();
    if (open && !coordinatorRunningRef.current) {
      _activateProcessing();
    } else if (
      !open &&
      coordinatorRunningRef.current &&
      !coordinatorRestartingRef.current
    ) {
      _deactivateProcessing();
    }

    _scheduleNextPreciseCheck();
  }, [isSmsWindowOpen, _activateProcessing, _deactivateProcessing, _scheduleNextPreciseCheck]);

  useEffect(() => {
    applyWindowScheduleRef.current = applyWindowSchedule;
  }, [applyWindowSchedule]);

 
  const doStop = useCallback((silent = false) => {
    windowSchedulerActiveRef.current = false;
    if (windowScheduleTimeoutRef.current) {
      clearTimeout(windowScheduleTimeoutRef.current);
      windowScheduleTimeoutRef.current = null;
    }
    _requestStop();
    ACTIVE_LOOP_ID++;   
    isRunningRef.current          = false;
    coordinatorRunningRef.current = false;
    setIsRunning(false);
    setIsScheduled(false);
    _stopNativeWatchdog();
    stopForegroundService();
    AsyncStorage.setItem(APP_SHOULD_RUN_KEY, 'false').catch(() => {});
    setStatusMessage('Process stopped.');
    updateServiceStatus('Process stopped — tap to reopen');
    if (!silent) Alert.alert('Process Stopped', 'SMS process stopping...');
  }, [_requestStop, _stopNativeWatchdog, stopForegroundService, updateServiceStatus]);

  const doStart = useCallback(async () => {
    if (windowSchedulerActiveRef.current) return;
    
    windowSchedulerActiveRef.current = true;
    restartSignalRef.current = SIGNAL_NONE;
    try { await AsyncStorage.setItem(APP_SHOULD_RUN_KEY, 'true'); } catch {}

    setIsScheduled(true);

    startForegroundService();

    if (!isSmsWindowOpen()) {
      const st = startTimeRef.current;
      setStatusMessage(`⏳ Outside SMS window — will auto-start at ${formatTime(st)}`);
      updateServiceStatus(`⏳ Waiting — starts ${formatTime(st)}`);
    }

    applyWindowSchedule();
  }, [startForegroundService, updateServiceStatus, isSmsWindowOpen, applyWindowSchedule]);


  const handleStart = useCallback(async () => {
    Keyboard.dismiss();
    if (!numStudents || !idleSeconds || !deviceName) {
      Alert.alert('Missing Information', 'Please fill out all fields before starting.');
      return;
    }
    if (!await ensureSmsPermission()) {
      Alert.alert('SMS Permission Required', 'Please allow SMS permission to continue.');
      return;
    }
    if (isSmsWindowOpen()) {
      Alert.alert('Process Started', 'Fetching and sending SMS notifications...');
    } else {
      Alert.alert(
        'Process Scheduled',
        `Right now is outside the SMS window (${formatTime(startTimeRef.current)} – ` +
        `${formatTime(endTimeRef.current)}). The app will automatically start sending ` +
        `at ${formatTime(startTimeRef.current)} and stop at ${formatTime(endTimeRef.current)} ` +
        `every day — no need to open the app.`
      );
    }
    await doStart();
  }, [numStudents, idleSeconds, deviceName, ensureSmsPermission, doStart, isSmsWindowOpen]);

  const handleStop = useCallback(() => { doStop(false); }, [doStop]);

  const handleSettingsPress = () => {
    Keyboard.dismiss();
    navigation?.navigate('Settings');
  };


  const intervalLabel = AUTO_RESTART_INTERVAL_MS < 60 * 60 * 1000
    ? `${AUTO_RESTART_INTERVAL_MS / 60000} min`
    : `${AUTO_RESTART_INTERVAL_MS / 3_600_000} hr`;

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.container}>
        <TouchableWithoutFeedback onPress={Keyboard.dismiss} accessible={false}>
          <View style={styles.innerContainer}>

            <Text style={styles.title}>School Attendance SMS Notifier</Text>
            <Image source={require('./assets/mhcs_logo.png')} style={styles.logo} />

            <View style={styles.inputsContainer}>

              <View style={styles.inputGroup}>
                <Text style={styles.label}>Number of Students</Text>
                <TextInput
                  style={[styles.input, displayDashboard && styles.inputDisabled]}
                  keyboardType="numeric" value={numStudents}
                  onChangeText={setNumStudents} editable={!displayDashboard}/>
              </View>

              <View style={styles.inputGroup}>
                <Text style={styles.label}>Idle Seconds to Wait</Text>
                <TextInput
                  style={[styles.input, displayDashboard && styles.inputDisabled]}
                  keyboardType="numeric" value={idleSeconds}
                  onChangeText={setIdleSeconds} editable={!displayDashboard}/>
              </View>

              <View style={styles.inputGroup}>
                <Text style={styles.label}>Sending SMS Start Time</Text>
                <TouchableOpacity
                  style={[styles.input, displayDashboard && styles.inputDisabled]}
                  onPress={() => setShowStartPicker(true)}
                  disabled={displayDashboard}>
                  <Text style={displayDashboard ? styles.disabledText : styles.normalText}>
                    {formatTime(startTime)}
                  </Text>
                </TouchableOpacity>
                {showStartPicker && (
                  <DateTimePicker
                    value={startTime}
                    mode="time"
                    is24Hour={false}
                    display={Platform.OS === 'ios' ? 'spinner' : 'default'}
                    onChange={(e, d) => {
                      if (Platform.OS === 'android') {
                        if (e.type === 'set' && d) setStartTime(d);
                        setShowStartPicker(false);
                      } else {
                        setStartTime(d || startTime);
                      }
                    }}
                  />
                )}
              </View>

              <View style={styles.inputGroup}>
                <Text style={styles.label}>Sending SMS End Time</Text>
                <TouchableOpacity
                  style={[styles.input, displayDashboard && styles.inputDisabled]}
                  onPress={() => setShowEndPicker(true)}
                  disabled={displayDashboard}>
                  <Text style={displayDashboard ? styles.disabledText : styles.normalText}>
                    {formatTime(endTime)}
                  </Text>
                </TouchableOpacity>
                {showEndPicker && (
                  <DateTimePicker
                    value={endTime}
                    mode="time"
                    is24Hour={false}
                    display={Platform.OS === 'ios' ? 'spinner' : 'default'}
                    onChange={(e, d) => {
                      if (Platform.OS === 'android') {
                        if (e.type === 'set' && d) setEndTime(d);
                        setShowEndPicker(false);
                      } else {
                        setEndTime(d || endTime);
                      }
                    }}
                  />
                )}
              </View>

            </View>

            {isRunning ? (
              <View style={styles.autoRestartBadge}>
                <Text style={styles.autoRestartText}>
                  {`🟢 Running · 🔄 ${intervalLabel} restart · 🌅 Daily restart @ ${formatTime(startTime)} & ${formatTime(endTime)} · 🐕 Native watchdog · ⏹ Auto-stops ${formatTime(endTime)}`}
                </Text>
              </View>
            ) : (
              <View style={styles.schedulerBadge}>
                <Text style={styles.schedulerText}>
                  {isScheduled
                    ? `⏸ Stopped  ·  ▶ Auto-starts ${formatTime(startTime)}  ·  ⏹ Auto-stops ${formatTime(endTime)}  ·  📧 Email: 24/7`
                    : `⏸ Stopped  ·  📨 SMS: ${formatTime(startTime)} – ${formatTime(endTime)}  ·  📧 Email: 24/7`}
                </Text>
              </View>
            )}

            <View style={styles.buttonContainer}>
              <TouchableOpacity
                style={[styles.button, { backgroundColor: isRunning ? '#95a5a6' : '#3A6F43' }]}
                onPress={handleStart} disabled={isRunning}>
                <Text style={styles.buttonText}>Start</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.button, { backgroundColor: '#c74d3a' }]}
                onPress={handleStop}>
                <Text style={styles.buttonText}>Stop</Text>
              </TouchableOpacity>
            </View>

            <View style={styles.statusBox}>
              <Text style={styles.statusText}>
                Status: {isRunning ? '🟢 Running' : '🔴 Stopped'}
              </Text>
              {statusMessage ? (
                <Text style={styles.statusText}>{statusMessage}</Text>
              ) : null}
            </View>

            <TouchableOpacity style={styles.settingsContainer} onPress={handleSettingsPress}>
              <Text style={styles.settingsText}>⚙️ Configuration Settings</Text>
            </TouchableOpacity>

          </View>
        </TouchableWithoutFeedback>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container:        { flex: 1, backgroundColor: '#f8f9fa', justifyContent: 'center' },
  innerContainer:   { flex: 1, justifyContent: 'space-around', alignItems: 'center', paddingHorizontal: width * 0.05 },
  title:            { fontSize: width * 0.055, fontWeight: '700', color: '#11224E', textAlign: 'center', marginTop: height * 0.03, marginBottom: -17 },
  logo:             { width: width * 0.3, height: width * 0.3, resizeMode: 'contain', marginVertical: height * 0.03 },
  inputsContainer:  { width: '100%' },
  inputGroup:       { marginBottom: height * 0.015 },
  label:            { fontSize: width * 0.035, fontWeight: '500', color: '#040536', marginBottom: 5 },
  input:            { borderWidth: 1, borderColor: '#bdc3c7', borderRadius: 8, paddingHorizontal: width * 0.03, paddingVertical: height * 0.012, backgroundColor: '#fff', fontSize: width * 0.035 },
  inputDisabled:    { backgroundColor: '#ecf0f1' },
  normalText:       { color: '#000' },
  disabledText:     { color: '#7f8c8d' },
  buttonContainer:  { flexDirection: 'row', justifyContent: 'space-evenly', width: '100%', marginVertical: height * 0.001 },
  button:           { flex: 1, marginHorizontal: 5, borderRadius: 10, paddingVertical: height * 0.015, alignItems: 'center' },
  buttonText:       { color: '#fff', fontWeight: '600', fontSize: width * 0.04 },
  statusBox:        { backgroundColor: '#ecf0f1', padding: height * 0.015, borderRadius: 8, alignItems: 'center', width: '100%' },
  statusText:       { fontSize: width * 0.035, fontWeight: '600', color: '#2c3e50' },
  autoRestartBadge: { backgroundColor: '#d4edda', borderRadius: 6, paddingHorizontal: 10, paddingVertical: 4, marginVertical: 2 },
  autoRestartText:  { fontSize: width * 0.026, color: '#155724', fontWeight: '500', textAlign: 'center' },
  schedulerBadge:   { backgroundColor: '#cce5ff', borderRadius: 6, paddingHorizontal: 10, paddingVertical: 4, marginVertical: 2 },
  schedulerText:    { fontSize: width * 0.028, color: '#004085', fontWeight: '500', textAlign: 'center' },
  settingsContainer:{ flexDirection: 'row', justifyContent: 'center', alignItems: 'center', marginTop: height * 0.010, marginBottom: height * 0.015 },
  settingsText:     { fontSize: width * 0.04, color: '#0d1e30', borderBottomWidth: 1, borderBottomColor: '#0d1e30', paddingBottom: 1 },
});