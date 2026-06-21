"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { fmtBytes } from "@/lib/format";
import { EmptyState, Spinner } from "./atoms";

type Artifact = { name: string; size: number };

/**
 * The run's deliverables, grouped by folder: root deliverables first
 * (final-report pinned to the front), then crawl/, data/, … alphabetically.
 * `refreshKey` (the live artifact count) triggers a refetch as agents save.
 */
export function ArtifactsPanel({ id, refreshKey }: { id: string; refreshKey: number }) {
  const [artifacts, setArtifacts] = useState<Artifact[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .artifacts(id)
      .then((a) => {
        if (alive) {
          setArtifacts(a.artifacts);
          setError(null);
        }
      })
      .catch((e) => {
        if (alive) setError(e?.message || "request failed");
      });
    return () => {
      alive = false;
    };
  }, [id, refreshKey]);

  if (error) {
    return (
      <div className="panel">
        <EmptyState glyph="⚠" title="Couldn't load artifacts" sub={`The hub didn't answer (${error}).`} />
      </div>
    );
  }
  if (artifacts === null) {
    return (
      <div className="panel p-10 flex items-center justify-center gap-3 text-ink-faint">
        <Spinner /> loading artifacts…
      </div>
    );
  }
  if (artifacts.length === 0) {
    return (
      <div className="panel">
        <EmptyState
          glyph="↧"
          title="No artifacts yet"
          sub="Files agents save with save_artifact land here — reports, data, charts, documents."
        />
      </div>
    );
  }

  return (
    <div className="panel p-5 space-y-5">
      {groupArtifacts(artifacts).map((g) => (
        <div key={g.dir}>
          <div className="label mb-2">{g.dir ? `${g.dir}/` : "Deliverables"} · {g.files.length}</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {g.files.map((a) => (
              <a
                key={a.name}
                href={api.artifactUrl(id, a.name)}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-2.5 px-3 py-2.5 tile tile-hover"
              >
                <ExtBadge name={a.name} />
                <span className="mono text-xs truncate flex-1 text-ink">
                  {a.name.slice(g.dir ? g.dir.length + 1 : 0)}
                </span>
                <span className="text-2xs shrink-0 mono text-ink-faint">{fmtBytes(a.size)}</span>
                <span className="text-ink-dim">↗</span>
              </a>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function groupArtifacts(artifacts: Artifact[]): { dir: string; files: Artifact[] }[] {
  const byDir = new Map<string, Artifact[]>();
  for (const a of artifacts) {
    const slash = a.name.indexOf("/");
    const dir = slash > 0 ? a.name.slice(0, slash) : "";
    (byDir.get(dir) ?? byDir.set(dir, []).get(dir)!).push(a);
  }
  const rank = (n: string) => (n.startsWith("final-report.") ? 0 : 1);
  for (const files of byDir.values()) {
    files.sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
  }
  return [...byDir.entries()]
    .sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)))
    .map(([dir, files]) => ({ dir, files }));
}

export function ExtBadge({ name }: { name: string }) {
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase().slice(0, 4) : "file";
  return (
    <span
      className="mono shrink-0 uppercase grid place-items-center text-ink-dim"
      style={{
        fontSize: 10,
        letterSpacing: "0.08em",
        width: 34,
        height: 20,
        borderRadius: 5,
        background: "rgb(var(--hi) / 0.05)",
        border: "1px solid var(--color-border)",
      }}
    >
      {ext}
    </span>
  );
}
