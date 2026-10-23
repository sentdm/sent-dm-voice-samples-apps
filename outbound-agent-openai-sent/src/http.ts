import tls from 'node:tls';

// setDefaultCACertificates() exists from Node 22.19 and 24.5; @types/node 22.18 does not declare it.
const nodeTls = tls as typeof tls & { setDefaultCACertificates?: (certs: string[]) => void };

/**
 * Trusts the operating system's certificate store as well as Node's bundled one. Antivirus HTTPS scanning and
 * company proxies add their root certificate to the system store only: browsers trust it, Node does not, and
 * every fetch() and WebSocket fails with UNABLE_TO_GET_ISSUER_CERT_LOCALLY. Call before the first HTTPS request.
 */
export function trustSystemCertificates(): void {
  nodeTls.setDefaultCACertificates?.([...tls.getCACertificates('default'), ...tls.getCACertificates('system')]);
}

// The codes Node reports when a certificate chain ends at a root it does not trust.
const UNTRUSTED_ROOT = new Set(['UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN']);

/** What to do about an untrusted certificate anywhere in the error's cause chain, else ''. */
export function certificateHint(error: unknown): string {
  for (let e = error; e && typeof e === 'object'; e = (e as { cause?: unknown }).cause) {
    if (!UNTRUSTED_ROOT.has((e as { code?: string }).code ?? '')) continue;
    return nodeTls.setDefaultCACertificates
      ? 'Antivirus HTTPS scanning or a network proxy replaced the server certificate, and its root is not in the system certificate store. Set NODE_EXTRA_CA_CERTS to that root certificate file in your shell, then start again.'
      : 'Antivirus HTTPS scanning or a network proxy replaced the server certificate. Update Node.js to 22.19 or later so the app trusts the system certificate store.';
  }
  return '';
}

/** fetch() whose network errors say why: Node reports them all as "fetch failed" and keeps the reason (DNS, refused, TLS) in `cause`. */
export async function fetchWithReason(url: string, init?: RequestInit): Promise<Response> {
  try { return await fetch(url, init); }
  catch (e) {
    const cause = (e as { cause?: { code?: string; message?: string } }).cause;
    const reason = cause?.code ?? cause?.message;
    const hint = certificateHint(e);
    throw reason ? new Error(`${(e as Error).message} (${reason})${hint ? `. ${hint}` : ''}`, { cause: e }) : e;
  }
}
