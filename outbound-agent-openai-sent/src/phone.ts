// No Node.js imports: the dashboard bundles this file too, so the browser and the server check numbers the same way.

export const INTERNATIONAL_FORMAT_HINT = 'Enter the number in international format, for example +14155551234.';

/**
 * Normalizes a number typed in international format to E.164: `+1 (415) 555-1234` becomes `+14155551234`.
 * Anything without a leading + and country code returns undefined. The app never guesses a country.
 */
export function toE164(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 40) return undefined;
  const compact = value.trim().replace(/[\s().-]/g, '');
  return /^\+[1-9]\d{6,14}$/.test(compact) ? compact : undefined;
}

/** The checks before a call, in the order the dashboard reports them: the number's format, the agent's own number, permission. */
export function checkNumberToCall(value: unknown, ownNumber: string | undefined, consent: unknown): { to: string; error?: undefined } | { to?: undefined; error: string } {
  const to = toE164(value);
  if (!to) return { error: INTERNATIONAL_FORMAT_HINT };
  if (to === ownNumber) return { error: 'The agent cannot call its own Sent number.' };
  if (consent !== true) return { error: 'Confirm that you have permission to call this number with an AI voice.' };
  return { to };
}
