import React from 'react';
import { StatusBar } from 'expo-status-bar';
import { View, ActivityIndicator, StyleSheet } from 'react-native';
import * as Location from 'expo-location';
import AsyncStorage from '@react-native-async-storage/async-storage';

import DisclosureScreen from './src/screens/DisclosureScreen';
import HomeScreen from './src/screens/HomeScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import { createDetector } from './src/services/geofence';
import { planSession, cancelOnExit } from './src/services/stayTimer';
import { ensureNotificationSetup, scheduleSessionReminders, cancelReminders } from './src/services/notifications';
import { loadSites } from './src/services/siteSync';

const DISCLOSURE_KEY = 'parkmate:disclosureAccepted';
const SETTINGS_KEY = 'parkmate:settings';
const DEFAULT_SETTINGS = { backgroundEnabled: false, alertLeadMinutes: 15, includeUnverified: true };
const FIX_INTERVAL_MS = 30000;

export default function App() {
  const [ready, setReady] = React.useState(false);
  const [disclosureAccepted, setDisclosureAccepted] = React.useState(false);
  const [screen, setScreen] = React.useState('home');
  const [settings, setSettings] = React.useState(DEFAULT_SETTINGS);
  const [sites, setSites] = React.useState([]);
  const [monitoring, setMonitoring] = React.useState(false);
  const [lastFix, setLastFix] = React.useState(null);
  const [session, setSession] = React.useState(null);

  const detectorRef = React.useRef(null);
  const watchRef = React.useRef(null);
  const sessionRef = React.useRef(null);
  sessionRef.current = session;
  const settingsRef = React.useRef(settings);
  settingsRef.current = settings;

  React.useEffect(() => {
    (async () => {
      try {
        const [accepted, storedSettings, data] = await Promise.all([
          AsyncStorage.getItem(DISCLOSURE_KEY),
          AsyncStorage.getItem(SETTINGS_KEY),
          loadSites(),
        ]);
        setDisclosureAccepted(accepted === 'true');
        if (storedSettings) setSettings({ ...DEFAULT_SETTINGS, ...JSON.parse(storedSettings) });
        setSites(data.sites);
      } finally {
        setReady(true);
      }
    })();
  }, []);

  const activeSites = React.useMemo(
    () => sites.filter((s) => settings.includeUnverified || s.verified),
    [sites, settings.includeUnverified]
  );

  const handleEvents = React.useCallback(async (events) => {
    for (const ev of events) {
      if (ev.type === 'enter' && !sessionRef.current) {
        const plan = planSession(ev.site, ev.at, { alertLeadMinutes: settingsRef.current.alertLeadMinutes });
        let notifIds = [];
        try { notifIds = await scheduleSessionReminders(plan); } catch {}
        setSession({
          siteId: ev.site.id,
          siteName: ev.site.name,
          entryAt: ev.at,
          deadlineAt: plan.deadlineAt,
          hardLimitAt: plan.hardLimitAt,
          hint: plan.reminders[0]?.message,
          notifIds,
        });
      }
      if (ev.type === 'exit' && sessionRef.current?.siteId === ev.site.id) {
        await endSession(ev.at);
      }
    }
  }, []);

  const endSession = React.useCallback(async (at = Date.now()) => {
    const s = sessionRef.current;
    if (!s) return;
    try { await cancelReminders(s.notifIds); } catch {}
    setSession(null);
  }, []);

  const startMonitoring = React.useCallback(async () => {
    const fg = await Location.requestForegroundPermissionsAsync();
    if (fg.status !== 'granted') return;
    if (settingsRef.current.backgroundEnabled) {
      try { await Location.requestBackgroundPermissionsAsync(); } catch {}
    }
    await ensureNotificationSetup();
    detectorRef.current = createDetector(activeSites);
    try {
      watchRef.current = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.Balanced, timeInterval: FIX_INTERVAL_MS, distanceInterval: 25 },
        (loc) => {
          const { latitude: lat, longitude: lng } = loc.coords;
          setLastFix({ lat, lng, at: loc.timestamp });
          const events = detectorRef.current?.update(lat, lng, loc.timestamp) || [];
          if (events.length) handleEvents(events);
        }
      );
      setMonitoring(true);
    } catch {
      setMonitoring(false);
    }
  }, [activeSites, handleEvents]);

  const stopMonitoring = React.useCallback(() => {
    watchRef.current?.remove();
    watchRef.current = null;
    detectorRef.current = null;
    setMonitoring(false);
  }, []);

  const onToggleMonitoring = () => (monitoring ? stopMonitoring() : startMonitoring());

  const onChangeSettings = async (next) => {
    setSettings(next);
    try { await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(next)); } catch {}
  };

  const acceptDisclosure = async () => {
    setDisclosureAccepted(true);
    try { await AsyncStorage.setItem(DISCLOSURE_KEY, 'true'); } catch {}
  };

  if (!ready) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator size="large" color="#22c55e" />
      </View>
    );
  }

  if (!disclosureAccepted) {
    return <DisclosureScreen onAccept={acceptDisclosure} onDecline={() => {}} />;
  }

  return (
    <View style={{ flex: 1 }}>
      <StatusBar style="light" />
      {screen === 'settings' ? (
        <SettingsScreen settings={settings} onChange={onChangeSettings} onBack={() => setScreen('home')} />
      ) : (
        <HomeScreen
          monitoring={monitoring}
          session={session}
          sites={activeSites}
          lastFix={lastFix}
          onToggleMonitoring={onToggleMonitoring}
          onOpenSettings={() => setScreen('settings')}
          onEndSession={() => endSession()}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  loading: { flex: 1, backgroundColor: '#0e1726', alignItems: 'center', justifyContent: 'center' },
});
