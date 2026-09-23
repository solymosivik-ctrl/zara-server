import { Feather } from '@expo/vector-icons';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import React from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { Screen } from '@/components/Screen';
import { useZara } from '@/context/ZaraContext';
import { useColors } from '@/hooks/useColors';

export default function ConversationDetailScreen() {
  const colors = useColors();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { conversations } = useZara();
  const conversation = conversations.find((item) => item.id === id);

  if (!conversation) {
    return (
      <Screen>
        <Stack.Screen options={{ headerShown: false }} />
        <View style={styles.missing}>
          <Text style={[styles.missingTitle, { color: colors.foreground }]}>Conversation not found</Text>
          <Pressable onPress={() => router.back()} style={[styles.backButton, { backgroundColor: colors.primary }]}>
            <Text style={{ color: colors.primaryForeground, fontWeight: '700' }}>Go back</Text>
          </Pressable>
        </View>
      </Screen>
    );
  }

  return (
    <Screen>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.topbar}>
        <Pressable onPress={() => router.back()} hitSlop={12} style={styles.backIcon}>
          <Feather name="arrow-left" size={20} color={colors.foreground} />
        </Pressable>
        <View style={styles.topbarCopy}>
          <Text style={[styles.topbarLabel, { color: colors.primary }]}>ZARA / SESSION</Text>
          <Text style={[styles.topbarTitle, { color: colors.foreground }]} numberOfLines={1}>{conversation.title}</Text>
        </View>
      </View>
      <FlatList
        data={conversation.messages}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.messages}
        renderItem={({ item }) => (
          <View style={[styles.bubble, item.role === 'user' ? styles.userBubble : styles.assistantBubble, { backgroundColor: item.role === 'user' ? colors.primary : colors.card, borderColor: item.role === 'user' ? colors.primary : colors.border }]}>
            <Text style={[styles.role, { color: item.role === 'user' ? colors.primaryForeground : colors.primary }]}>
              {item.role === 'user' ? 'YOU' : 'ZARA'}
            </Text>
            <Text style={[styles.message, { color: item.role === 'user' ? colors.primaryForeground : colors.secondaryForeground }]}>{item.text}</Text>
          </View>
        )}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  topbar: { paddingHorizontal: 22, paddingBottom: 18, flexDirection: 'row', alignItems: 'center', gap: 16 },
  backIcon: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  topbarCopy: { flex: 1 },
  topbarLabel: { fontSize: 10, fontWeight: '700', letterSpacing: 1.8 },
  topbarTitle: { fontSize: 19, fontWeight: '700', marginTop: 5 },
  messages: { paddingHorizontal: 22, paddingBottom: 24, gap: 12 },
  bubble: { maxWidth: '88%', borderWidth: 1, borderRadius: 18, padding: 15 },
  userBubble: { alignSelf: 'flex-end', borderBottomRightRadius: 5 },
  assistantBubble: { alignSelf: 'flex-start', borderBottomLeftRadius: 5 },
  role: { fontSize: 9, fontWeight: '800', letterSpacing: 1.7, marginBottom: 8 },
  message: { fontSize: 14, lineHeight: 21 },
  missing: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16 },
  missingTitle: { fontSize: 18, fontWeight: '700' },
  backButton: { borderRadius: 14, paddingHorizontal: 18, paddingVertical: 12 },
});