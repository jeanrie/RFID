// MainScreen.js — Native-Watchdog Edition + Editable SMS Time Window
//                + Auto-Resume on Launch + JS Fallback Restart Timers
//                + TRUE Scheduled Stop/Start
//                + DB/SMS/Email TIMEOUTS + NATIVE HARD-RESTART BACKSTOP
//                + SINGLE NOTIFICATION PER RESTART EVENT
//                + RECONNECT-STUCK ESCALATION + GLOBAL CRASH NOTICE
//
//  🔧 FIXED (this revision — "stuck reconnecting forever, no notice" +
//            "app just closed this morning, no SMS/email"):
//
//     BUG #1 — Stuck reconnecting with zero further notices:
//       In runLoop's catch block, `networkErrorSentRef.current` was set
//       to true on the FIRST network-ish error, but only ever reset back
//       to false inside the `try { await reconnect(); ... }` SUCCESS path.
//       If reconnect() kept failing (dead server, bad wifi, etc.), that
//       flag stayed true forever, so notifyNetworkError() never fired
//       again — the loop just quietly retried every 5s, potentially
//       forever, with the UI stuck on "⚠️ Reconnecting..." and admins
//       totally in the dark after the first message.
//
//       Fix:
//         • reconnectFailStreakRef tracks consecutive reconnect failures.
//         • reconnectStuckSinceRef timestamps when the CURRENT failure
//           streak started.
//         • Exponential backoff between retries (5s → capped at 60s)
//           instead of hammering the server every 5s forever.
//         • A periodic re-notification every RECONNECT_RENOTIFY_INTERVAL_MS
//           (5 min) fires WHILE still stuck, so admins get "still down,
//           Nx min now" updates instead of just one message and silence.
//         • If stuck reconnecting for RECONNECT_STUCK_RESTART_MS (5 min)
//           straight, the loop gives up trying in-place and requests a
//           full lifecycleCoordinator restart (which itself re-notifies
//           via the existing AUTO-RESTART STARTING/COMPLETE messages).
//           This also fully tears down and re-creates the MSSQL
//           connection state instead of retrying the same possibly-wedged
//           connection object forever.
//
//     BUG #2 — App closes with zero notice/SMS/email:
//       There was no global JS error handler. An uncaught fatal JS
//       exception ANYWHERE (not just inside runLoop's own try/catch —
//       e.g. during Google Sign-In, an effect, a native event callback)
//       crashes the whole app silently. Nothing attempted to warn anyone
//       before the process died.
//
//       Fix: a global.ErrorUtils handler is installed on mount. On a
//       FATAL error it fires off best-effort emergency SMS(es) directly
//       via SmsModule (not the queued/awaited helper — the app may be
//       moments from dying, so this is fire-and-forget, no awaiting) to
//       all valid admin numbers, then defers to whatever the previous
//       global handler was (so RN's own crash/red-box behavior still
//       runs normally afterwards).
//
//       NOTE: this can only catch JS-level crashes. It CANNOT catch a
//       native-level crash or an Android OOM kill of the whole process —
//       those happen below the JS layer entirely. If the app keeps
//       disappearing with no console trace at all (not even a "GLOBAL JS
//       ERROR" log line), that's a signal to check native Android logs
//       (logcat) around the time it happened, and to double check that
//       WatchdogModule.kt's own hard-restart SMS path isn't itself gated
//       on some condition (like the SMS window) that was closed at the
//       time. The existing BootReceiver + MacroDroid daily relaunch is
//       what recovers the device either way, but that alone doesn't
//       explain the crash without a trace.
//
//  ✅ All timing-critical work (watchdog, auto-restart, daily restart)
//     runs in WatchdogModule (Kotlin HandlerThread) — immune to JS suspension
//  ✅ JS-side fallback restart timers — if the native 3hr/7AM timers
//     ever fail to fire, the JS loop independently tracks elapsed
//     wall-clock time and forces the same restart sequence.
//  ✅ Auto-resume on launch — persists an "appShouldRun" flag in
//     AsyncStorage. If the app process is restarted for any reason (crash,
//     device reboot via BootReceiver, hard-restart kill, manually reopening
//     the app) while that flag is true, the app re-arms the scheduler
//     automatically.
//  ✅ SMS sending window is USER-EDITABLE via time pickers
//  ✅ Pending SMS messages are released back to the queue if the window
//     closes mid-cycle and are automatically retried once it reopens
//  ✅ Email notifications for window open/close are always allowed 24/7
//  ✅ Flat coordinator loop — zero recursion, clean state reset every restart
//  ✅ pingHeartbeat() called every loop iteration so the native watchdog
//     knows the JS thread is alive
//  ✅ WatchdogModule.resetAutoRestartTimer() called after every restart so
//     the 3-hour clock starts fresh
//  ✅ Exactly ONE "restarting" notice + ONE "restart complete" notice per
//     restart event — no more duplicate SMS/email spam
//  ✅ NEW: reconnect failures escalate (backoff + periodic re-notify +
//     forced restart after 5 min stuck) instead of retrying silently forever
//  ✅ NEW: global JS error handler attempts an emergency SMS before a
//     fatal crash takes the app down

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

// ─── Timing constants (passed to native WatchdogModule, also used by the ──────
//     JS-side fallback timers below)
const AUTO_RESTART_INTERVAL_MS    = 3 * 60 * 60 * 1000;  // 3 hours
const WATCHDOG_STUCK_THRESHOLD_MS = 10 * 60 * 1000;       // 10 minutes
const DAILY_RESTART_HOUR          = 8;                     // 6 AM

// 🔧 how much EXTRA silence beyond WATCHDOG_STUCK_THRESHOLD_MS the
// native watchdog tolerates before concluding JS is truly wedged and
// force-killing/relaunching the whole app. Total silence before nuking:
// WATCHDOG_STUCK_THRESHOLD_MS + HARD_RESTART_GRACE_MS = 10min + 15min = 25min.
// That's comfortably longer than DB_OP_TIMEOUT_MS below, so a normal
// timeout-triggered reconnect always has time to resolve itself first.
const HARD_RESTART_GRACE_MS = 15 * 60 * 1000;

// 🔧 hard ceiling for any single DB call (connect/executeUpdate/
// executeQuery). A stalled/dead connection now fails fast instead of
// hanging forever, so the existing catch-block reconnect logic can do its
// job instead of the whole loop freezing silently.
const DB_OP_TIMEOUT_MS = 45 * 1000;

// 🔧 hard ceiling for a single native SMS send and for email network
// calls, for the same reason.
const SMS_OP_TIMEOUT_MS   = 20 * 1000;
const EMAIL_OP_TIMEOUT_MS = 20 * 1000;

// Window (in minutes) after DAILY_RESTART_HOUR:00 during which the JS
// fallback is allowed to fire the daily restart, to avoid re-firing it
// repeatedly throughout the 7:00–7:05 minute span.
const DAILY_RESTART_FIRE_WINDOW_MIN = 5;

// 🔧 Scheduler tuning: precise setTimeout handles the exact boundary; this
// fallback interval is just a catch-up net in case the precise timer gets
// suspended by Android (mirrors the existing 60s catch-up pattern already
// used for the daily restart check).
const WINDOW_SCHEDULE_FALLBACK_MS = 60 * 1000; // 1 minute

const APP_SHOULD_RUN_KEY = 'appShouldRun';

const SMS_MAX_PROCESSING = 5;
const MAX_ERROR_CYCLES   = 30;

const SIGNAL_NONE    = null;
const SIGNAL_RESTART = 'restart';
const SIGNAL_STOP    = 'stop';

// 🔧 hard cooldown between any two "restart" notifications (STARTING
// or COMPLETE). No matter what causes a duplicate — a repeated native
// event, a duplicated listener, or anything else — this is a last-line
// guarantee that the exact same kind of restart notice can never go out
// twice within this window. Real scheduled restarts are hours apart, so
// this never blocks a legitimate notification.
const RESTART_NOTIF_COOLDOWN_MS = 30 * 1000;

// 🔧 NEW — reconnect-stuck escalation tuning.
// Base backoff and cap for repeated reconnect attempts: 5s, 10s, 15s...
// up to 60s, instead of a flat 5s forever (which just hammers a server
// that's already down/unreachable).
const RECONNECT_BACKOFF_BASE_MS = 5 * 1000;
const RECONNECT_BACKOFF_MAX_MS  = 60 * 1000;
// While stuck reconnecting, remind admins every 5 minutes instead of
// sending exactly one message and then going silent for however long
// the outage lasts.
const RECONNECT_RENOTIFY_INTERVAL_MS = 5 * 60 * 1000;
// If reconnect() has failed continuously for this long, stop retrying
// in-place and force a full coordinator restart instead (tears down and
// rebuilds all loop state, including a fresh MSSQL connection object,
// instead of possibly retrying against the same wedged native connection
// forever).
const RECONNECT_STUCK_RESTART_MS = 5 * 60 * 1000;

export default function MainScreen() {

  // ── UI state ────────────────────────────────────────────────────────────────
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

  // 🔧 NEW — reconnect-stuck escalation refs.
  const reconnectFailStreakRef   = useRef(0);
  const reconnectStuckSinceRef   = useRef(0);
  const lastNetworkErrorNotifRef = useRef(0);

  // ── Coordinator lifecycle refs ───────────────────────────────────────────────
  const restartSignalRef         = useRef(SIGNAL_NONE);
  const restartReasonRef         = useRef('');
  const coordinatorRunningRef    = useRef(false);
  const coordinatorRestartingRef = useRef(false);
  // set to true by anything (e.g. the watchdog-stuck alert) that
  // already told admins "the loop is restarting" for the CURRENT restart
  // cycle. lifecycleCoordinator checks this before sending its own generic
  // "AUTO-RESTART STARTING" notice, so only ONE "starting" message ever
  // goes out per restart — never two or three for the same event.
  const restartStartNotifiedRef  = useRef(false);
  // timestamp (ms) of the last STARTING/COMPLETE restart notice
  // actually sent. Used as a hard cooldown so the same kind of message can
  // never fire twice back-to-back, regardless of what triggered it.
  const lastRestartNotifSentAtRef = useRef(0);

  // ── JS-side fallback restart timers ──────────────────────────────────────────
  const loopStartTimestampRef    = useRef(0);
  const dailyRestartFiredDateRef = useRef(null);

  // ── Auto-resume-on-launch guard ──────────────────────────────────────────────
  const autoStartAttemptedRef    = useRef(false);

  // ── SMS-window scheduler refs ─────────────────────────────────────────────────
  const windowSchedulerActiveRef = useRef(false);
  const windowScheduleTimeoutRef = useRef(null);
  const applyWindowScheduleRef   = useRef(() => {});
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

  // keep the native watchdog's emergency contact info fresh even if
  // the loop isn't restarting right now — it's what the hard-restart
  // backstop uses to send an SMS directly, bypassing JS entirely.
  useEffect(() => {
    try { WatchdogModule?.updateEmergencyContacts?.(adminNumbers || '', deviceName || ''); }
    catch {}
  }, [adminNumbers, deviceName]);

  useEffect(() => {
    if (windowSchedulerActiveRef.current) {
      applyWindowScheduleRef.current?.();
    }
  }, [startTime, endTime]);

  // ── KeepAwake (JS layer — belt-and-suspenders with native WakeLock) ──────────
  useEffect(() => {
    KeepAwake.activate();
    return () => { KeepAwake.deactivate(); };
  }, []);

  // ── AppState listener — re-arm foreground service + re-check schedule ────────
  useEffect(() => {
    const sub = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') {
        if (isRunningRef.current) startForegroundService();
        applyWindowScheduleRef.current?.();
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

  // ── NEW: Global JS error handler — best-effort emergency SMS before a ───────
  //         fatal crash takes the whole app down silently.
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

          // Fire-and-forget: the app may be moments from dying, so we
          // deliberately do NOT await these. Best-effort only.
          if (nums.length > 0 && SmsModule?.sendSMS) {
            nums.forEach((num) => {
              try { SmsModule.sendSMS(num, msg).catch(() => {}); } catch {}
            });
          }
        } catch (notifyErr) {
          console.error('Emergency crash SMS attempt failed:', notifyErr);
        }
      }

      // Always defer to whatever RN's own handler normally does
      // (red box in dev, crash reporting / process termination in prod)
      // so behavior outside of this emergency notice is unchanged.
      if (previousHandler) previousHandler(error, isFatal);
    };

    GlobalErrorUtils.setGlobalHandler(emergencyCrashHandler);

    return () => {
      if (previousHandler) GlobalErrorUtils.setGlobalHandler(previousHandler);
    };
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

  // ── Fallback catch-up interval for the window scheduler ──────────────────────
  useEffect(() => {
    const id = setInterval(() => {
      applyWindowScheduleRef.current?.();
    }, WINDOW_SCHEDULE_FALLBACK_MS);
    return () => clearInterval(id);
  }, []);

  // ── Cleanup on unmount ───────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      _unsubscribeWatchdog();
      WatchdogModule?.stop?.();
      restartSignalRef.current = SIGNAL_STOP;
      if (windowScheduleTimeoutRef.current) clearTimeout(windowScheduleTimeoutRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── AUTO-RESUME ON LAUNCH ─────────────────────────────────────────────────────
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doStart]);

  const navigation = useNavigation();

  const errorSound = new Sound('alert.mp3', Sound.MAIN_BUNDLE, (err) => {
    if (err && __DEV__) console.error('Failed to load sound', err);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Pure helpers
  // ─────────────────────────────────────────────────────────────────────────────
  const sleep        = (ms) => new Promise(r => setTimeout(r, ms));
  const isValidPhone = (num) => /^(?:\+63|0)9\d{9}$/.test(num);
  // de-duplicated — if the Admin Numbers field ever ends up with
  // the same number listed twice (extra comma, copy-paste mistake, etc.),
  // sendSMSStable used to loop over it and text that number twice for
  // every single alert. A Set removes exact duplicates before sending.
  const getValidNumbers = (raw) =>
    raw
      ? [...new Set(
          raw.split(/[,;]+/).map(n => n.trim()).filter(n => n.length > 0 && isValidPhone(n))
        )]
      : [];

  // races any promise against a timeout. A promise that never
  // settles (dead connection, dropped broadcast receiver, etc.) now
  // rejects instead of hanging the loop forever.
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

  // DB helpers — every query/update now has a hard ceiling so a
  // stalled connection fails fast and gets caught by the existing
  // reconnect-and-retry logic in runLoop's catch block, instead of the
  // whole loop silently freezing.
  const dbUpdate = useCallback((sql) =>
    withTimeout(MSSQL.executeUpdate(sql), DB_OP_TIMEOUT_MS, 'DB update'), []);
  const dbQuery = useCallback((sql) =>
    withTimeout(MSSQL.executeQuery(sql), DB_OP_TIMEOUT_MS, 'DB query'), []);

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

  // ── Exact ms until the next start/end boundary crossing ───────────────────────
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
        `This usually means a DB/SMS call stalled. A soft restart is being ` +
        `triggered now; if it doesn't recover, the app will force-restart itself.`;

      updateServiceStatus(`⚠️ Loop stuck ${mins}m — restarting`);
      const stuckNowTs = Date.now();
      // same cooldown lock applies here — if this listener is ever
      // invoked more than once for one underlying native event (e.g. a
      // stale duplicate subscription), only the first invocation actually
      // sends anything.
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
      // This alert already told admins the loop is restarting — mark the
      // restart as "already notified" so lifecycleCoordinator's generic
      // "AUTO-RESTART STARTING" message is skipped for this cycle. Without
      // this, admins would get BOTH this stuck alert AND a separate
      // "starting" message for the same event.
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
      const reason = e.reason || 'Daily 7AM restart';
      console.log(`🌅 Native daily restart event: ${reason}`);
      _requestRestart(reason);
    });

    // purely informational — by the time this fires, the native
    // side has already sent an emergency SMS and is about to kill the
    // process, entirely independent of JS. This listener may or may not
    // get a chance to run depending on how wedged JS is; that's fine,
    // it's not required for the recovery to work.
    const s4 = emitter.addListener('hardRestartTriggered', (e) => {
      console.error(`💀 Native hard-restart triggered: ${e.reason || ''}`);
    });

    watchdogSubsRef.current = [s1, s2, s3, s4];
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [_requestRestart, updateServiceStatus, isSmsWindowOpen]);

  const _unsubscribeWatchdog = useCallback(() => {
    watchdogSubsRef.current.forEach(s => { try { s.remove(); } catch {} });
    watchdogSubsRef.current = [];
  }, []);

  // subscribe to native watchdog events exactly ONCE, for the
  // whole lifetime of this screen — not once per restart cycle. Before,
  // _startNativeWatchdog() called _subscribeWatchdog() on every single
  // restart, which un-subscribes the old listeners then adds new ones. If
  // `.remove()` on an old listener ever silently failed (the code wraps it
  // in try/catch), the new listener would stack on top of the old one, and
  // every future native event would fire its JS handler TWICE — which is
  // exactly the kind of bug that makes the same restart message go out
  // more than once. Subscribing once on mount removes that failure mode
  // entirely; _startNativeWatchdog/_stopNativeWatchdog below now only
  // start/stop the native timers, they never touch listeners.
  useEffect(() => {
    _subscribeWatchdog();
    return () => { _unsubscribeWatchdog(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const _startNativeWatchdog = useCallback(() => {
    if (!WatchdogModule) {
      console.warn('WatchdogModule not available');
      return;
    }
    WatchdogModule.start(
      WATCHDOG_STUCK_THRESHOLD_MS,
      AUTO_RESTART_INTERVAL_MS,
      DAILY_RESTART_HOUR,
      HARD_RESTART_GRACE_MS,
      adminNumbersRef.current || '',
      deviceNameRef.current || '',
    );
    console.log('✅ Native watchdog started (with hard-restart backstop)');
  }, [_subscribeWatchdog]);

  const _stopNativeWatchdog = useCallback(() => {
    try { WatchdogModule?.stop?.(); } catch {}
  }, []);

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
          // the native SMS module's promise resolves via a
          // dynamically-registered BroadcastReceiver. If Android ever
          // drops that broadcast, this promise would hang forever and
          // freeze the whole SMS loop. Now it fails fast instead.
          const r = await withTimeout(SmsModule.sendSMS(num, message), SMS_OP_TIMEOUT_MS, 'SmsModule.sendSMS');
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

  // ─────────────────────────────────────────────────────────────────────────────
  // DB helpers
  // ─────────────────────────────────────────────────────────────────────────────
  const reconnect = useCallback(async () => {
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
  }, []);

  const markSent = useCallback(async (seed, devName) => {
    try {
      await dbUpdate(
        `UPDATE logs SET smssent=1, smsmac='${devName}', smssenttime=GETDATE()` +
        ` WHERE seed='${seed}'`
      );
    } catch (e) { console.error('markSent:', e); }
  }, [dbUpdate]);

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
      `🌅 SMS WINDOW OPENED — PROCESS STARTED\n\n` +
      `Device: ${deviceNameRef.current}\n` +
      `The SMS process has automatically started (same as tapping Start), ` +
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
      `The SMS process has automatically stopped (same as tapping Stop). ` +
      `It will automatically start again at ${formatTime(st)}.\n` +
      `Email notifications continue 24/7.`;
    updateServiceStatus(`😴 Stopped — resumes ${formatTime(st)}`);
    if (adminEmailsRef.current?.trim()) queueEmailStable('SMS Window Closed', msg);
  }, [queueEmailStable, updateServiceStatus]);

  // ─────────────────────────────────────────────────────────────────────────────
  // MAIN LOOP — runs only while SMS processing is "activated" (window open)
  // ─────────────────────────────────────────────────────────────────────────────
  const runLoop = useCallback(async () => {
    const limit   = parseInt(numStudentsRef.current, 10) || 5;
    const idleMs  = (parseInt(idleSecondsRef.current, 10) || 5) * 1000;
    const devName = deviceNameRef.current;

    const startHH = '00:00:00';
    const endHH   = '23:59:59';

    setStatusMessage('Starting SMS process...');
    updateServiceStatus('Starting SMS process...');

    loopStartTimestampRef.current = Date.now();

    // 🔧 NEW: reset reconnect-stuck escalation state at the start of every
    // fresh runLoop invocation (i.e. every restart cycle), so a previous
    // cycle's failure streak/timers never bleed into the new one.
    reconnectFailStreakRef.current   = 0;
    reconnectStuckSinceRef.current   = 0;
    lastNetworkErrorNotifRef.current = 0;

    try {
      await reconnect();

      while (restartSignalRef.current === SIGNAL_NONE) {

        // ── Ping native watchdog so it knows the JS loop is alive ──────────
        try { WatchdogModule?.pingHeartbeat?.(); } catch {}

        // ── JS FALLBACK: 3-hour auto-restart ────────────────────────────────
        if (Date.now() - loopStartTimestampRef.current >= AUTO_RESTART_INTERVAL_MS) {
          _requestRestart('JS fallback: 3-hour interval elapsed (native timer did not fire)');
        }

        // ── JS FALLBACK: daily restart at DAILY_RESTART_HOUR ────────────────
        const nowDt    = new Date();
        const todayKey = nowDt.toDateString();
        if (
          restartSignalRef.current === SIGNAL_NONE &&
          nowDt.getHours() === DAILY_RESTART_HOUR &&
          nowDt.getMinutes() < DAILY_RESTART_FIRE_WINDOW_MIN &&
          dailyRestartFiredDateRef.current !== todayKey
        ) {
          dailyRestartFiredDateRef.current = todayKey;
          _requestRestart('JS fallback: daily restart (native timer did not fire)');
        }

        if (restartSignalRef.current !== SIGNAL_NONE) break;

        try {
          // ── Claim records ──────────────────────────────────────────────────
          await dbUpdate(`
            UPDATE logs SET smsmac='${devName}'
            WHERE seed IN (
              SELECT TOP (${limit}) seed FROM logs
              WHERE smssent=0 AND (smsmac IS NULL OR smsmac='')
                AND CONVERT(VARCHAR(10),date,120)=CONVERT(VARCHAR(10),GETDATE(),120)
                AND time BETWEEN '${startHH}' AND '${endHH}'
              ORDER BY smsprocessing ASC, date ASC, time ASC)`);

          const claimed = await dbQuery(`
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

          // Ping again right after the DB round-trip — belt-and-suspenders
          // in case a slow-but-successful query ate a big chunk of the
          // heartbeat interval.
          try { WatchdogModule?.pingHeartbeat?.(); } catch {}

          if (!claimed || claimed.length === 0) {
            // ── Idle ──────────────────────────────────────────────────────────
            cycleCountRef.current += 1;
            setCycleCount(cycleCountRef.current);

            const statusTxt =
              `No new records. Idle cycle ${cycleCountRef.current} — ` +
              `waiting ${idleSecondsRef.current}s...`;
            setStatusMessage(statusTxt);

            if (cycleCountRef.current % 10 === 0) {
              updateServiceStatus(`Idle cycle ${cycleCountRef.current} — sending active`);
            }

          } else {
            // ── Process records ────────────────────────────────────────────────
            cycleCountRef.current = 0;
            setCycleCount(0);
            updateServiceStatus(`Processing ${claimed.length} record(s)...`);

            const failedThisCycle = [];

            for (const log of claimed) {
              if (restartSignalRef.current !== SIGNAL_NONE) break;

              if (!isSmsWindowOpen()) {
                try {
                  await dbUpdate(
                    `UPDATE logs SET smsmac=NULL WHERE seed='${log.seed}' AND smssent=0`
                  );
                } catch {}
                continue;
              }

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

              // Ping between sends too — a batch of several numbers each
              // waiting up to SMS_OP_TIMEOUT_MS can otherwise eat a lot of
              // wall-clock time between heartbeat pings.
              try { WatchdogModule?.pingHeartbeat?.(); } catch {}

              if (log.smsprocessing < SMS_MAX_PROCESSING) {
                const ok = await sendSMSStable(validNumbers, message);
                await dbUpdate(
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
          // With DB_OP_TIMEOUT_MS in place, a stalled connection now
          // lands here (as a timeout Error) instead of hanging forever.
          console.error('Loop iteration error:', loopErr);
          const errMsg = String(loopErr?.message || loopErr).toLowerCase();
          const isNetworkish =
            errMsg.includes('network') ||
            errMsg.includes('timeout') ||
            errMsg.includes('timed out') ||
            errMsg.includes('connection');

          // 🔧 NEW: mark the start of a fresh failure streak so we can
          // measure how long we've been continuously stuck.
          if (reconnectFailStreakRef.current === 0) {
            reconnectStuckSinceRef.current = Date.now();
          }
          const nowErr   = Date.now();
          const stuckMs  = reconnectStuckSinceRef.current
            ? nowErr - reconnectStuckSinceRef.current
            : 0;
          const stuckMin = Math.max(1, Math.round(stuckMs / 60000));

          // 🔧 NEW: notify on the FIRST error, and then again every
          // RECONNECT_RENOTIFY_INTERVAL_MS while still stuck — instead of
          // exactly once and then silence for however long the outage lasts.
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

          // 🔧 NEW: give up retrying in-place after RECONNECT_STUCK_RESTART_MS
          // and force a full coordinator restart instead — this rebuilds all
          // loop/connection state from scratch rather than possibly retrying
          // against the same wedged connection object forever. The restart
          // itself will send its own AUTO-RESTART STARTING/COMPLETE notices.
          if (stuckMs >= RECONNECT_STUCK_RESTART_MS) {
            console.warn(`🚨 Reconnect stuck for ${stuckMin} min — forcing full restart`);
            reconnectFailStreakRef.current = 0;
            reconnectStuckSinceRef.current = 0;
            _requestRestart(`Stuck reconnecting for ${stuckMin}+ minutes`);
            break;
          }

          // 🔧 NEW: exponential backoff instead of a flat 5s retry forever.
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
      await safeClose();
    }
  }, [
    reconnect, sendSMSStable, queueEmailStable, markSent, notifyNetworkError,
    updateServiceStatus, isSmsWindowOpen, _requestRestart, dbUpdate, dbQuery,
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
      restartSignalRef.current         = SIGNAL_NONE;
      restartReasonRef.current         = '';
      coordinatorRestartingRef.current = false;
      // fresh slate for this cycle — whatever was set during the PREVIOUS
      // restart has already been consumed, so start this one clean.
      restartStartNotifiedRef.current  = false;
      cycleCountRef.current            = 0; setCycleCount(0);
      sendingSeedsRef.current          = new Set();
      networkErrorSentRef.current      = false;

      setIsRunning(true);
      isRunningRef.current = true;

      _startNativeWatchdog();

      try { WatchdogModule?.resetAutoRestartTimer?.(); } catch {}

      if (!isFirstRun) {
        const reason = restartReasonRef.current || 'Scheduled restart';
        const nowTs  = Date.now();
        // hard cooldown — see RESTART_NOTIF_COOLDOWN_MS comment above.
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

      try { await runLoop(); }
      catch (e) { console.error('lifecycleCoordinator: runLoop threw:', e); }

      const signal = restartSignalRef.current;
      _stopNativeWatchdog();

      if (signal === SIGNAL_STOP || signal === SIGNAL_NONE) {
        console.log('🛑 Coordinator: clean stop');
        break;
      }

      const reason = restartReasonRef.current || 'Scheduled 3hr auto-restart';
      console.log(`🔄 Coordinator: restarting — ${reason}`);

      coordinatorRestartingRef.current = true;
      setStatusMessage(`🔄 Auto-restarting (${reason})...`);
      updateServiceStatus(`🔄 Restarting: ${reason}`);

      // Only send the generic "STARTING" notice if nothing already told
      // admins about THIS SPECIFIC restart (e.g. the watchdog-stuck alert,
      // which sets restartStartNotifiedRef = true before requesting the
      // restart). This is what stops admins/parents from getting 2-3
      // messages for what is really one restart event — now it's exactly
      // one "it's restarting" notice, no matter which trigger caused it.
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
      setStatusMessage(`🔴 Stopped (SMS window closed). Auto-starts at ${formatTime(st)}.`);
      updateServiceStatus(`Stopped — auto-starts ${formatTime(st)}`);
    }

    console.log('🛑 Coordinator: exited');
  }, [
    runLoop, sendSMSStable, queueEmailStable,
    _startNativeWatchdog, _stopNativeWatchdog,
    updateServiceStatus, isSmsWindowOpen,
  ]);

  // ─────────────────────────────────────────────────────────────────────────────
  const _activateProcessing = useCallback(async () => {
    if (coordinatorRunningRef.current) return;
    console.log('▶️ SMS window OPEN — activating processing (same as Start)');
    restartSignalRef.current = SIGNAL_NONE;
    try { await notifySmsWindowOpen(); } catch {}
    await lifecycleCoordinator();
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

  // ─────────────────────────────────────────────────────────────────────────────
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

  // ── doStop / doStart — the ONLY places that touch the foreground service ────
  const doStop = useCallback((silent = false) => {
    windowSchedulerActiveRef.current = false;
    if (windowScheduleTimeoutRef.current) {
      clearTimeout(windowScheduleTimeoutRef.current);
      windowScheduleTimeoutRef.current = null;
    }
    _requestStop();
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
    // this flag now flips to true BEFORE the first `await` below.
    // Previously it was set AFTER `await AsyncStorage.setItem(...)`, which
    // left a window where calling doStart() twice in quick succession
    // (e.g. auto-resume-on-launch racing a manual Start tap) could let
    // both calls pass the guard above before either one claimed it.
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
                  {`🟢 Running · 🔄 ${intervalLabel} restart · 🐕 Native watchdog · ⏹ Auto-stops ${formatTime(endTime)}`}
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