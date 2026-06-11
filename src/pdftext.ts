import * as zlib from "zlib";

/**
 * Minimal zero-dependency PDF text extraction: inflate FlateDecode content
 * streams (Node's built-in zlib) and interpret the text-showing operators
 * (Tj / TJ / ' / "). Good enough for most digitally-produced text PDFs;
 * returns null for scanned, encrypted, or exotic-encoding documents so the
 * caller can tell the agent to find an HTML source instead.
 */
export function extractPdfText(buf: Buffer): { text: string; pages: number } | null {
  if (buf.subarray(0, 5).toString("latin1") !== "%PDF-") return null;
  // latin1 preserves bytes 1:1, so stream offsets in the string match the buffer.
  const raw = buf.toString("latin1");
  const pages = (raw.match(/\/Type\s*\/Pages?\b/g) || []).filter((m) => !/Pages/.test(m)).length || 1;

  let text = "";
  const streamRe = /<<([\s\S]{0,2000}?)>>\s*stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = streamRe.exec(raw))) {
    const dict = m[1];
    const start = m.index + m[0].length;
    const end = raw.indexOf("endstream", start);
    if (end < 0) continue;
    streamRe.lastIndex = end;
    // Only plain or Flate-compressed streams are supported.
    if (/\/Filter/.test(dict) && !/FlateDecode/.test(dict)) continue;
    let len = end;
    while (len > start && (raw[len - 1] === "\n" || raw[len - 1] === "\r")) len--;
    let data = buf.subarray(start, len);
    if (/FlateDecode/.test(dict)) {
      try {
        data = zlib.inflateSync(data);
      } catch {
        continue;
      }
    }
    const content = data.toString("latin1");
    if (!/\bBT\b/.test(content)) continue; // not a text content stream
    const extracted = extractFromContent(content);
    if (extracted.trim()) text += extracted + "\n";
  }

  const cleaned = text
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  // CID/Type0 fonts yield glyph-index garbage; require a body of real characters.
  const printable = cleaned.replace(/[^\x20-\x7E\n -￿]/g, "");
  if (printable.replace(/\s/g, "").length < 40) return null;
  return { text: printable, pages };
}

/** Walk a content stream, collecting strings shown by Tj/TJ/'/" with newline heuristics. */
function extractFromContent(src: string): string {
  let out = "";
  let pending: string[] = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const ch = src[i];
    if (ch === "(") {
      const [s, next] = parseLiteralString(src, i);
      pending.push(s);
      i = next;
    } else if (ch === "<" && src[i + 1] !== "<") {
      const close = src.indexOf(">", i + 1);
      if (close < 0) break;
      pending.push(decodeHexString(src.slice(i + 1, close)));
      i = close + 1;
    } else if (ch === "%") {
      // comment to end of line
      while (i < n && src[i] !== "\n" && src[i] !== "\r") i++;
    } else if (/[A-Za-z'"*]/.test(ch)) {
      let j = i;
      while (j < n && /[A-Za-z'"*]/.test(src[j])) j++;
      const op = src.slice(i, j);
      if (op === "Tj" || op === "TJ") {
        out += pending.join("");
      } else if (op === "'" || op === '"') {
        out += "\n" + pending.join("");
      } else if (op === "Td" || op === "TD" || op === "T*" || op === "Tm" || op === "ET") {
        if (pending.length) out += pending.join("");
        if (!out.endsWith("\n")) out += "\n";
      }
      pending = [];
      i = j;
    } else if (ch === "-" || (ch >= "0" && ch <= "9") || ch === ".") {
      let j = i + 1;
      while (j < n && /[0-9.]/.test(src[j])) j++;
      // Large negative kerning inside a TJ array is a word gap.
      const num = parseFloat(src.slice(i, j));
      if (num <= -180 && pending.length && !pending[pending.length - 1].endsWith(" ")) pending.push(" ");
      i = j;
    } else {
      i++;
    }
  }
  return out;
}

/** PDF literal string: balanced parens, backslash escapes, octal codes. */
function parseLiteralString(src: string, start: number): [string, number] {
  let out = "";
  let depth = 0;
  let i = start;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === "\\") {
      const next = src[i + 1];
      if (next >= "0" && next <= "7") {
        let oct = "";
        for (let k = 1; k <= 3 && src[i + k] >= "0" && src[i + k] <= "7"; k++) oct += src[i + k];
        out += String.fromCharCode(parseInt(oct, 8));
        i += oct.length;
      } else {
        const map: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "(": "(", ")": ")", "\\": "\\" };
        out += map[next] ?? next ?? "";
        i++;
      }
    } else if (ch === "(") {
      depth++;
      if (depth > 1) out += ch;
    } else if (ch === ")") {
      depth--;
      if (depth === 0) {
        i++;
        break;
      }
      out += ch;
    } else {
      out += ch;
    }
  }
  return [out, i];
}

/** PDF hex string: byte pairs; a UTF-16BE BOM switches to two-byte chars. */
function decodeHexString(hex: string): string {
  const clean = hex.replace(/[^0-9a-fA-F]/g, "");
  const bytes: number[] = [];
  for (let i = 0; i + 1 < clean.length; i += 2) bytes.push(parseInt(clean.slice(i, i + 2), 16));
  if (clean.length % 2) bytes.push(parseInt(clean[clean.length - 1] + "0", 16));
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let s = "";
    for (let i = 2; i + 1 < bytes.length; i += 2) s += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    return s;
  }
  return bytes.map((b) => String.fromCharCode(b)).join("");
}
