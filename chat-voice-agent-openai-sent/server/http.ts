/** fetch() whose network errors say why: Node reports them all as "fetch failed" and keeps the reason (DNS, refused, TLS) in `cause`. */
export async function fetchWithReason(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init)
  } catch (error) {
    const cause = (error as { cause?: { code?: string; message?: string } }).cause
    const reason = cause?.code ?? cause?.message
    throw reason ? new Error(`${(error as Error).message} (${reason})`, { cause: error }) : error
  }
}
