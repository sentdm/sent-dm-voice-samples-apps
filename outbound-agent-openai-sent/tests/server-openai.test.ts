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
const CONTACT = '+14155550123';
const TEST_CONTACT = '+14155559999';
const QUESTION = { type: 'call.request', version: '1', number: DEFAULT_NUMBER, timestamp: '2026-01-01T00:00:00.000Z' };
/** The question Sent sends when the dashboard's tab (`identity`) places a call with connect({ to }). */
const outboundCall = (identity: string, overrides: Record<string, unknown> = {}) => ({ ...QUESTION, direction: 'outbound', from: { kind: 'user', identity }, to: { kind: 'number', number: CONTACT }, ...overrides });
const INBOUND_CALL = { ...QUESTION, callId: 'call_inbound', direction: 'inbound', from: { kind: 'number', number: CONTACT }, to: { kind: 'number', number: DEFAULT_NUMBER } };
const dialed = (to: string) => ({ action: { action: 'connectToNumber', number: to, callerId: DEFAULT_NUMBER, dialTimeoutSeconds: 30 } });
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
      // The shape of Sent's test question: an app user calling a phone number, flagged as a test.
      const payload = Buffer.from(JSON.stringify({ type: 'call.request', version: '1', callId: 'sent-synthetic-test', number, timestamp: '2026-01-01T00:00:00.000Z', direction: 'outbound', from: { kind: 'user', identity: 'sent-test-user' }, to: { kind: 'number', number: TEST_CONTACT }, test: true }));
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
  assert.equal((await dashboardPost(fixture, '/api/heartbeat', { registered: true })).response.status, 200);
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

async function identityOf(fixture: Fixture): Promise<string> {
  return String((await dashboardGet(fixture, '/api/state')).body.identity);
}

/** The dashboard's Call: opens the bridge, asks for the number, and waits until the model is ready to dial. */
async function startCall(fixture: Fixture, to = CONTACT) {
  const bridge = await openBridge(fixture);
  const messages = observe(bridge);
  bridge.send(JSON.stringify({ type: 'start', to, consent: true }));
  const ready = parseJson(await messages.wait(message => parseJson(message)?.type === 'ready', 'bridge ready'));
  return { bridge, messages, ready, session: fixture.openai.sessions.at(-1)! };
}

/** A Call that the server refuses: resolves to its reason. */
async function refusedStart(fixture: Fixture, start: Record<string, unknown>): Promise<string> {
  const bridge = await openBridge(fixture);
  const replies = observe(bridge);
  bridge.send(JSON.stringify({ type: 'start', ...start }));
  const reason = String(parseJson(await replies.wait(message => parseJson(message)?.type === 'error', 'refused start'))?.message);
  bridge.terminate();
  return reason;
}

const actionOf = (reply: { body: Record<string, unknown> | null }): unknown => (reply.body?.action as Record<string, unknown>).action;

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
    const settings = await dashboardPost(fixture, '/api/settings', { number: OTHER_NUMBER, model: 'gpt-live-1', greeting: 'Hi there.', instructions: 'Do not use tools.' });
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
    assert.deepEqual(fixture.sent.tokenBodies[0], { identity: configured.body.identity, number: OTHER_NUMBER, ttl: 600 }, 'the voice token binds the identity to the caller-ID number for ten minutes');

    const prematureActivation = await dashboardPost(fixture, '/api/activate', {});
    assert.equal(prematureActivation.response.status, 400, 'activation requires a current browser heartbeat');
    const heartbeat = await dashboardPost(fixture, '/api/heartbeat', { registered: true });
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

test('activation signs the actual Sent callback, dials only the requested number and only once, sends audio only after the answer, and restores its prior callback on stop', async () => {
  const fixture = await makeFixture();
  let bridge: WebSocket | undefined;
  try {
    await configure(fixture);
    const settings = await dashboardPost(fixture, '/api/settings', { number: DEFAULT_NUMBER, model: 'gpt-live-1', greeting: 'Hello there.', instructions: 'Short answers only.' });
    assert.equal(settings.response.status, 200);
    await goLive(fixture);
    const identity = await identityOf(fixture);
    assert.equal(fixture.runtime.state().phase, 'ready');

    assert.equal(fixture.sent.routeBodies.length, 1);
    assert.deepEqual(Object.keys(fixture.sent.routeBodies[0]).sort(), ['callback_url', 'number']);
    assert.equal(fixture.sent.routeBodies[0].number, DEFAULT_NUMBER, 'existing selected number is required in routing body');
    const callbackUrl = String(fixture.sent.routeBodies[0].callback_url);
    assert.match(callbackUrl, /^http:\/\/127\.0\.0\.1:\d+\/voice\/[0-9a-f]{48}$/);
    assert.deepEqual(fixture.sent.testCallbacks[0].body, dialed(TEST_CONTACT), 'fake Sent /test used a real signed probe and got a full answer, caller ID included');

    const backupFile = path.join(fixture.dataDir, 'routing-backup.json');
    assert.equal((await stat(backupFile)).mode & 0o777, 0o600);
    const missingSignature = await fetch(callbackUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
    assert.equal(missingSignature.status, 401);
    const malformed = Buffer.from('{broken');
    const malformedResponse = await fetch(callbackUrl, { method: 'POST', headers: signCallback(malformed, 'evt-malformed'), body: malformed });
    assert.equal(malformedResponse.status, 400);

    const inbound = await signedCallback(callbackUrl, INBOUND_CALL);
    assert.equal(actionOf(inbound), 'reject', 'inbound calls to the number are turned away while the agent runs');
    const unrequested = await signedCallback(callbackUrl, outboundCall(identity, { callId: 'call_unrequested' }));
    assert.equal(actionOf(unrequested), 'reject', 'nothing is dialed that the dashboard did not ask for');

    for (const [start, reason] of [
      [{ to: '415 555 0123', consent: true }, /international format/],
      [{ to: CONTACT }, /permission to call/],
      [{ to: DEFAULT_NUMBER, consent: true }, /its own Sent number/],
    ] as const) assert.match(await refusedStart(fixture, start), reason);
    assert.equal(fixture.openai.sessions.length, 1, 'a refused start never opens a model session (only the preflight did)');
    assert.equal(fixture.runtime.state().pendingDial, undefined);

    await expectBridgeRejected(fixture, fixture.csrf, 'http://127.0.0.1:1');
    await expectBridgeRejected(fixture, 'not-the-csrf-token', fixture.base);
    const call = await startCall(fixture, '+1 (415) 555-0123');
    bridge = call.bridge;
    const { messages, session: liveSession } = call;
    assert.equal(call.ready?.model, 'gpt-live-1');
    assert.equal(fixture.runtime.state().pendingDial?.to, CONTACT, 'the typed number is normalized before it is matched');
    assert.equal(liveSession.path, '/v1/live/sessions');
    assert.match(String((liveSession.events[0].session as Record<string, unknown>).instructions), /When the contact has greeted you or finished their first sentence, open with: “Hello there\.”/);

    const otherUser = await signedCallback(callbackUrl, outboundCall('another-app-user', { callId: 'call_other_user' }));
    assert.equal(actionOf(otherUser), 'reject', 'another app user of the account cannot use the pending dial');
    const otherNumber = await signedCallback(callbackUrl, outboundCall(identity, { callId: 'call_other_number', to: { kind: 'number', number: '+14155550124' } }));
    assert.equal(actionOf(otherNumber), 'reject', 'only the requested number is dialed');

    const accepted = await signedCallback(callbackUrl, outboundCall(identity, { callId: 'call_dial_1' }), 'evt-dial');
    const repeated = await signedCallback(callbackUrl, outboundCall(identity, { callId: 'call_dial_1' }), 'evt-dial-retry');
    const reused = await signedCallback(callbackUrl, outboundCall(identity, { callId: 'call_dial_2' }));
    assert.deepEqual(accepted.body, dialed(CONTACT));
    assert.deepEqual(repeated.body, accepted.body, 'a retry of the same question receives the cached answer');
    assert.equal(actionOf(reused), 'reject', 'one request places one call');
    assert.equal(fixture.runtime.state().pendingDial, undefined);

    // Before the answer the line carries ringback: only the frame sent after `answered` reaches the model.
    const incomingPcm = Buffer.from([0, 1, 2, 3]);
    bridge.send(Buffer.from([9, 9, 9, 9]));
    bridge.send(JSON.stringify({ type: 'answered' }));
    bridge.send(incomingPcm);
    await waitFor(() => liveSession.events.some(event => event.type === 'session.input_audio.append'), 'PCM append to OpenAI');
    assert.deepEqual(liveSession.events.filter(event => event.type === 'session.input_audio.append').map(event => event.audio), [incomingPcm.toString('base64')], 'no audio reaches the model before the answer');

    fixture.openai.send(liveSession, { type: 'session.output_audio.delta', item_id: 'output-1', delta: Buffer.from([4, 5, 6, 7]).toString('base64') });
    fixture.openai.send(liveSession, { type: 'session.input_transcript.delta', delta: 'Contact words', start_ms: 1, end_ms: 2 });
    fixture.openai.send(liveSession, { type: 'session.output_transcript.delta', delta: 'Agent words', start_ms: 3, end_ms: 4 });
    assert.equal(parseJson(await messages.wait(message => parseJson(message)?.type === 'audio-meta', 'audio metadata'))?.itemId, 'output-1');
    assert.deepEqual((await messages.wait(message => message.binary && message.data.equals(Buffer.from([4, 5, 6, 7])), 'output PCM')).data, Buffer.from([4, 5, 6, 7]));
    assert.equal(parseJson(await messages.wait(message => parseJson(message)?.text === 'Contact words', 'contact transcript'))?.speaker, 'contact');
    assert.equal(parseJson(await messages.wait(message => parseJson(message)?.text === 'Agent words', 'agent transcript'))?.speaker, 'agent');
    const logged = (await dashboardGet(fixture, '/api/state')).body.events as Array<{ id: number; text: string }>;
    assert.equal(logged.some(item => item.text.includes('Contact words') || item.text.includes('Agent words')), false, 'transcript fragments stay out of the bounded event log');
    assert.ok(logged.some(item => item.text === 'Outbound call call_dial_1: connectToNumber.'));
    assert.ok(logged.some(item => item.text === `${CONTACT} answered.`));
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

test('a dial request that Sent never asks about expires with its bridge, and a second call cannot start while one is active', async () => {
  const fixture = await makeFixture();
  try {
    await configure(fixture);
    await goLive(fixture);
    const first = await startCall(fixture);
    assert.match(await refusedStart(fixture, { to: '+14155550124', consent: true }), /busy or not ready/);
    assert.equal(fixture.runtime.state().pendingDial?.to, CONTACT, 'the refused start leaves the first request as it was');

    first.bridge.close();
    await waitFor(() => fixture.runtime.state().active === undefined, 'cleanup after the dashboard gave up');
    assert.equal(fixture.runtime.state().pendingDial, undefined, 'closing the bridge withdraws the dial request');
    const late = await signedCallback(String(fixture.sent.routeBodies[0].callback_url), outboundCall(await identityOf(fixture), { callId: 'call_late' }));
    assert.equal(actionOf(late), 'reject');
  } finally {
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
    const voice = new OpenAIVoice({ key: OPENAI_KEY, model: 'gpt-live-1', instructions: 'No tools.', greeting: 'Hi.', openingWaitMs: 10, httpBase: fake.httpBase, wsBase: fake.wsBase }, event => emitted.push(event));
    await voice.connect();
    const session = fake.sessions[0];
    assert.equal(session.path, '/v1/live/sessions');
    assert.equal(session.events[0].type, 'session.start');
    assert.equal((session.events[0].session as Record<string, unknown>).model, 'gpt-live-1');

    voice.audio(Buffer.from([7, 7]));
    voice.answered();
    voice.audio(Buffer.from([9, 8, 7]));
    await waitFor(() => session.events.some(event => event.type === 'session.input_audio.append'), 'Live audio append');
    assert.deepEqual(session.events.filter(event => event.type === 'session.input_audio.append').map(event => event.audio), [Buffer.from([9, 8]).toString('base64')], 'audio before the answer is dropped, and an odd PCM byte is held for the next packet');
    await waitFor(() => session.events.some(event => event.type === 'session.instructions.append'), 'Live opening line into silence');

    fake.send(session, { type: 'session.output_audio.delta', item_id: 'audio-item', delta: Buffer.from([1, 2]).toString('base64') });
    fake.send(session, { type: 'session.input_transcript.delta', delta: 'Need help' });
    fake.send(session, { type: 'session.delegation.created', delegation: { target: 'client', id: 'delegate-1' } });
    await waitFor(() => fake.responseBodies.length === 1, 'delegated /v1/responses call');
    assert.equal(fake.responseBodies[0].model, 'gpt-6-luna');
    assert.deepEqual(fake.responseBodies[0].reasoning, { effort: 'none' });
    await waitFor(() => session.events.some(event => event.type === 'session.commentary.append'), 'delegated commentary');
    assert.equal((session.events.find(event => event.type === 'session.commentary.append')?.content), 'A short safe answer.');
    assert.equal(emitted.some(event => Buffer.isBuffer(event) && event.equals(Buffer.from([1, 2]))), true);
    assert.equal(emitted.some(event => !Buffer.isBuffer(event) && event.type === 'transcript' && event.speaker === 'contact'), true);

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

test('the agent lets the contact finish their first sentence, speaks the opening line itself only into silence, then replies at the normal pace', async () => {
  const fake = new FakeOpenAi(); await fake.start();
  const config = { key: OPENAI_KEY, model: 'gpt-realtime-2.1' as const, instructions: 'Be brief.', greeting: 'Hi, this is Sent.', openingWaitMs: 40, wsBase: fake.wsBase };
  const voices: OpenAIVoice[] = [];
  const open = async () => { const voice = new OpenAIVoice(config, () => {}); voices.push(voice); await voice.connect(); return { voice, session: fake.sessions.at(-1)! }; };
  const spoken = (session: ModelSession) => session.events.filter(event => event.type === 'response.create');
  try {
    const ringing = await open();
    assert.match(String((ringing.session.events[0].session as any).instructions), /Be brief\.\n\nWhen the contact has greeted you or finished their first sentence, open with: “Hi, this is Sent\.”/, 'the model knows its opening line if the contact speaks first');
    assert.equal((ringing.session.events[0].session as any).audio.input.turn_detection.silence_duration_ms, 900, 'a pause inside the first words does not end the contact’s turn');
    await delay(100);
    assert.equal(spoken(ringing.session).length, 0, 'nothing is said before the answer');

    const hello = await open();
    hello.voice.answered();
    fake.send(hello.session, { type: 'input_audio_buffer.speech_started' });
    await delay(100);
    assert.equal(spoken(hello.session).length, 0, 'a contact who speaks first is answered by the model, not talked over');

    const silent = await open();
    silent.voice.answered();
    await waitFor(() => spoken(silent.session).length === 1, 'opening line into silence');
    assert.match(String((spoken(silent.session)[0].response as any).instructions), /Say, in English: Hi, this is Sent\. .*Identify yourself as an AI assistant/);
    silent.voice.answered();
    await delay(80);
    assert.equal(spoken(silent.session).length, 1, 'the opening line is spoken once');

    const paceUpdates = () => silent.session.events.filter(event => event.type === 'session.update').slice(1);
    fake.send(silent.session, { type: 'response.done', response: { status: 'cancelled' } });
    await delay(40);
    assert.equal(paceUpdates().length, 0, 'an opening line that the contact cut off keeps the patient first turn');
    fake.send(silent.session, { type: 'response.done', response: { status: 'completed' } });
    await waitFor(() => paceUpdates().length === 1, 'normal pace after the opening line');
    const input = (paceUpdates()[0].session as any).audio.input;
    assert.equal(input.turn_detection.silence_duration_ms, 450);
    assert.equal(input.transcription.model, 'gpt-live-transcribe', 'the update keeps the contact transcription');
    fake.send(silent.session, { type: 'response.done', response: { status: 'completed' } });
    await delay(40);
    assert.equal(paceUpdates().length, 1, 'the pace changes once');
  } finally {
    for (const voice of voices) await voice.close();
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

    assert.equal((await dashboardPost(fixture, '/api/forget-backup', {})).response.status, 400, 'a backup cannot be forgotten while the agent runs');
    assert.equal((await dashboardPost(fixture, '/api/stop', {})).response.status, 200);
    assert.deepEqual((await dashboardGet(fixture, '/api/state')).body.routingBackup, { number: DEFAULT_NUMBER, previousUrl: null });
    await dashboardPost(fixture, '/api/settings', { number: OTHER_NUMBER, model: 'gpt-realtime-2.1', greeting: 'Hi.', instructions: 'x' });
    await dashboardPost(fixture, '/api/prepare', {});
    await dashboardPost(fixture, '/api/heartbeat', { registered: true });
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

test('a Sent registration outage stops dialing but keeps routing while the tab is alive', async () => {
  const fixture = await makeFixture();
  let bridge: WebSocket | undefined;
  try {
    await configure(fixture);
    await goLive(fixture);
    const callbackUrl = String(fixture.sent.routeBodies[0].callback_url);
    const identity = await identityOf(fixture);
    ({ bridge } = await startCall(fixture));

    await dashboardPost(fixture, '/api/heartbeat', { registered: false });
    const during = await signedCallback(callbackUrl, outboundCall(identity, { callId: 'call_during_outage' }));
    assert.equal(actionOf(during), 'reject', 'nothing is dialed while the tab is not registered');
    await delay(2_300); // At least one 2-second watchdog tick, well inside the 7-second liveness window.
    assert.equal(fixture.runtime.state().phase, 'ready', 'the watchdog stops only when the tab itself goes quiet');
    assert.equal(fixture.sent.patchBodies.length, 0, 'routing is not restored during an SDK outage');

    await dashboardPost(fixture, '/api/heartbeat', { registered: true });
    assert.deepEqual((await signedCallback(callbackUrl, outboundCall(identity, { callId: 'call_after_outage' }))).body, dialed(CONTACT));
  } finally {
    bridge?.terminate();
    await fixture.dispose();
  }
});

test('a Realtime call saves record_outcome to a private call-outcomes.jsonl and forwards end_call to the browser', async () => {
  const fixture = await makeFixture();
  let bridge: WebSocket | undefined;
  try {
    await configure(fixture);
    await goLive(fixture);
    const call = await startCall(fixture);
    bridge = call.bridge;
    const { messages, session } = call;

    fixture.openai.send(session, { type: 'response.output_item.done', item: { type: 'function_call', status: 'completed', name: 'record_outcome', call_id: 'o1', arguments: JSON.stringify({ outcome: 'callback_requested', summary: 'Busy now; asked for a call tomorrow.', callback_time: 'tomorrow at 10' }) } });
    fixture.openai.send(session, { type: 'response.done' });
    await waitFor(() => session.events.some(event => event.type === 'response.create'), 'follow-up response after saving');
    const file = path.join(fixture.dataDir, 'call-outcomes.jsonl');
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    const record = JSON.parse((await readFile(file, 'utf8')).trim());
    assert.equal(record.from, DEFAULT_NUMBER);
    assert.equal(record.to, CONTACT);
    assert.equal(record.outcome, 'callback_requested');
    assert.equal(record.summary, 'Busy now; asked for a call tomorrow.');
    assert.equal(record.callbackTime, 'tomorrow at 10');
    const logged = (await dashboardGet(fixture, '/api/state')).body.events as Array<{ kind: string; text: string }>;
    assert.ok(logged.some(item => item.kind === 'outcome' && item.text === `${CONTACT}: callback_requested (call back: tomorrow at 10). Busy now; asked for a call tomorrow.`));

    fixture.openai.send(session, { type: 'response.output_item.done', item: { type: 'function_call', status: 'completed', name: 'end_call', call_id: 'o2', arguments: '{}' } });
    fixture.openai.send(session, { type: 'response.done' });
    await waitFor(() => session.events.some(event => event.type === 'response.create' && (event.response as any)?.tool_choice === 'none'), 'app-prompted goodbye');
    fixture.openai.send(session, { type: 'response.done', response: { status: 'completed' } });
    assert.equal(parseJson(await messages.wait(message => parseJson(message)?.type === 'end-call', 'end-call forwarded to the browser'))?.reason, 'agent');
  } finally {
    bridge?.terminate();
    await fixture.dispose();
  }
});

test('an unanswered attempt ends after the dial window, and the 5-minute limit counts from the answer', async () => {
  const fixture = await makeFixture();
  const originalSetTimeout = globalThis.setTimeout;
  const shorten = (limit: number) => {
    (globalThis as typeof globalThis & { setTimeout: typeof setTimeout }).setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => originalSetTimeout(handler, timeout === limit ? 60 : timeout, ...args)) as typeof setTimeout;
  };
  try {
    await configure(fixture);
    await goLive(fixture);

    shorten(75_000);
    const unanswered = await startCall(fixture);
    await unanswered.messages.wait(message => parseJson(message)?.type === 'closed', 'dial window closed');
    await waitFor(() => fixture.runtime.state().active === undefined, 'cleanup after the dial window');

    shorten(5 * 60_000);
    const answered = await startCall(fixture);
    answered.bridge.send(JSON.stringify({ type: 'answered' }));
    await answered.messages.wait(message => parseJson(message)?.type === 'closed', 'call limit closed');
    await waitFor(() => fixture.runtime.state().active === undefined, 'cleanup after the call limit');

    const logged = ((await dashboardGet(fixture, '/api/state')).body.events as Array<{ text: string }>).map(item => item.text);
    assert.ok(logged.includes('Nobody answered in time; ending the call attempt.'));
    assert.ok(logged.includes('The call reached the 5-minute limit.'));
  } finally {
    (globalThis as typeof globalThis & { setTimeout: typeof setTimeout }).setTimeout = originalSetTimeout;
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

test('record_outcome saves before the model continues and refuses unknown outcomes, end_call waits for the goodbye response, and silence ends the call', async () => {
  const fake = new FakeOpenAi(); await fake.start();
  const events: Array<ModelEvent | Buffer> = [];
  const saved: unknown[] = [];
  let finishSave!: () => void;
  const voice = new OpenAIVoice({
    key: OPENAI_KEY, model: 'gpt-realtime-2.1', instructions: 'x', greeting: 'Hi.', wsBase: fake.wsBase, idleTimeoutMs: 60,
    saveOutcome: outcome => { saved.push(outcome); return new Promise<void>(resolve => { finishSave = resolve; }); },
  }, event => events.push(event));
  const endCalls = () => events.filter((event): event is ModelEvent => !Buffer.isBuffer(event) && event.type === 'end-call');
  let session!: ModelSession;
  const outputs = () => session.events.filter(event => event.type === 'conversation.item.create').map(event => event.item as Record<string, unknown>);
  try {
    await voice.connect();
    session = fake.sessions[0];
    assert.deepEqual((session.events[0].session as any).tools.map((tool: { name: string }) => tool.name), ['record_outcome', 'end_call']);

    fake.send(session, { type: 'response.output_item.done', item: { type: 'function_call', status: 'completed', name: 'record_outcome', call_id: 'call-1', arguments: JSON.stringify({ outcome: 'interested', summary: ' Wants a demo next week. ' }) } });
    // response.done arrives while the save is still pending: the follow-up must wait for it.
    fake.send(session, { type: 'response.done' });
    await waitFor(() => saved.length === 1, 'saveOutcome call');
    await delay(20);
    assert.equal(session.events.some(event => event.type === 'response.create'), false, 'no follow-up before the outcome is saved');
    finishSave();
    await waitFor(() => session.events.some(event => event.type === 'response.create'), 'follow-up response after save');
    assert.deepEqual(saved[0], { outcome: 'interested', summary: 'Wants a demo next week.', callbackTime: undefined });
    assert.deepEqual(outputs()[0], { type: 'function_call_output', call_id: 'call-1', output: JSON.stringify({ saved: true }) });
    assert.ok(session.events.findIndex(event => event.type === 'conversation.item.create') < session.events.findIndex(event => event.type === 'response.create'), 'tool output precedes the follow-up');

    fake.send(session, { type: 'response.output_item.done', item: { type: 'function_call', status: 'completed', name: 'record_outcome', call_id: 'call-bad', arguments: JSON.stringify({ outcome: 'maybe', summary: 'Unsure.' }) } });
    fake.send(session, { type: 'response.done' });
    await waitFor(() => outputs().some(item => item.call_id === 'call-bad'), 'refused outcome answered');
    assert.match(String(outputs().find(item => item.call_id === 'call-bad')!.output), /"saved":false.*must be one of: interested, callback_requested/);
    assert.equal(saved.length, 1, 'an unknown outcome is never saved');

    // The contact interrupts the goodbye: the cancelled response reports its end_call item as incomplete.
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
    assert.ok(outputs().some(item => item.call_id === 'call-2'), 'end_call is answered before the goodbye');
    assert.equal(endCalls().length, 0, 'the goodbye must play before hanging up');
    fake.send(session, { type: 'response.done', response: { status: 'cancelled' } });
    await delay(20);
    assert.equal(endCalls().length, 0, 'a contact cutting into the goodbye ("wait, one more thing") keeps the call open');

    fake.send(session, { type: 'response.output_item.done', item: { type: 'function_call', status: 'completed', name: 'end_call', call_id: 'call-3', arguments: '{}' } });
    fake.send(session, { type: 'response.done' });
    await waitFor(() => goodbyes().length === 2, 'second goodbye');
    fake.send(session, { type: 'response.done', response: { status: 'completed' } });
    await waitFor(() => endCalls().length === 1, 'agent end-call after the goodbye played');
    assert.equal(endCalls()[0].reason, 'agent');

    voice.answered();
    await waitFor(() => endCalls().length === 2, 'silence end-call', 1_000);
    assert.equal(endCalls()[1].reason, 'silence');
  } finally { await voice.close(); await fake.close(); }
});

test('latest Realtime Mini uses the GA audio path and handles streaming transcripts without duplicate completed text', async () => {
  const fake = new FakeOpenAi(); await fake.start();
  const emitted: Array<ModelEvent | Buffer> = [];
  const voice = new OpenAIVoice({ key: OPENAI_KEY, model: 'gpt-realtime-2.1-mini', transcriptionModel: 'gpt-transcribe', instructions: 'Short answers.', greeting: 'Hi.', openingWaitMs: 0, wsBase: fake.wsBase }, event => emitted.push(event));
  try {
    await voice.connect();
    const session = fake.sessions[0];
    assert.equal(session.path, '/v1/realtime?model=gpt-realtime-2.1-mini');
    assert.equal((session.events[0].session as any).audio.input.transcription.model, 'gpt-transcribe');
    voice.answered(); voice.audio(Buffer.from([1, 2]));
    await waitFor(() => session.events.some(e => e.type === 'input_audio_buffer.append'), 'Mini PCM append');
    await waitFor(() => session.events.some(e => e.type === 'response.create'), 'Mini opening line');
    fake.send(session, { type: 'conversation.item.input_audio_transcription.delta', item_id: 'contact1', content_index: 0, delta: 'Hello ' });
    fake.send(session, { type: 'conversation.item.input_audio_transcription.delta', item_id: 'contact1', content_index: 0, delta: 'there' });
    fake.send(session, { type: 'conversation.item.input_audio_transcription.completed', item_id: 'contact1', content_index: 0, transcript: 'Hello there.' });
    await waitFor(() => emitted.some(e => !Buffer.isBuffer(e) && e.type === 'transcript-final'), 'transcript final metadata');
    const contactText = emitted.filter(e => !Buffer.isBuffer(e) && e.type === 'transcript' && e.speaker === 'contact').map(e => (e as ModelEvent).text).join('');
    assert.equal(contactText, 'Hello there.', 'streamed text plus final suffix appears exactly once');
    fake.send(session, { type: 'conversation.item.input_audio_transcription.completed', item_id: 'contact2', content_index: 0, transcript: 'Final only.' });
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
      assert.match(String(fake.responseBodies[0].input), /^contact: Please help\.$/, 'the helper reads who said what');
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
