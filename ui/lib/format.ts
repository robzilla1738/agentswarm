import type { AggregateComponents, ForecastKind } from "./types";

/** Friendly label for a forecast domain pack id — keep in sync with src/domains/*.ts. */
const DOMAIN_LABELS: Record<string, string> = {
  sports: "Sports",
  finance: "Finance / markets",
  macro: "Macro / economy",
  elections: "Elections / politics",
  construction: "Construction / projects",
  business: "Business / operations",
  generic: "General",
};
export function domainLabel(id: string | null | undefined): string {
  if (!id) return "";
  return DOMAIN_LABELS[id] ?? id;
}

/** "panel split 28 pts" / "panel split 31%" — one phrasing for panel disagreement everywhere. */
export function splitLabel(spread: number, kind: ForecastKind): string {
  return `panel split ${Math.round(spread * 100)}${kind === "binary" ? " pts" : "%"}`;
}

export function fmtTokens(n: number): string {
  if (!n) return "0";
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(Math.round(n));
}

export function fmtMoney(n: number): string {
  if (!n) return "$0.00";
  if (n < 0.01) return "<$0.01";
  if (n < 1) return "$" + n.toFixed(3);
  return "$" + n.toFixed(2);
}

/** Compact numeric display: thousands-separated above 1000, else 4 significant figures. */
export function fmtNum(v: number): string {
  return Math.abs(v) >= 1000 ? Math.round(v).toLocaleString() : String(Number(v.toPrecision(4)));
}

/** Compact dollar volume for a market anchor ($1.2M, $340k). */
export function fmtVol(v: number): string {
  return v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `$${Math.round(v / 1e3)}k` : `$${Math.round(v)}`;
}

/**
 * The engine's mechanical aggregation chain as one string — the SINGLE source
 * of truth so the live headline and the ledger render the derivation identically.
 * "GMO 60% → extremized 64% (k=2.5) → ⚓ Polymarket 58% (w=0.40) → 60% → recalibrated 57% → updated 56% → sim 57% (w=0.20)"
 */
export function forecastChain(c: AggregateComponents | undefined, k: number): string | null {
  if (!c || typeof c.extremized !== "number") return null;
  const pct = (p: number) => `${Math.round(p * 100)}%`;
  const steps: string[] = [];
  if (typeof c.panelGmo === "number") steps.push(`GMO ${pct(c.panelGmo)}`);
  steps.push(`extremized ${pct(c.extremized)} (k=${k})`);
  if (c.market && typeof c.blended === "number") {
    const vol = typeof c.market.volume === "number" && c.market.volume > 0 ? `, ${fmtVol(c.market.volume)}` : "";
    steps.push(`⚓ ${c.market.platform} ${pct(c.market.probability)} (w=${c.market.weight.toFixed(2)}${vol}) → ${pct(c.blended)}`);
  }
  if (typeof c.recalibrated === "number") steps.push(`recalibrated ${pct(c.recalibrated)}`);
  if (typeof c.superseded === "number") steps.push(`updated ${pct(c.superseded)}`);
  if (typeof c.simulated === "number" && (c.simBlendWeight ?? 0) > 0) {
    steps.push(`sim ${pct(c.simulated)} (w=${(c.simBlendWeight ?? 0).toFixed(2)})`);
  }
  return steps.length > 1 ? steps.join(" → ") : null;
}

/** Epoch-days (how date forecasts store their quantiles) → ISO yyyy-mm-dd. */
export function daysToIso(days: number): string {
  return new Date(Math.round(days) * 86_400_000).toISOString().slice(0, 10);
}

export function fmtBytes(n: number): string {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(1) + " MB";
}

export function fmtDur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function fmtAgo(t: number, now: number): string {
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function fmtClock(t: number): string {
  const d = new Date(t);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** Fixed-width 24h clock for dense feeds — uniform column, no AM/PM. */
export function fmtClockShort(t: number): string {
  const d = new Date(t);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

/* Monochrome: state is carried by brightness + glyph, not hue. */
export const STATUS_COLOR: Record<string, string> = {
  pending: "var(--color-ink-faint)",
  running: "var(--ink-hi)",
  verifying: "var(--status-warm)",
  done: "var(--color-ink-dim)",
  failed: "var(--ink-hi)",
  blocked: "var(--status-cool)",
  planning: "var(--ink-hi)",
  "awaiting-approval": "var(--status-warm)",
  synthesizing: "var(--status-warm)",
  cancelled: "var(--color-ink-dim)",
};

export function statusColor(status: string): string {
  return STATUS_COLOR[status] ?? "var(--color-ink-dim)";
}
