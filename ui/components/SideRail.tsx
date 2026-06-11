"use client";

import { useEffect, useRef, useState } from "react";
import { fmtAgo, fmtClock } from "@/lib/format";
import { PixelAvatar, personaName } from "@/lib/persona";
import type { ActivityItem, BlackboardNote, ConductorSay, OperatorNote } from "@/lib/types";
import { EmptyState, Md, ToolIcon } from "./atoms";

type Tab = "activity" | "conductor" | "blackboard";

export function SideRail({
  activity,
  conductorLog,
  notes,
  operatorNotes,
  now,
}: {
  activity: ActivityItem[];
  conductorLog: ConductorSay[];
  notes: BlackboardNote[];
  operatorNotes: OperatorNote[];
  now: number;
}) {
  const [tab, setTab] = useState<Tab>("activity");
  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: "activity", label: "Activity" },
    { id: "conductor", label: "Conductor", count: conductorLog.length + operatorNotes.length },
    { id: "blackboard", label: "Blackboard", count: notes.length },
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
        {tab === "activity" && <ActivityFeed activity={activity} now={now} />}
        {tab === "conductor" && <ConductorFeed log={conductorLog} operatorNotes={operatorNotes} now={now} />}
        {tab === "blackboard" && <Blackboard notes={notes} now={now} />}
      </div>
    </div>
  );
}

function ActivityFeed({ activity, now }: { activity: ActivityItem[]; now: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [stick, setStick] = useState(true);

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
        {activity.map((item) => (
          <ActivityRow key={item.id} item={item} />
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
 * like a feed, not a log dump.
 */
function ActivityRow({ item }: { item: ActivityItem }) {
  const isResult = item.kind === "result";
  let head: React.ReactNode = null;
  let text = item.text ?? "";
  let tone = "text-ink-dim";

  if (item.kind === "tool") {
    head = (
      <span className="mono font-medium text-ink mr-1.5 whitespace-nowrap">
        <ToolIcon name={item.name} /> {item.name}
      </span>
    );
    tone = "text-ink-faint";
  } else if (isResult) {
    head = <span className={`mr-1.5 ${item.ok ? "text-ink-faint" : "text-ink"}`}>{item.ok ? "↳" : "↳ ✗"}</span>;
    tone = item.ok ? "text-ink-faint" : "text-ink";
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
      className="flex items-start gap-2 py-1.5 text-xs leading-snug"
      style={{ animation: "var(--animate-rise)" }}
      title={`${new Date(item.t).toLocaleString()}${item.taskId ? ` · ${item.taskId} ${personaName(item.taskId)}` : ""}`}
    >
      <span className="flex items-center gap-1.5 shrink-0 w-[56px]" style={{ marginTop: 1 }}>
        {item.taskId ? (
          <>
            <PixelAvatar seed={item.taskId} size={18} />
            <span className="mono text-2xs text-ink-faint">{item.taskId}</span>
          </>
        ) : (
          <span className="mono text-2xs text-ink-faint">◉</span>
        )}
      </span>
      <span className={`min-w-0 flex-1 ${isResult ? "pl-2 border-l border-border-soft" : ""}`}>
        <span className="line-clamp-2" style={{ overflowWrap: "anywhere" }}>
          {head}
          <span className={tone}>{text}</span>
        </span>
      </span>
      <span className="mono text-2xs shrink-0 text-ink-faint" style={{ marginTop: 1 }}>
        {fmtClock(item.t)}
      </span>
    </div>
  );
}

function ConductorFeed({ log, operatorNotes, now }: { log: ConductorSay[]; operatorNotes: OperatorNote[]; now: number }) {
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
              <div className="label mb-1 text-ink" style={{ letterSpacing: "0.12em" }}>
                you · {fmtAgo(m.t, now)}
              </div>
              <div className="text-ink-dim">{m.text}</div>
            </div>
          ) : (
            <div className="text-xs leading-relaxed">
              <div className="label mb-0.5" style={{ letterSpacing: "0.12em" }}>
                ◉ conductor · {fmtClock(m.t)}
              </div>
              <Md compact dim>{m.text}</Md>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/** Decisions are the load-bearing notes — they get the solid treatment. */
function NoteKind({ kind }: { kind: string }) {
  const glyph: Record<string, string> = { decision: "◆", "open-question": "?", handoff: "⇢", claim: "⚑" };
  return (
    <span
      className={`mono shrink-0 uppercase ${kind === "decision" ? "chip-solid" : ""}`}
      style={{
        fontSize: 9,
        letterSpacing: "0.1em",
        padding: "1px 6px",
        borderRadius: 4,
        border: kind === "decision" ? undefined : "1px solid var(--color-border)",
      }}
    >
      {glyph[kind] ?? "·"} {kind}
    </span>
  );
}

function Blackboard({ notes, now }: { notes: BlackboardNote[]; now: number }) {
  if (notes.length === 0) {
    return <EmptyState glyph="✦" title="Blackboard is empty" sub="Durable facts agents post for the rest of the swarm show up here." />;
  }
  return (
    <div className="h-full overflow-y-auto px-3.5 py-3 space-y-2">
      {[...notes].reverse().map((n, i) => (
        <div key={i} className="tile p-3 text-xs" style={{ animation: "var(--animate-rise)" }}>
          <div className="flex items-baseline gap-2 mb-1.5 text-2xs text-ink-faint">
            {n.kind && n.kind !== "finding" && <NoteKind kind={n.kind} />}
            {n.key && <span className="mono font-semibold text-ink truncate">{n.key.replace(/[_-]+/g, " ")}</span>}
            {n.taskId && <span className="mono shrink-0">{n.taskId}</span>}
            <span className="ml-auto shrink-0">{fmtAgo(n.t, now)}</span>
          </div>
          <Md compact dim>{n.text}</Md>
        </div>
      ))}
    </div>
  );
}
