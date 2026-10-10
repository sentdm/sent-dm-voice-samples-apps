import { randomUUID } from 'node:crypto';
import { fetchWithReason } from './http.js';
export interface VoiceNumber { number: string; status: string; default_for_app_calls: boolean; callback_url: string | null; }
export class SentClient {
  constructor(private key: string, private base = 'https://api.sent.dm') {}
  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { 'x-api-key': this.key, 'Content-Type': 'application/json' };
    if (method !== 'GET') headers['Idempotency-Key'] = randomUUID();
    const response = await fetchWithReason(this.base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
    if (response.status === 204) return undefined as T;
    const json = await response.json() as { success?: boolean; data?: T; error?: { code?: string; message?: string } };
    if (!response.ok || json.success === false) throw new Error(`Sent ${response.status}: ${json.error?.code ?? 'REQUEST_FAILED'} — ${json.error?.message ?? 'Request failed.'}`);
    if (json.data === undefined || json.data === null) throw new Error('Sent returned no data. Check API scope and account access.');
    return json.data;
  }
  list(): Promise<VoiceNumber[]> { return this.request('GET', '/v3/channels/voice'); }
  get(number: string): Promise<VoiceNumber> { return this.request('GET', `/v3/channels/voice/${encodeURIComponent(number)}`); }
  // Explicit existing number: never request allocation of a new phone number.
  routeExisting(number: string, callback: string): Promise<VoiceNumber & { callback_secret: string }> {
    return this.request('POST', '/v3/channels/voice', { number, callback_url: callback });
  }
  restore(number: string, callback: string): Promise<VoiceNumber> {
    return this.request('PATCH', `/v3/channels/voice/${encodeURIComponent(number)}`, { callback_url: callback });
  }
  async token(identity: string, number: string): Promise<string> {
    const data = await this.request<{ token: string }>('POST', '/v3/channels/voice/tokens', { identity, number, ttl: 600 });
    if (!data.token) throw new Error('Sent did not return a voice token.');
    return data.token;
  }
  async test(number: string): Promise<void> {
    const verdict = await this.request<{ outcome: string; error?: { message?: string } }>('POST', `/v3/channels/voice/${encodeURIComponent(number)}/test`, {});
    if (verdict.outcome !== 'ok') throw new Error(`Sent callback test: ${verdict.outcome}. ${verdict.error?.message ?? ''}`);
  }
}
