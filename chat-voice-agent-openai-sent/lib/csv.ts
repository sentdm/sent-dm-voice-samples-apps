// No Node.js imports: the browser parses uploaded files with it, and the tests run it directly.

/**
 * Parses CSV text (RFC 4180: quoted fields, "" escapes, commas and line
 * breaks inside quotes, CRLF or LF). Returns the header row and one object
 * per data row, keyed by header. Empty lines are skipped.
 */
export function parseCsv(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const records: string[][] = []
  let field = ""
  let record: string[] = []
  let quoted = false
  const source = text.replace(/^\uFEFF/, "")
  for (let i = 0; i < source.length; i++) {
    const char = source[i]
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') {
        field += '"'
        i++
      } else if (char === '"') quoted = false
      else field += char
    } else if (char === '"') quoted = true
    else if (char === ",") {
      record.push(field)
      field = ""
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[i + 1] === "\n") i++
      record.push(field)
      records.push(record)
      record = []
      field = ""
    } else field += char
  }
  if (field || record.length) {
    record.push(field)
    records.push(record)
  }
  const nonEmpty = records.filter((r) => r.some((cell) => cell.trim()))
  const headers = (nonEmpty.shift() ?? []).map((h) => h.trim())
  const rows = nonEmpty.map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? "").trim()])))
  return { headers, rows }
}

/** The column that most likely holds phone numbers. */
export function guessPhoneColumn(headers: string[]) {
  return headers.find((h) => /^(phone|phone.?number|number|mobile|msisdn|tel|to)$/i.test(h.trim())) ?? headers[0]
}

/** The column that most likely holds names. */
export function guessNameColumn(headers: string[]) {
  return headers.find((h) => /^(name|full.?name|first.?name|customer|contact)$/i.test(h.trim()))
}
