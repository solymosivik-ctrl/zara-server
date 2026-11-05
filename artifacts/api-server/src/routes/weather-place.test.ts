import assert from "node:assert/strict";
import { test } from "node:test";
import { extractWeatherPlace } from "./weather-place";

test("removes weather verbs before resolving a Hungarian place", () => {
  assert.equal(extractWeatherPlace("Milyen idő lesz holnap Budapesten?"), "Budapesten");
  assert.equal(extractWeatherPlace("Holnap Debrecenben lesz eső."), "Debrecenben");
});

test("does not treat inflected future weather verbs as place names", () => {
  assert.equal(extractWeatherPlace("Milyen idő lesznek holnap?"), "Budapest");
  assert.equal(extractWeatherPlace("Lesz-e eső ma?"), "Budapest");
});

test("preserves accented place names and removes only weather filler words", () => {
  assert.equal(extractWeatherPlace("Zara, nézd meg kérlek, milyen idő lesz Győrben!"), "Győrben");
});
