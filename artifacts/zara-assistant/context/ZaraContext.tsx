import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { zaraChat } from '@workspace/api-client-react';
import { cancelReminderNotification, scheduleReminderNotification } from '@/services/reminders';

export type ZaraLanguage = 'en' | 'hu';
export type VoiceProfile = {
  samples: number[][];
  createdAt: string;
};
export type AssistantMessage = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: string;
};
export type Conversation = {
  id: string;
  title: string;
  updatedAt: string;
  messages: AssistantMessage[];
};
export type Reminder = {
  id: string;
  title: string;
  scheduledAt: string;
  notificationId: string | null;
  createdAt: string;
};
export type ZaraSettings = {
  language: ZaraLanguage;
  voiceEnabled: boolean;
  wakeWordEnabled: boolean;
  ownerName: string | null;
  ownerVoiceProfile: VoiceProfile | null;
  voiceName: string;
  voiceSpeed: 'slow' | 'balanced' | 'fast';
  aiModel: string;
  responseStyle: 'focused' | 'warm' | 'technical';
};

type ZaraContextValue = {
  conversations: Conversation[];
  reminders: Reminder[];
  settings: ZaraSettings;
  hydrated: boolean;
  createConversation: () => Conversation;
  sendMessage: (
    conversationId: string,
    text: string,
    options?: { ownerVerified?: boolean; localResponse?: string },
  ) => Promise<string | null>;
  sendingConversationId: string | null;
  sendError: string | null;
  clearSendError: () => void;
  updateSettings: (patch: Partial<ZaraSettings>) => void;
  deleteConversation: (conversationId: string) => void;
  addReminder: (title: string, scheduledAt: Date) => Promise<boolean>;
  deleteReminder: (reminderId: string) => Promise<void>;
};

const STORAGE_KEY = '@zara/assistant-state';
const STORAGE_VERSION = 7;
const defaultSettings: ZaraSettings = {
  language: 'hu',
  voiceEnabled: true,
  wakeWordEnabled: false,
  ownerName: null,
  ownerVoiceProfile: null,
  voiceName: 'Zara',
  voiceSpeed: 'balanced',
  aiModel: 'AI connection ready',
  responseStyle: 'focused',
};

const makeId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

export function normalizeOwnerName(value: string | null | undefined): string | null {
  const normalized = value?.trim().replace(/\s+/g, ' ') ?? '';
  const parts = normalized.split(' ').filter(Boolean);
  if (parts.length < 2) return null;
  if (/\b(hello|helló|helo|hallo|szia|zara|sara|hallasz|hallod)\b/i.test(normalized)) return null;
  return normalized;
}

const ZaraContext = createContext<ZaraContextValue | null>(null);

export function ZaraProvider({ children }: { children: React.ReactNode }) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [settings, setSettings] = useState<ZaraSettings>(defaultSettings);
  const [hydrated, setHydrated] = useState(false);
  const [sendingConversationId, setSendingConversationId] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then((stored) => {
        if (!stored) return;
        const parsed = JSON.parse(stored) as {
          version?: number;
          conversations?: Conversation[];
          reminders?: Reminder[];
          settings?: ZaraSettings;
        };
        setConversations(parsed.conversations ?? []);
        setReminders(parsed.reminders ?? []);
        const restoredSettings = { ...defaultSettings, ...(parsed.settings ?? {}) };
        setSettings({
          ...restoredSettings,
          ownerName: normalizeOwnerName(restoredSettings.ownerName),
          ownerVoiceProfile: restoredSettings.ownerVoiceProfile ?? null,
          language: 'hu',
          wakeWordEnabled: false,
        });
      })
      .catch(() => undefined)
      .finally(() => setHydrated(true));
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    AsyncStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: STORAGE_VERSION, conversations, reminders, settings }),
    ).catch(() => undefined);
  }, [conversations, hydrated, reminders, settings]);

  const createConversation = () => {
    const now = new Date().toISOString();
    const conversation: Conversation = {
      id: makeId(),
      title: settings.language === 'hu' ? 'Új beszélgetés' : 'New conversation',
      updatedAt: now,
      messages: [],
    };
    setConversations((current) => [conversation, ...current]);
    return conversation;
  };

  const sendMessage = async (
    conversationId: string,
    text: string,
    options: { ownerVerified?: boolean; localResponse?: string } = {},
  ) => {
    const cleanText = text.trim();
    if (!cleanText) return null;
    const now = new Date().toISOString();
    const userMessage: AssistantMessage = {
      id: makeId(),
      role: 'user',
      text: cleanText,
      createdAt: now,
    };
    const existingConversation = conversations.find((conversation) => conversation.id === conversationId);
    const requestMessages = [
      ...(existingConversation?.messages ?? []),
      userMessage,
    ]
      .slice(-40)
      .map((message) => ({ role: message.role, content: message.text }));

    setSendError(null);
    setSendingConversationId(conversationId);
    setConversations((current) => {
      const matchingConversation = current.find((conversation) => conversation.id === conversationId);
      if (!matchingConversation) {
        return [
          {
            id: conversationId,
            title: cleanText.slice(0, 36),
            updatedAt: now,
            messages: [userMessage],
          },
          ...current,
        ];
      }
      return current.map((conversation) =>
        conversation.id === conversationId
          ? {
              ...conversation,
              title: conversation.messages.length === 0 ? cleanText.slice(0, 36) : conversation.title,
              updatedAt: now,
              messages: [...conversation.messages, userMessage],
            }
          : conversation,
      );
    });

    try {
      if (options.localResponse) {
        const assistantMessage: AssistantMessage = {
          id: makeId(),
          role: 'assistant',
          text: options.localResponse,
          createdAt: new Date().toISOString(),
        };
        setConversations((current) =>
          current.map((conversation) =>
            conversation.id === conversationId
              ? {
                  ...conversation,
                  updatedAt: assistantMessage.createdAt,
                  messages: [...conversation.messages, assistantMessage],
                }
              : conversation,
          ),
        );
        return options.localResponse;
      }
      const response = await zaraChat({
        messages: requestMessages,
        language: 'hu',
        responseStyle: settings.responseStyle,
        ownerName: options.ownerVerified ? settings.ownerName ?? undefined : undefined,
        ownerVerified: options.ownerVerified === true,
      });
      const assistantMessage: AssistantMessage = {
        id: makeId(),
        role: 'assistant',
        text: response.message,
        createdAt: new Date().toISOString(),
      };
      setConversations((current) =>
        current.map((conversation) =>
          conversation.id === conversationId
            ? {
                ...conversation,
                updatedAt: assistantMessage.createdAt,
                messages: [...conversation.messages, assistantMessage],
              }
            : conversation,
        ),
      );
      return response.message;
    } catch (error) {
      setSendError(error instanceof Error ? error.message : 'Zara could not complete that request.');
      return null;
    } finally {
      setSendingConversationId(null);
    }
  };

  const value = useMemo(
    () => ({
      conversations,
      reminders,
      settings,
      hydrated,
      createConversation,
      sendMessage,
      sendingConversationId,
      sendError,
      clearSendError: () => setSendError(null),
      updateSettings: (patch: Partial<ZaraSettings>) =>
        setSettings((current) => ({ ...current, ...patch, language: 'hu' })),
      deleteConversation: (conversationId: string) =>
        setConversations((current) =>
          current.filter((conversation) => conversation.id !== conversationId),
        ),
      addReminder: async (title: string, scheduledAt: Date) => {
        const cleanTitle = title.trim();
        if (!cleanTitle) return false;
        const notificationId = await scheduleReminderNotification(cleanTitle, scheduledAt);
        const reminder: Reminder = {
          id: makeId(),
          title: cleanTitle,
          scheduledAt: scheduledAt.toISOString(),
          notificationId,
          createdAt: new Date().toISOString(),
        };
        setReminders((current) => [...current, reminder]);
        return true;
      },
      deleteReminder: async (reminderId: string) => {
        const reminder = reminders.find((item) => item.id === reminderId);
        if (reminder) await cancelReminderNotification(reminder.notificationId);
        setReminders((current) => current.filter((item) => item.id !== reminderId));
      },
    }),
    [conversations, hydrated, reminders, sendError, sendingConversationId, settings],
  );

  return <ZaraContext.Provider value={value}>{children}</ZaraContext.Provider>;
}

export function useZara() {
  const context = useContext(ZaraContext);
  if (!context) throw new Error('useZara must be used inside ZaraProvider');
  return context;
}