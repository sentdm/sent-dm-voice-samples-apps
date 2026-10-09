import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { OpenAIVoice, preflight, type ModelEvent } from '../src/openai.js';
import { createApplication } from '../src/server.js';

const SENT_KEY = 'sent-test-key-12345';
const OPENAI_KEY = 'openai-test-key-12345';
const CALLBACK_SECRET = `whsec_${Buffer.from('known-callback-secret').toString('base64')}`;
const DEFAULT_NUMBER = '+15550000002';
const OTHER_NUMBER = '+15550000001';
const BASE_CALL = { type: 'call.request', version: '1', number: DEFAULT_NUMBER, timestamp: '2026-01-01T00:00:00.000Z', direction: 'inbound', to: { kind: 'number', number: DEFAULT_NUMBER } };
const delay = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));

function signCallback(raw: Buffer, id = 'evt-test', timestamp = Math.floor(Date.now() / 1000), secret = CALLBACK_SECRET) {
  const key = Buffer.from(secret.slice(6), 'base64');
  const signature = createHmac('sha256', key).update(`${id}.${timestamp}.`).update(raw).digest('base64');
  return {
    'content-type': 'application/json',
    'x-webhook-id': id,
    'x-webhook-timestamp': String(timestamp),
    'x-webhook-signature': `v1,${signature}`,
  };
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}

async function listen(server: http.Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as import('node:net').AddressInfo).port;
}

async function closeHttp(server: http.Server): Promise<void> {
  server.closeAllConnections?.();
  if (!server.listening) return;
  await new Promise<void>(resolve => server.close(() => resolve()));
}

async function waitFor(predicate: () => boolean, description: string, timeout = 2_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await delay(5);
  }
}

interface VoiceNumber {
  number: string;
  status: string;
  default_for_app_calls: boolean;
  callback_url: string | null;
}

class FakeSentApi {
  readonly server: http.Server;
  readonly secret = CALLBACK_SECRET;
  readonly numbers = new Map<string, VoiceNumber>();
  readonly routeBodies: Array<Record<string, unknown>> = [];
  readonly patchBodies: Array<{ number: string; body: Record<string, unknown> }> = [];
  readonly tokenBodies: Array<Record<string, unknown>> = [];
  readonly testCallbacks: Array<{ status: number; body: unknown }> = [];
  readonly requests: Array<{ method: string; path: string; key?: string }> = [];
  base = '';

  constructor() {
    this.numbers.set(OTHER_NUMBER, { number: OTHER_NUMBER, status: 'ACTIVE', default_for_app_calls: false, callback_url: 'https://old.example/other' });
    this.numbers.set(DEFAULT_NUMBER, { number: DEFAULT_NUMBER, status: 'ACTIVE', default_for_app_calls: true, callback_url: 'https://old.example/callback' });
    this.numbers.set('+15550000003', { number: '+15550000003', status: 'INACTIVE', default_for_app_calls: false, callback_url: null });
    this.server = http.createServer((req, res) => void this.handle(req, res));
  }

  async start(): Promise<void> {
    this.base = `http://127.0.0.1:${await listen(this.server)}`;
  }

  async close(): Promise<void> { await closeHttp(this.server); }

  changeExternally(number: string, callback: string): void {
    const record = this.mustNumber(number);
    record.callback_url = callback;
  }

  private mustNumber(number: string): VoiceNumber {
    const item = this.numbers.get(number);
    if (!item) throw new Error(`Unknown fake number ${number}`);
    return item;
  }

  private ok(res: ServerResponse, data: unknown): void { json(res, 200, { success: true, data }); }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.base || 'http://127.0.0.1');
    const key = typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'] : undefined;
    this.requests.push({ method: req.method ?? '', path: url.pathname, key });
    if (key !== SENT_KEY) return json(res, 401, { success: false, error: { code: 'BAD_KEY', message: 'bad key' } });

    if (req.method === 'GET' && url.pathname === '/v3/channels/voice') return this.ok(res, [...this.numbers.values()]);
    if (req.method === 'POST' && url.pathname === '/v3/channels/voice') {
      const body = JSON.parse((await readBody(req)).toString() || '{}') as Record<string, unknown>;
      this.routeBodies.push(body);
      if (typeof body.number !== 'string' || typeof body.callback_url !== 'string') return json(res, 400, { success: false, error: { code: 'INVALID', message: 'number and callback_url required' } });
      const record = this.mustNumber(body.number);
      record.callback_url = body.callback_url;
      return this.ok(res, { ...record, callback_secret: this.secret });
    }

    const testMatch = url.pathname.match(/^\/v3\/channels\/voice\/(.+)\/test$/);
    if (req.method === 'POST' && testMatch) {
      const number = decodeURIComponent(testMatch[1]);
      const callback = this.mustNumber(number).callback_url;
      if (!callback) return json(res, 400, { success: false, error: { code: 'NO_CALLBACK', message: 'missing callback' } });
      const payload = Buffer.from(JSON.stringify({ type: 'call.request', version: '1', callId: 'sent-synthetic-test', number, timestamp: '2026-01-01T00:00:00.000Z', test: true }));
      const result = await fetch(callback, { method: 'POST', headers: signCallback(payload, 'evt-synthetic'), body: payload });
      const body = await result.json().catch(() => null);
      this.testCallbacks.push({ status: result.status, body });
      if (!result.ok) return json(res, 400, { success: false, error: { code: 'CALLBACK_FAILED', message: String(result.status) } });
      return this.ok(res, { outcome: 'ok' });
    }

    if (req.method === 'POST' && url.pathname === '/v3/channels/voice/tokens') {
      const body = JSON.parse((await readBody(req)).toString() || '{}') as Record<string, unknown>;
      this.tokenBodies.push(body);
      return this.ok(res, { token: 'fake-voice-token' });
    }

    const itemMatch = url.pathname.match(/^\/v3\/channels\/voice\/(.+)$/);
    if (itemMatch) {
      const number = decodeURIComponent(itemMatch[1]);
      const record = this.mustNumber(number);
      if (req.method === 'GET') return this.ok(res, record);
      if (req.method === 'PATCH') {
        const body = JSON.parse((await readBody(req)).toString() || '{}') as Record<string, unknown>;
        this.patchBodies.push({ number, body });
        if (typeof body.callback_url === 'string') record.callback_url = body.callback_url;
        return this.ok(res, record);
      }
    }
    json(res, 404, { success: false, error: { code: 'NOT_FOUND', message: 'not found' } });
  }
}

type OpenAiBehavior = 'ready' | 'model-error' | 'silent';
interface ModelSession { socket: WebSocket; path: string; events: Array<Record<string, unknown>>; }

class FakeOpenAi {
  readonly server: http.Server;
  readonly wss = new WebSocketServer({ noServer: true });
  readonly sessions: ModelSession[] = [];
  readonly modelsRequests: string[] = [];
  readonly responseBodies: Array<Record<string, unknown>> = [];
  httpBase = '';
  wsBase = '';

  constructor(private readonly behavior: OpenAiBehavior = 'ready') {
    this.server = http.createServer((req, res) => void this.handleHttp(req, res));
    this.server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/v1/live/sessions' && url.pathname !== '/v1/realtime') {
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, ws => this.wss.emit('connection', ws, req));
    });
    this.wss.on('connection', (socket, req) => {
      const session: ModelSession = { socket, path: req.url ?? '', events: [] };
      this.sessions.push(session);
      socket.on('message', (data, binary) => {
        if (binary) return;
        let event: Record<string, unknown>;
        try { event = JSON.parse(data.toString()) as Record<string, unknown>; } catch { return; }
        session.events.push(event);
        if (event.type === 'session.start' || event.type === 'session.update') {
          if (this.behavior === 'ready') this.send(session, { type: event.type === 'session.start' ? 'session.started' : 'session.updated' });
          if (this.behavior === 'model-error') this.send(session, { type: 'error', error: { message: 'model is not enabled' } });
        }
        if (event.type === 'session.close') {
          this.send(session, { type: 'session.closed', usage: { input_tokens: 3 } });
          setTimeout(() => socket.close(), 0);
        }
      });
      socket.on('error', () => {});
    });
  }

  async start(): Promise<void> {
    const port = await listen(this.server);
    this.httpBase = `http://127.0.0.1:${port}`;
    this.wsBase = `ws://127.0.0.1:${port}`;
  }

  async close(): Promise<void> {
    for (const client of this.wss.clients) client.terminate();
    await closeHttp(this.server);
  }

  send(session: ModelSession, event: unknown): void {
    if (session.socket.readyState === WebSocket.OPEN) session.socket.send(JSON.stringify(event));
  }

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.httpBase || 'http://127.0.0.1');
    const authorization = req.headers.authorization;
    if (url.pathname === '/v1/models' && req.method === 'GET') {
      this.modelsRequests.push(typeof authorization === 'string' ? authorization : '');
      if (authorization !== `Bearer ${OPENAI_KEY}`) return json(res, 401, { error: { message: 'wrong key' } });
      return json(res, 200, { data: [{ id: 'gpt-live-1' }, { id: 'gpt-realtime-2.1' }] });
    }
    if (url.pathname === '/v1/responses' && req.method === 'POST') {
      if (authorization !== `Bearer ${OPENAI_KEY}`) return json(res, 401, { error: { message: 'wrong key' } });
      this.responseBodies.push(JSON.parse((await readBody(req)).toString() || '{}') as Record<string, unknown>);
      return json(res, 200, { output_text: 'A short safe answer.' });
    }
    json(res, 404, { error: { message: 'not found' } });
  }
}

interface Fixture {
  sent: FakeSentApi;
  openai: FakeOpenAi;
  dataDir: string;
  runtime: Awaited<ReturnType<typeof createApplication>>;
  base: string;
  gatewayBase: string;
  csrf: string;
  tunnelPorts: number[];
  get tunnelStops(): number;
  dispose(): Promise<void>;
}

async function makeFixture(): Promise<Fixture> {
  const sent = new FakeSentApi();
  const openai = new FakeOpenAi();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'sent-agent-server-'));
  const tunnelPorts: number[] = [];
  let stopped = 0;
  await Promise.all([sent.start(), openai.start()]);
  const runtime = await createApplication({
    port: 0,
    dataDir,
    sentBase: sent.base,
    openaiHttpBase: openai.httpBase,
    openaiWsBase: openai.wsBase,
    tunnelFactory: async port => {
      tunnelPorts.push(port);
      return { url: `http://127.0.0.1:${port}`, stop: () => { stopped += 1; } };
    },
  });
  const managementPort = await runtime.listen();
  const base = `http://127.0.0.1:${managementPort}`;
  const gatewayPort = (runtime.gatewayServer.address() as import('node:net').AddressInfo).port;
  return {
    sent, openai, dataDir, runtime, base, gatewayBase: `http://127.0.0.1:${gatewayPort}`, csrf: runtime.csrf, tunnelPorts,
    get tunnelStops() { return stopped; },
    async dispose() {
      try { await runtime.close(); } finally {
        await Promise.allSettled([sent.close(), openai.close()]);
        await rm(dataDir, { recursive: true, force: true });
      }
    },
  };
}

async function dashboardGet(fixture: Fixture, endpoint: string) {
  const response = await fetch(fixture.base + endpoint);
  return { response, body: await response.json() as Record<string, unknown> };
}

async function dashboardPost(fixture: Fixture, endpoint: string, body: unknown, options: { csrf?: string; origin?: string } = {}) {
  const response = await fetch(fixture.base + endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: options.origin ?? fixture.base,
      'x-csrf-token': options.csrf ?? fixture.csrf,
    },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() as Record<string, unknown> };
}

async function configure(fixture: Fixture): Promise<void> {
  const result = await dashboardPost(fixture, '/api/configure', { sentKey: SENT_KEY, openaiKey: OPENAI_KEY });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
}

/** The dashboard's Start sequence: prepare, report a registered browser, activate routing. */
async function goLive(fixture: Fixture): Promise<void> {
  assert.equal((await dashboardPost(fixture, '/api/prepare', {})).response.status, 200);
  assert.equal((await dashboardPost(fixture, '/api/heartbeat', { registered: true, busy: false })).response.status, 200);
  const activated = await dashboardPost(fixture, '/api/activate', {});
  assert.equal(activated.response.status, 200, JSON.stringify(activated.body));
}

let callbackSequence = 0;

async function signedCallback(url: string, payload: Record<string, unknown>, id = `evt-local-${++callbackSequence}`) {
  const raw = Buffer.from(JSON.stringify(payload));
  const response = await fetch(url, { method: 'POST', headers: signCallback(raw, id), body: raw });
  return { response, body: await response.json().catch(() => null) as Record<string, unknown> | null };
}

function observe(ws: WebSocket) {
  const messages: Array<{ data: Buffer; binary: boolean }> = [];
  ws.on('message', (data: RawData, binary: boolean) => {
    const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer);
    messages.push({ data: bytes, binary });
  });
  return {
    messages,
    async wait(predicate: (message: { data: Buffer; binary: boolean }) => boolean, description: string): Promise<{ data: Buffer; binary: boolean }> {
      let found: { data: Buffer; binary: boolean } | undefined;
      await waitFor(() => {
        found = messages.find(predicate);
        return !!found;
      }, description);
      return found!;
    },
  };
}

function parseJson(message: { data: Buffer; binary: boolean }): Record<string, unknown> | undefined {
  if (message.binary) return undefined;
  try { return JSON.parse(message.data.toString()) as Record<string, unknown>; } catch { return undefined; }
}

async function openBridge(fixture: Fixture, token = fixture.csrf, origin = fixture.base): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${new URL(fixture.base).port}/bridge?token=${encodeURIComponent(token)}`, { headers: { origin } });
  ws.on('error', () => {});
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('bridge did not open')), 1_500);
    ws.once('open', () => { clearTimeout(timer); resolve(); });
    ws.once('error', error => { clearTimeout(timer); reject(error); });
  });
  return ws;
}

async function expectBridgeRejected(fixture: Fixture, token: string, origin: string): Promise<void> {
  const ws = new WebSocket(`ws://127.0.0.1:${new URL(fixture.base).port}/bridge?token=${encodeURIComponent(token)}`, { headers: { origin } });
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; clearTimeout(timer); resolve(); } };
    const timer = setTimeout(() => { if (!settled) { settled = true; ws.terminate(); reject(new Error('bridge rejection timed out')); } }, 1_500);
    ws.once('open', () => { clearTimeout(timer); settled = true; ws.close(); reject(new Error('bridge unexpectedly opened')); });
    ws.once('error', done);
    ws.once('close', done);
    ws.once('unexpected-response', (_request, response) => { response.resume(); done(); });
  });
}

test('local lifecycle configures only active Sent numbers, validates keys locally, preflights a callback tunnel, and never exposes keys through the gateway', async () => {
  const fixture = await makeFixture();
  try {
    const initial = await dashboardGet(fixture, '/api/state');
    assert.equal(initial.response.status, 200);
    assert.equal(initial.body.csrfToken, fixture.csrf);
    assert.equal(initial.body.configured, false);
    assert.equal(initial.body.model, 'gpt-realtime-2.1');
    assert.equal(initial.body.backendModel, 'gpt-6-luna');
    assert.equal(initial.body.transcriptionModel, 'gpt-live-transcribe');

    const missingCsrf = await dashboardPost(fixture, '/api/configure', { sentKey: SENT_KEY, openaiKey: OPENAI_KEY }, { csrf: '' });
    assert.equal(missingCsrf.response.status, 403);
    const badOrigin = await dashboardPost(fixture, '/api/configure', { sentKey: SENT_KEY, openaiKey: OPENAI_KEY }, { origin: 'http://evil.invalid' });
    assert.equal(badOrigin.response.status, 403);
    const wrongKey = await dashboardPost(fixture, '/api/configure', { sentKey: SENT_KEY, openaiKey: 'wrong-openai-key-123' });
    assert.equal(wrongKey.response.status, 400);
    assert.match(String(wrongKey.body.error), /OpenAI key check failed \(401\)/);

    const gatewayState = await fetch(fixture.gatewayBase + '/api/state');
    const gatewayText = await gatewayState.text();
    assert.equal(gatewayState.status, 404, 'the callback-only gateway has no management API');
    assert.equal(gatewayText.includes(SENT_KEY) || gatewayText.includes(OPENAI_KEY), false, 'gateway errors cannot disclose credentials');

    await configure(fixture);
    assert.deepEqual(fixture.openai.modelsRequests, [`Bearer wrong-openai-key-123`, `Bearer ${OPENAI_KEY}`]);
    const configured = await dashboardGet(fixture, '/api/state');
    assert.equal(configured.body.configured, true);
    assert.equal(configured.body.number, DEFAULT_NUMBER, 'default active number is selected');
    assert.deepEqual((configured.body.numbers as Array<{ number: string }>).map(item => item.number), [OTHER_NUMBER, DEFAULT_NUMBER]);

    const invalidSettings = await dashboardPost(fixture, '/api/settings', { number: '+15550009999', model: 'not-a-model', greeting: '', instructions: 'x' });
    assert.equal(invalidSettings.response.status, 400);
    const settings = await dashboardPost(fixture, '/api/settings', { number: OTHER_NUMBER, model: 'gpt-live-1', greeting: 'Welcome.', instructions: 'Do not use tools.' });
    assert.equal(settings.response.status, 200);

    const prepare = await dashboardPost(fixture, '/api/prepare', {});
    assert.equal(prepare.response.status, 200, JSON.stringify(prepare.body));
    assert.equal(fixture.tunnelPorts.length, 1);
    assert.equal(fixture.tunnelPorts[0], Number(new URL(fixture.gatewayBase).port), 'fake public URL targets the actual callback gateway port');
    assert.equal((await fetch(fixture.gatewayBase + '/health')).status, 200, 'the local fake tunnel passes public health preflight');
    assert.equal(fixture.openai.sessions[0].path, '/v1/live/sessions', 'Live session has no model query string');
    assert.equal(fixture.openai.sessions[0].events[0].type, 'session.start');
    await waitFor(() => fixture.openai.sessions[0].events.some(event => event.type === 'session.close'), 'preflight session.close');

    const token = await dashboardPost(fixture, '/api/voice-token', {});
    assert.equal(token.response.status, 200);
    assert.equal(token.body.token, 'fake-voice-token');
    assert.deepEqual(fixture.sent.tokenBodies[0], { identity: configured.body.identity, number: OTHER_NUMBER, ttl: 600 }, 'voice token explicitly has a ten-minute expiry');

    const prematureActivation = await dashboardPost(fixture, '/api/activate', {});
    assert.equal(prematureActivation.response.status, 400, 'activation requires a current browser heartbeat');
    const heartbeat = await dashboardPost(fixture, '/api/heartbeat', { registered: true, busy: false });
    assert.equal(heartbeat.response.status, 200);
  } finally {
    await fixture.dispose();
  }
});

test('a number still waiting for its first callback URL gets an actionable error instead of "no active numbers"', async () => {
  const fixture = await makeFixture();
  try {
    for (const record of fixture.sent.numbers.values()) { record.status = 'INACTIVE'; record.callback_url = null; }
    const result = await dashboardPost(fixture, '/api/configure', { sentKey: SENT_KEY, openaiKey: OPENAI_KEY });
    assert.equal(result.response.status, 400);
    assert.match(String(result.body.error), /\+15550000001, \+15550000002, \+15550000003 are waiting for a first callback URL\. Set any public HTTPS URL/);
  } finally {
    await fixture.dispose();
  }
});

test('environment keys use the dashboard validation path, surface rejection in state, report their source, and can be overridden', async () => {
  const fixture = await makeFixture();
  try {
    await assert.rejects(fixture.runtime.configureFromEnvironment(SENT_KEY, 'short'), /SENT_DM_API_KEY and OPENAI_API_KEY must each be 12–1024 characters/);
    await assert.rejects(fixture.runtime.configureFromEnvironment(SENT_KEY, 'wrong-openai-key-123'), /OpenAI key check failed \(401\)/);
    const rejected = await dashboardGet(fixture, '/api/state');
    assert.equal(rejected.body.configured, false, 'a rejected environment key never half-configures the app');
    assert.equal(rejected.body.keySource, null);
    assert.match(String(rejected.body.error), /OpenAI key check failed \(401\)/, 'the dashboard explains why environment keys were not used');

    await fixture.runtime.configureFromEnvironment(` ${SENT_KEY}\n`, OPENAI_KEY);
    const configured = await dashboardGet(fixture, '/api/state');
    assert.equal(configured.body.configured, true);
    assert.equal(configured.body.keySource, 'env');
    assert.equal(configured.body.error, '');
    assert.equal(configured.body.number, DEFAULT_NUMBER, 'default active number is selected exactly as for dashboard keys');
    const serialized = JSON.stringify(configured.body);
    assert.equal(serialized.includes(SENT_KEY) || serialized.includes(OPENAI_KEY), false, 'state never echoes environment keys');

    await configure(fixture);
    assert.equal((await dashboardGet(fixture, '/api/state')).body.keySource, 'dashboard', 'dashboard entry overrides environment keys for the session');
  } finally {
    await fixture.dispose();
  }
});

test('activation signs the actual Sent callback, routes only safe inbound calls, bridges PCM to OpenAI, and restores its prior callback on stop', async () => {
  const fixture = await makeFixture();
  let bridge: WebSocket | undefined;
  try {
    await configure(fixture);
    const settings = await dashboardPost(fixture, '/api/settings', { number: DEFAULT_NUMBER, model: 'gpt-live-1', greeting: 'Hello there.', instructions: 'Short answers only.' });
    assert.equal(settings.response.status, 200);
    await goLive(fixture);

    assert.equal(fixture.sent.routeBodies.length, 1);
    assert.deepEqual(Object.keys(fixture.sent.routeBodies[0]).sort(), ['callback_url', 'number']);
    assert.equal(fixture.sent.routeBodies[0].number, DEFAULT_NUMBER, 'existing selected number is required in routing body');
    const callbackUrl = String(fixture.sent.routeBodies[0].callback_url);
    assert.match(callbackUrl, /^http:\/\/127\.0\.0\.1:\d+\/voice\/[0-9a-f]{48}$/);
    assert.deepEqual(fixture.sent.testCallbacks[0].body, { action: { action: 'connectToUser', identity: (await dashboardGet(fixture, '/api/state')).body.identity } }, 'fake Sent /test used a real signed probe to the installed URL');

    const backupFile = path.join(fixture.dataDir, 'routing-backup.json');
    assert.equal((await stat(backupFile)).mode & 0o777, 0o600);
    const missingSignature = await fetch(callbackUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
    assert.equal(missingSignature.status, 401);
    const malformed = Buffer.from('{broken');
    const malformedResponse = await fetch(callbackUrl, { method: 'POST', headers: signCallback(malformed, 'evt-malformed'), body: malformed });
    assert.equal(malformedResponse.status, 400);

    const outgoing = await signedCallback(callbackUrl, { ...BASE_CALL, callId: 'outgoing', direction: 'outbound' }, 'evt-outgoing');
    assert.deepEqual(outgoing.body, { action: { action: 'reject', reason: 'declined' } });

    await dashboardPost(fixture, '/api/heartbeat', { registered: true, busy: true });
    const busyFromHeartbeat = await signedCallback(callbackUrl, { ...BASE_CALL, callId: 'busy-heartbeat' }, 'evt-busy-heartbeat');
    assert.deepEqual(busyFromHeartbeat.body, { action: { action: 'reject', reason: 'busy' } });
    await dashboardPost(fixture, '/api/heartbeat', { registered: true, busy: false });

    const accepted = await signedCallback(callbackUrl, { ...BASE_CALL, callId: 'provider-call-1' }, 'evt-accepted');
    const repeated = await signedCallback(callbackUrl, { ...BASE_CALL, callId: 'provider-call-1' }, 'evt-accepted-retry');
    const concurrent = await signedCallback(callbackUrl, { ...BASE_CALL, callId: 'provider-call-2' }, 'evt-concurrent');
    assert.deepEqual(repeated.body, accepted.body, 'retry for the same provider call receives the cached answer');
    assert.equal((accepted.body?.action as Record<string, unknown>).action, 'connectToUser');
    await waitFor(() => fixture.openai.sessions.length === 2, 'model session pre-warmed when Sent accepted the call (preflight + warm)');
    assert.deepEqual(concurrent.body, { action: { action: 'reject', reason: 'busy' } }, 'reservation makes a second incoming call busy');
    const synthetic = await signedCallback(callbackUrl, { ...BASE_CALL, callId: 'manual-synthetic', direction: 'outbound', test: true }, 'evt-synthetic-manual');
    assert.equal((synthetic.body?.action as Record<string, unknown>).action, 'connectToUser', 'synthetic test remains harmless and routable');

    await expectBridgeRejected(fixture, fixture.csrf, 'http://127.0.0.1:1');
    await expectBridgeRejected(fixture, 'not-the-csrf-token', fixture.base);
    bridge = await openBridge(fixture);
    const messages = observe(bridge);
    bridge.send(JSON.stringify({ type: 'start', callId: 'provider-call-1' }));
    const ready = await messages.wait(message => parseJson(message)?.type === 'ready', 'bridge ready');
    assert.equal(parseJson(ready)?.model, 'gpt-live-1');
    assert.equal(fixture.openai.sessions.length, 2, 'the bridge adopted the pre-warmed session instead of opening another');
    const liveSession = fixture.openai.sessions.at(-1)!;
    assert.equal(liveSession.path, '/v1/live/sessions');
    assert.equal(liveSession.events[0].type, 'session.start');

    const incomingPcm = Buffer.from([0, 1, 2, 3]);
    bridge.send(incomingPcm);
    await waitFor(() => liveSession.events.some(event => event.type === 'session.input_audio.append'), 'PCM append to OpenAI');
    const audioAppend = liveSession.events.find(event => event.type === 'session.input_audio.append')!;
    assert.equal(audioAppend.audio, incomingPcm.toString('base64'));

    fixture.openai.send(liveSession, { type: 'session.output_audio.delta', item_id: 'output-1', delta: Buffer.from([4, 5, 6, 7]).toString('base64') });
    fixture.openai.send(liveSession, { type: 'session.input_transcript.delta', delta: 'Caller words', start_ms: 1, end_ms: 2 });
    fixture.openai.send(liveSession, { type: 'session.output_transcript.delta', delta: 'Agent words', start_ms: 3, end_ms: 4 });
    assert.equal(parseJson(await messages.wait(message => parseJson(message)?.type === 'audio-meta', 'audio metadata'))?.itemId, 'output-1');
    assert.deepEqual((await messages.wait(message => message.binary && message.data.equals(Buffer.from([4, 5, 6, 7])), 'output PCM')).data, Buffer.from([4, 5, 6, 7]));
    assert.equal(parseJson(await messages.wait(message => parseJson(message)?.text === 'Caller words', 'caller transcript'))?.speaker, 'caller');
    assert.equal(parseJson(await messages.wait(message => parseJson(message)?.text === 'Agent words', 'agent transcript'))?.speaker, 'agent');
    const logged = (await dashboardGet(fixture, '/api/state')).body.events as Array<{ id: number; text: string }>;
    assert.equal(logged.some(item => item.text.includes('Caller words') || item.text.includes('Agent words')), false, 'transcript fragments stay out of the bounded event log');
    assert.ok(logged.some(item => item.text.includes('pre-warmed')), 'the event log records that the warm session was used');
    assert.deepEqual(logged.map(item => item.id), [...logged.map(item => item.id)].sort((a, b) => a - b), 'event ids increase');

    bridge.close();
    await waitFor(() => liveSession.events.some(event => event.type === 'session.close'), 'graceful session.close after media disconnect');
    await waitFor(() => fixture.runtime.state().active === undefined, 'active call cleanup');
    bridge = undefined;

    const stopped = await dashboardPost(fixture, '/api/stop', {});
    assert.equal(stopped.response.status, 200);
    assert.deepEqual(fixture.sent.patchBodies.at(-1), { number: DEFAULT_NUMBER, body: { callback_url: 'https://old.example/callback' } });
    assert.equal(fixture.sent.numbers.get(DEFAULT_NUMBER)?.callback_url, 'https://old.example/callback');
    await assert.rejects(stat(backupFile));
    assert.equal(fixture.tunnelStops, 1);
  } finally {
    bridge?.terminate();
    await fixture.dispose();
  }
});

test('stop preserves a callback changed externally rather than overwriting it and clears the obsolete backup', async () => {
  const fixture = await makeFixture();
  try {
    await configure(fixture);
    await goLive(fixture);
    fixture.sent.changeExternally(DEFAULT_NUMBER, 'https://someone-else.example/new-routing');

    const stopped = await dashboardPost(fixture, '/api/stop', {});
    assert.equal(stopped.response.status, 200);
    assert.equal(fixture.sent.patchBodies.length, 0, 'external routing is never overwritten');
    assert.equal(fixture.sent.numbers.get(DEFAULT_NUMBER)?.callback_url, 'https://someone-else.example/new-routing');
    assert.match(String((await dashboardGet(fixture, '/api/state')).body.warning), /changed outside this app/);
    await assert.rejects(stat(path.join(fixture.dataDir, 'routing-backup.json')));
  } finally {
    await fixture.dispose();
  }
});

test('OpenAI Live uses session.start/session.started without a query, emits audio and delegates through local responses', async () => {
  const fake = new FakeOpenAi();
  await fake.start();
  try {
    const emitted: Array<ModelEvent | Buffer> = [];
    const voice = new OpenAIVoice({ key: OPENAI_KEY, model: 'gpt-live-1', instructions: 'No tools.', greeting: 'Hi.', httpBase: fake.httpBase, wsBase: fake.wsBase }, event => emitted.push(event));
    await voice.connect();
    const session = fake.sessions[0];
    assert.equal(session.path, '/v1/live/sessions');
    assert.equal(session.events[0].type, 'session.start');
    assert.equal((session.events[0].session as Record<string, unknown>).model, 'gpt-live-1');

    voice.audio(Buffer.from([9, 8, 7]));
    await waitFor(() => session.events.some(event => event.type === 'session.input_audio.append'), 'Live audio append');
    assert.equal(session.events.find(event => event.type === 'session.input_audio.append')?.audio, Buffer.from([9, 8]).toString('base64'), 'odd PCM byte is held for the next packet');
    voice.greet();
    await waitFor(() => session.events.some(event => event.type === 'session.instructions.append'), 'Live greeting instruction');

    fake.send(session, { type: 'session.output_audio.delta', item_id: 'audio-item', delta: Buffer.from([1, 2]).toString('base64') });
    fake.send(session, { type: 'session.input_transcript.delta', delta: 'Need help' });
    fake.send(session, { type: 'session.delegation.created', delegation: { target: 'client', id: 'delegate-1' } });
    await waitFor(() => fake.responseBodies.length === 1, 'delegated /v1/responses call');
    assert.equal(fake.responseBodies[0].model, 'gpt-6-luna');
    assert.deepEqual(fake.responseBodies[0].reasoning, { effort: 'none' });
    await waitFor(() => session.events.some(event => event.type === 'session.commentary.append'), 'delegated commentary');
    assert.equal((session.events.find(event => event.type === 'session.commentary.append')?.content), 'A short safe answer.');
    assert.equal(emitted.some(event => Buffer.isBuffer(event) && event.equals(Buffer.from([1, 2]))), true);
    assert.equal(emitted.some(event => !Buffer.isBuffer(event) && event.type === 'transcript' && event.speaker === 'caller'), true);

    await voice.close();
    assert.equal(session.events.some(event => event.type === 'session.close'), true);
  } finally {
    await fake.close();
  }
});

test('OpenAI GA realtime accepts session.update/session.updated and uses the model query only for realtime', async () => {
  const fake = new FakeOpenAi();
  await fake.start();
  try {
    const voice = new OpenAIVoice({ key: OPENAI_KEY, model: 'gpt-realtime-2.1', instructions: 'No tools.', greeting: 'Hi.', wsBase: fake.wsBase }, () => {});
    await voice.connect();
    const session = fake.sessions[0];
    assert.equal(session.path, '/v1/realtime?model=gpt-realtime-2.1');
    assert.equal(session.events[0].type, 'session.update');
    const sessionConfig = session.events[0].session as any;
    assert.equal(sessionConfig.audio.input.transcription.model, 'gpt-live-transcribe');
    await voice.close();
  } finally {
    await fake.close();
  }
});

test('OpenAI preflight reports unavailable models, HTTP upgrade refusal, and startup timeout on bounded local fakes', async () => {
  const unavailable = new FakeOpenAi('model-error');
  await unavailable.start();
  try {
    await assert.rejects(preflight({ key: OPENAI_KEY, model: 'gpt-live-1', instructions: 'x', greeting: 'x', wsBase: unavailable.wsBase }), /OpenAI: model is not enabled/);
  } finally {
    await unavailable.close();
  }

  const refusal = http.createServer();
  refusal.on('upgrade', (_req, socket) => { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); });
  const refusalPort = await listen(refusal);
  try {
    const started = Date.now();
    await assert.rejects(preflight({ key: OPENAI_KEY, model: 'gpt-live-1', instructions: 'x', greeting: 'x', wsBase: `ws://127.0.0.1:${refusalPort}` }), /connection refused \(401\)/);
    assert.ok(Date.now() - started < 1_000, 'immediate HTTP refusal never waits for the 15-second model startup timeout');
  } finally {
    await closeHttp(refusal);
  }

  const silent = new FakeOpenAi('silent');
  await silent.start();
  const originalSetTimeout = globalThis.setTimeout;
  (globalThis as typeof globalThis & { setTimeout: typeof setTimeout }).setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => originalSetTimeout(handler, timeout === 15_000 ? 25 : timeout, ...args)) as typeof setTimeout;
  try {
    const started = Date.now();
    await assert.rejects(preflight({ key: OPENAI_KEY, model: 'gpt-live-1', instructions: 'x', greeting: 'x', wsBase: silent.wsBase }), /startup timed out/);
    assert.ok(Date.now() - started < 1_000, 'startup timeout is deterministic and bounded under a fake clock');
  } finally {
    (globalThis as typeof globalThis & { setTimeout: typeof setTimeout }).setTimeout = originalSetTimeout;
    await silent.close();
  }
});

test('a number with no prior callback warns, preserves recovery data, and can reactivate without provisioning', async () => {
  const fixture = await makeFixture();
  try {
    fixture.sent.numbers.get(DEFAULT_NUMBER)!.callback_url = null;
    await configure(fixture);
    await goLive(fixture);
    assert.equal((await dashboardPost(fixture, '/api/stop', {})).response.status, 200);
    assert.equal(fixture.sent.patchBodies.length, 0, 'no unsupported null callback PATCH is attempted');
    assert.ok(fixture.runtime.state().backup, 'backup remains recoverable when previous URL was absent');
    assert.match(String((await dashboardGet(fixture, '/api/state')).body.warning), /no previous callback URL/);
    await goLive(fixture);
    assert.equal(fixture.runtime.state().backup?.previousUrl, null, 'reactivation preserves the true initially empty route');
    assert.ok(fixture.sent.routeBodies.every(body => body.number === DEFAULT_NUMBER));

    assert.equal((await dashboardPost(fixture, '/api/forget-backup', {})).response.status, 400, 'a backup cannot be forgotten while answering');
    assert.equal((await dashboardPost(fixture, '/api/stop', {})).response.status, 200);
    assert.deepEqual((await dashboardGet(fixture, '/api/state')).body.routingBackup, { number: DEFAULT_NUMBER, previousUrl: null });
    await dashboardPost(fixture, '/api/settings', { number: OTHER_NUMBER, model: 'gpt-realtime-2.1', greeting: 'Hi.', instructions: 'x' });
    await dashboardPost(fixture, '/api/prepare', {});
    await dashboardPost(fixture, '/api/heartbeat', { registered: true, busy: false });
    const blocked = await dashboardPost(fixture, '/api/activate', {});
    assert.match(String(blocked.body.error), /needs recovery/, 'an unrestorable backup blocks every other number until forgotten');
    await dashboardPost(fixture, '/api/stop', {});
    assert.equal((await dashboardPost(fixture, '/api/forget-backup', {})).response.status, 200);
    const afterForget = await dashboardGet(fixture, '/api/state');
    assert.equal(afterForget.body.routingBackup, null);
    assert.ok((afterForget.body.events as Array<{ text: string }>).some(item => item.text.startsWith(`Forgot the routing backup for ${DEFAULT_NUMBER}. It had no previous callback.`)));
    await goLive(fixture); // another number can be activated after forgetting
  } finally { await fixture.dispose(); }
});

test('a Sent registration outage declines new calls as busy but keeps routing while the tab is alive', async () => {
  const fixture = await makeFixture();
  try {
    await configure(fixture);
    await goLive(fixture);
    const callbackUrl = String(fixture.sent.routeBodies[0].callback_url);

    await dashboardPost(fixture, '/api/heartbeat', { registered: false, busy: false });
    assert.deepEqual((await signedCallback(callbackUrl, { ...BASE_CALL, callId: 'during-outage' })).body, { action: { action: 'reject', reason: 'busy' } });
    await delay(2_300); // At least one 2-second watchdog tick, well inside the 7-second liveness window.
    assert.equal(fixture.runtime.state().phase, 'answering', 'the watchdog stops only when the tab itself goes quiet');
    assert.equal(fixture.sent.patchBodies.length, 0, 'routing is not restored during an SDK outage');

    await dashboardPost(fixture, '/api/heartbeat', { registered: true, busy: false });
    assert.equal(((await signedCallback(callbackUrl, { ...BASE_CALL, callId: 'after-outage' })).body?.action as Record<string, unknown>).action, 'connectToUser');
  } finally { await fixture.dispose(); }
});

test('a Realtime call saves take_message to a private messages.jsonl and forwards end_call to the browser', async () => {
  const fixture = await makeFixture();
  let bridge: WebSocket | undefined;
  try {
    await configure(fixture);
    await goLive(fixture);
    bridge = await openBridge(fixture);
    const messages = observe(bridge);
    bridge.send(JSON.stringify({ type: 'start', callId: 'local-correlation' }));
    await messages.wait(message => parseJson(message)?.type === 'ready', 'bridge ready');
    const session = fixture.openai.sessions.at(-1)!;

    fixture.openai.send(session, { type: 'response.output_item.done', item: { type: 'function_call', status: 'completed', name: 'take_message', call_id: 'm1', arguments: JSON.stringify({ caller_name: 'Ada', callback_number: '+15550100', message: 'Call me back about pricing.' }) } });
    fixture.openai.send(session, { type: 'response.done' });
    await waitFor(() => session.events.some(event => event.type === 'response.create'), 'follow-up response after saving');
    const file = path.join(fixture.dataDir, 'messages.jsonl');
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    const record = JSON.parse((await readFile(file, 'utf8')).trim());
    assert.equal(record.number, DEFAULT_NUMBER);
    assert.equal(record.callerName, 'Ada');
    assert.equal(record.message, 'Call me back about pricing.');
    const logged = (await dashboardGet(fixture, '/api/state')).body.events as Array<{ kind: string; text: string }>;
    assert.ok(logged.some(item => item.kind === 'message' && item.text === 'Ada (+15550100): Call me back about pricing.'));

    fixture.openai.send(session, { type: 'response.output_item.done', item: { type: 'function_call', status: 'completed', name: 'end_call', call_id: 'm2', arguments: '{}' } });
    fixture.openai.send(session, { type: 'response.done' });
    await waitFor(() => session.events.some(event => event.type === 'response.create' && (event.response as any)?.tool_choice === 'none'), 'app-prompted goodbye');
    fixture.openai.send(session, { type: 'response.done', response: { status: 'completed' } });
    assert.equal(parseJson(await messages.wait(message => parseJson(message)?.type === 'end-call', 'end-call forwarded to the browser'))?.reason, 'agent');
  } finally {
    bridge?.terminate();
    await fixture.dispose();
  }
});

test('Realtime barge-in lets the server cancel, clears local playback, and truncates once at the rendered audio position', async () => {
  const fake = new FakeOpenAi(); await fake.start();
  const events: Array<ModelEvent | Buffer> = [];
  const voice = new OpenAIVoice({ key: OPENAI_KEY, model: 'gpt-realtime-2.1', instructions: 'Be concise.', greeting: 'Hi.', wsBase: fake.wsBase }, event => events.push(event));
  try {
    await voice.connect();
    const session = fake.sessions[0];
    assert.equal((session.events[0].session as any).audio.input.turn_detection.interrupt_response, true, 'the server cancels generation itself, so no client cancel can race response.done');
    assert.deepEqual((session.events[0].session as any).reasoning, { effort: 'low' }, 'OpenAI recommends low reasoning effort for production voice agents');
    fake.send(session, { type: 'response.output_audio.delta', item_id: 'spoken-item', delta: Buffer.from([1, 2]).toString('base64') });
    await waitFor(() => events.some(event => !Buffer.isBuffer(event) && event.type === 'audio-meta'), 'Realtime output metadata');
    voice.reportPlayback('spoken-item', 123.7);
    fake.send(session, { type: 'input_audio_buffer.speech_started' });
    await waitFor(() => session.events.some(event => event.type === 'conversation.item.truncate'), 'playback truncation');
    assert.equal(events.some(event => !Buffer.isBuffer(event) && event.type === 'clear'), true);
    assert.deepEqual(session.events.find(event => event.type === 'conversation.item.truncate'), { type: 'conversation.item.truncate', item_id: 'spoken-item', content_index: 0, audio_end_ms: 123 });
    fake.send(session, { type: 'input_audio_buffer.speech_started' });
    await delay(10);
    assert.equal(session.events.filter(event => event.type === 'conversation.item.truncate').length, 1, 'an already truncated item is not truncated again');
    assert.equal(session.events.some(event => event.type === 'response.cancel'), false);
  } finally { await voice.close(); await fake.close(); }
});

test('only fatal OpenAI error codes end the call; request-level errors seen on the live API become notices', async () => {
  const fake = new FakeOpenAi(); await fake.start();
  const events: Array<ModelEvent | Buffer> = [];
  const voice = new OpenAIVoice({ key: OPENAI_KEY, model: 'gpt-realtime-2.1', instructions: 'x', greeting: 'x', wsBase: fake.wsBase }, event => events.push(event));
  try {
    await voice.connect();
    const session = fake.sessions[0];
    // Exact shapes returned by the real Realtime API when a cancel or truncate races the response lifecycle.
    fake.send(session, { type: 'error', error: { type: 'invalid_request_error', code: 'response_cancel_not_active', message: 'Cancellation failed: no active response found' } });
    fake.send(session, { type: 'error', error: { type: 'invalid_request_error', code: 'item_truncate_invalid_item_id', message: 'Item with item_id not found: x' } });
    fake.send(session, { type: 'error', error: { type: 'invalid_request_error', code: 'session_expired', message: 'Your session hit the maximum duration.' } });
    // Billing failures per OpenAI's error-codes guide: a specific code, or only `type: insufficient_quota`.
    fake.send(session, { type: 'error', error: { type: 'insufficient_quota', code: 'credit_balance_exhausted', message: 'Credit balance exhausted.' } });
    fake.send(session, { type: 'error', error: { type: 'insufficient_quota', code: null, message: 'Quota exceeded.' } });
    await waitFor(() => events.filter(event => !Buffer.isBuffer(event) && (event.type === 'notice' || event.type === 'error')).length === 5, 'five classified errors');
    const kinds = events.filter((event): event is ModelEvent => !Buffer.isBuffer(event)).map(event => `${event.type}:${event.message}`);
    assert.deepEqual(kinds, [
      'notice:OpenAI: Cancellation failed: no active response found',
      'notice:OpenAI: Item with item_id not found: x',
      'error:OpenAI: Your session hit the maximum duration.',
      'error:OpenAI: Credit balance exhausted.',
      'error:OpenAI: Quota exceeded.',
    ]);
  } finally { await voice.close(); await fake.close(); }
});

test('take_message saves before the model continues, end_call waits for the goodbye response, and silence ends the call', async () => {
  const fake = new FakeOpenAi(); await fake.start();
  const events: Array<ModelEvent | Buffer> = [];
  const saved: unknown[] = [];
  let finishSave!: () => void;
  const voice = new OpenAIVoice({
    key: OPENAI_KEY, model: 'gpt-realtime-2.1', instructions: 'x', greeting: 'Hi.', wsBase: fake.wsBase, idleTimeoutMs: 60,
    saveMessage: message => { saved.push(message); return new Promise<void>(resolve => { finishSave = resolve; }); },
  }, event => events.push(event));
  const endCalls = () => events.filter((event): event is ModelEvent => !Buffer.isBuffer(event) && event.type === 'end-call');
  try {
    await voice.connect();
    const session = fake.sessions[0];
    assert.deepEqual((session.events[0].session as any).tools.map((tool: { name: string }) => tool.name), ['take_message', 'end_call']);

    fake.send(session, { type: 'response.output_item.done', item: { type: 'function_call', status: 'completed', name: 'take_message', call_id: 'call-1', arguments: JSON.stringify({ caller_name: ' Ada ', callback_number: '+1 555 0100', message: 'Please call me back.' }) } });
    // response.done arrives while the save is still pending: the follow-up must wait for it.
    fake.send(session, { type: 'response.done' });
    await waitFor(() => saved.length === 1, 'saveMessage call');
    await delay(20);
    assert.equal(session.events.some(event => event.type === 'response.create'), false, 'no follow-up before the message is saved');
    finishSave();
    await waitFor(() => session.events.some(event => event.type === 'response.create'), 'follow-up response after save');
    assert.deepEqual(saved[0], { callerName: 'Ada', callbackNumber: '+1 555 0100', message: 'Please call me back.' });
    const output = session.events.find(event => event.type === 'conversation.item.create')!.item as Record<string, unknown>;
    assert.deepEqual(output, { type: 'function_call_output', call_id: 'call-1', output: JSON.stringify({ saved: true }) });
    assert.ok(session.events.findIndex(event => event.type === 'conversation.item.create') < session.events.findIndex(event => event.type === 'response.create'), 'tool output precedes the follow-up');

    // The caller interrupts the goodbye: the cancelled response reports its end_call item as incomplete.
    fake.send(session, { type: 'response.output_item.done', item: { type: 'function_call', status: 'incomplete', name: 'end_call', call_id: 'call-cut', arguments: '{}' } });
    fake.send(session, { type: 'response.done', response: { status: 'cancelled' } });
    await delay(20);
    assert.equal(endCalls().length, 0, 'an interrupted end_call must not hang up');

    // end_call → the app answers it and asks for the goodbye itself (tools off); the call ends once that has played.
    const goodbyes = () => session.events.filter(event => event.type === 'response.create' && (event.response as any)?.tool_choice === 'none');
    fake.send(session, { type: 'response.output_item.done', item: { type: 'function_call', status: 'completed', name: 'end_call', call_id: 'call-2', arguments: '{}' } });
    fake.send(session, { type: 'response.done' });
    await waitFor(() => goodbyes().length === 1, 'app-prompted goodbye');
    assert.match(String((goodbyes()[0].response as any).instructions), /goodbye/i);
    assert.ok(session.events.some(event => event.type === 'conversation.item.create' && (event.item as any).call_id === 'call-2'), 'end_call is answered before the goodbye');
    assert.equal(endCalls().length, 0, 'the goodbye must play before hanging up');
    fake.send(session, { type: 'response.done', response: { status: 'cancelled' } });
    await delay(20);
    assert.equal(endCalls().length, 0, 'a caller cutting into the goodbye ("wait, one more thing") keeps the call open');

    fake.send(session, { type: 'response.output_item.done', item: { type: 'function_call', status: 'completed', name: 'end_call', call_id: 'call-3', arguments: '{}' } });
    fake.send(session, { type: 'response.done' });
    await waitFor(() => goodbyes().length === 2, 'second goodbye');
    fake.send(session, { type: 'response.done', response: { status: 'completed' } });
    await waitFor(() => endCalls().length === 1, 'agent end-call after the goodbye played');
    assert.equal(endCalls()[0].reason, 'agent');

    voice.greet();
    await waitFor(() => endCalls().length === 2, 'silence end-call', 1_000);
    assert.equal(endCalls()[1].reason, 'silence');
  } finally { await voice.close(); await fake.close(); }
});

test('latest Realtime Mini uses the GA audio path and handles streaming transcripts without duplicate completed text', async () => {
  const fake = new FakeOpenAi(); await fake.start();
  const emitted: Array<ModelEvent | Buffer> = [];
  const voice = new OpenAIVoice({ key: OPENAI_KEY, model: 'gpt-realtime-2.1-mini', transcriptionModel: 'gpt-transcribe', instructions: 'Short answers.', greeting: 'Hi.', wsBase: fake.wsBase }, event => emitted.push(event));
  try {
    await voice.connect();
    const session = fake.sessions[0];
    assert.equal(session.path, '/v1/realtime?model=gpt-realtime-2.1-mini');
    assert.equal((session.events[0].session as any).audio.input.transcription.model, 'gpt-transcribe');
    voice.audio(Buffer.from([1, 2])); voice.greet();
    await waitFor(() => session.events.some(e => e.type === 'input_audio_buffer.append'), 'Mini PCM append');
    assert.ok(session.events.some(e => e.type === 'response.create'));
    fake.send(session, { type: 'conversation.item.input_audio_transcription.delta', item_id: 'caller1', content_index: 0, delta: 'Hello ' });
    fake.send(session, { type: 'conversation.item.input_audio_transcription.delta', item_id: 'caller1', content_index: 0, delta: 'there' });
    fake.send(session, { type: 'conversation.item.input_audio_transcription.completed', item_id: 'caller1', content_index: 0, transcript: 'Hello there.' });
    await waitFor(() => emitted.some(e => !Buffer.isBuffer(e) && e.type === 'transcript-final'), 'transcript final metadata');
    const callerText = emitted.filter(e => !Buffer.isBuffer(e) && e.type === 'transcript' && e.speaker === 'caller').map(e => (e as ModelEvent).text).join('');
    assert.equal(callerText, 'Hello there.', 'streamed text plus final suffix appears exactly once');
    fake.send(session, { type: 'conversation.item.input_audio_transcription.completed', item_id: 'caller2', content_index: 0, transcript: 'Final only.' });
    await waitFor(() => emitted.some(e => !Buffer.isBuffer(e) && e.type === 'transcript' && e.text === 'Final only.'), 'completed-only input');
    assert.equal(fake.responseBodies.length, 0, 'Realtime never invokes GPT-6 helper');
  } finally { await voice.close(); await fake.close(); }
});

test('each Live helper model uses the lowest reasoning effort it accepts, with a matching output budget', async () => {
  for (const [backendModel, effort, budget] of [['gpt-6-sol', 'none', 600], ['gpt-5.4-mini', 'none', 600], ['gpt-6-astra', 'low', 2000]] as const) {
    const fake = new FakeOpenAi(); await fake.start();
    const voice = new OpenAIVoice({ key: OPENAI_KEY, model: 'gpt-live-1', backendModel, instructions: 'Safe concise facts.', greeting: 'Hi.', wsBase: fake.wsBase, httpBase: fake.httpBase }, () => {});
    try {
      await voice.connect(); const session = fake.sessions[0];
      fake.send(session, { type: 'session.input_transcript.delta', delta: 'Please help.' });
      fake.send(session, { type: 'session.delegation.created', delegation: { target: 'client', id: 'quality-helper' } });
      await waitFor(() => fake.responseBodies.length === 1, `${backendModel} delegation`);
      assert.equal(fake.responseBodies[0].model, backendModel);
      assert.deepEqual(fake.responseBodies[0].reasoning, { effort });
      assert.equal(fake.responseBodies[0].max_output_tokens, budget);
      assert.equal((session.events[0].session as any).audio.format.rate, 24000, 'text backend never replaces voice transport');
    } finally { await voice.close(); await fake.close(); }
  }
});

test('model settings retain independent current voice, ASR, and Live backend selections and reject cross-role IDs', async () => {
  const fixture = await makeFixture();
  try {
    await configure(fixture);
    const settings = { number: DEFAULT_NUMBER, model: 'gpt-realtime-2.1-mini', transcriptionModel: 'gpt-transcribe', backendModel: 'gpt-6-sol', greeting: 'Hi.', instructions: 'Be concise.' };
    assert.equal((await dashboardPost(fixture, '/api/settings', settings)).response.status, 200);
    const state = (await dashboardGet(fixture, '/api/state')).body;
    assert.equal(state.model, settings.model); assert.equal(state.backendModel, settings.backendModel); assert.equal(state.transcriptionModel, settings.transcriptionModel);
    assert.equal((await dashboardPost(fixture, '/api/settings', { ...settings, model: 'gpt-6-astra' })).response.status, 400);
    assert.equal((await dashboardPost(fixture, '/api/settings', { ...settings, backendModel: 'gpt-realtime-2.1' })).response.status, 400);
    assert.equal((await dashboardPost(fixture, '/api/settings', { ...settings, transcriptionModel: 'gpt-live-1' })).response.status, 400);
    assert.equal((await dashboardPost(fixture, '/api/prepare', {})).response.status, 200);
    const session = fixture.openai.sessions[0];
    assert.equal(session.path, '/v1/realtime?model=gpt-realtime-2.1-mini');
    assert.equal((session.events[0].session as any).audio.input.transcription.model, 'gpt-transcribe');
  } finally { await fixture.dispose(); }
});
