import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import express, { type NextFunction, type Request, type Response } from 'express';
import { build } from 'esbuild';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { WebSocket, WebSocketServer } from 'ws';

type NumberRecord = {
  number: string;
  status: string;
  default_for_app_calls: boolean;
  callback_url: string | null;
};

type RequestRecord = {
  name: string;
  at: number;
  body?: Record<string, unknown>;
};

type BridgeRecord = { at: number; model?: string; type: string };

type FakeSnapshot = {
  acceptCount: number;
  rejectCount: number;
  disconnectCount: number;
  tokenCount: number;
  instances: Array<{ state: string; destroyCount: number }>;
  invites: Array<{ state: string; acceptedAt?: number; rejectedAt?: number; from: string }>;
  events: Array<{ type: string; at: number; [key: string]: unknown }>;
};

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = await mkdtemp(path.join(os.tmpdir(), 'sent-agent-dashboard-'));
const bundle = path.join(scratch, 'browser-dashboard-app.js');
const csrfToken = 'csrf-browser-dashboard-token';
const fakeSentKey = 'fake-sent-key';
const fakeOpenAiKey = 'fake-openai-key';
const defaultNumber = '+15555550101';
const otherNumber = '+15555550102';

const state = {
  configured: false,
  numbers: [] as NumberRecord[],
  phase: 'offline',
  number: undefined as string | undefined,
  identity: 'fake-browser-agent',
  callbackUrl: undefined as string | undefined,
  warning: undefined as string | undefined,
  error: undefined as string | undefined,
  model: 'gpt-realtime-2.1',
  transcriptionModel: 'gpt-live-transcribe',
  backendModel: 'gpt-6-luna',
  greeting: 'Hello, thanks for calling. How can I help?',
  instructions: 'Be helpful, concise, and honest.',
  events: [] as Array<{ time: string; kind: string; text: string }>,
};

const requests: RequestRecord[] = [];
const heartbeats: Array<{ at: number; registered: boolean; busy: boolean }> = [];
const bridges = {
  records: [] as BridgeRecord[],
  starts: [] as Array<{ at: number; callId: string; model: string }>,
  ready: [] as Array<{ at: number; model: string }>,
  greets: 0,
  binaryFrames: 0,
  controls: [] as Array<{ at: number; type: string }>,
};
let savedSettings: Record<string, unknown> | undefined;
let activateCount = 0;
let stopCount = 0;
let currentBridge: WebSocket | undefined;
let origin = '';

function snapshotState(): Record<string, unknown> {
  return {
    csrfToken,
    configured: state.configured,
    numbers: state.numbers,
    phase: state.phase,
    number: state.number,
    identity: state.identity,
    callbackUrl: state.callbackUrl,
    warning: state.warning,
    error: state.error,
    model: state.model,
    transcriptionModel: state.transcriptionModel,
    backendModel: state.backendModel,
    greeting: state.greeting,
    instructions: state.instructions,
    events: state.events,
  };
}

function record(name: string, body?: Record<string, unknown>): void {
  // Do not retain credential values in this test's diagnostic state.
  requests.push({ name, at: Date.now(), body: name === 'configure' ? undefined : body });
}

function assertOriginAndCsrf(req: Request, res: Response, next: NextFunction): void {
  if (req.get('origin') !== origin) {
    res.status(403).json({ error: 'Origin validation failed.' });
    return;
  }
  if (req.get('x-csrf-token') !== csrfToken) {
    res.status(403).json({ error: 'CSRF validation failed.' });
    return;
  }
  next();
}

async function waitFor(condition: () => boolean | Promise<boolean>, label: string, timeout = 10_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function fakeSnapshot(page: Page): Promise<FakeSnapshot> {
  return page.evaluate(() => {
    const fake = (window as any).__fakeVoice;
    return {
      acceptCount: fake.acceptCount,
      rejectCount: fake.rejectCount,
      disconnectCount: fake.disconnectCount,
      tokenCount: fake.tokenCount,
      instances: fake.instances.map((instance: any) => ({ state: instance.state, destroyCount: instance.destroyCount })),
      invites: fake.invites.map((invite: any) => ({
        state: invite.state,
        acceptedAt: invite.acceptedAt,
        rejectedAt: invite.rejectedAt,
        from: invite.from,
      })),
      events: fake.events.map((event: any) => ({ ...event })),
    };
  });
}

function requestIndex(name: string, occurrence = 0): number {
  let seen = 0;
  for (let index = 0; index < requests.length; index += 1) {
    if (requests[index].name !== name) continue;
    if (seen === occurrence) return index;
    seen += 1;
  }
  return -1;
}

function currentReadyBridge(): WebSocket {
  assert.ok(currentBridge && currentBridge.readyState === WebSocket.OPEN, 'Expected an open fake model bridge.');
  return currentBridge;
}

function sendBridgeControl(message: Record<string, unknown>): void {
  currentReadyBridge().send(JSON.stringify(message));
}

function sendBridgeAudio(): void {
  const pcm = new Int16Array(480);
  for (let i = 0; i < pcm.length; i += 1) pcm[i] = Math.round(Math.sin((i / pcm.length) * Math.PI * 2) * 8_000);
  currentReadyBridge().send(Buffer.from(pcm.buffer));
}

await build({
  entryPoints: [path.join(repo, 'client/app.ts')],
  outfile: bundle,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  alias: { '@sentdm/voice': path.join(repo, 'tests/fixtures/fake-voice.ts') },
  logLevel: 'silent',
});

const app = express();
app.use(express.json());
app.get('/api/state', (req, res) => {
  // State is the bootstrap endpoint and has no CSRF header in the real client. It still rejects a
  // supplied cross-origin Origin value; every mutating API request below requires both checks.
  const suppliedOrigin = req.get('origin');
  if (suppliedOrigin && suppliedOrigin !== origin) {
    res.status(403).json({ error: 'Origin validation failed.' });
    return;
  }
  res.json(snapshotState());
});
app.post('/api/configure', assertOriginAndCsrf, (req, res) => {
  const body = req.body as Record<string, unknown>;
  if (body.sentKey !== fakeSentKey || body.openaiKey !== fakeOpenAiKey) {
    res.status(400).json({ error: 'Only the test fake keys are accepted.' });
    return;
  }
  record('configure');
  state.configured = true;
  state.numbers = [
    { number: defaultNumber, status: 'active', default_for_app_calls: true, callback_url: null },
    { number: otherNumber, status: 'active', default_for_app_calls: false, callback_url: null },
  ];
  state.phase = 'offline';
  res.json({ ok: true });
});
app.post('/api/settings', assertOriginAndCsrf, (req, res) => {
  const body = req.body as Record<string, unknown>;
  if (!state.configured || typeof body.number !== 'string' || !state.numbers.some(item => item.number === body.number)) {
    res.status(400).json({ error: 'Invalid test settings.' });
    return;
  }
  if (typeof body.model !== 'string' || !['gpt-realtime-2.1', 'gpt-realtime-2.1-mini', 'gpt-live-1'].includes(body.model)) {
    res.status(400).json({ error: 'Invalid test model.' });
    return;
  }
  if (typeof body.transcriptionModel !== 'string' || !['gpt-live-transcribe', 'gpt-transcribe'].includes(body.transcriptionModel)) {
    res.status(400).json({ error: 'Invalid test transcription model.' });
    return;
  }
  if (typeof body.backendModel !== 'string' || !['gpt-6-luna', 'gpt-5.4-mini', 'gpt-6-sol', 'gpt-6-astra'].includes(body.backendModel)) {
    res.status(400).json({ error: 'Invalid test backend model.' });
    return;
  }
  if (typeof body.greeting !== 'string' || typeof body.instructions !== 'string') {
    res.status(400).json({ error: 'Invalid test behavior.' });
    return;
  }
  savedSettings = { ...body };
  state.number = body.number;
  state.model = body.model;
  state.transcriptionModel = body.transcriptionModel;
  state.backendModel = body.backendModel;
  state.greeting = body.greeting;
  state.instructions = body.instructions;
  record('settings', { ...body });
  res.json({ ok: true });
});
app.post('/api/prepare', assertOriginAndCsrf, (_req, res) => {
  if (!savedSettings) {
    res.status(409).json({ error: 'Settings must be saved before preparation.' });
    return;
  }
  state.phase = 'prepared';
  record('prepare');
  res.json({ ok: true, callbackUrl: 'https://fake.local/callback' });
});
app.post('/api/voice-token', assertOriginAndCsrf, (_req, res) => {
  if (state.phase !== 'prepared' && state.phase !== 'answering') {
    res.status(409).json({ error: 'Voice token requested before preparation.' });
    return;
  }
  record('voice-token');
  res.json({ token: 'fake-browser-voice-token' });
});
app.post('/api/heartbeat', assertOriginAndCsrf, (req, res) => {
  const body = req.body as Record<string, unknown>;
  if (typeof body.registered !== 'boolean' || typeof body.busy !== 'boolean') {
    res.status(400).json({ error: 'Malformed heartbeat.' });
    return;
  }
  const heartbeat = { at: Date.now(), registered: body.registered, busy: body.busy };
  heartbeats.push(heartbeat);
  record('heartbeat', { registered: heartbeat.registered, busy: heartbeat.busy });
  res.json({ ok: true });
});
app.post('/api/activate', assertOriginAndCsrf, (_req, res) => {
  const hasRegistrationHeartbeat = heartbeats.some(heartbeat => heartbeat.registered);
  if (state.phase !== 'prepared' || !hasRegistrationHeartbeat) {
    res.status(409).json({ error: 'Activation requires a prepared service and registered heartbeat.' });
    return;
  }
  state.phase = 'answering';
  activateCount += 1;
  record('activate');
  res.json({ ok: true });
});
app.post('/api/stop', assertOriginAndCsrf, (_req, res) => {
  stopCount += 1;
  state.phase = 'offline';
  record('stop');
  res.json({ ok: true });
});
app.get('/app.js', (_req, res) => res.sendFile(bundle));
app.use(express.static(path.join(repo, 'public')));

const server = http.createServer(app);
const bridgeServer = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const requestUrl = new URL(req.url ?? '/', origin);
  const permitted = requestUrl.pathname === '/bridge'
    && req.headers.origin === origin
    && requestUrl.searchParams.get('token') === csrfToken;
  if (!permitted) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  bridgeServer.handleUpgrade(req, socket, head, websocket => bridgeServer.emit('connection', websocket, req));
});
bridgeServer.on('connection', websocket => {
  currentBridge = websocket;
  let started = false;
  websocket.on('message', (data, isBinary) => {
    if (isBinary) {
      bridges.binaryFrames += 1;
      bridges.records.push({ at: Date.now(), type: 'binary' });
      return;
    }
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(data.toString()) as Record<string, unknown>;
    } catch {
      websocket.close(1003, 'bad control');
      return;
    }
    const type = typeof message.type === 'string' ? message.type : 'unknown';
    bridges.controls.push({ at: Date.now(), type });
    if (type === 'start' && !started) {
      started = true;
      const callId = typeof message.callId === 'string' ? message.callId : '';
      bridges.starts.push({ at: Date.now(), callId, model: state.model });
      // The delayed server control makes the test prove accept waits for bridge readiness.
      setTimeout(() => {
        if (websocket.readyState !== WebSocket.OPEN) return;
        const at = Date.now();
        bridges.ready.push({ at, model: state.model });
        bridges.records.push({ at, type: 'ready', model: state.model });
        websocket.send(JSON.stringify({ type: 'ready', model: state.model }));
      }, 35);
    }
    if (type === 'greet') bridges.greets += 1;
  });
  websocket.on('close', () => {
    if (currentBridge === websocket) currentBridge = undefined;
  });
});

let browser: Browser | undefined;
let context: BrowserContext | undefined;
let page: Page | undefined;
const pageErrors: string[] = [];

try {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string', 'Fake server did not bind a TCP port.');
  origin = `http://127.0.0.1:${address.port}`;

  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 1024 } });
  await context.grantPermissions(['notifications'], { origin });
  page = await context.newPage();
  // tsx preserves helper references in serialized page functions; make them available before app code.
  await page.addInitScript('window.__name = (fn, name) => fn;');
  page.on('pageerror', error => pageErrors.push(error.message));

  await page.goto(origin, { waitUntil: 'networkidle' });
  await page.locator('#status-text', { hasText: 'Add both keys' }).waitFor();

  await page.locator('#sent-key').fill(fakeSentKey);
  await page.locator('#openai-key').fill(fakeOpenAiKey);
  await page.locator('#connect-button').click();
  await waitFor(() => state.configured, 'fake credential configuration');
  await page.waitForFunction(number => (document.querySelector('#number-select') as HTMLSelectElement).value === number, defaultNumber);
  assert.equal(await page.locator('#sent-key').inputValue(), '', 'Sent key field must be cleared after one local submission.');
  assert.equal(await page.locator('#openai-key').inputValue(), '', 'OpenAI key field must be cleared after one local submission.');
  assert.equal(await page.locator('#number-select').inputValue(), defaultNumber, 'The discovered default number must be preselected.');
  assert.equal(await page.locator('#number-select option').count(), 2, 'Both discovered active fake numbers must render.');
  assert.equal(await page.locator('#model-select').inputValue(), 'gpt-realtime-2.1', 'GPT-Realtime-2.1 must be the default voice model.');
  assert.equal(await page.locator('#transcription-model-select').inputValue(), 'gpt-live-transcribe', 'GPT-Live Transcribe must be the default ASR model.');
  assert.equal(await page.locator('#backend-model-select').inputValue(), 'gpt-6-luna', 'GPT-6 Luna must be the default text helper.');
  assert.equal(await page.locator('#transcription-model-select').isDisabled(), false, 'ASR must be selectable for stopped Realtime models.');
  assert.equal(await page.locator('#backend-model-select').isDisabled(), true, 'The GPT-6 helper must be unavailable for Realtime models.');

  const customGreeting = 'Hello <caller> & welcome.';
  const customInstructions = 'Use <safe> guidance & concise answers.';
  await page.locator('#greeting-input').fill(customGreeting);
  await page.locator('#instructions-input').fill(customInstructions);
  await page.locator('#model-select').selectOption('gpt-realtime-2.1');
  await page.locator('#transcription-model-select').selectOption('gpt-transcribe');
  await page.locator('#start-button').click();
  await waitFor(() => state.phase === 'answering' && activateCount === 1, 'first routing activation');
  await page.locator('#status-text', { hasText: 'Ready for inbound calls' }).waitFor();

  const realtimeSettings = {
    number: defaultNumber,
    model: 'gpt-realtime-2.1',
    transcriptionModel: 'gpt-transcribe',
    backendModel: 'gpt-6-luna',
    greeting: customGreeting,
    instructions: customInstructions,
  };
  assert.deepEqual(savedSettings, realtimeSettings, 'Start must save the actual edited dashboard settings.');
  assert.deepEqual(requests[requestIndex('settings')]?.body, realtimeSettings,
    'The first settings request must send both model-selection IDs, including the disabled GPT-6 helper choice.');
  const prepareIndex = requestIndex('prepare');
  const tokenIndex = requestIndex('voice-token');
  const firstHeartbeatIndex = requests.findIndex(item => item.name === 'heartbeat' && item.body?.registered === true);
  const activateIndex = requestIndex('activate');
  assert.ok(prepareIndex >= 0 && prepareIndex < tokenIndex && tokenIndex < firstHeartbeatIndex && firstHeartbeatIndex < activateIndex,
    'The dashboard must prepare, obtain a token, heartbeat registered, then activate routing in that order.');

  await page.evaluate(() => (window as any).__fakeVoice.incoming('+15555550999'));
  await page.waitForFunction(() => (window as any).__fakeVoice.acceptCount === 1);
  await waitFor(() => bridges.ready.length === 1 && bridges.greets === 1, 'first bridge ready and greeting');
  await waitFor(() => bridges.binaryFrames >= 3, 'continuous PCM frames from the actual audio worklet', 12_000);
  const firstVoice = await fakeSnapshot(page);
  assert.equal(firstVoice.invites[0]?.state, 'accepted', 'The first invite must be accepted once ready.');
  assert.ok((firstVoice.invites[0]?.acceptedAt ?? 0) >= bridges.ready[0].at,
    'The provider invite must not be accepted until the bridge has sent ready.');
  assert.equal(bridges.ready[0].model, 'gpt-realtime-2.1', 'Bridge readiness must use the selected saved model.');
  assert.equal(await page.locator('#transcript-state').textContent(), 'CALL ACTIVE');

  sendBridgeControl({ type: 'transcript', speaker: 'caller', text: '<img src=x onerror="window.__xss=1"> Hello & <b>world</b>' });
  sendBridgeControl({ type: 'transcript', speaker: 'agent', text: 'I can help with <safe> next steps.' });
  sendBridgeControl({ type: 'audio-meta', itemId: 'fake-item-1' });
  sendBridgeAudio();
  await page.waitForFunction(() => document.querySelectorAll('#transcript-log .transcript-entry').length === 2);
  assert.equal(await page.locator('#transcript-log .caller .words').textContent(), '<img src=x onerror="window.__xss=1"> Hello & <b>world</b>',
    'Transcript content must be displayed as text, not parsed HTML.');
  assert.equal(await page.locator('#transcript-log img').count(), 0, 'Untrusted transcript markup must not create DOM elements.');
  assert.equal(await page.evaluate(() => (window as any).__xss), undefined, 'Transcript markup must not execute.');

  await page.evaluate(() => (window as any).__fakeVoice.incoming('+15555550888'));
  await page.waitForFunction(() => (window as any).__fakeVoice.rejectCount === 1);
  const afterSecondInvite = await fakeSnapshot(page);
  assert.equal(afterSecondInvite.acceptCount, 1, 'A second invite while active must never be accepted.');
  assert.equal(afterSecondInvite.invites[1]?.state, 'rejected', 'The second active-call invite must be rejected.');

  sendBridgeControl({ type: 'closed' });
  await page.waitForFunction(() => (window as any).__fakeVoice.disconnectCount === 1);
  await page.waitForFunction(() => document.querySelector('#transcript-state')?.textContent === 'NO ACTIVE CALL');
  assert.equal((await fakeSnapshot(page)).disconnectCount, 1, 'A server closed control must disconnect the provider call.');

  await page.evaluate(() => (window as any).__fakeVoice.incoming('+15555550777'));
  await page.waitForFunction(() => (window as any).__fakeVoice.acceptCount === 2);
  await waitFor(() => bridges.ready.length === 2 && bridges.greets === 2, 'next call bridge ready and greeting');
  assert.equal(bridges.ready[1].model, 'gpt-realtime-2.1', 'The next call must also wait for a ready bridge with the saved model.');

  await page.setViewportSize({ width: 1440, height: 1024 });
  await page.screenshot({ path: path.join(scratch, 'sent-agent-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(scratch, 'sent-agent-mobile.png'), fullPage: true });

  await page.locator('#stop-button').click();
  await waitFor(() => stopCount === 1 && state.phase === 'offline', 'first stop and routing restore');
  await page.waitForFunction(() => (window as any).__fakeVoice.instances[0]?.destroyCount === 1);
  const firstStopAt = requests.find(item => item.name === 'stop')?.at;
  const firstDestroyAt = (await fakeSnapshot(page)).events.find(event => event.type === 'destroy')?.at;
  assert.ok(firstStopAt && firstDestroyAt && firstStopAt <= firstDestroyAt,
    'The restore API must run before the dashboard destroys browser voice registration.');
  await page.waitForFunction(() => !(document.querySelector('#start-button') as HTMLButtonElement).disabled);
  assert.equal(await page.locator('#transcription-model-select').inputValue(), 'gpt-transcribe', 'The selected ASR must persist after stopping.');
  assert.equal(await page.locator('#transcription-model-select').isDisabled(), false, 'Stopped Realtime controls must re-enable ASR selection.');
  assert.equal(await page.locator('#backend-model-select').isDisabled(), true, 'Stopped Realtime controls must keep the GPT-6 helper unavailable.');

  await page.locator('#model-select').selectOption('gpt-realtime-2.1-mini');
  assert.equal(await page.locator('#transcription-model-select').isDisabled(), false, 'Realtime Mini must keep ASR selection enabled while stopped.');
  assert.equal(await page.locator('#backend-model-select').isDisabled(), true, 'Realtime Mini must not enable the GPT-6 helper.');
  await page.locator('#start-button').click();
  await waitFor(() => state.phase === 'answering' && activateCount === 2, 'restart routing activation');
  await page.locator('#status-text', { hasText: 'Ready for inbound calls' }).waitFor();
  assert.equal((await fakeSnapshot(page)).instances.length, 2, 'Stopping must leave the dashboard able to create a fresh SDK registration.');
  const miniSettings = {
    number: defaultNumber,
    model: 'gpt-realtime-2.1-mini',
    transcriptionModel: 'gpt-transcribe',
    backendModel: 'gpt-6-luna',
    greeting: customGreeting,
    instructions: customInstructions,
  };
  assert.deepEqual(savedSettings, miniSettings, 'Restarting with Realtime Mini must retain the ASR and text-helper choices.');
  assert.deepEqual(requests[requestIndex('settings', 1)]?.body, miniSettings, 'The Mini restart must send an exact complete settings payload.');

  await page.locator('#stop-button').click();
  await waitFor(() => stopCount === 2 && state.phase === 'offline', 'second stop and routing restore');
  await page.waitForFunction(() => !(document.querySelector('#start-button') as HTMLButtonElement).disabled);

  await page.locator('#model-select').selectOption('gpt-live-1');
  assert.equal(await page.locator('#transcription-model-select').isDisabled(), true, 'GPT-Live must ignore and disable the ASR selector.');
  assert.equal(await page.locator('#backend-model-select').isDisabled(), false, 'GPT-Live must enable the GPT-6 text-helper selector while stopped.');
  await page.locator('#backend-model-select').selectOption('gpt-6-sol');
  await page.locator('#start-button').click();
  await waitFor(() => state.phase === 'answering' && activateCount === 3, 'GPT-Live routing activation');
  const liveSettings = {
    number: defaultNumber,
    model: 'gpt-live-1',
    transcriptionModel: 'gpt-transcribe',
    backendModel: 'gpt-6-sol',
    greeting: customGreeting,
    instructions: customInstructions,
  };
  assert.deepEqual(savedSettings, liveSettings, 'GPT-Live must retain the ignored ASR choice and selected GPT-6 text helper.');
  assert.deepEqual(requests[requestIndex('settings', 2)]?.body, liveSettings, 'The GPT-Live restart must send an exact complete settings payload.');
  assert.equal(await page.locator('#backend-model-select').inputValue(), 'gpt-6-sol', 'The selected GPT-6 helper must persist during GPT-Live operation.');

  // The SDK retries an offline registration by itself, so the dashboard keeps routing and the heartbeat alive,
  // reports registered:false (the server then declines calls as busy), and resumes when registration returns.
  const offlineAt = Date.now();
  await page.evaluate(() => (window as any).__fakeVoice.offline('Intentional fake registration outage.'));
  await waitFor(() => heartbeats.some(heartbeat => !heartbeat.registered && heartbeat.at >= offlineAt), 'offline false heartbeat');
  await delay(2_200);
  assert.ok(heartbeats.filter(heartbeat => heartbeat.at >= offlineAt).length >= 2, 'Heartbeats must continue during an SDK outage so the watchdog keeps routing.');
  assert.equal(heartbeats.filter(heartbeat => heartbeat.at >= offlineAt).some(heartbeat => heartbeat.registered), false, 'Heartbeats must report the outage.');
  assert.equal(stopCount, 2, 'An SDK outage must not restore routing.');
  assert.equal((await fakeSnapshot(page)).instances[2]?.destroyCount, 0, 'An SDK outage must not destroy the registration the SDK is retrying.');
  await page.locator('#status-text', { hasText: 'offline and retrying' }).waitFor();
  const reconnectAt = Date.now();
  await page.evaluate(() => (window as any).__fakeVoice.reconnect());
  await waitFor(() => heartbeats.some(heartbeat => heartbeat.registered && heartbeat.at >= reconnectAt), 'registered heartbeat after reconnect');
  await page.locator('#status-text', { hasText: 'Ready for inbound calls' }).waitFor();

  await page.locator('#stop-button').click();
  await waitFor(() => stopCount === 3 && state.phase === 'offline', 'third stop and routing restore');
  await page.waitForFunction(() => (window as any).__fakeVoice.instances[2]?.destroyCount === 1);
  const stoppedAt = Date.now();
  await delay(2_200);
  assert.equal(heartbeats.some(heartbeat => heartbeat.at > stoppedAt + 100), false, 'Heartbeat scheduling must stop after Stop.');

  const persistedStorage = await page.evaluate(() => ({
    local: Object.entries(localStorage),
    session: Object.entries(sessionStorage),
  }));
  const serializedStorage = JSON.stringify(persistedStorage);
  assert.equal(serializedStorage.includes(fakeSentKey), false, 'The Sent key must not leak into browser storage.');
  assert.equal(serializedStorage.includes(fakeOpenAiKey), false, 'The OpenAI key must not leak into browser storage.');
  assert.equal(pageErrors.length, 0, `Browser page errors: ${pageErrors.join('; ')}`);

  console.log(`Browser dashboard integration passed: Realtime ASR persistence, Mini and GPT-Live restarts, ${bridges.binaryFrames} PCM frames, two call lifecycles, stop/restart, and SDK-outage recovery.`);
} finally {
  for (const client of bridgeServer.clients) client.terminate();
  await context?.close().catch(() => {});
  await browser?.close().catch(() => {});
  await new Promise<void>(resolve => bridgeServer.close(() => resolve()));
  await new Promise<void>(resolve => server.close(() => resolve()));
}
