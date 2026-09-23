import * as Location from 'expo-location';
import { ApiError, zaraWeather } from '@workspace/api-client-react';

export type WeatherRequest = {
  query: string;
  useCurrentLocation: boolean;
};

export type WeatherResponse = {
  displayText: string;
  spokenText: string;
};

function normalizeWeatherText(value: string): string {
  return value
    .toLocaleLowerCase('hu-HU')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const weatherFillerWords = new Set([
  'milyen',
  'mi',
  'mondd',
  'meg',
  'mutasd',
  'nezd',
  'kerlek',
  'hogy',
  'szia',
  'hello',
  'helo',
  'hallo',
  'zara',
  'es',
  'de',
  'is',
  'akkor',
  'na',
  'hat',
  'ugye',
  'az',
  'a',
  'ido',
  'van',
  'lesz',
  'volna',
  'lenne',
  'lehet',
  'varhato',
  'varhatoan',
  'holnap',
  'most',
  'ma',
  'jelenleg',
  'nap',
  'folyaman',
  'soran',
  'napon',
  'napra',
]);

function isWeatherFillerWord(word: string): boolean {
  const normalized = normalizeWeatherText(word);
  if (weatherFillerWords.has(normalized)) return true;
  // Keep speech-recognition variants such as "holnapur" out of the place
  // phrase without maintaining a list of transcription mistakes.
  if (/^holnap\p{L}*$/u.test(normalized)) return true;
  return /^(?:idojaras|homerseklet|hofok|eso|szel)\p{L}*$/u.test(normalized);
}

function weatherQuerySegment(value: string): string {
  const segments = value
    .split(/[?!.,;:]+/)
    .map((segment) => segment.trim())
    .filter(Boolean);
  return segments.find((segment) => isWeatherIntent(segment)) ?? segments[0] ?? value;
}

function canonicalizePlaceToken(token: string): string {
  const normalized = normalizeWeatherText(token);
  if (new Set(['budakeszi', 'budakeszit', 'budakeszin']).has(normalized)) {
    return 'Budakeszi';
  }
  if (/esten$/iu.test(token) && token.length > 5) {
    return token.slice(0, -2);
  }
  if (/(?:ban|ben)$/iu.test(token) && token.length > 4) {
    return token.slice(0, -3);
  }
  return token;
}

export function cleanWeatherQuery(value: string): string {
  const source = weatherQuerySegment(value);
  const tokens = source
    .replace(/[?!.,;:()[\]{}"']/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const cleaned = tokens.filter((token) => !isWeatherFillerWord(token));
  const deduplicated = cleaned.filter(
    (token, index) =>
      index === 0 ||
      normalizeWeatherText(token) !== normalizeWeatherText(cleaned[index - 1] ?? ''),
  );
  const location = deduplicated.length > 0
    ? deduplicated
        .map((token, index) =>
          index === deduplicated.length - 1 ? canonicalizePlaceToken(token) : token,
        )
        .join(' ')
        .trim()
    : '';
  const hasTomorrow = normalizeWeatherText(value)
    .split(' ')
    .some((word) => /^holnap\p{L}*$/u.test(word));
  return [location, hasTomorrow ? 'holnap' : ''].filter(Boolean).join(' ');
}

const hungarianNumberWords = [
  'nulla',
  'egy',
  'két',
  'három',
  'négy',
  'öt',
  'hat',
  'hét',
  'nyolc',
  'kilenc',
];

function hungarianInteger(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  const integer = Math.abs(Math.trunc(value));
  if (integer < 10) return hungarianNumberWords[integer] ?? String(integer);
  if (integer < 20) {
    return integer === 10
      ? 'tíz'
      : `tizen${hungarianNumberWords[integer - 10] ?? integer - 10}`;
  }
  if (integer < 30) {
    return integer === 20
      ? 'húsz'
      : `huszon${hungarianNumberWords[integer - 20] ?? integer - 20}`;
  }
  if (integer < 100) {
    const tens = [
      '',
      '',
      '',
      'harminc',
      'negyven',
      'ötven',
      'hatvan',
      'hetven',
      'nyolcvan',
      'kilencven',
    ][Math.floor(integer / 10)];
    return `${tens}${integer % 10 ? hungarianNumberWords[integer % 10] : ''}`;
  }
  if (integer < 1000) {
    const hundreds = Math.floor(integer / 100);
    const prefix = hundreds === 1 ? 'száz' : `${hungarianNumberWords[hundreds]}száz`;
    return `${prefix}${integer % 100 ? hungarianInteger(integer % 100) : ''}`;
  }
  if (integer < 10000) {
    const thousands = Math.floor(integer / 1000);
    const prefix = thousands === 1 ? 'ezer' : `${hungarianNumberWords[thousands]}ezer`;
    return `${prefix}${integer % 1000 ? hungarianInteger(integer % 1000) : ''}`;
  }
  return String(integer);
}

function hungarianNumber(value: string): string {
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [integerPart, decimalPart] = unsigned.split(',');
  const integer = hungarianInteger(Number(integerPart));
  if (!decimalPart) return `${negative ? 'mínusz ' : ''}${integer}`;

  const decimalDigits = [...decimalPart]
    .map((digit) => hungarianNumberWords[Number(digit)] ?? digit)
    .join(' ');
  return `${negative ? 'mínusz ' : ''}${integer} egész ${decimalDigits} tized`;
}

export function weatherTextForSpeech(value: string): string {
  return value.replace(/-?\d+(?:,\d+)?/g, (number) => hungarianNumber(number));
}

const weatherIntentWords = new Set([
  'idojaras',
  'idokep',
  'homerseklet',
  'hofok',
  'elorejelzes',
  'eso',
  'szel',
]);

const weatherQuestionWords = new Set(['milyen', 'milyennek', 'mi', 'hogyan', 'hogy']);

function isWeatherIntentWord(word: string): boolean {
  if (weatherIntentWords.has(word)) return true;
  return /^(?:idojaras|idokep|homerseklet|hofok|elorejelzes|eso|szel)\p{L}*$/u.test(word);
}

export function isWeatherIntent(value: string): boolean {
  const words = normalizeWeatherText(value).split(' ').filter(Boolean);
  if (words.some(isWeatherIntentWord)) return true;

  return words.some((word, index) => {
    if (!weatherQuestionWords.has(word)) return false;
    return words
      .slice(index + 1, index + 8)
      .some((nextWord) => nextWord === 'ido' || isWeatherIntentWord(nextWord));
  });
}

export function parseWeatherRequest(value: string): WeatherRequest | null {
  const normalized = normalizeWeatherText(value);
  if (!isWeatherIntent(normalized)) return null;

  return {
    query: cleanWeatherQuery(value),
    useCurrentLocation: /\b(?:itt|ezen a helyen|az adott helyen|jelenlegi helyemen|most ahol vagyok)\b/.test(
      normalized,
    ),
  };
}

async function getCurrentCoordinates(): Promise<{ latitude: number; longitude: number }> {
  const servicesEnabled = await Location.hasServicesEnabledAsync();
  if (!servicesEnabled) {
    throw new Error('A helymeghatározás ki van kapcsolva. Kapcsold be, vagy adj meg egy települést.');
  }

  const permission = await Location.requestForegroundPermissionsAsync();
  if (permission.status !== Location.PermissionStatus.GRANTED) {
    throw new Error(
      'A helyalapú időjáráshoz engedélyezned kell a helymeghatározást, vagy adj meg egy települést.',
    );
  }

  const position = await Location.getCurrentPositionAsync({
    accuracy: Location.Accuracy.Balanced,
  });
  return {
    latitude: position.coords.latitude,
    longitude: position.coords.longitude,
  };
}

function weatherErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.startsWith('A hely')) {
    return error.message;
  }
  if (error instanceof Error && error.message.startsWith('A helyalapú')) {
    return error.message;
  }
  if (error instanceof ApiError) {
    const responseMessage =
      error.data && typeof error.data === 'object' && 'message' in error.data &&
      typeof error.data.message === 'string'
        ? error.data.message
        : null;
    console.warn('[Zara weather] API request failed', {
      status: error.status,
      statusText: error.statusText,
      url: error.url,
      response: error.data,
    });
    return responseMessage
      ? `Az időjárás API hibát adott (HTTP ${error.status}): ${responseMessage}`
      : `Az időjárás API hibát adott (HTTP ${error.status}). A fejlesztői naplóban látható a pontos válasz.`;
  }
  const networkMessage = error instanceof Error ? error.message : String(error);
  console.warn('[Zara weather] request could not reach the API', {
    message: networkMessage,
  });
  return `Nem sikerült elérni a Zara időjárás API-ját: ${networkMessage}`;
}

export async function getWeatherResponse(request: WeatherRequest): Promise<WeatherResponse> {
  try {
    const coordinates = request.useCurrentLocation ? await getCurrentCoordinates() : undefined;
    console.info(
      '[Zara weather trace] 4 API request query',
      JSON.stringify(request.query),
    );
    const response = await zaraWeather({
      query: request.query,
      ...(coordinates ?? {}),
    });
    return {
      displayText: response.message,
      spokenText: weatherTextForSpeech(response.message),
    };
  } catch (error) {
    const message = weatherErrorMessage(error);
    return { displayText: message, spokenText: message };
  }
}