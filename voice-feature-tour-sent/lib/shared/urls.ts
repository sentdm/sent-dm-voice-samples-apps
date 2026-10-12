export function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

/** Where Sent asks this app what to do with a call. */
export function callbackUrlFor(publicBaseUrl: string): string {
  return `${trimSlash(publicBaseUrl)}/api/voice/callback`;
}

/** Where Sent delivers this app's call webhooks. */
export function webhookUrlFor(publicBaseUrl: string): string {
  return `${trimSlash(publicBaseUrl)}/api/sent/webhooks`;
}
