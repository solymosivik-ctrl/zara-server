import { Router, type IRouter, type Request } from "express";
import { ReplitConnectors } from "@replit/connectors-sdk";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const router: IRouter = Router();
const connectors = new ReplitConnectors();

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

type ZaraChatRequest = {
  messages?: ChatMessage[];
  language?: "en" | "hu";
  responseStyle?: "focused" | "warm" | "technical";
  ownerName?: string;
  ownerVerified?: boolean;
};

type ZaraTranscribeRequest = {
  audioBase64?: string;
  mimeType?: string;
  language?: "en" | "hu";
};

type ZaraSpeakRequest = {
  text?: string;
  language?: "en" | "hu";
};

type ZaraWeatherRequest = {
  query?: string;
  latitude?: number;
  longitude?: number;
};

type WeatherReport = {
  message: string;
  location: string;
  latitude: number;
  longitude: number;
  temperatureC: number;
  condition: string;
  windSpeedKmh: number;
  todayHighC?: number;
  todayLowC?: number;
  precipitationProbability?: number;
};

type OpenAIResponse = {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
  error?: {
    message?: string;
  };
};

const conversationHistory: ChatMessage[] = [];
const MAX_HISTORY_MESSAGES = 12;

function normalizeZaraText(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[?!.,;:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function providerErrorMessage(status: number): string {
  if (status === 401 || status === 403) {
    return "The AI provider rejected the configured API key. Update OPENAI_API_KEY in Replit Secrets.";
  }
  if (status === 429) {
    return "The AI provider is rate-limited right now. Please try again in a moment.";
  }
  return "The AI provider could not complete this request. Please try again in a moment.";
}

function getRequestBody(req: Request): ZaraChatRequest {
  return req.body as ZaraChatRequest;
}

type WeatherLocation = {
  name: string;
  label?: string;
  latitude: number;
  longitude: number;
};

type OpenMeteoForecast = {
  current?: {
    temperature_2m?: number;
    weather_code?: number;
    wind_speed_10m?: number;
  };
  daily?: {
    temperature_2m_max?: number[];
    temperature_2m_min?: number[];
    weather_code?: number[];
    wind_speed_10m_max?: number[];
    precipitation_probability_max?: number[];
  };
};

type OpenMeteoGeocoding = {
  results?: Array<{
    name?: string;
    latitude?: number;
    longitude?: number;
    country_code?: string;
    country?: string;
    admin1?: string;
  }>;
};

class WeatherProviderError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly providerMessage: string,
    readonly safeUrl: string,
  ) {
    super(message);
    this.name = "WeatherProviderError";
  }
}

function weatherCondition(code: number): string {
  if (code === 0) return "derült lesz az ég";
  if ([1, 2, 3].includes(code)) return "részben felhős lesz az ég";
  if ([45, 48].includes(code)) return "ködös idő várható";
  if ([51, 53, 55, 56, 57].includes(code)) return "gyenge eső várható";
  if ([61, 63, 65, 66, 67].includes(code)) return "esős idő várható";
  if ([80, 81, 82].includes(code)) return "zápor várható";
  if ([71, 73, 75, 77, 85, 86].includes(code)) return "havas idő várható";
  if ([95, 96, 99].includes(code)) return "zivatar várható";
  return "változó időjárás";
}

function weatherPlaceLabel(name: string): string {
  const placeName = name.split(",")[0].trim();
  if (placeName === "a jelenlegi tartózkodási helyed") {
    return "A jelenlegi helyeden";
  }
  return placeName;
}

function extractWeatherPlace(query: string): string | null {
  let place = query
    .replace(/[?!.,;:]+/g, " ")
    .replace(/(?<![\p{L}\p{N}])holnap[\p{L}\p{N}]*/giu, " ")
    .replace(
      /(?<![\p{L}\p{N}])(?:milyen|milyen az|mi(?:lyen)?|nézd meg|nézd|mutasd meg|mondd meg|kérlek|kérlek szépen|hogy|az időjárás|az időjárást|időjárás|időjárást|időjárási|idő|ido|hőmérséklet|homerseklet|hőfok|hofok|fok|eső|szél|van|lesz|várható|holnap|most|ma|jelenleg|hány|hany|mennyi|ott|itt|az adott helyen|ezen a helyen|a nap folyamán|a|az|nap|folyamán|folyaman|során|soran|napon|napra|nál|nálam)(?![\p{L}\p{N}])/giu,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();

  if (!place || place.length < 2) {
    place = "Budapest";
  }

  return place;
}

function weatherPlaceCandidates(place: string): string[] {
  const candidates = new Set<string>([place]);
  const words = place.split(/\s+/);
  const lastWord = words.at(-1);
  if (!lastWord) return [...candidates];

  // Open-Meteo geocoding expects the dictionary form. Try the original
  // phrase first, then remove Hungarian case endings from the last word.
  // The suffixes are linguistic patterns, not a list of cities, so the same
  // logic works for Hungarian and foreign place names alike.
  const caseEndings = [
    "nál",
    "nél",
    "ból",
    "ből",
    "ról",
    "ről",
    "tól",
    "től",
    "hoz",
    "hez",
    "höz",
    "ban",
    "ben",
    "on",
    "en",
    "ön",
    "in",
    "ra",
    "re",
  ];
  for (const ending of caseEndings) {
    if (lastWord.length <= ending.length + 1 || !lastWord.endsWith(ending)) {
      continue;
    }
    const stem = lastWord.slice(0, -ending.length);
    candidates.add([...words.slice(0, -1), stem].join(" "));
  }
  return [...candidates];
}

async function fetchOpenMeteo<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const responseText = await response.text();
    const safeUrl = new URL(url);
    safeUrl.searchParams.delete("apikey");
    let payload: unknown = responseText;
    try {
      payload = responseText ? JSON.parse(responseText) : null;
    } catch {
      // Keep the raw provider body in the diagnostic message.
    }
    if (!response.ok) {
      const providerMessage =
        payload && typeof payload === "object" && "reason" in payload &&
        typeof payload.reason === "string"
          ? payload.reason
          : responseText.slice(0, 500);
      throw new WeatherProviderError(
        `Open-Meteo HTTP ${response.status} ${response.statusText}: ${providerMessage}`,
        response.status,
        providerMessage,
        safeUrl.toString(),
      );
    }
    if (payload === null || typeof payload !== "object") {
      throw new WeatherProviderError(
        "Open-Meteo returned an invalid JSON response.",
        response.status,
        responseText.slice(0, 500),
        safeUrl.toString(),
      );
    }
    return payload as T;
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveWeatherLocation(body: ZaraWeatherRequest): Promise<WeatherLocation> {
  const hasLatitude = typeof body.latitude === "number";
  const hasLongitude = typeof body.longitude === "number";
  if (hasLatitude !== hasLongitude) {
    throw new Error("A hely koordinátáihoz szélesség és hosszúság is szükséges.");
  }
  if (hasLatitude && hasLongitude) {
    if (
      !Number.isFinite(body.latitude) ||
      !Number.isFinite(body.longitude) ||
      body.latitude! < -90 ||
      body.latitude! > 90 ||
      body.longitude! < -180 ||
      body.longitude! > 180
    ) {
      throw new Error("Érvénytelen helykoordinátákat kaptam.");
    }
    return {
      name: "a jelenlegi tartózkodási helyed",
      latitude: body.latitude!,
      longitude: body.longitude!,
    };
  }

  const query = body.query?.trim();
  const place = query ? extractWeatherPlace(query) : null;
  if (!place) {
    throw new Error(
      "Nem találtam településnevet a kérésben. Mondd például: Milyen idő van Budapesten?",
    );
  }

  const candidates = weatherPlaceCandidates(place);
  for (const candidate of candidates) {
    const geocodingUrl = new URL("https://geocoding-api.open-meteo.com/v1/search");
    geocodingUrl.searchParams.set("name", candidate);
    geocodingUrl.searchParams.set("count", "5");
    geocodingUrl.searchParams.set("language", "hu");
    geocodingUrl.searchParams.set("format", "json");
    const apiKey = process.env["OPEN_METEO_API_KEY"]?.trim();
    if (apiKey) geocodingUrl.searchParams.set("apikey", apiKey);
    const geocoding = await fetchOpenMeteo<OpenMeteoGeocoding>(
      geocodingUrl.toString(),
    );
    const result =
      geocoding.results?.find(
        (item) =>
          typeof item.name === "string" &&
          normalizePlaceName(item.name) === normalizePlaceName(candidate),
      ) ??
      geocoding.results?.find((item) => item.country_code === "HU") ??
      geocoding.results?.[0];
    if (
      result &&
      typeof result.name === "string" &&
      typeof result.latitude === "number" &&
      typeof result.longitude === "number"
    ) {
      return {
        name: [result.name, result.admin1 !== result.name ? result.admin1 : undefined, result.country]
          .filter(Boolean)
          .join(", "),
        label: place,
        latitude: result.latitude,
        longitude: result.longitude,
      };
    }
  }

  throw new Error(`Nem találtam helyet ehhez: ${place}.`);
}

function normalizeWeatherQuery(value: string): string {
  return value
    .toLocaleLowerCase("hu-HU")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizePlaceName(value: string): string {
  return value
    .toLocaleLowerCase("hu-HU")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function isWeatherQuestion(value: string): boolean {
  const normalized = normalizeWeatherQuery(value);
  return (
    /\b(?:idojaras|idokep|homerseklet|hofok|elorejelzes|szel)\b/.test(normalized) ||
    /\b(?:milyen|mi(?:lyen)?)\b(?:\s+\p{L}+){0,3}\s+\bido\b/u.test(normalized)
  );
}

function isTomorrowWeatherQuestion(value: string): boolean {
  const normalized = normalizeWeatherQuery(value);
  return /(?:^|\s)holnap[\p{L}]*(?=\s|$)/u.test(normalized);
}

async function getWeatherReport(body: ZaraWeatherRequest): Promise<WeatherReport> {
  const location = await resolveWeatherLocation(body);
  const tomorrow = isTomorrowWeatherQuestion(body.query ?? "");
  const forecastUrl = new URL("https://api.open-meteo.com/v1/forecast");
  forecastUrl.searchParams.set("latitude", String(location.latitude));
  forecastUrl.searchParams.set("longitude", String(location.longitude));
  forecastUrl.searchParams.set(
    "current",
    "temperature_2m,weather_code,wind_speed_10m",
  );
  forecastUrl.searchParams.set(
    "daily",
    "temperature_2m_max,temperature_2m_min,weather_code,wind_speed_10m_max,precipitation_probability_max",
  );
  forecastUrl.searchParams.set("forecast_days", tomorrow ? "2" : "1");
  forecastUrl.searchParams.set("timezone", "auto");
  const apiKey = process.env["OPEN_METEO_API_KEY"]?.trim();
  if (apiKey) forecastUrl.searchParams.set("apikey", apiKey);
  const forecast = await fetchOpenMeteo<OpenMeteoForecast>(forecastUrl.toString());
  const current = forecast.current;
  const daily = forecast.daily;
  if (
    !current ||
    typeof current.temperature_2m !== "number" ||
    typeof current.weather_code !== "number" ||
    typeof current.wind_speed_10m !== "number"
  ) {
    throw new Error("Az időjárási szolgáltatás hiányos adatot adott vissza.");
  }

  const forecastDayIndex = tomorrow ? 1 : 0;
  const condition = weatherCondition(
    daily?.weather_code?.[forecastDayIndex] ?? current.weather_code,
  );
  const forecastHigh = daily?.temperature_2m_max?.[forecastDayIndex];
  const forecastLow = daily?.temperature_2m_min?.[forecastDayIndex];
  const precipitationProbability =
    daily?.precipitation_probability_max?.[forecastDayIndex];
  const forecastWindSpeed =
    daily?.wind_speed_10m_max?.[forecastDayIndex] ?? current.wind_speed_10m;
  const formatTemperature = (value: number) =>
    `${value.toLocaleString("hu-HU", { maximumFractionDigits: 1 })} fok`;
  const formatWindSpeed = (value: number) =>
    `${Math.round(value)} kilométer/óra`;
  const formatPrecipitationProbability = (value: number) =>
    `${Math.round(value)} százalék`;
  const dailyDetails: string[] = [];
  if (typeof forecastHigh === "number" && typeof forecastLow === "number") {
    dailyDetails.push(
      `${tomorrow ? "Holnap" : "Ma"} ${formatTemperature(forecastLow)} és ${formatTemperature(forecastHigh)} között várható a hőmérséklet`,
    );
  }
  if (typeof precipitationProbability === "number") {
    dailyDetails.push(
      `az eső esélye ${formatPrecipitationProbability(precipitationProbability)}`,
    );
  }
  const locationLabel = weatherPlaceLabel(location.label ?? location.name);
  const currentSummary = tomorrow
    ? `${
        typeof forecastHigh === "number" && typeof forecastLow === "number"
          ? `Holnap ${locationLabel} várhatóan ${formatTemperature(forecastLow)} és ${formatTemperature(forecastHigh)} között lesz`
          : `Holnap ${locationLabel} időjárása várható`
      }, ${condition}. A szél legfeljebb ${formatWindSpeed(forecastWindSpeed)}.` +
      (typeof precipitationProbability === "number"
        ? ` Az eső esélye ${formatPrecipitationProbability(precipitationProbability)}.`
        : "")
    : `${locationLabel} most ${formatTemperature(current.temperature_2m)} van, ` +
      `${condition}, a szél ${formatWindSpeed(current.wind_speed_10m)}.`;
  return {
    message:
      currentSummary +
      (!tomorrow && dailyDetails.length > 0
        ? ` ${dailyDetails.join(", ")}.`
        : ""),
    location: location.name,
    latitude: location.latitude,
    longitude: location.longitude,
    temperatureC: current.temperature_2m,
    condition,
    windSpeedKmh: tomorrow ? forecastWindSpeed : current.wind_speed_10m,
    ...(typeof forecastHigh === "number" ? { todayHighC: forecastHigh } : {}),
    ...(typeof forecastLow === "number" ? { todayLowC: forecastLow } : {}),
    ...(typeof precipitationProbability === "number"
      ? { precipitationProbability }
      : {}),
  };
}

function transcriptionErrorMessage(status: number): string {
  if (status === 401 || status === 403) {
    return "The speech provider rejected the configured API key.";
  }
  if (status === 429) {
    return "Speech recognition is busy right now. Please try again in a moment.";
  }
  if (status === 400 || status === 415 || status === 422) {
    return "The recorded audio could not be decoded. Please record again.";
  }
  return "Zara could not recognize that recording. Please try again.";
}

function detectAudioFormat(audio: Buffer): { mimeType: string; extension: string } | null {
  if (audio.length >= 12 && audio.subarray(0, 4).toString("ascii") === "RIFF") {
    return { mimeType: "audio/wav", extension: "wav" };
  }
  if (audio.length >= 8 && audio.subarray(4, 8).toString("ascii") === "ftyp") {
    const majorBrand = audio.subarray(8, 12).toString("ascii").toLowerCase();
    if (majorBrand.startsWith("3g")) return null;
    return { mimeType: "audio/mp4", extension: "m4a" };
  }
  if (audio.length >= 4 && audio.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) {
    return { mimeType: "audio/webm", extension: "webm" };
  }
  if (audio.length >= 6 && audio.subarray(0, 6).toString("ascii") === "#!AMR\n") {
    return { mimeType: "audio/amr", extension: "amr" };
  }
  return null;
}

async function requestOpenAiSpeech(text: string, language: "en" | "hu"): Promise<Buffer | null> {
  const apiKey = process.env["OPENAI_API_KEY"];
  if (!apiKey) return null;

  const baseUrl = (process.env["OPENAI_BASE_URL"] ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(`${baseUrl}/audio/speech`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env["OPENAI_TTS_MODEL"] ?? "gpt-4o-mini-tts",
        voice: process.env["OPENAI_TTS_VOICE"] ?? "shimmer",
        input: text,
        instructions:
          language === "hu"
            ? "Beszélj természetes, lágy, meleg magyar női hangon. Legyél nyugodt és közvetlen, ne hangozz gépiesnek. A Zara nevet rövid a-val ejtsd: Zara, ne Zára. Ne tegyél hozzá semmit a szöveghez."
            : "Speak in a natural, soft, warm voice. Be calm and direct, and do not sound robotic. Do not add anything to the text.",
        response_format: "mp3",
      }),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const audio = Buffer.from(await response.arrayBuffer());
    return audio.length >= 256 ? audio : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function containsAudibleSpeech(audio: Buffer): Promise<boolean> {
  return await new Promise((resolve) => {
    const ffmpeg = spawn(
      "ffmpeg",
      [
        "-hide_banner",
        "-nostats",
        "-i",
        "pipe:0",
        "-af",
        "volumedetect",
        "-f",
        "null",
        "-",
      ],
      { stdio: ["pipe", "ignore", "pipe"] },
    );
    let diagnostics = "";
    const timeout = setTimeout(() => {
      ffmpeg.kill("SIGKILL");
      resolve(true);
    }, 5_000);

    ffmpeg.stderr.setEncoding("utf8");
    ffmpeg.stderr.on("data", (chunk: string) => {
      diagnostics += chunk;
    });
    ffmpeg.once("error", () => {
      clearTimeout(timeout);
      resolve(true);
    });
    ffmpeg.once("close", () => {
      clearTimeout(timeout);
      const meanMatch = diagnostics.match(/mean_volume:\s*(-?(?:\d+(?:\.\d+)?|inf))\s*dB/i);
      const maxMatch = diagnostics.match(/max_volume:\s*(-?(?:\d+(?:\.\d+)?|inf))\s*dB/i);
      if (!meanMatch || !maxMatch) {
        resolve(true);
        return;
      }
      const meanVolume = Number.parseFloat(meanMatch[1] ?? "-Infinity");
      const maxVolume = Number.parseFloat(maxMatch[1] ?? "-Infinity");
       resolve(meanVolume > -85 && maxVolume > -70);
    });
    ffmpeg.stdin.end(audio);
  });
}

router.post("/zara/chat", async (req, res) => {
  const body = getRequestBody(req);
  const messages = body.messages;

  if (
    !Array.isArray(messages) ||
    messages.length === 0 ||
    messages.length > 40 ||
    !messages.every(
      (message) =>
        (message.role === "user" || message.role === "assistant") &&
        typeof message.content === "string" &&
        message.content.trim().length > 0,
    )
  ) {
    res.status(400).json({ message: "At least one valid conversation message is required." });
    return;
  }

  const latestUserMessage = [...messages]
    .reverse()
    .find((message) => message.role === "user");
  if (latestUserMessage) {
    const normalized = normalizeZaraText(latestUserMessage.content);

    if ([
      "uj tema",
      "kezdjuk ujra",
      "felejtsd el az elozot",
      "felejts el mindent",
      "masrol beszeljunk"
    ].includes(normalized)) {
      conversationHistory.length = 0;
      res.json({ message: "Rendben, új témával folytatjuk." });
      return;
    }
  }

  if (latestUserMessage && isWeatherQuestion(latestUserMessage.content)) {
    req.log.info(
      { query: latestUserMessage.content },
      "Routing weather question to live provider before AI chat",
    );
    try {
      const report = await getWeatherReport({ query: latestUserMessage.content });
      res.json({ message: report.message });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Ismeretlen időjárási hiba.";
      if (error instanceof WeatherProviderError) {
        req.log.error(
          {
            status: error.status,
            providerMessage: error.providerMessage,
            providerUrl: error.safeUrl,
            query: latestUserMessage.content,
          },
          "Weather provider request failed during chat fallback prevention",
        );
        res.status(502).json({
          message: `Az időjárási szolgáltató hibát adott (HTTP ${error.status}): ${error.providerMessage}`,
        });
      } else {
        req.log.warn(
          { err: error, query: latestUserMessage.content },
          "Weather request failed during chat fallback prevention",
        );
        res.status(400).json({ message });
      }
    }
    return;
  }

  const apiKey = process.env["OPENAI_API_KEY"];
  if (!apiKey) {
    res.status(503).json({
      message: "Zara's AI provider is not configured. Add OPENAI_API_KEY to Replit Secrets.",
    });
    return;
  }

  const baseUrl = (process.env["OPENAI_BASE_URL"] ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  const model = process.env["OPENAI_MODEL"] ?? "gpt-5.4-mini";
  const language = body.language === "hu" ? "Hungarian" : "English";
  const responseStyle = body.responseStyle ?? "focused";
  const ownerIdentity =
    body.ownerVerified && body.ownerName?.trim()
      ? body.ownerName.trim()
      : null;
  const systemPrompt = [
  "Te vagy ZARA, Viktor személyes AI asszisztense és közvetlen beszélgetőtársa.",
  "Mindig magyarul kommunikálsz, teljesen természetesen, emberien, közvetlenül és barátságosan.",
  "A személyiséged: közvetlen, meleg, egy kicsit vicces és nevetgélős, mint egy igazi jó barát és társ.",
  "SOHA ne beszélj úgy, mint egy hivatalos ügyfélszolgálat, és SOHA ne légy oktató jellegű.",
  "SOHA ne javítsd ki Viktor nyelvtanát vagy beszédét, és SOHA ne adj kéretlen tanácsot a megfogalmazásra.",
  "Ha valamit nem értesz pontosan, kérdezz vissza röviden és természetesen: 'Ezt most nem teljesen értettem. Mire gondolsz?'.",
  "A válaszaid legyenek rövidek, közvetlenek és természetesek. Ne magyarázd túl az egyszerű dolgokat.",
  "Ne tegyed hozzá automatikusan a 'Viktor' nevet minden mondat végére. Csak akkor használd a nevét, ha természetesen illik a mondatba.",
  "Ne használj semmilyen Markdown formázást (ne használj csillagokat **, dőlt betűt *, aláhúzást _). Csak sima, tiszta szöveget írj.",
  "Ne mondd azt, hogy nyelvi modell vagy, a neved Zara.",
  "A beszélgetés előzményeit mindig vedd figyelembe."
].join(" ");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);

  try {
    const upstreamResponse = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_completion_tokens: 8192,
        messages: [{ role: "system", content: systemPrompt }, ...conversationHistory, ...messages],
      }),
      signal: controller.signal,
    });

    const payload = (await upstreamResponse.json()) as OpenAIResponse;
    if (!upstreamResponse.ok) {
      req.log.warn(
        { status: upstreamResponse.status, providerMessage: payload.error?.message },
        "AI provider request failed",
      );
      res.status(502).json({ message: providerErrorMessage(upstreamResponse.status) });
      return;
    }

    const rawMessage = payload.choices?.[0]?.message?.content?.trim();
    if (!rawMessage) {
      req.log.error({ model }, "AI provider returned no assistant message");
      res.status(502).json({ message: "Zara received an empty response. Please try again." });
      return;
    }

    const message = rawMessage.replace(/[*#_~`>|]/g, "").trim();
    if (!message) {
      req.log.error({ model }, "AI provider returned no assistant message");
      res.status(502).json({ message: "Zara received an empty response. Please try again." });
      return;
    }

    conversationHistory.push(...messages);
    conversationHistory.push({ role: "assistant", content: message });

    if (conversationHistory.length > MAX_HISTORY_MESSAGES) {
      conversationHistory.splice(
        0,
        conversationHistory.length - MAX_HISTORY_MESSAGES
      );
    }

    res.json({ message });
  } catch (error) {
    const isAbort = error instanceof Error && error.name === "AbortError";
    req.log.error({ err: error }, isAbort ? "AI provider request timed out" : "AI provider request errored");
    res.status(502).json({
      message: isAbort
        ? "Zara took too long to respond. Please try again."
        : "Zara could not reach the AI provider. Please try again.",
    });
  } finally {
    clearTimeout(timeout);
  }
});

router.post("/zara/weather", async (req, res) => {
  const body = req.body as ZaraWeatherRequest;
  try {
    res.json(await getWeatherReport(body));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Ismeretlen időjárási hiba.";
    if (error instanceof WeatherProviderError) {
      req.log.error(
        {
          status: error.status,
          providerMessage: error.providerMessage,
          providerUrl: error.safeUrl,
          query: body.query,
          latitude: body.latitude,
          longitude: body.longitude,
        },
        "Weather provider request failed",
      );
    } else {
      req.log.warn(
        { err: error, query: body.query, latitude: body.latitude, longitude: body.longitude },
        "Weather request failed",
      );
    }
    const isClientError =
      message.startsWith("Nem találtam településnevet") ||
      message.startsWith("Adj meg") ||
      message.startsWith("Érvénytelen") ||
      message.startsWith("A hely koordinátáihoz") ||
      message.startsWith("Nem találtam helyet");
    res.status(isClientError ? 400 : 502).json({
      message: isClientError
        ? message
        : error instanceof WeatherProviderError
          ? `Az időjárási szolgáltató hibát adott (HTTP ${error.status}): ${error.providerMessage}`
          : "Nem sikerült elérni az aktuális időjárási szolgáltatást. Ellenőrizd a fejlesztői naplót a pontos hibáért.",
    });
  }
});

router.post("/zara/transcribe", async (req, res) => {
  const body = req.body as ZaraTranscribeRequest;
  const audioBase64 = body.audioBase64?.trim();

  if (!audioBase64) {
    res.status(400).json({ message: "A microphone recording is required." });
    return;
  }

  let audio: Buffer;
  try {
    audio = Buffer.from(audioBase64, "base64");
  } catch {
    res.status(400).json({ message: "The microphone recording is invalid." });
    return;
  }

  if (audio.length < 256 || audio.length > 10 * 1024 * 1024) {
    res.status(422).json({
      message:
        audio.length < 256
          ? "The microphone recording is too short. Please speak for a moment and try again."
          : "The microphone recording is too large.",
    });
    return;
  }

  const detectedFormat = detectAudioFormat(audio);
  if (!detectedFormat) {
    req.log.warn(
      { bytes: audio.length, reportedMimeType: body.mimeType },
      "Rejected unrecognized audio container",
    );
    res.status(422).json({
      message: "The phone created an unsupported audio recording. Please record again.",
    });
    return;
  }

  if (!(await containsAudibleSpeech(audio))) {
    res.status(422).json({ message: "Zara could not hear any speech. Please try again." });
    return;
  }

  const apiKey = process.env["OPENAI_API_KEY"];
  if (!apiKey) {
    res.status(503).json({ message: "Zara's speech recognition is not configured." });
    return;
  }

  const baseUrl = (process.env["OPENAI_BASE_URL"] ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  const model = process.env["OPENAI_TRANSCRIBE_MODEL"] ?? "gpt-4o-mini-transcribe";
  const form = new FormData();
  form.append("model", model);
  form.append("language", body.language === "en" ? "en" : "hu");
  if (body.language !== "en") {
    form.append("prompt", "Magyar beszéd. Ébresztőmondatok: Szia Zara. Hallasz Zara? Hallod Zara? Figyelsz Zara?");
  }
  form.append("response_format", "json");
  form.append(
    "file",
    new Blob([Uint8Array.from(audio)], { type: detectedFormat.mimeType }),
    `zara-recording.${detectedFormat.extension}`,
  );

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);

  try {
    const upstreamResponse = await fetch(`${baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: controller.signal,
    });
    const payload = (await upstreamResponse.json()) as {
      text?: string;
      error?: { message?: string };
    };

    if (!upstreamResponse.ok) {
      req.log.warn(
        {
          status: upstreamResponse.status,
          providerMessage: payload.error?.message,
          bytes: audio.length,
          mimeType: detectedFormat.mimeType,
        },
        "Speech transcription request failed",
      );
      const clientStatus = [400, 415, 422].includes(upstreamResponse.status) ? 422 : 502;
      res.status(clientStatus).json({ message: transcriptionErrorMessage(upstreamResponse.status) });
      return;
    }

    const transcript = payload.text?.trim();
    if (!transcript) {
      res.status(422).json({ message: "Zara could not hear any speech. Please try again." });
      return;
    }

    res.json({ transcript });
  } catch (error) {
    const isAbort = error instanceof Error && error.name === "AbortError";
    req.log.error({ err: error }, isAbort ? "Speech transcription timed out" : "Speech transcription errored");
    res.status(502).json({
      message: isAbort
        ? "Speech recognition took too long. Please try again."
        : "Zara could not reach speech recognition. Please try again.",
    });
  } finally {
    clearTimeout(timeout);
  }
});

async function requestEdgeTtsSpeech(text: string, voice = "hu-HU-NoemiNeural"): Promise<Buffer | null> {
  const tmpFile = path.join(os.tmpdir(), `zara_tts_${Date.now()}_${Math.random().toString(36).substring(2, 8)}.mp3`);
  try {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn('python', [
        '-m', 'edge_tts',
        '--voice', voice,
        '--text', text,
        '--write-media', tmpFile
      ]);
      let stderr = '';
      proc.stderr.on('data', chunk => { stderr += chunk.toString(); });
      proc.on('close', code => {
        if (code === 0 && fs.existsSync(tmpFile) && fs.statSync(tmpFile).size > 0) {
          resolve();
        } else {
          reject(new Error(`edge-tts exited with code ${code}: ${stderr}`));
        }
      });
      proc.on('error', err => reject(err));
    });

    const buffer = fs.readFileSync(tmpFile);
    return buffer.length >= 256 ? buffer : null;
  } catch (err) {
    return null;
  } finally {
    if (fs.existsSync(tmpFile)) {
      try { fs.unlinkSync(tmpFile); } catch {}
    }
  }
}

router.post("/zara/speak", async (req, res) => {
  let text = "";
  if (req.body && typeof req.body === "object") {
    const body = req.body as Record<string, unknown>;
    if (typeof body.text === "string") text = body.text.trim();
    else if (typeof body.input === "string") text = body.input.trim();
    else if (typeof body.content === "string") text = body.content.trim();
  } else if (typeof req.body === "string") {
    try {
      const parsed = JSON.parse(req.body);
      text = (parsed.text || parsed.input || parsed.content || "").trim();
    } catch {
      text = req.body.trim();
    }
  }

  if (!text || text.length > 5_000) {
    req.log.warn({ body: req.body, headers: req.headers }, "Invalid or empty text in /zara/speak request");
    res.status(400).json({ message: "A Zara response of up to 5,000 characters is required." });
    return;
  }

  // Remove emojis and non-speech UI symbols before TTS generation
  text = text
    .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{27BF}\u{2300}-\u{23FF}]/gu, "")
    .replace(/[*#_~`>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!text) {
    text = "Rendben.";
  }

  const language = (req.body && typeof req.body === "object" && req.body.language === "en") ? "en" : "hu";

  // 1. Primary Zara Reference Voice (Edge TTS Neural Noemi - exact match to zara_voice.mp3)
  const edgeTtsAudio = await requestEdgeTtsSpeech(text, "hu-HU-NoemiNeural");
  if (edgeTtsAudio) {
    res.json({ audioBase64: edgeTtsAudio.toString("base64"), mimeType: "audio/mpeg" });
    return;
  }

  // 2. Secondary Fallback (OpenAI Speech API)
  const openAiAudio = await requestOpenAiSpeech(text, language);
  if (openAiAudio) {
    res.json({ audioBase64: openAiAudio.toString("base64"), mimeType: "audio/mpeg" });
    return;
  }

  // 3. Tertiary Fallback (ElevenLabs if voiceId configured)
  const voiceId = process.env["ELEVENLABS_VOICE_ID"];
  if (voiceId) {
    try {
      const response = await connectors.proxy(
        "elevenlabs",
        `/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "audio/mpeg",
          },
          body: JSON.stringify({
            text,
            model_id: "eleven_v3",
            language_code: language,
            voice_settings: {
              speed: 0.9,
              stability: 0.5,
              similarity_boost: 0.75,
              style: 0,
              use_speaker_boost: true,
            },
          }),
        },
      );

      if (response.ok) {
        const audio = Buffer.from(await response.arrayBuffer());
        if (audio.length >= 256) {
          res.json({ audioBase64: audio.toString("base64"), mimeType: "audio/mpeg" });
          return;
        }
      }
    } catch (error) {
      req.log.warn({ err: error }, "ElevenLabs speech request errored");
    }
  }

  res.status(502).json({ message: "Zara could not generate speech." });
});

export default router;






