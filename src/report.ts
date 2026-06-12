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

import { CHART_CSS, chartError, renderChart } from "./charts";
import { canonicalizeUrl } from "./searchcore";
import { SourceRef, Task } from "./types";
import { clip, escapeHtml as esc } from "./util";

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

    // Fenced code block. ```chart blocks render as inline SVG charts.
    const fence = /^\s*(```|~~~)\s*(\S*)/.exec(line);
    if (fence) {
      flushAll();
      const buf: string[] = [];
      for (i++; i < lines.length && !lines[i].trim().startsWith(fence[1]); i++) buf.push(lines[i]);
      if (fence[2].toLowerCase() === "chart") {
        const spec = buf.join("\n");
        try {
          html.push(renderChart(spec));
        } catch (e) {
          html.push(chartError(e instanceof Error ? e.message : String(e), spec));
        }
        continue;
      }
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
  margin: 0; padding: 56px 24px 96px;
  font: 15px/1.7 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
  background: #fdfdfc; color: #1d1d1b;
  -webkit-font-smoothing: antialiased;
}
@media (prefers-color-scheme: dark) { body { background: #141413; color: #e7e5e0; } }
main, header.run-meta { max-width: 720px; margin: 0 auto; }
header.run-meta {
  margin-bottom: 40px; padding-bottom: 16px;
  border-bottom: 1px solid rgba(128,128,128,.2);
  font: 500 11px/1.6 ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  letter-spacing: .08em; text-transform: uppercase; color: #8a887f;
  display: flex; flex-wrap: wrap; gap: 6px 16px; align-items: baseline;
}
.badge { font-weight: 700; color: inherit; }
.badge.done::before { content: "✓ "; }
.badge.failed { color: #b3392f; }
.badge.failed::before { content: "✕ "; }
.badge.cancelled::before { content: "◌ "; }
h1, h2, h3, h4 { line-height: 1.3; letter-spacing: -0.011em; font-weight: 650; }
h1 { font-size: 26px; margin: 0 0 20px; }
h2 { font-size: 19px; margin: 40px 0 12px; padding-top: 18px; border-top: 1px solid rgba(128,128,128,.14); }
h3 { font-size: 16px; margin: 26px 0 8px; }
h4 { font-size: 15px; margin: 20px 0 6px; }
p { margin: 10px 0; }
a { color: inherit; text-decoration: underline; text-decoration-color: rgba(128,128,128,.45); text-underline-offset: 2.5px; }
a:hover { text-decoration-color: currentColor; }
code {
  font: 12.5px/1.5 ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  background: rgba(128,128,128,.11); padding: 1.5px 5px; border-radius: 4px;
}
pre {
  background: rgba(128,128,128,.07); border: 1px solid rgba(128,128,128,.15);
  border-radius: 8px; padding: 13px 15px; overflow-x: auto;
}
pre code { background: none; padding: 0; }
blockquote {
  margin: 16px 0; padding: 1px 18px; border-left: 2px solid rgba(128,128,128,.35);
  color: #75736b;
}
table { border-collapse: collapse; margin: 18px 0; width: 100%; font-size: 13.5px; }
th, td { border: 0; border-bottom: 1px solid rgba(128,128,128,.18); padding: 7px 10px; text-align: left; vertical-align: top; }
th {
  font: 600 11px/1.5 ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  letter-spacing: .07em; text-transform: uppercase; color: #8a887f;
  border-bottom: 1.5px solid rgba(128,128,128,.35);
}
img { max-width: 100%; border-radius: 6px; }
hr { border: none; border-top: 1px solid rgba(128,128,128,.2); margin: 32px 0; }
ul, ol { padding-left: 24px; margin: 10px 0; }
li { margin: 4px 0; }
li::marker { color: #a8a69d; }
`;

export interface DocHtmlOpts {
  markdown: string;
  /** <title>; falls back to the markdown's first # heading. */
  title?: string;
  /** Small mono meta strip above the document. Raw HTML spans — escape inputs. */
  metaHtml?: string;
}

/**
 * The house document shell: every generated HTML artifact and the final
 * report render through this — one style, self-contained (inline CSS, no
 * scripts, no external fetches), chart blocks included.
 */
export function renderDocHtml(o: DocHtmlOpts): string {
  const title = o.title ?? /^#\s+(.+)$/m.exec(o.markdown)?.[1] ?? "Report";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title.slice(0, 120))}</title>
<style>${CSS}${CHART_CSS}</style>
</head>
<body>
${o.metaHtml ? `<header class="run-meta">${o.metaHtml}</header>` : ""}
<main>
${mdToHtml(o.markdown)}
</main>
</body>
</html>
`;
}

export interface FinalHtmlOpts {
  markdown: string;
  mission: string;
  runId: string;
  status: "done" | "failed" | "cancelled";
  finishedAt: number;
}

/** Self-contained HTML document (inline CSS, no scripts, no external fetches). */
export function renderFinalHtml(o: FinalHtmlOpts): string {
  const date = new Date(o.finishedAt).toISOString().replace("T", " ").slice(0, 16) + " UTC";
  return renderDocHtml({
    markdown: o.markdown,
    title: /^#\s+(.+)$/m.exec(o.markdown)?.[1] ?? o.mission,
    metaHtml:
      `<span class="badge ${o.status}">${o.status}</span>` +
      `<span>${esc(o.runId)}</span><span>${esc(date)}</span>` +
      `<span title="${esc(o.mission.slice(0, 600))}">${esc(clip(o.mission, 80))}</span>`,
  });
}
