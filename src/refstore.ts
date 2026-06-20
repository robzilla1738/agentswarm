// The reference-class / persistence store. Two accumulation needs, three
// append-only JSONL logs under ~/.agentswarm/refstore/, all mirroring the
// ledger's discipline (append-only, malformed-line-skip, latest-wins reduce):
//
//   series.jsonl    fetched {date,value}[] series — so a run doesn't re-fetch
//                   FRED/SEC/Census every time, and history ACCUMULATES across
//                   runs (revisions + new periods merge by date).
//   reftables.jsonl long-TTL lookup tables (e.g. the SEC ticker→CIK map).
//   refclass.jsonl  denormalized resolved-outcome rows tagged by domain +
//                   reference-class key, so a domain pack can ask "base rate of
//                   X" and get a COUNTED frequency, not an LLM guess.
//
// Every read is best-effort and every write fire-and-append: a corrupt/locked
// store degrades to live-fetch and never fails a run.

import * as fs from "fs";
import * as path from "path";
import { home } from "./config";
import { ensureDir } from "./util";
import type { ForecastKind } from "./types";
import type { LedgerOutcome } from "./forecast";
import type { TimeSeriesResult, TimeSeriesSource } from "./datatools";

export interface SeriesRecord {
  v: 1;
  kind: "series";
  source: TimeSeriesSource;
  series: string;
  /** Fetch time (ms) — drives TTL. */
  t: number;
  label: string;
  unit?: string;
  points: { date: string; value: number }[];
}

export interface RefTableRecord {
  v: 1;
  kind: "reftable";
  key: string;
  t: number;
  ttlDays: number;
  data: unknown;
}

export interface RefClassRecord {
  v: 1;
  kind: "refclass";
  t: number;
  domain: string;
  /** Normalized reference-class key, e.g. "infra_project_schedule_slip". */
  refClass: string;
  /** Human text (audit). */
  question: string;
  /** The question kind, so queryRefClass can bucket binary vs numeric. */
  qkind: ForecastKind;
  outcome: LedgerOutcome;
  /** Optional de-normalized features the pack buckets on. */
  features?: Record<string, number | string>;
  /** Back-pointer to the ledger entry (also the de-dup / self-exclusion key). */
  ledgerId: string;
}

export function refstoreDir(): string {
  return path.join(home(), "refstore");
}
function logPath(name: string): string {
  return path.join(refstoreDir(), name);
}
export const seriesPath = () => logPath("series.jsonl");
export const reftablePath = () => logPath("reftables.jsonl");
export const refclassPath = () => logPath("refclass.jsonl");

function append(file: string, rec: unknown): void {
  ensureDir(refstoreDir());
  fs.appendFileSync(file, JSON.stringify(rec) + "\n", "utf8");
}
function* readLines(file: string): Generator<Record<string, unknown>> {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return;
  }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (rec && typeof rec === "object") yield rec;
    } catch {
      /* malformed line — skip, never throw */
    }
  }
}

// ---------------------------------------------------------------- series

export function appendSeries(rec: SeriesRecord): void {
  append(seriesPath(), rec);
}

/** A reduced series: points merged across every stored snapshot for the key. */
export interface StoredSeries {
  source: TimeSeriesSource;
  series: string;
  /** Most recent snapshot time for this key. */
  t: number;
  label: string;
  unit?: string;
  points: { date: string; value: number }[];
}

function mergePoints(
  a: { date: string; value: number }[],
  b: { date: string; value: number }[],
): { date: string; value: number }[] {
  const m = new Map<string, number>();
  for (const p of a) if (p && typeof p.date === "string" && Number.isFinite(p.value)) m.set(p.date, p.value);
  for (const p of b) if (p && typeof p.date === "string" && Number.isFinite(p.value)) m.set(p.date, p.value);
  return [...m.entries()]
    .map(([date, value]) => ({ date, value }))
    .sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
}

/** Reduce series.jsonl: newest snapshot per (source|series), points merged by date (newer wins). */
// Memoize the reduced series map within a process, keyed by the file's
// (size, mtime). time_series is called many times per run (fanned-out scouts +
// every domain driver); without this each call re-reads and re-parses the whole
// file. The key changes on any append, so freshness is exact.
let seriesMemo: { stamp: string; map: Map<string, StoredSeries> } | null = null;

export function loadSeries(): Map<string, StoredSeries> {
  let stamp = "";
  try {
    const st = fs.statSync(seriesPath());
    stamp = `${st.size}:${st.mtimeMs}`;
    if (seriesMemo && seriesMemo.stamp === stamp) return seriesMemo.map;
  } catch {
    return new Map(); // no file yet
  }
  const out = new Map<string, StoredSeries>();
  const records: SeriesRecord[] = [];
  for (const rec of readLines(seriesPath())) {
    if (rec.kind === "series" && typeof rec.series === "string" && Array.isArray(rec.points)) {
      records.push(rec as unknown as SeriesRecord);
    }
  }
  // Process oldest→newest so the newest snapshot's value wins on a date collision.
  records.sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
  for (const rec of records) {
    const key = `${rec.source}|${rec.series}`;
    const prev = out.get(key);
    out.set(key, {
      source: rec.source,
      series: rec.series,
      t: Math.max(prev?.t ?? 0, rec.t ?? 0),
      label: rec.label ?? prev?.label ?? rec.series,
      unit: rec.unit ?? prev?.unit,
      points: prev ? mergePoints(prev.points, rec.points) : rec.points,
    });
  }
  seriesMemo = { stamp, map: out };
  return out;
}

/**
 * Bound series.jsonl growth: every TTL miss appends a full snapshot, so the file
 * grows without limit and 99% of it is superseded redundancy. When it crosses a
 * size threshold, rewrite it to the reduced one-record-per-key form (atomic
 * tmp+rename), restoring loadSeries cost to O(distinct series). Best-effort.
 */
const SERIES_COMPACT_BYTES = 4 * 1024 * 1024;
function maybeCompactSeries(): void {
  let size = 0;
  try {
    size = fs.statSync(seriesPath()).size;
  } catch {
    return;
  }
  if (size < SERIES_COMPACT_BYTES) return;
  try {
    const map = loadSeries();
    const body =
      [...map.values()]
        .map((s) =>
          JSON.stringify({ v: 1, kind: "series", source: s.source, series: s.series, t: s.t, label: s.label, unit: s.unit, points: s.points } satisfies SeriesRecord)
        )
        .join("\n") + "\n";
    const tmp = `${seriesPath()}.tmp`;
    fs.writeFileSync(tmp, body, "utf8");
    fs.renameSync(tmp, seriesPath());
    seriesMemo = null; // file replaced — drop the memo
  } catch {
    /* compaction is best-effort; the append already succeeded */
  }
}

/** Per-source default freshness windows, from each feed's real update cadence. Keyed by the closed TimeSeriesSource union so a typo or a removed source is a compile error. */
export const SERIES_TTL: Partial<Record<TimeSeriesSource, number>> = {
  yahoo: 60 * 60_000, // intraday — short
  fred: 12 * 3_600_000,
  eia: 12 * 3_600_000,
  bls: 24 * 3_600_000, // monthly releases
  usaspending: 24 * 3_600_000,
  secfacts: 7 * 86_400_000, // quarterly filings
  gdelt: 6 * 3_600_000,
  gdelttone: 6 * 3_600_000,
  openmeteo: 6 * 3_600_000,
  nws: 3 * 3_600_000,
  wikipageviews: 12 * 3_600_000,
  worldbank: 30 * 86_400_000, // annual
};
const DEFAULT_SERIES_TTL = 12 * 3_600_000;
export function ttlFor(source: TimeSeriesSource): number {
  return SERIES_TTL[source] ?? DEFAULT_SERIES_TTL;
}

/**
 * Cache-through a series fetch: return the stored snapshot when fresh, else
 * fetch + append + return (merged with accumulated history). On fetch failure
 * fall back to the stale stored series with a warn — external data is worth
 * keeping; a dead API must never blank a series the store already has.
 */
export async function cachedSeries(
  source: TimeSeriesSource,
  series: string,
  fetcher: () => Promise<TimeSeriesResult>,
  opts: { ttlMs?: number; log?: (level: "info" | "warn", msg: string) => void } = {},
): Promise<TimeSeriesResult> {
  const ttl = opts.ttlMs ?? ttlFor(source);
  const key = `${source}|${series}`;
  let stored: StoredSeries | undefined;
  try {
    stored = loadSeries().get(key);
  } catch {
    /* store unreadable — fall through to a live fetch */
  }
  if (stored && Date.now() - stored.t < ttl) {
    return { source, series, points: stored.points, label: stored.label, unit: stored.unit };
  }
  try {
    const fresh = await fetcher();
    try {
      append(seriesPath(), { v: 1, kind: "series", source, series, t: Date.now(), label: fresh.label, unit: fresh.unit, points: fresh.points } satisfies SeriesRecord);
      maybeCompactSeries(); // bound the file; collapses superseded snapshots
    } catch {
      /* persistence is best-effort */
    }
    return stored ? { ...fresh, points: mergePoints(stored.points, fresh.points) } : fresh;
  } catch (e) {
    if (stored) {
      opts.log?.("warn", `series ${key} fetch failed — using stored snapshot (${Math.round((Date.now() - stored.t) / 3_600_000)}h old)`);
      return { source, series, points: stored.points, label: stored.label, unit: stored.unit };
    }
    throw e;
  }
}

// ---------------------------------------------------------------- reftables

export function appendRefTable(rec: RefTableRecord): void {
  append(reftablePath(), rec);
}

/** Newest non-expired record for a key, or null (stale rows are dropped). */
export function loadRefTable(key: string): RefTableRecord | null {
  let best: RefTableRecord | null = null;
  for (const rec of readLines(reftablePath())) {
    if (rec.kind !== "reftable" || rec.key !== key) continue;
    const r = rec as unknown as RefTableRecord;
    if (!best || (r.t ?? 0) > (best.t ?? 0)) best = r;
  }
  if (!best) return null;
  const ageDays = (Date.now() - (best.t ?? 0)) / 86_400_000;
  return ageDays <= (best.ttlDays ?? 7) ? best : null;
}

/**
 * Read-or-build a long-TTL lookup table: return the fresh stored table, else
 * build + append + return. Stale-on-failure like cachedSeries.
 */
export async function cachedRefTable<T>(key: string, ttlDays: number, build: () => Promise<T>): Promise<T> {
  const hit = loadRefTable(key);
  if (hit) return hit.data as T;
  try {
    const data = await build();
    try {
      append(reftablePath(), { v: 1, kind: "reftable", key, t: Date.now(), ttlDays, data } satisfies RefTableRecord);
    } catch {
      /* best-effort */
    }
    return data;
  } catch (e) {
    // Expired but present beats nothing when the rebuild fails — serve the
    // NEWEST expired snapshot (consistent with loadRefTable / loadSeries).
    let best: RefTableRecord | null = null;
    for (const rec of readLines(reftablePath())) {
      if (rec.kind !== "reftable" || rec.key !== key) continue;
      const r = rec as unknown as RefTableRecord;
      if (!best || (r.t ?? 0) > (best.t ?? 0)) best = r;
    }
    if (best) return best.data as T;
    throw e;
  }
}

// ---------------------------------------------------------------- reference classes

export function appendRefClass(rec: RefClassRecord): void {
  append(refclassPath(), rec);
}

export function loadRefClasses(): RefClassRecord[] {
  const out: RefClassRecord[] = [];
  for (const rec of readLines(refclassPath())) {
    if (rec.kind === "refclass" && typeof rec.refClass === "string" && typeof rec.domain === "string") {
      out.push(rec as unknown as RefClassRecord);
    }
  }
  return out;
}

/**
 * Counted reference-class summary for a (domain, refClass): the base rate over
 * resolved binary rows and the realized values over numeric rows. The caller
 * MUST pass a filter that excludes the current question's own ledger id when it
 * uses the result as a driver of that question (non-circularity).
 */
export function queryRefClass(
  domain: string,
  refClass: string,
  filter?: (r: RefClassRecord) => boolean,
): { n: number; baseRate?: number; values: number[]; rows: RefClassRecord[] } {
  let rows = loadRefClasses().filter((r) => r.domain === domain && r.refClass === refClass);
  if (filter) rows = rows.filter(filter);
  const values: number[] = [];
  let yes = 0;
  let binaryN = 0;
  for (const r of rows) {
    if (r.qkind === "binary") {
      if (r.outcome === 1 || r.outcome === 0) {
        binaryN++;
        if (r.outcome === 1) yes++;
      }
    } else if (typeof r.outcome === "number") {
      values.push(r.outcome);
    }
  }
  return { n: rows.length, baseRate: binaryN ? yes / binaryN : undefined, values, rows };
}
