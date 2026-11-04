import { useEffect, useState } from 'react';
import { Text } from 'react-native';
import { Redirect } from 'expo-router';

const errorBoundaryTestKey = 'me-error-boundary-test-thrown';

/**
 * Crash fixture for the error-boundary UI spec only (ported from the
 * Replit Nov 3 build). It renders ONLY in a build made with
 * EXPO_PUBLIC_TEST_ERROR_BOUNDARY=true — see
 * playwright.error-boundary.config.js / `npm run test:ui:error-boundary`.
 * The normal test:web build never sets that variable, so production and
 * the main UI suite never see this screen. It throws exactly once per
 * browser session; after the boundary's Try Again, it shows the recovered
 * marker instead of throwing again.
 */
function ErrorBoundaryTestScreen() {
  const [shouldThrow, setShouldThrow] = useState(false);
  const [recovered, setRecovered] = useState(false);

  useEffect(() => {
    if (window.sessionStorage.getItem(errorBoundaryTestKey) === 'true') {
      setRecovered(true);
      return;
    }

    window.sessionStorage.setItem(errorBoundaryTestKey, 'true');
    setShouldThrow(true);
  }, []);

  if (shouldThrow) {
    throw new Error('Controlled error boundary test');
  }

  return recovered ? (
    <Text testID="error-boundary-recovered">The app recovered.</Text>
  ) : (
    <Text>Preparing the controlled test.</Text>
  );
}

export default function IndexRoute() {
  if (process.env.EXPO_PUBLIC_TEST_ERROR_BOUNDARY === 'true') {
    return <ErrorBoundaryTestScreen />;
  }

  return <Redirect href="/(tabs)/feed" />;
}
