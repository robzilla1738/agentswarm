/**
 * Dependency-free chart rendering for generated artifacts.
 *
 * Agents embed ```chart fenced blocks (JSON) in any markdown they save as an
 * .html artifact (or in the final report); mdToHtml routes them here and gets
 * back self-contained inline SVG/HTML in the house style — monochrome,
 * currentColor-based so light/dark mode both work, no scripts, no CDNs.
 *
 * Specs (all numbers finite; extra fields ignored):
 *   { "type": "line",  "title"?, "unit"?, "labels"?: string[],
 *     "series": [{ "name"?, "values": number[] }, …] }            ≤4 series
 *   { "type": "bar",   "title"?, "unit"?, "labels": string[],
 *     "series": [{ "name"?, "values": number[] }, …] }            ≤3 series
 *   { "type": "donut", "title"?, "unit"?,
 *     "segments": [{ "label", "value" }, …] }                     ≤8 segments
 *   { "type": "stat",  "title"?,
 *     "items": [{ "label", "value", "delta"? }, …] }              ≤8 cards
 *
 * A malformed spec renders as a visible error block — never silently dropped,
 * so the verifier and operator both see it.
 */

import { escapeHtml as esc } from "./util";

/** 1234567 → "1.2M", 0.0042 → "0.0042" — axis/legend numbers stay short. */
export function fmtNum(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return trim(n / 1e9) + "B";
  if (abs >= 1e6) return trim(n / 1e6) + "M";
  if (abs >= 1e4) return trim(n / 1e3) + "k";
  if (abs >= 100) return String(Math.round(n));
  if (abs >= 1) return trim(n);
  return String(Number(n.toPrecision(2)));
}
function trim(n: number): string {
  return String(Math.round(n * 10) / 10);
}

interface Series {
  name?: string;
  values: number[];
}

/** Stroke/fill treatments per series — monochrome, distinguished by pattern. */
const STROKES = [
  { dash: "", opacity: 0.9 },
  { dash: "6 3", opacity: 0.65 },
  { dash: "2 3", opacity: 0.5 },
  { dash: "8 2 2 2", opacity: 0.4 },
];

const W = 660;
const H = 280;
const PAD = { top: 14, right: 14, bottom: 26, left: 46 };

function niceTicks(min: number, max: number, n = 4): number[] {
  if (min === max) {
    min = min - 1;
    max = max + 1;
  }
  const span = max - min;
  const step = Math.pow(10, Math.floor(Math.log10(span / n)));
  const mult = span / n / step >= 5 ? 5 : span / n / step >= 2 ? 2 : 1;
  const inc = step * mult;
  const start = Math.ceil(min / inc) * inc;
  const out: number[] = [];
  for (let v = start; v <= max + inc * 0.01; v += inc) out.push(Math.round(v * 1e9) / 1e9);
  return out;
}

function legend(series: Series[]): string {
  const named = series.filter((s) => s.name);
  if (named.length < 2 && series.length < 2) return "";
  return `<div class="chart-legend">${series
    .map((s, i) => {
      const st = STROKES[i % STROKES.length];
      return `<span><svg width="18" height="8" aria-hidden="true"><line x1="0" y1="4" x2="18" y2="4" stroke="currentColor" stroke-width="2" stroke-dasharray="${st.dash}" opacity="${st.opacity}"/></svg>${esc(s.name ?? `series ${i + 1}`)}</span>`;
    })
    .join("")}</div>`;
}

function frame(inner: string, title: string | undefined, extra = ""): string {
  return `<figure class="chart">${title ? `<figcaption>${esc(title)}</figcaption>` : ""}${extra}${inner}</figure>`;
}

function plotArea(allValues: number[], unit: string) {
  const lo = Math.min(0, ...allValues);
  const hi = Math.max(...allValues);
  const ticks = niceTicks(lo, hi);
  const yMin = Math.min(lo, ticks[0] ?? lo);
  const yMax = Math.max(hi, ticks[ticks.length - 1] ?? hi);
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const y = (v: number) => PAD.top + innerH - ((v - yMin) / (yMax - yMin || 1)) * innerH;
  const grid = ticks
    .map(
      (t) =>
        `<line x1="${PAD.left}" y1="${y(t).toFixed(1)}" x2="${W - PAD.right}" y2="${y(t).toFixed(1)}" stroke="currentColor" opacity="0.12" stroke-width="1"/>` +
        `<text x="${PAD.left - 7}" y="${(y(t) + 3.5).toFixed(1)}" text-anchor="end" class="tick">${esc(unit)}${fmtNum(t)}</text>`
    )
    .join("");
  return { y, grid, innerW, innerH };
}

function xLabels(labels: string[] | undefined, count: number, xAt: (i: number) => number): string {
  if (!labels?.length) return "";
  const max = 8;
  const every = Math.max(1, Math.ceil(count / max));
  return labels
    .slice(0, count)
    .map((l, i) =>
      i % every === 0
        ? `<text x="${xAt(i).toFixed(1)}" y="${H - 7}" text-anchor="middle" class="tick">${esc(String(l).slice(0, 14))}</text>`
        : ""
    )
    .join("");
}

function lineChart(spec: { title?: string; unit?: string; labels?: string[]; series: Series[] }): string {
  // Non-finite entries (JSON null, "n/a") stay in place as GAPS — filtering
  // them out would shift later points under the wrong x labels.
  const series = spec.series.slice(0, 4).map((s) => ({ ...s, values: s.values.map((v) => (Number.isFinite(v) ? v : NaN)) }));
  const n = Math.max(...series.map((s) => s.values.length));
  const finite = series.flatMap((s) => s.values.filter(Number.isFinite));
  if (n < 2 || finite.length < 2) throw new Error("line chart needs at least 2 points");
  const unit = spec.unit ?? "";
  const { y, grid } = plotArea(finite, unit);
  const xAt = (i: number) => PAD.left + (i / (n - 1)) * (W - PAD.left - PAD.right);

  const paths = series
    .map((s, si) => {
      const st = STROKES[si % STROKES.length];
      let d = "";
      let pen = false;
      let lastIdx = -1;
      s.values.forEach((v, i) => {
        if (!Number.isFinite(v)) {
          pen = false; // gap: lift the pen, next finite point restarts the path
          return;
        }
        d += `${pen ? "L" : "M"}${xAt(i).toFixed(1)},${y(v).toFixed(1)} `;
        pen = true;
        lastIdx = i;
      });
      if (lastIdx < 0) return "";
      // Soft area fill under the first series only — keeps multi-series readable.
      const area =
        si === 0
          ? `<path d="${d}L${xAt(lastIdx).toFixed(1)},${H - PAD.bottom} L${PAD.left},${H - PAD.bottom} Z" fill="currentColor" opacity="0.05"/>`
          : "";
      return (
        area +
        `<path d="${d.trim()}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-dasharray="${st.dash}" opacity="${st.opacity}" stroke-linejoin="round"/>` +
        `<circle cx="${xAt(lastIdx).toFixed(1)}" cy="${y(s.values[lastIdx]).toFixed(1)}" r="2.6" fill="currentColor" opacity="${st.opacity}"/>`
      );
    })
    .join("");

  const svg = `<svg viewBox="0 0 ${W} ${H}" role="img">${grid}${paths}${xLabels(spec.labels, n, xAt)}</svg>`;
  return frame(svg, spec.title, legend(series));
}

function barChart(spec: { title?: string; unit?: string; labels: string[]; series: Series[] }): string {
  const series = spec.series.slice(0, 3);
  const n = Math.max(...series.map((s) => s.values.length));
  if (!n) throw new Error("bar chart needs values");
  const unit = spec.unit ?? "";
  const { y, grid } = plotArea([0, ...series.flatMap((s) => s.values.filter(Number.isFinite))], unit);
  const innerW = W - PAD.left - PAD.right;
  const groupW = innerW / n;
  const barW = Math.min(38, (groupW * 0.72) / series.length);
  const y0 = y(0);

  const bars = series
    .map((s, si) => {
      const opacity = [0.85, 0.45, 0.22][si] ?? 0.2;
      return s.values
        .slice(0, n)
        .map((v, i) => {
          if (!Number.isFinite(v)) return "";
          const cx = PAD.left + groupW * (i + 0.5);
          const x = cx - (barW * series.length) / 2 + si * barW;
          const top = Math.min(y(v), y0);
          const h = Math.abs(y0 - y(v));
          return `<rect x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${(barW - 2).toFixed(1)}" height="${Math.max(h, 0.5).toFixed(1)}" rx="2" fill="currentColor" opacity="${opacity}"/>`;
        })
        .join("");
    })
    .join("");

  const svg = `<svg viewBox="0 0 ${W} ${H}" role="img">${grid}${bars}${xLabels(spec.labels, n, (i) => PAD.left + groupW * (i + 0.5))}</svg>`;
  return frame(svg, spec.title, legend(series));
}

function donutChart(spec: { title?: string; unit?: string; segments: { label: string; value: number }[] }): string {
  const segs = spec.segments.filter((s) => Number.isFinite(s.value) && s.value > 0).slice(0, 8);
  const total = segs.reduce((a, s) => a + s.value, 0);
  if (!total) throw new Error("donut needs positive segment values");
  const size = 180;
  const c = size / 2;
  const r = 70;
  const stroke = 26;
  const circ = 2 * Math.PI * r;
  let offset = 0;
  const rings = segs
    .map((s, i) => {
      const frac = s.value / total;
      const opacity = 0.9 - (i * 0.78) / Math.max(segs.length - 1, 1);
      const el = `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="currentColor" stroke-width="${stroke}" opacity="${opacity.toFixed(2)}" stroke-dasharray="${(frac * circ).toFixed(2)} ${circ.toFixed(2)}" stroke-dashoffset="${(-offset * circ).toFixed(2)}" transform="rotate(-90 ${c} ${c})"/>`;
      offset += frac;
      return el;
    })
    .join("");
  const rows = segs
    .map((s, i) => {
      const opacity = 0.9 - (i * 0.78) / Math.max(segs.length - 1, 1);
      const pct = Math.round((s.value / total) * 100);
      return `<tr><td><span class="swatch" style="opacity:${opacity.toFixed(2)}"></span>${esc(s.label)}</td><td>${esc(spec.unit ?? "")}${fmtNum(s.value)}</td><td>${pct}%</td></tr>`;
    })
    .join("");
  const inner = `<div class="donut-wrap"><svg viewBox="0 0 ${size} ${size}" role="img" class="donut">${rings}</svg><table class="donut-key">${rows}</table></div>`;
  return frame(inner, spec.title);
}

function statCards(spec: { title?: string; items: { label: string; value: string | number; delta?: string | number }[] }): string {
  const items = spec.items.slice(0, 8);
  if (!items.length) throw new Error("stat needs items");
  const cards = items
    .map((it) => {
      const d = it.delta !== undefined && it.delta !== "" ? String(it.delta) : "";
      const up = /^[+▲]/.test(d) || (typeof it.delta === "number" && it.delta > 0);
      const down = /^[-▼−]/.test(d) || (typeof it.delta === "number" && it.delta < 0);
      const deltaHtml = d
        ? `<div class="stat-delta">${up ? "▲" : down ? "▼" : ""} ${esc(d.replace(/^[+\-▲▼−]\s*/, ""))}</div>`
        : "";
      return `<div class="stat-card"><div class="stat-label">${esc(String(it.label))}</div><div class="stat-value">${esc(String(it.value))}</div>${deltaHtml}</div>`;
    })
    .join("");
  return frame(`<div class="stat-grid">${cards}</div>`, spec.title);
}

/** ```chart block body → house-style HTML. Throws with a readable message on a bad spec. */
export function renderChart(specJson: string): string {
  let spec: any;
  try {
    spec = JSON.parse(specJson);
  } catch (e) {
    throw new Error(`chart spec is not valid JSON: ${e instanceof Error ? e.message : e}`);
  }
  switch (spec?.type) {
    case "line":
      if (!Array.isArray(spec.series) || !spec.series.length) throw new Error('line chart needs "series"');
      return lineChart(spec);
    case "bar":
      if (!Array.isArray(spec.series) || !spec.series.length) throw new Error('bar chart needs "series"');
      if (!Array.isArray(spec.labels)) throw new Error('bar chart needs "labels"');
      return barChart(spec);
    case "donut":
      if (!Array.isArray(spec.segments)) throw new Error('donut chart needs "segments"');
      return donutChart(spec);
    case "stat":
      if (!Array.isArray(spec.items)) throw new Error('stat block needs "items"');
      return statCards(spec);
    default:
      throw new Error(`unknown chart type "${spec?.type}" — use line | bar | donut | stat`);
  }
}

/** Visible, non-fatal error block: a bad spec must not sink the whole document. */
export function chartError(message: string, specJson: string): string {
  return `<figure class="chart chart-error"><figcaption>chart failed: ${esc(message)}</figcaption><pre><code>${esc(specJson.slice(0, 600))}</code></pre></figure>`;
}

/** Styles for everything this module emits — merged into the document shell CSS. */
export const CHART_CSS = `
figure.chart { margin: 22px 0; }
figure.chart figcaption {
  font: 600 11px/1.5 ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  letter-spacing: .07em; text-transform: uppercase; color: #8a887f; margin-bottom: 8px;
}
figure.chart svg { width: 100%; height: auto; display: block; }
figure.chart .tick { font: 10px ui-monospace, "SF Mono", Menlo, Consolas, monospace; fill: currentColor; opacity: .45; }
.chart-legend { display: flex; flex-wrap: wrap; gap: 4px 16px; margin-bottom: 6px; font: 11px ui-monospace, "SF Mono", Menlo, Consolas, monospace; color: #8a887f; }
.chart-legend span { display: inline-flex; align-items: center; gap: 6px; }
.donut-wrap { display: flex; align-items: center; gap: 28px; flex-wrap: wrap; }
.donut { width: 180px; max-width: 180px; flex-shrink: 0; }
table.donut-key { border: 0; margin: 0; width: auto; font-size: 13px; }
table.donut-key td { border: 0; padding: 3px 14px 3px 0; }
table.donut-key td:nth-child(2), table.donut-key td:nth-child(3) { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 12px; }
.swatch { display: inline-block; width: 10px; height: 10px; border-radius: 3px; background: currentColor; margin-right: 8px; vertical-align: -1px; }
.stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; }
.stat-card { border: 1px solid rgba(128,128,128,.2); border-radius: 10px; padding: 12px 14px; }
.stat-label { font: 500 10px/1.5 ui-monospace, "SF Mono", Menlo, Consolas, monospace; letter-spacing: .08em; text-transform: uppercase; color: #8a887f; }
.stat-value { font-size: 22px; font-weight: 650; letter-spacing: -0.01em; margin-top: 3px; }
.stat-delta { font: 11px ui-monospace, "SF Mono", Menlo, Consolas, monospace; color: #8a887f; margin-top: 2px; }
figure.chart-error { border: 1px solid rgba(128,128,128,.3); border-radius: 8px; padding: 10px 14px; }
`;
