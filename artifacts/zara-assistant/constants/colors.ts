/**
 * Semantic design tokens for the mobile app.
 *
 * These tokens mirror the naming conventions used in web artifacts (index.css)
 * so that multi-artifact projects share a cohesive visual identity.
 *
 * Replace the placeholder values below with values that match the project's
 * brand. If a sibling web artifact exists, read its index.css and convert the
 * HSL values to hex so both artifacts use the same palette.
 *
 * To add dark mode, add a `dark` key with the same token names.
 * The useColors() hook will automatically pick it up.
 */

const futuristicPalette = {
  text: '#F3F7FF',
  tint: '#65E8FF',
  background: '#080B14',
  foreground: '#F3F7FF',
  card: '#111827',
  cardForeground: '#F3F7FF',
  primary: '#65E8FF',
  primaryForeground: '#071018',
  secondary: '#182234',
  secondaryForeground: '#C4D2E5',
  muted: '#121A2B',
  mutedForeground: '#8292AA',
  accent: '#FFB86B',
  accentForeground: '#211307',
  destructive: '#FF6D7A',
  destructiveForeground: '#21080D',
  border: '#233149',
  input: '#1A263B',
};

const colors = {
  light: futuristicPalette,
  dark: futuristicPalette,
  radius: 18,
};

export default colors;
