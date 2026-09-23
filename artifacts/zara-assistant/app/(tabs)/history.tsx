import { Feather } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { Screen } from '@/components/Screen';
import { useZara, type Conversation } from '@/context/ZaraContext';
import { useColors } from '@/hooks/useColors';

export default function HistoryScreen() {
  const colors = useColors();
  const router = useRouter();
  const { conversations, deleteConversation, settings } = useZara();

  return (
    <Screen>
      <View style={styles.header}>
        <View>
          <Text style={[styles.eyebrow, { color: colors.primary }]}>ZARA / ARCHIVE</Text>
          <Text style={[styles.title, { color: colors.foreground }]}>
            {settings.language === 'hu' ? 'Előzmények' : 'Conversation history'}
          </Text>
        </View>
        <View style={[styles.count, { backgroundColor: colors.secondary }]}>
          <Text style={[styles.countText, { color: colors.primary }]}>{conversations.length}</Text>
        </View>
      </View>
      <FlatList
        data={conversations}
        keyExtractor={(item) => item.id}
        contentContainerStyle={conversations.length ? styles.list : styles.emptyList}
        showsVerticalScrollIndicator={false}
        scrollEnabled={conversations.length > 0}
        ListEmptyComponent={
          <View style={styles.empty}>
            <View style={[styles.emptyIcon, { borderColor: colors.border, backgroundColor: colors.card }]}>
              <Feather name="clock" size={22} color={colors.primary} />
            </View>
            <Text style={[styles.emptyTitle, { color: colors.foreground }]}>
              {settings.language === 'hu' ? 'Még nincs előzmény' : 'No conversations yet'}
            </Text>
            <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
              {settings.language === 'hu'
                ? 'A Zara-val folytatott beszélgetéseid itt jelennek majd meg.'
                : 'Your conversations with Zara will appear here.'}
            </Text>
          </View>
        }
        renderItem={({ item }) => (
          <ConversationRow
            conversation={item}
            colors={colors}
            onPress={() => router.push(`/history/${item.id}`)}
            onDelete={() => deleteConversation(item.id)}
          />
        )}
      />
    </Screen>
  );
}

function ConversationRow({
  conversation,
  colors,
  onPress,
  onDelete,
}: {
  conversation: Conversation;
  colors: ReturnType<typeof useColors>;
  onPress: () => void;
  onDelete: () => void;
}) {
  const lastMessage = conversation.messages[conversation.messages.length - 1];
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        { backgroundColor: colors.card, borderColor: colors.border, opacity: pressed ? 0.72 : 1 },
      ]}
    >
      <View style={[styles.rowIcon, { backgroundColor: colors.secondary }]}>
        <Feather name="message-circle" size={17} color={colors.primary} />
      </View>
      <View style={styles.rowCopy}>
        <Text style={[styles.rowTitle, { color: colors.foreground }]} numberOfLines={1}>{conversation.title}</Text>
        <Text style={[styles.rowPreview, { color: colors.mutedForeground }]} numberOfLines={1}>
          {lastMessage?.text ?? 'Empty conversation'}
        </Text>
      </View>
      <Pressable
        accessibilityLabel={`Delete ${conversation.title}`}
        onPress={onDelete}
        hitSlop={12}
        style={styles.deleteButton}
      >
        <Feather name="trash-2" size={16} color={colors.mutedForeground} />
      </Pressable>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: 22, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', paddingBottom: 22 },
  eyebrow: { fontSize: 11, fontWeight: '700', letterSpacing: 2.2 },
  title: { fontSize: 27, fontWeight: '700', marginTop: 7, letterSpacing: -0.5 },
  count: { minWidth: 36, height: 30, paddingHorizontal: 10, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  countText: { fontSize: 13, fontWeight: '700' },
  list: { paddingHorizontal: 22, gap: 10, paddingBottom: 24 },
  emptyList: { flexGrow: 1, paddingHorizontal: 34, justifyContent: 'center' },
  empty: { alignItems: 'center', marginTop: -60 },
  emptyIcon: { width: 64, height: 64, borderRadius: 22, borderWidth: 1, alignItems: 'center', justifyContent: 'center', marginBottom: 16 },
  emptyTitle: { fontSize: 19, fontWeight: '700' },
  emptyText: { textAlign: 'center', fontSize: 13, lineHeight: 20, marginTop: 7 },
  row: { minHeight: 78, borderWidth: 1, borderRadius: 17, padding: 13, flexDirection: 'row', alignItems: 'center', gap: 12 },
  rowIcon: { width: 42, height: 42, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  rowCopy: { flex: 1 },
  rowTitle: { fontSize: 14, fontWeight: '700', marginBottom: 6 },
  rowPreview: { fontSize: 12 },
  deleteButton: { padding: 6 },
});