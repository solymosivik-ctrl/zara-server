import { useEffect, useState } from 'react';
import {
  setApiDiagnosticListener,
  type ApiDiagnosticEvent,
} from '@workspace/api-client-react';

export type DiagnosticEntry =
  | {
      id: string;
      timestamp: number;
      kind: 'api';
      event: ApiDiagnosticEvent;
    }
  | {
      id: string;
      timestamp: number;
      kind: 'app';
      label: string;
      value: string;
    };

const MAX_ENTRIES = 80;
let entries: DiagnosticEntry[] = [];
const subscribers = new Set<(nextEntries: DiagnosticEntry[]) => void>();

function publish(entry: DiagnosticEntry): void {
  entries = [...entries, entry].slice(-MAX_ENTRIES);
  subscribers.forEach((subscriber) => subscriber(entries));
}

setApiDiagnosticListener((event) => {
  publish({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
    kind: 'api',
    event,
  });
});

export function recordDiagnostic(label: string, value: string): void {
  publish({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
    kind: 'app',
    label,
    value,
  });
}

export function clearDiagnostics(): void {
  entries = [];
  subscribers.forEach((subscriber) => subscriber(entries));
}

export function useApiDiagnostics(): DiagnosticEntry[] {
  const [currentEntries, setCurrentEntries] = useState<DiagnosticEntry[]>(entries);

  useEffect(() => {
    subscribers.add(setCurrentEntries);
    setCurrentEntries(entries);
    return () => {
      subscribers.delete(setCurrentEntries);
    };
  }, []);

  return currentEntries;
}

function apiLabel(endpoint: string): string {
  if (endpoint.endsWith('/transcribe')) return 'TRANSCRIBE';
  if (endpoint.endsWith('/weather')) return 'WEATHER';
  if (endpoint.endsWith('/chat')) return 'CHAT';
  return 'API';
}

function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString('hu-HU', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function diagnosticLines(entry: DiagnosticEntry): string[] {
  const time = formatTimestamp(entry.timestamp);
  if (entry.kind === 'app') {
    return [`[${time}] ${entry.label}: ${entry.value}`];
  }

  const { event } = entry;
  const label = apiLabel(event.endpoint);
  const lines = [
    `[${time}] ${label} ${event.phase.toUpperCase()}`,
    `HTTP METHOD: ${event.method}`,
    `${label} URL: ${event.url}`,
    `ENDPOINT: ${event.endpoint}`,
  ];

  if (event.phase === 'before') {
    lines.push(`REQUEST BODY: ${event.requestBody ?? '(none)'}`);
  } else {
    lines.push(`${label} STATUS: ${event.status ?? '(no response)'}`);
    lines.push(`${label} CONTENT-TYPE: ${event.responseContentType ?? '(none)'}`);
    if (event.phase === 'error') {
      lines.push(`RESPONSE BODY FIRST 300 CHARACTERS: ${event.responsePreview ?? '(empty)'}`);
    }
  }

  return lines;
}