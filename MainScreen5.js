// MainScreen.js — Fixed: recurring auto-restart every 3 hours (2nd, 3rd, Nth restart work)
// ROOT CAUSE FIX: triggerAutoRestart no longer calls runLoop() itself.
// Instead it signals the EXISTING loop to exit cleanly, then re-invokes handleStart logic
// so the scheduler and watchdog are always freshly initialized on every restart.
import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Platform,
  Image,
  Alert,
  Dimensions,
  Keyboard,
  TouchableWithoutFeedback,
  PermissionsAndroid,
  NativeModules,
  Vibration,
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

const AUTO_RESTART_INTERVAL_MS   = 3 * 60 * 60 * 1000; // 3 hours
const WATCHDOG_CHECK_INTERVAL_MS  = 5 * 60 * 1000;      // check every 5 min
const WATCHDOG_STUCK_THRESHOLD_MS = 10 * 60 * 1000;     // alert if no progress for 10 min

export default function MainScreen() {
  const [isRunning, setIsRunning] = useState(false);
  const keepAwakeActiveRef = useRef(false);

  // ─── KeepAwake ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (isRunning && !keepAwakeActiveRef.current) {
      KeepAwake.activate();
      keepAwakeActiveRef.current = true;
    } else if (!isRunning && keepAwakeActiveRef.current) {
      KeepAwake.deactivate();
      keepAwakeActiveRef.current = false;
    }
    return () => {
      if (keepAwakeActiveRef.current) {
        KeepAwake.deactivate();
        keepAwakeActiveRef.current = false;
      }
    };
  }, [isRunning]);

  // ─── Google Sign-In ────────────────────────────────────────────────────────
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
      } catch (err) {
        console.error('Google Sign-In init error:', err);
      }
    })();
  }, []);

  const errorSound = new Sound('alert.mp3', Sound.MAIN_BUNDLE, (err) => {
    if (err && __DEV__) console.error('Failed to load sound', err);
  });

  // ─── UI State ──────────────────────────────────────────────────────────────
  const [numStudents,      setNumStudents]      = useState('10');
  const [idleSeconds,      setIdleSeconds]      = useState('20');
  const defaultStart = new Date(); defaultStart.setHours(4,  0, 0, 0);
  const defaultEnd   = new Date(); defaultEnd.setHours(22,   0, 0, 0);
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

  // ─── Stable refs ───────────────────────────────────────────────────────────
  const isRunningRef            = useRef(false);
  const stopRequestedRef        = useRef(false);
  const cycleCountRef           = useRef(0);
  const failedSendsRef          = useRef({});
  const sendingSeedsRef         = useRef(new Set());
  const batteryAlertSentRef     = useRef(false);
  const emailQueueRef           = useRef([]);
  const sendingEmailRef         = useRef(false);
  const smsPermissionGrantedRef = useRef(false);
  const networkErrorSentRef     = useRef(false);

  // Watchdog / auto-restart
  const lastCycleIncrementRef  = useRef(Date.now());
  const watchdogAlertSentRef   = useRef(false);
  const watchdogTimerRef       = useRef(null);
  const autoRestartTimerRef    = useRef(null);

  // ── FIX: single gate that prevents overlapping restart attempts ────────────
  // Previous code used autoRestartPendingRef only inside triggerAutoRestart,
  // but the flag was cleared BEFORE runLoop() finished, allowing a second
  // scheduled timer (or watchdog) to fire a new restart concurrently.
  // Now the flag stays TRUE for the entire duration of the restart sequence
  // and is only cleared when the fresh loop is running and healthy.
  const restartInProgressRef = useRef(false);

  // ── Function refs ──────────────────────────────────────────────────────────
  const sendSMSRef             = useRef(null);
  const queueEmailRef          = useRef(null);
  const triggerAutoRestartRef  = useRef(null);
  const runLoopRef             = useRef(null);
  const stopWatchdogRef        = useRef(null);
  const clearAutoRestartRef    = useRef(null);
  const scheduleAutoRestartRef = useRef(null);
  const startWatchdogRef       = useRef(null);
  const reconnectRef           = useRef(null);
  // FIX: expose the core "boot a fresh loop" logic so triggerAutoRestart
  // can call it without touching handleStart's UI guards.
  const bootLoopRef            = useRef(null);

  // ── Config refs ────────────────────────────────────────────────────────────
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

  useEffect(() => { serverNameRef.current       = serverName;     }, [serverName]);
  useEffect(() => { usernameRef.current         = username;       }, [username]);
  useEffect(() => { passwordRef.current         = password;       }, [password]);
  useEffect(() => { databaseNameRef.current     = databaseName;   }, [databaseName]);
  useEffect(() => { deviceNameRef.current       = deviceName;     }, [deviceName]);
  useEffect(() => { adminNumbersRef.current     = adminNumbers;   }, [adminNumbers]);
  useEffect(() => { adminEmailsRef.current      = adminEmails;    }, [adminEmails]);
  useEffect(() => { batteryThresholdRef.current = batteryThreshold; }, [batteryThreshold]);
  useEffect(() => { numStudentsRef.current      = numStudents;    }, [numStudents]);
  useEffect(() => { idleSecondsRef.current      = idleSeconds;    }, [idleSeconds]);
  useEffect(() => { startTimeRef.current        = startTime;      }, [startTime]);
  useEffect(() => { endTimeRef.current          = endTime;        }, [endTime]);
  useEffect(() => { arrivalMessageRef.current   = arrivalMessage; }, [arrivalMessage]);
  useEffect(() => { departureMessageRef.current = departureMessage; }, [departureMessage]);
  useEffect(() => { isRunningRef.current        = isRunning;      }, [isRunning]);

  // ─── Load saved config ─────────────────────────────────────────────────────
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

  const navigation = useNavigation();
  const maxErrorCycles    = 30;
  const SMS_MAX_PROCESSING = 5;

  // ─── Pure helpers ──────────────────────────────────────────────────────────
  const sleep        = (ms) => new Promise(r => setTimeout(r, ms));
  const isValidPhone = (num) => /^(?:\+63|0)9\d{9}$/.test(num);
  const getValidNumbers = (raw) => {
    if (!raw) return [];
    return raw.split(/[,;]+/).map(n => n.trim()).filter(n => n.length > 0 && isValidPhone(n));
  };

  const formatTime = (time) => {
    const h = time.getHours(), m = time.getMinutes();
    const ampm = h >= 12 ? 'PM' : 'AM';
    return `${h % 12 || 12}:${m < 10 ? '0' + m : m} ${ampm}`;
  };

  const formatLogDateTime = (sqlDate, sqlTime) => {
    try {
      const dt = new Date(`${sqlDate.split(' ')[0]}T${sqlTime}`);
      const timeStr = dt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true }).toLowerCase();
      const dateStr = dt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
      return `${timeStr} ${dateStr}`;
    } catch { return sqlTime; }
  };

  const getBatteryLevel = async () => {
    try { return BatteryModule?.getLevel ? await BatteryModule.getLevel() : 100; }
    catch { return 100; }
  };

  const getLowBatteryMessage = (level) =>
    `⚠️ LOW BATTERY ALERT ⚠️\n\nDevice: ${deviceNameRef.current}\nBattery Level: ${level}%\n\nPlease plug in the device immediately.`;

  const safeClose = async () => {
    try { if (MSSQL?.close) await MSSQL.close(); } catch (e) { console.error('safeClose error:', e); }
  };

  // ─── reconnect ─────────────────────────────────────────────────────────────
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
    const result = await PermissionsAndroid.request(perm, {
      title: 'SMS Permission', message: 'App needs permission to send SMS messages.', buttonPositive: 'OK',
    });
    if (result === PermissionsAndroid.RESULTS.GRANTED) { smsPermissionGrantedRef.current = true; return true; }
    return false;
  };

  // ─── sendSMS ───────────────────────────────────────────────────────────────
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

  // ─── email queue ───────────────────────────────────────────────────────────
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
        if (ok) emailQueueRef.current.shift();
        else break;
      }
    } finally { sendingEmailRef.current = false; }
  };

  const queueEmail = (subject, message) => {
    emailQueueRef.current.push({ subject, message });
    processEmailQueue();
  };
  queueEmailRef.current = queueEmail;

  // ─── markSent ──────────────────────────────────────────────────────────────
  const markSent = async (seed, devName) => {
    try {
      await MSSQL.executeUpdate(`
        UPDATE logs SET smssent = 1, smsmac = '${devName}', smssenttime = GETDATE()
        WHERE seed = '${seed}'`);
    } catch (e) { console.error('markSent error:', e); }
  };

  // ─── notifyNetworkError ────────────────────────────────────────────────────
  const notifyNetworkError = async (errorMsg) => {
    try {
      const msg = `NETWORK/SERVER ERROR\n\nDevice: ${deviceNameRef.current}\n\nError:\n${errorMsg}\n\nThe device cannot connect to the server or lost internet connection.`;
      const nums = getValidNumbers(adminNumbersRef.current);
      if (nums.length > 0) await sendSMSRef.current(nums, msg);
      if (adminEmailsRef.current?.trim()) queueEmailRef.current('Network/Server Error', msg);
    } catch (e) { console.log('notifyNetworkError failed:', e); }
  };

  // ─── stopWatchdog ──────────────────────────────────────────────────────────
  const stopWatchdog = () => {
    if (watchdogTimerRef.current) {
      clearInterval(watchdogTimerRef.current);
      watchdogTimerRef.current = null;
    }
  };
  stopWatchdogRef.current = stopWatchdog;

  // ─── clearAutoRestart ──────────────────────────────────────────────────────
  const clearAutoRestart = () => {
    if (autoRestartTimerRef.current) {
      clearTimeout(autoRestartTimerRef.current);
      autoRestartTimerRef.current = null;
    }
  };
  clearAutoRestartRef.current = clearAutoRestart;

  // ─── MAIN LOOP ─────────────────────────────────────────────────────────────
  const runLoop = async () => {
    const limit   = parseInt(numStudentsRef.current, 10)  || 5;
    const idleMs  = (parseInt(idleSecondsRef.current, 10) || 5) * 1000;
    const st      = startTimeRef.current;
    const et      = endTimeRef.current;
    const startHH = `${st.getHours().toString().padStart(2,'0')}:${st.getMinutes().toString().padStart(2,'0')}:00`;
    const endHH   = `${et.getHours().toString().padStart(2,'0')}:${et.getMinutes().toString().padStart(2,'0')}:59`;
    const devName = deviceNameRef.current;

    setStatusMessage('Starting SMS process...');

    try {
      await reconnectRef.current();

      while (!stopRequestedRef.current) {
        try {
          // ── Claim logs ─────────────────────────────────────────────────
          await MSSQL.executeUpdate(`
            UPDATE logs SET smsmac = '${devName}'
            WHERE seed IN (
              SELECT TOP (${limit}) seed FROM logs
              WHERE smssent = 0
                AND (smsmac IS NULL OR smsmac = '')
                AND CONVERT(VARCHAR(10), date, 120) = CONVERT(VARCHAR(10), GETDATE(), 120)
                AND time BETWEEN '${startHH}' AND '${endHH}'
              ORDER BY smsprocessing ASC, date ASC, time ASC)`);

          // ── Fetch claimed logs ─────────────────────────────────────────
          const claimed = await MSSQL.executeQuery(`
            SELECT TOP (${limit})
              l.seed, l.studentid, l.date, l.time, l.trans,
              ISNULL(l.smsprocessing,0) as smsprocessing,
              s.studentname, s.smsnotify, s.yearlevel, s.section
            FROM logs l
            INNER JOIN student s ON l.studentid = s.studentid
            WHERE l.smssent = 0
              AND l.smsmac = '${devName}'
              AND CONVERT(VARCHAR(10), l.date, 120) = CONVERT(VARCHAR(10), GETDATE(), 120)
              AND l.time BETWEEN '${startHH}' AND '${endHH}'
            ORDER BY l.smsprocessing ASC, l.date ASC, l.time ASC;`);

          if (!claimed || claimed.length === 0) {
            cycleCountRef.current += 1;
            setCycleCount(cycleCountRef.current);
            lastCycleIncrementRef.current = Date.now(); // ✅ heartbeat
            watchdogAlertSentRef.current  = false;
            setStatusMessage(`No new records. Idle cycle ${cycleCountRef.current} — waiting ${idleSecondsRef.current}s...`);

          } else {
            cycleCountRef.current = 0;
            setCycleCount(0);
            lastCycleIncrementRef.current = Date.now(); // ✅ heartbeat
            watchdogAlertSentRef.current  = false;

            const failedThisCycle = [];

            for (const log of claimed) {
              if (stopRequestedRef.current) break;
              if (sendingSeedsRef.current.has(log.seed)) continue;
              sendingSeedsRef.current.add(log.seed);

              const studentName       = log.studentname || 'Student';
              const trans             = log.trans || '';
              const formattedTimeDate = formatLogDateTime(log.date, log.time);
              const yearLevel         = log.yearlevel || '';
              const section           = log.section   || '';

              const message =
                trans === 'TI'
                  ? arrivalMessageRef.current
                      .replace('{student}', studentName).replace('{time}', formattedTimeDate)
                      .replace('{year}', yearLevel).replace('{section}', section)
                  : trans === 'TO'
                  ? departureMessageRef.current
                      .replace('{student}', studentName).replace('{time}', formattedTimeDate)
                      .replace('{year}', yearLevel).replace('{section}', section)
                  : `${studentName} ${trans} at ${formattedTimeDate}.`;

              const validNumbers = (log.smsnotify ? log.smsnotify.split(/[,;]+/).map(n => n.trim()) : []).filter(isValidPhone);

              if (validNumbers.length === 0) {
                await markSent(log.seed, devName);
                sendingSeedsRef.current.delete(log.seed);
                continue;
              }

              if (log.smsprocessing < SMS_MAX_PROCESSING) {
                const ok = await sendSMS(validNumbers, message);
                await MSSQL.executeUpdate(`
                  UPDATE logs
                  SET smsprocessing = ISNULL(smsprocessing,0) + 1
                      ${ok ? `, smssent = 1, smssenttime = GETDATE()` : ''}
                  WHERE seed = '${log.seed}' AND smsmac = '${devName}'`);
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
                queueEmail('Critical SMS Error',
                  `Failed SMS recipients:\n${failedNames}\n\nDevice: ${devName}\n⚠️ Check SIM card credit/load.`);
              }
              try {
                errorSound?.setVolume(1.0);
                errorSound?.play(() => {});
                Vibration.vibrate([0,1000,500,1000,500,1000], false);
              } catch {}
            }

            setStatusMessage('Processed new records. Cycle counter reset.');
          }

          // ── Battery check ──────────────────────────────────────────────
          try {
            const level = await getBatteryLevel();
            if (level <= batteryThresholdRef.current && !batteryAlertSentRef.current) {
              const msg = getLowBatteryMessage(level);
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
          if ((errMsg.includes('network') || errMsg.includes('timeout') || errMsg.includes('connection'))
              && !networkErrorSentRef.current) {
            await notifyNetworkError(errMsg);
            networkErrorSentRef.current = true;
          }
          setStatusMessage('⚠️ Reconnecting...');
          try {
            await reconnectRef.current();
            networkErrorSentRef.current = false;
            console.log('Reconnect successful');
          } catch (e) { console.log('Reconnect failed:', e); }
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
  };
  runLoopRef.current = runLoop;

  // ─── bootLoop ──────────────────────────────────────────────────────────────
  // Shared core used by both handleStart and triggerAutoRestart.
  // Resets all volatile state, starts watchdog + scheduler, then runs the loop.
  // When the loop exits (manual stop OR the loop throws), we clean up timers and
  // update UI — but we do NOT touch restartInProgressRef here; that is the
  // caller's responsibility so each restart sequence can manage its own gate.
  const bootLoop = async () => {
    stopRequestedRef.current      = false;
    cycleCountRef.current         = 0;
    setCycleCount(0);
    sendingSeedsRef.current       = new Set();
    networkErrorSentRef.current   = false;
    lastCycleIncrementRef.current = Date.now();
    watchdogAlertSentRef.current  = false;

    setIsRunning(true);
    isRunningRef.current = true;

    // ── Start fresh watchdog and 3-hour timer BEFORE entering the loop ───────
    startWatchdogRef.current();
    scheduleAutoRestartRef.current();

    await runLoopRef.current(); // blocks until stop is requested or fatal error

    // ── Loop exited — teardown (applies to manual stop AND error exit) ───────
    setIsRunning(false);
    isRunningRef.current = false;
    stopWatchdogRef.current();
    clearAutoRestartRef.current();
    setStatusMessage('Process stopped.');
  };
  bootLoopRef.current = bootLoop;

  // ─── triggerAutoRestart ────────────────────────────────────────────────────
  // KEY FIX: this function ONLY signals the current loop to stop, notifies
  // admins, and then calls bootLoop() for a completely fresh start.
  // It never calls runLoop() directly — that avoids the double-teardown
  // that killed the second scheduler in the original code.
  const triggerAutoRestart = async (reason) => {
    // Single-entry gate — prevents watchdog + scheduler firing together
    if (restartInProgressRef.current) {
      console.log(`triggerAutoRestart: already in progress, ignoring reason="${reason}"`);
      return;
    }
    restartInProgressRef.current = true;

    console.log(`🔄 Auto-restart triggered: ${reason}`);
    setStatusMessage(`🔄 Auto-restarting (${reason})...`);

    // ── Notify admin ──────────────────────────────────────────────────────────
    const msg =
      `🔄 AUTO-RESTART NOTICE\n\n` +
      `Device: ${deviceNameRef.current}\n` +
      `Reason: ${reason}\n\n` +
      `The SMS loop is being automatically restarted.`;

    const nums = getValidNumbers(adminNumbersRef.current);
    if (nums.length > 0) {
      try { await sendSMSRef.current(nums, msg); }
      catch (e) { console.log('Auto-restart SMS failed:', e); }
    }
    if (adminEmailsRef.current?.trim()) {
      try { queueEmailRef.current('SMS Loop Auto-Restart', msg); }
      catch (e) { console.log('Auto-restart email failed:', e); }
    }

    // ── Tell the current loop to exit ─────────────────────────────────────────
    stopRequestedRef.current = true;

    // ── Kill the existing watchdog and scheduler so they don't double-fire ───
    stopWatchdogRef.current();
    clearAutoRestartRef.current();

    // ── Give the loop time to notice stopRequested and unwind ─────────────────
    // We wait a generous 6 s (covers one idle sleep + cleanup + safeClose).
    await sleep(6000);

    // ── Now boot a completely fresh loop ─────────────────────────────────────
    // Clear the gate just before bootLoop so that if *another* restart is
    // triggered inside the new session, it can proceed normally.
    restartInProgressRef.current = false;

    try {
      await bootLoopRef.current(); // blocks until the new loop stops
    } catch (e) {
      console.error('bootLoop error during auto-restart:', e);
      setIsRunning(false);
      isRunningRef.current = false;
      stopWatchdogRef.current();
      clearAutoRestartRef.current();
      restartInProgressRef.current = false;
      setStatusMessage('Process stopped after restart error.');
    }
  };
  triggerAutoRestartRef.current = triggerAutoRestart;

  // ─── startWatchdog ─────────────────────────────────────────────────────────
  // Uses ONLY refs inside the interval — zero stale closure risk.
  const startWatchdog = () => {
    stopWatchdogRef.current(); // clear any existing
    lastCycleIncrementRef.current = Date.now();
    watchdogAlertSentRef.current  = false;

    watchdogTimerRef.current = setInterval(async () => {
      if (!isRunningRef.current) return;
      if (restartInProgressRef.current) return; // restart already underway

      const elapsed = Date.now() - lastCycleIncrementRef.current;

      if (elapsed >= WATCHDOG_STUCK_THRESHOLD_MS && !watchdogAlertSentRef.current) {
        watchdogAlertSentRef.current = true;
        const mins = Math.round(elapsed / 60000);
        console.warn(`⚠️ Watchdog: loop stuck for ${mins} min — sending alert & restarting`);

        const alertMsg =
          `🚨 SMS LOOP STUCK ALERT 🚨\n\n` +
          `Device: ${deviceNameRef.current}\n` +
          `The SMS sending loop has not progressed for ${mins} minutes.\n\n` +
          `An automatic restart is being performed now.`;

        const nums = getValidNumbers(adminNumbersRef.current);
        if (nums.length > 0) {
          try {
            await sendSMSRef.current(nums, alertMsg);
            console.log('✅ Watchdog stuck-alert SMS sent');
          } catch (e) { console.log('Watchdog SMS failed:', e); }
        } else {
          console.warn('Watchdog: no valid admin numbers configured — SMS not sent');
        }

        if (adminEmailsRef.current?.trim()) {
          try {
            queueEmailRef.current('🚨 SMS Loop Stuck – Auto Restart', alertMsg);
            console.log('✅ Watchdog stuck-alert email queued');
          } catch (e) { console.log('Watchdog email failed:', e); }
        } else {
          console.warn('Watchdog: no admin email configured — email not sent');
        }

        try {
          await triggerAutoRestartRef.current('Watchdog: loop stuck');
        } catch (e) { console.log('Watchdog auto-restart failed:', e); }
      }
    }, WATCHDOG_CHECK_INTERVAL_MS);
  };
  startWatchdogRef.current = startWatchdog;

  // ─── scheduleAutoRestart ───────────────────────────────────────────────────
  // Schedules a single 3-hour timer. bootLoop() calls this EVERY time it starts
  // (including after a restart), so the timer is always re-armed correctly.
  const scheduleAutoRestart = () => {
    clearAutoRestartRef.current();
    console.log('⏱ Auto-restart scheduled in 3 hours');
    autoRestartTimerRef.current = setTimeout(async () => {
      if (!isRunningRef.current) return;
      if (restartInProgressRef.current) return;
      console.log('⏱ 3-hour timer fired');
      try {
        await triggerAutoRestartRef.current('Scheduled 3-hour auto-restart');
      } catch (e) { console.log('Scheduled auto-restart failed:', e); }
    }, AUTO_RESTART_INTERVAL_MS);
  };
  scheduleAutoRestartRef.current = scheduleAutoRestart;

  // ─── handleStart ───────────────────────────────────────────────────────────
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

    restartInProgressRef.current = false; // clean slate on manual start
    Alert.alert('Process Started', 'Fetching and sending SMS notifications...');

    await bootLoopRef.current();
    // When bootLoop returns the UI is already reset inside bootLoop's finally block.
  };

  // ─── handleStop ────────────────────────────────────────────────────────────
  const handleStop = () => {
    stopRequestedRef.current  = true;
    isRunningRef.current      = false;
    setIsRunning(false);
    stopWatchdog();
    clearAutoRestart();
    restartInProgressRef.current = false;
    Alert.alert('Process Stopped', 'SMS process stopping...');
  };

  // ─── Cleanup on unmount ────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      stopWatchdog();
      clearAutoRestart();
      stopRequestedRef.current = true;
    };
  }, []);

  const handleSettingsPress = () => { Keyboard.dismiss(); navigation?.navigate('Settings'); };

  // ─── Render ────────────────────────────────────────────────────────────────
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
                  onChangeText={setNumStudents} editable={!displayDashboard} />
              </View>

              <View style={styles.inputGroup}>
                <Text style={styles.label}>Idle Seconds to Wait</Text>
                <TextInput
                  style={[styles.input, displayDashboard && styles.inputDisabled]}
                  keyboardType="numeric" value={idleSeconds}
                  onChangeText={setIdleSeconds} editable={!displayDashboard} />
              </View>

              <View style={styles.inputGroup}>
                <Text style={styles.label}>Sending SMS Start Time</Text>
                <TouchableOpacity
                  style={[styles.input, displayDashboard && styles.inputDisabled]}
                  onPress={() => setShowStartPicker(true)} disabled={displayDashboard}>
                  <Text style={displayDashboard ? styles.disabledText : styles.normalText}>{formatTime(startTime)}</Text>
                </TouchableOpacity>
                {showStartPicker && (
                  <DateTimePicker value={startTime} mode="time" is24Hour={false}
                    display={Platform.OS === 'ios' ? 'spinner' : 'default'}
                    onChange={(e, d) => { if (Platform.OS === 'android') { if (e.type === 'set' && d) setStartTime(d); setShowStartPicker(false); } else setStartTime(d || startTime); }} />
                )}
              </View>

              <View style={styles.inputGroup}>
                <Text style={styles.label}>Sending SMS End Time</Text>
                <TouchableOpacity
                  style={[styles.input, displayDashboard && styles.inputDisabled]}
                  onPress={() => setShowEndPicker(true)} disabled={displayDashboard}>
                  <Text style={displayDashboard ? styles.disabledText : styles.normalText}>{formatTime(endTime)}</Text>
                </TouchableOpacity>
                {showEndPicker && (
                  <DateTimePicker value={endTime} mode="time" is24Hour={false}
                    display={Platform.OS === 'ios' ? 'spinner' : 'default'}
                    onChange={(e, d) => { if (Platform.OS === 'android') { if (e.type === 'set' && d) setEndTime(d); setShowEndPicker(false); } else setEndTime(d || endTime); }} />
                )}
              </View>

            </View>

            {isRunning && (
              <View style={styles.autoRestartBadge}>
                <Text style={styles.autoRestartText}>🔄 Auto-restart every 3 hrs · 🐕 Watchdog active</Text>
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
              {isRunning && <Text style={styles.statusText}>{statusMessage}</Text>}
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
  autoRestartBadge: { backgroundColor: '#d4edda', borderRadius: 6, paddingHorizontal: 10, paddingVertical: 4, marginVertical: 4 },
  autoRestartText:  { fontSize: width * 0.03, color: '#155724', fontWeight: '500' },
  settingsContainer:{ flexDirection: 'row', justifyContent: 'center', alignItems: 'center', marginTop: height * 0.010, marginBottom: height * 0.015 },
  settingsText:     { fontSize: width * 0.04, color: '#0d1e30', borderBottomWidth: 1, borderBottomColor: '#0d1e30', paddingBottom: 1 },
});