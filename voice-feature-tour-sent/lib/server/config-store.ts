import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type {
  AppConfig,
  PublicConfig,
  RoutingRules,
  SentCredentials,
} from "@/lib/shared/types";
import { callbackUrlFor, trimSlash, webhookUrlFor } from "@/lib/shared/urls";
import { E164_PATTERN } from "@/lib/shared/validation";
import { DEFAULT_ROUTING_RULES, routingRulesSchema } from "./routing";
import { isSetupPasswordRequired } from "./setup-password";
import { tunnelInfo } from "./state";

/**
 * Configuration lives in one JSON file on the server, written from the setup screen.
 * It holds the API key and the signing secrets, so the browser only ever receives the
 * masked form produced by `toPublicConfig`.
 */

const CONFIG_FILE = "config.json";
const ROUTING_FILE = "routing.json";

export const DEFAULT_API_BASE_URL = "https://api.sent.dm";

export const credentialsInputSchema = z.object({
  apiBaseUrl: z
    .url({ protocol: /^https?$/, error: "Enter the Sent API base URL" })
    .trim()
    .transform(trimSlash),
  /** Empty means the saved key. */
  apiKey: z.string().trim().optional().default(""),
});

export const setupInputSchema = credentialsInputSchema.extend({
  phoneNumber: z
    .string()
    .trim()
    .regex(E164_PATTERN, "Use E.164, for example +14155551234"),
  /** Empty keeps the saved secret. */
  callbackSigningSecret: z.string().trim().optional().default(""),
});

/** The base URL and key a setup request names, with the saved key when it leaves the key empty. */
export function credentialsFor(
  input: z.infer<typeof credentialsInputSchema>,
  current: AppConfig | null
): SentCredentials | null {
  const apiKey = input.apiKey || current?.apiKey;
  return apiKey ? { apiBaseUrl: input.apiBaseUrl, apiKey } : null;
}

function dataDir(): string {
  return path.resolve(
    /*turbopackIgnore: true*/ process.cwd(),
    process.env.DATA_DIR ?? ".data"
  );
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    // The data folder is chosen at runtime, so the bundler must not trace it.
    const text = await fs.readFile(
      path.join(/*turbopackIgnore: true*/ dataDir(), file),
      "utf8"
    );
    return JSON.parse(text) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  const dir = dataDir();
  await fs.mkdir(dir, { recursive: true });
  const target = path.join(/*turbopackIgnore: true*/ dir, file);
  const temp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await fs.rename(temp, target);
}

export async function readConfig(): Promise<AppConfig | null> {
  const stored = await readJson<Partial<AppConfig>>(CONFIG_FILE);
  if (!stored || !stored.apiKey || !stored.phoneNumber) return null;
  return {
    apiBaseUrl: stored.apiBaseUrl || DEFAULT_API_BASE_URL,
    apiKey: stored.apiKey,
    phoneNumber: stored.phoneNumber,
    callbackSigningSecret: stored.callbackSigningSecret ?? "",
    publicBaseUrl: stored.publicBaseUrl ?? "",
    webhook: stored.webhook ?? null,
    updatedAt: stored.updatedAt ?? new Date(0).toISOString(),
  };
}

/** Throws when the app is not set up yet. Routes that need the API key use this. */
export async function requireConfig(): Promise<AppConfig> {
  const config = await readConfig();
  if (!config) throw new NotConfiguredError();
  return config;
}

export class NotConfiguredError extends Error {
  constructor() {
    super("The app is not set up yet. Open /setup first.");
    this.name = "NotConfiguredError";
  }
}

export async function writeConfig(config: AppConfig): Promise<void> {
  await writeJson(CONFIG_FILE, config);
}

export async function updateConfig(
  patch: Partial<AppConfig>
): Promise<AppConfig> {
  const current = await requireConfig();
  const next: AppConfig = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  await writeConfig(next);
  return next;
}

export function mask(secret: string | null | undefined): string {
  if (!secret) return "";
  if (secret.length <= 8) return "****";
  return `${secret.slice(0, 4)}${"*".repeat(Math.min(12, secret.length - 8))}${secret.slice(-4)}`;
}

/**
 * Where Sent and other devices reach this app now: PUBLIC_BASE_URL when it is set, otherwise the
 * tunnel's URL once it is open. Empty while the tunnel opens.
 */
export const TUNNEL_NOT_OPEN =
  "The public tunnel is not open yet. Wait until the setup screen shows its URL, then try again.";

export function currentPublicBaseUrl(): string {
  const fixed = process.env.PUBLIC_BASE_URL?.trim();
  return trimSlash(fixed || tunnelInfo().url || "");
}

export function toPublicConfig(config: AppConfig | null): PublicConfig {
  const publicBaseUrl = currentPublicBaseUrl();
  const urls = {
    publicBaseUrl,
    publicUrlChanged: Boolean(
      config?.publicBaseUrl &&
      publicBaseUrl &&
      config.publicBaseUrl !== publicBaseUrl
    ),
    tunnel: tunnelInfo(),
    callbackUrl: publicBaseUrl ? callbackUrlFor(publicBaseUrl) : "",
    webhookEndpointUrl: publicBaseUrl ? webhookUrlFor(publicBaseUrl) : "",
  };
  if (!config) {
    return {
      configured: false,
      apiBaseUrl: DEFAULT_API_BASE_URL,
      apiKeyMasked: "",
      phoneNumber: "",
      callbackSigningSecretMasked: "",
      ...urls,
      webhook: null,
      updatedAt: null,
      setupPasswordRequired: isSetupPasswordRequired(),
    };
  }
  return {
    configured: true,
    apiBaseUrl: config.apiBaseUrl,
    apiKeyMasked: mask(config.apiKey),
    phoneNumber: config.phoneNumber,
    callbackSigningSecretMasked: mask(config.callbackSigningSecret),
    ...urls,
    webhook: config.webhook
      ? {
          id: config.webhook.id,
          endpointUrl: config.webhook.endpointUrl,
          signingSecretMasked: mask(config.webhook.signingSecret),
        }
      : null,
    updatedAt: config.updatedAt,
    setupPasswordRequired: isSetupPasswordRequired(),
  };
}

export async function readRoutingRules(): Promise<RoutingRules> {
  const stored = await readJson<unknown>(ROUTING_FILE);
  if (!stored) return DEFAULT_ROUTING_RULES;
  const parsed = routingRulesSchema.safeParse(stored);
  return parsed.success ? parsed.data : DEFAULT_ROUTING_RULES;
}

export async function writeRoutingRules(rules: RoutingRules): Promise<void> {
  await writeJson(ROUTING_FILE, rules);
}
