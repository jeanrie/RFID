import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ScrollView,
  Switch
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import MSSQL from 'react-native-mssql';

export default function ConfigurationScreen({ navigation }) {
  const [deviceName, setDeviceName] = useState('');
  const [serverName, setServerName] = useState('');
  const [databaseName, setDatabaseName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [arrivalMessage, setArrivalMessage] = useState('');
  const [departureMessage, setDepartureMessage] = useState('');
  const [displayDashboard, setDisplayDashboard] = useState(false);
  const [adminNumbers, setAdminNumbers] = useState(''); 
  const [batteryThreshold, setBatteryThreshold] = useState(0); 
  const [adminEmails, setAdminEmails] = useState(''); // New state for email addresses


  
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
          console.log('Loaded adminNumbers:', config.adminNumbers);
          setAdminNumbers(config.adminNumbers || '');        
          setBatteryThreshold(config.batteryThreshold || 0);
          setAdminEmails(config.adminEmails || '');

        }
      } catch (err) {
        console.error('Failed to load config:', err);
      }
    })();
  }, []);

  // Test Connection to SQL Server
  const handleTestConnection = async () => {
    if (!serverName || !databaseName || !username || !password) {
      Alert.alert('Missing Information', 'Please fill out all required fields.');
      return;
    }

    const config = {
      server: serverName,
      username: username,
      password: password,
      database: databaseName,
      port: 1433,
      timeout: 10,
    };

    try {
      await MSSQL.connect(config);
      const result = await MSSQL.executeQuery('SELECT 1 AS test');
      if (result && result.length > 0) {
        Alert.alert('✅ Connection Successful', 'Connected to SQL Server successfully!');
      } else {
        Alert.alert('⚠️ Connection Failed', 'Could not fetch data from SQL Server.');
      }
    } catch (error) {
      console.error('Test connection failed:', error);
      Alert.alert('❌ Connection Failed', 'Please check your SQL Server settings.');
    } finally {
      try { await MSSQL.close(); } catch {}
    }
  };

  
  const handleSave = async () => {
    if (!deviceName || !serverName || !databaseName || !username || !password) {
      Alert.alert('Missing Information', 'Please fill out all fields before saving.');
      return;
    }

    const config = {
      deviceName,
      serverName,
      databaseName,
      username,
      password,
      arrivalMessage,
      departureMessage,
      displayDashboard,
      adminNumbers,     
      batteryThreshold, 
      adminEmails
    };

    try {
      await AsyncStorage.setItem('appConfig', JSON.stringify(config));
      Alert.alert('✅ Configuration Saved', 'Your settings have been saved successfully.');
    } catch (err) {
      console.error('Save config failed:', err);
      Alert.alert('Error', 'Failed to save configuration.');
    }
  };

  const handleExit = () => {
    if (navigation) navigation.navigate('Main');
  };

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.safeArea}>
        <ScrollView
          style={styles.scrollView}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={true}
        >
          <Text style={styles.title}>Server Configuration</Text>

          {/* --- Container 1 --- */}
          <View style={styles.formContainer}>
            <View style={styles.inputGroup}>
              <Text style={styles.label}>Device Name</Text>
              <TextInput
                style={styles.input}
                placeholder="Enter Device Name"
                value={deviceName}
                onChangeText={setDeviceName}/>
            </View>

            <View style={styles.inputGroup}>
              <Text style={styles.label}>Server Name</Text>
              <TextInput
                style={styles.input}
                placeholder="Enter Server Name"
                value={serverName}
                onChangeText={setServerName}/>
            </View>

            <View style={styles.inputGroup}>
              <Text style={styles.label}>Database Name</Text>
              <TextInput
                style={styles.input}
                placeholder="Enter Database Name"
                value={databaseName}
                onChangeText={setDatabaseName} />
            </View>

            <View style={styles.inputGroup}>
              <Text style={styles.label}>Username</Text>
              <TextInput
                style={styles.input}
                placeholder="Enter Username"
                value={username}
                onChangeText={setUsername}/>
            </View>

            <View style={styles.inputGroup}>
              <Text style={styles.label}>Password</Text>
              <TextInput
                style={styles.input}
                placeholder="Enter Password"
                secureTextEntry={true}
                value={password}
                onChangeText={setPassword}/>
            </View>

            <View style={styles.buttonContainer}>
              <TouchableOpacity
                style={[styles.button, { backgroundColor: '#1A2A4F' }]}
                onPress={handleTestConnection}>
                <Text style={styles.buttonText}>Test Connection</Text>
              </TouchableOpacity>
            </View>
          </View>

          {/* --- Container 2 --- */}
          <View style={styles.formContainer}>
            <View style={styles.inputGroup}>
              <Text style={styles.label}>Student Arrival Message</Text>
              <TextInput
                style={[styles.input, styles.textArea]}
                placeholder="Enter message for arrival"
                multiline={true}
                numberOfLines={4}
                textAlignVertical="top"
                value={arrivalMessage}
                onChangeText={setArrivalMessage}/>
            </View>

            <View style={styles.inputGroup}>
              <Text style={styles.label}>Student Departure Message</Text>
              <TextInput
                style={[styles.input, styles.textArea]}
                placeholder="Enter message for departure"
                multiline={true}
                numberOfLines={4}
                textAlignVertical="top"
                value={departureMessage}
                onChangeText={setDepartureMessage} />
            </View>
          </View>

         
          <View style={styles.formContainer}>
            <View style={styles.inputGroup}>
              <Text style={styles.label}>Admin Alert Numbers</Text>
              <Text style={styles.label2}>(Use commas for multiple numbers)</Text>
              <TextInput style={styles.input} placeholder="Enter phone numbers" 
              value={adminNumbers}             
              onChangeText={setAdminNumbers}   />
              
            </View>

          <View style={styles.inputGroup}>
            <Text style={styles.label}>Admin Alert Emails</Text>
            <Text style={styles.label2}>(Use commas for multiple emails)</Text>
            <TextInput
              style={styles.input}
              placeholder="Enter admin email(s)"
              value={adminEmails}
              onChangeText={setAdminEmails}
              keyboardType="email-address"
              autoCapitalize="none"/>
          </View>


            <View style={styles.inputGroup}>
              <Text style={styles.label}>Battery Alert Threshold (%)</Text>
              <TextInput style={styles.input} placeholder="Enter percentage (e.g. 30)" 
              value={batteryThreshold}          
              onChangeText={setBatteryThreshold} 
              keyboardType="numeric"/>
            </View>
          </View>

          
          <View style={styles.formContainer}>
            <View style={[styles.inputGroup, { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }]}>
              <Text style={styles.label}>Display Dashboard Setting</Text>
              <Switch
                value={displayDashboard}
                onValueChange={setDisplayDashboard}
                trackColor={{ false: '#767577', true: '#1A2A4F' }}
                thumbColor={displayDashboard ? '#fff' : '#322fe7ff'}
              />
            </View>
          </View>

        
          <View style={styles.buttonContainer}>
            <TouchableOpacity
              style={[styles.button, { backgroundColor: '#1A2A4F' }]}
              onPress={handleSave}>
              <Text style={styles.buttonText}>Save Configuration</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.buttonContainer}>
            <TouchableOpacity
              style={[styles.button, { backgroundColor: '#E55050' }]}
              onPress={handleExit}>
              <Text style={styles.buttonText}>Exit</Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}




const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#f8f9fa',
  },
  scrollView: {
    flex: 1,
    width: '100%',
    overflow: 'auto', 
  },
  scrollContent: {
    flexGrow: 1,
    paddingHorizontal: 20,
    paddingBottom: 60,
    alignItems: 'center',
  },
  title: {
    fontSize: 24,
    fontWeight: '800',
    color: '#11224E',
    textAlign: 'center',
    marginVertical: 20,
  },
  formContainer: {
    width: '90%',
    backgroundColor: '#fff',
    padding: 20,
    borderRadius: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 5,
    marginBottom: 20,
  },
  inputGroup: {
    marginBottom: 15,
  },
  label: {
    fontSize: 16,
    fontWeight: '500',
    color: '#040536ff',
    marginBottom: 5,
  },
  label2: {
    fontSize: 10,
    fontWeight: '500',
    color: '#E55050',
    marginTop: -7,
    marginBottom: 5,
  },
  input: {
    borderWidth: 1,
    borderColor: '#bdc3c7',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 12,
    backgroundColor: '#fff',
    color: '#64696eff',
    fontSize: 14,
  },
  textArea: {
    height: 80,                 
    paddingVertical: 10,
    },
  buttonContainer: {
    marginTop: 10,
    alignItems: 'center',
    width: '100%',
  },
  button: {
    width: '90%',         
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',   
    },
  buttonText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 15,
  },
});
