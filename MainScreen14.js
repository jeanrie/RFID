// MainScreen.js — 24/7 Edition + Exact-Time Scheduler Fix
//
// ROOT CAUSE OF MISSED 7AM START:
// The previous scheduler used setInterval(60s) to check if it's time to
// start/stop. When the Android JS thread is suspended overnight (even with
// the foreground service running), this interval can miss ticks entirely,
// causing the 7AM auto-start to never fire.
//
// FIX: Replace setInterval-based scheduler with an EXACT-TIME scheduler:
//  - On every wake, calculate the EXACT milliseconds until the next
//    start or stop event using setTimeout pointed at that precise moment.
//  - Also runs a 60s "catch-up" interval as a safety net in case the
//    setTimeout itself is delayed.
//  - On AppState change to 'active' (app comes to foreground / JS resumes),
//    the scheduler immediately re-evaluates and re-arms — this is the
//    critical fix for the "JS thread was suspended overnight" problem.
//  - Missed-window detection: if the current time is PAST the scheduled
//    start time but no start has happened today, start immediately.

import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, Platform,
  Image, Alert, Dimensions, Keyboard, TouchableWithoutFeedback,
  PermissionsAndroid, NativeModules, Vibration, AppState,
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

const SmsModule     = NativeModules.SmsModule;
const BatteryModule = NativeModules.BatteryModule;
const { width, height } = Dimensions.get('window');

const WEB_CLIENT_ID = '651284152046-22s1bs6beejjmd6jkop35rdi6hsaapqt.apps.googleusercontent.com';

// ─── Timing constants ─────────────────────────────────────────────────────────
const AUTO_RESTART_INTERVAL_MS     = 3 * 60 * 60 * 1000;  // 3 hours
const WATCHDOG_CHECK_INTERVAL_MS   = 5 * 60 * 1000;
const WATCHDOG_STUCK_THRESHOLD_MS  = 10 * 60 * 1000;
const RESTART_HANG_TIMEOUT_MS      = 10 * 60 * 1000;
const AUTO_RESTART_TICK_MS         = 60 * 1000;
const AUTO_RESTART_TICK_COUNT      = Math.round(AUTO_RESTART_INTERVAL_MS / AUTO_RESTART_TICK_MS);
const HEARTBEAT_TICK_MS            = 60 * 1000;
const HEARTBEAT_STUCK_THRESHOLD_MS = 10 * 60 * 1000;

// Scheduler catch-up interval — runs every 60s as a safety net in addition
// to the exact-time setTimeout. If the setTimeout fires late, this catches it.
const SCHEDULER_CATCHUP_MS = 60 * 1000;

const SIGNAL_NONE    = null;
const SIGNAL_RESTART = 'restart';
const SIGNAL_STOP    = 'stop';

export default function MainScreen() {

  // ── UI state ────────────────────────────────────────────────────────────────
  const [isRunning,        setIsRunning]        = useState(false);
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

  // ── Foreground service ───────────────────────────────────────────────────────
  const {
    startForegroundService,
    stopForegroundService,
    updateServiceStatus,
  } = useForegroundService();

  // ── Runtime refs ────────────────────────────────────────────────────────────
  const isRunningRef            = useRef(false);
  const cycleCountRef           = useRef(0);
  const failedSendsRef          = useRef({});
  const sendingSeedsRef         = useRef(new Set());
  const batteryAlertSentRef     = useRef(false);
  const emailQueueRef           = useRef([]);
  const sendingEmailRef         = useRef(false);
  const smsPermissionGrantedRef = useRef(false);
  const networkErrorSentRef     = useRef(false);

  // ── Lifecycle refs ──────────────────────────────────────────────────────────
  const restartSignalRef         = useRef(SIGNAL_NONE);
  const restartReasonRef         = useRef('');
  const coordinatorRestartingRef = useRef(false);
  const coordinatorRunningRef    = useRef(false);

  // ── Watchdog / timer refs ───────────────────────────────────────────────────
  const lastHeartbeatRef            = useRef(Date.now());
  const watchdogAlertSentRef        = useRef(false);
  const watchdogTimerRef            = useRef(null);
  const autoRestartTickerRef        = useRef(null);
  const autoRestartTicksLeftRef     = useRef(0);
  const restartHangTimerRef         = useRef(null);
  const restartHangAlertSentRef     = useRef(false);
  const heartbeatTickerRef          = useRef(null);
  const heartbeatLastCycleRef       = useRef(0);
  const heartbeatLastChangeTimeRef  = useRef(Date.now());
  const heartbeatStuckAlertSentRef  = useRef(false);
  const cycleProgressTimerRef       = useRef(null);
  const cycleStuckAlertSentRef      = useRef(false);

  // ── Exact-time scheduler refs ────────────────────────────────────────────────
  // Two-layer approach:
  //   exactTimerRef   — setTimeout pointed at the EXACT next event ms
  //   catchupTimerRef — setInterval every 60s as a safety net
  // Both call the same _evaluateSchedule() function.
  // On AppState 'active', _evaluateSchedule() is called immediately.
  const exactTimerRef           = useRef(null);
  const catchupTimerRef         = useRef(null);
  const scheduledStopDateRef    = useRef(null);   // date string of last auto-stop
  const scheduledStartDateRef   = useRef(null);   // date string of last auto-start

  // ── Config refs ──────────────────────────────────────────────────────────────
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

  // ── KeepAwake ───────────────────────────────────────────────────────────────
  useEffect(() => {
    KeepAwake.activate();
    return () => { KeepAwake.deactivate(); };
  }, []);

  // ── Google Sign-In ──────────────────────────────────────────────────────────
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

  // ── Load saved config ───────────────────────────────────────────────────────
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
        }
      } catch (err) { console.error('Failed to load config:', err); }
    })();
  }, []);

  // ── Cleanup on unmount ──────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      _stopWatchdog();
      _clearAutoRestartTicker();
      _stopRestartHangTimer();
      _stopScheduler();
      _stopCycleProgressWatchdog();
      _stopHeartbeatTicker();
      restartSignalRef.current = SIGNAL_STOP;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Battery optimization prompt ──────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const prompted = await AsyncStorage.getItem('batteryOptPrompted');
        if (!prompted && Platform.OS === 'android') {
          await AsyncStorage.setItem('batteryOptPrompted', '1');
          Alert.alert(
            '⚡ Allow Background Operation',
            'To keep this app running 24/7, go to:\n\n' +
            'Settings → Apps → AttendanceSMSApp → Battery → "Unrestricted"\n\n' +
            'This prevents Android from stopping the app overnight.',
            [{ text: 'OK' }]
          );
        }
      } catch {}
    })();
  }, []);

  const navigation     = useNavigation();
  const maxErrorCycles = 30;
  const SMS_MAX_PROCESSING = 5;

  const errorSound = new Sound('alert.mp3', Sound.MAIN_BUNDLE, (err) => {
    if (err && __DEV__) console.error('Failed to load sound', err);
  });

  // ── Pure helpers ────────────────────────────────────────────────────────────
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
      return `${dt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true }).toLowerCase()} ${dt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}`;
    } catch { return sqlTime; }
  };

  const getBatteryLevel = async () => {
    try { return BatteryModule?.getLevel ? await BatteryModule.getLevel() : 100; } catch { return 100; }
  };

  const safeClose = async () => {
    try { if (MSSQL?.close) await MSSQL.close(); } catch (e) { console.error('safeClose:', e); }
  };

  const todayDateStr = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  };

  // ── Timer stop helpers ──────────────────────────────────────────────────────
  const _stopWatchdog = () => {
    if (watchdogTimerRef.current) { clearInterval(watchdogTimerRef.current); watchdogTimerRef.current = null; }
  };
  const _clearAutoRestartTicker = () => {
    if (autoRestartTickerRef.current) { clearInterval(autoRestartTickerRef.current); autoRestartTickerRef.current = null; }
    autoRestartTicksLeftRef.current = 0;
  };
  const _stopRestartHangTimer = () => {
    if (restartHangTimerRef.current) { clearTimeout(restartHangTimerRef.current); restartHangTimerRef.current = null; }
  };
  const _stopCycleProgressWatchdog = () => {
    if (cycleProgressTimerRef.current) { clearTimeout(cycleProgressTimerRef.current); cycleProgressTimerRef.current = null; }
  };
  const _stopHeartbeatTicker = () => {
    if (heartbeatTickerRef.current) { clearInterval(heartbeatTickerRef.current); heartbeatTickerRef.current = null; }
  };
  const _stopScheduler = () => {
    if (exactTimerRef.current)   { clearTimeout(exactTimerRef.current);   exactTimerRef.current = null; }
    if (catchupTimerRef.current) { clearInterval(catchupTimerRef.current); catchupTimerRef.current = null; }
  };

  // ── Signal helpers ──────────────────────────────────────────────────────────
  const _requestRestart = useCallback((reason) => {
    if (restartSignalRef.current !== SIGNAL_NONE) return;
    console.log(`📨 Restart requested: ${reason}`);
    restartReasonRef.current = reason;
    restartSignalRef.current = SIGNAL_RESTART;
  }, []);

  const _requestStop = useCallback(() => {
    restartReasonRef.current = '';
    restartSignalRef.current = SIGNAL_STOP;
  }, []);

  // ── Layer-1: Cycle-progress watchdog ────────────────────────────────────────
  const _resetCycleProgressWatchdog = useCallback(() => {
    _stopCycleProgressWatchdog();
    if (!isRunningRef.current) return;
    const idleSec = parseInt(idleSecondsRef.current, 10) || 5;
    const deadline = idleSec * 1000 * 2 + 5000;

    cycleProgressTimerRef.current = setTimeout(async () => {
      if (!isRunningRef.current || cycleStuckAlertSentRef.current) return;
      if (restartSignalRef.current !== SIGNAL_NONE) return;
      cycleStuckAlertSentRef.current = true;
      const stuckMsg =
        `🚨 SMS LOOP FROZEN 🚨\n\nDevice: ${deviceNameRef.current}\n\n` +
        `Cycle count not advanced in ${Math.round(deadline/1000)}s. Auto-restart triggered.`;
      console.warn('🚨 Layer-1 watchdog fired');
      const nums = getValidNumbers(adminNumbersRef.current);
      if (nums.length > 0) { try { await sendSMSStable(nums, stuckMsg); } catch {} }
      if (adminEmailsRef.current?.trim()) { try { queueEmailStable('🚨 SMS Loop Frozen', stuckMsg); } catch {} }
      _requestRestart('Layer-1 watchdog: loop frozen');
    }, deadline);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [_requestRestart]);

  // ── Layer-2: Independent heartbeat ticker ────────────────────────────────────
  const _startHeartbeatTicker = useCallback(() => {
    _stopHeartbeatTicker();
    heartbeatLastCycleRef.current      = cycleCountRef.current;
    heartbeatLastChangeTimeRef.current = Date.now();
    heartbeatStuckAlertSentRef.current = false;

    heartbeatTickerRef.current = setInterval(async () => {
      if (!isRunningRef.current) return;
      if (coordinatorRestartingRef.current) {
        heartbeatLastCycleRef.current      = cycleCountRef.current;
        heartbeatLastChangeTimeRef.current = Date.now();
        return;
      }
      if (restartSignalRef.current !== SIGNAL_NONE || heartbeatStuckAlertSentRef.current) return;

      const currentCycle = cycleCountRef.current;
      if (currentCycle !== heartbeatLastCycleRef.current) {
        heartbeatLastCycleRef.current      = currentCycle;
        heartbeatLastChangeTimeRef.current = Date.now();
        return;
      }
      const elapsed = Date.now() - heartbeatLastChangeTimeRef.current;
      if (elapsed >= HEARTBEAT_STUCK_THRESHOLD_MS) {
        heartbeatStuckAlertSentRef.current = true;
        const mins = Math.round(elapsed / 60000);
        const stuckMsg =
          `🚨 SMS LOOP STUCK (HEARTBEAT) 🚨\n\nDevice: ${deviceNameRef.current}\n\n` +
          `Cycle ${currentCycle} frozen for ${mins} min. Auto-restart triggered.`;
        console.warn(`🚨 Layer-2 heartbeat fired — stuck ${mins} min`);
        const nums = getValidNumbers(adminNumbersRef.current);
        if (nums.length > 0) { try { await sendSMSStable(nums, stuckMsg); } catch {} }
        if (adminEmailsRef.current?.trim()) { try { queueEmailStable('🚨 SMS Loop Stuck', stuckMsg); } catch {} }
        updateServiceStatus(`⚠️ Loop stuck — restarting`);
        _requestRestart('Layer-2 heartbeat: cycle frozen');
      }
    }, HEARTBEAT_TICK_MS);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [_requestRestart, updateServiceStatus]);

  // ── reconnect ───────────────────────────────────────────────────────────────
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const ensureSmsPermission = useCallback(async () => {
    if (smsPermissionGrantedRef.current) return true;
    if (Platform.OS !== 'android') return true;
    const perm = PermissionsAndroid.PERMISSIONS.SEND_SMS;
    if (await PermissionsAndroid.check(perm)) { smsPermissionGrantedRef.current = true; return true; }
    const r = await PermissionsAndroid.request(perm, {
      title: 'SMS Permission', message: 'App needs to send SMS.', buttonPositive: 'OK',
    });
    if (r === PermissionsAndroid.RESULTS.GRANTED) { smsPermissionGrantedRef.current = true; return true; }
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

  const processEmailQueue = useCallback(async () => {
    if (sendingEmailRef.current) return;
    sendingEmailRef.current = true;
    try {
      const recipients = (adminEmailsRef.current || '').split(/[;,]+/).map(s => s.trim()).filter(Boolean);
      if (recipients.length === 0) { emailQueueRef.current = []; return; }
      const accessToken = await fetchAccessToken();
      if (!accessToken) return;
      while (emailQueueRef.current.length > 0) {
        const { subject, message } = emailQueueRef.current[0];
        const ok = await sendEmailViaGmailAPI(recipients.join(','), subject, message, accessToken);
        if (ok) emailQueueRef.current.shift(); else break;
      }
    } finally { sendingEmailRef.current = false; }
  }, []);

  const queueEmailStable = useCallback((subject, message) => {
    emailQueueRef.current.push({ subject, message });
    processEmailQueue();
  }, [processEmailQueue]);

  const markSent = useCallback(async (seed, devName) => {
    try {
      await MSSQL.executeUpdate(
        `UPDATE logs SET smssent=1, smsmac='${devName}', smssenttime=GETDATE() WHERE seed='${seed}'`
      );
    } catch (e) { console.error('markSent:', e); }
  }, []);

  const notifyNetworkError = useCallback(async (errorMsg) => {
    try {
      const msg =
        `NETWORK/SERVER ERROR\n\nDevice: ${deviceNameRef.current}\n\nError:\n${errorMsg}\n\n` +
        `The device cannot connect to the server or lost internet connection.`;
      const nums = getValidNumbers(adminNumbersRef.current);
      if (nums.length > 0) await sendSMSStable(nums, msg);
      if (adminEmailsRef.current?.trim()) queueEmailStable('Network/Server Error', msg);
    } catch {}
  }, [sendSMSStable, queueEmailStable]);

  // ── RESTART-HANG WATCHDOG ───────────────────────────────────────────────────
  const _armRestartHangTimer = useCallback(() => {
    _stopRestartHangTimer();
    restartHangAlertSentRef.current = false;
    restartHangTimerRef.current = setTimeout(async () => {
      if (!coordinatorRestartingRef.current || restartHangAlertSentRef.current) return;
      restartHangAlertSentRef.current = true;
      const msg =
        `🚨 AUTO-RESTART HUNG 🚨\n\nDevice: ${deviceNameRef.current}\n\n` +
        `Restart has not completed in ${Math.round(RESTART_HANG_TIMEOUT_MS/60000)} min.\n` +
        `⚠️ Please manually reopen the app.`;
      const nums = getValidNumbers(adminNumbersRef.current);
      if (nums.length > 0) { try { await sendSMSStable(nums, msg); } catch {} }
      if (adminEmailsRef.current?.trim()) { try { queueEmailStable('🚨 Auto-Restart Hung', msg); } catch {} }
      coordinatorRunningRef.current    = false;
      coordinatorRestartingRef.current = false;
      setIsRunning(false);
      isRunningRef.current = false;
      setStatusMessage('⛔ Auto-restart hung. Please reopen the app manually.');
      updateServiceStatus('⛔ Hung — please reopen app');
    }, RESTART_HANG_TIMEOUT_MS);
  }, [sendSMSStable, queueEmailStable, updateServiceStatus]);

  // ── HEARTBEAT WATCHDOG (event-loop level) ────────────────────────────────────
  const _startWatchdog = useCallback(() => {
    _stopWatchdog();
    watchdogTimerRef.current = setInterval(async () => {
      if (!isRunningRef.current || coordinatorRestartingRef.current) return;
      const elapsed = Date.now() - lastHeartbeatRef.current;
      if (elapsed >= WATCHDOG_STUCK_THRESHOLD_MS && !watchdogAlertSentRef.current) {
        watchdogAlertSentRef.current = true;
        const mins = Math.round(elapsed / 60000);
        const alertMsg =
          `🚨 SMS LOOP STUCK 🚨\n\nDevice: ${deviceNameRef.current}\n` +
          `No progress for ${mins} min. Auto-restart triggered.`;
        const nums = getValidNumbers(adminNumbersRef.current);
        if (nums.length > 0) { try { await sendSMSStable(nums, alertMsg); } catch {} }
        if (adminEmailsRef.current?.trim()) { try { queueEmailStable('🚨 Loop Stuck', alertMsg); } catch {} }
        _requestRestart('Watchdog: loop stuck');
      }
    }, WATCHDOG_CHECK_INTERVAL_MS);
  }, [sendSMSStable, queueEmailStable, _requestRestart]);

  // ── TICK-BASED AUTO-RESTART ──────────────────────────────────────────────────
  const _armAutoRestartTicker = useCallback(() => {
    _clearAutoRestartTicker();
    autoRestartTicksLeftRef.current = AUTO_RESTART_TICK_COUNT;
    autoRestartTickerRef.current = setInterval(() => {
      autoRestartTicksLeftRef.current -= 1;
      if (autoRestartTicksLeftRef.current > 0) return;
      if (!isRunningRef.current) { _clearAutoRestartTicker(); return; }
      _clearAutoRestartTicker();
      _requestRestart('Scheduled 3hr auto-restart');
    }, AUTO_RESTART_TICK_MS);
  }, [_requestRestart]);

  // ════════════════════════════════════════════════════════════════════════════
  // EXACT-TIME SCHEDULER
  //
  // How it works:
  //  _evaluateSchedule() is the single function that decides what to do RIGHT NOW.
  //  It is called:
  //    a) Every 60s by the catch-up interval (safety net)
  //    b) At the EXACT millisecond of the next event by a setTimeout
  //    c) Immediately when AppState changes to 'active' (JS resumes from suspension)
  //    d) When startTime/endTime change
  //
  //  On each call it:
  //    1. Checks if we're past the end time → auto-stop if running
  //    2. Checks if we're within the window and missed today's start → start NOW
  //    3. Checks if we're within the window but haven't started today → start NOW
  //    4. Calculates the ms until the NEXT event and arms a setTimeout for it
  // ════════════════════════════════════════════════════════════════════════════
  const _evaluateSchedule = useCallback(async () => {
    const now     = new Date();
    const nowMs   = now.getHours() * 3600000 + now.getMinutes() * 60000 + now.getSeconds() * 1000;
    const dateStr = todayDateStr();

    const st  = startTimeRef.current;
    const et  = endTimeRef.current;
    const stMs = st.getHours() * 3600000 + st.getMinutes() * 60000;
    const etMs = et.getHours() * 3600000 + et.getMinutes() * 60000;

    // ── 1. Auto-stop: past end time ───────────────────────────────────────────
    if (
      nowMs >= etMs &&
      isRunningRef.current &&
      restartSignalRef.current === SIGNAL_NONE &&
      scheduledStopDateRef.current !== dateStr
    ) {
      scheduledStopDateRef.current  = dateStr;
      scheduledStartDateRef.current = null; // allow auto-start tomorrow

      console.log(`🕐 Scheduler: past end time (${formatTime(et)}) — auto-stopping`);
      setStatusMessage(`🕐 Past end time (${formatTime(et)}). Auto-stopping...`);
      updateServiceStatus(`🕐 Auto-stopped at ${formatTime(et)}`);

      const stopMsg =
        `🕐 AUTO-STOP\n\nDevice: ${deviceNameRef.current}\n` +
        `Sending window ended (${formatTime(et)}).\n` +
        `Will auto-start tomorrow at ${formatTime(st)}.`;
      const nums = getValidNumbers(adminNumbersRef.current);
      if (nums.length > 0) { try { await sendSMSStable(nums, stopMsg); } catch {} }
      if (adminEmailsRef.current?.trim()) { try { queueEmailStable('SMS Auto-Stopped', stopMsg); } catch {} }

      _requestStop();
      _armNextScheduleTimer(nowMs, stMs, etMs);
      return;
    }

    // ── 2 & 3. Auto-start: within window, not yet started today ──────────────
    if (
      !coordinatorRunningRef.current &&
      restartSignalRef.current === SIGNAL_NONE &&
      nowMs >= stMs &&
      nowMs < etMs &&
      scheduledStartDateRef.current !== dateStr
    ) {
      scheduledStartDateRef.current = dateStr;

      const wasLate = nowMs > stMs + 60000; // more than 1 min past start time
      const lateMin = Math.round((nowMs - stMs) / 60000);
      const lateNote = wasLate ? ` (${lateMin} min late — JS was suspended)` : '';

      console.log(`🌅 Scheduler: auto-starting${lateNote}`);
      setStatusMessage(`🌅 Auto-starting${lateNote}...`);
      updateServiceStatus(`🌅 Auto-starting${lateNote}`);

      const startMsg =
        `🌅 AUTO-START\n\nDevice: ${deviceNameRef.current}\n` +
        `Sending window began (${formatTime(st)})${lateNote}.`;
      const nums = getValidNumbers(adminNumbersRef.current);
      if (nums.length > 0) { try { await sendSMSStable(nums, startMsg); } catch {} }
      if (adminEmailsRef.current?.trim()) { try { queueEmailStable('SMS Auto-Started', startMsg); } catch {} }

      try { await doStartRef.current(); } catch (e) { console.error('Scheduler auto-start failed:', e); }
    }

    // Arm the next exact-time timer
    _armNextScheduleTimer(nowMs, stMs, etMs);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sendSMSStable, queueEmailStable, _requestStop, updateServiceStatus]);

  // Calculate ms until next event and arm a setTimeout for it
  const _armNextScheduleTimer = useCallback((nowMs, stMs, etMs) => {
    if (exactTimerRef.current) { clearTimeout(exactTimerRef.current); exactTimerRef.current = null; }

    const msInDay = 24 * 3600000;
    let msUntilNext;

    if (nowMs < stMs) {
      // Before start time today — wait until start
      msUntilNext = stMs - nowMs;
    } else if (nowMs < etMs) {
      // Inside window — wait until end
      msUntilNext = etMs - nowMs;
    } else {
      // Past end time — wait until start time tomorrow
      msUntilNext = msInDay - nowMs + stMs;
    }

    // Add a small buffer so we land just AFTER the target second
    const delay = msUntilNext + 1000;

    console.log(`⏰ Next schedule event in ${Math.round(delay / 60000)} min`);
    exactTimerRef.current = setTimeout(() => {
      _evaluateSchedule();
    }, delay);
  }, [_evaluateSchedule]);

  // Start the full scheduler (exact timer + catch-up interval)
  const _startScheduler = useCallback(() => {
    _stopScheduler();

    // Catch-up interval: fires every 60s as a safety net
    catchupTimerRef.current = setInterval(() => {
      _evaluateSchedule();
    }, SCHEDULER_CATCHUP_MS);

    // Evaluate immediately
    _evaluateSchedule();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [_evaluateSchedule]);

  // ── doStartRef — needed by _evaluateSchedule before doStart is defined ──────
  const doStartRef = useRef(null);

  // ── AppState listener — RE-EVALUATE IMMEDIATELY when JS resumes ─────────────
  // This is the critical fix: when Android suspends the JS thread overnight and
  // it wakes up at 7AM (or later), AppState fires 'active' and we immediately
  // check whether we should have started and do so.
  useEffect(() => {
    const sub = AppState.addEventListener('change', async (nextState) => {
      if (nextState === 'active') {
        console.log('📱 AppState active — re-evaluating schedule immediately');
        // Re-arm foreground service in case it was restarted by BootReceiver
        if (isRunningRef.current) startForegroundService();
        // Immediately check if we missed a start/stop event
        await _evaluateSchedule();
      }
    });
    return () => sub.remove();
  }, [_evaluateSchedule, startForegroundService]);

  // ── MAIN LOOP ───────────────────────────────────────────────────────────────
  const runLoop = useCallback(async () => {
    const limit   = parseInt(numStudentsRef.current, 10) || 5;
    const idleMs  = (parseInt(idleSecondsRef.current, 10) || 5) * 1000;
    const st      = startTimeRef.current, et = endTimeRef.current;
    const startHH = `${st.getHours().toString().padStart(2,'0')}:${st.getMinutes().toString().padStart(2,'0')}:00`;
    const endHH   = `${et.getHours().toString().padStart(2,'0')}:${et.getMinutes().toString().padStart(2,'0')}:59`;
    const devName = deviceNameRef.current;

    setStatusMessage('Starting SMS process...');
    updateServiceStatus('Starting SMS process...');

    try {
      await reconnect();
      _resetCycleProgressWatchdog();

      while (restartSignalRef.current === SIGNAL_NONE) {
        try {
          lastHeartbeatRef.current     = Date.now();
          watchdogAlertSentRef.current = false;

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
            cycleCountRef.current += 1;
            setCycleCount(cycleCountRef.current);
            const statusTxt = `No new records. Idle cycle ${cycleCountRef.current} — waiting ${idleSecondsRef.current}s...`;
            setStatusMessage(statusTxt);
            if (cycleCountRef.current % 10 === 0) updateServiceStatus(statusTxt);
            cycleStuckAlertSentRef.current = false;
            _resetCycleProgressWatchdog();
          } else {
            cycleCountRef.current = 0;
            setCycleCount(0);
            cycleStuckAlertSentRef.current = false;
            _resetCycleProgressWatchdog();
            updateServiceStatus(`Processing ${claimed.length} record(s)...`);

            const failedThisCycle = [];

            for (const log of claimed) {
              if (restartSignalRef.current !== SIGNAL_NONE) break;
              if (sendingSeedsRef.current.has(log.seed)) continue;
              sendingSeedsRef.current.add(log.seed);

              const studentName = log.studentname || 'Student';
              const trans       = log.trans || '';
              const fmtDT       = formatLogDateTime(log.date, log.time);
              const yr          = log.yearlevel || '', sec = log.section || '';

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
                log.smsnotify ? log.smsnotify.split(/[,;]+/).map(n => n.trim()) : []
              ).filter(isValidPhone);

              if (validNumbers.length === 0) {
                await markSent(log.seed, devName);
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
                  failedSendsRef.current[log.seed] = (failedSendsRef.current[log.seed] || 0) + 1;
                  if (failedSendsRef.current[log.seed] >= maxErrorCycles) {
                    failedThisCycle.push({ studentName, seed: log.seed });
                    delete failedSendsRef.current[log.seed];
                  }
                }
              } else {
                failedSendsRef.current[log.seed] = (failedSendsRef.current[log.seed] || 0) + 1;
                if (failedSendsRef.current[log.seed] >= maxErrorCycles) {
                  failedThisCycle.push({ studentName, seed: log.seed });
                  delete failedSendsRef.current[log.seed];
                }
              }
              sendingSeedsRef.current.delete(log.seed);
            }

            if (failedThisCycle.length > 0) {
              const failedNames = failedThisCycle.map(f => f.studentName).join(', ');
              Alert.alert('SMS Sending Error', `Failed to send SMS after ${maxErrorCycles} cycles. Check SIM load/credit.`);
              if (adminEmailsRef.current?.trim()) {
                queueEmailStable('Critical SMS Error',
                  `Failed:\n${failedNames}\n\nDevice: ${devName}\n⚠️ Check SIM card.`);
              }
              try { errorSound?.setVolume(1.0); errorSound?.play(() => {}); Vibration.vibrate([0,1000,500,1000,500,1000], false); } catch {}
            }
            setStatusMessage('Processed new records. Cycle counter reset.');
          }

          try {
            const level = await getBatteryLevel();
            if (level <= batteryThresholdRef.current && !batteryAlertSentRef.current) {
              const msg =
                `⚠️ LOW BATTERY\n\nDevice: ${deviceNameRef.current}\nLevel: ${level}%\nPlease plug in.`;
              const nums = getValidNumbers(adminNumbersRef.current);
              if (nums.length > 0) await sendSMSStable(nums, msg);
              queueEmailStable('Low Battery', msg);
              batteryAlertSentRef.current = true;
              updateServiceStatus(`⚠️ Low battery: ${level}%`);
            } else if (level > batteryThresholdRef.current) {
              batteryAlertSentRef.current = false;
            }
          } catch {}

          await sleep(idleMs);

        } catch (loopErr) {
          console.error('Loop error:', loopErr);
          const errMsg = String(loopErr?.message || loopErr).toLowerCase();
          if ((errMsg.includes('network') || errMsg.includes('timeout') || errMsg.includes('connection')) && !networkErrorSentRef.current) {
            await notifyNetworkError(errMsg);
            networkErrorSentRef.current = true;
          }
          setStatusMessage('⚠️ Reconnecting...');
          updateServiceStatus('⚠️ Reconnecting...');
          try { await reconnect(); networkErrorSentRef.current = false; } catch {}
          await sleep(5000);
          _resetCycleProgressWatchdog();
        }
      }

    } catch (outerErr) {
      console.error('Main loop outer error:', outerErr);
      await notifyNetworkError(String(outerErr));
      Alert.alert('Error', 'Something went wrong with the SMS process.');
    } finally {
      _stopCycleProgressWatchdog();
      await safeClose();
    }
  }, [
    reconnect, sendSMSStable, queueEmailStable, markSent,
    notifyNetworkError, _resetCycleProgressWatchdog, updateServiceStatus,
  ]);

  // ── LIFECYCLE COORDINATOR ───────────────────────────────────────────────────
  const lifecycleCoordinator = useCallback(async () => {
    if (coordinatorRunningRef.current) {
      console.log('Coordinator already running — ignoring');
      return;
    }
    coordinatorRunningRef.current = true;

    let isFirstRun = true;

    while (true) {
      restartSignalRef.current         = SIGNAL_NONE;
      restartReasonRef.current         = '';
      coordinatorRestartingRef.current = false;
      cycleCountRef.current            = 0; setCycleCount(0);
      sendingSeedsRef.current          = new Set();
      networkErrorSentRef.current      = false;
      lastHeartbeatRef.current         = Date.now();
      watchdogAlertSentRef.current     = false;
      cycleStuckAlertSentRef.current   = false;
      heartbeatStuckAlertSentRef.current  = false;
      heartbeatLastCycleRef.current       = 0;
      heartbeatLastChangeTimeRef.current  = Date.now();
      _stopCycleProgressWatchdog();

      setIsRunning(true);
      isRunningRef.current = true;

      startForegroundService();
      _startWatchdog();
      _armAutoRestartTicker();
      _startHeartbeatTicker();

      if (!isFirstRun) {
        const reason = restartReasonRef.current || 'Scheduled restart';
        const msg =
          `🔄 AUTO-RESTART\n\nDevice: ${deviceNameRef.current}\nReason: ${reason}\n\nSMS loop restarted.`;
        const nums = getValidNumbers(adminNumbersRef.current);
        if (nums.length > 0) { try { await sendSMSStable(nums, msg); } catch {} }
        if (adminEmailsRef.current?.trim()) { try { queueEmailStable('SMS Loop Auto-Restart', msg); } catch {} }
        setStatusMessage(`🔄 Restarted (${reason}). Running...`);
        updateServiceStatus(`🔄 Restarted: ${reason}`);
      }
      isFirstRun = false;

      try { await runLoop(); } catch (e) { console.error('runLoop threw:', e); }

      const signal = restartSignalRef.current;
      _stopWatchdog();
      _clearAutoRestartTicker();
      _stopCycleProgressWatchdog();
      _stopHeartbeatTicker();

      if (signal === SIGNAL_STOP || signal === SIGNAL_NONE) {
        console.log('🛑 Coordinator: clean stop');
        break;
      }

      const reason = restartReasonRef.current || 'Scheduled 3hr auto-restart';
      coordinatorRestartingRef.current = true;
      _armRestartHangTimer();
      setStatusMessage(`🔄 Restarting (${reason})...`);
      updateServiceStatus(`🔄 Restarting: ${reason}`);

      const preMsg =
        `🔄 RESTARTING\n\nDevice: ${deviceNameRef.current}\nReason: ${reason}\nResuming in a few seconds.`;
      const nums = getValidNumbers(adminNumbersRef.current);
      if (nums.length > 0) { try { await sendSMSStable(nums, preMsg); } catch {} }
      if (adminEmailsRef.current?.trim()) { try { queueEmailStable('SMS Loop Restarting', preMsg); } catch {} }

      await sleep(6000);
      _stopRestartHangTimer();
      coordinatorRestartingRef.current = false;
    }

    coordinatorRunningRef.current = false;
    setIsRunning(false);
    isRunningRef.current = false;
    setStatusMessage('Process stopped.');
    updateServiceStatus('Process stopped — tap to reopen');
    console.log('🛑 Coordinator: exited');
  }, [
    runLoop, sendSMSStable, queueEmailStable,
    startForegroundService, _startWatchdog, _armAutoRestartTicker,
    _startHeartbeatTicker, _armRestartHangTimer, updateServiceStatus,
  ]);

  // ── doStop ──────────────────────────────────────────────────────────────────
  const doStop = useCallback((silent = false) => {
    _requestStop();
    isRunningRef.current          = false;
    coordinatorRunningRef.current = false;
    setIsRunning(false);
    _stopWatchdog();
    _clearAutoRestartTicker();
    _stopCycleProgressWatchdog();
    _stopHeartbeatTicker();
    stopForegroundService();
    setStatusMessage('Process stopped.');
    if (!silent) Alert.alert('Process Stopped', 'SMS process stopping...');
  }, [_requestStop, stopForegroundService]);

  // ── doStart ─────────────────────────────────────────────────────────────────
  const doStart = useCallback(async () => {
    if (coordinatorRunningRef.current) return;
    restartSignalRef.current = SIGNAL_NONE;
    await lifecycleCoordinator();
  }, [lifecycleCoordinator]);

  // Keep doStartRef in sync so _evaluateSchedule always calls current doStart
  useEffect(() => { doStartRef.current = doStart; }, [doStart]);

  // ── handleStart / handleStop ─────────────────────────────────────────────────
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
    // Mark today as manually started so the scheduler doesn't double-start
    scheduledStartDateRef.current = todayDateStr();
    Alert.alert('Process Started', 'Fetching and sending SMS notifications...');
    await doStart();
  }, [numStudents, idleSeconds, deviceName, ensureSmsPermission, doStart]);

  const handleStop = useCallback(() => { doStop(false); }, [doStop]);

  // ── Mount scheduler ──────────────────────────────────────────────────────────
  useEffect(() => {
    _startScheduler();
    return () => _stopScheduler();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-arm when times change
  useEffect(() => {
    _startScheduler();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startTime, endTime]);

  const handleSettingsPress = () => { Keyboard.dismiss(); navigation?.navigate('Settings'); };

  // ── Render ──────────────────────────────────────────────────────────────────
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
              <View style={styles.inputGroup}>
                <Text style={styles.label}>Sending SMS Start Time</Text>
                <TouchableOpacity
                  style={[styles.input, displayDashboard && styles.inputDisabled]}
                  onPress={() => setShowStartPicker(true)} disabled={displayDashboard}>
                  <Text style={displayDashboard ? styles.disabledText : styles.normalText}>
                    {formatTime(startTime)}
                  </Text>
                </TouchableOpacity>
                {showStartPicker && (
                  <DateTimePicker value={startTime} mode="time" is24Hour={false}
                    display={Platform.OS === 'ios' ? 'spinner' : 'default'}
                    onChange={(e, d) => {
                      if (Platform.OS === 'android') { if (e.type === 'set' && d) setStartTime(d); setShowStartPicker(false); }
                      else { setStartTime(d || startTime); }
                    }} />
                )}
              </View>
              <View style={styles.inputGroup}>
                <Text style={styles.label}>Sending SMS End Time</Text>
                <TouchableOpacity
                  style={[styles.input, displayDashboard && styles.inputDisabled]}
                  onPress={() => setShowEndPicker(true)} disabled={displayDashboard}>
                  <Text style={displayDashboard ? styles.disabledText : styles.normalText}>
                    {formatTime(endTime)}
                  </Text>
                </TouchableOpacity>
                {showEndPicker && (
                  <DateTimePicker value={endTime} mode="time" is24Hour={false}
                    display={Platform.OS === 'ios' ? 'spinner' : 'default'}
                    onChange={(e, d) => {
                      if (Platform.OS === 'android') { if (e.type === 'set' && d) setEndTime(d); setShowEndPicker(false); }
                      else { setEndTime(d || endTime); }
                    }} />
                )}
              </View>
            </View>

            {isRunning ? (
              <View style={styles.autoRestartBadge}>
                <Text style={styles.autoRestartText}>
                  🟢 Running · 🔄 3hr restart · 🐕 Watchdog · 💓 Heartbeat · ⏰ Exact scheduler
                </Text>
              </View>
            ) : (
              <View style={styles.schedulerBadge}>
                <Text style={styles.schedulerText}>
                  ⏰ Exact scheduler · Auto-start {formatTime(startTime)} · Auto-stop {formatTime(endTime)}
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
                Status: {isRunning ? '🟢 Running (sending SMS...)' : '🔴 Stopped'}
              </Text>
              {statusMessage ? <Text style={styles.statusText}>{statusMessage}</Text> : null}
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
  autoRestartText:  { fontSize: width * 0.028, color: '#155724', fontWeight: '500' },
  schedulerBadge:   { backgroundColor: '#cce5ff', borderRadius: 6, paddingHorizontal: 10, paddingVertical: 4, marginVertical: 2 },
  schedulerText:    { fontSize: width * 0.03, color: '#004085', fontWeight: '500' },
  settingsContainer:{ flexDirection: 'row', justifyContent: 'center', alignItems: 'center', marginTop: height * 0.010, marginBottom: height * 0.015 },
  settingsText:     { fontSize: width * 0.04, color: '#0d1e30', borderBottomWidth: 1, borderBottomColor: '#0d1e30', paddingBottom: 1 },
});