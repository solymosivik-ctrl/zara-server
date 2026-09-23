import type { AssistantMessage, ZaraSettings } from '@/context/ZaraContext';

export type AssistantRequest = {
  conversationId: string;
  messages: AssistantMessage[];
  settings: ZaraSettings;
};

export type AssistantResponse = { text: string };

/**
 * Provider boundary for the server-backed AI integration.
 * The API key stays on the server; this module only models the request shape.
 */
export function toAssistantRequest(
  conversationId: string,
  messages: AssistantMessage[],
  settings: ZaraSettings,
): AssistantRequest {
  return { conversationId, messages, settings };
}