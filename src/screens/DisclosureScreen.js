// Prominent disclosure BEFORE any system location permission prompt.
// Google Play requires this flow to be visible for ACCESS_BACKGROUND_LOCATION
// (and it must appear in the Play Console demo video).
import React from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from 'react-native';

export default function DisclosureScreen({ onAccept, onDecline }) {
  return (
    <ScrollView style={styles.wrap} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Location disclosure</Text>
      <Text style={styles.body}>
        ParkMate collects location data to detect when you enter a privately
        enforced car park and to alert you before your free or paid parking
        time runs out — even when the app is closed or not in use.
      </Text>
      <Text style={styles.body}>
        Your location is processed on your device only. It is never sold,
        shared, or sent to a server. You can turn detection off at any time
        in Settings.
      </Text>
      <TouchableOpacity style={styles.accept} onPress={onAccept}>
        <Text style={styles.acceptText}>I understand — continue</Text>
      </TouchableOpacity>
      <TouchableOpacity style={styles.decline} onPress={onDecline}>
        <Text style={styles.declineText}>Not now</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: '#0e1726' },
  content: { padding: 24, paddingTop: 80 },
  title: { fontSize: 26, fontWeight: '700', color: '#fff', marginBottom: 16 },
  body: { fontSize: 16, lineHeight: 24, color: '#cbd5e1', marginBottom: 14 },
  accept: { backgroundColor: '#22c55e', borderRadius: 12, padding: 16, marginTop: 24, alignItems: 'center' },
  acceptText: { color: '#052e16', fontWeight: '700', fontSize: 16 },
  decline: { padding: 16, alignItems: 'center' },
  declineText: { color: '#94a3b8', fontSize: 15 },
});
