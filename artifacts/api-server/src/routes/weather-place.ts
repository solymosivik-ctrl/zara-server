const weatherFillerWords = new Set([
  "a",
  "adott",
  "az",
  "de",
  "ezen",
  "es",
  "fok",
  "fog",
  "folyaman",
  "hello",
  "helo",
  "hallo",
  "hany",
  "hat",
  "hogy",
  "holnap",
  "homerseklet",
  "hofok",
  "ido",
  "idojaras",
  "idojarasi",
  "idojarast",
  "is",
  "itt",
  "jelenleg",
  "kerlek",
  "kornyek",
  "kornyeken",
  "lesz",
  "ma",
  "meg",
  "mennyi",
  "mi",
  "milyen",
  "mondd",
  "most",
  "mutasd",
  "nap",
  "napon",
  "napra",
  "nezd",
  "nalam",
  "nal",
  "ott",
  "szia",
  "soran",
  "szel",
  "van",
  "varhato",
  "varhatoan",
  "volna",
  "helyen",
  "zara",
]);

function normalizeWeatherToken(value: string): string {
  return value
    .toLocaleLowerCase("hu-HU")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

export function findExactWeatherPlace<T extends { name?: string }>(
  results: readonly T[] | undefined,
  query: string,
): T | undefined {
  const normalizedQuery = normalizeWeatherToken(query);
  return results?.find(
    (result) =>
      typeof result.name === "string" &&
      normalizeWeatherToken(result.name) === normalizedQuery,
  );
}

function isWeatherFillerToken(token: string): boolean {
  const normalized = normalizeWeatherToken(token).replace(/[-–](?:e|is)$/u, "");
  if (weatherFillerWords.has(normalized)) return true;
  if (/^(?:holnap|lesz|fog)\p{L}*$/u.test(normalized)) return true;
  return /^(?:idojaras|homerseklet|hofok|fok|eso|szel|varhato)\p{L}*$/u.test(
    normalized,
  );
}

/** Extract a place while filtering Hungarian weather verbs and prompt words. */
export function extractWeatherPlace(query: string): string | null {
  const tokens = query
    .replace(/[?!.,;:()[\]{}"'’]+/gu, " ")
    .split(/\s+/u)
    .filter(Boolean);
  const place = tokens.filter((token) => !isWeatherFillerToken(token)).join(" ").trim();
  return place.length >= 2 ? place : null;
}
