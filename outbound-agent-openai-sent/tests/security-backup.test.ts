import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, readdir, rm, stat, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BackupStore, type RoutingBackup } from '../src/backup.js';
import { decideOutbound, verifySentSignature, type CallAnswer } from '../src/security.js';
import { toE164 } from '../src/phone.js';

const secret = `whsec_${Buffer.from('deterministic-test-secret').toString('base64')}`;

function signatureHeaders(raw: Buffer, id = 'evt-raw-1', timestamp = Math.floor(Date.now() / 1000), signingSecret = secret) {
  const key = Buffer.from(signingSecret.slice(6), 'base64');
  const signature = createHmac('sha256', key).update(`${id}.${timestamp}.`).update(raw).digest('base64');
  return {
    'x-webhook-id': id,
    'x-webhook-timestamp': String(timestamp),
    'x-webhook-signature': `v1,${signature}`,
  };
}

const number = '+15550000001';
const identity = 'sent-ai-test';
const contact = '+14155550123';
const now = 1_700_000_000_000;
const pending = { to: contact, until: now + 20_000 };
const liveOutbound = {
  type: 'call.request', version: '1', callId: 'call-1', number, timestamp: '2026-01-01T00:00:00.000Z',
  direction: 'outbound', from: { kind: 'user', identity }, to: { kind: 'number', number: contact },
};
const dialed = (to: string): CallAnswer => ({ action: { action: 'connectToNumber', number: to, callerId: number, dialTimeoutSeconds: 30 } });
const refused = (answer: CallAnswer, why: string) => assert.equal(answer.action.action, 'reject', why);

test('Sent signatures authenticate exact raw bytes, reject replay, and allow a valid signature among versions', () => {
  const now = 1_700_000_000_000;
  const raw = Buffer.from('{"unicode":"€","keys":[2,1]}');
  const timestamp = Math.floor(now / 1000);
  const headers = signatureHeaders(raw, 'evt-raw-bytes', timestamp);

  assert.equal(verifySentSignature(headers, raw, secret, now), true);
  assert.equal(verifySentSignature(headers, Buffer.from('{"keys":[2,1],"unicode":"€"}'), secret, now), false, 'parsing/re-serializing must not validate');
  assert.equal(verifySentSignature(headers, raw, secret, now + 300_000), true, 'the exact five-minute edge is allowed');
  assert.equal(verifySentSignature(headers, raw, secret, now + 301_000), false, 'a replay older than five minutes is rejected');

  const multiple = {
    ...headers,
    'x-webhook-signature': `v1,${Buffer.alloc(32, 9).toString('base64')} v0,ignored ${headers['x-webhook-signature']}`,
  };
  assert.equal(verifySentSignature(multiple, raw, secret, now), true, 'one valid v1 signature is sufficient');
  assert.equal(verifySentSignature({ ...headers, 'x-webhook-signature': 'v1,not-base64!!!' }, raw, secret, now), false);
  assert.equal(verifySentSignature({ ...headers, 'x-webhook-timestamp': 'not-a-time' }, raw, secret, now), false);
  assert.equal(verifySentSignature(headers, raw, 'not-a-whsec', now), false);
});

test('numbers to call are accepted only in international format and normalized to E.164', () => {
  assert.equal(toE164('+14155550123'), '+14155550123');
  assert.equal(toE164(' +1 (415) 555-0123 '), '+14155550123');
  assert.equal(toE164('+383.49.123.456'), '+38349123456');
  for (const bad of ['4155550123', '0044 20 7946 0958', '+0123456789', '+12345', '+1234567890123456', '+1 415 555 0123 ext 9', 'tel:+14155550123', '', 14155550123, undefined]) {
    assert.equal(toE164(bad), undefined, `${String(bad)} must be refused; the app never guesses a country`);
  }
});

test('outbound policy dials only the number the dashboard asked for, for this tab, while that request is pending', () => {
  assert.deepEqual(decideOutbound(liveOutbound, number, identity, pending, now), dialed(contact));
  refused(decideOutbound(liveOutbound, number, identity, undefined, now), 'nothing was requested, or the agent is not ready');
  refused(decideOutbound(liveOutbound, number, identity, pending, pending.until + 1), 'the request expired');
  refused(decideOutbound({ ...liveOutbound, to: { kind: 'number', number: '+14155550124' } }, number, identity, pending, now), 'a different number than requested');
  refused(decideOutbound({ ...liveOutbound, from: { kind: 'user', identity: 'another-app-user' } }, number, identity, pending, now), 'another app user of the account');
  refused(decideOutbound({ ...liveOutbound, to: { kind: 'user', identity: 'ben' } }, number, identity, pending, now), 'a call to an app user');
  refused(decideOutbound({ ...liveOutbound, direction: 'inbound', from: { kind: 'number', number: contact }, to: { kind: 'number', number } }, number, identity, pending, now), 'an inbound call to the number');
  refused(decideOutbound({ ...liveOutbound, version: '2' }, number, identity, pending, now), 'an unknown contract version');
  refused(decideOutbound({ ...liveOutbound, number: '+15550000009' }, number, identity, pending, now), 'a question for another number');
});

test('Sent callback tests get a harmless dial answer without using the pending request', () => {
  const probe = { ...liveOutbound, test: true, to: { kind: 'number', number: '+14155559999' } };
  assert.deepEqual(decideOutbound(probe, number, identity, undefined, now), dialed('+14155559999'), 'Sent places no call for a test');
  refused(decideOutbound({ ...probe, to: { kind: 'user', identity: 'ben' } }, number, identity, undefined, now), 'a test that is not to a number');
});

test('routing backups are private, atomically replaced, readable, and cleared', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sent-agent-backup-'));
  const file = path.join(dir, 'routing-backup.json');
  const store = new BackupStore(dir);
  const first: RoutingBackup = {
    number: '+15550000001', previousUrl: 'https://previous.example/callback', installedUrl: 'https://installed.example/voice/a', createdAt: '2026-01-01T00:00:00.000Z',
  };
  const second: RoutingBackup = { ...first, installedUrl: 'https://installed.example/voice/b', callbackSecret: secret };

  try {
    assert.equal(await store.read(), null);
    await store.save(first);
    assert.equal((await stat(dir)).mode & 0o777, 0o700, 'backup directory is owner-only');
    assert.equal((await stat(file)).mode & 0o777, 0o600, 'routing secret is owner-read/write only');
    assert.deepEqual(await store.read(), first);

    await store.save(second);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), second, 'replacement leaves a complete JSON document');
    assert.equal((await readdir(dir)).includes('routing-backup.json.tmp'), false, 'rename removes the temporary atomically-written file');
    assert.equal((await stat(file)).mode & 0o777, 0o600, 'replacement does not loosen secret permissions');

    await store.clear();
    assert.equal(await store.read(), null);
    await store.clear();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('routing backup read exposes malformed persisted data instead of silently treating it as no backup', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sent-agent-backup-malformed-'));
  try {
    const file = path.join(dir, 'routing-backup.json');
    await (await import('node:fs/promises')).writeFile(file, '{ definitely not json', { mode: 0o600 });
    await assert.rejects(new BackupStore(dir).read(), SyntaxError);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
