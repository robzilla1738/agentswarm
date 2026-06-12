import type { ActivityItem } from "./types";

/**
 * Shorten an absolute path for the activity feed. Paths inside a run
 * workspace become workspace-relative; paths under the mission cwd become
 * cwd-relative; anything else keeps its last two segments.
 */
export function shortPath(p: string, cwd?: string): string {
  if (!p.startsWith("/") && !/^[A-Za-z]:\\/.test(p)) return p;
  const ws = p.replace(/^.*?\/runs\/run_[a-z0-9]+\/workspace\/?/, "");
  if (ws !== p) return ws || "workspace/";
  if (cwd && p.startsWith(cwd + "/")) return p.slice(cwd.length + 1);
  if (cwd && p === cwd) return ".";
  const segs = p.split("/").filter(Boolean);
  if (segs.length <= 2) return p;
  return "…/" + segs.slice(-2).join("/");
}

/**
 * Turn a raw failed-tool summary ("ERROR: ENOENT: no such file or directory,
 * open '/long/path'") into a calm one-liner. Display-only — the journal keeps
 * the full text.
 */
export function summarizeToolError(raw: string, cwd?: string): string {
  const s = raw.replace(/\s+/g, " ").trim();
  const enoent = s.match(/ENOENT[^']*'([^']*)'/);
  if (enoent) return `file not found: ${shortPath(enoent[1], cwd)}`;
  if (/ENOENT/.test(s)) return "file not found";
  if (/EACCES|EPERM/.test(s)) return "permission denied";
  if (/ETIMEDOUT|timed? ?out/i.test(s)) return "timed out";
  if (/EEXIST/.test(s)) return "already exists";
  if (/EISDIR/.test(s)) return "path is a directory";
  if (/ENOTDIR/.test(s)) return "path is not a directory";
  const exit = s.match(/exit(?:ed)?(?: with)? code (\d+)/i);
  if (exit) return `exited with code ${exit[1]}`;
  const cleaned = s.replace(/^(ERROR|Error)[:\s]+/g, "").trim();
  return cleaned.length > 120 ? cleaned.slice(0, 117) + "…" : cleaned || "failed";
}

export type ActivityGroup = ActivityItem & {
  count?: number;
  /** Ok-result summary folded into its call row (one row per call, not two). */
  result?: string;
};

/**
 * File-shaped tools whose ok-result summary adds nothing the call row didn't
 * already say — dropped entirely so back-to-back calls fold into one row.
 */
const ABSORB_OK_RESULT = new Set(["read_file", "list_dir", "write_file", "replace_in_file", "save_artifact", "checkpoint"]);

/**
 * Calls that already produce a richer dedicated row (✦ note.added, ✓
 * task.report) — the raw tool row and its "noted/saved" confirmation are
 * pure duplication.
 */
const DROP_CALLS = new Set(["note", "report"]);

/** "[exit 0 in 0.2s] output" → "output" — a clean exit is the expected case. */
function tidyResult(name: string | undefined, text: string): string {
  if (name === "shell") return text.replace(/^\[exit 0 in [^\]]*\]\s*/, "").trim() || "ok";
  return text.trim();
}

/**
 * Shape the raw event stream into a scannable feed:
 *  - runs of the same tool collapse into one row ("read_file ×4")
 *  - an ok result folds INTO its call row as trailing context, never its own row
 *  - note/report tool rows vanish (their note.added / task.report rows carry more)
 *  - failed results always surface as their own row and break the group
 */
export function groupActivity(items: ActivityItem[]): ActivityGroup[] {
  const out: ActivityGroup[] = [];
  for (const item of items) {
    const last = out[out.length - 1];
    if (item.kind === "tool" && DROP_CALLS.has(item.name ?? "")) continue;
    if (item.kind === "result" && item.ok) {
      if (DROP_CALLS.has(item.name ?? "") || ABSORB_OK_RESULT.has(item.name ?? "")) continue;
      // Fold the summary into the call row it answers. Concurrent agents
      // interleave events, so look back a few rows for the matching call —
      // copy-on-write: rows in `out` may still be reducer-owned state objects.
      const at = findCallRow(out, item);
      if (at >= 0) {
        out[at] = { ...out[at], result: tidyResult(item.name, item.text) };
        continue;
      }
      out.push(item); // no visible call row to fold into — a result must never vanish
      continue;
    }
    if (item.kind === "tool" && last?.kind === "tool" && last.name === item.name && last.taskId === item.taskId) {
      // Keep the first item's id so the React key stays stable as the group grows.
      out[out.length - 1] = { ...item, id: last.id, count: (last.count ?? 1) + 1, result: last.result };
      continue;
    }
    out.push(item);
  }
  return out;
}

/** Nearest preceding call row (same tool + task, not yet folded) within a short window. */
function findCallRow(out: ActivityGroup[], result: ActivityItem): number {
  for (let i = out.length - 1, seen = 0; i >= 0 && seen < 6; i--, seen++) {
    const row = out[i];
    if (row.kind === "tool" && row.name === result.name && row.taskId === result.taskId && row.result === undefined) {
      return i;
    }
  }
  return -1;
}
