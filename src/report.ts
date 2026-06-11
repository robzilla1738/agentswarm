/**
 * Dependency-free markdown → styled HTML rendering for final reports.
 *
 * Every run writes artifacts/final-report.html next to final-report.md so the
 * operator always gets a readable, shareable document — even for fallback and
 * failure reports. This is NOT a full CommonMark implementation; it covers the
 * subset models actually emit in reports: headings, paragraphs, lists (nested),
 * fenced code, inline code, bold/italic, links, images, tables, blockquotes,
 * and horizontal rules. Unknown constructs degrade to escaped text — never to
 * broken markup.
 */

import { canonicalizeUrl } from "./searchcore";
import { SourceRef, Task } from "./types";

// ---------- source aggregation (citation pipeline) ----------

export interface NumberedSource extends SourceRef {
  n: number;
  /** Tasks whose reports cited this source. */
  taskIds: string[];
}

/**
 * Dedupe every task's reported sources (by canonical URL) into one numbered
 * bibliography for the synthesizer. First occurrence wins the number; later
 * tasks fill in missing titles/dates.
 */
export function aggregateSources(tasks: Task[]): NumberedSource[] {
  const byKey = new Map<string, NumberedSource>();
  for (const t of tasks) {
    for (const s of t.sources ?? []) {
      const key = canonicalizeUrl(s.url);
      const cur = byKey.get(key);
      if (cur) {
        if (!cur.taskIds.includes(t.id)) cur.taskIds.push(t.id);
        if (!cur.title && s.title) cur.title = s.title;
        if (!cur.date && s.date) cur.date = s.date;
        if (!cur.note && s.note) cur.note = s.note;
      } else {
        byKey.set(key, { ...s, n: byKey.size + 1, taskIds: [t.id] });
      }
    }
  }
  return [...byKey.values()];
}

/** Render the numbered source list for prompts (one line per source). */
export function sourcesBlock(sources: NumberedSource[]): string {
  return sources
    .map(
      (s) =>
        `[${s.n}] ${s.title ? `${s.title} — ` : ""}${s.url}${s.date ? ` (${s.date})` : ""}${s.note ? ` — ${s.note}` : ""} [cited by ${s.taskIds.join(",")}]`
    )
    .join("\n");
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Inline markdown on an already-escaped string. Code spans are opaque. */
function inline(s: string): string {
  const out: string[] = [];
  // Split on code spans first so no other rule fires inside them.
  const parts = s.split(/(`+[^`]*`+)/g);
  for (const part of parts) {
    const code = /^(`+)([^`]*)\1$/.exec(part);
    if (code) {
      out.push(`<code>${code[2].trim() || "`"}</code>`);
      continue;
    }
    let t = part;
    // Images before links (same bracket syntax).
    t = t.replace(
      /!\[([^\]]*)\]\((https?:[^()\s]+)\)/g,
      '<img src="$2" alt="$1" loading="lazy">'
    );
    t = t.replace(
      /\[([^\]]+)\]\(((?:https?:|#|\.{0,2}\/)[^()\s]*)\)/g,
      '<a href="$2" target="_blank" rel="noopener">$1</a>'
    );
    t = t.replace(/\*\*\*([^*]+)\*\*\*/g, "<strong><em>$1</em></strong>");
    t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    t = t.replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
    t = t.replace(/(^|[\s(])_([^_\s][^_]*)_(?=[\s.,;:!?)]|$)/g, "$1<em>$2</em>");
    // Bare URLs become links (escaped text, so no quotes can appear inside).
    t = t.replace(
      /(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?])/g,
      '$1<a href="$2" target="_blank" rel="noopener">$2</a>'
    );
    out.push(t);
  }
  return out.join("");
}

interface ListFrame {
  indent: number;
  tag: "ul" | "ol";
}

export function mdToHtml(md: string): string {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const html: string[] = [];
  const lists: ListFrame[] = [];
  let para: string[] = [];
  let quote: string[] = [];

  const closeLists = (toIndent = -1) => {
    while (lists.length && lists[lists.length - 1].indent > toIndent) {
      html.push(`</li></${lists.pop()!.tag}>`);
    }
  };
  const flushPara = () => {
    if (para.length) {
      html.push(`<p>${inline(esc(para.join(" ")))}</p>`);
      para = [];
    }
  };
  const flushQuote = () => {
    if (quote.length) {
      html.push(`<blockquote>${mdToHtml(quote.join("\n"))}</blockquote>`);
      quote = [];
    }
  };
  const flushAll = () => {
    flushPara();
    flushQuote();
    closeLists();
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Fenced code block.
    const fence = /^\s*(```|~~~)\s*(\S*)/.exec(line);
    if (fence) {
      flushAll();
      const buf: string[] = [];
      for (i++; i < lines.length && !lines[i].trim().startsWith(fence[1]); i++) buf.push(lines[i]);
      const lang = fence[2] ? ` class="lang-${esc(fence[2])}"` : "";
      html.push(`<pre><code${lang}>${esc(buf.join("\n"))}</code></pre>`);
      continue;
    }

    // Blockquote (grouped, recursively rendered).
    const q = /^\s*>\s?(.*)$/.exec(line);
    if (q) {
      flushPara();
      closeLists();
      quote.push(q[1]);
      continue;
    }
    flushQuote();

    // Blank line ends the current paragraph / list run (unless the next
    // non-blank line continues the list).
    if (!line.trim()) {
      flushPara();
      if (lists.length) {
        let j = i + 1;
        while (j < lines.length && !lines[j].trim()) j++;
        if (j >= lines.length || !/^(\s*)([-*+]|\d+[.)])\s+/.test(lines[j])) closeLists();
      }
      continue;
    }

    // Heading.
    const h = /^(#{1,6})\s+(.*)$/.exec(line.trim());
    if (h) {
      flushAll();
      const level = h[1].length;
      const text = h[2].replace(/\s+#+\s*$/, "");
      html.push(`<h${level}>${inline(esc(text))}</h${level}>`);
      continue;
    }

    // Horizontal rule.
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
      flushAll();
      html.push("<hr>");
      continue;
    }

    // Table: header row + |---| separator.
    if (line.includes("|") && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1]) && lines[i + 1].includes("-")) {
      flushAll();
      const cells = (row: string) =>
        row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => inline(esc(c.trim())));
      const head = cells(line);
      const rows: string[][] = [];
      for (i += 2; i < lines.length && lines[i].includes("|") && lines[i].trim(); i++) rows.push(cells(lines[i]));
      i--;
      html.push(
        "<table><thead><tr>" +
          head.map((c) => `<th>${c}</th>`).join("") +
          "</tr></thead><tbody>" +
          rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("") +
          "</tbody></table>"
      );
      continue;
    }

    // List item (unordered or ordered, nested by indentation).
    const li = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) {
      flushPara();
      const indent = li[1].length;
      const tag: "ul" | "ol" = /\d/.test(li[2]) ? "ol" : "ul";
      const top = lists[lists.length - 1];
      if (!top || indent > top.indent) {
        lists.push({ indent, tag });
        html.push(`<${tag}><li>${inline(esc(li[3]))}`);
      } else {
        closeLists(indent);
        const cur = lists[lists.length - 1];
        if (cur && cur.indent === indent && cur.tag !== tag) {
          html.push(`</li></${lists.pop()!.tag}>`);
        }
        if (lists.length && lists[lists.length - 1].indent === indent) {
          html.push(`</li><li>${inline(esc(li[3]))}`);
        } else {
          lists.push({ indent, tag });
          html.push(`<${tag}><li>${inline(esc(li[3]))}`);
        }
      }
      continue;
    }

    // Continuation line inside a list item.
    if (lists.length && /^\s{2,}\S/.test(line)) {
      html.push(` ${inline(esc(line.trim()))}`);
      continue;
    }

    closeLists();
    para.push(line.trim());
  }
  flushAll();
  return html.join("\n");
}

const CSS = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
  margin: 0; padding: 48px 24px 96px;
  font: 16px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
  background: #fcfcfa; color: #1c1c1a;
}
@media (prefers-color-scheme: dark) { body { background: #131312; color: #e8e6e1; } }
main { max-width: 860px; margin: 0 auto; }
header.run-meta {
  max-width: 860px; margin: 0 auto 36px; padding-bottom: 20px;
  border-bottom: 1px solid rgba(128,128,128,.25);
  font-size: 13px; color: #6e6e68; display: flex; flex-wrap: wrap; gap: 8px 18px; align-items: center;
}
.badge { padding: 2px 10px; border-radius: 999px; font-weight: 600; font-size: 12px; letter-spacing: .02em; }
.badge.done { background: rgba(34,160,84,.14); color: #1d8a4c; }
.badge.failed { background: rgba(214,60,60,.14); color: #c23b3b; }
.badge.cancelled { background: rgba(150,150,150,.18); color: #77756f; }
h1, h2, h3, h4 { line-height: 1.25; letter-spacing: -0.012em; }
h1 { font-size: 30px; margin: 0 0 18px; }
h2 { font-size: 22px; margin: 36px 0 12px; }
h3 { font-size: 18px; margin: 28px 0 10px; }
a { color: #2563c4; text-decoration: none; }
a:hover { text-decoration: underline; }
@media (prefers-color-scheme: dark) { a { color: #7aa7e8; } }
code {
  font: 13.5px/1.5 ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  background: rgba(128,128,128,.13); padding: 1.5px 5px; border-radius: 4px;
}
pre {
  background: rgba(128,128,128,.09); border: 1px solid rgba(128,128,128,.18);
  border-radius: 8px; padding: 14px 16px; overflow-x: auto;
}
pre code { background: none; padding: 0; }
blockquote {
  margin: 16px 0; padding: 2px 18px; border-left: 3px solid rgba(128,128,128,.35);
  color: #6e6e68;
}
table { border-collapse: collapse; margin: 18px 0; width: 100%; font-size: 14.5px; }
th, td { border: 1px solid rgba(128,128,128,.25); padding: 7px 12px; text-align: left; vertical-align: top; }
th { background: rgba(128,128,128,.08); }
img { max-width: 100%; border-radius: 6px; }
hr { border: none; border-top: 1px solid rgba(128,128,128,.25); margin: 32px 0; }
ul, ol { padding-left: 26px; }
li { margin: 3px 0; }
`;

export interface FinalHtmlOpts {
  markdown: string;
  mission: string;
  runId: string;
  status: "done" | "failed" | "cancelled";
  finishedAt: number;
}

/** Self-contained HTML document (inline CSS, no scripts, no external fetches). */
export function renderFinalHtml(o: FinalHtmlOpts): string {
  const title = /^#\s+(.+)$/m.exec(o.markdown)?.[1] ?? o.mission;
  const date = new Date(o.finishedAt).toISOString().replace("T", " ").slice(0, 16) + " UTC";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title.slice(0, 120))}</title>
<style>${CSS}</style>
</head>
<body>
<header class="run-meta">
  <span class="badge ${o.status}">${o.status}</span>
  <span>run ${esc(o.runId)}</span>
  <span>${esc(date)}</span>
  <span title="${esc(o.mission.slice(0, 600))}">mission: ${esc(o.mission.length > 90 ? o.mission.slice(0, 90) + "…" : o.mission)}</span>
</header>
<main>
${mdToHtml(o.markdown)}
</main>
</body>
</html>
`;
}
