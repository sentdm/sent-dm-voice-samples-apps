import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { SentClient } from './sent.js';
import { BackupStore } from './backup.js';
import { DIAL_TIMEOUT_SECONDS, decideOutbound, equalSecret, verifySentSignature } from './security.js';
import { checkNumberToCall } from './phone.js';
import { OpenAIVoice, MODELS, checkKey, preflight } from './openai.js';
import { BACKEND_MODELS, TRANSCRIPTION_MODELS, DEFAULT_VOICE_MODEL, DEFAULT_BACKEND_MODEL, DEFAULT_TRANSCRIPTION_MODEL, isLiveModel } from './models.js';
import { openTunnel } from './tunnel.js';
// Counted from the answer, so ringing does not use up the conversation.
const MAX_CALL_MS = 5 * 60_000;
// From Call to the answer: up to 45 s for the model session (15 s at most) and Sent's call setup, then the ring time.
const DIAL_SETUP_MS = (45 + DIAL_TIMEOUT_SECONDS) * 1000;
// From the model being ready to Sent's callback question for that dial; the SDK places the call within seconds.
const PENDING_DIAL_MS = 20_000;
export async function createApplication(options = {}) {
    const csrf = randomBytes(32).toString('hex');
    const identity = `sent-ai-${randomBytes(6).toString('hex')}`;
    const store = new BackupStore(options.dataDir ?? path.resolve('.sent-agent'));
    let backup = await store.read();
    let sent;
    let openaiKey = '';
    let keySource = null;
    let numbers = [];
    let number = '', phase = 'offline', model = DEFAULT_VOICE_MODEL;
    let backendModel = DEFAULT_BACKEND_MODEL;
    let transcriptionModel = DEFAULT_TRANSCRIPTION_MODEL;
    let instructions = [
        'You call people on behalf of Sent (sent.dm): one API for business messaging over SMS, WhatsApp, and RCS. The person you call signed up for Sent recently.',
        'When they pick up, let them speak first. Wait until they have greeted you or finished their first sentence, then say your opening line. Don’t talk over them.',
        'Your goal: find out whether they got started, answer simple questions, and offer a follow-up from the team. Say that you’re an AI assistant in your first sentence.',
        'Sound like a friendly person, not a script: keep most replies under 20 words, then let them talk. Plain words, one question at a time, and don’t narrate what you’re doing.',
        'You can’t see accounts, pricing, or billing, so don’t guess or promise anything. If it’s a bad time, ask when to call back. If they ask not to be called again, apologize, confirm it, and end the call.',
        'If you reach voicemail, wait for the beep, leave one short message saying who you are and why you called, then end the call.',
        'Before you end the call, record the outcome.',
    ].join('\n\n');
    let greeting = 'Hi, this is an AI assistant calling from Sent. Is now a good time for a quick chat about getting started?';
    let callbackUrl = '', callbackPath = '', error = '', warning = '';
    let tunnel;
    // The dial request belongs to the call attempt: it exists from `dialUntil` (set once the model is ready) until Sent
    // dials it, and ending the attempt withdraws it with everything else.
    let active;
    const pendingDial = () => active?.dialUntil && !active.dialed ? { to: active.to, until: active.dialUntil } : undefined;
    let heartbeat = 0, registered = false;
    let preparing = false, mutating = false, stopping;
    const cache = new Map();
    // Sequence ids let the dashboard render only new events without remembering every one it has seen.
    let eventSeq = 0;
    const events = [];
    const event = (kind, text) => { events.push({ id: ++eventSeq, time: new Date().toISOString(), kind, text }); if (events.length > 150)
        events.shift(); };
    // The one way a failure reaches the dashboard: its status line (`error`) and the event log.
    const recordError = (e) => { error = e instanceof Error ? e.message : String(e); event('error', error); return error; };
    const saveOutcome = (to) => async (outcome) => {
        await store.appendOutcome({ time: new Date().toISOString(), from: number, to, ...outcome });
        event('outcome', `${to}: ${outcome.outcome}${outcome.callbackTime ? ` (call back: ${outcome.callbackTime})` : ''}. ${outcome.summary}`);
    };
    const currentVoiceConfig = (to) => ({ key: openaiKey, model, backendModel, transcriptionModel, instructions, greeting, saveOutcome: to ? saveOutcome(to) : undefined, httpBase: options.openaiHttpBase, wsBase: options.openaiWsBase });
    // The tab being alive and its Sent registration are separate: while the SDK is offline it retries on its own and
    // cannot place calls, but routing is only torn down when the tab itself stops responding.
    const alive = () => Date.now() - heartbeat < 7000;
    const online = () => registered && alive();
    function requireConfigured() { if (!sent || !openaiKey || !number)
        throw new Error('Connect keys and select an active voice number first.'); return sent; }
    function requireStopped(message) { if (phase !== 'offline' || preparing || mutating)
        throw new Error(message); }
    async function clearBackup() { await store.clear(); backup = null; }
    async function restoreBackup(client) {
        if (!backup)
            return;
        const saved = backup;
        const current = await client.get(saved.number);
        if (current.callback_url !== saved.installedUrl) {
            if (current.callback_url === saved.previousUrl)
                event('routing', 'Previous routing is already restored.');
            else {
                warning = 'The number callback changed outside this app. It was not overwritten.';
                event('warning', warning);
            }
            await clearBackup();
            return;
        }
        if (!saved.previousUrl) {
            warning = 'This number had no previous callback URL. Sent does not document clearing it to null; the stopped callback rejects calls while this app runs. Set a new callback in Sent when needed.';
            event('warning', warning);
            return;
        }
        await client.restore(saved.number, saved.previousUrl);
        await clearBackup();
        event('routing', 'Previous callback URL restored.');
    }
    async function stop() {
        if (stopping)
            return stopping;
        phase = 'stopping';
        registered = false;
        stopping = (async () => {
            const call = active;
            if (call) {
                if (call.socket.readyState === WebSocket.OPEN)
                    call.socket.send(JSON.stringify({ type: 'closed' }));
                call.socket.close();
                await call.voice?.close();
                clearTimeout(call.timer);
                if (active === call)
                    active = undefined;
            }
            try {
                if (sent && backup)
                    await restoreBackup(sent);
            }
            catch (e) {
                recordError(`Routing restoration failed: ${e.message}. Backup retained; reconnect the same keys and stop/recover again.`);
            }
            tunnel?.stop();
            tunnel = undefined;
            callbackUrl = '';
            phase = 'offline';
            cache.clear();
            event('status', 'Agent stopped.');
        })().finally(() => { stopping = undefined; });
        return stopping;
    }
    const gateway = express();
    gateway.disable('x-powered-by');
    gateway.get('/health', (_req, res) => res.json({ ok: true }));
    gateway.post('/voice/:nonce', express.raw({ type: 'application/json', limit: '64kb' }), (req, res) => {
        if (!callbackPath || req.path !== callbackPath || !backup?.callbackSecret || !Buffer.isBuffer(req.body))
            return res.sendStatus(401);
        if (!verifySentSignature(req.headers, req.body, backup.callbackSecret))
            return res.sendStatus(401);
        let q;
        try {
            q = JSON.parse(req.body.toString());
        }
        catch {
            return res.sendStatus(400);
        }
        if (!q || typeof q.callId !== 'string' || q.callId.length > 100 || q.number !== number)
            return res.sendStatus(400);
        const key = `${q.callId}:${q.type}:${q.test === true ? 'test' : 'live'}`;
        const previous = cache.get(key);
        if (previous && Date.now() - previous.time < 15_000)
            return res.json(previous.answer);
        // Only a live, registered tab places calls, so there is no dial to match while it isn't.
        const answer = decideOutbound(q, number, identity, phase === 'ready' && online() ? pendingDial() : undefined);
        cache.set(key, { answer, time: Date.now() });
        if (cache.size > 300)
            cache.delete(cache.keys().next().value);
        if (!q.test) {
            // One dial, one call: a retry of this question gets the cached answer, and nothing else can reuse the dial.
            if (answer.action.action === 'connectToNumber' && active)
                active.dialed = true;
            event('call', `${q.direction === 'outbound' ? 'Outbound' : 'Inbound'} call ${q.callId}: ${answer.action.action}.`);
        }
        return res.json(answer);
    });
    gateway.use((_req, res) => res.sendStatus(404));
    const gatewayServer = http.createServer(gateway);
    await new Promise((resolve, reject) => { gatewayServer.once('error', reject); gatewayServer.listen(options.gatewayPort ?? 0, '127.0.0.1', resolve); });
    const gatewayPort = gatewayServer.address().port;
    const app = express();
    app.disable('x-powered-by');
    app.use((req, res, next) => {
        const port = (req.socket.localPort ?? options.port ?? 3000);
        const host = req.headers.host;
        if (host !== `localhost:${port}` && host !== `127.0.0.1:${port}`)
            return res.status(403).json({ error: 'Local management access only.' });
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Referrer-Policy', 'no-referrer');
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            const origin = req.headers.origin;
            if (origin && origin !== `http://${host}`)
                return res.status(403).json({ error: 'Same-origin requests only.' });
            const token = req.headers['x-csrf-token'];
            if (typeof token !== 'string' || !equalSecret(token, csrf))
                return res.status(403).json({ error: 'Invalid local CSRF token.' });
        }
        next();
    });
    app.use(express.json({ limit: '32kb' }));
    app.get('/health', (_req, res) => res.json({ ok: true }));
    app.get('/api/state', (_req, res) => res.json({ csrfToken: csrf, configured: !!sent && !!openaiKey, keySource, numbers, phase, number, identity, callbackUrl, warning, error, model, backendModel, transcriptionModel, greeting, instructions, events, routingBackup: backup ? { number: backup.number, previousUrl: backup.previousUrl } : null }));
    const endpoint = (fn) => async (req, res) => {
        try {
            const value = await fn(req);
            res.json(value ?? { ok: true });
        }
        catch (e) {
            res.status(400).json({ error: recordError(e) });
        }
    };
    // Shared by the dashboard form and SENT_DM_API_KEY/OPENAI_API_KEY so both paths get identical validation.
    async function configureKeys(sentKey, key, source) {
        requireStopped('Stop the agent before changing keys.');
        if (typeof sentKey !== 'string' || sentKey.length < 12 || sentKey.length > 1024 || typeof key !== 'string' || key.length < 12 || key.length > 1024) {
            throw new Error(source === 'env' ? 'SENT_DM_API_KEY and OPENAI_API_KEY must each be 12–1024 characters.' : 'Enter valid Sent and OpenAI API keys.');
        }
        const candidate = new SentClient(sentKey.trim(), options.sentBase);
        const openai = key.trim();
        // The checks are independent, so the OpenAI one runs during the Sent listing; a Sent problem is still reported first.
        const keyCheck = checkKey(openai, options.openaiHttpBase);
        keyCheck.catch(() => { });
        const found = await candidate.list();
        const activeNumbers = found.filter(n => n.status?.toUpperCase() === 'ACTIVE');
        // Sent: a number added without a callback URL (e.g. from the dashboard) is INACTIVE for that one reason, and setting one turns it on.
        const waiting = found.filter(n => n.status?.toUpperCase() !== 'ACTIVE' && !n.callback_url).map(n => n.number);
        if (!activeNumbers.length && waiting.length)
            throw new Error(`${waiting.join(', ')} ${waiting.length > 1 ? 'are' : 'is'} waiting for a first callback URL. Set any public HTTPS URL on it in Sent (PATCH /v3/channels/voice/{number}); this app swaps in its own while it runs and restores yours on Stop. Then reconnect.`);
        if (!activeNumbers.length)
            throw new Error('No active voice numbers on this Sent key. Enable voice on an existing number in Sent first. This app does not buy or allocate numbers.');
        await keyCheck;
        sent = candidate;
        openaiKey = openai;
        numbers = activeNumbers;
        keySource = source;
        number = (activeNumbers.find(n => n.default_for_app_calls) ?? activeNumbers[0]).number;
        error = '';
        warning = '';
        if (backup) {
            warning = 'A previous session left a routing backup. Recovering the previous callback before starting again.';
            await restoreBackup(candidate);
        }
        event('status', source === 'env' ? 'Environment keys validated; active voice numbers loaded.' : 'Keys validated; active voice numbers loaded.');
    }
    app.post('/api/configure', endpoint(req => configureKeys(req.body?.sentKey, req.body?.openaiKey, 'dashboard')));
    app.post('/api/settings', endpoint(async (req) => {
        requireStopped('Stop before changing agent settings.');
        const value = req.body ?? {};
        if (!numbers.some(n => n.number === value.number))
            throw new Error('Select an existing active Sent voice number.');
        if (!MODELS.includes(value.model))
            throw new Error('Choose GPT-Realtime-2.1, GPT-Realtime-2.1 Mini, or GPT-Live-1.');
        const selectedBackend = value.backendModel ?? backendModel;
        const selectedTranscription = value.transcriptionModel ?? transcriptionModel;
        if (!BACKEND_MODELS.includes(selectedBackend))
            throw new Error('Choose GPT-6 Luna, GPT-5.4 Mini, GPT-6 Sol, or GPT-6 Astra for the optional Live text helper.');
        if (!TRANSCRIPTION_MODELS.includes(selectedTranscription))
            throw new Error('Choose GPT-Live-Transcribe or GPT-Transcribe for Realtime input transcription.');
        if (typeof value.greeting !== 'string' || value.greeting.trim().length < 1 || value.greeting.length > 600 || typeof value.instructions !== 'string' || value.instructions.length > 5000)
            throw new Error('The opening line must be 1–600 characters; instructions at most 5,000 characters.');
        number = value.number;
        model = value.model;
        backendModel = selectedBackend;
        transcriptionModel = selectedTranscription;
        greeting = value.greeting.trim();
        instructions = value.instructions.trim();
        error = '';
    }));
    app.post('/api/prepare', endpoint(async () => {
        requireConfigured();
        if (preparing || phase !== 'offline')
            throw new Error('Agent is already preparing or online.');
        preparing = true;
        phase = 'preparing';
        error = '';
        try {
            event('status', `Checking ${model} voice-session access${isLiveModel(model) ? `; ${backendModel} is the optional text helper` : ` with ${transcriptionModel} input transcription`}.`);
            await preflight(currentVoiceConfig());
            event('status', 'Opening the callback-only tunnel and waiting until it is publicly reachable. No number routing changed yet.');
            tunnel = await (options.tunnelFactory ?? openTunnel)(gatewayPort, message => { recordError(message); void stop(); });
            callbackPath = `/voice/${randomBytes(24).toString('hex')}`;
            callbackUrl = tunnel.url + callbackPath;
            phase = 'prepared';
        }
        catch (e) {
            tunnel?.stop();
            tunnel = undefined;
            phase = 'offline';
            callbackUrl = '';
            throw e;
        }
        finally {
            preparing = false;
        }
    }));
    app.post('/api/voice-token', endpoint(async () => {
        const client = requireConfigured();
        if (!['prepared', 'ready', 'activating'].includes(phase))
            throw new Error('Prepare the agent before registering the browser.');
        return { token: await client.token(identity, number) };
    }));
    app.post('/api/heartbeat', endpoint(async (req) => {
        registered = req.body?.registered === true;
        heartbeat = Date.now();
    }));
    app.post('/api/activate', endpoint(async () => {
        const client = requireConfigured();
        if (phase !== 'prepared' || !tunnel || !online() || mutating)
            throw new Error('Browser must be registered and the callback tunnel ready before activating.');
        mutating = true;
        phase = 'activating';
        try {
            const previous = await client.get(number);
            if (previous.status?.toUpperCase() !== 'ACTIVE')
                throw new Error('Selected number is no longer active.');
            const priorEmpty = backup && backup.number === number && !backup.previousUrl && previous.callback_url === backup.installedUrl;
            if (backup && !priorEmpty)
                throw new Error('A previous routing backup needs recovery before a new activation.');
            backup = { number, previousUrl: priorEmpty ? null : previous.callback_url, installedUrl: callbackUrl, createdAt: new Date().toISOString() };
            await store.save(backup);
            const routed = await client.routeExisting(number, callbackUrl);
            if (!routed.callback_secret)
                throw new Error('Sent did not return the callback secret for this existing number.');
            backup.callbackSecret = routed.callback_secret;
            await store.save(backup);
            phase = 'ready';
            await client.test(number);
            if (!previous.callback_url)
                warning = 'This number had no previous callback. Stop cannot clear the URL to null using the documented Sent API; configure another callback when finished.';
            event('routing', `Ready to place calls from ${number}. Inbound calls to it are rejected until Stop. Keep this tab and computer awake.`);
        }
        catch (e) {
            phase = 'prepared';
            if (backup)
                await restoreBackup(client).catch(recovery => event('error', `Recovery: ${recovery.message}`));
            throw e;
        }
        finally {
            mutating = false;
        }
    }));
    app.post('/api/stop', endpoint(async () => {
        if (preparing || mutating)
            throw new Error('Setup is still in progress; wait for it to finish before stopping.');
        await stop();
        if (error.startsWith('Routing restoration failed:'))
            throw new Error(error);
    }));
    // Escape hatch when a backup can never be restored here (e.g. the number had no previous callback, which Sent
    // cannot clear): without it every other number stays blocked. The dashboard confirms and the event log keeps the URL.
    app.post('/api/forget-backup', endpoint(async () => {
        requireStopped('Stop the agent before forgetting the routing backup.');
        if (!backup)
            return;
        const { number: forgotten, previousUrl } = backup;
        await clearBackup();
        warning = '';
        event('routing', `Forgot the routing backup for ${forgotten}. ${previousUrl ? `Its previous callback was ${previousUrl}; restore it in Sent if needed.` : 'It had no previous callback.'}`);
    }));
    // Resolves to dist/public from both dist/server.js and src/server.ts (`pnpm dev`), since dist/ and src/ are siblings.
    app.use(express.static(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/public')));
    app.use((_req, res) => res.sendStatus(404));
    const server = http.createServer(app);
    const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 });
    server.on('upgrade', (req, socket, head) => {
        const port = socket.localPort;
        const host = req.headers.host;
        const url = new URL(req.url ?? '/', 'http://localhost');
        if ((host !== `localhost:${port}` && host !== `127.0.0.1:${port}`) || req.headers.origin !== `http://${host}` || url.pathname !== '/bridge' || !equalSecret(url.searchParams.get('token') ?? '', csrf)) {
            socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
            socket.destroy();
            return;
        }
        wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
    });
    wss.on('connection', ws => {
        let session;
        let started = false;
        const startTimer = setTimeout(() => { if (!started)
            ws.close(1008, 'Start required.'); }, 5000);
        const send = (value) => {
            if (ws.readyState !== WebSocket.OPEN)
                return;
            if (ws.bufferedAmount > 128 * 1024) {
                ws.close(1011, 'Audio congestion.');
                return;
            }
            ws.send(Buffer.isBuffer(value) ? value : JSON.stringify(value));
        };
        const endCall = (reason) => { event('call', reason); send({ type: 'closed' }); ws.close(); };
        ws.on('message', async (data, binary) => {
            if (binary) {
                // OpenAIVoice.audio() drops audio before the answer; checking first avoids copying those frames.
                const voice = session?.voice;
                if (!voice?.isAnswered)
                    return;
                const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
                if (bytes.length <= 24 * 1024)
                    voice.audio(bytes);
                return;
            }
            try {
                const message = JSON.parse(data.toString());
                if (message.type === 'start') {
                    if (started || active || phase !== 'ready' || !online())
                        throw new Error('The agent is busy or not ready to call.');
                    const { to, error: refused } = checkNumberToCall(message.to, number, message.consent);
                    if (refused !== undefined)
                        throw new Error(refused);
                    started = true;
                    clearTimeout(startTimer);
                    session = { socket: ws, to, dialed: false, timer: setTimeout(() => endCall('Nobody answered in time; ending the call attempt.'), DIAL_SETUP_MS) };
                    active = session;
                    // Transcripts go to the dashboard's transcript pane over this socket; the event log keeps only call-level events.
                    const forward = value => {
                        send(value);
                        if (Buffer.isBuffer(value))
                            return;
                        if (value.type === 'error' || value.type === 'notice')
                            event(value.type, value.message);
                        if (value.type === 'end-call')
                            event('call', value.reason === 'silence' ? 'Ending the call after a long silence.' : 'The agent said goodbye and is ending the call.');
                    };
                    const voice = session.voice = new OpenAIVoice(currentVoiceConfig(to), forward);
                    await voice.connect();
                    if (ws.readyState !== WebSocket.OPEN) {
                        await voice.close();
                        return;
                    }
                    // Set only now, so the gateway would dial this number for as short a time as possible.
                    session.dialUntil = Date.now() + PENDING_DIAL_MS;
                    send({ type: 'ready', model });
                    event('call', `OpenAI voice connected; dialing ${to}.`);
                }
                else if (message.type === 'answered') {
                    const voice = session?.voice;
                    if (!session || !voice || voice.isAnswered)
                        return;
                    voice.answered();
                    clearTimeout(session.timer);
                    session.timer = setTimeout(() => endCall(`The call reached the ${MAX_CALL_MS / 60_000}-minute limit.`), MAX_CALL_MS);
                    event('call', `${session.to} answered.`);
                }
                else if (message.type === 'playback')
                    session?.voice?.reportPlayback(message.itemId, message.audioMs);
                else if (message.type === 'stop')
                    ws.close();
            }
            catch (e) {
                send({ type: 'error', message: e.message });
                ws.close();
            }
        });
        ws.on('error', () => { });
        ws.on('close', () => {
            clearTimeout(startTimer);
            if (session) {
                clearTimeout(session.timer);
                void session.voice?.close();
                if (active === session)
                    active = undefined;
                event('call', 'Call media disconnected.');
            }
        });
    });
    const watchdog = setInterval(() => { if (phase === 'ready' && !alive()) {
        event('warning', 'Browser heartbeat lost; stopping and restoring routing.');
        void stop();
    } }, 2000);
    const listen = async () => {
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 3000, '127.0.0.1', resolve); });
        return server.address().port;
    };
    const close = async () => {
        clearInterval(watchdog);
        await stop();
        for (const ws of wss.clients)
            ws.terminate();
        await Promise.all([new Promise(resolve => server.close(() => resolve())), new Promise(resolve => gatewayServer.close(() => resolve()))]);
    };
    const configureFromEnvironment = async (sentKey, key) => {
        try {
            await configureKeys(sentKey, key, 'env');
        }
        catch (e) {
            recordError(e);
            throw e;
        }
    };
    return { app, gateway, server, gatewayServer, listen, close, configureFromEnvironment, state: () => ({ phase, backup, active: active?.to, pendingDial: pendingDial() }), csrf };
}
/**
 * Startup policy for SENT_DM_API_KEY / OPENAI_API_KEY (from the shell or ./.env).
 * runtime.configureFromEnvironment() validates both keys against Sent and OpenAI exactly like the
 * dashboard form; on rejection it records the error in dashboard state, then rethrows it.
 * Dashboard entry always remains available and overrides environment keys for the session.
 */
async function applyEnvironmentKeys(runtime, sentKey, openaiKey) {
    if (!sentKey && !openaiKey)
        return;
    // Fall back to the dashboard rather than exiting: launchers are often double-clicked, so a closed window would hide the reason.
    if (!sentKey || !openaiKey) {
        console.warn(`Ignoring environment keys: ${sentKey ? 'OPENAI_API_KEY' : 'SENT_DM_API_KEY'} is not set. Enter both keys in the dashboard.`);
        return;
    }
    console.log('Validating SENT_DM_API_KEY and OPENAI_API_KEY…');
    try {
        await runtime.configureFromEnvironment(sentKey, openaiKey);
        console.log('Environment keys validated.');
    }
    catch (e) {
        console.warn(`Environment keys were not used: ${e.message} Enter keys in the dashboard instead.`);
    }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    // Optional ./.env; variables already set in the shell take precedence over the file.
    try {
        process.loadEnvFile();
    }
    catch (e) {
        if (e.code !== 'ENOENT')
            throw e;
    }
    const requestedPort = Number(process.env.PORT ?? 3000);
    if (!Number.isInteger(requestedPort) || requestedPort < 1024 || requestedPort > 65535)
        throw new Error('PORT must be an integer between 1024 and 65535.');
    // Read once, then scrub: cloudflared is spawned with the inherited environment and must never receive API keys.
    const envSentKey = process.env.SENT_DM_API_KEY?.trim();
    const envOpenaiKey = process.env.OPENAI_API_KEY?.trim();
    delete process.env.SENT_DM_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const runtime = await createApplication({ port: requestedPort });
    // Before listen(), so the first dashboard load already reflects the environment-key outcome.
    await applyEnvironmentKeys(runtime, envSentKey, envOpenaiKey);
    const port = await runtime.listen();
    console.log(`\nSent outbound agent\nOpen http://localhost:${port}\nKeys stay in this process. Keep the browser tab/computer awake.\nUse Stop & restore before closing. Ctrl+C attempts routing restoration.\n`);
    let exiting = false;
    const shutdown = async () => { if (exiting)
        return; exiting = true; console.log('Stopping and restoring routing…'); const timeout = setTimeout(() => process.exit(1), 20_000); await runtime.close(); clearTimeout(timeout); process.exit(0); };
    process.on('SIGINT', () => void shutdown());
    process.on('SIGTERM', () => void shutdown());
}
//# sourceMappingURL=server.js.map