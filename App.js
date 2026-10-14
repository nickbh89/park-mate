import React from 'react';
import { StatusBar } from 'expo-status-bar';
import { View, ActivityIndicator, StyleSheet } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

import DisclosureScreen from './src/screens/DisclosureScreen';
import HomeScreen from './src/screens/HomeScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import OnboardingScreen from './src/screens/OnboardingScreen';
import HistoryScreen from './src/screens/HistoryScreen';
// Importing the engine also registers the background location task, which has
// to happen every time the app's JavaScript starts.
import * as engine from './src/services/engine';

const DISCLOSURE_KEY = 'parkmate:disclosureAccepted';
const ONBOARDING_KEY = 'parkmate:onboardingSeen';

export default function App() {
  const [, forceRender] = React.useReducer((n) => n + 1, 0);
  const [flagsReady, setFlagsReady] = React.useState(false);
  const [disclosureAccepted, setDisclosureAccepted] = React.useState(false);
  const [onboardingSeen, setOnboardingSeen] = React.useState(false);
  const [screen, setScreen] = React.useState('home');

  React.useEffect(() => {
    const unsubscribe = engine.subscribe(forceRender);
    engine.init();
    (async () => {
      try {
        const [accepted, seen] = await Promise.all([
          AsyncStorage.getItem(DISCLOSURE_KEY),
          AsyncStorage.getItem(ONBOARDING_KEY),
        ]);
        setDisclosureAccepted(accepted === 'true');
        setOnboardingSeen(seen === 'true');
      } finally {
        setFlagsReady(true);
      }
    })();
    return unsubscribe;
  }, []);

  const s = engine.getState();

  const onToggleMonitoring = () => (s.monitoring ? engine.stopDetection() : engine.startDetection());

  const acceptDisclosure = async () => {
    setDisclosureAccepted(true);
    try { await AsyncStorage.setItem(DISCLOSURE_KEY, 'true'); } catch {}
  };

  const finishOnboarding = async () => {
    setOnboardingSeen(true);
    try { await AsyncStorage.setItem(ONBOARDING_KEY, 'true'); } catch {}
  };

  if (!flagsReady || !s.ready) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator size="large" color="#22c55e" />
      </View>
    );
  }

  if (!disclosureAccepted) {
    return <DisclosureScreen onAccept={acceptDisclosure} onDecline={() => {}} />;
  }

  if (!onboardingSeen || screen === 'help') {
    return (
      <OnboardingScreen
        onDone={() => {
          if (!onboardingSeen) finishOnboarding();
          if (screen === 'help') setScreen('settings');
        }}
      />
    );
  }

  return (
    <View style={{ flex: 1 }}>
      <StatusBar style="light" />
      {screen === 'history' ? (
        <HistoryScreen history={s.history} onClear={engine.clearHistory} onBack={() => setScreen('settings')} />
      ) : screen === 'settings' ? (
        <SettingsScreen
          settings={s.settings}
          onChange={engine.updateSettings}
          onBack={() => setScreen('home')}
          onOpenHelp={() => setScreen('help')}
          onOpenHistory={() => setScreen('history')}
        />
      ) : (
        <HomeScreen
          monitoring={s.monitoring}
          mode={s.mode}
          session={s.session}
          sites={s.activeSites}
          lastFix={s.lastFix}
          onToggleMonitoring={onToggleMonitoring}
          onOpenSettings={() => setScreen('settings')}
          onEndSession={() => engine.endSession()}
          onSetLimit={engine.setSessionLimit}
          onNoLimit={engine.dismissSessionLimit}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  loading: { flex: 1, backgroundColor: '#0e1726', alignItems: 'center', justifyContent: 'center' },
});
