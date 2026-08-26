// MainScreen.js — Native-Watchdog Edition + Editable SMS Time Window
//
//  ✅ All timing-critical work (watchdog, auto-restart, daily restart)
//     runs in WatchdogModule (Kotlin HandlerThread) — immune to JS suspension
//  ✅ SMS sending window is USER-EDITABLE via time pickers (restored from
//     the original "Code 2" version, instead of the hardcoded 7AM–9PM)
//  ✅ Pending SMS messages are released back to the queue when the window
//     is closed and automatically retried once it reopens
//  ✅ Email notifications are always allowed 24/7, regardless of SMS window
//  ✅ Flat coordinator loop — zero recursion, clean state reset every restart
//  ✅ pingHeartbeat() called every loop iteration so the native watchdog
//     knows the JS thread is alive
//  ✅ WatchdogModule.resetAutoRestartTimer() called after every restart so
//     the 3-hour clock restarts cleanly (fixes the 3rd-restart failure)

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

// ─── Timing constants (passed to native WatchdogModule) ───────────────────────
const AUTO_RESTART_INTERVAL_MS    = 3 * 60 * 60 * 1000;  // 3 hours
const WATCHDOG_STUCK_THRESHOLD_MS = 10 * 60 * 1000;       // 10 minutes
const DAILY_RESTART_HOUR          = 7;                     // 7 AM

const SMS_MAX_PROCESSING = 5;
const MAX_ERROR_CYCLES   = 30;

const SIGNAL_NONE    = null;
const SIGNAL_RESTART = 'restart';
const SIGNAL_STOP    = 'stop';

export default function MainScreen() {

  // ── UI state ────────────────────────────────────────────────────────────────
  const [isRunning,        setIsRunning]        = useState(false);
  const [numStudents,      setNumStudents]      = useState('10');
  const [idleSeconds,      setIdleSeconds]      = useState('20');

  // ── Editable SMS start/end time — defaults to 6AM–9PM like the original ─────
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

  // ── Foreground service hook ──────────────────────────────────────────────────
  const {
    startForegroundService,
    stopForegroundService,
    updateServiceStatus,
  } = useForegroundService();

  // ── Runtime refs ────────────────────────────────────────────────────────────
  const isRunningRef             = useRef(false);
  const cycleCountRef            = useRef(0);
  const failedSendsRef           = useRef({});
  const sendingSeedsRef          = useRef(new Set());
  const batteryAlertSentRef      = useRef(false);
  const emailQueueRef            = useRef([]);
  const sendingEmailRef          = useRef(false);
  const smsPermissionGrantedRef  = useRef(false);
  const networkErrorSentRef      = useRef(false);

  // ── Coordinator lifecycle refs ───────────────────────────────────────────────
  const restartSignalRef         = useRef(SIGNAL_NONE);
  const restartReasonRef         = useRef('');
  const coordinatorRunningRef    = useRef(false);
  const coordinatorRestartingRef = useRef(false);

  // ── SMS window state ─────────────────────────────────────────────────────────
  const smsWindowOpenRef         = useRef(false);
  const windowNotifSentRef       = useRef({ open: false, close: false });

  // ── Native watchdog event subscriptions ──────────────────────────────────────
  const watchdogSubsRef          = useRef([]);

  // ── Config refs (mirror state for use inside async callbacks) ────────────────
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

  // ── KeepAwake (JS layer — belt-and-suspenders with native WakeLock) ──────────
  useEffect(() => {
    KeepAwake.activate();
    return () => { KeepAwake.deactivate(); };
  }, []);

  // ── AppState listener — re-arm foreground service if JS resumes ──────────────
  useEffect(() => {
    const sub = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active' && isRunningRef.current) {
        startForegroundService();
      }
    });
    return () => sub.remove();
  }, [startForegroundService]);

  // ── Battery optimization prompt (shown once) ─────────────────────────────────
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

  // ── Google Sign-In ───────────────────────────────────────────────────────────
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
          // ── Restore saved SMS start/end time, if present ───────────────────
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

  // ── Persist SMS start/end time whenever they change ──────────────────────────
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

  // ── Cleanup on unmount ───────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      _unsubscribeWatchdog();
      WatchdogModule?.stop?.();
      restartSignalRef.current = SIGNAL_STOP;
      // Do NOT stop the foreground service on unmount — it must keep running.
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const navigation = useNavigation();

  const errorSound = new Sound('alert.mp3', Sound.MAIN_BUNDLE, (err) => {
    if (err && __DEV__) console.error('Failed to load sound', err);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Pure helpers
  // ─────────────────────────────────────────────────────────────────────────────
  const sleep        = (ms) => new Promise(r => setTimeout(r, ms));
  const isValidPhone = (num) => /^(?:\+63|0)9\d{9}$/.test(num);
  const getValidNumbers = (raw) =>
    raw ? raw.split(/[,;]+/).map(n => n.trim()).filter(n => n.length > 0 && isValidPhone(n)) : [];

  const formatTime = (time) => {
    const h = time.getHours(), m = time.getMinutes(), ampm = h >= 12 ? 'PM' : 'AM';
    return `${h % 12 || 12}:${m < 10 ? '0' + m : m} ${ampm}`;
  };

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

  const safeClose = async () => {
    try { if (MSSQL?.close) await MSSQL.close(); }
    catch (e) { console.error('safeClose:', e); }
  };

  // ── SMS window check — uses the USER-CONFIGURED startTimeRef / endTimeRef ───
  const isSmsWindowOpen = useCallback(() => {
    const now      = new Date();
    const nowMin   = now.getHours() * 60 + now.getMinutes();
    const st       = startTimeRef.current;
    const et       = endTimeRef.current;
    const startMin = st.getHours() * 60 + st.getMinutes();
    const endMin   = et.getHours() * 60 + et.getMinutes();
    return nowMin >= startMin && nowMin < endMin;
  }, []);

  // ─────────────────────────────────────────────────────────────────────────────
  // Signal helpers
  // ─────────────────────────────────────────────────────────────────────────────
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

  // ─────────────────────────────────────────────────────────────────────────────
  // Native watchdog subscriptions
  // ─────────────────────────────────────────────────────────────────────────────
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
        `This usually means the JS thread was suspended by Android's battery optimizer.\n\n` +
        `Reason: ${reason}\n\n` +
        `An automatic restart is being triggered now.`;

      updateServiceStatus(`⚠️ Loop stuck ${mins}m — restarting`);
      if (adminEmailsRef.current?.trim()) {
        try { queueEmailStable('🚨 SMS Loop Stuck (Native Watchdog)', stuckMsg); } catch {}
      }
      if (isSmsWindowOpen()) {
        const nums = getValidNumbers(adminNumbersRef.current);
        if (nums.length > 0) { try { await sendSMSStable(nums, stuckMsg); } catch {} }
      }
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
      const reason = e.reason || 'Daily 7AM restart';
      console.log(`🌅 Native daily restart event: ${reason}`);
      _requestRestart(reason);
    });

    watchdogSubsRef.current = [s1, s2, s3];
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [_requestRestart, updateServiceStatus, isSmsWindowOpen]);

  const _unsubscribeWatchdog = useCallback(() => {
    watchdogSubsRef.current.forEach(s => { try { s.remove(); } catch {} });
    watchdogSubsRef.current = [];
  }, []);

  const _startNativeWatchdog = useCallback(() => {
    if (!WatchdogModule) {
      console.warn('WatchdogModule not available');
      return;
    }
    _subscribeWatchdog();
    WatchdogModule.start(
      WATCHDOG_STUCK_THRESHOLD_MS,
      AUTO_RESTART_INTERVAL_MS,
      DAILY_RESTART_HOUR,
    );
    console.log('✅ Native watchdog started');
  }, [_subscribeWatchdog]);

  const _stopNativeWatchdog = useCallback(() => {
    _unsubscribeWatchdog();
    try { WatchdogModule?.stop?.(); } catch {}
  }, [_unsubscribeWatchdog]);

  // ─────────────────────────────────────────────────────────────────────────────
  // SMS helpers
  // ─────────────────────────────────────────────────────────────────────────────
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

  const sendSMSStable = useCallback(async (numbers = [], message) => {
    try {
      if (!await ensureSmsPermission()) return false;
      if (!Array.isArray(numbers) || numbers.length === 0 || !message) return true;
      const valid = numbers.filter(isValidPhone);
      if (valid.length === 0) return true;
      let allOk = true;
      for (const num of valid) {
        try {
          const r = await SmsModule.sendSMS(num, message);
          if (!(r && r.success)) allOk = false;
          await sleep(1500);
        } catch (e) { console.error(`SMS error on ${num}`, e); allOk = false; }
      }
      return allOk;
    } catch (e) { console.error('sendSMS fatal:', e); return false; }
  }, [ensureSmsPermission]);

  // ─────────────────────────────────────────────────────────────────────────────
  // Email helpers (always allowed — not gated by SMS window)
  // ─────────────────────────────────────────────────────────────────────────────
  const processEmailQueue = useCallback(async () => {
    if (sendingEmailRef.current) return;
    sendingEmailRef.current = true;
    try {
      const recipients = (adminEmailsRef.current || '')
        .split(/[;,]+/).map(s => s.trim()).filter(Boolean);
      if (recipients.length === 0) { emailQueueRef.current = []; return; }
      const accessToken = await fetchAccessToken();
      if (!accessToken) return;
      while (emailQueueRef.current.length > 0) {
        const { subject, message } = emailQueueRef.current[0];
        const ok = await sendEmailViaGmailAPI(
          recipients.join(','), subject, message, accessToken
        );
        if (ok) emailQueueRef.current.shift(); else break;
      }
    } finally { sendingEmailRef.current = false; }
  }, []);

  const queueEmailStable = useCallback((subject, message) => {
    emailQueueRef.current.push({ subject, message });
    processEmailQueue();
  }, [processEmailQueue]);

  // ─────────────────────────────────────────────────────────────────────────────
  // DB helpers
  // ─────────────────────────────────────────────────────────────────────────────
  const reconnect = useCallback(async () => {
    await safeClose();
    await sleep(1000);
    await MSSQL.connect({
      server:   serverNameRef.current,
      username: usernameRef.current,
      password: passwordRef.current,
      database: databaseNameRef.current,
      port:     1433,
      timeout:  15,
    });
  }, []);

  const markSent = useCallback(async (seed, devName) => {
    try {
      await MSSQL.executeUpdate(
        `UPDATE logs SET smssent=1, smsmac='${devName}', smssenttime=GETDATE()` +
        ` WHERE seed='${seed}'`
      );
    } catch (e) { console.error('markSent:', e); }
  }, []);

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

  // ─────────────────────────────────────────────────────────────────────────────
  // SMS window open/close notifications
  // ─────────────────────────────────────────────────────────────────────────────
  const notifySmsWindowOpen = useCallback(async () => {
    if (windowNotifSentRef.current.open) return;
    windowNotifSentRef.current.open  = true;
    windowNotifSentRef.current.close = false;
    const st = startTimeRef.current, et = endTimeRef.current;
    const msg =
      `🌅 SMS WINDOW OPENED\n\n` +
      `Device: ${deviceNameRef.current}\n` +
      `SMS sending has resumed (${formatTime(st)} – ${formatTime(et)}).`;
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
      `🌙 SMS WINDOW CLOSED\n\n` +
      `Device: ${deviceNameRef.current}\n` +
      `SMS sending is paused until ${formatTime(st)} tomorrow.\n` +
      `Email notifications continue 24/7.`;
    updateServiceStatus(`😴 SMS paused until ${formatTime(st)}`);
    if (adminEmailsRef.current?.trim()) queueEmailStable('SMS Window Closed', msg);
    // Can't send SMS — window just closed. Only email.
  }, [queueEmailStable, updateServiceStatus]);

  // ─────────────────────────────────────────────────────────────────────────────
  // MAIN LOOP
  // ─────────────────────────────────────────────────────────────────────────────
  const runLoop = useCallback(async () => {
    const limit   = parseInt(numStudentsRef.current, 10) || 5;
    const idleMs  = (parseInt(idleSecondsRef.current, 10) || 5) * 1000;
    const devName = deviceNameRef.current;

    // Query the full day — the SMS window gate is enforced in JS so records
    // are always claimed and released back to the queue if the window is closed.
    const startHH = '00:00:00';
    const endHH   = '23:59:59';

    setStatusMessage('Starting SMS process...');
    updateServiceStatus('Starting SMS process...');

    try {
      await reconnect();

      while (restartSignalRef.current === SIGNAL_NONE) {

        // ── Ping native watchdog so it knows the JS loop is alive ──────────
        try { WatchdogModule?.pingHeartbeat?.(); } catch {}

        // ── SMS window transition detection ──────────────────────────────────
        const windowOpen = isSmsWindowOpen();
        if (windowOpen && !smsWindowOpenRef.current) {
          smsWindowOpenRef.current = true;
          await notifySmsWindowOpen();
        } else if (!windowOpen && smsWindowOpenRef.current) {
          smsWindowOpenRef.current = false;
          await notifySmsWindowClose();
        }

        try {
          // ── Claim records ──────────────────────────────────────────────────
          await MSSQL.executeUpdate(`
            UPDATE logs SET smsmac='${devName}'
            WHERE seed IN (
              SELECT TOP (${limit}) seed FROM logs
              WHERE smssent=0 AND (smsmac IS NULL OR smsmac='')
                AND CONVERT(VARCHAR(10),date,120)=CONVERT(VARCHAR(10),GETDATE(),120)
                AND time BETWEEN '${startHH}' AND '${endHH}'
              ORDER BY smsprocessing ASC, date ASC, time ASC)`);

          const claimed = await MSSQL.executeQuery(`
            SELECT TOP (${limit})
              l.seed, l.studentid, l.date, l.time, l.trans,
              ISNULL(l.smsprocessing,0) as smsprocessing,
              s.studentname, s.smsnotify, s.yearlevel, s.section
            FROM logs l
            INNER JOIN student s ON l.studentid=s.studentid
            WHERE l.smssent=0 AND l.smsmac='${devName}'
              AND CONVERT(VARCHAR(10),l.date,120)=CONVERT(VARCHAR(10),GETDATE(),120)
              AND l.time BETWEEN '${startHH}' AND '${endHH}'
            ORDER BY l.smsprocessing ASC, l.date ASC, l.time ASC;`);

          if (!claimed || claimed.length === 0) {
            // ── Idle ──────────────────────────────────────────────────────────
            cycleCountRef.current += 1;
            setCycleCount(cycleCountRef.current);

            const st = startTimeRef.current, et = endTimeRef.current;
            const windowLabel = windowOpen
              ? `📨 Sending enabled`
              : `😴 SMS paused (outside ${formatTime(st)}–${formatTime(et)})`;

            const statusTxt =
              `No new records. Idle cycle ${cycleCountRef.current} — ` +
              `waiting ${idleSecondsRef.current}s... ${windowLabel}`;
            setStatusMessage(statusTxt);

            if (cycleCountRef.current % 10 === 0) {
              updateServiceStatus(`Idle cycle ${cycleCountRef.current} — 24/7 active`);
            }

          } else {
            // ── Process records ────────────────────────────────────────────────
            cycleCountRef.current = 0;
            setCycleCount(0);
            updateServiceStatus(`Processing ${claimed.length} record(s)...`);

            const failedThisCycle = [];

            for (const log of claimed) {
              if (restartSignalRef.current !== SIGNAL_NONE) break;
              if (sendingSeedsRef.current.has(log.seed)) continue;
              sendingSeedsRef.current.add(log.seed);

              const studentName = log.studentname || 'Student';
              const trans       = log.trans || '';
              const fmtDT       = formatLogDateTime(log.date, log.time);
              const yr          = log.yearlevel || '';
              const sec         = log.section   || '';

              const message =
                trans === 'TI'
                  ? arrivalMessageRef.current
                      .replace('{student}', studentName).replace('{time}', fmtDT)
                      .replace('{year}', yr).replace('{section}', sec)
                  : trans === 'TO'
                  ? departureMessageRef.current
                      .replace('{student}', studentName).replace('{time}', fmtDT)
                      .replace('{year}', yr).replace('{section}', sec)
                  : `${studentName} ${trans} at ${fmtDT}.`;

              const validNumbers = (
                log.smsnotify
                  ? log.smsnotify.split(/[,;]+/).map(n => n.trim())
                  : []
              ).filter(isValidPhone);

              if (validNumbers.length === 0) {
                await markSent(log.seed, devName);
                sendingSeedsRef.current.delete(log.seed);
                continue;
              }

              // ── Only send SMS if window is open; email is always allowed ───
              if (!windowOpen) {
                // Release the claim so it's retried automatically once the
                // window reopens (e.g. the next day at the configured start time)
                try {
                  await MSSQL.executeUpdate(
                    `UPDATE logs SET smsmac=NULL WHERE seed='${log.seed}'`
                  );
                } catch {}
                sendingSeedsRef.current.delete(log.seed);
                continue;
              }

              if (log.smsprocessing < SMS_MAX_PROCESSING) {
                const ok = await sendSMSStable(validNumbers, message);
                await MSSQL.executeUpdate(
                  `UPDATE logs SET smsprocessing=ISNULL(smsprocessing,0)+1` +
                  `${ok ? `, smssent=1, smssenttime=GETDATE()` : ''}` +
                  ` WHERE seed='${log.seed}' AND smsmac='${devName}'`
                );
                if (ok) {
                  await markSent(log.seed, devName);
                  delete failedSendsRef.current[log.seed];
                } else {
                  failedSendsRef.current[log.seed] =
                    (failedSendsRef.current[log.seed] || 0) + 1;
                  if (failedSendsRef.current[log.seed] >= MAX_ERROR_CYCLES) {
                    failedThisCycle.push({ studentName, seed: log.seed });
                    delete failedSendsRef.current[log.seed];
                  }
                }
              } else {
                failedSendsRef.current[log.seed] =
                  (failedSendsRef.current[log.seed] || 0) + 1;
                if (failedSendsRef.current[log.seed] >= MAX_ERROR_CYCLES) {
                  failedThisCycle.push({ studentName, seed: log.seed });
                  delete failedSendsRef.current[log.seed];
                }
              }
              sendingSeedsRef.current.delete(log.seed);
            }

            if (failedThisCycle.length > 0) {
              const failedNames = failedThisCycle.map(f => f.studentName).join(', ');
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
              try {
                errorSound?.setVolume(1.0);
                errorSound?.play(() => {});
                Vibration.vibrate([0, 1000, 500, 1000, 500, 1000], false);
              } catch {}
            }

            setStatusMessage('Processed new records. Cycle counter reset.');
          }

          // ── Battery check ──────────────────────────────────────────────────
          try {
            const level = await getBatteryLevel();
            if (level <= batteryThresholdRef.current && !batteryAlertSentRef.current) {
              const msg =
                `⚠️ LOW BATTERY ALERT ⚠️\n\n` +
                `Device: ${deviceNameRef.current}\n` +
                `Battery Level: ${level}%\n\nPlease plug in the device immediately.`;
              if (adminEmailsRef.current?.trim()) queueEmailStable('Low Battery Alert', msg);
              if (windowOpen) {
                const nums = getValidNumbers(adminNumbersRef.current);
                if (nums.length > 0) await sendSMSStable(nums, msg);
              }
              batteryAlertSentRef.current = true;
              updateServiceStatus(`⚠️ Low battery: ${level}%`);
            } else if (level > batteryThresholdRef.current) {
              batteryAlertSentRef.current = false;
            }
          } catch {}

          await sleep(idleMs);

        } catch (loopErr) {
          console.error('Loop iteration error:', loopErr);
          const errMsg = String(loopErr?.message || loopErr).toLowerCase();
          if (
            (errMsg.includes('network') ||
             errMsg.includes('timeout') ||
             errMsg.includes('connection')) &&
            !networkErrorSentRef.current
          ) {
            await notifyNetworkError(errMsg);
            networkErrorSentRef.current = true;
          }
          setStatusMessage('⚠️ Reconnecting...');
          updateServiceStatus('⚠️ Reconnecting to server...');
          try { await reconnect(); networkErrorSentRef.current = false; }
          catch (e) { console.log('Reconnect failed:', e); }
          await sleep(5000);
        }
      } // end while

    } catch (outerErr) {
      console.error('Main loop outer error:', outerErr);
      await notifyNetworkError(String(outerErr));
      Alert.alert('Error', 'Something went wrong with the SMS process.');
    } finally {
      await safeClose();
    }
  }, [
    reconnect, sendSMSStable, queueEmailStable, markSent, notifyNetworkError,
    updateServiceStatus, isSmsWindowOpen, notifySmsWindowOpen, notifySmsWindowClose,
  ]);

  // ─────────────────────────────────────────────────────────────────────────────
  // LIFECYCLE COORDINATOR — flat loop, zero recursion
  // ─────────────────────────────────────────────────────────────────────────────
  const lifecycleCoordinator = useCallback(async () => {
    if (coordinatorRunningRef.current) {
      console.log('lifecycleCoordinator: already running, ignoring');
      return;
    }
    coordinatorRunningRef.current = true;

    let isFirstRun = true;

    while (true) {
      // ── Reset all volatile state ───────────────────────────────────────────
      restartSignalRef.current         = SIGNAL_NONE;
      restartReasonRef.current         = '';
      coordinatorRestartingRef.current = false;
      cycleCountRef.current            = 0; setCycleCount(0);
      sendingSeedsRef.current          = new Set();
      networkErrorSentRef.current      = false;
      windowNotifSentRef.current       = { open: false, close: false };
      smsWindowOpenRef.current         = isSmsWindowOpen();

      setIsRunning(true);
      isRunningRef.current = true;

      startForegroundService();
      _startNativeWatchdog();

      // Reset the native 3-hour auto-restart timer so it starts fresh
      try { WatchdogModule?.resetAutoRestartTimer?.(); } catch {}

      if (!isFirstRun) {
        const reason = restartReasonRef.current || 'Scheduled restart';
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
        setStatusMessage(`🔄 Restarted (${reason}). Running...`);
        updateServiceStatus(`🔄 Restarted: ${reason}`);
      }
      isFirstRun = false;

      try { await runLoop(); }
      catch (e) { console.error('lifecycleCoordinator: runLoop threw:', e); }

      const signal = restartSignalRef.current;
      _stopNativeWatchdog();

      if (signal === SIGNAL_STOP || signal === SIGNAL_NONE) {
        console.log('🛑 Coordinator: clean stop');
        break;
      }

      // ── SIGNAL_RESTART ────────────────────────────────────────────────────────
      const reason = restartReasonRef.current || 'Scheduled 3hr auto-restart';
      console.log(`🔄 Coordinator: restarting — ${reason}`);

      coordinatorRestartingRef.current = true;
      setStatusMessage(`🔄 Auto-restarting (${reason})...`);
      updateServiceStatus(`🔄 Restarting: ${reason}`);

      const preMsg =
        `🔄 AUTO-RESTART STARTING\n\n` +
        `Device: ${deviceNameRef.current}\n` +
        `Reason: ${reason}\n\n` +
        `The SMS loop is stopping for restart. It will resume in a few seconds.`;
      if (adminEmailsRef.current?.trim()) {
        try { queueEmailStable('SMS Loop Restarting…', preMsg); } catch {}
      }
      if (isSmsWindowOpen()) {
        const nums = getValidNumbers(adminNumbersRef.current);
        if (nums.length > 0) { try { await sendSMSStable(nums, preMsg); } catch {} }
      }

      await sleep(6000);
      coordinatorRestartingRef.current = false;
      // Loop continues — next iteration resets state and calls runLoop again
    }

    coordinatorRunningRef.current = false;
    setIsRunning(false);
    isRunningRef.current = false;
    setStatusMessage('Process stopped.');
    updateServiceStatus('Process stopped — tap to reopen');
    console.log('🛑 Coordinator: exited');
  }, [
    runLoop, sendSMSStable, queueEmailStable,
    startForegroundService, _startNativeWatchdog, _stopNativeWatchdog,
    updateServiceStatus, isSmsWindowOpen,
  ]);

  // ── doStop / doStart ─────────────────────────────────────────────────────────
  const doStop = useCallback((silent = false) => {
    _requestStop();
    isRunningRef.current          = false;
    coordinatorRunningRef.current = false;
    setIsRunning(false);
    _stopNativeWatchdog();
    stopForegroundService();
    setStatusMessage('Process stopped.');
    if (!silent) Alert.alert('Process Stopped', 'SMS process stopping...');
  }, [_requestStop, _stopNativeWatchdog, stopForegroundService]);

  const doStart = useCallback(async () => {
    if (coordinatorRunningRef.current) return;
    restartSignalRef.current = SIGNAL_NONE;
    await lifecycleCoordinator();
  }, [lifecycleCoordinator]);

  // ── handleStart / handleStop ──────────────────────────────────────────────────
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
    Alert.alert('Process Started', 'Fetching and sending SMS notifications...');
    await doStart();
  }, [numStudents, idleSeconds, deviceName, ensureSmsPermission, doStart]);

  const handleStop = useCallback(() => { doStop(false); }, [doStop]);

  const handleSettingsPress = () => {
    Keyboard.dismiss();
    navigation?.navigate('Settings');
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────────
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
                  onChangeText={setNumStudents} editable={!displayDashboard}
                />
              </View>

              <View style={styles.inputGroup}>
                <Text style={styles.label}>Idle Seconds to Wait</Text>
                <TextInput
                  style={[styles.input, displayDashboard && styles.inputDisabled]}
                  keyboardType="numeric" value={idleSeconds}
                  onChangeText={setIdleSeconds} editable={!displayDashboard}
                />
              </View>

              {/* ── Editable SMS Start Time ──────────────────────────────────── */}
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

              {/* ── Editable SMS End Time ────────────────────────────────────── */}
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
                  {`🟢 24/7 · 🔄 ${intervalLabel} restart · 🐕 Native watchdog · 📧 Email: always on`}
                </Text>
              </View>
            ) : (
              <View style={styles.schedulerBadge}>
                <Text style={styles.schedulerText}>
                  {`⏸ Stopped  ·  📨 SMS: ${formatTime(startTime)} – ${formatTime(endTime)}  ·  📧 Email: 24/7`}
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