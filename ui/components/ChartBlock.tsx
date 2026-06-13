"use client";

import { useMemo } from "react";

/**
 * In-app renderer for ```chart fenced blocks in reports — the client mirror of
 * src/charts.ts (which renders the same specs to HTML for the styled artifact).
 * Without this, react-markdown shows the raw {"type":"stat",…} JSON as a code
 * block. Monochrome, currentColor-based, no chart library. Specs:
 *   {type:"stat",  items:[{label,value,delta?}]}                 ≤8 cards
 *   {type:"donut", segments:[{label,value}], unit?}              ≤8 segments
 *   {type:"bar",   labels:[…], series:[{name?,values:[…]}], unit?}  ≤3 series
 *   {type:"line",  labels?:[…], series:[{name?,values:[…]}], unit?} ≤4 series
 * A spec that won't parse or render falls back to a quiet, contained block —
 * never the glaring raw dump.
 */

type StatItem = { label: string; value: string | number; delta?: string | number };
type Segment = { label: string; value: number };
type Series = { name?: string; values: number[] };
type ChartSpec =
  | { type: "stat"; title?: string; items: StatItem[] }
  | { type: "donut"; title?: string; unit?: string; segments: Segment[] }
  | { type: "bar"; title?: string; unit?: string; labels: string[]; series: Series[] }
  | { type: "line"; title?: string; unit?: string; labels?: string[]; series: Series[] };

const fmtNum = (n: number): string => {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${Math.round(n / 1e8) / 10}B`;
  if (abs >= 1e6) return `${Math.round(n / 1e5) / 10}M`;
  if (abs >= 1e4) return `${Math.round(n / 1e2) / 10}k`;
  if (abs >= 100) return String(Math.round(n));
  if (abs >= 1) return String(Math.round(n * 10) / 10);
  return String(Number(n.toPrecision(2)));
};

const STROKES = [
  { dash: "", op: 0.9 },
  { dash: "6 3", op: 0.65 },
  { dash: "2 3", op: 0.5 },
  { dash: "8 2 2 2", op: 0.4 },
];

function Frame({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <figure className="my-5">
      {title && <figcaption className="mono text-2xs uppercase tracking-wider text-ink-faint mb-2">{title}</figcaption>}
      {children}
    </figure>
  );
}

function StatCards({ spec }: { spec: Extract<ChartSpec, { type: "stat" }> }) {
  const items = spec.items.slice(0, 8);
  if (!items.length) return null;
  return (
    <Frame title={spec.title}>
      <div className="flex flex-wrap gap-3">
        {items.map((it, i) => {
          const d = it.delta !== undefined && it.delta !== "" ? String(it.delta) : "";
          const up = /^[+▲]/.test(d) || (typeof it.delta === "number" && it.delta > 0);
          const down = /^[-▼−]/.test(d) || (typeof it.delta === "number" && it.delta < 0);
          return (
            <div
              key={i}
              className="flex-1 min-w-[120px] rounded-lg border border-border-soft px-3.5 py-2.5"
              style={{ background: "rgb(var(--hi) / 0.015)" }}
            >
              <div className="mono text-2xs uppercase tracking-wider text-ink-faint">{String(it.label)}</div>
              <div className="text-xl font-semibold text-ink mt-1 leading-tight">{String(it.value)}</div>
              {d && (
                <div className={`mono text-2xs mt-0.5 ${up ? "text-ink" : down ? "text-ink-dim" : "text-ink-faint"}`}>
                  {up ? "▲ " : down ? "▼ " : ""}
                  {d.replace(/^[+\-▲▼−]\s*/, "")}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Frame>
  );
}

function Donut({ spec }: { spec: Extract<ChartSpec, { type: "donut" }> }) {
  const segs = spec.segments.filter((s) => Number.isFinite(s.value) && s.value > 0).slice(0, 8);
  const total = segs.reduce((a, s) => a + s.value, 0);
  if (!total) return null;
  const size = 180;
  const c = size / 2;
  const r = 70;
  const stroke = 26;
  const circ = 2 * Math.PI * r;
  const op = (i: number) => 0.9 - (i * 0.78) / Math.max(segs.length - 1, 1);
  let acc = 0;
  const arcs = segs.map((s, i) => {
    const frac = s.value / total;
    const o = acc;
    acc += frac;
    return { s, frac, o, i };
  });
  return (
    <Frame title={spec.title}>
      <div className="flex items-center gap-7 flex-wrap">
        <svg viewBox={`0 0 ${size} ${size}`} role="img" className="w-[180px] shrink-0 text-ink">
          {arcs.map(({ frac, o, i }) => (
            <circle
              key={i}
              cx={c}
              cy={c}
              r={r}
              fill="none"
              stroke="currentColor"
              strokeWidth={stroke}
              opacity={op(i).toFixed(2)}
              strokeDasharray={`${(frac * circ).toFixed(2)} ${circ.toFixed(2)}`}
              strokeDashoffset={(-o * circ).toFixed(2)}
              transform={`rotate(-90 ${c} ${c})`}
            />
          ))}
        </svg>
        <table className="text-sm">
          <tbody>
            {segs.map((s, i) => (
              <tr key={i}>
                <td className="pr-3.5 py-0.5 text-ink-dim">
                  <span
                    className="inline-block w-2.5 h-2.5 rounded-sm bg-[var(--color-ink)] mr-1.5 align-middle"
                    style={{ opacity: op(i) }}
                  />
                  {s.label}
                </td>
                <td className="pr-3.5 py-0.5 mono text-xs text-ink-dim">
                  {spec.unit ?? ""}
                  {fmtNum(s.value)}
                </td>
                <td className="py-0.5 mono text-xs text-ink-dim">{Math.round((s.value / total) * 100)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Frame>
  );
}

function Legend({ series }: { series: Series[] }) {
  if (series.length < 2) return null;
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 mb-1.5 mono text-2xs text-ink-faint">
      {series.map((s, i) => (
        <span key={i}>{s.name ?? `series ${i + 1}`}</span>
      ))}
    </div>
  );
}

function LineChart({ spec }: { spec: Extract<ChartSpec, { type: "line" }> }) {
  const series = spec.series.slice(0, 4).filter((s) => Array.isArray(s.values) && s.values.filter(Number.isFinite).length >= 2);
  if (!series.length) return null;
  const W = 660;
  const H = 220;
  const padL = 42;
  const padR = 12;
  const padT = 12;
  const padB = 22;
  const all = series.flatMap((s) => s.values).filter(Number.isFinite);
  let min = Math.min(...all);
  let max = Math.max(...all);
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const n = Math.max(...series.map((s) => s.values.length));
  const x = (i: number) => padL + (n > 1 ? (i / (n - 1)) * (W - padL - padR) : 0);
  const y = (v: number) => padT + (1 - (v - min) / (max - min)) * (H - padT - padB);
  return (
    <Frame title={spec.title}>
      <Legend series={series} />
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full text-ink">
        {[max, min].map((v, i) => (
          <text key={i} x={4} y={y(v) + 3} className="fill-current mono" fontSize="10" opacity={0.4}>
            {fmtNum(v)}
          </text>
        ))}
        {series.map((s, i) => (
          <polyline
            key={i}
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            opacity={STROKES[i].op}
            strokeDasharray={STROKES[i].dash}
            points={s.values.map((v, j) => `${x(j).toFixed(1)},${y(v).toFixed(1)}`).join(" ")}
          />
        ))}
      </svg>
    </Frame>
  );
}

function BarChart({ spec }: { spec: Extract<ChartSpec, { type: "bar" }> }) {
  const labels = spec.labels.slice(0, 16);
  const series = spec.series.slice(0, 3).filter((s) => Array.isArray(s.values));
  if (!series.length || !labels.length) return null;
  const all = series.flatMap((s) => s.values).filter(Number.isFinite);
  const max = Math.max(0, ...all);
  const W = 660;
  const H = 220;
  const padL = 42;
  const padR = 12;
  const padT = 12;
  const padB = 28;
  const groupW = (W - padL - padR) / labels.length;
  const barW = (groupW * 0.7) / series.length;
  const yOf = (v: number) => padT + (1 - (max ? v / max : 0)) * (H - padT - padB);
  const op = (i: number) => 0.9 - (i * 0.5) / Math.max(series.length - 1, 1);
  return (
    <Frame title={spec.title}>
      <Legend series={series} />
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full text-ink">
        {[max].map((v, i) => (
          <text key={i} x={4} y={yOf(v) + 3} className="fill-current mono" fontSize="10" opacity={0.4}>
            {spec.unit ?? ""}
            {fmtNum(v)}
          </text>
        ))}
        {labels.map((lab, gi) => (
          <g key={gi}>
            {series.map((s, si) => {
              const v = s.values[gi];
              if (!Number.isFinite(v)) return null;
              const bx = padL + gi * groupW + groupW * 0.15 + si * barW;
              const by = yOf(v);
              const bh = H - padB - by;
              return (
                <rect
                  key={si}
                  x={bx.toFixed(1)}
                  y={by.toFixed(1)}
                  width={barW.toFixed(1)}
                  height={Math.max(0, bh).toFixed(1)}
                  fill="currentColor"
                  opacity={op(si).toFixed(2)}
                />
              );
            })}
            <text
              x={(padL + gi * groupW + groupW / 2).toFixed(1)}
              y={H - 8}
              textAnchor="middle"
              className="fill-current mono"
              fontSize="10"
              opacity={0.5}
            >
              {String(lab).slice(0, 8)}
            </text>
          </g>
        ))}
      </svg>
    </Frame>
  );
}

/**
 * react-markdown `components` override that renders ```chart fences as charts.
 * A fence becomes <pre><code class="language-chart">…</code></pre>; we detect
 * that and swap the whole <pre> for <ChartBlock>, leaving every other code
 * block untouched. Shared by ReportPanel and the app-wide `Md` renderer so
 * model-written charts render the same everywhere (mirrors src/charts.ts).
 */
export const markdownChartComponents = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pre({ children, node, ...rest }: any) {
    const child = Array.isArray(children) ? children[0] : children;
    const className: string = child?.props?.className || "";
    if (/\blanguage-chart\b/.test(className)) {
      const raw = String(child.props.children ?? "").replace(/\n$/, "");
      return <ChartBlock raw={raw} />;
    }
    return <pre {...rest}>{children}</pre>;
  },
};

export function ChartBlock({ raw }: { raw: string }) {
  const spec = useMemo<ChartSpec | null>(() => {
    try {
      return JSON.parse(raw) as ChartSpec;
    } catch {
      return null;
    }
  }, [raw]);

  const rendered = useMemo(() => {
    if (!spec || typeof spec !== "object") return null;
    try {
      if (spec.type === "stat" && Array.isArray(spec.items)) return <StatCards spec={spec} />;
      if (spec.type === "donut" && Array.isArray(spec.segments)) return <Donut spec={spec} />;
      if (spec.type === "bar" && Array.isArray(spec.series) && Array.isArray(spec.labels)) return <BarChart spec={spec} />;
      if (spec.type === "line" && Array.isArray(spec.series)) return <LineChart spec={spec} />;
    } catch {
      /* fall through to the contained fallback */
    }
    return null;
  }, [spec]);

  if (rendered) return rendered;

  // Couldn't parse or render — keep it quiet and contained, never a raw dump.
  return (
    <figure className="my-5">
      <figcaption className="mono text-2xs uppercase tracking-wider text-ink-faint mb-1">chart</figcaption>
      <pre
        className="text-2xs text-ink-faint overflow-x-auto rounded p-2 m-0"
        style={{ background: "rgb(var(--hi) / 0.03)" }}
      >
        <code>{raw}</code>
      </pre>
    </figure>
  );
}
