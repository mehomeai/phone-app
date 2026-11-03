import * as WebBrowser from 'expo-web-browser';
import React, { useEffect } from 'react';
import { Text, View } from 'react-native';

/**
 * OAuth callback route for the app-owned scheme
 * (`me-mobile://auth/callback`, registered in app.json).
 *
 * Expo AuthSession + WebBrowser completes the flow natively; this screen
 * never reads tokens from the URL and persists nothing. It exists so the
 * OS deep link lands inside Expo Router on a known route.
 */
export default function AuthCallback() {
  useEffect(() => {
    WebBrowser.maybeCompleteAuthSession();
  }, []);
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <Text>Finishing secure sign-in — you can return to the app.</Text>
    </View>
  );
}
