import assert from "node:assert/strict";
import { test } from "node:test";
import { extractWeatherPlace, findExactWeatherPlace } from "./weather-place";

test("removes weather verbs before resolving a Hungarian place", () => {
  assert.equal(extractWeatherPlace("Milyen idő lesz holnap Budapesten?"), "Budapesten");
  assert.equal(extractWeatherPlace("Holnap Debrecenben lesz eső."), "Debrecenben");
});

test("does not treat inflected future weather verbs as place names", () => {
  assert.equal(extractWeatherPlace("Milyen idő lesznek holnap?"), null);
  assert.equal(extractWeatherPlace("Lesz-e eső ma?"), null);
});

test("preserves accented place names and removes only weather filler words", () => {
  assert.equal(extractWeatherPlace("Zara, nézd meg kérlek, milyen idő lesz Győrben!"), "Győrben");
});

test("does not treat approximate geocoding matches as the requested place", () => {
  const results = [
    { name: "Viktor", latitude: 47.5 },
    { name: "Győr", latitude: 47.7 },
  ];
  assert.equal(findExactWeatherPlace(results, "győr")?.latitude, 47.7);
  assert.equal(findExactWeatherPlace(results, "Veszprém"), undefined);
});

test("does not invent Budapest when a weather request contains no place", () => {
  assert.equal(extractWeatherPlace("Milyen idő lesz holnap?"), null);
  assert.equal(extractWeatherPlace("Lesz-e eső a környéken?"), null);
});

test("handles the five reported Hungarian weather queries exactly", () => {
  assert.equal(extractWeatherPlace("Milyen idő lesznek holnap?"), null);
  assert.equal(extractWeatherPlace("Milyen idő lesz holnap?"), null);
  assert.equal(extractWeatherPlace("Lesz-e eső ma?"), null);
  assert.equal(
    extractWeatherPlace("Holnap milyen idő lesz Budakeszin?"),
    "Budakeszin",
  );
  assert.equal(extractWeatherPlace("Milyen idő lesz Veszprémben?"), "Veszprémben");
});
