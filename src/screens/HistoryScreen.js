// Past parking sessions, stored on this device only.
import React from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity } from 'react-native';

function fmtDate(ms) {
  const d = new Date(ms);
  const day = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `${day}, ${time}`;
}

function fmtDuration(ms) {
  const mins = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h} h ${m} min` : `${m} min`;
}

export default function HistoryScreen({ history, onClear, onBack }) {
  return (
    <View style={styles.wrap}>
      <TouchableOpacity onPress={onBack}><Text style={styles.back}>‹ Back</Text></TouchableOpacity>
      <Text style={styles.title}>Parking history</Text>
      <Text style={styles.note}>Stored on this device only. The last 30 stays are kept.</Text>

      <FlatList
        data={history}
        keyExtractor={(h) => h.id}
        ListEmptyComponent={
          <Text style={styles.empty}>No stays yet. They appear here after ParkMate detects you leaving a car park.</Text>
        }
        renderItem={({ item }) => {
          const overstayed = item.deadlineAt && item.exitAt > item.deadlineAt;
          return (
            <View style={styles.row}>
              <Text style={styles.site}>{item.siteName}</Text>
              <Text style={styles.meta}>
                {fmtDate(item.entryAt)} · stayed {fmtDuration(item.exitAt - item.entryAt)}
              </Text>
              {item.deadlineAt ? (
                <Text style={[styles.status, overstayed && styles.statusOver]}>
                  {overstayed ? 'Left after the time limit' : 'Left within the time limit'}
                </Text>
              ) : null}
            </View>
          );
        }}
      />

      {history.length > 0 ? (
        <TouchableOpacity style={styles.clear} onPress={onClear}>
          <Text style={styles.clearText}>Clear history</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: '#0e1726', padding: 20, paddingTop: 60 },
  back: { color: '#93c5fd', fontSize: 17, marginBottom: 12 },
  title: { fontSize: 26, fontWeight: '800', color: '#fff', marginBottom: 6 },
  note: { color: '#64748b', fontSize: 13, marginBottom: 16 },
  empty: { color: '#94a3b8', fontSize: 15, lineHeight: 22, marginTop: 20 },
  row: { paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#1e293b' },
  site: { color: '#e2e8f0', fontSize: 16, fontWeight: '600' },
  meta: { color: '#94a3b8', fontSize: 13, marginTop: 3 },
  status: { color: '#22c55e', fontSize: 13, marginTop: 3 },
  statusOver: { color: '#ef4444' },
  clear: { padding: 14, alignItems: 'center', marginTop: 8 },
  clearText: { color: '#f87171', fontSize: 15, fontWeight: '600' },
});
