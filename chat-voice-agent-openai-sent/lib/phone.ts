// No Node.js imports: the browser and the server check numbers the same way.

/**
 * Normalizes a number in international format to E.164: `+1 (415) 555-1234`
 * becomes `+14155551234`. Anything without a leading + and country code
 * returns undefined. The app never guesses a country.
 */
export function toE164(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 40) return undefined
  const compact = value.trim().replace(/[\s().-]/g, "")
  return /^\+[1-9]\d{6,14}$/.test(compact) ? compact : undefined
}
