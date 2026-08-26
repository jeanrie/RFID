// MainScreen.js — Fixed: recursive restart, call-stack buildup, time-window auto-start,
//                         cycle-progress (frozen-loop) watchdog
import React, { useState, useRef, useEffect } from 'react';
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
// Change AUTO_RESTART_INTERVAL_MS to whatever interval you want.
// For production use:  3 * 60 * 60 * 1000  (3 hours)
// For testing use:    20 * 60 * 1000        (20 minutes)
const AUTO_RESTART_INTERVAL_MS    = 3 * 60 * 60 * 1000;

const WATCHDOG_CHECK_INTERVAL_MS  = 5 * 60 * 1000;   // watchdog checks every 5 min
const WATCHDOG_STUCK_THRESHOLD_MS = 10 * 60 * 1000;  // alert if no heartbeat for 10 min

// If the restart coordinator doesn't complete within this window, alert admins.
const RESTART_HANG_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

// Ticker: one tick per minute.
const AUTO_RESTART_TICK_MS    = 60 * 1000;
const AUTO_RESTART_TICK_COUNT = Math.round(AUTO_RESTART_INTERVAL_MS / AUTO_RESTART_TICK_MS);

// ─── Restart signal values ────────────────────────────────────────────────────
// The lifecycle coordinator polls restartSignalRef. Setting it to a non-null
// string causes the coordinator to stop the current loop and start a new one,
// WITHOUT nesting any async call stacks.
const SIGNAL_NONE    = null;
const SIGNAL_RESTART = 'restart'; // scheduled / watchdog restart
const SIGNAL_STOP    = 'stop';    // permanent stop (manual button or end-of-window)


export default function MainScreen() {
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

  const keepAwakeActiveRef = useRef(false);

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
  // lifecycleCoordinator reads this each iteration. Any timer writes here instead
  // of calling doStart/doStop directly — eliminates all recursive call-stack issues.
  const restartSignalRef         = useRef(SIGNAL_NONE);
  const restartReasonRef         = useRef('');
  const coordinatorRestartingRef = useRef(false);

  // ── Watchdog / auto-restart timers ─────────────────────────────────────────
  const lastHeartbeatRef        = useRef(Date.now());
  const watchdogAlertSentRef    = useRef(false);
  const watchdogTimerRef        = useRef(null);

  const autoRestartTickerRef    = useRef(null);
  const autoRestartTicksLeftRef = useRef(0);

  const restartHangTimerRef     = useRef(null);
  const restartHangAlertSentRef = useRef(false);

  // ── Cycle-progress (frozen-loop) watchdog ───────────────────────────────────
  // Detects when the loop is alive but frozen mid-iteration (cycle count stops
  // incrementing). Fires after idleSeconds×2 + 5s with no cycle tick.
  const cycleProgressTimerRef  = useRef(null);
  const cycleStuckAlertSentRef = useRef(false);

  // ── Time-window scheduler ───────────────────────────────────────────────────
  const timeWindowTimerRef     = useRef(null);
  const timeWindowStopDateRef  = useRef(null);
  const timeWindowStartDateRef = useRef(null);

  // ── Function refs ───────────────────────────────────────────────────────────
  const sendSMSRef   = useRef(null);
  const queueEmailRef = useRef(null);
  const runLoopRef   = useRef(null);
  const doStopRef    = useRef(null);
  const doStartRef   = useRef(null);
  const reconnectRef = useRef(null);

  // ── Config refs ─────────────────────────────────────────────────────────────
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
    keepAwakeActiveRef.current = true;
    return () => {
      KeepAwake.deactivate();
      keepAwakeActiveRef.current = false;
    };
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
      restartSignalRef.current = SIGNAL_STOP;
    };
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

  // ── Cycle-progress watchdog helpers ────────────────────────────────────────
  const _stopCycleProgressWatchdog = () => {
    if (cycleProgressTimerRef.current) {
      clearTimeout(cycleProgressTimerRef.current);
      cycleProgressTimerRef.current = null;
    }
  };

  // Called at the start of every idle cycle tick AND every time records are
  // processed. Resets the deadline. If the deadline expires without being reset,
  // the loop is frozen and the admin is notified immediately.
  const _resetCycleProgressWatchdog = () => {
    _stopCycleProgressWatchdog();
    if (!isRunningRef.current) return;

    const idleSec = parseInt(idleSecondsRef.current, 10) || 5;
    const idleMs  = idleSec * 1000;
    // Grace = 2× idle interval + 5 s buffer for DB/SMS overhead
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

      console.warn('🚨 Cycle-progress watchdog fired — loop is frozen');

      const nums = getValidNumbers(adminNumbersRef.current);
      if (nums.length > 0) {
        try { await sendSMSRef.current(nums, stuckMsg); }
        catch (e) { console.log('Cycle-stuck SMS failed:', e); }
      }
      if (adminEmailsRef.current?.trim()) {
        try { queueEmailRef.current('🚨 SMS Loop Frozen – Auto Restart Triggered', stuckMsg); }
        catch (e) { console.log('Cycle-stuck email failed:', e); }
      }

      _requestRestart('Cycle-progress watchdog: loop frozen mid-iteration');
    }, deadline);
  };

  // ── reconnect ───────────────────────────────────────────────────────────────
  const reconnect = async () => {
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
  };
  reconnectRef.current = reconnect;

  const ensureSmsPermission = async () => {
    if (smsPermissionGrantedRef.current) return true;
    if (Platform.OS !== 'android') return true;
    const perm = PermissionsAndroid.PERMISSIONS.SEND_SMS;
    if (await PermissionsAndroid.check(perm)) { smsPermissionGrantedRef.current = true; return true; }
    const r = await PermissionsAndroid.request(perm, {
      title: 'SMS Permission', message: 'App needs to send SMS.', buttonPositive: 'OK',
    });
    if (r === PermissionsAndroid.RESULTS.GRANTED) { smsPermissionGrantedRef.current = true; return true; }
    return false;
  };

  // ── sendSMS ─────────────────────────────────────────────────────────────────
  const sendSMS = async (numbers = [], message) => {
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
  };
  sendSMSRef.current = sendSMS;

  // ── Email queue ─────────────────────────────────────────────────────────────
  const processEmailQueue = async () => {
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
  };

  const queueEmail = (subject, message) => {
    emailQueueRef.current.push({ subject, message });
    processEmailQueue();
  };
  queueEmailRef.current = queueEmail;

  const markSent = async (seed, devName) => {
    try {
      await MSSQL.executeUpdate(
        `UPDATE logs SET smssent=1, smsmac='${devName}', smssenttime=GETDATE() WHERE seed='${seed}'`
      );
    } catch (e) { console.error('markSent:', e); }
  };

  const notifyNetworkError = async (errorMsg) => {
    try {
      const msg =
        `NETWORK/SERVER ERROR\n\n` +
        `Device: ${deviceNameRef.current}\n\n` +
        `Error:\n${errorMsg}\n\n` +
        `The device cannot connect to the server or lost internet connection.`;
      const nums = getValidNumbers(adminNumbersRef.current);
      if (nums.length > 0) await sendSMSRef.current(nums, msg);
      if (adminEmailsRef.current?.trim()) queueEmailRef.current('Network/Server Error', msg);
    } catch (e) { console.log('notifyNetworkError failed:', e); }
  };

  // ── School-hours check ──────────────────────────────────────────────────────
  const isWithinSendingHours = () => {
    const now  = new Date();
    const nowM = now.getHours() * 60 + now.getMinutes();
    const st   = startTimeRef.current;
    const et   = endTimeRef.current;
    const stM  = st.getHours() * 60 + st.getMinutes();
    const etM  = et.getHours() * 60 + et.getMinutes();
    return nowM >= stM && nowM <= etM;
  };

  // ── Signal helpers ──────────────────────────────────────────────────────────
  // Timers call these instead of doStart/doStop directly — no async, no nesting.
  const _requestRestart = (reason) => {
    if (restartSignalRef.current !== SIGNAL_NONE) return;
    console.log(`📨 Restart requested: ${reason}`);
    restartReasonRef.current = reason;
    restartSignalRef.current = SIGNAL_RESTART;
  };

  const _requestStop = () => {
    restartReasonRef.current = '';
    restartSignalRef.current = SIGNAL_STOP;
  };

  // ── RESTART-HANG WATCHDOG ───────────────────────────────────────────────────
  const _armRestartHangTimer = () => {
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
        try { await sendSMSRef.current(nums, msg); }
        catch (e) { console.log('Restart-hang SMS failed:', e); }
      }
      if (adminEmailsRef.current?.trim()) {
        try { queueEmailRef.current('🚨 SMS App Auto-Restart Hung – Manual Restart Needed', msg); }
        catch (e) { console.log('Restart-hang email failed:', e); }
      }
      setIsRunning(false);
      isRunningRef.current = false;
      setStatusMessage('⛔ Auto-restart hung. Please reopen the app manually.');
    }, RESTART_HANG_TIMEOUT_MS);
  };

  // ── HEARTBEAT WATCHDOG ──────────────────────────────────────────────────────
  // Checks every 5 min whether the loop has updated its heartbeat.
  // Fires if no heartbeat for 10 min (catches total event-loop freezes that
  // even the cycle-progress watchdog can't detect).
  const _startWatchdog = () => {
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
          try { await sendSMSRef.current(nums, alertMsg); }
          catch (e) { console.log('Watchdog SMS failed:', e); }
        }
        if (adminEmailsRef.current?.trim()) {
          try { queueEmailRef.current('🚨 SMS Loop Stuck – Auto Restart', alertMsg); }
          catch (e) { console.log('Watchdog email failed:', e); }
        }
        _requestRestart('Watchdog: loop stuck');
      }
    }, WATCHDOG_CHECK_INTERVAL_MS);
  };

  // ── TICK-BASED AUTO-RESTART TIMER ───────────────────────────────────────────
  const _armAutoRestartTicker = () => {
    _clearAutoRestartTicker();
    autoRestartTicksLeftRef.current = AUTO_RESTART_TICK_COUNT;
    const intervalLabel = AUTO_RESTART_INTERVAL_MS < 60 * 60 * 1000
      ? `${AUTO_RESTART_INTERVAL_MS / 60000} min`
      : `${AUTO_RESTART_INTERVAL_MS / 3600000} hr`;
    console.log(`⏱ Auto-restart ticker armed: ${AUTO_RESTART_TICK_COUNT} ticks × 1 min = ${intervalLabel}`);

    autoRestartTickerRef.current = setInterval(() => {
      autoRestartTicksLeftRef.current -= 1;
      const left = autoRestartTicksLeftRef.current;
      console.log(`⏱ Auto-restart ticker: ${left} ticks left`);
      if (left > 0) return;
      if (!isRunningRef.current) {
        console.log('⏱ Ticker fired but process stopped — clearing');
        _clearAutoRestartTicker();
        return;
      }
      console.log('⏱ Auto-restart ticker reached 0 — signalling restart');
      _clearAutoRestartTicker();
      _requestRestart(`Scheduled ${intervalLabel} auto-restart`);
    }, AUTO_RESTART_TICK_MS);
  };

  // ── MAIN LOOP ───────────────────────────────────────────────────────────────
  // Exits when restartSignalRef is set to anything other than SIGNAL_NONE.
  // The coordinator reads the signal after this returns and acts accordingly.
  const runLoop = async () => {
    const limit   = parseInt(numStudentsRef.current, 10) || 5;
    const idleMs  = (parseInt(idleSecondsRef.current, 10) || 5) * 1000;
    const st      = startTimeRef.current, et = endTimeRef.current;
    const startHH = `${st.getHours().toString().padStart(2, '0')}:${st.getMinutes().toString().padStart(2, '0')}:00`;
    const endHH   = `${et.getHours().toString().padStart(2, '0')}:${et.getMinutes().toString().padStart(2, '0')}:59`;
    const devName = deviceNameRef.current;

    setStatusMessage('Starting SMS process...');
    try {
      await reconnectRef.current();

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

            // Reset cycle-progress watchdog — proof that this iteration completed.
            // If the watchdog fires before the next reset, the loop is frozen.
            cycleStuckAlertSentRef.current = false;
            _resetCycleProgressWatchdog();

          } else {
            // ── Records found ──────────────────────────────────────────────
            cycleCountRef.current = 0;
            setCycleCount(0);

            // Keep watchdog alive during record-processing iterations too
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
                const ok = await sendSMS(validNumbers, message);
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
                queueEmail(
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
              if (nums.length > 0) await sendSMS(nums, msg);
              queueEmail('Low Battery Alert', msg);
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
          try { await reconnectRef.current(); networkErrorSentRef.current = false; }
          catch (e) { console.log('Reconnect failed:', e); }
          await sleep(5000);
          // Reset watchdog after recovery so it doesn't fire during reconnect delay
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
  };
  runLoopRef.current = runLoop;

  // ══════════════════════════════════════════════════════════════════════════════
  // lifecycleCoordinator — THE SINGLE OWNER OF THE RUN/STOP LIFECYCLE
  //
  // Called once when the process starts (manual or auto). Loops internally for
  // every restart — never recurses, never nests async call stacks. Only ONE
  // instance of runLoop is ever alive at a time.
  //
  // Flow:
  //   while (not stopped):
  //     1. Reset volatile state + arm timers
  //     2. Notify admins if this is a restart
  //     3. await runLoop()  ← blocks until restartSignalRef is set
  //     4. Read signal:
  //        SIGNAL_STOP    → break
  //        SIGNAL_RESTART → send notice, sleep 6 s, loop again (flat, no recursion)
  // ══════════════════════════════════════════════════════════════════════════════
  const lifecycleCoordinator = async () => {
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
      _stopCycleProgressWatchdog();

      setIsRunning(true);
      isRunningRef.current = true;

      // Arm watchdog + ticker
      _startWatchdog();
      _armAutoRestartTicker();

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
          try { await sendSMSRef.current(nums, msg); }
          catch (e) { console.log('Restart-notice SMS failed:', e); }
        }
        if (adminEmailsRef.current?.trim()) {
          try { queueEmailRef.current('SMS Loop Auto-Restart', msg); }
          catch (e) { console.log('Restart-notice email failed:', e); }
        }
        setStatusMessage(`🔄 Restarted (${reason}). Running...`);
      }
      isFirstRun = false;

      // 3. Run the loop (blocks until signal is set)
      try {
        await runLoopRef.current();
      } catch (e) {
        console.error('lifecycleCoordinator: runLoop threw:', e);
      }

      // 4. Read signal
      const signal = restartSignalRef.current;
      _stopWatchdog();
      _clearAutoRestartTicker();
      _stopCycleProgressWatchdog();

      if (signal === SIGNAL_STOP || signal === SIGNAL_NONE) {
        console.log('🛑 Coordinator: clean stop');
        break;
      }

      // SIGNAL_RESTART — flat loop iteration, zero recursion
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
        try { await sendSMSRef.current(nums, preMsg); }
        catch (e) { console.log('Pre-restart SMS failed:', e); }
      }
      if (adminEmailsRef.current?.trim()) {
        try { queueEmailRef.current('SMS Loop Restarting…', preMsg); }
        catch (e) { console.log('Pre-restart email failed:', e); }
      }

      await sleep(6000);

      _stopRestartHangTimer();
      coordinatorRestartingRef.current = false;
      // Signal + reason are reset at the top of the next iteration
    }

    setIsRunning(false);
    isRunningRef.current = false;
    setStatusMessage('Process stopped.');
    console.log('🛑 Coordinator: exited');
  };

  // ── doStop — sets stop signal (manual button or time-window) ───────────────
  const doStop = (silent = false) => {
    _requestStop();
    isRunningRef.current = false;
    setIsRunning(false);
    _stopWatchdog();
    _clearAutoRestartTicker();
    _stopCycleProgressWatchdog();
    setStatusMessage('Process stopped.');
    if (!silent) Alert.alert('Process Stopped', 'SMS process stopping...');
  };
  doStopRef.current = doStop;

  // ── doStart — validates then launches the coordinator ──────────────────────
  const doStart = async () => {
    if (isRunningRef.current) {
      console.log('doStart: already running, ignoring');
      return;
    }
    restartSignalRef.current = SIGNAL_NONE;
    await lifecycleCoordinator();
  };
  doStartRef.current = doStart;

  // ══════════════════════════════════════════════════════════════════════════════
  // TIME-WINDOW SCHEDULER
  // Checks every minute. Auto-stops at End Time, auto-starts at Start Time.
  // Fixed: auto-start no longer requires a prior auto-stop to have fired first.
  // ══════════════════════════════════════════════════════════════════════════════
  const _startTimeWindowScheduler = () => {
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
        timeWindowStartDateRef.current = null; // allow auto-start tomorrow morning

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
          try { await sendSMSRef.current(nums, stopMsg); }
          catch (e) { console.log('Time-window stop SMS failed:', e); }
        }
        if (adminEmailsRef.current?.trim()) {
          try { queueEmailRef.current('SMS Process Auto-Stopped (End of Sending Window)', stopMsg); }
          catch (e) { console.log('Time-window stop email failed:', e); }
        }

        _requestStop();
        return;
      }

      // Auto-start when within sending window and not yet started today
      if (
        !isRunningRef.current &&
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
          try { await sendSMSRef.current(nums, startMsg); }
          catch (e) { console.log('Time-window start SMS failed:', e); }
        }
        if (adminEmailsRef.current?.trim()) {
          try { queueEmailRef.current('SMS Process Auto-Started (Sending Window Began)', startMsg); }
          catch (e) { console.log('Time-window start email failed:', e); }
        }

        try { await doStartRef.current(); }
        catch (e) { console.error('Time-window auto-start failed:', e); }
      }

    }, 60 * 1000);
  };

  // ── handleStart (manual button) ─────────────────────────────────────────────
  const handleStart = async () => {
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
    await doStartRef.current();
  };

  // ── handleStop (manual button) ──────────────────────────────────────────────
  const handleStop = () => {
    doStopRef.current(false);
  };

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
                  🔄 Auto-restart every {intervalLabel} · 🐕 Watchdog active
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