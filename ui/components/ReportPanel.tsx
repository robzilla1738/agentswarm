"use client";

import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api } from "@/lib/api";
import { CopyButton, EmptyState, Spinner } from "./atoms";

export function ReportPanel({ id, hasFinal, live }: { id: string; hasFinal: boolean; live?: boolean }) {
  const [report, setReport] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    // 404 = no report (yet) — an expected state, not an error.
    fetch(api.reportUrl(id))
      .then((r) => (r.ok ? r.text() : r.status === 404 ? null : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((rep) => {
        if (!alive) return;
        setReport(rep);
        setLoading(false);
      })
      .catch((e) => {
        if (!alive) return;
        setError(e?.message || "request failed");
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [id, hasFinal, retryNonce]);

  const download = () => {
    if (!report) return;
    const blob = new Blob([report], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${id}-report.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (loading) {
    return (
      <div className="panel p-10 flex items-center justify-center gap-3 text-ink-faint">
        <Spinner /> loading report…
      </div>
    );
  }

  if (error) {
    return (
      <div className="panel">
        <EmptyState
          glyph="⚠"
          title="Couldn't load the report"
          sub={`The hub didn't answer (${error}). Check that swarm serve is still running, then retry.`}
        />
        <div className="flex justify-center pb-8 -mt-2">
          <button className="btn btn-sm" onClick={() => setRetryNonce((n) => n + 1)}>Retry</button>
        </div>
      </div>
    );
  }

  return (
    <div className="panel overflow-hidden">
      {report ? (
        <>
          <div
            className="flex items-center justify-between gap-3 px-5 sm:px-7 py-3 border-b border-border-soft"
            style={{ background: "rgb(var(--hi) / 0.015)" }}
          >
            <span className="label">Final report</span>
            <div className="flex items-center gap-1.5">
              <CopyButton text={report} label="Copy markdown" />
              <button className="btn btn-sm" onClick={download}>Download .md</button>
              <a className="btn btn-sm" href={api.reportUrl(id)} target="_blank" rel="noreferrer">
                Raw ↗
              </a>
            </div>
          </div>
          <div className="p-5 sm:p-8">
            <div className="prose-report">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{report}</ReactMarkdown>
            </div>
          </div>
        </>
      ) : (
        <EmptyState
          glyph="▤"
          title={live ? "No report yet" : "No final report"}
          sub={
            live
              ? "The synthesizer composes the final report when the mission finishes — it will appear here automatically."
              : "This run ended without a synthesized report."
          }
        />
      )}
    </div>
  );
}
