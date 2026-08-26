//MainScreen.js with sms processing
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

// Web client id from Google Cloud 
const WEB_CLIENT_ID = '651284152046-22s1bs6beejjmd6jkop35rdi6hsaapqt.apps.googleusercontent.com';

export default function MainScreen() {
  const [isRunning, setIsRunning] = useState(false); // ✅ move here before KeepAwake effect

  const keepAwakeActiveRef = useRef(false);

  // KeepAwake effect
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

  // GOOGLE SIGN-IN INITIALIZATION 
  useEffect(() => {
    (async () => {
      try {
        GoogleSignin.configure({
          webClientId: WEB_CLIENT_ID,
          offlineAccess: true,
          scopes: ['email', 'profile', 'https://mail.google.com/'],
        });

        await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });

        // NEW API — check if user exists
        const user = await GoogleSignin.getCurrentUser();

        if (!user) {
          await GoogleSignin.signIn();   // Interactive login ONCE
        }
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


  // --- STATE ---
  const [numStudents, setNumStudents] = useState('10');
  const [idleSeconds, setIdleSeconds] = useState('20');
  const defaultStart = new Date();
  defaultStart.setHours(4, 0, 0, 0);
  const defaultEnd = new Date();
  defaultEnd.setHours(22, 0, 0, 0);
  const [startTime, setStartTime] = useState(defaultStart);
  const [endTime, setEndTime] = useState(defaultEnd);
  const [showStartPicker, setShowStartPicker] = useState(false);
  const [showEndPicker, setShowEndPicker] = useState(false);

  const [deviceName, setDeviceName] = useState('');
  const [serverName, setServerName] = useState('');
  const [databaseName, setDatabaseName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [arrivalMessage, setArrivalMessage] = useState('');
  const [departureMessage, setDepartureMessage] = useState('');
  const [displayDashboard, setDisplayDashboard] = useState(false);
  const [batteryThreshold, setBatteryThreshold] = useState(20);
  const [adminNumbers, setAdminNumbers] = useState('');
  const [adminEmails, setAdminEmails] = useState('');
  const batteryAlertSentRef = useRef(false);
  const emailQueueRef = useRef([]);
  const stopRequestedRef = useRef(false);
  const cycleCountRef = useRef(0);
  const failedSendsRef = useRef({});
  const maxErrorCycles = 30;
  const [cycleCount, setCycleCount] = useState(0);
  const [statusMessage, setStatusMessage] = useState('');
  const navigation = useNavigation();
  const sendingEmailRef = useRef(false);
  const smsPermissionGrantedRef = useRef(false);
  const SMS_MAX_PROCESSING = 5;

  const networkErrorSentRef = useRef(false);
  const lastNetworkErrorRef = useRef(null);
  const lastLoopRunRef = useRef(Date.now());
  const watchdogIntervalRef = useRef(null);
  const restartIntervalRef = useRef(null);
  const isRefreshingRef = useRef(false);
  const lastFullResetRef = useRef(Date.now());
  const dbConnectedRef = useRef(false);
  const dbBusyRef = useRef(false);
  const lastSuccessfulDbRef = useRef(Date.now());
  const dbLockRef = useRef(false);


  useEffect(() => {
    if (!isRunning) return;

    const watchdogInterval = setInterval(async () => {
      const diff = Date.now() - lastSuccessfulDbRef.current;

      if (diff < 300000) return; // 5 min ok

      if (dbLockRef.current || isRefreshingRef.current) return;

      console.log('🚨 DB frozen → reconnecting');

      await withDbLock(async () => {
        await reconnectDB();
      });

    }, 60000);

    return () => clearInterval(watchdogInterval);
  }, [isRunning]);

  useEffect(() => {

    if (!isRunning) return;

    const heartbeat = setInterval(async () => {

      try {

        if (dbBusyRef.current) {
          return;
        }

        dbBusyRef.current = true;

        await MSSQL.executeQuery(
          'SELECT GETDATE()'
        );

        dbConnectedRef.current = true;

        lastSuccessfulDbRef.current =
          Date.now();

      } catch (err) {

        console.log('Heartbeat failed');

        dbConnectedRef.current = false;

      } finally {

        dbBusyRef.current = false;

      }

    }, 60000);

    return () => clearInterval(heartbeat);

  }, [isRunning]);

  useEffect(() => {
    if (!isRunning) return;

    let intervalId;

    const runRefresh = async () => {
      const now = Date.now();
      const diff = now - lastFullResetRef.current;

      // already refreshing
      if (isRefreshingRef.current) return;

      // still not 1 hour
      if (diff < 10 *  60 * 1000) return;

      console.log('♻️ AUTO REFRESH TRIGGERED');

      isRefreshingRef.current = true;

      try {
        setStatusMessage('♻️ Refreshing DB...');

        if (dbBusyRef.current) {
          return;
        }

        dbBusyRef.current = true;

        try {

          await safeClose();

          await sleep(2000);

          const connected = await ensureDbConnection();

          if (!connected) {

            Alert.alert(
              'Database Error',
              'Cannot connect to SQL Server.'
            );

            setIsRunning(false);

            return;
          }

          dbConnectedRef.current = true;

          lastSuccessfulDbRef.current =
            Date.now();

        } finally {

          dbBusyRef.current = false;

        }

        lastFullResetRef.current = Date.now();

        console.log('✅ REFRESH DONE:', new Date().toLocaleTimeString());
        setStatusMessage('✅ DB refreshed');
      } catch (err) {
        console.log('❌ Refresh error:', err);
      } finally {
        isRefreshingRef.current = false;
      }
    };

    // run every 1 minute
    intervalId = setInterval(runRefresh, 60 * 1000);

    console.log('🟢 Refresh system started');

    return () => {
      clearInterval(intervalId);
      console.log('🔴 Refresh system stopped');
    };
  }, [isRunning]);


  // --- load saved config ---
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


  const withDbLock = async (fn) => {
    if (dbLockRef.current) return null;
    dbLockRef.current = true;

    try {
      return await fn();
    } finally {
      dbLockRef.current = false;
    }
  };


  const mssqlConfig = {
    server: serverName,
    username,
    password,
    database: databaseName,
    port: 1433,
    timeout: 15,
  };

  const getBatteryLevel = async () => {
    try {
      if (BatteryModule?.getLevel) return await BatteryModule.getLevel();
      return 100;
    } catch {
      return 100;
    }
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
      const options = { hour: '2-digit', minute: '2-digit', hour12: true };
      const timeStr = dt.toLocaleTimeString('en-US', options).toLowerCase();
      const dateStr = dt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
      return `${timeStr} ${dateStr}`;
    } catch (e) {
      if (typeof __DEV__ !== 'undefined' && __DEV__) {
        console.error('ERR PARSING DATE', e);
      }
      return sqlTime;
    }
  };

  const safeClose = async () => {
    try {

      await MSSQL.close();

    } catch (e) {

      console.log(
        'safeClose ignored',
        e?.message
      );

    }

    dbConnectedRef.current = false;
  };

  const reconnectDB = async (retries = 5) => {
    if (dbLockRef.current) return false;
    dbLockRef.current = true;

    try {
      for (let i = 0; i < retries; i++) {
        try {
          await safeClose();
          await MSSQL.connect(mssqlConfig);

          dbConnectedRef.current = true;
          lastSuccessfulDbRef.current = Date.now();

          return true;

        } catch (e) {
          await sleep(3000 * (i + 1));
        }
      }

      dbConnectedRef.current = false;
      return false;

    } finally {
      dbLockRef.current = false;
    }
  };

  const ensureDbConnection = async () => {
    try {
      if (dbConnectedRef.current) {
        return true;
      }

      await safeClose();

      await MSSQL.connect(mssqlConfig);

      dbConnectedRef.current = true;
      lastSuccessfulDbRef.current = Date.now();

      console.log('✅ DB connected');

      return true;
    } catch (err) {
      dbConnectedRef.current = false;

      console.log('❌ DB connect failed', err);

      return false;
    }
  };

  const ensureSmsPermission = async () => {
    if (smsPermissionGrantedRef.current) return true;

    if (Platform.OS !== 'android') return true;

    const perm = PermissionsAndroid.PERMISSIONS.SEND_SMS;

    const has = await PermissionsAndroid.check(perm);
    if (has) {
      smsPermissionGrantedRef.current = true;
      return true;
    }

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
    return raw
      .split(/[,;]+/)
      .map((n) => n.trim())
      .filter((n) => n.length > 0 && isValidPhone(n));
  };

  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  const sendSMS = async (numbers = [], message) => {
    try {
      const ok = await ensureSmsPermission();
      if (!ok) return false;

      if (!Array.isArray(numbers) || numbers.length === 0 || !message) return true; 

      // Ensure all numbers are valid
      const validNumbers = numbers.filter(isValidPhone);
      if (validNumbers.length === 0) return true; // nothing to send

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
      const query = `
        UPDATE logs
        SET 
          smssent = 1,
          smsmac = '${deviceNameParam}',
          smssenttime = GETDATE()
        WHERE seed = '${seed}'
      `;
      await MSSQL.executeUpdate(query);
    } catch (error) {
      console.error('Failed to update log in markSent:', error);
    }
  };

  const handleStop = () => {
    stopRequestedRef.current = true;
    setIsRunning(false);
  
    Alert.alert('Process Stopped', 'SMS process stopping...');
  };


  const getLowBatteryMessage = (level) => {
    return `⚠️ LOW BATTERY ALERT ⚠️
    
  Device: ${deviceName}
  Battery Level: ${level}%

  Please plug in the device immediately.`;
  };


  const queueEmail = (subject, message) => {
    if (!emailQueueRef.current) emailQueueRef.current = [];
    emailQueueRef.current.push({ subject, message });
    processEmailQueue();
  };

  const processEmailQueue = async () => {
    if (sendingEmailRef.current) return;
    sendingEmailRef.current = true;

    try {
      const recipients = (adminEmails || '')
        .split(/[;,]+/)
        .map(s => s.trim())
        .filter(Boolean);

      if (recipients.length === 0) {
        console.warn('No admin emails configured.');
        emailQueueRef.current = [];
        return;
      }

      let accessToken = await fetchAccessToken();
      if (!accessToken) return;

      while (emailQueueRef.current.length > 0) {
        const { subject, message } = emailQueueRef.current[0];

        const ok = await sendEmailViaGmailAPI(
          recipients.join(','),
          subject,
          message,
          accessToken
        );

        if (ok) {
          emailQueueRef.current.shift();
        } else {
          break;
        }
      }
    } finally {
      sendingEmailRef.current = false;
    }
  };

  const notifyNetworkError = async (errorMsg) => {
    try {
      const msg = `NETWORK/SERVER ERROR 
      
  Device: ${deviceName}

  Error:
  ${errorMsg}

  The device cannot connect to the server or lost internet connection.`;

      const numbers = getValidNumbers(adminNumbers);

      if (numbers.length > 0) {
        await sendSMS(numbers, msg);
      }

      if (adminEmails && adminEmails.trim() !== '') {
        queueEmail('Network/Server Error', msg);
      }

      console.log('⚠️ Network alert sent to admin');
    } catch (e) {
      console.log('Failed to send network alert:', e);
    }
  };



  // MAIN LOOP 
  const sendingSeedsRef = useRef(new Set()); // tracks seeds being sent this cycle
 
  const failedCyclesRef = useRef({}); // 🟢 tracks seeds being sent this cycle

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

    try {
      await MSSQL.connect(mssqlConfig);
      networkErrorSentRef.current = false;

      const limit = parseInt(numStudents, 10) || 5;
      const idleMs = (parseInt(idleSeconds, 10) || 5) * 1000;

      const startHHMMSS =
        `${startTime.getHours().toString().padStart(2, '0')}:${startTime.getMinutes().toString().padStart(2, '0')}:00`;

      const endHHMMSS =
        `${endTime.getHours().toString().padStart(2, '0')}:${endTime.getMinutes().toString().padStart(2, '0')}:59`;

      while (!stopRequestedRef.current) {

        const dbOk = await ensureDbConnection();

        if (!dbOk) {
          await sleep(5000);

          if (!dbConnectedRef.current) {
            setStatusMessage('❌ DB down. Waiting for recovery...');
          }

          continue;
        }

     
        try {
          lastLoopRunRef.current = Date.now();

        
          // =========================
          // CLAIM RECORDS
          // =========================

          if (dbBusyRef.current) {

            await sleep(1000);

            continue;
          }

          dbBusyRef.current = true;

          try {

          
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

          const claimed = await MSSQL.executeQuery(`
            SELECT TOP (${limit})
              l.seed, l.studentid, l.date, l.time, l.trans, l.fetcher,
              l.smssent, l.smsmac, ISNULL(l.smsprocessing,0) as smsprocessing,
              s.studentname, s.smsnotify, s.parentguardian, s.yearlevel, s.section
            FROM logs l
            INNER JOIN student s ON l.studentid = s.studentid
            WHERE l.smssent = 0
              AND l.smsmac = '${deviceName}'
              AND CONVERT(VARCHAR(10), l.date, 120) = CONVERT(VARCHAR(10), GETDATE(), 120)
              AND l.time BETWEEN '${startHHMMSS}' AND '${endHHMMSS}'
            ORDER BY l.smsprocessing ASC, l.date ASC, l.time ASC;
          `);

          lastSuccessfulDbRef.current =
            Date.now();

          } finally {

            dbBusyRef.current = false;

          }

          if (!claimed || claimed.length === 0) {
            cycleCountRef.current += 1;
            setCycleCount(cycleCountRef.current);
            setStatusMessage(
              `No new records. Idle cycle ${cycleCountRef.current} — waiting ${idleSeconds}s...`
            );
          } else {
            cycleCountRef.current = 0;
            setCycleCount(0);

            const failedThisCycle = [];

            for (const log of claimed) {
              if (stopRequestedRef.current) break;
              if (sendingSeedsRef.current.has(log.seed)) continue;

              sendingSeedsRef.current.add(log.seed);

              const studentName = log.studentname || 'Student';
              const trans = log.trans || '';
              const formattedTimeDate = formatLogDateTime(log.date, log.time);
              const yearLevel = log.yearlevel || '';
              const section = log.section || '';

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

              const rawNumbers = log.smsnotify
                ? log.smsnotify.split(/[,;]+/).map(n => n.trim())
                : [];

              const validNumbers = rawNumbers.filter(isValidPhone);

              if (validNumbers.length === 0) {
                console.log(`Skipping ${studentName} — no valid SMS number.`);
                await markSent(log.seed, deviceName);

                failedSendsRef.current[log.seed] =
                  (failedSendsRef.current[log.seed] || 0) + 1;

                if (failedSendsRef.current[log.seed] >= maxErrorCycles) {
                  failedThisCycle.push({ studentName, seed: log.seed });
                  delete failedSendsRef.current[log.seed];
                }

                sendingSeedsRef.current.delete(log.seed);
                continue;
              }

              let ok = true;

              if (log.smsprocessing < SMS_MAX_PROCESSING) {
                ok = await sendSMS(validNumbers, message);

                await MSSQL.executeUpdate(`
                  UPDATE logs
                  SET smsprocessing = ISNULL(smsprocessing,0) + 1
                      ${ok ? `, smssent = 1, smssenttime = GETDATE()` : ''}
                  WHERE seed = '${log.seed}' AND smsmac = '${deviceName}'
                `);

                if (ok) {
                  await markSent(log.seed, deviceName);
                  delete failedSendsRef.current[log.seed];
                }
              } else {
                failedSendsRef.current[log.seed] =
                  (failedSendsRef.current[log.seed] || 0) + 1;

                if (failedSendsRef.current[log.seed] >= maxErrorCycles) {
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
                `Failed after ${maxErrorCycles} cycles. Check SIM/load.`
              );

              if (adminEmails && adminEmails.trim() !== '') {
                queueEmail(
                  'Critical SMS Error',
                  `Failed students:\n${failedNames}\nDevice: ${deviceName}`
                );
              }

              try {
                const sound = errorSoundRef?.current;
                if (sound) {
                  sound.setVolume(1.0);
                  sound.play();
                }
                Vibration.vibrate([0, 1000, 500, 1000], false);
              } catch (e) {}
            }

            setStatusMessage('Processed new records. Cycle counter reset.');
          }

          // =========================
          // BATTERY CHECK
          // =========================
          try {
            const level = await getBatteryLevel();

            if (level <= batteryThreshold && !batteryAlertSentRef.current) {
              const msg = getLowBatteryMessage(level);

              if (adminNumbers && adminNumbers.trim() !== '') {
                await sendSMS(getValidNumbers(adminNumbers), msg);
              }

              queueEmail('Low Battery Alert', msg);
              batteryAlertSentRef.current = true;
            } else if (level > batteryThreshold) {
              batteryAlertSentRef.current = false;
            }
          } catch {}

          await sleep(idleMs);

        } catch (loopErr) {
          console.error('Loop error:', loopErr);

          const errMsg = String(loopErr?.message || loopErr).toLowerCase();

          if (
            errMsg.includes('network') ||
            errMsg.includes('timeout') ||
            errMsg.includes('connection')
          ) {
            if (!networkErrorSentRef.current) {
              await notifyNetworkError(errMsg);
              networkErrorSentRef.current = true;
            }

            setStatusMessage('⚠️ Reconnecting...');
          }

          try {
            await safeClose();
            await MSSQL.connect(mssqlConfig);
          } catch (e) {}

          await sleep(5000);
        }
      }
    } catch (err) {
      console.error('Main loop error', err);
      await notifyNetworkError(String(err));
      Alert.alert('Error', 'Something went wrong with the SMS process.');
    } finally {
      await safeClose();
      setIsRunning(false);
      setStatusMessage('Process stopped.');
    }
  };

  const handleSettingsPress = () => {
    Keyboard.dismiss();
    navigation?.navigate('Settings');
  };

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.container}>
        <TouchableWithoutFeedback onPress={Keyboard.dismiss} accessible={false}>
          <View style={styles.innerContainer}>
            <Text style={styles.title}>School Attendance SMS Notifier</Text>

            <Image source={require('./assets/mhcs_logo.png')} style={styles.logo} />

            <View style={styles.inputsContainer}>
              {/* Number of Students */}
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

              {/* Idle Seconds */}
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

              {/* Start Time */}
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

              {/* End Time */}
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
  inputsContainer: {
    width: '100%',
  },
  inputGroup: {
    marginBottom: height * 0.015,
  },
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
