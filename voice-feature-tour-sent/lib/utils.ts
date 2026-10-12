export { cn } from "cn";

/** A short id that is unique enough for log rows. */
export function newId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** Parses JSON, or gives back the text as is when it is not JSON. An empty body is null. */
export function parseJsonOrText(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
