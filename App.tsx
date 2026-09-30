import { useEffect, useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { NavigationContainer, DefaultTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { ActivityIndicator, View } from 'react-native';

import { CameraScreen } from '@/screens/CameraScreen';
import { ResultsScreen } from '@/screens/ResultsScreen';
import { AssignmentSummaryScreen } from '@/screens/AssignmentSummaryScreen';
import { AnswerKeyScreen } from '@/screens/AnswerKeyScreen';
import { SettingsScreen } from '@/screens/SettingsScreen';
import { setupPwa } from '@/lib/pwa';
import { waitForStorage } from '@/lib/storage';
import { colors } from '@/theme';
import type { RootStackParamList } from '@/navigation';

const Stack = createNativeStackNavigator<RootStackParamList>();

/** The camera is black; making the navigator black too stops the white flash
 *  between screens that would otherwise strobe on every scan. */
const navTheme = {
  ...DefaultTheme,
  colors: { ...DefaultTheme.colors, background: colors.camBg, card: colors.surface },
};

export default function App() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    // On the web this installs the manifest, the home-screen icons and the
    // service worker; on native it does nothing.
    setupPwa();

    let cancelled = false;
    void (async () => {
      // Persisted state has to land before the first render, or the camera
      // would briefly show the wrong assignment.
      await waitForStorage();
      if (!cancelled) setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!ready) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.camBg, justifyContent: 'center' }}>
        <ActivityIndicator color="#fff" />
      </View>
    );
  }

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <NavigationContainer theme={navTheme}>
        <Stack.Navigator
          initialRouteName="Camera"
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: colors.bg },
            animation: 'slide_from_right',
          }}
        >
          {/* No splash, no onboarding, no login wall: straight to the camera. */}
          <Stack.Screen name="Camera" component={CameraScreen} />
          <Stack.Screen
            name="Results"
            component={ResultsScreen}
            // Results should feel like the photo rising off the camera.
            options={{ animation: 'slide_from_bottom' }}
          />
          <Stack.Screen
            name="Summary"
            component={AssignmentSummaryScreen}
            options={{ headerShown: true, title: 'Assignment', headerBackTitle: 'Back' }}
          />
          <Stack.Screen
            name="AnswerKey"
            component={AnswerKeyScreen}
            options={{
              headerShown: true,
              title: 'Answer key',
              presentation: 'modal',
              animation: 'slide_from_bottom',
            }}
          />
          <Stack.Screen
            name="Settings"
            component={SettingsScreen}
            options={{ headerShown: true, title: 'Settings', headerBackTitle: 'Back' }}
          />
        </Stack.Navigator>
      </NavigationContainer>
    </SafeAreaProvider>
  );
}
