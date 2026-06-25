"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { CodePanel } from "@/components/CodePanel";
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
  const scrollRef = useRef<HTMLDivElement>(null);
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
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
            turn={turn}
            isActive={turn.turnId === activeTurnId}
            live={live && turn.turnId === session.live}
            liveCode={turn.turnId === activeTurnId ? liveRun : null}
            now={now}
            index={i}
          />
        ))}
      </div>

      {/* Composer */}
      <div className="px-5 sm:px-6 py-3 border-t border-border-soft">
        {sendErr && <div className="text-2xs text-ink mb-2">{sendErr}</div>}
        <div className="flex items-end gap-2">
          <textarea
            className="input resize-none leading-relaxed text-sm flex-1"
            rows={2}
            placeholder={live ? "A turn is building — wait for it to finish…" : "Describe the next change — it builds on everything so far…"}
            value={message}
            disabled={live}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") send();
            }}
          />
          <button className="btn btn-primary shrink-0" disabled={live || sending || !message.trim()} onClick={send}>
            {sending ? <Spinner size={12} /> : live ? "Building…" : "Send"}
          </button>
        </div>
        <div className="text-2xs text-ink-faint mt-1.5">
          ⌘↵ to send · every message iterates on the same codebase · builds exhaustive by default
        </div>
      </div>
    </div>
  );
}

function TurnBlock({
  turn,
  isActive,
  live,
  liveCode,
  now,
  index,
}: {
  turn: SessionTurn;
  isActive: boolean;
  live: boolean;
  liveCode: ReturnType<typeof useRun>["data"] | null;
  now: number;
  index: number;
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

          {/* The active turn renders the full live build console. */}
          {isActive && liveCode?.code ? (
            <CodePanel code={liveCode.code} tasks={liveCode.tasks} status={liveCode.status} now={now} />
          ) : isActive && !terminal ? (
            <div className="panel p-4 flex items-center gap-3 text-sm text-ink-dim">
              <Spinner size={14} /> starting build…
            </div>
          ) : (
            <CompactResult turnId={turn.turnId} summary={run?.finalSummary} status={status} reason={run?.statusReason} />
          )}
        </div>
      </div>
    </div>
  );
}

function CompactResult({
  turnId,
  summary,
  status,
  reason,
}: {
  turnId: string;
  summary?: string;
  status: RunStatus;
  reason?: string;
}) {
  const failed = status === "failed";
  return (
    <div className="panel p-4">
      {summary ? (
        <p className="text-sm text-ink-dim leading-relaxed line-clamp-4 whitespace-pre-wrap">{summary}</p>
      ) : (
        <p className="text-sm text-ink-faint">{failed ? reason || "This turn failed." : "Build finished."}</p>
      )}
      <div className="mt-2.5">
        <Link href={`/run?id=${turnId}`} className="btn btn-sm">Open full build →</Link>
      </div>
    </div>
  );
}
