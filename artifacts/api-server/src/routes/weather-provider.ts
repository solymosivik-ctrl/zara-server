export type WeatherProviderCacheKind = "geocoding" | "forecast";

const GEOCODING_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const FORECAST_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_CACHE_ENTRIES = 500;
const REQUEST_TIMEOUT_MS = 12_000;
const SENSITIVE_QUERY_PARAMS = new Set([
  "apikey",
  "api_key",
  "access_token",
  "token",
]);

type CacheEntry = {
  expiresAt: number;
  value: unknown;
};

class AsyncTtlCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
    private readonly now: () => number,
  ) {}

  async getOrLoad<T>(key: string, load: () => Promise<T>): Promise<T> {
    const now = this.now();
    const cached = this.entries.get(key);
    if (cached && cached.expiresAt > now) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      return cached.value as T;
    }
    if (cached) this.entries.delete(key);

    const pending = this.inFlight.get(key);
    if (pending) return pending as Promise<T>;

    const request = Promise.resolve()
      .then(load)
      .then((value) => {
        this.pruneExpired(this.now());
        this.entries.delete(key);
        this.entries.set(key, {
          value,
          expiresAt: this.now() + this.ttlMs,
        });
        while (this.entries.size > this.maxEntries) {
          const oldestKey = this.entries.keys().next().value;
          if (oldestKey === undefined) break;
          this.entries.delete(oldestKey);
        }
        return value;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });
    this.inFlight.set(key, request);
    return request;
  }

  private pruneExpired(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }
}

export class WeatherProviderError extends Error {
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

function getSensitiveValues(url: URL): string[] {
  const values: string[] = [];
  for (const [key, value] of url.searchParams) {
    if (SENSITIVE_QUERY_PARAMS.has(key.toLowerCase()) && value) {
      values.push(value);
    }
  }
  return values;
}

export function sanitizeWeatherProviderUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  for (const key of [...url.searchParams.keys()]) {
    if (SENSITIVE_QUERY_PARAMS.has(key.toLowerCase())) {
      url.searchParams.delete(key);
    }
  }
  url.searchParams.sort();
  return url.toString();
}

function sanitizeProviderMessage(message: string, secretValues: string[]): string {
  let sanitized = message;
  for (const secret of secretValues) {
    sanitized = sanitized.split(secret).join("[REDACTED]");
  }
  return sanitized.slice(0, 500);
}

export function weatherProviderUserMessage(error: WeatherProviderError): string {
  if (error.status === 429) {
    return "Az időjárási szolgáltató lekérdezési korlátja betelt. Kérlek, próbáld újra később.";
  }
  return `Az időjárási szolgáltató hibát adott (HTTP ${error.status}): ${error.providerMessage}`;
}

export function createOpenMeteoClient(options?: {
  fetchImpl?: typeof fetch;
  now?: () => number;
  maxCacheEntries?: number;
}) {
  const fetchImpl = options?.fetchImpl ?? fetch;
  const now = options?.now ?? Date.now;
  const maxCacheEntries = options?.maxCacheEntries ?? DEFAULT_MAX_CACHE_ENTRIES;
  const geocodingCache = new AsyncTtlCache(
    GEOCODING_TTL_MS,
    maxCacheEntries,
    now,
  );
  const forecastCache = new AsyncTtlCache(FORECAST_TTL_MS, maxCacheEntries, now);

  async function fetchJson<T>(
    rawUrl: string,
    cacheKind: WeatherProviderCacheKind,
  ): Promise<T> {
    const originalUrl = new URL(rawUrl);
    const secretValues = getSensitiveValues(originalUrl);
    const safeUrl = sanitizeWeatherProviderUrl(rawUrl);
    const cache = cacheKind === "geocoding" ? geocodingCache : forecastCache;

    return cache.getOrLoad(safeUrl, async () => {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        REQUEST_TIMEOUT_MS,
      );
      try {
        let response: Response;
        try {
          response = await fetchImpl(rawUrl, { signal: controller.signal });
        } catch (error) {
          const rawMessage =
            error instanceof Error
              ? error.name === "AbortError"
                ? "Open-Meteo request timed out."
                : error.message
              : "Open-Meteo request failed.";
          const providerMessage = sanitizeProviderMessage(
            rawMessage,
            secretValues,
          );
          throw new WeatherProviderError(
            providerMessage,
            0,
            providerMessage,
            safeUrl,
          );
        }

        const responseText = await response.text();
        let payload: unknown = responseText;
        try {
          payload = responseText ? JSON.parse(responseText) : null;
        } catch {
          // Retain a bounded, sanitized provider response for diagnostics.
        }
        if (!response.ok) {
          const rawProviderMessage =
            payload &&
            typeof payload === "object" &&
            "reason" in payload &&
            typeof payload.reason === "string"
              ? payload.reason
              : responseText;
          const providerMessage = sanitizeProviderMessage(
            rawProviderMessage,
            secretValues,
          );
          throw new WeatherProviderError(
            `Open-Meteo HTTP ${response.status} ${response.statusText}: ${providerMessage}`,
            response.status,
            providerMessage,
            safeUrl,
          );
        }
        if (payload === null || typeof payload !== "object") {
          const providerMessage = sanitizeProviderMessage(
            responseText || "Open-Meteo returned an invalid JSON response.",
            secretValues,
          );
          throw new WeatherProviderError(
            "Open-Meteo returned an invalid JSON response.",
            response.status,
            providerMessage,
            safeUrl,
          );
        }
        return payload as T;
      } finally {
        clearTimeout(timeout);
      }
    });
  }

  return {
    fetchGeocoding: <T>(url: string) => fetchJson<T>(url, "geocoding"),
    fetchForecast: <T>(url: string) => fetchJson<T>(url, "forecast"),
  };
}

const productionOpenMeteoClient = createOpenMeteoClient();

export const fetchOpenMeteoGeocoding = productionOpenMeteoClient.fetchGeocoding;
export const fetchOpenMeteoForecast = productionOpenMeteoClient.fetchForecast;
