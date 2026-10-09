import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, readdir, rm, stat, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BackupStore, type RoutingBackup } from '../src/backup.js';
import { decideInbound, verifySentSignature } from '../src/security.js';

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

const liveInbound = {
  type: 'call.request', version: '1', callId: 'call-1', number: '+15550000001', timestamp: '2026-01-01T00:00:00.000Z',
  direction: 'inbound', to: { kind: 'number', number: '+15550000001' },
};

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

test('inbound policy accepts only ready inbound calls, treats synthetic tests safely, and rejects busy/offline/outgoing calls', () => {
  const identity = 'sent-ai-test';
  assert.deepEqual(decideInbound(liveInbound, liveInbound.number, identity, true, false), { action: { action: 'connectToUser', identity } });
  assert.deepEqual(decideInbound(liveInbound, liveInbound.number, identity, false, false), { action: { action: 'reject', reason: 'busy' } }, 'offline browser never accepts a live call');
  assert.deepEqual(decideInbound(liveInbound, liveInbound.number, identity, true, true), { action: { action: 'reject', reason: 'busy' } });
  assert.deepEqual(decideInbound({ ...liveInbound, direction: 'outbound' }, liveInbound.number, identity, true, false), { action: { action: 'reject', reason: 'declined' } });
  assert.deepEqual(decideInbound({ ...liveInbound, to: { kind: 'user', number: liveInbound.number } }, liveInbound.number, identity, true, false), { action: { action: 'reject', reason: 'declined' } });
  assert.deepEqual(decideInbound({ ...liveInbound, test: true, direction: 'outbound' }, liveInbound.number, identity, false, true), { action: { action: 'connectToUser', identity } }, 'Sent callback probes never originate a call');
  assert.deepEqual(decideInbound({ ...liveInbound, version: '2' }, liveInbound.number, identity, true, false), { action: { action: 'reject', reason: 'declined' } });
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
