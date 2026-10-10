/** fetch() whose network errors say why: Node reports them all as "fetch failed" and keeps the reason (DNS, refused, TLS) in `cause`. */
export async function fetchWithReason(url, init) {
    try {
        return await fetch(url, init);
    }
    catch (e) {
        const cause = e.cause;
        const reason = cause?.code ?? cause?.message;
        throw reason ? new Error(`${e.message} (${reason})`, { cause: e }) : e;
    }
}
//# sourceMappingURL=http.js.map