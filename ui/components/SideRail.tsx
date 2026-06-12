"use client";

import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { type ActivityGroup, groupActivity } from "@/lib/feed";
import { fmtClockShort } from "@/lib/format";
import { PixelAvatar, personaName } from "@/lib/persona";
import type { ActivityItem, BlackboardNote, ConductorSay, OperatorNote } from "@/lib/types";
import { Clamp, EmptyState, Md, ToolIcon } from "./atoms";

type Tab = "activity" | "conductor" | "blackboard" | "plan";

export function SideRail({
  runId,
  activity,
  conductorLog,
  notes,
  operatorNotes,
  planUpdatedAt,
}: {
  runId: string;
  activity: ActivityItem[];
  conductorLog: ConductorSay[];
  notes: BlackboardNote[];
  operatorNotes: OperatorNote[];
  planUpdatedAt: number;
}) {
  const [tab, setTab] = useState<Tab>("activity");
  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: "activity", label: "Activity" },
    { id: "conductor", label: "Conductor", count: conductorLog.length + operatorNotes.length },
    { id: "blackboard", label: "Blackboard", count: notes.length },
    { id: "plan", label: "Plan" },
  ];

  return (
    <div className="panel flex flex-col h-[480px] lg:h-[calc(100vh-88px)] lg:sticky lg:top-[72px]">
      <div className="flex items-center gap-5 px-4 border-b border-border-soft shrink-0">
        {tabs.map((t) => (
          <button key={t.id} className="tab" data-active={tab === t.id} onClick={() => setTab(t.id)}>
            {t.label}
            {t.count ? <span className="mono text-2xs text-ink-faint">{t.count}</span> : null}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-hidden relative">
        {tab === "activity" && <ActivityFeed activity={activity} />}
        {tab === "conductor" && <ConductorFeed log={conductorLog} operatorNotes={operatorNotes} />}
        {tab === "blackboard" && <Blackboard notes={notes} />}
        {tab === "plan" && <PlanView runId={runId} planUpdatedAt={planUpdatedAt} />}
      </div>
    </div>
  );
}

/** The conductor's living mission-plan.md, refetched whenever it changes. */
function PlanView({ runId, planUpdatedAt }: { runId: string; planUpdatedAt: number }) {
  const [plan, setPlan] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .fetchPlan(runId)
      .then((text) => {
        if (alive) {
          setPlan(text);
          setLoaded(true);
        }
      })
      .catch(() => {
        if (alive) setLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, [runId, planUpdatedAt]);

  if (!loaded) return <EmptyState glyph="◈" title="Loading plan…" sub="" />;
  if (!plan) {
    return (
      <EmptyState
        glyph="◈"
        title="No plan yet"
        sub="On longer missions the conductor maintains a living plan (mission-plan.md) — it appears here as it evolves."
      />
    );
  }
  return (
    <div className="h-full overflow-y-auto px-4 py-3 text-xs leading-relaxed">
      <Md compact dim>{plan}</Md>
    </div>
  );
}

function ActivityFeed({ activity }: { activity: ActivityItem[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [stick, setStick] = useState(true);
  const rows = useMemo(() => groupActivity(activity), [activity]);

  useEffect(() => {
    if (stick && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [activity, stick]);

  if (activity.length === 0) {
    return <EmptyState glyph="❯" title="No activity yet" sub="Every agent tool call streams here live." />;
  }

  return (
    <>
      <div
        ref={ref}
        onScroll={(e) => {
          const el = e.currentTarget;
          setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 60);
        }}
        className="h-full overflow-y-auto px-3 py-2 space-y-0.5"
      >
        {rows.map((item, i) => (
          <ActivityRow key={item.id} item={item} showTask={rows[i - 1]?.taskId !== item.taskId} />
        ))}
      </div>
      {!stick && (
        <button
          onClick={() => {
            setStick(true);
            if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
          }}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 btn btn-sm"
          style={{
            background: "color-mix(in oklab, var(--color-panel) 92%, transparent)",
            borderColor: "rgb(var(--hi) / 0.35)",
            boxShadow: "0 6px 20px -6px rgba(0,0,0,0.6)",
          }}
        >
          ↓ Latest
        </button>
      )}
    </>
  );
}

/**
 * One activity row. Layout: [avatar · task id] [content] [time]. Identifiers
 * stay mono; everything prose-like is sans and clamped — the rail should scan
 * like a feed, not a log dump. The avatar/task id renders only when the task
 * changes (`showTask`), so a burst from one agent reads as one block.
 */
function ActivityRow({ item, showTask = true }: { item: ActivityGroup; showTask?: boolean }) {
  const isResult = item.kind === "result";
  let head: React.ReactNode = null;
  let text = item.text ?? "";
  let tone = "text-ink-dim";

  if (item.kind === "tool") {
    head = (
      <span className="mono font-medium text-ink mr-1.5 whitespace-nowrap">
        <ToolIcon name={item.name} /> {item.name}
        {(item.count ?? 1) > 1 && <span className="text-ink-faint"> ×{item.count}</span>}
      </span>
    );
    tone = "text-ink-faint";
  } else if (isResult) {
    head = <span className={`mr-1.5 ${item.ok ? "text-ink-faint" : "text-ink-dim"}`}>{item.ok ? "↳" : "↳ ✗"}</span>;
    tone = item.ok ? "text-ink-faint" : "text-ink-dim";
  } else if (item.kind === "note") {
    head = <span className="text-ink-dim mr-1.5">✦</span>;
  } else if (item.kind === "spawn") {
    head = <span className="text-ink mr-1.5">⊕</span>;
    tone = "text-ink";
  } else if (item.kind === "report") {
    head = <span className="text-ink-dim mr-1.5">✓</span>;
  } else {
    head = <span className="mono font-medium text-ink mr-1.5">{item.name}</span>;
    text = item.text ?? "";
  }

  return (
    <div
      className="flex items-center gap-2 py-1 text-xs leading-snug"
      style={{ animation: "var(--animate-rise)" }}
      title={`${new Date(item.t).toLocaleString()}${item.taskId ? ` · ${item.taskId} ${personaName(item.taskId)}` : " · conductor"}${item.name ? `\n${item.name}` : ""}${text ? `\n${text}` : ""}${item.result ? `\n↳ ${item.result}` : ""}`}
    >
      <span className="flex items-center gap-1.5 shrink-0 w-[52px]">
        {showTask ? (
          item.taskId ? (
            <>
              <PixelAvatar seed={item.taskId} size={18} />
              <span className="mono text-2xs text-ink-faint">{item.taskId}</span>
            </>
          ) : (
            <span className="mono text-2xs text-ink-faint inline-flex items-center justify-center" style={{ width: 18 }}>◉</span>
          )
        ) : null}
      </span>
      <span className={`min-w-0 flex-1 truncate ${isResult ? "pl-2 border-l border-border-soft" : ""}`}>
        {head}
        <span className={tone}>{text}</span>
        {item.result && <span className="text-ink-faint"> ↳ {item.result}</span>}
      </span>
      <span className="mono text-2xs shrink-0 w-[36px] text-right text-ink-faint">
        {fmtClockShort(item.t)}
      </span>
    </div>
  );
}

function ConductorFeed({ log, operatorNotes }: { log: ConductorSay[]; operatorNotes: OperatorNote[] }) {
  const merged = [
    ...log.map((l) => ({ t: l.t, kind: "say" as const, text: l.text })),
    ...operatorNotes.map((o) => ({ t: o.t, kind: "op" as const, text: o.text })),
  ].sort((a, b) => a.t - b.t);

  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [merged.length]);

  if (merged.length === 0) {
    return <EmptyState glyph="◉" title="Conductor is quiet" sub="Its decisions and commentary appear here. Send it a note from the header to steer the run." />;
  }
  return (
    <div ref={ref} className="h-full overflow-y-auto px-3.5 py-3 space-y-3">
      {merged.map((m, i) => (
        <div key={i} style={{ animation: "var(--animate-rise)" }}>
          {m.kind === "op" ? (
            <div
              className="rounded-lg p-2.5 text-xs"
              style={{ background: "rgb(var(--hi) / 0.05)", border: "1px solid rgb(var(--hi) / 0.18)" }}
            >
              <div className="flex items-baseline justify-between mb-1">
                <span className="label text-ink">You</span>
                <span className="mono text-2xs text-ink-faint">{fmtClockShort(m.t)}</span>
              </div>
              <div className="text-ink-dim">{m.text}</div>
            </div>
          ) : (
            <div className="text-xs leading-relaxed">
              <div className="flex items-baseline justify-between mb-1">
                <span className="label">◉ Conductor</span>
                <span className="mono text-2xs text-ink-faint">{fmtClockShort(m.t)}</span>
              </div>
              <Md compact dim>{m.text}</Md>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/** "gpt56_gpt6-prediction_synthesis" → "Gpt56 gpt6 prediction synthesis" — note keys read as titles. */
function titleCase(key: string): string {
  const s = key.replace(/[_-]+/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** One chip styling for note kinds and their filter buttons, so they can't drift apart. */
function kindChipStyle(solid: boolean, padding = "1px 6px"): CSSProperties {
  return {
    fontSize: 9,
    letterSpacing: "0.1em",
    padding,
    borderRadius: 4,
    border: solid ? undefined : "1px solid var(--color-border)",
  };
}

/** Decisions and conflicts are the load-bearing notes — they get the solid treatment. */
function NoteKind({ kind }: { kind: string }) {
  const glyph: Record<string, string> = { decision: "◆", conflict: "≠", "open-question": "?", handoff: "⇢", claim: "⚑" };
  const solid = kind === "decision" || kind === "conflict";
  return (
    <span className={`mono shrink-0 uppercase ${solid ? "chip-solid" : ""}`} style={kindChipStyle(solid)}>
      {glyph[kind] ?? "·"} {kind}
    </span>
  );
}

function Blackboard({ notes }: { notes: BlackboardNote[] }) {
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<string | null>(null);

  const kinds = useMemo(() => {
    const counts = new Map<string, number>();
    for (const n of notes) {
      const k = n.kind || "finding";
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [notes]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return notes.filter((n) => {
      if (kindFilter && (n.kind || "finding") !== kindFilter) return false;
      if (!q) return true;
      return [n.text, n.key, n.taskId, n.url].some((f) => f && f.toLowerCase().includes(q));
    });
  }, [notes, query, kindFilter]);

  if (notes.length === 0) {
    return <EmptyState glyph="✦" title="Blackboard is empty" sub="Durable facts agents post for the rest of the swarm show up here." />;
  }
  return (
    <div className="h-full flex flex-col">
      <div className="px-3.5 pt-2.5 pb-2 space-y-2 shrink-0 border-b border-border-soft">
        <input
          className="input"
          style={{ padding: "4px 10px", fontSize: 12 }}
          placeholder={`Search ${notes.length} notes…`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {kinds.length > 1 && (
          <div className="flex items-center gap-1.5 flex-wrap">
            {kinds.map(([k, count]) => (
              <button
                key={k}
                onClick={() => setKindFilter(kindFilter === k ? null : k)}
                className={`mono uppercase ${kindFilter === k ? "chip-solid" : "text-ink-faint hover:text-ink-dim"}`}
                style={kindChipStyle(kindFilter === k, "2px 7px")}
              >
                {k} {count}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="flex-1 overflow-y-auto px-3.5 py-3 space-y-2">
        {filtered.length === 0 && <div className="text-xs text-ink-faint py-4 text-center">No notes match.</div>}
        {[...filtered].reverse().map((n, i) => (
          <div key={i} className="tile p-3 text-xs" style={{ animation: "var(--animate-rise)" }}>
            <div className="flex items-baseline gap-2 mb-1.5">
              {n.kind && n.kind !== "finding" && <NoteKind kind={n.kind} />}
              {n.key && <span className="font-medium text-ink truncate text-xs">{titleCase(n.key)}</span>}
              {n.taskId && <span className="mono text-2xs text-ink-faint shrink-0">{n.taskId}</span>}
              <span className="mono text-2xs text-ink-faint ml-auto shrink-0">{fmtClockShort(n.t)}</span>
            </div>
            <Clamp lines={5}>
              <Md compact dim>{n.text}</Md>
            </Clamp>
            {n.url && (
              <a
                href={n.url}
                target="_blank"
                rel="noreferrer"
                className="mono text-2xs text-ink-faint hover:text-ink transition-colors block truncate mt-1.5"
                title={n.url}
              >
                ↗ {n.url.replace(/^https?:\/\/(www\.)?/, "")}
              </a>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
