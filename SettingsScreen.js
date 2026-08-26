import React, { useState } from 'react';
import { 
  View, 
  Text, 
  TextInput, 
  TouchableOpacity, 
  StyleSheet, 
  Alert, 
  Keyboard, 
  TouchableWithoutFeedback 
} from 'react-native';
import { useNavigation } from '@react-navigation/native';

export default function SettingsScreen() {
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);   // 👁️ NEW
  const [isRunning, setIsRunning] = useState(false);
  const navigation = useNavigation();

  const handleSubmitPress = () => {
    if (password === 'abc123#') {
      navigation.navigate('Configuration');
    } else {
      Alert.alert('Access Denied', 'Incorrect password, please try again.');
    }
  };

  const handleCancelPress = () => {
    Keyboard.dismiss();
    navigation.navigate('Main');
  };

  return (
    <TouchableWithoutFeedback onPress={Keyboard.dismiss} accessible={false}>
      <View style={styles.container}>
        <View style={styles.inputGroup}>
          <Text style={styles.label}>Administration Password:</Text>

          {/* PASSWORD FIELD WITH TOGGLE */}
          <View style={styles.passwordContainer}>
            <TextInput
              style={[styles.input, { flex: 1 }]}
              placeholder="Password"
              secureTextEntry={!showPassword}
              value={password}
              onChangeText={setPassword}
            />

            <TouchableOpacity onPress={() => setShowPassword(!showPassword)}>
              <Text style={{color: '#606e7cff'}}>
                {showPassword ? 'Hide' : 'Show'}
              </Text>
            </TouchableOpacity>

          </View>

          <Text style={styles.label2}>HINT: SFS DEV</Text>
        </View>

        <View style={styles.buttonContainer}>
          <TouchableOpacity
            style={[styles.button, { backgroundColor: isRunning ? '#CBD99B' : '#212A3E' }]}
            onPress={handleSubmitPress}
            disabled={isRunning}
          >
            <Text style={styles.buttonText}>Submit</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.button, { backgroundColor: '#737d8fff' }]}
            onPress={handleCancelPress}
          >
            <Text style={styles.buttonText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </View>
    </TouchableWithoutFeedback>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#f8f9fa',
  },

  inputGroup: {
    marginBottom: 20,
    width: '100%',
    alignItems: 'center',
  },

  label: {
    fontSize: 24,
    fontWeight: '500',
    color: '#34495e',
    marginBottom: 10,
    textAlign: 'center',
  },

  label2: {
    fontSize: 12,
    fontWeight: '400',
    fontStyle: 'italic',
    color: '#e23232ff',
    marginTop: 5
  },

  passwordContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    width: '80%',
    borderWidth: 1,
    borderColor: '#bdc3c7',
    borderRadius: 8,
    backgroundColor: '#fff',
    paddingHorizontal: 10,
  },

  eyeButton: {
    paddingHorizontal: 10,
  },

  eyeText: {
    fontSize: 22,
  },

  input: {
    paddingVertical: 12,
    fontSize: 16,
  },

  buttonContainer: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    width: '70%',
    marginTop: 10,
  },

  button: {
    paddingVertical: 12,
    paddingHorizontal: 30,
    borderRadius: 10,
  },

  buttonText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 15,
  },
});
