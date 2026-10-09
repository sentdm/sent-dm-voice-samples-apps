import { randomUUID } from 'node:crypto';
import { fetchWithReason } from './http.js';
export class SentClient {
    key;
    base;
    constructor(key, base = 'https://api.sent.dm') {
        this.key = key;
        this.base = base;
    }
    async request(method, path, body) {
        const headers = { 'x-api-key': this.key, 'Content-Type': 'application/json' };
        if (method !== 'GET')
            headers['Idempotency-Key'] = randomUUID();
        const response = await fetchWithReason(this.base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
        if (response.status === 204)
            return undefined;
        const json = await response.json();
        if (!response.ok || json.success === false)
            throw new Error(`Sent ${response.status}: ${json.error?.code ?? 'REQUEST_FAILED'} — ${json.error?.message ?? 'Request failed.'}`);
        if (json.data === undefined || json.data === null)
            throw new Error('Sent returned no data. Check API scope and account access.');
        return json.data;
    }
    list() { return this.request('GET', '/v3/channels/voice'); }
    get(number) { return this.request('GET', `/v3/channels/voice/${encodeURIComponent(number)}`); }
    // Explicit existing number: never request allocation of a new phone number.
    routeExisting(number, callback) {
        return this.request('POST', '/v3/channels/voice', { number, callback_url: callback });
    }
    restore(number, callback) {
        return this.request('PATCH', `/v3/channels/voice/${encodeURIComponent(number)}`, { callback_url: callback });
    }
    async token(identity, number) {
        const data = await this.request('POST', '/v3/channels/voice/tokens', { identity, number, ttl: 600 });
        if (!data.token)
            throw new Error('Sent did not return a voice token.');
        return data.token;
    }
    async test(number) {
        const verdict = await this.request('POST', `/v3/channels/voice/${encodeURIComponent(number)}/test`, {});
        if (verdict.outcome !== 'ok')
            throw new Error(`Sent callback test: ${verdict.outcome}. ${verdict.error?.message ?? ''}`);
    }
}
//# sourceMappingURL=sent.js.map