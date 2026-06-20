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
  synthesizing: "var(--status-warm)",
  cancelled: "var(--color-ink-dim)",
};

export function statusColor(status: string): string {
  return STATUS_COLOR[status] ?? "var(--color-ink-dim)";
}
