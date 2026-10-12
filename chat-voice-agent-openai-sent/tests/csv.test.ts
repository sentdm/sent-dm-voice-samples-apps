import { test } from "node:test"
import assert from "node:assert/strict"
import { guessNameColumn, guessPhoneColumn, parseCsv } from "../lib/csv"

test("parses quoted fields, embedded commas and line breaks, CRLF, and a byte-order mark", () => {
  const text = '\uFEFFPhone,Name,Note\r\n+38344876143,"Krasniqi, Betim","Line one\nline two"\r\n\r\n+14155550142,Ana,"She said ""hi"""\n'
  const { headers, rows } = parseCsv(text)
  assert.deepEqual(headers, ["Phone", "Name", "Note"])
  assert.equal(rows.length, 2)
  assert.deepEqual(rows[0], { Phone: "+38344876143", Name: "Krasniqi, Betim", Note: "Line one\nline two" })
  assert.equal(rows[1].Note, 'She said "hi"')
  assert.equal(guessPhoneColumn(headers), "Phone")
  assert.equal(guessNameColumn(headers), "Name")
})
