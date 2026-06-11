// Unit tests for the zero-dep PDF text extractor: minimal PDFs are assembled
// in-test (zlib.deflateSync for FlateDecode streams) so no fixtures needed.
const test = require("node:test");
const assert = require("node:assert");
const zlib = require("zlib");

const { extractPdfText } = require("../../dist/pdftext.js");

/** Hand-assemble a one-page PDF whose content stream is `content`. */
function minimalPdf(content, { compress = true } = {}) {
  const stream = compress ? zlib.deflateSync(Buffer.from(content, "latin1")) : Buffer.from(content, "latin1");
  const filter = compress ? " /Filter /FlateDecode" : "";
  return Buffer.concat([
    Buffer.from(
      "%PDF-1.4\n" +
        "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n" +
        "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n" +
        "3 0 obj << /Type /Page /Parent 2 0 R /Contents 4 0 R >> endobj\n" +
        `4 0 obj << /Length ${stream.length}${filter} >> stream\n`,
      "latin1"
    ),
    stream,
    Buffer.from("\nendstream endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n", "latin1"),
  ]);
}

const LONG = "This sentence pads the document so the extractor's minimum-content gate passes cleanly.";

test("extracts Tj text from a FlateDecode stream", () => {
  const pdf = minimalPdf(`BT /F1 12 Tf 72 720 Td (Hello swarm) Tj 0 -14 Td (${LONG}) Tj ET`);
  const out = extractPdfText(pdf);
  assert.ok(out, "extraction should succeed");
  assert.equal(out.pages, 1);
  assert.match(out.text, /Hello swarm\n/);
  assert.match(out.text, /pads the document/);
});

test("uncompressed content streams work too", () => {
  const out = extractPdfText(minimalPdf(`BT (Plain text body. ${LONG}) Tj ET`, { compress: false }));
  assert.ok(out);
  assert.match(out.text, /Plain text body\./);
});

test("TJ arrays join segments and turn large kerning into spaces", () => {
  const out = extractPdfText(minimalPdf(`BT [(Hel) -50 (lo) -250 (world)] TJ (. ${LONG}) Tj ET`));
  assert.ok(out);
  assert.match(out.text, /Hello world\./);
});

test("escapes and octal codes in literal strings", () => {
  const out = extractPdfText(minimalPdf(`BT (a\\(b\\)c \\101BC. ${LONG}) Tj ET`));
  assert.ok(out);
  assert.match(out.text, /a\(b\)c ABC\./);
});

test("hex strings decode (single-byte and UTF-16BE)", () => {
  // "Hi" = 4869; UTF-16BE with BOM: FEFF00480069
  const out = extractPdfText(minimalPdf(`BT <4869> Tj ( ) Tj <FEFF00480069> Tj (. ${LONG}) Tj ET`));
  assert.ok(out);
  assert.match(out.text, /Hi Hi\./);
});

test("non-PDF and scanned-style PDFs return null", () => {
  assert.equal(extractPdfText(Buffer.from("not a pdf at all")), null);
  // A "PDF" whose only stream is an unsupported filter (e.g. image data).
  const scanned = Buffer.concat([
    Buffer.from("%PDF-1.4\n3 0 obj << /Type /Page >> endobj\n4 0 obj << /Length 4 /Filter /DCTDecode >> stream\n", "latin1"),
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    Buffer.from("\nendstream endobj\n%%EOF", "latin1"),
  ]);
  assert.equal(extractPdfText(scanned), null);
});
