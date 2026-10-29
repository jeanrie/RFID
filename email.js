// emailService.js
import { GoogleSignin } from '@react-native-google-signin/google-signin';
import { encode as base64Encode } from 'base-64';
import utf8 from 'utf8';

// Get Signed In Email 
export const getSignedInEmail = async () => {
  try {
    const user = await GoogleSignin.getCurrentUser();
    return user?.user?.email || null;
  } catch (err) {
    console.log('getSignedInEmail error', err);
    return null;
  }
};

// Get Access Token Silently 
export const getAccessTokenSilently = async () => {
  try {
    await GoogleSignin.hasPlayServices({
      showPlayServicesUpdateDialog: true,
    });

    const user = await GoogleSignin.getCurrentUser();
    if (!user) return null;

    const tokens = await GoogleSignin.getTokens();
    return tokens?.accessToken || null;
  } catch (err) {
    console.error("Failed to get access token silently", err);
    return null;
  }
};

// Sign-in if needed (interactive) 
export const signInWithGoogleOnce = async () => {
  try {
    await GoogleSignin.hasPlayServices({
      showPlayServicesUpdateDialog: true,
    });

    await GoogleSignin.signIn();
  } catch (err) {
    console.error("Google Sign-In failed", err);
  }
};

// Fetch Access Token 
export const fetchAccessToken = async () => {
  let token = await getAccessTokenSilently();
  if (!token) {
    await signInWithGoogleOnce();
    token = await getAccessTokenSilently();
  }
  return token;
};

// Send Email via Gmail API 
export const sendEmailViaGmailAPI = async (to, subject, message, accessToken) => {
  if (!accessToken) return false;

  const fromEmail = await getSignedInEmail();
  if (!fromEmail) return false;

  const email =
    `From: Attendance SMS <${fromEmail}>\r\n` +
    `To: ${to}\r\n` +
    `Subject: ${subject}\r\n` +
    `Content-Type: text/plain; charset="UTF-8"\r\n\r\n` +
    `${message}`;

  const utf8Email = utf8.encode(email);
  const raw = base64Encode(utf8Email)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  try {
    const res = await fetch(
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ raw }),
      }
    );

    if (!res.ok) {
      const txt = await res.text();
      console.log('Gmail API send failed', res.status, txt);
      return false;
    }

    console.log('Gmail API send OK');
    return true;
  } catch (err) {
    console.log('sendEmailViaGmailAPI error', err);
    return false;
  }
};
