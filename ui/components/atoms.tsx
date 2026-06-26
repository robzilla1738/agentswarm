"use client";

import Link from "next/link";
import { useLayoutEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { statusColor } from "@/lib/format";
import { markdownChartComponents } from "./ChartBlock";

/**
 * The one way to render model-written text. Everything an agent or the
 * conductor writes is markdown — raw text walls are never shown to the
 * operator. `compact` is the 13px variant for side rails and drawers.
 */
export function Md({ children, compact, dim }: { children: string; compact?: boolean; dim?: boolean }) {
  return (
    <div className={`prose-report${compact ? " prose-compact" : ""}${dim ? " prose-dim" : ""}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownChartComponents}>
        {children}
      </ReactMarkdown>
    </div>
  );
}

/**
 * Collapses long content to roughly `lines` lines with a fade-out mask and a
 * "Show more" toggle. Max-height based (not line-clamp) because `Md` renders
 * block elements. The toggle only appears when the content actually overflows.
 */
export function Clamp({ children, lines = 3 }: { children: React.ReactNode; lines?: number }) {
  const [open, setOpen] = useState(false);
  const [canExpand, setCanExpand] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const maxHeight = `${Math.round(lines * 1.55 * 10) / 10}em`;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => setCanExpand(el.scrollHeight > el.clientHeight + 2);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [children, open]);

  return (
    <div>
      <div
        ref={ref}
        className={!open && canExpand ? "clamp-fade" : undefined}
        style={open ? undefined : { maxHeight, overflow: "hidden" }}
      >
        {children}
      </div>
      {(canExpand || open) && (
        <button
          onClick={() => setOpen((v) => !v)}
          className="text-2xs mt-1 text-ink-faint hover:text-ink transition-colors"
        >
          {open ? "Show less ▴" : "Show more ▾"}
        </button>
      )}
    </div>
  );
}

/** The swarm mark (halftone bee, white on transparent). */
export function LogoMark({ size = 30 }: { size?: number }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/swarm-mark.png"
      alt=""
      aria-hidden
      className="shrink-0 select-none"
      style={{ height: size, width: "auto", filter: "var(--logo-filter)" }}
      draggable={false}
    />
  );
}

export function Logo({ small }: { small?: boolean }) {
  return (
    <Link href="/" className="flex items-center gap-2.5">
      <LogoMark size={small ? 24 : 28} />
      <span className={`font-display ${small ? "text-base" : "text-lg"}`}>
        agentswarm
      </span>
    </Link>
  );
}

export function StatusDot({ status, size = 8, pulse }: { status: string; size?: number; pulse?: boolean }) {
  const color = statusColor(status);
  const live = pulse ?? ["running", "planning", "synthesizing", "verifying", "awaiting-approval"].includes(status);
  return (
    <span className="relative inline-flex" style={{ width: size, height: size }}>
      {live && (
        <span
          className="absolute inset-0 rounded-full animate-ping"
          style={{ background: color, opacity: 0.4 }}
        />
      )}
      <span className="relative rounded-full" style={{ width: size, height: size, background: color }} />
    </span>
  );
}

export function StatusBadge({ status }: { status: string }) {
  // Monochrome alarm: failure inverts to filled white.
  if (status === "failed") {
    return <span className="chip chip-solid">✕ failed</span>;
  }
  const color = statusColor(status);
  return (
    <span
      className="chip"
      style={{ color, borderColor: `color-mix(in oklab, ${color} 35%, var(--color-border))`, background: `color-mix(in oklab, ${color} 7%, transparent)` }}
    >
      <StatusDot status={status} size={6} />
      {status}
    </span>
  );
}

export function BudgetBar({ spent, cap, height = 5 }: { spent: number; cap: number; height?: number }) {
  const pct = cap > 0 ? Math.min(100, (spent / cap) * 100) : 0;
  const hot = pct > 85;
  return (
    <div className="w-full rounded-full overflow-hidden" style={{ height, background: "rgb(var(--hi) / 0.07)" }}>
      <div
        className="h-full rounded-full bg-ink transition-all duration-500"
        style={{ width: `${pct}%`, animation: hot ? "var(--animate-pulse-soft)" : undefined }}
      />
    </div>
  );
}

/** Hand-rolled SVG sparkline — no chart library for one little line. */
export function Sparkline({ points, width = 120, height = 26 }: { points: number[]; width?: number; height?: number }) {
  if (points.length < 2) return null;
  const max = Math.max(...points);
  const min = Math.min(...points);
  const flat = max === min;
  const span = max - min || 1;
  const step = width / (points.length - 1);
  // A flat (zero-variance) series rides the vertical middle, not the invisible bottom edge.
  const y = (p: number) => (flat ? height / 2 : height - 2 - ((p - min) / span) * (height - 4));
  const d = points.map((p, i) => `${i === 0 ? "M" : "L"}${(i * step).toFixed(1)},${y(p).toFixed(1)}`).join(" ");
  const area = `${d} L${width},${height} L0,${height} Z`;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="block" aria-hidden>
      <path d={area} fill="rgb(var(--hi) / 0.06)" stroke="none" />
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.4" opacity="0.65" />
      <circle cx={width} cy={y(points[points.length - 1])} r="2" fill="currentColor" opacity="0.9" />
    </svg>
  );
}

export function Spinner({ size = 14, dark }: { size?: number; dark?: boolean }) {
  return (
    <span
      className="inline-block rounded-full animate-spin"
      style={{
        width: size,
        height: size,
        border: dark ? "1.5px solid color-mix(in srgb, var(--color-bg) 25%, transparent)" : "1.5px solid rgb(var(--hi) / 0.18)",
        borderTopColor: dark ? "var(--color-bg)" : "var(--ink-hi)",
      }}
    />
  );
}

export function CopyButton({ text, label = "Copy" }: { text: string | (() => string); label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="btn btn-sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(typeof text === "function" ? text() : text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard unavailable */
        }
      }}
    >
      {copied ? "Copied ✓" : label}
    </button>
  );
}

export function EmptyState({ glyph, title, sub }: { glyph: string; title: string; sub?: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-14 px-6 text-center">
      <div className="glyph mb-4" style={{ width: 44, height: 44, fontSize: 16 }}>
        {glyph}
      </div>
      <div className="font-semibold text-sm text-ink-dim">{title}</div>
      {sub && <div className="text-xs mt-1.5 max-w-[340px] leading-relaxed text-ink-faint">{sub}</div>}
    </div>
  );
}

export function ToolIcon({ name }: { name?: string }) {
  const map: Record<string, string> = {
    shell: "❯", read_file: "▤", write_file: "✎", replace_in_file: "✎", list_dir: "▸",
    web_search: "⌕", fetch_url: "↓", note: "✦", save_artifact: "↧", report: "✓",
    spawn_tasks: "⊕", verdict: "◈", submit_final: "■", wait: "∥", finish: "▣",
  };
  return <span className="mono text-ink-faint">{map[name ?? ""] ?? "·"}</span>;
}
