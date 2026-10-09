import { createHmac, timingSafeEqual } from 'node:crypto';

export function equalSecret(a: string, b: string): boolean {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function verifySentSignature(headers: Record<string, unknown>, raw: Buffer, secret: string, now = Date.now()): boolean {
  const id = headers['x-webhook-id'], stamp = headers['x-webhook-timestamp'], signature = headers['x-webhook-signature'];
  if (typeof id !== 'string' || typeof stamp !== 'string' || typeof signature !== 'string' || !/^\d+$/.test(stamp)) return false;
  if (Math.abs(Math.floor(now / 1000) - Number(stamp)) > 300) return false;
  if (!/^whsec_[A-Za-z0-9+/]+=*$/.test(secret)) return false;
  const key = Buffer.from(secret.slice(6), 'base64');
  const expected = createHmac('sha256', key).update(`${id}.${stamp}.`).update(raw).digest();
  return signature.split(/\s+/).some(part => {
    if (!part.startsWith('v1,')) return false;
    const actual = Buffer.from(part.slice(3), 'base64');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  });
}

export interface CallQuestion {
  type: string; version: string; callId: string; number: string; timestamp: string;
  direction?: string; test?: boolean; from?: { kind: string }; to?: { kind: string; number?: string };
}
export type CallAnswer = { action: { action: 'connectToUser'; identity: string } | { action: 'reject'; reason: 'busy' | 'declined' } };
export function decideInbound(question: CallQuestion, number: string, identity: string, ready: boolean, busy: boolean): CallAnswer {
  if (question.type !== 'call.request' || question.version !== '1' || question.number !== number) return { action: { action: 'reject', reason: 'declined' } };
  // Synthetic tests are allowed to validate the route but must never originate a call.
  if (question.test === true) return { action: { action: 'connectToUser', identity } };
  if (question.direction !== 'inbound' || question.to?.kind !== 'number' || question.to.number !== number) return { action: { action: 'reject', reason: 'declined' } };
  if (!ready || busy) return { action: { action: 'reject', reason: 'busy' } };
  return { action: { action: 'connectToUser', identity } };
}
