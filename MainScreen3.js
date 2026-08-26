import React, { useState, useRef, useEffect } from 'react';
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
  Linking
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

const SmsModule = NativeModules.SmsModule;
const BatteryModule = NativeModules.BatteryModule;
const { width, height } = Dimensions.get('window');

const WEB_CLIENT_ID = '651284152046-22s1bs6beejjmd6jkop35rdi6hsaapqt.apps.googleusercontent.com';

// ─────────────────────────────────────────────────────────────────────────────
// HOW THE OVERNIGHT FIX WORKS
// ─────────────────────────────────────────────────────────────────────────────
// Problem: Android/SQL Server silently drops idle TCP connections after a few
// hours. The old code called MSSQL.connect() once before the while-loop and
// only reconnected on explicit caught errors. A silent drop means every query
// just hangs or returns nothing, so no SMS is sent the next morning.
//
// Fix: Before every single cycle we call ensureConnected(), which:
//   1. Runs a cheap "SELECT 1" probe query.
//   2. If it throws (silent drop, timeout, network blip) → safeClose() then
//      reconnect with exponential back-off (max 3 retries).
//   3. Only after a confirmed live connection do we run the real queries.
//
// Additional fixes:
//   • sendingSeedsRef is cleared at the start of each cycle so a crash in the
//     previous cycle never permanently blocks a seed.
//   • The try/catch brace nesting was realigned so the reconnect catch truly
//     wraps the whole cycle body.
//   • Date-boundary: startTime / endTime values are re-derived inside the loop
//     so they always reflect "today", not the date when Start was pressed.
//
// STUCK DETECTION FIX:
//   • Every idle cycle, a secondary query checks if unprocessed logs exist for
//     today within the time window. If records exist but the loop claims none,
//     the loop is stuck — admin is alerted via SMS + email immediately.
//   • stuckAlertSentRef prevents repeated alerts until the app is restarted
//     or the loop successfully processes records again.
// ─────────────────────────────────────────────────────────────────────────────

export default function MainScreen() {
  const [isRunning, setIsRunning] = useState(false);

  const keepAwakeActiveRef = useRef(false);

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
      } catch (err) {
        console.error('Google Sign-In init error:', err);
      }
    })();
  }, []);

  const errorSound = new Sound('alert.mp3', Sound.MAIN_BUNDLE, (err) => {
    if (err && typeof __DEV__ !== 'undefined' && __DEV__) {
      console.error('Failed to load sound', err);
    }
  });

  // ── STATE ──────────────────────────────────────────────────────────────────
  const [numStudents, setNumStudents] = useState('10');
  const [idleSeconds, setIdleSeconds] = useState('20');
  const defaultStart = new Date(); defaultStart.setHours(4, 0, 0, 0);
  const defaultEnd   = new Date(); defaultEnd.setHours(22, 0, 0, 0);
  const [startTime, setStartTime] = useState(defaultStart);
  const [endTime, setEndTime]     = useState(defaultEnd);
  const [showStartPicker, setShowStartPicker] = useState(false);
  const [showEndPicker, setShowEndPicker]     = useState(false);

  const [deviceName, setDeviceName]           = useState('');
  const [serverName, setServerName]           = useState('');
  const [databaseName, setDatabaseName]       = useState('');
  const [username, setUsername]               = useState('');
  const [password, setPassword]               = useState('');
  const [arrivalMessage, setArrivalMessage]   = useState('');
  const [departureMessage, setDepartureMessage] = useState('');
  const [displayDashboard, setDisplayDashboard] = useState(false);
  const [batteryThreshold, setBatteryThreshold] = useState(20);
  const [adminNumbers, setAdminNumbers]         = useState('');
  const [adminEmails, setAdminEmails]           = useState('');

  const batteryAlertSentRef   = useRef(false);
  const emailQueueRef         = useRef([]);
  const stopRequestedRef      = useRef(false);
  const cycleCountRef         = useRef(0);
  const failedSendsRef        = useRef({});
  const maxErrorCycles        = 30;
  const [cycleCount, setCycleCount]       = useState(0);
  const [statusMessage, setStatusMessage] = useState('');
  const navigation = useNavigation();
  const sendingEmailRef             = useRef(false);
  const smsPermissionGrantedRef     = useRef(false);
  const SMS_MAX_PROCESSING          = 5;
  const networkErrorSentRef         = useRef(false);
  const sendingSeedsRef             = useRef(new Set());
  const mssqlConnectedRef           = useRef(false);

  // ── Failure alert refs ─────────────────────────────────────────────────────
  const overnightFailAlertDateRef   = useRef('');
  const smsFailAlertedSeedsRef      = useRef(new Set());

  // ── STUCK DETECTION ref ────────────────────────────────────────────────────
  // Set to true after the first stuck alert is sent. Cleared when:
  //   • The loop successfully processes records again (records found), OR
  //   • handleStart() is called (fresh session).
  // This prevents repeated SMS/email spam while the app remains stuck.
  const stuckAlertSentRef = useRef(false);

  // ── Load saved config ──────────────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const saved = await AsyncStorage.getItem('appConfig');
        if (saved) {
          const config = JSON.parse(saved);
          setDeviceName(config.deviceName || '');
          setServerName(config.serverName || '');
          setDatabaseName(config.databaseName || '');
          setUsername(config.username || '');
          setPassword(config.password || '');
          setArrivalMessage(config.arrivalMessage || '');
          setDepartureMessage(config.departureMessage || '');
          setDisplayDashboard(!!config.displayDashboard);
          setBatteryThreshold(config.batteryThreshold || 20);
          setAdminNumbers(config.adminNumbers || '');
          setAdminEmails(config.adminEmails || '');
        }
      } catch (err) {
        console.error('Failed to load config:', err);
      }
    })();
  }, []);

  // ── Helpers ────────────────────────────────────────────────────────────────
  const getMssqlConfig = () => ({
    server: serverName,
    username,
    password,
    database: databaseName,
    port: 1433,
    timeout: 15,
  });

  const getBatteryLevel = async () => {
    try {
      if (BatteryModule?.getLevel) return await BatteryModule.getLevel();
      return 100;
    } catch { return 100; }
  };

  const formatTime = (time) => {
    const hours = time.getHours();
    const minutes = time.getMinutes();
    const ampm = hours >= 12 ? 'PM' : 'AM';
    const formattedHours = hours % 12 || 12;
    const formattedMinutes = minutes < 10 ? `0${minutes}` : minutes;
    return `${formattedHours}:${formattedMinutes} ${ampm}`;
  };

  const formatLogDateTime = (sqlDate, sqlTime) => {
    try {
      const datePart = sqlDate.split(' ')[0];
      const dt = new Date(`${datePart}T${sqlTime}`);
      const timeStr = dt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true }).toLowerCase();
      const dateStr = dt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
      return `${timeStr} ${dateStr}`;
    } catch (e) {
      return sqlTime;
    }
  };

  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  // ── Safe close ─────────────────────────────────────────────────────────────
  const safeClose = async () => {
    try {
      if (MSSQL && MSSQL.close) await MSSQL.close();
    } catch (err) {
      console.error('Error closing MSSQL:', err);
    } finally {
      mssqlConnectedRef.current = false;
    }
  };

  // ── KEY FIX: ensureConnected ───────────────────────────────────────────────
  const ensureConnected = async () => {
    const MAX_RETRIES = 3;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        await MSSQL.executeQuery('SELECT 1 AS alive');
        mssqlConnectedRef.current = true;
        return;
      } catch (probeErr) {
        console.warn(`[ensureConnected] Probe failed (attempt ${attempt}/${MAX_RETRIES}):`, probeErr?.message || probeErr);

        await safeClose();

        try {
          setStatusMessage(`⚠️ Reconnecting to server (attempt ${attempt})…`);
          await MSSQL.connect(getMssqlConfig());
          mssqlConnectedRef.current = true;
          networkErrorSentRef.current = false;
          console.log(`[ensureConnected] Reconnected on attempt ${attempt}`);
          return;
        } catch (connErr) {
          console.error(`[ensureConnected] Reconnect attempt ${attempt} failed:`, connErr?.message || connErr);

          if (attempt === MAX_RETRIES) {
            throw connErr;
          }

          const backoff = 5000 * Math.pow(2, attempt - 1);
          console.log(`[ensureConnected] Waiting ${backoff / 1000}s before next retry…`);
          await sleep(backoff);
        }
      }
    }
  };

  // ── SMS helpers ────────────────────────────────────────────────────────────
  const ensureSmsPermission = async () => {
    if (smsPermissionGrantedRef.current) return true;
    if (Platform.OS !== 'android') return true;

    const perm = PermissionsAndroid.PERMISSIONS.SEND_SMS;
    const has = await PermissionsAndroid.check(perm);
    if (has) { smsPermissionGrantedRef.current = true; return true; }

    const granted = await PermissionsAndroid.request(perm, {
      title: 'SMS Permission',
      message: 'App needs permission to send SMS messages.',
      buttonPositive: 'OK',
    });
    if (granted === PermissionsAndroid.RESULTS.GRANTED) {
      smsPermissionGrantedRef.current = true;
      return true;
    }
    return false;
  };

  const isValidPhone = (num) => /^(?:\+63|0)9\d{9}$/.test(num);

  const getValidNumbers = (raw) => {
    if (!raw) return [];
    return raw.split(/[,;]+/).map(n => n.trim()).filter(n => n.length > 0 && isValidPhone(n));
  };

  const sendSMS = async (numbers = [], message) => {
    try {
      const ok = await ensureSmsPermission();
      if (!ok) return false;
      if (!Array.isArray(numbers) || numbers.length === 0 || !message) return true;

      const validNumbers = numbers.filter(isValidPhone);
      if (validNumbers.length === 0) return true;

      let allDelivered = true;
      for (const num of validNumbers) {
        try {
          const r = await SmsModule.sendSMS(num, message);
          if (!(r && r.success)) allDelivered = false;
          await sleep(1500);
        } catch (err) {
          console.error(`SMS error on ${num}`, err);
          allDelivered = false;
        }
      }
      return allDelivered;
    } catch (err) {
      console.error('sendSMS fatal err:', err);
      return false;
    }
  };

  const markSent = async (seed, deviceNameParam) => {
    try {
      await MSSQL.executeUpdate(`
        UPDATE logs
        SET smssent = 1, smsmac = '${deviceNameParam}', smssenttime = GETDATE()
        WHERE seed = '${seed}'
      `);
    } catch (error) {
      console.error('Failed to update log in markSent:', error);
    }
  };

  // ── Email helpers ──────────────────────────────────────────────────────────
  const queueEmail = (subject, message) => {
    if (!emailQueueRef.current) emailQueueRef.current = [];
    emailQueueRef.current.push({ subject, message });
    processEmailQueue();
  };

  const processEmailQueue = async () => {
    if (sendingEmailRef.current) return;
    sendingEmailRef.current = true;
    try {
      const recipients = (adminEmails || '').split(/[;,]+/).map(s => s.trim()).filter(Boolean);
      if (recipients.length === 0) { emailQueueRef.current = []; return; }

      let accessToken = await fetchAccessToken();
      if (!accessToken) return;

      while (emailQueueRef.current.length > 0) {
        const { subject, message } = emailQueueRef.current[0];
        const ok = await sendEmailViaGmailAPI(recipients.join(','), subject, message, accessToken);
        if (ok) emailQueueRef.current.shift();
        else break;
      }
    } finally {
      sendingEmailRef.current = false;
    }
  };

  const notifyNetworkError = async (errorMsg) => {
    try {
      const msg = `NETWORK/SERVER ERROR\n\nDevice: ${deviceName}\n\nError:\n${errorMsg}\n\nThe device cannot connect to the server or lost internet connection.`;
      const numbers = getValidNumbers(adminNumbers);
      if (numbers.length > 0) await sendSMS(numbers, msg);
      if (adminEmails && adminEmails.trim() !== '') queueEmail('Network/Server Error', msg);
    } catch (e) {
      console.log('Failed to send network alert:', e);
    }
  };

  const getLowBatteryMessage = (level) =>
    `⚠️ LOW BATTERY ALERT ⚠️\n\nDevice: ${deviceName}\nBattery Level: ${level}%\n\nPlease plug in the device immediately.`;

  const todayKey = () => new Date().toISOString().slice(0, 10);

  const notifyOvernightFailure = async (errorMsg) => {
    const key = todayKey();
    if (overnightFailAlertDateRef.current === key) return;
    overnightFailAlertDateRef.current = key;
    try {
      const msg =
        `⚠️ SMS LOOP FAILURE ⚠️\n\n` +
        `Device: ${deviceName}\n` +
        `Date: ${key}\n\n` +
        `The SMS sending loop could NOT reconnect to the server after multiple retries.\n` +
        `No SMS notifications will be sent until the connection is restored.\n\n` +
        `Error: ${errorMsg}\n\n` +
        `Please check the device network/Wi-Fi and SQL Server availability.`;

      const numbers = getValidNumbers(adminNumbers);
      if (numbers.length > 0) await sendSMS(numbers, msg);
      if (adminEmails && adminEmails.trim() !== '') {
        queueEmail('⚠️ SMS Loop Failure — Cannot Reach Server', msg);
      }
      console.warn('[notifyOvernightFailure] Alert sent to admin.');
    } catch (e) {
      console.error('notifyOvernightFailure error:', e);
    }
  };

  const notifySmsSendFailure = async (studentName, numbers, seed) => {
    if (smsFailAlertedSeedsRef.current.has(seed)) return;
    smsFailAlertedSeedsRef.current.add(seed);
    try {
      const numbersStr = numbers.join(', ') || 'N/A';
      const msg =
        `⚠️ SMS SEND FAILURE ⚠️\n\n` +
        `Device: ${deviceName}\n` +
        `Student: ${studentName}\n` +
        `Number(s): ${numbersStr}\n\n` +
        `Failed to send SMS notification.\n` +
        `Possible causes: no load/credit, SIM issue, or invalid number.\n\n` +
        `Please check the SIM card and retry manually if needed.`;

      const adminNums = getValidNumbers(adminNumbers);
      if (adminNums.length > 0) await sendSMS(adminNums, msg);
      if (adminEmails && adminEmails.trim() !== '') {
        queueEmail(`SMS Send Failure — ${studentName}`, msg);
      }
      console.warn(`[notifySmsSendFailure] Alert sent for seed ${seed} (${studentName}).`);
    } catch (e) {
      console.error('notifySmsSendFailure error:', e);
    }
  };

  // ── STUCK DETECTION: notifyLoopStuck ──────────────────────────────────────
  // Called when the loop says "no records" but the DB has unprocessed logs.
  // Sends one SMS + one email to admin. stuckAlertSentRef prevents re-spam.
  const notifyLoopStuck = async (pendingCount, startHHMMSS, endHHMMSS) => {
    if (stuckAlertSentRef.current) return; // already alerted, don't spam
    stuckAlertSentRef.current = true;

    try {
      const now = new Date().toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
      });
      const msg =
        `⚠️ SMS LOOP STUCK ⚠️\n\n` +
        `Device: ${deviceName}\n` +
        `Time Detected: ${now}\n` +
        `Date: ${todayKey()}\n\n` +
        `The SMS loop is running but NOT processing ${pendingCount} pending attendance log(s) for today.\n\n` +
        `Time window: ${startHHMMSS} - ${endHHMMSS}\n\n` +
        `Parents will NOT receive SMS notifications until the app is restarted.\n\n` +
        `Please restart the app immediately.`;

      const numbers = getValidNumbers(adminNumbers);
      if (numbers.length > 0) await sendSMS(numbers, msg);
      if (adminEmails && adminEmails.trim() !== '') {
        queueEmail('⚠️ SMS Loop Stuck — Restart Required', msg);
      }
      console.warn(`[notifyLoopStuck] Alert sent — ${pendingCount} pending log(s) not being processed.`);
    } catch (e) {
      console.error('notifyLoopStuck error:', e);
    }
  };

  // ── Stop ───────────────────────────────────────────────────────────────────
  const handleStop = () => {
    stopRequestedRef.current = true;
    setIsRunning(false);
    Alert.alert('Process Stopped', 'SMS process stopping...');
  };

  // ── MAIN LOOP ──────────────────────────────────────────────────────────────
  const handleStart = async () => {
    Keyboard.dismiss();
    stopRequestedRef.current = false;

    if (!numStudents || !idleSeconds || !deviceName) {
      Alert.alert('Missing Information', 'Please fill out all fields before starting.');
      return;
    }

    setIsRunning(true);
    const okPerm = await ensureSmsPermission();
    if (!okPerm) {
      Alert.alert('SMS Permission Required', 'Please allow SMS permission to continue.');
      setIsRunning(false);
      return;
    }

    cycleCountRef.current = 0;
    setCycleCount(0);
    setStatusMessage('Starting SMS process...');
    Alert.alert('Process Started', 'Fetching and sending SMS notifications...');

    // Reset all per-session failure tracking on fresh start
    smsFailAlertedSeedsRef.current.clear();
    stuckAlertSentRef.current = false; // ← reset stuck alert on every fresh start

    // Initial connection
    try {
      await MSSQL.connect(getMssqlConfig());
      mssqlConnectedRef.current = true;
      networkErrorSentRef.current = false;
    } catch (initErr) {
      console.error('Initial connect failed:', initErr);
      Alert.alert('Connection Error', 'Could not connect to the database. Check your settings.');
      setIsRunning(false);
      return;
    }

    const limit  = parseInt(numStudents, 10) || 5;
    const idleMs = (parseInt(idleSeconds, 10) || 5) * 1000;

    // ── while loop ────────────────────────────────────────────────────────────
    try {
      while (!stopRequestedRef.current) {

        // ── STEP 1: Ensure DB connection is alive ─────────────────────────────
        try {
          await ensureConnected();
        } catch (connErr) {
          const errMsg = String(connErr?.message || connErr);
          await notifyOvernightFailure(errMsg);
          if (!networkErrorSentRef.current) {
            await notifyNetworkError(errMsg);
            networkErrorSentRef.current = true;
          }
          setStatusMessage('⚠️ Cannot reach server. Will retry next cycle...');
          await sleep(idleMs);
          continue;
        }

        // ── STEP 2: Clear stuck seeds from any previous crashed cycle ─────────
        sendingSeedsRef.current.clear();

        // ── STEP 3: Re-derive time window using TODAY's date ──────────────────
        const startHHMMSS = `${startTime.getHours().toString().padStart(2,'0')}:${startTime.getMinutes().toString().padStart(2,'0')}:00`;
        const endHHMMSS   = `${endTime.getHours().toString().padStart(2,'0')}:${endTime.getMinutes().toString().padStart(2,'0')}:59`;

        // ── STEP 4: Main query cycle ──────────────────────────────────────────
        try {
          // Claim unsent logs for this device
          await MSSQL.executeUpdate(`
            UPDATE logs
            SET smsmac = '${deviceName}'
            WHERE seed IN (
              SELECT TOP (${limit}) seed
              FROM logs
              WHERE smssent = 0
                AND (smsmac IS NULL OR smsmac = '')
                AND CONVERT(VARCHAR(10), date, 120) = CONVERT(VARCHAR(10), GETDATE(), 120)
                AND time BETWEEN '${startHHMMSS}' AND '${endHHMMSS}'
              ORDER BY smsprocessing ASC, date ASC, time ASC
            )
          `);

          // Select the claimed logs
          const claimed = await MSSQL.executeQuery(`
            SELECT TOP (${limit})
              l.seed, l.studentid, l.date, l.time, l.trans, l.fetcher,
              l.smssent, l.smsmac, ISNULL(l.smsprocessing,0) AS smsprocessing,
              s.studentname, s.smsnotify, s.parentguardian, s.yearlevel, s.section
            FROM logs l
            INNER JOIN student s ON l.studentid = s.studentid
            WHERE l.smssent = 0
              AND l.smsmac = '${deviceName}'
              AND CONVERT(VARCHAR(10), l.date, 120) = CONVERT(VARCHAR(10), GETDATE(), 120)
              AND l.time BETWEEN '${startHHMMSS}' AND '${endHHMMSS}'
            ORDER BY l.smsprocessing ASC, l.date ASC, l.time ASC;
          `);

          if (!claimed || claimed.length === 0) {
            cycleCountRef.current += 1;
            setCycleCount(cycleCountRef.current);
            setStatusMessage(`No new records. Idle cycle ${cycleCountRef.current} — waiting ${idleSeconds}s...`);

            // ── STUCK DETECTION ──────────────────────────────────────────────
            // The loop says no records — but check the DB directly.
            // If unprocessed logs exist for today within the time window,
            // the loop is stuck and we must alert admin to restart the app.
            try {
              const pendingCheck = await MSSQL.executeQuery(`
                SELECT COUNT(*) AS pendingCount
                FROM logs
                WHERE smssent = 0
                  AND CONVERT(VARCHAR(10), date, 120) = CONVERT(VARCHAR(10), GETDATE(), 120)
                  AND time BETWEEN '${startHHMMSS}' AND '${endHHMMSS}'
              `);

              const pendingCount = pendingCheck?.[0]?.pendingCount ?? 0;

              if (pendingCount > 0) {
                console.warn(`[stuckDetection] Loop idle but ${pendingCount} unprocessed log(s) exist. Loop is STUCK.`);
                await notifyLoopStuck(pendingCount, startHHMMSS, endHHMMSS);
              }
            } catch (stuckCheckErr) {
              // Non-fatal — don't crash the loop if stuck detection query fails
              console.error('[stuckDetection] Query failed:', stuckCheckErr);
            }
            // ── END STUCK DETECTION ──────────────────────────────────────────

          } else {
            cycleCountRef.current = 0;
            setCycleCount(0);
            // Reset stuck alert so it can fire again if the loop gets stuck later
            stuckAlertSentRef.current = false;

            const failedThisCycle = [];

            for (const log of claimed) {
              if (stopRequestedRef.current) break;
              if (sendingSeedsRef.current.has(log.seed)) continue;
              sendingSeedsRef.current.add(log.seed);

              const studentName    = log.studentname || 'Student';
              const trans          = log.trans || '';
              const formattedTimeDate = formatLogDateTime(log.date, log.time);
              const yearLevel      = log.yearlevel || '';
              const section        = log.section || '';

              const message =
                trans === 'TI'
                  ? arrivalMessage
                      .replace('{student}', studentName)
                      .replace('{time}', formattedTimeDate)
                      .replace('{year}', yearLevel)
                      .replace('{section}', section)
                  : trans === 'TO'
                  ? departureMessage
                      .replace('{student}', studentName)
                      .replace('{time}', formattedTimeDate)
                      .replace('{year}', yearLevel)
                      .replace('{section}', section)
                  : `${studentName} ${trans} at ${formattedTimeDate}.`;

              const rawNumbers  = log.smsnotify ? log.smsnotify.split(/[,;]+/).map(n => n.trim()) : [];
              const validNumbers = rawNumbers.filter(isValidPhone);

              if (validNumbers.length === 0) {
                console.log(`Skipping ${studentName} — no valid SMS number.`);
                await markSent(log.seed, deviceName);
                failedSendsRef.current[log.seed] = (failedSendsRef.current[log.seed] || 0) + 1;
                if (failedSendsRef.current[log.seed] >= maxErrorCycles) {
                  failedThisCycle.push({ studentName, seed: log.seed });
                  delete failedSendsRef.current[log.seed];
                }
                sendingSeedsRef.current.delete(log.seed);
                continue;
              }

              if (log.smsprocessing < SMS_MAX_PROCESSING) {
                const ok = await sendSMS(validNumbers, message);
                await MSSQL.executeUpdate(`
                  UPDATE logs
                  SET smsprocessing = ISNULL(smsprocessing,0) + 1
                    ${ok ? `, smssent = 1, smssenttime = GETDATE()` : ''}
                  WHERE seed = '${log.seed}' AND smsmac = '${deviceName}'
                `);
                if (ok) {
                  await markSent(log.seed, deviceName);
                  delete failedSendsRef.current[log.seed];
                } else {
                  await notifySmsSendFailure(studentName, validNumbers, log.seed);
                }
              } else {
                failedSendsRef.current[log.seed] = (failedSendsRef.current[log.seed] || 0) + 1;
                if (failedSendsRef.current[log.seed] >= maxErrorCycles) {
                  failedThisCycle.push({ studentName, seed: log.seed });
                  delete failedSendsRef.current[log.seed];
                }
              }

              sendingSeedsRef.current.delete(log.seed);
            } // end for-each log

            if (failedThisCycle.length > 0) {
              const failedNames = failedThisCycle.map(f => f.studentName).join(', ');
              console.warn(`⚠️ SMS failed after ${maxErrorCycles} cycles: ${failedNames}`);
              Alert.alert('SMS Sending Error', `Failed to send SMS after ${maxErrorCycles} cycles. Check load credit or SIM.`);

              const criticalMsg =
                `⚠️ CRITICAL SMS ERROR ⚠️\n\n` +
                `Device: ${deviceName}\n\n` +
                `The following students failed to receive SMS after ${maxErrorCycles} attempts:\n` +
                `${failedNames}\n\n` +
                `Please check SIM card load/credit immediately.`;

              const adminNums = getValidNumbers(adminNumbers);
              if (adminNums.length > 0) {
                await sendSMS(adminNums, criticalMsg);
              }
              if (adminEmails && adminEmails.trim() !== '') {
                queueEmail('Critical SMS Error', criticalMsg);
              }
              try {
                if (errorSound) { errorSound.setVolume(1.0); errorSound.play(); }
                Vibration.vibrate([0, 1000, 500, 1000, 500, 1000], false);
              } catch (e) { console.log('Sound/vibration error:', e); }
            }

            setStatusMessage('Processed new records. Cycle counter reset.');
          }

          // Battery check
          try {
            const level = await getBatteryLevel();
            if (level <= batteryThreshold && !batteryAlertSentRef.current) {
              const msg = getLowBatteryMessage(level);
              if (adminNumbers && adminNumbers.trim() !== '') await sendSMS(getValidNumbers(adminNumbers), msg);
              queueEmail('Low Battery Alert', msg);
              batteryAlertSentRef.current = true;
            } else if (level > batteryThreshold) {
              batteryAlertSentRef.current = false;
            }
          } catch { /* battery errors are non-fatal */ }

          await sleep(idleMs);

        } catch (cycleErr) {
          console.error('Cycle error:', cycleErr);
          const errMsg = String(cycleErr?.message || cycleErr).toLowerCase();

          if (
            errMsg.includes('network') ||
            errMsg.includes('timeout') ||
            errMsg.includes('connection') ||
            errMsg.includes('connect')
          ) {
            if (!networkErrorSentRef.current) {
              await notifyNetworkError(errMsg);
              networkErrorSentRef.current = true;
            }
            mssqlConnectedRef.current = false;
          }

          setStatusMessage('⚠️ Cycle error — retrying next cycle...');
          await safeClose();
          await sleep(5000);
        }
      } // end while

    } catch (fatalErr) {
      console.error('Fatal loop error:', fatalErr);
      const fatalMsg = String(fatalErr);
      await notifyNetworkError(fatalMsg);
      try {
        const adminNums = getValidNumbers(adminNumbers);
        if (adminNums.length > 0) {
          await sendSMS(
            adminNums,
            `⚠️ FATAL SMS LOOP ERROR\n\nDevice: ${deviceName}\n\nThe SMS loop has crashed and stopped.\n\nError: ${fatalMsg}\n\nPlease restart the app immediately.`
          );
        }
      } catch (e) { console.error('Fatal SMS notify error:', e); }
      Alert.alert('Error', 'Something went wrong with the SMS process.');
    } finally {
      await safeClose();
      setIsRunning(false);
      setStatusMessage('Process stopped.');
    }
  };

  // ── UI handlers ────────────────────────────────────────────────────────────
  const handleSettingsPress = () => {
    Keyboard.dismiss();
    navigation?.navigate('Settings');
  };

  // ── RENDER ─────────────────────────────────────────────────────────────────
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
                  style={[styles.input, displayDashboard && { backgroundColor: '#ecf0f1', color: '#7f8c8d' }]}
                  keyboardType="numeric"
                  value={numStudents}
                  onChangeText={setNumStudents}
                  editable={!displayDashboard}
                />
              </View>

              <View style={styles.inputGroup}>
                <Text style={styles.label}>Idle Seconds to Wait</Text>
                <TextInput
                  style={[styles.input, displayDashboard && { backgroundColor: '#ecf0f1', color: '#7f8c8d' }]}
                  keyboardType="numeric"
                  value={idleSeconds}
                  onChangeText={setIdleSeconds}
                  editable={!displayDashboard}
                />
              </View>

              <View style={styles.inputGroup}>
                <Text style={styles.label}>Sending SMS Start Time</Text>
                <TouchableOpacity
                  style={[styles.input, displayDashboard && { backgroundColor: '#ecf0f1' }]}
                  onPress={() => setShowStartPicker(true)}
                  disabled={displayDashboard}
                >
                  <Text style={displayDashboard ? { color: '#7f8c8d' } : { color: '#000' }}>{formatTime(startTime)}</Text>
                </TouchableOpacity>
                {showStartPicker && (
                  <DateTimePicker
                    value={startTime}
                    mode="time"
                    is24Hour={false}
                    display={Platform.OS === 'ios' ? 'spinner' : 'default'}
                    onChange={(event, selectedDate) => {
                      if (Platform.OS === 'android') {
                        if (event.type === 'set' && selectedDate) setStartTime(selectedDate);
                        setShowStartPicker(false);
                      } else {
                        setStartTime(selectedDate || startTime);
                      }
                    }}
                  />
                )}
              </View>

              <View style={styles.inputGroup}>
                <Text style={styles.label}>Sending SMS End Time</Text>
                <TouchableOpacity
                  style={[styles.input, displayDashboard && { backgroundColor: '#ecf0f1' }]}
                  onPress={() => setShowEndPicker(true)}
                  disabled={displayDashboard}
                >
                  <Text style={displayDashboard ? { color: '#7f8c8d' } : { color: '#000' }}>{formatTime(endTime)}</Text>
                </TouchableOpacity>
                {showEndPicker && (
                  <DateTimePicker
                    value={endTime}
                    mode="time"
                    is24Hour={false}
                    display={Platform.OS === 'ios' ? 'spinner' : 'default'}
                    onChange={(event, selectedDate) => {
                      if (Platform.OS === 'android') {
                        if (event.type === 'set' && selectedDate) setEndTime(selectedDate);
                        setShowEndPicker(false);
                      } else {
                        setEndTime(selectedDate || endTime);
                      }
                    }}
                  />
                )}
              </View>
            </View>

            <View style={styles.buttonContainer}>
              <TouchableOpacity
                style={[styles.button, { backgroundColor: isRunning ? '#95a5a6' : '#3A6F43' }]}
                onPress={handleStart}
                disabled={isRunning}
              >
                <Text style={styles.buttonText}>Start</Text>
              </TouchableOpacity>

              <TouchableOpacity style={[styles.button, { backgroundColor: '#c74d3aff' }]} onPress={handleStop}>
                <Text style={styles.buttonText}>Stop</Text>
              </TouchableOpacity>
            </View>

            <View style={styles.statusBox}>
              <Text style={styles.statusText}>Status: {isRunning ? '🟢 Running (sending SMS...)' : '🔴 Stopped'}</Text>
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
  container: {
    flex: 1,
    backgroundColor: '#f8f9fa',
    justifyContent: 'center',
  },
  innerContainer: {
    flex: 1,
    justifyContent: 'space-around',
    alignItems: 'center',
    paddingHorizontal: width * 0.05,
  },
  title: {
    fontSize: width * 0.055,
    fontWeight: '700',
    color: '#11224E',
    textAlign: 'center',
    marginTop: height * 0.03,
    marginBottom: -17,
  },
  logo: {
    width: width * 0.3,
    height: width * 0.3,
    resizeMode: 'contain',
    marginVertical: height * 0.03,
  },
  inputsContainer: { width: '100%' },
  inputGroup:      { marginBottom: height * 0.015 },
  label: {
    fontSize: width * 0.035,
    fontWeight: '500',
    color: '#040536ff',
    marginBottom: 5,
  },
  input: {
    borderWidth: 1,
    borderColor: '#bdc3c7',
    borderRadius: 8,
    paddingHorizontal: width * 0.03,
    paddingVertical: height * 0.012,
    backgroundColor: '#fff',
    fontSize: width * 0.035,
  },
  buttonContainer: {
    flexDirection: 'row',
    justifyContent: 'space-evenly',
    width: '100%',
    marginVertical: height * 0.001,
  },
  button: {
    flex: 1,
    marginHorizontal: 5,
    borderRadius: 10,
    paddingVertical: height * 0.015,
    alignItems: 'center',
  },
  buttonText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: width * 0.04,
  },
  statusBox: {
    backgroundColor: '#ecf0f1',
    padding: height * 0.015,
    borderRadius: 8,
    alignItems: 'center',
    width: '100%',
  },
  statusText: {
    fontSize: width * 0.035,
    fontWeight: '600',
    color: '#2c3e50',
  },
  settingsContainer: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: height * 0.010,
    marginBottom: height * 0.015,
  },
  settingsText: {
    fontSize: width * 0.04,
    color: '#0d1e30ff',
    borderBottomWidth: 1,
    borderBottomColor: '#0d1e30ff',
    paddingBottom: 1,
  },
});