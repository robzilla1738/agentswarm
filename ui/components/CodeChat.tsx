"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { CodePanel } from "@/components/CodePanel";
import { DiffView } from "@/components/DiffView";
import { Spinner, StatusBadge, StatusDot } from "@/components/atoms";
import { api } from "@/lib/api";
import { fmtMoney, fmtTokens, fmtAgo } from "@/lib/format";
import { useNow, useRun, useSession } from "@/lib/hooks";
import type { RunStatus, SessionTurn } from "@/lib/types";

const TERMINAL: RunStatus[] = ["done", "failed", "cancelled"];

/**
 * The code-chat thread for one session. Each user message is a TURN — an
 * ordinary code run pinned to the session's persistent workspace. The transcript
 * shows every message; the ACTIVE (live or most-recent) turn renders the full
 * live build console (CodePanel), while earlier turns collapse to a compact
 * result card that links to the full run view. The composer is disabled while a
 * turn is building (the backend enforces one live turn per session too).
 */
export function CodeChat({ id }: { id: string }) {
  const router = useRouter();
  const { session, error, refresh } = useSession(id);
  const now = useNow(1000);

  const turns = session?.turns ?? [];
  const activeTurnId = session?.live || turns[turns.length - 1]?.turnId || null;
  // Stream the active turn's fine-grained build events for the live console.
  const { data: liveRun } = useRun(activeTurnId);

  const live = Boolean(session?.live);
  const liveStatus = liveRun?.status;
  const awaitingApproval = live && liveStatus === "awaiting-approval";
  const scrollRef = useRef<HTMLDivElement>(null);
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sendErr, setSendErr] = useState<string | null>(null);

  // Keep the newest turn in view as the thread grows / builds.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [turns.length, liveRun?.tasks.length, live]);

  const send = async () => {
    const text = message.trim();
    if (!text || sending || live) return;
    setSending(true);
    setSendErr(null);
    try {
      await api.sessionMessage(id, text);
      setMessage("");
      refresh();
    } catch (e: any) {
      setSendErr(e?.message || "could not send");
    } finally {
      setSending(false);
    }
  };

  // Steer the live build (or tweak the plan during approval) without ending it.
  const sendNote = async () => {
    const text = message.trim();
    if (!text || sending || !live) return;
    setSending(true);
    setSendErr(null);
    try {
      await api.sessionNote(id, text);
      setMessage("");
      refresh();
    } catch (e: any) {
      setSendErr(e?.message || "could not steer");
    } finally {
      setSending(false);
    }
  };

  const approve = async () => {
    if (busy) return;
    setBusy(true);
    setSendErr(null);
    try {
      // A non-empty composer becomes a plan tweak applied before the build starts.
      const text = message.trim();
      if (text) {
        await api.sessionNote(id, text);
        setMessage("");
      }
      await api.sessionApprove(id);
      refresh();
    } catch (e: any) {
      setSendErr(e?.message || "could not approve");
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    if (busy) return;
    if (!confirm("Stop this turn? It finalizes from whatever is already built.")) return;
    setBusy(true);
    setSendErr(null);
    try {
      await api.sessionCancel(id);
      refresh();
    } catch (e: any) {
      setSendErr(e?.message || "could not stop");
    } finally {
      setBusy(false);
    }
  };

  const del = async () => {
    if (!confirm("Delete this code chat? The conversation is removed; a managed project's files are deleted too.")) return;
    try {
      await api.deleteSession(id);
      router.push("/code");
    } catch (e: any) {
      setSendErr(e?.message || "could not delete");
    }
  };

  if (error && !session) {
    return (
      <div className="max-w-3xl mx-auto p-16 text-center text-ink-dim">
        Can&apos;t load this chat: {error}. <Link href="/code" className="underline">Back to chats</Link>
      </div>
    );
  }
  if (!session) {
    return (
      <div className="max-w-3xl mx-auto p-16 text-center text-ink-faint flex items-center justify-center gap-3">
        <Spinner /> opening chat…
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto flex flex-col h-[calc(100vh-3.5rem)]">
      {/* Chat header */}
      <div className="flex items-center justify-between gap-3 px-5 sm:px-6 py-3 border-b border-border-soft">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Link href="/code" className="text-ink-faint hover:text-ink text-sm shrink-0" title="All code chats">←</Link>
            <h1 className="text-sm font-semibold text-ink truncate">{session.meta.title}</h1>
            {live && <StatusDot status="running" size={7} pulse />}
          </div>
          <div className="mono text-2xs text-ink-faint truncate mt-0.5" title={session.meta.workspace}>
            {session.meta.workspaceKind === "managed" ? "managed project" : "your folder"} · {session.meta.workspace}
          </div>
        </div>
        <button className="btn btn-ghost btn-sm shrink-0 text-ink-faint" onClick={del} title="Delete this chat">Delete</button>
      </div>

      {/* Transcript */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 sm:px-6 py-5 space-y-5">
        {turns.length === 0 && (
          <div className="text-center text-ink-faint text-sm py-10">
            Send the first message to start building.
          </div>
        )}
        {turns.map((turn, i) => (
          <TurnBlock
            key={turn.turnId}
            sessionId={id}
            turn={turn}
            isActive={turn.turnId === activeTurnId}
            live={live && turn.turnId === session.live}
            liveCode={turn.turnId === activeTurnId ? liveRun : null}
            now={now}
            index={i}
            anyLive={live}
            committed={session.meta.workspaceKind === "managed"}
            onChanged={refresh}
          />
        ))}
      </div>

      {/* Composer — dual mode: idle → Send a new turn; awaiting-approval →
          Approve & build (or tweak); building → Send note (steer) / Stop. */}
      <div className="px-5 sm:px-6 py-3 border-t border-border-soft">
        {sendErr && <div className="text-2xs text-ink mb-2">{sendErr}</div>}
        <div className="flex items-end gap-2">
          <textarea
            className="input resize-none leading-relaxed text-sm flex-1"
            rows={2}
            placeholder={
              awaitingApproval
                ? "Approve below to build — or type an adjustment to the plan first…"
                : live
                ? "Steer the live build — type a note it picks up on the next turn…"
                : "Describe the next change — it builds on everything so far…"
            }
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                if (awaitingApproval) approve();
                else if (live) sendNote();
                else send();
              }
            }}
          />
          <div className="flex flex-col gap-1.5 shrink-0">
            {awaitingApproval ? (
              <>
                <button className="btn btn-primary" disabled={busy} onClick={approve}>
                  {busy ? <Spinner size={12} /> : "Approve & build"}
                </button>
                <button className="btn btn-ghost btn-sm text-ink-faint" disabled={busy} onClick={stop}>Stop</button>
              </>
            ) : live ? (
              <>
                <button className="btn btn-primary" disabled={sending || !message.trim()} onClick={sendNote}>
                  {sending ? <Spinner size={12} /> : "Send note"}
                </button>
                <button className="btn btn-ghost btn-sm text-ink-faint" disabled={busy} onClick={stop}>Stop</button>
              </>
            ) : (
              <button className="btn btn-primary" disabled={sending || !message.trim()} onClick={send}>
                {sending ? <Spinner size={12} /> : "Send"}
              </button>
            )}
          </div>
        </div>
        <div className="text-2xs text-ink-faint mt-1.5">
          {awaitingApproval
            ? "⌘↵ to approve · review the plan above · a note refines it before building"
            : live
            ? "⌘↵ to send a note · the build picks it up at its next checkpoint · Stop finalizes from what's built"
            : "⌘↵ to send · every message iterates on the same codebase · researches + builds exhaustive by default"}
        </div>
      </div>
    </div>
  );
}

function TurnBlock({
  sessionId,
  turn,
  isActive,
  live,
  liveCode,
  now,
  index,
  anyLive,
  committed,
  onChanged,
}: {
  sessionId: string;
  turn: SessionTurn;
  isActive: boolean;
  live: boolean;
  liveCode: ReturnType<typeof useRun>["data"] | null;
  now: number;
  index: number;
  anyLive: boolean;
  committed: boolean;
  onChanged: () => void;
}) {
  const run = turn.run;
  const status: RunStatus = (live ? "running" : run?.status) ?? "planning";
  const terminal = TERMINAL.includes(status);
  const spent = run ? run.usage.promptTokens + run.usage.completionTokens : 0;

  return (
    <div className="space-y-3" style={{ animation: "var(--animate-rise)" }}>
      {/* User message */}
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-ink/[0.06] border border-border-soft px-3.5 py-2 text-sm text-ink whitespace-pre-wrap">
          {turn.message}
        </div>
      </div>

      {/* Assistant turn */}
      <div className="flex items-start gap-2.5">
        <div className="glyph shrink-0 w-7 h-7 text-2xs mt-0.5">⌬</div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1.5 flex-wrap">
            <span className="text-2xs text-ink-faint">Turn {index + 1}</span>
            <StatusBadge status={status} />
            {run && (
              <span className="mono text-2xs text-ink-faint">
                {run.tasks.done}/{run.tasks.total} tasks · {fmtTokens(spent)} tok · {fmtMoney(run.cost)}
              </span>
            )}
            <span className="mono text-2xs text-ink-faint">{fmtAgo(turn.at, now)}</span>
          </div>

          {/* The active turn renders narration bubbles, the approval card (while
              awaiting), and the full live build console. */}
          {isActive && liveCode?.code ? (
            <div className="space-y-3">
              <NarrationBubbles items={liveCode.code.narration} />
              {status === "awaiting-approval" && liveCode.code.proposed && (
                <ApprovalCard proposed={liveCode.code.proposed} spec={liveCode.code.productSpec} />
              )}
              <CodePanel code={liveCode.code} tasks={liveCode.tasks} status={liveCode.status} now={now} />
            </div>
          ) : isActive && !terminal ? (
            <div className="panel p-4 flex items-center gap-3 text-sm text-ink-dim">
              <Spinner size={14} /> starting build…
            </div>
          ) : (
            <CompactResult
              sessionId={sessionId}
              turnId={turn.turnId}
              summary={run?.finalSummary}
              status={status}
              reason={run?.statusReason}
              anyLive={anyLive}
              committed={committed}
              onChanged={onChanged}
            />
          )}
        </div>
      </div>
    </div>
  );
}

type CodeView = NonNullable<ReturnType<typeof useRun>["data"]>["code"];

/** Conversational narration — the assistant's plan / progress / result messages, derived from build events. */
function NarrationBubbles({ items }: { items: NonNullable<CodeView>["narration"] }) {
  if (!items?.length) return null;
  return (
    <div className="space-y-2">
      {items.map((n, i) => (
        <div
          key={i}
          className={
            n.kind === "progress"
              ? "text-2xs text-ink-faint pl-1 flex items-center gap-1.5"
              : "rounded-2xl rounded-bl-sm bg-ink/[0.04] border border-border-soft px-3.5 py-2 text-sm text-ink-dim whitespace-pre-wrap"
          }
        >
          {n.kind === "progress" ? <span className="text-ink-faint shrink-0">›</span> : null}
          {n.text}
        </div>
      ))}
    </div>
  );
}

/** The "here's my plan — approve?" card shown while the turn is awaiting approval. */
function ApprovalCard({
  proposed,
  spec,
}: {
  proposed: NonNullable<NonNullable<CodeView>["proposed"]>;
  spec: NonNullable<CodeView>["productSpec"];
}) {
  const waveCount = proposed.waves?.length ?? 0;
  return (
    <div className="panel p-4" style={{ borderColor: "color-mix(in oklab, var(--status-warm) 45%, var(--color-border))" }}>
      <div className="flex items-center gap-2 mb-2">
        <span className="text-sm font-semibold text-ink">Here&apos;s the plan</span>
        <span className="chip">awaiting approval</span>
      </div>
      {spec && (
        <p className="text-xs text-ink-dim mb-2.5">
          Researched <span className="font-medium text-ink">{spec.productName}</span>
          {spec.grounded ? "" : " (inferred — thin sources)"}: {spec.features.length} features, {spec.screens.length} screens.
        </p>
      )}
      {proposed.stack && (
        <div className="text-2xs text-ink-faint mb-2">
          <span className="text-ink-dim font-medium">Stack:</span> {proposed.stack}
        </div>
      )}
      {proposed.criteria.length > 0 && (
        <div className="mb-2">
          <div className="text-2xs text-ink-faint mb-1">Scope — {proposed.criteria.length} acceptance criteria</div>
          <ul className="text-xs text-ink-dim space-y-0.5 max-h-40 overflow-y-auto">
            {proposed.criteria.slice(0, 14).map((c) => (
              <li key={c.id} className="flex gap-1.5"><span className="text-ink-faint mono shrink-0">{c.id}</span> {c.text}</li>
            ))}
            {proposed.criteria.length > 14 && <li className="text-ink-faint">+{proposed.criteria.length - 14} more…</li>}
          </ul>
        </div>
      )}
      {proposed.modules.length > 0 && (
        <div className="text-2xs text-ink-faint">
          Plan — {proposed.modules.length} module{proposed.modules.length === 1 ? "" : "s"}
          {waveCount ? ` across ${waveCount} conflict-free wave${waveCount === 1 ? "" : "s"}` : ""}.
        </div>
      )}
      <div className="text-2xs text-ink-faint mt-2.5 pt-2 border-t border-border-soft">
        Approve &amp; build below — or send an adjustment to refine it first.
      </div>
    </div>
  );
}

function CompactResult({
  sessionId,
  turnId,
  summary,
  status,
  reason,
  anyLive,
  committed,
  onChanged,
}: {
  sessionId: string;
  turnId: string;
  summary?: string;
  status: RunStatus;
  reason?: string;
  anyLive: boolean;
  committed: boolean;
  onChanged: () => void;
}) {
  const failed = status === "failed";
  const [diff, setDiff] = useState<string | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  const [diffErr, setDiffErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const toggleDiff = async () => {
    if (showDiff) {
      setShowDiff(false);
      return;
    }
    setShowDiff(true);
    if (diff === null) {
      try {
        setDiff(await api.turnDiff(sessionId, turnId));
        setDiffErr(null);
      } catch (e: any) {
        setDiffErr(e?.message || "no diff");
      }
    }
  };

  const revert = async () => {
    if (busy) return;
    if (!confirm("Revert this turn? It adds a commit that undoes this turn's changes on the session branch.")) return;
    setBusy(true);
    try {
      await api.revertTurn(sessionId, turnId);
      onChanged();
    } catch (e: any) {
      setDiffErr(e?.message || "could not revert");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel p-4">
      {summary ? (
        <p className="text-sm text-ink-dim leading-relaxed line-clamp-4 whitespace-pre-wrap">{summary}</p>
      ) : (
        <p className="text-sm text-ink-faint">{failed ? reason || "This turn failed." : "Build finished."}</p>
      )}
      <div className="mt-2.5 flex items-center gap-2 flex-wrap">
        <Link href={`/run?id=${turnId}`} className="btn btn-sm">Open full build →</Link>
        {/* Diff/revert only exist when the engine committed the turn (managed
            sessions commit-on-green; existing folders with auto-commit off don't). */}
        {committed && !failed && (
          <>
            <button className="btn btn-sm btn-ghost" onClick={toggleDiff}>{showDiff ? "Hide diff" : "View diff"}</button>
            <button className="btn btn-sm btn-ghost text-ink-faint" onClick={revert} disabled={busy || anyLive} title={anyLive ? "Finish the live turn first" : "Undo this turn's changes"}>
              {busy ? <Spinner size={11} /> : "Revert turn"}
            </button>
          </>
        )}
      </div>
      {diffErr && <div className="text-2xs text-ink-faint mt-1.5">{diffErr}</div>}
      {showDiff && diff !== null && <DiffView diff={diff} />}
    </div>
  );
}
