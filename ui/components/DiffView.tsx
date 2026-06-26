"use client";

type DiffLine = { kind: "add" | "del" | "ctx" | "meta"; text: string };
type DiffFile = { path: string; added: number; removed: number; lines: DiffLine[] };

/** Parse a unified git diff into per-file hunks (client-side, no dependency). */
function parseDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let cur: DiffFile | null = null;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git")) {
      const m = / b\/(.+)$/.exec(raw);
      cur = { path: m ? m[1] : raw.replace("diff --git ", ""), added: 0, removed: 0, lines: [] };
      files.push(cur);
      continue;
    }
    if (!cur) continue;
    if (
      raw.startsWith("+++") ||
      raw.startsWith("---") ||
      raw.startsWith("index ") ||
      raw.startsWith("new file") ||
      raw.startsWith("deleted file") ||
      raw.startsWith("similarity ") ||
      raw.startsWith("rename ") ||
      raw.startsWith("Binary files")
    ) {
      continue;
    }
    if (raw.startsWith("@@")) cur.lines.push({ kind: "meta", text: raw });
    else if (raw.startsWith("+")) {
      cur.added++;
      cur.lines.push({ kind: "add", text: raw.slice(1) });
    } else if (raw.startsWith("-")) {
      cur.removed++;
      cur.lines.push({ kind: "del", text: raw.slice(1) });
    } else cur.lines.push({ kind: "ctx", text: raw.startsWith(" ") ? raw.slice(1) : raw });
  }
  for (const f of files)
    if (f.lines.length > 400) f.lines = [...f.lines.slice(0, 400), { kind: "meta", text: `… (${f.lines.length - 400} more lines — open the full build to see all)` }];
  return files;
}

const LINE_BG: Record<DiffLine["kind"], string> = {
  add: "color-mix(in oklab, var(--status-warm) 14%, transparent)",
  del: "color-mix(in oklab, var(--color-ink) 8%, transparent)",
  ctx: "transparent",
  meta: "transparent",
};

export function DiffView({ diff }: { diff: string }) {
  const files = parseDiff(diff);
  if (!files.length) return <div className="text-2xs text-ink-faint py-1">No file changes recorded for this turn.</div>;
  return (
    <div className="space-y-2 mt-2">
      {files.map((f, i) => (
        <details key={i} className="tile" open={files.length <= 2}>
          <summary className="cursor-pointer px-2.5 py-1.5 mono text-2xs flex items-center gap-2" style={{ color: "var(--color-ink-dim)" }}>
            <span className="truncate flex-1">{f.path}</span>
            <span style={{ color: "var(--color-ink-faint)" }}>+{f.added} −{f.removed}</span>
          </summary>
          <pre className="text-2xs leading-relaxed overflow-x-auto px-0 py-1 border-t border-border-soft mono">
            {f.lines.map((l, j) => (
              <div key={j} className="px-2.5" style={{ background: LINE_BG[l.kind], color: l.kind === "meta" ? "var(--color-ink-faint)" : "var(--color-ink-dim)" }}>
                <span className="select-none mr-1" style={{ color: "var(--color-ink-faint)" }}>
                  {l.kind === "add" ? "+" : l.kind === "del" ? "−" : l.kind === "meta" ? "" : " "}
                </span>
                {l.text || " "}
              </div>
            ))}
          </pre>
        </details>
      ))}
    </div>
  );
}
