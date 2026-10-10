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

type FakeSnapshot = {
  rejectCount: number;
  disconnectCount: number;
  tokenCount: number;
  instances: Array<{ state: string; destroyCount: number }>;
  calls: Array<{ state: string }>;
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
const contact = '+14155550123';

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
  greeting: 'Hi, this is an AI assistant calling. Is now a good time?',
  instructions: 'Be helpful, concise, and honest.',
  events: [] as Array<{ time: string; kind: string; text: string }>,
};

const requests: RequestRecord[] = [];
const heartbeats: Array<{ at: number; registered: boolean }> = [];
const bridges = {
  starts: [] as Array<{ at: number; to: unknown; consent: unknown; model: string }>,
  ready: [] as Array<{ at: number; model: string }>,
  answered: [] as number[],
  binaryFrames: [] as number[],
  // Loudest sample of each frame: silence is near 0, the fake contact's tone is about 16,000.
  peaks: [] as number[],
  controls: [] as Array<{ at: number; type: string }>,
};
// The fake model bridge answers `ready` after this long; the cancel test raises it to have time to hang up.
let readyDelayMs = 35;
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
      rejectCount: fake.rejectCount,
      disconnectCount: fake.disconnectCount,
      tokenCount: fake.tokenCount,
      instances: fake.instances.map((instance: any) => ({ state: instance.state, destroyCount: instance.destroyCount })),
      calls: fake.calls.map((call: any) => ({ state: call.state })),
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

async function dial(page: Page, number: string, consent: boolean): Promise<void> {
  await page.locator('#dial-number').fill(number);
  await page.locator('#consent-checkbox').setChecked(consent);
  await page.locator('#call-button').click();
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
    { number: defaultNumber, status: 'active', default_for_app_calls: true, callback_url: 'https://old.example/callback' },
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
  res.json({ ok: true });
});
app.post('/api/voice-token', assertOriginAndCsrf, (_req, res) => {
  if (state.phase !== 'prepared' && state.phase !== 'ready') {
    res.status(409).json({ error: 'Voice token requested before preparation.' });
    return;
  }
  record('voice-token');
  res.json({ token: 'fake-browser-voice-token' });
});
app.post('/api/heartbeat', assertOriginAndCsrf, (req, res) => {
  const body = req.body as Record<string, unknown>;
  if (typeof body.registered !== 'boolean') {
    res.status(400).json({ error: 'Malformed heartbeat.' });
    return;
  }
  const heartbeat = { at: Date.now(), registered: body.registered };
  heartbeats.push(heartbeat);
  record('heartbeat', { registered: heartbeat.registered });
  res.json({ ok: true });
});
app.post('/api/activate', assertOriginAndCsrf, (_req, res) => {
  const hasRegistrationHeartbeat = heartbeats.some(heartbeat => heartbeat.registered);
  if (state.phase !== 'prepared' || !hasRegistrationHeartbeat) {
    res.status(409).json({ error: 'Activation requires a prepared service and registered heartbeat.' });
    return;
  }
  state.phase = 'ready';
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
      bridges.binaryFrames.push(Date.now());
      const bytes = data as Buffer;
      const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.length / 2));
      bridges.peaks.push(pcm.reduce((peak, sample) => Math.max(peak, Math.abs(sample)), 0));
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
      bridges.starts.push({ at: Date.now(), to: message.to, consent: message.consent, model: state.model });
      // The delayed server control makes the test prove the dashboard dials only once the bridge is ready.
      setTimeout(() => {
        if (websocket.readyState !== WebSocket.OPEN) return;
        bridges.ready.push({ at: Date.now(), model: state.model });
        websocket.send(JSON.stringify({ type: 'ready', model: state.model }));
      }, readyDelayMs);
    }
    if (type === 'answered') bridges.answered.push(Date.now());
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
  assert.equal(await page.locator('#call-button').isDisabled(), true, 'Call must be unavailable before the agent is started.');

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
  assert.equal(await page.locator('#backend-model-select').isDisabled(), true, 'The GPT-6 helper must be unavailable for Realtime models.');
  assert.equal(await page.locator('#call-button').isDisabled(), true, 'Call must stay unavailable until routing is active.');

  const customGreeting = 'Hi <contact> & welcome.';
  const customInstructions = 'Use <safe> guidance & concise answers.';
  await page.locator('#greeting-input').fill(customGreeting);
  await page.locator('#instructions-input').fill(customInstructions);
  await page.locator('#transcription-model-select').selectOption('gpt-transcribe');
  await page.locator('#start-button').click();
  await waitFor(() => state.phase === 'ready' && activateCount === 1, 'first routing activation');
  await page.locator('#status-text', { hasText: 'Ready to place calls' }).waitFor();

  const realtimeSettings = {
    number: defaultNumber,
    model: 'gpt-realtime-2.1',
    transcriptionModel: 'gpt-transcribe',
    backendModel: 'gpt-6-luna',
    greeting: customGreeting,
    instructions: customInstructions,
  };
  assert.deepEqual(savedSettings, realtimeSettings, 'Start must save the actual edited dashboard settings.');
  const prepareIndex = requestIndex('prepare');
  const tokenIndex = requestIndex('voice-token');
  const firstHeartbeatIndex = requests.findIndex(item => item.name === 'heartbeat' && item.body?.registered === true);
  const activateIndex = requestIndex('activate');
  assert.ok(prepareIndex >= 0 && prepareIndex < tokenIndex && tokenIndex < firstHeartbeatIndex && firstHeartbeatIndex < activateIndex,
    'The dashboard must prepare, obtain a token, heartbeat registered, then activate routing in that order.');
  assert.equal((await fakeSnapshot(page)).events.some(event => event.type === 'connect'), false, 'Start must never place a call by itself.');

  // The number to call must be in international format; the dashboard never guesses a country.
  await dial(page, '415 555 0123', true);
  await page.locator('#status-text', { hasText: 'international format' }).waitFor();
  await dial(page, '+1 (415) 555-0123', false);
  await page.locator('#status-text', { hasText: 'permission to call' }).waitFor();
  await dial(page, defaultNumber, true);
  await page.locator('#status-text', { hasText: 'its own Sent number' }).waitFor();
  // The checks run before any await in placeCall(), so a refused call has already returned here.
  assert.equal(bridges.starts.length, 0, 'A refused number or missing permission must not open a model session.');

  // First call: answered, talked, then ended by the server.
  await dial(page, '+1 (415) 555-0123', true);
  await waitFor(() => bridges.ready.length === 1, 'first bridge ready');
  assert.deepEqual({ to: bridges.starts[0].to, consent: bridges.starts[0].consent }, { to: contact, consent: true }, 'The bridge must receive the normalized number and the permission.');
  assert.equal(await page.locator('#dial-number').inputValue(), contact, 'The field must show the normalized number.');
  await page.waitForFunction(() => (window as any).__fakeVoice.calls.length === 1);
  const firstConnect = (await fakeSnapshot(page)).events.find(event => event.type === 'connect');
  assert.ok(firstConnect && firstConnect.at >= bridges.ready[0].at, 'The dashboard must dial only after the model bridge is ready.');
  assert.equal(firstConnect.to, contact);
  assert.equal(await page.locator('#call-button').isDisabled(), true, 'A second call cannot start while one is in progress.');
  assert.equal(await page.locator('#hangup-button').isDisabled(), false, 'Hang up must be available while dialing.');

  await page.evaluate(() => (window as any).__fakeVoice.latestCall().ring());
  await page.waitForFunction(() => document.querySelector('#transcript-state')?.textContent === 'RINGING');
  await delay(400);
  assert.equal(bridges.binaryFrames.length, 0, 'Ringback and carrier audio must never reach the model.');
  assert.equal(bridges.answered.length, 0);
  assert.notEqual(await page.locator('#status-dot').getAttribute('data-kind'), 'error',
    `Dialing with a track-less stream must not fail: ${await page.locator('#status-text').textContent()}`);

  await page.evaluate(() => (window as any).__fakeVoice.latestCall().answer());
  await waitFor(() => bridges.answered.length === 1, 'answered control');
  await waitFor(() => bridges.binaryFrames.length >= 3, 'continuous PCM frames from the actual audio worklet', 12_000);
  assert.ok(bridges.binaryFrames[0] >= bridges.answered[0], 'Contact audio must start only after the answer.');
  // The stream got its track only at the answer; the contact's voice, not silence, must reach the model.
  await waitFor(() => bridges.peaks.some(peak => peak > 4_000), 'the contact’s audio in the frames sent to the model', 12_000);
  await page.locator('#event-log', { hasText: `${contact} picked up; connecting the audio.` }).waitFor();
  assert.equal(await page.locator('#transcript-state').textContent(), 'CALL ACTIVE');
  assert.equal(await page.locator('#call-title').textContent(), `Talking with ${contact}`);

  sendBridgeControl({ type: 'transcript', speaker: 'contact', text: '<img src=x onerror="window.__xss=1"> Hello & <b>world</b>' });
  sendBridgeControl({ type: 'transcript', speaker: 'agent', text: 'I can help with <safe> next steps.' });
  sendBridgeControl({ type: 'audio-meta', itemId: 'fake-item-1' });
  sendBridgeAudio();
  await page.waitForFunction(() => document.querySelectorAll('#transcript-log .transcript-entry').length === 2);
  assert.equal(await page.locator('#transcript-log .contact .words').textContent(), '<img src=x onerror="window.__xss=1"> Hello & <b>world</b>',
    'Transcript content must be displayed as text, not parsed HTML.');
  assert.equal(await page.locator('#transcript-log img').count(), 0, 'Untrusted transcript markup must not create DOM elements.');
  assert.equal(await page.evaluate(() => (window as any).__xss), undefined, 'Transcript markup must not execute.');

  await page.evaluate(() => (window as any).__fakeVoice.incoming('+15555550888'));
  await page.waitForFunction(() => (window as any).__fakeVoice.rejectCount === 1);
  assert.equal((await fakeSnapshot(page)).calls[0].state, 'connected', 'An unexpected invite is rejected without touching the call.');

  sendBridgeControl({ type: 'closed' });
  await page.waitForFunction(() => (window as any).__fakeVoice.disconnectCount === 1);
  await page.waitForFunction(() => document.querySelector('#transcript-state')?.textContent === 'NO ACTIVE CALL');
  await page.locator('#call-detail', { hasText: 'The call ended.' }).waitFor();
  assert.equal(await page.locator('#call-button').isDisabled(), false, 'Call must be available again after the call ends.');

  // Second call: the line is busy. The model bridge closes and nothing is sent to it.
  const framesBeforeBusy = bridges.binaryFrames.length;
  await page.locator('#call-button').click();
  await waitFor(() => bridges.ready.length === 2, 'second bridge ready');
  await page.waitForFunction(() => (window as any).__fakeVoice.calls.length === 2);
  await page.evaluate(() => (window as any).__fakeVoice.latestCall().end('busy'));
  await page.locator('#call-detail', { hasText: 'busy' }).waitFor();
  await waitFor(() => currentBridge === undefined, 'bridge closed after a busy line');
  assert.equal(bridges.answered.length, 1, 'A busy call is never reported as answered.');
  assert.equal(bridges.binaryFrames.length, framesBeforeBusy, 'A busy call sends no audio to the model.');

  // Third call: the SDK refuses to place it.
  await page.evaluate(() => { (window as any).__fakeVoice.connectError = 'Fake CALL_IN_PROGRESS.'; });
  await page.locator('#call-button').click();
  await page.locator('#status-text', { hasText: 'Fake CALL_IN_PROGRESS.' }).waitFor();
  await waitFor(() => currentBridge === undefined, 'bridge closed after connect() failed');

  // Fourth call: hung up while the model session is still starting, so Sent is never asked to dial.
  readyDelayMs = 1_500;
  const connectsBeforeCancel = (await fakeSnapshot(page)).events.filter(event => event.type === 'connect').length;
  await page.locator('#call-button').click();
  await waitFor(() => bridges.starts.length === 4, 'fourth bridge start');
  await page.locator('#hangup-button').click();
  await page.locator('#call-detail', { hasText: 'Call cancelled.' }).waitFor();
  await page.locator('#status-text', { hasText: 'Call cancelled. Ready for the next call.' }).waitFor();
  // Call is enabled again only once placeCall() has finished; a call it had dialed would keep it disabled.
  await page.waitForFunction(() => !(document.querySelector('#call-button') as HTMLButtonElement).disabled);
  assert.equal((await fakeSnapshot(page)).events.filter(event => event.type === 'connect').length, connectsBeforeCancel, 'A call cancelled before the model was ready must never be dialed.');
  readyDelayMs = 35;

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
  assert.equal(await page.locator('#call-button').isDisabled(), true, 'Call must be unavailable after Stop.');
  assert.equal(await page.locator('#transcription-model-select').inputValue(), 'gpt-transcribe', 'The selected ASR must persist after stopping.');

  await page.locator('#model-select').selectOption('gpt-live-1');
  assert.equal(await page.locator('#transcription-model-select').isDisabled(), true, 'GPT-Live must ignore and disable the ASR selector.');
  assert.equal(await page.locator('#backend-model-select').isDisabled(), false, 'GPT-Live must enable the GPT-6 text-helper selector while stopped.');
  await page.locator('#backend-model-select').selectOption('gpt-6-sol');
  await page.locator('#start-button').click();
  await waitFor(() => state.phase === 'ready' && activateCount === 2, 'GPT-Live routing activation');
  await page.locator('#status-text', { hasText: 'Ready to place calls' }).waitFor();
  assert.equal((await fakeSnapshot(page)).instances.length, 2, 'Stopping must leave the dashboard able to create a fresh SDK registration.');
  assert.deepEqual(savedSettings, { ...realtimeSettings, model: 'gpt-live-1', backendModel: 'gpt-6-sol' },
    'GPT-Live must retain the ignored ASR choice and the selected GPT-6 text helper.');

  // The SDK retries an offline registration by itself, so the dashboard keeps routing and the heartbeat alive,
  // reports registered:false (the server then refuses to dial), and resumes when registration returns.
  const offlineAt = Date.now();
  await page.evaluate(() => (window as any).__fakeVoice.offline('Intentional fake registration outage.'));
  await waitFor(() => heartbeats.some(heartbeat => !heartbeat.registered && heartbeat.at >= offlineAt), 'offline false heartbeat');
  await delay(2_200);
  assert.ok(heartbeats.filter(heartbeat => heartbeat.at >= offlineAt).length >= 2, 'Heartbeats must continue during an SDK outage so the watchdog keeps routing.');
  assert.equal(heartbeats.filter(heartbeat => heartbeat.at >= offlineAt).some(heartbeat => heartbeat.registered), false, 'Heartbeats must report the outage.');
  assert.equal(stopCount, 1, 'An SDK outage must not restore routing.');
  assert.equal((await fakeSnapshot(page)).instances[1]?.destroyCount, 0, 'An SDK outage must not destroy the registration the SDK is retrying.');
  await page.locator('#status-text', { hasText: 'offline and retrying' }).waitFor();
  const reconnectAt = Date.now();
  await page.evaluate(() => (window as any).__fakeVoice.reconnect());
  await waitFor(() => heartbeats.some(heartbeat => heartbeat.registered && heartbeat.at >= reconnectAt), 'registered heartbeat after reconnect');
  await page.locator('#status-text', { hasText: 'Ready to place calls' }).waitFor();

  await page.locator('#stop-button').click();
  await waitFor(() => stopCount === 2 && state.phase === 'offline', 'second stop and routing restore');
  await page.waitForFunction(() => (window as any).__fakeVoice.instances[1]?.destroyCount === 1);
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

  console.log(`Browser dashboard integration passed: number format and permission checks, dial-after-ready, no audio before the answer, ${bridges.binaryFrames.length} PCM frames, busy, SDK refusal, cancel before dial, stop/restart, and SDK-outage recovery.`);
} finally {
  for (const client of bridgeServer.clients) client.terminate();
  await context?.close().catch(() => {});
  await browser?.close().catch(() => {});
  await new Promise<void>(resolve => bridgeServer.close(() => resolve()));
  await new Promise<void>(resolve => server.close(() => resolve()));
}
