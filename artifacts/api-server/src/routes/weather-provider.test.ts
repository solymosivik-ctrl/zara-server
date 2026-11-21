import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createOpenMeteoClient,
  WeatherProviderError,
  weatherProviderUserMessage,
} from "./weather-provider";

const GEOCODING_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const FORECAST_TTL_MS = 30 * 60 * 1000;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("reuses geocoding data for 30 days, then requests it again", async () => {
  let now = 1_000;
  let calls = 0;
  const client = createOpenMeteoClient({
    now: () => now,
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({ results: [{ name: "Budapest" }] });
    },
  });
  const url =
    "https://geocoding-api.open-meteo.com/v1/search?name=Budapest&count=5&language=hu&format=json";

  await client.fetchGeocoding(url);
  await client.fetchGeocoding(url);
  assert.equal(calls, 1);

  now += GEOCODING_TTL_MS;
  await client.fetchGeocoding(url);
  assert.equal(calls, 2);
});

test("caches forecasts for 30 minutes and separates requested parameters", async () => {
  let now = 2_000;
  let calls = 0;
  const client = createOpenMeteoClient({
    now: () => now,
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({ current: { temperature_2m: 20 } });
    },
  });
  const today =
    "https://api.open-meteo.com/v1/forecast?latitude=47.5&longitude=19.04&forecast_days=1&timezone=auto";
  const tomorrow =
    "https://api.open-meteo.com/v1/forecast?latitude=47.5&longitude=19.04&forecast_days=2&timezone=auto";

  await client.fetchForecast(today);
  await client.fetchForecast(today);
  await client.fetchForecast(tomorrow);
  assert.equal(calls, 2);

  now += FORECAST_TTL_MS;
  await client.fetchForecast(today);
  assert.equal(calls, 3);
});

test("simultaneous identical requests share one provider request", async () => {
  let calls = 0;
  let releaseFetch: ((response: Response) => void) | undefined;
  const blockedFetch = new Promise<Response>((resolve) => {
    releaseFetch = resolve;
  });
  const client = createOpenMeteoClient({
    fetchImpl: async () => {
      calls += 1;
      return blockedFetch;
    },
  });
  const url =
    "https://api.open-meteo.com/v1/forecast?latitude=47.5&longitude=19.04&forecast_days=1";

  const first = client.fetchForecast(url);
  const second = client.fetchForecast(url);
  await Promise.resolve();
  assert.equal(calls, 1);
  releaseFetch?.(jsonResponse({ current: { temperature_2m: 20 } }));
  assert.deepEqual(await Promise.all([first, second]), [
    { current: { temperature_2m: 20 } },
    { current: { temperature_2m: 20 } },
  ]);
  assert.equal(calls, 1);
});

test("HTTP 429 is returned after one provider request without retries", async () => {
  let calls = 0;
  const client = createOpenMeteoClient({
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({ reason: "Daily API request limit exceeded." }, 429);
    },
  });

  await assert.rejects(
    client.fetchForecast(
      "https://api.open-meteo.com/v1/forecast?latitude=47.5&longitude=19.04",
    ),
    (error: unknown) => error instanceof WeatherProviderError && error.status === 429,
  );
  assert.equal(calls, 1);
});

test("provider error URL and message redact API keys", async () => {
  const apiKey = "test-secret-weather-key";
  const client = createOpenMeteoClient({
    fetchImpl: async () =>
      jsonResponse({ reason: `Rejected key ${apiKey}` }, 429),
  });
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=47.5&apikey=${apiKey}`;

  await assert.rejects(
    client.fetchForecast(url),
    (error: unknown) => {
      assert.ok(error instanceof WeatherProviderError);
      assert.equal(error.status, 429);
      assert.equal(error.safeUrl.includes(apiKey), false);
      assert.equal(error.safeUrl.includes("apikey"), false);
      assert.equal(error.providerMessage.includes(apiKey), false);
      return true;
    },
  );
});

test("HTTP 429 has a clear Hungarian quota message", () => {
  const error = new WeatherProviderError("provider error", 429, "quota", "safe-url");
  assert.equal(
    weatherProviderUserMessage(error),
    "Az időjárási szolgáltató lekérdezési korlátja betelt. Kérlek, próbáld újra később.",
  );
});
