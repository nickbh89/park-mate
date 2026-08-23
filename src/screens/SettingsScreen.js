import React from 'react';
import { View, Text, StyleSheet, Switch, TouchableOpacity, ScrollView, Linking } from 'react-native';

export const KOFI_URL = 'https://ko-fi.com/nickbradshawhughes';

const LEAD_OPTIONS = [10, 15, 20, 30];

export default function SettingsScreen({ settings, onChange, onBack }) {
  return (
    <ScrollView style={styles.wrap} contentContainerStyle={{ padding: 20, paddingTop: 60 }}>
      <TouchableOpacity onPress={onBack}><Text style={styles.back}>‹ Back</Text></TouchableOpacity>
      <Text style={styles.title}>Settings</Text>

      <View style={styles.row}>
        <View style={{ flex: 1 }}>
          <Text style={styles.label}>Background detection</Text>
          <Text style={styles.sub}>Detect car parks while the app is closed</Text>
        </View>
        <Switch
          value={settings.backgroundEnabled}
          onValueChange={(v) => onChange({ ...settings, backgroundEnabled: v })}
        />
      </View>

      <Text style={styles.label}>Warn me before my time runs out</Text>
      <View style={styles.leadRow}>
        {LEAD_OPTIONS.map((m) => (
          <TouchableOpacity
            key={m}
            style={[styles.leadBtn, settings.alertLeadMinutes === m && styles.leadBtnActive]}
            onPress={() => onChange({ ...settings, alertLeadMinutes: m })}
          >
            <Text style={[styles.leadText, settings.alertLeadMinutes === m && styles.leadTextActive]}>{m} min</Text>
          </TouchableOpacity>
        ))}
      </View>

      <View style={styles.row}>
        <View style={{ flex: 1 }}>
          <Text style={styles.label}>Include unverified sites</Text>
          <Text style={styles.sub}>Seed sites not yet field-checked against signage</Text>
        </View>
        <Switch
          value={settings.includeUnverified}
          onValueChange={(v) => onChange({ ...settings, includeUnverified: v })}
        />
      </View>

      <TouchableOpacity
        style={styles.tipBtn}
        onPress={() => Linking.openURL(KOFI_URL).catch(() => {})}
      >
        <Text style={styles.tipTitle}>☕ Enjoying ParkMate?</Text>
        <Text style={styles.tipSub}>Leave a tip on Ko-fi to support development</Text>
      </TouchableOpacity>

      <Text style={styles.footer}>
        ParkMate alerts are reminders, not legal advice. The signage at each
        site is the binding record of its terms — always check it. Site data
        is community-maintained and may be out of date.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: '#0e1726' },
  back: { color: '#93c5fd', fontSize: 17, marginBottom: 12 },
  title: { fontSize: 26, fontWeight: '800', color: '#fff', marginBottom: 24 },
  row: { flexDirection: 'row', alignItems: 'center', marginBottom: 28 },
  label: { color: '#e2e8f0', fontSize: 16, fontWeight: '600' },
  sub: { color: '#64748b', fontSize: 13, marginTop: 3 },
  leadRow: { flexDirection: 'row', gap: 10, marginTop: 12, marginBottom: 28 },
  leadBtn: { borderRadius: 10, paddingVertical: 10, paddingHorizontal: 16, backgroundColor: '#16233a' },
  leadBtnActive: { backgroundColor: '#22c55e' },
  leadText: { color: '#94a3b8', fontWeight: '600' },
  leadTextActive: { color: '#052e16' },
  tipBtn: { backgroundColor: '#16233a', borderRadius: 12, padding: 16, marginTop: 4 },
  tipTitle: { color: '#e2e8f0', fontSize: 16, fontWeight: '700' },
  tipSub: { color: '#94a3b8', fontSize: 13, marginTop: 4 },
  footer: { color: '#475569', fontSize: 12, lineHeight: 18, marginTop: 20 },
});
