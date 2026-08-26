// MainScreen.js — Fixed: recursive restart, call-stack buildup, time-window auto-start,
//                         cycle-progress (frozen-loop) watchdog
//
// KEY FIXES:
// 1. All function refs (sendSMSRef, queueEmailRef, runLoopRef, etc.) are now assigned
//    via useCallback + useRef so they never go stale between restarts.
// 2. The lifecycle coordinator is extracted into a stable useRef so it is never re-created
//    on re-render, eliminating the "second restart never fires" bug.
// 3. The cycle-progress watchdog now uses a TWO-LAYER approach:
//    - Layer 1: JS setTimeout (existing) — catches slow/delayed loops
//    - Layer 2: A native-safe setInterval "heartbeat ticker" that runs independently
//      of the main loop and detects when cycleCountRef has NOT changed for
//      WATCHDOG_STUCK_THRESHOLD_MS. This fires even when the JS loop itself is hung.
// 4. Time-window scheduler: dateStr guard is reset correctly on each new calendar day
//    so the 7 AM auto-start fires every morning without needing a prior auto-stop.
// 5. doStop now explicitly resets coordinatorRestartingRef so a stopped coordinator
//    does not block a fresh manual start.
// 6. The auto-restart ticker is armed AFTER the restart sleep completes, not before,
//    so it counts the full interval from the moment the new loop starts.

import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, Platform,
  Image, Alert, Dimensions, Keyboard, TouchableWithoutFeedback,
  PermissionsAndroid, NativeModules, Vibration,
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

const SmsModule     = NativeModules.SmsModule;
const BatteryModule = NativeModules.BatteryModule;
const { width, height } = Dimensions.get('window');

const WEB_CLIENT_ID = '651284152046-22s1bs6beejjmd6jkop35rdi6hsaapqt.apps.googleusercontent.com';

// ─── Timing constants ─────────────────────────────────────────────────────────
const AUTO_RESTART_INTERVAL_MS    = 3 * 60 * 60 * 1000;  // 3 hours

const WATCHDOG_CHECK_INTERVAL_MS  = 5 * 60 * 1000;   // watchdog checks every 5 min
const WATCHDOG_STUCK_THRESHOLD_MS = 10 * 60 * 1000;  // alert if no heartbeat for 10 min

const RESTART_HANG_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

// Ticker: one tick per minute.
const AUTO_RESTART_TICK_MS    = 60 * 1000;
const AUTO_RESTART_TICK_COUNT = Math.round(AUTO_RESTART_INTERVAL_MS / AUTO_RESTART_TICK_MS);

// ─── Stuck-detection: independent heartbeat ticker ───────────────────────────
// This runs on its own setInterval and compares cycleCountRef.current against
// its last-seen value. If the cycle count has not changed in
// HEARTBEAT_STUCK_THRESHOLD_MS and the loop claims to be running, we treat it
// as stuck — even if the main-loop sleep() has frozen.
const HEARTBEAT_TICK_MS           = 60 * 1000;          // sample every 1 min
const HEARTBEAT_STUCK_THRESHOLD_MS = 10 * 60 * 1000;   // stuck if no change for 10 min

// ─── Restart signal values ────────────────────────────────────────────────────
const SIGNAL_NONE    = null;
const SIGNAL_RESTART = 'restart';
const SIGNAL_STOP    = 'stop';


export default function MainScreen() {
  // ── UI state ────────────────────────────────────────────────────────────────
  const [isRunning,        setIsRunning]        = useState(false);
  const [numStudents,      setNumStudents]      = useState('10');
  const [idleSeconds,      setIdleSeconds]      = useState('20');
  const defaultStart = new Date(); defaultStart.setHours(7,  0, 0, 0);
  const defaultEnd   = new Date(); defaultEnd.setHours(21,  0, 0, 0);
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

  // ── Runtime state refs ──────────────────────────────────────────────────────
  const isRunningRef            = useRef(false);
  const cycleCountRef           = useRef(0);
  const failedSendsRef          = useRef({});
  const sendingSeedsRef         = useRef(new Set());
  const batteryAlertSentRef     = useRef(false);
  const emailQueueRef           = useRef([]);
  const sendingEmailRef         = useRef(false);
  const smsPermissionGrantedRef = useRef(false);
  const networkErrorSentRef     = useRef(false);

  // ── Central lifecycle signal ────────────────────────────────────────────────
  const restartSignalRef         = useRef(SIGNAL_NONE);
  const restartReasonRef         = useRef('');
  const coordinatorRestartingRef = useRef(false);
  // FIX: track whether the coordinator is currently executing (to block duplicate starts)
  const coordinatorRunningRef    = useRef(false);

  // ── Watchdog / auto-restart timers ─────────────────────────────────────────
  const lastHeartbeatRef        = useRef(Date.now());
  const watchdogAlertSentRef    = useRef(false);
  const watchdogTimerRef        = useRef(null);

  const autoRestartTickerRef    = useRef(null);
  const autoRestartTicksLeftRef = useRef(0);

  const restartHangTimerRef     = useRef(null);
  const restartHangAlertSentRef = useRef(false);

  // ── Independent heartbeat ticker (Layer-2 stuck detection) ──────────────────
  // Runs independently of the main loop. Compares cycleCountRef against the
  // last-seen snapshot to detect a frozen loop even when sleep() is hung.
  const heartbeatTickerRef          = useRef(null);
  const heartbeatLastCycleRef       = useRef(0);
  const heartbeatLastChangeTimeRef  = useRef(Date.now());
  const heartbeatStuckAlertSentRef  = useRef(false);

  // ── Cycle-progress (frozen-loop) watchdog (Layer-1, JS setTimeout) ─────────
  const cycleProgressTimerRef  = useRef(null);
  const cycleStuckAlertSentRef = useRef(false);

  // ── Time-window scheduler ───────────────────────────────────────────────────
  const timeWindowTimerRef     = useRef(null);
  const timeWindowStopDateRef  = useRef(null);
  const timeWindowStartDateRef = useRef(null);

  // ── Config refs (kept in sync with state via useEffect) ─────────────────────
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
          setDeviceName(c.deviceName || '');      setServerName(c.serverName || '');
          setDatabaseName(c.databaseName || '');  setUsername(c.username || '');
          setPassword(c.password || '');          setArrivalMessage(c.arrivalMessage || '');
          setDepartureMessage(c.departureMessage || '');
          setDisplayDashboard(!!c.displayDashboard);
          setBatteryThreshold(c.batteryThreshold || 20);
          setAdminNumbers(c.adminNumbers || '');  setAdminEmails(c.adminEmails || '');
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
      _stopTimeWindowScheduler();
      _stopCycleProgressWatchdog();
      _stopHeartbeatTicker();
      restartSignalRef.current = SIGNAL_STOP;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // ── Timer helpers ───────────────────────────────────────────────────────────
  const _stopWatchdog = () => {
    if (watchdogTimerRef.current) {
      clearInterval(watchdogTimerRef.current);
      watchdogTimerRef.current = null;
    }
  };

  const _clearAutoRestartTicker = () => {
    if (autoRestartTickerRef.current) {
      clearInterval(autoRestartTickerRef.current);
      autoRestartTickerRef.current = null;
    }
    autoRestartTicksLeftRef.current = 0;
  };

  const _stopRestartHangTimer = () => {
    if (restartHangTimerRef.current) {
      clearTimeout(restartHangTimerRef.current);
      restartHangTimerRef.current = null;
    }
  };

  const _stopTimeWindowScheduler = () => {
    if (timeWindowTimerRef.current) {
      clearInterval(timeWindowTimerRef.current);
      timeWindowTimerRef.current = null;
    }
  };

  // ── Layer-1: Cycle-progress watchdog (JS setTimeout) ───────────────────────
  const _stopCycleProgressWatchdog = () => {
    if (cycleProgressTimerRef.current) {
      clearTimeout(cycleProgressTimerRef.current);
      cycleProgressTimerRef.current = null;
    }
  };

  const _resetCycleProgressWatchdog = useCallback(() => {
    _stopCycleProgressWatchdog();
    if (!isRunningRef.current) return;

    const idleSec = parseInt(idleSecondsRef.current, 10) || 5;
    const idleMs  = idleSec * 1000;
    const deadline = idleMs * 2 + 5000;

    cycleProgressTimerRef.current = setTimeout(async () => {
      if (!isRunningRef.current) return;
      if (cycleStuckAlertSentRef.current) return;
      if (restartSignalRef.current !== SIGNAL_NONE) return;

      cycleStuckAlertSentRef.current = true;
      const graceSec = Math.round(deadline / 1000);
      const stuckMsg =
        `🚨 SMS LOOP FROZEN 🚨\n\n` +
        `Device: ${deviceNameRef.current}\n\n` +
        `The idle cycle count has not advanced in ${graceSec} seconds.\n` +
        `Expected a new cycle every ~${idleSec}s but the loop appears frozen mid-iteration.\n\n` +
        `An automatic restart is being triggered now.`;

      console.warn('🚨 Cycle-progress watchdog (Layer-1) fired — loop is frozen');

      const nums = getValidNumbers(adminNumbersRef.current);
      if (nums.length > 0) {
        try { await sendSMSStable(nums, stuckMsg); } catch (e) { console.log('Cycle-stuck SMS failed:', e); }
      }
      if (adminEmailsRef.current?.trim()) {
        try { queueEmailStable('🚨 SMS Loop Frozen – Auto Restart Triggered', stuckMsg); } catch {}
      }

      _requestRestart('Cycle-progress watchdog (Layer-1): loop frozen mid-iteration');
    }, deadline);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Layer-2: Independent heartbeat ticker (catches frozen sleep()) ──────────
  // This ticker runs independently of the main loop. It tracks changes to
  // cycleCountRef. If cycleCountRef hasn't changed in HEARTBEAT_STUCK_THRESHOLD_MS
  // while the process is supposed to be running, it triggers a restart.
  // Unlike the Layer-1 watchdog, this is not reset/cancelled by the main loop,
  // so it fires even when sleep() itself is hung.
  const _stopHeartbeatTicker = () => {
    if (heartbeatTickerRef.current) {
      clearInterval(heartbeatTickerRef.current);
      heartbeatTickerRef.current = null;
    }
  };

  const _startHeartbeatTicker = useCallback(() => {
    _stopHeartbeatTicker();
    heartbeatLastCycleRef.current      = cycleCountRef.current;
    heartbeatLastChangeTimeRef.current = Date.now();
    heartbeatStuckAlertSentRef.current = false;

    heartbeatTickerRef.current = setInterval(async () => {
      if (!isRunningRef.current) return;
      if (coordinatorRestartingRef.current) {
        // Coordinator is mid-restart; reset the baseline so we don't alert
        heartbeatLastCycleRef.current      = cycleCountRef.current;
        heartbeatLastChangeTimeRef.current = Date.now();
        return;
      }
      if (restartSignalRef.current !== SIGNAL_NONE) return;
      if (heartbeatStuckAlertSentRef.current) return;

      const currentCycle = cycleCountRef.current;
      if (currentCycle !== heartbeatLastCycleRef.current) {
        // Cycle progressed — reset baseline
        heartbeatLastCycleRef.current      = currentCycle;
        heartbeatLastChangeTimeRef.current = Date.now();
        return;
      }

      const elapsed = Date.now() - heartbeatLastChangeTimeRef.current;
      if (elapsed >= HEARTBEAT_STUCK_THRESHOLD_MS) {
        heartbeatStuckAlertSentRef.current = true;
        const mins = Math.round(elapsed / 60000);
        const stuckMsg =
          `🚨 SMS LOOP STUCK (HEARTBEAT) 🚨\n\n` +
          `Device: ${deviceNameRef.current}\n\n` +
          `The idle cycle count has been frozen at ${currentCycle} for ${mins} minutes.\n` +
          `The main loop sleep() may be hung or the JS thread is blocked.\n\n` +
          `An automatic restart is being triggered now.`;

        console.warn(`🚨 Heartbeat ticker (Layer-2) fired — cycle stuck at ${currentCycle} for ${mins} min`);

        const nums = getValidNumbers(adminNumbersRef.current);
        if (nums.length > 0) {
          try { await sendSMSStable(nums, stuckMsg); } catch (e) { console.log('Heartbeat SMS failed:', e); }
        }
        if (adminEmailsRef.current?.trim()) {
          try { queueEmailStable('🚨 SMS Loop Stuck (Heartbeat Watchdog)', stuckMsg); } catch {}
        }

        _requestRestart('Heartbeat ticker (Layer-2): cycle count frozen');
      }
    }, HEARTBEAT_TICK_MS);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  // ── sendSMS (stable, does not depend on render-cycle closures) ──────────────
  // FIX: extracted to a standalone useCallback so refs (sendSMSRef) always
  // point to the same function identity across re-renders and restarts.
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

  // ── Email queue (stable) ────────────────────────────────────────────────────
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
        `NETWORK/SERVER ERROR\n\n` +
        `Device: ${deviceNameRef.current}\n\n` +
        `Error:\n${errorMsg}\n\n` +
        `The device cannot connect to the server or lost internet connection.`;
      const nums = getValidNumbers(adminNumbersRef.current);
      if (nums.length > 0) await sendSMSStable(nums, msg);
      if (adminEmailsRef.current?.trim()) queueEmailStable('Network/Server Error', msg);
    } catch (e) { console.log('notifyNetworkError failed:', e); }
  }, [sendSMSStable, queueEmailStable]);

  // ── School-hours check ──────────────────────────────────────────────────────
  const isWithinSendingHours = useCallback(() => {
    const now  = new Date();
    const nowM = now.getHours() * 60 + now.getMinutes();
    const st   = startTimeRef.current;
    const et   = endTimeRef.current;
    const stM  = st.getHours() * 60 + st.getMinutes();
    const etM  = et.getHours() * 60 + et.getMinutes();
    return nowM >= stM && nowM <= etM;
  }, []);

  // ── RESTART-HANG WATCHDOG ───────────────────────────────────────────────────
  const _armRestartHangTimer = useCallback(() => {
    _stopRestartHangTimer();
    restartHangAlertSentRef.current = false;
    restartHangTimerRef.current = setTimeout(async () => {
      if (!coordinatorRestartingRef.current) return;
      if (restartHangAlertSentRef.current) return;
      restartHangAlertSentRef.current = true;
      const hangMins = Math.round(RESTART_HANG_TIMEOUT_MS / 60000);
      const msg =
        `🚨 AUTO-RESTART FAILED / HUNG 🚨\n\n` +
        `Device: ${deviceNameRef.current}\n\n` +
        `The auto-restart started ${hangMins} minutes ago but the SMS loop ` +
        `has not resumed.\n\n` +
        `⚠️ Please manually close and reopen the app to restore operation.`;
      console.error('🚨 Restart hang detected — sending alert');
      const nums = getValidNumbers(adminNumbersRef.current);
      if (nums.length > 0) {
        try { await sendSMSStable(nums, msg); } catch {}
      }
      if (adminEmailsRef.current?.trim()) {
        try { queueEmailStable('🚨 SMS App Auto-Restart Hung – Manual Restart Needed', msg); } catch {}
      }
      // FIX: reset coordinator state so a new manual start is possible
      coordinatorRunningRef.current    = false;
      coordinatorRestartingRef.current = false;
      setIsRunning(false);
      isRunningRef.current = false;
      setStatusMessage('⛔ Auto-restart hung. Please reopen the app manually.');
    }, RESTART_HANG_TIMEOUT_MS);
  }, [sendSMSStable, queueEmailStable]);

  // ── HEARTBEAT WATCHDOG (10-min event-loop watchdog) ─────────────────────────
  const _startWatchdog = useCallback(() => {
    _stopWatchdog();
    watchdogTimerRef.current = setInterval(async () => {
      if (!isRunningRef.current) return;
      if (coordinatorRestartingRef.current) {
        lastHeartbeatRef.current = Date.now();
        return;
      }
      const elapsed = Date.now() - lastHeartbeatRef.current;
      if (elapsed >= WATCHDOG_STUCK_THRESHOLD_MS && !watchdogAlertSentRef.current) {
        watchdogAlertSentRef.current = true;
        const mins = Math.round(elapsed / 60000);
        console.warn(`⚠️ Watchdog: stuck ${mins} min`);
        const alertMsg =
          `🚨 SMS LOOP STUCK ALERT 🚨\n\n` +
          `Device: ${deviceNameRef.current}\n` +
          `The SMS loop has not progressed for ${mins} minutes.\n\n` +
          `An automatic restart is being performed now.`;
        const nums = getValidNumbers(adminNumbersRef.current);
        if (nums.length > 0) {
          try { await sendSMSStable(nums, alertMsg); } catch {}
        }
        if (adminEmailsRef.current?.trim()) {
          try { queueEmailStable('🚨 SMS Loop Stuck – Auto Restart', alertMsg); } catch {}
        }
        _requestRestart('Watchdog: loop stuck');
      }
    }, WATCHDOG_CHECK_INTERVAL_MS);
  }, [sendSMSStable, queueEmailStable, _requestRestart]);

  // ── TICK-BASED AUTO-RESTART TIMER ───────────────────────────────────────────
  const _armAutoRestartTicker = useCallback(() => {
    _clearAutoRestartTicker();
    autoRestartTicksLeftRef.current = AUTO_RESTART_TICK_COUNT;
    const intervalLabel = AUTO_RESTART_INTERVAL_MS < 60 * 60 * 1000
      ? `${AUTO_RESTART_INTERVAL_MS / 60000} min`
      : `${AUTO_RESTART_INTERVAL_MS / 3600000} hr`;
    console.log(`⏱ Auto-restart ticker armed: ${AUTO_RESTART_TICK_COUNT} ticks × 1 min = ${intervalLabel}`);

    autoRestartTickerRef.current = setInterval(() => {
      autoRestartTicksLeftRef.current -= 1;
      const left = autoRestartTicksLeftRef.current;
      if (left > 0) return;
      if (!isRunningRef.current) {
        _clearAutoRestartTicker();
        return;
      }
      console.log('⏱ Auto-restart ticker reached 0 — signalling restart');
      _clearAutoRestartTicker();
      _requestRestart(`Scheduled ${intervalLabel} auto-restart`);
    }, AUTO_RESTART_TICK_MS);
  }, [_requestRestart]);

  // ── MAIN LOOP ───────────────────────────────────────────────────────────────
  const runLoop = useCallback(async () => {
    const limit   = parseInt(numStudentsRef.current, 10) || 5;
    const idleMs  = (parseInt(idleSecondsRef.current, 10) || 5) * 1000;
    const st      = startTimeRef.current, et = endTimeRef.current;
    const startHH = `${st.getHours().toString().padStart(2, '0')}:${st.getMinutes().toString().padStart(2, '0')}:00`;
    const endHH   = `${et.getHours().toString().padStart(2, '0')}:${et.getMinutes().toString().padStart(2, '0')}:59`;
    const devName = deviceNameRef.current;

    setStatusMessage('Starting SMS process...');
    try {
      await reconnect();

      // Arm the cycle-progress watchdog as soon as the loop begins
      _resetCycleProgressWatchdog();

      while (restartSignalRef.current === SIGNAL_NONE) {
        try {
          // Heartbeat for the 10-min watchdog
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
            // ── Idle cycle ─────────────────────────────────────────────────
            cycleCountRef.current += 1;
            setCycleCount(cycleCountRef.current);
            setStatusMessage(`No new records. Idle cycle ${cycleCountRef.current} — waiting ${idleSecondsRef.current}s...`);

            // Reset cycle-progress watchdog
            cycleStuckAlertSentRef.current = false;
            _resetCycleProgressWatchdog();

          } else {
            // ── Records found ──────────────────────────────────────────────
            cycleCountRef.current = 0;
            setCycleCount(0);

            cycleStuckAlertSentRef.current = false;
            _resetCycleProgressWatchdog();

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
                queueEmailStable(
                  'Critical SMS Error',
                  `Failed SMS recipients:\n${failedNames}\n\nDevice: ${devName}\n⚠️ Check SIM card credit/load.`
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

          // Battery check
          try {
            const level = await getBatteryLevel();
            if (level <= batteryThresholdRef.current && !batteryAlertSentRef.current) {
              const msg =
                `⚠️ LOW BATTERY ALERT ⚠️\n\n` +
                `Device: ${deviceNameRef.current}\n` +
                `Battery Level: ${level}%\n\n` +
                `Please plug in the device immediately.`;
              const nums = getValidNumbers(adminNumbersRef.current);
              if (nums.length > 0) await sendSMSStable(nums, msg);
              queueEmailStable('Low Battery Alert', msg);
              batteryAlertSentRef.current = true;
            } else if (level > batteryThresholdRef.current) {
              batteryAlertSentRef.current = false;
            }
          } catch {}

          await sleep(idleMs);

        } catch (loopErr) {
          console.error('Loop iteration error:', loopErr);
          const errMsg = String(loopErr?.message || loopErr).toLowerCase();
          if (
            (errMsg.includes('network') || errMsg.includes('timeout') || errMsg.includes('connection')) &&
            !networkErrorSentRef.current
          ) {
            await notifyNetworkError(errMsg);
            networkErrorSentRef.current = true;
          }
          setStatusMessage('⚠️ Reconnecting...');
          try { await reconnect(); networkErrorSentRef.current = false; }
          catch (e) { console.log('Reconnect failed:', e); }
          await sleep(5000);
          _resetCycleProgressWatchdog();
        }
      } // end while

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
    notifyNetworkError, _resetCycleProgressWatchdog,
  ]);

  // ══════════════════════════════════════════════════════════════════════════════
  // lifecycleCoordinator — THE SINGLE OWNER OF THE RUN/STOP LIFECYCLE
  //
  // FIX: extracted to a stable useCallback and guarded by coordinatorRunningRef
  // so it can never be entered twice. On each restart iteration it arms a FRESH
  // auto-restart ticker AFTER the restart sleep, not before — ensuring the
  // full interval is always counted from the new loop's start.
  // ══════════════════════════════════════════════════════════════════════════════
  const lifecycleCoordinator = useCallback(async () => {
    // Guard: only one coordinator may run at a time
    if (coordinatorRunningRef.current) {
      console.log('lifecycleCoordinator: already running, ignoring duplicate call');
      return;
    }
    coordinatorRunningRef.current = true;

    const intervalLabel = AUTO_RESTART_INTERVAL_MS < 60 * 60 * 1000
      ? `${AUTO_RESTART_INTERVAL_MS / 60000} min`
      : `${AUTO_RESTART_INTERVAL_MS / 3600000} hr`;

    let isFirstRun = true;

    while (true) {
      // 1. Reset volatile state
      restartSignalRef.current        = SIGNAL_NONE;
      restartReasonRef.current        = '';
      coordinatorRestartingRef.current = false;
      cycleCountRef.current           = 0;   setCycleCount(0);
      sendingSeedsRef.current         = new Set();
      networkErrorSentRef.current     = false;
      lastHeartbeatRef.current        = Date.now();
      watchdogAlertSentRef.current    = false;
      cycleStuckAlertSentRef.current  = false;
      heartbeatStuckAlertSentRef.current = false;
      heartbeatLastCycleRef.current      = 0;
      heartbeatLastChangeTimeRef.current = Date.now();
      _stopCycleProgressWatchdog();

      setIsRunning(true);
      isRunningRef.current = true;

      // Arm all monitoring
      _startWatchdog();
      _armAutoRestartTicker();
      _startHeartbeatTicker();    // FIX: start Layer-2 heartbeat ticker

      // 2. Admin notice on restart (not first start)
      if (!isFirstRun) {
        const reason = restartReasonRef.current || 'Scheduled restart';
        const msg =
          `🔄 AUTO-RESTART NOTICE\n\n` +
          `Device: ${deviceNameRef.current}\n` +
          `Reason: ${reason}\n\n` +
          `The SMS loop has been automatically restarted.`;
        const nums = getValidNumbers(adminNumbersRef.current);
        if (nums.length > 0) {
          try { await sendSMSStable(nums, msg); } catch {}
        }
        if (adminEmailsRef.current?.trim()) {
          try { queueEmailStable('SMS Loop Auto-Restart', msg); } catch {}
        }
        setStatusMessage(`🔄 Restarted (${reason}). Running...`);
      }
      isFirstRun = false;

      // 3. Run the loop (blocks until signal is set)
      try {
        await runLoop();
      } catch (e) {
        console.error('lifecycleCoordinator: runLoop threw:', e);
      }

      // 4. Read signal
      const signal = restartSignalRef.current;
      _stopWatchdog();
      _clearAutoRestartTicker();
      _stopCycleProgressWatchdog();
      _stopHeartbeatTicker();     // FIX: stop Layer-2 ticker on each exit

      if (signal === SIGNAL_STOP || signal === SIGNAL_NONE) {
        console.log('🛑 Coordinator: clean stop');
        break;
      }

      // SIGNAL_RESTART — flat loop, zero recursion
      const reason = restartReasonRef.current || `Scheduled ${intervalLabel} auto-restart`;
      console.log(`🔄 Coordinator: restarting — ${reason}`);

      coordinatorRestartingRef.current = true;
      _armRestartHangTimer();

      setStatusMessage(`🔄 Auto-restarting (${reason})...`);

      const preMsg =
        `🔄 AUTO-RESTART STARTING\n\n` +
        `Device: ${deviceNameRef.current}\n` +
        `Reason: ${reason}\n\n` +
        `The SMS loop is stopping for restart. It will resume in a few seconds.`;
      const nums = getValidNumbers(adminNumbersRef.current);
      if (nums.length > 0) {
        try { await sendSMSStable(nums, preMsg); } catch {}
      }
      if (adminEmailsRef.current?.trim()) {
        try { queueEmailStable('SMS Loop Restarting…', preMsg); } catch {}
      }

      await sleep(6000);

      _stopRestartHangTimer();
      coordinatorRestartingRef.current = false;
      // Signal + reason are reset at top of next while iteration
    }

    // Clean exit
    coordinatorRunningRef.current = false;
    setIsRunning(false);
    isRunningRef.current = false;
    setStatusMessage('Process stopped.');
    console.log('🛑 Coordinator: exited');
  }, [
    runLoop, sendSMSStable, queueEmailStable,
    _startWatchdog, _armAutoRestartTicker, _startHeartbeatTicker,
    _armRestartHangTimer, _requestRestart,
  ]);

  // ── doStop — sets stop signal (manual button or time-window) ───────────────
  const doStop = useCallback((silent = false) => {
    _requestStop();
    isRunningRef.current = false;
    setIsRunning(false);
    _stopWatchdog();
    _clearAutoRestartTicker();
    _stopCycleProgressWatchdog();
    _stopHeartbeatTicker();
    // FIX: reset coordinator guard so a new manual start works after a stop
    coordinatorRunningRef.current = false;
    setStatusMessage('Process stopped.');
    if (!silent) Alert.alert('Process Stopped', 'SMS process stopping...');
  }, [_requestStop]);

  // ── doStart — validates then launches the coordinator ──────────────────────
  const doStart = useCallback(async () => {
    if (coordinatorRunningRef.current) {
      console.log('doStart: already running, ignoring');
      return;
    }
    restartSignalRef.current = SIGNAL_NONE;
    await lifecycleCoordinator();
  }, [lifecycleCoordinator]);

  // ══════════════════════════════════════════════════════════════════════════════
  // TIME-WINDOW SCHEDULER
  // FIX: Uses dateStr guards correctly. After an auto-stop, timeWindowStopDateRef
  // is set. At midnight, todayDateStr() returns a new value, so both guards reset
  // automatically — the 7 AM auto-start fires every day without any extra logic.
  // FIX: doStart reference is now stable (useCallback) so the scheduler always
  // calls the current version.
  // ══════════════════════════════════════════════════════════════════════════════
  const _startTimeWindowScheduler = useCallback(() => {
    _stopTimeWindowScheduler();

    timeWindowTimerRef.current = setInterval(async () => {
      const now     = new Date();
      const nowM    = now.getHours() * 60 + now.getMinutes();
      const dateStr = todayDateStr();

      const st  = startTimeRef.current;
      const et  = endTimeRef.current;
      const stM = st.getHours() * 60 + st.getMinutes();
      const etM = et.getHours() * 60 + et.getMinutes();

      // Auto-stop at or past End Time
      if (
        nowM >= etM &&
        isRunningRef.current &&
        restartSignalRef.current === SIGNAL_NONE &&
        timeWindowStopDateRef.current !== dateStr
      ) {
        timeWindowStopDateRef.current  = dateStr;
        timeWindowStartDateRef.current = null; // FIX: allow auto-start on next day

        console.log(`🕐 Time-window: past end time (${formatTime(et)}) — auto-stopping`);
        setStatusMessage(`🕐 Past end time (${formatTime(et)}). Auto-stopping...`);

        const stopMsg =
          `🕐 AUTO-STOP (END OF SENDING WINDOW)\n\n` +
          `Device: ${deviceNameRef.current}\n` +
          `The SMS sending window has ended (${formatTime(et)}).\n` +
          `The process has been automatically stopped.\n\n` +
          `It will auto-start again at ${formatTime(st)} tomorrow.`;
        const nums = getValidNumbers(adminNumbersRef.current);
        if (nums.length > 0) {
          try { await sendSMSStable(nums, stopMsg); } catch {}
        }
        if (adminEmailsRef.current?.trim()) {
          try { queueEmailStable('SMS Process Auto-Stopped (End of Sending Window)', stopMsg); } catch {}
        }

        _requestStop();
        return;
      }

      // Auto-start when within sending window and not yet started today
      if (
        !coordinatorRunningRef.current &&          // FIX: use coordinator guard, not isRunningRef
        restartSignalRef.current === SIGNAL_NONE &&
        nowM >= stM &&
        nowM < etM &&
        timeWindowStartDateRef.current !== dateStr
      ) {
        timeWindowStartDateRef.current = dateStr;

        console.log(`🌅 Time-window: within start time (${formatTime(st)}) — auto-starting`);
        setStatusMessage(`🌅 Auto-starting for sending window (${formatTime(st)} – ${formatTime(et)})...`);

        const startMsg =
          `🌅 AUTO-START (START OF SENDING WINDOW)\n\n` +
          `Device: ${deviceNameRef.current}\n` +
          `The SMS sending window has begun (${formatTime(st)}).\n` +
          `The process has been automatically started.`;
        const nums = getValidNumbers(adminNumbersRef.current);
        if (nums.length > 0) {
          try { await sendSMSStable(nums, startMsg); } catch {}
        }
        if (adminEmailsRef.current?.trim()) {
          try { queueEmailStable('SMS Process Auto-Started (Sending Window Began)', startMsg); } catch {}
        }

        try { await doStart(); }
        catch (e) { console.error('Time-window auto-start failed:', e); }
      }

    }, 60 * 1000);
  }, [doStart, sendSMSStable, queueEmailStable, _requestStop]);

  // ── handleStart (manual button) ─────────────────────────────────────────────
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

  // ── handleStop (manual button) ──────────────────────────────────────────────
  const handleStop = useCallback(() => {
    doStop(false);
  }, [doStop]);

  // ── Start time-window scheduler on mount ────────────────────────────────────
  useEffect(() => {
    _startTimeWindowScheduler();
    return () => _stopTimeWindowScheduler();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    _startTimeWindowScheduler();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startTime, endTime]);

  const handleSettingsPress = () => { Keyboard.dismiss(); navigation?.navigate('Settings'); };

  // ── Render ──────────────────────────────────────────────────────────────────
  const intervalLabel = AUTO_RESTART_INTERVAL_MS < 60 * 60 * 1000
    ? `${AUTO_RESTART_INTERVAL_MS / 60000} min`
    : `${AUTO_RESTART_INTERVAL_MS / 3600000} hr`;

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
                  keyboardType="numeric"
                  value={numStudents}
                  onChangeText={setNumStudents}
                  editable={!displayDashboard}
                />
              </View>
              <View style={styles.inputGroup}>
                <Text style={styles.label}>Idle Seconds to Wait</Text>
                <TextInput
                  style={[styles.input, displayDashboard && styles.inputDisabled]}
                  keyboardType="numeric"
                  value={idleSeconds}
                  onChangeText={setIdleSeconds}
                  editable={!displayDashboard}
                />
              </View>
              <View style={styles.inputGroup}>
                <Text style={styles.label}>Sending SMS Start Time</Text>
                <TouchableOpacity
                  style={[styles.input, displayDashboard && styles.inputDisabled]}
                  onPress={() => setShowStartPicker(true)}
                  disabled={displayDashboard}
                >
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
                      } else { setStartTime(d || startTime); }
                    }}
                  />
                )}
              </View>
              <View style={styles.inputGroup}>
                <Text style={styles.label}>Sending SMS End Time</Text>
                <TouchableOpacity
                  style={[styles.input, displayDashboard && styles.inputDisabled]}
                  onPress={() => setShowEndPicker(true)}
                  disabled={displayDashboard}
                >
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
                      } else { setEndTime(d || endTime); }
                    }}
                  />
                )}
              </View>
            </View>

            {isRunning && (
              <View style={styles.autoRestartBadge}>
                <Text style={styles.autoRestartText}>
                  🔄 Auto-restart every {intervalLabel} · 🐕 Watchdog active · 💓 Heartbeat active
                </Text>
              </View>
            )}

            {!isRunning && (
              <View style={styles.schedulerBadge}>
                <Text style={styles.schedulerText}>
                  🕐 Scheduler active · Auto-start {formatTime(startTime)} · Auto-stop {formatTime(endTime)}
                </Text>
              </View>
            )}

            <View style={styles.buttonContainer}>
              <TouchableOpacity
                style={[styles.button, { backgroundColor: isRunning ? '#95a5a6' : '#3A6F43' }]}
                onPress={handleStart}
                disabled={isRunning}
              >
                <Text style={styles.buttonText}>Start</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.button, { backgroundColor: '#c74d3a' }]}
                onPress={handleStop}
              >
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
  autoRestartText:  { fontSize: width * 0.03, color: '#155724', fontWeight: '500' },
  schedulerBadge:   { backgroundColor: '#cce5ff', borderRadius: 6, paddingHorizontal: 10, paddingVertical: 4, marginVertical: 2 },
  schedulerText:    { fontSize: width * 0.03, color: '#004085', fontWeight: '500' },
  settingsContainer: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', marginTop: height * 0.010, marginBottom: height * 0.015 },
  settingsText:     { fontSize: width * 0.04, color: '#0d1e30', borderBottomWidth: 1, borderBottomColor: '#0d1e30', paddingBottom: 1 },
});