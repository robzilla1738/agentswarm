"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { ClientState, applyEvent, emptyState } from "./reducer";
import type {
  ActivityItem,
  AgentView,
  AggregateForecast,
  BlackboardNote,
  ConductorSay,
  ForecastPanelist,
  ForecastQuestion,
  OperatorNote,
  RunMeta,
  RunStatus,
  RunSummary,
  Task,
  Usage,
} from "./types";

export interface LiveRun {
  meta: RunMeta | null;
  status: RunStatus;
  statusReason: string;
  tasks: Task[];
  agents: AgentView[];
  activeAgents: AgentView[];
  notes: BlackboardNote[];
  conductorLog: ConductorSay[];
  operatorNotes: OperatorNote[];
  activity: ActivityItem[];
  usage: Usage;
  cost: number;
  budgetSeries: { t: number; tokens: number; cost: number }[];
  /** Distinct web sources touched so far — updates live as agents search/fetch. */
  sourceCount: number;
  planUpdatedAt: number;
  /** Forecast runs: the sharpened question and (once computed) the panel aggregate. */
  question: ForecastQuestion | null;
  aggregate: AggregateForecast | null;
  forecastPanel: ForecastPanelist[];
  finalSummary?: string;
  finalReportPath?: string;
  lastSeq: number;
  updatedAt: number;
}

function project(s: ClientState): LiveRun {
  const tasks = s.taskOrder.map((id) => s.tasks.get(id)!).filter(Boolean);
  const agents = [...s.agents.values()];
  return {
    meta: s.meta,
    status: s.status,
    statusReason: s.statusReason,
    tasks,
    agents,
    activeAgents: agents.filter((a) => a.status === "running"),
    // The reducer mutates its arrays in place; hand out fresh references so
    // downstream useMemo/useEffect deps actually invalidate (a frozen
    // identity here freezes every memoized view built on it).
    notes: s.notes.slice(),
    conductorLog: s.conductorLog.slice(),
    operatorNotes: s.operatorNotes.slice(),
    activity: s.activity.slice(),
    usage: s.usage,
    cost: s.cost,
    budgetSeries: s.budgetSeries.slice(),
    sourceCount: s.sourceUrls.size,
    planUpdatedAt: s.planUpdatedAt,
    question: s.question,
    aggregate: s.aggregate,
    forecastPanel: s.forecastPanel.slice(),
    finalSummary: s.finalSummary,
    finalReportPath: s.finalReportPath,
    lastSeq: s.lastSeq,
    updatedAt: s.lastT,
  };
}

const TERMINAL: RunStatus[] = ["done", "failed", "cancelled"];

/**
 * Subscribe to a run via SSE (with a polling fallback) and reduce its events.
 * `engineLive` is the hub's view of whether the engine process still exists —
 * null until first reported. It lets the UI flag a run that died without a
 * terminal status (kill -9, reboot) instead of showing "running" forever.
 */
export function useRun(id: string | null): { data: LiveRun | null; connected: boolean; engineLive: boolean | null } {
  const stateRef = useRef<ClientState>(emptyState());
  const [data, setData] = useState<LiveRun | null>(null);
  const [connected, setConnected] = useState(false);
  const [engineLive, setEngineLive] = useState<boolean | null>(null);
  const dirtyRef = useRef(false);

  useEffect(() => {
    if (!id) return;
    stateRef.current = emptyState();
    setData(null);
    setEngineLive(null);
    let closed = false;
    let es: EventSource | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    const flush = () => {
      if (dirtyRef.current) {
        dirtyRef.current = false;
        setData(project(stateRef.current));
      }
    };
    const flushTimer = setInterval(flush, 120);

    const ingest = (ev: any) => {
      applyEvent(stateRef.current, ev);
      dirtyRef.current = true;
      if (TERMINAL.includes(stateRef.current.status)) {
        // settle: final flush shortly after
        setTimeout(flush, 160);
      }
    };

    const startPolling = () => {
      if (pollTimer) return;
      const poll = async () => {
        try {
          const since = stateRef.current.lastSeq;
          const { events, live } = await api.events(id, since);
          for (const ev of events) ingest(ev);
          setConnected(true);
          setEngineLive(live);
          if (!live && TERMINAL.includes(stateRef.current.status) && pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
          }
        } catch {
          setConnected(false);
        }
      };
      poll();
      pollTimer = setInterval(poll, 1200);
    };

    const startSse = () => {
      try {
        es = new EventSource(api.streamUrl(id));
      } catch {
        startPolling();
        return;
      }
      es.onopen = () => setConnected(true);
      es.onmessage = (e) => {
        try {
          ingest(JSON.parse(e.data));
        } catch {
          /* skip */
        }
      };
      es.addEventListener("live", (e: MessageEvent) => {
        try {
          setEngineLive(Boolean(JSON.parse(e.data).live));
        } catch {
          /* skip */
        }
      });
      es.onerror = () => {
        setConnected(false);
        // If the run is already terminal, no need to reconnect.
        if (TERMINAL.includes(stateRef.current.status)) {
          es?.close();
          return;
        }
        // Otherwise EventSource auto-reconnects; also kick polling as a safety net.
        if (!pollTimer && !closed) startPolling();
      };
    };

    if (typeof EventSource !== "undefined") startSse();
    else startPolling();

    return () => {
      closed = true;
      clearInterval(flushTimer);
      if (pollTimer) clearInterval(pollTimer);
      es?.close();
    };
  }, [id]);

  return { data, connected, engineLive };
}

/** Poll the run list for the dashboard. */
export function useRuns(intervalMs = 2500): { runs: RunSummary[]; loading: boolean; error: string | null; refresh: () => void } {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const { runs } = await api.listRuns();
        if (alive) {
          setRuns(runs);
          setError(null);
        }
      } catch (e: any) {
        if (alive) setError(e?.message || "hub unreachable");
      } finally {
        if (alive) setLoading(false);
      }
    };
    load();
    const t = setInterval(load, intervalMs);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [intervalMs, nonce]);

  return { runs, loading, error, refresh: () => setNonce((n) => n + 1) };
}

/** A ticking clock for relative timestamps. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function useConfig() {
  const [config, setConfig] = useState<Awaited<ReturnType<typeof api.getConfig>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useMemo(
    () => async () => {
      try {
        setConfig(await api.getConfig());
        setError(null);
      } catch (e: any) {
        setError(e?.message || "could not load config");
      }
    },
    []
  );
  useEffect(() => {
    reload();
  }, [reload]);
  return { config, setConfig, error, reload };
}
