// MainScreen.js — Auto-restart mimics manual Stop → Start button press
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

// ─── Timing constants ────────────────────────────────────────────────────────
// Change AUTO_RESTART_INTERVAL_MS to whatever interval you want.
// AUTO_RESTART_TICK_MS and AUTO_RESTART_TICK_COUNT update automatically.
// For production use:  3 * 60 * 60 * 1000  (3 hours)
// For testing use:    20 * 60 * 1000        (20 minutes)
const AUTO_RESTART_INTERVAL_MS   = 2 * 60 * 60 * 1000 ; // ← change this only

const WATCHDOG_CHECK_INTERVAL_MS  = 5 * 60 * 1000;  // watchdog checks every 1 min
const WATCHDOG_STUCK_THRESHOLD_MS = 10 * 60 * 1000;  // alert if no heartbeat for 5 min (testing)

// Ticker: one tick per minute. Count = how many ticks until restart.
// Both are derived automatically — never edit these two lines directly.
const AUTO_RESTART_TICK_MS    = 60 * 1000;
const AUTO_RESTART_TICK_COUNT = Math.round(AUTO_RESTART_INTERVAL_MS / AUTO_RESTART_TICK_MS);
// e.g. 20 min → 20 ticks; 3 hrs → 180 ticks


export default function MainScreen() {
  const [isRunning,        setIsRunning]        = useState(false);
  const [numStudents,      setNumStudents]      = useState('10');
  const [idleSeconds,      setIdleSeconds]      = useState('20');
  const defaultStart = new Date(); defaultStart.setHours(4,  0, 0, 0);
  const defaultEnd   = new Date(); defaultEnd.setHours(22,  0, 0, 0);
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

  const keepAwakeActiveRef      = useRef(false);

  // ── Runtime state refs ─────────────────────────────────────────────────────
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
  const idleStuckAlertSentRef   = useRef(false);

  // ── Watchdog / auto-restart refs ──────────────────────────────────────────
  const lastHeartbeatRef        = useRef(Date.now());
  const watchdogAlertSentRef    = useRef(false);
  const watchdogTimerRef        = useRef(null);

  // Tick-based auto-restart (immune to Android Doze killing long setTimeout)
  const autoRestartTickerRef    = useRef(null);
  const autoRestartTicksLeftRef = useRef(0);

  // Gate: true only during the brief stop→sleep→start window
  const autoRestartActiveRef    = useRef(false);

  // ── Function refs (so timers always call the latest version) ──────────────
  const sendSMSRef             = useRef(null);
  const queueEmailRef          = useRef(null);
  const runLoopRef             = useRef(null);
  const doStopRef              = useRef(null);
  const doStartRef             = useRef(null);
  const reconnectRef           = useRef(null);

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

  // ── KeepAwake ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (isRunning && !keepAwakeActiveRef.current) {
      KeepAwake.activate(); keepAwakeActiveRef.current = true;
    } else if (!isRunning && keepAwakeActiveRef.current) {
      KeepAwake.deactivate(); keepAwakeActiveRef.current = false;
    }
    return () => {
      if (keepAwakeActiveRef.current) { KeepAwake.deactivate(); keepAwakeActiveRef.current = false; }
    };
  }, [isRunning]);

  // ── Google Sign-In ─────────────────────────────────────────────────────────
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

  // ── Load saved config ──────────────────────────────────────────────────────
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

  // ── Cleanup on unmount ─────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      _stopWatchdog();
      _clearAutoRestartTicker();
      stopRequestedRef.current = true;
    };
  }, []);

  const navigation       = useNavigation();
  const maxErrorCycles   = 30;
  const SMS_MAX_PROCESSING = 5;

  const errorSound = new Sound('alert.mp3', Sound.MAIN_BUNDLE, (err) => {
    if (err && __DEV__) console.error('Failed to load sound', err);
  });

  // ── Pure helpers ───────────────────────────────────────────────────────────
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

  // ── Timer helpers ──────────────────────────────────────────────────────────
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

  // ── reconnect ──────────────────────────────────────────────────────────────
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

  // ── sendSMS ────────────────────────────────────────────────────────────────
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

  // ── Email queue ────────────────────────────────────────────────────────────
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

  // ── School-hours check ─────────────────────────────────────────────────────
  const isWithinSendingHours = () => {
    const now  = new Date();
    const nowM = now.getHours() * 60 + now.getMinutes();
    const st   = startTimeRef.current;
    const et   = endTimeRef.current;
    const stM  = st.getHours() * 60 + st.getMinutes();
    const etM  = et.getHours() * 60 + et.getMinutes();
    return nowM >= stM && nowM <= etM;
  };

  const IDLE_STUCK_CYCLE_LIMIT = 600;

  // ── MAIN LOOP ──────────────────────────────────────────────────────────────
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

      while (!stopRequestedRef.current) {
        try {
          // Heartbeat BEFORE any DB call — ensures watchdog sees a live pulse
          // even if a previous DB call is still pending/hung.
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

            if (
              isWithinSendingHours() &&
              cycleCountRef.current >= IDLE_STUCK_CYCLE_LIMIT &&
              !idleStuckAlertSentRef.current
            ) {
              idleStuckAlertSentRef.current = true;
              const totalMinutes = Math.round(
                (cycleCountRef.current * (parseInt(idleSecondsRef.current, 10) || 5)) / 60
              );
              const stuckMsg =
                `⚠️ SMS LOOP IDLE DURING SCHOOL HOURS ⚠️\n\n` +
                `Device: ${deviceNameRef.current}\n` +
                `The loop has completed ${cycleCountRef.current} idle cycles ` +
                `(~${totalMinutes} minutes) during school hours without processing any new records.\n\n` +
                `The loop may be stuck. Please close and reopen the app manually to restart it.`;

              console.warn(`⚠️ Idle-stuck alert fired at cycle ${cycleCountRef.current}`);

              const nums = getValidNumbers(adminNumbersRef.current);
              if (nums.length > 0) {
                try { await sendSMSRef.current(nums, stuckMsg); }
                catch (e) { console.log('Idle-stuck SMS failed:', e); }
              }
              if (adminEmailsRef.current?.trim()) {
                try {
                  queueEmailRef.current(
                    'SMS Loop Idle During School Hours - Manual Restart Needed',
                    stuckMsg
                  );
                } catch (e) { console.log('Idle-stuck email failed:', e); }
              }
            }

          } else {
            // ── Records found — reset idle state ───────────────────────────
            cycleCountRef.current        = 0;
            setCycleCount(0);
            idleStuckAlertSentRef.current = false;

            const failedThisCycle = [];

            for (const log of claimed) {
              if (stopRequestedRef.current) break;
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

          // ── Battery check ───────────────────────────────────────────────
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

  // ══════════════════════════════════════════════════════════════════════════
  // doStop — identical to pressing Stop button, but optional silent mode
  // ══════════════════════════════════════════════════════════════════════════
  const doStop = (silent = false) => {
    stopRequestedRef.current = true;
    isRunningRef.current     = false;
    setIsRunning(false);
    _stopWatchdog();
    _clearAutoRestartTicker();
    setStatusMessage('Process stopped.');
    if (!silent) Alert.alert('Process Stopped', 'SMS process stopping...');
  };
  doStopRef.current = doStop;

  // ══════════════════════════════════════════════════════════════════════════
  // doStart — identical to pressing Start button.
  // Arms the watchdog + tick-based auto-restart, then runs the loop.
  // ══════════════════════════════════════════════════════════════════════════
  const doStart = async () => {
    // Reset all volatile state
    stopRequestedRef.current      = false;
    cycleCountRef.current         = 0;   setCycleCount(0);
    sendingSeedsRef.current       = new Set();
    networkErrorSentRef.current   = false;
    idleStuckAlertSentRef.current = false;
    lastHeartbeatRef.current      = Date.now();
    watchdogAlertSentRef.current  = false;

    // Clear the restart gate so the 2nd, 3rd, Nth restart all work
    autoRestartActiveRef.current  = false;

    setIsRunning(true);
    isRunningRef.current = true;

    // ── Start watchdog ─────────────────────────────────────────────────────
    _stopWatchdog();
    watchdogTimerRef.current = setInterval(async () => {
      if (!isRunningRef.current)        return;
      if (autoRestartActiveRef.current) return;

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
          try {
            await sendSMSRef.current(nums, alertMsg);
            console.log('✅ Watchdog alert SMS sent');
          } catch (e) { console.log('Watchdog SMS failed:', e); }
        }
        if (adminEmailsRef.current?.trim()) {
          try { queueEmailRef.current('🚨 SMS Loop Stuck – Auto Restart', alertMsg); }
          catch (e) { console.log('Watchdog email failed:', e); }
        }

        try { await _autoRestart('Watchdog: loop stuck'); }
        catch (e) { console.log('Watchdog auto-restart failed:', e); }
      }
    }, WATCHDOG_CHECK_INTERVAL_MS);

    // ── Tick-based auto-restart ────────────────────────────────────────────
    _clearAutoRestartTicker();
    autoRestartTicksLeftRef.current = AUTO_RESTART_TICK_COUNT;
    const intervalLabel = AUTO_RESTART_INTERVAL_MS < 60 * 60 * 1000
      ? `${AUTO_RESTART_INTERVAL_MS / 60000} min`
      : `${AUTO_RESTART_INTERVAL_MS / 3600000} hr`;
    console.log(`⏱ Auto-restart ticker armed: ${AUTO_RESTART_TICK_COUNT} ticks × 1 min = ${intervalLabel}`);

    autoRestartTickerRef.current = setInterval(async () => {
      autoRestartTicksLeftRef.current -= 1;
      const left = autoRestartTicksLeftRef.current;
      console.log(`⏱ Auto-restart ticker: ${left} ticks left`);

      if (left > 0) return;

      if (!isRunningRef.current) {
        console.log('⏱ Auto-restart ticker fired but process is stopped — clearing');
        _clearAutoRestartTicker();
        return;
      }
      if (autoRestartActiveRef.current) {
        console.log('⏱ Auto-restart ticker fired but restart already in progress — clearing');
        _clearAutoRestartTicker();
        return;
      }

      console.log('⏱ Auto-restart ticker reached 0 — triggering scheduled restart');
      _clearAutoRestartTicker();
      try { await _autoRestart(`Scheduled ${intervalLabel} auto-restart`); }
      catch (e) { console.log('Scheduled auto-restart failed:', e); }
    }, AUTO_RESTART_TICK_MS);

    // ── Run the loop (blocks until stopRequested) ──────────────────────────
    await runLoopRef.current();

    // Loop exited — if NOT inside an auto-restart, clean up fully
    if (!autoRestartActiveRef.current) {
      setIsRunning(false);
      isRunningRef.current = false;
      _stopWatchdog();
      _clearAutoRestartTicker();
      setStatusMessage('Process stopped.');
    }
  };
  doStartRef.current = doStart;

  // ══════════════════════════════════════════════════════════════════════════
  // _autoRestart — exactly mimics pressing Stop then Start, with admin notice
  // ══════════════════════════════════════════════════════════════════════════
  const _autoRestart = async (reason) => {
    if (autoRestartActiveRef.current) {
      console.log('_autoRestart: already in progress, skip');
      return;
    }
    autoRestartActiveRef.current = true;

    console.log(`🔄 Auto-restart: ${reason}`);
    setStatusMessage(`🔄 Auto-restarting (${reason})...`);

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

    doStopRef.current(true /* silent */);
    await sleep(6000);

    console.log('🔄 Auto-restart: calling doStart');
    try {
      await doStartRef.current();
    } catch (e) {
      console.error('Auto-restart doStart failed:', e);
      autoRestartActiveRef.current = false;
      setIsRunning(false);
      isRunningRef.current = false;
      _stopWatchdog();
      _clearAutoRestartTicker();
      setStatusMessage('Process stopped after restart error.');
    }
  };

  // ── handleStart (manual button) ────────────────────────────────────────────
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

  // ── handleStop (manual button) ─────────────────────────────────────────────
  const handleStop = () => {
    doStopRef.current(false);
  };

  const handleSettingsPress = () => { Keyboard.dismiss(); navigation?.navigate('Settings'); };

  // ── Render ─────────────────────────────────────────────────────────────────
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
                  🔄 Auto-restart every {AUTO_RESTART_INTERVAL_MS / 60000} min · 🐕 Watchdog active
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
  settingsContainer: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', marginTop: height * 0.010, marginBottom: height * 0.015 },
  settingsText:     { fontSize: width * 0.04, color: '#0d1e30', borderBottomWidth: 1, borderBottomColor: '#0d1e30', paddingBottom: 1 },
});