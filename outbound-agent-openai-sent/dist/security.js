import { createHmac, timingSafeEqual } from 'node:crypto';
import { toE164 } from './phone.js';
export function equalSecret(a, b) {
    const left = Buffer.from(a), right = Buffer.from(b);
    return left.length === right.length && timingSafeEqual(left, right);
}
export function verifySentSignature(headers, raw, secret, now = Date.now()) {
    const id = headers['x-webhook-id'], stamp = headers['x-webhook-timestamp'], signature = headers['x-webhook-signature'];
    if (typeof id !== 'string' || typeof stamp !== 'string' || typeof signature !== 'string' || !/^\d+$/.test(stamp))
        return false;
    if (Math.abs(Math.floor(now / 1000) - Number(stamp)) > 300)
        return false;
    if (!/^whsec_[A-Za-z0-9+/]+=*$/.test(secret))
        return false;
    const key = Buffer.from(secret.slice(6), 'base64');
    const expected = createHmac('sha256', key).update(`${id}.${stamp}.`).update(raw).digest();
    return signature.split(/\s+/).some(part => {
        if (!part.startsWith('v1,'))
            return false;
        const actual = Buffer.from(part.slice(3), 'base64');
        return actual.length === expected.length && timingSafeEqual(actual, expected);
    });
}
export const DIAL_TIMEOUT_SECONDS = 30;
const declined = () => ({ action: { action: 'reject', reason: 'declined' } });
// The contact sees the selected Sent number as caller ID; Sent would also default to it (the question's `number`).
const dial = (to, callerId) => ({ action: { action: 'connectToNumber', number: to, callerId, dialTimeoutSeconds: DIAL_TIMEOUT_SECONDS } });
/**
 * Answers Sent's callback question for the selected number. Sent asks it for every call in both directions, and the
 * answer decides what rings: `connectToNumber` dials a phone and charges your balance. This is the toll-fraud guard.
 */
export function decideOutbound(question, number, identity, pending, now = Date.now()) {
    if (question.type !== 'call.request' || question.version !== '1' || question.number !== number)
        return declined();
    const to = question.to?.kind === 'number' ? toE164(question.to.number) : undefined;
    // Sent's callback test places no call and charges nothing. Dialing its `to` lets Sent check the full answer, caller ID included.
    if (question.test === true)
        return to ? dial(to, number) : declined();
    // Inbound calls to the number arrive here too, and so do calls placed by any other app user of your account.
    // Only the call this tab just asked for may dial: from this identity, to exactly the pending number, before it expires.
    const fromThisTab = question.direction === 'outbound' && question.from?.kind === 'user' && question.from.identity === identity;
    if (!fromThisTab || !pending || to !== pending.to || now > pending.until)
        return declined();
    return dial(pending.to, number);
}
//# sourceMappingURL=security.js.map